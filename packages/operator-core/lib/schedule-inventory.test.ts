import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectScheduleInventory,
  humanInterval,
  summarizeInventory,
  EXTERNAL_PROCESS_TIMERS,
  SYNC_TRIGGERED_SWEEPS,
  SCHEDULE_SOURCES,
  collectStartupActivity,
  scheduleStartupFeature,
  checkStartupActivityCensus,
  STARTUP_ACTIVITY_ENTRYPOINTS,
  type ScheduleInventoryDeps,
  type ScheduleInventoryRow,
  type StartupActivityFeature,
  type RoutineRow,
} from './schedule-inventory';
import type { DbosScheduledEntry } from './dbos/dbos-schedule-introspect';
import { EXTERNAL_SCHEDULES, SYNC_TRIGGERED_SCHEDULES } from './schedule-descriptors.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — pure JS guard script, no .d.ts; imported for its allow/baseline sets only.
import { BASELINE, ALLOWLIST, ALLOWLIST_DIRS } from '../../../scripts/check-no-raw-setinterval.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sourceText = (repoRelativePath: string): string =>
  readFileSync(resolve(REPO_ROOT, repoRelativePath), 'utf8');

const dbos = (over: Partial<DbosScheduledEntry> = {}): DbosScheduledEntry => ({
  name: 'telemetryFlush',
  crontab: '0 0 * * * *',
  mode: 'ExactlyOncePerIntervalWhenActive',
  queueName: null,
  lastFireMs: null,
  lastStatus: null,
  ...over,
});

const routine = (over: Partial<RoutineRow> = {}): RoutineRow => ({
  install_slug: 'system',
  name: 'git-sync',
  trigger_kind: 'cron',
  trigger_config: { cron: '*/2 * * * *' },
  target_role: 'system',
  active: true,
  next_fire_at: null,
  last_fired_at: null,
  metadata: null,
  // WI-5217: RoutineRow.group_slug (WI-5018) is a required field this factory
  // predates — default to null (ungrouped), overridable via `over`.
  group_slug: null,
  ...over,
});

const emptyInventory: ScheduleInventoryDeps = {
  getDbosSchedules: async () => [], getRoutines: async () => [], getManaged: () => [],
  getInProcessChecks: () => ({ checks: [], armed: false }), getExternalProcess: () => [],
  getSiblingManaged: async () => [], enrichSiblingDbos: async () => [], getSyncTriggered: () => [],
};

const startupRow = (over: Partial<ScheduleInventoryRow> = {}): ScheduleInventoryRow => ({
  source: 'dbos', scope: 'operator', tier: 'durable', category: 'dbos-scheduled',
  name: 'registered-work', installSlug: null, cadence: 'every minute', armed: true,
  lastFire: null, nextFire: null, lastError: null, groupSlug: null, detail: {}, ...over,
});

