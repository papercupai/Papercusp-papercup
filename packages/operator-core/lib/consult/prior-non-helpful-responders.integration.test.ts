/**
 * prior-non-helpful-responders.integration.test.ts — `priorNonHelpfulResponders`
 * against a REAL Postgres. WI-10002406.
 *
 * THE BUG. The function's job is to stop `consult:get_feedback` re-offering a
 * verbatim-identical question to someone who already refused it. It used to
 * read the decline set from `consult_state.cascade_digest`, whose own doc
 * comment called it "the append-only record of who declined this consult".
 * It is append-only with a SLIDING WINDOW: `cascade-core` writes
 * `[...prev, event].slice(-CASCADE_DIGEST_MAX_ENTRIES)` with a cap of 16, so a
 * decline early in a long cascade is silently evicted — and the agent who made
 * it becomes eligible for re-offer. The failure direction is the bad one: an
 * under-report is indistinguishable from "nobody declined", so there is no
 * error and nothing to notice. Same silent shape, and the same fix, as
 * WI-10002369 next door (`resolvePriorGradingDecliners`).
 *
 * WHY A REAL-PG TEST. Every claim that makes the fix correct lives in the SQL:
 * that the decline is recovered from `consult_post_meta` (immutable, one row
 * per decline post, neither truncated nor advanced), that the join is scoped
 * per conversation, and that `kind` is respected. A mock of the reader could
 * only prove that whatever it returns gets returned.
 *
 * CONTROLS. Per the house discipline (see
 * acceptance-grader-prior-decliners.integration.test.ts): every predicate is
 * asserted against a near-identical row that must NOT match, so the suite can
 * tell a working predicate from `WHERE true`. The overflow fixture also
 * carries a CALIBRATION assertion that the digest genuinely lacks the decliner
 * — without it, the load-bearing test could pass for the wrong reason (a
 * fixture that never actually overflowed), which is precisely the vacuous
 * green this bug class produces.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { priorNonHelpfulResponders } from './get-feedback-core';
import {
  CASCADE_DIGEST_MAX_ENTRIES,
  digestFromRow,
  makeDigestEntry,
  type CascadeDigestEntry,
} from './cascade-core';

const WS = 'ws-prior-non-helpful';
const OTHER_WS = 'ws-somebody-else';
const REQUESTER = 'su-requester-asking-again';
const OTHER_REQUESTER = 'su-a-different-requester';
const QUESTION = 'why does the frozen repair queue never resume?';
const OTHER_QUESTION = 'why does the frozen repair queue never resume???';

const DECLINER = 'su-c03852cb-the-agent-who-refused';
/** The agent `responder_id` advanced to. Never declined anything. */
const ADVANCED_RESPONDER = 'su-cb56af59-never-declined';

const MIGRATION_834 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);
const MIGRATION_844 = fileURLToPath(
  new URL('../../../../libs/papercusp/libs/db/sql/844-consult-cascade-cursor.sql', import.meta.url),
);

let rootSql: Sql;
let fixtureDb: MigratedTestDb;
let seq = 0;

/**
 * A digest in which `DECLINER`'s decline has been EVICTED by the sliding
 * window — built by folding events through the same expression `cascade-core`
 * uses, so the fixture cannot drift from the writer it represents.
 */
function overflowedDigest(): CascadeDigestEntry[] {
  const at = '2026-09-22T00:00:00.000Z';
  const decline = makeDigestEntry(DECLINER, 'decline', at, 'cannot help with this');
  const later = Array.from({ length: CASCADE_DIGEST_MAX_ENTRIES }, (_, i) =>
    makeDigestEntry(`su-filler-${i}`, 'answer', at, `reply ${i}`),
  );
  return [decline, ...later].slice(-CASCADE_DIGEST_MAX_ENTRIES);
}

