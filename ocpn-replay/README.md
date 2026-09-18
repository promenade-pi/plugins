# OCEL/OCPN Replay

`Replay OCEL on OCPN` consumes one complete timestamped OCEL and one concrete
OCPN, then produces `ObjectCentricReplayEvidence` for Interaction Atlas.

The bundled **Replay animation** view draws the net and plays the token game
back step by step — during the run as a live preview, and afterwards as a
scrubbable replay. It reads `net` and `trace` from the evidence (see
`docs/semantics.md`); `traceLimit` bounds how many events the trace covers.

It is an object-bound greedy token replay, not an optimal alignment. Each
event-object relation for a modelled object type is replayed against that
object's own marking. The event's `support` is the fraction of those bindings
that can execute the observed activity. Failed bindings become `logMoves`;
bounded, automatically fired silent transitions become `modelMoves`.

The action rejects logs with missing timestamps and refuses to emit evidence
for a capped prefix. Thus `replay.completed` means the evidence covers the
whole selected source OCEL in deterministic `(timestamp, event id)` order.

It also writes an expected interaction field per observed model-supported type
pair. This is a replayed-event, model-conditioned field: only pairs with two
successful bindings contribute, using the Atlas's fixed lifecycle phase and
equal-event-mass convention. It is not a generated stochastic simulation.
