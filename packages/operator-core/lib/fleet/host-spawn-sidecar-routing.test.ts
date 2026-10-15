/**
 * WI-10004975 routing guard: each hot bg-host spawn site's PRODUCTION default goes through
 * the shared execFileViaSidecar seam (not a raw local execFile), under its own fallback
 * label and kill-switch var. A 13 GB bg-host spent 33–73% of main-thread samples forking
 * these short commands locally; if any default regresses to a raw execFile, its case
 * here fails because the seam is never called.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileViaSidecar = vi.hoisted(() => vi.fn());
vi.mock('./git-via-sidecar', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./git-via-sidecar')>()),
  execFileViaSidecar,
}));

beforeEach(() => {
  execFileViaSidecar.mockReset();
  execFileViaSidecar.mockResolvedValue({ stdout: 'ok', stderr: '' });
});

describe('bg-host spawn sites route through the spawner sidecar seam (WI-10004975)', () => {
  it('release-cut async unit-state reads use the sidecar and keep state text on a non-zero exit', async () => {
    const { readUnitActiveStateAsync } = await import('../release-cut-launch');
    const err = Object.assign(new Error('systemctl exited 3'), {
      code: 3,
      stdout: 'inactive\n',
      stderr: '',
    });
    execFileViaSidecar.mockRejectedValueOnce(err);
    await expect(readUnitActiveStateAsync('papercup-release-cut')).resolves.toBe('inactive');
    expect(execFileViaSidecar).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'is-active', 'papercup-release-cut'],
      { timeoutMs: 5000, subsystem: 'release-cut-launch' },
    );
  });

  it('single-primary async LoadState reads use the sidecar and preserve non-zero stdout', async () => {
    const { readBackgroundPrimaryLoadStateAsync } = await import('../system-health/single-primary-check');
    execFileViaSidecar.mockResolvedValueOnce({ stdout: 'masked\n', stderr: '' });
    await expect(readBackgroundPrimaryLoadStateAsync('papercusp-bg-host.service')).resolves.toBe('masked');
    expect(execFileViaSidecar).toHaveBeenNthCalledWith(
      1,
      'systemctl',
      ['--user', 'show', 'papercusp-bg-host.service', '-p', 'LoadState', '--value'],
      { timeoutMs: 5000, subsystem: 'single-primary-check' },
    );

    const err = Object.assign(new Error('systemctl exited 3'), {
      code: 3,
      stdout: 'not-found\n',
      stderr: '',
    });
    execFileViaSidecar.mockRejectedValueOnce(err);
    await expect(readBackgroundPrimaryLoadStateAsync('papercusp-bg-host.service')).resolves.toBe('not-found');
    expect(execFileViaSidecar).toHaveBeenNthCalledWith(
      2,
      'systemctl',
      ['--user', 'show', 'papercusp-bg-host.service', '-p', 'LoadState', '--value'],
      { timeoutMs: 5000, subsystem: 'single-primary-check' },
    );
  });

  it('task-manager scope-terminal-state: systemctl', async () => {
    const { defaultScopeTerminalExec, SCOPE_TERMINAL_SIDECAR_VAR } = await import('../task-manager/scope-terminal-state');
    await defaultScopeTerminalExec('systemctl', ['--user', 'reset-failed', 'x.scope'], { timeout: 4321 });
    expect(execFileViaSidecar).toHaveBeenCalledWith('systemctl', ['--user', 'reset-failed', 'x.scope'], {
      timeoutMs: 4321,
      subsystem: 'task-manager-scope-terminal',
      sidecarVar: SCOPE_TERMINAL_SIDECAR_VAR,
    });
  });

  it('supervision reconcile: systemctl --user and the unit journal', async () => {
    const mod = await import('../harness/routines/supervision-reconcile-action');
    await expect(mod.execSystemctlUser(['show', 'a.service'])).resolves.toBe('ok');
    await mod.readSystemdUserJournal('a.service');
    const expected = { timeoutMs: 10_000, subsystem: 'supervision-reconcile', sidecarVar: mod.SUPERVISION_RECONCILE_SIDECAR_VAR };
    expect(execFileViaSidecar).toHaveBeenNthCalledWith(1, 'systemctl', ['--user', 'show', 'a.service'], expected);
    expect(execFileViaSidecar).toHaveBeenNthCalledWith(
      2,
      'journalctl',
      ['--user', '-u', 'a.service', '--since=-10min', '--no-pager', '--lines=200'],
      expected,
    );
  });

  it('supervision reconcile: a non-zero exit still rejects (reconcileTick reads stdout off the error)', async () => {
    const err = Object.assign(new Error('Command failed'), { code: 3, stdout: 'Id=a.service\n', stderr: '' });
    execFileViaSidecar.mockRejectedValueOnce(err);
    const mod = await import('../harness/routines/supervision-reconcile-action');
    await expect(mod.execSystemctlUser(['show', 'a.service'])).rejects.toBe(err);
  });

  it('supervision reconcile: the 60 s drop-in install check (WI-10005118)', async () => {
    const mod = await import('../harness/routines/supervision-reconcile-action');
    await mod.runSystemdDropInInstallCheck();
    expect(execFileViaSidecar).toHaveBeenCalledTimes(1);
    const [command, args, opts] = execFileViaSidecar.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe(process.execPath);
    expect(args[1]).toBe('--list');
    expect(opts).toMatchObject({
      timeoutMs: 30_000,
      maxBuffer: 256 * 1024,
      subsystem: 'supervision-dropin-check',
      sidecarVar: mod.SUPERVISION_RECONCILE_SIDECAR_VAR,
    });
    expect(typeof opts.cwd).toBe('string');
  });

  it('service-health journal canary: journalctl', async () => {
    const { defaultJournalCanaryExec, JOURNAL_CANARY_SIDECAR_VAR } = await import('../service-health');
    await expect(defaultJournalCanaryExec(['--user', '-n', '1'], 2500)).resolves.toEqual({ stdout: 'ok' });
    expect(execFileViaSidecar).toHaveBeenCalledWith('journalctl', ['--user', '-n', '1'], {
      timeoutMs: 2500,
      maxBuffer: 64 * 1024,
      subsystem: 'journal-canary',
      sidecarVar: JOURNAL_CANARY_SIDECAR_VAR,
    });
  });

  it('gitnexus canary: cypher via the sidecar, and a failed child maps to null (unreadable), never 0', async () => {
    const { runCanaryCypher, GITNEXUS_CANARY_SIDECAR_VAR } = await import('../harness/routines/gitnexus-reindex-action');
    execFileViaSidecar.mockResolvedValueOnce({ stdout: '| n |\n| 7 |', stderr: '' });
    await expect(runCanaryCypher('gitnexus', '/repo', 'papercusp', 'MATCH (f) RETURN count(f)', 900)).resolves.toBe('| n |\n| 7 |');
    expect(execFileViaSidecar).toHaveBeenCalledWith('gitnexus', ['cypher', '--repo', 'papercusp', 'MATCH (f) RETURN count(f)'], {
      cwd: '/repo',
      timeoutMs: 900,
      maxBuffer: 4 * 1024 * 1024,
      subsystem: 'gitnexus-canary',
      sidecarVar: GITNEXUS_CANARY_SIDECAR_VAR,
    });
    execFileViaSidecar.mockRejectedValueOnce(Object.assign(new Error('segfault'), { code: 139, stdout: '', stderr: '' }));
    await expect(runCanaryCypher('gitnexus', '/repo', 'papercusp', 'q', 900)).resolves.toBeNull();
  });

  describe('keychain secret-tool + the probe memo', () => {
    const prevDir = process.env.PAPERCUSP_IDENTITY_DIR;
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'pc-keychain-routing-'));
      process.env.PAPERCUSP_IDENTITY_DIR = dir;
    });
    afterEach(async () => {
      (await import('../identity/keychain')).configureKeychainSecretToolExec(null);
      if (prevDir === undefined) delete process.env.PAPERCUSP_IDENTITY_DIR;
      else process.env.PAPERCUSP_IDENTITY_DIR = prevDir;
      rmSync(dir, { recursive: true, force: true });
    });

    it('routes the lookup through the seam and answers the probe once per TTL, re-probing after a delete', async () => {
      const kc = await import('../identity/keychain');
      // keychain.ts never imports the sidecar module (it is inside a bundled runtime worker's
      // graph); the host installs the route — exactly what hive-epoch-boot-deps does.
      (await import('./keychain-sidecar-exec')).installKeychainSidecarExec();
      kc.resetKeychainProbeTiersCacheForTest();
      const lookups = () =>
        execFileViaSidecar.mock.calls.filter(([cmd, args]) => cmd === 'secret-tool' && (args as string[])[0] === 'lookup').length;

      const t0 = 1_000_000;
      const first = await kc.keychainProbeTiersCached('dev:routing', 'svc-routing', t0);
      expect(first.file).toBeNull();
      expect(execFileViaSidecar).toHaveBeenCalledWith(
        'secret-tool',
        ['lookup', 'service', 'svc-routing', 'account', 'dev:routing'],
        { timeoutMs: 5000, subsystem: 'keychain-secret-tool', sidecarVar: kc.SECRET_TOOL_SIDECAR_VAR },
      );
      expect(lookups()).toBe(1);

      // Within the TTL: the memo answers, no second spawn.
      await kc.keychainProbeTiersCached('dev:routing', 'svc-routing', t0 + kc.PROBE_TIERS_TTL_MS - 1);
      expect(lookups()).toBe(1);

      // TTL elapsed: re-probe.
      await kc.keychainProbeTiersCached('dev:routing', 'svc-routing', t0 + kc.PROBE_TIERS_TTL_MS);
      expect(lookups()).toBe(2);

      // A delete changes the tiers: the memo entry is dropped, and `clear` also uses the seam.
      await kc.keychainDelete('dev:routing', 'svc-routing');
      expect(execFileViaSidecar).toHaveBeenCalledWith(
        'secret-tool',
        ['clear', 'service', 'svc-routing', 'account', 'dev:routing'],
        expect.objectContaining({ subsystem: 'keychain-secret-tool' }),
      );
      await kc.keychainProbeTiersCached('dev:routing', 'svc-routing', t0 + kc.PROBE_TIERS_TTL_MS);
      expect(lookups()).toBe(3);
    });
  });
});
