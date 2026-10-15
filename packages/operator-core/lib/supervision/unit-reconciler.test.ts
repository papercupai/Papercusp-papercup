/**
 * unit-reconciler — failed-unit reconciler pure functions + orchestrator
 * (critical-process-supervisor-2026-07-04 P-002).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SupervisionGiveUpEpisode } from './give-up-ei';
import {
  parseSystemctlListUnits,
  parseSystemctlShowProperties,
  parseSystemctlShowRecords,
  signalTermination,
  isUnitDown,
  isEpisodicRunInFlight,
  isSystemdTransitioning,
  isAdministrativelyPaused,
  decideReconcile,
  initialFlapState,
  reconcileTick,
  supervisionListUnitPatterns,
  _resetReconcilerState,
  checkRestartPolicyDrift,
  checkSilentCrashLoop,
  censusUnregisteredFailedUnits,
  _resetFailedUnitCensusForTests,
  BACKOFF_SEQUENCE_SEC,
  confirmFlapRestart,
  GIVE_UP_THRESHOLD,
  GIVE_UP_WINDOW_MS,
  HEALTHY_RESET_MS,
  SILENT_LOOP_THRESHOLD,
  SILENT_LOOP_WINDOW_MS,
  summarizeSystemctlStatusCause,
  isBuildStepFailure,
  BUILD_STEP_RETRY_LIMIT,
  STAGING_API_RECOVERY_PROBE_TIMEOUT_MS,
  supervisionSnapshot,
  extractBuildErrorDetail,
  extractRuntimeFailureDetail,
  stdoutFromExecError,
  scopeToFailedProcess,
  type SystemctlUnitStatus,
  type ReconcilerDeps,
  type ReconcileAction,
} from './unit-reconciler';
import type { SupervisionEntry } from '../service-health';

const AUTORESTART_ENTRY: SupervisionEntry = {
  name: 'mcp-proxy',
  layer: 'systemd-user',
  unit: 'papercup-mcp-proxy',
  criticality: 'important',
  autoRestart: true,
};

const REPORT_ONLY_ENTRY: SupervisionEntry = {
  name: 'live-federation-gate',
  layer: 'systemd-user',
  unit: 'papercup-live-federation-gate',
  criticality: 'important',
  autoRestart: false,
};

const STAGING_API_ENTRY: SupervisionEntry = {
  name: 'staging-api',
  layer: 'systemd-user',
  unit: 'papercusp-staging-api',
  criticality: 'important',
  autoRestart: true,
};

// WI-5378: the actual entry whose auto-heal (WI-5376) fought a deliberate pause.
const TIMER_ENTRY: SupervisionEntry = {
  name: 'live-federation-gate-timer',
  layer: 'systemd-user',
  unit: 'papercup-live-federation-gate.timer',
  criticality: 'important',
  autoRestart: true,
};

const LIST_UNITS_FIXTURE = [
  'papercup-bg-host.service                         loaded active   running Papercusp dedicated background host',
  'papercup-live-federation-gate.service            loaded inactive dead    Live 2-peer federation gate',
  'papercup-mcp-proxy.service                       loaded failed   failed  Papercusp resilient MCP proxy',
  '',
].join('\n');

describe('parseSystemctlListUnits', () => {
  it('parses unit/load/active/sub/description columns', () => {
    const rows = parseSystemctlListUnits(LIST_UNITS_FIXTURE);
    expect(rows).toEqual([
      { unit: 'papercup-bg-host.service', load: 'loaded', active: 'active', sub: 'running', description: 'Papercusp dedicated background host' },
      { unit: 'papercup-live-federation-gate.service', load: 'loaded', active: 'inactive', sub: 'dead', description: 'Live 2-peer federation gate' },
      { unit: 'papercup-mcp-proxy.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'Papercusp resilient MCP proxy' },
    ]);
  });

  it('tolerates a leading "●" bullet marker and blank lines', () => {
    const rows = parseSystemctlListUnits('\n● foo.service loaded failed failed some desc\n\n');
    expect(rows).toEqual([{ unit: 'foo.service', load: 'loaded', active: 'failed', sub: 'failed', description: 'some desc' }]);
  });

  it('returns [] for empty output', () => {
    expect(parseSystemctlListUnits('')).toEqual([]);
    expect(parseSystemctlListUnits('   \n  \n')).toEqual([]);
  });
});

describe('parseSystemctlShowProperties', () => {
  it('parses Key=Value lines', () => {
    expect(parseSystemctlShowProperties('Restart=always\nResult=success\nNRestarts=0\n')).toEqual({
      Restart: 'always',
      Result: 'success',
      NRestarts: '0',
    });
  });

  it('handles a value containing "="', () => {
    expect(parseSystemctlShowProperties('ExecStart={ path=/bin/x ; argv[]=x }')).toEqual({
      ExecStart: '{ path=/bin/x ; argv[]=x }',
    });
  });
});

describe('parseSystemctlShowRecords', () => {
  it('keys blank-line-separated multi-unit output by Id', () => {
    const records = parseSystemctlShowRecords(
      [
        'Id=alpha.service\nResult=success\nNRestarts=2',
        'Id=beta.timer\nResult=start-limit-hit\nNRestarts=5',
        '',
      ].join('\n\n'),
    );
    expect([...records.entries()]).toEqual([
      ['alpha.service', { Id: 'alpha.service', Result: 'success', NRestarts: '2' }],
      ['beta.timer', { Id: 'beta.timer', Result: 'start-limit-hit', NRestarts: '5' }],
    ]);
  });

  it('ignores an unkeyed partial record instead of assigning it by position', () => {
    expect(parseSystemctlShowRecords('Result=success\nNRestarts=2\n')).toEqual(new Map());
  });
});

// EI-19457080109574347: the 2026-08-10 papercup-staging-api outage, verbatim in shape — an
// agent's mid-edit duplicate `const` in the shared tree failed the ExecStartPre bundle. The
// error is printed FIRST and buried under the warnings that follow it, which is precisely why a
// tail-window read of the journal reported a step name and no cause.
const EXEC_START_PRE_BUILD_ERROR_JOURNAL = [
  'Aug 10 12:19:03 host bundle-host.sh[1655791]: ✘ [ERROR] The symbol "startingAdvSessionId" has already been declared',
  'Aug 10 12:19:03 host bundle-host.sh[1655791]:     ../../packages/operator-core/lib/endpoint-route/routes/adv/launch-su.ts:533:10:',
  'Aug 10 12:19:03 host bundle-host.sh[1655791]:       533 │     const startingAdvSessionId = ownerId',
  'Aug 10 12:19:03 host bundle-host.sh[1655791]: ▲ [WARNING] Ignoring this import because "../../libs/testing-shell/src/llm/asserts/tool.ts" was marked as having no side effects',
  'Aug 10 12:19:57 host bundle-host.sh[1655791]: 7 warnings and 1 error',
  'Aug 10 12:19:58 host systemd[3674]: papercup-staging-api.service: Control process exited, code=exited, status=1/FAILURE',
];

// EI-19457080109574347 recurrence on 2026-08-22: ExecStartPre SUCCEEDED; the main process
// rejected an unsafe off-loopback listener contract and exited 7. The actionable error existed
// only in journald while the alert said "Last exit unavailable".
const REMOTE_AUTH_RUNTIME_FAILURE_JOURNAL = [
  'Aug 22 03:53:24 host hono-host[2450000]: [boot-integrity] tree-drift warning (not fatal)',
  'Aug 22 03:53:26 host hono-host[2450000]: Error: Refusing off-loopback bind 0.0.0.0: set PAPERCUSP_ALLOW_REMOTE_ADMIN=1 only together with PAPERCUSP_REMOTE_ORIGINS.',
  'Aug 22 03:53:26 host systemd[3674]: papercup-staging-api.service: Main process exited, code=exited, status=7/NOTRUNNING',
];

describe('summarizeSystemctlStatusCause', () => {
  it('extracts the most-recent concrete failure line from a restarted unit status', () => {
    expect(
      summarizeSystemctlStatusCause([
        'Active: active (running)',
        'Jul 13 10:52:48 host node[1]: Error: listen EADDRINUSE: address already in use 127.0.0.1:3070',
        'Jul 13 10:52:48 host systemd[1]: papercup-dev-api.service: Main process exited, code=exited, status=1/FAILURE',
        'Jul 13 10:53:19 host systemd[1]: Started papercup-dev-api.service',
      ].join('\n')),
    ).toContain('Main process exited, code=exited, status=1/FAILURE');
  });

  it('returns null when status has no failure evidence', () => {
    expect(summarizeSystemctlStatusCause('Active: active (running)\nStarted cleanly')).toBeNull();
  });

  // WI-9249 — the 2026-08-03 papercup-staging-api outage, verbatim in shape. The unit died in
  // ExecStartPre (a bundle failure), so it never started and the journal tail is all generic
  // systemd trailers. Picking one of those is TRUE and useless; only the `Process:` line names
  // the step that actually failed.
  const EXEC_START_PRE_FAILURE = [
    '× papercup-staging-api.service - Papercusp operator STAGING host (:3170)',
    'Active: failed (Result: exit-code) since Mon 2026-08-03 14:07:26 EDT; 13min ago',
    'Process: 904863 ExecStartPre=/home/x/papercusp/apps/operator/bin/bundle-host.sh (code=exited, status=1/FAILURE)',
    'Aug 03 14:13:03 host systemd[1]: papercup-staging-api.service: Start request repeated too quickly.',
    "Aug 03 14:13:03 host systemd[1]: papercup-staging-api.service: Failed with result 'exit-code'.",
    'Aug 03 14:13:03 host systemd[1]: Failed to start papercup-staging-api.service - Papercusp operator STAGING host (:3170).',
  ].join('\n');

  it('prefers a FAILED control-process line over the generic journal trailer', () => {
    const cause = summarizeSystemctlStatusCause(EXEC_START_PRE_FAILURE);
    // The whole point: it must name the failing STEP.
    expect(cause).toContain('ExecStartPre');
    expect(cause).toContain('bundle-host.sh');
    // ...and must NOT settle for the trailer, which is what the old ordering returned.
    expect(cause).not.toContain('Failed with result');
  });

  it('CONTROL: a SUCCESSFUL control process is not mistaken for the cause', () => {
    // A healthy ExecStartPre is also reported on a `Process:` line. Preferring `Process:`
    // blindly would report a step that SUCCEEDED as the failure.
    const output = [
      'Active: failed (Result: exit-code)',
      'Process: 111 ExecStartPre=/home/x/prep.sh (code=exited, status=0/SUCCESS)',
      'Aug 03 14:13:03 host systemd[1]: svc.service: Main process exited, code=exited, status=3/NOTIMPLEMENTED',
    ].join('\n');
    const cause = summarizeSystemctlStatusCause(output);
    expect(cause).not.toContain('prep.sh');
    expect(cause).toContain('status=3/NOTIMPLEMENTED');
  });

  it('CONTROL: with no control-process line the previous trailer behaviour is preserved', () => {
    const cause = summarizeSystemctlStatusCause(
      [
        'Active: active (running)',
        'Jul 13 10:52:48 host systemd[1]: svc.service: Main process exited, code=exited, status=1/FAILURE',
      ].join('\n'),
    );
    expect(cause).toContain('Main process exited, code=exited, status=1/FAILURE');
  });

  // EI-19457080109574347 — naming the failing STEP is not naming the FAULT.
  it('appends the build error the failed step printed, not just the step name', () => {
    const cause = summarizeSystemctlStatusCause(
      [
        'Process: 1694694 ExecStartPre=/home/x/apps/operator/bin/bundle-host.sh (code=exited, status=1/FAILURE)',
        ...EXEC_START_PRE_BUILD_ERROR_JOURNAL,
      ].join('\n'),
    );
    // still names the step (WI-9249 must not regress)...
    expect(cause).toContain('bundle-host.sh');
    // ...and now carries the fault itself, which is what responders had to journalctl for.
    expect(cause).toContain('startingAdvSessionId');
    expect(cause).toContain('launch-su.ts:533:10');
  });

  it('appends a main-process startup policy error and ignores unrelated "not fatal" chatter', () => {
    const cause = summarizeSystemctlStatusCause(REMOTE_AUTH_RUNTIME_FAILURE_JOURNAL.join('\n'));
    expect(cause).toContain('Main process exited, code=exited, status=7/NOTRUNNING');
    expect(cause).toContain('Error: Refusing off-loopback bind 0.0.0.0');
    expect(cause).not.toContain('tree-drift warning');
  });
});

describe('extractBuildErrorDetail (EI-19457080109574347)', () => {
  it('recovers the esbuild error AND its source location from the journal excerpt', () => {
    const detail = extractBuildErrorDetail(EXEC_START_PRE_BUILD_ERROR_JOURNAL.join('\n'));
    expect(detail).toContain('The symbol "startingAdvSessionId" has already been declared');
    expect(detail).toContain('launch-su.ts:533:10');
  });

  it('strips the journald line prefix so the detail is the tool\'s own text', () => {
    const detail = extractBuildErrorDetail(EXEC_START_PRE_BUILD_ERROR_JOURNAL.join('\n'));
    expect(detail).not.toContain('bundle-host.sh[1655791]');
    expect(detail).not.toMatch(/^Aug 10/);
  });

  // The whole reason the callers read --lines=200: the error leads and the warnings trail it, so
  // a short tail window keeps the useless half. Guard the ORDERING, not the window size.
  it('finds an error that leads a long run of trailing warnings', () => {
    const warningFlood = Array.from(
      { length: 60 },
      (_, i) => `Aug 10 12:19:57 host bundle-host.sh[1]: ▲ [WARNING] ignored import #${i}`,
    );
    const detail = extractBuildErrorDetail(
      [...EXEC_START_PRE_BUILD_ERROR_JOURNAL.slice(0, 3), ...warningFlood].join('\n'),
    );
    expect(detail).toContain('startingAdvSessionId');
  });

  it('reads a tsc diagnostic too, not only esbuild', () => {
    const detail = extractBuildErrorDetail(
      'Aug 10 12:19:03 host tsc[1]: src/thing.ts(12,3): error TS2339: Property "x" does not exist.',
    );
    expect(detail).toContain('error TS2339');
  });

  it('returns null when the excerpt holds no build error', () => {
    expect(
      extractBuildErrorDetail(
        [
          'Aug 10 12:19:03 host systemd[1]: svc.service: Start request repeated too quickly.',
          "Aug 10 12:19:03 host systemd[1]: svc.service: Failed with result 'exit-code'.",
        ].join('\n'),
      ),
    ).toBeNull();
  });
});

describe('extractRuntimeFailureDetail (EI-19457080109574347 recurrence)', () => {
  it('recovers the exact runtime policy error and rejects "not fatal" noise', () => {
    expect(extractRuntimeFailureDetail(REMOTE_AUTH_RUNTIME_FAILURE_JOURNAL.join('\n')))
      .toContain('Error: Refusing off-loopback bind 0.0.0.0');
    expect(extractRuntimeFailureDetail('host: warning (not fatal)')).toBeNull();
  });
});

// EI-19966318801100410: `systemctl --user status` on a failed/inactive unit ALWAYS exits
// non-zero, so `execSystemctlUser` (the production execUser) always REJECTS for exactly the
// down-unit case this reconciler needs diagnostics for — but Node's `util.promisify(execFile)`
// attaches the captured stdout to that rejection error regardless, per the same contract as the
// callback form.
describe('stdoutFromExecError (EI-19966318801100410)', () => {
  it('recovers stdout from a promisified execFile-style rejection', () => {
    const err = Object.assign(new Error('Command failed: systemctl --user status x exit code 3'), {
      stdout: 'Active: failed (Result: exit-code)\nProcess: 1 ExecStartPre=/x.sh (code=exited, status=1/FAILURE)\n',
      stderr: '',
    });
    expect(stdoutFromExecError(err)).toContain('ExecStartPre');
  });

  it('returns null for a genuine spawn failure with no captured stdout', () => {
    expect(stdoutFromExecError(new Error('spawn systemctl ENOENT'))).toBeNull();
  });

  it('returns null for blank/whitespace-only stdout (nothing usable was captured)', () => {
    const err = Object.assign(new Error('x'), { stdout: '   \n\t' });
    expect(stdoutFromExecError(err)).toBeNull();
  });

  it('returns null for a non-object rejection (a thrown string, undefined, etc.)', () => {
    expect(stdoutFromExecError('plain string rejection')).toBeNull();
    expect(stdoutFromExecError(undefined)).toBeNull();
    expect(stdoutFromExecError(null)).toBeNull();
  });
});

describe('isUnitDown', () => {
  const s = (active: string): SystemctlUnitStatus => ({ unit: 'x.service', load: 'loaded', active, sub: 'n/a', description: '' });
  it('active/activating/reloading/deactivating are NOT down', () => {
    for (const a of ['active', 'activating', 'reloading', 'deactivating']) expect(isUnitDown(s(a))).toBe(false);
  });
  it('failed/inactive ARE down', () => {
    expect(isUnitDown(s('failed'))).toBe(true);
    expect(isUnitDown(s('inactive'))).toBe(true);
  });
  it('an undefined status (unit not reported at all) is down', () => {
    expect(isUnitDown(undefined)).toBe(true);
  });
});

describe('isAdministrativelyPaused (WI-5378)', () => {
  it('disabled and masked are paused', () => {
    expect(isAdministrativelyPaused('disabled')).toBe(true);
    expect(isAdministrativelyPaused('masked')).toBe(true);
  });
  it('enabled/static/linked/generated/unknown/undefined are NOT paused', () => {
    for (const s of ['enabled', 'static', 'linked', 'generated', 'transient', 'bad', undefined]) {
      expect(isAdministrativelyPaused(s)).toBe(false);
    }
  });
});

describe('decideReconcile', () => {
  const down = (unit: string): SystemctlUnitStatus => ({ unit, load: 'loaded', active: 'failed', sub: 'failed', description: '' });
  const up = (unit: string): SystemctlUnitStatus => ({ unit, load: 'loaded', active: 'active', sub: 'running', description: '' });

  it('healthy unit -> action "healthy", no state change of note', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: up('papercup-mcp-proxy.service'),
      show: undefined,
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    // `firstObservation` is set because this state is fresh (EI-20083989508593730); the steady
    // state below (`healthy tick after a recovery`) keeps the bare shape.
    expect(action).toEqual({ kind: 'healthy', unit: 'mcp-proxy', firstObservation: true });
  });

  // EI-20083989508593730 — the orphaned-give-up-EI class, at the decision layer.
  it('flags ONLY the first observation, so a restart-orphaned give-up EI can be reconciled', () => {
    const first = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: up('papercup-mcp-proxy.service'),
      show: undefined,
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(first.action).toMatchObject({ kind: 'healthy', firstObservation: true });

    // Second tick of the SAME process: not a first observation, so no re-reconcile every 60s.
    const second = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: up('papercup-mcp-proxy.service'),
      show: undefined,
      state: first.nextState,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(second.action).toEqual({ kind: 'healthy', unit: 'mcp-proxy' });
  });

  it('down + autoRestart flag OFF -> report-only, notify on the FIRST tick of the down streak', () => {
    const state = initialFlapState('papercup-mcp-proxy.service');
    const r1 = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: false, now: 1000 });
    expect(r1.action).toEqual({ kind: 'report-only', unit: 'mcp-proxy', reason: 'down-report-only', notify: true });
    const r2 = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: undefined, state: r1.nextState, autoRestartFlagOn: false, now: 2000 });
    expect(r2.action).toEqual({ kind: 'report-only', unit: 'mcp-proxy', reason: 'down-report-only', notify: false });
  });

  it('down + entry.autoRestart:false (e.g. the federation gate) -> report-only regardless of the flag', () => {
    const { action } = decideReconcile({
      entry: REPORT_ONLY_ENTRY,
      status: down('papercup-live-federation-gate.service'),
      show: undefined,
      state: initialFlapState('papercup-live-federation-gate.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'report-only', unit: 'live-federation-gate', reason: 'down-report-only', notify: true });
  });

  it('unit not found by systemctl at all -> report-only "unit-not-found" (absence UNCONFIRMED without a show-probe)', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      show: undefined,
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    // WI-35537: no show-probe ⇒ we cannot claim the unit is really gone.
    // EI-21531785497245954: nor can we claim it is PRESENT — with no probe both confirmations are
    // false, which is the only case where "state could not be read" is an honest thing to say.
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'mcp-proxy',
      reason: 'unit-not-found',
      confirmedAbsent: false,
      confirmedLoaded: false,
      notify: true,
    });
  });

  it('WI-35537: LoadState=not-found CONFIRMS absence -> unit-not-found with confirmedAbsent:true', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      show: { loadState: 'not-found' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'mcp-proxy',
      reason: 'unit-not-found',
      confirmedAbsent: true,
      confirmedLoaded: false,
      notify: true,
    });
  });

  it('EI-21531785497245954: LoadState=loaded CONFIRMS PRESENCE -> confirmedLoaded:true (idle and not resident, NOT unreadable)', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      show: { loadState: 'loaded', unitFileState: 'enabled-runtime', result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    // Measured on papercup-live-federation-gate: `systemctl --user list-units 'papercup*' --all`
    // omits it entirely, while `show` on the same unit returns LoadState=loaded,
    // UnitFileState=enabled-runtime, Result=success. systemd simply does not keep an idle
    // timer-triggered unit resident. The old single boolean could only report "not confirmed
    // absent", so the notifier fell through to "is not loaded ... and its state could not be
    // read" — false on BOTH clauses, about a unit it had just successfully read. That false
    // alarm fired repeatedly for weeks and cost each reader a verification round.
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'mcp-proxy',
      reason: 'unit-not-found',
      confirmedAbsent: false,
      confirmedLoaded: true,
      notify: true,
    });
  });

  // ── EI-22375866670391854: a false "loaded but not resident / currently inactive" alarm for
  //    four ACTIVE core services. Filed five times (also EI-22385488367114177,
  //    EI-22384738074232316, EI-22381604521211834, EI-22392509856811605), each guessing a
  //    different mechanism — missing `--all`, a bus/session difference, a restart race. All
  //    wrong. The cause was a hardcoded `list-units 'papercup*'` glob that stopped matching four
  //    entries renamed to `papercusp-` on 2026-08-27. Two guards: the pattern must be DERIVED,
  //    and the residency inference must never outrank a measured ActiveState. ──

  it('EI-22375866670391854: list-units patterns are DERIVED from the registry, so a papercusp- rename cannot fall out of the list', () => {
    const patterns = supervisionListUnitPatterns([
      { unit: 'papercusp-bg-host' },
      { unit: 'papercusp-bg-host-watchdog' },
      { unit: 'papercusp-dev-api' },
      { unit: 'papercusp-staging-api' },
      { unit: 'papercup-mcp-proxy' },
      { unit: 'papercup-live-federation-gate.timer' },
      { unit: undefined },
    ]);

    // The four units the false alarm named. `papercup*` cannot match `papercusp-…` — they
    // diverge at the 8th character — which is exactly why these four, and only these four,
    // vanished from every tick's list while systemd had them active (running).
    expect(patterns).toContain('papercusp-bg-host.service');
    expect(patterns).toContain('papercusp-bg-host-watchdog.service');
    expect(patterns).toContain('papercusp-dev-api.service');
    expect(patterns).toContain('papercusp-staging-api.service');
    // Positive control: the entries that always worked still resolve, and a unit that already
    // names its type keeps it rather than becoming `….timer.service`.
    expect(patterns).toContain('papercup-mcp-proxy.service');
    expect(patterns).toContain('papercup-live-federation-gate.timer');
    // An entry with no unit contributes nothing, and nothing here is a bare prefix glob: a
    // pattern-less `list-units --all` would enumerate every user unit on the box.
    expect(patterns).toHaveLength(6);
    expect(patterns.some((p) => p.includes('*'))).toBe(false);
  });

  it('EI-22375866670391854: CONTROL — the pre-fix literal glob misses exactly the four renamed units, the derived patterns do not', () => {
    // A deliberately-wrong implementation kept permanently as the control (the module-subject
    // tier from CLAUDE.md § "Proving a guard is falsifiable" — a copy-out mutation cannot reach
    // a module the test imports by specifier). This is the code that shipped, verbatim in shape.
    const PRE_FIX_PATTERNS = ['papercup*'];
    const globMatches = (pattern: string, unit: string) =>
      new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(unit);
    const matchedBy = (patterns: string[], unit: string) => patterns.some((p) => globMatches(p, unit));

    const RENAMED = ['papercusp-bg-host.service', 'papercusp-bg-host-watchdog.service', 'papercusp-dev-api.service', 'papercusp-staging-api.service'];
    const ALWAYS_WORKED = ['papercup-mcp-proxy.service', 'papercup-inference-gateway.service'];

    // CALIBRATION — the instrument works: the old glob really did match the units that never
    // misbehaved. Without this, "the old glob matches nothing" would look like the same result.
    for (const unit of ALWAYS_WORKED) expect(matchedBy(PRE_FIX_PATTERNS, unit)).toBe(true);

    // THE DEFECT: the old glob matches none of the four the alarm named. Verified against real
    // systemd on 2026-09-05 — `list-units 'papercup*' --all` returned 47 papercup-NAMED units
    // and 0 papercusp-NAMED ones, while all four were `loaded active running`.
    for (const unit of RENAMED) expect(matchedBy(PRE_FIX_PATTERNS, unit)).toBe(false);

    // ...and the derived patterns cover every one of them, renamed or not.
    const derived = supervisionListUnitPatterns([...RENAMED, ...ALWAYS_WORKED].map((u) => ({ unit: u })));
    for (const unit of [...RENAMED, ...ALWAYS_WORKED]) expect(matchedBy(derived, unit)).toBe(true);
  });

  it('EI-22375866670391854: a unit ABSENT from list-units but ActiveState=active is NOT reported down', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined, // the list came back without it — an inference, not a measurement
      show: { loadState: 'loaded', unitFileState: 'enabled', activeState: 'active', result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    // Before this guard the same input produced `report-only / unit-not-found /
    // confirmedLoaded:true`, which the notifier renders as "loaded but not resident … currently
    // inactive — this persistent service is expected to stay resident; investigate".
    expect(action.kind).not.toBe('report-only');
    expect(action).toEqual({ kind: 'healthy', unit: 'mcp-proxy', firstObservation: true });
  });

  it('EI-22375866670391854: an UNREADABLE ActiveState still reports down — the guard did not just silence the alarm', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      // show-probe answered, but ActiveState was not among the properties it could read.
      show: { loadState: 'loaded', unitFileState: 'enabled', result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    // An honest unknown stays down: that is the conservative direction for a supervisor, and it
    // is what makes the passing test above evidence of a MEASUREMENT rather than of a mute.
    expect(action).toMatchObject({ kind: 'report-only', reason: 'unit-not-found', confirmedLoaded: true });
  });

  it('EI-22375866670391854: ActiveState=inactive on an absent unit still alarms (a real down is still reported)', () => {
    const { action } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: undefined,
      show: { loadState: 'loaded', unitFileState: 'enabled', activeState: 'inactive', result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toMatchObject({ kind: 'report-only', reason: 'unit-not-found', confirmedLoaded: true });
  });

  it('EI-22375866670391854: end-to-end — an active papercusp- unit missing from the list broadcasts NOTHING', async () => {
    _resetReconcilerState();
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const listArgs: string[][] = [];
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) => {
        if (args[0] === 'list-units') {
          listArgs.push(args);
          return ''; // the drifted-glob case: the unit is active but absent from the list
        }
        return 'LoadState=loaded\nUnitFileState=enabled\nResult=success\nActiveState=active\nRestart=always\n';
      },
      now: () => 1_000_000,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [
        { name: 'operator', layer: 'systemd-user', unit: 'papercusp-dev-api', criticality: 'critical', autoRestart: true },
      ],
      log: () => {},
    };

    await reconcileTick(deps);

    // The tick asks for the unit by its real name rather than a prefix that no longer matches.
    expect(listArgs[0]).toContain('papercusp-dev-api.service');
    // And nothing is broadcast about a service systemd reports active — the whole defect was
    // four such "core service is down" escalations reaching every agent in the coord stream.
    const summaries = notify.mock.calls.map((c) => c[0]!.summary);
    expect(summaries.filter((s) => s.includes('not resident'))).toEqual([]);
    expect(summaries.filter((s) => s.includes('is down'))).toEqual([]);
  });

  it('EI-22361981911655947: loaded persistent services are not mislabeled as idle oneshots', async () => {
    _resetReconcilerState();
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? ''
          : 'LoadState=loaded\nUnitFileState=enabled\nResult=success\n',
      now: () => 1_000_000,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [REPORT_ONLY_ENTRY],
      log: () => {},
    };

    await reconcileTick(deps);

    const summaries = notify.mock.calls.map((c) => c[0].summary);
    const persistentWarning = summaries.find((summary) => summary.includes('loaded but not resident'));
    expect(persistentWarning).toContain('persistent service is expected to stay resident');
    expect(persistentWarning).not.toContain('normal for an idle timer-triggered/oneshot unit');
  });

  it('EI-22361981911655947: episodic loaded units retain the normal idle oneshot message', async () => {
    _resetReconcilerState();
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const episodicEntry: SupervisionEntry = {
      ...REPORT_ONLY_ENTRY,
      name: 'live-federation-gate-timer',
      unit: 'papercup-live-federation-gate.timer',
      episodic: true,
    };
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? ''
          : 'LoadState=loaded\nUnitFileState=enabled\nResult=success\n',
      now: () => 1_000_000,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [episodicEntry],
      log: () => {},
    };

    await reconcileTick(deps);

    const summaries = notify.mock.calls.map((c) => c[0].summary);
    const idleInfo = summaries.find((summary) => summary.includes('loaded but not resident'));
    expect(idleInfo).toContain('normal for an idle timer-triggered/oneshot unit');
    expect(idleInfo).not.toContain('persistent service is expected to stay resident');
  });

  // ── WI-35537: the pause check must be reachable for a unit ABSENT from `list-units` ──
  //
  // `systemctl --user disable --now <unit>` — the DOCUMENTED way to pause the federation gate —
  // leaves the unit unloaded, so it vanishes from `list-units --all` and `status` is undefined.
  // Before this fix the `!status` branch returned `unit-not-found` and the WI-5378 pause check
  // was structurally unreachable, so a deliberate pause was reported as a missing unit file.
  it('WI-35537: a DISABLED unit absent from list-units is reported as paused, not "unit-not-found"', () => {
    const { action, nextState } = decideReconcile({
      entry: TIMER_ENTRY,
      status: undefined, // disabled + never started ⇒ absent from `list-units --all`
      show: { unitFileState: 'disabled', loadState: 'loaded' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'live-federation-gate-timer',
      reason: 'paused',
      notify: true,
    });
    // A pause is not a crash-loop: flap state resets, exactly as in the `status`-present path.
    expect(nextState.gaveUp).toBe(false);
    expect(nextState.restarts).toEqual([]);
  });

  it('WI-35537: a MASKED unit absent from list-units is likewise paused, not "unit-not-found"', () => {
    const { action } = decideReconcile({
      entry: TIMER_ENTRY,
      status: undefined,
      show: { unitFileState: 'masked', loadState: 'masked' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'live-federation-gate-timer',
      reason: 'paused',
      notify: true,
    });
  });

  it('WI-35537: an ENABLED unit absent from list-units is still unit-not-found (the pause branch must not over-claim)', () => {
    const { action } = decideReconcile({
      entry: TIMER_ENTRY,
      status: undefined,
      show: { unitFileState: 'enabled', loadState: 'not-found' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'report-only',
      unit: 'live-federation-gate-timer',
      reason: 'unit-not-found',
      confirmedAbsent: true,
      // EI-21531785497245954: LoadState=not-found, so presence is NOT confirmed either. The two
      // booleans are independent readings of the same probe, not opposites — both are false when
      // the probe is missing, and exactly one is true when it resolved.
      confirmedLoaded: false,
      notify: true,
    });
  });

  it('down + flag on + autoRestart:true -> restart with the FIRST backoff rung', () => {
    const { action, nextState } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({
      kind: 'restart',
      unit: 'mcp-proxy',
      backoffSec: BACKOFF_SEQUENCE_SEC[0],
      notify: true,
    });
    expect(nextState.restarts).toEqual([]);
    expect(nextState.backoffIndex).toBe(1);
    expect(nextState.lastAttemptAt).toBe(1000);
    expect(nextState.lastRestartAt).toBeNull();

    const confirmed = confirmFlapRestart(nextState, 1000);
    expect(confirmed.restarts).toEqual([1000]);
    expect(confirmed.lastRestartAt).toBe(1000);
  });

  it('a second restart attempt too soon (before the backoff wait elapses) -> waiting-backoff, no double-restart', () => {
    const first = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 0,
    });
    // BACKOFF_SEQUENCE_SEC[0] = 1s; try again 500ms later — too soon.
    const second = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: first.nextState,
      autoRestartFlagOn: true,
      now: 500,
    });
    expect(second.action).toEqual({ kind: 'waiting-backoff', unit: 'mcp-proxy' });
  });

  it('after the backoff wait elapses, a second restart attempt fires (backoff rung advances)', () => {
    const first = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 0,
    });
    const second = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'success' },
      state: first.nextState,
      autoRestartFlagOn: true,
      now: BACKOFF_SEQUENCE_SEC[0] * 1000 + 1,
    });
    expect(second.action).toEqual({
      kind: 'restart',
      unit: 'mcp-proxy',
      backoffSec: BACKOFF_SEQUENCE_SEC[1],
      notify: false,
    });
  });

  it('systemd start-limit-hit -> escalate-start-limit-hit, latches gaveUp (no further restart attempts)', () => {
    const { action, nextState } = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'start-limit-hit' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'escalate-start-limit-hit', unit: 'mcp-proxy' });
    expect(nextState.gaveUp).toBe(true);

    const next = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'start-limit-hit' },
      state: nextState,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(next.action).toEqual({ kind: 'already-escalated', unit: 'mcp-proxy' });
  });

  it('the first GIVE_UP_THRESHOLD restarts within the window are allowed; the NEXT attempt gives up instead of restarting again', () => {
    let state = initialFlapState('papercup-mcp-proxy.service');
    let now = 0;
    // Drive GIVE_UP_THRESHOLD (6) successful restart attempts, each spaced past its own backoff wait.
    for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
      const r = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state, autoRestartFlagOn: true, now });
      expect(r.action.kind).toBe('restart');
      state = confirmFlapRestart(r.nextState, now);
      now += 61_000; // past even the 60s cap rung
    }
    expect(state.restarts.length).toBe(GIVE_UP_THRESHOLD);
    // The (GIVE_UP_THRESHOLD + 1)th attempt (still inside the 10-minute window) gives up instead
    // of restarting further — a crash-loop is a code fault, not something to restart forever.
    const next = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state, autoRestartFlagOn: true, now });
    expect(next.action).toEqual({ kind: 'escalate-give-up', unit: 'mcp-proxy', restartsInWindow: GIVE_UP_THRESHOLD });
    expect(next.nextState.gaveUp).toBe(true);
  });

  it('restarts older than the 10-minute window are pruned before counting toward give-up', () => {
    const oldRestarts = [0, 1000, 2000, 3000, 4000]; // all > 10min before `now`
    const state = { ...initialFlapState('papercup-mcp-proxy.service'), restarts: oldRestarts, backoffIndex: 3, lastRestartAt: 4000 };
    const now = GIVE_UP_WINDOW_MS + 5000;
    const { action } = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state, autoRestartFlagOn: true, now });
    expect(action.kind).toBe('restart'); // not give-up — the old restarts fell out of the window
  });

  it('recovery: down -> healthy transition fires "recovered" once, then plain "healthy"', () => {
    const downState = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'success' }, state: initialFlapState('papercup-mcp-proxy.service'), autoRestartFlagOn: true, now: 0 }).nextState;
    const r1 = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state: downState, autoRestartFlagOn: true, now: 5000 });
    expect(r1.action).toEqual({ kind: 'recovered', unit: 'mcp-proxy' });
    const r2 = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state: r1.nextState, autoRestartFlagOn: true, now: 6000 });
    expect(r2.action).toEqual({ kind: 'healthy', unit: 'mcp-proxy' });
  });

  it('5 minutes continuously healthy resets the restart counter + give-up latch', () => {
    // Give up first.
    let state = initialFlapState('papercup-mcp-proxy.service');
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: down('papercup-mcp-proxy.service'), show: { result: 'start-limit-hit' }, state, autoRestartFlagOn: true, now: 0 }).nextState;
    expect(state.gaveUp).toBe(true);
    // Recovers at t=1000.
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: true, now: 1000 }).nextState;
    expect(state.gaveUp).toBe(true); // not reset yet — hasn't been healthy 5 min
    // Still healthy just under 5 minutes later — not reset yet.
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: true, now: 1000 + HEALTHY_RESET_MS - 1 }).nextState;
    expect(state.gaveUp).toBe(true);
    // Past 5 continuous minutes healthy — reset.
    state = decideReconcile({ entry: AUTORESTART_ENTRY, status: up('papercup-mcp-proxy.service'), show: undefined, state, autoRestartFlagOn: true, now: 1000 + HEALTHY_RESET_MS + 1 }).nextState;
    expect(state.gaveUp).toBe(false);
    expect(state.restarts).toEqual([]);
  });

  it('WI-5378: down + autoRestart:true + disabled UnitFileState -> report-only "paused", never restart', () => {
    const { action, nextState } = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'disabled' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: true });
    // Second tick, still paused — no re-notify (transition-only, like the other report-only paths).
    const r2 = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'disabled' },
      state: nextState,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(r2.action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: false });
  });

  it('WI-5378: masked UnitFileState is also treated as an intentional pause', () => {
    const { action } = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'masked' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    });
    expect(action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: true });
  });

  it('WI-5378: a unit that already gave up (crash-loop) but is then disabled is recognized as paused, not "already-escalated", and its flap state resets', () => {
    const gaveUp = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'start-limit-hit', unitFileState: 'enabled' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    }).nextState;
    expect(gaveUp.gaveUp).toBe(true);

    const paused = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'start-limit-hit', unitFileState: 'disabled' },
      state: gaveUp,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(paused.action).toEqual({ kind: 'report-only', unit: 'live-federation-gate-timer', reason: 'paused', notify: false });
    expect(paused.nextState.gaveUp).toBe(false);
    expect(paused.nextState.restarts).toEqual([]);
    expect(paused.nextState.backoffIndex).toBe(0);
    expect(paused.nextState.lastRestartAt).toBeNull();
  });

  it('WI-5378: re-enabling a paused unit resumes normal restart behavior on the very next tick', () => {
    const paused = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'disabled' },
      state: initialFlapState('papercup-live-federation-gate.timer'),
      autoRestartFlagOn: true,
      now: 1000,
    }).nextState;

    const resumed = decideReconcile({
      entry: TIMER_ENTRY,
      status: down('papercup-live-federation-gate.timer'),
      show: { result: 'success', unitFileState: 'enabled' },
      state: paused,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(resumed.action).toEqual({
      kind: 'restart',
      unit: 'live-federation-gate-timer',
      backoffSec: BACKOFF_SEQUENCE_SEC[0],
      notify: false,
    });
  });

  it('activating is treated as NOT down (never restart a unit mid-start)', () => {
    const activating: SystemctlUnitStatus = { unit: 'papercup-mcp-proxy.service', load: 'loaded', active: 'activating', sub: 'start', description: '' };
    const { action } = decideReconcile({ entry: AUTORESTART_ENTRY, status: activating, show: undefined, state: initialFlapState('papercup-mcp-proxy.service'), autoRestartFlagOn: true, now: 1000 });
    expect(action).toEqual({ kind: 'waiting-transition', unit: 'mcp-proxy' });
  });

  it('holds a persistent unit down across activating until a terminal healthy state proves recovery', () => {
    const downState = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: down('papercup-mcp-proxy.service'),
      show: { result: 'exit-code' },
      state: initialFlapState('papercup-mcp-proxy.service'),
      autoRestartFlagOn: true,
      now: 1000,
    }).nextState;
    const transitioning = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: { unit: 'papercup-mcp-proxy.service', load: 'loaded', active: 'activating', sub: 'start', description: '' },
      show: { result: 'exit-code' },
      state: downState,
      autoRestartFlagOn: true,
      now: 2000,
    });
    expect(transitioning.action).toEqual({ kind: 'waiting-transition', unit: 'mcp-proxy' });
    expect(transitioning.nextState.wasDown).toBe(true);

    const recovered = decideReconcile({
      entry: AUTORESTART_ENTRY,
      status: up('papercup-mcp-proxy.service'),
      show: undefined,
      state: transitioning.nextState,
      autoRestartFlagOn: true,
      now: 3000,
    });
    expect(recovered.action).toEqual({ kind: 'recovered', unit: 'mcp-proxy' });
  });
});

describe('checkRestartPolicyDrift (P-003(b) config-drift guard)', () => {
  it('report-only entry (autoRestart:false) never warns, regardless of the live Restart= value', () => {
    expect(checkRestartPolicyDrift(REPORT_ONLY_ENTRY, 'no', 'loaded', false)).toEqual({ warn: false, nextWarned: false });
    expect(checkRestartPolicyDrift(REPORT_ONLY_ENTRY, 'no', 'loaded', true)).toEqual({ warn: false, nextWarned: true });
  });

  it('no drift (Restart=always, matching the applied drop-in) -> no warn, latch clears', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'always', 'loaded', false)).toEqual({ warn: false, nextWarned: false });
    // Clears an existing latch too — a prior warn that's since been fixed should reset so a
    // future re-drift warns again instead of staying silently latched forever.
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'always', 'loaded', true)).toEqual({ warn: false, nextWarned: false });
  });

  it('unknown/unavailable Restart=/LoadState (systemctl show call failed this tick) -> treated as no drift, no warn', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, undefined, undefined, false)).toEqual({ warn: false, nextWarned: false });
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', undefined, false)).toEqual({ warn: false, nextWarned: false });
  });

  it('missing unit file (LoadState=not-found) -> warns with a missing-file reason, even when Restart=no is a default', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', 'not-found', false)).toEqual({
      warn: true,
      nextWarned: true,
      reason: 'unit-file-missing',
    });
  });

  it('first drift observed (LoadState=loaded + Restart=no, not yet warned) -> warns once, latches', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', 'loaded', false)).toEqual({
      warn: true,
      nextWarned: true,
      reason: 'restart-policy-drift',
    });
  });

  it('drift persists across ticks (already warned) -> no re-warn, latch stays set', () => {
    expect(checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', 'loaded', true)).toEqual({
      warn: false,
      nextWarned: true,
      reason: 'restart-policy-drift',
    });
  });

  it('drift observed fixed after having warned -> latch clears, so a future re-drift warns again', () => {
    const fixed = checkRestartPolicyDrift(AUTORESTART_ENTRY, 'on-failure', 'loaded', true);
    expect(fixed).toEqual({ warn: false, nextWarned: false });
    // Simulate the drift recurring on a later tick — it warns again since the latch was cleared.
    const redrift = checkRestartPolicyDrift(AUTORESTART_ENTRY, 'no', 'loaded', fixed.nextWarned);
    expect(redrift).toEqual({ warn: true, nextWarned: true, reason: 'restart-policy-drift' });
  });
});

describe('checkSilentCrashLoop (EI-10750 silent-crash-loop guard)', () => {
  it('a missing NRestarts reading carries state unchanged (no page, obs preserved)', () => {
    const obs = [{ at: 100, n: 3 }];
    const r = checkSilentCrashLoop(undefined, obs, false, 1000);
    expect(r).toEqual({ escalate: false, restartsInWindow: 0, nextObs: obs, nextEscalated: false });
  });

  it('a first observation of an already-high NRestarts does NOT page (no restarts seen DURING our window yet)', () => {
    // e.g. after an operator restart re-inits obs while systemd has long been at 43.
    const r = checkSilentCrashLoop(43, [], false, 1000);
    expect(r.escalate).toBe(false);
    expect(r.restartsInWindow).toBe(0);
    expect(r.nextObs).toEqual([{ at: 1000, n: 43 }]);
  });

  it('NRestarts climbing ≥ SILENT_LOOP_THRESHOLD within the window pages ONCE, then latches (no per-tick re-page)', () => {
    let obs: { at: number; n: number }[] = [];
    let escalated = false;
    let paged = 0;
    // 0..THRESHOLD, each 30s apart (all inside the five-minute window).
    for (let i = 0; i <= SILENT_LOOP_THRESHOLD; i++) {
      const r = checkSilentCrashLoop(i, obs, escalated, i * 30_000);
      obs = r.nextObs;
      escalated = r.nextEscalated;
      if (r.escalate) paged++;
    }
    expect(paged).toBe(1); // exactly one page, at the tick the delta first reaches the threshold
    // A further stable tick (NRestarts unchanged) must NOT re-page while still latched.
    const stable = checkSilentCrashLoop(SILENT_LOOP_THRESHOLD, obs, escalated, SILENT_LOOP_THRESHOLD * 30_000 + 5_000);
    expect(stable.escalate).toBe(false);
    expect(stable.nextEscalated).toBe(true);
  });

  it('below-threshold clears the latch so a fresh loop pages again', () => {
    // Loop-then-settle: once the early restarts age out of the window, the delta drops below
    // threshold and the latch clears.
    const settled = checkSilentCrashLoop(6, [{ at: 0, n: 6 }], true, SILENT_LOOP_WINDOW_MS + 1);
    // The only in-window observation is the fresh {now, 6}; delta 0 → below threshold → latch cleared.
    expect(settled.escalate).toBe(false);
    expect(settled.restartsInWindow).toBe(0);
    expect(settled.nextEscalated).toBe(false);
  });

  it('a DECREASE in NRestarts is treated as a systemd counter reset — fresh window + latch cleared', () => {
    const obs = [{ at: 0, n: 43 }, { at: 1000, n: 44 }];
    const r = checkSilentCrashLoop(0, obs, true, 2000);
    expect(r.nextObs).toEqual([{ at: 2000, n: 0 }]);
    expect(r.restartsInWindow).toBe(0);
    expect(r.escalate).toBe(false);
    expect(r.nextEscalated).toBe(false);
  });

  it('observations older than the five-minute window are pruned before computing the delta', () => {
    // An old {n:0} that has aged out must not inflate the in-window delta.
    const now = SILENT_LOOP_WINDOW_MS + 100_000;
    const obs = [{ at: 0, n: 0 }, { at: now - 60_000, n: 40 }];
    const r = checkSilentCrashLoop(41, obs, false, now);
    // Only the {n:40} obs is still in-window; delta = 41 - 40 = 1, below threshold.
    expect(r.restartsInWindow).toBe(1);
    expect(r.escalate).toBe(false);
  });
});

describe('censusUnregisteredFailedUnits (unregistered crash-loop reporting)', () => {
  beforeEach(() => _resetFailedUnitCensusForTests());

  function makeDeps(
    units: Array<{ unit: string; active: string; transient: string }>,
    getRestarts: () => number,
  ) {
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') {
        return units.map(({ unit, active }) => `${unit} loaded ${active} ${active === 'failed' ? 'failed' : 'running'} ${unit}`).join('\n');
      }
      return units.map(({ unit, transient }) =>
        `Id=${unit}\nLoadState=loaded\nTransient=${transient}\nNRestarts=${getRestarts()}`,
      ).join('\n\n');
    });
    return { execUser, notify: vi.fn<ReconcilerDeps['notify']>(async () => {}) };
  }

  it('pages once when an unregistered service NRestarts rises by three within five minutes, then re-arms after the episode settles', async () => {
    let nRestarts = 0;
    const deps = makeDeps([{ unit: 'third-party.service', active: 'active', transient: 'no' }], () => nRestarts);
    for (let i = 0; i <= 3; i++) {
      nRestarts = i;
      await censusUnregisteredFailedUnits(deps, [], () => {}, i * 60_000);
    }
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0]?.[0].summary).toContain('third-party.service');
    expect(deps.notify.mock.calls[0]?.[0].summary).toContain('systemd remains the restart authority');

    nRestarts = 4;
    await censusUnregisteredFailedUnits(deps, [], () => {}, 240_000);
    expect(deps.notify).toHaveBeenCalledTimes(1);

    await censusUnregisteredFailedUnits(deps, [], () => {}, 600_001);
    for (let i = 5; i <= 7; i++) {
      nRestarts = i;
      await censusUnregisteredFailedUnits(deps, [], () => {}, 600_001 + (i - 4) * 60_000);
    }
    expect(deps.notify).toHaveBeenCalledTimes(2);
  });

  it('excludes transient and registered services from restart-rate alerts', async () => {
    let nRestarts = 0;
    const deps = makeDeps([
      { unit: 'run-scoped.service', active: 'active', transient: 'yes' },
      { unit: 'registered.service', active: 'active', transient: 'no' },
    ], () => nRestarts);
    for (let i = 0; i <= 3; i++) {
      nRestarts = i;
      await censusUnregisteredFailedUnits(deps, [{ unit: 'registered.service' }], () => {}, i * 60_000);
    }
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('preserves the failed-unit alert and latches it once per failure episode', async () => {
    const deps = makeDeps([{ unit: 'retired.service', active: 'failed', transient: 'no' }], () => 7);
    expect(await censusUnregisteredFailedUnits(deps, [], () => {}, 0)).toEqual(['retired.service']);
    expect(await censusUnregisteredFailedUnits(deps, [], () => {}, 60_000)).toEqual(['retired.service']);
    expect(deps.notify).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls[0]?.[0].summary).toContain('FAILED on this host');
  });
});

/**
 * EI-20093902925801178 — the false-GREEN this reproduces at the source.
 *
 * `flapStateByUnit` is plain module state, so it is populated ONLY in the
 * process that runs `reconcileTick` — and the sole non-test caller is the
 * `supervision-reconcile` ROUTINE, which executes inside `papercup-bg-host`.
 * `dev:service_health` imports this module in the OPERATOR process, where the
 * Map is therefore empty forever. Every entry took the `state === undefined`
 * branch and serialized `restartsLast10m: 0, lastRestartAt: null,
 * flapState: 'ok'` — a NO-DATA reading wearing the exact shape of a
 * measured-healthy one. Live cost, 2026-08-10: papercup-staging-api reported
 * all of that while systemd's own NRestarts was 4.
 *
 * The test below IS that production condition (an empty map), so `flapObserved`
 * must be false. If someone later makes it default true, this fails.
 */
