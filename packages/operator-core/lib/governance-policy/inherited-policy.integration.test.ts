/**
 * inherited-policy.integration.test.ts — inherited organization > department > workspace policy
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, WI-10007900) against a REAL
 * Postgres, with the REAL migration 1497 applied (not a hand copy), so schema drift fails here.
 *
 * What a fake-sql unit test cannot prove:
 *  - the recursive chain walk returns the workspace's chain ROOT FIRST, across a department;
 *  - a lower layer that tries to widen an ancestor still loses at evaluation time, end to end
 *    from stored rows (fail-closed intersection), and the refusal names the deciding layer;
 *  - an expiring exception written through upsertLayer is honoured while live and not after;
 *  - every write appends a version row carrying actor + reason + content hash (versioned evidence);
 *  - optimistic concurrency (expectedVersion) and parent validation refuse with typed codes;
 *  - a row that bypassed write validation is reported as `malformed`, never evaluated as policy;
 *  - the DB constraints themselves refuse a parentless workspace layer and an empty reason.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  GovernancePolicyWriteError,
  listVersions,
  loadChainForWorkspace,
  upsertLayer,
  type UpsertLayerInput,
} from './store';
import { evaluateInheritedPolicy } from './inherited-policy';

const MIGRATION = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/1497-governance-policy-layers.sql', import.meta.url),
);

let sql: postgres.Sql;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `govpolicy_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  await sql.unsafe(readFileSync(MIGRATION, 'utf8'));
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await sql.unsafe(
    `TRUNCATE harness_shared.governance_policy_layer_versions, harness_shared.governance_policy_layers`,
  );
});

const base = { actor: 'su-admin', reason: 'pilot baseline' };

function layer(over: Partial<UpsertLayerInput> & Pick<UpsertLayerInput, 'layerId' | 'level' | 'scopeRef'>): UpsertLayerInput {
  return { parentLayerId: null, rules: {}, exceptions: [], ...base, ...over };
}

/** org (allows two models, denies egress to *.evil.example) > dept > workspace ws-1. */
async function seedTree(): Promise<void> {
  await upsertLayer(
    layer({
      layerId: 'org-acme',
      level: 'organization',
      scopeRef: 'acme',
      rules: { models: { allow: ['claude-*', 'gpt-5*'] }, egress: { deny: ['*.evil.example'] } },
    }),
    sql,
  );
  await upsertLayer(
    layer({
      layerId: 'dept-eng',
      level: 'department',
      scopeRef: 'acme/eng',
      parentLayerId: 'org-acme',
      rules: { tools: { deny: ['processes:kill'] } },
    }),
    sql,
  );
  await upsertLayer(
    layer({
      layerId: 'ws-1',
      level: 'workspace',
      scopeRef: 'ws-1',
      parentLayerId: 'dept-eng',
      // Tries to WIDEN the org's model allow-list. Inheritance must not let it.
      rules: { models: { allow: ['*'] } },
    }),
    sql,
  );
}

