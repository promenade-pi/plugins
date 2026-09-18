# How the Inductive Miner works

One idea, applied recursively: **split the activities, split the log the same
way, recurse on the pieces.** Each split becomes one node of a process tree, and
because every split is a construction that is sound by definition, the result is
sound whatever the log looks like.

```
discover(log):
    if a base case applies:  return it
    if a cut is found:       return operator(discover(each sublog))
    otherwise:               fall through
```

## Deriving the relations

Every recursion node rebuilds, in one pass over its sublog:

- the **directly-follows graph** — how often `a` is immediately followed by `b`;
- the **start** and **end** activities, with counts;
- the number of **empty traces**;
- the **minimum self-distance** of each activity: the closest two of its own
  occurrences ever get, and which activities lie between them.

## The four cuts

Each detector partitions the activities. The first that yields at least two
non-empty parts wins, so **the order is part of the algorithm**.

| | Looks for | Becomes |
|---|---|---|
| **Exclusive choice** | the graph falls into disconnected pieces | `×` |
| **Sequence** | pieces that can be ordered so all edges point forward | `→` |
| **Parallel** | pieces with edges in *both* directions between every pair | `∧` |
| **Loop** | a body reachable from every end and returning to every start | `↻` |

Two details that matter more than they look:

**Parallel is tried twice.** The first attempt also keeps together any
activities that sit between the closest repeat of an activity. A loop and a
concurrency produce the same directly-follows graph, and this is what tells them
apart — so it has to be asked *first*, or every small loop reads as parallelism.

**Every parallel branch must be able to start and to finish.** A branch that can
only start, or only end, is not something that can run alongside another; those
get paired up, and anything left over is folded into the first complete branch.
If no branch can do both, there is no parallel cut.

## Splitting the log

Once the activities are split, the log has to follow — and a trace rarely fits
the cut perfectly. Each operator resolves that differently:

- **Exclusive choice** — the trace goes wherever the plurality of its events
  went; the rest of its events are dropped.
- **Sequence** — the trace is cut into consecutive segments, at the positions
  that misplace the fewest events.
- **Parallel** — each branch gets the whole trace, restricted to its own
  activities. A branch that gets nothing gets an empty trace, which is how the
  next level learns the branch is optional.
- **Loop** — the trace is chopped into its runs of body and redo activities,
  each becoming a trace of its own. This is the one split that produces *more*
  traces than it consumed.

## Base cases

| Log | Result |
|---|---|
| no activities | `τ` |
| one activity, once per trace | `a` |
| one activity, repeating | `↻(a, τ)` |
| contains empty traces | `×( discover(rest), τ )` |

## When nothing fits

Four fall-throughs, then a guarantee:

1. **An activity occurring exactly once in every trace** is pulled out in
   parallel — it demonstrably runs alongside everything else.
2. **Leaving one activity out** may let the rest fall into disconnected pieces;
   if so, that activity goes in parallel with the remainder.
3. **A trace that looks like several runs glued together** — an end activity
   immediately followed by a start activity — is cut at the seams and wrapped in
   a loop.
4. The same, **relaxed**: cut before every start activity, provided that
   actually produces more traces.
5. **The flower model**, `↻( ×(a₁ … aₙ), τ )`: any activity, any number of
   times, in any order. It fits everything, which is what makes the recursion
   total — and seeing it in your output means the log had no structure the miner
   could find at that point.

## Infrequent behaviour (IMf)

IMf changes *when* a cut is looked for, not how.

The four detectors run first on the unfiltered graph. Only if all of them fail
is a filtered copy of the graph built — dropping each activity's weakest
outgoing paths, relative to its own strongest — and the same four detectors run
again on that. A log with clean structure never reaches the filter.

Two base cases become threshold-dependent too: a handful of empty traces among
many is read as noise rather than as an optional block, and an activity that
repeats *close* to once per trace is read as a single step rather than a loop.

## Reduction

The discovered tree is then simplified without changing its language: operators
with one child collapse, nested operators of the same kind flatten, redundant
silent steps disappear, and `×(τ, ↻(A, τ))` is folded back into `↻(τ, A)`. This
matters for reading the output — the raw recursion leaves a lot of scaffolding.

## Complexity

The recursion visits each activity set once; the parallel cut is the expensive
detector at O(n²) in the activities of a node, and the "leave out an activity"
fall-through is O(n) connectivity tests. Cost tracks the number of **trace
variants**, not traces, which is why the scan collapses the log first: a log of
200 000 traces over three distinct behaviours costs the same as one with three
traces.
