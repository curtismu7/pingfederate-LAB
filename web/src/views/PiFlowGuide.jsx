import { latestTrace } from '../flows.js';
import { PIFLOW_GUIDE } from '../piflowGuide.js';

// The pi.flow card's explainer: the idea, the steps (tied to the trace), a field guide to the JSON this run got
// back, the statuses, and when to use it. The content is data (piflowGuide.js); the live answer comes from the run.
const short = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}...` : v;
  if (Array.isArray(v)) return `${v.length} item${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') return Object.keys(v).join(', ');
  return String(v);
};

export default function PiFlowGuide({ results = [] }) {
  const g = PIFLOW_GUIDE;
  const trace = latestTrace(results);
  const opened = trace.find((s) => s.id === 'authorize')?.response?.body;
  const body = opened && typeof opened === 'object' ? opened : null;
  const seenStatus = body?.status || null;

  return (
    <section className="pfg" aria-labelledby="pfg-title">
      <h3 id="pfg-title">How pi.flow works</h3>

      <h4>1. The idea</h4>
      {g.idea.map((p) => <p key={p} className="pfg-p">{p}</p>)}

      <h4>2. The steps</h4>
      <ol className="pfg-steps">
        {g.steps.map((s) => (
          <li key={s.title}>
            <strong>{s.title}</strong>{s.onThisCard && <span className="pfg-tag">on this card</span>}
            <span className="pfg-detail">{s.detail}</span>
            {s.call && <code className="pfg-call">{s.call}</code>}
          </li>
        ))}
      </ol>
      <p className="hint">{g.stepsNote}</p>
      <h5>{g.idp} and {g.otherIdp} differ here</h5>
      <ul className="pfg-diff">
        {g.differences.map((d) => <li key={d.topic}><strong>{d.topic}:</strong> {d.here} <span className="hint">({g.otherIdp}: {d.other})</span></li>)}
      </ul>

      <h4>3. The answer you just got</h4>
      {!body && <p className="hint" role="status">Press Run: {g.idp}&apos;s JSON answer is explained here, field by field.</p>}
      <dl className="pfg-fields">
        {g.fields.map((f) => {
          const present = body ? Object.hasOwn(body, f.key) : null;
          return (
            <div key={f.key} className={present === false ? 'pfg-absent' : undefined}>
              <dt><code>{f.key}</code>{present && <span className="pfg-val">{short(body[f.key])}</span>}{present === false && <span className="hint"> not in this answer</span>}</dt>
              <dd>{f.meaning}</dd>
            </div>
          );
        })}
      </dl>
      {body && Object.keys(body).filter((k) => !g.fields.some((f) => f.key === k)).length > 0 && (
        <p className="hint">Also in this answer: {Object.keys(body).filter((k) => !g.fields.some((f) => f.key === k)).join(', ')}. The trace below shows every field.</p>
      )}
      <p className="hint">{g.cookieNote}</p>

      <h4>4. Statuses</h4>
      <div className="pfg-table-wrap" tabIndex={0} role="region" aria-label="pi.flow statuses">
        <table className="pfg-table">
          <thead><tr><th scope="col">status</th><th scope="col">What it means</th><th scope="col">What the app does</th><th scope="col">In this lab</th></tr></thead>
          <tbody>
            {g.statuses.map((s) => (
              <tr key={s.status} className={s.status === seenStatus ? 'pfg-seen' : undefined}>
                <th scope="row"><code>{s.status}</code>{s.status === seenStatus && <span className="pfg-tag">your answer</span>}</th>
                <td>{s.meaning}</td>
                <td>{s.app}</td>
                <td>{s.lab}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">{g.statusesNote}</p>

      <h4>5. When to use it</h4>
      <div className="pfg-when">
        <div><h5>Good fit</h5><ul>{g.when.good.map((w) => <li key={w}>{w}</li>)}</ul></div>
        <div><h5>Use the redirect sign-in instead</h5><ul>{g.when.avoid.map((w) => <li key={w}>{w}</li>)}</ul></div>
      </div>
      <p className="pfg-p">{g.when.note}</p>
    </section>
  );
}
