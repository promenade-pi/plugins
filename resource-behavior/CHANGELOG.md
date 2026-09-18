# Changelog

## 0.1.0 — 2026-09-16

- Initial release. Profiles every person in a log: volume, spread of work,
  specialisation, collaboration and batching always; service time, waiting
  time, utilisation, multitasking and workload-dependent speed wherever the
  log records `start` and `complete` separately.
- Uses the host's `activityLifecycle` classifier to recover real work items,
  so durations are measured rather than inferred. On a log with no lifecycle
  the duration metrics are **absent rather than approximated** — the gap since
  the previous event in a case is waiting plus working, and reporting it as
  service time would call a resource slow when the case merely sat in a queue.
- Two views: a profile table with a workload-versus-speed scatter, and a
  workload timeline showing who was busy when.
