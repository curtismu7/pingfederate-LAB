import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadCustomerConfig, publicConfig } from './customer.js';
import { renderStory, verticalList, StoryError } from './stories.js';
import { createSettings, REQUIRED, SettingsError } from './settings.js';
import { createNetguard } from './netguard.js';
import { createMock, modeSettings, mockSignInRefusal, hostRunAllowsMockSignIn, labelMock, MOCK_USER } from './mock.js';
import { createOutbound } from './outbound.js';
import { createPf, LabError } from './pf.js';
import { createPiFlow } from './piflow.js';
import { createDcr } from './dcr.js';
import { createCiba } from './ciba.js';
import { createApprover } from './approver.js';
import { createExchange } from './exchange.js';
import { createUserinfo } from './userinfo.js';
import { cardList, buildAuthorizationDetail, discoveryCheck } from './cards.js';
import { createSessions, validWorkspace, DEFAULT_WORKSPACE } from './session.js';
import { tokenView, withTokenMode } from './trace.js';
import { shelfInfo } from './shelfLink.js';

export const DEMO = { id: 'pingfederate-lab', name: 'PingFederate LAB', version: '0.1.0' };
const FLOW_CARDS = new Set(['pkce', 'par', 'rar', 'dpop']);
const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
// The built UI loads only its own files: no third-party script, style, font or connection.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Every error is JSON with a fixed code; LabError adds a message written for the page and, when PingFederate was
// already called, the redacted trace up to the failure. No stack, path or secret ever reaches the client.
export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof LabError) {
    const body = { error: err.code, message: err.message, ...(err.extra?.trace ? { trace: err.extra.trace } : {}) };
    return res.status(err.status).json(res.locals.mock ? labelMock(body) : body);
  }
  if (err instanceof SettingsError) return res.status(400).json({ error: 'invalid_setting', field: err.field, message: err.message });
  const status = Number(err?.status ?? err?.statusCode);
  if (status === 413) return res.status(413).json({ error: 'payload_too_large' });
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' });
  console.error('[pingfederate-lab] unexpected error:', err?.name || 'Error'); // never the message: it could carry a value
  return res.status(500).json({ error: 'server_error' });
}

// In mock mode (res.locals.mock) every reply, and every error's trace, is labelled mock (labelMock).
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((body) => {
  if (!res.headersSent) res.set('Cache-Control', 'no-store').json(res.locals.mock ? labelMock(body) : body);
}).catch(next);

