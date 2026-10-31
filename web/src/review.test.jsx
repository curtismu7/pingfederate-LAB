// Tests for the step-2 review fixes. Each fails if its fix is reverted.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, renderHook, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { viewTitle } from './App.jsx';
import DiagramView, { usePositions, resetDiagram } from './DiagramView.jsx';
import { reduce, initial, useStepper, speedMs } from './stepper.js';
import { loadDiagram } from './diagrams/index.js';
import { mockServer, BASE_ROUTES, CARDS } from './testApi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const go = (hash) => { window.location.hash = hash; };
beforeEach(() => go('#/'));
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const view = {
  settings: { pf: { issuer: 'https://pf.example', redirectUri: 'http://127.0.0.1:5400/callback' }, ciba: { clientId: 'c1', clientSecret: { set: true }, scope: 'openid' } },
  ready: { discovery: true },
};

describe('1. skip link', () => {
  it('moves focus to main without changing the route, so Settings keeps what was typed', async () => {
    mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view });
    go('#/settings');
    render(<App />);
    const scopes = await screen.findByLabelText('Scopes');
    await userEvent.clear(scopes);
    await userEvent.type(scopes, 'openid typed');
    await userEvent.type(screen.getByLabelText(/^Client secret/), 'typed-secret');
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' }));
    expect(window.location.hash).toBe('#/settings');
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Scopes')).toHaveValue('openid typed');
    expect(screen.getByLabelText(/^Client secret/)).toHaveValue('typed-secret');
    expect(document.activeElement).toBe(document.getElementById('main'));
  });
});

describe('2 and 11. diagrams: positions, Reset, speed, Pause', () => {
  const diagram = loadDiagram('pfl-pkce');

  it('a moved box goes back to its data position on Reset', () => {
    const { result } = renderHook(() => usePositions(diagram));
    const original = { ...result.current.positions.lab };
    act(() => result.current.move('lab', { x: 999, y: -42 }));
    expect(result.current.positions.lab).toEqual({ x: 999, y: -42 });
    act(() => resetDiagram({ reset: result.current.reset, dispatch: () => {}, instance: null }));
    expect(result.current.positions.lab).toEqual(original);
  });

  it('Reset also stops the walkthrough and re-fits zoom and pan', () => {
    const reset = vi.fn(); const dispatch = vi.fn(); const fitView = vi.fn();
    resetDiagram({ reset, dispatch, instance: { fitView } });
    expect(reset).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: 'stop' });
    expect(fitView).toHaveBeenCalledOnce();
  });

  it('the stepper walks, pauses, resumes, steps and stops', () => {
    let s = initial(3);
    s = reduce(s, { type: 'simulate' }); expect(s).toMatchObject({ step: 0, paused: false });
    s = reduce(s, { type: 'tick' }); expect(s.step).toBe(1);
    s = reduce(s, { type: 'pause' }); expect(s.paused).toBe(true);
    expect(reduce(s, { type: 'tick' }).step).toBe(1);
    s = reduce(s, { type: 'resume' }); expect(s.paused).toBe(false);
    s = reduce(reduce(s, { type: 'tick' }), { type: 'tick' }); expect(s).toMatchObject({ step: 2, paused: true });
    expect(reduce(s, { type: 'prev' }).step).toBe(1);
    expect(reduce(s, { type: 'goto', step: 99 }).step).toBe(2);
    expect(reduce(s, { type: 'speed', speed: 'warp' }).speed).toBe('normal');
    expect(reduce(s, { type: 'stop' }).step).toBe(-1);
  });

  it('the speed control changes how fast the walkthrough moves', () => {
    vi.useFakeTimers();
    expect(speedMs('fast')).toBeLessThan(speedMs('normal'));
    const fast = renderHook(() => useStepper(4));
    act(() => { fast.result.current[1]({ type: 'speed', speed: 'fast' }); fast.result.current[1]({ type: 'simulate' }); });
    act(() => { vi.advanceTimersByTime(speedMs('fast') + 10); });
    expect(fast.result.current[0].step).toBe(1);
    const normal = renderHook(() => useStepper(4));
    act(() => normal.result.current[1]({ type: 'simulate' }));
    act(() => { vi.advanceTimersByTime(speedMs('fast') + 10); });
    expect(normal.result.current[0].step).toBe(0);
  });

  it('Pause is off until a walkthrough runs; the controls are a group, not a toolbar', async () => {
    render(<DiagramView id="pfl-pkce" />);
    const controls = screen.getByRole('group', { name: /diagram controls/ });
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(within(controls).getByRole('button', { name: 'Pause' })).toBeDisabled();
    await userEvent.click(within(controls).getByRole('button', { name: 'Simulate' }));
    expect(within(controls).getByRole('button', { name: 'Pause' })).toBeEnabled();
  });
});

describe('3. customer.config warnings', () => {
  it('are shown on Settings', async () => {
    const routes = BASE_ROUTES();
    routes['GET /api/config'] = { ...routes['GET /api/config'], customer: { ...routes['GET /api/config'].customer, warnings: ['accent: is in the purple range (250 to 330 degrees), which this app does not use; the default is used'] } };
    mockServer({ ...routes, 'GET /api/settings': view });
    go('#/settings');
    render(<App />);
    expect(await screen.findByText(/^customer\.config: accent: is in the purple range/)).toBeInTheDocument();
  });
});

