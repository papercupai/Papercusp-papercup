import { describe, it, expect, beforeAll } from 'vitest';
import { MCP_PROXY_HOT_PATHS as SERVICE_HEALTH_MCP_PROXY_HOT_PATHS } from '../../../../packages/operator-core/lib/service-health';

// The watchdog is a long-lived systemd entrypoint that starts its poll loop on import. Opt out so
// we can unit-test the pure decision logic without launching setInterval / hitting the network.
process.env.PAPERCUSP_WATCHDOG_NO_AUTOSTART = '1';

// Types come from watchdog.d.mts — without it this import is an implicit `any` (TS7016) and
// every assertion below silently stops type-checking (a misspelled verdict would compile).
type Watchdog = typeof import('./watchdog.mjs');
let shouldRestart: Watchdog['shouldRestart'];
let classifyProbeResult: Watchdog['classifyProbeResult'];
let classifyDataPlaneResult: Watchdog['classifyDataPlaneResult'];
let dataPlaneProbeArgs: Watchdog['dataPlaneProbeArgs'];
let decideHandshakeAction: Watchdog['decideHandshakeAction'];
let LIVENESS_PROBE_PATH: Watchdog['LIVENESS_PROBE_PATH'];
let livenessProbeUrl: Watchdog['livenessProbeUrl'];
let evaluateStallRate: Watchdog['evaluateStallRate'];
let evaluateRestartAdmission: Watchdog['evaluateRestartAdmission'];
let recordRestartOutcome: Watchdog['recordRestartOutcome'];
let restartFailureDetail: Watchdog['restartFailureDetail'];
let buildEscalationCall: Watchdog['buildEscalationCall'];
let decideRestartAfterRecheck: Watchdog['decideRestartAfterRecheck'];
let MCP_PROXY_COMMITTED_HOT_PATHS: Watchdog['MCP_PROXY_COMMITTED_HOT_PATHS'];
let evaluateMcpProxyHotPathActivation: Watchdog['evaluateMcpProxyHotPathActivation'];
let shouldCheckMcpProxyHotPathActivation: Watchdog['shouldCheckMcpProxyHotPathActivation'];
let readMcpProxyHotPathState: Watchdog['readMcpProxyHotPathState'];
let requestMcpProxyHotPathRestart: Watchdog['requestMcpProxyHotPathRestart'];
beforeAll(async () => {
  ({
    shouldRestart,
    classifyProbeResult,
    classifyDataPlaneResult,
    dataPlaneProbeArgs,
    decideHandshakeAction,
    LIVENESS_PROBE_PATH,
    livenessProbeUrl,
    evaluateStallRate,
    evaluateRestartAdmission,
    recordRestartOutcome,
    restartFailureDetail,
    buildEscalationCall,
    decideRestartAfterRecheck,
    MCP_PROXY_COMMITTED_HOT_PATHS,
    evaluateMcpProxyHotPathActivation,
    shouldCheckMcpProxyHotPathActivation,
    readMcpProxyHotPathState,
    requestMcpProxyHotPathRestart,
  } = await import('./watchdog.mjs'));
});

/**
 * EI-22647232817982385 — the proxy tsx-loads the working tree but has no file watcher, so a
 * committed fix can sit inert in the live process indefinitely. This is the recurrence guard for
 * the activation lane adapted from bghost-watchdog's fail-closed committed-hot-path check:
 * activation requires a known generation, a known newer commit, and a clean relevant tree.
 * Unknown evidence and in-progress edits must never become permission to restart a peer's proxy.
 */
