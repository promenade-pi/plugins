/**
 * Deterministic ordering for ELK input.
 *
 * OCPN ids are already stable functions of what a node *means* (see
 * `app/src/host/artifact/ocpn.ts`'s module docs: `"t:" + activity`,
 * `"p:" + objectType + ":src"`, …) — this module does not invent new ids, it
 * only fixes the ORDER these already-stable ids are fed to ELK in. Without
 * that, `buildElkGraph` would inherit whatever order the OCPN artifact's own
 * arrays happen to be in — a property of the discovery run, not something
 * this view should depend on to look the same twice.
 */
import type { OcpnArc, OcpnPlace, OcpnPlaceKind, OcpnTransition } from './types';

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const PLACE_ROLE_ORDER: Record<OcpnPlaceKind, number> = { source: 0, normal: 1, sink: 2 };

export function sortedPlaces(places: OcpnPlace[]): OcpnPlace[] {
  return [...places].sort((a, b) =>
    cmp(a.objectType, b.objectType)
    || (PLACE_ROLE_ORDER[a.kind] - PLACE_ROLE_ORDER[b.kind])
    || cmp(a.id, b.id));
}

/** Silent transitions (`activity === null`) sort before labelled ones —
 * arbitrary but fixed; what matters is that it never varies run to run. */
export function sortedTransitions(transitions: OcpnTransition[]): OcpnTransition[] {
  return [...transitions].sort((a, b) =>
    cmp(a.activity ?? '', b.activity ?? '')
    || cmp(a.id, b.id));
}

export function sortedArcs(arcs: OcpnArc[]): OcpnArc[] {
  return [...arcs].sort((a, b) =>
    cmp(a.source.id, b.source.id)
    || cmp(a.target.id, b.target.id)
    || cmp(a.objectType, b.objectType)
    || (Number(a.variable) - Number(b.variable))
    || cmp(a.id, b.id));
}
