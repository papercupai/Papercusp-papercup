import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parkedAuditOperatorRoute, parkedAuditScorecardEnvironment, parkedAuditToolFailure } from './parked-agent-audit-oracles';

describe('parked audit scorecard execution configuration', () => {
  const suite = 'packages/operator-core/lib/agent-tools/coordination/parked-agent-audit.e2e.test.ts';
  const group = { PAPERCUSP_TEST_RUN_GROUP: 'scorecard-check-' + 'a'.repeat(40) + '-0' };
  const request = { files: [suite], actorId: 'authenticated-grader', workspaceId: 'caller-workspace' };
  it('leaves ordinary CI, unrelated suites and explicit manual opt-out unchanged', () => {
    for (const env of [{}, { PAPERCUSP_TEST_RUN_GROUP: 'ordinary-run' },
      { PAPERCUSP_TEST_RUN_GROUP: 'scorecard-check-invalid' }, { ...group, PAPERCUSP_PARKED_SEARCH_LIVE: '0' }]) {
      expect(parkedAuditScorecardEnvironment(env, request)).toEqual({});
    }
    expect(parkedAuditScorecardEnvironment(group, { ...request, files: ['other.e2e.test.ts'] })).toEqual({});
    expect(parkedAuditScorecardEnvironment({ PAPERCUSP_PARKED_SEARCH_LIVE: '1' }, request)).toEqual({});
  });
  it('configures fresh live checks with caller scope and the maintained profile before collection', () => {
    const result = parkedAuditScorecardEnvironment({ ...group, PAPERCUSP_SID: 'stale-server-owner',
      PAPERCUSP_WORKSPACE: 'stale-server-workspace', PAPERCUSP_PARKED_AUDIT_LIVE: '1',
      PAPERCUSP_PARKED_CURRENT_LIVE: '1' }, { ...request, files: ['/checkout/' + suite] });
    expect(result).toEqual({ PAPERCUSP_SID: 'authenticated-grader', PAPERCUSP_WORKSPACE: 'caller-workspace',
      PAPERCUSP_APP_OPERATION_LIVE_PROFILE: 'packages/operator-core/test/parked-agent-audit.live-profile.json',
      PAPERCUSP_PARKED_SEARCH_LIVE: '1', PAPERCUSP_PARKED_AUDIT_LIVE: '0', PAPERCUSP_PARKED_CURRENT_LIVE: '0' });
    expect(parkedAuditScorecardEnvironment({ ...group, PAPERCUSP_PARKED_SEARCH_LIVE: '1' }, request)).toEqual(result);
  });
  it.each([{ actorId: undefined }, { actorId: ' ' }, { workspaceId: undefined },
    { workspaceId: ' ' }, { workspaceId: '*' }])('refuses absent authenticated scope: %j', missing => {
    expect(() => parkedAuditScorecardEnvironment({ ...group, PAPERCUSP_SID: 'server-owner',
      PAPERCUSP_WORKSPACE: 'ledger-workspace' }, { ...request, ...missing }))
      .toThrow('parked-audit-scorecard-authenticated-scope-required');
  });
  it.each(['', 'other-profile.json'])('refuses an explicitly missing or wrong profile: %s', profile => {
    expect(() => parkedAuditScorecardEnvironment({ ...group, PAPERCUSP_APP_OPERATION_LIVE_PROFILE: profile }, request))
      .toThrow('parked-audit-scorecard-live-profile-mismatch');
  });
  it('uses the same scoped profile for R7 and honors each suite opt-out independently', () => {
    const orientation = 'packages/operator-core/lib/agent-tools/coordination/parked-agent-orientation.e2e.test.ts';
    const result = parkedAuditScorecardEnvironment(group, { ...request, files: [orientation] });
    expect(result.PAPERCUSP_PARKED_ORIENTATION_LIVE).toBe('1');
    expect(result.PAPERCUSP_PARKED_SEARCH_LIVE).toBeUndefined();
    expect(result.PAPERCUSP_SID).toBe(request.actorId);
    expect(result.PAPERCUSP_APP_OPERATION_LIVE_PROFILE).toBe('packages/operator-core/test/parked-agent-audit.live-profile.json');
    expect(parkedAuditScorecardEnvironment({ ...group, PAPERCUSP_PARKED_ORIENTATION_LIVE: '0' },
      { ...request, files: [orientation] })).toEqual({});
    const mixed = parkedAuditScorecardEnvironment({ ...group, PAPERCUSP_PARKED_SEARCH_LIVE: '0' },
      { ...request, files: [suite, orientation] });
    expect(mixed.PAPERCUSP_PARKED_ORIENTATION_LIVE).toBe('1');
    expect(mixed.PAPERCUSP_PARKED_SEARCH_LIVE).toBeUndefined();
  });
});

const native = {
  VERIFY_TAURI_PID: '1234', VERIFY_TAURI_PORT: '23170',
  VERIFY_TAURI_DEV_URL: 'http://127.0.0.1:23170',
  VERIFY_TAURI_SOURCE_REF: 'a'.repeat(40),
  VERIFY_TAURI_SOURCE_RECEIPT: '/verifier/source.json', OPERATOR_SOURCE_ROOT: '/verifier/source',
};

describe('parked audit failed tool diagnostics', () => {
  it('preserves the original failed process and its structured child refusal', async () => {
    const failure = await promisify(execFile)(process.execPath, ['-e',
      'process.stdout.write(JSON.stringify({ok:false,okFalseMutations:[{tool:"events:await",error:"child-write-refused"}]}));process.exitCode=5;',
    ]).catch(error => {
      try { parkedAuditToolFailure(error); } catch (annotated) { return annotated as Error & { code: number }; }
    });
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error & { code: number }).code).toBe(5);
    expect((failure as Error).message).toContain('child-write-refused');
    expect((failure as Error).message).toContain('events:await');
  });
});

describe('parked audit authenticated runtime route', () => {
  it('keeps the shared default and sends owned-verifier observations to their own port', () => {
    expect(parkedAuditOperatorRoute({})).toEqual({ port: '3170', origin: 'http://127.0.0.1:3170' });
    expect(parkedAuditOperatorRoute(native)).toEqual({ port: '23170', origin: native.VERIFY_TAURI_DEV_URL });
  });

  it.each(Object.keys(native))('refuses a partial verifier missing %s instead of probing staging', key => {
    expect(() => parkedAuditOperatorRoute({ ...native, [key]: '' })).toThrow('parked-audit-native-route-invalid');
  });

  it.each(['0', '65536', '23170suffix', '23.5'])('refuses invalid port %s', port => {
    expect(() => parkedAuditOperatorRoute({ ...native, VERIFY_TAURI_PORT: port })).toThrow('parked-audit-native-route-invalid');
  });

  it.each(['http://127.0.0.1:3170', 'https://127.0.0.1:23170', 'http://remote.test:23170',
    'http://user@127.0.0.1:23170', 'http://127.0.0.1:23170/api'])('refuses a mismatched destination %s', url => {
    expect(() => parkedAuditOperatorRoute({ ...native, VERIFY_TAURI_DEV_URL: url })).toThrow('parked-audit-native-route-invalid');
  });
});
