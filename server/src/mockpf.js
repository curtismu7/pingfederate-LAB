// The lab's mock PingFederate: an in-process authorization server that answers every endpoint the cards and the
// Playground use (discovery, JWKS, pi.flow, token, PAR, RAR, DPoP, CIBA, DCR, token exchange, userinfo). Mock mode
// reaches it through the netguard instead of fetch, so no socket is ever opened. The tests use it too (as the
// "fake"): it records every call and remembers every secret it hands out, so tests can prove none reaches the page.
// The demo user below exists only inside this mock; it is not a credential anywhere else.
import crypto from 'node:crypto';
import { createEcKey, signEs256, s256, jwkThumbprint } from './jose.js';

export const MOCK_ORIGIN = 'https://pingfederate.mock.invalid';
export const USER = { username: 'alice', password: 'correct-horse-battery', sub: 'alice' };

const rand = (n = 18) => crypto.randomBytes(n).toString('base64url');
const json = (status, body, extra = {}) => {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  for (const [k, v] of Object.entries(extra)) {
    if (k === 'set-cookie') for (const c of [].concat(v)) headers.append('set-cookie', c);
    else headers.set(k, v);
  }
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
};
const html = (status, text) => new Response(`<html><body><h1>${text}</h1></body></html>`, { status, headers: { 'Content-Type': 'text/html' } });

function cookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

function decodeJwt(token) {
  const [h, p] = String(token).split('.');
  return { header: JSON.parse(Buffer.from(h, 'base64url')), payload: JSON.parse(Buffer.from(p, 'base64url')) };
}

function verifyDpop(proof, { htu, htm, nonce }) {
  try {
    const [h, p, s] = proof.split('.');
    const { header, payload } = decodeJwt(proof);
    if (header.typ !== 'dpop+jwt' || header.alg !== 'ES256') return null;
    const key = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
    if (!crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) return null;
    if (payload.htu !== htu || payload.htm !== htm || !payload.jti) return null;
    if (nonce && payload.nonce !== nonce) return { needNonce: true };
    return { jkt: jwkThumbprint(header.jwk) };
  } catch { return null; }
}

