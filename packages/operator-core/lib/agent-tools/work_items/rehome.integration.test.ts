/**
 * work_items:rehome against real Postgres — WI-10004844.
 *
 * Two defects, both measured live on 2026-10-01 while re-homing 14 mis-homed
 * learning-loop rows (plan work-queue-bulk-cleanup-remediation-2026-10-01 P-003):
 *
 *  1. A dry run answered ok:true for three rows whose REAL move then died on a raw
 *     `duplicate key value violates unique constraint "work_items_keyless_title_identity_uq"`
 *     handler_error. The preview re-read only the source row, so it could not see the newer
 *     OPEN twin already holding the same title identity in the target harness. A dry run
 *     now runs the whole move and rolls it back, and a constraint refusal comes back as a
 *     structured `conflicts_in_target` that names the twin.
 *  2. The move is a local content write, so `stamp_local_federated_write` re-stamps
 *     origin='local' — taking a genuinely peer-authored row away from its author. A remote
 *     row now moves only when its author key is one of this workspace's OWN keys (the same
 *     own-node rule the claim gate applies); otherwise it is refused `peer_owned`.
 *
 * The title-identity index is loaded from migration 1157 itself, not restated here, so this
 * fixture cannot drift from the guard it exercises.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  decisions: [] as Array<{ verdict: string; subject?: string | null }>,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../../work-scope-policy', async (orig) => ({
  ...(await orig<typeof import('../../work-scope-policy')>()),
  recordWorkScopeDecision: async (d: { verdict: string; subject?: string | null }) => {
    h.decisions.push({ verdict: d.verdict, subject: d.subject });
  },
}));

const { rehomeWorkItem, REHOME_DEPENDENT_TABLES } = await import('./rehome');

const WS = 'ws-rehome';
const FROM = 'operator:ws-rehome';
const TO = 'papercusp';
const OWN_KEY = 'f89879623b3799fa00';
const PEER_KEY = 'aa11bb22cc33dd4400';

const MIGRATION_1157 = fileURLToPath(
  new URL('../../../../../libs/papercusp/libs/db/sql/1157-work-items-keyless-title-identity-guard.sql', import.meta.url),
);

/** The live index statement, cut from the migration that defines it. */
function titleIdentityIndexDdl(): string {
  const src = readFileSync(MIGRATION_1157, 'utf8');
  const m = src.match(/CREATE UNIQUE INDEX IF NOT EXISTS work_items_keyless_title_identity_uq[\s\S]*?;/);
  if (!m) throw new Error('migration 1157 no longer defines work_items_keyless_title_identity_uq — update this fixture');
  return m[0];
}

const DDL = `
  CREATE TABLE harness_shared.work_items (
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    summary text,
    status text,
    item_kind text,
    origin text NOT NULL DEFAULT 'local',
    author_pubkey text,
    payload jsonb,
    metadata jsonb,
    created_ts bigint,
    updated_ts bigint,
    PRIMARY KEY (workspace_id, harness_slug, feature_id)
  );
  ${REHOME_DEPENDENT_TABLES.map(
    (t) => `CREATE TABLE harness_shared.${t} (workspace_id text NOT NULL, harness_slug text NOT NULL, feature_id text NOT NULL);`,
  ).join('\n')}
`;

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('work-items-rehome');
  h.sql = db.sql;
  await db.sql.unsafe(DDL);
  await db.sql.unsafe(titleIdentityIndexDdl());
}, 60_000);

afterAll(async () => db?.cleanup());

beforeEach(async () => {
  await db.sql.unsafe(`TRUNCATE harness_shared.work_items, ${REHOME_DEPENDENT_TABLES.map((t) => `harness_shared.${t}`).join(', ')}`);
  h.decisions.length = 0;
});

