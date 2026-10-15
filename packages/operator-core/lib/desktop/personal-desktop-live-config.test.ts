import { describe, expect, it } from 'vitest';
import { personalDesktopLiveMode, personalDesktopScorecardEnvironment } from './personal-desktop-live-config';

describe('personal desktop live grading configuration', () => {
  it('keeps ordinary CI off, while the explicit scorecard check opts into fresh live execution', () => {
    expect(personalDesktopLiveMode({})).toBe('off');
    expect(personalDesktopLiveMode({ PAPERCUSP_TEST_RUN_GROUP: 'ordinary-test-run' })).toBe('off');
    expect(personalDesktopLiveMode({ PAPERCUSP_TEST_RUN_GROUP: 'scorecard-check-' + 'a'.repeat(40) })).toBe('scorecard');
    expect(personalDesktopLiveMode({ PAPERCUSP_TEST_RUN_GROUP: 'scorecard-check-invalid' })).toBe('off');
  });
  it('honors explicit manual opt-in and opt-out', () => {
    const grading = { PAPERCUSP_TEST_RUN_GROUP: 'scorecard-check-' + 'b'.repeat(40) };
    expect(personalDesktopLiveMode({ ...grading, PAPERCUSP_PERSONAL_DESKTOP_LIVE: '0' })).toBe('off');
    expect(personalDesktopLiveMode({ ...grading, PAPERCUSP_PERSONAL_DESKTOP_LIVE: '1' })).toBe('manual');
  });
  const profile = { plan: 'personal-cloud-desktop-2026-10-06', item: 'P-006', passed: false,
    host: { organizationId: 'org', customerWorkspaceId: 'workspace', hostId: 'host', instance: 'vm', project: 'project', zone: 'zone', runtime: 'runtime' },
    relay: { broker: 'ws://127.0.0.1:3880/socket' } };
  it('copies only real connection coordinates and a fresh output, never the recorded result', () => {
    expect(personalDesktopScorecardEnvironment(profile, '/fresh.json', 'new-run')).toEqual({ ORG: 'org', CWS: 'workspace', HOST: 'host', INST: 'vm', PROJECT: 'project', ZONE: 'zone', RUNTIME: 'runtime', BROKER: 'ws://127.0.0.1:3880/socket', OUT: '/fresh.json', RUN_ID: 'new-run' });
  });
  it('fails closed on a wrong target or incomplete host coordinates', () => {
    expect(() => personalDesktopScorecardEnvironment({ ...profile, item: 'P-005' }, '/fresh', 'run')).toThrow(/Wrong/);
    expect(() => personalDesktopScorecardEnvironment({ ...profile, host: { ...profile.host, hostId: '' } }, '/fresh', 'run')).toThrow(/hostId/);
    expect(() => personalDesktopScorecardEnvironment({ ...profile, relay: {} }, '/fresh', 'run')).toThrow(/broker/);
  });
});
