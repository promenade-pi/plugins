/**
 * Mirrors `app/src/host/artifact/bpmn.ts`'s `BpmnPayload` contract field for
 * field. This plugin is a separate package with no access to the host's own
 * TypeScript sources across the sandboxed boundary — the same reason
 * `plugins/bpmn-rs/crates/bpmn-core` carries its own copy of this contract
 * in Rust rather than importing it. Keep in sync by hand.
 */

export type BpmnNodeKind =
  | 'task'
  | 'startEvent'
  | 'endEvent'
  | 'exclusiveGateway'
  | 'parallelGateway'
  | 'inclusiveGateway';

export interface BpmnNode {
  id: string;
  kind: BpmnNodeKind;
  label: string | null;
}

export interface BpmnFlow {
  id: string;
  source: string;
  target: string;
  label?: string | null;
}

export interface BpmnMetadata {
  sourceType: 'AcceptingPetriNet' | 'ProcessTree' | 'import' | null;
  structured: boolean;
  warnings: string[];
}

export interface BpmnPayload {
  nodes: BpmnNode[];
  flows: BpmnFlow[];
  metadata: BpmnMetadata;
}
