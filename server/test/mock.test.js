import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLab } from './helpers.js';
import { MOCK_USER, mockSignInRefusal, hostRunAllowsMockSignIn, labelMock } from '../src/mock.js';
import { createNetguard } from '../src/netguard.js';

const MOCK_ENV = { ALLOW_MOCK_SIGNIN: '1' };

// A "real" fetch that records every attempt: mock mode must never call it.
function recordingFetch() {
  const attempts = [];
  const fn = async (url) => { attempts.push(String(url)); throw new Error('real network attempted'); };
  return { fn, attempts };
}

async function mockLab(extra = {}) {
  const real = recordingFetch();
  const lab = await startLab({ settings: null, env: MOCK_ENV, fetchImpl: real.fn, ...extra });
  return { lab, real };
}

const signIn = async (lab) => {
  const started = await lab.call('POST', '/api/signin/start');
  if (started.data?.state !== 'credentials_required') return started;
  return lab.call('POST', '/api/signin/credentials', { username: MOCK_USER.username, password: MOCK_USER.password });
};

// A flow card through the sign-in dialog when PingFederate asks for it.
async function flowCard(lab, card, body = {}) {
  const started = await lab.call('POST', `/api/cards/${card}/start`, body);
  if (started.data?.state !== 'credentials_required') return started;
  return lab.call('POST', `/api/cards/${card}/credentials`, { username: MOCK_USER.username, password: MOCK_USER.password });
}

test('mock mode with no settings file: every card runs end to end, labelled mock, with zero real outbound attempts', async () => {
  const { lab, real } = await mockLab();
  try {
    assert.equal(fs.existsSync(lab.file), false, 'no settings file was needed');
    const health = (await lab.call('GET', '/api/health')).data;
    assert.equal(health.runtime, 'offline');
    assert.equal(health.state, 'ready');
    const cards = (await lab.call('GET', '/api/cards')).data.cards;
    for (const id of ['discovery', 'signin', 'piflow', 'pkce', 'par', 'rar', 'dpop', 'ciba', 'dcr', 'tokenExchange', 'userinfo', 'playground']) {
      assert.equal(cards.find((c) => c.id === id).ready, true, id);
    }

    const discovery = await lab.call('POST', '/api/pf/discovery');
    assert.equal(discovery.data.issuer, 'https://pingfederate.mock.invalid');
    assert.equal(discovery.data.mode, 'mock');
    assert.ok(discovery.data.trace.every((s) => s.mock === true));

    const piflow = await lab.call('POST', '/api/cards/piflow/open');
    assert.equal(piflow.status, 200, piflow.text);

    // The sign-in dialog: a wrong password is refused by the mock, the demo user is accepted.
    const started = await lab.call('POST', '/api/signin/start');
    assert.equal(started.data.state, 'credentials_required');
    const wrong = await lab.call('POST', '/api/signin/credentials', { username: MOCK_USER.username, password: 'not-the-password' });
    assert.equal(wrong.data.refused, 'credential_validation_failed');
    const ok = await lab.call('POST', '/api/signin/credentials', { username: MOCK_USER.username, password: MOCK_USER.password });
    assert.equal(ok.data.outcome, 'accepted', ok.text);
    assert.ok(ok.data.trace.every((s) => s.mock === true));
    const me = (await lab.call('GET', '/api/me')).data;
    assert.equal(me.signedIn, true);
    assert.equal(me.accessToken.mock, true);
    assert.equal(me.accessToken.claims.iss, 'https://pingfederate.mock.invalid');

    const userinfo = await lab.call('POST', '/api/cards/userinfo/read');
    assert.equal(userinfo.data.outcome, 'accepted', userinfo.text);

    for (const card of ['pkce', 'par', 'dpop']) {
      const r = await flowCard(lab, card);
      assert.equal(r.data.outcome, 'accepted', `${card}: ${r.text}`);
    }
    for (const dpop of [false, true]) {
      const r = await flowCard(lab, 'rar', { amount: 125, currency: 'USD', dpop });
      assert.equal(r.data.outcome, 'accepted', `rar dpop=${dpop}: ${r.text}`);
    }

    // CIBA: the mock registers the request with the lab's approval channel; the person approves on the card.
    const ciba = await lab.call('POST', '/api/cards/ciba/start', {});
    assert.equal(ciba.data.approval, 'lab', ciba.text);
    assert.equal((await lab.call('POST', '/api/cards/ciba/poll')).data.state, 'pending');
    assert.equal((await lab.call('POST', '/api/cards/ciba/decision', { decision: 'approve' })).status, 200);
    let polled;
    for (let i = 0; i < 5; i += 1) {
      await new Promise((r) => setTimeout(r, 1050)); // the card polls no faster than PingFederate's interval (1 s)
      polled = await lab.call('POST', '/api/cards/ciba/poll');
      if (polled.data.state !== 'pending') break;
    }
    assert.equal(polled.data.state, 'approved', polled.text);

    for (const step of ['initial-token', 'register', 'use', 'delete']) {
      const r = await lab.call('POST', `/api/cards/dcr/${step}`);
      assert.equal(r.status, 200, `dcr ${step}: ${r.text}`);
    }
    const hop1 = await lab.call('POST', '/api/cards/token-exchange/agent');
    assert.equal(hop1.data.outcome, 'accepted', hop1.text);
    const hop2 = await lab.call('POST', '/api/cards/token-exchange/mcp');
    assert.equal(hop2.data.outcome, 'accepted', hop2.text);

    assert.deepEqual(real.attempts, [], 'mock mode called the real network');
    const stats = lab.app.locals.netguard.stats();
    assert.equal(stats.realAttempts, 0);
    assert.ok(stats.mockCalls > 20);
    // The mock's client secrets, codes and refresh tokens never reach the page. Its fake tokens do, whole (owner, rule 4).
    const all = lab.bodies.join('\n');
    const shownWhole = new Set([...all.matchAll(/"(?:access_token|id_token|subject_token|actor_token|issued_token|initial_access_token)":"([^"]+)"/g), ...all.matchAll(/"raw":true,"value":"([^"]+)"/g)].map((m) => m[1]));
    assert.ok(shownWhole.size > 5, 'mock tokens are shown whole');
    assert.deepEqual([...lab.app.locals.mock.secrets].filter((s) => s && s !== MOCK_USER.password && !shownWhole.has(s) && all.includes(s)), []);
  } finally { await lab.close(); }
});

