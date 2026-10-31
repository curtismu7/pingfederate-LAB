import { describe, it, expect } from 'vitest';
import { DIAGRAM_IDS, loadDiagram, CARD_DIAGRAM } from './diagrams/index.js';
import { validateDiagram } from './diagrams/validate.js';
import { FLOW_IDS } from './flows.js';

describe('named diagrams (diagram-studio/1 data)', () => {
  it('every diagram passes the studio validator', () => {
    for (const id of DIAGRAM_IDS) expect([id, validateDiagram(loadDiagram(id))]).toEqual([id, []]);
  });
  it('every runnable card has its named diagram', () => {
    for (const id of FLOW_IDS.filter((x) => x !== 'discovery')) expect(DIAGRAM_IDS).toContain(CARD_DIAGRAM[id]);
  });
  it('an unknown name is refused', () => {
    expect(() => loadDiagram('nope')).toThrow(/Unknown diagram/);
  });
});

describe('arrows between the same boxes', () => {
  it('spread their labels apart, and an arrow pointing back to the left uses the back handles', async () => {
    const { labelShifts, toFlow } = await import('./DiagramView.jsx');
    expect(labelShifts([{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'b', target: 'a' }])).toEqual([-12, 0, 12]);
    const d = { groups: {}, nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }, { id: 'b', label: 'B', x: 300, y: 0 }], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }] };
    const [fwd, back] = toFlow(d, { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }, new Set(), false).edges;
    expect([fwd.sourceHandle, fwd.targetHandle, fwd.data.labelShift]).toEqual(['out', 'in', -12]);
    expect([back.sourceHandle, back.targetHandle, back.data.labelShift]).toEqual(['back-out', 'back-in', 12]);
    // A box dragged past the other flips the arrows with it.
    const [moved] = toFlow(d, { a: { x: 600, y: 0 }, b: { x: 300, y: 0 } }, new Set(), false).edges;
    expect(moved.sourceHandle).toBe('back-out');
  });
});
