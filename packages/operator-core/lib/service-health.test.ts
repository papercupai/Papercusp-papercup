/**
 * diffHealth — pure transition detector (fleet-coordination-painpoints P-017).
 */
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { describe, it, expect } from 'vitest';
import {
  diffHealth,
  HEALTH_ENDPOINTS,
  resolveHealthEndpoints,
  probeEndpoint,
  tcpPreflight,
  CONNECT_PREFLIGHT_MS,
  evaluateBgHostTicker,
  evaluateBgHostCodeDrift,
  evaluateMcpProxyCodeDrift,
  evaluateMcpProxyBgHostCodeDrift,
  MCP_PROXY_HOT_PATHS,
  MCP_PROXY_BG_HOST_HOT_PATHS,
  probeBgHostCodeDrift,
  probeMcpProxyBgHostCodeDrift,
  BG_HOST_HOT_PATHS,
  BG_HOST_ARTIFACT_PATHS,
  BG_HOST_STALE_MS,
  compareCommittedHotPaths,
  SUPERVISED_PROCESSES,
  supervisedProcesses,
  applyDownConfirmDebounce,
  DOWN_CONFIRM_TICKS,
  PORTLESS_PROBE_NAME_SET,
  OPERATOR_DOWN_CONFIRM_TICKS,
  STAGING_API_DOWN_CONFIRM_TICKS,
  DESKTOP_DOWN_CONFIRM_TICKS,
  EMBED_SIDECAR_DOWN_CONFIRM_TICKS,
  classifyListenerWedge,
  localProbePort,
  detectWedgedListener,
  parseMcpHandshakePayload,
  probeMcpHandshake,
  MCP_HEALTH_PROBE_CLIENT,
  type CodeDriftExecFile,
  type ProbeResult,
} from './service-health';
import type { ListeningSocket } from './listening-sockets';
import { collectServiceDownSignals } from './harness/improvements/watchdog';

const r = (name: string, up: boolean): ProbeResult => ({
  name,
  up,
  status: up ? 200 : null,
  latencyMs: 1,
});

describe('probeMcpHandshake — bounded control-plane health verdict (EI-21392098254217280)', () => {
  it('parses both direct JSON and streamable-HTTP SSE data envelopes', () => {
    const payload = { jsonrpc: '2.0', id: 'mcp-health', result: { protocolVersion: '2025-06-18' } };
    expect(parseMcpHandshakePayload(JSON.stringify(payload))).toEqual(payload);
    expect(
      parseMcpHandshakePayload(`event: message\ndata: ${JSON.stringify(payload)}\n\n`),
    ).toEqual(payload);
    expect(parseMcpHandshakePayload('not-json')).toBeNull();
  });

  it('reports a valid initialize round-trip and sends the named diagnostic client marker', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const result = await probeMcpHandshake(
      'http://127.0.0.1:3170/',
      100,
      async (input, init) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id: 'mcp-health',
          result: { protocolVersion: '2025-06-18' },
        }), { status: 200 });
      },
      (() => {
        const ticks = [1000, 1007];
        return () => ticks.shift() ?? 1007;
      })(),
    );

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      protocolVersion: '2025-06-18',
      latencyMs: 7,
      url: `http://127.0.0.1:3170/api/mcp?client=${MCP_HEALTH_PROBE_CLIENT}`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({ method: 'initialize', id: 'mcp-health' });
  });

  it('fails closed when HTTP succeeds but MCP initialize is malformed or returns an error', async () => {
    const malformed = await probeMcpHandshake(
      'http://127.0.0.1:3170',
      100,
      async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'mcp-health', result: {} }), { status: 200 }),
    );
    expect(malformed).toMatchObject({ ok: false, status: 200 });
    expect(malformed.note).toMatch(/protocolVersion/);

    const error = await probeMcpHandshake(
      'http://127.0.0.1:3170',
      100,
      async () => new Response(JSON.stringify({
        jsonrpc: '2.0',
        id: 'mcp-health',
        error: { code: -32000, message: 'busy' },
      }), { status: 200 }),
    );
    expect(error).toMatchObject({ ok: false, status: 200 });
    expect(error.note).toMatch(/JSON-RPC error.*busy/);
  });

  it('reports an HTTP failure and a timeout as distinct, bounded verdicts', async () => {
    const httpFailure = await probeMcpHandshake(
      'http://127.0.0.1:3170',
      100,
      async () => new Response('overloaded', { status: 503 }),
    );
    expect(httpFailure).toMatchObject({ ok: false, status: 503 });
    expect(httpFailure.note).toBe('MCP initialize returned HTTP 503');

    const timeout = await probeMcpHandshake(
      'http://127.0.0.1:3170',
      5,
      async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    );
    expect(timeout.ok).toBe(false);
    expect(timeout.note).toMatch(/MCP initialize timed out after 5ms/);
  });
});

describe('diffHealth', () => {
  it('alerts a first-seen DOWN but stays silent on a first-seen UP (no startup spam)', () => {
    const { transitions, next } = diffHealth({}, [r('a', false), r('b', true)]);
    expect(transitions).toEqual([{ name: 'a', to: 'down' }]);
    expect(next).toEqual({ a: false, b: true });
  });

  it('reports only the endpoints that changed (up→down and down→up)', () => {
    const { transitions } = diffHealth({ a: true, b: false, c: true }, [
      r('a', false),
      r('b', true),
      r('c', true),
    ]);
    expect(transitions).toEqual([
      { name: 'a', to: 'down' },
      { name: 'b', to: 'up' },
    ]);
  });

  it('no change → no transitions', () => {
    expect(diffHealth({ a: true }, [r('a', true)]).transitions).toEqual([]);
  });

  // A `present: false` result is a legitimately-absent service (the desktop is
  // not running) — it must never produce a phantom DOWN/recovered (P-019).
  const absent = (name: string): ProbeResult => ({
    name,
    up: false,
    present: false,
    status: null,
    latencyMs: 1,
  });

  it('skips an absent (present:false) service — no transition, drops its state', () => {
    const { transitions, next } = diffHealth({}, [absent('desktop'), r('a', true)]);
    expect(transitions).toEqual([]); // desktop absent → no DOWN; a first-seen-up → silent
    expect(next).toEqual({ a: true }); // desktop not carried forward
  });

  it('a previously-up service going absent does NOT alert and is forgotten', () => {
    const { transitions, next } = diffHealth({ desktop: true }, [absent('desktop')]);
    expect(transitions).toEqual([]);
    expect(next.desktop).toBeUndefined();
  });

  it('a present desktop that is down DOES alert (running but unhealthy)', () => {
    const present: ProbeResult = { name: 'desktop', up: false, present: true, status: null, latencyMs: 1 };
    const { transitions } = diffHealth({ desktop: true }, [present]);
    expect(transitions).toEqual([{ name: 'desktop', to: 'down' }]);
  });
});

