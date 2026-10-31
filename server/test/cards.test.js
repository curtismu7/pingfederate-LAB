import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';
import { buildAuthorizationDetail } from '../src/cards.js';

test('discovery check lists what PingFederate supports', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('POST', '/api/pf/discovery');
    assert.equal(res.status, 200);
    assert.equal(res.data.issuer, 'https://pf.example');
    const f = Object.fromEntries(res.data.features.map((x) => [x.id, x.supported]));
    assert.deepEqual(f, { pkce: true, par: true, rar: true, dpop: true, ciba: true, dcr: true, tokenExchange: true, userinfo: true, clientCredentials: true, cimd: false });
    assert.equal(res.data.trace[0].request.url, 'https://pf.example/.well-known/openid-configuration');
  } finally { await lab.close(); }
});

test('discovery is refused when the issuer differs or an endpoint leaves the PingFederate origin', async () => {
  for (const [discovery, code] of [
    [{ issuer: 'https://other.example' }, 'discovery_issuer_mismatch'],
    [{ token_endpoint: 'https://evil.example/token' }, 'discovery_invalid'],
    [{ pushed_authorization_request_endpoint: 'http://pf.example/par' }, 'discovery_invalid'],
    [{ jwks_uri: undefined }, 'discovery_invalid'],
  ]) {
    const lab = await startLab({ fake: { discovery } });
    try {
      const res = await lab.call('POST', '/api/pf/discovery');
      assert.equal(res.status, 502);
      assert.equal(res.data.error, code);
      assert.ok(Array.isArray(res.data.trace), 'the trace up to the failure is shown');
      assert.ok(lab.fake.calls.every((c) => c.origin === 'https://pf.example'));
    } finally { await lab.close(); }
  }
});

