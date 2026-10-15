/**
 * memory-federation-privacy.integration.test.ts — mem0-cross-machine-federation-2026-07-10
 * P-007: privacy + federation REAL-PG tests for shareable-flagged memory federation.
 *
 * Mirrors two existing patterns:
 *   - substrate-outbox-trigger.integration.test.ts (real capture-trigger proof against a
 *     hand-rolled, column-faithful table + the REAL migration DDL applied verbatim).
 *   - agent-facts/store.integration.test.ts (the SQL paths a pure fakeSql unit test
 *     deliberately can't exercise — the actual identity index, ON CONFLICT arbiter, and
 *     the fed_order_key LWW guard).
 *
 * `projections/p2p-memories.test.ts` already covers the wire-validator + fakeSql-level H6
 * source-partitioning/demux properties. This file proves what only a REAL Postgres can:
 *   1. a default (non-shareable) memory INSERT never reaches the outbox (dark by default),
 *   2. only shareable=true memories egress (the capture trigger's WHEN clause),
 *   3. (malformed/invalid rows dropped — see p2p-memories.test.ts's decodeValue coverage),
 *   4. a foreign/non-admitted pot's memory never lands locally (projection demux, against a
 *      REAL table — the private-pot leak guard),
 *   5. the fed_order_key LWW guard actually resolves conflicting writes last-writer-wins
 *      (a stale, out-of-order replay can never clobber a newer projected row),
 *   6. retraction-of-sharing (EI-10393): a remote put whose payload is not
 *      shareable:true DELETES that source's partition (the mig-563 un-share flip
 *      applies as a retraction; a never-shareable hostile put stores nothing;
 *      the local partition is immune).
 *
 * `createFreshPgDb` provisions only `harness_shared` + the fed_order_key fns (EI-9387) — the
 * capture infra (function + substrate_outbox) and memory_canonical's base shape live in
 * 000-baseline.sql, which is NOT replayed here. So (mirroring substrate-outbox-trigger's own
 * approach) this file hand-rolls a column-faithful copy of both, then applies the REAL
 * federation migrations (562/563/564) verbatim on top.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../../../../test/_pg-helpers';
import { buildMemoriesProjection } from '../projections/p2p-memories';

const WS = 'ws_mem_fed';
const SLUG = 'mem-fed-home';
const LOCAL_PROVENANCE = { authorPubkey: '', origin: 'local' as const };

interface OutboxRow {
  id: string | number;
  workspace_id: string;
  harness_slug: string;
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
}

describe('mem0 federation privacy + LWW (real PG, mem0-cross-machine-federation-2026-07-10 P-007)', () => {
  let db: FreshPgDb;
  // Exercise the projection's privacy/LWW path independently of the live dark
  // gate. The explicit OFF control below guards the production gate itself.
  const projection = (enabled = true) => buildMemoriesProjection({
    workspaceId: WS,
    harnessSlug: SLUG,
    sql: db.sql,
    isFlagOn: async () => enabled,
  });

  beforeAll(async () => {
    db = await createFreshPgDb('mem-fed-privacy');

    // The capture-trigger infra (baseline-foundational; 000-baseline.sql L10-53 / L2521,
    // reproduced verbatim — createFreshPgDb only provisions harness_shared + fed_order_key).
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.substrate_outbox (
        id           BIGSERIAL PRIMARY KEY,
        workspace_id TEXT   NOT NULL,
        harness_slug TEXT   NOT NULL,
        table_name   TEXT   NOT NULL,
        op           TEXT   NOT NULL CHECK (op IN ('put', 'del')),
        key          TEXT   NOT NULL,
        row          JSONB,
        ts           BIGINT NOT NULL,
        enqueued_at_ms BIGINT NOT NULL DEFAULT ((EXTRACT(epoch FROM now()) * 1000)::bigint),
        drained_at   BIGINT
      );

      CREATE OR REPLACE FUNCTION harness_shared.capture_substrate_outbox() RETURNS trigger
          LANGUAGE plpgsql
          AS $$
          DECLARE
            v_op      TEXT;
            v_rec     RECORD;
            v_origin  TEXT;
            v_key     TEXT;
            v_row     JSONB;
            v_ws      TEXT;
            v_slug    TEXT;
            v_keycol  TEXT := TG_ARGV[0];
          BEGIN
            IF (TG_OP = 'DELETE') THEN
              v_op := 'del';
              v_rec := OLD;
            ELSE
              v_op := 'put';
              v_rec := NEW;
            END IF;

            v_row := to_jsonb(v_rec);
            v_origin := v_row ->> 'origin';

            -- Echo-loop guard: skip remote-origin writes (the projection's own writes).
            IF COALESCE(v_origin, 'local') <> 'local' THEN
              RETURN v_rec;
            END IF;

            v_key  := v_row ->> v_keycol;
            v_ws   := COALESCE(v_row ->> 'workspace_id', '');
            v_slug := v_row ->> 'harness_slug';

            INSERT INTO harness_shared.substrate_outbox
              (workspace_id, harness_slug, table_name, op, key, row, ts)
            VALUES
              (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
               (extract(epoch from now()) * 1000)::bigint);

            PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

            RETURN v_rec;
          END;
          $$;
    `);

    // Column-faithful memory_canonical: 000-baseline.sql L1603 base shape PLUS
    // mig-398's real GENERATED-STORED workspace_id/user_id (production carries
    // these as generated columns since 398 — reproduced verbatim here, not
    // simplified to plain columns, specifically so a projection write path that
    // tries to INSERT an explicit value into a GENERATED column fails here
    // exactly as it would against the real schema).
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.memory_canonical (
        id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
        payload jsonb DEFAULT '{}'::jsonb NOT NULL,
        created_at timestamptz DEFAULT now() NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL,
        state text DEFAULT 'active' NOT NULL,
        user_id text GENERATED ALWAYS AS (payload->>'user_id') STORED,
        workspace_id text GENERATED ALWAYS AS (payload->>'workspace_id') STORED
      );
    `);

    // Apply the REAL federation migrations verbatim.
    // EI-18808675015292160: applyMigrationsForTest AUDITS this list before
    // applying it. 570 + 578 were MISSING and that is what reddened this file —
    // 578 adds memory_canonical.valid_at, so the suite failed with
    // `column "valid_at" ... does not exist`, naming a column and never the list.
    await applyMigrationsForTest(
      db.sql,
      [
        '562-memory-shareable-federation.sql',
        '563-memory-federation-capture-triggers.sql',
        '564-memory-federation-columns.sql',
        '570-memory-canonical-rls.sql',
        '578-memory-canonical-temporal-lite.sql',
        // 757 adds memory_canonical.row_kind — another GENERATED-STORED column, so it
        // belongs here for the same reason 398's are reproduced above: this fixture's
        // whole point is that a write path attempting to INSERT an explicit value into
        // a generated column fails here exactly as it would in production.
        '757-memory-canonical-row-kind-discriminator.sql',
        '1312-memory-canonical-hot-surfaced-bump.sql',
      ],
      { label: 'memory-federation-privacy.integration.test.ts' },
    );
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  afterEach(async () => {
    await db.sql.unsafe('TRUNCATE harness_shared.memory_canonical, harness_shared.substrate_outbox');
  });

  const outboxFor = (id: string) =>
    db.sql<
      OutboxRow[]
    >`SELECT * FROM harness_shared.substrate_outbox WHERE key = ${id} ORDER BY id ASC`;

  // `harnessSlug` is a PHYSICAL column (mig 564 ADDs it plain, unlike workspace_id/
  // user_id which mig 398 made GENERATED from payload) — a real local write (e.g.
  // memory:remember) sets both the payload key AND this column, so the capture
  // trigger's `to_jsonb(NEW)` sees it.
  //
  // NOTE: `payload` is bound as `${JSON.stringify(payload)}::text::jsonb` — the
  // CANONICAL jsonb-write form (postgres-js-jsonb-binding agent-insight): correct
  // under both this testcontainer client AND the operator runtime client. A bare
  // `${payload}::jsonb` (no `::text`) double-encodes here (payload lands as a
  // JSON *string* scalar), which silently breaks every `payload->>'…'` GENERATED
  // column, incl. `shareable` — this bit the first draft of this very test file.
  const insertMemory = (id: string, payload: Record<string, unknown>, harnessSlug: string | null = null) =>
    db.sql`INSERT INTO harness_shared.memory_canonical (id, payload, harness_slug)
      VALUES (${id}::uuid, ${JSON.stringify(payload)}::text::jsonb, ${harnessSlug})`;

  // ── (1) + (2): capture-trigger privacy gate — dark by default ─────────────
  describe('capture trigger: only shareable=true memories reach the outbox', () => {
    it('a DEFAULT (no shareable key) memory INSERT enqueues NOTHING — dark by default', async () => {
      const id = '11111111-1111-1111-1111-111111111111';
      await insertMemory(id, { user_id: 'u1', workspace_id: WS, text: 'a private note' });
      const rows = await outboxFor(id);
      expect(rows).toHaveLength(0);
    });

    it('an EXPLICIT shareable:false memory INSERT also enqueues NOTHING', async () => {
      const id = '22222222-2222-2222-2222-222222222222';
      await insertMemory(id, { user_id: 'u1', workspace_id: WS, shareable: false, text: 'still private' });
      const rows = await outboxFor(id);
      expect(rows).toHaveLength(0);
    });

    it('a shareable:true memory INSERT enqueues exactly one put row carrying the full row', async () => {
      const id = '33333333-3333-3333-3333-333333333333';
      await insertMemory(id, { user_id: 'u1', workspace_id: WS, shareable: true, text: 'ok to share' }, SLUG);
      const rows = await outboxFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].op).toBe('put');
      expect(rows[0].table_name).toBe('memory_canonical');
      expect(rows[0].row).toMatchObject({ id, harness_slug: SLUG });
    });

    it('a private edit never egresses; flipping shareable false→true captures the sharing event', async () => {
      const id = '44444444-4444-4444-4444-444444444444';
      await insertMemory(id, { user_id: 'u1', workspace_id: WS, shareable: false });

      await db.sql`UPDATE harness_shared.memory_canonical
        SET payload = payload || ${JSON.stringify({ note: 'edited while private' })}::text::jsonb
        WHERE id = ${id}::uuid`;
      expect(await outboxFor(id)).toHaveLength(0); // private edits never egress

      await db.sql`UPDATE harness_shared.memory_canonical
        SET payload = payload || ${JSON.stringify({ shareable: true })}::text::jsonb, harness_slug = ${SLUG}
        WHERE id = ${id}::uuid`;
      const rows = await outboxFor(id);
      expect(rows).toHaveLength(1); // the flip-to-shareable itself captures
      expect(rows[0].row).toMatchObject({ shareable: true });
    });

    it('DELETE of a shareable memory enqueues a del row; DELETE of a private memory enqueues nothing', async () => {
      const shared = '55555555-5555-5555-5555-555555555555';
      const priv = '66666666-6666-6666-6666-666666666666';
      await insertMemory(shared, { shareable: true }, SLUG);
      await insertMemory(priv, { shareable: false });

      await db.sql`DELETE FROM harness_shared.memory_canonical WHERE id = ${shared}::uuid`;
      await db.sql`DELETE FROM harness_shared.memory_canonical WHERE id = ${priv}::uuid`;

      const sharedRows = await outboxFor(shared);
      expect(sharedRows.some((r) => r.op === 'del')).toBe(true);
      expect(await outboxFor(priv)).toHaveLength(0);
    });
  });

  // ── (4): projection-layer private-pot leak guard, against the REAL table ──
  describe('projection demux: a foreign/non-admitted pot memory never lands (no leak)', () => {
    it('keeps remote puts, retractions and deletes inert while the gate is OFF', async () => {
      const id = '22222222-2222-2222-2222-222222222222';
      const otherId = '33333333-3333-3333-3333-333333333333';
      const row = {
        harness_slug: SLUG,
        id,
        payload: { shareable: true, workspace_id: WS, text: 'existing shared memory' },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const provenance = { authorPubkey: 'admitted-peer', origin: 'remote', ts: 100 } as never;
      await projection().writeToPg(row, provenance);
      expect(await db.sql`SELECT id FROM harness_shared.memory_canonical WHERE id = ${id}::uuid`).toHaveLength(1);

      const disabled = projection(false);
      await disabled.writeToPg({ ...row, id: otherId }, provenance);
      await disabled.writeToPg({ ...row, payload: { ...row.payload, shareable: false } }, provenance);
      await disabled.deleteFromPg(id, 200);
      const rows = await db.sql`SELECT id FROM harness_shared.memory_canonical`;
      expect(rows).toEqual([{ id }]);
    });

    it('a wire row scoped to a DIFFERENT (non-admitted) pot never inserts', async () => {
      const proj = projection();
      const id = '77777777-7777-7777-7777-777777777777';
      await proj.writeToPg(
        {
          harness_slug: 'other-pot-not-admitted',
          id,
          payload: { shareable: true, workspace_id: WS },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { authorPubkey: 'peer-1', origin: 'remote' } as never,
      );
      const rows = await db.sql`SELECT 1 FROM harness_shared.memory_canonical WHERE id = ${id}::uuid`;
      expect(rows).toHaveLength(0);
    });

    it('a wire row scoped to THIS pot from an admitted peer lands under its receiver-stamped source partition', async () => {
      const proj = projection();
      const id = '88888888-8888-8888-8888-888888888888';
      await proj.writeToPg(
        {
          harness_slug: SLUG,
          id,
          payload: { shareable: true, workspace_id: WS, text: 'peer memory' },
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { authorPubkey: 'admitted-peer', origin: 'remote' } as never,
      );
      const rows = await db.sql`SELECT source_hive, origin FROM harness_shared.memory_canonical WHERE id = ${id}::uuid`;
      expect(rows).toHaveLength(1);
      expect(rows[0].source_hive).toBe('admitted-peer');
      expect(rows[0].origin).toBe('remote');
    });
  });

  // ── (6): retraction-of-sharing applied on receive (EI-10393) ──────────────
  // mig 563 deliberately captures the shareable true→false flip as a PUT
  // ("peers apply the retraction of sharing") — the projection must DELETE that
  // source's partition on such an op, never store the now-private content.
  describe('retraction-of-sharing: a remote non-shareable put deletes that source partition', () => {
    const mkProj = () => projection();
    const wire = (id: string, payload: Record<string, unknown>) => ({
      harness_slug: SLUG,
      id,
      payload,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const rowsFor = (id: string) =>
      db.sql`SELECT source_hive FROM harness_shared.memory_canonical WHERE id = ${id}::uuid`;

    it('the un-share flip op removes the peer copy (content no longer held)', async () => {
      const proj = mkProj();
      const id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      await proj.writeToPg(
        wire(id, { shareable: true, workspace_id: WS, text: 'shared for a while' }),
        { authorPubkey: 'peer-1', origin: 'remote', ts: 100 } as never,
      );
      expect(await rowsFor(id)).toHaveLength(1);

      await proj.writeToPg(
        wire(id, { shareable: false, workspace_id: WS, text: 'shared for a while' }),
        { authorPubkey: 'peer-1', origin: 'remote', ts: 200 } as never,
      );
      expect(await rowsFor(id)).toHaveLength(0); // retraction APPLIED, not stored
    });

    it('LWW: a STALE retraction replay can never delete a newer re-share', async () => {
      const proj = mkProj();
      const id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      await proj.writeToPg(
        wire(id, { shareable: true, workspace_id: WS, text: 're-shared' }),
        { authorPubkey: 'peer-1', origin: 'remote', ts: 300 } as never,
      );
      await proj.writeToPg(
        wire(id, { shareable: false, workspace_id: WS }),
        { authorPubkey: 'peer-1', origin: 'remote', ts: 200 } as never, // stale retraction
      );
      expect(await rowsFor(id)).toHaveLength(1); // the newer re-share survived
    });

    it('a NEVER-shared non-shareable put stores nothing (hostile/buggy sender)', async () => {
      const id = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      await mkProj().writeToPg(
        wire(id, { workspace_id: WS, text: 'hostile private push, no shareable key' }),
        { authorPubkey: 'hostile-peer', origin: 'remote', ts: 100 } as never,
      );
      expect(await rowsFor(id)).toHaveLength(0);
    });

    it('a LOCAL-origin echo with shareable:false never deletes the local partition', async () => {
      const id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      await insertMemory(id, { user_id: 'u1', workspace_id: WS, shareable: false, text: 'local private row' }, SLUG);
      await mkProj().writeToPg(
        wire(id, { user_id: 'u1', workspace_id: WS, shareable: false, text: 'local private row' }),
        LOCAL_PROVENANCE,
      );
      const rows = await rowsFor(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].source_hive).toBeNull(); // still the untouched local partition
    });
  });

  // ── (5): fed_order_key LWW guard resolves conflicting writes last-writer-wins ──
  describe('fed_order_key LWW guard resolves last-writer-wins', () => {
    it('a newer fed_ts write wins; a STALE out-of-order write arriving after is refused', async () => {
      const proj = projection();
      const id = '99999999-9999-9999-9999-999999999999';
      const wire = (text: string) => ({
        harness_slug: SLUG,
        id,
        payload: { shareable: true, workspace_id: WS, text },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      await proj.writeToPg(wire('v1-old'), { authorPubkey: 'peer-1', origin: 'remote', ts: 100 } as never);
      await proj.writeToPg(wire('v2-newer'), { authorPubkey: 'peer-1', origin: 'remote', ts: 200 } as never);

      let [row] = await db.sql<{ payload: { text: string } }[]>`
        SELECT payload FROM harness_shared.memory_canonical WHERE id = ${id}::uuid AND source_hive = 'peer-1'`;
      expect(row.payload.text).toBe('v2-newer');

      // A stale (older-ts) replay arriving LATE must NOT clobber the newer state.
      await proj.writeToPg(wire('v0-stale-replay'), { authorPubkey: 'peer-1', origin: 'remote', ts: 150 } as never);
      [row] = await db.sql<{ payload: { text: string } }[]>`
        SELECT payload FROM harness_shared.memory_canonical WHERE id = ${id}::uuid AND source_hive = 'peer-1'`;
      expect(row.payload.text).toBe('v2-newer'); // still the newer write — LWW held
    });

    // NOTE: a "two DIFFERENT source partitions of the same identity" case (two
    // peers each relaying/observing the SAME memory id) is NOT covered here —
    // it surfaced a separate, pre-existing schema defect: memory_canonical's
    // actual PRIMARY KEY is `(id)` alone (000-baseline.sql), never widened to
    // the composite `(workspace_id, id, coalesce(source_hive,''))` H6 identity
    // mig 564's own comments describe (unlike agent_facts, whose mig 461
    // rebuilt ITS identity index to the 5-column composite). A second
    // source_hive partition for the same id throws
    // `duplicate key value violates unique constraint "memory_canonical_pkey"`.
    // Widening the PK is a real but separate, higher-risk fix (memory_anchors /
    // memory_vec_local / memory_vec_openai all FK ON DELETE CASCADE against
    // `memory_canonical(id)` alone) — filed as a follow-up rather than bundled
    // into this test-authoring pass; see the WI-4305 completion note.
  });
});