test('netguard: self-test passes; in mock mode a real URL is refused and the real fetch is never called', async () => {
  const real = recordingFetch();
  let mode = 'mock';
  const mock = { origin: 'https://pingfederate.mock.invalid', fetchImpl: async () => new Response('{}') };
  const guard = createNetguard({ mode: () => mode, mock, realFetch: real.fn });
  const result = await guard.selfTest();
  assert.equal(result.ok, true, JSON.stringify(result.checks));
  await assert.rejects(() => guard.fetchImpl('https://pf.example/as/token.oauth2', {}), /no real outbound/);
  assert.equal((await guard.fetchImpl('https://pingfederate.mock.invalid/x', {})).status, 200);
  assert.deepEqual(real.attempts, []);
  assert.equal(guard.stats().realAttempts, 0);
  mode = 'live';
  await assert.rejects(() => guard.fetchImpl('https://pf.example/', {}), /real network attempted/);
  assert.equal(guard.stats().realAttempts, 1);
});

test('the mock lab refuses to reach anything but the mock, even when asked for another origin', async () => {
  const { lab, real } = await mockLab();
  try {
    await lab.call('PUT', '/api/settings', { pf: { issuer: 'https://pf.example' } });
    // Saving an issuer does not leave mock mode: the mode is chosen, never implied once set.
    assert.equal((await lab.call('GET', '/api/mode')).data.mode, 'mock');
    assert.equal((await lab.call('POST', '/api/pf/discovery')).data.issuer, 'https://pingfederate.mock.invalid');
    assert.deepEqual(real.attempts, []);
  } finally { await lab.close(); }
});