describe('inherited governance policy over real Postgres (P-005)', () => {
  it('loads the workspace chain root first, through the department', async () => {
    await seedTree();
    const load = await loadChainForWorkspace('ws-1', sql);
    expect(load.status).toBe('ok');
    if (load.status !== 'ok') return;
    expect(load.chain.map((l) => `${l.level}:${l.layerId}@v${l.version}`)).toEqual([
      'organization:org-acme@v1',
      'department:dept-eng@v1',
      'workspace:ws-1@v1',
    ]);
  });

  it('reports none for a workspace with no layer', async () => {
    await seedTree();
    expect(await loadChainForWorkspace('ws-unbound', sql)).toEqual({ status: 'none' });
  });

  it('a workspace layer cannot widen its organization: the org decides the refusal', async () => {
    await seedTree();
    const load = await loadChainForWorkspace('ws-1', sql);
    if (load.status !== 'ok') throw new Error(`chain ${load.status}`);

    expect(evaluateInheritedPolicy(load.chain, { models: ['claude-sonnet-5'] }).allow).toBe(true);

    const widened = evaluateInheritedPolicy(load.chain, { models: ['llama-4'] });
    expect(widened.allow).toBe(false);
    if (widened.allow) return;
    expect(widened.code).toBe('org_policy:denied');
    expect(widened.decidedBy).toMatchObject({ layerId: 'org-acme', level: 'organization', outcome: 'not-allowed' });

    const tool = evaluateInheritedPolicy(load.chain, { tools: ['processes:kill'] });
    expect(tool.allow).toBe(false);
    if (tool.allow) return;
    expect(tool.decidedBy).toMatchObject({ layerId: 'dept-eng', outcome: 'deny-rule', pattern: 'processes:kill' });

    const egress = evaluateInheritedPolicy(load.chain, { egress: ['api.evil.example'] });
    expect(egress.allow).toBe(false);
  });

  it('an expiring exception is honoured while live and lapses after expiry', async () => {
    await seedTree();
    const expiresAt = '2026-11-01T00:00:00.000Z';
    await upsertLayer(
      layer({
        layerId: 'org-acme',
        level: 'organization',
        scopeRef: 'acme',
        rules: { models: { allow: ['claude-*', 'gpt-5*'] }, egress: { deny: ['*.evil.example'] } },
        exceptions: [{ category: 'models', pattern: 'llama-4', reason: 'eval sprint', approvedBy: 'su-admin', expiresAt }],
        reason: 'temporary model exception',
        expectedVersion: 1,
      }),
      sql,
    );
    const load = await loadChainForWorkspace('ws-1', sql);
    if (load.status !== 'ok') throw new Error(`chain ${load.status}`);

    const live = evaluateInheritedPolicy(load.chain, { models: ['llama-4'] }, new Date('2026-10-20T00:00:00Z'));
    expect(live.allow).toBe(true);
    expect(live.trace.some((s) => s.outcome === 'excepted' && s.expiresAt === expiresAt)).toBe(true);

    const lapsed = evaluateInheritedPolicy(load.chain, { models: ['llama-4'] }, new Date('2026-11-02T00:00:00Z'));
    expect(lapsed.allow).toBe(false);
  });

  it('every write appends a version row with actor, reason and content hash', async () => {
    await seedTree();
    await upsertLayer(
      layer({
        layerId: 'ws-1',
        level: 'workspace',
        scopeRef: 'ws-1',
        parentLayerId: 'dept-eng',
        rules: { models: { allow: ['claude-*'] } },
        actor: 'su-second-admin',
        reason: 'narrow to one family',
        expectedVersion: 1,
      }),
      sql,
    );
    const versions = await listVersions('ws-1', 10, sql);
    expect(versions.map((v) => [v.version, v.actor, v.reason])).toEqual([
      [2, 'su-second-admin', 'narrow to one family'],
      [1, 'su-admin', 'pilot baseline'],
    ]);
    expect(versions[0]!.contentHash).not.toBe(versions[1]!.contentHash);
    expect(versions[0]!.rules).toEqual({ models: { allow: ['claude-*'] } });
    // Recurrence guard for the postgres-js double-encoding class: on this default-config pool a
    // `${JSON.stringify(x)}::jsonb` bind stores a jsonb STRING. Both tables must hold real objects/arrays.
    const shapes = await sql<Array<{ t: string; rules: string; exceptions: string }>>`
      SELECT 'layer' AS t, jsonb_typeof(rules) AS rules, jsonb_typeof(exceptions) AS exceptions
        FROM harness_shared.governance_policy_layers
      UNION ALL
      SELECT 'version', jsonb_typeof(rules), jsonb_typeof(exceptions)
        FROM harness_shared.governance_policy_layer_versions
    `;
    expect(shapes.length).toBeGreaterThan(0);
    for (const s of shapes) expect([s.t, s.rules, s.exceptions]).toEqual([s.t, 'object', 'array']);
  });

  it('refuses a stale expectedVersion and an unknown or illegal parent with typed codes', async () => {
    await seedTree();
    const stale = upsertLayer(
      layer({ layerId: 'ws-1', level: 'workspace', scopeRef: 'ws-1', parentLayerId: 'dept-eng', expectedVersion: 0 }),
      sql,
    );
    await expect(stale).rejects.toBeInstanceOf(GovernancePolicyWriteError);
    await expect(stale).rejects.toMatchObject({ code: 'conflict' });

    await expect(
      upsertLayer(layer({ layerId: 'ws-2', level: 'workspace', scopeRef: 'ws-2', parentLayerId: 'org-missing' }), sql),
    ).rejects.toMatchObject({ code: 'parent' });

    await expect(
      upsertLayer(layer({ layerId: 'ws-3', level: 'workspace', scopeRef: 'ws-3', parentLayerId: 'ws-1' }), sql),
    ).rejects.toMatchObject({ code: 'parent' });

    // A refused write appends no version row.
    expect((await listVersions('ws-1', 10, sql)).map((v) => v.version)).toEqual([1]);
  });

  it('a row that bypassed write validation is reported malformed, never evaluated as policy', async () => {
    await seedTree();
    await sql.unsafe(
      `UPDATE harness_shared.governance_policy_layers SET rules = '{"models":{"allow":"claude-*"}}'::jsonb WHERE layer_id = 'dept-eng'`,
    );
    const load = await loadChainForWorkspace('ws-1', sql);
    expect(load.status).toBe('malformed');
    if (load.status !== 'malformed') return;
    expect(load.reason).toContain('dept-eng');
  });

  it('the schema itself refuses a parentless workspace layer and an empty change reason', async () => {
    await expect(
      sql.unsafe(
        `INSERT INTO harness_shared.governance_policy_layers (layer_id, level, scope_ref, parent_layer_id, version, content_hash, updated_by)
         VALUES ('ws-orphan', 'workspace', 'ws-orphan', NULL, 1, 'h', 'x')`,
      ),
    ).rejects.toThrow(/governance_policy_layers_root_is_org/);

    await seedTree();
    await expect(
      sql.unsafe(
        `INSERT INTO harness_shared.governance_policy_layer_versions (layer_id, version, level, scope_ref, parent_layer_id, rules, exceptions, content_hash, actor, reason)
         VALUES ('ws-1', 9, 'workspace', 'ws-1', 'dept-eng', '{}', '[]', 'h', 'x', '   ')`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
