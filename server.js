import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import ffmpegPath from 'ffmpeg-static';
import archiver from 'archiver';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const META_VERSION = process.env.META_API_VERSION || 'v23.0';
const META_TOKEN = process.env.META_ACCESS_TOKEN || '';
const IG_USER_ID = process.env.INSTAGRAM_USER_ID || '';
const COBALT_API_URL = (process.env.COBALT_API_URL || '').replace(/\/$/, '');
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';
const MEDIA_WORKER_URL = (process.env.MEDIA_WORKER_URL || '').replace(/\/$/, '');
const DOWNLOAD_SIGNING_SECRET = process.env.DOWNLOAD_SIGNING_SECRET || '';
const IG_COOKIE = process.env.IG_COOKIE || '';
const IG_CSRF = process.env.IG_CSRF_TOKEN || ((IG_COOKIE.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '');
const IG_SESSION_USER_ID = process.env.IG_DS_USER_ID || ((IG_COOKIE.match(/(?:^|;\s*)ds_user_id=([^;]+)/) || [])[1] || '');
const IG_FEED_SESSIONID = process.env.IG_FEED_SESSIONID || '';
const IG_FEED_USER_ID = process.env.IG_FEED_USER_ID || (() => {
  try { return decodeURIComponent(IG_FEED_SESSIONID).split(':')[0] || IG_SESSION_USER_ID; } catch { return IG_SESSION_USER_ID; }
})();
const MAX_META_PAGES = Math.max(1, Number(process.env.MAX_META_PAGES || 10));
const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '1' ? 1 : false);
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && allowed.includes('*')) throw new Error('ALLOWED_ORIGINS=* is forbidden in production. Set your exact HTTPS website origin.');
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  strictTransportSecurity: isProduction ? { maxAge: 31_536_000, includeSubDomains: true, preload: true } : false
}));
app.use((_req, res, next) => {
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '16kb', strict: true }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    cb(new Error('Origin is not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

// Small in-memory limiter. Use Redis when scaling to multiple instances.
const buckets = new Map();
const resolveCache = new Map();
const RESOLVE_CACHE_MS = Number(process.env.RESOLVE_CACHE_MS || 300_000);
const windowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const maxRequests = Number(process.env.RATE_LIMIT_MAX || 60);
app.use('/api', (req, res, next) => {
  if (req.originalUrl.length > 4096) return res.status(414).json({ error: 'Request URL is too long.' });
  if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Content-Type must be application/json.' });
  const now = Date.now();
  const key = req.ip || 'unknown';
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) b = { start: now, count: 0 };
  b.count += 1; buckets.set(key, b);
  res.set('X-RateLimit-Limit', String(maxRequests));
  res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - b.count)));
  if (b.count > maxRequests) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  next();
});

function requireMetaConfig(res) {
  if (META_TOKEN && IG_USER_ID) return true;
  res.status(503).json({ error: 'Meta API is not configured on the server.' });
  return false;
}

function normalizeInstagramUrl(value) {
  try {
    const u = new URL(value);
    if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
    u.search = ''; u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch { return null; }
}

async function metaGet(pathOrUrl, params = {}) {
  const url = pathOrUrl.startsWith('http')
    ? new URL(pathOrUrl)
    : new URL(`https://graph.facebook.com/${META_VERSION}/${pathOrUrl.replace(/^\//, '')}`);
  if (!pathOrUrl.startsWith('http')) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  url.searchParams.set('access_token', META_TOKEN);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || 'Meta API request failed';
    const error = new Error(message); error.status = response.status; throw error;
  }
  return body;
}

function instagramSessionHeaders(referer) {
  const headers = {
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    'X-IG-App-ID': '936619743392459',
    'Referer': referer || 'https://www.instagram.com/'
  };
  if (IG_COOKIE) headers.Cookie = IG_COOKIE;
  if (IG_CSRF) headers['X-CSRFToken'] = IG_CSRF;
  return headers;
}

