import { useState } from 'react';
import type { TreeNode } from './tree';
import { fmtBytes } from './format';

/**
 * The artifact's directory, drawn the way a file explorer draws one.
 *
 * Directories are collapsible even though artifact directories are flat
 * today — the listing is recursive, so this must not be the thing that has to
 * change the day an artifact keeps a subdirectory.
 */
export function FileTree({ nodes, selected, onSelect }: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (path: string) =>
    setCollapsed((c) => ({ ...c, [path]: !c[path] }));

  const rows = (list: TreeNode[], depth: number): React.ReactNode[] =>
    list.flatMap((node) => {
      const isDir = node.kind === 'directory';
      const shut = !!collapsed[node.path];
      const row = (
        <button
          key={node.path}
          type="button"
          className={`raw-row${isDir ? ' dir' : ''}${node.path === selected ? ' sel' : ''}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          onClick={() => (isDir ? toggle(node.path) : onSelect(node.path))}
          title={node.path}
        >
          <span className="raw-caret">{isDir ? (shut ? '▶' : '▼') : ''}</span>
          <span className={`raw-glyph ${glyphOf(node)}`}>{glyphTextOf(node)}</span>
          <span className="raw-name">
            {node.name}
            {node.logical ? <span className="raw-logical"> · {node.logical}</span> : null}
          </span>
          <span className="raw-size">{fmtBytes(node.size)}</span>
        </button>
      );
      return isDir && !shut ? [row, ...rows(node.children, depth + 1)] : [row];
    });

  return <div className="raw-tree">{rows(nodes, 0)}</div>;
}

function glyphOf(node: TreeNode): string {
  if (node.kind === 'directory') return 'folder';
  if (node.name.endsWith('.parquet')) return 'parquet';
  if (node.name.endsWith('.json')) return 'json';
  return 'other';
}

function glyphTextOf(node: TreeNode): string {
  if (node.kind === 'directory') return '▤';
  if (node.name.endsWith('.parquet')) return 'PQ';
  if (node.name.endsWith('.json')) return '{}';
  return '·';
}