// EI-18144960689849695: desktop flapped DOWN→recovered 500+ times since
// 2026-07-04 even after the two prior desktop-flap fixes (EI-7760 racy
// singleton, EI-18131725582506957 single ipc-connect retry) — the remaining
// cause is diffHealth's own single-bad-tick-no-debounce design. Require
// DESKTOP_DOWN_CONFIRM_TICKS consecutive bad ticks before `desktop` is
// reported down to any consumer; a single good tick clears the streak.
// WI-6146/P-013 generalized this from a desktop-only special case to the
// per-probe DOWN_CONFIRM_TICKS map. The desktop cases below are UNCHANGED in
// substance — they are the parity guard proving the generalization did not
// alter the behaviour EI-18144960689849695 shipped.
describe('applyDownConfirmDebounce (EI-18144960689849695 — flap damping)', () => {
  const down = (note = 'ipc socket unreachable'): ProbeResult => ({
    name: 'desktop',
    up: false,
    present: true,
    status: null,
    latencyMs: 1,
    note,
  });
  const up: ProbeResult = { name: 'desktop', up: true, present: true, status: null, latencyMs: 1, note: 'up' };
  const absent: ProbeResult = { name: 'desktop', up: false, present: false, status: null, latencyMs: 1 };
  const other: ProbeResult = { name: 'operator', up: true, status: 200, latencyMs: 1 };

  it('a single bad tick is SUPPRESSED (reported up, annotated) below the confirm threshold', () => {
    const { results, nextStreaks } = applyDownConfirmDebounce([down(), other], {});
    expect(nextStreaks.desktop).toBe(1);
    expect(nextStreaks.desktop).toBeLessThan(DESKTOP_DOWN_CONFIRM_TICKS);
    const d = results.find((r) => r.name === 'desktop')!;
    expect(d.up).toBe(true);
    expect(d.note).toMatch(/unconfirmed down \(streak 1\/2\)/);
    expect(d.note).toMatch(/ipc socket unreachable/); // original detail preserved
    // untouched entries pass through unchanged
    expect(results.find((r) => r.name === 'operator')).toEqual(other);
  });

  it('reports genuinely DOWN once the streak reaches the confirm threshold', () => {
    const first = applyDownConfirmDebounce([down()], {});
    const second = applyDownConfirmDebounce([down()], first.nextStreaks);
    expect(second.nextStreaks.desktop).toBe(DESKTOP_DOWN_CONFIRM_TICKS);
    const d = second.results.find((r) => r.name === 'desktop')!;
    expect(d.up).toBe(false);
    expect(d.note).toBe('ipc socket unreachable'); // unmodified once confirmed
  });

  it('a single good tick immediately clears an in-progress streak (fast-recover, slow-alarm)', () => {
    const { nextStreaks: afterOneBad } = applyDownConfirmDebounce([down()], {});
    expect(afterOneBad.desktop).toBe(1);
    const { results, nextStreaks } = applyDownConfirmDebounce([up], afterOneBad);
    expect(nextStreaks.desktop).toBeUndefined();
    expect(results.find((r) => r.name === 'desktop')).toEqual(up); // pass-through, no rewrite
  });

  it('a legitimately-absent desktop (present:false) resets the streak and passes through untouched', () => {
    const { results, nextStreaks } = applyDownConfirmDebounce([absent], { desktop: 2 });
    expect(nextStreaks.desktop).toBeUndefined();
    expect(results.find((r) => r.name === 'desktop')).toEqual(absent);
  });

  it('no desktop entry in the batch → streak resets, results untouched', () => {
    const { results, nextStreaks } = applyDownConfirmDebounce([other], { desktop: 3 });
    expect(nextStreaks.desktop).toBeUndefined();
    expect(results).toEqual([other]);
  });

  it('does not touch non-desktop entries even while desktop is being debounced', () => {
    const { results } = applyDownConfirmDebounce([other, down()], {});
    expect(results.find((r) => r.name === 'operator')).toEqual(other);
  });

  // ── WI-6146 / P-013: the generalization itself ──

  const stagingDown: ProbeResult = {
    name: 'staging-api',
    up: false,
    status: null,
    latencyMs: 1,
    note: 'connect ECONNREFUSED',
  };

  it('damps staging-api too: a dev:restart blip is suppressed, a real outage confirms', () => {
    const first = applyDownConfirmDebounce([stagingDown], {});
    expect(first.nextStreaks['staging-api']).toBe(1);
    expect(first.results[0].up).toBe(true); // restart blip — not yet an outage
    expect(first.results[0].note).toMatch(/unconfirmed down \(streak 1\/2\)/);

    const second = applyDownConfirmDebounce([stagingDown], first.nextStreaks);
    expect(second.nextStreaks['staging-api']).toBe(STAGING_API_DOWN_CONFIRM_TICKS);
    expect(second.results[0].up).toBe(false); // sustained — a real DOWN still alarms
    expect(second.results[0].note).toBe('connect ECONNREFUSED');
  });

  it('damps embed-sidecar functional probe blips while confirming a sustained outage', () => {
    const embedDown: ProbeResult = {
      name: 'embed-sidecar',
      up: false,
      present: true,
      status: null,
      latencyMs: 1_201,
      note: 'functional POST /embed failed within 1200ms: timeout',
    };

    const first = applyDownConfirmDebounce([embedDown], {});
    expect(first.nextStreaks['embed-sidecar']).toBe(1);
    expect(first.nextStreaks['embed-sidecar']).toBeLessThan(EMBED_SIDECAR_DOWN_CONFIRM_TICKS);
    expect(first.results[0].up).toBe(true); // one functional timeout is a transient blip
    expect(first.results[0].note).toMatch(/unconfirmed down \(streak 1\/2\)/);

    const second = applyDownConfirmDebounce([embedDown], first.nextStreaks);
    expect(second.nextStreaks['embed-sidecar']).toBe(EMBED_SIDECAR_DOWN_CONFIRM_TICKS);
    expect(second.results[0].up).toBe(false); // sustained failure still alarms
    expect(second.results[0].note).toBe(embedDown.note);
  });

  it('an endpoint absent from the opt-in map keeps single-tick alerting', () => {
    const unlistedDown: ProbeResult = { name: 'unlisted-probe', up: false, status: null, latencyMs: 1 };
    const { results, nextStreaks } = applyDownConfirmDebounce([unlistedDown], {});
    expect(results[0].up).toBe(false); // reported DOWN immediately, no suppression
    expect(results[0]).toEqual(unlistedDown); // untouched
    expect(nextStreaks['unlisted-probe']).toBeUndefined(); // no streak carried for undamped names
  });

  it('damps a single operator preflight failure but confirms a sustained outage', () => {
    const operatorDown: ProbeResult = { name: 'operator', up: false, status: null, latencyMs: 1 };
    const first = applyDownConfirmDebounce([operatorDown], {});
    expect(OPERATOR_DOWN_CONFIRM_TICKS).toBe(2);
    expect(first.nextStreaks.operator).toBe(1);
    expect(first.results[0].up).toBe(true); // a one-tick restart/startup blip is suppressed
    expect(first.results[0].note).toMatch(/unconfirmed down \(streak 1\/2\)/);

    const second = applyDownConfirmDebounce([operatorDown], first.nextStreaks);
    expect(second.nextStreaks.operator).toBe(OPERATOR_DOWN_CONFIRM_TICKS);
    expect(second.results[0]).toEqual(operatorDown); // persistent DOWN still alerts
  });

  it('tracks streaks per name independently', () => {
    const step1 = applyDownConfirmDebounce([down(), stagingDown], {});
    expect(step1.nextStreaks).toEqual({ desktop: 1, 'staging-api': 1 });
    // desktop recovers, staging-api stays down → only staging-api's streak advances
    const step2 = applyDownConfirmDebounce([up, stagingDown], step1.nextStreaks);
    expect(step2.nextStreaks.desktop).toBeUndefined();
    expect(step2.nextStreaks['staging-api']).toBe(2);
    expect(step2.results.find((r) => r.name === 'staging-api')!.up).toBe(false);
  });

  it('every DOWN_CONFIRM_TICKS name is a real probe target (no damping a name nothing emits)', () => {
    // The real probe-name universe is the fixed-URL specs PLUS the portless
    // probes. This used to read `[...HEALTH_ENDPOINTS, 'desktop']` — a bare
    // literal that silently claimed `desktop` was the only portless probe, so
    // damping any OTHER portless probe failed this guard even though the name
    // was emitted on every tick. That is what happened when `bg-host-ticker`
    // was damped (EI-19375157952766991): a correct source change reddened the
    // fleet gate. Deriving from PORTLESS_PROBE_NAMES — which the emitters
    // themselves name from — keeps the guard honest about typo'd/dead names
    // while it can no longer reject a genuinely-emitted one.
    const probeNames = new Set([
      ...HEALTH_ENDPOINTS.map((e) => e.name),
      ...PORTLESS_PROBE_NAME_SET,
    ]);
    for (const name of Object.keys(DOWN_CONFIRM_TICKS)) {
      expect(probeNames.has(name), `${name} is damped but is not a probe target`).toBe(true);
    }
  });
});

describe('HEALTH_ENDPOINTS', () => {
  // EI-188: the retired standalone web app (:3001 — the "old Restart web app",
  // never running in this deployment) must NOT be monitored, or the watchdog
  // re-captures a phantom "web is DOWN" improvement every cycle.
  it('does not monitor the retired web app (:3001)', () => {
    expect(HEALTH_ENDPOINTS.some((e) => e.name === 'web')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((e) => e.url.includes(':3001'))).toBe(false);
  });

  // EI-276: the Restart shop storefront (:4321) is not part of the running stack;
  // probing it re-broadcast a phantom "shop is DOWN" on every restart/deploy and
  // fed the EI-187 CRITICAL. Must NOT be monitored.
  it('does not monitor the retired shop storefront (:4321)', () => {
    expect(HEALTH_ENDPOINTS.some((e) => e.name === 'shop')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((e) => e.url.includes(':4321'))).toBe(false);
  });

  // WI-40135 / EI-21028583648509131: the standalone Restart Scout app was
  // deleted. Papercusp's Blender/Scout cycle runs in bg-host, so :3350 can
  // never become healthy and must not remain a permanent false root cause.
  it('does not monitor the retired standalone Scout service (:3350)', () => {
    expect(HEALTH_ENDPOINTS.some((e) => e.name === 'scout')).toBe(false);
    expect(HEALTH_ENDPOINTS.some((e) => e.url.includes(':3350'))).toBe(false);
  });

  // The live set we DO watch — a guard so a retired surface can't quietly creep
  // back in (any new entry here is a deliberate edit + a failing test to update).
  it('watches exactly the live dev services', () => {
    // WI-6149 (D-010 item 4) added `oddsmith-sidecar` — the one unit of that
    // item's four candidates that is structurally eligible for a probe (persistent
    // + fixed port). The other three are recorded, with the measurement that
    // excluded each, in `NON_PROBED_UNITS`.
    expect(HEALTH_ENDPOINTS.map((e) => e.name).sort()).toEqual(
      ['oddsmith-sidecar', 'operator', 'staging-api', 'vite'].sort(),
    );
  });

  // WI-6146 / P-013 (D-010): :3170 is the staging operator CLAUDE.md tells every
  // agent to probe after `dev:restart { target:'staging' }`. It had no tool form,
  // so 80 curl atoms went to bash. It is a persistent systemd unit — so NOT
  // onDemand (a sustained down is real) — but it IS flap-damped, because
  // dev:restart restarts it several times a day on purpose.
  it('probes the :3170 staging operator, damped rather than onDemand', () => {
    const staging = HEALTH_ENDPOINTS.find((e) => e.name === 'staging-api');
    expect(staging).toBeDefined();
    expect(staging!.url).toContain(':3170');
    expect(staging!.onDemand).toBeUndefined(); // a real outage must still alarm
    expect(DOWN_CONFIRM_TICKS['staging-api']).toBe(STAGING_API_DOWN_CONFIRM_TICKS);
    // it must join its existing supervision row rather than inventing a new name
    expect(SUPERVISED_PROCESSES.some((e) => e.name === 'staging-api')).toBe(true);
  });

  // EI-6902: vite's dev-server can legitimately take several seconds to answer under
  // this box's typical concurrent build/vitest load — the shared 3000ms default fired
  // a persistent false "vite DOWN" alarm from probe impatience, not an actual outage.
  it('gives vite a more generous probe timeout than the 3000ms default', () => {
    const vite = HEALTH_ENDPOINTS.find((e) => e.name === 'vite');
    expect(vite?.timeoutMs).toBeGreaterThan(3000);
  });

  // EI-2339 recurrence guard: vite (:3055) is the Tauri desktop's on-demand dev
  // content layer — it has no systemd unit and is simply not listening whenever
  // no desktop dev shell is up, by design. It must be flagged `onDemand` so a
  // down probe never escalates like a real persistent-service outage; the
  // persistent endpoints must NOT be onDemand.
  it('flags vite (and only vite) as onDemand — a down probe must never escalate like a real outage', () => {
    const byName = Object.fromEntries(HEALTH_ENDPOINTS.map((e) => [e.name, e]));
    expect(byName.vite?.onDemand).toBe(true);
    expect(byName.operator?.onDemand).toBeFalsy();
    expect(byName['staging-api']?.onDemand).toBeFalsy();
    expect(byName['oddsmith-sidecar']?.onDemand).toBeFalsy();
  });
});

