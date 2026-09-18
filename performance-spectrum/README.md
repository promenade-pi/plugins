# Performance Spectrum

The Performance Spectrum is a fine-grained performance visualization from Denisov, Fahland, and van der Aalst. Instead of reducing a process step to one mean duration, it draws every observed directly-follows segment over calendar time. Each inclined line represents one observed flow: its horizontal extent and slope encode duration; colour shows its duration quartile, from fast blue to slow red.

This makes temporary slowdowns, batching, queues, recovery behaviour and concept drift visible even when aggregate averages look normal.

## Promenade implementation

For a traditional event log, segments are consecutive timestamped events of a case. For an OCEL, they are consecutive timestamped events in an object's lifecycle. The Inspector offers a searchable multi-select for **Activities** on every log, and an additional **Object types** multi-select only for OCELs.

The source query computes `LEAD(...)` per case/object, then samples individual segments before classifying the sample into four duration quartiles. The canvas shows the most frequent activity pairs as horizontal bands. It never replaces the spectrum by a per-band average.

The Inspector's **Time range** uses Promenade's dual-handle calendar control. Its bounds are applied before the segment sample is selected, so a focused time period uses its own visual budget rather than a sparse remainder of a whole-log sample.

Use **Sampled segments** to set the visual point budget and **Visible segments** to keep labels legible. Clicking a band publishes its two activities to the shared activity selection.

The **Segments** menu above the chart lets you choose any subset of the offered activity pairs. Selected pairs are redistributed across the complete vertical chart area, so comparing a few spectra does not leave them compressed between unrelated bands.

## Interaction Atlas lasso cohorts

On an OCEL, the selector in the header lists published **exact lasso cohorts**
from Interaction Atlas that share the same canonical source log. Choosing one
filters the spectrum to directly-follows segments whose **source event** is in
the cohort. The target remains that object's immediate next event in the full
lifecycle, so the chart answers “what followed the selected contacts?” rather
than constructing a new, potentially discontinuous lifecycle. The host
validates the source binding and the discrete lifecycle-bin mask before the
selection is made available; this is never a transfer of screen coordinates.

## References

- Vadim Denisov, Dirk Fahland, Wil M.P. van der Aalst (2018): *Unbiased, Fine-Grained Description of Processes Performance from Event Data*, BPM 2018, pp. 139–157. DOI: 10.1007/978-3-319-98648-7_9.
- Vadim Denisov, Elena Belkina, Dirk Fahland, Wil M.P. van der Aalst (2018): *The Performance Spectrum Miner: Visual Analytics for Fine-Grained Performance Analysis of Processes*, BPM Demonstration Track.
