/**
 * standing-pr-merge-deps — the real git / record-store deps for the standing PR's
 * exact-merge gate (plan pot-review-integration-mode-2026-10-05, P-021 / P-024, D-008),
 * exercised against REAL git: a bare "upstream" repo with refs/pull/<n>/head, and a
 * clone the deps run in. End-to-end cases drive stepStandingPrMerge over these deps.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Pr } from '../../pr-host/types';
import { parsePollMeta } from '../../pr-host/poll-daemon';
import type { MergeTestRecord } from './decide-merge-gate';
import { STANDING_PR_BRANCH } from './decide-standing-pr';
import {
  createDefaultStandingPrMergeDeps,
  isStandingPrMergeRunActive,
  makeWorktreeSuiteRunner,
  MERGE_TEST_FAILURE_OUTPUT_LIMIT,
  STANDING_PR_MERGE_TESTS_META_KEY,
  type RunSuite,
} from './standing-pr-merge-deps';
import { stepStandingPrMerge } from './standing-pr-merge';
import { makeLiveStandingPrMerge } from './standing-pr-merge-live';
import type { PotIntegrationModeRead } from './pot-integration-mode';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV }).trim();
}

const PR_NUMBER = 7;
const INSTALL = 'upstream-install';

let root: string;
let bare: string;
let work: string; // author's clone: makes upstream + PR commits
let deps_repo: string; // the clone the deps run in

/** In-memory PollStore slice with the daemon's real shallow-merge + parse semantics. */
function memStore() {
  let pollPoll: Record<string, unknown> = {};
  return {
    async readMeta() {
      return parsePollMeta(pollPoll);
    },
    async patchMeta(_slug: string, patch: Record<string, unknown>) {
      pollPoll = { ...pollPoll, ...JSON.parse(JSON.stringify(patch)) };
    },
    raw: () => pollPoll,
  };
}

