import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { LayoutNode } from './types.ts';

/**
 * React Flow mounts a custom edge only for nodes that expose handles, even
 * when the edge draws its own precomputed geometry and never consults them.
 */
const HANDLE = { width: 1, height: 1, opacity: 0, border: 'none' } as const;

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} style={HANDLE} />
      <Handle type="source" position={Position.Bottom} style={HANDLE} />
    </>
  );
}

export interface ActivityNodeData {
  node: LayoutNode;
  types: Array<{ name: string; color: string }>;
  trunkColor: string | null;
  selected: boolean;
  dimmed: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

export function ActivityNode({ data }: NodeProps & { data: ActivityNodeData }) {
  const { node, theme, trunkColor } = data;
  const border = data.selected ? theme.accent : (trunkColor ?? theme.border);
  return (
    <div
      title={node.label ?? node.id}
      style={{
        width: node.width, height: node.height, boxSizing: 'border-box',
        padding: '5px 8px', borderRadius: 6,
        // A trunk node is outlined in its object type's colour and drawn
        // heavier: the backbone is meant to be the first thing read.
        border: `${trunkColor || data.selected ? 2 : 1}px solid ${border}`,
        background: data.selected ? theme['accent-soft'] : theme.bg,
        color: theme.text, fontSize: 11, overflow: 'hidden', cursor: 'pointer',
        opacity: data.dimmed ? 0.28 : 1,
        boxShadow: data.selected ? `0 0 0 2px ${theme.accent}33` : undefined,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1,
      }}
    >
      <Handles />
      <div style={{
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        fontWeight: trunkColor ? 600 : 500, lineHeight: 1.2,
      }}>
        {node.label}
      </div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, color: theme['text-dim'],
        fontSize: 9.5, lineHeight: 1.2,
      }}>
        {node.count != null && <span>{node.count.toLocaleString()}</span>}
        <span style={{ display: 'flex', gap: 2, marginLeft: 'auto' }}>
          {data.types.slice(0, 6).map((type) => (
            <span
              key={type.name} title={type.name}
              style={{ width: 6, height: 6, borderRadius: '50%', background: type.color }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

export interface BoundaryNodeData {
  node: LayoutNode;
  color: string;
  dimmed: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

export function BoundaryNode({ data }: NodeProps & { data: BoundaryNodeData }) {
  const { node, color, theme } = data;
  const isStart = node.kind === 'start';
  return (
    <div
      title={`${node.objectType} ${isStart ? 'start' : 'end'}`}
      style={{
        width: node.width, height: node.height, boxSizing: 'border-box',
        borderRadius: '50%', background: isStart ? color : theme.bg,
        border: `${isStart ? 2 : 4}px solid ${color}`,
        opacity: data.dimmed ? 0.28 : 1,
      }}
    >
      <Handles />
    </div>
  );
}

export interface VirtualNodeData {
  node: LayoutNode;
  color: string;
  dimmed: boolean;
  [key: string]: unknown;
}

/**
 * A routing node. Hidden by default: it is a layout artefact, not part of the
 * process. Showing it is how you see what the rank assignment actually did —
 * it is [2] Fig. 11's own diagnostic view.
 */
export function VirtualNode({ data }: NodeProps & { data: VirtualNodeData }) {
  return (
    <div
      title={`routing node (${data.node.objectType}, rank ${data.node.rank})`}
      style={{
        width: data.node.width, height: data.node.width, borderRadius: '50%',
        background: data.color, opacity: data.dimmed ? 0.2 : 0.85,
      }}
    >
      <Handles />
    </div>
  );
}
