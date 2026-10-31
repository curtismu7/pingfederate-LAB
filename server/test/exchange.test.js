import test from 'node:test';
import assert from 'node:assert/strict';
import { startLab } from './helpers.js';
import { actChain } from '../src/exchange.js';

test('token exchange needs a PingFederate sign-in', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('POST', '/api/cards/token-exchange/agent');
    assert.equal(res.status, 409);
    assert.equal(res.data.error, 'signin_required');
    assert.equal((await lab.call('POST', '/api/cards/token-exchange/mcp')).data.error, 'hop1_required');
  } finally { await lab.close(); }
});

test('two hops: user -> agent (act.sub = agent) -> MCP (nested act chain MCP -> agent)', async () => {
  const lab = await startLab();
  try {
    await lab.signIn();
    const one = await lab.call('POST', '/api/cards/token-exchange/agent');
    assert.equal(one.data.outcome, 'accepted', JSON.stringify(one.data.checks));
    assert.deepEqual(one.data.actChain, ['agent-actor']);
    assert.equal(one.data.token.claims.sub, 'alice');
    const two = await lab.call('POST', '/api/cards/token-exchange/mcp');
    assert.equal(two.data.outcome, 'accepted', JSON.stringify(two.data.checks));
    assert.deepEqual(two.data.actChain, ['mcp-actor', 'agent-actor']);
    const exchange = two.data.trace.find((s) => s.id === 'mcp-exchange');
    assert.equal(exchange.request.params.grant_type, 'urn:ietf:params:oauth:grant-type:token-exchange');
    assert.equal(exchange.request.params.subject_token.kind, 'JWT');
    assert.equal(exchange.request.params.actor_token.kind, 'JWT');
    assert.deepEqual(lab.leaks(), []);
  } finally { await lab.close(); }
});

test('a flat act claim on hop 2 is reported as a failed check, not hidden', async () => {
  const lab = await startLab({ fake: { flatAct: true } });
  try {
    await lab.signIn();
    await lab.call('POST', '/api/cards/token-exchange/agent');
    const two = await lab.call('POST', '/api/cards/token-exchange/mcp');
    assert.equal(two.data.outcome, 'failed');
    assert.equal(two.data.checks.find((c) => /nested/.test(c.name)).ok, false);
  } finally { await lab.close(); }
});

test('a configured audience is checked', async () => {
  const lab = await startLab({ fake: { exchangeAud: 'resource' } });
  try {
    await lab.call('PUT', '/api/settings', { tokenExchange: { intermediateAudience: 'something-else' } });
    await lab.signIn();
    const one = await lab.call('POST', '/api/cards/token-exchange/agent');
    assert.equal(one.data.outcome, 'failed');
    assert.equal(one.data.checks.find((c) => /audience/.test(c.name)).ok, false);
  } finally { await lab.close(); }
});

test('actChain walks at most 8 levels', () => {
  let claims = { act: { sub: 'x' } }; let cur = claims.act;
  for (let i = 0; i < 50; i += 1) { cur.act = { sub: `a${i}` }; cur = cur.act; }
  assert.equal(actChain(claims).length, 8);
  assert.deepEqual(actChain({}), []);
});
