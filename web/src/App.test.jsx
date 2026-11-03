import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { bannerText, parseRoute } from './App.jsx';
import { mockServer, BASE_ROUTES, CARDS, hop } from './testApi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const go = (hash) => { window.location.hash = hash; };

beforeEach(() => { go('#/'); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('banner (rule 2)', () => {
  it('says live with the issuer, not connected, or mock', () => {
    expect(bannerText('https://pf.example')).toBe('Live: every call goes to your PingFederate at https://pf.example. Nothing here is simulated.');
    expect(bannerText(null)).toBe('Not connected: set your PingFederate in Settings.');
    expect(bannerText('https://pingfederate.mock.invalid', 'mock')).toBe('Mock: a simulated PingFederate inside this lab. Nothing leaves this machine.');
  });
  it('the Mock/Live toggle is in the header on every view and switches the whole lab', async () => {
    let mode = 'mock';
    const routes = BASE_ROUTES('https://pingfederate.mock.invalid');
    const server = mockServer({
      ...routes,
      'GET /api/config': () => ({ body: { ...routes['GET /api/config'], mode, issuer: mode === 'mock' ? 'https://pingfederate.mock.invalid' : 'https://pf.example' } }),
      'GET /api/info': () => ({ body: { source: mode === 'mock' ? 'mock' : 'real', realAvailable: true, realReason: null, mode } }),
      'PUT /api/mode': (body) => { mode = body.mode === 'real' ? 'live' : 'mock'; return { body: { mode, source: body.mode } }; },
    });
    render(<App />);
    expect(await screen.findByTestId('banner')).toHaveTextContent('MOCKMock: a simulated PingFederate inside this lab. Nothing leaves this machine.');
    const toggle = screen.getByRole('group', { name: 'Mock or live PingFederate' });
    expect(within(toggle).getByRole('button', { name: 'Mock' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(toggle).getByRole('button', { name: 'Real' }));
    await waitFor(() => expect(screen.getByTestId('banner')).toHaveTextContent('Live: every call goes to your PingFederate at https://pf.example.'));
    expect(server.calls.find((c) => c.method === 'PUT' && c.path === '/api/mode').body).toEqual({ mode: 'real' });
    expect(within(toggle).getByRole('button', { name: 'Real' })).toHaveAttribute('aria-pressed', 'true');
    await act(async () => { go('#/settings'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByRole('group', { name: 'Mock or live PingFederate' })).toBeInTheDocument();
  });
  it('is on every view, presenter mode included', async () => {
    mockServer(BASE_ROUTES(null));
    render(<App />);
    expect(await screen.findByTestId('banner')).toHaveTextContent('Not connected: set your PingFederate in Settings.');
    await userEvent.click(screen.getByRole('button', { name: 'Presenter' }));
    expect(screen.getByTestId('banner')).toBeInTheDocument();
    await act(async () => { go('#/playground'); window.dispatchEvent(new HashChangeEvent('hashchange')); });
    expect(screen.getByTestId('banner')).toBeInTheDocument();
  });
});

describe('routes', () => {
  it('parses the hash routes and refuses odd focus values', () => {
    expect(parseRoute('#/run/dcr')).toEqual({ view: 'run', card: 'dcr' });
    expect(parseRoute('#/settings/pf.issuer')).toEqual({ view: 'settings', focus: 'pf.issuer' });
    expect(parseRoute('#/settings/<img>')).toEqual({ view: 'settings', focus: null });
    expect(parseRoute('#/elsewhere')).toEqual({ view: 'shelf' });
  });
});

describe('shelf', () => {
  it('shows the cards in the owner\'s order, with readiness, stories and link cards', async () => {
    mockServer(BASE_ROUTES());
    render(<App />);
    await screen.findByText('Ledger registers itself.');
    const titles = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(['Sign in (pi.flow)', 'Dynamic client registration (RFC 7591/7592)', 'RAR via PAR (banking_transaction)', 'CIBA (start and poll)',
      'DPoP sign-in', 'Token exchange, two hops (RFC 8693)', 'Authentication API: open and read a pi.flow', 'PAR', 'PKCE', 'PingFederate Protocol Playground',
      'Client ID metadata documents', 'ID-JAG']);
    expect(screen.getByRole('link', { name: 'ciba.clientSecret' })).toHaveAttribute('href', '#/settings/ciba.clientSecret');
    expect(screen.getByRole('link', { name: 'Open cimd-lab' })).toHaveAttribute('href', 'http://127.0.0.1:5250');
    expect(screen.getByRole('link', { name: 'Set its address in Settings' })).toHaveAttribute('href', '#/settings/links.idJagUrl');
    expect(screen.getAllByText(/This lives in a sibling app/)).toHaveLength(2);
    await userEvent.click(screen.getByLabelText('Retail'));
    expect(await screen.findByText('Scout registers itself.')).toBeInTheDocument();
  });

  it('shows who is signed in from /api/me, and signs out', async () => {
    let signedIn = true;
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/me': () => ({ body: signedIn ? { signedIn: true, user: { subject: 'alice' } } : { signedIn: false } }), 'POST /api/signout': () => { signedIn = false; return { body: { signedIn: false } }; } });
    render(<App />);
    expect(await screen.findByTestId('who')).toHaveTextContent('alice');
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/api/signout')).toBe(true);
  });

  it('the header Sign in opens the sign-in card and starts its flow, without pressing Run', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/signin/start': { state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(window.location.hash).toBe('#/run/signin');
    expect(await screen.findByRole('form', { name: 'Sign-in form' })).toBeInTheDocument();
    expect(server.calls.filter((c) => c.path === '/api/signin/start')).toHaveLength(1);
  });

  it('opening the sign-in card any other way waits for Run', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/signin/start': { state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/signin');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Run' })).toBeEnabled();
    expect(server.calls.some((c) => c.path === '/api/signin/start')).toBe(false);
  });
});

describe('settings', () => {
  const view = {
    settings: { pf: { issuer: 'https://pf.example', redirectUri: 'http://127.0.0.1:5400/callback' }, ciba: { clientId: 'c1', clientSecret: { set: true }, scope: 'openid' }, dcr: { iatClientId: '', iatClientSecret: { set: false }, clientScope: 'openid', forbiddenScope: 'admin:write' } },
    ready: { discovery: true },
  };

  it('never prefills a secret, says set or not set, and saves only what changed', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'PUT /api/settings': view });
    go('#/settings');
    render(<App />);
    const secret = await screen.findByLabelText(/^Client secret/);
    expect(secret).toHaveAttribute('type', 'password');
    expect(secret).toHaveValue('');
    expect(screen.getByText('set')).toBeInTheDocument();
    expect(screen.getByText('not set')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Scopes'));
    await userEvent.type(screen.getByLabelText('Scopes'), 'openid profile');
    await userEvent.type(screen.getByLabelText(/^Registering client secret/), 'new-secret-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    const put = server.calls.find((c) => c.method === 'PUT');
    expect(put.body).toEqual({ ciba: { scope: 'openid profile' }, dcr: { iatClientSecret: 'new-secret-1' } });
  });

  it('clears a secret only when asked, and shows the server\'s field error', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'PUT /api/settings': (body) => (body.pf ? { status: 400, body: { error: 'invalid_setting', field: 'pf.issuer', message: 'pf.issuer must be https' } } : { body: view }) });
    go('#/settings');
    render(<App />);
    await userEvent.click(await screen.findByLabelText('Clear it'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    expect(server.calls.find((c) => c.method === 'PUT').body).toEqual({ ciba: { clientSecret: null } });
    await userEvent.clear(screen.getByLabelText('Issuer (https)'));
    await userEvent.type(screen.getByLabelText('Issuer (https)'), 'http://pf.example');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('invalid_setting (pf.issuer): pf.issuer must be https')).toBeInTheDocument();
  });

  it('Check PingFederate shows the endpoints found, or the error code and detail', async () => {
    let fail = false;
    mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'POST /api/pf/discovery': () => (fail
      ? { status: 502, body: { error: 'discovery_issuer_mismatch', message: 'The discovery issuer does not match the configured issuer' } }
      : { body: { issuer: 'https://pf.example', endpoints: { token: 'https://pf.example/as/token.oauth2', par: null }, features: [{ id: 'par', label: 'Pushed authorization requests', supported: false }], trace: [] } }) });
    go('#/settings');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check PingFederate' }));
    expect(await screen.findByText('Found at https://pf.example')).toBeInTheDocument();
    expect(screen.getByText('https://pf.example/as/token.oauth2')).toBeInTheDocument();
    expect(screen.getByText('not advertised')).toBeInTheDocument();
    fail = true;
    await userEvent.click(screen.getByRole('button', { name: 'Check PingFederate' }));
    expect(await screen.findByText('discovery_issuer_mismatch')).toBeInTheDocument();
  });

  it('Check PingFederate takes the person to its answer, which renders below every setting', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    mockServer({ ...BASE_ROUTES(), 'GET /api/settings': view, 'POST /api/pf/discovery': { issuer: 'https://pf.example', endpoints: {}, features: [], trace: [] } });
    go('#/settings');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Check PingFederate' }));
    const result = await screen.findByRole('region', { name: 'PingFederate check' });
    await waitFor(() => expect(result).toHaveFocus());
    expect(scrolled.mock.contexts).toContain(result);
    delete Element.prototype.scrollIntoView;
  });
});

