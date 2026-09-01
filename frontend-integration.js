window.REELSSAVER_API_BASE = window.REELSSAVER_API_BASE || 'http://localhost:8080';

async function resolveInstagramMedia(instagramUrl, mode = 'auto') {
  const base = window.REELSSAVER_API_BASE.replace(/\/$/, '');
  const response = await fetch(`${base}/api/instagram/resolve`, {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: instagramUrl,
      videoQuality: 'max',
      downloadMode: mode,
      audioFormat: 'mp3',
      audioBitrate: '320'
    })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Unable to process Instagram media.');
  return body.result;
}

function startResolvedDownload(result) {
  if (result.kind === 'single' && result.url) {
    const a = document.createElement('a'); a.href = result.url;
    a.download = result.filename || ''; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove(); return;
  }
  if (result.kind === 'picker') return result.items;
  throw new Error('This media requires additional processing.');
}
