/** The `LogSkeleton` payload, as `log-skeleton-core`'s `discover` writes it. */
export interface LogSkeleton {
  activities: string[];
  constraints: Constraint[];
  counts: ActivityCounts[];
  stats: {
    constraints: number; candidates: number; activities: number; traces: number;
    events: number; noise: number; equivalence: number; alwaysBefore: number;
    alwaysAfter: number; neverTogether: number; directlyFollows: number; dropped: number;
  };
}

export interface Constraint {
  relation: string;
  activities: string[];
  sentence: string;
  support: number;
  violations: number;
}

export interface ActivityCounts {
  activity: string;
  counts: number[];
  covered: number;
  dropped: number;
}

/** The `LogSkeletonDiagnostics` payload. */
export interface SkeletonDiagnostics {
  constraints: CheckedConstraint[];
  cases: Array<{ case: number; violated: number[] }>;
  unknownActivities: string[];
  unconstrainedActivities: string[];
  unknownRelations: string[];
  stats: {
    constraints: number; traces: number; fitting: number; nonFitting: number;
    fitness: number; violations: number; events: number; activities: number; countRules: number;
  };
}

export interface CheckedConstraint {
  relation: string;
  activities: string[];
  sentence: string;
  violations: number;
  violationRate: number;
  unknownActivity: boolean;
}

/** The label each relation goes by in the paper, for grouping and colour. */
export const RELATION_LABEL: Record<string, string> = {
  equivalence: 'equivalence',
  alwaysBefore: 'always before',
  alwaysAfter: 'always after',
  neverTogether: 'never together',
  directlyFollows: 'directly follows',
  count: 'how often',
};

export const RELATION_SYMBOL: Record<string, string> = {
  equivalence: '=',
  alwaysBefore: '◀—',
  alwaysAfter: '—▶',
  neverTogether: '‖',
  directlyFollows: '≡▶',
  count: '#',
};

export function relationColour(relation: string, theme: Record<string, string>): string {
  switch (relation) {
    case 'equivalence': return theme.accent ?? '#2563eb';
    case 'alwaysBefore': return theme.ok ?? '#15803d';
    case 'alwaysAfter': return theme.ok ?? '#15803d';
    case 'neverTogether': return theme.danger ?? '#d64550';
    case 'directlyFollows': return theme.experimental ?? '#7c3aed';
    case 'count': return theme.warn ?? '#b7791f';
    default: return theme['text-dim'] ?? '#6b7280';
  }
}
