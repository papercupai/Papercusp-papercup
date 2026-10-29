/**
 * release-cut-reclaim (EI-23968726111761920): the pure planner's protection matrix, the
 * lease/status parsers, and the executor against a REAL temporary git repo — including an
 * offloaded (moved + symlinked) worktree. No test touches a real release tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AUTHORED_UNCHECKED,
  archiveTreeDiffs,
  contiguousChunks,
  executeCutReclaim,
  helperResult,
  nextForkSlot,
  parseHelperFrames,
  gatherCutReclaimPlan,
  inspectAuthoredWork,
  isLeaseLive,
  lastReflogEntryMs,
  machineWrittenRule,
  neverExpiringLeaseHonored,
  parsePorcelainV2,
  parseRetentionLease,
  parseWorktreePorcelain,
  planCutReclaim,
  probeTree,
  reclaimPathRefusal,
  reclaimCutWorktrees,
  renderReclaimPlan,
  resolveReclaimTargets,
  scanProcHolders,
  type HolderScan,
  type ReclaimPhaseTiming,
  type ReclaimPlanInput,
  type ReclaimWorktree,
  type RetentionLease,
  type TreeProbe,
} from './release-cut-reclaim';
import { createRetentionPin } from './storage/retention-pins';
import { withFsMutex } from '../../../scripts/lib/fs-mutex.mjs';
import { readWalkState, walkAttemptFiles, walkProcessAlive, type WalkLauncher } from './storage/disk-census-detached-walk';

// Both Vitest imports and portable .mjs owners must use the same real mutex.
// A name mock only intercepts one import path and breaks the pin-writer race.
// Isolate the maintained lock-root seam instead of touching a live operator's lock.
let fixtureLockRoot: string;
let savedLockRoot: string | undefined;
let savedDisableMutex: string | undefined;
beforeEach(() => {
  savedLockRoot = process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  savedDisableMutex = process.env.PAPERCUSP_DISABLE_FS_MUTEX;
  fixtureLockRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'release-cut-mutex-'));
  process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = fixtureLockRoot;
  delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
});
afterEach(() => {
  if (savedLockRoot === undefined) delete process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR;
  else process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = savedLockRoot;
  if (savedDisableMutex === undefined) delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
  else process.env.PAPERCUSP_DISABLE_FS_MUTEX = savedDisableMutex;
  fs.rmSync(fixtureLockRoot, { recursive: true, force: true });
});

const NOW = Date.parse('2026-09-30T04:00:00Z');
const DAY = 86_400_000;
const VERSION_PATHS = ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/tauri.conf.json'] as const;

const wt = (p: string, extra: Partial<ReclaimWorktree> = {}): ReclaimWorktree => ({
  path: p,
  head: 'a'.repeat(40),
  detached: true,
  prunable: false,
  locked: false,
  ...extra,
});
const probe = (extra: Partial<TreeProbe> = {}): TreeProbe => ({
  realPath: null,
  offloaded: false,
  onRootFs: true,
  adminDir: '/repo/.git/worktrees/x',
  createdAtMs: NOW - 10 * DAY,
  lastHeadMoveMs: NOW - 10 * DAY,
  desktopVersion: '0.0.22',
  ...extra,
});
const lease = (tag: string, paths: string[], expiresNs: bigint): RetentionLease => ({
  file: `/ret/lease-${tag}.tsv`,
  tag,
  version: /v(\d+\.\d+\.\d+)/.exec(tag)?.[1] ?? null,
  expiresNs,
  paths,
});
const expired = BigInt(NOW - DAY) * 1_000_000n;
const liveFinite = BigInt(NOW + DAY) * 1_000_000n;
const verified: HolderScan = { verified: true, holders: new Map() };

function input(over: Partial<ReclaimPlanInput> & { trees: Array<[ReclaimWorktree, TreeProbe]> }): ReclaimPlanInput {
  const probes = new Map(over.trees.map(([w, p]) => [w.path, { ...p, realPath: p.realPath ?? w.path }]));
  const clean = new Map(over.trees.map(([w]) => [w.path, { ok: true as const, authored: [], machineWritten: 3 }]));
  return {
    nowMs: NOW,
    minIdleHours: 24,
    worktrees: [wt('/w/papercusp', { detached: false }), ...over.trees.map(([w]) => w)],
    isAutoManaged: (p) => ['papercusp', 'papercup-release', 'papercusp-staging'].includes(path.basename(p)),
    leases: [],
    leaseErrors: [],
    releases: [
      { version: '0.0.25', gitSha: 'f'.repeat(40), cutAtMs: NOW - 2 * DAY, publishedAtMs: NOW - DAY },
      { version: '0.0.24', gitSha: 'e'.repeat(40), cutAtMs: NOW - 3 * DAY, publishedAtMs: NOW - 3 * DAY },
    ],
    probes,
    holders: verified,
    authored: clean,
    ...over,
  };
}
const verdict = (plan: ReturnType<typeof planCutReclaim>, p: string) => plan.verdicts.find((v) => v.path === p)!;

describe('lastReflogEntryMs', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflog-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the newest entry, ignoring trailing blank lines', () => {
    const p = path.join(dir, 'HEAD');
    fs.writeFileSync(
      p,
      [
        `${'a'.repeat(40)} ${'b'.repeat(40)} A <a@x> 1790000000 -0400\tcommit: first`,
        `${'b'.repeat(40)} ${'c'.repeat(40)} B <b@x> 1790051708 +0000\tcheckout: moving from x to y 1799999999 -0400`,
        '',
        '',
      ].join('\n'),
    );
    expect(lastReflogEntryMs(p)).toBe(1790051708_000);
    // git omits the tab when the entry's message is empty
    fs.appendFileSync(p, `${'c'.repeat(40)} ${'d'.repeat(40)} C <c@x> 1790060000 -0400\n`);
    expect(lastReflogEntryMs(p)).toBe(1790060000_000);
  });

  it('is null for a missing, empty, or non-reflog file', () => {
    expect(lastReflogEntryMs(path.join(dir, 'absent'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'empty'), '');
    expect(lastReflogEntryMs(path.join(dir, 'empty'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'junk'), 'not a reflog line\n');
    expect(lastReflogEntryMs(path.join(dir, 'junk'))).toBeNull();
  });
});

describe('reclaimPathRefusal — the executor rail independent of the plan (WI-10006139)', () => {
  const canonical = '/w/papercusp';
  const home = '/home/u';
  it('refuses the canonical tree, any ancestor of it, home, any ancestor of home, and /', () => {
    for (const p of [canonical, '/w', '/', home, '/home']) expect(reclaimPathRefusal(p, canonical, home)).not.toBeNull();
  });
  it('allows a sibling tree and a linked worktree NESTED inside the canonical tree', () => {
    expect(reclaimPathRefusal('/w/papercusp-relcut-0023-win', canonical, home)).toBeNull();
    expect(reclaimPathRefusal('/w/papercusp/.papercusp/worktrees/desktop-release-0.0.19', canonical, home)).toBeNull();
    // a shared name prefix is not containment
    expect(reclaimPathRefusal('/w/papercusp2', canonical, home)).toBeNull();
    expect(reclaimPathRefusal('/home/u/.papercusp/relcut', canonical, home)).toBeNull();
  });
});

describe('parsers', () => {
  it('reads worktree porcelain with head/detached/locked/prunable', () => {
    const list = parseWorktreePorcelain(
      `worktree /w/papercusp\nHEAD ${'1'.repeat(40)}\nbranch refs/heads/staging\n\nworktree /w/relcut-0022\nHEAD ${'2'.repeat(40)}\ndetached\nlocked reason\n\nworktree /tmp/gone\nHEAD ${'3'.repeat(40)}\ndetached\nprunable gitdir file points to non-existent location\n`,
    );
    expect(list.map((w) => [w.path, w.detached, w.locked, w.prunable])).toEqual([
      ['/w/papercusp', false, false, false],
      ['/w/relcut-0022', true, true, false],
      ['/tmp/gone', true, false, true],
    ]);
  });

  it('parses a lease and fails CLOSED on malformed ones, like the bash guard', () => {
    const good = parseRetentionLease('f', 'schema=papercusp-release-retention/v1\ntag=desktop-v0.0.25-alpha\ncreated_ns=1\nexpires_ns=0\npath=/w/relcut-0025/x\n');
    expect(good.ok && good.lease.version).toBe('0.0.25');
    expect(parseRetentionLease('f', 'schema=papercusp-release-retention/v1\ntag=t\nexpires_ns=soon\n').ok).toBe(false);
    expect(parseRetentionLease('f', 'schema=papercusp-release-retention/v1\ntag=t\nexpires_ns=0\nbogus\n').ok).toBe(false);
    expect(parseRetentionLease('f', 'schema=v0\ntag=t\nexpires_ns=0\n').ok).toBe(false);
  });

  it('treats expires_ns=0 as never-expiring', () => {
    expect(isLeaseLive(lease('t', [], 0n), NOW)).toBe(true);
    expect(isLeaseLive(lease('t', [], expired), NOW)).toBe(false);
    expect(isLeaseLive(lease('t', [], BigInt(NOW + DAY) * 1_000_000n), NOW)).toBe(true);
  });

  it('parses porcelain v2 -z: prefixes submodule paths, flags gitlinks, consumes rename origins', () => {
    const z = [
      `1 .M S.M. 160000 160000 160000 ${'a'.repeat(40)} ${'a'.repeat(40)} papercusp-desktop`,
      `1 .M N... 100644 100644 100644 ${'b'.repeat(40)} ${'b'.repeat(40)} src/has space.ts`,
      `2 R. N... 100644 100644 100644 ${'c'.repeat(40)} ${'c'.repeat(40)} R100 new.ts`,
      'old.ts',
      '? notes.txt',
      '',
    ].join('\0');
    expect(parsePorcelainV2(z, 'libs/x')).toEqual([
      { path: 'libs/x/papercusp-desktop', submodule: true },
      { path: 'libs/x/src/has space.ts', submodule: false },
      { path: 'libs/x/new.ts', submodule: false },
      { path: 'libs/x/notes.txt', submodule: false },
    ]);
  });

  it('allows only the measured machine-written residue of a finished cut', () => {
    expect(machineWrittenRule('papercusp-desktop/src-tauri/env-sidecars/staging/db-sql/1.sql', VERSION_PATHS)).toBe('sidecar-build-output');
    expect(machineWrittenRule('papercusp-desktop/src-tauri/Cargo.toml', VERSION_PATHS)).toBe('release-version-bump');
    expect(machineWrittenRule('package-lock.json', VERSION_PATHS)).toBe('lockfile');
    expect(machineWrittenRule('papercusp-desktop/src-tauri/Cargo.lock', VERSION_PATHS)).toBe('lockfile');
    expect(machineWrittenRule('packages/operator-core/lib/x.ts', VERSION_PATHS)).toBeNull();
    expect(machineWrittenRule('src-tauri/Cargo.toml', VERSION_PATHS)).toBeNull(); // not under papercusp-desktop
  });
});

describe('planCutReclaim — the protected set', () => {
  it('reclaims a lease-identified cut whose lease lapsed, keeps live leases, skips managed + prunable', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/relcut-0022'), probe()],
          [wt('/w/relcut-0024'), probe({ desktopVersion: '0.0.24' })],
          [wt('/w/papercup-release'), probe()],
          [wt('/tmp/gone', { prunable: true }), probe()],
        ],
        leases: [
          lease('desktop-v0.0.22-alpha', ['/w/relcut-0022/papercusp-desktop/src-tauri/target/release'], expired),
          lease('desktop-v0.0.24-alpha', ['/w/relcut-0024/papercusp-desktop/src-tauri/target/release'], liveFinite),
        ],
      }),
    );
    expect(verdict(plan, '/w/relcut-0022').disposition).toBe('reclaimable');
    expect(verdict(plan, '/w/relcut-0024').reasons).toContain('lease:desktop-v0.0.24-alpha');
    expect(plan.skipped).toEqual({ autoManaged: ['/w/papercup-release'], prunable: 1 });
    expect(plan.latestPublished).toBe('0.0.25');
  });

  it('keeps the latest PUBLISHED release tree by HEAD sha or by its lease tag, even after the lease lapses', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/by-head', { head: 'f'.repeat(40) }), probe({ desktopVersion: '0.0.25' })],
          [wt('/w/by-lease'), probe({ desktopVersion: '0.0.25' })],
        ],
        leases: [lease('desktop-v0.0.25-alpha', ['/w/by-lease/papercusp-desktop/target'], expired)],
      }),
    );
    expect(verdict(plan, '/w/by-head').reasons).toContain('latest-published:0.0.25');
    expect(verdict(plan, '/w/by-lease').reasons).toContain('latest-published:0.0.25');
  });

  it('keeps the NEXT cut (0.0.26) before it has any lease: created after the latest cut, or a newer version', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/relcut-0026'), probe({ createdAtMs: NOW - 3_600_000, desktopVersion: '0.0.25' })],
          [wt('/w/bumped'), probe({ desktopVersion: '0.0.26' })],
          [wt('/w/ageless'), probe({ createdAtMs: null })],
        ],
      }),
    );
    expect(verdict(plan, '/w/relcut-0026').reasons).toContain('newer-than-latest-release');
    expect(verdict(plan, '/w/bumped').reasons).toContain('unreleased-version:0.0.26');
    expect(verdict(plan, '/w/ageless').reasons).toContain('unknown-age');
  });

  it('keeps trees held by a process, recently checked out, locked, or containing another worktree', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/held'), probe()],
          [wt('/w/fresh'), probe({ lastHeadMoveMs: NOW - 2 * 3_600_000 })],
          [wt('/w/locked', { locked: true }), probe()],
          [wt('/w/outer'), probe()],
          [wt('/w/outer/inner'), probe()],
        ],
        holders: { verified: true, holders: new Map([['/w/held', ['pid 42 cwd']]]) },
      }),
    );
    expect(verdict(plan, '/w/held').reasons).toEqual(['in-use:pid 42 cwd']);
    expect(verdict(plan, '/w/fresh').reasons).toEqual(['recent-checkout:2h']);
    expect(verdict(plan, '/w/locked').reasons).toEqual(['locked']);
    expect(verdict(plan, '/w/outer').reasons).toEqual(['contains-worktree:/w/outer/inner']);
    expect(verdict(plan, '/w/outer/inner').disposition).toBe('named-only');
  });

  it('keeps trees with AUTHORED work (incl. inside submodules), unverifiable work, or an unchecked read', () => {
    const base = input({ trees: [[wt('/w/a'), probe()], [wt('/w/b'), probe()], [wt('/w/c'), probe()]] });
    const plan = planCutReclaim({
      ...base,
      authored: new Map([
        ['/w/a', { ok: true, authored: ['libs/papercusp/src/fix.ts'], machineWritten: 0 }],
        ['/w/b', { ok: false, reason: 'git status timed out' }],
      ]),
    });
    expect(verdict(plan, '/w/a').reasons).toEqual(['authored:libs/papercusp/src/fix.ts']);
    expect(verdict(plan, '/w/b').reasons).toEqual(['authored-work-unverified:git status timed out']);
    expect(verdict(plan, '/w/c').reasons).toEqual([AUTHORED_UNCHECKED]);
  });

  it('covers an OFFLOADED tree through its realpath, and labels a lease-less tree named-only', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/relcut-0023-win'), probe({ realPath: '/mnt/off/w/relcut-0023-win', offloaded: true })],
          [wt('/w/desktop-release-0.0.19'), probe({ desktopVersion: '0.0.19' })],
        ],
        leases: [lease('desktop-v0.0.23-alpha', ['/mnt/off/w/relcut-0023-win/papercusp-desktop/target'], liveFinite)],
      }),
    );
    expect(verdict(plan, '/w/relcut-0023-win').reasons).toEqual(['lease:desktop-v0.0.23-alpha']);
    expect(verdict(plan, '/w/desktop-release-0.0.19').disposition).toBe('named-only');
  });

  // [peer:su-3ee17ad9 2026-09-30T04:04Z] expires_ns=0 is every lease's default while
  // PAPERCUSP_RELEASE_RETENTION_TTL_SEC is unset, so it must not pin every old cut forever.
  it('honours a never-expiring (expires_ns=0) lease only for the latest published and newer cuts', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/relcut-0021'), probe({ desktopVersion: '0.0.21' })],
          [wt('/w/relcut-0025', { head: 'f'.repeat(40) }), probe({ desktopVersion: '0.0.25' })],
          [wt('/w/relcut-0026'), probe({ desktopVersion: '0.0.26' })],
          [wt('/w/odd-tag'), probe()],
        ],
        leases: [
          lease('desktop-v0.0.21-alpha', ['/w/relcut-0021/papercusp-desktop/target'], 0n),
          lease('desktop-v0.0.25-alpha', ['/w/relcut-0025/papercusp-desktop/target'], 0n),
          lease('desktop-v0.0.26-alpha', ['/w/relcut-0026/papercusp-desktop/target'], 0n),
          lease('hotfix-build', ['/w/odd-tag/papercusp-desktop/target'], 0n),
        ],
      }),
    );
    const old = verdict(plan, '/w/relcut-0021');
    expect(old.reasons).toEqual([]);
    expect(old.disposition).toBe('reclaimable');
    expect(old.ignoredLeases).toEqual(['desktop-v0.0.21-alpha:never-expires,older-than-0.0.25']);
    expect(renderReclaimPlan(plan).reclaimable).toEqual([
      expect.objectContaining({ path: '/w/relcut-0021', leasesIgnored: old.ignoredLeases }),
    ]);
    expect(verdict(plan, '/w/relcut-0025').reasons).toEqual(
      expect.arrayContaining(['lease:desktop-v0.0.25-alpha', 'latest-published:0.0.25']),
    );
    expect(verdict(plan, '/w/relcut-0026').reasons).toContain('lease:desktop-v0.0.26-alpha');
    expect(verdict(plan, '/w/relcut-0026').ignoredLeases).toEqual([]);
    expect(verdict(plan, '/w/odd-tag').reasons).toEqual(['lease:hotfix-build']);
  });

  it('neverExpiringLeaseHonored: only expires_ns=0 on an older version is dropped; unknowns fail closed', () => {
    const pub = { version: '0.0.25', gitSha: null, cutAtMs: 0, publishedAtMs: 1 };
    expect(neverExpiringLeaseHonored(lease('desktop-v0.0.21-alpha', [], 0n), pub)).toBe(false);
    expect(neverExpiringLeaseHonored(lease('desktop-v0.0.21-alpha', [], liveFinite), pub)).toBe(true);
    expect(neverExpiringLeaseHonored(lease('desktop-v0.0.25-alpha', [], 0n), pub)).toBe(true);
    expect(neverExpiringLeaseHonored(lease('desktop-v0.0.26-alpha', [], 0n), pub)).toBe(true);
    expect(neverExpiringLeaseHonored(lease('no-version', [], 0n), pub)).toBe(true);
    expect(neverExpiringLeaseHonored(lease('desktop-v0.0.21-alpha', [], 0n), null)).toBe(true);
  });

  it.each([
    ['a malformed lease', { leaseErrors: ['lease-x.tsv:invalid expires_ns'] }, 'malformed-lease:lease-x.tsv:invalid expires_ns'],
    ['an unverified holder scan', { holders: { verified: false, reason: 'nested-pid-namespace(9/1)', holders: new Map() } }, 'holder-scan-unverified:nested-pid-namespace(9/1)'],
    ['unreadable release records', { releases: { error: 'db down' } }, 'release-records-unavailable:db down'],
    ['no published release', { releases: [{ version: '0.0.1', gitSha: null, cutAtMs: 0, publishedAtMs: null }] }, 'no-published-release'],
  ])('fails CLOSED on %s — every tree protected', (_label, over, reason) => {
    const plan = planCutReclaim(input({ trees: [[wt('/w/relcut-0022'), probe()]], ...(over as Partial<ReclaimPlanInput>) }));
    expect(plan.failClosed).toContain(reason);
    expect(verdict(plan, '/w/relcut-0022').disposition).toBe('protected');
  });

  it('accepts targets by registered or real path, all-or-nothing', () => {
    const plan = planCutReclaim(
      input({
        trees: [
          [wt('/w/ok'), probe({ realPath: '/mnt/off/w/ok', offloaded: true })],
          [wt('/w/held'), probe()],
        ],
        holders: { verified: true, holders: new Map([['/w/held', ['pid 7 fd']]]) },
      }),
    );
    expect(resolveReclaimTargets(plan, ['/mnt/off/w/ok'])).toMatchObject({ ok: true });
    const refused = resolveReclaimTargets(plan, ['/w/ok', '/w/held', '/w/nope']);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.problems).toHaveLength(2);
    expect(resolveReclaimTargets(plan, []).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- real git

const g = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

describe('gather + execute against a real temporary repo', () => {
  let tmp: string;
  let repo: string;
  let ret: string;
  let previousRetentionRoot: string | undefined;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-')));
    repo = path.join(tmp, 'papercusp');
    ret = path.join(tmp, 'retention');
    fs.mkdirSync(repo);
    fs.mkdirSync(ret);
    previousRetentionRoot = process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
    process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = ret;
    g(repo, 'init', '-q', '-b', 'staging');
    g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'root');
  });
  afterEach(() => {
    if (previousRetentionRoot === undefined) delete process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
    else process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = previousRetentionRoot;
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  const pin = (target: string) => createRetentionPin({ path: target, owner: 'test-owner',
    reason: 'release-cut allocation fixture', expiresAt: new Date(Date.now() + DAY).toISOString() }, { dir: ret });

  const gather = (extra: Partial<Parameters<typeof gatherCutReclaimPlan>[0]> = {}) =>
    gatherCutReclaimPlan({
      repoPath: repo,
      retentionDir: ret,
      isAutoManaged: (p) => path.basename(p) === 'papercusp',
      releaseVersionPaths: VERSION_PATHS,
      minIdleHours: 0,
      // the tmp worktrees are brand new; place the latest cut after them
      loadReleases: async () => [{ version: '0.0.25', gitSha: null, cutAtMs: Date.now() + DAY, publishedAtMs: Date.now() }],
      scanHolders: () => ({ verified: true, holders: new Map() }),
      ...extra,
    });

  it('emits phase timings for a read-only plan when diagnostics are requested', async () => {
    const phases: ReclaimPhaseTiming[] = [];
    await gather({
      listWorktrees: () => [wt(repo, { detached: false })],
      onPhase: (event) => phases.push(event),
    });

    const expected = [
      'worktree-enumeration',
      'tree-probes',
      'retention-leases',
      'release-records',
      'holder-scan',
      'cheap-plan',
      'authored-work',
      'final-plan',
      'interrupted-receipt-scan',
    ];
    expect(phases.filter((phase) => phase.stage === 'start').map((phase) => phase.phase)).toEqual(expected);
    const finished = phases.filter((phase) => phase.stage === 'finish');
    expect(finished.map((phase) => phase.phase)).toEqual(expected);
    expect(finished.every((phase) => Number.isFinite(phase.elapsedMs) && phase.outcome === 'fulfilled')).toBe(true);
  });

  it('only runs the git-heavy authored read for trees that survive the cheap checks', async () => {
    g(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'relcut-a'));
    g(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'relcut-held'));
    const authoredWork = vi.fn(() => ({ ok: true as const, authored: [], machineWritten: 0 }));
    const plan = await gather({
      authoredWork,
      scanHolders: () => ({ verified: true, holders: new Map([[path.join(tmp, 'relcut-held'), ['pid 1 cwd']]]) }),
    });
    expect(authoredWork).toHaveBeenCalledTimes(1);
    expect(authoredWork).toHaveBeenCalledWith(path.join(tmp, 'relcut-a'), repo);
    expect(plan.verdicts.find((v) => v.path.endsWith('relcut-a'))?.disposition).toBe('named-only');
  });

  it('inspects a named target without probing unrelated trees', async () => {
    const selected = path.join(tmp, 'selected');
    const other = path.join(tmp, 'unrelated');
    g(repo, 'worktree', 'add', '-q', '--detach', selected);
    g(repo, 'worktree', 'add', '-q', '--detach', other);
    const inspect = vi.fn(() => ({ ok: true as const, authored: [], machineWritten: 0 }));
    const probeTarget = vi.fn((p: string) => {
      if (p === other) throw new Error('unrelated tree must not be visited');
      return probeTree(p, null);
    });
    const plan = await gather({ targets: [selected], probe: probeTarget, authoredWork: inspect });
    expect(probeTarget).toHaveBeenCalledTimes(1);
    expect(inspect).toHaveBeenCalledExactlyOnceWith(selected, repo);
    expect(plan.verdicts.map((v) => v.path)).toEqual([selected]);
    expect(plan.failClosed).toEqual([]);
    const absent = await gather({ targets: [path.join(tmp, 'not-registered')] });
    expect(absent.verdicts).toEqual([]);
    expect(absent.failClosed).toEqual([`target-not-inspectable:${path.join(tmp, 'not-registered')}`]);
  });

  it('preserves containment protection when a nested worktree is outside the target selection', async () => {
    const parent = path.join(tmp, 'parent');
    const nested = path.join(parent, 'nested');
    g(repo, 'worktree', 'add', '-q', '--detach', parent);
    g(repo, 'worktree', 'add', '-q', '--detach', nested);
    const inspect = vi.fn(() => ({ ok: true as const, authored: [], machineWritten: 0 }));
    const plan = await gather({ targets: [parent], authoredWork: inspect });
    expect(plan.verdicts).toHaveLength(1);
    expect(plan.verdicts[0]?.reasons).toContain(`contains-worktree:${nested}`);
    expect(plan.verdicts[0]?.disposition).toBe('protected');
    expect(inspect).not.toHaveBeenCalled();
  });

  it('runs the authored-work reads width-bounded and keeps each result with its own tree', async () => {
    const trees = [1, 2, 3, 4, 5].map((i) => path.join(tmp, `relcut-${i}`));
    for (const t of trees) g(repo, 'worktree', 'add', '-q', '--detach', t);
    let inFlight = 0;
    let peak = 0;
    const authoredWork = vi.fn(async (tree: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 30));
      inFlight--;
      return { ok: true as const, authored: tree.endsWith('relcut-3') ? ['x.ts'] : [], machineWritten: 0 };
    });
    // calibration: width 1 is the old serial loop, and the instrument must read exactly 1
    await gather({ authoredWork, authoredConcurrency: 1 });
    expect(peak).toBe(1);
    authoredWork.mockClear();
    const plan = await gather({ authoredWork, authoredConcurrency: 2 });
    expect(authoredWork).toHaveBeenCalledTimes(5);
    // serial (the 54s dry-run, EI-24849983022443070) would peak at 1; unbounded at 5
    expect(peak).toBe(2);
    const byTree = new Map(plan.verdicts.map((v) => [path.basename(v.path), v]));
    expect(byTree.get('relcut-3')?.reasons).toEqual(['authored:x.ts']);
    for (const n of [1, 2, 4, 5]) expect(byTree.get(`relcut-${n}`)?.disposition).toBe('named-only');
  });

  it('dates a checkout by the newest reflog ENTRY, not the reflog file mtime a gc rewrites', () => {
    const tree = path.join(tmp, 'relcut-gc');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const probe0 = probeTree(tree, null);
    const admin = probe0.adminDir as string;
    const oldSec = Math.floor((Date.now() - 10 * DAY) / 1000);
    const logPath = path.join(admin, 'logs', 'HEAD');
    // age every entry, then leave the FILE freshly written (what `git gc` / `reflog expire` does)
    const aged = fs
      .readFileSync(logPath, 'utf8')
      // an entry with an empty message has NO tab (git omits it) — `worktree add` writes one
      .replace(/ (\d{9,}) ([+-]\d{4})(?=\t|$)/gm, ` ${oldSec} $2`);
    fs.writeFileSync(logPath, aged);
    const oldDate = new Date(oldSec * 1000);
    fs.utimesSync(path.join(admin, 'HEAD'), oldDate, oldDate);
    expect(fs.statSync(logPath).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
    expect(probeTree(tree, null).lastHeadMoveMs).toBe(oldSec * 1000);
  });

  it('detects an authored file with the real git read and protects the tree', async () => {
    const tree = path.join(tmp, 'relcut-dirty');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.writeFileSync(path.join(tree, 'handwritten.ts'), 'export {}\n');
    const plan = await gather();
    expect(plan.verdicts[0]?.reasons).toEqual(['authored:handwritten.ts']);
  });

  it('removes a named tree + its admin dir, archives first, audits, and leaves the canonical repo intact', async () => {
    const tree = path.join(tmp, 'relcut-0019');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    const audit: string[] = [];
    const res = await executeCutReclaim(plan, [tree], {
      scanHolders: () => ({ verified: true, holders: new Map() }),
      archiveDir: path.join(ret, 'archive'),
      appendAudit: (l) => audit.push(l),
    });
    expect(res).toMatchObject({ ok: true, results: [{ path: tree, removed: true }] });
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readdirSync(path.join(repo, '.git', 'worktrees'))).toEqual([]);
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain('relcut-0019');
    expect(fs.readdirSync(path.join(ret, 'archive'))).toHaveLength(1);
    expect(audit[0]).toContain('deleter=release:cut-reclaim');
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('staging');
    expect(fs.readdirSync(tmp).filter((n) => n.startsWith('.reclaim-trash-'))).toEqual([]);
  });

  it('reclaims expired cuts oldest first and reports allocated pinned overage', async () => {
    const newer = path.join(tmp, 'a-newer'), older = path.join(tmp, 'z-older'), pinned = path.join(tmp, 'pinned');
    for (const tree of [newer, older, pinned]) {
      g(repo, 'worktree', 'add', '-q', '--detach', tree);
      fs.writeFileSync(path.join(tree, 'package-lock.json'), Buffer.alloc(8192, 1));
    }
    pin(pinned);
    const plan = await gather();
    for (const v of plan.verdicts) {
      v.disposition = v.path === pinned ? 'protected' : 'reclaimable';
      if (v.path !== pinned) v.reasons = [];
      v.createdAt = v.lastHeadMoveAt = new Date(NOW - (v.path === older ? 10 : 5) * DAY).toISOString();
    }
    const deps = { scanHolders: () => verified, archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {} };
    const dry = await reclaimCutWorktrees(plan, { dryRun: true, maxBytes: 1 }, deps);
    expect(dry.ok).toBe(true);
    expect(dry.targets).toEqual([older, newer]);
    expect(dry.cap.beforeBytes).toBeGreaterThan(8192 * 3);
    expect(fs.existsSync(older)).toBe(true);
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 }, deps);
    expect(result.ok).toBe(true);
    expect(result.targets).toEqual(dry.targets);
    expect(result.execution?.ok && result.execution.results.map((r) => r.path)).toEqual([older, newer]);
    expect(result.cap.pinnedPaths).toEqual([pinned]);
    expect(result.cap.afterBytes).toBe(result.cap.pinnedBytes);
    expect(result.cap.overByBytes).toBe(result.cap.afterBytes! - 1);
    expect(result.cap.retainedPaths).toEqual([pinned]);
    expect(fs.existsSync(pinned)).toBe(true);
  });

  it('retains every cut when its execution deadline has already expired', async () => {
    const tree = path.join(tmp, 'deadline-before-admission');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    const scanHolders = vi.fn(() => verified);
    const archive = vi.fn(archiveTreeDiffs);
    const result = await executeCutReclaim(plan, [tree], {
      notAfterMs: Date.now() - 1, scanHolders, archive,
      archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {},
    });
    expect(result).toMatchObject({ ok: true, results: [{ path: tree, removed: false,
      reason: 'release-cut execution run deadline exhausted; resume with a fresh plan' }] });
    expect(scanHolders).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(fs.existsSync(tree)).toBe(true);
    expect(g(repo, 'worktree', 'list', '--porcelain')).toContain(tree);
  });

  function usageSlot(seconds = 0) {
    const launches: number[] = [];
    const dir = path.join(tmp, 'usage-slot');
    const launch: WalkLauncher = async (cmd, args, meta) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
      if (!child.pid) throw new Error('fixture worker did not launch');
      launches.push(child.pid);
      return { pid: child.pid, taskId: null, confined: true };
    };
    const usageWalk = { dir, launch, pollMs: 10,
      command: (args: string[]): [string, string[]] => ['/bin/sh', ['-c', `sleep ${seconds}; exec du "$@"`, 'usage-fixture', ...args]] };
    const finished = async () => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const state = await readWalkState(dir);
        if (state && !walkProcessAlive(state) && fs.existsSync(walkAttemptFiles(dir, state.attempt).exit)) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('fixture worker did not finish');
    };
    return { dir, launches, usageWalk, finished };
  }

  it('reuses retention admission instead of reacquiring a usage slot mutex', async () => {
    const tree = path.join(tmp, 'contended-usage');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    const slot = usageSlot();
    // A leftover holder of the old, redundant slot mutex must not impose a
    // second one-second admission deadline after retention admission succeeded.
    // Use the ordinary slot: private runtime temp prefixes can already be long.
    let release!: () => void;
    let acquired!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const holder = withFsMutex(`release-cut-usage:${path.resolve(slot.usageWalk.dir)}`, async () => {
      acquired();
      await held;
    });
    // Surface acquisition errors instead of leaving ready pending until the
    // test deadline (for example ENAMETOOLONG in a deeper private temp root).
    await Promise.race([ready, holder]);
    try {
      const result = await reclaimCutWorktrees(plan, { dryRun: true, notAfterMs: Date.now() + 10_000 }, { usageWalk: slot.usageWalk });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.cap.beforeBytes).toBeGreaterThan(0);
      expect(slot.launches).toHaveLength(1);
      expect(fs.existsSync(tree)).toBe(true);
    } finally {
      release();
      await holder;
    }
  });

  it('keeps usage launch behind the shared retention admission', async () => {
    const tree = path.join(tmp, 'retention-admission-usage');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather(), slot = usageSlot();
    let release!: () => void;
    let acquired!: (hasWaiters: () => Promise<boolean>) => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<() => Promise<boolean>>(resolve => { acquired = resolve; });
    const holder = withFsMutex('papercusp-disk-retention', async context => {
      if (!context) throw new Error('fixture retention mutex is disabled');
      acquired(context.hasWaiters);
      await held;
    });
    const hasWaiters = await Promise.race([ready, holder]);
    if (!hasWaiters) throw new Error('fixture retention mutex ended before admission');
    const pending = reclaimCutWorktrees(plan, { dryRun: true }, { usageWalk: slot.usageWalk });
    try {
      await vi.waitFor(async () => expect(await hasWaiters()).toBe(true));
      expect(slot.launches).toHaveLength(0);
    } finally {
      release();
      await holder;
    }
    const result = await pending;
    expect(result.errors).toEqual([]);
    expect(result.cap.beforeBytes).toBeGreaterThan(0);
    expect(slot.launches).toHaveLength(1);
    expect(fs.existsSync(tree)).toBe(true);
  });

  it('adopts the same scheduled usage worker after a bounded wait and refuses a live changed population', async () => {
    const tree = path.join(tmp, 'adopt-first');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    const slot = usageSlot(1);
    const first = await reclaimCutWorktrees(plan, { notAfterMs: Date.now() + 200 }, { usageWalk: slot.usageWalk });
    expect(first.ok).toBe(false);
    expect(first.errors[0]).toContain('pending');
    expect(first.cap.beforeBytes).toBeNull();
    expect(first.cap.afterBytes).toBeNull();
    expect(slot.launches).toHaveLength(1);
    const original = (await readWalkState(slot.dir))!;
    const pendingWalk = { root: original.root, dir: slot.dir, attempt: original.attempt,
      requestKey: original.requestKey, launchedAt: original.launchedAt };
    // The ordinary delegate detail must keep its own lineage after the slot is
    // consumed and replaced, including through the receipt's JSON round trip.
    const receipt = JSON.parse(JSON.stringify({ delegates: [{ classId: 'release-cut-worktrees', ok: first.ok, detail: first }] }));
    expect(receipt.delegates[0].detail.pendingWalk).toEqual(pendingWalk);
    expect(walkProcessAlive(original)).toBe(true);
    const other = path.join(tmp, 'adopt-new-root');
    g(repo, 'worktree', 'add', '-q', '--detach', other);
    const changed = await gather();
    const refused = await reclaimCutWorktrees(changed, {}, { usageWalk: slot.usageWalk });
    expect(refused.ok).toBe(false);
    expect(refused.cap.beforeBytes).toBeNull();
    expect(refused.errors[0]).toContain('request changed');
    expect(refused.pendingWalk).toBeUndefined();
    expect(slot.launches).toHaveLength(1);
    await slot.finished();
    const adopted = await reclaimCutWorktrees(plan, {}, { usageWalk: slot.usageWalk });
    expect(adopted.ok).toBe(true);
    expect(adopted.cap.beforeBytes).toBeGreaterThan(0);
    expect(adopted.cap.afterBytes).toBe(adopted.cap.beforeBytes);
    expect(slot.launches).toHaveLength(1);
    // Consumed terminal evidence cannot be reused, even if the path set matches.
    const next = await reclaimCutWorktrees(changed, {}, { usageWalk: slot.usageWalk });
    expect(next.ok).toBe(true);
    expect(next.cap.retainedPaths).toEqual([tree, other]);
    expect(slot.launches).toHaveLength(2);
    expect((await readWalkState(slot.dir))?.requestKey).not.toBe(original.requestKey);
    expect(receipt.delegates[0].detail.pendingWalk).toEqual(pendingWalk);
    await slot.finished();
  });

  it.each(['authored', 'published', 'lease', 'holder'])('rechecks %s protection after scheduled measurement before any removal', async kind => {
    const tree = path.join(tmp, 'guard-after-adoption');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const fresh = structuredClone(plan);
    fresh.verdicts[0]!.disposition = 'protected';
    fresh.verdicts[0]!.reasons = [`${kind}:arrived-during-measurement`];
    const scanHolders = vi.fn(() => verified), archive = vi.fn(archiveTreeDiffs);
    const slot = usageSlot();
    const result = await reclaimCutWorktrees(plan, {}, {
      usageWalk: slot.usageWalk, refreshPlan: async () => fresh, scanHolders, archive,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('protection or population changed');
    expect(result.cap.beforeBytes).toBeNull();
    expect(scanHolders).not.toHaveBeenCalled();
    expect(archive).not.toHaveBeenCalled();
    expect(fs.existsSync(tree)).toBe(true);
    await slot.finished();
  });

  it.each([true, false])('retires a dead obsolete population before launching its replacement (exit marker: %s)', async exitMarker => {
    const first = path.join(tmp, 'terminal-first');
    g(repo, 'worktree', 'add', '-q', '--detach', first);
    const plan = await gather(), slot = usageSlot(1);
    const pending = await reclaimCutWorktrees(plan, { notAfterMs: Date.now() + 200 }, { usageWalk: slot.usageWalk });
    expect(pending.cap.beforeBytes).toBeNull();
    await slot.finished();
    if (!exitMarker) fs.rmSync(walkAttemptFiles(slot.dir, (await readWalkState(slot.dir))!.attempt).exit);
    const second = path.join(tmp, 'terminal-second');
    g(repo, 'worktree', 'add', '-q', '--detach', second);
    const result = await reclaimCutWorktrees(await gather(), {}, { usageWalk: slot.usageWalk });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.cap.retainedPaths).toEqual([first, second]);
    expect(slot.launches).toHaveLength(2);
    await slot.finished();
  });

  it.each([true, false])('keeps a failed dead measurement unknown and permits a fresh worker (exit marker: %s)', async exitMarker => {
    const tree = path.join(tmp, 'failed-then-fresh');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather(), slot = usageSlot();
    const failed = await reclaimCutWorktrees(plan, {}, { usageWalk: {
      ...slot.usageWalk, command: () => ['/bin/sh', ['-c', 'exit 1']],
    } });
    expect(failed.ok).toBe(false);
    expect(failed.cap.beforeBytes).toBeNull();
    expect(failed.cap.afterBytes).toBeNull();
    await slot.finished();
    if (!exitMarker) fs.rmSync(walkAttemptFiles(slot.dir, (await readWalkState(slot.dir))!.attempt).exit);
    const result = await reclaimCutWorktrees(plan, {}, { usageWalk: slot.usageWalk });
    expect(result.ok).toBe(true);
    expect(result.cap.beforeBytes).toBeGreaterThan(0);
    expect(slot.launches).toHaveLength(2);
    expect(fs.existsSync(tree)).toBe(true);
    await slot.finished();
  });

  it('consumes an exhausted dead worker without an exit marker before admitting a fresh measurement', async () => {
    const tree = path.join(tmp, 'missing-exit-exhausted');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather(), slot = usageSlot();
    await reclaimCutWorktrees(plan, {}, { usageWalk: slot.usageWalk });
    await slot.finished();
    fs.rmSync(path.join(slot.dir, 'consumed'));
    fs.rmSync(walkAttemptFiles(slot.dir, (await readWalkState(slot.dir))!.attempt).exit);
    const failed = await reclaimCutWorktrees(plan, {}, { usageWalk: { ...slot.usageWalk, maxAttempts: 1 } });
    expect(failed.ok).toBe(false);
    expect(failed.errors[0]).toContain('walk ended without an exit status');
    expect(failed.cap.beforeBytes).toBeNull();
    expect(failed.cap.afterBytes).toBeNull();
    expect(slot.launches).toHaveLength(1);
    expect(fs.existsSync(tree)).toBe(true);
    const recovered = await reclaimCutWorktrees(plan, {}, { usageWalk: { ...slot.usageWalk, maxAttempts: 1 } });
    expect(recovered.ok).toBe(true);
    expect(recovered.cap.beforeBytes).toBeGreaterThan(0);
    expect(slot.launches).toHaveLength(2);
    expect(fs.existsSync(tree)).toBe(true);
    await slot.finished();
  });

  it('invalidates adopted usage before effects and measures the remaining pinned hardlinks in a fresh worker', async () => {
    const tree = path.join(tmp, 'a-reclaim'), pinned = path.join(tmp, 'z-pin');
    for (const root of [tree, pinned]) g(repo, 'worktree', 'add', '-q', '--detach', root);
    const data = path.join(tree, 'package-lock.json');
    fs.writeFileSync(data, Buffer.alloc(32768, 1));
    fs.linkSync(data, path.join(pinned, 'package-lock.json'));
    pin(pinned);
    const plan = await gather();
    plan.verdicts.find(v => v.path === tree)!.disposition = 'reclaimable';
    const protectedTree = plan.verdicts.find(v => v.path === pinned)!;
    protectedTree.disposition = 'protected';
    const slot = usageSlot();
    const result = await reclaimCutWorktrees(plan, {}, {
      usageWalk: slot.usageWalk, refreshPlan: async () => plan,
      scanHolders: () => verified, archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.cap.beforeBytes).toBeGreaterThan(result.cap.afterBytes!);
    expect(result.cap.afterBytes).toBe(result.cap.pinnedBytes);
    expect(result.cap.retainedPaths).toEqual([pinned]);
    expect(slot.launches).toHaveLength(2);
    expect(fs.existsSync(tree)).toBe(false);
    await slot.finished();
  });

  it('refuses a stale scheduled terminal receipt instead of assigning cap totals', async () => {
    const tree = path.join(tmp, 'stale-measurement');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather(), slot = usageSlot(1);
    await reclaimCutWorktrees(plan, { notAfterMs: Date.now() + 200 }, { usageWalk: slot.usageWalk });
    await slot.finished();
    const progressPath = path.join(slot.dir, 'usage-progress.json');
    const statePath = path.join(slot.dir, 'state.json');
    const progress = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    progress.startedAt -= 2 * 60 * 60_000; progress.finishedAt -= 2 * 60 * 60_000;
    state.launchedAt -= 2 * 60 * 60_000;
    fs.writeFileSync(progressPath, JSON.stringify(progress)); fs.writeFileSync(statePath, JSON.stringify(state));
    const result = await reclaimCutWorktrees(plan, {}, { usageWalk: slot.usageWalk });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('stale or unsafe');
    expect(result.cap.beforeBytes).toBeNull();
    expect(result.cap.afterBytes).toBeNull();
    expect(slot.launches).toHaveLength(1);
    expect(fs.existsSync(tree)).toBe(true);
  });

  it.each(['holder', 'archive'])('rechecks its execution deadline after the %s phase before admitting a removal', async (phase) => {
    const tree = path.join(tmp, `deadline-during-${phase}`);
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    let clock = Date.now();
    const notAfterMs = clock + 10_000;
    const archive = vi.fn(async (root: string, file: string) => {
      await archiveTreeDiffs(root, file);
      if (phase === 'archive') clock = notAfterMs;
    });
    const result = await executeCutReclaim(plan, [tree], {
      notAfterMs, nowMs: () => clock,
      scanHolders: () => { if (phase === 'holder') clock = notAfterMs; return verified; },
      archive, archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {},
    });
    expect(result).toMatchObject({ ok: true, results: [{ path: tree, removed: false,
      reason: 'release-cut execution run deadline exhausted; resume with a fresh plan' }] });
    expect(archive).toHaveBeenCalledTimes(phase === 'holder' ? 0 : 1);
    expect(fs.existsSync(tree)).toBe(true);
    expect(g(repo, 'worktree', 'list', '--porcelain')).toContain(tree);
    expect(fs.readdirSync(tmp).filter((name) => name.startsWith('.reclaim-trash-'))).toEqual([]);
  });

  it('finishes an admitted cut removal but leaves the next cut for a fresh guarded plan after the shared deadline', async () => {
    const trees = ['a-deadline-first', 'b-deadline-second'].map((name) => path.join(tmp, name));
    for (const tree of trees) g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    for (const verdict of plan.verdicts) verdict.disposition = 'reclaimable';
    let clock = Date.now();
    const notAfterMs = clock + 10_000;
    const archive = vi.fn(archiveTreeDiffs);
    const rmrf = vi.fn(async (file: string) => {
      await fs.promises.rm(file, { recursive: true, force: true });
      clock = notAfterMs;
    });
    const result = await reclaimCutWorktrees(plan, { notAfterMs }, {
      nowMs: () => clock, scanHolders: () => verified, archive, rmrf,
      archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.execution).toMatchObject({ ok: true, results: [
      { path: trees[0], removed: true },
      { path: trees[1], removed: false,
        reason: 'release-cut execution run deadline exhausted; resume with a fresh plan' },
    ] });
    expect(archive).toHaveBeenCalledTimes(1);
    // Both the renamed tree and its admin directory finish once removal is admitted.
    expect(rmrf).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(trees[0]!)).toBe(false);
    expect(fs.existsSync(trees[1]!)).toBe(true);
    expect(g(repo, 'worktree', 'list', '--porcelain')).toContain(trees[1]);

    const resumed = await gather();
    const remaining = resumed.verdicts.find((verdict) => verdict.path === trees[1])!;
    remaining.disposition = 'reclaimable';
    const previousRoot = process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
    process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = ret;
    try {
      // The public executor deliberately obtains its own pin reader under the
      // real mutex. Write an actual pin after the resumed plan was gathered.
      createRetentionPin({ path: trees[1]!, owner: 'test-owner', reason: 'pin before resumed removal',
        expiresAt: new Date(Date.now() + DAY).toISOString() }, { dir: ret });
      const protectedResult = await reclaimCutWorktrees(resumed, {}, {
        scanHolders: () => verified,
        archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {},
      });
      expect(protectedResult.ok).toBe(false);
      expect(protectedResult.execution).toMatchObject({ ok: true, results: [
        { path: trees[1], removed: false, reason: 'active retention pin' },
      ] });
      expect(fs.existsSync(trees[1]!)).toBe(true);
    } finally {
      if (previousRoot === undefined) delete process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
      else process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = previousRoot;
    }
  });

  it('counts an interrupted physical removal in the cap after the worktree was moved aside', async () => {
    const tree = path.join(tmp, 'partial-cut');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.writeFileSync(path.join(tree, 'package-lock.json'), Buffer.alloc(8192, 1));
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 }, {
      scanHolders: () => verified, archiveDir: path.join(ret, 'reclaim-archive'),
      rmrf: async () => { throw new Error('injected incomplete physical deletion'); },
    });
    expect(result.ok).toBe(false);
    expect(result.cap.afterBytes).toBe(result.cap.beforeBytes);
    expect(result.cap.overByBytes).toBeGreaterThan(8192);
    expect(result.cap.retainedPaths[0]).toContain('.reclaim-trash-partial-cut-');
  });

  it.each([
    { scope: 'root', aliased: false },
    { scope: 'child', aliased: false },
    { scope: 'child', aliased: true },
  ])('attributes a validated $scope pin on interrupted trash without granting removal authority (logical alias: $aliased)', async ({ scope, aliased }) => {
    const tree = path.join(tmp, 'interrupted-pinned-cut');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.mkdirSync(path.join(tree, 'evidence'));
    fs.writeFileSync(path.join(tree, 'evidence', 'proof'), Buffer.alloc(8192, 1));
    fs.writeFileSync(path.join(tree, 'bulk'), Buffer.alloc(128 * 1024, 1));
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const failedRemoval = await executeCutReclaim(plan, [tree], {
      scanHolders: () => verified, archiveDir: path.join(ret, 'reclaim-archive'),
      rmrf: async () => { throw new Error('injected interrupted deletion'); },
    });
    expect(failedRemoval).toMatchObject({ ok: true, results: [{ removed: false, reason: expect.stringContaining('partial removal') }] });
    const next = await gather();
    expect(next.verdicts).toEqual([]);
    const trash = next.interrupted![0]!.trash;
    const pinnedPath = scope === 'root' ? trash : path.join(trash, 'evidence');
    if (aliased) {
      const alias = path.join(tmp, 'interrupted-trash-parent-alias');
      fs.symlinkSync(path.dirname(trash), alias);
      const logicalPin = path.join(alias, path.basename(trash), 'evidence');
      expect(logicalPin).not.toBe(pinnedPath);
      expect(fs.realpathSync(logicalPin)).toBe(pinnedPath);
      pin(logicalPin);
    } else {
      pin(pinnedPath);
    }
    const rmrf = vi.fn(async () => { throw new Error('trash must remain protected'); });
    const result = await reclaimCutWorktrees(next, { maxBytes: 1 }, {
      scanHolders: () => verified, archiveDir: path.join(ret, 'reclaim-archive'), rmrf,
    });
    const expected = scope === 'root' ? result.cap.beforeBytes :
      (fs.lstatSync(pinnedPath).blocks + fs.lstatSync(path.join(pinnedPath, 'proof')).blocks) * 512;
    expect(result.cap.pinnedPaths).toEqual([pinnedPath]);
    expect(result.cap.pinnedBytes).toBe(expected);
    expect(result.cap.pinnedOverageBytes).toBe(expected! - 1);
    expect(result.ok).toBe(scope === 'root');
    if (scope === 'child') expect(result.errors.join(';')).toContain('non-pin excess');
    expect(rmrf).not.toHaveBeenCalled();
    expect(fs.existsSync(trash)).toBe(true);
    expect(await executeCutReclaim(next, [trash])).toMatchObject({ ok: false, refused: true });
  });

  it.each([false, true])('retains named-only cuts over cap without inventing deletion authority (managed: %s)', async managed => {
    const tree = path.join(tmp, 'named-only');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    expect(plan.verdicts[0]!.disposition).toBe('named-only');
    const slot = managed ? usageSlot() : undefined;
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 }, { usageWalk: slot?.usageWalk });
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toContain('non-pin excess');
    expect(result.targets).toEqual([]);
    expect(result.cap.afterBytes).toBeGreaterThan(1);
    expect(result.cap.retainedPaths).toEqual([tree]);
    expect(fs.existsSync(tree)).toBe(true);
    if (slot) await slot.finished();
  });

  it.each([false, true])('accepts allocated pin-only overage without removing protected cuts (managed: %s)', async managed => {
    const tree = path.join(tmp, 'pin-only-cap');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.writeFileSync(path.join(tree, 'pinned-data'), Buffer.alloc(32768, 1));
    pin(tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'protected';
    const slot = managed ? usageSlot() : undefined;
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 }, { usageWalk: slot?.usageWalk });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.cap.afterBytes).toBeGreaterThan(32768);
    expect(result.cap.pinnedBytes).toBe(result.cap.afterBytes);
    expect(result.cap.pinnedOverageBytes).toBe(result.cap.overByBytes);
    expect(result.targets).toEqual([]);
    expect(fs.existsSync(tree)).toBe(true);
    if (slot) await slot.finished();
  });

  it('remeasures pin allocation before accepting retained mixed-root excess', async () => {
    const pinned = path.join(tmp, 'shrinking-pin'), named = path.join(tmp, 'named-cap');
    for (const tree of [pinned, named]) g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const data = path.join(pinned, 'pinned-data');
    fs.writeFileSync(data, Buffer.alloc(131072, 1));
    fs.writeFileSync(path.join(named, 'retained-data'), Buffer.alloc(32768, 1));
    pin(pinned);
    const plan = await gather();
    const v = plan.verdicts.find(v => v.path === pinned)!;
    v.disposition = 'protected';
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 }, {
      refreshPlan: async () => { fs.rmSync(data); return plan; },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toContain('non-pin excess');
    expect(result.cap.beforeBytes).toBeGreaterThan(result.cap.afterBytes!);
    expect(result.cap.pinnedBytes).toBeLessThan(131072);
    expect(result.cap.overByBytes).toBeGreaterThan(result.cap.pinnedOverageBytes!);
    expect(fs.existsSync(pinned)).toBe(true);
    expect(fs.existsSync(named)).toBe(true);
    expect(result.targets).toEqual([]);
  });

  it('collects an expired cut below cap and reports zero remaining allocated bytes', async () => {
    const tree = path.join(tmp, 'below-cap');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const result = await reclaimCutWorktrees(plan, {}, {
      scanHolders: () => verified, archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.cap.beforeBytes).toBeGreaterThan(0);
    expect(result.cap.beforeBytes).toBeLessThan(result.cap.maxBytes);
    expect(result.cap.afterBytes).toBe(0);
    expect(result.cap.overByBytes).toBe(0);
    expect(result.cap.retainedPaths).toEqual([]);
    expect(fs.existsSync(tree)).toBe(false);
  });

  it('charges shared hardlink allocation to pins before unpinned cuts', async () => {
    const unpinned = path.join(tmp, 'a-unpinned'), pinned = path.join(tmp, 'z-pinned');
    for (const tree of [unpinned, pinned]) g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const data = path.join(unpinned, 'package-lock.json');
    fs.writeFileSync(data, Buffer.alloc(32768, 1));
    fs.linkSync(data, path.join(pinned, 'package-lock.json'));
    pin(pinned);
    const plan = await gather();
    const v = plan.verdicts.find((v) => v.path === pinned)!;
    v.disposition = 'protected';
    const result = await reclaimCutWorktrees(plan, { dryRun: true, maxBytes: 1 });
    expect(result.ok).toBe(true);
    expect(result.cap.pinnedBytes).toBeGreaterThanOrEqual(fs.statSync(data).blocks * 512);
    expect(result.cap.pinnedOverageBytes).toBe(result.cap.pinnedBytes! - 1);
  });

  it.each([false, true])('counts exact validated child-pin allocation without excusing sibling bulk (managed: %s)', async managed => {
    const tree = path.join(tmp, 'child-pin-cut');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const child = path.join(tree, 'evidence'); fs.mkdirSync(child);
    const evidence = path.join(child, 'proof'); fs.writeFileSync(evidence, Buffer.alloc(8192, 1));
    fs.linkSync(evidence, path.join(child, 'proof-link'));
    fs.linkSync(evidence, path.join(tree, 'outside-link'));
    const second = path.join(tree, 'second-proof'); fs.linkSync(evidence, second);
    fs.writeFileSync(path.join(tree, 'unpinned-bulk'), Buffer.alloc(131072, 1));
    pin(child); pin(evidence); pin(second);
    const plan = await gather();
    expect(plan.verdicts[0]!.disposition).toBe('protected');
    const slot = managed ? usageSlot() : undefined;
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 }, { usageWalk: slot?.usageWalk });
    const expected = (fs.lstatSync(child).blocks + fs.lstatSync(evidence).blocks) * 512;
    expect(result.cap.pinnedBytes).toBe(expected);
    expect(result.cap.pinnedOverageBytes).toBe(expected - 1);
    expect(result.cap.overByBytes).toBeGreaterThan(result.cap.pinnedOverageBytes!);
    expect(result.ok).toBe(false);
    expect(result.errors.join('; ')).toContain('non-pin excess');
    expect(fs.existsSync(tree)).toBe(true);
    if (slot) await slot.finished();
  });

  it.each([false, true])('rejects fabricated pin provenance in a protected verdict (managed: %s)', async managed => {
    const tree = path.join(tmp, 'fabricated-pin-cut');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'protected';
    plan.verdicts[0]!.reasons = ['lease:agent-pin-fixture'];
    const slot = managed ? usageSlot() : undefined;
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 }, { usageWalk: slot?.usageWalk });
    expect(result.ok).toBe(false);
    expect(result.cap.pinnedBytes).toBe(0);
    expect(result.cap.pinnedPaths).toEqual([]);
    expect(fs.existsSync(tree)).toBe(true);
    if (slot) await slot.finished();
  });

  it('does not attribute an expired child pin to the retained parent', async () => {
    const tree = path.join(tmp, 'expired-child-pin');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const evidence = path.join(tree, 'proof'); fs.writeFileSync(evidence, Buffer.alloc(8192, 1));
    pin(evidence);
    const plan = await gather();
    const leaseFile = path.join(ret, fs.readdirSync(ret).find(name => name.startsWith('lease-agent-pin-'))!);
    fs.writeFileSync(leaseFile, fs.readFileSync(leaseFile, 'utf8').replace(/expires_ns=\d+/, 'expires_ns=1'));
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 });
    expect(result.cap.pinnedBytes).toBe(0);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(tree)).toBe(true);
  });

  it('refuses malformed pin metadata before allocation or removal', async () => {
    const tree = path.join(tmp, 'malformed-child-pin');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather(); plan.verdicts[0]!.disposition = 'reclaimable';
    fs.writeFileSync(path.join(ret, 'lease-agent-pin-invalid.tsv'),
      `schema=papercusp-release-retention/v1\ntag=agent-pin-invalid\nexpires_ns=1\npath=${tree}\n`);
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 });
    expect(result.ok).toBe(false);
    expect(result.cap.beforeBytes).toBeNull();
    expect(result.cap.pinnedBytes).toBeNull();
    expect(result.errors.join('; ')).toContain('retention pins unreadable');
    expect(fs.existsSync(tree)).toBe(true);
  });

  it.each(['incomplete', 'disappeared'])('keeps %s child-pin allocation unknown', async kind => {
    const tree = path.join(tmp, 'unknown-pin-cut');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const child = path.join(tree, 'evidence'); fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, 'proof'), Buffer.alloc(8192, 1)); pin(child);
    const plan = await gather();
    const census = await import('./storage/disk-consumer-census');
    const original = census.inspectRetentionTrees;
    const inspect = vi.spyOn(census, 'inspectRetentionTrees').mockImplementation(async (root, options) => {
      if (kind === 'incomplete') return { entries: [], retained: [], inspectedNodes: 0,
        retainedRecentTrees: 0, error: 'fixture incomplete pin census' };
      const result = await original(root, options);
      fs.rmSync(child, { recursive: true });
      return result;
    });
    try {
      const result = await reclaimCutWorktrees(plan, { maxBytes: 1 });
      expect(result.ok).toBe(false);
      expect(result.cap.beforeBytes).toBeNull();
      expect(result.cap.pinnedBytes).toBeNull();
      expect(result.errors.join('; ')).toContain(kind === 'incomplete' ? 'fixture incomplete' : 'ENOENT');
      expect(fs.existsSync(tree)).toBe(true);
    } finally { inspect.mockRestore(); }
  });

  it('refuses a child pin replaced by a symlink to unrelated allocation', async () => {
    const tree = path.join(tmp, 'replaced-pin-cut');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const child = path.join(tree, 'proof'); fs.writeFileSync(child, Buffer.alloc(8192, 1)); pin(child);
    const plan = await gather();
    const outside = path.join(tmp, 'outside-proof'); fs.writeFileSync(outside, Buffer.alloc(16384, 1));
    fs.rmSync(child); fs.symlinkSync(outside, child);
    const result = await reclaimCutWorktrees(plan, { maxBytes: 1 });
    expect(result.ok).toBe(false);
    expect(result.cap.beforeBytes).toBeNull();
    expect(result.cap.pinnedBytes).toBeNull();
    expect(result.errors.join('; ')).toContain('noncanonical release-cut pin scope');
    expect(fs.existsSync(tree)).toBe(true);
  });

  it('uses one validated snapshot across real pin expiry and expires it on the next run', async () => {
    const tree = path.join(tmp, 'snapshot-pin-cut');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const child = path.join(tree, 'evidence'); fs.mkdirSync(child);
    const data = path.join(child, 'proof'); fs.writeFileSync(data, Buffer.alloc(8192, 1)); pin(child);
    const plan = await gather(); plan.verdicts[0]!.disposition = 'reclaimable';
    const pins = await import('../../../scripts/lib/retention-pins.mjs');
    const census = await import('./storage/disk-consumer-census');
    const originalRead = pins.readRetentionPinsAsync, originalInspect = census.inspectRetentionTrees;
    let expires = 0;
    const read = vi.spyOn(pins, 'readRetentionPinsAsync').mockImplementation(async options => {
      expires = Date.now() + 100;
      const file = path.join(ret, fs.readdirSync(ret).find(name => name.startsWith('lease-agent-pin-'))!);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/expires_ns=\d+/,
        'expires_ns=' + BigInt(expires) * 1_000_000n));
      return originalRead(options);
    });
    const inspect = vi.spyOn(census, 'inspectRetentionTrees').mockImplementation(async (root, options) => {
      if (Date.now() <= expires) await new Promise(resolve => setTimeout(resolve, expires - Date.now() + 20));
      return originalInspect(root, options);
    });
    const deps = { scanHolders: () => verified, archiveDir: path.join(ret, 'reclaim-archive'), appendAudit: () => {} };
    try {
      const first = await reclaimCutWorktrees(plan, {}, deps);
      expect(Date.now()).toBeGreaterThan(expires);
      expect(first.execution).toMatchObject({ ok: true, results: [{ removed: false, reason: 'active retention pin' }] });
      expect(first.cap.pinnedBytes).toBe((fs.statSync(child).blocks + fs.statSync(data).blocks) * 512);
      expect(fs.existsSync(tree)).toBe(true);
      read.mockRestore(); inspect.mockRestore();
      const next = await reclaimCutWorktrees(plan, {}, deps);
      expect(next.ok).toBe(true);
      expect(next.cap.pinnedBytes).toBe(0);
      expect(fs.existsSync(tree)).toBe(false);
    } finally { read.mockRestore(); inspect.mockRestore(); }
  });

  it('refuses the whole sweep when allocated-byte measurement fails', async () => {
    const tree = path.join(tmp, 'unmeasurable');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'du'), '#!/bin/sh\nprintf "du: fixture permission denied\\n" >&2\nexit 1\n', { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const result = await reclaimCutWorktrees(plan, { maxBytes: 1 });
      expect(result.ok).toBe(false);
      expect(result.cap.beforeBytes).toBeNull();
      expect(result.cap.afterBytes).toBeNull();
      expect(result.errors[0]).toContain('usage before reclaim');
      const failure = JSON.parse(result.errors[0]!.split('usage before reclaim: ')[1]!);
      expect(failure).toMatchObject({ code: 1, signal: null, killed: false,
        stderr: 'du: fixture permission denied\n' });
      expect(fs.existsSync(tree)).toBe(true);
    } finally { process.env.PATH = previous; }
  });

  it('finishes a quiet multi-root usage walk past ten seconds and counts only complete root totals', async () => {
    const first = path.join(tmp, 'quiet-usage-first');
    const second = path.join(tmp, 'quiet-usage-second');
    g(repo, 'worktree', 'add', '-q', '--detach', first);
    g(repo, 'worktree', 'add', '-q', '--detach', second);
    const plan = await gather();
    const bin = path.join(tmp, 'quiet-du');
    fs.mkdirSync(bin);
    // A metadata silence does not prove the traversal is stuck: a single large
    // directory or a buffered du stream can be quiet for more than ten seconds.
    // Keep the whole-population command quiet past the former watchdog, then
    // emit a complete NUL-framed root total for every requested root.
    fs.writeFileSync(path.join(bin, 'du'), `#!${process.execPath}
const roots = process.argv.slice(process.argv.indexOf('--') + 1);
setTimeout(() => {
  for (const root of roots) process.stdout.write('8192\\t' + root + '\\0');
}, 11_000);
`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const result = await reclaimCutWorktrees(plan, { dryRun: true, maxBytes: 1, notAfterMs: Date.now() + 20_000 });
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
      expect(result.cap.beforeBytes).toBe(8192 * result.cap.retainedPaths.length);
      expect(result.cap.retainedPaths).toContain(first);
      expect(result.cap.retainedPaths).toContain(second);
      expect(fs.existsSync(first)).toBe(true);
      expect(fs.existsSync(second)).toBe(true);
    } finally { process.env.PATH = previous; }
  }, 25_000);

  it.each(['missing-root', 'duplicate-root', 'malformed', 'outside-root', 'partial'])('refuses %s usage evidence before any removal', async (kind) => {
    const tree = path.join(tmp, 'invalid-usage');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const row = `8192\t${tree}\0`;
    const output = kind === 'missing-root' ? `4096\t${tree}/child\0`
      : kind === 'duplicate-root' ? row + row
      : kind === 'malformed' ? `NaN\t${tree}\0`
      : kind === 'outside-root' ? `8192\t${tree}-outside\0` : row.slice(0, -1);
    const bin = path.join(tmp, 'invalid-du');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'du'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\n`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const result = await reclaimCutWorktrees(plan);
      expect(result.ok).toBe(false);
      expect(result.cap.beforeBytes).toBeNull();
      expect(result.cap.afterBytes).toBeNull();
      expect(result.errors[0]).toContain('usage before reclaim');
      expect(fs.existsSync(tree)).toBe(true);
      expect(fs.existsSync(path.join(ret, 'reclaim-archive'))).toBe(false);
    } finally { process.env.PATH = previous; }
  });

  it('stops a still-productive usage walk at the existing shared run deadline', async () => {
    const tree = path.join(tmp, 'deadline-usage');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const bin = path.join(tmp, 'deadline-du');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'du'), `#!${process.execPath}
let index = 0;
setInterval(() => process.stdout.write('4096\\t' + ${JSON.stringify(tree)} + '/child-' + index++ + '\\0'), 20);
`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const result = await reclaimCutWorktrees(plan, { notAfterMs: Date.now() + 300 });
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('run deadline exhausted');
      expect(result.cap.beforeBytes).toBeNull();
      expect(fs.existsSync(tree)).toBe(true);
    } finally { process.env.PATH = previous; }
  });

  it.each([false, true])('retains diagnostics when an idle usage walk reaches its run deadline (initial record: %s)', async (initialRecord) => {
    const tree = path.join(tmp, 'idle-usage');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    plan.verdicts[0]!.disposition = 'reclaimable';
    const bin = path.join(tmp, 'idle-du');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'du'), `#!${process.execPath}
${initialRecord ? `process.stdout.write('4096\\t' + ${JSON.stringify(tree)} + '/last-file\\0');` : ''}
setInterval(() => { process.stdout.write('1'); process.stderr.write('noise'); }, 100);
`, { mode: 0o755 });
    const previous = process.env.PATH;
    process.env.PATH = bin;
    try {
      const notAfterMs = Date.now() + 3_000;
      const result = await reclaimCutWorktrees(plan, { notAfterMs });
      expect(Date.now()).toBeGreaterThanOrEqual(notAfterMs - 1);
      expect(result.ok).toBe(false);
      expect(result.errors[0]).toContain('run deadline exhausted');
      const failure = JSON.parse(result.errors[0]!.split('usage before reclaim: ')[1]!);
      expect(failure.usageProgress).toMatchObject({
        metadataRecords: initialRecord ? 1 : 0, completedRoots: 0, totalRoots: 1,
        lastMetadataPath: initialRecord ? `${tree}/last-file` : null,
      });
      expect(failure.usageProgress.stdoutBytes).toBeGreaterThan(0);
      expect(failure.usageProgress.pendingBytes).toBeGreaterThan(0);
      expect(failure.usageProgress.elapsedMs).toBeGreaterThan(0);
      // Noise arrives every 100ms after the initial valid record. Compare its
      // observed count to the age, rather than assuming child startup <500ms.
      if (initialRecord) {
        expect(failure.usageProgress.lastMetadataAgeMs).toBeGreaterThanOrEqual((failure.usageProgress.pendingBytes - 1) * 100);
        expect(failure.usageProgress.lastMetadataAgeMs).toBeLessThanOrEqual(failure.usageProgress.elapsedMs);
      }
      else expect(failure.usageProgress.lastMetadataAgeMs).toBeNull();
      expect(result.cap.beforeBytes).toBeNull();
      expect(fs.existsSync(tree)).toBe(true);
      expect(fs.existsSync(path.join(ret, 'reclaim-archive'))).toBe(false);
    } finally { process.env.PATH = previous; }
  }, 20_000);

  it('measures allocated bytes for descendant paths containing tabs and newlines without following symlinks or opening FIFOs', async () => {
    const tree = path.join(tmp, 'usage-separators');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const data = path.join(tree, 'file\twith\nseparators');
    fs.writeFileSync(data, Buffer.alloc(8192, 1));
    fs.symlinkSync(tmp, path.join(tree, 'outside'));
    execFileSync('mkfifo', [path.join(tree, 'fifo')]);
    const plan = await gather();
    const result = await reclaimCutWorktrees(plan, { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.cap.beforeBytes).toBeGreaterThanOrEqual(fs.statSync(data).blocks * 512);
    expect(result.cap.retainedPaths).toEqual([tree]);
  });

  it('removes an OFFLOADED tree: the real directory and the symlink both go', async () => {
    const tree = path.join(tmp, 'relcut-0023-win');
    const offload = path.join(tmp, 'offload');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.mkdirSync(offload);
    fs.renameSync(tree, path.join(offload, 'relcut-0023-win'));
    fs.symlinkSync(path.join(offload, 'relcut-0023-win'), tree);
    const plan = await gather();
    const res = await executeCutReclaim(plan, [tree], {
      scanHolders: () => ({ verified: true, holders: new Map() }),
      archiveDir: path.join(ret, 'archive'),
      appendAudit: () => {},
    });
    expect(res).toMatchObject({ ok: true, results: [{ removed: true }] });
    expect(fs.existsSync(path.join(offload, 'relcut-0023-win'))).toBe(false);
    expect(() => fs.lstatSync(tree)).toThrow();
  });

  it('rediscovers failed physical deletion from the retained archive after the original path becomes prunable', async () => {
    const parent = path.join(tmp, 'producer');
    const tree = path.join(parent, 'source');
    const offload = path.join(tmp, 'offload');
    fs.mkdirSync(parent);
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.renameSync(parent, offload);
    fs.symlinkSync(offload, parent);
    const admin = g(tree, 'rev-parse', '--absolute-git-dir');
    const rmrf = vi.fn(async () => { throw new Error('injected deletion failure'); });
    const result = await executeCutReclaim(await gather(), [tree], {
      scanHolders: () => verified,
      archiveDir: path.join(ret, 'reclaim-archive'),
      rmrf,
    });
    expect(result).toMatchObject({ ok: true, results: [{ removed: false, reason: expect.stringContaining('partial removal') }] });
    expect(rmrf).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(admin)).toBe(true);
    expect(fs.existsSync(tree)).toBe(false);
    const next = await gather();
    expect(next.skipped.prunable).toBe(1);
    expect(next.interrupted).toHaveLength(1);
    const residue = next.interrupted![0]!;
    expect(residue).toMatchObject({ path: tree, realPath: path.join(offload, 'source'), adminDir: admin, state: 'trash-present' });
    expect(fs.readFileSync(path.join(residue.trash, '.git'), 'utf8')).toContain(admin);
    expect(fs.readFileSync(residue.archive, 'utf8')).toContain('## HEAD ');
    expect(renderReclaimPlan(next)).toMatchObject({ interrupted: [residue] });
    // A recovery receipt reports evidence; it does not confer deletion authority.
    expect(await executeCutReclaim(next, [residue.trash])).toMatchObject({ ok: false, refused: true });
    expect(fs.existsSync(residue.trash)).toBe(true);
  });

  it('keeps unfinished Git bookkeeping discoverable after physical deletion succeeds', async () => {
    const tree = path.join(tmp, 'relcut-bookkeeping');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const admin = g(tree, 'rev-parse', '--absolute-git-dir');
    const calls: string[] = [];
    await executeCutReclaim(await gather(), [tree], {
      scanHolders: () => verified,
      archiveDir: path.join(ret, 'reclaim-archive'),
      rmrf: async (p) => {
        calls.push(p);
        if (p === admin) throw new Error('injected bookkeeping failure');
        await fs.promises.rm(p, { recursive: true, force: true });
      },
    });
    expect(calls[0]).toContain('.reclaim-trash-');
    expect(calls[1]).toBe(admin);
    expect((await gather()).interrupted).toEqual([expect.objectContaining({ path: tree, state: 'bookkeeping-pending' })]);
  });

  it('refuses to rename when the retained removal receipt cannot be made durable', async () => {
    const tree = path.join(tmp, 'relcut-receipt');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const rename = vi.fn(fs.renameSync);
    const result = await executeCutReclaim(await gather(), [tree], {
      scanHolders: () => verified,
      archiveDir: path.join(ret, 'reclaim-archive'),
      recordRemoval: () => { throw new Error('injected fsync failure'); },
      rename,
    });
    expect(result).toMatchObject({ ok: true, results: [{ removed: false, reason: expect.stringContaining('removal receipt failed') }] });
    expect(rename).not.toHaveBeenCalled();
    expect(g(tree, 'rev-parse', 'HEAD')).toBe(g(repo, 'rev-parse', 'HEAD'));
    expect((await gather()).interrupted).toEqual([]);
  });

  it('removes an offloaded tree beneath a symlinked parent without unlinking the missing leaf', async () => {
    const parent = path.join(tmp, 'producer');
    const tree = path.join(parent, 'source');
    const offload = path.join(tmp, 'offloaded-producer');
    fs.mkdirSync(parent);
    fs.writeFileSync(path.join(parent, 'evidence.txt'), 'retained producer evidence');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.renameSync(parent, offload);
    fs.symlinkSync(offload, parent);
    const plan = await gather();
    const adminDir = plan.verdicts.find((v) => v.path === tree)?.realPath;
    expect(adminDir).toBe(path.join(offload, 'source'));
    const unlink = vi.fn(fs.unlinkSync);
    const res = await executeCutReclaim(plan, [tree], {
      scanHolders: () => ({ verified: true, holders: new Map() }),
      archiveDir: path.join(ret, 'archive'),
      appendAudit: () => {},
      unlink,
    });
    expect(res).toMatchObject({ ok: true, results: [{ path: tree, removed: true }] });
    expect(unlink).not.toHaveBeenCalled();
    expect(fs.lstatSync(parent).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(parent, 'evidence.txt'), 'utf8')).toBe('retained producer evidence');
    expect(fs.existsSync(path.join(offload, 'source'))).toBe(false);
    expect(fs.readdirSync(offload).filter((n) => n.startsWith('.reclaim-trash-'))).toEqual([]);
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain(tree);
    expect(fs.readdirSync(path.join(repo, '.git', 'worktrees'))).toEqual([]);
  });

  // WI-10006139: the planner offered `.papercusp/worktrees/desktop-release-0.0.19` (a linked
  // worktree NESTED in the canonical tree) as named-only, and the executor then refused it as
  // "overlaps the canonical tree" — a descendant is not the canonical tree or an ancestor.
  it('removes a linked worktree nested INSIDE the canonical tree and leaves the canonical repo intact', async () => {
    const tree = path.join(repo, '.papercusp', 'worktrees', 'desktop-release-0.0.19');
    fs.mkdirSync(path.dirname(tree), { recursive: true });
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    expect(plan.verdicts.find((v) => v.path === tree)?.disposition).toBe('named-only');
    const res = await executeCutReclaim(plan, [tree], {
      scanHolders: () => ({ verified: true, holders: new Map() }),
      archiveDir: path.join(ret, 'archive'),
      appendAudit: () => {},
    });
    expect(res).toMatchObject({ ok: true, results: [{ path: tree, removed: true }] });
    expect(fs.existsSync(tree)).toBe(false);
    expect(fs.readdirSync(path.dirname(tree)).filter((n) => n.startsWith('.reclaim-trash-'))).toEqual([]);
    expect(g(repo, 'worktree', 'list', '--porcelain')).not.toContain('desktop-release-0.0.19');
    expect(fs.statSync(path.join(repo, '.git')).isDirectory()).toBe(true);
    expect(g(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('staging');
  });

  // WI-10006139: archiveTreeDiffs collected `git diff --binary HEAD` through the buffered git()
  // helper (64 MB maxBuffer), so a cut tree whose staged sidecar diff was 158 MB could never be
  // archived — and therefore never removed. The archive must stream, with no size ceiling.
  it('archives a tracked diff larger than 64 MB (streamed, not buffered) and then removes the tree', async () => {
    const tree = path.join(tmp, 'relcut-big-diff');
    const blob = path.join(repo, 'sidecar.bin');
    // --binary emits a forward AND a reverse literal; 32 MB of incompressible bytes each way
    // base85-encodes to well over 64 MB (asserted below, so the test cannot pass vacuously).
    fs.writeFileSync(blob, crypto.randomBytes(32 * 1024 * 1024));
    g(repo, 'add', 'sidecar.bin');
    g(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'sidecar');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.writeFileSync(path.join(tree, 'sidecar.bin'), crypto.randomBytes(32 * 1024 * 1024));
    const plan = await gather({ authoredWork: () => ({ ok: true as const, authored: [], machineWritten: 1 }) });
    const res = await executeCutReclaim(plan, [tree], {
      scanHolders: () => ({ verified: true, holders: new Map() }),
      archiveDir: path.join(ret, 'archive'),
      appendAudit: () => {},
    });
    expect(res).toMatchObject({ ok: true, results: [{ path: tree, removed: true }] });
    const [archive] = fs.readdirSync(path.join(ret, 'archive'));
    const archivePath = path.join(ret, 'archive', archive as string);
    expect(fs.statSync(archivePath).size).toBeGreaterThan(64 * 1024 * 1024);
    const head = fs.readFileSync(archivePath, 'utf8').slice(0, 4096);
    expect(head).toContain('## HEAD ');
    expect(head).toContain('GIT binary patch');
    expect(fs.existsSync(tree)).toBe(false);
  }, 120_000);

  it('refuses a protected target and removes nothing; a fresh holder hit aborts that tree', async () => {
    const tree = path.join(tmp, 'relcut-live');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    fs.writeFileSync(
      path.join(ret, 'lease-desktop-v0.0.24-alpha.tsv'),
      // a FINITE live expiry: an expires_ns=0 lease on a pre-published version no longer protects
      `schema=papercusp-release-retention/v1\ntag=desktop-v0.0.24-alpha\ncreated_ns=1\nexpires_ns=${BigInt(Date.now() + DAY) * 1_000_000n}\npath=${tree}/target\n`,
    );
    const refused = await executeCutReclaim(await gather(), [tree]);
    expect(refused).toMatchObject({ ok: false, refused: true });
    fs.rmSync(path.join(ret, 'lease-desktop-v0.0.24-alpha.tsv'));
    const held = await executeCutReclaim(await gather(), [tree], {
      scanHolders: () => ({ verified: true, holders: new Map([[tree, ['pid 9 cwd']]]) }),
    });
    expect(held).toMatchObject({ ok: true, results: [{ removed: false, reason: 'in use: pid 9 cwd' }] });
    expect(fs.existsSync(tree)).toBe(true);
  });

  it('re-reads agent pins under the executor mutex when a pin lands after planning', async () => {
    const tree = path.join(tmp, 'relcut-pin-race');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const previousRoot = process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
    process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = ret;
    try {
      // The plan is intentionally captured before the pin exists: this is the
      // read-to-delete race that a plan-only check cannot close.
      const plan = await gather();
      createRetentionPin({ path: tree, owner: 'test-owner', reason: 'race regression',
        expiresAt: new Date(Date.now() + DAY).toISOString() }, { dir: ret });
      const result = await executeCutReclaim(plan, [tree], {
        scanHolders: () => ({ verified: true, holders: new Map() }),
        archiveDir: path.join(ret, 'archive'),
        appendAudit: () => {},
      });
      expect(result).toMatchObject({ ok: true, results: [{ path: tree, removed: false, reason: 'active retention pin' }] });
      expect(fs.existsSync(tree)).toBe(true);
    } finally {
      if (previousRoot === undefined) delete process.env.PAPERCUSP_RELEASE_RETENTION_ROOT;
      else process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = previousRoot;
    }
  });

  it('waits for a pin writer before its final protection read', async () => {
    const tree = path.join(tmp, 'relcut-pin-writer');
    g(repo, 'worktree', 'add', '-q', '--detach', tree);
    const plan = await gather();
    const envKeys = ['PAPERCUSP_RELEASE_RETENTION_ROOT', 'PAPERCUSP_FS_MUTEX_LOCK_DIR', 'PAPERCUSP_DISABLE_FS_MUTEX'] as const;
    const saved = envKeys.map((key) => process.env[key]);
    process.env.PAPERCUSP_RELEASE_RETENTION_ROOT = ret;
    process.env.PAPERCUSP_FS_MUTEX_LOCK_DIR = path.join(tmp, 'mutexes');
    delete process.env.PAPERCUSP_DISABLE_FS_MUTEX;
    let execution!: ReturnType<typeof executeCutReclaim>;
    try {
      await withFsMutex('papercusp-disk-retention', async () => {
        execution = executeCutReclaim(plan, [tree], {
          scanHolders: () => ({ verified: true, holders: new Map() }),
          archiveDir: path.join(ret, 'archive'), appendAudit: () => {},
        });
        // An executor that reads before waiting or never takes the mutex would
        // miss this pin. The writer still owns the lock for the whole delay.
        await new Promise((resolve) => setTimeout(resolve, 100));
        createRetentionPin({ path: tree, owner: 'test-writer', reason: 'pin while executor waits',
          expiresAt: new Date(Date.now() + DAY).toISOString() }, { dir: ret });
      });
      expect(await execution).toMatchObject({ ok: true, results: [{ removed: false, reason: 'active retention pin' }] });
      expect(fs.existsSync(tree)).toBe(true);
    } finally {
      await execution?.catch(() => {});
      envKeys.forEach((key, i) => {
        if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
      });
    }
  });
});

// WI-10005315 (owner directive #1155): this module runs inside the operator host via
// release:cut. On 2026-10-02 05:30Z its synchronous git (execFileSync per tree and per
// submodule) held :3170's event loop for 24s and the sentinel SIGKILLed the host.
describe('host event loop stays live during reclaim git + /proc work', () => {
  let binDir: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-slow-git-'));
    // A `git` that takes 300ms and fails: one call is enough to observe whether the
    // caller blocks the event loop while the child runs.
    fs.writeFileSync(path.join(binDir, 'git'), '#!/bin/sh\nsleep 0.3\nexit 1\n', { mode: 0o755 });
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it('inspectAuthoredWork never blocks the event loop while git runs (a 20ms timer fires first)', async () => {
    const order: string[] = [];
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        order.push('timer');
        resolve();
      }, 20),
    );
    // A synchronous spawn finishes the whole 300ms git call before the timer can run,
    // so 'inspect' would come first; an async spawn lets the loop service the timer.
    const result = await inspectAuthoredWork(binDir, binDir, VERSION_PATHS).then((r) => {
      order.push('inspect');
      return r;
    });
    await timer;
    expect(order).toEqual(['timer', 'inspect']);
    expect(result.ok).toBe(false); // the fake git exits 1 → fails CLOSED, as before
  });

  it('archiveTreeDiffs is async and rejects (not throws synchronously) on a git failure', async () => {
    const pending = archiveTreeDiffs(binDir, path.join(binDir, 'out', 'a.patch'));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow();
  });
});

describe('inspectAuthoredWork reads submodules width-bounded (EI-24849983022443070)', () => {
  const SHA = 'a'.repeat(40);
  let binDir: string;
  let log: string;
  let savedPath: string | undefined;
  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-subs-git-'));
    log = path.join(binDir, 'calls.log');
    fs.writeFileSync(
      path.join(binDir, 'subs.txt'),
      [1, 2, 3, 4, 5, 6].map((i) => ` ${SHA} sub/s${i} (heads/main)`).join('\n') + '\n',
    );
    // Each submodule status logs its start and end and holds 300ms, so the log ORDER
    // shows how many ran at once without a wall-clock assertion. s6's commit is absent
    // from the canonical checkout; RECLAIM_FAIL_SUB makes one submodule status fail.
    fs.writeFileSync(
      path.join(binDir, 'git'),
      [
        '#!/bin/sh',
        'case "$*" in',
        `  *"submodule status"*) cat '${path.join(binDir, 'subs.txt')}' ;;`,
        `  *"rev-parse HEAD"*) echo ${SHA} ;;`,
        '  *"for-each-ref"*) echo refs/heads/staging ;;',
        '  *"--ignore-submodules=all"*)',
        `    echo s >> '${log}'; sleep 0.3; echo e >> '${log}'`,
        '    case "$*" in *"/$RECLAIM_FAIL_SUB "*) exit 1 ;; esac ;;',
        '  *"cat-file"*) case "$*" in *sub/s6*) exit 1 ;; esac ;;',
        'esac',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
  });
  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.RECLAIM_FAIL_SUB;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  const peakOverlap = () => {
    let cur = 0;
    let peak = 0;
    for (const ev of fs.readFileSync(log, 'utf8').split('\n')) {
      if (ev === 's') peak = Math.max(peak, ++cur);
      else if (ev === 'e') cur--;
    }
    return peak;
  };

  it('overlaps submodule reads up to the width, never past it, and reports in submodule order', async () => {
    const tree = path.join(binDir, 'tree');
    // calibration: width 1 is the old serial loop, and the log instrument must read exactly 1
    await inspectAuthoredWork(tree, path.join(binDir, 'canon'), VERSION_PATHS, { submoduleConcurrency: 1 });
    expect(peakOverlap()).toBe(1);
    fs.rmSync(log);
    const result = await inspectAuthoredWork(tree, path.join(binDir, 'canon'), VERSION_PATHS, { submoduleConcurrency: 3 });
    expect(result).toEqual({
      ok: true,
      authored: [`sub/s6@${SHA.slice(0, 10)} (commit absent from canonical checkout)`],
      machineWritten: 0,
    });
    expect(fs.readFileSync(log, 'utf8').split('\n').filter((l) => l === 's')).toHaveLength(6);
    const peak = peakOverlap();
    expect(peak).toBeGreaterThanOrEqual(2); // a serial loop peaks at exactly 1
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('still fails CLOSED when one submodule read fails', async () => {
    process.env.RECLAIM_FAIL_SUB = 's2';
    const result = await inspectAuthoredWork(path.join(binDir, 'tree'), path.join(binDir, 'canon'), VERSION_PATHS);
    expect(result.ok).toBe(false);
  });
});

describe('scanProcHolders (async /proc walk) against a fabricated proc root', () => {
  let proc: string;
  let held: string;
  beforeEach(() => {
    proc = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-proc-'));
    held = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-held-'));
    const self = path.join(proc, String(process.pid));
    fs.mkdirSync(path.join(self, 'fd'), { recursive: true });
    fs.symlinkSync(fs.realpathSync(process.cwd()), path.join(self, 'cwd'));
    fs.symlinkSync(path.join(held, 'data.bin'), path.join(self, 'fd', '7'));
    fs.mkdirSync(path.join(proc, 'self'));
    fs.writeFileSync(path.join(proc, 'self', 'status'), `Name:\tnode\nNSpid:\t${process.pid}\n`);
    fs.mkdirSync(path.join(proc, '999999')); // an unreadable/exited process: no links at all
  });
  afterEach(() => {
    fs.rmSync(proc, { recursive: true, force: true });
    fs.rmSync(held, { recursive: true, force: true });
  });

  it('finds an fd holder, sees its own cwd as the positive control, and returns a Promise', async () => {
    const pending = scanProcHolders([{ key: held, prefixes: [held] }], proc);
    expect(pending).toBeInstanceOf(Promise);
    const scan = await pending;
    expect(scan.verified).toBe(true);
    expect(scan.holders.get(held)).toEqual([`pid ${process.pid} reference`]);
  });

  it('refuses verification in a nested PID namespace (a confident false idle otherwise)', async () => {
    fs.writeFileSync(path.join(proc, 'self', 'status'), `Name:\tnode\nNSpid:\t${process.pid}\t12\n`);
    const scan = await scanProcHolders([{ key: held, prefixes: [held] }], proc);
    expect(scan.verified).toBe(false);
    expect(scan.verified === false && scan.reason).toMatch(/nested-pid-namespace/);
  });

  it('refuses missing namespace evidence and incomplete worker reads', async () => {
    fs.writeFileSync(path.join(proc, 'self', 'status'), 'Name:\tnode\n');
    expect((await scanProcHolders([], proc)).verified).toBe(false);
    const scan = vi.fn().mockResolvedValue({ complete: false,
      byPath: new Map([[process.cwd(), [String(process.pid)]]]), diagnostics: { readFailures: 1 } });
    const result = await scanProcHolders([{ key: held, prefixes: [held] }], '/proc', { scan });
    expect(result.verified).toBe(false);
    expect(result.reason).toContain('holder-scan-incomplete');
  });

  it('reuses the isolated privileged scanner and preserves alias holders with bounded diagnostics', async () => {
    const diagnostics = { elapsedMs: 5, processesTotal: 10, processesScanned: 10, descriptorsScanned: 50, readFailures: 0 };
    const scan = vi.fn().mockResolvedValue({ complete: true, diagnostics,
      byPath: new Map([[process.cwd(), [String(process.pid)]], [held, ['42']], ['/real-cut', ['42', '7']]]) });
    const result = await scanProcHolders([{ key: held, prefixes: [held, '/real-cut'] }], '/proc', { scan });
    expect(scan).toHaveBeenCalledWith([held, '/real-cut'], { isolate: true, includeProcessLinks: true });
    expect(result).toEqual({ verified: true, diagnostics,
      holders: new Map([[held, ['pid 7 reference', 'pid 42 reference']]]) });
    scan.mockResolvedValueOnce({ complete: true, byPath: new Map() });
    expect((await scanProcHolders([], '/proc', { scan })).verified).toBe(false);
  });
});

describe('batched git helpers (EI-24849983022443070)', () => {
  const N = '0123456789abcdef0123456789abcdef';
  const frame = (tag: string, exit: number) => `\0${N} ${tag} ${exit}\0`;

  it('splits framed output in order, keeps NUL-delimited bodies intact, drops unframed tail bytes', () => {
    const body = '1 .M N... 100644 100644 100644 a b x.ts\0? we ird\nname\0';
    const out = body + frame('status', 0) + 'abc' + frame('head', 0) + frame('contains', 1) + 'partial';
    expect(parseHelperFrames(out, N)).toEqual([
      { tag: 'status', exit: 0, out: body },
      { tag: 'head', exit: 0, out: 'abc' },
      { tag: 'contains', exit: 1, out: '' },
    ]);
  });

  it('a frame forged with a different nonce stays inside the body', () => {
    const forged = `? \0${'f'.repeat(32)} head 0\0\0`;
    expect(parseHelperFrames(forged + frame('status', 0), N)).toEqual([{ tag: 'status', exit: 0, out: forged }]);
    expect(() => parseHelperFrames('', 'not-hex(.*)')).toThrow(/hex/);
  });

  it('take() fails on a failed or missing section; exitOf() reports a failure without throwing', () => {
    const r = helperResult(
      [
        { tag: 'a', exit: 0, out: 'ok' },
        { tag: 'b', exit: 128, out: '' },
      ],
      '\nfatal: not a git repository\n',
    );
    expect(r.take('a')).toBe('ok');
    expect(() => r.take('b')).toThrow('git b failed (exit 128): fatal: not a git repository');
    expect(r.exitOf('b')).toBe(128);
    expect(() => r.exitOf('c')).toThrow(/no 'c' section/);
  });

  it('nextForkSlot gives each fork its own event-loop turn: work queued after slot A runs before slot B', async () => {
    const order: string[] = [];
    const a = nextForkSlot().then(() => {
      order.push('a');
      setImmediate(() => order.push('turn-after-a'));
    });
    const b = nextForkSlot().then(() => order.push('b'));
    await Promise.all([a, b]);
    // independent setImmediate slots would run a and b in the same check phase: [a, b, turn-after-a]
    expect(order).toEqual(['a', 'turn-after-a', 'b']);
  });

  it('contiguousChunks keeps order, never exceeds the part count, and handles empty input', () => {
    expect(contiguousChunks([1, 2, 3, 4, 5, 6], 3)).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(contiguousChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2, 3], [4, 5]]);
    expect(contiguousChunks([1, 2], 4)).toEqual([[1], [2]]);
    expect(contiguousChunks([], 4)).toEqual([]);
    expect(contiguousChunks([1, 2], 0)).toEqual([[1, 2]]);
  });

  describe('host spawn count', () => {
    const SHA = 'b'.repeat(40);
    let binDir: string;
    let savedPath: string | undefined;
    beforeEach(() => {
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-spawns-'));
      const subs = Array.from({ length: 30 }, (_, i) => ` ${SHA} sub/s${i} (heads/main)`).join('\n');
      fs.writeFileSync(path.join(binDir, 'subs.txt'), subs + '\n');
      // `sh` on PATH logs every HOST spawn of a helper, then hands over to the real shell.
      fs.writeFileSync(
        path.join(binDir, 'sh'),
        `#!/bin/sh\necho sh >> '${path.join(binDir, 'host.log')}'\nexec /bin/sh "$@"\n`,
        { mode: 0o755 },
      );
      fs.writeFileSync(
        path.join(binDir, 'git'),
        [
          '#!/bin/sh',
          `echo git >> '${path.join(binDir, 'git.log')}'`,
          'case "$*" in',
          `  *"submodule status"*) cat '${path.join(binDir, 'subs.txt')}' ;;`,
          `  *"rev-parse HEAD"*) echo ${SHA} ;;`,
          '  *"for-each-ref"*) echo refs/heads/staging ;;',
          '  *"--ignore-submodules=all"*) case "$*" in *"/s7 "*) printf "? new.ts\\000" ;; esac ;;',
          'esac',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      savedPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    });
    afterEach(() => {
      process.env.PATH = savedPath;
      fs.rmSync(binDir, { recursive: true, force: true });
    });
    const lines = (f: string) => fs.readFileSync(path.join(binDir, f), 'utf8').split('\n').filter(Boolean).length;

    it('forks the host once per helper, not once per git call: 30 submodules cost 2 host spawns', async () => {
      const result = await inspectAuthoredWork(path.join(binDir, 'tree'), path.join(binDir, 'canon'), VERSION_PATHS);
      expect(result).toEqual({ ok: true, authored: ['sub/s7/new.ts'], machineWritten: 0 });
      // positive control: the git work itself still happened, 4 top-level + 2 per submodule
      expect(lines('git.log')).toBe(4 + 2 * 30);
      expect(lines('host.log')).toBe(2);
    });

    it('a width of 3 costs exactly 3 submodule helpers', async () => {
      await inspectAuthoredWork(path.join(binDir, 'tree'), path.join(binDir, 'canon'), VERSION_PATHS, {
        submoduleConcurrency: 3,
      });
      expect(lines('host.log')).toBe(1 + 3);
    });
  });

  it('reads a REAL submodule through the helper, including a path with a newline in it', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-realsub-')));
    try {
      const lib = path.join(tmp, 'lib');
      const canon = path.join(tmp, 'canon');
      const commit = (cwd: string, m: string) =>
        g(cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', m);
      for (const r of [lib, canon]) {
        fs.mkdirSync(r);
        g(r, 'init', '-q', '-b', 'staging');
      }
      commit(lib, 'lib root');
      g(canon, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'libs/x');
      commit(canon, 'add sub');
      const tree = path.join(tmp, 'tree');
      g(canon, 'worktree', 'add', '-q', '--detach', tree);
      g(tree, '-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init');
      fs.writeFileSync(path.join(tree, 'libs/x', 'we ird\nname.ts'), 'x');
      const clean = await inspectAuthoredWork(canon, canon, VERSION_PATHS);
      expect(clean).toEqual({ ok: true, authored: [], machineWritten: 0 });
      const dirty = await inspectAuthoredWork(tree, canon, VERSION_PATHS);
      expect(dirty).toEqual({ ok: true, authored: ['libs/x/we ird\nname.ts'], machineWritten: 0 });
      // a submodule commit the canonical checkout lacks is authored work
      commit(path.join(tree, 'libs/x'), 'local only');
      const local = g(path.join(tree, 'libs/x'), 'rev-parse', 'HEAD');
      const ahead = await inspectAuthoredWork(tree, canon, VERSION_PATHS);
      expect(ahead.ok && ahead.authored).toContain(`libs/x@${local.slice(0, 10)} (commit absent from canonical checkout)`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
