import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { minimatch } from 'minimatch';
import { execFileSync } from 'node:child_process';

// WI-10005353: count every pattern compile the code under test performs, through
// either minimatch entry point, so the "compile once per distinct pattern" guard
// below cannot be dodged by switching back to per-call `minimatch()`.
const mmCount = vi.hoisted(() => ({ compiles: 0 }));
vi.mock('minimatch', async (importOriginal) => {
  const mod = await importOriginal<typeof import('minimatch')>();
  class CountingMinimatch extends mod.Minimatch {
    constructor(...args: ConstructorParameters<typeof mod.Minimatch>) {
      super(...args);
      mmCount.compiles++;
    }
  }
  const countingMinimatch = Object.assign(
    (...args: Parameters<typeof mod.minimatch>) => {
      mmCount.compiles++;
      return mod.minimatch(...args);
    },
    mod.minimatch,
  );
  return { ...mod, Minimatch: CountingMinimatch, minimatch: countingMinimatch };
});
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  anchorMatchesChanged,
  createAnchorMatcher,
  classifyDrift,
  sweepHarnessDocs,
  baselineFor,
  stewardBackoffMs,
  dispatchDue,
  STEWARD_RETRY_BASE_MS,
  STEWARD_MAX_ATTEMPTS,
  type DocStore,
} from './freshness-sweep';
import type { GitRunner } from './subject-ref';
import type { HarnessDocRecord, DocStatus } from './doc-record';

const runGit: GitRunner = (args, cwd) => {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      killSignal: 'SIGKILL',
    });
    return Promise.resolve({ code: 0, stdout, stderr: '' });
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return Promise.resolve({ code: err.status ?? -1, stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? '') });
  }
};

describe('anchorMatchesChanged', () => {
  it('matches a glob anchor', () => {
    expect(anchorMatchesChanged(['src/**'], ['src/a/b.ts'])).toBe(true);
    expect(anchorMatchesChanged(['src/**'], ['lib/x.ts'])).toBe(false);
  });
  it('matches an exact file anchor', () => {
    expect(anchorMatchesChanged(['src/a.ts'], ['src/a.ts'])).toBe(true);
  });
  it('matches a directory anchor against files under it', () => {
    expect(anchorMatchesChanged(['src/dir'], ['src/dir/x.ts'])).toBe(true);
  });
  it('no match on empty inputs', () => {
    expect(anchorMatchesChanged([], ['x'])).toBe(false);
    expect(anchorMatchesChanged(['x'], [])).toBe(false);
  });
});

// The pre-WI-10005353 implementation, kept verbatim as the semantic reference.
function legacyAnchorMatchesChanged(anchorPaths: string[], changedPaths: string[]): boolean {
  if (!anchorPaths.length || !changedPaths.length) return false;
  for (const anchor of anchorPaths) {
    const a = anchor.replace(/\/+$/, '');
    if (!a) continue;
    const isGlob = /[*?[\]{}()!+@]/.test(a);
    const patterns = isGlob ? [a] : [a, `${a}/**`];
    for (const changed of changedPaths) {
      for (const pat of patterns) {
        if (minimatch(changed, pat, { dot: true })) return true;
      }
    }
  }
  return false;
}

