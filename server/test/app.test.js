import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { startLab } from './helpers.js';

const raw = (port, { method = 'GET', path = '/api/settings', headers = {}, body } = {}) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => { res.resume(); resolve(res.statusCode); });
  if (body) req.write(body);
  req.end();
});

test('health follows demo-health/1, no detail, no outbound call', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(res.data).sort(), ['at', 'demo', 'runtime', 'schema', 'state']);
    assert.equal(res.data.schema, 'demo-health/1');
    assert.equal(res.data.state, 'ready');
    assert.equal(res.data.runtime, 'live');
    assert.deepEqual(res.data.demo, { id: 'pingfederate-lab', name: 'PingFederate LAB', version: '0.1.0' });
    assert.ok(res.text.length < 4096);
    assert.equal(lab.fake.calls.length, 0);
  } finally { await lab.close(); }
  // No settings at all: mock mode, ready and offline.
  const empty = await startLab({ settings: null });
  try {
    const h = (await empty.call('GET', '/api/health')).data;
    assert.equal(h.state, 'ready');
    assert.equal(h.runtime, 'offline');
  } finally { await empty.close(); }
  const unset = await startLab({ settings: null, mode: 'live' });
  try { assert.equal((await unset.call('GET', '/api/health')).data.state, 'needs-setup'); } finally { await unset.close(); }
});

test('Host check, same-origin writes and JSON-only writes', async () => {
  const lab = await startLab();
  try {
    assert.equal(await raw(lab.port, { headers: { host: 'evil.example' } }), 403);
    assert.equal(await raw(lab.port, { headers: { host: `127.0.0.1:${lab.port}` } }), 200);
    assert.equal(await raw(lab.port, { headers: { host: `localhost:${lab.port}` } }), 200);
    const write = (headers) => raw(lab.port, { method: 'POST', path: '/api/reset', headers: { host: `127.0.0.1:${lab.port}`, 'content-type': 'application/json', ...headers }, body: '{}' });
    assert.equal(await write({ origin: 'https://evil.example' }), 403);
    assert.equal(await write({ origin: `http://127.0.0.1:${lab.port + 1}` }), 403);
    assert.equal(await write({ 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await write({ origin: `http://127.0.0.1:${lab.port}` }), 200);
    assert.equal(await raw(lab.port, { method: 'POST', path: '/api/reset', headers: { host: `127.0.0.1:${lab.port}`, 'content-type': 'text/plain' }, body: '{}' }), 415);
    assert.equal(await raw(lab.port, { method: 'POST', path: '/api/reset', headers: { host: `127.0.0.1:${lab.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' }), 415);
  } finally { await lab.close(); }
});

test('settings API: secrets write-only, validation errors are JSON, file stays 600', async () => {
  const lab = await startLab();
  try {
    const view = await lab.call('GET', '/api/settings');
    assert.deepEqual(view.data.settings.ciba.clientSecret, { set: true });
    assert.ok(!view.text.includes('ciba-secret-value-1'));
    const put = await lab.call('PUT', '/api/settings', { ciba: { clientSecret: 'brand-new-secret-9' } });
    assert.equal(put.status, 200);
    assert.ok(!put.text.includes('brand-new-secret-9'));
    assert.equal(fs.statSync(lab.file).mode & 0o777, 0o600);
    const bad = await lab.call('PUT', '/api/settings', { pf: { issuer: 'http://pf.example' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.data.error, 'invalid_setting');
    assert.equal(bad.data.field, 'pf.issuer');
    const huge = await lab.call('PUT', '/api/settings', { pf: { issuer: 'https://x.example/'.padEnd(20000, 'a') } });
    assert.equal(huge.status, 413);
    const notJson = await fetch(`${lab.base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(notJson.status, 400);
    assert.deepEqual(await notJson.json(), { error: 'bad_request' });
  } finally { await lab.close(); }
});

test('cards list: ready flags and the two link cards with configurable URLs', async () => {
  const lab = await startLab();
  try {
    const { data } = await lab.call('GET', '/api/cards');
    const byId = Object.fromEntries(data.cards.map((c) => [c.id, c]));
    for (const id of ['discovery', 'signin', 'piflow', 'pkce', 'par', 'rar', 'dpop', 'ciba', 'dcr', 'tokenExchange', 'userinfo']) assert.equal(byId[id].ready, true, id);
    assert.equal(byId.rar.variantsReady.dpop, true);
    assert.equal(byId.cimd.kind, 'link');
    assert.equal(byId.cimd.url, 'http://127.0.0.1:5250');
    assert.equal(byId.idJag.url, 'https://id-jag.example');
  } finally { await lab.close(); }
  const empty = await startLab({ settings: null, mode: 'live' });
  try {
    const { data } = await empty.call('GET', '/api/cards');
    assert.ok(data.cards.every((c) => c.ready === false));
    const start = await empty.call('POST', '/api/signin/start');
    assert.equal(start.status, 409);
    assert.equal(start.data.error, 'not_configured');
    assert.equal(empty.fake.calls.length, 0, 'nothing configured: nothing called');
  } finally { await empty.close(); }
});

test('unknown routes and cards are JSON 404s', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('GET', '/nope')).data.error, 'not_found');
    assert.equal((await lab.call('POST', '/api/cards/evil/start')).status, 404);
    assert.equal((await lab.call('POST', '/api/cards/dcr/__proto__')).status, 404);
    assert.equal((await lab.call('POST', '/api/cards/dcr/constructor')).status, 404);
  } finally { await lab.close(); }
});