describe('startup activity disclosure', () => {
  it('distinguishes configured startup from observed running state', () => {
    const registered = scheduleStartupFeature(startupRow({ detail: { lastStatus: 'SUCCESS', running: true } }));
    expect(registered.observed).toBe('unknown');
    expect(registered.desired.automatic).toBeNull();
    const activeRoutine = scheduleStartupFeature(startupRow({ source: 'routines', armed: true }));
    expect(activeRoutine.desired.automatic).toBe(true);
    expect(activeRoutine.observed).toBe('unknown');
    const managed = scheduleStartupFeature(startupRow({ source: 'managed', detail: { running: false } }));
    expect(managed.observed).toBe('idle');
    expect(managed.desired.automatic).toBeNull();
    expect(scheduleStartupFeature(startupRow({ source: 'managed', detail: { running: true } })).observed).toBe('running');
    expect(scheduleStartupFeature(startupRow({ source: 'external-process', detail: { running: true, federated: false } })).observed).toBe('unknown');
  });

  it('keeps unavailable resource and cost measurements unknown even for a free handler', () => {
    const feature = scheduleStartupFeature(startupRow({ source: 'routines', detail: { targetRole: 'system:wake-brain' } }));
    expect(feature.spend).toBe('none');
    expect(feature.resources).toEqual({ cpuUsec: null, rssBytes: null, costCents: null });
    expect(feature.network).toBe('unknown');
    expect(scheduleStartupFeature(startupRow({ name: 'expensive-agent-looking-name' })).spend).toBe('unknown');
  });

  it('preserves required disclosure fields and source-specific feature identity', () => {
    const feature = scheduleStartupFeature(startupRow({ source: 'routines', installSlug: 'harness-a', name: 'doc-refresh' }), { workspaceId: 'workspace-a' });
    expect(feature).toMatchObject({ name: 'doc refresh', origin: 'routines', scope: { kind: 'workspace', id: 'workspace-a' },
      dependencies: null, trigger: 'every minute', network: 'unknown', desired: { revision: null, pausedUntil: null } });
    expect(feature.purpose).toContain('not been described');
    expect(feature.id).not.toBe(scheduleStartupFeature(startupRow({ source: 'routines', installSlug: 'harness-a', name: 'doc-refresh' }), { workspaceId: 'workspace-b' }).id);
    expect(feature.id).not.toContain('doc-refresh');
    const row = startupRow({ source: 'routines', installSlug: 'harness-a', name: 'doc-refresh' });
    expect(scheduleStartupFeature(row, { workspaceId: 'workspace-a', deviceId: 'desktop-a' }).id)
      .toBe(scheduleStartupFeature(row, { workspaceId: 'workspace-a', deviceId: 'desktop-b' }).id);
    expect(scheduleStartupFeature({ ...row, source: 'managed' }, { workspaceId: 'workspace-a', deviceId: 'desktop-a' }).id)
      .not.toBe(scheduleStartupFeature({ ...row, source: 'managed' }, { workspaceId: 'workspace-a', deviceId: 'desktop-b' }).id);
  });

  it('retains failed sources as unavailable without leaking their errors or asserting an empty complete inventory', async () => {
    const snapshot = await collectStartupActivity({ ...emptyInventory,
      getRoutines: async () => { throw new Error('credential=secret'); },
      getManaged: () => { throw new Error('private path'); },
      getSiblingManaged: async () => { throw new Error('private URL'); },
    });
    expect(snapshot.unavailable).toEqual(['census', 'federation', 'history', 'managed', 'native', 'policy', 'routines']);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(JSON.stringify(snapshot)).not.toContain('private');
    const empty = await collectStartupActivity(emptyInventory, { native: async () => [], policy: async () => null, history: async () => [] });
    expect(empty.unavailable).toEqual(['census']);
    expect(empty.census.complete).toBe(false);
    expect(empty.census.problems).toContain('missing:native-login');
  });

  it('reads saved policy independently of a measured in-flight invocation', async () => {
    let historyId = '';
    const snapshot = await collectStartupActivity({ ...emptyInventory, getRoutines: async () => [routine()] }, {
      native: async () => [],
      policy: async () => ({ automatic: false, pausedUntil: null, revision: 7 }),
      history: async (ids, limit) => {
        expect(ids).toHaveLength(1); historyId = ids[0]!; expect(limit).toBe(100); return [];
      },
    });
    expect(snapshot.features[0]!.desired.automatic).toBe(false);
    expect(snapshot.features[0]!.observed).toBe('unknown');
    expect(historyId).toBe(snapshot.features[0]!.id);
    expect(snapshot.unavailable).toEqual(['census']);
  });

  it('bounds history, excludes foreign feature records and strips undeclared nested fields', async () => {
    const snapshot = await collectStartupActivity({ ...emptyInventory, getRoutines: async () => [routine()] }, {
      native: async () => [], policy: async () => ({ automatic: false, pausedUntil: null, revision: 2 }),
      history: async (ids) => [
        { featureId: ids[0]!, operation: 'policy-change', status: 'completed', at: '2026-11-02T08:00:00.000Z',
          actor: 'user:opaque-id', trigger: 'settings', previous: null,
          resulting: { automatic: false, pausedUntil: null, revision: 2, command: 'secret' }, error: 'secret' },
        { featureId: 'another-workspace', operation: 'start', status: 'running', at: '2026-11-02T08:00:00.000Z',
          actor: 'user:opaque-id', trigger: 'timer', previous: null, resulting: null },
      ],
    });
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.history[0]!.resulting).toEqual({ automatic: false, pausedUntil: null, revision: 2 });
    expect(JSON.stringify(snapshot.history)).not.toContain('secret');
    expect(snapshot.unavailable).toContain('history');
    const bounded = await collectStartupActivity({ ...emptyInventory, getRoutines: async () => [routine()] }, {
      history: async ids => Array.from({ length: 101 }, () => ({ featureId: ids[0]!, operation: 'start', status: 'completed',
        at: '2026-11-02T08:00:00.000Z', actor: 'system:opaque-id', trigger: 'timer', previous: null, resulting: null })),
    });
    expect(bounded.history).toHaveLength(100);
  });
});