describe('anchorMatchesChanged — indexed matcher (WI-10005353)', () => {
  const anchors = [
    'src/a.ts', 'src/dir', 'src/dir/', 'src/**', '*.md', 'docs/*.md',
    'apps/operator/app/cupboard/[id]/ThemeInstall.tsx', '#notes', './src', 'a//b', 'a\\b',
    '{lib,src}/x.ts', '.github', '.github/workflows', 'src/.hidden', 'lib/x(1).ts', 'x', '', '/',
  ];
  const changed = [
    'src/a.ts', 'src/dir/x.ts', 'src/dir/.env', 'src/dirx/y.ts', 'README.md', 'docs/guide.md',
    'docs/sub/guide.md', 'apps/operator/app/cupboard/i/ThemeInstall.tsx',
    'apps/operator/app/cupboard/[id]/ThemeInstall.tsx', '#notes', 'src', 'a/b/c', 'a//b/c',
    '/abs/src/a.ts', 'src/dir/', 'lib/x.ts', '.github/workflows/ci.yml', 'src/.hidden/f',
    'lib/x(1).ts', 'x', 'xy', 'a\\b', 'src/./a.ts',
  ];

  it('agrees with per-call minimatch for every anchor × changed path, singly and together', () => {
    for (const anchor of anchors) {
      for (const c of changed) {
        expect([anchor, c, anchorMatchesChanged([anchor], [c])])
          .toEqual([anchor, c, legacyAnchorMatchesChanged([anchor], [c])]);
      }
      expect([anchor, anchorMatchesChanged([anchor], changed)])
        .toEqual([anchor, legacyAnchorMatchesChanged([anchor], changed)]);
    }
    // calibration: the corpus exercises both verdicts
    expect(anchors.filter((a) => legacyAnchorMatchesChanged([a], changed)).length).toBeGreaterThan(5);
    expect(anchors.filter((a) => !legacyAnchorMatchesChanged([a], changed)).length).toBeGreaterThan(3);
  });

  it('compiles each distinct glob pattern once, and plain anchors never, however many paths changed', () => {
    const plain = Array.from({ length: 300 }, (_, i) => (i % 2 ? `pkg${i}/src` : `pkg${i}/lib/file${i}.ts`));
    const globs = ['docs/**/*.md', 'apps/*/x.tsx'];
    const paths = Array.from({ length: 5000 }, (_, i) => `other/area${i % 50}/f${i}.ts`);
    mmCount.compiles = 0;
    const matcher = createAnchorMatcher(paths);
    for (let doc = 0; doc < 50; doc++) expect(matcher(plain)).toBe(false);
    expect(mmCount.compiles).toBe(0);
    for (let doc = 0; doc < 50; doc++) expect(matcher([...plain, ...globs])).toBe(false);
    expect(mmCount.compiles).toBe(globs.length);
    expect(matcher(['pkg7/src'])).toBe(false);
    expect(createAnchorMatcher([...paths, 'pkg7/src/deep/a.ts'])(plain)).toBe(true);
  });

  it('sweepHarnessDocs builds the changed-path index once for all docs (no per-doc compiles)', async () => {
    const records = Array.from({ length: 200 }, (_, i) => ({
      docId: `doc-${i}`,
      status: 'fresh',
      subjectRef: [{ kind: 'path', path: `pkg${i}/src` }],
      anchorPaths: [`pkg${i}/src`, `pkg${i}/README.md`],
    })) as unknown as HarnessDocRecord[];
    const store = { load: async () => records } as unknown as DocStore;
    mmCount.compiles = 0;
    const r = await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: '/nonexistent', runGit,
      changedPaths: Array.from({ length: 3000 }, (_, i) => `unrelated/d${i % 30}/f${i}.ts`),
      store,
    });
    expect(r.candidates).toBe(0);
    expect(mmCount.compiles).toBe(0);
  });
});

describe('classifyDrift (pure)', () => {
  const gen = { source: 'generated' as const, subjectRef: [{ kind: 'path' as const, globs: ['x'] }] };
  const man = { source: 'manual' as const, subjectRef: [{ kind: 'path' as const, globs: ['x'] }] };
  it('untracked when no subject ref', () => {
    expect(classifyDrift({ source: 'manual', subjectRef: [] }, { stale: false, changedPaths: [], method: 'none' }).status).toBe('untracked');
  });
  it('no-baseline → review', () => {
    expect(classifyDrift(man, { stale: false, changedPaths: [], method: 'none', error: 'no-baseline' }).status).toBe('review');
  });
  it('git error → unknown', () => {
    expect(classifyDrift(gen, { stale: false, changedPaths: [], method: 'path', error: 'git-error: boom' }).status).toBe('unknown');
  });
  it('stale generated → stale; stale manual → review', () => {
    expect(classifyDrift(gen, { stale: true, changedPaths: ['x'], method: 'path' }).status).toBe('stale');
    expect(classifyDrift(man, { stale: true, changedPaths: ['x'], method: 'path' }).status).toBe('review');
  });
  it('not stale → fresh', () => {
    expect(classifyDrift(gen, { stale: false, changedPaths: [], method: 'path' }).status).toBe('fresh');
  });
});

