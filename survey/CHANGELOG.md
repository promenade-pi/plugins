# Changelog

## 0.1.3

- "New survey" is now "New survey…". The ellipsis is a convention, not
  decoration: it says the entry opens somewhere to work rather than doing the
  thing on the spot, and this was the one entry in the artifact panel's "New
  artifact…" menu without it.

## 0.1.2

- **Fixed: "Reopen" did nothing** once the participant had closed the stimulus
  panel. The cause was in the host, not here, and it affected every plugin's
  `promenade.openView()`: dockview fixes a panel's params when it is created
  and only refreshes a few of them, so the opener a frame calls closes over the
  tab list *as it stood when that frame opened*. Reopening a panel the user had
  since closed therefore asked a stale list, concluded the tab already existed,
  and did nothing at all. The host now reads the live list.
- The runner, the editor and **New survey** declare `dock: "right"`, so they
  open as their own right-hand column instead of as a tab on top of whatever
  you were looking at. That is the arrangement the whole plugin assumes — the
  questionnaire on the right, what it is asking about on the left — and it
  should not need dragging into place each time.

## 0.1.1

- **Fixed: the options editor could not take a new line.** Options were edited
  as one-per-line text, and the change handler dropped empty lines — so
  pressing Enter created a line that the very next render deleted, and there
  was no way to add an option except by typing it onto the end of an existing
  one. A controlled field whose handler cannot represent the state the user is
  typing *through* is unusable; the fix is not a better handler but a different
  control.
- Options (and the items of an ordering question) are now a proper list: one
  field each, a drag handle on the left, ✕ to remove. Enter adds the next one,
  Backspace on an empty one removes it, and a handle can also be moved with the
  arrow keys — drag is the obvious gesture and also the one that does not work
  from a keyboard. A blank row stays on screen while you type and is left out
  of what the survey stores.
- Fixed the same class of problem, milder, in the rating scale's From/To
  fields: `Number('')` is 0, so clearing one snapped it to zero instead of
  letting you retype it.
- The editor stacks into one column when the panel is narrow. It is normally
  docked *beside* the view it captures, and at that width a fixed 300px step
  list left the form about 190px — an option field four characters wide.
- Fixed the root cause behind both of those and the reload bug in 0.1.0:
  the host sends a panel's initial `resize`/`params` when `ready()` is called,
  which is before any React effect runs, so a handler registered in an effect
  never sees them. Those events are now latched at module scope (`src/host.ts`)
  where no arrival order can lose them.

## 0.1.0

First release.

- **Run survey** — the participant panel. Opens the visualisation each question
  is about *beside itself* with the parameters the author captured, and reads
  back what the participant did to it. Nine question kinds: instruction, single
  and multiple choice, rating scale, free text, number, ordering, *selection in
  a view* (the answer is what they clicked, off the selection bus) and
  *configure the view* (the answer is the parameters they left it on).
- **Edit / New survey** — the authoring surface, with *Capture*: arrange a real
  panel, press one button, and its exact parameters become the step's stimulus.
  Live validation; saving an existing survey publishes a new version whose
  parent is the old one.
- **Counterbalanced blocks** — a block's steps are ordered per participant from
  a recorded seed, so an A/B comparison is not also measuring which condition
  came first.
- **Response** — one recorded run, with import-and-pool for responses exported
  from other machines, a per-question tally, and JSON/CSV export.
- A run survives a page reload: the draft is kept in the host's own parameter
  store, which is written to disk, rather than in the in-memory panel cache.
- Every answer records the stimulus and its parameters *as submitted*, so any
  answer can be put back on screen exactly as it was given.

Needs a host from 2026-09-09 or later: this plugin uses `views[].readsWorkspace`
(`promenade.workspace()`), `promenade.publishArtifact()`, `openView`'s `beside`
placement hint, `promenade.view()`, and `family` on manifest artifact types.
Against an older app the panel reports the missing call rather than working
partially.
