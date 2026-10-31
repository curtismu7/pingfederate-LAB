import { useMemo, useState } from 'react';
import DiagramView from '../DiagramView.jsx';
import Steps from './Steps.jsx';
import Credentials from './Credentials.jsx';
import CibaApproval from './CibaApproval.jsx';
import { TraceList } from '../Proof.jsx';
import { FLOWS, FLOW_IDS, latestTrace, proofPoints, traceToDiagram } from '../flows.js';
import { useFlowRun } from '../useFlowRun.js';

// The PingFederate Protocol Playground: every flow, step by step, on the same server endpoints as the cards.
// Flows that take a user: CIBA asks that user to approve; the sign-in flows send it as login_hint (RAR as user_id).
const USER_FLOWS = new Set(['ciba', 'signin', 'pkce', 'par', 'dpop', 'rar']);

function FlowPanel({ flowId, ready, onChanged, signedInAs }) {
  const [loginHint, setLoginHint] = useState('');
  const run = useFlowRun(flowId, { onSettled: onChanged });
  const settled = useMemo(() => run.results.filter((r) => r && !r.skipped && !r.pending), [run.results]);
  const trace = useMemo(() => latestTrace(settled), [settled]);
  const diagram = useMemo(() => traceToDiagram(trace, `${FLOWS[flowId].title}: calls so far`), [trace, flowId]);
  const points = useMemo(() => proofPoints(flowId, settled), [flowId, settled]);
  const options = { amount: '125', currency: 'USD', loginHint, rarUser: loginHint };
  // CIBA needs someone to ask: the typed user, or else the signed-in user.
  const needsSignIn = flowId === 'ciba' && !signedInAs && !loginHint.trim();
  // CIBA: while a poll runs, the latest "still pending" answer says whether PingFederate has asked this lab for the approval.
  const cibaPending = flowId === 'ciba' ? run.results.map((r) => r?.data).filter((d) => d?.state === 'pending').at(-1) : null;

  // The trace entries each step added (the server returns the run's trace so far with every answer).
  const perStep = useMemo(() => {
    let seen = 0;
    return run.results.map((r) => {
      const t = r?.data?.trace;
      if (!Array.isArray(t)) return [];
      const added = t.slice(t.length >= seen ? seen : 0);
      seen = t.length;
      return added;
    });
  }, [run.results]);

  return (
    <div className="pg-flow">
      {USER_FLOWS.has(flowId) && (
        <label className="pg-user" htmlFor={`pg-${flowId}-user`}>User (login_hint)
          <input id={`pg-${flowId}-user`} type="text" value={loginHint} maxLength={256} onChange={(e) => setLoginHint(e.target.value)}
            placeholder={signedInAs ? `empty = ${signedInAs} (signed in)` : 'optional, a user name'} />
        </label>
      )}
      <div className="run-actions">
        <button type="button" className="primary" onClick={() => run.runAll(options)} disabled={run.busy || !ready || needsSignIn}>Run all</button>
        <button type="button" onClick={run.clear} disabled={run.busy}>Clear</button>
        {!ready && <span className="hint">Not ready: see the card on the shelf for what is missing.</span>}
        {ready && needsSignIn && <span className="hint">Type the user who should approve, or <a href="#/run/signin">sign in</a> and leave it empty to use yourself.</span>}
      </div>
      <Steps flow={run.flow} results={run.results} waiting={run.waiting} onExecute={(i) => run.runOne(i, options)} busy={run.busy || !ready || needsSignIn} />
      {cibaPending && run.busy && <CibaApproval key={cibaPending.expiresAt} pending={cibaPending} />}
      {run.waiting >= 0 && <Credentials busy={run.busy} refused={run.results[run.waiting]?.data?.refused} onSubmit={(c) => run.submitCredentials(c, { single: true })} idPrefix={`pg-${flowId}`} initialUsername={run.results[run.waiting - 1]?.data?.loginHint || ''} mock={run.results[run.waiting - 1]?.data?.mode === 'mock'} />}
      {points.length > 0 && <ul className="points" aria-live="polite">{points.map((p, i) => <li key={`${i}-${p.text}`} className={`pt pt-${p.tone}`}><span className="pt-tag">{p.tag || p.tone}</span> {p.text}</li>)}</ul>}
      {diagram && <DiagramView key={`live-${trace.length}`} diagram={diagram} heading="h4" />}
      <h4>Request and response per step</h4>
      {run.flow.steps.map((step, i) => (run.results[i] && !run.results[i].skipped && !run.results[i].pending ? (
        <section key={step.id} className="pg-step" aria-label={`Step ${i + 1} raw`}>
          <h5>{i + 1}. {step.label} <span className="mono hint">POST {step.path} : {run.results[i].status}</span></h5>
          {!run.results[i].ok && <p className="pt pt-error" role="alert"><code>{run.results[i].data?.error}</code>{run.results[i].data?.message ? `: ${run.results[i].data.message}` : ''}</p>}
          <TraceList trace={perStep[i] || []} />
        </section>
      ) : null))}
    </div>
  );
}

export default function Playground({ cards, onChanged, signedInAs = null }) {
  const [flowId, setFlowId] = useState(FLOW_IDS[0]);
  const readyOf = (id) => (id === 'discovery' ? cards.find((c) => c.id === 'playground')?.ready : cards.find((c) => c.id === id)?.ready);
  return (
    <section aria-labelledby="pg-title" className="playground">
      <p className="crumbs"><a href="#/">Shelf</a> / Playground</p>
      <h2 id="pg-title">PingFederate Protocol Playground</h2>
      <p className="explain">Every flow, step by step. Execute one step at a time or run them all; each step calls the same lab endpoint as its card, and the lab calls your PingFederate.</p>
      <div className="pg">
        <nav className="pg-nav" aria-label="Flows">
          {FLOW_IDS.map((id) => (
            <button key={id} type="button" aria-pressed={id === flowId} onClick={() => setFlowId(id)}>
              {FLOWS[id].title}<span className="hint"> {FLOWS[id].steps.length} step{FLOWS[id].steps.length === 1 ? '' : 's'}</span>
            </button>
          ))}
        </nav>
        <div className="pg-main">
          <h3>{FLOWS[flowId].title}</h3>
          <FlowPanel key={flowId} flowId={flowId} ready={Boolean(readyOf(flowId))} onChanged={onChanged} signedInAs={signedInAs} />
        </div>
      </div>
    </section>
  );
}
