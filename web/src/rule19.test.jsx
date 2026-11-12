import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.jsx";
import { mockServer, BASE_ROUTES, CARDS } from "./testApi.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Rule 19 Mock/Real toggle", () => {
  it("an incomplete live configuration: Real is disabled with the server's reason and clicking it never PUTs", async () => {
    let switched = false;
    const routes = BASE_ROUTES('https://pingfederate.mock.invalid');
    const server = mockServer({
      ...routes,
      'GET /api/config': () => ({ body: { ...routes['GET /api/config'], mode: 'mock', issuer: 'https://pingfederate.mock.invalid' } }),
      'GET /api/info': () => ({ body: { source: 'mock', realAvailable: false, realReason: 'Real (live) is not available: the live settings are incomplete. Set the PingFederate issuer and every client id and secret on the Settings page.', mode: 'mock' } }),
      'PUT /api/mode': () => { switched = true; return { status: 409, body: { error: 'real_not_available', message: 'Real (live) is not available.' } }; },
    });
    render(<App />);
    const toggle = await screen.findByTestId('mode-select');
    const real = within(toggle).getByRole('option', { name: 'Real' });
    await waitFor(() => expect(real).toBeDisabled());
    await userEvent.selectOptions(toggle, 'real');
    expect(switched).toBe(false, 'a disabled Real option never reaches the server');
    expect(toggle).toHaveValue('mock');
  });

  it('after a switch the pressed button follows /api/info', async () => {
    let source = 'real';
    const routes = BASE_ROUTES('https://pingfederate.mock.invalid');
    mockServer({
      ...routes,
      'GET /api/config': () => ({ body: { ...routes['GET /api/config'], mode: source === 'real' ? 'live' : 'mock', issuer: 'https://pf.example' } }),
      'GET /api/info': () => ({ body: { source, realAvailable: true, realReason: null, mode: source === 'real' ? 'live' : 'mock' } }),
      'PUT /api/mode': (body) => { source = body.mode === 'real' ? 'real' : 'mock'; return { body: { mode: source === 'real' ? 'live' : 'mock', source } }; },
    });
    render(<App />);
    const toggle = await screen.findByTestId('mode-select');
    await waitFor(() => expect(toggle).toHaveValue('real'));
    await userEvent.selectOptions(toggle, 'mock');
    await waitFor(() => expect(toggle).toHaveValue('mock'));
  });
});
