import { call } from './api.js';

// Every flow the lab runs, as data: its steps in order and the lab endpoint each step calls. The card run views and
// the Protocol Playground both run flows from here, so the two never drift apart.
// A step with `credentials: true` only runs when the step before it stopped at USERNAME_PASSWORD_REQUIRED.
// A step with `poll` repeats while PingFederate says the request is still pending.
// The start step sends the typed user as login_hint unless the card names the user itself (RAR's user_id).
const codeFlow = (card, startLabel, extra = {}) => ({
  steps: [
    { id: 'start', label: startLabel, path: card === 'signin' ? '/api/signin/start' : `/api/cards/${card}/start`, body: (o) => ({ loginHint: o.loginHint || undefined }), ...extra },
    { id: 'credentials', label: 'Post the username and password (checkUsernamePassword)', path: card === 'signin' ? '/api/signin/credentials' : `/api/cards/${card}/credentials`, credentials: true },
  ],
});

export const FLOWS = {
  signin: { title: 'Sign in (pi.flow)', ...codeFlow('signin', 'Open a pi.flow sign-in') },
  dcr: {
    title: 'Dynamic client registration',
    steps: [
      { id: 'initial-token', label: 'Get an initial access token (dcr:register)', path: '/api/cards/dcr/initial-token' },
      { id: 'register', label: 'Register: first with no token, then with it', path: '/api/cards/dcr/register' },
      { id: 'use', label: 'Use the new client, then ask a forbidden scope', path: '/api/cards/dcr/use' },
      { id: 'delete', label: 'Delete it and prove it is gone', path: '/api/cards/dcr/delete' },
    ],
  },
  rar: { title: 'RAR via PAR', ...codeFlow('rar', 'Push banking_transaction details (PAR) and open the flow', { body: (o) => ({ amount: o.amount, currency: o.currency, dpop: Boolean(o.dpop), userId: o.rarUser || undefined, sourceAccount: o.fromAccount || undefined, destinationAccount: o.toAccount || undefined }) }) },
  ciba: {
    title: 'CIBA',
    steps: [
      { id: 'start', label: 'Ask PingFederate to get the user\'s approval (backchannel)', path: '/api/cards/ciba/start', body: (o) => ({ loginHint: o.loginHint || undefined, bindingMessage: o.bindingMessage || undefined }) },
      { id: 'poll', label: 'Poll until approved, denied or expired', path: '/api/cards/ciba/poll', poll: true },
    ],
  },
  dpop: { title: 'DPoP sign-in', ...codeFlow('dpop', 'Open a pi.flow for the DPoP-bound client') },
  tokenExchange: {
    title: 'Token exchange (act chain)',
    steps: [
      { id: 'agent', label: 'Exchange 1: user token + agent actor', path: '/api/cards/token-exchange/agent' },
      { id: 'mcp', label: 'Exchange 2: agent token + tool-service actor', path: '/api/cards/token-exchange/mcp' },
    ],
  },
  userinfo: { title: 'Userinfo', steps: [{ id: 'read', label: 'Read the user\'s claims with the access token', path: '/api/cards/userinfo/read' }] },
  piflow: { title: 'Authentication API (pi.flow open)', steps: [{ id: 'open', label: 'Open a flow and read it back (no credential sent)', path: '/api/cards/piflow/open' }] },
  par: { title: 'PAR', ...codeFlow('par', 'Push the request (PAR) and open the flow') },
  pkce: { title: 'PKCE', ...codeFlow('pkce', 'Open a pi.flow with an S256 code challenge') },
  discovery: { title: 'Discovery check', steps: [{ id: 'check', label: 'Read PingFederate discovery', path: '/api/pf/discovery' }] },
};
export const FLOW_IDS = Object.keys(FLOWS);

export const MAX_POLLS = 60;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// Should this step run, given what the previous step answered?
export function needsStep(step, previous) {
  if (!step.credentials) return true;
  return previous?.data?.state === 'credentials_required';
}

// Runs one step. Credential steps send the typed username and password (to the lab server only).
export async function runStep(step, { options = {}, credentials, onPoll, sleep = wait } = {}) {
  const body = step.credentials ? credentials : (step.body ? step.body(options) : {});
  let result = await call('POST', step.path, body);
  if (step.poll) {
    for (let i = 0; result.ok && result.data?.state === 'pending' && i < MAX_POLLS; i += 1) {
      onPoll?.(result);
      await sleep(Math.max(1, Number(result.data.interval) || 2) * 1000);
      result = await call('POST', step.path, {});
    }
  }
  return result;
}

