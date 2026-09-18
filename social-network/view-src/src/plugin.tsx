import { bootView } from './bootstrap';
import { GraphView } from './GraphView';

/**
 * Entry point for the node-link view. Its sibling `matrix.tsx` draws the same
 * artifact as an adjacency matrix — two panels rather than a tab inside one,
 * so each keeps its own place in the tree's Views list and its own params.
 */
bootView((payload) => <GraphView payload={payload} />);
