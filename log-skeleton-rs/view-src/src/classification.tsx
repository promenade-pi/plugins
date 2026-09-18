import { bootView } from './bootstrap';
import { ClassificationView } from './ClassificationView';
import type { SkeletonDiagnostics } from './types';

/** Entry point for the classification view. */
bootView<SkeletonDiagnostics>(
  (v) => Array.isArray(v.constraints) && v.stats && typeof v.stats.fitness === 'number',
  (payload) => <ClassificationView payload={payload} />,
  {
    title: 'No classification in memory',
    body: 'This report has no result in memory — a derived artifact is recomputed rather '
      + 'than stored, so a reloaded session has to run the check again.',
  },
);