// The trace to show: the newest one any step returned (the server sends the run's whole trace so far).
export function latestTrace(results) {
  for (let i = results.length - 1; i >= 0; i -= 1) {
    const trace = results[i]?.data?.trace;
    if (Array.isArray(trace) && trace.length) return trace;
  }
  return [];
}

// Plain names for what a trace step asked PingFederate for.
const PHRASES = {
  discovery: 'the discovery request',
  authorize: 'the pi.flow authorization request',
  read: 'the read-back of the flow',
  credentials: 'the username and password',
  continue: 'the step after MFA',
  token: 'the code redemption at the token endpoint',
  par: 'the pushed authorization request',
  'initial-access-token': 'the initial access token request',
  'register-anonymous': 'the registration with no initial access token',
  register: 'the registration with the initial access token',
  'client-token': 'a token for the newly registered client',
  'client-token-forbidden': 'a token with a scope the registration does not allow',
  delete: 'the delete with the registration access token',
  'delete-other': 'the delete of the other registered client',
  'read-deleted': 'a read of the deleted registration',
  'deleted-token': 'a token for the deleted client',
  start: 'the backchannel (CIBA) request',
  poll: 'the CIBA poll',
  'agent-actor-token': 'the AI agent\'s own token',
  'mcp-actor-token': 'the tool service\'s own token',
  'agent-exchange': 'exchange 1 (user token to agent token)',
  'mcp-exchange': 'exchange 2 (agent token to tool-service token)',
};
export const phraseFor = (traceStep) => PHRASES[traceStep?.id] || `"${String(traceStep?.title || 'the request').toLowerCase()}"`;

// Calls a run makes on purpose to show PingFederate saying no. A refusal here is the correct answer (a pass); an
// acceptance means PingFederate is set up wrong.
export const EXPECTED_REFUSALS = new Set(['register-anonymous', 'client-token-forbidden', 'read-deleted', 'deleted-token']);
// CIBA polls answer these while the person has not approved yet: waiting, not refused.
const STILL_WAITING = new Set(['authorization_pending', 'slow_down']);

// One plain sentence per PingFederate answer: what it accepted and what it refused, with the status.
export function stepSentence(traceStep) {
  const status = traceStep?.response?.status;
  if (!Number.isInteger(status)) return null;
  const body = traceStep.response.body;
  const why = body && typeof body === 'object' ? (body.error || body.code || '') : '';
  // PingFederate's own words for the refusal, when it sends them (for example which RAR rule failed).
  const said = body && typeof body === 'object' && typeof body.error_description === 'string' ? ` (${body.error_description.slice(0, 200)})` : '';
  if (EXPECTED_REFUSALS.has(traceStep.id)) {
    return status >= 400
      ? { tone: 'expected', tag: 'refused as expected', text: `PingFederate refused ${phraseFor(traceStep)}, as it should: ${status}${why ? ` ${why}` : ''}` }
      : { tone: 'error', text: `PingFederate accepted ${phraseFor(traceStep)} (${status}), but it should have refused it. Check its settings.` };
  }
  if (traceStep.id === 'poll' && status >= 400 && STILL_WAITING.has(why)) return { tone: 'info', tag: 'waiting', text: `PingFederate says the approval is still pending: ${status} ${why}` };
  if (status >= 400) return { tone: 'refused', text: `PingFederate refused ${phraseFor(traceStep)}: ${status}${why ? ` ${why}` : ''}${said}` };
  if (status >= 300) return { tone: 'info', text: `PingFederate answered ${phraseFor(traceStep)} with a redirect: ${status} (not followed)` };
  return { tone: 'accepted', text: `PingFederate accepted ${phraseFor(traceStep)}: ${status}` };
}

const yesNo = (ok, yes, no) => ({ tone: ok ? 'accepted' : 'refused', text: ok ? yes : no });

