# Petri Net

React Flow renderer for `AcceptingPetriNet` artifacts.

The view uses the same ELK layered configuration as the **OCPN** viewer:
spline-routed edges with network-simplex layering and placement, two-sided
layer-sweep crossing minimisation, and the same spacing preset. React Flow
supplies panning, zooming, controls and a minimap; ELK remains the sole
authority for node placement and edge routing.

## Flow direction

The one view `param` (Inspector panel) turns the whole net between
left-to-right and top-to-bottom — `elk.direction` is the single key the view
varies on the shared preset, so the two orientations are the same drawing
seen along a different axis. A silent transition's bar turns with it: Petri-net
notation draws that bar across the direction of travel, which is the layer's
axis, not the direction's.

## Accepting Petri-net notation

- An **initial place** has a filled dot token.
- A **final place** has the conventional second, inner circle.
- A place which is both initial and final shows both markings.
- Silent transitions are small filled squares.

There are intentionally no play or stop glyphs: those describe the
object-centric DFG/OCPN boundary presentation, not an accepting Petri net.
There is also no legend, because the standard Petri-net shapes explain the
entire notation without object-type-specific controls.

## Payloads

pm4py results provide `labels`, with `null` for silent transitions. Older
Alpha Miner payloads do not expose their activity labels across the sandbox
boundary, so those transitions retain their stable `#<id>` labels.
