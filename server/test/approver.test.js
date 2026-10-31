import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startLab, FULL_SETTINGS } from './helpers.js';

const SECRET = 'approver-secret-value-1';
const WITH_APPROVER = { ...FULL_SETTINGS, ciba: { ...FULL_SETTINGS.ciba, approverSecret: SECRET } };

// What PingFederate's web-approver plugin sends: server to server, Bearer shared secret, no Origin, no cookie.
const asPingFederate = (lab, method, path, body, secret = SECRET) => fetch(`${lab.base}${path}`, {
  method,
  headers: { Accept: 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});

test('approver: 404 without the secret or with a wrong one; registers and answers with it; never creates a session', async () => {
  const off = await startLab();
  try {
    const res = await asPingFederate(off, 'POST', '/api/ciba-approver/requests', { transactionId: crypto.randomUUID(), subject: 'alice' });
    assert.equal(res.status, 404);
  } finally { await off.close(); }

  const lab = await startLab({ settings: WITH_APPROVER });
  try {
    const id = crypto.randomUUID();
    assert.equal((await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: id, subject: 'alice' }, 'wrong')).status, 404);
    assert.equal((await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: id, subject: 'alice' }, null)).status, 404);
    const ok = await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: id, subject: 'alice', bindingMessage: 'PAY-42' });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.headers.getSetCookie(), []);
    const look = await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${id}`);
    assert.deepEqual(await look.json(), { status: 'pending' });
    assert.deepEqual(look.headers.getSetCookie(), []);
    assert.equal((await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${crypto.randomUUID()}`)).status, 404);
    assert.equal((await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: 'not-a-uuid', subject: 'alice' })).status, 400);
    assert.equal((await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: crypto.randomUUID(), subject: 'a\nb' })).status, 400);
    // The secret is write-only like every other secret.
    const view = await lab.call('GET', '/api/settings');
    assert.deepEqual(view.data.settings.ciba.approverSecret, { set: true });
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('approver: holds at most 50 requests, oldest out first', async () => {
  const lab = await startLab({ settings: WITH_APPROVER });
  try {
    const ids = Array.from({ length: 55 }, () => crypto.randomUUID());
    for (const id of ids) assert.equal((await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: id, subject: 'alice' })).status, 200);
    assert.equal((await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${ids[0]}`)).status, 404);
    assert.equal((await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${ids.at(-1)}`)).status, 200);
  } finally { await lab.close(); }
});

test('CIBA card: waits for PingFederate to ask, then the person who started it approves; PingFederate sees "approved"', async () => {
  const lab = await startLab({ settings: WITH_APPROVER, fake: { cibaPolls: 99 } });
  try {
    const start = await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice', bindingMessage: 'PAY-42' });
    assert.equal(start.data.approval, 'waiting');
    assert.equal((await lab.call('POST', '/api/cards/ciba/decision', { decision: 'approve' })).data.error, 'not_asked_yet');

    const id = crypto.randomUUID();
    await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: id, subject: 'Alice', bindingMessage: 'PAY-42' });
    assert.equal((await lab.call('POST', '/api/cards/ciba/poll')).data.approval, 'lab');

    // Another browser (no session cookie) cannot decide it.
    const stranger = await fetch(`${lab.base}/api/cards/ciba/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: lab.base }, body: JSON.stringify({ decision: 'approve' }) });
    assert.equal(stranger.status, 409);
    assert.equal((await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${id}`).then((r) => r.json())).status, 'pending');

    assert.equal((await lab.call('POST', '/api/cards/ciba/decision', { decision: 'maybe' })).data.error, 'decision_invalid');
    const decided = await lab.call('POST', '/api/cards/ciba/decision', { decision: 'approve' });
    assert.equal(decided.status, 200);
    assert.ok(decided.data.trace.some((s) => s.id === 'decision' && /alice approved/.test(s.title)));
    assert.deepEqual(await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${id}`).then((r) => r.json()), { status: 'approved' });
  } finally { await lab.close(); }
});

test('CIBA card: a request PingFederate registers DURING the backchannel call is offered (as the real authenticator does)', async () => {
  let lab;
  const id = crypto.randomUUID();
  lab = await startLab({ settings: WITH_APPROVER, fake: { cibaPolls: 99, onBackchannel: async ({ hint }) => {
    await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: id, subject: hint });
  } } });
  try {
    const start = await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice' });
    assert.equal(start.data.approval, 'lab');
    await lab.call('POST', '/api/cards/ciba/decision', { decision: 'approve' });
    assert.equal((await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${id}`).then((r) => r.json())).status, 'approved');
  } finally { await lab.close(); }
});

