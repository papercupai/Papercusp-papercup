/**
 * The GUARD's own correctness (task-manager-no-escape-2026-07-27, P-016).
 *
 * A guard that only ever runs against a clean tree proves nothing — it would pass
 * identically if its predicate were `return false`. So the property under test is
 * "a NEW unenrolled detached spawn fails", driven against synthetic sources, the
 * same discipline `no-raw-spawn-guard.test.ts` applies to its own predicate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isUnenrolledDetachedSpawn,
  spawnTriggers,
  ALLOWLIST,
  KNOWN_DEFECTS,
} from '../../../../scripts/check-no-unenrolled-detached-spawn.mjs';

/** This file sits at packages/operator-core/lib/task-manager/ — four levels down. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const check = isUnenrolledDetachedSpawn;
const allow = ALLOWLIST;

/** A path in no map, so only the PREDICATE decides the verdict. */
const NEW = 'packages/operator-core/lib/brand-new-thing.ts';

/**
 * THE PERMANENTLY-WRONG CONTROL (falsifiability, kept in the test file rather than
 * mutating the shared tree — a mutation probe here would be committed by the git-sync
 * sweep while it ran).
 *
 * This is the guard's OWN previous implementation: a literal-text match on
 * `detached: true`. It is not a strawman — it shipped, and EI-19483245448673321 is the
 * record of what it could not see. Keeping it here means the blind-spot cases below
 * are proven DISCRIMINATING: each one asserts the real predicate catches what this
 * control misses. Without it, those cases would pass identically against a predicate
 * that simply returned `true` for everything.
 */
