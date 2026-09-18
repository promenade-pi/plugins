export interface RelationRef {
  objectId: string;
  objectType: string;
  qualifier: string | null;
}

export interface RelatedEvent {
  eventId: string;
  activity: string;
  ts: string;
}

/** A screen within this one plugin panel's own client-side router — Object
 * Detail is not a separate manifest view (a plugin has no API to ask the
 * host to open one for a specific record), so list <-> detail is just
 * internal React state, the same way Ocelot's own SPA router works. */
export type Screen =
  | { mode: 'list' }
  | { mode: 'detail'; objectType: string; objectId: string; tab: 'overview' | 'timeline' | 'relations' };
