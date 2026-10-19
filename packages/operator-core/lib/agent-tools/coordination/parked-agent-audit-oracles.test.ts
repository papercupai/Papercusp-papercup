import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parkedAuditOperatorRoute, parkedAuditToolFailure } from './parked-agent-audit-oracles';

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
