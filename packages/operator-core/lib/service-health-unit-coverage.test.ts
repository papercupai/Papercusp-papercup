/**
 * WI-6149 / P-013 (D-010 item 4) — the supervision registry's UNIT-COVERAGE
 * invariants, and the `episodic` behaviour that makes them enforceable.
 *
 * Item 4 asked which non-papercusp units agents probe should become probes. The
 * answer was ONE addition (`oddsmith-sidecar`) and four documented exclusions,
 * and the measurement that produced it exposed a live defect: the registry had
 * no concept of a TIMER-DRIVEN unit, so a healthy hourly oneshot
 * (`papercup-live-federation-gate`) was reported through `dev:service_health` as
 * `active: false` — which that tool's own description sold as "the unit is
 * confirmed DOWN". Verified live 2026-07-26 before the fix.
 *
 * These tests exist because the fix is only half of the work: the reason the
 * defect survived is that NOTHING asserted the registry's shape. Comments in
 * `service-health.ts` state the invariants; this file is what makes them fail.
 *
 * Deliberately separate from `service-health.test.ts`, which covers the PROBE
 * mechanics (timeouts, debounce, diffing). This file covers the REGISTRY: who is
 * in it, who is deliberately not, and what "down" means per entry.
 */
import { describe, it, expect } from 'vitest';
import {
  HEALTH_ENDPOINTS,
  SUPERVISED_PROCESSES,
  NON_PROBED_UNITS,
  DOWN_CONFIRM_TICKS,
  ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS,
  PORTLESS_PROBE_NAME_SET,
  applyDownConfirmDebounce,
  type ProbeResult,
} from './service-health';
import { isUnitDown, isActiveStateDown, type SystemctlUnitStatus } from './supervision/unit-reconciler';
import { overlaySystemdRestartRecency } from './agent-tools/dev/service_health';
import type { ServiceStartInfo } from './agent-tools/dev/systemd-service-probe';

const unitStatus = (active: string): SystemctlUnitStatus => ({
  unit: 'x.service',
  load: 'loaded',
  active,
  sub: 'x',
  description: 'x',
});