test('rule 11: mock sign-in needs ALLOW_MOCK_SIGNIN=1, no proxy headers, and a loopback bind', async () => {
  const off = await mockLab({ env: {} });
  try {
    const r = await off.lab.call('POST', '/api/signin/start');
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'mock_signin_refused');
    assert.equal((await off.lab.call('POST', '/api/cards/pkce/start')).status, 403);
    assert.equal((await off.lab.call('POST', '/api/cards/ciba/start', {})).status, 403);
    // A refused lab hands out neither the mock user nor its password, and the refusal says the exact command.
    const refused = (await off.lab.call('GET', '/api/mode')).data.mockSignIn;
    assert.equal(refused.allowed, false);
    assert.deepEqual(Object.keys(refused).sort(), ['allowed', 'refusal']);
    assert.match(refused.refusal, /ALLOW_MOCK_SIGNIN=1 npm start/);
    assert.doesNotMatch(JSON.stringify(refused), new RegExp(MOCK_USER.password));
  } finally { await off.lab.close(); }
  const on = await mockLab();
  try {
    assert.equal((await on.lab.call('POST', '/api/signin/start', {}, { 'X-Forwarded-For': '203.0.113.9' })).status, 403);
    assert.equal((await signIn(on.lab)).data.outcome, 'accepted');
    const view = (await on.lab.call('GET', '/api/mode')).data;
    assert.deepEqual(view.mockSignIn, { allowed: true, refusal: null, username: MOCK_USER.username, password: MOCK_USER.password });
  } finally { await on.lab.close(); }
  const wide = await mockLab({ bind: '0.0.0.0' });
  try { assert.equal((await wide.lab.call('POST', '/api/signin/start')).status, 403); } finally { await wide.lab.close(); }
  const docker = await mockLab({ bind: '0.0.0.0', env: { ...MOCK_ENV, LAB_PUBLISH: 'loopback' } });
  try { assert.equal((await docker.lab.call('POST', '/api/signin/start')).status, 200); } finally { await docker.lab.close(); }
  assert.match(mockSignInRefusal({ env: { NODE_ENV: 'production' }, bind: '127.0.0.1', headers: {} }), /Mock sign-in is off\. Start the lab with ALLOW_MOCK_SIGNIN=1 npm start/);
  // In Docker the switch is the compose file, so the message must not tell the owner to run npm start.
  assert.match(mockSignInRefusal({ env: { LAB_PUBLISH: 'loopback' }, bind: '0.0.0.0', headers: {} }), /compose file.*docker compose up -d/);
  assert.doesNotMatch(mockSignInRefusal({ env: { LAB_PUBLISH: 'loopback' }, bind: '0.0.0.0', headers: {} }), /npm start/);
  assert.equal(mockSignInRefusal({ env: { NODE_ENV: 'production', ALLOW_MOCK_SIGNIN: '1' }, bind: '127.0.0.1', headers: {} }), null);
  assert.match(mockSignInRefusal({ env: MOCK_ENV, bind: '127.0.0.1', headers: { forwarded: 'for=x' } }), /proxy/);
});

// A plain `npm start` (hostRun) on loopback with no PingFederate saved allows mock sign-in; nothing wider does.
test('rule 11 on a host run: allowed on loopback with no tenant settings, refused on every other bind, proxy, Docker marker or saved issuer', async () => {
  const signinStatus = async (opts, headers) => {
    const { lab } = await mockLab({ env: {}, hostRun: true, ...opts });
    try { return (await lab.call('POST', '/api/signin/start', {}, headers)).status; } finally { await lab.close(); }
  };
  assert.equal(await signinStatus({}), 200, 'plain npm start works');
  assert.equal(await signinStatus({}, { 'X-Forwarded-For': '203.0.113.9' }), 403, 'behind a proxy');
  assert.equal(await signinStatus({}, { Forwarded: 'for=203.0.113.9' }), 403);
  assert.equal(await signinStatus({ bind: '0.0.0.0' }), 403, 'non-loopback bind');
  assert.equal(await signinStatus({ env: { NODE_ENV: 'production' } }), 200, 'NODE_ENV is not a guard either way');
  assert.equal(await signinStatus({ env: { ALLOW_MOCK_SIGNIN: '0' } }), 403, 'an explicit off wins');
  assert.equal(await signinStatus({ env: { LAB_PUBLISH: 'loopback' } }), 403, 'the Docker marker needs the explicit flag');
  assert.equal(await signinStatus({ hostRun: false }), 403, 'only index.js asks for the host-run default');
  // A saved issuer is a tenant: the default ends, and saving one later ends it at once.
  assert.equal(await signinStatus({ settings: { pf: { issuer: 'https://pf.example' } }, mode: 'mock' }), 403);
  const { lab } = await mockLab({ env: {}, hostRun: true });
  try {
    assert.equal((await lab.call('GET', '/api/mode')).data.mockSignIn.allowed, true);
    await lab.call('PUT', '/api/settings', { pf: { issuer: 'https://pf.example' } });
    const after = (await lab.call('GET', '/api/mode')).data.mockSignIn;
    assert.equal(after.allowed, false);
    assert.equal((await lab.call('POST', '/api/signin/start')).status, 403);
  } finally { await lab.close(); }
  const base = { env: {}, bind: '127.0.0.1', hasTenant: false };
  assert.equal(hostRunAllowsMockSignIn(base), true);
  for (const bad of [{ bind: '0.0.0.0' }, { bind: '::' }, { hasTenant: true }, { env: { ALLOW_MOCK_SIGNIN: '' } }, { env: { LAB_PUBLISH: 'loopback' } }]) {
    assert.equal(hostRunAllowsMockSignIn({ ...base, ...bad }), false, JSON.stringify(bad));
  }
});

