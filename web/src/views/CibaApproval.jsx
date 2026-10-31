import { useState } from 'react';
import { api } from '../api.js';

// The CIBA approval panel, shared by the CIBA card and the Playground: while the poll runs and PingFederate's web
// approver has handed the request to this lab, the person who started it approves or denies it here. `pending` is the
// latest "still pending" answer from the server. Mount it with a key that changes per request so the buttons reset.
export default function CibaApproval({ pending }) {
  const [decision, setDecision] = useState(null); // { sent, done } | { error }
  const decide = async (choice) => {
    setDecision({ sent: choice });
    const r = await api.cibaDecision(choice);
    setDecision(r.ok ? { sent: choice, done: true } : { error: r.data?.message || r.data?.error || `HTTP ${r.status}` });
  };
  return (
    <section className="creds" aria-label="Approve on this page">
      {pending.approval === 'lab' ? (
        <>
          <p className="creds-title"><strong>PingFederate asks {pending.loginHint} to approve</strong>{pending.bindingMessage ? <>: <code>{pending.bindingMessage}</code></> : null}.
            {' '}<span className="hint">In production this reaches their phone; here PingFederate's web approver brings it to this page.</span></p>
          <div className="run-actions">
            <button type="button" className="primary" onClick={() => decide('approve')} disabled={Boolean(decision?.sent)}>Approve</button>
            <button type="button" onClick={() => decide('deny')} disabled={Boolean(decision?.sent)}>Deny</button>
          </div>
        </>
      ) : (
        <p className="creds-title">{pending.approval === 'waiting'
          ? 'Waiting for PingFederate to ask for the approval...'
          : 'PingFederate sends this approval to the user through its own CIBA authenticator (for example a phone push). Approve it there; this page keeps polling.'}</p>
      )}
      {decision?.done && <p className="pt pt-info" role="status">{decision.sent === 'approve' ? 'Approved' : 'Denied'}. PingFederate picks it up on its next check; the poll then finishes.</p>}
      {decision?.error && <p className="pt pt-error" role="alert">{decision.error}</p>}
    </section>
  );
}
