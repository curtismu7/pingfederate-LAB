import crypto from 'node:crypto';
import { createMockPf, MOCK_ORIGIN, USER } from './mockpf.js';
import { createFixedSettings } from './settings.js';

// Mock mode: the mock PingFederate, the clients it knows, the settings the cards read while it is on, the guards on
// mock sign-in (rule 11) and the "mock" labels on everything it issues. Nothing here touches the settings file.

export const MOCK_USER = { username: USER.username, password: USER.password };

const secret = () => crypto.randomBytes(18).toString('base64url');

// Every client the mock knows, with secrets made fresh at each start (never written anywhere).
function mockClients() {
  const s = {
    par: secret(), rar: secret(), rarDpop: secret(), ciba: secret(), iat: secret(),
    agentExchange: secret(), mcpExchange: secret(), agentActor: secret(), mcpActor: secret(),
  };
  const clients = {
    'mock-signin': { scopes: [] },
    'mock-pkce': { scopes: [] },
    'mock-par': { secret: s.par, scopes: [] },
    'mock-rar': { secret: s.rar, scopes: [] },
    'mock-rar-dpop': { secret: s.rarDpop, dpop: true, scopes: [] },
    'mock-dpop': { dpop: true, scopes: [] },
    'mock-ciba': { secret: s.ciba, scopes: [] },
    'mock-dcr-registrar': { secret: s.iat, scopes: ['dcr:register'] },
    'mock-agent-exchange': { secret: s.agentExchange, scopes: [] },
    'mock-mcp-exchange': { secret: s.mcpExchange, scopes: [] },
    'mock-agent-actor': { secret: s.agentActor, scopes: ['agent:invoke'] },
    'mock-mcp-actor': { secret: s.mcpActor, scopes: ['mcp:invoke'] },
  };
  const values = {
    pf: { issuer: MOCK_ORIGIN },
    signin: { clientId: 'mock-signin', scope: 'openid profile email' },
    pkce: { clientId: 'mock-pkce' },
    par: { clientId: 'mock-par', clientSecret: s.par },
    rar: { clientId: 'mock-rar', clientSecret: s.rar, sourceAccount: 'checking-001', destinationAccount: 'savings-002' },
    rarDpop: { clientId: 'mock-rar-dpop', clientSecret: s.rarDpop },
    dpop: { clientId: 'mock-dpop' },
    ciba: { clientId: 'mock-ciba', clientSecret: s.ciba, approverSecret: secret() },
    dcr: { iatClientId: 'mock-dcr-registrar', iatClientSecret: s.iat, clientScope: 'lab:read', forbiddenScope: 'admin:write' },
    tokenExchange: {
      agentExchangeClientId: 'mock-agent-exchange', agentExchangeClientSecret: s.agentExchange,
      mcpExchangeClientId: 'mock-mcp-exchange', mcpExchangeClientSecret: s.mcpExchange,
      agentActorClientId: 'mock-agent-actor', agentActorClientSecret: s.agentActor,
      mcpActorClientId: 'mock-mcp-actor', mcpActorClientSecret: s.mcpActor,
    },
  };
  return { clients, values };
}

// The mock PingFederate plus its settings. getApprover is read lazily: the approver is built from these settings.
export function createMock({ port, getApprover }) {
  const { clients, values } = mockClients();
  const settings = createFixedSettings(values, { port });
  const bearer = () => `Bearer ${values.ciba.approverSecret}`;
  const pf = createMockPf({
    origin: MOCK_ORIGIN,
    clients,
    // Like a real PingFederate's web-approver authenticator: register the request with the lab's own channel and
    // let the person approve or deny it on the CIBA card; the poll answers whatever they chose.
    onBackchannel: ({ hint, bindingMessage, transactionId }) => {
      getApprover().register(bearer(), { transactionId, subject: hint, bindingMessage: bindingMessage || undefined });
    },
    cibaStatus: (transactionId) => {
      try { return getApprover().lookup(bearer(), transactionId).status; } catch { return 'denied'; }
    },
  });
  return { pf, settings, origin: MOCK_ORIGIN };
}