describe('card run', () => {
  it('DCR runs its four steps in order and shows proof points, the live sequence and the raw trace', async () => {
    const trace = [hop('initial-access-token', 'Get an initial access token', 'POST', 'https://pf.example/as/token.oauth2', 200)];
    const t2 = [...trace, hop('register-anonymous', 'Register with no initial access token', 'POST', 'https://pf.example/as/clients.oauth2', 401, { error: 'invalid_token' }), hop('register', 'Register with the initial access token', 'POST', 'https://pf.example/as/clients.oauth2', 201)];
    const server = mockServer({ ...BASE_ROUTES(),
      'POST /api/cards/dcr/initial-token': { trace },
      'POST /api/cards/dcr/register': { anonymousRefused: true, trace: t2 },
      'POST /api/cards/dcr/use': { forbiddenRefused: true, trace: t2 },
      'POST /api/cards/dcr/delete': { gone: true, trace: t2 } });
    go('#/run/dcr');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const line = await screen.findByText('PingFederate refused the registration with no initial access token, as it should: 401 invalid_token');
    expect(line.closest('li')).toHaveClass('pt-expected');
    expect(within(line.closest('li')).getByText('refused as expected')).toBeInTheDocument();
    expect(screen.getByText(/"Refused as expected" lines are passes/)).toBeInTheDocument();
    expect(screen.getByText('401 as expected')).toHaveClass('s-ok');
    await screen.findByText(/nor get a token: it is gone/);
    expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/cards/dcr/initial-token', '/api/cards/dcr/register', '/api/cards/dcr/use', '/api/cards/dcr/delete']);
    expect(screen.getByRole('region', { name: 'This run, call by call' })).toBeInTheDocument();
    expect(screen.getByText('Register with no initial access token', { selector: '.trace-title' })).toBeInTheDocument();
  });

  it('stops at an error and shows the server code and detail', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/dcr/initial-token': { status: 409, body: { error: 'client_pending', message: 'A registered client is still on PingFederate' } } });
    go('#/run/dcr');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    expect((await screen.findAllByText('client_pending')).length).toBeGreaterThan(0);
    expect(screen.getByText('The lab stopped: client_pending: A registered client is still on PingFederate')).toBeInTheDocument();
  });

  it('a code-flow card asks for credentials in the lab\'s own form, posts them to the lab, and clears the password', async () => {
    let tries = 0;
    const server = mockServer({ ...BASE_ROUTES(),
      'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] },
      'POST /api/cards/pkce/credentials': () => ((tries += 1) === 1
        ? { status: 200, body: { state: 'credentials_required', refused: 'credential_validation_failed', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } }
        : { status: 200, body: { state: 'done', outcome: 'accepted', identity: { subject: 'alice' }, accessToken: { masked: 'eyJhbG...abcd', length: 300, kind: 'JWT', header: { alg: 'ES256' }, claims: { sub: 'alice' } }, trace: [] } }) });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('form', { name: 'Sign-in form' });
    await userEvent.type(within(form).getByLabelText('Username'), 'alice');
    await userEvent.type(within(form).getByLabelText('Password'), 'wrong');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Sign in' })).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/PingFederate refused the username or password. Try again./)).toBeInTheDocument();
    expect(within(form).getByLabelText('Password')).toHaveValue('');
    await userEvent.type(within(form).getByLabelText('Password'), 'right');
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Sign in' })).getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Done: PingFederate issued tokens; the verified ID token names alice.')).toBeInTheDocument();
    expect(screen.getByText('eyJhbG...abcd')).toBeInTheDocument();
    expect(server.calls.filter((c) => c.path === '/api/cards/pkce/credentials').map((c) => c.body)).toEqual([{ username: 'alice', password: 'wrong' }, { username: 'alice', password: 'right' }]);
  });

  it('the sign-in dialog: Sign in waits for both fields; Cancel and Escape close it; Sign in reopens it, the run still waiting', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    let dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    const submit = within(dialog).getByRole('button', { name: 'Sign in' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Username'), 'alice');
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText('Password'), 'x');
    expect(submit).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(within(document.querySelector('.creds-reopen')).getByRole('button', { name: 'Sign in' }));
    dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(within(dialog).getByLabelText('Username')).toHaveValue('alice');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the sign-in dialog does not block the page: Expand all opens every step behind it, Collapse all closes them', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED',
      trace: [hop('discovery', 'Discovery', 'GET', 'https://pf.example/.well-known/openid-configuration', 200), hop('authorize', 'Open', 'GET', 'https://pf.example/as/authorization.oauth2', 200)] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in' });
    expect(dialog).not.toHaveAttribute('aria-modal');
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    const rows = [...document.querySelectorAll('.proof .trace-list > li > details')];
    expect(rows.length).toBe(2);
    expect(rows.every((d) => d.open)).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(rows.some((d) => d.open)).toBe(false);
    expect(screen.getByRole('dialog', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('a typed user goes to PingFederate as login_hint and the sign-in form starts with it', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', loginHint: 'alice', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.type(await screen.findByLabelText('User (login_hint)'), 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('form', { name: 'Sign-in form' });
    expect(within(form).getByLabelText('Username')).toHaveValue('alice');
    expect(server.calls.find((c) => c.path === '/api/cards/pkce/start').body).toEqual({ loginHint: 'alice' });
  });

  it('the password takes a paste, and Show/Hide switches it to plain text and back without losing it (macOS Secure Input)', async () => {
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/pkce/start': { card: 'pkce', state: 'credentials_required', status: 'USERNAME_PASSWORD_REQUIRED', trace: [] } });
    go('#/run/pkce');
    render(<App />);
    await userEvent.click(await screen.findByRole('button', { name: 'Run' }));
    const form = await screen.findByRole('form', { name: 'Sign-in form' });
    const pass = within(form).getByLabelText('Password');
    pass.focus();
    await userEvent.paste('pasted-secret');
    expect(pass).toHaveValue('pasted-secret');
    expect(pass).toHaveAttribute('type', 'password');
    await userEvent.click(within(form).getByRole('button', { name: 'Show' }));
    expect(pass).toHaveAttribute('type', 'text');
    expect(pass).toHaveValue('pasted-secret');
    expect(pass.getAttribute('value') || '').toBe('');
    await userEvent.click(within(form).getByRole('button', { name: 'Hide' }));
    expect(pass).toHaveAttribute('type', 'password');
  });

  it('CIBA names who will approve, and Run waits until there is someone (typed, or the signed-in user)', async () => {
    const ready = CARDS.map((c) => (c.id === 'ciba' ? { ...c, ready: true, missing: [] } : c));
    let signedIn = false;
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: ready },
      'GET /api/me': () => ({ body: signedIn ? { signedIn: true, user: { subject: 'alice' } } : { signedIn: false } }),
      'POST /api/cards/ciba/start': { state: 'pending', trace: [] }, 'POST /api/cards/ciba/poll': { state: 'approved', trace: [] } });
    go('#/run/ciba');
    const { unmount } = render(<App />);
    const run = await screen.findByRole('button', { name: 'Run' });
    expect(run).toBeDisabled();
    expect(screen.getByText(/Type the user who should approve, or/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('User (login_hint)'), 'bob');
    expect(screen.getByText('bob', { selector: 'strong' })).toBeInTheDocument();
    expect(run).toBeEnabled();
    unmount();
    signedIn = true;
    render(<App />);
    expect(await screen.findByText('alice', { selector: '#ciba-who strong' })).toBeInTheDocument();
    expect(screen.getByLabelText('User (login_hint)')).toHaveAttribute('placeholder', 'alice');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(server.calls.some((c) => c.path === '/api/cards/ciba/start')).toBe(true));
  });

  it('CIBA shows Approve and Deny once PingFederate asks this lab, and the poll then finishes', async () => {
    const ready = CARDS.map((c) => (c.id === 'ciba' ? { ...c, ready: true, missing: [] } : c));
    let decided = false;
    const pending = { state: 'pending', loginHint: 'bob', bindingMessage: 'PAY-42', interval: 1, approval: 'lab', trace: [] };
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: ready },
      'POST /api/cards/ciba/start': pending,
      'POST /api/cards/ciba/poll': () => ({ body: decided ? { state: 'approved', identity: { subject: 'bob' }, trace: [] } : pending }),
      'POST /api/cards/ciba/decision': () => { decided = true; return { body: pending }; } });
    go('#/run/ciba');
    render(<App />);
    await userEvent.type(await screen.findByLabelText('User (login_hint)'), 'bob');
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    const panel = await screen.findByRole('region', { name: 'Approve on this page' });
    expect(within(panel).getByText('PingFederate asks bob to approve')).toBeInTheDocument();
    expect(within(panel).getByText('PAY-42')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve' }));
    expect(server.calls.find((c) => c.path === '/api/cards/ciba/decision').body).toEqual({ decision: 'approve' });
    expect(await screen.findByText(/The approval request ended: approved/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Approve on this page' })).not.toBeInTheDocument();
  });

  it('RAR runs with nothing typed when the server supplies the defaults (mock mode)', async () => {
    const cards = CARDS.map((c) => (c.id === 'rar' ? { ...c, defaults: { user: 'alice', sourceAccount: 'checking-001', destinationAccount: 'savings-002' } } : c));
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards }, 'POST /api/cards/rar/start': { status: 400, body: { error: 'stop_here' } } });
    go('#/run/rar');
    render(<App />);
    expect(await screen.findByLabelText('From account')).toHaveAttribute('placeholder', 'checking-001');
    expect(screen.getByLabelText('User (user_id)')).toHaveAttribute('placeholder', 'alice');
    const run = screen.getByRole('button', { name: 'Run' });
    expect(run).toBeEnabled();
    await userEvent.click(run);
    await waitFor(() => expect(server.calls.some((c) => c.path === '/api/cards/rar/start')).toBe(true));
  });

  it('RAR stays disabled in live mode until a user and the accounts are known', async () => {
    mockServer(BASE_ROUTES());
    go('#/run/rar');
    render(<App />);
    expect(await screen.findByRole('button', { name: 'Run' })).toBeDisabled();
  });

  it('RAR offers "Bind to DPoP" only when that client is set up', async () => {
    mockServer(BASE_ROUTES());
    go('#/run/rar');
    render(<App />);
    expect(await screen.findByLabelText(/Bind to DPoP/)).toBeDisabled();
  });
});

