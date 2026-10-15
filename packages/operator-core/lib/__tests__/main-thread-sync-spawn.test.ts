/**
 * main-thread-sync-spawn.test.ts — WI-10005242.
 *
 * THE DEFECT THIS RATCHETS DOWN. An MCP tool handler runs on the operator host's MAIN thread
 * (:3070 / :3170 / bg-host). A synchronous child-process call there (`execFileSync`,
 * `spawnSync`, `execSync`) parks the whole event loop inside libuv's `uv_spawn_sync` until the
 * child exits: no request is served, no SSE frame is flushed, no timer fires. The host's own
 * watchdog then sees a wedged process and SIGKILLs it, and every MCP session riding that host
 * drops at once. That is the outage owner directive #1155 asked about.
 *
 * Every producer found so far was found only AFTER the fact, from an event-loop-sentinel
 * 'STALL profiled' hot stack:
 *   - release:cut resolveCutRoot / defaultWorktreeStatus execFileSync (54% of samples in the
 *     02:28Z profile on 2026-10-02) and prepare-tag execFileSync up to 120s: WI-10005193.
 *   - release:repair-queue admission realAdmissionGit spawnSync, 4–12s per admit and up to
 *     61.8s: WI-10005223 (moved onto a worker thread).
 * Nothing stopped the NEXT one from landing. This guard does.
 *
 * WHY A BOUND DOES NOT HELP HERE (the difference from pure-lane-unbounded-sync-spawn.test.ts).
 * That sibling ratchet accepts a call with a `timeout:` because its problem is a test that can
 * never be interrupted. Here the problem is the block itself: a call bounded at 120s still
 * freezes every MCP session on the host for up to 120s. So EVERY reference counts, bounded or not.
 *
 * WHAT COUNTS. A VALUE REFERENCE to a sync child-process primitive: a call (`execFileSync(…)`,
 * `cp.spawnSync(…)`), an alias call (`import { execFileSync as git }` then `git(…)`), or the
 * primitive handed over as a value (`exec = execFileSync` as a seam default, `{ run: spawnSync }`).
 * The seam case matters: injectable deps are this codebase's standard testability pattern, and a
 * call-only scan would miss every site written that way. Type positions (`typeof execFileSync`),
 * import/export specifiers, declaration names and object keys do not count; neither do mentions
 * in comments or string literals (the AST never sees them as identifiers).
 *
 * WHAT IS OUT OF SCOPE, deliberately:
 *   - `*.worker.ts` / `*.worker.mts` bodies. They run on their own thread, and moving git work
 *     into one is exactly the fix (release/admission-jobs.worker.ts, WI-10005223).
 *   - apps/operator/lib/release/**. green-checkpoint and its legs run in their own systemd unit,
 *     not on a host that serves MCP.
 *   - A sync spawn reached through a library helper OUTSIDE the scanned roots. Static scope ends
 *     at these two directories; the sentinel's 'STALL profiled' line is the runtime backstop.
 *
 * THE RATCHET. BASELINE grandfathers each file's measured count. The guard fails when:
 *   (a) a file NOT in BASELINE gains a reference,
 *   (b) a baselined file's count GROWS, or
 *   (c) a baselined file's count SHRINKS without the baseline being tightened — without (c) the
 *       slack left by a fix silently re-admits the next regression in that same file.
 *
 * FIX for a red: make the work asynchronous (`execFile` + `await`, the `runFileAsync` pattern in
 * agent-tools/release/cut.ts) or move it onto a worker (release/admission-offthread.ts). Do NOT
 * add or raise a BASELINE entry to make a new call pass; that list only ever shrinks.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Workspace-relative roots whose code runs on the operator host's main thread. */
export const SCAN_ROOTS = ['lib/agent-tools', 'lib/release'] as const;

/**
 * WI-10005268: single main-thread files outside SCAN_ROOTS. Each serves operator handlers
 * (release:checkpoint-run, dev:pipeline_position, the /admin/git pipeline read).
 */
export const SCAN_FILES = [
  'lib/release-checkpoint-launch.ts',
  'lib/git-pipeline-position.ts',
  'lib/git-pipeline-stats.ts',
  'lib/git-trackedness.ts',
  'lib/plan-audits.ts',
  // This system action runs on the operator host; its Git log must stay off the event loop.
  'lib/harness/routines/frozen-candidate-drift-sweep-action.ts',
  'lib/fleet/spawner-sidecar-spawn.ts',
  // Sync snapshots remain for child reporters; Hono test-run paths must use the async counterpart.
  'lib/testing-worktree.ts',
] as const;

