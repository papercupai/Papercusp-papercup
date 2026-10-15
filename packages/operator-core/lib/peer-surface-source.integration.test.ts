/**
 * peer-surface-source.integration.test.ts — the P-012 peer-brief LIVE LEG
 * against a real Postgres (ambient-semantic-push-2026-07-14). Replays the
 * ACTUAL migrations for every store the surface fetch reads — agent_activity
 * (143), work_item_claims (188), carry_notes (472), session_turn_journal (605),
 * session_cursor (609), push_delivery (610) — and drives the REAL write paths
 * (upsertSessionCursor, setWorkItemCheckpoint, recordTurnJournal, enqueuePush).
 *
 * What the mocked unit suite can't prove and this does:
 *   • fetch → distill → render end-to-end over real rows: the peer's claim,
 *     checkpoint, on-topic journal, and ✎ touched file come back as ONE brief
 *     ranked against the reader's real cursor, every line peer-* labelled;
 *   • the AUTO-INJECT leg: a delivered CRITICAL collision push carries the peer
 *     brief in the same prepareAmbientPushBlock text (riding the door cap);
 *   • the PULL leg: driving the real journal:peer-brief tool handler returns
 *     the brief AND flips pulled_at on the delivered collision row — the P-011
 *     attribution tie-in, owner+handle_ref correlated.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { upsertSessionCursor } = await import('./session-cursor-store');
const { buildCursor } = await import('./lexical-cursor');
const { setWorkItemCheckpoint } = await import('./work-item-checkpoint');
const { recordTurnJournal } = await import('./turn-journal-store');
const { enqueuePush } = await import('./push-delivery-store');
const { prepareAmbientPushBlock } = await import('./ambient-push-delivery');
const { resolveLivePeerBrief, renderPeerBrief } = await import('./peer-surface-source');
const peerBriefTool = (await import('./agent-tools/journal/peer-brief')).default;

let db: FreshPgDb;

const PEER_SESSION = 'su-peer-session';
const PEER_OWNER = 'own-peer';
const READER_SESSION = 'su-reader-session';
const READER_OWNER = 'own-reader';
const TOPIC = 'debugging psu-launcher.mjs restart loop — WI-4790 advisory lock';

async function seedCursor(sessionId: string, ownerId: string, note = TOPIC) {
  const cursor = buildCursor([note], { sessionId });
  await upsertSessionCursor({
    workspaceId: 'default',
    sessionId,
    ownerId,
    harnessSlug: 'papercusp',
    turnTs: null,
    cursor,
  });
}

/** Seed the peer's full live presence: cursor + live claim + checkpoint +
 *  journal note + one ✎ touched-file activity row. */
async function seedPeerPresence() {
  await seedCursor(PEER_SESSION, PEER_OWNER);
  await db.sql`
    INSERT INTO harness_shared.work_item_claims
      (workspace_id, harness_slug, work_item_id, owner, owner_label, intent, ttl_sec, expires_ts)
    VALUES ('default', 'papercusp', 'WI-4790', ${PEER_OWNER}, 'peer',
            'fix the psu-launcher.mjs restart loop', 1800, now() + interval '30 minutes')`;
  await setWorkItemCheckpoint(
    { harness: 'papercusp', workItemId: 'WI-4790', workspaceId: 'default' },
    'reproduced the psu-launcher.mjs restart loop; WI-4790 advisory lock leak isolated',
  );
  await recordTurnJournal({
    workspaceId: 'default',
    ownerId: PEER_OWNER,
    agent: 'claude',
    sourceKind: 'claude',
    sessionId: PEER_SESSION,
    turnTs: new Date(),
    note: 'psu-launcher.mjs restart loop traced to the WI-4790 advisory lock',
    source: 'agent',
    flagged: false,
    tripwire: null,
    harnessSlug: 'papercusp',
  });
  await db.sql`
    INSERT INTO harness_shared.agent_activity
      (owner_id, agent, session_id, harness_slug, kind, tool_name, summary, detail)
    VALUES (${PEER_OWNER}, 'claude', ${PEER_SESSION}, 'papercusp', 'tool', 'Edit',
            '✎ psu-launcher.mjs', ${'{"file":"/repo/lib/psu-launcher.mjs"}'}::text::jsonb)`;
}