function commitFile(dir: string, file: string, content: string, msg: string): string {
  writeFileSync(join(dir, file), content);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

/** Publish `sha` as the PR head in the bare upstream (GitHub's refs/pull/<n>/head). */
function publishPrHead(sha: string) {
  git(work, 'push', '-q', 'origin', `${sha}:refs/pull/${PR_NUMBER}/head`, '--force');
}

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('waitFor timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'standing-pr-merge-deps-'));
  bare = join(root, 'upstream.git');
  work = join(root, 'work');
  deps_repo = join(root, 'deps');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, work);
  git(work, 'checkout', '-q', '-b', 'main');
  commitFile(work, 'a.txt', 'base\n', 'base');
  git(work, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', bare, deps_repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeDeps(
  store: ReturnType<typeof memStore>,
  runSuite: RunSuite = async () => true,
  onError?: (e: unknown) => void,
  admittedFixPaths?: string[],
) {
  return createDefaultStandingPrMergeDeps({
    repoDir: deps_repo,
    installSlug: INSTALL,
    prNumber: PR_NUMBER,
    store,
    runSuite,
    onError,
    resolveAdmittedFixPaths: async ({ prHeadSha, targetTipSha }) => ({
      ok: true,
      paths: admittedFixPaths ?? git(deps_repo, 'diff', '--no-renames', '--name-only', `${targetTipSha}...${prHeadSha}`)
        .split('\n').filter(Boolean),
    }),
  });
}

/** A PR branch off main touching its own file, published as refs/pull/7/head. */
function makePrHead(file = 'pr.txt', content = 'pr\n', additionalFiles: Record<string, string> = {}): string {
  const base = git(work, 'rev-parse', 'main');
  git(work, 'checkout', '-q', '-b', `pr-${Date.now()}-${Math.random().toString(36).slice(2)}`, base);
  let head = commitFile(work, file, content, 'pr change');
  for (const [extraFile, extraContent] of Object.entries(additionalFiles)) {
    head = commitFile(work, extraFile, extraContent, 'additional PR change');
  }
  git(work, 'checkout', '-q', 'main');
  publishPrHead(head);
  return head;
}

/** Advance upstream main with an unrelated commit (another contributor merged). */
function moveUpstreamMain(file = 'other.txt'): string {
  git(work, 'checkout', '-q', 'main');
  git(work, 'pull', '-q', '--ff-only', 'origin', 'main');
  const sha = commitFile(work, file, `${Date.now()}\n`, 'upstream moved');
  git(work, 'push', '-q', 'origin', 'main');
  return sha;
}

describe('createDefaultStandingPrMergeDeps (real git)', () => {
  it('readTargetTip reads the upstream branch tip', async () => {
    const d = makeDeps(memStore());
    expect(await d.readTargetTip('main')).toBe(git(bare, 'rev-parse', 'main'));
  });

  it('buildMergeResult builds the exact merge commit: parents [tip, head], pinned ref, both changes present', async () => {
    const head = makePrHead();
    const tip = moveUpstreamMain();
    const d = makeDeps(memStore());
    const merge = await d.buildMergeResult(head, tip);
    expect(merge).toMatch(/^[0-9a-f]{40}$/);
    expect(git(deps_repo, 'rev-list', '--parents', '-n1', merge!).split(' ').slice(1)).toEqual([tip, head]);
    expect(git(deps_repo, 'rev-parse', `refs/papercusp/standing-merge/${PR_NUMBER}`)).toBe(merge);
    const files = git(deps_repo, 'ls-tree', '--name-only', merge!).split('\n');
    expect(files).toEqual(expect.arrayContaining(['a.txt', 'pr.txt', 'other.txt']));
  });

  it('buildMergeResult returns null on a conflict', async () => {
    const head = makePrHead('a.txt', 'pr side\n');
    git(work, 'checkout', '-q', 'main');
    const tip = commitFile(work, 'a.txt', 'upstream side\n', 'conflicting');
    git(work, 'push', '-q', 'origin', 'main');
    const d = makeDeps(memStore());
    expect(await d.buildMergeResult(head, tip)).toBeNull();
  });

  it('advanceTarget fast-forwards the base to exactly the tested sha', async () => {
    const head = makePrHead();
    const tip = git(bare, 'rev-parse', 'main');
    const d = makeDeps(memStore());
    const merge = (await d.buildMergeResult(head, tip))!;
    expect(await d.advanceTarget({ baseBranch: 'main', sha: merge, expectedTip: tip })).toEqual({ ok: true });
    expect(git(bare, 'rev-parse', 'main')).toBe(merge);
  });

  it('advanceTarget is refused by the lease when the target moved, and reports the new tip', async () => {
    const head = makePrHead();
    const tip = git(bare, 'rev-parse', 'main');
    const d = makeDeps(memStore());
    const merge = (await d.buildMergeResult(head, tip))!;
    const moved = moveUpstreamMain();
    const res = await d.advanceTarget({ baseBranch: 'main', sha: merge, expectedTip: tip });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.tipAtPush).toBe(moved);
    expect(git(bare, 'rev-parse', 'main')).toBe(moved);
  });

  it('startTests records pass / fail; a suite that could not run clears the record', async () => {
    for (const [suite, expected] of [
      [async () => true, 'pass'],
      [async () => false, 'fail'],
      [async () => { throw new Error('spawn failed'); }, null],
    ] as Array<[RunSuite, string | null]>) {
      const store = memStore();
      const errors: unknown[] = [];
      const d = makeDeps(store, suite, (e) => errors.push(e));
      const rec: MergeTestRecord = { mergeSha: 'm'.repeat(40), prHeadSha: 'h'.repeat(40), targetTipSha: 't'.repeat(40), result: 'running' };
      await d.saveTest(PR_NUMBER, rec);
      await d.startTests(PR_NUMBER, rec);
      await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, rec.mergeSha));
      const stored = (store.raw()[STANDING_PR_MERGE_TESTS_META_KEY] as Record<string, MergeTestRecord>)[String(PR_NUMBER)];
      if (expected === null) {
        expect(stored).toBeUndefined();
        expect(errors).toHaveLength(1);
      } else {
        expect(stored.result).toBe(expected);
        expect(await d.loadLastTest(PR_NUMBER)).toEqual({ ...rec, result: expected });
      }
    }
  });

  it('a running record with no live run in this process (restart) reads as absent', async () => {
    const store = memStore();
    const d = makeDeps(store);
    const rec: MergeTestRecord = { mergeSha: 'z'.repeat(40), prHeadSha: 'h'.repeat(40), targetTipSha: 't'.repeat(40), result: 'running' };
    await d.saveTest(PR_NUMBER, rec);
    expect(await d.loadLastTest(PR_NUMBER)).toBeNull();
  });

  it('reports a store that kept the fail verdict but dropped its diagnostics', async () => {
    const store = memStore();
    const errors: unknown[] = [];
    const d = createDefaultStandingPrMergeDeps({
      repoDir: deps_repo, installSlug: INSTALL, prNumber: PR_NUMBER,
      store: {
        ...store,
        async patchMeta(slug, patch) {
          const copied = JSON.parse(JSON.stringify(patch));
          const saved = copied[STANDING_PR_MERGE_TESTS_META_KEY]?.[String(PR_NUMBER)];
          if (saved) delete saved.failure;
          await store.patchMeta(slug, copied);
        },
      },
      runSuite: async () => ({ passed: false, failure: { phase: 'suite', exitCode: 2, output: 'must survive' } }),
      onError: (e) => errors.push(e),
    });
    const rec: MergeTestRecord = { mergeSha: 'v'.repeat(40), prHeadSha: 'h'.repeat(40), targetTipSha: 't'.repeat(40), result: 'running' };
    await d.saveTest(PR_NUMBER, rec);
    await d.startTests(PR_NUMBER, rec);
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, rec.mergeSha));
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('was not saved');
    expect((await d.loadLastTest(PR_NUMBER))?.result).toBe('fail');
  });

  it('the record survives the daemon writing its own pr_poll keys (shallow merge)', async () => {
    const store = memStore();
    const d = makeDeps(store);
    const rec: MergeTestRecord = { mergeSha: 'y'.repeat(40), prHeadSha: 'h'.repeat(40), targetTipSha: 't'.repeat(40), result: 'pass' };
    await d.saveTest(PR_NUMBER, rec);
    await store.patchMeta(INSTALL, { last_seen: {}, consecutive_errors: 0, last_status: 'ok' });
    expect(await d.loadLastTest(PR_NUMBER)).toEqual(rec);
  });
});