describe('supervisionSnapshot flapObserved (EI-20093902925801178)', () => {
  beforeEach(() => {
    _resetReconcilerState();
  });

  it('reports flapObserved:false when this process holds NO reconciler state — the zeros are defaults, not measurements', () => {
    const snap = supervisionSnapshot(1_000_000, [AUTORESTART_ENTRY, REPORT_ONLY_ENTRY]);
    expect(snap).toHaveLength(2);
    for (const row of snap) {
      expect(row.flapObserved, `${row.name} has no flap state in this process`).toBe(false);
      // The zero-defaults that made this indistinguishable from health. They are
      // still reported — the fix is that `flapObserved` now disambiguates them,
      // not that the reading is hidden.
      expect(row.restartsLast10m).toBe(0);
      expect(row.lastRestartAt).toBeNull();
      expect(row.flapState).toBe('ok');
    }
  });

  it('flips flapObserved:true only for units the reconciler has actually tracked', async () => {
    // One tick populates flap state for the units in THIS registry.
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
      if (args[0] === 'show') return 'Result=success\nNRestarts=0\n';
      return '';
    });
    await reconcileTick({
      execUser,
      notify: async () => {},
      now: () => 1_000_000,
      autoRestartFlagOn: async () => true,
      registry: () => [AUTORESTART_ENTRY],
      log: () => {},
    } as unknown as ReconcilerDeps);

    const [tracked] = supervisionSnapshot(1_000_000, [AUTORESTART_ENTRY]);
    expect(tracked?.flapObserved, 'a unit this process reconciled IS observed').toBe(true);

    // ...and a unit absent from that tick stays honestly un-observed, so the
    // flag tracks real per-unit knowledge rather than "did any tick ever run".
    const [untracked] = supervisionSnapshot(1_000_000, [REPORT_ONLY_ENTRY]);
    expect(untracked?.flapObserved).toBe(false);
  });
});

