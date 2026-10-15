/**
 * WI-10005713 — the raw test router's restricted-write preflight (scripts/lib/restricted-hold-preflight.mjs).
 * The census and reach walk are restricted-hold-fence.ts (tested there); this suite pins the PROCESS
 * contract: the router fails CLOSED on every result that is not an explicit, exit-coded admit, and
 * skips only the two documented duplicate-check cases.
 *
 * Lives in operator-core (like test-file-router.test.ts) so the gate's test:lane-pure selects it;
 * a test beside the module under scripts/lib runs only under the root config, which no gate task runs.
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER,
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST,
  RESTRICTED_HOLD_PREFLIGHT_CLI,
  RESTRICTED_HOLD_PREFLIGHT_DONE,
  RESTRICTED_HOLD_PREFLIGHT_ENV,
  RESTRICTED_HOLD_PREFLIGHT_EXIT,
  RESTRICTED_HOLD_PREFLIGHT_MARKER,
  COMMITTED_SOURCE_LOADER,
  censusSpawnArgs,
  formatRestrictedHoldRefusal,
  formatVitestRestrictedHoldRefusal,
  interpretRestrictedHoldPreflight,
  restrictedHoldPreflightSkipReason,
  runRestrictedHoldPreflight,
  runVitestRootPreflight,
  vitestRootPreflightSkipReason,
} from '../../../../scripts/lib/restricted-hold-preflight.mjs';

const line = (payload: unknown) => `${RESTRICTED_HOLD_PREFLIGHT_MARKER} ${JSON.stringify(payload)}\n`;
const UNRESTRICTED_ENV = { PATH: '/usr/bin' };
// WI-10005764: every census spawn loads the committed-source loader BEFORE tsx.
const CENSUS_PREFIX = ['--import', COMMITTED_SOURCE_LOADER, '--import', 'tsx', RESTRICTED_HOLD_PREFLIGHT_CLI];
const LOADER_OPTION = `--import=${pathToFileURL(COMMITTED_SOURCE_LOADER).href}`;

describe('interpretRestrictedHoldPreflight — fail closed', () => {
  it('admits only an explicit admit verdict with the admit exit code', () => {
    expect(interpretRestrictedHoldPreflight({ status: 0, stdout: line({ verdict: 'admit' }) })).toEqual({ verdict: 'admit' });
  });

  it('passes a refusal through verbatim', () => {
    const refusal = { verdict: 'refuse', error: 'restricted_write_held', hint: 'tests/x.test.ts is itself a held restricted write' };
    expect(interpretRestrictedHoldPreflight({ status: RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse, stdout: line(refusal) })).toEqual(refusal);
  });

  it.each([
    ['no verdict line', { status: 0, stdout: 'some unrelated output\n' }],
    ['an empty stdout', { status: 0, stdout: '' }],
    ['an unparseable verdict', { status: 0, stdout: `${RESTRICTED_HOLD_PREFLIGHT_MARKER} {not json\n` }],
    ['an admit verdict with a non-admit exit', { status: 1, stdout: line({ verdict: 'admit' }) }],
    ['an unknown verdict', { status: 0, stdout: line({ verdict: 'maybe' }) }],
    ['a refusal missing its hint', { status: 3, stdout: line({ verdict: 'refuse', error: 'restricted_write_held' }) }],
    ['a kill signal', { status: null, signal: 'SIGTERM', stdout: '' }],
    ['a spawn error', { status: null, error: new Error('spawnSync node ETIMEDOUT'), stdout: '' }],
  ])('refuses as restricted_hold_state_unknown on %s', (_label, result) => {
    const verdict = interpretRestrictedHoldPreflight(result);
    expect(verdict.verdict).toBe('refuse');
    expect(verdict).toMatchObject({ error: 'restricted_hold_state_unknown' });
  });

  it('reads the LAST verdict line, so earlier noise cannot pose as the verdict', () => {
    const stdout = line({ verdict: 'admit' }) + line({ verdict: 'refuse', error: 'restricted_write_held', hint: 'held' });
    expect(interpretRestrictedHoldPreflight({ status: 3, stdout }).verdict).toBe('refuse');
  });

  it('keeps the originating loader error as well as final frames without admitting', () => {
    const stderr = 'Error [TransformError]: You installed esbuild for another platform.\n'
      + 'Present @esbuild/linux-x64; required @esbuild/linux-arm64.\n'
      + 'at nextLoad\nat AsyncLoaderHooksOnLoaderHookWorker.load\nNode.js v24.18.1';
    const result = interpretRestrictedHoldPreflight({ status: 1, stdout: '', stderr });
    expect(result).toMatchObject({ verdict: 'refuse', error: 'restricted_hold_state_unknown' });
    if (result.verdict !== 'refuse') throw new Error(`expected a refusal, got ${result.verdict}`);
    expect(result.hint).toContain('Present @esbuild/linux-x64; required @esbuild/linux-arm64');
    expect(result.hint).toContain('AsyncLoaderHooksOnLoaderHookWorker.load');
  });

  it('bounds noisy multiline and single-line failures while keeping both ends', () => {
    for (const filler of ['x'.repeat(10000), 'noise\n'.repeat(2000)]) {
      const result = interpretRestrictedHoldPreflight({ status: 1, stdout: '',
        stderr: 'ORIGINATING_LOADER_FAILURE\n' + filler + '\nFINAL_LOADER_FRAME' });
      expect(result).toMatchObject({ verdict: 'refuse', error: 'restricted_hold_state_unknown' });
      if (result.verdict !== 'refuse') throw new Error(`expected a refusal, got ${result.verdict}`);
      expect(result.hint).toContain('ORIGINATING_LOADER_FAILURE');
      expect(result.hint).toContain('FINAL_LOADER_FRAME');
      expect(result.hint.length).toBeLessThan(4000);
    }
  });
});

describe('restrictedHoldPreflightSkipReason', () => {
  it('skips only when testing:run already admitted the files, or when nested inside vitest', () => {
    expect(restrictedHoldPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_DONE })).toBe('testing-run');
    expect(restrictedHoldPreflightSkipReason({ VITEST: 'true' })).toBe('nested-in-vitest');
    expect(restrictedHoldPreflightSkipReason(UNRESTRICTED_ENV)).toBeNull();
  });

  it('does not treat an arbitrary value of the marker as a testing:run admission', () => {
    expect(restrictedHoldPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: '1' })).toBeNull();
  });

  it('skips a router whose process tree an enclosing router or vitest root already admitted', () => {
    for (const marker of [RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER, RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST]) {
      expect(restrictedHoldPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: marker })).toBe('admitted-upstream');
    }
  });

  it('skips inside the green-checkpoint gate only when BOTH gate markers are set', () => {
    expect(restrictedHoldPreflightSkipReason({ GREEN_CHECKPOINT: '1', PC_HEAVY_RELEASE_GATE: '1' })).toBe('release-gate');
    // GREEN_CHECKPOINT=1 alone is exported by hand to reproduce the gate's skip-set: not the gate.
    expect(restrictedHoldPreflightSkipReason({ GREEN_CHECKPOINT: '1' })).toBeNull();
    expect(restrictedHoldPreflightSkipReason({ PC_HEAVY_RELEASE_GATE: '1' })).toBeNull();
  });
});

// WI-10005724: the vitest ROOT door (libs/test-config host-preflight globalSetup).
describe('vitestRootPreflightSkipReason', () => {
  it('does NOT skip on VITEST: vitest sets it in its own main process, so it is present at every root', () => {
    expect(vitestRootPreflightSkipReason({ VITEST: 'true', TEST: 'true' })).toBeNull();
  });

  it('skips only for an upstream admission marker or a GitHub Actions runner', () => {
    expect(vitestRootPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_DONE })).toBe('testing-run');
    expect(vitestRootPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER })).toBe(
      'admitted-upstream',
    );
    expect(vitestRootPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST })).toBe(
      'admitted-upstream',
    );
    expect(vitestRootPreflightSkipReason({ GITHUB_ACTIONS: 'true' })).toBe('github-actions');
    expect(vitestRootPreflightSkipReason({ [RESTRICTED_HOLD_PREFLIGHT_ENV]: '1', CI: 'true' })).toBeNull();
  });

  // The gate runs committed code in an isolated checkout, and D-011 keeps held restricted writes out
  // of commits; a census there would fence nothing while making every gate vitest process depend on
  // Postgres (fail closed) and pay a census spawn.
  it('skips inside the green-checkpoint gate only when BOTH gate markers are set', () => {
    expect(vitestRootPreflightSkipReason({ VITEST: 'true', GREEN_CHECKPOINT: '1', PC_HEAVY_RELEASE_GATE: '1' })).toBe('release-gate');
    expect(vitestRootPreflightSkipReason({ VITEST: 'true', GREEN_CHECKPOINT: '1' })).toBeNull();
    expect(vitestRootPreflightSkipReason({ VITEST: 'true', PC_HEAVY_RELEASE_GATE: '1' })).toBeNull();
    expect(vitestRootPreflightSkipReason({ GREEN_CHECKPOINT: 'true', PC_HEAVY_RELEASE_GATE: 'true' })).toBeNull();
  });
});

describe('runVitestRootPreflight', () => {
  it('on admit hands back the vitest-root marker for the main-process env', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: line({ verdict: 'admit' }), stderr: '' }));
    expect(runVitestRootPreflight({ repoRoot: '/repo', files: ['/repo/a.test.ts'], env: { VITEST: 'true' }, spawn: spawn as never })).toEqual({
      verdict: 'admit',
      setEnv: { [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST },
    });
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args).toEqual([...CENSUS_PREFIX, '/repo', '/repo/a.test.ts']);
  });

  it('passes a refusal through and fails closed on a missing verdict, with no marker', () => {
    const refused = vi.fn(() => ({
      status: 3,
      signal: null,
      stdout: line({ verdict: 'refuse', error: 'restricted_write_held', hint: 'h' }),
      stderr: '',
    }));
    expect(runVitestRootPreflight({ repoRoot: '/repo', files: [], env: {}, spawn: refused as never })).toEqual({
      verdict: 'refuse',
      error: 'restricted_write_held',
      hint: 'h',
    });
    const silent = vi.fn(() => ({ status: 0, signal: null, stdout: '', stderr: '' }));
    expect(runVitestRootPreflight({ repoRoot: '/repo', files: [], env: {}, spawn: silent as never })).toMatchObject({
      verdict: 'refuse',
      error: 'restricted_hold_state_unknown',
    });
  });

  it('never spawns when an upstream root already admitted', () => {
    const spawn = vi.fn();
    expect(
      runVitestRootPreflight({
        repoRoot: '/repo',
        files: [],
        env: { [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_ROUTER },
        spawn: spawn as never,
      }),
    ).toEqual({ verdict: 'skipped', reason: 'admitted-upstream' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('formats its refusal as one greppable line that says nothing was measured', () => {
    expect(formatVitestRestrictedHoldRefusal({ error: 'restricted_write_held', hint: 'x is held' })).toBe(
      'VITEST_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none x is held',
    );
  });

  it('the convention module test-config loads exists and exports hostPreflight', async () => {
    const mod = await import('../../../../scripts/lib/vitest-host-preflight.mjs');
    expect(typeof mod.hostPreflight).toBe('function');
  });
});

describe('runRestrictedHoldPreflight', () => {
  it('spawns the operator-core CLI under tsx with the root and files, and interprets its verdict', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: line({ verdict: 'admit' }), stderr: '' }));
    const verdict = runRestrictedHoldPreflight({
      repoRoot: '/repo',
      files: ['/repo/a.test.ts', '/repo/b.test.ts'],
      env: UNRESTRICTED_ENV,
      spawn: spawn as never,
    });
    expect(verdict).toEqual({ verdict: 'admit' });
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string; env: unknown }];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([...CENSUS_PREFIX, '/repo', '/repo/a.test.ts', '/repo/b.test.ts']);
    expect(options).toMatchObject({ cwd: '/repo', env: { ...UNRESTRICTED_ENV, NODE_OPTIONS: LOADER_OPTION } });
  });

  it('never spawns when skipping, and says why', () => {
    const spawn = vi.fn();
    expect(
      runRestrictedHoldPreflight({ repoRoot: '/repo', files: [], env: { VITEST: 'true' }, spawn: spawn as never }),
    ).toEqual({ verdict: 'skipped', reason: 'nested-in-vitest' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('resolves the CLI to a real file in this repo, independent of the checked root', () => {
    expect(existsSync(RESTRICTED_HOLD_PREFLIGHT_CLI)).toBe(true);
    expect(existsSync(COMMITTED_SOURCE_LOADER)).toBe(true);
  });
});

// WI-10005764: the census's own closure lives in the tree it judges; the loader (first on the argv,
// and in NODE_OPTIONS for the processes the census forks) makes it run committed bytes only.
describe('censusSpawnArgs', () => {
  it('puts the loader before tsx on the argv and first in NODE_OPTIONS, keeping inherited options', () => {
    const { argv, env } = censusSpawnArgs(['--tree', '/repo'], { PATH: '/usr/bin', NODE_OPTIONS: '--max-old-space-size=4096' });
    expect(argv).toEqual([...CENSUS_PREFIX, '--tree', '/repo']);
    expect(env).toEqual({ PATH: '/usr/bin', NODE_OPTIONS: `${LOADER_OPTION} --max-old-space-size=4096` });
  });

  it('does not add the loader to NODE_OPTIONS twice when a census spawns inside another', () => {
    const once = censusSpawnArgs([], {}).env;
    expect(once.NODE_OPTIONS).toBe(LOADER_OPTION);
    expect(censusSpawnArgs([], once).env.NODE_OPTIONS).toBe(LOADER_OPTION);
  });

  it('never mutates the env it was given', () => {
    const given = { PATH: '/usr/bin' };
    censusSpawnArgs([], given);
    expect(given).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps census Git independent of inherited host sidecar routes', async () => {
    const { gitSidecarEnabled } = await import('../fleet/git-via-sidecar');
    const overrides = ['PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR', 'PAPERCUSP_DEV_DEPLOY_SPAWN_SIDECAR',
      'PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR', 'PAPERCUSP_FUTURE_READER_SPAWN_SIDECAR'];
    const given = { PATH: '/usr/bin', PAPERCUSP_CLUSTER: '16',
      PAPERCUSP_SPAWNER_IPC_SOCKET: '/foreign/host.sock', PAPERCUSP_SPAWNER_SIDECAR: '1',
      ...Object.fromEntries(overrides.map(key => [key, '1'])),
      PAPERCUSP_WORKSPACE_ID: 'private-verifier', PAPERCUSP_ADMISSION_CONTEXT: 'parent-lineage' };
    // Control: host-only overrides select the sidecar in a short-lived census.
    for (const key of overrides) expect(gitSidecarEnabled(key, given)).toBe(true);
    const { env } = censusSpawnArgs([], given);
    for (const key of overrides) expect(gitSidecarEnabled(key, env)).toBe(false);
    expect(env.PAPERCUSP_SPAWNER_IPC_SOCKET).toBeUndefined();
    expect(env.PAPERCUSP_SPAWNER_SIDECAR).toBeUndefined();
    expect(env.PAPERCUSP_CLUSTER).toBeUndefined();
    expect(env).toMatchObject({ PATH: '/usr/bin', PAPERCUSP_WORKSPACE_ID: 'private-verifier',
      PAPERCUSP_ADMISSION_CONTEXT: 'parent-lineage', NODE_OPTIONS: LOADER_OPTION });
    expect(given.PAPERCUSP_SPAWNER_IPC_SOCKET).toBe('/foreign/host.sock');
  });

  it('scrubs at the real census spawn boundary without losing a restricted-write refusal', async () => {
    const { gitSidecarEnabled } = await import('../fleet/git-via-sidecar');
    const { runBundleRestrictedHoldPreflight } = await import('../../../../scripts/lib/restricted-hold-preflight.mjs');
    const spawn = vi.fn((_command, _args, options) => {
      expect(gitSidecarEnabled('PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR', options.env)).toBe(false);
      expect(options.env.PAPERCUSP_SPAWNER_IPC_SOCKET).toBeUndefined();
      return { status: 3, stdout: line({ verdict: 'refuse', error: 'restricted_write_held', hint: 'source is held' }) };
    });
    expect(runBundleRestrictedHoldPreflight({ repoRoot: '/repo', inputsFile: '/repo/inputs.json',
      env: { PAPERCUSP_PLAN_AUDIT_SPAWN_SIDECAR: '1', PAPERCUSP_SPAWNER_IPC_SOCKET: '/foreign/host.sock' },
      spawn: spawn as never,
    })).toEqual({ verdict: 'refuse', error: 'restricted_write_held', hint: 'source is held' });
    expect(spawn).toHaveBeenCalledOnce();
  });
});

it('formats a refusal as one greppable line that says nothing was measured', () => {
  expect(formatRestrictedHoldRefusal({ error: 'restricted_write_held', hint: 'x is held' })).toBe(
    'TEST_FILE_RESTRICTED_HOLD_REFUSED error=restricted_write_held measured=none x is held',
  );
});
