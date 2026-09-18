import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `model.ts` is the part of this plugin with rules in it, and rules are worth
 * testing without a browser. esbuild is already a dependency (it builds the
 * bundle), so one bundling step turns the TypeScript into something Node can
 * import — cheaper than adding a TS test runner for one file.
 */
const dir = mkdtempSync(join(tmpdir(), 'survey-model-'));
const out = join(dir, 'model.mjs');
execFileSync('npx', ['esbuild', 'src/model.ts', '--bundle', '--format=esm', `--outfile=${out}`], {
  stdio: 'pipe',
});
const M = await import(out);

function survey(overrides = {}) {
  return {
    schemaVersion: 1,
    title: 'Metro map vs DFG',
    steps: [
      { id: 's1', kind: 'instruction', prompt: 'Welcome' },
      { id: 's2', kind: 'choice', prompt: 'Which is clearer?', options: ['A', 'B'], required: true },
      { id: 's3', kind: 'rating', prompt: 'How hard?', scale: { min: 1, max: 7 } },
    ],
    ...overrides,
  };
}

test('a well-formed survey validates', () => {
  const r = M.validateSurvey(survey());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
});

test('every way a questionnaire is silently broken for a participant is caught', () => {
  const cases = [
    [{ steps: [{ id: 'a', kind: 'choice', prompt: 'x', options: ['only'] }] }, /at least two options/],
    [{ steps: [{ id: 'a', kind: 'rating', prompt: 'x' }] }, /needs a scale/],
    [{ steps: [{ id: 'a', kind: 'rating', prompt: 'x', scale: { min: 1, max: 1 } }] }, /max greater than min/],
    [{ steps: [{ id: 'a', kind: 'workspace', prompt: 'x' }] }, /needs a stimulus/],
    [{ steps: [{ id: 'a', kind: 'choice', prompt: '', options: ['x', 'y'] }] }, /no prompt/],
    [{ steps: [{ id: 'a', kind: 'nope', prompt: 'x' }] }, /unknown kind/],
    [{ steps: [{ id: 'a', kind: 'text', prompt: 'x' }, { id: 'a', kind: 'text', prompt: 'y' }] }, /repeats the id/],
    [{ steps: [{ id: 'a', kind: 'instruction', prompt: 'x', required: true }] }, /cannot be required/],
    [{ title: '' }, /needs a title/],
    [{ schemaVersion: 2 }, /Unsupported schemaVersion/],
    [{ steps: [] }, /no steps/],
  ];
  for (const [overrides, pattern] of cases) {
    const r = M.validateSurvey(survey(overrides));
    assert.equal(r.ok, false, `expected a failure for ${JSON.stringify(overrides).slice(0, 60)}`);
    assert.match(r.errors.join(' '), pattern);
  }
});

test('a block naming a deleted step is an error, not a silently shrunken counterbalance', () => {
  const r = M.validateSurvey(survey({ blocks: [{ id: 'b1', label: 'AB', steps: ['s2', 'gone'] }] }));
  assert.match(r.errors.join(' '), /names a step that does not exist/);
});

test('a step in two blocks is rejected', () => {
  const r = M.validateSurvey(survey({
    blocks: [
      { id: 'b1', label: 'one', steps: ['s2', 's3'] },
      { id: 'b2', label: 'two', steps: ['s2', 's1'] },
    ],
  }));
  assert.match(r.errors.join(' '), /more than one block/);
});

test('counterbalancing permutes a block within its own slots and nowhere else', () => {
  const s = survey({ blocks: [{ id: 'b1', label: 'AB', steps: ['s2', 's3'], counterbalance: true }] });
  const seen = new Set();
  for (let seed = 0; seed < 8; seed++) seen.add(M.stepOrder(s, seed).join(','));
  // Both arrangements occur...
  assert.deepEqual([...seen].sort(), ['s1,s2,s3', 's1,s3,s2']);
  // ...and the instruction never moves out of position 1, whichever way it fell.
  for (const order of seen) assert.match(order, /^s1,/);
});

test('the order is a pure function of the seed, so a recorded response replays', () => {
  const s = survey({ blocks: [{ id: 'b1', label: 'AB', steps: ['s2', 's3'], counterbalance: true }] });
  for (const seed of [0, 1, 7, 12345, 0x7ffffffe]) {
    assert.deepEqual(M.stepOrder(s, seed), M.stepOrder(s, seed));
  }
});

test('a block without counterbalance keeps document order', () => {
  const s = survey({ blocks: [{ id: 'b1', label: 'AB', steps: ['s2', 's3'] }] });
  for (let seed = 0; seed < 4; seed++) {
    assert.deepEqual(M.stepOrder(s, seed), ['s1', 's2', 's3']);
  }
});