describe('7. results are announced', () => {
  it('step states and proof points sit in polite live regions', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/piflow/open': { status: 'USERNAME_PASSWORD_REQUIRED', actions: ['checkUsernamePassword'], trace: [] } });
    go('#/run/piflow');
    const { container } = render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    await screen.findByText(/No credential was sent/);
    expect(container.querySelector('ol.steps')).toHaveAttribute('aria-live', 'polite');
    expect(container.querySelector('.proof ul.points')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('8. typed secrets never sit in a value attribute and are cleared after use', () => {
  it('the sign-in password is uncontrolled and emptied on submit', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] }, 'POST /api/cards/pkce/credentials': { state: 'done', outcome: 'accepted', trace: [] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const pass = await screen.findByLabelText('Password');
    await userEvent.type(screen.getByLabelText('Username'), 'alice');
    await userEvent.type(pass, 'hunter2-secret');
    expect(pass.getAttribute('value') || '').not.toContain('hunter2');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Sign in' })).getByRole('button', { name: 'Sign in' }));
    await screen.findByText(/Done: PingFederate issued the tokens/);
    expect(server.calls.find((c) => c.path === '/api/cards/pkce/credentials').body.password).toBe('hunter2-secret');
  });

  it('a Settings secret is uncontrolled, sent once, and emptied after Save', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'PUT /api/settings': view });
    go('#/settings');
    render(<App />);
    const secret = await screen.findByLabelText(/^Client secret/);
    await userEvent.type(secret, 'brand-new-secret');
    expect(secret.getAttribute('value') || '').toBe('');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(server.calls.find((c) => c.method === 'PUT').body).toEqual({ ciba: { clientSecret: 'brand-new-secret' } });
    expect(screen.getByLabelText(/^Client secret/)).toHaveValue('');
  });
});

describe('12. colours come from the shared stylesheet\'s tokens (CSS standard)', () => {
  const css = fs.readFileSync(path.join(here, 'app.css'), 'utf8');
  it('the lab\'s stylesheet has no colour literal, no dark-mode block, no !important and no italics', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi)).toBeNull();
    expect(css).not.toMatch(/prefers-color-scheme|!important|font-style:\s*italic/);
  });
  it('breakpoints are 600px and 900px only', () => {
    const widths = [...css.matchAll(/@media[^{]*?(\d+)px/g)].map((m) => m[1]);
    expect(widths.length).toBeGreaterThan(0);
    expect(widths.every((w) => w === '600' || w === '900')).toBe(true);
  });
  it('the shared stylesheet loads first, then the lab\'s', () => {
    const main = fs.readFileSync(path.join(here, 'main.jsx'), 'utf8');
    expect(main.indexOf("import './standalone-ui.css'")).toBeGreaterThan(-1);
    expect(main.indexOf("import './standalone-ui.css'")).toBeLessThan(main.indexOf("import './app.css'"));
  });
});

describe('13. the window title names the view', () => {
  it('per view', async () => {
    expect(viewTitle({ view: 'settings' }, CARDS, 'Lab')).toBe('Settings - Lab');
    expect(viewTitle({ view: 'run', card: 'dcr' }, CARDS, 'Lab')).toBe('Dynamic client registration (RFC 7591/7592) - Lab');
    expect(viewTitle({ view: 'playground' }, CARDS, 'Lab')).toBe('Protocol Playground - Lab');
    expect(viewTitle({ view: 'shelf' }, CARDS)).toBe('Shelf - PingFederate LAB');
    mockServer(BASE_ROUTES());
    go('#/run/dcr');
    render(<App />);
    await screen.findByRole('heading', { name: 'Dynamic client registration (RFC 7591/7592)' });
    expect(document.title).toBe('Dynamic client registration (RFC 7591/7592) - PingFederate LAB');
  });
});

describe('14. mock mode is labelled where it shows', () => {
  it('a mock-issued token and a mock trace step say mock', async () => {
    const { TokenView, TraceList } = await import('./Proof.jsx');
    render(<><TokenView label="Access token" token={{ masked: 'eyJhbG...abcd', length: 300, kind: 'JWT', mock: true, claims: { sub: 'alice' } }} />
      <TraceList trace={[{ id: 'token', title: 'Redeem the code', mock: true, request: { method: 'POST', url: 'https://pingfederate.mock.invalid/as/token.oauth2' }, response: { status: 200 } }]} /></>);
    expect(screen.getAllByText('mock')).toHaveLength(2);
  });
  it('the sign-in dialog names the mock demo user on a mock run', async () => {
    const Credentials = (await import('./views/Credentials.jsx')).default;
    mockServer({ 'GET /api/mode': { mode: 'mock', mockSignIn: { allowed: true, refusal: null, username: 'alice', password: 'demo-only' } } });
    render(<Credentials onSubmit={() => {}} mock />);
    expect(await screen.findByTestId('mock-user')).toHaveTextContent('Mock PingFederate: sign in as alice with password demo-only. This user exists only in the mock.');
  });
});
