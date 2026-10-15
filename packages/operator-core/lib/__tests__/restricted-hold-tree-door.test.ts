/**
 * WI-10005763 — the restricted-write TREE door (D-012, residue of WI-10005745).
 *
 * papercusp-desktop/bin/tauri-guarded `dev` and scripts/verify-tauri-headless.sh boot the app from
 * the live shared tree with network, so any held restricted write under the tree refuses. This
 * suite pins the three layers of that door:
 *   1. the wrapper (scripts/lib/restricted-hold-preflight.mjs): argv, root resolution, skip rules;
 *   2. the census CLI's --tree mode, end to end, through its VITEST-only test-census seam;
 *   3. each shell door, end to end, with a fake `node` that refuses: the door must stop before it
 *      boots anything, and must pass the gate ABSOLUTE roots.
 *
 * Lives in operator-core beside restricted-hold-preflight.test.ts so the gate's lane selects it.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST,
  RESTRICTED_HOLD_PREFLIGHT_CLI,
  RESTRICTED_HOLD_PREFLIGHT_ENV,
  RESTRICTED_HOLD_PREFLIGHT_EXIT,
  RESTRICTED_HOLD_PREFLIGHT_MARKER,
  COMMITTED_SOURCE_LOADER,
  censusSpawnArgs,
  formatTreeRestrictedHoldRefusal,
  runTreeRestrictedHoldPreflight,
  treeDoorPreflightSkipReason,
} from '../../../../scripts/lib/restricted-hold-preflight.mjs';

const REPO = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const line = (payload: unknown) => `${RESTRICTED_HOLD_PREFLIGHT_MARKER} ${JSON.stringify(payload)}\n`;

const scratch: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('treeDoorPreflightSkipReason', () => {
  it.each([
    [{}, null],
    [{ [RESTRICTED_HOLD_PREFLIGHT_ENV]: RESTRICTED_HOLD_PREFLIGHT_ADMITTED_BY_VITEST }, 'admitted-upstream'],
    [{ PC_HEAVY_RELEASE_GATE: '1', GREEN_CHECKPOINT: '1' }, 'release-gate'],
    [{ GREEN_CHECKPOINT: '1' }, null],
    [{ GITHUB_ACTIONS: 'true' }, 'github-actions'],
    [{ VITEST: 'true' }, 'nested-in-test-runner'],
    // node:test sets this on every test-file process; the desktop shell suites drive tauri-guarded under it.
    [{ NODE_TEST_CONTEXT: 'child-v8' }, 'nested-in-test-runner'],
    [{ [RESTRICTED_HOLD_PREFLIGHT_ENV]: 'not-a-known-marker' }, null],
  ])('%j → %s', (env, reason) => {
    expect(treeDoorPreflightSkipReason(env as NodeJS.ProcessEnv)).toBe(reason);
  });
});

describe('runTreeRestrictedHoldPreflight', () => {
  it('spawns the census CLI in --tree mode with ABSOLUTE roots, cwd at the first root', () => {
    const spawn = vi.fn(() => ({ status: 0, signal: null, stdout: line({ verdict: 'admit' }), stderr: '' }));
    const verdict = runTreeRestrictedHoldPreflight({ roots: ['relative/root', '/abs/other'], env: { PATH: '/usr/bin' }, spawn: spawn as never });
    expect(verdict).toEqual({ verdict: 'admit' });
    const [command, args, options] = spawn.mock.calls[0] as unknown as [string, string[], { cwd: string }];
    expect(command).toBe(process.execPath);
    const abs = resolve('relative/root');
    // WI-10005764: the committed-source loader precedes tsx, so the census runs committed bytes only.
    expect(args).toEqual(['--import', COMMITTED_SOURCE_LOADER, '--import', 'tsx', RESTRICTED_HOLD_PREFLIGHT_CLI, '--tree', abs, '/abs/other']);
    expect(options.cwd).toBe(abs);
  });

  it('passes a refusal through and never reads it as an admit', () => {
    const refusal = { verdict: 'refuse', error: 'restricted_write_held', hint: '1 held' };
    const spawn = vi.fn(() => ({ status: RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse, signal: null, stdout: line(refusal), stderr: '' }));
    expect(runTreeRestrictedHoldPreflight({ roots: ['/r'], env: {}, spawn: spawn as never })).toEqual(refusal);
  });

  it('fails closed with no root, and never spawns while skipping', () => {
    const spawn = vi.fn();
    expect(runTreeRestrictedHoldPreflight({ roots: [], env: {}, spawn: spawn as never })).toMatchObject({
      verdict: 'refuse',
      error: 'restricted_hold_state_unknown',
    });
    expect(runTreeRestrictedHoldPreflight({ roots: ['/r'], env: { NODE_TEST_CONTEXT: 'child-v8' }, spawn: spawn as never })).toEqual({
      verdict: 'skipped',
      reason: 'nested-in-test-runner',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('formats a refusal as one greppable line naming the door', () => {
    expect(formatTreeRestrictedHoldRefusal('tauri-dev', { error: 'restricted_write_held', hint: 'h' })).toBe(
      'RESTRICTED_HOLD_REFUSED door=tauri-dev error=restricted_write_held booted=none h',
    );
  });
});

describe('restricted-hold-preflight-cli --tree (end to end, test-census seam)', () => {
  function runCli(args: string[], census: unknown) {
    const dir = tempDir('wi5763-census-');
    const file = join(dir, 'census.json');
    writeFileSync(file, JSON.stringify(census));
    // The real door argv and env (loader first), so this also proves the census runs under the loader.
    const door = censusSpawnArgs(args, { ...process.env, VITEST: 'true', PAPERCUSP_RESTRICTED_HOLD_CENSUS_FILE: file });
    const result = spawnSync(process.execPath, door.argv, {
      cwd: REPO,
      env: door.env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    const verdictLine = result.stdout.split('\n').find((l) => l.startsWith(`${RESTRICTED_HOLD_PREFLIGHT_MARKER} `));
    return { status: result.status, verdict: verdictLine ? JSON.parse(verdictLine.slice(RESTRICTED_HOLD_PREFLIGHT_MARKER.length + 1)) : null };
  }

  it('admits when nothing is held, refuses when a write under the root is held, misuses with no root', () => {
    const root = tempDir('wi5763-tree-');
    const heldFile = join(root, 'src', 'held.ts');
    mkdirSync(join(root, 'src'));
    writeFileSync(heldFile, 'export {};\n');

    expect(runCli(['--tree', root], [])).toEqual({ status: RESTRICTED_HOLD_PREFLIGHT_EXIT.admit, verdict: { verdict: 'admit' } });

    const refused = runCli(['--tree', root], [{ path: heldFile, owner: 'su-restricted', intent: 'x' }]);
    expect(refused.status).toBe(RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse);
    expect(refused.verdict).toMatchObject({ verdict: 'refuse', error: 'restricted_write_held' });
    expect(refused.verdict.hint).toContain('src/held.ts');

    // A holding OUTSIDE every root is not this tree's business (control for the refusal above).
    const elsewhere = tempDir('wi5763-elsewhere-');
    expect(runCli(['--tree', root], [{ path: join(elsewhere, 'x.ts'), owner: 'o', intent: 'i' }]).verdict).toEqual({ verdict: 'admit' });

    expect(runCli(['--tree'], []).status).toBe(RESTRICTED_HOLD_PREFLIGHT_EXIT.misuse);
  }, 120_000);
});

/**
 * The shell doors, driven for real with a fake `node` first on PATH. The fake records its argv and
 * answers like a refusing gate, so the assertion is about the DOOR's wiring: it calls the gate with
 * absolute roots before anything else runs, and a refusal stops it.
 */
