import { bootView } from './bootstrap';
import { ViolationsView } from './ViolationsView';
import type { DeclareDiagnostics } from './types';

/** Entry point for the conformance view. */
bootView<DeclareDiagnostics>(
  (v) => Array.isArray(v.constraints) && v.stats && typeof v.stats.conformance === 'number',
  (payload) => <ViolationsView payload={payload} />,
  {
    title: 'No conformance result in memory',
    body: 'This report has no result in memory — a derived artifact is recomputed rather '
      + 'than stored, so a reloaded session has to run the check again.',
  },
);
