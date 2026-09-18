// Mirrors plugin.py's `mine_totem` return shape exactly.

export type Cardinality = '0' | '1' | '0...1' | '1..*' | '0...*';
export type TemporalRelation = 'D' | 'Di' | 'I' | 'Ii' | 'P';

export interface TotemEdgeData {
  source: string;
  target: string;
  lc: Cardinality | null;
  lcInverse: Cardinality | null;
  ec: Cardinality | null;
  ecInverse: Cardinality | null;
  tr: TemporalRelation | null;
  trInverse: TemporalRelation | null;
}

export interface TotemPayload {
  objectTypes: string[];
  edges: TotemEdgeData[];
  parameters?: { tau: number };
  fetchedEvents?: number;
  totalEvents?: number;
  truncated?: boolean;
}
