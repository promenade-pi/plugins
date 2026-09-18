# Changelog

## 0.1.0

First release.

- **Generate a process tree** — a random `ProcessTree` drawn from
  PTandLogGenerator's parameters: size from a triangular distribution, operators
  from five weights, silent steps and duplicate labels by probability, all from
  one seed.
- Silent steps are placed only where they change what the model does: as a
  branch of a choice, or as a loop's repeat part.
- Nested operators of the same kind are folded (`→(a, →(b, c))` becomes
  `→(a, b, c)`), which changes no behaviour and is the difference between a tree
  a person can read and a staircase.
- **Executable invariants** gating the package: the payload is a well-formed
  tree (indices in range, every node reached exactly once, operators with the
  arity their meaning requires); the size, silence and duplication are what was
  asked for; the same parameters give the same tree; and every generated tree is
  converted — through `bpmn-core` and checked with `soundness-core`, two other
  plugins' crates — to a **sound** workflow net.
- Statistics carry the operator mix, depth, distinct activities and the seed, so
  a generated benchmark can describe itself.

### Host requirement

Needs the host's `"standalone": true` action flag (Promenade ≥ the change that
added it to `app/src/host/plugins/manifest.ts`): an action with no input
artifact and no file to read is otherwise refused as a forgotten `inputs`. The
action appears in the artifact tree's **New** menu.
