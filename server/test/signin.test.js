import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';
import { ORIGIN } from './fakepf.js';

test('pi.flow sign-in: JSON flow, credentials posted to the Authentication API, code redeemed with PKCE, tokens kept server-side', async () => {
  const lab = await startLab();
  try {
    const started = await lab.call('POST', '/api/signin/start');
    assert.equal(started.status, 200);
    assert.equal(started.data.state, 'credentials_required');
    assert.equal(started.data.status, 'USERNAME_PASSWORD_REQUIRED');
    assert.deepEqual(started.data.actions, ['checkUsernamePassword']);
    const done = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'correct-horse-battery' });
    assert.equal(done.data.outcome, 'accepted');
    assert.equal(done.data.identity.subject, 'alice');
    assert.equal(done.data.accessToken.kind, 'JWT');
    assert.match(done.data.accessToken.masked, /^.{6}\.\.\..{4}$/);
    assert.deepEqual(done.data.trace.map((s) => s.id), ['discovery', 'authorize', 'credentials', 'code', 'token']);

    // What PingFederate saw: response_mode=pi.flow, the XSRF header, the flow cookie replayed, PKCE at the token endpoint.
    const authorize = lab.fake.calls.find((c) => c.path === '/as/authorization.oauth2');
    assert.match(authorize.headers.accept, /application\/json/);
    const step = lab.fake.calls.find((c) => c.path.startsWith('/pf-ws/authn/flows/'));
    assert.equal(step.headers['x-xsrf-header'], 'PingFederate');
    assert.equal(step.headers['content-type'], 'application/vnd.pingidentity.checkUsernamePassword+json');
    assert.match(step.headers.cookie, /PF\.FLOW=/);
    assert.ok(lab.fake.calls.every((c) => c.origin === ORIGIN), 'only the configured PingFederate was called');
    assert.ok(lab.fake.calls.every((c) => /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/.test(c.headers.traceparent)), 'traceparent on every hop');
    assert.ok(lab.fake.calls.every((c) => c.redirect === 'manual'), 'redirects never followed');
    const traceIds = new Set(lab.fake.calls.map((c) => c.headers.traceparent.split('-')[1]));
    assert.equal(traceIds.size, 1, 'one trace id for the run');

    const me = await lab.call('GET', '/api/me');
    assert.equal(me.data.signedIn, true);
    assert.equal(me.data.user.subject, 'alice');
    assert.equal(me.data.accessToken.claims.sub, 'alice');
    assert.deepEqual(lab.leaks(), [], 'no code, verifier, token, cookie, flow id or password reached the page');
    assert.ok(!JSON.stringify(done.data.trace).includes('correct-horse-battery'));
  } finally { await lab.close(); }
});

test('a wrong password is refused and the same flow takes the right one', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    const wrong = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'nope' });
    assert.equal(wrong.data.state, 'credentials_required');
    assert.equal(wrong.data.refused, 'credential_validation_failed');
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
    const right = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'correct-horse-battery' });
    assert.equal(right.data.outcome, 'accepted');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('a flow PingFederate no longer knows (restart or expiry) ends the run as flow_gone', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start');
    lab.fake.forgetFlows();
    const gone = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'correct-horse-battery' });
    assert.equal(gone.data.outcome, 'failed');
    assert.equal(gone.data.reason, 'flow_gone');
    assert.equal(gone.data.trace.at(-1).response.status, 404);
    assert.equal((await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'x' })).data.error, 'no_run');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('credential input is bounded and needs a started run', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'x' })).data.error, 'no_run');
    await lab.call('POST', '/api/signin/start');
    for (const body of [{ username: '', password: 'x' }, { username: 'a\nb', password: 'x' }, { username: 'alice' }, { username: ['a'], password: 'x' }, { username: 'alice', password: 'p'.repeat(2000) }]) {
      assert.equal((await lab.call('POST', '/api/signin/credentials', body)).status, 400, JSON.stringify(body).slice(0, 40));
    }
  } finally { await lab.close(); }
});

test('after sign-in, a later run rides the PingFederate session (SSO) and needs no password', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const pkce = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(pkce.data.outcome, 'accepted');
    assert.ok(!pkce.data.trace.some((s) => s.id === 'credentials'));
  } finally { await lab.close(); }
});

test('sign-out drops the session and everything in it', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const out = await lab.call('POST', '/api/signout');
    assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);
  } finally { await lab.close(); }
});

test('the session cookie is HttpOnly and SameSite=Strict; sessions do not mix', async () => {
  const a = await startLab();
  try {
    const first = await a.call('POST', '/api/reset');
    assert.match(first.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    await a.signIn();
    const stranger = await fetch(`${a.base}/api/me`);
    assert.equal((await stranger.json()).signedIn, false);
    const forged = await fetch(`${a.base}/api/me`, { headers: { Cookie: 'pflab_sid=../../etc' } });
    assert.equal((await forged.json()).signedIn, false);
  } finally { await a.close(); }
});

test('pi.flow open-and-read: shows status and actions, sends no credential and no session cookie', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const before = lab.fake.calls.length;
    const res = await lab.call('POST', '/api/cards/piflow/open');
    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'USERNAME_PASSWORD_REQUIRED');
    assert.deepEqual(res.data.actions, ['checkUsernamePassword']);
    const calls = lab.fake.calls.slice(before);
    assert.deepEqual(calls.map((c) => c.method), ['GET', 'GET']);
    assert.ok(!/(^|; )PF=/.test(calls[0].headers.cookie || ''), 'fresh flow: the sign-in session cookie is not sent');
    assert.equal(calls[1].headers['x-xsrf-header'], 'PingFederate');
    assert.ok(res.data.trace.every((s) => !JSON.stringify(s).match(/flows\/[A-Za-z0-9_-]{6,}/)), 'flow id never shown');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('a refused authorization request (PingFederate HTML 400) is shown as a refusal with its words', async () => {
  const lab = await startLab();
  try {
    await lab.call('PUT', '/api/settings', { signin: { clientId: 'unknown-client' } });
    const res = await lab.call('POST', '/api/signin/start');
    assert.equal(res.data.outcome, 'refused');
    assert.equal(res.data.reason, 'http_400');
    assert.match(res.data.trace.at(-1).note, /400 - Invalid client_id/);
  } finally { await lab.close(); }
});
