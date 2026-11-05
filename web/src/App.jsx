import { useCallback, useEffect, useState } from 'react';
import { api, chooseWorkspace } from './api.js';
import Shelf from './views/Shelf.jsx';
import RunView from './views/RunView.jsx';
import Settings from './views/Settings.jsx';
import Playground from './views/Playground.jsx';
import WorkspaceSwitch from './views/WorkspaceSwitch.jsx';
import ShelfLink from "./components/ShelfLink.jsx";
import { currentWorkspace } from "./api.js";

// Hash routes: #/ (shelf), #/run/<card>, #/settings[/<section.field>], #/playground.
export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'run' && parts[1]) return { view: 'run', card: parts[1] };
  if (parts[0] === 'settings') return { view: 'settings', focus: parts[1] && /^[A-Za-z]+\.[A-Za-z]+$/.test(parts[1]) ? parts[1] : null };
  if (parts[0] === 'playground') return { view: 'playground' };
  return { view: 'shelf' };
}

// Rule 2: says on every view, presenter mode included, whether the lab is on the mock or on a real PingFederate.
export function bannerText(issuer, mode = 'live') {
  if (mode === 'mock') return 'Mock: a simulated PingFederate inside this lab. Nothing leaves this machine.';
  return issuer
    ? `Live: every call goes to your PingFederate at ${issuer}. Nothing here is simulated.`
    : 'Not connected: set your PingFederate in Settings.';
}

export function viewTitle(route, cards, name = 'PingFederate LAB') {
  const lab = name || 'PingFederate LAB';
  if (route.view === 'settings') return `Settings - ${lab}`;
  if (route.view === 'playground') return `Protocol Playground - ${lab}`;
  if (route.view === 'run') { const card = cards.find((c) => c.id === route.card); return `${card ? card.title : 'Unknown card'} - ${lab}`; }
  return `Shelf - ${lab}`;
}

const THEMES = ['auto', 'light', 'dark'];
const read = (key, fallback) => { try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { window.localStorage.setItem(key, value); } catch { /* storage may be blocked */ } };

