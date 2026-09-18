/** The accepting-net payload exposed across the sandboxed view boundary. */
export interface AcceptingPetriNetPayload {
  places: unknown[];
  activities: number[];
  /** pm4py labels, indexed by transition id; `null` denotes a tau transition. */
  labels?: Array<string | null>;
  place_to_transition?: Array<[number, number]>;
  transition_to_place?: Array<[number, number]>;
  initial_marking?: number[];
  final_marking?: number[];
}