// What the run proves, in plain language: one line per PingFederate answer, then the card's own conclusions.
export function proofPoints(flowId, results) {
  const points = [];
  for (const s of latestTrace(results)) { const line = stepSentence(s); if (line) points.push(line); }
  const last = results.at(-1);
  if (!last) return points;
  const d = last.data || {};
  if (!last.ok) {
    points.push({ tone: 'error', text: `The lab stopped: ${d.error || `HTTP ${last.status}`}${d.message ? `: ${d.message}` : ''}` });
    return points;
  }
  if (d.state === 'credentials_required') points.push({ tone: 'info', text: d.refused ? 'PingFederate refused the username or password; the flow still waits for them.' : `PingFederate is waiting for a username and password (${d.status}).` });
  if (d.outcome === 'accepted' && flowId === 'userinfo') points.push(yesNo(d.subMatches, `Userinfo answered for the signed-in user (${(d.claims || []).join(', ')}).`, 'Userinfo answered for a different subject than the ID token.'));
  else if (d.outcome === 'accepted') points.push({ tone: 'accepted', text: d.identity?.subject ? `Done: PingFederate issued tokens; the verified ID token names ${d.identity.subject}.` : 'Done: PingFederate issued the tokens.' });
  if (d.outcome === 'refused') points.push({ tone: 'refused', text: `PingFederate refused the request: ${d.reason}` });
  if (d.outcome === 'failed' && d.reason === 'flow_gone') points.push({ tone: 'error', text: 'PingFederate no longer knows this sign-in (404): it expired, or PingFederate restarted while it waited. Press Run to start again.' });
  else if (d.outcome === 'failed') points.push({ tone: 'error', text: `The run failed a check: ${d.reason}` });
  if (d.dpop) points.push(yesNo(d.dpop.bound, `The token is DPoP-bound: token_type ${d.dpop.tokenType}, cnf.jkt ${d.dpop.cnfJkt ?? '(opaque token)'} matches this run's key ${d.dpop.jkt}.`, `The token is NOT bound to this run's key (token_type ${d.dpop.tokenType}).`));
  if (Array.isArray(d.authorizationDetails) && d.authorizationDetails.length) points.push({ tone: 'accepted', text: `The token carries the approved authorization_details: ${d.authorizationDetails.map((x) => `${x.type} ${x.amount ?? ''} ${x.currency ?? ''}`.trim()).join(', ')}.` });
  if (flowId === 'dcr') {
    if (d.anonymousRefused !== undefined) points.push(yesNo(d.anonymousRefused, 'Registration without an initial access token was refused.', 'Open registration is ON: PingFederate registered a client with no initial access token.'));
    if (d.forbiddenRefused !== undefined) points.push(yesNo(d.forbiddenRefused, 'The registered client could not get a scope outside its registration.', 'The registered client got a scope outside its registration.'));
    if (d.gone !== undefined && d.gone !== null) points.push(yesNo(d.gone, 'After the delete, the client can neither be read nor get a token: it is gone.', 'After the delete, PingFederate still answered for the client.'));
    if (d.leftOnPingFederate?.length) points.push({ tone: 'refused', text: `Still on PingFederate: ${d.leftOnPingFederate.join(', ')}` });
  }
  // Denied on the lab page: PingFederate's access_denied is then the right answer, not a failure.
  const deniedHere = flowId === 'ciba' && d.state === 'denied' && (d.trace || []).some((s) => s.id === 'decision' && / denied /.test(s.title || ''));
  if (deniedHere) {
    for (const p of points) if (p.tone === 'refused' && /CIBA poll: 400 access_denied/.test(p.text)) Object.assign(p, { tone: 'expected', tag: 'refused as expected', text: `${p.text} (the request was denied on this page)` });
  }
  if (flowId === 'ciba' && d.state && d.state !== 'pending') {
    points.push(deniedHere
      ? { tone: 'expected', tag: 'denied as asked', text: 'The approval request ended: denied, as chosen on this page. PingFederate issued no token.' }
      : { tone: d.state === 'approved' ? 'accepted' : 'refused', text: `The approval request ended: ${d.state}${d.identity?.subject ? ` (ID token for ${d.identity.subject})` : ''}.` });
  }
  if (flowId === 'tokenExchange' && Array.isArray(d.checks)) {
    for (const c of d.checks) points.push(yesNo(c.ok, `Check passed: ${c.name}.`, `Check FAILED: ${c.name}.`));
    if (d.actChain?.length) points.push({ tone: 'info', text: `act chain, outermost first: ${d.actChain.join(' -> ')}` });
  }
  if (flowId === 'piflow' && d.status) points.push({ tone: 'accepted', text: `PingFederate opened a flow at ${d.status}, offering: ${(d.actions || []).join(', ') || 'no actions'}. No credential was sent.` });
  if (flowId === 'discovery' && Array.isArray(d.features)) {
    for (const f of d.features) points.push({ tone: f.supported ? 'accepted' : 'info', text: `${f.label}: ${f.supported ? 'advertised' : 'not advertised'}` });
  }
  return points;
}

