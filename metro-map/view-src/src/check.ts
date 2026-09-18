// This plugin's gate: the shared layout's own invariant suite first (the
// same one every consumer of `metro-layout` runs), then the Logistics
// fixture, which exercises that layout through *this* plugin's complexity
// filter and so belongs here rather than in the package.
import 'metro-layout/check';
import './logistics.check';
