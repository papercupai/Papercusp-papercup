import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MCP_TRANSPORT_CAP_MS,
  FOREGROUND_RESPONSE_HEADROOM_MS,
  FOREGROUND_TERMINATION_GRACE_MS,
  FOREGROUND_TIMEOUT_CEILING_MS,
  clampForegroundTimeoutMs,
  foregroundTimeoutHint,
  foregroundClampDisclosure,
} from './foreground-transport-cap';

// EI-6073 / EI-20645849301780712 — a FOREGROUND tool call that outruns the ~55s MCP transport
// cap is abandoned by the CLIENT with a generic failure, which is the SAME token a real non-zero
// exit produces. The agent then cannot tell "my command failed" from "the transport gave up", and
// because no abort reaches the child the command may still have run to completion invisibly.
// Foreground-only tools clamp BELOW the cap so the tool self-times-out first. capability:bash
// now uses the stronger start-once design: the same ceiling bounds only its response wait, and
// the original durable job continues. These tests pin both permitted transport-safe shapes.

// The subject root is overridable so falsifiability can be proven against a MUTATED COPY outside
// the tree (scripts/mutation-probe.sh tier 2) instead of by editing the shared checkout, which a
// git-sync sweep can commit mid-probe.
const TOOLS_DIR = process.env.PROBE_AGENT_TOOLS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), '..');

describe('clampForegroundTimeoutMs — keep a foreground run under the MCP transport cap (EI-6073)', () => {
  it('caps the ceiling below the transport cap (with serialize headroom)', () => {
    expect(FOREGROUND_TIMEOUT_CEILING_MS).toBeLessThan(MCP_TRANSPORT_CAP_MS);
  });

  // The ceiling and the cap are two numbers that must stay apart; a "just bump it a bit" edit
  // that leaves the ceiling technically-below the cap but with no room to serialize a response
  // re-opens the same dead window more subtly. Require real headroom, not mere inequality.
  it('leaves at least 3s of headroom to serialize the response', () => {
    expect(MCP_TRANSPORT_CAP_MS - FOREGROUND_TIMEOUT_CEILING_MS).toBeGreaterThanOrEqual(3_000);
  });

  it('clamps a request ABOVE the ceiling down to it (the operator-core 120s default case)', () => {
    expect(clampForegroundTimeoutMs(120_000)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
    expect(clampForegroundTimeoutMs(600_000)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
  });

  it('leaves a request BELOW the ceiling untouched (a fast package is unaffected)', () => {
    expect(clampForegroundTimeoutMs(5_000)).toBe(5_000);
    expect(clampForegroundTimeoutMs(FOREGROUND_TIMEOUT_CEILING_MS)).toBe(FOREGROUND_TIMEOUT_CEILING_MS);
  });
});

describe('foreground timeout cleanup headroom (EI-22536928771275862)', () => {
  it('derives the ceiling from cleanup grace and response-delivery headroom', () => {
    expect(FOREGROUND_TERMINATION_GRACE_MS).toBeGreaterThan(0);
    expect(FOREGROUND_RESPONSE_HEADROOM_MS).toBeGreaterThanOrEqual(3_000);
    expect(FOREGROUND_TIMEOUT_CEILING_MS).toBe(
      MCP_TRANSPORT_CAP_MS - FOREGROUND_TERMINATION_GRACE_MS - FOREGROUND_RESPONSE_HEADROOM_MS,
    );
    expect(FOREGROUND_TIMEOUT_CEILING_MS).toBe(45_000);
  });

  it('uses the shared termination grace for process-tree escalation', () => {
    const runSrc = readFileSync(join(TOOLS_DIR, 'testing', 'run.ts'), 'utf8');
    expect(runSrc).toContain('FOREGROUND_TERMINATION_GRACE_MS');
    expect(runSrc).not.toMatch(/setTimeout\(\(\) => killGroup\('SIGKILL'\), 5000\)/);
  });
});

describe('foregroundTimeoutHint — actionable hint on a clamped timeout (EI-6073)', () => {
  const RERUN = 'capability:bash { …same command…, run_in_background: true }';

  it('on a timed_out status → points to run_in_background + bash_output', () => {
    const h = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS, RERUN);
    expect(h).toMatch(/run_in_background/);
    expect(h).toMatch(/capability:bash_output/);
    expect(h).toContain(`${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s`); // the clamped ceiling, human-readable
  });

  it("carries the CALLER's own re-run invocation, not a hardcoded sibling tool's", () => {
    const asBash = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS, RERUN);
    expect(asBash).toContain('capability:bash {');
    const asInspect = foregroundTimeoutHint(
      'timed_out',
      FOREGROUND_TIMEOUT_CEILING_MS,
      'capability:inspect { …same args…, run_in_background: true }',
    );
    expect(asInspect).toContain('capability:inspect {');
    expect(asInspect).not.toContain('capability:bash {');
  });

  // EI-20645849301780712 was filed as "I could not tell whether the command was still running".
  // Saying so is the whole point of the hint, so assert it rather than trusting the prose.
  it('states the process tree was KILLED — the ambiguity the item was filed about', () => {
    const h = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS, RERUN);
    expect(h).toMatch(/KILLED/);
    expect(h).toMatch(/nothing is still running/i);
  });

  it('is EMPTY for any non-timeout status (completed / failed / killed) — no false hint', () => {
    expect(foregroundTimeoutHint('completed', FOREGROUND_TIMEOUT_CEILING_MS, RERUN)).toBe('');
    expect(foregroundTimeoutHint('failed', FOREGROUND_TIMEOUT_CEILING_MS, RERUN)).toBe('');
    expect(foregroundTimeoutHint('killed', FOREGROUND_TIMEOUT_CEILING_MS, RERUN)).toBe('');
  });

  // EI-21903653840648934 — a /proc IO-counter scan piped through a final `sort` stage was
  // killed at the foreground cap and returned LITERALLY ZERO output, which read as "the
  // capture is broken" rather than "the pipeline's own last stage never got to emit anything".
  // Reproduced directly: `for i in ...; do echo ...; sleep .5; done | sort -rn` under a 3s
  // foreground cap returns `(no output)` even though six lines were produced upstream of the
  // buffering `sort`. The hint now names the actual mechanism so the NEXT agent restructures
  // the pipeline instead of filing this as a capture defect a fourth time.
  it('names the end-of-pipeline BUFFERING trap that can make partial output look like NO output', () => {
    const h = foregroundTimeoutHint('timed_out', FOREGROUND_TIMEOUT_CEILING_MS, RERUN);
    expect(h).toMatch(/BUFFERS until/);
    expect(h).toMatch(/EOF/);
    expect(h).toMatch(/sort/);
    expect(h).toMatch(/read time, never launch time/i);
  });
});