// Which Host headers and write Origins the lab answers. Loopback always; LAB_ALLOWED_HOSTS adds more names (comma
// separated host names that point at this Mac, such as a local domain). TLS (LAB_TLS_CERT and LAB_TLS_KEY) makes the origins https.
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;
export function labAddresses({ port, env = process.env }) {
  const scheme = env.LAB_TLS_CERT && env.LAB_TLS_KEY ? 'https' : 'http';
  const extra = String(env.LAB_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  for (const h of extra) if (!HOSTNAME.test(h)) throw Object.assign(new Error(`LAB_ALLOWED_HOSTS: not a host name: ${h}`), { field: 'env' });
  const names = ['127.0.0.1', 'localhost', '[::1]', ...extra];
  return {
    scheme,
    hosts: new Set(names.map((n) => `${n}:${port}`)),
    origins: new Set(names.map((n) => `${scheme}://${n}:${port}`)),
  };
}

// bind: the address index.js listens on (mock sign-in is refused on a non-loopback one, rule 11).
// hostRun: index.js sets it, so a plain `npm start` on loopback with no PingFederate saved allows mock sign-in (hostRunAllowsMockSignIn).
export function createApp({ port, fetchImpl = globalThis.fetch, settingsFile, now = Date.now, webDist = DEFAULT_WEB_DIST, customerFile, env = process.env, bind = '127.0.0.1', hostRun = false } = {}) {
  // customer.config.json (or CUSTOMER_CONFIG): branding and vocabulary, validated once at start.
  const customer = loadCustomerConfig({ file: customerFile, env });
  // The owner's saved settings (and the chosen mode); `settings` below is what the cards read in the current mode.
  const saved = createSettings({ file: settingsFile, port });
  let approver = null;
  const mock = createMock({ port, getApprover: () => approver });
  const settings = modeSettings({ live: saved, mock });
  const mode = () => saved.mode();
  // Rule 19: Real (live) is available only when the live configuration is complete (every required setting).
  const liveConfigured = () => Object.values(REQUIRED).every((entries) => entries.every(([s, f]) => Boolean(saved.value(s, f))));
  const netguard = createNetguard({ mode, mock: mock.pf, realFetch: fetchImpl });
  const outbound = createOutbound({ getIssuer: () => settings.value('pf', 'issuer'), fetchImpl: netguard.fetchImpl });
  const pf = createPf({ outbound, settings, now });
  const piflow = createPiFlow({ pf, settings, now });
  const dcr = createDcr({ pf, settings, now });
  approver = createApprover({ settings, now });
  const ciba = createCiba({ pf, settings, approver, now });
  const exchange = createExchange({ pf, settings, now });
  const userinfo = createUserinfo({ pf, settings });
  const addresses = labAddresses({ port, env });
  // The environment rule 11 reads: the real one, plus ALLOW_MOCK_SIGNIN=1 for a host run that qualifies. Read per request, because saving an issuer ends the default.
  const signInEnv = () => (hostRun && hostRunAllowsMockSignIn({ env, bind, hasTenant: Boolean(saved.value('pf', 'issuer')) }) ? { ...env, ALLOW_MOCK_SIGNIN: '1' } : env);
  const sessions = createSessions({ now, secure: addresses.scheme === 'https' });

  const app = express();
  // index.js logs these at startup; the Settings page shows them (via /api/config).
  app.locals.customerWarnings = customer.warnings;
  app.locals.netguard = netguard; // tests and the doctor read its counters
  app.locals.mock = mock.pf;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.locals.mock = mode() === 'mock';
    res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': CSP });
    // Mock tokens are fake and shown whole; live tokens stay masked (trace.js). Everything after this runs in that mode.
    withTokenMode(res.locals.mock, next);
  });
  const allowedHosts = addresses.hosts;
  const allowedOrigins = addresses.origins;

  app.use((req, res, next) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return res.status(403).json({ error: 'host_not_allowed' });
    return next();
  });

  // GET only, no detail (demo-health/1). Behind the Host check, so DNS rebinding cannot read it.
  app.get('/api/health', (req, res) => {
    res.set('Cache-Control', 'no-store').json({
      schema: 'demo-health/1',
      at: new Date(now()).toISOString(),
      state: settings.ready('signin') ? 'ready' : 'needs-setup',
      runtime: mode() === 'mock' ? 'offline' : 'live',
      demo: DEMO,
    });
  });

  app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    if (origin && !allowedOrigins.has(origin)) return res.status(403).json({ error: 'cross_origin_write_refused' });
    if (site && site !== 'same-origin' && site !== 'none') return res.status(403).json({ error: 'cross_origin_write_refused' });
    // A cross-site form cannot send application/json without a preflight, so every write must be JSON.
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return res.status(415).json({ error: 'json_required' });
    return next();
  });
  app.use(express.json({ limit: '16kb' }));

  // PingFederate's CIBA web approver (server to server, Bearer shared secret), before sessions so its calls never
  // create one. Without the secret set, both answer 404.
  app.post('/api/ciba-approver/requests', wrap((req) => approver.register(req.headers.authorization, req.body)));
  app.get('/api/ciba-approver/requests/:transactionId', wrap((req) => approver.lookup(req.headers.authorization, req.params.transactionId)));

  // `npm run reset` (before the session middleware, so the script never creates a session): clears one workspace for every browser. Run state only; saved settings and sign-ins stay.
  app.post('/api/workspaces/:workspace/reset', wrap(async (req) => {
    if (!validWorkspace(req.params.workspace)) throw new LabError('bad_workspace', 'The workspace id is lowercase letters, digits and hyphens (1 to 32 characters)', 400);
    if (mode() === 'mock') for (const s of sessions.inWorkspace(req.params.workspace)) await dcr.discard(s);
    return { ok: true, workspace: req.params.workspace, ...sessions.resetWorkspace(req.params.workspace) };
  }));

  app.use(sessions.middleware);

  // Settings: the owner's saved settings (used in live mode). Secrets are write-only (the view says set: true/false).
  app.get('/api/settings', wrap(() => saved.publicView()));
  app.put('/api/settings', wrap((req) => {
    const view = saved.update(req.body);
    pf.clearCache();
    return view;
  }));

  // Mock or live, for the whole lab. Switching signs everyone out: tokens from one PingFederate mean nothing to the other.
  // The mock user's password is sent only when mock sign-in is allowed, so a refused lab hands out nothing.
  const modeView = (req) => {
    const refusal = mode() === 'mock' ? mockSignInRefusal({ env: signInEnv(), bind, headers: req.headers }) : null;
    return {
      mode: mode(),
      source: mode() === 'mock' ? 'mock' : 'real',
      realAvailable: liveConfigured(),
      realReason: liveConfigured() ? null : 'Real (live) is not available: the live settings are incomplete. Set the PingFederate issuer and every client id and secret on the Settings page.',
      issuer: settings.value('pf', 'issuer') || null,
      mockSignIn: mode() === 'mock' ? { allowed: !refusal, refusal, ...(refusal ? {} : { username: MOCK_USER.username, password: MOCK_USER.password }) } : null,
    };
  };
  app.get('/api/mode', wrap((req) => modeView(req)));
  app.put('/api/mode', wrap((req, res) => {
    const next = req.body?.mode === 'real' ? 'live' : req.body?.mode;
    if (req.body?.mode !== 'mock' && req.body?.mode !== 'real') throw new LabError('bad_mode', 'mode must be exactly "mock" or "real"', 400);
    if (next === 'live' && !liveConfigured()) throw new LabError('real_not_available', 'Real (live) is not available: the live settings are incomplete. Set the PingFederate issuer and every client id and secret on the Settings page.', 409);
    if (next !== mode()) {
      saved.setMode(next);
      pf.clearCache();
      sessions.clear();
    }
    return modeView(req);
  }));

  // Rule 11: in mock mode, every route that signs someone in checks the mock sign-in guards first.
  const SIGNS_IN = /^\/api\/(signin\/(start|credentials)|cards\/(pkce|par|rar|dpop|ciba)\/(start|credentials))$/;
  app.use((req, res, next) => {
    if (mode() !== 'mock' || req.method !== 'POST' || !SIGNS_IN.test(req.path)) return next();
    const refusal = mockSignInRefusal({ env: signInEnv(), bind, headers: req.headers });
    return refusal ? res.status(403).json({ error: 'mock_signin_refused', message: refusal, mode: 'mock' }) : next();
  });

  app.get('/api/cards', wrap(() => ({ cards: cardList(settings, mode() === 'mock' ? { mockUser: MOCK_USER.username } : {}) })));

  // What the page needs to draw itself: branding, vocabulary, and which PingFederate it talks to (for the banner).
  app.get('/api/config', wrap((req) => ({ customer: publicConfig(customer), issuer: settings.value('pf', 'issuer') || null, mode: mode(), workspace: req.session.workspace })));
  // Rule 19: what the Mock/Real toggle needs.
  app.get('/api/info', wrap((req) => {
    const v = modeView(req);
    return { source: v.source, realAvailable: v.realAvailable, realReason: v.realReason, mode: v.mode, issuer: v.issuer };
  }));
  app.get('/api/stories', wrap(() => ({ verticals: verticalList(), default: customer.config.vertical })));
  app.get('/api/stories/:vertical', wrap((req) => {
    try { return renderStory(req.params.vertical, customer.config); } catch (error) {
      if (error instanceof StoryError && error.message === 'unknown vertical') throw new LabError('unknown_vertical', 'Unknown vertical', 404);
      throw error;
    }
  }));
  // A POST (same-origin, JSON) because it calls PingFederate: a cross-site GET must never cause an outbound call.
  app.post('/api/pf/discovery', wrap(() => discoveryCheck(pf)));

  // Sign-in: pi.flow only. Tokens stay in the session; /api/me shows them masked, with claims.
  // Signed in only with a verified identity; the session id is rotated so a planted id cannot ride the sign-in.
  const signedIn = (req, res, result) => {
    if (result.outcome === 'accepted' && result.identity?.subject) {
      req.session.user = { ...result.identity, signedInAt: new Date(now()).toISOString() };
      sessions.rotate(req.session, res);
    }
    return result;
  };
  app.post('/api/signin/start', wrap(async (req, res) => signedIn(req, res, await piflow.start(req.session, 'signin', { loginHint: req.body?.loginHint }))));
  app.post('/api/signin/credentials', wrap(async (req, res) => signedIn(req, res, await piflow.submitCredentials(req.session, 'signin', req.body || {}))));
  app.post('/api/signout', wrap((req, res) => {
    // The cookie goes with the last workspace; the browser's other workspaces keep theirs.
    if (sessions.destroy(req.session)) res.append('Set-Cookie', 'pflab_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return { signedIn: false };
  }));
  app.get('/api/me', wrap((req) => {
    const tokens = req.session.tokens.signin;
    return req.session.user
      ? { signedIn: true, user: req.session.user, accessToken: tokenView(tokens?.accessToken), idToken: tokenView(tokens?.idToken), tokenType: tokens?.tokenType || null }
      : { signedIn: false };
  }));

  app.post('/api/cards/piflow/open', wrap(() => piflow.openAndRead()));

  // 'discard' (the Playground's Clear): in mock mode it deletes the clients a half-finished run left; on a real PingFederate it does nothing.
  const dcrSteps = { 'initial-token': dcr.initialToken, register: dcr.register, use: dcr.use, delete: dcr.remove, discard: (session) => (mode() === 'mock' ? dcr.discard(session) : { deleted: [] }) };
  app.post('/api/cards/dcr/:step', wrap((req) => {
    const fn = Object.hasOwn(dcrSteps, req.params.step) ? dcrSteps[req.params.step] : null;
    if (!fn) throw new LabError('unknown_step', 'Unknown DCR step', 404);
    return fn(req.session);
  }));

  app.post('/api/cards/ciba/start', wrap((req) => ciba.start(req.session, req.body || {})));
  app.post('/api/cards/ciba/poll', wrap((req) => ciba.poll(req.session)));
  app.post('/api/cards/ciba/decision', wrap((req) => ciba.decide(req.session, req.body?.decision)));

  app.post('/api/cards/userinfo/read', wrap((req) => userinfo.read(req.session)));
  app.post('/api/cards/token-exchange/agent', wrap((req) => exchange.agentHop(req.session)));
  app.post('/api/cards/token-exchange/mcp', wrap((req) => exchange.mcpHop(req.session)));

  // Authorization-code cards on the pi.flow engine (registered after the named cards above, so they never shadow them).
  app.post('/api/cards/:card/start', wrap(async (req) => {
    const card = req.params.card;
    if (!FLOW_CARDS.has(card)) throw new LabError('unknown_card', 'Unknown card', 404);
    const body = req.body || {};
    const loginHint = body.loginHint;
    if (card === 'pkce') return piflow.start(req.session, 'pkce', { loginHint });
    if (card === 'par') return piflow.start(req.session, 'par', { par: true, loginHint });
    if (card === 'dpop') return piflow.start(req.session, 'dpop', { dpop: true, loginHint });
    // The user and accounts: typed on the card, else the signed-in user and the accounts saved in Settings.
    const detail = buildAuthorizationDetail({
      amount: body.amount, currency: body.currency,
      userId: (typeof body.userId === 'string' && body.userId.trim()) || req.session.user?.subject || (mode() === 'mock' ? MOCK_USER.username : undefined),
      sourceAccount: (typeof body.sourceAccount === 'string' && body.sourceAccount.trim()) || settings.value('rar', 'sourceAccount'),
      destinationAccount: (typeof body.destinationAccount === 'string' && body.destinationAccount.trim()) || settings.value('rar', 'destinationAccount'),
    });
    // The transaction's user is also who PingFederate should sign in.
    return piflow.start(req.session, 'rar', { configKey: body.dpop === true ? 'rarDpop' : 'rar', par: true, authorizationDetails: [detail], dpop: body.dpop === true, loginHint: detail.user_id });
  }));
  app.post('/api/cards/:card/credentials', wrap((req) => {
    if (!FLOW_CARDS.has(req.params.card)) throw new LabError('unknown_card', 'Unknown card', 404);
    return piflow.submitCredentials(req.session, req.params.card, req.body || {});
  }));
  app.get('/api/cards/:card/result', wrap((req) => {
    const card = req.params.card;
    if (!FLOW_CARDS.has(card) && card !== 'signin') throw new LabError('unknown_card', 'Unknown card', 404);
    return req.session.results[card] || { card, state: req.session.runs[card] ? 'running' : 'none' };
  }));

  // Reset clears this session's card runs, results and tokens; the sign-in and the settings stay.
  // In mock mode the clients a half-finished DCR run left on the in-process mock go first; Reset then has none to list.
  app.post('/api/reset', wrap(async (req) => {
    if (mode() === 'mock') await dcr.discard(req.session);
    return { ok: true, workspace: req.session.workspace, ...sessions.reset(req.session) };
  }));

  // Workspaces (rule 13): the page sends its workspace in X-Lab-Workspace (default "default"). Sessions, runs, results,
  // tokens and trace belong to one workspace; Reset clears the current one only.
  app.get('/api/workspaces', wrap((req) => ({ current: req.session.workspace, default: DEFAULT_WORKSPACE, workspaces: sessions.workspacesOf(req.session.id, req.session.workspace) })));

  // The header "Shelf" button. Always mounted (not only when a web build exists), and before the web fallback.
  app.get('/api/shelf', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json(shelfInfo()); }); // the header "Shelf" button
  // The built web UI, when it exists. Registered last so it never shadows an API route.
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: 'index.html' }));
    app.get(/^\/(?!api(\/|$)).*/, (req, res) => res.sendFile(path.join(webDist, 'index.html')));
  }

  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  app.use(errorHandler);
  return app;
}
