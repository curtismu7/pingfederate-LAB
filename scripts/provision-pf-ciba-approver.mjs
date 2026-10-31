#!/usr/bin/env node
// provision-pf-ciba-approver.mjs: let the CIBA card approve on the lab's own page. On a PingFederate that already has
// the demo web-approver CIBA plugin, it creates (or re-points) the lab's own instance of that plugin with the lab's
// approval URL and a new shared secret, a CIBA request policy that uses it, and points ONLY the lab's CIBA client at
// that policy. Every other client and policy keeps what it had. The secret is saved to the lab's settings file
// (ciba.approverSecret); restart the lab afterwards so it reads it. Dry run by default; --apply makes the changes.
// Prints no secret.
//
//   PF_ADMIN_BASE=https://<pf-admin-host>:<port>/pf-admin-api/v1   (required)
//   PINGFEDERATE_ADMIN_PASSWORD=...                                (required; never printed)
//   PFLAB_APPROVAL_URL=https://<lab host>:<port>/api/ciba-approver (required; PingFederate must reach it)
//   PFLAB_CIBA_TEMPLATE_PLUGIN=<id of an existing web-approver plugin instance to copy>
//   PFLAB_CIBA_TEMPLATE_POLICY=<id of an existing CIBA request policy that uses it>
//   PF_ADMIN_INSECURE=1      only for a PingFederate admin API with a self-signed certificate (local Docker)
//   node scripts/provision-pf-ciba-approver.mjs [--apply]
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createSettings } from '../server/src/settings.js';
import { createAdminApi } from './provision-pf.mjs';

const READ_ONLY = ['lastModified', 'creationDate', 'modificationDate'];
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !READ_ONLY.includes(k)));

export async function provisionCibaApprover({ api, settings, approvalUrl, templatePlugin, templatePolicy, apply, prefix = 'pfLab', log = () => {} }) {
  if (!/^https:\/\/[^/]+\/api\/ciba-approver$/.test(approvalUrl)) throw new Error('PFLAB_APPROVAL_URL must be https://<host>[:port]/api/ciba-approver');
  const clientId = settings.value('ciba', 'clientId');
  if (!clientId || !clientId.startsWith(`${prefix}-`)) throw new Error(`The lab's CIBA client must be one of its own (${prefix}-...); got ${clientId || 'none'}`);
  const pluginId = `${prefix}CibaWebApprover`;
  const policyId = `${prefix}CibaWebPolicy`;

  const tPlugin = await api('GET', `oauth/outOfBandAuthPlugins/${encodeURIComponent(templatePlugin)}`);
  if (!tPlugin) throw new Error(`Template plugin ${templatePlugin} not found`);
  const tPolicy = await api('GET', `oauth/cibaServerPolicy/requestPolicies/${encodeURIComponent(templatePolicy)}`);
  if (!tPolicy) throw new Error(`Template policy ${templatePolicy} not found`);
  if (tPolicy.authenticatorRef?.id !== templatePlugin) throw new Error(`Template policy ${templatePolicy} does not use ${templatePlugin}`);
  const client = await api('GET', `oauth/clients/${encodeURIComponent(clientId)}`);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const existingPlugin = await api('GET', `oauth/outOfBandAuthPlugins/${pluginId}`);
  const existingPolicy = await api('GET', `oauth/cibaServerPolicy/requestPolicies/${policyId}`);
  if (!apply) {
    log(`WOULD ${existingPlugin ? 're-point and rotate the secret of' : 'create'} plugin ${pluginId} (copy of ${templatePlugin}) -> ${approvalUrl}`);
    log(`WOULD ${existingPolicy ? 'keep' : 'create'} CIBA policy ${policyId} (copy of ${templatePolicy}) using ${pluginId}`);
    log(`WOULD point client ${clientId} at ${policyId} (now: ${client.requestPolicyRef?.id || 'the default policy'})`);
    return;
  }

  // 1. The plugin instance: the lab's URL and a new shared secret. Saved to the settings right away, because neither
  // the lab nor PingFederate can show it again.
  const secret = crypto.randomBytes(32).toString('base64url');
  const fields = tPlugin.configuration.fields.map((f) => (f.name === 'Approval URL' ? { name: f.name, value: approvalUrl }
    : f.name === 'Approval Credential' ? { name: f.name, value: secret } : { name: f.name, value: f.value }));
  if (!fields.some((f) => f.name === 'Approval URL') || !fields.some((f) => f.name === 'Approval Credential')) {
    throw new Error(`Template plugin ${templatePlugin} is not a web approver (no Approval URL / Approval Credential)`);
  }
  const plugin = { ...strip(tPlugin), id: pluginId, name: 'PingFederate Lab web approver (CIBA)', configuration: { ...tPlugin.configuration, fields } };
  await api(existingPlugin ? 'PUT' : 'POST', existingPlugin ? `oauth/outOfBandAuthPlugins/${pluginId}` : 'oauth/outOfBandAuthPlugins', plugin);
  settings.update({ ciba: { approverSecret: secret } });
  log(`plugin ${pluginId} ${existingPlugin ? 'updated' : 'created'} (secret saved)`);

  // 2. The policy: the template's identity-hint mapping, with the lab's plugin.
  if (!existingPolicy) {
    await api('POST', 'oauth/cibaServerPolicy/requestPolicies', { ...strip(tPolicy), id: policyId, name: 'PingFederate Lab CIBA (approve on the lab page)', authenticatorRef: { id: pluginId } });
    log(`policy ${policyId} created`);
  } else if (existingPolicy.authenticatorRef?.id !== pluginId) {
    await api('PUT', `oauth/cibaServerPolicy/requestPolicies/${policyId}`, { ...strip(existingPolicy), authenticatorRef: { id: pluginId } });
    log(`policy ${policyId} re-pointed at ${pluginId}`);
  } else log(`policy ${policyId} already uses ${pluginId}`);

  // 3. Only the lab's CIBA client uses it. clientAuth goes back as PingFederate sent it (encryptedSecret), so the
  // client keeps its secret.
  await api('PUT', `oauth/clients/${encodeURIComponent(clientId)}`, { ...strip(client), requestPolicyRef: { id: policyId } });
  const back = await api('GET', `oauth/clients/${encodeURIComponent(clientId)}`);
  log(`client ${clientId} -> ${back?.requestPolicyRef?.id === policyId ? policyId : 'NOT SET'}`);
}

