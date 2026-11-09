// Opened from Customer Agent LAB: the strip sits right below the simulation banner, a compact Back button sits in the header, and
// the mapped card and vertical are preselected (handoffMap.js).
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import App from './App.jsx';
import { mockServer, BASE_ROUTES, CARDS } from './testApi.js';
import { UC_CARD, VERTICALS, cardFor, verticalFor } from './handoffMap.js';
import { VERTICALS as SERVER_VERTICALS } from '../../server/src/customer.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const at = (url) => window.history.replaceState(null, '', url);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); at('/'); });

describe('hand-off from Customer Agent LAB', () => {
  it('every mapped use case names a real card, the verticals are the server ones, odd ids map to nothing', () => {
    for (const card of Object.values(UC_CARD)) expect(CARDS.find((c) => c.id === card)?.kind).toBe('flow');
    const serverCards = fs.readFileSync(path.join(here, '..', '..', 'server', 'src', 'cards.js'), 'utf8');
    for (const card of Object.values(UC_CARD)) expect(serverCards).toContain(`id: '${card}'`);
    expect([...VERTICALS]).toEqual(SERVER_VERTICALS);
    expect(cardFor({ uc: 'UC-LEARN12' })).toBeNull();
    expect(cardFor({ uc: 'toString' })).toBeNull();
    expect(verticalFor({ vertical: 'constructor' })).toBeNull();
  });

  it('UC-LEARN13 in retail: banner then strip, header Back, the RAR card and the retail vertical are preselected', async () => {
    const server = mockServer(BASE_ROUTES());
    at('/?from=customer-agent&uc=UC-LEARN13&vertical=retail');
    render(<App />);
    const strip = screen.getByRole('note', { name: 'Opened from Customer Agent LAB' });
    expect(strip).toHaveTextContent('UC-LEARN13');
    expect(screen.getByTestId('banner').nextElementSibling).toBe(strip);
    expect(document.querySelector('header.top .prefs > button.return-link--header')).not.toBeNull();
    expect(window.location.hash).toBe('#/run/rar');
    expect(window.location.search).toBe('?from=customer-agent&uc=UC-LEARN13&vertical=retail');
    await waitFor(() => expect(document.title).toMatch(/^RAR via PAR/));
    await waitFor(() => expect(server.calls.some((c) => c.path === '/api/stories/retail')).toBe(true));
  });

  // The page's own path decides where Back goes: served at / it is the app's own port (direct URL), under /pingfederate-lab/ the lab proxy.
  for (const [pathname, href] of [['/', 'http://127.0.0.1:5603/?returned=pingfederate&uc=UC-LEARN12'], ['/pingfederate-lab/', '/customer-agent/?returned=pingfederate&uc=UC-LEARN12']]) {
    it(`served at ${pathname}: Back goes to ${href}; UC-LEARN12 opens the shelf (strip only)`, async () => {
      mockServer(BASE_ROUTES());
      const assign = vi.fn();
      vi.stubGlobal('location', { ...window.location, pathname, hash: '', search: '?from=customer-agent&uc=UC-LEARN12', assign });
      render(<App />);
      for (const b of screen.getAllByRole('button', { name: /Back to Customer Agent LAB/ })) fireEvent.click(b);
      expect(assign.mock.calls).toEqual([[href], [href]]);
      await waitFor(() => expect(document.title).toMatch(/^Shelf/));
    });
  }

  it('a hash already in the address bar wins over the mapped card', async () => {
    mockServer(BASE_ROUTES());
    at('/?from=customer-agent&uc=UC-LOGIN-PF#/settings');
    render(<App />);
    expect(window.location.hash).toBe('#/settings');
    await waitFor(() => expect(document.title).toMatch(/^Settings/));
  });

  it('no from, an unknown from or a bad id: no strip, no button, no preselect', async () => {
    for (const q of ['/', '/?from=elsewhere&uc=UC-LEARN13', '/?from=customer-agent&uc=a%20b', '/?from=customer-agent&uc=UC-LEARN13&vertical=%3Cb%3E']) {
      mockServer(BASE_ROUTES());
      at(q);
      render(<App />);
      expect(screen.queryByRole('note', { name: /Opened from/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Back to/ })).toBeNull();
      expect(window.location.hash).toBe('');
      cleanup();
    }
  });

  it('the vendored files match return-link.sha256, which names the parent commit', () => {
    const dir = path.join(here, 'return-link');
    const text = fs.readFileSync(path.join(dir, 'return-link.sha256'), 'utf8');
    expect(text.split('\n')[0]).toMatch(/^# vendored byte for byte from curtismu7\/AI-DEMO-Standalone shared\/return-link at [0-9a-f]{7,40}/);
    const pins = text.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/));
    expect(pins.map(([, f]) => f).sort()).toEqual(['ReturnLink.jsx', 'ReturnLink.test.jsx', 'returnTargets.js']);
    for (const [h, f] of pins) expect(createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'), f).toBe(h);
  });
});
