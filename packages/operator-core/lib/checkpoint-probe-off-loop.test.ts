/**
 * WI-10005268: the checkpoint probes (`checkActiveCheckpointRun`, `currentCheckpointCandidate`,
 * `excludedCommitsSync`, `pathsBetweenSync`) are SYNC functions whose default exec is
 * `spawnSync`. Called from an operator handler with that default, each one parks the host's main
 * thread for every git/systemctl child it runs; the event-loop sentinel then wedge-kills
 * :3070/:3170 and every MCP session on the host drops (owner directive #1155; the first measured
 * producer of this exact shape was WI-10005261).
 *
 * Two halves:
 *   1. BEHAVIOUR: `runCheckpointProbe` keeps an injected exec synchronous (so
 *      `launchDetachedCheckpoint` still reaches spawn in the caller's tick) and routes the real
 *      default through async record/replay with a faithful result.
 *   2. GUARD: on the main-thread call paths, every reference to a probe sits inside the probe
 *      callback of `runCheckpointProbe` / `runSyncWithAsyncExec`. The WI-10005242 ratchet cannot
 *      see this class: the `spawnSync` lives in the seam default, not at the call site.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { checkActiveCheckpointRun, runCheckpointProbe, type ExecSyncLike } from './release-checkpoint-launch';
import type { ExecResult } from './sync-exec-replay';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// 1. Behaviour
// ---------------------------------------------------------------------------------------------

/** Deterministic answers for any call, so a sync run and a replayed run see the same world. */
function answer(cmd: string, args: readonly string[]): ExecResult {
  if (cmd === 'systemctl') {
    return { status: 0, stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\n', stderr: '' };
  }
  if (args.includes('rev-parse')) return { status: 0, stdout: 'a'.repeat(40) + '\n', stderr: '' };
  return { status: 1, stdout: '', stderr: `unscripted: ${cmd} ${args.join(' ')}` };
}

/** The real probe with every non-exec reader stubbed, so only the exec seam varies. */
function activeRunProbe(exec: ExecSyncLike) {
  return checkActiveCheckpointRun(
    '/nonexistent/wi-10005268-root',
    exec,
    () => null,
    () => false,
    () => null,
    () => null,
    () => null,
    () => null,
    () => null,
  );
}

describe('runCheckpointProbe (WI-10005268)', () => {
  it('runs an INJECTED exec synchronously and returns the plain value, not a Promise', () => {
    const calls: string[] = [];
    const injected: ExecSyncLike = (cmd, args) => {
      calls.push(`${cmd} ${args.join(' ')}`);
      return answer(cmd, args);
    };
    const r = runCheckpointProbe(activeRunProbe, injected);
    // launchDetachedCheckpoint depends on this: with sync seams it must reach spawnFn in the
    // caller's own tick, so no microtask may be inserted.
    expect(typeof (r as { then?: unknown }).then).toBe('undefined');
    expect(r).toEqual(activeRunProbe(injected));
    expect(calls.length).toBeGreaterThan(0);
  });

  it('routes the real default exec through async record/replay with a faithful result', async () => {
    const seen: Array<{ call: string; timeout: unknown }> = [];
    const asyncExec = async (cmd: string, args: string[], options?: { timeout?: number }) => {
      seen.push({ call: `${cmd} ${args.join(' ')}`, timeout: options?.timeout });
      await new Promise((resolve) => setTimeout(resolve, 1));
      return answer(cmd, args);
    };
    const r = runCheckpointProbe(activeRunProbe, undefined, asyncExec);
    expect(r).toBeInstanceOf(Promise);
    const replayed = await r;

    // Same answers through a sync exec: the replay must reproduce that run exactly.
    expect(replayed).toEqual(activeRunProbe((cmd, args) => answer(cmd, args)));
    // Every distinct call went through the async exec exactly once.
    expect(new Set(seen.map((s) => s.call)).size).toBe(seen.length);
    // The systemctl probe's own bound is forwarded, not dropped.
    const systemctl = seen.find((s) => s.call.startsWith('systemctl '));
    expect(systemctl).toBeDefined();
    expect(typeof systemctl?.timeout).toBe('number');
  });
});

// ---------------------------------------------------------------------------------------------
// 2. Guard
// ---------------------------------------------------------------------------------------------

const PROBES: ReadonlySet<string> = new Set([
  'checkActiveCheckpointRun',
  'currentCheckpointCandidate',
  'excludedCommitsSync',
  'pathsBetweenSync',
]);
const WRAPPERS: ReadonlySet<string> = new Set(['runCheckpointProbe', 'runSyncWithAsyncExec']);
/** Already-async entry points: a reference to one is a correctly converted call site. */
const SAFE_FORMS: ReadonlySet<string> = new Set(['checkActiveCheckpointRunAsync']);

function calleeName(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return '';
}

/** True when `node` sits inside a function passed as the FIRST argument of a wrapper call. */
function insideWrapper(node: ts.Node): boolean {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      ts.isCallExpression(n.parent) &&
      n.parent.arguments[0] === n &&
      WRAPPERS.has(calleeName(n.parent.expression))
    ) {
      return true;
    }
  }
  return false;
}

/** Declarations, keys, specifiers and destructured names do not read the probe's value. */
function isNonReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p)) return true;
  if (ts.isBindingElement(p)) return true;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertySignature(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p)) &&
    p.name === id
  ) {
    return true;
  }
  return false;
}

export interface ProbeScan {
  /** `file:line name` for every value reference to a probe outside a wrapper callback. */
  unwrapped: string[];
  /** Value references inside a wrapper callback (half of the positive control). */
  wrapped: number;
  /** Value references to an already-async form (the other half). */
  safe: number;
  /** Which of `onlyFunctions` were actually found (the denominator). */
  functionsFound: string[];
}

