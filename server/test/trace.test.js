import test from 'node:test';
import assert from 'node:assert/strict';
import { safeParams, safeBody, safeHeaders, masked, tokenView, claimsOf, traceparent, bareUrl } from '../src/trace.js';

const jwt = `${Buffer.from('{"alg":"ES256"}').toString('base64url')}.${Buffer.from('{"sub":"alice","scope":"a b"}').toString('base64url')}.c2lnbmF0dXJlLXZhbHVlLWhlcmU`;

test('secrets are redacted to kind and length; tokens are masked first 6 + last 4', () => {
  const out = safeParams(new URLSearchParams({
    code: 'the-code-1234567', code_verifier: 'verifier-abcdefghijk', client_secret: 'sssssssssss', refresh_token: 'rrrrrrrrrrrrrrrrrrr',
    registration_access_token: 'ratratratratratrat', auth_req_id: 'authreqidauthreqid', password: 'pw-pw-pw', subject_token: jwt,
    client_id: 'my-client', scope: 'openid', state: 'abcdefghijklmnopqrstuvwxyz', authorization_details: '[{"type":"banking_transaction"}]',
  }));
  for (const key of ['code', 'code_verifier', 'client_secret', 'refresh_token', 'registration_access_token', 'auth_req_id', 'password']) {
    assert.match(out[key], /^<redacted (JWT|opaque), \d+ chars>$/, key);
  }
  assert.deepEqual(out.subject_token, { masked: `${jwt.slice(0, 6)}...${jwt.slice(-4)}`, length: jwt.length, kind: 'JWT' });
  assert.equal(out.client_id, 'my-client');
  assert.equal(out.scope, 'openid');
  assert.equal(out.state, 'abcdefgh...');
  assert.deepEqual(out.authorization_details, [{ type: 'banking_transaction' }]);
  assert.equal(masked('short').masked, '<too short to mask>');
});

test('bodies are redacted at any depth, and objects under secret keys too', () => {
  const body = safeBody({ access_token: jwt, nested: { client_secret: 'abc123abc123', list: [{ refresh_token: 'zzzzzzzzzzzzzzzzzz' }] }, password: { a: 1 }, ok: 1 });
  const text = JSON.stringify(body);
  for (const s of ['abc123abc123', 'zzzzzzzzzzzzzzzzzz', jwt]) assert.ok(!text.includes(s), s);
  assert.equal(body.ok, 1);
  let deep = {}; const root = deep;
  for (let i = 0; i < 5000; i += 1) { deep.next = {}; deep = deep.next; }
  assert.doesNotThrow(() => safeBody(root), 'deep input is bounded');
});

test('headers: Authorization keeps only its scheme; DPoP proofs and cookies are hidden', () => {
  const h = safeHeaders({ Authorization: 'Bearer abc.def.ghi', DPoP: 'x.y.z', Cookie: 'PF=1', Accept: 'application/json' });
  assert.equal(h.Authorization, 'Bearer <redacted>');
  assert.equal(h.DPoP, '<redacted DPoP proof JWT>');
  assert.equal(h.Cookie, '<redacted PingFederate session cookies>');
  assert.equal(h.Accept, 'application/json');
});

test('claims are decoded; opaque tokens have none; URLs lose their query', () => {
  assert.deepEqual(claimsOf(jwt), { sub: 'alice', scope: 'a b' });
  assert.equal(claimsOf('opaque-token'), null);
  assert.equal(tokenView(jwt).claims.sub, 'alice');
  assert.equal(tokenView(null), null);
  assert.equal(bareUrl('https://pf.example/as/authorization.oauth2?code=1'), 'https://pf.example/as/authorization.oauth2');
  assert.equal(bareUrl('https://idp.example/flows/<flow id>'), 'https://idp.example/flows/<flow id>');
  // Error codes are labels and stay readable; an authorization code next to them stays masked.
  assert.deepEqual(safeBody({ code: 'INVALID_TOKEN', message: 'm', details: [{ code: 'INVALID_VALUE', message: 'd' }] }),
    { code: 'INVALID_TOKEN', message: 'm', details: [{ code: 'INVALID_VALUE', message: 'd' }] });
  assert.match(safeBody({ code: 'abcDEF123', message: 'm' }).code, /^<redacted/);
  assert.match(safeBody({ code: 'SECRETCODE' }).code, /^<redacted/);
  assert.match(traceparent(), /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});
