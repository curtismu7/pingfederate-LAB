import { useCallback, useEffect, useState } from 'react';
import { api, chooseWorkspace } from './api.js';
import Shelf from './views/Shelf.jsx';
import RunView from './views/RunView.jsx';
import Settings from './views/Settings.jsx';
import Playground from './views/Playground.jsx';
import WorkspaceSwitch from './views/WorkspaceSwitch.jsx';
import TopMenu, { applyFontSize } from './top-menu/TopMenu.jsx';
import TalkTrackDialog from "./talk-track/TalkTrackDialog.jsx";
import talkMd from "../../docs/talk-track.md?raw";
import ShelfLink from "./components/ShelfLink.jsx";
import VerifyMark from "./components/VerifyMark.jsx";
import { currentWorkspace } from "./api.js";
import ReturnLink from "./return-link/ReturnLink.jsx";
import { readReturnContext } from "./return-link/returnTargets.js";
import { cardFor, verticalFor } from "./handoffMap.js";
import ModeModal from "./mode-modal/ModeModal.jsx";

// Opened from Customer Agent LAB: on load, with no route in the hash yet, open the mapped card (handoffMap.js). The hash is written
// back so the router and the address bar agree; the query (and with it the strip) stays.
function initialRoute(handoff) {
  const card = !window.location.hash.replace(/^#\/?/, '') && cardFor(handoff);
  if (card) window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/run/${card}`);
  return parseRoute(window.location.hash);
}

// Hash routes: #/ (shelf), #/run/<card>, #/settings[/<section.field>], #/playground.
export function parseRoute(hash) {
  const parts = String(hash || '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'run' && parts[1]) return { view: 'run', card: parts[1] };
  if (parts[0] === 'settings') return { view: 'settings', focus: parts[1] && /^[A-Za-z]+\.[A-Za-z]+$/.test(parts[1]) ? parts[1] : null };
  if (parts[0] === 'playground') return { view: 'playground' };
  return { view: 'shelf' };
}

// Rule 2 (amended 2026-11-28): the Real-or-mock modal says whether the lab is on the mock or on a real PingFederate (it replaced the banner).
// Until /api/config has answered it says MOCK with the "unknown" line; Live is this lab's word for REAL, and Live with no PingFederate set is "off".
export const MODE_LINES = {
  unknown: 'The lab server has not said which mode this is yet, so treat everything as simulated until it does.',
  mock: 'A simulated PingFederate inside this lab. Nothing leaves this machine.',
  live: (issuer) => `Every call goes to your PingFederate at ${issuer}. Nothing here is simulated.`,
  off: 'Not connected: set your PingFederate in Settings.',
};

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
  const [handoff] = useState(() => readReturnContext(window.location.search));
  const [talkOpen, setTalkOpen] = useState(false);
  const talkSteps = (() => {
    const steps = []; let n = 0;
    for (const line of talkMd.split("\n")) {
      const m = line.match(/^\d+\.\s+(?:"(.+?)"|\*\*(.+?)\.\*\*\s*(.*))$/);
      if (m) { n += 1; steps.push({ id: `s${n}`, title: (m[1] || m[2]).slice(0, 60), say: m[1] || m[3] }); }
    }
    return steps.length ? steps : [{ id: "s1", title: "Talk track", say: talkMd.slice(0, 600) }];
  })();
  const [route, setRoute] = useState(() => initialRoute(handoff));
  const [config, setConfig] = useState(null);
  const [cards, setCards] = useState([]);
  const [me, setMe] = useState({ signedIn: false });
  const [verticals, setVerticals] = useState([]);
  const [vertical, setVertical] = useState(() => verticalFor(handoff) || read('pflab-vertical', ''));
  const [story, setStory] = useState(null);
  const [theme, setTheme] = useState(() => (THEMES.includes(read('pflab-theme', 'auto')) ? read('pflab-theme', 'auto') : 'auto'));
  const [presenter, setPresenter] = useState(() => new URLSearchParams(window.location.search).get('present') === '1');
  const [fontStep, setFontStep] = useState(() => (['S', 'M', 'L'].includes(read('pflab.font', 'M')) ? read('pflab.font', 'M') : 'M'));
  useEffect(() => { applyFontSize(fontStep); write('pflab.font', fontStep); }, [fontStep]);
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
      <header className="shell-bar">
        <div className="shell-brand">
          <img className="shell-logo" src="/ping-logo.png" alt="Ping Identity" width="30" height="30" />
          <h1><a href="#/">{name}</a></h1>
          <span className={`shell-badge${mode === 'mock' ? '' : ' shell-badge--real'}`} data-testid="mode-badge">{mode === 'mock' ? 'Mock' : 'Real'}</span>
        </div>
        <nav className="shell-nav" aria-label="Main">
          {/* A card's run view opens from the shelf, so the Shelf pill stays current there. */}
          <a href="#/" aria-current={route.view === 'shelf' || route.view === 'run' ? 'page' : undefined}>Shelf</a>
          <a href="#/playground" aria-current={route.view === 'playground' ? 'page' : undefined}>Playground</a>
          <a href="#/settings" aria-current={route.view === 'settings' ? 'page' : undefined}>Settings</a>
        </nav>
        <TopMenu
          mode={{ value: mode === 'live' ? 'real' : mode, onChange: (v) => setMode(v === 'real' ? 'live' : v), realAvailable, realHint: modeInfo?.realReason }}
          theme={{ value: theme, onChange: setTheme }}
          fontSize={{ value: fontStep, onChange: setFontStep }}
          present={{ active: presenter, onToggle: () => setPresenter((p) => !p) }}
          talkTrack={{ active: talkOpen, onToggle: () => setTalkOpen((v) => !v) }}
          help={{ href: 'https://github.com/curtismu7/pingfederate-LAB#readme' }}
          version={modeInfo?.version || null}
          showSignIn={mode === 'live'}
          signedIn={{ subject: me.signedIn ? me.user?.subject : null, onSignIn: signIn, onSignOut: signOut }}
          extra={<WorkspaceSwitch current={config?.workspace || 'default'} known={workspaces} onChoose={(id) => { chooseWorkspace(id); window.location.reload(); }} />}
        >
          <ReturnLink app="pingfederate" variant="header" />
          <ShelfLink headers={() => ({ "x-lab-workspace": currentWorkspace() })} />
          <VerifyMark id="pingfederate-lab" headers={() => ({ "x-lab-workspace": currentWorkspace() })} />
        </TopMenu>
      </header>
      <main id="main" tabIndex={-1}>
        <ReturnLink app="pingfederate" />
        {loadError && <p className="pt pt-error" role="alert">Could not load the lab: {loadError}</p>}
        {config?.customer?.tagline && <p className="tagline">{config.customer.tagline}</p>}
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
      <TalkTrackDialog isOpen={talkOpen} onClose={() => setTalkOpen(false)} talk={talkSteps} />

      </footer>
      <ModeModal mode={config && mode !== 'mock' ? 'real' : 'mock'} lines={{ mock: config ? MODE_LINES.mock : MODE_LINES.unknown, real: config?.issuer ? MODE_LINES.live(config.issuer) : MODE_LINES.off }} storageKey="pfl-mode" />
    </div>
  );
}