describe('playground', () => {
  it('CIBA in the Playground shows Approve and Deny when PingFederate asks this lab, and Run all then finishes', async () => {
    const ready = CARDS.map((c) => (c.id === 'ciba' ? { ...c, ready: true, missing: [] } : c));
    let decided = false;
    const pending = { state: 'pending', loginHint: 'bob', bindingMessage: 'PAY-42', interval: 1, approval: 'lab', expiresAt: 'later', trace: [] };
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: ready },
      'POST /api/cards/ciba/start': pending,
      'POST /api/cards/ciba/poll': () => ({ body: decided ? { state: 'approved', identity: { subject: 'bob' }, trace: [] } : pending }),
      'POST /api/cards/ciba/decision': () => { decided = true; return { body: pending }; } });
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    await userEvent.click(within(nav).getByRole('button', { name: /CIBA/ }));
    await userEvent.type(screen.getByLabelText('User (login_hint)'), 'bob');
    await userEvent.click(screen.getByRole('button', { name: 'Run all' }));
    const panel = await screen.findByRole('region', { name: 'Approve on this page' });
    expect(within(panel).getByText('PingFederate asks bob to approve')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve' }));
    expect(server.calls.find((c) => c.path === '/api/cards/ciba/decision').body).toEqual({ decision: 'approve' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Approve on this page' })).not.toBeInTheDocument(), { timeout: 4000 });
    expect(screen.getByRole('button', { name: 'Run all' })).toBeEnabled();
  });

  it('CIBA takes a typed user when nobody is signed in and sends it as login_hint', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'GET /api/cards': { cards: CARDS.map((c) => (c.id === 'ciba' ? { ...c, ready: true, missing: [] } : c)) }, 'POST /api/cards/ciba/start': { status: 400, body: { error: 'stop_here' } } });
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    await userEvent.click(within(nav).getByRole('button', { name: /CIBA/ }));
    const runAll = screen.getByRole('button', { name: 'Run all' });
    expect(runAll).toBeDisabled();
    await userEvent.type(screen.getByLabelText('User (login_hint)'), 'bob');
    expect(runAll).toBeEnabled();
    await userEvent.click(runAll);
    await waitFor(() => expect(server.calls.find((c) => c.path === '/api/cards/ciba/start')?.body?.loginHint).toBe('bob'));
  });

  it('lists every flow and executes exactly one step at a time', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/cards/dcr/initial-token': { trace: [hop('initial-access-token', 'IAT', 'POST', 'https://pf.example/as/token.oauth2', 200)] } });
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    expect(within(nav).getAllByRole('button')).toHaveLength(11);
    await userEvent.click(within(nav).getByRole('button', { name: /Dynamic client registration/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Execute step 1: Get an initial access token (dcr:register)' }));
    expect(await screen.findByText('PingFederate accepted the initial access token request: 200')).toBeInTheDocument();
    expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/cards/dcr/initial-token']);
    expect(screen.getByRole('region', { name: 'Step 1 raw' })).toBeInTheDocument();
  });
});

