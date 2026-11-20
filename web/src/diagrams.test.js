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
  it('an arrow pointing back to the left uses the back handles, and every arrow gets a label item for the kit', async () => {
    const { toFlow, toLabelItems } = await import('./DiagramView.jsx');
    const d = { groups: {}, nodes: [{ id: 'a', label: 'A', x: 0, y: 0 }, { id: 'b', label: 'B', x: 300, y: 0 }], edges: [{ source: 'a', target: 'b', label: 'go' }, { source: 'b', target: 'a', label: 'back' }] };
    const flow = toFlow(d, { a: { x: 0, y: 0 }, b: { x: 300, y: 0 } }, new Set(), false);
    const [fwd, back] = flow.edges;
    expect([fwd.sourceHandle, fwd.targetHandle]).toEqual(['out', 'in']);
    expect([back.sourceHandle, back.targetHandle]).toEqual(['back-out', 'back-in']);
    // A box dragged past the other flips the arrows with it.
    const [moved] = toFlow(d, { a: { x: 600, y: 0 }, b: { x: 300, y: 0 } }, new Set(), false).edges;
    expect(moved.sourceHandle).toBe('back-out');
    // One kit label item per arrow, on the right handles.
    const items = toLabelItems(d, flow.edges, new Set());
    expect(items.map((it) => [it.sourceHandle, it.targetHandle, it.text])).toEqual([['out', 'in', 'go'], ['back-out', 'back-in', 'back']]);
  });
});