test('CIBA card: deny reaches PingFederate as "denied"; a request from before the run is not offered', async () => {
  const lab = await startLab({ settings: WITH_APPROVER, fake: { cibaPolls: 99 } });
  try {
    const old = crypto.randomUUID();
    await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: old, subject: 'alice' });
    await new Promise((r) => setTimeout(r, 5));
    const start = await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice' });
    assert.equal(start.data.approval, 'waiting');
    const id = crypto.randomUUID();
    await asPingFederate(lab, 'POST', '/api/ciba-approver/requests', { transactionId: id, subject: 'alice' });
    await lab.call('POST', '/api/cards/ciba/decision', { decision: 'deny' });
    assert.equal((await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${id}`).then((r) => r.json())).status, 'denied');
    assert.equal((await asPingFederate(lab, 'GET', `/api/ciba-approver/requests/${old}`).then((r) => r.json())).status, 'pending');
  } finally { await lab.close(); }
});

test('CIBA card without the approver secret: no approval channel, so the page says PingFederate handles it', async () => {
  const lab = await startLab({ fake: { cibaPolls: 99 } });
  try {
    const start = await lab.call('POST', '/api/cards/ciba/start', { loginHint: 'alice' });
    assert.equal(start.data.approval, null);
    assert.equal((await lab.call('POST', '/api/cards/ciba/decision', { decision: 'approve' })).data.error, 'not_asked_yet');
  } finally { await lab.close(); }
});

test('provision-pf-ciba-approver: dry run changes nothing; apply copies the plugin and policy, saves the secret, and re-points only the lab client', async () => {
  const { provisionCibaApprover } = await import('../../scripts/provision-pf-ciba-approver.mjs');
  const { createSettings } = await import('../src/settings.js');
  const { tempSettingsFile } = await import('./helpers.js');
  const file = tempSettingsFile();
  const settings = createSettings({ file });
  settings.update({ ciba: { clientId: 'pfLab-ciba' } });
  const store = {
    'oauth/outOfBandAuthPlugins/tplPlugin': { id: 'tplPlugin', name: 'x', lastModified: 'd', pluginDescriptorRef: { id: 'web' }, configuration: { tables: [], fields: [{ name: 'Approval URL', value: 'https://other.example/approver' }, { name: 'Approval Credential', encryptedValue: 'enc' }] } },
    'oauth/cibaServerPolicy/requestPolicies/tplPolicy': { id: 'tplPolicy', authenticatorRef: { id: 'tplPlugin' }, transactionLifetime: 120, lastModified: 'd' },
    'oauth/clients/pfLab-ciba': { clientId: 'pfLab-ciba', clientAuth: { type: 'SECRET', encryptedSecret: 'enc-client' }, modificationDate: 'd' },
  };
  const writes = [];
  const api = async (method, resource, body) => {
    if (method === 'GET') return store[resource] ? structuredClone(store[resource]) : null;
    writes.push({ method, resource, body });
    const id = body.id || body.clientId;
    const key = method === 'POST' ? `${resource}/${id}` : resource;
    store[key] = structuredClone(body);
    return body;
  };
  const args = { api, settings, approvalUrl: 'https://lab.example:5400/api/ciba-approver', templatePlugin: 'tplPlugin', templatePolicy: 'tplPolicy' };
  await provisionCibaApprover({ ...args, apply: false });
  assert.equal(writes.length, 0);
  await provisionCibaApprover({ ...args, apply: true });
  const plugin = writes.find((w) => w.resource === 'oauth/outOfBandAuthPlugins');
  assert.equal(plugin.body.id, 'pfLabCibaWebApprover');
  assert.equal(plugin.body.lastModified, undefined);
  assert.deepEqual(plugin.body.configuration.fields[0], { name: 'Approval URL', value: 'https://lab.example:5400/api/ciba-approver' });
  const secret = createSettings({ file }).value('ciba', 'approverSecret');
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(plugin.body.configuration.fields[1].value, secret);
  assert.equal(writes.find((w) => w.resource === 'oauth/cibaServerPolicy/requestPolicies').body.authenticatorRef.id, 'pfLabCibaWebApprover');
  const client = writes.find((w) => w.resource === 'oauth/clients/pfLab-ciba');
  assert.deepEqual(client.body.requestPolicyRef, { id: 'pfLabCibaWebPolicy' });
  assert.deepEqual(client.body.clientAuth, { type: 'SECRET', encryptedSecret: 'enc-client' });
  assert.ok(writes.every((w) => !/tplPlugin|tplPolicy/.test(w.resource)), 'the templates are never written');
  // A client that is not the lab's own is refused before anything is written.
  settings.update({ ciba: { clientId: 'someone-elses-client' } });
  writes.length = 0;
  await assert.rejects(() => provisionCibaApprover({ ...args, apply: true }), /must be one of its own/);
  assert.equal(writes.length, 0);
  await assert.rejects(() => provisionCibaApprover({ ...args, approvalUrl: 'http://lab.example/api/ciba-approver', apply: false }), /must be https/);
});
