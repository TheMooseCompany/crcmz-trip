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
    const { FormData, File } = await import('undici');
    const fileData = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('assetData', new File([fileData], originalName));
    form.append('deviceId', 'crcmz-trip');
    form.append('deviceAssetId', `trip-${path.basename(filePath)}`);
    form.append('fileCreatedAt', mtime || new Date().toISOString());
    form.append('fileModifiedAt', mtime || new Date().toISOString());
    form.append('isFavorite', 'false');
    const { fetch } = await import('undici');
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
      .filter((m) => !m.hidden)
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
      if (IMMICH_URL && IMMICH_API_KEY) {
        Promise.all(files.map((f) => uploadToImmich(
          path.join(UPLOADS_DIR, f.filename), f.originalname, now,
        ))).catch(() => {});
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
  const PERSON_ALIASES = [
    ['Mutasif', ['mutasif', 'moose', 'themoosecompany']],
    ['Moiz', ['moiz', 'soup', 'interestingsoup']],
    ['Noor', ['noor']],
    ['Samad', ['samad', 'asamad']],
    ['Brendan', ['brendan']],
    ['Zubi', ['zubi']],
  ];
  function matchPerson(user) {
    if (!user) return null;
    const hay = [user.name, user.preferred_username, user.email]
      .filter(Boolean).join(' ').toLowerCase();
    for (const [person, aliases] of PERSON_ALIASES) {
      if (aliases.some((a) => hay.includes(a))) return person;
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

  // ---------- Album ----------
  // Redirect /album to the Immich shared album (IMMICH_SHARE_URL env var).
  // Auth-gated so the share URL stays off public crawlers.
  app.get('/album', requireAuth, (req, res) => {
    if (IMMICH_SHARE_URL) return res.redirect(IMMICH_SHARE_URL);
    res.type('text/plain').send('No album configured (set IMMICH_SHARE_URL).');
  });

  app.use(requireAuth, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

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
