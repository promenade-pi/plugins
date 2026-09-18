# Changelog

## 0.7.0

- **The Logistics log no longer makes the browser offer to kill the page.** Opening Cases & variants on it ran ~88 seconds of uninterrupted JavaScript; it is now about 6 seconds of work, none of it holding the main thread for more than ~40ms at a time.
- **The isomorphism check was the whole problem, and it was 23x slower than it needed to be.** Profiling the pipeline stage by stage put ~79 of those 88 seconds in one place: verifying that executions sharing a canonical hash really are isomorphic. The check compared graphs through string keys — `consistent()` built four template literals and did four `Map<string,string>` lookups *per already-mapped node, per candidate* — and re-indexed both graphs on every one of the ~10,000 comparisons. Nodes are now integers, labels are interned, adjacency is a dense `Int32Array`, and each graph is prepared once instead of once per comparison. That stage went from ~79s to ~1.8s. Same algorithm, same answer.
- **Progress is now shown, and it is real.** The bar counts process executions actually finished, phase by phase (extracting, fingerprinting, grouping), so it cannot run ahead of the work.
- **The extraction can be canceled.** A sandboxed view has no Worker to offload to — the frame's CSP is `default-src 'none'` with no `worker-src` — so the stages were rewritten as generators and are driven in ~12ms slices, handing control back to the browser in between. That is what makes the tab stay responsive, the progress paint, and a click on Cancel land within a slice. Canceling says so rather than showing an empty view that looks like a result.
- Added `npm run check` (wired into `package.sh`, so it gates packaging) asserting the things that are easy to break and impossible to eyeball — including that the progress readout itself names the phase, shows the real counts and offers Cancel: that the rewritten isomorphism produces a byte-identical variant partition — verified against the previous implementation, kept verbatim in the check, across every leading object type of a synthetic log and of Logistics (13 configurations, 10,553 executions in the largest) — and that the longest uninterrupted stretch of main-thread work stays under 250ms.
- Fixed a leak introduced by the above before it shipped: the yielding helper opened a `MessageChannel` per run and never closed it, so every parameter change left one behind.

## 0.6.4

Changelog starts here; versions before 0.6.4 were not individually tracked.

The object-centric analogue of the traditional "Cases & variants" view.
Cases become process executions (Adams, Schuster, Schmitz, Schuh & van der
Aalst, "Defining Cases and Variants for Object-Centric Event Data",
arXiv:2208.03235): connected subgraphs of the object co-occurrence graph,
extracted either by connected components or by a chosen leading object
type. Variants become equivalence classes of process executions under
activity-labelled graph isomorphism (Weisfeiler-Lehman canonical hashing,
then exact verification within each hash bucket). Create execution
partition publishes the typed, source-bound memberships for downstream
views without duplicating OCEL records.
