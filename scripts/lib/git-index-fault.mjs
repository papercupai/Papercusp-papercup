// scripts/lib/git-index-fault.mjs
//
// EI-22703095921400106 (2026-09-08): a guard that cannot READ the repository must report
// "I could not look", never "your code is in violation".
//
// THE BUG THIS EXISTS TO KILL
//   Scoped affected run 471374-afdaa22b failed BOTH lint:no-unreachable-tier-mock and
//   lint:di-seam-arity-strands at 2026-09-08T14:14Z. Neither had a finding. Both shell out to
//   `git ls-files` to enumerate their subject, and both got:
//
//       fatal: .git/index: index file smaller than expected
//
//   The canonical .git/index was observed at exactly 0 bytes while git-sync was active on the
//   shared staging tree; it self-resolved (3,796,841 bytes / 28,265 paths a few hours later).
//   `execFileSync` throws on that non-zero exit, the guard dies, and the runner sees a non-zero
//   status — which reads as A LINT VIOLATION. One transient index tear therefore reds the
//   affected gate and freezes promotion for the whole fleet, while pointing at innocent code.
//
//   That is the exact false-verdict class this repo legislates against everywhere else:
//   `LINT_TSC_RESULT status=` partial-vs-clean, `state:read` `status:'unknown'` being in-band,
//   `TEST_FILE_ROUTE_ERROR`/`matched=0` meaning UNDETERMINED, and — stated verbatim in
//   scripts/affected-tests.mjs at the EXIT_NOT_CHECKED definition — "a gate that collapses those
//   into `status !== 0` reads 'I could not look' as 'violation'".
//
// WHY A TORN INDEX IS AN ACCEPTED STATE HERE, NOT AN EMERGENCY
//   packages/operator-core/lib/harness/git-sync/run-git-sync.ts already treats it as one:
//   `preflightInvalidIndex` (with MIN_VALID_GIT_INDEX_BYTES = 12 + 20, the header+checksum floor)
//   detects a short/zero index and rebuilds it with `git read-tree HEAD`. So the repository
//   already self-heals this — but ONLY on the git-sync tick. The affected-test guards read the
//   same index with no equivalent protection. The gap is SCOPE, not knowledge.
//
// WHY RETRY BEFORE REPORTING UNDETERMINED
//   The tear is transient and self-healing, so a bounded retry usually recovers the guard's REAL
//   verdict. Reporting NOT_CHECKED immediately would be honest but lossy: it converts a
//   recoverable blip into a permanently unjudged candidate, which is how a guard quietly stops
//   guarding. Retry first; surrender only if it persists.
//
// WHY THIS DOES NOT REPAIR THE INDEX ITSELF
//   Deliberate. `git read-tree HEAD` is a WRITE, and these guards are read-only instruments
//   running concurrently with the writer that owns repair (git-sync). A lint script racing
//   git-sync to rewrite the shared index would be a second uncoordinated writer of exactly the
//   kind suspected in the original incident. Detect, wait, re-read, and otherwise stand down.
//
// SCOPE DISCIPLINE (the reason the pattern list below is deliberately narrow)
//   Every pattern here converts a hard failure into a NON-finding. An over-broad matcher would
//   silently swallow genuine guard failures — the false-GREEN direction, strictly worse than the
//   false-red it replaces. So this matches only git's own unambiguous index-corruption strings,
//   and only when the error really came from a failed git invocation.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { EXIT_NOT_CHECKED } from './not-checked.mjs';

export { EXIT_NOT_CHECKED };

/**
 * The work-item that owns the still-UNDIAGNOSED torn-index writer (three recurrences:
 * 2026-09-08 ×2, 2026-10-01; the earlier items closed without a cause). The banner names it so
 * the agent who hits the NEXT recurrence posts evidence there instead of filing a fourth orphan.
 */
export const INDEX_FAULT_TRACKING_ITEM = 'WI-10004911';

/**
 * Reads the auditd watch (key `papercusp-gitindex`, /etc/audit/rules.d/60-papercusp-gitindex.rules)
 * that can record processes writing `.git/index` / `index.lock` while its sink is live.
 * Force the configured log source: ausearch otherwise reads piped stdin in noninteractive
 * jobs, where an empty pipe produces a false no-match despite persisted audit events.
 * An empty search cannot establish that no writer exists. `--start recent` is the last 10
 * minutes — the banner fires while the index is torn, so the write that tore it is in that window.
 * Do NOT swap in an explicit `--start 'MM/DD/YYYY HH:MM:SS'`: on this box that form returned 0
 * records for a window the raw log proved held thousands (measured 2026-10-01).
 */
