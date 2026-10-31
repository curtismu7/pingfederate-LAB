import { useEffect, useReducer } from 'react';

// step -1 = off; 0..total-1 = the step in focus.
export const SPEEDS = [
  { id: 'slow', label: 'Slow', ms: 2400 },
  { id: 'normal', label: 'Normal', ms: 1200 },
  { id: 'fast', label: 'Fast', ms: 500 },
];
export const speedMs = (id) => (SPEEDS.find((s) => s.id === id) ?? SPEEDS[1]).ms;
export const initial = (total) => ({ total, step: -1, paused: false, speed: 'normal' });

export function reduce(s, action) {
  const last = s.total - 1;
  switch (action.type) {
    case 'simulate': return s.total < 1 ? s : { ...s, step: 0, paused: false };
    case 'tick':
      if (s.step < 0 || s.paused) return s;
      return s.step >= last ? { ...s, paused: true } : { ...s, step: s.step + 1 };
    case 'pause': return s.step < 0 ? s : { ...s, paused: true };
    case 'resume': return s.step < 0 ? s : { ...s, step: s.step >= last ? 0 : s.step, paused: false };
    case 'next': return s.step < 0 ? { ...s, step: 0, paused: true } : { ...s, step: Math.min(s.step + 1, last), paused: true };
    case 'prev': return s.step < 0 ? s : { ...s, step: Math.max(s.step - 1, 0), paused: true };
    case 'goto': return s.total < 1 ? s : { ...s, step: Math.max(0, Math.min(action.step, last)), paused: true };
    case 'speed': return SPEEDS.some((x) => x.id === action.speed) ? { ...s, speed: action.speed } : s;
    case 'stop': return { ...s, step: -1, paused: false };
    case 'total': return { ...initial(action.total), speed: s.speed };
    default: return s;
  }
}

export function useStepper(total) {
  const [s, dispatch] = useReducer(reduce, total, initial);
  useEffect(() => {
    if (s.step < 0 || s.paused) return undefined;
    const id = setTimeout(() => dispatch({ type: 'tick' }), speedMs(s.speed));
    return () => clearTimeout(id);
  }, [s.step, s.paused, s.speed]);
  return [s, dispatch];
}
