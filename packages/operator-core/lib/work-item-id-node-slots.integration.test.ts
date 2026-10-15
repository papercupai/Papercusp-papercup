/**
 * scope-unique-identifiers-2026-07-26 P-010 (decisions D-005, D-006), against real Postgres.
 *
 * Migration 1442 gives each federating database its own block of WI- ids:
 * id = node_slot * 10^11 + work_item_seq. A database that has never federated
 * keeps slot 0, so its ids are unchanged. These tests apply the real migration
 * chain (1003 → 1218 → 1442) on the consolidated work_items fixture.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../libs/papercusp/libs/db/sql');
const BLOCK = 100_000_000_000n;
const MAX_SLOT = 90_070n;

function readMigration(file: string, marker: string): string {
  const armed = resolve(SQL_DIR, file);
  const draft = `${armed}.DRAFT`;
  const path = existsSync(armed) ? armed : draft;
  if (!existsSync(path)) throw new Error(`migration not found at ${armed} or ${draft}`);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(marker)) throw new Error(`migration at ${path} does not contain ${marker}`);
  return text;
}

const MIGRATION_1003 = readMigration('1003-work-item-sequence-federation-floor.sql', 'work_items_advance_id_sequence');
const MIGRATION_1218 = readMigration('1218-work-item-floor-lockfree-fast-path.sql', 'advance_work_item_seq_from_insert');
const MIGRATION_1442 = readMigration('1442-work-item-id-node-slots.sql', 'claim_work_item_id_slot');

/** The slot the migration derives from a node id: 1 + (first 8 hex as uint32) mod 90070. */
function expectedSlot(nodeId: string): bigint {
  return 1n + (BigInt(`0x${nodeId.slice(0, 8)}`) % MAX_SLOT);
}

const NODE_ID = '00c0ffee12345678';
const SLOT = expectedSlot(NODE_ID);

let db: FreshPgDb;

async function nextId(on: FreshPgDb = db): Promise<string> {
  const rows = await on.sql<Array<{ id: string }>>`SELECT harness_shared.next_work_item_id() AS id`;
  return rows[0]!.id;
}

async function insertRow(
  featureId: string,
  origin: 'local' | 'remote',
  harness = 'papercusp',
  on: FreshPgDb = db,
): Promise<void> {
  await on.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin)
    VALUES ('papercusp-workspace', ${harness}, ${featureId}, ${`row ${featureId}`}, 'open', 'task', ${origin})`;
}

/** The consolidated work_items fixture, a minimal HLC clock, and the real 1003 → 1218 → 1442 chain. */
async function applyFixture(target: FreshPgDb): Promise<void> {
  await target.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  // Minimal HLC clock: the claim reads the node id; hlc_now() mints one when empty.
  await target.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.hlc_clock (
      id smallint PRIMARY KEY CHECK (id = 1),
      last_ms bigint NOT NULL DEFAULT 0,
      last_count integer NOT NULL DEFAULT 0,
      node_id text NOT NULL DEFAULT ''
    );
    INSERT INTO harness_shared.hlc_clock (id) VALUES (1) ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text LANGUAGE plpgsql AS $fn$
    BEGIN
      UPDATE harness_shared.hlc_clock SET node_id = 'abcdef0123456789' WHERE id = 1 AND node_id = '';
      RETURN '000000000000000:00000:abcdef0123456789';
    END $fn$;
  `).simple();
  await target.sql.unsafe(MIGRATION_1003).simple();
  await target.sql.unsafe(MIGRATION_1218).simple();
  await target.sql.unsafe(MIGRATION_1442).simple();
}

async function slotRow(): Promise<{ node_slot: number; node_id: string; claim_reason: string } | undefined> {
  const rows = await db.sql<Array<{ node_slot: number; node_id: string; claim_reason: string }>>`
    SELECT node_slot, node_id, claim_reason FROM harness_shared.work_item_id_space`;
  return rows[0];
}

