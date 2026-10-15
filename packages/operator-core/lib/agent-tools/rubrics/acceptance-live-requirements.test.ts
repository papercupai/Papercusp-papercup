/**
 * R-1 (agent-paperwork-and-restart-tax-reduction-2026-10-15 P-001): acceptance criteria are a
 * live view of the plan's requirement blocks. A test-path-only edit to a requirement must be
 * BAR-neutral (no amendment, so nothing re-vets or re-grades) and the next acceptance read must
 * show the new test path. A meaning edit must still require an amendment.
 */
import { describe, expect, it } from 'vitest';
import { acceptanceBarSourceFingerprint } from '../../acceptance-bar-amendment';
import { parseRequirementBars } from '../../acceptance-bar-seed';
import {
  classifyRequirementBarEdit,
  overlayLiveRequirementVerification,
  readLiveAcceptanceCriteria,
  verificationNeutralCriterion,
  type LiveAcceptanceViewDeps,
} from '../../acceptance-live-requirements';

const OLD_TEST = 'packages/operator-core/lib/old-path.test.ts';
const NEW_TEST = 'packages/operator-core/lib/new-path.test.ts';

function requirementBlock(opts: { file?: string; condition?: string; method?: string; checkKind?: 'tests' | 'instrument' } = {}): string {
  const check = (opts.checkKind ?? 'tests') === 'tests'
    ? { kind: 'tests', files: [opts.file ?? OLD_TEST] }
    : { kind: 'instrument', instrumentKey: 'none' };
  return JSON.stringify({
    intent: { request: 'Read acceptance criteria from the live plan.', sourceRefs: ['owner-directive:1909'] },
    acceptance: {
      condition: opts.condition ?? 'A path-only edit shows the new path on the next read.',
      falsifier: 'A path-only edit leaves a stale criterion.',
      evidencePlane: 'tree',
      requiredScope: ['P-001'],
      requiredTestLayers: ['unit'],
    },
    verification: { method: opts.method ?? 'Run the live-view tests.', check },
  });
}

function fixturePlan(block: string): string {
  return [
    '---', 'title: Live view fixture', 'slug: live-view-fixture', 'status: active', '---', '',
    '## Requirements', '',
    '**R-1 — Live view.**', '',
    '```requirement', block, '```', '',
    '## Design', '',
    '### Bar-to-work map for this plan', '',
    '| bar | implementing plan items | evidence plane |',
    '|---|---|---|',
    '| R-1 | P-001 | tree |', '',
    '## Phase 1', '',
    '- **P-001** `todo` Build the live view (R-1).', '',
  ].join('\n');
}

describe('classifyRequirementBarEdit', () => {
  const base = { model: 'm', driftMarkers: 'f', method: 'run it', check: { kind: 'tests', files: [OLD_TEST] } };

  it('is unchanged for an identical criterion', () => {
    expect(classifyRequirementBarEdit(base, { ...base })).toBe('unchanged');
  });
  it('treats a tests-check file move as verification-only', () => {
    expect(classifyRequirementBarEdit(base, { ...base, check: { kind: 'tests', files: [NEW_TEST] } })).toBe('verification-only');
  });
  it('treats a method rewrite as verification-only', () => {
    expect(classifyRequirementBarEdit(base, { ...base, method: 'run it differently' })).toBe('verification-only');
  });
  it('treats a condition change as meaning', () => {
    expect(classifyRequirementBarEdit(base, { ...base, model: 'a different promise' })).toBe('meaning');
  });
  it('treats a check-kind change as meaning', () => {
    expect(classifyRequirementBarEdit(base, { ...base, check: { kind: 'instrument', instrumentKey: 'none' } })).toBe('meaning');
  });
  it('treats an added or removed requirement as meaning', () => {
    expect(classifyRequirementBarEdit(undefined, base)).toBe('meaning');
    expect(classifyRequirementBarEdit(base, null)).toBe('meaning');
  });
  it('keeps a non-tests check whole in the meaning projection', () => {
    const neutral = verificationNeutralCriterion({ check: { kind: 'probe', all: ['a'] }, method: 'x' });
    expect(neutral).toEqual({ check: { kind: 'probe', all: ['a'] } });
  });
});

describe('acceptanceBarSourceFingerprint (BAR-neutrality of plan edits)', () => {
  it('is unchanged by a test-path-only or method-only requirement edit', async () => {
    const before = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock()));
    // Positive control: the fixture parses, so equality below is not two nulls.
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ file: NEW_TEST })))).toBe(before);
    expect(await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ method: 'Run the renamed tests.' })))).toBe(before);
  });

  it('still changes for a meaning edit, so an amendment stays required', async () => {
    const before = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock()));
    const condition = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ condition: 'A different promise holds.' })));
    const kind = await acceptanceBarSourceFingerprint(fixturePlan(requirementBlock({ checkKind: 'instrument' })));
    expect(condition).toMatch(/^[a-f0-9]{64}$/);
    expect(condition).not.toBe(before);
    expect(kind).not.toBe(before);
  });
});

