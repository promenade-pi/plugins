import { bootView } from './bootstrap';
import { SkeletonView } from './SkeletonView';
import type { LogSkeleton } from './types';

/** Entry point for the log skeleton view. */
bootView<LogSkeleton>(
  (v) => Array.isArray(v.constraints) && Array.isArray(v.activities) && Array.isArray(v.counts),
  (payload) => <SkeletonView payload={payload} />,
  {
    title: 'No skeleton in memory',
    body: 'This log skeleton has no result in memory — a derived artifact is recomputed '
      + 'rather than stored, so a reloaded session has to run the discovery again before '
      + 'this view can list anything.',
  },
);