describe('mcp-proxy watchdog — committed hot-path activation (EI-22647232817982385)', () => {
  const NOW = 1_000_000;
  const safe = {
    activeForSec: 100,
    latestCommitMs: 950_000,
    latestCommitHash: 'abcdef1234567890',
    nowMs: NOW,
    dirtyEntries: [],
  };

  it('pins the watchdog scope to the canonical service-health proxy hot paths', () => {
    expect([...MCP_PROXY_COMMITTED_HOT_PATHS]).toEqual([...SERVICE_HEALTH_MCP_PROXY_HOT_PATHS]);
  });

  it('activates only for a newer committed change and a clean working tree', () => {
    expect(evaluateMcpProxyHotPathActivation(safe)).toMatchObject({
      activate: true,
      code: 'activate',
      bootMs: 900_000,
      latestCommitHash: safe.latestCommitHash,
    });
  });

  it.each([
    ['generation age unknown', { activeForSec: null }, 'generation_unknown'],
    ['clock unknown', { nowMs: null }, 'clock_unknown'],
    ['commit timestamp unknown', { latestCommitMs: null }, 'commit_unknown'],
    ['commit hash unknown', { latestCommitHash: null }, 'commit_unknown'],
    ['future-dated commit', { latestCommitMs: NOW + 1 }, 'commit_time_future'],
    ['running generation is current', { latestCommitMs: NOW - 101_000 }, 'generation_current'],
    ['cleanliness unknown', { dirtyEntries: null }, 'cleanliness_unknown'],
  ])('fails closed when %s', (_label, patch, code) => {
    expect(evaluateMcpProxyHotPathActivation({ ...safe, ...patch })).toMatchObject({
      activate: false,
      code,
    });
  });

  it('suppresses on any dirty or untracked proxy hot-path entry, including tests', () => {
    expect(
      evaluateMcpProxyHotPathActivation({
        ...safe,
        dirtyEntries: [
          ' M apps/operator/lib/mcp-proxy/proxy.ts',
          '?? apps/operator/lib/mcp-proxy/proxy.test.ts',
        ],
      }),
    ).toMatchObject({ activate: false, code: 'hot_paths_dirty', dirtyCount: 2 });
  });

  it('throttles repeated checks and refuses an overlapping check', () => {
    expect(
      shouldCheckMcpProxyHotPathActivation({ inFlight: false, lastCheckMs: 0, nowMs: 10, intervalMs: 300 }),
    ).toBe(true);
    expect(
      shouldCheckMcpProxyHotPathActivation({ inFlight: true, lastCheckMs: 0, nowMs: 10, intervalMs: 300 }),
    ).toBe(false);
    expect(
      shouldCheckMcpProxyHotPathActivation({ inFlight: false, lastCheckMs: 100, nowMs: 399, intervalMs: 300 }),
    ).toBe(false);
    expect(
      shouldCheckMcpProxyHotPathActivation({ inFlight: false, lastCheckMs: 100, nowMs: 400, intervalMs: 300 }),
    ).toBe(true);
  });

  it('reads a non-test committed proxy change while treating every dirty entry as unsafe', async () => {
    const calls: Array<{ args: string[]; options?: { env?: NodeJS.ProcessEnv } }> = [];
    const state = await readMcpProxyHotPathState({
      root: '/repo',
      sh: async (_command, args, options) => {
        calls.push({ args, options });
        if (args.includes('log')) return { err: null, stdout: '950\u0000abcdef1234567890\n' };
        return {
          err: null,
          stdout:
            ' M apps/operator/lib/mcp-proxy/proxy.ts\u0000' +
            '?? apps/operator/lib/mcp-proxy/proxy.test.ts\u0000',
        };
      },
    });
    expect(state).toMatchObject({
      latestCommitMs: 950_000,
      latestCommitHash: 'abcdef1234567890',
      dirtyEntries: [
        'M apps/operator/lib/mcp-proxy/proxy.ts',
        '?? apps/operator/lib/mcp-proxy/proxy.test.ts',
      ],
      error: null,
    });
    const logArgs = calls.find((call) => call.args.includes('log'))!.args;
    const statusCall = calls.find((call) => call.args.includes('status'))!;
    const statusArgs = statusCall.args;
    expect(logArgs).toContain(':(glob)apps/operator/lib/mcp-proxy/**/*.ts');
    expect(logArgs).toContain(':(exclude,glob)**/*.test.ts');
    expect(logArgs).toContain(':(exclude)apps/operator/lib/mcp-proxy/watchdog.mjs');
    expect(statusArgs).toContain('--untracked-files=all');
    expect(statusArgs).toContain('apps/operator/lib/mcp-proxy');
    expect(statusArgs).toContain(':(exclude)apps/operator/lib/mcp-proxy/watchdog.test.ts');
    expect(statusCall.options?.env).toMatchObject({ GIT_OPTIONAL_LOCKS: '0' });
  });

  it('fails closed when either git read fails', async () => {
    const state = await readMcpProxyHotPathState({
      root: '/repo',
      sh: async (_command, args) =>
        args.includes('log')
          ? { err: new Error('git unavailable'), stdout: '' }
          : { err: null, stdout: '' },
    });
    expect(state).toMatchObject({ latestCommitMs: null, latestCommitHash: null, dirtyEntries: [], error: 'commit_unknown' });
    expect(evaluateMcpProxyHotPathActivation({ ...safe, ...state })).toMatchObject({
      activate: false,
      code: 'commit_unknown',
    });
  });

  it('uses the coordinated mcp-proxy restart surface with a bounded call drain', async () => {
    let observed: { command: string; args: string[]; opts?: { stdin?: string; timeout?: number } } | undefined;
    const outcome = await requestMcpProxyHotPathRestart('abcdef1234567890', {
      ptoolScript: '/repo/apps/operator/scripts/ptool.mjs',
      sh: async (command, args, opts) => {
        observed = { command, args, opts };
        return { err: null, stdout: JSON.stringify({ ok: true, target: 'mcp-proxy', restarted: true }) };
      },
    });
    expect(outcome).toMatchObject({ ok: true, restarted: true, code: 'restarted' });
    expect(observed?.command).toBe(process.execPath);
    expect(observed?.args).toEqual(['/repo/apps/operator/scripts/ptool.mjs', 'dev:restart', '--json', '-']);
    const payload = JSON.parse(observed?.opts?.stdin ?? '{}');
    expect(payload).toMatchObject({
      target: 'mcp-proxy',
      confirm: true,
      authorize: true,
    });
    expect(payload.max_drain_sec).toBeGreaterThan(0);
    expect(observed?.opts?.timeout).toBe(30_000 + payload.max_drain_sec * 1_000);
    expect(payload).not.toHaveProperty('override_gate_collision');
    expect(payload).not.toHaveProperty('override_boot_integrity');
  });

  it('fails closed when coordinated restart is unavailable or refuses', async () => {
    await expect(
      requestMcpProxyHotPathRestart('abc', {
        sh: async () => ({ err: new Error('boom'), stdout: '' }),
      }),
    ).resolves.toMatchObject({ ok: false, restarted: false, code: 'ptool_failed', error: 'boom' });
    await expect(
      requestMcpProxyHotPathRestart('abc', {
        sh: async () => ({ err: null, stdout: JSON.stringify({ ok: false, reason: 'gate_collision' }) }),
      }),
    ).resolves.toMatchObject({ ok: false, restarted: false, code: 'gate_collision' });
    // ptool exits 5 on an ok:false answer (EI-24654733539966460): the refusal arrives
    // WITH an exec error, and its reason must survive instead of collapsing to ptool_failed.
    await expect(
      requestMcpProxyHotPathRestart('abc', {
        sh: async () => ({ err: new Error('Command failed: exit 5'), stdout: JSON.stringify({ ok: false, reason: 'gate_collision' }) }),
      }),
    ).resolves.toMatchObject({ ok: false, restarted: false, code: 'gate_collision' });
  });

  it('keeps activation in the existing poll cadence before liveness probing', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./watchdog.mjs', import.meta.url), 'utf8');
    const pollStart = source.indexOf('async function poll()');
    const pollBody = source.slice(pollStart);
    const activationIndex = pollBody.indexOf('maybeActivateMcpProxyHotPathCode');
    const livenessIndex = pollBody.indexOf('fetch(livenessProbeUrl');
    expect(activationIndex).toBeGreaterThan(-1);
    expect(activationIndex).toBeLessThan(livenessIndex);
    expect(source).toContain('if (!admitRestart(reason)) return { restartRequested: false, code: \'restart_suppressed\' };');
  });
});

