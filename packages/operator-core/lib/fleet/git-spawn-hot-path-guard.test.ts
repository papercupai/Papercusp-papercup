import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * RECURRENCE GUARD for EI-18808838427010743 — the fork tax.
 *
 * ## The bug class
 *
 * `fork()` copies the calling process's page tables, so `child_process.spawn`
 * costs the CALLER ~40ms per GB of its OWN RSS, charged as synchronous system
 * time on the main thread. The bg-host runs at ~4GB, so every `git` forked from
 * it blocked the event loop ~165ms for a command git finishes in ~4ms. That
 * dead loop is what killed p2p peer sockets mid-transfer
 * (EI-18808621019872598): UDX keepalives and timers cannot fire while the loop
 * is blocked, so a multi-GB pot repo could never converge.
 *
 * ## Why a guard, and why THIS guard
 *
 * Nothing FAILS when a git seam forks locally — it just silently gets slow, and
 * the damage lands in a different subsystem (p2p transfers) than the code that
 * caused it. Silent performance regressions do not announce themselves, and
 * this one was invisible to every JS-level metric because the cost is kernel
 * time inside one synchronous call.
 *
 * The repo has ~80 `spawn('git')` sites, but the overwhelming majority are
 * one-shot CLI/gym/bootstrap paths where a single fork's cost is irrelevant. A
 * blanket ban would be pure noise and would rot into a suppressed lint. What
 * actually matters is narrow and stable: modules that run INSIDE the
 * long-lived host on a REPEATING path. Those are enumerated below, each one
 * confirmed by CPU-profile attribution on the live bg-host, and each must route
 * through the shared `fleet/git-via-sidecar` helper.
 *
 * Adding a git call to one of these modules without routing it is the exact
 * regression this catches. If a module genuinely stops being hot, remove it
 * here with a note — don't silently weaken the assertion.
 */

const LIB = join(import.meta.dirname, '..');

/** Modules that run in the long-lived host on a repeating path. */
const HOT_GIT_MODULES: { file: string; why: string }[] = [
  {
    file: 'sync/pot-git/storage.ts',
    why: 'pot-git reads refs one git-process-per-ref; callers loop over them (was 51.8% of the main thread)',
  },
  {
    file: 'harness/docs/git-runner.ts',
    why: 'the shared harness-docs GitRunner — drift `git log --name-only` per (baseline, submodule) group per doc',
  },
  {
    file: 'dev-deploy-state.ts',
    why: 'sits behind a UI-POLLED sync query and fans out to ~6 git execs per poll (2.24% of the main thread)',
  },
  {
    file: 'git-pipeline-hives.ts',
    why: 'revListCount runs per hive row inside the pipeline snapshot (0.62% of the main thread)',
  },
  {
    file: 'agent-tools/plans/committed-tree-reader.ts',
    why: 'uncached committed-blob reads fork git on operator handlers; the 2026-10-07 stall profile attributed 96.4% of samples to defaultBlobBatchReader',
  },
];