describe('reconcileTick (orchestrator, mocked deps)', () => {
  beforeEach(() => {
    _resetReconcilerState();
  });

  function makeDeps(overrides: Partial<ReconcilerDeps> = {}): ReconcilerDeps & { execUser: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> } {
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
      if (args[0] === 'show') {
        const propertyIndex = args.indexOf('-p');
        return args
          .slice(1, propertyIndex)
          .map((unit) => `Id=${unit.includes('.') ? unit : `${unit}.service`}\nResult=success\nNRestarts=0`)
          .join('\n\n');
      }
      if (args[0] === 'restart') return '';
      return '';
    });
    const notify = vi.fn(async () => {});
    return {
      execUser,
      notify,
      now: () => 1_000_000,
      autoRestartFlagOn: async () => true,
      registry: () => [AUTORESTART_ENTRY, REPORT_ONLY_ENTRY],
      log: () => {},
      ...overrides,
    } as ReconcilerDeps & { execUser: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
  }

  it('EI-22777309029828628: systemd active plus a refused staging listener waits without emitting false recovery', async () => {
    let active = false;
    let now = 1_000;
    const probeService = vi.fn(async () => ({
      name: 'staging-api',
      up: false,
      status: null,
      latencyMs: 2,
      url: 'http://127.0.0.1:3170/api/desktop/version',
    }));
    const resolveGiveUpEi = vi.fn(async () => ['EI-staging']);
    const deps = makeDeps({
      registry: () => [STAGING_API_ENTRY],
      probeService,
      resolveGiveUpEi,
      now: () => now,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') {
          return active
            ? 'papercusp-staging-api.service loaded active running Papercusp staging API\n'
            : 'papercusp-staging-api.service loaded failed failed Papercusp staging API\n';
        }
        if (args[0] === 'show') {
          return 'Id=papercusp-staging-api.service\nResult=success\nNRestarts=0\nActiveState=' +
            (active ? 'active' : 'failed') +
            '\nLoadState=loaded\nUnitFileState=enabled\n';
        }
        if (args[0] === 'restart') {
          active = true;
          return '';
        }
        return '';
      }),
    });

    // First tick establishes the down episode and performs the systemd restart.
    await reconcileTick(deps);

    // systemd now reports active, but the listener still refuses HTTP. The pre-decision state
    // must survive: wasDown stays true, so this is not a recovered transition.
    now += 2_000;
    const result = await reconcileTick(deps);
    expect(result.actions).toEqual([{ kind: 'waiting-health-probe', unit: 'staging-api' }]);
    expect(probeService).toHaveBeenCalledTimes(1);
    expect(probeService).toHaveBeenCalledWith('staging-api');
    expect(deps.notify.mock.calls.some((call) => String(call[0]?.summary ?? '').includes('recovered'))).toBe(false);
    expect(resolveGiveUpEi).not.toHaveBeenCalled();

    // The probe is bounded even for an injected implementation; this exported value is part of
    // the contract and keeps the recovery gate from inheriting an unbounded HTTP wait.
    expect(STAGING_API_RECOVERY_PROBE_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('EI-22777309029828628: systemd active plus a healthy staging listener permits the real recovery transition', async () => {
    let active = false;
    let now = 1_000;
    const probeService = vi.fn(async () => ({
      name: 'staging-api',
      up: true,
      status: 200,
      latencyMs: 2,
      url: 'http://127.0.0.1:3170/api/desktop/version',
    }));
    const resolveGiveUpEi = vi.fn(async () => ['EI-staging']);
    const deps = makeDeps({
      registry: () => [STAGING_API_ENTRY],
      probeService,
      resolveGiveUpEi,
      now: () => now,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') {
          return active
            ? 'papercusp-staging-api.service loaded active running Papercusp staging API\n'
            : 'papercusp-staging-api.service loaded failed failed Papercusp staging API\n';
        }
        if (args[0] === 'show') {
          return 'Id=papercusp-staging-api.service\nResult=success\nNRestarts=0\nActiveState=' +
            (active ? 'active' : 'failed') +
            '\nLoadState=loaded\nUnitFileState=enabled\n';
        }
        if (args[0] === 'restart') {
          active = true;
          return '';
        }
        return '';
      }),
    });

    await reconcileTick(deps);
    now += 2_000;
    const result = await reconcileTick(deps);

    expect(result.actions).toEqual([{ kind: 'recovered', unit: 'staging-api' }]);
    expect(probeService).toHaveBeenCalledTimes(1);
    expect(deps.notify.mock.calls.some((call) => String(call[0]?.summary ?? '').includes('recovered'))).toBe(true);
    expect(resolveGiveUpEi).toHaveBeenCalledWith({ unit: 'papercusp-staging-api' });
  });

  it('restarts a failed autoRestart:true unit and notifies; leaves the report-only entry alone', async () => {
    const deps = makeDeps();
    const result = await reconcileTick(deps);
    expect(result.checked).toBe(2);
    expect(result.degraded).toBe(false);
    // `entry.unit` is the BARE name (no `.service` suffix) — systemctl accepts either form, and
    // the reconciler passes the registry's bare form straight through.
    const restartCalls = deps.execUser.mock.calls.map((c) => c[0]).filter((args) => args[0] === 'restart');
    expect(restartCalls).toEqual([['restart', 'papercup-mcp-proxy']]);
    // The report-only entry (live-federation-gate, autoRestart:false) is down (inactive/dead in
    // the fixture) but must NEVER be restarted.
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart' && c[0][1] === 'papercup-live-federation-gate')).toBe(false);
    expect(deps.notify).toHaveBeenCalled();
  });

  it('EI-22737582656157929: reads every eligible unit with one Id-keyed systemctl show call', async () => {
    const deps = makeDeps();
    await reconcileTick(deps);

    const showCalls = deps.execUser.mock.calls.map((call) => call[0] as string[]).filter((args) => args[0] === 'show');
    expect(showCalls).toHaveLength(1);
    expect(showCalls[0].slice(1, showCalls[0].indexOf('-p'))).toEqual([
      'papercup-mcp-proxy',
      'papercup-live-federation-gate',
    ]);
    expect(showCalls[0][showCalls[0].indexOf('-p') + 1]).toContain('Id');
  });

  it('falls back only for a unit omitted from a successful multi-unit show response', async () => {
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
      if (args[0] === 'show' && args.includes('papercup-mcp-proxy') && args.includes('papercup-live-federation-gate')) {
        return 'Id=papercup-mcp-proxy.service\nResult=success\nNRestarts=0\n';
      }
      if (args[0] === 'show') {
        return 'Id=papercup-live-federation-gate.service\nResult=success\nNRestarts=0\nUnitFileState=disabled\nLoadState=loaded\n';
      }
      if (args[0] === 'restart') return '';
      return '';
    });
    const deps = makeDeps({ execUser });
    await reconcileTick(deps);

    const showCalls = execUser.mock.calls.map((call) => call[0] as string[]).filter((args) => args[0] === 'show');
    expect(showCalls).toHaveLength(2);
    expect(showCalls[1].slice(1, showCalls[1].indexOf('-p'))).toEqual(['papercup-live-federation-gate']);
  });

  it('falls back per unit when the multi-unit show call fails', async () => {
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
      if (args[0] === 'show' && args.includes('papercup-mcp-proxy') && args.includes('papercup-live-federation-gate')) {
        throw new Error('one unit vanished during the batch');
      }
      if (args[0] === 'show') {
        const unit = args[1];
        return `Id=${unit}.service\nResult=success\nNRestarts=0\nLoadState=loaded\n`;
      }
      if (args[0] === 'restart') return '';
      return '';
    });
    const deps = makeDeps({ execUser });
    await reconcileTick(deps);

    const showCalls = execUser.mock.calls.map((call) => call[0] as string[]).filter((args) => args[0] === 'show');
    expect(showCalls).toHaveLength(3);
    expect(showCalls.slice(1).map((args) => args[1])).toEqual([
      'papercup-mcp-proxy',
      'papercup-live-federation-gate',
    ]);
  });

  // EI-20083989508593730 — the SEAM. `flapStateByUnit` is in-memory, so a bg-host restart drops
  // every `wasDown`; if the unit is healthy again by the first tick, no 'recovered' transition
  // ever fires and the give-up EI filed by the previous process is orphaned. Measured live:
  // bg-host restarted 16:50Z, papercup-staging-api was healthy 16:51Z, EI still open 25min later.
  it('reconciles a give-up EI orphaned by a restart on the FIRST healthy observation, silently', async () => {
    const resolveGiveUpEi = vi.fn(async () => ['EI-1']);
    const deps = makeDeps({
      resolveGiveUpEi,
      registry: () => [AUTORESTART_ENTRY],
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units')
          return ['papercup-mcp-proxy.service loaded active running Papercusp resilient MCP proxy', ''].join('\n');
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\n';
        return '';
      }),
    });

    await reconcileTick(deps);
    expect(resolveGiveUpEi).toHaveBeenCalledWith({ unit: 'papercup-mcp-proxy' });
    // ...and WITHOUT announcing a recovery that never happened: the unit did not recover, the
    // supervising process merely restarted. A "✅ recovered" per healthy unit per bg-host
    // restart would be pure noise.
    expect(deps.notify.mock.calls.some((c) => String(c[0]?.summary ?? '').includes('recovered'))).toBe(false);

    // Once only — not re-fired on every 60s tick for the life of the process.
    resolveGiveUpEi.mockClear();
    await reconcileTick(deps);
    expect(resolveGiveUpEi).not.toHaveBeenCalled();
  });

  // WI-9249: these assert the SEAM (the escalation actually carries the cause), which the pure
  // summarizeSystemctlStatusCause tests above cannot reach.
  const STATUS_WITH_CAUSE = [
    'Active: failed (Result: exit-code)',
    'Process: 904863 ExecStartPre=/home/x/apps/operator/bin/bundle-host.sh (code=exited, status=1/FAILURE)',
    "Aug 03 14:13:03 host systemd[1]: papercup-mcp-proxy.service: Failed with result 'exit-code'.",
  ].join('\n');

  function depsWithStartLimit(statusImpl: (args: string[]) => Promise<string>) {
    return makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=start-limit-hit\nNRestarts=0\n';
        if (args[0] === 'status') return statusImpl(args);
        return '';
      }),
    });
  }

  it('an escalation page carries the failure CAUSE, not just "needs investigation"', async () => {
    const deps = depsWithStartLimit(async () => STATUS_WITH_CAUSE);
    await reconcileTick(deps);
    const page = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('start-limit'));
    expect(page, 'expected a start-limit escalation').toBeDefined();
    // The regression this closes: the page used to end at "investigation" with no cause, so
    // every responder began from zero and re-ran journalctl by hand.
    expect(page).toContain('Cause:');
    expect(page).toContain('bundle-host.sh');
  });

  it('CONTROL: gathering diagnostics must never suppress the page itself', async () => {
    const deps = depsWithStartLimit(async () => {
      throw new Error('journal unreadable');
    });
    await reconcileTick(deps);
    const page = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('start-limit'));
    // Still paged — the escalation is the load-bearing part, the cause is a bonus.
    expect(page).toBeDefined();
    expect(page).toContain('Cause unavailable');
  });

  // ── WI-35537 WIRING ────────────────────────────────────────────────────────
  //
  // The pure decideReconcile cases above all still pass if the tick never asks systemctl for
  // LoadState/UnitFileState, or never probes a unit missing from `list-units` — the fix would be
  // inert. These two assert the SEAM.

  it('WI-35537 WIRING: the show-probe requests LoadState, without which absence can never be confirmed', async () => {
    const deps = makeDeps();
    await reconcileTick(deps);
    const showCalls = deps.execUser.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === 'show');
    expect(showCalls.length).toBeGreaterThan(0);
    for (const call of showCalls) {
      const props = call[call.indexOf('-p') + 1];
      expect(props).toContain('LoadState');
      expect(props).toContain('UnitFileState');
    }
  });

  it('WI-35537 WIRING: a registry unit ABSENT from list-units is show-probed and reported as PAUSED, not "removed/never installed"', async () => {
    // The live case: `disable --now` on the gate timer leaves it out of `list-units --all`
    // entirely, while `systemctl show` still resolves it as loaded-but-disabled.
    const deps = makeDeps({
      registry: () => [TIMER_ENTRY],
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE; // contains NO .timer row
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nUnitFileState=disabled\nLoadState=loaded\n';
        return '';
      }),
    });
    await reconcileTick(deps);

    // It must have been probed despite being absent from the listing.
    expect(deps.execUser.mock.calls.some((c) => (c[0] as string[])[0] === 'show')).toBe(true);
    // Never restarted — a pause is deliberate.
    expect(deps.execUser.mock.calls.some((c) => (c[0] as string[])[0] === 'restart')).toBe(false);

    const summaries = deps.notify.mock.calls.map((c) => c[0].summary as string);
    expect(summaries.some((s) => s.includes('administratively disabled/masked'))).toBe(true);
    // The regression this closes: a deliberate pause reported as a missing unit file.
    expect(summaries.some((s) => s.includes('removed/never installed'))).toBe(false);
  });

  it('WI-35537 WIRING: an autoRestart:FALSE unit absent from list-units is ALSO probed — the widening, not just the autoRestart path', async () => {
    // Guards the `|| !status` half of the probe condition specifically: a report-only entry never
    // got a show-probe before, so a paused one could only ever be reported as "removed".
    const ABSENT_REPORT_ONLY: SupervisionEntry = {
      name: 'absent-report-only',
      layer: 'systemd-user',
      unit: 'papercup-absent-report-only',
      criticality: 'important',
      autoRestart: false,
    };
    const deps = makeDeps({
      registry: () => [ABSENT_REPORT_ONLY],
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE; // does not contain it
        if (args[0] === 'show') return 'UnitFileState=disabled\nLoadState=loaded\n';
        return '';
      }),
    });
    await reconcileTick(deps);

    expect(
      deps.execUser.mock.calls.some((c) => (c[0] as string[])[0] === 'show'),
      'an autoRestart:false entry missing from list-units must still be show-probed',
    ).toBe(true);
    const summaries = deps.notify.mock.calls.map((c) => c[0].summary as string);
    expect(summaries.some((s) => s.includes('administratively disabled/masked'))).toBe(true);
    expect(summaries.some((s) => s.includes('removed/never installed'))).toBe(false);
  });

  it('does not restart when FLAGS.supervisorAutoRestart resolves false (report-only everywhere)', async () => {
    const deps = makeDeps({ autoRestartFlagOn: async () => false });
    await reconcileTick(deps);
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
  });

  it('a systemctl list-units failure degrades to report-only + ONE warning, never throws', async () => {
    const deps = makeDeps({ execUser: vi.fn(async () => { throw new Error('user bus unreachable'); }) });
    const result = await reconcileTick(deps);
    expect(result.degraded).toBe(true);
    expect(result.checked).toBe(0);
    expect(deps.notify).toHaveBeenCalledTimes(1); // one-time warn, not a per-tick spam
    // A SECOND tick with the same failure does not warn again.
    const deps2 = { ...deps, execUser: deps.execUser, notify: deps.notify };
    await reconcileTick(deps2);
    expect(deps.notify).toHaveBeenCalledTimes(1);
  });

  it('never throws even when the restart command itself fails', async () => {
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=success\n';
        if (args[0] === 'restart') throw new Error('systemctl restart failed');
        return '';
      }),
    });
    await expect(reconcileTick(deps)).resolves.toBeDefined();
    expect(deps.notify).toHaveBeenCalled();
    const [snapshot] = supervisionSnapshot(1_000_000, [AUTORESTART_ENTRY]);
    expect(snapshot).toMatchObject({
      restartsLast10m: 0,
      lastRestartAt: null,
      flapObserved: true,
    });
  });

  it('paces repeated failed restart commands without consuming the confirmed give-up budget', async () => {
    let now = 0;
    const deps = makeDeps({
      now: () => now,
      registry: () => [AUTORESTART_ENTRY],
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\n';
        if (args[0] === 'restart') throw new Error('systemctl restart failed');
        return '';
      }),
    });

    for (let attempt = 0; attempt < GIVE_UP_THRESHOLD + 1; attempt += 1) {
      await reconcileTick(deps);
      now += 61_000;
    }

    const restartCalls = deps.execUser.mock.calls.filter((c) => c[0][0] === 'restart');
    expect(restartCalls).toHaveLength(GIVE_UP_THRESHOLD + 1);
    expect(deps.notify.mock.calls.some((c) => String(c[0]?.summary ?? '').includes('GIVING UP'))).toBe(false);
    const [snapshot] = supervisionSnapshot(now, [AUTORESTART_ENTRY]);
    expect(snapshot).toMatchObject({
      restartsLast10m: 0,
      lastRestartAt: null,
      flapObserved: true,
    });
  });

  it('EI-21271585349726650: pages once per continuous restart-failure episode, then re-arms after recovery', async () => {
    let now = 0;
    let healthy = false;
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') {
        return healthy
          ? 'papercup-mcp-proxy.service loaded active running Papercusp resilient MCP proxy\n'
          : LIST_UNITS_FIXTURE;
      }
      if (args[0] === 'show') return 'Result=success\nNRestarts=0\nRestart=always\nLoadState=loaded\n';
      if (args[0] === 'restart') throw new Error('systemctl restart failed');
      return '';
    });
    const deps = makeDeps({
      execUser,
      now: () => now,
      registry: () => [AUTORESTART_ENTRY],
    });
    const failurePages = () =>
      deps.notify.mock.calls.filter((c) => String(c[0]?.summary ?? '').includes('systemctl --user restart'));

    await reconcileTick(deps);
    now = BACKOFF_SEQUENCE_SEC[0] * 1000 + 1;
    await reconcileTick(deps);
    expect(failurePages()).toHaveLength(1);

    healthy = true;
    now += 1_000;
    await reconcileTick(deps);

    healthy = false;
    now += 61_000;
    await reconcileTick(deps);
    expect(failurePages()).toHaveLength(2);
  });

  it('P-003(b): a supervised unit whose live Restart= has drifted to "no" gets a ONE-TIME escalation notify, not re-fired while still drifted', async () => {
    // mcp-proxy is UP+healthy in this variant (so the drift guard is exercised independently of
    // the down/restart path) but its live Restart= has drifted off the applied drop-in.
    const upFixture = [
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
      '',
    ].join('\n');
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nRestart=no\nLoadState=loaded\n';
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    await reconcileTick(deps);
    const driftNotifies = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('Restart= policy has drifted'));
    expect(driftNotifies).toHaveLength(1);

    // A second tick, still drifted — must NOT re-notify (one-time until observed fixed).
    await reconcileTick(deps);
    const driftNotifiesAfter = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('Restart= policy has drifted'));
    expect(driftNotifiesAfter).toHaveLength(1);
  });

  it('P-003(b): once the drift is observed fixed, a later re-drift warns again', async () => {
    const upFixture = [
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
      '',
    ].join('\n');
    let restartProp = 'no';
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return `Result=success\nNRestarts=0\nRestart=${restartProp}\nLoadState=loaded\n`;
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    await reconcileTick(deps); // drifted -> warns (1)
    restartProp = 'always'; // fixed
    await reconcileTick(deps); // fixed -> no warn, latch clears
    restartProp = 'no'; // drifts again
    await reconcileTick(deps); // re-drifted -> warns again (2)
    const driftNotifies = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('Restart= policy has drifted'));
    expect(driftNotifies).toHaveLength(2);
  });

  it('P-003(b): LoadState=not-found reports an unreachable unit file, not Restart= policy drift', async () => {
    const upFixture = [
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
      '',
    ].join('\n');
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nRestart=no\nLoadState=not-found\n';
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    await reconcileTick(deps);
    await reconcileTick(deps);
    const summaries = deps.notify.mock.calls.map((c) => String(c[0]?.summary));
    const missingUnitNotifies = summaries.filter((summary) => summary.includes('unit file is MISSING/UNREACHABLE'));
    expect(missingUnitNotifies).toEqual([
      '⚠ supervision: `papercup-mcp-proxy` unit file is MISSING/UNREACHABLE (LoadState=not-found; check for a broken symlink in ~/.config/systemd/user) — systemd cannot start or restart it',
    ]);
    expect(summaries.some((summary) => summary.includes('Restart= policy has drifted'))).toBe(false);
  });

  it('EI-11344: NRestarts climbing 8→12 in four minutes pages once with the last exit cause, even with auto-restart off', async () => {
    // The exact bug: papercup-staging-api crash-looped under systemd's own Restart= so fast that
    // every 60s reconciler tick saw it `active`. The down-path give-up counter never engaged — 43
    // restarts / 25 min of :3170 down, ZERO pages. Flag OFF (the real default) to prove the page is
    // independent of whether WE do the restarting.
    const upFixture = ['papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy', ''].join('\n');
    let nRestarts = 0;
    let now = 1_000_000;
    const deps = makeDeps({
      autoRestartFlagOn: async () => false,
      now: () => now,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return `Result=success\nNRestarts=${nRestarts}\nRestart=always\n`;
        if (args[0] === 'status') {
          return 'node:events: listen EADDRINUSE 127.0.0.1:3070\npapercup-dev-api.service: Main process exited, code=exited, status=1/FAILURE\n';
        }
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    // Exact production incident shape: baseline 8, then four restarts in four minutes.
    for (let i = 0; i <= 4; i++) {
      nRestarts = 8 + i;
      await reconcileTick(deps);
      now += 60_000;
    }
    // One more stable tick (no further climb) must not re-page.
    await reconcileTick(deps);

    const silentPages = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('SILENTLY crash-looping'));
    expect(silentPages).toHaveLength(1);
    expect(String(silentPages[0][0].summary)).toContain('papercup-mcp-proxy');
    expect(String(silentPages[0][0].summary)).toContain('3× in <5min');
    expect(String(silentPages[0][0].summary)).toContain('Main process exited, code=exited, status=1/FAILURE');
    expect(silentPages[0][0].kind).toBe('escalation');
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'status')).toBe(true);
    // It read healthy at every tick — the down/restart path never engaged.
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
  });

  it('WI-5378: a deliberately disabled autoRestart:true unit (the live-federation-gate timer, stopped+disabled to pause the gate) is NEVER restarted, and the reconciler reports the pause instead', async () => {
    const timerDisabledFixture = [
      'papercup-live-federation-gate.timer                loaded inactive dead    Nightly trigger for the live 2-peer federation gate',
      '',
    ].join('\n');
    const deps = makeDeps({
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return timerDisabledFixture;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\nRestart=no\nUnitFileState=disabled\n';
        if (args[0] === 'restart') return '';
        return '';
      }),
      registry: () => [TIMER_ENTRY],
    });
    const result = await reconcileTick(deps);
    expect(result.checked).toBe(1);
    // The whole point of the fix: no restart call was ever issued against the paused timer.
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
    const pausedNotifies = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('respecting the pause'));
    expect(pausedNotifies).toHaveLength(1);

    // A second tick, still disabled — no repeat restart attempt and no re-notify.
    await reconcileTick(deps);
    expect(deps.execUser.mock.calls.some((c) => c[0][0] === 'restart')).toBe(false);
    const pausedNotifiesAfter = deps.notify.mock.calls.filter((c) => String(c[0]?.summary).includes('respecting the pause'));
    expect(pausedNotifiesAfter).toHaveLength(1);
  });

  // ── EI-19966318801100410 WIRING ──────────────────────────────────────────
  //
  // Defect #1: `systemctl --user status` on a down unit ALWAYS exits non-zero (the promisified
  // execUser therefore always REJECTS for the down-unit case), but the rejection still carries
  // the diagnostic stdout — these assert the cause SEAM recovers it instead of discarding it.
  // Defect #2: a give-up escalation must file a claimable EI, not just broadcast to `*`.

  /** A REJECTED `status` call whose error still carries the diagnostic stdout — the real shape
   *  of `execSystemctlUser` (`util.promisify(execFile)`) against a failed/inactive unit. */
  function rejectingStatusErr(stdout: string): Error & { stdout: string } {
    return Object.assign(new Error('Command failed: systemctl --user status x exit code 3'), { stdout });
  }

  it('an escalation page recovers the CAUSE from a REJECTED status call that still carries stdout, instead of falling back to "unavailable"', async () => {
    const deps = depsWithStartLimit(async () => {
      throw rejectingStatusErr(STATUS_WITH_CAUSE);
    });
    await reconcileTick(deps);
    const page = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('start-limit'));
    expect(page).toBeDefined();
    expect(page).toContain('Cause:');
    expect(page).toContain('bundle-host.sh');
    expect(page).not.toContain('Cause unavailable');
  });

  it('CONTROL: a rejection with NO stdout at all still falls back to "unavailable" (the recovery is additive, not a blanket cause-fabricator)', async () => {
    const deps = depsWithStartLimit(async () => {
      throw new Error('spawn systemctl ENOENT'); // no .stdout — a genuine spawn failure
    });
    await reconcileTick(deps);
    const page = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('start-limit'));
    expect(page).toBeDefined();
    expect(page).toContain('Cause unavailable');
  });

  it('the SILENT-crash-loop page also recovers "Last exit" from a rejected status call carrying stdout', async () => {
    // Same shape as the EI-11344 test above, but the `status` probe REJECTS (carrying stdout)
    // instead of resolving — the real contract of a promisified execFile against a down unit.
    const upFixture = ['papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy', ''].join('\n');
    let nRestarts = 0;
    let now = 1_000_000;
    const deps = makeDeps({
      autoRestartFlagOn: async () => false,
      now: () => now,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return `Result=success\nNRestarts=${nRestarts}\nRestart=always\n`;
        if (args[0] === 'status') throw rejectingStatusErr(STATUS_WITH_CAUSE);
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    for (let i = 0; i <= 4; i++) {
      nRestarts = 8 + i;
      await reconcileTick(deps);
      now += 60_000;
    }
    const silentPage = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('SILENTLY crash-looping'));
    expect(silentPage).toBeDefined();
    expect(silentPage).toContain('Last exit:');
    expect(silentPage).toContain('bundle-host.sh');
    expect(silentPage).not.toContain('Last exit unavailable');
  });

  it('EI-19457080109574347: a SILENT crash-loop page reads journald when status has no output and carries the remote-auth boot failure', async () => {
    const upFixture = [
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
      '',
    ].join('\n');
    let nRestarts = 0;
    let now = 1_000_000;
    const readUnitJournal = vi.fn(async (_unit: string) => REMOTE_AUTH_RUNTIME_FAILURE_JOURNAL.join('\n'));
    const deps = makeDeps({
      autoRestartFlagOn: async () => false,
      now: () => now,
      readUnitJournal,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return upFixture;
        if (args[0] === 'show') return `Result=success\nNRestarts=${nRestarts}\nRestart=always\n`;
        if (args[0] === 'status') throw new Error('status output unavailable');
        return '';
      }),
      registry: () => [AUTORESTART_ENTRY],
    });
    for (let i = 0; i <= 4; i++) {
      nRestarts = 8 + i;
      await reconcileTick(deps);
      now += 60_000;
    }
    const silentPage = deps.notify.mock.calls
      .map((c) => c[0].summary as string)
      .find((s) => s.includes('SILENTLY crash-looping'));
    expect(silentPage).toContain('Last exit:');
    expect(silentPage).toContain('Error: Refusing off-loopback bind 0.0.0.0');
    expect(silentPage).not.toContain('Last exit unavailable');
    expect(readUnitJournal).toHaveBeenCalledWith('papercup-mcp-proxy');
  });

  it('EI-19966318801100410: an escalate-give-up transition FILES a durable EI via fileGiveUpEi, carrying the unit, restart count, and cause — not just a broadcast', async () => {
    let now = 0;
    // Declare the PARAMETER, not just the return: a bare `vi.fn(async () => …)`
    // infers a zero-arg signature, so `mock.calls[0]` is the empty tuple `[]` and
    // the `[0]` assertions below fail to typecheck (TS2493/TS2532 — a committed
    // gate red, WI-37470). Mirroring the real dep signature keeps the argument
    // assertions type-checked against what the reconciler actually passes.
    const fileGiveUpEi = vi.fn(
      async (_episode: SupervisionGiveUpEpisode): Promise<string | null> => 'EI-123',
    );
    const deps = makeDeps({
      now: () => now,
      fileGiveUpEi,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\n';
        if (args[0] === 'status') return STATUS_WITH_CAUSE;
        return '';
      }),
    });
    // Drive GIVE_UP_THRESHOLD successful restarts (mirrors the pure decideReconcile test), each
    // spaced past its own backoff wait so the reconciler actually attempts every one.
    for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
      await reconcileTick(deps);
      now += 61_000;
    }
    expect(fileGiveUpEi).not.toHaveBeenCalled(); // not yet — still restarting, hasn't given up

    // EI-20093844846536045: this fixture's cause is a BUILD-STEP (ExecStartPre) failure, which is
    // no longer a PERMANENT give-up on the first trip — the tree usually recovers on its own, so
    // the reconciler absorbs a bounded number of cycles and keeps retrying. Filing an EI for a
    // self-clearing tree break is exactly the noise that policy exists to avoid.
    //
    // The contract THIS test guards is unchanged and still asserted below: when the reconciler
    // genuinely gives up, it files a durable claimable EI rather than only broadcasting. So drive
    // past the patience budget to reach that real give-up, instead of weakening the assertion.
    for (let i = 0; i < (GIVE_UP_THRESHOLD + 2) * (BUILD_STEP_RETRY_LIMIT + 2); i++) {
      if (fileGiveUpEi.mock.calls.length > 0) break;
      await reconcileTick(deps);
      now += 61_000;
    }
    expect(fileGiveUpEi).toHaveBeenCalledTimes(1);
    expect(fileGiveUpEi.mock.calls[0]![0]).toMatchObject({
      unit: 'papercup-mcp-proxy',
      restartsInWindow: GIVE_UP_THRESHOLD,
    });
    expect(fileGiveUpEi.mock.calls[0]![0].causeSuffix).toContain('bundle-host.sh');
    // The broadcast still fires too — filing is additive, never a replacement.
    const page = deps.notify.mock.calls.map((c) => c[0].summary as string).find((s) => s.includes('GIVING UP'));
    expect(page).toBeDefined();
  });

  it('EI-19966318801100410: fileGiveUpEi is best-effort — a rejection must not affect the give-up broadcast or throw out of reconcileTick', async () => {
    let now = 0;
    const fileGiveUpEi = vi.fn(async () => {
      throw new Error('PG unreachable');
    });
    const deps = makeDeps({ now: () => now, fileGiveUpEi });
    for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
      await reconcileTick(deps);
      now += 61_000;
    }
    await expect(reconcileTick(deps)).resolves.toBeDefined();
    expect(fileGiveUpEi).toHaveBeenCalledTimes(1);
    const page = deps.notify.mock.calls.map((c) => c[0].summary as string).find((s) => s.includes('GIVING UP'));
    expect(page).toBeDefined();
  });

  it('EI-19966318801100410: fileGiveUpEi is OPTIONAL — omitting it changes nothing (a give-up still broadcasts normally)', async () => {
    let now = 0;
    const deps = makeDeps({ now: () => now }); // no fileGiveUpEi override — makeDeps's base has none
    for (let i = 0; i < GIVE_UP_THRESHOLD; i++) {
      await reconcileTick(deps);
      now += 61_000;
    }
    await expect(reconcileTick(deps)).resolves.toBeDefined();
    const page = deps.notify.mock.calls.map((c) => c[0].summary as string).find((s) => s.includes('GIVING UP'));
    expect(page).toBeDefined();
  });

  it('EI-19966318801100410: a down -> healthy "recovered" transition auto-resolves the give-up EI via resolveGiveUpEi', async () => {
    let unitUp = false;
    const resolveGiveUpEi = vi.fn(async () => ['EI-1']);
    const upListUnits = LIST_UNITS_FIXTURE.replace(
      'papercup-mcp-proxy.service                       loaded failed   failed  Papercusp resilient MCP proxy',
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
    );
    const deps = makeDeps({
      resolveGiveUpEi,
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return unitUp ? upListUnits : LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\n';
        return '';
      }),
    });
    await reconcileTick(deps); // down tick — marks wasDown, restarts (not yet recovered)
    expect(resolveGiveUpEi).not.toHaveBeenCalled();
    unitUp = true;
    await reconcileTick(deps); // down -> healthy => 'recovered'
    expect(resolveGiveUpEi).toHaveBeenCalledWith({ unit: 'papercup-mcp-proxy' });
  });

  it('EI-19966318801100410: resolveGiveUpEi is OPTIONAL and best-effort — a recovery still notifies even if resolving throws or is omitted', async () => {
    let unitUp = false;
    const upListUnits = LIST_UNITS_FIXTURE.replace(
      'papercup-mcp-proxy.service                       loaded failed   failed  Papercusp resilient MCP proxy',
      'papercup-mcp-proxy.service                       loaded active   running Papercusp resilient MCP proxy',
    );
    const deps = makeDeps({
      resolveGiveUpEi: vi.fn(async () => {
        throw new Error('PG unreachable');
      }),
      execUser: vi.fn(async (args: string[]) => {
        if (args[0] === 'list-units') return unitUp ? upListUnits : LIST_UNITS_FIXTURE;
        if (args[0] === 'show') return 'Result=success\nNRestarts=0\n';
        return '';
      }),
    });
    await reconcileTick(deps);
    unitUp = true;
    await expect(reconcileTick(deps)).resolves.toBeDefined();
    const recoveredPage = deps.notify.mock.calls.map((c) => c[0].summary as string).find((s) => s.includes('recovered'));
    expect(recoveredPage).toBeDefined();
  });
});