async function seed(input: {
  id: string;
  harness: string;
  titleKey?: string;
  status?: string;
  origin?: 'local' | 'remote';
  author?: string | null;
  createdTs?: number;
}): Promise<void> {
  const payload = input.titleKey
    ? { admissionIdentity: { schemaVersion: 'admission-identity-v1', titleKey: input.titleKey } }
    : {};
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, item_kind, origin, author_pubkey, payload, created_ts)
    VALUES (${WS}, ${input.harness}, ${input.id}, ${'title of ' + input.id}, ${input.status ?? 'open'}, 'bug',
            ${input.origin ?? 'local'}, ${input.author === undefined ? OWN_KEY : input.author},
            ${db.sql.json(payload)}, ${input.createdTs ?? 1})`;
}

async function homeOf(id: string): Promise<Array<{ harness_slug: string; rehomed: boolean }>> {
  return db.sql<Array<{ harness_slug: string; rehomed: boolean }>>`
    SELECT harness_slug, (payload ? 'rehomed_from') AS rehomed
      FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ${id}`;
}

const move = (id: string, dryRun?: boolean) =>
  rehomeWorkItem({ id, to: TO, reason: 'mis-homed platform defect', actor: 'role:test', from: FROM, workspaceId: WS, dryRun });

describe('work_items:rehome — target title-identity twin (WI-10004844 defect 1)', () => {
  it('a DRY RUN predicts the twin collision the real move would hit, and changes nothing', async () => {
    await seed({ id: 'EI-old', harness: FROM, titleKey: 'title:fleet ekg stalled', origin: 'remote' });
    await seed({ id: 'EI-twin', harness: TO, titleKey: 'title:fleet ekg stalled', createdTs: 9 });

    const res = await move('EI-old', true);

    expect(res).toMatchObject({
      ok: false,
      error: 'conflicts_in_target',
      constraint: 'work_items_keyless_title_identity_uq',
      twinId: 'EI-twin',
    });
    expect(res.ok === false && res.message).toMatch(/Close EI-old as superseded by EI-twin/);
    expect(await homeOf('EI-old')).toEqual([{ harness_slug: FROM, rehomed: false }]);
    expect(h.decisions).toEqual([]);
  });

  it('the REAL move returns the same structured refusal instead of a raw unique-violation', async () => {
    await seed({ id: 'EI-old', harness: FROM, titleKey: 'title:regret sweep', origin: 'remote' });
    await seed({ id: 'EI-twin', harness: TO, titleKey: 'title:regret sweep' });

    await expect(move('EI-old')).resolves.toMatchObject({ ok: false, error: 'conflicts_in_target', twinId: 'EI-twin' });
    expect(await homeOf('EI-old')).toEqual([{ harness_slug: FROM, rehomed: false }]);
    expect(h.decisions).toEqual([]);
  });

  it('calibration: a TERMINAL twin is outside the partial index, so the same move goes through', async () => {
    // Without this control the two cases above would pass for any refusal at all — e.g. a
    // blanket "never move into a harness holding the same title" rule the index does not have.
    await seed({ id: 'EI-old', harness: FROM, titleKey: 'title:canary', origin: 'remote' });
    await seed({ id: 'EI-closed-twin', harness: TO, titleKey: 'title:canary', status: 'done' });

    await expect(move('EI-old')).resolves.toMatchObject({ ok: true, from: FROM, to: TO });
    expect(await homeOf('EI-old')).toEqual([{ harness_slug: TO, rehomed: true }]);
  });
});

describe('work_items:rehome — dry run is the real move, rolled back', () => {
  it('reports the per-relation move counts without moving anything or recording a decision', async () => {
    await seed({ id: 'EI-clean', harness: FROM, titleKey: 'title:clean' });
    await db.sql`INSERT INTO harness_shared.feature_claims (workspace_id, harness_slug, feature_id) VALUES (${WS}, ${FROM}, 'EI-clean')`;

    const res = await move('EI-clean', true);

    expect(res).toMatchObject({ ok: true, dryRun: true, from: FROM, to: TO });
    expect(res.ok && res.moved).toMatchObject({ work_items: 1, feature_claims: 1 });
    expect(await homeOf('EI-clean')).toEqual([{ harness_slug: FROM, rehomed: false }]);
    const [claim] = await db.sql`SELECT harness_slug FROM harness_shared.feature_claims WHERE feature_id = 'EI-clean'`;
    expect(claim!.harness_slug).toBe(FROM);
    expect(h.decisions).toEqual([]);
  });

  it('the real move relocates the row and its dependents and records the decision', async () => {
    await seed({ id: 'EI-clean', harness: FROM, titleKey: 'title:clean' });
    await db.sql`INSERT INTO harness_shared.feature_claims (workspace_id, harness_slug, feature_id) VALUES (${WS}, ${FROM}, 'EI-clean')`;

    await expect(move('EI-clean')).resolves.toMatchObject({ ok: true, from: FROM, to: TO });
    expect(await homeOf('EI-clean')).toEqual([{ harness_slug: TO, rehomed: true }]);
    const [claim] = await db.sql`SELECT harness_slug FROM harness_shared.feature_claims WHERE feature_id = 'EI-clean'`;
    expect(claim!.harness_slug).toBe(TO);
    expect(h.decisions).toEqual([{ verdict: 'rehomed', subject: 'EI-clean' }]);
  });
});

describe('work_items:rehome — remote-authored rows (WI-10004844 defect 2)', () => {
  it('refuses a remote row whose author key this workspace has never written locally', async () => {
    await seed({ id: 'EI-own-local', harness: TO, author: OWN_KEY }); // enrolls OWN_KEY as ours
    await seed({ id: 'EI-peer', harness: FROM, origin: 'remote', author: PEER_KEY });

    const res = await move('EI-peer');

    expect(res).toMatchObject({ ok: false, error: 'peer_owned' });
    expect(await homeOf('EI-peer')).toEqual([{ harness_slug: FROM, rehomed: false }]);
  });

  it('moves a remote row authored by one of our OWN keys (origin mislabel, not a peer)', async () => {
    await seed({ id: 'EI-own-local', harness: TO, author: OWN_KEY });
    await seed({ id: 'EI-own-remote', harness: FROM, origin: 'remote', author: OWN_KEY });

    await expect(move('EI-own-remote')).resolves.toMatchObject({ ok: true, from: FROM, to: TO });
    expect(await homeOf('EI-own-remote')).toEqual([{ harness_slug: TO, rehomed: true }]);
  });

  it('a remote row with NO author key is never treated as ours', async () => {
    await seed({ id: 'EI-own-local', harness: TO, author: OWN_KEY });
    await seed({ id: 'EI-anon', harness: FROM, origin: 'remote', author: null });

    await expect(move('EI-anon')).resolves.toMatchObject({ ok: false, error: 'peer_owned' });
  });
});