describe('hot-path git seams route through the spawner sidecar', () => {
  for (const { file, why } of HOT_GIT_MODULES) {
    it(`${file} imports the shared git-via-sidecar helper — ${why}`, () => {
      const src = readFileSync(join(LIB, file), 'utf8');
      expect(
        /from\s+['"][^'"]*fleet\/git-via-sidecar['"]/.test(src),
        `${file} runs in the long-lived host but does not import fleet/git-via-sidecar. ` +
          `Forking git from the ~4GB bg-host blocks the event loop ~165ms per call and ` +
          `kills p2p transfers. Route it through runGitViaSpawnerSidecar with a local fallback.`,
      ).toBe(true);
    });

    it(`${file} retains an explicit local route without fabricating Git results`, () => {
      const src = readFileSync(join(LIB, file), 'utf8');
      // Keep deliberate disabled/cold execution available. Enabled blob-reader
      // failures must reject before this path; committed-tree-reader-sidecar-route
      // tests enforce that with timeout, infrastructure, and cold-read controls.
      expect(
        /spawn\(\s*['"]git['"]|execFile\(\s*['"]git['"]|pexec\(\s*['"]git['"]/.test(src),
        `${file} routes git through the sidecar but has no local fallback path. ` +
          `Preserve explicit disabled-mode execution and exact error/result identity.`,
      ).toBe(true);
    });
  }

  it('the shared helper never caches a FAILED module load', () => {
    // A cached rejected promise would pin every future call onto the local
    // fallback for the process's whole life after one transient hiccup —
    // reintroducing the full fork tax silently and permanently.
    const src = readFileSync(join(LIB, 'fleet/git-via-sidecar.ts'), 'utf8');
    expect(src).toMatch(/sidecarModulesPromise\s*=\s*null/);
  });

  it('the shared helper memoises its dynamic imports', () => {
    // Under tsx every dynamic import() blocks on a SYNCHRONOUS ESM
    // loader-thread round-trip (makeSyncRequest). Re-importing per git call
    // would hand back a slice of the very stall this module removes.
    const src = readFileSync(join(LIB, 'fleet/git-via-sidecar.ts'), 'utf8');
    expect(src).toMatch(/if\s*\(!sidecarModulesPromise\)/);
  });
});

/**
 * ── The OCCURRENCE-granular half (WI-6727) ──────────────────────────────────
 *
 * The assertions above are FILE-granular: "this module imports the helper".
 * That is necessary but demonstrably not sufficient, and the gap cost a real
 * regression (WI-6404).
 *
 * `sync/pot-git/storage.ts` is in HOT_GIT_MODULES and DOES import
 * git-via-sidecar — for `defaultRunGit`. So every assertion above stayed GREEN
 * for five days while `defaultRunGitStdin`, ~50 lines below it in the SAME
 * FILE, called raw `spawn('git')` on the seam a CPU profile then put at the TOP
 * of the host's remaining spawn attribution (~2.45%). A file-level import check
 * cannot see a SECOND, unconverted seam in a file that already imports the
 * helper — and worse, its green actively suppressed suspicion.
 *
 * Three more private raw-spawn copies (publish-guard, chunked-blob-scan,
 * foreign-mirror-quarantine) were invisible for the same reason: they were not
 * listed at all, despite the profile naming two of them.
 *
 * So this half inverts the question. Instead of "does the file import the
 * helper?", it asks **"is every raw git spawn in the hot set one we
 * deliberately allow?"** — resolved per OCCURRENCE to its enclosing top-level
 * symbol. Adding an unrouted git call to an already-routed file now reds here,
 * which is exactly the case the half above cannot catch.
 *
 * ⚠ Note why the listed modules could NOT simply be appended to
 * HOT_GIT_MODULES: that block's second assertion requires each listed module to
 * contain its OWN local `spawn('git')` fallback. Once a seam is SHARED, the
 * delegating modules correctly have no local fallback of their own (it lives in
 * storage.ts), so listing them there would fail a check they are right to fail.
 * Two different questions, two different shapes.
 */

/** Files that run inside the long-lived host and touch git. Deliberately a
 *  NAMED set, not a tree walk: the repo has ~80 `spawn('git')` sites and a
 *  blanket ban would be noise that rots into a suppressed lint. */
const HOT_GIT_SCAN_FILES: string[] = [
  // Own a local fallback (the four originally-profiled hot modules).
  'sync/pot-git/storage.ts',
  'harness/docs/git-runner.ts',
  'dev-deploy-state.ts',
  'git-pipeline-hives.ts',
  'agent-tools/plans/committed-tree-reader.ts',
  'harness/git-sync/run-git-sync.ts',
  // DELEGATE to a shared seam and must therefore contain NO raw git spawn at
  // all. These are the three that silently kept private copies (WI-6404), plus
  // the one caller that always used the shared seam.
  'sync/pot-git/publish-guard.ts',
  'sync/pot-git/chunked-blob-scan.ts',
  'sync/pot-git/foreign-mirror-quarantine.ts',
  'sync/pot-git/github-egress.ts',
  // Streaming seam — see its allowlist entry.
  'sync/pot-git/fetch-transport.ts',
  // Completion-settlement reads, run by the git-sync reconciler on bg-host every
  // pass (jev-memory-timeouts-to-zero-2026-10-01: ~8 forks/s traced, ~54 ms each).
  'agent-tools/work_items/untouched-paths.ts',
];

/** Every raw git invocation ALLOWED in the hot set, keyed by the top-level
 *  symbol that owns it. Anything else in HOT_GIT_SCAN_FILES is a regression. */
const ALLOWED_RAW_GIT: { file: string; symbol: string; why: string }[] = [
  {
    file: 'sync/pot-git/storage.ts',
    symbol: 'runGitLocal',
    why: 'the exported local fallback behind defaultRunGit — a sidecar fault must degrade perf, not correctness',
  },
  {
    file: 'sync/pot-git/storage.ts',
    symbol: 'runGitStdinLocal',
    why: 'the exported local fallback behind defaultRunGitStdin (WI-6404)',
  },
  {
    file: 'sync/pot-git/fetch-transport.ts',
    symbol: 'serveUploadPackUnmanaged',
    why: 'git upload-pack is a BIDIRECTIONAL STREAMING protocol (duplex.pipe(child.stdin)), not a batch invocation — it cannot ride a request/response RPC or an fd handoff. Routing it needs a socket-passing design; tracked separately, not silently tolerated.',
  },
  {
    file: 'harness/docs/git-runner.ts',
    symbol: 'runGitLocal',
    why: 'the local fallback for the harness-docs GitRunner',
  },
  { file: 'dev-deploy-state.ts', symbol: 'git', why: 'the local fallback for the deploy-state reader' },
  {
    file: 'dev-deploy-state.ts',
    symbol: 'gitToplevel',
    why:
      'execFileSync — a SYNCHRONOUS fork, which blocks the loop for the whole child, not just the fork. ' +
      'Exempt ONLY because it is memoised to once per process AND its signature is synchronous (callers ' +
      'take a string, so it cannot ride an async RPC without rippling). The memoisation is what makes this ' +
      'safe, so it is asserted separately below rather than trusted.',
  },
  {
    file: 'agent-tools/plans/committed-tree-reader.ts',
    symbol: 'defaultBlobBatchReader',
    why: 'binary cat-file only when the sidecar route is disabled; enabled timeout/infrastructure failures reject before local spawn, enforced by committed-tree-reader-sidecar-route.test.ts',
  },
  {
    file: 'git-pipeline-hives.ts',
    symbol: 'revListCountLocal',
    why: 'the local fallback for the per-hive rev-list count',
  },
  {
    file: 'agent-tools/work_items/untouched-paths.ts',
    symbol: 'streamGitFieldsLocal',
    why:
      'the streaming local path behind streamGitFields: the default for unbounded reads (an early stop must kill git) ' +
      'and the fallback when a preferSidecar read cannot reach the sidecar',
  },
  {
    file: 'harness/git-sync/run-git-sync.ts',
    symbol: 'runGitLocalBounded',
    why: 'the local fallback for the git-sync runner',
  },
];

/** Any raw git invocation, however it is spelled — including a test seam's
 *  nullish default, `spawn(opts.gitBinary ?? 'git', …)`, which a bare
 *  `spawn('git'` match cannot see. */
const RAW_GIT_CALL =
  /(?:spawn|spawnSync|execFile|execFileSync|pexec)\(\s*(?:[A-Za-z_$][\w$.?]*\s*\?\?\s*)?['"]git['"]/g;

/** Nearest preceding TOP-LEVEL declaration — indentation 0, so a local
 *  `const child = spawn(...)` on the matching line itself is never mistaken
 *  for the owning symbol. */
function enclosingTopLevelSymbol(lines: string[], lineIndex: number): string | null {
  const decl = /^(?:export\s+)?(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/;
  for (let i = lineIndex; i >= 0; i--) {
    const m = decl.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

function findRawGitSites(file: string): { symbol: string | null; line: number }[] {
  const src = readFileSync(join(LIB, file), 'utf8');
  const lines = src.split('\n');
  const out: { symbol: string | null; line: number }[] = [];
  lines.forEach((text, i) => {
    RAW_GIT_CALL.lastIndex = 0;
    if (RAW_GIT_CALL.test(text)) out.push({ symbol: enclosingTopLevelSymbol(lines, i), line: i + 1 });
  });
  return out;
}

describe('no UNROUTED git spawn survives in the hot set (occurrence-granular)', () => {
  for (const file of HOT_GIT_SCAN_FILES) {
    it(`${file} forks git only from allowlisted fallbacks`, () => {
      const allowed = new Set(ALLOWED_RAW_GIT.filter((a) => a.file === file).map((a) => a.symbol));
      const offenders = findRawGitSites(file).filter((s) => !s.symbol || !allowed.has(s.symbol));
      expect(
        offenders,
        `${file} forks git directly from ${offenders
          .map((o) => `${o.symbol ?? '<top level>'}() at line ${o.line}`)
          .join(', ')}, which is not an allowlisted local fallback.\n` +
          `This module runs inside the long-lived host, where fork() costs the CALLER ~40ms per GB of its OWN RSS ` +
          `(~165ms at the bg-host's ~4GB) as synchronous time on the main thread — which kills p2p transfers.\n` +
          `Route it through the shared seam (defaultRunGit / defaultRunGitStdin / runGitViaSpawnerSidecar). ` +
          `If it genuinely cannot be routed, add it to ALLOWED_RAW_GIT with a REASON — never by deleting this test.`,
      ).toEqual([]);
    });
  }

  it('every allowlist entry still exists — a stale exemption must not silently widen the guard', () => {
    // An allowlisted symbol that has been renamed or removed leaves a hole:
    // the entry matches nothing, so a NEW raw spawn could later reuse the old
    // name and inherit the exemption without anyone deciding that.
    const stale = ALLOWED_RAW_GIT.filter(
      (a) => !findRawGitSites(a.file).some((s) => s.symbol === a.symbol),
    );
    expect(
      stale,
      `these ALLOWED_RAW_GIT entries no longer match any raw git call: ${stale
        .map((s) => `${s.file}#${s.symbol}`)
        .join(', ')}. Remove them — a stale exemption is a hole waiting to be reused.`,
    ).toEqual([]);
  });

  it('gitToplevel stays MEMOISED — that is the sole reason its sync fork is exempt', () => {
    // A synchronous fork blocks the event loop for the child's ENTIRE runtime
    // plus the ~165ms fork tax at bg-host RSS. One-shot that is tolerable; per
    // call it would be worse than anything else this guard protects. If the
    // cache is ever dropped, the exemption above silently stops being true —
    // so tie the exemption to the property, not to a comment.
    const src = readFileSync(join(LIB, 'dev-deploy-state.ts'), 'utf8');
    expect(
      /cachedToplevel\s*!=\s*null|cachedToplevel\s*!==\s*null|if\s*\(\s*cachedToplevel\s*\)/.test(src),
      'gitToplevel() no longer memoises its result, so its execFileSync now forks git on EVERY call — ' +
        'a synchronous, loop-blocking fork in a UI-polled module. Restore the cache or route it.',
    ).toBe(true);
  });

  it('the delegating pot-git seams contain NO raw git spawn at all', () => {
    // The specific WI-6404 regression: each of these had grown a PRIVATE
    // raw-spawn `runGitStdin` copy while the shared seam sat unused next door.
    // They have no allowlist entry, so any raw spawn reappearing here reds.
    const delegating = [
      'sync/pot-git/publish-guard.ts',
      'sync/pot-git/chunked-blob-scan.ts',
      'sync/pot-git/foreign-mirror-quarantine.ts',
      'sync/pot-git/github-egress.ts',
    ];
    for (const file of delegating) {
      expect(findRawGitSites(file), `${file} must delegate to the shared seam, not fork git itself`).toEqual(
        [],
      );
    }
  });
});
