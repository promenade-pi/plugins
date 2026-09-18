# Method, and what came from where

Two papers by the same authors describe this layout, and the plugin needs
both. This page records which step comes from which, how the two relate, and
every place the papers leave something open that an implementation cannot.

- **[1]** D. Lee, M. Song, W.M.P. van der Aalst. *Layouting Object-Centric
  Directly Follows Graphs.* BPM 2025, LNBIP 564, pp. 204–220.
- **[2]** D. Lee, M. Song, W.M.P. van der Aalst. *An optimized backbone-based
  process layout generation method using integer programming and heuristics
  to enhance user comprehension.* Data & Knowledge Engineering 164 (2026)
  102601. Received 14 Nov 2025, accepted 20 Mar 2026.
- Reference implementation of [2]: <https://github.com/deoksanglee/BackboneLayoutIP>
  (Python + Gurobi).

## How the two papers relate

They are **siblings, not a sequence**. Both extend the backbone-based process
layout of Mennens et al. (Comput. Graph. Forum 38(3), 2019), and each extends
it along a different axis:

- **[1] extends the scope.** It carries the backbone idea from a single
  case-centric DFG to an OC-DFG: one axis per object type, an incremental
  merge that decides the axis order, a cost function that wants the axis
  distances between types to mirror how much they share, and crossing
  minimisation restricted to within an axis. Its layout core is comparatively
  simple — a linear precedence penalty, and node positioning taken over from
  the earlier study.
- **[2] extends the depth.** It stays on the single-log DFG and rebuilds the
  core: a squared precedence penalty, horizontal edges for mutually dependent
  pairs, virtual-node generation, component balancing as a second integer
  program, and a node-positioning step that keeps the backbone a straight
  line. It adds a 27-participant user study and a five-log quantitative
  evaluation.

