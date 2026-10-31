import crypto from 'node:crypto';

// Server-side sessions, in memory only. The browser holds an unguessable id in an HttpOnly, SameSite=Strict
// cookie; tokens, PingFederate's session cookies, DPoP keys and pending runs live here and never leave the server.

export const COOKIE = 'pflab_sid';
const ID = /^[A-Za-z0-9_-]{43}$/;
// Workspaces (rule 13): the page sends its workspace id in this header. A workspace has its own sessions (sign-in,
// runs, results, tokens, trace); Reset clears the current workspace only. Absent = the default workspace.
export const WORKSPACE_HEADER = 'x-lab-workspace';
export const DEFAULT_WORKSPACE = 'default';
const WORKSPACE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const validWorkspace = (value) => typeof value === 'string' && WORKSPACE.test(value);
export const MAX_SESSIONS = 200;
export const IDLE_TTL_MS = 8 * 60 * 60 * 1000;

export function emptyState() {
  return { user: null, pfCookies: {}, pfCookiesFor: null, runs: {}, results: {}, tokens: {}, dcr: null, dcrClients: [], dcrLeftOver: [], ciba: null, exchange: null };
}

export function createSessions({ now = Date.now, max = MAX_SESSIONS, secure = false } = {}) {
  const live = new Map(); // `${id}|${workspace}` -> session; insertion order = least recently used first
  const keyOf = (id, workspace) => `${id}|${workspace}`;
  const sessionsOf = (id) => [...live.values()].filter((s) => s.id === id);

  function readWorkspace(headers) {
    const raw = headers[WORKSPACE_HEADER];
    if (raw === undefined) return DEFAULT_WORKSPACE;
    return validWorkspace(raw) ? raw : null;
  }

  function readId(header) {
    if (typeof header !== 'string' || header.length > 4096) return null;
    for (const part of header.split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) {
        const value = rest.join('=');
        return ID.test(value) ? value : null;
      }
    }
    return null;
  }

  const newId = () => crypto.randomBytes(32).toString('base64url');
  // Secure once the lab serves https, so the cookie never travels over plain http.
  const setCookie = (res, id) => res.append('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`);

  // Over the cap, anonymous sessions go first (least recently used first); a signed-in one only when none is left.
  function evict() {
    while (live.size > max) {
      let victim = null;
      for (const [key, s] of live) { if (!s.user) { victim = key; break; } }
      live.delete(victim ?? live.keys().next().value);
    }
  }

  // Looks up the caller's session by its cookie. A session is created only on a write (which has already passed the
  // same-origin checks), never on a GET: cross-site GETs (an <img> tag) cannot fill the store. A GET without a live
  // session gets an empty, unstored one. A client-chosen id that is not live is never adopted.
  function middleware(req, res, next) {
    const workspace = readWorkspace(req.headers);
    if (!workspace) return res.status(400).json({ error: 'bad_workspace', message: 'The workspace id is lowercase letters, digits and hyphens (1 to 32 characters)' });
    let id = readId(req.headers.cookie);
    let session = id ? live.get(keyOf(id, workspace)) : null;
    if (session && now() - session.lastSeen > IDLE_TTL_MS) { live.delete(session.key); session = null; }
    if (!session) {
      if (req.method === 'GET' || req.method === 'HEAD') {
        req.session = { id: null, workspace, lastSeen: now(), ...emptyState() };
        return next();
      }
      // A cookie id that no live session carries is never adopted. One that another workspace carries is the same
      // browser, so it is kept: all of a browser's workspaces share the cookie.
      if (!id || sessionsOf(id).length === 0) { id = newId(); setCookie(res, id); }
      session = { id, workspace, key: keyOf(id, workspace), lastSeen: now(), ...emptyState() };
    }
    session.lastSeen = now();
    live.delete(session.key);
    live.set(session.key, session);
    evict();
    req.session = session;
    return next();
  }

  // On an accepted sign-in the browser gets a new id: the old one (which someone else may have planted) is dead,
  // for every workspace the browser has.
  function rotate(session, res) {
    const old = session.id;
    const id = newId();
    for (const s of sessionsOf(old)) {
      live.delete(s.key);
      s.id = id;
      s.key = keyOf(id, s.workspace);
      live.set(s.key, s);
    }
    setCookie(res, id);
  }

  // Sign-out: this workspace's session goes, PingFederate's cookies and every token with it. True when the browser
  // has no other workspace left, so its cookie can go too.
  function destroy(session) {
    live.delete(session.key);
    return sessionsOf(session.id).length === 0;
  }

  // Reset: clears every card's runs, results and tokens; keeps the sign-in.
  function reset(session) {
    const keep = { user: session.user, pfCookies: session.pfCookies, pfCookiesFor: session.pfCookiesFor, signin: session.tokens.signin };
    // Every client DCR created and did not delete is still on PingFederate: name them all.
    const leftover = [...(session.dcrClients || []), ...(session.dcrLeftOver || [])].map((c) => c.clientId);
    Object.assign(session, emptyState(), { user: keep.user, pfCookies: keep.pfCookies, pfCookiesFor: keep.pfCookiesFor });
    if (keep.signin) session.tokens.signin = keep.signin;
    return { dcrClientsLeftOnPingFederate: leftover };
  }

  // Reset one workspace for everyone (the doctor-style `npm run reset`): every session in it is reset, sign-ins stay.
  function resetWorkspace(workspace) {
    const targets = [...live.values()].filter((s) => s.workspace === workspace);
    const left = targets.flatMap((s) => reset(s).dcrClientsLeftOnPingFederate);
    return { sessionsReset: targets.length, dcrClientsLeftOnPingFederate: left };
  }

  // The workspaces this browser has used, plus the one it is on.
  const workspacesOf = (id, current) => [...new Set([DEFAULT_WORKSPACE, current, ...(id ? sessionsOf(id).map((s) => s.workspace) : [])])].sort();

  // Switching between mock and live ends every session.
  const clear = () => live.clear();

  return { middleware, destroy, reset, resetWorkspace, workspacesOf, rotate, clear, size: () => live.size, has: (id) => sessionsOf(id).length > 0 };
}
