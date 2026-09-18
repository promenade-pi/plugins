/** The `SoundnessReport` payload, as `crates/soundness-core/src/report.rs`
 *  serializes it. Field names are kept identical on purpose — one rename on
 *  either side and the view silently renders an empty diagnosis. */

/** The net echoed inside the report, in `AcceptingPetriNet`'s own field
 *  names, so `layout.ts` is the unmodified renderer other Petri-net views use. */
export interface AcceptingPetriNetPayload {
  places: unknown[];
  activities: number[];
  labels?: Array<string | null>;
  place_to_transition?: Array<[number, number]>;
  transition_to_place?: Array<[number, number]>;
  initial_marking?: number[];
  final_marking?: number[];
}

export type Verdict = 'sound' | 'unsound' | 'inconclusive';
export type Outcome = 'pass' | 'fail' | 'unknown';
export type Severity = 'error' | 'warning' | 'info';

export interface Situation {
  marking: Array<[number, number]>;
  trace: number[];
  steps: string[];
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  places: number[];
  transitions: number[];
  witness: Situation | null;
}

export interface SoundnessReport {
  net: AcceptingPetriNetPayload;
  summary: {
    verdict: Verdict;
    headline: string;
    isWorkflowNet: boolean;
    bounded: Outcome;
    optionToComplete: Outcome;
    properCompletion: Outcome;
    noDeadTransitions: Outcome;
    errors: number;
    warnings: number;
  };
  structure: {
    placeCount: number;
    transitionCount: number;
    silentTransitionCount: number;
    arcCount: number;
    sourcePlaces: number[];
    sinkPlaces: number[];
    disconnectedPlaces: number[];
    disconnectedTransitions: number[];
    freeChoice: boolean;
    stateMachine: boolean;
    markedGraph: boolean;
  };
  behaviour: {
    exploration: 'complete' | 'truncated' | 'unbounded';
    states: number;
    finalReachable: boolean | null;
    deadTransitions: number[];
    deadlocks: Situation[];
    livelocks: Situation[];
    improperCompletions: Situation[];
    unbounded: { prefix: number[]; pump: number[]; steps: string[]; growingPlaces: number[] } | null;
  };
  findings: Finding[];
  warnings: string[];
}

/** The four requirements, in the order the report states them. */
export const REQUIREMENTS: Array<{ key: keyof SoundnessReport['summary']; label: string; hint: string }> = [
  { key: 'bounded', label: 'Bounded', hint: 'No marking can accumulate tokens without limit.' },
  { key: 'optionToComplete', label: 'Can always finish', hint: 'From every reachable marking, the final marking is still reachable.' },
  { key: 'properCompletion', label: 'Finishes cleanly', hint: 'No reachable marking holds the final marking plus something else.' },
  { key: 'noDeadTransitions', label: 'No dead transitions', hint: 'Every transition is enabled in some reachable marking.' },
];