async function main() {
  const APPLY = process.argv.includes('--apply');
  const env = process.env;
  const log = (m) => console.log(`[provision-pf-ciba-approver] ${m}`);
  const fail = (m) => { console.error(`[provision-pf-ciba-approver] ${m}`); process.exit(1); };
  const base = String(env.PF_ADMIN_BASE || '').replace(/\/$/, '');
  if (!/^https:\/\//.test(base)) fail('Set PF_ADMIN_BASE to the https PingFederate admin API base');
  if (!env.PINGFEDERATE_ADMIN_PASSWORD) fail('Set PINGFEDERATE_ADMIN_PASSWORD');
  if (!env.PFLAB_CIBA_TEMPLATE_PLUGIN || !env.PFLAB_CIBA_TEMPLATE_POLICY) fail('Set PFLAB_CIBA_TEMPLATE_PLUGIN and PFLAB_CIBA_TEMPLATE_POLICY');
  const settings = createSettings({ port: Number(env.PORT) || undefined, file: env.PFLAB_SETTINGS_FILE || undefined });
  const api = createAdminApi({ base, password: env.PINGFEDERATE_ADMIN_PASSWORD, insecure: env.PF_ADMIN_INSECURE === '1' });
  log(`${APPLY ? 'apply' : 'dry run'} against ${base}; settings ${settings.file}`);
  try {
    await provisionCibaApprover({ api, settings, approvalUrl: String(env.PFLAB_APPROVAL_URL || ''), templatePlugin: env.PFLAB_CIBA_TEMPLATE_PLUGIN,
      templatePolicy: env.PFLAB_CIBA_TEMPLATE_POLICY, apply: APPLY, prefix: env.PFLAB_CLIENT_PREFIX || 'pfLab', log });
  } catch (error) { fail(`stopped: ${error.message}`); }
  if (APPLY) log('done; restart the lab so it reads the new approver secret');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