describe('mcp-proxy watchdog — actual restart accounting (WI-6554700010018605)', () => {
  const NOW = 1_000_000;

  it('does not spend restart history or debounce on failed, coalesced, or no-op activations', () => {
    let state = { lastRestartMs: 0, restartTimesMs: [] as number[] };
    const nonRestarts = [
      { ok: false, restarted: false, code: 'ptool_failed', error: 'timeout' },
      { ok: true, restarted: false, coalesced: true, code: 'coalesced' },
      { ok: true, restarted: false, code: 'no_restart' },
    ];
    for (let i = 0; i < 6; i += 1) {
      state = recordRestartOutcome(state, nonRestarts[i % nonRestarts.length], NOW + i);
    }

    expect(state).toEqual({ lastRestartMs: 0, restartTimesMs: [] });
    expect(
      evaluateRestartAdmission({
        ...state,
        nowMs: NOW + 10,
        debounceMs: 300_000,
        maxRestartsPerHour: 6,
      }),
    ).toMatchObject({ allowed: true, code: 'admitted', recentRestartTimesMs: [] });
  });

  it('counts confirmed restarts and opens the rolling circuit only at the actual-restart cap', () => {
    let state = { lastRestartMs: 0, restartTimesMs: [] as number[] };
    for (let i = 0; i < 6; i += 1) {
      state = recordRestartOutcome(state, { ok: true, restarted: true }, NOW + i);
    }

    expect(state.restartTimesMs).toHaveLength(6);
    expect(state.lastRestartMs).toBe(NOW + 5);
    expect(
      evaluateRestartAdmission({
        ...state,
        nowMs: NOW + 10,
        debounceMs: 0,
        maxRestartsPerHour: 6,
      }),
    ).toMatchObject({ allowed: false, code: 'circuit_open', recentRestartTimesMs: state.restartTimesMs });
  });

  it('prevents overlapping restart actions while one reservation is in flight', () => {
    expect(
      evaluateRestartAdmission({
        restartTimesMs: [],
        lastRestartMs: 0,
        nowMs: NOW,
        debounceMs: 300_000,
        maxRestartsPerHour: 6,
        inFlight: true,
      }),
    ).toMatchObject({ allowed: false, code: 'restart_in_flight' });
  });

  it('keeps ptool failure detail single-line and bounded for durable logs', () => {
    expect(restartFailureDetail('ptool failed\n  transport closed')).toBe(' detail=ptool failed transport closed');
    expect(restartFailureDetail('x'.repeat(400))).toBe(` detail=${'x'.repeat(300)}`);
    expect(restartFailureDetail(null)).toBe('');
  });
});

