/** Read the actual native ballot through the production governance store. */
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { InvalidInputError } from '@papercusp/tooldef';
import { insertHiveIfAbsent } from './hive-store';
import { readPlanAdmissionGovernanceSnapshot } from './agent-tools/plans/plan-admission-governance-store';
import { getPlanRow, resolvePlanScope } from './agent-tools/plans/source';

const isolated = process.env.PAPERCUSP_VERIFY_TAURI_ISOLATED === '1';
let sql: Sql;
let workspaceId: string;
let evidence: string;

describe.skipIf(!isolated)('Native DAO persisted signed governance', () => {
  beforeAll(() => {
    const receipt = JSON.parse(readFileSync(process.env.PAPERCUSP_APP_OPERATION_LIVE_PROFILE! + '.dao.json', 'utf8'));
    expect(receipt.sourceCommit).toBe(process.env.VERIFY_TAURI_SOURCE_REF);
    workspaceId = receipt.workspaceId;
    evidence = receipt.evidence;
    expect(workspaceId).toMatch(/^verify-tauri-isolated-\d+$/);
    const url = process.env.HARNESS_ADMIN_DATABASE_URL!;
    const address = new URL(url);
    expect(['localhost', '127.0.0.1']).toContain(address.hostname);
    expect(address.port).not.toBe('5432');
    sql = postgres(url, { max: 1, onnotice: () => {} });
  });
  afterAll(async () => { if (sql) await sql.end({ timeout: 5 }); });

  it('reads the native proposal and authenticated approve ballot, round and finalization from the real isolated store', async () => {
    const response = JSON.parse(readFileSync(evidence + '/proposal-response.json', 'utf8'));
    const proposalSlug = JSON.parse(response.body).slug;
    const scopes = await sql`SELECT workspace_id, harness_slug FROM harness_shared.harness_plans WHERE plan_slug = ${proposalSlug}`;
    expect(scopes).toEqual([{ workspace_id: workspaceId, harness_slug: 'workbench-native' }]);
    const plan = await getPlanRow(proposalSlug, { workspaceId, harnessSlug: 'workbench-native' });
    expect(plan?.title).toBe('Native proposal');
    const snapshot = await readPlanAdmissionGovernanceSnapshot({ workspaceId, potHomeSlug: 'workbench-native' }, sql);
    expect(snapshot.integrityErrors).toEqual([]);
    expect(snapshot.events.map(event => event.body.kind).sort()).toEqual(['finalize', 'round-open', 'vote']);
    expect(JSON.stringify(snapshot.events.find(event => event.body.kind === 'vote')!.body)).toContain('"approve"');
    console.log('DAO_NATIVE_INTEGRATION_WORKSPACE=' + workspaceId);
  });

  it('refuses an unbound foreign workspace before reading the native proposal', async () => {
    const response = JSON.parse(readFileSync(evidence + '/proposal-response.json', 'utf8'));
    const foreignWorkspace = workspaceId + '-unbound-foreign';
    const read = getPlanRow(JSON.parse(response.body).slug, { workspaceId: foreignWorkspace, harnessSlug: 'workbench-native' });
    await expect(read).rejects.toBeInstanceOf(InvalidInputError);
    await expect(read).rejects.toThrow(`does not belong to one in workspace '${foreignWorkspace}'`);
    const snapshot = await readPlanAdmissionGovernanceSnapshot({ workspaceId: foreignWorkspace, potHomeSlug: 'workbench-native' }, sql);
    expect(snapshot.events).toEqual([]);
  });

  it('does not expose the native proposal or authenticated ballot through a registered foreign Hive', async () => {
    const response = JSON.parse(readFileSync(evidence + '/proposal-response.json', 'utf8'));
    const foreignWorkspace = workspaceId + '-bound-foreign';
    const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const foreignHive = await insertHiveIfAbsent({ workspaceId: foreignWorkspace, homeSlug: 'workbench-native',
      pubkeyBase64: publicKey, keychainId: 'synthetic-foreign:' + foreignWorkspace, title: 'Foreign isolated DAO' }, sql);
    expect(foreignHive.created).toBe(true);
    expect(await resolvePlanScope({ workspaceId: foreignWorkspace, harnessSlug: 'workbench-native' }))
      .toEqual({ workspaceId: foreignWorkspace, harnessSlug: 'workbench-native' });
    expect(await getPlanRow(JSON.parse(response.body).slug, { workspaceId: foreignWorkspace, harnessSlug: 'workbench-native' })).toBeNull();
    const snapshot = await readPlanAdmissionGovernanceSnapshot({ workspaceId: foreignWorkspace, potHomeSlug: 'workbench-native' }, sql);
    expect(snapshot.events).toEqual([]);
  });
});