describe('foregroundClampDisclosure — the clamp must SAY it clamped (EI-21570021207351896)', () => {
  const REQUESTED = 120_000;

  it('names BOTH the requested budget and the effective one — the pair is the whole point', () => {
    const d = foregroundClampDisclosure(REQUESTED, FOREGROUND_TIMEOUT_CEILING_MS);
    expect(d).toContain('120s'); // what the caller asked for
    expect(d).toContain(`${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s`); // what was actually in force
  });

  // Both items were filed as "I requested 120 and was killed at the foreground ceiling". The specific dead end
  // was concluding the deadline had been honoured and the SCRIPT was simply too slow. Say the
  // opposite out loud, and say that retrying bigger is futile — otherwise the natural next move
  // is timeoutSec:120 again, which changes nothing.
  it('states the requested deadline was never in force, and that raising it will not help', () => {
    const d = foregroundClampDisclosure(REQUESTED, FOREGROUND_TIMEOUT_CEILING_MS);
    expect(d).toMatch(/never in force/i);
    expect(d).toMatch(/will NOT buy more time/i);
  });

  // The disposition claim that would have been WRONG here. capability:bash/inspect own their
  // child and may truthfully say it was killed; code:run's worker dies while a host-side facade
  // call may still be settling, so borrowing that sentence would assert a falsehood about
  // in-flight writes. Pin the absence so a future "let's just reuse the hint" edit fails here.
  it('does NOT claim the process tree was killed — untrue for code:run (EI-20282336542235171)', () => {
    const d = foregroundClampDisclosure(REQUESTED, FOREGROUND_TIMEOUT_CEILING_MS);
    expect(d).not.toMatch(/KILLED/);
    expect(d).not.toMatch(/nothing is still running/i);
  });

  it('is EMPTY when the request was NOT clamped — an honest budget carries no notice', () => {
    expect(foregroundClampDisclosure(5_000, 5_000)).toBe('');
    expect(foregroundClampDisclosure(FOREGROUND_TIMEOUT_CEILING_MS, FOREGROUND_TIMEOUT_CEILING_MS)).toBe('');
  });

  it('also covers the testing:run-sized 900s request', () => {
    const disclosure = foregroundClampDisclosure(900_000, FOREGROUND_TIMEOUT_CEILING_MS);
    expect(disclosure).toContain('you requested 900s');
    expect(disclosure).toContain(`effective budget was ${FOREGROUND_TIMEOUT_CEILING_MS / 1000}s`);
  });

  // CALIBRATION (permanent control): the assertions above must be able to FAIL. A disclosure that
  // omitted the requested budget — the exact shape that shipped, where only the effective ceiling
  // ever reached the caller — must be rejected by the same checks.
  it('the same assertions REJECT a disclosure that omits the REQUESTED budget', () => {
    const effectiveOnly = 'script_timeout after 45000ms';
    expect(effectiveOnly).toContain('45'); // passes — this is what shipped
    expect(effectiveOnly).not.toContain('120s'); // ← the real guard would fail here
    expect(effectiveOnly).not.toMatch(/never in force/i); // ← and here
  });
});

