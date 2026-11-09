// return-link service: the fixed list of apps that can hand a use case to this app, and the pure logic behind the
// "Back to <app>" button. Vendored byte for byte into each app (web/src/return-link/), next to ReturnLink.jsx.
//
// Safety: the Back target comes ONLY from RETURN_TARGETS below, keyed by the `from` id. Nothing read from the address
// bar ever becomes part of the target's origin or path: `from` only selects a list entry, and `uc` / `vertical` must be
// id-shaped before they are shown or carried back. So there is no open redirect. Unknown `from` means no strip.
//
// Where Back goes, decided from this page's own path (the host alone cannot tell: the lab proxy also runs on
// 127.0.0.1:8443 and localhost:8443): under a directory prefix (/a2a-lab/...) the page is behind the shared lab
// proxy, so Back is the target's proxyPath on this same origin; served at its root ('/' or '/index.html') the app
// is on its own port, so Back is the target's directUrl. The link carries ids only: returned=<this app id>&uc=<uc>.
// No token, secret, cookie or user data.

export const RETURN_TARGETS = Object.freeze({
  'customer-agent': Object.freeze({
    label: 'Customer Agent LAB',
    proxyPath: '/customer-agent/',
    directUrl: 'http://127.0.0.1:5603/',
  }),
});

const ID = /^[A-Za-z0-9.-]{1,40}$/;
export const isId = (v) => typeof v === 'string' && ID.test(v);

// True when the page sits under a directory prefix (a non-empty first path segment followed by '/'): the lab proxy.
export const isProxiedPath = (pathname) => typeof pathname === 'string' && /^\/[^/]+\//.test(pathname);

// Reads ?from=&uc=&vertical= from a query string. Returns { from, label, uc, vertical } or null when there must be no
// strip: unknown or repeated `from`, a missing or bad `uc`, a bad `vertical` (vertical is optional), or a repeated id.
export function readReturnContext(search) {
  let q;
  try { q = new URLSearchParams(typeof search === 'string' ? search : ''); } catch { return null; }
  for (const k of ['from', 'uc', 'vertical']) if (q.getAll(k).length > 1) return null;
  const from = q.get('from');
  if (!isId(from) || !Object.hasOwn(RETURN_TARGETS, from)) return null;
  const uc = q.get('uc');
  if (!isId(uc)) return null;
  const vertical = q.get('vertical');
  if (vertical !== null && !isId(vertical)) return null;
  return { from, label: RETURN_TARGETS[from].label, uc, vertical };
}

// The Back link for a context from readReturnContext, from the app `self` (its own id), given this page's location
// ({ pathname }). Returns null when there must be no button.
export function backHref(ctx, self, location) {
  if (!ctx || !isId(self) || !Object.hasOwn(RETURN_TARGETS, ctx.from) || !isId(ctx.uc)) return null;
  const t = RETURN_TARGETS[ctx.from];
  const query = new URLSearchParams([['returned', self], ['uc', ctx.uc]]).toString();
  const base = isProxiedPath(location?.pathname) ? t.proxyPath : t.directUrl;
  return `${base}?${query}`;
}

// Both at once from the browser (or a passed-in location, for tests).
export function returnLinkFor(self, location) {
  const loc = location ?? (typeof window !== 'undefined' ? window.location : null);
  if (!loc) return null;
  const ctx = readReturnContext(loc.search);
  const href = backHref(ctx, self, loc);
  return ctx && href ? { ...ctx, href } : null;
}
