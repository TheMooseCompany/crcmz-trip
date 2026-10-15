# CRCMZ Trip

The CRCMZ BOYZ Calgary trip hub (Oct 29 – Nov 1, 2026): flight-convergence
cinematic, countdown, crew, the Airbnb, day plans, Food Finder, Photo Wall,
the Split, and the FC 27 tournament.

The page itself is a single static HTML file (`public/index.html` +
`public/assets`). A thin Express server (`server.js`) serves it and gates
every route behind a **Zitadel OIDC login** (Authorization Code flow with
PKCE via `openid-client` — a public client, no client secret). There is no
database; sessions are signed cookies (in-memory session store — run a
single instance).

## Run locally

```sh
npm install
cp .env.example .env   # fill in your Zitadel values
npm start              # http://localhost:3000
```

Without the required environment variables the server refuses to start and
names the missing ones.

## Deploying on Coolify

- **Build pack:** Dockerfile (this repo's `Dockerfile`, Node 22 Alpine).
- **Port:** the app listens on **3000** (or `$PORT` if set) on `0.0.0.0`.
- **Health check:** `GET /healthz` (public, returns `ok`).
- **Domain:** point `trip.crcmz.me` at the Coolify service.

### Required environment variables

| Variable | What it is |
| --- | --- |
| `ZITADEL_ISSUER` | Zitadel instance URL, e.g. `https://auth.crcmz.me` |
| `ZITADEL_CLIENT_ID` | Client ID of the OIDC app registered in Zitadel (public client, PKCE) |
| `SESSION_SECRET` | Long random string for the session cookie (`openssl rand -hex 32`) |
| `BASE_URL` | `https://trip.crcmz.me` |
| `PORT` | Optional — defaults to `3000` |
| `UPLOADS_DIR` | Optional — photo storage dir, defaults to `/app/data/uploads` in the container |
| `MAX_FILE_MB` | Optional — max size per uploaded file, defaults to `50` |

### Zitadel setup (one-time)

Register a Web application in Zitadel as a **public client** using the
Authorization Code flow with **PKCE (S256)** — no client secret — and this
exact redirect URI:

```
https://trip.crcmz.me/auth/callback
```

Every visitor must sign in with a Zitadel account before any page or asset
is served; only `/healthz` and the `/auth/*` endpoints are public.

## Photo Wall (self-hosted uploads)

The Photos tab is a working album on this server — no Google Photos:

- `POST /api/photos` — multipart upload, form field `photos` (up to 20 files,
  images and videos, 50 MB each by default).
- `GET /api/photos` — JSON list of what's on the wall (newest first).
- `GET /uploads/<name>` — serves one uploaded file.

All three sit behind the same Zitadel login. Files are stored under
`UPLOADS_DIR` (default `/app/data/uploads` in the container) with an
`index.json` beside them recording who uploaded what, when.

**Coolify:** mount a persistent volume at `/app/data` (or set `UPLOADS_DIR`
to wherever the volume is mounted). Without a volume, uploaded photos are
wiped on every redeploy.