// The settings the cards read: the mock's while mock mode is on (the sibling-app links stay the owner's), the
// owner's saved settings in live mode. Same interface as settings.js; read-only.
export function modeSettings({ live, mock }) {
  const pick = (section) => (live.mode() === 'mock' && section !== 'links' ? mock.settings : live);
  return {
    value: (section, name) => pick(section).value(section, name),
    section: (name) => pick(name).section(name),
    ready: (card) => (live.mode() === 'mock' ? mock.settings : live).ready(card),
    missing: (card) => (live.mode() === 'mock' ? mock.settings : live).missing(card),
  };
}

const LOOPBACK_BIND = new Set(['127.0.0.1', '::1', 'localhost']);
const FORWARDED = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip'];

// Rule 11: mock sign-in works only when the owner allowed it (ALLOW_MOCK_SIGNIN=1), never behind a proxy, and only
// on a loopback bind (or in Docker, whose compose file publishes on the Mac's 127.0.0.1 alone: LAB_PUBLISH=loopback).
// Returns null when allowed, or the reason it is refused.
// viaLauncher: app.js sets it only for a request from the family launcher itself (launcherRequest); it lifts the proxy
// refusal and nothing else (ALLOW_MOCK_SIGNIN and the bind / LAB_PUBLISH checks still apply).
export function mockSignInRefusal({ env, bind, headers, viaLauncher = false }) {
  // NODE_ENV is not a guard: the Docker image runs with NODE_ENV=production and mock sign-in is allowed there on purpose.
  if (env.ALLOW_MOCK_SIGNIN !== '1') {
    return env.LAB_PUBLISH === 'loopback'
      ? 'Mock sign-in is off. Set ALLOW_MOCK_SIGNIN to "1" under environment in the compose file, then run docker compose up -d.'
      : 'Mock sign-in is off. Start the lab with ALLOW_MOCK_SIGNIN=1 npm start (plain npm start allows it only when no PingFederate is saved in Settings).';
  }
  if (!viaLauncher && FORWARDED.some((h) => headers[h] !== undefined)) return 'Mock sign-in is refused behind a proxy.';
  if (!LOOPBACK_BIND.has(bind) && env.LAB_PUBLISH !== 'loopback') return 'Mock sign-in is refused on a non-loopback address.';
  return null;
}

// A host run (npm start) allows mock sign-in on its own, so the lab works out of the box: ALLOW_MOCK_SIGNIN unset,
// a loopback bind, not Docker (LAB_PUBLISH unset), and no PingFederate saved in Settings (no tenant settings). An explicit
// ALLOW_MOCK_SIGNIN (even 0) always wins, and the proxy-header check in mockSignInRefusal still applies to every request.
export function hostRunAllowsMockSignIn({ env, bind, hasTenant }) {
  return env.ALLOW_MOCK_SIGNIN === undefined && env.LAB_PUBLISH === undefined && LOOPBACK_BIND.has(bind) && !hasTenant;
}

// Marks a reply as mock: { mode: 'mock' }, every trace step and every decoded token gets mock: true.
export function labelMock(body, depth = 0) {
  if (!body || typeof body !== 'object' || depth > 8) return body;
  if (Array.isArray(body)) { for (const item of body.slice(0, 200)) labelMock(item, depth + 1); return body; }
  if (depth === 0 && !Object.hasOwn(body, 'mode')) body.mode = 'mock';
  if (Object.hasOwn(body, 'claims') && (Object.hasOwn(body, 'header') || Object.hasOwn(body, 'request'))) body.mock = true;
  for (const [key, value] of Object.entries(body)) {
    if (key === 'trace' && Array.isArray(value)) for (const s of value.slice(0, 200)) if (s && typeof s === 'object') s.mock = true;
    if (value && typeof value === 'object') labelMock(value, depth + 1);
  }
  return body;
}
