import { vi } from 'vitest';

// A stand-in for the lab server in web tests: routes "METHOD /path" to a body (or a function of the request body).
// It records every call so tests can assert exactly what the page sent.
export function mockServer(routes) {
  const calls = [];
  const impl = vi.fn(async (path, init = {}) => {
    const method = init.method || 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    // A function returns { status?, body }. A static value is the body, unless it is { status: <number>, body }.
    const reply = typeof route === 'function' ? route(body, calls)
      : (typeof route.status === 'number' && 'body' in route ? route : { body: route });
    const { status = 200, body: out } = reply;
    return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', impl);
  return { calls, impl };
}

export const CARDS = [
  { id: 'signin', title: 'Sign in (pi.flow)', kind: 'flow', ready: true, missing: [] },
  { id: 'dcr', title: 'Dynamic client registration (RFC 7591/7592)', kind: 'flow', ready: true, missing: [] },
  { id: 'rar', title: 'RAR via PAR (banking_transaction)', kind: 'flow', ready: true, missing: [], variantsReady: { dpop: false }, variantsMissing: { dpop: ['rarDpop.clientId'] } },
  { id: 'ciba', title: 'CIBA (start and poll)', kind: 'flow', ready: false, missing: ['ciba.clientId', 'ciba.clientSecret'] },
  { id: 'dpop', title: 'DPoP sign-in', kind: 'flow', ready: true, missing: [] },
  { id: 'tokenExchange', title: 'Token exchange, two hops (RFC 8693)', kind: 'flow', ready: true, missing: [] },
  { id: 'piflow', title: 'Authentication API: open and read a pi.flow', kind: 'flow', ready: true, missing: [] },
  { id: 'par', title: 'PAR', kind: 'flow', ready: true, missing: [] },
  { id: 'pkce', title: 'PKCE', kind: 'flow', ready: true, missing: [] },
  { id: 'playground', title: 'PingFederate Protocol Playground', kind: 'playground', ready: true, missing: [] },
  { id: 'cimd', title: 'Client ID metadata documents', kind: 'link', app: 'cimd-lab', setting: 'cimdLabUrl', url: 'http://127.0.0.1:5250', ready: true, missing: [] },
  { id: 'idJag', title: 'ID-JAG', kind: 'link', app: 'id-jag-standalone', setting: 'idJagUrl', url: null, ready: false, missing: ['links.idJagUrl'] },
  { id: 'discovery', title: 'PingFederate discovery check', kind: 'check', ready: true, missing: [] },
];

export const BASE_ROUTES = (issuer = 'https://pf.example') => ({
  'GET /api/config': { customer: { name: 'PingFederate LAB', tagline: 'Live', accent: '#b3122d', accentDark: '#ff6b7f', vocabulary: {}, warnings: [] }, issuer },
  'GET /api/cards': { cards: CARDS },
  'GET /api/me': { signedIn: false },
  'GET /api/stories': { verticals: [{ id: 'banking', label: 'Banking' }, { id: 'retail', label: 'Retail' }], default: 'banking' },
  'GET /api/stories/banking': { vertical: 'banking', intro: ['Harbor Mutual intro.'], cards: { dcr: 'Ledger registers itself.' } },
  'GET /api/stories/retail': { vertical: 'retail', intro: ['Copperline intro.'], cards: { dcr: 'Scout registers itself.' } },
});

// One trace step as the server records it.
export const hop = (id, title, method, url, status, body = {}) => ({ id, title, request: { method, url, headers: { traceparent: '00-a-b-01' } }, response: { status, body } });
