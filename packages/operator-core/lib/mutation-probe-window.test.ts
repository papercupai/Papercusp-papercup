/**
 * EI-18750303030034478 — a failing raw `test:file` / `test:affected` run names an ACTIVE in-tree
 * mutation-probe window, so a red read from a peer's deliberately-broken file is not mistaken for a
 * regression in the caller's own change.
 *
 * Every test builds its marker under a private scratch `tmpDir`. NEVER write a marker into the real
 * `/tmp/papercusp-mutation-probe-<uid>-<hash>` of this checkout: the next real `--in-tree` probe
 * would read it as an orphaned snapshot and try to RESTORE the subject from it.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildWindowStamp,
  buildWindowVerdict,
  checkoutRootsUnder,
  formatBuildWindowBlock,
  formatMutationProbeWindow,
  mutationProbeAdmissionDir,
  readMutationProbeWindow,
  resolveBuildWindowWaitSec,
  verifyBuildWindowUnchanged,
  waitForBuildWindowClear,
} from '../../../scripts/lib/mutation-probe-window.mjs';

const REPO = resolve(__dirname, '../../..');

describe('mutation-probe window marker (EI-18750303030034478)', () => {
  let scratch: string;
  let checkout: string;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mp-window-')));
    checkout = join(scratch, 'checkout');
    mkdirSync(checkout);
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const opts = () => ({ uid: 4242, tmpDir: scratch });

  it('uses the shared admission-root override when resolving a marker', () => {
    const previousAdmissionRoot = process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
    process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = join(scratch, 'admission-base');
    try {
      const admissionDir = mutationProbeAdmissionDir(checkout, { uid: 4242 });
      mkdirSync(admissionDir, { recursive: true });
      const manifestPath = join(admissionDir, 'original.manifest');
      writeFileSync(
        manifestPath,
        ['checkout', 'subject', 'snapshot', String(process.pid)].map((field) => field + '\0').join(''),
        'latin1',
      );

      expect(readMutationProbeWindow(checkout, { uid: 4242 })?.manifestPath).toBe(manifestPath);
    } finally {
      if (previousAdmissionRoot === undefined) delete process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT;
      else process.env.PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT = previousAdmissionRoot;
    }
  });
  const publish = (fields: string[]) => {
    const dir = mutationProbeAdmissionDir(checkout, opts());
    mkdirSync(dir, { recursive: true });
    // The writer terminates EVERY field with NUL: printf '%s\0%s\0%s\0%s\0'.
    writeFileSync(join(dir, 'original.manifest'), fields.map((f) => `${f}\0`).join(''), 'latin1');
  };
  const deadPid = () => {
    const child = spawnSync(process.execPath, ['-e', '']);
    return child.pid as number;
  };

  it('reads no marker as "no window" (null), never an error', () => {
    expect(readMutationProbeWindow(checkout, opts())).toBeNull();
    expect(formatMutationProbeWindow(null, checkout)).toBe('');
  });

  it('reports an ACTIVE window when the owner pid is alive, with the subject repo-relative', () => {
    publish([checkout, join(checkout, 'pkg/src/cpu-task-worker.ts'), join(scratch, 'x.orig'), String(process.pid)]);
    const window = readMutationProbeWindow(checkout, opts());
    expect(window).toMatchObject({ state: 'active', ownerPid: process.pid });
    const line = formatMutationProbeWindow(window, checkout);
    expect(line).toMatch(/^TEST_FILE_MUTATION_PROBE_WINDOW state=active subject=pkg\/src\/cpu-task-worker\.ts /);
    expect(line).toContain(`ownerPid=${process.pid}`);
    expect(line).toContain('re-run in isolation');
  });

  it('reports an ORPHANED window when the owner died mid-window (the mutant may still be in the file)', () => {
    publish([checkout, join(checkout, 'a.ts'), join(scratch, 'a.orig'), String(deadPid())]);
    const window = readMutationProbeWindow(checkout, opts());
    expect(window?.state).toBe('orphaned');
    expect(formatMutationProbeWindow(window, checkout)).toContain('may STILL be mutated');
  });

  it.each([
    ['three fields', ['a', 'b', 'c']],
    ['five fields', ['a', 'b', 'c', '1', 'e']],
    ['a non-numeric pid', ['a', 'b', 'c', 'pid']],
    ['a zero pid', ['a', 'b', 'c', '0']],
    ['an empty subject', ['a', '', 'c', '1']],
  ])('reports an UNREADABLE window (not "none", not a throw) for %s', (_name, fields) => {
    publish(fields);
    const window = readMutationProbeWindow(checkout, opts());
    expect(window).toMatchObject({ state: 'unreadable', subject: null, ownerPid: null });
    expect(formatMutationProbeWindow(window, checkout)).toContain('could not be parsed');
  });

  it('reports a marker missing its trailing NUL as unreadable (a truncated write is not a window we can name)', () => {
    const dir = mutationProbeAdmissionDir(checkout, opts());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'original.manifest'), `a\0b\0c\0${process.pid}`, 'latin1');
    expect(readMutationProbeWindow(checkout, opts())?.state).toBe('unreadable');
  });

  it('never throws for a checkout that cannot be resolved', () => {
    expect(readMutationProbeWindow(join(scratch, 'does-not-exist'), opts())).toBeNull();
  });
});

/**
 * WI-10005321 — the BUILD gate. A bundler that reads the shared tree inside a probe window ships
 * the mutant (2026-10-02: bg-host ran with its tool-ceiling denial disabled for ~8 min), so
 * `bundle-host.sh` waits on, and re-verifies, every window under the tree it bundles.
 */