describe('SupervisionEntry.episodic — what "down" means for a timer-driven unit (WI-6149)', () => {
  it('an episodic unit is NOT down while inactive — only when it FAILED', () => {
    // The whole defect in one assertion. A `Type=oneshot` on an hourly timer is
    // `inactive` for ~96% of every hour; calling that down is what produced the
    // false "confirmed DOWN" reading, and (once the reconciler is armed) would
    // produce ~48 coord broadcasts/day for one healthy unit.
    expect(isUnitDown(unitStatus('inactive'), { episodic: true })).toBe(false);
    expect(isUnitDown(unitStatus('failed'), { episodic: true })).toBe(true);
    // A run in flight is not a fault either.
    expect(isUnitDown(unitStatus('activating'), { episodic: true })).toBe(false);
    expect(isUnitDown(unitStatus('active'), { episodic: true })).toBe(false);
  });

  it('a PERSISTENT unit keeps the original semantics — inactive IS down', () => {
    // The episodic option must not quietly relax the default. If this ever
    // inverts, every real outage stops alarming.
    expect(isUnitDown(unitStatus('inactive'))).toBe(true);
    expect(isUnitDown(unitStatus('failed'))).toBe(true);
    expect(isUnitDown(unitStatus('active'))).toBe(false);
    expect(isUnitDown(unitStatus('activating'))).toBe(false);
  });

  it('isActiveStateDown is the SAME oracle, reachable from a bare ActiveState string', () => {
    // dev:service_health holds an ActiveState string, not a parsed list-units row.
    // Before WI-6149 it applied its own `=== "active"` rule and therefore
    // DISAGREED with the reconciler about `activating`. One oracle, two doors.
    for (const state of ['active', 'activating', 'reloading', 'deactivating', 'inactive', 'failed']) {
      expect(isActiveStateDown(state), `state=${state}`).toBe(isUnitDown(unitStatus(state)));
      expect(isActiveStateDown(state, { episodic: true }), `episodic state=${state}`).toBe(
        isUnitDown(unitStatus(state), { episodic: true }),
      );
    }
  });

  it('an unreadable ActiveState is UNKNOWN, never a determinate down', () => {
    expect(isActiveStateDown(undefined)).toBeUndefined();
  });

  it('INVARIANT: every episodic registry entry has autoRestart:false', () => {
    // Auto-restarting a oneshot does not heal it — it RE-RUNS the job once per
    // reconciler tick until the give-up threshold escalates. For a backup unit
    // that means re-running pg_dump every 60s.
    const violations = SUPERVISED_PROCESSES.filter((e) => e.episodic && e.autoRestart).map((e) => e.name);
    expect(
      violations,
      `An episodic (timer-driven oneshot) entry must never be auto-restarted — a restart re-RUNS the job rather ` +
        `than healing anything:\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('EI-24811958626062774 INVARIANT: notifyAfterDownMs is only set on report-only entries', () => {
    // A restart-capable entry pages on its own ladder (failed restart, give-up); delaying that
    // page would hide a dead service behind a quiet window.
    const violations = SUPERVISED_PROCESSES.filter((e) => e.notifyAfterDownMs !== undefined && e.autoRestart).map((e) => e.name);
    expect(violations, `notifyAfterDownMs on an autoRestart entry:\n  - ${violations.join('\n  - ')}`).toEqual([]);
  });

  it('EI-24811958626062774: papercup-staging-sync is supervised as an episodic, delayed-alarm, report-only unit', () => {
    // It ran FATAL for 5+ hours on 2026-10-01 with no alarm while :3170 served a stale build.
    const row = SUPERVISED_PROCESSES.find((e) => e.unit === 'papercup-staging-sync');
    expect(row, 'papercup-staging-sync must be in SUPERVISED_PROCESSES').toBeDefined();
    expect(row?.episodic, 'Type=oneshot on a ~5min timer: idle inactive is healthy').toBe(true);
    expect(row?.autoRestart, 're-running a failed sync repeats the same FATAL').toBe(false);
    expect(row?.notifyAfterDownMs, 'short single-run streaks must not page').toBeGreaterThanOrEqual(15 * 60_000);
  });

  it('live-federation-gate is marked episodic, and its .timer is NOT', () => {
    // The specific unit the defect was found on, asserted by name so the
    // regression cannot return silently. The distinction is real: the SERVICE is
    // a oneshot; an armed TIMER is genuinely active/waiting continuously, so
    // persistent semantics are correct for it.
    const svc = SUPERVISED_PROCESSES.find((e) => e.name === 'live-federation-gate');
    const timer = SUPERVISED_PROCESSES.find((e) => e.name === 'live-federation-gate-timer');
    expect(svc?.episodic, 'papercup-live-federation-gate is a Type=oneshot unit on an hourly timer').toBe(true);
    expect(timer?.episodic, 'an ARMED timer is continuously active — marking it episodic would mask a stopped timer').toBeFalsy();
  });

  it('EI-21232345359778222: live-federation-gate declares exitEncodesRunOnly, and that implies episodic', () => {
    // The gate exits 0 on `GATE: FRESH-RED (… still red, already tracked; NOT a green)` exactly
    // as it does on a real green (live-federation-gate.sh:563), so a down→up transition on this
    // unit is "the last run exited 0" and NEVER "recovered". Asserted by name because dropping
    // the flag re-arms a FALSE ALL-CLEAR — the failure direction nothing else would catch: the
    // reconciler would go back to broadcasting `✅ … recovered` and stay green in every test.
    const svc = SUPERVISED_PROCESSES.find((e) => e.name === 'live-federation-gate');
    expect(
      svc?.exitEncodesRunOnly,
      'papercup-live-federation-gate exits 0 whether its subject is green or still red — supervision may not claim recovery from it',
    ).toBe(true);

    // INVARIANT: exitEncodesRunOnly ⇒ episodic. For a persistent service the exit status IS the
    // condition (the process is up or it is not), so the flag could only mislead there.
    const violations = SUPERVISED_PROCESSES.filter((e) => e.exitEncodesRunOnly && !e.episodic).map((e) => e.name);
    expect(
      violations,
      `exitEncodesRunOnly only makes sense for a timer-driven oneshot; for a persistent unit the exit ` +
        `status IS the condition:\n  - ${violations.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('the host release-gate PRODUCER timer is supervised, non-episodic, and auto-restarting (WI-38449 / D-007 F1)', () => {
    // The gap this closes: `papercup-perf-signals-capture.timer` latched `failed`
    // for ~7h on 2026-08-15/16 and NOTHING detected it, so the host SLO/CLOSE_WAIT
    // guard read a stale capture the whole time. perf-budgets.ts's `blindMs` branch
    // notices the stale ARTEFACT; only this registry entry watches the UNIT.
    const timer = SUPERVISED_PROCESSES.find((e) => e.name === 'perf-signals-capture-timer');
    expect(timer, 'the perf-signals capture timer must be supervised — it produces the host gate input').toBeDefined();
    expect(timer?.unit, 'a .timer needs its explicit suffix; the reconciler only strips .service').toBe(
      'papercup-perf-signals-capture.timer',
    );
    expect(
      timer?.episodic,
      'an armed timer is continuously active — marking it episodic would mask the exact failed/stopped timer this entry exists to catch',
    ).toBeFalsy();
    expect(
      timer?.autoRestart,
      'restarting a TIMER only re-arms the schedule (it never touches an in-flight capture), so this heals itself',
    ).toBe(true);
  });

  it('the perf-signals ONESHOT service is deliberately NOT supervised — liveness is the wrong question', () => {
    // Calibration for the test above: it would also pass if someone "helpfully"
    // registered both units. `papercup-perf-signals-capture.service` is Type=oneshot,
    // so `inactive` is its healthy state between 2-min ticks — the same shape
    // NON_PROBED_UNITS excludes as `episodic-oneshot` for papercusp-db-backup. Its
    // last-run result is already served by perf-budgets.ts's blindMs branch.
    const svc = SUPERVISED_PROCESSES.find(
      (e) => e.unit === 'papercup-perf-signals-capture' || e.unit === 'papercup-perf-signals-capture.service',
    );
    expect(
      svc,
      'the oneshot capture service must NOT be registered — registering it adds a second, worse answer to a question blindMs already answers',
    ).toBeUndefined();
  });
});

describe('dev:service_health supervision overlay reports the honest state (WI-6149)', () => {
  const entry = (name: string) => ({
    name,
    layer: 'systemd-user' as const,
    autoRestart: false,
    criticality: 'important' as const,
    consecutiveProbeFailures: 0,
    lastRestartAt: null,
    restartsLast10m: 0,
    flapState: 'ok' as const,
    // EI-20093902925801178: these rows model entries the reconciler HAS
    // observed, so the zeros above are measurements. The un-observed case (same
    // zeros, no data behind them) is guarded in service_health.test.ts.
    flapObserved: true,
  });
  const probeReturning = (activeState: string, secondsSinceStart?: number) => async (): Promise<ServiceStartInfo> => ({
    ok: true,
    activeState,
    ...(secondsSinceStart === undefined ? {} : { mainPid: 123, secondsSinceStart }),
  });

  it('an idle EPISODIC unit reads healthy — the exact live misreport this fixes', () => {
    // Pre-fix, this returned { active: false } and nothing else, which the tool
    // description defined as "confirmed DOWN".
    return overlaySystemdRestartRecency(
      [entry('gate')],
      probeReturning('inactive'),
      [{ name: 'gate', unit: 'papercup-live-federation-gate', episodic: true }],
    ).then(([row]) => {
      expect(row.activeState).toBe('inactive');
      expect(row.active).toBe(false); // the RAW systemd read is still reported honestly
      expect(row.healthy, 'an idle timer-driven unit is not down').toBe(true);
      expect(row.episodic).toBe(true);
    });
  });

  it('a FAILED episodic unit reads unhealthy — damping must not hide a real failure', () => {
    return overlaySystemdRestartRecency(
      [entry('gate')],
      probeReturning('failed'),
      [{ name: 'gate', unit: 'papercup-live-federation-gate', episodic: true }],
    ).then(([row]) => {
      expect(row.activeState).toBe('failed');
      expect(row.healthy).toBe(false);
    });
  });

  it('a PERSISTENT unit that is inactive reads unhealthy', () => {
    return overlaySystemdRestartRecency(
      [entry('sidecar')],
      probeReturning('inactive'),
      [{ name: 'sidecar', unit: 'papercup-oddsmith-sidecar' }],
    ).then(([row]) => {
      expect(row.healthy).toBe(false);
      expect(row.episodic).toBeUndefined();
    });
  });

  it('a unit MID-RESTART reads unhealthy=false→healthy, not down (the activating disagreement)', () => {
    // `activating` is explicitly not-down per isUnitDown, but the overlay used to
    // report active:false for it with no way to tell it from a crash — so a
    // caller could not distinguish "retry in a second" from "page someone".
    return overlaySystemdRestartRecency(
      [entry('operator')],
      probeReturning('activating'),
      [{ name: 'operator', unit: 'papercusp-dev-api' }],
    ).then(([row]) => {
      expect(row.activeState).toBe('activating');
      expect(row.active).toBe(false);
      expect(row.healthy, 'a transitional state is not a fault').toBe(true);
    });
  });

  it('a probe that could not determine anything leaves the row untouched (no invented verdict)', () => {
    return overlaySystemdRestartRecency(
      [entry('operator')],
      async () => ({ ok: false }) as ServiceStartInfo,
      [{ name: 'operator', unit: 'papercusp-dev-api' }],
    ).then(([row]) => {
      expect(row.activeState).toBeUndefined();
      expect(row.active).toBeUndefined();
      expect(row.healthy).toBeUndefined();
    });
  });
});

describe('unit-coverage decisions (WI-6149 D-010 item 4)', () => {
  it('oddsmith-sidecar has BOTH a probe and a supervision row, joined by name', () => {
    // service-health.ts's naming convention: the probe name matches its
    // SUPERVISED_PROCESSES entry so the two rows join. A mismatch silently
    // produces an unjoined pair of half-answers.
    const probe = HEALTH_ENDPOINTS.find((s) => s.name === 'oddsmith-sidecar');
    const row = SUPERVISED_PROCESSES.find((e) => e.name === 'oddsmith-sidecar');
    expect(probe?.url, 'ODDSMITH_HONO_PORT=46229 is pinned in the unit file').toBe('http://127.0.0.1:46229/health');
    expect(row?.unit).toBe('papercup-oddsmith-sidecar');
    // Already Restart=always at the systemd level, so a registry restart lever
    // would be a SECOND restarter racing systemd's own (the bg-host precedent).
    expect(row?.autoRestart).toBe(false);
  });

  it('every DOWN_CONFIRM_TICKS key names a probe the tool can actually emit', () => {
    // Damping is keyed by ProbeResult.name. A typo'd key is not an error — it is
    // silently NO damping, i.e. exactly the phantom-DOWN flood the entry was
    // added to prevent, with a green test suite.
    //
    // EI-15810: this used to hand-type the portless set here, which had already
    // silently drifted (missing 'mcp-proxy-code') before this change — the exact
    // rot service-health.test.ts's own PORTLESS_PROBE_NAME_SET-derived guard exists
    // to prevent (see its comment re: EI-19375157952766991). Deriving from the same
    // exported set both fixes that drift and stops this file re-introducing it.
    const emittable = new Set([...HEALTH_ENDPOINTS.map((s) => s.name), ...PORTLESS_PROBE_NAME_SET]);
    const orphans = Object.keys(DOWN_CONFIRM_TICKS).filter((name) => !emittable.has(name));
    expect(
      orphans,
      `These names are damped but no probe emits them, so the damping is a silent no-op:\n  - ${orphans.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('two ticks of damping actually suppress a single-tick blip and then expose a real down', () => {
    // The behavioural claim behind ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS: a restart
    // window (≤2s measured) cannot span two ticks 60s apart, but a genuinely dead
    // sidecar stays down and must still alarm one tick later.
    const down: ProbeResult[] = [{ name: 'oddsmith-sidecar', up: false, status: null, latencyMs: 1 }];
    const first = applyDownConfirmDebounce(down, {});
    expect(first.results[0].up, 'first bad tick is not yet a confirmed down').toBe(true);
    const second = applyDownConfirmDebounce(down, first.nextStreaks);
    expect(second.results[0].up, 'second consecutive bad tick IS the real down').toBe(false);
    expect(ODDSMITH_SIDECAR_DOWN_CONFIRM_TICKS).toBe(2);
  });

  it('every documented exclusion is honoured — not probed, not registered', () => {
    const probed = new Set(HEALTH_ENDPOINTS.map((s) => s.name));
    const units = new Set(SUPERVISED_PROCESSES.map((e) => e.unit).filter((u): u is string => Boolean(u)));
    const contradictions = Object.keys(NON_PROBED_UNITS).filter(
      (u) => probed.has(u) || units.has(u) || units.has(`${u}.service`),
    );
    expect(
      contradictions,
      `NON_PROBED_UNITS documents why these are excluded, but they are probed/registered anyway:\n  - ${contradictions.join('\n  - ')}`,
    ).toEqual([]);
  });

  it('each exclusion records a structural reason, not a preference', () => {
    // The four reasons are the load-bearing part of item 4's answer: they are why
    // a future agent must not "just add a probe". A new exclusion code means a new
    // structural category, which deserves the same measurement — so the set is
    // pinned rather than open.
    const codes = [...new Set(Object.values(NON_PROBED_UNITS).map((v) => v.reason))].sort();
    expect(codes).toEqual(['episodic-oneshot', 'system-scope-unit', 'transient-unit-name', 'unit-not-installed']);
  });
});

/**
 * EI-20067982007251440 — the RECOVERY PATH for a critical unit must itself be
 * supervised.
 *
 * `papercusp-bg-host-watchdog` is the only out-of-process recovery bg-host has:
 * the in-process supervision reconciler runs INSIDE bg-host and freezes with it,
 * so when the DBOS ticker wedges, the watchdog is the sole actor that can act.
 * Measured 2026-08-10: it restarted a frozen bg-host at 11:00:30Z, while that
 * same freeze had halted git-sync, every scheduled routine, and the release gate
 * fleet-wide. It was absent from the registry, so nothing would have reported it
 * if the watchman itself had stopped.
 */
describe('EI-20067982007251440 — bg-host-watchdog supervision', () => {
  const entry = () => SUPERVISED_PROCESSES.find((e) => e.name === 'bg-host-watchdog');

  it("registers bg-host's out-of-process recovery, so its silence is visible", () => {
    expect(
      entry(),
      'bg-host-watchdog is missing from SUPERVISED_PROCESSES. It is the ONLY actor that can ' +
        'recover a frozen bg-host (the in-process reconciler freezes with it), so removing it ' +
        'from the registry means a dead watchman is reported by nothing, and the next ticker ' +
        'freeze halts git-sync + all routines + the release gate fleet-wide with no recovery.',
    ).toBeDefined();
    expect(entry()?.unit).toBe('papercusp-bg-host-watchdog');
    expect(entry()?.layer).toBe('systemd-user');
  });

  it('is NOT episodic — it is a persistent poller, so `inactive` really is down', () => {
    // Guards the D-010 item-4 hazard in the other direction: mislabelling this
    // episodic would make a genuinely-stopped watchdog read as "normally idle".
    expect(entry()?.episodic ?? false).toBe(false);
  });

  it('keeps autoRestart:true — `Restart=always` does NOT cover an administratively STOPPED unit', () => {
    // THE REGRESSION THIS EXISTS TO CATCH: a future edit "harmonizing" this entry
    // with the `bg-host` row directly above it, whose comment says a registry
    // lever is redundant because systemd is already `Restart=always`. That
    // rationale does not transfer. `Restart=always` fires on EXIT; a unit that was
    // stopped (or whose start was never re-attempted) stays down indefinitely and
    // is indistinguishable from healthy at the process level. WI-5376 is the
    // precedent, not a hypothetical: the federation gate's timer was externally
    // stopped TWICE with no systemd-logged stop client, silently meaning "the gate
    // never runs again" until a human noticed. Restarting THIS unit is safe and
    // idempotent (stateless poller, own 8/hr circuit breaker + 5min debounce), and
    // WI-5378's isAdministrativelyPaused still honours a deliberate disable/mask.
    expect(
      entry()?.autoRestart,
      'bg-host-watchdog must keep autoRestart:true. If you flipped this to match the bg-host ' +
        'entry above ("already Restart=always at the systemd level"), that reasoning does not ' +
        'transfer: Restart=always fires on process EXIT and does nothing for a STOPPED unit — ' +
        'the exact way WI-5376 lost the federation gate timer twice, silently. A deliberate ' +
        'pause is still respected via `systemctl --user disable --now papercusp-bg-host-watchdog`.',
    ).toBe(true);
  });
});
