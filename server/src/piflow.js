import crypto from 'node:crypto';
import { pkce as newPkce, createEcKey } from './jose.js';
import { LabError, hop } from './pf.js';
import { newTraceId, tokenView, claimsOf, step } from './trace.js';

// Authorization-code runs driven through PingFederate's Authentication API (pi.flow), never a browser redirect:
// the authorization request carries response_mode=pi.flow, PingFederate answers with a JSON flow (status +
// _links), the lab's own form posts the username and password to /pf-ws/authn/flows/{id}, and a COMPLETED flow
// carries the code inline (authorizeResponse). The code is redeemed with PKCE, server-side; tokens stay in the
// server-side session. Sign-in, PKCE, PAR, RAR and DPoP all run on this engine.

export const FLOW_ID = /^[A-Za-z0-9_-]{6,128}$/;
export const PIFLOW_JSON = 'application/json';
export const CHECK_USERNAME_PASSWORD = 'application/vnd.pingidentity.checkUsernamePassword+json';
export const CONTINUE_AUTHENTICATION = 'application/vnd.pingidentity.continueAuthentication+json';
const RUN_TTL_MS = 5 * 60 * 1000;
const REQUEST_URI_PREFIX = 'urn:ietf:params:oauth:request_uri:';
const MAX_COOKIES = 30;
const CONTROL = /[\u0000-\u001f\u007f]/;

// PingFederate ties a flow to its session cookies, so every step replays the jar and merges what comes back.
export function mergeCookies(jar, setCookies) {
  const next = { ...jar };
  for (const line of setCookies || []) {
    const [pair] = String(line).split(';');
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name) || value.length > 4096 || CONTROL.test(value)) continue;
    if (!Object.hasOwn(next, name) && Object.keys(next).length >= MAX_COOKIES) continue;
    next[name] = value;
  }
  return next;
}
export const cookieHeader = (jar) => Object.entries(jar || {}).map(([k, v]) => `${k}=${v}`).join('; ');

// What a client renders from: status, offered actions, embedded objects. Never the flow id (a bearer handle).
export function flowView(flow) {
  return {
    status: typeof flow?.status === 'string' ? flow.status : null,
    actions: Object.keys(flow?._links || {}).filter((name) => name !== 'self'),
    ...(flow?._embedded ? { embedded: Object.keys(flow._embedded) } : {}),
    ...(typeof flow?.usernameHint === 'string' ? { usernameHint: flow.usernameHint } : {}),
  };
}

export const EXCERPT_INPUT_MAX = 8 * 1024;

// PingFederate answers a refused authorization request as an HTML page ("400 - Invalid ..."): show its words.
// Linear: the input is cut to 8 KB first, then one pass drops <script>/<style> blocks and tags (indexOf only,
// no backtracking regex), and the remaining regexes have no nested or overlapping quantifiers.
export function htmlExcerpt(text) {
  const input = String(text || '').slice(0, EXCERPT_INPUT_MAX);
  const lower = input.toLowerCase();
  let out = '';
  let i = 0;
  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) { out += input.slice(i); break; }
    out += `${input.slice(i, lt)} `;
    let skipTo = -1;
    for (const block of ['script', 'style']) {
      if (lower.startsWith(`<${block}`, lt)) {
        const close = lower.indexOf(`</${block}`, lt);
        const end = close === -1 ? -1 : lower.indexOf('>', close);
        skipTo = end === -1 ? input.length : end + 1;
      }
    }
    if (skipTo === -1) {
      const gt = input.indexOf('>', lt);
      skipTo = gt === -1 ? input.length : gt + 1;
    }
    i = skipTo;
  }
  return out.replace(/&#?[a-z0-9]{1,10};/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

// The JSON PingFederate returned, as it came, for the trace. Masked: the flow id wherever it appears (it is a
// bearer handle to the sign-in, also inside _links hrefs), an authorization code, and any token, secret or password
// value. Bounded: depth 12, 50 items per array, 2000 characters per string.
const MASKED_KEY = /token|secret|password|assertion/i;
export function rawFlowBody(json, flowId = null) {
  if (!json || typeof json !== 'object') return null;
  const id = typeof flowId === 'string' && flowId ? flowId : (typeof json.id === 'string' ? json.id : null);
  const walk = (v, depth, key, parent) => {
    if (typeof v === 'string') {
      if (MASKED_KEY.test(key) || (key === 'code' && parent === 'authorizeResponse')) return '<redacted>';
      const s = id ? v.split(id).join('<flow id>') : v;
      return s.length > 2000 ? `${s.slice(0, 2000)}...` : s;
    }
    if (!v || typeof v !== 'object') return v;
    if (depth >= 12) return '...';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => walk(x, depth + 1, key, parent));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, depth + 1, k, key)]));
  };
  return walk(json, 0, '', '');
}

