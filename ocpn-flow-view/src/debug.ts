/**
 * Development-only diagnostics — never shown in the normal UI.
 *
 * `serializeElkInputForDebug` dumps the canonical ELK input (post-sort, the
 * exact order `buildElkGraph` used) in a deterministic text form, so two
 * renders of what should be the same OCPN can be diffed directly instead of
 * eyeballing two screenshots. There is no test runner in this package (the
 * other example view plugins are hand-written JS with no build step at
 * all — see `README.md`'s "Building" section), so this is the practical
 * substitute for an automated determinism test: call it twice across a
 * reload and diff the two strings by hand.
 */
import type { OcpnPayload } from './types';
import { sortedArcs, sortedPlaces, sortedTransitions } from './canonical';

export function serializeElkInputForDebug(net: OcpnPayload): string {
  const lines: string[] = [];
  lines.push('NODES');
  let i = 0;
  for (const p of sortedPlaces(net.places)) {
    lines.push(`  [${i++}] place id=${p.id} objectType=${p.objectType} role=${p.kind}`);
  }
  for (const t of sortedTransitions(net.transitions)) {
    lines.push(`  [${i++}] transition id=${t.id} activity=${t.activity ?? '(silent)'} objectTypes=${t.objectTypes.join(',')}`);
  }
  lines.push('EDGES');
  i = 0;
  for (const a of sortedArcs(net.arcs)) {
    lines.push(`  [${i++}] arc id=${a.id} ${a.source.id} -> ${a.target.id} objectType=${a.objectType} variable=${a.variable}`);
  }
  return lines.join('\n');
}

export function logVersions(): void {
  // eslint-disable-next-line no-console
  console.debug('[ocpn-flow-view] elkjs 0.12.0, @xyflow/react 12.11.3');
}
