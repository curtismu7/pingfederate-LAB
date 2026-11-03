// Rule 19: /api/info and /api/mode carry {source, realAvailable, realReason}; PUT accepts exactly mock|real,
// refuses real with 409 + reason when the live configuration is incomplete, and keeps mock. Bad modes 400.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';

test('with full live settings: source real, realAvailable true, no reason', async () => {
  const lab = await startLab();
  try {
    const info = (await lab.call('GET', '/api/info')).data;
    assert.equal(info.source, 'real');
    assert.equal(info.realAvailable, true);
    assert.equal(info.realReason, null);
    assert.ok(info.issuer);
  } finally { await lab.close(); }
});

test('an incomplete live configuration: realAvailable false with the reason, and PUT real is refused 409', async () => {
  const lab = await startLab({ settings: {} });
  try {
    const info = (await lab.call('GET', '/api/info')).data;
    assert.equal(info.source, 'mock');
    assert.equal(info.realAvailable, false);
    assert.match(info.realReason, /Settings page/);
    const refused = await lab.call('PUT', '/api/mode', { mode: 'real' });
    assert.equal(refused.status, 409);
    assert.match(refused.data.message, /Settings page/);
    assert.equal((await lab.call('GET', '/api/info')).data.source, 'mock');
    const keep = await lab.call('PUT', '/api/mode', { mode: 'mock' });
    assert.equal(keep.status, 200);
    assert.equal(keep.data.source, 'mock');
  } finally { await lab.close(); }
});

test('PUT /api/mode rejects unknown and missing modes with 400', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('PUT', '/api/mode', { mode: 'pretend' })).status, 400);
    assert.equal((await lab.call('PUT', '/api/mode', {})).status, 400);
    assert.equal((await lab.call('PUT', '/api/mode', { mode: 'live' })).status, 400, 'the old live alias is gone: the body is exactly mock or real');
  } finally { await lab.close(); }
});
