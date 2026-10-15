/**
 * EI-21867819718600027 — a promoted tool-failure probation row must leave the
 * observation lane completely, not store `lane: null`.
 *
 * The scheduler excludes only payload.lane='observation', but keeping a JSON
 * null key is still the wrong admission identity and defeats key-existence
 * readers. This drives the real capture promotion, mergeIssuePayload unset, and
 * issue-family claimability read against a fully migrated Postgres database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { FilterNode } from '../../scheduler/claim-spec';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('./capture-core');
const { createIssue } = await import('../../issues-engineer');
const { createImplementationReadiness } = await import('./agent-review-policy');
const { readIssueClaimability } = await import('../../scheduler/get-next');
const { stampFiledBugReproduction } = await import('../../attention/bug-reproduction');
const { defaultReproductionLedgerDeps } = await import('../../attention/intake-promotion');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('tool-failure probation promotion → scheduler admission', () => {
  it('stores file-time duplicate evidence while keeping the new bug behind admission', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    // This row only seeds the real database write. The lexical query is not part
    // of this test's claimability contract; a slow query can legitimately hit
    // captureImprovement's bounded fallback and its warning, which Vitest treats
    // as a failure. The second capture below supplies its duplicate candidate.
    const first = await captureImprovement(
      {
        title: `duplicate handshake admission failure ${suffix}`,
        kind: 'bug',
        scope: 'harness:papercusp',
        createdBy: 'su-test',
      },
      { searchIssues: async () => [], createIssue },
    );
    const second = await captureImprovement(
      {
        title: `duplicate handshake admission failures ${suffix}`,
        kind: 'bug',
        scope: 'harness:papercusp',
        createdBy: 'su-peer',
      },
      { searchIssues: async () => [first.issue!], createIssue },
    );
    expect(second.created).toBe(true);
    const [stored] = await db.adminSql<{
      workspace_id: string;
      admission: string | null;
      payload: Record<string, unknown>;
    }[]>`
      SELECT workspace_id, admission, payload
        FROM harness_shared.work_items
       WHERE feature_id = ${second.issue!.id}`;
    expect(stored.admission).toBe('pending');
    expect(stored.payload).toMatchObject({
      dedupVerdict: 'likely-duplicate',
      dedupCandidates: [expect.objectContaining({ id: first.issue!.id })],
    });
    const claimability = await readIssueClaimability(
      { field: 'id', op: 'in', value: [second.issue!.id] },
      {
        harness: 'papercusp',
        workspaceId: stored.workspace_id,
        states: ['open'],
        assignee: 'su-peer',
        client: db.adminSql,
      },
      { limit: 10 },
    );
    expect(claimability.rows).toEqual([]);
  });

  it('keeps an ordinary captured bug out of self-pull until admission and records a critical bypass', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const ordinary = await captureImprovement({
      title: `ordinary admission capture ${suffix}`,
      kind: 'bug',
      scope: 'harness:papercusp',
      createdBy: 'su-test',
    });
    const critical = await captureImprovement({
      title: `critical admission capture ${suffix}`,
      kind: 'bug',
      severity: 'critical',
      scope: 'harness:papercusp',
      createdBy: 'su-test',
    });
    const ids = [ordinary.issue!.id, critical.issue!.id];
    const rows = await db.adminSql<{
      feature_id: string;
      workspace_id: string;
      admission: string | null;
      admitted_by: string | null;
    }[]>`
      SELECT feature_id, workspace_id, admission, admitted_by
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${ids}::text[])`;
    const byId = new Map(rows.map((row) => [row.feature_id, row]));
    expect(byId.get(ordinary.issue!.id)).toMatchObject({ admission: 'pending', admitted_by: null });
    expect(byId.get(critical.issue!.id)).toMatchObject({ admission: 'auto', admitted_by: 'bypass:severity-critical' });

    const claimability = await readIssueClaimability(
      { field: 'id', op: 'in', value: ids },
      {
        harness: 'papercusp',
        workspaceId: byId.get(ordinary.issue!.id)!.workspace_id,
        states: ['open'],
        assignee: 'su-test',
        client: db.adminSql,
      },
      { limit: 10 },
    );
    expect(claimability.rows.map((row) => row.id)).toEqual([critical.issue!.id]);
  });

  it('removes payload.lane but keeps peer-corroboration out of normal pickup until approval', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const title = `tool-failure probation claimability ${suffix}`;
    const watchdogKey = `repeated-tool-error:work_items:get:structural:${suffix}`;
    const probation = (reporter: string) => ({
      state: 'probation' as const,
      class: 'structural',
      watchdogKey,
      correlationFingerprint: `work_items:get|handler_error|500|payload|test|${suffix}`,
      intendedKind: 'change' as const,
      reporters: [reporter],
    });

    const first = await captureImprovement({
      title,
      kind: 'change',
      lane: 'observation',
      scope: 'harness:papercusp',
      watchdogKey,
      createdBy: 'su-test',
      payloadExtra: { toolFailureProbation: probation('su-test') },
    });
    expect(first).toMatchObject({
      ok: true,
      created: true,
      issue: { payload: { lane: 'observation' } },
    });

    const promoted = await captureImprovement({
      title,
      kind: 'change',
      lane: 'observation',
      scope: 'harness:papercusp',
      watchdogKey,
      createdBy: 'su-peer',
      payloadExtra: { toolFailureProbation: probation('su-peer') },
    });
    expect(promoted).toMatchObject({
      ok: true,
      created: false,
      reason: 'promoted',
      issue: { id: first.issue?.id, payload: { toolFailureProbation: { state: 'promoted' } } },
    });

    const id = first.issue!.id;
    const storedRows = await db.adminSql<
      {
        workspace_id: string;
        payload: Record<string, unknown>;
      }[]
    >`
      SELECT workspace_id, payload
        FROM harness_shared.work_items
       WHERE feature_id = ${id}`;
    expect(storedRows).toHaveLength(1);
    const stored = storedRows[0];
    if (!stored) throw new Error(`promoted row ${id} was not persisted`);
    expect(stored.workspace_id).not.toBe('');
    expect(Object.keys(stored.payload)).not.toContain('lane');
    // P-008 / D-038: promotion stamps the one stage reason, awaiting-agent-review, and
    // enrolment (EI-25176539351759672) re-stamps it with the review lifecycle's own record.
    expect(stored.payload).toMatchObject({
      implementationReadiness: {
        schemaVersion: 'implementation-readiness-v1',
        status: 'unknown',
        reason: 'awaiting-agent-review',
      },
    });

    const filter: FilterNode = { field: 'id', op: 'in', value: [id] };
    const claimability = await readIssueClaimability(
      filter,
      {
        harness: 'papercusp',
        workspaceId: stored.workspace_id,
        states: ['open'],
        assignee: 'su-test',
        client: db.adminSql,
      },
      { limit: 10 },
    );

    expect(claimability.breakdown.matchedByFilter).toBe(1);
    expect(claimability.breakdown.claimable).toBe(0);
    expect(claimability.breakdown.excluded.observationLane).toBe(0);
    expect(claimability.breakdown.excluded.agentReview).toBe(1);
    expect(claimability.rows).toEqual([]);

    // EI-25176539351759672: the awaiting-review stamp is backed by a real pending
    // review, so approval has to clear that review too, not just the readiness key.
    expect(stored.payload).toMatchObject({ agentReview: { status: 'pending', submittedBy: 'su-peer' } });
    const approved = createImplementationReadiness({
      status: 'ready',
      source: 'agent-review',
      reason: 'agent-review-approved',
      evidence: { review: { submittedBy: 'su-peer', reviewer: 'su-reviewer', round: 1, grade: 4 } },
    });
    await db.adminSql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(
               jsonb_set(payload, '{implementationReadiness}', ${JSON.stringify(approved)}::jsonb, true),
               '{agentReview,status}', '"approved"'::jsonb, false)
       WHERE feature_id = ${id}`;
    const afterApproval = await readIssueClaimability(
      filter,
      {
        harness: 'papercusp',
        workspaceId: stored.workspace_id,
        states: ['open'],
        assignee: 'su-test',
        client: db.adminSql,
      },
      { limit: 10 },
    );
    expect(afterApproval.rows.map((row) => row.id)).toEqual([id]);
  });

  // EI-25176539351759672 (plan unified-bug-pipeline-and-honest-queue-2026-10-05 P-002):
  // ~450 promoted bugs carried readiness 'unknown/corroborated-tool-failure-awaiting-review'
  // with NO agentReview record. The claim floor held them as in-review, and the reviewer
  // lane selects only agentReview.status pending, so nobody could ever clear them.
  const promoteBug = async (suffix: string, extra: Record<string, unknown> = {}) => {
    const title = `promoted bug review enrolment ${suffix}`;
    const watchdogKey = `repeated-tool-error:work_items:get:structural:${suffix}`;
    const probation = (reporter: string) => ({
      state: 'probation' as const,
      class: 'structural',
      watchdogKey,
      correlationFingerprint: `work_items:get|handler_error|500|payload|bug|${suffix}`,
      intendedKind: 'bug' as const,
      reporters: [reporter],
    });
    const first = await captureImprovement({
      title,
      kind: 'bug',
      lane: 'observation',
      scope: 'harness:papercusp',
      watchdogKey,
      createdBy: 'su-test',
      payloadExtra: { toolFailureProbation: probation('su-test') },
    });
    const promoted = await captureImprovement({
      title,
      kind: 'bug',
      lane: 'observation',
      scope: 'harness:papercusp',
      watchdogKey,
      createdBy: 'su-peer',
      payloadExtra: { toolFailureProbation: probation('su-peer'), ...extra },
    });
    expect(promoted).toMatchObject({ ok: true, created: false, reason: 'promoted' });
    const [stored] = await db.adminSql<{ workspace_id: string; payload: Record<string, unknown> }[]>`
      SELECT workspace_id, payload FROM harness_shared.work_items WHERE feature_id = ${first.issue!.id}`;
    return { id: first.issue!.id, stored: stored! };
  };

  it('enrols a peer-corroborated tool-failure promotion so the reviewer lane can claim it', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const { id, stored } = await promoteBug(suffix);
    expect(stored.payload).toMatchObject({
      agentReview: { status: 'pending', submittedBy: 'su-peer', round: 1 },
      implementationReadiness: { status: 'unknown' },
    });
    const { claimAgentReview } = await import('./agent-review');
    const review = await claimAgentReview({ id, reviewer: 'su-reviewer', harnessSlug: 'papercusp' });
    expect(review).toMatchObject({ claimed: true, workItem: { id } });
  });

  // P-029: resolve the actual ledger before driving persisted promotion and
  // scheduler admission. A caller-authored "verified" fixture misses this seam.
  it.each([
    { name: 'failed invocation', table: 'tool_invocations', status: 'error', build: 'abcdef1234567', dirty: false, ineligible: null, expected: 'verified' },
    { name: 'wrong-build invocation', table: 'tool_invocations', status: 'error', build: '7654321fedcba', dirty: false, ineligible: null, expected: 'refuted' },
    { name: 'successful invocation', table: 'tool_invocations', status: 'ok', build: 'abcdef1234567', dirty: false, ineligible: null, expected: 'refuted' },
    { name: 'clean failed test', table: 'test_runs', status: 'fail', build: 'abcdef1234567', dirty: false, ineligible: null, expected: 'verified' },
    { name: 'passing test', table: 'test_runs', status: 'pass', build: 'abcdef1234567', dirty: false, ineligible: null, expected: 'refuted' },
    { name: 'dirty failed test', table: 'test_runs', status: 'fail', build: 'abcdef1234567', dirty: true, ineligible: null, expected: 'refuted' },
    { name: 'caller-ineligible receipt', table: 'tool_invocations', status: 'error', build: 'abcdef1234567', dirty: false, ineligible: 'caller-classified tool failure', expected: 'not-eligible' },
    { name: 'human-ineligible receipt', table: 'tool_invocations', status: 'error', build: 'abcdef1234567', dirty: false, ineligible: 'human-filed report', expected: 'not-eligible' },
  ])('admits only an eligible ledger-backed encounter: $name', async (scenario) => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const [ledger] = scenario.table === 'test_runs'
      ? await db.adminSql<{ id: string }[]>`
          INSERT INTO harness_shared.test_runs (file_path, framework, status, commit_sha, worktree_dirty)
          VALUES (${`p029/${suffix}.test.ts`}, 'vitest', ${scenario.status}, ${scenario.build}, ${scenario.dirty})
          RETURNING id`
      : await db.adminSql<{ id: string }[]>`
          INSERT INTO harness_shared.tool_invocations
            (workspace_id, harness_slug, plugin_name, role, spawn_id, window_key, tool_name, status, serving_build_sha)
          VALUES ('default', 'papercusp', 'papercusp', 'su', 'p029-test', 'p029-test',
                  'work_items:get', ${scenario.status}, ${scenario.build})
          RETURNING id`;
    const ref = `${scenario.table}:${ledger!.id}`;
    const stamp = await stampFiledBugReproduction(
      { kind: 'encounter', ref, buildSha: 'abcdef1234567', verification: { status: 'verified' } },
      { filedBy: 'su-peer', ineligibleReason: scenario.ineligible },
      defaultReproductionLedgerDeps(),
    );
    expect(stamp.ok).toBe(true);
    if (!stamp.ok) throw new Error(stamp.error);
    expect(stamp.stored.verification.status).toBe(scenario.expected);
    const { id, stored } = await promoteBug(suffix, { reproduction: stamp.stored });
    expect(stored.payload).toMatchObject({ reproduction: { receipt: { ref }, verification: { status: scenario.expected } } });
    if (scenario.expected === 'verified') {
      expect(stored.payload).toMatchObject({ implementationReadiness: { status: 'ready', reason: 'born-verified-tool-failure-promotion' } });
      expect(stored.payload).not.toHaveProperty('agentReview');
    } else {
      expect(stored.payload).toMatchObject({
        implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' },
        agentReview: { status: 'pending', submittedBy: 'su-peer' },
      });
    }
    const claimability = await readIssueClaimability(
      { field: 'id', op: 'in', value: [id] },
      { harness: 'papercusp', workspaceId: stored.workspace_id, states: ['open'], assignee: 'su-test', client: db.adminSql },
      { limit: 10 },
    );
    expect(claimability.rows.map((row) => row.id)).toEqual(scenario.expected === 'verified' ? [id] : []);
  });

  it('keeps a row with no readiness key on the explicit legacy path', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const captured = await captureImprovement({
      title: `legacy readiness compatibility ${suffix}`,
      kind: 'bug',
      scope: 'harness:papercusp',
      createdBy: 'su-test',
    });
    const id = captured.issue!.id;
    const [row] = await db.adminSql<{ workspace_id: string }[]>`
      UPDATE harness_shared.work_items
         SET payload = COALESCE(payload, '{}'::jsonb) - 'implementationReadiness',
             admission = NULL
       WHERE feature_id = ${id}
      RETURNING workspace_id`;
    const filter: FilterNode = { field: 'id', op: 'in', value: [id] };
    const claimability = await readIssueClaimability(
      filter,
      {
        harness: 'papercusp',
        workspaceId: row!.workspace_id,
        states: ['open'],
        assignee: 'su-test',
        client: db.adminSql,
      },
      { limit: 10 },
    );
    expect(claimability.rows.map((candidate) => candidate.id)).toEqual([id]);
  });

  it('preserves only the legacy revision-sentinel exception across the readiness floor', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const captured = await captureImprovement({
      title: `legacy revision readiness ${suffix}`,
      kind: 'bug',
      scope: 'harness:papercusp',
      createdBy: 'su-test',
    });
    const id = captured.issue!.id;
    const notReady = createImplementationReadiness({
      status: 'not-ready',
      source: 'agent-review',
      reason: 'agent-review-revision-requested',
    });
    const [row] = await db.adminSql<{ workspace_id: string }[]>`
      UPDATE harness_shared.work_items
         SET admission = NULL,
             payload = COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
           'agentReview', jsonb_build_object(
             'status', 'revision-requested',
             'submittedBy', 'system:legacy-agent-review',
             'ledgerIdeaId', ${id}::text,
             'round', 1
           ),
           'implementationReadiness', ${JSON.stringify(notReady)}::jsonb
         )
       WHERE feature_id = ${id}
      RETURNING workspace_id`;
    const filter: FilterNode = { field: 'id', op: 'in', value: [id] };
    const read = () =>
      readIssueClaimability(
        filter,
        {
          harness: 'papercusp',
          workspaceId: row!.workspace_id,
          states: ['open'],
          assignee: 'su-test',
          client: db.adminSql,
        },
        { limit: 10 },
      );
    expect((await read()).rows.map((candidate) => candidate.id)).toEqual([id]);

    await db.adminSql`
      UPDATE harness_shared.work_items
         SET payload = jsonb_set(payload, '{agentReview,submittedBy}', '"su-real"'::jsonb, false)
       WHERE feature_id = ${id}`;
    const normalRevision = await read();
    expect(normalRevision.rows).toEqual([]);
    expect(normalRevision.breakdown.excluded.agentReview).toBe(1);
  });
});
