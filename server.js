'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Issuer, generators } = require('openid-client');
const multer = require('multer');

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

  app.get('/auth/login', (req, res) => {
    if (req.query.returnTo && typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/')) {
      req.session.returnTo = req.query.returnTo;
    }
    // Show custom sign-in page unless ?proceed=1 (OIDC fallback).
    if (!req.query.proceed) {
      const hasPasskey = !!SERVICE_TOKEN;
      return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="dark"/>
<title>Sign in · CRCMZ Trip</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#04060e;--surface:rgba(255,255,255,.04);--line:rgba(255,255,255,.09);--cream:#e9ecff;--muted:rgba(233,236,255,.45);--amber:#f2b33d}
html,body{height:100%;background:var(--bg);color:var(--cream);font-family:"IBM Plex Mono",monospace;-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100dvh;padding:env(safe-area-inset-top,24px) 24px env(safe-area-inset-bottom,24px);position:relative;overflow:hidden}
body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 50% 30%,rgba(242,179,61,.07),transparent 70%),radial-gradient(ellipse 60% 50% at 20% 80%,rgba(100,120,255,.06),transparent 65%);pointer-events:none}
.card{display:flex;flex-direction:column;align-items:center;gap:24px;width:100%;max-width:360px;padding:40px 32px 36px;background:var(--surface);border:1px solid var(--line);border-radius:20px;backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);position:relative;z-index:1}
.logo{display:flex;flex-direction:column;align-items:center;gap:10px}
.logo-mark{width:56px;height:56px;border-radius:16px;background:linear-gradient(135deg,#1a1d2e 0%,#0d0f1a 100%);border:1px solid rgba(242,179,61,.25);display:flex;align-items:center;justify-content:center}
.logo-mark svg{width:28px;height:28px}
.logo-name{font-size:22px;font-weight:600;letter-spacing:.12em;color:var(--cream)}
.logo-trip{font-size:11px;letter-spacing:.22em;color:var(--muted);text-transform:uppercase;margin-top:-4px}
.divider{width:100%;height:1px;background:var(--line)}
.copy{text-align:center;display:flex;flex-direction:column;gap:8px}
.copy h1{font-size:16px;font-weight:600;letter-spacing:.04em;color:var(--cream)}
.copy p{font-size:12.5px;color:var(--muted);line-height:1.6;letter-spacing:.02em}
input[type=email]{width:100%;padding:12px 14px;background:rgba(255,255,255,.06);border:1px solid var(--line);border-radius:10px;color:var(--cream);font-family:"IBM Plex Mono",monospace;font-size:13px;letter-spacing:.03em;outline:none;transition:border-color .15s}
input[type=email]:focus{border-color:rgba(242,179,61,.5)}
input[type=email]::placeholder{color:rgba(233,236,255,.3)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:14px 20px;border:none;border-radius:12px;cursor:pointer;font-family:"IBM Plex Mono",monospace;font-size:13.5px;font-weight:700;letter-spacing:.08em;text-decoration:none;transition:opacity .15s,transform .1s}
.btn:active{opacity:.85;transform:scale(.98)}
.btn:disabled{opacity:.5;cursor:default}
.btn-passkey{background:var(--amber);color:#09090e}
.btn-oidc{background:rgba(255,255,255,.07);color:var(--cream);border:1px solid var(--line);font-size:12.5px;margin-top:-4px}
.btn svg{width:18px;height:18px;flex-shrink:0}
.errmsg{font-size:12px;color:#f87171;text-align:center;min-height:18px;letter-spacing:.02em}
.footer{font-size:10.5px;color:var(--muted);letter-spacing:.06em;text-align:center;line-height:1.7}
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
      <div class="logo-name">CRCMZ</div>
      <div class="logo-trip">Trip 2.0 &nbsp;·&nbsp; YYC</div>
    </div>
  </div>
  <div class="divider"></div>
  <div class="copy">
    <h1>Welcome back</h1>
    <p>Sign in with your CRCMZ account to access the trip hub.</p>
  </div>
  ${hasPasskey ? `<input type="email" id="em" placeholder="your@email.com" autocomplete="username webauthn" autocapitalize="off" inputmode="email"/>
  <div class="errmsg" id="errmsg"></div>
  <button class="btn btn-passkey" id="pkBtn" onclick="passkeyLogin()">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
    Sign in with Passkey
  </button>
  <a class="btn btn-oidc" href="/auth/login?proceed=1">Use password instead</a>` : `<a class="btn btn-passkey" href="/auth/login?proceed=1">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
    Sign in with CRCMZ
  </a>`}
  <div class="footer">CRCMZ · auth.crcmz.me</div>
</div>
${hasPasskey ? `<script>
function b64url(buf){return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=/g,'')}
function fromB64url(s){const pad='='.repeat((4-s.length%4)%4);return Uint8Array.from(atob((s+pad).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)).buffer}
function showErr(msg){document.getElementById('errmsg').textContent=msg}

let _conditionalAbort=null;
async function _begin(identifier,silent){
  const br=await fetch('/auth/passkey/begin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(identifier?{identifier}:{})});
  if(!br.ok){if(!silent)showErr((await br.json()).error||'Could not start passkey flow.');return null;}
  const {sessionId,options}=await br.json();
  options.challenge=fromB64url(options.challenge);
  if(options.allowCredentials)options.allowCredentials=options.allowCredentials.map(c=>({...c,id:fromB64url(c.id)}));
  return {sessionId,options};
}
async function _complete(sessionId,cred){
  const assertion={id:cred.id,rawId:b64url(cred.rawId),type:cred.type,response:{clientDataJSON:b64url(cred.response.clientDataJSON),authenticatorData:b64url(cred.response.authenticatorData),signature:b64url(cred.response.signature),userHandle:cred.response.userHandle?b64url(cred.response.userHandle):null}};
  const cr=await fetch('/auth/passkey/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId,assertion})});
  if(!cr.ok){showErr((await cr.json()).error||'Passkey verification failed.');return;}
  window.location.href=(await cr.json()).next||'/';
}
async function passkeyLogin(){
  if(!window.PublicKeyCredential){showErr('Passkeys not supported in this browser.');return;}
  if(_conditionalAbort){_conditionalAbort.abort();_conditionalAbort=null;}
  const identifier=document.getElementById('em').value.trim();
  if(!identifier){document.getElementById('em').focus();showErr('Enter your email first.');return;}
  const btn=document.getElementById('pkBtn');
  btn.disabled=true;btn.textContent='Waiting for passkey…';
  try{
    const began=await _begin(identifier);
    if(!began)return;
    const cred=await navigator.credentials.get({publicKey:began.options});
    await _complete(began.sessionId,cred);
  }catch(e){
    if(e.name!=='NotAllowedError')showErr('Passkey error: '+e.message);
  }finally{btn.disabled=false;btn.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>Sign in with Passkey';}
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

  function requireAuth(req, res, next) {
    if (req.session.user) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    req.session.returnTo = req.originalUrl || '/';
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
          : `/uploads/${encodeURIComponent(m.name)}`;
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
    res.json({ name: displayName(req.session.user), person: matchPerson(req.session.user), isAdmin: isAdminUser(req.session.user) });
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
  function readContent() {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONTENT_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
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
    writeContent(c);
    res.json({ ok: true });
  });

  // Link previews: chat/social crawlers (WhatsApp, iMessage, Telegram,
  // Discord, Slack…) cannot log in, so bot user-agents receive a tiny public
  // document carrying only the Open Graph tags, and the preview image is
  // public. Real visitors continue to the login gate untouched. The preview
  // exposes branding only — title, dates, one image — never site content.
  const PREVIEW_BOTS = /whatsapp|facebookexternalhit|facebot|twitterbot|telegrambot|discordbot|slackbot|linkedinbot|pinterest|redditbot|skypeuripreview|meta-externalagent/i;
  const PREVIEW_HTML = '<!doctype html><html><head><meta charset="utf-8">'
    + '<title>CRCMZ BOYZ — Calgary Trip</title>'
    + '<meta name="description" content="Oct 29 – Nov 1, 2026 · Bayside, Airdrie. Itinerary, halal food guide, photo wall, expense split and the FC 27 tournament.">'
    + '<meta property="og:type" content="website">'
    + '<meta property="og:url" content="https://trip.crcmz.me/">'
    + '<meta property="og:title" content="CRCMZ BOYZ — Calgary Trip">'
    + '<meta property="og:description" content="Oct 29 – Nov 1, 2026 · Bayside, Airdrie. Itinerary, halal food guide, photo wall, expense split and the FC 27 tournament.">'
    + '<meta property="og:image" content="https://trip.crcmz.me/og-image.jpg">'
    + '<meta property="og:image:width" content="1200">'
    + '<meta property="og:image:height" content="630">'
    + '<meta name="twitter:card" content="summary_large_image">'
    + '</head><body>CRCMZ BOYZ — Calgary Trip</body></html>';
  app.get('/og-image.jpg', (req, res) => {
    res.set('Cache-Control', 'public, max-age=86400');
    res.sendFile(path.join(__dirname, 'public', 'og-image.jpg'));
  });
  app.use((req, res, next) => {
    const p = req.path || '';
    if (req.method === 'GET'
      && !p.startsWith('/api') && !p.startsWith('/auth') && !p.startsWith('/uploads')
      && PREVIEW_BOTS.test(req.get('user-agent') || '')) {
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

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="dark"/>
<link rel="icon" href="data:,">
<title>Trip Album · CRCMZ</title>
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
@media(max-width:360px){.grid{grid-template-columns:1fr}}
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
.wrap{padding-bottom:calc(72px + env(safe-area-inset-bottom,0px))}
.tabbar{position:fixed;bottom:0;left:0;right:0;z-index:100;display:flex;background:rgba(10,11,18,.92);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border-top:1px solid rgba(255,255,255,.08);padding-bottom:env(safe-area-inset-bottom,0px)}
.tabbar a.tab{flex:1;background:none;border:0;color:rgba(233,236,255,.6);display:flex;flex-direction:column;align-items:center;gap:4px;padding:7px 0 4px;font-family:"IBM Plex Mono",monospace;font-size:10px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;-webkit-tap-highlight-color:transparent;text-decoration:none}
.tabbar a.tab.on{color:var(--amber2)}
.tabbar a.tab svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
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
    <div class="label">CRCMZ Trip 2.0 · Photos</div>
    <h1>TX/CA — YYC 2.0</h1>
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
  let wxCache = { data: null, at: 0 };
  app.get('/api/weather', requireAuth, async (req, res) => {
    const now = Date.now();
    if (wxCache.data && now - wxCache.at < 30 * 60 * 1000) return res.json(wxCache.data);
    try {
      const url = 'https://api.open-meteo.com/v1/forecast'
        + '?latitude=51.0447&longitude=-114.0719'
        + '&daily=weathercode,temperature_2m_max,temperature_2m_min'
        + '&temperature_unit=celsius&timezone=America%2FEdmonton'
        + '&start_date=2026-10-29&end_date=2026-11-01';
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Open-Meteo ${r.status}`);
      const j = await r.json();
      const d = j.daily || {};
      const days = (d.time || []).map((date, i) => ({
        date,
        code: (d.weathercode || [])[i] ?? 0,
        high: (d.temperature_2m_max || [])[i] ?? null,
        low: (d.temperature_2m_min || [])[i] ?? null,
      }));
      wxCache = { data: { days }, at: now };
      res.json({ days });
    } catch (e) {
      console.error('[crcmz-trip] weather fetch failed:', e.message);
      if (wxCache.data) return res.json(wxCache.data);
      res.status(503).json({ error: 'Weather unavailable.' });
    }
  });

  // ---------- Packing list ----------
  const PACK_PATH = path.join(__dirname, 'data', 'packing.json');
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
    const text = ((req.body && req.body.text) || '').trim();
    if (!text || text.length > 120) return res.status(400).json({ error: 'Invalid item.' });
    const list = readPacking();
    const item = { id: crypto.randomUUID(), text, addedBy: displayName(req.session.user), addedAt: new Date().toISOString(), checkedBy: null };
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

  // ---------- Group poll (one active poll at a time, admin creates/closes) ----------
  const POLL_PATH = path.join(__dirname, 'data', 'poll.json');
  function readPoll() {
    try { return JSON.parse(fs.readFileSync(POLL_PATH, 'utf8')) || null; } catch { return null; }
  }
  function writePoll(p) {
    const tmp = `${POLL_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2));
    fs.renameSync(tmp, POLL_PATH);
  }
  app.get('/api/poll', requireAuth, (req, res) => res.json({ poll: readPoll() }));
  app.post('/api/poll', requireAuth, (req, res) => {
    if (!isAdminUser(req.session.user)) return res.status(403).json({ error: 'Admins only.' });
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
    const poll = { id: crypto.randomUUID(), question: question.trim(), options: opts, open: true, createdAt: new Date().toISOString(), createdBy: displayName(req.session.user) };
    writePoll(poll);
    res.status(201).json({ ok: true, poll });
  });
  app.post('/api/poll/vote', requireAuth, (req, res) => {
    const { optionId } = req.body || {};
    const poll = readPoll();
    if (!poll || !poll.open) return res.status(404).json({ error: 'No active poll.' });
    const opt = poll.options.find((o) => o.id === optionId);
    if (!opt) return res.status(400).json({ error: 'Invalid option.' });
    const voter = matchPerson(req.session.user) || displayName(req.session.user);
    poll.options.forEach((o) => { o.voters = o.voters.filter((v) => v !== voter); });
    opt.voters.push(voter);
    writePoll(poll);
    res.json({ ok: true, poll });
  });
  app.delete('/api/poll', requireAuth, (req, res) => {
    if (!isAdminUser(req.session.user)) return res.status(403).json({ error: 'Admins only.' });
    const poll = readPoll();
    if (!poll) return res.status(404).json({ error: 'No poll.' });
    poll.open = false;
    writePoll(poll);
    res.json({ ok: true });
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
    res.type('html').send(renderPage(req.session.user));
  });
  app.use(requireAuth, express.static(path.join(__dirname, 'public'), { index: false }));

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