/**
 * WI-6743 — the liveness probe must not traverse the upstream.
 *
 * Polling a FORWARDED path (`/api/health`) made this watchdog report the proxy as unreachable
 * every time :3070 restarted, because retry-on-refused deliberately withholds a response for up
 * to the retry window so a deploy is invisible to MCP clients. Result: 272 false `unreachable`
 * incidents, and a real wedge became indistinguishable from a routine deploy.
 *
 * The end-to-end proof (the proxy still answers this path with a dead upstream) lives in
 * proxy.test.ts. These pin the two ways the fix can silently rot: the path drifting away from
 * the route the proxy actually serves, and the probe quietly reacquiring an upstream dependency.
 */
describe('mcp-proxy watchdog — liveness probe target (WI-6743)', () => {
  it('is the SAME constant the proxy serves, not a copied literal', async () => {
    const { MCP_PROXY_LOCAL_HEALTH_PATH } = await import('./budgets.mjs');
    // Both sides import this from budgets.mjs, so they cannot drift. If someone re-inlines a
    // literal on either side, this fails.
    expect(LIVENESS_PROBE_PATH).toBe(MCP_PROXY_LOCAL_HEALTH_PATH);
  });

  it('is proxy-local — never an upstream-forwarded path', () => {
    // `/api/*` is exactly what the proxy forwards; polling any of it reintroduces the bug.
    expect(LIVENESS_PROBE_PATH.startsWith('/api/')).toBe(false);
    expect(LIVENESS_PROBE_PATH).not.toBe('/api/health');
  });

  it('builds a loopback URL against the watchdog port', () => {
    expect(livenessProbeUrl(9071)).toBe(`http://127.0.0.1:9071${LIVENESS_PROBE_PATH}`);
  });
});

/**
 * EI-9237: the proxy's wedge signature ("event loop dead, zero responses") shows up purely as
 * sustained unreachability — there's no /stats counter to distinguish an internal wedge from an
 * external stall (unlike the inference-gateway watchdog), so the threshold-crossing decision is
 * the whole detector. Pure logic; the poll loop debounces + circuit-breaks the actual restart.
 */
describe('mcp-proxy watchdog — shouldRestart (unreachability threshold)', () => {
  it('does not restart while never-yet-unreachable (unreachableSinceMs=0)', () => {
    expect(shouldRestart(0, Date.now(), 45_000)).toBe(false);
  });

  it('does not restart before the threshold elapses', () => {
    const now = Date.now();
    expect(shouldRestart(now - 10_000, now, 45_000)).toBe(false);
  });

  it('restarts once the threshold is reached exactly', () => {
    const now = Date.now();
    expect(shouldRestart(now - 45_000, now, 45_000)).toBe(true);
  });

  it('restarts once the threshold is exceeded', () => {
    const now = Date.now();
    expect(shouldRestart(now - 90_000, now, 45_000)).toBe(true);
  });

  it('honors a custom threshold', () => {
    const now = Date.now();
    expect(shouldRestart(now - 5_000, now, 10_000)).toBe(false);
    expect(shouldRestart(now - 15_000, now, 10_000)).toBe(true);
  });
});

/**
 * WI-6744 — escalate on stall FREQUENCY, not only on one long outage.
 *
 * shouldRestart only fires when a SINGLE outage exceeds the threshold, so a burst of short
 * outages that each self-recover produces a run of reassuring `recovered (was unreachable 10s)`
 * lines and no action at all. That is how WI-6740 survived three weeks: severity was invisible
 * at the layer that observed it.
 */
describe('mcp-proxy watchdog — evaluateStallRate (burst detection)', () => {
  const now = 1_700_000_000_000;
  const HOUR = 3_600_000;

  it('does not escalate below the threshold', () => {
    const r = evaluateStallRate([now - 60_000, now - 120_000], now, HOUR, 3);
    expect(r.count).toBe(2);
    expect(r.escalate).toBe(false);
  });

  it('THE POINT: escalates on a burst of SELF-RECOVERED stalls, which shouldRestart never sees', () => {
    const onsets = [now - 1_000, now - 600_000, now - 1_200_000];
    // Each of these recovered in ~10s, so the single-outage detector stays silent...
    for (const t of onsets) expect(shouldRestart(t, t + 10_000, 45_000)).toBe(false);
    // ...but the rate detector fires.
    expect(evaluateStallRate(onsets, now, HOUR, 3).escalate).toBe(true);
  });

  it('prunes events outside the window and returns the survivors', () => {
    const r = evaluateStallRate([now - 10_000, now - HOUR - 1, now - 2 * HOUR], now, HOUR, 3);
    expect(r.kept).toEqual([now - 10_000]);
    expect(r.count).toBe(1);
    expect(r.escalate).toBe(false);
  });

  it('an old burst that has aged out does not keep firing', () => {
    const stale = [now - HOUR - 1, now - HOUR - 2, now - HOUR - 3];
    expect(evaluateStallRate(stale, now, HOUR, 3)).toMatchObject({ count: 0, escalate: false });
  });

  it('escalates exactly AT the threshold, not one past it', () => {
    const three = [now - 1, now - 2, now - 3];
    expect(evaluateStallRate(three, now, HOUR, 3).escalate).toBe(true);
    expect(evaluateStallRate(three.slice(0, 2), now, HOUR, 3).escalate).toBe(false);
  });
});

