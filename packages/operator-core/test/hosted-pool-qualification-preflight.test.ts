import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION, workspaceHostCanaryIdentityLabels } from '@papercusp/deployment-driver';
import { setWorkspaceHostProvisioningExecutor } from '../lib/dbos/workspace-host-provision-workflow';
import { assertHostedPoolQualificationPreflight, type HostedPoolQualificationPreflight } from './hosted-pool-qualification-preflight';

const directory = mkdtempSync(join(tmpdir(), 'p544-admission-'));
const artifact = join(directory, 'serve.mjs');
const contents = 'export const qualification = true;\n';
writeFileSync(artifact, contents);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
function input(): HostedPoolQualificationPreflight {
  const workspaceId = 'test-runtime-p544', runId = 'p544-preflight';
  const cloudCredentialRef = { kind: 'cloud' as const, ref: 'adc://qualification-controller' };
  return {
    environment: { PAPERCUSP_WORKSPACE: workspaceId, PAPERCUSP_SKIP_PG_DISCOVERY: '1', PAPERCUSP_PG_PORT: '15492',
      HARNESS_ADMIN_DATABASE_URL: 'postgres://admin@127.0.0.1:15492/private',
      DATABASE_URL: 'postgres://app@localhost:15492/private', PAPERCUSP_DBOS_ENABLE: '1',
      PAPERCUSP_BACKGROUND_WORKERS: '1', DBOS__APPVERSION: `p544-${runId}` },
    systemDatabaseUrl: 'postgres://dbos@127.0.0.1:15492/private', artifact,
    expectedBundleSha256: createHash('sha256').update(contents).digest('hex'),
    desired: { hostId: 'host-p544', target: 'gcp', scope: { kind: 'project', id: 'qualification-project' },
      region: 'us-central1', zone: 'us-central1-a', size: 'e2-standard-2', image: { id: 'qualification-image' },
      data: { volumeGiB: 10, encrypted: true }, credentials: { cloudCredentialRef },
      labels: workspaceHostCanaryIdentityLabels({ workspaceId, runId }) },
    connection: { target: 'gcp', scope: { kind: 'project', id: 'qualification-project' }, cloudCredentialRef },
    canary: { workspaceId, runId, maxSpendCents: 100, teardownDeadlineAt: new Date(Date.now() + 600_000).toISOString(),
      contractApproval: { status: 'approved', suiteVersion: WORKSPACE_HOST_PROVIDER_CONTRACT_VERSION,
        reportRef: 'test://approved-provider-contract', approvedBy: 'preflight-test', approvedAt: new Date().toISOString() },
      budgetEvidenceRef: 'test://finite-budget', preRunZeroBaseline: { cents: 0,
        providerEvidenceRef: 'test://zero-baseline', observedAt: new Date().toISOString() } },
    workloadDeadlineAt: new Date(Date.now() + 300_000).toISOString(), teardownBudgetMs: 120_000,
  };
}

describe('positive hosted pool qualification preflight', () => {
  it('accepts a private runtime with explicit economic admission and unchanged artifact', () => {
    expect(assertHostedPoolQualificationPreflight(input())).toMatchObject({ workspaceId: 'test-runtime-p544',
      appVersion: 'p544-p544-preflight' });
  });
  it.each(['PAPERCUSP_DBOS_ENABLE', 'PAPERCUSP_BACKGROUND_WORKERS'])(
    'rejects the negative serving fixture with %s disabled before any cloud call', key => {
      const value = input(); value.environment[key] = '0';
      expect(() => assertHostedPoolQualificationPreflight(value)).toThrow(/requires/);
    });
  it('rejects a substituted DBOS executor', () => {
    setWorkspaceHostProvisioningExecutor(async () => ({ status: 'succeeded', hostId: 'fake', operationId: 'fake' }));
    try { expect(() => assertHostedPoolQualificationPreflight(input())).toThrow(/substituted/); }
    finally { setWorkspaceHostProvisioningExecutor(null); }
  });
  it.each(['PAPERCUSP_WORKSPACE', 'PAPERCUSP_PG_PORT', 'DBOS__APPVERSION'])(
    'rejects shared or unbound runtime identity in %s', key => {
      const value = input(); value.environment[key] = key === 'PAPERCUSP_PG_PORT' ? '5432' : 'papercusp';
      expect(() => assertHostedPoolQualificationPreflight(value)).toThrow();
    });
  it.each(['DATABASE_URL', 'systemDatabaseUrl'] as const)('rejects another database in %s', key => {
    const value = input();
    if (key === 'DATABASE_URL') value.environment[key] = 'postgres://app@localhost:15492/shared';
    else value.systemDatabaseUrl = 'postgres://app@localhost:15492/shared';
    expect(() => assertHostedPoolQualificationPreflight(value)).toThrow(/database differs/);
  });
  it('rejects a non-loopback database', () => {
    const value = input(); value.systemDatabaseUrl = 'postgres://app@remote.invalid:15492/private';
    expect(() => assertHostedPoolQualificationPreflight(value)).toThrow(/loopback/);
  });
  it('rejects the wrong artifact', () => {
    const value = input(); value.expectedBundleSha256 = '0'.repeat(64);
    expect(() => assertHostedPoolQualificationPreflight(value)).toThrow(/artifact differs/);
  });
  it('rejects absent, expired, or insufficient deadlines and implicit spending', () => {
    for (const change of [
      (v: HostedPoolQualificationPreflight) => { v.canary.teardownDeadlineAt = ''; },
      (v: HostedPoolQualificationPreflight) => { v.workloadDeadlineAt = new Date(0).toISOString(); },
      (v: HostedPoolQualificationPreflight) => { v.teardownBudgetMs = 600_000; },
      (v: HostedPoolQualificationPreflight) => { delete v.canary.maxSpendCents; },
    ]) { const value = input(); change(value); expect(() => assertHostedPoolQualificationPreflight(value)).toThrow(); }
  });
  it('reuses the production identity and approval guard', () => {
    const value = input(); value.desired.labels = { ...value.desired.labels, papercusp_run_id: 'another-run' };
    expect(() => assertHostedPoolQualificationPreflight(value)).toThrow(/papercusp_run_id/);
    const unapproved = input(); unapproved.canary.contractApproval.status = 'pending' as 'approved';
    expect(() => assertHostedPoolQualificationPreflight(unapproved)).toThrow(/approved/);
  });
});