/**
 * Scan `source` for probe references. With `onlyFunctions`, only the bodies of those function
 * declarations are in scope (the probes call each other legitimately elsewhere in their module).
 */
export function scanProbeReferences(source: string, fileName: string, onlyFunctions?: ReadonlySet<string>): ProbeScan {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: ProbeScan = { unwrapped: [], wrapped: 0, safe: 0, functionsFound: [] };
  const visit = (node: ts.Node, inScope: boolean): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node)) return;
    let scope = inScope;
    if (onlyFunctions && ts.isFunctionDeclaration(node) && node.name && onlyFunctions.has(node.name.text)) {
      scope = true;
      out.functionsFound.push(node.name.text);
    }
    if (scope && ts.isIdentifier(node) && PROBES.has(node.text) && !isNonReference(node)) {
      if (insideWrapper(node)) out.wrapped++;
      else out.unwrapped.push(`${fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1} ${node.text}`);
    }
    if (scope && ts.isIdentifier(node) && SAFE_FORMS.has(node.text) && !isNonReference(node)) out.safe++;
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(sf, !onlyFunctions);
  out.functionsFound.sort();
  return out;
}

/**
 * Main-thread call paths. A whole-file entry (`null`) scans every reference; a function list scans
 * only those bodies. Extend this list when a new handler reaches a checkpoint probe.
 */
const MAIN_THREAD_PATHS: ReadonlyArray<readonly [string, readonly string[] | null]> = [
  ['release-checkpoint-launch.ts', ['assessPreLaunchExclusion', 'checkActiveCheckpointRunAsync', 'launchDetachedCheckpoint']],
  ['agent-tools/routines/set.ts', null],
  ['git-pipeline-stats.ts', null],
  ['git-pipeline-position.ts', null],
];

describe('checkpoint probes stay off the operator main thread (WI-10005268 guard)', () => {
  it('CALIBRATION: flags bare and aliased probe uses; accepts wrapped, typed and imported ones', () => {
    // Inline fixtures, never a tree mutation (CLAUDE.md, "Proving a guard is falsifiable").
    expect(scanProbeReferences(`checkActiveCheckpointRun(root);`, 'a.ts').unwrapped).toHaveLength(1);
    expect(scanProbeReferences(`const p = (await import('x')).checkActiveCheckpointRun; p(r);`, 'a.ts').unwrapped).toHaveLength(1);
    expect(scanProbeReferences(`f(opts.probe ?? currentCheckpointCandidate);`, 'a.ts').unwrapped).toHaveLength(1);
    // Wrapped only when the probe sits in the wrapper's FIRST argument.
    expect(scanProbeReferences(`runCheckpointProbe(x, () => pathsBetweenSync(r, a, b));`, 'a.ts').unwrapped).toHaveLength(1);

    const wrapped = scanProbeReferences(
      `await runCheckpointProbe((e) => checkActiveCheckpointRun(root, e), execFn);\n` +
        `await runSyncWithAsyncExec(function (e) { return excludedCommitsSync(r, a, b, 1, e); }, ax);`,
      'a.ts',
    );
    expect(wrapped).toEqual({ unwrapped: [], wrapped: 2, safe: 0, functionsFound: [] });
    expect(scanProbeReferences(`await checkActiveCheckpointRunAsync(root);`, 'a.ts')).toMatchObject({ unwrapped: [], safe: 1 });

    expect(scanProbeReferences(`type T = ReturnType<typeof checkActiveCheckpointRun>;`, 'a.ts').unwrapped).toEqual([]);
    expect(scanProbeReferences(`import { checkActiveCheckpointRun } from 'x';`, 'a.ts').unwrapped).toEqual([]);
    expect(scanProbeReferences(`const { currentCheckpointCandidate } = await import('x');`, 'a.ts').unwrapped).toEqual([]);
    expect(scanProbeReferences(`// checkActiveCheckpointRun(root)\nconst s = 'pathsBetweenSync(r)';`, 'a.ts').unwrapped).toEqual([]);

    // Function scoping: only the named bodies count.
    const scoped = scanProbeReferences(
      `function other() { checkActiveCheckpointRun(r); }\nasync function launchDetachedCheckpoint() { checkActiveCheckpointRun(r); }`,
      'a.ts',
      new Set(['launchDetachedCheckpoint']),
    );
    expect(scoped.unwrapped).toEqual(['a.ts:2 checkActiveCheckpointRun']);
    expect(scoped.functionsFound).toEqual(['launchDetachedCheckpoint']);
  });

  for (const [rel, fns] of MAIN_THREAD_PATHS) {
    it(`${rel}: every checkpoint probe on the main-thread path runs through runCheckpointProbe`, () => {
      const scan = scanProbeReferences(readFileSync(path.join(HERE, rel), 'utf8'), rel, fns ? new Set(fns) : undefined);
      // Denominator: a renamed function would otherwise scan nothing and pass.
      if (fns) expect(scan.functionsFound).toEqual([...fns].sort());
      // Positive control: each path does reach a probe today, so the walker must see it.
      expect(scan.unwrapped.length + scan.wrapped + scan.safe).toBeGreaterThan(0);
      expect(
        scan.unwrapped,
        `\nThese references run a checkpoint probe with its default spawnSync exec on the operator main\n` +
          `thread, which freezes every MCP session on the host (WI-10005268, #1155).\n` +
          `FIX: await runCheckpointProbe((e) => <probe>(..., e), execFn), or checkActiveCheckpointRunAsync(root).\n\n` +
          scan.unwrapped.map((u) => `  ${u}`).join('\n') +
          '\n',
      ).toEqual([]);
    });
  }
});
