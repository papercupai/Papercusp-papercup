import { describe, expect, it, vi } from 'vitest';
import type { RecordOperationalRunDeps } from './record-run';
import {
  BG_HOST_ID,
  GATE_REPAIR_PLANE_CHECK_PATH,
  IDLE_ACTUATOR_SOURCE_PATH,
  RELEASE_HOST_ID,
  R7_WINDOW_START,
  executeGateRepairPlaneReading,
  findPassMarkerSubject,
  judgeRepairPassMarker,
  judgeRepairQueueServing,
  type GateRepairPlaneQueries,
  type PassMarkerRecord,
  type RepairQueueServingCell,
} from './native-check-gate-repair-plane';

const byId = (assertions: Array<{ id: string; passed: boolean; evidence: string }>) =>
  Object.fromEntries(assertions.map(a => [a.id, a]));

describe('judgeRepairQueueServing (R-7 oracle)', () => {
  const staging = (n: number): RepairQueueServingCell => ({ servingHost: 'port-3170', hasBuildSelector: false, argsNull: false, n });

  it('passes when every selector-less call since the restart is off the release host and above the floor', () => {
    const a = byId(judgeRepairQueueServing({ cells: [staging(174)], total: 174 }));
    expect(Object.values(a).every(x => x.passed)).toBe(true);
  });

  it('fails on a single selector-less call served by the release host', () => {
    const cells = [staging(173), { servingHost: RELEASE_HOST_ID, hasBuildSelector: false, argsNull: false, n: 1 }];
    const a = byId(judgeRepairQueueServing({ cells, total: 174 }));
    expect(a['r7-no-selectorless-call-on-release-host']!.passed).toBe(false);
  });

  it('does not count a release-host call that carried an explicit build selector', () => {
    const cells = [staging(30), { servingHost: RELEASE_HOST_ID, hasBuildSelector: true, argsNull: false, n: 4 }];
    const a = byId(judgeRepairQueueServing({ cells, total: 34 }));
    expect(a['r7-no-selectorless-call-on-release-host']!.passed).toBe(true);
    expect(a['r7-sample-above-floor']!.evidence).toContain('30 selector-less');
  });

  it('counts a NULL-args call as selector-less, so one on the release host fails', () => {
    const cells = [staging(30), { servingHost: RELEASE_HOST_ID, hasBuildSelector: false, argsNull: true, n: 1 }];
    expect(byId(judgeRepairQueueServing({ cells, total: 31 }))['r7-no-selectorless-call-on-release-host']!.passed).toBe(false);
  });

  it('reads unknown (not passed) below the 20-call floor', () => {
    const a = byId(judgeRepairQueueServing({ cells: [staging(19)], total: 19 }));
    expect(a['r7-sample-above-floor']!.passed).toBe(false);
    expect(a['r7-sample-above-floor']!.evidence).toContain('unknown, not passed');
  });

  it('fails the partition when a selector-less call has no recorded serving host', () => {
    const cells = [staging(30), { servingHost: null, hasBuildSelector: false, argsNull: false, n: 2 }];
    expect(byId(judgeRepairQueueServing({ cells, total: 32 }))['r7-partition-exhaustive']!.passed).toBe(false);
  });

  it('fails the partition when the cells do not sum to the filtered row count', () => {
    expect(byId(judgeRepairQueueServing({ cells: [staging(30)], total: 31 }))['r7-partition-exhaustive']!.passed).toBe(false);
  });
});

