import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExportBundle } from './export-bundle';

let baseDir: string;

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'bench-export-'));
  const dir = join(baseDir, 'run-x');
  mkdirSync(join(dir, 'diffs-hive-realqueen'), { recursive: true });
  writeFileSync(
    join(dir, 'hive-realqueen.json'),
    JSON.stringify({
      arm: 'hive-realqueen',
      runId: 'run-x',
      startedAt: '2026-06-16T04:00:00Z',
      perTask: [
        { instanceId: 'instance_a', diffBytes: 50 },
        { instanceId: 'instance_b', diffBytes: 0 },
      ],
    }),
    'utf8',
  );
  writeFileSync(join(dir, 'diffs-hive-realqueen', 'instance_a.diff'), 'diff --git a/x b/x\n+patch', 'utf8');
  writeFileSync(join(dir, 'diffs-hive-realqueen', 'instance_b.diff'), '', 'utf8');
});
afterAll(() => rmSync(baseDir, { recursive: true, force: true }));

describe('buildExportBundle', () => {
  it('assembles predictions + task ids + the official re-grade command + a README', () => {
    const b = buildExportBundle('run-x', { baseDir })!;
    expect(b).not.toBeNull();
    expect(b.arm).toBe('hive-realqueen');
    expect(b.taskCount).toBe(2);
    expect(b.nonEmptyPatches).toBe(1);
    expect(b.taskIds).toEqual(['instance_a', 'instance_b']);
    expect(b.predictions).toHaveLength(2);
    const a = b.predictions.find((p) => p.instance_id === 'instance_a')!;
    expect(a.patch).toContain('diff --git');
    expect(a.prefix).toBe('arm-hive-realqueen');
    // The exact public re-grade command + the caveats are in the bundle.
    expect(b.regradeCommand).toContain('swe_bench_pro_eval.py');
    expect(b.regradeCommand).toContain('--use_local_docker');
    expect(b.readme).toMatch(/Caveats/);
    expect(b.readme).toMatch(/Empty diffs/);
  });

  it('returns null when the run has no on-disk snapshot', () => {
    expect(buildExportBundle('missing', { baseDir })).toBeNull();
  });

  it('exports assigned non-attempts and the same primary/conditional outcome as run detail', () => {
    const dir = join(baseDir, 'assigned');
    mkdirSync(join(dir, 'grade-current', 'out'), { recursive: true });
    writeFileSync(join(dir, 'current.json'), JSON.stringify({
      arm: 'current', model: 'measured-model', config: { taskIds: ['a', 'b', 'c'] },
      perTask: [{ instanceId: 'a', stopReason: 'end_turn' }],
    }));
    writeFileSync(join(dir, 'grade-current', 'out', 'eval_results.json'), JSON.stringify({ a: true }));
    const b = buildExportBundle('assigned', { baseDir })!;
    expect(b.taskIds).toEqual(['a', 'b', 'c']);
    expect(b.taskCount).toBe(3);
    expect(b.predictions).toHaveLength(3);
    expect(b.outcomes[1]).toMatchObject({ instanceId: 'b', taskStatus: 'todo', resolved: null });
    expect(b.summary).toMatchObject({ taskCount: 3, attemptedCount: 1, absentCount: 2, resolvedPct: 1 / 3, conditionalResolvedPct: 1 });
    expect(b.assignmentIdentityComplete).toBe(true);
    expect(b.readme).toContain('Primary assigned outcome: 1/3');
    expect(b.readme).toContain('Conditional graded quality: 1/1');
    expect(b.readme).toContain('measured-model');
    expect(b.readme).not.toContain('Model: opus');
  });

  it('preserves missing grader measurement and unknown legacy assignment identity', () => {
    const dir = join(baseDir, 'missing-grade');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'current.json'), JSON.stringify({
      arm: 'current', taskCount: 3, perTask: [{ instanceId: 'a', stopReason: 'end_turn' }],
    }));
    const b = buildExportBundle('missing-grade', { baseDir })!;
    expect(b.summary).toMatchObject({ taskCount: 3, resolvedPct: null, missingGradeCount: 1 });
    expect(b.assignmentIdentityComplete).toBe(false);
    expect(b.readme).toContain('Primary assigned outcome: inconclusive');
    expect(b.readme).toContain('Recorded source model: unknown');
  });

  it('keeps the primary headline inconclusive when only some submissions are graded', () => {
    const dir = join(baseDir, 'partially-graded');
    mkdirSync(join(dir, 'grade-current', 'out'), { recursive: true });
    writeFileSync(join(dir, 'current.json'), JSON.stringify({
      arm: 'current', config: { taskIds: ['a', 'b', 'c'] },
      perTask: [
        { instanceId: 'a', stopReason: 'end_turn' },
        { instanceId: 'b', stopReason: 'end_turn' },
      ],
    }));
    writeFileSync(join(dir, 'grade-current', 'out', 'eval_results.json'), JSON.stringify({ a: true }));

    const b = buildExportBundle('partially-graded', { baseDir })!;
    expect(b.summary).toMatchObject({
      taskCount: 3, attemptedCount: 2, absentCount: 1,
      resolvedCount: 1, gradedCount: 1, missingGradeCount: 1,
      resolvedPct: null, conditionalResolvedPct: 1,
    });
    expect(b.readme).toContain('Primary assigned outcome: inconclusive');
    expect(b.readme).not.toContain('Primary assigned outcome: 1/3');
    expect(b.readme).toContain('Conditional graded quality: 1/1');
    expect(b.readme).toContain('Assigned: 3; attempted: 2; absent: 1; missing grader measurements: 1.');
  });
});
