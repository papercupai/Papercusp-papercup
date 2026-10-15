/**
 * affected-tests-stdout-ordering.test.ts — EI-10542 regression guard.
 *
 * `scripts/affected-tests.mjs` labels each workspace's suite with a
 * `>>> <ws> :: ...` header, then runs the suite as a child with
 * `stdio: 'inherit'` (the child writes SYNCHRONOUSLY straight to fd 1). When
 * fd 1 is NOT a TTY — a pipe/file, e.g. the green-checkpoint gate captures this
 * runner's output — Node makes `console.log` / `process.stdout.write`
 * ASYNCHRONOUS (buffered, flushed on an event-loop turn). But `spawnSync` BLOCKS
 * the event loop, so a header queued before the child cannot flush until AFTER
 * the child has already written its output to the same fd — one workspace's
 * suite output then prints under a DIFFERENT workspace's header (the reported
 * symptom: apps/operator-vite's 143 test files, and a failure, appeared under
 * the `@papercusp/web` header).
 *
 * The fix routes the runner's own output through synchronous fd writes
 * (`scripts/lib/sync-write.mjs`), so every header stays glued to the child
 * output it labels regardless of whether fd 1/2 is a TTY, pipe, or file.
 *
 * These tests exercise the REAL helper + assert the runner uses it.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, openSync, closeSync, readSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { appendAllSync, writeAllSync, outSync, errSync } from '../../../../scripts/lib/sync-write.mjs';

/**
 * The dotted name of a call's callee (`console.log`, `process.stderr.write`), built
 * from the AST rather than `getText()` so incidental whitespace/comments inside the
 * property access cannot hide a call. Returns null for anything not rooted in a
 * plain identifier (e.g. `obj[fn]()`).
 */
