import crypto from 'node:crypto';

// Small JOSE helpers on Node's built-in crypto: PKCE, DPoP keys and proofs (RFC 9449), JWK thumbprints (RFC 7638)
// and ID token verification. EC keys are built with createECDH + createPrivateKey: the EC variants of generateKeyPairSync and
// the async EC generateKeyPair can abort Node 20 (SIGABRT in the keygen job's GC finalizer).

const b64u = (value) => Buffer.from(value).toString('base64url');

export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: s256(verifier), method: 'S256' };
}

export const s256 = (text) => crypto.createHash('sha256').update(text).digest('base64url');

export function jwkThumbprint(jwk) {
  return s256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}

// A fresh P-256 key for one run. The private key stays in this process's memory, inside the server-side session.
export function createEcKey() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const point = ecdh.getPublicKey(); // 0x04 || X || Y
  const publicJwk = { kty: 'EC', crv: 'P-256', x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33, 65)) };
  const privateKey = crypto.createPrivateKey({ key: { ...publicJwk, d: b64u(ecdh.getPrivateKey()) }, format: 'jwk' });
  return { privateKey, publicJwk, jkt: jwkThumbprint(publicJwk) };
}

export function signEs256(header, payload, privateKey) {
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64u(signature)}`;
}

// RFC 9449 section 4.2. htu has no query or fragment.
export function dpopProof({ key, htu, htm = 'POST', nonce, accessToken, now = Date.now }) {
  const url = new URL(htu);
  return signEs256(
    { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk },
    {
      htu: `${url.origin}${url.pathname}`,
      htm: String(htm).toUpperCase(),
      iat: Math.floor(now() / 1000),
      jti: crypto.randomUUID(),
      ...(nonce ? { nonce } : {}),
      ...(accessToken ? { ath: s256(accessToken) } : {}),
    },
    key.privateKey,
  );
}

const ALGS = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  PS384: { hash: 'sha384', kty: 'RSA', pss: true },
  PS512: { hash: 'sha512', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC' },
  ES384: { hash: 'sha384', kty: 'EC' },
  ES512: { hash: 'sha512', kty: 'EC' },
};

export class JwtInvalid extends Error {}

// An ID token valid for more than a year is refused.
export const MAX_LIFETIME_S = 366 * 24 * 60 * 60;

function decode(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new JwtInvalid('not a JWT');
  try {
    return {
      parts,
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
    };
  } catch { throw new JwtInvalid('unreadable JWT'); }
}

// Verifies signature (against the issuer's JWKS), iss, aud, exp and, when given, nonce. Returns the claims.
export function verifyIdToken(token, { jwks, issuer, audience, nonce, now = Date.now, skewSeconds = 60 }) {
  const { parts, header, payload } = decode(token);
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new JwtInvalid('header is not an object');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new JwtInvalid('payload is not an object');
  const alg = Object.hasOwn(ALGS, header?.alg) ? ALGS[header.alg] : null;
  if (!alg) throw new JwtInvalid('signing algorithm not allowed');
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  const jwk = keys.find((k) => k && k.kty === alg.kty && (!header.kid || k.kid === header.kid)
    && (!k.use || k.use === 'sig') && (!k.alg || k.alg === header.alg));
  if (!jwk) throw new JwtInvalid('signing key not found');
  let good = false;
  try {
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const options = alg.kty === 'EC' ? { key, dsaEncoding: 'ieee-p1363' }
      : alg.pss ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : key;
    good = crypto.verify(alg.hash, Buffer.from(`${parts[0]}.${parts[1]}`), options, Buffer.from(parts[2], 'base64url'));
  } catch { good = false; }
  if (!good) throw new JwtInvalid('signature did not verify');
  const t = Math.floor(now() / 1000);
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (payload.iss !== issuer) throw new JwtInvalid('issuer does not match');
  if (!auds.includes(audience)) throw new JwtInvalid('audience does not match');
  if (auds.length > 1 && payload.azp !== audience) throw new JwtInvalid('azp does not match');
  // Time claims are numbers in a sane range, so later date arithmetic cannot throw.
  if (!Number.isFinite(payload.exp)) throw new JwtInvalid('exp is not a number');
  if (payload.exp + skewSeconds < t) throw new JwtInvalid('expired');
  if (payload.exp > t + MAX_LIFETIME_S) throw new JwtInvalid('exp is too far in the future');
  if (payload.iat !== undefined && (!Number.isFinite(payload.iat) || payload.iat > t + skewSeconds)) throw new JwtInvalid('iat is invalid or in the future');
  if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > t + skewSeconds)) throw new JwtInvalid('not valid yet (nbf)');
  if (nonce !== undefined && payload.nonce !== nonce) throw new JwtInvalid('nonce does not match');
  if (typeof payload.sub !== 'string' || !payload.sub) throw new JwtInvalid('no subject');
  return payload;
}
