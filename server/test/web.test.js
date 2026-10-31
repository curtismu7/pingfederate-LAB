import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { startLab, tempSettingsFile } from './helpers.js';
import { createApp } from '../src/app.js';
import { renderStory, loadStories, fill, tokensIn, StoryError, verticalList } from '../src/stories.js';
import { validateConfig, VERTICALS, CAST_KEYS } from '../src/customer.js';

test('config: branding, vocabulary and the issuer for the banner; no secret', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('GET', '/api/config');
    assert.equal(res.data.issuer, 'https://pf.example');
    assert.equal(res.data.customer.name, 'PingFederate LAB');
    assert.ok(!/secret-value|secret-1/.test(res.text));
  } finally { await lab.close(); }
  const empty = await startLab({ settings: null, mode: 'live' });
  try { assert.equal((await empty.call('GET', '/api/config')).data.issuer, null); } finally { await empty.close(); }
});

test('cards say which settings are missing, in shelf order', async () => {
  const lab = await startLab({ settings: { pf: { issuer: 'https://pf.example' } } });
  try {
    const { data } = await lab.call('GET', '/api/cards');
    assert.deepEqual(data.cards.map((c) => c.id), ['signin', 'dcr', 'rar', 'ciba', 'dpop', 'tokenExchange', 'userinfo', 'piflow', 'par', 'pkce', 'playground', 'cimd', 'idJag', 'discovery']);
    const ciba = data.cards.find((c) => c.id === 'ciba');
    assert.deepEqual(ciba.missing, ['ciba.clientId', 'ciba.clientSecret']);
    assert.deepEqual(data.cards.find((c) => c.id === 'rar').variantsMissing.dpop, ['rarDpop.clientId']);
    assert.deepEqual(data.cards.find((c) => c.id === 'idJag').missing, ['links.idJagUrl']);
    assert.equal(data.cards.find((c) => c.id === 'playground').ready, true);
  } finally { await lab.close(); }
});

test('stories: three verticals, every pack tells every card, no undefined token', async () => {
  const stories = loadStories();
  assert.deepEqual(VERTICALS, ['banking', 'healthcare', 'retail']);
  for (const v of VERTICALS) {
    const s = renderStory(v);
    assert.deepEqual(Object.keys(s.cards).sort(), [...stories.common.cards].sort());
    assert.ok(Object.values(s.cards).every((t) => t && !/\{\{|\}\}/.test(t)), v);
  }
  for (const pack of Object.values(stories.packs)) {
    for (const text of Object.values(pack.cards)) for (const k of tokensIn(text)) assert.ok(CAST_KEYS.includes(k) || ['agentWord', 'userWord', 'serviceWord'].includes(k), k);
  }
  assert.throws(() => fill('Hi {{cast.nobody}}', { user: 'x' }), StoryError);
  assert.throws(() => renderStory('__proto__'), StoryError);
  assert.equal(verticalList().length, 3);
  const lab = await startLab();
  try {
    assert.equal((await lab.call('GET', '/api/stories')).data.default, 'banking');
    assert.match((await lab.call('GET', '/api/stories/retail')).data.cards.dcr, /Copperline/);
    assert.equal((await lab.call('GET', '/api/stories/nope')).status, 404);
  } finally { await lab.close(); }
});

test('customer config: vocabulary flows into the stories; purple and bad values fall back', () => {
  const { config, warnings } = validateConfig({ accent: '#7a3cff', vocabulary: { agent: 'digital teller' }, cast: { agent: 'Aurora', bad: 'x' } });
  assert.equal(config.accent, '#d20e0f');
  assert.ok(warnings.some((w) => w.startsWith('accent')));
  const story = renderStory('banking', config);
  assert.match(story.intro[0], /lets Aurora, its digital teller, act for its customers/);
});

