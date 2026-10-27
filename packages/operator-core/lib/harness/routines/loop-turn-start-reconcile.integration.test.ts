/** EI-24791346664119438: real producer/store/reconciler correlation before transcript ingest. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { Sql } from 'postgres';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

import { recordLoopTurnStart } from './loop-turn-start-stamp';
import { reconcileLoopRoutines } from './reconcile-loop-routines';
import { LOOP_TURN_START_MARKER } from '../../agent-tools/activity/lifecycle-markers';
import { tagTurnForInjection } from '../../turn-provenance/turn-provenance';
import { recordAdvSession, recordSuLaunchSpec } from '../../adv-sessions';
import { cleanupScopedNativeFixtureDatabase } from '../../../../../apps/operator/vitest-shims/scoped-native-fixture-cleanup';

let pg: DedicatedNativePg;
let org: OrgTestDb;
let sql: Sql;
const savedAdmin = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
const savedProvenanceDir = process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
const WS = 'ws-loop-start-correlation';
let provenanceDir: string | undefined;

beforeAll(async () => {
  // This acceptance owns its cluster: no live workspace or shared baseline mutex.
  pg = await startDedicatedNativePg();
  process.env.PAPERCUSP_TEST_PG_ADMIN_URL = pg.getConnectionUri();
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  provenanceDir = await mkdtemp(join(tmpdir(), 'pc-loop-turn-start-'));
  process.env.PAPERCUSP_TURN_PROVENANCE_DIR = join(provenanceDir, 'host-global');
}, 180_000);

afterAll(async () => {
  try {
    const flushed = await cleanupScopedNativeFixtureDatabase(org);
    expect(flushed?.failed).toBe(0);
  } finally {
    try {
      await pg?.stop();
    } finally {
      if (provenanceDir) await rm(provenanceDir, { recursive: true, force: true });
      if (savedAdmin === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
      else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = savedAdmin;
      if (savedProvenanceDir === undefined) delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
      else process.env.PAPERCUSP_TURN_PROVENANCE_DIR = savedProvenanceDir;
    }
  }
});

afterEach(() => vi.restoreAllMocks());

describe('loop turn-start producer to reconciler, real Postgres', () => {
  it('requires loop-fire prompt-start proof even when generic delivery proof observes tool use', async () => {
    const now = Date.now();
    const fired = new Date(now - 10_000);
    const dispatched = new Date(now - 5_000);
    const cases = [
      { id: 'rt-start-proof', owner: 'su-start-proof', enrolled: true, genericPickupObserved: false },
      { id: 'rt-no-start-proof', owner: 'su-no-start-proof', enrolled: false, genericPickupObserved: true },
    ];
    for (const c of cases) {
      await sql`
        INSERT INTO harness_shared.routines
          (id, install_slug, name, trigger_kind, trigger_config, target_role,
           active, workspace_id, last_fired_at, next_fire_at,
           reschedule_interval_sec, target_owner_id, metadata)
        VALUES (${c.id}, 'papercusp', ${c.id}, 'cron', '{}'::jsonb, 'su',
                TRUE, ${WS}, ${fired}, 'infinity'::timestamptz, 60, ${c.owner},
                ${JSON.stringify({ fire_count: 1 })}::jsonb)`;
      const awaits = await sql<Array<{ id: number }>>`
        INSERT INTO harness_shared.event_awaits (workspace_id, subscriber_id, event_key)
        VALUES (${WS}, ${c.owner}, ${'test:' + c.id}) RETURNING id`;
      // Generic event pickup can be observed from a PostToolUse hook in a turn that
      // was already running when the delivery arrived. It is not loop-fire prompt-start proof.
      const genericTurnProof = c.genericPickupObserved ? 'observed' : 'awaiting';
      const genericTurnStartedAt = c.genericPickupObserved ? new Date(dispatched.getTime() + 1_000) : null;
      await sql`
        INSERT INTO harness_shared.event_wake_deliveries
          (workspace_id, await_id, subscriber_id, event_key, source, status,
           channel, created_at, delivered_at, turn_proof, turn_started_at, pickup_deadline_at)
        VALUES (${WS}, ${awaits[0]!.id}, ${c.owner}, ${'test:' + c.id},
                ${'loop:' + c.id}, 'delivered', 'inbox', ${dispatched}, ${dispatched},
                ${genericTurnProof}, ${genericTurnStartedAt}, ${new Date(dispatched.getTime() + 600_000)})`;
      // Exercise the real producer and default PG telemetry writer, not a seeded marker.
      let prompt = 'An unrelated owner turn.';
      if (c.enrolled) {
        const launchId = await recordAdvSession({ workspaceId: WS, agent: 'codex', mode: 'omp',
          coordOwnerId: c.owner, sessionId: 'native-' + c.owner });
        expect(launchId).not.toBeNull();
        expect(await recordSuLaunchSpec(launchId!, c.owner, {
          v: 1, workspaceId: WS, turnProvenanceDir: provenanceDir,
        })).toBe(true);
        const tagged = await tagTurnForInjection({
          sid: c.owner,
          origin: 'loop-fire',
          text: 'Continue the loop.',
          loopFire: { routineId: c.id, wakeCount: 1 },
          dir: provenanceDir,
        });
        expect(tagged.ledgerWritten).toBe(true);
        prompt = tagged.taggedText;
      }
      if (c.enrolled) {
        // Use the actual endpoint over HTTP, including its unawaited producer.
        // Memory is disabled so this proves stamping independently of recall.
        const { default: routes } = await import('../../endpoint-route/routes/agent-mcp/turn-start-memory');
        const endpoint = routes[0] as unknown as { handler(req: Request): Promise<Response> };
        const server = createServer(async (incoming, outgoing) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
            const response = await endpoint.handler(new Request('http://127.0.0.1/api/agent-mcp/turn-start-memory', {
              method: incoming.method, body: Buffer.concat(chunks).toString(),
            }));
            outgoing.writeHead(response.status, { 'content-type': 'application/json' });
            outgoing.end(await response.text());
          } catch (error) {
            outgoing.writeHead(500);
            outgoing.end(String(error));
          }
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        // Optional recall legs can miss the real hook's wall without affecting
        // this stamp. Check that specific diagnostic; keep unexpected warnings red.
        const deadlineWarning = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
          expect(String(message)).toMatch(/^\[turn-start\] response deadline: omitted /);
        });
        try {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('private HTTP listener missing');
          const response = await fetch(`http://127.0.0.1:${address.port}/api/agent-mcp/turn-start-memory`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ owner: c.owner, workspace: WS, client: 'codex', prompt,
              memoryEnabled: false, wallMs: 2500 }),
          });
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({ ok: true });
          await vi.waitFor(async () => {
            const stamps = await sql`SELECT detail FROM harness_shared.agent_activity
              WHERE workspace_id = ${WS} AND owner_id = ${c.owner} AND summary = ${LOOP_TURN_START_MARKER}`;
            expect(stamps).toHaveLength(1);
            expect(stamps[0]!.detail).toMatchObject({ loopFire: { routineId: c.id, wakeCount: 1 } });
          }, { timeout: 10_000 });
        } finally {
          try {
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          } finally {
            deadlineWarning.mockRestore();
          }
        }
      } else {
        expect(await recordLoopTurnStart({ owner: c.owner, workspaceId: WS, client: 'codex', prompt })).toBe(false);
      }
    }

    const stamps = await sql<Array<{ owner_id: string; created_at: Date; summary: string }>>`
      SELECT owner_id, created_at, summary FROM harness_shared.agent_activity
       WHERE workspace_id = ${WS}`;
    expect(stamps).toHaveLength(1);
    expect(stamps[0]).toMatchObject({ owner_id: 'su-start-proof', summary: LOOP_TURN_START_MARKER });
    expect(stamps[0]!.created_at.getTime()).toBeGreaterThan(dispatched.getTime());
    const enrolledIdentity = await sql<Array<{ detail: Record<string, unknown> }>>`
      SELECT detail FROM harness_shared.agent_activity
       WHERE workspace_id = ${WS} AND owner_id = 'su-start-proof'`;
    expect(enrolledIdentity).toHaveLength(1);
    expect(enrolledIdentity[0]!.detail).toMatchObject({
      loopFire: { routineId: 'rt-start-proof', wakeCount: 1 },
    });

    const genericProof = await sql<Array<{ turn_proof: string; turn_started_at: Date }>>`
      SELECT turn_proof, turn_started_at FROM harness_shared.event_wake_deliveries
       WHERE workspace_id = ${WS} AND subscriber_id = 'su-no-start-proof'`;
    expect(genericProof).toHaveLength(1);
    expect(genericProof[0]).toMatchObject({ turn_proof: 'observed' });
    expect(genericProof[0]!.turn_started_at.getTime()).toBeGreaterThan(dispatched.getTime());

    const recordFire = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await reconcileLoopRoutines({
      sql, nowMs: now + 3 * 60_000,
      recordFire, readFireState: async () => null,
    });
    const rows = await sql<Array<{ id: string; parked: boolean }>>`
      SELECT id, next_fire_at = 'infinity'::timestamptz AS parked
        FROM harness_shared.routines WHERE workspace_id = ${WS} ORDER BY id`;
    expect(rows.find((r) => r.id === 'rt-start-proof')?.parked).toBe(true);
    expect(rows.find((r) => r.id === 'rt-no-start-proof')?.parked).toBe(false);
    expect(result.loops).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rt-no-start-proof', via: 'delivered-wake-no-loop-turn' }),
    ]));
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp', 'rt-no-start-proof', 'loop-delivered-wake-no-loop-turn', 'error',
    );
    expect(recordFire).not.toHaveBeenCalledWith(
      'papercusp', 'rt-start-proof', 'loop-delivered-wake-no-loop-turn', 'error',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("loop 'rt-no-start-proof'"));
  });
});