test('mode: unset follows the issuer, a chosen mode is saved, switching signs everyone out; live sign-in is unguarded', async () => {
  const live = await startLab(); // FULL_SETTINGS has an issuer: live, as for an owner who already set one
  try {
    assert.equal((await live.call('GET', '/api/mode')).data.mode, 'live');
    assert.equal((await live.call('GET', '/api/health')).data.runtime, 'live');
    await live.signIn(); // no ALLOW_MOCK_SIGNIN: the guards are for mock sign-in only
    assert.equal((await live.call('GET', '/api/me')).data.signedIn, true);
    const bad = await live.call('PUT', '/api/mode', { mode: 'pretend' });
    assert.equal(bad.status, 400);
    assert.equal((await live.call('GET', '/api/info')).data.realAvailable, true, 'FULL_SETTINGS configures every required live value');
    assert.equal((await live.call('GET', '/api/info')).data.source, 'real');
    const toMockR19 = await live.call('PUT', '/api/mode', { mode: 'mock' });
    assert.equal(toMockR19.data.source, 'mock');
    const toMock = await live.call('PUT', '/api/mode', { mode: 'mock' });
    assert.equal(toMock.data.mode, 'mock');
    assert.equal(toMock.data.issuer, 'https://pingfederate.mock.invalid');
    assert.equal(JSON.parse(fs.readFileSync(live.file, 'utf8')).mode, 'mock');
    assert.equal((await live.call('GET', '/api/me')).data.signedIn, false, 'switching ended the session');
    assert.equal((await live.call('GET', '/api/health')).data.runtime, 'offline');
    assert.equal((await live.call('GET', '/api/config')).data.mode, 'mock');
    // Saving settings keeps the chosen mode.
    await live.call('PUT', '/api/settings', { signin: { scope: 'openid' } });
    assert.equal(JSON.parse(fs.readFileSync(live.file, 'utf8')).mode, 'mock');
    const back = await live.call('PUT', '/api/mode', { mode: 'real' });
    assert.equal(back.data.mode, 'live');
    assert.equal(back.data.source, 'real');
    assert.equal((await live.call('GET', '/api/info')).data.source, 'real');
    assert.equal((await live.call('GET', '/api/config')).data.issuer, 'https://pf.example');
  } finally { await live.close(); }
});

test('labelMock marks the reply, every trace step and every decoded token', () => {
  const body = { outcome: 'accepted', trace: [{ id: 'a', request: {}, claims: null }], token: { header: {}, claims: { sub: 'x' } } };
  labelMock(body);
  assert.equal(body.mode, 'mock');
  assert.equal(body.trace[0].mock, true);
  assert.equal(body.token.mock, true);
});