export const INDEX_FAULT_CAPTURE_COMMAND =
  "sudo -n ausearch --input-logs -k papercusp-gitindex -i --start recent | grep -E '^type=(SYSCALL|PATH|PROCTITLE)'";

export const INDEX_AUDIT_SINK_STATE_PATH = '/run/auditd.state';
export const INDEX_AUDIT_SINK_PROBE_COMMAND = 'node scripts/lib/git-index-fault.mjs --audit-sink';

/**
 * EI-25949667985509297: enabled=1/lost=0 describes kernel intake, not persistence.
 * Request a NEW daemon snapshot (the signal writes asynchronously), then prove persistence
 * with a unique USER message read back from the log. Never resume/reconfigure auditd here.
 * This explicit diagnostic shares the index-fault seam; normal guards do not signal auditd.
 * All subprocesses, snapshot convergence and receipt reads share one finite time budget.
 *
 * @param {{ timeoutMs?: number, pollMs?: number,
 *   run?: (args: string[], timeoutMs: number) => string,
 *   readState?: (timeoutMs: number) => { text: string, updatedAtMs: number },
 *   now?: () => number, sleep?: (ms: number) => void, marker?: string, auditLogPath?: string }} [options]
 * @returns {{ status: 'live' | 'suspended' | 'unknown', reason: string,
 *   marker: string, stateUpdatedAtMs?: number, eventId?: string, errorCode?: string }}
 */
export function probeIndexAuditSink({
  timeoutMs = 3000, pollMs = 50,
  run = (args, budget) => execFileSync('sudo', ['-n', ...args], {
    encoding: 'utf8', timeout: budget, killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }),
  readState, now = Date.now, sleep = sleepSync,
  marker = `papercusp-audit-sink-${randomUUID()}`, auditLogPath,
} = {}) {
  const started = now();
  const deadline = started + Math.min(10_000, Math.max(1, timeoutMs));
  const remaining = () => Math.max(1, Math.ceil(deadline - now()));
  const unknown = (reason, error = undefined) => ({
    status: /** @type {'unknown'} */ ('unknown'), reason, marker,
    ...(error ? { errorCode: String(error.code ?? error.status ?? 'unknown') } : {}),
  });
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(marker)) return unknown('invalid-positive-control-marker');
  const snapshot = readState ?? ((budget) => {
    const before = statSync(INDEX_AUDIT_SINK_STATE_PATH);
    const text = run(['cat', INDEX_AUDIT_SINK_STATE_PATH], budget);
    const after = statSync(INDEX_AUDIT_SINK_STATE_PATH);
    if (before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error('snapshot changed while reading');
    return { text, updatedAtMs: after.mtimeMs };
  });
  const wait = () => sleep(Math.min(Math.max(1, pollMs), Math.max(0, deadline - now())));
  try {
    run(['auditctl', '--signal', 'state'], remaining());
  } catch (error) { return unknown('daemon-state-request-failed', error); }
  let state;
  while (now() < deadline) {
    try {
      const candidate = snapshot(remaining());
      if (Number.isFinite(candidate.updatedAtMs) && candidate.updatedAtMs >= started && candidate.updatedAtMs <= now()) {
        state = candidate;
        break;
      }
    } catch { /* The asynchronous snapshot may not exist yet. */ }
    wait();
  }
  if (!state || now() >= deadline) return unknown('fresh-daemon-state-unavailable');
  const field = (name) => new RegExp(`^${name}\\s*=\\s*(yes|no)\\s*$`, 'im').exec(state.text)?.[1].toLowerCase();
  const suspended = field('logging suspended');
  const writing = field('writing to logs');
  if (suspended === 'yes' || writing === 'no') {
    return { status: 'suspended', reason: 'daemon-log-persistence-disabled', marker, stateUpdatedAtMs: state.updatedAtMs };
  }
  if (suspended !== 'no' || writing !== 'yes') return unknown('daemon-state-fields-unreadable');
  try {
    // A newly emitted event belongs to the current log. Scanning rotated history can
    // exhaust the whole deadline before reaching it. Reuse auditd's configured sink;
    // a rotation race/missing receipt remains UNKNOWN, never evidence of no writer.
    if (!auditLogPath) {
      const config = run(['cat', '/etc/audit/auditd.conf'], remaining());
      auditLogPath = /^\s*log_file\s*=\s*(\/\S+)\s*$/m.exec(config)?.[1];
    }
    if (!auditLogPath?.startsWith('/') || /[\r\n\0]/.test(auditLogPath)) return unknown('configured-audit-log-unavailable');
    if (now() >= deadline) return unknown('positive-control-deadline-expired');
    run(['auditctl', '-m', marker], remaining());
  } catch (error) { return unknown('positive-control-emission-failed', error); }
  while (now() < deadline) {
    try {
      const records = run(['ausearch', '--input', auditLogPath, '-m', 'USER', '--start', 'recent', '--raw'], remaining());
      // Match the actual USER record, never PROCTITLE/command echo or another probe's marker.
      const receipt = records.split('\n').find((line) =>
        /^type=USER\s/.test(line) && line.includes(`msg='text=${marker} `) && /\bres=success\b/.test(line));
      const eventId = receipt && /\bmsg=audit\(([^)]+)\)/.exec(receipt)?.[1];
      if (eventId && now() < deadline) return {
        status: 'live', reason: 'fresh-daemon-state-and-persisted-positive-control', marker,
        stateUpdatedAtMs: state.updatedAtMs, eventId,
      };
    } catch (error) {
      // ausearch's documented no-match exit can precede the asynchronous log write.
      if (error?.status !== 1 || !/<no matches>/.test(errorText(error))) return unknown('positive-control-search-failed', error);
    }
    wait();
  }
  return unknown('positive-control-not-persisted-before-deadline');
}

