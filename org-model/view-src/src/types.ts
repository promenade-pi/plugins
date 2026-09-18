/** The `OrganizationalModel` payload, as `src/lib.rs` serialises it. */

export interface Role {
  id: number;
  label: string;
  members: number[];
  size: number;
  events: number;
  cases: number;
  /** `[activity index, share of the group's events]`, strongest first. */
  profile: Array<[number, number]>;
  cohesion: number;
  separation: number;
}

export interface Merge {
  /** Cluster ids: below `resources.length` these are people, above they are
   *  earlier merges — merge `i` creates id `resources.length + i`. */
  a: number;
  b: number;
  distance: number;
  size: number;
}

export interface OrgModelPayload {
  sourceMetric: string;
  /** `roles` or `units` — the word this model's groups deserve. */
  grouping: string;
  method: string;
  linkage: string;
  cutBy: string;
  cut: number;
  resources: string[];
  activities: string[];
  roles: Role[];
  roleOf: number[];
  merges: Merge[];
  stats: {
    resources: number;
    roles: number;
    singletons: number;
    largestRole: number;
    meanSilhouette: number;
    meanCohesion: number;
    sparsity: number;
  };
}

/** Singular noun for one group, in this model's terms. */
export function groupNoun(grouping: string): string {
  return grouping === 'units' ? 'unit' : 'role';
}
