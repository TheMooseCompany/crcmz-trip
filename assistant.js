'use strict';
/*
 * Trip AI: a chat assistant for trip.crcmz.me on the local model (same oMLX
 * setup as Buds), with tools for every part of the site and the CRCMZ MCP
 * read tools.
 *
 * Reads run straight away. Anything that changes data only PROPOSES: the
 * assistant returns a proposal the user must Apply. Applying replays the
 * exact site API calls as the signed-in user (an internal request carrying
 * their session cookie), so the assistant can never do more than that person
 * could do by tapping through the UI, and every rule (admin-only content,
 * expense validation) is enforced in one place.
 */
const crypto = require('crypto');

const AI_BASE = () => (process.env.AI_BASE_URL || 'http://192.168.4.38:1234/v1').replace(/\/$/, '');
const AI_MODEL = () => process.env.AI_MODEL || 'Qwen3.6-35B-A3B-Uncensored-Heretic-MLX-8bit';
const MCP_URL = process.env.CRCMZ_MCP_URL || 'https://app.crcmz.me/mcp';
const MCP_TOKEN = () => process.env.TRIP_MCP_TOKEN || '';
// Read-only CRCMZ tools worth having on a trip; the service token has no write scope anyway.
const MCP_PICK = ['person_profile', 'squad_facts', 'memory_search', 'tournament_list', 'tournament_bracket',
  'tourney_leaderboard', 'tourney_player_stats', 'recent_clips', 'psn_squad_status', 'whatsapp_search', 'web_search'];
const MAX_STEPS = 6;
const PROPOSAL_TTL = 15 * 60 * 1000;
const CONTENT_SECTIONS = ['trip', 'days', 'stay', 'foodCats', 'food', 'buds', 'splitPeople'];
const PACK_CATS = ['clothes', 'electronics', 'documents', 'buds', 'misc'];