/**
 * Git's own error strings for an unreadable/torn index, from read-cache.c.
 *
 * Each is unambiguous about the INDEX specifically — none can be produced by a guard's own
 * logic, a missing file, or an ordinary non-zero lint exit. Anything less specific (a bare
 * "fatal:", "cannot read", an exit code alone) is deliberately NOT here: see SCOPE DISCIPLINE.
 */
const INDEX_FAULT_PATTERNS = [
  /index file smaller than expected/i,
  /bad index file sha1 signature/i,
  /index file corrupt/i,
  /unknown index entry format/i,
  /malformed index info/i,
  /broken index file/i,
  /\.git[/\\]index[^\n]*\b(?:corrupt|truncated)\b/i,
];

/**
 * The git diagnostic itself, not the wrapper's framing.
 *
 * execFileSync's own `error.message` leads with "Command failed: git ls-files …", which says
 * nothing about WHY. Pull the line that actually matched, so the NOT CHECKED banner quotes
 * git ("index file smaller than expected") rather than a generic failure notice.
 */
function indexFaultDiagnostic(error) {
  const lines = errorText(error).split('\n');
  const matched = lines.find((line) => INDEX_FAULT_PATTERNS.some((re) => re.test(line)));
  return (matched ?? lines.find(Boolean) ?? '(no diagnostic)').trim();
}

/** Text a thrown child-process error can carry the git diagnostic in. */
function errorText(error) {
  if (!error) return '';
  const parts = [
    error.message,
    error.stderr,
    error.stdout,
    Array.isArray(error.output) ? error.output.join('\n') : undefined,
  ];
  return parts
    .map((p) => (p == null ? '' : Buffer.isBuffer(p) ? p.toString('utf8') : String(p)))
    .join('\n');
}

/**
 * Is this error git telling us the repository index is unreadable?
 *
 * TRUE means "the instrument failed", never "the subject is in violation". Callers must convert
 * a true here into an UNDETERMINED verdict, never into a finding and never into a silent pass.
 */
export function isRepositoryIndexFault(error) {
  const text = errorText(error);
  if (!text) return false;
  return INDEX_FAULT_PATTERNS.some((re) => re.test(text));
}