async function insertConsult(opts: {
  /** Written to consult_post_meta as an immutable decline post. */
  declinedBy?: string | null;
  postKind?: string;
  digest?: CascadeDigestEntry[];
  workspaceId?: string;
  requesterId?: string;
  question?: string;
  /** Who the row's responder_id advanced to — deliberately NOT the decliner. */
  responderId?: string | null;
  state?: string;
}): Promise<string> {
  const workspaceId = opts.workspaceId ?? WS;
  const conversationId = `conv-nonhelpful-${(seq += 1).toString().padStart(4, '0')}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, question, cascade_digest)
    VALUES (
      ${workspaceId},
      ${conversationId},
      ${opts.requesterId ?? REQUESTER},
      ${/* `??` would swallow an explicit null, silently reinstating the
            advanced responder in every control that needs the column EMPTY —
            which reads as the implementation over-returning. */
      opts.responderId === undefined ? ADVANCED_RESPONDER : opts.responderId},
      ${opts.state ?? 'declined'},
      ${opts.question ?? QUESTION},
      ${rootSql.json((opts.digest ?? []) as never)}
    )`;
  if (opts.declinedBy) {
    await rootSql`
      INSERT INTO harness_shared.consult_post_meta
        (workspace_id, post_id, conversation_id, author_id, kind)
      VALUES (
        ${workspaceId},
        ${(seq += 1000)},
        ${conversationId},
        ${opts.declinedBy},
        ${opts.postKind ?? 'decline'}
      )`;
  }
  return conversationId;
}

async function truncate(): Promise<void> {
  await rootSql`DELETE FROM harness_shared.consult_post_meta`;
  await rootSql`DELETE FROM harness_shared.consult_state`;
}

/**
 * THE PRE-FIX IMPLEMENTATION, kept here permanently as a CONTROL — the tier
 * this repo prescribes for a subject you `import` (never mutate the shared
 * tree to prove a guard falsifiable). It reads exactly what the function read
 * before WI-10002406: `responder_id` + `cascade_digest`, and nothing else.
 *
 * It must FAIL to see a decline evicted from the digest window, and must still
 * SUCCEED on a non-overflowed fixture. Both halves are asserted below: the
 * failure is what makes the real assertion non-vacuous, and the success is the
 * calibration proving this control is blind specifically to eviction rather
 * than simply broken.
 */
async function preFixResponders(): Promise<string[]> {
  const rows = (await rootSql`
    SELECT responder_id, cascade_digest
      FROM harness_shared.consult_state
     WHERE workspace_id = ${WS}
       AND requester_id = ${REQUESTER}
       AND question = ${QUESTION}
       AND state IN ('closed_cant_help', 'declined')
  `) as unknown as Array<{ responder_id: string | null; cascade_digest: unknown }>;
  const owners = new Set<string>();
  for (const row of rows) {
    if (row.responder_id) owners.add(row.responder_id);
    for (const entry of digestFromRow(row.cascade_digest)) {
      if (entry.kind === 'decline') owners.add(entry.ownerId);
    }
  }
  return [...owners];
}

const ask = (over?: { workspaceId?: string; requesterId?: string; question?: string }) =>
  priorNonHelpfulResponders(
    rootSql,
    over?.workspaceId ?? WS,
    over?.requesterId ?? REQUESTER,
    over?.question ?? QUESTION,
  );