describe('startup entrypoint census', () => {
  it('returns the versioned census with the actual snapshot and fails an omitted installed entry', async () => {
    const native: StartupActivityFeature[] = STARTUP_ACTIVITY_ENTRYPOINTS.filter(entry => !('notApplicableReason' in entry))
      .map(entry => ({ ...scheduleStartupFeature(startupRow()), id: entry.id, origin: 'native', entrypointIds: [entry.id] }));
    const complete = await collectStartupActivity({ ...emptyInventory, getRoutines: async () => [routine()] }, {
      native: async () => native,
      census: async features => STARTUP_ACTIVITY_ENTRYPOINTS.filter(entry => !('notApplicableReason' in entry))
        .map(entry => ({ id: entry.id, kind: 'checked', featureIds: features.filter(feature => feature.entrypointIds.includes(entry.id)).map(feature => feature.id) })),
    });
    expect(complete.census).toMatchObject({ version: 1, complete: true, problems: [] });
    const omitted = await collectStartupActivity(emptyInventory, { census: async () => [] });
    expect(omitted.census.complete).toBe(false);
    expect(omitted.census.dispositions.filter(entry => entry.kind === 'not-applicable')).toHaveLength(3);
    expect(omitted.census.problems).toContain('missing:managed-fire-on-arm');
  });
  it('pins actual native writers and consumes the existing timer and sync descriptors', () => {
    for (const entry of STARTUP_ACTIVITY_ENTRYPOINTS) expect(sourceText(entry.writer), entry.id).toContain(entry.witness);
    const writers = new Set(STARTUP_ACTIVITY_ENTRYPOINTS.map(entry => entry.writer));
    for (const dir of ['systemd', 'launchd', 'deb']) {
      const base = `papercusp-desktop/src-tauri/${dir}`;
      for (const file of readdirSync(resolve(REPO_ROOT, base)).filter(file => /(?:\.service|\.sh|\.plist\.template)$/.test(file)))
        expect(writers.has(`${base}/${file}`), `unregistered native startup writer ${file}`).toBe(true);
    }
    const population = STARTUP_ACTIVITY_ENTRYPOINTS.map(entry => entry.id);
    const dispositions = STARTUP_ACTIVITY_ENTRYPOINTS.map(entry => 'notApplicableReason' in entry
      ? { id: entry.id, kind: 'not-applicable' as const, reason: entry.notApplicableReason }
      : { id: entry.id, kind: 'checked' as const, featureIds: [entry.id] });
    const features = population.map(id => ({ id, entrypointIds: [id] }));
    expect(checkStartupActivityCensus(population, dispositions, features).complete).toBe(true);
    expect(checkStartupActivityCensus(population, dispositions.slice(1), features).complete).toBe(false);
  });
  it('requires the entire independently discovered writer population exactly once', () => {
    const population = ['native-login', 'boot-service', 'event-dispatch', 'managed-fire-on-arm', 'sync-trigger'];
    const dispositions = population.map(id => ({ id, kind: 'checked' as const, featureIds: [id] }));
    const features = population.map(id => ({ id, entrypointIds: [id] }));
    expect(checkStartupActivityCensus(population, dispositions, features).complete).toBe(true);
    expect(checkStartupActivityCensus(population, dispositions.slice(1), features)).toEqual({ complete: false, problems: ['missing:native-login'] });
    expect(checkStartupActivityCensus(population, [...dispositions, dispositions[0]!], features).problems).toContain('duplicate:native-login');
    expect(checkStartupActivityCensus(population, dispositions, features.slice(1)).problems).toContain('unrepresented:native-login');
    expect(checkStartupActivityCensus(population, dispositions, features.map(feature => ({ ...feature, entrypointIds: ['unrelated'] }))).problems).toContain('wrong-writer:native-login');
  });

  it('requires reasons and accountable residue rather than silently exempting undisclosed features', () => {
    expect(checkStartupActivityCensus(['native'], [{ id: 'native', kind: 'not-applicable', reason: '' }], []).complete).toBe(false);
    expect(checkStartupActivityCensus(['native'], [{ id: 'native', kind: 'residue', workItemId: 'EI-123', owner: '' }], []).complete).toBe(false);
    expect(checkStartupActivityCensus(['native'], [{ id: 'native', kind: 'not-applicable', reason: 'Registration is not installed on the observed device.' }], []).complete).toBe(true);
  });
});

describe('humanInterval', () => {
  it('formats seconds, minutes, hours', () => {
    expect(humanInterval(30_000)).toBe('every 30s');
    expect(humanInterval(120_000)).toBe('every 2m');
    expect(humanInterval(3_600_000)).toBe('every 1h');
  });
});

