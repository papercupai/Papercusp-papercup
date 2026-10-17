/**
 * work-item-checkpoint.integration.test.ts — the bee work-item checkpoint store
 * (bee-context-efficiency-2026-06-14 P-010; D-002/D-003), against real Postgres.
 *
 * Asserts setHiveCarryNote semantics on a WORK-ITEM-scoped store: write→read,
 * replace-on-write, trim, blank/null/undefined ⇒ clear (row deleted), any length,
 * successor-bee inheritance (the checkpoint lives on the work-item, D-002), and
 * workspace isolation. The migration-281 grants/RLS are validated separately by
 * fresh-migrate.integration.test.ts (which seeds the framework roles); the store
 * semantics only need the table, so the inline DDL mirrors migration 281's table.
 * Gated on Docker like the other *-integration tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('./workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('./workspace-registry')>('./workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});

// The production work-item attestation uses the bounded path. Keep this
// contention regression short while leaving the production default untouched.
const PRIOR_ATTEST_LOCK_TIMEOUT = process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = '100';
const { setWorkItemCheckpoint, setWorkItemCheckpointWithPrior, getWorkItemCheckpoint, getWorkItemCheckpointWithMeta, attestWorkItemCheckpointUnchanged } = await import(
  './work-item-checkpoint'
);
if (PRIOR_ATTEST_LOCK_TIMEOUT === undefined) delete process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS;
else process.env.PAPERCUSP_COORD_WRITE_LOCK_TIMEOUT_MS = PRIOR_ATTEST_LOCK_TIMEOUT;
const {
  workItemScope,
  shortCarryHash,
  computeWorkItemSubjectFingerprint,
  CARRY_NOTE_ATTESTATION_MAX_CHAIN,
} = await import('./carry-note');
const { readHeldWorkItems, renderCarryBriefText } = await import('./carry-brief');
const { readLeaderCheckpointProgress } = await import('./agent-tools/fleet/leader-brief-progress');

const HARNESS = 'h1';

// As of su-cold-auto-mode P-001 the bee checkpoint IS a scope on the shared
// carry-note store (mig 472). The bee uses journal:false, so a clear DELETES the
// row exactly as the pre-P-001 work_item_checkpoints table did — this suite's
// row-existence semantics are unchanged; only the table + scope key move.
const CARRY_NOTES_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.carry_notes (
    workspace_id text NOT NULL,
    scope text NOT NULL,
    note text,
    journal jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_ts bigint NOT NULL,
    deps jsonb,
    -- migration 1118 (P-007/R-06) unchanged-attestation state. body_ts = when the note
    -- TEXT last actually changed (NULL on pre-1118 rows; readers coalesce to
    -- updated_ts); attested_count = the consecutive-attestation chain since the last
    -- real body write. Kept in step with the real schema deliberately: this fixture
    -- tracks harness_shared.carry_notes rather than stubbing a minimal subset.
    body_ts bigint,
    attested_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (workspace_id, scope))`;
const WORK_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_items (
    -- WI-38326: FEATURE_COLS projects these five claim-spec filter columns; a fixture
    -- missing them fails that projection with "column does not exist" (D-014 debt).
    tags jsonb,
    source_plan_slug text,
    source_plan_item_ids text[],
    redundancy integer,
    expected_cost_cents bigint,
    workspace_id text NOT NULL,
    harness_slug text NOT NULL,
    feature_id text NOT NULL,
    title text,
    summary text,
    payload jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'open',
    item_kind text NOT NULL DEFAULT 'feature',
    taken_by text,
    taken_at timestamptz,
    last_progress_at timestamptz,
    -- P-007/R-06: the G2 subject-movement guard reads this column. It is updated_ts
    -- (bigint EPOCH MILLISECONDS), NOT an updated_at timestamptz — work_items has no
    -- such column, and work_items:get's camelCase updatedAt is a PROJECTION of this
    -- one. Getting that wrong is not a loud failure: the guard's read throws, its
    -- deliberate fail-open catch swallows it, and G2 silently never runs. A fixture
    -- that invented an updated_at column would have made this suite green over a dead guard,
    -- so the column name here is load-bearing and must track the real table.
    updated_ts bigint,
    admission text, admitted_at timestamptz, admitted_by text,
    PRIMARY KEY (workspace_id, harness_slug, feature_id))`;

let db: FreshPgDb;
// EI-9013: the store now canonicalizes the workspace via resolveConcreteWorkspaceId,
// whose INTERNAL fallback call to activeWorkspaceId() the module mock above cannot
// intercept (same-module internal call — see checkpoint.test.ts's EI-8824 note). Pin
// the env override (workspace-registry precedence #2) so omitted-workspace calls
// deterministically resolve to 'default' like the mock used to guarantee.
const PRIOR_WS_ENV = process.env.PAPERCUSP_WORKSPACE_ID;
beforeAll(async () => {
  process.env.PAPERCUSP_WORKSPACE_ID = 'default';
  db = await createFreshPgDb('work-item-checkpoint');
  h.sql = db.sql;
  await db.sql.unsafe(CARRY_NOTES_DDL);
  await db.sql.unsafe(WORK_ITEMS_DDL);
}, 60_000);
afterAll(async () => {
  if (PRIOR_WS_ENV === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = PRIOR_WS_ENV;
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.carry_notes`;
  await db.sql`DELETE FROM harness_shared.work_items`;
});

async function rowCount(): Promise<number> {
  const r = await db.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM harness_shared.carry_notes`;
  return Number(r[0]?.n ?? 0);
}

describe('work-item checkpoint store (P-010, real PG) — setHiveCarryNote semantics', () => {
  it('persists all four cited reference kinds and excludes its own item through the work-item checkpoint writer (R-13)', async () => {
    const ref = { harness: HARNESS, workItemId: 'WI-5000', workspaceId: 'default' };
    await db.sql`INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, status, updated_ts)
      VALUES ('default', ${HARNESS}, 'WI-5000', 'open', 1),
             ('default', ${HARNESS}, 'WI-1313', 'open', 10),
             ('other-workspace', ${HARNESS}, 'WI-1313', 'done', 99)`;
    await db.sql`CREATE TABLE harness_shared.harness_plans (
      workspace_id text, harness_slug text, plan_slug text, decisions jsonb)`;
    await db.sql`INSERT INTO harness_shared.harness_plans VALUES
      ('default', ${HARNESS}, 'reference-plan', '[{"id":"D-001","title":"Keep baseline","body":"Read before replacing"}]'::jsonb)`;
    await db.sql`CREATE TABLE harness_shared.agent_facts (
      workspace_id text, key text, id bigint, updated_at timestamptz,
      retracted_at timestamptz, superseded_at timestamptz, evicted_at timestamptz, expires_at timestamptz)`;
    await db.sql`INSERT INTO harness_shared.agent_facts (workspace_id, key, id, updated_at)
      VALUES ('default', 'reference-fact', 1313, ${new Date(10)})`;
    const citations = 'WI-5000 waits on WI-1313 reference-plan#D-001 fact:reference-fact packages/operator-core/lib/carry-ref-stamps.test.ts';
    const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
    const expected = [
      { dep: 'work-item:WI-1313', token: 'open@10', at: expect.any(Number) },
      { dep: 'decision:reference-plan#D-001', token: hash('Keep baseline\nRead before replacing'), at: expect.any(Number) },
      { dep: 'fact:reference-fact', token: 'live:1313@10', at: expect.any(Number) },
      { dep: 'file:packages/operator-core/lib/carry-ref-stamps.test.ts', token: hash(readFileSync(new URL('./carry-ref-stamps.test.ts', import.meta.url))), at: expect.any(Number) },
    ];

    await setWorkItemCheckpointWithPrior(ref, citations);
    const [saved] = await db.sql<{ deps: { refs: unknown[] } }[]>`
      SELECT deps FROM harness_shared.carry_notes
      WHERE workspace_id = 'default' AND scope = ${workItemScope(HARNESS, ref.workItemId)}`;
    expect(saved?.deps.refs).toEqual(expected);

    await db.sql`UPDATE harness_shared.work_items SET updated_ts = 20
      WHERE workspace_id = 'default' AND feature_id = 'WI-1313'`;
    const [baseline] = await db.sql<{ deps: { refs: unknown[] } }[]>`
      SELECT deps FROM harness_shared.carry_notes
      WHERE workspace_id = 'default' AND scope = ${workItemScope(HARNESS, ref.workItemId)}`;
    expect(baseline?.deps).toEqual(saved?.deps);
    await setWorkItemCheckpointWithPrior(ref, `Still: ${citations}`);
    const [refreshed] = await db.sql<{ deps: { refs: unknown[] } }[]>`
      SELECT deps FROM harness_shared.carry_notes
      WHERE workspace_id = 'default' AND scope = ${workItemScope(HARNESS, ref.workItemId)}`;
    expect(refreshed?.deps.refs).toEqual([{ ...expected[0], token: 'open@20' }, ...expected.slice(1)]);
  });

  it('persists the authoritative subject fingerprint on each journal entry and returns the newest one', async () => {
    const ref = { harness: HARNESS, workItemId: 'WI-subject-fingerprint' };
    const subject = {
      id: ref.workItemId,
      harness: HARNESS,
      kind: 'bug',
      title: 'original subject',
      summary: 'the first active lane',
      state: 'open',
    };
    const first = computeWorkItemSubjectFingerprint(subject);

    await setWorkItemCheckpointWithPrior(ref, 'first checkpoint', { workItem: subject });
    const storedFirst = await getWorkItemCheckpointWithMeta(ref);
    expect(storedFirst.subjectFingerprint).toEqual(first);
    const journalFirst = await db.sql<Array<{ subject_fingerprint: unknown }>>`
      SELECT journal -> -1 -> 'subjectFingerprint' AS subject_fingerprint
        FROM harness_shared.carry_notes
       WHERE workspace_id = 'default' AND scope = ${workItemScope(HARNESS, ref.workItemId)}`;
    expect(journalFirst[0]?.subject_fingerprint).toEqual(first);

    await new Promise((resolve) => setTimeout(resolve, 3));
    const changed = { ...subject, title: 'rewritten subject' };
    const second = computeWorkItemSubjectFingerprint(changed);
    await setWorkItemCheckpointWithPrior(ref, 'second checkpoint', { workItem: changed });

    const storedSecond = await getWorkItemCheckpointWithMeta(ref);
    expect(storedSecond.subjectFingerprint).toEqual(second);
    expect(storedSecond.subjectFingerprint).not.toEqual(first);
  });

  it('tracks the latest authored update across append, refresh, metadata changes and stale span data', async () => {
    const { renderCarryNote, withCarryNoteChecks } = await import('./carry-note');
    const { readWorkItemResume } = await import('./agent-tools/work_items/resume');
    const ref = { harness: HARNESS, workItemId: 'WI-resume-latest-update' };
    const source = { id: ref.workItemId, harness: HARNESS, state: 'open', assignee: 'successor' };
    const deps = { checkpoint: getWorkItemCheckpointWithMeta,
      freshness: async () => undefined, evidence: async () => [] };
    await setWorkItemCheckpoint(ref, renderCarryNote({ next: 'Acquire run.ts and implement the wiring.' }));
    // A plain-prose update is progress, not an action. Neither it nor a possibly
    // superseded historical Next is a verified current instruction.
    const prose = 'Recorded the saved proof for the wiring review.';
    await setWorkItemCheckpointWithPrior(ref, prose, {
      latestUpdate: prose,
      transform: prior => `${prior}\n\n---\n${prose}`,
    });
    expect((await readWorkItemResume(source, deps)).nextAction).toEqual({
      status: 'unknown', text: null,
    });
    // An appended update that names its own Next becomes the action.
    const added = renderCarryNote({ next: 'Wiring is complete. Review the saved proof.' });
    await setWorkItemCheckpointWithPrior(ref, added, {
      latestUpdate: added,
      transform: prior => `${prior}\n\n---\n${added}`,
    });
    expect((await readWorkItemResume(source, deps)).nextAction).toEqual({
      status: 'available', text: 'Wiring is complete. Review the saved proof.', source: 'next-action',
    });
    const refreshed = renderCarryNote({ next: 'Run the independent acceptance check.' });
    await setWorkItemCheckpointWithPrior(ref, refreshed, {
      latestUpdate: refreshed,
      transform: prior => `${refreshed}\n\n---\n${prior}`,
    });
    expect((await readWorkItemResume(source, deps)).nextAction.text).toBe('Run the independent acceptance check.');
    await setWorkItemCheckpointWithPrior(ref, undefined, {
      transform: prior => withCarryNoteChecks(prior ?? '', [{ id: 'saved', claim: 'Keep the saved proof.', verified: 'run:44' }]),
    });
    const updated = await readWorkItemResume(source, deps);
    expect(updated.nextAction.text).toBe('Run the independent acceptance check.');
    expect(updated.checks.rows).toHaveLength(1);
    await db.sql`UPDATE harness_shared.carry_notes SET note = note || '\nChanged outside the checkpoint writer'
      WHERE workspace_id = 'default' AND scope = ${workItemScope(HARNESS, ref.workItemId)}`;
    expect((await readWorkItemResume(source, deps)).nextAction).toMatchObject({ status: 'unknown', text: null });
  });

  it('resumes the latest durable next action after a successor boundary without historical paging', async () => {
    const { renderCarryNote } = await import('./carry-note');
    const { readWorkItemResume } = await import('./agent-tools/work_items/resume');
    const { shapeWorkItemsGet } = await import('./agent-tools/work_items/get-shape');
    const ref = { harness: HARNESS, workItemId: 'WI-resume-roundtrip' };
    const source = { id: ref.workItemId, harness: HARNESS, state: 'open', assignee: 'successor' };
    const deps = { checkpoint: getWorkItemCheckpointWithMeta,
      freshness: async () => undefined, evidence: async () => [] };
    await setWorkItemCheckpoint(ref, renderCarryNote({ did: 'Prior detail '.repeat(700),
      next: 'Reuse test-run:44; request independent acceptance.' }));
    const resume = await readWorkItemResume(source, deps);
    const shaped = shapeWorkItemsGet({ ok: true, __resumeOnly: true,
      results: [{ ok: true, id: source.id, resume }], counts: { ok: 1, failed: 0 } }, 'trimmed') as any;
    expect(shaped.results[0].resume.nextAction.text).toBe('Reuse test-run:44; request independent acceptance.');
    expect(shaped.results[0].resume.claim.assignee).toBe('successor');
    expect(JSON.stringify(shaped).length).toBeLessThan(6_000);
    await setWorkItemCheckpoint(ref, renderCarryNote({ next: 'Acceptance is complete; advance the next item.' }));
    const updated = await readWorkItemResume(source, deps);
    expect(updated.nextAction.text).toBe('Acceptance is complete; advance the next item.');
    expect(updated.checkpoint.contentHash).not.toBe(resume.checkpoint.contentHash);
  });

  it('one persisted checkpoint write updates item, carry and leader views without a loop copy (P-005)', async () => {
    const ownerId = 'progress-fixture-owner';
    const workspaceId = 'default';
    const { withCarryNoteWalls, withCarryNoteChecks } = await import('./carry-note');
    const { renderCarryDoc } = await import('./carry-doc');
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, taken_by)
      VALUES
        (${workspaceId}, ${HARNESS}, 'WI-progress', 'Progress', ${ownerId}),
        (${workspaceId}, ${HARNESS}, 'WI-review', 'Independent review', ${ownerId}),
        ('other-workspace', ${HARNESS}, 'WI-progress', 'Wrong workspace', ${ownerId})`;
    const ref = { harness: HARNESS, workItemId: 'WI-progress', workspaceId };
    const note = withCarryNoteWalls(withCarryNoteChecks(
      'RETRACTED: old acceptance. Next: verify scoped source.', [{
        id: 'source-only', claim: 'Not deployment proof', verified: 'saved-receipt', sinceMs: 1,
      }],
    ), [{ id: 'runtime-wall', claim: 'No restart', recheck: 'Read scope', sinceMs: 1 }]);
    await setWorkItemCheckpoint(ref, note);
    await setWorkItemCheckpoint({ ...ref, workItemId: 'WI-review' }, 'Independent review stays open.');
    await setWorkItemCheckpoint({ ...ref, workspaceId: 'other-workspace' }, 'Wrong workspace must never leak.');
    const claims = ['WI-progress', 'WI-review'].map((id) => ({
      type: 'work-item' as const, id, active: true, harnessSlug: HARNESS,
    } as import('./fleet/assignments').AgentClaim));
    const leaderRead = async () => (await readLeaderCheckpointProgress(
      [{ agentId: ownerId, claims }], workspaceId, { timeoutMs: 5_000 },
    )).get(ownerId)!;
    const before = await getWorkItemCheckpointWithMeta(ref);
    const leader = await leaderRead();
    expect(leader.status).toBe('read');
    expect(leader.items.find((item) => item.id === 'WI-progress')).toMatchObject({
      checkpoint: note, checkpointUpdatedAtMs: before.updatedAtMs,
      checkpointContentHash: shortCarryHash(note), checks: 1, walls: 1,
    });
    const carryItems = await readHeldWorkItems(ownerId, workspaceId);
    const brief: import('./carry-brief').CarryBrief = {
      ownerId, workspaceId, loop: null, heldItems: JSON.parse(JSON.stringify(carryItems)),
      directives: [], directivesTotalOpen: 0, walls: [], facts: [], awaits: [], fleet: null,
    };
    const doc: import('./carry-doc').CarryDoc = {
      brief, identity: { ownerId, ownerLabel: null, workspaceId, harness: HARNESS, fleet: null, account: null },
      sessionMode: { modes: [], loopActive: false, loopIntervalSec: null },
      planItems: [], asks: [], tail: [],
      continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true },
    };
    for (const rendered of [renderCarryBriefText(brief), renderCarryDoc(doc)]) {
      expect(rendered).toContain('Next: verify scoped source.');
      expect(rendered).toContain('Independent review stays open.');
      expect(rendered).not.toContain('Wrong workspace must never leak.');
    }
    expect(renderCarryDoc(doc)).toContain('BLIND WINDOW');
    expect(renderCarryDoc(doc)).toContain('RETRACTED CLAIMS');
    const next = 'Next: acceptance still requires independent review.';
    await setWorkItemCheckpoint(ref, next);
    // Fresh reads use the same persisted field, not the earlier serialized carry.
    expect(await getWorkItemCheckpoint(ref)).toBe(next);
    expect((await readHeldWorkItems(ownerId, workspaceId)).find((item) => item.id === 'WI-progress')?.checkpoint)
      .toBe(next);
    expect((await leaderRead()).items.find((item) => item.id === 'WI-progress')?.checkpoint).toBe(next);
    expect(brief.heldItems.find((item) => item.id === 'WI-progress')?.checkpoint).toBe(note);
    const loopCopies = await db.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.carry_notes WHERE scope LIKE 'loop:%'`;
    expect(loopCopies[0].n).toBe(0);
    // Reassignment after the roster snapshot cannot leak the old member's prose.
    await db.sql`
      UPDATE harness_shared.work_items SET taken_by = 'different-owner'
       WHERE workspace_id = ${workspaceId} AND feature_id = 'WI-progress'`;
    const reassigned = await leaderRead();
    expect(reassigned.status).toBe('unknown');
    expect(reassigned.items.map((item) => item.id)).toEqual(['WI-review']);
  });

  it('distinguishes a failed metadata read from absence and recovers the same stored checkpoint', async () => {
    const ref = { harness: HARNESS, workItemId: 'WI-read-failure' };
    expect(await getWorkItemCheckpointWithMeta(ref)).toEqual({ checkpoint: null, updatedAtMs: null });
    await setWorkItemCheckpoint(ref, 'Next: preserve the independent review.');
    const original = await getWorkItemCheckpointWithMeta(ref);
    expect(original.checkpoint).toBe('Next: preserve the independent review.');
    // Fault injection stays in the private test database. Restore in finally so
    // neither a failed assertion nor the negative control poisons another case.
    await db.sql`ALTER TABLE harness_shared.carry_notes RENAME TO carry_notes_unavailable`;
    try {
      expect(await getWorkItemCheckpointWithMeta(ref)).toEqual({
        checkpoint: null, updatedAtMs: null, readFailed: true,
      });
    } finally {
      await db.sql`ALTER TABLE harness_shared.carry_notes_unavailable RENAME TO carry_notes`;
    }
    expect(await getWorkItemCheckpointWithMeta(ref)).toEqual(original);
  });

  it('write → read round-trips', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'phase 2 of 5; edited foo.ts')).toBe(
      'phase 2 of 5; edited foo.ts',
    );
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('phase 2 of 5; edited foo.ts');
  });

  it('replace-on-write: the latest write wins (one row, not appended)', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'first');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'second');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('second');
    expect(await rowCount()).toBe(1);
  });

  it('trims the stored value (mirrors setHiveCarryNote)', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, '  padded  ')).toBe('padded');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('padded');
  });

  it('blank / null / undefined ⇒ CLEAR; re-read is null (the ROW survives — P-003 journaling)', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'state');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, '   ')).toBeNull(); // blank clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();
    // effort-scoped-continuity-2026-09-02 P-003 flipped this scope to journal:true.
    // A clear therefore keeps the row (the trajectory ring outlives the note) instead
    // of deleting it — deliberately, and called out as "THE ONE BEHAVIOUR CHANGE" at
    // the journal:true site. What every reader depends on is unchanged and is what
    // this test now pins: `note` still reads back NULL. The row is a survivor, not a
    // resurrected checkpoint.
    expect(await rowCount()).toBe(1);
    const [cleared] = await db.sql<Array<{ note: string | null; journal: unknown }>>`
      SELECT note, journal FROM harness_shared.carry_notes
       WHERE scope = ${workItemScope(HARNESS, 'WI-1')}`;
    expect(cleared?.note).toBeNull();
    expect(Array.isArray(cleared?.journal) ? (cleared.journal as unknown[]).length : 0).toBeGreaterThan(0);

    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'again');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, null)).toBeNull(); // null clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();

    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'yet again');
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, undefined)).toBeNull(); // undefined clears
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull();
  });

  it('clearing a non-existent checkpoint is a no-op (idempotent)', async () => {
    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'NOPE' }, '')).toBeNull();
    expect(await rowCount()).toBe(0);
  });

  it('reading a missing checkpoint returns null', async () => {
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'MISSING' })).toBeNull();
  });

  it('any length — a large compressed blob round-trips (no cap)', async () => {
    const big = 'x'.repeat(200_000);
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-BIG' }, big);
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-BIG' })).toBe(big);
  });

  it('WORK-ITEM-scoped (D-002): a successor reader on the SAME work-item inherits the checkpoint', async () => {
    // The bee that wrote it is irrelevant — the checkpoint lives on the work-item,
    // so any later reader (a re-woken bee OR a successor after eviction) gets it.
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-HANDOFF' }, 'predecessor left this');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-HANDOFF' })).toBe('predecessor left this');
  });

  it('checkpoint advances issue progress without rewriting its claim-acquisition time (EI-21498578211680100)', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, status, item_kind, taken_by, taken_at, last_progress_at)
      VALUES
        ('default', 'operator:default', 'WI-ISSUE-PROGRESS', 'open', 'bug', 'su-holder',
         now() - interval '30 minutes', now() - interval '20 minutes')`;

    const [before] = await db.sql<{ taken_at: Date; last_progress_at: Date }[]>`
      SELECT taken_at, last_progress_at
        FROM harness_shared.work_items
       WHERE feature_id = 'WI-ISSUE-PROGRESS'`;

    expect(
      await setWorkItemCheckpoint(
        { harness: HARNESS, workItemId: 'WI-ISSUE-PROGRESS' },
        'still working; preserve the original claim clock',
      ),
    ).toBe('still working; preserve the original claim clock');

    const [after] = await db.sql<{ taken_at: Date; last_progress_at: Date }[]>`
      SELECT taken_at, last_progress_at
        FROM harness_shared.work_items
       WHERE feature_id = 'WI-ISSUE-PROGRESS'`;
    expect(after.taken_at.getTime()).toBe(before.taken_at.getTime());
    expect(after.last_progress_at.getTime()).toBeGreaterThan(before.last_progress_at.getTime());
  });

  it('returns a committed checkpoint when the best-effort progress anchor is row-locked', async () => {
    const item = 'WI-PROGRESS-ANCHOR-CONTENTION';
    const checkpoint = 'carry note committed while progress update is blocked';
    const ref = { harness: HARNESS, workItemId: item, workspaceId: 'default' };
    const oldProgress = new Date('2000-01-01T00:00:00.000Z');
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, status, item_kind, taken_by, taken_at, last_progress_at)
      VALUES
        ('default', ${HARNESS}, ${item}, 'open', 'bug', 'su-holder', now(), ${oldProgress})`;

    let release!: () => void;
    let lockedResolve!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const locked = new Promise<void>((resolve) => { lockedResolve = resolve; });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT feature_id
          FROM harness_shared.work_items
         WHERE workspace_id = 'default' AND harness_slug = ${HARNESS} AND feature_id = ${item}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    const startedAt = Date.now();
    const write = setWorkItemCheckpointWithPrior(ref, checkpoint);
    const settled = write.then(
      (value) => ({ status: 'settled' as const, value }),
      (error: unknown) => ({ status: 'error' as const, error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outcome: Awaited<typeof settled> | { status: 'pending' } = { status: 'pending' };
    let noteWhileLocked: string | null = null;
    let progressWhileLocked: Date | null = null;
    try {
      outcome = await Promise.race([
        settled,
        new Promise<{ status: 'pending' }>((resolve) => {
          timer = setTimeout(() => resolve({ status: 'pending' }), 3_500);
        }),
      ]);
      noteWhileLocked = await getWorkItemCheckpoint(ref);
      const [progress] = await db.sql<{ last_progress_at: Date }[]>`
        SELECT last_progress_at FROM harness_shared.work_items
         WHERE workspace_id = 'default' AND harness_slug = ${HARNESS} AND feature_id = ${item}`;
      progressWhileLocked = progress?.last_progress_at ?? null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      release();
      await blocker;
      await settled;
    }

    expect(noteWhileLocked).toBe(checkpoint);
    expect(progressWhileLocked?.getTime()).toBe(oldProgress.getTime());
    expect(outcome.status).toBe('settled');
    if (outcome.status === 'settled') expect(outcome.value.stored).toBe(checkpoint);
    expect(Date.now() - startedAt).toBeLessThan(3_500);
    expect(await getWorkItemCheckpoint(ref)).toBe(checkpoint);
  });

  it('checkpoint keeps feature progress harness-scoped and preserves its claim time', async () => {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, status, item_kind, taken_by, taken_at, last_progress_at)
      VALUES
        ('default', ${HARNESS}, 'F-SCOPED-PROGRESS', 'open', 'feature', 'su-holder',
         now() - interval '30 minutes', now() - interval '20 minutes'),
        ('default', 'h2', 'F-SCOPED-PROGRESS', 'open', 'feature', 'su-other',
         now() - interval '40 minutes', now() - interval '10 minutes')`;

    const before = await db.sql<{ harness_slug: string; taken_at: Date; last_progress_at: Date }[]>`
      SELECT harness_slug, taken_at, last_progress_at
        FROM harness_shared.work_items
       WHERE feature_id = 'F-SCOPED-PROGRESS'
       ORDER BY harness_slug`;

    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'F-SCOPED-PROGRESS' }, 'feature progress');

    const after = await db.sql<{ harness_slug: string; taken_at: Date; last_progress_at: Date }[]>`
      SELECT harness_slug, taken_at, last_progress_at
        FROM harness_shared.work_items
       WHERE feature_id = 'F-SCOPED-PROGRESS'
       ORDER BY harness_slug`;
    expect(after.map((row) => row.taken_at.getTime())).toEqual(before.map((row) => row.taken_at.getTime()));
    expect(after[0].harness_slug).toBe(HARNESS);
    expect(after[0].last_progress_at.getTime()).toBeGreaterThan(before[0].last_progress_at.getTime());
    expect(after[1]).toEqual(before[1]);
  });

  it('checkpoints are independent per work-item and per harness', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' }, 'one');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-2' }, 'two');
    await setWorkItemCheckpoint({ harness: 'h2', workItemId: 'WI-1' }, 'other-harness');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBe('one');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-2' })).toBe('two');
    expect(await getWorkItemCheckpoint({ harness: 'h2', workItemId: 'WI-1' })).toBe('other-harness');
  });

  it('EI-8805: a harness-null item round-trips (write → read back the same continuity state)', async () => {
    // A harness-null item — an issue-family EI filed from an unscoped su session — has
    // no harness. Previously the write silently orphaned its checkpoint (keyed under the
    // session harness while the read looked under the item's null harness); the store
    // now canonicalizes a null harness to one namespace so the checkpoint survives.
    expect(await setWorkItemCheckpoint({ harness: null, workItemId: 'EI-1' }, 'harness-null continuity')).toBe(
      'harness-null continuity',
    );
    expect(await getWorkItemCheckpoint({ harness: null, workItemId: 'EI-1' })).toBe('harness-null continuity');
  });

  it('EI-8805: cross-key agreement — a write under the unscoped wildcard reads back under the item null harness', async () => {
    // The unscoped su session resolves its harness to the '*' wildcard on write; the read
    // side (work_items:get) keys by the item's OWN null harness. null and '*' must
    // collapse onto ONE namespace or the write is invisible to the read — the exact
    // EI-8805 defect. Assert both directions.
    expect(await setWorkItemCheckpoint({ harness: '*', workItemId: 'EI-2' }, 'written under wildcard')).toBe(
      'written under wildcard',
    );
    expect(await getWorkItemCheckpoint({ harness: null, workItemId: 'EI-2' })).toBe('written under wildcard');

    expect(await setWorkItemCheckpoint({ harness: null, workItemId: 'EI-3' }, 'written under null')).toBe(
      'written under null',
    );
    expect(await getWorkItemCheckpoint({ harness: '*', workItemId: 'EI-3' })).toBe('written under null');
  });

  it('EI-8805 / scope-unique-identifiers R-7: a feature id held by two harnesses of one workspace keeps each checkpoint on the row it was written to', async () => {
    // Legacy F-FIX ids were numbered per harness, so one workspace holds the same
    // feature id under two harnesses (measured: F-FIX-001 in hiveloop-hive and
    // papercusp). A checkpoint written for one row must read back from THAT row —
    // never be lost, never surface on the sibling, never bump the sibling's progress.
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, status, item_kind, taken_by, taken_at, last_progress_at)
      VALUES
        ('default', ${HARNESS}, 'F-FIX-TWIN', 'open', 'feature', 'su-a',
         now() - interval '40 minutes', now() - interval '30 minutes'),
        ('default', 'h2', 'F-FIX-TWIN', 'open', 'feature', 'su-b',
         now() - interval '40 minutes', now() - interval '30 minutes')`;
    const progress = async () =>
      Object.fromEntries(
        (
          await db.sql<{ harness_slug: string; last_progress_at: Date }[]>`
            SELECT harness_slug, last_progress_at FROM harness_shared.work_items
             WHERE workspace_id = 'default' AND feature_id = 'F-FIX-TWIN'`
        ).map((r) => [r.harness_slug, r.last_progress_at.getTime()]),
      );
    const before = await progress();

    expect(await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'F-FIX-TWIN' }, 'state of the h1 row')).toBe(
      'state of the h1 row',
    );
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'F-FIX-TWIN' })).toBe('state of the h1 row');
    expect(await getWorkItemCheckpoint({ harness: 'h2', workItemId: 'F-FIX-TWIN' })).toBeNull();
    const afterFirst = await progress();
    expect(afterFirst[HARNESS]).toBeGreaterThan(before[HARNESS]);
    expect(afterFirst.h2).toBe(before.h2);

    await setWorkItemCheckpoint({ harness: 'h2', workItemId: 'F-FIX-TWIN' }, 'state of the h2 row');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'F-FIX-TWIN' })).toBe('state of the h1 row');
    expect(await getWorkItemCheckpoint({ harness: 'h2', workItemId: 'F-FIX-TWIN' })).toBe('state of the h2 row');
  });

  it("EI-9013: the unscoped-session literal '*' workspace canonicalizes to the concrete workspace on BOTH write and read", async () => {
    // The EI-9013/EI-8824 class: an unscoped su session's ctx.workspaceId is the
    // literal '*'. A write keyed under '*' is invisible to every concrete-workspace
    // read (the incident: a confirmed-successful checkpoint read back null after
    // compaction). The substrate now canonicalizes at BOTH seams.
    expect(
      await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013', workspaceId: '*' }, 'wildcard write'),
    ).toBe('wildcard write');
    // Readable with the workspace omitted (concrete), passed concretely, and passed as '*'.
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013' })).toBe('wildcard write');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013', workspaceId: 'default' })).toBe(
      'wildcard write',
    );
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013', workspaceId: '*' })).toBe(
      'wildcard write',
    );
    // No literal-'*' row was ever persisted.
    const star = await db.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM harness_shared.carry_notes WHERE workspace_id = '*'`;
    expect(Number(star[0]?.n ?? 0)).toBe(0);
    // And the reverse direction: a '*'-scoped READ finds a concretely-written row.
    await setWorkItemCheckpoint(
      { harness: HARNESS, workItemId: 'WI-9013-B', workspaceId: 'default' },
      'concrete write',
    );
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-9013-B', workspaceId: '*' })).toBe(
      'concrete write',
    );
  });

  it('workspace-scoped: a checkpoint in another workspace is invisible here', async () => {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1', workspaceId: 'other-ws' }, 'theirs');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1' })).toBeNull(); // default ws
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-1', workspaceId: 'other-ws' })).toBe(
      'theirs',
    );
  });
});

// C6 [P3] — concurrency under contention + the cross-workspace PK isolation guarantee.
// The store is a single UPSERT keyed by (workspace_id, harness_slug, work_item_id). Two bees
// (a re-woken one + a successor, or two surfaces of the same bee) can race a write to the SAME
// checkpoint; the ON CONFLICT DO UPDATE must leave EXACTLY ONE coherent row — one writer's full
// value, never an interleaved/corrupted blob, never two rows. And because the PK leads with
// workspace_id, a write/clear in one workspace must NEVER perturb the same (harness, workItem)
// in another — the multi-workspace install isolation (operator_multi_workspace) rides on this.
describe('work-item checkpoint store (C6) — concurrent writes + cross-workspace PK isolation', () => {
  async function rowsFor(workItemId: string): Promise<{ workspace_id: string; checkpoint: string }[]> {
    // The bee's row is keyed by scope 'workitem:<harness>:<id>' across every workspace.
    return db.sql<{ workspace_id: string; checkpoint: string }[]>`
      SELECT workspace_id, note AS checkpoint FROM harness_shared.carry_notes
       WHERE scope = ${workItemScope(HARNESS, workItemId)} ORDER BY workspace_id`;
  }

  it('two CONCURRENT writes to the same checkpoint → exactly ONE row, value is ONE writer (never corrupted/interleaved)', async () => {
    // Fire N distinct, individually-coherent writers at the same key simultaneously. The UPSERT
    // serializes them; the survivor must be ONE of the inputs verbatim — no row gets a spliced blob.
    const writers = Array.from({ length: 12 }, (_, i) => `writer-${i}-${'='.repeat(i)}|coherent-snapshot`);
    await Promise.all(writers.map((cp) => setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RACE' }, cp)));
    const rows = await rowsFor('WI-RACE');
    expect(rows).toHaveLength(1); // exactly one row survives — the PK held under contention
    expect(writers).toContain(rows[0].checkpoint); // it's one writer's WHOLE value, not a merge
    // The read path agrees with the stored row (no torn read).
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RACE' })).toBe(rows[0].checkpoint);
  });

  it('a concurrent write vs clear converges to a single definite state (one row, or none) — never two rows', async () => {
    // A successor writing while a predecessor clears (eviction) is a legitimate race. Whichever
    // lands last wins; either way the table holds 0-or-1 row for the key — never a duplicate.
    await Promise.all([
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, 'successor wrote this'),
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, ''), // clear
      setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-RC' }, 'and another'),
    ]);
    const rows = await rowsFor('WI-RC');
    expect(rows.length).toBeLessThanOrEqual(1); // 0 (clear won) or 1 (a write won) — never 2
    if (rows.length === 1) {
      expect(['successor wrote this', 'and another']).toContain(rows[0].checkpoint);
    }
  });

  it('cross-workspace PK isolation: a write/clear in WS-A leaves the SAME (harness, workItem) in WS-B untouched', async () => {
    // Same harness + same work-item id in two workspaces are DISTINCT rows (PK leads with workspace_id).
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, 'A-state');
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' }, 'B-state');
    expect(await rowsFor('WI-ISO')).toEqual([
      { workspace_id: 'ws-a', checkpoint: 'A-state' },
      { workspace_id: 'ws-b', checkpoint: 'B-state' },
    ]);

    // Re-WRITE in WS-A → WS-B is unchanged.
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, 'A-state-2');
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' })).toBe(
      'B-state',
    );

    // CLEAR in WS-A → WS-B's row is still present + intact.
    expect(
      await setWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' }, null),
    ).toBeNull();
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-a' })).toBeNull();
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: 'WI-ISO', workspaceId: 'ws-b' })).toBe(
      'B-state',
    );
    // effort-scoped-continuity-2026-09-02 P-003 flipped the work-item scope to
    // journal:true, so a CLEAR no longer deletes the row — the ring outlives the
    // note and WS-A survives with checkpoint null. That is orthogonal to what this
    // test is actually about: WS-B is untouched either way.
    expect(await rowsFor('WI-ISO')).toEqual([
      { workspace_id: 'ws-a', checkpoint: null },
      { workspace_id: 'ws-b', checkpoint: 'B-state' },
    ]);
  });
});

// ───────────────────────────────────────────────────────────────────────────────
// P-007/R-06 — G2, the work-item-specific anti-concealment guard.
//
// G1 (content binding) and G3 (bounded chain) are properties of the stored note and
// are proven in carry-note.integration.test.ts. G2 is the only guard that needs the
// SUBJECT: if the work-item row itself moved after the checkpoint body was written,
// "unchanged" is a false claim no matter what the agent believes, so the honest
// answer is a real checkpoint.
//
// READ THIS BEFORE EDITING: the guard's read is deliberately fail-OPEN (an unreadable
// row must not manufacture a refusal). That makes a broken read INDISTINGUISHABLE from
// a satisfied guard — a wrong column name, a fixture that drifted from the real table,
// and a genuinely-unmoved item all produce the same green. The refusal tests below are
// therefore the canary: fail-open cannot produce a refusal, so they are the only thing
// standing between this suite and a permanent vacuous pass. Keep at least one.
// ───────────────────────────────────────────────────────────────────────────────
describe('P-007/R-06 G2 — an attestation cannot conceal a work-item that moved', () => {
  const ITEM = 'WI-ATTEST';
  const BODY = 'parked waiting on the release gate; nothing has moved';

  /** Write a checkpoint and return the instant its BODY was stored. */
  async function seedCheckpoint(workItemId = ITEM, body = BODY): Promise<number> {
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId }, body);
    const rows = await db.sql<Array<{ body_ts: string | null; updated_ts: string }>>`
      SELECT body_ts, updated_ts FROM harness_shared.carry_notes
       WHERE scope = ${workItemScope(HARNESS, workItemId)}`;
    const row = rows[0];
    if (!row) throw new Error('checkpoint was not stored');
    return Number(row.body_ts ?? row.updated_ts);
  }

  async function insertItem(workItemId: string, updatedTs: number, harnessSlug = 'operator:default'): Promise<void> {
    await db.sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, status, item_kind, updated_ts)
      VALUES ('default', ${harnessSlug}, ${workItemId}, 'open', 'feature', ${updatedTs})`;
  }

  async function attestedCount(workItemId = ITEM): Promise<number> {
    const rows = await db.sql<Array<{ attested_count: number }>>`
      SELECT attested_count FROM harness_shared.carry_notes
       WHERE scope = ${workItemScope(HARNESS, workItemId)}`;
    return Number(rows[0]?.attested_count ?? -1);
  }

  it('passes cheaply for the population that pays for pointless rewrites: an item that has NOT moved', async () => {
    const bodyTs = await seedCheckpoint();
    // The measured case — a parked or blocked agent whose item is exactly where it
    // was when the checkpoint was written.
    await insertItem(ITEM, bodyTs - 60_000);

    const res = await attestWorkItemCheckpointUnchanged(
      { harness: HARNESS, workItemId: ITEM },
      { contentHash: shortCarryHash(BODY) },
    );
    expect(res.ok).toBe(true);
    expect(res.refusedReason).toBeUndefined();
    expect(res.attestedCount).toBe(1);
    expect(res.itemUpdatedAtMs).toBe(bodyTs - 60_000);
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: ITEM })).toBe(BODY); // no rewrite
  });

  it('REFUSES when the item row moved after the body was written (the canary — see the note above)', async () => {
    const bodyTs = await seedCheckpoint();
    // A state flip / reassignment / any write that stamps the item's own clock.
    await insertItem(ITEM, bodyTs + 1);

    const res = await attestWorkItemCheckpointUnchanged(
      { harness: HARNESS, workItemId: ITEM },
      { contentHash: shortCarryHash(BODY) },
    );
    expect(res.ok).toBe(false);
    expect(res.refusedReason).toBe('attestation_state_changed');
    // Reported so the caller can say WHAT moved, not merely that something did.
    expect(res.itemUpdatedAtMs).toBe(bodyTs + 1);
    // The guard runs BEFORE the store write, so a refusal must not have spent a slot
    // from the chain budget — otherwise a rejected attestation silently shrinks the
    // allowance left for a legitimate one.
    expect(await attestedCount()).toBe(0);
  });

  it('a refusal leaves the FULL chain budget available to the real write that follows', async () => {
    const bodyTs = await seedCheckpoint();
    await insertItem(ITEM, bodyTs + 1);
    expect(
      (await attestWorkItemCheckpointUnchanged({ harness: HARNESS, workItemId: ITEM }, {
        contentHash: shortCarryHash(BODY),
      })).refusedReason,
    ).toBe('attestation_state_changed');

    // The agent does what the refusal asked for: writes real state. That write pins a
    // new body_ts ahead of the item's clock, so attestation is available again — with
    // the whole budget, not a budget the refusal quietly ate into.
    const rewritten = 'state after the item actually moved';
    await setWorkItemCheckpoint({ harness: HARNESS, workItemId: ITEM }, rewritten);
    const res = await attestWorkItemCheckpointUnchanged(
      { harness: HARNESS, workItemId: ITEM },
      { contentHash: shortCarryHash(rewritten) },
    );
    expect(res.ok).toBe(true);
    expect(res.remainingAttestations).toBe(CARRY_NOTE_ATTESTATION_MAX_CHAIN - 1);
  });

  it('a same-id row in ANOTHER harness that moved also refuses — the guard reads MAX, never an arbitrary row', async () => {
    const bodyTs = await seedCheckpoint();
    // feature_id is unique only WITH harness_slug, and a checkpoint scope may carry the
    // wildcard harness, so one id can match several rows. A joined LIMIT 1 would pick
    // one arbitrarily — and picking arbitrarily can answer in the PASS direction,
    // concealing exactly the movement this guard exists to catch. MAX is refuse-biased.
    await insertItem(ITEM, bodyTs - 60_000, 'harness-a');
    await insertItem(ITEM, bodyTs + 1, 'harness-b');

    const res = await attestWorkItemCheckpointUnchanged(
      { harness: HARNESS, workItemId: ITEM },
      { contentHash: shortCarryHash(BODY) },
    );
    expect(res.refusedReason).toBe('attestation_state_changed');
    expect(res.itemUpdatedAtMs).toBe(bodyTs + 1); // the newest of the two, deterministically
  });

  it('no work-item row at all: G2 cannot fire, and G1/G3 still bound the attestation', async () => {
    await seedCheckpoint();
    // Nothing inserted — the subject is unreadable, not unmoved.
    const ok = await attestWorkItemCheckpointUnchanged(
      { harness: HARNESS, workItemId: ITEM },
      { contentHash: shortCarryHash(BODY) },
    );
    expect(ok.ok).toBe(true);
    expect(ok.itemUpdatedAtMs).toBeNull(); // honest: not "it did not move", but "unknown"

    // G1 is still reached through the wrapper — the work-item path delegates to the
    // store's guards rather than replacing them.
    const mismatch = await attestWorkItemCheckpointUnchanged(
      { harness: HARNESS, workItemId: ITEM },
      { contentHash: shortCarryHash('a body nobody stored') },
    );
    expect(mismatch.refusedReason).toBe('attestation_hash_mismatch');
    expect(mismatch.currentHash).toBe(shortCarryHash(BODY));
  });

  it('returns a bounded typed timeout when the checkpoint row is locked, without changing the body', async () => {
    const item = 'WI-ATTEST-CONTENTION';
    const body = 'checkpoint body remains intact during transient lock contention';
    const bodyTs = await seedCheckpoint(item, body);
    const scope = workItemScope(HARNESS, item);

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockedResolve!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockedResolve = resolve;
    });
    const blocker = db.sql.begin(async (tx) => {
      await tx`
        SELECT note
          FROM harness_shared.carry_notes
         WHERE workspace_id = 'default' AND scope = ${scope}
         FOR UPDATE`;
      lockedResolve();
      await held;
    });

    await locked;
    const startedAt = Date.now();
    let error: unknown;
    try {
      await attestWorkItemCheckpointUnchanged(
        { harness: HARNESS, workItemId: item },
        { contentHash: shortCarryHash(body) },
      );
    } catch (caught) {
      error = caught;
    } finally {
      release();
      await blocker;
    }

    expect(error).toMatchObject({ name: 'OrgTxnTimeoutError', pgCode: '55P03' });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(await getWorkItemCheckpoint({ harness: HARNESS, workItemId: item })).toBe(body);
    expect(bodyTs).toBeGreaterThan(0);
  });

  it('a failing G2 read fails OPEN — a guard that cannot run must not become a new way to block', async () => {
    await seedCheckpoint();
    // Make the guarded read throw outright, the way a missing table/column or a
    // permissions fault would in production.
    await db.sql.unsafe('ALTER TABLE harness_shared.work_items RENAME TO work_items_hidden');
    try {
      const res = await attestWorkItemCheckpointUnchanged(
        { harness: HARNESS, workItemId: ITEM },
        { contentHash: shortCarryHash(BODY) },
      );
      expect(res.ok).toBe(true);
      expect(res.itemUpdatedAtMs).toBeNull();
    } finally {
      await db.sql.unsafe('ALTER TABLE harness_shared.work_items_hidden RENAME TO work_items');
    }
  });

  it('attestation refuses for an item that never had a checkpoint — nothing to be still-current about', async () => {
    await insertItem('WI-NO-CHECKPOINT', Date.now());
    const res = await attestWorkItemCheckpointUnchanged(
      { harness: HARNESS, workItemId: 'WI-NO-CHECKPOINT' },
      { contentHash: shortCarryHash('anything') },
    );
    expect(res.ok).toBe(false);
    expect(res.refusedReason).toBe('attestation_no_checkpoint');
    expect(await rowCount()).toBe(0); // and it did not invent a row
  });
});