describe('build gate: never bundle a probe-mutated tree (WI-10005321)', () => {
  let scratch: string;
  let checkout: string;
  let sub: string;

  beforeEach(() => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mp-build-gate-')));
    checkout = join(scratch, 'checkout');
    sub = join(checkout, 'libs', 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(checkout, '.gitmodules'),
      '[submodule "libs/sub"]\n\tpath = libs/sub\n\turl = x\n[submodule "gone"]\n\tpath = libs/not-checked-out\n\turl = y\n',
    );
  });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));

  const opts = () => ({ uid: 4242, tmpDir: scratch });
  const publishFor = (root: string, fields: string[]) => {
    const dir = mutationProbeAdmissionDir(root, opts());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'original.manifest'), fields.map((f) => `${f}\0`).join(''), 'latin1');
    return dir;
  };
  const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;

  it('reads the superproject and every checked-out submodule as build roots', () => {
    expect(checkoutRootsUnder(checkout)).toEqual([checkout, sub]);
  });

  it('is clear with no marker, and stamps every root', () => {
    expect(buildWindowVerdict(checkout, opts())).toMatchObject({ clear: true, blocking: [] });
    expect(Object.keys(buildWindowStamp(checkout, opts()))).toEqual([checkout, sub]);
  });

  it('BLOCKS on an active window in a SUBMODULE, which the superproject-keyed read cannot see', () => {
    publishFor(sub, [sub, join(sub, 'a.ts'), join(scratch, 'a.orig'), String(process.pid)]);
    // Calibration: the diagnostic read of the superproject alone sees nothing.
    expect(readMutationProbeWindow(checkout, opts())).toBeNull();
    const verdict = buildWindowVerdict(checkout, opts());
    expect(verdict).toMatchObject({ clear: false, waitable: true });
    expect(formatBuildWindowBlock(verdict, checkout)[0]).toMatch(
      /^BUILD_MUTATION_PROBE_WINDOW state=active subject=libs\/sub\/a\.ts /,
    );
  });

  it('clears an orphan whose subject already equals its snapshot; an orphan that differs blocks without waiting', () => {
    const subject = join(checkout, 'b.ts');
    const snapshot = join(scratch, 'b.orig');
    writeFileSync(subject, 'original\n');
    writeFileSync(snapshot, 'original\n');
    publishFor(checkout, [checkout, subject, snapshot, String(deadPid())]);
    const restored = buildWindowVerdict(checkout, opts());
    expect(restored.clear).toBe(true);
    expect(restored.notes.join('\n')).toContain('already equals its snapshot');
    writeFileSync(subject, 'MUTANT\n');
    expect(buildWindowVerdict(checkout, opts())).toMatchObject({ clear: false, waitable: false });
  });

  it('blocks without waiting on an unreadable marker (the mutated file is unknown)', () => {
    publishFor(checkout, ['a', 'b', 'c']);
    expect(buildWindowVerdict(checkout, opts())).toMatchObject({ clear: false, waitable: false });
  });

  it('waits for an active window to close, then returns the stamp', async () => {
    const dir = publishFor(checkout, [checkout, join(checkout, 'c.ts'), join(scratch, 'c.orig'), String(process.pid)]);
    let clock = 0;
    const result = await waitForBuildWindowClear(checkout, {
      ...opts(),
      timeoutMs: 60_000,
      pollMs: 1_000,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        rmSync(join(dir, 'original.manifest'));
      },
    });
    expect(result).toMatchObject({ ok: true, polls: 1, waitedMs: 1_000 });
    expect(result.stamp[checkout]).not.toBeNull();
  });

  it('gives up at the bound on a window that stays open, and never waits on an orphan', async () => {
    publishFor(checkout, [checkout, join(checkout, 'd.ts'), join(scratch, 'd.orig'), String(process.pid)]);
    let clock = 0;
    let sleeps = 0;
    const sleep = async (ms: number) => {
      clock += ms;
      sleeps += 1;
    };
    const stuck = await waitForBuildWindowClear(checkout, { ...opts(), timeoutMs: 5_000, pollMs: 1_000, now: () => clock, sleep });
    expect(stuck).toMatchObject({ ok: false, waitedMs: 5_000 });
    expect(sleeps).toBe(5);

    publishFor(checkout, [checkout, join(checkout, 'd.ts'), join(scratch, 'missing.orig'), String(deadPid())]);
    sleeps = 0;
    const orphan = await waitForBuildWindowClear(checkout, { ...opts(), timeoutMs: 5_000, pollMs: 1_000, now: () => clock, sleep });
    expect(orphan.ok).toBe(false);
    expect(sleeps).toBe(0);
  });

  it('verify fails when a window opened AND closed during the build (an admission directory moved)', async () => {
    const dir = mutationProbeAdmissionDir(sub, opts());
    mkdirSync(dir, { recursive: true });
    utimesSync(dir, 1_000, 1_000);
    const { stamp } = await waitForBuildWindowClear(checkout, opts());
    expect(verifyBuildWindowUnchanged(checkout, stamp, opts())).toMatchObject({ ok: true });
    // A probe opens and restores inside the build: its manifest comes and goes.
    writeFileSync(join(dir, 'original.manifest'), 'x');
    rmSync(join(dir, 'original.manifest'));
    // Pin the move: a same-millisecond create+remove could otherwise tie the mtime.
    utimesSync(dir, 2_000, 2_000);
    expect(verifyBuildWindowUnchanged(checkout, stamp, opts())).toMatchObject({
      ok: false,
      reason: 'window-opened-during-build',
      moved: [sub],
    });
  });

  it('verify fails when a window is still open after the build', async () => {
    const { stamp } = await waitForBuildWindowClear(checkout, opts());
    publishFor(checkout, [checkout, join(checkout, 'e.ts'), join(scratch, 'e.orig'), String(process.pid)]);
    expect(verifyBuildWindowUnchanged(checkout, stamp, opts())).toMatchObject({ ok: false, reason: 'window-open' });
  });

  it('the CLI exits 1 on an open window, and 0 for wait and verify once it closes', () => {
    publishFor(checkout, [checkout, join(checkout, 'f.ts'), join(scratch, 'f.orig'), String(process.pid)]);
    const stampFile = join(scratch, 'stamp.json');
    const run = (mode: string) =>
      spawnSync(
        process.execPath,
        [
          join(REPO, 'scripts/mutation-probe-window-gate.mjs'),
          mode,
          '--root',
          checkout,
          '--stamp-file',
          stampFile,
          '--tmp-dir',
          scratch,
          '--uid',
          '4242',
          '--timeout-sec',
          '0',
        ],
        { encoding: 'utf8' },
      );
    const blocked = run('wait');
    expect(blocked.status).toBe(1);
    expect(blocked.stdout).toContain('BUILD_MUTATION_PROBE_WINDOW state=active subject=f.ts');
    rmSync(join(mutationProbeAdmissionDir(checkout, opts()), 'original.manifest'));
    expect(run('wait').status).toBe(0);
    expect(run('verify').status).toBe(0);
  });

  it('the CLI wait takes its budget from the env when no --timeout-sec is passed (WI-10006268)', () => {
    publishFor(checkout, [checkout, join(checkout, 'g.ts'), join(scratch, 'g.orig'), String(process.pid)]);
    const run = (env: Record<string, string>) =>
      spawnSync(
        process.execPath,
        [
          join(REPO, 'scripts/mutation-probe-window-gate.mjs'),
          'wait',
          '--root',
          checkout,
          '--stamp-file',
          join(scratch, 'stamp-env.json'),
          '--tmp-dir',
          scratch,
          '--uid',
          '4242',
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: '', PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '', ...env },
        },
      );
    const umbrella = run({ PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '1' });
    expect(umbrella.status).toBe(1);
    expect(umbrella.stdout).toContain('whole 1s wait (from PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC');
    const specific = run({ PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: '0', PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '3600' });
    expect(specific.status).toBe(1);
    expect(specific.stdout).toContain('whole 0s wait (from PAPERCUSP_BUNDLE_PROBE_WAIT_SEC');
    const junk = run({ PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: 'soon' });
    expect(junk.status).toBe(2);
    expect(junk.stderr).toContain('PAPERCUSP_BUNDLE_PROBE_WAIT_SEC must be a non-negative number');
  });
});