describe('baselineFor', () => {
  it('uses lastVerifiedSha for manual, generatedFromSha otherwise', () => {
    expect(baselineFor({ source: 'manual', lastVerifiedSha: 'v', generatedFromSha: 'g' })).toBe('v');
    expect(baselineFor({ source: 'generated', lastVerifiedSha: 'v', generatedFromSha: 'g' })).toBe('g');
    expect(baselineFor({ source: 'augmented', lastVerifiedSha: 'v', generatedFromSha: 'g' })).toBe('g');
  });
});

// ---- sweep against a real fixture repo + in-memory store ----

let repo: string;
const shas: Record<string, string> = {};
function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    timeout: 30_000,
    killSignal: 'SIGKILL',
  }).trim();
}
function commitAll(msg: string): string {
  git(['add', '-A']);
  git(['commit', '-q', '-m', msg]);
  return git(['rev-parse', 'HEAD']);
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'sweep-fixture-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@p.dev']);
  git(['config', 'user.name', 'T']);
  git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/gen.ts'), 'export const g = 1;\n');
  writeFileSync(join(repo, 'src/man.ts'), 'export const m = 1;\n');
  writeFileSync(join(repo, 'src/stable.ts'), 'export const s = 1;\n');
  shas.c0 = commitAll('c0');
  writeFileSync(join(repo, 'src/gen.ts'), 'export const g = 2;\n');
  writeFileSync(join(repo, 'src/man.ts'), 'export const m = 2;\n');
  shas.c1 = commitAll('c1 touch gen + man');
});
afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

function rec(partial: Partial<HarnessDocRecord> & Pick<HarnessDocRecord, 'docId' | 'source'>): HarnessDocRecord {
  return {
    workspaceId: 'ws', harnessSlug: 'h', subjectRef: [], anchorPaths: [],
    generatedFromSha: null, lastVerifiedSha: null, lastVerifiedAt: null, overlay: null,
    status: 'fresh', statusDetail: null, statusCheckedAt: null, regenEnqueuedAt: null,
    reverifyFlaggedAt: null, regenAttempts: 0, reverifyAttempts: 0,
    title: null, createdAt: '', updatedAt: '', ...partial,
  };
}

// Mirrors the PG DocStore semantics (mig 386 + WI-1661): `touchRegen`/`touchReverify`
// bump ONLY the retry-clock latch timestamp — NOT the attempt counter (spending an
// attempt is now the sweep-after-sync.ts caller's job, gated on a CONFIRMED doc-steward
// dispatch, so it's exercised in sweep-after-sync's own tests, not here). Returning to
// `fresh` still clears both. `stampAt` lets a test control the latch clock so the
// backoff is actually exercised.
function memStore(
  records: HarnessDocRecord[],
  stampAt: () => string = () => new Date().toISOString(),
): DocStore & { records: HarnessDocRecord[] } {
  const byId = new Map(records.map((r) => [r.docId, r]));
  return {
    records,
    load: async () => [...byId.values()],
    setStatus: async (docId, status: DocStatus, detail) => {
      const r = byId.get(docId)!;
      r.status = status;
      r.statusDetail = detail;
      if (status === 'fresh') {
        r.regenEnqueuedAt = null; r.reverifyFlaggedAt = null;
        r.regenAttempts = 0; r.reverifyAttempts = 0;
      }
    },
    touchRegen: async (docId) => { const r = byId.get(docId)!; r.regenEnqueuedAt = stampAt(); },
    touchReverify: async (docId) => { const r = byId.get(docId)!; r.reverifyFlaggedAt = stampAt(); },
  };
}

