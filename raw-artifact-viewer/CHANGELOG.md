# Changelog

## 0.1.1

- The view is labelled **Inspect raw artifact files** (was "Raw files").
- No code change. Note that this view needs a host that serves
  `promenade.files()` / `promenade.openFile()` — the `views[].readsFiles`
  capability. Against an older host the panel stays blank and the frame
  reports `promenade.files is not a function`.

## 0.1.0

First release.

- A per-artifact file tree of what is physically in its OPFS directory —
  Parquet relations (annotated with their logical name where the catalog still
  declares one), the `artifact.json` sidecar, a materialized `payload.json`,
  and anything else present.
- A paginated table for a selected Parquet file: row-number gutter, sticky
  header carrying each column's DuckDB type, page sizes of 50–1000,
  first/prev/next/last, jump-to-row, and per-column visibility toggles that
  narrow the query rather than just the table.
- Parquet footer facts in the header: exact row count, row groups, compression
  codec, writer.
- Non-Parquet files are shown as text, with JSON re-indented — an 800 KB
  sidecar written on one line is otherwise unreadable. A file that is not UTF-8
  is reported as binary rather than rendered as mojibake.
- Uses the host's new `views[].readsFiles` capability
  (`promenade.files()` / `promenade.openFile()`).
- `harness/` stages the bundle into a same-origin page (`npm run harness`) so
  the pagination and column controls can actually be driven and asserted on —
  the sandboxed frame the view ships in accepts no synthetic input.
