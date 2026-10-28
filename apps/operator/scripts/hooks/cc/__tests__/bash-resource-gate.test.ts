/**
 * pretooluse-bash-resource-gate.sh — the native-scheduler lockout leg
 * (native-scheduler-lockout-2026-06-09 P-010).
 *
 * The script is the shared Claude+Codex PreToolUse shell hook; this suite
 * drives it exactly as the host CLI does — JSON on stdin, decision JSON (or
 * silence = allow) on stdout — with a HERMETIC fake $HOME carrying the
 * su-token files the script gates on (so the suite passes on a box with no
 * real install). The OS-scheduler deny is a LOCAL decision (no HTTP);
 * OPERATOR_URL points at a dead port so any accidental resource-gate
 * round-trip fails open fast instead of touching a live operator.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The audited pairs, so the pre-filter guard reads each pair's VERDICT rather
// than inferring enforceability from a fixture filename.
//
// BASH_GATE_PAIRS, not ALL_PAIRS: this file tests the SHELL gate, whose
// pre-filter only ever sees shell atoms. ALL_PAIRS also carries the SQL corpus
// (pairs/sql-reads.ts), whose atoms are raw SELECTs that reach a different
// surface entirely — feeding them to the shell pre-filter asserts a routing
// this gate is not responsible for and cannot perform. The SQL corpus has its
// own guard in bash-substitution/sql-corpus.test.ts, so narrowing here loses no
// coverage. Widening this back to ALL_PAIRS reds the gate the moment any
// non-bash corpus gains an enforceable pair.
import { BASH_GATE_PAIRS } from '@papercusp/operator-core/lib/bash-substitution/pairs/index';
import {
  FIXTURE_DIR,
  selectEnforceableFixtures,
} from '@papercusp/operator-core/lib/bash-substitution/corpus';

// PROBE_GATE_SCRIPT exists ONLY so a falsifiability probe can point this suite at a
// MUTATED COPY of the gate (plus its sibling libs) outside the tree — the copy-out tier
// in CLAUDE.md's "proving a guard is falsifiable". Without this one line the subject
// path is hardcoded, and the only way to test a mutant is to mutate the SHARED tree,
// where git-sync can commit it mid-probe even when nothing goes wrong. Every production
// run leaves it unset.
const SCRIPT = process.env.PROBE_GATE_SCRIPT
  ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'pretooluse-bash-resource-gate.sh');

let fakeHome = '';

/** The two $HOME-relative credential files the hook's bash preamble gates on. */
const credPaths = () => ({
  token: join(fakeHome, '.papercusp', 'superuser-token'),
  agentId: join(fakeHome, '.papercusp', 'su-agent-id'),
});

/**
 * Re-assert the credential precondition before EVERY hook invocation (EI-18829641916212203).
 *
 * The hook's preamble allows UNCONDITIONALLY — exit 0, no stdout — when either
 * credential file is missing or empty (`[ ! -s "$TOKEN_PATH" ] || [ ! -s "$AGENT_ID_PATH" ]`).
 * That is byte-identical to a legitimate allow, so if `fakeHome` ever looks empty
 * mid-run, every deny-expecting test fails as a bare `JSON.parse('')` SyntaxError
 * instead of as a missing-credentials error. Observed live: 11 such failures at once
 * under fleet load (load ~82-92), all green on a re-run minutes later and all green
 * when their describe ran alone — i.e. a shared-state flake, not a logic bug.
 *
 * Writing this once in `beforeAll` leaves the whole suite depending on those two
 * files surviving ~431 tests. Re-asserting costs two stats per invocation and
 * removes the dependency outright.
 *
 * NOTE: this hardens the leading hypothesis; it is deliberately paired with
 * `parseDecision`'s diagnostic below, so that if the real mechanism turns out to be
 * something else, the next occurrence reports itself instead of recurring as a
 * mystery red. Do not drop one as redundant with the other.
 */
function ensureGateCredentials(): void {
  const { token, agentId } = credPaths();
  mkdirSync(join(fakeHome, '.papercusp'), { recursive: true });
  for (const [path, body] of [
    [token, 'test-token\n'],
    [agentId, 'test-agent\n'],
  ] as const) {
    let size = -1;
    try {
      size = statSync(path).size;
    } catch {
      /* missing — rewritten below */
    }
    if (size <= 0) writeFileSync(path, body);
  }
}

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'gate-home-'));
  writeFileSync(join(CANON, '.gitignore'), '**/.papercusp/scratch/\n');
  execFileSync('git', ['init', '--quiet'], { cwd: CANON, stdio: 'ignore' });
  ensureGateCredentials();
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(CANON, { recursive: true, force: true });
});

// Advisories are SAY-ONCE per session (context-injection-audit P-020): the
// hook suppresses a repeat of the same advisory CLASS within one session key.
// Every call below is a distinct hook invocation standing for a distinct
// session, so each gets its own id — sharing one would mean only the FIRST
// test of each advisory class could ever pass, and the rest would assert the
// dedup rather than the advisory they name (WI-6671). `_session_key()` reads
// PAPERCUSP_SID ahead of the payload's session_id, so this isolates a call
// whichever helper built its payload. A test that deliberately exercises the
// dedup pins PAPERCUSP_SID explicitly in `env` — the spread below lets it win.
let sidSeq = 0;
const nextSid = () => `gate-suite-${process.pid}-${++sidSeq}`;

// Adding an advisory? If it covers a common command shape, pin it OFF in this
// shared `runGate` env and opt in from the describe that tests it; see the
// `PC_HEAVY_LOAD1_OVERRIDE` precedent above.
function runGate(
  payload: unknown,
  env: Record<string, string> = {},
  attempt = 0,
): GateOut {
  // EI-18829641916212203: cheap re-assert so a transiently-absent credential file
  // cannot turn a deny test into an unexplained JSON.parse('') failure.
  ensureGateCredentials();
  const r = spawnSync('bash', [SCRIPT], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      NODE_ENV: 'test',
      PATH: process.env.PATH ?? '',
      HOME: fakeHome,
      PAPERCUSP_SID: nextSid(),
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', // dead port — fail-open fast
      // Pin the heavy-admission gate's load input: it reads the REAL host
      // /proc/loadavg, so on a loaded box (load1 > threshold) every
      // expectAllow test of an UNRELATED guard reds on the admission deny
      // (observed live 2026-08-02 at load1=137: the fd-duplication shell-write
      // test failed on the admission message). Tests OF the admission gate set
      // their own OVER/UNDER via the `...env` spread below, which wins.
      PC_HEAVY_LOAD1_OVERRIDE: '0',
      // Same reasoning as the load pin above, one guard later (WI-5936): the
      // native-bg-task advisory fires on a LONG backgrounded run that redirects
      // to a file — which is the exact command shape the bg pipe/exit-code
      // suites background on purpose. Left on, it occupies the single ADVISORY
      // slot and reds ~12 expectAllow tests OF OTHER GUARDS. Pinning it off here
      // keeps those assertions at full strength (blanket silence) instead of
      // weakening them to "not THIS advisory"; the suite that tests the advisory
      // itself turns it back on via the `...env` spread below, which wins.
      PAPERCUSP_NATIVE_BG_ADVISORY: 'off',
      ...env,
    },
    timeout: 15_000,
  });
  // Carry `signal` and `error` OUT, do not drop them. spawnSync reports a child
  // that never exited NORMALLY as status:null, and the cause lives in exactly one
  // of those two fields — `signal` when the `timeout: 15_000` above fired, `error`
  // when the spawn itself failed (e.g. EAGAIN on a box that cannot fork). Dropping
  // both made every such case surface as the uninformative `expected null to be
  // +0`; see describeGateExit for what that cost.
  const out: GateOut = {
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    status: r.status,
    signal: r.signal ?? null,
    error: r.error ? r.error.message : null,
  };

  // RETRY EXACTLY ONCE when the child never exited normally (WI-1036031).
  //
  // status:null is an INFRASTRUCTURE outcome, not a gate verdict — the 15s timeout
  // fired, or the spawn failed. Measured: this file passes 853/853 in isolation and
  // failed ONE `expectAllow` inside the 813-file canonical suite, where it competes
  // with the rest of the run on a box at load1>150. That single false red exits the
  // whole `@papercusp/web` lane non-zero, which reds the canonical run — the exact
  // verdict test-suite-recovery-2026-08-27 exists to make trustworthy.
  //
  // A retry is SAFE here specifically because the gate is a PURE, read-only
  // evaluation: it reads the payload on stdin and prints a decision. It mutates no
  // repo state, and `PAPERCUSP_SID: nextSid()` gives the retry its own session id,
  // so nothing carries over from the killed attempt.
  //
  // Bounded to one deliberately. This must not silently paper over a REAL hang: a
  // genuine deadlock in the gate still fails, just at 2x15s, and describeGateExit
  // then names the signal — so the symptom stays visible instead of turning into an
  // infinite retry loop. Note this is the THIRD load-induced failure class in this
  // file (see PC_HEAVY_LOAD1_OVERRIDE and PAPERCUSP_NATIVE_BG_ADVISORY above); those
  // two pin a load-dependent INPUT, whereas this one survives a load-dependent KILL.
  if (attempt === 0 && out.status === null && (out.signal || out.error)) {
    return runGate(payload, env, attempt + 1);
  }
  return out;
}

/**
 * Async twin of `runGate`, for sweeps that spawn the hook hundreds of times (WI-38077).
 *
 * `runGate` is `spawnSync` deliberately and MUST stay that way — the stub-operator
 * describe below depends on it blocking this process's event loop. But that also
 * means a sweep over N payloads costs N x the hook's full startup, strictly
 * serially. The hook is ~150ms per call (220KB of Python re-compiled per
 * invocation, plus a urllib import and a refused TCP connect), so the 430-atom
 * pre-filter sweep alone measured 58.6s — 37% of this entire file.
 *
 * Those spawns are independent and read-only: each one asks the hook about one
 * atom and reads only stderr. Nothing shares state, so serial execution buys
 * nothing. This runs them through a bounded pool instead.
 *
 * Use this ONLY for such sweeps. Anything that needs the event loop blocked —
 * or that talks to the in-process stub operator — must keep using `runGate`.
 */
function runGateAsync(
  payload: unknown,
  env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  ensureGateCredentials();
  return new Promise((resolvePromise) => {
    const child = execFile(
      'bash',
      [SCRIPT],
      {
        encoding: 'utf8',
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH ?? '',
          HOME: fakeHome,
          PAPERCUSP_SID: nextSid(),
          PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', // dead port — fail-open fast
          PC_HEAVY_LOAD1_OVERRIDE: '0',
          ...env,
        },
        timeout: 15_000,
      },
      (err, stdout, stderr) => {
        const code = (err as { code?: unknown } | null)?.code;
        resolvePromise({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          status: typeof code === 'number' ? code : 0,
        });
      },
    );
    child.stdin?.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/**
 * FAITHFUL async twin of `runGate` — same env, same `GateOut`, same retry (WI-1507930).
 *
 * `runGateAsync` above is deliberately minimal: it exists for the atom sweep, which reads only
 * stderr. It is NOT a drop-in for an ordinary verdict test, and using it as one silently costs two
 * things this file paid for:
 *   - it omits `PAPERCUSP_NATIVE_BG_ADVISORY: 'off'`, so the bg advisory reoccupies the single
 *     ADVISORY slot and reds ~12 `expectAllow` assertions of unrelated guards (see runGate's env);
 *   - it coerces a non-numeric exit `code` to 0, which ERASES the `status:null` infrastructure
 *     outcome — exactly the load-induced kill WI-1036031's one-shot retry exists to survive, and
 *     the one `describeGateExit` is built to explain. Coerced to 0 it reads as a clean allow.
 * This twin keeps both, so a converted test is byte-equivalent in verdict AND in failure diagnosis.
 *
 * Why it exists: 877 of this file's 879 tests each pay one full serial `spawnSync` of the hook
 * (~129ms measured 2026-08-31 — 113.6s of the file). Those spawns are independent and read-only, so
 * the wall time is pure serialisation. Note `.concurrent` ALONE cannot fix that: `runGate` is
 * `spawnSync`, which blocks the event loop, so concurrent tests calling it interleave nothing.
 * Parallelism needs BOTH an async runner and `.concurrent`.
 *
 * Same rule as `runGateAsync`: anything that needs the event loop blocked — or that talks to the
 * in-process stub operator — must keep using `runGate`.
 */
function runGateAsyncFull(
  payload: unknown,
  env: Record<string, string> = {},
  attempt = 0,
): Promise<GateOut> {
  ensureGateCredentials();
  return new Promise((resolvePromise) => {
    const child = execFile(
      'bash',
      [SCRIPT],
      {
        encoding: 'utf8',
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH ?? '',
          HOME: fakeHome,
          PAPERCUSP_SID: nextSid(),
          PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1', // dead port — fail-open fast
          PC_HEAVY_LOAD1_OVERRIDE: '0',
          PAPERCUSP_NATIVE_BG_ADVISORY: 'off',
          ...env,
        },
        timeout: 15_000,
      },
      (err, stdout, stderr) => {
        // Mirror runGate's carry-out of signal/error rather than collapsing them into a status.
        const e = err as (Error & { code?: unknown; signal?: string | null }) | null;
        const code = e?.code;
        const out: GateOut = {
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          status: typeof code === 'number' ? code : e ? null : 0,
          signal: e?.signal ?? null,
          error: e && typeof code !== 'number' ? e.message : null,
        };
        // RETRY EXACTLY ONCE on an infrastructure outcome — identical rule and rationale to
        // runGate's (WI-1036031): the gate is a pure read-only evaluation and the retry gets its
        // own PAPERCUSP_SID, so nothing carries over from the killed attempt.
        if (attempt === 0 && out.status === null && (out.signal || out.error)) {
          resolvePromise(runGateAsyncFull(payload, env, attempt + 1));
          return;
        }
        resolvePromise(out);
      },
    );
    child.stdin?.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/**
 * Bounded-concurrency map, preserving input order in the result.
 *
 * The cap is the point: each task spawns a CPU-bound Python process, and this
 * repo's suites run on a box shared with the rest of the fleet. Unbounded
 * `Promise.all` over 430 atoms would fork 430 interpreters at once. The total
 * CPU work is identical either way — only the wall time and the peak process
 * count change — so a small pool captures nearly all the win at a fraction of
 * the peak footprint.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Parse the hook's decision JSON, turning the fail-open shape into a SELF-DIAGNOSING
 * error (EI-18829641916212203).
 *
 * `status === 0` with empty stdout is the hook's allow/fail-open shape. Parsed
 * naively that surfaces as `SyntaxError: Unexpected end of JSON input`, which names
 * neither the cause nor where to look — and it lands on deny-expecting tests, where
 * it is indistinguishable at a glance from a real regression in a SAFETY rail. That
 * ambiguity is the expensive part: 11 of these appeared alongside one unrelated
 * 2-line change and had to be manually proven not to be its fault.
 *
 * `runGate` already captures stderr; this reports it, plus whether each credential
 * file actually existed and its size, so the next occurrence explains itself.
 *
 * EI-20437152261657452 — BUT IT MUST READ THAT EVIDENCE BEFORE NAMING A CAUSE.
 * In this hook's protocol SILENCE IS ALLOW (see `expectAllow`, which asserts exactly
 * an empty stdout). So `status 0 + empty stdout` has TWO causes, not one:
 *   (a) the credential preamble fail-opened — the flake this helper was built for; or
 *   (b) the guard ran fine and DELIBERATELY ALLOWED the command — i.e. the test's
 *       expectation is stale, which is a real finding and not a flake at all.
 * This message used to assert (a) unconditionally, and explicitly rule out a logic
 * failure ("not a logic failure") — while printing `token: … (size=11)` two lines
 * later, evidence that falsifies its own diagnosis. Observed live: after the
 * native-scheduler lockout was changed to allow `crontab -l` (EI-20419484186942049),
 * a stale `expectDeny(… "sh -c 'crontab -l'")` failed with this text, which sent the
 * reader hunting a credential bug that did not exist. So: stat first, then diagnose.
 *
 * The allow reading requires BOTH signals healthy — usable credentials AND a quiet
 * stderr — because a deliberate allow is silent on both streams. Anything on stderr
 * means the hook errored rather than chose, which is a fail-open no matter how good
 * the credential files look afterwards.
 *
 * NB the branch describes the DEFAULT `fakeHome` credentials that every deny test
 * uses. A test that overrides HOME via runGate's env spread is outside what these
 * paths can speak to — the sizes are printed either way, so the reader can tell.
 */
function parseDecision(out: { stdout: string; stderr?: string; status: number | null }): {
  hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
} {
  if (out.status === 0 && out.stdout.trim() === '') {
    const sizeOrNull = (p: string): number | null => {
      try {
        return statSync(p).size;
      } catch {
        return null;
      }
    };
    const { token, agentId } = credPaths();
    const tokenSize = sizeOrNull(token);
    const agentIdSize = sizeOrNull(agentId);
    const describeFile = (p: string, size: number | null) =>
      size === null ? `${p} (MISSING)` : `${p} (size=${size})`;
    // TWO signals, and BOTH must look healthy before this can be read as an ordinary
    // allow. Credentials: the precondition the hook's preamble actually tests (present
    // AND non-empty). Stderr: a deliberate allow is silent on BOTH streams, so anything
    // on stderr means the hook ERRORED rather than chose — that is a fail-open however
    // healthy the credential files look right now. (The stderr half is not a guess: the
    // EI-18829641916212203 test above pins exactly that case — healthy files, stderr
    // 'hook error: token unreadable' — and it is the reason this branch is a conjunction
    // instead of a credential check alone.)
    const credentialsUsable = (tokenSize ?? 0) > 0 && (agentIdSize ?? 0) > 0;
    const stderrQuiet = (out.stderr ?? '').trim() === '';
    const lead = credentialsUsable && stderrQuiet
      ? 'gate hook exited 0 with EMPTY stdout and an EMPTY stderr, which in this hook\'s ' +
        'protocol means it ALLOWED the command (silence = allow). Both $HOME credential files ' +
        'are present and NON-EMPTY right now (sizes below), so the evidence does not support ' +
        'the credential fail-open shape (EI-18829641916212203): the likeliest reading is that ' +
        'the guard ran and simply did not match. Check the EXPECTATION first — a rail that ' +
        'legitimately stopped denying this command, or a probe string that is now allowed, ' +
        'looks exactly like this.\n' +
        '  Caveat, stated so this cannot mis-diagnose in the other direction: the files are ' +
        'stat-ed AFTER the run, so a credential transiently unreadable under load and since ' +
        'restored would also land here. RE-RUN 3x — that is what separates them: a load flake ' +
        'does not fail deterministically, a stale expectation does. Diagnostics:\n'
      : 'gate hook exited 0 with EMPTY stdout — it FAIL-OPENED instead of emitting a decision. ' +
        (credentialsUsable
          ? 'The credential files are present and non-empty, but the hook wrote to STDERR (below), ' +
            'so it ERRORED OUT rather than deliberately allowing — read this as the fail-open ' +
            'shape (EI-18829641916212203), not as a guard that chose to allow. '
          : 'This is the credential-precondition shape (EI-18829641916212203), not a logic ' +
            "failure: the hook's preamble allows unconditionally when either $HOME credential " +
            'file is missing or empty, and one of them is (see below). ') +
        'Diagnostics:\n';
    throw new Error(
      lead +
        `  stderr:   ${JSON.stringify(out.stderr ?? '(not captured)')}\n` +
        `  token:    ${describeFile(token, tokenSize)}\n` +
        `  agent-id: ${describeFile(agentId, agentIdSize)}\n` +
        `  HOME:     ${fakeHome}`,
    );
  }
  return JSON.parse(out.stdout);
}

/**
 * What a gate invocation returned, including WHY it did not exit normally.
 *
 * `signal`/`error` are optional so the handful of call sites that build their own
 * spawnSync result still satisfy it.
 */
type GateOut = {
  stdout: string;
  status: number | null;
  stderr?: string;
  signal?: string | null;
  error?: string | null;
};

/**
 * Explain a non-zero/null exit IN THE ASSERTION MESSAGE.
 *
 * `status: null` does not mean "the gate exited non-zero" — it means the child
 * never exited normally at all, which is an INFRASTRUCTURE outcome, not a gate
 * verdict. Until this existed, both causes rendered as `expected null to be +0`,
 * which names neither the signal, the 15s timeout, nor a failed spawn.
 *
 * That cost real time, measured: this single assertion was the ENTIRE
 * `@papercusp/web` lane failure in canonical run 4 (1 failed of 13,450 tests), and
 * because the message named no cause, identifying it took a 305s full-suite
 * reproduction plus a hand-audit of runGate — for a line that could have said
 * "killed by SIGTERM after 15s". The plan this sits under (test-suite-recovery)
 * exists to make the canonical verdict TRUSTWORTHY, and a red whose message
 * cannot distinguish infrastructure from defect is the exact opposite (WI-1036031).
 */
function describeGateExit(out: GateOut): string {
  if (out.status === 0) return '';
  const cause = out.error
    ? `the SPAWN ITSELF FAILED: ${out.error}`
    : out.signal
      ? `the child was KILLED BY ${out.signal} — runGate's spawnSync timeout is 15s, so this is an infrastructure kill (contention/hang), NOT a gate verdict`
      : `the gate exited ${String(out.status)}`;
  return [
    `gate did not exit 0 — ${cause}.`,
    `stdout=${JSON.stringify((out.stdout ?? '').slice(0, 200))}`,
    `stderr=${JSON.stringify((out.stderr ?? '').slice(0, 300))}`,
  ].join(' ');
}

function expectDeny(out: GateOut) {
  expect(out.status, describeGateExit(out)).toBe(0); // deny is exit 0 + decision JSON (hook protocol)
  const decision = parseDecision(out);
  expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('pot:declare-wake');
}

function expectAllow(out: GateOut) {
  expect(out.status, describeGateExit(out)).toBe(0);
  expect(out.stdout.trim()).toBe(''); // silence = allow
}

function expectGitDeny(out: GateOut) {
  expect(out.status, describeGateExit(out)).toBe(0); // deny is exit 0 + decision JSON (hook protocol)
  // parseDecision, not a bare JSON.parse: the shell-write / `sed -i` deny tests that
  // route through here are precisely the ones observed failing en masse on the
  // fail-open shape (EI-18829641916212203).
  const decision = parseDecision(out);
  expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('shared-tree guard');
}

describe('the fail-open shape is self-diagnosing, not a bare SyntaxError (EI-18829641916212203)', () => {
  it('names stderr and both credential files when the hook exits 0 with empty stdout', () => {
    let err: Error | null = null;
    try {
      parseDecision({ stdout: '   ', stderr: 'hook error: token unreadable', status: 0 });
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeTruthy();
    const msg = err!.message;
    // The regression this guards: the old bare JSON.parse produced
    // "SyntaxError: Unexpected end of JSON input" — which names neither the cause
    // nor where to look, and lands on deny-expecting tests where it is
    // indistinguishable from a real regression in a SAFETY rail.
    expect(msg).not.toMatch(/Unexpected end of JSON input/);
    expect(msg).toContain('FAIL-OPENED');
    expect(msg).toContain('EI-18829641916212203');
    expect(msg).toContain('hook error: token unreadable'); // stderr surfaced
    expect(msg).toContain('superuser-token'); // both credential files reported
    expect(msg).toContain('su-agent-id');
    expect(msg).toContain(fakeHome);
  });

  it('leaves a real decision payload untouched', () => {
    const decision = parseDecision({
      stdout: JSON.stringify({
        hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'nope' },
      }),
      status: 0,
    });
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toBe('nope');
  });

  it('ensureGateCredentials restores a credential file that went missing mid-run', () => {
    const { token } = credPaths();
    rmSync(token, { force: true });
    expect(existsSync(token)).toBe(false);
    ensureGateCredentials();
    expect(statSync(token).size).toBeGreaterThan(0);
  });
});

const AGENT = { PAPERCUSP_AGENT_SESSION: '1' };
// A fleet-member session that never got PAPERCUSP_AGENT_SESSION (EI-7872-class
// gap) but does carry the fleet slug the server stamps independently.
const FLEET = { PAPERCUSP_FLEET_SLUG: 'nonp2p-bug-drain-0727' };
// A deterministic stand-in for the canonical shared staging tree. The hook
// resolves the canonical tree from PAPERCUSP_CANONICAL_TREE (or ~/papercupai-
// workspace/papercusp); we pin it via env + pass an explicit payload `cwd` so
// the tree-based git guard (EI-7872) is tested independent of where vitest runs.
const CANON = mkdtempSync(join(tmpdir(), 'gate-canonical-'));
const CANON_ENV = { PAPERCUSP_CANONICAL_TREE: CANON };
const bashCmd = (
  command: string,
  opts: { tool?: string; cwd?: string } = {},
) => ({
  tool_name: opts.tool ?? 'Bash',
  tool_input: { command },
  session_id: 's-test',
  ...(opts.cwd ? { cwd: opts.cwd } : {}),
});

describe('native-scheduler lockout (agent sessions)', () => {
  it.each([
    ['plain crontab', 'crontab -e'],
    ['bare crontab (stdin form)', 'crontab'],
    ['compound &&', 'cd /tmp && crontab evil-tab'],
    // NB: these two carry a MUTATING form on purpose. They exist to test the
    // separator anchor (`;` / newline), and until EI-20419484186942049 they
    // spelled it `crontab -l` — a listing, which is now correctly exempt. A
    // read here would have made them pass for the wrong reason forever after.
    ['compound ;', 'git status; crontab -e'],
    ['piped at', 'echo done | at midnight'],
    ['sudo form', 'sudo crontab -u root -e'],
    ['newline-separated', 'true\ncrontab -e'],
    ['batch', 'batch < jobs.txt'],
    ['systemd-run timer', 'systemd-run --on-calendar=daily echo hi'],
    // EI-9937: quote-stripping must NOT weaken a genuine deny — the scheduler
    // token is UNQUOTED at command position; a quoted arg elsewhere is irrelevant.
    ['&& crontab after a quoted echo', 'echo "done; ok" && crontab -e'],
    ['crontab after a quoted-pipe grep', "grep -E 'a|b' f.txt | crontab -"],
  ])('denies %s', (_label, command) => {
    expectDeny(runGate(bashCmd(command), AGENT));
  });

  it.each([
    ['prose "at"', 'echo "look at this"'],
    ['atuin (no mid-word match)', 'atuin search foo'],
    ['attach (no prefix match)', 'attach session-3'],
    ['crontab in a commit message (not command position)', 'git commit -m "fix crontab docs"'],
    ['systemctl is not systemd-run', 'systemctl --user status papercup-staging-api.service'],
    ['ordinary command', 'ls -la'],
    // ── EI-9937: `;&|` INSIDE a quoted arg are literal data, not shell
    // separators — a read-only grep/wc/sed naming these scheduler tokens in a
    // quoted regex/pattern must NOT trip the command-position anchor. ──
    ['grep -E alternation naming the scheduler tokens', 'grep -E "crontab|at|batch|systemd-run" packages/operator-core/lib/code-run-batch-nudge.ts'],
    ['double-quoted pipe-alternation "at|batch"', 'grep -nE "at|batch" code-run-batch-nudge.ts'],
    ["single-quoted pipe-alternation 'foo|batch'", "grep -rn 'foo|batch' packages/operator-core/lib/"],
    ['sed with a quoted pipe-alternation', "sed -E 's/(a|batch)/x/' code-run-batch-nudge.ts"],
    ['quoted semicolon before batch (echo only)', 'echo "run this; batch job"'],
    ['batch only as a filename substring (no command-position token)', 'wc -l packages/operator-core/lib/code-run-batch-nudge.ts'],
    ['SQL heredoc column named at (not an OS schedule)', 'cat > /tmp/health.mts <<EOF\nSELECT at, statuses FROM harness_shared.system_health_ticks WHERE at >= 0\nEOF'],
    ['Python heredoc variable named batch (not an OS schedule)', 'python3 - <<\'PY\nrows = []\nbatch = [r["txt"] for r in rows]\nPY'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  it('accepts codex shell tool names (exec_command) — same wire contract', () => {
    expectDeny(runGate(bashCmd('crontab -e', { tool: 'exec_command' }), AGENT));
  });

  it('ignores non-shell tools even in agent sessions', () => {
    expectAllow(runGate({ tool_name: 'Edit', tool_input: { file_path: '/x' } }, AGENT));
  });
});

// ── EI-20419484186942049: the lockout stops an agent CREATING a schedule the
// hive cannot see. A pure LISTING creates nothing, so it must not be blocked —
// `crontab -l` is the direct way to VERIFY an existing entry, and denying it
// bought no safety while teaching agents to route around the rail (the reporter
// dropped the read and audited a reconciler via journal output instead).
//
// The exemption is an ALLOWLIST and these tests pin BOTH halves: the reads that
// must now pass, and — the half that matters more — the mutating forms that must
// still deny, including the ones that merely LOOK like the read.
describe('native-scheduler lockout: read-only listings are exempt (EI-20419484186942049)', () => {
  it.each([
    ['crontab -l on its own', 'crontab -l'],
    ['crontab -l after a ; separator', 'git status; crontab -l'],
    ['crontab -l after a newline', 'true\ncrontab -l'],
    ['crontab -l piped into a filter', 'crontab -l | grep session-archive'],
    ['crontab -l inside a compound with unrelated probes', 'find . -name x.ts && crontab -l'],
    ['another user’s crontab, listed', 'crontab -u root -l'],
    ['flag order reversed', 'crontab -l -u root'],
    ['sudo crontab -l', 'sudo crontab -l'],
    ['at -l is atq spelled differently', 'at -l'],
    ['atq never matched the anchor at all', 'atq'],
    ['systemctl list-timers is not systemd-run', 'systemctl --user list-timers'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  it.each([
    // The allowlist must not be widened by shape alone. `-u <user>` WITHOUT
    // `-l` is the stdin-install form — it creates a schedule for that user.
    ['crontab -u bob (stdin install, no -l)', 'crontab -u bob'],
    ['bare crontab (stdin install)', 'crontab'],
    ['crontab - (explicit stdin install)', 'crontab -'],
    ['crontab -r (removes the schedule)', 'crontab -r'],
    ['crontab -e (edits the schedule)', 'crontab -e'],
    ['crontab <file> (installs a file)', 'crontab my-jobs.txt'],
    // A read TOKEN does not launder a mutating invocation, in either order.
    ['read flag alongside an edit', 'crontab -l -e'],
    ['read first, then a write in the same compound', 'crontab -l && crontab -e'],
    ['read first, then a write after a ;', 'crontab -l; crontab -r'],
    ['a listing piped INTO crontab still installs', 'crontab -l | crontab -'],
  ])('still denies %s', (_label, command) => {
    expectDeny(runGate(bashCmd(command), AGENT));
  });

  it('names the read/write boundary in the refusal, so the rail teaches instead of just blocking', () => {
    const r = runGate(bashCmd('crontab -e'), AGENT);
    expectDeny(r);
    expect(`${r.stdout}${r.stderr}`).toMatch(/crontab -l/);
  });
});

// ── EI-21934170410740770: the read-only allowlist above is $-ANCHORED, so any
// shell REDIRECTION defeated it. `crontab -l 2>&1 | head -20` denied while bare
// `crontab -l` passed — and the refusal text promised, in the same breath, that
// listings pass. Worse, its advertised remedy ("re-run the listing form on its
// own") denied a SECOND time, because the reporter kept the redirect. A rail
// whose own instructions do not work is the one a session stops believing.
//
// Pipes were never the cause: the segment splitter already ends a segment at
// `|`, and `crontab -l | grep x` has passed since EI-20419484186942049. The
// mechanism is subtler — the splitter cuts on [;&|\n], and the `&` inside
// `2>&1` is one of those, so the segment reaching the classifier is the
// truncated `crontab -l 2>`.
//
// MIRROR: the same classification lives in the OMP hook
// (scripts/hooks/omp/coord-hook.ts). Fix one, fix both.
describe('native-scheduler lockout: redirections do not defeat the read exemption (EI-21934170410740770)', () => {
  it.each([
    ['stderr merged, piped to a filter', 'crontab -l 2>&1 | grep session-archive'],
    ['stderr to /dev/null', 'crontab -l 2>/dev/null'],
    ['stdout to a scratch file', 'crontab -l > /tmp/out.txt'],
    ['appended to a scratch file', 'crontab -l >> /tmp/out.txt'],
    ['both streams to separate files', 'crontab -l 1>/tmp/a 2>/tmp/b'],
    ['sudo form with a redirect', 'sudo crontab -l 2>&1 | wc -l'],
    ['another user listed, with a redirect', 'crontab -u root -l 2>/dev/null'],
    ['redirect inside a compound', 'git status; crontab -l 2>&1 | wc -l'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  // The reported command VERBATIM. It cannot use expectAllow (which asserts
  // total silence) because `| head` independently trips the foreground SIGPIPE
  // advisory (EI-18787618439028592) — an ALLOW decision carrying advice, from a
  // guard that has nothing to do with schedulers. Asserting silence here would
  // couple this regression to that unrelated advisory's existence; asserting the
  // scheduler verdict directly is what this test is actually about.
  it('does not deny the reported command verbatim', () => {
    const r = runGate(bashCmd('crontab -l 2>&1 | head -20'), AGENT);
    expect(r.status, describeGateExit(r)).toBe(0);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/native-scheduler lockout/);
  });

  // Stripping redirections stays fail-CLOSED. These are the shapes where a
  // redirection genuinely CREATES a schedule — the reason the strip is not a
  // blanket one — so they must keep denying even with a read flag beside them.
  it.each([
    ['stdin redirect IS the install vector', 'crontab < jobs.txt'],
    ['stdin install for another user', 'crontab -u bob < jobs.txt'],
    ['listing written straight into the cron spool', 'crontab -l > /var/spool/cron/crontabs/bob'],
    ['listing written into a cron drop-in', 'crontab -l > /etc/cron.d/evil'],
    ['listing appended to /etc/crontab', 'crontab -l >> /etc/crontab'],
    ['a redirect on the read does not launder the install', 'crontab -l 2>&1 | crontab -'],
  ])('still denies %s', (_label, command) => {
    expectDeny(runGate(bashCmd(command), AGENT));
  });
});

// ── EI-20437152261657452: `status 0 + empty stdout` is BOTH the credential
// fail-open AND an ordinary allow (silence = allow). The diagnostic must read the
// credential sizes it already collects before naming a cause, or it sends the
// reader after a credential bug that does not exist — which is exactly what it did
// when the crontab read-exemption above made a stale deny expectation come true.
describe('parseDecision diagnoses an empty stdout from the evidence (EI-20437152261657452)', () => {
  it('reads a healthy-credential ALLOW as an allow, not as a credential fail-open', () => {
    // `ls -la` is allowed by every guard, so expectDeny MUST throw here. The bug was
    // never whether it throws — it is which cause the message asserts.
    let msg = '';
    try {
      expectDeny(runGate(bashCmd('ls -la'), AGENT));
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/silence = allow/);
    expect(msg).toMatch(/does not support the credential fail-open shape/);
    expect(msg).toMatch(/Check the EXPECTATION first/);
    // The old text asserted the credential shape unconditionally. It must not return.
    expect(msg).not.toMatch(/it FAIL-OPENED instead of emitting a decision/);
    // And it must still surface the evidence that justifies the branch it took.
    expect(msg).toMatch(/token:.*size=/);
    expect(msg).toMatch(/agent-id:.*size=/);
  });

  it('does NOT read healthy credentials alone as an allow when the hook wrote to stderr', () => {
    // The conjunction that matters, and the case a credential-only check gets wrong:
    // the files are fine, but the hook ERRORED (it did not choose to allow). Silence on
    // stdout ALONE is not consent — a deliberate allow is quiet on both streams.
    let msg = '';
    try {
      parseDecision({ stdout: '   ', stderr: 'hook error: token unreadable', status: 0 });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('FAIL-OPENED');
    expect(msg).toMatch(/wrote to STDERR/);
    expect(msg).not.toMatch(/silence = allow/);
  });
});

// ── EI-18815668439722436 / WI-6147: PAPERCUSP_FLEET_SLUG backstop ──────────
// This guard used to gate ONLY on PAPERCUSP_AGENT_SESSION, with no backstop —
// unlike the sibling shared-tree git guard (EI-7872), which fires on cwd even
// without the marker. A cwd-based backstop doesn't fit here (crontab/at/batch/
// systemd-run aren't tied to a working directory), so the backstop instead is
// PAPERCUSP_FLEET_SLUG — stamped server-side into a fleet member's env
// independent of whatever client-side path sets (or fails to set) the marker.
describe('native-scheduler lockout: fleet-slug backstop (EI-18815668439722436)', () => {
  it.each([
    ['crontab', 'crontab -e'],
    ['systemd-run timer', 'systemd-run --on-calendar=daily echo hi'],
    ['at', 'echo done | at midnight'],
    ['batch', 'batch < jobs.txt'],
  ])('fires WITHOUT the agent marker when PAPERCUSP_FLEET_SLUG is set: %s', (_label, command) => {
    expectDeny(runGate(bashCmd(command), FLEET));
  });

  it('still honors the agent marker even with no fleet slug (unchanged behavior)', () => {
    expectDeny(runGate(bashCmd('crontab -e'), AGENT));
  });

  it('fires when BOTH signals are present (no double-deny weirdness)', () => {
    expectDeny(runGate(bashCmd('crontab -e'), { ...AGENT, ...FLEET }));
  });

  it("never fires with NEITHER signal — the owner's crontab is still their business", () => {
    expectAllow(runGate(bashCmd('crontab -e')));
  });

  it('an empty PAPERCUSP_FLEET_SLUG does not count as set (defensive)', () => {
    expectAllow(runGate(bashCmd('crontab -e'), { PAPERCUSP_FLEET_SLUG: '' }));
  });
});

/**
 * EI-21924747520941481 — `systemd-run` is also the cgroup-isolation mechanism
 * used by execution guards. Only timer-backed forms create a persistent OS
 * schedule; transient services/scopes, `--pipe --wait`, and resource-control
 * properties must remain available.
 */
function denyReason(out: { stdout: string; stderr?: string; status: number | null }): string {
  expect(out.status).toBe(0);
  const decision = parseDecision(out);
  expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  return decision.hookSpecificOutput.permissionDecisionReason as string;
}

describe('native-scheduler lockout: systemd-run blocks timers, not transient units (EI-21924747520941481)', () => {
  it.each([
    ['plain transient service', 'systemd-run ./thing.sh'],
    ['transient scope', 'systemd-run --scope ./heavy.sh'],
    ['pipe/wait scope with properties', 'systemd-run --pipe --wait --property=NoNewPrivileges=yes ./probe.sh'],
    ['CPU resource control', 'systemd-run -p CPUQuota=200% node_modules/.bin/vitest run'],
    ['memory resource control', 'systemd-run --property=MemoryMax=4G npm run build'],
    ['sudo transient scope', 'sudo systemd-run --scope --collect ./probe.sh'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  it.each([
    ['--on-calendar', 'systemd-run --on-calendar=daily echo hi'],
    ['--on-active', 'systemd-run --on-active=30m ./wake.sh'],
    ['--on-boot', 'systemd-run --on-boot=5m ./wake.sh'],
    ['--on-startup', 'systemd-run --on-startup=5m ./wake.sh'],
    ['--on-unit-active', 'systemd-run --on-unit-active=5m ./wake.sh'],
    ['--on-unit-inactive', 'systemd-run --on-unit-inactive=5m ./wake.sh'],
    ['--timer-property', 'systemd-run --timer-property=AccuracySec=1s --on-calendar=daily ./wake.sh'],
  ])('a timer form (%s) still gets the wake answer', (_l, command) => {
    const reason = denyReason(runGate(bashCmd(command), AGENT));
    expect(reason).toMatch(/must not create OS schedules/);
    expect(reason).toMatch(/pot:declare-wake/);
  });

  it('does not treat a timer-looking payload after `--` as a timer', () => {
    expectAllow(runGate(bashCmd('systemd-run --scope -- echo --on-calendar=daily'), AGENT));
  });

  it('keeps non-systemd schedulers denied', () => {
    for (const command of ['crontab -e', 'echo done | at midnight', 'batch < jobs.txt']) {
      expectDeny(runGate(bashCmd(command), AGENT));
    }
  });

  it('quoted prose naming CPUQuota is not a systemd-run at all', () => {
    expectAllow(runGate(bashCmd('echo "we could use -p CPUQuota=200% here"'), AGENT));
  });
});

/**
 * EI-20235141119412683 — `systemd-run` waits for the START JOB unless `--no-block`
 * is passed, and a `Type=oneshot` start job is not complete until the payload EXITS.
 * So a oneshot without `--no-block` holds the caller for the unit's whole runtime.
 *
 * Verified against real systemd before the guard was written: a 4s oneshot returned
 * the client after 4s without the flag and after 0s with it, while the SAME sleep
 * under the default service type returned after 0s either way. That control is why
 * this guard is scoped to `Type=oneshot` alone — the cause is the TYPE, not
 * systemd-run, so a blanket "always pass --no-block" would be noise on the ~40
 * non-oneshot call sites in this repo.
 *
 * ADVISORY, never a deny: waiting on a oneshot is a legitimate thing to WANT, so an
 * explicit `--wait` suppresses it too.
 */
describe('systemd-run oneshot detach advisory (EI-20235141119412683)', () => {
  function advisoryFor(command: string): string {
    const out = runGate(bashCmd(command), AGENT);
    expect(out.status, describeGateExit(out)).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // teaches, never blocks
    return hso.additionalContext as string;
  }

  it.each([
    ['--property= long form', 'systemd-run --user --collect --unit=gate --property=Type=oneshot ./gate.sh'],
    ['-p short form', 'systemd-run --user -p Type=oneshot ./gate.sh'],
    ['--property with a space', 'systemd-run --user --property Type=oneshot ./gate.sh'],
    // The shared _strip_quotes_and_comments normalizer replaces a quoted span with a
    // space, which would render this `--property=` and silently match nothing. This
    // case is the whole reason the scanner unquotes instead of using that normalizer.
    ['a QUOTED property value', 'systemd-run --user --property="Type=oneshot" ./gate.sh'],
  ])('warns when a oneshot omits --no-block (%s)', (_label, command) => {
    const ctx = advisoryFor(command);
    expect(ctx).toContain('systemd-run oneshot advisory');
    expect(ctx).toContain('--no-block');
  });

  it.each([
    ['--no-block is already present', 'systemd-run --user --no-block --property=Type=oneshot ./gate.sh'],
    ['--wait means the caller INTENDS to block', 'systemd-run --user --wait --property=Type=oneshot ./gate.sh'],
    ['--pipe --wait, the synchronous seam this repo uses on purpose',
      'systemd-run --pipe --wait --property=Type=oneshot ./probe.sh'],
    // The default service type's start job completes at fork, so the client already
    // returns immediately — advising --no-block here would be false.
    ['the default service type does not block', 'systemd-run --user --collect --unit=x ./gate.sh'],
    ['a transient scope', 'systemd-run --scope --property=MemoryMax=4G ./heavy.sh'],
    ['Type=oneshot only in the PAYLOAD after `--`', 'systemd-run --scope -- echo --property=Type=oneshot'],
    ['prose merely naming the property', 'echo "pass --property=Type=oneshot next time"'],
  ])('stays silent when %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command), AGENT));
  });

  it('is switchable off for test isolation, like its sibling advisories', () => {
    const command = 'systemd-run --user --property=Type=oneshot ./gate.sh';
    expect(advisoryFor(command)).toContain('systemd-run oneshot advisory');
    expectAllow(runGate(bashCmd(command), { ...AGENT, PAPERCUSP_SYSTEMD_ONESHOT_ADVISORY: 'off' }));
  });

  // EI-21971958067151594: `capability_bash` is the SAME shell reached over MCP, and
  // CLAUDE.md routes agents onto exactly that spelling for long-running launches —
  // which is this advisory's whole population. Gating on Claude's `Bash` name alone
  // would exempt the callers most likely to hit it.
  it.each([
    ['the MCP spelling', 'mcp__papercusp-su__capability_bash'],
    ["codex's exec_command", 'exec_command'],
    ["codex's local_shell", 'local_shell'],
  ])('reaches %s, not just Claude-native Bash', (_label, tool) => {
    const out = runGate(bashCmd('systemd-run --user --property=Type=oneshot ./gate.sh', { tool }), AGENT);
    expect(out.status, describeGateExit(out)).toBe(0);
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext)
      .toContain('systemd-run oneshot advisory');
  });
});

/**
 * EI-10939 — tauri-agent-tools target guard (SAFETY).
 *
 * `tauri-agent-tools` resolves its target by scanning /tmp for
 * `tauri-dev-bridge-<pid>.token` and taking the FIRST LIVE ONE readdir happens to
 * yield (its tokenDiscovery.js: `if (!found) found = …`). No preference, no
 * tie-break, no warning when several are alive — so a bare `… click '#btn'`
 * drives whichever app came up first, which is very often the OWNER'S LIVE
 * DESKTOP WINDOW rather than the throwaway instance the agent spawned.
 *
 * The package is third-party and global (outside our repo), so the fix lives
 * here, in the hook: refuse to let an UNAIMED command through.
 *
 * The load-bearing case is the FIRST test below: with exactly ONE live bridge
 * there is no ambiguity to detect — and on this box that one bridge was the
 * owner's own papercusp-desktop. An ambiguity-only guard sails right through it.
 * A mutating command must name its target unconditionally.
 */
describe('tauri-agent-tools target guard (EI-10939)', () => {
  let tmpBridgeDir = '';
  const LIVE_A = process.pid; // this vitest process — definitely alive
  const LIVE_B = process.ppid; // its parent — also alive
  // Linux documents pid_max as one greater than the maximum allocatable PID, so
  // it cannot collide with a live process even on a high-churn fleet host.
  const DEAD = (() => {
    try { return Number(readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim()); } catch { return 2_147_483_647; }
  })();

  function writeBridge(pid: number, port: number) {
    writeFileSync(
      join(tmpBridgeDir, `tauri-dev-bridge-${pid}.token`),
      JSON.stringify({ port, token: `tok-${pid}`, pid }),
    );
  }

  /** Run the gate with the fabricated bridge set visible as the temp dir. */
  const runTat = (command: string) =>
    runGate(bashCmd(command), { ...AGENT, TMPDIR: tmpBridgeDir });

  beforeEach(() => {
    tmpBridgeDir = mkdtempSync(join(tmpdir(), 'tat-bridges-'));
  });
  afterEach(() => {
    rmSync(tmpBridgeDir, { recursive: true, force: true });
  });

  it('DENIES a mutating command with ONE live bridge — the "unambiguous" case is exactly how the owner\'s window gets driven', () => {
    writeBridge(LIVE_A, 46423);
    const reason = denyReason(runTat(`tauri-agent-tools eval 'document.title'`));
    expect(reason).toMatch(/DRIVES a webview but does not say WHICH/);
    expect(reason).toMatch(new RegExp(`--pid\\s+${LIVE_A}`)); // names the candidate
    expect(reason).toMatch(/probe/); // and the way to find the right one
  });

  it.each([
    ['click', `tauri-agent-tools click '#send-button'`],
    ['type', `tauri-agent-tools type '#input' 'hello'`],
    ['navigate', `tauri-agent-tools navigate /settings`],
    ['invoke', `tauri-agent-tools invoke some_command`],
    ['select', `tauri-agent-tools select '#dropdown' v`],
    ['focus', `tauri-agent-tools focus '#el'`],
    ['scroll', `tauri-agent-tools scroll --to 400`],
  ])('DENIES unaimed mutating `%s`', (_l, command) => {
    writeBridge(LIVE_A, 46423);
    expect(denyReason(runTat(command))).toMatch(/DRIVES a webview/);
  });

  it.each([
    ['--pid', `tauri-agent-tools eval --pid ${999} 'x'`],
    ['--pid=', `tauri-agent-tools click --pid=${999} '#b'`],
    ['--port + --token', `tauri-agent-tools eval --port 46423 --token abc 'x'`],
  ])('ALLOWS a mutating command that names its target (%s)', (_l, command) => {
    writeBridge(LIVE_A, 46423);
    expectAllow(runTat(command));
  });

  it('ALLOWS an unaimed READ command when only one bridge is live (no ambiguity to resolve)', () => {
    writeBridge(LIVE_A, 46423);
    expectAllow(runTat('tauri-agent-tools dom body'));
  });

  it('DENIES an unaimed READ command when TWO bridges are live — reading the wrong app is how a false green happens', () => {
    writeBridge(LIVE_A, 46423);
    writeBridge(LIVE_B, 43929);
    const reason = denyReason(runTat('tauri-agent-tools dom body'));
    expect(reason).toMatch(/2 bridges are live/);
    expect(reason).toMatch(new RegExp(`--pid\\s+${LIVE_A}`));
    expect(reason).toMatch(new RegExp(`--pid\\s+${LIVE_B}`));
  });

  it('counts only LIVE bridges — a stale token file from a dead app is not ambiguity', () => {
    writeBridge(LIVE_A, 46423);
    writeBridge(DEAD, 111); // stale: the tool itself skips + unlinks these
    expectAllow(runTat('tauri-agent-tools dom body'));
  });

  it.each([
    ['probe — the ANSWER to the deny, so it must never be blocked', 'tauri-agent-tools probe'],
    ['list-windows', 'tauri-agent-tools list-windows'],
    ['info', 'tauri-agent-tools info'],
    ['forensics (bridge-free)', 'tauri-agent-tools forensics --identifier ai.papercup'],
    ['app-paths (bridge-free)', 'tauri-agent-tools app-paths --identifier ai.papercup'],
    ['--help', 'tauri-agent-tools --help'],
    ['bare (usage)', 'tauri-agent-tools'],
  ])('never gates discovery / bridge-free commands: %s', (_l, command) => {
    writeBridge(LIVE_A, 46423);
    writeBridge(LIVE_B, 43929); // maximally ambiguous — still allowed
    expectAllow(runTat(command));
  });

  it('ALLOWS when NO bridge is live — nothing to hit; the tool prints its own error', () => {
    expectAllow(runTat(`tauri-agent-tools eval 'document.title'`));
  });

  // EI-21971958067151594 — the SPELLING hole. `capability:bash` is the same
  // shell reached over MCP, and it was exempt from this whole file: the script
  // early-returned on tool_name, and the installers registered a native-only
  // `Bash` matcher. Measured live 2026-08-31 with 3 real bridges up: this exact
  // command was DENIED as `Bash` and RAN as `capability:bash`, dumping a foreign
  // 2669x1391 webview. The guard is only as wide as its narrowest spelling, so
  // the deny is pinned per-spelling rather than once.
  it.each([
    ['claude native', 'Bash'],
    ['claude MCP shell (EI-21971958067151594)', 'mcp__papercusp-su__capability_bash'],
    ['MCP shell, any server segment', 'mcp__some-other-server__capability_bash'],
    ['codex exec_command', 'exec_command'],
  ])('DENIES an unaimed mutating command spelled as %s', (_l, tool) => {
    writeBridge(LIVE_A, 46423);
    const out = runGate(
      bashCmd(`tauri-agent-tools eval 'document.title'`, { tool }),
      { ...AGENT, TMPDIR: tmpBridgeDir },
    );
    expect(denyReason(out)).toMatch(/DRIVES a webview but does not say WHICH/);
  });

  // The name test is ANCHORED for a reason: these two take a `bash_id`, never a
  // `command`, so they are readers rather than shells. A loose prefix match
  // would pull them in and make every background-log read pay the gate.
  it.each([
    ['capability_bash_output', 'mcp__papercusp-su__capability_bash_output'],
    ['capability_bash_kill', 'mcp__papercusp-su__capability_bash_kill'],
  ])('does NOT treat %s as a shell', (_l, tool) => {
    writeBridge(LIVE_A, 46423);
    expectAllow(runGate(
      { tool_name: tool, tool_input: { bash_id: 'b-1' }, session_id: 's-test' },
      { ...AGENT, TMPDIR: tmpBridgeDir },
    ));
  });

  it('guards a full-path / npx invocation too (the binary is a global install)', () => {
    writeBridge(LIVE_A, 46423);
    expect(
      denyReason(runTat(`/home/linuxbrew/.linuxbrew/bin/tauri-agent-tools click '#b'`)),
    ).toMatch(/DRIVES a webview/);
  });

  it('a quoted PROSE mention is not an invocation (no false deny)', () => {
    writeBridge(LIVE_A, 46423);
    expectAllow(runTat(`echo "you could run tauri-agent-tools eval document.title"`));
  });
});

describe('destructive tree-wide git guard (hive-loop-supervision-2026-06-21, agent sessions) — EI-2376 recurrence guard', () => {
  // WI-1507930 pilot: these cases are pure, read-only, independent verdict probes — each one
  // spawns the hook, reads a decision, shares nothing. `.concurrent` alone would buy NOTHING here
  // (runGate is spawnSync and blocks the event loop), so it is paired with runGateAsyncFull.
  //
  // ⛔ DO NOT ROLL THIS OUT TO THE OTHER ~377 `runGate(` SITES — measured, and it does not pay.
  // Controlled A/B on 2026-08-31, same code, back-to-back: `--maxConcurrency=1` 107,876ms vs
  // default 104,708ms — 3.0% for these 47 cases, against ~5s of run-to-run variance on this box.
  // The cause is structural, not a tuning miss: each spawn is a CPU-BOUND Python interpreter
  // (see mapWithConcurrency below — "the total CPU work is identical either way"), so on a loaded
  // box overlapping them reclaims little. The gate suite runs at exactly that load. The real lever
  // for this file is per-invocation cost, not parallelism: EI-20226903620041425 measured 28ms of
  // the ~129ms as Python re-compile the hook could cache = ~24.6s here, load-independent, and worth
  // far more in production. Spend there first.
  it.concurrent.each([
    ['bare reset --hard', 'git reset --hard'],
    ['reset --hard HEAD', 'git reset --hard HEAD'],
    ['reset --hard a remote ref', 'git reset --hard origin/staging'],
    ['clean -f', 'git clean -f'],
    ['clean -fd', 'git clean -fd'],
    ['clean -fdx', 'git clean -fdx'],
    ['checkout .', 'git checkout .'],
    ['checkout -- .', 'git checkout -- .'],
    ['checkout :/ (repo-root pathspec)', 'git checkout :/'],
    ['restore .', 'git restore .'],
    ['bare stash', 'git stash'],
    ['stash save', 'git stash save "wip"'],
    ['stash push (no explicit path)', 'git stash push'],
    ['sudo-prefixed reset --hard', 'sudo git reset --hard'],
    ['compound && reset --hard', 'cd /tmp && git reset --hard'],
    ['compound ; clean -f', 'git status ; git clean -f'],
    ['newline-separated stash', 'git status\ngit stash'],
    ['git -C <dir> reset --hard', 'git -C /some/repo reset --hard'],
    // wrapper-prefix bypass class (definetool-token-reduction-uncovered-surfaces P-014;
    // PROVEN 2026-07-06: the guard denied `git reset --hard` but ALLOWED `rtk git reset
    // --hard`). rtk = the token-killer output filter, which rewrites `git …`→`rtk git …`.
    ['rtk-wrapped reset --hard (the RTK rewrite that motivated this)', 'rtk git reset --hard HEAD'],
    ['time-wrapped reset --hard', 'time git reset --hard'],
    ['env-assignment-wrapped clean -fd', 'env FOO=bar git clean -fd'],
    ['nice -n N wrapped stash', 'nice -n 5 git stash'],
    ['command-wrapped checkout .', 'command git checkout .'],
    ['nohup-wrapped restore .', 'nohup git restore .'],
    ['sudo -u <user> value-flag checkout .', 'sudo -u marsh git checkout .'],
    ['nested wrappers (time rtk) reset --hard', 'time rtk git reset --hard'],
    // EI-18215743778965613 (self-caught 2026-07-20): `pop`/`apply` and a
    // scoped `push -- <path>` used to be exempted — but the stash is a SINGLE
    // shared LIFO stack, so a scoped push followed by `pop` popped an
    // UNRELATED entry, conflicting in files never touched by the caller.
    ['stash pop', 'git stash pop'],
    ['stash apply', 'git stash apply'],
    ['stash push with an explicit `--` path (no longer exempt — see EI-18215743778965613)', 'git stash push -- path/to/file.ts'],
    // WI-6554700010017558: drop/clear delete entries on the shared stack and
    // branch switches the shared tree's branch, so none of them is exempt.
    ['stash drop', 'git stash drop'],
    ['stash branch', 'git stash branch wip-x'],
    ['stash clear', 'git stash clear'],
    ['stash listing-prefixed subcommand is not mistaken for list', 'git stash listx'],
  ])('denies %s', async (_label, command) => {
    expectGitDeny(await runGateAsyncFull(bashCmd(command), AGENT));
  });

  it.concurrent.each([
    ['checkout of an explicit single file', 'git checkout -- path/to/file.ts'],
    ['restore of an explicit single file', 'git restore path/to/file.ts'],
    ['stash list', 'git stash list'],
    ['stash show', 'git stash show'],
    ['stash show of a named entry', 'git stash show -p stash@{1}'],
    ['clean dry-run (no f flag)', 'git clean -n'],
    ['reset (no --hard)', 'git reset HEAD~1'],
    ['reset --soft', 'git reset --soft HEAD~1'],
    ['ordinary status', 'git status'],
    ['ordinary diff', 'git diff --stat'],
    ['"reset --hard" only in a commit message, not command position', 'git commit -m "docs: explain git reset --hard"'],
    ['"git reset --hard" inside a string arg, not command position', 'echo "git reset --hard"'],
    ['rtk-wrapped safe read (no false positive)', 'rtk git status'],
    ['time-wrapped safe read (no false positive)', 'time git log --oneline'],
    ['env-wrapped safe read (no false positive)', 'env FOO=bar git diff --stat'],
  ])('allows %s', async (_label, command) => {
    expectAllow(await runGateAsyncFull(bashCmd(command), AGENT));
  });

  // ── EI-7872: the guard keys on the SHARED TREE, not a fragile env marker ──
  // The PAPERCUSP_AGENT_SESSION marker is silently absent in fleet-launched
  // sessions (verified 2026-07-06 in the Claude process env this hook inherits),
  // which left this rail INERT for exactly the sessions it must protect. The
  // guard now fires on cwd ∈ the canonical staging tree — WITHOUT any marker —
  // and stays exempt in the owner's own separate checkouts (a different cwd),
  // preserving the D-003 intent by TREE rather than by marker.
  it.each([
    ['reset --hard in the canonical tree', 'git reset --hard', CANON],
    ['clean -fd in a subdir of the canonical tree', 'git clean -fd', `${CANON}/apps/operator`],
    ['bare stash in the canonical tree', 'git stash', CANON],
    ['checkout . in the canonical tree', 'git checkout .', CANON],
  ])('fires WITHOUT the agent marker: %s (EI-7872 fail-open fix)', (_label, command, cwd) => {
    expectGitDeny(runGate(bashCmd(command, { cwd }), CANON_ENV));
  });

  it.each([
    ["owner's release checkout (sibling of the canonical tree)", '/ws/papercupai-workspace/papercup-release'],
    ['a name that PREFIXES the canonical tree but is a sibling', '/ws/papercupai-workspace/papercusp-staging'],
    ['an unrelated repo outside the workspace', '/tmp/some-other-repo'],
  ])('does NOT fire without the marker outside the canonical tree — %s (D-003 preserved)', (_label, cwd) => {
    expectAllow(runGate(bashCmd('git reset --hard', { cwd }), CANON_ENV));
  });

  it('still honors the agent marker even OUTSIDE the canonical tree (OR-trigger)', () => {
    expectGitDeny(runGate(bashCmd('git reset --hard', { cwd: '/tmp/elsewhere' }), { ...AGENT, ...CANON_ENV }));
  });
});

describe('redirected-work-tree index guard (WI-6554700010017981)', () => {
  // `git --work-tree=<dir>` moves only where FILES land. The index, HEAD and refs
  // still come from the git dir found from cwd/-C, so run from the shared checkout
  // it rewrites the SHARED .git/index. The first case is the exact command that, on
  // 2026-10-18, staged b42a3e8a35's blobs over 91 tracked paths of the shared index.
  // It already tripped the `checkout .` guard, with a reason about discarding
  // uncommitted work; every narrower form below used to pass. The guard keys on the
  // tree, not the agent marker, so these run with CANON_ENV alone.
  const expectWorkTreeDeny = (out: GateOut) => {
    expectGitDeny(out);
    expect(parseDecision(out).hookSpecificOutput.permissionDecisionReason).toContain('WI-6554700010017981');
  };
  const SUB = `${CANON}/apps/operator`;

  it.concurrent.each([
    ['the exact 2026-10-18 export command', 'git --work-tree=/tmp/pc-candidate-b42a3e8a35 checkout b42a3e8a35fd9af27be3609f5fcf992bef6ff17c -- .', CANON],
    ['checkout of a narrower pathspec', 'git --work-tree=/tmp/x checkout b42a3e8a35 -- src/', CANON],
    ['space-separated --work-tree value', 'git --work-tree /tmp/x checkout b42a3e8a35 -- src/', CANON],
    ['GIT_WORK_TREE assignment prefix', 'GIT_WORK_TREE=/tmp/x git checkout b42a3e8a35 -- src/', CANON],
    ['exported GIT_WORK_TREE earlier in the command', 'export GIT_WORK_TREE=/tmp/x; git add -A', CANON],
    ['read-tree -u', 'git --work-tree=/tmp/x read-tree -u b42a3e8a35', CANON],
    ['add -A', 'git --work-tree=/tmp/x add -A', CANON],
    ['mixed reset', 'git --work-tree=/tmp/x reset b42a3e8a35', CANON],
    ['restore --staged', 'git --work-tree=/tmp/x restore --staged --source=b42a3e8a35 -- src/', CANON],
    ['a ref writer even with a private index', 'GIT_INDEX_FILE=/tmp/idx git --work-tree=/tmp/x commit -am wip', CANON],
    ['checkout without `--` (can move HEAD) even with a private index', 'GIT_INDEX_FILE=/tmp/idx git --work-tree=/tmp/x checkout some-branch', CANON],
    ['timeout-wrapped', 'timeout 60 git --work-tree=/tmp/x checkout b42a3e8a35 -- src/', CANON],
    ['bash -c payload', "bash -c 'git --work-tree=/tmp/x checkout b42a3e8a35 -- src/'", CANON],
    ['rtk-wrapped', 'rtk git --work-tree=/tmp/x add -A', CANON],
    ['from a subdirectory of the canonical tree', 'git --work-tree=/tmp/x add -A', SUB],
    ['-C into the canonical tree from outside', `git -C ${CANON} --work-tree=/tmp/x checkout b42 -- src/`, '/tmp'],
    ['a leading cd into the canonical tree', `cd ${CANON} && git --work-tree=/tmp/x add -A`, '/tmp'],
  ])('denies %s', async (_label, command, cwd) => {
    expectWorkTreeDeny(await runGateAsyncFull(bashCmd(command, { cwd }), CANON_ENV));
  });

  it.concurrent.each([
    ['the recommended archive export', 'git archive b42a3e8a35 | tar -x -C /tmp/x', CANON],
    ['an index-only form with a private GIT_INDEX_FILE', 'GIT_INDEX_FILE=$(mktemp -u) git --work-tree=/tmp/x checkout b42a3e8a35 -- src/', CANON],
    ['env-wrapped private index', 'env GIT_INDEX_FILE=/tmp/idx git --work-tree=/tmp/x read-tree -u b42a3e8a35', CANON],
    ['an explicit --git-dir', 'git --git-dir=/tmp/x/.git --work-tree=/tmp/x checkout b42a3e8a35 -- src/', CANON],
    ['a GIT_DIR assignment', 'GIT_DIR=/tmp/x/.git git --work-tree=/tmp/x add -A', CANON],
    ['read-only status', 'git --work-tree=/tmp/x status', CANON],
    ['read-only diff', 'git --work-tree=/tmp/x diff --stat', CANON],
    ['checkout-index (writes files, not the index)', 'git --work-tree=/tmp/x checkout-index -a --prefix=/tmp/y/', CANON],
    ['restore without --staged (writes files only)', 'git --work-tree=/tmp/x restore --source=b42a3e8a35 -- src/', CANON],
    ['an ordinary single-path checkout with no redirect', 'git checkout b42a3e8a35 -- src/', CANON],
    ['-C into another repository', 'git -C /tmp/other-repo --work-tree=/tmp/x checkout b42 -- src/', CANON],
    ['the construct only inside an echo string', 'echo "never run git --work-tree=/tmp/x add -A"', CANON],
    ['the construct only inside a commit message', 'git commit -m "explain git --work-tree=/tmp/x add -A"', CANON],
    ['a cwd outside the canonical tree', 'git --work-tree=/tmp/x checkout b42 -- src/', '/tmp/other-repo'],
  ])('allows %s', async (_label, command, cwd) => {
    expectAllow(await runGateAsyncFull(bashCmd(command, { cwd }), CANON_ENV));
  });
});

describe('GOAL-mode tracked Bash mutation bridge (EI-21567270631276419)', () => {
  // This file cannot make /ws/... a real Git checkout, so hook/server integration
  // is pinned in the fake-operator suite below. These local controls prove the
  // classifier remains quiet for reads, prose, expansions, and out-of-tree work.
  it.each([
    ['git status', 'git status'],
    ['git diff', 'git diff --stat'],
    ['quoted prose', 'echo "git mv old.ts new.ts"'],
    ['expansion-bearing rename', 'git mv "$SRC" "$DST"'],
    ['out-of-tree rename', 'mv /tmp/old.ts /tmp/new.ts'],
  ])('allows %s without a tracked mutation verdict', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });
});

/**
 * EI-19294800751120438 — the WRAPPED/QUOTED command evasion class.
 *
 * Every deny-guard in the gate used to match RAW command text: split on [;&|\n],
 * peel a hand-maintained wrapper NAME-list, `re.match` an anchored pattern. Measured
 * before the fix: 4 DENY / 14 probes on the shared-tree git guard, and the same hole
 * in the pkill, systemctl-exit and crontab guards. `bash -c "…"` defeated all of them.
 *
 * The wrapper name-list is specifically what rotted — the 2026-07-06 `rtk` bypass was
 * fixed by ADDING `rtk` to the list, which left `timeout` open for another three
 * weeks. So the fix was structural: ONE `scannable_command()` normalizer (quote
 * stripping, ANSI-C decoding, heredoc handling, and recursive descent into every
 * executed shell payload, with wrappers peeled by parsing argv rather than by name),
 * which every guard now matches through.
 *
 * This table is the regression net whose ABSENCE let `timeout` hide. Each case is a
 * form that was measured ALLOW before the fix. A new guard added to the gate should
 * get a row here too.
 */
describe('wrapped/quoted command evasion (EI-19294800751120438)', () => {
  describe('shared-tree git guard', () => {
    it.each([
      ['bash -c', 'bash -c "git reset --hard"'],
      ['sh -c with single quotes', "sh -c 'git clean -fd'"],
      ['eval', 'eval "git reset --hard"'],
      ['quoted argument tokens', 'git "reset" "--hard"'],
      ['command substitution', '$(echo git) reset --hard'],
      ['variable indirection', 'x=git; $x reset --hard'],
      ['pipe-to-shell', 'echo "git reset --hard" | bash'],
      ['here-string', 'bash <<< "git reset --hard"'],
      ['env --split-string', 'env -S "git reset --hard"'],
      // `timeout` was NOT in the old _WRAP_STRIP name-list — the exact rot this fixes.
      ['timeout wrapper', 'timeout 60 git reset --hard'],
      ['nested wrappers around a -c payload', 'timeout 60 sudo bash -c "git reset --hard"'],
      ['heredoc fed to a shell', 'bash <<EOF\ngit reset --hard\nEOF'],
    ])('denies %s', (_label, command) => {
      expectGitDeny(runGate(bashCmd(command), AGENT));
    });
  });

  describe('pkill/killall guard', () => {
    it.each([
      ['bash -c', 'bash -c "pkill -f node"'],
      ['eval', 'eval "pkill -f node"'],
      ['killall via bash -c', 'bash -c "killall vitest"'],
      ['sh -c', "sh -c 'pkill -f vitest'"],
    ])('denies %s', (_label, command) => {
      expectPkillDeny(runGate(bashCmd(command)));
    });

    // The regression this table caught during the fix itself: an early version of the
    // normalizer collapsed a multi-word quoted span to `""`, so `pkill -f "npm run
    // test"` became `pkill -f ""` and the guard — which matches on the pattern
    // ARGUMENT — stopped firing. Quoted spans now keep their words.
    it('still denies a QUOTED multi-word pattern (span content must survive unquoting)', () => {
      expectPkillDeny(runGate(bashCmd('pkill -f "npm run test"')));
    });
  });

  describe('systemd user-manager exit guard', () => {
    it.each([
      ['bash -c', 'bash -c "systemctl --user exit"'],
      ['eval', 'eval "systemctl --user exit"'],
    ])('denies %s', (_label, command) => {
      expectExitGuardDeny(runGate(bashCmd(command)));
    });
  });

  describe('native-scheduler lockout', () => {
    it.each([
      ['bash -c', 'bash -c "crontab -e"'],
      ['command substitution', '$(echo crontab) -e'],
      // Mutating payload on purpose: this case tests that a WRAPPED payload is
      // surfaced and scanned at all, and until EI-20419484186942049 it spelled
      // that payload `crontab -l` — a listing, now correctly exempt. A read here
      // would assert the evasion path is closed while proving nothing about it.
      ['sh -c', "sh -c 'crontab -e'"],
    ])('denies %s', (_label, command) => {
      expectDeny(runGate(bashCmd(command), AGENT));
    });
  });

  /**
   * The other half of the contract. Surfacing quoted words to the guards must NOT
   * make ordinary work deniable — a false positive here blocks the whole fleet, which
   * is strictly worse than the hole being closed. These hold because every guard
   * anchors with `re.match`: unquoted inner words appear mid-segment, not at command
   * position, so they cannot match a destructive pattern.
   */
  describe('does not over-block once quoted content is surfaced', () => {
    it.each([
      ['a commit message naming a destructive op', 'git commit -m "docs: explain git reset --hard"'],
      ['a string argument naming a destructive op', 'echo "git reset --hard"'],
      ['a quoted regex alternation (EI-9937)', 'grep -E "at|batch" scripts/foo.ts'],
      ['prose mentioning crontab', 'echo "remember: crontab is denied here"'],
      ['a heredoc written to a FILE, not run', 'cat <<EOF > /tmp/notes.txt\ngit reset --hard\nEOF'],
      ['searching the tree for pkill', "rg -n 'pkill' apps/operator"],
      ['a scoped single-file checkout', 'git checkout -- path/to/one.file.ts'],
      ['a soft reset', 'git reset --soft HEAD~1'],
      ['stash list (read-only)', 'git stash list'],
      ['killing a specific pid', 'kill 12345'],
    ])('allows %s', (_label, command) => {
      expectAllow(runGate(bashCmd(command), AGENT));
    });
  });
});

describe('host PostgreSQL restart guard (WI-6554700010008482)', () => {
  it.each([
    ['the incident command', 'systemctl restart postgresql@18-main.service'],
    ['a sudo-prefixed restart', 'sudo systemctl restart postgresql@18-main.service'],
    ['an explicit system-manager restart', 'systemctl --system restart postgresql.service'],
    ['the wildcard form', 'systemctl restart postgresql*'],
    ['a nested shell command', 'bash -c "systemctl restart postgresql@18-main.service"'],
    ['an env-wrapped command', 'env FOO=bar systemctl restart postgresql@18-main.service'],
  ])('denies %s without requiring an agent marker', (_label, command) => {
    const reason = denyReason(runGate(bashCmd(command)));
    expect(reason).toContain('host PostgreSQL restart guard');
    expect(reason).toContain('WI-6554700010008482');
  });

  it.each([
    ['a user service restart', 'systemctl --user restart papercup-staging-api.service'],
    ['a different host service restart', 'systemctl restart redis.service'],
    ['a PostgreSQL status read', 'systemctl status postgresql@18-main.service'],
    ['quoted prose', 'echo "systemctl restart postgresql@18-main.service"'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command)));
  });
});

/**
 * EI-13135 — systemd user-manager exit/kill guard.
 *
 * `systemctl --user exit` tears down the WHOLE shared user@<uid> manager in
 * one shot (bg-host, :3070, :3170, gateway, git-sync, mcp-proxy, every other
 * live agent session's scope) — confirmed root cause of a ~15min fleet-wide
 * outage on 2026-07-16. UNCONDITIONAL: unlike the git-guard, this fires with
 * NO agent marker and NO tree/cwd condition at all — the resource is the
 * whole host, not a working tree, so every test here omits AGENT/CANON_ENV
 * entirely to prove that.
 */
function expectExitGuardDeny(out: { stdout: string; status: number | null }) {
  const reason = denyReason(out);
  expect(reason).toContain('EI-13135');
}

describe('systemd user-manager exit/kill guard (EI-13135)', () => {
  it.each([
    ['systemctl --user exit', 'systemctl --user exit'],
    ['systemctl exit (no --user flag)', 'systemctl exit'],
    ['systemctl --user start exit.target', 'systemctl --user start exit.target'],
    ['systemctl --user halt', 'systemctl --user halt'],
    ['systemctl --user poweroff', 'systemctl --user poweroff'],
    ['loginctl terminate-user', 'loginctl terminate-user someuser'],
    ['loginctl kill-user', 'loginctl kill-user 1000'],
    ['systemctl stop user@<uid>.service', 'systemctl stop user@1000.service'],
    ['systemctl kill user@<uid>.service', 'systemctl kill user@1000.service'],
    ['sudo-prefixed exit', 'sudo systemctl --user exit'],
    ['compound && exit', 'cd /tmp && systemctl --user exit'],
    ['compound ; halt', 'echo done ; systemctl --user halt'],
    ['newline-separated', 'true\nsystemctl --user exit'],
    ['rtk-wrapped (the same wrapper-bypass class as the git-guard)', 'rtk systemctl --user exit'],
    ['time-wrapped', 'time systemctl --user exit'],
    ['env-wrapped', 'env FOO=bar systemctl --user exit'],
  ])('denies %s — with NO agent marker, NO tree cwd', (_label, command) => {
    expectExitGuardDeny(runGate(bashCmd(command)));
  });

  it.each([
    ['status is not exit', 'systemctl --user status papercup-staging-api.service'],
    ['restart a real service is not exit', 'systemctl --user restart papercup-staging-api.service'],
    ['stop a real service is not the user@ class', 'systemctl --user stop papercup-vite.service'],
    ['"exit" only in a commit message, not command position', 'git commit -m "handle process exit"'],
    ['"systemctl --user exit" inside a quoted string, not command position', 'echo "systemctl --user exit"'],
    ['a stop of an unrelated numbered service (not user@)', 'systemctl stop worker@1000.service'],
    ['ordinary command', 'ls -la'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command)));
  });
});

/**
 * EI-18690252462401774 — pkill/killall host-wide dev-process guard.
 *
 * `pkill -f <substring>` (and `killall <name>`) match by process cmdline/name
 * SUBSTRING across the ENTIRE host process table, not scoped to the caller's
 * own PID tree. An agent cleaning up its OWN redundant backgrounded
 * `npm run test:affected` job ran `pkill -f "test:affected"` and collaterally
 * killed 5-6 OTHER agents' in-flight `test:affected` runs on this shared host
 * (2026-07-26). UNCONDITIONAL: like the systemd exit-guard above, this fires
 * with NO agent marker and NO tree/cwd condition — the hazard is host-wide
 * process-table scope, not a working tree.
 */
function expectPkillDeny(out: { stdout: string; status: number | null }) {
  const reason = denyReason(out);
  expect(reason).toContain('EI-18690252462401774');
}

/**
 * DENIAL FORENSICS (EI-19421518638516187).
 *
 * The guard used to deny with a reason naming only the RESOLVED TARGET, and
 * wrote no log anywhere — so the denied command vanished with the turn and every
 * false-positive report was reconstructed from memory. Four tickets from three
 * agents all named the wrong cause that way; the load-bearing detail (a `#`
 * comment) is exactly what a hand-written repro drops.
 *
 * Two separate outputs, tested separately because they serve different readers:
 * the REASON tells the blocked agent what the guard was looking at right now,
 * and the LOG preserves primary evidence for whoever writes the ticket later.
 */
describe('denial forensics — deny reason + denial log (EI-19421518638516187)', () => {
  const denialLog = () =>
    join(fakeHome, '.papercusp', 'hooks', 'cc', 'bash-resource-gate.denials.log');
  const logSize = () => (existsSync(denialLog()) ? statSync(denialLog()).size : 0);

  it('includes the matched POST-normalization fragment in the deny reason', () => {
    const reason = denyReason(
      runGate(bashCmd('cat foo > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('What the guard actually matched');
    expect(reason).toContain('cat foo > apps/operator/generated.ts');
  });

  /**
   * The case that matters: when the normalizer has transformed the command, the
   * reason must show the TRANSFORMED text, because the difference between what
   * you typed and what the guard read IS the diagnosis. Here the `#` comment is
   * stripped, so it must not appear in the reported fragment.
   */
  it('reports normalized text that visibly differs from the raw command', () => {
    const reason = denyReason(
      runGate(
        bashCmd('# note "\ncat foo > apps/operator/generated.ts && echo "x"', { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('What the guard actually matched');
    expect(reason).not.toContain('# note');
  });

  it('records the VERBATIM command — the thing a from-memory repro loses', () => {
    const command = 'cat forensics-probe > apps/operator/generated.ts';
    runGate(bashCmd(command, { cwd: CANON }), CANON_ENV);
    const lines = readFileSync(denialLog(), 'utf8').trim().split('\n');
    const rec = JSON.parse(lines[lines.length - 1]);
    expect(rec.command).toBe(command);
    expect(rec.matchedFragment).toContain('apps/operator/generated.ts');
    expect(rec.reason).toContain('shell-write guard');
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('logs nothing for an ALLOW — the log is denials only, not a command journal', () => {
    const before = logSize();
    expectAllow(runGate(bashCmd('echo hello', { cwd: CANON }), CANON_ENV));
    expect(logSize()).toBe(before);
  });
});

/**
 * CLASS recurrence guard for the comment/quote-parity bypass
 * (EI-19420133701663526).
 *
 * A `#` comment containing an ODD number of quote characters breaks quote
 * parity for every normalizer in this hook. The filed report was about the
 * redirect scanner, but the hole was never redirect-specific: the SAME prefix
 * silently disarmed every other deny-guard, including the ones protecting
 * against irrecoverable loss of peers' uncommitted work (`git reset --hard`,
 * `git clean -fd`, `git stash`) and against killing the owner's desktop
 * (`pkill -f`). All measured ALLOW against the pre-fix build.
 *
 * Two DIFFERENT mechanisms, one root cause — which is why the fix needed two
 * sites and why this guard covers several guards rather than one:
 *   - redirect/interpreter scanners: the deleted span SWALLOWS the redirect
 *     outright, so nothing is left to match.
 *   - everything routed through `_scannable_command`: nothing is deleted, but
 *     the stray quote makes `_scan_dequote` read the newline and `&&` as quoted
 *     DATA, flattening the dangerous command onto the comment's line. It
 *     survives intact yet is no longer at COMMAND POSITION, which every one of
 *     those guards anchors on.
 *
 * Both quote characters are exercised: the report named only `"`, and driving
 * the real hook showed `'` breaks parity identically, so a fix verified on one
 * leaves half the hole open. If either normalizer stops stripping comments
 * quote-awarely, these fail instead of the bypass reopening silently.
 */
describe('comment quote-parity bypass — CLASS recurrence guard (EI-19420133701663526)', () => {
  /** A comment carrying one unbalanced quote, plus a trailing quoted word for it to pair with. */
  const withDoubleQuoteComment = (cmd: string) => `# note "\n${cmd} && echo "x"`;
  const withSingleQuoteComment = (cmd: string) => `# don't\n${cmd} && echo 'x'`;

  it.each([
    ['git reset --hard', 'git reset --hard'],
    ['git clean -fd', 'git clean -fd'],
    ['git checkout -- :/', 'git checkout -- :/'],
    ['git stash', 'git stash'],
  ])('still denies %s behind a parity-breaking comment (double quote)', (_label, command) => {
    expectGitDeny(runGate(bashCmd(withDoubleQuoteComment(command)), AGENT));
  });

  it.each([
    ['git reset --hard', 'git reset --hard'],
    ['git clean -fd', 'git clean -fd'],
    ['git stash', 'git stash'],
  ])('still denies %s behind a parity-breaking comment (single quote)', (_label, command) => {
    expectGitDeny(runGate(bashCmd(withSingleQuoteComment(command)), AGENT));
  });

  it('still denies a host-wide pkill behind a parity-breaking comment', () => {
    expectPkillDeny(runGate(bashCmd(withDoubleQuoteComment('pkill -f vitest'))));
  });

  it('still denies a self-matching pgrep wait-loop behind a parity-breaking comment', () => {
    expectSelfMatchDeny(
      runGate(bashCmd(withDoubleQuoteComment('until ! pgrep -f myjob; do sleep 5; done'))),
    );
  });

  /**
   * The other direction, so the fix cannot be "strip anything after a #".
   * A `#` that is NOT a comment introducer — inside quotes, or mid-word — must
   * still leave the command fully visible to the guards.
   */
  it('still denies when the `#` is inside a quoted argument, not a comment', () => {
    expectGitDeny(runGate(bashCmd('echo "a # b" && git reset --hard'), AGENT));
  });

  it('allows an ordinary command whose comment merely mentions a dangerous string', () => {
    expectAllow(runGate(bashCmd('git status  # never run git reset --hard here'), AGENT));
  });
});

describe('pkill/killall host-wide dev-process guard (EI-18690252462401774)', () => {
  it.each([
    ['pkill -f test:affected (the exact repro)', 'pkill -f "test:affected"'],
    ['pkill -f test:affected, unquoted', 'pkill -f test:affected'],
    ['killall vitest', 'killall vitest'],
    ['pkill -f npm run test', 'pkill -f "npm run test"'],
    ['pkill -f vitest', 'pkill -f vitest'],
    ['pkill -f jest', 'pkill -f jest'],
    ['pkill -f tsc', 'pkill -f tsc'],
    ['pkill node', 'pkill node'],
    ['killall -9 python3', 'killall -9 python3'],
    ['pkill -f playwright', 'pkill -f playwright'],
    ['pkill -f cargo', 'pkill -f cargo'],
    ['sudo-prefixed', 'sudo pkill -f "npm run test"'],
    ['compound &&', 'cd /tmp && pkill -f vitest'],
    ['compound ;', 'echo done ; killall vitest'],
    ['newline-separated', 'true\npkill -f test:affected'],
    ['rtk-wrapped (the same wrapper-bypass class as the git-guard)', 'rtk pkill -f vitest'],
    ['time-wrapped', 'time pkill -f test:affected'],
    ['env-wrapped', 'env FOO=bar pkill -f vitest'],
  ])('denies %s — with NO agent marker, NO tree cwd', (_label, command) => {
    expectPkillDeny(runGate(bashCmd(command)));
  });

  it.each([
    ['a genuinely unique/caller-specific pattern', 'pkill -f my-unique-script-xyz123'],
    ['killing a specific PID (the recommended remedy)', 'kill -9 12345'],
    ['killing a specific PID, plain', 'kill 12345'],
    ['read-only pgrep (not pkill/killall)', 'pgrep vitest'],
    ['prose mention, not command position', 'echo "you could pkill -f vitest here"'],
    ['a commit message mentioning it', 'git commit -m "fix: guard against pkill -f test:affected"'],
    ['ordinary command', 'ls -la'],
    ['ordinary process listing', 'ps aux | grep vitest'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command)));
  });
});

/**
 * Wait-loop self-match (EI-19312699396945642): `until ! pgrep -f '<pat>'; do
 * sleep …; done` can never exit from an agent shell — the loop's own bash -c
 * argv contains the pattern, so `pgrep -f` (full-cmdline match) finds the
 * poller itself and the condition holds forever. A peer burned 27 silent
 * minutes exactly here (2026-08-02). `ps | grep` loop conditions share the
 * defect, and `grep -v grep` does NOT fix it (the bash -c wrapper still
 * matches). UNCONDITIONAL, same rationale as the pkill guard. Scoped to loop
 * CONDITIONS: one-shot pgrep/ps|grep reads terminate and stay allowed. The
 * separate WI-7134 advisory below warns on an unbracketed one-shot `pgrep -f`
 * without converting it into a denial.
 */
function expectSelfMatchDeny(out: { stdout: string; status: number | null }) {
  const reason = denyReason(out);
  expect(reason).toContain('EI-19312699396945642');
}

describe('process-table wait-loop self-match guard (EI-19312699396945642)', () => {
  it.each([
    [
      'the exact live repro (27-min silent loop)',
      "until ! pgrep -f 'lint-tsc' >/dev/null; do sleep 5; done; echo \"=== lint:tsc finished ===\"",
    ],
    ['while-form pgrep -f poll', 'while pgrep -f test:affected >/dev/null; do sleep 10; done'],
    ['bundled short flag (-qf)', 'until ! pgrep -qf my-build-marker; do sleep 2; done'],
    ['long flag (--full)', 'while pgrep --full some-long-job; do sleep 1; done'],
    ['ps|grep loop condition', 'until ! ps aux | grep -q build-step; do sleep 5; done'],
    [
      'ps|grep with grep -v grep (still self-matches via the bash -c wrapper)',
      'while ps aux | grep my-task | grep -v grep; do sleep 5; done',
    ],
    ['bash -c wrapped (the argv that actually self-matches)', 'bash -c "until ! pgrep -f lint-tsc; do sleep 5; done"'],
    ['after a compound separator', 'echo start; until ! pgrep -f render-job; do sleep 3; done'],
  ])('denies %s', (_label, command) => {
    expectSelfMatchDeny(runGate(bashCmd(command)));
  });

  it.each([
    ["bracket idiom pgrep (the documented escape): pgrep -f '[l]int-tsc'", "until ! pgrep -f '[l]int-tsc' >/dev/null; do sleep 5; done"],
    ["bracket idiom ps|grep: grep '[b]uild-step'", "until ! ps aux | grep '[b]uild-step'; do sleep 5; done"],
    ['name-only pgrep (no -f: matches comm, not the argv)', 'until ! pgrep myserver; do sleep 5; done'],
    ['pidfile flag -F is not -f', 'while pgrep -F /run/x.pid worker; do sleep 5; done'],
    ['one-shot ps|grep (the routine listing idiom)', 'ps aux | grep "npm install"'],
    ['PID-based wait loop (the recommended remedy)', 'while kill -0 12345; do sleep 5; done'],
    ['tail --pid wait (the other remedy)', 'tail --pid=12345 -f /dev/null'],
    ['non-process-table until loop', 'until curl -s localhost:3070/api/health; do sleep 2; done'],
    ['prose mention, not command position', 'echo "an until pgrep -f loop never exits"'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command)));
  });
});

/**
 * WI-7134 — a one-shot `pgrep -f <literal>` terminates, but the returned PID
 * set is still contaminated by the invoking `bash -c`, whose argv contains the
 * same literal pattern. Keep this SOFT: teach the managed-task and raw-host
 * alternatives while allowing the caller's diagnostic to run.
 */
describe('bare pgrep -f self-match advisory (WI-7134)', () => {
  function expectPgrepAdvisory(out: { stdout: string; status: number | null }) {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow');
    expect(hso.additionalContext).toContain('bare pgrep -f self-match advisory');
    expect(hso.additionalContext).toContain('processes:list');
    expect(hso.additionalContext).toContain('coordOwnerId');
    expect(hso.additionalContext).toContain('scripts/proc-guard.mjs');
  }

  it.each([
    ['the reported one-shot shape', 'pgrep -f owner-id-123'],
    ['bundled short options', 'pgrep -af owner-id-123'],
    ['long --full option', 'pgrep --full owner-id-123'],
    ['explicit option terminator', 'pgrep -f -- owner-id-123'],
    ['path-qualified binary in a pipeline', '/usr/bin/pgrep -qf owner-id-123 | head -1'],
    ['conditional query', 'if pgrep -f owner-id-123; then echo live; fi'],
    ['nested shell payload', "bash -c 'pgrep -f owner-id-123'"],
  ])('advises without denying %s', (_label, command) => {
    expectPgrepAdvisory(runGate(bashCmd(command)));
  });

  it.each([
    ['bracketed full-cmdline pattern', "pgrep -f '[o]wner-id-123'"],
    ['name-only lookup', 'pgrep owner-id-123'],
    ['pidfile flag -F', 'pgrep -F /run/worker.pid worker'],
    ['quoted prose', 'echo "pgrep -f owner-id-123 is unsafe"'],
  ])('stays silent for %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command)));
  });
});

describe('owner sessions + fail-open (D-003)', () => {
  it("never fires without the agent marker — the owner's crontab is their business", () => {
    expectAllow(runGate(bashCmd('crontab -l')));
  });

  it('fail-open on malformed JSON', () => {
    expectAllow(runGate('not json {'));
  });

  it('fail-open on a missing command field', () => {
    expectAllow(runGate({ tool_name: 'Bash', tool_input: {} }, AGENT));
  });

  it('no-ops entirely when the su-token install is absent (early exit 0)', () => {
    const bare = mkdtempSync(join(tmpdir(), 'gate-bare-'));
    try {
      const r = spawnSync('bash', [SCRIPT], {
        input: JSON.stringify(bashCmd('crontab -e')),
        encoding: 'utf8',
        env: { NODE_ENV: 'test', PATH: process.env.PATH ?? '', HOME: bare, ...AGENT },
        timeout: 15_000,
      });
      expect(r.status).toBe(0);
      expect((r.stdout ?? '').trim()).toBe('');
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('heavy-command admission control (WI-3821)', () => {
  // Deterministic threshold so the suite never depends on the runner's core
  // count: cap at 100 and inject the "current" load1 via PC_HEAVY_LOAD1_OVERRIDE.
  const OVER = { PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: '200' };
  const UNDER = { PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: '50' };

  // EI-19284963139619048: was a bare `JSON.parse(out.stdout)` — the exact
  // fail-open shape EI-18829641916212203 already made self-diagnosing via
  // `parseDecision` for expectDeny/expectGitDeny, but this helper (and its
  // WI-3853-describe sibling below) were never migrated, so a transient
  // fail-open here still surfaced as a bare `SyntaxError: Unexpected end of
  // JSON input` — indistinguishable from a real admission-gate regression.
  const expectHeavyDeny = (out: { stdout: string; stderr?: string; status: number | null }) => {
    expect(out.status).toBe(0); // deny is exit 0 + decision JSON (hook protocol)
    const decision = parseDecision(out);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('heavy-command admission');
  };

  /**
   * EI-19419178369405401 — a sanctioned root entrypoint must be exempt at EVERY
   * command position, not only as the first word.
   *
   * The (a2) skip-check was `re.match` (start-anchored) while heavy-detection is
   * anchored at every command position, so `npm run test:file` passed alone and
   * was DENIED after any separator. That denied the blessed, already
   * self-throttling entrypoint under exactly the load it exists to queue for,
   * and the deny text then named that same entrypoint as the remedy.
   *
   * These are written as COMPOUNDS on purpose: the bare forms already passed
   * before the fix, so a bare-command test would go green against the bug.
   */
  it.each([
    ['leading echo', 'echo "=== 1/3 ==="; npm run test:file -- lib/x.test.ts'],
    ['leading export', 'export SUBJECT=/tmp/copy.sh; npm run test:file -- lib/x.test.ts'],
    ['leading builtin', 'true; npm run test:file -- lib/x.test.ts'],
    ['newline + timeout', 'echo hi\ntimeout 400 npm run test:file -- lib/x.test.ts'],
    ['test:affected', 'echo hi; npm run test:affected'],
    ['test:all:integration', 'echo hi; npm run test:all:integration'],
    ['lint:tsc', 'echo hi; npm run lint:tsc'],
  ])('allows a sanctioned root entrypoint mid-command (%s), over threshold', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  /**
   * The exemption must NOT grant amnesty to the rest of the command line.
   * Before this fix (a2) was an unconditional early `return`, so a sanctioned
   * entrypoint at the FRONT waved through everything after it — measured
   * 2026-08-03: `npm run test:file && npx vitest` was ALLOWED at any load.
   * Expressing the exemption as a negative lookahead inside heavy-detection
   * (rather than an early return) is what closes this.
   */
  it.each([
    ['sanctioned then raw vitest', 'npm run test:file -- x.test.ts && npx vitest run y.test.ts'],
    ['sanctioned then npm run build', 'npm run test:file -- x.test.ts; npm run build'],
    ['sanctioned then bare tsc', 'npm run test:affected && npx tsc --noEmit'],
  ])('still denies a raw heavy command hiding behind a sanctioned one (%s)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  // The narrowness that keeps the fix safe: only the EXACT root script names are
  // exempt. A workspace cwd resolves these to its own raw vitest, not the
  // pc-heavy-wrapped root script, so they must stay gated in every position.
  it.each([
    ['bare npm test after a separator', 'echo hi; npm test'],
    ['npm run test after a separator', 'echo hi; npm run test'],
    ['an unsanctioned test:* script', 'echo hi; npm run test:unit'],
    ['npm run build after a separator', 'echo hi; npm run build'],
  ])('does not over-exempt: %s stays denied', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    ['npm test', 'npm test'],
    ['npm run test', 'npm run test'],
    ['npm run build', 'npm run build'],
    ['bare vitest', 'vitest run lib/x.test.ts'],
    ['npx vitest', 'npx vitest run lib/x.test.ts'],
    ['pnpm vitest', 'pnpm vitest'],
    ['path-invoked vitest (.bin)', '../../node_modules/.bin/vitest run app/x.test.ts'],
    ['compound cd && .bin/vitest', 'cd apps/operator && ../../node_modules/.bin/vitest run x.test.ts'],
    ['tsc --noEmit', 'tsc --noEmit'],
    ['npx tsc -p', 'npx tsc -p tsconfig.json'],
    ['turbo run test', 'turbo run test'],
    ['time-wrapped npm test', 'time npm test'],
    ['nice-wrapped vitest', 'nice -n 10 vitest run x'],
  ])('denies %s when the host is over the load threshold (agent session)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it('advertises an absolute wrapper path usable from a harness cwd (EI-22392503014903966)', () => {
    const reason = denyReason(
      runGate(
        bashCmd('vitest run lib/x.test.ts', {
          cwd: '/home/x/.papercusp/hives/sidestage',
        }),
        { ...AGENT, ...OVER, ...CANON_ENV },
      ),
    );
    expect(reason).toContain(`\`${CANON}/scripts/pc-heavy.sh -- <your command>\``);
    expect(reason).not.toContain('`scripts/pc-heavy.sh -- <your command>`');
  });

  it.each([
    ['npm run test:affected', 'npm run test:affected'],
    ['path-invoked vitest', '../../node_modules/.bin/vitest run app/x.test.ts'],
  ])('allows %s when the host is UNDER the load threshold', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...UNDER }));
  });

  it.each([
    ['bare tsc', 'tsc --noEmit'],
    ['npx tsc', 'npx tsc -p packages/operator-core/tsconfig.json'],
    ['path-invoked tsc', 'node_modules/.bin/tsc -p packages/operator-core/tsconfig.json'],
    ['pinned native tsc', 'node_modules/@typescript/typescript-linux-x64/lib/tsc -p packages/operator-core/tsconfig.json'],
    ['compound', 'echo ready && npx tsc --noEmit'],
  ])('denies raw compiler %s even UNDER the load threshold (WI-10003344)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...UNDER }));
  });

  it('allows a raw compiler when it is explicitly wrapped by pc-heavy at low load', () => {
    expectAllow(runGate(bashCmd('scripts/pc-heavy.sh -- npx tsc -p packages/operator-core/tsconfig.json'), { ...AGENT, ...UNDER }));
  });

  // The ROOT entrypoints wrapped in scripts/pc-heavy.sh inside package.json are
  // SELF-THROTTLING — denying them over-threshold would re-open the EI-10001
  // "the remedy doesn't work" trap (EI-19296434833105508). Bare `npm test` /
  // `npm run test` stay denied above: a workspace cwd resolves those to its own
  // raw vitest, not the wrapper.
  it.each([
    ['npm run test:affected', 'npm run test:affected'],
    ['npm run test:affected:integration', 'npm run test:affected:integration'],
    ['npm run test:all', 'npm run test:all'],
    ['npm run test:file', 'npm run test:file -- lib/x.test.ts'],
    ['npm run lint:tsc', 'npm run lint:tsc'],
    ['npm run typecheck', 'npm run typecheck'],
    ['cd-prefixed test:file', 'cd /some/dir && npm run test:file -- lib/x.test.ts'],
    ['timeout-wrapped test:affected (the peel must reach the allow-list)', 'timeout 90 npm run test:affected'],
  ])('allows the self-throttled root entrypoint %s even OVER the threshold', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    ['ordinary ls', 'ls -la'],
    ['git status', 'git status'],
    ['reading a vitest config file', 'cat vitest.config.ts'],
    ['grep for vitest in a file', 'grep vitest package.json'],
    ['vitest named only in a prose arg', 'echo "run vitest later"'],
    ['a docs path containing vitest', 'ls docs/vitest-guide'],
    ['bare tsx runs a light script (NOT heavy)', 'tsx scripts/one-shot.ts'],
    ['npm run lint (not a heavy pattern)', 'npm run lint'],
  ])('does NOT false-positive on %s even over the threshold', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  /**
   * EI-19320012246476716 — command-position matching must not treat literal
   * newlines inside data as shell separators. The same matcher still denies a
   * bare `npx vitest` control above, while these commands merely print/store
   * text that names a heavy command.
   */
  it.each([
    [
      'a read-only heredoc body',
      "cat <<'EOF'\nline one\nnpx vitest run x.test.ts\nEOF",
    ],
    [
      'a multiline quoted argument',
      'echo "line one\nnpx vitest run x.test.ts"',
    ],
  ])('does NOT false-positive on %s even over the threshold (EI-19320012246476716)', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it('is skipped when PC_HEAVY_BYPASS=1 (the pc-heavy wrapper self-limits)', () => {
    expectAllow(runGate(bashCmd('npm run test:affected'), { ...AGENT, ...OVER, PC_HEAVY_BYPASS: '1' }));
  });

  // ── EI-9634: the two remedies the deny message itself recommends must WORK ──
  // The hook decides BEFORE the wrapped command runs, so a child-shell env
  // (`PC_HEAVY_BYPASS=1 …`) and the wrapper's own PC_HEAVY_BYPASS export aren't
  // in THIS process's env yet — so both documented escape hatches were denied
  // under the exact high load they exist for. The gate now reads them in-band
  // from the command text (no PC_HEAVY_BYPASS in the hook's own env here).
  it.each([
    ['scripts/pc-heavy.sh -- <heavy> (the primary suggested remedy)', 'scripts/pc-heavy.sh -- node_modules/.bin/vitest run lib/x.test.ts'],
    ['./scripts/pc-heavy.sh wrapping npm test', './scripts/pc-heavy.sh npm run test:affected'],
    ['bare pc-heavy.sh invocation', 'pc-heavy.sh -- vitest run x.test.ts'],
    ['pc-heavy.sh behind bash', 'bash scripts/pc-heavy.sh -- vitest run x.test.ts'],
    ['env-prefixed inline PC_HEAVY_BYPASS=1', 'env PC_HEAVY_BYPASS=1 vitest run lib/x.test.ts'],
    ['bare inline PC_HEAVY_BYPASS=1 prefix', 'PC_HEAVY_BYPASS=1 npm run test:affected'],
    ['PC_HEAVY_BYPASS=1 among other assignments', 'FOO=bar PC_HEAVY_BYPASS=1 vitest run x.test.ts'],
    // EI-10001: the deny message's own suggested remedy ("run it under
    // `scripts/pc-heavy.sh -- <your command>`") must actually work in the
    // everyday forms an agent naturally reaches for, not just the bare form.
    ['cd <dir> && scripts/pc-heavy.sh -- <heavy> (EI-10001)', 'cd packages/operator-core && scripts/pc-heavy.sh -- npx tsc --noEmit -p .'],
    ['cd "<quoted dir>" && scripts/pc-heavy.sh -- <heavy> (EI-10001)', 'cd "packages/operator-core" && scripts/pc-heavy.sh -- npx tsc --noEmit -p .'],
    ['cd <dir>; scripts/pc-heavy.sh -- <heavy> (EI-10001, semicolon separator)', 'cd packages/operator-core; scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['(scripts/pc-heavy.sh -- <heavy>) & subshell wrapper (EI-10001)', '(scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts) &'],
    ['cd <dir> && (scripts/pc-heavy.sh -- <heavy>) & both wrappers stacked (EI-10001)', 'cd packages/operator-core && (scripts/pc-heavy.sh -- npx tsc --noEmit) &'],
    ['timeout <seconds> && scripts/pc-heavy.sh -- <heavy> (EI-10439)', 'timeout 90 scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['timeout with long option && scripts/pc-heavy.sh -- <heavy> (EI-10439)', 'timeout --preserve-status 90 ./scripts/pc-heavy.sh -- npm run test:affected'],
    // WI-4547 follow-on: `set -o pipefail` was NOT in the peel set, so the whole
    // remedy collapsed the moment an agent used it — `cd d && set -o pipefail &&
    // scripts/pc-heavy.sh -- vitest` stopped peeling at `set`, never saw the
    // pc-heavy lead, and got denied as a raw vitest with a message telling it to
    // do the thing it had just done. It punished exactly the right habit, too:
    // pipefail is what stops `… | tail` from masking a real exit code (which is how
    // a failing migration run reported "exit 0" earlier the same day). `set` only
    // flips shell options — it runs no command — so peeling it is safe.
    ['set -o pipefail && scripts/pc-heavy.sh -- <heavy>', 'set -o pipefail && scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['cd <dir> && set -o pipefail && scripts/pc-heavy.sh -- <heavy> (the real-world form)', 'cd packages/operator-core && set -o pipefail && scripts/pc-heavy.sh -- npx vitest run lib/x.test.ts'],
    ['set -euo pipefail; scripts/pc-heavy.sh -- <heavy> (semicolon + combined flags)', 'set -euo pipefail; scripts/pc-heavy.sh -- npm run test:affected'],
    ['set -e && set -o pipefail && scripts/pc-heavy.sh -- <heavy> (stacked sets)', 'set -e && set -o pipefail && scripts/pc-heavy.sh -- npx tsc --noEmit'],
  ])('allows the in-band bypass %s even over the threshold (EI-9634)', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    // The in-band bypass must not become a free pass: a raw heavy leading a
    // chain is still gated even if a later segment wraps with pc-heavy.sh —
    // EI-10001's peel loop only strips genuinely benign wrappers (cd/(/sudo/
    // env/nice/ionice/rtk/time) that run no command of their own, so it stops
    // the instant it hits a REAL command and never reaches pc-heavy.sh.
    ['a raw heavy leading a pc-heavy chain', 'vitest run a.test.ts && scripts/pc-heavy.sh -- vitest run b.test.ts'],
    ['a raw heavy leading a pc-heavy chain, behind a cd (EI-10001 guard)', 'cd packages/operator-core && npm test && scripts/pc-heavy.sh -- vitest run b.test.ts'],
    ['timeout-wrapped raw heavy remains gated (EI-10439 guard)', 'timeout 90 vitest run x.test.ts'],
    ['PC_HEAVY_BYPASS with the wrong value does not bypass', 'env PC_HEAVY_BYPASS=0 vitest run x.test.ts'],
    // The `set` peel must not become a free pass either: it strips the option-setting
    // builtin, then stops dead at the first REAL command.
    ['set -o pipefail && <raw heavy> stays gated', 'set -o pipefail && vitest run x.test.ts'],
    ['set -o pipefail && a raw heavy leading a pc-heavy chain stays gated', 'set -o pipefail && npm test && scripts/pc-heavy.sh -- vitest run b.test.ts'],
  ])('does NOT over-bypass %s (EI-9634 guard)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it('is disabled by the PC_HEAVY_ADMISSION=off kill-switch', () => {
    expectAllow(runGate(bashCmd('npm run test:affected'), { ...AGENT, ...OVER, PC_HEAVY_ADMISSION: 'off' }));
  });

  // ── EI-10913: the documented kill-switch must WORK as an INLINE prefix ──
  // The deny message advertises `PC_HEAVY_ADMISSION=off` as the kill-switch, but
  // the gate only read it from THIS hook process's env — and an agent cannot set
  // that from a Bash call (the assignment applies to the child, not to the hook).
  // So the guard's own documented escape hatch was itself denied under the exact
  // high load it exists for. The gate now reads a leading `PC_HEAVY_ADMISSION=off`
  // prefix in-band from the command text, exactly parallel to the PC_HEAVY_BYPASS=1
  // in-band remedy (EI-9634). Recurrence guards — these fail against the pre-fix hook.
  it.each([
    ['bare PC_HEAVY_ADMISSION=off prefix', 'PC_HEAVY_ADMISSION=off npm run test:affected'],
    ['inline off in front of a bare vitest', 'PC_HEAVY_ADMISSION=off vitest run lib/x.test.ts'],
    ['env-prefixed inline off', 'env PC_HEAVY_ADMISSION=off npm run test:affected'],
    // The EXACT repro from the item body: the message told the agent to run it
    // under pc-heavy.sh AND named PC_HEAVY_ADMISSION=off, and both were rejected.
    ['PC_HEAVY_ADMISSION=off scripts/pc-heavy.sh -- <heavy> (the item repro)', 'PC_HEAVY_ADMISSION=off scripts/pc-heavy.sh -- node_modules/.bin/vitest run lib/x.test.ts'],
    ['cd <dir> && PC_HEAVY_ADMISSION=off <heavy>', 'cd packages/operator-core && PC_HEAVY_ADMISSION=off npx tsc --noEmit -p .'],
    ['PC_HEAVY_ADMISSION=off among other assignments', 'FOO=bar PC_HEAVY_ADMISSION=off vitest run x.test.ts'],
    // The env read lower-cases and accepts off/0/false/no — the inline form must
    // accept the same value set (value case-insensitive, var name literal).
    ['uppercase value PC_HEAVY_ADMISSION=OFF', 'PC_HEAVY_ADMISSION=OFF vitest run x.test.ts'],
    ['numeric off PC_HEAVY_ADMISSION=0', 'PC_HEAVY_ADMISSION=0 npm test'],
    ['PC_HEAVY_ADMISSION=false', 'PC_HEAVY_ADMISSION=false vitest run x.test.ts'],
    ['PC_HEAVY_ADMISSION=no', 'PC_HEAVY_ADMISSION=no npm run build'],
  ])('allows the inline kill-switch %s even over the threshold (EI-10913)', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    // Not a free pass: `=on` is NOT an off-value, so my value alternation must
    // reject it and leave the command gated.
    //
    // These used to be pinned to the `env`-prefixed spelling with the note that
    // "a BARE `KEY=val vitest` prefix was never recognized as heavy by the
    // detector's anchor to begin with — that gap predates this fix". That gap
    // was real, and it was a GATE BYPASS, not a quirk: it is closed by
    // EI-19317242751258158, so the bare forms below now discriminate too.
    // Both spellings are kept — the pair is what proves the fix did not simply
    // move the gap from one to the other.
    ['env PC_HEAVY_ADMISSION=on does not bypass', 'env PC_HEAVY_ADMISSION=on vitest run x.test.ts'],
    ['env PC_HEAVY_ADMISSION=onward (not an off-value) does not bypass', 'env PC_HEAVY_ADMISSION=onward vitest run x.test.ts'],
    ['bare PC_HEAVY_ADMISSION=on does not bypass (EI-19317242751258158)', 'PC_HEAVY_ADMISSION=on vitest run x.test.ts'],
    ['bare PC_HEAVY_ADMISSION=onward does not bypass (EI-19317242751258158)', 'PC_HEAVY_ADMISSION=onward vitest run x.test.ts'],
    // The prefix must be at command position — hidden after a real heavy op it
    // does not un-gate the leading heavy command.
    ['inline off after a raw heavy stays gated', 'vitest run a.test.ts && PC_HEAVY_ADMISSION=off vitest run b.test.ts'],
  ])('does NOT over-bypass %s (EI-10913 guard)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  /**
   * EI-19317242751258158 — "benign leading wrapper" was defined TWICE in the
   * hook (the peel loop, and the heavy-detection anchor) and the two copies had
   * DIVERGED. The peel knew `timeout`; the anchor did not. NEITHER knew a bare
   * `VAR=val` assignment prefix — only the `env VAR=val` spelling.
   *
   * That single divergence failed in two OPPOSITE directions at once, which is
   * why it survived three previous fixes to this area (EI-9634, EI-10001,
   * WI-4547): each added the missing wrapper to ONE of the two lists.
   *
   *   • BYPASS   — a two-token prefix in front of a heavy command escaped
   *     admission ENTIRELY. This is the failure that matters: the gate exists
   *     to stop a vitest/tsc herd melting the box, and `FOO=1 npx vitest` was
   *     never even evaluated.
   *   • FRICTION — the mirror image: `PC_HEAVY_COALESCE=0 scripts/pc-heavy.sh
   *     -- node_modules/.bin/vitest` was DENIED with a message telling the
   *     caller to run it under scripts/pc-heavy.sh, which is what it was doing.
   *
   * Both directions are pinned below, plus the false-positive corner: the
   * assignment prefix is general enough (`\w+=`) to match ordinary prose, so it
   * counts only at a real command position. `echo "PC_HEAVY=1 vitest is the
   * way"` denied during development of this fix — it must not.
   */
  it.each([
    ['bare VAR= in front of a heavy', 'PC_HEAVY_COALESCE=0 npx vitest run x.test.ts'],
    ['bare VAR= in front of tsc', 'FOO=1 npx tsc --noEmit'],
    ['several bare assignments in front of a heavy', 'FOO=1 BAR=2 npx vitest run x.test.ts'],
    ['bare VAR= in front of npm test', 'FOO=1 npm test'],
    // Mid-chain: the peel only strips from the FRONT, so a non-peelable first
    // segment used to hide the wrapper from the anchor entirely.
    ['mid-chain timeout-wrapped heavy', 'echo hi && timeout 60 npx vitest run x.test.ts'],
    ['mid-chain bare VAR= heavy', 'echo hi && FOO=1 npx vitest run x.test.ts'],
    ['mid-chain stacked nice+timeout heavy', 'echo hi && nice -n 10 timeout 60 npx vitest run x.test.ts'],
    ['mid-chain assignment after a semicolon', 'echo hi; PC_HEAVY_COALESCE=0 npx tsc --noEmit'],
  ])('closes the wrapper-divergence BYPASS: denies %s (EI-19317242751258158)', (_label, command) => {
    expectHeavyDeny(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    // The exact filed repro. A path-invoked heavy is what makes it visible: the
    // `\S*/` anchor fires on `node_modules/.bin/`, so the command reached the
    // deny while the identical command WITHOUT the assignment prefix was
    // admitted — i.e. adding an env var to the blessed remedy broke it.
    ['VAR= scripts/pc-heavy.sh -- <path heavy> (the filed repro)', 'PC_HEAVY_COALESCE=0 scripts/pc-heavy.sh -- node_modules/.bin/vitest run x.test.ts'],
    ['several assignments then pc-heavy', 'FOO=1 BAR=2 scripts/pc-heavy.sh -- node_modules/.bin/vitest run x.test.ts'],
    ['cd <dir> && VAR= scripts/pc-heavy.sh -- <path heavy>', 'cd packages/operator-core && PC_HEAVY_COALESCE=0 scripts/pc-heavy.sh -- node_modules/.bin/vitest run x.test.ts'],
    ['VAR= in front of a self-throttled root entrypoint', 'FOO=1 npm run test:affected'],
  ])('closes the wrapper-divergence FRICTION: allows %s (EI-19317242751258158)', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  it.each([
    // The bare-assignment arm is far more general than the named wrappers
    // (`sudo`, `nice`, …), so it is honoured ONLY at a real command position.
    // Free-floating mid-string it would deny ordinary prose that merely NAMES a
    // heavy command — each of these denied while developing the fix.
    ['a heavy named in a quoted grep pattern', "grep 'FOO=1 vitest' package.json"],
    ['a heavy named in prose after an assignment-looking token', 'echo "PC_HEAVY=1 vitest is the way"'],
    ['an assignment-looking token in a commit message', 'git commit -m "set FOO=1 before vitest runs"'],
  ])('does NOT false-positive on %s (EI-19317242751258158 FP guard)', (_label, command) => {
    expectAllow(runGate(bashCmd(command), { ...AGENT, ...OVER }));
  });

  // These scoping tests probe with a RAW heavy (vitest) — `npm run test:affected`
  // is allow-listed as self-throttling (EI-19296434833105508), so it can no longer
  // discriminate whether the marker/tree scoping fired.
  it('never throttles the owner (no agent marker, outside the canonical tree)', () => {
    expectAllow(runGate(bashCmd('vitest run x.test.ts', { cwd: '/tmp/not-canonical' }), { ...CANON_ENV, ...OVER }));
  });

  it('fires WITHOUT the agent marker inside the canonical tree (EI-7872 tree-keyed parity)', () => {
    expectHeavyDeny(runGate(bashCmd('vitest run x.test.ts', { cwd: CANON }), { ...CANON_ENV, ...OVER }));
  });

  it('honors the codex shell tool name (exec_command) — same wire contract', () => {
    expectHeavyDeny(runGate(bashCmd('vitest run x.test.ts', { tool: 'exec_command' }), { ...AGENT, ...OVER }));
  });

  it('fails open (allows) when load cannot be read', () => {
    // A non-numeric override forces the load-read to throw → fail-open allow.
    expectAllow(runGate(bashCmd('npm run test:affected'), { ...AGENT, PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: 'not-a-number' }));
  });

  /**
   * EI-19300297240416558 — every ADVERTISED remedy must survive every command
   * SEPARATOR, not just the one whoever last touched the peel happened to test.
   *
   * This gate has now denied its own prescribed escape FOUR times: EI-9634 (cd /
   * subshell), the `set -o pipefail` peel, EI-10913 (`PC_HEAVY_ADMISSION=off`),
   * and this one. Every fix taught the peel ONE more prefix shape, so the next
   * shape silently re-opened the hole. Here the peel accepted `cd <dir> &&` and
   * `cd <dir>;` but NOT `cd <dir>` + NEWLINE — while heavy-DETECTION was
   * newline-anchored the whole time. That asymmetry (detection knows a newline
   * starts a command, the allowance does not) denied the blessed
   * `npm run test:file` under exactly the load the wrapper exists to queue for,
   * and the message blamed load, so the natural next move was to re-run it and
   * be denied again — or reach for the kill-switch, which was broken the same way.
   *
   * Note the suite already tests newline-separated forms for the crontab,
   * git-stash, systemctl and pkill guards; the admission gate's REMEDY path was
   * simply never given that treatment.
   *
   * The cross-product is the point: adding a remedy or a separator forces a
   * decision here instead of leaving a silent gap.
   */
  describe('advertised remedies survive EVERY separator (EI-19300297240416558)', () => {
    const REMEDIES: [string, string][] = [
      ['self-throttling npm entrypoint', 'npm run test:file -- lib/x.test.ts'],
      ['pc-heavy.sh wrapper', 'bash scripts/pc-heavy.sh -- vitest run lib/x.test.ts'],
      ['PC_HEAVY_BYPASS=1 prefix', 'PC_HEAVY_BYPASS=1 vitest run lib/x.test.ts'],
      ['PC_HEAVY_ADMISSION=off kill-switch', 'PC_HEAVY_ADMISSION=off vitest run lib/x.test.ts'],
    ];
    // The separator between `cd <dir>` and the remedy. '\n' is the regression.
    const SEPARATORS: [string, string][] = [
      ['&&', ' && '],
      [';', ' ; '],
      ['a newline', '\n'],
    ];

    for (const [remedyLabel, remedy] of REMEDIES) {
      for (const [sepLabel, sep] of SEPARATORS) {
        it(`allows ${remedyLabel} after \`cd <dir>\` joined by ${sepLabel}`, () => {
          expectAllow(runGate(bashCmd(`cd ${CANON}${sep}${remedy}`, { cwd: CANON }), { ...AGENT, ...OVER }));
        });
      }
    }

    // The other half of the contract. Widening the peel must NOT let a raw heavy
    // command through in the same shape — otherwise the matrix above could be
    // "satisfied" by quietly disabling the gate, which is the failure mode a
    // permissive fix to a guard always risks.
    it.each([
      ['raw vitest', 'vitest run lib/x.test.ts'],
      ['raw npx tsc', 'npx tsc --noEmit -p tsconfig.json'],
      ['bare `npm test` (a workspace cwd resolves its own vitest, not the wrapper)', 'npm test'],
    ])('still DENIES %s after `cd <dir>` + a newline', (_label, command) => {
      expectHeavyDeny(runGate(bashCmd(`cd ${CANON}\n${command}`, { cwd: CANON }), { ...AGENT, ...OVER }));
    });
  });

  /**
   * EI-18139694363457325 — heavy detection must anchor at EVERY shell command
   * position, not only after an operator.
   *
   * The item was filed on the assumption that the PEEL's open wrapper set would
   * recurr a 5th time and deny the advertised remedy. Measured across 14 shell
   * shapes (11 the peel has never known), the remedy was allowed in ALL of
   * them — the peel gap and the anchor gap mostly cancel, because a remedy's
   * heavy token sits behind `pc-heavy.sh --` and so reaches no anchor either.
   *
   * The live defect was the COMPLEMENT, in the safety direction: the anchor
   * treated only `[;&|\n]` as a command position, so a heavy command placed
   * after a reserved word reached no anchor and was ADMITTED outright —
   * `for f in a; do vitest; done` is N unthrottled heavy runs, while the
   * identical bare `vitest` denies.
   *
   * These are written as a MATRIX on purpose. The wrapper set is open and must
   * never be "fixed" by enumeration, but shell command positions are a CLOSED
   * set fixed by the grammar — so the invariant is assertable directly, and a
   * 5th recurrence surfaces here as a red test rather than as silent agent
   * friction or a silently ungated build.
   */
  describe('heavy detection anchors at every shell command position (EI-18139694363457325)', () => {
    const HEAVY = 'vitest run lib/x.test.ts';
    const REMEDY = `scripts/pc-heavy.sh -- ${HEAVY}`;

    // Each shape places a command after a reserved word or a group-open rather
    // than after a plain operator. Every one was measured ADMITTED before the fix.
    const POSITIONS: [string, (cmd: string) => string][] = [
      ['`if …; then`', (c) => `if true; then ${c}; fi`],
      ['`for …; do`', (c) => `for f in a; do ${c}; done`],
      ['`while …; do`', (c) => `while read y; do ${c}; done`],
      ['`… else`', (c) => `if false; then :; else ${c}; fi`],
      ['a brace group', (c) => `{ ${c}; }`],
    ];

    for (const [label, wrap] of POSITIONS) {
      it(`DENIES a raw heavy command after ${label}`, () => {
        expectHeavyDeny(runGate(bashCmd(wrap(HEAVY), { cwd: CANON }), { ...AGENT, ...OVER }));
      });

      // The other half of the contract, mirroring the sibling describe above:
      // closing an anchor gap must not start denying the advertised remedy.
      it(`still allows the pc-heavy remedy after ${label}`, () => {
        expectAllow(runGate(bashCmd(wrap(REMEDY), { cwd: CANON }), { ...AGENT, ...OVER }));
      });
    }

    // The reserved word is only a command position at a REAL command position.
    // Without this, widening the anchor would deny ordinary prose that merely
    // contains the word — the over-block a permissive-looking fix always risks.
    it('does not treat a reserved word inside prose as a command position', () => {
      expectAllow(
        runGate(bashCmd(`echo "then vitest is the next step"`, { cwd: CANON }), { ...AGENT, ...OVER }),
      );
    });
  });
});

describe('compound `cd <canonical> && …` coverage (WI-3853 — marker-less fleet sessions)', () => {
  // The OUTER cwd is outside the canonical tree; the command cds INTO it. A
  // fleet-launched session carries no PAPERCUSP_AGENT_SESSION marker (EI-7872),
  // so only the tree check can catch these — and it must follow the leading cd.
  const OUTSIDE = '/tmp/outside-canonical';
  const OVER = { PC_HEAVY_MAX_LOAD1: '100', PC_HEAVY_LOAD1_OVERRIDE: '200' };
  // EI-19284963139619048: same fail-open-shape fix as the sibling
  // expectHeavyDeny above — route through parseDecision so a transient
  // fail-open self-diagnoses instead of a bare JSON.parse SyntaxError.
  const expectHeavyDeny = (out: { stdout: string; stderr?: string; status: number | null }) => {
    expect(out.status).toBe(0); // deny is exit 0 + decision JSON (hook protocol)
    expect(parseDecision(out).hookSpecificOutput.permissionDecisionReason).toContain('heavy-command admission');
  };

  it('git-guard fires on `cd <canonical> && git reset --hard` from a marker-less session', () => {
    expectGitDeny(runGate(bashCmd(`cd ${CANON} && git reset --hard`, { cwd: OUTSIDE }), CANON_ENV));
  });

  it('git-guard resolves a simply-quoted cd target', () => {
    expectGitDeny(runGate(bashCmd(`cd "${CANON}" && git clean -fd`, { cwd: OUTSIDE }), CANON_ENV));
  });

  it('git-guard does NOT fire when the cd targets a DIFFERENT tree (no false positive)', () => {
    expectAllow(runGate(bashCmd('cd /some/other/repo && git reset --hard', { cwd: OUTSIDE }), CANON_ENV));
  });

  // Raw-vitest probes here for the same reason as the scoping tests above:
  // `npm run test:affected` is allow-listed as self-throttling, so only a raw
  // heavy can show whether the tree check followed the leading cd.
  it('admission gate denies `cd <canonical> && <raw heavy>` (marker-less, over threshold)', () => {
    expectHeavyDeny(runGate(bashCmd(`cd ${CANON} && vitest run x.test.ts`, { cwd: OUTSIDE }), { ...CANON_ENV, ...OVER }));
  });

  it('admission gate does NOT gate a heavy command that cds into a DIFFERENT tree', () => {
    expectAllow(runGate(bashCmd('cd /some/other/repo && vitest run x.test.ts', { cwd: OUTSIDE }), { ...CANON_ENV, ...OVER }));
  });

  it('a bare `cd` with no path does not throw / falls through to allow', () => {
    expectAllow(runGate(bashCmd('cd && vitest run x.test.ts', { cwd: OUTSIDE }), { ...CANON_ENV, ...OVER }));
  });
});

describe('long-foreground-exec advisory (coord-delivery-residual-gaps P-003)', () => {
  // Claude-Bash-only soft nudge: explicit foreground timeout > 120s → allow
  // WITH additionalContext advising run_in_background (same-session detach).
  // Never a deny; never fired for backends without the native primitive.
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('run_in_background');
    expect(hso.additionalContext).toContain('THIS session');
  };

  it('fires on Claude Bash with an explicit foreground timeout > 120s', () => {
    expectAdvisory(runGate(bashWithInput({ command: 'npm ci', timeout: 300_000 })));
  });

  it('names the requested duration in seconds', () => {
    const out = runGate(bashWithInput({ command: 'sleep 400', timeout: 400_000 }));
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain('400s');
  });

  it('silent when the call is already backgrounded', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 300_000, run_in_background: true })));
  });

  it('silent at/under the 120s default (no explicit long-hold intent)', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 120_000 })));
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 5_000 })));
  });

  it('silent when no timeout is requested at all', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci' })));
  });

  it('does NOT nudge codex shells — no native background primitive there', () => {
    for (const tool of ['exec_command', 'local_shell', 'shell']) {
      expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 300_000 }, tool)));
    }
  });

  it('a deny gate still WINS over the advisory (advisory never masks a block)', () => {
    const out = runGate(
      { tool_name: 'Bash', tool_input: { command: 'crontab -e', timeout: 300_000 }, session_id: 's-test' },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('a non-numeric timeout never fires or throws', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm ci', timeout: 'lots' })));
  });
});

describe('foreground shell-backgrounding advisory (EI-20202551640426512)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-shell-backgrounding',
  });

  const expectShellBackgroundingAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('foreground shell-backgrounding advisory');
    expect(hso.additionalContext).toContain('capability:bash_output');
    expect(hso.additionalContext).toContain('120s');
  };

  it('fires for the live nohup + trailing-& failure shape', () => {
    expectShellBackgroundingAdvisory(
      runGate(
        bashWithInput({
          command: 'nohup npm run lint:tsc > /tmp/tsc.log 2>&1 &',
        }),
      ),
    );
  });

  it('fires for a plain shell background operator without nohup', () => {
    expectShellBackgroundingAdvisory(
      runGate(bashWithInput({ command: 'npm run test:affected > /tmp/test.log 2>&1 &' })),
    );
  });

  it('uses an explicitly requested timeout when naming the wrapper deadline', () => {
    const out = runGate(
      bashWithInput({ command: 'nohup npm run build &', timeout: 300_000 }),
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain('300s');
  });

  // EI-20349478936631977 — the orphan-lifetime clause. The deadline text warns the
  // child may die too EARLY (with the wrapper); a true detach wrapper carries the
  // opposite hazard, that it dies too LATE — never, because the terminal scope is
  // KillMode=process. Both can be true of one command, so the clause is additive.
  const orphanClause = (out: { stdout: string }) =>
    JSON.parse(out.stdout).hookSpecificOutput.additionalContext as string;

  it('names the KillMode=process orphan hazard for a true detach wrapper', () => {
    const ctx = orphanClause(runGate(bashWithInput({ command: 'nohup node server.mjs &' })));
    expect(ctx).toContain('KillMode=process');
    expect(ctx).toContain('systemd-run --user --scope');
    // The deadline-bearing alternative must still be named, not replaced.
    expect(ctx).toContain('run_in_background: true');
  });

  it('names it for setsid without a background operator', () => {
    expect(orphanClause(runGate(bashWithInput({ command: 'setsid node server.mjs' })))).toContain(
      'KillMode=process',
    );
  });

  // NARROWNESS is the property that keeps this affordable: a bare `&` is the
  // common, usually-harmless case and must not pay the extra text on every call.
  it('does NOT add the orphan clause for a bare shell background operator', () => {
    const ctx = orphanClause(
      runGate(bashWithInput({ command: 'npm run test:affected > /tmp/t.log 2>&1 &' })),
    );
    expect(ctx).toContain('foreground shell-backgrounding advisory'); // base advisory intact
    expect(ctx).not.toContain('KillMode=process');
  });

  // THIS advisory stands down when the native background mode is used — that is
  // its own premise and still holds. But the command below is not therefore
  // benign: `run_in_background: true` PLUS `nohup … &` is the double-backgrounding
  // trap (EI-19408257709127659), so the hand-off is to that advisory rather than
  // to silence. This case asserted a bare silence until 2026-09-05, which encoded
  // the hazard as safe.
  it('hands the native same-session background mode to the double-background advisory', () => {
    const out = runGate(
      bashWithInput({ command: 'nohup npm run lint:tsc > /tmp/tsc.log 2>&1 &', run_in_background: true }),
    );
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).not.toContain('foreground shell-backgrounding advisory');
    expect(hso.additionalContext).toContain('double-background advisory');
  });

  it('is silent when the native background mode is used WITHOUT a second fork', () => {
    expectAllow(
      runGate(bashWithInput({ command: 'npm run lint:tsc > /tmp/tsc.log 2>&1', run_in_background: true })),
    );
  });

  it('does not false-positive on quoted ampersands or Bash &> redirection', () => {
    expectAllow(runGate(bashWithInput({ command: "printf '%s\\n' '&'" })));
    expectAllow(runGate(bashWithInput({ command: 'npm run lint:tsc &> /tmp/tsc.log' })));
  });

  it('does NOT nudge codex shells, which have no native background primitive here', () => {
    for (const tool of ['exec_command', 'local_shell', 'shell']) {
      expectAllow(runGate(bashWithInput({ command: 'nohup npm run lint:tsc > /tmp/tsc.log 2>&1 &' }, tool)));
    }
  });

  it('a deny gate still WINS over the advisory', () => {
    const out = runGate(
      { tool_name: 'Bash', tool_input: { command: 'crontab -e; nohup npm run build &' }, session_id: 's-test' },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('background-pipe exit-code trap advisory (EI-8871/EI-14065)', () => {
  // A backgrounded `cmd | tail/head/grep` reports the PIPE's last-stage exit
  // code in the completion notification, not the real command's — soft nudge
  // only, never a deny.
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectPipeAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('background-pipe exit-code advisory');
    expect(hso.additionalContext).toContain('tail/head/grep');
  };

  it('fires on a backgrounded `cmd | tail -N`', () => {
    expectPipeAdvisory(
      runGate(bashWithInput({ command: 'npm run test:affected 2>&1 | tail -100', run_in_background: true })),
    );
  });

  it('fires on a backgrounded `cmd | head`', () => {
    expectPipeAdvisory(runGate(bashWithInput({ command: 'rsync -av a b 2>&1 | head -50', run_in_background: true })));
  });

  it('fires on a backgrounded `cmd | grep`', () => {
    expectPipeAdvisory(runGate(bashWithInput({ command: 'ssh host cmd | grep error', run_in_background: true })));
  });

  it("hands a foreground verification pipe to the foreground exit-code advisory", () => {
    const out = runGate(
      bashWithInput({ command: "npm run test:affected 2>&1 | tail -100" }),
    );
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.additionalContext).toContain(
      "foreground verification-pipe exit-code advisory",
    );
    expect(hso.additionalContext).not.toContain(
      "background-pipe exit-code advisory",
    );
  });

  // EI-18686555459167489: the list was tail/head/grep only, so the most natural
  // idiom for a LONG verification run (tee the output to a log, count the
  // errors, slice it with sed) walked straight through and still produced a
  // false "exit code 0". These are the stages that actually showed up in the
  // incident class, and every one of them exits 0 regardless of upstream.
  it.each([
    ['tee (save the output AND see it — the most likely miss)', 'npx tsc --noEmit 2>&1 | tee /tmp/tsc.log'],
    ['wc (count the errors)', 'npx tsc --noEmit 2>&1 | wc -l'],
    ['sed (slice the output)', "npm run build 2>&1 | sed -n '1,40p'"],
    ['awk', 'npm test 2>&1 | awk "{print $1}"'],
    ['sort', 'npm test 2>&1 | sort'],
    ['uniq', 'npm test 2>&1 | uniq -c'],
    ['cut', 'npm test 2>&1 | cut -d: -f1'],
    ['jq', 'npm test --json 2>&1 | jq .'],
    ['cat', 'npm test 2>&1 | cat'],
  ])('fires on a backgrounded pipe into %s', (_label, command) => {
    expectPipeAdvisory(runGate(bashWithInput({ command, run_in_background: true })));
  });

  it('still fires when the masking stage is reached via a path', () => {
    expectPipeAdvisory(
      runGate(bashWithInput({ command: 'npm test 2>&1 | /usr/bin/tee /tmp/x.log', run_in_background: true })),
    );
  });

  it('still silent when a widened stage is used but the caller handles pipefail', () => {
    expectAllow(
      runGate(
        bashWithInput({
          command: 'set -o pipefail; npx tsc --noEmit 2>&1 | tee /tmp/tsc.log',
          run_in_background: true,
        }),
      ),
    );
  });

  it('does not false-positive on a widened stage name appearing as a plain argument', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm test -- --reporter=tee', run_in_background: true })));
  });

  it('silent for a plain backgrounded command with no pipe', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm run test:affected > /tmp/x.log 2>&1', run_in_background: true })));
  });

  it('does NOT confuse `||` with a real pipe', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm test || echo failed', run_in_background: true })));
  });

  it('silent when the caller already applies `set -o pipefail`', () => {
    expectAllow(
      runGate(
        bashWithInput({
          command: 'set -o pipefail; npm run test:affected 2>&1 | tail -100',
          run_in_background: true,
        }),
      ),
    );
  });

  it('silent when the caller already captures PIPESTATUS', () => {
    expectAllow(
      runGate(
        bashWithInput({
          command: 'npm test 2>&1 | tail -20; echo "EXIT=${PIPESTATUS[0]}"',
          run_in_background: true,
        }),
      ),
    );
  });

  it('does not false-positive on a pipe-to-tail token INSIDE quotes', () => {
    expectAllow(
      runGate(
        bashWithInput({ command: 'grep -E "a|tail" some-file.ts', run_in_background: true }),
      ),
    );
  });

  it('does NOT nudge codex shells — no native background primitive there', () => {
    for (const tool of ['exec_command', 'local_shell', 'shell']) {
      expectAllow(runGate(bashWithInput({ command: 'npm test 2>&1 | tail -20', run_in_background: true }, tool)));
    }
  });

  it('a deny gate still WINS over the pipe advisory', () => {
    const out = runGate(
      { tool_name: 'Bash', tool_input: { command: 'crontab -e | tail', run_in_background: true }, session_id: 's-test' },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * ripgrep `-r`-consumes-cluster advisory (EI-19962592202828420). `rg`'s `-r`
 * is `--replace <REPLACEMENT>` and takes an argument, so a clustered short
 * flag like `-rn` parses as `-r n` — a silent, markerless rewrite of every
 * match to the literal replacement text "n". SOFT by design: this only ever
 * advises, never denies.
 */
describe('ripgrep `-r`-consumes-cluster advisory (EI-19962592202828420)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectRgAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain("rg `-r`-consumes-cluster advisory");
  };

  it.each([
    ['-rn (the reported repro — line numbers eaten as the replacement)', "rg -rn 'SearchLegStats' -g '*.ts'"],
    ['-rl (files-with-matches eaten)', "rg -rl 'TODO'"],
    ['-ri (case-insensitive eaten)', "rg -ri 'todo'"],
  ])('fires on %s', (_label, command) => {
    expectRgAdvisory(runGate(bashWithInput({ command })));
  });

  it('fires when reached via a leading path', () => {
    expectRgAdvisory(runGate(bashWithInput({ command: "/usr/bin/rg -rn 'foo'" })));
  });

  it('fires after a `&&` chain', () => {
    expectRgAdvisory(runGate(bashWithInput({ command: "cd apps/operator && rg -rn 'foo'" })));
  });

  it('silent for the correct grep-style form (`-n` alone, no `-r`)', () => {
    expectAllow(runGate(bashWithInput({ command: "rg -n 'SearchLegStats' -g '*.ts'" })));
  });

  it('silent for GNU `grep -rn` — grep`s `-r` is boolean recursive, a different flag entirely', () => {
    expectAllow(runGate(bashWithInput({ command: "grep -rn 'foo' ." })));
  });

  it('silent for an explicit `--replace` (long form, unambiguous)', () => {
    expectAllow(runGate(bashWithInput({ command: "rg --replace n 'foo'" })));
  });

  it('silent for `-r` as a separate, unclustered argument', () => {
    expectAllow(runGate(bashWithInput({ command: "rg -r n 'foo'" })));
  });

  it('silent when `-rn` only appears as prose inside quotes, not at command position', () => {
    expectAllow(runGate(bashWithInput({ command: 'echo "remember: rg -rn is a trap"' })));
  });

  it('a deny gate still WINS over the rg advisory', () => {
    const out = runGate(bashWithInput({ command: "crontab -e; rg -rn 'foo'" }), AGENT);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * false-absence search-path guard (EI-20580705812821502).
 *
 * `grep -rn X some/wrong/path/` prints NOTHING — visually identical to a
 * search that ran correctly and found no matches. The natural reading is "X
 * does not exist", and that confident negative gets written somewhere durable
 * where the next reader inherits it as fact. Measured twice in this repo: a
 * plan sat blocked THREE WEEKS on such a premise, and the agent verifying it
 * hit the identical trap the same day (`work-items/` typed for the real
 * `work_items/`).
 *
 * The guard denies rather than advises because its verdict is a stat of a
 * LITERAL path, not a heuristic. That only holds while every non-literal
 * construct FAILS OPEN, so the allow cases below are the load-bearing half of
 * this suite — each one names a construct whose operand the guard must refuse
 * to judge. Deleting one does not weaken a warning; it converts the guard into
 * a false-deny on an everyday command.
 */
describe('false-absence search-path guard (EI-20580705812821502)', () => {
  let haystack: string;

  beforeAll(() => {
    haystack = mkdtempSync(join(tmpdir(), 'fa-guard-'));
    mkdirSync(join(haystack, 'work_items'), { recursive: true });
    writeFileSync(join(haystack, 'work_items', 'tag.ts'), 'export const tag = 1;\n');
  });

  afterAll(() => {
    rmSync(haystack, { recursive: true, force: true });
  });

  const at = (command: string, cwd = haystack) => ({
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 's-test',
    cwd,
  });

  const expectFalseAbsenceDeny = (out: { stdout: string; stderr?: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const reason = parseDecision(out).hookSpecificOutput.permissionDecisionReason as string;
    expect(parseDecision(out).hookSpecificOutput.permissionDecision).toBe('deny');
    expect(reason).toContain('false-absence search-path guard');
    // The remedy is the whole point of the deny — a bare refusal would leave
    // the agent to guess, which is how the measured 3-week instance happened.
    expect(reason).toContain('AN ABSENCE CLAIM NEEDS A POSITIVE CONTROL');
  };

  it('denies a grep whose path operand does not exist', () => {
    expectFalseAbsenceDeny(runGate(at("grep -rn 'foo' no-such-dir/")));
  });

  it('denies the MEASURED typo — piped `ls` on `work-items/` when the real dir is `work_items/`', () => {
    expectFalseAbsenceDeny(runGate(at('ls work-items/ | grep -i tag')));
  });

  it('denies an `rg` whose path operand does not exist', () => {
    expectFalseAbsenceDeny(runGate(at("rg -n 'foo' no-such-dir/")));
  });

  it('denies the `-e` form, where EVERY positional operand is a path', () => {
    expectFalseAbsenceDeny(runGate(at('grep -rn -e foo no-such-dir/')));
  });

  it('denies through a `cd`, resolving the path relative to the new cwd', () => {
    expectFalseAbsenceDeny(runGate(at('cd work_items && grep -rn foo no-such-dir/')));
  });

  it('does not treat the next line\'s command name as a path operand', () => {
    expectAllow(runGate(at('grep -rn foo work_items/\necho done')));
  });

  it('preserves a quoted newline inside a search argument', () => {
    expectAllow(runGate(at(`grep -rn "foo
bar" work_items/`)));
  });

  it('preserves a backslash-continued newline instead of making a separator', () => {
    const command = 'echo first' + '\\' + '\n' + 'second\ngrep -rn foo work_items/';
    expectAllow(runGate(at(command)));
  });

  it('keeps operator chains intact when an operator precedes a newline', () => {
    expectAllow(runGate(at('grep -rn foo work_items/ &&\necho done')));
  });

  it('names the missing path AND its resolved form in the refusal', () => {
    const reason = parseDecision(runGate(at("grep -rn 'foo' no-such-dir/")))
      .hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain('no-such-dir/');
    expect(reason).toContain(haystack); // where it actually looked
  });

  it('silent when the path EXISTS (the guard measures, it does not pattern-match)', () => {
    expectAllow(runGate(at("grep -rn 'foo' work_items/")));
  });

  it('resolves an existing relative path from exec_command workdir, not the session cwd', () => {
    const sessionCwd = join(haystack, 'session-cwd');
    mkdirSync(sessionCwd, { recursive: true });
    expectAllow(runGate({
      tool_name: 'exec_command',
      tool_input: {
        command: "rg -n 'tag' work_items/",
        workdir: haystack,
      },
      session_id: 's-test',
      cwd: sessionCwd,
    }));
  });

  it('still refuses a missing relative path under exec_command workdir', () => {
    const sessionCwd = join(haystack, 'session-cwd');
    mkdirSync(sessionCwd, { recursive: true });
    const reason = parseDecision(runGate({
      tool_name: 'exec_command',
      tool_input: {
        command: "rg -n 'tag' no-such-dir/",
        workdir: haystack,
      },
      session_id: 's-test',
      cwd: sessionCwd,
    })).hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain('false-absence search-path guard');
    expect(reason).toContain(join(haystack, 'no-such-dir'));
  });

  it('silent when a `cd` is what makes the relative path valid', () => {
    expectAllow(runGate(at('cd work_items && grep -rn foo tag.ts')));
  });

  it('silent for a glob operand — the shell, not the guard, decides what it names', () => {
    expectAllow(runGate(at("grep -rn foo work_*/")));
  });

  it('silent for a variable operand — unresolvable, so never judged', () => {
    expectAllow(runGate(at('grep -rn foo $DIR/')));
  });

  it('silent for a command substitution in the path', () => {
    expectAllow(runGate(at('grep -rn foo "$(pwd)/no-such-dir"')));
  });

  // UNQUOTED is the case that bites: `$(pwd)/x` tokenizes to the five words
  // `$` `(` `pwd` `)` `/x`, so a bare `(` arrives looking exactly like a
  // positional path operand. Without the subshell abort the guard stats `(`,
  // finds no such file, and denies an entirely ordinary command.
  it('silent for an UNQUOTED command substitution, whose `(` is not a path', () => {
    expectAllow(runGate(at('grep -rn foo $(pwd)/no-such-dir')));
  });

  it("does not read a redirect's fd digit as a path (`2>/dev/null`)", () => {
    expectAllow(runGate(at('grep -rn foo work_items 2>/dev/null')));
  });

  it("preserves grep's -- pattern terminator before a stderr redirect", () => {
    const command =
      "grep -rn -- '--run=' .papercusp/scratch/wi5384/*.sh scripts/agent-capacity/vm/*.sh 2>/dev/null | grep -i teardown | head";
    const out = runGate(at(command));
    expect(out.status).toBe(0);
    if (out.stdout.trim()) {
      expect(parseDecision(out).hookSpecificOutput.permissionDecision).toBe('allow');
    }
  });

  it('still checks a numeric path operand after -- when no redirect follows', () => {
    expectFalseAbsenceDeny(runGate(at('grep -rn -- foo 2')));
  });

  it('silent when the search appears only as PROSE inside quotes', () => {
    expectAllow(runGate(at('echo "grep -rn foo no-such-dir/"')));
  });

  it('silent when a non-`cd` command precedes it — it may be CREATING that path', () => {
    expectAllow(runGate(at('mkdir -p made-here && ls made-here | grep x')));
  });

  it('silent inside a subshell, where the guard cannot tell what the `cd` applies to', () => {
    expectAllow(runGate(at('( cd work_items && grep -rn foo no-such-dir/ )')));
  });

  it('silent for `ls -d missing` — that IS the existence probe the deny recommends', () => {
    expectAllow(runGate(at('ls -d no-such-dir | grep x')));
  });

  /**
   * `ls` is parsed with ITS OWN flag table, not grep's. `-A`, `-C`, `-B`,
   * `-D`, `-m` and `-f` all take an argument in grep and take none in ls, so
   * borrowing grep's table makes the path parse as the flag's argument and
   * the guard sees no path at all — a silent miss on the exact command shape
   * that produced the measured instance. Found by mutation probe: it is what
   * made the `ls -d` exemption above look load-bearing while the operand was
   * really just being swallowed.
   */
  it.each(['-A', '-C', '-m', '-f', '-B'])(
    'still denies `ls %s missing | grep` — an ls flag that takes NO argument',
    (flag) => {
      expectFalseAbsenceDeny(runGate(at(`ls ${flag} no-such-dir | grep x`)));
    },
  );

  it('silent for an UNPIPED `ls missing` — its stderr error is loud, not absent', () => {
    expectAllow(runGate(at('ls no-such-dir/')));
  });

  it('silent when grep reads stdin and its only operand is the PATTERN', () => {
    expectAllow(runGate(at('cat work_items/tag.ts | grep no-such-dir/foo')));
  });

  /**
   * The cwd leg is load-bearing, and getting it wrong is not a near-miss —
   * it is a false deny on everyday commands. Resolving a relative operand
   * against the HOOK process's `os.getcwd()` (the idiom used elsewhere in
   * this script) turned `rg -n pkill apps/operator` into a lookup of
   * `apps/operator/apps/operator` and denied nine commands in this suite.
   * A relative path is only resolvable when the host states the cwd.
   */
  describe('a relative operand is only judged when the host states a cwd', () => {
    const noCwd = (command: string) => ({
      tool_name: 'Bash',
      tool_input: { command },
      session_id: 's-test',
    });

    it('silent for a relative path when the payload carries no cwd', () => {
      expectAllow(runGate(noCwd('grep -rn foo no-such-dir/')));
    });

    it('still denies an ABSOLUTE missing path with no cwd — nothing to resolve', () => {
      expectFalseAbsenceDeny(runGate(noCwd(`grep -rn foo ${join(haystack, 'no-such-dir')}`)));
    });

    it('silent for a relative `cd` target when the payload carries no cwd', () => {
      expectAllow(runGate(noCwd('cd work_items && grep -rn foo no-such-dir/')));
    });

    // A cwd that does not exist is worse than none: EVERY relative operand
    // under it resolves to a fictional location and would read as missing.
    // Caught by the `#`-comment shell-write suite, whose payloads state a
    // canonical-tree cwd that is not a real directory on this box.
    it('silent for a relative path when the stated cwd does not exist', () => {
      expectAllow(
        runGate({
          tool_name: 'Bash',
          tool_input: { command: 'grep -n foo bar.ts' },
          session_id: 's-test',
          cwd: '/no/such/cwd/anywhere',
        }),
      );
    });
  });
});

/**
 * invalid relative find timestamp guard (EI-21185971718818430).
 *
 * bfs 4.1.1 rejects human-relative and named-timezone timestamp text for
 * `-newermt`. When stderr is hidden, the empty result is easy to misread as
 * "nothing changed". The hook can safely judge literal values, but must leave
 * variables and command substitutions alone because expansion would execute
 * user code and is outside a PreToolUse lexical guard's scope.
 */
describe('invalid relative find timestamp guard (EI-21185971718818430)', () => {
  const bashWithInput = (command: string) => ({
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 's-find-timestamp',
    cwd: '/tmp',
  });

  const expectTimestampDeny = (out: { stdout: string; stderr?: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const decision = parseDecision(out).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason).toContain('invalid find timestamp guard');
    expect(decision.permissionDecisionReason).toContain('bfs 4.1.1');
    expect(decision.permissionDecisionReason).toContain('ISO-8601-like');
    expect(decision.permissionDecisionReason).toContain('stderr');
  };

  it('denies bfs human-relative text even when stderr is redirected', () => {
    expectTimestampDeny(
      runGate(bashWithInput("bfs . -newermt '12 minutes ago' 2>/dev/null")),
    );
  });

  it('denies find negative-relative text', () => {
    expectTimestampDeny(runGate(bashWithInput("find . -newermt '-10 minutes'")));
  });

  it('denies a named timezone that is not ISO-8601-like', () => {
    expectTimestampDeny(
      runGate(bashWithInput("find . -newermt '2026-08-22 20:34:00 America/New_York'")),
    );
  });

  it('denies the generic -newerXY date form when Y is t', () => {
    expectTimestampDeny(runGate(bashWithInput("find . -newerBt 'yesterday'")));
  });

  it.each([
    "find . -newermt '2026-08-22'",
    "find . -newermt '2026-08-22T20:34:00Z'",
    "find . -newermt '2026-08-22 20:34:00 +00:00'",
    'find . -newermt "$STAMP"',
    'find . -newermt "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
  ])('allows an ISO or runtime-produced timestamp: %s', (command) => {
    expectAllow(runGate(bashWithInput(command)));
  });

  it('does not inspect prose that merely mentions find', () => {
    expectAllow(runGate(bashWithInput('echo "find . -newermt \'12 minutes ago\'"')));
  });
});

/**
 * false-absence SYMLINK-TRAVERSAL guard (EI-20825101204716643).
 *
 * Same class as the suite above, different mechanism — and a worse one. A
 * missing path at least errors on stderr and exits non-zero. Here `find`
 * prints nothing, exits 0, and says nothing on stderr, because it defaults to
 * -P and will not follow a symlink operand: the link is treated as a FILE, so
 * nothing is descended and no `-name` can match. Every channel reports
 * success, which is why the filer only caught it when a POSITIVE CONTROL for
 * a file they knew was there also came back empty.
 *
 * It was filed as "absolute paths are intercepted by the sandbox". They are
 * not — `command find`, with every wrapper bypassed, behaves identically, and
 * /tmp, /etc and $HOME all enumerate fine. `cd <symlink> && find .` works only
 * because `cd` resolves the link, which is what made the bug look positional.
 *
 * The allow cases are again the load-bearing half: this guard DENIES, so each
 * one names a construct it must refuse to judge, or a shape where not
 * descending is what the caller actually asked for.
 */
describe('false-absence symlink-traversal guard (EI-20825101204716643)', () => {
  let haystack: string;
  let linked: string;

  beforeAll(() => {
    haystack = mkdtempSync(join(tmpdir(), 'fa-symlink-'));
    mkdirSync(join(haystack, 'real_pkg'), { recursive: true });
    writeFileSync(join(haystack, 'real_pkg', 'package.json'), '{}\n');
    linked = join(haystack, 'linked');
    symlinkSync(join(haystack, 'real_pkg'), linked, 'dir');
    // A symlink to a FILE is deliberately NOT this trap: nothing was going to
    // be descended, so denying it would be a false positive.
    symlinkSync(join(haystack, 'real_pkg', 'package.json'), join(haystack, 'linked_file'));
  });

  afterAll(() => {
    rmSync(haystack, { recursive: true, force: true });
  });

  const at = (command: string, cwd = haystack) => ({
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 's-test',
    cwd,
  });

  const expectSymlinkDeny = (out: { stdout: string; stderr?: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const decision = parseDecision(out).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason as string).toContain(
      'false-absence symlink-traversal guard',
    );
  };

  /**
   * CALIBRATION AGAINST REALITY, not against my belief about find.
   *
   * Every assertion below is worthless if find does not actually behave this
   * way, and a guard that encodes a stale premise denies correct commands
   * forever. So pin the premise to the system itself: if a future findutils
   * (or the `bfs` the shell wraps `find` as) starts following symlink
   * operands, THIS fails first and says the guard is now wrong — rather than
   * the guard silently becoming a false-deny nobody can explain.
   */
  it('PREMISE: real `find` returns nothing for a bare symlink operand, and the file WITH a trailing slash', () => {
    const run = (...args: string[]) =>
      execFileSync('find', args, { encoding: 'utf8' }).trim();
    expect(run(linked, '-maxdepth', '1', '-name', 'package.json')).toBe('');
    // The positive control: same haystack, same needle, one character apart.
    expect(run(`${linked}/`, '-maxdepth', '1', '-name', 'package.json')).toContain('package.json');
    expect(run('-L', linked, '-maxdepth', '1', '-name', 'package.json')).toContain('package.json');
  });

  it('denies a bare symlink-to-directory operand', () => {
    expectSymlinkDeny(runGate(at(`find ${linked} -maxdepth 1 -name package.json`)));
  });

  it('denies a RELATIVE symlink operand, resolved against the stated cwd', () => {
    expectSymlinkDeny(runGate(at('find linked -name package.json')));
  });

  it('denies through a `cd`, like its sibling guard', () => {
    expectSymlinkDeny(runGate(at('cd real_pkg && find ../linked -name package.json')));
  });

  it('names the link target AND the trailing-slash remedy in the refusal', () => {
    const reason = parseDecision(runGate(at(`find ${linked} -name package.json`)))
      .hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain('real_pkg');                     // where it actually points
    expect(reason).toContain(`find ${linked}/`);              // the one-character fix
    expect(reason).toContain('AN ABSENCE CLAIM NEEDS A POSITIVE CONTROL');
  });

  /**
   * CALIBRATION CONTROL. Without this, every allow below would also pass if
   * the guard were simply inert — the failure mode that makes a guard suite
   * look green while guarding nothing.
   */
  it('silent for a REAL directory operand — the deny is about the symlink, not about `find`', () => {
    expectAllow(runGate(at(`find ${join(haystack, 'real_pkg')} -maxdepth 1 -name package.json`)));
  });

  it('silent WITH a trailing slash — the remedy the deny recommends must not be denied', () => {
    expectAllow(runGate(at(`find ${linked}/ -maxdepth 1 -name package.json`)));
  });

  it.each(['-L', '-H'])('silent with %s, which follows the operand', (flag) => {
    expectAllow(runGate(at(`find ${flag} ${linked} -name package.json`)));
  });

  it('silent with the deprecated `-follow` expression spelling', () => {
    expectAllow(runGate(at(`find ${linked} -follow -name package.json`)));
  });

  it('silent with `-maxdepth 0` — not descending is the stated intent', () => {
    expectAllow(runGate(at(`find ${linked} -maxdepth 0 -type l`)));
  });

  it('silent for a symlink to a FILE — nothing was going to be descended', () => {
    expectAllow(runGate(at(`find ${join(haystack, 'linked_file')} -name package.json`)));
  });

  it('silent for a variable operand — unresolvable, so never judged', () => {
    expectAllow(runGate(at('find $DIR -name package.json')));
  });

  it('silent for a glob operand — the shell, not the guard, decides what it names', () => {
    expectAllow(runGate(at('find link* -name package.json')));
  });

  it('does not read a redirect fd digit as a path (`find /x 2>/dev/null`)', () => {
    expectAllow(runGate(at(`find ${join(haystack, 'real_pkg')} 2>/dev/null`)));
  });

  it('silent when a non-`cd` command precedes it — it may be CREATING that path', () => {
    expectAllow(runGate(at(`mkdir -p made && find ${linked} -name package.json`)));
  });
});

/**
 * FIFO-read hang guard (EI-24862273512503301).
 *
 * Claude Code re-opens a path after a Bash command reads it, after the command
 * has returned and outside the Bash timeout. open(2) of a FIFO blocks until a
 * writer attaches, so once the writer has closed, the tool result never comes
 * back (measured 2026-10-02 in the J5 outage drill, wchan wait_for_partner).
 *
 * Every fixture here is a REAL FIFO made with mkfifo, and the gate is judged
 * through the same stdin/stdout contract the host uses. The guard itself must
 * never open the pipe: if it did, these tests would hang rather than pass,
 * because no test ever attaches a writer.
 */
describe('FIFO-read hang guard (EI-24862273512503301)', () => {
  let dir: string;
  let fifo: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fifo-guard-'));
    fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    writeFileSync(join(dir, 'regular'), 'x\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const at = (command: string, tool = 'Bash') => ({
    tool_name: tool,
    tool_input: { command },
    session_id: nextSid(),
    cwd: dir,
  });

  const expectFifoDeny = (out: GateOut) => {
    expect(out.status).toBe(0);
    const decision = parseDecision(out).hookSpecificOutput;
    expect(decision.permissionDecision).toBe('deny');
    expect(decision.permissionDecisionReason as string).toContain('FIFO-read hang guard');
  };

  it('PREMISE: the fixture is a real FIFO, so every deny below is about a pipe', () => {
    expect(statSync(fifo).isFIFO()).toBe(true);
    expect(statSync(join(dir, 'regular')).isFIFO()).toBe(false);
  });

  it.skipIf(process.platform !== 'linux' || !existsSync('/dev/shm'))('judges user FIFOs under /dev/shm while allowing regular files there', () => {
    const sharedDir = mkdtempSync(join('/dev/shm', 'fifo-guard-'));
    const sharedFifo = join(sharedDir, 'pipe');
    const sharedRegular = join(sharedDir, 'regular');
    try {
      execFileSync('mkfifo', [sharedFifo]);
      writeFileSync(sharedRegular, 'x\n');
      expectFifoDeny(runGate(at(`cat ${sharedFifo}`)));
      expectFifoDeny(runGate(at(`sudo -n cat ${sharedFifo}`)));
      expectAllow(runGate(at(`cat ${sharedRegular}`)));
    } finally {
      rmSync(sharedDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['absolute operand', () => `cat ${fifo}`],
    ['relative operand resolved against the stated cwd', () => 'cat pipe'],
    ['through a `cd`', () => `cd ${dir} && head -n 3 pipe`],
    ['behind a wrapper (`sudo -n`)', () => `sudo -n cat ${fifo}`],
    ['a pattern-taking reader (`grep`)', () => 'grep -n foo pipe'],
    ['the second segment of a pipeline', () => `echo hi | wc -l ${fifo}`],
  ])('denies a read of a FIFO: %s', (_label, command) => {
    expectFifoDeny(runGate(at(command())));
  });

  it('names the pipe and the regular-file remedy in the refusal', () => {
    const reason = parseDecision(runGate(at(`cat ${fifo}`)))
      .hookSpecificOutput.permissionDecisionReason as string;
    expect(reason).toContain(fifo);
    expect(reason).toContain('REGULAR FILE');
    expect(reason).toContain('wait_for_partner');
  });

  /**
   * CALIBRATION CONTROL: the same reader on a regular file in the same
   * directory. Without it, every allow below would also pass if the guard were
   * simply inert.
   */
  it('silent for a regular file — the deny is about the pipe, not about `cat`', () => {
    expectAllow(runGate(at(`cat ${join(dir, 'regular')}`)));
  });

  it.each([
    ['inspecting the pipe without opening it (`ls -l`)', () => `ls -l ${fifo}`],
    ['inspecting the pipe without opening it (`stat`)', () => `stat ${fifo}`],
    ['a redirect: the shell opens it, not a named operand', () => `cat < ${fifo}`],
    ['a command that only MENTIONS the words', () => 'echo cat pipe'],
    ['an unresolvable operand (`$VAR`)', () => 'cat $P'],
    ['/dev/stdin, which resolves against the hook process', () => 'cat /dev/stdin'],
  ])('silent for %s', (_label, command) => {
    expectAllow(runGate(at(command())));
  });

  it('silent for a Codex shell — the re-open is a Claude Code behaviour', () => {
    expectAllow(runGate(at(`cat ${fifo}`, 'exec_command')));
  });
});

/**
 * WI-6944 — the `;`-chain half of the same exit-code trap. The advisory above
 * only matches a PIPE; a `;`-chain masks identically but through a separate
 * TRAILING command:
 *
 *     cmd > /tmp/out.txt 2>&1; echo "===EXIT:$?==="
 *
 * A `;`-chain exits with its LAST command's status, so the trailing `echo`
 * (always 0) replaces the real command's and the completion notification
 * reports "completed (exit code 0)" for a run that FAILED.
 *
 * Proven end-to-end 2026-08-02 (job bnmntj9o4): `sleep 2; false; echo
 * "===PROOF_EXIT:$?==="` produced artifact `===PROOF_EXIT:1===` under a
 * notification reading "completed (exit code 0)". Three real `lint:tsc` runs
 * the same night all ended `===TSC_EXIT:1===` with "1 NEW file(s) have type
 * errors" and were nearly accepted as a green gate check on the strength of
 * their notifications.
 *
 * The irony this guard exists for: the trailing command is almost always an
 * exit MARKER added so the log would carry a trustworthy verdict — i.e. the
 * diagnostic you reach for when you care most is what erases the failure.
 */
describe('background `;`-chain trailing-reporter exit-code advisory (WI-6944)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectChainAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('background `;`-chain exit-code advisory');
    expect(hso.additionalContext).toContain('exit "$rc"');
  };

  it('fires on the exact idiom that produced the false green (exit marker echo)', () => {
    expectChainAdvisory(
      runGate(
        bashWithInput({
          command: 'npm run lint:tsc -- --files=a.ts > /tmp/o.txt 2>&1; echo "===TSC_EXIT:$?==="',
          run_in_background: true,
        }),
      ),
    );
  });

  it.each([
    ['echo confirming completion', 'npm test > /tmp/o 2>&1; echo done'],
    ['ls to confirm the artifact', 'npm test > /tmp/o 2>&1; ls -la /tmp/o'],
    ['date stamp after the run', 'npm test > /tmp/o 2>&1; date'],
    ['wc counting the output', 'npm test > /tmp/o 2>&1; wc -l /tmp/o'],
    ['newline-separated, not semicolon', 'npm test > /tmp/o 2>&1\necho "===EXIT:$?==="'],
  ])('fires on a trailing reporter: %s', (_label, command) => {
    expectChainAdvisory(runGate(bashWithInput({ command, run_in_background: true })));
  });

  // EI-18861104217890085: the reporter list used to be echo/ls/date/wc/cat/tee
  // only, so the exact idiom the PIPE guard's own docstring recommends as the
  // safe alternative to a pipe ("redirect to a log file … and read that
  // instead: `cmd > /tmp/x.log 2>&1; head -N /tmp/x.log`") walked straight
  // through this guard unadvised whenever the trailing reader was tail/head/
  // grep/sed/awk/… rather than echo/ls/date/wc. Live repro (verifying
  // WI-6522): `npm run test:affected > /tmp/x.log 2>&1; echo "EXIT=$?"; tail
  // -25 /tmp/x.log` — a REAL failed sweep reported "completed (exit code 0)"
  // because the command ends in `tail`, not `echo`.
  it.each([
    ['tail reading the log (the exact live repro, EI-18861104217890085)',
      'npm run test:affected > /tmp/x.log 2>&1; echo "EXIT=$?"; tail -25 /tmp/x.log'],
    ['head reading the log', 'npm test > /tmp/o 2>&1; head -20 /tmp/o'],
    ['grep filtering the log', 'npm test > /tmp/o 2>&1; grep FAIL /tmp/o'],
    ['sed slicing the log', "npm run build > /tmp/o 2>&1; sed -n '1,40p' /tmp/o"],
    ['awk on the log', 'npm test > /tmp/o 2>&1; awk "{print $1}" /tmp/o'],
  ])('fires on a trailing reporter widened to match the pipe guard: %s', (_label, command) => {
    expectChainAdvisory(runGate(bashWithInput({ command, run_in_background: true })));
  });

  // Deliberate NON-targets. Each masks (or looks like it might), but each also
  // demonstrates that the author already knows about exit codes — so advising
  // them is noise. The pipe suite above independently asserts the first two;
  // these cases exist so a later change can't quietly widen this guard back
  // over them and rediscover the same false positives.
  it.each([
    ['`||` — writing a failure branch IS awareness of the failure path', 'npm test || echo failed'],
    ['PIPESTATUS — an explicit exit-status-preservation idiom', 'npm test 2>&1 | tail -20; echo "EXIT=${PIPESTATUS[0]}"'],
    ['pipefail — same', 'set -o pipefail; npm test 2>&1 | tee /tmp/o; echo done'],
  ])('deliberately silent: %s', (_label, command) => {
    expectAllow(runGate(bashWithInput({ command, run_in_background: true })));
  });

  // The correct pattern must stay SILENT, or the advisory punishes the fix.
  it.each([
    ['exit "$rc" restores the code', 'npm test > /tmp/o 2>&1; rc=$?; echo "===EXIT:$rc===" >> /tmp/o; exit "$rc"'],
    ['unquoted exit $rc', 'npm test > /tmp/o 2>&1; rc=$?; echo "EXIT:$rc"; exit $rc'],
    ['exit $? directly', 'npm test > /tmp/o 2>&1; echo marker; exit $?'],
  ])('silent when the exit code is restored: %s', (_label, command) => {
    expectAllow(runGate(bashWithInput({ command, run_in_background: true })));
  });

  it('silent on `&&` — it short-circuits, so a failure still propagates', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm test > /tmp/o 2>&1 && echo passed', run_in_background: true })));
  });

  it('silent when NOT backgrounded (no completion notification to mislead)', () => {
    expectAllow(runGate(bashWithInput({ command: 'npm test > /tmp/o 2>&1; echo "===EXIT:$?==="' })));
  });

  it('silent on a lone reporter — one command masks nothing', () => {
    expectAllow(runGate(bashWithInput({ command: 'echo hello', run_in_background: true })));
  });

  it('silent when the real command is LAST (nothing trailing it)', () => {
    expectAllow(runGate(bashWithInput({ command: 'cd packages/operator-core; npm test', run_in_background: true })));
  });
});

/**
 * EI-19408257709127659 — DOUBLE-BACKGROUNDING. The two guards above catch a
 * notification carrying the wrong EXIT CODE for a job that really did finish.
 * This one catches a notification that fires while the job is STILL RUNNING:
 * `run_in_background: true` already backgrounds the command, so a manual `&`
 * (or `nohup … &` / `setsid`) forks a second untracked layer whose wrapper
 * returns immediately. The completion itself is false, not just its code.
 */
describe('double-backgrounding false-completion advisory (EI-19408257709127659)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectDoubleBgAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('double-background advisory');
    expect(hso.additionalContext).toContain('FALSE COMPLETION');
  };

  it('fires on the exact filed repro (`nohup … > log 2>&1 &`)', () => {
    const out = runGate(
      bashWithInput({
        command: 'nohup npm run test:affected > /tmp/aff.log 2>&1 &',
        run_in_background: true,
      }),
    );
    expectDoubleBgAdvisory(out);
    expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain('nohup');
  });

  it.each([
    ['a bare trailing `&`', 'npm run build > /tmp/o 2>&1 &'],
    ['the `& echo $!` pid-capture idiom', 'npm run test:affected > /tmp/o 2>&1 & echo "launched pid $!"'],
    ['`setsid` with no `&` — it detaches on its own', 'setsid npm run build > /tmp/o 2>&1'],
    ['a backgrounded segment mid-chain', 'cd packages/operator-core && npm test > /tmp/o 2>&1 &'],
  ])('fires on %s', (_label, command) => {
    expectDoubleBgAdvisory(runGate(bashWithInput({ command, run_in_background: true })));
  });

  // The `&`-bearing shapes that are NOT a second fork. Each of these once made
  // a naive `&` scan useless, so they are pinned as deliberate non-targets.
  it.each([
    ['`2>&1` is a redirection, not a background fork', 'npm test > /tmp/o 2>&1'],
    ['`>&2` is a redirection too', 'npm test 2>/dev/null >&2'],
    ['`&>log` is a redirection too', 'npm test &> /tmp/o'],
    ['`&&` short-circuits in one process', 'npm run build > /tmp/o 2>&1 && npm test >> /tmp/o 2>&1'],
    ['`wait` reaps the child, so the wrapper outlives the job', 'npm test > /tmp/o 2>&1 & wait'],
    ['bare `nohup` with no `&` does not fork', 'nohup npm run build > /tmp/o 2>&1'],
  ])('deliberately silent: %s', (_label, command) => {
    expectAllow(runGate(bashWithInput({ command, run_in_background: true })));
  });

  it('silent when NOT backgrounded — there is no completion notification to falsify', () => {
    // A foreground `&` is a different hazard and already has its own advisory
    // (EI-20202551640426512); what must NOT appear is the double-background one,
    // whose whole premise is a tracked background job reporting completion.
    const out = runGate(bashWithInput({ command: 'npm run build > /tmp/o 2>&1 &' }));
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.additionalContext).not.toContain('double-background advisory');
    expect(hso.additionalContext).toContain('foreground shell-backgrounding advisory');
  });

  it('yields to the pipe advisory when both apply (ordering is pinned)', () => {
    const out = runGate(
      bashWithInput({ command: 'setsid npm test 2>&1 | tail -20', run_in_background: true }),
    );
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.additionalContext).toContain('background-pipe exit-code advisory');
    expect(hso.additionalContext).not.toContain('double-background advisory');
  });

  // …but a trailing `&` AFTER the pipe stage is deliberately ours, not the pipe
  // guard's: `_PIPE_TAIL_RE` ends its match at `[^|;&\n]*$`, so a segment ending
  // in `&` never matches it. That is the right split — with a second fork in
  // play the notification is false outright, which subsumes a wrong exit code.
  it('claims `cmd | tail &` — the pipe guard cannot see past the trailing `&`', () => {
    expectDoubleBgAdvisory(
      runGate(bashWithInput({ command: 'nohup npm test 2>&1 | tail -20 &', run_in_background: true })),
    );
  });
});

/**
 * EI-18787618439028592 — foreground `| head` SIGPIPE-kill advisory: distinct
 * from the background-pipe exit-code trap above. `head` exits after N lines
 * and SIGPIPEs the upstream writer, killing it mid-run — a hazard that exists
 * in the FOREGROUND too. The generic foreground exit-code advisory runs after
 * this block so the sharper SIGPIPE explanation keeps precedence for `head`.
 */
describe('foreground `| head` SIGPIPE-kill advisory (EI-18787618439028592)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectHeadAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('foreground `| head` SIGPIPE-kill advisory');
    expect(hso.additionalContext).toContain('SIGPIPE');
  };

  it('fires on a FOREGROUND `cmd | head -N`', () => {
    expectHeadAdvisory(runGate(bashWithInput({ command: "node -e \"import('./x.mjs')\" 2>&1 | head -3" })));
  });

  it("hands foreground `cmd | tail -N` to the exit-code advisory, not the SIGPIPE advisory", () => {
    const out = runGate(
      bashWithInput({ command: "npm run test:affected 2>&1 | tail -100" }),
    );
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.additionalContext).toContain(
      "foreground verification-pipe exit-code advisory",
    );
    expect(hso.additionalContext).not.toContain("SIGPIPE-kill");
  });

  it('silent when BACKGROUNDED — the exit-code advisory above takes the one slot instead', () => {
    const out = runGate(bashWithInput({ command: 'rsync -av a b 2>&1 | head -50', run_in_background: true }));
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.additionalContext).toContain('background-pipe exit-code advisory');
    expect(hso.additionalContext).not.toContain('SIGPIPE-kill');
  });

  it('silent when the writer is already protected (`cat >/dev/null` drains the pipe)', () => {
    expectAllow(
      runGate(bashWithInput({ command: 'long-running-cmd | { head -3; cat >/dev/null; }' })),
    );
  });

  it('still fires when `head` is reached via a path', () => {
    expectHeadAdvisory(runGate(bashWithInput({ command: 'npm run build 2>&1 | /usr/bin/head -20' })));
  });

  it('does not false-positive on a pipe-to-head token INSIDE quotes', () => {
    expectAllow(runGate(bashWithInput({ command: 'grep -E "a|head" some-file.ts' })));
  });

  it('does NOT confuse `||` with a real pipe', () => {
    expectAllow(runGate(bashWithInput({ command: 'some-cmd || head -3 fallback.txt' })));
  });

  it('silent for a plain command with no pipe (`head` reading a real file directly)', () => {
    expectAllow(runGate(bashWithInput({ command: 'head -20 /tmp/some.log' })));
  });

  it('fires for Codex shells too — SIGPIPE is a real OS signal, not a Claude-only concern', () => {
    for (const tool of ['exec_command', 'local_shell', 'shell']) {
      expectHeadAdvisory(runGate(bashWithInput({ command: 'long-running-cmd | head -3' }, tool)));
    }
  });

  it('a deny gate still WINS over the head advisory', () => {
    const out = runGate(
      { tool_name: 'Bash', tool_input: { command: 'crontab -e | head' }, session_id: 's-test' },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * EI-21551186399462209 — foreground pipelines mask upstream verification
 * failures exactly like background pipelines. The measured repro was
 * `cargo test … | tail`: cargo exited 101, while the shell returned tail's 0.
 * Keep this proportional by limiting it to declared verification/build/test
 * stages; ordinary exploratory pipes stay silent.
 */
describe('foreground verification-pipe exit-code advisory (EI-21551186399462209)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectForegroundPipeAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow');
    expect(hso.additionalContext).toContain('foreground verification-pipe exit-code advisory');
    expect(hso.additionalContext).toContain("FILTER's exit code");
    expect(hso.additionalContext).toContain('PIPESTATUS[0]');
  };

  it('fires on the measured `cargo test | tail` repro', () => {
    expectForegroundPipeAdvisory(
      runGate(bashWithInput({ command: 'cd apps/tui && cargo test --lib focused_case 2>&1 | tail -25' })),
    );
  });

  it.each([
    ['grep', 'npm test 2>&1 | grep FAIL'],
    ['cut', 'go test ./... 2>&1 | cut -d: -f1'],
    ['sort', 'pytest -q 2>&1 | sort'],
    ['tee via a path', 'npx tsc --noEmit 2>&1 | /usr/bin/tee /tmp/tsc.log'],
  ])('fires when a foreground verification pipes into %s', (_label, command) => {
    expectForegroundPipeAdvisory(runGate(bashWithInput({ command })));
  });

  it('fires for Codex shell tools too — this is shell pipeline behaviour', () => {
    for (const tool of ['exec_command', 'local_shell', 'shell']) {
      expectForegroundPipeAdvisory(
        runGate(bashWithInput({ command: 'cargo test --lib focused_case 2>&1 | tail -25' }, tool)),
      );
    }
  });

  it.each([
    ['pipefail', 'set -o pipefail; cargo test --lib focused_case 2>&1 | tail -25'],
    ['PIPESTATUS', 'cargo test --lib focused_case 2>&1 | tail -25; echo "EXIT=${PIPESTATUS[0]}"'],
  ])('silent when the caller preserves the upstream status with %s', (_label, command) => {
    expectAllow(runGate(bashWithInput({ command })));
  });

  it.each([
    ['ordinary process inspection', 'ps aux | tail -5'],
    ['ordinary source filtering', 'git status --short | grep apps'],
    ['filter name only inside quoted prose', 'echo "cargo test | tail is risky"'],
  ])('stays silent for %s', (_label, command) => {
    expectAllow(runGate(bashWithInput({ command })));
  });

  it('a deny gate still wins over the foreground advisory', () => {
    const out = runGate(
      bashWithInput({ command: 'crontab -e; cargo test --lib focused_case 2>&1 | tail -25' }),
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * EI-20041520588565350 — a recursive grep/rg piped into `head` can make a
 * partial match list look like a complete absence search. This is separate
 * from the SIGPIPE warning above: even when the writer is harmless, the first
 * N lines do not establish that later files contain no matches.
 */
describe('grep/rg → `| head` false-absence advisory (EI-20041520588565350)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectFalseAbsenceAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('grep-to-head false-absence advisory');
    expect(hso.additionalContext).toContain('cannot prove absence');
    expect(hso.additionalContext).toContain('grep -rl');
  };

  const expectNoFalseAbsenceAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    // A real `head` pipeline still receives the older SIGPIPE advisory. The
    // regression here is specifically that this new false-absence class does
    // not fire for an explicitly bounded search or a non-search pipeline.
    if (!out.stdout.trim()) return;
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow');
    expect(hso.additionalContext ?? '').not.toContain('grep-to-head false-absence advisory');
  };

  it('fires on the reported recursive grep pipeline', () => {
    expectFalseAbsenceAdvisory(
      runGate(
        bashWithInput({
          command: 'grep -rn "PotHealthPane" apps --include=*.tsx | grep -v "PotHealthPane.tsx:" | head',
        }),
      ),
    );
  });

  it('fires for rg as well as grep', () => {
    expectFalseAbsenceAdvisory(runGate(bashWithInput({ command: "rg -n 'PotHealthPane' apps | head -10" })));
  });

  it.each([
    ['files-with-matches', 'grep -rl foo apps | head -10'],
    ['count', 'grep -rc foo apps | head -10'],
    ['quiet boolean', 'grep -rq foo apps | head -10'],
    ['long files-with-matches', 'grep --files-with-matches foo apps | head -10'],
    ['long count', 'grep --count foo apps | head -10'],
  ])('does not emit the false-absence advisory for an explicit %s search mode', (_label, command) => {
    expectNoFalseAbsenceAdvisory(runGate(bashWithInput({ command })));
  });

  it('does not emit the false-absence advisory for a head pipeline with no grep/rg stage', () => {
    expectNoFalseAbsenceAdvisory(runGate(bashWithInput({ command: 'git status --short | head -10' })));
  });

  it('does not treat a quoted pipe as a real pipeline', () => {
    expectNoFalseAbsenceAdvisory(runGate(bashWithInput({ command: 'grep -E "a|head" some-file.ts' })));
  });

  it('a deny gate still WINS over the false-absence advisory', () => {
    const out = runGate(
      {
        tool_name: 'Bash',
        tool_input: { command: 'crontab -e; grep -rn foo apps | head' },
        session_id: 's-test',
      },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * EI-22031870119269961 — a double-quoted grep/sed/awk pattern containing an
 * UNESCAPED $N or ${N} is a live shell expansion, not the literal digits the
 * pattern almost certainly meant. Positional parameters are normally unset
 * here, so it silently collapses to "" and the search reports a well-formed
 * ZERO-MATCH that reads exactly like "the code was rewritten/absent" — the
 * reported repro was `grep -n "...\$4::jsonb..."` losing its backslash
 * between JSON authoring and bash execution.
 */
describe('double-quoted $N pattern advisory (EI-22031870119269961)', () => {
  const bashWithInput = (tool_input: Record<string, unknown>, tool = 'Bash') => ({
    tool_name: tool,
    tool_input,
    session_id: 's-test',
  });

  const expectDollarDigitAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('double-quoted $N pattern advisory');
    expect(hso.additionalContext).toContain('ZERO-MATCH');
  };

  const expectNoDollarDigitAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    if (!out.stdout.trim()) return;
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow');
    expect(hso.additionalContext ?? '').not.toContain('double-quoted $N pattern advisory');
  };

  it('fires on the reported repro shape (bare $N, no escape)', () => {
    expectDollarDigitAdvisory(runGate(bashWithInput({ command: 'grep -n "foo$4::jsonb bar" file.ts' })));
  });

  it('fires on braced ${N}', () => {
    expectDollarDigitAdvisory(runGate(bashWithInput({ command: 'grep -n "foo${4}bar" file.ts' })));
  });

  it.each([
    ['egrep', 'egrep -n "foo$4bar" file.ts'],
    ['fgrep', 'fgrep -n "foo$4bar" file.ts'],
    ['rg', 'rg -n "foo$4bar" file.ts'],
    ['sed', 'sed -n "s/x/$4/" file.ts'],
    ['awk', 'awk "{print $4}" file.ts'],
  ])('fires for %s as well as grep', (_label, command) => {
    expectDollarDigitAdvisory(runGate(bashWithInput({ command })));
  });

  it('fires when an escaped backslash precedes a live $N (even backslash-run)', () => {
    // Bash text is: grep -n "foo\\$4bar" file.ts — TWO backslashes then $4.
    // `\\` decodes to one literal backslash; the $4 that follows is NOT
    // escaped by it and stays live.
    expectDollarDigitAdvisory(runGate(bashWithInput({ command: 'grep -n "foo\\\\$4bar" file.ts' })));
  });

  it('does not fire when $N is escaped with a single backslash (the safe form)', () => {
    // Bash text is: grep -n "foo\$4bar" file.ts — ONE backslash then $4,
    // which bash decodes to the literal characters `$4` — exactly the safe
    // form this advisory teaches the caller to use.
    expectNoDollarDigitAdvisory(runGate(bashWithInput({ command: 'grep -n "foo\\$4bar" file.ts' })));
  });

  it('does not fire when the pattern is single-quoted (always literal)', () => {
    expectNoDollarDigitAdvisory(runGate(bashWithInput({ command: "grep -n 'foo$4bar' file.ts" })));
  });

  it('does not fire for a named variable ($BAR, not a digit)', () => {
    expectNoDollarDigitAdvisory(runGate(bashWithInput({ command: 'grep -n "foo$BARbar" file.ts' })));
  });

  it('does not fire for a non-search command', () => {
    expectNoDollarDigitAdvisory(runGate(bashWithInput({ command: 'echo "foo$4bar"' })));
  });

  it('a deny gate still WINS over the $N pattern advisory', () => {
    const out = runGate(
      {
        tool_name: 'Bash',
        tool_input: { command: 'crontab -e; grep -n "foo$4bar" apps' },
        session_id: 's-test',
      },
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * EI-18764990059061608 — background-log-read-race advisory: reading a
 * background job's redirected-to-file output while the job is STILL WRITING
 * it is indistinguishable, at the read call, from the job having finished and
 * genuinely produced nothing — both look like an empty/short file. The
 * advisory only fires when a REAL process is still holding the tracked path
 * open (a live /proc fd scan), so these tests spawn a real short-lived
 * child that holds a log file's fd open to simulate "still running" —
 * exactly the liveness signal the hook itself checks.
 */
describe('background-log-read-race advisory (EI-18764990059061608)', () => {
  let raceHome = '';
  let logDir = '';

  beforeEach(() => {
    raceHome = mkdtempSync(join(tmpdir(), 'gate-race-home-'));
    mkdirSync(join(raceHome, '.papercusp'), { recursive: true });
    writeFileSync(join(raceHome, '.papercusp', 'superuser-token'), 'test-token\n');
    writeFileSync(join(raceHome, '.papercusp', 'su-agent-id'), 'test-agent\n');
    logDir = mkdtempSync(join(tmpdir(), 'gate-race-log-'));
  });

  afterEach(() => {
    rmSync(raceHome, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  const runRace = (payload: unknown) => runGate(payload, { HOME: raceHome });
  const bgCmd = (command: string, cwd: string, extra: Record<string, unknown> = {}) => ({
    tool_name: 'Bash',
    tool_input: { command, ...extra },
    session_id: 's-race',
    cwd,
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Holds `path` open for writing until killed — the liveness signal the
   *  advisory's /proc fd scan checks for. */
  function spawnOpenHolder(path: string) {
    // The second `exec` REPLACES the shell process with `sleep` (no fork) —
    // a plain `sleep 30 >&3` would fork a CHILD that inherits fd 3 and
    // outlives `holder.kill()` (which only signals the shell), leaving the
    // path open under an orphaned pid the "closed" tests never account for.
    return spawn('bash', ['-c', `exec 3>'${path}'; exec sleep 30 >&3`], { stdio: 'ignore' });
  }

  it('fires when the redirected file is still open by a live process', async () => {
    const log = join(logDir, 'still-running.log');
    const holder = spawnOpenHolder(log);
    try {
      await wait(300);
      expectAllow(runRace(bgCmd(`npx tsc --noEmit > ${log} 2>&1`, logDir, { run_in_background: true })));

      const out = runRace(bgCmd(`cat ${log}`, logDir));
      expect(out.status).toBe(0);
      const hso = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
      expect(hso.additionalContext).toContain('background-log-read-race advisory');
      expect(hso.additionalContext).toContain('still OPEN for writing');
      expect(hso.additionalContext).toContain(String(holder.pid));
    } finally {
      holder.kill();
    }
  });

  it('is silent once the writer has closed the file (the job actually finished)', async () => {
    const log = join(logDir, 'finished.log');
    const holder = spawnOpenHolder(log);
    await wait(300);
    expectAllow(runRace(bgCmd(`npx tsc --noEmit > ${log} 2>&1`, logDir, { run_in_background: true })));
    holder.kill();
    await wait(300); // let the fd actually close
    expectAllow(runRace(bgCmd(`cat ${log}`, logDir)));
  });

  it('is silent for a plain read with no tracked path', () => {
    expectAllow(runRace(bgCmd('cat /tmp/some-untracked-file-EI18764990059061608.log', logDir)));
  });

  it('does not fire on the very call that (re-)establishes the redirect (a write, not a read)', async () => {
    const log = join(logDir, 'rewrite.log');
    const holder = spawnOpenHolder(log);
    try {
      await wait(300);
      expectAllow(runRace(bgCmd(`npx tsc --noEmit > ${log} 2>&1`, logDir, { run_in_background: true })));
      expectAllow(runRace(bgCmd(`echo restart > ${log} 2>&1`, logDir, { run_in_background: true })));
    } finally {
      holder.kill();
    }
  });

  it('treats a Bash `&>` / `&>>` redirect as a WRITE, not a READ, of a tracked path (WI-2144525)', async () => {
    // Deterministic form of a host-state flake: `npm run lint:tsc &> /tmp/tsc.log`
    // in the shell-backgrounding suite drew this advisory on the gate box whenever
    // some unrelated real process held /tmp/tsc.log open, because `&>` was not
    // recognised as a redirect. Here a holder makes the path "still open" on purpose.
    const log = join(logDir, 'amp-redirect.log');
    const holder = spawnOpenHolder(log);
    try {
      await wait(300);
      expectAllow(runRace(bgCmd(`npx tsc --noEmit > ${log} 2>&1`, logDir, { run_in_background: true })));
      expectAllow(runRace(bgCmd(`npm run lint:tsc &> ${log}`, logDir)));
      expectAllow(runRace(bgCmd(`npm run lint:tsc &>> ${log}`, logDir)));
      expectAllow(runRace(bgCmd(`npm run lint:tsc &>${log}`, logDir)));
      // Control: a genuine READ of the same still-open path must STILL fire, or
      // the three silences above would pass vacuously.
      const out = runRace(bgCmd(`cat ${log}`, logDir));
      expect(JSON.parse(out.stdout).hookSpecificOutput.additionalContext).toContain(
        'background-log-read-race advisory',
      );
    } finally {
      holder.kill();
    }
  });

  it('still fires for a READ from a different tool_name than the one that backgrounded it', async () => {
    // Recording only happens for `run_in_background` (a Claude-Bash-only
    // concept), but the RACE is real regardless of which tool later reads the
    // path — a codex shell reading the same still-open file is just as blind.
    const log = join(logDir, 'cross-tool.log');
    const holder = spawnOpenHolder(log);
    try {
      await wait(300);
      expectAllow(runRace(bgCmd(`npx tsc --noEmit > ${log} 2>&1`, logDir, { run_in_background: true })));
      const out = runRace({ ...bgCmd(`cat ${log}`, logDir), tool_name: 'exec_command' });
      expect(out.status).toBe(0);
      const hso = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hso.additionalContext).toContain('background-log-read-race advisory');
    } finally {
      holder.kill();
    }
  });
});

/**
 * WI-5936 / EI-16611 — native background tasks die on carry-respawn.
 *
 * The knowledge existed on the READ path (compaction strategy, an insights doc)
 * and the mistake kept happening on the WRITE path, at the instant
 * `run_in_background: true` is typed. These cases pin the launch-time guard and
 * — more importantly — the `sid` stamp, which is the load-bearing half: the
 * ledger is host-shared and keyed by output PATH, so without an owner stamp the
 * compaction seam can see that *a* job is live but not WHOSE, and its whole
 * question is "is MY job about to be killed by this cut?".
 */
describe('native bg task dies on carry-respawn (WI-5936 / EI-16611)', () => {
  let bgHome = '';
  let bgDir = '';

  beforeEach(() => {
    bgHome = mkdtempSync(join(tmpdir(), 'gate-nativebg-home-'));
    mkdirSync(join(bgHome, '.papercusp'), { recursive: true });
    writeFileSync(join(bgHome, '.papercusp', 'superuser-token'), 'test-token\n');
    writeFileSync(join(bgHome, '.papercusp', 'su-agent-id'), 'test-agent\n');
    bgDir = mkdtempSync(join(tmpdir(), 'gate-nativebg-log-'));
  });

  afterEach(() => {
    rmSync(bgHome, { recursive: true, force: true });
    rmSync(bgDir, { recursive: true, force: true });
  });

  const runBg = (command: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) =>
    runGate(
      { tool_name: 'Bash', tool_input: { command, ...extra }, session_id: 's-nativebg', cwd: bgDir },
      // This suite is the one that TESTS the advisory, so it turns the
      // file-wide isolation pin back on.
      { HOME: bgHome, PAPERCUSP_SID: 'su-nativebg-test', PAPERCUSP_NATIVE_BG_ADVISORY: 'on', ...env },
    );

  it('fires a NON-BLOCKING teaching block on a LONG backgrounded run', () => {
    const out = runBg(`npm run test:affected > ${join(bgDir, 'a.log')} 2>&1`, {
      run_in_background: true,
    });
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    // Non-blocking is the contract: this teaches, it never denies.
    expect(hso.permissionDecision).toBe('allow');
    expect(hso.additionalContext).toContain('native background task advisory');
    expect(hso.additionalContext).toContain('capability:bash');
  });

  it('is SILENT for a short backgrounded command — only strandable jobs are worth teaching about', () => {
    // The proportionality rule. Fired on every backgrounded command, this
    // advisory broke 22 sibling tests that (correctly) assert silence here.
    expectAllow(runBg(`echo hello > ${join(bgDir, 'short.log')} 2>&1`, { run_in_background: true }));
    expectAllow(runBg(`sleep 60 > ${join(bgDir, 'sleep.log')} 2>&1`, { run_in_background: true }));
  });

  it('is SILENT for a long run with no redirect — nothing to track, nothing to prove live later', () => {
    // Keeps the launch advice and the cut-time detection over the SAME
    // population: an untracked job could never be named at the cut anyway.
    expectAllow(runBg('npm run test:affected', { run_in_background: true }));
  });

  it('respects the PAPERCUSP_NATIVE_BG_ADVISORY=off isolation switch', () => {
    expectAllow(
      runBg(`npm run test:affected > ${join(bgDir, 'off.log')} 2>&1`, { run_in_background: true }, {
        PAPERCUSP_NATIVE_BG_ADVISORY: 'off',
      }),
    );
  });

  it('stamps the OWNING SESSION on the ledger record (the half that makes it readable)', () => {
    const log = join(bgDir, 'stamped.log');
    runBg(`npm run test:affected > ${log} 2>&1`, { run_in_background: true });
    const ledger = JSON.parse(
      readFileSync(join(bgHome, '.papercusp', 'tracking', 'bg-output-tracking.json'), 'utf8'),
    );
    expect(ledger[log]).toBeTruthy();
    expect(ledger[log].sid).toBe('su-nativebg-test');
    expect(ledger[log].cmd).toBeUndefined();
    // started_at stays SECONDS — the operator-side reader converts. If this ever
    // becomes ms, native-bg-task-ledger.ts silently dates every record to 1970.
    expect(ledger[log].started_at).toBeLessThan(1e12);
  });

  it('migrates the legacy root-level ledger without copying command text', () => {
    const legacy = join(bgHome, '.papercusp', 'bg-output-tracking.json');
    const log = join(bgDir, 'legacy.log');
    const secret = 'Authorization: Bearer should-never-survive';
    writeFileSync(
      legacy,
      JSON.stringify({
        [log]: { started_at: Date.now() / 1000, sid: 'su-nativebg-test', cmd: `curl -H '${secret}' > ${log}` },
      }),
    );

    runBg(`npm run test:affected > ${join(bgDir, 'new.log')} 2>&1`, { run_in_background: true });

    const migratedPath = join(bgHome, '.papercusp', 'tracking', 'bg-output-tracking.json');
    const raw = readFileSync(migratedPath, 'utf8');
    const ledger = JSON.parse(raw);
    expect(existsSync(legacy)).toBe(false);
    expect(ledger[log]).toMatchObject({ sid: 'su-nativebg-test' });
    expect(ledger[log].cmd).toBeUndefined();
    expect(raw).not.toContain(secret);
  });

  it('is say-once per session — a second launch does not re-teach', () => {
    const first = runBg(`npm run test:affected > ${join(bgDir, 'b.log')} 2>&1`, {
      run_in_background: true,
    });
    expect(JSON.parse(first.stdout).hookSpecificOutput.additionalContext).toContain(
      'native background task advisory',
    );
    expectAllow(
      runBg(`npm run test:affected > ${join(bgDir, 'c.log')} 2>&1`, { run_in_background: true }),
    );
  });

  it('never fires for a FOREGROUND command — the job dies only because it is backgrounded', () => {
    expectAllow(runBg(`npm run test:affected > ${join(bgDir, 'd.log')} 2>&1`));
  });

  it('yields to a command-shape-specific bg advisory (a wrong RESULT outranks a general lesson)', () => {
    // `tee` is BOTH a tracked redirect target and an exit-code-masking stage, so
    // both advisories are genuinely eligible here — without that, this test
    // would pass trivially rather than proving precedence.
    const out = runBg(`npm run test:affected 2>&1 | tee ${join(bgDir, 'e.log')}`, {
      run_in_background: true,
    });
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.additionalContext).toContain('background-pipe exit-code advisory');
    expect(hso.additionalContext).not.toContain('native background task advisory');
  });
});

/**
 * EI-15605 — tauri-agent-tools raw-JSON --token advisory.
 *
 * The dev-bridge token file (/tmp/tauri-dev-bridge-<pid>.token) is JSON
 * (`{"port":N,"token":"...","pid":N}`), not a bare token string. Piping its
 * raw content straight into `--token` silently fails auth even though the
 * token itself is correct inside that JSON. Soft advisory only (never a
 * deny) — the CLI is third-party/global, so we cannot fix its own error
 * message; this just saves the failed-attempt detour.
 */
describe('tauri-agent-tools raw-JSON --token advisory (EI-15605)', () => {
  const expectTokenAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('tauri-agent-tools --token advisory');
    expect(hso.additionalContext).toContain('is JSON');
  };

  it('fires on the inline raw-cat repro (`--token "$(cat …/*.token)"`)', () => {
    expectTokenAdvisory(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token "$(cat /tmp/tauri-dev-bridge-1234.token)" 'document.title'`)),
    );
  });

  it('fires on an unquoted inline raw-cat substitution', () => {
    expectTokenAdvisory(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token $(cat /tmp/tauri-dev-bridge-1234.token) 'x'`)),
    );
  });

  it('fires on the assign-then-use form (TOK=$(cat …/*.token); … --token "$TOK")', () => {
    expectTokenAdvisory(
      runGate(
        bashCmd(
          'TOK=$(cat /tmp/tauri-dev-bridge-1234.token)\n' +
            `tauri-agent-tools eval --port 46423 --token "$TOK" 'x'`,
        ),
      ),
    );
  });

  it('silent when the value is already extracted via jq', () => {
    expectAllow(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token "$(jq -r .token /tmp/tauri-dev-bridge-1234.token)" 'x'`)),
    );
  });

  it('silent when the value is already extracted via node/JSON.parse', () => {
    expectAllow(
      runGate(
        bashCmd(
          `tauri-agent-tools eval --port 46423 --token "$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).token)' /tmp/tauri-dev-bridge-1234.token)" 'x'`,
        ),
      ),
    );
  });

  it('silent for a plain bare token value (the correct usage)', () => {
    expectAllow(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token tok-abc123 'x'`)),
    );
  });

  it('silent when --token is absent (auto-discovery / --pid usage)', () => {
    expectAllow(runGate(bashCmd(`tauri-agent-tools probe`)));
  });

  it('silent for a cat on a non-.token file', () => {
    expectAllow(
      runGate(bashCmd(`tauri-agent-tools eval --port 46423 --token "$(cat /tmp/some-other-file.txt)" 'x'`)),
    );
  });

  it('a deny gate (e.g. the target guard) still wins over the token advisory', () => {
    // No --pid and no bridges live: the target guard itself allows here (per
    // its own "nothing to hit" rule), so assert the DECISION is allow — this
    // just confirms the advisory path never OVERRIDES a deny when one fires.
    // (Covered structurally: deny() calls sys.exit(0) before this block runs.)
    const out = runGate(
      bashCmd('crontab -e'),
      AGENT,
    );
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

/**
 * EI-18664655909328670 — shell-write file-target guard.
 *
 * Raw shell writes to tree files (`cat >>`, `echo >`, `tee`, `sed -i`, `cp`)
 * bypass the Edit/Write PreToolUse hooks entirely: no file lock is claimed,
 * and if the session cwd has silently drifted the write does not error — it
 * silently CREATES a stray file (repro'd live 2026-07-25: an agent appended
 * via `cat >> tools/conversations-list.test.ts` believing cwd was a package
 * subdir; cwd had drifted to the repo root, which also has a `tools/`, so
 * the redirect silently created a stray file there instead of erroring).
 *
 * UNCONDITIONAL like the exit-guard: it keys on the resolved TARGET path
 * resolving inside the canonical tree, not on the agent marker or cwd, so
 * every test below explicitly asserts this fires with NO agent marker too.
 */
describe('shell-write guard: `#` comments are not shell syntax (EI-19385448516432576)', () => {
  // A `->`/`=>`/`>` inside a comment is PROSE. Because this guard rejects the
  // WHOLE command, a false positive here means nothing in the call ran — the
  // agent then works around it, so the cost is silent and recurring. This was
  // one of at least five filed false-positive reports against this guard.
  it('allows the filed repro: an arrow inside a trailing `#` comment', () => {
    // Keep the search operand real so this test isolates shell-comment parsing;
    // the separate false-absence guard must still reject a missing `bar.ts`.
    writeFileSync(join(CANON, 'bar.ts'), 'foo\n');
    expectAllow(
      runGate(bashCmd('grep -n foo bar.ts # payload->x is the field', { cwd: CANON }), CANON_ENV),
    );
  });

  it('allows a comment that merely TALKS about redirecting into the tree', () => {
    expectAllow(
      runGate(bashCmd('ls -la # writes > apps/operator/x.txt someday', { cwd: CANON }), CANON_ENV),
    );
  });

  it('still denies a real redirect that happens to be followed by a comment', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > apps/operator/generated.ts # log it', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('EI-18664655909328670');
    expect(reason).toContain('apps/operator/generated.ts');
  });

  /**
   * ORDER REGRESSION GUARD. Comment-stripping MUST run after quote-stripping.
   * Reversed, the `#` inside the quoted string would be treated as a comment
   * introducer and swallow the rest of the line — including the REAL redirect —
   * turning a false positive into a false NEGATIVE (a missed tree write), which
   * is the far more expensive direction for this guard. If someone reorders the
   * pipeline, this test fails instead of the hole opening silently.
   */
  it('still denies when a `#` appears inside a quoted argument before a real redirect', () => {
    const reason = denyReason(
      runGate(bashCmd('echo "x # y" > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  it('still denies when a URL fragment `#` precedes a real redirect', () => {
    const reason = denyReason(
      runGate(bashCmd('curl http://h/p#frag > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  /**
   * THE CASE THE FILED REPORTS ACTUALLY HIT — EI-19418179098729784,
   * EI-19417957171220978, EI-19323309702408274 — and the reason all three name
   * the wrong cause. Each blamed the construct sitting next to the `>`: the SQL
   * idiom `> now()`, or an `=>` arrow in `node -e`. Driven against the real
   * hook, every one of those verbatim commands ALLOWS, and has since
   * quote-stripping landed in `_shell_write_guard` on 2026-07-26 — so the filed
   * root cause ("the guard scans raw text without accounting for quoting
   * context") is disproven.
   *
   * The actual trigger is an ODD number of quote characters inside the `#`
   * COMMENT. That breaks quote parity in `_strip_shell_quotes`, which then
   * deletes the span running from the comment's stray quote up to the OPENING
   * quote of the real argument — leaving a genuinely-quoted `>` exposed to the
   * redirect scan. Reproduced against the INSTALLED hook: denied naming target
   * `now`, byte-for-byte the reported symptom. Remove the comment, or balance
   * its quotes, and the same command allows.
   *
   * A comment is the only possible source: bash itself refuses a command whose
   * quotes are unbalanced OUTSIDE a comment, so any command that actually ran
   * is balanced everywhere else. That is why this reads as random false
   * positives on ordinary commands, and why a reconstructed repro never
   * reproduces — the comment is the part people drop when writing the ticket.
   *
   * The sibling FALSE NEGATIVE of the same parity break is EI-19420133701663526,
   * fixed by collapsing the two passes into one quote-aware scanner and covered
   * by the two tests below.
   */
  it('allows a quoted `>` when a `#` comment contains an odd quote (the filed repro)', () => {
    expectAllow(
      runGate(
        bashCmd(
          '# count rows in the "tool_invocations table\n'
            + 'psql -Atc "SELECT count(*) FROM t WHERE invoked_at > now() - interval \'2 min\'"',
          { cwd: CANON },
        ),
        CANON_ENV,
      ),
    );
  });

  /**
   * THE FALSE NEGATIVE — EI-19420133701663526, the expensive twin of the false
   * positive above. Same root cause (quote parity broken by a stray quote in a
   * `#` comment), opposite and far worse consequence: a REAL tree write is
   * ALLOWED.
   *
   * Mechanism, for `# note "` + newline + `cat foo > <tree path> && echo "x"`:
   * quote-stripping ran FIRST, so it read the comment's stray `"` as an opening
   * quote and paired it with the `"` before `x` — deleting everything between
   * them. That span contains the newline AND the entire redirect, so what
   * reached the redirect scanner was a single comment line, which
   * comment-stripping then removed outright. Nothing was left to match, so the
   * guard allowed a raw shell write into the shared tree.
   *
   * Reproduced against the INSTALLED hook before the fix: ALLOW here, DENY for
   * the identical command with the comment removed.
   *
   * Both quote characters are tested. The filed report named only `"`; driving
   * the real hook showed `'` breaks parity identically, so a fix verified on
   * `"` alone would have left half the hole open.
   */
  it('still denies a real tree redirect when a `#` comment contains an odd double quote', () => {
    const reason = denyReason(
      runGate(
        bashCmd('# note "\ncat foo > apps/operator/generated.ts && echo "x"', { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  it('still denies a real tree redirect when a `#` comment contains an odd single quote', () => {
    const reason = denyReason(
      runGate(
        bashCmd("# don't\ncat foo > apps/operator/generated.ts && echo 'x'", { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  it('does not treat `$#` or an infix `a#b` as a comment introducer', () => {
    // Both must remain visible to the scanner: neither starts a comment in bash,
    // and over-stripping here would hide a following real redirect.
    const reason = denyReason(
      runGate(bashCmd('echo $# a#b > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });
});

/**
 * THE THIRD QUOTE-PARITY BREAK — EI-23804564629952456. Same family as the `#`
 * comment break above, different source, and the one the filed report got
 * wrong in a way worth pinning.
 *
 * A command substitution RESTARTS shell quoting: inside `"…$(cmd "arg")…"`, the
 * quotes around `arg` open a FRESH string, they do not close the outer one. The
 * normalizer scanned flatly to the next `"`, so it picked the wrong terminator
 * and INVERTED the quoted/unquoted classification for the rest of the span —
 * quoted data exposed to every matcher, live shell text blanked.
 *
 * WHAT THE REPORT GOT WRONG, and why these tests are shaped the way they are.
 * The report's stated mechanism was "the SQL lived inside a double-quoted
 * `psql -c "…"` argument, so quote-stripping exposes its `>`", and its stated
 * repro was that bare command. Driven against the real hook that command
 * ALLOWS — plain quoted spans have been blanked correctly all along — so the
 * mechanism is disproven and the repro does not reproduce. The trigger is
 * specifically the NESTED form: the `$( )` must sit inside an outer
 * double-quoted string. The first two tests pin that distinction, because a
 * fix aimed at the reported mechanism would change nothing at all.
 *
 * THE DIRECTION THE REPORT MISSED. The same inversion also hides a REAL
 * `> <tree path>` written inside `$( )` inside `"…"`, while the identical
 * redirect in a BARE `$( )` is caught — a silent hole in the one guard that
 * keeps raw shell writes out of the shared tree, and the far more expensive
 * half. Both directions are one root cause and are fixed together by treating
 * a substitution as a nested context and normalizing its interior.
 *
 * Backticks are the same construct with older syntax and broke identically;
 * a fix verified on `$( )` alone would have left half the hole open, so both
 * spellings are covered.
 */
describe('command-substitution quote-parity break — CLASS recurrence guard (EI-23804564629952456)', () => {
  const SQL = "SELECT count(*) FROM t WHERE closed_at > now() - interval '15 minutes'";

  it('allows the filed repro: a SQL `>` inside $( ) nested in a double-quoted string', () => {
    expectAllow(
      runGate(bashCmd(`echo "closed=$(psql -Atc "${SQL}")"`, { cwd: CANON }), CANON_ENV),
    );
  });

  it('allows the backtick spelling of the same nesting', () => {
    expectAllow(
      runGate(bashCmd(`echo "closed=\`psql -Atc "${SQL}"\`"`, { cwd: CANON }), CANON_ENV),
    );
  });

  /**
   * NEGATIVE CONTROL for the report's own claim. If this ever starts failing,
   * the guard has regressed into the mechanism the report described — and the
   * two tests above would no longer be measuring the nesting at all.
   */
  it("allows the report's stated repro, which never reproduced (mechanism control)", () => {
    expectAllow(runGate(bashCmd(`psql -Atc "${SQL}"`, { cwd: CANON }), CANON_ENV));
  });

  it('allows a SQL `>` in $( ) that is NOT inside a double-quoted string', () => {
    expectAllow(runGate(bashCmd(`f=$(psql -Atc "${SQL}")`, { cwd: CANON }), CANON_ENV));
  });

  /**
   * THE FALSE NEGATIVE — the expensive twin, and the half the report never
   * found. A real tree write inside a substitution inside double quotes was
   * ALLOWED before this fix.
   */
  it('still denies a real tree redirect inside $( ) nested in a double-quoted string', () => {
    const reason = denyReason(
      runGate(
        bashCmd('echo "out=$(cat foo > apps/operator/generated.ts)"', { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  it('still denies a real tree redirect inside backticks nested in a double-quoted string', () => {
    const reason = denyReason(
      runGate(
        bashCmd('echo "out=`cat foo > apps/operator/generated.ts`"', { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  /**
   * CALIBRATION. The same redirect in a bare substitution was always caught;
   * if this ever fails the suite is broken rather than the nesting fixed, so
   * the two denials above cannot pass vacuously.
   */
  it('still denies a real tree redirect inside a bare $( )', () => {
    const reason = denyReason(
      runGate(bashCmd('echo out=$(cat foo > apps/operator/generated.ts)', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  /**
   * The plain quoted span must still be inert. Widening the normalizer to
   * recurse into substitutions must not start surfacing ordinary quoted prose,
   * which is the false-positive class this whole normalizer exists to prevent.
   */
  it('still treats an ordinary quoted `>` as inert data', () => {
    expectAllow(runGate(bashCmd('echo "a > b" && ls', { cwd: CANON }), CANON_ENV));
  });

  it('still denies a real redirect that follows a nested substitution', () => {
    const reason = denyReason(
      runGate(
        bashCmd('echo "n=$(wc -l < in.txt)" > apps/operator/generated.ts', { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });

  /**
   * An unbalanced `$(` and an unpaired backtick must degrade to the previous
   * behaviour rather than dropping the rest of the input — dropping would be a
   * silent ALLOW, which is the direction that costs.
   */
  it('still denies a real tree redirect after an unbalanced `$(`', () => {
    const reason = denyReason(
      runGate(
        bashCmd('echo "cost me $(a" ; cat foo > apps/operator/generated.ts', { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('apps/operator/generated.ts');
  });
});

describe('mcp-call inline JSON quoting guard (EI-26073319721581332)', () => {
  it('denies positional JSON whose apostrophe leaves the shell quote open', () => {
    const command = `node scripts/mcp-call.mjs loop:checkpoint '{"note":"it's safe"}' --client su-test`;
    const out = runGate(bashCmd(command), CANON_ENV);
    expect(out.status).toBe(0);
    const decision = parseDecision(out);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('EI-26073319721581332');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('--json -');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('--json-file');
  });

  it('allows the quoted-stdin heredoc form for the same apostrophe payload', () => {
    const command = `node scripts/mcp-call.mjs loop:checkpoint --json - <<'JSON'\n{"note":"it's safe"}\nJSON`;
    expectAllow(runGate(bashCmd(command), CANON_ENV));
  });

  it.each([
    ['the documented flag order', 'node scripts/mcp-call.mjs improvements:capture --json - --client su-test --port 3170'],
    ['client before the JSON flag', 'node scripts/mcp-call.mjs improvements:capture --client su-test --port 3170 --json -'],
    ['the JSON flag after the heredoc redirection', 'node scripts/mcp-call.mjs improvements:capture --client su-test --port 3170 <<\'JSON\' --json -'],
  ])('allows %s when the JSON body mentions the mcp-call marker', (_label, prefix) => {
    const body = '{"body":"Recovery evidence mentions node scripts/mcp-call.mjs improvements:capture, but contains no shell quote."}';
    const command = prefix.includes("<<'JSON'")
      ? `${prefix}\n${body}\nJSON`
      : `${prefix} <<'JSON'\n${body}\nJSON`;
    expectAllow(runGate(bashCmd(command), CANON_ENV));
  });

  it('allows a positional JSON payload without shell-hostile prose', () => {
    const command = `node scripts/mcp-call.mjs loop:checkpoint '{"note":"safe"}' --client su-test`;
    expectAllow(runGate(bashCmd(command), CANON_ENV));
  });
});

describe('shell-write file-target guard (EI-18664655909328670)', () => {
  const expectShellWriteDeny = (out: { stdout: string; status: number | null }) => {
    const reason = denyReason(out);
    expect(reason).toContain('EI-18664655909328670');
    expect(reason).toMatch(/Edit or Write/);
    return reason;
  };

  it('denies the exact cwd-drift repro: `cat >> file <<EOF` whose target resolves inside the canonical tree', () => {
    const command = "cat >> tools/conversations-list.test.ts <<'EOF'\nsome appended content\nEOF";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('tools/conversations-list.test.ts');
    expect(reason).toMatch(/shell redirect \(`>>`\)/);
  });

  it('denies a plain `echo > file` redirect into the tree', () => {
    expectShellWriteDeny(
      runGate(bashCmd('echo hi > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
    );
  });

  it('allows a quoted ASCII arrow instead of treating its `>` as a redirect', () => {
    expectAllow(
      runGate(bashCmd('echo "=> x"', { cwd: CANON }), CANON_ENV),
    );
  });

  it('allows the exact unquoted JavaScript arrow-function repro in node --eval', () => {
    const command = `node -e "import('./scripts/check-declared-consumed.mjs').then(m=>console.log(Object.keys(m).join(' ')))"`;
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows an unquoted JavaScript >= comparison in node --eval', () => {
    expectAllow(runGate(bashCmd('node -e "console.log(1 >= 0)"', { cwd: CANON }), CANON_ENV));
  });

  /**
   * EI-19301210652900510 — a quoted expansion with a path suffix is still an
   * unresolved redirect operand, not an empty span. If quote normalization
   * erases `"$BAD/superuser-token"`, the same-line scanner borrows the next
   * bare word (`timeout`) as the target and falsely denies an out-of-tree
   * scratch write. The newline-separated form is the exact filed command;
   * the adjacent form pins the normalization failure that originally named
   * `timeout`.
   */
  it.each([
    [
      'the exact filed newline-separated timeout/env command',
      'BAD=$(mktemp -d); echo "not-the-real-token" > "$BAD/superuser-token"\n'
        + 'timeout 8 env HOME="$BAD" ... node apps/operator/lib/mcp-proxy/watchdog.mjs >/dev/null 2>&1',
    ],
    [
      'same-line text after the unresolved redirect operand',
      'BAD=$(mktemp -d); echo "not-the-real-token" > "$BAD/superuser-token" '
        + 'timeout 8 env HOME="$BAD" ... node apps/operator/lib/mcp-proxy/watchdog.mjs >/dev/null 2>&1',
    ],
  ])('allows %s without naming the neighboring command word', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('denies `tee` writing into the tree', () => {
    const reason = expectShellWriteDeny(
      runGate(bashCmd('echo hi | tee apps/operator/foo.txt', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(/`tee`/);
  });

  it('does not treat a tee heredoc input redirection as its destination', () => {
    const command = "sudo -n tee /etc/systemd/system/papercusp-sni-bypass.service >/dev/null <<'UNIT'\n"
      + '[Unit]\nDescription=probe\nUNIT';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('still denies the real tee destination when a heredoc feeds it', () => {
    const command = "tee apps/operator/foo.txt <<'UNIT'\ncontent\nUNIT";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/foo.txt');
    expect(reason).toMatch(/`tee`/);
  });

  it('denies `sed -i` editing a tree file in place', () => {
    const reason = expectShellWriteDeny(
      runGate(bashCmd("sed -i 's/a/b/' apps/operator/foo.ts", { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(/`sed -i`/);
  });

  it('denies `cp` copying a file into the tree', () => {
    const reason = expectShellWriteDeny(
      runGate(bashCmd('cp /tmp/x.ts apps/operator/foo.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(/`cp`/);
  });

  it('allows a `cp` substring in an argument filename instead of treating the later port as its destination', () => {
    const command =
      "cat > /tmp/wi40939-cp-addendum.json <<'EOF'\n{}\nEOF\n"
      + 'node scripts/mcp-call.mjs work_items:checkpoint '
      + '--json-file /tmp/wi40939-cp-addendum.json '
      + '--client su-830bbb98-6e38-4c2d-b780-537abe520690 --port 3170';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * EI-20090210551302164 — Prettier's in-place modes bypass the Edit/Write
   * hooks just like the older shell-write constructs above. The filed command
   * was `npx prettier --write` against GoalDetailPanel.test.tsx; keep that
   * exact target and the supported executable wrappers pinned here so a future
   * parser narrowing cannot silently reopen one spelling of the same bypass.
   */
  describe('Prettier in-place writes (EI-20090210551302164)', () => {
    const TARGET = 'apps/operator/app/adv/hud/GoalDetailPanel.test.tsx';

    it('denies the exact filed `npx prettier --write` repro', () => {
      const reason = expectShellWriteDeny(
        runGate(bashCmd(`npx prettier --write ${TARGET}`, { cwd: CANON }), CANON_ENV),
      );
      expect(reason).toContain('`prettier --write`/`-w`');
      expect(reason).toContain(TARGET);
    });

    it('denies Prettier’s short `-w` alias', () => {
      const reason = expectShellWriteDeny(
        runGate(bashCmd(`prettier -w ${TARGET}`, { cwd: CANON }), CANON_ENV),
      );
      expect(reason).toContain(TARGET);
    });

    it.each([
      ['pnpm exec', `pnpm exec prettier --write ${TARGET}`],
      ['yarn exec', `yarn exec prettier --write ${TARGET}`],
      ['yarn dlx', `yarn dlx prettier --write ${TARGET}`],
      ['bunx', `bunx prettier --write ${TARGET}`],
      ['an explicit executable path', `./node_modules/.bin/prettier --write ${TARGET}`],
    ])('denies %s when it targets a tree file', (_label, command) => {
      const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
      expect(reason).toContain(TARGET);
    });

    it('does not mistake a read-only `--config` path for a write target', () => {
      expectAllow(
        runGate(
          bashCmd(
            `prettier --write --config packages/operator-core/.prettierrc.json /tmp/prettier-probe.ts`,
            { cwd: CANON },
          ),
          CANON_ENV,
        ),
      );
    });

    it('does not mistake a read-only `--stdin-filepath` value for a write target', () => {
      expectAllow(
        runGate(
          bashCmd(`prettier --write --stdin-filepath ${TARGET}`, { cwd: CANON }),
          CANON_ENV,
        ),
      );
    });

    it.each([
      ['without `--write`', `npx prettier --check ${TARGET}`],
      ['with an out-of-tree target', 'npx prettier --write /tmp/prettier-probe.ts'],
    ])('allows Prettier %s', (_label, command) => {
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });
  });

  /**
   * EI-20511008504632401 — an unconfigured whole-file check against the
   * legacy release helpers reports pre-existing drift and invites broad
   * `--write` churn during a focused repair. Keep the guard scoped to that
   * subtree, while allowing an explicit formatter config and unrelated checks.
   */
  describe('Prettier checks on release helpers (EI-20511008504632401)', () => {
    const TARGETS = [
      'apps/operator/lib/release/gitignored-asset-coverage.ts',
      'apps/operator/lib/release/gitignored-asset-coverage.test.ts',
      'apps/operator/lib/release/setup-release-checkout-workspace-builds.test.ts',
    ];
    const targetList = TARGETS.join(' ');

    it('denies the filed unconfigured release-helper check before execution', () => {
      const reason = denyReason(
        runGate(bashCmd(`npx prettier --check ${targetList}`, { cwd: CANON }), CANON_ENV),
      );
      expect(reason).toContain('EI-20511008504632401');
      expect(reason).toContain(TARGETS[0]);
      expect(reason).toContain('git diff --check');
      expect(reason).toContain('hunk-scoped formatter check');
      expect(reason).toContain('NOTHING in this Bash call ran');
    });

    it('allows a release-helper check with an explicit formatter config', () => {
      expectAllow(
        runGate(
          bashCmd(
            `npx prettier --check --config packages/operator-core/.prettierrc.json ${TARGETS[0]}`,
            { cwd: CANON },
          ),
          CANON_ENV,
        ),
      );
    });

    it('allows checks outside the release-helper subtree', () => {
      expectAllow(
        runGate(
          bashCmd('npx prettier --check apps/operator/lib/psu-launcher.test.ts', { cwd: CANON }),
          CANON_ENV,
        ),
      );
    });
  });

  it('fires WITH NO agent marker at all — unconditional, like the exit-guard', () => {
    expectShellWriteDeny(runGate(bashCmd('echo hi >> apps/operator/foo.txt', { cwd: CANON }), CANON_ENV));
  });

  it.each([
    ['redirect to /tmp (outside the tree)', 'echo hi > /tmp/scratch-out.txt'],
    ['append outside the tree', 'echo hi >> /tmp/notes.txt'],
    ['recursive `cp -r` (directory copy — no single-file substitute)', 'cp -r /tmp/somedir apps/operator/somedir'],
    ['`cp -a` archive copy (same recursive exemption)', 'cp -a /tmp/somedir apps/operator/somedir'],
    ['fd-duplication `2>&1` is not a file target', 'npm run build > /tmp/out.log 2>&1'],
    ['arithmetic `>=` comparison is not a redirect', '(( a >= b ))'],
    ['a quoted `>` inside a string is not a real redirect', 'echo "a > b was found"'],
    ['a quoted `tee`-looking string is not an invocation', 'echo "please tee up the report"'],
    ['a plain read-only command', 'git status'],
    ['a redirect target using shell expansion is left alone (fail-open)', 'echo hi >> "$SOME_DIR/file.txt"'],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * EI-18741479132591597 — filed repro claimed the guard mis-attributed a
   * quoted-variable redirect target to the leading wrapper word (`setsid`)
   * for a detached-launch idiom (`setsid nohup ... > "$LOG" 2>&1 < /dev/null &`),
   * denying a legitimate write to an explicit /tmp path. Could not reproduce
   * against the current guard — `_resolve_write_target`'s literal-only check
   * (any `$`/backtick/`~`/glob in the raw target bails, per the existing
   * "shell expansion is left alone" case above) already fails this open
   * regardless of the leading wrapper words, and cwd never enters into it
   * since resolution never happens for an expansion-bearing target. Locking
   * in the EXACT filed shape (multiple leading wrappers + a `cd`/assignment
   * preamble + backgrounding) as its own regression rather than relying on
   * the simpler existing case to imply it.
   */
  it('allows the setsid/nohup detached-launch repro with a quoted $VAR redirect target (EI-18741479132591597)', () => {
    const command =
      'cd papercusp-desktop\n' +
      'LOG=/tmp/wi760-fedproof4.log\n' +
      'setsid nohup bin/vm-federation.sh --vms=2 --dht=testnet --net=bridge > "$LOG" 2>&1 < /dev/null &';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('does not fire when the resolved target is OUTSIDE the canonical tree even with a relative path', () => {
    expectAllow(runGate(bashCmd('cat >> notes.txt <<EOF\nhi\nEOF', { cwd: '/tmp/outside-canonical' }), CANON_ENV));
  });

  it('a deny gate still wins over anything else that would allow (structural: deny() exits before further checks)', () => {
    const out = runGate(bashCmd('cat >> apps/operator/foo.ts <<EOF\nx\nEOF', { cwd: CANON }), CANON_ENV);
    expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
  });

  /**
   * EI-18683619680591304 — heredoc-body comparison/arrow operators are DATA,
   * not shell redirects. Repro'd live 2026-07-26: a heredoc'd python one-liner
   * doing `if v>100` was denied as if `100` were a redirect target resolving
   * inside the shared tree (the guard scanned the heredoc BODY for `>` tokens
   * with no awareness it was inside a heredoc at all).
   */
  it('allows a comparison operator inside a heredoc python script (`v>100`) — the exact repro', () => {
    const command =
      "python3 - <<'PY'\n" +
      'per = {"a": 50, "b": 150}\n' +
      'print(sum(1 for v in per.values() if v>100))\n' +
      'PY';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it.each([
    ['a bare `>` comparison (`x > y`)', 'if x > y:'],
    ['a fat-arrow (`=>`)', 'const f = (x) => x + 1;'],
    ['a thin-arrow (`->`)', 'def f(x) -> int:'],
    ['a `>=` comparison', 'if v >= 100:'],
    ['a real filename-looking token following `>`', 'echo "not a redirect: report.txt > 5"'],
  ])('allows heredoc body text containing %s', (_label, bodyLine) => {
    const command = `cat <<'EOF'\n${bodyLine}\nEOF`;
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('an UNQUOTED heredoc delimiter body is stripped the same way', () => {
    const command = 'node <<EOF\nconsole.log(1 > 2 ? "a" : "b");\nEOF';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('a genuine redirect on the heredoc START line still denies (the strip only removes the BODY)', () => {
    const command = "cat >> apps/operator/generated.ts <<'PY'\nprint(1 > 2)\nPY";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/generated.ts');
  });

  it('a real redirect AFTER a heredoc closes still denies (text past the terminator is not swallowed)', () => {
    const command = "cat <<'EOF'\nharmless body\nEOF\necho hi > apps/operator/after-heredoc.ts";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/after-heredoc.ts');
  });

  it('a bare numeric target with NO heredoc at all is still not treated as a path (looks-like-a-path heuristic)', () => {
    // `(( v>100 ))` arithmetic — quote-stripping never touches this, so the
    // looks-like-a-path check is the only thing standing between this and a
    // false deny; already covered structurally by the existing `(( a >= b ))`
    // allow-case above, this asserts the un-`=`-suffixed `>100` form too.
    expectAllow(runGate(bashCmd('echo $(( 1 > 100 ))', { cwd: CANON }), CANON_ENV));
  });

  /**
   * EI-23394109515758945 — the raw redirect scan also sees the body of a
   * command substitution. Quote stripping removes PostgreSQL JSON keys from
   * an unquoted psql expression, leaving `payload-> -> ->>`; the `>` in the
   * first arrow was then read as a redirect targeting `-`. Only the SQL
   * operators are ignored: a genuine redirect in the same substitution must
   * continue to hit the shell-write guard.
   */
  it('allows PostgreSQL JSON `->`/`->>` operators inside a nested psql substitution', () => {
    const command =
      "value=$(psql -Atc SELECT payload->'observation'->'gradingAudit'->>'state' FROM records)";
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('still denies a genuine tree redirect inside a nested psql substitution', () => {
    const command =
      "value=$(psql -Atc SELECT payload->'observation'->>'state' FROM records > apps/operator/generated.ts)";
    const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/generated.ts');
  });

  /**
   * EI-18691980588797795 — a command substitution whose LITERAL TEXT contains
   * a space defeats the naive `.split()` that every token-based leg (`tee`,
   * `sed -i`, `perl -i`/`ruby -i`, `cp`) uses to find its target(s): the
   * substitution splits across SEVERAL tokens, and the fragments left behind
   * (`prefix)/dest.txt`, `rev-parse`, or an unquoted `s/a/b/` script now read
   * as the last positional) carry none of the expansion markers — dollar,
   * backtick, tilde, glob — that make `_resolve_write_target` bail. Resolved
   * against a cwd INSIDE the canonical tree (the exact situation this guard
   * exists for), any such fragment trivially starts with the canonical root,
   * so the guard FALSE-DENIES a command that never targeted the tree at all.
   *
   * Every case below is a verified regression: DENY against the pre-fix
   * script, ALLOW against the fixed one.
   */
  it.each([
    [
      '`cp` whose DEST is built from a substitution with an internal space (the filed repro)',
      'cp /tmp/x.txt $(npm prefix)/dest.txt',
    ],
    [
      '`cp` whose substitution tail also looks like a flag',
      'cp /tmp/x.txt $(git rev-parse --show-toplevel)/notes.txt',
    ],
    ['`tee` target built from a substitution with an internal space', 'echo hi | tee $(npm prefix)/out.log'],
    ['`sed -i` target built from a substitution with an internal space', 'sed -i s/a/b/ $(npm prefix)/foo.ts'],
    [
      '`perl -i` target built from a substitution with an internal space',
      'perl -i -pe s/a/b/ $(npm prefix)/foo.ts',
    ],
    ['the backtick spelling of the same substitution', 'sed -i s/a/b/ `npm prefix`/foo.ts'],
  ])('allows %s (fail-open on an unsplittable expansion)', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('the expansion fail-open is scoped to the expansion — a LITERAL tree target in the same construct still denies', () => {
    // Guards the fix against over-relaxing into "any `cp`/`sed -i`/`tee` is
    // fine": only a segment actually carrying a substitution skips detection.
    for (const command of [
      'cp /tmp/x.ts apps/operator/foo.ts',
      "sed -i 's/a/b/' apps/operator/foo.ts",
      'echo hi | tee apps/operator/foo.txt',
    ]) {
      expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    }
  });

  /**
   * EI-19966359020779598 — the filed bug: a BARE `$VAR` target (no parens, no
   * backtick — so `_segment_has_unsplittable_expansion` above does NOT skip
   * it) reaches `_resolve_write_target`, which bails on the `$` the same way
   * it bails on any expansion marker, and until this fix that was fully
   * silent — no deny, no signal at all, for an in-place rewrite that may be
   * mutating dozens of tracked files with zero lock claimed. Repro'd live,
   * both directions, in the SAME session: the literal-path form of this exact
   * edit was correctly denied; the `$FILES`-multi-path form of it sailed
   * through and wrote 24 tracked source files.
   *
   * This does NOT deny (a bare variable gives the guard nothing to prove
   * lands in-tree — denying here would reopen this file's own documented
   * false-positive history) — it now surfaces the gap as a non-blocking
   * advisory instead of silence, the same shape as the interpreter guard's
   * computed-path advisory (EI-18828866497684686).
   */
  function expectShellWriteAdvisory(out: { stdout: string; status: number | null }) {
    expect(out.status).toBe(0);
    const decision = parseDecision(out);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow'); // soft — never blocks
    const ctx = (decision.hookSpecificOutput as { additionalContext?: string }).additionalContext ?? '';
    expect(ctx).toContain('EI-19966359020779598');
    return ctx;
  }

  it.each([
    ['the exact filed repro: `sed -i` against a bare multi-path `$FILES` variable', "sed -i 's/bm25/lexical/g' $FILES"],
    ['the two-statement filed shape: `FILES=$(...)` assigned, THEN referenced bare in `sed -i`',
      "FILES=$(ls libs/generic/search/src/*.ts | grep -v provenance.ts)\nsed -i 's/bm25/lexical/g' $FILES"],
    ['`perl -i` against a bare `$FILES` variable', "perl -i -pe 's/a/b/' $FILES"],
    ['`tee` against a bare `$OUT` variable', 'echo hi | tee $OUT'],
    ['`cp` where BOTH source and dest are bare variables', 'cp $SRC $DEST'],
  ])('allows %s (with the shell-write-guard bare-variable advisory — no longer fully silent)', (_label, command) => {
    const ctx = expectShellWriteAdvisory(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(ctx).toContain('shell-write guard notice');
  });

  it('advises for a quoted loop-variable target instead of silently allowing the rewrite', () => {
    const command =
      "cd packages/operator-core/lib/bash-substitution/pairs && " +
      "for f in ambient-context.ts logs.ts; do sed -i 's/a/b/' \"$f\"; done";
    const ctx = expectShellWriteAdvisory(
      runGate(bashCmd(command, { cwd: CANON }), CANON_ENV),
    );
    expect(ctx).toContain('variable-driven target list');
    expect(ctx).toContain('shell variable');
  });

  it('the bare-variable advisory is scoped to the in-place-rewrite family — a plain `>`/`>>` redirect to a bare $VAR stays fully silent (unchanged)', () => {
    // Deliberately NOT advised: `> "$LOG"`/`>> $LOG` is the overwhelmingly
    // common "write a computed scratch/log path" idiom, and this guard has a
    // long documented history of false-positive incidents from guessing at
    // expansion-bearing targets. Scoping the new advisory to
    // sed-i/perl-i/ruby-i/awk-i-inplace/tee/cp (never a bare redirect) keeps
    // that idiom exactly as quiet as it always was.
    expectAllow(runGate(bashCmd('echo hi >> $LOGFILE', { cwd: CANON }), CANON_ENV));
  });

  it('the bare-variable advisory never fires for the ALREADY-hardened $(...)/backtick shape (unchanged, still fully silent)', () => {
    // EI-18691980588797795's fix (tested above) deliberately skips target
    // detection ENTIRELY for a `$(...)`/backtick segment — a substitution's
    // literal text can contain a space that defeats the `.split()` these
    // constructs use, so there is no safe signal to raise here at all. This
    // fix must not reopen that: it only ever looks at `_targets`, and a
    // `$(...)`/backtick segment never reaches `_targets` in the first place.
    for (const command of [
      'sed -i s/a/b/ $(npm prefix)/foo.ts',
      'sed -i s/a/b/ `npm prefix`/foo.ts',
    ]) {
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    }
  });

  it('the bare-variable advisory does not mask an existing deny — a LITERAL tree target alongside a bare $VAR still denies (masking control)', () => {
    expectShellWriteDeny(
      runGate(bashCmd("sed -i 's/a/b/' apps/operator/foo.ts $FILES", { cwd: CANON }), CANON_ENV),
    );
  });

  /**
   * WI-6026 (EI-18664655909328670, 3rd instance) — a trailing REDIRECT used
   * to silence output (`cmd ... 2>/dev/null`, `cmd ... > out.log`) defeats
   * the same naive `.split()` as the substitution-fragment bug above, but in
   * the opposite direction: instead of a stray fragment reading as an
   * in-tree target, the redirect token ITSELF gets treated as the
   * `cp`/`tee`/`sed -i`/`perl -i` destination. Repro'd live 2026-07-26:
   *
   *   cp file-read.cat-file.sample.json /tmp/.../fx-backup-catfile.json 2>/dev/null
   *
   * was denied, naming `2>/dev/null` itself as the "target ... inside the
   * shared staging tree" — the give-away that the guard's own parse was
   * wrong, since the real destination was an absolute `/tmp` path nowhere
   * near the tree. `cmd ... 2>/dev/null` is an extremely common idiom, so
   * this denied a broad class of legitimate out-of-tree writes.
   */
  it.each([
    ['`cp` with a combined stderr-silencing redirect (the filed repro)', 'cp file.json /tmp/x/out.json 2>/dev/null'],
    ['`cp` with both streams silenced (combined + fd-dup forms)', 'cp file.json /tmp/x/out.json >/dev/null 2>&1'],
    ['`cp` with a split-token redirect (`> FILE` as two tokens)', 'cp file.json /tmp/x/out.json > /tmp/x/log.txt'],
    ['`tee` with a trailing stderr redirect', 'echo hi | tee /tmp/x/out.txt 2>/dev/null'],
    ["`sed -i` with a trailing stderr redirect", "sed -i 's/a/b/' /tmp/x/foo.ts 2>/dev/null"],
    ['`perl -i` with a trailing stderr redirect', "perl -i -pe 's/a/b/' /tmp/x/foo.ts 2>/dev/null"],
  ])('allows %s (the redirect token is not the destination)', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('the redirect strip is scoped to the redirect — a LITERAL tree target alongside a silenced redirect still denies (masking control)', () => {
    // Load-bearing per the same discipline as the substitution-fragment fix:
    // stripping a token before positional analysis must not hide a genuine
    // in-tree destination sitting right next to it.
    for (const command of [
      'cp /tmp/a.txt in-tree.txt 2>/dev/null',
      "sed -i 's/a/b/' in-tree.txt 2>/dev/null",
      'echo hi | tee in-tree.txt 2>/dev/null',
    ]) {
      expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    }
  });

  /**
   * EI-18760311552821358 — `docker cp` to a CONTAINER destination
   * (`<container>:<path>`) false-denied. The `\bcp\b` scan matches the `cp`
   * inside `docker cp` too, and its destination positional (`container:/path`)
   * is not a host path at all — `_resolve_write_target` was joining it against
   * cwd like any relative path, and when cwd sits inside the canonical tree
   * (the exact situation this guard exists to protect) that trivially
   * resolves to a path under the tree root, producing a false deny on a
   * command that can never touch the host tree at that argument position.
   */
  it.each([
    [
      'the exact filed repro: `docker cp local.sh container:/tmp/c.sh && docker exec ...`',
      'docker cp /tmp/wi6210-check.sh pcusp-rig-a:/tmp/c.sh && docker exec pcusp-rig-a bash /tmp/c.sh',
    ],
    ['a bare `docker cp` to a container destination', 'docker cp /tmp/x.sh my-container:/tmp/x.sh'],
    ['the symmetric container-source form (still not a host path token)', 'docker cp my-container:/tmp/x.sh /tmp/x.sh'],
  ])('allows %s (container ref is not a host path)', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('a genuine in-tree `cp` destination right next to a `docker cp` invocation still denies (the exemption is scoped to container refs, not to `cp` generally)', () => {
    expectShellWriteDeny(runGate(bashCmd('cp /tmp/x.ts apps/operator/foo.ts', { cwd: CANON }), CANON_ENV));
  });

  /**
   * EI-18763270524857214 — a `cd <dir>` earlier in the SAME compound command
   * changes the cwd every LATER relative target actually resolves against.
   * The guard used to resolve every target against the session's STARTING
   * cwd regardless, so the sanctioned "build a scratch probe in /tmp" idiom
   * (`cd /tmp/probe && ... > relative.md`) got told its target "resolves
   * INSIDE the shared staging tree" as flat, stated fact — filed by an agent
   * doing the CAREFUL thing (deliberately building outside the tree) whom the
   * guard sent hunting a cwd-drift bug that never happened.
   */
  describe('cd-tracking (EI-18763270524857214)', () => {
    it('allows the exact filed repro: a heredoc write to a relative path after `cd /tmp/...`', () => {
      const command =
        'set -e\n' +
        'rm -rf /tmp/idlint-probe; mkdir -p /tmp/idlint-probe\n' +
        'cd /tmp/idlint-probe\n' +
        'git init -q .\n' +
        "cat > probe.md <<'EOF'\n" +
        'hello\n' +
        'EOF';
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });

    it('allows a simple `cd /tmp/x && printf ... > relative-name` idiom', () => {
      expectAllow(runGate(bashCmd('cd /tmp/x && printf hi > relative-name.txt', { cwd: CANON }), CANON_ENV));
    });

    it('allows a `;`-separated `cd` (not just `&&`)', () => {
      expectAllow(runGate(bashCmd('cd /tmp/x; echo hi > relative-name.txt', { cwd: CANON }), CANON_ENV));
    });

    it('allows a MULTI-cd chain that walks out of the tree via relative `cd ..`', () => {
      // CANON = /ws/papercupai-workspace/papercusp — two `cd ..` walks land
      // at /ws, well outside the tree, before the relative redirect.
      expectAllow(runGate(bashCmd('cd .. && cd .. && echo hi > escaped.txt', { cwd: CANON }), CANON_ENV));
    });

    it('still denies when there is NO preceding cd (the original guard behavior, unaffected)', () => {
      expectShellWriteDeny(runGate(bashCmd('echo hi > apps/operator/foo.txt', { cwd: CANON }), CANON_ENV));
    });

    it('still denies when a `cd` moves INTO a tree subdirectory (the tracking correctly keeps it in-tree)', () => {
      const reason = expectShellWriteDeny(
        runGate(bashCmd('cd apps/operator && echo hi > foo.txt', { cwd: CANON }), CANON_ENV),
      );
      expect(reason).toContain('foo.txt');
    });

    it('still denies a genuine in-tree write when `cd` appears only as ORDINARY TEXT, not a real invocation (`echo cd ...`)', () => {
      // "cd" here is an argument to `echo`, not a statement of its own — must
      // NOT be folded into the replayed cwd as if it really changed directory.
      expectShellWriteDeny(
        runGate(bashCmd('echo "please cd to /tmp first" && cat > apps/operator/foo.ts', { cwd: CANON }), CANON_ENV),
      );
    });

    it('still denies when `cd`s target is a shell expansion the replay cannot resolve (fails safe to the original cwd)', () => {
      expectShellWriteDeny(
        runGate(bashCmd('cd $SOME_DIR && cat > apps/operator/foo.ts', { cwd: CANON }), CANON_ENV),
      );
    });

    it('is inert (falls back to original behavior) when the command contains a paren — a subshell-scoped `cd` must not leak out', () => {
      // `(cd /tmp/x && true)` only changes cwd INSIDE the subshell in a real
      // shell; cwd is back to CANON by the time the real redirect runs. This
      // replay has no paren-depth tracking, so it must sit out entirely
      // rather than risk folding the subshell's cd into the outer cwd and
      // turning a genuine in-tree write into a false allow.
      const reason = expectShellWriteDeny(
        runGate(bashCmd('(cd /tmp/x && true); cat > apps/operator/foo.ts', { cwd: CANON }), CANON_ENV),
      );
      expect(reason).toContain('foo.ts');
    });
  });

  /**
   * EI-18899608047558048 — a fully-quoted redirect target crossing into the
   * NEXT STATEMENT was misread as that statement's first token.
   *
   * `_strip_shell_quotes` replaces an ENTIRE quoted span with a single blank
   * space, with no marker that anything was ever there. So `: > "$OUT"`
   * leaves nothing after the `>` but trailing whitespace on that line, and
   * the old `\s*` gap between the operator and its target happily crossed
   * the following newline to grab the first token of the NEXT statement —
   * `URL=` from an unrelated assignment, or `done` closing a loop — and named
   * it, with full confidence, as a write resolving inside the shared tree.
   * Both filed shapes reproduced live against the pre-fix guard.
   */
  describe('cross-line redirect-target misattribution (EI-18899608047558048)', () => {
    it('allows the exact filed Shape A repro: a quoted $VAR redirect target followed by an unrelated assignment', () => {
      const command = 'OUT=/tmp/wi6569-cold.jsonl; : > "$OUT"\n' + "URL='http://127.0.0.1:33700/adv?x=1'";
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });

    it('allows the exact filed Shape B repro: an append inside a loop, target on the line before `done`', () => {
      const command = 'for x in 1; do\n' + 'printf x >> "$OUT"\n' + 'done';
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });

    /**
     * EI-19333253837331724 — the same cross-line misattribution, filed independently
     * against the pre-fix guard as "the guard reports the redirect target as `nohup`".
     * The reporter's own hypothesis (a `nohup` COMMAND PREFIX shifts the redirect-target
     * extractor) does not match how the guard actually works — it is regex-based, not a
     * positional argv walk, and `nohup` is never treated as a prefix by the shell-write
     * guard's target scan at all. Reproducing the pre-fix guard directly (a local revert
     * of the `[^\S\n]*` fix back to `\s*`) confirms the REAL mechanism is exactly
     * EI-18899608047558048: the EARLIER `: > "$LOG"` redirect (not the later `nohup ...
     * >> "$LOG"` one) had its fully-quoted target blanked to nothing, and the old `\s*`
     * gap crossed the newline to grab `nohup` — the first token of the FOLLOWING
     * statement — as if it were that redirect's own target. Already fixed by the same
     * same-line-whitespace restriction Shape A/B cover above; this case is kept as its
     * own test because the captured token ("nohup") is a real command name, which is
     * exactly the shape a future regression here would be easiest to misdiagnose again.
     */
    it('allows the exact filed EI-19333253837331724 repro: a quoted $VAR redirect immediately followed by a `nohup ...` statement', () => {
      const command =
        'cd ' +
        CANON +
        '\n' +
        'LOG=/tmp/docs-build-opencode-omp.log\n' +
        ': > "$LOG"\n' +
        "nohup ./scripts/pc-heavy.sh -- bash -c 'cd apps/operator-docs && npm run build' >> \"$LOG\" 2>&1 &";
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });

    it('does not cross a `;`-separated statement on the SAME line either', () => {
      const command = ': > "$OUT"; URL=http://example.com';
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });

    it('a genuine same-line unquoted in-tree redirect still denies (the fix does not weaken same-line detection)', () => {
      const reason = expectShellWriteDeny(
        runGate(bashCmd('echo hi > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
      );
      expect(reason).toContain('apps/operator/generated.ts');
    });

    it('a genuine same-line unquoted in-tree redirect immediately followed by another statement still denies', () => {
      const command = 'echo hi > apps/operator/generated.ts\ntrue';
      const reason = expectShellWriteDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
      expect(reason).toContain('apps/operator/generated.ts');
    });
  });
});

/**
 * EI-18691482279179647 — interpreter inline-code write guard.
 *
 * The shell-write guard above only recognizes SHELL write constructs
 * (`>`/`>>`, `tee`, `sed -i`, `cp`). An interpreter invoked with inline code
 * (`python3 -c`, `node -e`, or a `python3 - <<EOF … EOF` heredoc script) does
 * its own file I/O — invisible to shell-redirect detection — and sailed
 * straight through with no lock claimed and no worktree validation
 * (self-caught live 2026-07-26 rewriting a tree file via a heredoc'd python
 * script). Also covers the `perl -i`/`ruby -i` in-place-flag half, added as
 * a new leg on the existing shell-write guard's target extraction.
 */
/**
 * RELATIVE target + a `cd` the guard cannot follow (EI-20106159536811878, WI-7219,
 * EI-18800669297694465, EI-19372138838008750, EI-18700825865251498, EI-18898365995336025).
 *
 * ONE defect, reported six times over six weeks and fixed none of those times.
 * The guard resolves a relative target against the SESSION cwd whenever it cannot
 * follow a `cd`, then reports it as "resolves INSIDE the shared staging tree" —
 * a true statement about the string it computed and a false one about where the
 * write lands. Every reporter concluded the guard was broken rather than that
 * their path needed to be absolute, because the text never mentions cwd, `cd`,
 * or relativity.
 *
 * Two halves, and they fail differently, so they are tested separately:
 *  - what CANNOT be known statically (`cd "$T"`) must still refuse, but must say
 *    WHY and name the one-line fix. That is a MESSAGE contract.
 *  - what CAN be known (`cd /literal/path`) must be followed rather than refused.
 *    That is a BEHAVIOR contract, and it is WI-7219 proper: the redirect guard has
 *    replayed `cd` for weeks while the interpreter guard beside it never did.
 */
describe('relative target after an unfollowable `cd` (EI-20106159536811878 / WI-7219)', () => {
  // The verbatim repro from the filing: the out-of-tree falsifiability probe
  // CLAUDE.md prescribes. Its paths are repo-SHAPED on purpose — the probe has to
  // mirror the real layout for the guard under test to behave realistically — so
  // this is the normal shape of the careful thing, not an exotic one.
  const FILED_REPRO = [
    'T=$(mktemp -d /tmp/strand-falsify-XXXXXX) || exit 1',
    'cd "$T" || exit 1',
    'mkdir -p packages/operator-core/lib',
    "printf 'export interface A { id: string }\\n' > packages/operator-core/lib/a.ts",
  ].join('\n');

  it('still DENIES the filed repro — the policy is right and is not being weakened', () => {
    const reason = denyReason(runGate(bashCmd(FILED_REPRO, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('EI-18664655909328670');
  });

  it('names relativity, the unfollowed `cd`, and the absolute-path fix', () => {
    const reason = denyReason(runGate(bashCmd(FILED_REPRO, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('RELATIVE');
    expect(reason).toContain('could not follow');
    expect(reason).toContain('ABSOLUTE target');
    // The remedy has to be actionable against THIS target, not generic advice.
    expect(reason).toContain('packages/operator-core/lib/a.ts');
  });

  /**
   * The note must never quote the `cd` argument back. `cd "$T"` reaches the guard
   * as the operator debris `||` — quote-stripping blanked the whole span — so
   * printing "the cd argument" would print a confidently wrong token, which is
   * this file's oldest and most expensive failure mode.
   */
  it('does not quote the cd argument back (it is operator debris by this point)', () => {
    const reason = denyReason(runGate(bashCmd(FILED_REPRO, { cwd: CANON }), CANON_ENV));
    expect(reason).not.toMatch(/could not follow \(`?\|\|/);
    expect(reason).not.toContain('`||`');
  });

  it('stays silent about cwd when there is no `cd` at all — no spurious excuse', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > apps/operator/generated.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('EI-18664655909328670');
    expect(reason).not.toContain('THIS IS MOST LIKELY THE WHOLE PROBLEM');
  });

  it('stays silent for an ABSOLUTE in-tree target — relativity is not the story there', () => {
    const reason = denyReason(
      runGate(bashCmd(`cd "$T" && echo hi > ${CANON}/apps/operator/generated.ts`, { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('EI-18664655909328670');
    expect(reason).not.toContain('THIS IS MOST LIKELY THE WHOLE PROBLEM');
  });

  // WI-7219 proper — the BEHAVIOR half. A literal `cd` out of the tree means the
  // write lands outside it in fact, not merely in the string, so allowing it is
  // correct. The redirect guard already did this; the interpreter guard did not.
  it('follows a LITERAL cd out of the tree before an INTERPRETER write (WI-7219)', () => {
    expectAllow(
      runGate(
        bashCmd(`cd /tmp/pc-scratch-probe && python3 -c "open('out.txt','w').write('x')"`, {
          cwd: CANON,
        }),
        CANON_ENV,
      ),
    );
  });

  /**
   * WI-7219's VERBATIM repro, kept in its original shape on purpose: a NEWLINE
   * statement separator (not `&&`) and a multi-line quoted body. Closing that item
   * on a paraphrase would leave its actual reported case untested.
   */
  it('allows WI-7219\'s exact reported repro (newline-separated cd, multi-line body)', () => {
    expectAllow(
      runGate(
        bashCmd(`cd /tmp\npython3 -c "\nopen('somefile.json', 'w').write('x')\n"`, { cwd: CANON }),
        CANON_ENV,
      ),
    );
  });

  it('still denies an interpreter write into the tree when NO cd moved us out', () => {
    const reason = denyReason(
      runGate(
        bashCmd(`python3 -c "open('apps/operator/generated.ts','w').write('x')"`, { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('EI-18691482279179647');
  });

  it('explains itself on the INTERPRETER path too, not just the redirect path', () => {
    const reason = denyReason(
      runGate(
        bashCmd(`cd "$T" && python3 -c "open('apps/operator/generated.ts','w').write('x')"`, {
          cwd: CANON,
        }),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toContain('RELATIVE');
    expect(reason).toContain('ABSOLUTE target');
  });
});

/**
 * A tree path used as a READ (a require/import specifier) must not trip the write
 * guard (EI-18898365995336025). Requiring a module FROM the tree while writing
 * scratch OUT of it is the normal shape of an ad-hoc probe — bundle a lib to test
 * it in isolation, extract a fixture, dump a projection — and the guard's own
 * advice ("write it outside the tree — /tmp") is unhelpful to a command already
 * writing to /tmp.
 *
 * These are the reporter's two verbatim repros, kept as regression pins. The
 * narrowing that fixes them (EI-18814109122347052: only WRITE-CALL ARGUMENT spans
 * are candidates, so a `require(...)` specifier is never scanned) landed for a
 * different report and was never pinned against THESE commands, so nothing stopped
 * a future widening of the candidate scan from silently reopening them.
 */
/**
 * A heredoc script whose every target is absolute and under /tmp must not be denied
 * on a NON-PATH fragment of its own source text (EI-18800669297694465,
 * EI-18700825865251498).
 *
 * Both reporters were shown a confidently-worded verdict naming something that is
 * not a path at all — `wrote /tmp/promote-substitution-tiers.mts` (the argument of a
 * `print()`) and ` in ln: ln = ln.replace(` (a fragment of a for-loop body). As both
 * pointed out, the message then closed by advising them to "write it outside the tree
 * (/tmp)", which is exactly what the blocked script already did. A guard whose refusal
 * describes the thing you just did teaches agents to route around it.
 *
 * Kept as verbatim regression pins: the two narrowings that fixed these (whitespace
 * tokenizing of each literal, and scanning only write-call argument spans) were filed
 * for OTHER symptoms and never tested against these commands.
 */
describe('non-path source fragments are not write targets (EI-18800669297694465 / EI-18700825865251498)', () => {
  it('allows a /tmp heredoc write whose print() mentions the same path (EI-18800669297694465)', () => {
    const command = [
      "cd /tmp && python3 - <<'EOF'",
      "open('/tmp/promote-substitution-tiers.mts','w').write('x')",
      'print("wrote /tmp/promote-substitution-tiers.mts")',
      'EOF',
    ].join('\n');
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows a /tmp heredoc write alongside loop-body code fragments (EI-18700825865251498)', () => {
    const command = [
      "python3 - <<'EOF'",
      "for ln in ['a','b']:",
      "    if 'x' in ln: ln = ln.replace('a','b')",
      "open('/tmp/wi5980-live/fixture-differs.log','w').write('x')",
      'EOF',
    ].join('\n');
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  // Negative control: the same heredoc shape aimed INTO the tree must still deny, so
  // the two allows above cannot be satisfied by a guard that stopped scanning heredocs.
  it('still denies a heredoc write whose target IS in the tree', () => {
    const command = [
      "python3 - <<'EOF'",
      "print('wrote /tmp/decoy.txt')",
      "open('apps/operator/generated.ts','w').write('x')",
      'EOF',
    ].join('\n');
    const reason = denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toContain('apps/operator/generated.ts');
  });
});

describe('read-only tree references do not trip the write guard (EI-18898365995336025)', () => {
  it('allows an absolute /tmp write from a cwd inside the tree (repro 1)', () => {
    expectAllow(
      runGate(
        bashCmd(
          `node -e "const fs=require('fs'); fs.writeFileSync('/tmp/egress-probe/wv-bundle.js', 'x')"`,
          { cwd: CANON },
        ),
        CANON_ENV,
      ),
    );
  });

  it('allows requiring a module FROM the tree while writing to /tmp (repro 2)', () => {
    expectAllow(
      runGate(
        bashCmd(
          `cd /tmp/egress-probe && node -e "const esbuild = require('${CANON}/node_modules/esbuild'); const fs=require('fs'); fs.writeFileSync('/tmp/egress-probe/wv-bundle.js', 'text')"`,
          { cwd: CANON },
        ),
        CANON_ENV,
      ),
    );
  });

  it('allows read-only Python Path references to repo files alongside a /tmp write', () => {
    const command = [
      'python3 - <<\'PY\'',
      'from pathlib import Path',
      "Path('apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh').read_bytes()",
      "Path('apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts').read_bytes()",
      "Path('packages/operator-core/lib/code-intelligence/reuse-source-population.ts').stat()",
      "Path('packages/operator-core/lib/session-port/cleanup.ts').read_bytes()",
      "Path('/tmp/ei-26745732189410562-readonly-source-probe.json').write_text('{}')",
      'PY',
    ].join('\n');
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('still denies an in-tree Path target held in a variable when sibling Path references are read-only', () => {
    const command = [
      'python3 - <<\'PY\'',
      'from pathlib import Path',
      "Path('packages/operator-core/lib/code-intelligence/reuse-source-population.ts').read_bytes()",
      "target = Path('apps/operator/generated.ts')",
      "target.write_text('x')",
      "Path('/tmp/ei-26745732189410562-readonly-source-probe.json').write_text('{}')",
      'PY',
    ].join('\n');
    const reason = denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toContain('apps/operator/generated.ts');
  });

  // The guard must still catch the thing it exists for: the SAME shape, but with
  // the write itself aimed into the tree. Without this, the two allows above could
  // be satisfied by a guard that had simply stopped working.
  it('still denies when the WRITE target itself is in the tree', () => {
    const reason = denyReason(
      runGate(
        bashCmd(
          `node -e "const esbuild = require('${CANON}/node_modules/esbuild'); const fs=require('fs'); fs.writeFileSync('apps/operator/generated.ts', 'text')"`,
          { cwd: CANON },
        ),
        CANON_ENV,
      ),
    );
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toContain('apps/operator/generated.ts');
  });
});

/**
 * EI-19372138838008750 — the guard's own remediation was unfollowable for the
 * single most common scratch case on this repo.
 *
 * It denied every in-tree write and advised "~/.papercusp/scratch or /tmp". But a
 * tsx/node probe that IMPORTS repo modules cannot run from either: resolution
 * walks up from the FILE's directory and neither has a repo `node_modules` above
 * it (measured 2026-08-10 — a probe under `~/.papercusp/scratch` dies with
 * MODULE_NOT_FOUND). `<tree>/.papercusp/scratch/` is the one location that both
 * resolves imports AND is gitignored, so git-sync can never commit it.
 *
 * The negative controls below matter as much as the allows: two passing allows
 * are equally consistent with a guard that has stopped working entirely.
 */
describe('sanctioned in-tree scratch exemption (EI-19372138838008750)', () => {
  const scratchRemedy = /\.papercusp\/scratch\/` INSIDE/;
  const uniqueExternalScratchRemedy = /per-session\/task-unique directory/;
  const nestedScratchRepo = (ignoreInNestedRoot: boolean) => {
    const outer = mkdtempSync(join(tmpdir(), 'gate-scratch-outer-'));
    const root = join(outer, 'apps', 'nested-app');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(outer, '.gitignore'), '**/.papercusp/scratch/\n');
    execFileSync('git', ['init', '--quiet'], { cwd: outer, stdio: 'ignore' });
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
    if (ignoreInNestedRoot) {
      writeFileSync(join(root, '.gitignore'), '**/.papercusp/scratch/\n');
    }
    return { root, cleanup: () => rmSync(outer, { recursive: true, force: true }) };
  };

  it('ALLOWS a shell redirect into <tree>/.papercusp/scratch/', () => {
    expectAllow(
      runGate(bashCmd('echo hi > .papercusp/scratch/probe-out.log', { cwd: CANON }), CANON_ENV),
    );
  });

  it('ALLOWS the absolute-path form of the same target', () => {
    expectAllow(
      runGate(bashCmd(`echo hi > ${CANON}/.papercusp/scratch/probe-out.log`, { cwd: CANON }), CANON_ENV),
    );
  });

  it('ALLOWS an interpreter write into <tree>/.papercusp/scratch/ (the tsx-probe case)', () => {
    expectAllow(
      runGate(
        bashCmd(`python3 -c "open('.papercusp/scratch/probe-out.txt','w')"`, { cwd: CANON }),
        CANON_ENV,
      ),
    );
  });

  it('allows scratch writes ignored by their nested Git root', () => {
    const repo = nestedScratchRepo(true);
    try {
      const env = { ...CANON_ENV, PAPERCUSP_CANONICAL_TREE: repo.root };
      expectAllow(
        runGate(
          bashCmd('echo hi > .papercusp/scratch/probe.mts', { cwd: repo.root }),
          env,
        ),
      );
    } finally {
      repo.cleanup();
    }
  });

  it('denies scratch writes ignored only by the parent Git root', () => {
    const repo = nestedScratchRepo(false);
    try {
      const env = { ...CANON_ENV, PAPERCUSP_CANONICAL_TREE: repo.root };
      const reason = denyReason(
        runGate(
          bashCmd('echo hi > .papercusp/scratch/probe.mts', { cwd: repo.root }),
          env,
        ),
      );
      expect(reason).toContain('not ignored in the Git repository that owns it');
    } finally {
      repo.cleanup();
    }
  });

  // NEGATIVE CONTROLS — the exemption must be strictly-under, never a prefix match.
  it('still DENIES an ordinary source path (the guard is not disabled)', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > packages/operator-core/lib/evil.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('EI-18664655909328670');
  });

  it('still DENIES a near-miss sibling `.papercusp/scratchpad/` (prefix, not a child)', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > .papercusp/scratchpad/x.log', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('EI-18664655909328670');
  });

  it('still DENIES `.papercusp/` itself outside the scratch subdir', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > .papercusp/config.json', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('EI-18664655909328670');
  });

  // The message half: a denied agent must be told where it CAN write.
  it('names the in-tree scratch location in the shell-redirect deny', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > packages/operator-core/lib/evil.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(scratchRemedy);
  });

  // EI-19304149823089876 asked for this explicitly: the working mechanism was
  // never named at the point of failure, so the message routed agents toward the
  // two paths that cannot work.
  it('names `code:run` as the other working route for a repo-importing probe', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > packages/operator-core/lib/evil.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toContain('code:run');
  });

  it('requires external scratch paths to be unique instead of reusing bare /tmp names', () => {
    const reason = denyReason(
      runGate(bashCmd('echo hi > packages/operator-core/lib/evil.ts', { cwd: CANON }), CANON_ENV),
    );
    expect(reason).toMatch(uniqueExternalScratchRemedy);
    expect(reason).toContain('never reuse a bare shared `/tmp` filename');
    expect(reason).toContain('concurrent agents can overwrite it');
  });

  it('names the in-tree scratch location in the interpreter-write deny', () => {
    const reason = denyReason(
      runGate(
        bashCmd(`python3 -c "open('packages/operator-core/lib/evil.ts','w')"`, { cwd: CANON }),
        CANON_ENV,
      ),
    );
    expect(reason).toMatch(scratchRemedy);
  });
});

describe('interpreter inline-code write guard (EI-18691482279179647)', () => {
  const expectInterpDeny = (out: { stdout: string; status: number | null }) => {
    const reason = denyReason(out);
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toMatch(/Edit or Write/);
    return reason;
  };

  it('denies the exact repro: a python3 heredoc script writing a literal tree path via open(...)', () => {
    const command =
      "python3 - <<'EOF'\n" +
      "s2 = open('apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts').read()\n" +
      "open('apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts', 'w').write(s2)\n" +
      'EOF';
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/scripts/hooks/cc/__tests__/bash-resource-gate.test.ts');
    expect(reason).toContain('python3');
  });

  it('denies `python3 -c "..."` with an inline literal tree-path write', () => {
    const command = `python3 -c "open('apps/operator/generated.ts', 'w').write('x')"`;
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * EI-19327302389409134 — the guard denied `sed -i` on a tree file, then MINUTES
   * LATER allowed (only advised, non-blocking) the semantically identical hazard
   * spelled as `p = 'tree/path'; open(p, 'w')` — the path assigned to a variable
   * one line above the write call, instead of written inline as a literal
   * argument. Being refused for one spelling and waved through for the other
   * reads as positive confirmation that the variable form is the sanctioned
   * workaround — exactly backwards from what the refusal is meant to teach.
   */
  describe('interpreter write via a variable holding a literal tree path (EI-19327302389409134)', () => {
    it('denies the exact repro: `p = "path"` then `open(p, "w")` in a heredoc', () => {
      const command =
        "python3 - <<'PY'\n" +
        "p='apps/operator/app/_components/chat/SessionChatModal.test.tsx'\n" +
        "s=open(p).read()\n" +
        "open(p,'w').write(s)\n" +
        'PY';
      const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
      expect(reason).toContain('apps/operator/app/_components/chat/SessionChatModal.test.tsx');
      expect(reason).toContain('python3');
    });

    it('denies the same shape via `python3 -c "..."` (single-line assignment then write)', () => {
      const command = `python3 -c "p='apps/operator/generated.ts'\nopen(p,'w').write('x')"`;
      expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });

    it('never DENIES the variable form when the assigned literal resolves OUTSIDE the tree — falls back to the existing computed-path advisory, same as any other bare-identifier write argument', () => {
      // The write call's own first argument is still a bare identifier (`p`), so
      // the PRE-EXISTING computed-path advisory (EI-18828866497684686) still fires
      // regardless of what the new variable-indirection resolution found — this
      // leg only ever ADDS a deny for a proven in-tree hit, it never SILENCES the
      // advisory that already covers "I can't fully verify this argument".
      const command = `python3 -c "p='/tmp/scratch.txt'\nopen(p,'w').write('x')"`;
      const out = runGate(bashCmd(command, { cwd: CANON }), CANON_ENV);
      expect(out.status).toBe(0);
      const hso = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hso.permissionDecision).toBe('allow');
      expect(hso.additionalContext).toContain('EI-18828866497684686');
    });

    it('allows a variable assigned an in-tree literal that is only ever READ, never written', () => {
      const command = `python3 -c "p='apps/operator/generated.ts'\nprint(open(p).read())"`;
      expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    });

    it('does not treat a dict-key assignment (`d[\'x\'] = \'path\'`) as a tracked variable — stays in the existing computed-path handling, no false DENY', () => {
      const command = `python3 -c "d={}\nd['x']='apps/operator/generated.ts'\nopen(d['x'],'w').write('z')"`;
      const out = runGate(bashCmd(command, { cwd: CANON }), CANON_ENV);
      // Must not be THIS guard's deny — `d['x']` is not a bare identifier, so the
      // variable-indirection leg does not fire (matches the pre-existing behavior
      // for any non-bare-identifier first argument).
      if (out.stdout.trim()) {
        expect(denyReason(out)).not.toContain('EI-19327302389409134');
      }
    });

    it('still only ADVISES (never denies) a genuinely computed path that never touched a literal assignment', () => {
      const command = `python3 -c "open(sys.argv[1], 'w')" "$SOME_PATH"`;
      const out = runGate(bashCmd(command, { cwd: CANON }), CANON_ENV);
      expect(out.status).toBe(0);
      const hso = JSON.parse(out.stdout).hookSpecificOutput;
      expect(hso.permissionDecision).toBe('allow');
      expect(hso.additionalContext).toContain('EI-18828866497684686');
    });
  });

  it('denies `node -e "..."` with fs.writeFileSync targeting a literal tree path', () => {
    const command = `node -e "require('fs').writeFileSync('apps/operator/generated.ts', data)"`;
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('node');
  });

  it('allows node writes whose concatenated absolute prefix is outside the tree', () => {
    const command =
      "node -e \"const D='" + join(fakeHome, '.papercusp', 'scratch', 'su-4d323') + "/'; " +
      "const fs=require('fs'); fs.writeFileSync(D+'identity-kernel-precache-ledger-2026-09-26.json','{}')\"";
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows a HOME-based out-of-tree prefix concatenated with a filename', () => {
    const command =
      "node -e \"const D=process.env.HOME+'/.papercusp/perf-baselines/'; " +
      "const fs=require('fs'); fs.writeFileSync(D+'identity-kernel-precache-ledger.json','{}')\"";
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('still denies an absolute in-tree prefix concatenated with a filename', () => {
    const command =
      "node -e \"const D='" + CANON + "/apps/operator/'; " +
      "const fs=require('fs'); fs.writeFileSync(D+'generated.ts','x')\"";
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows path.join when its statically known absolute prefix is outside the tree', () => {
    const command =
      "node -e \"const D='" + join(fakeHome, '.papercusp', 'scratch', 'su-4d323') + "/'; " +
      "const fs=require('fs'); const path=require('path'); " +
      "fs.writeFileSync(path.join(D,'identity-kernel-precache-ledger.json'),'{}')\"";
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('denies `perl -i` editing a tree file in place (the in-place-flag leg, same as `sed -i`)', () => {
    const out = runGate(bashCmd("perl -i -pe 's/a/b/' apps/operator/foo.pl", { cwd: CANON }), CANON_ENV);
    const reason = denyReason(out);
    expect(reason).toContain('EI-18664655909328670');
    expect(reason).toMatch(/perl -i.*ruby -i/);
  });

  it('denies `ruby -i` editing a tree file in place', () => {
    const out = runGate(bashCmd("ruby -i.bak -pe 'gsub!(/a/,\"b\")' apps/operator/foo.rb", { cwd: CANON }), CANON_ENV);
    expect(denyReason(out)).toContain('EI-18664655909328670');
  });

  /**
   * EI-18809538554039853. The in-place legs above keyed on `(?:^|\s)-i\S*`, which
   * requires the flag TOKEN to begin with `-i`. Unix short flags bundle, so the
   * in-place flag is routinely NOT first: `perl -0pi -e ...` is `-0` `-p` `-i`, and
   * it is the idiomatic spelling for a slurp-mode in-place rewrite — i.e. exactly the
   * multi-line edit someone reaches for INSTEAD of Edit. Hit live 2026-07-27.
   *
   * This is the dangerous direction of failure: an over-block is a nuisance (use
   * Edit), but an under-block silently bypasses the file-lock hook on a tree shared
   * by the whole fleet, which is the entire point of the guard.
   */
  const CLUSTERED_INPLACE: Array<[string, string]> = [
    ['`perl -0pi` (slurp + in-place, the form hit live)', "perl -0pi -e 's/a/b/' apps/operator/foo.ts"],
    ['`perl -pi` (the most common bundling)', "perl -pi -e 's/a/b/' apps/operator/foo.ts"],
    ['`perl -ni`', "perl -ni -e 'print' apps/operator/foo.ts"],
    ['`perl -pi.bak` (bundled AND suffixed)', "perl -pi.bak -e 's/a/b/' apps/operator/foo.ts"],
    ['`ruby -pi`', "ruby -pi -e 'gsub!(/a/,\"b\")' apps/operator/foo.rb"],
    ['`sed -ni` (sed bundles too)', "sed -ni 's/a/b/p' apps/operator/foo.ts"],
  ];
  for (const [label, command] of CLUSTERED_INPLACE) {
    it(`denies ${label} — the in-place flag is not the first in the cluster`, () => {
      const reason = denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
      expect(reason).toContain('EI-18664655909328670');
    });
  }

  /**
   * The other side of the same fix. A cluster scan that merely asks "does this token
   * contain an i?" would deny `-Mstrict`, `-Iinc`, `-e '...if...'` — all extremely
   * common and none of them in-place. Perl/sed short flags that take a VALUE consume
   * the rest of their token, so the scan must stop at the first such flag.
   */
  /**
   * gawk's in-place edit is a THIRD shape: `-i` is the generic include-a-library
   * option, and the rewrite happens only for the `inplace` library. The guard had no
   * awk leg at all, so this was an unguarded write path — a different root cause from
   * the bundling bug above, fixed here because leaving a known bypass in a write
   * guard is worse than the bug that surfaced it.
   */
  const AWK_INPLACE: Array<[string, string]> = [
    ['`awk -i inplace`', "awk -i inplace '{print}' apps/operator/foo.ts"],
    ['`gawk -i inplace`', "gawk -i inplace '{print}' apps/operator/foo.ts"],
    ['the attached spelling `-iinplace`', "awk -iinplace '{print}' apps/operator/foo.ts"],
    ['the long spelling `--include=inplace`', "awk --include=inplace '{print}' apps/operator/foo.ts"],
  ];
  for (const [label, command] of AWK_INPLACE) {
    it(`denies ${label} rewriting a tree file`, () => {
      const reason = denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
      expect(reason).toContain('EI-18664655909328670');
    });
  }

  const NOT_INPLACE: Array<[string, string]> = [
    ['`awk` with no inplace library — reading, not writing', "awk '{print}' apps/operator/foo.ts"],
    ['`awk -i` including some OTHER library', "awk -i somelib '{print}' apps/operator/foo.ts"],
    ['`-Mstrict` — the module name merely contains an i', "perl -Mstrict -e 'print 1' apps/operator/foo.ts"],
    ['`-Ilib` — an include dir containing an i', "perl -Ilib/inc -e 'print 1' apps/operator/foo.ts"],
    ['`-e` code containing the letter i', "perl -e 'print if 1' apps/operator/foo.ts"],
    ['plain `sed` with no in-place flag', "sed 's/a/b/' apps/operator/foo.ts"],
  ];
  for (const [label, command] of NOT_INPLACE) {
    it(`still ALLOWS ${label} — reading a tree file is not writing it`, () => {
      const out = runGate(bashCmd(command, { cwd: CANON }), CANON_ENV);
      // Allow = silence (or at least: not THIS guard's deny).
      if (out.stdout.trim()) {
        expect(out.stdout).not.toContain('EI-18664655909328670');
      }
    });
  }

  it('fires WITH NO agent marker at all — unconditional, like the shell-write guard', () => {
    const command = `python3 -c "open('apps/operator/generated.ts', 'w').write('x')"`;
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows the exact pre-existing v>100 heredoc repro (EI-18683619680591304) — no literal tree path in the body', () => {
    const command =
      "python3 - <<'PY'\n" +
      'per = {"a": 50, "b": 150}\n' +
      'print(sum(1 for v in per.values() if v>100))\n' +
      "PY";
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows a READ-ONLY interpreter script that merely references a literal tree path (no write call) — the exact false-positive this guard self-caught during its own fix', () => {
    // A read-only syntax-check idiom: read a tree file's content, parse it,
    // print a result — no open(...,'w')/write(/writeFileSync anywhere. This
    // must stay allowed: a read needs no lock, and the ORIGINAL guard did
    // deny this before the write-indicator requirement was added, blocking
    // this test suite's own author mid-verification.
    const command =
      "python3 -c \"\n" +
      "with open('apps/operator/scripts/hooks/cc/pretooluse-bash-resource-gate.sh') as f:\n" +
      "    content = f.read()\n" +
      "print(len(content))\n" +
      '"';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it.each([
    ['a python3 -c write targeting /tmp (outside the tree)', `python3 -c "open('/tmp/scratch.txt', 'w').write('x')"`],
    ['a node -e write targeting ~/.papercusp/scratch', `node -e "require('fs').writeFileSync('/home/x/.papercusp/scratch/out.json', '{}')"`],
    ['a plain `node script.js` — the code lives in a real (Edit-locked) file, not inline', 'node apps/operator/script.js'],
    ['a plain `python3 file.py` with no -c/-e/heredoc', 'python3 apps/operator/tool.py --flag'],
    ['python3 -c with no path literal at all', `python3 -c "print(1 + 1)"`],
    ['a read-only python3 -c (no write call, no tree path)', `python3 -c "import sys; print(sys.version)"`],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  // EI-18828866497684686: `open(sys.argv[1], 'w')` is the canonical COMPUTED-path
  // shape (the target is an argv value, definitionally not a literal) — before
  // that fix this was fully silent ("left alone, fail-open"); it now still
  // ALLOWS (never denies — a bare argv reference gives the guard nothing to
  // resolve against the tree), but with the new non-blocking advisory, since
  // this is exactly the gap that advisory exists to surface.
  it('allows (with the computed-path advisory) a redirect target using shell expansion — no longer fully silent', () => {
    const command = `python3 -c "open(sys.argv[1], 'w')" "$SOME_PATH"`;
    const out = runGate(bashCmd(command, { cwd: CANON }), CANON_ENV);
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow');
    expect(hso.additionalContext).toContain('EI-18828866497684686');
  });

  it('does not fire when the resolved target is OUTSIDE the canonical tree even with a relative path', () => {
    const command = "python3 -c \"open('notes.txt', 'w').write('x')\"";
    expectAllow(runGate(bashCmd(command, { cwd: '/tmp/outside-canonical' }), CANON_ENV));
  });

  /**
   * EI-18700825865251498 — the literal-path scan mismatched quote TYPES:
   * `['"]([^'"\n]+)['"]` happily pairs a `'` with a `"` (or vice versa), so
   * an apostrophe inside one double-quoted string literal (e.g. `"it's
   * differs"`) closes that "string" early, and the NEXT quote character
   * anywhere later on the same line then closes a bogus "string" whose
   * content is actual CODE TEXT — never a literal at all. Repro'd live
   * 2026-07-26: a heredoc python for-loop line containing
   * `if "it's differs" in ln: ln = ln.replace("differs", "diffs")` produced
   * the garbage "path" ` in ln: ln = ln.replace(` — which contains a `.`
   * (from `ln.replace`), so `_resolve_write_target` resolved it against a
   * cwd inside the canonical tree and DENIED a script whose real `open(...)`
   * targets were both absolute `/tmp` paths nowhere near the tree (exactly
   * the "genuinely a scratch file? write it to /tmp" case the guard's own
   * remedy text endorses).
   */
  it('allows the exact repro: a heredoc /tmp write whose CODE contains a mismatched-quote-type line (an apostrophe inside a "double-quoted" string)', () => {
    const command =
      "python3 - <<'EOF'\n" +
      "with open('/tmp/wi5980-live/fixture-source.log') as f:\n" +
      "    lines = f.readlines()\n" +
      "out = []\n" +
      "for ln in lines:\n" +
      "    if \"it's differs\" in ln: ln = ln.replace(\"differs\", \"diffs\")\n" +
      "    out.append(ln)\n" +
      "with open('/tmp/wi5980-live/fixture-differs.log', 'w') as f:\n" +
      "    f.writelines(out)\n" +
      'EOF';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('the quote-type fix is scoped to the mismatch — a LITERAL in-tree write sharing a line with a stray apostrophe still denies (masking control)', () => {
    const command = `python3 -c "open('apps/operator/generated.ts', 'w').write('x')  # it's fine"`;
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * EI-18800669297694465 — the literal scan treated a PROSE SENTENCE as a path.
   *
   * The fourth false positive in this family, and the same shape as the three
   * above: something that is not a path is resolved as one. A log line like
   * `print("wrote /tmp/x.mts")` is a single quoted literal containing a `/`
   * and a `.`, so it cleared both filters — and because the literal does not
   * START with `/`, `_resolve_write_target` treated the WHOLE sentence as a
   * RELATIVE path and joined it onto the cwd, producing
   * `<canon>/wrote /tmp/x.mts` — inside the tree. Denied.
   *
   * Every real path in the repro was absolute under /tmp. Worse, the refusal's
   * own remedy text says "Genuinely a scratch/log file? Write it outside the
   * tree (~/.papercusp/scratch or /tmp)" — which is exactly what the command
   * did. A guard whose refusal describes the thing you just did teaches agents
   * to distrust it on the cases where it is RIGHT.
   *
   * The fix: a path CANDIDATE may not contain whitespace. No tracked path in
   * this repo has a space (verified: `git ls-files | grep -c ' '` → 0), so an
   * in-tree target — the only thing this guard gates — cannot contain one.
   * A whitespace-bearing literal is split and each token tested on its own,
   * so the embedded `/tmp/...` is still examined, and correctly cleared.
   */
  it('allows the exact repro: a /tmp heredoc write whose script PRINTS a sentence containing a /tmp path', () => {
    const command =
      "cd /tmp && python3 - <<'EOF'\n" +
      "open('/tmp/promote-substitution-tiers.mts','w').write('x')\n" +
      'print("wrote /tmp/promote-substitution-tiers.mts")\n' +
      'EOF';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows a sentence whose embedded path is ABSOLUTE and outside the tree, wherever it sits in the line', () => {
    const command = `python3 -c "open('/tmp/o.txt','w').write('x'); print('done: /tmp/o.txt and /var/log/x.log')"`;
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * UPDATE (EI-18814109122347052): this used to be "the accepted coarseness,
   * not a bug" — a sentence naming a RELATIVE tree path denied even when the
   * path was only MENTIONED, never written, because the scan deliberately
   * did not parse which call a literal was an argument to. That note ended
   * "If this ever needs relaxing, relax it with real argument parsing — not
   * by widening what counts as 'not a path'." EI-18814109122347052 is
   * exactly that: a print() label containing a slash (`postings/comments`)
   * was denied even though the body's only actual write target was an
   * unrelated absolute /tmp path. _write_call_arg_spans now scopes the
   * literal scan to the argument list of a recognized write-shaped/file-
   * construct call — real (if coarse, balanced-paren) argument parsing,
   * exactly as prescribed — so a path merely MENTIONED in a print()/log
   * sentence is no longer a candidate at all, while a path passed to
   * open(...)/Path(...)/etc. still is (see the masking-control tests below).
   */
  it('allows a sentence that merely MENTIONS a relative tree path outside any write call (EI-18814109122347052)', () => {
    const command = `python3 -c "open('/tmp/o.txt','w').write('x'); print('wrote apps/operator/generated.ts')"`;
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * The masking control for the narrowing above. If tokenizing had been
   * implemented as "a literal containing whitespace is skipped entirely", a
   * real in-tree write would sail through whenever its literal sat next to
   * any spaced string — so each token must still be tested individually.
   */
  it('still denies a real in-tree write in a script that ALSO prints a spaced sentence (masking control)', () => {
    const command =
      "python3 - <<'EOF'\n" +
      "open('apps/operator/generated.ts','w').write('x')\n" +
      'print("wrote it out just fine")\n' +
      'EOF';
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/generated.ts');
  });

  it('quotes back a real path token, never a prose fragment, as the offending reference', () => {
    const command =
      "python3 - <<'EOF'\n" +
      "print('about to write apps/operator/generated.ts now')\n" +
      "open('apps/operator/generated.ts','w').write('x')\n" +
      'EOF';
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    // The cited reference must be the path itself — not the sentence that
    // happens to contain it, which is what made the original message unusable.
    expect(reason).toContain('`apps/operator/generated.ts`');
    expect(reason).not.toContain('about to write');
  });
});

/**
 * EI-18828866497684686 — a COMPUTED write path (derived from a parsed log, a
 * loop variable, an env var, string concatenation — anything that is not a
 * plain quoted literal) is invisible to `_payload_literal_tree_path`'s
 * literal-only scan, so an interpreter write via a computed path sails
 * through with no deny and, before this fix, no signal at all. This is the
 * guard's own documented "honest limit" (no static scan can see a runtime-
 * constructed path) — the fix is NOT to deny it (that would also flag the
 * common, safe case of a computed path resolving OUTSIDE the tree, and a
 * literal out-of-tree write like `open('/tmp/x.log','w')` must stay silent
 * too — see the second test below), but to say so once, non-blocking, so a
 * silent pass no longer reads as an endorsement.
 */
describe('interpreter write-guard advisory for a COMPUTED path (EI-18828866497684686)', () => {
  const expectComputedAdvisory = (out: { stdout: string; status: number | null }) => {
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('EI-18828866497684686');
    expect(hso.additionalContext).toContain('COMPUTED path');
    return hso.additionalContext as string;
  };

  it('advises (not denies) a python3 heredoc writing via a variable path derived from a loop', () => {
    const command =
      "python3 - <<'EOF'\n" +
      "for f in changed_paths:\n" +
      "    open(f, 'w').write('x')\n" +
      'EOF';
    const ctx = expectComputedAdvisory(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(ctx).toContain('python3');
  });

  it('advises for `node -e` writing via fs.writeFileSync with a computed path', () => {
    const command = `node -e "require('fs').writeFileSync(path.join(dir, name), data)"`;
    expectComputedAdvisory(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('does not resolve a suffix fragment as a target in an absolute scratch-path concatenation', () => {
    const command = `python3 -c "for tag in ('quality','specs'): open('/tmp/iphone-85b00-prefixed-' + tag + '3271.json', 'w').write('x')"`;
    const context = expectComputedAdvisory(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(context).not.toContain('3271.json');
  });

  it('stays SILENT for a LITERAL out-of-tree write — the advisory is not "no in-tree hit", only "no literal at all"', () => {
    const command = `python3 -c "open('/tmp/scratch.log', 'w').write('x')"`;
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('a deny (literal in-tree path) still wins — never merely advises when a real hit exists', () => {
    const command = `python3 -c "open('apps/operator/generated.ts', 'w').write('x')"`;
    const reason = denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('EI-18691482279179647');
  });

  it('does not fire for a read via a computed path (no write indicator at all)', () => {
    const command =
      "python3 - <<'EOF'\n" +
      "for f in changed_paths:\n" +
      "    print(open(f).read())\n" +
      'EOF';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });
});

/**
 * EI-18814109122347052 — a print() LABEL containing a slash was resolved as a
 * path.
 *
 * Sixth in the not-a-path-resolved-as-one family, and the first fixed by
 * narrowing WHERE the scan looks rather than what a candidate token is
 * allowed to look like. `print("postings/comments pulled:", ...)` is a
 * literal like any other: it contains a `/`, carries no quote character
 * inside it, and so cleared every prior filter (paired quotes, whitespace
 * tokenizing, quote-char + path-shape exclusion) — even though the body's
 * only real write target was an unrelated `open('/tmp/hiring-blob.txt',
 * 'w')` a line away. Hit live 2026-07-27, twice in one session.
 *
 * The fix (`_write_call_arg_spans`): only scan literals that are ARGUMENTS TO
 * a recognized write-shaped/file-construct call (open(...), Path(...),
 * write_text(...)/write_bytes(...), writeFileSync(...), etc.), found by
 * balanced-paren matching from the call site — real (if coarse) argument
 * parsing, not a full interpreter parse. A literal sitting anywhere else in
 * the body — a print() label, a docstring, a bare variable assignment — is
 * no longer a candidate at all.
 */
describe('interpreter literal scan — only WRITE-CALL ARGUMENTS are candidates (EI-18814109122347052)', () => {
  const expectInterpDeny = (out: { stdout: string; status: number | null }) => {
    const reason = denyReason(out);
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toMatch(/Edit or Write/);
    return reason;
  };

  it('allows the exact repro: a print() label containing a slash, alongside a real write to an absolute /tmp path', () => {
    const command =
      "python3 - <<'PY'\n" +
      "import urllib.request\n" +
      "texts=['a']\n" +
      "blob='x'\n" +
      'print("postings/comments pulled:", len(texts), "| chars:", len(blob))\n' +
      "open('/tmp/hiring-blob.txt','w').write(blob)\n" +
      'PY';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows other everyday slash-bearing prose labels next to an out-of-tree write (read/write, input/output, pub/sub)', () => {
    const command =
      "python3 - <<'PY'\n" +
      "open('/tmp/x.log','w').write('x')\n" +
      "print('read/write mode, input/output pair, pub/sub channel')\n" +
      'PY';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('still denies a real in-tree write via open(...,\'w\') — the recurrence guard for the fix itself', () => {
    const command = `python3 -c "open('apps/operator/generated.ts', 'w').write('x')"`;
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('fails closed for an unresolved concat with a relative in-tree prefix', () => {
    const command = `python3 -c "for tag in ('quality','specs'): open('apps/operator/generated-' + tag + '.ts', 'w').write('x')"`;
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/generated-');
  });

  it('masking control: still denies a real in-tree write in a script that ALSO prints a slash-bearing label', () => {
    const command =
      "python3 - <<'PY'\n" +
      'print("postings/comments pulled:", 3)\n' +
      "open('apps/operator/generated.ts','w').write('x')\n" +
      'PY';
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/generated.ts');
    expect(reason).not.toContain('postings/comments');
  });

  it('still denies when the in-tree literal is itself the write-call argument, not merely nearby prose', () => {
    const command = `node -e "require('fs').writeFileSync('packages/operator-core/lib/foo.ts', 'x')"`;
    expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });
});

/**
 * EI-21274601485463217 — a write target outside the tree must not be denied
 * because a later payload argument names a tracked file in its rationale.
 * Only the first path argument is an operand for the interpreter write guard;
 * JSON payloads and other later arguments are data, not paths.
 */
describe('interpreter literal scan — only the first write-call path argument is scanned (EI-21274601485463217)', () => {
  const expectInterpDeny = (out: { stdout: string; status: number | null }) => {
    const reason = denyReason(out);
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toMatch(/Edit or Write/);
    return reason;
  };

  it('allows a /tmp write whose JSON rationale names a tracked test file', () => {
    const command =
      `node -e "const fs=require('fs'); fs.writeFileSync('/tmp/p019-done.json', ` +
      `JSON.stringify({rationale:'Wave B gate landed: wave-b-gate.test.ts (14 tests) closes both halves...'}));"`;
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('still denies an in-tree first path argument even when its payload also contains prose', () => {
    const command =
      `node -e "const fs=require('fs'); fs.writeFileSync('apps/operator/generated.ts', ` +
      `JSON.stringify({rationale:'Wave B gate landed: wave-b-gate.test.ts (14 tests) closes both halves...'}));"`;
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('`apps/operator/generated.ts`');
    expect(reason).not.toContain('wave-b-gate.test.ts');
  });
});

/**
 * EI-18828567391761902 — a PROSE WORD carrying a period was resolved as a path.
 *
 * Fifth in the not-a-path-resolved-as-one family. The predecessor
 * (EI-18800669297694465) narrowed candidates from whole literals to whitespace
 * TOKENS, which left the per-token test as a bare `[./]` — so any prose word
 * ending in a period still qualified. `sibling."""` contains a `.`, does not
 * start with `/`, and was therefore joined onto an in-tree cwd as
 * `<canon>/sibling."""`.
 *
 * What makes this one worth pinning rather than just fixing: the offending
 * command's ONLY write sink was `open('/tmp/...','w')`, so the write-indicator
 * test (the previous two rounds' fix) was satisfied LEGITIMATELY and could not
 * help. The entire error was in path detection, which is why the narrowing has
 * to land there.
 *
 * The cost was not merely a refusal. The blocked command was building an
 * out-of-tree MUTANT copy to verify a guard fix — the technique this repo's own
 * guidance prescribes for testing a guard without touching shared source. The
 * fallback (`sed`) silently produced a no-op mutant, and a working fix was
 * nearly reported as inert. A false positive here degrades verification itself.
 */
describe('interpreter literal scan — prose periods are not extensions (EI-18828567391761902)', () => {
  // Same assertion as the sibling describe's local helper: this guard's deny
  // must be attributable to the interpreter leg (its own EI ref) rather than to
  // the shell-write leg, which would otherwise satisfy a bare "it denied" check.
  const expectInterpDeny = (out: { stdout: string; status: number | null }) => {
    const reason = denyReason(out);
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toMatch(/Edit or Write/);
    return reason;
  };

  it('allows the exact repro: a heredoc searching for a docstring sentence while writing only to /tmp', () => {
    const command =
      "python3 - <<'PY'\n" +
      `anchor = 'newly refuse an independent sibling."""'\n` +
      "open('/tmp/mutant.sh','w').write('x')\n" +
      'PY';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows prose whose words merely END in a period (`sibling.`, `e.g.`, `etc.`)', () => {
    const command =
      "python3 - <<'PY'\n" +
      "open('/tmp/o.txt','w').write('x')\n" +
      "print('refused an independent sibling. see the docstring, e.g. the list, etc.')\n" +
      'PY';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * The `/` branch needed the same protection: tokenizing prose can hand back a
   * token that is quote-wrapped rather than path-shaped. No tracked path in this
   * repo contains a quote character (`git ls-files | grep -c '["'\'']'` → 0), so
   * excluding quoted tokens cannot lose a real in-tree target.
   */
  it('allows prose that QUOTES a relative tree path inside the sentence', () => {
    const command =
      "python3 - <<'PY'\n" +
      "open('/tmp/o.txt','w').write('x')\n" +
      'print(\'see "apps/operator" for details\')\n' +
      'PY';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  /**
   * THE LOAD-BEARING CONTROL for how the extension rule is spelled.
   *
   * An alnum-only extension (`\.[A-Za-z0-9]+$`) would have excluded prose just
   * as well, but it would ALSO have stopped matching 5 real tracked paths whose
   * extensions carry `_` or `-` and which have no `/` to fall back on:
   * .bash_profile, .gitnexusignore, .mcp.json.su-parked, and two dated
   * .mcp.json backups. Measured, not assumed: of the 3615 tracked paths whose
   * final segment is not an alnum extension, exactly those 5 lack a slash.
   * Hence `[A-Za-z0-9_-]`. This test fails if anyone tightens it to alnum.
   */
  it('still denies a write to a root dotfile whose extension contains _ or - (why filename-safe, not alnum)', () => {
    for (const target of ['.bash_profile', '.gitnexusignore', '.mcp.json.su-parked']) {
      const command = `python3 -c "open('${target}','w').write('x')"`;
      const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
      expect(reason).toContain(target);
    }
  });

  /**
   * Masking control. If the narrowing had been implemented as "skip any literal
   * containing prose", a real in-tree write sitting beside a prose sentence
   * would sail through — the exact hole this guard exists to close.
   */
  it('still denies a real in-tree write in a script that ALSO holds a period-bearing prose literal', () => {
    const command =
      "python3 - <<'PY'\n" +
      `anchor = 'newly refuse an independent sibling."""'\n` +
      "open('apps/operator/generated.ts','w').write('x')\n" +
      'PY';
    const reason = expectInterpDeny(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('apps/operator/generated.ts');
    expect(reason).not.toContain('sibling');
  });
});

/**
 * EI-18692070370140239 — the write-INDICATOR's own false positives.
 *
 * The describe above records how the guard, on its first pass, denied a
 * read-only script and was fixed by requiring a WRITE-shaped call. The
 * indicator then over-matched in the same shape one level down: its
 * `\bwrite\w*\s*\(` alternative matched ANY `.write(`, so a script that
 * merely PRINTS a string resembling a tree path — `sys.stdout.write(...)`,
 * `process.stdout.write(...)` — was denied as an "interpreter write" with no
 * file I/O anywhere in it. Caught the same way as its predecessor: it denied
 * an ordinary agent command that wrote nothing to the tree.
 *
 * A write to stdout/stderr is not a file write; a bare `.write(` is ambiguous
 * (file handle vs io.StringIO vs socket) and now counts only alongside a
 * file-object construct in the SAME inline body. The denies below are the
 * load-bearing half: they prove the narrowing did not open a hole.
 */
describe('interpreter write-indicator false positives (EI-18692070370140239)', () => {
  const TREE_PATH = 'packages/operator-core/lib/foo.ts';

  it.each([
    ['a read-only sys.stdout.write of a literal tree path', `python3 -c 'import sys; sys.stdout.write("${TREE_PATH}")'`],
    ['a read-only sys.stderr.write of a literal tree path', `python3 -c 'import sys; sys.stderr.write("${TREE_PATH}")'`],
    ['a read-only process.stdout.write (node)', `node -e 'process.stdout.write("${TREE_PATH}")'`],
    ['a .write( onto an in-memory io.StringIO buffer', `python3 -c 'import io; b=io.StringIO(); b.write("${TREE_PATH}")'`],
  ])('allows %s', (_label, command) => {
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('allows a heredoc script that only PRINTS a tree path', () => {
    const command = "python3 - <<'EOF'\n" + `import sys; sys.stdout.write("${TREE_PATH}")\n` + 'EOF';
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  // ── the narrowing must not open a hole ──────────────────────────────────
  it('still denies a stdout write sitting ALONGSIDE a real file write in one body', () => {
    // The load-bearing case for stripping non-file sinks before scanning:
    // removing `sys.stdout.write(` must not mask the open(...,'w') next to it.
    const command = `python3 -c 'import sys; sys.stdout.write("hi"); open("${TREE_PATH}", "w").write("x")'`;
    expect(denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV))).toContain('EI-18691482279179647');
  });

  it('still denies a two-statement handle write (f = open(p, "w"); f.write(...))', () => {
    const command = `python3 -c 'f=open("${TREE_PATH}", "w"); f.write("x")'`;
    expect(denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV))).toContain('EI-18691482279179647');
  });

  it('still denies pathlib Path(...).write_text — a named form that is unambiguous alone', () => {
    const command = `python3 -c 'from pathlib import Path; Path("${TREE_PATH}").write_text("x")'`;
    expect(denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV))).toContain('EI-18691482279179647');
  });

  it('still denies a StringIO buffer write alongside a real file write', () => {
    const command = `python3 -c 'import io; b=io.StringIO(); b.write("x"); open("${TREE_PATH}", "w").write("y")'`;
    expect(denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV))).toContain('EI-18691482279179647');
  });
});

describe('interpreter write guard ignores inert serialized code strings (EI-26810819700181555)', () => {
  const TREE_PATH = 'packages/operator-core/lib/foo.ts';

  const serializedArtifactScript =
    "tools.artifacts.save({slug: 'probe', rel_path: 'witness.json', content: 'ok'}); " +
    "open('packages/operator-core/lib/foo.ts', 'w').write('x')";

  it('allows a read-only serializer whose JSON string contains remote save and local-open code', () => {
    const command = [
      "python3 - <<'PY'",
      'import json, sys',
      `payload = {'script': ${JSON.stringify(serializedArtifactScript)}}`,
      'sys.stdout.write(json.dumps(payload))',
      'PY',
    ].join('\n');
    expectAllow(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
  });

  it('still denies a real in-tree open write when serialized code beside it names another target', () => {
    const command = [
      "python3 - <<'PY'",
      'import json, sys',
      `payload = {'script': ${JSON.stringify(serializedArtifactScript)}}`,
      "open('packages/operator-core/lib/foo.ts', 'w').write('x')",
      'sys.stdout.write(json.dumps(payload))',
      'PY',
    ].join('\n');
    const reason = denyReason(runGate(bashCmd(command, { cwd: CANON }), CANON_ENV));
    expect(reason).toContain('EI-18691482279179647');
    expect(reason).toContain(TREE_PATH);
    expect(reason).not.toContain('witness.json');
  });
});

// ── Substitution gate (bash-to-tool-substitution-2026-07-26, P-016) ─────────
// Two distinct things are under test and they fail differently:
//   1. the PRE-FILTER — does a command a registry rule could claim actually
//      reach the operator? A pre-filter miss is SILENT: no error, just an
//      advisory that never fires for the commands it was written for.
//   2. the VERDICT HANDLING — given a substitution payload, does `advise` ride
//      out as a non-blocking additionalContext and `deny` actually deny?
describe('substitution pre-filter', () => {
  // With OPERATOR_URL pointed at a dead port, a command that PASSES the
  // pre-filter attempts HTTP and fails open with a diagnostic on stderr, while
  // one filtered out returns in silence. That difference is the probe.
  // `stderr` is optional on GateOut (a few call sites build their own spawnSync
  // result), so default it rather than requiring it — an absent stderr simply
  // means the operator was not reached.
  const reachedOperator = (out: { stderr?: string }) =>
    (out.stderr ?? '').includes('operator unreachable');

  it.each([
    ['sed range read', "sed -n '1,80p' packages/foo.ts"],
    ['sed behind a cd', "cd /repo && sed -n '1,80p' packages/foo.ts"],
    ['cat a file', 'cat packages/operator-core/lib/foo.ts'],
    ['head a file', 'head -n 20 packages/foo.ts'],
    ['tail a file', 'tail -n 50 packages/foo.ts'],
    ['psql select', 'psql -d papercusp -c "SELECT 1"'],
    ['behind sudo', "sudo sed -n '1,5p' /etc/hosts"],
    ['behind an env assignment', 'FOO=bar cat notes.txt'],
    ['second atom in a pipeline', 'echo hi; cat notes.txt'],
  ])('routes %s to the operator', (_label, command) => {
    expect(reachedOperator(runGate(bashCmd(command)))).toBe(true);
  });

  it.each([
    ['a plain listing', 'ls -la'],
    ['a word merely CONTAINING a verb', 'echo concatenate the duplicates'],
    ['a path merely containing a verb', 'node scripts/cat-herder.mjs'],
    ['an unrelated npm script', 'npm run lint'],
  ])('does NOT pay an HTTP round-trip for %s', (_label, command) => {
    const out = runGate(bashCmd(command));
    expect(reachedOperator(out)).toBe(false);
    expectAllow(out);
  });

  // THE ANTI-DRIFT GUARD. The pre-filter keeps a hand-written verb set, and a
  // registry pair whose verb is missing from it is enforced nowhere while every
  // other test stays green. This replays the REAL atoms behind every recorded
  // equivalence verdict — the same frozen corpus those verdicts were computed
  // from — and asserts each still reaches the operator. Add a pair without
  // adding its verb and this goes red.
  // Scoped to the ENFORCEABLE pairs, exactly as the OMP hook's mirror of this
  // guard is. A `not-a-substitute` pair (P-008's `ps`/`pgrep`) is dropped by
  // `matchCommandToSubstitutions` unconditionally per D-007, so its atoms can
  // never produce an advisory however the pre-filter behaves — admitting them
  // would charge every `ps` call on the box a round-trip to be told nothing.
  // The verdict is read off the pair, never inferred from a filename.
  // Budget: this sweep spawns the REAL bash+python hook once per enforceable
  // atom (~400 processes, serial), so its wall time scales with box load, not
  // with the code under test — measured 60.3s at loadavg ~111 (2026-08-01,
  // EI-19296218202371307), sailing past the 60s default exactly when the
  // fleet is busiest. 5× the measured worst keeps the guard exhaustive
  // without making it a load canary.
  it('every atom behind an ENFORCEABLE verdict passes the pre-filter', { timeout: 300_000 }, async () => {
    // Selection is SHARED with the OMP hook's mirror of this guard
    // (`selectEnforceableFixtures`) so the two cannot drift — see
    // EI-18699117901393768. D-005 duplicates the pre-filter across the HOOKS;
    // it does not require their tests to re-derive which fixtures to replay.
    const { files, expected } = selectEnforceableFixtures(BASH_GATE_PAIRS);
    // Exact, not `> 0`: a filter that silently dropped fixtures would make this
    // guard vacuously green.
    expect(files.length, 'a fixture is missing for some enforceable pair').toBe(expected);

    // Flatten first, then sweep through a bounded pool. These probes are
    // independent and read-only (each reads only stderr), so the original
    // nested serial loop cost 430 x the hook's full ~150ms startup — 58.6s,
    // 37% of this file — for no isolation benefit. See `runGateAsync`.
    const probes = files.flatMap((file) => {
      const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, file), 'utf8')) as {
        sample: { atom: string }[];
      };
      return fixture.sample.map(({ atom }) => ({ file, atom }));
    });

    const outcomes = await mapWithConcurrency(probes, 8, async ({ file, atom }) => ({
      file,
      atom,
      reached: reachedOperator(await runGateAsync(bashCmd(atom))),
    }));

    const missed = outcomes.filter((o) => !o.reached).map((o) => `${o.file}: ${o.atom}`);
    expect(missed, `pre-filter dropped atoms a registry rule claims:\n${missed.join('\n')}`).toEqual(
      [],
    );
  });
});

describe('substitution verdict handling', () => {
  // A stand-in operator returning a real MCP envelope, so the hook's own
  // response parsing is exercised rather than mocked away.
  //
  // It MUST run in a separate process. runGate uses spawnSync, which blocks
  // this process's event loop for the whole hook run — an in-process server
  // could never accept the connection, so every case would hang until the
  // hook's 4s HTTP timeout and then fail open, and the suite would report
  // "allow" everywhere while testing nothing. (Cost an initial round of four
  // confusing "Unexpected end of JSON input" failures.)
  //
  // The desired reply is passed through a FILE the server re-reads per request,
  // so a test can change it without restarting the child.
  let child: ReturnType<typeof spawn>;
  let url = '';
  let replyFile = '';
  let requestFile = '';
  const setReply = (r: Record<string, unknown>) =>
    writeFileSync(replyFile, JSON.stringify({ ok: true, ...r }));

  beforeAll(async () => {
    replyFile = join(fakeHome, 'reply.json');
    requestFile = join(fakeHome, 'requests.jsonl');
    setReply({ decision: 'allow', matched: [] });
    writeFileSync(requestFile, '');
    const serverJs = join(fakeHome, 'fake-operator.mjs');
    writeFileSync(
      serverJs,
      // The stub HONOURS result-format negotiation, exactly like the real
      // operator — this is load-bearing, not realism for its own sake. The
      // agent transport TOON-encodes a tabular result (substitutions[]) unless
      // the caller declares `_meta.format: 'json'`, and the gate parses with
      // json.loads. A stub that always replied JSON is why both hook paths sat
      // SILENTLY FAIL-OPEN — no resource hold and no substitution row enforced
      // — through a green suite until P-028 probed the live operator by hand.
      // Replying TOON to an undeclared caller makes the whole describe block
      // below the regression guard: drop the `_meta.format` and these fail.
      `import { createServer } from 'node:http';
       import { appendFileSync, readFileSync } from 'node:fs';
       const s = createServer((req, res) => {
         let raw = '';
         req.on('data', (c) => { raw += c; });
         req.on('end', () => {
           appendFileSync(process.argv[3], raw + '\\n');
           const body = readFileSync(process.argv[2], 'utf8');
           let wantsJson = false;
           try { wantsJson = JSON.parse(raw)?.params?._meta?.format === 'json'; } catch {}
           // TOON is self-identifying and is NOT valid JSON — the same shape the
           // real operator sends a caller that never said what it can decode.
           const text = wantsJson ? body : 'format: toon\\nok: true\\ndecision: allow\\nmatched: []';
           res.writeHead(200, { 'Content-Type': 'application/json' });
           res.end(JSON.stringify({ jsonrpc: '2.0', id: 1,
             result: { content: [{ type: 'text', text }] } }));
         });
       });
       s.listen(0, '127.0.0.1', () => console.log('PORT=' + s.address().port));`,
    );

    child = spawn(process.execPath, [serverJs, replyFile, requestFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    url = await new Promise<string>((ok, fail) => {
      const t = setTimeout(() => fail(new Error('fake operator did not start')), 10_000);
      child.stdout!.on('data', (b: Buffer) => {
        const m = /PORT=(\d+)/.exec(String(b));
        if (m) {
          clearTimeout(t);
          ok(`http://127.0.0.1:${m[1]}`);
        }
      });
    });
  });

  afterAll(() => {
    child?.kill();
  });

  const CAT = 'cat packages/operator-core/lib/foo.ts';
  const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const SUB = {
    intentLabel: 'file-whole-read',
    toolName: 'capability:read',
    tier: 'advise',
    advisoryText: 'capability:read { file_path } returns the whole file.',
    atom: CAT,
  };
  const run = (command = CAT) => runGate(bashCmd(command), { PAPERCUSP_OPERATOR_URL: url });

  it.each([
    [
      '`git mv` of a tracked source (the filed bypass)',
      'git mv packages/operator-core/lib/agent-tools/locks/check_command.ts /tmp/check-command-moved.ts',
    ],
    [
      '`git rm` of a tracked path',
      'git rm packages/operator-core/lib/agent-tools/locks/check_command.ts',
    ],
    [
      'plain `mv` of a tracked source',
      'mv packages/operator-core/lib/agent-tools/locks/check_command.ts /tmp/check-command-moved.ts',
    ],
  ])('bridges %s into the server-side GOAL edit refusal', (_label, command) => {
    setReply({
      decision: 'allow',
      matched: [],
      goalModeEditDenyReason: 'GOAL mode: you never implement — route it instead.',
    });
    const out = runGate(bashCmd(command, { cwd: REPO_ROOT }), {
      PAPERCUSP_OPERATOR_URL: url,
      PAPERCUSP_CANONICAL_TREE: REPO_ROOT,
    });
    const hook = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain('GOAL mode: you never implement');

    const requests = readFileSync(requestFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { params?: { arguments?: Record<string, unknown> } });
    expect(requests.at(-1)?.params?.arguments).toMatchObject({
      command,
      cwd: REPO_ROOT,
      tracked_mutation: true,
    });
  });

  it('surfaces the actionable frozen-lineage refusal before generic resource-block prose', () => {
    const message =
      'frozen_candidate_lineage_violation — candidate=ccc, repairHead=rrr, queueRevision=42; use repairHead/admit.';
    setReply({
      decision: 'block',
      matched: [],
      frozenLineageDenyReason: message,
    });
    const out = run();
    const hook = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain(message);
    expect(hook.permissionDecisionReason).not.toContain('resource-gate:');
  });

  it('does not mark a Git read as a tracked mutation', () => {
    setReply({ decision: 'allow', matched: [], goalModeEditDenyReason: null });
    expectAllow(runGate(bashCmd('git status', { cwd: REPO_ROOT }), {
      PAPERCUSP_OPERATOR_URL: url,
      PAPERCUSP_CANONICAL_TREE: REPO_ROOT,
    }));
    const requests = readFileSync(requestFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { params?: { arguments?: Record<string, unknown> } });
    expect(requests.at(-1)?.params?.arguments).not.toHaveProperty('tracked_mutation');
  });

  it('honors `git -C`: a mutation in another checkout is not attributed to this tree', () => {
    // A FRESH empty dir, never the shared `/tmp`: the gate resolves `-C <dir>/<operand>`
    // through realpath, so a peer's `/tmp/packages -> <canonical>/packages` symlink
    // (observed 2026-10-18) made the literal `/tmp` fixture resolve INTO this tree and
    // the gate correctly reported a tracked mutation (WI-6554700010017558).
    const otherCheckout = mkdtempSync(join(tmpdir(), 'gate-other-checkout-'));
    const command =
      `git -C ${otherCheckout} rm packages/operator-core/lib/agent-tools/locks/check_command.ts`;
    setReply({ decision: 'allow', matched: [], goalModeEditDenyReason: null });
    try {
      expectAllow(runGate(bashCmd(command, { cwd: REPO_ROOT }), {
        PAPERCUSP_OPERATOR_URL: url,
        PAPERCUSP_CANONICAL_TREE: REPO_ROOT,
      }));
    } finally {
      rmSync(otherCheckout, { recursive: true, force: true });
    }
    const requests = readFileSync(requestFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { params?: { arguments?: Record<string, unknown> } });
    expect(requests.at(-1)?.params?.arguments).not.toHaveProperty('tracked_mutation');
  });

  /**
   * WI-10005009: git-sync rewrites .git/index on every sweep, and a half-written index
   * makes `git ls-files --error-unmatch` answer "not tracked" for a TRACKED path,
   * byte-for-byte like an untracked one. For this classifier that is the unsafe
   * direction: a tracked `mv` would slip past the GOAL-mode edit refusal with no
   * `tracked_mutation` bridge. `_is_tracked_path` must fall back to HEAD's tree.
   */
  describe('tracked-mutation classifier under a torn index (WI-10005009)', () => {
    const tornRepo = () => {
      const dir = mkdtempSync(join(tmpdir(), 'gate-torn-index-'));
      const git = (...args: string[]) =>
        execFileSync('git', [
          '-C', dir, '-c', 'user.email=t@t', '-c', 'user.name=t',
          '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args,
        ], { stdio: 'pipe' });
      git('init', '-q');
      writeFileSync(join(dir, 'tracked.ts'), 'export const x = 1;\n');
      git('add', 'tracked.ts');
      git('commit', '-q', '-m', 'seed');
      writeFileSync(join(dir, 'untracked.ts'), 'export const y = 2;\n');
      const index = join(dir, '.git', 'index');
      const bytes = readFileSync(index);
      writeFileSync(index, bytes.subarray(0, Math.floor(bytes.length / 2)));
      return dir;
    };
    const rawIndexSaysTracked = (dir: string, rel: string) =>
      spawnSync('git', ['-C', dir, 'ls-files', '--error-unmatch', '--', rel], { stdio: 'ignore' })
        .status === 0;
    const trackedMutationFlags = () =>
      readFileSync(requestFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { params?: { arguments?: Record<string, unknown> } })
        .map((r) => r.params?.arguments?.tracked_mutation);
    const runIn = (dir: string, command: string) => {
      writeFileSync(requestFile, '');
      return runGate(bashCmd(command, { cwd: dir }), {
        PAPERCUSP_OPERATOR_URL: url,
        PAPERCUSP_CANONICAL_TREE: dir,
      });
    };

    it('still bridges a tracked `mv` when the index is half-written', () => {
      const dir = tornRepo();
      try {
        // Calibration: the raw index read really does misreport, so this case is not vacuous.
        expect(rawIndexSaysTracked(dir, 'tracked.ts')).toBe(false);
        setReply({
          decision: 'allow',
          matched: [],
          goalModeEditDenyReason: 'GOAL mode: you never implement — route it instead.',
        });
        const out = runIn(dir, 'mv tracked.ts /tmp/gate-torn-index-moved.ts');
        const hook = JSON.parse(out.stdout).hookSpecificOutput;
        expect(hook.permissionDecision).toBe('deny');
        expect(hook.permissionDecisionReason).toContain('GOAL mode: you never implement');
        expect(trackedMutationFlags()).toContain(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('does not promote an untracked path to a tracked mutation under the same torn index', () => {
      const dir = tornRepo();
      try {
        expect(rawIndexSaysTracked(dir, 'untracked.ts')).toBe(false);
        setReply({ decision: 'allow', matched: [], goalModeEditDenyReason: null });
        expectAllow(runIn(dir, 'mv untracked.ts /tmp/gate-torn-index-moved.ts'));
        expect(trackedMutationFlags()).not.toContain(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it('forwards the shell cwd to locks:check_command for cwd-scoped substitution policy', () => {
    const scratch = '/tmp/ei-204040-scratch';
    setReply({ decision: 'allow', matched: [] });
    const out = runGate(
      bashCmd('npm install --package-lock-only --ignore-scripts', { cwd: scratch }),
      { PAPERCUSP_OPERATOR_URL: url },
    );
    expect(out.status).toBe(0);

    const requests = readFileSync(requestFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { params?: { arguments?: Record<string, unknown>; _meta?: Record<string, unknown> } });
    const request = requests.at(-1);
    expect(request?.params?.arguments).toEqual({
      command: 'npm install --package-lock-only --ignore-scripts',
      cwd: scratch,
    });
    expect(request?.params?._meta).toMatchObject({ format: 'json' });
  });

  it('allows a read-only ps/grep inspection that mentions heavy tools under load (EI-19299721661084366)', () => {
    // The live operator must answer first so the heavy-admission leg is reached;
    // otherwise its substitution pre-filter fails open before this regression can
    // be observed. This is the exact filed command, with a deterministic over-
    // threshold load, and it must remain an empty-output allow.
    setReply({ decision: 'allow', matched: [] });
    const out = runGate(
      bashCmd('ps -eo pid,etimes,pcpu,comm,args --sort=-pcpu | grep -E "vitest|tsc|node scripts/test-files" | grep -v grep'),
      {
        PAPERCUSP_OPERATOR_URL: url,
        ...AGENT,
        PC_HEAVY_MAX_LOAD1: '100',
        PC_HEAVY_LOAD1_OVERRIDE: '200',
      },
    );
    expectAllow(out);
  });

  it('tier=advise rides out as a NON-BLOCKING additionalContext', () => {
    setReply({ decision: 'allow', matched: [], substitutions: [SUB], substitutionTier: 'advise' });
    const out = run();
    const hook = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('allow'); // the command still runs
    expect(hook.additionalContext).toContain('capability:read');
    expect(hook.additionalContext).toContain('proceeding as issued');
  });

  it('tier=observe changes nothing the agent sees', () => {
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [{ ...SUB, tier: 'observe' }],
      substitutionTier: 'observe',
    });
    expectAllow(run());
  });

  it('tier=deny blocks and names the tool to use instead', () => {
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [{ ...SUB, tier: 'deny' }],
      substitutionTier: 'deny',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain('capability:read');
  });

  /**
   * EI-18810711449496523 — the advised tool is usually NOT in the caller's
   * loaded tool surface, and the hook cannot know that.
   *
   * Measured on a live trimmed su session: of the 10 tools the registry names,
   * only `coord:orient` and `dev:pg_query` were reachable. `capability:read`,
   * `testing:run`, `logs:read`, `build:typecheck`, `capability:git`,
   * `dev:service_health`, `dev:listening_ports` and `dev:processes` all missed
   * — a `ToolSearch select:` for each returned nothing (verified against a
   * positive control in the same call, so the miss is per-name, not a broken
   * query). The agent then spends a round-trip discovering the dead end and
   * falls back to bash, and is advised again on the next call.
   *
   * PreToolUse carries `tool_name` / `tool_input` / `transcript_path` and no
   * tool surface, so the hook cannot suppress the row conditionally. What it
   * CAN do is name the calling convention that always works: `tools:invoke`
   * dispatches any catalog tool server-side and is in every trimmed seed
   * (proven live for both `capability:read` and `testing:run`). That keeps the
   * teaching signal and removes the dead end for every row, present and future
   * — a per-row fix would reopen the moment a pair names a new tool.
   *
   * Asserted on BOTH tiers because `deny` is the worse failure: it blocks the
   * command outright and says "re-run using the tool above", which strands an
   * agent that cannot call that tool.
   */
  it('the advisory names the tools:invoke fallback, because the advised tool is often not loadable', () => {
    setReply({ decision: 'allow', matched: [], substitutions: [SUB], substitutionTier: 'advise' });
    const ctx = JSON.parse(run().stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('tools:invoke');
  });

  it('the deny refusal names the tools:invoke fallback too (a block with no path out is worse)', () => {
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [{ ...SUB, tier: 'deny' }],
      substitutionTier: 'deny',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain('tools:invoke');
  });

  /**
   * P-009 — the executable advisory, through the REAL shell hook.
   *
   * `invokeLine` is rendered server-side so this Python block and the OMP hook's
   * TypeScript cannot format the same envelope two ways; what is asserted here
   * is that the shell path places it and applies the same suppression rule.
   */
  const INVOKE_LINE =
    'tools:invoke { name: "capability:read", args: {"file_path":"packages/operator-core/lib/foo.ts"} }';
  const SUB_WITH_INVOKE = { ...SUB, invokeLine: INVOKE_LINE };

  it('renders the executable call, labelled run:, on the advise path', () => {
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [SUB_WITH_INVOKE],
      substitutionTier: 'advise',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('allow'); // still advisory only
    expect(hook.additionalContext).toContain(`run: ${INVOKE_LINE}`);
  });

  it('renders the executable call on the deny path too', () => {
    // A block that says "re-run using the tool above" is exactly where handing
    // over the finished call matters most.
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [{ ...SUB_WITH_INVOKE, tier: 'deny' }],
      substitutionTier: 'deny',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain(`run: ${INVOKE_LINE}`);
  });

  it('SUPPRESSES the generic tools:invoke hint once a concrete call is present', () => {
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [SUB_WITH_INVOKE],
      substitutionTier: 'advise',
    });
    const ctx = JSON.parse(run().stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('tools:invoke'); // the concrete one
    expect(ctx).not.toContain('Not in your loaded tool set?'); // not the generic one
  });

  it('keeps the generic hint when the server derived no call (the majority case)', () => {
    setReply({ decision: 'allow', matched: [], substitutions: [SUB], substitutionTier: 'advise' });
    const ctx = JSON.parse(run().stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Not in your loaded tool set?');
    expect(ctx).not.toContain('run: tools:invoke');
  });

  it('degrades to prose when invokeLine is malformed rather than wedging the command', () => {
    // Fail-open is the contract for this whole block: a bad payload field must
    // cost an envelope, never a command.
    setReply({
      decision: 'allow',
      matched: [],
      substitutions: [{ ...SUB, invokeLine: null }],
      substitutionTier: 'advise',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('allow');
    expect(hook.additionalContext).toContain('capability:read');
    expect(hook.additionalContext).not.toContain('run:');
  });

  it('an in-flight RESOURCE hold outranks a substitution advisory', () => {
    // A lock collision is happening right now; tool-choice guidance is not.
    // Burying the urgent message under the educational one is the failure.
    setReply({
      decision: 'block',
      matched: [{ resource: 'dev:restart' }],
      substitutions: [SUB],
      substitutionTier: 'advise',
    });
    const hook = JSON.parse(run().stdout).hookSpecificOutput;
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain('resource-gate');
  });

  it('degrades to pre-P-016 behaviour when the payload carries no substitutions', () => {
    setReply({ decision: 'allow', matched: [] });
    expectAllow(run());
  });

  it('never wedges a command on a malformed substitutions payload', () => {
    setReply({ decision: 'allow', matched: [], substitutions: 'not-an-array', substitutionTier: 'advise' });
    const out = run();
    expect(out.status).toBe(0);
    if (out.stdout.trim()) {
      expect(JSON.parse(out.stdout).hookSpecificOutput.permissionDecision).toBe('allow');
    }
  });

  /**
   * The guard on the failure the tests above could not see.
   *
   * `locks:check_command` returns a tabular `substitutions[]`, so the agent
   * transport TOON-encodes it unless the CALLER declares what it can decode.
   * This gate parses with `json.loads`. When the declaration went missing the
   * parse threw, `inner` stayed None, and the mandatory fail-open silently
   * disabled BOTH answers this round-trip carries — every resource hold and
   * every substitution row — with no error in any log. It stayed that way
   * through a fully green suite, because the stub replied JSON unconditionally.
   *
   * So the stub now negotiates like the real operator, and this test states the
   * contract directly: a gate that does not say what it can read is a gate that
   * is not running. It is deliberately asserted on `deny` — the loudest tier —
   * because a silent fail-open is indistinguishable from "nothing matched".
   */
  it('declares a machine-parseable result format, without which it silently fails open', () => {
    const denyReply = {
      decision: 'allow' as const,
      matched: [],
      substitutions: [{ ...SUB, tier: 'deny' }],
      substitutionTier: 'deny',
    };
    setReply(denyReply);

    // Live path: the gate declares `_meta.format: 'json'`, so the stub answers
    // in JSON and the deny is enforced.
    expect(JSON.parse(run().stdout).hookSpecificOutput.permissionDecision).toBe('deny');

    // The counterfactual the stub now makes visible: an undeclared caller gets
    // TOON, which `json.loads` cannot read. Proven by asking the SAME stub the
    // way the pre-fix gate asked, and observing the payload it would parse.
    const undeclared = execFileSync(
      process.execPath,
      [
        '-e',
        `const b=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',
           params:{name:'locks:check_command',arguments:{command:'x'}}});
         fetch(process.argv[1],{method:'POST',headers:{'Content-Type':'application/json'},body:b})
           .then(r=>r.json()).then(j=>console.log(j.result.content[0].text));`,
        url,
      ],
      { encoding: 'utf8' },
    );
    expect(undeclared).toContain('format: toon');
    expect(() => JSON.parse(undeclared)).toThrow();
  });
});

describe('say-once advisory dedup (context-injection-audit P-020, D-030+D-031) — WI-6671 recurrence guard', () => {
  // The dedup that gates all 29 advisory classes shipped with no test of its
  // own, and its first version keyed the seen-set on tempfile.gettempdir():
  // machine-global, shared by every user/install/run on the box, and never
  // expired. Two defects followed — state leaked ACROSS hermetic fake $HOMEs
  // (26 gate failures, held `main`), and a recurring session id could suppress
  // an advisory ONCE AND FOR ALL on that box, the exact "silently swallow a
  // safety advisory" failure the dedup's own comment promises not to be.
  // Both are fixed; this block is what keeps them fixed.
  //
  // Vehicle: the long-foreground-exec advisory — soft (allow +
  // additionalContext), deterministic, and needs no operator round-trip.
  const SEEN_REL = ['.papercusp', 'advisory-seen'];

  const longFg = (sid: string) => ({
    tool_name: 'Bash',
    tool_input: { command: 'npm ci', timeout: 300_000 },
    session_id: sid,
  });

  /** True when the gate actually EMITTED the advisory rather than suppressing it. */
  const fired = (out: { stdout: string }) => {
    const s = out.stdout.trim();
    if (!s) return false; // silence = suppressed
    const ctx = JSON.parse(s).hookSpecificOutput?.additionalContext ?? '';
    return ctx.includes('run_in_background');
  };

  // A fresh $HOME per test — the seen-set is per-$HOME, so sharing one would
  // leak suppression between cases and hide exactly the bug under test.
  const makeHome = (prefix: string) => {
    const h = mkdtempSync(join(tmpdir(), prefix));
    const dir = join(h, '.papercusp');
    mkdirSync(dir, { recursive: true });
    // Same su-token files the suite's own fake $HOME carries, so the ONLY
    // difference between this home and the suite's is the thing under test.
    writeFileSync(join(dir, 'superuser-token'), 'test-token\n');
    writeFileSync(join(dir, 'su-agent-id'), 'test-agent\n');
    return h;
  };

  let home = '';
  beforeEach(() => {
    home = makeHome('gate-sayonce-');
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const run = (sid: string, h = home) => runGate(longFg(sid), { HOME: h, PAPERCUSP_SID: sid });

  it('says it ONCE per session — an identical repeat is suppressed', () => {
    expect(fired(run('s-once'))).toBe(true);
    expect(fired(run('s-once'))).toBe(false);
  });

  it('is per-SESSION, not per-box — a different session still hears it', () => {
    expect(fired(run('s-a'))).toBe(true);
    expect(fired(run('s-b'))).toBe(true);
  });

  it('keys the seen-set under $HOME, never machine-global /tmp', () => {
    run('s-home');
    expect(readdirSync(join(home, ...SEEN_REL))).toContain('s-home');
    // Where the original defect wrote. Nothing may recreate it.
    expect(existsSync(join(tmpdir(), 'papercusp-advisory-seen', 's-home'))).toBe(false);
  });

  it('does NOT leak across installs — the same session id under a SECOND $HOME still fires', () => {
    // THE regression. With a machine-global seen-set the second $HOME was
    // silently suppressed: that is what broke the hermetic-fake-$HOME contract
    // the whole hook suite is built on, and what reddened the gate 26x.
    const other = makeHome('gate-sayonce-alt-');
    try {
      expect(fired(run('s-shared'))).toBe(true);
      expect(fired(run('s-shared', other))).toBe(true);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('re-arms once the seen-set lapses — a recurring session id cannot suppress forever', () => {
    expect(fired(run('s-ttl'))).toBe(true);
    expect(fired(run('s-ttl'))).toBe(false);
    const seen = join(home, ...SEEN_REL, 's-ttl');
    const stale = Date.now() / 1000 - (24 * 3600 + 60); // just past the 24h TTL
    utimesSync(seen, stale, stale);
    expect(fired(run('s-ttl'))).toBe(true);
  });

  it('fails OPEN — an unusable seen-set emits rather than swallowing the advisory', () => {
    // A dedup bug must never silently swallow a safety advisory. Block the
    // directory with a regular file so every seen-set operation raises.
    writeFileSync(join(home, ...SEEN_REL), 'not a directory\n');
    expect(fired(run('s-failopen'))).toBe(true);
    expect(fired(run('s-failopen'))).toBe(true); // still emits, every time
  });
});

describe('cd + EXIT-trap/restore path-drift advisory (EI-19409854431997137)', () => {
  // Each test uses its own session id so the say-once dedup (tested above)
  // never suppresses a case this suite still expects to fire.
  let seq = 0;
  const nextTrapSid = () => `cdtrap-${process.pid}-${++seq}`;
  const cdtrapCmd = (command: string) => ({
    tool_name: 'Bash',
    tool_input: { command },
    session_id: 's-cdtrap',
  });
  const run = (command: string) =>
    runGate(cdtrapCmd(command), { PAPERCUSP_SID: nextTrapSid() });

  function expectAdvisory(out: { stdout: string; status: number | null }) {
    expect(out.status).toBe(0);
    const decision = parseDecision(out);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('allow'); // soft — never blocks
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('advisory');
    return (decision.hookSpecificOutput as { additionalContext?: string }).additionalContext ?? '';
  }

  it('fires for the full repro shape: cd + an EXIT trap capturing a pre-cd relative path', () => {
    const ctx = expectAdvisory(
      run(
        'cp "$F" /tmp/restore.ts\n' +
          `trap 'cp /tmp/restore.ts '"$F"'' EXIT\n` +
          'sed -i "s/x/y/" "$F"\n' +
          'cd apps/operator && npx vitest run app/adv/hud/hud-board-model.test.ts\n' +
          'cp /tmp/restore.ts "$F"',
      ),
    );
    expect(ctx).toContain('cd + restore-path drift advisory (EI-19409854431997137)');
    expect(ctx).toContain('an EXIT trap');
  });

  it('fires for a plain end-of-script restore (`cp` after the `cd`, no trap at all)', () => {
    const ctx = expectAdvisory(
      run(
        'F=path/to/file.ts\n' +
          'cp "$F" /tmp/restore.ts\n' +
          'cd apps/operator && npx vitest run x\n' +
          'cp /tmp/restore.ts "$F"',
      ),
    );
    expect(ctx).toContain('cd + restore-path drift advisory');
    expect(ctx).toContain('a `cp` after the cd');
  });

  it('fires for `mv` too, not only `cp`', () => {
    const ctx = expectAdvisory(
      run('cd apps/operator && npx vitest run x\nmv /tmp/restore.ts "$F"'),
    );
    expect(ctx).toContain('a `mv` after the cd');
  });

  // ── comment/quote parity (EI-19423080880635119) ──────────────────────────
  // `_quote_preserve_tokens` was the last comment-blind member of the
  // normalizer family fixed by EI-19420133701663526. It cannot cause a missed
  // DENY (it feeds only this advisory's positional-argument count), but an odd
  // quote inside a `#` comment made it pair that stray quote with the opening
  // quote of a real later argument — swallowing the restore `cp` entirely, so
  // the advisory went SILENT on exactly the shape it exists to catch.
  it('fires when a `#` comment carries an ODD quote (parity family — EI-19423080880635119)', () => {
    // Pre-fix trace: the comment's `"` opens a span that closes on the `"`
    // before `$F`, so `\ncp /tmp/restore.ts ` becomes one placeholder token —
    // no `cp` survives after the `cd`, and no advisory is emitted.
    const ctx = expectAdvisory(
      run('cd apps/operator && npx vitest run x   # note "\n' + 'cp /tmp/restore.ts "$F"'),
    );
    expect(ctx).toContain('a `cp` after the cd');
  });

  it("fires with an odd SINGLE quote in the comment too (both quote chars, not just `\"`)", () => {
    const ctx = expectAdvisory(
      run("cd apps/operator && npx vitest run x   # don't\n" + 'cp /tmp/restore.ts "$F"'),
    );
    expect(ctx).toContain('a `cp` after the cd');
  });

  // The two invariants a naive comments-then-quotes fix would break. Both hold
  // pre-fix; they are here so the fix cannot buy comment-awareness by
  // re-opening the hole the single-pass ordering exists to close.
  it('still counts arguments when a `#` sits INSIDE quotes (data, not a comment)', () => {
    // If the quoted `#` were read as a comment introducer it would swallow the
    // destination, dropping the count to 1 and silencing the advisory.
    const ctx = expectAdvisory(
      run('cd apps/operator && npx vitest run x\ncp "# not a comment" dest.ts'),
    );
    expect(ctx).toContain('a `cp` after the cd');
  });

  it('still counts arguments when `#` has no preceding whitespace (`a#b`, not a comment)', () => {
    const ctx = expectAdvisory(
      run('cd apps/operator && npx vitest run x\ncp /tmp/re#store.ts dest.ts'),
    );
    expect(ctx).toContain('a `cp` after the cd');
  });

  it('does NOT fire for a bare `cd` with no trap or restore at all', () => {
    expectAllow(run('cd apps/operator && npx vitest run x'));
  });

  it('does NOT fire for the initial backup `cp` BEFORE the cd (nothing follows it)', () => {
    expectAllow(run('cp "$F" /tmp/restore.ts\ncd apps/operator && npx vitest run x'));
  });

  it('does NOT fire when the whole thing is scoped inside a subshell (the recommended fix)', () => {
    expectAllow(
      run(
        'cp "$F" /tmp/restore.ts\n' +
          `trap 'cp /tmp/restore.ts '"$F"'' EXIT\n` +
          '( cd apps/operator && npx vitest run x )\n' +
          'cp /tmp/restore.ts "$F"',
      ),
    );
  });

  it('does NOT fire when the restore variable is anchored absolutely (the OTHER recommended fix)', () => {
    expectAllow(
      run(
        'F=$(git rev-parse --show-toplevel)/path/to/file.ts\n' +
          'cd apps/operator && npx vitest run x\n' +
          'cp /tmp/restore.ts "$F"',
      ),
    );
  });

  it('does NOT fire when the cp/mv destination is already a literal absolute path', () => {
    expectAllow(
      run(
        'cd apps/operator && npx vitest run x\n' +
          'cp /tmp/restore.ts /some/absolute/repo/apps/operator/app/adv/hud/hud-board-model.test.ts',
      ),
    );
  });

  it('does NOT fire on an ordinary unrelated command', () => {
    expectAllow(run('ls -la apps/operator'));
  });

  it('does NOT fire for a `cd` followed only by `git checkout --` (cp/mv-only scan, by design)', () => {
    expectAllow(
      run('cd apps/operator && npx vitest run x\ngit checkout -- app/adv/hud/hud-board-model.test.ts'),
    );
  });
});

// ── ancestor-chain kill guard (WI-36926) ────────────────────────────────────
// The owner lost their GNOME session on 2026-08-08 11:52:49 EDT to an agent's
// ad-hoc rig teardown: it walked its app's ancestor chain stopping at pid 1 —
// which INCLUDES `systemd --user`, whose PPID *is* 1 — and SIGTERM'd it. A
// SIGTERM to a user systemd manager activates exit.target, i.e. a logout.
// No repo library could have caught this one: the command was typed by an agent
// and never committed, so this gate is the only chokepoint it passed through.
describe('ancestor-chain kill guard (WI-36926)', () => {
  const gate = (command: string) =>
    runGate({
      tool_name: 'Bash',
      tool_input: { command },
      cwd: process.cwd(),
      session_id: 'wi36926',
    });

  it('DENIES the verbatim 2026-08-08 command that logged the owner out', () => {
    const decision = parseDecision(
      gate(
        'cd /repo || exit 1\n' +
          'APP=$(cat "$SP/app2.pid")\n' +
          "# walk MY app's ancestor chain, stopping before systemd — exact pids only\n" +
          'CHAIN="$APP"; P=$(ps -o ppid= -p "$APP" 2>/dev/null | tr -d \' \')\n' +
          'while [ -n "$P" ] && [ "$P" != "1" ]; do CHAIN="$CHAIN $P"; ' +
          'P=$(ps -o ppid= -p "$P" 2>/dev/null | tr -d \' \'); done\n' +
          'for p in $CHAIN $OP $XV; do kill "$p" 2>/dev/null && echo "TERM $p"; done',
      ),
    );
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    // The reason must name the MECHANISM, not merely say "blocked" — an agent that
    // does not learn why reaches for the same shape again on the next turn.
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('systemd --user');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('session-floor');
  });

  it('DENIES the /proc/<pid>/status variant of the same walk', () => {
    const decision = parseDecision(
      gate(
        'cur=$$; while :; do cur=$(awk \'/^PPid:/{print $2}\' /proc/$cur/status); ' +
          '[ "$cur" != "1" ] || break; kill -9 $cur; done',
      ),
    );
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  // Calibration. All three signals (walk + stop-at-1 + signal) are required
  // together, so the guard must stay SILENT on each alone — a guard that denies
  // routine teardown gets worked around, which is worse than not existing.
  it('ALLOWS killing a recorded pid (no ancestor walk)', () => {
    expectAllow(gate('PID=$(cat /tmp/myapp.pid); kill "$PID" 2>/dev/null || true; echo done'));
  });

  it('ALLOWS a read-only ancestor walk that signals nothing', () => {
    expectAllow(
      gate(
        'cur=$$; while [ "$cur" != "1" ]; do echo "$cur"; cur=$(ps -o ppid= -p "$cur" | tr -d \' \'); done',
      ),
    );
  });

  it('ALLOWS `kill -0` liveness probing along the chain', () => {
    expectAllow(
      gate(
        'cur=$$; while [ "$cur" != "1" ]; do kill -0 "$cur" 2>/dev/null && echo alive; ' +
          'cur=$(ps -o ppid= -p "$cur" | tr -d \' \'); done',
      ),
    );
  });
});

describe('schema skew between the hook and the deployed tool (WI-40602)', () => {
  // THE FAILURE THIS PINS DOWN, because a green suite already hid it once:
  // this hook is read LIVE from the staging tree, while `locks:check_command`
  // is served by the release checkout pinned to green `main`. Staging commit
  // 8b824cae7f added a `cwd` argument to both halves; the client half went live
  // instantly, the server half could not promote behind a red gate, and every
  // call was rejected `Unrecognized key: "cwd"`. An error envelope carries no
  // `result`, so all 549 of them (8 agents, ~4h) fell through to the fail-open
  // allow() — the resource gate stopped blocking real collisions and NOTHING
  // surfaced it.
  //
  // This case is the CONTROL: point the gate at an operator that rejects `cwd`
  // exactly as the deployed one does, and hand it a decision it MUST act on.
  // Against the pre-fix hook it fails (allow), which is the only reason it is
  // worth having — the 805 assertions around it passed identically before and
  // after the fix and so could not tell a working gate from an inert one.
  let child: ReturnType<typeof spawn>;
  let url = '';
  let requestFile = '';

  beforeAll(async () => {
    requestFile = join(fakeHome, 'skew-requests.jsonl');
    writeFileSync(requestFile, '');
    const serverJs = join(fakeHome, 'skew-operator.mjs');
    writeFileSync(
      serverJs,
      `import { createServer } from 'node:http';
       import { appendFileSync } from 'node:fs';
       const s = createServer((req, res) => {
         let raw = '';
         req.on('data', (c) => { raw += c; });
         req.on('end', () => {
           appendFileSync(process.argv[2], raw + '\\n');
           let hasCwd = false;
           try {
             const a = JSON.parse(raw)?.params?.arguments ?? {};
             hasCwd = Object.prototype.hasOwnProperty.call(a, 'cwd');
           } catch {}
           if (hasCwd) {
             // Byte-for-byte the deployed operator's refusal: HTTP 200 with
             // a truthy MCP result whose isError flag carries the rejection.
             res.writeHead(200, { 'Content-Type': 'application/json' });
             res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {
               content: [{ type: 'text', text:
                 'invalid_input: invalid_args: Unrecognized key: "cwd" — this tool accepts ONLY: command.' }],
               isError: true } }));
             return;
           }
           res.writeHead(200, { 'Content-Type': 'application/json' });
           res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text',
             text: JSON.stringify({ ok: true, decision: 'block', matched: [{ resource: 'dev:restart' }] }) }] } }));
         });
       });
       s.listen(0, '127.0.0.1', () => console.log('PORT=' + s.address().port));`,
    );

    child = spawn(process.execPath, [serverJs, requestFile], { stdio: ['ignore', 'pipe', 'ignore'] });
    url = await new Promise<string>((ok, fail) => {
      const t = setTimeout(() => fail(new Error('skew operator did not start')), 10_000);
      child.stdout!.on('data', (b: Buffer) => {
        const m = /PORT=(\d+)/.exec(String(b));
        if (m) {
          clearTimeout(t);
          ok(`http://127.0.0.1:${m[1]}`);
        }
      });
    });
  });

  afterAll(() => {
    child?.kill();
  });

  it('still enforces a resource BLOCK when the deployed tool rejects `cwd`', () => {
    writeFileSync(requestFile, '');
    const out = runGate(bashCmd('cat packages/operator-core/lib/foo.ts'), {
      PAPERCUSP_OPERATOR_URL: url,
    });
    const hook = JSON.parse(out.stdout).hookSpecificOutput;
    // Pre-fix this reads 'allow': the rejection produced no `result` and the
    // gate fell straight through to fail-open.
    expect(hook.permissionDecision).toBe('deny');
    expect(hook.permissionDecisionReason).toContain('resource-gate');
  });

  it('sends `cwd` first and only DROPS it on the rejection, so the arg is not abandoned', () => {
    writeFileSync(requestFile, '');
    runGate(bashCmd('cat packages/operator-core/lib/foo.ts'), { PAPERCUSP_OPERATOR_URL: url });
    const sent = readFileSync(requestFile, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).params.arguments);

    // Exactly two: the optimistic call, then the degraded retry. A third would
    // mean the retry itself is looping.
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveProperty('cwd');
    expect(sent[1]).not.toHaveProperty('cwd');
    // The retry must still carry the thing actually being judged.
    expect(sent[1].command).toContain('cat packages/operator-core/lib/foo.ts');
  });
});

describe('tauri-agent-tools screenshot window-resolution advisory (EI-21383660965482252)', () => {
  const bashWithInput = (command: string, sid: string) => ({
    tool_name: 'Bash',
    tool_input: { command },
    session_id: sid,
  });

  it('advises even when --pid is explicit — the pid aims the bridge, not the pixel grab', () => {
    const out = runGate(
      bashWithInput(
        'tauri-agent-tools screenshot --pid 3593460 --selector body --out /tmp/shot.png',
        's-tat-screenshot-1',
      ),
    );
    expect(out.status).toBe(0);
    const hso = JSON.parse(out.stdout).hookSpecificOutput;
    expect(hso.permissionDecision).toBe('allow'); // soft — command proceeds
    expect(hso.additionalContext).toContain('screenshot advisory (EI-21383660965482252)');
    expect(hso.additionalContext).toContain('capability:computer screenshot');
    expect(hso.additionalContext).toContain('EI-11084');
  });

  it('stays quiet for non-screenshot tat subcommands', () => {
    const out = runGate(
      bashWithInput("tauri-agent-tools eval --pid 3593460 'document.title'", 's-tat-screenshot-2'),
    );
    expect(out.status).toBe(0);
    // The gate may ALLOW silently (empty stdout) — the assertion is about the
    // advisory being ABSENT, whichever allow shape this command took.
    const ctx = out.stdout.trim()
      ? ((JSON.parse(out.stdout).hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext ?? '')
      : '';
    expect(ctx).not.toContain('screenshot advisory (EI-21383660965482252)');
  });
});

describe('bytecode cache degrades to SLOW, never to OFF (EI-20226903620041425)', () => {
  // This wrapper ends in `|| exit 0` — it fails OPEN. So the risk the cache
  // introduces is not a crash, it is SILENT non-gating: a cache bug that skipped
  // the body would allow every command, with no error anywhere and no symptom to
  // notice. That failure is invisible by construction, which is exactly why it
  // has to be asserted rather than observed.
  //
  // The shipped design routes around it: the try/except covers only cache
  // PREPARATION and picks the execution route BEFORE any body code runs, so a
  // broken cache falls back to exec(compile(src)) — the pre-cache behaviour.
  const cacheEnvIn = (dir: string) => ({ ...AGENT, XDG_CACHE_HOME: dir });
  const freshCacheRoot = () => mkdtempSync(join(tmpdir(), 'gate-pycache-'));
  const soleModuleIn = (dir: string) => {
    const mods = readdirSync(dir).filter((f) => f.startsWith('pcgate_') && f.endsWith('.py'));
    expect(mods, `expected exactly one cached module in ${dir}`).toHaveLength(1);
    return join(dir, mods[0]!);
  };

  // ── CALIBRATION. Without this, every fallback case below would pass just as
  // happily if the cache NEVER worked at all — they would all be quietly
  // exercising the same single path. This is the case that fails if the speedup
  // itself breaks, which is what makes the others mean anything.
  it('CALIBRATION: a normal run materializes the module AND its .pyc', () => {
    const root = freshCacheRoot();
    try {
      expectDeny(runGate(bashCmd('crontab -e'), cacheEnvIn(root)));
      const dir = join(root, 'papercusp-hooks');
      soleModuleIn(dir);
      // The .pyc IS the point: CPython writes one only for an IMPORTED module,
      // never for __main__ — which is why `python3 -c 'import …'` is load-bearing
      // and `python3 script.py` would not do. If this is empty the gate is still
      // correct but has silently reverted to recompiling ~291KB per bash call.
      const pyc = readdirSync(join(dir, '__pycache__')).filter((f) => f.endsWith('.pyc'));
      expect(pyc, 'no .pyc — the cache is not actually caching').toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still DENIES when the cache directory cannot be created (XDG_CACHE_HOME is a file)', () => {
    const root = freshCacheRoot();
    const asFile = join(root, 'not-a-dir');
    writeFileSync(asFile, '');
    try {
      expectDeny(runGate(bashCmd('crontab -e'), cacheEnvIn(asFile)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still DENIES when the cache directory is read-only', () => {
    const root = freshCacheRoot();
    const dir = join(root, 'papercusp-hooks');
    try {
      mkdirSync(dir, { recursive: true });
      chmodSync(dir, 0o500);
      expectDeny(runGate(bashCmd('crontab -e'), cacheEnvIn(root)));
    } finally {
      try { chmodSync(dir, 0o700); } catch { /* never created */ }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still DENIES when the cached module is TRUNCATED, and REPAIRS it', () => {
    const root = freshCacheRoot();
    try {
      expectDeny(runGate(bashCmd('crontab -e'), cacheEnvIn(root))); // populate
      const mod = soleModuleIn(join(root, 'papercusp-hooks'));
      const whole = readFileSync(mod);
      writeFileSync(mod, whole.subarray(0, 5000));
      expectDeny(runGate(bashCmd('crontab -e'), cacheEnvIn(root)));
      // Verify-or-rewrite, not bypass-forever: one bad write (a crashed or
      // ENOSPC-d peer) must not cost this box the speedup permanently, silently.
      expect(readFileSync(mod).length, 'the corrupt entry should be repaired').toBe(whole.length);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The filename is content-addressed, which proves what the file was CALLED,
  // not what it CONTAINS. Size alone is insufficient: this rewrite keeps the byte
  // count identical, so only a genuine re-hash rejects it. If the check were
  // weakened back to a size compare, a same-length body would execute AS the gate.
  it('rejects a SAME-LENGTH tampered cache entry and still DENIES', () => {
    const root = freshCacheRoot();
    try {
      expectDeny(runGate(bashCmd('crontab -e'), cacheEnvIn(root))); // populate
      const mod = soleModuleIn(join(root, 'papercusp-hooks'));
      const size = readFileSync(mod).length;
      // Valid python that would ALLOW everything, padded to the exact same size.
      const evil = 'import sys;sys.exit(0)#';
      writeFileSync(mod, evil + ' '.repeat(size - evil.length));
      expect(readFileSync(mod).length, 'the tamper must be same-length or this proves nothing').toBe(size);
      // ⚠ WITHOUT THIS LINE THIS TEST PASSES FOR THE WRONG REASON, and a mutation
      // probe proved it: CPython validates a .pyc against its source's mtime+size at
      // ONE-SECOND granularity, so a same-length rewrite inside the same second leaves
      // the ORIGINAL bytecode looking valid. The honest gate then never even reads the
      // tampered source, the assertion below passes, and the hash check it is supposed
      // to be exercising is never reached — the guard survives a gate with NO hash
      // verification at all. Ageing the source past the .pyc is what forces the import
      // machinery to go back to the (tampered) file, which is the only state in which
      // the pre-import re-hash is load-bearing. Do not remove this as a stray sleep.
      const stale = Date.now() / 1000 + 10;
      utimesSync(mod, stale, stale);
      expectDeny(runGate(bashCmd('crontab -e'), cacheEnvIn(root)));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('unbounded symlink-following walk guard (WI-10000836)', () => {
  // Measured 2026-09-08: `find -L ~/.papercusp -name …` ran 32h, 70 GB RSS +
  // 1.86 TB swap, thrashed the host. The guard denies `-L`/`-follow` from a
  // broad root with no `-maxdepth` and no `node_modules … -prune`.
  //
  // Family-local deny helper: the shared `expectDeny` above belongs to the
  // native-scheduler family (it pins the `pot:declare-wake` redirect in the
  // reason text); this family's reason must instead name its own guard so a
  // denied agent can find the incident and the safe forms.
  function expectLwalkDeny(out: GateOut) {
    expect(out.status, describeGateExit(out)).toBe(0); // deny is exit 0 + decision JSON (hook protocol)
    const decision = parseDecision(out);
    expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain(
      'unbounded symlink-following walk guard (WI-10000836)',
    );
    // The reason must carry the safe forms, not just the refusal.
    expect(decision.hookSpecificOutput.permissionDecisionReason).toContain('-name node_modules -prune');
  }
  it('denies `find -L ~/.papercusp` with no bound (the measured incident shape)', () => {
    expectLwalkDeny(runGate(bashCmd('find -L ~/.papercusp -name additional-states.json -o -name phone-disabled.png')));
  });
  it('denies the bfs spelling, the -follow spelling, and the $HOME / workspace roots', () => {
    expectLwalkDeny(runGate(bashCmd(`bfs -L ${fakeHome}/papercupai-workspace -name x`)));
    expectLwalkDeny(runGate(bashCmd(`find ${fakeHome}/.papercusp -name x -follow`)));
    expectLwalkDeny(runGate(bashCmd(`find -L ${fakeHome} -name x`)));
  });
  it('allows the same walk once bounded by -maxdepth or a node_modules prune', () => {
    expectAllow(runGate(bashCmd('find -L ~/.papercusp -maxdepth 4 -name x')));
    expectAllow(runGate(bashCmd('find -L ~/papercupai-workspace -name node_modules -prune -o -name x -print')));
  });
  it('allows -L on a narrow root (one checkout) and a bare find on the broad root (the sibling guard owns that shape)', () => {
    expectAllow(runGate(bashCmd(`find -L ${fakeHome}/papercupai-workspace/papercusp/scripts -name x`)));
    expectAllow(runGate(bashCmd('find ~/.papercusp -name x')));
  });
});