/** Thrown when the index is still unreadable after every retry. */
export class RepositoryIndexFaultError extends Error {
  constructor(message, { attempts, cause } = {}) {
    super(message);
    this.name = 'RepositoryIndexFaultError';
    this.isRepositoryIndexFault = true;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Sleep on the main thread.
 *
 * These guards are synchronous end to end (execFileSync), so the retry has to be too. Atomics
 * .wait on a private SharedArrayBuffer is the supported synchronous sleep in Node; a busy-wait
 * would burn a core on a box that is already contended enough to tear an index in the first place.
 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a git-reading closure, retrying only the repository-index-fault class.
 *
 * Any OTHER error propagates untouched and immediately — this widens nothing, it only makes the
 * one known-transient, known-self-healing fault recoverable. Returns the closure's value; throws
 * RepositoryIndexFaultError if the index is still unreadable after `attempts`.
 *
 * Defaults (4 attempts, 250ms, doubling → ~1.75s worst case) are sized to git-sync's repair
 * window while staying far below any guard's own runtime, so a healthy run pays nothing at all:
 * the retry path is entered only after a fault has already been classified.
 *
 * @template T
 * @param {() => T} run
 * @param {{ attempts?: number, delayMs?: number, onRetry?: (info: { attempt: number, of: number, delayMs: number, error: unknown }) => void }} [options]
 * @returns {T}
 */
export function withGitIndexFaultRetry(run, { attempts = 4, delayMs = 250, onRetry } = {}) {
  const total = Math.max(1, attempts);
  let lastError;

  for (let attempt = 1; attempt <= total; attempt += 1) {
    try {
      return run();
    } catch (error) {
      if (!isRepositoryIndexFault(error)) throw error;
      lastError = error;
      if (attempt < total) {
        const wait = delayMs * 2 ** (attempt - 1);
        if (typeof onRetry === 'function') onRetry({ attempt, of: total, delayMs: wait, error });
        sleepSync(wait);
      }
    }
  }

  throw new RepositoryIndexFaultError(
    `repository index unreadable after ${total} attempt(s): ${indexFaultDiagnostic(lastError)}`,
    { attempts: total, cause: lastError },
  );
}

/**
 * Print the UNDETERMINED banner for a persistent index fault and return EXIT_NOT_CHECKED.
 *
 * Returns null when the error is NOT an index fault, so the caller rethrows instead of
 * swallowing it. The banner is deliberately loud and names the guard: a NOT_CHECKED run is a
 * hole in coverage, and a quiet hole is how a guard stops guarding without anyone noticing.
 *
 * @param {unknown} error
 * @param {{ guard?: string, log?: (...args: any[]) => void }} [options]
 * @returns {number | null} EXIT_NOT_CHECKED for an index fault, else null.
 */
export function reportIndexFaultNotChecked(error, { guard, log = console.error } = {}) {
  if (!isRepositoryIndexFault(error) && !error?.isRepositoryIndexFault) return null;

  const name = guard ?? 'guard';
  log(`\n⚠ ${name}: NOT CHECKED — the repository index could not be read.\n`);
  log('  This is an INSTRUMENT FAILURE, not a finding: no file was examined, so nothing here');
  log('  says anything about your code. Do not read it as a pass or as a violation.\n');
  log(`  git said: ${indexFaultDiagnostic(error)}\n`);
  log('  A torn .git/index is a RECURRING defect on this shared tree whose WRITER IS STILL UNKNOWN');
  log(`  (${INDEX_FAULT_TRACKING_ITEM}). It is NOT a benign transient: git-sync only MITIGATES it, repairing via`);
  log('  preflightInvalidIndex (`git read-tree HEAD`, run-git-sync.ts). This run already retried');
  log('  and the index was still unreadable, so it stood down rather than guess.\n');
  log('  CAPTURE THE WRITER NOW. First verify auditd persistence, including logging suspended:');
  log(`      ${INDEX_AUDIT_SINK_PROBE_COMMAND}`);
  log('  Kernel enabled/lost counters and an armed watch do not prove a live file sink.');
  log('  A suspended/unknown sink or an empty search is inconclusive about the writer.');
  log(`  Capture .git/index / index.lock evidence promptly; post it to ${INDEX_FAULT_TRACKING_ITEM}:`);
  log(`      ${INDEX_FAULT_CAPTURE_COMMAND}\n`);
  log(`  Re-run the guard once the index is healthy:`);
  log(`      stat -c '%s' .git/index && git ls-files | wc -l\n`);
  return EXIT_NOT_CHECKED;
}

/**
 * The whole contract in one call, for a guard whose `main()` is synchronous.
 *
 * Wraps the entrypoint so a persistent index fault exits EXIT_NOT_CHECKED with the banner above
 * instead of crashing with a non-zero status the runner would read as a violation.
 *
 * Handles a SYNC or an ASYNC `main` — an async one is guarded through its promise rejection,
 * because a sync try/catch around it would silently protect nothing.
 *
 * @template T
 * @param {() => T | Promise<T>} main
 * @param {{ guard?: string }} [options]
 * @returns {T | Promise<T>}
 */
export function runGuardWithIndexFaultGuard(main, { guard } = {}) {
  const settle = (error) => {
    const code = reportIndexFaultNotChecked(error, { guard });
    if (code === null) throw error;
    process.exit(code);
  };
  try {
    const result = main();
    // An ASYNC main returns a promise, and its rejection NEVER reaches the sync catch below.
    // Without this branch a caller wiring up an async guard gets a raw stack trace and exit 1
    // — the violation-shaped exit this module exists to prevent — while the call site LOOKS
    // protected. That is silent false-safety: the failure is invisible at the point where
    // someone would notice it. Measured on check-migration-fixture-drift.mjs, whose main() is
    // async (EI-22703095921400106).
    if (result && typeof result.then === 'function') return result.then(undefined, settle);
    return result;
  } catch (error) {
    return settle(error);
  }
}

if (isCliEntry(import.meta.url) && process.argv.includes('--audit-sink')) {
  const result = probeIndexAuditSink();
  console.log(JSON.stringify(result));
  process.exitCode = result.status === 'live' ? 0 : EXIT_NOT_CHECKED;
}
