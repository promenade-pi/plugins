/** The `DeclareModel` payload, as `declare-core`'s `discover` writes it. */
export interface DeclareModel {
  activities: string[];
  constraints: Constraint[];
  stats: {
    constraints: number;
    candidates: number;
    pruned: number;
    dropped: number;
    activities: number;
    traces: number;
    events: number;
    minSupport: number;
    minConfidence: number;
  };
}

export interface Constraint {
  template: string;
  activities: string[];
  sentence: string;
  support: number;
  confidence: number;
  activations: number;
  violations: number;
}

/** The `DeclareDiagnostics` payload, as `declare-core`'s `Checker` writes it. */
export interface DeclareDiagnostics {
  constraints: CheckedConstraint[];
  cases: Array<{ case: number; violated: number[] }>;
  unknownActivities: string[];
  unconstrainedActivities: string[];
  unknownTemplates: string[];
  stats: {
    constraints: number;
    traces: number;
    conforming: number;
    violating: number;
    conformance: number;
    violations: number;
    events: number;
    activities: number;
    inactiveConstraints: number;
  };
}

export interface CheckedConstraint {
  template: string;
  activities: string[];
  sentence: string;
  activations: number;
  violations: number;
  violationRate: number;
  unknownActivity: boolean;
}

/**
 * The template families, for grouping and colour.
 *
 * Kept in the same order the kernel's parameters are in, so a reader who
 * turned a family off in the Inspector finds the same word here.
 */
export const FAMILY_OF: Record<string, string> = {
  existence: 'single activity',
  absence: 'single activity',
  exactlyOne: 'single activity',
  init: 'single activity',
  end: 'single activity',
  respondedExistence: 'ordering',
  response: 'ordering',
  precedence: 'ordering',
  succession: 'ordering',
  altResponse: 'alternating',
  altPrecedence: 'alternating',
  altSuccession: 'alternating',
  chainResponse: 'immediate',
  chainPrecedence: 'immediate',
  chainSuccession: 'immediate',
  notCoExistence: 'never',
  notSuccession: 'never',
  notChainSuccession: 'never',
};

/** The symbol DECLARE's own notation uses, where it has a short one. */
export const SYMBOL_OF: Record<string, string> = {
  existence: '1..∗',
  absence: '0',
  exactlyOne: '1',
  init: 'init',
  end: 'end',
  respondedExistence: '•——',
  response: '•—▸',
  precedence: '——▸',
  succession: '•—▸•',
  altResponse: '•=▸',
  altPrecedence: '==▸',
  altSuccession: '•=▸•',
  chainResponse: '•≡▸',
  chainPrecedence: '≡≡▸',
  chainSuccession: '•≡▸•',
  notCoExistence: '‖',
  notSuccession: '—∦▸',
  notChainSuccession: '≡∦▸',
};

export function familyColour(template: string, theme: Record<string, string>): string {
  switch (FAMILY_OF[template]) {
    case 'single activity': return theme.accent ?? '#4c6ef5';
    case 'ordering': return theme.ok ?? '#2f9e44';
    case 'alternating': return theme.warn ?? '#e8590c';
    case 'immediate': return theme.experimental ?? '#7c3aed';
    case 'never': return theme.danger ?? '#c92a2a';
    default: return theme['text-dim'] ?? '#697386';
  }
}