// options: origin, clients (id -> { secret, dpop, scopes }), dpopNonce, flatAct, cibaPolls, cibaDecision, cibaStatus
// (transactionId -> 'pending'|'approved'|'denied', replaces cibaPolls/cibaDecision), onBackchannel, openRegistration,
// parLimit, discovery (overrides), keepDeletedClient
export function createMockPf(options = {}) {
  const key = createEcKey();
  const kid = 'fake-1';
  const origin = options.origin || MOCK_ORIGIN;
  const issuer = options.issuer || origin;
  const calls = [];
  const secrets = new Set([USER.password]);
  const remember = (value) => { secrets.add(value); return value; };
  const clients = new Map(Object.entries(options.clients || {}));
  for (const c of clients.values()) if (c.secret) secrets.add(c.secret);
  const flows = new Map();
  const codes = new Map();
  const pushed = new Map();
  const cibas = new Map();
  const tokens = new Map(); // token -> claims
  const iats = new Set();
  const registered = new Map(); // client_id -> rat
  let ssoCookie = null;
  const dpopNonce = options.dpopNonce ? 'nonce-from-pf' : null;

  const sign = (payload, typ = 'JWT') => remember(signEs256({ alg: 'ES256', kid, typ }, payload, key.privateKey));
  const now = () => Math.floor(Date.now() / 1000);
  const accessToken = (claims) => { const t = sign({ iss: issuer, iat: now(), exp: now() + 300, jti: rand(), ...claims }); tokens.set(t, claims); return t; };

  const discovery = {
    issuer,
    authorization_endpoint: `${origin}/as/authorization.oauth2`,
    token_endpoint: `${origin}/as/token.oauth2`,
    jwks_uri: `${origin}/pf/JWKS`,
    pushed_authorization_request_endpoint: `${origin}/as/par.oauth2`,
    backchannel_authentication_endpoint: `${origin}/as/bc-auth.ciba`,
    registration_endpoint: `${origin}/as/clients.oauth2`,
    userinfo_endpoint: `${origin}/idp/userinfo.openid`,
    grant_types_supported: ['authorization_code', 'client_credentials', 'urn:ietf:params:oauth:grant-type:token-exchange', 'urn:openid:params:grant-type:ciba'],
    code_challenge_methods_supported: ['plain', 'S256'],
    authorization_details_types_supported: ['banking_transaction'],
    dpop_signing_alg_values_supported: ['ES256'],
    backchannel_token_delivery_modes_supported: ['poll'],
    ...(options.discovery || {}),
  };

  function clientAuth(req, form) {
    const auth = req.headers.get('authorization') || '';
    let id = form.get('client_id');
    let secret = null;
    if (auth.startsWith('Basic ')) {
      const [a, b] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      id = decodeURIComponent(a); secret = decodeURIComponent(b);
    }
    const client = clients.get(id);
    if (!client) return null;
    if (client.secret && client.secret !== secret) return null;
    return { id, ...client };
  }

  function flowDoc(flow) {
    if (flow.status === 'COMPLETED') return { id: flow.id, status: 'COMPLETED', authorizeResponse: { code: flow.code, state: options.wrongState ? 'not-your-state' : flow.params.state } };
    if (flow.status === 'MFA_COMPLETED') return { id: flow.id, status: 'MFA_COMPLETED', _links: { continueAuthentication: { href: 'x' } } };
    return { id: flow.id, status: flow.status, _links: { self: { href: 'x' }, checkUsernamePassword: { href: 'x' } } };
  }

  function issueCode(params, sub) {
    const code = remember(rand());
    codes.set(code, { params, sub });
    return code;
  }

  async function authorize(url, req) {
    let params = Object.fromEntries(url.searchParams);
    if (params.request_uri) {
      const p = pushed.get(params.request_uri);
      if (!p || p.client_id !== params.client_id) return html(400, '400 - Invalid request_uri');
      pushed.delete(params.request_uri);
      params = { ...p, response_mode: url.searchParams.get('response_mode') || p.response_mode };
    }
    const client = clients.get(params.client_id);
    if (options.authorizeBody) return new Response(options.authorizeBody, { status: 400, headers: { 'Content-Type': 'text/html' } });
    if (!client) return html(400, '400 - Invalid client_id');
    if (params.response_mode !== 'pi.flow' || !/json/.test(req.headers.get('accept') || '')) return html(200, 'Login page');
    const jar = cookies(req.headers.get('cookie'));
    const id = rand(12);
    const flow = { id, params, cookie: rand(), status: 'USERNAME_PASSWORD_REQUIRED' };
    remember(flow.cookie); remember(id);
    if (ssoCookie && jar.PF === ssoCookie) {
      flow.status = 'COMPLETED';
      flow.code = issueCode(params, USER.sub);
    }
    flows.set(id, flow);
    return json(200, flowDoc(flow), { 'set-cookie': [`PF.FLOW=${flow.cookie}; Path=/; Secure; HttpOnly`] });
  }

  async function flowStep(url, req, id) {
    const flow = flows.get(id);
    if (!flow) return json(404, { code: 'RESOURCE_NOT_FOUND' });
    if (req.headers.get('x-xsrf-header') !== 'PingFederate') return json(403, { code: 'CSRF' });
    if (cookies(req.headers.get('cookie'))['PF.FLOW'] !== flow.cookie) return json(400, { code: 'SESSION_MISMATCH' });
    if (req.method === 'GET') return json(200, flowDoc(flow));
    if (req.headers.get('content-type') === 'application/vnd.pingidentity.continueAuthentication+json' && flow.status === 'MFA_COMPLETED') return json(200, flowDoc(flow));
    if (req.headers.get('content-type') !== 'application/vnd.pingidentity.checkUsernamePassword+json') return json(400, { code: 'INVALID_CONTENT_TYPE' });
    const body = JSON.parse(await req.text());
    if (body.username !== USER.username || body.password !== USER.password) {
      return json(400, { id: flow.id, code: 'VALIDATION_ERROR', message: 'Invalid credentials', details: [{ code: 'CREDENTIAL_VALIDATION_FAILED', target: `${origin}/pf-ws/authn/flows/${flow.id}` }],
        _links: { self: { href: `${origin}/pf-ws/authn/flows/${flow.id}` } } });
    }
    if (options.mfaLoop) { flow.status = 'MFA_COMPLETED'; return json(200, flowDoc(flow)); }
    flow.status = 'COMPLETED';
    flow.code = issueCode(flow.params, USER.sub);
    ssoCookie = remember(rand());
    return json(200, flowDoc(flow), { 'set-cookie': [`PF=${ssoCookie}; Path=/; Secure; HttpOnly`] });
  }

  async function token(url, req) {
    const form = new URLSearchParams(await req.text());
    const client = clientAuth(req, form);
    if (!client) return json(401, { error: 'invalid_client' });
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') {
      const entry = codes.get(form.get('code'));
      if (!entry || entry.params.client_id !== client.id) return json(400, { error: 'invalid_grant' });
      remember(form.get('code_verifier'));
      if (s256(form.get('code_verifier') || '') !== entry.params.code_challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE' });
      if (form.get('redirect_uri') !== entry.params.redirect_uri) return json(400, { error: 'invalid_grant' });
      let jkt = null;
      if (client.dpop) {
        const proof = req.headers.get('dpop');
        if (!proof) return json(400, { error: 'invalid_dpop_proof' });
        remember(proof);
        const checked = verifyDpop(proof, { htu: `${origin}/as/token.oauth2`, htm: 'POST', nonce: dpopNonce });
        if (checked?.needNonce) return json(400, { error: 'use_dpop_nonce' }, { 'DPoP-Nonce': dpopNonce });
        if (!checked) return json(400, { error: 'invalid_dpop_proof' });
        jkt = checked.jkt;
      }
      codes.delete(form.get('code'));
      const details = entry.params.authorization_details ? JSON.parse(entry.params.authorization_details) : undefined;
      const at = accessToken({ sub: entry.sub, client_id: client.id, scope: entry.params.scope, ...(jkt ? { cnf: { jkt } } : {}), ...(details ? { authorization_details: details } : {}) });
      const idt = sign({ iss: issuer, sub: entry.sub, aud: client.id, nonce: entry.params.nonce, iat: now(), exp: now() + 300, ...(options.idTokenClaims || {}) });
      const refresh = remember(rand());
      return json(200, { access_token: at, id_token: idt, refresh_token: refresh, token_type: jkt ? 'DPoP' : 'Bearer', expires_in: 300, scope: entry.params.scope, ...(details ? { authorization_details: details } : {}) });
    }
    if (grant === 'client_credentials') {
      const scope = form.get('scope') || '';
      const allowed = new Set(client.scopes || []);
      if (!scope.split(' ').every((s) => allowed.has(s))) return json(400, { error: 'invalid_scope' });
      const at = accessToken({ client_id: client.id, sub: client.id, scope });
      if (scope === 'dcr:register') iats.add(at);
      return json(200, { access_token: at, token_type: 'Bearer', expires_in: 300 });
    }
    if (grant === 'urn:ietf:params:oauth:grant-type:token-exchange') {
      const subject = tokens.get(form.get('subject_token'));
      const actor = tokens.get(form.get('actor_token'));
      if (!subject || !actor) return json(400, { error: 'invalid_request' });
      const act = options.flatAct ? { sub: actor.client_id } : { sub: actor.client_id, ...(subject.act ? { act: subject.act } : {}) };
      const at = accessToken({ sub: subject.sub, client_id: client.id, scope: form.get('scope'), act, aud: options.exchangeAud || 'resource' });
      return json(200, { access_token: at, issued_token_type: 'urn:ietf:params:oauth:token-type:access_token', token_type: 'Bearer', expires_in: 300 });
    }
    if (grant === 'urn:openid:params:grant-type:ciba') {
      const ciba = cibas.get(form.get('auth_req_id'));
      if (!ciba || ciba.client !== client.id) return json(400, { error: 'invalid_grant' });
      ciba.polls += 1;
      if (options.cibaStatus) {
        const status = await options.cibaStatus(ciba.transactionId);
        if (status === 'denied') return json(400, { error: 'access_denied' });
        if (status !== 'approved') return json(400, { error: 'authorization_pending' });
      } else {
        if (ciba.polls < (options.cibaPolls ?? 2)) return json(400, { error: 'authorization_pending' });
        if ((options.cibaDecision || 'approved') === 'denied') return json(400, { error: 'access_denied' });
      }
      const at = accessToken({ sub: ciba.hint, client_id: client.id, scope: ciba.scope });
      const idt = sign({ iss: issuer, sub: ciba.hint, aud: client.id, iat: now(), exp: now() + 300 });
      return json(200, { access_token: at, id_token: idt, token_type: 'Bearer', expires_in: 300, scope: ciba.scope });
    }
    return json(400, { error: 'unsupported_grant_type' });
  }

  async function par(url, req) {
    const form = new URLSearchParams(await req.text());
    const client = clientAuth(req, form);
    if (!client) return json(401, { error: 'invalid_client' });
    const params = Object.fromEntries(form);
    if (params.authorization_details) {
      // The same shape rules as the demo banking_transaction processor on a real PingFederate.
      const details = JSON.parse(params.authorization_details);
      const FIELDS = 'actions,amount,currency,destination_account,source_account,type,user_id';
      const refuse = (why) => json(400, { error: 'invalid_authorization_details', error_description: why });
      for (const d of details) {
        if (d.type !== 'banking_transaction') return refuse('unsupported authorization detail type');
        if (Object.keys(d).sort().join(',') !== FIELDS) return refuse('authorization detail contains missing or unsupported fields');
        if (!String(params.scope || '').split(' ').includes('transactions:write')) return refuse('transactions:write scope is required');
        if (d.amount > (options.parLimit ?? 5000)) return refuse('transaction amount exceeds the user limit');
      }
    }
    const uri = `urn:ietf:params:oauth:request_uri:${rand()}`;
    pushed.set(uri, { ...params, client_id: client.id });
    return json(201, { request_uri: uri, expires_in: 60 });
  }

  async function backchannel(url, req) {
    const form = new URLSearchParams(await req.text());
    const client = clientAuth(req, form);
    if (!client) return json(401, { error: 'invalid_client' });
    if (form.get('login_hint') !== USER.username) return json(400, { error: 'unknown_user_id' });
    const id = remember(rand());
    const transactionId = crypto.randomUUID();
    cibas.set(id, { client: client.id, hint: form.get('login_hint'), scope: form.get('scope'), polls: 0, transactionId });
    // Like PingFederate's out-of-band authenticator: it contacts the approval channel before answering the client.
    if (options.onBackchannel) await options.onBackchannel({ hint: form.get('login_hint'), bindingMessage: form.get('binding_message'), transactionId });
    return json(200, { auth_req_id: id, expires_in: 120, interval: 1 });
  }

  async function registration(url, req, clientId) {
    const bearer = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!clientId && req.method === 'POST') {
      if (!options.openRegistration && !iats.has(bearer)) return json(401, { error: 'invalid_token' });
      if (options.registerFailWithToken && iats.has(bearer)) return json(400, { error: 'invalid_client_metadata' });
      const doc = JSON.parse(await req.text());
      const id = `dcr-${rand(6)}`;
      const secret = remember(rand());
      const rat = remember(rand());
      clients.set(id, { secret, scopes: String(doc.scope || '').split(' ') });
      registered.set(id, rat);
      return json(201, { ...doc, client_id: id, client_secret: secret, registration_access_token: rat, registration_client_uri: `${origin}/as/clients.oauth2/${id}` });
    }
    if (!clientId || registered.get(clientId) !== bearer) return json(401, { error: 'invalid_token' });
    if (req.method === 'DELETE') {
      if (!options.keepDeletedClient) { clients.delete(clientId); registered.delete(clientId); }
      return json(204);
    }
    if (req.method === 'GET') return json(200, { client_id: clientId });
    return json(405, {});
  }

  async function fetchImpl(input, init = {}) {
    const url = new URL(input);
    const req = new Request(url, { method: init.method || 'GET', headers: init.headers, body: init.body });
    calls.push({ origin: url.origin, path: url.pathname, method: req.method, headers: Object.fromEntries(req.headers), redirect: init.redirect });
    if (url.origin !== origin) throw new Error(`mock PingFederate got a call for ${url.origin}`);
    const p = url.pathname;
    if (p === '/.well-known/openid-configuration') return json(200, discovery);
    if (p === '/idp/userinfo.openid') {
      const bearer = /^Bearer (.+)$/.exec(req.headers.get('authorization') || '')?.[1];
      const claims = bearer ? tokens.get(bearer) : null;
      if (!claims?.sub) return json(401, { error: 'invalid_token', error_description: 'Access token is invalid or expired' });
      return json(200, { sub: claims.sub, name: 'Alice Example', given_name: 'Alice', family_name: 'Example', preferred_username: claims.sub, email: 'alice@example.invalid', ...(options.userinfoClaims || {}) });
    }
    if (p === '/pf/JWKS') return json(200, { keys: [{ ...key.publicJwk, kid, use: 'sig', alg: 'ES256' }] });
    if (p === '/as/authorization.oauth2') return authorize(url, req);
    if (p.startsWith('/pf-ws/authn/flows/')) return flowStep(url, req, p.split('/').pop());
    if (p === '/as/token.oauth2') return token(url, req);
    if (p === '/as/par.oauth2') return par(url, req);
    if (p === '/as/bc-auth.ciba') return backchannel(url, req);
    if (p === '/as/clients.oauth2') return registration(url, req, null);
    if (p.startsWith('/as/clients.oauth2/')) return registration(url, req, decodeURIComponent(p.split('/').pop()));
    return html(404, 'Not found');
  }

  // forgetFlows: what a PingFederate restart (or flow expiry) does to pi.flow flows in progress.
  return { fetchImpl, calls, secrets, clients, decodeJwt, registered, origin, forgetFlows: () => flows.clear() };
}
