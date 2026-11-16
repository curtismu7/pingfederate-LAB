import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen, within } from '@testing-library/react';
import App from './App.jsx';
import { mockServer, BASE_ROUTES } from './testApi.js';

// The header shows this lab's own Verified / In progress mark, read from the same /api/shelf call the Shelf link makes (through the lab-proxy
// that call reaches the shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
const here = path.dirname(fileURLToPath(import.meta.url));
beforeEach(() => { window.location.hash = '#/'; });
afterEach(() => { vi.unstubAllGlobals(); });

const mark = (status, label, extra = {}) => ({ status, label, note: '', updatedAt: '2026-11-15', source: 'shipped', ...extra });
const withShelf = (payload) => mockServer({ ...BASE_ROUTES(null), 'GET /api/shelf': payload });

describe('verification mark in the header', () => {
  it("shows this lab's own mark beside the Shelf link, and no other lab's", async () => {
    const server = withShelf({ shelfUrl: 'http://shelf.example', demos: [
      { id: 'other-lab', verification: mark('in-progress', 'In progress') },
      { id: 'pingfederate-lab', verification: mark('verified', 'Verified', { note: 'Every card run on the mock' }) },
    ] });
    render(<App />);
    const bar = within(await screen.findByTestId('top-menu'));
    expect(await bar.findByText('Verified')).toBeInTheDocument();
    expect(bar.getByRole('link', { name: 'Shelf' })).toBeInTheDocument();
    expect(bar.queryByText('In progress')).toBeNull();
    expect(document.querySelectorAll('.verify')).toHaveLength(1);
    expect(bar.getByText('Verified').closest('.verify')).toHaveAttribute('title', expect.stringContaining('Every card run on the mock'));
    // like the Shelf link, the badge's request carries the workspace header
    expect(server.impl.mock.calls.filter(([p]) => p === '/api/shelf').every(([, init]) => init.headers['x-lab-workspace'])).toBe(true);
  });

  it('shows nothing when the lab is opened on its own port (its /api/shelf has no demos) or the shelf has no mark for it', async () => {
    for (const payload of [{ shelfUrl: 'http://shelf.example' }, { shelfUrl: 'http://shelf.example', demos: [{ id: 'pingfederate-lab', verification: null }] }]) {
      withShelf(payload);
      const { unmount } = render(<App />);
      const bar = within(await screen.findByTestId('top-menu'));
      expect(await bar.findByRole('link', { name: 'Shelf' })).toBeInTheDocument(); // the shelf answered, and still no badge
      expect(document.querySelector('.verify')).toBeNull();
      unmount();
    }
  });

  it('App.jsx renders the badge with the lab\'s shelf id (removing the line must fail this test)', () => {
    const src = fs.readFileSync(path.join(here, 'App.jsx'), 'utf8');
    expect(src).toMatch(/<VerifyMark id="pingfederate-lab"/);
    const entry = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'docs', 'shelf-entry.json'), 'utf8'));
    expect(entry.id).toBe('pingfederate-lab');
  });
});
