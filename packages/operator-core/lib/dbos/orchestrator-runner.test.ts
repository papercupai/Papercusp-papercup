import { describe, test, expect } from 'vitest';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';
import {
  extractAgentOutput,
  formatInvokeStderr,
  debuggerGateDecision,
  pickReactiveBeforeWorkerRole,
  invokeTimeoutMs,
  governorMaxWaitMs,
  leaseHeartbeatFailOpen,
  useWorkerChunkLoopOp,
} from './orchestrator-runner';

describe('useWorkerChunkLoopOp — retired DBOS route', () => {
  test('stale flags, opt-ins, cohorts, and roles can never re-enable the operator-hosted loop', () => {
    for (const role of ['worker', 'validator', 'architect', 'scoper', 'director', 'reviewer']) {
      for (const flagEnabled of [false, true]) {
        for (const harnessOptIn of [false, true]) {
          expect(
            useWorkerChunkLoopOp({
              role,
              flagEnabled,
              harnessOptIn,
              cohortPercent: 100,
              cohortKey: 'legacy-cohort',
            }),
          ).toBe(false);
        }
      }
    }
  });
});

describe('leaseHeartbeatFailOpen — D-007 fail-open lease-heartbeat glue', () => {
  test('passes a clean heartbeat verdict (renewed true/false) straight through', async () => {
    expect(await leaseHeartbeatFailOpen(async () => ({ renewed: true }))).toEqual({ renewed: true });
    expect(
      await leaseHeartbeatFailOpen(async () => ({ renewed: false, reason: 'stolen by swarm-B' })),
    ).toEqual({ renewed: false, reason: 'stolen by swarm-B' });
  });

  test('a throwing heartbeat FAILS OPEN to renewed:true (a PG/authority blip never kills a live pipeline)', async () => {
    const r = await leaseHeartbeatFailOpen(async () => {
      throw new Error('connection refused');
    });
    expect(r.renewed).toBe(true);
    expect(r.reason).toContain('heartbeat-error-fail-open');
    expect(r.reason).toContain('connection refused');
  });
});

describe('lazy env knobs (audit P-015 / EI-172)', () => {
  test('invokeTimeoutMs + governorMaxWaitMs read env at call time, not import time', () => {
    const prevT = process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS;
    const prevG = process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS;
    try {
      delete process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS;
      delete process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS;
      expect(invokeTimeoutMs()).toBe(2_700_000);
      expect(governorMaxWaitMs()).toBe(1_800_000);
      // The module was imported long before these env writes — the values must
      // still be honored (the old module-init consts ignored them: EI-172).
      process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS = '1234';
      process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS = '5678';
      expect(invokeTimeoutMs()).toBe(1234);
      expect(governorMaxWaitMs()).toBe(5678);
    } finally {
      if (prevT === undefined) delete process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS;
      else process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS = prevT;
      if (prevG === undefined) delete process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS;
      else process.env.PAPERCUSP_AGENT_GOVERNOR_MAX_WAIT_MS = prevG;
    }
  });
});

describe('extractAgentOutput — strip orchestrator timestamp log lines', () => {
  test('drops [2026-…] timestamp lines, keeps the agent body', () => {
    const stdout = [
      '[2026-06-01T04:00:00.000Z] booting invoke-once',
      'NEXT_WORKER',
      'some body text',
      '[2026-06-01T04:00:01.000Z] done',
    ].join('\n');
    expect(extractAgentOutput(stdout)).toBe('NEXT_WORKER\nsome body text');
  });

  test('trims leading/trailing whitespace', () => {
    expect(extractAgentOutput('\n\n  PASS  \n\n')).toBe('PASS');
  });

  test('empty stdout → empty string', () => {
    expect(extractAgentOutput('')).toBe('');
  });
});

