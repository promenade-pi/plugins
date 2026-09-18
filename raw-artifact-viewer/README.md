# Raw Artifact Viewer

Looks at an artifact the way its storage does.

Every other view in Promenade shows an artifact through an interpretation of
it — a Petri net, a metro map, a dotted chart. When one of those looks wrong,
the next question is whether the *storage* is wrong, and until now nothing in
the app could answer it. This view can: on the left, the files physically
present in the artifact's OPFS directory; on the right, for a selected Parquet
file, its rows.

```
artifacts/a_mtqijl9_r0kp3          event.parquet   35,372 rows · 3 cols · 228 KB · 1 row group · ZSTD
  artifact.json      3.0 KB        ┌───┬──────────┬──────────────────────┬─────────────────────┐
  e2o.parquet      367 KB          │ # │ event_id │ activity             │ ts                  │
  event_attr.par…  138 B           │ 1 │ reg_co1  │ Register Customer O… │ 2023-05-22 11:54:42 │
  event.parquet    228 KB  ◀       │ 2 │ reg_co2  │ Register Customer O… │ 2023-05-22 18:33:30 │
  o2o.parquet       49 KB          └───┴──────────┴──────────────────────┴─────────────────────┘
  object.parquet    31 KB          «  ‹  1–100 of 35,372  ›  »       [Jump to row] [Go] [100 ▾]
```

## What it shows that nothing else does

The file list comes from the storage, not from the catalog, and the two are
not the same list:

- `artifact.json` — the **sidecar**: this artifact's own catalog record and the
  executions that produced it, written beside its data so a lost catalog can be
  reconstructed from the directories.
- `payload.json` — a **materialized inline payload**, for an artifact whose
  value is a structure rather than a table.
- `<relation>.parquet` — the artifact's relations. A file whose relation the
  catalog still declares is annotated with its logical name (`· event`); one
  that is **not** annotated is on disk without being declared, which is
  normally the interesting case.

For a Parquet file the header reports what the file itself says: row count and
row-group count from its footer, the compression codec its column chunks
actually use, and the writer that produced it.

## Fidelity

Cell values are cast to `VARCHAR` **in the query**, so DuckDB — the thing that
read the file — is what renders them. That is deliberate:

- every type works, including `DECIMAL`, `LIST`, `STRUCT`, `BLOB` and nested
  combinations of them, rather than only the types a hand-written formatter
  happened to cover;
- a `TIMESTAMP` is shown as the file's reader resolves it, with no unit guessed
  at on the plugin side of the sandbox boundary — which is exactly the class of
  bug this view is for finding;
- `event.parquet` resolves to the **file**, not to the classifier-applied view
  the rest of the app queries. Raw has to mean raw.

Only visible columns are selected, so hiding columns on a wide file makes the
query cheaper, not just the table narrower.

## What it needs from the host

The manifest declares `views[].readsFiles: true`, which is what entitles the
frame to call `promenade.files()` and `promenade.openFile(path)`. Both are
scoped by the *host* to the artifact the panel is bound to; a path is the only
thing this plugin gets to name, and the host rejects any path that is not a
plain relative name inside that one directory. Files are read-only — there is
no write door here, declared or otherwise.

## Building

```bash
./package.sh
```

Bundles `src/` into one classic-script IIFE (the sandboxed frame evals a single
file) and zips it with the manifest into `dist/`.

## Verifying it

The shipped view runs in a sandboxed, opaque-origin iframe: a driver's clicks
never reach it and `read_page` sees none of its content, so an in-app
screenshot can show that the panel renders and nothing more. `harness/` stages
the *same* bundle into an ordinary same-origin page, wired to the *same*
`dataClient` — real worker handlers, real DuckDB relations, real Parquet files;
only the frame boundary is missing.

```bash
npm run harness     # then open /__raw-harness/index.html on the app's dev server
npm run harness:rm  # remove it again — never leave it staged in a build
```

The page exposes `window.__probe()` (the tree rows, header chips, column
headers, the visible rows, the footer range) and `window.__click(sel, text)`,
so pagination, jump-to-row and the column toggles can be asserted on rather
than eyeballed. That is how the one real bug in this view was found: hiding a
column while a page was in flight left the rows one column wider than the
header for a single render, which is a crash and not a glitch — rows and the
columns they were fetched for are now one piece of state.
