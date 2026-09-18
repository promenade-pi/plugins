# DECLARE

Declarative process mining: a model that says what the process **never did**,
rather than what it does.

Every other miner here answers "what does this process look like?" with
something you can walk through — a Petri net, a BPMN diagram, a process tree.
For a flexible process, that answer is worthless: a hospital, a helpdesk, an
insurance claim handled by people who decide the order themselves has no
readable imperative model. What it has is *rules*.

```
“every claim is eventually assessed”                       response
“payment only ever happens after approval”                 precedence
“a rejection and a payout never both occur”                not co-existence
“the case always starts with registration”                 init
```

That is a DECLARE model: a list of sentences, each one true of the log, each
one checkable against the next log.

## Two actions

**Discover DECLARE model** measures every candidate rule the parameters allow —
eighteen templates over every ordered pair of activities — and keeps the ones
that survive two thresholds.

**Check DECLARE rules** takes a model and a log and reports which rules were
broken, how often, and by which cases. There is no alignment and no cost
function: a declarative model is a list of claims, so conformance is the list
of claims that failed, with the cases that failed them.

## Support and confidence

Both are reported because they answer different questions.

- **Support** — the share of all cases the rule held in. The classical number,
  and a rule about something that almost never happens scores nearly 1.0 on it
  without ever having been tested.
- **Confidence** — the share of the cases that *could have broken it* in which
  it held. A rule the log never activates has no confidence at all (0, not 1),
  so the default threshold drops it rather than padding the model with empty
  truths.

Both thresholds are `cheap` parameters: the log is scanned once and the counts
are kept, so dragging a slider re-mines the model without touching the log
again.

## Pruning

If the log says "A is always *immediately* followed by B", then it also says "A
is eventually followed by B", "A is followed by B before the next A", and "if A
happens, B happens". Reporting all four is reporting one fact four times.
Pruning keeps the strongest statement and drops what it implies — and counts
what it dropped, so nothing disappears quietly.

## What the numbers mean

| | |
|---|---|
| **applies to** | cases in which the rule could have been broken |
| **support** | cases in which it held, out of all of them |
| **confidence** | cases in which it held, out of the ones it applied to |
| **break rate** (checking) | violations out of activations |

## Limits

- **Trace-level, not event-level.** A rule holds or fails for a whole case; the
  report does not point at the offending event. That matches the classical
  definitions and keeps the check linear.
- **No branched or data-aware templates.** The multi-activity (`choice`,
  `exclusive choice`) and data-conditional variants of DECLARE are not here.
- **Activity names are the vocabulary.** A model checked against a log that
  calls the same activity something else will report rules about activities the
  log does not record — named as such, rather than silently passing.
- Discovery is quadratic in the number of activities, which is what the
  activity limit is for.

## References

Pesic, M., Schonenberg, H. & van der Aalst, W.M.P. (2007). *DECLARE: Full
Support for Loosely-Structured Processes.* EDOC 2007, 287–298.
[doi:10.1109/EDOC.2007.14](https://doi.org/10.1109/EDOC.2007.14)

Maggi, F.M., Bose, R.P.J.C. & van der Aalst, W.M.P. (2012). *Efficient
Discovery of Understandable Declarative Process Models from Event Logs.*
CAiSE 2012, LNCS 7328, 270–285.

Implemented from the definitions; see [docs/algorithm.md](docs/algorithm.md)
for the semantics of each template and the arithmetic discovery rests on.

## Building

```bash
./package.sh
```

Runs the Rust tests and the invariants first (`DECLARE_CHECK_CASES` raises the
case count), then `wasm-pack`, then the view bundles, then packages
`dist/run.promenade.declare-<version>.pmplugin`.
