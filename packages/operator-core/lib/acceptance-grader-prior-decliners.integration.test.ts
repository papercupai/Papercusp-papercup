/**
 * acceptance-grader-prior-decliners.integration.test.ts — `resolvePriorGradingDecliners`
 * against a REAL Postgres. WI-10002369.
 *
 * WHY A REAL-PG TEST, AND NOT JUST THE UNIT TEST NEXT DOOR. The sibling unit
 * test in `acceptance-grader.test.ts` INJECTS `readPriorDecliners`, so it can
 * only prove that whatever the reader returns gets merged into the exclusion
 * set. Every claim that actually makes this fix correct lives in the SQL and is
 * invisible there:
 *
 *   - that the decline is read from `consult_post_meta.author_id` and NOT from
 *     `consult_state.responder_id`, which ADVANCES PAST the decliner;
 *   - that `kind = 'decline'` really discriminates a refusal from an answer;
 *   - that the plan / rubric / workspace predicates are not `WHERE true`.
 *
 * A jsonb path typo, a column rename, or a predicate that silently matches
 * nothing all survive the unit test and then degrade into "nobody ever
 * declined" — which is indistinguishable from the bug this fixes: the recruiter
 * re-offers grading to an agent who already refused. Only a real round-trip
 * through the migration-owned tables can falsify that.
 *
 * THE MEASURED SHAPE THIS ENCODES (plan bash-substitution-reachable-ceiling-2026-08-01,
 * 2026-09-22). Three grading cascades; `responder_id` read su-cb56af59 on ALL
 * THREE, while the agent who actually ran `consult:decline` was su-c03852cb.
 * conv-mucapfpl recorded that decline at 06:40:52Z, and conv-mucb58ib — opened
 * 06:43:14Z — re-selected su-c03852cb, who then let it expire. The
 * `responder_id`-vs-decliner divergence is therefore not hypothetical, and the
 * control below reproduces it exactly.
 *
 * CONTROLS. Per the house discipline (see acceptance-grading-authority.integration.test.ts):
 * every predicate is asserted against a near-identical row that must NOT match.
 * A test that only ever inserts matching rows cannot tell a working predicate
 * from `WHERE true`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

const WS = 'ws-prior-decliners';
const OTHER_WS = 'ws-somebody-else';
const PLAN = 'ship-the-thing-2026-09-22';
const OTHER_PLAN = 'some-other-plan-2026-09-22';
const RUBRIC = 'acceptance-ship-the-thing';
const OTHER_RUBRIC = 'acceptance-something-else';

const DECLINER = 'su-c03852cb-the-agent-who-refused';
/** The agent `responder_id` advances to. Never declined anything. */
const ADVANCED_RESPONDER = 'su-cb56af59-never-declined';

const MIGRATION_834 = fileURLToPath(
  new URL('../../../libs/papercusp/libs/db/sql/834-consult-threads.sql', import.meta.url),
);

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

// Imported AFTER the mock so the module binds the test pool.
const { resolvePriorGradingDecliners } = await import('./acceptance-grader');
const { GRADING_CASCADE_FLAVOR } = await import('./consult/grading-cascade');

let rootSql: Sql;
let seq = 0;