// ── EI-20093844846536045: build-step failures are not permanent give-ups ─────

/**
 * The real 2026-08-10 shape: the unit never started because its ExecStartPre bundle step failed
 * to compile against a torn git-sync commit. `status=1/FAILURE` on a `Process:` line is what
 * separates this from the unit's own code dying.
 */
const CONTROL_PROCESS_CAUSE =
  'Process: 1694694 ExecStartPre=/srv/papercusp/apps/operator/bin/bundle-host.sh (code=exited, status=1/FAILURE)';

describe('isBuildStepFailure', () => {
  it('is TRUE for a failed control-process (ExecStartPre) line', () => {
    expect(isBuildStepFailure(CONTROL_PROCESS_CAUSE)).toBe(true);
  });

  it('is TRUE when the cause carries an appended build error (the shipped summarizer format)', () => {
    expect(isBuildStepFailure(`${CONTROL_PROCESS_CAUSE} — [ERROR] Expected "}" but found "s"`)).toBe(true);
  });

  it('is FALSE for a MAIN-process death — that IS a code fault and must still give up', () => {
    expect(isBuildStepFailure('Main process exited, code=exited, status=1/FAILURE')).toBe(false);
  });

  it('is FALSE for a SUCCESSFUL control process (status=0 is also reported on a Process: line)', () => {
    expect(isBuildStepFailure('Process: 123 ExecStartPre=/x/bundle-host.sh (code=exited, status=0/SUCCESS)')).toBe(
      false,
    );
  });

  it.each([null, undefined, '', 'Failed with result "exit-code".'])('is FALSE for %p', (cause) => {
    expect(isBuildStepFailure(cause as string | null | undefined)).toBe(false);
  });

  it('agrees with the cause SUMMARIZER — the two share one predicate and cannot drift', () => {
    const status = [
      '● papercup-staging-api.service - Papercusp staging API',
      '   Active: failed (Result=exit-code)',
      `  ${CONTROL_PROCESS_CAUSE}`,
      "   Failed with result 'exit-code'.",
    ].join('\n');
    const summarized = summarizeSystemctlStatusCause(status);
    expect(summarized).toContain('ExecStartPre');
    expect(isBuildStepFailure(summarized)).toBe(true);
  });
});

