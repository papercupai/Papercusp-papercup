import { describe, expect, it } from 'vitest';
import { checkStartupActivityCensus, STARTUP_ACTIVITY_ENTRYPOINTS, type StartupActivityFeature } from './schedule-inventory';
import { readNativeStartupActivity, savedStartupActivityPolicy, startupActivityCensus } from './startup-activity';

const linux = (service: string, linger = 'yes') => readNativeStartupActivity({ platform: 'linux', deviceId: 'test-device', uid: 1001,
  probe: async (command, args) => {
    if (command === 'systemctl') {
      expect(args).toEqual(['--user', 'show', 'papercusp-server.service', '--no-pager', '--property=LoadState,UnitFileState,ActiveState,CPUUsageNSec']);
      return service;
    }
    expect(command).toBe('loginctl');
    expect(args).toEqual(['show-user', '1001', '--property=Linger', '--value']);
    return linger;
  },
});
const state = (unit: string, active: string) => `LoadState=loaded\nUnitFileState=${unit}\nActiveState=${active}\nCPUUsageNSec=125000\nMemoryCurrent=32768\n`;

describe('native startup activity observations', () => {
  it('distinguishes configured startup from observed running state', async () => {
    const enabledIdle = await linux(state('enabled', 'inactive'));
    expect(enabledIdle.features.map(f => f.observed)).toEqual(['idle', 'unknown', 'unknown']);
    expect(enabledIdle.features.map(f => f.desired.automatic)).toEqual([null, true, true]);
    const disabledRunning = await linux(state('disabled', 'active'));
    expect(disabledRunning.features[0]!.observed).toBe('running');
    expect(disabledRunning.features[1]!.desired.automatic).toBe(false);
    expect(disabledRunning.features[2]!.desired.automatic).toBe(false);
    expect(disabledRunning.features[0]!.resources).toEqual({ cpuUsec: 125, rssBytes: null, costCents: null });
  });

  it('requires both an enabled unit and linger to claim boot startup', async () => {
    expect((await linux(state('enabled', 'active'), 'no')).features[2]!.desired.automatic).toBe(false);
    const unknown = await linux(state('enabled-runtime', 'activating'), 'not available');
    expect(unknown.features[1]!.desired.automatic).toBeNull();
    expect(unknown.features[2]!.desired.automatic).toBeNull();
    expect(unknown.features[0]!.observed).toBe('unknown');
    expect(unknown.unavailable).toEqual(['native-boot', 'native-registration', 'native-service']);
  });

  it('keeps unavailable managers and sentinel resource measurements unknown without leaking stderr', async () => {
    const snapshot = await readNativeStartupActivity({ platform: 'linux', deviceId: 'test', uid: 1001,
      probe: async () => { throw new Error('secret /private/path https://private.example'); },
    });
    expect(snapshot.features.every(f => f.observed === 'unknown' && f.desired.automatic === null)).toBe(true);
    expect(snapshot.unavailable).toEqual(['native-boot', 'native-registration', 'native-service']);
    expect(JSON.stringify(snapshot)).not.toMatch(/secret|private/);
    const sentinel = await linux('LoadState=loaded\nUnitFileState=masked\nActiveState=failed\nCPUUsageNSec=18446744073709551615\nMemoryCurrent=[not set]');
    expect(sentinel.features[0]!.resources).toEqual({ cpuUsec: null, rssBytes: null, costCents: null });
    expect(sentinel.features[1]!.desired.automatic).toBe(false);
  });

  it('separates devices and never executes Linux commands on another OS', async () => {
    const a = await readNativeStartupActivity({ platform: 'win32', deviceId: 'a', probe: async () => { throw new Error('must not execute'); } });
    const b = await readNativeStartupActivity({ platform: 'darwin', deviceId: 'b', probe: async () => { throw new Error('must not execute'); } });
    expect(a.features[0]!.id).not.toBe(b.features[0]!.id);
    expect(a.features.every(f => f.desired.automatic === null && f.observed === 'unknown')).toBe(true);
    expect(a.unavailable).toEqual(['native-registration', 'native-service', 'native-boot']);
  });

  it('links native writers, explains other OS writers, and leaves missing dynamic writers uncovered', async () => {
    const { features } = await linux(state('enabled', 'active'));
    const census = startupActivityCensus(features, 'linux');
    expect(census.find(d => d.id === 'linux-user-service')).toEqual({ id: 'linux-user-service', kind: 'checked', featureIds: [features[0]!.id] });
    expect(census.find(d => d.id === 'mac-boot-install')).toMatchObject({ kind: 'not-applicable', reason: expect.stringContaining('Linux') });
    const result = checkStartupActivityCensus(STARTUP_ACTIVITY_ENTRYPOINTS.map(e => e.id), census, features);
    expect(result.complete).toBe(false);
    expect(result.problems).toContain('missing:routine-dispatch');
    const counterexample = census.map(d => d.id === 'linux-user-service' ? { ...d, kind: 'checked' as const, featureIds: [features[1]!.id] } : d);
    expect(checkStartupActivityCensus(STARTUP_ACTIVITY_ENTRYPOINTS.map(e => e.id), counterexample, features).problems).toContain('wrong-writer:linux-user-service');
  });

  it('reads persistent workspace policy without rewriting native preferences or inferring a stopped invocation', async () => {
    const { features } = await linux(state('enabled', 'active'));
    const device = features[0]!;
    const workspace: StartupActivityFeature = { ...device, scope: { kind: 'workspace', id: 'workspace-a' }, desired: { automatic: true, pausedUntil: null, revision: null } };
    const row = { paused: true, backgroundActivity: { version: 1, revision: 8, automatic: false, pausedUntil: '2026-12-01T00:00:00Z' }, unknownFutureField: 1 };
    expect(savedStartupActivityPolicy(workspace, row, 'workspace-a')).toEqual({ automatic: false, paused: true, pausedUntil: '2026-12-01T00:00:00Z', revision: 8 });
    expect(workspace.observed).toBe('running');
    expect(savedStartupActivityPolicy(device, row, 'workspace-a')).toEqual(device.desired);
    expect(savedStartupActivityPolicy(workspace, null, 'workspace-a')).toMatchObject({ automatic: true, paused: false, revision: null });
    expect(() => savedStartupActivityPolicy(workspace, row, 'workspace-b')).toThrow('scope unavailable');
    expect(() => savedStartupActivityPolicy(workspace, { backgroundActivity: { ...row.backgroundActivity, version: 2 } }, 'workspace-a')).toThrow();
  });

  it('preserves an explicit feature disable when the workspace permits automatic activity', async () => {
    const { features } = await linux(state('enabled', 'active'));
    const feature: StartupActivityFeature = { ...features[0]!, scope: { kind: 'workspace', id: 'workspace-a' } };
    const row = { paused: false, backgroundActivity: { version: 1, revision: 9, automatic: true, pausedUntil: null,
      features: { [feature.id]: { automatic: false, paused: false, pausedUntil: null, revision: 7 } } } };
    expect(savedStartupActivityPolicy(feature, row, 'workspace-a')).toMatchObject({ automatic: false, paused: false, revision: 9 });
  });

  it('expires only the elapsed pause and preserves an independent feature pause and disable', async () => {
    const { features } = await linux(state('enabled', 'active'));
    const feature: StartupActivityFeature = { ...features[0]!, scope: { kind: 'workspace', id: 'workspace-a' } };
    const now = Date.parse('2026-11-02T12:00:00Z');
    const row = { paused: true, backgroundActivity: { version: 1, revision: 11, automatic: true,
      pausedUntil: '2026-11-02T11:00:00Z', features: {
        [feature.id]: { automatic: false, paused: true, pausedUntil: '2026-11-02T13:00:00Z', revision: 10 },
      } } };
    expect(savedStartupActivityPolicy(feature, row, 'workspace-a', now)).toEqual({
      automatic: false, paused: true, pausedUntil: '2026-11-02T13:00:00Z', revision: 11,
    });
    expect(savedStartupActivityPolicy(feature, row, 'workspace-a', now + 3_600_000)).toEqual({
      automatic: false, paused: false, pausedUntil: null, revision: 11,
    });
    const indefinite = { ...row, backgroundActivity: { ...row.backgroundActivity, pausedUntil: null } };
    expect(savedStartupActivityPolicy(feature, indefinite, 'workspace-a', now)).toMatchObject({ paused: true, pausedUntil: null });
  });
});
