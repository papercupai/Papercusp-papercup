/**
 * RECURRENCE GUARD for chunk-split UTF-8 corruption (WI-6728).
 *
 * ## What this guard actually asserts — read this before trusting its green
 *
 * It does NOT assert "the tree is free of this bug". 96 sites predate it and are
 * recorded in {@link BASELINE} below. What it asserts is narrower and true:
 *
 *   1. the count can only go DOWN — no new file joins the set, no file grows;
 *   2. the sites already CONVERTED stay converted;
 *   3. the helper they were converted to is still boundary-safe.
 *
 * That distinction is the point. A guard whose green is read as "the property
 * holds" when it only checked something weaker is worse than no guard, because
 * it actively suppresses suspicion — the fork-tax guard (WI-6727) passed for
 * five days while a second seam in an already-allowlisted file forked git raw.
 * So the failure messages here say which of the three claims broke, and this
 * comment says plainly which claim is NOT being made.
 *
 * ## Fixing a site rather than baselining it
 *
 * Route it through `collectChildOutput(child)` / `createTextCollector(stream)`
 * from child-output.ts, then LOWER this file's baseline count. The ratchet
 * refuses a baseline that is looser than reality, so the number cannot silently
 * drift back up after someone fixes a site.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { scanSource, enclosingTopLevelSymbol, type ChunkUnsafeSite } from './child-output-scan.js';
// Typed via scripts/lib/tracked-files.d.mts — the former `@ts-expect-error` here became
// UNUSED (TS2578) the moment those declarations landed, so it is deliberately gone.
import { listTrackedFiles } from '../../../scripts/lib/tracked-files.mjs';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
  cwd: import.meta.dirname,
  timeout: 10_000,
  killSignal: 'SIGKILL',
}).trim();

/**
 * Files that legitimately CONTAIN the pattern as data rather than as behaviour:
 * the scanner's own regexes, the helper's documentation of the bug, and the
 * test that deliberately reproduces the broken idiom to prove it corrupts.
 * Excluded by exact path — never by a glob that could swallow a real site.
 */
const SELF_EXCLUDED = new Set([
  'packages/operator-core/lib/child-output-scan.ts',
  'packages/operator-core/lib/child-output.ts',
  'packages/operator-core/lib/child-output.test.ts',
  'packages/operator-core/lib/child-output-guard.test.ts',
]);

/**
 * Sites CONVERTED under WI-6728. These must stay at zero AND keep importing the
 * helper — asserted separately below, because "has no raw accumulation" and
 * "actually uses the safe helper" are different properties and a file can lose
 * the second while keeping the first (e.g. by dropping output capture entirely).
 */
const CONVERTED = [
  'packages/operator-core/lib/sync/pot-git/storage.ts',
  'packages/operator-core/lib/sync/pot-git/fetch-transport.ts',
  'packages/operator-core/lib/harness/docs/git-runner.ts',
  'packages/operator-core/lib/harness/git-sync/run-git-sync.ts',
  'packages/operator-core/lib/harness-state/git-export/git-committer.ts',
  'packages/operator-core/lib/release-deploy-launch.ts',
  'packages/operator-core/lib/memory/embed-sidecar-spawn.ts',
];

/**
 * Pre-existing sites, as of 2026-08-01. RATCHET ONLY — every number here may
 * fall, none may rise, and no key may be added without fixing the site instead.
 */
