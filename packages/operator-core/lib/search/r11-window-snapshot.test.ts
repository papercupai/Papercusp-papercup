import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureR11JournalBoundary, publishR11SnapshotBytes, readR11SnapshotBytes, r11JournalDirectory, r11PreservationRoots, r11DiskAllocations } from './r11-window-snapshot';
import { inspectGovernorSource } from '../../../../scripts/check-resource-governor-enforcement.mjs';
import { executeGovernedByteProcess } from '../../../../scripts/lib/governed-test-process.mjs';
import { buildR11JournalCapturePlan, buildR11SystemdRunArgs, buildR11TargetQuery, buildR11TimerSpecs, evaluateR11Snapshots, R11_JOURNAL_MAX_BYTES, scheduleR11Timers, selectR11StageRows, type R11Snapshot } from './r11-window-snapshot';

const at = '2026-10-03T03:00:00.000Z';
const snapshot = (stage: R11Snapshot['stage'], offsetMs: number, rows: Array<{ key: string; stale: boolean }>): R11Snapshot => ({
  stage, capturedAt: new Date(Date.parse(at) + offsetMs).toISOString(), mode: 'gemma', profileId: 'gemma',
  targets: [{ table: 's.t', embedCol: 'embedding', keyCols: ['id'], predicateHash: 'p',
    rows: rows.map((row) => ({ ...row, recency: null })) }],
});
const cut = (24 * 60 - 10) * 60_000;
const end = 24 * 60 * 60_000;