test('PKCE card: S256 challenge in the request, verifier at the token endpoint (redacted in the trace)', async () => {
  const lab = await startLab();
  try {
    const started = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(started.data.state, 'credentials_required');
    const done = await lab.call('POST', '/api/cards/pkce/credentials', { username: 'alice', password: 'correct-horse-battery' });
    assert.equal(done.data.outcome, 'accepted');
    const authorize = done.data.trace.find((s) => s.id === 'authorize');
    assert.equal(authorize.request.params.code_challenge_method, 'S256');
    assert.equal(authorize.request.params.response_mode, 'pi.flow');
    const token = done.data.trace.find((s) => s.id === 'token');
    assert.match(token.request.params.code_verifier, /^<redacted/);
    assert.match(token.request.params.code, /^<redacted/);
    assert.equal((await lab.call('GET', '/api/cards/pkce/result')).data.outcome, 'accepted');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('login_hint: sent when a user is given (and RAR sends its user_id), echoed for the sign-in form, bounded', async () => {
  const lab = await startLab();
  try {
    const plain = await lab.call('POST', '/api/cards/pkce/start');
    assert.equal(plain.data.trace.find((s) => s.id === 'authorize').request.params.login_hint, undefined);
    assert.equal(plain.data.loginHint, undefined);
    const hinted = await lab.call('POST', '/api/cards/pkce/start', { loginHint: ' alice ' });
    assert.equal(hinted.data.trace.find((s) => s.id === 'authorize').request.params.login_hint, 'alice');
    assert.equal(hinted.data.loginHint, 'alice');
    const signin = await lab.call('POST', '/api/signin/start', { loginHint: 'alice' });
    assert.equal(signin.data.trace.find((s) => s.id === 'authorize').request.params.login_hint, 'alice');
    const par = await lab.call('POST', '/api/cards/par/start', { loginHint: 'alice' });
    assert.equal(par.data.trace.find((s) => s.id === 'par').request.params.login_hint, 'alice');
    const rar = await lab.call('POST', '/api/cards/rar/start', { amount: 10, userId: 'alice' });
    assert.equal(rar.data.trace.find((s) => s.id === 'par').request.params.login_hint, 'alice');
    assert.equal(rar.data.loginHint, 'alice');
    assert.equal((await lab.call('POST', '/api/cards/dpop/start', { loginHint: 'a\nb' })).data.error, 'bad_login_hint');
    assert.equal((await lab.call('POST', '/api/cards/dpop/start', { loginHint: 'x'.repeat(257) })).data.error, 'bad_login_hint');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('PAR card: pushed request, then only client_id + request_uri on the authorization request', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/par/start');
    assert.equal(res.data.outcome, 'accepted');
    const par = res.data.trace.find((s) => s.id === 'par');
    assert.equal(par.response.status, 201);
    assert.match(par.response.body.request_uri, /^urn:ietf:params:oauth:request_uri:.{8}\.\.\.$/);
    assert.equal(par.request.headers.Authorization, 'Basic <redacted>');
    const authorize = res.data.trace.find((s) => s.id === 'authorize');
    assert.deepEqual(Object.keys(authorize.request.params).sort(), ['client_id', 'request_uri', 'response_mode']);
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('RAR card: banking_transaction pushed by PAR and returned in the token; a detail over the limit is refused', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const ok = await lab.call('POST', '/api/cards/rar/start', { amount: 250, currency: 'EUR' });
    assert.equal(ok.data.outcome, 'accepted');
    assert.equal(ok.data.authorizationDetails[0].type, 'banking_transaction');
    assert.equal(ok.data.authorizationDetails[0].amount, 250);
    assert.equal(ok.data.accessToken.claims.authorization_details[0].currency, 'EUR');
    const pushed = ok.data.trace.find((s) => s.id === 'par').request.params.authorization_details[0];
    assert.deepEqual(pushed.actions, ['transfer']);
    // The signed-in user and the accounts from Settings, unless the card names others.
    assert.deepEqual([pushed.user_id, pushed.source_account, pushed.destination_account], ['alice', 'acct-1', 'acct-2']);
    const named = await lab.call('POST', '/api/cards/rar/start', { amount: 10, userId: 'bob', sourceAccount: 'b-1', destinationAccount: 'b-2' });
    const namedDetail = named.data.trace.find((s) => s.id === 'par').request.params.authorization_details[0];
    assert.deepEqual([namedDetail.user_id, namedDetail.source_account, namedDetail.destination_account], ['bob', 'b-1', 'b-2']);
    const refused = await lab.call('POST', '/api/cards/rar/start', { amount: 9000 });
    assert.equal(refused.data.outcome, 'refused');
    assert.equal(refused.data.reason, 'invalid_authorization_details');
    assert.equal(refused.data.trace.find((s) => s.id === 'par').response.body.error_description, 'transaction amount exceeds the user limit');
    for (const bad of [{ amount: -1 }, { amount: 'lots' }, { currency: 'usd' }, { sourceAccount: '<script>' }, { destinationAccount: 'a'.repeat(65) }]) {
      assert.equal((await lab.call('POST', '/api/cards/rar/start', bad)).status, 400, JSON.stringify(bad));
    }
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('RAR with DPoP: the token is DPoP-bound to this run key (cnf.jkt), after the nonce retry', async () => {
  const lab = await startLab({ fake: { dpopNonce: true } });
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/rar/start', { dpop: true });
    assert.equal(res.data.outcome, 'accepted');
    assert.equal(res.data.dpop.tokenType, 'DPoP');
    assert.equal(res.data.dpop.cnfJkt, res.data.dpop.jkt);
    assert.equal(res.data.dpop.bound, true);
    const token = res.data.trace.find((s) => s.id === 'token');
    assert.match(token.note, /nonce/);
    assert.equal(token.request.headers.DPoP, '<redacted DPoP proof JWT>');
    const tokenCalls = lab.fake.calls.filter((c) => c.path === '/as/token.oauth2' && c.headers.dpop);
    assert.equal(tokenCalls.length, 2, 'one proof, then one with the nonce');
    assert.deepEqual(lab.leaks(), [], 'no DPoP proof reached the page');
  } finally { await lab.close(); }
});

test('DPoP card: token type DPoP and the cnf.jkt thumbprint; an unbound answer is refused', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const res = await lab.call('POST', '/api/cards/dpop/start');
    assert.equal(res.data.outcome, 'accepted');
    assert.equal(res.data.tokenType, 'DPoP');
    assert.match(res.data.dpop.jkt, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(res.data.accessToken.claims.cnf.jkt, res.data.dpop.jkt);
    // Point the DPoP card at a client PingFederate does not bind: the Bearer answer must not pass as DPoP.
    await lab.call('PUT', '/api/settings', { dpop: { clientId: 'pkce-client' } });
    const unbound = await lab.call('POST', '/api/cards/dpop/start');
    assert.equal(unbound.data.outcome, 'failed');
    assert.equal(unbound.data.reason, 'dpop_not_bound');
  } finally { await lab.close(); }
});

test('Reset clears card results but keeps the sign-in', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    await lab.call('POST', '/api/cards/pkce/start');
    const reset = await lab.call('POST', '/api/reset');
    assert.equal(reset.data.ok, true);
    assert.equal((await lab.call('GET', '/api/cards/pkce/result')).data.state, 'none');
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, true);
  } finally { await lab.close(); }
});

test('authorization detail builder rounds and bounds, and needs a user and both accounts', () => {
  const who = { userId: 'alice', sourceAccount: 'a-1', destinationAccount: 'a-2' };
  assert.equal(buildAuthorizationDetail({ ...who, amount: 12.345 }).amount, 12.35);
  assert.equal(buildAuthorizationDetail({ ...who, amount: '12.34' }).amount, 12.34);
  assert.throws(() => buildAuthorizationDetail({ ...who, amount: 1e7 }));
  assert.deepEqual(Object.keys(buildAuthorizationDetail(who)).sort(), ['actions', 'amount', 'currency', 'destination_account', 'source_account', 'type', 'user_id']);
  assert.throws(() => buildAuthorizationDetail({ ...who, userId: '' }), /Name the user/);
  assert.throws(() => buildAuthorizationDetail({ ...who, userId: 'a\nb' }), /Name the user/);
  assert.throws(() => buildAuthorizationDetail({ ...who, sourceAccount: undefined }), /from and to accounts/);
});

test('RAR card: without a signed-in user or a named one, the lab says so before calling PingFederate', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('POST', '/api/cards/rar/start', { amount: 10 });
    assert.equal(res.status, 400);
    assert.equal(res.data.error, 'rar_user_required');
    assert.equal(lab.fake.calls.length, 0);
  } finally { await lab.close(); }
});

test('Userinfo card: needs a sign-in; reads the claims with the access token, same subject as the ID token, token never shown', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('POST', '/api/cards/userinfo/read')).data.error, 'signin_required');
    await lab.signIn();
    const ok = await lab.call('POST', '/api/cards/userinfo/read');
    assert.equal(ok.data.outcome, 'accepted');
    assert.equal(ok.data.subMatches, true);
    assert.deepEqual(ok.data.claims, ['sub', 'name', 'given_name', 'family_name', 'preferred_username', 'email']);
    const step = ok.data.trace.find((s) => s.id === 'userinfo');
    assert.doesNotMatch(JSON.stringify(step.request.headers), /eyJ/);
    assert.equal(step.response.body.email, 'alice@example.invalid');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});
