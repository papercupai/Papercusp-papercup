/**
 * orchestrator-runner-spawn.test.ts — plan harness-test-coverage-for-launch P-012.
 *
 * Covers spawnInvokeOnce — the subprocess spawn + SIGTERM timeout-kill +
 * stdout/stderr capture that every DBOS agent run (realRunner / realFinalizer /
 * the debugger gate) goes through. Its pure helpers were tested; the actual
 * spawn path was not. We mock `buildInvokeOnce` to drive a fake `node -e`
 * process (deterministic, no real agent binary), and pin a short
 * INVOKE_TIMEOUT_MS via env BEFORE the module loads (it's read at module init).
 *
 * vitest-fail-on-console is active and spawnInvokeOnce console.error's on a
 * non-zero/spawn-error exit (the P-005 stderr surfacing) — so we spy+silence it
 * and assert it fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execPath } from 'node:process';
// Imported, never re-spelled: the marker is invoke.ts's to define, and a second
// literal copy here would keep passing after a rename while production broke.
import { OUTER_ACTIVITY_ECHO_MARKER } from '@papercusp/orchestrator';

// Set the invoke timeout BEFORE orchestrator-runner is imported (INVOKE_TIMEOUT_MS
// is a module-load const). It must be ample for a REAL `node -e` child under gate
// load: at 600ms the fast cases were SIGTERM'd before the child finished and read
// exitCode 1 (gate candidate 9f0a0776, 2026-09-30). Cases that exercise the kill
// pass a short per-request timeoutMs instead of relying on this default.
const MODULE_TIMEOUT_MS = vi.hoisted(() => {
  process.env.PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS = '30000';
  return 30_000;
});

// buildInvokeOnce is the seam: tests set H.cmd to the {command,args,env} to spawn.
// Inputs are recorded so the display-lease wiring (extraEnv.DISPLAY) is assertable.
const H = vi.hoisted(() => ({
  cmd: null as null | { command: string; args: string[]; env: NodeJS.ProcessEnv },
  inputs: [] as Array<{ extraEnv: Record<string, string> }>,
  // EI-18118494223190987: when set, buildInvokeOnce THROWS instead of returning
  // a command — simulates a setup-step failure (e.g. instance-config read)
  // upstream of the actual child spawn, to prove spawnInvokeOnce honors its own
  // documented "never rejects" contract even then.
  throwOnBuild: null as null | Error,
}));
vi.mock('../harness-invoke-once', () => ({
  buildInvokeOnce: (input: { extraEnv: Record<string, string> }) => {
    if (H.throwOnBuild) throw H.throwOnBuild;
    H.inputs.push(input);
    return H.cmd;
  },
  // orchestrator-runner ALSO imports resolveSpawnBackendModel from this module
  // (the AGENT_GOVERNOR bucket-keying path). The mock must mirror the module's
  // FULL named-export surface or Vitest 4's module-evaluator throws "No
  // resolveSpawnBackendModel export is defined on the mock" when the importer
  // is linked — load-order-dependent, so it passed isolated but flaked under
  // the full operator-core suite (2026-06-11).
  resolveSpawnBackendModel: () => ({ backend: 'omp', model: '' }),
}));

import { spawnInvokeOnce } from './orchestrator-runner';
import { _resetDisplayPoolForTests } from '../deployment/display-allocator';
import { governorForBackend, resetGovernorRegistry } from '@papercusp/papercusp-shared/agent';

const node = (script: string) => ({ command: execPath, args: ['-e', script], env: process.env });
// The first-turn guard arms at spawn, so a case asserting it CLEARS races the child's own
// startup against the guard. WI-10003853 measured 1028ms of spawn cost under gate load, and a
// 200ms guard lost that race at repairHead cef7d918 (WI-10004340). Cases that must NOT trip
// the guard use this window; cases that must trip it keep a short one (a slow start only
// makes those fire more surely). 3000ms then lost the same race at repairHead f07043ba
// (WI-10006055: both clear-cases saw the guard fire before the child's first byte), so the
// window is sized for a heavily loaded gate, not an idle box. Only the stderr-marker case
// pays it in wall time; the stdout case exits after 20ms.
const SPAWN_SAFE_FIRST_TURN_MS = 10_000;
// Each clear-case's Vitest budget must outlive the inner spawn timeout (3x the guard).
const SPAWN_SAFE_TEST_BUDGET_MS = SPAWN_SAFE_FIRST_TURN_MS * 3 + 10_000;

beforeEach(() => {
  // P-005 failLog / spawn-error log → console.error; silence (fail-on-console).
  vi.spyOn(console, 'error').mockImplementation(() => {});
  H.throwOnBuild = null;
});
afterEach(() => vi.restoreAllMocks());

describe('spawnInvokeOnce', () => {
  it('captures stdout and a clean exit (code 0)', async () => {
    H.cmd = node('process.stdout.write("DECISION\\nNEXT_WORKER F-1\\n")');
    const r = await spawnInvokeOnce(process.cwd(), 'director', [], {});
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain('NEXT_WORKER F-1');
    expect(console.error).not.toHaveBeenCalled();
  });

  // EI-18118494223190987: a throw from a SETUP step (buildInvokeOnce, the
  // instance-config env-transport read, resolveSpawnBackendModel,
  // governorForBackend, the governor acquire/feed path) used to propagate as a
  // REJECTED promise, contradicting this function's own doc'd "never rejects"
  // contract — and every caller (notably the harness /invoke route's auto-implement
  // worker-exit back-edge) has no try/catch around its `await spawnInvokeOnce(...)`,
  // so the rejection silently skipped their post-spawn bookkeeping instead of
  // surfacing as a normal failed-exit result. Assert it now resolves instead.
  it('resolves (never rejects) when a setup step throws before the child ever spawns', async () => {
    H.throwOnBuild = new Error('instance-config read failed: ECONNREFUSED');
    await expect(spawnInvokeOnce(process.cwd(), 'worker', [], {})).resolves.toMatchObject({
      exitCode: 1,
      output: '',
      stderr: expect.stringContaining('instance-config read failed: ECONNREFUSED'),
    });
    expect(console.error).toHaveBeenCalled();
  });

  it('threads child pid and output activity callbacks on the default governor-off path', async () => {
    vi.stubEnv('PAPERCUSP_AGENT_GOVERNOR', '');
    H.cmd = node('process.stdout.write("chunk")');
    const pids: number[] = [];
    let outputEvents = 0;

    const r = await spawnInvokeOnce(process.cwd(), 'cup', [], {}, {
      onChildPid: (pid) => pids.push(pid),
      onOutputActivity: () => {
        outputEvents += 1;
      },
    });

    expect(r.exitCode).toBe(0);
    expect(pids).toHaveLength(1);
    expect(pids[0]).toBeGreaterThan(1);
    expect(outputEvents).toBeGreaterThanOrEqual(1);
    expect(console.error).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('strips [timestamp] log lines from the captured output', async () => {
    H.cmd = node('process.stdout.write("[2026-06-02T10:00:00.000Z] booting\\nDONE\\n")');
    const r = await spawnInvokeOnce(process.cwd(), 'director', [], {});
    expect(r.output).toBe('DONE'); // the timestamp line is filtered out
  });

  it('preserves a bounded raw stdout tail for diagnostics even when output is filtered', async () => {
    H.cmd = node('process.stdout.write("[2026-06-02T10:00:00.000Z] booting\\nAPI Error: invalid_api_key\\n");process.exit(1)');
    const r = await spawnInvokeOnce(process.cwd(), 'mug', [], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe('API Error: invalid_api_key');
    expect(r.rawStdoutTail).toContain('[2026-06-02T10:00:00.000Z] booting');
    expect(r.rawStdoutTail).toContain('invalid_api_key');
  });

  // EI-286 leg (b): a child spawned by a port-aware host (PAPERCUSP_HONO_PORT
  // set, e.g. staging :3170) must get its SPAWNER's MCP base — the child
  // inherits process.env, where .env.local pins PAPERCUSP_OPERATOR_URL to the
  // green :3070, so without the override the P-071 Queen handshook the WRONG
  // host (stale role catalog; placement tools never appeared).
  it('pins the child MCP base to the spawning host, overriding the inherited host env', async () => {
    vi.stubEnv('PAPERCUSP_HONO_PORT', '3170');
    // The poison case: the HOST's own env points elsewhere (.env.local).
    vi.stubEnv('PAPERCUSP_OPERATOR_URL', 'http://localhost:3070/api/mcp');
    H.cmd = node('process.stdout.write("ok")');
    await spawnInvokeOnce(process.cwd(), 'mug', [], {});
    expect(H.inputs.at(-1)?.extraEnv.PAPERCUSP_OPERATOR_URL).toBe('http://localhost:3170/api/mcp');
    vi.unstubAllEnvs();
  });

  it('routes orchestrator children through the same-vintage bg-host proxy, not the sessions proxy', async () => {
    try {
      vi.stubEnv('PAPERCUSP_HONO_PORT', '3271');
      vi.stubEnv('PAPERCUSP_OPERATOR_URL', 'http://localhost:3070/api/mcp');
      vi.stubEnv('PAPERCUSP_MCP_PROXY_BASE', 'http://127.0.0.1:9271');
      vi.stubEnv('PAPERCUSP_MCP_PROXY_TARGET_PORT', '3271');
      vi.stubEnv('PAPERCUSP_BG_HOST_AGENTS_MCP_BASE', 'http://127.0.0.1:9071');
      H.cmd = node('process.stdout.write("ok")');
      await spawnInvokeOnce(process.cwd(), 'release-fixer', [], {});
      expect(H.inputs.at(-1)?.extraEnv.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9271/api/mcp');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('respects a caller-pinned PAPERCUSP_OPERATOR_URL (no override)', async () => {
    vi.stubEnv('PAPERCUSP_HONO_PORT', '3170');
    vi.stubEnv('PAPERCUSP_OPERATOR_URL', '');
    H.cmd = node('process.stdout.write("ok")');
    await spawnInvokeOnce(process.cwd(), 'mug', [], {
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:9999/api/mcp',
    });
    expect(H.inputs.at(-1)?.extraEnv.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:9999/api/mcp');
    vi.unstubAllEnvs();
  });

  it('surfaces stderr + the non-zero exit code (P-005), and logs the fail line', async () => {
    H.cmd = node('process.stderr.write("kaboom");process.exit(3)');
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('kaboom');
    expect(r.output).toBe('');
    expect(console.error).toHaveBeenCalled(); // failLog surfaced, not silent
  });

  it('SIGTERM-kills a hung child at the timeout and resolves (never hangs)', async () => {
    H.cmd = node('setInterval(() => {}, 1000)'); // never exits on its own
    const start = Date.now();
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {}, { timeoutMs: 600 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(MODULE_TIMEOUT_MS); // killed at ~600ms, not hung to the default
    expect(elapsed).toBeGreaterThanOrEqual(400); // it DID wait for the timeout, not exit early
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).not.toBe(0); // terminated by signal (code null → 1)
  }, 20_000);

  // WI-108: per-request opts.timeoutMs must override the module-level default
  // (PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS=MODULE_TIMEOUT_MS here). The invoke route passes the
  // caller-supplied timeoutMs through spawnInvokeOnce → runChild, so a
  // body.timeoutMs: 280_000 truly kills at 280s, not the 600s host default.
  it('per-request opts.timeoutMs overrides the module-level PAPERCUSP_DBOS_INVOKE_TIMEOUT_MS default', async () => {
    H.cmd = node('setInterval(() => {}, 5000)'); // never exits on its own
    // Module default is MODULE_TIMEOUT_MS (env above). A per-request 200ms must arm the kill timer.
    // Assert the ARMED DELAY, not wall-clock elapsed: `timedOut` is set by either timer,
    // and an elapsed bound measured around a real child spawn absorbs the spawn cost,
    // which under gate load exceeded the whole 200-vs-600 margin (WI-10003853: 1028ms).
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    try {
      const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {}, { timeoutMs: 200 });
      const armedDelays = setTimeoutSpy.mock.calls.map((call) => call[1]);
      expect(armedDelays).toContain(200);
      expect(armedDelays).not.toContain(MODULE_TIMEOUT_MS);
      expect(r.timedOut).toBe(true);
      expect(r.exitCode).not.toBe(0);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  }, 10_000);

  it('release-fixer first-turn silence guard kills before the full invoke deadline', async () => {
    // Bootstrap logs are timestamp-prefixed and do not count as an agent turn.
    // This mirrors the observed shape: prompt assembly succeeds, then the
    // release-fixer emits no agent stream until the overall timeout.
    H.cmd = node(
      'process.stdout.write("[2026-08-20T12:15:34.000Z] prompt-budget role=release-fixer total=63586\\n");' +
        'setInterval(() => {}, 5000)',
    );
    const r = await spawnInvokeOnce(
      process.cwd(),
      'release-fixer',
      [],
      {},
      { timeoutMs: 1_000, firstTurnTimeoutMs: 200 },
    );
    // firstTurnTimedOut is only set when the first-turn guard fires BEFORE the overall
    // timer (runChild's guard returns early once timedOut is set), so it alone proves
    // the guard beat the 1s deadline. No wall-clock bound: it absorbed the child-spawn
    // cost and flaked under gate load (WI-10003853).
    expect(r.firstTurnTimedOut).toBe(true);
    expect(r.timedOut).toBe(true);
    expect(r.stderr).toContain('release-fixer first-turn timeout');
  }, 10_000);

  it('release-fixer first-turn silence guard clears when an agent stream starts', async () => {
    H.cmd = node(
      'process.stdout.write("{\\"type\\":\\"assistant\\",\\"content\\":\\"turn\\"}\\n");' +
        'setTimeout(() => process.exit(0), 20)',
    );
    const r = await spawnInvokeOnce(
      process.cwd(),
      'release-fixer',
      [],
      {},
      { timeoutMs: SPAWN_SAFE_FIRST_TURN_MS * 3, firstTurnTimeoutMs: SPAWN_SAFE_FIRST_TURN_MS },
    );
    expect(r.exitCode).toBe(0);
    expect(r.firstTurnTimedOut).toBe(false);
  }, SPAWN_SAFE_TEST_BUDGET_MS);

  it('release-fixer first-turn guard clears on the stderr activity marker (production shape)', async () => {
    // WI-85288 regression. The test above disarms the guard via STDOUT, which is a
    // shape production never produces: invoke.ts does NOT echo the inner agent CLI's
    // stdout onto this child's stdout — WI-3302 deliberately routes the liveness
    // signal to STDERR as OUTER_ACTIVITY_ECHO_MARKER, because downstream consumers
    // key off exact stdout content. So the real fixer emits only timestamp-prefixed
    // stdout (which extractAgentOutput strips) plus that marker. Before the fix the
    // guard could never be disarmed and SIGTERM'd every release-fixer at exactly
    // 300000ms: 0 completions and 100% timeouts from 2026-08-24 16:57Z onward, which
    // is what stopped `main` advancing — no fixer survived long enough to commit.
    // A clean exit that still produced stderr makes spawnInvokeOnce console.warn the
    // stderr surfacing (orchestrator-runner.ts:862), and vitest-fail-on-console is
    // active — same spy+assert idiom the other stderr-bearing cases in this file use.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const start = Date.now();
    // Outlive the guard so a still-armed timer would kill this and fail. The exit is pinned to
    // an absolute instant past the guard, so a slow child start cannot shorten the window.
    const exitAt = start + SPAWN_SAFE_FIRST_TURN_MS + 300;
    H.cmd = node(
      'process.stdout.write("[2026-08-27T12:23:25.000Z] prompt-budget role=release-fixer total=63586\\n");' +
        `process.stderr.write(${JSON.stringify(`${OUTER_ACTIVITY_ECHO_MARKER}\n`)});` +
        `setTimeout(() => process.exit(0), Math.max(0, ${exitAt} - Date.now()))`,
    );
    const r = await spawnInvokeOnce(
      process.cwd(),
      'release-fixer',
      [],
      {},
      { timeoutMs: SPAWN_SAFE_FIRST_TURN_MS * 3, firstTurnTimeoutMs: SPAWN_SAFE_FIRST_TURN_MS },
    );
    expect(r.firstTurnTimedOut).toBe(false);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(Date.now() - start).toBeGreaterThan(SPAWN_SAFE_FIRST_TURN_MS); // it really outlived the guard
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  }, SPAWN_SAFE_TEST_BUDGET_MS);

  it('resolves (never rejects) with exitCode 1 on a spawn error (bad command)', async () => {
    H.cmd = { command: 'papercusp-no-such-binary-zzz', args: [], env: process.env };
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toBe('');
    expect(r.stderr).toBeTruthy(); // the spawn-error message
    expect(console.error).toHaveBeenCalled();
  });
});

// ── governor back-edge: subprocess 429 → shared bucket penalty (EI-86) ───────
// The dominant traffic class is the spawned claude-CLI bee, NOT the in-process
// anthropic-direct lane — so without this back-edge the (provider,modelClass)
// governor stays GREEN while the account chokes, the AIMD never engages, and
// `did we hit a rate limit?` is unanswerable from instruments. spawnInvokeOnce
// classifies the child's outcome (classifyTurnError, unit-tested in
// turn-error.test.ts) and, on an account-wide stop (429/overload/usage-cap),
// PENALIZES the shared governor bucket. These assert that wiring actually fires:
// a rate-limited child pauses the bucket; a clean child leaves it green. The
// mocked resolveSpawnBackendModel keys the omp bucket (`unknown:self`) — the
// classifier is provider-agnostic, so a rate-limited child still pauses it.
describe('spawnInvokeOnce → governor back-edge (EI-86)', () => {
  beforeEach(() => {
    resetGovernorRegistry();
    // feedGovernor keys the bucket to PAPERCUSP_ACCOUNT_ID (a frame's bound
    // account) or the global bucket when unset — pin it empty so the assertion
    // resolves the SAME no-account bucket the spawn penalizes.
    vi.stubEnv('PAPERCUSP_ACCOUNT_ID', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetGovernorRegistry();
  });

  it('penalizes the shared bucket when a child prints a rate-limit marker and fails', async () => {
    // The claude/codex CLIs print API errors to STDOUT and exit non-zero — the
    // exact shape classifySubprocessResult folds into the scan on a failed exit.
    H.cmd = node('process.stdout.write("API Error: rate limited, retry after 30s\\n");process.exit(1)');
    const before = governorForBackend('omp', '').snapshot().pausedUntil;
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r.exitCode).toBe(1);
    const after = governorForBackend('omp', '').snapshot().pausedUntil;
    expect(after).toBeGreaterThan(before); // the back-edge fired
    expect(after).toBeGreaterThan(Date.now()); // bucket parked until the retry-after
  });

  it('leaves the bucket green on a clean child run (no false penalty)', async () => {
    H.cmd = node('process.stdout.write("DONE\\n");process.exit(0)');
    const r = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r.exitCode).toBe(0);
    expect(governorForBackend('omp', '').snapshot().pausedUntil).toBe(0); // stays unpaused
  });
});

// ── per-agent DISPLAY leasing (hive-frame-desktops-live-view P-002) ─────────
describe('spawnInvokeOnce display leasing', () => {
  beforeEach(() => {
    H.inputs = [];
    process.env.PAPERCUSP_DESKTOP_DISPLAYS = '1';
    process.env.PAPERCUSP_DESKTOP_STATE_DIR = '/tmp/pc-display-spawn-test';
    _resetDisplayPoolForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_DESKTOP_DISPLAYS;
    delete process.env.PAPERCUSP_DESKTOP_STATE_DIR;
    _resetDisplayPoolForTests();
  });

  it('on a desktop frame the agent env carries the leased DISPLAY, released on exit', async () => {
    H.cmd = node('process.exit(0)');
    const r1 = await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(r1.exitCode).toBe(0);
    expect(H.inputs[0].extraEnv.DISPLAY).toBe(':99');
    expect(H.inputs[0].extraEnv.PAPERCUSP_AGENT_DISPLAY).toBe(':99');
    // lease released after the child exited → next spawn re-leases :99
    await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(H.inputs[1].extraEnv.DISPLAY).toBe(':99');
  });

  it('pool exhausted → headless spawn (no DISPLAY) + a warn, never queued', async () => {
    H.cmd = node('setTimeout(() => process.exit(0), 250)');
    const slow = spawnInvokeOnce(process.cwd(), 'worker', [], {}); // holds :99
    await new Promise((r) => setTimeout(r, 50));
    H.cmd = node('process.exit(0)');
    const r2 = await spawnInvokeOnce(process.cwd(), 'validator', [], {});
    expect(r2.exitCode).toBe(0);
    expect(H.inputs[1].extraEnv.DISPLAY).toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('display pool exhausted'));
    await slow;
  });

  it('off-frame (no pool env) nothing is injected', async () => {
    delete process.env.PAPERCUSP_DESKTOP_DISPLAYS;
    _resetDisplayPoolForTests();
    H.cmd = node('process.exit(0)');
    await spawnInvokeOnce(process.cwd(), 'worker', [], {});
    expect(H.inputs[0].extraEnv.DISPLAY).toBeUndefined();
    expect(H.inputs[0].extraEnv.PAPERCUSP_AGENT_DISPLAY).toBeUndefined();
  });
});
