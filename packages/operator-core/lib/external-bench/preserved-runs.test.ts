/**
 * Unit tests for the preserved external-bench run reader (Evaluation
 * "Preserved runs" surface). Covers the heart of the surface — the grade-map →
 * perTask `resolved` merge + the summary rollup — against an on-disk fixture
 * that mirrors the real `m3-realqueen-2026-06-16` shape (11 tasks, 6 resolved).
 * No DB, no network; just the disk read + the pure merge.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSafeRunId,
  listPreservedRuns,
  mergeResolved,
  readGradeMap,
  readPreservedRun,
  resolveArmFile,
  summarizePreservedRun,
  preservedExecutionTimes,
  inspectPreservedRun,
  type PreservedArmRun,
} from './preserved-runs';

const RUN_ID = 'm3-realqueen-2026-06-16';
const ARM = 'hive-realqueen';

// 11 instances; the 6 resolved=true matching the README's 6/11.
const RESOLVED_TRUE = [
  'instance_NodeBB__NodeBB-x',
  'instance_ansible__ansible-x',
  'instance_navidrome__navidrome-x',
  'instance_gravitational__teleport-x',
  'instance_qutebrowser__qutebrowser-x',
  'instance_protonmail__webclients-x',
];
const RESOLVED_FALSE = [
  'instance_element-hq__element-web-x',
  'instance_internetarchive__openlibrary-x',
  'instance_future-architect__vuls-x',
  'instance_flipt-io__flipt-x',
  'instance_tutao__tutanota-x',
];
const ALL = [...RESOLVED_TRUE, ...RESOLVED_FALSE];

describe('preserved execution provenance', () => {
  const start = '2026-06-16T04:47:56.836Z';
  it('preserves explicit execution time even for a recovered archive', () => {
    expect(preservedExecutionTimes({ arm: ARM, startedAt: start, finishedAt: '2026-06-16T05:00:00Z', recovered: true }))
      .toEqual({ startedAt: start, finishedAt: '2026-06-16T05:00:00.000Z' });
  });
  it('derives an end from actual unrecovered measured duration', () => {
    expect(preservedExecutionTimes({ arm: ARM, startedAt: start, wallMs: 1000 }))
      .toEqual({ startedAt: start, finishedAt: '2026-06-16T04:47:57.836Z' });
  });
  it.each([{}, { startedAt: 'not-a-date' }, { startedAt: start, wallMs: 0 },
    { startedAt: start, wallMs: 1000, recovered: true }, { startedAt: start, wallMs: Number.MAX_VALUE }])(
    'never invents current completion time from missing, recovered or unusable timing: %j', (metadata) => {
      expect(preservedExecutionTimes({ arm: ARM, ...metadata }).finishedAt).toBeNull();
    },
  );
  it('rejects a completion timestamp preceding task execution', () => {
    expect(preservedExecutionTimes({ arm: ARM, startedAt: start, finishedAt: '2026-06-15T00:00:00Z' }).finishedAt).toBeNull();
  });
});

function fixtureRun(): PreservedArmRun {
  return {
    arm: ARM,
    runId: 'xbench-recover-hive-realqueen-1',
    startedAt: '2026-06-16T04:47:56.836Z',
    wallMs: 0,
    peakConcurrentBees: 0,
    taskCount: 11,
    nonEmptyDiffs: 8,
    totals: { costUsd: 33.97, tokensIn: 19727, tokensOut: 250219 },
    perTask: ALL.map((instanceId, i) => ({
      instanceId,
      cupId: `s-${i}`,
      disposition: 'spawn',
      // flipt + vuls produced empty diffs (no-diff → cost 0).
      stopReason: instanceId.includes('flipt') || instanceId.includes('vuls') ? 'no-diff' : 'done',
      tokensIn: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 3000 + i,
      tokensOut: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 30000 + i,
      costUsd: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 4 + i * 0.1,
      turns: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 1,
      wallClockMs: 0,
      diffBytes: instanceId.includes('flipt') || instanceId.includes('vuls') ? 0 : 3000 + i,
    })),
    coordEvents: [
      { ts: 1, kind: 'placement', agent: 's-0', taskId: ALL[0], detail: 'placed' },
      { ts: 2, kind: 'rework', agent: 's-1', taskId: ALL[1] },
      { ts: 3, kind: 'rework', agent: 's-2', taskId: ALL[2] },
      { ts: 4, kind: 'stranded_item', agent: 's-3', taskId: ALL[3] },
      { ts: 5, kind: 'complete', agent: 's-0', taskId: ALL[0] },
    ],
    recovered: true,
  };
}

function gradeMap(): Record<string, boolean> {
  const m: Record<string, boolean> = {};
  for (const id of RESOLVED_TRUE) m[id] = true;
  for (const id of RESOLVED_FALSE) m[id] = false;
  return m;
}

// ── Pure merge + summary (no disk) ──────────────────────────────────────────

describe('mergeResolved', () => {
  it('joins the grade verdict onto each perTask row by instanceId', () => {
    const merged = mergeResolved(fixtureRun().perTask!, gradeMap());
    expect(merged).toHaveLength(11);
    const byId = new Map(merged.map((r) => [r.instanceId, r.resolved]));
    expect(byId.get(RESOLVED_TRUE[0])).toBe(true);
    expect(byId.get(RESOLVED_FALSE[0])).toBe(false);
  });

  it('marks resolved=null (not false) when the grade map has no entry for the row', () => {
    const partial = { [RESOLVED_TRUE[0]]: true };
    const merged = mergeResolved(fixtureRun().perTask!, partial);
    expect(merged.find((r) => r.instanceId === RESOLVED_TRUE[0])!.resolved).toBe(true);
    // Every other row is ungraded → null, NOT a silent false.
    expect(merged.filter((r) => r.resolved === null)).toHaveLength(10);
    expect(merged.filter((r) => r.resolved === false)).toHaveLength(0);
  });

  it('marks every row null when there is no grade map', () => {
    const merged = mergeResolved(fixtureRun().perTask!, null);
    expect(merged.every((r) => r.resolved === null)).toBe(true);
  });
});

describe('summarizePreservedRun', () => {
  it('counts 6 resolved of 11 graded = 54.5%', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    expect(s.gradedCount).toBe(11);
    expect(s.resolvedCount).toBe(6);
    expect(s.taskCount).toBe(11);
    expect(s.resolvedPct).toBeCloseTo(6 / 11, 5);
  });

  it('prefers the snapshot totals over summing perTask', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    expect(s.costUsd).toBe(33.97);
    expect(s.tokensIn).toBe(19727);
    expect(s.tokensOut).toBe(250219);
  });

  it('sums perTask cost when the snapshot has no totals', () => {
    const run = { ...fixtureRun(), totals: undefined };
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    const expected = merged.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    expect(s.costUsd).toBeCloseTo(expected, 5);
  });

  it('carries coordEvent count, recovered flag and nonEmptyDiffs through', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, gradeMap());
    const s = summarizePreservedRun(run, merged);
    expect(s.coordEventCount).toBe(5);
    expect(s.recovered).toBe(true);
    expect(s.nonEmptyDiffs).toBe(8);
  });

  it('resolvedPct is null when nothing is graded', () => {
    const run = fixtureRun();
    const merged = mergeResolved(run.perTask!, null);
    expect(summarizePreservedRun(run, merged).resolvedPct).toBeNull();
  });
});

// ── FAIRNESS (benchmark-fairness-fix): external/transient/infra rows EXCLUDED from resolved% ─────────
describe('summarizePreservedRun — fairness exclusion', () => {
  function fairnessRun(): PreservedArmRun {
    // 5 tasks: 2 scored-resolved, 1 scored-fail, and 2 NON-scored (a timeout + an infra-failed) that must
    // be EXCLUDED from the denominator — not counted as capability fails.
    return {
      arm: 'hive-realqueen',
      runId: 'fairness-run',
      taskCount: 5,
      perTask: [
        { instanceId: 'ok-1', stopReason: 'done', diffBytes: 100 },
        { instanceId: 'ok-2', stopReason: 'done', diffBytes: 100 },
        { instanceId: 'fail-1', stopReason: 'escalate', diffBytes: 100 }, // a GENUINE non-resolution (scored)
        { instanceId: 'timeout-1', stopReason: 'timeout', diffBytes: 0 }, // wall-clock under contention → excluded
        { instanceId: 'infra-1', stopReason: 'infra-failed', generationError: '429 contention', diffBytes: 0 }, // excluded
      ],
    };
  }
  // The grader (wrongly, pre-fix) returned a verdict for EVERY instance, incl. the infra ones.
  const fullGrade = (): Record<string, boolean> => ({
    'ok-1': true,
    'ok-2': true,
    'fail-1': false,
    'timeout-1': false, // a grader-manufactured false on a never-fairly-run task — must NOT count as a fail
    'infra-1': false, // ditto
  });

  it('excludes timeout / infra-failed rows from the denominator even if the grade map has a (false) verdict', () => {
    const run = fairnessRun();
    const merged = mergeResolved(run.perTask!, fullGrade());
    const s = summarizePreservedRun(run, merged);
    // Denominator is the 3 SCORED tasks (ok-1, ok-2, fail-1), NOT all 5.
    expect(s.gradedCount).toBe(3);
    expect(s.resolvedCount).toBe(2);
    expect(s.infraExcluded).toBe(2); // timeout-1 + infra-1
    expect(s.resolvedPct).toBeCloseTo(2 / 5, 5);
    expect(s.conditionalResolvedPct).toBeCloseTo(2 / 3, 5);
    expect(s.taskCount).toBe(5); // taskCount still reflects the whole set
  });

  it('a timeout/infra row contributes ZERO to resolvedCount and is never a fail', () => {
    const run = fairnessRun();
    // Even with NO grade entries for the infra rows (the grade-path fix omits them), the result is identical.
    const partialGrade: Record<string, boolean> = { 'ok-1': true, 'ok-2': true, 'fail-1': false };
    const merged = mergeResolved(run.perTask!, partialGrade);
    const s = summarizePreservedRun(run, merged);
    expect(s.gradedCount).toBe(3);
    expect(s.resolvedCount).toBe(2);
    expect(s.infraExcluded).toBe(2);
    expect(s.resolvedPct).toBeCloseTo(2 / 5, 5);
    expect(s.conditionalResolvedPct).toBeCloseTo(2 / 3, 5);
  });
});

describe('assigned task outcomes', () => {
  it('keeps absent tasks and generation timeouts in the primary denominator', () => {
    const run: PreservedArmRun = { arm: 'su', taskCount: 5 };
    const summary = summarizePreservedRun(run, [
      { instanceId: 'solved', stopReason: 'done', resolved: true },
      { instanceId: 'capped', stopReason: 'timeout', resolved: null },
    ]);
    expect(summary).toMatchObject({ taskCount: 5, attemptedCount: 2, absentCount: 3,
      gradedCount: 1, resolvedCount: 1, infraExcluded: 1, missingGradeCount: 0,
      measurementComplete: true, resolvedPct: 0.2, conditionalResolvedPct: 1 });
  });

  it('reports a grader outage as missing measurement, then accepts a repaired grade', () => {
    const run: PreservedArmRun = { arm: 'su', config: { taskIds: ['a', 'b', 'c'] } };
    const rows = [{ instanceId: 'a', stopReason: 'done', resolved: null }];
    expect(summarizePreservedRun(run, rows)).toMatchObject({ taskCount: 3,
      missingGradeCount: 1, measurementComplete: false, resolvedPct: null });
    expect(summarizePreservedRun(run, [{ ...rows[0], resolved: true }])).toMatchObject({
      taskCount: 3, missingGradeCount: 0, resolvedPct: 1 / 3 });
  });

  it('counts queued placeholders as non-attempts and sums all spent cost', () => {
    const summary = summarizePreservedRun({ arm: 'su', taskCount: 3 }, [
      { instanceId: 'a', taskStatus: 'todo', resolved: null },
      { instanceId: 'b', taskStatus: 'in_progress', costUsd: 2, resolved: null },
      { instanceId: 'c', taskStatus: 'graded', costUsd: 1, generationError: '', resolved: true },
    ]);
    expect(summary).toMatchObject({ attemptedCount: 1, absentCount: 2,
      missingGradeCount: 0, resolvedPct: 1 / 3, costUsd: 3 });
  });
});

describe('isSafeRunId', () => {
  it('accepts plain run ids', () => {
    expect(isSafeRunId('m3-realqueen-2026-06-16')).toBe(true);
    expect(isSafeRunId('run_1.2')).toBe(true);
  });
  it('rejects traversal / separators', () => {
    for (const bad of ['..', '.', '../x', 'a/b', 'a\\b', '/abs', 'a b']) {
      expect(isSafeRunId(bad)).toBe(false);
    }
  });
});

// ── Disk read against a fixture dir ─────────────────────────────────────────

describe('disk read', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'preserved-runs-'));
    const dir = join(base, RUN_ID);
    mkdirSync(join(dir, `grade-${ARM}`, 'out'), { recursive: true });
    writeFileSync(join(dir, `${ARM}.json`), JSON.stringify(fixtureRun()));
    writeFileSync(join(dir, `grade-${ARM}`, 'out', 'eval_results.json'), JSON.stringify(gradeMap()));
    // Sibling artifacts the resolver must ignore.
    writeFileSync(join(dir, 'README.md'), '# run');
    writeFileSync(join(dir, 'tasks-sample.jsonl'), '{}');
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('resolveArmFile picks the single arm json, ignoring siblings', () => {
    expect(resolveArmFile(join(base, RUN_ID))).toBe(ARM);
  });

  it('listPreservedRuns finds the run with its arm', () => {
    const runs = listPreservedRuns(base);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: RUN_ID, arm: ARM });
  });

  it('readGradeMap reads the verdict map', () => {
    const g = readGradeMap(join(base, RUN_ID), ARM);
    expect(g?.[RESOLVED_TRUE[0]]).toBe(true);
    expect(Object.values(g ?? {}).filter(Boolean)).toHaveLength(6);
  });

  it('readPreservedRun merges + summarizes the whole run', () => {
    const detail = readPreservedRun(RUN_ID, base);
    expect(detail).not.toBeNull();
    expect(detail!.summary.resolvedCount).toBe(6);
    expect(detail!.summary.taskCount).toBe(11);
    expect(detail!.perTask.filter((t) => t.resolved === true)).toHaveLength(6);
    // coordRates derived from the trace (1 rework on s-1, 1 on s-2, 1 stranded).
    expect(detail!.coordRates.counts.redundant).toBe(2);
    expect(detail!.coordRates.counts.breakdown).toBe(1);
  });

  it('preserves the archived model identity without substituting a configured model', () => {
    const id = 'explicit-model';
    const dir = join(base, id);
    mkdirSync(dir);
    writeFileSync(join(dir, `${ARM}.json`), JSON.stringify({
      ...fixtureRun(), model: 'provider-model-frozen-version',
    }));
    expect(readPreservedRun(id, base)!.run.model).toBe('provider-model-frozen-version');
  });

  it('leaves absent model provenance unknown for the importing caller', () => {
    const id = 'missing-model';
    const dir = join(base, id);
    mkdirSync(dir);
    writeFileSync(join(dir, `${ARM}.json`), JSON.stringify(fixtureRun()));
    expect(readPreservedRun(id, base)!.run.model).toBeUndefined();
  });

  it('returns null for a missing / unsafe run id', () => {
    expect(readPreservedRun('nope', base)).toBeNull();
    expect(readPreservedRun('../etc', base)).toBeNull();
  });

  it.each([
    { instances: 103, overall: { score: 1 } },
    { arm: ARM, perTask: [] },
    { arm: ARM, perTask: [null] },
    { arm: ARM, perTask: [{ instanceId: '' }] },
    { arm: ARM, perTask: [{ instanceId: 'duplicate' }, { instanceId: 'duplicate' }] },
  ])('rejects non-run or malformed archive records: %j', (value) => {
    const dir = join(base, 'invalid-record');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'summary.json'), JSON.stringify(value));
    try {
      expect(readPreservedRun('invalid-record', base)).toBeNull();
      expect(inspectPreservedRun('invalid-record', base).kind).toBe('invalid');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies absent evidence separately from invalid run content', () => {
    expect(inspectPreservedRun('does-not-exist', base).kind).toBe('unavailable');
  });

  it('does not accept a malformed grade map as verdict evidence', () => {
    const dir = join(base, 'invalid-grades');
    mkdirSync(join(dir, `grade-${ARM}`, 'out'), { recursive: true });
    writeFileSync(join(dir, `grade-${ARM}`, 'out', 'eval_results.json'), JSON.stringify({ task: 'passed' }));
    expect(readGradeMap(dir, ARM)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns [] when the base dir does not exist', () => {
    expect(listPreservedRuns(join(base, 'does-not-exist'))).toEqual([]);
  });
});
