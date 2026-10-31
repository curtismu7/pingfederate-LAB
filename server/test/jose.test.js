import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { s256, pkce, createEcKey, dpopProof, jwkThumbprint, signEs256, verifyIdToken, JwtInvalid } from '../src/jose.js';

test('PKCE S256 matches RFC 7636 appendix B', () => {
  assert.equal(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const p = pkce();
  assert.equal(p.challenge, s256(p.verifier));
  assert.equal(p.method, 'S256');
  assert.ok(p.verifier.length >= 43);
});

test('DPoP proof: header carries the public key, payload has htu without query, verifies with that key', () => {
  const key = createEcKey();
  const proof = dpopProof({ key, htu: 'https://pf.example/as/token.oauth2?x=1', htm: 'post', nonce: 'n1', accessToken: 'tok' });
  const [h, p, s] = proof.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url'));
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(header.typ, 'dpop+jwt');
  assert.ok(!('d' in header.jwk), 'no private part');
  assert.equal(payload.htu, 'https://pf.example/as/token.oauth2');
  assert.equal(payload.htm, 'POST');
  assert.equal(payload.nonce, 'n1');
  assert.equal(payload.ath, s256('tok'));
  const pub = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url')));
  assert.equal(jwkThumbprint(header.jwk), key.jkt);
});

test('ID token verification: good token passes; each broken property is refused', () => {
  const key = createEcKey();
  const jwks = { keys: [{ ...key.publicJwk, kid: 'k1', alg: 'ES256', use: 'sig' }] };
  const t = Math.floor(Date.now() / 1000);
  const base = { iss: 'https://pf.example', aud: 'c1', sub: 'alice', nonce: 'n', exp: t + 60 };
  const make = (claims, header = { alg: 'ES256', kid: 'k1' }, signer = key) => signEs256(header, claims, signer.privateKey);
  const opts = { jwks, issuer: 'https://pf.example', audience: 'c1', nonce: 'n' };
  assert.equal(verifyIdToken(make(base), opts).sub, 'alice');
  const bad = [
    make({ ...base, iss: 'https://other.example' }),
    make({ ...base, aud: 'c2' }),
    make({ ...base, nonce: 'm' }),
    make({ ...base, exp: t - 3600 }),
    make({ ...base, aud: ['c1', 'c2'] }),
    make(base, { alg: 'ES256', kid: 'k1' }, createEcKey()),
    make(base, { alg: 'none', kid: 'k1' }),
    make(base, { alg: 'HS256', kid: 'k1' }),
    make(base, { alg: 'ES256', kid: 'other' }),
    'not.a.jwt',
    'two.parts',
  ];
  for (const token of bad) assert.throws(() => verifyIdToken(token, opts), JwtInvalid);
});