describe('reconcileTick — a build-step give-up is absorbed and retried, not latched', () => {
  beforeEach(() => {
    _resetReconcilerState();
  });

  /** Drives ticks on a controllable clock, always past the longest backoff. */
  function makeBuildStepDeps(statusCause: string) {
    let clock = 1_000_000;
    const execUser = vi.fn(async (args: string[]) => {
      if (args[0] === 'list-units') return LIST_UNITS_FIXTURE; // mcp-proxy is failed/failed here
      if (args[0] === 'show') return 'Result=exit-code\nNRestarts=0\n';
      if (args[0] === 'status') return ['● papercup-mcp-proxy.service', `  ${statusCause}`].join('\n');
      return '';
    });
    const notify = vi.fn(async () => {});
    const deps = {
      execUser,
      notify,
      now: () => clock,
      autoRestartFlagOn: async () => true,
      registry: () => [AUTORESTART_ENTRY],
      log: () => {},
    } as unknown as ReconcilerDeps & { execUser: ReturnType<typeof vi.fn>; notify: ReturnType<typeof vi.fn> };
    // 61s > the 60s ladder max, so backoff spacing never suppresses an attempt.
    const advance = () => {
      clock += 61_000;
    };
    return { deps, advance, execUser, notify };
  }

  const summaries = (notify: ReturnType<typeof vi.fn>) =>
    notify.mock.calls.map((c) => (c[0] as { summary: string }).summary);
  const callsFor = (execUser: ReturnType<typeof vi.fn>, verb: string) =>
    execUser.mock.calls.map((c) => c[0] as string[]).filter((a) => a[0] === verb);

  it("does NOT declare a code fault, clears systemd's latch, and keeps restarting", async () => {
    const { deps, advance, execUser, notify } = makeBuildStepDeps(CONTROL_PROCESS_CAUSE);
    for (let i = 0; i <= GIVE_UP_THRESHOLD; i++) {
      await reconcileTick(deps);
      advance();
    }

    const said = summaries(notify);
    expect(said.some((s) => s.includes('BUILD STEP failed'))).toBe(true);
    expect(said.some((s) => s.includes('NOT giving up'))).toBe(true);
    // The false verdict this whole change exists to stop.
    expect(said.some((s) => s.includes('this is a code fault not a transient'))).toBe(false);

    // The step that existed nowhere before: without it systemd refuses every later restart.
    expect(callsFor(execUser, 'reset-failed')).toContainEqual(['reset-failed', 'papercup-mcp-proxy']);

    // Not latched — it must still be trying after the give-up point.
    const before = callsFor(execUser, 'restart').length;
    await reconcileTick(deps);
    expect(callsFor(execUser, 'restart').length).toBeGreaterThan(before);
  });

  it('pages ONCE per episode, not on every retry cycle', async () => {
    const { deps, advance, notify } = makeBuildStepDeps(CONTROL_PROCESS_CAUSE);
    for (let i = 0; i < GIVE_UP_THRESHOLD * 3; i++) {
      await reconcileTick(deps);
      advance();
    }
    expect(summaries(notify).filter((s) => s.includes('BUILD STEP failed'))).toHaveLength(1);
  });

  it('EVENTUALLY gives up for real — patience is bounded, not infinite', async () => {
    const { deps, advance, notify } = makeBuildStepDeps(CONTROL_PROCESS_CAUSE);
    for (let i = 0; i < (GIVE_UP_THRESHOLD + 2) * (BUILD_STEP_RETRY_LIMIT + 2); i++) {
      await reconcileTick(deps);
      advance();
    }
    expect(summaries(notify).some((s) => s.includes('GIVING UP') && s.includes('retry cycles'))).toBe(true);
  });

  it('files NO give-up EI while absorbing — then files exactly one when patience runs out', async () => {
    const fileGiveUpEi = vi.fn(async (_e: SupervisionGiveUpEpisode): Promise<string | null> => 'EI-123');
    const { deps, advance } = makeBuildStepDeps(CONTROL_PROCESS_CAUSE);
    (deps as ReconcilerDeps).fileGiveUpEi = fileGiveUpEi;

    // One full give-up cycle: absorbed, so no durable EI — filing one for a self-clearing tree
    // break is the noise this policy exists to avoid.
    for (let i = 0; i <= GIVE_UP_THRESHOLD; i++) {
      await reconcileTick(deps);
      advance();
    }
    expect(fileGiveUpEi).not.toHaveBeenCalled();

    // But the unit must never end up permanently down with nobody owning it: once the budget is
    // spent, the normal durable filing happens exactly as before.
    for (let i = 0; i < (GIVE_UP_THRESHOLD + 2) * (BUILD_STEP_RETRY_LIMIT + 2); i++) {
      if (fileGiveUpEi.mock.calls.length > 0) break;
      await reconcileTick(deps);
      advance();
    }
    expect(fileGiveUpEi).toHaveBeenCalledTimes(1);
  });

  it('a MAIN-process failure still gives up immediately — the old behaviour is untouched', async () => {
    const { deps, advance, execUser, notify } = makeBuildStepDeps('Main process exited, code=exited, status=1/FAILURE');
    for (let i = 0; i <= GIVE_UP_THRESHOLD; i++) {
      await reconcileTick(deps);
      advance();
    }
    const said = summaries(notify);
    expect(said.some((s) => s.includes('this is a code fault not a transient'))).toBe(true);
    expect(said.some((s) => s.includes('BUILD STEP failed'))).toBe(false);
    expect(callsFor(execUser, 'reset-failed')).toHaveLength(0);
  });
});

