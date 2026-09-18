# Replay semantics

The engine is `run.promenade.ocpn-replay.greedy-token-game` version `1.0.0`.
It processes every event in `(timestamp, event_id)` order. For each related
object whose type exists in the selected OCPN, it keeps an independent marking
initialised at that type's source places. It searches enabled silent moves by
breadth first search, bounded by the user setting, then fires the first
lexicographically ordered enabled transition for the observed activity.

The result is deterministic but intentionally not an optimal object-centric
alignment. Variable arcs are replayed per object binding; no cross-object
token matching or cost-optimal repair is attempted.

`support` is successful relevant bindings / relevant bindings for an event.
Each event row also carries `tsMs`, its epoch-millisecond timestamp.
`logMoves` counts failed relevant bindings (or one for an event with no
model-relevant binding); `modelMoves` counts inserted silent firings. Expected
fields contain only successful bindings. Their mass is descriptive replay
support, not a probability distribution or statistical residual score.

## Animation trace

The evidence carries `net` — the selected OCPN (`OcpnPayload` without its
discovery `metadata`) — so a view can draw the model without a second artifact
input.

When `traceLimit` > 0, the first `traceLimit` events are also emitted as
`trace.frames`, one frame per event: `{ e, t, a, steps }` where each step is a
single token move — `{ o, ot, tr, k: "fire" | "silent" }` for a fired
transition, or `{ o, ot, k: "logmove" }` for a binding the model could not
replay. Markings are never stored: a consumer replays the steps against `net`
from the source-place marking to reconstruct them. `trace.truncated` is true
when the log has more events than `traceLimit`; `stats.tracedEvents` is the
frame count actually emitted (events whose bindings produced no step — an
event with no model-relevant object — contribute no frame).