describe('overlayLiveRequirementVerification', () => {
  const stored = [
    { key: 'r-1', barKey: 'R-1', method: 'old', check: { kind: 'tests', files: [OLD_TEST] } },
    { key: 'r-2', barKey: 'R-2', method: 'legacy', check: { kind: 'tests', files: [OLD_TEST] } },
    { key: 'r-3', barKey: 'R-3', method: 'kind', check: { kind: 'tests', files: [OLD_TEST] } },
  ];

  it('takes method and check from the live explicit block, and reports what changed', () => {
    const overlay = overlayLiveRequirementVerification(stored, [
      { barKey: 'R-1', criterion: { method: 'new', check: { kind: 'tests', files: [NEW_TEST] } } },
      { barKey: 'R-2' },
      { barKey: 'R-3', criterion: { check: { kind: 'instrument', instrumentKey: 'none' } } },
    ]);
    expect(overlay.criteria[0]).toMatchObject({ method: 'new', check: { kind: 'tests', files: [NEW_TEST] } });
    expect(overlay.live).toEqual(['R-1']);
    expect(overlay.changed).toEqual(['R-1']);
    expect(overlay.criteria[1]).toBe(stored[1]);
    expect(overlay.criteria[2]).toBe(stored[2]);
    expect(overlay.kept).toEqual([
      { barKey: 'R-2', reason: 'no-explicit-block' },
      { barKey: 'R-3', reason: 'check-kind-changed' },
    ]);
  });

  it('keeps a stored field the live block omits instead of blanking it', () => {
    const overlay = overlayLiveRequirementVerification([stored[0]!], [{ barKey: 'R-1', criterion: { check: { kind: 'tests', files: [NEW_TEST] } } }]);
    expect(overlay.criteria[0]!.method).toBe('old');
  });
});

describe('readLiveAcceptanceCriteria (the acceptance read)', () => {
  const realParser: LiveAcceptanceViewDeps['parseRequirementBars'] = (content) => {
    const parsed = parseRequirementBars(content);
    return parsed.ok
      ? { ok: true, bars: parsed.bars.map((bar) => ({ barKey: bar.barKey, ...(bar.criterion ? { criterion: bar.criterion } : {}) })) }
      : { ok: false, problems: parsed.problems };
  };

  it('shows the new test path after a test-path-only edit, with no amendment', async () => {
    const original = fixturePlan(requirementBlock());
    const edited = fixturePlan(requirementBlock({ file: NEW_TEST }));
    const seeded = parseRequirementBars(original);
    if (!seeded.ok) throw new Error('fixture must parse');
    const storedCriteria = seeded.bars.map((bar) => ({ ...bar.criterion!, barKey: bar.barKey }));
    expect(storedCriteria[0]!.check).toMatchObject({ kind: 'tests', files: [OLD_TEST] });

    // No amendment: the edit is BAR-neutral, so the pin advances on the neutral path.
    expect(await acceptanceBarSourceFingerprint(edited)).toBe(await acceptanceBarSourceFingerprint(original));

    const read = await readLiveAcceptanceCriteria(
      { kind: 'acceptance', subjectPlan: 'live-view-fixture', subjectHarnessSlug: 'papercusp', criteria: storedCriteria },
      { readSubjectPlanContent: async () => ({ content: edited, version: 7 }), parseRequirementBars: realParser },
    );
    expect(read.criteria[0]!.check).toMatchObject({ kind: 'tests', files: [NEW_TEST] });
    expect(read.status).toMatchObject({ source: 'live-plan', subjectPlanVersion: 7, live: ['R-1'], changed: ['R-1'] });
  });

  it('falls back to the stored criteria, naming why, when the subject plan cannot be read', async () => {
    const criteria = [{ barKey: 'R-1', check: { kind: 'tests', files: [OLD_TEST] } }];
    const unreadable = await readLiveAcceptanceCriteria(
      { kind: 'acceptance', subjectPlan: 'gone', criteria },
      { readSubjectPlanContent: async () => { throw new Error('pg down'); }, parseRequirementBars: realParser },
    );
    expect(unreadable.criteria).toEqual(criteria);
    expect(unreadable.status).toMatchObject({ source: 'stored-rubric', reason: 'subject-plan-unreadable', detail: 'pg down' });

    const missing = await readLiveAcceptanceCriteria(
      { kind: 'acceptance', subjectPlan: 'gone', criteria },
      { readSubjectPlanContent: async () => null, parseRequirementBars: realParser },
    );
    expect(missing.status).toMatchObject({ source: 'stored-rubric', reason: 'subject-plan-unreadable' });
  });

  it('does not overlay a non-acceptance rubric', async () => {
    let reads = 0;
    const read = await readLiveAcceptanceCriteria(
      { kind: 'standard', subjectPlan: null, criteria: [{ barKey: 'R-1' }] },
      { readSubjectPlanContent: async () => { reads += 1; return null; }, parseRequirementBars: realParser },
    );
    expect(reads).toBe(0);
    expect(read.status).toMatchObject({ source: 'stored-rubric', reason: 'not-a-plan-acceptance-rubric' });
  });
});
