# Fuzzy Miner

Günther & van der Aalst's Fuzzy Miner (BPM 2007), for case-centric event logs,
as a Rust/WebAssembly kernel plus a React Flow view with the original's slider
rail.

Most discovery algorithms answer "what is the process?". On a *less-structured*
log — healthcare, service desks, anything where people improvise — that
question has no good answer, and the model you get back is the spaghetti
picture. The Fuzzy Miner answers a different question: **which parts of this
log matter enough to draw, and at what level of detail?** It measures the log
from several perspectives, keeps every measurement, and then lets you simplify
interactively until the diagram says something.

## What the action produces

`Fuzzy Miner` turns a Traditional Event Log into a **Fuzzy Model** — not a
control-flow model, but the complete weighted graph the simplification runs on:

- **unary significance** per activity, from its frequency and its *routing*
  behaviour (a rare activity that decides where the process goes is significant
  even though it is rare);
- **binary significance** per ordered activity pair, from the attenuated
  frequency of the relation and its *distance* significance;
- **binary correlation** per ordered pair, from how close in time the two
  events are, how similar their activity names are, and how similar their
  `org:resource` values are.

Relations are counted up to the **maximal event distance** — 5 by default, so an
activity two or three steps later still contributes, attenuated by how far away
it is. That is what lets the miner see through interleaved noise that a plain
directly-follows count would take at face value.

## What the view does

`Fuzzy graph` draws the model and carries the filter chain, live, on a vertical
slider rail — a collapsible side panel down the right of the view rather than a
card floating over the diagram, so nothing on the canvas is ever hidden behind
it. The same three stages and the same defaults as the original:

1. **Resolve concurrency.** Where A and B relate in both directions, decide
   whether that is real concurrency (both kept), one direction plus noise (the
   weaker dropped), or noise both ways (both dropped).
2. **Filter edges.** Rank each activity's own relations against each other and
   keep everything within the cutoff of its best — *per activity*, so a quiet
   corner of the process is thinned rather than silenced.
3. **Aggregate nodes.** Activities below the significance cutoff are folded
   into clusters with whatever they correlate with most; clusters that only
   touch other clusters merge; a cluster of one is dissolved and the path
   around it redrawn.

Blue squares are activities, green octagons are clusters — click one to see
what went inside. Edge thickness carries the relation's combined weight, and its
ink darkens with significance.

## Where the algorithm lives

The metric extraction is in Rust (`src/lib.rs`), because it is the part that
touches every event. The filter chain is in TypeScript
(`view-src/src/filters.ts`), because it is a pure O(n²) transformation of a
model that already sits in the frame — which is what makes dragging a slider
instant instead of a round trip. `docs/algorithm.md` has the details, including
the two metrics that are not implemented and why.

## Building

```bash
./package.sh
```

Runs the Rust unit tests, builds the wasm kernel, runs the filter chain's
invariant checks over 400 randomised models, builds the view bundle, and zips
the `.pmplugin`.

## Citation

Günther, C.W., van der Aalst, W.M.P. (2007). *Fuzzy Mining – Adaptive Process
Simplification Based on Multi-Perspective Metrics.* Business Process Management
(BPM 2007), LNCS 4714, pp. 328–343.
