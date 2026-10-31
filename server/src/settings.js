import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Which PingFederate this lab talks to, and per card the client ids and secrets. One file, mode 600:
// ~/.config/demo-kit/pingfederate-lab/pingfederate.json, in a folder of its own so Docker mounts nothing else
// (PFLAB_SETTINGS_FILE overrides the path, for tests and the container).
// Secrets are write-only: publicView() says only whether each one is set; nothing here ever logs a value.

export const DEFAULT_FILE = path.join(os.homedir(), '.config', 'demo-kit', 'pingfederate-lab', 'pingfederate.json');
export const DEFAULT_PORT = 5400;

// kind: https = https URL; redirect = https, or http on loopback (PingFederate never visits it under pi.flow);
// link = https, or http on loopback; id = a client id; scope = space-separated scopes; text; secret.
const client = (extra = {}) => ({ clientId: { kind: 'id' }, clientSecret: { kind: 'secret' }, ...extra });
export const SCHEMA = {
  pf: { issuer: { kind: 'https' }, redirectUri: { kind: 'redirect' } }, // default: http://127.0.0.1:<the lab's port>/callback
  signin: client({ scope: { kind: 'scope', default: 'openid profile' } }),
  pkce: client({ scope: { kind: 'scope', default: 'openid profile' } }),
  par: client({ scope: { kind: 'scope', default: 'openid profile' } }),
  // The transfer's accounts: PingFederate's processor accepts only the signed-in user's own accounts.
  rar: client({ scope: { kind: 'scope', default: 'openid profile transactions:write' }, sourceAccount: { kind: 'id' }, destinationAccount: { kind: 'id' } }),
  rarDpop: client(),
  dpop: client({ scope: { kind: 'scope', default: 'openid profile' } }),
  // approverSecret: shared with PingFederate's web-approver authenticator, so the CIBA card can approve on its own page.
  ciba: client({ scope: { kind: 'scope', default: 'openid profile' }, approverSecret: { kind: 'secret' } }),
  dcr: {
    iatClientId: { kind: 'id' },
    iatClientSecret: { kind: 'secret' },
    clientScope: { kind: 'scope', default: 'openid' },
    forbiddenScope: { kind: 'scope', default: 'admin:write' },
  },
  tokenExchange: {
    agentExchangeClientId: { kind: 'id' },
    agentExchangeClientSecret: { kind: 'secret' },
    mcpExchangeClientId: { kind: 'id' },
    mcpExchangeClientSecret: { kind: 'secret' },
    agentActorClientId: { kind: 'id' },
    agentActorClientSecret: { kind: 'secret' },
    agentActorScope: { kind: 'scope', default: 'agent:invoke' },
    mcpActorClientId: { kind: 'id' },
    mcpActorClientSecret: { kind: 'secret' },
    mcpActorScope: { kind: 'scope', default: 'mcp:invoke' },
    // Optional: when set, the hop's token must name this audience.
    intermediateAudience: { kind: 'text' },
    finalAudience: { kind: 'text' },
  },
  links: { cimdLabUrl: { kind: 'link' }, idJagUrl: { kind: 'link' } },
};

// What each card needs before it can run.
export const REQUIRED = {
  discovery: [['pf', 'issuer']],
  signin: [['pf', 'issuer'], ['signin', 'clientId']],
  pkce: [['pf', 'issuer'], ['pkce', 'clientId']],
  par: [['pf', 'issuer'], ['par', 'clientId']],
  rar: [['pf', 'issuer'], ['rar', 'clientId']],
  rarDpop: [['pf', 'issuer'], ['rarDpop', 'clientId']],
  dpop: [['pf', 'issuer'], ['dpop', 'clientId']],
  ciba: [['pf', 'issuer'], ['ciba', 'clientId'], ['ciba', 'clientSecret']],
  dcr: [['pf', 'issuer'], ['dcr', 'iatClientId'], ['dcr', 'iatClientSecret']],
  tokenExchange: [['pf', 'issuer'], ...['agentExchange', 'mcpExchange', 'agentActor', 'mcpActor']
    .flatMap((who) => [['tokenExchange', `${who}ClientId`], ['tokenExchange', `${who}ClientSecret`]])],
  piflow: [['pf', 'issuer'], ['signin', 'clientId']],
  userinfo: [['pf', 'issuer'], ['signin', 'clientId']],
};