describe('collectScheduleInventory', () => {
  it('unions DBOS + routines + in-process into one tier-tagged row shape', async () => {
    const rows = await collectScheduleInventory({
      // EI-19445595198254637: the sibling-federation seam is a NETWORK default, so
      // every unit test must stub it — otherwise a dev box with live sibling
      // operators (bg-host/staging) injects real rows and these assertions go
      // non-deterministic. Federation itself is covered in schedule-federation.test.ts
      // and in the dedicated cases at the bottom of this file.
      getSiblingManaged: async () => [],
      getDbosSchedules: async () => [dbos({ name: 'backupCadence', crontab: '0 * * * * *', lastFireMs: 1_700_000_000_000 })],
      getRoutines: async () => [routine({ name: 'green-checkpoint', active: false, metadata: { last_error: 'boom' } })],
      getManaged: () => [],
      getInProcessChecks: () => ({
        checks: [{ name: 'system-health', intervalMs: 30_000, shed: true }],
        armed: true,
      }),
      getExternalProcess: () => [], // this test asserts the dbos/routines/in-process union only
      getSyncTriggered: () => [], // sync-triggered sweeps have their own test below
    });

    expect(rows).toHaveLength(3);

    const d = rows.find((r) => r.source === 'dbos')!;
    expect(d).toMatchObject({ tier: 'durable', category: 'dbos-scheduled', cadence: '0 * * * * *', armed: true });
    expect(d.lastFire).toBe(new Date(1_700_000_000_000).toISOString());

    const r = rows.find((r) => r.source === 'routines')!;
    expect(r).toMatchObject({
      tier: 'durable',
      category: 'routine',
      installSlug: 'system',
      cadence: '*/2 * * * *',
      armed: false,
      lastError: 'boom',
    });

    const ip = rows.find((r) => r.source === 'in-process')!;
    expect(ip).toMatchObject({ tier: 'ephemeral', category: 'global-sweep', cadence: 'every 30s', armed: true });
    expect(ip.detail).toMatchObject({ intervalMs: 30_000, shed: true });
  });

  it('collects only sources needed for a filtered DBOS lookup while preserving federated DBOS rows', async () => {
    const calls: string[] = [];
    const rows = await collectScheduleInventory(
      {
        getDbosSchedules: async () => {
          calls.push('dbos');
          return [];
        },
        getRoutines: async () => {
          calls.push('routines');
          return [routine()];
        },
        getSiblingManaged: async () => {
          calls.push('siblings');
          return [
            {
              port: 3271,
              pid: 42,
              label: 'bg-host:3271',
              process: 'bg-host',
              ok: true,
              timers: [],
              dbosSchedules: [
                {
                  name: 'sessionSearchIndexBuild',
                  crontab: '0 7,22,37,52 * * * *',
                  mode: 'ExactlyOncePerIntervalWhenActive',
                  queueName: null,
                },
              ],
              stallWaker: null,
              elapsedMs: 1,
            },
          ];
        },
        enrichSiblingDbos: async (schedules) =>
          schedules.map((entry) => ({ ...entry, lastFireMs: null, lastStatus: null })),
        getManaged: () => {
          calls.push('managed');
          return [];
        },
        getInProcessChecks: () => {
          calls.push('in-process');
          return { checks: [], armed: false };
        },
        getExternalProcess: () => {
          calls.push('external-process');
          return [];
        },
        getSyncTriggered: () => {
          calls.push('sync-triggered');
          return [];
        },
      },
      { source: 'dbos', name: 'sessionSearchIndexBuild' },
    );

    expect(calls.sort()).toEqual(['dbos', 'siblings']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'dbos',
      name: 'sessionSearchIndexBuild',
      detail: { federated: true, process: 'bg-host:3271' },
    });
  });

  it('is fail-soft per source — one source throwing yields its empty slice, not a thrown inventory', async () => {
    const rows = await collectScheduleInventory({
      // EI-19445595198254637: the sibling-federation seam is a NETWORK default, so
      // every unit test must stub it — otherwise a dev box with live sibling
      // operators (bg-host/staging) injects real rows and these assertions go
      // non-deterministic. Federation itself is covered in schedule-federation.test.ts
      // and in the dedicated cases at the bottom of this file.
      getSiblingManaged: async () => [],
      getDbosSchedules: async () => {
        throw new Error('dbos down');
      },
      getRoutines: async () => {
        throw new Error('pg down');
      },
      getManaged: () => [],
      getInProcessChecks: () => ({ checks: [{ name: 'service-health', intervalMs: 60_000 }], armed: false }),
      getExternalProcess: () => [],
      getSyncTriggered: () => [],
    });
    expect(rows.map((r) => r.source)).toEqual(['in-process']);
    expect(rows[0].armed).toBe(false);
  });

  it('lists external-process timers (P-014) as source=external-process, per-process, with fire-state null', async () => {
    const rows = await collectScheduleInventory({
      // EI-19445595198254637: the sibling-federation seam is a NETWORK default, so
      // every unit test must stub it — otherwise a dev box with live sibling
      // operators (bg-host/staging) injects real rows and these assertions go
      // non-deterministic. Federation itself is covered in schedule-federation.test.ts
      // and in the dedicated cases at the bottom of this file.
      getSiblingManaged: async () => [],
      getDbosSchedules: async () => [],
      getRoutines: async () => [],
      getManaged: () => [],
      getInProcessChecks: () => ({ checks: [], armed: false }),
      getExternalProcess: () => [
        { process: 'inference-gateway', name: 'gw-self-heal', cadence: 'every ~10s', source: 'inference-gateway/gateway.ts' },
        { process: 'psu-launcher', name: 'psu-supervisor-heartbeat', cadence: 'every ~60s', source: 'apps/operator/scripts/psu-launcher.mjs' },
      ],
      getSyncTriggered: () => [],
    });
    expect(rows.map((r) => r.source)).toEqual(['external-process', 'external-process']);
    const gw = rows.find((r) => r.name === 'gw-self-heal')!;
    expect(gw).toMatchObject({
      source: 'external-process',
      category: 'external-process',
      tier: 'ephemeral',
      cadence: 'every ~10s',
      armed: null, // live fire-state requires federation (the follow-on)
      lastFire: null,
    });
    expect(gw.detail).toMatchObject({ process: 'inference-gateway', source: 'inference-gateway/gateway.ts' });
  });

  /**
   * The owner asked, of the Docs pane, "what about the routine that checks for
   * drifted documentation?" — and was right: it ran after every git-sync while
   * appearing in no inventory and no pane, because it is neither a routines row
   * nor a timer. These rows are how a sync-triggered sweep gets an identity.
   */
  it('lists sync-triggered sweeps, splitting free DETECTION from the agent-spawning REPAIR', async () => {
    const rows = await collectScheduleInventory({
      // EI-19445595198254637: the sibling-federation seam is a NETWORK default, so
      // every unit test must stub it — otherwise a dev box with live sibling
      // operators (bg-host/staging) injects real rows and these assertions go
      // non-deterministic. Federation itself is covered in schedule-federation.test.ts
      // and in the dedicated cases at the bottom of this file.
      getSiblingManaged: async () => [],
      getDbosSchedules: async () => [],
      getRoutines: async () => [],
      getManaged: () => [],
      getInProcessChecks: () => ({ checks: [], armed: false }),
      getExternalProcess: () => [],
      getSyncTriggered: () => [
        { name: 'doc-freshness-sweep', cadence: 'after each git-sync', armed: true, source: 'a.ts', spends: 'none', note: 'free' },
        { name: 'doc-steward-dispatch', cadence: 'after each git-sync', armed: false, flag: 'papercusp-doc-steward', source: 'b.ts', spends: 'llm', note: 'spawns' },
      ],
    });
    expect(rows.map((r) => r.name)).toEqual(['doc-freshness-sweep', 'doc-steward-dispatch']);
    expect(rows.every((r) => r.source === 'in-process' && r.category === 'sync-triggered')).toBe(true);
    // Detection is unconditional; repair reports the flag's real state. A
    // dark-flagged agent-spawner must never read as armed.
    expect(rows.find((r) => r.name === 'doc-freshness-sweep')!.armed).toBe(true);
    const repair = rows.find((r) => r.name === 'doc-steward-dispatch')!;
    expect(repair.armed).toBe(false);
    expect(repair.detail).toMatchObject({ flag: 'papercusp-doc-steward' });
  });

  it('the DEFAULT sync-triggered manifest carries the doc drift pipeline', async () => {
    // Guards the hole itself: if someone drops these from the manifest, the doc
    // drift sweep goes invisible again exactly as the owner found it.
    expect(SYNC_TRIGGERED_SWEEPS.map((s) => s.name)).toEqual([
      'doc-freshness-sweep',
      'doc-steward-dispatch',
    ]);
    // The repair half must stay flag-resolved, never hardcoded armed.
    const repair = SYNC_TRIGGERED_SWEEPS.find((s) => s.name === 'doc-steward-dispatch')!;
    expect(repair.armed).toBeNull();
    expect(repair.flag).toBe('papercusp-doc-steward');
  });

  it('the DEFAULT external-process manifest covers the gateway + watchdog + psu-launcher (D-007)', async () => {
    const rows = await collectScheduleInventory({
      // EI-19445595198254637: the sibling-federation seam is a NETWORK default, so
      // every unit test must stub it — otherwise a dev box with live sibling
      // operators (bg-host/staging) injects real rows and these assertions go
      // non-deterministic. Federation itself is covered in schedule-federation.test.ts
      // and in the dedicated cases at the bottom of this file.
      getSiblingManaged: async () => [],
      getDbosSchedules: async () => [],
      getRoutines: async () => [],
      getManaged: () => [],
      getInProcessChecks: () => ({ checks: [], armed: false }),
      // no getExternalProcess → the default EXTERNAL_PROCESS_TIMERS manifest is used
    });
    const ext = rows.filter((r) => r.source === 'external-process');
    expect(ext.length).toBeGreaterThanOrEqual(6);
    const processes = new Set(ext.map((r) => (r.detail as { process: string }).process));
    expect(processes).toEqual(
      new Set(['inference-gateway', 'gateway-watchdog', 'mcp-proxy-watchdog', 'bg-host-watchdog', 'psu-launcher']),
    );
  });

  it('surfaces live managed timers as source=managed with real fire times, deduping the static in-process fallback', async () => {
    const rows = await collectScheduleInventory({
      // EI-19445595198254637: the sibling-federation seam is a NETWORK default, so
      // every unit test must stub it — otherwise a dev box with live sibling
      // operators (bg-host/staging) injects real rows and these assertions go
      // non-deterministic. Federation itself is covered in schedule-federation.test.ts
      // and in the dedicated cases at the bottom of this file.
      getSiblingManaged: async () => [],
      getDbosSchedules: async () => [],
      getRoutines: async () => [],
      getManaged: () => [
        {
          name: 'system-health',
          category: 'global-sweep',
          intervalMs: 30_000,
          armedAt: 10,
          lastFireAt: 1_700_000_000_000,
          lastError: null,
          running: true,
          runningSince: 1_700_000_000_000,
          skippedWhileRunning: 4,
          instanced: false,
          instances: 1,
          fires: 5,
          shed: true,
          classification: null,
        },
        {
          name: 'engine-death-sentinel',
          category: 'watchdog',
          intervalMs: 300_000,
          armedAt: 10,
          lastFireAt: null,
          lastError: 'last tick failed',
          running: false,
          runningSince: null,
          skippedWhileRunning: 0,
          instanced: false,
          instances: 1,
          fires: 2,
          shed: false,
          classification: null,
        },
      ],
      getInProcessChecks: () => ({
        checks: [
          { name: 'system-health', intervalMs: 30_000, shed: true }, // also armed as managed → deduped
          { name: 'service-health', intervalMs: 60_000 }, // NOT managed → static fallback
        ],
        armed: true,
      }),
    });

    // system-health appears ONCE (live managed), not duplicated as in-process
    const sh = rows.filter((r) => r.name === 'system-health');
    expect(sh).toHaveLength(1);
    expect(sh[0]).toMatchObject({ source: 'managed', tier: 'ephemeral', category: 'global-sweep', armed: true });
    expect(sh[0].lastFire).toBe(new Date(1_700_000_000_000).toISOString());
    expect(sh[0].detail).toMatchObject({
      running: true,
      runningSince: 1_700_000_000_000,
      skippedWhileRunning: 4,
    });

    // a watchdog managed timer is VISIBLE (source managed) but stays its own category — visibility != control
    const wd = rows.find((r) => r.name === 'engine-death-sentinel')!;
    expect(wd).toMatchObject({ source: 'managed', category: 'watchdog', lastError: 'last tick failed' });

    // service-health is not a managed timer here → static in-process fallback (armed flag from the process)
    const svc = rows.find((r) => r.name === 'service-health')!;
    expect(svc).toMatchObject({ source: 'in-process', armed: true, lastFire: null });
  });

  it('summarizeInventory rolls up by source and tier', () => {
    const summary = summarizeInventory([
      { source: 'dbos', tier: 'durable' } as never,
      { source: 'routines', tier: 'durable' } as never,
      { source: 'in-process', tier: 'ephemeral' } as never,
    ]);
    expect(summary.total).toBe(3);
    expect(summary.bySource).toEqual({ dbos: 1, routines: 1, 'in-process': 1 });
    expect(summary.byTier).toEqual({ durable: 2, ephemeral: 1 });
  });
});

