/**
 * WI-1416 (bg-host-freeze-eventloop-stall P-006): the CHECKPOINTED git-sync pipeline,
 * proven against real git fixtures (bare origins + a working clone with a submodule).
 *
 * THE WI-1415 FAILURE MODE: handleGitSync ran as ONE opaque DBOS step, so the executor
 * reaper cancelled+requeued any fire whose first step outlived its 90s orphan window —
 * a restart-from-scratch loop (~1 commit/40min). The pipeline now checkpoints per phase
 * (`git-sync:submodules` → `git-sync:pointer-bump` → `git-sync:push`) via the
 * RunGitSyncOpts.step seam. This suite pins the two properties the split must hold:
 *
 *   RESUME+COMMIT, NOT LOOP — a fire killed right after the submodules checkpoint (the
 *   reaper's cancel) leaves its submodule work durable; the requeued fire completes the
 *   superproject pointer-bump + push WITHOUT redoing (or double-committing) the
 *   submodule work.
 *
 *   REPLAY-SAFE — a DBOS resume that replays recorded step outputs (full or partial)
 *   never double-commits: a replayed commit checkpoint is never re-executed, and a
 *   re-executed push on an already-pushed HEAD is `Everything up-to-date`.
 *
 * Plus the WI-1416 hang guard: a wedged git subprocess fails FAST with a recorded
 * timeout error instead of hanging the fire into a reap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// WI-6824: runGitSync's `log` sink defaults to console.warn (it used to be a no-op, which is
// why a real ~10h git-sync fault left zero trace in journald). This suite deliberately drives
// blocked/deferred submodule paths, which narrate — capture the expected output.
let gitSyncWarnSpy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
  gitSyncWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  gitSyncWarnSpy?.mockRestore();
  gitSyncWarnSpy = undefined;
});
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runGitSync,
  runGitBounded,
  gitTimeoutMsFor,
  gitHardTimeoutMsFor,
  gitSyncSidecarEnabled,
  type GitSyncStepRunner,
  type RunGit,
} from './run-git-sync';
import { markSpawnOffloadHost, resetSpawnOffloadHostForTest } from '../../fleet/git-via-sidecar';

/** Run git synchronously for test setup; throws on failure. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
function configUser(repo: string): void {
  git(repo, 'config', 'user.email', 'test@papercusp.local');
  git(repo, 'config', 'user.name', 'git-sync checkpoint test');
  git(repo, 'config', 'commit.gpgsign', 'false');
}

/** A step runner that records executed step names/outputs, optionally REPLAYS
 *  pre-recorded outputs (a DBOS resume: recorded steps return their checkpoint
 *  without executing), and optionally ABORTS right after a named step completes
 *  (the executor reaper cancelling the workflow post-checkpoint). */
function makeStepRunner(o: {
  names: string[];
  outputs?: Map<string, unknown>;
  replay?: Map<string, unknown>;
  abortAfter?: string;
}): GitSyncStepRunner {
  return async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    if (o.replay?.has(name)) {
      o.names.push(`${name} (replayed)`);
      return o.replay.get(name) as T;
    }
    const out = await fn();
    o.names.push(name);
    o.outputs?.set(name, out);
    if (o.abortAfter === name) throw new Error('simulated reap: workflow cancelled after checkpoint');
    return out;
  };
}