const LITERAL_TEXT_PREDICATE = (source: string): boolean =>
  /detached:\s*true/.test(source) && /\b(spawn|childSpawn|spawnFn)\s*\(/.test(source);

const RAW = `
import { spawn } from 'node:child_process';
export function go() {
  return spawn('node', ['worker.js'], { cwd: '/tmp', detached: true });
}`;

describe('isUnenrolledDetachedSpawn', () => {
  it('FAILS a new detached spawn with no enrolment', () => {
    expect(check('packages/operator-core/lib/brand-new-thing.ts', RAW)).toBe(true);
  });

  it('passes once the file enrols through the sync seam', () => {
    const enrolled = `import { beginSyncEnrolment } from '../task-manager/enroll-sync';\n${RAW}`;
    expect(check('packages/operator-core/lib/brand-new-thing.ts', enrolled)).toBe(false);
  });

  it('does not count erased type-only enrolment imports as runtime enrolment', () => {
    expect(check(NEW, `import type { beginSyncEnrolment } from '../task-manager/enroll-sync';\n${RAW}`)).toBe(true);
    expect(check(NEW, `import { type beginSyncEnrolment } from '../task-manager/enroll-sync';\n${RAW}`)).toBe(true);
  });

  it('accepts an injected sync enrolment seam only when its functions are called', () => {
    const injected = `
import type { beginSyncEnrolment, completeSyncEnrolment, finishSyncEnrolment } from '../task-manager/enroll-sync';
type Enrollment = { begin: typeof beginSyncEnrolment; complete: typeof completeSyncEnrolment; finish: typeof finishSyncEnrolment };
export function go(opts: { enrollment?: Enrollment }) {
  const receipt = opts.enrollment?.begin({});
  const child = spawn('node', ['worker.js'], { detached: true });
  opts.enrollment?.complete(receipt, {}, child.pid);
  opts.enrollment?.finish(receipt, {});
  return child;
}`;
    expect(check(NEW, injected)).toBe(false);
    expect(check(NEW, injected.replace('opts.enrollment?.finish(receipt, {});', ''))).toBe(true);
  });

  it('passes once the file enrols through the async chokepoint', () => {
    const enrolled = `import { managedSpawn } from '../task-manager/managed-spawn';\n${RAW}`;
    expect(check('packages/operator-core/lib/brand-new-thing.ts', enrolled)).toBe(false);
  });

  it('passes an explicitly allowlisted site', () => {
    const [first] = [...allow.keys()];
    expect(check(first!, RAW)).toBe(false);
  });

  it('ignores a file that merely TALKS about detached:true in a comment', () => {
    // Several files explain the flag at length; a doc-comment is not a spawn, and
    // flagging one would train people to ignore the guard.
    const commentOnly = `
import { spawn } from 'node:child_process';
// This process runs with detached: true elsewhere, which is why we group-kill.
/* detached: true gives it its own process group */
export function go() { return spawn('ls', []); }`;
    expect(check('packages/operator-core/lib/talks-about-it.ts', commentOnly)).toBe(false);
  });

  it('ignores a non-detached spawn — short-lived children inherit their parent cgroup', () => {
    const plain = `import { spawn } from 'node:child_process';\nspawn('git', ['rev-parse']);`;
    expect(check('packages/operator-core/lib/plain.ts', plain)).toBe(false);
  });

  it('ignores an object with detached:true that never spawns anything', () => {
    const notASpawn = `export const opts = { detached: true, cwd: '/tmp' };`;
    expect(check('packages/operator-core/lib/config.ts', notASpawn)).toBe(false);
  });
});

describe('the widened trigger (EI-19483245448673321)', () => {
  // CALIBRATION FIRST. If the control missed EVERYTHING it would "prove" every case
  // below for free, so assert its teeth before relying on its blindness.
  it('CALIBRATION: the literal-text control does catch a plain `detached: true`', () => {
    expect(LITERAL_TEXT_PREDICATE(RAW)).toBe(true);
  });

  it('FAILS `detached: <computed>` — the blind spot the literal-text control cannot see', () => {
    // green-checkpoint.ts:9289 in the real tree: `const detach = ...; { detached: detach }`.
    const computed = `
import { spawn } from 'node:child_process';
export function go(opts: { killOnTimeout?: boolean }) {
  const detach = opts.killOnTimeout === true;
  return spawn('node', ['w.js'], { stdio: 'ignore', detached: detach });
}`;
    expect(LITERAL_TEXT_PREDICATE(computed)).toBe(false); // ← the control is blind here
    expect(check(NEW, computed)).toBe(true); // ← the real predicate is not
  });

  it('FAILS a shorthand `{ detached }` — value unknown is not value-false', () => {
    const shorthand = `
import { spawn } from 'node:child_process';
export function go(detached: boolean) { return spawn('node', ['w.js'], { detached }); }`;
    expect(LITERAL_TEXT_PREDICATE(shorthand)).toBe(false);
    expect(check(NEW, shorthand)).toBe(true);
  });

  it('FAILS a handle PARKED ON A PROPERTY even with `detached: false`', () => {
    // local-whisper-service.ts in the real tree: a health-gated server kept in
    // module-scope `state`. It outlives the call inside the parent cgroup, which is
    // the hazard enrolment exists to prevent — and the old rule could not see it.
    const parked = `
import { spawn } from 'node:child_process';
const state: { child: unknown } = { child: null };
export function start() {
  const child = spawn('whisper-server', ['--port', '9000'], { detached: false });
  state.child = child;
}`;
    expect(LITERAL_TEXT_PREDICATE(parked)).toBe(false);
    expect(check(NEW, parked)).toBe(true);
  });

  it('FAILS a spawn assigned straight onto a property', () => {
    const direct = `
import { spawn } from 'node:child_process';
class Svc { proc: unknown = null; start() { this.proc = spawn('x', []); } }`;
    expect(check(NEW, direct)).toBe(true);
  });

  it('does NOT fail a handle merely RETURNED to the caller', () => {
    // A deliberate non-trigger: an awaited caller is the false-positive class the
    // ALLOWLIST header calls category (2). 9 sites measured; flagging them would
    // encode a rule the guard's own documentation says is wrong.
    const returned = `
import { spawn } from 'node:child_process';
export function run() { const child = spawn('git', ['status']); return child; }`;
    expect(check(NEW, returned)).toBe(false);
  });

  it('does NOT fail a `detached:` key on a DATA object in a file that also spawns', () => {
    // harness/git-stats.ts:883 — `detached: live.branch === null && ...` on a repo-status
    // object. Any WIDENED TEXT rule scores this an offender; the AST does not, because
    // the key is not in a spawn call's options argument. This is why the guard parses.
    const dataObject = `
import { spawn } from 'node:child_process';
export function status(live: { branch: string | null; head: string | null }) {
  spawn('git', ['rev-parse']);
  return { branch: live.branch, detached: live.branch === null && live.head !== null };
}`;
    expect(check(NEW, dataObject)).toBe(false);
  });

  it('self-excludes the enrolment primitives, so the fix is never read as the defect', () => {
    // managed-spawn.ts spawns and hands the handle back — that IS enrolment from the
    // inside. Without the exclusion a widened guard flags the remedy.
    const primitive = 'packages/operator-core/lib/task-manager/managed-spawn.ts';
    expect(check(primitive, RAW)).toBe(false);
    expect(spawnTriggers(primitive, RAW)).toEqual({
      detachedNotFalse: false,
      storedOnProperty: false,
      selfDaemonizing: false,
    });
  });

  it('stays a strict SUPERSET: everything the literal-text control catches still fails', () => {
    expect(LITERAL_TEXT_PREDICATE(RAW) && check(NEW, RAW)).toBe(true);
  });

  /**
   * TRIGGER (3) — the self-daemonizing child (WI-41108).
   *
   * The real-world source is `dbus-daemon --fork` in desktop/a11y-bus-core.ts (it lived in
   * desktop/a11y-bus.ts until the 6ec387d053 split moved it), which leaked to
   * 115 host-wide processes while this guard read the tree as clean. Each case below is
   * asserted DISCRIMINATING against LITERAL_TEXT_PREDICATE: a trigger that fired on
   * everything would pass the positive cases too, so the control is what gives them force.
   */
  describe('trigger (3): a child that daemonizes itself', () => {
    /** The shape that was invisible: sync launch, no `detached`, no handle kept. */
    const DAEMONIZES = `
import { spawnSync } from 'node:child_process';
const busCmd = { bin: 'dbus-daemon', args: ['--config-file=/tmp/x', '--fork', '--print-pid=1'] };
export function startBus() {
  return spawnSync(busCmd.bin, busCmd.args, { encoding: 'utf8' });
}`;

    it('FAILS a self-daemonizing child that presents NEITHER older trigger', () => {
      expect(check(NEW, DAEMONIZES)).toBe(true);
      expect(spawnTriggers(NEW, DAEMONIZES)).toEqual({
        detachedNotFalse: false,
        storedOnProperty: false,
        selfDaemonizing: true,
      });
    });

    it('is DISCRIMINATING — the pre-fix control cannot see it', () => {
      // This is the whole finding: no `detached: true` anywhere, so the old rule read
      // this file as clean. If this ever goes false, trigger (3) has stopped being new.
      expect(LITERAL_TEXT_PREDICATE(DAEMONIZES)).toBe(false);
      expect(check(NEW, DAEMONIZES)).toBe(true);
    });

    it('is reachable at all: `spawnSync(` does NOT match the trigger-(1)/(2) pre-filter', () => {
      // Two independent blind spots, not one — if the pre-filter had matched spawnSync,
      // the a11y site would still have escaped on the trigger set alone.
      expect(/\b(spawn|childSpawn|spawnFn|fork)\s*\(/.test('spawnSync(')).toBe(false);
    });

    it('does NOT fire on `git checkout --detach` — the excluded-ambiguous-flag control', () => {
      // Every `--detach` site in this tree is a git ref operation. Were `--detach` in the
      // flag set, this guard would cry wolf on them and its findings would get
      // rubber-stamped into ALLOWLIST — the D-012 failure the guard's own header warns of.
      const gitCheckout = `
import { spawnSync } from 'node:child_process';
export function pin(dir: string, sha: string) {
  return spawnSync('git', ['-C', dir, 'checkout', '--quiet', '--detach', sha]);
}`;
      expect(check(NEW, gitCheckout)).toBe(false);
    });

    it('does NOT fire on a daemonize flag that appears only in a COMMENT', () => {
      // Trigger (3) reads string LITERALS off the AST, not raw text. Prose that merely
      // NAMES `--fork` must not convict a file — the false-positive direction.
      const prose = `
import { spawnSync } from 'node:child_process';
// We deliberately do NOT pass --fork here; the child must die with this call.
export function run() {
  return spawnSync('dbus-daemon', ['--nofork']);
}`;
      expect(check(NEW, prose)).toBe(false);
    });

    it('does NOT fire on a daemonize flag with no launch call in the file', () => {
      const noLaunch = `export const ARGS = ['--fork'];`;
      expect(check(NEW, noLaunch)).toBe(false);
    });

    it('still clears once the site enrols', () => {
      const enrolled = `import { beginSyncEnrolment } from '../task-manager/enroll-sync';\n${DAEMONIZES}`;
      expect(check(NEW, enrolled)).toBe(false);
    });

    /**
     * WI-41108 — the motivating site is now ENROLLED, so it must clear on the
     * predicate's own terms and on NO exemption. This runs against the REAL file
     * rather than a synthetic, because the thing worth pinning is not "the guard
     * can be satisfied" but "this specific site actually satisfies it".
     *
     * The trap it exists to catch: a file can stop being reported for two very
     * different reasons — it enrolled (correct), or the detector stopped seeing it
     * (a silent regression that looks identical from `exit 0`). Asserting the
     * trigger STILL FIRES separates them, which the old KNOWN_DEFECTS assertion
     * could not do.
     */
    describe('the motivating site (desktop/a11y-bus-core.ts) after enrolment', () => {
      // NOTE (2026-09-20): commit 6ec387d053 SPLIT the original a11y-bus.ts into a
      // 9-line enrolment shim (a11y-bus.ts, which now spawns nothing) plus this core
      // module, which carries the real `dbus-daemon --fork`. The site under test is
      // wherever the SPAWN lives, so it moved here with it. Pointing at the shim made
      // both assertions below fail for a reason that had nothing to do with the guard.
      const a11y = 'packages/operator-core/lib/desktop/a11y-bus-core.ts';
      const source = readFileSync(join(REPO_ROOT, a11y), 'utf8');

      it('earned neither exemption — it is in no map at all', () => {
        expect(KNOWN_DEFECTS.has(a11y)).toBe(false);
        expect(allow.has(a11y)).toBe(false);
      });

      it('STILL fires trigger (3) — the detector did not go quiet', () => {
        // If this goes false, the file cleared because the guard stopped seeing
        // `--fork`, not because anything was fixed.
        //
        // CALIBRATION: it can ALSO go false because the spawn was refactored into
        // another module again (exactly what 6ec387d053 did). Those two causes need
        // different fixes — a guard repair vs. re-pointing this describe block — so
        // say which one this is instead of leaving a bare `expected false to be true`.
        expect(
          spawnTriggers(a11y, source).selfDaemonizing,
          `${a11y} no longer self-daemonizes. Either the detector regressed (fix the ` +
            `guard), or the \`--fork\` spawn moved to another module (re-point this ` +
            `describe block at wherever it went — grep the tree for "--fork").`,
        ).toBe(true);
      });

      it('is not reported, because it enrols', () => {
        expect(check(a11y, source)).toBe(false);
      });

      it('FALSIFIABILITY: drop the injected begin call and the guard convicts it again', () => {
        // A pure string transform on an in-memory copy — never a tree mutation,
        // which the git-sync sweep would commit while the probe ran.
        const unenrolled = source.replace('opts.enrollment?.begin(', 'opts.unenrolled?.begin(');
        expect(unenrolled).not.toEqual(source); // the transform actually did something
        expect(check(a11y, unenrolled)).toBe(true);
      });
    });
  });
});

describe('bounded awaited process-group runners', () => {
  it.each([
    'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
    'packages/operator-core/lib/fleet/sidecar-exec-process.ts',
  ])('classifies %s as an explicit awaited-group exemption without blinding new sites', (path) => {
    const runner = readFileSync(join(REPO_ROOT, path), 'utf8');
    expect(spawnTriggers(path, runner).detachedNotFalse).toBe(true);
    expect(check(NEW, runner)).toBe(true);
    expect(allow.get(path)).toContain('processGroupLifetime');
    expect(check(path, runner)).toBe(false);
    // The local and IPC real-process suites verify exit-before-settlement;
    // this pins only the static guard's classification and path isolation.
  });

  const mutationProbeFence = 'packages/operator-core/lib/agent-tools/testing/mutation-probe-fence.ts';
  const mutationProbeFenceSource = readFileSync(join(REPO_ROOT, mutationProbeFence), 'utf8');

  it('allowlists the mutation-probe worker only while its deadline cleanup remains awaited', () => {
    expect(KNOWN_DEFECTS.has(mutationProbeFence)).toBe(false);
    expect(allow.get(mutationProbeFence)).toContain('request deadline');
    expect(spawnTriggers(mutationProbeFence, mutationProbeFenceSource).detachedNotFalse).toBe(true);
    expect(mutationProbeFenceSource).toContain('timer = setTimeout(');
    expect(mutationProbeFenceSource).toContain('terminateSpawnTree(worker, detached)');
    expect(mutationProbeFenceSource).toContain('await exited');
    // A new path is still caught; only the reviewed, bounded real site is exempt.
    expect(check(NEW, mutationProbeFenceSource)).toBe(true);
    expect(check(mutationProbeFence, mutationProbeFenceSource)).toBe(false);
  });

  const oddsmith = 'packages/operator-core/lib/harness/routines/oddsmith-cron-shared.ts';
  const source = readFileSync(join(REPO_ROOT, oddsmith), 'utf8');

  it('allowlists oddsmith only after proving its detached child is bounded and awaited', () => {
    expect(KNOWN_DEFECTS.has(oddsmith)).toBe(false);
    expect(allow.has(oddsmith)).toBe(true);
    expect(spawnTriggers(oddsmith, source).detachedNotFalse).toBe(true);
    expect(source).toContain("child.on('close', (code) =>");
    expect(source).toContain('process.kill(-child.pid, sig)');
    // The same source is still an offender under a new path; the allowlist is the
    // explicit lifetime decision, not a detector blind spot.
    expect(check(NEW, source)).toBe(true);
    expect(check(oddsmith, source)).toBe(false);
  });
});

describe('KNOWN_DEFECTS hygiene', () => {
  // This map suppresses a FAILURE, so it is the one place a real hazard can go quiet, and
  // it is governed harder than the allowlist rather than more softly.
  //
  // It is currently EMPTY (its one entry, local-whisper-service.ts / WI-39563, was fixed
  // rather than exempted). A loop over an empty map passes no matter what the rule says,
  // so the rule is expressed as a FUNCTION and tested against synthetic entries — the map
  // being empty then makes the suite vacuous only in the harmless direction.
  const defectEntryProblem = (path: string, reason: string): string | null => {
    if (!reason || reason.length <= 40) return 'reason too thin';
    if (!/\b(WI|EI)-\d+/.test(reason)) return 'no WI-/EI- tracking ref';
    if (allow.has(path)) return 'also in ALLOWLIST — an entry means one thing or the other';
    return null;
  };

  it('REJECTS an entry with no tracking ref — a parked defect with no owner is the blind spot', () => {
    expect(defectEntryProblem('packages/x/a.ts', 'we know about this one, it is fine for now really'))
      .toBe('no WI-/EI- tracking ref');
  });

  it('REJECTS a thin reason, and an entry double-booked in ALLOWLIST', () => {
    expect(defectEntryProblem('packages/x/a.ts', 'WI-1 broken')).toBe('reason too thin');
    const [allowlisted] = [...allow.keys()];
    expect(defectEntryProblem(allowlisted!, 'WI-39563 a suitably long and specific reason string here'))
      .toBe('also in ALLOWLIST — an entry means one thing or the other');
  });

  it('ACCEPTS a well-formed entry (calibration — the rule must not reject everything)', () => {
    expect(defectEntryProblem('packages/x/a.ts', 'WI-39563 — parks a long-lived child on a module-scope property; wants managedSpawn'))
      .toBe(null);
  });

  it('every REAL entry satisfies that same rule', () => {
    for (const [path, reason] of KNOWN_DEFECTS as Map<string, string>) {
      expect(defectEntryProblem(path, reason), `${path} is a malformed KNOWN_DEFECTS entry`).toBe(null);
    }
  });

  it('stays tiny — a parking lot is not an allowlist', () => {
    expect(KNOWN_DEFECTS.size).toBeLessThanOrEqual(3);
  });
});

describe('ALLOWLIST hygiene', () => {
  it('gives every entry a non-trivial reason', () => {
    // An allowlist without reasons becomes a rubber stamp within a month.
    for (const [path, reason] of allow) {
      expect(reason, `${path} needs a real reason`).toBeTruthy();
      expect(reason.length, `${path}'s reason is too thin`).toBeGreaterThan(20);
    }
  });

  it('stays small enough to actually review', () => {
    // The point of scoping the guard to `detached: true` (rather than all ~813
    // spawn sites) was to keep this list reviewable. If it grows past ~40 the
    // guard has drifted back into rubber-stamp territory and needs re-scoping.
    expect(allow.size).toBeLessThanOrEqual(40);
  });

  it('every entry still fires a trigger — a dead entry only spends the review budget', () => {
    // WI-6554700010009949: seven entries whose files no longer call spawn/fork at all
    // sat here and pushed a legitimate new category-(2) entry past the ceiling above.
    // A file that fires no trigger already passes without an entry, so its entry only
    // consumes the budget, and would silently re-cover the file if it ever spawned again.
    for (const [path] of allow) {
      const t = spawnTriggers(path, readFileSync(join(REPO_ROOT, path), 'utf8'));
      expect(t.detachedNotFalse || t.storedOnProperty || t.selfDaemonizing,
        `${path} fires no trigger — remove its ALLOWLIST entry`).toBe(true);
    }
  });
});
