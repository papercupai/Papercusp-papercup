/**
 * git-sync-eligibility — the seed/run eligibility verdict + the jittered
 * per-key cron + the P-005 provisional seed-active constants
 * (git-sync-any-hive-2026-06-12 P-001 / seed-side P-008).
 *
 * The reason vocabulary here is PINNED — git-sync-action.test.ts asserts the
 * same strings through the runtime gate, and the seed sites report them in
 * tool results. The disk checks ride the injected `pathExists` seam for the
 * matrix cases, plus one real-tmpdir case proving the default seam.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterAll } from 'vitest';
import type { ProjectEntry } from '../../harness-registry';
import { computeNextFireAt } from '../routines/cron';
import {
  gitSyncEligibility,
  gitSyncCronForKey,
  GIT_SYNC_SEED_ACTIVE_CREATOR,
  GIT_SYNC_SEED_ACTIVE_JOINER,
} from './git-sync-eligibility';

const entry = (over: Partial<ProjectEntry> = {}): ProjectEntry => ({
  slug: 'member',
  path: '/repos/member',
  ...over,
});

/** Seam: every path exists (isolates the registry-snapshot checks). */
const allExist = { pathExists: () => true };

describe('gitSyncEligibility — the verdict matrix (P-001)', () => {
  it('registration-only checkouts are ineligible without filesystem access', () => {
    expect(gitSyncEligibility(entry({
      registrationOnly: { commitSha: 'a'.repeat(40) },
      hive_slug: 'home',
      self_repo: true,
    }), { pathExists: () => { throw new Error('passive entry must not touch disk'); } })).toEqual({
      eligible: false, reason: 'registration_only',
    });
  });

  it('a plain member checkout with a .git is eligible', () => {
    expect(gitSyncEligibility(entry(), allExist)).toEqual({ eligible: true });
  });

  it('an ephemeral/benchmark INSTANCE slug is ineligible: ephemeral_debris (INCIDENT 2026-06-18, highest precedence — pure, no IO)', () => {
    // The torn-down xbench/SWE-bench per-task instances whose active git-sync routines
    // saturated the :3070 event loop. Both naming forms + the bare prefixes.
    for (const slug of [
      'xbench-su-Bag54m-instance_navidrome__',   // clean `-instance_` form
      'xbqyn2hx7nbminstancenavidromenavidrokhx8', // smushed `instance<...>` form
      'xbench-su-CjnO8m',                          // bare xbench prefix (scout/base)
      'memcap-run-3',
      'pot-verify-DELETEME',
    ]) {
      expect(gitSyncEligibility(entry({ slug }), allExist)).toEqual({
        eligible: false,
        reason: 'ephemeral_debris',
      });
    }
  });

  it('real harnesses never match ephemeral_debris (regression guard)', () => {
    for (const slug of ['papercup', 'sb-devboard', 'sheets', 'restart', 'papercup-hive', 'grapes-research', 'hiveloop']) {
      expect(gitSyncEligibility(entry({ slug }), allExist)).toEqual({ eligible: true });
    }
  });

  it('a hive HOME (kind hive, non-repo state dir) is ineligible: hive_home', () => {
    expect(gitSyncEligibility(entry({ harness_kind: 'hive' }), allExist)).toEqual({
      eligible: false,
      reason: 'hive_home',
    });
  });

  it('a joiner-side remote-hive VIEW is ineligible: remote_hive_view (the flag wins over hive_home)', () => {
    expect(
      gitSyncEligibility(entry({ harness_kind: 'hive', remote_hive: true }), allExist),
    ).toEqual({ eligible: false, reason: 'remote_hive_view' });
  });

  it('a self_repo remote-hive entry (release-install canonical clone, EI-8793) IS eligible', () => {
    // bootstrap-papercusp-hive defaultSelfAdmitCanonical registers the seeded
    // clone as { harness_kind:'hive', remote_hive:true, self_repo:true } — its
    // path IS the real checkout, and it must be synced (joiner-side) or the
    // release install's self-improvement loop never commits.
    expect(
      gitSyncEligibility(
        entry({ harness_kind: 'hive', remote_hive: true, self_repo: true }),
        allExist,
      ),
    ).toEqual({ eligible: true });
  });

  it('a self_repo remote-hive entry still fails the DISK checks like any member (not_a_git_repo)', () => {
    // self_repo only lifts the flag-level view/home skips — a clone whose git
    // seed has not landed yet (deferred restore) is still not_a_git_repo until
    // the checkout materializes.
    expect(
      gitSyncEligibility(entry({ harness_kind: 'hive', remote_hive: true, self_repo: true }), {
        pathExists: (p) => p === '/repos/member', // dir exists, .git does not
      }),
    ).toEqual({ eligible: false, reason: 'not_a_git_repo' });
  });

  it('a non-local deployment is ineligible: non_local_deployment (seed-side P-008)', () => {
    expect(
      gitSyncEligibility(entry({ deployment: { target: 'latitude' } as never }), allExist),
    ).toEqual({ eligible: false, reason: 'non_local_deployment' });
  });

  it('an explicit local deployment stays eligible', () => {
    expect(
      gitSyncEligibility(entry({ deployment: { target: 'local' } as never }), allExist),
    ).toEqual({ eligible: true });
  });

  it('a missing/empty path is ineligible: no_path', () => {
    expect(gitSyncEligibility(entry({ path: '' }), allExist)).toEqual({
      eligible: false,
      reason: 'no_path',
    });
    expect(gitSyncEligibility({ slug: 'x' } as ProjectEntry, allExist)).toEqual({
      eligible: false,
      reason: 'no_path',
    });
  });

  it('a VANISHED checkout (path not on disk) is ineligible: no_path', () => {
    expect(gitSyncEligibility(entry(), { pathExists: () => false })).toEqual({
      eligible: false,
      reason: 'no_path',
    });
  });

  it('a checkout without a .git is ineligible: not_a_git_repo', () => {
    const verdict = gitSyncEligibility(entry({ path: '/repos/member' }), {
      pathExists: (p) => p === '/repos/member', // the dir exists, its .git does not
    });
    expect(verdict).toEqual({ eligible: false, reason: 'not_a_git_repo' });
  });

  it('the registry-snapshot reasons win BEFORE any disk check runs', () => {
    let touched = 0;
    const counting = { pathExists: () => (touched++, true) };
    gitSyncEligibility(entry({ harness_kind: 'hive' }), counting);
    gitSyncEligibility(entry({ remote_hive: true }), counting);
    gitSyncEligibility(entry({ deployment: { target: 'cloud' } as never }), counting);
    expect(touched).toBe(0);
  });

  describe('default seam (real fs)', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'git-sync-eligibility-'));
    afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

    it('accepts .git as a dir (clone) AND as a file (worktree/submodule); rejects neither/none', () => {
      const repo = join(tmpRoot, 'repo');
      mkdirSync(join(repo, '.git'), { recursive: true });
      const worktree = join(tmpRoot, 'worktree');
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n', 'utf8');
      const bare = join(tmpRoot, 'bare');
      mkdirSync(bare, { recursive: true });

      expect(gitSyncEligibility(entry({ path: repo }))).toEqual({ eligible: true });
      expect(gitSyncEligibility(entry({ path: worktree }))).toEqual({ eligible: true });
      expect(gitSyncEligibility(entry({ path: bare }))).toEqual({ eligible: false, reason: 'not_a_git_repo' });
      expect(gitSyncEligibility(entry({ path: join(tmpRoot, 'gone') }))).toEqual({ eligible: false, reason: 'no_path' });
    });
  });
});