describe('stepStandingPrMerge over the real deps (D-008 end to end)', () => {
  function pr(head: string): Pr {
    return { ref: { number: PR_NUMBER }, head_ref: STANDING_PR_BRANCH, base_ref: 'main', head_sha: head, review_decision: 'approved', checks_state: 'success' } as Pr;
  }
  const input = (head: string, promotedSha: string | null = head) => ({ pr: pr(head), policy: 'auto' as const, promotedSha, authorRevoked: false });

  it('refuses a real-git PR diff path that is outside the admitted fix manifest', async () => {
    const head = makePrHead('fix.ts', 'fix\n', { 'unrelated.ts': 'unrelated\n' });
    let suites = 0;
    const d = makeDeps(memStore(), async () => { suites += 1; return true; }, undefined, ['fix.ts']);
    const before = git(bare, 'rev-parse', 'main');

    const out = await stepStandingPrMerge(input(head), d);

    expect(out).toMatchObject({ action: 'refused', reason: 'unattributed-delta' });
    expect(out.action === 'refused' && out.detail).toContain('unrelated.ts');
    expect(suites).toBe(0);
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
    expect(await d.loadLastTest(PR_NUMBER)).toBeNull();
  });

  it('never-tested -> testing -> merged; the target lands on exactly the tested sha', async () => {
    const head = makePrHead();
    const tested: string[] = [];
    const d = makeDeps(memStore(), async ({ sha }) => (tested.push(sha), true));
    const first = await stepStandingPrMerge(input(head), d);
    expect(first.action).toBe('testing');
    const mergeSha = (first as { mergeSha: string }).mergeSha;
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, mergeSha));
    const second = await stepStandingPrMerge(input(head), d);
    expect(second).toMatchObject({ action: 'merged', mergeSha });
    expect(tested).toEqual([mergeSha]);
    expect(git(bare, 'rev-parse', 'main')).toBe(mergeSha);
  });

  it('target moved after a pass -> rebuilt and re-tested on the new tip, never merged untested', async () => {
    const head = makePrHead();
    const tested: string[] = [];
    const d = makeDeps(memStore(), async ({ sha }) => (tested.push(sha), true));
    const first = (await stepStandingPrMerge(input(head), d)) as { mergeSha: string };
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, first.mergeSha));
    const moved = moveUpstreamMain();
    const second = await stepStandingPrMerge(input(head), d);
    expect(second).toMatchObject({ action: 'testing', reason: 'target-moved' });
    expect(git(bare, 'rev-parse', 'main')).toBe(moved);
    const secondSha = (second as { mergeSha: string }).mergeSha;
    expect(secondSha).not.toBe(first.mergeSha);
    expect(git(deps_repo, 'rev-list', '--parents', '-n1', secondSha).split(' ')[1]).toBe(moved);
  });

  it('a failing suite never merges', async () => {
    const head = makePrHead();
    const before = git(bare, 'rev-parse', 'main');
    const d = makeDeps(memStore(), async () => false);
    const first = (await stepStandingPrMerge(input(head), d)) as { mergeSha: string };
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, first.mergeSha));
    const second = await stepStandingPrMerge(input(head), d);
    expect(second.action).not.toBe('merged');
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
  });

  it('a PR head moved after a pass is re-tested before the target can advance', async () => {
    const head = makePrHead();
    const target = git(bare, 'rev-parse', 'main');
    const tested: string[] = [];
    const d = makeDeps(memStore(), async ({ sha }) => (tested.push(sha), true));
    const first = (await stepStandingPrMerge(input(head), d)) as { mergeSha: string };
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, first.mergeSha));

    const movedHead = makePrHead('new-fix.txt', 'new fix\n');
    const second = await stepStandingPrMerge(input(movedHead), d);
    expect(second).toMatchObject({ action: 'testing', reason: 'pr-head-moved' });
    expect(git(bare, 'rev-parse', 'main')).toBe(target);
    const secondSha = (second as { mergeSha: string }).mergeSha;
    expect(secondSha).not.toBe(first.mergeSha);
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, secondSha));

    expect(await stepStandingPrMerge(input(movedHead), d)).toMatchObject({ action: 'merged', mergeSha: secondSha });
    expect(tested).toEqual([first.mergeSha, secondSha]);
    expect(git(bare, 'rev-parse', 'main')).toBe(secondSha);
    expect(git(bare, 'rev-list', '--parents', '-n1', secondSha).split(' ').slice(1)).toEqual([target, movedHead]);
  });

  it('a PR head that is not the promoted commit is refused before anything is built', async () => {
    const head = makePrHead();
    const d = makeDeps(memStore());
    const out = await stepStandingPrMerge(input(head, 'f'.repeat(40)), d);
    expect(out).toMatchObject({ action: 'refused', reason: 'pr-head-not-promoted' });
  });
});

