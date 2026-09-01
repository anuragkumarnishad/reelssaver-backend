# Reelssaver Backend

Node.js/Express backend for a CDN-hosted frontend. It supports two provider modes:

1. **Cobalt (recommended for public, permitted media):** configure `COBALT_API_URL` and optionally `COBALT_API_KEY`. Requests use maximum available video quality and 320 kbps for audio.
2. **Instagram session fallback:** configure a full `IG_COOKIE` string for private testing with your own/permitted media. The cookie stays server-side. This method is brittle and may be rate-limited or challenged.
3. **Official Meta Graph API:** limited to media belonging to the Instagram professional account that authorized the app.

## Important limitation

The official Meta API is not a general-purpose Instagram downloader. It cannot resolve or download arbitrary public Instagram URLs from unrelated accounts. Supporting arbitrary third-party content would require a separate licensed provider and appropriate rights/permission.

## Requirements

- Node.js 20+
- A Meta developer app
- An Instagram Business or Creator account connected to a Facebook Page
- A valid long-lived access token with the permissions required by the current Instagram Graph API
- The authorized Instagram account ID

## Local setup

```bash
cp .env.example .env
# Fill META_ACCESS_TOKEN, INSTAGRAM_USER_ID and ALLOWED_ORIGINS
npm install
npm run check
npm start
```

Health check:

```bash
curl http://localhost:8080/api/health
```

Resolve an authorized account post:

```bash
curl 'http://localhost:8080/api/instagram/resolve?url=https%3A%2F%2Fwww.instagram.com%2Freel%2FEXAMPLE'
```

## API routes

- `GET /api/health`
- `GET /api/instagram/resolve?url=...`
- `GET /api/instagram/media/:id`
- `GET /api/instagram/download/:id`

## Deploy on Render

1. Push this folder to GitHub.
2. Create a Render Blueprint using `render.yaml`, or create a Node web service manually.
3. Set `META_ACCESS_TOKEN`, `INSTAGRAM_USER_ID`, and `ALLOWED_ORIGINS` in Render.
4. Set `ALLOWED_ORIGINS` to your exact CDN frontend origin, e.g. `https://www.example.com`.
5. Put the deployed API URL in your frontend:

```html
<script>window.REELSSAVER_API_BASE='https://your-service.onrender.com';</script>
<script src="frontend-integration.js"></script>
```

## Production notes

- Never place the Meta access token in frontend HTML.
- Replace the in-memory rate limiter with Redis when running multiple server instances.
- Meta media URLs can expire; resolve them when needed rather than storing them permanently.
- Use only content you own or are authorized to process.
