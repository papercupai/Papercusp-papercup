/**
 * The 'refactor' change-kind proof gate (plan code-cleanup-campaigns-2026-10-26, P-004).
 *
 *   R-4 — work_items:complete refuses a successful close declaring change kind 'refactor' unless
 *         the proof shows unchanged covering tests passing both before and after the landing change,
 *         every touched member covered, the finding gone on re-scan, and clean typecheck + strands.
 *   D-006 — enforced regardless of CHANGE_KIND_GATE_CUTOVER (a pre-cutover claim is still refused).
 *
 * One accepted close, then one refused close per missing or violated element. Drives
 * `evaluateChangeKindGate` with an injected facts resolver, so no git or database is touched.
 */
import { describe, expect, it } from 'vitest';

import { CHANGE_KIND_CATALOG, CHANGE_KINDS, changeKindsProofWeight, type ChangeKindEvidence } from './change-kind-catalog';
import { CHANGE_KIND_GATE_CUTOVER, evaluateChangeKindGate, type ChangeKindGateInput } from './change-kind-proof';
import type { RefactorFacts, RefactorFactsQuery } from './change-kind-refactor-proof';
import type { ChangeKindsView } from './work-item-change-kinds';

const AFTER_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) + 3_600_000).toISOString();
const BEFORE_CUTOVER = new Date(Date.parse(CHANGE_KIND_GATE_CUTOVER) - 3_600_000).toISOString();
const PARENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LANDING = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TEST_A = 'packages/x/lib/a.test.ts';
const TEST_B = 'packages/x/lib/b.test.ts';

const ENTRY: ChangeKindEvidence = {
  kind: 'refactor',
  landingCommit: LANDING,
  beforeRuns: [11, 12],
  afterRuns: [21, 22],
  finding: 'clone-family:abc123',
  typecheck: 'LINT_TSC_RESULT status=clean exit=0',
  behaviouralStrands: 'lint:behavioural-strands exit 0, no strands',
};

function facts(over: Partial<RefactorFacts> = {}): RefactorFacts {
  return {
    landingCommit: LANDING,
    landingParent: PARENT,
    beforeRuns: [
      { id: 11, filePath: TEST_A, commitSha: PARENT, status: 'pass', worktreeDirty: false },
      { id: 12, filePath: TEST_B, commitSha: PARENT, status: 'pass', worktreeDirty: false },
    ],
    afterRuns: [
      { id: 21, filePath: TEST_A, commitSha: LANDING, status: 'pass', worktreeDirty: false },
      { id: 22, filePath: TEST_B, commitSha: LANDING, status: 'pass', worktreeDirty: false },
    ],
    changedFiles: ['packages/x/lib/a.ts', 'packages/x/lib/b.ts'],
    touchedMembers: [
      { member: 'packages/x/lib/a.ts#parseA', coveringFiles: [TEST_A] },
      { member: 'packages/x/lib/b.ts#parseB', coveringFiles: [TEST_B] },
    ],
    findingStillReported: false,
    ...over,
  };
}

function storedAtClaim(): ChangeKindsView {
  return {
    current: ['refactor'],
    history: [{ kinds: ['refactor'], step: 'claim', declaredBy: 'su-tester', declaredAt: AFTER_CUTOVER, reason: null }],
  };
}

function input(entry: Partial<ChangeKindEvidence> | null = ENTRY, over: Partial<ChangeKindGateInput> = {}): ChangeKindGateInput {
  return {
    itemId: 'WI-9101',
    successfulClose: true,
    stored: storedAtClaim(),
    claimStartedAt: AFTER_CUTOVER,
    kindEvidence: entry ? [{ kind: 'refactor', ...entry } as ChangeKindEvidence] : null,
    root: { summary: 'extracted parseShared', filesChanged: ['packages/x/lib/a.ts', 'packages/x/lib/b.ts'] },
    ...over,
  };
}