describe('R-11 snapshot recovery', () => {
  it('budgets preflight and frozen captures in both copies plus all journal streams', () => {
    expect(r11DiskAllocations('/primary', { recoveryRoot: '/recovery', journalRoot: '/journals' }))
      .toEqual([{ path: '/primary', bytes: 32 * 1024 ** 3 },
        { path: '/recovery', bytes: 32 * 1024 ** 3 },
        { path: '/journals', bytes: 24 * 1024 ** 3 }]);
  });
  it('refuses an oversized snapshot before creating recovery or primary bytes', () => {
    const root = mkdtempSync(join(tmpdir(), 'r11-cap-'));
    try {
      expect(() => publishR11SnapshotBytes(join(root, 'snapshot'),
        { length: R11_JOURNAL_MAX_BYTES + 1 } as Buffer, join(root, 'recovery'))).toThrow('cap');
      expect(() => readFileSync(join(root, 'snapshot'))).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('rejects preservation aliases into primary, including children that do not exist yet', () => {
    const root = mkdtempSync(join(tmpdir(), 'r11-physical-'));
    try {
      const primary = join(root, 'primary');
      mkdirSync(primary);
      const alias = join(root, 'alias');
      symlinkSync(primary, alias, 'dir');
      for (const key of ['R11_RECOVERY_ROOT', 'R11_JOURNAL_ROOT']) {
        for (const destination of [alias, join(alias, 'missing', 'child')]) {
          expect(() => r11PreservationRoots(root, primary, { [key]: destination })).toThrow('outside');
        }
      }
      expect(() => r11JournalDirectory(alias, join(primary, 'missing'))).toThrow('outside');
      expect(() => r11JournalDirectory(primary, join(root, 'independent', 'missing'))).not.toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('defaults to canonical preservation and rejects destinations inside primary', () => {
    expect(r11PreservationRoots('/repo', '/backup/window', {})).toEqual({
      recoveryRoot: '/repo/.papercusp/evidence/r11-recovery', journalRoot: '/repo/.papercusp/evidence/r11-journals',
    });
    expect(r11PreservationRoots('/repo', '/backup/window', {
      R11_RECOVERY_ROOT: '/backup/recovery', R11_JOURNAL_ROOT: '/backup/journals',
    })).toEqual({ recoveryRoot: '/backup/recovery', journalRoot: '/backup/journals' });
    for (const key of ['R11_RECOVERY_ROOT', 'R11_JOURNAL_ROOT']) {
      expect(() => r11PreservationRoots('/repo', '/backup/window', { [key]: '/backup/window/nested' })).toThrow('outside');
      expect(() => r11PreservationRoots('/repo', '/backup/window', { [key]: 'relative' })).toThrow('absolute');
    }
  });
  it('retains bounded journal streams when the primary capture directory is removed', () => {
    const root = mkdtempSync(join(tmpdir(), 'r11-journal-preservation-'));
    try {
      const primary = join(root, 'primary');
      mkdirSync(primary);
      const preserved = r11JournalDirectory(primary, join(root, 'preserved'));
      mkdirSync(preserved, { recursive: true });
      const plan = buildR11JournalCapturePlan(buildR11TimerSpecs(snapshot('T0', 0, [])), preserved, Date.parse(at));
      for (const capture of plan.captures) {
        writeFileSync(capture.path, '{"before":true}\n');
        expect(capture.command).toContain(`--property=LimitFSIZE=${R11_JOURNAL_MAX_BYTES}`);
      }
      rmSync(primary, { recursive: true });
      for (const capture of plan.captures) {
        writeFileSync(capture.path, '{"after":true}\n', { flag: 'a' });
        expect(readFileSync(capture.path, 'utf8')).toBe('{"before":true}\n{"after":true}\n');
      }
      expect(r11JournalDirectory(primary + '/', join(root, 'preserved'))).toBe(preserved);
      expect(r11JournalDirectory(join(root, 'other'), join(root, 'preserved'))).not.toBe(preserved);
      expect(() => r11JournalDirectory(primary, primary)).toThrow('outside');
      expect(() => r11JournalDirectory(primary, join(primary, 'nested'))).toThrow('outside');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('recovers exact frozen bytes after the primary directory is deleted', () => {
    const root = mkdtempSync(join(tmpdir(), 'r11-recovery-'));
    try {
      const primaryDir = join(root, 'primary');
      mkdirSync(primaryDir);
      const primary = join(primaryDir, 't0.json.gz');
      const bytes = Buffer.from('original frozen snapshot');
      const recoveryRoot = join(root, 'recovery');
      const recovery = publishR11SnapshotBytes(primary, bytes, recoveryRoot);
      expect(readFileSync(recovery)).toEqual(bytes);
      rmSync(primaryDir, { recursive: true });
      expect(readR11SnapshotBytes(primary, recoveryRoot)).toEqual(bytes);
      expect(() => publishR11SnapshotBytes(primary, Buffer.from('replacement'), recoveryRoot)).toThrow();
      expect(readFileSync(recovery)).toEqual(bytes);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses conflicting primary bytes rather than concealing corruption', () => {
    const root = mkdtempSync(join(tmpdir(), 'r11-recovery-'));
    try {
      const primary = join(root, 't0.json.gz');
      const recoveryRoot = join(root, 'recovery');
      publishR11SnapshotBytes(primary, Buffer.from('original'), recoveryRoot);
      writeFileSync(primary, 'changed');
      expect(() => readR11SnapshotBytes(primary, recoveryRoot)).toThrow('disagree');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('R-11 admitted timer commands', () => {
  const specs = buildR11TimerSpecs(snapshot('T0', 0, []));
  const paths = { t0: '/evidence/t0.json.gz', cut: '/evidence/cut.json.gz', t1: '/evidence/t1.json.gz' };
  const runtime = { repoRoot: '/repo', tsx: '/repo/node_modules/.bin/tsx', script: '/repo/scripts/r11-window-snapshot.mts' };
  const success = { status: 0, signal: null, stdout: '', stderr: '', actualDemand: {} };
  const active = (index: number) => ({ ...success, stdout: `ActiveState=active\nUnit=${specs[index]!.unit}.service\n` });

  it('bounds both snapshot services independently of the scheduling process limits', () => {
    for (const spec of specs) {
      const command = buildR11SystemdRunArgs(spec, paths, runtime);
      expect(command).toContain(`--property=LimitFSIZE=${R11_JOURNAL_MAX_BYTES}`);
      expect(command).toContain('--property=UMask=0077');
    }
  });

  it('passes frozen preservation roots as literal arguments after loading the runtime environment', () => {
    const command = buildR11SystemdRunArgs(specs[1], paths, { ...runtime,
      recoveryRoot: '/backup/recovery space', journalRoot: '/backup/journal $literal' });
    expect(command.slice(command.indexOf('r11-capture') + 1, -4)).toEqual([
      '/usr/bin/env', 'R11_RECOVERY_ROOT=/backup/recovery space', 'R11_JOURNAL_ROOT=/backup/journal $literal',
      runtime.tsx, runtime.script,
    ]);
  });

  it('awaits the admitted start and verification for each timer', async () => {
    const execute = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce(active(0))
      .mockResolvedValueOnce(success).mockResolvedValueOnce(active(1));
    const timers = await scheduleR11Timers(specs, paths, runtime, false, execute);
    expect(timers.map(({ show }) => show)).toEqual([active(0).stdout, active(1).stdout]);
    expect(execute.mock.calls.map(([command]) => command)).toEqual(['systemd-run', 'systemctl', 'systemd-run', 'systemctl']);
    expect(execute).toHaveBeenNthCalledWith(1, 'systemd-run', buildR11SystemdRunArgs(specs[0], paths, runtime),
      new Uint8Array(), { namespace: 'r11-window-snapshot', timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
    expect(execute.mock.calls[1]![1]).toContain(`${specs[0].unit}.timer`);
  });

  it('starts no process for a dry run', async () => {
    const execute = vi.fn();
    expect(await scheduleR11Timers(specs, paths, runtime, true, execute)).toEqual(
      specs.map((spec) => ({ ...spec, command: buildR11SystemdRunArgs(spec, paths, runtime) })),
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not continue after admission refuses the first start', async () => {
    const execute = vi.fn().mockRejectedValue(new Error('admission refused'));
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute)).rejects.toThrow('admission refused');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stops every successfully started timer after bad verification, preserving the first error', async () => {
    const execute = vi.fn().mockResolvedValueOnce(success).mockResolvedValueOnce(active(0))
      .mockResolvedValueOnce(success).mockResolvedValueOnce({ ...success, stdout: 'ActiveState=failed' })
      .mockRejectedValueOnce(new Error('stop refused')).mockResolvedValueOnce(success);
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute)).rejects.toThrow(`Timer ${specs[1].unit} was not armed`);
    expect(execute.mock.calls.slice(4).map(([command, args]) => ({ command, args }))).toEqual(
      specs.map((spec) => ({ command: 'systemctl', args: ['--user', 'stop', `${spec.unit}.timer`] })),
    );
  });

  it.each([
    { ...success, status: 1, stderr: 'start failed' },
    { ...success, status: null, signal: 'SIGTERM' as const },
    { ...success, error: { code: 'ENOENT' } },
  ])('refuses unsuccessful process outcomes without arming the next timer', async (failure) => {
    const execute = vi.fn().mockResolvedValue(failure);
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute)).rejects.toThrow('systemd-run failed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps the canonical CLI free of unadmitted starts and detects a reintroduced start', () => {
    const source = readFileSync(new URL('../../../../scripts/r11-window-snapshot.mts', import.meta.url), 'utf8');
    expect(source).toContain('await scheduleR11Timers(');
    expect(source).toContain('r11PreservationRoots(repoRoot, dirname(path))');
    expect(source).toContain('r11JournalDirectory(dirname(path), preservation.journalRoot)');
    expect(source).toContain('preparedJournals, t0At: t0.capturedAt');
    expect(inspectGovernorSource(source)).not.toContain('resource-start-outside-admission');
    expect(source).toContain('await runGovernedTestProcess(');
    expect(inspectGovernorSource(source.replaceAll('runGovernedTestProcess', 'unadmittedProcess')))
      .toContain('resource-start-outside-admission');
  });
});

describe('R-11 journal producer bounds', () => {
  const specs = buildR11TimerSpecs(snapshot('T0', 0, []));
  const paths = { t0: '/evidence/t0.json.gz', cut: '/evidence/cut.json.gz', t1: '/evidence/t1.json.gz' };
  const runtime = { repoRoot: '/repo', tsx: '/repo/tsx', script: '/repo/capture.mts', journalDirectory: '/evidence/100%' };
  const now = () => Date.parse(at);
  const success = { status: 0, signal: null, stdout: '', stderr: '', actualDemand: {} };

  it('records unchanged live identities at T1 and rejects stopped, changed or late observations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'r11-boundary-'));
    const show = `ActiveState=active\nNRestarts=0\nMainPID=123\nInvocationID=${'a'.repeat(32)}\nExecMainStartTimestamp=${at}\n`;
    const captures = ['bg', 'bg-all', 'sidecar-anchored'].map((name) => {
      const path = join(directory, name);
      writeFileSync(path, `${name}\n`);
      return { unit: name, path, show };
    });
    const prepared = { specs, sinceMs: now(), captures };
    const execute = vi.fn(async () => ({ ...success, stdout: show }));
    const boundary = () => now() + end;
    try {
      const proof = await captureR11JournalBoundary(prepared, at, specs[1].at, execute, boundary);
      expect(proof.files.map((file) => file.bytes)).toEqual([3, 7, 17]);
      expect(proof.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
      for (const broken of [show.replace('active', 'inactive'), show.replace('MainPID=123', 'MainPID=456'),
        show.replace('NRestarts=0', 'NRestarts=1')]) {
        await expect(captureR11JournalBoundary(prepared, at, specs[1].at,
          async () => ({ ...success, stdout: broken }), boundary)).rejects.toThrow('identity changed');
      }
      await expect(captureR11JournalBoundary(prepared, at, specs[1].at, execute,
        () => boundary() + 60_001)).rejects.toThrow('missed T1');
      await expect(captureR11JournalBoundary(prepared, at, specs[1].at, execute,
        () => boundary() - 1)).rejects.toThrow('missed T1');
      expect(buildR11SystemdRunArgs(specs[1], paths, { ...runtime, preparedJournalsPath: '/receipt.json' }))
        .toContain('/receipt.json');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('prepares three bounded producers before T0 and adopts them without starting replacements', async () => {
    const preparationSpecs = buildR11TimerSpecs(snapshot('T0', 2 * 3600_000, []));
    const identity = `SubState=running\nResult=success\nNRestarts=0\nMainPID=123\nInvocationID=${'a'.repeat(32)}\nExecMainStartTimestamp=${new Date(now() - 1000).toISOString()}\n`;
    const execute = vi.fn(async (command: string, args: string[]) => {
      if (command === 'systemctl' && args.includes('show')) {
        const unit = args[2]!;
        return { ...success, stdout: unit.endsWith('.timer')
          ? `ActiveState=active\nUnit=${unit.replace('.timer', '.service')}\n`
          : `ActiveState=active\nRuntimeMaxUSec=1d 2h\nLimitFSIZE=${R11_JOURNAL_MAX_BYTES}\n${identity}` };
      }
      return success;
    });
    const prepared = await scheduleR11Timers(preparationSpecs, paths,
      { ...runtime, journalPreparation: true, journalSinceMs: now() }, false, execute, now);
    expect(prepared).toHaveLength(4);
    expect(execute.mock.calls.filter(([command]) => command === 'systemd-run')).toHaveLength(4);
    const receipt = { specs: preparationSpecs, sinceMs: now(), captures: prepared.filter(({ kind }) => kind === 'journal')
      .map(({ unit, path, show }) => ({ unit, path: path!, show: show! })) };
    execute.mockClear();
    const adopted = await scheduleR11Timers(specs, paths,
      { ...runtime, preparedJournals: receipt, t0At: at }, false, execute, now);
    expect(adopted.filter(({ kind }) => kind === 'journal').map(({ unit }) => unit)).toEqual(receipt.captures.map(({ unit }) => unit));
    expect(execute.mock.calls.filter(([command]) => command === 'systemd-run')).toHaveLength(3);
    expect(adopted[0].command?.slice(-3)).toEqual(receipt.captures.map(({ unit }) => `${unit}.service`));
    for (const defect of ['changed', 'late', 'restarted']) {
      const broken = structuredClone(receipt);
      if (defect === 'changed') broken.captures[0]!.show = identity.replace('MainPID=123', 'MainPID=999');
      const badExecute = vi.fn(async (command: string, args: string[]) => {
        const result = await execute(command, args);
        if (command === 'systemctl' && args.includes(`${receipt.captures[0]!.unit}.service`) && args.includes('show')) {
          result.stdout = result.stdout.replace(defect === 'late' ? new Date(now() - 1000).toISOString() : 'NRestarts=0',
            defect === 'late' ? new Date(now() + 1000).toISOString() : defect === 'restarted' ? 'NRestarts=1' : 'NRestarts=0');
        }
        return result;
      });
      await expect(scheduleR11Timers(specs, paths, { ...runtime, preparedJournals: broken, t0At: at },
        false, badExecute, now)).rejects.toThrow('identity changed');
      expect(badExecute.mock.calls.filter(([command, args]) => command === 'systemctl' && args.includes('stop'))
        .every(([, args]) => !args.some((arg) => /journal-.*\.service$/.test(arg)))).toBe(true);
    }
  });

  it('uses an independent frozen stop timer plus time and file-size limits for every follower', () => {
    const plan = buildR11JournalCapturePlan(specs, runtime.journalDirectory, now());
    expect(plan.deadline).toBe('2026-10-04T03:00:00.000Z');
    expect(plan.expiryCommand).toContain('--on-calendar=2026-10-04 03:10:00 UTC');
    expect(plan.expiryCommand.slice(-3)).toEqual(plan.captures.map(({ unit }) => `${unit}.service`));
    for (const follower of plan.captures) {
      expect(follower.command).toContain('--property=RuntimeMaxSec=86400');
      expect(follower.command).toContain(`--property=LimitFSIZE=${R11_JOURNAL_MAX_BYTES}`);
      expect(follower.command).toContain(`--property=StandardOutput=append:${follower.path.replace('%', '%%')}`);
    }
    expect(plan.captures[2].command.slice(-2)).toEqual(['-n', '1']);
    expect(plan.captures[1].command).toContain('--no-tail');
    expect(plan.captures[1].command).toContain(`--since=@${Date.parse(at) / 1000}`);
  });

  it('uses a calendar accepted by systemd for the bounded post-T1 tail', async () => {
    const plan = buildR11JournalCapturePlan(specs, runtime.journalDirectory, now());
    const calendar = plan.expiryCommand.find((arg) => arg.startsWith('--on-calendar='))!.slice('--on-calendar='.length);
    const result = await executeGovernedByteProcess('systemd-analyze', ['calendar', calendar], new Uint8Array(),
      { namespace: 'r11-window-snapshot', timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
    expect(result.error).toBeFalsy();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('2026-10-04 03:10:00');
  });

  it('rejects an expired window before starting anything and shows bounds in a dry run', async () => {
    const execute = vi.fn();
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute, () => now() + end))
      .rejects.toThrow('future frozen T1');
    expect(execute).not.toHaveBeenCalled();
    const preview = await scheduleR11Timers(specs, paths, runtime, true, execute, now);
    expect(preview).toHaveLength(6);
    expect(preview[0].command).toContain('/usr/bin/systemctl');
    expect(execute).not.toHaveBeenCalled();
  });

  it('rolls back owned followers and the expiry timer when a snapshot timer fails', async () => {
    const plan = buildR11JournalCapturePlan(specs, runtime.journalDirectory, now());
    const execute = vi.fn(async (command: string, args: string[]) => {
      if (command === 'systemd-run' && args.includes(`--unit=${specs[0].unit}`)) {
        return { ...success, status: 1, stderr: 'snapshot start failed' };
      }
      if (command === 'systemctl' && args.includes('show')) {
        return { ...success, stdout: args.includes(`${plan.expiryUnit}.timer`)
          ? `ActiveState=active\nUnit=${plan.expiryUnit}.service\n`
          : `ActiveState=active\nRuntimeMaxUSec=1d\nLimitFSIZE=${R11_JOURNAL_MAX_BYTES}\n` };
      }
      return success;
    });
    await expect(scheduleR11Timers(specs, paths, runtime, false, execute, now)).rejects.toThrow('snapshot start failed');
    expect(execute.mock.calls.filter(([command, args]) => command === 'systemctl' && args.includes('stop'))
      .map(([, args]) => args.at(-1))).toEqual([
      `${plan.expiryUnit}.timer`, ...plan.captures.map(({ unit }) => `${unit}.service`),
    ]);
  });

  it('refuses an ineffective runtime limit and stops a start that crossed the deadline in admission', async () => {
    for (const drift of [false, true]) {
      const plan = buildR11JournalCapturePlan(specs, runtime.journalDirectory, now());
      let clock = now();
      const execute = vi.fn(async (command: string, args: string[]) => {
        if (command === 'systemctl' && args.includes('show')) {
          if (args.includes(`${plan.expiryUnit}.timer`)) return { ...success, stdout: `ActiveState=active\nUnit=${plan.expiryUnit}.service\n` };
          if (drift) clock += end;
          return { ...success, stdout: `ActiveState=active\nRuntimeMaxUSec=${drift ? '1d' : 'infinity'}\nLimitFSIZE=${R11_JOURNAL_MAX_BYTES}\n` };
        }
        return success;
      });
      await expect(scheduleR11Timers(specs, paths, runtime, false, execute, () => clock)).rejects.toThrow('not bounded and active');
      expect(execute.mock.calls.filter(([command, args]) => command === 'systemctl' && args.includes('stop'))).toHaveLength(2);
      expect(execute.mock.calls.filter(([command]) => command === 'systemd-run')).toHaveLength(2);
    }
  });
});

describe('R-11 prospective snapshot', () => {
  it('uses shared sweep predicates and binds mode, exact profile and recipe', () => {
    const target = { table: 's.t', embedCol: 'embedding', bodySql: "coalesce(body, '')", keyCols: ['id'], recipeVersion: 2 };
    const query = buildR11TargetQuery(target, new Set(['id', 'embedding', 'body', 'embedding_mode', 'embedding_profile', 'embedding_recipe']),
      'gemma', { profileId: 'gemma-embeddinggemma-300m-768@v1', targetDims: 768, distanceMetric: 'cosine' });
    expect(query.query).toContain("length(coalesce(body, '')) > 0");
    expect(query.query).toContain('embedding_profile');
    expect(query.query).toContain('embedding_recipe');
    expect(query.params).toContain(2);
  });

  it('checks T0 and in-window eligible cohorts at the frozen T1', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }, { key: '[2]', stale: false }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[1]', stale: true }, { key: '[2]', stale: false }, { key: '[3]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[1]', stale: false }, { key: '[2]', stale: false }, { key: '[3]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('healthy');
    t1.targets[0]!.rows[2]!.stale = true;
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('failed');
  });

  it('keeps only newly eligible keys at Tcut and the frozen cohorts at T1', () => {
    const t0 = [{ key: '[1]', stale: true, recency: null }, { key: '[2]', stale: false, recency: null }];
    const now = [...t0, { key: '[3]', stale: true, recency: null }];
    const newKeys = selectR11StageRows('Tcut', now, t0);
    expect(newKeys.map((row) => row.key)).toEqual(['[3]']);
    expect(selectR11StageRows('T1', now, t0, newKeys).map((row) => row.key)).toEqual(['[1]', '[3]']);
  });

  it('keeps all-zero T0 and late captures inconclusive', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: false }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[1]', stale: false }, { key: '[2]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[2]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
    t0.targets[0]!.rows[0]!.stale = true;
    t1.capturedAt = new Date(Date.parse(at) + end + 61_000).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('freezes two UTC timer deadlines from the T0 database timestamp', () => {
    const t0 = snapshot('T0', 529, [{ key: '[1]', stale: true }]);
    expect(buildR11TimerSpecs(t0)).toEqual([
      { stage: 'Tcut', unit: `r11-p008-tcut-${Math.floor(Date.parse(t0.capturedAt) / 1000)}`,
        at: '2026-10-04 02:50:00 UTC' },
      { stage: 'T1', unit: `r11-p008-t1-${Math.floor(Date.parse(t0.capturedAt) / 1000)}`,
        at: '2026-10-04 03:00:00 UTC' },
    ]);
    expect(() => buildR11TimerSpecs(snapshot('Tcut', 0, []))).toThrow('T0 snapshot');
    t0.capturedAt = 'not-a-timestamp';
    expect(() => buildR11TimerSpecs(t0)).toThrow('invalid database timestamp');
  });

  it('passes frozen T0 and Tcut files to the correct one-shot user timers', () => {
    const [cutTimer, endTimer] = buildR11TimerSpecs(snapshot('T0', 0, []));
    const paths = { t0: '/evidence/t0.json.gz', cut: '/evidence/cut.json.gz', t1: '/evidence/t1.json.gz' };
    const runtime = { repoRoot: '/repo', tsx: '/repo/node_modules/.bin/tsx', script: '/repo/scripts/r11-window-snapshot.mts' };
    const common = (unit: string, at: string) => ['--user', `--unit=${unit}`, `--on-calendar=${at}`,
      `--property=LimitFSIZE=${R11_JOURNAL_MAX_BYTES}`, '--property=UMask=0077',
      '--timer-property=AccuracySec=1s', '--working-directory=/repo', '/usr/bin/bash', '-c',
      'set -a; . ./apps/operator/.env.local; set +a; exec "$@"', 'r11-capture', runtime.tsx, runtime.script];
    expect(buildR11SystemdRunArgs(cutTimer, paths, runtime)).toEqual([
      ...common(cutTimer.unit, cutTimer.at), 'Tcut', paths.cut, paths.t0,
    ]);
    expect(buildR11SystemdRunArgs(endTimer, paths, runtime)).toEqual([
      ...common(endTimer.unit, endTimer.at), 'T1', paths.t1, paths.t0, paths.cut,
    ]);
  });

  it('rejects malformed, early and out-of-order cutoff captures', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, []);
    const t1 = snapshot('T1', end, [{ key: '[1]', stale: false }]);
    for (const malformed of ['not-a-timestamp', '', '2026-99-99']) {
      tcut.capturedAt = malformed;
      expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
      tcut.capturedAt = new Date(Date.parse(at) + cut).toISOString();
      t1.capturedAt = malformed;
      expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
      t1.capturedAt = new Date(Date.parse(at) + end).toISOString();
    }
    tcut.capturedAt = new Date(Date.parse(at) - 1).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
    tcut.capturedAt = new Date(Date.parse(at) + cut).toISOString();
    t1.capturedAt = new Date(Date.parse(at) + cut - 1).toISOString();
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('does not pass clause 1 if all originally stale rows leave the eligible set', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, [{ key: '[2]', stale: true }]);
    const t1 = snapshot('T1', end, [{ key: '[2]', stale: false }]);
    expect(evaluateR11Snapshots(t0, tcut, t1).verdict).toBe('inconclusive');
  });

  it('does not let a passing target hide another target whose stale cohort disappeared', () => {
    const t0 = snapshot('T0', 0, [{ key: '[1]', stale: true }]);
    const tcut = snapshot('Tcut', cut, []);
    const t1 = snapshot('T1', end, []);
    t0.targets.push({ ...snapshot('T0', 0, [{ key: '[2]', stale: true }]).targets[0]!, table: 's.other' });
    tcut.targets.push({ ...snapshot('Tcut', cut, []).targets[0]!, table: 's.other' });
    t1.targets.push({ ...snapshot('T1', end, [{ key: '[2]', stale: false }]).targets[0]!, table: 's.other' });

    const result = evaluateR11Snapshots(t0, tcut, t1);
    expect(result.verdict).toBe('inconclusive');
    expect(result.targets.map(({ table, passed }) => ({ table, passed }))).toEqual([
      { table: 's.t', passed: false }, { table: 's.other', passed: true },
    ]);
  });
});
