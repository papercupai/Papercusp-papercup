/**
 * R-3, live plane — grader recruitment is IDEMPOTENT, and a pickup verdict is
 * THREE-VALUED with `not-yet` and `unreadable` each leaving the grader in place.
 *
 * Real PG on purpose, for two different reasons.
 *
 * 1. The pickup verdict is computed from the grader's OWN activity timestamps
 *    read out of `harness_shared.coord_presence` (plus the ingested transcript
 *    leg). A unit test hands `classifyGraderPickup` a literal reading, so it
 *    proves the comparison and nothing about whether the production reader
 *    supplies the thing being compared. Here `observeGraderPickup` runs with its
 *    DEFAULT reader — `prodReadGraderActivity`, no injection — against rows this
 *    test really wrote.
 *
 * 2. ⚠ "Neither re-recruits nor re-wakes" is a NEGATIVE, and the agreed spec
 *    (WI-10002379) requires it OBSERVED rather than inferred from a call count
 *    on a mock. So the discovery and cascade legs are left REAL: if the dedup
 *    guard failed, `prodOpenGradingCascade` would write a `consult_state` row
 *    and a conversation. The assertion is therefore that those durable
 *    populations are UNCHANGED across a second resolve — a fact about the
 *    database, not about a spy.
 *
 * `not-yet` is the failure mode that regresses silently, because the "safe"
 * reflex on an inconclusive probe is to re-recruit — and D-009 independence
 * makes the eligible pool non-replenishable, so every redundant dispatch
 * permanently shrinks it. Hence one explicit negative PER VERDICT.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { observeGraderPickup } from './acceptance-grader-pickup';
import {
  advanceGradingCascadeOnCard,
  detectAcceptanceGraderTerminalFailure,
  isInFlightAcceptanceGradingRequest,
  reconcileOpenGradingCascades,
  resolveAcceptanceGrader,
} from './acceptance-grader';
import { GRADING_CASCADE_FLAVOR } from './consult/grading-cascade';
import { activeWorkspaceId } from './workspace-registry';

const { createOrgTestDb } = await import('../test/_org-test-db');
const { _resetHarnessAdminUrlCacheForTests } = await import('./embedded-pg-discovery');

const WORKSPACE = 'r3-grader-pickup-ws';
/**
 * ⚠ The grading-request row must live under the workspace `listWorkItems`
 * actually reads. That read is scoped by `activeWorkspaceId()` (an ambient
 * value), NOT by anything the caller passes — so seeding the row under this
 * file's own WORKSPACE constant makes the dedup guard find nothing and the
 * resolver falls through to a launch. That failure looks like "dedup is
 * broken" while really meaning "the fixture was invisible".
 */
const LIST_WORKSPACE = activeWorkspaceId();
const HARNESS = 'papercusp';
const PLAN_SLUG = 'r3-pickup-subject-plan';
const RUBRIC_ID = 'acceptance-r3-pickup-subject-plan';
const SAVED_ADMIN_URL = process.env.HARNESS_ADMIN_DATABASE_URL;

const WAKE_INSTANT_MS = Date.parse('2026-09-22T12:00:00.000Z');

/** Minimal LaunchCtx — resolve only reads identity/workspace off it. */
const ctx = {
  workspaceId: LIST_WORKSPACE,
  harnessSlug: HARNESS,
  ownerId: 'su-r3-shipper',
  emit: () => {},
} as unknown as Parameters<typeof resolveAcceptanceGrader>[1];

