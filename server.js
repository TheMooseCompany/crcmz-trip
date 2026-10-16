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

  app.get('/auth/login', (req, res) => {
    if (req.query.returnTo && typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/')) {
      req.session.returnTo = req.query.returnTo;
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
      .filter((m) => !m.hidden && !m.immichId && fs.existsSync(path.join(UPLOADS_DIR, m.name)))
      .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
      .map((m) => ({
        name: m.name,
        originalName: m.originalName,
        url: `/uploads/${encodeURIComponent(m.name)}`,
        uploadedBy: m.uploadedBy,
        uploadedAt: m.uploadedAt,
        size: m.size,
        kind: IMAGE_EXT.has(path.extname(m.name).toLowerCase()) ? 'image' : 'video',
      }));
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
    <div class="label">CRCMZ Trip 2.0 · Album</div>
    <h1>TX/CA — YYC 2.0</h1>
    <div class="hdr-meta">${count} item${count !== 1 ? 's' : ''}${IMMICH_SHARE_URL ? ' &nbsp;·&nbsp; <a href="' + IMMICH_SHARE_URL + '" target="_blank" rel="noopener" class="share-link">Open in Immich ↗</a>' : ''}</div>
  </div>
  <a class="back" href="/?tab=photos">← Back</a>
</div></div></header>

<div class="wrap">
${count === 0
  ? '<p class="empty">No photos yet — upload some from the Photo Wall.</p>'
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
</body>
</html>`);
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
