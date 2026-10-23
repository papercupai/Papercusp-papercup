/**
 * git-index-fault-guard.test.ts — EI-22703095921400106
 *
 * THE RECURRENCE THIS EXISTS TO CATCH
 *   Scoped affected run 471374-afdaa22b (2026-09-08T14:14Z) reported
 *   lint:no-unreachable-tier-mock and lint:di-seam-arity-strands as FAILING while the shared
 *   staging tree's `.git/index` was 0 bytes. Neither guard had a finding: both enumerate their
 *   subject with `git ls-files`, both got `fatal: .git/index: index file smaller than expected`,
 *   and a crashed guard's non-zero exit is indistinguishable from a violation. One transient
 *   index tear reds the affected gate and freezes promotion for the whole fleet — while pointing
 *   the blame at innocent code.
 *
 *   The contract these tests pin: a guard that could not READ the repository reports
 *   EXIT_NOT_CHECKED (2) with a loud banner. Never 1 (a finding). Never 0 (a false green).
 *
 * WHY THE END-TO-END CASES USE GIT_INDEX_FILE
 *   The honest way to prove this is to make a real guard read a real torn index. Truncating the
 *   shared `.git/index` to do that would be catastrophic here — ~100 agents share this checkout,
 *   and git-sync commits the whole tree every few minutes. `GIT_INDEX_FILE` points git at a
 *   throwaway 0-byte file instead, reproducing the incident's EXACT stderr with zero mutation of
 *   the tree: the "mutate a COPY outside the tree" tier from the mutation-probe guidance — no
 *   window, no lock, no restore trap, nothing for a sweep to commit.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';

import {
  EXIT_NOT_CHECKED,
  INDEX_FAULT_CAPTURE_COMMAND,
  INDEX_FAULT_TRACKING_ITEM,
  INDEX_AUDIT_SINK_STATE_PATH,
  RepositoryIndexFaultError,
  isRepositoryIndexFault,
  probeIndexAuditSink,
  reportIndexFaultNotChecked,
  withGitIndexFaultRetry,
} from '../../../scripts/lib/git-index-fault.mjs';
import { runGuardScript } from './testing-guard-script';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The verbatim stderr observed in the incident. */
const REAL_INCIDENT_STDERR = 'fatal: .git/index: index file smaller than expected';

/** Shape of the error execFileSync actually throws (message + stderr, not just one). */
function execFileSyncLikeError(stderr: string, message = 'Command failed: git ls-files') {
  return Object.assign(new Error(message), { stderr, status: 128 });
}

let tmp: string;
let tornIndex: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'git-index-fault-'));
  tornIndex = join(tmp, 'torn-index');
  writeFileSync(tornIndex, ''); // 0 bytes — exactly what the incident observed
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

