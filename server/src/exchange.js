import { LabError, hop } from './pf.js';
import { newTraceId, claimsOf, headerOf, tokenView } from './trace.js';

// RFC 8693 token exchange at PingFederate, two hops. Hop 1: the signed-in user's access token (subject) plus the
// AI agent's own token (actor) become an agent token: act.sub names the agent. Hop 2: that token plus the MCP
// service's token become the final token, whose act claim is the nested chain MCP service -> AI agent.
// Every check is reported (ok true/false) rather than hidden: a missing nested act is the lesson.

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const HOP_TTL_MS = 5 * 60 * 1000;

const scopeSet = (value) => new Set(Array.isArray(value) ? value : String(value || '').split(/\s+/).filter(Boolean));
const hasAudience = (aud, expected) => (Array.isArray(aud) ? aud.includes(expected) : aud === expected);
const actorId = (claims) => claims?.client_id || claims?.sub || null;

// The act chain, outermost first, depth-limited.
export function actChain(claims) {
  const chain = [];
  let act = claims?.act;
  while (act && typeof act === 'object' && chain.length < 8) {
    chain.push(act.sub ?? act.client_id ?? null);
    act = act.act;
  }
  return chain;
}

export function createExchange({ pf, settings, now = Date.now }) {
  function userToken(session) {
    const token = session.tokens.signin?.accessToken;
    if (!session.user || !token) throw new LabError('signin_required', 'Sign in with PingFederate first: the exchange starts from your access token', 409);
    const claims = claimsOf(token);
    if (!claims) throw new LabError('opaque_token', 'Your PingFederate access token is opaque (a reference token), so its user cannot be read. Use a JWT access token manager for the sign-in client.', 409);
    const sub = claims.sub ?? claims.Username;
    if (sub === undefined || sub === null || sub === '') throw new LabError('no_subject', 'Your access token has neither sub nor Username', 409);
    return { token, sub: String(sub) };
  }

  async function actorToken({ metadata, who, traceId, trace }) {
    const c = settings.section('tokenExchange');
    const clientId = c[`${who}ActorClientId`];
    const scope = c[`${who}ActorScope`];
    const { result, body, headers } = await pf.formPost({ url: metadata.tokenEndpoint, clientId, clientSecret: c[`${who}ActorClientSecret`], params: { grant_type: 'client_credentials', scope }, traceId });
    trace.push(hop({ id: `${who}-actor-token`, title: `The ${who === 'agent' ? 'AI agent' : 'MCP service'} gets its own token (actor)`, method: 'POST', url: metadata.tokenEndpoint,
      headers, params: body, result, claims: pf.tokenClaims(result.json) }));
    const token = result.json?.access_token;
    if (!result.ok || typeof token !== 'string') throw new LabError('actor_token_refused', `PingFederate refused the ${who} actor token (HTTP ${result.status})`, 502, { trace });
    return token;
  }

  async function exchangeHop({ metadata, who, subjectToken, actor, traceId, trace }) {
    const c = settings.section('tokenExchange');
    const scope = c[`${who}ActorScope`];
    const params = {
      grant_type: TOKEN_EXCHANGE_GRANT,
      subject_token: subjectToken,
      subject_token_type: ACCESS_TOKEN_TYPE,
      actor_token: actor,
      actor_token_type: ACCESS_TOKEN_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      scope,
    };
    const { result, body, headers } = await pf.formPost({ url: metadata.tokenEndpoint, clientId: c[`${who}ExchangeClientId`], clientSecret: c[`${who}ExchangeClientSecret`], params, traceId });
    trace.push(hop({ id: `${who}-exchange`, title: who === 'agent' ? 'Exchange 1: user token + agent actor -> agent token' : 'Exchange 2: agent token + MCP actor -> MCP token',
      method: 'POST', url: metadata.tokenEndpoint, headers, params: body, result, claims: pf.tokenClaims(result.json) }));
    const token = result.json?.access_token;
    if (!result.ok || typeof token !== 'string') throw new LabError('exchange_refused', `PingFederate refused the exchange (HTTP ${result.status}${result.json?.error ? `, ${String(result.json.error).slice(0, 64)}` : ''})`, 502, { trace });
    return { token, scope };
  }

  function report(hopName, token, checks, trace) {
    const claims = claimsOf(token);
    return {
      hop: hopName,
      outcome: checks.every((c) => c.ok) ? 'accepted' : 'failed',
      token: tokenView(token),
      header: headerOf(token),
      actChain: actChain(claims),
      checks,
      trace,
    };
  }

  async function agentHop(session) {
    if (!settings.ready('tokenExchange')) throw new LabError('not_configured', 'Set the four token-exchange clients in Settings', 409);
    const user = userToken(session);
    const traceId = newTraceId();
    const trace = [];
    const { metadata, step } = await pf.discover({ traceId });
    if (step) trace.push(step);
    const agentActor = await actorToken({ metadata, who: 'agent', traceId, trace });
    const { token, scope } = await exchangeHop({ metadata, who: 'agent', subjectToken: user.token, actor: agentActor, traceId, trace });
    const claims = claimsOf(token) || {};
    const audience = settings.value('tokenExchange', 'intermediateAudience');
    const checks = [
      { name: 'is a JWT access token', ok: Boolean(claimsOf(token)) },
      { name: 'issued by the configured PingFederate', ok: claims.iss === metadata.issuer },
      { name: 'keeps the user as subject', ok: String(claims.sub ?? claims.Username ?? '') === user.sub },
      { name: 'act.sub names the AI agent', ok: Boolean(claims.act) && claims.act.sub === actorId(claimsOf(agentActor)) },
      { name: `scope includes ${scope}`, ok: [...scopeSet(scope)].every((s) => scopeSet(claims.scope).has(s)) },
      ...(audience ? [{ name: `audience is ${audience}`, ok: hasAudience(claims.aud, audience) }] : []),
    ];
    session.exchange = { traceId, trace, metadata, intermediate: token, agentActor, userSub: user.sub, expiresAt: now() + HOP_TTL_MS };
    const out = report('agent', token, checks, trace);
    session.results.tokenExchange = out;
    return out;
  }

  async function mcpHop(session) {
    const run = session.exchange;
    if (!run || run.expiresAt <= now()) throw new LabError('hop1_required', 'Run exchange 1 first (it expires after 5 minutes)', 409);
    const { metadata, traceId, trace } = run;
    const mcpActor = await actorToken({ metadata, who: 'mcp', traceId, trace });
    const { token, scope } = await exchangeHop({ metadata, who: 'mcp', subjectToken: run.intermediate, actor: mcpActor, traceId, trace });
    const claims = claimsOf(token) || {};
    const audience = settings.value('tokenExchange', 'finalAudience');
    const checks = [
      { name: 'is a JWT access token', ok: Boolean(claimsOf(token)) },
      { name: 'issued by the configured PingFederate', ok: claims.iss === metadata.issuer },
      { name: 'keeps the user as subject', ok: String(claims.sub ?? claims.Username ?? '') === run.userSub },
      { name: 'act.sub names the MCP service', ok: claims.act?.sub === actorId(claimsOf(mcpActor)) },
      { name: 'act.act.sub names the AI agent (nested chain)', ok: claims.act?.act?.sub === actorId(claimsOf(run.agentActor)) },
      { name: `scope includes ${scope}`, ok: [...scopeSet(scope)].every((s) => scopeSet(claims.scope).has(s)) },
      ...(audience ? [{ name: `audience is ${audience}`, ok: hasAudience(claims.aud, audience) }] : []),
    ];
    session.exchange = null;
    const out = report('mcp', token, checks, trace);
    session.results.tokenExchange = out;
    return out;
  }

  return { agentHop, mcpHop };
}