describe('build-window wait budget (WI-10006268)', () => {
  it('defaults to the interactive 90 s', () => {
    expect(resolveBuildWindowWaitSec({})).toEqual({ sec: 90, source: 'default' });
  });

  it('honours the unattended umbrella that every other build lock wait honours', () => {
    expect(resolveBuildWindowWaitSec({ PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '3600' })).toEqual({
      sec: 3600,
      source: 'PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC',
    });
  });

  it('lets the specific knob win over the umbrella, including an explicit 0', () => {
    const env = { PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: '0', PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: '3600' };
    expect(resolveBuildWindowWaitSec(env)).toEqual({ sec: 0, source: 'PAPERCUSP_BUNDLE_PROBE_WAIT_SEC' });
  });

  it('ignores an umbrella that is junk or <= 0, as scripts/lib/fs-mutex.mjs does', () => {
    for (const bad of ['junk', '0', '-5', '']) {
      expect(resolveBuildWindowWaitSec({ PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC: bad })).toEqual({ sec: 90, source: 'default' });
    }
  });

  it('refuses a specific knob that is set but not a non-negative number', () => {
    expect(() => resolveBuildWindowWaitSec({ PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: 'soon' })).toThrow(/non-negative/);
    expect(() => resolveBuildWindowWaitSec({ PAPERCUSP_BUNDLE_PROBE_WAIT_SEC: '-1' })).toThrow(/non-negative/);
  });
});

