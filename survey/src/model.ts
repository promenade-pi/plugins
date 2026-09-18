/**
 * The survey model, its validator, and the response it produces.
 *
 * Kept free of React and of `promenade` on purpose: this is the part with
 * rules in it — what a well-formed questionnaire is, what order a given
 * participant sees it in, what a finished run looks like — and rules want to
 * be testable without a DOM or a host. `test/model.test.js` runs it in plain
 * Node.
 */

/**
 * A view, an artifact, and the parameters to open it with — a *captured
 * preset*.
 *
 * The author arranges a real panel and presses Capture, so this is never
 * hand-written and never guessed: it is exactly what `promenade.workspace()`
 * reported for that panel. Restoring it is one `openView` call, which is also
 * what makes a filtering answer replayable — the same three fields put the
 * participant's own end state back on screen.
 */
export interface Stimulus {
  artifactId: string;
  /** Recorded for display, and so a broken reference can say *what* is missing. */
  artifactName: string;
  viewId: string;
  viewLabel: string;
  params: Record<string, unknown>;
  /** Which side of the questionnaire it opens on. */
  side: 'left' | 'right';
}

export type StepKind =
  | 'instruction'
  | 'choice'
  | 'multi'
  | 'rating'
  | 'text'
  | 'number'
  | 'order'
  | 'selection'
  | 'workspace';

export const STEP_KINDS: Array<{ kind: StepKind; label: string; hint: string }> = [
  { kind: 'instruction', label: 'Instruction', hint: 'Text only — nothing to answer.' },
  { kind: 'choice', label: 'Single choice', hint: 'One option from a list.' },
  { kind: 'multi', label: 'Multiple choice', hint: 'Any number of options.' },
  { kind: 'rating', label: 'Rating scale', hint: 'A Likert scale with labelled ends.' },
  { kind: 'text', label: 'Free text', hint: 'A written answer.' },
  { kind: 'number', label: 'Number', hint: 'A single numeric answer.' },
  { kind: 'order', label: 'Ordering', hint: 'Put the listed items in order.' },
  { kind: 'selection', label: 'Selection in a view', hint: 'The answer is what they click in the shown view.' },
  { kind: 'workspace', label: 'Configure the view', hint: 'The answer is how they leave the shown view set up.' },
];

export interface RatingScale {
  min: number;
  max: number;
  minLabel?: string;
  maxLabel?: string;
}

export interface Step {
  id: string;
  kind: StepKind;
  prompt: string;
  /** Secondary text under the prompt — the task detail, not the question. */
  help?: string;
  required?: boolean;
  /** `choice`, `multi`, `order`. */
  options?: string[];
  /** `rating`. */
  scale?: RatingScale;
  /** What to put on screen for this step; nothing means "leave the screen alone". */
  stimulus?: Stimulus | null;
}

/**
 * A block of steps whose order can be flipped per participant.
 *
 * The one piece of randomisation here, and it is not optional in spirit: an
 * A/B comparison where everyone sees A first measures "A first" as much as it
 * measures A. Flipping is deterministic in the run's seed and the seed is
 * recorded, so any single response can be replayed exactly and the analysis
 * can control for order.
 */
export interface Block {
  id: string;
  label: string;
  /** Step ids in this block, in authoring order. */
  steps: string[];
  counterbalance?: boolean;
}

export interface Survey {
  schemaVersion: 1;
  title: string;
  description?: string;
  steps: Step[];
  blocks?: Block[];
}

export const SCHEMA_VERSION = 1;

export function emptySurvey(): Survey {
  return { schemaVersion: SCHEMA_VERSION, title: 'Untitled survey', steps: [], blocks: [] };
}

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Kinds whose answer the participant supplies through a widget in the panel. */
export function hasOptions(kind: StepKind): boolean {
  return kind === 'choice' || kind === 'multi' || kind === 'order';
}

/** Kinds whose answer is read out of another panel rather than typed here. */
export function readsFromStimulus(kind: StepKind): boolean {
  return kind === 'selection' || kind === 'workspace';
}

// ---------------------------------------------------------------- validation

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  survey?: Survey;
}

/**
 * Checks a survey hard enough that the runner never has to.
 *
 * Everything here is a way a questionnaire can be *silently* wrong for a
 * participant: a rating with no range renders an empty row of buttons, a
 * choice with no options is an unanswerable required question, a block naming
 * a step that was deleted quietly drops it out of the counterbalance. None of
 * those throw at runtime; they just produce a study that measured nothing.
 */
