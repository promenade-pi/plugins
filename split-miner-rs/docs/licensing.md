# Licensing

**This plugin is MIT. It is an independent implementation from the published
papers, not a translation of the authors' code.** The distinction matters, and
this document exists so the reasoning is on the record rather than assumed.

## The licence gate

`plugins/PORTING.md` says to settle the licence before reading any source with
the intent to translate. The authors' own implementation of both Split Miner
and Split Miner 2.0 is [`github.com/nemo-91/bpmtk`](https://github.com/nemo-91/bpmtk)
— Adriano Augusto's toolkit, the one the papers and the Apromore platform point
at. Its `LICENSE.txt` reads:

> The source code stored in this repository is distributed with a GPL license.
> The source code relies on libraries distributed either with GPL license.
>
> We acknowledge that many of the libraries stored in this repository come from
> the ProM project (http://www.promtools.org), we redistribute them under the
> GPL license.

A second implementation, [`github.com/iharsuvorau/split-miner`](https://github.com/iharsuvorau/split-miner),
carries the same non-permissive terms.

A translation of GPL source is a derivative work and cannot be MIT. An
independent implementation of a published algorithm can be: algorithms are not
copyrightable, their expression is.

## What was actually used

- **The papers, and only the papers.** Every definition, condition, algorithm
  and threshold in `crates/split-miner-core` comes from:
  - Augusto, Conforti, Dumas & La Rosa, *Split Miner: Discovering Accurate and
    Simple Business Process Models from Event Logs*, ICDM 2017 — the version
    carrying Algorithms 1–4 in full, [openly available from the second
    author](https://kodu.ut.ee/~dumas/pubs/icdm2017-split-miner.pdf);
  - Augusto, Conforti, Dumas, La Rosa & Polyvyanyy, *Split miner: automated
    discovery of accurate and simple business process models from event logs*,
    KAIS 59(2), 2019 — the journal version, [doi:10.1007/s10115-018-1214-x](https://doi.org/10.1007/s10115-018-1214-x);
  - Augusto, Dumas & La Rosa, *Automated Discovery of Process Models with True
    Concurrency and Inclusive Choices*, ICPM Workshops 2021,
    [arXiv:2105.06016](https://arxiv.org/abs/2105.06016).
- **No source was read, vendored or translated**, from either repository, and
  the published jar was not used as an oracle either. Unlike the Inductive
  Miner port — where `plugins/PORTING.md` records a differential harness run
  against the reference — there is no bug-parity claim here and none is made.

## What that costs, stated plainly

Without a reference to differentially test against, "faithful to the papers" is
the strongest claim available, and the papers leave things open that any
implementation has to decide. Every such decision is marked in the source at
the point it is made, and the four that change output are:

1. **Which arc of a short loop is lifted.** The paper says self-loops and
   short-loops are "trivially removed from the DFG and restored in the output
   BPMN model at the end" without saying which of a short loop's two arcs goes.
   Removing both can disconnect the graph, which would break the very property
   the filtering step then has to establish, so the *less frequent* arc is
   treated as the loop-back and lifted. See `dfg.rs`.
2. **When loops are restored.** Restoring them after join discovery, which
   "at the end" can also be read as, leaves every loop without the gateways
   that make it a loop — and a task with two outgoing sequence flows is an
   implicit parallel split in BPMN, which is not what a repeat means. They are
   restored at the end of the *graph* pipeline instead, before splits. See
   `lib.rs`.
3. **What "SESE region" is computed as.** The join rule types a join by the
   entry gateway of the acyclic homogeneous single-entry-single-exit region it
   closes. That is computed here as a dominance/post-dominance pair — the
   standard characterisation — with the region boundary checked against the
   model's back edges, so a region a loop leaves by some other door than its
   exit is not treated as single-exit. See `joins.rs` and `flow.rs`.
4. **Ties, and the percentile.** `getMostFrequentEdge` gets a total order
   (frequency, then the host's own activity ids) so the output is reproducible,
   and the η percentile is linear interpolation over the sorted frequencies.
   See `filter.rs`.

Two places also go beyond the pseudocode for robustness, both recorded in the
output rather than hidden: split discovery has a termination fallback if
neither rule can reduce the successor set (it records a warning), and a model
left with no path from start to end after filtering becomes an empty process
with a warning instead of a diagram with nothing in it.

## Credit

The algorithm is Adriano Augusto, Raffaele Conforti, Marlon Dumas, Marcello La
Rosa and Artem Polyvyanyy's. This is their work, reimplemented; the citation
travels with the plugin in its manifest and is shown in its details panel.
