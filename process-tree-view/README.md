# Process Tree View

Draws a `ProcessTree` artifact: operator nodes, activity leaves and silent
(tau) steps, in the operator notation pm4py prints.

## Why this is its own plugin

It could have been bundled with the Inductive Miner, which is what produces
the trees in the example workspace. It is not, on purpose.

A viewer bundled with one producer disappears when that producer is removed,
and every other tree-producing plugin — a different inductive variant, a
converter, an importer — would have to ship its own copy. The agreement is
with the **artifact type**, not with the miner: `ProcessTree` is registered by
the host, this plugin declares it consumes one, and the Inductive Miner
declares it produces one. Neither knows the other exists.

The Inductive Miner does `recommend` this package in its manifest, which is a
hint for the plugin manager, not a dependency: the miner works without it, and
this viewer works with any other producer.

## The payload contract

```json
{
  "root": 0,
  "nodes": [
    { "operator": "sequence", "label": null, "children": [1, 2] },
    { "operator": null, "label": "Create order", "children": [] },
    { "operator": null, "label": null, "children": [] }
  ],
  "activities": ["Create order"],
  "stats": { "nodes": 3, "leaves": 2, "silent": 1, "operators": 1 }
}
```

`operator` is one of `sequence`, `xor`, `parallel`, `loop`, `or`,
`interleaving`, `partialorder`, or `null` for a leaf. A leaf with
`label: null` is a silent step.

## Parameters

| Parameter | Effect |
|---|---|
| Orientation | Lays the tree out top-down or left-to-right. |
| Show silent steps | Hides tau leaves. They carry no activity but do change the language of the model, so they are shown by default. |
| Compact spacing | Tightens the gaps for large trees. |

## Isolation

Runs in the host's sandboxed frame with an opaque origin: no host DOM, no
storage, no credentialed network, no panel handle. Activity colours come from
the host's colour registry, so an activity has the same colour here as in
every other panel. Clicking a leaf publishes into the host's selection
vocabulary.
