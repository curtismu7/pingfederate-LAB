import { useMemo, useRef, useState } from 'react';
import DiagramView from './DiagramView.jsx';
import { latestTrace, proofPoints, traceToDiagram, endpointName, lastTokenStep, tokenFacts, EXPECTED_REFUSALS } from './flows.js';

const json = (value) => JSON.stringify(value, null, 2);

// A token as the server shows it: masked value (the whole fake token in mock mode), length, kind, and its decoded header and claims.
export function TokenView({ label, token }) {
  if (!token) return null;
  return (
    <div className="token">
      <h4>{label}{token.mock && <span className="tag-mock" title="Issued by the lab's mock PingFederate">mock</span>}</h4>
      {token.raw
        ? <p className="mono token-raw"><span className="tag">raw</span> {token.value} <span className="hint">({token.length} characters, {token.kind}; fake, issued by the mock)</span></p>
        : token.masked && <p className="mono"><span className="tag">masked</span> {token.masked} <span className="hint">({token.length} characters, {token.kind})</span></p>}
      {token.header && <><h5>Header</h5><pre>{json(token.header)}</pre></>}
      {token.claims && <><h5>Claims</h5><pre>{json(token.claims)}</pre></>}
    </div>
  );
}

// The decoded-claims card: scopes, audience, subject and expiry of the newest token a settled step returned, then the
// full token view (value as the server shows it, header, claims). `steps` are the flow's steps, to name where it came from.
export function TokenCard({ results, steps }) {
  const found = useMemo(() => lastTokenStep(results), [results]);
  if (!found) return <p className="hint" role="status">No token yet. A step that returns a token (or its decoded claims) shows it here.</p>;
  const step = steps?.[found.index];
  return (
    <div className="token-card">
      <p className="hint">From step {found.index + 1}{step ? `: ${step.label}` : ''}.</p>
      <div className="tokens">
        {found.tokens.map(({ label, view }) => {
          const facts = tokenFacts(view.claims);
          return (
            <div key={label}>
              {facts
                ? (
                  <dl className="token-facts" aria-label={`${label}: scopes, audience, subject, expiry`}>
                    <div><dt>Scopes</dt><dd className="mono">{facts.scopes.join(' ') || 'none in the token'}</dd></div>
                    <div><dt>aud</dt><dd className="mono">{facts.aud.join(', ') || 'none in the token'}</dd></div>
                    <div><dt>sub</dt><dd className="mono">{facts.sub || 'none in the token'}</dd></div>
                    <div><dt>exp</dt><dd className="mono">{facts.exp || 'none in the token'}</dd></div>
                  </dl>
                )
                : <p className="hint">{label} is opaque: there are no claims to decode.</p>}
              <TokenView label={label} token={view} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Every request and response, as the server recorded them (secrets redacted there, live tokens masked, mock tokens whole).
export function TraceList({ trace }) {
  const listRef = useRef(null);
  const [allOpen, setAllOpen] = useState(false);
  // One click opens (or closes) every step; each step still opens on its own too.
  const toggleAll = () => {
    const next = !allOpen;
    for (const d of listRef.current?.querySelectorAll(':scope > li > details') || []) d.open = next;
    setAllOpen(next);
  };
  if (!trace.length) return <p className="hint">No PingFederate call yet.</p>;
  return (
    <>
    <div className="trace-tools"><button type="button" onClick={toggleAll} aria-expanded={allOpen}>{allOpen ? 'Collapse all' : 'Expand all'}</button></div>
    <ol className="trace-list" ref={listRef}>
      {trace.map((s, i) => {
        const status = s.response?.status;
        return (
          <li key={`${i}-${s.id}`}>
            <details>
              <summary>
                <span className="trace-n">{String(i + 1).padStart(2, '0')}</span>
                <span className="trace-title">{s.title}{s.mock && <span className="tag-mock" title="Answered by the lab's mock PingFederate">mock</span>}</span>
                {s.request && <span className="mono trace-meta">{s.request.method} {endpointName(s.request.url)}</span>}
                {Number.isInteger(status) && (status >= 400 && EXPECTED_REFUSALS.has(s.id)
                  ? <span className="status s-ok" title="Refused as expected: this call tests that PingFederate says no">{status} as expected</span>
                  : <span className={`status ${status >= 400 ? 's-bad' : 's-ok'}`}>{status}</span>)}
              </summary>
              {s.note && <p className="note">{s.note}</p>}
              {s.request && (
                <div className="io">
                  <h5>Request</h5>
                  <p className="mono wrap">{s.request.method} {s.request.url}</p>
                  {s.request.headers && <pre>{json(s.request.headers)}</pre>}
                  {s.request.params && <><h6>Parameters</h6><pre>{json(s.request.params)}</pre></>}
                  {s.request.body && <><h6>Body</h6><pre>{json(s.request.body)}</pre></>}
                </div>
              )}
              {s.response && (
                <div className="io">
                  <h5>Response{Number.isInteger(status) ? ` ${status}` : ''}</h5>
                  {s.response.location && <p className="mono wrap">Location: {s.response.location}</p>}
                  {s.response.body !== undefined && s.response.body !== null && <pre>{json(s.response.body)}</pre>}
                </div>
              )}
              {s.claims && <div className="io"><h5>Decoded claims</h5><pre>{json(s.claims)}</pre></div>}
            </details>
          </li>
        );
      })}
    </ol>
    </>
  );
}

// The proof panel: the live sequence, plain proof points, the tokens, and the raw trace.
export default function Proof({ flowId, results }) {
  const settled = useMemo(() => results.filter((r) => r && !r.skipped && !r.pending), [results]);
  const trace = useMemo(() => latestTrace(settled), [settled]);
  const points = useMemo(() => proofPoints(flowId, settled), [flowId, settled]);
  const diagram = useMemo(() => traceToDiagram(trace), [trace]);
  const last = settled.at(-1)?.data || {};
  if (!settled.length) return null;
  return (
    <section className="proof" aria-label="Proof">
      <h3>Proof</h3>
      <ul className="points" aria-live="polite">
        {points.map((p, i) => <li key={`${i}-${p.text}`} className={`pt pt-${p.tone}`}><span className="pt-tag">{p.tag || p.tone}</span> {p.text}</li>)}
      </ul>
      {points.some((p) => p.tone === 'expected') && (
        <p className="hint">"Refused as expected" lines are passes: the run asks for something PingFederate must refuse, and it did.</p>
      )}
      {diagram && <DiagramView key={`live-${trace.length}`} diagram={diagram} heading="h4" />}
      {(last.accessToken || last.idToken || last.token) && (
        <div className="tokens">
          <TokenView label="Access token" token={last.accessToken || last.token} />
          <TokenView label="ID token" token={last.idToken} />
        </div>
      )}
      <h4>Raw trace</h4>
      <p className="hint">Every request the lab sent to PingFederate and every answer, with secrets redacted on the server and live tokens masked (mock tokens are fake and shown whole). Each request carried a W3C traceparent.</p>
      <TraceList trace={trace} />
    </section>
  );
}
