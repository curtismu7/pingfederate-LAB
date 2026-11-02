// npm run e2e: drives the built lab in a real browser (Playwright, Chromium), in mock mode, on a throwaway settings file.
// It starts the server the way a plain `npm start` does (no ALLOW_MOCK_SIGNIN), runs all 11 Playground flows to completion,
// each in a fresh browser context (so every sign-in dialog runs), then checks the Activity/Token tab keys, the explainer and the Token tab in light and dark at 1280 and 375 wide. Every request must stay on loopback.
// Needs `npm run build` first and a Chromium (`npx playwright install chromium`). E2E_PORT (5400-5449, default 5449) picks
// the port; E2E_SHOTS=<folder> saves a screenshot per theme and width. Exit 1 on the first failed check.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.E2E_PORT || 5449);
const base = `http://127.0.0.1:${port}`;
const shots = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : null;
if (!fs.existsSync(path.join(root, 'web', 'dist', 'index.html'))) { console.error('run `npm run build` first'); process.exit(1); }
if (shots) fs.mkdirSync(shots, { recursive: true });

// A temp settings file, so the owner's real one is never read; the lab starts in mock mode because nothing names a PingFederate.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pflab-e2e-'));
const env = { ...process.env, PORT: String(port), PFLAB_SETTINGS_FILE: path.join(dir, 'pingfederate.json'), CUSTOMER_CONFIG: path.join(dir, 'none.json') };
delete env.ALLOW_MOCK_SIGNIN;
delete env.LAB_PUBLISH;
delete env.LAB_BIND;
const server = spawn(process.execPath, [path.join(root, 'server', 'src', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
const cleanup = () => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); };

const failures = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`); if (!ok) failures.push(name); };

async function main() {
  for (let i = 0; i < 300 && !log.includes('PingFederate LAB on'); i += 1) await new Promise((r) => setTimeout(r, 100));
  if (!log.includes('PingFederate LAB on')) throw new Error(`the lab did not start: ${log.slice(0, 300)}`);
  const mode = await (await fetch(`${base}/api/mode`)).json();
  check('plain start is in mock mode and allows mock sign-in', mode.mode === 'mock' && mode.mockSignIn?.allowed === true);
  const user = mode.mockSignIn.username;
  const password = mode.mockSignIn.password;

  const browser = await chromium.launch();
  const requests = [];
  const problems = [];
  let context;
  let page;
  // A fresh browser context (no cookies), so a flow's sign-in dialog runs for every flow, not just the first one.
  const freshPage = async (scheme = 'light', size = { width: 1280, height: 900 }) => {
    await context?.close();
    context = await browser.newContext({ viewport: size, colorScheme: scheme });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      requests.push(url);
      return /^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:)/.test(url) ? route.continue() : route.abort();
    });
    page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  };

  const openFlow = async (title) => {
    await page.goto(`${base}/#/playground`);
    await page.getByRole('navigation', { name: 'Flows' }).getByRole('button', { name: title, exact: false }).first().click();
  };

  // Runs the open flow to the end: answers the sign-in dialog and the CIBA approval when they appear.
  const runToEnd = async (flowId) => {
    const panel = page.locator('.pg-flow');
    const user_ = panel.getByLabel('User (login_hint)');
    if (await user_.count()) await user_.fill(user);
    await panel.getByRole('button', { name: 'Run all' }).click();
    const runAll = panel.getByRole('button', { name: 'Run all' });
    const deadline = Date.now() + 45000;
    let dialogs = 0;
    while (Date.now() < deadline) {
      const dialog = page.getByRole('dialog');
      if (await dialog.count()) {
        dialogs += 1;
        await dialog.getByLabel('Username').fill(user);
        await dialog.getByLabel('Password').fill(password);
        await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
      }
      const approve = page.getByRole('region', { name: 'Approve on this page' }).getByRole('button', { name: 'Approve' });
      if (await approve.count() && await approve.isEnabled()) await approve.click();
      if (await runAll.isEnabled() && !(await page.getByRole('dialog').count())) break;
      await page.waitForTimeout(150);
    }
    return dialogs;
  };

  const flowTitles = [['signin', 'Sign in (pi.flow)'], ['dcr', 'Dynamic client registration'], ['rar', 'RAR via PAR'], ['ciba', 'CIBA'], ['dpop', 'DPoP sign-in'],
    ['tokenExchange', 'Token exchange'], ['userinfo', 'Userinfo'], ['piflow', 'Authentication API'], ['par', 'PAR'], ['pkce', 'PKCE'], ['discovery', 'Discovery check']];
  for (const [id, title] of flowTitles) {
    await freshPage();
    // These two read the session the sign-in flow leaves behind, so each starts by signing in (in its own fresh browser).
    if (id === 'tokenExchange' || id === 'userinfo') { await openFlow('Sign in (pi.flow)'); await runToEnd('signin'); }
    await openFlow(title);
    const about = page.getByRole('region', { name: /^About / });
    const explained = await about.getByText('Why it matters for AI agents').count() === 1 && await about.getByRole('link').count() === 1;
    const dialogs = await runToEnd(id);
    const chips = await page.locator('.pg-flow .steps .chip').evaluateAll((els) => els.map((e) => e.textContent));
    const errors = await page.locator('.pg-flow .step-err, .pg-flow .pt-error, .pg-flow .pt-refused').count();
    const done = chips.filter((c) => c === 'done').length;
    check(`flow ${id} runs to completion in mock`, errors === 0 && done >= 1 && chips.every((c) => c === 'done' || c === 'not needed'), `steps: ${chips.join(', ')}`);
    check(`flow ${id} ran its sign-in step in a fresh browser (no step skipped as 'not needed')`, !chips.includes('not needed'), `${dialogs} sign-in dialog${dialogs === 1 ? '' : 's'}`);
    check(`flow ${id} shows the explainer with a spec link`, explained);
  }

  // The explainer and the Token tab, light and dark, wide and phone width.
  const viewports = [['1280', { width: 1280, height: 900 }], ['375', { width: 375, height: 800 }]];
  for (const scheme of ['light', 'dark']) {
    for (const [name, size] of viewports) {
      await freshPage(scheme, size);
      await openFlow('Sign in (pi.flow)');
      await runToEnd('signin');
      await page.getByRole('tab', { name: 'Token' }).click();
      const token = page.getByRole('tabpanel', { name: 'Token' });
      const facts = await token.locator('.token-facts dd').allTextContents();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const visible = await page.getByRole('region', { name: /^About / }).isVisible() && await token.isVisible();
      check(`${scheme} ${name}px: explainer and Token tab render, claims shown, no sideways scroll`, visible && facts.length >= 4 && facts.some((f) => f.includes('openid')) && overflow <= 0, `${facts.length} claim rows, overflow ${overflow}px`);
      if (shots) await page.screenshot({ path: path.join(shots, `playground-token-${scheme}-${name}.png`), fullPage: false });
    }
  }

  // The Activity/Token tabs follow the ARIA pattern: roving tabindex, Left/Right wrap, Home/End.
  const tabs = page.getByRole('tablist', { name: 'Activity and token' });
  const selected = async () => tabs.getByRole('tab', { selected: true }).textContent();
  await tabs.getByRole('tab', { name: 'Activity' }).click();
  const tabindexes = await tabs.getByRole('tab').evaluateAll((els) => els.map((e) => e.tabIndex));
  await page.keyboard.press('ArrowRight');
  const afterRight = [await selected(), await page.evaluate(() => document.activeElement?.textContent)];
  await page.keyboard.press('ArrowRight');
  const afterWrap = await selected();
  await page.keyboard.press('End');
  const afterEnd = await selected();
  await page.keyboard.press('Home');
  const afterHome = await selected();
  check('Activity/Token tabs: roving tabindex and arrow-key navigation', tabindexes.join() === '0,-1' && afterRight.join() === 'Token,Token' && afterWrap === 'Activity' && afterEnd === 'Token' && afterHome === 'Activity',
    `tabindex ${tabindexes}, right ${afterRight}, wrap ${afterWrap}, end ${afterEnd}, home ${afterHome}`);

  const off = requests.filter((u) => !/^(http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/|data:|blob:)/.test(u));
  check('zero requests left localhost', off.length === 0, `${requests.length} requests, ${off.length} off-localhost`);
  check('no page errors or console errors', problems.length === 0, problems.slice(0, 3).join(' | '));
  await browser.close();
}

try { await main(); } catch (error) { failures.push('crash'); console.error(error.message); } finally { cleanup(); }
console.log(failures.length ? `e2e FAILED: ${failures.join(', ')}` : 'e2e passed');
process.exit(failures.length ? 1 : 0);
