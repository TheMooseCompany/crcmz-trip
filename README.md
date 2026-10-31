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

| `TRIP_APP_TOKEN` | Optional — lets the CRCMZ app's Trips show and change this trip's Split and Moments as the signed-in person (the bridge in `server.js`: those calls only). Same value as `TRIP_APP_TOKEN` in the CRCMZ app. Unset = off. |
| `TRIP_SERVICE_TOKEN` | Optional — lets app.crcmz.me's read-only MCP read the trip (`GET /api/service/tool/<name>`, Trip AI read tools only). Same value in the CRCMZ app. Unset = off. |

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

## Split ledger protection and recovery

`LEDGER_PATH` defaults to `/app/data/ledger.json` in the container. Keep its
parent directory on persistent storage. Split runs in a **single process**;
do not share this JSON store between replicas or edit it while the app runs.

A genuinely new store initializes an empty ledger. Malformed JSON, an invalid
ledger structure, storage read errors, or a missing ledger with an existing
backup directory cause HTTP **503** with `code: LEDGER_UNAVAILABLE` and a
human-readable error. Expense/settlement additions and deletions stop; damaged
bytes are never silently replaced with empty arrays. The dashboard also reports
this error rather than presenting misleading zero totals.

Before each replacement, the current validated ledger is saved under
`<LEDGER_PATH>.backups/<sha256>.json`. Snapshots are immutable and deduplicated;
backup failure aborts the mutation. Writes use unique temporary files, file
fsync, atomic rename, and directory fsync. Snapshots contain the same sensitive
expense data as the ledger. Back up this directory off-host as well; local
snapshots cannot protect against loss of the entire volume. No automatic
retention deletes snapshots; monitor disk usage.

### Explicit offline recovery

1. Stop the app so recovery cannot race with purchases or settlements.
2. Preserve/copy the ledger and backup directory off-host. Inspect candidate
   snapshots and compare their expense/settlement IDs and totals. Filenames
   are content hashes, **not chronological order**. Each snapshot represents
   the state **before** a write, so the latest purchase may need reconciliation.
3. Run with the same volume, filesystem permissions, and `LEDGER_PATH` as the app:

   ```sh
   LEDGER_PATH=/app/data/ledger.json node ledger-store.js recover /app/data/ledger.json.backups/CHOSEN_HASH.json
   ```

   The command validates the chosen file before changing anything, preserves
   an existing primary as `ledger.json.damaged-<uuid>` (and aborts if it cannot
   preserve it), then atomically restores the chosen snapshot. It also works
   when the primary is missing. It never repairs automatically on a request.
4. Review restored totals and any missing recent entries before restarting.
   Keep the preserved file and other snapshots for reconciliation.

Run `npm test` for isolated temporary-directory regression tests; no production
records, live authentication, or Photo Wall storage are used.
