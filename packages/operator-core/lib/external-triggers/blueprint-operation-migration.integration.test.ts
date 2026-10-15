import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../../..');
const armed = path.join(REPO, 'libs/papercusp/libs/db/sql/1228-blueprint-operation-automation-bindings.sql');
// Copy-out mutation probes supply a scratch SQL file while ordinary runs use the
// armed migration. This keeps the canonical submodule clean throughout the probe.
const migrationPath = process.env.PAPERCUSP_BLUEPRINT_OPERATION_MIGRATION_PROBE_PATH
  ?? (existsSync(armed) ? armed : `${armed}.DRAFT`);
const migrationSql = readFileSync(migrationPath, 'utf8');
const WS = 'ws-trigger-operation-migration';

let org: OrgTestDb;
let sql: Sql;
let sourceId: string;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  await sql.unsafe(migrationSql);
  await sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash)
    VALUES (${WS}, 'papercusp', 'legacy-plan', 'Legacy', 'ready', '# Legacy', 'legacy-v1')`;
  const sources = await sql<Array<{ id: string }>>`
    INSERT INTO harness_shared.data_sources (workspace_id, kind, status)
    VALUES (${WS}, 'slack', 'connected') RETURNING id::text`;
  sourceId = sources[0]!.id;
});

afterAll(async () => {
  await org?.cleanup();
});

describe('migration 1228 — blueprint-operation automation binding target', () => {
  it('is idempotent and keeps legacy plan targets valid', async () => {
    await expect(sql.unsafe(migrationSql)).resolves.toBeDefined();
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern, action)
      VALUES (${WS}, ${sourceId}::uuid, 'papercusp', 'legacy-plan', 'ext:slack:mention',
              '{"type":"launch-plan"}'::jsonb)
    `).resolves.toBeDefined();
  });

  it('accepts one validated operation action target and no target columns', async () => {
    const rows = await sql<Array<{ action: Record<string, unknown> }>>`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, event_pattern, action)
      VALUES (${WS}, ${sourceId}::uuid, 'ext:slack:mention',
              ${JSON.stringify({
                type: 'blueprint-operation',
                operationHarnessSlug: 'papercusp',
                operationId: 'triage-message',
                input: { priority: 'normal' },
              })}::text::jsonb)
      RETURNING action`;
    expect(rows[0]!.action).toMatchObject({ type: 'blueprint-operation', operationId: 'triage-message' });
  });

  it('refuses malformed, target-less and double-target operation rows', async () => {
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, event_pattern, action)
      VALUES (${WS}, ${sourceId}::uuid, 'ext:slack:missing-id',
              '{"type":"blueprint-operation","operationHarnessSlug":"papercusp"}'::jsonb)
    `).rejects.toThrow(/trigger_bindings_blueprint_operation_action_check/);
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, event_pattern, action)
      VALUES (${WS}, ${sourceId}::uuid, 'ext:slack:no-target', '{"type":"send-webhook"}'::jsonb)
    `).rejects.toThrow(/trigger_bindings_exactly_one_target/);
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, event_pattern, action)
      VALUES (${WS}, ${sourceId}::uuid, 'ext:slack:missing-action-type', '{}'::jsonb)
    `).rejects.toThrow(/trigger_bindings_exactly_one_target/);
    await expect(sql`
      INSERT INTO harness_shared.trigger_bindings
        (workspace_id, source_id, plan_harness_slug, plan_slug, event_pattern, action)
      VALUES (${WS}, ${sourceId}::uuid, 'papercusp', 'legacy-plan', 'ext:slack:double',
              '{"type":"blueprint-operation","operationHarnessSlug":"papercusp","operationId":"triage-message"}'::jsonb)
    `).rejects.toThrow(/trigger_bindings_exactly_one_target/);
  });
});
