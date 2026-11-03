// Same-origin calls to the lab's own server, never any other host. The server is the only thing that talks to
// PingFederate; the page never navigates to it.
// The workspace (rule 13) is the page's own choice, kept in this browser and sent on every call; the server scopes
// sessions, runs, results and trace to it. Default: "default".
const WORKSPACE_KEY = 'pflab-workspace';
export const WORKSPACE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export function currentWorkspace() {
  try { const v = window.localStorage.getItem(WORKSPACE_KEY); return WORKSPACE_RE.test(v || '') ? v : 'default'; } catch { return 'default'; }
}
export function chooseWorkspace(id) {
  try { if (id === 'default') window.localStorage.removeItem(WORKSPACE_KEY); else window.localStorage.setItem(WORKSPACE_KEY, id); } catch { /* the page still works on the default */ }
}

export async function call(method, path, body) {
  try {
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'x-lab-workspace': currentWorkspace(), ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    let data = null;
    try { data = await response.json(); } catch { /* empty or non-JSON body */ }
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'network_error', message: 'The lab server did not answer' } };
  }
}

export const api = {
  config: () => call('GET', '/api/config'),
  cards: () => call('GET', '/api/cards'),
  me: () => call('GET', '/api/me'),
  signOut: () => call('POST', '/api/signout'),
  settings: () => call('GET', '/api/settings'),
  saveSettings: (patch) => call('PUT', '/api/settings', patch),
  discovery: () => call('POST', '/api/pf/discovery'),
  stories: () => call('GET', '/api/stories'),
  story: (vertical) => call('GET', `/api/stories/${encodeURIComponent(vertical)}`),
  reset: () => call('POST', '/api/reset'),
  workspaces: () => call('GET', '/api/workspaces'),
  mode: () => call('GET', '/api/mode'),
  setMode: (mode) => call('PUT', '/api/mode', { mode: mode === 'live' ? 'real' : mode }),
  info: () => call('GET', '/api/info'),
  discardDcr: () => call('POST', '/api/cards/dcr/discard'),
  cibaDecision: (decision) => call('POST', '/api/cards/ciba/decision', { decision }),
};