export const MAX_FLOW_STEPS = 5;

const hasOpenid = (scope) => /(^| )openid( |$)/.test(String(scope || ''));
const flowUrl = (metadata, flowId) => `${metadata.pfOrigin}/pf-ws/authn/flows/${flowId}`;
// The flow id is a bearer handle to the sign-in; it never appears in a trace.
const shownFlowUrl = (metadata) => `${metadata.pfOrigin}/pf-ws/authn/flows/<flow id>`;

export function createPiFlow({ pf, settings, now = Date.now }) {
  const redirectUri = () => settings.value('pf', 'redirectUri');

  async function openFlow({ metadata, authorizeUrl, jar, traceId, title }) {
    const headers = { Accept: PIFLOW_JSON, ...(Object.keys(jar).length ? { Cookie: cookieHeader(jar) } : {}) };
    const result = await pf.call(authorizeUrl, { headers, traceId });
    const nextJar = mergeCookies(jar, result.setCookies);
    const flow = result.json;
    const opened = result.ok && FLOW_ID.test(String(flow?.id || ''));
    const s = hop({
      id: 'authorize',
      title,
      method: 'GET',
      url: authorizeUrl,
      headers: { ...headers, ...(headers.Cookie ? { Cookie: 'x' } : {}) },
      params: new URL(authorizeUrl).searchParams,
      result: { ...result, json: rawFlowBody(result.json) },
      note: opened
        ? 'response_mode=pi.flow: PingFederate answers with JSON. The client renders the form named by status and posts to one of the actions.'
        : (result.json ? null : `PingFederate did not open a flow. Page text: ${htmlExcerpt(result.text) || '(empty)'}`),
    });
    return { result, flow: opened ? flow : null, jar: nextJar, step: s };
  }

  async function postStep({ metadata, run, contentType, payload, shownPayload, title, id }) {
    const url = flowUrl(metadata, run.flowId);
    const headers = { 'Content-Type': contentType, Accept: PIFLOW_JSON, 'X-XSRF-Header': 'PingFederate', Cookie: cookieHeader(run.jar) };
    const result = await pf.call(url, { method: 'POST', headers, body: JSON.stringify(payload), traceId: run.traceId });
    run.jar = mergeCookies(run.jar, result.setCookies);
    const s = hop({
      id, title, method: 'POST', url: shownFlowUrl(metadata),
      headers: { ...headers, Cookie: 'x' },
      json: shownPayload,
      result: { ...result, json: rawFlowBody(result.json, run.flowId) },
    });
    run.trace.push(s);
    return result;
  }

  function clientFor(card) {
    const section = card === 'rarDpop' ? 'rarDpop' : card;
    const c = settings.section(section);
    const scope = c.scope || settings.value('rar', 'scope') || 'openid profile';
    return { clientId: c.clientId, clientSecret: c.clientSecret, scope };
  }

  // Begin a run. opts: { par, authorizationDetails, dpop, loginHint }. Returns the run's public state.
  async function start(session, card, { configKey = card, par = false, authorizationDetails = null, dpop = false, loginHint = null } = {}) {
    if (!settings.ready(configKey)) throw new LabError('not_configured', `Settings for ${card} are incomplete`, 409);
    // A sign-in must prove who signed in: openid in the scope, and a verified ID token at the end.
    if (card === 'signin' && !hasOpenid(settings.value('signin', 'scope'))) throw new LabError('signin_needs_openid', 'The sign-in scope must include openid', 409);
    // login_hint names the user PingFederate should sign in; it comes back as the username the form starts with.
    const hint = typeof loginHint === 'string' ? loginHint.trim() : '';
    if (hint.length > 256 || CONTROL.test(hint)) throw new LabError('bad_login_hint', 'The user (login_hint) must be at most 256 characters', 400);
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step: discoveryStep } = await pf.discover({ traceId });
    if (discoveryStep) trace.push(discoveryStep);
    const client = clientFor(configKey);
    const codes = newPkce();
    const state = crypto.randomBytes(24).toString('base64url');
    const nonce = crypto.randomBytes(24).toString('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: client.clientId,
      redirect_uri: redirectUri(),
      scope: client.scope,
      state,
      nonce,
      code_challenge: codes.challenge,
      code_challenge_method: codes.method,
      response_mode: 'pi.flow',
    });
    if (authorizationDetails) params.set('authorization_details', JSON.stringify(authorizationDetails));
    if (hint) params.set('login_hint', hint);
        // PingFederate's session cookies are reused only with the PingFederate that set them.
    const jar = session.pfCookiesFor === metadata.issuer ? { ...(session.pfCookies || {}) } : {};
    const run = { card, traceId, trace, client, codes, state, nonce, metadata, jar,
      dpopKey: dpop ? createEcKey() : null, expiresAt: now() + RUN_TTL_MS, status: null, loginHint: hint || null };

    let authorizeUrl;
    if (par) {
      if (!metadata.parEndpoint) throw new LabError('par_not_supported', 'PingFederate does not advertise a PAR endpoint', 409, { trace });
      const { result, body, headers } = await pf.formPost({ url: metadata.parEndpoint, clientId: client.clientId, clientSecret: client.clientSecret, params, traceId });
      trace.push(hop({ id: 'par', title: 'Push the authorization request (PAR)', method: 'POST', url: metadata.parEndpoint, headers, params: body, result,
        note: result.ok ? 'PingFederate kept the request and returned a one-time handle (request_uri).' : null }));
      if (!result.ok) {
        const error = result.json?.error;
        // A refusal of the authorization details (RFC 9396) is an answer, not a failure.
        if (error === 'invalid_authorization_details' || error === 'invalid_request' || error === 'unauthorized_client' || error === 'invalid_scope') {
          return finishRun(session, run, { outcome: 'refused', reason: error });
        }
        throw new LabError('par_failed', `PingFederate refused the pushed request (HTTP ${result.status})`, 502, { trace });
      }
      const requestUri = result.json?.request_uri;
      const expiresIn = result.json?.expires_in;
      if (typeof requestUri !== 'string' || !requestUri.startsWith(REQUEST_URI_PREFIX) || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > 3600) {
        throw new LabError('par_response_invalid', 'PingFederate PAR answer has no valid request_uri', 502, { trace });
      }
      const url = new URL(metadata.authorizationEndpoint);
      url.searchParams.set('client_id', client.clientId);
      url.searchParams.set('request_uri', requestUri);
      // UNVERIFIED against a live PingFederate: response_mode is sent in the pushed request and repeated here,
      // so the authorization endpoint answers with a pi.flow document rather than a login page.
      url.searchParams.set('response_mode', 'pi.flow');
      authorizeUrl = url.toString();
    } else {
      const url = new URL(metadata.authorizationEndpoint);
      for (const [k, v] of params) url.searchParams.set(k, v);
      authorizeUrl = url.toString();
    }

    const opened = await openFlow({ metadata, authorizeUrl, jar: run.jar, traceId, title: par ? 'Open the flow with the request_uri' : 'Open a pi.flow authorization request' });
    trace.push(opened.step);
    run.jar = opened.jar;
    if (!opened.flow) {
      if (opened.result.status === 400 || opened.result.json?.error) return finishRun(session, run, { outcome: 'refused', reason: opened.result.json?.error || `http_${opened.result.status}` });
      throw new LabError('piflow_not_opened', `PingFederate did not open a pi.flow (HTTP ${opened.result.status}). The client needs "Allow Authentication API OAuth initiation".`, 502, { trace });
    }
    run.flowId = opened.flow.id;
    return advance(session, run, opened.flow);
  }

  // Moves a run on from a flow document: done, waiting for credentials, or stopped at a status this lab does not drive.
  async function advance(session, run, flow) {
    run.status = flow.status;
    run.steps = (run.steps || 0) + 1;
    if (run.steps > MAX_FLOW_STEPS) return finishRun(session, run, { outcome: 'failed', reason: 'too_many_steps' });
    if (flow.status === 'COMPLETED') return complete(session, run, flow);
    if (flow.status === 'MFA_COMPLETED') {
      const next = await postStep({ metadata: run.metadata, run, contentType: CONTINUE_AUTHENTICATION, payload: {}, shownPayload: {}, title: 'Continue after MFA', id: 'continue' });
      if (!next.ok || !next.json) return finishRun(session, run, { outcome: 'failed', reason: `http_${next.status}` });
      return advance(session, run, next.json);
    }
    session.runs[run.card] = run;
    return publicRun(run, { state: flow.status === 'USERNAME_PASSWORD_REQUIRED' ? 'credentials_required' : 'stopped', ...flowView(flow) });
  }

  async function submitCredentials(session, card, { username, password } = {}) {
    const run = session.runs[card];
    if (!run || run.expiresAt <= now() || !run.flowId) throw new LabError('no_run', 'Start this card first (a run expires after 5 minutes)', 409);
    if (run.status !== 'USERNAME_PASSWORD_REQUIRED') throw new LabError('wrong_status', `The flow is at ${run.status}, not waiting for a password`, 409);
    if (typeof username !== 'string' || !username || username.length > 256 || CONTROL.test(username)) throw new LabError('bad_username', 'Username must be 1 to 256 characters', 400);
    if (typeof password !== 'string' || !password || password.length > 1024) throw new LabError('bad_password', 'Password must be 1 to 1024 characters', 400);
    const result = await postStep({
      metadata: run.metadata, run, contentType: CHECK_USERNAME_PASSWORD,
      payload: { username, password }, shownPayload: { username, password: '<redacted>' },
      title: 'Post the username and password (checkUsernamePassword)', id: 'credentials',
    });
    if (!result.ok) {
      const codes = Array.isArray(result.json?.details) ? result.json.details.map((d) => d?.code) : [];
      if (result.status === 400 && codes.includes('CREDENTIAL_VALIDATION_FAILED')) {
        return publicRun(run, { state: 'credentials_required', refused: 'credential_validation_failed', status: run.status });
      }
      // PingFederate no longer knows the flow: it expired, or PingFederate restarted while the run waited.
      if (result.status === 404) return finishRun(session, run, { outcome: 'failed', reason: 'flow_gone' });
      return finishRun(session, run, { outcome: 'failed', reason: result.json?.code || `http_${result.status}` });
    }
    if (!result.json) return finishRun(session, run, { outcome: 'failed', reason: 'not_json' });
    return advance(session, run, result.json);
  }

  async function complete(session, run, flow) {
    session.pfCookies = run.jar; // the PingFederate session now belongs to this lab session (SSO for later runs)
    session.pfCookiesFor = run.metadata.issuer;
    const answer = flow.authorizeResponse || {};
    if (answer.state !== undefined && answer.state !== run.state) return finishRun(session, run, { outcome: 'failed', reason: 'state_mismatch' });
    if (answer.error) return finishRun(session, run, { outcome: 'refused', reason: String(answer.error).slice(0, 64) });
    if (typeof answer.code !== 'string' || !answer.code) return finishRun(session, run, { outcome: 'failed', reason: 'no_code' });
    run.trace.push(step({ id: 'code', title: 'The completed flow carries the authorization code', response: { body: { status: 'COMPLETED', authorizeResponse: { code: '<redacted>', state: '<matches>' } } },
      note: 'No browser redirect: PingFederate returns the authorization response inside the flow document.' }));
    const params = new URLSearchParams({ grant_type: 'authorization_code', code: answer.code, redirect_uri: redirectUri(), code_verifier: run.codes.verifier });
    const { result, body, headers, retried } = await pf.formPost({
      url: run.metadata.tokenEndpoint, clientId: run.client.clientId, clientSecret: run.client.clientSecret, params, dpopKey: run.dpopKey, traceId: run.traceId,
    });
    run.trace.push(hop({ id: 'token', title: 'Redeem the code (PKCE code_verifier)', method: 'POST', url: run.metadata.tokenEndpoint, headers, params: body, result,
      claims: pf.tokenClaims(result.json), note: retried ? 'PingFederate asked for a DPoP nonce; the proof was signed again with it.' : null }));
    const tokens = result.json;
    if (!result.ok || typeof tokens?.access_token !== 'string') return finishRun(session, run, { outcome: 'refused', reason: tokens?.error || `http_${result.status}` });

    const tokenType = typeof tokens.token_type === 'string' ? tokens.token_type : null;
    let dpop = null;
    if (run.dpopKey) {
      const cnfJkt = claimsOf(tokens.access_token)?.cnf?.jkt ?? null;
      dpop = { jkt: run.dpopKey.jkt, tokenType, cnfJkt, bound: String(tokenType).toLowerCase() === 'dpop' && (cnfJkt === null || cnfJkt === run.dpopKey.jkt) };
      if (!dpop.bound) return finishRun(session, run, { outcome: 'failed', reason: 'dpop_not_bound', dpop });
    }
    let identity = null;
    if (run.card === 'signin' || hasOpenid(run.client.scope)) {
      if (typeof tokens.id_token !== 'string') return finishRun(session, run, { outcome: 'failed', reason: 'no_id_token' });
      const keys = await pf.jwks(run.metadata, run.traceId);
      const claims = pf.idToken(tokens.id_token, { metadata: run.metadata, keys, clientId: run.client.clientId, nonce: run.nonce });
      identity = { subject: String(claims.sub), issuer: claims.iss, expiresAt: new Date(claims.exp * 1000).toISOString() };
    }
    return finishRun(session, run, {
      outcome: 'accepted',
      tokenType,
      dpop,
      identity,
      scope: typeof tokens.scope === 'string' ? tokens.scope : null,
      authorizationDetails: tokens.authorization_details ?? claimsOf(tokens.access_token)?.authorization_details ?? null,
      accessToken: tokenView(tokens.access_token),
      idToken: tokenView(tokens.id_token),
    }, tokens);
  }

  function finishRun(session, run, result, tokens = null) {
    const done = { card: run.card, state: 'done', ...result, trace: run.trace, completedAt: new Date(now()).toISOString() };
    delete session.runs[run.card];
    session.results[run.card] = done;
    if (tokens) session.tokens[run.card] = { accessToken: tokens.access_token, idToken: tokens.id_token || null, refreshToken: tokens.refresh_token || null, tokenType: done.tokenType };
    return done;
  }

  const publicRun = (run, extra) => ({ card: run.card, ...(run.loginHint ? { loginHint: run.loginHint } : {}), ...extra, trace: run.trace, expiresAt: new Date(run.expiresAt).toISOString() });

  // pi.flow open-and-read: open a flow with the sign-in client, read it back, show status and actions. Sends no
  // credential and no existing PingFederate session cookie, so the flow always starts fresh.
  async function openAndRead() {
    if (!settings.ready('piflow')) throw new LabError('not_configured', 'Set the issuer and the sign-in client in Settings', 409);
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step: discoveryStep } = await pf.discover({ traceId });
    if (discoveryStep) trace.push(discoveryStep);
    const client = settings.section('signin');
    const url = new URL(metadata.authorizationEndpoint);
    url.search = new URLSearchParams({
      response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri(), scope: client.scope,
      state: crypto.randomBytes(12).toString('base64url'), code_challenge: newPkce().challenge, code_challenge_method: 'S256', response_mode: 'pi.flow',
    }).toString();
    const opened = await openFlow({ metadata, authorizeUrl: url.toString(), jar: {}, traceId, title: 'Ask PingFederate for a sign-in flow instead of a login page' });
    trace.push(opened.step);
    if (!opened.flow) throw new LabError('piflow_not_opened', `PingFederate did not open a pi.flow (HTTP ${opened.result.status})`, 502, { trace });
    const run = { traceId, jar: opened.jar, flowId: opened.flow.id, trace };
    const headers = { Accept: PIFLOW_JSON, 'X-XSRF-Header': 'PingFederate', Cookie: cookieHeader(run.jar) };
    const again = await pf.call(flowUrl(metadata, run.flowId), { headers, traceId });
    trace.push(hop({ id: 'read', title: 'Read the flow back from the Authentication API', method: 'GET', url: shownFlowUrl(metadata),
      headers: { ...headers, Cookie: 'x' }, result: { ...again, json: rawFlowBody(again.json, opened.flow.id) },
      note: 'The flow and its state live on PingFederate. A client moves it on by posting to one of the actions; this card sends nothing.' }));
    const view = flowView(again.ok && again.json ? again.json : opened.flow);
    return { status: view.status, actions: view.actions, trace };
  }

  return { start, submitCredentials, openAndRead };
}
