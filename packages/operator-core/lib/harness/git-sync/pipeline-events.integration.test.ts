/**
 * pipeline-events.integration.test.ts — real-Postgres round-trip for the mig-177
 * pipeline history: append events, then summarize a window + read the recent
 * timeline back over actual rows (not a mocked `sql`).
 *
 * Uses the production-faithful testcontainer client from _pg-helpers (the same
 * `prepare:false` + BIGINT→number config as getOrgPg), and inlines the mig-177 +
 * mig-419 table/constraint DDL (RLS/grants omitted — the test client is the table
 * owner). The append fns take an injectable `sql` (the emitUsageEvent seam) so
 * they run against it.
 *
 * EI-2969 recurrence guard: mig-419 widened `pipeline_events_kind_check` after
 * the TS `PipelineEventKind` union grew ('content_fixer' / 'release_fixer')
 * without the DB constraint following — every content-fixer/release-fixer write
 * (including the release-fixer's GREEN verdict) was silently rejected at the DB
 * layer for ~74h, freezing deploys fleet-wide. The CHECK constraint is now
 * mirrored into this suite's DDL (not just the bare inline table from mig-177),
 * and 'every PipelineEventKind round-trips' asserts each kind in the TS union is
 * still accepted by the mirrored constraint — so a future kind added to the type
 * without a matching migration fails HERE instead of silently dropping rows in
 * production.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { readGateNonVerdictReasons } from '../../release/gate-fire-ledger';
import {
  appendPipelineEvent,
  summarizePipelineWindow,
  recentPipelineEvents,
  findGreenCheckpointVerdictForCandidate,
  readGatePipelineWindow,
  type PipelineEventKind,
} from './pipeline-events';

const SLUG = 'pipetest';
let db: FreshPgDb;

// Keep in sync with libs/papercusp/libs/db/sql/419-pipeline-events-kind-content-release-fixer.sql —
// this is the LIVE constraint's allowlist, mirrored here on purpose (see EI-2969 note above).
const ALL_KINDS: PipelineEventKind[] = [
  'git_sync',
  'merge_resolver',
  'content_fixer',
  'green_checkpoint',
  'deploy',
  'release_fixer',
];

describe('pipeline-events runtime — real Postgres', () => {
  beforeAll(async () => {
    db = await createFreshPgDb('pipeline');
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.pipeline_events (
        id bigserial PRIMARY KEY,
        workspace_id text NOT NULL,
        install_slug text NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        detail jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pipeline_events_kind_check CHECK (kind = ANY (ARRAY['git_sync'::text, 'merge_resolver'::text, 'content_fixer'::text, 'green_checkpoint'::text, 'green_checkpoint_fire'::text, 'deploy'::text, 'release_fixer'::text]))
      );
    `);
  });
  afterAll(async () => {
    await db?.cleanup();
  });
  beforeEach(async () => {
    await db.sql`TRUNCATE harness_shared.pipeline_events RESTART IDENTITY`;
  });

  it('counts non-verdict reasons over an exact complete day, deduplicating repeated fire outcomes', async () => {
    const now = Date.UTC(2026, 9, 13, 12);
    const insert = async (status: string, fire: string | null, at = now - 1000,
      workspace = 'ws', install = SLUG, kind: PipelineEventKind = 'green_checkpoint') => {
      await db.sql`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES (${workspace}, ${install}, ${kind}, ${status},
          ${JSON.stringify(fire === null ? {} : { gateFireId: fire })}::text::jsonb, ${new Date(at)})`;
    };
    for (let i = 0; i < 6; i++) {
      await insert('skipped-joined-attempt', `joined-${i}`);
      await insert('skipped-joined-attempt', `joined-${i}`);
    }
    await insert('skipped-memory-budget', null);
    await insert('skipped-memory-budget', null);
    await insert('skipped-joined-attempt', 'too-old', now - 86_400_001);
    await insert('skipped-joined-attempt', 'future', now + 1);
    await insert('skipped-joined-attempt', 'foreign-workspace', now, 'other');
    await insert('skipped-joined-attempt', 'foreign-install', now, 'ws', 'other');
    await insert('skipped-joined-attempt', 'anchor', now, 'ws', SLUG, 'green_checkpoint_fire');
    await insert('not-green', 'red');
    await insert('pure-proof-capture-pending', 'pending');
    const result = await readGateNonVerdictReasons(db.sql, { workspaceId: 'ws', installSlug: SLUG }, now);
    expect(result.reasons.map(({ reason, count }) => ({ reason, count }))).toEqual([
      { reason: 'skipped-joined-attempt', count: 6 }, { reason: 'skipped-memory-budget', count: 2 },
    ]);
    expect(result).toMatchObject({ windowHours: 24, measuredAtMs: now, sinceMs: now - 86_400_000 });
  });

  it('counts failed or unmeasured joins while preserving identified live joins only in history (P-033)', async () => {
    const now = Date.UTC(2026, 9, 13, 12);
    const insert = async (status: string, detail: Record<string, unknown>) => {
      await db.sql`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES ('ws', ${SLUG}, 'green_checkpoint', ${status},
          ${JSON.stringify(detail)}::text::jsonb, ${new Date(now - 1000)})`;
    };
    for (let i = 0; i < 10; i++) {
      await insert('skipped-joined-attempt', {
        gateFireId: `healthy-${i}`, attemptId: 'attempt-live', runnerId: 'runner-live', runnerLiveness: 'live',
      });
    }
    for (const [fire, detail] of [
      ['legacy', {}],
      ['unknown', { attemptId: 'attempt-live', runnerId: 'runner-live', runnerLiveness: 'unknown' }],
      ['dead', { attemptId: 'attempt-live', runnerId: 'runner-live', runnerLiveness: 'dead' }],
      ['missing-runner', { attemptId: 'attempt-live', runnerLiveness: 'live' }],
      ['missing-attempt', { runnerId: 'runner-live', runnerLiveness: 'live' }],
      ['blank-runner', { attemptId: 'attempt-live', runnerId: ' ', runnerLiveness: 'live' }],
    ] as const) {
      await insert('skipped-joined-attempt', { gateFireId: fire, ...detail });
      await insert('skipped-joined-attempt', { gateFireId: fire, ...detail });
    }
    await insert('error', { gateFireId: 'abort', runnerLiveness: 'live', runnerId: 'runner-live', attemptId: 'attempt-live' });
    await insert('skipped-runner-liveness-unknown', { gateFireId: 'unmeasured' });

    const result = await readGateNonVerdictReasons(db.sql, { workspaceId: 'ws', installSlug: SLUG }, now);
    expect(result.reasons.map(({ reason, count }) => ({ reason, count }))).toEqual([
      { reason: 'skipped-joined-attempt', count: 6 },
      { reason: 'error', count: 1 },
      { reason: 'skipped-runner-liveness-unknown', count: 1 },
    ]);
    const history = await db.sql`SELECT count(*)::int AS count FROM harness_shared.pipeline_events
      WHERE workspace_id = 'ws' AND install_slug = ${SLUG} AND detail->>'gateFireId' LIKE 'healthy-%'`;
    expect(history[0]?.count).toBe(10);
  });

  it('reads complete gate windows in one snapshot, scopes exactly and exposes spanning attempts', async () => {
    const start = Date.parse('2026-10-05T10:00:00Z');
    const end = Date.parse('2026-10-05T11:00:00Z');
    const insert = async (workspace: string, install: string, kind: PipelineEventKind,
      fire: string, at: number, status: string) => {
      await db.sql`INSERT INTO harness_shared.pipeline_events
        (workspace_id, install_slug, kind, status, detail, created_at)
        VALUES (${workspace}, ${install}, ${kind}, ${status}, ${JSON.stringify({ gateFireId: fire })}::text::jsonb, ${new Date(at)})`;
    };
    for (const [workspace, install] of [['ws', SLUG], ['foreign', SLUG], ['ws', 'foreign']]) {
      await insert(workspace!, install!, 'green_checkpoint_fire', 'complete', start + 10, 'fired');
      await insert(workspace!, install!, 'green_checkpoint', 'complete', start + 20, 'advanced');
    }
    await insert('ws', SLUG, 'git_sync', 'noise', start + 30, 'synced');
    await insert('ws', SLUG, 'green_checkpoint_fire', 'old-finished', start - 20, 'fired');
    await insert('ws', SLUG, 'green_checkpoint', 'old-finished', start - 10, 'advanced');
    const input = { windowStartMs: start, windowEndMs: end, nonTerminalStatuses: ['decision-pending'] };
    const types = await db.sql`SELECT DISTINCT jsonb_typeof(detail) AS type FROM harness_shared.pipeline_events`;
    expect(types.map((r) => r.type)).toEqual(['object']);
    const target = { workspaceId: 'ws', installSlug: SLUG };
    const complete = await readGatePipelineWindow(target, input, db.sql);
    expect(complete).toMatchObject({ status: 'complete', total: 2 });
    expect(complete.rows.map((r) => r.detail.gateFireId)).toEqual(['complete', 'complete']);
    expect(await readGatePipelineWindow(target, { ...input, maxRows: 1 }, db.sql))
      .toMatchObject({ status: 'capped', total: 2, rows: [expect.anything()] });
    // Both boundaries lie inside this attempt: a simple created_at window would miss it.
    await insert('ws', SLUG, 'green_checkpoint_fire', 'spanning', start - 50, 'fired');
    await insert('ws', SLUG, 'green_checkpoint', 'spanning', start - 40, 'decision-pending');
    await insert('ws', SLUG, 'green_checkpoint', 'spanning', end + 50, 'advanced');
    const spanning = await readGatePipelineWindow(target, input, db.sql);
    expect(spanning.total, JSON.stringify(spanning)).toBe(5);
    expect(spanning.status).toBe('complete');
    expect(spanning.rows.filter((r) => r.detail.gateFireId === 'spanning')).toHaveLength(3);
    // A vanished fire cannot silently disappear from the population either.
    await insert('ws', SLUG, 'green_checkpoint_fire', 'unfinished', start - 30, 'fired');
    expect((await readGatePipelineWindow(target, input, db.sql)).total).toBe(6);
  });

  it('distinguishes a double-encoded fixture from the production text-to-jsonb writer', async () => {
    const detail = JSON.stringify({ gateFireId: 'fixture-control' });
    const rows = await db.sql`SELECT jsonb_typeof(${detail}::jsonb) AS inferred,
      jsonb_typeof(${detail}::text::jsonb) AS production`;
    expect(rows[0]).toMatchObject({ inferred: 'string', production: 'object' });
  });

  it('appends events and summarizes the trailing window per kind/status', async () => {
    for (let i = 0; i < 5; i++) {
      await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);
    }
    await appendPipelineEvent(
      {
        workspaceId: 'ws',
        installSlug: SLUG,
        kind: 'git_sync',
        status: 'conflict',
        detail: { conflicts: [{ scope: 'libs/x' }] },
      },
      db.sql,
    );
    await appendPipelineEvent(
      { workspaceId: 'ws', installSlug: SLUG, kind: 'merge_resolver', status: 'ok', detail: { exitCode: 0 } },
      db.sql,
    );
    await appendPipelineEvent(
      { workspaceId: 'ws', installSlug: SLUG, kind: 'green_checkpoint', status: 'advanced', detail: { green: true } },
      db.sql,
    );
    await appendPipelineEvent(
      { workspaceId: 'ws', installSlug: SLUG, kind: 'green_checkpoint', status: 'not-green', detail: { green: false } },
      db.sql,
    );

    const w = await summarizePipelineWindow(SLUG, 24 * 60 * 60, db.sql);
    expect(w.gitSync).toMatchObject({ total: 6, synced: 5, conflict: 1 });
    expect(w.mergeResolver).toMatchObject({ total: 1, ok: 1 });
    expect(w.greenCheckpoint).toMatchObject({ total: 2, advanced: 1, notGreen: 1 });
  });

  it('excludes events older than the window', async () => {
    await db.sql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, created_at)
      VALUES ('ws', ${SLUG}, 'git_sync', 'synced', now() - interval '10 days')
    `;
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);

    const day = await summarizePipelineWindow(SLUG, 24 * 60 * 60, db.sql);
    const week = await summarizePipelineWindow(SLUG, 7 * 24 * 60 * 60, db.sql);
    expect(day.gitSync.total).toBe(1); // only the fresh one
    expect(week.gitSync.total).toBe(1); // 10d-old row excluded from the 7d window too
  });

  it('scopes counts to the harness slug', async () => {
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);
    await appendPipelineEvent(
      { workspaceId: 'ws', installSlug: 'other-harness', kind: 'git_sync', status: 'conflict' },
      db.sql,
    );
    const w = await summarizePipelineWindow(SLUG, 24 * 60 * 60, db.sql);
    expect(w.gitSync.total).toBe(1);
    expect(w.gitSync.conflict).toBe(0);
  });

  it('EI-2969 recurrence guard: every PipelineEventKind round-trips against the live kind_check constraint', async () => {
    for (const kind of ALL_KINDS) {
      // status 'ok' is a valid value for every kind in production usage (see
      // foldPipelineWindow's per-kind status handling) — the constraint under test
      // gates on `kind` only, so a single representative status is sufficient.
      await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind, status: 'ok' }, db.sql);
    }
    const recent = await recentPipelineEvents(SLUG, ALL_KINDS.length, db.sql);
    expect(recent.map((r) => r.kind).sort()).toEqual([...ALL_KINDS].sort());
  });

  it('reads the recent timeline newest-first with parsed detail', async () => {
    await appendPipelineEvent({ workspaceId: 'ws', installSlug: SLUG, kind: 'git_sync', status: 'synced' }, db.sql);
    await appendPipelineEvent(
      { workspaceId: 'ws', installSlug: SLUG, kind: 'merge_resolver', status: 'ok', detail: { scopes: ['libs/x'] } },
      db.sql,
    );

    const recent = await recentPipelineEvents(SLUG, 10, db.sql);
    expect(recent).toHaveLength(2);
    expect(recent[0].kind).toBe('merge_resolver'); // newest first
    expect(recent[0].status).toBe('ok');
    expect(recent[0].createdAtMs).toBeGreaterThan(0);
    // detail tolerates the client's jsonb representation (object or string).
    expect(recent[0].detail).toBeTypeOf('object');
  });

  it("P-009: every appended event is stamped with the emitting process's vintage (treeSha/bundleVersion)", async () => {
    await appendPipelineEvent(
      { workspaceId: 'ws', installSlug: SLUG, kind: 'green_checkpoint', status: 'not-green' },
      db.sql,
    );
    const [recent] = await recentPipelineEvents(SLUG, 1, db.sql);
    expect(recent.detail).toHaveProperty('vintage');
    const vintage = recent.detail.vintage as { treeSha: string | null; bundleVersion: string };
    // getBuildInfo() is best-effort (sha can be null in an unresolved test checkout) —
    // pin the SHAPE (both keys present, bundleVersion always a string), not a specific value.
    expect(vintage).toHaveProperty('treeSha');
    expect(typeof vintage.bundleVersion).toBe('string');
    // The existing host stamp (P-015) must still be present alongside it (additive, not replaced).
    expect(typeof recent.detail.host).toBe('string');
  });

  // EI-18676650746298156: checkpoint:await's candidateSha already-judged latch — real-Postgres
  // coverage for the exact-match probe against RECORDED green_checkpoint verdicts. Nested
  // INSIDE the outer describe so it shares the SAME beforeAll/beforeEach/afterAll lifecycle
  // (the module-level `db` connection + its per-test TRUNCATE) — a sibling top-level describe
  // here would run AFTER the outer describe's `afterAll` already closed `db.sql`, hitting
  // postgres.js's CONNECTION_ENDED on every query (caught + discarded here, the hard way).
  describe('findGreenCheckpointVerdictForCandidate — real Postgres', () => {
    const FULL_SHA = '94c1234567890abcdef1234567890abcdef12345';
    const OTHER_SHA = 'ffffffffff890abcdef1234567890abcdef12345';

    it('finds a GREEN verdict for the exact candidate (full sha matched against the truncated stored prefix)', async () => {
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: SLUG,
          kind: 'green_checkpoint',
          status: 'advanced',
          detail: { candidate: FULL_SHA.slice(0, 12), green: true },
        },
        db.sql,
      );
      const match = await findGreenCheckpointVerdictForCandidate(SLUG, FULL_SHA, { sql: db.sql });
      expect(match).not.toBeNull();
      expect(match?.status).toBe('advanced');
      expect(match?.detail.green).toBe(true);
    });

    it('finds a HELD/RED verdict for the exact candidate', async () => {
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: SLUG,
          kind: 'green_checkpoint',
          status: 'not-green',
          detail: { candidate: FULL_SHA.slice(0, 12), green: false },
        },
        db.sql,
      );
      const match = await findGreenCheckpointVerdictForCandidate(SLUG, FULL_SHA, { sql: db.sql });
      expect(match).not.toBeNull();
      expect(match?.status).toBe('not-green');
      expect(match?.detail.green).toBe(false);
    });

    it('returns null for a candidate that was never judged (the not-yet-judged sibling case)', async () => {
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: SLUG,
          kind: 'green_checkpoint',
          status: 'advanced',
          detail: { candidate: OTHER_SHA.slice(0, 12), green: true },
        },
        db.sql,
      );
      const match = await findGreenCheckpointVerdictForCandidate(SLUG, FULL_SHA, { sql: db.sql });
      expect(match).toBeNull();
    });

    it("WI-5685 shape: an 'advanced-prefix' row's detail.candidate is the RED tip — matching it must report green:false even though the pipeline overall advanced (to a DIFFERENT, earlier prefix)", async () => {
      const redTip = FULL_SHA;
      const advancedTo = OTHER_SHA;
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: SLUG,
          kind: 'green_checkpoint',
          status: 'advanced-prefix',
          // Mirrors buildCheckpointDetail exactly: candidate = the still-red tip, green:false,
          // advancedTo = the earlier prefix that actually shipped.
          detail: { candidate: redTip.slice(0, 12), green: false, advancedTo: advancedTo.slice(0, 12) },
        },
        db.sql,
      );
      // Querying the RED TIP itself must say "judged, and NOT green" — never inferred as green
      // just because the pipeline as a whole advanced.
      const tipMatch = await findGreenCheckpointVerdictForCandidate(SLUG, redTip, { sql: db.sql });
      expect(tipMatch).not.toBeNull();
      expect(tipMatch?.status).toBe('advanced-prefix');
      expect(tipMatch?.detail.green).toBe(false);
      // The prefix that actually advanced is a DIFFERENT candidate — querying for IT (a
      // candidateSha the caller never asked about here) must not spuriously match the red tip's row.
      const prefixMatch = await findGreenCheckpointVerdictForCandidate(SLUG, advancedTo, { sql: db.sql });
      expect(prefixMatch).toBeNull();
    });

    it('WI-4957: filters to the exact runId when two runs judged the same candidate', async () => {
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: SLUG,
          kind: 'green_checkpoint',
          status: 'not-green',
          detail: { candidate: FULL_SHA.slice(0, 12), green: false, runId: 'run-A' },
        },
        db.sql,
      );
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: SLUG,
          kind: 'green_checkpoint',
          status: 'advanced',
          detail: { candidate: FULL_SHA.slice(0, 12), green: true, runId: 'run-B' },
        },
        db.sql,
      );
      const matchB = await findGreenCheckpointVerdictForCandidate(SLUG, FULL_SHA, { sql: db.sql, runId: 'run-B' });
      expect(matchB?.status).toBe('advanced');
      const matchNone = await findGreenCheckpointVerdictForCandidate(SLUG, FULL_SHA, { sql: db.sql, runId: 'run-C' });
      expect(matchNone).toBeNull();
    });

    it('returns the NEWEST matching verdict when a candidate was judged more than once', async () => {
      await db.sql`
      INSERT INTO harness_shared.pipeline_events (workspace_id, install_slug, kind, status, detail, created_at)
      VALUES ('ws', ${SLUG}, 'green_checkpoint', 'not-green', ${JSON.stringify({ candidate: FULL_SHA.slice(0, 12), green: false })}::text::jsonb, now() - interval '1 hour')
    `;
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: SLUG,
          kind: 'green_checkpoint',
          status: 'advanced',
          detail: { candidate: FULL_SHA.slice(0, 12), green: true },
        },
        db.sql,
      );
      const match = await findGreenCheckpointVerdictForCandidate(SLUG, FULL_SHA, { sql: db.sql });
      expect(match?.status).toBe('advanced'); // the newer row, not the 1h-old one
    });

    it('scopes to the install_slug — a same-candidate verdict on a DIFFERENT pipeline does not match', async () => {
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: 'other-harness',
          kind: 'green_checkpoint',
          status: 'advanced',
          detail: { candidate: FULL_SHA.slice(0, 12), green: true },
        },
        db.sql,
      );
      const match = await findGreenCheckpointVerdictForCandidate(SLUG, FULL_SHA, { sql: db.sql });
      expect(match).toBeNull();
    });

    it('installSlug:null searches across ALL pipelines (the global:true case)', async () => {
      await appendPipelineEvent(
        {
          workspaceId: 'ws',
          installSlug: 'some-other-pipeline',
          kind: 'green_checkpoint',
          status: 'advanced',
          detail: { candidate: FULL_SHA.slice(0, 12), green: true },
        },
        db.sql,
      );
      const match = await findGreenCheckpointVerdictForCandidate(null, FULL_SHA, { sql: db.sql });
      expect(match).not.toBeNull();
      expect(match?.status).toBe('advanced');
    });
  });
});
