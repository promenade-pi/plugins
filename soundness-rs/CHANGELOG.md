# Changelog

## 0.1.0 — 2026-09-17

First release.

- **Check soundness** on an accepting Petri net: the workflow-net structural
  requirements, then the three classical soundness requirements plus
  boundedness, decided exactly on the reachability graph.
- Every behavioural failure carries the shortest firing sequence from the
  initial marking that produces it.
- Unboundedness is proven by the Karp–Miller covering test rather than assumed
  from a budget, so the search terminates on any net.
- A search stopped by the state limit reports **undecided**, never "unsound":
  it can convict on a counterexample it reached, never acquit.
- **Soundness** view — the net in React Flow with the selected finding's places
  and transitions highlighted, its firing sequence numbered on the transitions,
  and the witness marking drawn in the places.