/** Every `wait` call (up to its `||`) leaves the budget to the gate's env resolution. */
function waitCallsLeaveBudgetToGate(text: string): boolean {
  const calls = text
    .split('mutation-probe-window-gate.mjs" wait')
    .slice(1)
    .map((rest) => rest.slice(0, rest.indexOf('||')));
  return calls.length > 0 && calls.every((call) => !call.includes('--timeout-sec'));
}

describe('bundle wait call sites do not pin --timeout-sec (WI-10006268)', () => {
  const host = readFileSync(join(REPO, 'apps/operator/bin/bundle-host.sh'), 'utf8');
  const common = readFileSync(join(REPO, 'apps/operator/bin/bundle-host-common.sh'), 'utf8');

  it('bundle-host.sh and bundle-host-common.sh let PAPERCUSP_UNATTENDED_LOCK_WAIT_SEC reach the wait', () => {
    expect(waitCallsLeaveBudgetToGate(host)).toBe(true);
    expect(waitCallsLeaveBudgetToGate(common)).toBe(true);
  });

  it('CONTROL: the predicate catches a re-pinned budget and a vanished wait call', () => {
    const pinned = host.replace('--stamp-file "$PROBE_STAMP"', '--stamp-file "$PROBE_STAMP" --timeout-sec 90');
    expect(pinned).not.toBe(host);
    expect(waitCallsLeaveBudgetToGate(pinned)).toBe(false);
    expect(waitCallsLeaveBudgetToGate(common.replaceAll('mutation-probe-window-gate.mjs" wait', 'gone'))).toBe(false);
  });
});