export default function App() {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  const [config, setConfig] = useState(null);
  const [cards, setCards] = useState([]);
  const [me, setMe] = useState({ signedIn: false });
  const [verticals, setVerticals] = useState([]);
  const [vertical, setVertical] = useState(() => read('pflab-vertical', ''));
  const [story, setStory] = useState(null);
  const [theme, setTheme] = useState(() => (THEMES.includes(read('pflab-theme', 'auto')) ? read('pflab-theme', 'auto') : 'auto'));
  const [presenter, setPresenter] = useState(() => new URLSearchParams(window.location.search).get('present') === '1');
  const [loadError, setLoadError] = useState(null);
  // Set by the header's Sign in: the sign-in card starts its flow as soon as it shows, instead of waiting for Run.
  const [signInRequested, setSignInRequested] = useState(false);
  const signIn = () => { setSignInRequested(true); window.location.hash = '#/run/signin'; };

  const [workspaces, setWorkspaces] = useState([]);
  const refresh = useCallback(async () => {
    const [c, k, m, w] = await Promise.all([api.config(), api.cards(), api.me(), api.workspaces()]);
    setWorkspaces(w.ok ? w.data.workspaces : []);
    if (!c.ok || !k.ok) { setLoadError(c.data?.error || k.data?.error || 'the lab server did not answer'); return; }
    setLoadError(null);
    setConfig(c.data);
    setCards(k.data.cards);
    setMe(m.ok ? m.data : { signedIn: false });
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const onHash = () => { setRoute(parseRoute(window.location.hash)); window.scrollTo?.(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  useEffect(() => {
    api.stories().then((r) => { if (r.ok) { setVerticals(r.data.verticals); setVertical((v) => (r.data.verticals.some((x) => x.id === v) ? v : r.data.default)); } });
  }, []);
  useEffect(() => {
    if (!vertical) return;
    write('pflab-vertical', vertical);
    api.story(vertical).then((r) => setStory(r.ok ? r.data : null));
  }, [vertical]);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme);
    write('pflab-theme', theme);
  }, [theme]);
  // A customer.config accent (already checked for contrast with white text) replaces Ping Red in both themes.
  useEffect(() => {
    const accent = config?.customer?.accent;
    if (!accent) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-gradient', accent);
  }, [config]);
  // Mock or live for the whole lab; switching signs everyone out, so the page reloads its state.
  const [switching, setSwitching] = useState(false);
  // Rule 19: Real is disabled with the server's reason while the live settings are incomplete. The fields ride
  // /api/info (fetched once and after every switch), so the toggle always shows the server's answer.
  const [modeInfo, setModeInfo] = useState(null);
  useEffect(() => { api.info().then((r) => setModeInfo(r.ok ? r.data : null)).catch(() => setModeInfo(null)); }, []);
  const realAvailable = modeInfo ? modeInfo.realAvailable !== false : null; // null = not loaded yet
  const setMode = async (next) => {
    if (next === config?.mode || switching) return;
    if (next === 'live' && realAvailable === false) return; // Real is disabled with the reason; the button is too
    setSwitching(true);
    const r = await api.setMode(next);
    setSwitching(false);
    if (!r.ok) { setLoadError(r.data?.message || r.data?.error || 'could not switch modes'); return; }
    api.info().then((ir) => setModeInfo(ir.ok ? ir.data : null)).catch(() => {});
    await refresh();
  };
  useEffect(() => {
    if (!presenter) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setPresenter(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [presenter]);

  // The window title names the view, then the lab.
  useEffect(() => { document.title = viewTitle(route, cards, config?.customer?.name); }, [route, cards, config]);

  const signOut = async () => { await api.signOut(); await refresh(); };
  const skipToMain = (event) => { event.preventDefault(); document.getElementById('main')?.focus(); };
  const card = route.view === 'run' ? cards.find((c) => c.id === route.card && c.kind === 'flow') : null;
  const name = config?.customer?.name || 'PingFederate LAB';
  const mode = config?.mode || 'live';

  return (
    <div className={`app${presenter ? ' presenter' : ''}`}>
      {/* The skip link never changes the hash: the router reads the hash, so "#main" would leave the current view. */}
      <a className="skip" href="#main" onClick={skipToMain}>Skip to content</a>
      <div className="banner" data-mode={mode === 'mock' ? 'mock' : (config?.issuer ? 'live' : 'off')} role="status" data-testid="banner">
        <span className="mode-dot" aria-hidden="true" /><span className="mode-badge">{mode === 'mock' ? 'MOCK' : 'LIVE'}</span>{bannerText(config?.issuer, mode)}
      </div>
      <header className="top">
        <div className="brand">
          <img className="brand__logo" src="/ping-logo.png" alt="Ping Identity" width="40" height="40" />
          <div>
            <h1><a href="#/">{name}</a></h1>
        <ShelfLink headers={() => ({ "x-lab-workspace": currentWorkspace() })} />
            {config?.customer?.tagline && <p className="tagline">{config.customer.tagline}</p>}
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          <a href="#/" aria-current={route.view === 'shelf' ? 'page' : undefined}>Shelf</a>
          <a href="#/playground" aria-current={route.view === 'playground' ? 'page' : undefined}>Playground</a>
          <a href="#/settings" aria-current={route.view === 'settings' ? 'page' : undefined}>Settings</a>
        </nav>
        <div className="prefs">
          <div className="mode-toggle" role="group" aria-label="Mock or live PingFederate">
            <span className="mode-toggle__label">PingFederate</span>
            {[
              ['mock', 'Mock', false],
              ['live', 'Real', true],
            ].map(([m, label, isReal]) => {
              const off = switching || (isReal && realAvailable === false);
              const why = isReal && realAvailable === false && modeInfo?.realReason ? modeInfo.realReason : undefined;
              return (
                <button key={m} type="button" className="mode-toggle__button" aria-pressed={mode === m} disabled={off} title={why} onClick={() => setMode(m)} data-testid={`mode-${isReal ? 'real' : 'mock'}`}>
                  {label}
                </button>
              );
            })}
          </div>
          <WorkspaceSwitch current={config?.workspace || 'default'} known={workspaces} onChoose={(id) => { chooseWorkspace(id); window.location.reload(); }} />
          <label className="inline">Theme
            <select value={theme} onChange={(e) => setTheme(e.target.value)}>
              {THEMES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
            </select>
          </label>
          <button type="button" aria-pressed={presenter} onClick={() => setPresenter((p) => !p)}>Presenter</button>
        </div>
        <div className="who">
          {me.signedIn
            ? <><span>Signed in as <strong data-testid="who">{me.user?.subject}</strong></span><button type="button" onClick={signOut}>Sign out</button></>
            : <button type="button" className="primary" onClick={signIn}>Sign in</button>}
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {loadError && <p className="pt pt-error" role="alert">Could not load the lab: {loadError}</p>}
        {route.view === 'shelf' && <Shelf cards={cards} story={story} verticals={verticals} vertical={vertical} onVertical={setVertical} />}
        {route.view === 'run' && (card
          ? <RunView key={card.id} card={card} story={story?.cards?.[card.id]} onChanged={refresh} signedInAs={me.signedIn ? me.user?.subject : null}
              autoStart={card.id === 'signin' && signInRequested} onAutoStarted={() => setSignInRequested(false)} />
          : cards.length > 0 && <p>Unknown card. <a href="#/">Back to the shelf</a></p>)}
        {route.view === 'settings' && <Settings focus={route.focus} onChanged={refresh} warnings={config?.customer?.warnings || []} />}
        {route.view === 'playground' && <Playground cards={cards} onChanged={refresh} signedInAs={me.signedIn ? me.user?.subject : null} />}
      </main>
      <footer className="foot">
        <p>Live tokens are shown masked (first 6 and last 4 characters) with their decoded header and claims; mock tokens are fake and shown whole; secrets never leave the lab server. <a href="#/settings">Settings</a></p>
      </footer>
    </div>
  );
}
