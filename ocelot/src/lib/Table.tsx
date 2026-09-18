import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  render: (row: T) => ReactNode;
}

/**
 * A plain paginated table shell — the parent owns fetching (current page's
 * rows + total count), this only renders what it's given plus the pager
 * controls. Never receives more than one page of rows at a time: that's the
 * whole point of every view built on this being real `LIMIT`/`OFFSET`
 * paging rather than an in-memory array like Ocelot's own `v-data-table`.
 */
export function PaginatedTable<T>({
  columns, rows, rowKey, total, page, pageSize, onPageChange, loading, emptyMessage,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  loading?: boolean;
  emptyMessage?: string;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);

  return (
    <div>
      <div className="oc-table-wrap">
        <table className="oc-table">
          <thead>
            <tr>{columns.map((c) => <th key={c.key}>{c.label}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((c) => <td key={c.key}>{c.render(row)}</td>)}
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={columns.length}><div className="oc-empty">{emptyMessage ?? 'No rows.'}</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="oc-pager">
        <span>{loading ? 'Loading…' : total === 0 ? '0 rows' : `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`}</span>
        <span className="oc-toolbar-spacer" />
        <button className="oc-btn" disabled={page <= 0} onClick={() => onPageChange(0)}>«</button>
        <button className="oc-btn" disabled={page <= 0} onClick={() => onPageChange(page - 1)}>‹</button>
        <span>Page {page + 1} / {pageCount}</span>
        <button className="oc-btn" disabled={page >= pageCount - 1} onClick={() => onPageChange(page + 1)}>›</button>
        <button className="oc-btn" disabled={page >= pageCount - 1} onClick={() => onPageChange(pageCount - 1)}>»</button>
      </div>
    </div>
  );
}
