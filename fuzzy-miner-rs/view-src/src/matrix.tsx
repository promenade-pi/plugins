import { bootView } from './bootstrap';
import { MatrixView } from './MatrixView';

/**
 * Entry point for the "Fuzzy metrics" view — a separate sandboxed bundle
 * from `plugin.tsx`'s "Fuzzy graph", both registered against `FuzzyModel` in
 * the manifest. Two views rather than a tab inside the graph view: each opens
 * as its own panel with its own place in the artifact tree's Views list,
 * exactly like Provenance or a saved script does today, and each keeps its
 * own params (`views[].ownsControls`) rather than the two competing for one
 * param namespace.
 */
bootView((payload) => <MatrixView payload={payload} />);
