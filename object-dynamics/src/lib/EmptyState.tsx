/** The one "nothing to show" treatment every Object Dynamics view uses —
 * always says *why*, never a bare blank chart. */
export function EmptyState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="od-empty">
      <div className="od-empty-title">{title}</div>
      {detail && <div className="od-empty-detail">{detail}</div>}
    </div>
  );
}
