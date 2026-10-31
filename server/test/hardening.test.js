// Tests for the step-1 review fixes (one block per finding). Each would fail if its fix were reverted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startLab, tempSettingsFile, FULL_SETTINGS } from './helpers.js';
import { createFakePf } from './fakepf.js';
import { htmlExcerpt, rawFlowBody } from '../src/piflow.js';
import { createOutbound, OutboundRefused } from '../src/outbound.js';
import { createEcKey, signEs256, verifyIdToken, JwtInvalid } from '../src/jose.js';
import { createSettings, SettingsError } from '../src/settings.js';
import { buildAuthorizationDetail } from '../src/cards.js';
import { createApp, labAddresses } from '../src/app.js';
import { checkRoles, provision, adminAgent, createAdminApi } from '../../scripts/provision-pf.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// 1. htmlExcerpt is linear and reads at most 8 KB.
test('htmlExcerpt: hostile bodies finish fast; only the first 8 KB is read; scripts and styles are dropped', () => {
  for (const hostile of ['<'.repeat(256 * 1024), '<script'.repeat(36000), `<style>${'<'.repeat(200000)}`, '&#'.repeat(128 * 1024), ' \t'.repeat(128 * 1024)]) {
    const started = process.hrtime.bigint();
    htmlExcerpt(hostile);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 200, `took ${ms} ms`);
  }
  assert.equal(htmlExcerpt(`<${'x'.repeat(9000)}>visible`), '', 'text beyond 8 KB is never read');
  assert.equal(htmlExcerpt('<script>steal()</script><style>p{}</style><h1>400 - Invalid client_id</h1>'), '400 - Invalid client_id');
  assert.equal(htmlExcerpt('<SCRIPT type="x">a</SCRIPT>ok &amp; done'), 'ok done');
});

test('htmlExcerpt: a huge non-JSON authorize answer does not block the server', async () => {
  const lab = await startLab({ fake: { authorizeBody: '<'.repeat(256 * 1024) } });
  try {
    const started = Date.now();
    const [res, health] = await Promise.all([lab.call('POST', '/api/signin/start'), lab.call('GET', '/api/health')]);
    assert.ok(Date.now() - started < 3000);
    assert.equal(res.data.outcome, 'refused');
    assert.equal(health.status, 200);
  } finally { await lab.close(); }
});