/**
 * P-009 reconcile (WI-919): diff the operator-host timer AUDIT against the live registry +
 * the external-process manifest, asserting NO silent gaps. Two invariants, both durable:
 *
 *  1. The no-raw-setInterval guard BASELINE holds ONLY the one known-grandfathered site — every
 *     other operator-host timer goes through managedSetInterval, so it appears in listManaged() →
 *     the inventory's 'managed' source. A BASELINE entry means a host timer is runtime-INVISIBLE
 *     (the silent gap P-007/P-008 closed); shrinking it back to empty is the universal-visibility
 *     ratchet. ⚠ WI-6730: this invariant is only ever as strong as the guard's ENUMERATOR — it read
 *     as satisfied for two months while a bare `git ls-files` hid all 39 submodules from the scan.
 *  2. Every EXTERNAL_PROCESS_TIMERS source is allow-listed in that guard. This reconciles the two
 *     audits: a timer we LOG as 'external-process' must be one the host guard intentionally
 *     EXCLUDES (a separate process, not a host timer) — so no file is both expected-in-the-managed-
 *     registry AND logged-as-external (no double-count), and no external-process timer silently
 *     violates the host-setInterval guard. If the manifest and the allowlist drift apart, this fails.
 */
describe('schedule-inventory ⇄ host-timer guard reconcile (P-009 / WI-919)', () => {
  it('the no-raw-setInterval BASELINE is EMPTY — no host timer is runtime-invisible', () => {
    // The shrink-to-empty grandfather set, now EMPTY. A NEW bare setInterval is a hard guard
    // failure, never a BASELINE addition — that is the whole "every host timer is in
    // schedule:inventory" ratchet.
    //
    // WI-6730 (2026-08-01): an earlier `size === 0` assertion here passed — VACUOUSLY. BASELINE is
    // derived from what the guard can SEE, and the guard enumerated with a bare `git ls-files`,
    // which does not recurse into submodules. All 39 of them (incl. libs/papercusp) were therefore
    // never scanned, so "no host timer is runtime-invisible" was a statement about the visible
    // subtree only — precisely the silent gap this reconcile exists to catch.
    //
    // READ THIS BEFORE TRUSTING THE LINE BELOW: emptiness is meaningful again ONLY because the
    // guard now uses the RECURSING enumerator, which makes this a claim about the whole tree,
    // submodules included. The enumerator is the load-bearing part, not this assertion — if it
    // ever regresses to a non-recursing scan, this passes vacuously again while reading green.
    //
    // WI-6732 (2026-08-30): the final entry — libs/papercusp/packages/locks/src/workspace-listener.ts,
    // startBackgroundJanitor() — was migrated to managedSetInterval('su-locks:background-janitor',
    // …, { category: 'global-sweep', classification: 'timeout-reaper' }), emptying the set. Pinned
    // EXACTLY (not `<= N`) so the ratchet bites in both directions: a new offender cannot be parked
    // here, and any future grandfathering must update this test rather than silently loosen it.
    expect([...BASELINE].sort()).toEqual([]);
  });

  it('every external-process timer source is allow-listed in the host guard (audits agree, no gap)', () => {
    const allowlisted = (source: string): boolean =>
      ALLOWLIST.has(source) || ALLOWLIST_DIRS.some((dir: string) => source.startsWith(dir));
    const orphans = EXTERNAL_PROCESS_TIMERS.filter((e) => !allowlisted(e.source));
    // Each external-process timer file must be a separate-process site the host guard excludes.
    // An orphan = a manifest entry the guard would FLAG (so it isn't truly separate-process) OR a
    // typo'd path — either way the manifest and the guard have drifted.
    expect(orphans.map((o) => o.source)).toEqual([]);
  });

  it('the manifest covers exactly the three separate-process owners (gateway, watchdog, psu-launcher)', () => {
    const processes = new Set(EXTERNAL_PROCESS_TIMERS.map((e) => e.process));
    expect(processes).toEqual(
      new Set(['inference-gateway', 'gateway-watchdog', 'mcp-proxy-watchdog', 'bg-host-watchdog', 'psu-launcher']),
    );
    // Every entry carries a real repo source path + a cadence (no blank audit rows).
    for (const e of EXTERNAL_PROCESS_TIMERS) {
      expect(e.source).toMatch(/\.(ts|mjs)$/);
      expect(e.cadence.length).toBeGreaterThan(0);
    }
  });

  it('every source collectScheduleInventory emits is a filterable SCHEDULE_SOURCES value (tool ⇄ inventory parity)', async () => {
    // Stub one row per source so the union exercises all of them; assert the emitted `source`
    // set is a SUBSET of the tool's filter enum. This is what stops the exact drift WI-919 fixed —
    // the inventory surfacing a source (e.g. external-process) the schedule:inventory tool can't filter.
    const rows = await collectScheduleInventory({
      // EI-19445595198254637: the sibling-federation seam is a NETWORK default, so
      // every unit test must stub it — otherwise a dev box with live sibling
      // operators (bg-host/staging) injects real rows and these assertions go
      // non-deterministic. Federation itself is covered in schedule-federation.test.ts
      // and in the dedicated cases at the bottom of this file.
      getSiblingManaged: async () => [],
      getDbosSchedules: async () => [dbos()],
      getRoutines: async () => [routine()],
      getManaged: () => [
        {
          name: 'system-health',
          category: 'global-sweep',
          intervalMs: 30_000,
          armedAt: 1,
          lastFireAt: null,
          lastError: null,
          running: false,
          runningSince: null,
          skippedWhileRunning: 0,
          instanced: false,
          instances: 1,
          fires: 0,
          shed: false,
          classification: null,
        },
      ],
      getInProcessChecks: () => ({ checks: [{ name: 'service-health', intervalMs: 60_000 }], armed: true }),
      // default getExternalProcess → the real EXTERNAL_PROCESS_TIMERS manifest
    });
    const emitted = new Set(rows.map((r) => r.source));
    expect(emitted).toEqual(new Set(['dbos', 'routines', 'managed', 'in-process', 'external-process']));
    for (const s of emitted) expect(SCHEDULE_SOURCES).toContain(s);
  });
});

