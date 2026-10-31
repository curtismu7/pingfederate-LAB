import { useEffect, useRef, useState } from 'react';
import DiagramView from '../DiagramView.jsx';
import Proof from '../Proof.jsx';
import Steps from './Steps.jsx';
import Credentials from './Credentials.jsx';
import Readiness from './Readiness.jsx';
import PiFlowGuide from './PiFlowGuide.jsx';
import CibaApproval from './CibaApproval.jsx';
import { useFlowRun } from '../useFlowRun.js';
import { CARD_DIAGRAM } from '../diagrams/index.js';
import { EXPLAIN } from '../content.js';
import { api } from '../api.js';

// Cards that sign a user in through pi.flow and take an optional user (RAR names its user in the transaction).
const HINT_CARDS = new Set(['signin', 'pkce', 'par', 'dpop']);

// One card: run its server steps in order, answer PingFederate's credential prompt in the lab's own form, and
// read the proof (sequence, proof points, raw trace).
export default function RunView({ card, story, onChanged, autoStart = false, onAutoStarted, signedInAs = null }) {
  const run = useFlowRun(card.id, { onSettled: onChanged });
  const [amount, setAmount] = useState('125');
  const [currency, setCurrency] = useState('USD');
  const [dpop, setDpop] = useState(false);
  const [loginHint, setLoginHint] = useState('');
  const [bindingMessage, setBindingMessage] = useState('');
  // RAR: the user and accounts PingFederate's banking_transaction processor checks; empty fields use the signed-in
  // user and the accounts saved in Settings (shown as placeholders).
  const [rarUser, setRarUser] = useState('');
  const [fromAccount, setFromAccount] = useState('');
  const [toAccount, setToAccount] = useState('');
  // The server says what the empty fields fall back to (the mock's user and accounts in mock mode, the saved accounts
  // in live mode), so the card runs with no typing in mock mode.
  const defaults = card.defaults || {};
  const savedAccounts = { from: defaults.sourceAccount || '', to: defaults.destinationAccount || '' };
  const rarReady = Boolean((rarUser.trim() || signedInAs || defaults.user) && (fromAccount.trim() || savedAccounts.from) && (toAccount.trim() || savedAccounts.to));
  const waitingResult = run.waiting >= 0 ? run.results[run.waiting] : null;
  // CIBA: the latest "still pending" answer says whether PingFederate has asked this lab for the approval.
  const cibaPending = card.id === 'ciba' ? run.results.map((r) => r?.data).filter((d) => d?.state === 'pending').at(-1) : null;

  // CIBA asks PingFederate to get one named user's approval: the typed user, or else whoever is signed in here.
  const cibaApprover = loginHint.trim() || signedInAs || '';
  const start = () => run.runAll({ amount, currency, dpop, loginHint, bindingMessage, rarUser, fromAccount, toAccount });
  // StrictMode runs effects twice in development; the ref keeps it to one start.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStarted.current) return;
    autoStarted.current = true;
    onAutoStarted?.();
    if (card.ready && !run.busy) start();
  }, [autoStart]); // eslint-disable-line react-hooks/exhaustive-deps
  const reset = async () => { await api.reset(); run.clear(); onChanged?.(); };

  return (
    <article className="run" aria-labelledby="run-title">
      <p className="crumbs"><a href="#/">Shelf</a> / {card.title}</p>
      <header className="run-head">
        <h2 id="run-title">{card.title}</h2>
        <Readiness card={card} />
      </header>
      {story && <p className="story">{story}</p>}
      <p className="explain">{EXPLAIN[card.id]}</p>

      {card.id === 'rar' && (
        <fieldset className="opts">
          <legend>The transaction</legend>
          <label htmlFor="rar-amount">Amount<input id="rar-amount" type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
          <label htmlFor="rar-user">User (user_id)<input id="rar-user" type="text" value={rarUser} placeholder={signedInAs || defaults.user || 'a PingFederate user name'} onChange={(e) => setRarUser(e.target.value)} maxLength={256} /></label>
          <label htmlFor="rar-from">From account<input id="rar-from" type="text" value={fromAccount} placeholder={savedAccounts.from || 'set in Settings'} onChange={(e) => setFromAccount(e.target.value)} maxLength={64} spellCheck={false} /></label>
          <label htmlFor="rar-to">To account<input id="rar-to" type="text" value={toAccount} placeholder={savedAccounts.to || 'set in Settings'} onChange={(e) => setToAccount(e.target.value)} maxLength={64} spellCheck={false} /></label>
          <p className="hint">PingFederate accepts only the signed-in user's own accounts, within their limit. Sign in as that user when asked.{!rarReady && <> Needed first: a user (or <a href="#/run/signin">sign in</a>) and both accounts (here or in <a href="#/settings/rar.sourceAccount">Settings</a>).</>}</p>
          <label htmlFor="rar-currency">Currency<input id="rar-currency" type="text" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></label>
          <label className="check" htmlFor="rar-dpop">
            <input id="rar-dpop" type="checkbox" checked={dpop} onChange={(e) => setDpop(e.target.checked)} disabled={!card.variantsReady?.dpop} />
            Bind to DPoP {!card.variantsReady?.dpop && <span className="hint">(set up the RAR with DPoP client in <a href="#/settings/rarDpop.clientId">Settings</a>)</span>}
          </label>
        </fieldset>
      )}
      {HINT_CARDS.has(card.id) && (
        <fieldset className="opts">
          <legend>Who signs in</legend>
          <label htmlFor="flow-hint">User (login_hint)<input id="flow-hint" type="text" value={loginHint} placeholder="optional, a PingFederate user name" onChange={(e) => setLoginHint(e.target.value)} maxLength={256} /></label>
          <p className="hint">Sent to PingFederate as login_hint; the sign-in form then starts with this username.</p>
        </fieldset>
      )}
      {card.id === 'ciba' && (
        <fieldset className="opts">
          <legend>Who should approve</legend>
          <label htmlFor="ciba-hint">User (login_hint)<input id="ciba-hint" type="text" value={loginHint} placeholder={signedInAs || 'a PingFederate user name'} onChange={(e) => setLoginHint(e.target.value)} maxLength={256} aria-describedby="ciba-who" /></label>
          <p id="ciba-who" className={`hint${cibaApprover ? '' : ' pt-refused'}`} role="status">
            {cibaApprover
              ? <>PingFederate will ask <strong>{cibaApprover}</strong> to approve{loginHint.trim() ? '' : ' (the signed-in user)'}.</>
              : <>Type the user who should approve, or <a href="#/run/signin">sign in</a> first and leave this empty to use yourself.</>}
          </p>
          <label htmlFor="ciba-msg">Binding message<input id="ciba-msg" type="text" value={bindingMessage} placeholder="optional, e.g. PAY-42" onChange={(e) => setBindingMessage(e.target.value)} maxLength={20} /></label>
        </fieldset>
      )}

      <div className="run-actions">
        <button type="button" className="primary" onClick={start} disabled={run.busy || !card.ready || (card.id === 'ciba' && !cibaApprover) || (card.id === 'rar' && !rarReady)}>{run.busy ? 'Running...' : 'Run'}</button>
        <button type="button" onClick={reset} disabled={run.busy}>Reset this card</button>
      </div>

      <Steps flow={run.flow} results={run.results} waiting={run.waiting} />
      {cibaPending && run.busy && <CibaApproval key={cibaPending.expiresAt} pending={cibaPending} />}
      {run.waiting >= 0 && (
        <Credentials busy={run.busy} refused={waitingResult?.data?.refused} onSubmit={(c) => run.submitCredentials(c)} idPrefix={`${card.id}-cred`} initialUsername={run.results[run.waiting - 1]?.data?.loginHint || ''} mock={run.results[run.waiting - 1]?.data?.mode === 'mock'} />
      )}

      <Proof flowId={card.id} results={run.results} />
      {card.id === 'piflow' && <PiFlowGuide results={run.results} />}

      {CARD_DIAGRAM[card.id] && (
        <details className="how" open>
          <summary>How it works</summary>
          <DiagramView id={CARD_DIAGRAM[card.id]} heading="h4" />
        </details>
      )}
    </article>
  );
}