describe('sweepHarnessDocs', () => {
  it('flips a generated doc to stale + enqueues regen when its path changed', async () => {
    const records = [
      rec({ docId: 'features/F-1.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/gen.ts'] }], anchorPaths: ['src/gen.ts'], generatedFromSha: shas.c0 }),
    ];
    const store = memStore(records);
    const regen: string[] = [];
    const r = await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/gen.ts'], store,
      onRegenNeeded: (d) => { regen.push(d.docId); },
    });
    expect(r.flippedStale).toBe(1);
    expect(r.regenEnqueued).toEqual(['features/F-1.md']);
    expect(regen).toEqual(['features/F-1.md']);
    expect(store.records[0].status).toBe('stale');
    expect(store.records[0].regenEnqueuedAt).toBeTruthy(); // retry-clock touched
    // WI-1661: the sweep itself never SPENDS an attempt — only the caller does, once a
    // doc-steward dispatch is confirmed (see sweep-after-sync.ts). Stays 0 here.
    expect(store.records[0].regenAttempts).toBe(0);
  });

  it('flips a manual doc to review + flags re-verify; idempotent on re-run', async () => {
    const records = [
      rec({ docId: 'm.md', source: 'manual', subjectRef: [{ kind: 'path', globs: ['src/man.ts'] }], anchorPaths: ['src/man.ts'], lastVerifiedSha: shas.c0 }),
    ];
    const store = memStore(records);
    const reverify: string[] = [];
    const opts = {
      harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/man.ts'], store,
      onReverifyNeeded: (d: HarnessDocRecord) => { reverify.push(d.docId); },
    };
    const r1 = await sweepHarnessDocs(opts);
    expect(r1.reverifyFlagged).toEqual(['m.md']);
    expect(store.records[0].status).toBe('review');
    // Re-run: still review, but NOT re-flagged (idempotent close-the-loop).
    const r2 = await sweepHarnessDocs(opts);
    expect(r2.reverifyFlagged).toEqual([]);
    expect(reverify).toEqual(['m.md']); // callback fired exactly once
  });

  it('skips unanchored docs and docs the changed paths did not touch', async () => {
    const records = [
      rec({ docId: 'unanchored.md', source: 'manual', subjectRef: [], anchorPaths: [] }),
      rec({ docId: 'stable.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/stable.ts'] }], anchorPaths: ['src/stable.ts'], generatedFromSha: shas.c0, status: 'fresh' }),
    ];
    const store = memStore(records);
    const r = await sweepHarnessDocs({ harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/gen.ts'], store });
    // Neither is a candidate: unanchored skipped; stable's anchor not in changed paths.
    expect(r.candidates).toBe(0);
    expect(store.records[1].status).toBe('fresh');
  });

  it('recompute-all mode (no changedPaths) checks every anchored doc', async () => {
    const records = [
      rec({ docId: 'g.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/gen.ts'] }], anchorPaths: ['src/gen.ts'], generatedFromSha: shas.c0 }),
      rec({ docId: 'stable.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/stable.ts'] }], anchorPaths: ['src/stable.ts'], generatedFromSha: shas.c0 }),
    ];
    const store = memStore(records);
    const r = await sweepHarnessDocs({ harnessSlug: 'h', repoRoot: repo, runGit, store });
    expect(r.candidates).toBe(2);
    expect(store.records.find((x) => x.docId === 'g.md')!.status).toBe('stale');
    expect(store.records.find((x) => x.docId === 'stable.md')!.status).toBe('fresh');
  });
});

// ── doc-steward retry: backoff + give-up cap + stuck re-dispatch (mig 386) ──────
describe('steward retry policy (pure)', () => {
  it('stewardBackoffMs grows exponentially from the base and caps', () => {
    expect(stewardBackoffMs(1)).toBe(STEWARD_RETRY_BASE_MS); // first retry = base
    expect(stewardBackoffMs(2)).toBe(STEWARD_RETRY_BASE_MS * 2);
    expect(stewardBackoffMs(3)).toBe(STEWARD_RETRY_BASE_MS * 4);
    expect(stewardBackoffMs(99)).toBe(6 * 60 * 60_000); // capped at 6h
  });
  it('dispatchDue: first episode → yes; within backoff → no; past backoff → yes; capped → no', () => {
    const t = 10_000_000_000;
    expect(dispatchDue(null, 0, t)).toBe(true); // never dispatched
    const recent = new Date(t - 60_000).toISOString(); // 1min ago
    expect(dispatchDue(recent, 1, t)).toBe(false); // < 30min backoff
    const old = new Date(t - STEWARD_RETRY_BASE_MS - 1).toISOString();
    expect(dispatchDue(old, 1, t)).toBe(true); // past backoff
    expect(dispatchDue(old, STEWARD_MAX_ATTEMPTS, t)).toBe(false); // gave up
  });
});

