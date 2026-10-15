/** R9 detector controls. Real isolated PostgreSQL dump/restore and permission
 * probes; installation/network/MDM observations and approvals are FIXTURES.
 * This suite cannot accept an actual enterprise deployment or set release RTO/RPO.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveNativePgBinDir, startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { evaluateReleaseProfile } from '@papercusp/release-profile';
import {
  deploymentPhases, enterpriseDeploymentComponent, inspectEnterpriseDeployment,
  type DeploymentEvidenceInput, type DeploymentReceipt, type DeploymentSelection,
} from './release/enterprise-deployment-evidence';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
let pg: DedicatedNativePg;
let admin: Sql, source: Sql, target: Sql;
let scratch: string;
let control: DeploymentEvidenceInput;
let recovery: NonNullable<DeploymentReceipt['recovery']>;
const fixture = () => structuredClone(control);
const restoreRow = (input: DeploymentEvidenceInput) => input.receipts.find(r => r.phase === 'restore')!;
const inspect = (input: DeploymentEvidenceInput) => inspectEnterpriseDeployment({ ...input, nowMs: Date.now() });

async function observe(db: Sql) {
  const rows = await db.unsafe('SELECT marker FROM r9_records ORDER BY marker');
  const rawAcl = await db.unsafe(`SELECT relname, relacl::text FROM pg_class
    WHERE oid IN ('r9_records'::regclass, 'r9_private'::regclass) ORDER BY relname`);
  // ACL array order and NULL/default ACL representation need not survive a dump.
  // Compare effective named grants including owner, grantor and grant option.
  const grants = await db.unsafe(`SELECT c.relname, pg_get_userbyid(c.relowner) AS owner,
      CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
      pg_get_userbyid(a.grantor) AS grantor, a.privilege_type, a.is_grantable
    FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
    WHERE c.oid IN ('r9_records'::regclass, 'r9_private'::regclass)
    ORDER BY c.relname, grantee, grantor, a.privilege_type, a.is_grantable`);
  const legitimateAllowed = await db.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE r9_reader');
    const result = await tx.unsafe("SELECT marker FROM r9_records WHERE marker='before'");
    return result.length === 1;
  });
  let unauthorizedDenied = false;
  try {
    await db.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE r9_reader');
      await tx.unsafe('SELECT secret FROM r9_private');
    });
  } catch (error) {
    if ((error as { code?: string }).code !== '42501') throw error;
    unauthorizedDenied = true;
  }
  return { data: hash(JSON.stringify(rows)), restrictions: hash(JSON.stringify(grants)),
    rawAcl, legitimateAllowed, unauthorizedDenied };
}

describe('R9 selected deployment/recovery evidence detector', () => {
  beforeAll(async () => {
    const frozenAt = Date.now() - 1000;
    pg = await startDedicatedNativePg();
    admin = postgres(pg.getConnectionUri(), { onnotice: () => {} });
    await admin.unsafe('CREATE ROLE r9_reader NOLOGIN');
    await admin.unsafe('CREATE DATABASE r9_source');
    await admin.unsafe('CREATE DATABASE r9_restore');
    const sourceUrl = new URL(pg.getConnectionUri()); sourceUrl.pathname = '/r9_source';
    const targetUrl = new URL(pg.getConnectionUri()); targetUrl.pathname = '/r9_restore';
    source = postgres(sourceUrl.toString(), { onnotice: () => {} });
    target = postgres(targetUrl.toString(), { onnotice: () => {} });
    scratch = await mkdtemp(join(tmpdir(), 'r9-restore-'));
    await source.unsafe(`CREATE TABLE r9_records(marker text PRIMARY KEY);
      INSERT INTO r9_records VALUES ('before');
      CREATE TABLE r9_private(secret text); INSERT INTO r9_private VALUES ('restricted');
      REVOKE ALL ON r9_records, r9_private FROM PUBLIC;
      GRANT SELECT ON r9_records TO r9_reader`);
    const expected = await observe(source);
    expect(expected.legitimateAllowed).toBe(true);
    expect(expected.unauthorizedDenied).toBe(true);
    const startedAt = iso(Date.now());
    // The source is quiescent during pg_dump. This is a dump snapshot, not PITR.
    const [point] = await source.unsafe('SELECT clock_timestamp() AS at');
    const dump = join(scratch, 'snapshot.dump');
    await promisify(execFile)(join(resolveNativePgBinDir(), 'pg_dump'),
      ['--format=custom', '--file', dump, sourceUrl.toString()], { timeout: 60_000 });
    const backupRef = `fixture:pg-dump:sha256:${hash(await readFile(dump))}`;
    await source.unsafe("INSERT INTO r9_records VALUES ('after')");
    const incidentAt = iso(Date.now());
    await promisify(execFile)(join(resolveNativePgBinDir(), 'pg_restore'),
      ['--exit-on-error', '--dbname', targetUrl.toString(), dump], { timeout: 60_000 });
    const restored = await observe(target);
    if (JSON.stringify(expected.rawAcl) !== JSON.stringify(restored.rawAcl)) {
      console.info('R9_ACL_REPRESENTATION', JSON.stringify({ source: expected.rawAcl, restored: restored.rawAcl,
        effectiveGrantDigestsEqual: expected.restrictions === restored.restrictions }));
    }
    const healthyAt = iso(Date.now());
    recovery = { backupRef, recoveryPointAt: new Date(point!.at).toISOString(), incidentAt, healthyAt,
      expectedDataSha256: expected.data, restoredDataSha256: restored.data,
      expectedRestrictionsSha256: expected.restrictions, restoredRestrictionsSha256: restored.restrictions,
      legitimateAllowed: restored.legitimateAllowed, unauthorizedDenied: restored.unauthorizedDenied };
    const runtime = { ref: 'fixture:private-pg-and-simulated-endpoint', owner: 'vitest:r9', isolationBoundary: scratch };
    const selection: DeploymentSelection = {
      planRef: 'fixture:enterprise-selected-profile', specRevision: 'fixture:revision-1',
      sourceBlobSha256: hash('fixture spec'), recordSha256: hash('fixture frozen selection'),
      assumptionRegisterSha256: hash('fixture A1-A10 register'), approvalRef: 'fixture:approval',
      approvedBy: 'fixture:engineering-approver', approvedAt: iso(frozenAt - 1000), frozenAt: iso(frozenAt),
      candidateSha: 'a'.repeat(40), profiles: [{ id: 'fixture:linux-desktop-hosted', os: 'fixture:linux',
        delivery: 'desktop-hosted', artifactSha256: hash('fixture candidate bytes'),
        datasetId: 'fixture:r9-canaries', expectedDataSha256: expected.data,
        expectedRestrictionsSha256: expected.restrictions,
        installId: 'fixture:install-1', restoreId: 'fixture:restore-1', runtime,
        networkCases: ['legitimate-proxy', 'denied-proxy'], updateRings: ['pilot', 'broad'],
        managedEndpoint: true, privateNetwork: true, maxRtoMs: 120_000, maxRpoMs: 120_000 }],
    };
    const profile = selection.profiles[0]!;
    control = { selection, requiredPlane: 'integration', receipts: deploymentPhases(profile).map(phase => ({
      ref: `fixture:exercise:${phase}`, assertionIds: [`r9:fixture:${phase}`], plane: 'integration',
      runtime: { ...runtime, kind: 'integration-fixture', artifactSha256: profile.artifactSha256 },
      candidateSha: selection.candidateSha, recordSha256: selection.recordSha256, profileId: profile.id,
      artifactSha256: profile.artifactSha256, datasetId: profile.datasetId, installId: profile.installId,
      restoreId: profile.restoreId, phase, startedAt, finishedAt: healthyAt, verdict: 'pass',
      ...(phase === 'backup' ? { backupRef } : {}),
      ...(phase === 'restore' ? { recovery: structuredClone(recovery) } : {}),
    })) };
  }, 120_000);

  afterAll(async () => {
    await Promise.all([source?.end({ timeout: 5 }), target?.end({ timeout: 5 }), admin?.end({ timeout: 5 })]);
    await pg?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }, 30_000);

  it('qualifies the explicit integration control with real restored data and permission probes', async () => {
    expect(recovery.restoredDataSha256).toBe(recovery.expectedDataSha256);
    expect(recovery.restoredRestrictionsSha256).toBe(recovery.expectedRestrictionsSha256);
    const result = inspect(fixture());
    expect(result.verdict, result.reason).toBe('pass');
    expect(result.reason).toContain('integration');
    expect(result.coverage.checked).toEqual(result.coverage.population);
    expect(result.coverage.notChecked).toEqual([]);
    const composite = await evaluateReleaseProfile({ profileRef: 'fixture:r9',
      expectedLineage: { sha: control.selection!.candidateSha },
      components: [enterpriseDeploymentComponent(fixture(), 60_000)] });
    expect(composite.go).toBe(true);
  });

  it('keeps actual deployment unknown when only integration fixtures exist', () => {
    const input = fixture(); delete input.requiredPlane;
    const result = inspect(input);
    expect(result.verdict).toBe('unknown');
    expect(result.checks.some(c => c.id.endsWith(':runtime-route') && c.verdict === 'unknown')).toBe(true);
  });

  it.each(['candidateSha', 'artifactSha256', 'recordSha256', 'datasetId', 'installId', 'restoreId'] as const)(
    'detects a wrong %s joined to otherwise passing evidence', key => {
      const input = fixture(); restoreRow(input)[key] = key.endsWith('Sha256') ? 'f'.repeat(64) : 'wrong-identity';
      expect(inspect(input).verdict).toBe('fail');
    });

  it.each(['ref', 'owner', 'isolationBoundary'] as const)('detects a wrong runtime %s', key => {
    const input = fixture(); restoreRow(input).runtime[key] = 'wrong-runtime';
    expect(inspect(input).verdict).toBe('fail');
  });

  it('detects unsupported profiles and duplicate receipts without hiding failed rows', () => {
    const input = fixture(); const row = structuredClone(restoreRow(input)); row.profileId = 'unsupported';
    input.receipts = [...input.receipts, row]; expect(inspect(input).verdict).toBe('fail');
    row.profileId = input.selection!.profiles[0]!.id; row.verdict = 'fail';
    expect(inspect(input).verdict).toBe('fail');
  });

  it('joins restoration to the completed backup and frozen dataset/restriction pins', () => {
    const wrong = fixture(); restoreRow(wrong).recovery!.backupRef = 'wrong-backup';
    expect(inspect(wrong).verdict).toBe('fail');
    const forgedBaseline = fixture(); const observation = restoreRow(forgedBaseline).recovery!;
    observation.expectedDataSha256 = observation.restoredDataSha256 = hash('lost dataset');
    observation.expectedRestrictionsSha256 = observation.restoredRestrictionsSha256 = hash('lost restrictions');
    expect(inspect(forgedBaseline).verdict).toBe('fail');
  });

  it('enumerates each selected profile and refuses an unexercised second profile', () => {
    const input = fixture(); const second = structuredClone(input.selection!.profiles[0]!);
    second.id = 'fixture:private-cloud'; second.delivery = 'private-cloud'; second.managedEndpoint = false;
    input.selection!.profiles = [...input.selection!.profiles, second];
    expect(inspect(input).verdict).toBe('unknown');
    input.receipts = [...input.receipts, ...input.receipts.filter(r => deploymentPhases(second).includes(r.phase))
      .map(r => ({ ...structuredClone(r), profileId: second.id, ref: `${r.ref}:cloud` }))];
    const result = inspect(input); expect(result.verdict, result.reason).toBe('pass');
    expect(result.coverage.checked).toEqual(result.coverage.population);
    expect(result.coverage.population).not.toContain(`profile:${second.id}/mdm-packaging`);
  });

  const phases = ['install', 'boot', 'configuration', 'upgrade', 'health', 'diagnostics', 'backup', 'restore',
    'network:legitimate-proxy', 'network:denied-proxy', 'rollout:pilot', 'rollout:broad',
    'mdm-packaging', 'administrator-controls', 'isolated-endpoint', 'private-network'];
  it.each(phases)('detects missing and failing selected phase %s', phase => {
    const absent = fixture(); absent.receipts = absent.receipts.filter(r => r.phase !== phase);
    const missing = inspect(absent); expect(missing.verdict).toBe('unknown');
    expect(missing.coverage.notChecked).toContain(`profile:${absent.selection!.profiles[0]!.id}/${phase}`);
    const failed = fixture(); failed.receipts.find(r => r.phase === phase)!.verdict = 'fail';
    // A second missing branch must not downgrade a measured failure to unknown.
    failed.receipts = failed.receipts.filter(r => r.phase !== (phase === 'boot' ? 'health' : 'boot'));
    expect(inspect(failed).verdict).toBe('fail');
  });

  it('detects data actually lost after restore', async () => {
    try {
      await target.unsafe("DELETE FROM r9_records WHERE marker='before'");
      const observation = await observe(target);
      const input = fixture(); restoreRow(input).recovery!.restoredDataSha256 = observation.data;
      restoreRow(input).recovery!.legitimateAllowed = observation.legitimateAllowed;
      expect(inspect(input).verdict).toBe('fail');
    } finally { await target.unsafe("INSERT INTO r9_records VALUES ('before') ON CONFLICT DO NOTHING"); }
  });

  it('detects restrictions actually lost after restore, including a successful forbidden read', async () => {
    try {
      await target.unsafe('GRANT SELECT ON r9_private TO r9_reader');
      const observation = await observe(target);
      expect(observation.unauthorizedDenied).toBe(false);
      const input = fixture(); restoreRow(input).recovery!.restoredRestrictionsSha256 = observation.restrictions;
      restoreRow(input).recovery!.unauthorizedDenied = observation.unauthorizedDenied;
      expect(inspect(input).verdict).toBe('fail');
    } finally { await target.unsafe('REVOKE SELECT ON r9_private FROM r9_reader'); }
  });

  it.each(['maxRtoMs', 'maxRpoMs'] as const)('requires pinned %s and enforces it at the exact boundary', key => {
    const input = fixture(); const row = restoreRow(input).recovery!;
    const duration = key === 'maxRtoMs' ? Date.parse(row.healthyAt) - Date.parse(row.incidentAt)
      : Date.parse(row.incidentAt) - Date.parse(row.recoveryPointAt);
    expect(duration).toBeGreaterThan(0);
    input.selection!.profiles[0]![key] = duration;
    expect(inspect(input).verdict).toBe('pass');
    input.selection!.profiles[0]![key] = duration - 1;
    expect(inspect(input).verdict).toBe('fail');
    input.selection!.profiles[0]![key] = null;
    expect(inspect(input).verdict).toBe('unknown');
  });

  it('requires nonempty frozen populations, qualified provenance, immutable pins and predeclared objectives', () => {
    const empty = fixture(); empty.selection!.profiles = []; expect(inspect(empty).verdict).toBe('fail');
    empty.receipts = []; expect(inspect(empty).verdict).toBe('unknown');
    const absent = fixture(); absent.selection = null; expect(inspect(absent).verdict).toBe('unknown');
    for (const key of ['planRef', 'specRevision', 'approvalRef', 'approvedBy', 'sourceBlobSha256',
      'recordSha256', 'assumptionRegisterSha256'] as const) {
      const input = fixture(); input.selection![key] = '';
      expect(inspect(input).verdict).not.toBe('pass');
    }
    const late = fixture(); late.selection!.frozenAt = iso(Date.now() + 1000);
    expect(inspect(late).verdict).toBe('fail');
    const unqualified = fixture(); unqualified.selection!.profiles[0]!.networkCases = [];
    unqualified.receipts = unqualified.receipts.filter(r => !r.phase.startsWith('network:'));
    expect(inspect(unqualified).verdict).toBe('unknown');
  });

  it('does not let missing recovery observations authorize GO and reuses composite freshness/lineage policy', async () => {
    const absent = fixture(); delete restoreRow(absent).recovery;
    expect(inspect(absent).verdict).toBe('unknown');
    const missingDigest = fixture(); restoreRow(missingDigest).recovery!.expectedRestrictionsSha256 = '';
    expect(inspect(missingDigest).verdict).toBe('unknown');
    const missingDenial = fixture(); restoreRow(missingDenial).recovery!.unauthorizedDenied = null;
    expect(inspect(missingDenial).verdict).toBe('unknown');
    const component = enterpriseDeploymentComponent(fixture(), 60_000);
    const stale = await evaluateReleaseProfile({ profileRef: 'fixture:r9', components: [component] },
      { now: Date.now() + 120_000 });
    expect(stale.go).toBe(false); expect(stale.components[0]!.verdict).toBe('stale');
    const wrong = await evaluateReleaseProfile({ profileRef: 'fixture:r9', components: [component],
      expectedLineage: { sha: 'b'.repeat(40) } });
    expect(wrong.go).toBe(false); expect(wrong.components[0]!.verdict).toBe('lineage-mismatch');
  });

  it('detects invalid measurement windows and absent receipt/assertion/runtime qualification', () => {
    const future = fixture(); restoreRow(future).finishedAt = iso(Date.now() + 60_000);
    expect(inspect(future).verdict).toBe('fail');
    const reverse = fixture(); restoreRow(reverse).recovery!.recoveryPointAt = iso(Date.now() + 1000);
    expect(inspect(reverse).verdict).toBe('fail');
    const missing = fixture(); restoreRow(missing).assertionIds = [];
    expect(inspect(missing).verdict).toBe('unknown');
    const runtime = fixture(); runtime.selection!.profiles[0]!.runtime.ref = '';
    expect(inspect(runtime).verdict).toBe('unknown');
  });
});