// 2. Sessions: no session from a GET; anonymous sessions are evicted before signed-in ones.
test('cross-site GET floods create no session and cannot evict a signed-in one', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const signedIn = lab.cookie();
    for (let i = 0; i < 250; i += 1) {
      const res = await fetch(`${lab.base}/api/me`);
      assert.equal(res.headers.get('set-cookie'), null, 'a GET never mints a session');
      await res.text();
    }
    // 250 anonymous sessions made by same-origin writes still do not push out the signed-in one.
    for (let i = 0; i < 250; i += 1) {
      const res = await fetch(`${lab.base}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: lab.base }, body: '{}' });
      await res.text();
    }
    lab.setCookie(signedIn);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
  } finally { await lab.close(); }
});

// 3. Session fixation: the id rotates on sign-in; a client-chosen id is never adopted.
test('sign-in rotates the session id and kills the old one; planted ids are not adopted', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    const before = lab.cookie();
    const done = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'correct-horse-battery' });
    assert.equal(done.data.outcome, 'accepted');
    const after = lab.cookie();
    assert.notEqual(after, before);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
    lab.setCookie(before);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false, 'the pre-sign-in id is dead');
    const planted = `pflab_sid=${'A'.repeat(43)}`;
    lab.setCookie(planted);
    const res = await lab.call('POST', '/api/reset');
    assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith(planted)), 'a fresh id is issued');
    assert.notEqual(lab.cookie(), planted);
  } finally { await lab.close(); }
});

test('sign-out deletes the server-side session: the old cookie is dead', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const old = lab.cookie();
    await lab.call('POST', '/api/signout');
    lab.setCookie(old);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
  } finally { await lab.close(); }
});

test('an idle session expires after 8 hours', async () => {
  let offset = 0;
  const lab = await startLab({ now: () => Date.now() + offset });
  try {
    await lab.signIn();
    offset = 7 * 60 * 60 * 1000;
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
    offset += 8 * 60 * 60 * 1000 + 1000;
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
  } finally { await lab.close(); }
});

// State check and cross-issuer cookies.
test('a completed flow carrying someone else\'s state is refused', async () => {
  const lab = await startLab({ fake: { wrongState: true } });
  try {
    const res = await lab.signIn();
    assert.equal(res.data.outcome, 'failed');
    assert.equal(res.data.reason, 'state_mismatch');
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
    assert.ok(!lab.fake.calls.some((c) => c.path === '/as/token.oauth2'), 'the code is never redeemed');
  } finally { await lab.close(); }
});

test('PingFederate session cookies are never sent to a different issuer', async () => {
  const one = createFakePf({ clients: { 'signin-client': {}, 'pkce-client': {} } });
  const two = createFakePf({ origin: 'https://pf2.example', clients: { 'signin-client': {}, 'pkce-client': {} } });
  const route = (url, init) => (new URL(url).origin === two.origin ? two.fetchImpl(url, init) : one.fetchImpl(url, init));
  const lab = await startLab({ fetchImpl: route });
  try {
    assert.equal((await lab.signIn()).data.outcome, 'accepted');
    await lab.call('PUT', '/api/settings', { pf: { issuer: 'https://pf2.example' } });
    const res = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(res.data.state, 'credentials_required', 'no single sign-on across issuers');
    const authorize = two.calls.find((c) => c.path === '/as/authorization.oauth2');
    assert.equal(authorize.headers.cookie, undefined);
  } finally { await lab.close(); }
});

// Settings prototype guard.
test('settings refuse __proto__ sections and do not pollute Object.prototype', () => {
  const s = createSettings({ file: tempSettingsFile() });
  assert.throws(() => s.update(JSON.parse('{"__proto__":{"toString":"x"}}')), SettingsError);
  assert.throws(() => s.update(JSON.parse('{"constructor":{"name":"x"}}')), SettingsError);
  assert.equal(typeof ({}).toString, 'function');
  assert.equal(({}).polluted, undefined);
});

// 4. Sign-in needs openid.
test('sign-in refuses a scope without openid', async () => {
  const lab = await startLab();
  try {
    await lab.call('PUT', '/api/settings', { signin: { scope: 'profile' } });
    const res = await lab.call('POST', '/api/signin/start');
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'signin_needs_openid');
    assert.equal(lab.fake.calls.length, 0);
  } finally { await lab.close(); }
});

// 5. A body that fails mid-read is a refusal, not a 500.
test('outbound: a body that errors mid-read is the same refusal as no answer', async () => {
  const broken = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a"')); c.error(new Error('ECONNRESET')); } });
  const out = createOutbound({ getIssuer: () => 'https://pf.example', fetchImpl: async () => new Response(broken, { status: 200 }) });
  await assert.rejects(() => out.call('https://pf.example/x'), (e) => e instanceof OutboundRefused && e.reason === 'unreachable');
});

// 6. ID token claim types and ranges.
test('ID token: null payload, huge exp, future iat or nbf, non-string sub are refused (no TypeError, no 500)', async () => {
  const key = createEcKey();
  const jwks = { keys: [{ ...key.publicJwk, kid: 'k1', alg: 'ES256' }] };
  const t = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://pf.example', aud: 'c1', sub: 'alice', exp: t + 60 };
  const opts = { jwks, issuer: 'https://pf.example', audience: 'c1' };
  const make = (claims) => signEs256({ alg: 'ES256', kid: 'k1' }, claims, key.privateKey);
  for (const claims of [null, [1], { ...base, exp: 1e300 }, { ...base, exp: t + 400 * 86400 }, { ...base, iat: t + 3600 }, { ...base, iat: 'now' }, { ...base, nbf: t + 3600 }, { ...base, sub: 42 }, { ...base, exp: '9' }]) {
    assert.throws(() => verifyIdToken(make(claims), opts), JwtInvalid, JSON.stringify(claims));
  }
  assert.equal(verifyIdToken(make({ ...base, iat: t, nbf: t }), opts).sub, 'alice');
  const lab = await startLab({ fake: { idTokenClaims: { exp: 8.64e15 } } });
  try {
    const res = await lab.signIn();
    assert.equal(res.status, 502);
    assert.equal(res.data.error, 'id_token_invalid');
  } finally { await lab.close(); }
});

// 7. Step cap.
test('a flow that keeps answering MFA_COMPLETED stops after a few steps', async () => {
  const lab = await startLab({ fake: { mfaLoop: true } });
  try {
    const res = await lab.signIn();
    assert.equal(res.data.outcome, 'failed');
    assert.equal(res.data.reason, 'too_many_steps');
    assert.ok(lab.fake.calls.filter((c) => c.path.startsWith('/pf-ws/')).length <= 7);
  } finally { await lab.close(); }
});

// 8. DCR: every client tracked, deleted or reported; repeats capped.
test('DCR: an accepted anonymous client is tracked even when the real registration fails, and deleted later', async () => {
  let offset = 0;
  const lab = await startLab({ fake: { openRegistration: true, registerFailWithToken: true }, now: () => Date.now() + offset });
  try {
    await lab.call('POST', '/api/cards/dcr/initial-token');
    const reg = await lab.call('POST', '/api/cards/dcr/register');
    assert.equal(reg.data.error, 'register_refused');
    offset = 11 * 60 * 1000;
    assert.equal((await lab.call('POST', '/api/cards/dcr/initial-token')).data.error, 'client_pending', 'a live client blocks a new run, whatever the time');
    const del = await lab.call('POST', '/api/cards/dcr/delete');
    assert.equal(del.status, 200);
    assert.equal(del.data.alsoDeleted.length, 1);
    assert.equal(lab.fake.registered.size, 0, 'nothing left on PingFederate');
    assert.equal((await lab.call('POST', '/api/cards/dcr/initial-token')).status, 200);
  } finally { await lab.close(); }
});

test('DCR: Reset names every client left; repeated steps are capped', async () => {
  const lab = await startLab({ fake: { openRegistration: true } });
  try {
    await lab.call('POST', '/api/cards/dcr/initial-token');
    await lab.call('POST', '/api/cards/dcr/register');
    for (let i = 0; i < 3; i += 1) assert.equal((await lab.call('POST', '/api/cards/dcr/use')).status, 200);
    const fourth = await lab.call('POST', '/api/cards/dcr/use');
    assert.equal(fourth.data.error, 'too_many_repeats');
    const reset = await lab.call('POST', '/api/reset');
    assert.equal(reset.data.dcrClientsLeftOnPingFederate.length, 2, 'the anonymous and the registered client');
  } finally { await lab.close(); }
});

// 9. PingFederate's flow JSON is shown as it came, with the flow id, codes, tokens and secrets masked.
test('pi.flow bodies are shown raw but lose the flow id, codes, tokens and secrets', async () => {
  assert.deepEqual(rawFlowBody({ id: 'flow-123456', status: 'USERNAME_PASSWORD_REQUIRED', _links: { checkUsernamePassword: { href: 'https://pf.example/pf-ws/authn/flows/flow-123456' } } }),
    { id: '<flow id>', status: 'USERNAME_PASSWORD_REQUIRED', _links: { checkUsernamePassword: { href: 'https://pf.example/pf-ws/authn/flows/<flow id>' } } });
  assert.deepEqual(rawFlowBody({ code: 'VALIDATION_ERROR', details: [{ code: 'CREDENTIAL_VALIDATION_FAILED', target: 'https://pf.example/pf-ws/authn/flows/flow-123456' }] }, 'flow-123456'),
    { code: 'VALIDATION_ERROR', details: [{ code: 'CREDENTIAL_VALIDATION_FAILED', target: 'https://pf.example/pf-ws/authn/flows/<flow id>' }] });
  assert.deepEqual(rawFlowBody({ status: 'COMPLETED', authorizeResponse: { code: 'abc', state: 's' }, sessionToken: 't' }),
    { status: 'COMPLETED', authorizeResponse: { code: '<redacted>', state: 's' }, sessionToken: '<redacted>' });
  let deep = {}; for (let i = 0; i < 50; i += 1) deep = { a: deep };
  assert.doesNotThrow(() => rawFlowBody(deep));
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    const wrong = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'nope' });
    const step = wrong.data.trace.find((s) => s.id === 'credentials');
    assert.equal(step.response.status, 400);
    assert.equal(step.response.body.id, '<flow id>');
    assert.equal(step.response.body._links.self.href, 'https://pf.example/pf-ws/authn/flows/<flow id>');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

// 10. Settings: port-aware default, corrupt file, symlinks, temp file.
test('the default redirect URI follows the lab port', async () => {
  const file = tempSettingsFile();
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  server.on('request', createApp({ port, settingsFile: file, fetchImpl: async () => { throw new Error('no outbound in this test'); } }));
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/settings`);
    assert.equal((await res.json()).settings.pf.redirectUri, `http://127.0.0.1:${port}/callback`);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a symlinked settings file is refused for reading and writing; writes never follow a planted temp link', () => {
  const file = tempSettingsFile();
  const dir = path.dirname(file);
  const victim = path.join(dir, 'victim.txt');
  fs.writeFileSync(victim, 'untouched');
  fs.symlinkSync(victim, file);
  assert.throws(() => createSettings({ file }), (e) => e instanceof SettingsError && e.field === 'file');
  fs.unlinkSync(file);
  const s = createSettings({ file });
  fs.symlinkSync(victim, file);
  assert.throws(() => s.update({ signin: { clientId: 'x' } }), SettingsError);
  fs.unlinkSync(file);
  // The old predictable temp name, planted as a link: the write must not go through it.
  fs.symlinkSync(victim, `${file}.${process.pid}.tmp`);
  s.update({ signin: { clientId: 'x' } });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp') && !n.includes(String(process.pid))), [], 'no temp file left behind');
});