// Friendly name of the PingFederate endpoint a URL points at.
export function endpointName(url) {
  const p = (() => { try { return new URL(url).pathname; } catch { return String(url || ''); } })();
  if (p.includes('openid-configuration')) return 'Discovery';
  if (p.includes('/pf-ws/authn/')) return 'Authentication API';
  if (/par/i.test(p.split('/').pop())) return 'PAR endpoint';
  if (/authoriz/i.test(p)) return 'Authorization endpoint';
  if (/bc-auth|ciba|backchannel/i.test(p)) return 'Backchannel endpoint';
  if (/clients|regist/i.test(p)) return 'Registration endpoint';
  if (/userinfo/i.test(p)) return 'Userinfo endpoint';
  if (/jwks/i.test(p)) return 'JWKS';
  if (/token/i.test(p)) return 'Token endpoint';
  return 'PingFederate';
}

const PER_ROW = 3;

// The live sequence of a run, as diagram-studio/1 data built from the captured trace: one box per PingFederate
// call (green accepted, blue refused as expected, amber refused), in order, so the shared DiagramView can walk it with Simulate.
export function traceToDiagram(trace, title = 'This run, call by call') {
  const calls = (trace || []).filter((s) => s?.request && Number.isInteger(s?.response?.status));
  if (!calls.length) return null;
  const deniedHere = (trace || []).some((s) => s?.id === 'decision' && / denied /.test(s.title || ''));
  const nodes = [{ id: 'lab', group: 'lab', label: 'This lab (server)', sub: [calls.some((s) => s.mock) ? 'Every call below goes to the mock PingFederate' : 'Every call below is real'], x: 0, y: 0 }];
  const edges = [];
  const steps = [];
  calls.forEach((s, i) => {
    const status = s.response.status;
    const slot = i + 1;
    const row = Math.floor(slot / PER_ROW);
    const col = row % 2 === 0 ? slot % PER_ROW : PER_ROW - 1 - (slot % PER_ROW);
    const id = `c${i + 1}`;
    const sentence = stepSentence(s);
    nodes.push({
      id,
      group: status < 400 ? 'accepted'
        : sentence?.tone === 'expected' || (deniedHere && s.id === 'poll' && s.response.body?.error === 'access_denied') ? 'expected' : 'refused',
      label: `${i + 1}. ${String(s.title || s.id).slice(0, 70)}`,
      sub: [`${s.request.method} ${endpointName(s.request.url)}`, `${status}${s.response.body?.error ? ` ${String(s.response.body.error).slice(0, 60)}` : ''}`],
      x: col * 300,
      y: row * 170,
    });
    edges.push({ source: i === 0 ? 'lab' : `c${i}`, target: id, label: s.request.method, dashed: status >= 400 });
    steps.push({ title: `${i + 1}. ${String(s.title || s.id).slice(0, 110)}`, what: (sentence?.text || '').slice(0, 600), hop: String(s.id || 'hop').replace(/[^A-Za-z0-9._:/-]/g, '-').slice(0, 64), edges: [i] });
  });
  return {
    schema: 'diagram-studio/1',
    id: 'live-run',
    title,
    lede: 'Built from the trace this run captured. Green: PingFederate accepted. Blue, dashed: PingFederate refused, as it should (the run tests that on purpose). Amber, dashed: PingFederate refused.',
    groups: { lab: { label: 'This lab', color: 'dark' }, accepted: { label: 'Accepted', color: 'green' }, expected: { label: 'Refused as expected', color: 'blue' }, refused: { label: 'Refused', color: 'amber' } },
    nodes: nodes.slice(0, 60),
    edges: edges.slice(0, 59),
    steps: steps.slice(0, 59),
  };
}
