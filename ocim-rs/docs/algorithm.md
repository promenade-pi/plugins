# Algorithm

OCIM retains the object-centric information that is discarded by a conventional case projection. For each selected object type, the preparation stage creates one ordered lifecycle per object and computes four predicates for every activity/type pair on the original OCEL:

- related: the type appears in every occurrence of the activity;
- divergent: different typed object sets occur for the activity;
- convergent: an occurrence can involve more than one object of the type;
- deficient: the type appears in some but not all occurrences.

The Rust miner calculates directly-follows, start/end, and transitive-closure relations separately for each object type. It then recursively detects sequence, exclusive-choice, parallel, and body/redo loop cuts from those relations, retaining interaction constraints through every split. A single repeated activity is the degenerate loop case; if no strict cut is available, a deterministic sequence fall-through reduces the alphabet so discovery always terminates without dropping events.

The resulting OCPT stores the four type sets on each activity leaf. OCPN conversion projects the tree per related object type, translates each projected block tree to a workflow net, merges visible transitions by activity label, and marks arcs variable for each convergent activity/type pair.

Reference: Niklas van Detten, *Object-Centric Inductive Miner*.
