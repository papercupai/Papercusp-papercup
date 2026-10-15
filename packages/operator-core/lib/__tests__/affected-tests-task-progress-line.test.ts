/**
 * `scripts/lib/task-progress-line.mjs` — EI-21048499991398082 regression guard.
 *
 * The AFFECTED_TASK_PROGRESS line's `exitStatus=`/`signal=` fields used a bare
 * `value ?? "pending"`. Node's `child.close(code, signal)` pair is mutually exclusive
 * (a normal exit has a numeric `code` and `signal: null`; a signal-kill has `code: null`
 * and a signal name) — so at a TERMINAL progress state ("finished" and friends) exactly
 * one of the two fields is legitimately `null`, meaning "not applicable", not "not yet
 * known". Collapsing that onto the same `"pending"` sentinel used before the task closes
 * made a clean, exit-0 pass — e.g. `state=finished exitStatus=0 signal=pending` — read as
 * still-unresolved, which is the false-red shape the filed bug reports ("aborted run
 * reports exit-0 tasks as FAILED").
 */
import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

import { formatTaskOutcomeFields } from '../../../../scripts/lib/task-progress-line.mjs';
import { createCgroupMemoryObserver } from '../../../../scripts/lib/budgeted-task-scheduler.mjs';

describe('formatTaskOutcomeFields', () => {
  it('renders both fields as "pending" before the task has closed (genuinely unknown)', () => {
    expect(formatTaskOutcomeFields({ status: null, signal: null, settled: false })).toEqual({
      exitStatus: 'pending',
      signal: 'pending',
    });
  });

  // THE REGRESSION CASE: a clean, exit-0 finish must NEVER render `signal=pending` — that is
  // indistinguishable from "still running" and is exactly what sent a release-fixer chasing a
  // phantom regression on a task that had already passed (EI-21048499991398082).
  it('renders a clean exit-0 finish as exitStatus=0 signal=none, never signal=pending', () => {
    const outcome = formatTaskOutcomeFields({ status: 0, signal: null, settled: true });
    expect(outcome).toEqual({ exitStatus: 0, signal: 'none' });
    expect(outcome.signal).not.toBe('pending');
  });

  it('renders a signal-killed finish as exitStatus=none signal=<name>, never exitStatus=pending', () => {
    const outcome = formatTaskOutcomeFields({ status: null, signal: 'SIGTERM', settled: true });
    expect(outcome).toEqual({ exitStatus: 'none', signal: 'SIGTERM' });
    expect(outcome.exitStatus).not.toBe('pending');
  });

  it('renders a non-zero exit-code finish with the real code and signal=none', () => {
    expect(formatTaskOutcomeFields({ status: 1, signal: null, settled: true })).toEqual({
      exitStatus: 1,
      signal: 'none',
    });
  });
});

describe('affected-tests durable live progress', () => {
  it('records the real progress emitter in the canonical log before task output is replayed', () => {
    const source = readFileSync(resolve(__dirname, '../../../../scripts/affected-tests.mjs'), 'utf8');
    const ast = ts.createSourceFile('affected-tests.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const declarations = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isFunctionDeclaration(node) && node.name && ['errSync', 'logLine'].includes(node.name.text)) {
        declarations.set(node.name.text, node.getText(ast));
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'emitProgress') {
        expect(node.initializer).toBeDefined();
        declarations.set('emitProgress', `const emitProgress = ${node.initializer!.getText(ast)};`);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    expect([...declarations.keys()].sort()).toEqual(['emitProgress', 'errSync', 'logLine']);

    const dir = mkdtempSync(join(tmpdir(), 'affected-progress-'));
    const log = join(dir, 'run.log');
    const stderr: string[] = [];
    const cgroupMemoryObserver = createCgroupMemoryObserver({
      read: () => ({ anonMb: 12, peakMb: 16, oomKills: 0 }),
    });
    writeFileSync(log, '');
    try {
      // Execute the production emitter and its actual log wrapper, not a copied
      // formatter. No completed-task replay or final verdict exists in this fixture.
      runInNewContext(
        `${declarations.get('logLine')}\n${declarations.get('errSync')}\n${declarations.get('emitProgress')}\nemitProgress('running');`,
        {
          appendFileSync,
          RUN_LOG_PATH: log,
          rawErrSync: (line: string) => stderr.push(line),
          formatTaskOutcomeFields,
          cgroupMemoryObserver,
          Date: { now: () => 5_000 },
          startedAt: 1_000,
          progressTask: JSON.stringify('core :: integration'),
          capturedBytes: 42,
          taskTimeoutMs: 60_000,
          taskTimeoutSource: 'history',
          taskDurationMs: 30_000,
          countedNonzeroExit: false,
          observedNonzeroExits: 0,
          watchdog: { msSinceProgress: 2_000, deadlineMs: 60_000 },
        },
      );
      expect(stderr).toHaveLength(1);
      expect(stderr[0]).toContain('AFFECTED_TASK_PROGRESS state=running');
      expect(stderr[0]).toContain('capturedBytes=42 stalledForSec=2');
      expect(readFileSync(log, 'utf8')).toBe(`${stderr[0]}\n`);
      expect(cgroupMemoryObserver.summary()).toMatchObject({ samples: 1, maxAnonMb: 12, peakMb: 16, oomKills: 0 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('affected-tests synchronous spawn failures', () => {
  const source = readFileSync(resolve(__dirname, '../../../../scripts/affected-tests.mjs'), 'utf8');

  it('converts a synchronous E2BIG-class throw into an attributed terminal task result', () => {
    // `spawn()` can throw before returning a ChildProcess (E2BIG does), so an `error`
    // listener alone cannot observe it. Pin all three load-bearing effects: the boundary is
    // caught, the durable output record precedes the terminal progress marker, and the
    // scheduler receives a nonzero attributed result instead of a rejected shard /
    // process-level exit-without-verdict.
    expect(source).toMatch(/try\s*\{\s*child = spawn\(/);
    const catchStart = source.indexOf('    } catch (error) {');
    const catchEnd = source.indexOf('    // EI-21048499991398082:', catchStart);
    expect(catchStart).toBeGreaterThan(-1);
    expect(catchEnd).toBeGreaterThan(catchStart);
    const catchBlock = source.slice(catchStart, catchEnd);
    expect(catchBlock).toMatch(/const result = \{\s*status: 1,[\s\S]*?error: spawnError,/);
    expect(catchBlock).toContain('journalCapturedTaskOutput(');
    expect(catchBlock).toContain('AFFECTED_TASK_PROGRESS state=spawn-error task=${progressTask}');
    expect(catchBlock).toContain('resolveRun(result);');
    expect(catchBlock.indexOf('journalCapturedTaskOutput(')).toBeLessThan(
      catchBlock.indexOf('AFFECTED_TASK_PROGRESS state=spawn-error'),
    );
    expect(catchBlock.indexOf('AFFECTED_TASK_PROGRESS state=spawn-error')).toBeLessThan(
      catchBlock.indexOf('resolveRun(result);'),
    );
  });
});
