/**
 * affected-tests-print-eta.test.ts — green-main-ratchet-convergence-2026-10-17#D-030
 * (WI-6554700010018036).
 *
 * `affected-tests.mjs --print-affected` prints one AFFECTED_ETA line: the projected wall time
 * of the radius it enumerated, from the same lane simulation and duration history the run's
 * own admission intent uses. sync-batch-delta-check admits a batch by that projection instead
 * of by task count (the count caps refused 588s radii and admitted a ~1750s one).
 *
 * Two layers: the pure projection (scaling of narrowed suites, coverage counts, the heaviest
 * task) and the real CLI's print mode with a controlled history file.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyAffectedBlastRadius,
  emptyDurationHistory,
  formatAffectedEtaLine,
  mergeDurationHistory,
  NARROWED_TASK_FLOOR_MS,
  planAffectedTaskShards,
  projectAffectedRunEta,
  writeDurationHistoryAtomic,
} from '../../../../scripts/lib/budgeted-task-scheduler.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

const config = {
  workerBudget: 4,
  memoryBudgetMb: 4096,
  workerMemoryMb: 1024,
  maxConcurrentTasks: 2,
  reserveWorkers: 1,
  deadlineEpochMs: null,
};

interface FakeTask {
  key: string;
  share: number | null;
}

const scoped = classifyAffectedBlastRadius({ changedPaths: ['packages/operator-core/lib/a.ts'] });

function project(tasks: FakeTask[], history: Record<string, number>) {
  const plan = planAffectedTaskShards(tasks, { blastRadius: scoped, taskKey: (t: FakeTask) => t.key });
  return projectAffectedRunEta(plan, {
    ...config,
    taskKey: (t: FakeTask) => t.key,
    estimateMs: (t: FakeTask) => history[t.key] ?? null,
    narrowedShare: (t: FakeTask) => t.share,
  });
}

describe('projectAffectedRunEta (D-030)', () => {
  it('scales a narrowed suite by its selection share and keeps full suites at their history', () => {
    const eta = project(
      [
        { key: 'core :: test:lane-pure', share: 0.25 },
        { key: 'web :: test', share: null },
      ],
      { 'core :: test:lane-pure': 800_000, 'web :: test': 588_000 },
    );
    // 800s x 0.25 = 200s on one lane, 588s on the other: the run ends when the longer lane does.
    expect(eta).toMatchObject({
      projectedSec: 588,
      workSec: 788,
      knownTasks: 2,
      tasks: 2,
      unknownTasks: 0,
      concurrency: 2,
      narrowedTasks: 1,
      heaviest: { key: 'web :: test', sec: 588 },
    });
  });

  it('floors a narrowed suite at the fixed startup cost and never projects it above its full history', () => {
    const floored = project([{ key: 'a :: test', share: 0.001 }], { 'a :: test': 600_000 });
    expect(floored.projectedSec).toBe(NARROWED_TASK_FLOOR_MS / 1000);
    const short = project([{ key: 'b :: test', share: 0.5 }], { 'b :: test': 10_000 });
    expect(short.projectedSec).toBe(10);
  });

  it('counts tasks with no history as unknown instead of projecting them as free', () => {
    const eta = project(
      [
        { key: 'known :: test', share: null },
        { key: 'new :: test', share: null },
      ],
      { 'known :: test': 120_000 },
    );
    expect(eta).toMatchObject({ projectedSec: 120, knownTasks: 1, tasks: 2, unknownTasks: 1 });
  });

  it('formats one whitespace-free key=value line, and an unavailable line on error', () => {
    const line = formatAffectedEtaLine(
      project([{ key: '@papercusp/web :: test', share: null }], { '@papercusp/web :: test': 588_000 }),
    );
    expect(line).toBe(
      'AFFECTED_ETA status=projected projectedSec=588 workSec=588 knownTasks=1 tasks=1 unknownTasks=0 ' +
        'concurrency=2 narrowedTasks=0 heaviestSec=588 heaviestTask=@papercusp/web::test',
    );
    expect(formatAffectedEtaLine({ error: 'history file is not json' })).toBe(
      'AFFECTED_ETA status=unavailable reason=history_file_is_not_json',
    );
  });
});

describe('affected-tests.mjs --print-affected prints AFFECTED_ETA (D-030)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'affected-eta-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function printAffected(historyPath: string): string[] {
    // package.json routes to repo-wide guards only, the cheapest real radius.
    const r = spawnSync(process.execPath, [AFFECTED_TESTS, '--changed-paths', 'package.json', '--print-affected'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, AFFECTED_TASK_HISTORY_PATH: historyPath },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
      killSignal: 'SIGKILL',
    });
    expect(r.status, `affected-tests --print-affected failed:\n${r.stderr}`).toBe(0);
    return (r.stdout ?? '').split('\n').filter(Boolean);
  }

  it('projects from the history file it is given and covers every selected task', () => {
    const cold = printAffected(join(dir, 'missing.json'));
    const tasks = cold.filter((l) => l.startsWith('AFFECTED_WS_CMD\t')).length;
    const guards = cold
      .filter((l) => l.startsWith('AFFECTED_GUARD\t'))
      .map((l) => l.split('\t'))
      .map(([, workspace, script]) => `${workspace} :: ${script}`);
    expect(tasks, 'the probe selected nothing, so this case proves nothing').toBeGreaterThan(0);
    const coldEta = cold.filter((l) => l.startsWith('AFFECTED_ETA '));
    expect(coldEta).toHaveLength(1);
    expect(coldEta[0]).toContain(`knownTasks=0 tasks=${tasks} unknownTasks=${tasks}`);
    expect(coldEta[0]).toContain('projectedSec=0');

    const historyPath = join(dir, 'history.json');
    writeDurationHistoryAtomic(
      historyPath,
      mergeDurationHistory(
        emptyDurationHistory(),
        guards.map((key) => ({ key, durationMs: 60_000 })),
      ),
      'affected-eta-test',
    );
    const warmEta = printAffected(historyPath).filter((l) => l.startsWith('AFFECTED_ETA '));
    expect(warmEta).toHaveLength(1);
    expect(warmEta[0]).toMatch(/^AFFECTED_ETA status=projected projectedSec=[1-9]\d* /);
    expect(warmEta[0]).toContain(`knownTasks=${guards.length} tasks=${tasks}`);
    expect(warmEta[0]).toContain('heaviestSec=60 ');
  });
});
