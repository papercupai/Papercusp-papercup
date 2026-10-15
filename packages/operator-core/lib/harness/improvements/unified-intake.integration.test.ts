/**
 * unified-bug-pipeline-and-honest-queue-2026-10-05 P-011 (D-046), against a fully
 * migrated Postgres:
 *  - a person's in-app report and an agent's report of the SAME error land as ONE
 *    bug through the one intake, carrying both reporter kinds (the R-1 slice);
 *  - the candidate-expiry pass resolves a quiet automatic candidate with D-012
 *    evidence and leaves a person-reported candidate open.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import type { GitRead } from '../../candidate-contains';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { captureImprovement } = await import('./capture-core');
const { createIssue } = await import('../../issues-engineer');
const { intakeEndUserReport } = await import('./end-user-intake');
const { sweepExpiredCandidates } = await import('./stranded-tool-failure-sweep');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

// No similarity search: this pins the error-signature fold, which needs no search.
const capture = (input: Parameters<typeof captureImprovement>[0]) =>
  captureImprovement(input, { searchIssues: async () => [], createIssue });

describe('one intake for every reporter (R-1 slice)', () => {
  it("folds a person's report and an agent's report of the same error into one bug", async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const person = await intakeEndUserReport(
      {
        text: `The card panel goes blank when I open card ${suffix}`,
        reporterId: 'user-integration',
        scope: 'harness:papercusp',
        reportContext: {
          appVersion: '0.9.3',
          recentErrors: [
            { message: `TypeError: Cannot read properties of undefined (reading 'cardTitle${suffix.replace(/\W/g, '')}') at 41:17`, source: 'renderer' },
          ],
        },
      },
      { capture, rememberNote: async () => [] },
    );
    expect(person.routed).toBe('work-item');
    const first = person.routed === 'work-item' ? person.capture : null;
    expect(first?.created).toBe(true);

    // Same error, different line/column and wrapper: the normalized signature matches.
    const agent = await capture({
      title: `board renderer throws on card open (${suffix})`,
      kind: 'bug',
      scope: 'harness:papercusp',
      createdBy: 'su-integration-agent',
      reportContext: {
        recentErrors: [
          { message: `Uncaught TypeError: Cannot read properties of undefined (reading 'cardTitle${suffix.replace(/\W/g, '')}') at 88:3`, source: 'renderer' },
        ],
      },
    });

    expect(agent.created).toBe(false);
    expect(agent.issue?.id).toBe(first?.issue?.id);
    const rows = await db.adminSql<{ feature_id: string; title: string; payload: Record<string, unknown> }[]>`
      SELECT feature_id, title, payload FROM harness_shared.work_items
       WHERE payload->>'errorSignature' IS NOT NULL AND title ILIKE ${`%${suffix}%`}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toContain('goes blank');
    expect(rows[0]!.payload.reporterKinds).toEqual(expect.arrayContaining(['agent', 'end-user']));
    expect(rows[0]!.payload.reporter).toMatchObject({ kind: 'end-user' });
  });
});

describe('candidate expiry (D-046 pt 6)', () => {
  const REPORT = 'aaaaaaa1111';
  const CURRENT = 'bbbbbbb2222';
  const T0 = '2026-10-01T10:00:00.000Z';
  const git: GitRead = async (args) => {
    if (args[0] === 'config') return '';
    if (args[0] === 'log') return 'c-fix';
    if (args[0] === 'ls-tree') return '100644 blob 0123456789abcdef\tpackages/tool.ts';
    return null;
  };

  async function candidate(reporterKind: 'watchdog' | 'end-user', suffix: string): Promise<{ id: string; workspaceId: string }> {
    const filed = await capture({ title: `${reporterKind} candidate ${suffix}`, kind: 'bug', scope: 'harness:papercusp', createdBy: 'su-test' });
    const id = filed.issue!.id;
    const patch = {
      reporter: { kind: reporterKind, id: null, basis: 'explicit', at: T0 },
      reporterKinds: [reporterKind],
      toolFailureProbation: { state: 'probation', class: 'structural', report: { toolName: 'facts:assert', errorCode: 'handler_error' } },
      freshnessEnvelope: { observedSourceSha: REPORT, observedAt: T0 },
    };
    const [row] = await db.adminSql<{ workspace_id: string }[]>`
      UPDATE harness_shared.work_items
         SET admission = 'pending', payload = payload || ${db.adminSql.json(patch)}
       WHERE feature_id = ${id}
   RETURNING workspace_id`;
    return { id, workspaceId: row!.workspace_id };
  }

  it('resolves a quiet automatic candidate with evidence and leaves a person-reported one open', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const auto = await candidate('watchdog', suffix);
    const person = await candidate('end-user', suffix);

    const result = await sweepExpiredCandidates(auto.workspaceId, {
      currentBuild: () => CURRENT,
      sourceFileFor: () => '/repo/packages/tool.ts',
      repoRoot: '/repo',
      git,
      lastFailureAfter: async () => null,
    });
    expect(result.failed).toBe(0);
    expect(result.expired).toBeGreaterThanOrEqual(1);

    const rows = await db.adminSql<{ feature_id: string; status: string; payload: Record<string, unknown> }[]>`
      SELECT feature_id, status, payload FROM harness_shared.work_items
       WHERE feature_id IN (${auto.id}, ${person.id})`;
    const byId = Object.fromEntries(rows.map((r) => [r.feature_id, r]));
    expect(byId[auto.id]!.status).toBe('resolved');
    expect(byId[auto.id]!.payload.candidateExpiry).toMatchObject({ outcome: 'expired', reportBuild: REPORT, checkedBuild: CURRENT });
    expect(String(byId[auto.id]!.payload.decidedReason)).toContain('D-012/D-046');
    // The person's report is not even a candidate for this pass.
    expect(byId[person.id]!.status).toBe('open');
    expect(byId[person.id]!.payload.candidateExpiry).toBeUndefined();
  });
});