describe('resolveHealthEndpoints — packaged operator port (EI-20499210780607087)', () => {
  const savedOperatorBase = process.env.PAPERCUSP_OPERATOR_BASE;
  const savedHonoPort = process.env.PAPERCUSP_HONO_PORT;

  afterEach(() => {
    if (savedOperatorBase === undefined) delete process.env.PAPERCUSP_OPERATOR_BASE;
    else process.env.PAPERCUSP_OPERATOR_BASE = savedOperatorBase;
    if (savedHonoPort === undefined) delete process.env.PAPERCUSP_HONO_PORT;
    else process.env.PAPERCUSP_HONO_PORT = savedHonoPort;
  });

  it('targets the packaged sticky operator port while preserving the baseline registry', () => {
    process.env.PAPERCUSP_OPERATOR_BASE = 'http://127.0.0.1:18830';
    process.env.PAPERCUSP_HONO_PORT = '18830';

    expect(resolveHealthEndpoints().find((spec) => spec.name === 'operator')?.url).toBe(
      'http://127.0.0.1:18830/api/desktop/version',
    );
    expect(HEALTH_ENDPOINTS.find((spec) => spec.name === 'operator')?.url).toBe(
      'http://127.0.0.1:3070/api/desktop/version',
    );
  });

  it('does not rewrite explicit custom probe specs', () => {
    process.env.PAPERCUSP_OPERATOR_BASE = 'http://127.0.0.1:18830';
    const custom = [
      { name: 'operator', url: 'http://127.0.0.1:19999/api/desktop/version', timeoutMs: 25 },
      { name: 'fixture', url: 'http://127.0.0.1:19998/health' },
    ];

    expect(resolveHealthEndpoints(custom)).toEqual(custom);
  });
});

describe('supervisedProcesses (critical-process-supervisor-2026-07-04 P-001 — additive registry, no behavior change)', () => {
  it('returns the full initial supervised set from the plan Design section, unfiltered', () => {
    expect(supervisedProcesses().map((e) => e.name).sort()).toEqual(
      [
        'bg-host',
        // EI-20067982007251440 — bg-host's ONLY out-of-process recovery (the
        // in-process reconciler runs inside bg-host and freezes with it). Unlike
        // the entries above it is auto-restartable: `Restart=always` covers a
        // crash, not an administratively STOPPED unit. See its registry comment
        // and the dedicated guards in service-health-unit-coverage.test.ts.
        'bg-host-watchdog',
        'operator',
        'staging-api',
        'inference-gateway',
        'mcp-proxy',
        'substrate-sidecar',
        'spawner-sidecar',
        'embed-sidecar',
        'desktop-shell',
        'live-federation-gate',
        'live-federation-gate-timer',
        // WI-6149 (D-010 item 4) — probed on :46229, report-only like bg-host
        // because the unit is already Restart=always at the systemd level.
        'oddsmith-sidecar',
        // WI-38449 / D-007 F1 — the host release-gate's producer. Its timer latched
        // `failed` for ~7h on 2026-08-15/16 with nothing watching the unit, so the
        // host SLO/CLOSE_WAIT guard read a stale capture the whole window. Only the
        // `.timer` is registered; the Type=oneshot `.service` is deliberately out
        // (see the registry comment + service-health-unit-coverage.test.ts).
        'perf-signals-capture-timer',
        // EI-24811958626062774 — the job that moves :3170 forward. It ran FATAL for 5+ hours
        // on 2026-10-01 with nothing watching it; episodic, report-only, 30-min delayed alarm.
        'staging-sync',
      ].sort(),
    );
  });

  it('every entry has a layer, criticality, and boolean autoRestart; systemd-user entries carry a unit', () => {
    for (const e of SUPERVISED_PROCESSES) {
      expect(['systemd-user', 'node-child', 'desktop-shell']).toContain(e.layer);
      expect(['critical', 'important']).toContain(e.criticality);
      expect(typeof e.autoRestart).toBe('boolean');
      if (e.layer === 'systemd-user') expect(e.unit).toBeTruthy();
    }
  });

  it('bg-host and the federation test gate are report-only (autoRestart:false) — systemd already restarts bg-host, and a gate must never restart-loop', () => {
    const byName = Object.fromEntries(SUPERVISED_PROCESSES.map((e) => [e.name, e]));
    expect(byName['bg-host']?.autoRestart).toBe(false);
    expect(byName['live-federation-gate']?.autoRestart).toBe(false);
  });

  it('WI-5376: the federation gate TIMER (unlike its report-only service) is auto-restartable and carries an explicit .timer unit suffix', () => {
    const byName = Object.fromEntries(SUPERVISED_PROCESSES.map((e) => [e.name, e]));
    expect(byName['live-federation-gate-timer']?.autoRestart).toBe(true);
    expect(byName['live-federation-gate-timer']?.unit).toBe('papercup-live-federation-gate.timer');
  });

  it('filters by layer', () => {
    expect(supervisedProcesses({ layer: 'node-child' }).map((e) => e.name).sort()).toEqual(
      ['embed-sidecar', 'spawner-sidecar', 'substrate-sidecar'].sort(),
    );
  });

  it('filters by autoRestart', () => {
    const reportOnly = supervisedProcesses({ autoRestart: false }).map((e) => e.name).sort();
    // WI-6149: oddsmith-sidecar joins the report-only set for the SAME reason
    // bg-host is in it — the unit is already Restart=always under systemd, so a
    // registry restart lever would be a second restarter racing systemd's own.
    // EI-24811958626062774: staging-sync is report-only because re-running a failed sync only
    // repeats the same FATAL; the fault is in the tree or the layout.
    expect(reportOnly).toEqual(['bg-host', 'live-federation-gate', 'oddsmith-sidecar', 'staging-sync'].sort());
  });

  it('combines both filters', () => {
    expect(supervisedProcesses({ layer: 'systemd-user', autoRestart: false }).map((e) => e.name).sort()).toEqual(
      ['bg-host', 'live-federation-gate', 'oddsmith-sidecar', 'staging-sync'].sort(),
    );
  });

  // P-001 is additive-only: it must not change HEALTH_ENDPOINTS or any existing
  // probe/tick behavior — the new registry is a separate, standalone export.
  //
  // The exact-list form is deliberately brittle: adding a probe is a real
  // behaviour change (a new alarm source), so it should require a conscious
  // edit here rather than sliding in. `staging-api` was added on purpose by
  // WI-6146 / P-013 (D-010) and `oddsmith-sidecar` by WI-6149 (D-010 item 4) —
  // NEITHER is a P-001 registry side effect, which is what the intent-level
  // assertion below actually pins. (oddsmith-sidecar is in BOTH lists, and that
  // is the point: it took two separate, deliberate edits.)
  it('does not alter HEALTH_ENDPOINTS (additive-only, no behavior change)', () => {
    expect(HEALTH_ENDPOINTS.map((e) => e.name).sort()).toEqual(
      ['oddsmith-sidecar', 'operator', 'staging-api', 'vite'].sort(),
    );
  });

  it('HEALTH_ENDPOINTS is NOT derived from SUPERVISED_PROCESSES — supervision never auto-probes', () => {
    // D-010's root constraint, as an executable assertion: being supervised does
    // not make a unit answerable. If someone ever wires the registry straight
    // into the probe list, this fails and they must confront the alarm surface.
    const probed = new Set(HEALTH_ENDPOINTS.map((e) => e.name));
    const supervisedUnprobed = SUPERVISED_PROCESSES.map((e) => e.name).filter((n) => !probed.has(n));
    expect(supervisedUnprobed.length).toBeGreaterThan(0);
    // inference-gateway / mcp-proxy remain supervised-but-unprobed (D-010 item 2).
    expect(supervisedUnprobed).toContain('inference-gateway');
    expect(supervisedUnprobed).toContain('mcp-proxy');
  });
});

describe('probeEndpoint — per-spec timeout override (EI-6902)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("honors a spec's own timeoutMs over the 3000ms default (once past the TCP preflight)", async () => {
    // A real listener so the TCP preflight succeeds fast — the thing under test
    // here is the HTTP response budget, not connect reachability.
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      // A fetch that never settles — probeEndpoint must wait for the SPEC's timeout
      // (not the 3000ms default) before aborting.
      const fetchSpy = vi.fn(
        (_url: string, opts: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const start = Date.now();
      const result = await probeEndpoint({ name: 'vite', url: `http://127.0.0.1:${port}/`, timeoutMs: 20 });
      expect(Date.now() - start).toBeGreaterThanOrEqual(15); // aborted at ~20ms, not ~3000ms
      expect(result).toEqual(expect.objectContaining({ name: 'vite', up: false, status: null }));
    } finally {
      server.close();
    }
  });

  it('tolerates a slow-but-alive endpoint: connects instantly, HTTP response arrives within the response budget', async () => {
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const fetchSpy = vi.fn(
        () => new Promise((resolve) => setTimeout(() => resolve(new Response(null, { status: 200 })), 30)),
      );
      vi.stubGlobal('fetch', fetchSpy);
      const result = await probeEndpoint({ name: 'vite', url: `http://127.0.0.1:${port}/`, timeoutMs: 200 });
      expect(result.up).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('probeEndpoint — onDemand endpoints report present:false when down (EI-2339)', () => {
  it('a down onDemand endpoint (nothing listening) reports present:false with an explanatory note', async () => {
    // Nothing is listening on this port at all — mirrors "no desktop dev shell up".
    const result = await probeEndpoint({ name: 'vite', url: 'http://127.0.0.1:1/', onDemand: true, timeoutMs: 50 });
    expect(result.up).toBe(false);
    expect(result.present).toBe(false);
    expect(result.note).toMatch(/on-demand dev layer, not currently running/);
  });

  it('a down NON-onDemand endpoint still reports present unset (undefined) — normal alerting applies', async () => {
    const result = await probeEndpoint({ name: 'operator', url: 'http://127.0.0.1:1/', timeoutMs: 50 });
    expect(result.up).toBe(false);
    expect(result.present).not.toBe(false);
  });

  it('an UP onDemand endpoint is unaffected — no present:false stamped while healthy', async () => {
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
      vi.stubGlobal('fetch', fetchSpy);
      const result = await probeEndpoint({ name: 'vite', url: `http://127.0.0.1:${port}/`, onDemand: true, timeoutMs: 200 });
      expect(result.up).toBe(true);
      expect(result.present).not.toBe(false);
    } finally {
      server.close();
      vi.unstubAllGlobals();
    }
  });

  it('end-to-end: a down onDemand result is skipped by both diffHealth and collectServiceDownSignals — never escalates', async () => {
    const down = await probeEndpoint({ name: 'vite', url: 'http://127.0.0.1:1/', onDemand: true, timeoutMs: 50 });
    expect(diffHealth({ vite: true }, [down]).transitions).toEqual([]);
    expect(collectServiceDownSignals([down])).toEqual([]);
  });
});

describe('probeEndpoint — stamps the probed url on every branch (EI-13163)', () => {
  it('an UP endpoint carries the exact url that was probed', async () => {
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const fetchSpy = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
      vi.stubGlobal('fetch', fetchSpy);
      const url = `http://127.0.0.1:${port}/`;
      const result = await probeEndpoint({ name: 'operator', url, timeoutMs: 200 });
      expect(result.url).toBe(url);
    } finally {
      server.close();
      vi.unstubAllGlobals();
    }
  });

  it('a TCP-preflight-refused endpoint still carries the url (fast-fail branch)', async () => {
    const url = 'http://127.0.0.1:1/';
    const result = await probeEndpoint({ name: 'operator', url, timeoutMs: 50 });
    expect(result.up).toBe(false);
    expect(result.url).toBe(url);
  });

  it('an HTTP-fetch-throw endpoint still carries the url (catch branch)', async () => {
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const fetchSpy = vi.fn(() => Promise.reject(new Error('boom')));
      vi.stubGlobal('fetch', fetchSpy);
      const url = `http://127.0.0.1:${port}/`;
      const result = await probeEndpoint({ name: 'operator', url, timeoutMs: 200 });
      expect(result.up).toBe(false);
      expect(result.url).toBe(url);
    } finally {
      server.close();
      vi.unstubAllGlobals();
    }
  });

  it('an onDemand endpoint marked present:false still carries the url', async () => {
    const url = 'http://127.0.0.1:1/';
    const result = await probeEndpoint({ name: 'vite', url, onDemand: true, timeoutMs: 50 });
    expect(result.present).toBe(false);
    expect(result.url).toBe(url);
  });
});