/** wait < esbuild < verify < the atomic swap, in bundle-host.sh's text. */
function buildGateWiring(text: string): boolean {
  const wait = text.indexOf('mutation-probe-window-gate.mjs" wait');
  // The compile goes through bundle-host-common.sh's cached `bundle_host_esbuild` (no inline `npx esbuild@`).
  const esbuild = text.indexOf('host-compile bundle_host_esbuild', wait);
  const verify = text.indexOf('mutation-probe-window-gate.mjs" verify', esbuild);
  const swap = text.indexOf('mv -f "$TMPFILE" "$OUTFILE"', verify);
  return wait > -1 && esbuild > wait && verify > esbuild && swap > verify;
}

describe('bundle-host.sh runs the build gate around esbuild (WI-10005321)', () => {
  const script = readFileSync(join(REPO, 'apps/operator/bin/bundle-host.sh'), 'utf8');

  it('waits before esbuild and verifies before the atomic swap', () => {
    expect(buildGateWiring(script)).toBe(true);
  });

  it('CONTROL: the predicate catches a dropped wait or verify', () => {
    expect(buildGateWiring(script.replace('mutation-probe-window-gate.mjs" wait', 'gone'))).toBe(false);
    expect(buildGateWiring(script.replace('mutation-probe-window-gate.mjs" verify', 'gone'))).toBe(false);
  });
});

describe('the marker contract is pinned to scripts/mutation-probe.sh (EI-18750303030034478)', () => {
  const script = readFileSync(join(REPO, 'scripts/mutation-probe.sh'), 'utf8');
  const overlay = readFileSync(join(REPO, 'scripts/testing-run-probe-overlay.sh'), 'utf8');

  it('mirrors the admission-directory literal the script hard-codes', () => {
    expect(script).toContain('ADMISSION_KEY="$(printf \'%s\' "$ADMISSION_ROOT" | sha256sum | cut -d\' \' -f1)"');
    expect(script).toContain('ADMISSION_BASE="${PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT:-/tmp}"');
    expect(script).toContain('ADMISSION_DIR="$ADMISSION_BASE/papercusp-mutation-probe-$(id -u)-$ADMISSION_KEY"');
    expect(script).toContain('PROBE_MANIFEST="$ADMISSION_DIR/original.manifest"');
  });

  it('mirrors the four-field NUL-terminated manifest the script publishes', () => {
    expect(script).toContain('printf \'%s\\0%s\\0%s\\0%s\\0\' "$ADMISSION_ROOT" "$FILE" "$BASE" "$$" >"$PROBE_MANIFEST"');
  });

  it('uses the same admission-root override as the shell writer and marker reader', () => {
    expect(overlay).toContain('ADMISSION_BASE="${PAPERCUSP_MUTATION_PROBE_ADMISSION_ROOT:-/tmp}"');
    expect(overlay).toContain('directory="$ADMISSION_BASE/papercusp-mutation-probe-$(id -u)-$key"');
    expect(overlay).toContain('manifest="$directory/original.manifest"');
  });

  it('derives the same directory name as the shell does for the same root (sha256sum is the oracle)', () => {
    const root = realpathSync(REPO);
    const shell = spawnSync('bash', ['-c', `printf '%s' "$1" | sha256sum | cut -d' ' -f1`, '_', root], {
      encoding: 'utf8',
    });
    expect(shell.status).toBe(0);
    const key = shell.stdout.trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(mutationProbeAdmissionDir(REPO, { uid: 1000 })).toBe(`/tmp/papercusp-mutation-probe-1000-${key}`);
  });
});