test('isAnswered treats an empty string, empty list and empty object as unanswered', () => {
  const step = { id: 'a', kind: 'text', prompt: 'x' };
  assert.equal(M.isAnswered(step, ''), false);
  assert.equal(M.isAnswered(step, '   '), false);
  assert.equal(M.isAnswered(step, 'no'), true);
  assert.equal(M.isAnswered({ ...step, kind: 'multi' }, []), false);
  assert.equal(M.isAnswered({ ...step, kind: 'workspace' }, {}), false);
  assert.equal(M.isAnswered({ ...step, kind: 'workspace' }, { a: 1 }), true);
  assert.equal(M.isAnswered({ ...step, kind: 'number' }, 0), true);
  assert.equal(M.isAnswered({ ...step, kind: 'number' }, NaN), false);
  // An instruction can never block the Next button.
  assert.equal(M.isAnswered({ ...step, kind: 'instruction' }, null), true);
});

const response = {
  schemaVersion: 1,
  surveyTitle: 'Metro map vs DFG',
  participant: 'P01',
  seed: 3,
  order: ['s2', 's3'],
  startedAt: '2026-09-09T10:00:00.000Z',
  finishedAt: '2026-09-09T10:04:00.000Z',
  answers: [
    {
      stepId: 's2', kind: 'choice', prompt: 'Which is clearer?', answer: 'Metro map',
      stimulus: { artifactId: 'a1', artifactName: 'Logistics', viewId: 'v', viewLabel: 'Metro map', params: {}, side: 'left' },
      submittedParams: { variants: 4 },
      enteredAt: '2026-09-09T10:00:00.000Z', submittedAt: '2026-09-09T10:01:00.000Z', ms: 60000,
    },
    {
      stepId: 's3', kind: 'rating', prompt: 'How hard?', answer: 6,
      stimulus: null, submittedParams: null,
      enteredAt: '2026-09-09T10:01:00.000Z', submittedAt: '2026-09-09T10:02:00.000Z', ms: 60000,
    },
  ],
};

test('responseRows is one row per answer, with the stimulus alongside', () => {
  const rows = M.responseRows(response);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].participant, 'P01');
  assert.equal(rows[0].answer, 'Metro map');
  assert.equal(rows[0].stimulus_view, 'Metro map');
  assert.equal(rows[0].submitted_params, '{"variants":4}');
  assert.equal(rows[0].seconds, 60);
});

test('tally counts across responses and means the numeric ones', () => {
  const other = {
    ...response,
    participant: 'P02',
    answers: [
      { ...response.answers[0], answer: 'DFG' },
      { ...response.answers[1], answer: 4 },
    ],
  };
  const t = M.tally([response, other]);
  const choice = t.find((x) => x.stepId === 's2');
  assert.equal(choice.n, 2);
  assert.deepEqual(choice.counts.map((c) => c.value).sort(), ['DFG', 'Metro map']);
  assert.equal(choice.mean, null);
  const rating = t.find((x) => x.stepId === 's3');
  assert.equal(rating.mean, 5);
});

test('a required "configure the view" step is not satisfied by an untouched view', () => {
  // The answer is the panel's parameters, and those are never empty — the
  // panel opens with whatever the author captured. Without this rule a
  // required task would let the participant press Next having done nothing.
  const step = {
    id: 'w', kind: 'workspace', prompt: 'Filter it', required: true,
    stimulus: { artifactId: 'a', artifactName: 'L', viewId: 'v', viewLabel: 'V', params: { activityPct: 100 }, side: 'left' },
  };
  assert.equal(M.isAnswered(step, { activityPct: 100 }), false);
  assert.equal(M.isAnswered(step, { activityPct: 40 }), true);
  // Key order must not read as a change.
  const wide = { ...step, stimulus: { ...step.stimulus, params: { a: 1, b: 2 } } };
  assert.equal(M.isAnswered(wide, { a: 1, b: 2 }), false);
  assert.equal(M.isAnswered(wide, { b: 2, a: 1, c: 3 }), true);
});

test('moveItem is the index arithmetic reordering always gets wrong', () => {
  const l = ['a', 'b', 'c', 'd'];
  // Forward: the target index is where it lands *after* the removal shifted
  // everything later down by one.
  assert.deepEqual(M.moveItem(l, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(M.moveItem(l, 1, 3), ['a', 'c', 'd', 'b']);
  // Backward needs no adjustment.
  assert.deepEqual(M.moveItem(l, 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(M.moveItem(l, 2, 1), ['a', 'c', 'b', 'd']);
  // No-ops and out-of-range are the identity, not a crash or a duplicate.
  assert.deepEqual(M.moveItem(l, 1, 1), l);
  assert.deepEqual(M.moveItem(l, -1, 2), l);
  assert.deepEqual(M.moveItem(l, 9, 0), l);
  assert.deepEqual(M.moveItem(l, 0, 99), ['b', 'c', 'd', 'a']);
  // Never mutates the input.
  assert.deepEqual(l, ['a', 'b', 'c', 'd']);
});