The journal article is therefore **not an extension of the OC-DFG paper**. It
does not cite it — its reference list runs from Sugiyama and Gansner through
Mennens, Celonis and UiPath, with no entry for [1] — it never mentions object
types, and its evaluation is on five case-centric logs (BPI 2017/2018/2019,
a hospital log, a web log). Both are chapters of the same doctoral work (the
first author's PhD is dated 2026 at POSTECH), and the shared lineage shows in
the rank-assignment model: [1] Eqs. 1–9 and [2] Eqs. 1–7 are recognisably the
same formulation, with [2]'s the more developed of the two.

What *is* true, and is what this plugin is built on, is that [2] is the
mature version of exactly the layout core that [1]'s per-object-type step
needs. Combining them is not speculation about a future paper; it is putting
[1]'s object-centric structure on top of [2]'s repaired core, and it is the
combination that neither paper published.

| Concern | [1] (OC-DFG) | [2] (journal) | Used here |
| --- | --- | --- | --- |
| Scope | OC-DFG, per-type axes | single DFG | [1] |
| Rank penalty | `Σ freq(e)·α_e + y_e`, linear | `Σ α_e² + r_end`, squared | [2] by default, [1] selectable |
| Horizontal edges | not treated | allowed for mutual pairs | [2] |
| Virtual nodes | not treated | Defs. 12–13 | [2], per typed arc |
| Component balancing | not treated | integer program, Eqs. 8–10 | [2], per object type |
| Backbone straightness | per-type `packcutBN` (Alg. 2) | Def. 20, one backbone | both |
| Axis order | Defs. 2–8, incremental merge | — | [1] |
| Crossing minimisation | same-axis swaps only (Alg. 1) | Gansner transpose | [1] |
| Metrics | 7, incl. two object-centric | 6 | union of both |
| Evaluation | 7 OCELs vs. a web tool | 5 logs vs. Mennens + user study | — |

## The pipeline, step by step

| Step | Source | `plugin.py` |
| --- | --- | --- |
| 1. Typed graph, per-type start/end nodes | [1] §3.1 | `build_graph` |
| 2. Backbone per object type | [1] §3.2, [2] Def. 11 | `determine_backbones` |
| 3. Rank assignment (integer program) | [1] Eqs. 1–9, [2] Eqs. 1–7 | `_rank_ip` |
| 4. Virtual node generation | [2] §5.4, Defs. 12–13 | `generate_virtual_nodes` |
| 5. Components and balancing | [2] §5.5, Def. 8, Eqs. 8–10 | `_components`, `_balance_ip` |
| 6. Initial order | [2] Def. 14 | `local_layouts` |
| 7. Object type axis merge | [1] §3.5, Defs. 2–8 | `merge_axes` |
| 8. Crossing minimisation | [1] §3.6, Alg. 1 | `minimize_crossings` |
| 9. Node positioning | [1] Alg. 2, [2] §5.7, Defs. 16–21 | `Positioner` |
| 10. Metrics | [1] §4.3, [2] Def. 23 | `compute_metrics` |

### The squared penalty, without a quadratic solver

`α_p = max(0, r_u − r_v + 1)` is a pair's precedence violation: 0 downward, 1
horizontal, `d+1` for a `d`-rank rise. [2] minimises `Σ α_p²`, and the square
is the point — it makes one two-rank violation (cost 4) dearer than two
one-rank violations (cost 2), which is what pulls a mutually dependent pair
onto a single rank instead of merely adjacent ranks.

HiGHS takes no quadratic objective, so the square is linearised **exactly**
rather than approximated: `α_p = Σ_k s_{p,k}` over `K_p` binary unit
segments with segment cost `2k−1`. The cheapest `k` segments then sum to
exactly `k²`, and since the costs increase the solver always fills a prefix —
no ordering constraints are needed and no optimum is lost.

`K_p` also bounds `α_p`, and hence how far pair `p` may rise. It starts at
four segments and is quadrupled only for the pairs actually sitting at their
bound, re-solving until none does. On graphs where nothing rises far the
binary count stays near `4|P|`; where something does, it grows only there.

## Where the papers leave a choice, and what was chosen

Each of these is a decision an implementation has to make and the papers do
not. They are all visible in the output — parameters, or reported in the
view's diagnostics — rather than buried.

1. **The backbone cannot come from the most frequent variant.** Both papers
   take it from the log's most frequent variant. An OC-DFG is an aggregate:
   its variants are not recoverable from it, since directly-follows counts do
   not say which traces produced them. [2] Def. 5 explicitly permits other
   reference paths ("the most frequent sequence of activities, the longest
   path, or a user-selected reference path"), so two graph-level substitutes
   are offered: a greedy walk always taking the busiest unvisited successor
   (`modal`, the default) and a beam search for the heaviest simple path
   (`heaviest`).

2. **Per-type backbone chains can contradict each other.** This is not
   discussed in [1], and it makes its Eq. 7 infeasible rather than merely
   tight: two object types may traverse the same two shared activities in
   opposite orders, and then no rank assignment satisfies both chains. Chains
   are therefore admitted greedily, largest type first, and a constraint that
   would close a cycle with those already admitted is dropped — and reported,
   with the arc named, in the view's diagnostics. Without this the program is
   simply infeasible on such a graph.

3. **A trunk cannot pass through a node another trunk already claimed.**
   [1] Alg. 2 runs `packcutBN` once per object type, which for a shared
   backbone activity means the last type processed wins and the earlier
   trunks are left bent. Two rules make this explicit instead. A node belongs
   to the trunk of whichever type claimed it first. And a trunk is straight
   only over the nodes **its own merge step introduced** — which is [1] §3.5
   step 3's own rule, that a node already positioned keeps its position. A
   backbone activity an earlier type placed is still drawn and marked as this
   type's backbone; it is just not forced onto its column, because two
   straight lines cannot both pass through one point.

4. **A trunk needs at most one node per rank.** Follows from (2): once a
   chain constraint is dropped the backbone is no longer rank-monotone, its
   arcs' rank spans overlap, and their virtual nodes collide on a rank. Two
   nodes on a rank must be separated, so no single x exists. The straight
   trunk is therefore taken as the rank-monotone part of the backbone plus
   the routed interiors whose ranks are still free.

5. **The axis-insertion width is off by one in the paper.** [1] §3.5 step 3
   shifts existing nodes right by `w = max − min` of the inserted layout's
   orders, which is one less than the column count Fig. 3 illustrates it with
   and would overlap the inserted block with the one it displaced. Here the
   shift is the full column count and unoccupied columns are then removed,
   which reproduces Fig. 3's outcome — a shared node consumes no new column —
   without depending on which reading was meant.

6. **`left(G,R,O,n)` is read as "the nearest node to the left".** [2]
   Def. 18 asks for the node whose order is exactly one less. After the axis
   merge a rank frequently has no node at `order − 1`, and the literal
   reading would leave such a node unconstrained and free to slide past a
   nearer neighbour.

7. **Packing needs a separation guarantee the three moves do not give.**
   `packcut` only enforces a node's left margin when it finds a gap to close,
   and `packcutBN` moves a whole trunk right, which can push into whatever
   sits to its right. A final sweep moves nodes right until the required
   separation holds, moving each trunk as one rigid group so straightness
   survives; moves are only ever rightward, so it terminates. The last round
   is unconditional, which guarantees no overlap even on a graph that has not
   converged — and the view then reports how many trunks stayed straight.

8. **`QM_bal` is printed as a raw difference but tabulated as a score.** [2]
   Def. 23 defines it as `abs(|{n : o_n < 0}| − |{n : o_n > 0}|)`, a node
   count, while Tables 6 and 10 report values like 0.99 and 0.73. Both are
   reported here: `balance` normalised to 0..1 (1 = even) and
   `balanceDifference` as the raw count. Since every object type has a trunk
   in an OC-DFG, `balance` is measured about the main type's trunk — the
   layout's central spine — with the per-type split beside it.

9. **The orthogonality denominators say `|N|` where the sum is over `E`.**
   Both papers write `1 − (1/|N|) Σ_{e∈E} …` for `QM_eo`. `|E|` is used, so
   the score stays in 0..1 as described.

10. **Rank assignment is over unique activity pairs, weighted.** [1] sums its
    objective over typed edges. Summing over unique `(src, dst)` pairs with a
    weight is the identical model with `|OT|` times fewer rows; the default
    weight is the number of object types traversing the pair, which is the
    object-centric reading of a central transition. Frequency and uniform
    weighting are selectable.

11. **`Σ_ot r_end,ot` replaces `r_end`.** [2] adds the end node's rank to the
    objective to stop the layout stretching vertically. An OC-DFG has one end
    node per object type, so their sum is minimised, which keeps every type
    compact rather than only one of them.

12. **The reference implementation's `packcut` is not its paper's.** The code
    in `Graph.py` has several superseded lines in that function (assignments
    immediately overwritten, commented-out passes). [2] Defs. 19–21 are taken
    as authoritative and implemented as written.

## What this plugin does not claim

- It does **not** reproduce [1]'s quantitative comparison. That paper
  benchmarks against the OC-DFG layout of an external web tool, parsed out of
  its SVG. The baseline offered here varies the rank assignment and balancing
  *within this same object-centric pipeline*, which is [2]'s comparison, not
  [1]'s.
- It does not implement [2]'s user study, and reports no claim about
  comprehension. The metrics are geometric.
- [1]'s cost-function weights `λ1`, `λ2` are exposed as parameters with a
  default of 0.5 each. The paper states only that they lie in 0..1 and lists
  their influence as unanalysed, so these defaults are a choice, not a
  finding.
