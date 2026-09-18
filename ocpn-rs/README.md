# OCPN Discovery

Discovers an **Object-Centric Petri Net (OCPN)** from an `ObjectCentricEventLog`:
per selected object type, project the log, mine a process tree with Inductive
Miner, convert it to a Petri net, then merge every object type's net by
shared activity into one `ObjectCentricPetriNet` artifact. Ships as one
installable `.pmplugin` — no Promenade core code involved. One user-facing
action, `run.promenade.ocpn.discover`, selectable directly on the OCEL log:

```text
ObjectCentricEventLog                    (what the user selects)
        ↓
run.promenade.ocpn.project   (runtime: relational, project.sql, internal: true —
        ↓                     produced transparently via `scans`/`ctx.produce()`)
TraditionalEventLog (one combined projection across every selected object type)
        ↓
run.promenade.ocpn.discover  (runtime: wasm, this crate — "scans": "TraditionalEventLog")
        ↓
ObjectCentricPetriNet artifact
        ↓
Object-centric Petri net view  (app/src/ui/views/OcpnView.tsx)
```

The projection is still a real, independently-inspectable artifact with its
own provenance — it just isn't a separate *click*. See
`docs/architecture.md`'s "How this ships as one installable `.pmplugin`"
for the two generic manifest capabilities (`internal`, `scans`) this relies
on, both usable by any plugin, not specific to this one.

## Layout

```text
ocpn-rs/
├── Cargo.toml            workspace root = the wasm-bindgen kernel (promenade-ocpn)
├── src/lib.rs             the wasm boundary — scan-finalize/1 ABI
├── crates/
│   ├── ocpn-core/         the OCPN model: places, transitions, arcs, object types.
│   │                      zero deps, zero browser/wasm awareness.
│   ├── ocpn-discovery/    the pure discovery algorithm: projection → Inductive
│   │                      Miner (reused from inductive-miner-core) → tree-to-net
│   │                      → merge by activity → variable-arc detection.
│   └── ocpn-cli/          JSON-in/JSON-out debug harness, mirrors inductive-miner-cli.
├── project.sql            SQL Profile v1 program for run.promenade.ocpn.project (internal)
├── manifest.json          declares both actions (one internal) + the view
├── package.sh             builds the wasm module and zips the .pmplugin
└── docs/
    ├── algorithm.md        the discovery algorithm, precisely
    ├── architecture.md     reuse, the one-click action split, the wasm boundary, ELK configuration
    └── testing.md          test strategy and what "correct" means here
```

`ocpn-core` and `ocpn-discovery` have no wasm-bindgen, no browser API, and no
Promenade-specific dependency — `cargo test -p ocpn-core -p ocpn-discovery`
runs natively. That is what keeps this algorithm reusable later for a native
Promenade Compute execution path, not just the browser.

## Building

```bash
./package.sh    # wasm-pack build, then zip manifest.json + project.sql + the
                 # wasm module + docs into dist/run.promenade.ocpn-<version>.pmplugin
```

Install the resulting `.pmplugin` through Promenade's Plugins panel like any
other package — see `docs/architecture.md`'s "How this ships as one
installable `.pmplugin`" section for the generic host mechanisms (per-action
manifest `runtime`, `ActionContext.persistLog`, generic
upstream-meta-to-param forwarding, `internal`/`scans`) that make this
possible with no special-casing anywhere in Promenade's own code.

## Testing

```bash
cargo test -p ocpn-core -p ocpn-discovery -p ocpn-cli
```

See `docs/testing.md`.
