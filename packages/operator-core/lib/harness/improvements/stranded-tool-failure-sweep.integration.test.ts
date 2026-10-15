/**
 * Stranded tool-failure sweep against a fully migrated Postgres (plan
 * unified-bug-pipeline-and-honest-queue-2026-10-05 P-003 / D-022;
 * EI-25176539351759672).
 *
 * Drives the real candidate query, the real tool_invocations ledger read, the
 * real payload merge, terminal-state write and agent-review enrolment. Fixture
 * filing uses an empty lexical-dedup result, so the sweep's assertions do not
 * depend on the unrelated capture search deadline. The sweep injects only git
 * and the tool-source lookup; a fixed history makes retirement checkable.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { GitRead } from '../../candidate-contains';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  fixtureDedupSearch: vi.fn(async (_query: string, _limit?: number) => []),
}));
vi.mock('../../issues-engineer', async (orig) => ({
  ...(await orig<typeof import('../../issues-engineer')>()),
  searchIssuesForDedup: h.fixtureDedupSearch,
}));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('./capture-core');
const { readIssueClaimability } = await import('../../scheduler/get-next');
const { STRANDED_SWEEP_OWNER, sweepExpiredCandidates, sweepStrandedToolFailures } = await import('./stranded-tool-failure-sweep');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

const ROOT = '/repo';
const REPORT = 'aaaaaaa1111';
const CURRENT = 'bbbbbbb2222';
const HOUR = 3_600_000;

/** One commit history per tool file; `--since` filters by commit time, as git does. */
function gitWith(history: Record<string, Array<{ sha: string; at: string }>>): GitRead {
  return async (args) => {
    if (args[0] === 'config') return '';
    const path = String(args.at(-1));
    if (args[0] === 'ls-tree') return `100644 blob 0123456789abcdef\t${path}`;
    if (args[0] !== 'log') return null;
    const since = args.find((arg) => arg.startsWith('--since='))?.slice('--since='.length);
    return (history[path] ?? [])
      .filter((commit) => !since || Date.parse(commit.at) >= Date.parse(since))
      .map((commit) => commit.sha)
      .join('\n');
  };
}

