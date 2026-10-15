/**
 * work_items completion-attribution BACKFILL — REAL-PG guard for migration 729
 * (WI-7057). Sibling of work-items-terminal-attribution-preserve.integration.test.ts,
 * which guards migration 726: 726 is the PROTECTION (a NULL-carrying federated op
 * can no longer clear a populated completion record), 729 is the REPAIR of the 306
 * rows that were already destroyed before it landed.
 *
 * WHY REAL PG. The repair is a DO-block migration whose entire behaviour is which
 * rows it selects and which columns it declines to write. There is no TypeScript
 * seam to mock, and the interesting assertions are all negative — "authority was
 * NOT written", "the remote cohort was NOT touched" — which only mean something
 * against the real statement running on real rows.
 *
 * WHAT IT PINS, and why each one is here rather than assumed:
 *
 *   1. PART A — a row whose closer survives in the invocation ledger gets
 *      terminal_owner restored from it, including through the FLAT arg form
 *      (path 5 of the five aliasing paths migration 683 documents, and the one
 *      an earlier pass actually missed).
 *
 *   2. THE TRAP GUARD — `authority` is never written. This is the assertion the
 *      whole migration header is an argument for. Deriving authority from the
 *      surviving _completionEvidence looks free and is wrong: measured on the
 *      untouched control population, that derivation predicts 'committed' for
 *      2,020 rows of which 1,426 actually store NULL. A repair that wrote it
 *      would fabricate a uniform, plausible value onto 306 rows. Nothing else
 *      in this file would notice — every other assertion passes either way.
 *
 *   3. PART B — a row whose closer is NOT recoverable is MARKED, not guessed.
 *      terminal_owner stays NULL and _attributionLoss records why. An invented
 *      attribution is the same defect as the original bug: a completion record
 *      that reads as authoritative and is not.
 *
 *   4. THE COHORT CONTROLS — the two populations that look damaged and are not.
 *      A remote-origin replica (100% NULL attribution, because it never
 *      federates) and a clean local+local row must both be left alone. Without
 *      these, a repair that simply filled every NULL terminal_owner in the table
 *      would pass tests 1-3 and silently invent attribution for 1,856 replicas.
 *
 *   5. NON-DESTRUCTION — lifecycle status, _completionEvidence and a surviving
 *      terminal_completion_ref are never overwritten.
 *
 *   6. IDEMPOTENCE — a second apply is a no-op, asserted by the marker timestamp
 *      not moving rather than by row counts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createFreshPgDb, applyMigrationsForTest, type FreshPgDb } from '../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../test/_work-items-schema';

const WS = 'ws-attribution-backfill';
const SLUG = 'papercusp';

const BASE_DDL = `
  ${HARNESS_FEATURES_CONSOLIDATED_DDL}

  -- Migration 698's PREDICATE, which both 726 and 729 depend on. 698 itself is not
  -- applied here for the reason the sibling guard spells out: the canonical fixture
  -- already carries 698's column + view effects, so re-running its pg_get_viewdef
  -- surgery fails with "cannot change name of view column". Only the functions are
  -- missing, because _work-items-schema.ts models tables and views only.
  CREATE OR REPLACE FUNCTION harness_shared.work_item_status_is_terminal(s text)
  RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $fn$
    SELECT s = ANY (ARRAY['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'])
  $fn$;

  -- The invocation ledger 729 recovers closers from. Only the columns the
  -- migration actually reads; this is a fixture, not a schema mirror.
  CREATE TABLE IF NOT EXISTS harness_shared.tool_invocations (
    id BIGSERIAL PRIMARY KEY,
    workspace_id text NOT NULL,
    coord_owner_id text,
    tool_name text NOT NULL,
    status text NOT NULL DEFAULT 'ok',
    args_json jsonb,
    invoked_at timestamptz NOT NULL DEFAULT now()
  );
`;

/** The evidence blob that survived the clobber on every damaged row. */
const EVIDENCE = { verifiedHow: 'unit', testsRun: 'npm run test:file -- x.test.ts', testResult: '7/7 passed' };