/**
 * EI-20474047462811254 — an EPISODIC unit's run STARTING is not a RECOVERY.
 *
 * Measured live on `papercup-live-federation-gate` (2026-08-15/16): 12 consecutive
 * `✅ recovered` → `⚠ is down (report-only: entry.autoRestart:false)` broadcast PAIRS in 12
 * hours, one per hourly timer fire, not one of them a real transition. The journal pins the
 * mechanism to the second:
 *
 *   22:43:08Z  systemd: Starting papercup-live-federation-gate  (ActiveState=activating)
 *   22:43:57Z  reconciler: ✅ recovered          ← FALSE. A run merely started.
 *   22:44:15Z  systemd: Failed with result 'exit-code'
 *   22:44:58Z  reconciler: ⚠ is down
 *
 * The unit is `Type=oneshot` / `RemainAfterExit=no`, so it sits in `activating` for the WHOLE
 * run — and it budgets up to 4h (`TimeoutStartSec=14400`), so the false "recovered" can stand
 * for hours while the unit's last known result is a failure.
 *
 * WI-6149's `episodic` flag fixed the other half of this (idle `inactive` is not down); the
 * gap it left is that `decideReconcile` read "not faulted" as "recovered", which for a
 * timer-driven oneshot are different claims.
 */
describe('EI-20474047462811254: an episodic run IN FLIGHT carries no verdict', () => {
  const EPISODIC_ENTRY: SupervisionEntry = {
    name: 'live-federation-gate',
    layer: 'systemd-user',
    unit: 'papercup-live-federation-gate',
    criticality: 'important',
    autoRestart: false,
    episodic: true,
  };
  const st = (active: string): SystemctlUnitStatus => ({
    unit: 'papercup-live-federation-gate.service',
    load: 'loaded',
    active,
    sub: 'x',
    description: '',
  });
  /** Feed a sequence of ActiveStates through decideReconcile, threading flap state. */
  const run = (entry: SupervisionEntry, states: string[]) => {
    let state = initialFlapState(entry.unit!);
    const actions: ReconcileAction[] = [];
    let now = 1_000_000;
    for (const active of states) {
      const r = decideReconcile({ entry, status: st(active), show: undefined, state, autoRestartFlagOn: true, now });
      actions.push(r.action);
      state = r.nextState;
      now += 60_000; // the reconciler's real 60s cadence
    }
    return { actions, state };
  };

  it('isEpisodicRunInFlight covers the TRANSITIONAL states only — never a terminal verdict', () => {
    for (const s of ['activating', 'reloading', 'deactivating']) {
      expect(isEpisodicRunInFlight(s), `state=${s}`).toBe(true);
      expect(isSystemdTransitioning(s), `state=${s}`).toBe(true);
    }
    // `active` is deliberately excluded: for a oneshot with RemainAfterExit=yes it is the
    // terminal SUCCESS state, so calling it in-flight would suppress a REAL recovery.
    for (const s of ['active', 'inactive', 'failed']) {
      expect(isEpisodicRunInFlight(s), `state=${s}`).toBe(false);
      expect(isSystemdTransitioning(s), `state=${s}`).toBe(false);
    }
    expect(isEpisodicRunInFlight(undefined)).toBe(false);
    expect(isSystemdTransitioning(undefined)).toBe(false);
  });

  it('THE FLAP: failed -> activating -> failed emits no recovery and no duplicate down', () => {
    const { actions } = run(EPISODIC_ENTRY, ['failed', 'activating', 'failed']);

    // Tick 1 — the genuine failure. Notified once.
    expect(actions[0]).toEqual({ kind: 'report-only', unit: 'live-federation-gate', reason: 'down-report-only', notify: true });
    // Tick 2 — the run restarts. Pre-fix this was `{ kind: 'recovered' }` and broadcast
    // "✅ recovered" for a gate that was about to fail 18 seconds later.
    expect(actions[1]).toEqual({ kind: 'run-in-flight', unit: 'live-federation-gate' });
    // Tick 3 — the run failed. The unit never left the down state, so re-announcing it would be
    // the second half of the flap: `notify` must stay false.
    expect(actions[2]).toEqual({ kind: 'report-only', unit: 'live-federation-gate', reason: 'down-report-only', notify: false });
  });

  it('holds the previous DOWN state across the run rather than resetting it', () => {
    const { state } = run(EPISODIC_ENTRY, ['failed', 'activating']);
    // The hold is what makes both halves work: `wasDown` surviving the run is why the failure
    // above does not re-notify, and why the success below still reads as a transition.
    expect(state.wasDown).toBe(true);
    expect(state.healthySince).toBeNull();
    expect(state.consecutiveDownTicks).toBe(1); // held, not incremented by the in-flight tick
  });

  it('CALIBRATION: a run that actually SUCCEEDS still emits exactly one "recovered"', () => {
    // The failure direction that would make this fix worse than the bug — suppressing real
    // recoveries. `inactive` is a completed successful oneshot (RemainAfterExit=no).
    const { actions } = run(EPISODIC_ENTRY, ['failed', 'activating', 'inactive', 'inactive']);
    expect(actions[2]).toEqual({ kind: 'recovered', unit: 'live-federation-gate' });
    expect(actions.filter((a) => a.kind === 'recovered')).toHaveLength(1);
    expect(actions[3]).toEqual({ kind: 'healthy', unit: 'live-federation-gate' });
  });

  it('CALIBRATION: `active` (RemainAfterExit=yes) is a completed success, not an in-flight run', () => {
    const { actions } = run(EPISODIC_ENTRY, ['failed', 'active']);
    expect(actions[1]).toEqual({ kind: 'recovered', unit: 'live-federation-gate' });
  });

  it('CALIBRATION: a PERSISTENT unit also holds activating until the restart settles', () => {
    // A continuously-running service's `activating` state is a restart blip, not proof of a
    // recovered process. REPORT_ONLY_ENTRY is the same unit WITHOUT `episodic`.
    const { actions } = run(REPORT_ONLY_ENTRY, ['failed', 'activating']);
    expect(actions[1]).toEqual({ kind: 'waiting-transition', unit: 'live-federation-gate' });
  });

  it('END-TO-END: a full tick sequence over the live journal broadcasts nothing after the first down', async () => {
    _resetReconcilerState();
    let active = 'failed';
    // Typed with `notify`'s real signature so `calls[0].summary` is a checked `string` rather
    // than an index into a zero-length tuple.
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? `papercup-live-federation-gate.service loaded ${active} x Live 2-peer federation gate\n`
          : '',
      now: () => 1_000_000,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [EPISODIC_ENTRY],
      log: () => {},
    };

    await reconcileTick(deps); // failed      -> one honest "is down"
    active = 'activating';
    await reconcileTick(deps); // run starts  -> pre-fix: "✅ recovered"
    active = 'failed';
    await reconcileTick(deps); // run fails   -> pre-fix: "⚠ is down" again

    const said = notify.mock.calls.map((c) => c[0].summary);
    expect(said.filter((s) => s.includes('is down'))).toHaveLength(1);
    expect(said.some((s) => s.includes('recovered'))).toBe(false);
  });
});