module.exports = function mountAssistant(app, ctx) {
  const { requireAuth, isAdminUser, matchPerson, displayName, activePeople, port, readContent, defaultContent } = ctx;
  const proposals = new Map();
  const inflight = new Set();
  const rate = new Map();

  // ---------- helpers ----------
  const userKey = (req) => (req.session.user && (req.session.user.sub || req.session.user.email)) || 'anon';
  function content() { return readContent() || defaultContent() || {}; }
  async function internal(req, method, p, body) {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { cookie: req.headers.cookie || '', 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    return { ok: r.ok, status: r.status, data };
  }
  const money = (c) => `$${(c / 100).toFixed(2)}`;
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function person(name) {
    const ppl = activePeople();
    const n = norm(name);
    if (!n) return null;
    const hit = ppl.find((p) => norm(p) === n) || ppl.find((p) => norm(p).startsWith(n) || n.startsWith(norm(p)));
    if (hit) return hit;
    const alias = matchPerson({ name });
    return alias && ppl.includes(alias) ? alias : null;
  }
  function calgaryNow() {
    return new Date().toLocaleString('en-CA', { timeZone: 'America/Edmonton', weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function balances(ledger) {
    const ppl = activePeople();
    const net = Object.fromEntries(ppl.map((p) => [p, 0]));
    for (const e of ledger.expenses || []) {
      if (net[e.payer] !== undefined) net[e.payer] += e.amountCentsCAD;
      for (const [p, c] of Object.entries(e.shares || {})) if (net[p] !== undefined) net[p] -= c;
    }
    for (const s of ledger.settlements || []) {
      if (net[s.from] !== undefined) net[s.from] += s.amountCentsCAD;
      if (net[s.to] !== undefined) net[s.to] -= s.amountCentsCAD;
    }
    const debt = ppl.filter((p) => net[p] < 0).map((p) => [p, -net[p]]).sort((a, b) => b[1] - a[1]);
    const cred = ppl.filter((p) => net[p] > 0).map((p) => [p, net[p]]).sort((a, b) => b[1] - a[1]);
    const owes = [];
    let i = 0; let j = 0;
    while (i < debt.length && j < cred.length) {
      const amt = Math.min(debt[i][1], cred[j][1]);
      if (amt > 0) owes.push(`${debt[i][0]} owes ${cred[j][0]} ${money(amt)}`);
      debt[i][1] -= amt; cred[j][1] -= amt;
      if (debt[i][1] === 0) i++;
      if (cred[j][1] === 0) j++;
    }
    return { net: Object.fromEntries(Object.entries(net).map(([k, v]) => [k, money(v)])), settle_up: owes };
  }
  function splitEqual(total, names) {
    const base = Math.floor(total / names.length);
    let rem = total - base * names.length;
    const out = {};
    for (const n of names) { out[n] = base + (rem > 0 ? 1 : 0); rem -= rem > 0 ? 1 : 0; }
    return out;
  }
  // Content edit ops on a deep copy: path like "days.2.title" or "food.-" (append).
  function applyOps(base, ops) {
    const doc = JSON.parse(JSON.stringify(base));
    const labels = [];
    for (const op of ops) {
      const parts = String(op.path || '').split('.').filter(Boolean);
      if (!parts.length || !CONTENT_SECTIONS.includes(parts[0])) throw new Error(`Can't edit "${op.path}". Editable: ${CONTENT_SECTIONS.join(', ')}`);
      let cur = doc;
      for (let k = 0; k < parts.length - 1; k++) {
        const key = Array.isArray(cur) ? Number(parts[k]) : parts[k];
        if (cur[key] === undefined || cur[key] === null || typeof cur[key] !== 'object') throw new Error(`Path not found: ${op.path}`);
        cur = cur[key];
      }
      const last = parts[parts.length - 1];
      if (op.op === 'set') {
        if (Array.isArray(cur)) { const ix = Number(last); if (!(ix >= 0 && ix < cur.length)) throw new Error(`No item ${last} in ${parts.slice(0, -1).join('.')}`); cur[ix] = op.value; } else cur[last] = op.value;
        labels.push(`Set ${op.path}`);
      } else if (op.op === 'insert') {
        if (!Array.isArray(cur)) throw new Error(`${parts.slice(0, -1).join('.')} is not a list`);
        const ix = last === '-' ? cur.length : Number(last);
        if (!(ix >= 0 && ix <= cur.length)) throw new Error(`Bad position ${last}`);
        cur.splice(ix, 0, op.value);
        labels.push(`Add to ${parts.slice(0, -1).join('.')}`);
      } else if (op.op === 'remove') {
        if (Array.isArray(cur)) { const ix = Number(last); if (!(ix >= 0 && ix < cur.length)) throw new Error(`No item ${last}`); cur.splice(ix, 1); } else delete cur[last];
        labels.push(`Remove ${op.path}`);
      } else throw new Error(`Unknown op ${op.op}`);
    }
    for (const k of ['days', 'food', 'buds', 'splitPeople']) if (!Array.isArray(doc[k])) throw new Error(`${k} must stay a list`);
    return { doc, labels };
  }
  const hash = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');

  // ---------- MCP bridge (read-only) ----------
  let mcpCache = { at: 0, tools: [] };
  async function mcpRpc(method, params) {
    const r = await fetch(MCP_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${MCP_TOKEN()}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    const line = text.trim().startsWith('{') ? text : (text.split('\n').find((l) => l.startsWith('data:')) || '').slice(5);
    const j = JSON.parse(line || '{}');
    if (j.error) throw new Error(j.error.message || 'MCP error');
    return j.result;
  }
  async function mcpTools() {
    if (!MCP_TOKEN()) return [];
    if (Date.now() - mcpCache.at < 10 * 60 * 1000) return mcpCache.tools;
    try {
      const res = await mcpRpc('tools/list', {});
      const tools = (res.tools || []).filter((t) => MCP_PICK.includes(t.name)).map((t) => ({
        type: 'function',
        function: { name: `crcmz_${t.name}`, description: `[CRCMZ squad data] ${t.description || ''}`.slice(0, 900), parameters: t.inputSchema || { type: 'object', properties: {} } },
      }));
      mcpCache = { at: Date.now(), tools };
    } catch (e) {
      console.error('[crcmz-trip] assistant MCP tools/list failed:', e.message);
      mcpCache = { at: Date.now() - 9 * 60 * 1000, tools: mcpCache.tools };
    }
    return mcpCache.tools;
  }

  // ---------- tools ----------
  const fn = (name, description, properties = {}, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
  const LOCAL_TOOLS = [
    fn('get_overview', 'Trip basics: dates, the stay, the four days at a glance, who is on the Split, who is asking and whether they can edit site content. Call this first when unsure.'),
    fn('get_days', 'Full itinerary for one day or all days, with each day\'s index for edits.', { day: { type: 'string', description: 'Optional: Thu/Fri/Sat/Sun, a date like 2026-10-30, or an index 0-3.' } }),
    fn('search_food', 'Search the halal food guide (98 spots) by words in name, area or note, and/or category id.', { query: { type: 'string' }, category: { type: 'string', description: 'Category id, see foodCats in get_overview.' }, limit: { type: 'integer' } }),
    fn('search_buds', 'Search the cannabis menu (flower, pre-rolls, edibles) with THC/CBD %, price per gram, stock and rating.', { query: { type: 'string' }, type: { type: 'string', enum: ['flower', 'preroll', 'edible'] }, in_stock_only: { type: 'boolean' }, max_price: { type: 'number' }, limit: { type: 'integer' } }),
    fn('get_stay', 'The Airbnb: address area, check-in/out, beds, rules, amenities, price breakdown.'),
    fn('get_split', 'The shared expenses ledger: every expense (with id), settlements, each person\'s net balance and who owes whom.'),
    fn('get_packing', 'The shared packing list with item ids, category, who it\'s for and whether it\'s packed.'),
    fn('get_poll', 'The active group poll with vote counts, plus past polls.'),
    fn('get_flights', 'Everyone\'s flights with ids, times, status, gate.'),
    fn('get_weather', 'Calgary forecast for the trip days.'),
    fn('get_content_section', 'Raw JSON of a site content section, with indexes, before editing it. Sections: trip, days, stay, foodCats, food, buds, splitPeople.', { section: { type: 'string', enum: CONTENT_SECTIONS }, index: { type: 'integer', description: 'Optional item index for list sections.' } }, ['section']),
    fn('propose_expense', 'PROPOSE adding an expense to the Split (the user must confirm). Splits equally between split_between unless exact_shares is given.', {
      description: { type: 'string' }, amount: { type: 'number', description: 'Total in the given currency, e.g. 42.5' },
      currency: { type: 'string', enum: ['CAD', 'USD'] }, payer: { type: 'string', description: 'Who paid (a Split person).' },
      split_between: { type: 'array', items: { type: 'string' }, description: 'People sharing it. Omit for everyone.' },
      exact_shares: { type: 'object', description: 'Optional {person: amount} in the same currency; must add up to amount.' },
    }, ['description', 'amount', 'payer']),
    fn('propose_delete_expense', 'PROPOSE deleting an expense by id (from get_split).', { id: { type: 'string' } }, ['id']),
    fn('propose_settlement', 'PROPOSE recording that one person paid another back (CAD).', { from: { type: 'string' }, to: { type: 'string' }, amount: { type: 'number' } }, ['from', 'to', 'amount']),
    fn('propose_packing', 'PROPOSE packing list changes: add items, toggle packed, or delete items.', {
      add: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string', enum: PACK_CATS }, assigned_to: { type: 'string' } }, required: ['text'] } },
      toggle_ids: { type: 'array', items: { type: 'string' } }, delete_ids: { type: 'array', items: { type: 'string' } },
    }),
    fn('propose_poll', 'PROPOSE starting a new group poll (replaces the active one) or closing the active poll.', { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, close: { type: 'boolean' } }),
    fn('propose_vote', 'PROPOSE casting the user\'s vote in the active poll.', { option: { type: 'string', description: 'Option text (or id).' } }, ['option']),
    fn('propose_flight', 'PROPOSE adding a flight, or updating/deleting one by id (status, gate, terminal, notes).', {
      id: { type: 'string' }, delete: { type: 'boolean' }, person: { type: 'string' }, flightNumber: { type: 'string' }, airline: { type: 'string' },
      originCode: { type: 'string' }, destinationCode: { type: 'string' }, departureDate: { type: 'string', description: 'YYYY-MM-DD' },
      departureTime: { type: 'string' }, arrivalTime: { type: 'string' },
      status: { type: 'string', enum: ['scheduled', 'on-time', 'delayed', 'boarding', 'departed', 'landed', 'cancelled'] }, gate: { type: 'string' }, terminal: { type: 'string' }, notes: { type: 'string' },
    }),
    fn('propose_content_edit', 'PROPOSE edits to the site content (days, food guide, buds menu, stay details, trip text, Split people). Admins only (Mutasif, Moiz). Read the section with get_content_section first. Paths use dots and list indexes: "days.2.title", "days.1.bullets.0", "food.-" to append, "stay.checkIn".', {
      summary: { type: 'string', description: 'One line describing the change for the confirm card.' },
      ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['set', 'insert', 'remove'] }, path: { type: 'string' }, value: {} }, required: ['op', 'path'] } },
    }, ['summary', 'ops']),
  ];
  const STATUS = {
    get_overview: 'Reading the trip', get_days: 'Checking the itinerary', search_food: 'Searching the food guide', search_buds: 'Checking the buds menu',
    get_stay: 'Looking at the stay', get_split: 'Checking the Split', get_packing: 'Reading the packing list', get_poll: 'Checking the poll',
    get_flights: 'Checking flights', get_weather: 'Checking the forecast', get_content_section: 'Reading site content',
  };

  function makeProposal(req, p) {
    const id = crypto.randomUUID();
    proposals.set(id, { ...p, id, owner: userKey(req), at: Date.now() });
    for (const [k, v] of proposals) if (Date.now() - v.at > PROPOSAL_TTL) proposals.delete(k);
    return { proposal_id: id, summary: p.summary, items: p.items, note: 'Proposed. The user sees an Apply button; it is NOT done until they tap it.' };
  }

  async function runTool(req, name, args, send) {
    if (name.startsWith('crcmz_')) {
      send({ type: 'status', text: 'Checking CRCMZ data' });
      const res = await mcpRpc('tools/call', { name: name.slice(6), arguments: args || {} });
      const text = (res && res.content || []).map((c) => c.text || '').join('\n');
      return text.slice(0, 12000) || '(no result)';
    }
    if (STATUS[name]) send({ type: 'status', text: STATUS[name] });
    const c = content();
    switch (name) {
      case 'get_overview': {
        const me = req.session.user;
        return {
          now_in_calgary: calgaryNow(), trip: c.trip, you: { name: displayName(me), person: matchPerson(me), can_edit_site_content: isAdminUser(me) },
          split_people: activePeople(), days: (c.days || []).map((d, i) => ({ index: i, day: `${d.dow} ${d.dnum} ${d.dmon}`, chip: d.chip, title: d.title })),
          stay: c.stay && { intro: c.stay.intro, checkIn: c.stay.checkIn, checkOut: c.stay.checkOut, sleeps: c.stay.sleeps, url: c.stay.airbnbUrl },
          foodCats: c.foodCats, counts: { food: (c.food || []).length, buds: (c.buds || []).length },
        };
      }
      case 'get_days': {
        const days = (c.days || []).map((d, i) => ({ index: i, ...d }));
        if (!args.day) return days;
        const q = norm(args.day);
        return days.filter((d) => String(d.index) === q || norm(d.dow).startsWith(q.slice(0, 3)) || d.dateISO === args.day);
      }
      case 'search_food': {
        const q = norm(args.query);
        const lim = Math.max(1, Math.min(Number(args.limit) || 12, 40));
        const out = (c.food || []).map((f, i) => ({ index: i, ...f }))
          .filter((f) => (!args.category || (f.cats || []).includes(args.category))
            && (!q || q.split(' ').every((w) => norm(`${f.name} ${f.area} ${f.note}`).includes(w))));
        return { total: out.length, results: out.slice(0, lim) };
      }
      case 'search_buds': {
        const q = norm(args.query);
        const lim = Math.max(1, Math.min(Number(args.limit) || 12, 40));
        const out = (c.buds || []).map((b, i) => ({
          index: i, name: b.n, brand: b.b, type: b.c, strain: b.c === 'flower' ? (b.i ? 'indica' : 'sativa/hybrid') : undefined,
          thc: b.t, cbd: b.cb, price_per_g: b.p, in_stock_stores: b.st, rating: b.r, sizes: b.s, url: b.u,
        })).filter((b) => (!args.type || b.type === args.type) && (!args.in_stock_only || b.in_stock_stores > 0)
          && (!args.max_price || (b.price_per_g || 0) <= args.max_price) && (!q || norm(`${b.name} ${b.brand}`).includes(q)));
        return { total: out.length, results: out.slice(0, lim) };
      }
      case 'get_stay': return c.stay || {};
      case 'get_split': {
        const r = await internal(req, 'GET', '/api/expenses');
        if (!r.ok) throw new Error('Could not read the Split');
        const led = r.data || {};
        return {
          expenses: (led.expenses || []).map((e) => ({ id: e.id, desc: e.desc, payer: e.payer, total: money(e.amountCentsCAD), currency: e.currency,
            shares: Object.fromEntries(Object.entries(e.shares || {}).map(([k, v]) => [k, money(v)])), added: e.addedAt })),
          settlements: (led.settlements || []).map((s) => ({ id: s.id, from: s.from, to: s.to, amount: money(s.amountCentsCAD) })),
          ...balances(led), note: 'All amounts CAD.',
        };
      }
      case 'get_packing': return (await internal(req, 'GET', '/api/packing')).data;
      case 'get_poll': return (await internal(req, 'GET', '/api/poll')).data;
      case 'get_flights': return (await internal(req, 'GET', '/api/flights')).data;
      case 'get_weather': return (await internal(req, 'GET', '/api/weather')).data;
      case 'get_content_section': {
        const sec = c[args.section];
        if (sec === undefined) throw new Error('Unknown section');
        if (Array.isArray(sec) && args.index !== undefined) return { index: args.index, item: sec[args.index] };
        if (Array.isArray(sec) && sec.length > 30) return { note: `${sec.length} items; showing names with indexes. Ask for one index for its full JSON.`, items: sec.map((x, i) => ({ index: i, name: x.name || x.n || x.title })) };
        return sec;
      }
      case 'propose_expense': {
        const payer = person(args.payer);
        if (!payer) throw new Error(`Unknown payer "${args.payer}". People: ${activePeople().join(', ')}`);
        const cur = args.currency === 'USD' ? 'USD' : 'CAD';
        const orig = Math.round(Number(args.amount) * 100);
        if (!(orig > 0)) throw new Error('Amount must be more than 0');
        let rate = 1;
        if (cur === 'USD') { const fx = await internal(req, 'GET', '/api/fx'); rate = (fx.data && fx.data.usdCad) || 1.38; }
        const total = Math.round(orig * rate);
        let shares;
        if (args.exact_shares && typeof args.exact_shares === 'object') {
          shares = {};
          for (const [k, v] of Object.entries(args.exact_shares)) { const p = person(k); if (!p) throw new Error(`Unknown person "${k}"`); shares[p] = Math.round(Number(v) * 100 * rate); }
          const sum = Object.values(shares).reduce((a, b) => a + b, 0);
          const diff = total - sum;
          if (Math.abs(diff) > Object.keys(shares).length) throw new Error('Exact shares must add up to the amount');
          shares[Object.keys(shares)[0]] += diff;
        } else {
          const names = (Array.isArray(args.split_between) && args.split_between.length ? args.split_between : activePeople()).map((n) => { const p = person(n); if (!p) throw new Error(`Unknown person "${n}"`); return p; });
          shares = splitEqual(total, [...new Set(names)]);
        }
        const body = { payer, desc: String(args.description || '').slice(0, 200), amountCentsCAD: total, currency: cur, origCents: orig, fxRate: cur === 'USD' ? rate : null, splitMode: args.exact_shares ? 'exact' : 'equal', shares };
        const per = Object.entries(shares).map(([k, v]) => `${k} ${money(v)}`).join(', ');
        return makeProposal(req, {
          summary: `Add "${body.desc}": ${money(total)} CAD${cur === 'USD' ? ` (US${money(orig)})` : ''} paid by ${payer}`,
          items: [`Split: ${per}`], actions: [{ method: 'POST', path: '/api/expenses', body }], refresh: ['split'],
        });
      }
      case 'propose_delete_expense': {
        const led = (await internal(req, 'GET', '/api/expenses')).data || {};
        const e = (led.expenses || []).find((x) => x.id === args.id);
        if (!e) throw new Error('No expense with that id. Use get_split.');
        return makeProposal(req, { summary: `Delete expense "${e.desc}" (${money(e.amountCentsCAD)}, paid by ${e.payer})`, items: [], actions: [{ method: 'DELETE', path: `/api/expenses/${encodeURIComponent(e.id)}` }], refresh: ['split'] });
      }
      case 'propose_settlement': {
        const from = person(args.from); const to = person(args.to);
        const amt = Math.round(Number(args.amount) * 100);
        if (!from || !to || from === to || !(amt > 0)) throw new Error('Need two different Split people and an amount');
        return makeProposal(req, { summary: `Record ${from} paid ${to} ${money(amt)}`, items: [], actions: [{ method: 'POST', path: '/api/settlements', body: { from, to, amountCentsCAD: amt } }], refresh: ['split'] });
      }
      case 'propose_packing': {
        const actions = []; const items = [];
        const list = ((await internal(req, 'GET', '/api/packing')).data || {}).items || [];
        for (const a of args.add || []) {
          const to = a.assigned_to ? (person(a.assigned_to) || 'Everyone') : 'Everyone';
          actions.push({ method: 'POST', path: '/api/packing', body: { text: String(a.text).slice(0, 120), category: PACK_CATS.includes(a.category) ? a.category : 'misc', assignedTo: to } });
          items.push(`Add "${a.text}"${to !== 'Everyone' ? ` for ${to}` : ''}`);
        }
        for (const id of args.toggle_ids || []) { const it = list.find((x) => x.id === id); if (!it) throw new Error(`No packing item ${id}`); actions.push({ method: 'PATCH', path: `/api/packing/${encodeURIComponent(id)}/check` }); items.push(`${it.checkedBy ? 'Unpack' : 'Mark packed'}: ${it.text}`); }
        for (const id of args.delete_ids || []) { const it = list.find((x) => x.id === id); if (!it) throw new Error(`No packing item ${id}`); actions.push({ method: 'DELETE', path: `/api/packing/${encodeURIComponent(id)}` }); items.push(`Remove "${it.text}"`); }
        if (!actions.length) throw new Error('Nothing to change');
        return makeProposal(req, { summary: `Update the packing list (${actions.length} change${actions.length > 1 ? 's' : ''})`, items, actions, refresh: ['packing'] });
      }
      case 'propose_poll': {
        if (args.close) return makeProposal(req, { summary: 'Close the active poll', items: [], actions: [{ method: 'DELETE', path: '/api/poll' }], refresh: ['poll'] });
        const opts = (args.options || []).map((o) => String(o).trim()).filter(Boolean).slice(0, 8);
        if (!args.question || opts.length < 2) throw new Error('Need a question and 2-8 options');
        return makeProposal(req, { summary: `Start poll: ${args.question}`, items: opts.map((o) => `• ${o}`), actions: [{ method: 'POST', path: '/api/poll', body: { question: String(args.question).slice(0, 200), options: opts } }], refresh: ['poll'] });
      }
      case 'propose_vote': {
        const poll = ((await internal(req, 'GET', '/api/poll')).data || {}).active;
        if (!poll) throw new Error('No active poll');
        const opt = (poll.options || []).find((o) => o.id === args.option || norm(o.text) === norm(args.option)) || (poll.options || []).find((o) => norm(o.text).includes(norm(args.option)));
        if (!opt) throw new Error(`No option like "${args.option}"`);
        return makeProposal(req, { summary: `Vote "${opt.text}" in: ${poll.question}`, items: [], actions: [{ method: 'POST', path: '/api/poll/vote', body: { optionId: opt.id } }], refresh: ['poll'] });
      }
      case 'propose_flight': {
        if (args.id) {
          const fl = ((await internal(req, 'GET', '/api/flights')).data || {});
          const all = Array.isArray(fl) ? fl : (fl.flights || []);
          const f = all.find((x) => x.id === args.id);
          if (!f) throw new Error('No flight with that id. Use get_flights.');
          if (args.delete) return makeProposal(req, { summary: `Delete ${f.person}'s flight ${f.flightNumber}`, items: [], actions: [{ method: 'DELETE', path: `/api/flights/${encodeURIComponent(f.id)}` }], refresh: ['flights'] });
          const patch = {}; const items = [];
          for (const k of ['status', 'gate', 'terminal', 'notes']) if (args[k] !== undefined) { patch[k] = args[k]; items.push(`${k}: ${args[k]}`); }
          if (!items.length) throw new Error('Nothing to update');
          return makeProposal(req, { summary: `Update ${f.person}'s flight ${f.flightNumber}`, items, actions: [{ method: 'PATCH', path: `/api/flights/${encodeURIComponent(f.id)}`, body: patch }], refresh: ['flights'] });
        }
        const req2 = ['person', 'flightNumber', 'departureDate', 'originCode', 'destinationCode'];
        for (const k of req2) if (!args[k]) throw new Error(`Missing ${k}`);
        const body = {}; for (const [k, v] of Object.entries(args)) if (k !== 'delete') body[k] = v;
        return makeProposal(req, { summary: `Add ${args.person}'s flight ${args.flightNumber} ${args.originCode}→${args.destinationCode} on ${args.departureDate}`, items: [args.departureTime ? `Departs ${args.departureTime}` : ''].filter(Boolean), actions: [{ method: 'POST', path: '/api/flights', body }], refresh: ['flights'] });
      }
      case 'propose_content_edit': {
        if (!isAdminUser(req.session.user)) throw new Error('Only Mutasif and Moiz can edit site content. Tell the user that.');
        const ops = Array.isArray(args.ops) ? args.ops.slice(0, 40) : [];
        if (!ops.length) throw new Error('No changes');
        const base = content();
        const { labels } = applyOps(base, ops);
        return makeProposal(req, { summary: String(args.summary || 'Edit site content').slice(0, 200), items: labels, contentOps: ops, baseHash: hash(base), refresh: ['content'] });
      }
      default: throw new Error(`Unknown tool ${name}`);
    }
  }

  function systemPrompt(req, view) {
    const me = req.session.user;
    return `You are Trip AI on trip.crcmz.me, the hub for the CRCMZ BOYZ trip to Calgary (Airbnb in Bayside, Airdrie), Oct 29 to Nov 1 2026.
Now in Calgary: ${calgaryNow()}. You're talking to ${displayName(me)}${matchPerson(me) ? ` (${matchPerson(me)} on the Split)` : ''}. ${isAdminUser(me) ? 'They are an admin and can edit site content.' : 'They are not an admin: they can change the Split, packing, polls and flights, but not site content.'} They're on the "${view || 'home'}" tab.
Rules:
- Use tools for facts. Never invent prices, times, balances, stock or ids. If a tool fails, say so plainly.
- Keep replies short and friendly, squad energy, no corporate tone. Use short paragraphs, "- " bullets and **bold**. Links as [text](url).
- Tools named propose_* only PROPOSE a change; the user gets an Apply button. After proposing, say what you proposed in one line and that they can tap Apply. Never claim it's done.
- Money is CAD unless they say USD. The Split people are: ${activePeople().join(', ')}. "Me"/"I" means ${matchPerson(me) || 'the user'}.
- To edit site content (itinerary days, food guide, buds menu, stay, trip text): read it with get_content_section, then propose_content_edit with exact paths.
- For anything about the squad beyond this trip (stats, tournaments, leaderboards, clips, who said what, people) use the crcmz_ tools. For live Calgary info (hours, events, directions) use crcmz_web_search.`;
  }

  // ---------- model ----------
  async function chatStream(messages, tools, onDelta, signal) {
    const headers = { 'Content-Type': 'application/json' };
    if (process.env.OLLAMA_API_KEY) headers.Authorization = `Bearer ${process.env.OLLAMA_API_KEY}`;
    const r = await fetch(`${AI_BASE()}/chat/completions`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: AI_MODEL(), messages, tools, tool_choice: 'auto', stream: true, temperature: 0.4, max_tokens: 1400, chat_template_kwargs: { enable_thinking: false } }),
    });
    if (!r.ok || !r.body) throw new Error(`model ${r.status}`);
    let text = ''; let buf = ''; let inThink = false;
    const calls = [];
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
        if (d.content) {
          let piece = d.content;
          // Drop any <think> block the template still emits.
          let out = '';
          while (piece) {
            if (inThink) { const e = piece.indexOf('</think>'); if (e < 0) { piece = ''; } else { inThink = false; piece = piece.slice(e + 8); } } else { const s = piece.indexOf('<think>'); if (s < 0) { out += piece; piece = ''; } else { out += piece.slice(0, s); inThink = true; piece = piece.slice(s + 7); } }
          }
          if (out) { text += out; onDelta(out); }
        }
        for (const tc of d.tool_calls || []) {
          const k = tc.index || 0;
          calls[k] = calls[k] || { id: tc.id || `call_${k}_${Date.now()}`, type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) calls[k].id = tc.id;
          if (tc.function && tc.function.name) calls[k].function.name += tc.function.name;
          if (tc.function && tc.function.arguments) calls[k].function.arguments += tc.function.arguments;
        }
      }
    }
    return { text, calls: calls.filter(Boolean) };
  }

  // ---------- routes ----------
  app.post('/api/assistant/chat', requireAuth, async (req, res) => {
    const who = userKey(req);
    const now = Date.now();
    const hits = (rate.get(who) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (hits.length >= 40) return res.status(429).json({ error: 'Slow down a little, try again in a few minutes.' });
    if (inflight.has(who)) return res.status(409).json({ error: 'Still answering your last message.' });
    hits.push(now); rate.set(who, hits);
    const body = req.body || {};
    const history = (Array.isArray(body.messages) ? body.messages : []).slice(-14)
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
    if (!history.length || history[history.length - 1].role !== 'user') return res.status(400).json({ error: 'Send a message.' });

    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (ev) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(ev)}\n\n`); };
    const ctrl = new AbortController();
    res.on('close', () => ctrl.abort());
    inflight.add(who);
    try {
      const tools = [...LOCAL_TOOLS, ...(await mcpTools())];
      const msgs = [{ role: 'system', content: systemPrompt(req, String(body.view || '').slice(0, 20)) }, ...history];
      let final = '';
      for (let step = 0; step < MAX_STEPS; step++) {
        const { text, calls } = await chatStream(msgs, tools, (d) => send({ type: 'delta', text: d }), ctrl.signal);
        if (!calls.length) { final = text; break; }
        if (text) send({ type: 'reset' });
        msgs.push({ role: 'assistant', content: text || null, tool_calls: calls });
        for (const call of calls) {
          let args = {};
          try { args = call.function.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = {}; }
          let result;
          try {
            result = await runTool(req, call.function.name, args, send);
            if (result && result.proposal_id) send({ type: 'proposal', id: result.proposal_id, summary: result.summary, items: result.items || [] });
          } catch (e) {
            result = { error: e.message || String(e) };
          }
          msgs.push({ role: 'tool', tool_call_id: call.id, content: typeof result === 'string' ? result : JSON.stringify(result).slice(0, 14000) });
        }
        if (step === MAX_STEPS - 1) final = 'I went in circles there. Try asking a bit more specifically?';
      }
      send({ type: 'done', text: final });
    } catch (e) {
      if (!ctrl.signal.aborted) {
        console.error('[crcmz-trip] assistant error:', e.message);
        send({ type: 'error', text: /fetch failed|ECONN|model 5/.test(e.message) ? "The AI server isn't answering right now. Try again in a minute." : 'Something went wrong answering that.' });
      }
    } finally {
      inflight.delete(who);
      res.end();
    }
  });

  app.post('/api/assistant/apply', requireAuth, async (req, res) => {
    const p = proposals.get(String((req.body || {}).id || ''));
    if (!p || p.owner !== userKey(req)) return res.status(404).json({ error: 'That change expired. Ask again.' });
    if (Date.now() - p.at > PROPOSAL_TTL) { proposals.delete(p.id); return res.status(410).json({ error: 'That change expired. Ask again.' }); }
    proposals.delete(p.id);
    try {
      if (p.contentOps) {
        // Re-apply the ops on the latest content so a concurrent edit is never overwritten.
        const { doc } = applyOps(content(), p.contentOps);
        const r = await internal(req, 'PUT', '/api/content', doc);
        if (!r.ok) return res.status(r.status).json({ error: (r.data && r.data.error) || 'Could not save the content.' });
        return res.json({ ok: true, refresh: p.refresh, content: doc });
      }
      const results = [];
      for (const a of p.actions) {
        const r = await internal(req, a.method, a.path, a.body);
        if (!r.ok) return res.status(r.status >= 400 ? r.status : 400).json({ error: (r.data && r.data.error) || 'That change was rejected.', done: results.length });
        results.push(r.status);
      }
      return res.json({ ok: true, refresh: p.refresh });
    } catch (e) {
      console.error('[crcmz-trip] assistant apply failed:', e.message);
      return res.status(500).json({ error: 'Could not apply that change.' });
    }
  });

  app.get('/api/assistant/status', requireAuth, async (req, res) => {
    res.json({ model: AI_MODEL(), mcp: Boolean(MCP_TOKEN()), mcp_tools: (await mcpTools()).length, admin: isAdminUser(req.session.user) });
  });
};
