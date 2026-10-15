import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { PostgresHostedUsageStore } from '../auth/hosted/billing/usage-store';
import { createHostedUsageSource } from '../auth/hosted/billing/usage-service';
import { loadHarnessTokens } from './load-tokens';

let db: OrgTestDb;
beforeAll(async () => { db = await createOrgTestDb(); });
afterAll(async () => { await db?.cleanup(); });

it('keeps a persisted Papercusp service charge separate from observed local model costs and unknown account billing', async () => {
  const control = randomUUID(), organization = randomUUID(), customer = randomUUID();
  const harness = 'billing-separation', now = Date.now();
  await db.adminSql`INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${organization}::uuid, ${'billing-separation-' + organization}, 'Billing separation fixture')`;
  await db.adminSql`INSERT INTO harness_shared.workspace_host_connections
    (workspace_id, id, target, label, credential_ref, status)
    VALUES (${control}, ${customer}, 'gcp', 'Billing fixture', 'delegation://fixture/gcp', 'connected')`;
  await db.adminSql`INSERT INTO harness_shared.workspace_hosts
    (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${control}, ${customer}, 'Billing fixture', ${customer}, 'gcp', 'fixture-project',
      'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')`;
  await db.adminSql`INSERT INTO harness_shared.customer_workspaces
    (workspace_id, id, organization_id, workspace_host_id, display_name, state, created_by_principal_kind, created_by_principal_id)
    VALUES (${control}, ${customer}, ${organization}, ${customer}, 'Billing fixture', 'active', 'user', 'fixture-user')`;
  await db.adminSql`INSERT INTO harness_shared.agent_usage_samples
    (workspace_id, harness_slug, ts, bucket_key, provider, model_class, source,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, cost_source)
    VALUES
      (${customer}, ${harness}, ${now}, 'local', 'openai', 'reported', 'jsonl', 100, 20, 0, 0, 0.2, 'provider'),
      (${customer}, ${harness}, ${now - 1}, 'local', 'openai', 'estimated', 'jsonl', 200, 30, 0, 0, 0.1, 'estimated'),
      (${customer}, ${harness}, ${now - 2}, 'local', 'other', 'unknown', 'jsonl', NULL, 40, 0, NULL, NULL, NULL)`;
  const local = () => loadHarnessTokens({ workspace_id: customer, harness_slug: harness, windowMs: 60_000,
    runQuery: async <T>(query: string, params: unknown[]) =>
      await db.adminSql.unsafe(query, params as never) as unknown as T[],
  });
  const before = await local();
  const store = new PostgresHostedUsageStore(fn => db.adminSql.begin(async transaction => {
    const tx = transaction as unknown as Sql;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx);
  }) as ReturnType<typeof fn>);
  const scope = { controlWorkspaceId: control, organizationId: organization, customerWorkspaceId: customer };
  // A private collector fixture, never an actual customer invoice. Persist it
  // through the production billing store so an accidental ledger join is caught.
  expect(await store.append({ ...scope, provider: 'papercusp', recordId: randomUUID(), usageId: randomUUID(),
    revision: 1, category: 'platform-overhead', payer: 'consumption', occurredAtMs: now, observedAtMs: now,
    quantity: 1, unit: 'service-period', costSource: 'provider-billed', costMicros: 7_000_000,
    sourceRef: 'fixture:papercusp-service-charge' })).toBe('recorded');
  const statement = await createHostedUsageSource({ store, maximumAgeMs: 60_000 })({
    scope, month: new Date(now).toISOString().slice(0, 7), asOfMs: now + 1,
  });
  expect(statement.lines).toEqual([expect.objectContaining({ provider: 'papercusp', billedMicros: 7_000_000 })]);
  expect(statement.consumptionBilled.micros).toBe(7_000_000);
  expect(statement.settlementEligible).toBe(false);
  expect(statement.gaps).toContain('incomplete-source');
  expect(statement.forecast.projectedConsumptionMicros).toBeNull();
  const after = await local();
  expect(after.totals).toEqual(before.totals);
  expect(after.totals).toMatchObject({ runs: 3, reportedUsd: 0.2, estimatedUsd: 0.1, unpricedCalls: 1 });
  expect(after.totals.costUsd).toBeCloseTo(0.3);
  expect(after.recentCalls?.map(call => call.costSource)).toEqual(['provider', 'estimated', 'unknown']);
  expect(after.recentCalls?.[2].costUsd).toBeNull();
  expect(after.byModel.some(row => row.key === 'papercusp')).toBe(false);
});
