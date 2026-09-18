import { bootView } from './bootstrap';
import { RulesView } from './RulesView';
import type { DeclareModel } from './types';

/** Entry point for the DECLARE model view. */
bootView<DeclareModel>(
  (v) => Array.isArray(v.constraints) && Array.isArray(v.activities),
  (payload) => <RulesView payload={payload} />,
  {
    title: 'No model in memory',
    body: 'This DECLARE model has no result in memory — a derived artifact is recomputed '
      + 'rather than stored, so a reloaded session has to run the discovery again before '
      + 'this view can list anything.',
  },
);