export class SettingsError extends Error {
  constructor(field, message) {
    super(message);
    this.field = field;
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

// A host the lab will not call as an issuer: any IP address (the URL parser turns 2130706433, 0x7f.1 and the like into
// dotted form, and IPv6 stays bracketed) and localhost. It keeps a typed issuer from pointing the lab at link-local,
// private or loopback services (169.254.169.254, 10.x, ::1). A name that merely resolves to such an address cannot be
// seen here; the owner's own PingFederate name (for example one that points at 127.0.0.1 on this Mac) is allowed.
function isDirectAddress(hostname) {
  // Dotted IPv4 (the URL parser's normal form) or a bracketed IPv6 literal.
  const bare = hostname.toLowerCase();
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.startsWith('[') || bare === 'localhost' || bare.endsWith('.localhost');
}

function checkUrl(value, { allowLoopbackHttp, hostNamesOnly = false }) {
  let url;
  try { url = new URL(value); } catch { return 'is not a URL'; }
  if (url.username || url.password) return 'must not carry credentials';
  if (url.hash) return 'must not have a fragment';
  if (hostNamesOnly && isDirectAddress(url.hostname)) return 'must use a host name, not an IP address or localhost';
  if (url.protocol === 'https:') return null;
  if (allowLoopbackHttp && url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return null;
  return allowLoopbackHttp ? 'must be https (http only on loopback)' : 'must be https';
}

function validate(kind, value, name) {
  if (typeof value !== 'string') throw new SettingsError(name, `${name} must be text`);
  const max = kind === 'secret' ? 1024 : 512;
  if (!value || value.length > max || CONTROL.test(value)) throw new SettingsError(name, `${name} must be 1 to ${max} characters, no control characters`);
  let problem = null;
  if (kind === 'https') problem = checkUrl(value, { allowLoopbackHttp: false, hostNamesOnly: true });
  if (kind === 'redirect' || kind === 'link') problem = checkUrl(value, { allowLoopbackHttp: true });
  if (kind === 'id' && !/^[\x21-\x7e]{1,256}$/.test(value)) problem = 'must be printable ASCII with no spaces';
  if (kind === 'scope' && !/^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/.test(value)) problem = 'must be space-separated scope tokens';
  if (problem) throw new SettingsError(name, `${name} ${problem}`);
  // The issuer is compared exactly with PingFederate's discovery document, so keep it as typed minus a trailing slash.
  return kind === 'https' ? value.replace(/\/+$/, '') : value;
}

// A symlinked settings file is refused: writes and chmod would land wherever the link points.
function refuseSymlink(file) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { return false; }
  if (stat.isSymbolicLink()) throw new SettingsError('file', 'The settings file is a symbolic link; refusing to use it');
  return true;
}

// Written to an unpredictable temp file created exclusively (O_EXCL: never an existing file or link) in the same
// directory, mode 600 set on the open descriptor, then renamed over the target.
function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  refuseSymlink(file);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(12).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(data, null, 2)}\n`);
  } finally { fs.closeSync(fd); }
  try { fs.renameSync(tmp, file); } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
}

// value/section/ready/missing over one set of values (stored, else the default, else '').
function reader(getValues, port) {
  const defaults = { pf: { redirectUri: `http://127.0.0.1:${port}/callback` } };
  function value(section, name) {
    const stored = getValues()[section]?.[name];
    if (stored !== undefined) return stored;
    return defaults[section]?.[name] ?? SCHEMA[section]?.[name]?.default ?? '';
  }
  function section(name) {
    const out = {};
    for (const field of Object.keys(SCHEMA[name])) out[field] = value(name, field);
    return out;
  }
  const ready = (card) => (REQUIRED[card] || []).every(([s, f]) => Boolean(value(s, f)));
  // Which settings a card still needs, as "section.field" names (the Settings page anchors on them).
  const missing = (card) => (REQUIRED[card] || []).filter(([s, f]) => !value(s, f)).map(([s, f]) => `${s}.${f}`);
  return { value, section, ready, missing };
}

// Fixed, in-memory settings (the mock PingFederate's clients): read-only, nothing is written anywhere.
export function createFixedSettings(values, { port = DEFAULT_PORT } = {}) {
  return reader(() => values, port);
}