describe('stranded tool-failure sweep (P-003 / D-022)', () => {
  it('verifies, retires and enrols the stranded rows, and leaves taken rows alone', async () => {
    h.fixtureDedupSearch.mockClear();
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const t0 = new Date(Date.now() - 6 * HOUR).toISOString();
    const at = (hours: number) => new Date(Date.parse(t0) + hours * HOUR).toISOString();
    const tool = (name: string) => `sweep-${name}:${suffix}`;

    const make = async (name: string) => {
      const filed = await captureImprovement({
        title: `stranded sweep ${name} ${suffix}`,
        kind: 'bug',
        scope: 'harness:papercusp',
        createdBy: 'su-test',
      });
      return filed.issue!.id;
    };
    const ids = {
      retire: await make('retire'),
      recurring: await make('recurring'),
      verified: await make('verified'),
      freshness: await make('freshness'),
      taken: await make('taken'),
    };
    // Guard the fixture boundary: returning to the live lexical search would
    // reintroduce its wall-clock deadline before the sweep is even exercised.
    expect(h.fixtureDedupSearch).toHaveBeenCalledTimes(5);
    for (const [query, limit] of h.fixtureDedupSearch.mock.calls) {
      expect(query).toContain(`stranded sweep `);
      expect(limit).toBe(20);
    }
    const [{ workspace_id: workspaceId }] = await db.adminSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.work_items WHERE feature_id = ${ids.retire}`;

    // The failing call a receipt cites, and the failure that keeps a row open.
    const [{ id: receiptCall }] = await db.adminSql<{ id: string }[]>`
      INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, plugin_name, role, spawn_id, window_key,
         tool_name, status, error_code, serving_build_sha, invoked_at)
      VALUES (${workspaceId}, 'papercusp', 'papercusp', 'su', 'sweep-test', 'sweep-test',
              ${tool('verified')}, 'error', 'handler_error', ${REPORT}, ${at(0)}::timestamptz)
      RETURNING id`;
    const call = (name: string, status: string, errorCode: string | null, build: string, hours: number) =>
      db.adminSql`
        INSERT INTO harness_shared.tool_invocations
          (workspace_id, harness_slug, plugin_name, role, spawn_id, window_key,
           tool_name, status, error_code, serving_build_sha, invoked_at)
        VALUES (${workspaceId}, 'papercusp', 'papercusp', 'su', 'sweep-test', 'sweep-test',
                ${tool(name)}, ${status}, ${errorCode}, ${build}, ${at(hours)}::timestamptz)`;
    await call('retire', 'error', 'handler_error', REPORT, 1);
    await call('recurring', 'error', 'timeout', CURRENT, 4);
    // A success and a different error code never block retirement.
    await call('retire', 'ok', null, CURRENT, 5);
    await call('retire', 'invalid-input', 'invalid_input', CURRENT, 5);

    // Put each row in the state the pre-P-002 producers left it: promoted, awaiting a
    // verifier, no agentReview record, no admission hold.
    const strand = async (id: string, name: string, errorCode: string, reason: string, extra: Record<string, unknown> = {}) => {
      const patch = {
        implementationReadiness: {
          schemaVersion: 'implementation-readiness-v1',
          status: 'unknown',
          source: reason === 'deployment-freshness-unknown' ? 'triage-freshness' : 'capture-policy',
          reason,
          updatedAt: t0,
        },
        toolFailureProbation: {
          state: 'promoted',
          class: 'structural',
          deployedRevision: REPORT,
          report: { toolName: tool(name), errorCode },
        },
        freshnessEnvelope: { observedSourceSha: REPORT, observedRuntimeSha: REPORT, observedAt: t0 },
        ...extra,
      };
      await db.adminSql`
        UPDATE harness_shared.work_items
           SET admission = NULL,
               payload = (payload - 'agentReview' - 'lastSeenAt') || ${JSON.stringify(patch)}::jsonb
         WHERE feature_id = ${id}`;
    };
    await strand(ids.retire, 'retire', 'handler_error', 'corroborated-tool-failure-awaiting-review');
    await strand(ids.recurring, 'recurring', 'timeout', 'corroborated-tool-failure-awaiting-review');
    await strand(ids.verified, 'verified', 'handler_error', 'corroborated-tool-failure-awaiting-review', {
      reproduction: {
        schemaVersion: 'bug-reproduction-v1',
        receipt: { kind: 'encounter', ref: `tool_invocations:${receiptCall}`, buildSha: REPORT },
        filedBy: 'su-peer',
        verification: { status: 'verified', detail: 'filed', checkedAt: t0 },
      },
    });
    await strand(ids.freshness, 'freshness', 'handler_error', 'deployment-freshness-unknown');
    await strand(ids.taken, 'retire', 'handler_error', 'corroborated-tool-failure-awaiting-review');
    await db.adminSql`UPDATE harness_shared.work_items SET taken_by = 'su-busy' WHERE feature_id = ${ids.taken}`;

    // retire + recurring: the tool file changed at +2h. freshness: the tool source is unknown.
    const file = (name: string) => `packages/${name}.ts`;
    const result = await sweepStrandedToolFailures(workspaceId, {
      sql: db.adminSql,
      currentBuild: () => CURRENT,
      repoRoot: ROOT,
      sourceFileFor: (name) => (name === tool('freshness') ? null : `${ROOT}/${file(name.split(':')[0])}`),
      git: gitWith({
        [file('sweep-retire')]: [{ sha: 'c-retire-fix', at: at(2) }],
        [file('sweep-recurring')]: [{ sha: 'c-recurring-fix', at: at(2) }],
      }),
    });
    expect(result.failed).toBe(0);
    expect(result.enrolFailed).toBe(0);

    const rows = await db.adminSql<{
      feature_id: string;
      status: string;
      taken_by: string | null;
      payload: Record<string, unknown>;
    }[]>`
      SELECT feature_id, status, taken_by, payload
        FROM harness_shared.work_items
       WHERE feature_id = ANY(${Object.values(ids)}::text[])`;
    const byId = new Map(rows.map((row) => [row.feature_id, row]));

    // (2) retired with the D-012 evidence, under the sweep's own owner.
    const retired = byId.get(ids.retire)!;
    expect(retired.status).not.toBe('open');
    expect(retired.payload).toMatchObject({
      strandedToolFailureSweep: {
        owner: STRANDED_SWEEP_OWNER,
        outcome: 'retired',
        reportBuild: REPORT,
        currentBuild: CURRENT,
        changeCommits: ['c-retire-fix'],
        lastMatchingFailureAt: at(1),
      },
    });
    expect(String(retired.payload.decidedReason)).toContain('D-012/D-022');

    // (3) a failure after the change keeps the row. P-026 preserves the original
    // filer when repairing review enrolment; the sweep is the operation owner.
    const recurring = byId.get(ids.recurring)!;
    expect(recurring.status).toBe('open');
    expect(recurring.payload).toMatchObject({
      agentReview: { status: 'pending', submittedBy: 'su-test' },
      strandedToolFailureSweep: { outcome: 'review', reason: 'failure-after-last-change' },
    });
    const { claimAgentReview } = await import('./agent-review');
    expect(await claimAgentReview({ id: ids.recurring, reviewer: 'su-test', harnessSlug: 'papercusp' })).toMatchObject({
      claimed: false,
    });
    expect(await claimAgentReview({ id: ids.recurring, reviewer: 'su-reviewer', harnessSlug: 'papercusp' })).toMatchObject({
      claimed: true,
    });

    // (3) an unresolvable freshness never retires: review, for both stranded reasons.
    expect(byId.get(ids.freshness)!.payload).toMatchObject({
      agentReview: { status: 'pending' },
      strandedToolFailureSweep: { outcome: 'review', reason: 'tool-source-unknown' },
    });

    // (1) the cited failing call still resolves on its build: born verified and claimable.
    const verified = byId.get(ids.verified)!;
    expect(verified.payload).toMatchObject({
      implementationReadiness: { status: 'ready', reason: 'born-verified-tool-failure-promotion' },
      reproduction: { verification: { status: 'verified' } },
      strandedToolFailureSweep: { outcome: 'verified' },
    });
    expect(verified.payload).not.toHaveProperty('agentReview');
    const claimability = await readIssueClaimability(
      { field: 'id', op: 'in', value: [ids.verified] },
      { harness: 'papercusp', workspaceId, states: ['open'], assignee: 'su-test', client: db.adminSql },
      { limit: 10 },
    );
    expect(claimability.rows.map((row) => row.id)).toEqual([ids.verified]);

    // Someone else's taken row keeps its own disposition.
    const taken = byId.get(ids.taken)!;
    expect(taken.taken_by).toBe('su-busy');
    expect(taken.payload).not.toHaveProperty('strandedToolFailureSweep');
    expect(taken.payload).not.toHaveProperty('agentReview');

    // A second pass finds nothing left of these rows to do.
    const again = await sweepStrandedToolFailures(
      workspaceId,
      { sql: db.adminSql, currentBuild: () => CURRENT, repoRoot: ROOT, sourceFileFor: () => null, git: gitWith({}) },
      { dryRun: true },
    );
    const ours = new Set(Object.values(ids));
    expect((again.plan ?? []).filter((entry) => ours.has(entry.id))).toEqual([]);
  });
});

describe('candidate expiry reads no person-reported row (P-011 / D-046 pt 6, slack D-012)', () => {
  it('skips a chat-stamped candidate and one a chat report corroborated, and still reads an automatic one', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const make = async (name: string) => {
      const filed = await captureImprovement({
        title: `candidate expiry ${name} ${suffix}`,
        kind: 'bug',
        scope: 'harness:papercusp',
        createdBy: 'su-test',
      });
      return filed.issue!.id;
    };
    const ids = { automatic: await make('automatic'), chat: await make('chat'), corroborated: await make('corroborated') };
    const [{ workspace_id: workspaceId }] = await db.adminSql<{ workspace_id: string }[]>`
      SELECT workspace_id FROM harness_shared.work_items WHERE feature_id = ${ids.automatic}`;
    // An admission-pending tool-failure candidate, as capture leaves it while in probation.
    const pending = async (id: string, reporterKind: string, reporterKinds: string[]) => {
      const patch = {
        toolFailureProbation: { state: 'probation', class: 'structural', report: { toolName: `expiry:${suffix}`, errorCode: 'handler_error' } },
        reporter: { kind: reporterKind, id: 'reporter', basis: 'explicit', at: new Date().toISOString() },
        reporterKinds,
      };
      await db.adminSql`
        UPDATE harness_shared.work_items
           SET admission = 'pending', taken_by = NULL,
               payload = (payload - 'candidateExpiry') || ${JSON.stringify(patch)}::jsonb
         WHERE feature_id = ${id}`;
    };
    await pending(ids.automatic, 'agent', ['agent']);
    await pending(ids.chat, 'chat', ['chat']);
    await pending(ids.corroborated, 'agent', ['agent', 'chat']);

    const result = await sweepExpiredCandidates(
      workspaceId,
      { sql: db.adminSql, currentBuild: () => CURRENT, repoRoot: ROOT, sourceFileFor: () => null, git: gitWith({}) },
      { dryRun: true, limit: 500 },
    );
    const read = new Set((result.plan ?? []).map((entry) => entry.id));
    // The positive control: the automatic candidate is read, so an empty answer cannot pass vacuously.
    expect(read.has(ids.automatic)).toBe(true);
    expect(read.has(ids.chat)).toBe(false);
    expect(read.has(ids.corroborated)).toBe(false);
  });
});
