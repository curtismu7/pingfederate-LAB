import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';

const IN = (workspace) => ({ 'X-Lab-Workspace': workspace });

test('workspace: default when the header is absent; a bad id is refused', async () => {
  const lab = await startLab();
  try {
    assert.equal((await lab.call('GET', '/api/config')).data.workspace, 'default');
    assert.equal((await lab.call('GET', '/api/config', undefined, IN('demo-2'))).data.workspace, 'demo-2');
    for (const bad of ['', 'Demo', '-a', 'a b', 'a'.repeat(33), '../x']) {
      const res = await lab.call('GET', '/api/config', undefined, IN(bad));
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.data.error, 'bad_workspace');
    }
  } finally { await lab.close(); }
});

test('workspace: sign-in, runs and trace are per workspace; reset clears the current one only', async () => {
  const lab = await startLab();
  try {
    const alice = (await lab.call('POST', '/api/signin/start', undefined, IN('one')));
    assert.equal(alice.data.state, 'credentials_required');
    const done = await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'correct-horse-battery' }, IN('one'));
    assert.equal(done.data.outcome, 'accepted');
    assert.equal((await lab.call('GET', '/api/me', undefined, IN('one'))).data.signedIn, true);
    // The same browser (same cookie), another workspace: nobody is signed in there.
    assert.equal((await lab.call('GET', '/api/me', undefined, IN('two'))).data.signedIn, false);
    assert.equal((await lab.call('GET', '/api/me')).data.signedIn, false);

    await lab.call('POST', '/api/cards/pkce/start', undefined, IN('one'));
    assert.notEqual((await lab.call('GET', '/api/cards/pkce/result', undefined, IN('one'))).data.state, 'none');
    assert.equal((await lab.call('GET', '/api/cards/pkce/result', undefined, IN('two'))).data.state, 'none');

    await lab.call('POST', '/api/signin/start', undefined, IN('two'));
    const reset = await lab.call('POST', '/api/reset', {}, IN('two'));
    assert.equal(reset.data.workspace, 'two');
    // Workspace one keeps its sign-in and its result; two lost its run.
    assert.equal((await lab.call('GET', '/api/me', undefined, IN('one'))).data.signedIn, true);
    assert.notEqual((await lab.call('GET', '/api/cards/pkce/result', undefined, IN('one'))).data.state, 'none');
    const names = (await lab.call('GET', '/api/workspaces', undefined, IN('one'))).data.workspaces;
    assert.deepEqual(names, ['default', 'one', 'two']);
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('workspace: sign-in in one rotates the cookie for all; sign-out keeps the others', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start', undefined, IN('two'));
    await lab.call('POST', '/api/signin/start', undefined, IN('one'));
    await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'correct-horse-battery' }, IN('one'));
    // Workspace two still has its run after the cookie rotated (it was re-keyed, not orphaned).
    assert.equal((await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'wrong-password-123' }, IN('two'))).data.error, undefined);
    const out = await lab.call('POST', '/api/signout', {}, IN('one'));
    assert.equal(out.headers.get('set-cookie'), null, 'another workspace still holds the cookie');
    await lab.call('POST', '/api/signout', {}, IN('two'));
  } finally { await lab.close(); }
});

test('workspace: the reset-workspace route (npm run reset) clears every browser in that workspace, no session created', async () => {
  const lab = await startLab();
  try {
    await lab.call('POST', '/api/signin/start', undefined, IN('one'));
    const other = await fetch(`${lab.base}/api/workspaces/one/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${lab.port}` }, body: '{}' });
    assert.equal(other.status, 200);
    const body = await other.json();
    assert.equal(body.workspace, 'one');
    assert.equal(body.sessionsReset, 1);
    assert.deepEqual(other.headers.getSetCookie(), [], 'the script never gets a session');
    assert.equal((await lab.call('POST', '/api/signin/credentials', { username: 'alice', password: 'x' }, IN('one'))).data.error, 'no_run');
    assert.equal((await fetch(`${lab.base}/api/workspaces/BAD/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
    // A cross-origin page cannot reset it.
    assert.equal((await fetch(`${lab.base}/api/workspaces/one/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  } finally { await lab.close(); }
});