/**
 * EI-21232345359778222 — a completed RUN is not a recovered CONDITION.
 *
 * EI-20474047462811254 (above) fixed the half where a run STARTING read as a recovery. This is
 * the half it left: a run FINISHING reads as one too, and for `papercup-live-federation-gate`
 * that is false — because the gate's exit code encodes whether the WINDOW had news, not the
 * verdict. Read at the writer, `papercusp-desktop/bin/live-federation-gate.sh`:
 *
 *   verdict "GATE: FRESH-RED (red ${RED_AGE_H}h ago — still red, already tracked; NOT a green)"; exit 0
 *
 * Exit **0**, with the line itself saying "NOT a green". `GATE: FRESH-DOWNGRADE (… not a
 * green)` exits 0 as well. So `inactive` (a completed successful oneshot) spans GREEN,
 * still-RED and downgraded alike.
 *
 * Measured 2026-08-23 04:34 EDT: the unit started, freshness-suppressed the unchanged tracked
 * red, emitted `GATE: FRESH-RED`, exited 0/inactive — and supervision broadcast
 * `✅ … recovered` while WI-40905 was still red and no content-matrix or K4 witness had rerun.
 * A reader acted on that all-clear and had to retract it. That retraction is the entire cost of
 * the word.
 *
 * The fix is a WEAKER CLAIM, not a new oracle: `decideReconcile` stays a pure, domain-agnostic
 * systemd reader and never learns to parse the gate's verdict bank. See
 * `SupervisionEntry.exitEncodesRunOnly`.
 */