/**
 * P-021 end to end: the production entry the poll daemon calls
 * (makeLiveStandingPrMerge) over REAL git — real promotedSha (the checkout's local
 * main), real suite-command resolution (the checkout's package.json), real deps and
 * a real worktree suite run. Only the DB-backed integration-mode read is injected.
 */
describe('makeLiveStandingPrMerge over real git (P-021 auto-merge policy)', () => {
  const REVIEW: PotIntegrationModeRead = { mode: 'review', source: 'set' };
  const DIRECT: PotIntegrationModeRead = { mode: 'direct', source: 'set' };

  function standingPr(head: string): Pr {
    return { ref: { number: PR_NUMBER }, head_ref: STANDING_PR_BRANCH, base_ref: 'main', head_sha: head, review_decision: 'approved', checks_state: 'success' } as Pr;
  }

  /** The pot's green gate promoted `head`: the checkout's local main now points at it. */
  function promoteInCheckout(head: string) {
    git(deps_repo, 'fetch', '-q', 'origin', `refs/pull/${PR_NUMBER}/head`);
    git(deps_repo, 'checkout', '-q', '--detach');
    git(deps_repo, 'update-ref', 'refs/heads/main', head);
  }

  function live(integration: PotIntegrationModeRead) {
    const store = memStore();
    const tested: string[] = [];
    const commands: string[] = [];
    const suiteAsked: string[] = [];
    const entry = makeLiveStandingPrMerge({
      store,
      resolvers: {
        repoDir: async () => deps_repo,
        integration: async () => integration,
        // The pot's own suite (resolvePotSuiteCommand in production), asked per install.
        suiteCommand: async (slug) => (suiteAsked.push(slug), 'npm test'),
        // The real worktree runner then runs a stand-in suite that passes only when the
        // PR's file is present.
        runSuite: (command) => {
          commands.push(command);
          const real = makeWorktreeSuiteRunner('test -f pr.txt && test -f a.txt');
          return async (a) => (tested.push(a.sha), real(a));
        },
        buildDeps: ({ runSuite }) => makeDeps(store, runSuite),
      },
    });
    return { entry, tested, commands, suiteAsked };
  }

  const call = (head: string, autoMerge: boolean) => ({
    workspaceId: 'ws',
    installSlug: INSTALL,
    remote: 'owner/repo',
    pr: standingPr(head),
    autoMerge,
    authorRevoked: false,
  });

  it('auto-merge OFF: left for the owner; the target never advances and nothing is built or tested', async () => {
    const head = makePrHead();
    promoteInCheckout(head);
    const before = git(bare, 'rev-parse', 'main');
    const { entry, tested, commands } = live(REVIEW);
    for (let i = 0; i < 2; i += 1) expect(await entry(call(head, false))).toEqual({ action: 'left-for-owner' });
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
    expect(git(deps_repo, 'for-each-ref', 'refs/papercusp')).toBe('');
    expect(tested).toEqual([]);
    expect(commands).toEqual([]);
  });

  it('auto-merge ON but not a working-copy pot: left for the owner, target unchanged', async () => {
    const head = makePrHead();
    promoteInCheckout(head);
    const before = git(bare, 'rev-parse', 'main');
    const { entry, tested } = live(DIRECT);
    expect(await entry(call(head, true))).toEqual({ action: 'left-for-owner' });
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
    expect(tested).toEqual([]);
  });

  it('auto-merge ON in a working-copy pot: tests the exact merge result, then lands the target on exactly that sha', async () => {
    const head = makePrHead();
    promoteInCheckout(head);
    const before = git(bare, 'rev-parse', 'main');
    const { entry, tested, commands, suiteAsked } = live(REVIEW);
    const first = await entry(call(head, true));
    expect(first).toMatchObject({ action: 'testing', reason: 'never-tested' });
    const mergeSha = (first as { mergeSha: string }).mergeSha;
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, mergeSha));
    const second = await entry(call(head, true));
    expect(second).toMatchObject({ action: 'merged', mergeSha });
    // The pot's suite, asked by install slug; the install step is the runner's, not part of it.
    expect(suiteAsked[0]).toBe(INSTALL);
    expect(commands[0]).toBe('npm test');
    expect(tested).toEqual([mergeSha]);
    expect(git(bare, 'rev-parse', 'main')).toBe(mergeSha);
    expect(git(bare, 'rev-list', '--parents', '-n1', mergeSha).split(' ').slice(1)).toEqual([before, head]);
  });

  it('auto-merge ON but the checkout main is not the PR head: refused, target unchanged', async () => {
    const head = makePrHead();
    const { entry, tested } = live(REVIEW);
    // Local main still at base: the PR head was never promoted by the pot's green gate.
    const before = git(bare, 'rev-parse', 'main');
    expect(await entry(call(head, true))).toMatchObject({ action: 'refused', reason: 'pr-head-not-promoted' });
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
    expect(tested).toEqual([]);
  });
});