/** A grading cascade + optionally the decline post that names its real decliner. */
async function insertCascade(opts: {
  declinedBy?: string | null;
  postKind?: string;
  workspaceId?: string;
  planSlug?: string;
  rubricId?: string;
  flavor?: string;
  /** Who the row's responder_id advanced to — deliberately NOT the decliner. */
  responderId?: string;
  state?: string;
}): Promise<string> {
  const workspaceId = opts.workspaceId ?? WS;
  const conversationId = `conv-decliner-${(seq += 1).toString().padStart(4, '0')}`;
  await rootSql`
    INSERT INTO harness_shared.consult_state
      (workspace_id, conversation_id, requester_id, responder_id, state, routing)
    VALUES (
      ${workspaceId},
      ${conversationId},
      ${'system:acceptance-grading-sweep'},
      ${opts.responderId ?? ADVANCED_RESPONDER},
      ${opts.state ?? 'declined'},
      ${rootSql.json({
        cascade: {
          flavor: opts.flavor ?? GRADING_CASCADE_FLAVOR,
          planSlug: opts.planSlug ?? PLAN,
          rubricId: opts.rubricId ?? RUBRIC,
        },
      } as never)}
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

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `decliners_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 1, onnotice: () => {} });
  h.sql = rootSql;
  await rootSql.unsafe('CREATE SCHEMA harness_shared');
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.coord_conversations (
      id text PRIMARY KEY,
      kind text NOT NULL DEFAULT 'question'
    )`);
  // The REAL migration — the reader cannot drift from the shipped schema.
  await rootSql.unsafe(readFileSync(MIGRATION_834, 'utf8'));
}, 120_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

describe('WI-10002369: a prior grading decliner is remembered across cascades', () => {
  it('returns the agent who declined a grading cascade for this plan+rubric', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual([
      DECLINER,
    ]);
  });

  /**
   * THE LOAD-BEARING CASE, and the one a `responder_id`-based implementation
   * passes every other test while failing. Measured in production: the decline
   * ADVANCES the chain (D-005 always-advance), so the row's responder_id is a
   * DIFFERENT agent who never refused. Excluding on responder_id would both
   * miss the real decliner (re-offering to them — the bug) and exclude an
   * innocent candidate (shrinking an already-scarce pool).
   */
  it('names the DECLINER, not the responder the cascade advanced to', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER, responderId: ADVANCED_RESPONDER });

    const decliners = await resolvePriorGradingDecliners(
      { workspaceId: WS, planSlug: PLAN },
      RUBRIC,
    );

    expect(decliners).toEqual([DECLINER]);
    expect(decliners).not.toContain(ADVANCED_RESPONDER);
  });

  /**
   * FALSIFIABILITY CONTROL — a deliberately-WRONG implementation, kept
   * permanently rather than mutated into the tree for one run (CLAUDE.md
   * § "Proving a guard is falsifiable": for a module you import, the control
   * lives in the test file).
   *
   * It runs the plausible `responder_id` query against the SAME fixture. Three
   * things follow from it, none of which the assertions above can establish on
   * their own:
   *  1. the fixture genuinely DISCRIMINATES the two implementations — without
   *     this, every test above would pass just as happily against the wrong
   *     query, i.e. they would be testing `WHERE true`;
   *  2. the round-trip is real — this control reads a value out of Postgres
   *     that no test literal supplies to the subject, so a suite that somehow
   *     never reached the database could not produce it;
   *  3. if a later "simplification" swaps the subject to responder_id, the
   *     load-bearing test above goes red instead of silently re-opening the bug.
   */
  it('CONTROL: the responder_id implementation returns the WRONG agent on this fixture', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER, responderId: ADVANCED_RESPONDER });

    const wrong = (await rootSql`
      SELECT DISTINCT cs.responder_id AS owner_id
        FROM harness_shared.consult_state cs
       WHERE cs.workspace_id = ${WS}
         AND cs.state = 'declined'
         AND cs.routing -> 'cascade' ->> 'planSlug' = ${PLAN}
         AND cs.routing -> 'cascade' ->> 'rubricId' = ${RUBRIC}
    `) as unknown as Array<{ owner_id: string }>;

    // The wrong implementation names the agent the cascade advanced TO...
    expect(wrong.map((row) => row.owner_id)).toEqual([ADVANCED_RESPONDER]);
    // ...while the subject names the agent who actually refused. CALIBRATION:
    // the real subject must pass on the very fixture that fails the wrong one.
    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual([
      DECLINER,
    ]);
  });

  it('deduplicates an agent who declined more than one cascade for the same plan', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER });
    await insertCascade({ declinedBy: DECLINER });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual([
      DECLINER,
    ]);
  });

  // ── CONTROLS: each predicate asserted against a row that must NOT match ────

  it('does NOT treat an EXPIRED no-show as a refusal', async () => {
    await truncate();
    // A cascade that timed out with no decline post: the agent may simply have
    // been asleep, and the expiry sweep already retries that case.
    await insertCascade({ declinedBy: null, state: 'expired' });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual(
      [],
    );
  });

  it('does NOT exclude an agent whose post was an ANSWER rather than a decline', async () => {
    await truncate();
    await insertCascade({ declinedBy: 'su-helpful-answerer', postKind: 'answer' });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual(
      [],
    );
  });

  it('does NOT leak a decline from a DIFFERENT plan', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER, planSlug: OTHER_PLAN });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual(
      [],
    );
  });

  it('does NOT leak a decline from a DIFFERENT rubric on the same plan', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER, rubricId: OTHER_RUBRIC });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual(
      [],
    );
  });

  it('does NOT leak a decline from a DIFFERENT workspace (tenancy)', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER, workspaceId: OTHER_WS });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual(
      [],
    );
  });

  it('does NOT leak a decline from a non-grading consult that merely shares the plan slug', async () => {
    await truncate();
    await insertCascade({ declinedBy: DECLINER, flavor: 'rubric-vetting' });

    expect(await resolvePriorGradingDecliners({ workspaceId: WS, planSlug: PLAN }, RUBRIC)).toEqual(
      [],
    );
  });
});
