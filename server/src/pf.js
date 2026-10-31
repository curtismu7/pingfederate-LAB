import { dpopProof, verifyIdToken, JwtInvalid } from './jose.js';
import { OutboundRefused } from './outbound.js';
import { safeBody, safeHeaders, safeParams, bareUrl, claimsOf, step } from './trace.js';

// PingFederate as the authorization server: discovery, the JWKS, token requests (client auth, DPoP with the
// nonce retry) and ID token checks. Every request goes through the outbound guard and comes back as a trace step.

export class LabError extends Error {
  constructor(code, message, status = 502, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const DISCOVERY_TTL_MS = 5 * 60 * 1000;
const ENDPOINTS = {
  authorizationEndpoint: 'authorization_endpoint',
  tokenEndpoint: 'token_endpoint',
  jwksUri: 'jwks_uri',
  parEndpoint: 'pushed_authorization_request_endpoint',
  backchannelEndpoint: 'backchannel_authentication_endpoint',
  registrationEndpoint: 'registration_endpoint',
  userinfoEndpoint: 'userinfo_endpoint',
};
const REQUIRED_ENDPOINTS = ['authorizationEndpoint', 'tokenEndpoint', 'jwksUri'];

const basic = (id, secret) => `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString('base64')}`;

// A recorded hop: the request as sent (redacted), PingFederate's answer (redacted) and the traceparent it carried.
export function hop({ id, title, method, url, headers = {}, params = null, json = null, result, claims = null, note = null }) {
  const s = step({
    id,
    title,
    request: {
      method,
      url: bareUrl(url),
      headers: safeHeaders({ ...headers, traceparent: result?.traceparent }),
      ...(params ? { params: safeParams(params) } : {}),
      ...(json ? { body: safeBody(json) } : {}),
    },
    response: result ? {
      status: result.status,
      ...(result.location ? { location: result.location } : {}),
      body: result.json ? safeBody(result.json) : (result.text ? '<not JSON>' : null),
    } : null,
    claims,
    note,
  });
  return s;
}

function asLabError(error) {
  if (error instanceof LabError) return error;
  if (error instanceof OutboundRefused) {
    return new LabError(`outbound_${error.reason}`, error.message, error.reason === 'not_configured' ? 409 : 502);
  }
  return error;
}

export function createPf({ outbound, settings, now = Date.now }) {
  let cache = null; // { issuer, at, metadata }

  const issuer = () => settings.value('pf', 'issuer');

  async function call(url, init) {
    try { return await outbound.call(url, init); } catch (error) { throw asLabError(error); }
  }

  function readMetadata(doc, configured) {
    if (!doc || typeof doc !== 'object') throw new LabError('discovery_invalid', 'Discovery is not JSON');
    if (String(doc.issuer || '').replace(/\/+$/, '') !== configured) {
      throw new LabError('discovery_issuer_mismatch', 'The discovery issuer does not match the configured issuer');
    }
    const origin = new URL(configured).origin;
    const metadata = { issuer: doc.issuer, raw: doc };
    for (const [name, field] of Object.entries(ENDPOINTS)) {
      const value = doc[field];
      if (!value) { metadata[name] = ''; continue; }
      let url;
      try { url = new URL(value); } catch { throw new LabError('discovery_invalid', `${field} is not a URL`); }
      if (url.protocol !== 'https:' || url.origin !== origin) {
        throw new LabError('discovery_invalid', `${field} is not on the PingFederate origin`);
      }
      metadata[name] = url.toString();
    }
    for (const name of REQUIRED_ENDPOINTS) {
      if (!metadata[name]) throw new LabError('discovery_invalid', `Discovery has no ${ENDPOINTS[name]}`);
    }
    metadata.pfOrigin = origin;
    return metadata;
  }

  // { metadata, step }. Cached for five minutes per issuer; `fresh` skips the cache.
  async function discover({ traceId, fresh = false } = {}) {
    const configured = issuer();
    if (!fresh && cache && cache.issuer === configured && now() - cache.at < DISCOVERY_TTL_MS) {
      return { metadata: cache.metadata, step: null };
    }
    if (!configured) throw new LabError('not_configured', 'Set the PingFederate issuer in Settings', 409);
    const url = `${configured}/.well-known/openid-configuration`;
    const result = await call(url, { headers: { Accept: 'application/json' }, traceId });
    const s = hop({ id: 'discovery', title: 'Read PingFederate discovery', method: 'GET', url, headers: { Accept: 'application/json' }, result });
    if (result.status !== 200) throw new LabError('discovery_failed', `Discovery answered HTTP ${result.status}`, 502, { trace: [s] });
    let metadata;
    try { metadata = readMetadata(result.json, configured); } catch (error) { error.extra = { trace: [s] }; throw error; }
    cache = { issuer: configured, at: now(), metadata };
    return { metadata, step: s };
  }

  async function jwks(metadata, traceId) {
    const result = await call(metadata.jwksUri, { headers: { Accept: 'application/json' }, traceId });
    if (result.status !== 200 || !Array.isArray(result.json?.keys)) throw new LabError('jwks_failed', `JWKS answered HTTP ${result.status}`);
    return result.json;
  }

  // A form POST to PingFederate with client authentication: client_secret_basic when a secret is set, otherwise
  // client_id in the body (a public client). With `dpopKey` the request carries a DPoP proof; a server that
  // demands a nonce (use_dpop_nonce + DPoP-Nonce header) gets one more proof, once.
  async function formPost({ url, clientId, clientSecret, params, dpopKey = null, traceId }) {
    const body = new URLSearchParams(params);
    const headers = { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' };
    if (clientSecret) headers.Authorization = basic(clientId, clientSecret);
    else if (clientId) body.set('client_id', clientId);
    const send = (nonce) => call(url, {
      method: 'POST',
      headers: dpopKey ? { ...headers, DPoP: dpopProof({ key: dpopKey, htu: url, htm: 'POST', nonce }) } : headers,
      body: body.toString(),
      traceId,
    });
    let result = await send();
    let retried = false;
    const nonce = dpopKey && !result.ok ? result.headers.get('dpop-nonce') : null;
    if (nonce && result.json?.error === 'use_dpop_nonce') { result = await send(nonce); retried = true; }
    const shownHeaders = { ...headers, ...(dpopKey ? { DPoP: 'x' } : {}) };
    if (clientSecret) shownHeaders.Authorization = `Basic <${clientId}:client secret>`;
    return { result, body, headers: shownHeaders, retried };
  }

  function idToken(token, { metadata, keys, clientId, nonce }) {
    try {
      return verifyIdToken(token, { jwks: keys, issuer: metadata.issuer, audience: clientId, nonce, now });
    } catch (error) {
      if (error instanceof JwtInvalid) throw new LabError('id_token_invalid', `The ID token was refused: ${error.message}`);
      throw error;
    }
  }

  const tokenClaims = (json) => (json ? {
    ...(json.access_token ? { accessToken: claimsOf(json.access_token) } : {}),
    ...(json.id_token ? { idToken: claimsOf(json.id_token) } : {}),
  } : null);

  return { issuer, discover, jwks, formPost, idToken, tokenClaims, call, clearCache: () => { cache = null; } };
}