const SYNC_SPAWN_NAMES: ReadonlySet<string> = new Set(['execFileSync', 'spawnSync', 'execSync']);

/**
 * Cheap prefilter run over the whole roster before any file is parsed. Built from a source string
 * so the literal call shape never appears in this file's code.
 */
const PREFILTER = new RegExp(String.raw`\b(?:execFileSync|spawnSync|execSync)\b`);

function scriptKindFor(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** True when `id` names a declaration, a key or a specifier rather than reading a value. */
function isNonReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) {
    return true;
  }
  if (ts.isBindingElement(p)) return p.name === id || p.propertyName === id;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p)) &&
    p.name === id
  ) {
    return true;
  }
  return false;
}

/**
 * Count value references to a synchronous child-process primitive in `source`.
 *
 * Aliases introduced by a renaming import (`{ spawnSync as run }`) or a renaming destructure
 * (`{ spawnSync: run }`) are folded in, so `run(…)` counts like the primitive itself.
 */
export function countSyncSpawnReferences(source: string, fileName = 'scan.ts'): number {
  if (!PREFILTER.test(source)) return 0;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));

  const names = new Set(SYNC_SPAWN_NAMES);
  const collectAliases = (node: ts.Node): void => {
    if (ts.isImportSpecifier(node) && node.propertyName && SYNC_SPAWN_NAMES.has(node.propertyName.text)) {
      names.add(node.name.text);
    }
    if (
      ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isIdentifier(node.propertyName) &&
      SYNC_SPAWN_NAMES.has(node.propertyName.text) &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(sf);

  let count = 0;
  const visit = (node: ts.Node): void => {
    // Type positions never execute: `typeof execFileSync`, `interface Deps { execFileSync: … }`.
    if (ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return;
    if (ts.isIdentifier(node) && names.has(node.text) && !isNonReference(node)) count++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

const SOURCE_RE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
// This documented `npx tsx` entrypoint is a separate process and is not imported by request handlers.
const STANDALONE_PROCESS_ENTRYPOINTS: ReadonlySet<string> = new Set([
  'lib/release/staging-fix-proposal-cli.ts',
]);

/** True for files the scan must skip: tests, fixtures, declarations, worker bodies and standalone processes. */
export function isOutOfScope(rel: string): boolean {
  return (
    STANDALONE_PROCESS_ENTRYPOINTS.has(rel) ||
    !SOURCE_RE.test(rel) ||
    /\.d\.[cm]?ts$/.test(rel) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
    /\.worker\.[cm]?[jt]s$/.test(rel) ||
    rel.includes('/__tests__/') ||
    rel.includes('/__fixtures__/') ||
    rel.includes('/_retired/') ||
    rel.includes('/node_modules/')
  );
}

/** Workspace-relative paths of every in-scope source file under SCAN_ROOTS. */
function roster(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) {
    const entries = readdirSync(path.join(WORKSPACE_ROOT, root), { recursive: true, withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile()) continue;
      const rel = path.relative(WORKSPACE_ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/');
      if (!isOutOfScope(rel)) out.push(rel);
    }
  }
  out.push(...SCAN_FILES);
  return out.sort();
}

/** Measured reference count per file, for every in-scope file with at least one reference. */
function measure(): { files: string[]; counts: Map<string, number> } {
  const files = roster();
  const counts = new Map<string, number>();
  for (const rel of files) {
    let src: string;
    try {
      src = readFileSync(path.join(WORKSPACE_ROOT, rel), 'utf8');
    } catch {
      continue; // raced with a concurrent edit on this shared tree
    }
    const n = countSyncSpawnReferences(src, rel);
    if (n > 0) counts.set(rel, n);
  }
  return { files, counts };
}

/** Ratchet (a)+(b): files whose measured count exceeds the baseline (absent = 0). */
export function grownEntries(counts: ReadonlyMap<string, number>, baseline: ReadonlyMap<string, number>): string[] {
  return [...counts].filter(([f, n]) => n > (baseline.get(f) ?? 0)).map(([f, n]) => `${f}: ${baseline.get(f) ?? 0} -> ${n}`);
}

/** Ratchet (c): baseline entries whose file now measures FEWER references (absent = 0). */
export function staleEntries(counts: ReadonlyMap<string, number>, baseline: ReadonlyMap<string, number>): string[] {
  return [...baseline]
    .filter(([f, n]) => (counts.get(f) ?? 0) < n)
    .map(([f, n]) => `${f}: baseline ${n}, measured ${counts.get(f) ?? 0}`);
}

/**
 * Grandfathered sites, measured from this test's own scan (never a hand-run grep).
 * SHRINK-ONLY: lower a count or delete an entry when you convert a site; never raise one.
 */
const BASELINE: ReadonlyMap<string, number> = new Map<string, number>([
  // Seeded 2026-10-02T03:14Z from the "gains" assertion's own output (13 files, 16 references).
  // Each line names what the call runs so a converter can judge its cost without opening the file.
  ['lib/agent-tools/capability/exec-sandbox.ts', 1], // sandbox probe spawnSync
  ['lib/agent-tools/computer/desktop-provisioner-core.ts', 2], // xdpyinfo liveness probe; xsetroot paint
  ['lib/agent-tools/plans/audit.ts', 1], // git rev-parse HEAD
  ['lib/agent-tools/plans/git-history.ts', 1], // git rev-parse --show-toplevel
  ['lib/agent-tools/work_items/fabricated-paths.ts', 1], // git log -1 -- <path>, once per cited path
  ['lib/release/admission-fix-precheck.ts', 1], // git rev-parse --git-common-dir
  ['lib/release/checkpoint-required-ancestor.ts', 2], // git probes via spawnSync(cmd, argv)
  ['lib/release/gate-fire-drill-deps.ts', 2], // systemctl is-active; systemctl stop (timeout 60s)
  ['lib/release/in-flight-retriage.ts', 1], // git probe
  // The next two run on the admission worker since WI-10005223 (release/admission-offthread.ts).
  // Each is still imported on the main thread by repair-queue.ts's legacy sameAdmissionPrecheck
  // (one cheap rev-parse), so both stay counted rather than scoped out.
  ['lib/release/judged-sha-containment.ts', 1],
  ['lib/release/repair-head-admission.ts', 1],
  // WI-10005268 (SCAN_FILES). defaultExecSync is the seam default for every exec-injected
  // checkpoint probe; main-thread callers reach it only through runCheckpointProbe's record/replay,
  // pinned by checkpoint-probe-off-loop.test.ts. The green-checkpoint unit still uses it directly.
  ['lib/release-checkpoint-launch.ts', 1],
  // Synchronous snapshot retained for spawned test reporters; host consumers are guarded below.
  ['lib/testing-worktree.ts', 1],
]);

function directCallCount(source: string, name: string, fileName = 'scan.ts'): number {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  let count = 0;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) count++;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return count;
}

function callsLegacyTestingRunStart(source: string, fileName: string): boolean {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKindFor(fileName));
  const importedNames = new Set<string>();
  const namespaceNames = new Set<string>();
  const collectBindings = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const modulePath = node.moduleSpecifier.text.replace(/\.[cm]?[jt]sx?$/, '');
      if (!modulePath.endsWith('/testing-run-store')) return;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements) {
          if ((specifier.propertyName?.text ?? specifier.name.text) === 'startRun') importedNames.add(specifier.name.text);
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        namespaceNames.add(bindings.name.text);
      }
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sf);

  let found = false;
  const findCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && importedNames.has(node.expression.text)) found = true;
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'startRun' &&
        ts.isIdentifier(node.expression.expression) &&
        namespaceNames.has(node.expression.expression.text)
      ) {
        found = true;
      }
    }
    ts.forEachChild(node, findCalls);
  };
  findCalls(sf);
  return found;
}