/**
 * EI-19299524366372518 — the session-plane probe.
 *
 * On 2026-08-01 /api/health answered 200 in ~2ms for ~100 minutes while the MCP tool
 * plane was completely dead (fleet throughput 2759 -> 44 calls/30min; 29 sessions dark
 * a median of 80 minutes). The reachability probe above is structurally incapable of
 * seeing that, so these tests pin the verdict logic that can — including the two
 * false-positive traps measured against the live endpoint, either of which would have
 * made the new detector worse than no detector at all.
 */
describe('mcp-proxy watchdog — classifyProbeResult (session plane)', () => {
  const withTools = (n: number) => ({
    result: { tools: Array.from({ length: n }, (_, i) => ({ name: `t${i}` })) },
  });

  it('THE MISS: a target that serves a non-empty catalog is healthy', () => {
    expect(classifyProbeResult({ status: 200, json: withTools(742) })).toBe('ok');
  });

  it('THE MISS: a 200 that carries no catalog at all is NOT healthy', () => {
    // This is the shape /api/health would produce — a fine HTTP response proving nothing
    // about the tool plane. The old probe accepted exactly this and stayed silent.
    expect(classifyProbeResult({ status: 200, json: { ok: true } })).toBe('dead');
  });

  it('treats a timeout / connection error as dead', () => {
    expect(classifyProbeResult({ networkError: new Error('The operation was aborted') })).toBe('dead');
  });

  it('treats a non-200 as dead', () => {
    expect(classifyProbeResult({ status: 503, json: withTools(742) })).toBe('dead');
  });

  it('treats an unparseable body as dead', () => {
    expect(classifyProbeResult({ status: 200, json: null })).toBe('dead');
  });

  it('TRAP 1: a rejected bearer is auth, not a dead service', () => {
    // Verbatim shape from the live endpoint. Its own message warns this is NOT
    // "a healthy server with zero tools" — and it must not be read as a dead one either.
    const json = {
      error: {
        code: -32603,
        message:
          'mcp_auth_failed: superuser_invalid_bearer — this MCP session is UNAUTHENTICATED, so it exposes NO tools (this is NOT "a healthy server with zero tools").',
      },
    };
    expect(classifyProbeResult({ status: 200, json })).toBe('auth');
  });

  it('TRAP 2: 200 + zero tools + no error is ambiguous, never a verdict', () => {
    // `?tools=does-not-exist` returns exactly this, indistinguishable from an empty
    // registry — so it must resolve to 'empty' (caller confirms), never to 'dead'.
    expect(classifyProbeResult({ status: 200, json: withTools(0) })).toBe('empty');
  });

  it('a non-auth JSON-RPC error is dead', () => {
    expect(classifyProbeResult({ status: 200, json: { error: { code: -32000, message: 'boom' } } })).toBe('dead');
  });
});

/**
 * WI-6739 — the DATA plane, the third and last plane.
 *
 * The 2026-08-01 outage had three independent planes and only the third was broken:
 *   /api/health   → 200 in ~2ms, continuously, for the whole ~100 minutes.
 *   session plane → fine. 9 failed `/api/mcp` requests in the entire peak hour.
 *   data plane    → dead. 5,542 failed DB-backed bootstrap-su/heartbeat POSTs (HTTP 408),
 *                   because :3070 was ECONNREFUSING a stale embedded-pg port and never
 *                   re-resolved it.
 *
 * The catalog is served from an in-memory registry and never touches Postgres, so the
 * session-plane probe stays GREEN throughout — a detector that is green during the incident
 * it exists to catch is worse than no detector, because it actively reassures. That is what
 * the first test below pins, and it is the only test here that would have changed the
 * outcome on the day.
 *
 * The rest pin the conservatism that keeps this from crying wolf: OUR misconfiguration
 * ('config') must never be reported as a service fault ('dead'), because a watchdog that
 * alarms on its own stale probe config gets muted, and a muted watchdog is the blindness
 * it replaced.
 */