export const MODES = ['mock', 'live'];

export function createSettings({ file = process.env.PFLAB_SETTINGS_FILE || DEFAULT_FILE, port = DEFAULT_PORT } = {}) {
  let values = {};
  let storedMode = null; // 'mock' | 'live' once chosen
  let impliedMode = 'mock'; // never chosen: live if an issuer was set when the lab started, else mock (fixed until chosen)

  function load() {
    let parsed = {};
    // A missing file is an empty lab. A file that is a link, or is not JSON, stops the lab: it is never silently
    // ignored and then overwritten (the owner fixes or removes it).
    if (refuseSymlink(file)) {
      const stat = fs.statSync(file);
      // A settings file anyone else can read is narrowed to the owner before it is used.
      if ((stat.mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
        throw new SettingsError('file', `The settings file ${file} is not valid JSON; fix or remove it`);
      }
    }
    values = {};
    storedMode = MODES.includes(parsed?.mode) ? parsed.mode : null;
    const stored = parsed && typeof parsed.values === 'object' && parsed.values ? parsed.values : {};
    // Only known fields that still validate are kept; anything else in the file is ignored.
    for (const [section, fields] of Object.entries(SCHEMA)) {
      for (const [name, spec] of Object.entries(fields)) {
        const raw = stored?.[section]?.[name];
        if (raw === undefined) continue;
        try { (values[section] ||= {})[name] = validate(spec.kind, raw, `${section}.${name}`); } catch { /* dropped */ }
      }
    }
    impliedMode = values.pf?.issuer ? 'live' : 'mock';
  }
  load();

  const { value, section, ready, missing } = reader(() => values, port);

  // The mode the owner chose; never chosen, live when a PingFederate issuer was set at start, otherwise mock. Saving
  // an issuer later does not switch modes: only the toggle does.
  const mode = () => storedMode || impliedMode;
  const save = (nextValues, nextMode) => writePrivate(file, { version: 1, ...(nextMode ? { mode: nextMode } : {}), values: nextValues });
  function setMode(next) {
    if (!MODES.includes(next)) throw new SettingsError('mode', 'mode must be mock or live');
    save(values, next);
    storedMode = next;
    return mode();
  }

  // Safe for the page: every non-secret value, and for secrets only { set: true|false }.
  function publicView() {
    const out = {};
    for (const [name, fields] of Object.entries(SCHEMA)) {
      out[name] = {};
      for (const [field, spec] of Object.entries(fields)) {
        out[name][field] = spec.kind === 'secret' ? { set: Boolean(values[name]?.[field]) } : value(name, field);
      }
    }
    return { settings: out, ready: Object.fromEntries(Object.keys(REQUIRED).map((card) => [card, ready(card)])) };
  }

  // patch: { section: { field: string | null } }. null clears a field. For a secret, '' or an omitted field keeps
  // the stored value (the page never has it to send back). Validates everything before writing anything.
  function update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new SettingsError(null, 'Settings must be an object');
    const next = structuredClone(values);
    for (const [sectionName, fields] of Object.entries(patch)) {
      const spec = Object.hasOwn(SCHEMA, sectionName) ? SCHEMA[sectionName] : null;
      if (!spec) throw new SettingsError(sectionName, `Unknown section ${sectionName}`);
      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new SettingsError(sectionName, `${sectionName} must be an object`);
      for (const [name, raw] of Object.entries(fields)) {
        const fieldSpec = Object.hasOwn(spec, name) ? spec[name] : null;
        if (!fieldSpec) throw new SettingsError(`${sectionName}.${name}`, `Unknown field ${sectionName}.${name}`);
        if (raw === null) { if (next[sectionName]) delete next[sectionName][name]; continue; }
        if (raw === '' && fieldSpec.kind === 'secret') continue;
        if (raw === '') { if (next[sectionName]) delete next[sectionName][name]; continue; }
        (next[sectionName] ||= {})[name] = validate(fieldSpec.kind, raw, `${sectionName}.${name}`);
      }
    }
    save(next, storedMode);
    values = next;
    return publicView();
  }

  return { file, value, section, ready, missing, publicView, update, mode, setMode, reload: load };
}