describe('shell doors refuse before booting anything', () => {
  function shims(nodeExit: number) {
    const bin = tempDir('wi5763-bin-');
    const record = join(bin, 'node.argv');
    const tauriRan = join(bin, 'tauri.ran');
    writeFileSync(
      join(bin, 'node'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${record}'\n` +
        (nodeExit === 0 ? 'exit 0\n' : `echo 'RESTRICTED_HOLD_REFUSED door=x error=restricted_write_held booted=none fake' >&2\nexit ${nodeExit}\n`),
    );
    writeFileSync(join(bin, 'tauri'), `#!/usr/bin/env bash\ntouch '${tauriRan}'\nexit 0\n`);
    chmodSync(join(bin, 'node'), 0o755);
    chmodSync(join(bin, 'tauri'), 0o755);
    const home = tempDir('wi5763-home-');
    const env = { PATH: `${bin}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: home };
    return { env, record, tauriRan };
  }
  // WI-10005802: each door starts the gate under the committed-source loader, so the gate and the
  // preflight library run their committed (HEAD) bytes (the loader suite pins what that means).
  const gateArgv = (door: string) => [
    '--import',
    COMMITTED_SOURCE_LOADER,
    join(REPO, 'scripts', 'restricted-hold-tree-gate.mjs'),
    '--door',
    door,
    REPO,
  ];

  it('tauri-guarded dev: refuses with the gate verdict and never reaches tauri', () => {
    const { env, record, tauriRan } = shims(RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse);
    const result = spawnSync('bash', [join(REPO, 'papercusp-desktop', 'bin', 'tauri-guarded'), 'dev'], { env, encoding: 'utf8', timeout: 60_000 });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/restricted-write fence refused `tauri dev`/);
    expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(gateArgv('tauri-dev'));
    expect(existsSync(tauriRan)).toBe(false);
  });

  it('verify-tauri-headless.sh: refuses before its first precondition, and an admit lets it continue (control)', () => {
    const script = join(REPO, 'scripts', 'verify-tauri-headless.sh');
    const refused = shims(RESTRICTED_HOLD_PREFLIGHT_EXIT.refuse);
    const r = spawnSync('bash', [script, '--', 'true'], { env: refused.env, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/restricted-write fence refused this verifier launch/);
    expect(r.stderr).not.toMatch(/PAPERCUSP_SID is unset/);
    expect(readFileSync(refused.record, 'utf8').trim().split('\n')).toEqual(gateArgv('verify-tauri-headless'));

    // Control: an admitting gate lets the script run on to its NEXT check (no PAPERCUSP_SID here),
    // which proves the refusal above came from the gate and not from an earlier failure.
    const admitted = shims(0);
    const a = spawnSync('bash', [script, '--', 'true'], { env: admitted.env, encoding: 'utf8', timeout: 60_000 });
    expect(a.status).toBe(1);
    expect(a.stderr).toMatch(/PAPERCUSP_SID is unset/);
    expect(a.stderr).not.toMatch(/restricted-write fence refused/);
  });
});
