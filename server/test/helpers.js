import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { createFakePf, ORIGIN } from './fakepf.js';

export const tempSettingsFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pflab-')), 'pingfederate.json');

// Every client the fake knows, configured in the lab's settings the way an owner would.
export const CLIENTS = {
  'signin-client': { scopes: [] },
  'pkce-client': { scopes: [] },
  'par-client': { secret: 'par-secret-value-1', scopes: [] },
  'rar-client': { secret: 'rar-secret-value-1', scopes: [] },
  'rar-dpop-client': { secret: 'rar-dpop-secret-1', dpop: true, scopes: [] },
  'dpop-client': { dpop: true, scopes: [] },
  'ciba-client': { secret: 'ciba-secret-value-1', scopes: [] },
  'iat-client': { secret: 'iat-secret-value-1', scopes: ['dcr:register'] },
  'agent-exchange': { secret: 'agent-exchange-secret-1', scopes: [] },
  'mcp-exchange': { secret: 'mcp-exchange-secret-1', scopes: [] },
  'agent-actor': { secret: 'agent-actor-secret-1', scopes: ['agent:invoke'] },
  'mcp-actor': { secret: 'mcp-actor-secret-1', scopes: ['mcp:invoke'] },
};

export const FULL_SETTINGS = {
  pf: { issuer: ORIGIN },
  signin: { clientId: 'signin-client' },
  pkce: { clientId: 'pkce-client' },
  par: { clientId: 'par-client', clientSecret: 'par-secret-value-1' },
  rar: { clientId: 'rar-client', clientSecret: 'rar-secret-value-1', sourceAccount: 'acct-1', destinationAccount: 'acct-2' },
  rarDpop: { clientId: 'rar-dpop-client', clientSecret: 'rar-dpop-secret-1' },
  dpop: { clientId: 'dpop-client' },
  ciba: { clientId: 'ciba-client', clientSecret: 'ciba-secret-value-1' },
  dcr: { iatClientId: 'iat-client', iatClientSecret: 'iat-secret-value-1', clientScope: 'lab:read', forbiddenScope: 'admin:write' },
  tokenExchange: {
    agentExchangeClientId: 'agent-exchange', agentExchangeClientSecret: 'agent-exchange-secret-1',
    mcpExchangeClientId: 'mcp-exchange', mcpExchangeClientSecret: 'mcp-exchange-secret-1',
    agentActorClientId: 'agent-actor', agentActorClientSecret: 'agent-actor-secret-1',
    mcpActorClientId: 'mcp-actor', mcpActorClientSecret: 'mcp-actor-secret-1',
  },
  links: { cimdLabUrl: 'http://127.0.0.1:5250', idJagUrl: 'https://id-jag.example' },
};

// mode: written to the settings file ('mock' | 'live'); unset, the lab picks it (live when an issuer is set).
export async function startLab({ fake: fakeOptions = {}, settings = FULL_SETTINGS, mode, fetchImpl, now, env, bind } = {}) {
  const fake = createFakePf({ clients: structuredClone(CLIENTS), ...fakeOptions });
  const file = tempSettingsFile();
  if (settings || mode) fs.writeFileSync(file, JSON.stringify({ version: 1, ...(mode ? { mode } : {}), values: settings || {} }), { mode: 0o600 });
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  // No built UI and no customer.config by default, so tests never depend on a local build or file.
  const app = createApp({ port, fetchImpl: fetchImpl || fake.fetchImpl, settingsFile: file, webDist: path.join(path.dirname(file), 'no-dist'), customerFile: path.join(path.dirname(file), 'no-customer.json'), ...(now ? { now } : {}), ...(env ? { env } : {}), ...(bind ? { bind } : {}) });
  server.on('request', app);
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  const bodies = []; // every response text the "browser" saw, for leak checks

  async function call(method, route, body, headers = {}) {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { ...(body !== undefined || method !== 'GET' ? { 'Content-Type': 'application/json', Origin: base } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : (method !== 'GET' ? '{}' : undefined),
    });
    // The last Set-Cookie wins, as in a browser (a sign-in may create and then rotate the session in one reply).
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.at(-1).split(';')[0];
    const text = await res.text();
    bodies.push(text);
    let data = null;
    try { data = JSON.parse(text); } catch { data = null; }
    return { status: res.status, data, text, headers: res.headers };
  }

  // Signs in through pi.flow with the fake's user.
  async function signIn(password = 'correct-horse-battery') {
    const started = await call('POST', '/api/signin/start');
    if (started.data?.state !== 'credentials_required') return started;
    return call('POST', '/api/signin/credentials', { username: 'alice', password });
  }

  // No secret the fake handed out (or saw) may appear in anything the page received.
  function leaks() {
    const all = bodies.join('\n');
    return [...fake.secrets].filter((s) => s && all.includes(s));
  }

  const close = () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });
  return { base, port, call, signIn, leaks, close, fake, file, app, bodies, cookie: () => cookie, setCookie: (c) => { cookie = c; } };
}
