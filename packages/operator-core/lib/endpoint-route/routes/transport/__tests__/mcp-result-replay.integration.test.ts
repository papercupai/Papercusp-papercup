/**
 * MCP write idempotency / result replay — regression for full-app-audit
 * P-046 (EI-68), mig 220 + _mcp-result-replay.ts.
 *
 * The reconnect contract: a tools/call carrying `_meta.idempotencyKey`
 * persists its serialized result; a re-call with the SAME key (after the
 * first response died on a dropped connection) replays the stored
 * outcome, tagged `_meta.replayed: true`, instead of re-executing.
 *
 * Isolated-Postgres test against harness_shared.mcp_tool_results.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { getOrgPg } from '@papercusp/db-org';
import type { OrgTestDb } from '../../../../../test/_org-test-db';
import {
  validIdempotencyKey,
  lookupStoredMcpResult,
  serializeStoredMcpResult,
  storeMcpResult,
  claimPendingMcpResult,
  sweepExpiredMcpResults,
  type StoredMcpResult,
} from '../_mcp-result-replay';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { createOrgTestDb } = await import('../../../../../test/_org-test-db');

const RUN = Date.now();
const OWNER_A = `replay-test-owner-a-${RUN}`;
const OWNER_B = `replay-test-owner-b-${RUN}`;

const RESULT: StoredMcpResult = {
  content: [{ type: 'text', text: '{"ok":true,"created":"WI-42"}' }],
  _meta: { format: 'json' },
};

describe('MCP result replay (audit P-046 / EI-68)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
  }, 120_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('validates caller-supplied keys (non-empty bounded strings only)', () => {
    expect(validIdempotencyKey('write-1')).toBe('write-1');
    expect(validIdempotencyKey('  padded ')).toBe('padded');
    expect(validIdempotencyKey('')).toBeNull();
    expect(validIdempotencyKey('   ')).toBeNull();
    expect(validIdempotencyKey(42)).toBeNull();
    expect(validIdempotencyKey(undefined)).toBeNull();
    expect(validIdempotencyKey('x'.repeat(201))).toBeNull();
  });

  // EI-21508946450217911: the stored receipt must carry structuredContent, or
  // every replay of an outputSchema-declaring tool (scheduler:get_next) fails
  // the SDK's client-side contract check (-32600) and the prescribed
  // idempotent-recovery path can never return a schema-valid verdict.
  it('serializes structuredContent into the stored receipt when present', () => {
    const structured = { ok: true, claimReceipt: { workItemId: 'EI-1', committed: true } };
    const json = serializeStoredMcpResult({
      content: [{ type: 'text', text: '{"ok":true}' }],
      _meta: { format: 'json' },
      structuredContent: structured,
    });
    const parsed = JSON.parse(json) as { structuredContent?: unknown };
    expect(parsed.structuredContent).toEqual(structured);
  });

  it('omits the structuredContent key for results that never had one (shape unchanged)', () => {
    const json = serializeStoredMcpResult(RESULT);
    expect(JSON.parse(json)).not.toHaveProperty('structuredContent');
  });

  it('stores a result and replays it tagged _meta.replayed', async () => {
    expect(await lookupStoredMcpResult(OWNER_A, 'k1')).toBeNull();

    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k1',
      toolName: 'work_items:create',
      workspaceId: 'default',
      result: RESULT,
    });

    const replayed = await lookupStoredMcpResult(OWNER_A, 'k1');
    expect(replayed).not.toBeNull();
    expect(replayed!.content).toEqual(RESULT.content);
    expect(replayed!._meta).toMatchObject({ format: 'json', replayed: true });
    expect(replayed!.isError).toBeUndefined();
  });

  it('keys are scoped per owner — another caller with the same key sees nothing', async () => {
    expect(await lookupStoredMcpResult(OWNER_B, 'k1')).toBeNull();
  });

  it('first write wins — a concurrent same-key store never clobbers the original', async () => {
    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k1',
      toolName: 'work_items:create',
      workspaceId: 'default',
      result: { content: [{ type: 'text', text: 'SECOND EXECUTION' }] },
    });
    const replayed = await lookupStoredMcpResult(OWNER_A, 'k1');
    expect(replayed!.content).toEqual(RESULT.content);
  });

  it('error results replay with isError preserved', async () => {
    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k-err',
      toolName: 'plans:set-status',
      workspaceId: 'default',
      result: { content: [{ type: 'text', text: 'claim_conflict: held by peer' }], isError: true },
    });
    const replayed = await lookupStoredMcpResult(OWNER_A, 'k-err');
    expect(replayed!.isError).toBe(true);
    expect(replayed!._meta).toMatchObject({ replayed: true });
  });

  it(
    'replays an output-schema tool result with its structuredContent intact (scheduler:get_next recovery shape)',
    async () => {
      const structured = {
        ok: true,
        claimReceipt: { committed: true, workItemId: 'EI-21508946450217911', specId: 'nonp2p-bug-drain' },
      };
      await storeMcpResult({
        ownerKey: OWNER_A,
        idempotencyKey: 'k-structured',
        toolName: 'scheduler:get_next',
        workspaceId: 'default',
        result: {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          _meta: { format: 'json' },
          structuredContent: structured,
        },
      });
      const replayed = await lookupStoredMcpResult(OWNER_A, 'k-structured');
      expect(replayed).not.toBeNull();
      expect(replayed!.structuredContent).toEqual(structured); // THE regression: schema-valid replay
      expect(replayed!._meta).toMatchObject({ format: 'json', replayed: true });
    },
  );

  it('retains a non-idempotent pot creation receipt across the generic expiry and sweep', async () => {
    const { sql } = getOrgPg();
    await storeMcpResult({ ownerKey: OWNER_A, idempotencyKey: 'old-pot-create',
      toolName: 'pot:create_from_repo', workspaceId: 'default', result: RESULT });
    await sql`UPDATE harness_shared.mcp_tool_results SET created_at = now() - interval '2 hours'
      WHERE owner_key = ${OWNER_A} AND idempotency_key = 'old-pot-create'`;
    await sweepExpiredMcpResults();
    expect((await lookupStoredMcpResult(OWNER_A, 'old-pot-create'))?.content).toEqual(RESULT.content);
  });
  it('retains an unfinished pot operation so another process cannot claim it after expiry', async () => {
    const { sql } = getOrgPg();
    const input = { ownerKey: OWNER_A, idempotencyKey: 'old-pending-pot', toolName: 'pot:create_from_repo',
      workspaceId: 'default', result: { ...RESULT, _meta: { state: 'pending', progressId: 'original' } } };
    expect((await claimPendingMcpResult(input)).claimed).toBe(true);
    await sql`UPDATE harness_shared.mcp_tool_results SET created_at = now() - interval '2 hours'
      WHERE owner_key = ${OWNER_A} AND idempotency_key = 'old-pending-pot'`;
    await sweepExpiredMcpResults();
    expect(await claimPendingMcpResult(input)).toMatchObject({ claimed: false, pending: true });
    expect(await lookupStoredMcpResult(OWNER_A, 'old-pending-pot')).toBeNull();
  });
  it('the sweep removes ordinary rows past the 1h TTL; lookup ignores them either way', async () => {
    const { sql } = getOrgPg();
    await storeMcpResult({
      ownerKey: OWNER_A,
      idempotencyKey: 'k-old',
      toolName: 'plans:set-now',
      workspaceId: 'default',
      result: RESULT,
    });
    await sql`
      UPDATE harness_shared.mcp_tool_results
         SET created_at = now() - interval '2 hours'
       WHERE owner_key = ${OWNER_A} AND idempotency_key = 'k-old'
    `;
    // Expired → invisible to lookup even before the sweep runs.
    expect(await lookupStoredMcpResult(OWNER_A, 'k-old')).toBeNull();

    const swept = await sweepExpiredMcpResults();
    expect(swept).toBeGreaterThanOrEqual(1);
    const rows = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.mcp_tool_results
       WHERE owner_key = ${OWNER_A} AND idempotency_key = 'k-old'
    `;
    expect(Number(rows[0].n)).toBe(0);
    // Fresh rows survive.
    expect(await lookupStoredMcpResult(OWNER_A, 'k1')).not.toBeNull();
  });

});
