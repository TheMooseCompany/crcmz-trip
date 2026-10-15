# CRCMZ Trip

The CRCMZ BOYZ Calgary trip hub (Oct 29 – Nov 1, 2026): flight-convergence
cinematic, countdown, crew, the Airbnb, day plans, Food Finder, Photo Wall,
the Split, and the FC 27 tournament.

The page itself is a single static HTML file (`public/index.html` +
`public/assets`). A thin Express server (`server.js`) serves it and gates
every route behind a **Zitadel OIDC login** (Authorization Code flow,
`passport-openidconnect`). There is no database; sessions are signed cookies
(in-memory session store — run a single instance).

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
| `ZITADEL_CLIENT_ID` | Client ID of the OIDC app registered in Zitadel |
| `ZITADEL_CLIENT_SECRET` | That application's client secret |
| `SESSION_SECRET` | Long random string for the session cookie (`openssl rand -hex 32`) |
| `BASE_URL` | `https://trip.crcmz.me` |
| `PORT` | Optional — defaults to `3000` |

### Zitadel setup (one-time)

Register a Web application in Zitadel with the Authorization Code flow and
this exact redirect URI:

```
https://trip.crcmz.me/auth/callback
```

Every visitor must sign in with a Zitadel account before any page or asset
is served; only `/healthz` and the `/auth/*` endpoints are public.