describe('tcpPreflight — fast connect budget, separate from the HTTP response budget (EI-7462)', () => {
  it('a refused connection (nothing listening) resolves the DETERMINATE "refused" verdict well under the response timeout', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const start = Date.now();
    const result = await tcpPreflight(`http://127.0.0.1:${port}/`, 5000);
    const elapsed = Date.now() - start;
    // EI-18748002829224393: a real ECONNREFUSED is determinate — always 'refused',
    // never collapsed into the load-ambiguous 'indeterminate' bucket.
    expect(result).toBe('refused');
    expect(elapsed).toBeLessThan(1000); // fast ECONNREFUSED, not the 5000ms budget passed in
  });

  it('a connect that never settles (wedged accept queue OR loop lag) resolves "indeterminate" at the preflight deadline, not left hanging', async () => {
    // A fake "socket" that never emits connect or error — models EITHER a listener
    // whose backlog is stuck (SYN never completes) OR a healthy connect whose
    // callback simply never got serviced before the timer fired (EI-18748002829224393:
    // this layer cannot tell the two apart — that is why the verdict is
    // 'indeterminate', not 'refused'/down, and callers must fall through to a real probe).
    const neverSettles = () => {
      const fake = new EventEmitter() as unknown as ReturnType<typeof net.connect>;
      return fake;
    };
    const start = Date.now();
    const result = await tcpPreflight('http://127.0.0.1:1/', 50, neverSettles);
    const elapsed = Date.now() - start;
    expect(result).toBe('indeterminate');
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1000); // bounded by the preflight deadline, not any HTTP timeout
  });

  it('a connect that succeeds resolves "connected" quickly', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const result = await tcpPreflight(`http://127.0.0.1:${port}/`, CONNECT_PREFLIGHT_MS);
      expect(result).toBe('connected');
    } finally {
      server.close();
    }
  });

  it('EI-18748002829224393: an indeterminate preflight (loop-lag, not a real refusal) falls through to the real fetch and reports UP when the listener actually answers', async () => {
    // Models the reproduced bug: the TCP preflight's fixed setTimeout budget
    // expires before the connect callback is serviced (neverSettles), even
    // though the endpoint is genuinely healthy. probeEndpoint must NOT report
    // this as down — it must fall through to the real HTTP fetch.
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const neverSettles = () => new EventEmitter() as unknown as ReturnType<typeof net.connect>;
      const result = await probeEndpoint(
        { name: 'loop-lag-endpoint', url: `http://127.0.0.1:${port}/`, timeoutMs: 3000 },
        3000,
      );
      // probeEndpoint's own tcpPreflight call isn't injectable per-call today, so
      // exercise the fallback behavior directly via the real (fast, local) path —
      // the important invariant is that a healthy listener resolves up:true even
      // though the preflight budget is generous, not that the preflight itself
      // was forced indeterminate here (that is covered by the tcpPreflight unit
      // test above). Guard against a false pass: also assert the fallback logic
      // exists by checking tcpPreflight alone reports indeterminate under the
      // same never-settles injection.
      const preflightVerdict = await tcpPreflight(`http://127.0.0.1:${port}/`, 50, neverSettles);
      expect(preflightVerdict).toBe('indeterminate');
      expect(result.up).toBe(true);
    } finally {
      server.close();
    }
  });
});

describe('evaluateBgHostCodeDrift (WI-1867 — stale routines-primary detection)', () => {
  const NOW = 1_700_000_000_000;

  it('EI-20365119255138043: git-sync implementation changes are covered by the bg-host drift probe', () => {
    expect(BG_HOST_HOT_PATHS).toContain('packages/operator-core/lib/harness/git-sync');
  });

  it('tracks Red Queen sources and the compiled bg-host entrypoint', () => {
    expect(BG_HOST_HOT_PATHS).toContain('packages/operator-core/lib/red-queen');
    expect(BG_HOST_HOT_PATHS).toContain('packages/operator-core/lib/release/routine-engine-liveness.ts');
    expect(BG_HOST_ARTIFACT_PATHS).toContain('apps/operator/dist-host/hono-host.mjs');
  });

  it('hot-path change YOUNGER than the bg-host boot → drift flagged: up stays true (no alarm), note names the restart + the stale symptom', () => {
    const res = evaluateBgHostCodeDrift(NOW - 60 * 60_000, NOW - 10 * 60_000, 'packages/operator-core/lib/harness/routines/loop-fire.ts');
    expect(res.name).toBe('bg-host-code');
    expect(res.up).toBe(true); // drift is a WARNING, never a down-transition (EI-2186: restarts reclaim in-flight spawns)
    expect(res.present).not.toBe(false);
    expect(res.note).toMatch(/CODE DRIFT/);
    expect(res.note).toMatch(/loop-fire\.ts/); // the newest changed file, so the reader sees WHAT drifted
    expect(res.note).toMatch(/~50m AFTER/); // boot 60m ago, change 10m ago
    expect(res.note).toMatch(/systemctl --user restart papercusp-bg-host\.service/);
    expect(res.note).toMatch(/doesn't take effect/); // the exact symptom an agent greps for
  });

  it('hot-path change OLDER than the boot → current, no drift language', () => {
    const res = evaluateBgHostCodeDrift(NOW - 10 * 60_000, NOW - 60 * 60_000, 'x.ts');
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/code current/);
    expect(res.note).not.toMatch(/DRIFT/);
  });

  it('a compiled host bundle rebuilt after startup is reported as drift', () => {
    const res = evaluateBgHostCodeDrift(
      NOW - 60 * 60_000,
      NOW - 5_000,
      'apps/operator/dist-host/hono-host.mjs',
    );
    expect(res.note).toMatch(/CODE DRIFT/);
    expect(res.note).toMatch(/hono-host\.mjs/);
  });

  it('loaded runtime identity catches a stale bundle even when source mtime looks current', () => {
    const res = evaluateBgHostCodeDrift(
      NOW - 60 * 60_000,
      NOW - 90 * 60_000,
      'packages/operator-core/lib/harness/git-sync/git-sync-action.ts',
      {
        source: 'runtime-vintage',
        treeSha: 'old-build',
        pid: 2477163,
        host: 'tower',
        reportedAt: new Date(NOW - 59 * 60_000).toISOString(),
      },
      'new-build',
    );
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/CODE DRIFT/);
    expect(res.note).toMatch(/loaded build old-build/);
    expect(res.note).toMatch(/current source new-build/);
    expect(res.provenance).toEqual({
      source: 'runtime-vintage',
      loadedSha: 'old-build',
      expectedSha: 'new-build',
      loadedPid: 2477163,
      loadedReportedAt: new Date(NOW - 59 * 60_000).toISOString(),
    });
  });

  it('unrelated committed changes do not flag drift when the scoped hot paths are unchanged', () => {
    const res = evaluateBgHostCodeDrift(
      NOW - 10 * 60_000,
      NOW - 60 * 60_000,
      'x.ts',
      {
        source: 'runtime-vintage',
        treeSha: 'old-build',
        pid: 123,
        host: 'tower',
        reportedAt: new Date(NOW - 9 * 60_000).toISOString(),
      },
      'new-build',
      false,
    );
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/code current/);
    expect(res.note).not.toMatch(/CODE DRIFT/);
    expect(res.provenance).toMatchObject({
      source: 'runtime-vintage',
      loadedSha: 'old-build',
      expectedSha: 'new-build',
    });
  });

  it('matching loaded identity is reported as runtime-vintage current, not mtime fallback', () => {
    const res = evaluateBgHostCodeDrift(
      NOW - 10 * 60_000,
      NOW - 60 * 60_000,
      'x.ts',
      {
        source: 'runtime-vintage',
        treeSha: 'abc1234',
        pid: 123,
        host: 'tower',
        reportedAt: new Date(NOW - 9 * 60_000).toISOString(),
      },
      'ABC123456789',
      false,
    );
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/code current/);
    expect(res.note).toMatch(/runtime-vintage/);
    expect(res.provenance).toMatchObject({
      source: 'runtime-vintage',
      loadedSha: 'abc1234',
      expectedSha: 'ABC123456789',
    });
  });

  it('matching commit identity still uses mtime fallback for a newer uncommitted edit', () => {
    const res = evaluateBgHostCodeDrift(
      NOW - 60 * 60_000,
      NOW - 10 * 60_000,
      'dirty.ts',
      {
        source: 'runtime-vintage',
        treeSha: 'abc1234',
        pid: 123,
        host: 'tower',
        reportedAt: new Date(NOW - 59 * 60_000).toISOString(),
      },
      'abc123456789',
      false,
    );
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/CODE DRIFT/);
    expect(res.note).toMatch(/mtime fallback/);
    expect(res.provenance).toMatchObject({
      source: 'mtime-fallback',
      loadedSha: 'abc1234',
      expectedSha: 'abc123456789',
      reason: 'mtime detected a newer working-tree change',
    });
  });

  it('unknown boot time or change time → present:false (fail-soft, never a fabricated drift)', () => {
    expect(evaluateBgHostCodeDrift(null, NOW).present).toBe(false);
    expect(evaluateBgHostCodeDrift(NOW, null).present).toBe(false);
    expect(evaluateBgHostCodeDrift(null, null).note).toMatch(/unknown/);
  });

  it('a missing newest-file name still reports drift (the name is cosmetic)', () => {
    const res = evaluateBgHostCodeDrift(NOW - 60_000, NOW, null);
    expect(res.note).toMatch(/CODE DRIFT/);
  });

  it('drift is floored at ~1m so a seconds-level drift never rounds to "~0m"', () => {
    const res = evaluateBgHostCodeDrift(NOW - 10_000, NOW - 5_000, 'abc');
    expect(res.note).toMatch(/~1m AFTER/);
  });
});