describe('gitSyncCronForKey — deterministic jittered every-10-min cron', () => {
  it('is deterministic per key', () => {
    expect(gitSyncCronForKey('papercup')).toBe(gitSyncCronForKey('papercup'));
    expect(gitSyncCronForKey('shop')).toBe(gitSyncCronForKey('shop'));
  });

  it('emits a 6-field cron: 0 seconds + six offset minutes 10 apart, offset 0–9', () => {
    for (const key of ['papercup', 'shop', 'a', 'zzz-member-42', '']) {
      const cron = gitSyncCronForKey(key);
      const fields = cron.split(' ');
      expect(fields).toHaveLength(6);
      expect(fields[0]).toBe('0');
      expect(fields.slice(2)).toEqual(['*', '*', '*', '*']);
      const minutes = fields[1].split(',').map(Number);
      expect(minutes).toHaveLength(6);
      const offset = minutes[0];
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThanOrEqual(9);
      expect(minutes).toEqual([0, 10, 20, 30, 40, 50].map((m) => m + offset));
    }
  });

  it('SPREADS distinct keys across offsets (the D-004 same-tick jitter)', () => {
    const offsets = new Set(
      Array.from({ length: 40 }, (_, i) => `member-${i}`)
        .map((k) => Number(gitSyncCronForKey(k).split(' ')[1].split(',')[0])),
    );
    // 40 keys over 10 buckets: a degenerate hash would land 1 bucket; FNV-1a spreads.
    expect(offsets.size).toBeGreaterThanOrEqual(5);
  });

  it('parses with computeNextFireAt and fires every 10 minutes at the offset minute', () => {
    const cron = gitSyncCronForKey('papercup');
    const offset = Number(cron.split(' ')[1].split(',')[0]);
    const from = new Date('2026-06-12T10:00:00.000Z');
    const first = computeNextFireAt(cron, from);
    expect(first).not.toBeNull();
    expect(first!.getUTCMinutes() % 10).toBe(offset);
    expect(first!.getUTCSeconds()).toBe(0);
    const second = computeNextFireAt(cron, new Date(first!.getTime() + 1000));
    expect(second!.getTime() - first!.getTime()).toBe(10 * 60_000);
  });
});

describe('P-005 seed-active default (D-008: ratified all-active 2026-06-13)', () => {
  it('both creator-side and joiner-side seed ACTIVE', () => {
    expect(GIT_SYNC_SEED_ACTIVE_CREATOR).toBe(true);
    expect(GIT_SYNC_SEED_ACTIVE_JOINER).toBe(true);
  });
});