describe('judgeRepairPassMarker (R-6 oracle)', () => {
  const MARKER = 'marker-v2';
  const DIRTY = 'f'.repeat(10);
  const GOOD = 'a'.repeat(10);
  const record = (id: string, createdAt: string, sha: string | null, over: Partial<PassMarkerRecord> = {}): PassMarkerRecord =>
    ({ id, createdAt, hostId: BG_HOST_ID, executingBuildSha: sha, queuePhase: 'ready-to-test', candidate: 'c'.repeat(40), ...over });
  const records = [
    record('10', '2026-10-27T10:00:00.000Z', DIRTY),
    record('11', '2026-10-27T10:30:00.000Z', null),
    record('20', '2026-10-27T12:02:06.943Z', GOOD),
    record('21', '2026-10-27T12:32:06.000Z', GOOD),
  ];
  const containment = { [DIRTY]: false, [GOOD]: true };
  const main = { sha: 'd'.repeat(40), containsMarker: false };

  it('picks the first record whose own stamped build contains the marker, skipping dirty-bundle and unstamped residue', () => {
    expect(findPassMarkerSubject(records, containment)?.id).toBe('20');
    const a = byId(judgeRepairPassMarker({ marker: MARKER, records, containment, mainAtSubject: main }));
    expect(Object.values(a).every(x => x.passed)).toBe(true);
    expect(a['r6-residue-recorded']!.evidence).toContain(`1 stamped ${DIRTY} (contains marker: false)`);
    expect(a['r6-residue-recorded']!.evidence).toContain('1 stamped <unresolved>');
  });

  it('fails when no stamped build contains the marker', () => {
    const a = byId(judgeRepairPassMarker({ marker: MARKER, records, containment: { [DIRTY]: false, [GOOD]: false }, mainAtSubject: null }));
    expect(a['r6-subject-carries-current-marker']!.passed).toBe(false);
  });

  it('treats an unreadable stamped commit as not containing the marker', () => {
    expect(findPassMarkerSubject(records, { [DIRTY]: null, [GOOD]: null })).toBeUndefined();
  });

  it('fails when main already contains the marker at the subject record', () => {
    const a = byId(judgeRepairPassMarker({ marker: MARKER, records, containment, mainAtSubject: { ...main, containsMarker: true } }));
    expect(a['r6-main-lacks-marker-at-subject']!.passed).toBe(false);
  });

  it('fails when main at the subject cannot be resolved or read', () => {
    expect(byId(judgeRepairPassMarker({ marker: MARKER, records, containment, mainAtSubject: { sha: null, containsMarker: null } }))
      ['r6-main-lacks-marker-at-subject']!.passed).toBe(false);
    expect(byId(judgeRepairPassMarker({ marker: MARKER, records, containment, mainAtSubject: { ...main, containsMarker: null } }))
      ['r6-main-lacks-marker-at-subject']!.passed).toBe(false);
  });

  it('fails when the subject was written by a host other than bg-host', () => {
    const moved = records.map(r => (r.id === '20' ? { ...r, hostId: 'port-3170' } : r));
    expect(byId(judgeRepairPassMarker({ marker: MARKER, records: moved, containment, mainAtSubject: main }))
      ['r6-subject-executor-is-bg-host']!.passed).toBe(false);
  });

  it('fails when the subject snapshot shows no open frozen queue (main not red)', () => {
    const green = records.map(r => (r.id === '20' ? { ...r, queuePhase: null } : r));
    expect(byId(judgeRepairPassMarker({ marker: MARKER, records: green, containment, mainAtSubject: main }))
      ['r6-main-red-at-subject']!.passed).toBe(false);
  });
});