/**
 * EI-21570021207351896 / EI-21569537333182760 — code:run CLAMPS but must also DISCLOSE.
 *
 * The class guard below proves every foreground tool APPLIES the clamp; it never asked whether
 * the clamp is visible to the caller, which is why code:run passed it for as long as it did while
 * silently lowering a published 1..120 budget to 50s. This is scoped to code:run deliberately:
 * capability:inspect discloses through `foregroundTimeoutHint`, while capability:bash no longer
 * kills at the response boundary. That helper's "process tree was KILLED" wording is therefore
 * not a universal foreground claim, so a single shared assertion would be false.
 */
describe('code:run discloses the clamp on the failure envelope (EI-21570021207351896)', () => {
  const runSrc = readFileSync(join(TOOLS_DIR, 'code/run.ts'), 'utf8');

  it('imports the disclosure from the shared module and calls it', () => {
    expect(runSrc).toMatch(/foregroundClampDisclosure/);
    expect(runSrc).toMatch(/foregroundClampDisclosure\(/);
  });

  // The teeth: the pre-fix form collapsed requested and effective into ONE expression, which is
  // precisely why nothing downstream could report the difference. A revert restores it.
  it('keeps the requested and effective budgets as SEPARATE values', () => {
    expect(runSrc).toMatch(/requestedTimeoutMs/);
    expect(runSrc).toMatch(/effectiveTimeoutMs/);
    expect(runSrc, 'the inline clamp collapses the pair — the disclosure then has nothing to compare').not.toMatch(
      /timeoutMs:\s*args\.timeoutSec\s*\?\s*clampForegroundTimeoutMs\(/,
    );
  });

  it('the arg description leads with the EFFECTIVE ceiling, not the accepted max', () => {
    expect(runSrc).toMatch(/EFFECTIVE CEILING IS/);
  });
});

/**
 * EI-18776865728050036 / EI-20645849301780712 — the CLASS guard, not a per-tool patch.
 *
 * A tool dispatched FOREGROUND over the papercusp-su MCP transport gets ~55s (EI-6073). A tool
 * that declares a longer budget cannot honour it: the transport kills the call first and the
 * agent sees `MCP error -32603: write CONNECTION_CLOSED 127.0.0.1:6432` — an error naming the
 * DATABASE, which sends them off debugging PG. Measured: build:typecheck on packages/operator-core
 * (104.4s) failed 3/3 while libs/flags (2.1s) passed on the identical path.
 *
 * This guard EXISTED before capability:bash was fixed, and still did not catch it — because it
 * lived in `build/typecheck.test.ts` and enumerated only `build/typecheck.ts` + `testing/run.ts`.
 * A class guard whose list is incomplete reads exactly like a passing one. Two things changed
 * here: it now lives beside the module it guards (so the list is findable from the thing being
 * enumerated), and the list is complete. The lesson is the list, not the assertions — when you
 * add a foreground-capable tool, ADD THE ROW; that is the entire point.
 */
const FOREGROUND_CAPABLE_TOOLS = ['capability/inspect.ts', 'testing/run.ts', 'build/typecheck.ts', 'code/run.ts'];

describe('capability:bash uses start-once response yield instead of an execution clamp (P-002)', () => {
  const bashSrc = readFileSync(join(TOOLS_DIR, 'capability/bash.ts'), 'utf8');

  it('starts through the existing durable job seam exactly once in the handler source', () => {
    expect(bashSrc.match(/\bstartBackground\(/g)).toHaveLength(1);
    expect(bashSrc).toMatch(/await waitForJobResponse\(/);
    expect(bashSrc).not.toMatch(/\brunForeground\(/);
  });

  it('uses the transport-safe ceiling as a response window, not the execution timeout', () => {
    expect(bashSrc).toContain('yield_after_ms');
    expect(bashSrc).toMatch(/responseWindowMs\s*=\s*args\.yield_after_ms\s*\?\?\s*FOREGROUND_TIMEOUT_CEILING_MS/);
    expect(bashSrc).toMatch(/startBackground\([\s\S]*?executionTimeoutMs/);
    expect(bashSrc).not.toMatch(/executionTimeoutMs\s*=\s*clampForegroundTimeoutMs/);
  });

  it('returns the same durable handles when the response window elapses', () => {
    expect(bashSrc).toMatch(/bash_id:\s*job\.id/);
    expect(bashSrc).toMatch(/task_id:\s*job\.taskId/);
    expect(bashSrc).toMatch(/response yield did NOT restart or kill the command/);
  });
});

describe('every foreground-capable tool applies the clamp (EI-20645849301780712)', () => {
  it('clamping a budget far above the cap still lands below it', () => {
    // 900_000 is MAX_TIMEOUT_MS on build:typecheck / testing:run — the worst case a caller can ask
    // for; 600_000 was capability:bash's, and the one the transport could never actually deliver.
    expect(clampForegroundTimeoutMs(900_000)).toBeLessThan(MCP_TRANSPORT_CAP_MS);
    expect(clampForegroundTimeoutMs(600_000)).toBeLessThan(MCP_TRANSPORT_CAP_MS);
  });

  it.each(FOREGROUND_CAPABLE_TOOLS)('%s imports the clamp from the shared module and calls it', (rel) => {
    const src = readFileSync(join(TOOLS_DIR, rel), 'utf8');

    // Imported from the ONE shared module — not re-derived, and not reached for by importing a
    // peer tool (the shape that hid the bash miss in the first place).
    expect(src, `${rel} must import from capability/foreground-transport-cap`).toMatch(
      /from '(\.|\.\.)\/(capability\/)?foreground-transport-cap'/,
    );
    // ...and actually APPLIED, not merely imported for its description string. build:typecheck
    // and testing:run interpolate FOREGROUND_TIMEOUT_CEILING_MS into their arg docs, so an
    // import-only assertion would pass for a tool that never clamps a single run.
    expect(src, `${rel} must CALL clampForegroundTimeoutMs, not just import it`).toMatch(/clampForegroundTimeoutMs\(/);
    // Nobody may re-declare the constants locally and drift from the shared pair.
    expect(src, `${rel} must not redeclare the transport constants`).not.toMatch(
      /(const|let)\s+(MCP_TRANSPORT_CAP_MS|FOREGROUND_TIMEOUT_CEILING_MS)\s*=/,
    );
    // The teeth: the UN-CLAMPED form is what shipped in each of these and what a revert would
    // restore — the raw requested budget assigned straight to the value handed to the spawn.
    // Covers both arg spellings in play (`args.timeout` in capability:bash, `args.timeoutMs`
    // in build:typecheck / testing:run).
    expect(src, `${rel} passes its raw default straight to the spawn — the transport will kill it`).not.toMatch(
      /const\s+timeoutMs\s*=\s*args\.timeout(Ms)?\s*\?\?/,
    );
    // A timeout that names no escape route is how an agent ends up hand-rolling `npx tsc -p .`
    // — which checks ZERO files here and reads as clean.
    expect(src, `${rel} timeout branch must point at the detached run`).toMatch(/run_in_background/);
  });

  // CALIBRATION (permanent control): the assertions above must be capable of FAILING. A guard
  // that has only ever seen passing input is not evidence. These deliberately-wrong sources stay
  // in the test file so the check is proven falsifiable on every run, with no tree mutation.
  it('the same assertions REJECT a tool that imports the clamp but never calls it', () => {
    const importOnly =
      `import { FOREGROUND_TIMEOUT_CEILING_MS } from './foreground-transport-cap';\n` +
      `const timeoutMs = args.timeout ?? 120_000;\n`;
    expect(importOnly).toMatch(/from '(\.|\.\.)\/(capability\/)?foreground-transport-cap'/);
    expect(importOnly).not.toMatch(/clampForegroundTimeoutMs\(/); // ← the real guard would fail here
  });

  it('the same assertions REJECT a tool that redeclares the ceiling locally', () => {
    const redeclared = `const FOREGROUND_TIMEOUT_CEILING_MS = 240_000;\n`;
    expect(redeclared).toMatch(/(const|let)\s+FOREGROUND_TIMEOUT_CEILING_MS\s*=/); // ← would fail
  });
});

describe('testing:run discloses its requested/effective timeout pair', () => {
  const runSrc = readFileSync(join(TOOLS_DIR, 'testing', 'run.ts'), 'utf8');

  it('keeps the caller budget separate and wires the shared disclosure onto timeout hints', () => {
    expect(runSrc).toContain('const requestedTimeoutMs = args.timeoutMs;');
    expect(runSrc).toContain('clampTestingRunForegroundTimeoutMs(requestedTimeoutMs ?? DEFAULT_TIMEOUT_MS)');
    expect(runSrc).toMatch(/clampForegroundTimeoutMs\(requestedTimeoutMs\)/);
    expect(runSrc).toMatch(/testingRunTimeoutClampDisclosure\(requestedTimeoutMs, timeoutMs\)/);
    expect(runSrc).toMatch(/foregroundClampDisclosure\(requestedTimeoutMs, effectiveTimeoutMs\)/);
  });
});