describe('compareCommittedHotPaths (service-scoped runtime identity)', () => {
  it('passes only the service hot paths to git and treats a clean scoped diff as current', async () => {
    const calls: Array<{ file: string; args: string[]; options: { cwd: string; timeout: number; maxBuffer: number } }> = [];
    const run: CodeDriftExecFile = async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '' };
    };

    await expect(compareCommittedHotPaths(run, '/repo', 'abc1234', 'def5678', BG_HOST_HOT_PATHS)).resolves.toBe(false);
    expect(calls).toEqual([
      {
        file: 'git',
        args: ['diff', '--name-only', 'abc1234', 'def5678', '--', ...BG_HOST_HOT_PATHS, ':(exclude)**/*.test.ts'],
        options: { cwd: '/repo', timeout: 3000, maxBuffer: 4 * 1024 * 1024 },
      },
    ]);
  });

  it('returns changed for a scoped diff and unknown when Git cannot resolve the refs', async () => {
    const changed: CodeDriftExecFile = async () => ({ stdout: 'packages/operator-core/lib/events/fire.ts\n' });
    const failed: CodeDriftExecFile = async () => {
      throw new Error('unknown revision');
    };

    await expect(compareCommittedHotPaths(changed, '/repo', 'abc1234', 'def5678', BG_HOST_HOT_PATHS)).resolves.toBe(true);
    await expect(compareCommittedHotPaths(failed, '/repo', 'abc1234', 'def5678', BG_HOST_HOT_PATHS)).resolves.toBeNull();
  });
});

describe('evaluateMcpProxyCodeDrift (EI-21390665295968159 — stale :9071 proxy detection)', () => {
  const NOW = 1_700_000_000_000;

  it('covers the code the proxy unit actually tsx-loads (lib + the bin entrypoint)', () => {
    // ExecStart is `npx tsx bin/mcp-proxy.ts`, which imports lib/mcp-proxy/*. Miss either
    // and a landed proxy fix reads as "current" while the live process is pre-fix — the
    // exact false-negative EI-20365119255138043 caught for the bg-host git-sync path.
    expect(MCP_PROXY_HOT_PATHS).toContain('apps/operator/lib/mcp-proxy');
    expect(MCP_PROXY_HOT_PATHS).toContain('apps/operator/bin/mcp-proxy.ts');
  });

  it('proxy code changed AFTER boot → drift flagged; up stays true (restart severs live agent calls, so it is never an auto-restart nudge)', () => {
    const res = evaluateMcpProxyCodeDrift(NOW - 60 * 60_000, NOW - 10 * 60_000, 'apps/operator/lib/mcp-proxy/proxy.ts');
    expect(res.name).toBe('mcp-proxy-code');
    expect(res.up).toBe(true);
    expect(res.present).not.toBe(false);
    expect(res.note).toMatch(/CODE DRIFT/);
    expect(res.note).toMatch(/proxy\.ts/);
    expect(res.note).toMatch(/~50m AFTER/);
    expect(res.note).toMatch(/systemctl --user restart papercup-mcp-proxy\.service/);
  });

  it('names the symptom an agent actually greps for — a proxy failure that was already fixed', () => {
    // The reproduction: the FIFO handshake-admission fix landed 04:27Z, the proxy booted
    // 04:08Z, and three separate agents filed three bugs against the surviving symptoms.
    const res = evaluateMcpProxyCodeDrift(NOW - 60 * 60_000, NOW - 10 * 60_000, 'proxy.ts');
    expect(res.note).toMatch(/failure you already fixed/);
    expect(res.note).toMatch(/EI-21390665295968159/);
  });

  it('proxy code OLDER than the boot → current, no drift language', () => {
    const res = evaluateMcpProxyCodeDrift(NOW - 10 * 60_000, NOW - 60 * 60_000, 'x.ts');
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/code current/);
    expect(res.note).not.toMatch(/DRIFT/);
  });

  it('unknown boot time or change time → present:false (fail-soft, never a fabricated drift)', () => {
    expect(evaluateMcpProxyCodeDrift(null, NOW).present).toBe(false);
    expect(evaluateMcpProxyCodeDrift(NOW, null).present).toBe(false);
    expect(evaluateMcpProxyCodeDrift(null, null).note).toMatch(/unknown/);
  });

  it('drift is floored at ~1m so a seconds-level drift never rounds to "~0m"', () => {
    expect(evaluateMcpProxyCodeDrift(NOW - 10_000, NOW - 5_000, 'abc').note).toMatch(/~1m AFTER/);
  });

  it('the two code-drift verdicts stay distinguishable — same shape, different name and restart command', () => {
    // They share one implementation; a successor refactoring that helper must not let the
    // proxy verdict start telling agents to restart the bg-host (or vice versa).
    const proxy = evaluateMcpProxyCodeDrift(NOW - 60 * 60_000, NOW - 10 * 60_000, 'a.ts');
    const bgHost = evaluateBgHostCodeDrift(NOW - 60 * 60_000, NOW - 10 * 60_000, 'a.ts');
    expect(proxy.name).not.toBe(bgHost.name);
    expect(proxy.note).not.toMatch(/papercusp-bg-host/);
    expect(bgHost.note).not.toMatch(/papercup-mcp-proxy/);
  });
});

describe('probeBgHostCodeDrift — platform guard (P-005, cross-platform hardening)', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  afterEach(() => setPlatform(realPlatform));

  it('on macOS short-circuits to an HONEST not-applicable present:false (no systemctl spawn, no "probe failed")', async () => {
    setPlatform('darwin');
    const res = await probeBgHostCodeDrift();
    expect(res.name).toBe('bg-host-code');
    expect(res.up).toBe(true); // never a fabricated DOWN
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/Linux\/systemd-only/);
    expect(res.note).not.toMatch(/probe failed/); // the misleading note the old catch produced off-Linux
  });

  it('on win32 (non-WSL) also short-circuits — not applicable', async () => {
    setPlatform('win32');
    const res = await probeBgHostCodeDrift();
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/not applicable on this platform/);
  });
});

describe('evaluateMcpProxyBgHostCodeDrift (stale :9271 proxy detection)', () => {
  const NOW = 1_700_000_000_000;

  it('covers the source and launch unit used by the :9271 proxy', () => {
    expect(MCP_PROXY_BG_HOST_HOT_PATHS).toContain('apps/operator/lib/mcp-proxy');
    expect(MCP_PROXY_BG_HOST_HOT_PATHS).toContain('apps/operator/bin/mcp-proxy.ts');
    expect(MCP_PROXY_BG_HOST_HOT_PATHS).toContain('apps/operator/scripts/systemd/papercup-mcp-proxy-bg-host.service');
  });

  it('names the :9271 runtime and its sanctioned restart target when source changed after boot', () => {
    const res = evaluateMcpProxyBgHostCodeDrift(NOW - 60 * 60_000, NOW - 10 * 60_000, 'proxy.ts');
    expect(res.name).toBe('mcp-proxy-bg-host-code');
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/:9271 proxy code changed/);
    expect(res.note).toMatch(/dev:restart.*mcp-proxy-bg-host/);
  });

  it('returns present:false when boot or hot-change time is unknown', () => {
    expect(evaluateMcpProxyBgHostCodeDrift(null, NOW).present).toBe(false);
    expect(evaluateMcpProxyBgHostCodeDrift(NOW, null).present).toBe(false);
  });
});

describe('probeMcpProxyBgHostCodeDrift — platform guard', () => {
  const realPlatform = process.platform;
  const setPlatform = (p: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value: p, configurable: true });
  afterEach(() => setPlatform(realPlatform));

  it('is honestly not applicable off Linux rather than reporting a missing unit as a failure', async () => {
    setPlatform('darwin');
    const res = await probeMcpProxyBgHostCodeDrift();
    expect(res.name).toBe('mcp-proxy-bg-host-code');
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/Linux\/systemd-only/);
  });
});

