// npm run reset [workspace]: clears the run state of one workspace on the running lab (runs, results, tokens, trace;
// sign-ins and saved settings stay). Workspace: first argument, or WORKSPACE, or "default". LAB_URL points it at
// another loopback address (default: http://127.0.0.1:$PORT, then https).
import http from 'node:http';
import https from 'node:https';

const workspace = process.argv[2] || process.env.WORKSPACE || 'default';
const port = Number(process.env.PORT || 5400);
const base = process.env.LAB_URL ? new URL(process.env.LAB_URL) : null;
if (base && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) { console.error('LAB_URL must be a loopback address'); process.exit(1); }

const post = (lib, host, hostPort, options = {}) => new Promise((resolve) => {
  const req = lib.request({ host, port: hostPort, method: 'POST', path: `/api/workspaces/${encodeURIComponent(workspace)}/reset`, timeout: 4000, headers: { 'content-type': 'application/json' }, ...options }, (res) => {
    let text = '';
    res.on('data', (d) => { text += d; });
    res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { resolve(null); } });
  });
  req.on('error', () => resolve(null));
  req.on('timeout', () => req.destroy());
  req.end('{}');
});

const host = base?.hostname.replace(/^\[|\]$/g, '') || '127.0.0.1';
const targetPort = base ? Number(base.port) || (base.protocol === 'https:' ? 443 : 80) : port;
let answer = base?.protocol === 'https:' ? null : await post(http, host, targetPort);
answer ||= await post(https, host, targetPort, { rejectUnauthorized: false }); // loopback only
if (!answer) { console.log(`no lab answers on ${host}:${targetPort}; its run state lives in memory, so there is nothing to reset`); process.exit(0); }
if (answer.status !== 200) { console.error(`reset refused: ${answer.body?.error || answer.status}`); process.exit(1); }
const left = answer.body.dcrClientsLeftOnPingFederate || [];
console.log(`reset workspace "${answer.body.workspace}": ${answer.body.sessionsReset} session(s) cleared; settings and sign-ins kept`);
if (left.length) console.log(`DCR clients still on PingFederate: ${left.join(', ')}`);
