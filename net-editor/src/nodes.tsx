import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { PlaceMarking } from './model';

/**
 * Place and transition, drawn the way every Petri net has been drawn since
 * 1962: a place is a circle, a transition is a bar. Worth saying because it is
 * the one part of this editor that must not be inventive — an author reading
 * the canvas is reading a notation, not a diagram style.
 */

export interface PlaceData {
  [key: string]: unknown;
  label: string;
  objectType: string | null;
  color: string | null;
  marking: PlaceMarking;
  faulty: boolean;
}

export interface TransitionData {
  [key: string]: unknown;
  label: string;
  silent: boolean;
  colors: string[];
  faulty: boolean;
}

/** Both sides of both node kinds take connections, so an arc can be drawn in
 *  whichever direction the author happens to move. */
function Ports() {
  return (
    <>
      <Handle type="target" position={Position.Left} className="ne-handle" />
      <Handle type="source" position={Position.Right} className="ne-handle" />
    </>
  );
}

export function PlaceNode({ data, selected }: NodeProps) {
  const d = data as PlaceData;
  return (
    <div className={`ne-place${selected ? ' sel' : ''}${d.faulty ? ' faulty' : ''}`}>
      <Ports />
      <div className="ne-place-circle" style={d.color ? { borderColor: d.color } : undefined}>
        {/* The initial marking is a token, which is what a marking *is*; a
            final place gets the double ring accepting nets are drawn with. */}
        {d.marking === 'initial' && <span className="ne-token" style={d.color ? { background: d.color } : undefined} />}
        {d.marking === 'final' && <span className="ne-final-ring" style={d.color ? { borderColor: d.color } : undefined} />}
      </div>
      <div className="ne-node-label">
        {d.label || <em>unnamed</em>}
        {d.objectType && <span className="ne-type-chip" style={{ background: d.color ?? undefined }}>{d.objectType}</span>}
      </div>
    </div>
  );
}

export function TransitionNode({ data, selected }: NodeProps) {
  const d = data as TransitionData;
  return (
    <div className={`ne-transition${selected ? ' sel' : ''}${d.faulty ? ' faulty' : ''}`}>
      <Ports />
      <div className={`ne-transition-bar${d.silent ? ' silent' : ''}`}>
        {/* A transition's object types are a consequence of its arcs, so they
            are shown, never edited: a stripe per type along the bar. */}
        <span className="ne-stripes">
          {d.colors.map((c) => <span key={c} style={{ background: c }} />)}
        </span>
      </div>
      <div className="ne-node-label">{d.silent ? <em>silent</em> : (d.label || <em>unnamed</em>)}</div>
    </div>
  );
}