function collectInstagramMedia(node, output = []) {
  if (!node || typeof node !== 'object') return output;
  const children = node.carousel_media || node.edge_sidecar_to_children?.edges?.map(x => x.node) || node.children?.data;
  if (Array.isArray(children) && children.length) {
    children.forEach(child => collectInstagramMedia(child?.node || child, output));
    return output;
  }
  const videos = Array.isArray(node.video_versions) ? [...node.video_versions] : [];
  if (node.video_url) videos.push({ url: node.video_url, width: node.dimensions?.width, height: node.dimensions?.height });
  videos.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
  if (videos[0]?.url) {
    output.push({ type: 'video', url: videos[0].url, thumbnailUrl: node.display_url || node.thumbnail_src || node.image_versions2?.candidates?.[0]?.url || null, width: videos[0].width || node.original_width || node.dimensions?.width || null, height: videos[0].height || node.original_height || node.dimensions?.height || null, duration: node.video_duration || null });
    return output;
  }
  const images = node.image_versions2?.candidates || [];
  images.sort((a, b) => ((b.width || 0) * (b.height || 0)) - ((a.width || 0) * (a.height || 0)));
  const imageUrl = images[0]?.url || node.display_url || node.thumbnail_src;
  if (imageUrl) output.push({ type: 'photo', url: imageUrl, thumbnailUrl: imageUrl, width: images[0]?.width || node.original_width || node.dimensions?.width || null, height: images[0]?.height || node.original_height || node.dimensions?.height || null });
  return output;
}

function instagramShortcode(instagramUrl) {
  return instagramUrl.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i)?.[1] || null;
}

function mediaMetadata(root) {
  const caption = root?.caption?.text
    || root?.edge_media_to_caption?.edges?.[0]?.node?.text
    || root?.accessibility_caption
    || '';
  return {
    username: root?.user?.username || root?.owner?.username || null,
    caption: String(caption).slice(0, 2200),
    likes: Number(root?.like_count ?? root?.edge_media_preview_like?.count ?? root?.edge_liked_by?.count ?? 0),
    comments: Number(root?.comment_count ?? root?.edge_media_to_parent_comment?.count ?? root?.edge_media_to_comment?.count ?? 0),
    timestamp: root?.taken_at ? new Date(root.taken_at * 1000).toISOString() : null
  };
}
function resultWithMetadata(root, items) {
  const media = items.length > 1 ? { kind: 'picker', items } : { kind: 'single', ...items[0] };
  return { ...media, metadata: mediaMetadata(root) };
}
async function enrichFileInfo(result) {
  const item = result.kind === 'picker' ? result.items?.[0] : result;
  if (!item?.url) return result;
  try {
    const response = await fetch(item.url, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' }, signal: AbortSignal.timeout(10_000) });
    const bytes = Number(response.headers.get('content-length') || 0);
    if (bytes > 0) item.fileSizeBytes = bytes;
    const contentType = response.headers.get('content-type'); if (contentType) item.contentType = contentType;
  } catch {}
  return result;
}

function shortcodeToMediaId(shortcode) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let value = 0n;
  for (const char of shortcode) {
    const index = alphabet.indexOf(char);
    if (index < 0) return null;
    value = value * 64n + BigInt(index);
  }
  return value.toString();
}

async function resolveViaInstagramMediaInfo(instagramUrl) {
  const shortcode = instagramShortcode(instagramUrl);
  if (!shortcode) return null;
  const mediaId = shortcodeToMediaId(shortcode);
  if (!mediaId) return null;
  const endpoints = [
    `https://i.instagram.com/api/v1/media/${mediaId}/info/`,
    `https://www.instagram.com/api/v1/media/${mediaId}/info/`
  ];
  for (const endpoint of endpoints) {
    try {
      const headers = instagramSessionHeaders(instagramUrl);
      headers['User-Agent'] = 'Instagram 322.0.0.0.0 Android (33/13; 420dpi; 1080x2400; Google; Pixel 7; panther; en_US)';
      headers['X-IG-Capabilities'] = '3brTvw==';
      const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) continue;
      const json = await response.json();
      const root = json?.items?.[0] || json?.item;
      const items = collectInstagramMedia(root, []);
      if (items.length) return resultWithMetadata(root, items);
    } catch {}
  }
  return null;
}

async function resolveViaInstagramGraphQL(instagramUrl) {
  const shortcode = instagramShortcode(instagramUrl);
  if (!shortcode) return null;
  let lsd = '';
  try {
    const page = await fetch(instagramUrl, { headers: instagramSessionHeaders(instagramUrl), signal: AbortSignal.timeout(15_000) });
    if (page.ok) {
      const html = await page.text();
      lsd = html.match(/"LSD",\[\],\{"token":"([^"]+)"/)?.[1]
        || html.match(/"lsd":"([^"]+)"/)?.[1]
        || '';
    }
  } catch {}

  // Instagram changes these web query identifiers periodically, so try a small fallback set.
  const docIds = (process.env.IG_GRAPHQL_DOC_IDS || '24368985919464652,8845758582119845,10015901848480474')
    .split(',').map(x => x.trim()).filter(Boolean);
  for (const docId of docIds) {
    try {
      const headers = instagramSessionHeaders(instagramUrl);
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers.Origin = 'https://www.instagram.com';
      if (lsd) headers['X-FB-LSD'] = lsd;
      const body = new URLSearchParams({ variables: JSON.stringify({ shortcode }), doc_id: docId });
      if (lsd) body.set('lsd', lsd);
      const response = await fetch('https://www.instagram.com/graphql/query', {
        method: 'POST', headers, body, signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) continue;
      const json = await response.json();
      const root = json?.data?.xdt_api__v1__media__shortcode__web_info?.items?.[0]
        || json?.data?.shortcode_media
        || json?.graphql?.shortcode_media;
      const items = collectInstagramMedia(root, []);
      if (items.length) return resultWithMetadata(root, items);
    } catch {}
  }
  return null;
}