const BASELINE: Record<string, number> = {
  'apps/operator-vite/src/__tests__/vite-build-singleflight.test.ts': 2,
  'apps/operator-vite/src/__tests__/vite-watch-singleton.test.ts': 1,
  'apps/operator/lib/release/deploy-deps.ts': 2,
  'apps/operator/scripts/__tests__/docs-build-singleflight.test.ts': 1,
  'apps/operator/scripts/__tests__/onboard-launcher-flow.integration.test.ts': 2,
  'apps/operator/scripts/__tests__/tutorial-runner-flow.integration.test.ts': 2,
  'apps/operator/scripts/hooks/cc/__tests__/spawn-hook.ts': 2,
  // Submodule sites — invisible to a non-recursive `git ls-files`, and the
  // reason this guard recurses. Two of them are live orchestrator code.
  'libs/papercusp/packages/cli/src/install-atomic.node-test.ts': 2,
  'libs/papercusp/packages/orchestrator/src/bus-posts.test.ts': 1,
  'libs/papercusp/packages/orchestrator/src/chunk-loop-driver.test.ts': 2,
  'libs/papercusp/packages/orchestrator/src/scratch-env.test.ts': 4,
  'libs/papercusp/packages/orchestrator/src/scratch-env.ts': 4,
  'libs/papercusp/packages/orchestrator/src/worker-chunk-loop.concurrent.test.ts': 2,
  'libs/papercusp/packages/orchestrator/src/worker-chunk-loop.edge.test.ts': 2,
  'libs/papercusp/packages/orchestrator/src/worker-chunk-loop.recovery.test.ts': 2,
  'libs/papercusp/packages/orchestrator/src/worker-chunk-loop.test.ts': 2,
  'libs/papercusp/packages/orchestrator/src/worker-chunk-loop.ts': 1,
  'packages/backup/src/hook.ts': 2,
  'packages/operator-core/lib/admin-test-suites.ts': 2,
  'packages/operator-core/lib/deployment/cross-hive-cross-machine.integration.test.ts': 2,
  'packages/operator-core/lib/deployment/remote-exec.ts': 2,
  'packages/operator-core/lib/endpoint-route/routes/harness/git.ts': 1,
  'packages/operator-core/lib/endpoint-route/routes/harness/orchestration-actions.ts': 2,
  'packages/operator-core/lib/endpoint-route/routes/plugins/enable.ts': 2,
  'packages/operator-core/lib/endpoint-route/routes/plugins/uninstall.ts': 2,
  'packages/operator-core/lib/events/await/psu-pty-discovery.ts': 1,
  'packages/operator-core/lib/external-bench/competitor-live.ts': 2,
  'packages/operator-core/lib/external-bench/gaia/tools-live.ts': 2,
  'packages/operator-core/lib/gates/gate-canary-sweep-action.ts': 2,
  'packages/operator-core/lib/harness/bootstrap-papercusp-hive.ts': 2,
  'packages/operator-core/lib/harness/completion-ref-verifier.ts': 2,
  'packages/operator-core/lib/harness/git-sync/code-plane-federation.test.ts': 2,
  'packages/operator-core/lib/harness/git-sync/code-plane-fork-pr-live.test.ts': 1,
  'packages/operator-core/lib/harness/git-sync/multi-peer-convergence.test.ts': 4,
  'packages/operator-core/lib/harness/git-sync/seed-any-hive.integration.test.ts': 2,
  'packages/operator-core/lib/harness/git-sync/two-peer-convergence.integration.test.ts': 5,
  'packages/operator-core/lib/harness/routines/autoloop-release-readiness-action.ts': 2,
  'packages/operator-core/lib/harness/routines/cargo-test-action.ts': 2,
  'packages/operator-core/lib/harness/routines/gitnexus-reindex-action.ts': 2,
  'packages/operator-core/lib/harness/routines/p2p-perf-actions.ts': 2,
  'packages/operator-core/lib/harness/routines/release-actions.ts': 4,
  'packages/operator-core/lib/inference-gateway/codex-cli-bridge.ts': 1,
  'packages/operator-core/lib/p2p/sandbox/drill.ts': 1,
  'packages/operator-core/lib/p2p/sandbox/network-egress.ts': 1,
  'packages/operator-core/lib/p2p/sandbox/os-user-isolation.ts': 1,
  'packages/operator-core/lib/plugin-spawn-impl.ts': 2,
  'packages/operator-core/lib/provision/runner.ts': 2,
  'packages/operator-core/lib/release-checkpoint-launch.ts': 1,
  'packages/operator-core/lib/release-cut-launch.ts': 1,
  'packages/operator-core/lib/service-health.test.ts': 1,
  'packages/operator-core/lib/sync/pot-git/ref-announce-tick.integration.test.ts': 2,
};