// 11. Amount parsing.
test('amount accepts only a number or a plain decimal string', () => {
  for (const bad of [[5], true, '5e3', ' 5', '0x10', '', null, {}, '1.234']) {
    assert.throws(() => buildAuthorizationDetail({ userId: 'a', sourceAccount: 'x', destinationAccount: 'y', amount: bad }), /Amount/, JSON.stringify(bad));
  }
  assert.equal(buildAuthorizationDetail({ userId: 'a', sourceAccount: 'x', destinationAccount: 'y', amount: '250' }).amount, 250);
});

// 12. Health behind the Host check; discovery only as a same-origin POST.
test('health is behind the Host check; a GET can never trigger discovery', async () => {
  const lab = await startLab();
  try {
    const status = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: lab.port, path: '/api/health', headers: { host: 'rebind.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(status, 403);
    assert.equal((await lab.call('GET', '/api/pf/discovery?fresh=1')).status, 404);
    assert.equal(lab.fake.calls.length, 0);
    const cross = await fetch(`${lab.base}/api/pf/discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
    assert.equal(lab.fake.calls.length, 0);
  } finally { await lab.close(); }
});

// 12b. A local domain: LAB_ALLOWED_HOSTS adds names to the Host and Origin checks; anything else is still refused.
test('LAB_ALLOWED_HOSTS lets a named local domain in, and only that name', async () => {
  const lab = await startLab({ env: { LAB_ALLOWED_HOSTS: 'lab.local.example' } });
  try {
    const health = (host) => new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: lab.port, path: '/api/health', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode); });
    });
    assert.equal(await health(`lab.local.example:${lab.port}`), 200);
    assert.equal(await health(`rebind.example:${lab.port}`), 403);
    const post = (origin) => fetch(`${lab.base}/api/pf/discovery`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' }).then((r) => r.status);
    assert.equal(await post(`http://lab.local.example:${lab.port}`), 200);
    assert.equal(await post(`https://lab.local.example:${lab.port}`), 403);
    assert.equal(await post('https://evil.example'), 403);
  } finally { await lab.close(); }
});

test('labAddresses: loopback always, https origins only with a certificate and key, and a bad name stops the lab', () => {
  const plain = labAddresses({ port: 5400, env: {} });
  assert.equal(plain.scheme, 'http');
  assert.deepEqual([...plain.hosts], ['127.0.0.1:5400', 'localhost:5400', '[::1]:5400']);
  const tls = labAddresses({ port: 5400, env: { LAB_TLS_CERT: '/c', LAB_TLS_KEY: '/k', LAB_ALLOWED_HOSTS: ' Lab.Local.Example , ' } });
  assert.ok(tls.origins.has('https://lab.local.example:5400'));
  assert.ok(!tls.origins.has('http://127.0.0.1:5400'));
  assert.equal(labAddresses({ port: 5400, env: { LAB_TLS_CERT: '/c' } }).scheme, 'http');
  for (const bad of ['evil.example:80', 'a b', '*.example', 'x/y', '-a.example']) {
    assert.throws(() => labAddresses({ port: 5400, env: { LAB_ALLOWED_HOSTS: bad } }), /not a host name/);
  }
});

test('the session cookie is Secure only when the lab serves https', async () => {
  const sessionCookie = async (env) => {
    const lab = await startLab({ env });
    try {
      const res = await fetch(`${lab.base}/api/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: lab.base.replace('http:', env.LAB_TLS_CERT ? 'https:' : 'http:') }, body: '{}' });
      return res.headers.getSetCookie().join('\n');
    } finally { await lab.close(); }
  };
  assert.doesNotMatch(await sessionCookie({}), /Secure/);
  assert.match(await sessionCookie({ LAB_TLS_CERT: '/c', LAB_TLS_KEY: '/k' }), /; Secure/);
});

// 13. Provision script.
test('provision: only own ROLES properties are roles', () => {
  for (const role of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'nope']) {
    assert.throws(() => checkRoles(JSON.parse(`{"${role}":"tpl"}`)), /Unknown role/, role);
  }
  assert.throws(() => checkRoles([]), /JSON object/);
  assert.doesNotThrow(() => checkRoles({ signin: 'tpl', ciba: 'tpl2' }));
});

test('provision: settings are saved after each created client, so a later failure keeps earlier secrets', async () => {
  const file = tempSettingsFile();
  const settings = createSettings({ file });
  let posts = 0;
  const api = async (method, resource) => {
    if (method === 'GET' && resource.includes('pfLab-')) return posts >= 1 && resource.endsWith('pfLab-ciba') ? { clientId: 'pfLab-ciba' } : null;
    if (method === 'GET') return { clientId: 'tpl', clientAuth: { type: 'SECRET' } };
    posts += 1;
    if (posts === 2) throw new Error('POST oauth/clients -> HTTP 422');
    return {};
  };
  await assert.rejects(() => provision({ api, settings, templates: { ciba: 'tpl', dcrIat: 'tpl2' }, issuer: FULL_SETTINGS.pf.issuer, apply: true }), /422/);
  const saved = createSettings({ file });
  assert.equal(saved.value('ciba', 'clientId'), 'pfLab-ciba');
  assert.match(saved.value('ciba', 'clientSecret'), /^[A-Za-z0-9_-]{32}$/);
  assert.equal(saved.value('pf', 'issuer'), FULL_SETTINGS.pf.issuer);
});

test('provision: PF_ADMIN_INSECURE relaxes TLS for the admin agent only, never process-wide', async () => {
  assert.equal(adminAgent(true).options.rejectUnauthorized, false);
  assert.equal(adminAgent(false).options.rejectUnauthorized, true);
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  let seen;
  const request = (url, options, cb) => {
    seen = options;
    const req = new (class extends EventTarget { write() {} end() { const res = new (class extends http.IncomingMessage {})(null); res.statusCode = 200; cb(res); res.push('{}'); res.push(null); } on(n, f) { this.addEventListener(n, f); return this; } })();
    return req;
  };
  const api = createAdminApi({ base: 'https://pf-admin.example/pf-admin-api/v1', password: 'p', insecure: true, request });
  await api('GET', 'oauth/clients/x');
  assert.equal(seen.agent.options.rejectUnauthorized, false);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before);
  const source = fs.readFileSync(path.join(here, '../../scripts/provision-pf.mjs'), 'utf8');
  assert.ok(!source.includes('NODE_TLS_REJECT_UNAUTHORIZED'), 'the script never switches TLS checks off for the process');
});