describe('formatInvokeStderr — surface child stderr on a failed invoke (P-005)', () => {
  test('null on a clean (exit 0) run even with stderr present', () => {
    expect(formatInvokeStderr('worker', 0, 'some noise on stderr')).toBeNull();
  });

  test('null when exit is non-zero but stderr is empty/whitespace', () => {
    expect(formatInvokeStderr('worker', 1, '')).toBeNull();
    expect(formatInvokeStderr('worker', 1, '   \n  ')).toBeNull();
  });

  test('surfaces the role, exit code, and stderr body on a non-zero exit', () => {
    const out = formatInvokeStderr('director', 1, 'TypeError: paths.map is not a function');
    expect(out).toContain('role=director');
    expect(out).toContain('exited 1');
    expect(out).toContain('TypeError: paths.map is not a function');
  });

  test('this is exactly the throw-before-run case that was previously invisible', () => {
    // The two D-014 runtime bugs threw during subprocess boot → non-zero exit with
    // the message ONLY on stderr (stdout empty). Before P-005 the parent dropped it.
    const colErr = 'error: column "source_plan_slug" does not exist';
    const out = formatInvokeStderr('worker', 1, colErr);
    expect(out).not.toBeNull();
    expect(out).toContain(colErr);
  });

  test('truncates a pathologically long stderr with a marker', () => {
    const huge = 'x'.repeat(10_000);
    const out = formatInvokeStderr('worker', 1, huge)!;
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain('[stderr truncated: 10000 chars]');
  });

  test('keeps the Error message and stack when a minified bundle prints a huge code frame (WI-10006694)', () => {
    // The c1007k shape: node prints `<file>:<line>`, the whole minified source line, a caret, then
    // the error and stack. A head-only cut kept only the frame.
    const frame = 'var __create=Object.create;'.repeat(4000);
    const stderr = [
      'file:///usr/lib/Papercusp%20Server/sidecar/orchestrator/bin/invoke-once.mjs:2',
      frame,
      ' '.repeat(300) + '^',
      '',
      'Error: Dynamic require of "process" is not supported',
      '    at file:///usr/lib/Papercusp%20Server/sidecar/orchestrator/bin/invoke-once.mjs:2:454',
      '    at ../../node_modules/yaml/dist/compose/composer.js (file:///…/invoke-once.mjs:100:7832)',
      '',
      'Node.js v24.18.1',
    ].join('\n');
    const out = formatInvokeStderr('merge-resolver', 1, stderr)!;
    expect(out).toContain('Error: Dynamic require of "process" is not supported');
    expect(out).toContain('yaml/dist/compose/composer.js');
    expect(out).toContain('Node.js v24.18.1');
    expect(out).toContain(`[${frame.length}-char line elided]`);
    expect(out).toContain(`[stderr truncated: ${stderr.trim().length} chars]`);
    expect(out.length).toBeLessThan(5000);
  });

  test('keeps both the head and the tail of a long multi-line stderr', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'.'.repeat(20)}`);
    const out = formatInvokeStderr('worker', 1, lines.join('\n'))!;
    expect(out).toContain('line 0 ');
    expect(out).toContain('line 399 ');
    expect(out).not.toContain('line 200 ');
    expect(out).toContain('[stderr truncated:');
  });

  test('a short stderr is passed through untouched, with no truncation marker', () => {
    const out = formatInvokeStderr('worker', 1, 'Error: boom\n    at x (y.js:1:1)')!;
    expect(out).toBe('[dbos-invoke] role=worker exited 1 — stderr:\nError: boom\n    at x (y.js:1:1)');
  });
});

describe('debuggerGateDecision — fire the debugger before the worker (P-012)', () => {
  test('fires when enabled, attempts ≥ threshold, and no note exists', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 3, threshold: 3, noteExists: false })).toBe(true);
    expect(debuggerGateDecision({ enabled: true, attempts: 5, threshold: 3, noteExists: false })).toBe(true);
  });

  test('does NOT fire below the threshold', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 2, threshold: 3, noteExists: false })).toBe(false);
    expect(debuggerGateDecision({ enabled: true, attempts: 0, threshold: 3, noteExists: false })).toBe(false);
  });

  test('does NOT fire when a debug note already exists (fires at most once)', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 9, threshold: 3, noteExists: true })).toBe(false);
  });

  test('does NOT fire when the debugger is disabled', () => {
    expect(debuggerGateDecision({ enabled: false, attempts: 9, threshold: 3, noteExists: false })).toBe(false);
  });

  test('honors a custom threshold', () => {
    expect(debuggerGateDecision({ enabled: true, attempts: 4, threshold: 5, noteExists: false })).toBe(false);
    expect(debuggerGateDecision({ enabled: true, attempts: 5, threshold: 5, noteExists: false })).toBe(true);
  });
});

describe('pickReactiveBeforeWorkerRole — debugger launch is declarative (unify-launches D-001/D-003)', () => {
  test("the coding blueprint's reactive-before-worker role IS the debugger", () => {
    const coding = loadBuiltinBlueprint('coding-factory').blueprint;
    expect(pickReactiveBeforeWorkerRole(coding.reactive)).toBe('debugger');
  });

  test('a fork that swaps the before-worker reactive role is honored', () => {
    const reactive = [
      { role: 'my-debugger', when: { beforeRole: 'worker', minAttempts: 2 }, preempt: false },
      { role: 'security-reviewer', when: { afterRole: 'worker' }, preempt: false },
    ] as ReturnType<typeof loadBuiltinBlueprint>['blueprint']['reactive'];
    expect(pickReactiveBeforeWorkerRole(reactive)).toBe('my-debugger');
  });

  test("falls back to 'debugger' when no before-worker reactive rule is declared", () => {
    expect(pickReactiveBeforeWorkerRole([])).toBe('debugger');
  });
});
