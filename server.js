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
const ACTIVE_ALBUM_PATH = path.join(DATA_DIR, 'active-album.json');
const MAX_FILE_MB = parseInt(process.env.MAX_FILE_MB || '50', 10);
const ADMIN_SUB = process.env.ADMIN_SUB || '';
const ALLOWED_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif',
  '.mp4', '.mov', '.webm', '.m4v',
]);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.avif']);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function readActiveAlbum() {
  try {
    const a = JSON.parse(fs.readFileSync(ACTIVE_ALBUM_PATH, 'utf8'));
    return a && a.id ? a : null;
  } catch { return null; }
}
function writeActiveAlbum(album) {
  fs.writeFileSync(ACTIVE_ALBUM_PATH, JSON.stringify(album, null, 2));
}
function isAdmin(req) {
  if (!req.session.user) return false;
  if (ADMIN_SUB && req.session.user.sub === ADMIN_SUB) return true;
  return false;
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
      const activeAlbum = readActiveAlbum();
      const added = files.map((f) => {
        const meta = {
          name: f.filename,
          originalName: f.originalname,
          uploadedBy: by,
          uploadedAt: new Date().toISOString(),
          size: f.size,
        };
        if (activeAlbum) meta.albumId = activeAlbum.id;
        index[f.filename] = meta;
        return meta;
      });
      writeIndex(index);
      res.status(201).json({ ok: true, added: added.map((m) => m.name), albumId: activeAlbum ? activeAlbum.id : null });
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

  // ---------- Album API ----------
  app.get('/api/albums/active', requireAuth, (req, res) => {
    res.json({ album: readActiveAlbum() });
  });

  app.post('/api/albums', requireAuth, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only.' });
    const { id, name } = req.body || {};
    if (!id || typeof id !== 'string' || !/^[a-z0-9-]+$/.test(id)) {
      return res.status(400).json({ error: 'id must be lowercase letters, numbers, hyphens.' });
    }
    const album = { id, name: name || id, createdAt: new Date().toISOString() };
    writeActiveAlbum(album);
    res.status(201).json({ album });
  });

  app.delete('/api/albums/active', requireAuth, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only.' });
    try { fs.unlinkSync(ACTIVE_ALBUM_PATH); } catch {}
    res.json({ ok: true });
  });

  app.get('/api/albums/:id/photos', requireAuth, (req, res) => {
    const albumId = req.params.id;
    const index = readIndex();
    const items = Object.values(index)
      .filter((m) => m.albumId === albumId)
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
    res.json({ albumId, photos: items, total: items.length });
  });

  // ---------- Album view page ----------
  app.get('/album/:id', requireAuth, (req, res) => {
    const albumId = req.params.id;
    const index = readIndex();
    const photos = Object.values(index)
      .filter((m) => m.albumId === albumId)
      .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
    const count = photos.length;

    // Try to read album name from active album file
    const active = readActiveAlbum();
    const albumName = (active && active.id === albumId) ? (active.name || albumId) : albumId;

    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
<meta name="color-scheme" content="dark"/>
<link rel="icon" href="data:,">
<title>${albumName} · CRCMZ Trip</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--sky:#0A0E27;--deep:#060818;--panel:#10163A;--line:rgba(245,239,224,.12);--line-amber:rgba(242,179,61,.45);--amber:#F2B33D;--amber2:#FFC65C;--acid:#8CFF2B;--cream:#F5EFE0;--muted:#A9A5C6;--muted2:#8E89B8}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--sky);color:var(--cream);font-family:"Space Grotesk",system-ui,sans-serif;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.mono{font-family:"IBM Plex Mono",monospace}
.label{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.28em;text-transform:uppercase;color:var(--amber);font-weight:600}
.wrap{max-width:900px;margin:0 auto;padding:0 18px}
header{padding:28px 0 22px;border-bottom:1px solid var(--line)}
.header-inner{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}
.back{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);border:1px solid var(--line);border-radius:99px;padding:7px 14px;transition:border-color .2s,color .2s}
.back:hover{color:var(--amber2);border-color:var(--line-amber)}
.album-title{font-size:clamp(24px,4vw,38px);font-weight:700;letter-spacing:-.02em;margin:6px 0 4px}
.album-meta{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.14em;color:var(--muted)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;padding:24px 0 60px}
@media(max-width:640px){.grid{grid-template-columns:repeat(2,1fr);gap:7px}}
@media(max-width:380px){.grid{grid-template-columns:1fr}}
.tile{position:relative;border-radius:12px;overflow:hidden;border:1px solid var(--line);background:rgba(255,255,255,.04);aspect-ratio:1;cursor:pointer;transition:transform .2s,border-color .2s}
.tile:hover{transform:scale(1.02);border-color:var(--line-amber)}
.tile img,.tile video{width:100%;height:100%;object-fit:cover;display:block}
.tile .meta{position:absolute;left:0;right:0;bottom:0;padding:22px 8px 7px;font-size:11px;color:#fff;background:linear-gradient(transparent,rgba(4,5,16,.88));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1.4}
.tile .meta .by{font-weight:600;color:var(--amber2)}
.tile .play-badge{position:absolute;top:7px;right:7px;background:rgba(4,5,16,.78);color:#fff;font-family:"IBM Plex Mono",monospace;font-size:9.5px;letter-spacing:.1em;padding:3px 8px;border-radius:99px}
.empty{padding:60px 0;text-align:center;color:var(--muted);font-size:16px}
/* Lightbox */
#lb{display:none;position:fixed;inset:0;z-index:200;background:rgba(4,5,16,.96);align-items:center;justify-content:center;flex-direction:column;gap:12px}
#lb.on{display:flex}
#lb img,#lb video{max-width:92vw;max-height:82vh;border-radius:10px;object-fit:contain}
#lb .lb-meta{font-size:13px;color:var(--muted);font-family:"IBM Plex Mono",monospace;letter-spacing:.06em}
#lb .lb-close{position:fixed;top:18px;right:22px;background:rgba(4,5,16,.8);border:1px solid var(--line);color:var(--cream);font-size:18px;border-radius:99px;width:40px;height:40px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:border-color .2s}
#lb .lb-close:hover{border-color:var(--line-amber);color:var(--amber2)}
#lb .lb-nav{position:fixed;top:50%;transform:translateY(-50%);background:rgba(4,5,16,.75);border:1px solid var(--line);color:var(--cream);font-size:22px;border-radius:99px;width:48px;height:48px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:border-color .2s}
#lb .lb-prev{left:12px}
#lb .lb-next{right:12px}
#lb .lb-nav:hover{border-color:var(--line-amber);color:var(--amber2)}
</style>
</head>
<body>
<header><div class="wrap"><div class="header-inner">
  <div>
    <div class="label">CRCMZ Trip 2.0 · Album</div>
    <div class="album-title">${albumName.replace(/</g,'&lt;')}</div>
    <div class="album-meta">${count} item${count !== 1 ? 's' : ''}</div>
  </div>
  <a class="back" href="/?tab=photos">← Back to hub</a>
</div></div></header>

<div class="wrap">
${count === 0
  ? '<div class="empty">No photos yet — be the first to add one.</div>'
  : `<div class="grid" id="grid">${photos.map((m, i) => {
      const kind = IMAGE_EXT.has(path.extname(m.name).toLowerCase()) ? 'image' : 'video';
      const url = `/uploads/${encodeURIComponent(m.name)}`;
      const dt = new Date(m.uploadedAt);
      const timeStr = dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      if (kind === 'image') {
        return `<div class="tile" data-index="${i}" onclick="openLb(${i})"><img src="${url}" loading="lazy" alt="${m.originalName.replace(/"/g,'&quot;')}"><div class="meta"><span class="by">${m.uploadedBy.replace(/</g,'&lt;')}</span> · ${timeStr}</div></div>`;
      } else {
        return `<div class="tile" data-index="${i}" onclick="openLb(${i})"><video src="${url}" muted playsinline preload="metadata"></video><div class="play-badge">▶ Video</div><div class="meta"><span class="by">${m.uploadedBy.replace(/</g,'&lt;')}</span> · ${timeStr}</div></div>`;
      }
    }).join('')}</div>`
}
</div>

<div id="lb">
  <button class="lb-close" onclick="closeLb()" aria-label="Close">✕</button>
  <button class="lb-nav lb-prev" onclick="lbStep(-1)" aria-label="Previous">‹</button>
  <div id="lb-media"></div>
  <div class="lb-meta" id="lb-meta"></div>
  <button class="lb-nav lb-next" onclick="lbStep(1)" aria-label="Next">›</button>
</div>

<script>
var PHOTOS = ${JSON.stringify(photos.map(m => ({
  url: `/uploads/${encodeURIComponent(m.name)}`,
  by: m.uploadedBy,
  name: m.originalName,
  kind: IMAGE_EXT.has(path.extname(m.name).toLowerCase()) ? 'image' : 'video',
  at: new Date(m.uploadedAt).toLocaleDateString('en-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
}))
)};
var lbIdx = 0;
function openLb(i) {
  lbIdx = i; renderLb(); document.getElementById('lb').classList.add('on');
  document.body.style.overflow = 'hidden';
}
function closeLb() {
  document.getElementById('lb').classList.remove('on');
  document.body.style.overflow = '';
  document.getElementById('lb-media').innerHTML = '';
}
function lbStep(d) {
  lbIdx = (lbIdx + d + PHOTOS.length) % PHOTOS.length; renderLb();
}
function renderLb() {
  var p = PHOTOS[lbIdx], m = document.getElementById('lb-media');
  if (p.kind === 'image') {
    m.innerHTML = '<img src="' + p.url + '" alt="' + p.name.replace(/"/g,'&quot;') + '">';
  } else {
    m.innerHTML = '<video src="' + p.url + '" controls autoplay muted playsinline style="max-width:92vw;max-height:82vh;border-radius:10px"></video>';
  }
  document.getElementById('lb-meta').textContent = p.by + ' · ' + p.at + ' · ' + (lbIdx+1) + ' / ' + PHOTOS.length;
}
document.getElementById('lb').addEventListener('click', function(e) {
  if (e.target === this) closeLb();
});
document.addEventListener('keydown', function(e) {
  if (!document.getElementById('lb').classList.contains('on')) return;
  if (e.key === 'Escape') closeLb();
  if (e.key === 'ArrowLeft') lbStep(-1);
  if (e.key === 'ArrowRight') lbStep(1);
});
</script>
</body>
</html>`);
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