describe('mcp-proxy watchdog — classifyDataPlaneResult (data plane, WI-6739)', () => {
  /** A tool catalog is served from memory; it proves nothing about the database. */
  const healthyCatalog = { result: { tools: [{ name: 'coord:orient' }] } };

  it('THE 2026-08-01 MISS: catalog-green + DB-dead — the two classifiers MUST disagree', () => {
    // Same instant, same operator, two probes. This divergence is the entire reason the
    // data-plane probe exists: collapse them and ~100 minutes pass with nothing alarming.
    expect(classifyProbeResult({ status: 200, json: healthyCatalog })).toBe('ok');
    expect(classifyDataPlaneResult({ status: 408 })).toBe('dead');
  });

  it('a result that came back is healthy — the query ran', () => {
    expect(classifyDataPlaneResult({ status: 200, json: { result: { ok: true, count: 25 } } })).toBe(
      'ok',
    );
  });

  it('a timeout is dead — a pool waiting on a dead endpoint never answers', () => {
    // The live signature: fetch aborts at the probe timeout with "This operation was aborted".
    expect(classifyDataPlaneResult({ networkError: new Error('This operation was aborted') })).toBe(
      'dead',
    );
  });

  it('408 is dead — that is literally what clients saw on 2026-08-01', () => {
    expect(classifyDataPlaneResult({ status: 408 })).toBe('dead');
    expect(classifyDataPlaneResult({ status: 500 })).toBe('dead');
    expect(classifyDataPlaneResult({ status: 502 })).toBe('dead');
  });

  it('an unparseable or absent body is dead, never silently ok', () => {
    expect(classifyDataPlaneResult({ status: 200, json: null })).toBe('dead');
    expect(classifyDataPlaneResult({ status: 200, json: 'not json' })).toBe('dead');
    expect(classifyDataPlaneResult()).toBe('dead');
  });

  it('THE SIGNAL: the tool RAN but could not reach Postgres — connection-shaped errors are dead', () => {
    // These arrive as a well-formed JSON-RPC error with HTTP 200, so only the message
    // distinguishes "the database is gone" from "I called the tool wrong".
    for (const message of [
      'connect ECONNREFUSED 127.0.0.1:20216', // the exact 2026-08-01 error, 20,144 times
      'connect ETIMEDOUT 127.0.0.1:5432',
      'read ECONNRESET',
      'timeout exceeded when trying to connect',
      'Connection terminated unexpectedly',
      'pool is draining and cannot accept work',
    ]) {
      expect(classifyDataPlaneResult({ status: 200, json: { error: { code: -32603, message } } })).toBe(
        'dead',
      );
    }
  });

  it('OUR credential is config, never a service fault', () => {
    // A watchdog that escalates because its own bearer expired is strictly worse than the
    // blindness it replaced — the same trap already guarded on the session plane.
    expect(
      classifyDataPlaneResult({
        status: 200,
        json: { error: { code: -32603, message: 'this MCP session is UNAUTHENTICATED' } },
      }),
    ).toBe('config');
  });

  it('a fail-closed native-session verifier result is dead and reaches the pool sampler', () => {
    expect(
      classifyDataPlaneResult({
        status: 200,
        json: {
          result: {
            isError: true,
            content: [{ type: 'text', text: 'request_rejected: superuser_native_session_verifier_unavailable' }],
          },
        },
      }),
    ).toBe('dead');
  });

  it('a tool-level credential error remains config, not a service fault', () => {
    expect(
      classifyDataPlaneResult({
        status: 200,
        json: {
          result: {
            isError: true,
            content: [{ type: 'text', text: 'request_rejected: this MCP session is UNAUTHENTICATED' }],
          },
        },
      }),
    ).toBe('config');
  });

  it('OUR probe args / a renamed probe tool is config, never dead', () => {
    // The failure mode this guards: someone renames the probe tool, every poll starts
    // erroring, and a watchdog that called that "dead" would page about a healthy operator.
    for (const message of [
      'Tool facts:list not found',
      'Invalid arguments: scope must be one of workspace|role|owner',
      'unknown parameter "scope"',
    ]) {
      expect(classifyDataPlaneResult({ status: 200, json: { error: { code: -32602, message } } })).toBe(
        'config',
      );
    }
  });

  it('200 with neither result nor error is config, not dead — an unrecognised shape is our problem', () => {
    expect(classifyDataPlaneResult({ status: 200, json: {} })).toBe('config');
  });

  it('a config verdict is never reachable from a transport failure', () => {
    // Pins the asymmetry that makes the classifier safe: anything that did not come back
    // is ALWAYS 'dead'. 'config' requires a well-formed answer from a live server.
    for (const input of [
      { networkError: new Error('socket hang up') },
      { status: 408 },
      { status: 503 },
    ]) {
      expect(classifyDataPlaneResult(input)).not.toBe('config');
    }
  });
});

/**
 * WI-6739 — the probe's ARGUMENTS, and why the printed remedy has to be executable.
 *
 * On a 'config' verdict the watchdog tells its reader to point DB_PROBE_TOOL at a live
 * read-only tool. The args were hard-coded to the DEFAULT tool's (`{ scope: 'workspace' }`),
 * so obeying that instruction sent one tool's arguments to a different tool, failed
 * validation, and produced another 'config' verdict — a documented fix that could not work,
 * leaving the watchdog blind while it looked configured.
 */
