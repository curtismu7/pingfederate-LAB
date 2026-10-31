#!/usr/bin/env node
// provision-pf.mjs: create this lab's own OAuth clients on a PingFederate, and save their settings (ids and new
// secrets) into the lab's settings file. The owner runs it; it never runs from the app.
//
// Each lab client is cloned from a TEMPLATE client that already works on that PingFederate (named in a JSON file
// passed by the owner, kept out of this repo), with a new client id, the lab's redirect URI, the Authentication
// API (pi.flow) allowed for the sign-in style clients, and a newly generated secret where the template has one.
// Additive: an existing client is never changed or deleted. Dry run by default; --apply makes the changes and
// reads each client back. Prints no secret.
//
//   PF_ADMIN_BASE=https://<pf-admin-host>:<port>/pf-admin-api/v1   (required)
//   PINGFEDERATE_ADMIN_PASSWORD=...                                (required; never printed)
//   PF_ISSUER=https://<pf-runtime-host>                            (saved as pf.issuer)
//   PFLAB_TEMPLATES=<path to JSON: { "<role>": "<template client id>" }>
//   PF_ADMIN_INSECURE=1      only for a PingFederate admin API with a self-signed certificate (local Docker)
//   node scripts/provision-pf.mjs [--apply]
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { createSettings } from '../server/src/settings.js';

// role -> where its id and secret go in the lab's settings, and whether it signs people in (redirect + pi.flow).
export const ROLES = {
  signin: { section: 'signin', id: 'clientId', secret: 'clientSecret', signsIn: true },
  pkce: { section: 'pkce', id: 'clientId', secret: 'clientSecret', signsIn: true },
  par: { section: 'par', id: 'clientId', secret: 'clientSecret', signsIn: true },
  rar: { section: 'rar', id: 'clientId', secret: 'clientSecret', signsIn: true },
  rarDpop: { section: 'rarDpop', id: 'clientId', secret: 'clientSecret', signsIn: true },
  dpop: { section: 'dpop', id: 'clientId', secret: 'clientSecret', signsIn: true },
  ciba: { section: 'ciba', id: 'clientId', secret: 'clientSecret' },
  dcrIat: { section: 'dcr', id: 'iatClientId', secret: 'iatClientSecret' },
  agentExchange: { section: 'tokenExchange', id: 'agentExchangeClientId', secret: 'agentExchangeClientSecret' },
  mcpExchange: { section: 'tokenExchange', id: 'mcpExchangeClientId', secret: 'mcpExchangeClientSecret' },
  agentActor: { section: 'tokenExchange', id: 'agentActorClientId', secret: 'agentActorClientSecret' },
  mcpActor: { section: 'tokenExchange', id: 'mcpActorClientId', secret: 'mcpActorClientSecret' },
};
// Read-only or server-managed fields a client GET returns that a POST must not carry.
const DROP = ['clientAuth', 'creationDate', 'modificationDate', 'clientSecretChangedTime', 'clientSecretRetentionPeriod'];

// Only own properties of ROLES are roles ('constructor', '__proto__' and friends are not).
export function checkRoles(templates) {
  if (!templates || typeof templates !== 'object' || Array.isArray(templates)) throw new Error('The templates file must be a JSON object of { role: template client id }');
  for (const [role, id] of Object.entries(templates)) {
    if (!Object.hasOwn(ROLES, role)) throw new Error(`Unknown role ${role}; roles: ${Object.keys(ROLES).join(', ')}`);
    if (typeof id !== 'string' || !id) throw new Error(`Template for ${role} must be a client id`);
  }
  return templates;
}

// The admin API client. PF_ADMIN_INSECURE relaxes certificate checks for THESE calls only, through their own
// https.Agent; the rest of the process (and every other connection) keeps normal TLS verification.
export function adminAgent(insecure) {
  return new https.Agent({ rejectUnauthorized: !insecure });
}

export function createAdminApi({ base, password, insecure = false, request = https.request }) {
  const agent = adminAgent(insecure);
  const auth = `Basic ${Buffer.from(`administrator:${password}`).toString('base64')}`;
  return function api(method, resource, body) {
    const data = body ? JSON.stringify(body) : null;
    return new Promise((resolve, reject) => {
      const req = request(`${base}/${resource}`, {
        method,
        agent,
        headers: { Authorization: auth, 'X-XSRF-Header': 'PingFederate', Accept: 'application/json', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) },
        timeout: 15000,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = {};
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { json = {}; }
          if (res.statusCode === 404 && method === 'GET') return resolve(null);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const detail = (json.validationErrors || []).map((e) => e.message).join('; ') || json.message || '';
            return reject(new Error(`${method} ${resource} -> HTTP ${res.statusCode} ${detail}`.trim()));
          }
          return resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error(`${method} ${resource} timed out`)));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  };
}