describe('executeGateRepairPlaneReading (native, runtime-witnessed)', () => {
  function fixture(opts: { executedPort?: number; mainContains?: boolean; mainPath?: 'absent' | 'unreadable-commit' } = {}) {
    const persist = vi.fn(async (_params: Parameters<RecordOperationalRunDeps['persist']>[0]) => ({ written: 1, ids: [77] }));
    const readRuntime = vi.fn(async (_units: string[], _workspaceId: string) => 'c'.repeat(64));
    const execution = { sourceRoot: vi.fn(async () => process.cwd()),
      snapshot: vi.fn(() => ({ commit: 'b'.repeat(40), porcelain: '' })),
      readRuntime, verifyDefinition: vi.fn(async () => true), persist };
    const port = opts.executedPort ?? 5432;
    const queries: GateRepairPlaneQueries = {
      identity: vi.fn(async () => ({ database: 'papercusp', port: 5432 })),
      repairQueueServing: vi.fn(async () => ({ database: 'papercusp', port, total: 40,
        cells: [{ servingHost: 'port-3170', hasBuildSelector: false, argsNull: false, n: 40 }] })),
      passMarkerRecords: vi.fn(async () => ({ database: 'papercusp', port, records: [
        { id: '845672', createdAt: '2026-10-27T12:02:06.943Z', hostId: BG_HOST_ID, executingBuildSha: 'a'.repeat(40),
          queuePhase: 'ready-to-test', candidate: 'c'.repeat(40) }] })),
    };
    const git = vi.fn(async (_cwd: string, args: readonly string[]) => {
      if (args[0] === 'rev-list') return `${'d'.repeat(40)}\n`;
      const atMain = (args[0] === 'show' ? args[1]! : args[2]!).startsWith('d');
      if (atMain && opts.mainPath === 'absent') {
        // git show of a path the commit's tree lacks exits 128; ls-tree of that path prints nothing.
        if (args[0] === 'show') throw new Error(`fatal: path '${IDLE_ACTUATOR_SOURCE_PATH}' exists on disk, but not in 'ddd'`);
        if (args[0] === 'ls-tree') return '';
      }
      if (atMain && opts.mainPath === 'unreadable-commit') throw new Error('fatal: bad object ddd');
      if (args[0] === 'show') return atMain && !opts.mainContains ? 'no marker here' : 'export const M = "the-marker";';
      throw new Error(`unexpected git ${args.join(' ')}`);
    });
    const ctx = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() };
    return { persist, readRuntime, queries, git, ctx, deps: { queries, git, marker: 'the-marker', execution } };
  }
  const recorded = (f: ReturnType<typeof fixture>) => f.persist.mock.calls[0]![0].rows[0]!;

  it('records a passing R-7 row against this committed check, witnessing only the database unit', async () => {
    const f = fixture();
    expect(await executeGateRepairPlaneReading('r7-repair-queue-serving', f.ctx, f.deps))
      .toMatchObject({ ok: true, status: 'pass', testRunIds: [77], runtimeEnvironmentMeasured: true });
    expect(f.readRuntime.mock.calls[0]![0]).toEqual(['postgres:5432']);
    expect(f.queries.repairQueueServing).toHaveBeenCalledWith('papercusp-workspace', R7_WINDOW_START);
    expect(recorded(f).filePath).toBe(GATE_REPAIR_PLANE_CHECK_PATH);
  });

  it('records a passing R-6 row, reading the actuator file at the stamped build and at main-as-of-the-subject', async () => {
    const f = fixture();
    expect(await executeGateRepairPlaneReading('r6-pass-marker', f.ctx, f.deps)).toMatchObject({ ok: true, status: 'pass' });
    expect(f.git).toHaveBeenCalledWith(process.cwd(), ['show', `${'a'.repeat(40)}:${IDLE_ACTUATOR_SOURCE_PATH}`]);
    expect(f.git).toHaveBeenCalledWith(process.cwd(), ['rev-list', '-1', '--first-parent', '--before=2026-10-27T12:02:06Z', 'main']);
  });

  it('records a failing R-6 row when main already carries the marker', async () => {
    const f = fixture({ mainContains: true });
    expect(await executeGateRepairPlaneReading('r6-pass-marker', f.ctx, f.deps)).toMatchObject({ ok: true, status: 'fail' });
    expect(recorded(f).outputTail).toContain('r6-main-lacks-marker-at-subject');
  });

  it('reads main as lacking the marker when main predates the actuator file (path absent from a readable commit)', async () => {
    const f = fixture({ mainPath: 'absent' });
    expect(await executeGateRepairPlaneReading('r6-pass-marker', f.ctx, f.deps)).toMatchObject({ ok: true, status: 'pass' });
    expect(f.git).toHaveBeenCalledWith(process.cwd(), ['ls-tree', '--name-only', 'd'.repeat(40), '--', IDLE_ACTUATOR_SOURCE_PATH]);
  });

  it('still fails R-6 when main at the subject is an unreadable commit (absence is not inferred from an unreadable tree)', async () => {
    const f = fixture({ mainPath: 'unreadable-commit' });
    expect(await executeGateRepairPlaneReading('r6-pass-marker', f.ctx, f.deps)).toMatchObject({ ok: true, status: 'fail' });
    expect(recorded(f).outputTail).toContain('marker present there: unreadable');
  });

  it('records a failing row when execution reaches a different database than the one witnessed', async () => {
    const f = fixture({ executedPort: 6543 });
    expect(await executeGateRepairPlaneReading('r7-repair-queue-serving', f.ctx, f.deps)).toMatchObject({ ok: true, status: 'fail' });
    expect(recorded(f).outputTail).toContain('scope:database-unchanged');
  });

  it('refuses an unknown reading without querying or recording anything', async () => {
    const f = fixture();
    expect(await executeGateRepairPlaneReading('r9-nope' as never, f.ctx, f.deps)).toEqual({ ok: false, error: 'unknown_reading' });
    expect(f.queries.identity).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
  });
});
