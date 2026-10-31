import { useCallback, useRef, useState } from 'react';
import { FLOWS, needsStep, runStep } from './flows.js';

// Runs a flow's steps in order (Run all) or one at a time (the playground). A credentials step pauses the run until
// the person types a username and password; the password is sent once and never kept in state.
export function useFlowRun(flowId, { onSettled } = {}) {
  const flow = FLOWS[flowId];
  const [results, setResults] = useState([]); // index-aligned with flow.steps: { ok, status, data } | { skipped: true }
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(-1); // index of a credentials step waiting for input
  const optionsRef = useRef({});

  const setAt = (i, value) => setResults((prev) => { const next = prev.slice(0, i); next[i] = value; return next; });

  const previousOf = (list, i) => { for (let j = i - 1; j >= 0; j -= 1) if (list[j] && !list[j].skipped) return list[j]; return null; };

  // Runs from step `from` until done, a failure, or a credentials prompt.
  const runFrom = useCallback(async (from, list, { single = false } = {}) => {
    const acc = list.slice(0, from);
    for (let i = from; i < flow.steps.length; i += 1) {
      const step = flow.steps[i];
      if (step.credentials) {
        if (!needsStep(step, previousOf(acc, i))) { acc[i] = { skipped: true }; setAt(i, acc[i]); if (single) break; continue; }
        setWaiting(i);
        return acc;
      }
      setAt(i, { pending: true });
      const result = await runStep(step, { options: optionsRef.current, onPoll: (r) => setAt(i, { ...r, polling: true }) });
      acc[i] = result;
      setAt(i, result);
      if (!result.ok || single) break;
    }
    return acc;
  }, [flow]);

  const runAll = useCallback(async (options = {}) => {
    optionsRef.current = options;
    setBusy(true); setWaiting(-1); setResults([]);
    try { await runFrom(0, []); } finally { setBusy(false); onSettled?.(); }
  }, [runFrom, onSettled]);

  // The playground: execute exactly step i (earlier steps must have run).
  const runOne = useCallback(async (i, options = {}) => {
    optionsRef.current = options;
    setBusy(true); setWaiting(-1);
    try { await runFrom(i, results, { single: true }); } finally { setBusy(false); onSettled?.(); }
  }, [runFrom, results, onSettled]);

  const submitCredentials = useCallback(async ({ username, password }, { single = false } = {}) => {
    const i = waiting;
    if (i < 0) return;
    setBusy(true);
    try {
      setAt(i, { pending: true });
      const result = await runStep(flow.steps[i], { credentials: { username, password } });
      const acc = results.slice(0, i);
      acc[i] = result;
      setAt(i, result);
      // A refused password leaves the flow waiting for another try.
      if (result.ok && result.data?.state === 'credentials_required') return;
      setWaiting(-1);
      if (result.ok && !single) await runFrom(i + 1, acc);
    } finally { setBusy(false); onSettled?.(); }
  }, [waiting, flow, results, runFrom, onSettled]);

  const clear = useCallback(() => { setResults([]); setWaiting(-1); }, []);

  return { flow, results, busy, waiting, runAll, runOne, submitCredentials, clear };
}

// A step's state for its badge.
export function stepState(result, isWaiting) {
  if (isWaiting) return 'waiting';
  if (!result) return 'idle';
  if (result.skipped) return 'skipped';
  if (result.pending || result.polling) return 'running';
  if (!result.ok) return 'error';
  const d = result.data || {};
  if (d.outcome === 'refused' || d.outcome === 'failed' || ['denied', 'expired', 'error'].includes(d.state)) return 'refused';
  return 'done';
}