describe('EI-21232345359778222: exit 0 from a verdict-bearing unit is a completed RUN, not a recovery', () => {
  const RUN_ONLY_ENTRY: SupervisionEntry = {
    name: 'live-federation-gate',
    layer: 'systemd-user',
    unit: 'papercup-live-federation-gate',
    criticality: 'important',
    autoRestart: false,
    episodic: true,
    exitEncodesRunOnly: true,
  };
  /** The SAME unit without the flag — the control for every over-application assertion below. */
  const PLAIN_EPISODIC_ENTRY: SupervisionEntry = { ...RUN_ONLY_ENTRY, exitEncodesRunOnly: undefined };

  const st = (active: string): SystemctlUnitStatus => ({
    unit: 'papercup-live-federation-gate.service',
    load: 'loaded',
    active,
    sub: 'x',
    description: '',
  });
  const run = (entry: SupervisionEntry, states: string[]) => {
    let state = initialFlapState(entry.unit!);
    const actions: ReconcileAction[] = [];
    let now = 1_000_000;
    for (const active of states) {
      const r = decideReconcile({ entry, status: st(active), show: undefined, state, autoRestartFlagOn: true, now });
      actions.push(r.action);
      state = r.nextState;
      now += 60_000;
    }
    return { actions, state };
  };

  it('THE BUG: FRESH-RED exit 0 (failed -> activating -> inactive) emits run-succeeded, never recovered', () => {
    const { actions } = run(RUN_ONLY_ENTRY, ['failed', 'activating', 'inactive']);
    expect(actions[1]).toEqual({ kind: 'run-in-flight', unit: 'live-federation-gate' });
    expect(actions[2]).toEqual({ kind: 'run-succeeded', unit: 'live-federation-gate' });
    expect(actions.some((a) => a.kind === 'recovered')).toBe(false);
  });

  it('THE BUG, at the broadcast: the summary states the run and DISCLAIMS the verdict', async () => {
    _resetReconcilerState();
    let active = 'failed';
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? `papercup-live-federation-gate.service loaded ${active} x Live 2-peer federation gate\n`
          : '',
      now: () => 1_000_000,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [RUN_ONLY_ENTRY],
      log: () => {},
    };

    await reconcileTick(deps); // a run FAILED  -> one honest down report
    active = 'activating';
    await reconcileTick(deps); // the next run starts (held — EI-20474047462811254)
    active = 'inactive';
    await reconcileTick(deps); // the run exits 0 on GATE: FRESH-RED

    const said = notify.mock.calls.map((c) => c[0].summary);
    // The word that cost a retraction must not appear on ANY of these broadcasts.
    expect(said.some((s) => s.includes('recovered'))).toBe(false);
    const up = said.find((s) => s.includes('last run exited 0'));
    expect(up).toBeDefined();
    // The disclaimer must ride IN the summary — a doc note does not reach the reader.
    expect(up).toContain('NOT a verdict');
    expect(up).toContain('read the verdict writer');
    // Both ends pair: the down message states the same run-level fact, not "is down".
    expect(said.some((s) => s.includes('last run exited NON-ZERO'))).toBe(true);
    expect(said.some((s) => s.includes('is down'))).toBe(false);
  });

  it('EI-21339603192900833: a SIGTERM-stopped run reports STOPPED, not "the RUN failed"', async () => {
    // An operator ran `systemctl stop` to swap the unit. systemd recorded
    // Result=exit-code / ExecMainStatus=143, and supervision announced a failure.
    _resetReconcilerState();
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? `papercup-live-federation-gate.service loaded failed x Live 2-peer federation gate\n`
          : 'Result=exit-code\nExecMainCode=exited\nExecMainStatus=143\nUnitFileState=enabled\nLoadState=loaded\n',
      now: () => 1_000_000,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [RUN_ONLY_ENTRY],
      log: () => {},
    };

    await reconcileTick(deps);

    const said = notify.mock.calls.map((c) => c[0].summary);
    expect(said.length).toBeGreaterThan(0);
    // The false accusation must be gone...
    expect(said.some((s) => s.includes('last run exited NON-ZERO'))).toBe(false);
    expect(said.some((s) => s.includes('is down'))).toBe(false);
    // ...replaced by what actually happened, naming the signal so a reader can verify it.
    const stopped = said.find((s) => s.includes('STOPPED by SIGTERM'));
    expect(stopped).toBeDefined();
    expect(stopped).toContain('exit 143');
    expect(stopped).toContain('NOT a failed run');
  });

  it('EI-21339603192900833: SIGKILL still alerts — the OOM signature must NOT be softened', async () => {
    // The failure direction that would make this fix worse than the bug: muting a real fault.
    // 137 = 128+9 is what the OOM killer leaves behind, and it must keep reading as a failure.
    _resetReconcilerState();
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? `papercup-live-federation-gate.service loaded failed x Live 2-peer federation gate\n`
          : 'Result=exit-code\nExecMainCode=exited\nExecMainStatus=137\nUnitFileState=enabled\nLoadState=loaded\n',
      now: () => 1_000_000,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [RUN_ONLY_ENTRY],
      log: () => {},
    };

    await reconcileTick(deps);

    const said = notify.mock.calls.map((c) => c[0].summary);
    expect(said.some((s) => s.includes('last run exited NON-ZERO'))).toBe(true);
    expect(said.some((s) => s.includes('STOPPED by'))).toBe(false);
  });

  it('EI-21339603192900833: signalTermination classifies both systemd and shell kill shapes', () => {
    // systemd killed it directly: status IS the signal number.
    expect(signalTermination({ execMainCode: 'killed', execMainStatus: 15 })).toEqual({
      status: 15,
      signal: 'SIGTERM',
    });
    // A shell relayed it: 128+signal. This is the shape the reported bug actually produced.
    expect(signalTermination({ execMainCode: 'exited', execMainStatus: 143 })).toEqual({
      status: 143,
      signal: 'SIGTERM',
    });
    expect(signalTermination({ execMainCode: 'exited', execMainStatus: 130 })).toEqual({
      status: 130,
      signal: 'SIGINT',
    });

    // NOT signals — these are ordinary failures and must stay failures.
    expect(signalTermination({ execMainCode: 'exited', execMainStatus: 1 })).toBeUndefined();
    expect(signalTermination({ execMainCode: 'exited', execMainStatus: 137 })).toBeUndefined(); // SIGKILL/OOM
    expect(signalTermination({ execMainCode: 'killed', execMainStatus: 9 })).toBeUndefined(); // SIGKILL/OOM
    expect(signalTermination({ execMainCode: 'exited', execMainStatus: 15 })).toBeUndefined(); // a real exit 15
    expect(signalTermination(undefined)).toBeUndefined();
    expect(signalTermination({ result: 'exit-code' })).toBeUndefined();
  });

  it('CALIBRATION: WITHOUT the flag the identical sequence still emits a real "recovered"', () => {
    // The failure direction that would make this fix worse than the bug — muting genuine
    // recoveries for every episodic unit. Same states, same unit, flag off.
    const { actions } = run(PLAIN_EPISODIC_ENTRY, ['failed', 'activating', 'inactive']);
    expect(actions[2]).toEqual({ kind: 'recovered', unit: 'live-federation-gate' });
    expect(actions.some((a) => a.kind === 'run-succeeded')).toBe(false);
  });

  it('CALIBRATION: the flag weakens the CLAIM only — the up-transition and its state reset are unchanged', () => {
    const flagged = run(RUN_ONLY_ENTRY, ['failed', 'activating', 'inactive', 'inactive']);
    const plain = run(PLAIN_EPISODIC_ENTRY, ['failed', 'activating', 'inactive', 'inactive']);
    // Identical damping/telemetry state: only the third action's KIND differs.
    expect(flagged.state).toEqual(plain.state);
    expect(flagged.state.wasDown).toBe(false);
    // And the transition fires exactly once, so a steady-state healthy unit stays silent.
    expect(flagged.actions[3]).toEqual({ kind: 'healthy', unit: 'live-federation-gate' });
    expect(flagged.actions.filter((a) => a.kind === 'run-succeeded')).toHaveLength(1);
  });

  it('CALIBRATION: a give-up EI still auto-resolves — that IS a run-level fact', async () => {
    _resetReconcilerState();
    let active = 'failed';
    const resolveGiveUpEi = vi.fn(async (_o: { unit: string }) => []);
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? `papercup-live-federation-gate.service loaded ${active} x Live 2-peer federation gate\n`
          : '',
      now: () => 1_000_000,
      notify: async () => {},
      autoRestartFlagOn: async () => true,
      registry: () => [RUN_ONLY_ENTRY],
      log: () => {},
      resolveGiveUpEi,
    };
    await reconcileTick(deps);
    active = 'inactive';
    await reconcileTick(deps);
    // A give-up EI records that SUPERVISION gave up restarting the unit. A completed run
    // settles that, whatever the subject's verdict — so weakening the notification must not
    // strand the EI (the EI-19966318801100410 orphan this would otherwise reintroduce).
    expect(resolveGiveUpEi).toHaveBeenCalledWith({ unit: 'papercup-live-federation-gate' });
  });
});

/**
 * EI-24811958626062774 — papercup-staging-sync exited FATAL on every tick for 5+ hours and
 * nothing said so. It fails in short self-clearing streaks most of the time (3 days: 30
 * streaks, 14 of them one run), so a first-tick alarm would be noise. `notifyAfterDownMs`
 * delays the report-only broadcast to a sustained episode and keeps short ones silent.
 */
describe('EI-24811958626062774: a delayed report-only alarm for a streaky episodic unit', () => {
  const MIN = 60_000;
  const DELAYED_ENTRY: SupervisionEntry = {
    name: 'staging-sync',
    layer: 'systemd-user',
    unit: 'papercup-staging-sync',
    criticality: 'important',
    autoRestart: false,
    episodic: true,
    notifyAfterDownMs: 30 * MIN,
  };
  const st = (active: string): SystemctlUnitStatus => ({
    unit: 'papercup-staging-sync.service',
    load: 'loaded',
    active,
    sub: 'x',
    description: '',
  });
  /** One ActiveState per 60s tick, threading flap state exactly as reconcileTick does. */
  const run = (entry: SupervisionEntry, states: string[]) => {
    let state = initialFlapState(entry.unit!);
    const actions: ReconcileAction[] = [];
    let now = 1_000_000;
    for (const active of states) {
      const r = decideReconcile({ entry, status: st(active), show: undefined, state, autoRestartFlagOn: true, now });
      actions.push(r.action);
      state = r.nextState;
      now += MIN;
    }
    return { actions, state };
  };
  const notified = (actions: ReconcileAction[]) =>
    actions.flatMap((a, i) => (a.kind === 'report-only' && a.notify ? [i] : []));

  it('stays silent until the episode reaches the threshold, then announces exactly once', () => {
    const { actions } = run(DELAYED_ENTRY, Array(45).fill('failed'));
    // Tick 0 starts the clock; tick 30 is the first observation 30 min into the episode.
    expect(notified(actions)).toEqual([30]);
    expect(actions[30]).toMatchObject({ kind: 'report-only', reason: 'down-report-only', notify: true, downForMs: 30 * MIN });
    expect(actions[0]).toMatchObject({ kind: 'report-only', notify: false, downForMs: 0 });
  });

  it('a streak that clears before the threshold produces NO broadcast at either end', () => {
    // fail, re-run, fail, re-run, succeed: the 1-3 run streaks that are most of the history.
    const states = [...Array(5).fill('failed'), 'activating', ...Array(4).fill('failed'), 'activating', 'inactive', 'inactive'];
    const { actions, state } = run(DELAYED_ENTRY, states);
    expect(notified(actions)).toEqual([]);
    // The up-transition of an unannounced episode is not a recovery anyone was waiting for.
    expect(actions.some((a) => a.kind === 'recovered' || a.kind === 'run-succeeded')).toBe(false);
    expect(actions[11]).toEqual({ kind: 'healthy', unit: 'staging-sync' });
    expect(state.downSince).toBeNull();
    expect(state.downNotified).toBe(false);
  });

  it('CALIBRATION: an announced episode still ends in exactly one "recovered"', () => {
    const { actions } = run(DELAYED_ENTRY, [...Array(31).fill('failed'), 'activating', 'inactive', 'inactive']);
    expect(notified(actions)).toEqual([30]);
    expect(actions[32]).toEqual({ kind: 'recovered', unit: 'staging-sync' });
    expect(actions.filter((a) => a.kind === 'recovered')).toHaveLength(1);
  });

  it('the clock spans runs in flight: a long failing run does not restart it', () => {
    // One failed tick, then a 40-minute run that also fails. The episode is 41 min old.
    const { actions } = run(DELAYED_ENTRY, ['failed', ...Array(40).fill('activating'), 'failed']);
    expect(notified(actions)).toEqual([41]);
    expect(actions[41]).toMatchObject({ downForMs: 41 * MIN });
  });

  it('a second episode after a recovery gets a fresh clock and its own single alarm', () => {
    const states = [...Array(31).fill('failed'), 'inactive', ...Array(31).fill('failed')];
    const { actions } = run(DELAYED_ENTRY, states);
    expect(notified(actions)).toEqual([30, 62]);
  });

  it('CALIBRATION: an entry WITHOUT the field keeps first-tick notify and its exact action shape', () => {
    const plain: SupervisionEntry = { ...DELAYED_ENTRY, notifyAfterDownMs: undefined };
    const { actions } = run(plain, ['failed', 'failed', 'inactive']);
    expect(actions[0]).toEqual({ kind: 'report-only', unit: 'staging-sync', reason: 'down-report-only', notify: true });
    expect(actions[2]).toEqual({ kind: 'recovered', unit: 'staging-sync' });
  });

  it("signalTermination: systemd's own start-timeout SIGTERM is a failure, not an intentional stop", () => {
    expect(signalTermination({ result: 'timeout', execMainCode: 'killed', execMainStatus: 15 })).toBeUndefined();
    // CALIBRATION: an operator's `systemctl stop` (Result=signal) is still recognised as a stop.
    expect(signalTermination({ result: 'signal', execMainCode: 'killed', execMainStatus: 15 })).toEqual({ status: 15, signal: 'SIGTERM' });
  });

  // Shaped like the real `systemctl --user status papercup-staging-sync --lines=200` on
  // 2026-10-01: older runs (pids 101/202) printed an npm echo and a different FATAL; the run
  // that just failed (pid 1118840) printed the actionable FATAL.
  const STATUS_FIXTURE = [
    '× papercup-staging-sync.service - Papercusp staging tier auto-sync',
    '     Loaded: loaded (/home/u/.config/systemd/user/papercup-staging-sync.service; static)',
    '     Active: failed (Result: exit-code) since Thu 2026-10-01 17:34:26 EDT; 1min ago',
    '    Process: 1118840 ExecStart=/usr/bin/bash /x/papercusp-script-snapshot.sh /x/sync-staging-checkout.sh (code=exited, status=1/FAILURE)',
    '   Main PID: 1118840 (code=exited, status=1/FAILURE)',
    'Oct 01 16:10:02 host bash[101]: > node -e "const { spawnSync } = require(\'node:child_process\'); if (e.code === \'ERR_MODULE_NOT_FOUND\') throw new TypeError(\'x\')"',
    'Oct 01 16:16:06 host bash[202]: [staging-sync] 2026-10-01T16:16:06-04:00 FATAL: coordinated dev:restart was refused',
    'Oct 01 17:34:26 host bash[1118840]: [staging-sync] 2026-10-01T17:34:26-04:00 FATAL: papercusp-staging-api.service WorkingDirectory must follow the stable staging alias',
    "Oct 01 17:34:26 host systemd[4082]: papercup-staging-sync.service: Failed with result 'exit-code'.",
  ].join('\n');

  it('the failure detail comes from the run that failed, not the oldest run or an npm echo', () => {
    const cause = summarizeSystemctlStatusCause(STATUS_FIXTURE);
    expect(cause).toContain('WorkingDirectory must follow the stable staging alias');
    expect(cause).not.toContain('node -e');
    expect(cause).not.toContain('dev:restart was refused');
  });

  it('scopeToFailedProcess only narrows: no pid, or no tagged line, returns the excerpt unchanged', () => {
    expect(scopeToFailedProcess(STATUS_FIXTURE, undefined)).toBe(STATUS_FIXTURE);
    expect(scopeToFailedProcess(STATUS_FIXTURE, 'Process: 999 ExecStart=/x (code=exited, status=1/FAILURE)')).toBe(STATUS_FIXTURE);
    expect(scopeToFailedProcess(STATUS_FIXTURE, 'Process: 1118840 ExecStart=/x (code=exited, status=1/FAILURE)').split('\n')).toHaveLength(1);
  });

  it('END-TO-END: 31 failed minutes on reconcileTick broadcast once, with duration and cause', async () => {
    _resetReconcilerState();
    let now = 1_000_000;
    const notify = vi.fn(async (_opts: { summary: string; kind?: 'message' | 'escalation'; category?: string }) => {});
    const deps: ReconcilerDeps = {
      execUser: async (args: string[]) =>
        args[0] === 'list-units'
          ? 'papercup-staging-sync.service loaded failed failed Papercusp staging tier auto-sync\n'
          : args[0] === 'status'
            ? STATUS_FIXTURE
            : '',
      now: () => now,
      notify,
      autoRestartFlagOn: async () => true,
      registry: () => [DELAYED_ENTRY],
      log: () => {},
    };
    for (let i = 0; i <= 31; i += 1) {
      await reconcileTick(deps);
      now += MIN;
    }
    const said = notify.mock.calls.map((c) => c[0].summary).filter((s) => s.includes('papercup-staging-sync'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('has been down for 30min');
    expect(said[0]).toContain('WorkingDirectory must follow the stable staging alias');
  });
});