describe('WI-1416 checkpointed pipeline (real git, submodule)', () => {
  let root: string;
  let superOrigin: string;
  let subOrigin: string;
  let repo: string;

  // file:// submodule add/update is blocked by default (CVE) — allow it in setup.
  const allowFile = ['-c', 'protocol.file.allow=always'];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gitsync-ckpt-'));
    superOrigin = join(root, 'super-origin.git');
    subOrigin = join(root, 'sub-origin.git');
    git(root, 'init', '--bare', '-b', 'main', superOrigin);
    git(root, 'init', '--bare', '-b', 'main', subOrigin);

    const subseed = join(root, 'subseed');
    git(root, 'clone', subOrigin, subseed);
    configUser(subseed);
    writeFileSync(join(subseed, 'sub.txt'), 'sub-v1\n');
    git(subseed, 'add', '-A');
    git(subseed, 'commit', '--no-verify', '-m', 'sub init');
    git(subseed, 'push', '-u', 'origin', 'main');

    const superseed = join(root, 'superseed');
    git(root, 'clone', superOrigin, superseed);
    configUser(superseed);
    git(superseed, ...allowFile, 'submodule', 'add', subOrigin, 'libs/sub');
    configUser(join(superseed, 'libs/sub'));
    git(superseed, 'add', '-A');
    git(superseed, 'commit', '--no-verify', '-m', 'super init + submodule');
    git(superseed, 'push', '-u', 'origin', 'main');

    repo = join(root, 'repo');
    git(root, 'clone', superOrigin, repo);
    configUser(repo);
    git(repo, ...allowFile, 'submodule', 'update', '--init', '--recursive');
    configUser(join(repo, 'libs/sub'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const revCount = (bare: string): number => Number(git(bare, 'rev-list', '--count', 'main'));

  it('ACCEPTANCE: a fire reaped after the submodules checkpoint RESUMES+COMMITS on the requeued fire — no restart loop, no double-commit', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');

    // FIRE 1 — cancelled (reaped) right after the `git-sync:submodules` checkpoint.
    const names1: string[] = [];
    await expect(
      runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: names1, abortAfter: 'git-sync:submodules' }) }),
    ).rejects.toThrow(/simulated reap/);
    expect(names1).toEqual(['git-sync:submodules']);
    // The checkpointed phase's work is DURABLE: the submodule commit reached its origin…
    expect(git(subOrigin, 'log', '--format=%s', 'main')).toMatch(/sync\(root\): sub-work\.txt/);
    const subCountAfterFire1 = revCount(subOrigin);
    // …while the superproject (killed before its phases) has NOT moved.
    expect(git(superOrigin, 'log', '--format=%s', 'main')).not.toMatch(/auto-commit ckpt/);
    const superCountAfterFire1 = revCount(superOrigin);

    // FIRE 2 — the requeued fire (a NEW workflow, from the top). It must CONVERGE:
    // finish the superproject pointer-bump + push, and NOT re-commit the submodule.
    const names2: string[] = [];
    const out = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: names2 }) });
    expect(names2).toEqual(['git-sync:submodules', 'git-sync:pointer-bump', 'git-sync:push']);
    expect(out.status).toBe('synced');
    if (out.status === 'synced') {
      expect(out.pushed).toContain('superproject');
      expect(out.pushed).not.toContain('libs/sub'); // nothing redone — fire 1's push stands
    }
    // NO double-commit: the submodule origin gained ZERO commits on the requeued fire.
    expect(revCount(subOrigin)).toBe(subCountAfterFire1);
    // The superproject converged: exactly one new commit, whose gitlink resolves remotely.
    expect(revCount(superOrigin)).toBe(superCountAfterFire1 + 1);
    const subHead = git(join(repo, 'libs/sub'), 'rev-parse', 'HEAD');
    expect(git(repo, 'rev-parse', 'HEAD:libs/sub')).toBe(subHead);
    expect(() => git(subOrigin, 'cat-file', '-e', `${subHead}^{commit}`)).not.toThrow();
  });

  it('ACCEPTANCE: a FULL DBOS replay (all step outputs recorded) re-executes NOTHING and does not double-commit', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');

    const outputs = new Map<string, unknown>();
    const first = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: [], outputs }) });
    expect(first.status).toBe('synced');
    const subCount = revCount(subOrigin);
    const superCount = revCount(superOrigin);

    // The resume: every phase replays its checkpoint. Inject a runGit that FAILS the
    // test if the pipeline touches git at all outside the replayed steps.
    const forbiddenRunGit: RunGit = async (args) => {
      throw new Error(`replay must not execute git (got: git ${args.join(' ')})`);
    };
    const names: string[] = [];
    const replayed = await runGitSync('ckpt', {
      repoPath: repo,
      runGit: forbiddenRunGit,
      step: makeStepRunner({ names, replay: outputs }),
    });
    expect(names).toEqual([
      'git-sync:submodules (replayed)',
      'git-sync:pointer-bump (replayed)',
      'git-sync:push (replayed)',
    ]);
    // The replayed pass reconstructs the SAME outcome from checkpoints alone…
    expect(replayed).toEqual(first);
    // …and made zero new commits anywhere.
    expect(revCount(subOrigin)).toBe(subCount);
    expect(revCount(superOrigin)).toBe(superCount);
  });

  it('replays a pre-skipped-path PhaseCollect checkpoint as an empty census', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');

    const outputs = new Map<string, unknown>();
    const first = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: [], outputs }) });
    expect(first.status).toBe('synced');

    // A checkpoint written before skippedPaths was added has the older PhaseCollect
    // shape. Keep the other phase outputs intact and replay every step without git.
    const oldSubmoduleCheckpoint = { ...(outputs.get('git-sync:submodules') as Record<string, unknown>) };
    delete oldSubmoduleCheckpoint.skippedPaths;
    const replay = new Map(outputs);
    replay.set('git-sync:submodules', oldSubmoduleCheckpoint);
    const forbiddenRunGit: RunGit = async (args) => {
      throw new Error(`replay must not execute git (got: git ${args.join(' ')})`);
    };
    const resumed = await runGitSync('ckpt', {
      repoPath: repo,
      runGit: forbiddenRunGit,
      step: makeStepRunner({ names: [], replay }),
    });
    expect(resumed).toEqual(first);
  });

  it('ACCEPTANCE: a PARTIAL resume (commit checkpointed, push re-executed) never double-commits — the re-run push is a no-op', async () => {
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');

    const outputs = new Map<string, unknown>();
    const first = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names: [], outputs }) });
    expect(first.status).toBe('synced');
    const subCount = revCount(subOrigin);
    const superCount = revCount(superOrigin);

    // Resume with the submodules + pointer-bump checkpoints only: the push step
    // RE-EXECUTES against real git. The replayed commit checkpoint claims
    // committedLocal=true — the re-run push must find `Everything up-to-date`,
    // not mint a second commit.
    const replay = new Map<string, unknown>([
      ['git-sync:submodules', outputs.get('git-sync:submodules')],
      ['git-sync:pointer-bump', outputs.get('git-sync:pointer-bump')],
    ]);
    const names: string[] = [];
    const resumed = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names, replay }) });
    expect(names).toEqual([
      'git-sync:submodules (replayed)',
      'git-sync:pointer-bump (replayed)',
      'git-sync:push',
    ]);
    expect(resumed.status).toBe('synced'); // committedLocal from the checkpoint
    if (resumed.status === 'synced') {
      // The outcome reports the WHOLE fire's work: the replayed submodule checkpoint's
      // push, but NOT a fresh superproject push — the re-run found nothing to move.
      expect(resumed.pushed).toEqual(['libs/sub']);
    }
    expect(revCount(subOrigin)).toBe(subCount);
    expect(revCount(superOrigin)).toBe(superCount);
  });

  it('blocked submodules defer the superproject PUSH: pointer-bump IS minted, the push checkpoint never is', async () => {
    // Dirty the submodule, then break its CANONICAL origin so its phase errors
    // (GAP-4 shape). EI-20329530284626235 reconciles an initialized submodule's
    // copied origin from .gitmodules before every pass, so poisoning only the copy
    // is stale fixture setup: git-sync correctly heals it and the test false-reds.
    writeFileSync(join(repo, 'libs/sub', 'sub-work.txt'), 'sub work\n');
    writeFileSync(join(repo, 'super-work.txt'), 'super work\n');
    git(repo, 'config', '-f', '.gitmodules', 'submodule.libs/sub.url', join(root, 'gone.git'));

    const names: string[] = [];
    const out = await runGitSync('ckpt', { repoPath: repo, step: makeStepRunner({ names }) });
    expect(out.status).toBe('error');
    // EI-20182436053613562: the local commit ALWAYS runs, so its phase is a genuine
    // completed step and is checkpointed as one — a crashed fire that resumes replays it
    // instead of re-committing. Only the NETWORK half is withheld while a submodule is
    // unreconciled, so `git-sync:push` is still never minted.
    expect(names).toEqual(['git-sync:submodules', 'git-sync:pointer-bump']);
    expect(names).not.toContain('git-sync:push');
    expect(git(superOrigin, 'log', '--format=%s', 'main')).not.toMatch(/auto-commit ckpt/);
    // ...and the superproject's own work is safely committed locally rather than stranded.
    expect(git(repo, 'log', '--format=%s', 'HEAD')).toMatch(/sync\(root,sub\):/);
  });
});