describe('playground explainer, Token tab and ID-JAG note', () => {
  const jwt = (claims) => ({ masked: 'eyJhbG...abcd', length: 120, kind: 'JWT', header: { alg: 'ES256' }, claims });

  it('every flow shows the explainer, a spec link, what it solves and why it matters for AI agents', async () => {
    mockServer(BASE_ROUTES());
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons).toHaveLength(11);
    for (const b of buttons) {
      await userEvent.click(b);
      const about = screen.getByRole('region', { name: /^About / });
      for (const label of ['Specification', 'What it solves', 'Why it matters for AI agents']) expect(within(about).getByText(label)).toBeInTheDocument();
      const link = within(about).getByRole('link');
      expect(link.getAttribute('href')).toMatch(/^https:\/\/(www\.rfc-editor\.org|openid\.net)\//);
      expect(about.querySelector('p.explain').textContent.length).toBeGreaterThan(60);
    }
  });

  it('says ID-JAG lives in id-jag-standalone-LAB', async () => {
    mockServer(BASE_ROUTES());
    go('#/playground');
    render(<App />);
    const link = await screen.findByRole('link', { name: 'id-jag-standalone-LAB' });
    expect(link).toHaveAttribute('href', 'https://github.com/ping-sandbox/id-jag-standalone-LAB');
  });

  it('the Token tab shows scopes, aud, sub and exp of the newest token a step returned, and the full token view', async () => {
    mockServer({ ...BASE_ROUTES(),
      'POST /api/cards/token-exchange/agent': { token: jwt({ sub: 'alice', aud: ['agent.example', 'mcp.example'], scope: 'agent:invoke openid', exp: 1893456000, act: { sub: 'agent' } }), trace: [hop('agent-exchange', 'Exchange 1', 'POST', 'https://pf.example/as/token.oauth2', 200)] },
      'POST /api/cards/token-exchange/mcp': { token: { ...jwt({ sub: 'alice', aud: 'mcp.example', scope: 'mcp:invoke', exp: 1893456000 }), raw: true, value: 'fake.mock.token', mock: true }, trace: [hop('mcp-exchange', 'Exchange 2', 'POST', 'https://pf.example/as/token.oauth2', 200)] } });
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    await userEvent.click(within(nav).getByRole('button', { name: /Token exchange/ }));
    expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('tab', { name: 'Token' }));
    const panel = screen.getByRole('tabpanel', { name: 'Token' });
    expect(within(panel).getByText(/No token yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await userEvent.click(screen.getByRole('button', { name: 'Execute step 1: Exchange 1: user token + agent actor' }));
    await userEvent.click(await screen.findByRole('tab', { name: 'Token' }));
    expect(await within(panel).findByText(/From step 1: Exchange 1/)).toBeInTheDocument();
    expect(within(panel).getByText('agent:invoke openid')).toBeInTheDocument();
    expect(within(panel).getByText('agent.example, mcp.example')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    await userEvent.click(screen.getByRole('button', { name: 'Execute step 2: Exchange 2: agent token + tool-service actor' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Token' }));
    expect(await within(panel).findByText(/From step 2: Exchange 2/)).toBeInTheDocument();
    for (const text of ['mcp:invoke', 'mcp.example', 'alice', '2030-01-01T00:00:00.000Z']) expect(within(panel).getByText(text)).toBeInTheDocument();
    expect(within(panel).getByText(/fake\.mock\.token/)).toBeInTheDocument();
  });

  it('Clear on DCR asks the lab to discard a leftover mock client; other flows only clear the page', async () => {
    const server = mockServer({ ...BASE_ROUTES(), 'POST /api/cards/dcr/discard': { deleted: ['dcr-abc'] } });
    go('#/playground');
    render(<App />);
    const nav = await screen.findByRole('navigation', { name: 'Flows' });
    await userEvent.click(within(nav).getByRole('button', { name: /PKCE/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(server.calls.filter((c) => c.path === '/api/cards/dcr/discard')).toHaveLength(0);
    await userEvent.click(within(nav).getByRole('button', { name: /Dynamic client registration/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(server.calls.filter((c) => c.path === '/api/cards/dcr/discard')).toHaveLength(1));
  });
});

describe('no redirect, no other host', () => {
  it('no source file navigates the window or calls fetch with an absolute URL', () => {
    const files = [];
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.|testApi|testSetup/.test(e.name)) files.push(p); } };
    walk(here);
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      expect([f, /location\.(href|assign|replace)\s*[=(]|window\.open\(|location\s*=/.test(text)]).toEqual([f, false]);
      expect([f, /fetch\(\s*['"`]https?:/.test(text)]).toEqual([f, false]);
    }
  });
});

describe('pi.flow guide', () => {
  it('explains the idea, steps, statuses and when to use it, then the fields of the answer the run got back', async () => {
    const answer = { id: '<flow id>', status: 'USERNAME_PASSWORD_REQUIRED', _links: { checkUsernamePassword: { href: 'x' }, self: { href: 'x' } }, pluginTypeId: 'plugin-1', showCaptcha: false, extra: 1 };
    mockServer({ ...BASE_ROUTES(), 'POST /api/cards/piflow/open': { status: answer.status, actions: ['checkUsernamePassword'], trace: [hop('authorize', 'Open', 'GET', 'https://auth.example/as/authorize', 200, answer)] } });
    go('#/run/piflow');
    render(<App />);
    const guide = await screen.findByRole('region', { name: 'How pi.flow works' });
    for (const h of ['1. The idea', '2. The steps', '3. The answer you just got', '4. Statuses', '5. When to use it']) expect(within(guide).getByRole('heading', { name: h })).toBeInTheDocument();
    expect(within(guide).getByText(/Press Run/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(within(guide).queryByText(/Press Run/)).toBeNull());
    const statusRow = within(guide).getByRole('row', { name: /USERNAME_PASSWORD_REQUIRED/ });
    expect(within(statusRow).getByText('your answer')).toBeInTheDocument();
    expect(within(guide).getByText('plugin-1')).toBeInTheDocument();
    expect(within(guide).getAllByText('not in this answer').length).toBeGreaterThan(0);
    expect(within(guide).getByText(/Also in this answer: extra/)).toBeInTheDocument();
  });
});