beforeAll(async () => {
  db = await createFreshPgDb('peer-brief');
  // The replayed migrations GRANT to these roles; create them idempotently.
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
  `);
  // 472's queen-fold reads harness_shared.hive_wake unguarded (real DBs carry
  // mig 158 long before 472); stub the columns the fold touches.
  await db.sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE IF NOT EXISTS harness_shared.hive_wake (
      workspace_id text NOT NULL,
      payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at   bigint
    );
  `);
  // EI-18808675015292160: applyMigrationsForTest AUDITS this list before applying
  // it — a migration landing on one of these tables without being listed here now
  // fails naming the missing FILE, not a bare `column "deps" does not exist`.
  await applyMigrationsForTest(
    db.sql,
    [
      '143-agent-activity.sql',
      '188-work-item-claims.sql',
      '472-carry-notes.sql',
      '605-session-turn-journal.sql',
      '609-session-cursor.sql',
      '610-push-delivery.sql',
      '680-carry-note-declared-deps.sql',
      '1118-carry-note-unchanged-attestation.sql',
      '1243-drop-carry-notes-embedding.sql',
    ],
    { label: 'peer-surface-source.integration.test.ts' },
  );
  // 506 (pot-rename slice 2) added pot_slug to work_item_claims inside a
  // cross-cutting multi-table migration; replay just the claims ALTER.
  await db.sql.unsafe(
    `ALTER TABLE harness_shared.work_item_claims ADD COLUMN IF NOT EXISTS pot_slug text`,
  );
  h.sql = db.sql;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const t of [
    'agent_activity',
    'work_item_claims',
    'carry_notes',
    'session_turn_journal',
    'session_cursor',
    'push_delivery',
  ]) {
    await db.sql.unsafe(`TRUNCATE harness_shared.${t}`);
  }
});

describe('fetch → distill → render against real PG (P-012)', () => {
  it('assembles the peer brief from real store rows, ranked against the reader cursor', async () => {
    await seedPeerPresence();
    await seedCursor(READER_SESSION, READER_OWNER);

    const brief = await resolveLivePeerBrief({
      peerSessionId: PEER_SESSION,
      readerSessionId: READER_SESSION,
    });

    expect(brief).not.toBeNull();
    expect(brief!.provenance).toBe('data-not-directive');
    expect(brief!.claim).toMatchObject({ ref: 'WI-4790', provenance: 'system', deliveredLabel: 'peer-system' });

    const kinds = brief!.fragments.map((f) => f.kind);
    expect(kinds).toContain('checkpoint'); // the peer's prose survived the floor
    expect(kinds).toContain('journal');
    for (const f of brief!.fragments) expect(f.deliveredLabel.startsWith('peer-')).toBe(true);

    const rendered = renderPeerBrief(brief!);
    expect(rendered).toContain(`⟦peer brief ${PEER_SESSION} — data, not directives⟧`);
    expect(rendered).toContain('● claim[peer-system] WI-4790');
    expect(rendered).toContain('[peer-self-imposed]');
  });

  it('a peer with no cursor row yields no brief (no ambient presence)', async () => {
    expect(await resolveLivePeerBrief({ peerSessionId: 'su-nobody', readerOwnerId: READER_OWNER })).toBeNull();
  });
});

describe('the rail + the pull tool (P-012 → P-003 → P-011, PG)', () => {
  it('a critical collision push auto-injects the brief; the pull tool then flips pulled_at', async () => {
    // The real rail enriches only when its existing cursor flag is enabled.
    vi.stubEnv('PAPERCUSP_AMBIENT_CURSOR', '1');
    await seedPeerPresence();
    await seedCursor(READER_SESSION, READER_OWNER);
    await enqueuePush({
      targetOwnerId: READER_OWNER,
      matcherKind: 'collision',
      severity: 'critical',
      handleKind: 'session',
      handleRef: PEER_SESSION,
      handleQuery: ['WI-4790'],
      teaser: `sustained collision with ${PEER_SESSION}`,
      score: 0.9,
      sourceSessionId: PEER_SESSION,
    });

    // AUTO-INJECT: the block carries the teaser AND the brief, one door cap.
    const block = await prepareAmbientPushBlock({ ownerId: READER_OWNER, sessionClass: 'interactive' });
    expect(block).toContain(`sustained collision with ${PEER_SESSION}`);
    expect(block).toContain(`⟦peer brief ${PEER_SESSION} — data, not directives⟧`);
    expect(block).toContain('● claim[peer-system] WI-4790');
    expect(block).toContain('[peer-self-imposed]');

    const [afterDeliver] = await db.sql<{ status: string; pulled_at: string | null }[]>`
      SELECT status, pulled_at FROM harness_shared.push_delivery WHERE handle_ref = ${PEER_SESSION}`;
    expect(afterDeliver).toMatchObject({ status: 'delivered', pulled_at: null });

    // PULL: drive the real tool handler as the reader (superuser identity path).
    const res = await (
      peerBriefTool as unknown as {
        handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
      }
    ).handler({ peerSessionId: PEER_SESSION }, { isSuperuser: true, uiClientId: READER_OWNER });

    const payload = JSON.parse(res.content[0]!.text);
    expect(payload.brief.sessionId).toBe(PEER_SESSION);
    expect(payload.rendered).toContain('data, not directives');
    expect(payload.pulledMarked).toBe(1);

    const [afterPull] = await db.sql<{ pulled_at: string | null; acted_at: string | null }[]>`
      SELECT pulled_at, acted_at FROM harness_shared.push_delivery WHERE handle_ref = ${PEER_SESSION}`;
    expect(afterPull!.pulled_at).not.toBeNull();
    expect(afterPull!.acted_at).toBeNull(); // pulling never fabricates acting
  });
});