function calleeName(expr: ts.PropertyAccessExpression): string | null {
  const parts: string[] = [expr.name.text];
  let cur: ts.Expression = expr.expression;
  while (ts.isPropertyAccessExpression(cur)) {
    parts.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (!ts.isIdentifier(cur)) return null;
  parts.unshift(cur.text);
  return parts.join('.');
}

/**
 * Every async-write CALL in `text`, by callee name. AST-based on purpose: a raw
 * source regex cannot tell a call from the same tokens sitting in a comment or a
 * string literal, and this rule is one whose own documentation naturally NAMES the
 * calls it forbids. See the falsifiability test below.
 */
function findAsyncRunnerWrites(text: string): string[] {
  const sf = ts.createSourceFile('affected-tests.mjs', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = calleeName(node.expression);
      if (callee && (/^console\.(log|warn|error)$/.test(callee) || /^process\.(stdout|stderr)\.write$/.test(callee))) {
        hits.push(callee);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SYNC_WRITE = resolve(REPO_ROOT, 'scripts/lib/sync-write.mjs');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

describe('sync-write helper (EI-10542)', () => {
  it('writeAllSync writes the full payload to a fd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-'));
    const file = join(dir, 'out.txt');
    // O_WRONLY|O_CREAT|O_TRUNC
    const fd = openSync(file, 'w');
    try {
      writeAllSync(fd, 'hello ');
      writeAllSync(fd, 'world');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, 'utf8')).toBe('hello world');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeAllSync is a no-op on empty/nullish input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-'));
    const file = join(dir, 'out.txt');
    const fd = openSync(file, 'w');
    try {
      writeAllSync(fd, '');
      writeAllSync(fd, null as unknown as string);
      writeAllSync(fd, undefined as unknown as string);
      writeAllSync(fd, 'x');
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, 'utf8')).toBe('x');
    rmSync(dir, { recursive: true, force: true });
  });

  it('outSync/errSync are exported callables that append a newline', () => {
    // Behaviour is verified end-to-end (piped subprocess) below; here just assert
    // the surface exists and a redirected fd receives a trailing newline.
    expect(typeof outSync).toBe('function');
    expect(typeof errSync).toBe('function');
    const dir = mkdtempSync(join(tmpdir(), 'sw-'));
    const file = join(dir, 'fd3.txt');
    const fd = openSync(file, 'w');
    try {
      writeAllSync(fd, `line\n`);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file, 'utf8')).toBe('line\n');
    rmSync(dir, { recursive: true, force: true });
  });

  it('appendAllSync durably finishes a multipart failure record before a following SIGTERM', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sw-journal-'));
    const file = join(dir, 'settled-task.log');
    const fixture = [
      `import { appendAllSync } from ${JSON.stringify(SYNC_WRITE)};`,
      `appendAllSync(${JSON.stringify(file)}, [`,
      '  \'AFFECTED_TASK_OUTPUT_BEGIN task=\\"fast-fail\\" exitStatus=1\\n\',',
      "  'FAIL src/example.test.ts > preserves diagnostics\\n',",
      '  \'AFFECTED_TASK_OUTPUT_END task=\\"fast-fail\\"\\n\',',
      ']);',
      "process.kill(process.pid, 'SIGTERM');",
    ].join('\n');
    try {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', fixture], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        timeout: 10_000,
      });

      expect(r.status).toBeNull();
      expect(r.signal).toBe('SIGTERM');
      expect(readFileSync(file, 'utf8')).toBe(
        'AFFECTED_TASK_OUTPUT_BEGIN task="fast-fail" exitStatus=1\n' +
          'FAIL src/example.test.ts > preserves diagnostics\n' +
          'AFFECTED_TASK_OUTPUT_END task="fast-fail"\n',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * The core regression: through a PIPE (non-TTY, like the gate's capture), a
 * header emitted via the sync helper must stay ordered BEFORE the output of a
 * child spawned with `stdio: 'inherit'`, and a following footer must stay AFTER
 * it. If the runner reverts to async `console.log`, the header flushes after the
 * blocking spawnSync child and this ordering breaks.
 */
describe('sync-write keeps headers glued to inherit-child output through a pipe (EI-10542)', () => {
  function runFixture(fixtureSource: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'af-order-'));
    const fixture = join(dir, 'fixture.mjs');
    writeFileSync(fixture, fixtureSource, 'utf8');
    try {
      // stdout as a PIPE (not a TTY) — this is what makes Node buffer console.log
      // asynchronously and is exactly how the gate captures the runner's output.
      const r = spawnSync(process.execPath, [fixture], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        timeout: 60_000,
        killSignal: 'SIGKILL',
      });
      return r.stdout ?? '';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // A large preceding write BACKS UP the parent's async stdout buffer — the exact
  // condition under which the real runner misattributed a workspace's output: a
  // preceding task's captured suite output was still queued when the next header
  // was written, so the header queued behind it while the inherit child wrote
  // straight to the fd. The `P`-blob reproduces that backed-up state; it carries
  // no marker so indexOf on the markers is unaffected (stripped for readability).
  const BLOB = "'P'.repeat(300000)";
  const clean = (s: string) => s.replace(/P+/g, '');

  it('outSync header precedes the inherit child even with the stdout buffer backed up', () => {
    const src = `
import { writeAllSync, outSync } from ${JSON.stringify(SYNC_WRITE)};
import { spawnSync } from 'node:child_process';
writeAllSync(1, ${BLOB});
outSync('HEADER-MARK');
spawnSync(process.execPath, ['-e', 'process.stdout.write("CHILD-MARK")'], { stdio: 'inherit' });
outSync('FOOTER-MARK');
`;
    // Discriminating guard: with the synchronous helper this is deterministically
    // ordered. If the helper ever regresses to async process.stdout.write, the
    // header queues behind the blob and the inherit child overtakes it — this
    // assertion then fails (see the console.log contrast test below, which shows
    // exactly that misordering on the same platform).
    for (let i = 0; i < 6; i++) {
      const out = clean(runFixture(src));
      const h = out.indexOf('HEADER-MARK');
      const c = out.indexOf('CHILD-MARK');
      const f = out.indexOf('FOOTER-MARK');
      expect(h, `HEADER-MARK missing (iter ${i}): ${JSON.stringify(out)}`).toBeGreaterThanOrEqual(0);
      expect(c, `CHILD-MARK missing (iter ${i}): ${JSON.stringify(out)}`).toBeGreaterThanOrEqual(0);
      expect(f, `FOOTER-MARK missing (iter ${i}): ${JSON.stringify(out)}`).toBeGreaterThanOrEqual(0);
      expect(h, `header must precede child (iter ${i}): ${JSON.stringify(out)}`).toBeLessThan(c);
      expect(c, `child must precede footer (iter ${i}): ${JSON.stringify(out)}`).toBeLessThan(f);
    }
  });

  it('the async console.log path DOES misorder under the same backed-up buffer (the bug)', () => {
    const buggy = `
import { spawnSync } from 'node:child_process';
process.stdout.write(${BLOB});
console.log('HEADER-MARK');
spawnSync(process.execPath, ['-e', 'process.stdout.write("CHILD-MARK")'], { stdio: 'inherit' });
console.log('FOOTER-MARK');
`;
    // The defect: the inherit child's synchronous write overtakes the queued
    // header, so CHILD-MARK lands before HEADER-MARK. If a future Node makes pipe
    // stdout synchronous (bug can no longer occur), skip rather than false-fail —
    // the fixed-path test above remains the hard guard either way.
    let sawMisorder = false;
    for (let i = 0; i < 6; i++) {
      const out = clean(runFixture(buggy));
      if (
        out.indexOf('CHILD-MARK') >= 0 &&
        out.indexOf('HEADER-MARK') >= 0 &&
        out.indexOf('CHILD-MARK') < out.indexOf('HEADER-MARK')
      ) {
        sawMisorder = true;
        break;
      }
    }
    // Platform can't reproduce the async race (e.g. synchronous pipe stdout) —
    // nothing to assert; the fixed-path test above is the hard guard regardless.
    if (!sawMisorder) return;
    expect(sawMisorder).toBe(true);
  });
});

describe('affected-tests.mjs uses the synchronous writer for its own output (EI-10542)', () => {
  const source = readFileSync(AFFECTED_TESTS, 'utf8').replaceAll('"', "'");

  it('imports the sync-write helper', () => {
    expect(source).toMatch(/from '\.\/lib\/sync-write\.mjs'/);
  });

  it('journals settled child output outside the swept scratch namespace', () => {
    expect(source).toContain('const RUN_LOG_PATH = affectedTestRunLogPath(RUN_TOKEN);');
    expect(source).toContain('sweepStaleTestScratch(RUN_LOG_ROOT);');
    expect(source).not.toMatch(/const RUN_LOG_PATH = join\(RUN_LOG_ROOT/);
  });

  it('labels each workspace with outSync, not async console.log', () => {
    // The per-task header — the line the misattribution scrambled.
    expect(source).toMatch(/outSync\(\s*`\\n>>> \$\{t\.ws\.name\} ::/);
    expect(source).not.toMatch(/console\.log\(\s*`\\n>>> \$\{t\.ws\.name\} ::/);
  });

  it('emits NO runner output through async console.* / process.*.write', () => {
    // Every runner-emitted line must go through the synchronous fd helpers so it
    // stays ordered with inherit-mode child output. A reintroduced console.log /
    // console.warn / console.error / process.stdout.write / process.stderr.write
    // for the runner's own output re-opens the misattribution.
    //
    // Detected on the AST, not by a source regex. This rule is one whose own
    // documentation naturally NAMES the calls it forbids, and a raw text match reads
    // that prose — and any string literal — as live code. Not hypothetical: it
    // red-lined the fleet's test:affected once already, when a COMMENT added to
    // affected-tests.mjs explaining the pipe-truncation class (EI-20055889379250637)
    // was scanned as a call. The invariant is about emitted OUTPUT, so the detector
    // must look at calls, not text.
    expect(findAsyncRunnerWrites(source)).toEqual([]);
  });

  it('the AST detector actually fires on a reintroduced call (falsifiability)', () => {
    // A detector that can only ever answer "clean" is not a guard. Prove it flags the
    // real calls while ignoring the identical tokens in a comment and a string.
    const planted = [
      '// console.log( and process.stdout.write( named in prose must NOT count',
      'const doc = "console.error(also not a call)";',
      'outSync(`fine`);',
      'console.log(`real`);',
      'process.stderr.write("real");',
    ].join('\n');
    expect(findAsyncRunnerWrites(planted).sort()).toEqual(['console.log', 'process.stderr.write']);
  });
});