describe('sweepHarnessDocs — steward retry', () => {
  it('re-dispatches a stuck review doc once the backoff elapses (the no-retry-latch bug fix)', async () => {
    const t = 10_000_000_000;
    const longAgo = new Date(t - STEWARD_RETRY_BASE_MS - 1).toISOString();
    const records = [
      // Already flagged review from a prior sweep; steward died (never verified) →
      // still review, latch set, 1 attempt, anchor NOT in this tick's changed paths.
      rec({
        docId: 'm.md', source: 'manual', subjectRef: [{ kind: 'path', globs: ['src/man.ts'] }],
        anchorPaths: ['src/man.ts'], lastVerifiedSha: shas.c0,
        status: 'review', statusDetail: 'code changed: src/man.ts',
        reverifyFlaggedAt: longAgo, reverifyAttempts: 1,
      }),
    ];
    const store = memStore(records);
    const reverify: string[] = [];
    const r = await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, now: t,
      changedPaths: ['src/unrelated.ts'], // does NOT touch m.md's anchor
      store, onReverifyNeeded: (d) => { reverify.push(d.docId); },
    });
    expect(r.candidates).toBe(1); // re-considered via the retry leg despite no anchor hit
    expect(reverify).toEqual(['m.md']); // re-batched for dispatch
    expect(store.records[0].reverifyFlaggedAt).not.toBe(longAgo); // retry-clock touched
    // WI-1661: the sweep only touches the clock — it does NOT spend the attempt (that's
    // the caller's job, gated on a CONFIRMED doc-steward dispatch), so this stays at the
    // seeded 1 rather than bumping to 2.
    expect(store.records[0].reverifyAttempts).toBe(1);
  });

  it('does NOT re-dispatch while still inside the backoff window', async () => {
    const t = 10_000_000_000;
    const recent = new Date(t - 60_000).toISOString(); // 1min ago « 30min backoff
    const records = [
      rec({
        docId: 'm.md', source: 'manual', subjectRef: [{ kind: 'path', globs: ['src/man.ts'] }],
        anchorPaths: ['src/man.ts'], lastVerifiedSha: shas.c0,
        status: 'review', reverifyFlaggedAt: recent, reverifyAttempts: 1,
      }),
    ];
    const store = memStore(records);
    const reverify: string[] = [];
    const r = await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, now: t,
      changedPaths: ['src/unrelated.ts'], store, onReverifyNeeded: (d) => { reverify.push(d.docId); },
    });
    expect(r.candidates).toBe(0); // not yet due → not even re-considered
    expect(reverify).toEqual([]);
    expect(store.records[0].reverifyAttempts).toBe(1);
  });

  it('gives up after the attempt cap: no re-dispatch + a visible give-up status_detail', async () => {
    const t = 10_000_000_000;
    const longAgo = new Date(t - STEWARD_RETRY_BASE_MS * 1000).toISOString();
    const records = [
      rec({
        docId: 'm.md', source: 'manual', subjectRef: [{ kind: 'path', globs: ['src/man.ts'] }],
        anchorPaths: ['src/man.ts'], lastVerifiedSha: shas.c0,
        status: 'review', reverifyFlaggedAt: longAgo, reverifyAttempts: STEWARD_MAX_ATTEMPTS,
      }),
    ];
    const store = memStore(records);
    const reverify: string[] = [];
    // Anchor IS in changed paths, so it's a candidate regardless — proves the cap
    // (not the candidate filter) is what stops the dispatch.
    const r = await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, now: t,
      changedPaths: ['src/man.ts'], store, onReverifyNeeded: (d) => { reverify.push(d.docId); },
    });
    expect(reverify).toEqual([]); // capped → no further dispatch
    expect(store.records[0].reverifyAttempts).toBe(STEWARD_MAX_ATTEMPTS); // not bumped past cap
    expect(store.records[0].statusDetail).toContain('gave up after');
    expect(store.records[0].statusDetail).toContain('harness_docs:verify');
  });

  it('returning to fresh clears the latch + attempts so a future drift re-dispatches', async () => {
    // A generated doc whose baseline is current HEAD → recompute fresh; any leftover
    // regen latch/attempts from a prior healed episode must be cleared.
    const headNow = git(['rev-parse', 'HEAD']);
    const records = [
      rec({
        docId: 'g.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/gen.ts'] }],
        anchorPaths: ['src/gen.ts'], generatedFromSha: headNow,
        status: 'stale', regenEnqueuedAt: new Date().toISOString(), regenAttempts: 3,
      }),
    ];
    const store = memStore(records);
    await sweepHarnessDocs({ harnessSlug: 'h', repoRoot: repo, runGit, store });
    expect(store.records[0].status).toBe('fresh');
    expect(store.records[0].regenEnqueuedAt).toBeNull();
    expect(store.records[0].regenAttempts).toBe(0);
  });
});