async function gate(entry: Partial<ChangeKindEvidence> | null, f: RefactorFacts | null, over: Partial<ChangeKindGateInput> = {}) {
  const queries: RefactorFactsQuery[] = [];
  const result = await evaluateChangeKindGate(
    input(entry, over),
    f ? { resolveRefactorFacts: async (q) => (queries.push(q), f) } : {},
  );
  return { result, queries };
}

function refusedWith(result: Awaited<ReturnType<typeof evaluateChangeKindGate>>, needle: RegExp): void {
  expect(result).toMatchObject({ applicable: true, outcome: 'refuse' });
  const missing = result.applicable && result.outcome === 'refuse' ? result.missing.flatMap((m) => m.missing) : [];
  expect(missing.some((m) => needle.test(m)), `expected a gap matching ${needle}, got:\n${missing.join('\n')}`).toBe(true);
}

describe("change kind 'refactor' (R-4)", () => {
  it('is in the catalog, heavier than logic, so re-declaring a refactor as logic needs a reason', () => {
    expect(CHANGE_KINDS).toContain('refactor');
    expect(CHANGE_KIND_CATALOG.refactor.proofWeight).toBeGreaterThan(CHANGE_KIND_CATALOG.logic.proofWeight);
    expect(changeKindsProofWeight(['refactor'])).toBeGreaterThan(changeKindsProofWeight(['logic']));
  });

  it('accepts a close whose proof holds on every element', async () => {
    const { result, queries } = await gate(ENTRY, facts());
    expect(result).toEqual({ applicable: true, outcome: 'pass', kinds: ['refactor'] });
    expect(queries).toEqual([{ landingCommit: LANDING, beforeRunIds: [11, 12], afterRunIds: [21, 22], finding: 'clone-family:abc123' }]);
  });

  it('refuses when no proof entry is given at all', async () => {
    const { result } = await gate(null, facts());
    refusedWith(result, /`landingCommit`/);
    refusedWith(result, /`beforeRuns`/);
    refusedWith(result, /`afterRuns`/);
    refusedWith(result, /`finding`/);
  });

  it('refuses when the facts resolver is unavailable (fail closed)', async () => {
    const { result } = await gate(ENTRY, null);
    refusedWith(result, /resolver is unavailable/);
  });

  it('refuses when the resolver throws', async () => {
    const result = await evaluateChangeKindGate(input(), {
      resolveRefactorFacts: async () => {
        throw new Error('git rev-parse failed');
      },
    });
    refusedWith(result, /could not be resolved: git rev-parse failed/);
  });

  it('refuses when a before-run is missing', async () => {
    const f = facts();
    const { result } = await gate(ENTRY, { ...f, beforeRuns: f.beforeRuns.slice(0, 1) });
    refusedWith(result, /before-run row\(s\) 12 not found/);
  });

  it('refuses when a before-run failed', async () => {
    const f = facts();
    const { result } = await gate(ENTRY, { ...f, beforeRuns: [f.beforeRuns[0]!, { ...f.beforeRuns[1]!, status: 'fail' }] });
    refusedWith(result, /before-run 12 .* status 'fail'/);
  });

  it("refuses when a before-run ran at another commit than the landing change's parent", async () => {
    const f = facts();
    const { result } = await gate(ENTRY, { ...f, beforeRuns: [f.beforeRuns[0]!, { ...f.beforeRuns[1]!, commitSha: 'c'.repeat(40) }] });
    refusedWith(result, /before-run 12 .* ran at c{40}, not at the landing change's parent/);
  });

  it('refuses when an after-run is missing', async () => {
    const f = facts();
    const { result } = await gate(ENTRY, { ...f, afterRuns: f.afterRuns.slice(1) });
    refusedWith(result, /after-run row\(s\) 21 not found/);
  });

  it('refuses when an after-run failed', async () => {
    const f = facts();
    const { result } = await gate(ENTRY, { ...f, afterRuns: [{ ...f.afterRuns[0]!, status: 'error' }, f.afterRuns[1]!] });
    refusedWith(result, /after-run 21 .* status 'error'/);
  });

  it('refuses when an after-run ran at another commit or on a dirty tree', async () => {
    const f = facts();
    const other = await gate(ENTRY, { ...f, afterRuns: [{ ...f.afterRuns[0]!, commitSha: PARENT }, f.afterRuns[1]!] });
    refusedWith(other.result, /after-run 21 .* not at the landing change/);
    const dirty = await gate(ENTRY, { ...f, afterRuns: [{ ...f.afterRuns[0]!, worktreeDirty: true }, f.afterRuns[1]!] });
    refusedWith(dirty.result, /after-run 21 .* dirty tree/);
  });

  it('refuses when the before and after runs cover different test sets', async () => {
    const f = facts();
    const { result } = await gate(ENTRY, { ...f, afterRuns: [f.afterRuns[0]!, { ...f.afterRuns[1]!, filePath: 'packages/x/lib/c.test.ts' }] });
    refusedWith(result, /different test sets/);
  });

  it('refuses when a covering test file changed in the landing change', async () => {
    const { result } = await gate(ENTRY, facts({ changedFiles: ['packages/x/lib/a.ts', TEST_A] }));
    refusedWith(result, /covering test file\(s\) changed in the landing change: packages\/x\/lib\/a\.test\.ts/);
  });

  it('refuses when a touched member has no covering test', async () => {
    const { result } = await gate(
      ENTRY,
      facts({ touchedMembers: [{ member: 'packages/x/lib/a.ts#parseA', coveringFiles: [TEST_A] }, { member: 'packages/x/lib/c.ts#orphan', coveringFiles: [] }] }),
    );
    refusedWith(result, /touched member packages\/x\/lib\/c\.ts#orphan has no covering test/);
  });

  it('refuses when a covering file has no cited before/after run', async () => {
    const { result } = await gate(ENTRY, facts({ touchedMembers: [{ member: 'packages/x/lib/a.ts#parseA', coveringFiles: [TEST_A, 'packages/x/lib/d.test.ts'] }] }));
    refusedWith(result, /without a cited before and after run: packages\/x\/lib\/d\.test\.ts/);
  });

  it('refuses when the landing change touched no known member', async () => {
    const { result } = await gate(ENTRY, facts({ touchedMembers: [] }));
    refusedWith(result, /touched no source member/);
  });

  it('refuses when the finding is still reported, or the re-scan cannot answer', async () => {
    refusedWith((await gate(ENTRY, facts({ findingStillReported: true }))).result, /still reported after the change/);
    refusedWith((await gate(ENTRY, facts({ findingStillReported: null }))).result, /could not re-scan/);
  });

  it('refuses a typecheck failure', async () => {
    const { result } = await gate({ ...ENTRY, typecheck: 'LINT_TSC_RESULT status=partial exit=1' }, facts());
    refusedWith(result, /`typecheck` is not clean/);
  });

  it('refuses a behavioural-strands failure', async () => {
    const { result } = await gate({ ...ENTRY, behaviouralStrands: 'exit 1: 2 strands named' }, facts());
    refusedWith(result, /`behaviouralStrands` is not clean/);
  });

  it('refuses a claim started before the cutover just the same (D-006)', async () => {
    const { result } = await gate({ ...ENTRY, afterRuns: undefined }, facts(), { claimStartedAt: BEFORE_CUTOVER });
    refusedWith(result, /`afterRuns`/);
  });

  it('lands proposed (out of burn-down) when a refactor is re-declared as logic without a reason', async () => {
    const result = await evaluateChangeKindGate({
      ...input(null),
      declaredAtClose: ['logic'],
      kindEvidence: null,
      root: { testsRun: 'npm run test:file -- packages/x/lib/a.test.ts', testResult: '3 passed, 0 failed' },
    });
    expect(result).toMatchObject({ applicable: true, outcome: 'propose', narrowed: ['refactor'] });
  });
});
