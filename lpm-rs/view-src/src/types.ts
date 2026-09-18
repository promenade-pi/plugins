// Mirrors the wire shape `plugins/lpm-rs/src/lib.rs`'s `DiscoverResult`
// serialises (serde `rename_all = "camelCase"` throughout).

export interface Scores {
  support: number;
  confidence: number;
  determinism: number;
  languageFit: number;
  coverage: number;
  avgNumFirings: number;
  numTransitionsScore: number;
  weightedScore: number;
  frequency: number;
  avgFitness: number;
}

export type TreeJson =
  | { op: 'task'; activity: string }
  | { op: 'seq'; children: TreeJson[] }
  | { op: 'xor'; children: TreeJson[] }
  | { op: 'and'; children: TreeJson[] }
  | { op: 'or'; children: TreeJson[] }
  | { op: 'xorLoop'; body: TreeJson };

export interface ResultEntry {
  rank: number;
  tree: TreeJson;
  pretty: string;
  activities: string[];
  scores: Scores;
}

export interface DiscoverStats {
  totalCases: number;
  totalEvents: number;
  distinctActivities: number;
  candidatesScored: number;
  truncatedBySearchBudget: boolean;
}

export interface DiscoverResult {
  entries: ResultEntry[];
  stats: DiscoverStats;
}