beforeAll(async () => {
  fixtureDb = await createFreshTestDb({ prefix: 'nonhelpful' });
  rootSql = postgres(fixtureDb.url, { max: 1, onnotice: () => {} });
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  // Landing pad for the migration's coord_conversations kind-CHECK widening
  // (the real table is migration-132-owned).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      workspace_id text NOT NULL,
      id text NOT NULL,
      kind text NOT NULL DEFAULT 'question',
      state text NOT NULL DEFAULT 'open',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (workspace_id, id)
    )`);
  // The REAL migrations — consult_state + consult_post_meta + cascade_digest
  // cannot drift from the shipped schema.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
  await rootSql.unsafe(
    readFileSync(existsSync(MIGRATION_844) ? MIGRATION_844 : `${MIGRATION_844}.DRAFT`, 'utf8'),
  );
}, 120_000);

afterAll(async () => {
  try { await rootSql?.end({ timeout: 5 }); }
  finally { await fixtureDb?.drop(); }
});

describe('WI-10002406: a decline evicted from the digest window is still remembered', () => {
  /**
   * THE LOAD-BEARING CASE — the one the pre-fix implementation fails while
   * passing every other test here. The decline is real and recorded, but the
   * cascade ran long enough that the digest no longer carries it.
   */
  it('names a decliner whose digest entry was evicted by the 16-entry window', async () => {
    await truncate();
    const digest = overflowedDigest();

    // CALIBRATION: the fixture must really be the overflow case. If the digest
    // still carried the decliner, a digest-only implementation would pass and
    // this test would prove nothing.
    expect(digest).toHaveLength(CASCADE_DIGEST_MAX_ENTRIES);
    expect(digest.map((e) => e.ownerId)).not.toContain(DECLINER);

    await insertConsult({ declinedBy: DECLINER, digest });

    // FALSIFIABILITY: the pre-fix implementation, against this exact fixture,
    // cannot see the decliner. Without this the assertion below could not
    // distinguish the fix from any implementation that happens to return them.
    expect(await preFixResponders()).not.toContain(DECLINER);

    expect(await ask()).toContain(DECLINER);
  });

  it('still reads a decline that IS in the digest but has no post row (union, not swap)', async () => {
    await truncate();
    const at = '2026-09-22T00:00:00.000Z';
    await insertConsult({
      digest: [makeDigestEntry(DECLINER, 'decline', at, 'cannot help')],
      declinedBy: null,
      responderId: null,
    });

    // CALIBRATION for the control above: on a digest that never overflowed it
    // DOES find the decliner, so its blindness in the eviction case is about
    // the sliding window and not about the control being broken.
    expect(await preFixResponders()).toEqual([DECLINER]);

    expect(await ask()).toEqual([DECLINER]);
  });

  it('still reads responder_id, which is the closer on a closed_cant_help terminal', async () => {
    await truncate();
    await insertConsult({ state: 'closed_cant_help', responderId: DECLINER, declinedBy: null });

    expect(await ask()).toEqual([DECLINER]);
  });

  it('unions all three sources without duplicating an agent found in more than one', async () => {
    await truncate();
    const at = '2026-09-22T00:00:00.000Z';
    await insertConsult({
      declinedBy: DECLINER,
      digest: [makeDigestEntry(DECLINER, 'decline', at, 'cannot help')],
      responderId: DECLINER,
    });

    const owners = await ask();
    expect(owners).toEqual([DECLINER]);
    expect(owners.filter((o) => o === DECLINER)).toHaveLength(1);
  });
});

describe('WI-10002406 controls: each predicate must reject a near-identical row', () => {
  it('does not return a decliner from a DIFFERENT workspace', async () => {
    await truncate();
    await insertConsult({ declinedBy: DECLINER, workspaceId: OTHER_WS, responderId: null });

    expect(await ask()).toEqual([]);
    // Positive control: the same row IS found when asked for under its own workspace.
    expect(await ask({ workspaceId: OTHER_WS })).toEqual([DECLINER]);
  });

  it('does not return a decliner from a DIFFERENT requester', async () => {
    await truncate();
    await insertConsult({ declinedBy: DECLINER, requesterId: OTHER_REQUESTER, responderId: null });

    expect(await ask()).toEqual([]);
    expect(await ask({ requesterId: OTHER_REQUESTER })).toEqual([DECLINER]);
  });

  it('matches the question EXACTLY — a near-identical re-ask is a different question', async () => {
    await truncate();
    await insertConsult({ declinedBy: DECLINER, question: OTHER_QUESTION, responderId: null });

    expect(await ask()).toEqual([]);
    expect(await ask({ question: OTHER_QUESTION })).toEqual([DECLINER]);
  });

  it('ignores a consult whose state is neither declined nor closed_cant_help', async () => {
    await truncate();
    await insertConsult({ declinedBy: DECLINER, state: 'closed_answered', responderId: null });

    expect(await ask()).toEqual([]);
  });

  it('ignores a post_meta row whose kind is not a decline', async () => {
    await truncate();
    await insertConsult({ declinedBy: DECLINER, postKind: 'answer', responderId: null });

    expect(await ask()).toEqual([]);
  });

  it('does not attribute one conversation’s decline to another conversation', async () => {
    await truncate();
    // A decline recorded against a consult that does NOT match the question.
    await insertConsult({
      declinedBy: DECLINER,
      question: OTHER_QUESTION,
      responderId: null,
    });
    // A matching consult with no decline of its own.
    await insertConsult({ declinedBy: null, responderId: null });

    expect(await ask()).toEqual([]);
  });
});
