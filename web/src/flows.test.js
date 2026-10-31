import { describe, it, expect, vi, afterEach } from 'vitest';
import { FLOWS, FLOW_IDS, needsStep, runStep, stepSentence, proofPoints, traceToDiagram, latestTrace, endpointName } from './flows.js';
import { validateDiagram } from './diagrams/validate.js';
import { mockServer, hop } from './testApi.js';

afterEach(() => vi.unstubAllGlobals());

describe('flows', () => {
  it('covers every runnable card plus discovery, and only calls the lab\'s own /api', () => {
    expect(FLOW_IDS).toEqual(['signin', 'dcr', 'rar', 'ciba', 'dpop', 'tokenExchange', 'userinfo', 'piflow', 'par', 'pkce', 'discovery']);
    for (const id of FLOW_IDS) for (const s of FLOWS[id].steps) expect(s.path).toMatch(/^\/api\//);
  });

  it('runs a credentials step only when PingFederate asked for a password', () => {
    const step = FLOWS.pkce.steps[1];
    expect(needsStep(step, { data: { state: 'credentials_required' } })).toBe(true);
    expect(needsStep(step, { data: { outcome: 'accepted' } })).toBe(false);
    expect(needsStep(FLOWS.pkce.steps[0], null)).toBe(true);
  });

  it('polls CIBA while pending, at the interval, and stops when it ends', async () => {
    let n = 0;
    const server = mockServer({ 'POST /api/cards/ciba/poll': () => ({ body: (n += 1) < 3 ? { state: 'pending', interval: 2 } : { state: 'approved' } }) });
    const sleep = vi.fn(async () => {});
    const result = await runStep(FLOWS.ciba.steps[1], { sleep });
    expect(result.data.state).toBe('approved');
    expect(server.calls).toHaveLength(3);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('sends options for RAR and the typed credentials for a credentials step, nothing else', async () => {
    const server = mockServer({ 'POST /api/cards/rar/start': { state: 'done' }, 'POST /api/cards/rar/credentials': { state: 'done' } });
    await runStep(FLOWS.rar.steps[0], { options: { amount: '250', currency: 'EUR', dpop: true, extra: 'x' } });
    await runStep(FLOWS.rar.steps[1], { credentials: { username: 'u', password: 'p' } });
    expect(server.calls[0].body).toEqual({ amount: '250', currency: 'EUR', dpop: true });
    expect(server.calls[1].body).toEqual({ username: 'u', password: 'p' });
  });
});

describe('proof', () => {
  it('names a refusal plainly, with the status and PingFederate\'s error', () => {
    expect(stepSentence(hop('par', 'Push', 'POST', 'https://pf.example/as/par.oauth2', 400, { error: 'invalid_request' })))
      .toEqual({ tone: 'refused', text: 'PingFederate refused the pushed authorization request: 400 invalid_request' });
    expect(stepSentence(hop('token', 'Redeem', 'POST', 'https://pf.example/as/token.oauth2', 200)).text).toBe('PingFederate accepted the code redemption at the token endpoint: 200');
    expect(stepSentence({ id: 'code', title: 'No call' })).toBeNull();
  });

  it('a refusal the run asks for on purpose is a pass; accepting it instead is an error', () => {
    expect(stepSentence(hop('register-anonymous', 'Register with no initial access token', 'POST', 'https://pf.example/as/clients.oauth2', 401, { error: 'invalid_token' })))
      .toEqual({ tone: 'expected', tag: 'refused as expected', text: 'PingFederate refused the registration with no initial access token, as it should: 401 invalid_token' });
    for (const id of ['client-token-forbidden', 'read-deleted', 'deleted-token']) expect(stepSentence(hop(id, 'x', 'POST', 'https://pf.example/x', 400)).tone).toBe('expected');
    expect(stepSentence(hop('register-anonymous', 'x', 'POST', 'https://pf.example/as/clients.oauth2', 201)))
      .toEqual({ tone: 'error', text: 'PingFederate accepted the registration with no initial access token (201), but it should have refused it. Check its settings.' });
    expect(stepSentence(hop('poll', 'Poll', 'POST', 'https://pf.example/as/token.oauth2', 400, { error: 'authorization_pending' })))
      .toEqual({ tone: 'info', tag: 'waiting', text: 'PingFederate says the approval is still pending: 400 authorization_pending' });
    expect(stepSentence(hop('poll', 'Poll', 'POST', 'https://pf.example/as/token.oauth2', 400, { error: 'access_denied' })).tone).toBe('refused');
  });

  it('CIBA denied on the lab page: the access_denied poll and the end are passes, not failures', () => {
    const trace = [
      { id: 'decision', title: 'bob denied the request on the lab page (PingFederate\'s web approver)' },
      hop('poll', 'Poll', 'POST', 'https://pf.example/as/token.oauth2', 400, { error: 'access_denied' }),
    ];
    const pts = proofPoints('ciba', [{ ok: true, data: { state: 'denied', trace } }]);
    expect(pts.map((p) => p.tone)).toEqual(['expected', 'expected']);
    expect(pts[1].text).toBe('The approval request ended: denied, as chosen on this page. PingFederate issued no token.');
    // Denied somewhere else (no decision on this page): still a plain refusal.
    expect(proofPoints('ciba', [{ ok: true, data: { state: 'denied', trace: [trace[1]] } }]).map((p) => p.tone)).toEqual(['refused', 'refused']);
    expect(traceToDiagram(trace).nodes.map((n) => n.group)).toEqual(['lab', 'expected']);
    expect(traceToDiagram([trace[1]]).nodes.map((n) => n.group)).toEqual(['lab', 'refused']);
  });

  it('adds the card\'s own conclusions and the server error code and detail', () => {
    const trace = [hop('register-anonymous', 'x', 'POST', 'https://pf.example/as/clients.oauth2', 401)];
    const dcr = proofPoints('dcr', [{ ok: true, status: 200, data: { anonymousRefused: true, trace } }]);
    expect(dcr.map((p) => p.text)).toContain('Registration without an initial access token was refused.');
    const failed = proofPoints('dcr', [{ ok: false, status: 409, data: { error: 'step_order', message: 'Run the earlier DCR steps first' } }]);
    expect(failed.at(-1)).toEqual({ tone: 'error', text: 'The lab stopped: step_order: Run the earlier DCR steps first' });
    const dpop = proofPoints('dpop', [{ ok: true, data: { outcome: 'accepted', dpop: { bound: true, tokenType: 'DPoP', cnfJkt: 'abc', jkt: 'abc' } } }]);
    expect(dpop.some((p) => p.text.includes('DPoP-bound') && p.text.includes('abc'))).toBe(true);
    const gone = proofPoints('rar', [{ ok: true, data: { outcome: 'failed', reason: 'flow_gone' } }]);
    expect(gone.at(-1).text).toMatch(/no longer knows this sign-in \(404\).*Press Run/);
    const ex = proofPoints('tokenExchange', [{ ok: true, data: { checks: [{ name: 'act.act.sub names the AI agent (nested chain)', ok: false }], actChain: ['svc', 'agent'] } }]);
    expect(ex.map((p) => p.text)).toContain('Check FAILED: act.act.sub names the AI agent (nested chain).');
  });

  it('uses the newest trace any step returned', () => {
    expect(latestTrace([{ data: { trace: [1] } }, { data: {} }, { data: { trace: [1, 2] } }])).toEqual([1, 2]);
    expect(latestTrace([])).toEqual([]);
  });

  it('names PingFederate endpoints from their URL', () => {
    expect(endpointName('https://pf.example/as/par.oauth2')).toBe('PAR endpoint');
    expect(endpointName('https://pf.example/pf-ws/authn/flows/<flow id>')).toBe('Authentication API');
    expect(endpointName('https://pf.example/as/token.oauth2')).toBe('Token endpoint');
    expect(endpointName('https://pf.example/.well-known/openid-configuration')).toBe('Discovery');
  });
});

describe('live sequence diagram', () => {
  it('is valid diagram-studio/1 data built from the trace, one box per call in order', () => {
    const trace = [hop('a', 'First', 'GET', 'https://pf.example/.well-known/openid-configuration', 200), { id: 'code', title: 'no call' }, hop('b', 'Second', 'POST', 'https://pf.example/as/clients.oauth2', 401, { error: 'invalid_token' })];
    const d = traceToDiagram(trace);
    expect(validateDiagram(d)).toEqual([]);
    expect(d.nodes.map((n) => n.group)).toEqual(['lab', 'accepted', 'refused']);
    const deliberate = traceToDiagram([hop('register-anonymous', 'Register with no token', 'POST', 'https://pf.example/as/clients.oauth2', 401)]);
    expect(deliberate.nodes.map((n) => n.group)).toEqual(['lab', 'expected']);
    expect(validateDiagram(deliberate)).toEqual([]);
    expect(d.edges[1]).toMatchObject({ source: 'c1', target: 'c2', dashed: true });
    expect(d.steps).toHaveLength(2);
    expect(traceToDiagram([])).toBeNull();
  });

  it('stays within the studio limits for a very long trace', () => {
    const trace = Array.from({ length: 200 }, (_, i) => hop(`h${i}`, `Call ${i}`, 'POST', 'https://pf.example/as/token.oauth2', 200));
    expect(validateDiagram(traceToDiagram(trace))).toEqual([]);
  });
});