beforeAll(async () => {
  db = await createFreshPgDb('work-item-id-node-slots');
  await applyFixture(db);
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.work_items`;
  await db.sql`DELETE FROM harness_shared.work_item_id_space`;
  await db.sql`UPDATE harness_shared.hlc_clock SET node_id = ${NODE_ID} WHERE id = 1`;
  await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
});

describe('WI- id node slots (migration 1442)', () => {
  it('leaves a database that has never federated on its existing numbering', async () => {
    expect(await nextId()).toBe('WI-1');
    await insertRow('WI-500', 'local');
    // The 1003/1218 floor still applies to imported ids while there is no slot.
    expect(await nextId()).toBe('WI-501');
    expect(await slotRow()).toBeUndefined();
  });

  it('claims a slot on the first remote work item and keeps the counter', async () => {
    await insertRow('WI-40', 'local');
    expect(await nextId()).toBe('WI-41');

    await insertRow('EI-remote-1', 'remote', 'sibling-hive');

    const claimed = await slotRow();
    expect(claimed).toEqual({ node_slot: Number(SLOT), node_id: NODE_ID, claim_reason: 'first remote work item' });
    expect(await nextId()).toBe(`WI-${SLOT * BLOCK + 42n}`);
  });

  it('ignores imported ids from other blocks and from legacy slot 0 once claimed', async () => {
    await insertRow('EI-remote-1', 'remote', 'sibling-hive');
    expect(await nextId()).toBe(`WI-${SLOT * BLOCK + 1n}`);

    const otherSlot = SLOT === MAX_SLOT ? 1n : SLOT + 1n;
    await insertRow(`WI-${otherSlot * BLOCK + 5_000_000n}`, 'remote', 'sibling-hive');
    await insertRow('WI-9000000', 'remote', 'sibling-hive');
    expect(await nextId()).toBe(`WI-${SLOT * BLOCK + 2n}`);

    // An id inside this database's own block (for example a node sharing the slot) still raises the floor.
    await insertRow(`WI-${SLOT * BLOCK + 700n}`, 'remote', 'sibling-hive');
    expect(await nextId()).toBe(`WI-${SLOT * BLOCK + 701n}`);
  });

  it('is idempotent: a second claim with another node id returns the first slot', async () => {
    const first = await db.sql<Array<{ slot: number }>>`
      SELECT harness_shared.claim_work_item_id_slot(NULL, 'explicit') AS slot`;
    const second = await db.sql<Array<{ slot: number }>>`
      SELECT harness_shared.claim_work_item_id_slot('ffffffff00000000', 'again') AS slot`;
    expect(first[0]!.slot).toBe(Number(SLOT));
    expect(second[0]!.slot).toBe(Number(SLOT));
    expect((await slotRow())?.claim_reason).toBe('explicit');
  });

  it('mints a node id through hlc_now when the clock has none yet', async () => {
    await db.sql`UPDATE harness_shared.hlc_clock SET node_id = '' WHERE id = 1`;
    const rows = await db.sql<Array<{ slot: number }>>`
      SELECT harness_shared.claim_work_item_id_slot() AS slot`;
    expect(rows[0]!.slot).toBe(Number(expectedSlot('abcdef0123456789')));
  });

  it('claims during the migration itself when the database already holds remote rows', async () => {
    await db.sql`ALTER TABLE harness_shared.work_items DISABLE TRIGGER work_items_advance_id_sequence`;
    try {
      await insertRow('EI-remote-before-1442', 'remote', 'sibling-hive');
    } finally {
      await db.sql`ALTER TABLE harness_shared.work_items ENABLE TRIGGER work_items_advance_id_sequence`;
    }
    expect(await slotRow()).toBeUndefined();

    await db.sql.unsafe(MIGRATION_1442).simple();

    expect((await slotRow())?.claim_reason).toBe('migration 1442: database already holds remote work items');
    expect(await nextId()).toBe(`WI-${SLOT * BLOCK + 1n}`);
  });

  it('moves a counter that an older peer pushed past one block back into its own block', async () => {
    // A pre-1442 trigger imported another node's slotted id and dragged the counter.
    await db.sql`SELECT setval('harness_shared.work_item_seq', 6554700010008294, true)`;
    await db.sql`ALTER TABLE harness_shared.work_items DISABLE TRIGGER work_items_advance_id_sequence`;
    try {
      await insertRow(`WI-${SLOT * BLOCK + 33n}`, 'remote', 'sibling-hive');
    } finally {
      await db.sql`ALTER TABLE harness_shared.work_items ENABLE TRIGGER work_items_advance_id_sequence`;
    }

    await db.sql`SELECT harness_shared.claim_work_item_id_slot()`;

    expect(await nextId()).toBe(`WI-${SLOT * BLOCK + 34n}`);
  });

  it('refuses to mint past the end of a node block', async () => {
    await db.sql`SELECT harness_shared.claim_work_item_id_slot()`;
    await db.sql`SELECT setval('harness_shared.work_item_seq', ${(BLOCK - 1n).toString()}::bigint, true)`;
    await expect(nextId()).rejects.toThrow(/size of one node block/);
  });

  it('keeps every possible id below 2^53', async () => {
    const top = expectedSlot('ffffffffffffffff');
    expect(top).toBeLessThanOrEqual(MAX_SLOT);
    const largest = MAX_SLOT * BLOCK + (BLOCK - 1n);
    expect(largest <= BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    await db.sql`UPDATE harness_shared.hlc_clock SET node_id = 'ffffffffffffffff' WHERE id = 1`;
    const rows = await db.sql<Array<{ slot: number }>>`
      SELECT harness_shared.claim_work_item_id_slot() AS slot`;
    expect(BigInt(rows[0]!.slot)).toBe(top);
  });

  it('documents the D-006 residue: node ids whose first 8 hex digits agree modulo 90070 share a slot', async () => {
    // 0x00000001 and 0x00015fd7 (= 1 + 90070) both map to slot 2, so disjointness holds per SLOT, not per node id.
    const a = '0000000100000000';
    const b = '00015fd700000000';
    expect(expectedSlot(a)).toBe(2n);
    expect(expectedSlot(b)).toBe(2n);
    const rows = await db.sql<Array<{ slot: number }>>`
      SELECT harness_shared.claim_work_item_id_slot(${b}, 'residue') AS slot`;
    expect(BigInt(rows[0]!.slot)).toBe(expectedSlot(a));
  });
});

describe('two federating databases (scope-unique-identifiers R-4)', () => {
  const PEER_NODE_ID = 'deadbeef00000000';
  const PEER_SLOT = expectedSlot(PEER_NODE_ID);
  let peer: FreshPgDb;

  beforeAll(async () => {
    peer = await createFreshPgDb('work-item-id-node-slots-peer');
    await applyFixture(peer);
    await peer.sql`UPDATE harness_shared.hlc_clock SET node_id = ${PEER_NODE_ID} WHERE id = 1`;
  }, 60_000);

  afterAll(async () => {
    await peer?.cleanup();
  });

  it('mints disjoint WI- ids on two databases whose node ids map to different slots, from the same counter', async () => {
    // Calibration: the two node ids must land in different slots, or this case proves nothing.
    expect(PEER_SLOT).not.toBe(SLOT);

    // Identical local history on both databases, so their counters agree; then each federates.
    for (const target of [db, peer]) {
      await insertRow('WI-40', 'local', 'papercusp', target);
      await insertRow('EI-remote-1', 'remote', 'sibling-hive', target);
    }

    const mine: string[] = [];
    const theirs: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      mine.push(await nextId(db));
      theirs.push(await nextId(peer));
    }

    const counter = (id: string, slot: bigint): bigint => BigInt(id.slice(3)) - slot * BLOCK;
    // Same counters on both sides: without node slots these ids would be identical.
    expect(mine.map((id) => counter(id, SLOT))).toEqual(theirs.map((id) => counter(id, PEER_SLOT)));
    expect(counter(mine[0]!, SLOT)).toBe(41n);
    // Each database stays inside its own block, so the two ranges cannot meet.
    for (const id of mine) expect(BigInt(id.slice(3)) / BLOCK).toBe(SLOT);
    for (const id of theirs) expect(BigInt(id.slice(3)) / BLOCK).toBe(PEER_SLOT);
    expect(mine.filter((id) => theirs.includes(id))).toEqual([]);
  });
});
