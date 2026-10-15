import { describe, expect, it } from 'vitest';
import { assertPlanAuditReleaseHealth, readPlanAuditReleaseConfig } from './_plan-audit-release-config';

const sha = 'a'.repeat(40);
const receipt = 'promotion-fixture-receipt';
const env = { PAPERCUSP_PLAN_AUDIT_RELEASE_SHA: sha, PAPERCUSP_PLAN_AUDIT_RELEASE_RECEIPT: receipt, PAPERCUSP_WORKSPACE: 'workspace-fixture', PAPERCUSP_SID: 'session-fixture' };

describe('exact release audit proof admission', () => {
  it('requires a complete artifact identity and an authoritative receipt reference', () => {
    expect(() => readPlanAuditReleaseConfig({})).toThrow(/full promoted/);
    expect(() => readPlanAuditReleaseConfig({ ...env, PAPERCUSP_PLAN_AUDIT_RELEASE_SHA: sha.slice(0, 10) })).toThrow(/full promoted/);
    expect(() => readPlanAuditReleaseConfig({ ...env, PAPERCUSP_PLAN_AUDIT_RELEASE_RECEIPT: '' })).toThrow(/authoritative/);
    expect(readPlanAuditReleaseConfig(env)).toMatchObject({ origin: 'http://127.0.0.1:3070', expectedSha: sha, receiptRef: receipt });
  });

  it('refuses staging, remote and altered-path origins as final release evidence', () => {
    for (const origin of ['http://127.0.0.1:3170', 'https://example.test:3070', 'http://127.0.0.1:3070/adv', 'http://user:secret@127.0.0.1:3070']) {
      expect(() => readPlanAuditReleaseConfig({ ...env, OPERATOR_E2E_BASE_URL: origin })).toThrow(/release operator origin/);
    }
  });

  it('requires workspace scope and session attribution for the real audit', () => {
    expect(() => readPlanAuditReleaseConfig({ ...env, PAPERCUSP_WORKSPACE: '' })).toThrow(/scope and attribution/);
    expect(() => readPlanAuditReleaseConfig({ ...env, PAPERCUSP_SID: '' })).toThrow(/scope and attribution/);
    expect(readPlanAuditReleaseConfig(env)).toMatchObject({ workspace: 'workspace-fixture', clientId: 'session-fixture' });
  });

  it('rejects missing/mismatched artifact identity and stale bundles before the browser action', () => {
    const healthy = { ok: true, service: 'papercusp-operator', sha };
    expect(assertPlanAuditReleaseHealth(healthy, sha)).toBe(sha);
    expect(assertPlanAuditReleaseHealth({ ...healthy, sha: sha.slice(0, 10) }, sha)).toBe(sha.slice(0, 10));
    for (const bad of [null, { ...healthy, sha: null }, { ...healthy, sha: 'b'.repeat(40) }, { ...healthy, sha: 'a' }, { ...healthy, bundleStale: { reason: 'old bundle' } }]) {
      expect(() => assertPlanAuditReleaseHealth(bad, sha)).toThrow(/does not match/);
    }
  });
});