describe('makeWorktreeSuiteRunner (real git)', () => {
  it('persists both failed-suite streams before cleanup and still refuses the exact merge', async () => {
    const head = makePrHead();
    const before = git(bare, 'rev-parse', 'main');
    const store = memStore();
    const deps = makeDeps(store, makeWorktreeSuiteRunner("printf 'assertion failed on stdout'; printf 'suite stderr detail' >&2; exit 7"));
    const merge = (await deps.buildMergeResult(head, before))!;
    const rec: MergeTestRecord = { mergeSha: merge, prHeadSha: head, targetTipSha: before, result: 'running' };
    await deps.saveTest(PR_NUMBER, rec);
    await deps.startTests(PR_NUMBER, rec);
    await waitFor(() => !isStandingPrMergeRunActive(INSTALL, PR_NUMBER, merge));
    // Reload through new deps: the evidence is durable metadata, not process state.
    const saved = await makeDeps(store).loadLastTest(PR_NUMBER);
    expect(saved).toMatchObject({ ...rec, result: 'fail', failure: { phase: 'suite', exitCode: 7 } });
    expect(saved?.failure?.output).toContain('assertion failed on stdout');
    expect(saved?.failure?.output).toContain('suite stderr detail');
    expect(git(deps_repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    const decision = await stepStandingPrMerge({
      pr: { ref: { number: PR_NUMBER }, head_ref: STANDING_PR_BRANCH, base_ref: 'main', head_sha: head, review_decision: 'approved', checks_state: 'success' } as Pr,
      policy: 'auto', promotedSha: head, authorRevoked: false,
    }, deps);
    expect(decision).toMatchObject({ action: 'refused', reason: 'merge-result-failed' });
    expect(git(bare, 'rev-parse', 'main')).toBe(before);
  });

  it('distinguishes failed installation from a suite that never started', async () => {
    const head = makePrHead('package.json', JSON.stringify({ scripts: { preinstall: "node -e \"console.error('install lifecycle failed'); process.exit(9)\"" }, dependencies: { fixture: 'file:./missing-package' } }));
    git(deps_repo, 'fetch', '-q', 'origin', `refs/pull/${PR_NUMBER}/head`);
    const result = await makeWorktreeSuiteRunner("printf 'suite must not run'")({ repoDir: deps_repo, sha: head });
    expect(result).toMatchObject({ passed: false, failure: { phase: 'install', exitCode: expect.any(Number) } });
    if (!result.passed) {
      expect(result.failure.output).toContain('install lifecycle failed');
      expect(result.failure.output).not.toContain('suite must not run');
    }
  });

  it('bounds persisted diagnostics while retaining the end of each output stream', async () => {
    const tip = git(bare, 'rev-parse', 'main');
    const result = await makeWorktreeSuiteRunner("node -e \"process.stdout.write('x'.repeat(20000)+'STDOUT_END'); process.stderr.write('y'.repeat(20000)+'STDERR_END'); process.exitCode=4\"")({ repoDir: deps_repo, sha: tip });
    expect(result).toMatchObject({ passed: false, failure: { phase: 'suite', exitCode: 4 } });
    if (!result.passed) {
      expect(result.failure.output.length).toBeLessThanOrEqual(MERGE_TEST_FAILURE_OUTPUT_LIMIT);
      expect(result.failure.output).toContain('STDOUT_END');
      expect(result.failure.output).toContain('STDERR_END');
    }
  });

  it('runs the command in a checkout of exactly the given sha: exit 0 = pass, non-zero = fail', async () => {
    const head = makePrHead('only-in-pr.txt');
    const tip = git(bare, 'rev-parse', 'main');
    const d = makeDeps(memStore());
    const merge = await d.buildMergeResult(head, tip);
    const run = makeWorktreeSuiteRunner('test -f only-in-pr.txt && test -f a.txt');
    expect(await run({ repoDir: deps_repo, sha: merge! })).toEqual({ passed: true });
    // The upstream tip lacks the PR's file, so the same suite fails there.
    expect(await run({ repoDir: deps_repo, sha: tip })).toMatchObject({ passed: false, failure: { phase: 'suite', exitCode: 1 } });
  });

  it('removes its worktree afterwards, pass or fail', async () => {
    const tip = git(bare, 'rev-parse', 'main');
    await makeWorktreeSuiteRunner('exit 3')({ repoDir: deps_repo, sha: tip });
    await makeWorktreeSuiteRunner('true')({ repoDir: deps_repo, sha: tip });
    expect(git(deps_repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
  });

  it('decides the dependency install from the merge worktree, not the checkout (WI-10006355)', async () => {
    // The commit under test is a node package with no dependencies and no lockfile:
    // nothing to install, so the suite runs as given and passes.
    const head = makePrHead('package.json', JSON.stringify({ scripts: { test: 'true' } }));
    // The checkout's working tree carries an invalid lockfile the commit does not.
    // Were the install decided here, `npm ci` would run against it and fail the suite.
    writeFileSync(join(deps_repo, 'package.json'), '{"devDependencies":{"x":"1"}}');
    writeFileSync(join(deps_repo, 'package-lock.json'), 'not json');
    git(deps_repo, 'fetch', '-q', 'origin', `refs/pull/${PR_NUMBER}/head`);
    expect(await makeWorktreeSuiteRunner('test -f package.json && test ! -f package-lock.json')({ repoDir: deps_repo, sha: head })).toEqual({ passed: true });
  });

  it('a suite that cannot finish (timeout) throws instead of reporting a fail', async () => {
    const tip = git(bare, 'rev-parse', 'main');
    await expect(makeWorktreeSuiteRunner('sleep 5', { timeoutMs: 200 })({ repoDir: deps_repo, sha: tip })).rejects.toThrow();
  });
});

// slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 D-017 §6: the merge gate's
// publication check, against a real superproject whose submodule has its own main repo.
describe('findUnpublishedGitlinks: submodule commits must be on their main repository (real git)', () => {
  const gitF = (cwd: string, ...args: string[]) => git(cwd, '-c', 'protocol.file.allow=always', ...args);

  it('names a pinned submodule commit until it reaches the submodule main repository, then merges', async () => {
    // The submodule's main repository, and the superproject (upstream) using it.
    const subBare = join(root, 'sub.git');
    const subWork = join(root, 'sub-work');
    git(root, 'init', '-q', '--bare', '-b', 'main', subBare);
    git(root, 'clone', '-q', subBare, subWork);
    git(subWork, 'checkout', '-q', '-b', 'main');
    commitFile(subWork, 's.txt', 's1\n', 'sub base');
    git(subWork, 'push', '-q', 'origin', 'main');
    gitF(work, 'submodule', 'add', '-q', subBare, 'libs/sub');
    git(work, 'commit', '-q', '-m', 'add submodule');
    git(work, 'push', '-q', 'origin', 'main');
    // The deps run in the upstream's own checkout, submodules checked out.
    const upstreamCheckout = join(root, 'upstream-checkout');
    gitF(root, 'clone', '-q', '--recurse-submodules', bare, upstreamCheckout);
    const store = memStore();
    const d = createDefaultStandingPrMergeDeps({
      repoDir: upstreamCheckout, installSlug: INSTALL, prNumber: PR_NUMBER, store, runSuite: async () => true,
      resolveAdmittedFixPaths: async ({ prHeadSha, targetTipSha }) => ({
        ok: true,
        paths: git(upstreamCheckout, 'diff', '--no-renames', '--name-only', `${targetTipSha}...${prHeadSha}`)
          .split('\n').filter(Boolean),
      }),
    });

    // A PR without gitlink changes has nothing to publish.
    const plain = makePrHead();
    expect(await d.findUnpublishedGitlinks(plain, git(bare, 'rev-parse', 'main'))).toEqual({ ok: true, unpublished: [] });

    // The working copy bumps the submodule to a commit only its fork has.
    const workSub = join(work, 'libs/sub');
    const s2 = commitFile(workSub, 's.txt', 's2\n', 'sub change');
    git(work, 'add', 'libs/sub');
    git(work, 'commit', '-q', '-m', 'bump libs/sub');
    const head = git(work, 'rev-parse', 'HEAD');
    publishPrHead(head);
    const tip = git(bare, 'rev-parse', 'main');
    const pending = await d.findUnpublishedGitlinks(head, tip);
    if (!pending.ok) throw new Error(`pin check failed: ${pending.error}`);
    expect(pending.unpublished).toEqual([{ path: 'libs/sub', sha: s2 }]);

    // The gate refuses before building or testing anything.
    const pr = {
      ref: { number: PR_NUMBER }, head_ref: STANDING_PR_BRANCH, base_ref: 'main', head_sha: head,
      review_decision: 'approved', checks_state: 'success',
    } as unknown as Pr;
    const input = { pr, policy: 'auto' as const, promotedSha: head, authorRevoked: false };
    expect(await stepStandingPrMerge(input, d)).toMatchObject({ action: 'refused', reason: 'unpublished-gitlinks' });
    expect(store.raw()[STANDING_PR_MERGE_TESTS_META_KEY]).toBeUndefined();

    // The submodule PR merges into the submodule's main repository: the gate opens.
    git(workSub, 'push', '-q', 'origin', 'HEAD:main');
    expect(await d.findUnpublishedGitlinks(head, tip)).toEqual({ ok: true, unpublished: [] });
    expect(await stepStandingPrMerge(input, d)).toMatchObject({ action: 'testing', reason: 'never-tested' });
  });
});
