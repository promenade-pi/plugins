import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface EventNodeData {
  kind: 'startEvent' | 'endEvent';
  selected: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;

/** Standard BPMN notation: a thin circle for a start event, a thick one for
 * an end event. */
export function EventNode({ data }: NodeProps & { data: EventNodeData }) {
  const thick = data.kind === 'endEvent';
  return (
    <div
      title={thick ? 'End event' : 'Start event'}
      style={{
        width: '100%', height: '100%', borderRadius: '50%', boxSizing: 'border-box',
        border: `${thick ? 3 : 1.5}px solid ${data.selected ? data.theme.accent : data.theme.text}`,
        background: data.selected ? data.theme['bg-soft'] : data.theme.bg,
        boxShadow: data.selected ? `0 0 0 2px ${data.theme.accent}` : undefined,
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}
