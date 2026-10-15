/**
 * WI-10005327 guard (owner directive #1155): the turn-provenance ledger write
 * path must stay OFF the operator event loop.
 *
 * Measured 2026-10-02T05:51:49Z: the :3170 operator's main thread sat 10s in D
 * state in `mkdir(~/.papercusp/turn-provenance)` (wchan filename_create) during
 * a host-wide ext4 directory contention event. The previous appendLedgerRow did
 * mkdirSync + existsSync + statSync + appendFileSync on every wake injection.
 * The event-loop sentinel SIGKILLs a process stuck 20s, which drops MCP sessions.
 *
 * Two code-shape checks, both on the TypeScript AST (comments and strings are
 * never matched):
 *   1. Inside turn-provenance.ts, the ONLY synchronous fs call left is
 *      readFileSync in readLedgerRows (test/CLI read side; no operator caller).
 *   2. Every production call to the write-path entry points is AWAITED, so no
 *      caller types a turn before its ledger row is on disk, and no GC sweep is
 *      left as a floating promise.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..');

/** Overridable so scripts/mutation-probe.sh can point the guard at a mutated COPY. */
const MODULE_FILE = process.env.PROBE_TURN_PROVENANCE_FILE ?? join(HERE, 'turn-provenance.ts');

const WRITE_PATH_ENTRY_POINTS = ['appendLedgerRow', 'tagTurnForInjection', 'gcLedgerDir', 'tagWakeText'];

function parse(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function enclosingFunctionName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if (ts.isFunctionDeclaration(p) && p.name) return p.name.text;
    if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && ts.isVariableDeclaration(p.parent)) {
      const n = p.parent.name;
      if (ts.isIdentifier(n)) return n.text;
    }
  }
  return '<module>';
}

function calleeName(call: ts.CallExpression): string | null {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}

/** Every `*Sync(...)` call in `text`, as `<enclosing function>:<callee>`. */
export function syncCallSites(fileName: string, text: string): string[] {
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && /Sync$/.test(name)) out.push(`${enclosingFunctionName(node)}:${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(fileName, text));
  return out.sort();
}

/** Calls whose result is not awaited, including through a promise chain. */
export function unawaitedCalls(fileName: string, text: string, names: readonly string[]): string[] {
  const sf = parse(fileName, text);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && names.includes(name)) {
        let result: ts.Node = node;
        while (result.parent) {
          const parent = result.parent;
          if (ts.isParenthesizedExpression(parent)) {
            result = parent;
            continue;
          }
          if (
            ts.isPropertyAccessExpression(parent) && parent.expression === result &&
            ['then', 'catch', 'finally'].includes(parent.name.text) &&
            ts.isCallExpression(parent.parent) && parent.parent.expression === parent
          ) {
            result = parent.parent;
            continue;
          }
          break;
        }
        if (!ts.isAwaitExpression(result.parent)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push(`${fileName}:${line + 1}:${name}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Production .ts files (tracked or untracked, never tests or bundles) that call an entry point. */
function productionCallerFiles(): string[] {
  const pattern = `\\b(${WRITE_PATH_ENTRY_POINTS.join('|')})\\(`;
  const raw = execFileSync(
    'git',
    ['grep', '-l', '--untracked', '-E', pattern, '--', '*.ts', '*.mts', ':!*.test.ts', ':!**/dist*/**'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return raw.split('\n').filter(Boolean);
}

describe('turn-provenance ledger I/O stays off the event loop (WI-10005327)', () => {
  it('the only synchronous fs call left in turn-provenance.ts is the read side', () => {
    const sites = syncCallSites(MODULE_FILE, readFileSync(MODULE_FILE, 'utf8'));
    expect(
      sites,
      'A sync fs call reappeared in turn-provenance.ts. Its write path runs on the operator ' +
        'main thread for every wake injection, and a sync call there is exposed to D-state ' +
        'filesystem waits that trip the 20s event-loop WEDGED kill (#1155). Use fs.promises.',
    ).toEqual(['readLedgerRows:readFileSync']);
  });

  it('every production call to a write-path entry point is awaited', () => {
    const files = productionCallerFiles();
    // Positive control: a broken scan (wrong cwd, bad pathspec) must not pass vacuously.
    for (const known of [
      'packages/operator-core/lib/agent-tools/session/request-compaction.ts',
      'packages/operator-core/lib/dbos/periodic-workflows.ts',
      'packages/operator-core/lib/events/await/wake-executor.ts',
      'packages/operator-core/lib/harness/routines/loop-turn-outcome.ts',
      'packages/operator-core/lib/identity-management.ts',
      'packages/operator-core/lib/role-launch-spec.ts',
    ]) {
      expect(files, `scan did not find known caller ${known}`).toContain(known);
    }
    const offenders = files.flatMap((f) =>
      unawaitedCalls(f, readFileSync(join(REPO_ROOT, f), 'utf8'), WRITE_PATH_ENTRY_POINTS),
    );
    expect(
      offenders,
      'These calls are not awaited. An un-awaited tag can type the turn before its ledger row ' +
        'exists (the hook then classifies it unverified), and an un-awaited GC is a floating promise.',
    ).toEqual([]);
  });

  it('accepts awaited promise chains while rejecting floating and unrelated method calls', () => {
    const names = ['tagTurnForInjection'];
    expect(unawaitedCalls('x.ts',
      'async function f() { await (tagTurnForInjection(x)).then(format).catch(onError).finally(cleanup); }', names,
    )).toEqual([]);
    expect(unawaitedCalls('x.ts',
      'tagTurnForInjection(x).then(format).catch(onError);', names,
    )).toEqual(['x.ts:1:tagTurnForInjection']);
    expect(unawaitedCalls('x.ts',
      'async function f() { await tagTurnForInjection(x).toString(); }', names,
    )).toEqual(['x.ts:1:tagTurnForInjection']);
  });

  it('FALSIFIABLE controls: both detectors flag the shapes they exist to catch', () => {
    expect(
      syncCallSites('x.ts', 'export function appendLedgerRow() { mkdirSync(d); fs.appendFileSync(p, l); }'),
    ).toEqual(['appendLedgerRow:appendFileSync', 'appendLedgerRow:mkdirSync']);
    // A mention in a comment or string is not a call.
    expect(syncCallSites('x.ts', '// mkdirSync(d)\nconst s = "statSync(p)";')).toEqual([]);

    const bad = [
      'void gcLedgerDir();',
      'const t = tagTurnForInjection({}).taggedText;',
      'async function f() { return (await tagTurnForInjection({})).taggedText; }',
      'async function g() { await gcLedgerDir(); }',
    ].join('\n');
    expect(unawaitedCalls('x.ts', bad, WRITE_PATH_ENTRY_POINTS)).toEqual([
      'x.ts:1:gcLedgerDir',
      'x.ts:2:tagTurnForInjection',
    ]);
  });
});