describe('mcp-proxy watchdog — dataPlaneProbeArgs (WI-6739)', () => {
  it('sends the default args ONLY to the default tool', () => {
    expect(dataPlaneProbeArgs('facts:list', undefined)).toEqual({
      args: { scope: 'workspace' },
      invalid: false,
    });
  });

  it("THE TRAP: an overridden tool does NOT inherit the default tool's arguments", () => {
    expect(dataPlaneProbeArgs('work_items:list', undefined)).toEqual({ args: {}, invalid: false });
  });

  it('an explicit JSON override wins for any tool', () => {
    expect(dataPlaneProbeArgs('work_items:list', '{"state":"open","limit":1}')).toEqual({
      args: { state: 'open', limit: 1 },
      invalid: false,
    });
    // …including for the default tool, so a cheaper scope can be pinned without a code change.
    expect(dataPlaneProbeArgs('facts:list', '{"limit":1}')).toEqual({
      args: { limit: 1 },
      invalid: false,
    });
  });

  it('a malformed override is REPORTED, never silently replaced with another tool’s args', () => {
    // Silently substituting would reproduce the very bug this function fixes, one layer down.
    for (const raw of ['{not json', '[]', '"a string"', '42', 'null']) {
      expect(dataPlaneProbeArgs('work_items:list', raw)).toEqual({ args: {}, invalid: true });
    }
  });

  it('blank / whitespace / unset all mean "no override"', () => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(dataPlaneProbeArgs('facts:list', raw)).toEqual({
        args: { scope: 'workspace' },
        invalid: false,
      });
    }
  });

  it('never hands back the shared default object, so a caller cannot mutate the next probe', () => {
    const first = dataPlaneProbeArgs('facts:list', undefined).args as Record<string, unknown>;
    first.scope = 'mutated';
    expect(dataPlaneProbeArgs('facts:list', undefined).args).toEqual({ scope: 'workspace' });
  });
});

describe('mcp-proxy watchdog — decideHandshakeAction (proxy vs upstream)', () => {
  it('restarts the proxy only when the upstream is provably serving', () => {
    expect(decideHandshakeAction('dead', 'ok')).toBe('restart-proxy');
  });

  it('THE 2026-08-01 CASE: both dead => upstream, and the proxy is NOT restarted', () => {
    // Restarting the proxy here fixes nothing, burns a circuit-breaker slot, and makes
    // the log blame the wrong service. Only a :3070 restart cleared the real incident.
    expect(decideHandshakeAction('dead', 'dead')).toBe('upstream-wedged');
  });

  it('never acts on our own credential failure', () => {
    expect(decideHandshakeAction('auth', 'ok')).toBe('none');
    expect(decideHandshakeAction('auth', 'dead')).toBe('none');
  });

  it('does nothing while the proxy is healthy', () => {
    expect(decideHandshakeAction('ok', 'dead')).toBe('none');
  });
});

/**
 * buildEscalationCall (EI-19415174699106397) — a CRITICAL verdict used to reach only a durable
 * log file nobody tails in real time. Measured live 2026-08-03: this watchdog correctly
 * diagnosed a dead data plane and repeated the same CRITICAL line for 25 minutes while nobody
 * acted, because it had no channel to reach a human. These pin the request shape sent to
 * coord:escalate; the network POST itself is untested here (same convention as restart()/the
 * probe functions above — side effects are exercised live, not mocked).
 */
describe('mcp-proxy watchdog — buildEscalationCall (human escalation, EI-19415174699106397)', () => {
  it('targets coord:escalate as a blocker with the given conditionKey', () => {
    const call = buildEscalationCall('mcp-data-plane-dead', 'summary text', 'body text');
    expect(call.method).toBe('tools/call');
    expect(call.params.name).toBe('coord:escalate');
    expect(call.params.arguments.severity).toBe('blocker');
    expect(call.params.arguments.conditionKey).toBe('mcp-data-plane-dead');
    expect(call.params.arguments.summary).toBe('summary text');
    expect(call.params.arguments.body).toBe('body text');
  });

  it('THE POINT: the conditionKey is stable across repeated calls with a changing summary — coalesces onto one open row instead of leaking a new escalation per throttle window (the WI-... flood class)', () => {
    const first = buildEscalationCall('mcp-data-plane-dead', 'dead 120s', 'remediate');
    const second = buildEscalationCall('mcp-data-plane-dead', 'dead 720s', 'remediate');
    expect(first.params.arguments.conditionKey).toBe(second.params.arguments.conditionKey);
    expect(first.params.arguments.summary).not.toBe(second.params.arguments.summary);
  });

  it('marks the evidence as observed by the watchdog itself, never a bare unattributed claim', () => {
    const call = buildEscalationCall('mcp-proxy-stall-rate', 's', 'b');
    expect(call.params.arguments.evidence).toEqual({ band: 'observed', reportedBy: 'mcp-proxy-watchdog' });
  });

  it('body is optional', () => {
    const call = buildEscalationCall('k', 's', undefined);
    expect(call.params.arguments.body).toBeUndefined();
  });
});