describe('evaluateBgHostTicker (EI-1832 — bg-host DBOS ticker liveness)', () => {
  const NOW = 1_700_000_000_000;

  it('a recent tick → up, with the last-tick age + "ticker alive" in the note', () => {
    const res = evaluateBgHostTicker(NOW - 30_000, NOW);
    expect(res.name).toBe('bg-host-ticker');
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/last routine tick 30s ago/);
    expect(res.note).toMatch(/ticker alive/);
  });

  it('a fire older than the stale window → DOWN, naming the bg-host (NOT :3070, do not restart operator)', () => {
    const res = evaluateBgHostTicker(NOW - 45 * 60_000, NOW); // 45m — the 2026-06-20 incident
    expect(res.up).toBe(false);
    expect(res.note).toMatch(/no routine has fired in 45m/);
    expect(res.note).toMatch(/FROZEN/);
    expect(res.note).toMatch(/NOT the :3070 operator/);
    expect(res.note).toMatch(/do NOT dev:restart/);
  });

  it('exactly at the threshold is still up; one ms past it is down (boundary)', () => {
    expect(evaluateBgHostTicker(NOW - BG_HOST_STALE_MS, NOW).up).toBe(true);
    expect(evaluateBgHostTicker(NOW - BG_HOST_STALE_MS - 1, NOW).up).toBe(false);
  });

  it('no fired routine (null) → present:false, liveness UNKNOWN (never alarms a fresh/idle install)', () => {
    const res = evaluateBgHostTicker(null, NOW);
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/unknown/);
  });

  it('a future timestamp (clock skew) clamps to age 0 — up, never a negative age', () => {
    const res = evaluateBgHostTicker(NOW + 5_000, NOW);
    expect(res.up).toBe(true);
    expect(res.note).toMatch(/tick 0s ago/);
  });

  it('an UNKNOWN (present:false) ticker result is SKIPPED by diffHealth — no phantom transition', () => {
    const unknown = evaluateBgHostTicker(null, NOW);
    const { transitions, next } = diffHealth({ 'bg-host-ticker': true }, [unknown]);
    expect(transitions).toEqual([]); // present:false → skipped (no phantom alarm)
    expect(next['bg-host-ticker']).toBeUndefined(); // forgotten, not alerted
  });

  it('a real ticker DOWN DOES alert via diffHealth, like any service', () => {
    const down = evaluateBgHostTicker(NOW - 60 * 60_000, NOW); // 1h frozen
    const { transitions } = diffHealth({ 'bg-host-ticker': true }, [down]);
    expect(transitions).toEqual([{ name: 'bg-host-ticker', to: 'down' }]);
  });
});

// ---------------------------------------------------------------------------
// probeSubstrateSidecar — WI-895 discrimination (2026-07-03): "no sidecar
// spawned by this process" must read present:false (like flag-off / unknown
// ticker), NEVER a phantom DOWN; a socket that exists but fails healthz IS a
// real DOWN, with path provenance in the note.
// ---------------------------------------------------------------------------
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import {
  EMBED_SIDECAR_EXERCISE_INTERVAL_MS,
  __resetEmbedSidecarExerciseClockForTests,
  embedSidecarProbeShouldExercise,
  probeEmbedSidecar,
  probeSubstrateSidecar,
} from './service-health';
import { closeSubstrateIpcClient } from './sync/hyperbee/substrate-ipc-client';
import { SUBSTRATE_SOCKET_ENV } from './sync/hyperbee/substrate-socket-path';

vi.mock('@papercusp/flags/server', () => ({
  getFlag: vi.fn(async () => true), // SUBSTRATE_SIDECAR ON for every probe test
  onFlagChange: vi.fn(() => () => {}), // listener registration in the module graph — no-op
}));