describe('operator main thread — synchronous child-process calls (WI-10005242 ratchet)', () => {
  it('CALIBRATION: counts calls, alias calls and seam values; ignores async and type-only uses', () => {
    // Inline fixtures, never a tree mutation (CLAUDE.md, "Proving a guard is falsifiable").
    expect(countSyncSpawnReferences(`execFileSync('git', ['status']);`)).toBe(1);
    expect(countSyncSpawnReferences(`cp.spawnSync('git', ['status']);`)).toBe(1);
    expect(countSyncSpawnReferences(`execSync('ls', { timeout: 5_000 });`)).toBe(1); // a bound does not exempt it
    expect(countSyncSpawnReferences(`import { execFileSync as git } from 'node:child_process';\ngit('rev-parse');`)).toBe(1);
    expect(countSyncSpawnReferences(`const { spawnSync: run } = require('node:child_process');\nrun('x');`)).toBe(1);
    expect(countSyncSpawnReferences(`function f(exec = execFileSync) { return exec('git'); }`)).toBe(1);
    expect(countSyncSpawnReferences(`const deps = { exec: execSync };`)).toBe(1);
    expect(countSyncSpawnReferences(`const deps = { execFileSync };`)).toBe(1);
    expect(countSyncSpawnReferences(`execFileSync('a');\nspawnSync('b');\nexecSync('c');`)).toBe(3);

    // Silent cases. Without these every negative assertion below would be vacuous.
    expect(countSyncSpawnReferences(`import { execFileSync } from 'node:child_process';`)).toBe(0);
    expect(countSyncSpawnReferences(`await execFileAsync('git', ['status']);`)).toBe(0);
    expect(countSyncSpawnReferences(`execFile('git', ['status'], cb);`)).toBe(0);
    expect(countSyncSpawnReferences(`type Exec = typeof execFileSync;`)).toBe(0);
    expect(countSyncSpawnReferences(`interface Deps { execFileSync: typeof execFileSync }`)).toBe(0);
    expect(countSyncSpawnReferences(`const deps = { execFileSync: fakeExec };`)).toBe(0);
    expect(countSyncSpawnReferences(`export { execFileSync } from 'node:child_process';`)).toBe(0);
  });

  it('recognizes direct and aliased calls to the legacy testing-run start export', () => {
    expect(callsLegacyTestingRunStart(
      "import { startRun } from '../../../testing-run-store'; startRun({});",
      'lib/endpoint-route/routes/example.ts',
    )).toBe(true);
    expect(callsLegacyTestingRunStart(
      "import { startRun as startLegacy } from '../../../testing-run-store'; startLegacy({});",
      'lib/endpoint-route/routes/example.ts',
    )).toBe(true);
    expect(callsLegacyTestingRunStart(
      "import { startRunAsync } from '../../../testing-run-store'; startRunAsync({});",
      'lib/endpoint-route/routes/example.ts',
    )).toBe(false);
  });

  it('counts CODE only: a quoted or commented mention is not a reference', () => {
    expect(countSyncSpawnReferences(`const s = "spawnSync('node', ['x.mjs'])";`)).toBe(0);
    expect(countSyncSpawnReferences('const s = `execSync("ls")`;')).toBe(0);
    expect(countSyncSpawnReferences(`// execFileSync('git', ['status'])`)).toBe(0);
    expect(countSyncSpawnReferences(`/* spawnSync('sh') */`)).toBe(0);
    // A regex literal holding a quote must not desync the scan and hide the real call after it.
    expect(countSyncSpawnReferences(`const q = /['"]/g;\nspawnSync('sh', ['-c', 'x']);`)).toBe(1);
    // A real call inside a template interpolation is still code.
    expect(countSyncSpawnReferences('const s = `${execFileSync("git")}`;')).toBe(1);
  });

  it('scopes out worker bodies, standalone CLI entrypoints, tests, fixtures and declarations', () => {
    expect(isOutOfScope('lib/release/admission-jobs.worker.ts')).toBe(true);
    expect(isOutOfScope('lib/release/staging-fix-proposal-cli.ts')).toBe(true);
    expect(isOutOfScope('lib/agent-tools/release/cut.test.ts')).toBe(true);
    expect(isOutOfScope('lib/agent-tools/x/__tests__/helper.ts')).toBe(true);
    expect(isOutOfScope('lib/agent-tools/x/__fixtures__/f.ts')).toBe(true);
    expect(isOutOfScope('lib/release/x.d.ts')).toBe(true);
    expect(isOutOfScope('lib/release/notes.md')).toBe(true);
    expect(isOutOfScope('lib/agent-tools/release/cut.ts')).toBe(false);
    expect(isOutOfScope('lib/release/admission-offthread.ts')).toBe(false);
  });

  it('RATCHET CONTROL: a new file, a grown count and an unlowered fix each fail', () => {
    const baseline = new Map([['lib/release/a.ts', 2]]);
    // (a) a file absent from the baseline gains a reference
    expect(grownEntries(new Map([['lib/agent-tools/new.ts', 1], ['lib/release/a.ts', 2]]), baseline)).toEqual([
      'lib/agent-tools/new.ts: 0 -> 1',
    ]);
    // (b) a baselined file grows
    expect(grownEntries(new Map([['lib/release/a.ts', 3]]), baseline)).toEqual(['lib/release/a.ts: 2 -> 3']);
    // (c) a baselined file shrinks (or reaches zero) without the baseline being lowered
    expect(staleEntries(new Map([['lib/release/a.ts', 1]]), baseline)).toEqual(['lib/release/a.ts: baseline 2, measured 1']);
    expect(staleEntries(new Map(), baseline)).toEqual(['lib/release/a.ts: baseline 2, measured 0']);
    // and an exact match is clean on both sides
    expect(grownEntries(new Map([['lib/release/a.ts', 2]]), baseline)).toEqual([]);
    expect(staleEntries(new Map([['lib/release/a.ts', 2]]), baseline)).toEqual([]);
  });

  it('DENOMINATOR: the scan roots resolved to a real roster (a scan of nothing is not a pass)', () => {
    const { files, counts } = measure();
    expect(files.length).toBeGreaterThan(300);
    // Positive control: the tree does hold references today. If this reads 0 the detector broke,
    // and every "no new offender" assertion below would pass vacuously.
    expect(counts.size).toBeGreaterThan(0);
    for (const root of SCAN_ROOTS) expect(files.some((f) => f.startsWith(`${root}/`))).toBe(true);
    // A SCAN_FILES entry that moved would read as a silent 0, not as an error.
    for (const file of SCAN_FILES) expect(existsSync(path.join(WORKSPACE_ROOT, file)), file).toBe(true);
  });

  it('the fleet spawner sidecar cleanup stays off the operator event loop', () => {
    const file = 'lib/fleet/spawner-sidecar-spawn.ts';
    expect(SCAN_FILES).toContain(file);
    expect(countSyncSpawnReferences(readFileSync(path.join(WORKSPACE_ROOT, file), 'utf8'), file)).toBe(0);
  });

  it('Hono test-run entrypoints use async worktree snapshots', () => {
    const consumers = [
      { file: 'lib/agent-tools/testing/run.ts', sync: 'captureWorktreeSnapshot', async: 'captureWorktreeSnapshotAsync', expectedAsyncCalls: 2 },
      { file: 'lib/endpoint-route/routes/harness/testing.ts', sync: 'startRun', async: 'startRunAsync', expectedAsyncCalls: 1 },
      { file: 'lib/endpoint-route/routes/admin/testing-run.ts', sync: 'startRun', async: 'startRunAsync', expectedAsyncCalls: 1 },
    ];
    for (const consumer of consumers) {
      const source = readFileSync(path.join(WORKSPACE_ROOT, consumer.file), 'utf8');
      expect(directCallCount(source, consumer.sync, consumer.file), consumer.file).toBe(0);
      expect(directCallCount(source, consumer.async, consumer.file), consumer.file).toBe(consumer.expectedAsyncCalls);
    }

    const routeRoot = path.join(WORKSPACE_ROOT, 'lib/endpoint-route/routes');
    const routeFiles = readdirSync(routeRoot, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.relative(WORKSPACE_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .filter(file => !isOutOfScope(file));
    const syncStartRunConsumers = routeFiles.filter(file =>
      callsLegacyTestingRunStart(readFileSync(path.join(WORKSPACE_ROOT, file), 'utf8'), file));
    expect(syncStartRunConsumers).toEqual([]);
  });

  it('no file gains a synchronous child-process reference on the main thread', () => {
    const grown = grownEntries(measure().counts, BASELINE);
    expect(
      grown,
      `\nThese files reference execFileSync/spawnSync/execSync more often than BASELINE allows.\n` +
        `They run on the operator host's main thread, where a sync child-process call freezes every\n` +
        `MCP session until the child exits, and a long one gets the host SIGKILLed (WI-10005242).\n\n` +
        `FIX: use execFile + await (the runFileAsync pattern in agent-tools/release/cut.ts), or move\n` +
        `the work onto a worker (release/admission-offthread.ts). Do NOT raise BASELINE.\n\n` +
        // Listed in the message, not only in the diff: vitest collapses a long array diff to
        // `[ …(N) ]`, which hides the one thing a reader of this failure needs.
        grown.map((g) => `  ${g}`).join('\n') +
        '\n',
    ).toEqual([]);
  });

  it('BASELINE is shrink-only: every entry still matches its measured count', () => {
    const stale = staleEntries(measure().counts, BASELINE);
    expect(
      stale,
      `\nThese files now hold FEWER sync child-process references than BASELINE records.\n` +
        `Lower the count (or delete the entry at 0) so the freed slack cannot re-admit a regression.\n\n` +
        stale.map((s) => `  ${s}`).join('\n') +
        '\n',
    ).toEqual([]);
  });
});
