'use strict';

/**
 * CRCMZ Trip — thin production wrapper around the static trip page.
 *
 * The trip page itself is a single static HTML file (public/index.html +
 * public/assets). This server exists to:
 *   1. serve it on 0.0.0.0:$PORT, and
 *   2. gate every route behind a Zitadel OIDC login
 *      (Authorization Code flow via passport-openidconnect).
 *
 * All configuration comes from environment variables. No secrets in code.
 * Required env: ZITADEL_ISSUER, ZITADEL_CLIENT_ID, ZITADEL_CLIENT_SECRET,
 * SESSION_SECRET. Optional: PORT (default 3000), BASE_URL (public origin,
 * e.g. https://trip.crcmz.me — used to build the OIDC callback URL).
 */

const path = require('path');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const { Strategy: OpenIDConnectStrategy } = require('passport-openidconnect');

const PORT = parseInt(process.env.PORT || '3000', 10);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CALLBACK_PATH = '/auth/callback';
const CALLBACK_URL = `${BASE_URL}${CALLBACK_PATH}`;

const REQUIRED = ['ZITADEL_ISSUER', 'ZITADEL_CLIENT_ID', 'ZITADEL_CLIENT_SECRET', 'SESSION_SECRET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`[crcmz-trip] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[crcmz-trip] See .env.example — refusing to start without them.');
  process.exit(1);
}
const ISSUER = process.env.ZITADEL_ISSUER.replace(/\/$/, '');

async function discover(issuer) {
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`OIDC discovery failed: GET ${url} -> ${res.status}`);
  return res.json();
}

async function main() {
  const disco = await discover(ISSUER);
  for (const field of ['authorization_endpoint', 'token_endpoint', 'userinfo_endpoint']) {
    if (!disco[field]) throw new Error(`OIDC discovery document is missing ${field}`);
  }
  const endSessionEndpoint = disco.end_session_endpoint || null;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Coolify terminates TLS in front of the app

  app.use(
    session({
      secret: process.env.SESSION_SECRET,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: BASE_URL.startsWith('https://'),
        maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days — covers the trip weekend
      },
    })
  );
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new OpenIDConnectStrategy(
      {
        issuer: ISSUER,
        authorizationURL: disco.authorization_endpoint,
        tokenURL: disco.token_endpoint,
        userInfoURL: disco.userinfo_endpoint,
        clientID: process.env.ZITADEL_CLIENT_ID,
        clientSecret: process.env.ZITADEL_CLIENT_SECRET,
        callbackURL: CALLBACK_URL,
        scope: ['openid', 'profile', 'email'],
      },
      (issuer, profile, done) => done(null, profile)
    )
  );
  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  // Public: health check (Coolify) — no auth, no data.
  app.get('/healthz', (req, res) => res.status(200).type('text/plain').send('ok'));

  // OIDC routes.
  app.get('/auth/login', (req, res, next) => {
    if (req.query.returnTo && typeof req.query.returnTo === 'string' && req.query.returnTo.startsWith('/')) {
      req.session.returnTo = req.query.returnTo;
    }
    passport.authenticate('openidconnect')(req, res, next);
  });

  app.get(
    CALLBACK_PATH,
    passport.authenticate('openidconnect', { failureRedirect: '/auth/login' }),
    (req, res) => {
      const target = req.session.returnTo || '/';
      delete req.session.returnTo;
      res.redirect(target);
    }
  );

  app.get('/auth/logout', (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      req.session.destroy(() => {
        if (endSessionEndpoint) {
          const u = new URL(endSessionEndpoint);
          u.searchParams.set('post_logout_redirect_uri', `${BASE_URL}/auth/login`);
          return res.redirect(u.toString());
        }
        res.redirect('/auth/login');
      });
    });
  });

  // Everything below requires a logged-in Zitadel session.
  function requireAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    req.session.returnTo = req.originalUrl || '/';
    return res.redirect('/auth/login');
  }

  app.use(requireAuth, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[crcmz-trip] Listening on 0.0.0.0:${PORT}`);
    console.log(`[crcmz-trip] Issuer: ${ISSUER}`);
    console.log(`[crcmz-trip] OIDC redirect URI: ${CALLBACK_URL}`);
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

main().catch((err) => {
  console.error(`[crcmz-trip] Startup failed: ${err.message}`);
  process.exit(1);
});