test('every response carries the security headers', async () => {
  const lab = await startLab();
  try {
    const res = await lab.call('GET', '/api/health');
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'.*connect-src 'self'.*frame-ancestors 'none'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally { await lab.close(); }
});

test('the built UI is served, with SPA fallback; API misses stay JSON; Host check applies', async () => {
  const webDist = fs.mkdtempSync(path.join(os.tmpdir(), 'pflab-dist-'));
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>PingFederate LAB</title><div id="root"></div>');
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  server.on('request', createApp({ port, settingsFile: tempSettingsFile(), webDist, fetchImpl: async () => { throw new Error('no outbound here'); } }));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (const p of ['/', '/settings', '/run/dcr']) assert.match(await (await fetch(`${base}${p}`)).text(), /PingFederate LAB/, p);
    const miss = await fetch(`${base}/api/nothing`);
    assert.equal(miss.status, 404);
    assert.deepEqual(await miss.json(), { error: 'not_found' });
    const status = await new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }); });
    assert.equal(status, 403);
  } finally { server.closeAllConnections(); server.close(); }
});

// Step 2 review fixes.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPurple, hue, deriveDark } from '../src/customer.js';

test('no purple: 250 to 330 degrees refused, both edges, including purple-magenta', () => {
  for (const hex of ['#a0158f', '#b0109a', '#7a3cff', '#6a1b9a']) assert.equal(isPurple(hex), true, hex);
  assert.ok(hue('#a0158f') > 300 && hue('#b0109a') > 300, 'these sit above the old 300 limit');
  assert.equal(isPurple('#2a1fd6'), hue('#2a1fd6') >= 250, 'blue-violet edge follows the range');
  for (const hex of ['#b3122d', '#0b6b6b', '#1d4f8c', '#c2185b']) assert.equal(isPurple(hex), false, `${hex} hue ${hue(hex)}`);
  const { config, warnings } = validateConfig({ accent: '#a0158f' });
  assert.equal(config.accent, '#d20e0f');
  assert.ok(warnings.some((w) => /purple range \(250 to 330/.test(w)));
  const dark = deriveDark('#c2185b');
  assert.ok(dark === null || !isPurple(dark));
});

test('customer text: contrast, markup and control or format characters fall back to defaults', () => {
  const low = validateConfig({ accent: '#f0e000' });
  assert.equal(low.config.accent, '#d20e0f');
  assert.ok(low.warnings.some((w) => /contrast/.test(w)));
  for (const name of ['<b>Bank</b>', 'Bank {{cast.x}}', 'Bank‮knab', 'Ba​nk', 'Bank⁦x', 'Bank\u0085']) {
    const r = validateConfig({ name, tagline: name, vocabulary: { agent: name } });
    assert.equal(r.config.name, 'PingFederate LAB', JSON.stringify(name));
    assert.equal(r.config.tagline, validateConfig({}).config.tagline);
    assert.equal(r.config.vocabulary.agent, 'AI agent');
    assert.equal(r.warnings.length, 3, JSON.stringify(name));
  }
});

test('the intro reads right whatever the agent word is', () => {
  for (const agent of ['AI agent', 'digital assistant', 'helper']) {
    const s = renderStory('banking', { ...validateConfig({ vocabulary: { agent } }).config });
    assert.doesNotMatch(s.intro[0], /\ban [bcdfghjklmnpqrstvwxyz]/i);
    assert.match(s.intro[0], new RegExp(`its ${agent}`));
  }
});

test('the CSP allows no inline style or script and no eval', async () => {
  const lab = await startLab();
  try {
    const csp = (await lab.call('GET', '/api/health')).headers.get('content-security-policy');
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|unsafe-hashes|\*/);
    assert.match(csp, /style-src 'self';/);
  } finally { await lab.close(); }
});

test('customer.config warnings are logged at startup and returned for the Settings page', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pflab-cc-'));
  const cc = path.join(dir, 'customer.config.json');
  fs.writeFileSync(cc, JSON.stringify({ accent: '#a0158f' }));
  const index = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');
  const child = spawn(process.execPath, [index], { env: { ...process.env, PORT: '5441', CUSTOMER_CONFIG: cc, PFLAB_SETTINGS_FILE: path.join(dir, 'pf.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 50 && !out.includes('PingFederate LAB on'); i += 1) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /customer\.config: accent: is in the purple range/);
    const config = await (await fetch('http://127.0.0.1:5441/api/config')).json();
    assert.ok(config.customer.warnings.some((w) => w.startsWith('accent')));
  } finally { child.kill(); }
});
