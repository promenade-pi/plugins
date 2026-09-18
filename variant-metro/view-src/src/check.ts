// This plugin's gate is the shared layout's own invariant suite — the same
// one the Metro Map plugin runs, which is the point of `metro-layout`: the
// two views can no longer drift apart on geometry.
import 'metro-layout/check';