// ── WI-2007: the drift callbacks carry a `becameDrifted` transition flag so a caller can
// EDGE-TRIGGER the '*' broadcast on NEW drift while still driving the steward retry off
// every due re-fire. true on the fresh→drift transition; false on a retry re-confirm of an
// already-drifted doc (the ~30min re-fire that was re-announcing the standing backlog). ──
describe('sweepHarnessDocs — becameDrifted transition flag (WI-2007)', () => {
  it('passes becameDrifted=true when a manual doc first transitions fresh→review', async () => {
    const records = [
      rec({ docId: 'm.md', source: 'manual', subjectRef: [{ kind: 'path', globs: ['src/man.ts'] }], anchorPaths: ['src/man.ts'], lastVerifiedSha: shas.c0 }),
    ];
    const store = memStore(records);
    const flags: boolean[] = [];
    await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/man.ts'], store,
      onReverifyNeeded: (_d, _detail, becameDrifted) => { flags.push(becameDrifted); },
    });
    expect(flags).toEqual([true]); // the fresh→review edge
  });

  it('passes becameDrifted=true when a generated doc first transitions fresh→stale', async () => {
    const records = [
      rec({ docId: 'features/F-1.md', source: 'generated', subjectRef: [{ kind: 'path', globs: ['src/gen.ts'] }], anchorPaths: ['src/gen.ts'], generatedFromSha: shas.c0 }),
    ];
    const store = memStore(records);
    const flags: boolean[] = [];
    await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, changedPaths: ['src/gen.ts'], store,
      onRegenNeeded: (_d, _detail, becameDrifted) => { flags.push(becameDrifted); },
    });
    expect(flags).toEqual([true]); // the fresh→stale edge
  });

  it('passes becameDrifted=false on a retry re-confirm of an already-drifted doc (the ~30min re-fire)', async () => {
    const t = 10_000_000_000;
    const longAgo = new Date(t - STEWARD_RETRY_BASE_MS - 1).toISOString();
    const records = [
      // Already review from a prior sweep; steward never healed it → the retry leg re-fires,
      // but this is NOT a new transition — the '*' broadcast must NOT re-announce it.
      rec({
        docId: 'm.md', source: 'manual', subjectRef: [{ kind: 'path', globs: ['src/man.ts'] }],
        anchorPaths: ['src/man.ts'], lastVerifiedSha: shas.c0,
        status: 'review', statusDetail: 'code changed: src/man.ts',
        reverifyFlaggedAt: longAgo, reverifyAttempts: 1,
      }),
    ];
    const store = memStore(records);
    const flags: boolean[] = [];
    const r = await sweepHarnessDocs({
      harnessSlug: 'h', repoRoot: repo, runGit, now: t,
      changedPaths: ['src/unrelated.ts'], // retry leg, not an anchor hit
      store, onReverifyNeeded: (_d, _detail, becameDrifted) => { flags.push(becameDrifted); },
    });
    expect(r.candidates).toBe(1); // still re-dispatched to the steward (retry cadence intact)
    expect(flags).toEqual([false]); // ...but flagged NOT-new → stays out of the '*' broadcast
  });
});
