import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOutbound, OutboundRefused, assertAllowed } from '../src/outbound.js';

const ISSUER = 'https://pf.example';

function recorder(reply = () => new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })) {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return reply(url, init); };
  return { seen, fetchImpl };
}

test('a call to any host other than the configured PingFederate is refused before fetch runs', async () => {
  const r = recorder();
  const out = createOutbound({ getIssuer: () => ISSUER, fetchImpl: r.fetchImpl });
  for (const target of ['https://evil.example/x', 'https://pf.example.evil.example/', 'https://pf.example:8443/x', 'http://pf.example/x', 'https://u:p@pf.example/x', 'file:///etc/passwd', 'not-a-url']) {
    await assert.rejects(() => out.call(target), OutboundRefused, target);
  }
  assert.equal(r.seen.length, 0, 'fetch was never invoked');
  await out.call('https://pf.example/as/token.oauth2');
  assert.equal(r.seen.length, 1);
});

test('no issuer, or a non-https issuer, refuses everything', async () => {
  const r = recorder();
  for (const issuer of ['', null, 'http://pf.example', 'https://u:p@pf.example']) {
    const out = createOutbound({ getIssuer: () => issuer, fetchImpl: r.fetchImpl });
    await assert.rejects(() => out.call('https://pf.example/x'), OutboundRefused);
  }
  assert.equal(r.seen.length, 0);
  assert.throws(() => assertAllowed('https://pf.example/x', ''), (e) => e.reason === 'not_configured');
});

test('redirects are never followed and an off-origin Location is not revealed', async () => {
  const r = recorder(() => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/steal?code=1' } }));
  const out = createOutbound({ getIssuer: () => ISSUER, fetchImpl: r.fetchImpl });
  const res = await out.call('https://pf.example/as/authorization.oauth2');
  assert.equal(r.seen[0].init.redirect, 'manual');
  assert.equal(res.status, 302);
  assert.equal(res.location, '<another origin, not followed>');
  assert.equal(r.seen.length, 1);
  const same = createOutbound({ getIssuer: () => ISSUER, fetchImpl: async () => new Response(null, { status: 302, headers: { Location: '/login?x=secret' } }) });
  assert.equal((await same.call('https://pf.example/a')).location, 'https://pf.example/login');
});

test('every call carries a W3C traceparent, sharing the run trace id; a timeout signal is set', async () => {
  const r = recorder();
  const out = createOutbound({ getIssuer: () => ISSUER, fetchImpl: r.fetchImpl });
  const traceId = 'a'.repeat(32);
  const res = await out.call('https://pf.example/x', { traceId });
  await out.call('https://pf.example/y', { traceId });
  const [a, b] = r.seen.map((s) => s.init.headers.traceparent);
  assert.match(a, /^00-a{32}-[0-9a-f]{16}-01$/);
  assert.notEqual(a, b, 'a new span per hop');
  assert.equal(res.traceparent, a);
  assert.ok(r.seen[0].init.signal instanceof AbortSignal);
});

test('bodies over the cap are cut and not parsed; an unreachable server is a refusal', async () => {
  const big = 'x'.repeat(5000);
  const out = createOutbound({ getIssuer: () => ISSUER, maxBytes: 1000, fetchImpl: async () => new Response(JSON.stringify({ big }), { status: 200 }) });
  const res = await out.call('https://pf.example/x');
  assert.equal(res.truncated, true);
  assert.equal(res.text.length, 1000);
  assert.equal(res.json, null);
  const down = createOutbound({ getIssuer: () => ISSUER, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  await assert.rejects(() => down.call('https://pf.example/x'), (e) => e.reason === 'unreachable');
});

test('no module but outbound.js calls fetch or opens a socket', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src');
  for (const name of fs.readdirSync(dir)) {
    if (name === 'outbound.js') continue;
    let text = fs.readFileSync(path.join(dir, name), 'utf8').replace(/fetchImpl/g, '');
    if (name === 'index.js') {
      // The one exception: index.js imports node:https only to LISTEN with the lab's certificate. It may create a
      // server and nothing else from it.
      assert.doesNotMatch(text, /https\.(?!createServer\b)\w+/, 'index.js uses https for more than createServer');
      text = text.replace("import https from 'node:https';", '');
    }
    assert.doesNotMatch(text, /\bfetch\s*\(/, `${name} calls fetch`);
    assert.doesNotMatch(text, /node:(https?|net|tls|dgram)'|undici/, `${name} imports a network module`);
  }
});