test('docker-compose allows mock sign-in only with the loopback publish it pins; mock-only start needs no certificates', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  const live = fs.readFileSync(path.join(dir, 'docker-compose.live.yml'), 'utf8');
  assert.match(compose, /ALLOW_MOCK_SIGNIN: "1"/);
  assert.match(compose, /LAB_PUBLISH: loopback/);
  // A published port is `host:container`, each side a number or a ${HOST_PORT:-5400} default.
  const PORT_SIDE = String.raw`(?:\d+|\$\{HOST_PORT:-\d+\})`;
  const published = (text) => [...text.matchAll(/^\s+- "([^"]+)"$/gm)].map((m) => m[1]).filter((p) => new RegExp(`^(?:[\\d.]+:)?${PORT_SIDE}:${PORT_SIDE}$`).test(p));
  const ports = published(compose);
  assert.ok(ports.length > 0 && ports.every((p) => p.startsWith('127.0.0.1:')), ports.join(','));
  // One variable on both sides of the mapping and as the lab's PORT: the lab answers only the Host it is published as.
  assert.deepEqual(ports, ['127.0.0.1:${HOST_PORT:-5400}:${HOST_PORT:-5400}']);
  assert.match(compose, /PORT: "\$\{HOST_PORT:-5400\}"/);
  // The family lab-proxy's name for this lab, and only that name (never the bare launcher domain).
  assert.match(compose, /LAB_ALLOWED_HOSTS: \$\{LAB_ALLOWED_HOSTS:-pingfederate-lab\.local\.ping-devops\.com\}/);
  assert.deepEqual(published(live), [], 'the live file adds no published ports');
  // The base file starts with nothing set: no required variable, no certificate mount, plain http.
  assert.doesNotMatch(compose, /:\?/);
  assert.doesNotMatch(compose, /LAB_TLS_CERT|PFLAB_CA_FILE|PF_HOSTNAME/);
  assert.match(live, /PFLAB_TLS_CERT_FILE:\?/);
});

test('tokens: mock tokens are shown whole and labelled; live tokens are only ever masked (also side by side)', async () => {
  const mock = await mockLab();
  const live = await startLab();
  try {
    const [m, l] = await Promise.all([signIn(mock.lab), live.signIn()]);
    // Mock: the whole fake token, raw, with its decoded claims, and it is labelled mock.
    const view = m.data.accessToken;
    assert.equal(view.raw, true);
    assert.equal(view.mock, true);
    assert.match(view.value, /^[\w-]+\.[\w-]+\.[\w-]+$/);
    assert.equal(view.length, view.value.length);
    assert.equal(view.claims.sub, MOCK_USER.username);
    assert.equal(m.data.idToken.raw, true);
    // Live: masked first 6 + last 4, no whole value anywhere, even though a mock lab answers in the same process.
    const masked = l.data.accessToken;
    assert.match(masked.masked, /^.{6}\.\.\..{4}$/);
    assert.equal(masked.raw, undefined);
    assert.equal(masked.value, undefined);
    assert.equal(l.data.idToken.value, undefined);
    assert.deepEqual(live.leaks(), [], 'no token or secret the live fake issued reached the page');
    const text = live.bodies.join('\n');
    assert.equal(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/.test(text), false, 'no whole JWT in any live reply');
  } finally { await mock.lab.close(); await live.close(); }
});

test('netguard self-test really checks: a guard that lets a real URL through fails it', async () => {
  const real = recordingFetch();
  // The "mock" claims example.com as its own origin, so the self-test's probe URL is answered, not refused: check 1 must fail.
  const leaky = createNetguard({ mode: () => 'mock', mock: { origin: 'https://example.com', fetchImpl: async () => new Response('{}') }, realFetch: real.fn });
  const result = await leaky.selfTest();
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((c) => c.name === 'mock mode refuses a real URL').ok, false);
  // A guard that calls the real fetch in mock mode fails check 2 (and never reaches the network here: the fetch is a recorder).
  const calling = createNetguard({ mode: () => 'mock', mock: { origin: 'https://pingfederate.mock.invalid', fetchImpl: async () => new Response('{}') }, realFetch: real.fn });
  assert.equal((await calling.selfTest()).ok, true, 'a correct guard passes');
  assert.deepEqual(real.attempts, []);
});

test('RAR in mock mode needs no typing: the card list carries the mock user and accounts, and an empty run is accepted', async () => {
  const { lab } = await mockLab();
  const live = await startLab();
  try {
    const rar = (await lab.call('GET', '/api/cards')).data.cards.find((c) => c.id === 'rar');
    assert.deepEqual(rar.defaults, { user: MOCK_USER.username, sourceAccount: 'checking-001', destinationAccount: 'savings-002' });
    // Nobody signed in, no user, no accounts typed: the mock's own user and accounts are used.
    const done = await flowCard(lab, 'rar', {});
    assert.equal(done.status, 200, done.text);
    assert.equal(done.data.outcome, 'accepted', done.text);
    // Live mode offers no made-up user: the defaults are only the owner's saved accounts.
    const liveRar = (await live.call('GET', '/api/cards')).data.cards.find((c) => c.id === 'rar');
    assert.equal(liveRar.defaults.user, '');
  } finally { await lab.close(); await live.close(); }
});
