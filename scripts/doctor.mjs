// npm run doctor: one line per check, exit 1 when any fails. Works with no settings file and no PingFederate: the
// in-process checks run in mock mode on a temporary settings file, so nothing leaves this machine.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, DEMO } from '../server/src/app.js';
import { createSettings } from '../server/src/settings.js';
import { validateDiagram } from '../web/src/diagrams/validate.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
const check = (name, fn) => checks.push({ name, fn });

const listenFree = (port) => new Promise((resolve) => {
  const probe = net.createServer();
  probe.once('error', (error) => resolve(error.code === 'EADDRINUSE' ? 'busy' : 'error'));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve('free')));
});

// GET a loopback health route over http, then https (the Docker form serves https with a local certificate).
const getHealth = (port) => new Promise((resolve) => {
  const attempt = (lib, options, next) => {
    const req = lib.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 2000, ...options }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; if (text.length > 8192) req.destroy(); });
      res.on('end', () => { try { resolve(JSON.parse(text)); } catch { next(); } });
    });
    req.on('error', next);
    req.on('timeout', () => req.destroy());
  };
  attempt(http, {}, () => attempt(https, { rejectUnauthorized: false }, () => resolve(null))); // loopback only
});

check('node 26 or newer', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 26) throw new Error(`Node ${process.versions.node}; this lab needs 26`);
  return `Node ${process.versions.node}`;
});

// Scratch folders the checks make are removed when the doctor exits, whether it passed or failed.
const scratch = [];
const tempDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pflab-doctor-')); scratch.push(dir); return dir; };
process.on('exit', () => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });

check('settings file readable', () => {
  const settings = createSettings({});
  const exists = fs.existsSync(settings.file);
  return exists ? `${path.basename(path.dirname(settings.file))}/${path.basename(settings.file)} parses; mode ${settings.mode()}` : 'no settings file yet (mock mode needs none)';
});

check('mock mode: netguard self-test, zero real attempts', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'pingfederate.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'mock', values: {} }), { mode: 0o600 });
  const app = createApp({ port: 5400, settingsFile: file, webDist: path.join(dir, 'no-dist'), customerFile: path.join(dir, 'no-customer.json'), fetchImpl: () => { throw new Error('a real fetch was attempted'); } });
  const result = await app.locals.netguard.selfTest();
  if (!result.ok) throw new Error('the netguard self-test failed');
  if (app.locals.netguard.stats().realAttempts !== 0) throw new Error('the netguard saw a real outbound attempt');
  return 'a real URL is refused before any socket opens';
});

check('health route answers demo-health/1', async () => {
  const dir = tempDir();
  const file = path.join(dir, 'pingfederate.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, mode: 'mock', values: {} }), { mode: 0o600 });
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  server.on('request', createApp({ port, settingsFile: file, webDist: path.join(dir, 'no-dist'), customerFile: path.join(dir, 'no-customer.json') }));
  try {
    const health = await getHealth(port);
    if (health?.schema !== 'demo-health/1' || health.demo?.id !== DEMO.id) throw new Error('unexpected health reply');
    if (health.runtime !== 'offline') throw new Error(`runtime is ${health.runtime}; mock mode should be offline`);
    return `state ${health.state}, runtime ${health.runtime}`;
  } finally { server.closeAllConnections(); server.close(); }
});

check('port free, or already this lab', async () => {
  const port = Number(process.env.PORT || 5400);
  if (!Number.isInteger(port) || port < 5400 || port > 5449) throw new Error('PORT must be between 5400 and 5449');
  if (await listenFree(port) === 'free') return `${port} is free`;
  const health = await getHealth(port);
  if (health?.demo?.id === DEMO.id) return `${port} is in use by this lab (${health.runtime})`;
  throw new Error(`${port} is in use by something else (see the port section of the README)`);
});

check('diagrams load', () => {
  const dir = path.join(root, 'web', 'src', 'diagrams');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error('no diagrams found');
  for (const f of files) {
    const problems = validateDiagram(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    if (problems.length) throw new Error(`${f}: ${problems[0]}`);
  }
  return `${files.length} diagram-studio/1 diagrams validate`;
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    const detail = await fn();
    console.log(`ok    ${name}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL  ${name}: ${error.message}`);
  }
}
process.exit(failed ? 1 : 0);
