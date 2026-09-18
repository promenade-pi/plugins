export interface RelationshipRef {
  objectId: string;
  objectType?: string;
  qualifier?: string | null;
}

/** Chip cloud for an O2O/E2O relation list — each chip shows the related
 * object's ID, its qualifier as a hover tooltip, and navigates to that
 * object's detail on click when its type is known (matching Ocelot's own
 * `objectRoute` chip behaviour). */
export function RelationshipChips({ items, onOpen }: {
  items: RelationshipRef[];
  onOpen?: (objectId: string, objectType: string) => void;
}) {
  if (items.length === 0) return <span style={{ color: 'var(--text-dim)' }}>—</span>;
  return (
    <div className="oc-chip-cloud">
      {items.map((r, i) => {
        const clickable = !!onOpen && !!r.objectType;
        return (
          <span
            key={`${r.objectId}:${i}`}
            className={`oc-chip${clickable ? ' oc-chip-clickable' : ''}`}
            title={r.qualifier ? `qualifier: ${r.qualifier}` : undefined}
            onClick={clickable ? () => onOpen!(r.objectId, r.objectType!) : undefined}
          >
            {r.objectId}
          </span>
        );
      })}
    </div>
  );
}