async function resolveStoryOrHighlight(instagramUrl) {
  const parsed = new URL(instagramUrl);
  const highlightId = parsed.pathname.match(/^\/stories\/highlights\/(\d+)/i)?.[1];
  const storyMatch = parsed.pathname.match(/^\/stories\/([^/]+)\/(\d+)/i);
  const headers = instagramSessionHeaders(instagramUrl);
  headers['User-Agent'] = 'Instagram 322.0.0.0.0 Android (33/13; 420dpi; 1080x2400; Google; Pixel 7; panther; en_US)';
  headers['X-IG-Capabilities'] = '3brTvw==';

  if (highlightId) {
    const reelKey = `highlight:${highlightId}`;
    const endpoint = `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelKey)}`;
    const response = await fetch(endpoint, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const json = await response.json();
    const reel = json?.reels?.[reelKey] || Object.values(json?.reels || {})[0];
    const roots = Array.isArray(reel?.items) ? reel.items : [];
    const items = roots.flatMap(root => collectInstagramMedia(root, []));
    if (!items.length) return null;
    const media = items.length > 1 ? { kind: 'picker', items } : { kind: 'single', ...items[0] };
    return { ...media, metadata: { ...mediaMetadata(roots[0] || reel), username: reel?.user?.username || mediaMetadata(roots[0] || reel).username } };
  }

  if (storyMatch) {
    const username = storyMatch[1];
    const storyId = storyMatch[2];

    // Some Instagram sessions accept the numeric story media ID directly.
    for (const host of ['i.instagram.com', 'www.instagram.com']) {
      try {
        const response = await fetch(`https://${host}/api/v1/media/${storyId}/info/`, { headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
        if (!response.ok) continue;
        const json = await response.json();
        const root = json?.items?.[0] || json?.item;
        const items = collectInstagramMedia(root, []);
        if (items.length) return resultWithMetadata(root, items);
      } catch {}
    }

    // Reliable fallback: resolve the username to its numeric user ID, load that
    // user's active story reel, then select exactly the media ID from the URL.
    let userId = '';
    const webHeaders = instagramSessionHeaders(`https://www.instagram.com/${username}/`);
    const profileRequests = [
      { url: `https://i.instagram.com/api/v1/users/${encodeURIComponent(username)}/usernameinfo/`, headers },
      { url: `https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, headers },
      { url: `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, headers: webHeaders },
      { url: `https://i.instagram.com/api/v1/users/search/?q=${encodeURIComponent(username)}&count=10`, headers }
    ];
    for (const request of profileRequests) {
      try {
        const profileResponse = await fetch(request.url, { headers: request.headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
        if (!profileResponse.ok) continue;
        const profile = await profileResponse.json();
        const searchedUser = profile?.users?.find(user => String(user?.username || '').toLowerCase() === username.toLowerCase());
        userId = String(profile?.user?.pk || profile?.user?.id || profile?.data?.user?.id || searchedUser?.pk || searchedUser?.id || '');
        if (userId) break;
      } catch {}
    }

    if (userId) {
      try {
        const compositeResponse = await fetch(`https://i.instagram.com/api/v1/media/${storyId}_${userId}/info/`, {
          headers, redirect: 'manual', signal: AbortSignal.timeout(20_000)
        });
        if (compositeResponse.ok) {
          const compositeJson = await compositeResponse.json();
          const root = compositeJson?.items?.[0] || compositeJson?.item;
          const items = collectInstagramMedia(root, []);
          if (items.length) return resultWithMetadata(root, items);
        }
      } catch {}

      const storyRequests = [
        { url: `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(userId)}/story/`, headers },
        { url: `https://i.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`, headers },
        { url: `https://www.instagram.com/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(userId)}`, headers: webHeaders }
      ];
      for (const request of storyRequests) {
        try {
          const reelResponse = await fetch(request.url, { headers: request.headers, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
          if (!reelResponse.ok) continue;
          const reelJson = await reelResponse.json();
          const reel = reelJson?.reel || reelJson?.reels?.[userId] || Object.values(reelJson?.reels || {})[0];
          const roots = Array.isArray(reel?.items) ? reel.items : (Array.isArray(reelJson?.items) ? reelJson.items : []);
          const root = roots.find(item => {
            const ids = [item?.pk, item?.id, item?.media_id].filter(Boolean).map(String);
            return ids.some(id => id === storyId || id.startsWith(`${storyId}_`))
              || ids.some(id => id.slice(0, 12) === storyId.slice(0, 12));
          });
          const items = collectInstagramMedia(root, []);
          if (items.length) return resultWithMetadata(root, items);
        } catch {}
      }
    }
  }
  return null;
}

async function resolveViaLocalStoryService(instagramUrl) {
  if (!process.env.IG_STORY_SESSIONID && (!process.env.IG_STORY_USERNAME || !process.env.IG_STORY_PASSWORD)) return null;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.resolve(here, '../story_resolver.py');
  const python = process.env.STORY_PYTHON_COMMAND || (process.platform === 'win32' ? 'python' : 'python3');
  return await new Promise((resolve, reject) => {
    const child = spawn(python, [script, instagramUrl], { env: process.env, windowsHide: true });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(Object.assign(new Error('Local Story resolver timed out.'), { status: 504 })); }, 45_000);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => { clearTimeout(timer); reject(Object.assign(new Error(`Unable to start Python Story resolver: ${error.message}`), { status: 503 })); });
    child.on('close', () => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      let payload;
      try { payload = JSON.parse(line || '{}'); } catch { payload = null; }
      if (payload?.ok && payload.result) return resolve(payload.result);
      const message = payload?.error || stderr.trim().split(/\r?\n/).at(-1) || 'Local Story resolver failed.';
      reject(Object.assign(new Error(message), { status: 502 }));
    });
  });
}

async function sessionResolve(instagramUrl) {
  const isStoryUrl = /\/stories\/(?!highlights\/)/i.test(new URL(instagramUrl).pathname);
  const hasLocalStoryAuth = Boolean(process.env.IG_STORY_SESSIONID || (process.env.IG_STORY_USERNAME && process.env.IG_STORY_PASSWORD));
  if (isStoryUrl && hasLocalStoryAuth) {
    return await resolveViaLocalStoryService(instagramUrl);
  }
  if (!IG_COOKIE) { const error = new Error('Instagram session cookie is not configured.'); error.status = 503; throw error; }
  if (/\/stories\//i.test(new URL(instagramUrl).pathname)) {
    const storyResult = await resolveStoryOrHighlight(instagramUrl);
    if (storyResult) return storyResult;
    // Story/highlight URLs do not support the post embed/GraphQL fallbacks below;
    // Instagram can bounce those endpoints between login pages indefinitely.
    const error = new Error('Story could not be resolved. It may be expired, deleted, or unavailable to the configured Instagram session.');
    error.status = 404;
    throw error;
  }
  const mediaInfoResult = await resolveViaInstagramMediaInfo(instagramUrl);
  if (mediaInfoResult) return mediaInfoResult;

  const graphResult = await resolveViaInstagramGraphQL(instagramUrl);
  if (graphResult) return graphResult;

  const candidates = [
    `${instagramUrl}/?__a=1&__d=dis`,
    `${instagramUrl}/embed/captioned/`,
    `${instagramUrl}/embed/`
  ];
  let lastStatus = 502;
  for (const endpoint of candidates) {
    const response = await fetch(endpoint, { headers: instagramSessionHeaders(instagramUrl), redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    lastStatus = response.status;
    if (response.status === 401 || response.status === 403) continue;
    if (!response.ok) continue;
    const type = response.headers.get('content-type') || '';
    if (type.includes('application/json')) {
      const json = await response.json();
      const root = json?.graphql?.shortcode_media || json?.items?.[0] || json?.data?.shortcode_media || json;
      const items = collectInstagramMedia(root, []);
      if (items.length) return resultWithMetadata(root, items);
    } else {
      const html = await response.text();
      const video = html.match(/<meta[^>]+property=["']og:video(?::secure_url)?["'][^>]+content=["']([^"']+)/i)?.[1];
      const image = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)/i)?.[1];
      const decode = x => x?.replace(/&amp;/g, '&');
      if (video) return { kind: 'single', type: 'video', url: decode(video), thumbnailUrl: decode(image) || null };
      if (image) return { kind: 'single', type: 'photo', url: decode(image), thumbnailUrl: decode(image) };
    }
  }
  const error = new Error(lastStatus === 401 || lastStatus === 403 ? 'Instagram rejected the session. Refresh IG_COOKIE.' : 'Instagram media could not be resolved.');
  error.status = lastStatus === 401 || lastStatus === 403 ? 401 : 502; throw error;
}

async function cobaltResolve(instagramUrl, options = {}) {
  if (!COBALT_API_URL) {
    const error = new Error('Cobalt API is not configured.'); error.status = 503; throw error;
  }
  const headers = { 'Accept': 'application/json', 'Content-Type': 'application/json' };
  if (COBALT_API_KEY) headers.Authorization = `Api-Key ${COBALT_API_KEY}`;
  const response = await fetch(`${COBALT_API_URL}/`, {
    method: 'POST', headers,
    body: JSON.stringify({
      url: instagramUrl,
      videoQuality: options.videoQuality || 'max',
      downloadMode: options.downloadMode || 'auto',
      audioFormat: options.audioFormat || 'mp3',
      audioBitrate: options.audioBitrate || '320',
      filenameStyle: 'pretty',
      alwaysProxy: true,
      disableMetadata: false
    }),
    signal: AbortSignal.timeout(45_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.status === 'error') {
    const error = new Error(body?.error?.code || body?.text || 'Cobalt could not process this URL.');
    error.status = response.status >= 400 ? response.status : 502; throw error;
  }
  return body;
}

function normalizeCobaltResult(body) {
  if (body.status === 'picker') {
    return {
      kind: 'picker',
      items: (body.picker || []).map((item, index) => ({
        id: String(index + 1), type: item.type, url: item.url, thumbnailUrl: item.thumb || null
      })),
      audioUrl: body.audio || null,
      audioFilename: body.audioFilename || null
    };
  }
  if (body.status === 'redirect' || body.status === 'tunnel') {
    return { kind: 'single', url: body.url, filename: body.filename || null };
  }
  if (body.status === 'local-processing') {
    return { kind: 'processing', service: body.service, type: body.type, tunnel: body.tunnel || [], output: body.output || null };
  }
  return { kind: body.status || 'unknown', raw: body };
}

const fields = 'id,username,caption,media_type,media_product_type,media_url,thumbnail_url,permalink,timestamp,children{id,media_type,media_url,thumbnail_url}';

function publicMedia(media) {
  return {
    id: media.id,
    username: media.username || null,
    caption: media.caption || '',
    mediaType: media.media_type,
    productType: media.media_product_type || null,
    mediaUrl: media.media_url || null,
    thumbnailUrl: media.thumbnail_url || null,
    permalink: media.permalink,
    timestamp: media.timestamp,
    children: (media.children?.data || []).map(x => ({
      id: x.id, mediaType: x.media_type, mediaUrl: x.media_url || null, thumbnailUrl: x.thumbnail_url || null
    }))
  };
}

app.get('/', (_req, res) => res.redirect('/test'));
app.get('/test', (_req, res) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  res.sendFile(path.resolve(here, '../test-api.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'reelssaver-api', metaConfigured: Boolean(META_TOKEN && IG_USER_ID), cobaltConfigured: Boolean(COBALT_API_URL), sessionConfigured: Boolean(IG_COOKIE) });
});

app.get('/api/instagram/session-check', async (_req, res) => {
  if (!IG_COOKIE) return res.status(503).json({ valid: false, error: 'IG_COOKIE is not configured.' });
  try {
    const headers = instagramSessionHeaders('https://www.instagram.com/');
    headers['User-Agent'] = 'Instagram 322.0.0.0.0 Android (33/13; 420dpi; 1080x2400; Google; Pixel 7; panther; en_US)';
    headers['X-IG-Capabilities'] = '3brTvw==';
    const response = await fetch('https://i.instagram.com/api/v1/accounts/current_user/?edit=true', { headers, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({}));
    const user = body?.user;
    if (!response.ok || !user) return res.status(401).json({ valid: false, status: response.status, error: body?.message || 'Instagram session was rejected.' });
    res.json({ valid: true, username: user.username || null, userId: String(user.pk || user.id || '') });
  } catch (error) {
    res.status(502).json({ valid: false, error: error.message });
  }
});

// Live feed for the connected session account. This is not Instagram's global trending feed.
app.get('/api/instagram/feed', async (_req, res, next) => {
  const feedCookie = IG_FEED_SESSIONID ? `sessionid=${IG_FEED_SESSIONID}; ds_user_id=${IG_FEED_USER_ID}` : IG_COOKIE;
  if (!feedCookie || !IG_FEED_USER_ID) return res.status(503).json({ error: 'Instagram feed session is not configured.' });
  const feedHeaders = referer => {
    const value = instagramSessionHeaders(referer);
    value.Cookie = feedCookie;
    return value;
  };
  try {
    const headers = feedHeaders('https://www.instagram.com/');
    headers['User-Agent'] = 'Instagram 322.0.0.0.0 Android (33/13; 420dpi; 1080x2400; Google; Pixel 7; panther; en_US)';
    headers['X-IG-Capabilities'] = '3brTvw==';
    // Most reliable live-feed path: fetch recent posts from explicitly configured
    // public profiles through Instagram's web profile endpoint.
    let configuredNames = (process.env.IG_FEED_USERNAMES || '').split(',').map(x => x.trim().replace(/^@/, '')).filter(Boolean);
    if (!configuredNames.length) {
      try {
        const meResponse = await fetch('https://i.instagram.com/api/v1/accounts/current_user/?edit=true', { headers, signal: AbortSignal.timeout(15_000) });
        if (meResponse.ok) {
          const me = await meResponse.json();
          const username = me?.user?.username;
          if (username) configuredNames = [username];
        }
      } catch {}
    }
    let profileItems = [];
    for (const username of configuredNames.slice(0, 4)) {
      try {
        const profileResponse = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, {
          headers: feedHeaders(`https://www.instagram.com/${username}/`), signal: AbortSignal.timeout(20_000)
        });
        if (!profileResponse.ok) continue;
        const profile = await profileResponse.json();
        const edges = profile?.data?.user?.edge_owner_to_timeline_media?.edges || [];
        profileItems.push(...edges.map(edge => edge.node).filter(Boolean));
      } catch {}
    }

    const endpoints = [
      `https://i.instagram.com/api/v1/feed/user/${encodeURIComponent(IG_FEED_USER_ID)}/?count=12`,
      'https://i.instagram.com/api/v1/feed/timeline/?count=12',
      'https://www.instagram.com/api/v1/feed/timeline/?count=12',
      'https://www.instagram.com/api/v1/discover/web/explore_grid/'
    ];
    const findMediaObjects = payload => {
      const found = [], seen = new Set();
      const walk = (value, depth = 0) => {
        if (!value || depth > 9) return;
        if (Array.isArray(value)) { value.forEach(v => walk(v, depth + 1)); return; }
        if (typeof value !== 'object') return;
        const candidate = value.media && typeof value.media === 'object' ? value.media : value;
        const code = candidate.code || candidate.shortcode;
        if (code && (candidate.media_type || candidate.image_versions2 || candidate.video_versions) && !seen.has(code)) {
          seen.add(code); found.push(candidate);
        }
        Object.values(value).forEach(v => walk(v, depth + 1));
      };
      walk(payload); return found;
    };
    let feedItems = profileItems;
    let lastStatus = 502;
    for (const endpoint of endpoints) {
      if (feedItems.length) break;
      const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(25_000) });
      lastStatus = response.status;
      if (!response.ok) continue;
      const payload = await response.json();
      feedItems = findMediaObjects(payload);
      if (feedItems.length) break;
    }
    if (!feedItems.length && (lastStatus === 401 || lastStatus === 403)) return res.status(lastStatus).json({ error: 'Instagram session was rejected.' });
    const posts = feedItems.slice(0, 8).map(item => {
      const media = collectInstagramMedia(item, []);
      const meta = mediaMetadata(item);
      const code = item.code || item.shortcode || '';
      return {
        id: String(item.pk || item.id || code),
        shortcode: code,
        permalink: code ? `https://www.instagram.com/${item.media_type === 2 ? 'reel' : 'p'}/${code}/` : null,
        type: item.media_type === 2 ? 'reel' : (item.carousel_media ? 'carousel' : 'post'),
        thumbnailUrl: media[0]?.thumbnailUrl || media[0]?.url || null,
        title: meta.caption ? meta.caption.split('\n')[0].slice(0, 75) : 'Instagram post',
        username: meta.username || 'instagram',
        likes: meta.likes,
        comments: meta.comments
      };
    }).filter(item => item.thumbnailUrl && item.permalink);
    res.json({ source: 'connected-account', posts });
  } catch (error) { next(error); }
});

// Primary public-content resolver through your self-hosted/licensed Cobalt instance.
app.post('/api/instagram/resolve', async (req, res, next) => {
  const target = normalizeInstagramUrl(String(req.body?.url || ''));
  if (!target) return res.status(400).json({ error: 'A valid instagram.com URL is required.' });
  try {
    const cached = resolveCache.get(target);
    if (cached && Date.now() - cached.savedAt < RESOLVE_CACHE_MS) {
      return res.json({ ...cached.payload, cached: true });
    }
    if (COBALT_API_URL) {
      const result = await cobaltResolve(target, {
        videoQuality: req.body?.videoQuality,
        downloadMode: req.body?.downloadMode,
        audioFormat: req.body?.audioFormat,
        audioBitrate: req.body?.audioBitrate
      });
      const payload = { provider: 'cobalt', qualityRequested: req.body?.videoQuality || 'max', result: normalizeCobaltResult(result) };
      resolveCache.set(target, { savedAt: Date.now(), payload });
      return res.json(payload);
    }
    if (IG_COOKIE) {
      const result = await sessionResolve(target);
      // Do not wait for a separate HEAD request; it adds latency and file size is not shown.
      const payload = { provider: 'instagram-session', qualityRequested: 'best-available', result };
      resolveCache.set(target, { savedAt: Date.now(), payload });
      return res.json(payload);
    }
    res.status(503).json({ error: 'Configure COBALT_API_URL or IG_COOKIE on the server.' });
  } catch (error) { next(error); }
});

// Resolves only media owned by the authorized Instagram professional account.
app.get('/api/instagram/resolve', async (req, res, next) => {
  if (!requireMetaConfig(res)) return;
  const target = normalizeInstagramUrl(String(req.query.url || ''));
  if (!target) return res.status(400).json({ error: 'A valid instagram.com URL is required.' });
  try {
    let nextUrl = null;
    for (let page = 0; page < MAX_META_PAGES; page += 1) {
      const payload = nextUrl
        ? await metaGet(nextUrl)
        : await metaGet(`${IG_USER_ID}/media`, { fields, limit: '100' });
      const found = (payload.data || []).find(item => normalizeInstagramUrl(item.permalink) === target);
      if (found) return res.json({ media: publicMedia(found) });
      nextUrl = payload.paging?.next || null;
      if (!nextUrl) break;
    }
    res.status(404).json({ error: 'Media was not found in the authorized Instagram account.' });
  } catch (error) { next(error); }
});

app.get('/api/instagram/media/:id', async (req, res, next) => {
  if (!requireMetaConfig(res)) return;
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid media ID.' });
  try {
    const media = await metaGet(req.params.id, { fields });
    res.json({ media: publicMedia(media) });
  } catch (error) { next(error); }
});

function isAllowedInstagramMediaUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') || host === 'fbcdn.net' || host.endsWith('.fbcdn.net'));
  } catch { return false; }
}

// Creates a real ZIP containing every media item from a carousel.
app.post('/api/instagram/zip', async (req, res, next) => {
  const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 20) : [];
  if (!items.length) return res.status(400).json({ error: 'No media items supplied.' });
  if (items.some(item => !isAllowedInstagramMediaUrl(item?.url))) return res.status(400).json({ error: 'One or more media URLs are unsupported.' });
  try {
    const rawName = String(req.body?.filename || 'reelssaver-carousel.zip').replace(/[\r\n]/g, ' ').slice(0, 120);
    const zipName = rawName.toLowerCase().endsWith('.zip') ? rawName : `${rawName}.zip`;
    const asciiName = zipName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-') || 'reelssaver-carousel.zip';
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${asciiName}"`);
    res.set('Cache-Control', 'private, no-store');
    const archive = archiver('zip', { zlib: { level: 0 } });
    archive.on('error', next);
    archive.pipe(res);
    let added = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      const upstream = await fetch(item.url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' }, signal: AbortSignal.timeout(45_000) });
      if (!upstream.ok || !upstream.body) continue;
      const type = upstream.headers.get('content-type') || '';
      const ext = type.includes('image') || item.type === 'photo' || item.type === 'image' ? 'jpg' : 'mp4';
      archive.append(Readable.fromWeb(upstream.body), { name: `instagram-${String(index + 1).padStart(2, '0')}.${ext}` });
      added += 1;
    }
    if (!added) { archive.abort(); if (!res.headersSent) res.status(502).json({ error: 'Unable to retrieve carousel files.' }); return; }
    await archive.finalize();
  } catch (error) { next(error); }
});

// Extracts the audio track from an allowed Instagram CDN video and streams MP3.
app.get('/api/instagram/audio', (req, res, next) => {
  const mediaUrl = String(req.query.url || '');
  if (!isAllowedInstagramMediaUrl(mediaUrl)) return res.status(400).json({ error: 'Unsupported media host.' });
  const rawName = String(req.query.filename || 'reelssaver-audio.mp3').replace(/[\r\n]/g, ' ').slice(0, 130);
  const asciiName = rawName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-') || 'reelssaver-audio.mp3';
  const encodedName = encodeURIComponent(rawName).replace(/['()]/g, escape);
  res.set('Content-Type', 'audio/mpeg');
  res.set('Content-Disposition', `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`);
  res.set('Cache-Control', 'private, no-store');
  const ffmpeg = spawn(ffmpegPath, ['-hide_banner','-loglevel','error','-headers','Referer: https://www.instagram.com/\r\n','-i',mediaUrl,'-vn','-c:a','libmp3lame','-b:a','192k','-f','mp3','pipe:1'], { windowsHide: true });
  ffmpeg.stdout.pipe(res);
  ffmpeg.stderr.on('data', data => console.error('ffmpeg:', String(data).trim()));
  ffmpeg.on('error', next);
  ffmpeg.on('close', code => { if (code !== 0 && !res.headersSent) next(new Error('Audio conversion failed.')); });
  req.on('close', () => { if (!ffmpeg.killed) ffmpeg.kill(); });
});

// Streams a resolved Instagram CDN URL with attachment headers for native browser download.
// Host allowlisting prevents this route from becoming an open SSRF proxy.
app.get('/api/instagram/file', async (req, res, next) => {
  try {
    const mediaUrl = new URL(String(req.query.url || ''));
    const host = mediaUrl.hostname.toLowerCase();
    const allowedHost = host === 'cdninstagram.com' || host.endsWith('.cdninstagram.com') || host === 'fbcdn.net' || host.endsWith('.fbcdn.net');
    if (mediaUrl.protocol !== 'https:' || !allowedHost) return res.status(400).json({ error: 'Unsupported media host.' });
    const rawRequested = String(req.query.filename || 'reelssaver-download').replace(/[\r\n]/g, ' ').trim().slice(0, 140);
    const inline = req.query.inline === '1' ? '1' : '0';
    if (MEDIA_WORKER_URL && DOWNLOAD_SIGNING_SECRET) {
      const exp = String(Math.floor(Date.now() / 1000) + 300);
      const canonical = `${exp}\n${inline}\n${rawRequested}\n${mediaUrl.toString()}`;
      const sig = createHmac('sha256', DOWNLOAD_SIGNING_SECRET).update(canonical).digest('hex');
      const workerUrl = new URL(MEDIA_WORKER_URL);
      workerUrl.searchParams.set('url', mediaUrl.toString());
      workerUrl.searchParams.set('filename', rawRequested);
      workerUrl.searchParams.set('inline', inline);
      workerUrl.searchParams.set('exp', exp);
      workerUrl.searchParams.set('sig', sig);
      return res.redirect(307, workerUrl.toString());
    }
    const upstream = await fetch(mediaUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.instagram.com/' }, signal: AbortSignal.timeout(45_000) });
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'Unable to retrieve media file.' });
    const type = upstream.headers.get('content-type') || 'application/octet-stream';
    const extension = type.includes('image') ? '.jpg' : type.includes('audio') ? '.m4a' : '.mp4';
    const unicodeFilename = /\.[a-z0-9]{2,5}$/i.test(rawRequested) ? rawRequested : rawRequested + extension;
    const asciiFilename = unicodeFilename.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `reelssaver-download${extension}`;
    const encodedFilename = encodeURIComponent(unicodeFilename).replace(/['()]/g, escape);
    res.set('Content-Type', type);
    const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
    res.set('Content-Disposition', `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`);
    res.set('Cache-Control', 'private, no-store');
    const length = upstream.headers.get('content-length'); if (length) res.set('Content-Length', length);
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) { next(error); }
});

// Streams authorized Meta media through this backend.
app.get('/api/instagram/download/:id', async (req, res, next) => {
  if (!requireMetaConfig(res)) return;
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid media ID.' });
  try {
    const media = await metaGet(req.params.id, { fields: 'id,media_type,media_url' });
    if (!media.media_url) return res.status(404).json({ error: 'No downloadable file is available.' });
    const upstream = await fetch(media.media_url, { signal: AbortSignal.timeout(30_000) });
    if (!upstream.ok || !upstream.body) throw new Error('Unable to retrieve media file.');
    const ext = media.media_type === 'IMAGE' ? 'jpg' : 'mp4';
    res.set('Content-Type', upstream.headers.get('content-type') || 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename="reelssaver-${media.id}.${ext}"`);
    res.set('Cache-Control', 'private, max-age=300');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) { next(error); }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = Number(error.status) >= 400 && Number(error.status) < 600 ? Number(error.status) : 500;
  res.status(status).json({ error: status === 500 ? 'Server error.' : error.message });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Reelssaver API listening on port ${PORT}`));
