import { Handle, Position, type NodeProps } from '@xyflow/react';

export interface TaskNodeData {
  label: string;
  selected: boolean;
  theme: Record<string, string>;
  [key: string]: unknown;
}

const handleStyle = { width: 1, height: 1, opacity: 0, border: 'none' } as const;

export function TaskNode({ data }: NodeProps & { data: TaskNodeData }) {
  return (
    <div
      title={data.label}
      style={{
        width: '100%', height: '100%', boxSizing: 'border-box',
        borderRadius: 8, border: `1.5px solid ${data.selected ? data.theme.accent : data.theme.border}`,
        background: data.selected ? data.theme['bg-soft'] : data.theme.bg,
        boxShadow: data.selected ? `0 0 0 2px ${data.theme.accent}` : undefined,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '4px 10px', textAlign: 'center', cursor: 'pointer',
        fontSize: 12, color: data.theme.text, lineHeight: 1.25,
        overflow: 'hidden',
      }}
    >
      <Handle type="target" position={Position.Left} style={handleStyle} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as any }}>
        {data.label}
      </span>
      <Handle type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}
