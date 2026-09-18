# Object-Centric Inductive Miner

Rust implementation of the Object-Centric Inductive Miner (OCIM).

It provides two composable actions:

- `OCEL → Object-Centric Process Tree` mines one block-structured process tree while retaining each activity's related, divergent, convergent, and deficient object types.
- `Object-Centric Process Tree → Object-Centric Petri Net` projects that tree to each object type and merges equally-labelled transitions into an OCPN. Convergent activity/type pairs become variable arcs.

The relational preparation stage is internal. It projects one lifecycle per object for the Rust scan and retains interaction-pattern facts from the original event-object relation, which cannot be reconstructed after projection.