/**
 * P-006 C-10 — the manifest is an independent witness only when every writer
 * consumes its descriptor identity. These checks read the writer files rather
 * than comparing inventory rows to the same constants: descriptor→writer catches
 * a stale source path, while writer→descriptor catches an unlisted new writer.
 */
describe('schedule descriptors ⇄ recurring writers (P-006 C-10)', () => {
  it('every external descriptor source consumes its named EXTERNAL_SCHEDULES key', () => {
    for (const [key, descriptor] of Object.entries(EXTERNAL_SCHEDULES)) {
      const source = sourceText(descriptor.source);
      expect(source, `${descriptor.source} must consume EXTERNAL_SCHEDULES.${key}`).toContain(
        `EXTERNAL_SCHEDULES.${key}`,
      );
    }
  });

  it('every sync-triggered descriptor source consumes its named SYNC_TRIGGERED_SCHEDULES key', () => {
    for (const [key, descriptor] of Object.entries(SYNC_TRIGGERED_SCHEDULES)) {
      const source = sourceText(descriptor.source);
      expect(source, `${descriptor.source} must consume SYNC_TRIGGERED_SCHEDULES.${key}`).toContain(
        `SYNC_TRIGGERED_SCHEDULES.${key}`,
      );
    }
  });

  it('every descriptor reference in a writer resolves back to that writer\'s manifest row', () => {
    const reconcile = (
      prefix: 'EXTERNAL_SCHEDULES' | 'SYNC_TRIGGERED_SCHEDULES',
      descriptors: Record<string, { readonly source: string }>,
    ): void => {
      const sources = new Set(Object.values(descriptors).map((descriptor) => descriptor.source));
      for (const source of sources) {
        const declared = Object.entries(descriptors)
          .filter(([, descriptor]) => descriptor.source === source)
          .map(([key]) => key)
          .sort();
        const referenced = [
          ...sourceText(source).matchAll(new RegExp(`\\b${prefix}\\.([A-Za-z][A-Za-z0-9_]*)`, 'g')),
        ]
          .map((match) => match[1])
          .filter((key) => Object.hasOwn(descriptors, key))
          .filter((key, index, all) => all.indexOf(key) === index)
          .sort();
        expect(referenced, `${source} descriptor references must match its manifest rows`).toEqual(declared);
      }
    };

    reconcile('EXTERNAL_SCHEDULES', EXTERNAL_SCHEDULES);
    reconcile('SYNC_TRIGGERED_SCHEDULES', SYNC_TRIGGERED_SCHEDULES);
  });
});

