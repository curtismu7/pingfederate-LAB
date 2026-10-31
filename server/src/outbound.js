import { traceparent as newTraceparent } from './trace.js';
import { NetguardRefused } from './netguard.js';

// The one door out of this app. Every outbound request goes through call(), and call() only ever reaches the
// origin of the configured PingFederate issuer, over https, without following redirects, with a timeout and a
// body size cap. Anything else is refused before a socket is opened. No other module may call fetch.
// In mock mode the configured issuer is the in-process mock and fetchImpl is the netguard, which refuses every
// real URL. (Owner decisions 2026-10-28 and 2026-10-31: live mode may reach only the configured PingFederate origin.)

export const TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 256 * 1024;

export class OutboundRefused extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// The issuer's origin, or a refusal saying why there is none.
export function issuerOrigin(issuer) {
  if (!issuer) throw new OutboundRefused('not_configured', 'No PingFederate issuer is configured');
  let url;
  try { url = new URL(issuer); } catch { throw new OutboundRefused('bad_issuer', 'The PingFederate issuer is not a URL'); }
  if (url.protocol !== 'https:') throw new OutboundRefused('not_https', 'The PingFederate issuer must be https');
  if (url.username || url.password) throw new OutboundRefused('credentials_in_url', 'The PingFederate issuer must not carry credentials');
  return url.origin;
}

export function assertAllowed(target, issuer) {
  const origin = issuerOrigin(issuer);
  let url;
  try { url = new URL(target); } catch { throw new OutboundRefused('bad_url', 'Not a URL'); }
  if (url.protocol !== 'https:') throw new OutboundRefused('not_https', 'Outbound calls are https only');
  if (url.username || url.password) throw new OutboundRefused('credentials_in_url', 'Outbound URLs must not carry credentials');
  if (url.origin !== origin) throw new OutboundRefused('other_origin', 'Outbound calls may only reach the configured PingFederate');
  return url;
}

async function readCapped(response, max) {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.length > max) {
      chunks.push(value.subarray(0, max - total));
      await reader.cancel().catch(() => {});
      return { text: Buffer.concat(chunks).toString('utf8'), truncated: true };
    }
    chunks.push(value);
    total += value.length;
  }
  return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
}

export function createOutbound({ getIssuer, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BODY_BYTES }) {
  // { url, method, headers, body, traceId } -> { status, ok, headers, text, json, truncated, setCookies, location, traceparent }
  async function call(target, { method = 'GET', headers = {}, body, traceId } = {}) {
    const url = assertAllowed(target, getIssuer());
    const tp = newTraceparent(traceId);
    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers: { ...headers, traceparent: tp },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error instanceof NetguardRefused) throw new OutboundRefused('netguard', error.message);
      throw new OutboundRefused('unreachable', 'PingFederate did not answer');
    }
    let text;
    let truncated;
    // A body that times out or resets mid-read is the same refusal as no answer at all.
    try { ({ text, truncated } = await readCapped(response, maxBytes)); } catch {
      throw new OutboundRefused('unreachable', 'PingFederate stopped answering mid-reply');
    }
    let json = null;
    if (!truncated && text) { try { json = JSON.parse(text); } catch { json = null; } }
    const setCookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    // A redirect is reported, never followed. Its target is shown only when it stays on PingFederate.
    let location = null;
    const raw = response.headers.get('location');
    if (raw) {
      try {
        const next = new URL(raw, url);
        location = next.origin === url.origin ? `${next.origin}${next.pathname}` : '<another origin, not followed>';
      } catch { location = '<unparsable, not followed>'; }
    }
    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers: response.headers,
      text,
      json: json && typeof json === 'object' ? json : null,
      truncated,
      setCookies,
      location,
      traceparent: tp,
    };
  }
  return { call };
}