// Creates the lab's clients. With apply, the settings are saved after EACH created client, so a failure halfway
// keeps the secrets of the clients already made (PingFederate never returns a secret again).
export async function provision({ api, settings, templates, issuer, apply, prefix = 'pfLab', log = () => {} }) {
  checkRoles(templates);
  const redirectUri = settings.value('pf', 'redirectUri');
  if (apply) settings.update({ pf: { issuer } });
  for (const [role, templateId] of Object.entries(templates)) {
    const spec = ROLES[role];
    const newId = `${prefix}-${role}`;
    const template = await api('GET', `oauth/clients/${encodeURIComponent(templateId)}`);
    if (!template) { log(`${role}: template ${templateId} not found, skipped`); continue; }
    const existing = await api('GET', `oauth/clients/${encodeURIComponent(newId)}`);
    if (existing) {
      log(`${role}: ${newId} already exists, left as it is${settings.value(spec.section, spec.secret) ? '' : ' (its secret is not in the settings file and PingFederate never returns it)'}`);
      if (apply) settings.update({ [spec.section]: { [spec.id]: newId } });
      continue;
    }
    const hasSecret = template.clientAuth?.type === 'SECRET';
    const body = Object.fromEntries(Object.entries(template).filter(([k]) => !DROP.includes(k)));
    Object.assign(body, { clientId: newId, name: `pingfederate-lab ${role}`, enabled: true });
    if (spec.signsIn) Object.assign(body, { redirectUris: [redirectUri], allowAuthenticationApiInit: true });
    // The template's OIDC logout URIs point at its own app; the lab does no OIDC logout, so they are not copied.
    if (body.oidcPolicy) body.oidcPolicy = { ...body.oidcPolicy, logoutUris: [], logoutMode: 'NONE' };
    const secret = hasSecret ? crypto.randomBytes(24).toString('base64url') : null;
    body.clientAuth = hasSecret ? { type: 'SECRET', secret } : { type: template.clientAuth?.type || 'NONE' };
    if (!apply) { log(`${role}: WOULD create ${newId} from ${templateId} (${hasSecret ? 'confidential' : 'public'}${spec.signsIn ? ', pi.flow + lab redirect' : ''})`); continue; }
    await api('POST', 'oauth/clients', body);
    // Saved before anything else can fail: the secret exists only here and on PingFederate now.
    settings.update({ [spec.section]: { [spec.id]: newId, ...(secret ? { [spec.secret]: secret } : {}) } });
    const back = await api('GET', `oauth/clients/${encodeURIComponent(newId)}`);
    log(`${role}: created ${newId}${secret ? ' (secret saved)' : ''}, readback ${back?.clientId === newId ? 'ok' : 'MISSING'}`);
  }
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const BASE = String(process.env.PF_ADMIN_BASE || '').replace(/\/$/, '');
  const PASSWORD = process.env.PINGFEDERATE_ADMIN_PASSWORD || '';
  const ISSUER = String(process.env.PF_ISSUER || '').replace(/\/$/, '');
  const TEMPLATES_FILE = process.env.PFLAB_TEMPLATES || '';
  const log = (m) => console.log(`[provision-pf] ${m}`);
  const fail = (m) => { console.error(`[provision-pf] ${m}`); process.exit(1); };
  if (!/^https:\/\//.test(BASE)) fail('Set PF_ADMIN_BASE to the https PingFederate admin API base');
  if (!PASSWORD) fail('Set PINGFEDERATE_ADMIN_PASSWORD');
  if (!/^https:\/\//.test(ISSUER)) fail('Set PF_ISSUER to the https PingFederate runtime origin');
  if (!TEMPLATES_FILE || !fs.existsSync(TEMPLATES_FILE)) fail('Set PFLAB_TEMPLATES to a JSON file of { role: template client id }');
  let templates;
  try { templates = checkRoles(JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'))); } catch (error) { fail(error.message); }
  const settings = createSettings({ port: Number(process.env.PORT) || undefined });
  log(`${APPLY ? 'apply' : 'dry run'} against ${BASE}; issuer ${ISSUER}; redirect ${settings.value('pf', 'redirectUri')}; settings ${settings.file}`);
  const api = createAdminApi({ base: BASE, password: PASSWORD, insecure: process.env.PF_ADMIN_INSECURE === '1' });
  try {
    await provision({ api, settings, templates, issuer: ISSUER, apply: APPLY, prefix: process.env.PFLAB_CLIENT_PREFIX || 'pfLab', log });
  } catch (error) {
    // The message names the call and PingFederate's validation text; never a secret.
    fail(`stopped: ${error.message}${APPLY ? ' (clients created before this point are saved)' : ''}`);
  }
  if (APPLY) log(`saved to ${settings.file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
