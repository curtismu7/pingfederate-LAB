import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, Background, BaseEdge, Controls, getBezierPath, Handle, Position, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { loadDiagram } from './diagrams/index.js';
import { useStepper, SPEEDS } from './stepper.js';

// Renders diagram-studio/1 data: a named static diagram (`id`) or one built from a live trace (`diagram`).
// Boxes are movable; Reset puts every box back and stops the walkthrough; Simulate walks the steps at the chosen speed.
export function usePositions(diagram) {
  const original = useMemo(() => Object.fromEntries(diagram.nodes.map((n) => [n.id, { x: n.x, y: n.y }])), [diagram]);
  const [positions, setPositions] = useState(original);
  useEffect(() => { setPositions(original); }, [original]);
  const move = useCallback((id, position) => setPositions((p) => ({ ...p, [id]: position })), []);
  const reset = useCallback(() => setPositions(original), [original]);
  return { positions, move, reset, original };
}

// Reset: every box back to the data's position, the walkthrough stopped, and the view re-fitted (zoom and pan).
export function resetDiagram({ reset, dispatch, instance }) {
  reset();
  dispatch({ type: 'stop' });
  instance?.fitView?.();
}

// Arrows run left to right (out on the right, in on the left). An arrow that points back to the left uses the hidden
// "back" handles, out on the left and in on the right, a little lower, so it neither loops around both boxes nor lies
// on top of the arrow going the other way. Same rule as diagram-studio's canvas.
function BoxNode({ data }) {
  return (
    <div className={`dg-node dg-${data.color}`}>
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Left} id="back-out" className="handle-back" isConnectable={false} />
      <strong>{data.label}</strong>
      {data.sub.map((line, i) => <span key={`${i}-${line}`}>{line}</span>)}
      <Handle type="source" position={Position.Right} id="out" />
      <Handle type="target" position={Position.Right} id="back-in" className="handle-back" isConnectable={false} />
    </div>
  );
}
const nodeTypes = { box: BoxNode };

// The default curve, with its label moved by data.labelShift so a request and its response between the same two
// boxes do not print their labels on top of each other.
function Arrow({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, ...rest }) {
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  return <BaseEdge path={path} labelX={labelX} labelY={labelY + (data?.labelShift || 0)} {...rest} />;
}
const edgeTypes = { arrow: Arrow };

// Arrows that join the same two boxes, in either direction, are spread LABEL_GAP px apart; a lone arrow keeps 0.
const LABEL_GAP = 24;
export function labelShifts(edges) {
  const groups = new Map();
  edges.forEach((e, i) => { const k = [e.source, e.target].sort().join('\u0000'); (groups.get(k) || groups.set(k, []).get(k)).push(i); });
  const shifts = edges.map(() => 0);
  for (const ids of groups.values()) ids.forEach((i, k) => { shifts[i] = (k - (ids.length - 1) / 2) * LABEL_GAP; });
  return shifts;
}

export function toFlow(diagram, positions, activeEdges, simulating) {
  const nodes = diagram.nodes.map((n) => ({
    id: n.id,
    type: 'box',
    position: positions[n.id] ?? { x: n.x, y: n.y },
    data: { label: n.label, sub: n.sub ?? [], color: diagram.groups[n.group]?.color ?? 'grey' },
  }));
  const x = new Map(nodes.map((n) => [n.id, n.position.x]));
  const shifts = labelShifts(diagram.edges);
  const edges = diagram.edges.map((e, i) => {
    const on = activeEdges.has(i);
    const back = x.get(e.target) < x.get(e.source);
    return {
      id: `e${i}`,
      type: 'arrow',
      source: e.source,
      sourceHandle: back ? 'back-out' : 'out',
      targetHandle: back ? 'back-in' : 'in',
      target: e.target,
      label: e.label,
      animated: on,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: `${on ? 'edge-on' : simulating ? 'edge-dim' : ''}${e.dashed ? ' edge-dashed' : ''}`,
      style: { strokeWidth: on ? 3 : 1.5, ...(e.dashed ? { strokeDasharray: '6 4' } : {}) },
      data: { labelShift: shifts[i] },
    };
  });
  return { nodes, edges };
}

export default function DiagramView({ id, diagram: given, heading = 'h3' }) {
  const diagram = useMemo(() => given ?? loadDiagram(id), [given, id]);
  const { positions, move, reset } = usePositions(diagram);
  const [s, dispatch] = useStepper(diagram.steps?.length ?? 0);
  useEffect(() => { dispatch({ type: 'total', total: diagram.steps?.length ?? 0 }); }, [diagram, dispatch]);

  const flowRef = useRef(null);
  const doReset = useCallback(() => resetDiagram({ reset, dispatch, instance: flowRef.current }), [reset, dispatch]);
  const step = s.step >= 0 ? diagram.steps[s.step] : null;
  const active = useMemo(() => new Set(step?.edges ?? []), [step]);
  const { nodes, edges } = useMemo(() => toFlow(diagram, positions, active, s.step >= 0), [diagram, positions, active, s.step]);
  const onNodesChange = useCallback((changes) => {
    for (const change of changes) if (change.type === 'position' && change.position) move(change.id, change.position);
  }, [move]);
  const H = heading;

  return (
    <section className="diagram" aria-label={diagram.title}>
      <H className="dg-title">{diagram.title}</H>
      {diagram.lede && <p className="lede">{diagram.lede}</p>}
      <div className="dg-toolbar" role="group" aria-label={`${diagram.title}: diagram controls`}>
        <button type="button" className="primary" onClick={() => dispatch({ type: 'simulate' })}>Simulate</button>
        <button type="button" onClick={() => dispatch({ type: 'prev' })}>Back</button>
        <button type="button" onClick={() => dispatch({ type: 'next' })}>Next</button>
        {/* Pause only means something while a walkthrough is playing. */}
        {s.paused
          ? <button type="button" onClick={() => dispatch({ type: 'resume' })}>Resume</button>
          : <button type="button" onClick={() => dispatch({ type: 'pause' })} disabled={s.step < 0}>Pause</button>}
        <button type="button" onClick={doReset}>Reset diagram</button>
        <label className="inline">Speed
          <select value={s.speed} onChange={(e) => dispatch({ type: 'speed', speed: e.target.value })}>
            {SPEEDS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
          </select>
        </label>
      </div>
      <div className="dg-canvas" data-testid="diagram-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          nodesDraggable
          nodesConnectable={false}
          onInit={(instance) => { flowRef.current = instance; }}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
        >
          <Background />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      {step && <p className="dg-now" role="status"><strong>{step.title}.</strong> {step.what}</p>}
    </section>
  );
}