/**
 * `runGitBounded` routes a fetch through `withGitFetchHeadroom`, which first asks git for its
 * object store (`rev-parse --path-format=absolute --git-path objects`) and measures disk
 * headroom there. A fake `git` that ignores that preflight gets the fetch REFUSED with
 * "disk headroom unmeasured" (code -1) before the hang guard under test ever runs — which
 * was misfiled as load flakiness (WI-10003550). Answer it with the fake's own real working
 * directory so the headroom sample measures an existing path, then fall through unchanged.
 */
const HEADROOM_PREFLIGHT_ANSWER = 'case " $* " in *" rev-parse "*) pwd; exit 0;; esac\n';

describe('WI-1416 git subprocess hang guard', () => {
  it('kills a wedged git subprocess at the ceiling and reports a recorded timeout error (fail fast, not a silent reap)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gitsync-hang-'));
    const oldPath = process.env.PATH;
    const oldSidecar = process.env.PAPERCUSP_SPAWNER_SIDECAR;
    try {
      // Do not depend on `git credential fill` blocking: newer Git builds reject an
      // empty credential request immediately with 128. A PATH-local fake is the
      // deterministic equivalent of a git child wedged before producing output.
      const bin = join(cwd, 'bin');
      mkdirSync(bin);
      const fakeGit = join(bin, 'git');
      writeFileSync(fakeGit, '#!/bin/sh\nexec sleep 60\n');
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ''}`;
      process.env.PAPERCUSP_SPAWNER_SIDECAR = '0';

      const started = Date.now();
      const r = await runGitBounded(['status', '--porcelain'], cwd, 300);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(r.code).toBe(-1);
      expect(r.stderr).toMatch(/timed out after 300ms — killed by the git-sync hang guard/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldSidecar === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR = oldSidecar;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('classifies network subcommands (fetch/push) under the network ceiling, everything else under the local one — leading flags skipped', () => {
    const network = gitTimeoutMsFor(['push', 'origin', 'HEAD:main']);
    const local = gitTimeoutMsFor(['status', '--porcelain']);
    expect(network).toBe(4 * 60_000);
    expect(local).toBe(6 * 60_000);
    expect(gitTimeoutMsFor(['-c', 'x=y', 'fetch', 'origin'])).toBe(network);
    expect(gitTimeoutMsFor(['submodule', 'status', '--recursive'])).toBe(local);
    expect(gitHardTimeoutMsFor(['fetch', 'origin'], network)).toBe(60 * 60_000);
    expect(gitHardTimeoutMsFor(['status'], local)).toBe(local);
  });

  it('refreshes the network idle deadline on forced git progress, allowing a healthy fetch to outlive the old wall clock', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'gitsync-progress-'));
    const oldPath = process.env.PATH;
    const oldSidecar = process.env.PAPERCUSP_SPAWNER_SIDECAR;
    const oldHardTimeout = process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
    try {
      const bin = join(cwd, 'bin');
      mkdirSync(bin);
      const fakeGit = join(bin, 'git');
      // WI-38329 — TIMING BUDGET, do not re-tighten. This test asserts a REFRESH property, so
      // it needs the child to outlive the idle deadline; that only works if the deadline sits
      // ABOVE the inter-output gap and BELOW the child's total runtime. The constraint is
      // FOUR-WAY, not one deadline (WI-38338 derived it, and it is asserted below):
      //     gap  <  idle deadline  <  total runtime  <  hard ceiling
      // idle > gap = jitter tolerance · idle < total = falsifiability · total < ceiling or the
      // ceiling kills the HEALTHY child and fails this test for the WRONG reason.
      //
      // TWICE-BEATEN HISTORY, and why this fix is not a third re-tune of the same knob:
      //   80ms gap / 120ms deadline (1.5x) -> red on six concurrent vitest workers.
      //   50ms gap / 300ms deadline (6x)   -> red again at box load 129 AND at load 85
      //                                       (runId 89c526a9, clean tree, tip).
      // Both fixes widened the RATIO and both were beaten, because the ratio was never the
      // governing quantity. The fake git forks a `sleep` per iteration, so the gap is
      //     gap = sleep constant (load-INDEPENDENT) + fork/exec of /bin/sleep (load-DEPENDENT)
      // and at 50ms the load-dependent term DOMINATES — under contention fork latency alone
      // exceeded the whole 300ms deadline, which no multiple of a 50ms sleep can bound. The
      // premise the 6x budget rested on ("load only stretches the total, which strengthens
      // falsifiability") is false for the same reason: load stretches the GAP too.
      //
      // THE FIX IS TO INVERT THAT RATIO, not to widen it again: a 500ms sleep dominates fork
      // cost instead of being dwarfed by it, so the load-dependent term is a small fraction of
      // the gap rather than the whole of it — and 5 iterations instead of 10 halves the number
      // of forks that can each go slow. Absolute headroom (1000ms), which is the real lever,
      // is 4x the old budget's while the nominal runtime stays ~2.5s.
      //
      // BEATEN A FOURTH TIME (WI-6554700010008342): the 500ms gap / 1500ms deadline went red in
      // green-checkpoint run 3ff293fb (2026-10-11, repair head e526f5d4) with `code -1`, while the
      // file passed alone at the same sha. The ratio is no longer the problem; the absolute
      // headroom (deadline minus gap) is, because a loaded gate can lose more than 1s between two
      // writes. Since the ratio fix, run-git-sync defers the idle verdict to setImmediate, so a
      // stalled PARENT loop already reads pending bytes first; what remains is a slow CHILD (the
      // shell or the next `sleep` descheduled). So this widens only the headroom, from 1000ms to
      // 4000ms, and keeps the four-way chain: without the refresh the child is still killed 2000ms
      // before it would finish.
      const GAP_MS = 1_000;
      const ITERATIONS = 7;
      const NOMINAL_TOTAL_MS = GAP_MS * ITERATIONS;
      const IDLE_DEADLINE_MS = 5_000;
      // Only has to be high enough never to fire on a HEALTHY child; the ceiling is
      // `Math.max(idleTimeoutMs, env)` (run-git-sync.ts:143-146), so it can never sit below the
      // idle deadline no matter what is set here.
      const HARD_CEILING_MS = 30_000;
      // Recurrence guard: makes the four-way chain EXECUTABLE, so a future re-tighten fails
      // loudly and deterministically here instead of flaking on the shared gate hours later.
      expect(GAP_MS).toBeLessThan(IDLE_DEADLINE_MS);
      expect(IDLE_DEADLINE_MS).toBeLessThan(NOMINAL_TOTAL_MS);
      expect(NOMINAL_TOTAL_MS).toBeLessThan(HARD_CEILING_MS);
      writeFileSync(
        fakeGit,
        `#!/bin/sh\n${HEADROOM_PREFLIGHT_ANSWER}printf "%s\\n" "$@" > "$PWD/argv"\ni=0\nwhile test "$i" -lt ${ITERATIONS}; do echo "progress $i" >&2; sleep ${GAP_MS / 1000}; i=$((i + 1)); done\n`,
      );
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ''}`;
      process.env.PAPERCUSP_SPAWNER_SIDECAR = '0';
      process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = String(HARD_CEILING_MS);

      const started = Date.now();
      const r = await runGitBounded(['fetch', 'origin', 'main'], cwd, IDLE_DEADLINE_MS);
      // Outliving the deadline IS the property under test: without the refresh the child is
      // killed at 5000ms, a full 2000ms short of finishing, so `code` is -1 and the last
      // progress line never arrives. Both assertions below fail on a real regression.
      expect(Date.now() - started).toBeGreaterThanOrEqual(IDLE_DEADLINE_MS);
      expect(r.code).toBe(0);
      expect(r.stderr).toContain(`progress ${ITERATIONS - 1}`);
      expect(readFileSync(join(cwd, 'argv'), 'utf8').split('\n')).toContain('--progress');
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldSidecar === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR = oldSidecar;
      if (oldHardTimeout === undefined) delete process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = oldHardTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
    // WI-38338: vitest's 5000ms default was itself a live flake vector here, independent of the
    // timing budget. WI-38329 raised the nominal runtime to ~2.5s, so the explicit deadline is
    // raised with it to keep the same generous multiple; this changes no timing semantics.
    // WI-6554700010008342 raised the nominal runtime to ~7s, so the deadline is 60s.
  }, 60_000);

  it('still kills an endlessly-chatty network child at the independent hard ceiling', async () => {
    // WI-38338 — TIMING BUDGET, do not re-tighten. This is the SIBLING of the WI-38223 fix above
    // and it survived that fix carrying the identical defect: the same 50ms emitter, but against a
    // 120ms idle deadline — only 2.4x jitter tolerance. Measured 2026-08-12: 9/9 passing ALONE,
    // but 1 failure inside a 5-file parallel run, which is what reds the shared green-checkpoint.
    //
    // THE MECHANISM (run-git-sync.ts): terminate() is FIRST-TIMER-WINS (:197 — `if (settled ||
    // terminating) return`), racing the RE-ARMED idle deadline against the absolute hard ceiling.
    // A stretched 50ms gap let the IDLE guard win and kill the child with the wrong reason
    // ("made no output progress"), so the asserted ceiling message never appeared.
    //
    // ⚠ THE TRAP, measured the hard way 2026-08-12: you CANNOT fix that by lifting the idle
    // deadline above the ceiling. `gitHardTimeoutMsFor` (:143-146) computes the ceiling as
    // `Math.max(idleTimeoutMs, env)` — the ceiling can NEVER sit below the idle deadline. Raising
    // idle to 2000ms silently dragged the ceiling to 2000ms with it, so the child died at 2s
    // reporting "exceeded the 2000ms hard ceiling" and this regex missed all over again.
    // The ordering `gap < idle < ceiling` is therefore FORCED, and the race is inherent: the only
    // real lever is ABSOLUTE headroom between the gap and the idle deadline.
    //
    // BUDGET: 50ms gap · 1500ms idle (30x jitter tolerance) · 3000ms ceiling. WI-38223 set the
    // sibling at :294 to 6x and that has ALREADY been beaten on this box (su-ead0a, 2026-08-12) —
    // 6x is not enough here, so do not re-tighten toward it.
    // STILL FALSIFIABLE: drop the hard timer and the endlessly-chatty child is never killed at all
    // (idle re-arms on every write), so this test fails on its explicit timeout below rather than
    // passing vacuously.
    const IDLE_DEADLINE_MS = 1_500;
    const HARD_CEILING_MS = 3_000;
    // Recurrence guard for the exact trap above: if a future edit pushes the idle deadline to or
    // past the ceiling, Math.max() rewrites the ceiling and the asserted reason drifts. Fail HERE,
    // loudly and deterministically, instead of flaking on the shared gate hours later.
    expect(IDLE_DEADLINE_MS).toBeLessThan(HARD_CEILING_MS);

    const cwd = mkdtempSync(join(tmpdir(), 'gitsync-hard-timeout-'));
    const oldPath = process.env.PATH;
    const oldSidecar = process.env.PAPERCUSP_SPAWNER_SIDECAR;
    const oldHardTimeout = process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
    try {
      const bin = join(cwd, 'bin');
      mkdirSync(bin);
      const fakeGit = join(bin, 'git');
      writeFileSync(fakeGit, `#!/bin/sh\n${HEADROOM_PREFLIGHT_ANSWER}while :; do echo progress >&2; sleep 0.05; done\n`);
      chmodSync(fakeGit, 0o755);
      process.env.PATH = `${bin}:${oldPath ?? ''}`;
      process.env.PAPERCUSP_SPAWNER_SIDECAR = '0';
      process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = String(HARD_CEILING_MS);

      const r = await runGitBounded(['fetch', 'origin', 'main'], cwd, IDLE_DEADLINE_MS);
      expect(r.code).toBe(-1);
      // Built from the constant so the asserted reason cannot drift from the ceiling it names.
      expect(r.stderr).toMatch(
        new RegExp(`exceeded the ${HARD_CEILING_MS}ms hard ceiling despite output progress`),
      );
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      if (oldSidecar === undefined) delete process.env.PAPERCUSP_SPAWNER_SIDECAR;
      else process.env.PAPERCUSP_SPAWNER_SIDECAR = oldSidecar;
      if (oldHardTimeout === undefined) delete process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS;
      else process.env.PAPERCUSP_GIT_SYNC_NETWORK_HARD_TIMEOUT_MS = oldHardTimeout;
      rmSync(cwd, { recursive: true, force: true });
    }
    // Explicit budget: the ceiling above is 3000ms, which leaves too little headroom under
    // vitest's 5000ms default for a loaded box. Pinned so the DEADLINE never becomes the flake.
  }, 20_000);

  it('routes git through the sidecar only on the bg-host opt-in, never inside the sidecar itself', () => {
    try {
      const hostEnv = { PAPERCUSP_SPAWNER_SIDECAR: '1' } as NodeJS.ProcessEnv;
      expect(gitSyncSidecarEnabled(hostEnv)).toBe(false);
      markSpawnOffloadHost();
      expect(gitSyncSidecarEnabled(hostEnv)).toBe(true);
      expect(
        gitSyncSidecarEnabled({
          PAPERCUSP_SPAWNER_SIDECAR: '1',
          PAPERCUSP_SPAWNER_SIDECAR_MODE: '1',
        } as NodeJS.ProcessEnv),
      ).toBe(false);
      expect(
        gitSyncSidecarEnabled({
          PAPERCUSP_SPAWNER_SIDECAR: '1',
          PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: '0',
        } as NodeJS.ProcessEnv),
      ).toBe(false);
      expect(gitSyncSidecarEnabled({ PAPERCUSP_GIT_SYNC_SPAWN_SIDECAR: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    } finally {
      resetSpawnOffloadHostForTest();
    }
  });
});
