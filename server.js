'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const multer = require('multer');
// Photo Wall thumbnails (Oct 17): sharp generates grid-sized derivatives
// of local uploads. Loaded defensively — if the native binary is ever
// unavailable, /uploads-thumb falls back to the original bytes and the
// wall keeps working, just heavier.
let sharpLib = null;
try { sharpLib = require('sharp'); } catch { sharpLib = null; }

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CALLBACK_PATH = '/auth/callback';
const CALLBACK_URL = `${BASE_URL}${CALLBACK_PATH}`;

const REQUIRED = ['ZITADEL_ISSUER', 'ZITADEL_CLIENT_ID', 'SESSION_SECRET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[crcmz-trip] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
const ISSUER = process.env.ZITADEL_ISSUER.replace(/\/$/, '');
const SERVICE_TOKEN = process.env.ZITADEL_SERVICE_TOKEN || '';
const WEBAUTHN_RP_ID = process.env.WEBAUTHN_RP_ID || 'crcmz.me';
const WEBAUTHN_LEGACY_RP_ID = process.env.WEBAUTHN_LEGACY_RP_ID || 'auth.crcmz.me';

// ---------- Photo Wall storage ----------
// Uploads live on this server's disk under UPLOADS_DIR (default
// <app>/data/uploads). Optional env: UPLOADS_DIR, MAX_FILE_MB (default 50).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'data', 'uploads');
const INDEX_PATH = path.join(UPLOADS_DIR, 'index.json');
const DATA_DIR = path.join(__dirname, 'data');
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);
// Immich integration (optional — falls back to local-only if unset)
const IMMICH_URL = (process.env.IMMICH_URL || '').replace(/\/$/, '');
const IMMICH_API_KEY = process.env.IMMICH_API_KEY || '';
const IMMICH_ALBUM_ID = process.env.IMMICH_ALBUM_ID || '';
const IMMICH_SHARE_URL = process.env.IMMICH_SHARE_URL || '';
const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif',
  '.mp4', '.mov', '.webm', '.m4v',
]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif']);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

// Upload a local file to Immich and add it to the album.
// Returns the Immich asset id, or null on any failure.
async function uploadToImmich(filePath, originalName, mtime) {
  if (!IMMICH_URL || !IMMICH_API_KEY) return null;
  try {
    const fileData = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('assetData', new File([fileData], originalName));
    form.append('deviceId', 'crcmz-trip');
    form.append('deviceAssetId', `trip-${path.basename(filePath)}`);
    form.append('fileCreatedAt', mtime || new Date().toISOString());
    form.append('fileModifiedAt', mtime || new Date().toISOString());
    form.append('isFavorite', 'false');
    const r = await fetch(`${IMMICH_URL}/api/assets`, {
      method: 'POST',
      headers: { 'x-api-key': IMMICH_API_KEY },
      body: form,
    });
    if (!r.ok) { console.error('[crcmz-trip] Immich upload failed:', r.status, await r.text()); return null; }
    const j = await r.json();
    const assetId = j && (j.id || j.assetId);
    if (assetId && IMMICH_ALBUM_ID) {
      const ar = await fetch(`${IMMICH_URL}/api/albums/${IMMICH_ALBUM_ID}/assets`, {
        method: 'PUT',
        headers: { 'x-api-key': IMMICH_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: [assetId] }),
      });
      if (!ar.ok) console.error('[crcmz-trip] Immich add-to-album failed:', ar.status, await ar.text());
    }
    return assetId || null;
  } catch (e) {
    console.error('[crcmz-trip] Immich error:', e.message);
    return null;
  }
}

function readIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
function writeIndex(index) {
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index, null, 2));
}
// Delete any local files that were already uploaded to Immich (clean up on restart).
function pruneLocalFiles() {
  const index = readIndex();
  for (const [name, meta] of Object.entries(index)) {
    if (!meta.immichId) continue;
    const localPath = path.join(UPLOADS_DIR, name);
    if (fs.existsSync(localPath)) {
      fs.unlink(localPath, () => {});
    }
  }
}
pruneLocalFiles();

const photoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const rand = crypto.randomBytes(4).toString('hex');
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `${stamp}-${rand}${ext}`);
    },
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXT.has(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext || '(none)'} — photos and videos only.`));
  },
});

function displayName(user) {
  if (!user) return 'crew';
  return user.name || user.preferred_username || user.email || 'crew';
}

async function main() {
  const issuer = await Issuer.discover(ISSUER);

  const client = new issuer.Client({
    client_id: process.env.ZITADEL_CLIENT_ID,
    redirect_uris: [CALLBACK_URL],
    response_types: ['code'],
    token_endpoint_auth_method: 'none', // PKCE — no client secret needed
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: BASE_URL.startsWith('https://'),
        maxAge: 1000 * 60 * 60 * 24 * 7,
      },
    })
  );

  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

  // Installable app ("Add to Home Screen") with "Share to CRCMZ Trip": the manifest, its
  // icons and the service worker are fetched by the browser without the session cookie,
  // so they're public. None of them holds anything private.
  const PWA_FILES = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript',
    '/pwa-192.png': 'image/png', '/pwa-512.png': 'image/png' };
  app.get(Object.keys(PWA_FILES), (req, res) => {
    res.type(PWA_FILES[req.path]);
    res.set('Cache-Control', req.path === '/sw.js' ? 'no-cache' : 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', req.path));
  });
  // A share that arrives before the service worker is in place (it normally answers
  // this POST itself): open the page and say so.
  app.post('/share', (req, res) => res.redirect(303, '/?shared=nosw'));

  // ---------- Passkey auth (when ZITADEL_SERVICE_TOKEN is set) ----------
  app.post('/auth/passkey/begin', async (req, res) => {
    if (!SERVICE_TOKEN) return res.status(503).json({ error: 'not configured' });
    const identifier = (req.body && req.body.identifier || '').trim();
    let loginName = null;
    if (identifier) {
      loginName = identifier;
      if (identifier.includes('@')) {
        try {
          const sr = await fetch(`${ISSUER}/management/v1/users/_search`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ queries: [{ emailQuery: { emailAddress: identifier, method: 'TEXT_QUERY_METHOD_EQUALS' } }] }),
          });
          if (sr.ok) {
            const data = await sr.json();
            if (data.result && data.result.length > 0) {
              loginName = data.result[0].preferredLoginName || identifier;
              console.log('[crcmz-trip] passkey/begin resolved to loginName:', loginName.slice(0, 4) + '...');
            } else {
              console.log('[crcmz-trip] passkey/begin email not in Zitadel, trying as loginName directly');
            }
          }
        } catch (_) { /* use identifier as-is */ }
      }
    }
    try {
      // Try current RP ID first; fall back to legacy RP ID if Zitadel says
      // no credentials registered there (WEBAU-4G8sw = passkey registered to old domain).
      const rpDomains = [...new Set([WEBAUTHN_RP_ID, WEBAUTHN_LEGACY_RP_ID])];
      let r, errBody;
      for (const domain of rpDomains) {
        const webAuthN = { domain, userVerificationRequirement: 'USER_VERIFICATION_REQUIREMENT_REQUIRED' };
        const body = loginName
          ? { checks: { user: { loginName } }, challenges: { webAuthN } }
          : { challenges: { webAuthN } };
        r = await fetch(`${ISSUER}/v2/sessions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!(r.status >= 500 && (errBody = await r.text()).includes('WEBAU-4G8sw'))) break;
        console.log('[crcmz-trip] passkey/begin: WEBAU-4G8sw on', domain, '— retrying with legacy RP ID');
      }
      if (!r.ok) {
        if (!errBody) errBody = await r.text();
        console.error('[crcmz-trip] passkey/begin Zitadel error:', r.status, errBody.slice(0, 300));
        const msg = r.status === 404 ? 'No CRCMZ account found for that email. Use the email you signed up with.' : 'Could not start passkey flow. Try the email from your CRCMZ account.';
        return res.status(404).json({ error: msg });
      }
      const data = await r.json();
      const raw = data?.challenges?.webAuthN?.publicKeyCredentialRequestOptions;
      if (!raw) return res.status(500).json({ error: 'no webauthn challenge returned' });
      const options = raw.publicKey || raw;
      res.json({ sessionId: data.sessionId, options });
    } catch (e) {
      console.error('[crcmz-trip] passkey/begin error:', e.message);
      res.status(503).json({ error: 'service unavailable' });
    }
  });

  app.post('/auth/passkey/complete', async (req, res) => {
    if (!SERVICE_TOKEN) return res.status(503).json({ error: 'not configured' });
    const { sessionId, assertion } = req.body || {};
    if (!sessionId || !assertion) return res.status(400).json({ error: 'sessionId and assertion required' });
    try {
      const r = await fetch(`${ISSUER}/v2/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ checks: { webAuthN: { credentialAssertionData: assertion } } }),
      });
      if (!r.ok) return res.status(401).json({ error: 'passkey verification failed' });
      const sr = await fetch(`${ISSUER}/v2/sessions/${sessionId}`, {
        headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}` },
      });
      const userF = (await sr.json())?.session?.factors?.user || {};
      const sub = userF.id || '';
      if (!sub) return res.status(401).json({ error: 'session invalid' });
      req.session.user = {
        sub,
        email: userF.loginName || '',
        name: userF.displayName || userF.loginName || '',
        preferred_username: userF.loginName || '',
      };
      const next = (typeof req.query.next === 'string' && req.query.next.startsWith('/')) ? req.query.next : (req.session.returnTo || '/');
      delete req.session.returnTo;
      res.json({ ok: true, next });
    } catch (e) {
      console.error('[crcmz-trip] passkey/complete error:', e.message);
      res.status(503).json({ error: 'service unavailable' });
    }
  });

  // Zitadel login names are not always the email, so resolve what was typed
  // (email, username or login name) to a user id before the password check.
  async function findUserId(identifier) {
    const queries = identifier.includes('@')
      ? [{ emailQuery: { emailAddress: identifier, method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } },
         { loginNameQuery: { loginName: identifier, method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } }]
      : [{ userNameQuery: { userName: identifier, method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } },
         { loginNameQuery: { loginName: identifier, method: 'TEXT_QUERY_METHOD_EQUALS_IGNORE_CASE' } }];
    // v2 searches the whole instance; management v1 only sees the token's own org.
    for (const q of queries) {
      const sr = await fetch(`${ISSUER}/v2/users`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { limit: 2 }, queries: [{ typeQuery: { type: 'TYPE_HUMAN' } }, q] }),
      });
      if (!sr.ok) continue;
      const hit = ((await sr.json()).result || [])[0];
      if (hit) return hit.id || hit.userId || null;
    }
    return null;
  }

  app.post('/auth/password/login', async (req, res) => {
    if (!SERVICE_TOKEN) return res.status(503).json({ error: 'not configured' });
    const { identifier, password } = req.body || {};
    if (!identifier || !password) return res.status(400).json({ error: 'identifier and password required' });
    try {
      const userId = await findUserId(identifier.trim());
      if (!userId) return res.status(401).json({ error: 'No CRCMZ account found for that email or username.' });
      const r = await fetch(`${ISSUER}/v2/sessions`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ checks: { user: { userId }, password: { password } } }),
      });
      if (!r.ok) {
        const errBody = await r.text();
        console.error('[crcmz-trip] password/login Zitadel error:', r.status, errBody.slice(0, 200));
        const locked = /locked/i.test(errBody);
        return res.status(401).json({ error: locked ? 'Account locked after too many tries. Reset it at app.crcmz.me.' : 'Wrong password.' });
      }
      const data = await r.json();
      const sessionId = data.sessionId;
      if (!sessionId) return res.status(401).json({ error: 'Login failed.' });
      const sr = await fetch(`${ISSUER}/v2/sessions/${sessionId}`, {
        headers: { 'Authorization': `Bearer ${SERVICE_TOKEN}` },
      });
      const userF = (await sr.json())?.session?.factors?.user || {};
      const sub = userF.id || '';
      if (!sub) return res.status(401).json({ error: 'Session invalid.' });
      req.session.user = {
        sub,
        email: userF.loginName || '',
        name: userF.displayName || userF.loginName || '',
        preferred_username: userF.loginName || '',
      };
      const next = (req.session.returnTo && req.session.returnTo !== req.path)
        ? req.session.returnTo : '/';
      delete req.session.returnTo;
      res.json({ ok: true, next });
    } catch (e) {
      console.error('[crcmz-trip] password/login error:', e.message);
      res.status(503).json({ error: 'service unavailable' });
    }
  });

  app.get('/auth/login', (req, res) => {
    if (req.query.returnTo && typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/')) {
      req.session.returnTo = req.query.returnTo;
    }
    // Show custom sign-in page unless ?proceed=1 (OIDC fallback).
    if (!req.query.proceed) {
      const hasPasskey = !!SERVICE_TOKEN;
      return res.set('Cache-Control', 'no-cache').type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="dark"/>
<title>Sign in · CRCMZ Trip</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&family=Newsreader:ital,wght@1,500&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0A0E27;--surface:rgba(255,255,255,.04);--line:rgba(245,239,224,.12);--cream:#F5EFE0;--muted:#A9A5C6;--amber:#F2B33D;--amber2:#FFC65C;--err:#F87171;--indigo:#5B63E8}
html,body{height:100%;background:var(--bg);color:var(--cream);font-family:"Space Grotesk",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;padding:env(safe-area-inset-top,24px) 24px env(safe-area-inset-bottom,24px);position:relative;overflow:hidden;background:radial-gradient(1100px 620px at 50% 30%,#131B4A 0%,var(--bg) 52%,#060818 100%)}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 50% 30%,rgba(242,179,61,.07),transparent 70%),radial-gradient(ellipse 60% 50% at 20% 80%,rgba(165,180,255,.06),transparent 65%);pointer-events:none}
/* Backdrop (React Bits review): the app's stage sky brought to the
   sign-in page — the stage radial above plus a STATIC star layer in
   the same language as the hero's frozen starfield. No animation. */
body::after{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;opacity:.5;background-repeat:no-repeat;background-image:radial-gradient(1.6px 1.6px at 8% 14%,rgba(245,239,224,.85) 50%,transparent 52%),radial-gradient(1.1px 1.1px at 22% 30%,rgba(245,239,224,.6) 50%,transparent 52%),radial-gradient(1.3px 1.3px at 36% 8%,rgba(214,222,255,.7) 50%,transparent 52%),radial-gradient(1px 1px at 47% 24%,rgba(245,239,224,.55) 50%,transparent 52%),radial-gradient(1.5px 1.5px at 58% 12%,rgba(245,239,224,.8) 50%,transparent 52%),radial-gradient(1px 1px at 66% 34%,rgba(245,239,224,.5) 50%,transparent 52%),radial-gradient(1.4px 1.4px at 74% 18%,rgba(214,222,255,.65) 50%,transparent 52%),radial-gradient(1px 1px at 83% 28%,rgba(245,239,224,.6) 50%,transparent 52%),radial-gradient(1.6px 1.6px at 91% 10%,rgba(245,239,224,.85) 50%,transparent 52%),radial-gradient(1px 1px at 15% 44%,rgba(245,239,224,.45) 50%,transparent 52%),radial-gradient(1.1px 1.1px at 88% 46%,rgba(245,239,224,.5) 50%,transparent 52%),radial-gradient(1.2px 1.2px at 30% 52%,rgba(245,239,224,.35) 50%,transparent 52%)}
.card{display:flex;flex-direction:column;align-items:center;gap:20px;width:100%;max-width:360px;padding:36px 32px 32px;background:var(--surface);border:1px solid var(--line);border-radius:24px;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);position:relative;z-index:1}
.logo{display:flex;flex-direction:column;align-items:center;gap:10px}
.logo-mark{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#10163A 0%,#0D1233 100%);border:1px solid rgba(242,179,61,.25);display:flex;align-items:center;justify-content:center}
.logo-mark svg{width:28px;height:28px}
.logo-name{font-size:22px;font-weight:700;letter-spacing:.02em;color:var(--cream)}
.logo-trip{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.22em;color:var(--muted);text-transform:uppercase;margin-top:-4px}
.divider{width:100%;height:1px;background:var(--line)}
.copy{text-align:center}
.copy h1{font-size:20px;font-weight:600;letter-spacing:-.01em;color:var(--cream);margin-bottom:6px}
.copy h1 .serif{font-family:"Newsreader",Georgia,serif;font-style:italic;font-weight:500;color:var(--amber2)}
.copy p{font-size:13.5px;color:var(--muted);line-height:1.55}
/* tabs */
.tabs{display:flex;width:100%;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:12px;padding:3px;gap:3px}
.tab-btn{flex:1;padding:9px 0;border:none;border-radius:9px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:600;letter-spacing:.01em;background:transparent;color:var(--muted);transition:background .15s,color .15s}
.tab-btn.active{background:rgba(255,255,255,.09);color:var(--cream)}
/* panels */
.panel{display:none;flex-direction:column;gap:12px;width:100%}
.panel.active{display:flex}
/* inputs */
.field{display:flex;flex-direction:column;gap:6px;width:100%}
.field label{font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--muted);text-transform:uppercase}
.field input{width:100%;padding:12px 14px;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:10px;color:var(--cream);font-family:inherit;font-size:16px;outline:none;transition:border-color .15s}
.field input:focus{border-color:rgba(242,179,61,.5);background:rgba(255,255,255,.08)}
.field input::placeholder{color:rgba(245,239,224,.25)}
/* buttons */
.btn{display:flex;align-items:center;justify-content:center;gap:9px;width:100%;padding:14px 20px;border:none;border-radius:12px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:700;letter-spacing:.02em;text-decoration:none;transition:opacity .15s,transform .1s}
.btn:active{opacity:.85;transform:scale(.98)}
.btn:disabled{opacity:.5;cursor:default;pointer-events:none}
.btn-primary{background:var(--amber);color:#221A04}
.btn-ghost{background:rgba(255,255,255,.06);color:var(--cream);border:1px solid var(--line)}
.btn svg{width:17px;height:17px;flex-shrink:0}
.errmsg{font-size:12.5px;color:var(--err);text-align:center;min-height:16px;line-height:1.4}
.footer{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--muted);letter-spacing:.06em;text-align:center;line-height:1.7;margin-top:4px}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <div class="logo-mark">
      <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M14 4C8.477 4 4 8.477 4 14s4.477 10 10 10 10-4.477 10-10S19.523 4 14 4z" stroke="#f2b33d" stroke-width="1.6"/>
        <path d="M9.5 14a4.5 4.5 0 0 1 9 0" stroke="#f2b33d" stroke-width="1.6" stroke-linecap="round"/>
        <circle cx="14" cy="14" r="1.8" fill="#f2b33d"/>
      </svg>
    </div>
    <div>
      <div class="logo-name">CRCMZ TRIP</div>
      <div class="logo-trip">Calgary &nbsp;·&nbsp; Oct 29 – Nov 1</div>
    </div>
  </div>
  <div class="divider"></div>
  <div class="copy">
    <h1>Welcome <span class="serif">back</span></h1>
    <p>Sign in with your CRCMZ account.</p>
  </div>

  ${hasPasskey ? `
  <div class="tabs" role="tablist">
    <button class="tab-btn active" id="tab-pk" role="tab" aria-selected="true" onclick="switchTab('passkey')">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline;margin-right:5px;vertical-align:-2px"><path d="M14 1.5l-1.5 1.5m-5 5a3.5 3.5 0 1 1-5 5 3.5 3.5 0 0 1 5-5zm0 0L10 7m0 0l2 2 3.5-3.5-2-2"/></svg>Passkey
    </button>
    <button class="tab-btn" id="tab-pw" role="tab" aria-selected="false" onclick="switchTab('password')">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline;margin-right:5px;vertical-align:-2px"><rect x="2" y="7" width="12" height="8" rx="2"/><path d="M5 7V5a3 3 0 1 1 6 0v2"/></svg>Password
    </button>
  </div>

  <!-- passkey panel -->
  <div class="panel active" id="panel-passkey">
    <div class="field">
      <label for="em">Email</label>
      <input type="email" id="em" placeholder="your@email.com" autocomplete="username webauthn" autocapitalize="off" inputmode="email" onkeydown="if(event.key==='Enter')passkeyLogin()"/>
    </div>
    <div class="errmsg" id="pk-err"></div>
    <button class="btn btn-primary" id="pkBtn" onclick="passkeyLogin()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
      Sign in with Passkey
    </button>
  </div>

  <!-- password panel -->
  <div class="panel" id="panel-password">
    <div class="field">
      <label for="pw-em">Email or username</label>
      <input type="text" id="pw-em" placeholder="Email or username" autocomplete="username" autocapitalize="off" spellcheck="false" onkeydown="if(event.key==='Enter')document.getElementById('pw-pass').focus()"/>
    </div>
    <div class="field">
      <label for="pw-pass">Password</label>
      <input type="password" id="pw-pass" placeholder="••••••••" autocomplete="current-password" onkeydown="if(event.key==='Enter')passwordLogin()"/>
    </div>
    <div class="errmsg" id="pw-err"></div>
    <button class="btn btn-primary" id="pwBtn" onclick="passwordLogin()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      Sign in
    </button>
  </div>
  ` : `
  <div style="width:100%;display:flex;flex-direction:column;gap:12px">
    <a class="btn btn-primary" href="/auth/login?proceed=1">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
      Sign in with CRCMZ
    </a>
  </div>
  `}

  <div class="footer">CRCMZ · trip.crcmz.me</div>
</div>
${hasPasskey ? `<script>
function b64url(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'')}
function fromB64url(s){const pad='='.repeat((4-s.length%4)%4);return Uint8Array.from(atob((s+pad).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)).buffer}

function switchTab(tab){
  document.getElementById('tab-pk').classList.toggle('active',tab==='passkey');
  document.getElementById('tab-pw').classList.toggle('active',tab==='password');
  document.getElementById('panel-passkey').classList.toggle('active',tab==='passkey');
  document.getElementById('panel-password').classList.toggle('active',tab==='password');
  if(tab==='passkey')document.getElementById('em').focus();
  else document.getElementById('pw-em').focus();
}

let _conditionalAbort=null;
async function _begin(identifier,silent){
  const br=await fetch('/auth/passkey/begin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(identifier?{identifier}:{})});
  if(!br.ok){if(!silent)document.getElementById('pk-err').textContent=(await br.json()).error||'Could not start passkey flow.';return null;}
  const {sessionId,options}=await br.json();
  options.challenge=fromB64url(options.challenge);
  if(options.allowCredentials)options.allowCredentials=options.allowCredentials.map(c=>({...c,id:fromB64url(c.id)}));
  return {sessionId,options};
}
async function _complete(sessionId,cred){
  const assertion={id:cred.id,rawId:b64url(cred.rawId),type:cred.type,response:{clientDataJSON:b64url(cred.response.clientDataJSON),authenticatorData:b64url(cred.response.authenticatorData),signature:b64url(cred.response.signature),userHandle:cred.response.userHandle?b64url(cred.response.userHandle):null}};
  const cr=await fetch('/auth/passkey/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,assertion})});
  if(!cr.ok){document.getElementById('pk-err').textContent=(await cr.json()).error||'Passkey verification failed.';return;}
  const d=await cr.json();window.location.href=d.next||'/';
}
async function passkeyLogin(){
  if(!window.PublicKeyCredential){document.getElementById('pk-err').textContent='Passkeys not supported in this browser.';return;}
  if(_conditionalAbort){_conditionalAbort.abort();_conditionalAbort=null;}
  const identifier=document.getElementById('em').value.trim();
  if(!identifier){document.getElementById('em').focus();document.getElementById('pk-err').textContent='Enter your email first.';return;}
  document.getElementById('pk-err').textContent='';
  const btn=document.getElementById('pkBtn');
  btn.disabled=true;btn.textContent='Waiting for passkey…';
  try{
    const began=await _begin(identifier);
    if(!began)return;
    const cred=await navigator.credentials.get({publicKey:began.options});
    await _complete(began.sessionId,cred);
  }catch(e){
    if(e.name!=='NotAllowedError')document.getElementById('pk-err').textContent='Passkey error: '+e.message;
  }finally{
    btn.disabled=false;
    btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>Sign in with Passkey';
  }
}
async function passwordLogin(){
  const identifier=document.getElementById('pw-em').value.trim();
  const password=document.getElementById('pw-pass').value;
  if(!identifier||!password){document.getElementById('pw-err').textContent='Enter your email and password.';return;}
  document.getElementById('pw-err').textContent='';
  const btn=document.getElementById('pwBtn');
  btn.disabled=true;btn.textContent='Signing in…';
  try{
    const r=await fetch('/auth/password/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({identifier,password})});
    const d=await r.json();
    if(!r.ok){document.getElementById('pw-err').textContent=d.error||'Sign in failed.';return;}
    window.location.href=d.next||'/';
  }catch(e){
    document.getElementById('pw-err').textContent='Network error. Try again.';
  }finally{
    btn.disabled=false;
    btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>Sign in';
  }
}
(async()=>{
  if(!window.PublicKeyCredential)return;
  const ok=await PublicKeyCredential.isConditionalMediationAvailable?.()??false;
  if(!ok)return;
  const began=await _begin('',true);
  if(!began)return;
  _conditionalAbort=new AbortController();
  try{const cred=await navigator.credentials.get({publicKey:began.options,mediation:'conditional',signal:_conditionalAbort.signal});await _complete(began.sessionId,cred);}
  catch(e){if(e.name!=='AbortError'&&e.name!=='NotAllowedError')console.warn('conditional passkey:',e);}
})();
</script>` : ''}
</body>
</html>`);
    }
    const state = generators.state();
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    req.session.oidcState = state;
    req.session.codeVerifier = codeVerifier;
    const authUrl = client.authorizationUrl({
      scope: 'openid profile email',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    res.redirect(authUrl);
  });

  app.get(CALLBACK_PATH, async (req, res) => {
    try {
      const params = client.callbackParams(req);
      const tokenSet = await client.callback(CALLBACK_URL, params, {
        code_verifier: req.session.codeVerifier,
        state: req.session.oidcState,
      });
      const userinfo = await client.userinfo(tokenSet.access_token);
      req.session.user = userinfo;
      delete req.session.codeVerifier;
      delete req.session.oidcState;
      const target = req.session.returnTo || '/';
      delete req.session.returnTo;
      res.redirect(target);
    } catch (err) {
      console.error('[crcmz-trip] Auth callback error:', err.message);
      res.redirect('/auth/login');
    }
  });

  app.get('/auth/logout', (req, res) => {
    const endSessionUrl = issuer.end_session_endpoint;
    req.session.destroy(() => {
      if (endSessionUrl) {
        const u = new URL(endSessionUrl);
        u.searchParams.set('post_logout_redirect_uri', `${BASE_URL}/auth/login`);
        return res.redirect(u.toString());
      }
      res.redirect('/auth/login');
    });
  });

  // A machine caller (app.crcmz.me's read-only MCP) may GET a few data endpoints
  // with TRIP_SERVICE_TOKEN instead of a session. GET only, these paths only: those
  // handlers never touch req.session.user. Unset token = no service access at all.
  // Not named SERVICE_TOKEN: that would shadow the Zitadel token (top of file)
  // for everything in main(), and passkey + password sign-in would send this one.
  const TRIP_SERVICE_TOKEN = process.env.TRIP_SERVICE_TOKEN || '';
  const SERVICE_GET_PATHS = new Set(['/api/expenses', '/api/packing', '/api/poll', '/api/flights', '/api/weather']);
  function isService(req) {
    const got = req.get('x-trip-service') || '';
    if (!TRIP_SERVICE_TOKEN || !got || got.length !== TRIP_SERVICE_TOKEN.length) return false;
    return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(TRIP_SERVICE_TOKEN));
  }
  function requireAuth(req, res, next) {
    if (req.session.user) return next();
    if (req.method === 'GET' && SERVICE_GET_PATHS.has(req.path) && isService(req)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    // Only save the intended destination for browser navigations (text/html).
    // Asset requests (fonts, JS, CSS, images) must never overwrite it — doing
    // so causes a post-login redirect to a binary file, triggering a download.
    const accept = req.get('Accept') || '';
    if (accept.includes('text/html')) {
      req.session.returnTo = req.originalUrl || '/';
    }
    return res.redirect('/auth/login');
  }

  // ---------- Photo Wall API (auth required) ----------
  app.get('/api/photos', requireAuth, (req, res) => {
    const index = readIndex();
    const items = Object.values(index)
      .filter((m) => {
        if (m.hidden) return false;
        // Keep if Immich-backed (proxy URL) or still local
        return m.immichId || fs.existsSync(path.join(UPLOADS_DIR, m.name));
      })
      .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
      .map((m) => {
        const url = m.immichId
          ? `/album/asset/${m.immichId}/original`
          : `/uploads/${encodeURIComponent(m.name)}`;
        const thumb = m.immichId
          ? `/album/asset/${m.immichId}/thumbnail`
          : `/uploads-thumb/${encodeURIComponent(m.name)}`;
        return {
          name: m.name,
          originalName: m.originalName,
          url,
          thumb,
          uploadedBy: m.uploadedBy,
          uploadedAt: m.uploadedAt,
          size: m.size,
          kind: IMAGE_EXT.has(path.extname(m.name).toLowerCase()) ? 'image' : 'video',
        };
      });
    res.json({ photos: items });
  });

  app.post('/api/photos', requireAuth, (req, res) => {
    photoUpload.array('photos', 20)(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File too large — max ${MAX_FILE_MB} MB each.`
          : err.message || 'Upload failed.';
        return res.status(400).json({ error: msg });
      }
      const files = req.files || [];
      if (files.length === 0) return res.status(400).json({ error: 'No files received.' });
      const index = readIndex();
      const by = displayName(req.session.user);
      const now = new Date().toISOString();
      const added = files.map((f) => {
        const meta = {
          name: f.filename,
          originalName: f.originalname,
          uploadedBy: by,
          uploadedAt: now,
          size: f.size,
        };
        index[f.filename] = meta;
        return meta;
      });
      writeIndex(index);
      // Fire Immich uploads in the background — don't block the response.
      // On success: store immichId in index and delete the local file (Immich is the source of truth).
      if (IMMICH_URL && IMMICH_API_KEY) {
        Promise.all(files.map((f) => {
          const localPath = path.join(UPLOADS_DIR, f.filename);
          return uploadToImmich(localPath, f.originalname, now).then((assetId) => {
            if (!assetId) return;
            const idx = readIndex();
            if (idx[f.filename]) { idx[f.filename].immichId = assetId; writeIndex(idx); }
            fs.unlink(localPath, () => {});
          });
        })).catch(() => {});
      }
      res.status(201).json({ ok: true, added: added.map((m) => m.name) });
    });
  });

  app.get('/uploads/:name', requireAuth, (req, res) => {
    const name = path.basename(req.params.name); // traversal guard
    const index = readIndex();
    if (!index[name]) return res.status(404).type('text/plain').send('Not found');
    const filePath = path.join(UPLOADS_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).type('text/plain').send('Not found');
    res.sendFile(filePath);
  });

  // Photo Wall grid thumbnails (Oct 17, audit #4): the grid previously
  // loaded the full originals (its `thumb` URL WAS the original).
  // Derivatives are generated lazily on first request with sharp,
  // cached on the same data volume under thumbs/, and the originals
  // above remain what the viewer opens. Upload names are unique per
  // upload, so a cached derivative never needs invalidating.
  const THUMB_DIR = path.join(UPLOADS_DIR, 'thumbs');
  try { fs.mkdirSync(THUMB_DIR, { recursive: true }); } catch { /* retried per request */ }
  const thumbInflight = new Map();
  app.get('/uploads-thumb/:name', requireAuth, async (req, res) => {
    const name = path.basename(req.params.name); // traversal guard
    const index = readIndex();
    if (!index[name]) return res.status(404).type('text/plain').send('Not found');
    const filePath = path.join(UPLOADS_DIR, name);
    if (!fs.existsSync(filePath)) return res.status(404).type('text/plain').send('Not found');
    if (!sharpLib || !IMAGE_EXT.has(path.extname(name).toLowerCase())) return res.sendFile(filePath);
    const thumbPath = path.join(THUMB_DIR, `${name}.jpg`);
    try {
      if (!fs.existsSync(thumbPath)) {
        if (!thumbInflight.has(name)) {
          thumbInflight.set(name, (async () => {
            const buf = await sharpLib(filePath).rotate()
              .resize(480, 480, { fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 78 }).toBuffer();
            const tmp = `${thumbPath}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, thumbPath);
          })().finally(() => thumbInflight.delete(name)));
        }
        await thumbInflight.get(name);
      }
      res.set('Cache-Control', 'private, max-age=604800');
      res.type('image/jpeg');
      return res.sendFile(thumbPath);
    } catch { return res.sendFile(filePath); }
  });

  // ---------- Split ledger (auth required) ----------
  // Expenses + settlements live in one JSON document on the same data
  // volume as the photo uploads (LEDGER_PATH, default <app>/data/ledger.json).
  // All money is integer CAD cents; USD entries keep their original amount
  // and the rate they were logged at. Balances are computed by the client
  // from this raw ledger, so the numbers are always auditable.
  const LEDGER_PATH = process.env.LEDGER_PATH || path.join(__dirname, 'data', 'ledger.json');
  const PEOPLE = ['Mutasif', 'Moiz', 'Noor', 'Samad', 'Brendan', 'Zubi'];

  function readLedger() {
    try {
      const parsed = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      if (parsed && Array.isArray(parsed.expenses) && Array.isArray(parsed.settlements)) return parsed;
    } catch { /* fall through to an empty ledger */ }
    return { expenses: [], settlements: [] };
  }
  function writeLedger(ledger) {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    const tmp = `${LEDGER_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2));
    fs.renameSync(tmp, LEDGER_PATH);
  }
  const isCents = (n) => Number.isInteger(n) && n > 0;
  function validShares(shares, total) {
    if (!shares || typeof shares !== 'object' || Array.isArray(shares)) return false;
    const keys = Object.keys(shares);
    if (keys.length === 0) return false;
    let sum = 0;
    for (const k of keys) {
      if (!activePeople().includes(k) || !isCents(shares[k])) return false;
      sum += shares[k];
    }
    return sum === total;
  }
  function validExpense(e) {
    if (!e || typeof e !== 'object') return false;
    if (!activePeople().includes(e.payer)) return false;
    if (!isCents(e.amountCentsCAD)) return false;
    if (!validShares(e.shares, e.amountCentsCAD)) return false;
    if (e.currency !== 'CAD' && e.currency !== 'USD') return false;
    if (e.currency === 'USD') {
      if (!isCents(e.origCents)) return false;
      if (typeof e.fxRate !== 'number' || !(e.fxRate > 0)) return false;
    }
    if (typeof e.desc !== 'string' || e.desc.length > 200) return false;
    if (e.splitMode !== 'equal' && e.splitMode !== 'exact' && e.splitMode !== 'percent') return false;
    if (e.receipt != null && typeof e.receipt !== 'string') return false;
    return true;
  }

  app.get('/api/expenses', requireAuth, (req, res) => {
    res.json(readLedger());
  });

  app.post('/api/expenses', requireAuth, (req, res) => {
    const e = req.body || {};
    if (!validExpense(e)) return res.status(400).json({ error: 'Invalid expense.' });
    const ledger = readLedger();
    const record = {
      id: crypto.randomUUID(),
      payer: e.payer,
      desc: e.desc,
      amountCentsCAD: e.amountCentsCAD,
      currency: e.currency,
      origCents: e.currency === 'USD' ? e.origCents : e.amountCentsCAD,
      fxRate: e.currency === 'USD' ? e.fxRate : null,
      splitMode: e.splitMode,
      shares: e.shares,
      receipt: e.receipt || null,
      addedBy: displayName(req.session.user),
      addedAt: new Date().toISOString(),
    };
    ledger.expenses.push(record);
    writeLedger(ledger);
    res.status(201).json({ ok: true, expense: record });
  });

  app.delete('/api/expenses/:id', requireAuth, (req, res) => {
    const ledger = readLedger();
    const before = ledger.expenses.length;
    ledger.expenses = ledger.expenses.filter((x) => x.id !== req.params.id);
    if (ledger.expenses.length === before) return res.status(404).json({ error: 'No such expense.' });
    writeLedger(ledger);
    res.json({ ok: true });
  });

  app.post('/api/settlements', requireAuth, (req, res) => {
    const s = req.body || {};
    const ppl = activePeople();
    if (!ppl.includes(s.from) || !ppl.includes(s.to) || s.from === s.to || !isCents(s.amountCentsCAD)) {
      return res.status(400).json({ error: 'Invalid settlement.' });
    }
    const ledger = readLedger();
    const record = {
      id: crypto.randomUUID(),
      from: s.from,
      to: s.to,
      amountCentsCAD: s.amountCentsCAD,
      addedBy: displayName(req.session.user),
      addedAt: new Date().toISOString(),
    };
    ledger.settlements.push(record);
    writeLedger(ledger);
    res.status(201).json({ ok: true, settlement: record });
  });

  app.delete('/api/settlements/:id', requireAuth, (req, res) => {
    const ledger = readLedger();
    const idx = ledger.settlements.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Settlement not found.' });
    ledger.settlements.splice(idx, 1);
    writeLedger(ledger);
    res.json({ ok: true });
  });

  // Receipt uploads: images only, registered in the photo index as hidden
  // so /uploads serves them but they stay off the Photo Wall.
  const receiptUpload = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOADS_DIR),
      filename: (req, file, cb) => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const rand = crypto.randomBytes(4).toString('hex');
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, `receipt-${stamp}-${rand}${ext}`);
      },
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (IMAGE_EXT.has(ext)) return cb(null, true);
      cb(new Error(`Unsupported file type: ${ext || '(none)'} — images only.`));
    },
  });

  app.post('/api/receipts', requireAuth, (req, res) => {
    receiptUpload.single('receipt')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ error: 'No file received.' });
      const index = readIndex();
      index[req.file.filename] = {
        name: req.file.filename,
        originalName: req.file.originalname,
        uploadedBy: displayName(req.session.user),
        uploadedAt: new Date().toISOString(),
        size: req.file.size,
        hidden: true,
      };
      writeIndex(index);
      res.status(201).json({ ok: true, name: req.file.filename, url: `/uploads/${encodeURIComponent(req.file.filename)}` });
    });
  });

  // Scan a receipt: the vision model on the local AI server reads the total, the
  // currency and the place off the photo. Nothing is stored here: the client fills the
  // Add expense sheet with it (payer = you), and the receipt is saved with the expense.
  // Qwen3-VL 8B: ~5 s a receipt (gemma-4 26B read the same ones in ~40 s), totals with tax and tip right.
  const RECEIPT_MODEL = process.env.RECEIPT_VISION_MODEL || 'Qwen3-VL-8B-Instruct-MLX-4bit';
  const scanUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 12 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (/^image\//.test(file.mimetype || '') ? cb(null, true) : cb(new Error('Images only.'))),
  });
  const RECEIPT_PROMPT = `This is a photo of a receipt or bill. Read it and return ONLY a JSON object, no prose:
{"merchant": "the store or restaurant name, short", "total": the final amount paid as a number (the grand total after tax and tip, not a subtotal or a single item), "currency": "CAD" or "USD" or another ISO code (Canadian addresses, GST/PST or HST mean CAD; a US address or state sales tax means USD), "date": "YYYY-MM-DD" or "", "summary": "what it was for in 2-5 words, e.g. groceries, dinner, gas", "confidence": 0 to 1}
If it is not a receipt or the total can't be read, return {"total": null, "confidence": 0}.`;

  app.post('/api/receipts/scan', requireAuth, (req, res) => {
    scanUpload.single('receipt')(req, res, async (err) => {
      if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
      if (!req.file) return res.status(400).json({ error: 'No photo received.' });
      try {
        let img = req.file.buffer;
        let mime = req.file.mimetype;
        if (sharpLib) {
          img = await sharpLib(img).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
          mime = 'image/jpeg';
        }
        const base = (process.env.AI_BASE_URL || 'http://192.168.4.38:1234/v1').replace(/\/$/, '');
        const headers = { 'Content-Type': 'application/json' };
        if (process.env.OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
        const r = await fetch(`${base}/chat/completions`, {
          method: 'POST', headers,
          body: JSON.stringify({
            model: RECEIPT_MODEL, temperature: 0, max_tokens: 400, chat_template_kwargs: { enable_thinking: false },
            messages: [{ role: 'user', content: [
              { type: 'image_url', image_url: { url: `data:${mime};base64,${img.toString('base64')}` } },
              { type: 'text', text: RECEIPT_PROMPT }] }],
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (!r.ok) return res.status(502).json({ error: "The receipt reader isn't answering. Type the amount in." });
        const data = await r.json();
        const text = String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
        const m = text.match(/\{[\s\S]*\}/);
        let got = {};
        try { got = m ? JSON.parse(m[0]) : {}; } catch { got = {}; }
        const total = typeof got.total === 'number' ? got.total : parseFloat(String(got.total || '').replace(/[^0-9.]/g, ''));
        const cents = Number.isFinite(total) && total > 0 && total < 100000 ? Math.round(total * 100) : 0;
        if (!cents) return res.status(422).json({ error: "Couldn't find a total on that. Try a straighter, closer photo, or type it in." });
        const cur = String(got.currency || '').toUpperCase();
        res.json({
          ok: true, cents, currency: cur === 'CAD' || cur === 'USD' ? cur : null, otherCurrency: cur && cur !== 'CAD' && cur !== 'USD' ? cur : null,
          merchant: String(got.merchant || '').slice(0, 60), summary: String(got.summary || '').slice(0, 40),
          date: /^\d{4}-\d{2}-\d{2}$/.test(String(got.date || '')) ? got.date : '',
          confidence: typeof got.confidence === 'number' ? got.confidence : null,
        });
      } catch (e) {
        res.status(502).json({ error: e.name === 'TimeoutError' ? 'The receipt reader took too long. Type the amount in.' : 'Could not read that receipt.' });
      }
    });
  });

  // USD -> CAD rate from Frankfurter (ECB data), cached 12h, stale-tolerant.
  let fxCache = { rate: 1.419, at: 0, ok: false };
  app.get('/api/fx', requireAuth, async (req, res) => {
    const now = Date.now();
    if (fxCache.ok && now - fxCache.at < 12 * 3600 * 1000) {
      return res.json({ usdCad: fxCache.rate, stale: false });
    }
    try {
      const r = await fetch('https://api.frankfurter.app/latest?from=USD&to=CAD');
      const j = await r.json();
      const rate = j && j.rates && j.rates.CAD;
      if (typeof rate === 'number' && rate > 0) fxCache = { rate, at: now, ok: true };
    } catch { /* keep the last known rate */ }
    res.json({ usdCad: fxCache.rate, stale: !fxCache.ok });
  });

  // Who is logged in, mapped to a Split roster person so the client can
  // default the payer to the signed-in user instead of a fixed name.
  // Aliases per the CRCMZ identity chart (MCP person_profile): Mutasif's
  // identity name is "themoosecompany thegoopcompany"; Moiz is
  // InterestingSoup, PSN moiiz41510, WhatsApp name "MQ".
  const PERSON_ALIASES = [
    ['Mutasif', ['mutasif', 'moose', 'themoosecompany', 'thegoopcompany']],
    ['Moiz', ['moiz', 'soup', 'interestingsoup', 'moiiz41510', 'mq']],
    ['Noor', ['noor']],
    ['Samad', ['samad', 'asamad']],
    ['Brendan', ['brendan']],
    ['Zubi', ['zubi']],
  ];
  function matchPerson(user) {
    if (!user) return null;
    const hay = [user.name, user.preferred_username, user.email]
      .filter(Boolean).join(' ').toLowerCase();
    const tokens = hay.split(/[^a-z0-9]+/).filter(Boolean);
    for (const [person, aliases] of PERSON_ALIASES) {
      // Long aliases match as substrings; a short alias like "mq" must be
      // a whole token so it cannot false-positive inside other words.
      if (aliases.some((a) => (a.length >= 3 ? hay.includes(a) : tokens.includes(a)))) return person;
    }
    return null;
  }
  app.get('/api/me', requireAuth, (req, res) => {
    res.json({ name: displayName(req.session.user), person: matchPerson(req.session.user), isAdmin: isAdminUser(req.session.user), people: PEOPLE });
  });

  // ---------- Editable site content (admin-gated) ----------
  // The whole page renders from one content object. The server copy in
  // data/content.json is the source of truth; the client boots from its
  // local mirror, then syncs from GET /api/content. Writes are restricted
  // to the two test admins (Mutasif and Moiz, matched through the same
  // alias table as /api/me); everyone signed in may read.
  const CONTENT_PATH = process.env.CONTENT_PATH || path.join(__dirname, 'data', 'content.json');
  const ADMIN_PEOPLE = ['Mutasif', 'Moiz'];
  function isAdminUser(user) {
    const p = matchPerson(user);
    return !!p && ADMIN_PEOPLE.includes(p);
  }
  // Content epoch heal (Oct 17): the shipped defaults carry an epoch;
  // a saved file stamped below it is a stale whole-object copy (the
  // 50-spot list) and is treated as absent everywhere — GET serves null,
  // the admin state reads 'defaults', activePeople falls back — so a
  // stale save can never resurrect old content fleet-wide. New saves
  // are stamped with the shipped epoch in the PUT handler.
  function shippedEpoch() {
    const d = defaultContent();
    return d && typeof d.epoch === 'number' ? d.epoch : 0;
  }
  function readContent() {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const se = shippedEpoch();
        if (se > 0 && (parsed.epoch || 0) < se) return null;
        return parsed;
      }
    } catch { /* no content stored yet */ }
    return null;
  }
  function writeContent(content) {
    fs.mkdirSync(path.dirname(CONTENT_PATH), { recursive: true });
    const tmp = `${CONTENT_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(content, null, 2));
    fs.renameSync(tmp, CONTENT_PATH);
  }
  function contentPeople(content) {
    if (content && Array.isArray(content.splitPeople) && content.splitPeople.length > 0) {
      const names = content.splitPeople.map((p) => p && p.name).filter((n) => typeof n === 'string' && n.trim().length > 0);
      if (names.length === content.splitPeople.length && new Set(names).size === names.length) return names;
    }
    return null;
  }
  function activePeople() {
    return contentPeople(readContent()) || PEOPLE;
  }

  app.get('/api/content', requireAuth, (req, res) => {
    res.json({ content: readContent() });
  });

  app.put('/api/content', requireAuth, (req, res) => {
    if (!isAdminUser(req.session.user)) {
      return res.status(403).json({ error: 'Only Mutasif and Moiz can edit site content.' });
    }
    const c = req.body;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      return res.status(400).json({ error: 'Invalid content.' });
    }
    for (const k of ['trip', 'days', 'stay', 'food', 'buds', 'fifaTeams', 'splitPeople']) {
      if (!(k in c)) return res.status(400).json({ error: `Missing content section: ${k}` });
    }
    if (!Array.isArray(c.days) || !Array.isArray(c.food) || !Array.isArray(c.buds) || !Array.isArray(c.splitPeople)) {
      return res.status(400).json({ error: 'Content sections days/food/buds/splitPeople must be arrays.' });
    }
    c.epoch = shippedEpoch();
    writeContent(c);
    res.json({ ok: true });
  });

  // ---------- Admin console state (admin-gated, read-only) ----------
  // The Deck renders from this one payload: which content source is
  // live, the flights store + next movement, the Split ledger summary,
  // the photo wall count, and key PRESENCE (booleans only — key values
  // never leave the server). Same gate as content writes.
  app.get('/api/admin/state', requireAuth, (req, res) => {
    if (!isAdminUser(req.session.user)) {
      return res.status(403).json({ error: 'Only Mutasif and Moiz can view admin state.' });
    }
    // Content source: a saved data/content.json outranks the shipped
    // defaults; savedAt is the file's mtime (writeContent does not
    // stamp the payload itself).
    let content = { source: 'defaults', savedAt: null };
    if (readContent()) {
      let savedAt = null;
      try { savedAt = fs.statSync(CONTENT_PATH).mtime.toISOString(); } catch { /* stat raced a write */ }
      content = { source: 'saved', savedAt };
    }
    // Flights: count + next movement (earliest upcoming departure;
    // if every flight is in the past, the most recent one, flagged).
    const flights = readFlights();
    const now = Date.now();
    const timed = flights
      .map((f) => {
        const t = Date.parse(`${f.departureDate}T${f.departureTime || '00:00'}:00`);
        return { f, t: Number.isNaN(t) ? Infinity : t };
      })
      .sort((a, b) => a.t - b.t);
    const upNext = timed.find((x) => x.t >= now);
    const pick = upNext || timed[timed.length - 1] || null;
    const next = pick ? {
      person: pick.f.person,
      flightNumber: pick.f.flightNumber,
      originCode: pick.f.originCode,
      destinationCode: pick.f.destinationCode,
      departureDate: pick.f.departureDate,
      departureTime: pick.f.departureTime,
      arrivalTime: pick.f.arrivalTime,
      upcoming: !!upNext,
    } : null;
    // Split ledger summary (raw store totals; balances stay client-side).
    const ledger = readLedger();
    // Photo wall count — same visibility rule as GET /api/photos.
    const index = readIndex();
    const photoCount = Object.values(index)
      .filter((m) => !m.hidden && (m.immichId || fs.existsSync(path.join(UPLOADS_DIR, m.name))))
      .length;
    res.json({
      you: { name: displayName(req.session.user), person: matchPerson(req.session.user) },
      content,
      flights: { count: flights.length, next },
      ledger: {
        expenseCount: ledger.expenses.length,
        settlementCount: ledger.settlements.length,
        totalCentsCAD: ledger.expenses.reduce((s, e) => s + (e.amountCentsCAD || 0), 0),
      },
      photos: { count: photoCount },
      keys: { googlePlaces: !!PLACES_KEY, aeroapi: !!process.env.AEROAPI_KEY },
    });
  });

  // ---------- Buds AI recommendation ----------
  app.post('/api/buds/recommend', requireAuth, async (req, res) => {
    const { feeling } = req.body || {};
    if (!feeling || typeof feeling !== 'string' || !feeling.trim())
      return res.status(400).json({ error: 'feeling required' });
    if (feeling.length > 500)
      return res.status(400).json({ error: 'too long' });
    let c = readContent();
    if (!c) {
      // content.json may have been renamed; try the stale backup
      try {
        const stalePath = path.join(path.dirname(CONTENT_PATH), 'content.json.stale');
        c = JSON.parse(fs.readFileSync(stalePath, 'utf8'));
      } catch { /* no fallback either */ }
    }
    const buds = (c && Array.isArray(c.buds)) ? c.buds : [];
    if (buds.length === 0) return res.status(503).json({ error: 'No buds data available.' });
    const budsSummary = buds.map((b) => {
      const thcStr = Array.isArray(b.t) ? `${b.t[0]}-${b.t[1]}% THC` : '';
      const cbdStr = Array.isArray(b.cb) && (b.cb[0] > 0 || b.cb[1] > 0) ? ` / ${b.cb[0]}-${b.cb[1]}% CBD` : '';
      const type = b.c === 'edible' ? 'edible' : (b.c === 'preroll' ? 'pre-roll' : (b.i ? 'indica' : 'sativa/hybrid'));
      const rating = b.r ? ` ★${b.r}` : '';
      const inStock = (b.st || 0) > 0 ? 'yes' : 'no';
      return `- ${b.n} (${b.b}, ${type}${thcStr ? ', ' + thcStr : ''}${cbdStr}${rating}, $${b.p}/g, stock: ${inStock})`;
    }).join('\n');
    const aiBase = (process.env.AI_BASE_URL || 'http://192.168.4.38:1234/v1').replace(/\/$/, '');
    const aiModel = process.env.AI_MODEL || 'Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-8bit';
    const aiKey = process.env.OLLAMA_API_KEY || '';
    const userMsg = `You are a knowledgeable cannabis guide helping friends on a trip to Calgary.

Available products:
${budsSummary}

The user says: "${feeling.trim()}"

Suggest 2-3 products from the list that best match how they're feeling. Only recommend products where stock is "yes". For each, write 1-2 sentences explaining why it fits.

Return ONLY a valid JSON object with no explanation or markdown:
{"summary":"1-sentence overall note","suggestions":[{"name":"exact product name","brand":"brand name","why":"reason it fits"}]}`;
    try {
      const aiHeaders = { 'Content-Type': 'application/json' };
      if (aiKey) aiHeaders['Authorization'] = `Bearer ${aiKey}`;
      const r = await fetch(`${aiBase}/chat/completions`, {
        method: 'POST',
        headers: aiHeaders,
        body: JSON.stringify({
          model: aiModel,
          messages: [{ role: 'user', content: userMsg }],
          temperature: 0.4,
          max_tokens: 600,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) return res.status(502).json({ error: 'AI server error' });
      const data = await r.json();
      let content = (data.choices?.[0]?.message?.content || '').trim();
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return res.status(500).json({ error: 'AI did not return JSON' });
      const parsed = JSON.parse(match[0]);
      const rawSuggestions = parsed.suggestions || [];
      const suggestions = rawSuggestions.map((s) => {
        const bud = buds.find((b) => b.n === s.name);
        return { name: s.name, brand: s.brand || '', why: s.why || '', url: (bud && bud.u) || '' };
      });
      res.json({ ok: true, summary: parsed.summary || '', suggestions });
    } catch (e) {
      res.status(500).json({ error: e.message || 'recommend failed' });
    }
  });

  // Tourney: live tournaments from app.crcmz.me's read-only feed (TOURNEY_FEED_TOKEN).
  // Perf (Oct 17 device probe): the client polls this every 20 s and the
  // uncached upstream hop cost ~190 ms on device. A 10 s in-memory cache
  // halves upstream traffic; on an upstream error the last good payload
  // is served stale instead of an empty board. Payload shape unchanged.
  const TOURNEY_FEED_TOKEN = process.env.TOURNEY_FEED_TOKEN || '';
  const TOURNEY_FEED_URL = process.env.TOURNEY_FEED_URL || 'https://app.crcmz.me/api/tourney/feed';
  const TOURNEY_CACHE_TTL = Number(process.env.TOURNEY_CACHE_TTL_MS) > 0
    ? Number(process.env.TOURNEY_CACHE_TTL_MS) : 10000;
  let tourneyCache = null; // { tournaments, at }
  app.get('/api/tourney', requireAuth, async (req, res) => {
    if (!TOURNEY_FEED_TOKEN) return res.json({ tournaments: [], error: 'not configured' });
    if (tourneyCache && Date.now() - tourneyCache.at < TOURNEY_CACHE_TTL) {
      return res.set('Cache-Control', 'no-store').json({ tournaments: tourneyCache.tournaments });
    }
    let failure = null;
    try {
      const r = await fetch(TOURNEY_FEED_URL, {
        headers: { Authorization: `Bearer ${TOURNEY_FEED_TOKEN}` },
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) failure = `upstream ${r.status}`;
      else {
        const d = await r.json();
        const tournaments = Array.isArray(d.tournaments) ? d.tournaments : [];
        tourneyCache = { tournaments, at: Date.now() };
        return res.set('Cache-Control', 'no-store').json({ tournaments });
      }
    } catch {
      failure = 'unreachable';
    }
    if (tourneyCache) {
      return res.set('Cache-Control', 'no-store').json({ tournaments: tourneyCache.tournaments });
    }
    return res.json({ tournaments: [], error: failure || 'unreachable' });
  });

  // Link previews: chat/social crawlers (WhatsApp, iMessage, Telegram,
  // Discord, Slack…) cannot log in, so bot user-agents receive a tiny public
  // document carrying only the Open Graph tags, and the preview image is
  // public. Real visitors continue to the login gate untouched. The preview
  // exposes branding only — title, dates, one image — never site content.
  const PREVIEW_BOTS = /whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|discordbot|slackbot|linkedinbot|pinterest|redditbot|skypeuripreview|meta-externalagent/i;
  const PREVIEW_HTML = '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>CRCMZ BOYZ — Calgary Trip</title>'
    + '<meta name="description" content="Oct 29 – Nov 1, 2026 · Southeast Calgary. Itinerary, halal food guide, photo wall, expense split and the FC 27 tournament.">'
    + '<meta property="og:type" content="website">'
    + '<meta property="og:url" content="https://trip.crcmz.me/">'
    + '<meta property="og:title" content="CRCMZ BOYZ — Calgary Trip">'
    + '<meta property="og:description" content="Oct 29 – Nov 1, 2026 · Southeast Calgary. Itinerary, halal food guide, photo wall, expense split and the FC 27 tournament.">'
    + '<meta property="og:image" content="https://trip.crcmz.me/og-image-v2.jpg">'
    + '<meta property="og:image:type" content="image/jpeg">'
    + '<meta property="og:image:width" content="1200">'
    + '<meta property="og:image:height" content="630">'
    + '<meta name="twitter:card" content="summary_large_image">'
    + '<meta name="twitter:image" content="https://trip.crcmz.me/og-image-v2.jpg">'
    + '</head><body>CRCMZ BOYZ — Calgary Trip</body></html>';
  app.get('/og-image.jpg', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', 'og-image.jpg'));
  });
  /* v2 card (SE Calgary pool house). Versioned URL on purpose: chat apps
     cache link previews per image URL, so a new card needs a new URL. */
  app.get('/og-image-v2.jpg', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', 'og-image-v2.jpg'));
  });
  /* Browsers ask for /favicon.ico at the root regardless of the page's
     (placeholder) icon link — serve the app icon there, publicly, so the
     sign-in page gets it too. Long cache: the icon rarely changes. */
  app.get('/favicon.ico', (req, res) => {
    res.set('Cache-Control', 'public, max-age=604800');
    res.sendFile(path.join(__dirname, 'public', 'icon.webp'));
  });
  app.use((req, res, next) => {
    const p = req.path || '';
    if (req.method === 'GET'
      && !p.startsWith('/api') && !p.startsWith('/auth') && !p.startsWith('/uploads')
      && PREVIEW_BOTS.test(req.get('user-agent') || '')) {
      // Never let a crawler or intermediary cache this doc: a cached copy
      // would freeze any future preview fix out of the next scrape.
      res.set('Cache-Control', 'no-cache');
      return res.type('html').send(PREVIEW_HTML);
    }
    next();
  });

  // ---------- Immich asset proxy (serves thumbnails/originals with API key server-side) ----------
  // Album allowlist: only IDs that belong to IMMICH_ALBUM_ID may be proxied.
  // Refreshed every 5 minutes so new uploads appear without a restart.
  let albumAllowlist = new Set();
  let allowlistFetchedAt = 0;
  async function refreshAlbumAllowlist() {
    if (!IMMICH_URL || !IMMICH_API_KEY || !IMMICH_ALBUM_ID) return;
    try {
      const qp = `albumId=${encodeURIComponent(IMMICH_ALBUM_ID)}&size=MONTH&withPartners=false&withStacked=false`;
      const bucketsR = await fetch(`${IMMICH_URL}/api/timeline/buckets?${qp}`, { headers: { 'x-api-key': IMMICH_API_KEY } });
      if (!bucketsR.ok) return;
      const buckets = await bucketsR.json();
      const ids = new Set();
      for (const bucket of (Array.isArray(buckets) ? buckets : [])) {
        const bR = await fetch(`${IMMICH_URL}/api/timeline/bucket?${qp}&timeBucket=${encodeURIComponent(bucket.timeBucket)}`, { headers: { 'x-api-key': IMMICH_API_KEY } });
        if (!bR.ok) continue;
        const col = await bR.json();
        (col.id || []).forEach((id) => ids.add(id));
      }
      albumAllowlist = ids;
      allowlistFetchedAt = Date.now();
    } catch { /* keep stale list */ }
  }
  async function ensureAllowlist() {
    if (Date.now() - allowlistFetchedAt > 5 * 60 * 1000) await refreshAlbumAllowlist();
  }

  app.get('/album/asset/:id/thumbnail', requireAuth, async (req, res) => {
    if (!IMMICH_URL || !IMMICH_API_KEY) return res.status(404).end();
    await ensureAllowlist();
    if (!albumAllowlist.has(req.params.id)) return res.status(403).end();
    try {
      const r = await fetch(`${IMMICH_URL}/api/assets/${req.params.id}/thumbnail?size=preview`, {
        headers: { 'x-api-key': IMMICH_API_KEY },
      });
      if (!r.ok) return res.status(r.status).end();
      res.set('content-type', r.headers.get('content-type') || 'image/jpeg');
      res.set('cache-control', 'public, max-age=86400');
      const buf = await r.arrayBuffer();
      res.send(Buffer.from(buf));
    } catch { res.status(500).end(); }
  });

  app.get('/album/asset/:id/original', requireAuth, async (req, res) => {
    if (!IMMICH_URL || !IMMICH_API_KEY) return res.status(404).end();
    await ensureAllowlist();
    if (!albumAllowlist.has(req.params.id)) return res.status(403).end();
    try {
      const r = await fetch(`${IMMICH_URL}/api/assets/${req.params.id}/original`, {
        headers: { 'x-api-key': IMMICH_API_KEY },
      });
      if (!r.ok) return res.status(r.status).end();
      res.set('content-type', r.headers.get('content-type') || 'application/octet-stream');
      res.set('cache-control', 'public, max-age=86400');
      const buf = await r.arrayBuffer();
      res.send(Buffer.from(buf));
    } catch { res.status(500).end(); }
  });

  // ---------- Album gallery ----------
  // Fetches assets from Immich when configured; falls back to local index.json.
  app.get('/album', requireAuth, async (req, res) => {
    let items = [];
    let source = 'local';

    if (IMMICH_URL && IMMICH_API_KEY && IMMICH_ALBUM_ID) {
      try {
        // Always refresh the allowlist on gallery load so deletions take effect immediately.
        await refreshAlbumAllowlist();
        // Prune index entries whose immichId is no longer in the album.
        const idxToClean = readIndex();
        let pruned = false;
        for (const [name, meta] of Object.entries(idxToClean)) {
          if (meta.immichId && !albumAllowlist.has(meta.immichId)) {
            delete idxToClean[name]; pruned = true;
          }
        }
        if (pruned) writeIndex(idxToClean);
        // Use timeline bucket API — the only Immich v1.100+ endpoint that
        // correctly filters assets to a specific album.
        const qp = `albumId=${encodeURIComponent(IMMICH_ALBUM_ID)}&size=MONTH&withPartners=false&withStacked=false`;
        const bucketsR = await fetch(`${IMMICH_URL}/api/timeline/buckets?${qp}`, {
          headers: { 'x-api-key': IMMICH_API_KEY },
        });
        // Build immichId → uploadedBy map from local index (trip app uploads)
        const localIndex = readIndex();
        const immichIdToName = {};
        Object.values(localIndex).forEach((m) => {
          if (m.immichId) immichIdToName[m.immichId] = m.uploadedBy || 'crew';
        });

        if (bucketsR.ok) {
          const buckets = await bucketsR.json();
          // Collect unique ownerIds to resolve names for non-local photos
          const ownerIds = new Set();
          const rawItems = [];
          for (const bucket of (Array.isArray(buckets) ? buckets : [])) {
            const bR = await fetch(`${IMMICH_URL}/api/timeline/bucket?${qp}&timeBucket=${encodeURIComponent(bucket.timeBucket)}`, {
              headers: { 'x-api-key': IMMICH_API_KEY },
            });
            if (!bR.ok) continue;
            const col = await bR.json();
            const ids = col.id || [];
            ids.forEach((id, i) => {
              const ownerId = (col.ownerId || [])[i];
              if (ownerId) ownerIds.add(ownerId);
              rawItems.push({
                id, ownerId,
                url: `/album/asset/${id}/original`,
                thumb: `/album/asset/${id}/thumbnail`,
                originalName: id,
                uploadedAt: (col.fileCreatedAt || [])[i] || (col.createdAt || [])[i] || '',
                kind: (col.isImage || [])[i] !== false ? 'image' : 'video',
              });
            });
          }
          // Resolve owner names from Immich for photos not in local index
          const ownerNames = {};
          await Promise.all([...ownerIds].map(async (uid) => {
            try {
              const ur = await fetch(`${IMMICH_URL}/api/users/${uid}`, { headers: { 'x-api-key': IMMICH_API_KEY } });
              if (ur.ok) { const u = await ur.json(); ownerNames[uid] = u.name || u.email || 'crew'; }
            } catch { /* ignore */ }
          }));
          rawItems.forEach((item) => {
            items.push({
              ...item,
              uploadedBy: immichIdToName[item.id] || ownerNames[item.ownerId] || 'crew',
            });
          });
        }
        // Mark as immich even with 0 results — album may be intentionally empty.
        items.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
        source = 'immich';
      } catch (e) {
        console.error('[crcmz-trip] Immich album fetch failed:', e.message);
      }
    }

    if (source === 'local') {
      const index = readIndex();
      items = Object.values(index)
        .filter((m) => !m.hidden)
        .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
        .map((m) => ({
          id: m.name,
          url: `/uploads/${encodeURIComponent(m.name)}`,
          thumb: `/uploads/${encodeURIComponent(m.name)}`,
          originalName: m.originalName || m.name,
          uploadedBy: m.uploadedBy || '',
          uploadedAt: m.uploadedAt || '',
          kind: IMAGE_EXT.has(path.extname(m.name).toLowerCase()) ? 'image' : 'video',
        }));
    }

    const count = items.length;
    const shareHref = IMMICH_SHARE_URL ? ` <a href="${IMMICH_SHARE_URL}" target="_blank" rel="noopener" class="share-link">Open in Immich ↗</a>` : '';

    const tiles = items.map((item, i) => {
      const dt = item.uploadedAt ? new Date(item.uploadedAt) : null;
      const dateStr = dt ? dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '';
      const byEsc = item.uploadedBy.replace(/</g, '&lt;').replace(/"/g, '&quot;');
      const nameEsc = item.originalName.replace(/</g, '&lt;').replace(/"/g, '&quot;');
      const thumbEsc = item.thumb.replace(/"/g, '&quot;');
      const urlEsc = item.url.replace(/"/g, '&quot;');

      if (item.kind === 'video') {
        return `<div class="tile" data-i="${i}">
  <div class="tile-media" onclick="openLb(${i})">
    <video src="${urlEsc}" muted playsinline preload="metadata" class="tile-vid"></video>
    <div class="play-badge">▶</div>
  </div>
  <div class="tile-info"><span class="tile-by">${byEsc}</span><span class="tile-date">${dateStr}</span></div>
</div>`;
      }
      return `<div class="tile" data-i="${i}">
  <div class="tile-media" onclick="openLb(${i})">
    <img src="${thumbEsc}" loading="lazy" alt="${nameEsc}" decoding="async">
  </div>
  <div class="tile-info"><span class="tile-by">${byEsc}</span><span class="tile-date">${dateStr}</span></div>
</div>`;
    }).join('\n');

    const photosJson = JSON.stringify(items.map((item) => ({
      url: item.url,
      kind: item.kind,
      by: item.uploadedBy,
      name: item.originalName,
    })));

    res.set('Cache-Control', 'no-cache');
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="dark"/>
<link rel="icon" href="data:,">
<title>Album · CRCMZ Trip</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0A0E27;--panel:#10163A;--line:rgba(245,239,224,.12);
  --line-amber:rgba(242,179,61,.45);--amber:#F2B33D;--amber2:#FFC65C;
  --cream:#F5EFE0;--muted:#A9A5C6;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--cream);font-family:"Space Grotesk",system-ui,sans-serif;min-height:100dvh;-webkit-font-smoothing:antialiased}
a{color:var(--amber2);text-decoration:none}
.wrap{max-width:960px;margin:0 auto;padding:0 16px}
header{padding:24px 0 20px;border-bottom:1px solid var(--line);margin-bottom:20px}
.hdr{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px}
.hdr-left{display:flex;flex-direction:column;gap:4px}
.label{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.26em;text-transform:uppercase;color:var(--amber);font-weight:600}
.hdr h1{font-size:clamp(22px,4vw,34px);font-weight:700;letter-spacing:-.02em;line-height:1.1}
.hdr-meta{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.1em;color:var(--muted)}
.back{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:7px 14px;transition:border-color .18s,color .18s;white-space:nowrap}
.back:hover{color:var(--amber2);border-color:var(--line-amber)}
.share-link{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.1em;color:var(--muted)}
.share-link:hover{color:var(--amber2)}
/* Grid */
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:3px;padding-bottom:60px}
@media(max-width:640px){.grid{grid-template-columns:repeat(2,1fr)}}

.tile{display:flex;flex-direction:column;background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.tile-media{position:relative;aspect-ratio:1;overflow:hidden;cursor:pointer;background:#06080f}
.tile-media img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .25s}
.tile-media:hover img{transform:scale(1.04)}
.tile-vid{width:100%;height:100%;object-fit:cover;display:block;pointer-events:none}
.play-badge{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:28px;color:rgba(255,255,255,.85);text-shadow:0 2px 12px rgba(0,0,0,.6);pointer-events:none}
.tile-info{display:flex;justify-content:space-between;align-items:center;padding:6px 8px;gap:6px;min-height:32px}
.tile-by{font-size:12px;font-weight:600;color:var(--amber2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tile-date{font-family:"IBM Plex Mono",monospace;font-size:10.5px;color:var(--muted);white-space:nowrap;flex-shrink:0}
.empty{padding:60px 0;text-align:center;color:var(--muted);font-size:15px}
.upload-bar{display:flex;align-items:center;gap:12px;padding:14px 0 10px}
.btn-upload{display:inline-flex;align-items:center;gap:8px;background:var(--amber2);color:#0a0b12;font-size:14px;font-weight:700;padding:10px 18px;border-radius:99px;cursor:pointer;border:none;transition:opacity .15s}
.btn-upload:hover{opacity:.85}
#uploadStatus{font-size:13px;color:var(--muted)}
.wrap{padding-bottom:calc(100px + env(safe-area-inset-bottom,0px))}
/* The album's bar IS the app's floating glass pill (critique P1-9) —
   same geometry, glass, radius and drop-shadow recipe as the app's
   .tabbar, not the full-bleed square slab it used to be. */
.tabbar{position:fixed;left:50%;transform:translateX(-50%);bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:100;width:min(540px,calc(100% - 16px));display:flex;gap:2px;border-radius:30px;background:linear-gradient(160deg,rgba(26,30,58,.62),rgba(10,12,28,.55));backdrop-filter:blur(24px) saturate(180%);-webkit-backdrop-filter:blur(24px) saturate(180%);border:1px solid rgba(255,255,255,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.22);filter:drop-shadow(0 14px 20px rgba(2,3,10,.45));padding:8px}
.tabbar a.tab{flex:1;background:none;border:0;color:rgba(233,236,255,.82);display:flex;flex-direction:column;align-items:center;gap:4px;padding:7px 0 4px;font-family:"Space Grotesk",sans-serif;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;-webkit-tap-highlight-color:transparent;text-decoration:none}
.tabbar a.tab.on{color:var(--amber)}
.tabbar a.tab svg{width:21px;height:21px;stroke:currentColor;fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}
/* Lightbox */
#lb{display:none;position:fixed;inset:0;z-index:300;background:rgba(4,6,18,.96);flex-direction:column}
#lb.on{display:flex}
#lb-bar{display:flex;align-items:center;justify-content:space-between;padding:env(safe-area-inset-top,12px) 12px 8px;flex-shrink:0;min-height:56px}
#lb-caption{font-family:"IBM Plex Mono",monospace;font-size:11.5px;color:var(--muted);letter-spacing:.06em;flex:1;padding:0 4px}
.lb-close{background:rgba(255,255,255,.12);border:none;color:#fff;font-size:22px;line-height:1;border-radius:99px;width:44px;height:44px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0}
#lb-media{flex:1;display:flex;align-items:center;justify-content:center;overflow:hidden;padding:0 56px}
#lb-media img,#lb-media video{max-width:100%;max-height:100%;border-radius:8px;object-fit:contain;display:block}
.lb-nav{position:absolute;top:50%;transform:translateY(-50%);background:rgba(4,6,18,.75);border:1px solid var(--line);color:var(--cream);font-size:24px;border-radius:99px;width:48px;height:48px;display:flex;align-items:center;justify-content:center;cursor:pointer}
.lb-prev{left:6px}
.lb-next{right:6px}
</style>
</head>
<body>
<header><div class="wrap"><div class="hdr">
  <div class="hdr-left">
    <div class="label">CRCMZ Trip · Photos</div>
    <h1>Shared album</h1>
    <div class="hdr-meta">${count} item${count !== 1 ? 's' : ''}${IMMICH_SHARE_URL ? ' &nbsp;·&nbsp; <a href="' + IMMICH_SHARE_URL + '" target="_blank" rel="noopener" class="share-link">Open in Immich ↗</a>' : ''}</div>
  </div>
  <div style="width:44px"></div>
</div></div></header>

<div class="wrap">
<div class="upload-bar">
  <label class="btn-upload" id="uploadLabel">
    <input type="file" id="uploadInput" accept="image/*,video/*" multiple style="display:none">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
    Add Photos
  </label>
  <span id="uploadStatus"></span>
</div>
${count === 0
  ? '<p class="empty">No photos yet — be the first to upload!</p>'
  : `<div class="grid">\n${tiles}\n</div>`}
</div>

<div id="lb" role="dialog" aria-modal="true" aria-label="Photo viewer">
  <div id="lb-bar">
    <div id="lb-caption"></div>
    <button class="lb-close" onclick="closeLb()" aria-label="Close">&#x2715;</button>
  </div>
  <div id="lb-media">
    <button class="lb-nav lb-prev" onclick="lbStep(-1)" aria-label="Previous">&#x2039;</button>
    <div id="lb-inner"></div>
    <button class="lb-nav lb-next" onclick="lbStep(1)" aria-label="Next">&#x203a;</button>
  </div>
</div>

<script>
var ITEMS = ${photosJson};
var idx = 0;
function openLb(i) {
  idx = i; renderLb();
  document.getElementById('lb').classList.add('on');
  document.body.style.overflow = 'hidden';
}
function closeLb() {
  document.getElementById('lb').classList.remove('on');
  document.body.style.overflow = '';
  document.getElementById('lb-inner').innerHTML = '';
}
function lbStep(d) { idx = (idx + d + ITEMS.length) % ITEMS.length; renderLb(); }
function renderLb() {
  var p = ITEMS[idx], m = document.getElementById('lb-inner');
  if (p.kind === 'video') {
    m.innerHTML = '<video src="' + esc(p.url) + '" controls autoplay muted playsinline></video>';
  } else {
    m.innerHTML = '<img src="' + esc(p.url) + '" alt="' + esc(p.name) + '">';
  }
  document.getElementById('lb-caption').textContent = p.by + (p.by ? '  ·  ' : '') + (idx+1) + ' / ' + ITEMS.length;
}
function esc(s) { return s.replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
document.getElementById('lb-media').addEventListener('click', function(e) { if (e.target===this) closeLb(); });
document.addEventListener('keydown', function(e) {
  if (!document.getElementById('lb').classList.contains('on')) return;
  if (e.key==='Escape') closeLb();
  if (e.key==='ArrowLeft') lbStep(-1);
  if (e.key==='ArrowRight') lbStep(1);
});
</script>
<script>
(function(){
  var input=document.getElementById('uploadInput');
  var status=document.getElementById('uploadStatus');
  if(!input) return;
  input.addEventListener('change', function(){
    var files=input.files;
    if(!files||!files.length) return;
    var fd=new FormData();
    for(var i=0;i<files.length;i++) fd.append('photos',files[i]);
    status.textContent='Uploading '+files.length+(files.length===1?' photo…':' photos…');
    document.querySelector('.btn-upload').style.opacity='.5';
    fetch('/api/photos',{method:'POST',body:fd})
      .then(function(r){ return r.json().then(function(j){ if(!r.ok) throw new Error((j&&j.error)||'Upload failed.'); return j; }); })
      .then(function(){ status.textContent=''; location.reload(); })
      .catch(function(err){ status.textContent=err.message||'Upload failed.'; document.querySelector('.btn-upload').style.opacity=''; input.value=''; });
  });
})();
</script>
<nav class="tabbar" aria-label="Trip sections">
  <a class="tab" href="/#home"><svg viewBox="0 0 24 24"><path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/></svg><span>Home</span></a>
  <a class="tab" href="/#food"><svg viewBox="0 0 24 24"><path d="M4 16a8 8 0 0 1 16 0"/><path d="M2.5 19.5h19"/><path d="M12 8V6.5"/><circle cx="12" cy="5" r="1"/></svg><span>Food</span></a>
  <a class="tab on" href="/album"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3 17l5-4 4 3 3-2 6 4"/></svg><span>Photos</span></a>
  <a class="tab" href="/#split"><svg viewBox="0 0 24 24"><path d="M4 12h16"/><circle cx="12" cy="6" r="1.7"/><circle cx="12" cy="18" r="1.7"/></svg><span>Split</span></a>
  <a class="tab" href="/#fifa"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5l3.2 2.3-1.2 3.7h-4l-1.2-3.7z"/></svg><span>FIFA</span></a>
  <a class="tab" href="/#buds"><svg viewBox="0 0 24 24"><path d="M12 21c0-6 1-10 6-14 3-2.4 4-2 4-2s.3 5.5-2 9.5C17.8 18.3 14 20 12 21z"/><path d="M12 21c0-6-1-10-6-14C3 4.6 2 5 2 5s-.3 5.5 2 9.5C6.2 18.3 10 20 12 21z"/><path d="M12 21v-6"/></svg><span>Buds</span></a>
</nav>
</body>
</html>`);
  });

  // ---------- Weather forecast (Calgary, Open-Meteo, 30-min cache) ----------
  // ---------- Weather forecast (Calgary, Open-Meteo, 30-min cache) ----------
  // Uses forecast_days=16 and filters server-side to trip dates.
  // Nov 1 (the last trip day) falls outside the 16-day window until ~Oct 17;
  // it renders as unavailable until it enters the forecast horizon.
  const TRIP_DATES = ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
  let wxCache = { data: null, at: 0 };
  app.get('/api/weather', requireAuth, async (req, res) => {
    const now = Date.now();
    if (wxCache.data && now - wxCache.at < 30 * 60 * 1000) return res.json(wxCache.data);
    try {
      const url = 'https://api.open-meteo.com/v1/forecast'
        + '?latitude=51.0447&longitude=-114.0719'
        + '&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max,windspeed_10m_max'
        + '&temperature_unit=celsius&timezone=America%2FEdmonton'
        + '&forecast_days=16';
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      const j = await r.json();
      const d = j.daily || {};
      const times = d.time || [];
      const codes = d.weathercode || d.weather_code || [];
      const highs = d.temperature_2m_max || [];
      const lows = d.temperature_2m_min || [];
      const precip = d.precipitation_probability_max || [];
      const wind = d.windspeed_10m_max || [];
      const days = TRIP_DATES.map((date) => {
        const i = times.indexOf(date);
        if (i === -1) return { date, unavailable: true };
        return {
          date,
          code: codes[i] ?? 0,
          high: highs[i] ?? null,
          low: lows[i] ?? null,
          precip: precip[i] ?? null,
          wind: wind[i] != null ? Math.round(wind[i]) : null,
        };
      });
      wxCache = { data: { days }, at: now };
      res.json({ days });
    } catch (e) {
      console.error('[crcmz-trip] weather fetch failed:', e.message);
      if (wxCache.data) return res.json(wxCache.data);
      res.status(503).json({ error: 'Weather unavailable.' });
    }
  });

  // ---------- Google Places venue photos (Food guide) ----------
  // Terms-compliant shape: only the place_id is ever persisted
  // (data/places-cache.json, atomic writes like the ledger). Photo
  // resource names expire, so they are resolved fresh from Place
  // Details and held only in a short-lived in-memory cache (1h) -
  // long enough to spare a Details call on every card view, short
  // enough that a stale photo name is re-resolved the same day.
  // The API key lives only in the GOOGLE_PLACES_KEY env var; it is
  // never logged and never sent to the client.
  // Gallery extension: meta also reports photoCount (cap 5), the
  // default photoIndex and per-index attributions; /photo?n=<i>
  // serves slide i from the same cached Details. Only place_id is
  // persisted — photo names for every index stay memory-only.
  const PLACES_KEY = process.env.GOOGLE_PLACES_KEY || '';
  const PLACES_VENUES = require('./places-venues.js');
  const PLACES_BY_SLUG = new Map(PLACES_VENUES.map((v) => [v.slug, v]));
  const PLACES_CACHE_PATH =
    process.env.PLACES_CACHE_PATH || path.join(__dirname, 'data', 'places-cache.json');
  const PLACES_DETAILS_TTL = 60 * 60 * 1000;
  const PLACES_DETAILS_DISK_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
  const PLACES_PHOTOS_DIR = process.env.PLACES_PHOTOS_DIR || path.join(DATA_DIR, 'places-photos');
  const PLACES_PHOTO_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  try { fs.mkdirSync(PLACES_PHOTOS_DIR, { recursive: true }); } catch {}
  const placesMem = new Map(); // slug -> { details, at } | { pending }

  function readPlacesCache() {
    try {
      const parsed = JSON.parse(fs.readFileSync(PLACES_CACHE_PATH, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }
  function writePlacesCache(cache) {
    fs.mkdirSync(path.dirname(PLACES_CACHE_PATH), { recursive: true });
    const tmp = `${PLACES_CACHE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, PLACES_CACHE_PATH);
  }
  function photoMetaPath() { return path.join(PLACES_PHOTOS_DIR, 'meta.json'); }
  function readPhotoMeta() {
    try { return JSON.parse(fs.readFileSync(photoMetaPath(), 'utf8')) || {}; } catch { return {}; }
  }
  function writePhotoMeta(m) {
    const tmp = photoMetaPath() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, photoMetaPath());
  }
  function photoKey(photoName) {
    return crypto.createHash('sha256').update(photoName + '|800').digest('hex');
  }
  function cachePhotoToDisk(key, contentType, buf) {
    try {
      const p = path.join(PLACES_PHOTOS_DIR, key);
      fs.writeFileSync(p + '.tmp', buf);
      fs.renameSync(p + '.tmp', p);
      const m = readPhotoMeta();
      m[key] = { contentType, cachedAt: Date.now() };
      writePhotoMeta(m);
    } catch (e) { console.error('[crcmz-trip] photo cache write error:', e.message); }
  }
  function placesNorm(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // Card titles carry location suffixes the business itself does not
  // use ("Tahini's Airdrie - Yankee Valley"); match on the core name.
  function placesCoreName(name) {
    let core = String(name || '').split(/[\u2013\u2014]/)[0].trim();
    core = core.replace(/\s+(airdrie|calgary)$/i, '');
    return core;
  }
  function placesNameMatches(venueName, displayName) {
    const a = placesNorm(placesCoreName(venueName)).split(' ').filter((w) => w.length > 2);
    const b = new Set(placesNorm(displayName).split(' '));
    if (!a.length) return false;
    if (a.every((w) => b.has(w))) return true;
    const hits = a.filter((w) => b.has(w)).length;
    return hits / a.length >= 0.5 && hits >= 1;
  }
  function placesLocalityOk(venue, formattedAddress) {
    const fa = placesNorm(formattedAddress);
    const num = (venue.searchQuery.match(/\b\d{2,5}\b/) || [])[0];
    if (num) return fa.split(' ').includes(num);
    return ['calgary', 'airdrie', 'rocky view'].some((c) => fa.includes(c));
  }
  async function placesFetch(url, opts) {
    const r = await fetch(url, { ...(opts || {}), signal: AbortSignal.timeout(8000) });
    if (!r.ok) { const e = new Error(`Places upstream ${r.status}`); e.status = r.status; throw e; }
    return r;
  }
  async function resolvePlaceId(venue) {
    const disk = readPlacesCache();
    if (disk[venue.slug] && disk[venue.slug].placeId) return disk[venue.slug].placeId;
    const r = await placesFetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
      },
      body: JSON.stringify({ textQuery: venue.searchQuery, maxResultCount: 3, languageCode: 'en', regionCode: 'CA' }),
    });
    const j = await r.json();
    const candidates = (j && j.places) || [];
    const hit = candidates.find((p) => p.id && p.displayName
      && placesNameMatches(venue.name, p.displayName.text || '')
      && placesLocalityOk(venue, p.formattedAddress || ''));
    if (!hit) { const e = new Error('Places verify failed'); e.code = 'verify'; throw e; }
    disk[venue.slug] = {
      placeId: hit.id,
      displayName: (hit.displayName && hit.displayName.text) || '',
      formattedAddress: hit.formattedAddress || '',
      resolvedAt: new Date().toISOString(),
    };
    writePlacesCache(disk);
    return hit.id;
  }
  async function placeDetails(venue) {
    const now = Date.now();
    const mem = placesMem.get(venue.slug);
    if (mem && mem.details && now - mem.at < PLACES_DETAILS_TTL) return mem.details;
    if (mem && mem.pending) return mem.pending;
    // L2: disk cache (30-day TTL) — survives container restarts
    const diskCache = readPlacesCache();
    const diskEntry = diskCache[venue.slug];
    if (diskEntry && diskEntry.details && diskEntry.detailsCachedAt
        && (now - diskEntry.detailsCachedAt) < PLACES_DETAILS_DISK_TTL) {
      placesMem.set(venue.slug, { details: diskEntry.details, at: now });
      return diskEntry.details;
    }
    const pending = (async () => {
      const placeId = await resolvePlaceId(venue);
      const r = await placesFetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: {
          'X-Goog-Api-Key': PLACES_KEY,
          'X-Goog-FieldMask': 'id,displayName,formattedAddress,googleMapsUri,photos',
        },
      });
      const j = await r.json();
      const rawPhotos = ((j && j.photos) || []).filter((p) => p && p.name).slice(0, 5);
      // Up to 5 photos ride the same 1h Details cache — one upstream
      // Details call per venue per hour no matter how many indexes the
      // page fetches. Names stay memory-only, like the default photo's.
      const mapAttr = (p) => (p.authorAttributions
        ? p.authorAttributions.map((a) => ({ author: a.displayName || '', authorUri: a.uri || '' }))
        : []);
      const photos = rawPhotos.map((p) => ({
        name: p.name,
        attributions: mapAttr(p),
        // Pixel dims ride along (additive): the client picks the
        // first landscape photo as the card gallery's opening slide
        // (food/interior shots skew landscape; storefront openers
        // skew portrait). Names themselves stay server-side.
        widthPx: p.widthPx || 0,
        heightPx: p.heightPx || 0,
      }));
      const idx = venue.photoIndex < photos.length ? venue.photoIndex : 0;
      const photo = photos[idx] || null;
      const details = {
        placeId,
        googleMapsUri: (j && j.googleMapsUri) || '',
        photoName: photo ? photo.name : '',
        attributions: photo ? photo.attributions : [],
        photoCount: photos.length,
        photoIndex: idx,
        photos,
      };
      placesMem.set(venue.slug, { details, at: Date.now() });
      try {
        const d2 = readPlacesCache();
        if (!d2[venue.slug]) d2[venue.slug] = {};
        d2[venue.slug].details = details;
        d2[venue.slug].detailsCachedAt = Date.now();
        writePlacesCache(d2);
      } catch (e) { console.error('[crcmz-trip] places details disk write error:', e.message); }
      return details;
    })();
    placesMem.set(venue.slug, { pending });
    try { return await pending; } catch (e) { placesMem.delete(venue.slug); throw e; }
  }
  function placesVenueOrError(req, res) {
    const venue = PLACES_BY_SLUG.get(String(req.query.venue || ''));
    if (!venue) { res.status(404).json({ error: 'unknown-venue' }); return null; }
    if (!PLACES_KEY) { res.status(503).json({ error: 'places-key-missing' }); return null; }
    return venue;
  }
  function placesMetaPayload(d) {
    return {
      placeId: d.placeId,
      googleMapsUri: d.googleMapsUri,
      attributions: d.attributions,
      // Gallery extensions (additive; older consumers ignore them):
      // how many photos the gallery may serve (cap 5), which index is
      // the venue's default photo, and per-index author attributions
      // aligned with the ?n= indexes of /api/places/photo.
      photoCount: d.photoCount,
      photoIndex: d.photoIndex,
      photoAttributions: d.photos.map((p) => p.attributions),
      // Per-index pixel dims, aligned with photoAttributions and the
      // ?n= indexes of /api/places/photo (additive; older consumers
      // ignore it). Lets the client open galleries on the first
      // landscape photo instead of the storefront default.
      photoDims: d.photos.map((p) => ({ w: p.widthPx || 0, h: p.heightPx || 0 })),
    };
  }
  app.get('/api/places/meta', requireAuth, async (req, res) => {
    const venue = placesVenueOrError(req, res);
    if (!venue) return;
    try {
      const d = await placeDetails(venue);
      res.json(placesMetaPayload(d));
    } catch (e) {
      console.error('[crcmz-trip] places meta failed:', venue.slug, e.code || e.status || e.message);
      res.status(502).json({ error: e.code === 'verify' ? 'places-verify-failed' : 'places-upstream' });
    }
  });
  // Batched meta (perf fix, Oct 17 device probe): the Food view used to
  // fire one /api/places/meta request per venue — 98 in a single burst
  // on first open. On a cold Details cache each became up to two Google
  // calls (searchText + Details, 8 s abort each) with NO concurrency
  // control, so upstream throttling/timeouts picked off ~9% of venues
  // and each surfaced here as a hard 502 (see the handler above: any
  // placeDetails throw -> 502). This endpoint resolves every venue
  // through placeDetails behind a <=5-wide pool, reusing the same
  // memory/disk caches, and a venue whose resolution fails comes back
  // null — the endpoint itself always answers 200.
  async function placesPool(items, limit, fn) {
    let i = 0;
    async function worker() {
      while (i < items.length) { const it = items[i++]; await fn(it); }
    }
    const n = Math.max(1, Math.min(limit, items.length));
    await Promise.all(Array.from({ length: n }, worker));
  }
  app.get('/api/places/meta-all', requireAuth, async (req, res) => {
    const venues = {};
    if (!PLACES_KEY) {
      PLACES_VENUES.forEach((v) => { venues[v.slug] = null; });
      return res.json({ venues });
    }
    await placesPool(PLACES_VENUES, 5, async (venue) => {
      try {
        venues[venue.slug] = placesMetaPayload(await placeDetails(venue));
      } catch (e) {
        console.error('[crcmz-trip] places meta-all venue failed:', venue.slug, e.code || e.status || e.message);
        venues[venue.slug] = null;
      }
    });
    res.json({ venues });
  });
  // Streams one photo's bytes. photoName comes only from the in-memory
  // Details cache — never from the client, never from disk.
  async function streamPlacePhoto(res, d, photoName) {
    const key = photoKey(photoName);
    const filePath = path.join(PLACES_PHOTOS_DIR, key);
    const photoMeta = readPhotoMeta();
    const cached = photoMeta[key];
    if (cached && (Date.now() - cached.cachedAt) < PLACES_PHOTO_TTL_MS) {
      try {
        res.set('X-Place-Id', d.placeId);
        res.set('Cache-Control', 'private, max-age=2592000');
        res.type(cached.contentType);
        return res.sendFile(filePath);
      } catch { /* fall through to fetch */ }
    }
    const media = await placesFetch(
      `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&skipHttpRedirect=true`,
      { headers: { 'X-Goog-Api-Key': PLACES_KEY } });
    const ct = media.headers.get('content-type') || '';
    res.set('X-Place-Id', d.placeId);
    res.set('Cache-Control', 'private, max-age=2592000');
    let buf, finalCt;
    if (ct.startsWith('image/')) {
      buf = Buffer.from(await media.arrayBuffer());
      finalCt = ct;
    } else {
      const mj = await media.json();
      if (!mj || !mj.photoUri) return res.status(502).json({ error: 'places-upstream' });
      const img = await placesFetch(mj.photoUri, {});
      buf = Buffer.from(await img.arrayBuffer());
      finalCt = img.headers.get('content-type') || 'image/jpeg';
    }
    cachePhotoToDisk(key, finalCt, buf);
    res.type(finalCt);
    return res.send(buf);
  }
  app.get('/api/places/photo', requireAuth, async (req, res) => {
    const venue = placesVenueOrError(req, res);
    if (!venue) return;
    try {
      const d = await placeDetails(venue);
      if (!d.photoName) return res.status(502).json({ error: 'places-no-photo' });
      // ?n=<index> serves gallery slide n (0-based, meta order). No n =
      // the venue's default photo, exactly as before. A malformed or
      // out-of-range n is a clean 404 in the existing error vocabulary.
      if (req.query.n !== undefined) {
        const n = Number(req.query.n);
        if (!Number.isInteger(n) || n < 0 || n >= d.photos.length || !d.photos[n].name) {
          return res.status(404).json({ error: 'places-no-photo' });
        }
        return await streamPlacePhoto(res, d, d.photos[n].name);
      }
      return await streamPlacePhoto(res, d, d.photoName);
    } catch (e) {
      console.error('[crcmz-trip] places photo failed:', venue.slug, e.code || e.status || e.message);
      if (!res.headersSent) {
        res.status(502).json({ error: e.code === 'verify' ? 'places-verify-failed' : 'places-upstream' });
      }
    }
  });

  // ---------- Packing list ----------
  const PACK_PATH = path.join(__dirname, 'data', 'packing.json');
  const PACK_CATS = ['clothes', 'electronics', 'documents', 'buds', 'misc'];
  function readPacking() {
    try { return JSON.parse(fs.readFileSync(PACK_PATH, 'utf8')) || []; } catch { return []; }
  }
  function writePacking(list) {
    const tmp = `${PACK_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, PACK_PATH);
  }
  app.get('/api/packing', requireAuth, (req, res) => res.json({ items: readPacking() }));
  app.post('/api/packing', requireAuth, (req, res) => {
    const b = req.body || {};
    const text = (b.text || '').trim();
    if (!text || text.length > 120) return res.status(400).json({ error: 'Invalid item.' });
    const category = PACK_CATS.includes(b.category) ? b.category : 'misc';
    const validPeople = [...activePeople(), 'Everyone'];
    const assignedTo = validPeople.includes(b.assignedTo) ? b.assignedTo : 'Everyone';
    const list = readPacking();
    const item = { id: crypto.randomUUID(), text, category, assignedTo, addedBy: displayName(req.session.user), addedAt: new Date().toISOString(), checkedBy: null };
    list.push(item);
    writePacking(list);
    res.status(201).json({ ok: true, item });
  });
  app.patch('/api/packing/:id/check', requireAuth, (req, res) => {
    const list = readPacking();
    const item = list.find((i) => i.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found.' });
    item.checkedBy = item.checkedBy ? null : displayName(req.session.user);
    writePacking(list);
    res.json({ ok: true, checkedBy: item.checkedBy });
  });
  app.delete('/api/packing/:id', requireAuth, (req, res) => {
    const list = readPacking();
    const idx = list.findIndex((i) => i.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found.' });
    list.splice(idx, 1);
    writePacking(list);
    res.json({ ok: true });
  });

  // ---------- Group poll (active + history) ----------
  // Data: { active: <poll|null>, history: [...] }
  // Migrates old single-object format on first read.
  const POLL_PATH = path.join(__dirname, 'data', 'poll.json');
  function readPollStore() {
    try {
      const raw = JSON.parse(fs.readFileSync(POLL_PATH, 'utf8'));
      if (raw && typeof raw === 'object') {
        if ('active' in raw || 'history' in raw) return { active: raw.active || null, history: raw.history || [] };
        if (raw.id) return { active: raw.open ? raw : null, history: raw.open ? [] : [raw] };
      }
    } catch { /* no file */ }
    return { active: null, history: [] };
  }
  function writePollStore(s) {
    const tmp = `${POLL_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, POLL_PATH);
  }
  app.get('/api/poll', requireAuth, (req, res) => {
    const s = readPollStore();
    res.json({ active: s.active, history: (s.history || []).slice().reverse().slice(0, 20) });
  });
  app.post('/api/poll', requireAuth, (req, res) => {
    const { question, options } = req.body || {};
    if (typeof question !== 'string' || question.trim().length < 3 || question.trim().length > 200) {
      return res.status(400).json({ error: 'Invalid question.' });
    }
    if (!Array.isArray(options) || options.length < 2 || options.length > 8) {
      return res.status(400).json({ error: 'Need 2–8 options.' });
    }
    const opts = options.map((t, i) => {
      if (typeof t !== 'string' || !t.trim()) throw Object.assign(new Error('bad option'), { status: 400 });
      return { id: `opt${i}`, text: t.trim(), voters: [] };
    });
    const s = readPollStore();
    const history = s.history || [];
    if (s.active) { s.active.open = false; history.push(s.active); }
    const poll = { id: crypto.randomUUID(), question: question.trim(), options: opts, open: true, createdAt: new Date().toISOString(), createdBy: displayName(req.session.user) };
    writePollStore({ active: poll, history });
    res.status(201).json({ ok: true, active: poll });
  });
  app.post('/api/poll/vote', requireAuth, (req, res) => {
    const { optionId } = req.body || {};
    const s = readPollStore();
    if (!s.active || !s.active.open) return res.status(404).json({ error: 'No active poll.' });
    const opt = s.active.options.find((o) => o.id === optionId);
    if (!opt) return res.status(400).json({ error: 'Invalid option.' });
    const voter = matchPerson(req.session.user) || displayName(req.session.user);
    s.active.options.forEach((o) => { o.voters = o.voters.filter((v) => v !== voter); });
    opt.voters.push(voter);
    writePollStore(s);
    res.json({ ok: true, active: s.active });
  });
  app.delete('/api/poll', requireAuth, (req, res) => {
    const s = readPollStore();
    if (!s.active) return res.status(404).json({ error: 'No active poll.' });
    s.active.open = false;
    (s.history = s.history || []).push(s.active);
    writePollStore({ active: null, history: s.history });
    res.json({ ok: true });
  });

  // ── Flights store ──────────────────────────────────────────────────────────
  const FLIGHTS_PATH = path.join(__dirname, 'data', 'flights.json');
  function readFlights() {
    try { return JSON.parse(fs.readFileSync(FLIGHTS_PATH, 'utf8')); } catch { return []; }
  }
  function writeFlights(arr) {
    const tmp = FLIGHTS_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, FLIGHTS_PATH);
  }
  (function initFlights() {
    if (readFlights().length === 0) {
      writeFlights([{
        id: 'ac212-20261029',
        person: 'Moiz',
        flightNumber: 'AC 212',
        airline: 'Air Canada',
        origin: 'Vancouver', originCode: 'YVR',
        destination: 'Calgary', destinationCode: 'YYC',
        departureDate: '2026-10-29',
        departureTime: '11:30', arrivalTime: '13:59',
        duration: '1h 29m',
        aircraft: 'Airbus A220-300',
        cabin: 'Economy', hasWifi: true,
        status: 'scheduled',
        gate: '', terminal: 'Terminal M', notes: ''
      }]);
    }
  })();
  app.get('/api/flights', requireAuth, (req, res) => {
    res.json({ flights: readFlights() });
  });

  app.post('/api/flights/parse', requireAuth, async (req, res) => {
    const { text } = req.body || {};
    if (!text || typeof text !== 'string' || !text.trim())
      return res.status(400).json({ error: 'text required' });
    if (text.length > 4000)
      return res.status(400).json({ error: 'text too long (max 4000 chars)' });
    const aiBase = (process.env.AI_BASE_URL || 'http://192.168.4.38:1234/v1').replace(/\/$/, '');
    const aiModel = process.env.AI_MODEL || 'Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-8bit';
    const aiKey = process.env.OLLAMA_API_KEY || '';
    const userMsg = `Extract flight information from this booking/itinerary text. Return ONLY a valid JSON object — no explanation, no markdown fences.

Fields (use empty string for unknown, true/false for hasWifi):
flightNumber, airline, origin (city), originCode (IATA), destination (city), destinationCode (IATA),
departureDate (YYYY-MM-DD), departureTime (HH:MM 24h), arrivalTime (HH:MM 24h),
duration (e.g. "1h 29m"), aircraft, cabin, hasWifi, terminal, gate, notes

Text:
${text.trim()}`;
    try {
      const aiHeaders = { 'Content-Type': 'application/json' };
      if (aiKey) aiHeaders['Authorization'] = `Bearer ${aiKey}`;
      const r = await fetch(`${aiBase}/chat/completions`, {
        method: 'POST',
        headers: aiHeaders,
        body: JSON.stringify({
          model: aiModel,
          messages: [{ role: 'user', content: userMsg }],
          temperature: 0,
          max_tokens: 600,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(90000),
      });
      if (!r.ok) return res.status(502).json({ error: 'AI server error' });
      const data = await r.json();
      let content = (data.choices?.[0]?.message?.content || '').trim();
      // Strip Qwen3 thinking blocks (tagged or inline preamble)
      content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
      // Extract the JSON object — ignore any surrounding prose or markdown
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return res.status(500).json({ error: 'AI did not return JSON' });
      const flight = JSON.parse(match[0]);
      res.json({ ok: true, flight });
    } catch (e) {
      res.status(500).json({ error: e.message || 'parse failed' });
    }
  });
  app.post('/api/flights', requireAuth, (req, res) => {
    const { id, person, flightNumber, airline, origin, originCode, destination, destinationCode,
            departureDate, departureTime, arrivalTime, duration, aircraft, cabin, hasWifi,
            status, gate, terminal, notes } = req.body || {};
    if (!person || !flightNumber || !departureDate || !originCode || !destinationCode)
      return res.status(400).json({ error: 'Missing required fields.' });
    const VALID_STATUS = ['scheduled','on-time','delayed','boarding','departed','landed','cancelled'];
    if (status && !VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const flights = readFlights();
    const fid = id || crypto.randomUUID();
    const flight = { id: fid, person, flightNumber: flightNumber.trim(), airline: airline||'',
      origin: origin||'', originCode: originCode.toUpperCase().trim(),
      destination: destination||'', destinationCode: destinationCode.toUpperCase().trim(),
      departureDate, departureTime: departureTime||'', arrivalTime: arrivalTime||'',
      duration: duration||'', aircraft: aircraft||'', cabin: cabin||'', hasWifi: !!hasWifi,
      status: status||'scheduled', gate: gate||'', terminal: terminal||'', notes: notes||'' };
    const idx = flights.findIndex(f => f.id === fid);
    if (idx >= 0) flights[idx] = flight; else flights.push(flight);
    writeFlights(flights);
    res.json({ ok: true, flight });
  });
  app.patch('/api/flights/:id', requireAuth, (req, res) => {
    const VALID_STATUS = ['scheduled','on-time','delayed','boarding','departed','landed','cancelled'];
    const flights = readFlights();
    const idx = flights.findIndex(f => f.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Flight not found.' });
    const { status, gate, terminal, notes } = req.body || {};
    if (status) { if (!VALID_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status.' }); flights[idx].status = status; }
    if (gate !== undefined) flights[idx].gate = gate;
    if (terminal !== undefined) flights[idx].terminal = terminal;
    if (notes !== undefined) flights[idx].notes = notes;
    writeFlights(flights);
    res.json({ ok: true, flight: flights[idx] });
  });
  app.delete('/api/flights/:id', requireAuth, (req, res) => {
    writeFlights(readFlights().filter(f => f.id !== req.params.id));
    res.json({ ok: true });
  });

  // ---------- Trip AI (assistant.js) ----------
  // With no content.json the page renders its built-in defaults; the assistant
  // reads (and edits from) the same copy so it always sees what the page shows.
  let defaultContentCache;
  function defaultContent() {
    if (defaultContentCache !== undefined) return defaultContentCache;
    defaultContentCache = null;
    try {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      const m = html.match(/var CONTENT_DEFAULT\s*=\s*(\{.*\});\s*$/m);
      if (m) defaultContentCache = JSON.parse(m[1]);
    } catch (e) { console.error('[crcmz-trip] could not read content defaults:', e.message); }
    return defaultContentCache;
  }
  require('./assistant.js')(app, { requireAuth, isAdminUser, matchPerson, displayName, activePeople, port: PORT, readContent, defaultContent });
  // Moments: the trip's feed, its photos in the gallery, and the end-of-trip reel.
  require('./moments.js')(app, {
    requireAuth, readIndex, writeIndex, uploadToImmich, photoUpload, UPLOADS_DIR, IMAGE_EXT, DATA_DIR,
    displayName, matchPerson, isAdminUser, IMMICH_URL, IMMICH_API_KEY, sharpLib,
    tripContent: () => readContent() || defaultContent(),
  });

  // The admin console is NOT part of the public page. public/index.html
  // is a template carrying three placeholders; the dock button, the admin
  // view and the admin script live in private/ and are injected only for
  // the two admins (Mutasif and Moiz, per the CRCMZ identity chart).
  // Everyone else's copy of the page contains no admin markup or code.
  const PAGE_TEMPLATE_PATH = path.join(__dirname, 'public', 'index.html');
  let adminFragments = null;
  try {
    adminFragments = {
      dock: fs.readFileSync(path.join(__dirname, 'private', 'admin-dock.html'), 'utf8'),
      view: fs.readFileSync(path.join(__dirname, 'private', 'admin-view.html'), 'utf8'),
      script: fs.readFileSync(path.join(__dirname, 'private', 'admin-script.js'), 'utf8'),
    };
  } catch (e) {
    console.error('[crcmz-trip] admin fragments missing; admin console disabled:', e.message);
  }
  function renderPage(user) {
    let html = fs.readFileSync(PAGE_TEMPLATE_PATH, 'utf8');
    const parts = adminFragments && isAdminUser(user)
      ? { dock: adminFragments.dock, view: adminFragments.view, script: `<script>${adminFragments.script}</script>` }
      : { dock: '', view: '', script: '' };
    return html
      .replace('<!--ADMIN_DOCK-->', () => parts.dock)
      .replace('<!--ADMIN_VIEW-->', () => parts.view)
      .replace('<!--ADMIN_SCRIPT-->', () => parts.script);
  }
  app.get(['/', '/index.html'], requireAuth, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderPage(req.session.user));
  });
  app.use(requireAuth, express.static(path.join(__dirname, 'public'), {
    index: false,
    // Perf (audit win 3): /assets/** gets a real cache lifetime so repeat
    // visits skip revalidating art/fonts/images through the tunnel.
    // Filenames are stable (not content-hashed), so no `immutable`.
    // HTML is served by the route above and stays no-cache.
    setHeaders(res, filePath) {
      if (filePath.includes(path.sep + 'assets' + path.sep)) {
        res.setHeader('Cache-Control', 'public, max-age=604800');
      }
    },
  }));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[crcmz-trip] Listening on 0.0.0.0:${PORT}`);
    console.log(`[crcmz-trip] Issuer: ${ISSUER}`);
    console.log(`[crcmz-trip] OIDC redirect URI: ${CALLBACK_URL}`);
    console.log(`[crcmz-trip] Photo uploads: ${UPLOADS_DIR} (max ${MAX_FILE_MB} MB per file)`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

main().catch((err) => {
  console.error(`[crcmz-trip] Startup failed: ${err.message}`);
  process.exit(1);
});
