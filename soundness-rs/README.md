# Soundness Checker

Takes an accepting Petri net and answers the question every discovery plugin
leaves open: **can you trust this model?**

Promenade can mine a Petri net six ways, convert one from BPMN or a process
tree, import one from PNML and draw one by hand — and until now nothing checked
whether the result was a workflow net, whether it deadlocks, or whether it
contains transitions that can never fire. Inductive Miner guarantees soundness
by construction; Alpha Miner, Heuristics Miner, a BPMN conversion and a
hand-drawn net guarantee nothing at all.

## What it checks

**Structure** — the workflow-net requirements (van der Aalst, 1998): exactly
one source place, exactly one sink place, and every place and transition on
some path between them. Plus the things that are not disqualifying but are
nearly always mistakes: a transition with no input place, one with no output
place, a place connected to nothing.

**Behaviour** — the three classical soundness requirements, decided on the
net's reachable markings:

| | |
|---|---|
| **Can always finish** | From every reachable marking, the final marking is still reachable. |
| **Finishes cleanly** | No reachable marking holds the final marking *and* something else. |
| **No dead transitions** | Every transition is enabled in some reachable marking. |

plus **boundedness**, which is a precondition of the other three: a net whose
tokens can grow without limit is never sound.

## Every failure carries a witness

A verdict on its own is not actionable. Each behavioural failure is reported
with the **shortest firing sequence from the initial marking that produces it**,
and the view replays that sequence onto the net: the offending places and
transitions are highlighted, the steps are numbered in firing order, and the
places show the marking as it is at the moment things go wrong — which, for a
deadlock, is precisely "where the tokens are when everything stops".

The two textbook failures look like this:

- an **XOR-split joined by an AND-join** takes one branch and then waits
  forever for the other → *reachable deadlock*;
- an **AND-split joined by an XOR-join** marks the sink while the other branch
  is still running → *completes with tokens left over*.

## What it will not do

It will not say "unsound" on evidence it does not have. If the state space
exceeds the configured limit the verdict is **undecided**, and the report says
which requirements were left undecided and which were actually settled by a
counterexample it did find. A truncated search can still prove a net unsound —
a deadlock it reached is genuinely reachable — but it can never prove one
sound.

Unboundedness is *proven*, not guessed: the search reports the firing sequence
that covers an earlier marking while strictly adding tokens, and that sequence
can be replayed. See [docs/algorithm.md](docs/algorithm.md) for why this
terminates on any net.

## Scope

Accepting Petri nets. Object-centric Petri nets are not checked: there is no
single agreed notion of soundness for an OCPN, and inventing one silently
would be worse than saying so.

## Building

```bash
./package.sh
```

`wasm-pack` builds the kernel, `view-src` builds the sandboxed view, and
`cargo test --release` runs the invariants first — 20,000 randomised nets, an
independent reference implementation, and every reported witness replayed
against the net it came from. A failing invariant blocks packaging.
