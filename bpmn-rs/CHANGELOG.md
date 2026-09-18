# Changelog

## 0.6.1 — 2026-09-17

- **A loop at the root converts to a real workflow net.** The block-structured
  synthesis builds a loop by returning to the place it started from, so a model
  whose *root* is a loop — the Inductive Miner's flower model is one — left the
  net's initial place with incoming arcs. Behaviourally it was fine; formally it
  was not a workflow net at all, and the Soundness Checker was right to refuse
  it (`WF-SOURCE`, `WF-CONNECTED`). The synthesis now brackets the body with a
  silent transition at each end when, and only when, that has happened, so every
  other net stays exactly the size it was.

  Found by the Process Tree Generator's own invariant, which converts every
  generated tree to a Petri net and checks that it is sound: with loops weighted
  at 1 it took three trees to hit.

## 0.6.0 — 2026-09-17

- **Replace OR-joins** — a new action that rewrites inclusive joins into
  exclusive and parallel gateways, so a diagram containing them can be
  converted to a Petri net and analysed. It implements Favre and Völzer's
  *local* replacement (BPM 2012): the join's incoming flows are grouped so each
  group is internally mutually exclusive and the groups are always concurrent,
  giving one exclusive join per group under one parallel join. The two familiar
  cases — every flow exclusive, every flow concurrent — fall out as a plain
  XOR-join and a plain AND-join.

  The relations are derived by symbolic execution over the loop-free skeleton,
  not guessed: each exclusive split is a decision and each flow carries the
  condition under which a token reaches it. A join whose flows cannot be
  grouped has no local replacement at all — the paper is titled the way it is —
  and is left in place with the reason recorded, never relabelled on a guess.
  A loop's merge is handled too, as the one cyclic case whose answer is not in
  doubt.

  Checked by behavioural equivalence over 8,000 randomised diagrams: for every
  combination of decisions, the replacement fires exactly the nodes the
  original did.

- **BPMN → Petri net** no longer needs the diagram to nest. When the
  block-structured synthesis cannot find a fragment tree — which is every model
  a miner not restricted to block structure produces — it falls back to the
  direct mapping of Dijkman, Dumas and Ouyang (IST 2008), Split Miner's own
  reference [18]: a place per sequence flow, a transition per task, one
  synchronising transition per parallel gateway and one per branch of an
  exclusive one. The nicer, smaller synthesis is still tried first; the result
  is a larger net that always exists.

- **BPMN → Petri net** now names every inclusive gateway blocking it and points
  at the new action, instead of reporting only the first one it met.

## 0.5.1 — 2026-09-17

- The "not block-structured" notice now depends on where the diagram came
  from. Its text explained that *the source Petri net* wasn't a sound
  free-choice workflow net, which is simply false over a diagram mined from an
  event log — and with Split Miner producing `Bpmn` artifacts there is now a
  third kind of producer. A converted net keeps the original wording; anything
  else gets one that fits.
- A producer's own `metadata.warnings` are shown whenever there are any. They
  used to ride along with that notice, so a block-structured diagram could
  carry a warning nobody would ever see.

## 0.5.0

Changelog starts here; versions before 0.5.0 were not individually tracked.

BPMN 2.0 support: converts a process tree or a Petri net to a BPMN diagram
and back, imports BPMN 2.0 XML, and ships a React Flow view with BPMN 2.0
XML export. Pure control-flow BPMN only — tasks, start/end events,
exclusive/parallel/inclusive gateways, sequence flows — no pools, lanes,
message flows, sub-processes, or boundary events.
