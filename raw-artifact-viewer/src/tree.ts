import type { ArtifactFileEntry } from './promenade';

/**
 * The flat path list turned into the shape it is drawn in.
 *
 * The host answers with paths, not a tree, because a path is what identifies
 * a file to `openFile()` — the nesting is a presentation concern, and doing it
 * here keeps the boundary answering with facts rather than with layout.
 */
export interface TreeNode {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  size: number;
  logical?: string;
  children: TreeNode[];
}

export function buildTree(entries: ArtifactFileEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const e of entries) {
    const node: TreeNode = {
      path: e.path, name: e.name, kind: e.kind, size: e.size, logical: e.logical, children: [],
    };
    byPath.set(e.path, node);
    const cut = e.path.lastIndexOf('/');
    const parent = cut < 0 ? null : byPath.get(e.path.slice(0, cut));
    // A child whose parent directory was not listed (it cannot happen with the
    // host's own walk, but a truncated listing would) is shown at the root
    // rather than dropped: a file the viewer knows about must be reachable.
    (parent ? parent.children : roots).push(node);
  }

  const size = (node: TreeNode): number =>
    node.kind === 'file' ? node.size : node.children.reduce((sum, c) => sum + size(c), 0);
  for (const node of byPath.values()) if (node.kind === 'directory') node.size = size(node);

  return roots;
}

/** Total bytes of everything listed. */
export function totalBytes(entries: ArtifactFileEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.kind === 'file' ? e.size : 0), 0);
}

/**
 * What to show before the user has picked anything.
 *
 * The event table if there is one, otherwise the biggest Parquet file,
 * otherwise the only file there is — opening on an empty pane when the
 * artifact plainly has one obvious thing in it (an inline result keeps
 * nothing but its sidecar) is a click that never had a reason to exist.
 */
export function defaultSelection(entries: ArtifactFileEntry[]): string | null {
  const files = entries.filter((e) => e.kind === 'file');
  const parquet = files.filter((e) => e.name.endsWith('.parquet'));
  if (!parquet.length) return files.length === 1 ? files[0].path : null;
  const event = parquet.find((e) => e.logical === 'event');
  if (event) return event.path;
  return parquet.reduce((biggest, e) => (e.size > biggest.size ? e : biggest)).path;
}