const FIX_HINT =
  'Route it through `collectChildOutput(child)` or `createTextCollector(stream)` ' +
  'from packages/operator-core/lib/child-output.ts, then update BASELINE in this file.';

/**
 * EI-19298378364087215 — WHY THIS ENUMERATES VIA THE SHARED HELPER AND REPORTS
 * COVERAGE, rather than calling `git ls-files --recurse-submodules` itself.
 *
 * `--recurse-submodules` is load-bearing, not a nicety: a plain `git ls-files`
 * stops at the superproject and cannot see ANY of this repo's 39 submodules —
 * ~1000 TypeScript files that would silently never be scanned (WI-6730 filed
 * exactly this defect against 26 of the repo's 48 lint guards).
 *
 * But `--recurse-submodules` is NOT reliable everywhere, and its failure is
 * SILENT. The release/checkpoint checkout extracts submodule SOURCE with `git
 * archive` (setup-release-checkout.sh), deliberately — many submodule pins are
 * never pushed to origin, so a fresh worktree's `submodule update` fails "not
 * our ref". Archive-extracted trees have NO `.git`, so they are not submodules
 * to git: recursion returns superproject-only, exits 0, and simply yields a
 * SHORTER list. Measured in the checkpoint tree: 20,060 paths recursive vs
 * 20,098 plain, and ZERO under any submodule, while the files sit on disk.
 *
 * That is why coverage travels with the result. A guard that cannot tell "I
 * scanned this and found nothing" from "I never opened this" will, on the
 * absence-based ratchet below, instruct the reader to DELETE a guard entry
 * over a live unsafe site.
 */
function scanTree(): { byFile: Map<string, ChunkUnsafeSite[]>; unscanned: string[] } {
  // The shared enumerator returns the coverage split (declared/scanned/
  // unscanned) alongside the files, precisely so a caller cannot forget the
  // coverage question. Filter to TypeScript here rather than re-invoking git.
  const { files: allFiles, unscanned } = listTrackedFiles(REPO_ROOT) as {
    files: string[];
    unscanned: string[];
  };
  const files = allFiles
    .filter((f) => /\.(ts|mts|cts)$/.test(f))
    .filter((f) => !f.includes('node_modules') && !f.includes('_retired'))
    .filter((f) => !SELF_EXCLUDED.has(f));

  const byFile = new Map<string, ChunkUnsafeSite[]>();
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(join(REPO_ROOT, f), 'utf8');
    } catch {
      continue; // deleted between ls-files and read — a peer's in-flight rm
    }
    if (!src.includes("'data'") && !src.includes('"data"')) continue;
    const hits = scanSource(f, src);
    if (hits.length > 0) byFile.set(f, hits);
  }
  return { byFile, unscanned };
}

