'use strict';
/*
 * Moments: the trip's own feed. Anyone signed in posts what happened (text, photos or
 * both); the feed shows everyone's, newest first, with likes. Every photo is stored
 * exactly like a Photo Wall upload (same index, same background upload to the Immich
 * album), so it's in the gallery too.
 *
 * When the trip's last day is over, the server cuts a vertical reel out of all the
 * moments (an intro card, each moment's photos with who posted it and what they said,
 * an outro), saves it beside the data and adds it to the Immich album. An admin can
 * also make it (or make it again) from the Moments tab.
 *
 * Data: <data>/moments.json (posts), <data>/reel/ (the reel and its status).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_TEXT = 1000;
const MAX_PHOTOS = 10;
const SLIDE_S = 2.6;
const MAX_SLIDES = 45;
const PER_MOMENT = 3;
const W = 1080;
const H = 1920;

module.exports = function mountMoments(app, d) {
  const {
    requireAuth, readIndex, writeIndex, uploadToImmich, photoUpload, UPLOADS_DIR, IMAGE_EXT, DATA_DIR,
    displayName, matchPerson, isAdminUser, IMMICH_URL, IMMICH_API_KEY, sharpLib, tripContent,
  } = d;
  const FILE = path.join(DATA_DIR, 'moments.json');
  const REEL_DIR = path.join(DATA_DIR, 'reel');
  const REEL_FILE = path.join(REEL_DIR, 'reel.mp4');
  const REEL_STATE = path.join(REEL_DIR, 'state.json');

  function read() {
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (j && Array.isArray(j.moments)) return j;
    } catch { /* none yet */ }
    return { moments: [] };
  }
  function write(data) {
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
  }
  function reelState() {
    try { return JSON.parse(fs.readFileSync(REEL_STATE, 'utf8')); } catch { return { status: 'none' }; }
  }
  function setReel(s) {
    fs.mkdirSync(REEL_DIR, { recursive: true });
    fs.writeFileSync(REEL_STATE, JSON.stringify(s, null, 2));
  }
  // A build that was running when the server stopped never finishes.
  if (reelState().status === 'building') setReel({ ...reelState(), status: 'failed', error: 'The server restarted mid-build. Make it again.' });

  const who = (req) => matchPerson(req.session.user) || displayName(req.session.user);
  const isImage = (name) => IMAGE_EXT.has(path.extname(name).toLowerCase());

  function view(m, me) {
    return {
      id: m.id, by: m.by, text: m.text, at: m.at,
      photos: m.photos.map((n) => ({
        name: n, kind: isImage(n) ? 'image' : 'video',
        thumb: `/moments/photo/${encodeURIComponent(n)}`, url: `/moments/photo/${encodeURIComponent(n)}?full=1`,
      })),
      likes: m.likes.length, liked: m.likes.includes(me), mine: m.by === me,
    };
  }

  app.get('/api/moments', requireAuth, (req, res) => {
    const me = who(req);
    const all = read().moments.slice().sort((a, b) => (a.at < b.at ? 1 : -1));
    const r = reelState();
    res.json({
      moments: all.map((m) => view(m, me)),
      reel: { ...r, url: r.status === 'ready' && fs.existsSync(REEL_FILE) ? `/moments/reel.mp4?v=${encodeURIComponent(r.builtAt || '')}` : null },
      reelAt: reelDue().toISOString(),
      canReel: isAdminUser(req.session.user),
      me,
    });
  });

  app.post('/api/moments', requireAuth, (req, res) => {
    photoUpload.array('photos', MAX_PHOTOS)(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is too big.' : (err.message || 'Upload failed.') });
      }
      const files = req.files || [];
      const text = String((req.body && req.body.text) || '').trim().slice(0, MAX_TEXT);
      if (!text && !files.length) return res.status(400).json({ error: 'Say what happened, or add a photo.' });
      const by = who(req);
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      // Into the Photo Wall's index (not hidden): the photos are the gallery's too.
      const index = readIndex();
      for (const f of files) {
        index[f.filename] = { name: f.filename, originalName: f.originalname, uploadedBy: displayName(req.session.user),
          uploadedAt: now, size: f.size, moment: id };
      }
      writeIndex(index);
      const data = read();
      const m = { id, by, text, at: now, photos: files.map((f) => f.filename), likes: [] };
      data.moments.push(m);
      write(data);
      // To the Immich album in the background, as the Photo Wall does; then the local
      // copy goes (Immich is the source of truth) and the photo is served from there.
      if (IMMICH_URL && IMMICH_API_KEY) {
        Promise.all(files.map((f) => {
          const local = path.join(UPLOADS_DIR, f.filename);
          return uploadToImmich(local, f.originalname, now).then((assetId) => {
            if (!assetId) return;
            const idx = readIndex();
            if (idx[f.filename]) { idx[f.filename].immichId = assetId; writeIndex(idx); }
            fs.unlink(local, () => {});
          });
        })).catch(() => {});
      }
      res.status(201).json({ ok: true, moment: view(m, by) });
    });
  });

  app.post('/api/moments/:id/like', requireAuth, (req, res) => {
    const me = who(req);
    const data = read();
    const m = data.moments.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'That moment is gone.' });
    m.likes = m.likes.includes(me) ? m.likes.filter((x) => x !== me) : [...m.likes, me];
    write(data);
    res.json({ ok: true, likes: m.likes.length, liked: m.likes.includes(me) });
  });

  // The post goes; its photos stay in the gallery (they're the album's now).
  app.delete('/api/moments/:id', requireAuth, (req, res) => {
    const data = read();
    const m = data.moments.find((x) => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: 'That moment is gone.' });
    if (m.by !== who(req) && !isAdminUser(req.session.user)) return res.status(403).json({ error: 'Only whoever posted it can delete it.' });
    data.moments = data.moments.filter((x) => x.id !== m.id);
    write(data);
    res.json({ ok: true });
  });

  // A moment's photo: the local copy while it's still here, else from Immich by the id it
  // was stored under. Only photos that belong to a moment (no other Immich asset).
  async function photoBuffer(name, full) {
    const meta = readIndex()[name];
    if (!meta || !meta.moment) return null;
    const local = path.join(UPLOADS_DIR, name);
    if (fs.existsSync(local)) return { file: local };
    if (!meta.immichId || !IMMICH_URL || !IMMICH_API_KEY) return null;
    const r = await fetch(`${IMMICH_URL}/api/assets/${meta.immichId}/${full ? 'original' : 'thumbnail?size=preview'}`,
      { headers: { 'x-api-key': IMMICH_API_KEY } });
    if (!r.ok) return null;
    return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
  }

  app.get('/moments/photo/:name', requireAuth, async (req, res) => {
    const name = path.basename(req.params.name);
    try {
      const got = await photoBuffer(name, req.query.full === '1');
      if (!got) return res.status(404).end();
      res.set('Cache-Control', 'private, max-age=604800');
      if (got.file) {
        if (req.query.full === '1' || !sharpLib || !isImage(name)) return res.sendFile(got.file);
        const buf = await sharpLib(got.file).rotate().resize(900, 900, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
        return res.type('image/jpeg').send(buf);
      }
      res.type(got.type).send(got.buf);
    } catch { res.status(500).end(); }
  });

  app.get('/moments/reel.mp4', requireAuth, (req, res) => {
    if (!fs.existsSync(REEL_FILE)) return res.status(404).end();
    res.set('Cache-Control', 'private, max-age=3600');
    res.sendFile(REEL_FILE);
  });

  app.post('/api/moments/reel', requireAuth, (req, res) => {
    if (!isAdminUser(req.session.user)) return res.status(403).json({ error: 'Only an admin can make the reel.' });
    if (reelState().status === 'building') return res.status(409).json({ error: 'The reel is already being made.' });
    if (!slidesFrom(read().moments).length) return res.status(400).json({ error: 'No photos in any moment yet.' });
    buildReel(who(req)).catch(() => {});
    res.status(202).json({ ok: true });
  });

  // ---------- the reel ----------

  // The trip is over at the end of its last day, Calgary time (midnight MST: 07:00 UTC).
  function reelDue() {
    const c = tripContent() || {};
    const days = (Array.isArray(c.days) ? c.days : []).map((x) => x && x.dateISO).filter(Boolean).sort();
    const last = days[days.length - 1] || '2026-11-01';
    const t = new Date(`${last}T07:00:00Z`);
    t.setUTCDate(t.getUTCDate() + 1);
    return t;
  }

  function slidesFrom(moments) {
    const out = [];
    for (const m of moments.slice().sort((a, b) => (a.at < b.at ? -1 : 1))) {
      for (const n of m.photos.filter(isImage).slice(0, PER_MOMENT)) out.push({ name: n, by: m.by, text: m.text, at: m.at });
    }
    if (out.length <= MAX_SLIDES) return out;
    // Too many: an even spread across the whole trip.
    return Array.from({ length: MAX_SLIDES }, (_, i) => out[Math.floor((i * out.length) / MAX_SLIDES)]);
  }

  const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
  // The reel's font has no emoji: drop them rather than draw boxes.
  const plain = (s) => String(s || '').replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
  function wrap(s, max, lines) {
    const words = plain(s).split(' ').filter(Boolean);
    const out = [];
    let cur = '';
    for (const w of words) {
      if ((cur + ' ' + w).trim().length > max) { if (cur) out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
      if (out.length === lines) break;
    }
    if (cur && out.length < lines) out.push(cur);
    if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = out[lines - 1].replace(/.{0,2}$/, '…');
    return out;
  }
  const dayLabel = (iso) => new Date(iso).toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Edmonton' });

  function caption(s) {
    const lines = wrap(s.text, 34, 3);
    const top = H - 150 - lines.length * 62;
    return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".8"/></linearGradient></defs>
      <rect x="0" y="${top - 160}" width="${W}" height="${H - top + 160}" fill="url(#g)"/>
      <text x="72" y="${top - 30}" font-family="DejaVu Sans" font-weight="bold" font-size="46" fill="#C9A2FF">${xml(plain(s.by))} · ${xml(dayLabel(s.at))}</text>
      ${lines.map((l, i) => `<text x="72" y="${top + 40 + i * 62}" font-family="DejaVu Sans" font-size="50" fill="#fff">${xml(l)}</text>`).join('')}
    </svg>`);
  }

  async function slideImage(s, out) {
    const got = await photoBuffer(s.name, false);
    if (!got) return false;
    const src = got.file ? fs.readFileSync(got.file) : got.buf;
    const bg = await sharpLib(src).rotate().resize(W, H, { fit: 'cover' }).blur(40).modulate({ brightness: 0.55 }).toBuffer();
    const fg = await sharpLib(src).rotate().resize(W - 80, H - 520, { fit: 'inside' }).toBuffer();
    const meta = await sharpLib(fg).metadata();
    await sharpLib(bg).composite([
      { input: fg, left: Math.round((W - meta.width) / 2), top: Math.max(120, Math.round((H - 380 - meta.height) / 2)) },
      ...(plain(s.text) || s.by ? [{ input: caption(s), left: 0, top: 0 }] : []),
    ]).jpeg({ quality: 88 }).toFile(out);
    return true;
  }

  async function card(out, big, small, tiny) {
    const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1a1240"/><stop offset="1" stop-color="#05030f"/></linearGradient></defs>
      <rect width="${W}" height="${H}" fill="url(#b)"/>
      <text x="${W / 2}" y="${H / 2 - 40}" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="104" fill="#fff">${xml(big)}</text>
      <text x="${W / 2}" y="${H / 2 + 60}" text-anchor="middle" font-family="DejaVu Sans" font-size="50" fill="#C9A2FF">${xml(small)}</text>
      <text x="${W / 2}" y="${H / 2 + 140}" text-anchor="middle" font-family="DejaVu Sans" font-size="38" fill="#AFA4CC">${xml(tiny)}</text>
    </svg>`;
    await sharpLib(Buffer.from(svg)).jpeg({ quality: 90 }).toFile(out);
  }

  function ffmpeg(args) {
    return new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
      let err = '';
      p.stderr.on('data', (b) => { err += b; });
      p.on('error', reject);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.slice(-400) || `ffmpeg exited ${code}`))));
    });
  }

  // One slide: a slow push in, a quick fade at each end.
  function clip(img, out, seconds) {
    const frames = Math.round(seconds * 30);
    return ffmpeg(['-loop', '1', '-i', img, '-t', String(seconds), '-vf',
      `scale=${W * 2}:${H * 2},zoompan=z='min(zoom+0.0005,1.05)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=30,`
      + `fade=t=in:st=0:d=0.3,fade=t=out:st=${(seconds - 0.3).toFixed(2)}:d=0.3,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-r', '30', out]);
  }

  let building = false;
  async function buildReel(by) {
    if (building) return;
    building = true;
    const moments = read().moments;
    const slides = slidesFrom(moments);
    const work = path.join(REEL_DIR, `work-${Date.now()}`);
    // Once the end-of-trip build has run (made it or not), it never runs by itself again.
    const auto = by === 'auto' || !!reelState().auto;
    setReel({ status: 'building', startedAt: new Date().toISOString(), by, slides: slides.length, done: 0, auto });
    try {
      if (!sharpLib) throw new Error('Image tools are missing on the server.');
      fs.mkdirSync(work, { recursive: true });
      const c = tripContent() || {};
      const dates = String((c.trip && c.trip.heroDates) || 'Calgary').replace(/\s*\|\s*/g, ' · ');
      const clips = [];
      await card(path.join(work, 'intro.jpg'), 'CRCMZ BOYZ', dates, `${moments.length} moments`);
      await clip(path.join(work, 'intro.jpg'), path.join(work, 'c000.mp4'), 3);
      clips.push('c000.mp4');
      let i = 0;
      for (const s of slides) {
        i += 1;
        const img = path.join(work, `s${String(i).padStart(3, '0')}.jpg`);
        try {
          if (!(await slideImage(s, img))) continue;
        } catch (e) { console.error('[moments] slide skipped:', e.message); continue; }
        const name = `c${String(i).padStart(3, '0')}.mp4`;
        await clip(img, path.join(work, name), SLIDE_S);
        clips.push(name);
        setReel({ ...reelState(), done: i });
      }
      if (clips.length < 2) throw new Error("None of the moments' photos could be read.");
      await card(path.join(work, 'outro.jpg'), 'Until next trip.', 'CRCMZ BOYZ', 'trip.crcmz.me');
      await clip(path.join(work, 'outro.jpg'), path.join(work, 'c999.mp4'), 3);
      clips.push('c999.mp4');
      fs.writeFileSync(path.join(work, 'list.txt'), clips.map((n) => `file '${n}'`).join('\n'));
      const tmp = path.join(work, 'reel.mp4');
      await ffmpeg(['-f', 'concat', '-safe', '0', '-i', path.join(work, 'list.txt'), '-c', 'copy', '-movflags', '+faststart', tmp]);
      fs.renameSync(tmp, REEL_FILE);
      const builtAt = new Date().toISOString();
      setReel({ status: 'ready', builtAt, by, slides: clips.length - 2, moments: moments.length,
        seconds: Math.round(6 + (clips.length - 2) * SLIDE_S), auto });
      // Into the shared album too, beside the photos it's made of.
      if (IMMICH_URL && IMMICH_API_KEY) {
        const copy = path.join(UPLOADS_DIR, `reel-${builtAt.replace(/[:.]/g, '-')}.mp4`);
        fs.copyFileSync(REEL_FILE, copy);
        uploadToImmich(copy, 'CRCMZ Trip Reel.mp4', builtAt).then((id) => {
          if (id) { fs.unlink(copy, () => {}); setReel({ ...reelState(), immichId: id }); }
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[moments] reel failed:', e.message);
      setReel({ status: 'failed', error: e.message, at: new Date().toISOString(), by, auto });
    } finally {
      building = false;
      fs.rm(work, { recursive: true, force: true }, () => {});
    }
  }

  // At the end of the trip, once: the reel makes itself.
  setInterval(() => {
    const r = reelState();
    if (building || r.status === 'ready' || r.status === 'building' || r.auto) return;
    if (Date.now() < reelDue().getTime() || !slidesFrom(read().moments).length) return;
    buildReel('auto').catch(() => {});
  }, 10 * 60 * 1000).unref();

  return { buildReel, reelState, slidesFrom, reelDue };
};