export function validateSurvey(value: unknown): ValidationResult {
  const errors: string[] = [];
  const s = value as Partial<Survey> | null;

  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    return { ok: false, errors: ['That is not a survey object.'] };
  }
  if (s.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`Unsupported schemaVersion ${String(s.schemaVersion)} — this build reads ${SCHEMA_VERSION}.`);
  }
  if (typeof s.title !== 'string' || !s.title.trim()) errors.push('The survey needs a title.');
  if (!Array.isArray(s.steps)) {
    return { ok: false, errors: [...errors, 'The survey needs a "steps" array.'] };
  }
  if (!s.steps.length) errors.push('The survey has no steps.');

  const seen = new Set<string>();
  const kinds = new Set(STEP_KINDS.map((k) => k.kind));
  s.steps.forEach((step, i) => {
    const at = `Step ${i + 1}`;
    if (!step || typeof step !== 'object') { errors.push(`${at} is not an object.`); return; }
    if (typeof step.id !== 'string' || !step.id) errors.push(`${at} has no id.`);
    else if (seen.has(step.id)) errors.push(`${at} repeats the id "${step.id}".`);
    else seen.add(step.id);
    if (!kinds.has(step.kind)) errors.push(`${at} has an unknown kind "${String(step.kind)}".`);
    if (typeof step.prompt !== 'string' || !step.prompt.trim()) errors.push(`${at} has no prompt.`);

    if (hasOptions(step.kind) && (!Array.isArray(step.options) || step.options.length < 2)) {
      errors.push(`${at} is a ${step.kind} question and needs at least two options.`);
    }
    if (Array.isArray(step.options) && new Set(step.options).size !== step.options.length) {
      errors.push(`${at} repeats an option.`);
    }
    if (step.kind === 'rating') {
      const scale = step.scale;
      if (!scale || !Number.isFinite(scale.min) || !Number.isFinite(scale.max) || scale.max <= scale.min) {
        errors.push(`${at} is a rating and needs a scale with max greater than min.`);
      } else if (scale.max - scale.min > 20) {
        errors.push(`${at} has a ${scale.max - scale.min + 1}-point scale; that is past the point of being answerable.`);
      }
    }
    if (readsFromStimulus(step.kind) && !step.stimulus) {
      errors.push(`${at} reads its answer out of a view, so it needs a stimulus to read.`);
    }
    if (step.stimulus) {
      const st = step.stimulus;
      if (!st.artifactId || !st.viewId) errors.push(`${at} has an incomplete stimulus.`);
      if (st.side !== 'left' && st.side !== 'right') errors.push(`${at}'s stimulus needs a side.`);
    }
    if (step.kind === 'instruction' && step.required) {
      errors.push(`${at} is an instruction, so it cannot be required — there is nothing to answer.`);
    }
  });

  for (const block of s.blocks ?? []) {
    if (!block?.id) { errors.push('A block has no id.'); continue; }
    if (!Array.isArray(block.steps) || block.steps.length < 2) {
      errors.push(`Block "${block.label || block.id}" needs at least two steps to be worth ordering.`);
    }
    for (const id of block.steps ?? []) {
      if (!seen.has(id)) errors.push(`Block "${block.label || block.id}" names a step that does not exist ("${id}").`);
    }
  }
  const blocked = (s.blocks ?? []).flatMap((b) => b.steps ?? []);
  if (new Set(blocked).size !== blocked.length) {
    errors.push('A step is in more than one block.');
  }

  return errors.length ? { ok: false, errors } : { ok: true, errors: [], survey: s as Survey };
}

// ------------------------------------------------------------------ ordering

/**
 * The order this participant sees the steps in.
 *
 * A counterbalanced block keeps the *slots* it occupies in the document and
 * permutes its members between them, so a block's questions never migrate
 * past the instructions that introduce them — only their internal order
 * changes. One bit of the seed per block, so the whole order is recoverable
 * from the seed alone, which is what makes a recorded response replayable.
 */
export function stepOrder(survey: Survey, seed: number): string[] {
  const ids = survey.steps.map((s) => s.id);
  (survey.blocks ?? []).forEach((block, index) => {
    if (!block.counterbalance) return;
    const slots: number[] = [];
    ids.forEach((id, i) => { if (block.steps.includes(id)) slots.push(i); });
    if (slots.length < 2) return;
    const members = slots.map((i) => ids[i]);
    // One bit per block. Two arrangements is all a counterbalance needs, and
    // it keeps the mapping from seed to order trivially invertible.
    const flip = ((seed >>> (index % 31)) & 1) === 1;
    const arranged = flip ? [...members].reverse() : members;
    slots.forEach((slot, k) => { ids[slot] = arranged[k]; });
  });
  return ids;
}

/**
 * Moves one item of a list to another position.
 *
 * Its own function because reordering is the kind of index arithmetic that
 * looks obviously right and is off by one: removing the item first shifts
 * every later index, so a drag from 1 to 3 must land at 3 *after* the removal,
 * not before it. Used by every draggable list in the editor, and tested.
 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/** A fresh per-participant seed. Recorded in the response; nothing else uses randomness. */
export function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

// ------------------------------------------------------------------ response