it('keeps the audit CLI inert when imported into a real sidecar bundle', () => {
  const fakeChildProcess = join(tmp, 'inert-child-process.mjs');
  writeFileSync(fakeChildProcess, 'export function execFileSync() { throw new Error("audit CLI ran from a bundled import"); }');
  const bundle = join(tmp, 'audit-library-bundle.mjs');
  buildSync({
    stdin: {
      contents: 'import "./scripts/lib/git-index-fault.mjs"; console.log("LIBRARY_IMPORTED");',
      resolveDir: REPO_ROOT,
      sourcefile: 'audit-library-entry.mjs',
    },
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    define: { __PAPERCUSP_BUNDLED_SIDECAR__: 'true' },
    alias: { 'node:child_process': fakeChildProcess },
  });
  const result = spawnSync(process.execPath, [bundle, '--audit-sink'], {
    encoding: 'utf8', timeout: 10_000, env: { ...process.env, NODE_OPTIONS: '' },
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe('LIBRARY_IMPORTED');
});

it('reads configured audit logs when capture inherits empty or unrelated piped input', () => {
  const fixtureDir = mkdtempSync(join(tmp, 'audit-capture-'));
  const auditLog = join(fixtureDir, 'audit.log');
  const records = 'type=SYSCALL fixture=stored\ntype=PATH fixture=stored\ntype=PROCTITLE fixture=stored\n';
  writeFileSync(auditLog, records + 'type=USER fixture=not-a-writer\n');
  const sudo = join(fixtureDir, 'sudo');
  // ausearch reads a FIFO on stdin unless --input-logs selects auditd.conf's log.
  // Model that external CLI contract without needing root or the host audit daemon.
  writeFileSync(sudo, '#!' + process.execPath + '\n' + [
    'const fs = require("node:fs");',
    'const args = process.argv.slice(2);',
    'if (args.shift() !== "-n" || args.shift() !== "ausearch") process.exit(2);',
    'process.stdout.write(fs.readFileSync(args.includes("--input-logs") ? process.env.AUDIT_CAPTURE_FIXTURE : 0));',
  ].join('\n'));
  chmodSync(sudo, 0o755);
  for (const input of ['', 'type=SYSCALL fixture=unrelated-stdin\n']) {
    const result = spawnSync('bash', ['-c', INDEX_FAULT_CAPTURE_COMMAND], {
      encoding: 'utf8', input, timeout: 10_000,
      env: { ...process.env, PATH: fixtureDir + ':' + process.env.PATH, AUDIT_CAPTURE_FIXTURE: auditLog },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(records);
  }
});

describe('audit sink persistence — kernel intake is not proof of a live log', () => {
  const marker = 'papercusp-audit-sink-test';
  const healthy = 'writing to logs = yes\nlogging suspended = no\n';
  // Actual auditctl -m record shape, measured with persisted event5572724.
  const receipt = `type=USER msg=audit(1791970000.123:5566084): msg='text=${marker} exe="/usr/sbin/auditctl" hostname=? addr=? terminal=? res=success'`;
  function harness({ state = healthy, stateDelay = 0, receiptDelay = 0, output = receipt } = {}) {
    let clock = 1000;
    let stateReads = 0;
    let searches = 0;
    const calls: { args: string[]; timeout: number }[] = [];
    const options = {
      marker, timeoutMs: 100, pollMs: 10, auditLogPath: '/var/log/audit/audit.log',
      now: () => clock,
      sleep: (ms: number) => { clock += ms; },
      readState: () => ({ text: state, updatedAtMs: ++stateReads > stateDelay ? 1000 : 900 }),
      run: (args: string[], timeout: number) => {
        calls.push({ args, timeout });
        return args[0] === 'ausearch' && ++searches > receiptDelay ? output : '';
      },
    };
    return { options, calls, elapsed: () => clock - 1000 };
  }

  it('detects the observed enabled=1/lost=0 but logging-suspended counterexample', () => {
    const h = harness({ state: 'enabled 1\nlost 0\nwriting to logs = yes\nlogging suspended = yes\n' });
    expect(probeIndexAuditSink(h.options).status).toBe('suspended');
    expect(h.calls.map(c => c.args)).toEqual([['auditctl', '--signal', 'state']]);
  });

  it('detects disabled log writes even if the suspension field says no', () => {
    const h = harness({ state: 'writing to logs = no\nlogging suspended = no\n' });
    expect(probeIndexAuditSink(h.options).status).toBe('suspended');
  });

  it('requires a fresh snapshot AND the uniquely tagged persisted USER event', () => {
    const h = harness({ stateDelay: 2, receiptDelay: 2 });
    expect(probeIndexAuditSink(h.options)).toEqual({
      status: 'live', reason: 'fresh-daemon-state-and-persisted-positive-control',
      marker, stateUpdatedAtMs: 1000, eventId: '1791970000.123:5566084',
    });
    expect(h.elapsed()).toBe(40);
    expect(h.calls.some(c => c.args.includes('resume'))).toBe(false);
    expect(h.calls.filter(c => c.args[0] === 'ausearch').every(c => c.args.slice(1, 3).join(' ') === '--input /var/log/audit/audit.log')).toBe(true);
    expect(INDEX_AUDIT_SINK_STATE_PATH).toBe('/run/auditd.state');
  });

  it('reads the configured sink instead of scanning rotated log history', () => {
    const h = harness();
    const run = h.options.run;
    const options = { ...h.options, auditLogPath: undefined, run: (args: string[], timeout: number) => {
      if (args.join(' ') === 'cat /etc/audit/auditd.conf') return '# comment\nlog_file = /custom/current.log\n';
      return run(args, timeout);
    } };
    expect(probeIndexAuditSink(options).status).toBe('live');
    expect(h.calls.find(c => c.args[0] === 'ausearch')?.args.slice(1, 3)).toEqual(['--input', '/custom/current.log']);
  });

  it('does not emit a control when the configured sink is unavailable', () => {
    const h = harness();
    expect(probeIndexAuditSink({ ...h.options, auditLogPath: undefined })).toMatchObject({ status: 'unknown', reason: 'configured-audit-log-unavailable' });
    expect(h.calls.some(c => c.args[1] === '-m')).toBe(false);
  });

  it('preserves timeout evidence without reading a failed search as a negative result', () => {
    const h = harness();
    const run = h.options.run;
    h.options.run = (args, timeout) => {
      if (args[0] === 'ausearch') throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
      return run(args, timeout);
    };
    expect(probeIndexAuditSink(h.options)).toMatchObject({ status: 'unknown', reason: 'positive-control-search-failed', errorCode: 'ETIMEDOUT' });
  });

  it('allows asynchronous creation of the snapshot after a missing first read', () => {
    const h = harness();
    const read = h.options.readState;
    let reads = 0;
    h.options.readState = () => {
      if (++reads === 1) throw new Error('ENOENT');
      return read();
    };
    expect(probeIndexAuditSink(h.options).status).toBe('live');
    expect(h.elapsed()).toBe(10);
  });

  it('expires a stale snapshot without asserting healthy or emitting a probe', () => {
    const h = harness({ stateDelay: 100 });
    expect(probeIndexAuditSink(h.options)).toMatchObject({ status: 'unknown', reason: 'fresh-daemon-state-unavailable' });
    expect(h.elapsed()).toBe(100);
    expect(h.calls).toHaveLength(1);
  });

  it('does not accept a snapshot from the future', () => {
    const h = harness();
    h.options.readState = () => ({ text: healthy, updatedAtMs: 2000 });
    expect(probeIndexAuditSink(h.options).status).toBe('unknown');
  });

  it('does not infer readiness from absent or malformed daemon fields', () => {
    const h = harness({ state: 'enabled 1\nlost 0\nlogging suspended = maybe\n' });
    expect(probeIndexAuditSink(h.options)).toMatchObject({ status: 'unknown', reason: 'daemon-state-fields-unreadable' });
  });

  for (const output of ['', receipt.replace(marker, marker + '-other'), receipt.replace('type=USER ', 'type=PROCTITLE '), receipt.replace('res=success', 'res=failed'), receipt.replace('text=', 'command=')]) {
    it(`does not accept an empty, unrelated, echoed or failed receipt: ${output}`, () => {
      const h = harness({ output });
      expect(probeIndexAuditSink(h.options)).toMatchObject({ status: 'unknown', reason: 'positive-control-not-persisted-before-deadline' });
      expect(h.elapsed()).toBe(100);
      expect(h.calls.every(c => c.timeout > 0 && c.timeout <= 100)).toBe(true);
    });
  }

  it('waits for the asynchronous receipt on ausearch no-match, but not a permission error', () => {
    const h = harness();
    const run = h.options.run;
    let first = true;
    h.options.run = (args, timeout) => {
      if (args[0] === 'ausearch' && first) {
        first = false;
        throw Object.assign(new Error('<no matches>'), { status: 1 });
      }
      return run(args, timeout);
    };
    expect(probeIndexAuditSink(h.options).status).toBe('live');
    expect(h.elapsed()).toBe(10);
    const denied = harness();
    const deniedRun = denied.options.run;
    denied.options.run = (args, timeout) => {
      if (args[0] === 'ausearch') throw Object.assign(new Error('permission denied'), { status: 1 });
      return deniedRun(args, timeout);
    };
    expect(probeIndexAuditSink(denied.options)).toMatchObject({ status: 'unknown', reason: 'positive-control-search-failed' });
  });

  for (const phase of ['state', 'emission']) {
    it(`reports a failed ${phase} request as unknown without changing audit configuration`, () => {
      const h = harness();
      h.options.run = (args) => {
        if (phase === 'state' || args.includes('-m')) throw new Error('sudo refused');
        return '';
      };
      expect(probeIndexAuditSink(h.options)).toMatchObject({
        status: 'unknown', reason: phase === 'state' ? 'daemon-state-request-failed' : 'positive-control-emission-failed',
      });
    });
  }

  it('rejects unsafe markers before running any privileged command', () => {
    const h = harness();
    expect(probeIndexAuditSink({ ...h.options, marker: 'bad\nmarker' }).status).toBe('unknown');
    expect(h.calls).toHaveLength(0);
  });
});

describe('classification — what counts as "the instrument could not read the repository"', () => {
  it('recognises the incident stderr verbatim', () => {
    expect(isRepositoryIndexFault(execFileSyncLikeError(REAL_INCIDENT_STDERR))).toBe(true);
  });

  it('recognises the fault when git wrote it to the message rather than stderr', () => {
    expect(isRepositoryIndexFault(new Error(REAL_INCIDENT_STDERR))).toBe(true);
  });

  it('recognises the rest of git read-cache.c\'s index-corruption family', () => {
    for (const stderr of [
      'fatal: bad index file sha1 signature',
      'fatal: index file corrupt',
      'error: unknown index entry format 0x00000001',
      'fatal: malformed index info',
    ]) {
      expect(isRepositoryIndexFault(execFileSyncLikeError(stderr)), stderr).toBe(true);
    }
  });

  // CALIBRATIONS. Every one of these, if matched, would convert a REAL failure into a silent
  // NOT_CHECKED — the false-GREEN direction, strictly worse than the false-red being fixed.
  // This is the half of the contract that keeps the fix from becoming a bigger bug than the bug.
  it('does NOT match an ordinary guard failure', () => {
    expect(isRepositoryIndexFault(new Error('3 mock defaults contradict a CONSTANT predicate'))).toBe(false);
  });

  it('does NOT match an unrelated git failure', () => {
    for (const stderr of [
      'fatal: not a git repository (or any of the parent directories): .git',
      "fatal: pathspec 'nope.ts' did not match any files",
      'error: Your local changes to the following files would be overwritten by merge',
      'fatal: unable to access https://github.com/: Could not resolve host',
    ]) {
      expect(isRepositoryIndexFault(execFileSyncLikeError(stderr)), stderr).toBe(false);
    }
  });

  it('does NOT match a bare non-zero exit with no diagnostic', () => {
    expect(isRepositoryIndexFault(Object.assign(new Error('Command failed'), { status: 1 }))).toBe(false);
    expect(isRepositoryIndexFault(undefined)).toBe(false);
    expect(isRepositoryIndexFault(null)).toBe(false);
  });

  it('does NOT match a file that merely MENTIONS the index in unrelated prose', () => {
    // A guard scanning source could surface this text in its own findings; matching it would
    // make the guard silently stop guarding whenever it found something.
    expect(isRepositoryIndexFault(new Error('rebuild the search index file when it grows'))).toBe(false);
  });
});

describe('retry — the fault is transient and self-healing, so recover the REAL verdict', () => {
  it('returns the real value when the index recovers mid-retry', () => {
    let calls = 0;
    const value = withGitIndexFaultRetry(
      () => {
        calls += 1;
        if (calls < 3) throw execFileSyncLikeError(REAL_INCIDENT_STDERR);
        return 'a.ts\nb.ts';
      },
      { delayMs: 1 },
    );
    // The point of the whole retry: a blip must NOT cost the guard its verdict.
    expect(value).toBe('a.ts\nb.ts');
    expect(calls).toBe(3);
  });

  it('throws RepositoryIndexFaultError — never a partial or empty result — when it persists', () => {
    let calls = 0;
    expect(() =>
      withGitIndexFaultRetry(
        () => {
          calls += 1;
          throw execFileSyncLikeError(REAL_INCIDENT_STDERR);
        },
        { attempts: 3, delayMs: 1 },
      ),
    ).toThrow(RepositoryIndexFaultError);
    expect(calls).toBe(3);
  });

  it('quotes git\'s own diagnostic, not execFileSync\'s "Command failed" framing', () => {
    try {
      withGitIndexFaultRetry(
        () => {
          throw execFileSyncLikeError(REAL_INCIDENT_STDERR);
        },
        { attempts: 1, delayMs: 1 },
      );
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as Error).message).toContain('index file smaller than expected');
    }
  });

  it('does NOT retry a non-index error — it propagates on the first attempt', () => {
    let calls = 0;
    expect(() =>
      withGitIndexFaultRetry(
        () => {
          calls += 1;
          throw new Error('some other failure');
        },
        { attempts: 5, delayMs: 1 },
      ),
    ).toThrow('some other failure');
    expect(calls).toBe(1); // widening the retry to every error would mask real breakage
  });
});

describe('reporting — an undetermined run announces itself', () => {
  it('returns EXIT_NOT_CHECKED (2) and says NOT CHECKED for an index fault', () => {
    const lines: string[] = [];
    const code = reportIndexFaultNotChecked(execFileSyncLikeError(REAL_INCIDENT_STDERR), {
      guard: 'demo-guard',
      log: (m: string) => lines.push(m),
    });
    expect(code).toBe(EXIT_NOT_CHECKED);
    expect(code).not.toBe(0); // a false green
    expect(code).not.toBe(1); // a false finding
    const text = lines.join('\n');
    expect(text).toContain('NOT CHECKED');
    expect(text).toContain('demo-guard');
    expect(text).toContain('index file smaller than expected');
  });

  it('tells the agent who hits a torn index to CAPTURE the writer, not to wait it out (WI-10004911)', () => {
    // The torn-index writer is still unknown after three recurrences, and the auditd trail that
    // names it rotates within hours. The banner is printed at the one moment someone is looking,
    // so it must carry the capture command and the owning item; calling the fault a "known
    // transient" is exactly what let two earlier items close without a cause.
    const lines: string[] = [];
    reportIndexFaultNotChecked(execFileSyncLikeError(REAL_INCIDENT_STDERR), {
      guard: 'demo-guard',
      log: (m: string) => lines.push(m),
    });
    const text = lines.join('\n');
    expect(text).toContain(INDEX_FAULT_TRACKING_ITEM);
    expect(text).toContain(INDEX_FAULT_CAPTURE_COMMAND);
    expect(INDEX_FAULT_CAPTURE_COMMAND).toContain('-k papercusp-gitindex');
    expect(INDEX_FAULT_CAPTURE_COMMAND).toContain('--start recent');
    expect(text).not.toMatch(/known transient/i);
  });

  it('returns null for a non-index error so the caller rethrows instead of swallowing it', () => {
    expect(reportIndexFaultNotChecked(new Error('real violation'), { guard: 'x', log: () => {} })).toBeNull();
  });

  it('does not treat an armed watch or empty search as proof of audit sink persistence', () => {
    const lines: string[] = [];
    reportIndexFaultNotChecked(execFileSyncLikeError(REAL_INCIDENT_STDERR), {
      log: (m: string) => lines.push(m),
    });
    const text = lines.join('\n');
    expect(text).toContain('--audit-sink');
    expect(text).toContain('logging suspended');
    expect(text).toContain('empty search is inconclusive');
    expect(text).not.toContain('it names every process');
  });

  // runGuardWithIndexFaultGuard wraps `main` in a SYNC try/catch. An ASYNC main returns a
  // promise whose rejection never reaches that catch, so the wrapper silently guards NOTHING
  // while the call site looks correctly wired — false SAFETY, which is the same failure shape
  // as the false GREEN this work-item is about. Run in a subprocess because the guard's
  // success path calls process.exit.
  //
  // The two arms differ ONLY in `async`, so a regression cannot pass this by accident.
  for (const [shape, decl] of [
    ['sync', 'function'],
    ['async', 'async function'],
  ] as const) {
    it(`guards an ${shape} main(): index fault becomes NOT_CHECKED, never a violation-shaped exit`, () => {
      const run = runGuardScript(
        'node',
        [
          '--input-type=module',
          '-e',
          `import { runGuardWithIndexFaultGuard } from './scripts/lib/git-index-fault.mjs';
           ${decl} main() { throw Object.assign(new Error('boom'), { stderr: ${JSON.stringify(REAL_INCIDENT_STDERR)} }); }
           await runGuardWithIndexFaultGuard(main, { guard: 'async-probe' });`,
        ],
        { cwd: REPO_ROOT, timeoutMs: 30_000 },
      );
      expect(run.status, run.output).toBe(EXIT_NOT_CHECKED);
      expect(run.status, run.output).not.toBe(1);
      expect(run.stderr, run.output).toContain('NOT CHECKED');
    });
  }
});

describe('tracked-files — an unreadable index must never read as "no files"', () => {
  // THE SECOND, WORSE DEFECT, found while fixing the first (EI-22703095921400106).
  //
  // scripts/lib/tracked-files.mjs is the shared enumerator behind ~52 guards. Its helpers ended
  // in `catch { return [] }` with stderr discarded — correct for the shape it was written for (an
  // archive/checkpoint snapshot with no .git), silently wrong for a torn index. MEASURED on this
  // tree with a 0-byte index: listTrackedFiles() returned 35,742 files healthy and 0 files, NO
  // ERROR, torn. Every guard on it would then report a confident ✓ having scanned nothing.
  //
  // That is a false GREEN — strictly worse than the false RED this work-item started from. A red
  // gate is loud and gets fixed; a guard that scans zero files and passes lets real violations
  // through and nobody ever learns.
  const probe = (source: string, env: NodeJS.ProcessEnv) =>
    runGuardScript('node', ['--input-type=module', '-e', source], {
      cwd: REPO_ROOT,
      timeoutMs: 60_000,
      env,
    });

  const LIST_TRACKED = `
    import { listTrackedFiles } from './scripts/lib/tracked-files.mjs';
    try { console.log('FILES=' + listTrackedFiles().files.length); }
    catch (e) { console.log('THREW=' + e.message.split('\\n')[0]); }
  `;

  // Assert on `stdout`, NEVER on `output`. `runGuardScript` prefixes `output` with the echoed
  // command, and these probes carry both marker strings in their own source — so an assertion
  // against `output` matches the SCRIPT TEXT and passes whatever the program actually printed.
  // Caught here by the no-.git case failing while genuinely behaving correctly; the torn-index
  // case was passing VACUOUSLY for exactly the same reason.
  it('CONTROL: enumerates the real tree when the index is healthy', () => {
    const run = probe(LIST_TRACKED, process.env);
    expect(run.stdout, run.output).toMatch(/FILES=\d+/);
    const count = Number(/FILES=(\d+)/.exec(run.stdout)?.[1] ?? 0);
    // Guards against the other silent-empty failure this module exists to prevent.
    expect(count, run.output).toBeGreaterThan(1000);
  });

  it('THROWS on a torn index instead of returning an empty enumeration', () => {
    const run = probe(LIST_TRACKED, { ...process.env, GIT_INDEX_FILE: tornIndex });
    expect(run.stdout, run.output).toContain('THREW=');
    expect(run.stdout, run.output).toContain('index file smaller than expected');
    // The regression itself: `FILES=0` here is a guard about to pass having read nothing.
    expect(run.stdout, run.output).not.toContain('FILES=0');
  });

  it('still returns [] for the EXPECTED no-.git shape — the quiet-probe contract is preserved', () => {
    // An archive/checkpoint snapshot legitimately has no .git. Throwing there would break the
    // filesystem-fallback path, so the fix had to stay narrow to the index-fault class.
    const run = probe(
      `
      import { mkdtempSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { listTrackedFiles } from './scripts/lib/tracked-files.mjs';
      const dir = mkdtempSync(tmpdir() + '/no-git-');
      try { console.log('FILES=' + listTrackedFiles(dir).files.length); }
      catch (e) { console.log('THREW=' + e.message.split('\\n')[0]); }
      `,
      process.env,
    );
    expect(run.stdout, run.output).toContain('FILES=0');
    expect(run.stdout, run.output).not.toContain('THREW=');
  });
});

describe('END TO END — the real guards against a real torn index', () => {
  // The environment control. If git itself were broken, every case below would "pass" for the
  // wrong reason, so establish that git reads the HEALTHY index fine in this same environment.
  it('CONTROL: git reads the real index normally here', () => {
    const out = execFileSync('git', ['ls-files', '--', 'package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    expect(out).toContain('package.json');
  });

  it('CONTROL: a 0-byte GIT_INDEX_FILE really does reproduce the incident stderr', () => {
    let stderr = '';
    try {
      execFileSync('git', ['ls-files'], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, GIT_INDEX_FILE: tornIndex },
        timeout: 120_000,
        killSignal: 'SIGKILL',
      });
      expect.unreachable('git should have failed on a 0-byte index');
    } catch (error) {
      stderr = String((error as { stderr?: string }).stderr ?? (error as Error).message);
    }
    expect(stderr).toContain('index file smaller than expected');
  });

  // THE FALSIFIABILITY CONTROL, and the measurement behind this work-item's causal claim.
  //
  // Without the wrapper, `git ls-files` on a torn index throws out of execFileSync, node dies,
  // and the process exits 1 — BYTE-IDENTICAL to "this guard found a violation". That is the
  // whole defect: the affected runner cannot tell the two apart. Asserting it here makes the
  // guard cases below non-vacuous — same environment, same torn index, only the wrapper differs
  // (MEASURED 2026-09-08: unwrapped exit 1, wrapped exit 2).
  it('CONTROL: the UNWRAPPED call exits 1 — indistinguishable from a finding', () => {
    const run = runGuardScript(
      'node',
      ['-e', "require('node:child_process').execFileSync('git',['ls-files'],{encoding:'utf8'})"],
      { cwd: REPO_ROOT, timeoutMs: 30_000, env: { ...process.env, GIT_INDEX_FILE: tornIndex } },
    );
    expect(run.status, run.output).toBe(1);
    expect(run.status, run.output).not.toBe(EXIT_NOT_CHECKED);
  });

  for (const guard of [
    { name: 'unreachable-tier-mock', script: 'scripts/check-unreachable-tier-mock.mjs', args: [] as string[] },
    { name: 'di-seam-arity-strands', script: 'scripts/check-di-seam-arity-strands.mjs', args: [] as string[] },
    // `main()` in this one is ASYNC, which a sync try/catch around it would NOT guard: the
    // promise rejection escapes entirely and the process dies with a raw stack and exit 1 —
    // violation-shaped — while the call site LOOKS protected. So this row is also the
    // regression test for the async branch of runGuardWithIndexFaultGuard.
    //
    // `--base HEAD` is deliberate: a bare invocation short-circuits on "no migration files
    // given" BEFORE reaching any git enumeration, which would make this case vacuous.
    {
      name: 'migration-fixture-drift',
      script: 'scripts/check-migration-fixture-drift.mjs',
      args: ['--base', 'HEAD'],
    },
  ]) {
    it(`${guard.name}: exits NOT_CHECKED, not a violation, when the index is torn`, () => {
      const run = runGuardScript('node', [guard.script, ...guard.args], {
        cwd: REPO_ROOT,
        timeoutMs: 120_000,
        env: { ...process.env, GIT_INDEX_FILE: tornIndex },
      });

      // THE REGRESSION ITSELF: before the fix this was 1 (or a crash), which the affected
      // runner reports as a failing lint against code that was never even read.
      expect(run.status, run.output).toBe(EXIT_NOT_CHECKED);
      expect(run.status, run.output).not.toBe(1);
      // stderr, not `output`: `output` echoes the command, and the script PATH already contains
      // the guard name ('scripts/check-di-seam-arity-strands.mjs'), so asserting the banner
      // against `output` would match the echo and pass however the guard actually behaved.
      expect(run.stderr, run.output).toContain('NOT CHECKED');
      expect(run.stderr, run.output).toContain(guard.name);
      expect(run.stderr, run.output).toContain('index file smaller than expected');
    }, 130_000);
  }
});