/*
 * EI-19445595198254637 — cross-process federation.
 *
 * The bug: `source: 'managed'` reads the registry of whichever process SERVES the
 * call. Most sweeps run in bg-host, a different process, so they were absent from
 * the one surface built to inventory timers — and an inventory that answers "not
 * here" reads exactly like "does not exist". That is how a reaper failing 100% of
 * its passes ran 6+ days undetected.
 */
describe('collectScheduleInventory — sibling-process federation', () => {
  const federated = (over: Record<string, unknown> = {}) => ({
    port: 3271,
    pid: 4242,
    label: 'bg-host:3271',
    process: 'bg-host',
    ok: true,
    elapsedMs: 4,
    dbosSchedules: [],
    timers: [
      {
        name: 'attention-reconcile-unanswerable',
        category: 'global-sweep',
        intervalMs: 3_600_000,
        armedAt: 1,
        lastFireAt: 1_785_770_413_000,
        lastError: 'invalid input syntax for type bigint',
        running: true,
        runningSince: 1_785_770_413_000,
        skippedWhileRunning: 3,
        instanced: false,
        instances: 1,
        fires: 7,
        shed: false,
        classification: null,
      },
    ],
    ...over,
  });

  const emptySources = {
    getDbosSchedules: async () => [],
    getRoutines: async () => [],
    getManaged: () => [],
    getInProcessChecks: () => ({ checks: [], armed: false }),
    getExternalProcess: () => [],
    getSyncTriggered: () => [],
    // The default enrichment reads shared Postgres; stub it so these stay hermetic.
    enrichSiblingDbos: async (schedules: { name: string; crontab: string }[]) =>
      schedules.map((s) => ({
        name: s.name,
        crontab: s.crontab,
        mode: 'ExactlyOncePerIntervalWhenActive',
        queueName: null,
        lastFireMs: 1_785_773_000_000,
        lastStatus: 'SUCCESS',
      })),
  };

  it('surfaces a sibling process\'s LIVE timers with real armed/lastFire/lastError', async () => {
    const rows = await collectScheduleInventory({
      ...emptySources,
      getSiblingManaged: async () => [federated()] as never,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: 'external-process',
      name: 'attention-reconcile-unanswerable',
      cadence: 'every 1h',
      armed: true,
      // The whole point: fire-state and the error are REAL, not the nulls a static
      // manifest row carries.
      lastError: 'invalid input syntax for type bigint',
    });
    expect(rows[0].lastFire).toBe(new Date(1_785_770_413_000).toISOString());
    expect(rows[0].detail).toMatchObject({
      process: 'bg-host:3271',
      federated: true,
      reachable: true,
      running: true,
      runningSince: 1_785_770_413_000,
      skippedWhileRunning: 3,
    });
  });

  it('emits an explicit UNKNOWN row for a sibling that did not answer', async () => {
    const rows = await collectScheduleInventory({
      ...emptySources,
      getSiblingManaged: async () =>
        [
          {
            port: 3271,
            pid: 4242,
            label: 'operator:3271',
            process: null,
            ok: false,
            error: 'probe budget 1200ms exceeded',
            elapsedMs: 1200,
            timers: [],
            dbosSchedules: [],
          },
        ] as never,
    });

    // Exactly one row, and it must SAY the timers are unknown. Dropping the row
    // would restore the invisibility this change exists to remove — silence has to
    // be visible.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain('unknown');
    expect(rows[0].armed).toBeNull();
    expect(rows[0].lastError).toBe('probe budget 1200ms exceeded');
    expect(rows[0].detail).toMatchObject({ federated: false, reachable: false, port: 3271 });
  });

  it('is fail-soft: a throwing federation seam yields no rows, never a thrown inventory', async () => {
    const rows = await collectScheduleInventory({
      ...emptySources,
      getManaged: () => [
        {
          name: 'local-sweep',
          category: 'global-sweep',
          intervalMs: 30_000,
          armedAt: 1,
          lastFireAt: null,
          lastError: null,
          running: false,
          runningSince: null,
          skippedWhileRunning: 0,
          instanced: false,
          instances: 1,
          fires: 0,
          shed: false,
          classification: null,
        },
      ],
      getSiblingManaged: async () => {
        throw new Error('discovery dir unreadable');
      },
    });

    expect(rows.map((r) => r.name)).toEqual(['local-sweep']);
  });

  it('keeps federated rows OUT of the in-process dedup set', async () => {
    // `managed` means "armed in THIS process" and the static in-process fallback
    // dedups against it. A sibling arming the same name must not suppress the local
    // static row, or one process's timer would mask another's.
    const rows = await collectScheduleInventory({
      ...emptySources,
      getInProcessChecks: () => ({ checks: [{ name: 'service-health', intervalMs: 60_000 }], armed: false }),
      getSiblingManaged: async () =>
        [
          federated({
            timers: [
              {
                name: 'service-health',
                category: 'global-sweep',
                intervalMs: 60_000,
                armedAt: 1,
                lastFireAt: null,
                lastError: null,
                running: false,
                runningSince: null,
                skippedWhileRunning: 0,
                instanced: false,
                instances: 1,
                fires: 3,
                shed: false,
                classification: null,
              },
            ],
          }),
        ] as never,
    });

    const bySource = rows.filter((r) => r.name === 'service-health').map((r) => r.source).sort();
    expect(bySource).toEqual(['external-process', 'in-process']);
  });

  /*
   * The case the bug was actually FILED for. Both sweeps that failed silently for
   * 6+ days — dbos-executor-reaper and attention-reconcile-unanswerable — are DBOS
   * periodic workflows, not managedSetInterval timers, and DBOS keeps its schedule
   * registry in-process. Federating only the ephemeral timers would have shipped a
   * fix that missed its own motivating outage.
   */
  it('surfaces a sibling\'s DURABLE schedules under source:dbos with real fire-state', async () => {
    const rows = await collectScheduleInventory({
      ...emptySources,
      getSiblingManaged: async () =>
        [
          federated({
            timers: [],
            dbosSchedules: [
              { name: 'PeriodicWorkflows.attentionReconcileUnanswerable', crontab: '0 20 * * * *', mode: 'x', queueName: null },
            ],
          }),
        ] as never,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      // source:'dbos', NOT 'external-process' — an operator auditing the periodic
      // workflows filters on this, and that is the audience that missed the reaper.
      source: 'dbos',
      tier: 'durable',
      name: 'PeriodicWorkflows.attentionReconcileUnanswerable',
      cadence: '0 20 * * * *',
      armed: true,
    });
    // Fire-state resolves from shared Postgres, so a federated durable row is as
    // informative as a local one — the sibling only handed over name + crontab.
    expect(rows[0].lastFire).toBe(new Date(1_785_773_000_000).toISOString());
    expect(rows[0].detail).toMatchObject({ process: 'bg-host:3271', federated: true, lastStatus: 'SUCCESS' });
  });

  it('does not double-report a schedule registered in BOTH processes', async () => {
    // DBOS coordinates a schedule through shared Postgres, so both copies carry
    // identical fire-state; a second row would read as duplication, not information.
    const rows = await collectScheduleInventory({
      ...emptySources,
      getDbosSchedules: async () => [
        { name: 'Shared.telemetryFlush', crontab: '0 0 * * * *', mode: 'x', queueName: null, lastFireMs: null, lastStatus: null },
      ],
      getSiblingManaged: async () =>
        [
          federated({
            timers: [],
            dbosSchedules: [
              { name: 'Shared.telemetryFlush', crontab: '0 0 * * * *', mode: 'x', queueName: null },
              { name: 'BgOnly.executorReaper', crontab: '*/2 * * * *', mode: 'x', queueName: null },
            ],
          }),
        ] as never,
    });

    const dbosRows = rows.filter((r) => r.source === 'dbos');
    expect(dbosRows.map((r) => r.name).sort()).toEqual(['BgOnly.executorReaper', 'Shared.telemetryFlush']);
    // The surviving shared row is the LOCAL one (not federated); only the
    // bg-host-only schedule is added by federation.
    expect(dbosRows.find((r) => r.name === 'Shared.telemetryFlush')!.detail.federated).toBeUndefined();
    expect(dbosRows.find((r) => r.name === 'BgOnly.executorReaper')!.detail.federated).toBe(true);
  });
});
