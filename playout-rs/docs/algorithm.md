# Algorithm

## The timed token game

The classical token game fires a transition atomically: its input tokens are
consumed and its output tokens produced in the same instant. That is everything
a reachability question needs and exactly wrong for generating a log, because a
log records *work*, and work takes time.

So a transition here is a duration. One case runs as:

```
loop:
  marking == final and nothing running   -> the case is complete
  some transition enabled                -> start one: consume its inputs,
                                            schedule its completion, record it
  otherwise, something running           -> advance the clock to the earliest
                                            completion and produce its outputs
  otherwise                              -> deadlock
```

Starting a transition does **not** advance the clock. After an AND-split both
branches are enabled at the same instant, so both start there and then run
concurrently; two transitions in conflict cannot both start, because the first
to start has already taken the token. A silent transition takes no time at all —
it is routing the model needed and the business did not, and letting it consume
service time would stretch every duration in the log by however many taus the
miner that produced the net happened to insert.

### Why the log is still the model's behaviour

Two claims, both checked by `crates/playout-core/tests/invariants.rs` rather
than asserted here.

**The transitions in start order are a firing sequence of the untimed net.** At
the moment a transition starts, its input tokens are present in the engine's
marking, and that marking is pointwise no larger than the classical one — the
classical net has already produced what is here still in flight. So whatever is
enabled in the engine is enabled classically.

**The completion order is a firing sequence too.** Two executions that overlap
in time used disjoint tokens: the second started while the first was holding
its inputs and had produced nothing, so neither consumed what the other
produced, and they commute. Two executions that do *not* overlap complete in the
order they started. The completion order is therefore a linearisation of the
same partial order the start order linearises — a Mazurkiewicz trace
equivalence, which firing sequences are closed under.

That second claim is the one the log rests on, because the log is written in
completion order.

## Stochastic mode

- **Case arrivals**: a Poisson process — exponentially distributed gaps with the
  configured mean, starting from a fixed Monday morning (2025-01-06T08:00:00Z),
  so weekday and hour-of-day distributions in a generated log are the ones a
  reader expects rather than an artefact of the Unix epoch having been a
  Thursday.
- **Choices**: uniform over the transitions enabled at that moment. Not a
  stochastic net: branch probabilities are not part of an `AcceptingPetriNet`,
  and inventing a skew would be less honest than an even one.
- **Service times**: exponential, one mean for every activity.
- **Cut-off**: a case that fires `maxLength` transitions without finishing is
  truncated. This is what makes a loop the walk never leaves terminate.

## Extensive mode

Depth-first over markings, in transition-index order, collecting the firing
sequences that reach the final marking. Two firing sequences are the same
*trace* when their visible label sequences are equal, so silent routing and
duplicate labels collapse the way they do in the log.

Three budgets: the longest firing sequence, how many distinct traces to keep,
and how many markings to expand. `languageExhausted` on the resulting log's
statistics says whether all three held. A truncated enumeration is still a set
of real traces — it is just no longer the whole language, and a caller comparing
two models has to know which it got.

Timestamps for an enumerated trace are assigned sequentially rather than
concurrently: the enumeration fixed the order, so that is the only order these
executions are known to be valid in, and overlapping them would assert a
concurrency nothing established.

## Resources

`groups = min(pool size, activity count)`. Activity *k*, in order of first
appearance in the net, is served by group `k % groups`; resource *r* belongs to
group `r % groups`. With a pool smaller than the activity count the groups are
shared, which is what a small team is.

Resources are drawn from a separate stream, seeded from the same seed, so
turning the pool on does not change the traces or their timing — the control
flow of a simulation is not supposed to depend on who was staffed.

## Randomness

xoshiro256\*\*, seeded through SplitMix64, implemented in the crate. Two
properties are needed and neither requires a dependency: the same seed must give
the same log on every machine and every build (a dependency that changed its
algorithm in a minor release would break a published benchmark silently), and it
has to compile to wasm with nothing behind it.

## A note on parameter names

The host substitutes the *input artifact's* `meta` for any action parameter of
the same name (`wasmActionRuntime` in `app/src/host/plugins/runtimeAdapters.ts`)
— a deliberate rule that lets a plugin trust what produced its input over a
stale parameter. A discovered Petri net's `meta` records `traces`, `variants`,
`activities` and `cases` about the log it was mined from, so this plugin's
parameters are called `caseCount` and `traceLimit`: a parameter named `traces`
would be silently overwritten with the source log's trace count while the
control still showed what the user chose.

## What this is not

- Not a fitted simulation model. Rozinat et al. mine arrival rates, duration
  distributions and resource availability from a log; this generates all four
  from three numbers.
- No queueing: a resource never blocks work, so utilisation is descriptive
  rather than constraining.
- No object-centric play-out: one case is one instance of one model.
