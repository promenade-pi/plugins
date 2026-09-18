# Survey & Task

Runs a study inside the workspace. A questionnaire panel on one side, the
visualisation each question is about on the other — opened by the questionnaire
itself, with the parameters the author captured, and read back when the
participant is done with it.

```
┌──────────────────────────────┬───────────────────────────┐
│                              │ Metro map vs DFG   3 of 9 │
│      the metro map           │ ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░ │
│      (opened by the          │                           │
│       survey, with the       │ Which is easier to read?  │
│       captured parameters)   │  ( ) Metro map            │
│                              │  (•) Directly-follows     │
│                              │                           │
│                              │ Shown beside this panel   │
│                              │ Logistics · Metro map     │
│                              ├───────────────────────────┤
│                              │ Back              Next ›  │
└──────────────────────────────┴───────────────────────────┘
```

## Why this is not just a form

Two host doors face opposite ways, and having both is what makes a question a
*task*:

- `openView()` puts a visualisation on screen with given parameters — so a step
  can set up exactly what it wants asked about.
- `workspace()` reads back the panels and the parameters they are showing — so
  the answer can be *what the participant did* rather than what they typed.

That gives two question kinds nothing else has: **selection in a view** (the
answer is the node or activity they clicked, arriving over the selection bus)
and **configure the view** (the answer is the state they left a filter in; the
panel shows the diff, and a required step of this kind stays blocked until the
view is genuinely not how it was handed over).

Everything is recorded with the stimulus and its parameters *as submitted*, so
any answer can be put back on screen exactly as it was given.

## The A/B case

Author a survey with two steps — the metro map, then the plain DFG — put them
in a block, tick **Flip the order per participant**, and the runner derives the
order from a per-run seed it records. A comparison where everyone sees A first
measures "A first" as much as it measures A; the seed in the response is what
lets the analysis check that.

Pooling: each participant exports their response as JSON, and the **Response**
view imports a pile of them and tallies each question. OPFS is per-browser, so
files are the only transport there is between machines — there is no server
here, deliberately.

## Where a questionnaire lives

Both a survey and each response are ordinary **artifacts**:

- `Survey` — a root, authored the way OCEL Builder authors a log from nothing.
  Editing one publishes a new version whose parent is the old one, because a
  changed questionnaire is a different questionnaire once a study has been run
  against it.
- `SurveyResponse` — a child of the survey **and** of every artifact the survey
  showed. That is the provenance question a study answers: which questionnaire,
  run against which data.

So they sit in the tree, they rename and delete and export like anything else,
and the provenance panel shows what a response came from.

## Steps and the screen

A step with a stimulus **restores** it — the captured parameters go back on
screen, so every participant meets a condition in the same state. A step with
no stimulus **leaves the screen alone**, which is how a follow-up question about
what is already showing is written.

## Question kinds

| kind | answer |
|---|---|
| `instruction` | none — text only, never blocks |
| `choice` / `multi` | one / any of the listed options |
| `rating` | a point on a scale with labelled ends |
| `text` / `number` | what they wrote |
| `order` | positions assigned to the listed items |
| `selection` | what they selected in the shown view |
| `workspace` | the parameters they left the shown view on |

## Where the panels go

The runner, the editor and *New survey* declare `dock: "right"`: they open as
their own right-hand column rather than as a tab over whatever you were looking
at. A step's stimulus then opens with `beside: "left"`, so the arrangement is
the one the questionnaire assumes without anyone dragging a panel into place.
Both are preferences the host resolves — a plugin never positions anything.

## What it needs from the host

Declared in the manifest, per view: `readsWorkspace` (for `promenade.workspace()`
and the `workspace` event), `publishes` (for `promenade.publishArtifact()`,
which may only write artifact types this package itself declares) and `dock`.
It also uses `openView`'s `beside` placement hint and `promenade.view()`. A host
older than 2026-09-10 does not serve all of these, and the panel says so rather
than half-working.

## Not in this build

Branching, time limits, practice runs and attempt limits, study conditions
beyond counterbalancing, centralised collection, interaction-history logging,
and a manual-review workflow. Also *enforcing* which controls a participant may
touch: nothing lets one panel lock another's controls, and a survey that claimed
to would be lying.

One constraint worth knowing: a tab is keyed by (artifact, view), so the same
view of the same artifact cannot be open twice. Metro map *versus* DFG side by
side is fine; metro map A versus metro map B on different parameters has to be
sequential.

## Building and verifying

```bash
./package.sh          # gates on npm run check, then bundles and zips
npm run harness       # then open /__survey-harness/index.html on the dev server
npm run harness:rm    # remove it again — never leave it staged in a build
```

The shipped views run in a sandboxed iframe that synthetic clicks never reach,
so the harness loads the same bundle in a same-origin page against a scripted
`promenade` whose panels and parameters a driver can change on command — which
is the only way to exercise "the participant filtered the view next door".
`window.__probe()` returns what is on screen; `__click`, `__type`, `__pick`,
`__select`, `__setPanelParams`, `__closePanel` and `__pushParams` drive it.