/**
 * WI-39378 — a restart must never fire on a verdict that went stale mid-decision.
 *
 * Restarting the proxy is destructive to THIRD PARTIES: it kills every agent's
 * in-flight MCP call ("transport dropped mid-call; response was lost"). pollHandshake
 * decides "dead", then awaits an upstream probe that can burn a full
 * HANDSHAKE_TIMEOUT_MS, and only then acts — and the plane can recover inside that
 * window. It did, live, on 2026-08-16T03:54:37Z, verbatim from the watchdog's own log:
 *
 *     03:54:37.232Z session plane recovered (was failing 156s)
 *     03:54:37.826Z WEDGED -> restarting papercup-mcp-proxy: session plane dead 150s
 *
 * i.e. it restarted the proxy 594ms AFTER observing the plane was healthy, killing two
 * of this author's calls and everyone else's. A recovery must cancel a pending restart,
 * never race it.
 */
describe('mcp-proxy watchdog — no restart on a stale verdict (WI-39378)', () => {
  it('THE BUG: stands down when a concurrent poll already observed recovery (failingSince cleared)', () => {
    expect(decideRestartAfterRecheck(0, 'dead')).toBe('stand-down-recovered');
  });

  it('THE BUG: stands down when the plane answers on the fresh re-check, however dead it looked before', () => {
    expect(decideRestartAfterRecheck(Date.now() - 200_000, 'ok')).toBe('stand-down-recheck-ok');
  });

  it('CONTROL: still restarts when the plane is genuinely still dead — the guard is not a blanket veto', () => {
    expect(decideRestartAfterRecheck(Date.now() - 200_000, 'dead')).toBe('restart');
  });

  it('CONTROL: a non-ok, non-dead re-check verdict is not treated as recovery', () => {
    // Only an explicit 'ok' proves the plane answered. 'empty'/'auth' are ambiguous and
    // must not silently cancel a legitimate restart.
    expect(decideRestartAfterRecheck(Date.now() - 200_000, 'empty')).toBe('restart');
  });

  it('the pre-probe call form (recheckKind null) checks ONLY the concurrent-recovery case', () => {
    expect(decideRestartAfterRecheck(0, null)).toBe('stand-down-recovered');
    expect(decideRestartAfterRecheck(Date.now() - 200_000, null)).toBe('restart');
  });
});

/**
 * WI-39378 — `secs` was referenced inside pollDataPlane but declared only inside
 * pollHandshake, a different function scope. pollDataPlane is awaited FROM
 * pollHandshake, so the ReferenceError unwound into that caller's `.catch` and showed
 * up as one line: `handshake poll error: secs is not defined`.
 *
 * The expensive part was not the log line. The throw happened BEFORE
 * escalateToHuman('mcp-data-plane-dead', ...) on the next statement, so the WI-6739
 * data-plane escalation could never fire — the detector was silently dead in exactly
 * the scenario it was built for, and stayed that way undetected.
 *
 * watchdog.mjs is plain unchecked .mjs (lint:tsc covers only packages/operator-core),
 * which is why a free identifier survived review. These pin the fix at the source
 * level, since neither poll function is exported.
 */
describe('mcp-proxy watchdog — data-plane escalation is reachable (WI-39378)', () => {
  let src: string;
  beforeAll(async () => {
    const { readFile } = await import('node:fs/promises');
    // Subject path is overridable so falsifiability can be proven against a COPY
    // outside the tree (scripts/mutation-probe.sh), never by mutating the shared
    // checkout — git-sync sweeps the whole tree on a timer and would commit the
    // mutant even if nothing went wrong. See CLAUDE.md "Proving a guard is falsifiable".
    const subject = process.env.PROBE_WATCHDOG ?? new URL('./watchdog.mjs', import.meta.url);
    src = await readFile(subject, 'utf8');
  });

  /** The body of a top-level `async function <name>(...)`, by brace matching. */
  function functionBody(source: string, name: string): string {
    const start = source.indexOf(`async function ${name}(`);
    expect(start, `function ${name} not found`).toBeGreaterThan(-1);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  it('THE BUG: pollDataPlane declares every identifier it uses — `secs` is not borrowed from pollHandshake', () => {
    const body = functionBody(src, 'pollDataPlane');
    // It may still USE secs (the message wants a duration) but must DECLARE it locally.
    if (/\bsecs\b/.test(body)) {
      expect(body, 'pollDataPlane references `secs` without declaring it in its own scope').toMatch(
        /(const|let)\s+secs\s*=/,
      );
    }
  });

  it('THE CONSEQUENCE: escalateToHuman for the data-plane condition is still wired in pollDataPlane', () => {
    const body = functionBody(src, 'pollDataPlane');
    expect(body).toContain("escalateToHuman('mcp-data-plane-dead'");
  });

  it('CONTROL: the brace matcher really extracts a bounded body, not the whole file', () => {
    const body = functionBody(src, 'pollDataPlane');
    expect(body.length).toBeLessThan(src.length);
    // pollHandshake's own `const secs` must be OUTSIDE the extracted body, or the
    // assertion above would pass for the very bug it is meant to catch.
    expect(body).not.toContain('async function pollHandshake');
  });
});
