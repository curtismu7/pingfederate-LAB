import { stepState } from '../useFlowRun.js';

const LABEL = { idle: 'not run', running: 'running', done: 'done', refused: 'refused', error: 'error', skipped: 'not needed', waiting: 'waiting for you' };

// The flow's steps in order with their state; the playground adds an Execute button per step.
export default function Steps({ flow, results, waiting, onExecute, busy }) {
  return (
    <ol className="steps" aria-live="polite">
      {flow.steps.map((step, i) => {
        const state = stepState(results[i], waiting === i);
        const err = results[i] && !results[i].ok && !results[i].skipped && !results[i].pending ? results[i].data : null;
        return (
          <li key={step.id} className={`step st-${state}`}>
            <span className="step-n">{i + 1}</span>
            <span className="step-label">{step.label}{step.credentials && <span className="hint"> (only when PingFederate asks)</span>}</span>
            <span className={`chip chip-${state}`}>{LABEL[state]}</span>
            {onExecute && <button type="button" onClick={() => onExecute(i)} disabled={busy} aria-label={`Execute step ${i + 1}: ${step.label}`}>Execute</button>}
            {err && <p className="step-err" role="alert"><code>{err.error || 'error'}</code>{err.message ? `: ${err.message}` : ''}</p>}
          </li>
        );
      })}
    </ol>
  );
}
