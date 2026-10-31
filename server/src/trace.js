import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// Every PingFederate call is recorded as a trace step and shown raw, for teaching. Redaction happens here, on the
// server, before anything reaches the page:
// - SECRET values (codes, verifiers, client secrets, refresh tokens, registration access tokens, DPoP proofs,
//   auth_req_id, passwords, cookies, flow ids) are replaced by a fixed marker that keeps only kind and length.
// - TOKENS (access, id, subject, actor and initial access tokens) are shown masked (first 6 + last 4 characters,
//   length, kind) next to their decoded claims. Exception (owner, 2026-10-31, rule 4): in mock mode the tokens are
//   fake and are shown whole, so they can be copied and decoded. The mode is carried per request (withTokenMode);
//   anything outside a request, and every live-mode request, masks.
// Identifiers that are not secret (client_id, redirect_uri, scope, authorization_details) are shown as sent.

export const SECRET_KEYS = new Set([
  'code', 'code_verifier', 'client_secret', 'refresh_token', 'registration_access_token', 'dpop', 'auth_req_id',
  'password', 'cookie', 'set-cookie', 'authorization', 'client_assertion', 'flow_id', 'flowid', 'id_token_hint',
]);
export const TOKEN_KEYS = new Set(['access_token', 'id_token', 'subject_token', 'actor_token', 'issued_token', 'initial_access_token']);
// Random per-run values that are not secret, but long and noisy.
const SHORTEN_KEYS = new Set(['state', 'nonce', 'code_challenge', 'jti']);

const kindOf = (text) => (text.split('.').length === 3 ? 'JWT' : 'opaque');

const tokenScope = new AsyncLocalStorage();
// Runs fn with tokens shown whole (rawTokens true: mock mode) or masked (anything else: live mode, the default).
export function withTokenMode(rawTokens, fn) { return tokenScope.run({ rawTokens: rawTokens === true }, fn); }
const showRaw = () => tokenScope.getStore()?.rawTokens === true;

export function redacted(value) {
  const text = String(value);
  return `<redacted ${kindOf(text)}, ${text.length} chars>`;
}

// A token reduced to something that cannot be replayed: its edges, its length and its kind.
export function masked(value) {
  const text = String(value);
  if (text.length <= 16) return { masked: '<too short to mask>', length: text.length, kind: kindOf(text) };
  return { masked: `${text.slice(0, 6)}...${text.slice(-4)}`, length: text.length, kind: kindOf(text) };
}

export function shortened(value) {
  const text = String(value);
  return text.length > 12 ? `${text.slice(0, 8)}...` : text;
}

function maskedRequestUri(value) {
  const text = String(value);
  const at = text.lastIndexOf(':');
  return at > 0 ? `${text.slice(0, at + 1)}${shortened(text.slice(at + 1))}` : shortened(text);
}

export function safeValue(key, value) {
  if (value === undefined || value === null) return value;
  const k = String(key).toLowerCase();
  if (SECRET_KEYS.has(k)) return redacted(value);
  if (TOKEN_KEYS.has(k)) return showRaw() ? String(value) : masked(value);
  if (SHORTEN_KEYS.has(k)) return shortened(value);
  if (k === 'request_uri') return maskedRequestUri(value);
  return value;
}

const MAX_DEPTH = 6;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

// Walks plain JSON (iteratively bounded by depth) and redacts by key. Anything deeper than MAX_DEPTH is dropped.
export function safeBody(body, depth = 0) {
  if (body === null || typeof body !== 'object') return body;
  if (depth >= MAX_DEPTH) return '<nested too deep>';
  if (Array.isArray(body)) return body.slice(0, 50).map((item) => safeBody(item, depth + 1));
  const out = {};
  // An error object's code (INVALID_TOKEN, VALIDATION_ERROR) is a label, not an authorization code: shown as is.
  const isError = Object.hasOwn(body, 'message') || Object.hasOwn(body, 'details');
  for (const [key, value] of Object.entries(body)) {
    if (isError && key === 'code' && typeof value === 'string' && ERROR_CODE.test(value)) { out[key] = value; continue; }
    if (value !== null && typeof value === 'object') {
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? redacted(JSON.stringify(value)) : safeBody(value, depth + 1);
    } else out[key] = safeValue(key, value);
  }
  return out;
}

// URLSearchParams or plain object; authorization_details is shown parsed.
export function safeParams(params) {
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params || {});
  const out = {};
  for (const [key, value] of entries) {
    if (key === 'authorization_details') {
      try { out[key] = JSON.parse(value); } catch { out[key] = String(value).slice(0, 200); }
    } else out[key] = safeValue(key, value);
  }
  return out;
}

export function safeHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const k = key.toLowerCase();
    if (k === 'authorization') out[key] = `${String(value).split(' ')[0]} <redacted>`;
    else if (k === 'dpop') out[key] = '<redacted DPoP proof JWT>';
    else if (k === 'cookie') out[key] = '<redacted PingFederate session cookies>';
    else out[key] = safeValue(k, value);
  }
  return out;
}

// The URL without its query (parameters are shown separately, redacted).
export function bareUrl(value) {
  try {
    const url = new URL(value);
    // Decoded for reading, so a masked segment shows as <flow id> rather than %3Cflow%20id%3E.
    let path = url.pathname;
    try { path = decodeURI(path); } catch { /* keep it encoded */ }
    return `${url.origin}${path}`;
  } catch { return String(value).split('?')[0]; }
}

function decodePart(part) {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// Decoded claims of a JWT (no signature check here), or null for an opaque token.
export function claimsOf(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  return parts.length === 3 ? decodePart(parts[1]) : null;
}

export function headerOf(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  return parts.length === 3 ? decodePart(parts[0]) : null;
}

// What the page may show about a token: masked value (or, in mock mode, the whole fake token as `value`), header, claims.
export function tokenView(token) {
  if (typeof token !== 'string' || !token) return null;
  const shown = showRaw() ? { raw: true, value: token, length: token.length, kind: kindOf(token) } : masked(token);
  return { ...shown, header: headerOf(token), claims: claimsOf(token) };
}

// W3C trace context: one trace id per card run, a new span id per hop.
export function newTraceId() { return crypto.randomBytes(16).toString('hex'); }
export function traceparent(traceId = newTraceId()) {
  return `00-${traceId}-${crypto.randomBytes(8).toString('hex')}-01`;
}

export function step({ id, title, request = null, response = null, claims = null, note = null }) {
  return { id, title, request, response, claims, note };
}
