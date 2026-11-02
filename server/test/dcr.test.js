import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';

const run = async (lab, step) => lab.call('POST', `/api/cards/dcr/${step}`);

test('DCR: initial access token, refused anonymous register, register, use, forbidden scope, delete, proven gone', async () => {
  const lab = await startLab();
  try {
    const iat = await run(lab, 'initial-token');
    assert.equal(iat.status, 200);
    assert.equal(iat.data.token.claims.scope, 'dcr:register');
    const reg = await run(lab, 'register');
    assert.equal(reg.data.anonymousRefused, true);
    assert.match(reg.data.clientId, /^dcr-/);
    const anon = reg.data.trace.find((s) => s.id === 'register-anonymous');
    assert.equal(anon.response.status, 401);
    assert.equal(anon.request.headers.Authorization, undefined);
    const withIat = reg.data.trace.find((s) => s.id === 'register');
    assert.equal(withIat.request.headers.Authorization, 'Bearer <redacted>');
    assert.match(withIat.response.body.client_secret, /^<redacted/);
    assert.match(withIat.response.body.registration_access_token, /^<redacted/);
    const use = await run(lab, 'use');
    assert.equal(use.data.allowed, true);
    assert.equal(use.data.claims.client_id, reg.data.clientId);
    assert.equal(use.data.forbiddenRefused, true);
    const del = await run(lab, 'delete');
    assert.equal(del.data.gone, true);
    assert.equal(del.data.readRefused, true);
    assert.equal(del.data.tokenRefused, true);
    assert.deepEqual(del.data.trace.slice(-3).map((s) => s.id), ['delete', 'read-deleted', 'deleted-token']);
    assert.equal(lab.fake.clients.has(reg.data.clientId), false);
    const deleteCall = lab.fake.calls.find((c) => c.method === 'DELETE');
    assert.equal(deleteCall.path, `/as/clients.oauth2/${reg.data.clientId}`);
    assert.deepEqual(lab.leaks(), [], 'client secret, IAT and registration access token never reached the page');
  } finally { await lab.close(); }
});

test('DCR steps must run in order', async () => {
  const lab = await startLab();
  try {
    for (const step of ['register', 'use', 'delete']) assert.equal((await run(lab, step)).data.error, 'step_order');
    await run(lab, 'initial-token');
    assert.equal((await run(lab, 'use')).data.error, 'step_order');
  } finally { await lab.close(); }
});

test('DCR reports open registration and a delete that did not take', async () => {
  const lab = await startLab({ fake: { openRegistration: true, keepDeletedClient: true } });
  try {
    await run(lab, 'initial-token');
    const reg = await run(lab, 'register');
    assert.equal(reg.data.anonymousRefused, false);
    assert.match(reg.data.trace.find((s) => s.id === 'register-anonymous').note, /open registration is on/);
    await run(lab, 'use');
    const del = await run(lab, 'delete');
    assert.equal(del.data.gone, false);
    assert.equal(del.data.alsoDeleted.length, 1, 'the anonymously registered client is cleaned up too');
    assert.notEqual(del.data.alsoDeleted[0], reg.data.clientId);
  } finally { await lab.close(); }
});

test('Reset while a client is registered says which client is left on PingFederate', async () => {
  const lab = await startLab();
  try {
    await run(lab, 'initial-token');
    const reg = await run(lab, 'register');
    const reset = await lab.call('POST', '/api/reset');
    assert.deepEqual(reset.data.dcrClientsLeftOnPingFederate, [reg.data.clientId]);
  } finally { await lab.close(); }
});

// Mock mode: Clear and Reset delete the clients a half-finished run left on the in-process mock; live mode never deletes on its own.
const mockDcrLab = () => startLab({ settings: null, env: { ALLOW_MOCK_SIGNIN: '1' } });
const leftOnMock = (lab) => [...lab.app.locals.mock.registered.keys()];

test('mock DCR: Reset deletes the leftover client from the mock and lists none', async () => {
  const lab = await mockDcrLab();
  try {
    await run(lab, 'initial-token');
    const reg = await run(lab, 'register');
    assert.deepEqual(leftOnMock(lab), [reg.data.clientId]);
    const reset = await lab.call('POST', '/api/reset');
    assert.deepEqual(reset.data.dcrClientsLeftOnPingFederate, []);
    assert.deepEqual(leftOnMock(lab), [], 'the mock no longer holds the client');
    assert.equal((await run(lab, 'initial-token')).status, 200, 'a new run is not blocked');
  } finally { await lab.close(); }
});

test('mock DCR: the Playground Clear (discard) deletes the leftover client; npm run reset does too', async () => {
  const lab = await mockDcrLab();
  try {
    await run(lab, 'initial-token');
    const reg = await run(lab, 'register');
    const cleared = await run(lab, 'discard');
    assert.deepEqual(cleared.data.deleted, [reg.data.clientId]);
    assert.deepEqual(leftOnMock(lab), []);
    assert.equal((await run(lab, 'discard')).data.deleted.length, 0, 'nothing left is not an error');
    await run(lab, 'initial-token');
    await run(lab, 'register');
    assert.equal(leftOnMock(lab).length, 1);
    const all = await lab.call('POST', '/api/workspaces/default/reset');
    assert.deepEqual(all.data.dcrClientsLeftOnPingFederate, []);
    assert.deepEqual(leftOnMock(lab), []);
  } finally { await lab.close(); }
});

test('live DCR: discard and Reset never delete on their own', async () => {
  const lab = await startLab();
  try {
    await run(lab, 'initial-token');
    const reg = await run(lab, 'register');
    assert.deepEqual((await run(lab, 'discard')).data, { deleted: [] });
    assert.equal(lab.fake.registered.size, 1, 'the real client is untouched');
    const reset = await lab.call('POST', '/api/reset');
    assert.deepEqual(reset.data.dcrClientsLeftOnPingFederate, [reg.data.clientId]);
    assert.equal(lab.fake.registered.size, 1);
  } finally { await lab.close(); }
});
