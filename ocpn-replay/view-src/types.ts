/**
 * Mirrors `app/src/host/artifact/ocpn.ts`'s `OcpnPayload` contract field for
 * field. This plugin is a separate package with no access to the host's own
 * TypeScript sources across the sandboxed boundary — the same reason
 * `plugins/ocpn-rs/crates/ocpn-core` carries its own copy of this contract
 * in Rust rather than importing it. Keep in sync by hand.
 */

export type OcpnPlaceKind = 'normal' | 'source' | 'sink';

export interface OcpnPlace {
  id: string;
  objectType: string;
  kind: OcpnPlaceKind;
}

export interface OcpnTransition {
  id: string;
  activity: string | null;
  objectTypes: string[];
}

export type OcpnNodeRef =
  | { kind: 'place'; id: string }
  | { kind: 'transition'; id: string };

export interface OcpnArc {
  id: string;
  source: OcpnNodeRef;
  target: OcpnNodeRef;
  objectType: string;
  variable: boolean;
}

export interface OcpnObjectTypeStats {
  places: number;
  transitions: number;
  arcs: number;
  silentTransitions: number;
  variableArcs: number;
  traces: number;
  events: number;
}

export interface OcpnMetadata {
  perObjectType: Record<string, OcpnObjectTypeStats>;
  skippedObjectTypes: Array<{ objectType: string; reason: string }>;
  parameters: { variant: 'IM' | 'IMf'; noiseThreshold: number; objectTypes: string[] };
}

export interface OcpnPayload {
  objectTypes: string[];
  places: OcpnPlace[];
  transitions: OcpnTransition[];
  arcs: OcpnArc[];
  metadata: OcpnMetadata;
}