describe('work_items completion-attribution backfill (migration 729)', () => {
  let db: FreshPgDb;
  let sql: FreshPgDb['sql'];

  beforeAll(async () => {
    db = await createFreshPgDb('attrbackfill');
    sql = db.sql;
    await sql.unsafe(BASE_DDL);
    await applyMigrationsForTest(
      sql,
      [
        '725-payload-object-shape-guard-and-plan-item-stamp-index.sql',
        '726-preserve-terminal-attribution-on-federated-write.sql',
        '741-work-items-condition-key-singleton.sql',
        '777-work-items-embedding-recipe-discriminator.sql',
        '1110-work-items-admission-flags-generated-columns.sql',
        '1135-work-items-epoch-ms-timestamp-guard.sql',
        '1194-work-items-directive-ref.sql',
        '1294-work-item-readiness-payload-projections.sql',
        '1308-work-items-severity-projection.sql',
      ],
      {
        label: 'work-items-attribution-backfill',
        // Like the terminal-attribution sibling, this fixture already carries
        // 721's lane column and wider current family views. Replaying its older
        // CREATE OR REPLACE VIEW select lists would drop columns before any
        // attribution assertion runs. Keep all other migrations audited.
        knownInapplicable: [
          {
            file: '721-work-items-lane-generated-column.sql',
            reason:
              'The consolidated fixture already models the lane generated column and wider current family views. Replaying 721 replaces them with narrower historical select lists: PostgreSQL refuses to drop columns from a view.',
          },
        ],
      },
    );
    await seedAll();
    // PC_SKIP_729=1 runs this file WITHOUT the repair, which is how the guard was
    // proved to be a guard: 7 fail / 5 pass, and the 5 that still pass are exactly
    // the negative controls + the authority trap guard, which SHOULD pass vacuously
    // when no repair ran. (The trap guard was proved separately, by adding
    // `authority = 'committed'` to 729's Part A UPDATE: 1 failed / 11 passed, the one
    // failure being that guard.) Skipping can only ever produce failures, never a
    // green — so a stray env var reds the suite rather than hiding a regression.
    if (!process.env.PC_SKIP_729) await applyBackfill();
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  const applyBackfill = () =>
    applyMigrationsForTest(sql, ['729-wi7057-restore-clobbered-terminal-attribution.sql'], {
      label: 'work-items-attribution-backfill:729',
      // The list is deliberately partial (this file provisions the rest by hand),
      // so the staleness audit has nothing meaningful to check.
      audit: false,
    });

  /**
   * A row in the DAMAGED shape: locally created, overwritten by a peer op, its
   * terminal_owner cleared while payload._completionEvidence survived.
   */
  async function seedDamaged(
    id: string,
    opts: {
      origin?: string;
      authorPubkey?: string | null;
      terminalOwner?: string | null;
      completionRef?: string | null;
      authority?: string | null;
      status?: string;
      evidence?: unknown;
    } = {},
  ) {
    const {
      origin = 'local',
      authorPubkey = 'peer-3229ad4b3b994b12',
      terminalOwner = null,
      completionRef = null,
      authority = null,
      status = 'done',
      evidence = EVIDENCE,
    } = opts;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts,
         origin, author_pubkey, terminal_owner, terminal_completion_ref, authority, payload)
      VALUES (${WS}, ${SLUG}, ${id}, 'bug', ${status}, ${'t-' + id}, ${Date.now()}, ${Date.now()},
              ${origin}, ${authorPubkey}, ${terminalOwner}, ${completionRef}, ${authority},
              ${sql.json({ _completionEvidence: evidence } as never)})`;
    return id;
  }

  /** A terminal close recorded in the invocation ledger. */
  async function seedClose(
    itemId: string,
    owner: string,
    opts: { at?: string; flat?: boolean; ref?: string; sufficient?: boolean; toolName?: string } = {},
  ) {
    const { at, flat = false, ref, sufficient = true, toolName = 'work_items:complete' } = opts;
    const completion = sufficient
      ? { verifiedHow: 'unit', testResult: 'green' }
      : { summary: 'no verification recorded' };
    // FLAT form (path 5): the completion fields arrive as TOP-LEVEL args with no
    // `completion` wrapper, lifted by gatherFlatCompletion. The object form nests
    // them. Both must resolve to the same closer.
    const args = flat
      ? { id: itemId, ...completion, ...(ref ? { completionRef: ref } : {}) }
      : { id: itemId, completion, ...(ref ? { completionRef: ref } : {}) };
    await sql`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, coord_owner_id, tool_name, status, args_json, invoked_at)
      VALUES (${WS}, ${owner}, ${toolName}, 'ok', ${sql.json(args as never)},
              ${at ?? new Date().toISOString()})`;
  }

  async function read(id: string) {
    const [row] = await sql<
      {
        status: string;
        terminal_owner: string | null;
        terminal_completion_ref: string | null;
        authority: string | null;
        terminal_reason: string | null;
        payload: Record<string, unknown> | null;
      }[]
    >`
      SELECT status, terminal_owner, terminal_completion_ref, authority, terminal_reason, payload
        FROM harness_shared.work_items
       WHERE harness_slug = ${SLUG} AND feature_id = ${id}`;
    return row;
  }

  async function seedAll() {
    // --- Part A candidates: the closer survives in the ledger. ---------------
    await seedDamaged('wi-a-object');
    await seedClose('wi-a-object', 'su-closer-object', { ref: 'ref-from-ledger' });

    await seedDamaged('wi-a-flat');
    await seedClose('wi-a-flat', 'su-closer-flat', { flat: true });

    // Two closers: the first SUFFICIENT one must win, even though it is second
    // in time. This is the guard's rule (683), not "first wins".
    await seedDamaged('wi-a-two-closers');
    await seedClose('wi-a-two-closers', 'su-closer-thin', {
      at: '2026-07-20T01:00:00Z',
      sufficient: false,
    });
    await seedClose('wi-a-two-closers', 'su-closer-verified', {
      at: '2026-07-20T02:00:00Z',
      sufficient: true,
    });

    // A ref that SURVIVED the clobber must not be replaced by the ledger's.
    await seedDamaged('wi-a-keeps-ref', { completionRef: 'ref-survived' });
    await seedClose('wi-a-keeps-ref', 'su-closer-ref', { ref: 'ref-from-ledger' });

    // --- Part B: no recoverable closer. --------------------------------------
    await seedDamaged('wi-b-unrecoverable');

    // A ledger row that must NOT count as a close: wrong item, and a non-terminal
    // state for the right item.
    await seedDamaged('wi-b-only-reopen');
    await seedClose('wi-b-only-reopen', 'su-reopener', { toolName: 'work_items:set_state' });
    await sql`
      UPDATE harness_shared.tool_invocations
         SET args_json = ${sql.json({ id: 'wi-b-only-reopen', state: 'open' } as never)}
       WHERE coord_owner_id = 'su-reopener'`;

    // --- Cohort controls: look damaged, are not. -----------------------------
    // A remote replica. 100% of these have NULL attribution because it never
    // federates — inventing one would be a fabrication, not a repair.
    await seedDamaged('wi-c-remote', { origin: 'remote' });
    await seedClose('wi-c-remote', 'su-closer-remote');

    // A clean local+local row: no peer ever touched it, so a NULL here would be
    // a genuine absence, not damage. (Seeded owner-NULL deliberately — the point
    // is that author_pubkey IS NULL excludes it regardless.)
    await seedDamaged('wi-c-local-local', { authorPubkey: null });
    await seedClose('wi-c-local-local', 'su-closer-local');

    // A row with NO surviving evidence blob: nothing proves it ever had
    // attribution, so it is outside the damaged set by definition.
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, created_ts, updated_ts,
         origin, author_pubkey, terminal_owner, payload)
      VALUES (${WS}, ${SLUG}, 'wi-c-no-evidence', 'bug', 'done', 't', ${Date.now()}, ${Date.now()},
              'local', 'peer-3229ad4b3b994b12', NULL, '{}'::jsonb)`;
    await seedClose('wi-c-no-evidence', 'su-closer-noev');

    // A live (non-terminal) row a peer touched. Nothing to attribute yet.
    await seedDamaged('wi-c-open', { status: 'open' });
    await seedClose('wi-c-open', 'su-closer-open');
  }

  // -------------------------------------------------------------------------
  // 1. PART A — restore the evidenced closer.
  // -------------------------------------------------------------------------
  it('restores terminal_owner from the invocation ledger and records where it came from', async () => {
    const row = await read('wi-a-object');
    expect(row.terminal_owner).toBe('su-closer-object');
    expect(row.terminal_completion_ref).toBe('ref-from-ledger');

    const repair = row.payload?._terminalAttributionRepair as Record<string, unknown> | undefined;
    expect(repair, 'the repair must be self-describing on the row').toBeTruthy();
    expect(repair?.migration).toBe('729');
    expect(repair?.restoredOwner).toBe('su-closer-object');
    expect(repair?.restoredFrom).toBe('harness_shared.tool_invocations');
  });

  it('finds a closer passed in the FLAT arg form, not just the completion object', async () => {
    // Path 5 of the five aliasing paths. An extraction that only reads
    // args.completion resolves nothing here and silently demotes the row to
    // "unrecoverable" — which looks exactly like a correct Part B outcome.
    const row = await read('wi-a-flat');
    expect(row.terminal_owner).toBe('su-closer-flat');
  });

  it('seats the first SUFFICIENT closer, not merely the earliest', async () => {
    const row = await read('wi-a-two-closers');
    expect(row.terminal_owner).toBe('su-closer-verified');
  });

  it('never replaces a terminal_completion_ref that survived the clobber', async () => {
    const row = await read('wi-a-keeps-ref');
    expect(row.terminal_owner).toBe('su-closer-ref');
    expect(row.terminal_completion_ref).toBe('ref-survived');
  });

  // -------------------------------------------------------------------------
  // 2. THE TRAP GUARD — the assertion this migration's header exists to defend.
  // -------------------------------------------------------------------------
  it('does NOT write authority, even with sufficient evidence sitting on the row', async () => {
    // Every Part A row above carries verifiedHow + testResult, i.e. it clears
    // 683's `committed` bar. Deriving authority from that is the plausible,
    // wrong repair: NULL authority is the normal resting state (71.3% of the
    // untouched control population), so writing it would fabricate a value that
    // makes repaired rows look better-evidenced than untouched ones.
    for (const id of ['wi-a-object', 'wi-a-flat', 'wi-a-two-closers', 'wi-a-keeps-ref']) {
      const row = await read(id);
      expect(row.authority, `${id} had authority fabricated`).toBeNull();
      expect(row.terminal_reason, `${id} had terminal_reason fabricated`).toBeNull();
    }
  });

  // -------------------------------------------------------------------------
  // 3. PART B — mark, do not guess.
  // -------------------------------------------------------------------------
  it('marks an unrecoverable row instead of inventing a closer for it', async () => {
    const row = await read('wi-b-unrecoverable');
    expect(row.terminal_owner, 'an unrecoverable closer must stay NULL').toBeNull();

    const loss = row.payload?._attributionLoss as Record<string, unknown> | undefined;
    expect(loss, 'the loss must be recorded on the row, not left silent').toBeTruthy();
    expect(loss?.migration).toBe('729');
    expect(loss?.recoverable).toBe(false);
    expect(loss?.lostColumns).toEqual(['terminal_owner']);
    // The point of the marker: an auditor must be able to tell "record destroyed"
    // from "closed by nobody".
    expect(String(loss?.cause)).toContain('WI-7057');
  });

  it('does not treat a non-terminal ledger entry as a close', async () => {
    const row = await read('wi-b-only-reopen');
    expect(row.terminal_owner).toBeNull();
    expect(row.payload?._attributionLoss).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // 4. THE COHORT CONTROLS — the populations that look damaged and are not.
  // -------------------------------------------------------------------------
  it('leaves the remote-origin cohort completely alone, ledger match or not', async () => {
    // 1,856 live rows are in this shape. A repair that filled every NULL
    // terminal_owner would invent attribution for all of them and pass every
    // other test in this file.
    const row = await read('wi-c-remote');
    expect(row.terminal_owner).toBeNull();
    expect(row.payload?._terminalAttributionRepair).toBeUndefined();
    expect(row.payload?._attributionLoss).toBeUndefined();
  });

  it('leaves a clean local+local row alone — no peer touched it, so nothing was lost', async () => {
    const row = await read('wi-c-local-local');
    expect(row.terminal_owner).toBeNull();
    expect(row.payload?._terminalAttributionRepair).toBeUndefined();
    expect(row.payload?._attributionLoss).toBeUndefined();
  });

  it('leaves rows with no surviving evidence, and non-terminal rows, alone', async () => {
    for (const id of ['wi-c-no-evidence', 'wi-c-open']) {
      const row = await read(id);
      expect(row.terminal_owner, `${id} was touched`).toBeNull();
      expect(row.payload?._terminalAttributionRepair, `${id} was repaired`).toBeUndefined();
      expect(row.payload?._attributionLoss, `${id} was marked`).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // 5. NON-DESTRUCTION.
  // -------------------------------------------------------------------------
  it('never changes lifecycle state and never overwrites the surviving evidence blob', async () => {
    for (const id of ['wi-a-object', 'wi-b-unrecoverable']) {
      const row = await read(id);
      expect(row.status, `${id} lifecycle state moved`).toBe('done');
      expect(row.payload?._completionEvidence, `${id} lost its evidence`).toEqual(EVIDENCE);
    }
  });

  // -------------------------------------------------------------------------
  // 6. IDEMPOTENCE.
  // -------------------------------------------------------------------------
  it('is a no-op on re-apply', async () => {
    const before = await Promise.all([read('wi-a-object'), read('wi-b-unrecoverable')]);
    await applyBackfill();
    const after = await Promise.all([read('wi-a-object'), read('wi-b-unrecoverable')]);

    // Compared by the marker's own timestamp rather than a row count: a second
    // pass that re-selected and re-wrote these rows would produce identical
    // counts and a moved `at`.
    expect(
      (after[0].payload?._terminalAttributionRepair as Record<string, unknown>)?.at,
      're-apply rewrote the Part A marker',
    ).toBe((before[0].payload?._terminalAttributionRepair as Record<string, unknown>)?.at);
    expect(
      (after[1].payload?._attributionLoss as Record<string, unknown>)?.at,
      're-apply rewrote the Part B marker',
    ).toBe((before[1].payload?._attributionLoss as Record<string, unknown>)?.at);
    expect(after[0].terminal_owner).toBe('su-closer-object');
    expect(after[1].terminal_owner).toBeNull();
  });
});
