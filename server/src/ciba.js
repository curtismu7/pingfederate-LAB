import { LabError, hop } from './pf.js';
import { newTraceId, tokenView } from './trace.js';

// CIBA, poll mode, against real PingFederate: the lab names a user, PingFederate asks that user's authenticator to
// approve, and the page polls until approved, denied or expired. There is no mock phone here. The auth_req_id, the
// tokens and the client secret stay on the server; the page sees state, safe metadata and the redacted trace.

export const CIBA_GRANT = 'urn:openid:params:grant-type:ciba';
const MAX_PENDING_MS = 5 * 60 * 1000;
const DEFAULT_INTERVAL_S = 5;
const SLOW_DOWN_S = 5;
const BINDING_MESSAGE = /^[A-Za-z0-9._+/!?#-]{1,20}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

const clamp = (seconds) => Math.min(30, Math.max(1, Number.isFinite(seconds) ? Math.floor(seconds) : DEFAULT_INTERVAL_S));

export function createCiba({ pf, settings, approver = null, now = Date.now }) {
  // approval: where the person approves. 'lab' = PingFederate's web approver registered the request with this lab,
  // so the card can show Approve and Deny; 'waiting' = the lab channel is set up but PingFederate has not asked yet.
  const approval = (run) => {
    if (!approver?.enabled()) return null;
    return approver.pendingFor(run.loginHint, run.startedAt) ? 'lab' : 'waiting';
  };
  const view = (run) => ({ state: 'pending', loginHint: run.loginHint, bindingMessage: run.bindingMessage, interval: run.interval,
    expiresAt: new Date(run.expiresAt).toISOString(), polls: run.polls, approval: approval(run), trace: run.trace });

  function finish(session, run, state, extra = {}) {
    session.ciba = null;
    const result = { state, loginHint: run.loginHint, bindingMessage: run.bindingMessage, polls: run.polls, ...extra, trace: run.trace, completedAt: new Date(now()).toISOString() };
    session.results.ciba = result;
    return result;
  }

  async function start(session, { loginHint, bindingMessage } = {}) {
    if (!settings.ready('ciba')) throw new LabError('not_configured', 'Set the CIBA client in Settings', 409);
    // Starting again replaces a request that is still pending (a Playground run left behind, a closed tab): the old
    // auth_req_id is abandoned and PingFederate lets it expire. Refusing would leave the card stuck until a reset.
    const replaced = Boolean(session.ciba && session.ciba.expiresAt > now());
    const hint = typeof loginHint === 'string' && loginHint.trim() ? loginHint.trim() : (session.user?.subject || '');
    if (!hint || hint.length > 256 || CONTROL.test(hint)) throw new LabError('login_hint_required', 'Name the user who should approve (1 to 256 characters)', 400);
    let message = null;
    if (bindingMessage !== undefined && bindingMessage !== null && bindingMessage !== '') {
      if (typeof bindingMessage !== 'string' || !BINDING_MESSAGE.test(bindingMessage.trim())) {
        throw new LabError('binding_message_invalid', 'The binding message must be 1 to 20 letters, digits or . _ + / ! ? # - (no spaces)', 400);
      }
      message = bindingMessage.trim();
    }
    const traceId = newTraceId();
    const trace = [];
    if (replaced) trace.push({ id: 'superseded', title: 'A new approval request replaces the one that was still pending (the earlier auth_req_id is abandoned)' });
    // Before calling PingFederate: its authenticator registers the approval with the lab DURING the backchannel call.
    const startedAt = now();
    const { metadata, step } = await pf.discover({ traceId });
    if (step) trace.push(step);
    if (!metadata.backchannelEndpoint) throw new LabError('ciba_not_supported', 'PingFederate does not advertise a CIBA endpoint', 409, { trace });
    const c = settings.section('ciba');
    const params = { scope: c.scope, login_hint: hint, ...(message ? { binding_message: message } : {}) };
    const { result, body, headers } = await pf.formPost({ url: metadata.backchannelEndpoint, clientId: c.clientId, clientSecret: c.clientSecret, params, traceId });
    trace.push(hop({ id: 'start', title: 'Start the approval request (CIBA backchannel)', method: 'POST', url: metadata.backchannelEndpoint, headers, params: body, result }));
    if (!result.ok) {
      const error = result.json?.error;
      if (error === 'unknown_user_id') throw new LabError('ciba_unknown_user', 'PingFederate does not know that user', 404, { trace });
      throw new LabError('ciba_refused', `PingFederate refused the approval request (HTTP ${result.status}${error ? `, ${String(error).slice(0, 64)}` : ''})`, 502, { trace });
    }
    const data = result.json;
    if (typeof data?.auth_req_id !== 'string' || !data.auth_req_id || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      throw new LabError('ciba_response_invalid', 'PingFederate returned an invalid approval response', 502, { trace });
    }
    session.ciba = {
      traceId, trace, metadata, authReqId: data.auth_req_id, loginHint: hint, bindingMessage: message,
      interval: clamp(data.interval), lastPolledAt: 0, polls: 0, startedAt,
      expiresAt: now() + Math.min(data.expires_in * 1000, MAX_PENDING_MS),
    };
    delete session.results.ciba;
    return view(session.ciba);
  }

  async function poll(session) {
    const run = session.ciba;
    if (!run) return session.results.ciba || { state: 'none' };
    if (run.expiresAt <= now()) return finish(session, run, 'expired', { reason: 'timed_out' });
    // The page may ask more often than PingFederate allows: answer from the session instead.
    if (now() - run.lastPolledAt < run.interval * 1000) return view(run);
    run.lastPolledAt = now();
    run.polls += 1;
    const c = settings.section('ciba');
    const { result, body, headers } = await pf.formPost({ url: run.metadata.tokenEndpoint, clientId: c.clientId, clientSecret: c.clientSecret,
      params: { grant_type: CIBA_GRANT, auth_req_id: run.authReqId }, traceId: run.traceId });
    const error = result.json?.error;
    if (!result.ok && (error === 'authorization_pending' || error === 'slow_down')) {
      if (error === 'slow_down') run.interval = clamp(run.interval + SLOW_DOWN_S);
      return view(run);
    }
    run.trace.push(hop({ id: 'poll', title: 'Poll for the answer (CIBA grant)', method: 'POST', url: run.metadata.tokenEndpoint, headers, params: body, result,
      claims: pf.tokenClaims(result.json), note: run.polls > 1 ? `${run.polls - 1} earlier poll(s) answered authorization_pending.` : null }));
    if (!result.ok) {
      if (error === 'access_denied') return finish(session, run, 'denied', { reason: 'user_denied' });
      if (error === 'expired_token') return finish(session, run, 'expired', { reason: 'timed_out' });
      return finish(session, run, 'error', { reason: typeof error === 'string' ? error.slice(0, 64) : `http_${result.status}` });
    }
    const tokens = result.json;
    if (typeof tokens?.access_token !== 'string') return finish(session, run, 'error', { reason: 'invalid_token_response' });
    let identity = null;
    if (typeof tokens.id_token === 'string') {
      const keys = await pf.jwks(run.metadata, run.traceId);
      const claims = pf.idToken(tokens.id_token, { metadata: run.metadata, keys, clientId: c.clientId });
      identity = { subject: String(claims.sub), issuer: claims.iss };
    }
    session.tokens.ciba = { accessToken: tokens.access_token, idToken: tokens.id_token || null, refreshToken: tokens.refresh_token || null };
    return finish(session, run, 'approved', {
      identity, tokenType: tokens.token_type || null, scope: tokens.scope || null,
      accessToken: tokenView(tokens.access_token), idToken: tokenView(tokens.id_token),
    });
  }

  // The card's Approve / Deny, for the run this session started. PingFederate learns the answer on its next check and
  // the card's poll then gets the tokens (approve) or access_denied (deny).
  function decide(session, decision) {
    if (decision !== 'approve' && decision !== 'deny') throw new LabError('decision_invalid', 'The decision must be approve or deny', 400);
    const run = session.ciba;
    if (!run || run.expiresAt <= now()) throw new LabError('nothing_pending', 'No approval request is pending', 409);
    const entry = approver?.enabled() ? approver.pendingFor(run.loginHint, run.startedAt) : null;
    if (!entry) throw new LabError('not_asked_yet', 'PingFederate has not asked for this approval yet; try again in a moment', 409);
    entry.status = decision === 'approve' ? 'approved' : 'denied';
    run.trace.push({ id: 'decision', title: `${run.loginHint} ${decision === 'approve' ? 'approved' : 'denied'} the request on the lab page (PingFederate's web approver)` });
    return view(run);
  }

  return { start, poll, decide };
}
