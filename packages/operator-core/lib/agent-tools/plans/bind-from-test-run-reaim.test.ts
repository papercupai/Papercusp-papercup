/**
 * Bind-time re-aim detection (plan mutation-probe-evidence-value-2026-10-11, P-004,
 * D-003, BARs R-4 and R-6).
 *
 * R-4: a caught mutant whose test file, at the same testFileSha256, let a mutant pass in
 *      ANOTHER probe invocation is refused mutation_reaim_unjustified, naming every
 *      survivor that reaimJustification.survivorTestRunIds does not name or whose
 *      mutation equals the catch's own, each with its mutation expression.
 * R-6: when the justification names every survivor and none ran the catch's mutation,
 *      the catch binds and the binding stores { survivorTestRunIds, reason }.
 *
 * Survivors are scoped by test-file fingerprint and probe invocation, never by a time
 * window or by file mtime.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MUTATION_REAIM_MAX_SURVIVORS,
  decideMutationReaim,
  expandTestRunBinding,
  mutationLabel,
  testRunBindingSchema,
  type MutationSurvivor,
  type TestRunBindingDeps,
  type TestRunEvidenceRow,
} from './bind-from-test-run';

const TEST_SHA = 'a'.repeat(64);
const CATCH = { mutateExpression: 's/limit = 3/limit = 4/', againstCommit: null };

const survivor = (id: number, mutateExpression: string | null, againstCommit: string | null = null): MutationSurvivor => ({
  id,
  probeInvocationId: `probe-earlier-${id}`,
  mutateExpression,
  againstCommit,
});

describe('decideMutationReaim (R-4 refusal)', () => {
  it('refuses a catch when a survivor of the same test bytes is not named, naming its id and expression', () => {
    const r = decideMutationReaim({
      testRunId: 42,
      caught: CATCH,
      survivors: [survivor(101, 's/limit = 3/limit = 2/'), survivor(102, 's/>=/>/')],
      justification: { survivorTestRunIds: [101], reason: 'the off-by-one at 2 is a separate boundary' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('mutation_reaim_unjustified');
    expect(r.testRunId).toBe(42);
    expect(r.unjustifiedSurvivors).toEqual([{ testRunId: 102, mutation: 's/>=/>/', why: 'not-named' }]);
    expect(r.message).toContain('102');
    expect(r.message).toContain('s/>=/>/');
    expect(r.message).not.toContain('101 (');
  });

  it('refuses with every survivor named when no justification is given', () => {
    const r = decideMutationReaim({
      testRunId: 42,
      caught: CATCH,
      survivors: [survivor(101, 's/a/b/'), survivor(102, 's/c/d/')],
      justification: undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.unjustifiedSurvivors.map((u) => u.testRunId)).toEqual([101, 102]);
    expect(r.message).toContain('101');
    expect(r.message).toContain('102');
  });

  it('refuses a named survivor that ran the catch\'s own mutation: no reason can justify it', () => {
    const r = decideMutationReaim({
      testRunId: 42,
      caught: CATCH,
      survivors: [survivor(101, CATCH.mutateExpression)],
      justification: { survivorTestRunIds: [101], reason: 'trust me' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.unjustifiedSurvivors).toEqual([
      { testRunId: 101, mutation: CATCH.mutateExpression, why: 'same-mutation-as-catch' },
    ]);
    expect(r.message).toContain('the same mutation as this catch');
  });

  it('compares historical legs by againstCommit', () => {
    const commit = 'b'.repeat(40);
    const r = decideMutationReaim({
      testRunId: 42,
      caught: { mutateExpression: null, againstCommit: commit },
      survivors: [survivor(101, null, commit)],
      justification: { survivorTestRunIds: [101], reason: 'x' },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.unjustifiedSurvivors[0]).toMatchObject({ mutation: `againstCommit:${commit}`, why: 'same-mutation-as-catch' });
    expect(mutationLabel({ mutateExpression: 's/x/y/', againstCommit: null })).toBe('s/x/y/');
  });
});

describe('decideMutationReaim (R-6 justified re-aim)', () => {
  it('binds when every survivor is named with a different mutation, and records ids and reason', () => {
    const justification = { survivorTestRunIds: [101, 102], reason: 'both survivors mutated dead code paths' };
    const r = decideMutationReaim({
      testRunId: 42,
      caught: CATCH,
      survivors: [survivor(101, 's/a/b/'), survivor(102, 's/c/d/')],
      justification,
    });
    expect(r).toEqual({ ok: true, record: justification });
  });

  it('does not check a row without a descriptor, and needs nothing when no survivor exists', () => {
    expect(decideMutationReaim({ testRunId: 42, caught: null, survivors: [survivor(101, 's/a/b/')], justification: undefined }))
      .toEqual({ ok: true, record: null });
    expect(decideMutationReaim({ testRunId: 42, caught: CATCH, survivors: [], justification: undefined }))
      .toEqual({ ok: true, record: null });
  });
});

describe('testRunBindingSchema.reaimJustification', () => {
  const base = { workItemId: 'WI-1', specId: 'SPEC-1', fromTestRun: 42 };
  it('accepts { survivorTestRunIds, reason } and rejects every other shape', () => {
    expect(testRunBindingSchema.safeParse({ ...base, reaimJustification: { survivorTestRunIds: [1], reason: 'r' } }).success)
      .toBe(true);
    for (const bad of [
      'a bare string',
      { survivorTestRunIds: [], reason: 'r' },
      { survivorTestRunIds: [1], reason: '   ' },
      { survivorTestRunIds: [0], reason: 'r' },
      { survivorTestRunIds: [1], reason: 'r', extra: true },
      { survivorTestRunIds: Array.from({ length: MUTATION_REAIM_MAX_SURVIVORS + 1 }, (_, i) => i + 1), reason: 'r' },
    ]) {
      expect(testRunBindingSchema.safeParse({ ...base, reaimJustification: bad }).success).toBe(false);
    }
  });
});

describe('expandTestRunBinding re-aim check (the plans:bind-spec-evidence fromTestRun path)', () => {
  const SCOPE = { workspaceId: 'ws-1', harnessSlug: 'web' };
  const TEST = 'pkg/lib/limit.test.ts';
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'bind-reaim-'));
    await mkdir(path.join(root, 'pkg/lib'), { recursive: true });
    await writeFile(path.join(root, 'pkg/lib/limit.ts'), 'export const limit = 3;\n');
    await writeFile(path.join(root, TEST), "import { limit } from './limit';\nvoid limit;\n");
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const descriptor = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    probeInvocationId: 'probe-catch-0001',
    mode: 'copy-out',
    subjectPath: 'pkg/lib/limit.ts',
    mutateExpression: CATCH.mutateExpression,
    againstCommit: null,
    subjectBeforeSha256: 'c'.repeat(64),
    subjectAfterSha256: 'd'.repeat(64),
    mutantDiff: '-export const limit = 3;\n+export const limit = 4;\n',
    mutantDiffTruncated: false,
    testCommandSha256: 'e'.repeat(64),
    leg: 'mutant',
    testFileSha256: TEST_SHA,
    ...over,
  });

  const row = (over: Partial<TestRunEvidenceRow> = {}): TestRunEvidenceRow => {
    const { execution_details: overrideExecutionDetails, ...rest } = over;
    const defaultExecutionDetails = {
      collectionFailed: false,
      mutationPhase: 'mutant',
      // Keep the fixture's mutable-source witness at or after the temp files' creation.
      runStartedAt: new Date().toISOString(),
      mutation: descriptor(),
    };
    const executionDetailsOverride =
      overrideExecutionDetails && typeof overrideExecutionDetails === 'object' ? overrideExecutionDetails : {};
    return {
      id: 42,
      file_path: TEST,
      status: 'fail',
      source: 'mutation-probe',
      harness_slug: 'web',
      workspace_id: 'ws-1',
      commit_sha: 'abcdef0123456789',
      worktree_dirty: false,
      execution_details: {
        ...(overrideExecutionDetails === undefined ? defaultExecutionDetails : executionDetailsOverride),
      },
      finished_at: new Date().toISOString(),
      ...rest,
    };
  };

  function deps(r: TestRunEvidenceRow, survivors: MutationSurvivor[]) {
    const calls: Array<{ filePaths: readonly string[]; testFileSha256: string; exclude: string }> = [];
    const d: TestRunBindingDeps = {
      loadRun: async () => r,
      adoptRun: async () => true,
      resolveRoot: async () => root,
      loadMutationSurvivors: async (_scope, filePaths, testFileSha256, exclude) => {
        calls.push({ filePaths, testFileSha256, exclude });
        return survivors;
      },
    };
    return { d, calls };
  }

  const bind = (over: Record<string, unknown> = {}) =>
    testRunBindingSchema.parse({ workItemId: 'WI-1', specId: 'SPEC-1', fromTestRun: 42, ...over });

  it('refuses an unjustified re-aim and asks for survivors by the catch\'s test-file sha and another invocation', async () => {
    const { d, calls } = deps(row(), [survivor(101, 's/limit = 3/limit = 2/')]);
    const res = await expandTestRunBinding(bind(), SCOPE, d);
    expect(res).toMatchObject({
      ok: false,
      error: 'mutation_reaim_unjustified',
      testRunId: 42,
      unjustifiedSurvivors: [{ testRunId: 101, mutation: 's/limit = 3/limit = 2/', why: 'not-named' }],
    });
    expect(calls).toEqual([{ filePaths: [TEST], testFileSha256: TEST_SHA, exclude: 'probe-catch-0001' }]);
  });

  it('binds a justified re-aim and stores survivorTestRunIds and reason on the binding', async () => {
    const justification = { survivorTestRunIds: [101], reason: 'the survivor mutated an unreachable branch' };
    const { d } = deps(row(), [survivor(101, 's/limit = 3/limit = 2/')]);
    const res = await expandTestRunBinding(bind({ reaimJustification: justification }), SCOPE, d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.binding.testRunId).toBe(42);
    expect((res.binding.details as Record<string, unknown>).reaim).toEqual(justification);
  });

  it('refuses a justified-looking re-aim whose survivor ran the same mutation', async () => {
    const { d } = deps(row(), [survivor(101, CATCH.mutateExpression)]);
    const res = await expandTestRunBinding(
      bind({ reaimJustification: { survivorTestRunIds: [101], reason: 'x' } }),
      SCOPE,
      d,
    );
    expect(res).toMatchObject({ ok: false, error: 'mutation_reaim_unjustified' });
  });

  it('skips the check for rows without a mutant-leg descriptor or test-file sha (no survivor lookup)', async () => {
    for (const r of [
      row({ execution_details: { collectionFailed: false, mutationPhase: 'mutant', runStartedAt: new Date().toISOString() } }),
      row({ execution_details: { collectionFailed: false, mutationPhase: 'mutant', runStartedAt: new Date().toISOString(), mutation: descriptor({ testFileSha256: null }) } }),
      row({ execution_details: { collectionFailed: false, mutationPhase: 'mutant', runStartedAt: new Date().toISOString(), mutation: descriptor({ leg: 'consumption-control' }) } }),
      row({ status: 'pass' }),
    ]) {
      const { d, calls } = deps(r, [survivor(101, 's/a/b/')]);
      const res = await expandTestRunBinding(bind(), SCOPE, d);
      expect(res.ok, JSON.stringify(res)).toBe(true);
      expect(calls).toEqual([]);
    }
  });
});