export interface StepAnswer {
  stepId: string;
  kind: StepKind;
  prompt: string;
  /**
   * Shape follows the kind: a string for `choice`/`text`, `string[]` for
   * `multi`/`order`, a number for `rating`/`number`, the selected element
   * ids for `selection`, and the panel's parameters for `workspace`.
   */
  answer: unknown;
  /** What was on screen, as the survey asked for it. */
  stimulus: Stimulus | null;
  /**
   * The stimulus panel's parameters when the step was submitted.
   *
   * Recorded for *every* step with a stimulus, not only `workspace` ones:
   * knowing that a participant answered "the metro map is clearer" while
   * looking at it zoomed to three activities is the difference between a
   * result and an anecdote. It is also what makes the answer replayable.
   */
  submittedParams: Record<string, unknown> | null;
  enteredAt: string;
  submittedAt: string;
  ms: number;
}

export interface SurveyResponse {
  schemaVersion: 1;
  surveyTitle: string;
  /** The `Survey` artifact this was run from, when it came from one. */
  surveyArtifactId?: string;
  participant?: string;
  /** The seed the step order was derived from. */
  seed: number;
  /** The order this participant actually saw, so nothing has to be recomputed. */
  order: string[];
  startedAt: string;
  finishedAt: string;
  answers: StepAnswer[];
}

/**
 * Whether a step's answer counts as given. Instructions never block.
 *
 * `workspace` is the interesting case. Its answer is the stimulus panel's
 * parameters, and those are never empty — the panel opens with whatever the
 * author captured — so "is there an answer" would be satisfied the instant the
 * panel exists, and a required task like "filter to the three commonest
 * activities" would let the participant press Next without touching anything.
 * The task is only done once the view is *not* how it was handed over, so that
 * is what is checked.
 */
export function isAnswered(step: Step, answer: unknown): boolean {
  if (step.kind === 'instruction') return true;
  if (answer === undefined || answer === null) return false;
  if (step.kind === 'workspace') {
    return JSON.stringify(answer) !== JSON.stringify(step.stimulus?.params ?? {});
  }
  if (typeof answer === 'string') return answer.trim().length > 0;
  if (Array.isArray(answer)) return answer.length > 0;
  if (typeof answer === 'number') return Number.isFinite(answer);
  if (typeof answer === 'object') return Object.keys(answer as object).length > 0;
  return true;
}

/** One row per answered step — the shape the CSV export writes. */
export function responseRows(response: SurveyResponse): Array<Record<string, unknown>> {
  return response.answers.map((a, i) => ({
    participant: response.participant ?? '',
    survey: response.surveyTitle,
    seed: response.seed,
    position: i + 1,
    step_id: a.stepId,
    kind: a.kind,
    prompt: a.prompt,
    answer: Array.isArray(a.answer) ? a.answer.join(' | ')
      : a.answer != null && typeof a.answer === 'object' ? JSON.stringify(a.answer)
        : a.answer ?? '',
    stimulus_artifact: a.stimulus?.artifactName ?? '',
    stimulus_view: a.stimulus?.viewLabel ?? '',
    submitted_params: a.submittedParams ? JSON.stringify(a.submittedParams) : '',
    seconds: Math.round(a.ms / 100) / 10,
    submitted_at: a.submittedAt,
  }));
}

/**
 * Tallies one step across many responses — what an A/B test is actually
 * asking for once the runs are collected.
 *
 * Numeric kinds get a mean as well as counts, because "4.8 of 7" is the
 * answer to a rating question and a bar chart of seven bars is not.
 */
export interface Tally {
  stepId: string;
  prompt: string;
  kind: StepKind;
  n: number;
  counts: Array<{ value: string; n: number }>;
  mean: number | null;
}

export function tally(responses: SurveyResponse[]): Tally[] {
  const order: string[] = [];
  const byStep = new Map<string, StepAnswer[]>();
  for (const r of responses) {
    for (const a of r.answers) {
      if (!byStep.has(a.stepId)) { byStep.set(a.stepId, []); order.push(a.stepId); }
      byStep.get(a.stepId)!.push(a);
    }
  }
  return order.map((stepId) => {
    const answers = byStep.get(stepId)!;
    const counts = new Map<string, number>();
    let sum = 0;
    let numeric = 0;
    for (const a of answers) {
      const values = Array.isArray(a.answer) ? a.answer.map((v) => String(v))
        : a.answer == null ? []
          : typeof a.answer === 'object' ? [JSON.stringify(a.answer)]
            : [String(a.answer)];
      for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
      if (typeof a.answer === 'number' && Number.isFinite(a.answer)) { sum += a.answer; numeric++; }
    }
    return {
      stepId,
      prompt: answers[0].prompt,
      kind: answers[0].kind,
      n: answers.length,
      counts: [...counts].map(([value, n]) => ({ value, n })).sort((a, b) => b.n - a.n || a.value.localeCompare(b.value)),
      mean: numeric ? Math.round((sum / numeric) * 100) / 100 : null,
    };
  });
}