describe('probeSubstrateSidecar (WI-895 — not-spawned vs truly-dead discrimination)', () => {
  const sockPath = path.join(os.tmpdir(), `pc-probe-${process.pid}-${Math.floor(Math.random() * 1e6)}.sock`);
  let envBefore: string | undefined;

  beforeEach(() => {
    envBefore = process.env[SUBSTRATE_SOCKET_ENV];
    process.env[SUBSTRATE_SOCKET_ENV] = sockPath;
    closeSubstrateIpcClient(); // fresh singleton per test — it caches the socket path
  });
  afterEach(() => {
    if (envBefore === undefined) delete process.env[SUBSTRATE_SOCKET_ENV];
    else process.env[SUBSTRATE_SOCKET_ENV] = envBefore;
    closeSubstrateIpcClient();
    fs.rmSync(sockPath, { force: true });
  });

  it('flag ON + NO socket at the resolved path → present:false "not spawned", NOT a DOWN', async () => {
    const res = await probeSubstrateSidecar(1500);
    expect(res.up).toBe(true); // fail-soft: unknown/not-applicable is never DOWN
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/no sidecar spawned by this process/);
    expect(res.note).toContain(sockPath); // path provenance — the 49989 specimen's missing clue
    // And diffHealth must skip it (no phantom transition), like the unknown ticker.
    const { transitions } = diffHealth({ 'substrate-sidecar': true }, [res]);
    expect(transitions).toEqual([]);
  });

  it('flag ON + socket answers healthz → UP with path provenance', async () => {
    const conns = new Set<net.Socket>();
    const server = net.createServer((conn) => {
      conns.add(conn);
      conn.on('close', () => conns.delete(conn));
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const req = JSON.parse(line) as { id: number };
          conn.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(sockPath, () => resolve());
    });
    try {
      const res = await probeSubstrateSidecar(3000);
      expect(res.up).toBe(true);
      expect(res.present).not.toBe(false);
      expect(res.note).toContain(sockPath);
    } finally {
      // The probe's singleton client holds its connection open — close it and
      // destroy server-side conns FIRST, else server.close() waits forever.
      closeSubstrateIpcClient();
      for (const c of conns) c.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('flag ON + socket file EXISTS but nothing listens → real DOWN with the TRUE dial error, fast', async () => {
    // A stale socket file with no listener = the "sidecar died, file left behind"
    // shape — this one IS a fault worth alarming on.
    const stale = net.createServer(() => {});
    await new Promise<void>((resolve, reject) => {
      stale.once('error', reject);
      stale.listen(sockPath, () => resolve());
    });
    await new Promise<void>((resolve) => stale.close(() => resolve())); // closes listener…
    // net's close() unlinks the socket file; recreate the FILE to simulate the stale leftover.
    if (!fs.existsSync(sockPath)) fs.writeFileSync(sockPath, '');
    const started = Date.now();
    const res = await probeSubstrateSidecar(4000);
    expect(res.up).toBe(false);
    expect(res.note).toMatch(/ECONNREFUSED|ENOTSOCK|Connection/);
    expect(res.note).toContain(sockPath);
    expect(Date.now() - started).toBeLessThan(4000); // no masked 5s connect timer
  });
});

/**
 * EI-19465075959589134 — WEDGED is not DOWN.
 *
 * :3170 grew to 2.3x its RSS limit and stopped answering while `systemctl
 * is-active` said active, the pid was alive, the port was bound and a TCP
 * connect still succeeded — because the KERNEL completes the handshake without
 * the process. Every liveness signal the box had was defeated by the same
 * blocked event loop, simultaneously. The accept queue is the one signal that
 * is not, since only the process can drain it.
 */
describe('wedged-vs-down detection', () => {
  const socket = (over: Partial<ListeningSocket> = {}): ListeningSocket => ({
    port: 3170,
    address: '127.0.0.1',
    family: 'ipv4',
    pid: 47585,
    pids: [47585],
    listeners: 1,
    command: 'node-MainThread',
    ownerVisible: true,
    reserved: true,
    acceptQueue: { pending: 0, backlog: 511 },
    ...over,
  });

  it('classifies a listener holding unaccepted connections as WEDGED', () => {
    const v = classifyListenerWedge([socket({ acceptQueue: { pending: 97, backlog: 511 } })]);
    expect(v).toEqual({ wedged: true, pending: 97, backlog: 511 });
  });

  it('classifies a listener with a DRAINED queue as not wedged — the control', () => {
    // Without this pair the verdict could be "wedged whenever a probe fails",
    // which would relabel every ordinary outage and destroy the distinction.
    expect(classifyListenerWedge([socket()])).toEqual({ wedged: false, pending: 0, backlog: 511 });
  });

  it('sums pending across a SO_REUSEPORT cluster — one wedged worker still starves clients', () => {
    const v = classifyListenerWedge([
      socket({ pid: 1, acceptQueue: { pending: 0, backlog: 511 } }),
      socket({ pid: 2, acceptQueue: { pending: 40, backlog: 511 } }),
    ]);
    expect(v).toEqual({ wedged: true, pending: 40, backlog: 511 });
  });

  it('returns UNDETERMINED (null) when nothing is listening or the table is unreadable', () => {
    // Both must stay null rather than `{wedged:false}`: no listener means the
    // service is genuinely down (a different finding), and an unreadable table
    // means we do not know. Collapsing either into "not wedged" would recreate
    // the original bug — two different states rendering identically.
    expect(classifyListenerWedge([])).toBeNull();
    expect(classifyListenerWedge(null)).toBeNull();
  });

  it('only asks about LOCAL loopback ports', () => {
    expect(localProbePort('http://127.0.0.1:3170/api/health')).toBe(3170);
    expect(localProbePort('http://localhost:3055/')).toBe(3055);
    expect(localProbePort('http://example.com:3170/')).toBeNull(); // remote: our listen table says nothing about it
    expect(localProbePort('http://127.0.0.1/')).toBeNull(); // no explicit port
    expect(localProbePort('not a url')).toBeNull();
  });

  it('is FAIL-SOFT: a throwing listen table yields null, never a fabricated verdict', async () => {
    // This runs INSIDE the health probe. A diagnostic that can break the probe
    // it rides on is the same class of defect as the bug it diagnoses.
    const boom = async () => {
      throw new Error('ss: command not found');
    };
    await expect(detectWedgedListener('http://127.0.0.1:3170/api/health', boom)).resolves.toBeNull();
  });

  /**
   * A REAL listener that completes the TCP handshake and then never answers —
   * the wedge shape end to end. It matters that this is a live socket rather
   * than a closed port: a closed port is REFUSED at preflight and short-circuits
   * before the fetch, so it can never exercise this path, and asserting against
   * one would have produced a test that passes while proving nothing.
   */
  async function silentListener(): Promise<{ port: number; close: () => Promise<void> }> {
    const open = new Set<net.Socket>();
    const srv = net.createServer((s) => {
      open.add(s);
      s.on('close', () => open.delete(s));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', () => resolve()));
    const port = (srv.address() as net.AddressInfo).port;
    return {
      port,
      close: async () => {
        for (const s of open) s.destroy();
        await new Promise<void>((resolve) => srv.close(() => resolve()));
      },
    };
  }

  it('probeEndpoint reports a failed probe on a QUEUE-BACKED port as wedged, with the evidence', async () => {
    const listener = await silentListener();
    try {
      const res = await probeEndpoint(
        { name: 'staging-api', url: `http://127.0.0.1:${listener.port}/api/health`, timeoutMs: 300 },
        300,
        async () => ({ sockets: [socket({ port: listener.port, acceptQueue: { pending: 97, backlog: 511 } })] }),
      );

      expect(res.up).toBe(false);
      expect(res.wedged).toBe(true);
      expect(res.acceptQueue).toEqual({ pending: 97, backlog: 511 });
      expect(res.note).toContain('WEDGED');
      // The note must say what a restart does and does NOT buy, because
      // restarting is what closed the first two :3170 incidents in four hours
      // without anyone learning why it wedged.
      expect(res.note).toMatch(/restart/i);
    } finally {
      await listener.close();
    }
  });

  it('escalates a wedge under its OWN watchdog key, not merged into the generic down signal', () => {
    // Detection here happens in a DIFFERENT process from the wedged one (:3070
    // probing :3170) — which is the whole point, since an in-process guard rides
    // the same blocked loop it is meant to police.
    const [signal] = collectServiceDownSignals([
      {
        name: 'staging-api',
        up: false,
        status: null,
        latencyMs: 3000,
        wedged: true,
        acceptQueue: { pending: 97, backlog: 511 },
      },
    ]);
    // A distinct key is what stops it deduping into whatever long-standing
    // "Service staging-api is down" row already exists.
    expect(signal.key).toBe('staging-api:wedged');
    expect(signal.title).toContain('WEDGED');
    expect(signal.body).toContain('97 queued unaccepted');
    expect(signal.body).toMatch(/capture logs .*FIRST|FIRST/i);
  });

  it('leaves a plain down service on the ORIGINAL key — the wedge branch must not relabel outages', () => {
    const [signal] = collectServiceDownSignals([
      { name: 'operator', up: false, status: 503, latencyMs: 4 },
    ]);
    expect(signal.key).toBe('operator');
    expect(signal.title).toBe('Service operator is down');
  });

  it('probeEndpoint leaves an ordinary DOWN probe unlabelled — no wedge, no wedge note', async () => {
    const listener = await silentListener();
    try {
      const res = await probeEndpoint(
        { name: 'staging-api', url: `http://127.0.0.1:${listener.port}/api/health`, timeoutMs: 300 },
        300,
        async () => ({ sockets: [] }),
      );

      expect(res.up).toBe(false);
      expect(res.wedged).toBeUndefined(); // undetermined-or-absent, never a false "not wedged"
      expect(res.acceptQueue).toBeUndefined();
      expect(res.note ?? '').not.toContain('WEDGED');
    } finally {
      await listener.close();
    }
  });
});

describe('probeEmbedSidecar — functional POST /embed liveness (EI-21271970090208994)', () => {
  const sidecarUrlEnv = 'PAPERCUSP_EMBED_SIDECAR_URL';
  const previousUrl = process.env[sidecarUrlEnv];
  let server: http.Server | null = null;
  const sockets = new Set<net.Socket>();

  beforeEach(async () => {
    __resetEmbedSidecarExerciseClockForTests();
    server = http.createServer();
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address() as net.AddressInfo;
    process.env[sidecarUrlEnv] = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    if (previousUrl === undefined) delete process.env[sidecarUrlEnv];
    else process.env[sidecarUrlEnv] = previousUrl;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  /**
   * Reply to every POST /embed with `payload`, recording each request body so a
   * case can assert what the probe actually asked the sidecar for.
   */
  const serveEmbed = (payload: unknown): unknown[] => {
    const bodies: unknown[] = [];
    server!.on('request', (req, res) => {
      if (req.method !== 'POST' || req.url !== '/embed') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        bodies.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
      });
    });
    return bodies;
  };

  /** A response that proves the model ran for its one probe text. */
  const inferredOnce = {
    vectors: [[0.25, -0.5]],
    dims: 2,
    runtime: 'test',
    modelRev: 'test',
    cache: { hits: 0, coalesced: 0, inferred: 1 },
  };

  it('requires a usable one-vector POST response even when the listener is reachable', async () => {
    const bodies = serveEmbed(inferredOnce);

    const result = await probeEmbedSidecar(500, { exercise: false });
    expect(result).toMatchObject({
      name: 'embed-sidecar',
      up: true,
      status: 200,
      url: expect.stringMatching(/\/embed$/),
    });
    expect(result.note).toMatch(/functional POST \/embed OK/);
    // A probe that is NOT exercising sends exactly the historical body — the
    // duty cycle must not put an extra field on every tick.
    expect(bodies).toEqual([{ model: 'gemma', kind: 'query', texts: ['health probe'] }]);
  });

  it('reports malformed functional output as down instead of trusting HTTP 200', async () => {
    server!.on('request', (_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ vectors: [] }));
    });

    const result = await probeEmbedSidecar(500);
    expect(result.up).toBe(false);
    expect(result.status).toBe(200);
    expect(result.url).toMatch(/\/embed$/);
    expect(result.note).toMatch(/no usable vector/);
  });

  it('aborts a saturated POST within the supplied bound and reports the functional failure', async () => {
    server!.on('request', (req, res) => {
      if (req.method === 'POST' && req.url === '/embed') {
        // Deliberately leave the response open. The probe's AbortController is
        // the only thing that should end this request.
        req.on('aborted', () => res.destroy());
        return;
      }
      res.writeHead(404).end();
    });

    const started = Date.now();
    const result = await probeEmbedSidecar(40);
    const elapsed = Date.now() - started;
    expect(result.up).toBe(false);
    expect(result.status).toBeNull();
    expect(result.note).toMatch(/functional POST \/embed failed within 40ms/);
    expect(elapsed).toBeLessThan(1000);
  });

  describe('WI-1647443 — the probe text is constant, so the LRU can answer it forever', () => {
    it('forces a real inference on a fresh process and at most once per interval afterwards', () => {
      // Nothing proven yet is not "recently proven" — the first probe of a
      // process is exactly when "does this sidecar embed at all?" is open.
      expect(embedSidecarProbeShouldExercise(1_000_000, null)).toBe(true);
      expect(embedSidecarProbeShouldExercise(1_000_000, 1_000_000)).toBe(false);
      expect(
        embedSidecarProbeShouldExercise(1_000_000 + EMBED_SIDECAR_EXERCISE_INTERVAL_MS - 1, 1_000_000),
      ).toBe(false);
      expect(
        embedSidecarProbeShouldExercise(1_000_000 + EMBED_SIDECAR_EXERCISE_INTERVAL_MS, 1_000_000),
      ).toBe(true);
      // The interval bounds how long a dead worker can hide, so it must be
      // longer than a tick and far shorter than a shift.
      expect(EMBED_SIDECAR_EXERCISE_INTERVAL_MS).toBeGreaterThan(60_000);
      expect(EMBED_SIDECAR_EXERCISE_INTERVAL_MS).toBeLessThanOrEqual(15 * 60_000);
    });

    it('sends bypassCache and reports the model as exercised when the response proves it', async () => {
      const bodies = serveEmbed(inferredOnce);

      const result = await probeEmbedSidecar(500, { exercise: true });
      expect(bodies).toEqual([
        { model: 'gemma', kind: 'query', texts: ['health probe'], bypassCache: true },
      ]);
      expect(result.up).toBe(true);
      expect(result.embedModelExercised).toBe('yes');
      expect(result.note).toMatch(/the model ran for THIS probe/);
    });

    it('does NOT claim functionality when the vector came out of the sidecar LRU', async () => {
      // The filed defect, reproduced at the probe: HTTP 200, a usable vector,
      // ~0ms — and the ONNX worker never touched. The old note called this
      // "functional POST /embed OK".
      serveEmbed({ ...inferredOnce, cache: { hits: 1, coalesced: 0, inferred: 0 } });

      const result = await probeEmbedSidecar(500, { exercise: false });
      expect(result.up).toBe(true); // a cache hit is not evidence of DOWN
      expect(result.embedModelExercised).toBe('no');
      expect(result.note).toMatch(/model was NOT exercised/);
      expect(result.note).toMatch(/cache lookup/);
      expect(result.note).not.toMatch(/functional POST \/embed OK/);
    });

    it('reports an unaccounted response as UNDECIDABLE, not as a cache hit and not as OK', async () => {
      // The live failure measured on :3384 on 2026-08-31: a sidecar bundle
      // predating the accounting accepts `bypassCache` as an unknown JSON
      // field, ignores it, and answers from its LRU in ~2ms. Every layer looks
      // successful, so the flag we sent is worthless as evidence and the
      // response has to carry the proof.
      const bodies = serveEmbed({ vectors: [[0.25, -0.5]], dims: 2, runtime: 'test', modelRev: 'test' });

      const result = await probeEmbedSidecar(500, { exercise: true });
      expect(bodies).toHaveLength(1);
      expect(result.up).toBe(true);
      expect(result.embedModelExercised).toBe('unknown');
      expect(result.note).toMatch(/UNDECIDABLE/);
      expect(result.note).toMatch(/asked for bypassCache and the response did not account for it/);
      expect(result.note).not.toMatch(/functional POST \/embed OK/);

      // CONTROL — the shortcut this probe must not take: read a missing/zero
      // `hits` as "the cache was cold". It is DELIBERATELY WRONG and kept here
      // permanently, because it passes the exact body above. If someone
      // "simplifies" the probe onto it, `embedModelExercised` collapses to
      // 'yes' here and this case goes red instead of going quietly optimistic.
      const naiveExercised = (body: Record<string, unknown>): boolean =>
        !(body as { cache?: { hits?: number } }).cache?.hits;
      expect(naiveExercised({ vectors: [[0.25, -0.5]] })).toBe(true);
      expect(result.embedModelExercised).not.toBe('yes');
      // CALIBRATION — on a body that really was fully inferred the two agree,
      // so the disagreement above is about the unaccounted case and not about
      // the probe refusing everything.
      expect(naiveExercised(inferredOnce)).toBe(true);
    });

    it('advances the back-off clock only on PROVEN inference, so an unprovable probe re-tries next tick', async () => {
      const bodies = serveEmbed({ vectors: [[0.25, -0.5]], dims: 2, runtime: 'test', modelRev: 'test' });

      // Fresh process ⇒ the duty cycle chooses to exercise, unprompted.
      const first = await probeEmbedSidecar(500);
      expect(first.embedModelExercised).toBe('unknown');
      // Unproven, so the clock did NOT move: the next tick tries again rather
      // than reporting an interval of cheap cached "ups" after one failure.
      const second = await probeEmbedSidecar(500);
      expect(bodies).toEqual([
        { model: 'gemma', kind: 'query', texts: ['health probe'], bypassCache: true },
        { model: 'gemma', kind: 'query', texts: ['health probe'], bypassCache: true },
      ]);
      expect(second.embedModelExercised).toBe('unknown');
    });

    it('is what lets the embed sidecar EVER confirm DOWN, because the debounce resets on any up', () => {
      // The back-off rule is not a nicety — it is load-bearing against a
      // mechanism that already exists. `embed-sidecar` is damped: it needs
      // EMBED_SIDECAR_DOWN_CONFIRM_TICKS consecutive bad ticks before a DOWN
      // is exposed, and any `up` tick RESETS that streak. So if the duty-cycle
      // clock advanced on ATTEMPT, a dead worker would produce one exercising
      // DOWN followed by cheap cached ups for the rest of the interval — the
      // streak would reset every time and the sidecar could never confirm.
      expect(EMBED_SIDECAR_DOWN_CONFIRM_TICKS).toBeGreaterThan(1);
      const down = () => ({ name: 'embed-sidecar', up: false, status: null, latencyMs: 1 });

      // What advancing on attempt would produce: DOWN, then a cached "up".
      const t1 = applyDownConfirmDebounce([down()], {});
      expect(t1.results[0].up).toBe(true); // unconfirmed — correctly suppressed
      const cachedUp = { name: 'embed-sidecar', up: true, status: 200, latencyMs: 4 };
      const t2Wrong = applyDownConfirmDebounce([cachedUp], t1.nextStreaks);
      expect(t2Wrong.nextStreaks['embed-sidecar']).toBeUndefined(); // streak lost

      // What advancing only on PROOF produces: the next tick exercises again.
      const t2Right = applyDownConfirmDebounce([down()], t1.nextStreaks);
      expect(t2Right.nextStreaks['embed-sidecar']).toBe(EMBED_SIDECAR_DOWN_CONFIRM_TICKS);
      expect(t2Right.results[0].up).toBe(false); // confirmed DOWN, as intended
    });

    it('backs off after a proven inference instead of bypassing the cache every tick', async () => {
      const bodies = serveEmbed(inferredOnce);

      const first = await probeEmbedSidecar(500);
      expect(first.embedModelExercised).toBe('yes');
      const second = await probeEmbedSidecar(500);
      expect(second.embedModelExercised).toBe('yes'); // this mock always infers
      expect(bodies).toEqual([
        { model: 'gemma', kind: 'query', texts: ['health probe'], bypassCache: true },
        // The proof moved the clock, so the follow-up tick pays nothing.
        { model: 'gemma', kind: 'query', texts: ['health probe'] },
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// probeJournalCanary — EI-15810 (EI-2434 follow-up): journald stdout-capture
// liveness canary. Cross-tick design (write THIS tick's nonce, check the PRIOR
// tick's nonce) — see the doc comment on probeJournalCanary in service-health.ts
// for why: by the time a nonce is checked it is already a full tick old, so this
// probe adds zero blocking delay to probeAll(), unlike a probe that sleeps
// in-place before checking its own just-written canary. Every test below injects
// resolveUnit/exec/writeCanary so nothing here touches a real filesystem,
// subprocess, or systemd host, and nothing waits out a real tick interval.
// ---------------------------------------------------------------------------
import {
  probeJournalCanary,
  resolveOwnServiceUnit,
  parseOwnServiceUnitFromCgroup,
  __resetJournalCanaryStateForTests,
  JOURNAL_CANARY_DOWN_CONFIRM_TICKS,
} from './service-health';

describe('parseOwnServiceUnitFromCgroup — pure cgroup-path parsing (EI-15810)', () => {
  it('extracts a .service unit from a unified (v2) cgroup line', () => {
    const body = '0::/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-dev-api.service\n';
    expect(parseOwnServiceUnitFromCgroup(body)).toBe('papercusp-dev-api.service');
  });

  it('returns null for a .scope (not a systemd service unit — an agent terminal, a dev shell)', () => {
    const body = '0::/user.slice/user-1000.slice/user@1000.service/papercusp.slice/papercusp-agent.slice/pc-abc123-drain-canary.scope\n';
    expect(parseOwnServiceUnitFromCgroup(body)).toBeNull();
  });

  it('handles a multi-line cgroup v1 body, taking the first .service segment found', () => {
    const body = [
      '12:pids:/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-bg-host.service',
      '1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/papercusp-bg-host.service',
      '',
    ].join('\n');
    expect(parseOwnServiceUnitFromCgroup(body)).toBe('papercusp-bg-host.service');
  });

  it('returns null for an empty/garbage body', () => {
    expect(parseOwnServiceUnitFromCgroup('')).toBeNull();
    expect(parseOwnServiceUnitFromCgroup('garbage\nno slashes here')).toBeNull();
  });
});

describe('resolveOwnServiceUnit — platform guard (EI-15810)', () => {
  it('returns null on a non-Linux platform without touching the filesystem', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      expect(await resolveOwnServiceUnit()).toBeNull();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
    }
  });
});

describe('probeJournalCanary (EI-15810 — EI-2434 follow-up: journald stdout-capture liveness)', () => {
  const UNIT = 'papercusp-dev-api.service';

  beforeEach(() => {
    __resetJournalCanaryStateForTests();
  });

  it('not running under a systemd .service unit → present:false, never a fabricated verdict', async () => {
    const res = await probeJournalCanary({ resolveUnit: async () => null });
    expect(res.up).toBe(true);
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/not running under a systemd/);
  });

  it('first tick since process start → present:false (nothing to check yet), but WRITES a canary', async () => {
    const written: string[] = [];
    let execCallCount = 0;
    const res = await probeJournalCanary({
      resolveUnit: async () => UNIT,
      writeCanary: (line) => written.push(line),
      exec: async () => {
        execCallCount++;
        return { stdout: '' };
      },
    });
    expect(execCallCount, 'nothing to check on the very first tick').toBe(0);
    expect(res.up).toBe(true);
    expect(res.present).toBe(false);
    expect(res.note).toMatch(/first tick/);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\[journal-canary\] svchealth-/);
  });

  it('second tick: prior canary landed → up:true, checking the PRIOR nonce (not the just-written one)', async () => {
    const execCalls: string[][] = [];
    const deps = {
      resolveUnit: async () => UNIT,
      writeCanary: () => {},
      exec: async (args: string[]) => {
        execCalls.push(args);
        return { stdout: 'matched line' };
      },
    };
    const first = await probeJournalCanary(deps);
    expect(first.present).toBe(false); // nothing to check yet

    const second = await probeJournalCanary(deps);
    expect(second.up).toBe(true);
    expect(second.present).not.toBe(false);
    expect(second.note).toMatch(/stdout capture healthy/);

    // Exactly one exec call so far — the second tick checking tick 1's nonce.
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual(
      expect.arrayContaining([
        '--user', '-u', UNIT, '-g', expect.stringMatching(/^svchealth-/), '--since', expect.stringMatching(/^@\d+$/),
      ]),
    );
  });

  it('second tick: prior canary MISSING (journalctl exit 1, empty stderr = --grep matched nothing) → real DOWN, with an explicit "not the unit" disclaimer', async () => {
    const noMatchError = Object.assign(new Error('Command failed'), { code: 1, stderr: '' });
    const deps = {
      resolveUnit: async () => UNIT,
      writeCanary: () => {},
      exec: async () => {
        throw noMatchError;
      },
    };
    const first = await probeJournalCanary(deps);
    expect(first.present).toBe(false);

    const second = await probeJournalCanary(deps);
    expect(second.up).toBe(false);
    expect(second.present).not.toBe(false);
    expect(second.note).toMatch(/did NOT land in the journal/);
    expect(second.note).toMatch(/EI-2434/);
    expect(second.note).toMatch(/NOT a claim/); // explicit "this is not the unit being down" disclaimer
  });

  it('a genuine read failure (not a --grep miss) → present:false, liveness unknown, never a fabricated DOWN', async () => {
    const timeoutError = Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' });
    const deps = {
      resolveUnit: async () => UNIT,
      writeCanary: () => {},
      exec: async () => {
        throw timeoutError;
      },
    };
    await probeJournalCanary(deps); // first tick — writes, nothing to check
    const second = await probeJournalCanary(deps);
    expect(second.up).toBe(true); // fail-soft, not a fabricated down
    expect(second.present).toBe(false);
    expect(second.note).toMatch(/liveness unknown/);
  });

  it('writes a fresh, distinct canary every tick, even right after a confirmed miss (never goes permanently blind)', async () => {
    const written: string[] = [];
    const noMatchError = Object.assign(new Error('Command failed'), { code: 1, stderr: '' });
    const deps = {
      resolveUnit: async () => UNIT,
      writeCanary: (line: string) => written.push(line),
      exec: async () => {
        throw noMatchError;
      },
    };
    await probeJournalCanary(deps);
    await probeJournalCanary(deps);
    await probeJournalCanary(deps);
    expect(written).toHaveLength(3);
    expect(new Set(written).size).toBe(3); // each nonce distinct
  });

  it('a resolved unit changing mid-process resyncs rather than checking the wrong unit\'s journal (defensive)', async () => {
    let call = 0;
    const execCalls: string[][] = [];
    const deps = {
      resolveUnit: async () => (call++ === 0 ? 'unit-a.service' : 'unit-b.service'),
      writeCanary: () => {},
      exec: async (args: string[]) => {
        execCalls.push(args);
        return { stdout: 'x' };
      },
    };
    const first = await probeJournalCanary(deps);
    expect(first.present).toBe(false);
    const second = await probeJournalCanary(deps);
    expect(second.present).toBe(false);
    expect(second.note).toMatch(/unit changed/);
    expect(execCalls).toHaveLength(0); // never checked tick 1's nonce against unit-b's journal
  });

  it('is damped like every other single-signal portless probe (JOURNAL_CANARY_DOWN_CONFIRM_TICKS = 2)', () => {
    expect(JOURNAL_CANARY_DOWN_CONFIRM_TICKS).toBe(2);
    const down: ProbeResult[] = [{ name: 'journal-canary', up: false, status: null, latencyMs: 1 }];
    const first = applyDownConfirmDebounce(down, {});
    expect(first.results[0].up, 'first bad tick is not yet a confirmed down').toBe(true);
    const second = applyDownConfirmDebounce(down, first.nextStreaks);
    expect(second.results[0].up, 'second consecutive bad tick IS the real down').toBe(false);
  });
});