/**
 * The wiring predicates are pure functions of the source TEXT so each can be proven falsifiable with an
 * in-memory mutant (the "module/logic you import" tier of CLAUDE.md's falsifiability table): nothing
 * here ever mutates the shared tree, and the real file must pass while each mutant must be caught.
 */
const FAILED_EMISSION = 'errSync(resultLine("failed"));';

/** 1-based lines of a failing `AFFECTED_TESTS_RESULT` emission NOT immediately preceded by the annotation. */
function unannotatedFailedEmissions(text: string): { count: number; unannotated: number[] } {
  const lines = text.split('\n');
  const sites = lines.flatMap((line, index) => (line.trim() === FAILED_EMISSION ? [index] : []));
  return {
    count: sites.length,
    unannotated: sites.filter((index) => lines[index - 1]?.trim() !== 'emitMutationProbeWindow();').map((i) => i + 1),
  };
}

/**
 * How many pre/post-run reads + stderr prints the router carries (both must be present). Keyed on
 * the CALL SHAPE, not the root identifier's name: the router passes its root as a parameter
 * (`repoRoot`) since its refactor, and a name-pinned regex read that as "zero reads".
 */
const ROOT_ARG = String.raw`[A-Za-z_$][\w$]*`;
function routerWindowWiring(text: string): { reads: number; prints: number } {
  return {
    reads: text.match(new RegExp(String.raw`readMutationProbeWindow\(${ROOT_ARG}\)`, 'g'))?.length ?? 0,
    prints:
      text.match(new RegExp(String.raw`console\.error\(formatMutationProbeWindow\(probeWindow(?:Before|After), ${ROOT_ARG}\)\)`, 'g'))
        ?.length ?? 0,
  };
}

describe('every failing verdict path on the raw runners carries the annotation (EI-18750303030034478)', () => {
  const affected = readFileSync(join(REPO, 'scripts/affected-tests.mjs'), 'utf8');
  const router = readFileSync(join(REPO, 'scripts/test-files.mjs'), 'utf8');

  it('affected-tests.mjs emits the window immediately before EACH failing `AFFECTED_TESTS_RESULT` line', () => {
    const real = unannotatedFailedEmissions(affected);
    // The two real failure exits (undetermined-only, and failed>0): a vacuous scan of zero sites must
    // not read as "all annotated".
    expect(real.count).toBeGreaterThanOrEqual(2);
    expect(real.unannotated).toEqual([]);
  });

  it('CONTROL: the predicate catches an annotation removed from a real failure site', () => {
    const mutant = affected.replace('  emitMutationProbeWindow();\n  errSync(resultLine("failed"));', '  errSync(resultLine("failed"));');
    expect(mutant).not.toBe(affected); // a no-op mutation would make any guard look weak
    expect(unannotatedFailedEmissions(mutant).unannotated).toHaveLength(1);
  });

  it('CONTROL: the predicate catches a NEW failing verdict path added without the annotation', () => {
    const mutant = `${affected}\n  ${FAILED_EMISSION}\n`;
    expect(unannotatedFailedEmissions(mutant).unannotated).toHaveLength(1);
  });

  it('test-files.mjs reads the window both before and after the run, and prints each to stderr', () => {
    expect(routerWindowWiring(router)).toEqual({ reads: 2, prints: 2 });
  });

  it('CONTROL: the router predicate catches a dropped pre-run or post-run read', () => {
    const dropped = router.replace(/const probeWindowAfter = readMutationProbeWindow\([^)]*\);/, 'const probeWindowAfter = null;');
    expect(dropped).not.toBe(router);
    expect(routerWindowWiring(dropped)).not.toEqual({ reads: 2, prints: 2 });
  });
});
