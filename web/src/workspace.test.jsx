import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';
import WorkspaceSwitch from './views/WorkspaceSwitch.jsx';
import { currentWorkspace, chooseWorkspace } from './api.js';
import { mockServer, BASE_ROUTES } from './testApi.js';

// This test environment has no usable localStorage, so give the page a small in-memory one.
const store = new Map();
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
  getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k), clear: () => store.clear(),
} });
beforeEach(() => { window.location.hash = '#/'; store.clear(); });
afterEach(() => { vi.unstubAllGlobals(); store.clear(); });

describe('workspace (rule 13)', () => {
  it('the header names the current workspace and every call carries it', async () => {
    chooseWorkspace('demo-2');
    const routes = BASE_ROUTES();
    const server = mockServer({
      ...routes,
      'GET /api/config': () => ({ body: { ...routes['GET /api/config'], workspace: 'demo-2' } }),
      'GET /api/workspaces': { current: 'demo-2', default: 'default', workspaces: ['default', 'demo-2'] },
    });
    render(<App />);
    const field = await screen.findByLabelText(/Workspace/);
    await waitFor(() => expect(field).toHaveValue('demo-2'));
    const sent = server.impl.mock.calls.map(([, init]) => init.headers['x-lab-workspace']);
    expect(sent.length).toBeGreaterThan(2);
    expect(new Set(sent)).toEqual(new Set(['demo-2']));
  });

  it('defaults to "default", and a stored value that is not a valid id is ignored', () => {
    expect(currentWorkspace()).toBe('default');
    window.localStorage.setItem('pflab-workspace', '../x');
    expect(currentWorkspace()).toBe('default');
    chooseWorkspace('two');
    expect(currentWorkspace()).toBe('two');
    chooseWorkspace('default');
    expect(window.localStorage.getItem('pflab-workspace')).toBeNull();
  });

  it('Enter switches to a valid id; an invalid one is put back and nothing switches', async () => {
    const onChoose = vi.fn();
    render(<WorkspaceSwitch current="default" known={['default']} onChoose={onChoose} />);
    const field = screen.getByLabelText(/Workspace/);
    await userEvent.clear(field);
    await userEvent.type(field, 'Team-A{Enter}'); // upper case is lowered as it is typed
    expect(onChoose).toHaveBeenCalledWith('team-a');
    onChoose.mockClear();
    await userEvent.clear(field);
    await userEvent.type(field, '-bad{Enter}');
    expect(onChoose).not.toHaveBeenCalled();
    expect(field).toHaveValue('default');
  });
});
