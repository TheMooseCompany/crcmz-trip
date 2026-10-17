/* CRCMZ Trip — on-device performance probe v1 (diagnostics only).
 *
 * Loaded ONLY when the boot bootstrap in index.html finds the probe
 * flag armed (localStorage "crcmz-probe" = "1", set by ?probe=1 and
 * cleared by ?probe=off — the flag, not the query, survives the
 * Zitadel login redirect). With the flag off this file is never
 * requested and no probe code runs.
 *
 * It measures; it does not fix. It records, per the design in
 * research_notes/trip-perf-diagnosis-2026-10-17/findings.md §6:
 *   - a switch ledger (tap -> first paint vs tap -> content settle,
 *     with the fetches that landed inside each switch window),
 *   - rAF frame-gap histograms at rest and while scrolling, labelled
 *     by the ablation toggles active during the capture,
 *   - a 50 ms interval-drift sampler (main-thread blockage proxy),
 *   - environment facts (which CSS branches this device takes),
 *   - one-tap A/B ablations applied live: noblur / noanim / nofilter.
 * The session autosaves to localStorage ("crcmz-probe-session") on
 * every update, so a reload or a WKWebView process death mid-run does
 * not lose it; Export reads that saved copy.
 */
(function () {
  'use strict';
  if (window.__PROBE) return; // double-load guard

  var LS_SESSION = 'crcmz-probe-session';
  var VIEWS = ['home', 'food', 'photos', 'split', 'tourney', 'buds', 'poll', 'pack'];
  var ABLATIONS = [
    { id: 'noblur', label: 'No blur' },
    { id: 'noanim', label: 'No idle anims' },
    { id: 'nofilter', label: 'No recede filter' }
  ];
  var SCRIPT = [
    'Open the app — probe panel visible',
    'Tap all 8 tabs once, slowly',
    'Home: scroll to the bottom and back up',
    'Food: open it, scroll a few screens',
    'Home: start “Rest 10s”, sit still 10 s',
    'Toggle each ablation ON, re-scroll Home each time',
    'Export the JSON and send it back'
  ];

  /* ---------------- public handle (the recede drivers read .nofilter) */
  var P = window.__PROBE = {
    active: true,
    version: 1,
    nofilter: false,
    abl: { noblur: false, noanim: false, nofilter: false }
  };

  /* ---------------- session state */
  var state = {
    startedAt: new Date().toISOString(),
    env: null,
    ledger: [],
    fetchLog: [],
    histograms: [],
    drift: {},
    checks: {}
  };
  try {
    var saved = localStorage.getItem(LS_SESSION);
    if (saved) {
      var s = JSON.parse(saved);
      if (s && s.startedAt) state = s; // resume: a reload must not lose the run
    }
  } catch (e) { /* fresh session */ }

  var saveT = 0;
  function save() {
    try { localStorage.setItem(LS_SESSION, JSON.stringify(state)); } catch (e) {}
  }
  function saveSoon() {
    var now = Date.now();
    if (now - saveT > 400) { saveT = now; save(); }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) save();
  });

  function pct(arr, p) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return Math.round(a[Math.min(a.length - 1, Math.floor(p / 100 * a.length))] * 10) / 10;
  }
  function currentView() { return document.body.getAttribute('data-view') || 'home'; }

  /* ---------------- environment facts */
  function collectEnv() {
    var atProp = null;
    try {
      atProp = CSS.supports('@property --probe-x { syntax: "<length>"; inherits: false; initial-value: 0px; }');
    } catch (e) { atProp = 'error: ' + e.message; }
    var env = {
      ua: navigator.userAgent,
      standalone: (window.navigator.standalone === true) ||
        (window.matchMedia && matchMedia('(display-mode: standalone)').matches),
      displayMode: 'browser',
      dpr: window.devicePixelRatio || null,
      hardwareConcurrency: navigator.hardwareConcurrency || null,
      deviceMemory: (typeof navigator.deviceMemory === 'number') ? navigator.deviceMemory : null,
      viewport: { w: window.innerWidth, h: window.innerHeight },
      cssSupports: {
        contentVisibility: CSS.supports('content-visibility: auto'),
        animationTimelineView: CSS.supports('animation-timeline: view()'),
        atProperty: atProp,
        registerProperty: ('registerProperty' in CSS)
      },
      connection: null
    };
    try {
      if (matchMedia('(display-mode: standalone)').matches) env.displayMode = 'standalone';
      else if (matchMedia('(display-mode: fullscreen)').matches) env.displayMode = 'fullscreen';
    } catch (e) {}
    try {
      if (navigator.connection) env.connection = {
        effectiveType: navigator.connection.effectiveType,
        downlink: navigator.connection.downlink,
        rtt: navigator.connection.rtt
      };
    } catch (e) {}
    return env;
  }
  state.env = collectEnv();

  /* ---------------- fetch wrap (probe-active only: this file) */
  var openSwitch = null;
  function bump() { if (openSwitch) openSwitch.lastActivity = performance.now(); }
  if (typeof window.fetch === 'function') {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var url = (typeof input === 'string') ? input : ((input && input.url) || String(input));
      try { url = url.replace(location.origin, ''); } catch (e) {}
      var t0 = performance.now();
      var rec = { url: url, start: Math.round(t0), dur: null, status: null };
      state.fetchLog.push(rec);
      if (state.fetchLog.length > 400) state.fetchLog.splice(0, state.fetchLog.length - 400);
      if (openSwitch) { openSwitch.fetches.push(rec); bump(); }
      return origFetch.call(window, input, init).then(function (r) {
        rec.dur = Math.round(performance.now() - t0); rec.status = r.status;
        bump(); saveSoon(); return r;
      }, function (err) {
        rec.dur = Math.round(performance.now() - t0); rec.status = 'error';
        bump(); saveSoon(); throw err;
      });
    };
  }

  /* ---------------- switch ledger */
  function maybePaint(view) {
    if (!openSwitch || openSwitch.view !== view || openSwitch.paint != null) return;
    var el = document.getElementById('view-' + view);
    if (el && !el.hidden) {
      requestAnimationFrame(function () {
        if (openSwitch && openSwitch.paint == null) {
          openSwitch.paint = Math.round(performance.now());
          bump();
        }
      });
    }
  }
  function beginSwitch(to, tapT) {
    if (openSwitch && openSwitch.view === to && tapT - openSwitch.tap < 600) return; // click+hashchange dedupe
    closeSwitch(performance.now());
    openSwitch = {
      view: to, tap: Math.round(tapT), paint: null, settle: null,
      fetches: [], mutations: 0, lastActivity: tapT
    };
    maybePaint(to);
    renderLedger();
  }
  function closeSwitch(now) {
    if (!openSwitch) return;
    var s = openSwitch; openSwitch = null;
    /* Settle is stamped at the last observed activity (last fetch end /
       last mutation in the view), not at detection time — the quiet
       window below is only how we know activity has stopped. */
    s.settle = Math.round(Math.max(s.lastActivity, s.tap));
    s.tapToPaintMs = (s.paint != null) ? s.paint - s.tap : null;
    s.tapToSettleMs = s.settle - s.tap;
    s.fetchSummary = s.fetches.map(function (f) {
      return { url: f.url, dur: f.dur, status: f.status };
    });
    delete s.fetches; delete s.lastActivity;
    state.ledger.push(s);
    if (state.ledger.length > 60) state.ledger.splice(0, state.ledger.length - 60);
    save(); renderLedger();
  }
  setInterval(function () {
    if (!openSwitch || openSwitch.paint == null) return;
    var now = performance.now();
    if ((now - openSwitch.lastActivity > 500 && now - openSwitch.tap > 700) ||
        now - openSwitch.tap > 15000) closeSwitch(now);
  }, 100);

  document.addEventListener('click', function (e) {
    var t = (e.target && e.target.closest) ? e.target.closest('.tabbar .tab,[data-view].nav-tile') : null;
    if (t) {
      var v = t.getAttribute('data-view');
      if (v && VIEWS.indexOf(v) >= 0) beginSwitch(v, performance.now());
    }
  }, true);
  window.addEventListener('hashchange', function () {
    var h = (location.hash || '').replace(/^#/, '');
    if (VIEWS.indexOf(h) >= 0) beginSwitch(h, performance.now());
  });

  function watchViews() {
    VIEWS.forEach(function (v) {
      var el = document.getElementById('view-' + v);
      if (!el) return;
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].type === 'attributes') maybePaint(v);
          else if (openSwitch && openSwitch.view === v) { openSwitch.mutations++; bump(); }
        }
      }).observe(el, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
    });
  }

  /* ---------------- rAF histograms + drift sampler */
  var cap = null;
  function capLabel(context) {
    var on = ABLATIONS.filter(function (a) { return P.abl[a.id]; }).map(function (a) { return a.id; });
    return context + ' · ' + currentView() + ' · ' + (on.length ? on.join('+') : 'baseline');
  }
  function startCapture(context, seconds) {
    stopCapture();
    cap = {
      label: capLabel(context), context: context, view: currentView(),
      ablation: ABLATIONS.filter(function (a) { return P.abl[a.id]; }).map(function (a) { return a.id; }),
      gaps: [], driftSamples: [], lastT: 0, lastExp: performance.now() + 50, raf: 0, iv: 0
    };
    cap.iv = setInterval(function () {
      var now = performance.now();
      cap.driftSamples.push(Math.max(0, Math.round(now - cap.lastExp)));
      cap.lastExp = now + 50;
    }, 50);
    var t0 = performance.now();
    (function loop(t) {
      if (!cap) return;
      if (cap.lastT) cap.gaps.push(Math.round((t - cap.lastT) * 10) / 10);
      cap.lastT = t;
      if (t - t0 < seconds * 1000) cap.raf = requestAnimationFrame(loop);
      else stopCapture();
    })(t0);
    renderPanel();
  }
  function stopCapture() {
    if (!cap) return;
    cancelAnimationFrame(cap.raf); clearInterval(cap.iv);
    var gaps = cap.gaps.slice(1); // first delta straddles the start; drop it
    state.histograms.push({
      label: cap.label, context: cap.context, view: cap.view, ablation: cap.ablation,
      n: gaps.length, medianMs: pct(gaps, 50), p95Ms: pct(gaps, 95),
      maxMs: gaps.length ? Math.max.apply(null, gaps) : 0, gapsMs: gaps
    });
    state.drift[cap.label] = {
      n: cap.driftSamples.length, medianMs: pct(cap.driftSamples, 50),
      p95Ms: pct(cap.driftSamples, 95),
      maxMs: cap.driftSamples.length ? Math.max.apply(null, cap.driftSamples) : 0
    };
    cap = null;
    save(); renderPanel();
  }

  /* ---------------- ablations */
  var ablStyle = null;
  function applyAblations() {
    var d = document.documentElement;
    d.classList.toggle('probe-noblur', !!P.abl.noblur);
    d.classList.toggle('probe-noanim', !!P.abl.noanim);
    var css = '';
    if (P.abl.noblur) css +=
      'html.probe-noblur *,html.probe-noblur *::before,html.probe-noblur *::after' +
      '{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' +
      'html.probe-noblur .tabbar{filter:none!important}';
    if (P.abl.noanim) css +=
      'html.probe-noanim *,html.probe-noanim *::before,html.probe-noanim *::after' +
      '{animation-play-state:paused!important}';
    if (!css) {
      if (ablStyle) { ablStyle.remove(); ablStyle = null; }
      return;
    }
    if (!ablStyle) {
      ablStyle = document.createElement('style');
      ablStyle.id = 'crcmz-probe-abl';
      document.head.appendChild(ablStyle);
    }
    ablStyle.textContent = css;
  }
  function setAbl(id, on) {
    P.abl[id] = on;
    if (id === 'nofilter') {
      P.nofilter = on;
      if (on) { // neutralize filters the drivers already wrote
        document.querySelectorAll('.bp-pass,.fl-card').forEach(function (el) { el.style.filter = ''; });
      }
    }
    applyAblations(); save(); renderPanel();
  }

  /* ---------------- export */
  function fetchSummary() {
    var byUrl = {};
    state.fetchLog.forEach(function (f) {
      var k = f.url.split('?')[0];
      var b = byUrl[k] || (byUrl[k] = { count: 0, durs: [] });
      b.count++;
      if (typeof f.dur === 'number') b.durs.push(f.dur);
    });
    return Object.keys(byUrl).map(function (k) {
      return { url: k, count: byUrl[k].count, medianMs: pct(byUrl[k].durs, 50), p95Ms: pct(byUrl[k].durs, 95) };
    }).sort(function (a, b) { return b.count - a.count; });
  }
  function buildExport() {
    stopCapture();
    return {
      probe: 'crcmz-trip on-device perf probe',
      version: P.version,
      exportedAt: new Date().toISOString(),
      sessionStartedAt: state.startedAt,
      env: state.env,
      switchLedger: state.ledger,
      fetchLogSummary: fetchSummary(),
      fetchLog: state.fetchLog,
      rafHistograms: state.histograms,
      drift: state.drift,
      scriptChecks: state.checks
    };
  }
  function doExport(statusEl) {
    var json = JSON.stringify(buildExport(), null, 1);
    save();
    try {
      var blob = new Blob([json], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'crcmz-probe-session.json';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function () {
        statusEl.textContent = 'Exported ✓ — downloaded + copied to clipboard.';
      }, function () { statusEl.textContent = 'Exported ✓ — downloaded (clipboard unavailable; the file is the copy).'; });
    } else {
      statusEl.textContent = 'Exported ✓ — downloaded.';
    }
  }

  /* ---------------- panel */
  var panel = null, ledgerEl = null, statusEl = null;
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function renderLedger() {
    if (!ledgerEl) return;
    var rows = state.ledger.slice(-6).reverse().map(function (s) {
      return '<div class="pr-row">' + esc(s.view) +
        ' — paint ' + (s.tapToPaintMs == null ? '?' : s.tapToPaintMs + 'ms') +
        ' · settle ' + s.tapToSettleMs + 'ms · ' + s.fetchSummary.length + ' fetch</div>';
    });
    ledgerEl.innerHTML = rows.length ? rows.join('') : '<div class="pr-row pr-dim">No switches recorded yet — tap a tab.</div>';
  }
  function renderPanel() {
    if (!panel) return;
    panel.querySelectorAll('[data-abl]').forEach(function (b) {
      b.classList.toggle('on', !!P.abl[b.getAttribute('data-abl')]);
    });
    var capBtn = panel.querySelector('[data-act="capstop"]');
    if (capBtn) capBtn.textContent = cap ? ('■ Stop — ' + cap.label) : '';
    if (capBtn) capBtn.style.display = cap ? '' : 'none';
    renderLedger();
  }
  function buildPanel() {
    var st = document.createElement('style');
    st.id = 'crcmz-probe-css';
    st.textContent =
      '#crcmz-probe{position:fixed;right:8px;bottom:calc(94px + env(safe-area-inset-bottom));' +
      'z-index:9999;width:min(344px,calc(100vw - 16px));background:rgba(9,11,26,.95);' +
      'color:#F5EFE0;border:1px solid rgba(255,255,255,.28);border-radius:14px;' +
      'font:12px/1.5 -apple-system,system-ui,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.5)}' +
      '#crcmz-probe .pr-head{display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:pointer}' +
      '#crcmz-probe .pr-head b{font-size:12px;letter-spacing:.06em}' +
      '#crcmz-probe .pr-view{opacity:.75}' +
      '#crcmz-probe .pr-x{margin-left:auto;background:none;border:0;color:#F5EFE0;font-size:14px;padding:2px 6px}' +
      '#crcmz-probe .pr-body{padding:0 10px 10px;max-height:56vh;overflow-y:auto}' +
      '#crcmz-probe.pr-closed .pr-body{display:none}' +
      '#crcmz-probe h4{margin:10px 0 4px;font-size:11px;letter-spacing:.08em;opacity:.7}' +
      '#crcmz-probe button.pr-btn{background:rgba(255,255,255,.1);color:#F5EFE0;' +
      'border:1px solid rgba(255,255,255,.25);border-radius:999px;padding:5px 10px;' +
      'font-size:12px;margin:0 4px 4px 0}' +
      '#crcmz-probe button.pr-btn.on{background:#A5B4FF;color:#0B0E22;border-color:#A5B4FF;font-weight:700}' +
      '#crcmz-probe .pr-row{padding:2px 0;border-bottom:1px solid rgba(255,255,255,.08)}' +
      '#crcmz-probe .pr-dim{opacity:.6}' +
      '#crcmz-probe label.pr-step{display:flex;gap:7px;align-items:flex-start;padding:2px 0}' +
      '#crcmz-probe .pr-status{opacity:.8;min-height:16px}';
    document.head.appendChild(st);

    panel = document.createElement('div');
    panel.id = 'crcmz-probe';
    panel.className = 'pr-closed';
    panel.innerHTML =
      '<div class="pr-head"><b>🔬 PROBE</b><span class="pr-view">' + esc(currentView()) + '</span>' +
      '<button class="pr-x" data-act="toggle" aria-label="Collapse probe">▾</button></div>' +
      '<div class="pr-body">' +
      '<h4>CAPTURE FRAMES</h4>' +
      '<button class="pr-btn" data-act="rest">⏺ Rest 10s</button>' +
      '<button class="pr-btn" data-act="scroll">⏺ Scroll 20s</button>' +
      '<button class="pr-btn" data-act="capstop" style="display:none"></button>' +
      '<div class="pr-dim">Rest = sit still. Scroll = start, then scroll right away. ' +
      'Segments are labelled by the toggles active during them.</div>' +
      '<h4>ABLATIONS — ONE-TAP A/B</h4>' +
      ABLATIONS.map(function (a) {
        return '<button class="pr-btn" data-abl="' + a.id + '">' + a.label + '</button>';
      }).join('') +
      '<h4>SWITCH LEDGER (latest)</h4><div class="pr-ledger"></div>' +
      '<h4>SESSION SCRIPT</h4>' +
      SCRIPT.map(function (s, i) {
        return '<label class="pr-step"><input type="checkbox" data-prstep="' + i + '"' +
          (state.checks[i] ? ' checked' : '') + '> <span>' + esc(s) + '</span></label>';
      }).join('') +
      '<h4>EXPORT</h4>' +
      '<button class="pr-btn" data-act="export">⬇ Export JSON</button>' +
      '<button class="pr-btn" data-act="reset">Reset session</button>' +
      '<button class="pr-btn" data-act="off">Probe off</button>' +
      '<div class="pr-status"></div>' +
      '</div>';
    document.body.appendChild(panel);
    ledgerEl = panel.querySelector('.pr-ledger');
    statusEl = panel.querySelector('.pr-status');

    panel.addEventListener('click', function (e) {
      var ablBtn = e.target.closest ? e.target.closest('[data-abl]') : null;
      if (ablBtn) { var id = ablBtn.getAttribute('data-abl'); setAbl(id, !P.abl[id]); return; }
      var btn = e.target.closest ? e.target.closest('[data-act]') : null;
      var act = btn ? btn.getAttribute('data-act') : (e.target.closest && e.target.closest('.pr-head') ? 'toggle' : null);
      if (!act) return;
      if (act === 'toggle') panel.classList.toggle('pr-closed');
      else if (act === 'rest') startCapture('rest', 10);
      else if (act === 'scroll') startCapture('scroll', 20);
      else if (act === 'capstop') stopCapture();
      else if (act === 'export') doExport(statusEl);
      else if (act === 'reset') {
        state = { startedAt: new Date().toISOString(), env: collectEnv(), ledger: [], fetchLog: [], histograms: [], drift: {}, checks: {} };
        save(); buildChecklist(); renderPanel();
        statusEl.textContent = 'Session reset.';
      }
      else if (act === 'off') {
        try { localStorage.removeItem('crcmz-probe'); } catch (err) {}
        statusEl.textContent = 'Probe disarmed — reload the page to remove the panel.';
      }
    });
    panel.addEventListener('change', function (e) {
      var cb = e.target.closest ? e.target.closest('[data-prstep]') : null;
      if (cb) { state.checks[cb.getAttribute('data-prstep')] = cb.checked; save(); }
    });
    document.addEventListener('viewchange', function () {
      var v = panel.querySelector('.pr-view');
      if (v) v.textContent = currentView();
    });
    renderPanel();
  }
  function buildChecklist() {
    if (!panel) return;
    panel.querySelectorAll('[data-prstep]').forEach(function (cb) {
      cb.checked = !!state.checks[cb.getAttribute('data-prstep')];
    });
  }

  /* ---------------- boot */
  function init() {
    watchViews();
    buildPanel();
    save();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
