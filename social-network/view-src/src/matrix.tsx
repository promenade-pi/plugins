import { bootView } from './bootstrap';
import { MatrixView } from './MatrixView';

/** Entry point for the adjacency-matrix view — see `plugin.tsx`. */
bootView((payload) => <MatrixView payload={payload} />);
