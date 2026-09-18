export interface AcceptingPetriNetPayload {
  places: unknown[];
  activities: number[];
  labels?: Array<string | null>;
  place_to_transition?: Array<[number, number]>;
  transition_to_place?: Array<[number, number]>;
  initial_marking?: number[];
  final_marking?: number[];
}

export interface ReplayEvent {
  caseId: string;
  transitionId: number;
  timestamp?: number | null;
  sequence: number;
  silent?: boolean;
  deviation?: boolean;
}

export interface ReplayPayload {
  model: AcceptingPetriNetPayload;
  events: ReplayEvent[];
  timeline: { start: number; end: number; sourceSpanMs: number; durationMs: number; hasTiming?: boolean };
  stats: { cases: number; events: number; alignedEvents: number; deviations: number; meanFitness: number; truncated?: boolean; fallbackCases?: number; alignment?: string };
  method?: { name: string; exact: boolean; note: string };
}

export interface Point { x: number; y: number; }
export interface Section { startPoint: Point; bendPoints?: Point[]; endPoint: Point; }
export interface ElkResult {
  children?: Array<{ id: string; x: number; y: number; width: number; height: number }>;
  edges?: Array<{ id: string; sections?: Section[] }>;
}

export interface Arc { id: string; source: string; target: string; }
