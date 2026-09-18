import { bootView } from './bootstrap';
import { TimelineView } from './TimelineView';

/** Entry point for the workload heatmap — see `plugin.tsx`. */
bootView((payload) => <TimelineView payload={payload} />);
