import { LabError, hop } from './pf.js';
import { newTraceId, claimsOf, tokenView } from './trace.js';

// Dynamic client registration at PingFederate (RFC 7591, managed per RFC 7592), in four steps, each also showing
// what PingFederate refuses: (1) an initial access token (client_credentials, scope dcr:register); (2) register,
// first WITHOUT that token (refused), then with it; (3) a token as the new client, then a scope it may not have;
// (4) delete the client with its registration access token and prove it is gone. The new client's secret and
// every token stay in the server-side session. PingFederate needs JDBC client storage for DCR.

export const IAT_SCOPE = 'dcr:register';
const RUN_TTL_MS = 10 * 60 * 1000;
// Each step may be repeated a little (to show a refusal again), never without bound.
export const MAX_REPEATS = 3;

export function createDcr({ pf, settings, now = Date.now }) {
  const registration = () => ({
    client_name: 'PingFederate LAB agent (registered by DCR)',
    grant_types: ['client_credentials'],
    token_endpoint_auth_method: 'client_secret_basic',
    scope: settings.value('dcr', 'clientScope'),
  });

  // The initial access token expires with the run (10 minutes). A registered client's handle never expires: it is
  // tracked in session.dcrClients until the delete step removes it, whatever the time.
  function pending(session, need) {
    const run = session.dcr;
    if (!run || !run[need] || (need === 'iat' && run.expiresAt <= now())) throw new LabError('step_order', 'Run the earlier DCR steps first (a run expires after 10 minutes)', 409);
    return run;
  }

  function countRepeat(run, name) {
    run.repeats ||= {};
    run.repeats[name] = (run.repeats[name] || 0) + 1;
    if (run.repeats[name] > MAX_REPEATS) throw new LabError('too_many_repeats', `This step already ran ${MAX_REPEATS} times; delete the client or Reset`, 409);
  }

  const track = (session, client) => { (session.dcrClients ||= []).push(client); };
  const untrack = (session, clientId) => { session.dcrClients = (session.dcrClients || []).filter((c) => c.clientId !== clientId); };

  async function metadataFor(traceId, trace) {
    const { metadata, step } = await pf.discover({ traceId });
    if (step) trace.push(step);
    if (!metadata.registrationEndpoint) throw new LabError('dcr_not_supported', 'PingFederate does not advertise a registration endpoint', 409, { trace });
    return metadata;
  }

  async function clientToken(metadata, { clientId, clientSecret, scope, traceId }) {
    const { result, body, headers } = await pf.formPost({ url: metadata.tokenEndpoint, clientId, clientSecret, params: { grant_type: 'client_credentials', scope }, traceId });
    return { result, body, headers };
  }

  async function initialToken(session) {
    if (!settings.ready('dcr')) throw new LabError('not_configured', 'Set the DCR initial-access-token client in Settings', 409);
    if (session.dcrClients?.length) throw new LabError('client_pending', 'A registered client is still on PingFederate: run the delete step first', 409);
    const traceId = newTraceId();
    const trace = [];
    const metadata = await metadataFor(traceId, trace);
    const c = settings.section('dcr');
    const { result, body, headers } = await clientToken(metadata, { clientId: c.iatClientId, clientSecret: c.iatClientSecret, scope: IAT_SCOPE, traceId });
    trace.push(hop({ id: 'initial-access-token', title: `Get an initial access token (scope ${IAT_SCOPE})`, method: 'POST', url: metadata.tokenEndpoint, headers, params: body, result,
      claims: pf.tokenClaims(result.json), note: 'Without this token PingFederate refuses every registration: reaching the endpoint is not enough to add clients.' }));
    if (!result.ok || typeof result.json?.access_token !== 'string') throw new LabError('iat_refused', `PingFederate refused the initial access token (HTTP ${result.status})`, 502, { trace });
    session.dcr = { traceId, trace, iat: result.json.access_token, expiresAt: now() + RUN_TTL_MS };
    return { step: 'initial-token', token: tokenView(result.json.access_token), trace };
  }

  async function register(session) {
    const run = pending(session, 'iat');
    countRepeat(run, 'register');
    const metadata = await metadataFor(run.traceId, run.trace);
    const doc = registration();
    const post = (headers) => pf.call(metadata.registrationEndpoint, { method: 'POST', headers, body: JSON.stringify(doc), traceId: run.traceId });
    const base = { 'Content-Type': 'application/json', Accept: 'application/json' };
    const anonymous = await post(base);
    run.trace.push(hop({ id: 'register-anonymous', title: 'Register with no initial access token', method: 'POST', url: metadata.registrationEndpoint, headers: base, json: doc, result: anonymous,
      note: anonymous.ok ? 'PingFederate accepted an anonymous registration: open registration is on.' : 'Refused, as it should be.' }));
    if (anonymous.ok && anonymous.json?.client_id) {
      // Open registration is on: that client is real too. Keep its handle so the delete step removes it as well.
      track(session, { clientId: anonymous.json.client_id, rat: typeof anonymous.json.registration_access_token === 'string' ? anonymous.json.registration_access_token : null, kind: 'anonymous' });
    }
    const withToken = { ...base, Authorization: `Bearer ${run.iat}` };
    const result = await post(withToken);
    run.trace.push(hop({ id: 'register', title: 'Register with the initial access token', method: 'POST', url: metadata.registrationEndpoint, headers: withToken, json: doc, result,
      note: 'PingFederate chose the client_id and the secret. The registration access token lets this client read and delete itself.' }));
    const reg = result.json;
    if (!result.ok || typeof reg?.client_id !== 'string' || typeof reg?.client_secret !== 'string') {
      throw new LabError('register_refused', `PingFederate refused the registration (HTTP ${result.status})`, 502, { trace: run.trace });
    }
    run.client = { clientId: reg.client_id, clientSecret: reg.client_secret, rat: typeof reg.registration_access_token === 'string' ? reg.registration_access_token : null };
    track(session, { clientId: run.client.clientId, rat: run.client.rat, kind: 'registered' });
    delete run.iat;
    return { step: 'register', clientId: run.client.clientId, anonymousRefused: !anonymous.ok, trace: run.trace };
  }

  async function use(session) {
    const run = pending(session, 'client');
    countRepeat(run, 'use');
    const metadata = await metadataFor(run.traceId, run.trace);
    const { clientId, clientSecret } = run.client;
    const allowedScope = settings.value('dcr', 'clientScope');
    const forbiddenScope = settings.value('dcr', 'forbiddenScope');
    const allowed = await clientToken(metadata, { clientId, clientSecret, scope: allowedScope, traceId: run.traceId });
    run.trace.push(hop({ id: 'client-token', title: `Get a token as the new client (${allowedScope})`, method: 'POST', url: metadata.tokenEndpoint,
      headers: allowed.headers, params: allowed.body, result: allowed.result, claims: pf.tokenClaims(allowed.result.json) }));
    const forbidden = await clientToken(metadata, { clientId, clientSecret, scope: forbiddenScope, traceId: run.traceId });
    run.trace.push(hop({ id: 'client-token-forbidden', title: `Ask for a scope the registration does not allow (${forbiddenScope})`, method: 'POST', url: metadata.tokenEndpoint,
      headers: forbidden.headers, params: forbidden.body, result: forbidden.result,
      note: forbidden.result.ok ? 'PingFederate issued it: the DCR scope restriction is off.' : 'Refused: PingFederate limits what a self-registered client may ask for.' }));
    return {
      step: 'use',
      allowed: allowed.result.ok,
      claims: claimsOf(allowed.result.json?.access_token),
      forbiddenRefused: !forbidden.result.ok,
      trace: run.trace,
    };
  }

  async function deleteClient(metadata, client, traceId) {
    // Built from the discovered endpoint, never from PingFederate's reply; the outbound guard pins the origin anyway.
    const uri = `${metadata.registrationEndpoint}/${encodeURIComponent(client.clientId)}`;
    const auth = { Accept: 'application/json', Authorization: `Bearer ${client.rat}` };
    const result = await pf.call(uri, { method: 'DELETE', headers: auth, traceId });
    return { uri, auth, result };
  }

  // Deletes every client this session registered: the main one with the proof that it is gone, then any other
  // (an anonymously registered one). A client without a registration access token cannot delete itself; it is
  // reported as left on PingFederate.
  async function remove(session) {
    if (!session.dcrClients?.length) throw new LabError('step_order', 'No registered client to delete', 409);
    const run = session.dcr || { traceId: newTraceId(), trace: [] };
    const metadata = await metadataFor(run.traceId, run.trace);
    const out = { step: 'delete', gone: null, readRefused: null, tokenRefused: null, alsoDeleted: [], leftOnPingFederate: [] };
    const main = run.client && session.dcrClients.some((c) => c.clientId === run.client.clientId) ? run.client : null;
    if (main) {
      if (!main.rat) throw new LabError('no_registration_token', 'PingFederate returned no registration access token, so the client cannot delete itself', 409, { trace: run.trace });
      const { uri, auth, result: deleted } = await deleteClient(metadata, main, run.traceId);
      run.trace.push(hop({ id: 'delete', title: 'Delete the client with its registration access token (RFC 7592)', method: 'DELETE', url: uri, headers: auth, result: deleted }));
      if (!deleted.ok) throw new LabError('delete_refused', `PingFederate refused the delete (HTTP ${deleted.status})`, 502, { trace: run.trace });
      untrack(session, main.clientId);
      const read = await pf.call(uri, { headers: auth, traceId: run.traceId });
      run.trace.push(hop({ id: 'read-deleted', title: 'Read the deleted registration', method: 'GET', url: uri, headers: auth, result: read,
        note: read.ok ? 'PingFederate still answers for the deleted client.' : 'Gone: the registration no longer exists.' }));
      const after = await clientToken(metadata, { clientId: main.clientId, clientSecret: main.clientSecret, scope: settings.value('dcr', 'clientScope'), traceId: run.traceId });
      run.trace.push(hop({ id: 'deleted-token', title: 'Try the deleted client once more', method: 'POST', url: metadata.tokenEndpoint, headers: after.headers, params: after.body, result: after.result,
        note: after.result.ok ? 'PingFederate still issued a token after the delete.' : 'Refused: the client is gone.' }));
      Object.assign(out, { gone: !read.ok && !after.result.ok, readRefused: !read.ok, tokenRefused: !after.result.ok });
    }
    for (const other of [...session.dcrClients]) {
      if (!other.rat) { out.leftOnPingFederate.push(other.clientId); continue; }
      const { uri, auth, result } = await deleteClient(metadata, other, run.traceId);
      run.trace.push(hop({ id: 'delete-other', title: `Delete the ${other.kind} client too`, method: 'DELETE', url: uri, headers: auth, result }));
      if (result.ok) { untrack(session, other.clientId); out.alsoDeleted.push(other.clientId); } else out.leftOnPingFederate.push(other.clientId);
    }
    session.dcrClients = session.dcrClients.filter((c) => out.leftOnPingFederate.includes(c.clientId));
    // Clients that could not be deleted stay listed (Reset names them); they no longer block a new run.
    session.dcrLeftOver = [...(session.dcrLeftOver || []), ...session.dcrClients];
    session.dcrClients = [];
    session.dcr = null;
    return { ...out, trace: run.trace };
  }

  // Mock mode only (the caller checks the mode): Clear and Reset delete the clients a half-finished run left on the
  // in-process mock, so the next run starts clean. Best effort; on a real PingFederate the lab never deletes on its own.
  async function discard(session) {
    const deleted = [];
    if (!session.dcrClients?.length) return { deleted };
    try {
      const traceId = newTraceId();
      const { metadata } = await pf.discover({ traceId });
      if (!metadata.registrationEndpoint) return { deleted };
      for (const client of [...session.dcrClients]) {
        if (!client.rat) continue;
        const { result } = await deleteClient(metadata, client, traceId);
        if (result.ok) { untrack(session, client.clientId); deleted.push(client.clientId); }
      }
    } catch { /* the mock is in-process; if it cannot answer, Reset still lists what is left */ }
    session.dcr = null;
    return { deleted };
  }

  return { initialToken, register, use, remove, discard };
}