describe('chunk-split UTF-8 corruption guard (WI-6728)', () => {
  const { byFile: found, unscanned } = scanTree();
  /** True for a BASELINE key that lives under a submodule the enumerator could
   *  not open. For these, "0 sites found" carries NO information. */
  const wasNotScanned = (file: string): boolean =>
    unscanned.some((sub) => file.startsWith(`${sub}/`));

  it('no NEW file introduces a chunk-unsafe stream accumulator', () => {
    const offenders: string[] = [];
    for (const [file, hits] of found) {
      if (file in BASELINE) continue;
      for (const h of hits) {
        offenders.push(`${h.file}:${h.line} (in ${h.symbol ?? '<top level>'})  ${h.text}`);
      }
    }
    expect(
      offenders,
      `New chunk-unsafe stream accumulation. A multi-byte UTF-8 character split across two ` +
        `'data' events decodes to replacement chars — silent corruption, no error.\n${FIX_HINT}\n\n` +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('no baselined file GROWS more chunk-unsafe accumulators', () => {
    const grown: string[] = [];
    for (const [file, expected] of Object.entries(BASELINE)) {
      const actual = found.get(file)?.length ?? 0;
      if (actual > expected) grown.push(`${file}: baseline ${expected} → now ${actual}`);
    }
    expect(grown, `Baselined files gained new sites.\n${FIX_HINT}\n\n${grown.join('\n')}`).toEqual(
      [],
    );
  });

  it('the baseline is not looser than reality (a fixed site must lower its number)', () => {
    // Without this the ratchet only half works: a file fixed down to 0 could
    // silently regress back to its old baseline and stay green.
    //
    // ⚠ THIS IS THE ONE ASSERTION IN THIS FILE THAT REASONS FROM ABSENCE, and
    // absence is exactly what a silently-truncated enumeration manufactures
    // (EI-19298378364087215). The two assertions above are safe under partial
    // coverage — they only ever fire on a file that WAS read. This one turns
    // "not scanned" into "fixed", and its remedy text says DELETE THE KEY. In
    // the checkpoint tree that fired for all 12 submodule entries at once,
    // every one of which is a live unsafe site: chat-stream.ts still has 2 raw
    // `on('data')` accumulators, worker-chunk-loop.ts 1, gitnexus-bridge 1, and
    // none of them route through collectChildOutput. Following that advice
    // would have retired the guard over ~21% of the repo — the same blind spot
    // that let a raw NUL byte ship in libs/generic/sync/src/query-fetcher.ts.
    //
    // So a "fixed" verdict is UNREACHABLE for a file we could not open. The
    // skip is reported, never silent: an unverifiable ratchet is a stated gap,
    // which is the whole contract of the enumerator's scanned/unscanned split.
    const stale: string[] = [];
    const unverifiable: string[] = [];
    for (const [file, expected] of Object.entries(BASELINE)) {
      if (wasNotScanned(file)) {
        unverifiable.push(file);
        continue;
      }
      const actual = found.get(file)?.length ?? 0;
      if (actual < expected) {
        stale.push(
          actual === 0
            ? `${file}: fixed — DELETE this key from BASELINE`
            : `${file}: baseline ${expected} but only ${actual} remain — lower it to ${actual}`,
        );
      }
    }
    if (unverifiable.length > 0) {
      // ⚠ console.INFO, deliberately — NOT console.warn (EI-19298378364087215).
      //
      // The suite runs vitest-fail-on-console with shouldFailOnWarn, so a warn
      // here does not "report" the gap — it FAILS this test. And it fails it
      // with `Expected test not to call console.warn()`, which names neither
      // this guard nor the coverage gap, so every reader diagnosed it as an
      // unrelated flake. It is also unreproducible outside the gate: in a dev
      // tree the submodules are real, `unverifiable` is empty, and the file
      // passes 14/14 — so the red only ever appears where nobody can debug it.
      //
      // The gap it reports is a STRUCTURAL, EXPECTED property of the gate's own
      // checkout, not a code defect: setup-release-checkout.sh archive-extracts
      // submodule source at each pinned sha (many pins are never pushed to
      // origin, so `git submodule update` cannot work there), leaving plain
      // files with no .git that `ls-files --recurse-submodules` cannot see.
      // Reddening the fleet's release gate on that held `main` ~7h / 70 commits.
      //
      // This is NOT a weakening of the ratchet. The "fixed — DELETE this key"
      // verdict is made unreachable by the `continue` above, not by this line;
      // the dedicated "never concludes 'fixed' for a file the enumerator could
      // not open" test pins that invariant; and the ratchet still asserts
      // normally on every file that WAS scanned (38/39 submodules in staging).
      // Only the log LEVEL changes — the gap stays printed, on every run.
      //
      // DURABLE FIX (tracked on EI-19298378364087215, not done here): have
      // extract_submodule_source() persist the `tar -tf` manifest it already
      // computes, splice it into listTrackedFiles() for archive-extracted
      // submodules to restore real coverage, and only THEN promote near-total
      // non-coverage to a thrown broken-environment error — a signal that names
      // the environment, instead of a console-level accident that names nothing.
      console.info(
        `[child-output-guard] ratchet NOT verified for ${unverifiable.length} baselined file(s) — ` +
          `their submodule was not scanned by the enumerator, so "0 sites found" means "never opened", ` +
          `not "fixed". This is a coverage gap, not a pass:\n  ${unverifiable.join('\n  ')}`,
      );
    }
    expect(stale, `BASELINE is looser than the tree. Tighten it:\n\n${stale.join('\n')}`).toEqual(
      [],
    );
  });

  it('never concludes "fixed" for a file the enumerator could not open', () => {
    // The recurrence guard for the CLASS (EI-19298378364087215), not the
    // instance. The bug was not "12 baseline keys looked stale" — it was that a
    // ratchet built on absence could reach a destructive conclusion from an
    // enumeration that silently returned nothing. This pins the invariant that
    // makes that unreachable, so it fails if someone re-derives `actual` for an
    // unscanned path.
    for (const sub of unscanned) {
      for (const file of Object.keys(BASELINE)) {
        if (!file.startsWith(`${sub}/`)) continue;
        expect(
          wasNotScanned(file),
          `${file} is under unscanned submodule ${sub} but is not excluded from the ratchet — ` +
            `it would be reported as "fixed — DELETE this key" over a site nobody read`,
        ).toBe(true);
      }
    }
  });

  it('the sites converted under WI-6728 have zero raw accumulators', () => {
    const regressed = CONVERTED.filter((f) => (found.get(f)?.length ?? 0) > 0).map(
      (f) => `${f}: ${found.get(f)?.map((h) => `${h.line} ${h.text}`).join(' | ')}`,
    );
    expect(regressed, `A converted site regressed to raw accumulation:\n${regressed.join('\n')}`).toEqual([]);
  });

  it('the proxy test response readers do not concatenate raw data chunks', () => {
    const file = 'apps/operator/lib/mcp-proxy/proxy.test.ts';
    const src = readFileSync(join(REPO_ROOT, file), 'utf8');
    const regressed = scanSource(file, src, { includeBareChunkParameter: true }).map(
      (h) => `${h.line} (in ${h.symbol ?? '<top level>'}) ${h.text}`,
    );
    expect(src).toContain('createTextCollector');
    expect(
      regressed,
      `Proxy response readers must use the UTF-8-safe collector:\n${regressed.join('\n')}`,
    ).toEqual([]);
  });

  it('the converted sites actually IMPORT the safe helper', () => {
    // Distinct from the assertion above: a file can reach zero raw
    // accumulators by losing its output capture entirely, which would pass
    // there and still be a regression.
    const missing = CONVERTED.filter((f) => {
      const src = readFileSync(join(REPO_ROOT, f), 'utf8');
      return !/from '(?:\.\.?\/)+child-output\.js'/.test(src);
    });
    expect(
      missing,
      `Converted file no longer imports child-output.js — did the safe capture get removed?\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('the helper is still boundary-safe (StringDecoder, not a per-chunk decode)', () => {
    // The exemption every converted site rests on. If this stops being true,
    // every conversion above is silently worthless — so assert it rather than
    // trusting the helper's comment.
    const src = readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/child-output.ts'), 'utf8');
    expect(src).toContain("from 'node:string_decoder'");
    expect(src).toMatch(/new StringDecoder\('utf8'\)/);
    expect(src).toMatch(/decoder\.write\(/);
    expect(src).toMatch(/decoder\.end\(\)/);
  });
});

describe('the scanner itself (a blind detector makes the guard green and worthless)', () => {
  it('finds the one-line arrow form', () => {
    const src = `const run = () => {\n  child.stdout.on('data', (d) => (stdout += String(d)));\n};`;
    const hits = scanSource('x.ts', src);
    expect(hits.length).toBe(1);
    expect(hits[0].line).toBe(2);
    expect(hits[0].symbol).toBe('run');
  });

  it('finds the block-body form', () => {
    const src = `function go() {\n  child.stdout.on('data', (chunk) => {\n    stdout += chunk.toString();\n  });\n}`;
    const hits = scanSource('x.ts', src);
    expect(hits.length).toBe(1);
    expect(hits[0].line).toBe(3);
    expect(hits[0].symbol).toBe('go');
  });

  it('finds bounded assignment-based concatenation inside a data handler', () => {
    const src = `function go() {\n  child.stderr.on('data', (chunk) => {\n    errors = (errors + String(chunk)).slice(-12_000);\n  });\n}`;
    expect(scanSource('x.ts', src)).toMatchObject([{ line: 3, symbol: 'go' }]);
  });

  it('does not flag byte-preserving latin1 conversion', () => {
    const src = `function go() {\n  response.on('data', (chunk) => {\n    tail = (tail + chunk.toString("latin1")).slice(-4);\n  });\n}`;
    expect(scanSource('x.ts', src)).toEqual([]);
  });

  it('finds direct accumulation of a data-handler chunk parameter', () => {
    const src = `function go() {\n  response.on('data', (chunk) => (body += chunk));\n}`;
    const hits = scanSource('x.ts', src, { includeBareChunkParameter: true });
    expect(hits).toMatchObject([{ line: 2, symbol: 'go' }]);
  });

  it('finds the template-literal form', () => {
    const src = "function go() {\n  s.on('data', (d) => { acc += `${d}`; });\n}";
    expect(scanSource('x.ts', src).length).toBe(1);
  });

  it('does NOT flag an accumulation in a SIBLING handler', () => {
    // `child.on('error', e => stderr += String(e))` accumulates an Error, not a
    // chunk — correct code. A line-window scan mistakes it for a data-handler
    // site; this is why the scanner tracks the handler's real paren extent.
    const src = [
      'function go() {',
      "  child.stdout.on('data', (d) => outChunks.push(d));",
      "  child.on('error', (e) => {",
      '    stderr += String(e);',
      '  });',
      '}',
    ].join('\n');
    expect(scanSource('x.ts', src)).toEqual([]);
  });

  it('does NOT flag byte-exact Buffer accumulation', () => {
    const src = `function go() {\n  child.stdout.on('data', (d) => chunks.push(d));\n}`;
    expect(scanSource('x.ts', src)).toEqual([]);
  });

  it('does NOT flag the safe helper idiom', () => {
    const src = `function go() {\n  child.stdout.on('data', (d) => (out += decoder.write(d)));\n}`;
    expect(scanSource('x.ts', src)).toEqual([]);
  });

  it('resolves the enclosing symbol to a TOP-LEVEL declaration, not a local', () => {
    // The trap that silently empties a symbol-keyed allowlist: the nearest
    // declaration to a spawn site is the indented `const child = spawn(...)`.
    const lines = [
      'export const runGitLocal = (args) => {',
      '  const child = spawn("git", args);',
      '  child.stdout.on("data", (d) => (out += String(d)));',
      '};',
    ];
    expect(enclosingTopLevelSymbol(lines, 2)).toBe('runGitLocal');
  });

  it('finds a per-chunk decode hidden behind an accumulated alias', () => {
    const src = `function go() {\n  child.stdout.on('data', (chunk) => {\n    const decoded = chunk.toString('utf8');\n    output += decoded;\n  });\n}`;
    expect(scanSource('x.ts', src)).toMatchObject([
      { line: 3, symbol: 'go', text: "const decoded = chunk.toString('utf8');" },
    ]);
  });

  it('finds decoded chunk aliases in named data callbacks', () => {
    const src = `function go() {\n  const append = (chunk: Buffer) => {\n    const decoded = String(chunk);\n    output += decoded;\n  };\n  child.stdout.addListener('data', append);\n}`;
    expect(scanSource('x.ts', src)).toMatchObject([
      { line: 3, symbol: 'go', text: 'const decoded = String(chunk);' },
    ]);
  });

  it('finds a named function callback with direct per-chunk decoding', () => {
    const src = `function append(chunk: Buffer) {\n  output += chunk.toString('utf8');\n}\nfunction go() {\n  child.stdout.on('data', append);\n}`;
    expect(scanSource('x.ts', src)).toMatchObject([
      { line: 2, symbol: 'append', text: "output += chunk.toString('utf8');" },
    ]);
  });
});
