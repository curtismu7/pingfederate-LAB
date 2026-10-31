import { LabError, hop } from './pf.js';
import { newTraceId } from './trace.js';

// Userinfo (OpenID Connect Core 5.3): the signed-in user's access token reads their claims from PingFederate. Which
// claims come back is set by the client's OpenID Connect policy (its attribute contract and scope mappings), not by
// the lab. The lab checks that the answer is for the same subject as the verified ID token.
export function createUserinfo({ pf, settings }) {
  async function read(session) {
    if (!settings.ready('userinfo')) throw new LabError('not_configured', 'Set the issuer and the sign-in client in Settings', 409);
    const token = session.tokens.signin?.accessToken;
    if (!session.user || !token) throw new LabError('signin_required', 'Sign in with PingFederate first: this card works on your tokens', 409);
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step } = await pf.discover({ traceId });
    if (step) trace.push(step);
    if (!metadata.userinfoEndpoint) throw new LabError('userinfo_not_supported', 'Your PingFederate does not advertise a userinfo endpoint', 409, { trace });
    const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
    const result = await pf.call(metadata.userinfoEndpoint, { headers, traceId });
    trace.push(hop({ id: 'userinfo', title: 'Read the user\'s claims (userinfo)', method: 'GET', url: metadata.userinfoEndpoint,
      headers: { Accept: 'application/json', Authorization: 'Bearer <access token>' }, result }));
    const out = result.ok && result.json && typeof result.json === 'object'
      ? { outcome: 'accepted', sub: typeof result.json.sub === 'string' ? result.json.sub : null, subMatches: result.json.sub === session.user.subject, claims: Object.keys(result.json).slice(0, 40), trace }
      : { outcome: 'refused', reason: typeof result.json?.error === 'string' ? result.json.error.slice(0, 64) : `http_${result.status}`, trace };
    session.results.userinfo = out;
    return out;
  }
  return { read };
}