/** Counts of every durable trace a recruit-or-wake would leave. */
async function dispatchFootprint(db: OrgTestDb): Promise<{ consults: number; conversations: number; tasks: number }> {
  const [[consults], [conversations], [tasks]] = await Promise.all([
    db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.consult_state`,
    db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.coord_conversations`,
    db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.work_items
       WHERE workspace_id = ${LIST_WORKSPACE} AND item_kind = 'task'`,
  ]);
  return { consults: consults.n, conversations: conversations.n, tasks: tasks.n };
}

describe('R-3 grader recruitment idempotence + three-valued pickup (real PG)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    process.env.HARNESS_ADMIN_DATABASE_URL = db.adminDsn;
    _resetHarnessAdminUrlCacheForTests();

    // Clear the store-identity pin, and warm the org-admin pool, HERE — not
    // inside a test. The first `getOrgPg()` after the env re-route notices its
    // target moved and logs a one-time `[db] org-admin pool rebound` warning —
    // which `vitest-fail-on-console` turns into a test failure attributed to
    // whichever case happened to be first. Absorbing it in setup keeps that
    // rebind from masquerading as a verdict about the subject.
    //
    // The pin reset is the same one `plan-agent-brief-posture-live` takes, for
    // the same reason: `createOrgTestDb` provisions through the real cluster,
    // which pins store identity there, and the admin pool this test then opens
    // against its own throwaway database has a different `system_identifier` —
    // which the guard correctly reports as a WRONG STORE via `console.error`,
    // and `vitest-fail-on-console` turns into a failure attributed to whichever
    // case ran first. Resetting the pin at the same boundary as the URL cache
    // is the honest fix; suppressing the guard is not.
    //
    // ⚠ `_resetForTests` and not just `_resetStoreIdentityForTests`: db-org's
    // `adminUrl()` caches an env-sourced DSN for the life of the process
    // ("Env is stable for process lifetime → safe to cache", connection.ts:597).
    // That premise holds in production and is FALSE for the re-route above — if
    // anything resolved the admin URL before this `beforeAll`, the cache
    // short-circuits every later resolution, `endStalePool` compares the pool
    // against that same stale URL and never rebinds, and every read below runs
    // against whatever database the PARENT process was pointed at, where none of
    // the rows seeded here exist. `_resetForTests` is db-org's one test-reset
    // entrypoint and clears the URL caches, the store-identity pin and every
    // built pool together.
    //
    // That is what the three `unreadable` graders on 2026-09-22 were: this file
    // failed under `testing:run` (whose child inherits :3070's live
    // HARNESS_ADMIN_DATABASE_URL) and passed, unchanged, under a bare shell
    // (which starts with the var unset, so the first resolution lands as
    // `discovery` and is re-read every call). It read as a transient of the
    // shared box because nothing in the file changed between the two — the
    // RUNNER changed. The same one-variable A/B was measured on
    // `plan-agent-brief-posture-live`: unset ⇒ 5/5 pass, set ⇒ 5/5 fail.
    {
      const { getOrgPg, _resetForTests } = await import('@papercusp/db-org');
      await _resetForTests();
      await getOrgPg().sql`SELECT 1`;
    }

    // Three graders, differing ONLY in what their own activity record says.
    await db.adminSql`
      INSERT INTO harness_shared.coord_presence
        (owner_id, owner_label, workspace_id, source, intent, host, last_active_at, heartbeat_at)
      VALUES
        -- activity strictly AFTER the wake ⇒ confirmed
        ('su-grader-confirmed', 'confirmed', ${WORKSPACE}, 'omp-hook-session', 'grading',
         '', ${new Date(WAKE_INSTANT_MS + 60_000).toISOString()}, now()),
        -- activity strictly BEFORE the wake ⇒ not-yet (no turn since the wake)
        ('su-grader-not-yet', 'not yet', ${WORKSPACE}, 'omp-hook-session', 'grading',
         '', ${new Date(WAKE_INSTANT_MS - 60_000).toISOString()}, now()),
        -- present but with NO readable activity instant ⇒ unreadable
        ('su-grader-unreadable', 'unreadable', ${WORKSPACE}, 'omp-hook-session', 'grading',
         '', NULL, now())`;

    // A REAL in-flight acceptance-grading request: HELD (a held request is
    // in-flight on `assignee` alone, with no recency window to age out mid-run)
    // and titled so the identity predicate matches.
    //
    // ⚠ The column is `taken_by` — `work_items` has no `assignee` and no
    // `created_by`; `listWorkItems` projects those names. Leaving authorship
    // unset is correct here: `createdBy` is read ONLY to exclude the
    // acceptance-drain actor (WI-10002453), and this request is not one.
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, summary, status, taken_by, last_progress_at)
      VALUES (
        ${LIST_WORKSPACE}, ${HARNESS}, 'EI-R3-GRADING-REQUEST', 'task',
        ${`Acceptance grading for plan ${PLAN_SLUG}`},
        ${`A non-implementer grader must run scorecards:emit against ${PLAN_SLUG}.`},
        'wip', 'su-grader-confirmed', now())`;
  }, 180_000);

  afterAll(async () => {
    if (SAVED_ADMIN_URL === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
    else process.env.HARNESS_ADMIN_DATABASE_URL = SAVED_ADMIN_URL;
    _resetHarnessAdminUrlCacheForTests();
    // Leave no cached URL, pin or live pool on a database that is about to be
    // dropped — see the `beforeAll` note on db-org's process-lifetime env cache.
    {
      const { _resetForTests } = await import('@papercusp/db-org');
      await _resetForTests();
    }
    await db?.cleanup();
  });

  describe('the pickup verdict is three-valued, read from the grader\'s own record', () => {
    it('CONFIRMED — activity strictly after the wake, via the PRODUCTION reader', async () => {
      const obs = await observeGraderPickup({
        graderId: 'su-grader-confirmed',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(obs.verdict).toBe('confirmed');
      expect(obs.sinceWakeMs).toBeGreaterThan(0);
      // The reading came from a real row, not a literal handed to the classifier.
      expect(obs.source).not.toBeNull();
    });

    it('NOT-YET — activity predates the wake, and the grader is LEFT IN PLACE', async () => {
      const before = await dispatchFootprint(db);

      const obs = await observeGraderPickup({
        graderId: 'su-grader-not-yet',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(obs.verdict).toBe('not-yet');
      expect(obs.sinceWakeMs).toBeLessThan(0);
      // ⛔ The negative this case exists for: an inconclusive probe is NOT a
      // licence to re-recruit. Observed as durable state, not as a spy count.
      expect(await dispatchFootprint(db)).toEqual(before);
    });

    it('UNREADABLE — no readable activity instant, and the grader is LEFT IN PLACE', async () => {
      const before = await dispatchFootprint(db);

      const obs = await observeGraderPickup({
        graderId: 'su-grader-unreadable',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(obs.verdict).toBe('unreadable');
      // A failed measurement reports no instant at all — it must not be
      // downgraded into `not-yet`, which is a statement ABOUT the grader.
      expect(obs.graderLastActiveMs).toBeNull();
      expect(obs.sinceWakeMs).toBeNull();
      expect(await dispatchFootprint(db)).toEqual(before);
    });

    it('a grader with no record at all is unreadable, never absent-therefore-replaceable', async () => {
      const before = await dispatchFootprint(db);
      const obs = await observeGraderPickup({
        graderId: 'su-grader-never-existed',
        wakeInstantMs: WAKE_INSTANT_MS,
        nowMs: WAKE_INSTANT_MS + 120_000,
      });
      expect(obs.verdict).toBe('unreadable');
      expect(await dispatchFootprint(db)).toEqual(before);
    });
  });

  describe('recruitment is idempotent against an already-live grading', () => {
    it('the seeded request really is in-flight (instrument check)', async () => {
      const [row] = await db.adminSql<
        Array<{ title: string; summary: string; taken_by: string | null; created_ts: string; last_progress_at: string }>
      >`SELECT title, summary, taken_by, created_ts, last_progress_at
          FROM harness_shared.work_items WHERE feature_id = 'EI-R3-GRADING-REQUEST'`;
      expect(row).toBeTruthy();
      // If this predicate ever stops matching, every assertion below would pass
      // vacuously — the resolver would dedup on nothing and simply find no
      // eligible grader. Assert the premise rather than assume it.
      expect(
        isInFlightAcceptanceGradingRequest(
          {
            title: row.title,
            summary: row.summary,
            createdBy: null,
            assignee: row.taken_by,
            createdAt: new Date(row.created_ts).toISOString(),
            lastProgressAt: new Date(row.last_progress_at).toISOString(),
          } as Parameters<typeof isInFlightAcceptanceGradingRequest>[0],
          PLAN_SLUG,
          Date.now(),
        ),
      ).toBe(true);
    });

    it('a re-run neither re-recruits nor re-wakes — observed in durable state', async () => {
      // `readPlan` / `getRubric` are supplied so the resolver reaches its dedup
      // guard; everything the assertion depends on — the work-item listing that
      // finds the in-flight request, and the discovery + cascade legs that would
      // leave a trace if dedup failed — is left REAL.
      const deps = {
        readPlan: async () => ({
          row: { workspaceId: LIST_WORKSPACE, harnessSlug: HARNESS, planSlug: PLAN_SLUG, content: '' },
        }),
        getRubric: async () => ({ rubricId: RUBRIC_ID, revision: 4 }),
      } as unknown as Parameters<typeof resolveAcceptanceGrader>[2];

      const before = await dispatchFootprint(db);

      const first = await resolveAcceptanceGrader(PLAN_SLUG, ctx, deps);
      expect(first.state).toBe('deduped');
      expect((first as { existingWorkItemId?: string }).existingWorkItemId).toBe('EI-R3-GRADING-REQUEST');

      const second = await resolveAcceptanceGrader(PLAN_SLUG, ctx, deps);
      expect(second.state).toBe('deduped');
      // The SAME grading is pointed at — a second resolve did not open a rival.
      expect((second as { existingWorkItemId?: string }).existingWorkItemId).toBe(
        (first as { existingWorkItemId?: string }).existingWorkItemId,
      );

      // The load-bearing assertion: two resolves left the database exactly as
      // one found it. No new consult cascade (no re-recruit), no new
      // conversation (no re-wake), no second grading request.
      expect(await dispatchFootprint(db)).toEqual(before);
    });
  });

  /**
   * WI-10003451 — the open-cascade dedupe must not treat an ANSWERED grading cascade
   * as the live dispatch. Real PG because the defect lived in the SQL read (a
   * `LIMIT 1` over every open row) and the fix is a CAS-guarded close: both are facts
   * about rows, which a mocked sql cannot show.
   */
  describe('open-cascade reconcile closes answered cascades (WI-10003451)', () => {
    const RECONCILE_WS = 'wi-10003451-reconcile-ws';
    const RECONCILE_PLAN = 'wi-10003451-subject-plan';
    const RECONCILE_RUBRIC = 'acceptance-wi-10003451-subject-plan';
    const RESERVATION = { conditionKey: 'acceptance-review-target:wi-10003451', id: 'EI-WI10003451-RES' };

    async function seedCascade(opts: {
      conversationId: string;
      planSlug?: string;
      createdAgoMs: number;
      digest: Array<{ at: string; kind: string; ownerId: string; excerpt?: string }>;
      selection?: Record<string, unknown>;
      cascadeCursor?: number;
      state?: string;
    }): Promise<void> {
      const routing = {
        cascade: {
          flavor: GRADING_CASCADE_FLAVOR,
          planSlug: opts.planSlug ?? RECONCILE_PLAN,
          rubricId: RECONCILE_RUBRIC,
          harnessSlug: HARNESS,
          reservation: RESERVATION,
        },
        ...(opts.selection ? { selection: opts.selection } : {}),
      };
      // A selected slot names its routed source in responder_id; the answering
      // identity is separate. Keep the shared fixture consistent with that wire contract.
      const selected = opts.selection?.selected as Array<{ ownerId?: string }> | undefined;
      const responderId = selected?.[opts.cascadeCursor ?? 0]?.ownerId ?? 'su-head';
      const createdAt = new Date(Date.now() - opts.createdAgoMs).toISOString();
      await db.adminSql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, responder_id, state, question, latency_contract,
           routing, cascade_digest, cascade_cursor, created_at, updated_at, expires_at)
        VALUES
          (${RECONCILE_WS}, ${opts.conversationId}, ${'acceptance-grading-sweep'}, ${responderId},
           ${opts.state ?? 'active'},
           ${'grade it'}, ${'proceed'}, ${db.adminSql.json(routing as never)},
           ${db.adminSql.json(opts.digest as never)}, ${opts.cascadeCursor ?? 0},
           ${createdAt}::timestamptz, ${createdAt}::timestamptz,
           ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz)`;
    }

    async function stateOf(conversationId: string): Promise<{
      state: string;
      closed: boolean;
      outcome: Record<string, unknown> | null;
    }> {
      const [row] = await db.adminSql<{ state: string; closed: boolean; outcome: Record<string, unknown> | null }[]>`
        SELECT state, closed_at IS NOT NULL AS closed, outcome
          FROM harness_shared.consult_state
         WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`;
      return row!;
    }

    const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();
    const params = {
      workspaceId: RECONCILE_WS,
      planSlug: RECONCILE_PLAN,
      rubricId: RECONCILE_RUBRIC,
      reservation: RESERVATION,
    };

    it('closes an answered cascade whose answer is past grace and falls through to "open a fresh one"', async () => {
      await seedCascade({
        conversationId: 'conv-wi10003451-answered',
        createdAgoMs: 3 * 3_600_000,
        digest: [
          { at: agoIso(2.5 * 3_600_000), kind: 'decline', ownerId: 'su-decliner' },
          { at: agoIso(2 * 3_600_000), kind: 'answer', ownerId: 'su-stale-grader', excerpt: 'card went cohort-stale' },
        ],
      });
      // Same stale shape on ANOTHER plan: the reconcile is plan-scoped and must not touch it.
      await seedCascade({
        conversationId: 'conv-wi10003451-other-plan',
        planSlug: 'wi-10003451-other-plan',
        createdAgoMs: 3 * 3_600_000,
        digest: [{ at: agoIso(2 * 3_600_000), kind: 'answer', ownerId: 'su-elsewhere' }],
      });

      const first = await reconcileOpenGradingCascades(params);
      expect(first.liveConversationId).toBeNull();
      expect(first.closedSpent).toEqual([
        expect.objectContaining({ conversationId: 'conv-wi10003451-answered', answeredBy: 'su-stale-grader' }),
      ]);
      const closed = await stateOf('conv-wi10003451-answered');
      expect(closed).toMatchObject({ state: 'closed_answered', closed: true });
      expect(closed.outcome).toMatchObject({
        source: 'acceptance-recruiter',
        reason: 'answer_not_counted',
        answeredBy: 'su-stale-grader',
      });
      expect(await stateOf('conv-wi10003451-other-plan')).toMatchObject({ state: 'active', closed: false });

      // Idempotent: the closed row is no longer an open match, so a retry closes nothing more.
      const second = await reconcileOpenGradingCascades(params);
      expect(second).toEqual({ liveConversationId: null, closedSpent: [] });
    });

    it('keeps an unanswered cascade and a just-answered one LIVE, returning the newest as the dispatch', async () => {
      await seedCascade({
        conversationId: 'conv-wi10003451-declined-only',
        createdAgoMs: 2 * 3_600_000,
        digest: [{ at: agoIso(90 * 60_000), kind: 'decline', ownerId: 'su-decliner' }],
      });
      await seedCascade({
        conversationId: 'conv-wi10003451-just-answered',
        createdAgoMs: 30 * 60_000,
        digest: [{ at: agoIso(60_000), kind: 'answer', ownerId: 'su-filing-now' }],
      });

      const res = await reconcileOpenGradingCascades(params);
      expect(res.closedSpent).toEqual([]);
      expect(res.liveConversationId).toBe('conv-wi10003451-just-answered');
      expect(await stateOf('conv-wi10003451-declined-only')).toMatchObject({ state: 'active', closed: false });
      expect(await stateOf('conv-wi10003451-just-answered')).toMatchObject({ state: 'active', closed: false });
    });

    describe('EI-25855370514874242: completed failed answering missions', () => {
      const sessionId = 'failed-answerer-native';
      const ownerId = 'su-failed-answerer';
      const providerError = 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s';
      const errorTurn = JSON.stringify({
        type: 'assistant', sessionId, isApiErrorMessage: true, apiErrorStatus: 429,
        message: { role: 'assistant', stop_reason: 'end_turn' },
      });
      const selection = {
        min: 1,
        selected: [{ ownerId: 'su-failed-source', answeringOwnerId: ownerId,
          via: 'floor', score: 0.9, relevance: 0.9, similarity: 0.9, liveness: 'live' }],
      };
      const inspect = (native: string) => detectAcceptanceGraderTerminalFailure('answerer.log', {
        readLogTail: (path) => path === 'answerer.jsonl' ? native : `●${providerError}\n❯`,
        nativeTranscriptPath: 'answerer.jsonl', nativeSessionId: sessionId,
        maxRechecks: 0, detectStartupStall: false,
      });

      it('retires the exact failed slot instead of returning an open provider-error-only mission forever', async () => {
        const planSlug = 'failed-answerer-provider-429';
        const conversationId = 'conv-failed-answerer-provider-429';
        await seedCascade({ conversationId, planSlug, createdAgoMs: 60_000, digest: [], selection });
        const dependencies = { nowMs: Date.now(), readTerminalFailure: async () => inspect(errorTurn) };
        expect(await inspect(errorTurn)).toMatchObject({ code: 'inference_gateway_error' });
        const result = await reconcileOpenGradingCascades({ ...params, planSlug }, dependencies);
        expect(result.liveConversationId).toBeNull();
        expect(await stateOf(conversationId)).toMatchObject({ state: 'no_qualified_responder' });
        const [row] = await db.adminSql<{ cascade_digest: Array<{ kind: string; ownerId: string }> }[]>`
          SELECT cascade_digest FROM harness_shared.consult_state
           WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`;
        expect(row.cascade_digest).toContainEqual(expect.objectContaining({
          kind: 'dispatch_failed', ownerId: 'su-failed-source',
        }));
        expect((await reconcileOpenGradingCascades({ ...params, planSlug }, dependencies)).liveConversationId).toBeNull();
      });

      it.each([
        ['quoted', JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: providerError } })],
        ['newer-turn', errorTurn + '\n' + JSON.stringify({ type: 'user', sessionId })],
        ['incomplete', errorTurn + '\n{"type":"user"'],
        ['foreign', errorTurn.replace(sessionId, 'other-native')],
      ])('keeps a %s failure reading live', async (name, native) => {
        const planSlug = `failed-answerer-control-${name}`;
        const conversationId = `conv-${planSlug}`;
        await seedCascade({ conversationId, planSlug, createdAgoMs: 60_000, digest: [], selection });
        const dependencies = { nowMs: Date.now(), readTerminalFailure: async () => inspect(native) };
        expect(await inspect(native)).toBeNull();
        expect((await reconcileOpenGradingCascades({ ...params, planSlug }, dependencies)).liveConversationId)
          .toBe(conversationId);
        expect(await stateOf(conversationId)).toMatchObject({ state: 'active', closed: false });
      });

      it('queues the next selected slot once and preserves its durable dispatch across retries', async () => {
        const planSlug = 'failed-answerer-next-slot';
        const conversationId = `conv-${planSlug}`;
        const nextOwner = 'su-next-source';
        await seedCascade({ conversationId, planSlug, createdAgoMs: 60_000, digest: [],
          selection: { ...selection, selected: [...selection.selected,
            { ownerId: nextOwner, via: 'floor', score: 0.9, relevance: 0.9, similarity: 0.9, liveness: 'live' }] } });
        const continueDispatch = vi.fn(async () => false);
        const readTerminalFailure = vi.fn(async () => inspect(errorTurn));
        const dependencies = { nowMs: Date.now(), readTerminalFailure, continueDispatch };
        const result = await reconcileOpenGradingCascades({ ...params, planSlug }, dependencies);
        expect(result.liveConversationId).toBe(conversationId);
        const readDispatch = async () => (await db.adminSql<Array<{
          cascade_cursor: number; responder_id: string; cascade_digest: unknown; routing: Record<string, unknown>;
        }>>`SELECT cascade_cursor, responder_id, cascade_digest, routing FROM harness_shared.consult_state
          WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`)[0]!;
        const queued = await readDispatch();
        expect(queued).toMatchObject({ cascade_cursor: 1, responder_id: nextOwner,
          cascade_digest: [expect.objectContaining({ kind: 'dispatch_failed', ownerId: 'su-failed-source' })],
          routing: { cascadeDispatch: { responder: nextOwner, cursor: 1, leaseToken: null } } });
        expect(continueDispatch).toHaveBeenCalledTimes(1);
        await reconcileOpenGradingCascades({ ...params, planSlug }, dependencies);
        expect(await readDispatch()).toEqual(queued);
        expect(readTerminalFailure).toHaveBeenCalledTimes(1);
        expect(continueDispatch).toHaveBeenCalledTimes(1);
        const { continueCascadeDispatchCore } = await import('./consult/cascade-core');
        expect(await continueCascadeDispatchCore(RECONCILE_WS, conversationId, {
          getSql: () => db.adminSql,
          dispatch: (isCurrent) => async (opts) => {
            expect(await isCurrent()).toBe(true);
            expect(opts.responder).toBe(nextOwner);
            await opts.onAnsweringOwner?.('su-next-answerer');
            return { woke: 1, answeringOwnerId: 'su-next-answerer' };
          },
        })).toBe(true);
        const dispatched = await readDispatch();
        expect(dispatched.routing).not.toHaveProperty('cascadeDispatch');
        expect(dispatched.routing).toMatchObject({ selection: { selected: [
          expect.anything(), expect.objectContaining({ ownerId: nextOwner, answeringOwnerId: 'su-next-answerer' }),
        ] } });
      });

      it.each(['answer', 'cursor', 'answering-owner', 'digest'])('preserves a concurrent %s change while inspecting failure', async (change) => {
        const planSlug = `failed-answerer-race-${change}`;
        const conversationId = `conv-${planSlug}`;
        await seedCascade({ conversationId, planSlug, createdAgoMs: 60_000, digest: [], selection });
        const dependencies = {
          nowMs: Date.now(),
          readTerminalFailure: async () => {
            const failure = await inspect(errorTurn);
            if (change === 'answer') {
              await db.adminSql`UPDATE harness_shared.consult_state SET state = 'closed_answered', closed_at = now()
                WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`;
            } else if (change === 'cursor') {
              await db.adminSql`UPDATE harness_shared.consult_state SET cascade_cursor = 1
                WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`;
            } else if (change === 'answering-owner') {
              await db.adminSql`UPDATE harness_shared.consult_state SET routing = jsonb_set(routing,
                '{selection,selected,0,answeringOwnerId}', '"su-current-answerer"'::jsonb)
                WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`;
            } else {
              await db.adminSql`UPDATE harness_shared.consult_state SET cascade_digest = ${db.adminSql.json([
                { kind: 'answer', ownerId, at: agoIso(0), excerpt: 'valid concurrent answer' },
              ] as never)}
                WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`;
            }
            return failure;
          },
        };
        const result = await reconcileOpenGradingCascades({ ...params, planSlug }, dependencies);
        // A raced receipt is conservatively existing; this retry must launch nobody.
        expect(result.liveConversationId).toBe(conversationId);
        const [row] = await db.adminSql<{
          state: string; cascade_cursor: number; cascade_digest: unknown;
          answering_owner: string;
        }[]>`SELECT state, cascade_cursor, cascade_digest,
            routing #>> '{selection,selected,0,answeringOwnerId}' AS answering_owner
          FROM harness_shared.consult_state WHERE workspace_id = ${RECONCILE_WS} AND conversation_id = ${conversationId}`;
        expect(row.state).toBe(change === 'answer' ? 'closed_answered' : 'active');
        expect(row.cascade_cursor).toBe(change === 'cursor' ? 1 : 0);
        expect(row.answering_owner).toBe(change === 'answering-owner' ? 'su-current-answerer' : ownerId);
        expect(row.cascade_digest).toEqual(change === 'digest'
          ? [expect.objectContaining({ kind: 'answer', ownerId })] : []);
      });
    });

    // WI-10006700 — the shape MEASURED on conv-muwrapka (2026-10-06): every slot,
    // incl. the min-answers refill pick, failed to dispatch; cascade-core wrote
    // `underFilled: refill-spent` at cursor 2 and handed the terminal state to a
    // trigger that dropped it. Counted live, the row returned dispatch:'existing'
    // on every ship retry for the full 4h TTL.
    it('WI-10006700: finishes a cascade cascade-core already walked to exhaustion instead of reusing it', async () => {
      const plan = 'wi-10006700-subject-plan';
      const failed = (ownerId: string) => ({ at: agoIso(10 * 60_000), kind: 'dispatch_failed', ownerId });
      await seedCascade({
        conversationId: 'conv-wi10006700-walked',
        planSlug: plan,
        createdAgoMs: 15 * 60_000,
        state: 'awaiting_responder',
        cascadeCursor: 2,
        selection: {
          min: 1,
          underFilled: { at: agoIso(10 * 60_000), min: 1, answers: 0, reason: 'refill-spent' },
        },
        digest: [failed('su-g1'), failed('su-g2'), failed('su-refill')],
      });
      // CONTROL: the same failed digest WITHOUT underFilled is a cascade still
      // mid-walk (cascade-core has not finished the menu) — it must stay live.
      await seedCascade({
        conversationId: 'conv-wi10006700-mid-walk',
        planSlug: 'wi-10006700-control-plan',
        createdAgoMs: 15 * 60_000,
        state: 'awaiting_responder',
        cascadeCursor: 1,
        selection: { min: 1 },
        digest: [failed('su-g1')],
      });

      const res = await reconcileOpenGradingCascades({ ...params, planSlug: plan });
      expect(res).toEqual({ liveConversationId: null, closedSpent: [] });
      expect(await stateOf('conv-wi10006700-walked')).toMatchObject({
        state: 'no_qualified_responder',
        closed: false,
      });

      const control = await reconcileOpenGradingCascades({ ...params, planSlug: 'wi-10006700-control-plan' });
      expect(control.liveConversationId).toBe('conv-wi10006700-mid-walk');
      expect(await stateOf('conv-wi10006700-mid-walk')).toMatchObject({ state: 'awaiting_responder', closed: false });
    });
  });

  describe('a final acceptance card closes its grading cascade', () => {
    it('persists the card answer and closes the consult without requiring a reply', async () => {
      const conversationId = 'conv-r3-card-final-answer';
      const nowIso = new Date().toISOString();
      const routing = {
        selection: {
          min: 1,
          max: 2,
          selected: [{
            ownerId: 'su-r3-final-grader',
            via: 'floor',
            score: 0.9,
            relevance: 0.9,
            similarity: 0.9,
            liveness: 'live',
          }],
          candidates: [],
        },
        cascade: {
          flavor: GRADING_CASCADE_FLAVOR,
          planSlug: 'r3-card-final-plan',
          rubricId: 'acceptance-r3-card-final-plan',
          harnessSlug: HARNESS,
        },
      };
      await db.adminSql`
        INSERT INTO harness_shared.consult_state
          (workspace_id, conversation_id, requester_id, responder_id, state, question,
           latency_contract, routing, cascade_digest, cascade_cursor, wakes_used,
           created_at, updated_at, expires_at)
        VALUES
          (${LIST_WORKSPACE}, ${conversationId}, ${'su-r3-requester'}, ${'su-r3-final-grader'},
           ${'active'}, ${'grade it'}, ${'proceed'}, ${db.adminSql.json(routing as never)},
           ${db.adminSql.json([] as never)}, ${0}, ${1}, ${nowIso}::timestamptz,
           ${nowIso}::timestamptz, ${new Date(Date.now() + 3_600_000).toISOString()}::timestamptz)`;

      const result = await advanceGradingCascadeOnCard({
        workspaceId: LIST_WORKSPACE,
        rubricRef: 'acceptance-r3-card-final-plan',
        graderOwnerId: 'su-r3-final-grader',
        cardSummary: 'complete independent grade',
      });

      expect(result).toEqual({ advanced: false, reason: 'menu_exhausted' });
      const [row] = await db.adminSql<
        Array<{ state: string; closed: boolean; expires_at: string | null; outcome: Record<string, unknown> | null }>
      >`SELECT state, closed_at IS NOT NULL AS closed, expires_at, outcome
          FROM harness_shared.consult_state
         WHERE workspace_id = ${LIST_WORKSPACE} AND conversation_id = ${conversationId}`;
      expect(row).toMatchObject({ state: 'closed_answered', closed: true, expires_at: null });
      expect(row?.outcome).toMatchObject({
        source: 'acceptance-grader-card',
        reason: 'cascade_complete',
        answeredBy: 'su-r3-final-grader',
      });
    });
  });
});
