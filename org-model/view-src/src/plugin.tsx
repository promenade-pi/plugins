import { bootView } from './bootstrap';
import { OrgModelView } from './OrgModelView';

/** Entry point for the organisational-model view. */
bootView((payload) => <OrgModelView payload={payload} />);
