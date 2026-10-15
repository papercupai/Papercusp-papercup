import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';

import {
  acceptanceSourceRevision,
  acceptanceSourceRevisionSql,
  createImplementationReadiness,
  deriveWorkItemIntakeStage,
  implementationReadinessNormalExclusionSql,
  intakeStageAdmitsClaim,
  intakeStageClaimFloorSql,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  sealImplementationAcceptance,
  VERIFICATION_TASK_SCHEMA_VERSION,
  verificationConflict,
  verificationConflictSql,
  verificationParties,
  verificationTaskConflict,
  verificationTaskConflictSql,
  workItemIntakeStageSql,
  type ImplementationAcceptanceAuthority,
  type ImplementationAcceptanceContract,
  type ImplementationAcceptanceSource,
  type WorkItemIntakeStageInput,
} from './agent-review-policy';
import type { OrgSql } from '../../work-items';

let sql: postgres.Sql;

const TITLE = 'Bounded parser drops the trailing token';
const SUMMARY = 'The bounded parser drops the last token of every line.';
const BUG_SOURCE: ImplementationAcceptanceSource = { kind: 'bug', title: TITLE, summary: SUMMARY };

const PROPOSAL = {
  problem: 'The bounded parser drops the trailing token of a line.',
  evidence: ['parser.test.ts trailing-token fixture fails on HEAD'],
  outcome: 'Every token of a line survives parsing.',
  scope: 'Fix the bounded parser defect only.',
  completionCheck: 'The trailing-token regression fixture passes.',
};

const REVIEW_AUTHORITY: ImplementationAcceptanceAuthority = {
  kind: 'agent-review',
  reviewer: 'su-reviewer',
  submittedBy: 'su-author',
  round: 1,
};

function sealedContract(
  source: ImplementationAcceptanceSource = BUG_SOURCE,
  authority: ImplementationAcceptanceAuthority = REVIEW_AUTHORITY,
): ImplementationAcceptanceContract {
  const sealed = sealImplementationAcceptance({
    proposal: PROPOSAL,
    authority,
    reason: 'agent-review-approved (grade 5/5)',
    source,
    acceptedAt: '2026-09-05T00:00:00.000Z',
    // P-006: a bug's acceptance carries its reproduction receipt (ignored for other kinds).
    reproduction: { kind: 'failing-test', ref: 'fixture.test.ts', buildSha: 'abcdef1' },
  });
  if (!sealed.ok) throw new Error('fixture contract must seal');
  return sealed.contract;
}

const readinessWith = (acceptance: object | undefined, status: 'ready' | 'unknown' = 'ready') =>
  createImplementationReadiness({
    status,
    source: 'agent-review',
    reason: status === 'ready' ? 'agent-review-approved' : 'awaiting-agent-review',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...(acceptance ? { evidence: { acceptance: acceptance as Record<string, unknown> } } : {}),
  });

const acceptedReadiness = (source: ImplementationAcceptanceSource = BUG_SOURCE) => readinessWith(sealedContract(source));

const withoutKey = (value: Record<string, unknown>, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([entry]) => entry !== key));

const open = (payload: unknown, overrides: Partial<WorkItemIntakeStageInput> = {}): WorkItemIntakeStageInput => ({
  kind: 'bug',
  status: 'open',
  title: TITLE,
  summary: SUMMARY,
  payload,
  ...overrides,
});

const fixtures: Array<{ id: string; input: WorkItemIntakeStageInput }> = [
  {
    id: 'observation-closed',
    input: open({ lane: 'observation', implementationReadiness: acceptedReadiness() }, { status: 'done' }),
  },
  {
    id: 'candidate-unknown',
    input: open({
      implementationReadiness: createImplementationReadiness({
        status: 'unknown',
        source: 'agent-review',
        reason: 'awaiting-agent-review',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
    }),
  },
  {
    id: 'candidate-ready-without-contract',
    input: open({
      implementationReadiness: createImplementationReadiness({
        status: 'ready',
        source: 'capture-policy',
        reason: 'legacy-immediate-policy',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
    }),
  },
  { id: 'accepted-bug', input: open({ implementationReadiness: acceptedReadiness() }) },
  {
    id: 'accepted-feature',
    input: open(
      { implementationReadiness: acceptedReadiness({ ...BUG_SOURCE, kind: 'feature' }) },
      { kind: 'feature' },
    ),
  },
  {
    id: 'accepted-null-summary',
    input: open(
      { implementationReadiness: acceptedReadiness({ ...BUG_SOURCE, summary: null }) },
      { summary: null },
    ),
  },
  {
    id: 'accepted-policy-authority',
    input: open({
      implementationReadiness: readinessWith(
        sealedContract(BUG_SOURCE, {
          kind: 'policy',
          policy: 'trusted-tool-failure-promotion',
          actor: 'system:tool-failure-watchdog',
        }),
      ),
    }),
  },
  {
    id: 'stale-title-edit',
    input: open({ implementationReadiness: acceptedReadiness() }, { title: `${TITLE} (rescoped)` }),
  },
  {
    id: 'stale-summary-edit',
    input: open({ implementationReadiness: acceptedReadiness() }, { summary: `${SUMMARY} Also the header.` }),
  },
  {
    id: 'invalid-self-review',
    input: open({
      implementationReadiness: readinessWith({ ...sealedContract(), authority: { ...REVIEW_AUTHORITY, reviewer: 'su-author' } }),
    }),
  },
  {
    id: 'invalid-unknown-policy',
    input: open({
      implementationReadiness: readinessWith({
        ...sealedContract(),
        authority: { kind: 'policy', policy: 'duplicate-admission', actor: 'system:dedup' },
      }),
    }),
  },
  {
    id: 'invalid-confidence-authority',
    input: open({
      implementationReadiness: readinessWith({ ...sealedContract(), authority: { kind: 'confidence', confidence: 0.99 } }),
    }),
  },
  {
    id: 'invalid-string-round',
    input: open({
      implementationReadiness: readinessWith({ ...sealedContract(), authority: { ...REVIEW_AUTHORITY, round: '1' } }),
    }),
  },
  {
    // SQL NULL fall-through guard: a missing key must read `incomplete`, never skip
    // the branch and land on `qualifying`.
    id: 'incomplete-missing-contract-version',
    input: open({ implementationReadiness: readinessWith(withoutKey({ ...sealedContract() }, 'contractVersion')) }),
  },
  {
    id: 'incomplete-missing-authority',
    input: open({ implementationReadiness: readinessWith(withoutKey({ ...sealedContract() }, 'authority')) }),
  },
  {
    id: 'incomplete-array-authority',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), authority: [REVIEW_AUTHORITY] }) }),
  },
  {
    id: 'incomplete-missing-completion-check',
    input: open({ implementationReadiness: readinessWith(withoutKey({ ...sealedContract() }, 'completionCheck')) }),
  },
  {
    id: 'incomplete-numeric-reason',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), reason: 5 }) }),
  },
  {
    // btrim() strips only spaces; String.prototype.trim strips every whitespace class.
    id: 'incomplete-newline-only-scope',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), scope: '\n\t' }) }),
  },
  {
    id: 'incomplete-blank-evidence-entry',
    input: open({ implementationReadiness: readinessWith({ ...sealedContract(), evidence: ['ok', ' \n '] }) }),
  },
  { id: 'proposal-on-unknown', input: open({ implementationReadiness: readinessWith(PROPOSAL, 'unknown') }) },
  {
    id: 'creation-enrollment',
    input: open({
      implementationReadiness: createImplementationReadiness({
        status: 'unknown',
        source: 'creation-enrollment',
        reason: 'no-acceptance-evidence-at-creation',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
    }),
  },
  { id: 'terminal-by-state', input: open({ implementationReadiness: acceptedReadiness() }, { status: 'done' }) },
  {
    id: 'terminal-by-completion-ref',
    input: open(
      { implementationReadiness: acceptedReadiness() },
      { terminalOwner: 'su-finisher', terminalCompletionRef: 'WI-1#completion' },
    ),
  },
  { id: 'legacy-missing', input: open({}) },
  {
    id: 'malformed-version',
    input: open({ implementationReadiness: { schemaVersion: 'future-v9', status: 'ready' } }),
  },
  {
    // SQL NULL fall-through guard for the readiness validity check itself.
    id: 'malformed-missing-schema-version',
    input: open({ implementationReadiness: withoutKey({ ...acceptedReadiness() }, 'schemaVersion') }),
  },
  {
    id: 'malformed-numeric-reason',
    input: open({ implementationReadiness: { ...acceptedReadiness(), reason: 7 } }),
  },
  {
    id: 'malformed-timestamp',
    input: open({ implementationReadiness: { ...acceptedReadiness(), updatedAt: 'not-a-timestamp' } }),
  },
  // P-008 / D-038: admission dedup is intake step one, ahead of every readiness leg.
  {
    id: 'admission-pending-accepted',
    input: open({ implementationReadiness: acceptedReadiness() }, { admission: 'pending' }),
  },
  { id: 'admission-pending-unenrolled', input: open({}, { admission: 'pending' }) },
  {
    id: 'admission-admitted-accepted',
    input: open({ implementationReadiness: acceptedReadiness() }, { admission: 'admitted' }),
  },
  {
    id: 'admission-pending-terminal',
    input: open({ implementationReadiness: acceptedReadiness() }, { status: 'done', admission: 'pending' }),
  },
];

beforeAll(async () => {
  const dsn = inject('baselineSchemaDsn');
  await assertPgReachable(dsn, 'agent-review-stage-parity');
  sql = postgres(dsn, { max: 1, onnotice: () => {}, prepare: false });
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

describe('workItemIntakeStageSql', () => {
  it('matches the shared TypeScript derivation for every supported fixture', async () => {
    const rows: Array<{ id: string; decision: unknown }> = [];
    for (const { id, input } of fixtures) {
      const [row] = await sql<Array<{ decision: unknown }>>`
        SELECT ${workItemIntakeStageSql(sql as unknown as OrgSql, { admission: 'admission' })} AS decision
          FROM (VALUES (
            ${input.kind}::text,
            ${input.status}::text,
            ${input.terminalOwner ?? null}::text,
            ${input.terminalCompletionRef ?? null}::text,
            ${input.payload == null ? null : sql.json(input.payload as postgres.JSONValue)}::jsonb,
            ${input.title ?? null}::text,
            ${input.summary ?? null}::text,
            ${input.admission ?? null}::text
          )) AS fixture(item_kind, status, terminal_owner, terminal_completion_ref, payload, title, summary, admission)`;
      rows.push({ id, decision: row.decision });
    }
    rows.sort((a, b) => a.id.localeCompare(b.id));
    const expected = [...fixtures]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ id, input }) => ({ id, decision: deriveWorkItemIntakeStage(input) }));

    expect(rows).toEqual(expected);
    // Pin the load-bearing verdicts so a symmetric regression on both sides still fails.
    const byId = new Map(rows.map((row) => [row.id, row.decision]));
    expect(byId.get('observation-closed')).toMatchObject({ primaryStage: 'observation', countsAsBugWork: false });
    // P-008 / D-038: a pending admission is a candidate awaiting dedup, even when its
    // readiness would otherwise accept it, and it never counts as bug work yet.
    expect(byId.get('admission-pending-accepted')).toMatchObject({
      primaryStage: 'candidate',
      reason: 'awaiting-admission-dedup',
      countsAsBugWork: false,
    });
    expect(byId.get('admission-pending-unenrolled')).toMatchObject({
      primaryStage: 'candidate',
      reason: 'awaiting-admission-dedup',
      readiness: 'legacy-missing',
    });
    expect(byId.get('admission-admitted-accepted')).toMatchObject({ primaryStage: 'accepted', countsAsBugWork: true });
    expect(byId.get('admission-pending-terminal')).toMatchObject({ primaryStage: 'terminal' });
    expect(byId.get('accepted-bug')).toMatchObject({ primaryStage: 'accepted', acceptance: 'qualifying' });
    expect(byId.get('stale-title-edit')).toMatchObject({
      primaryStage: 'candidate',
      acceptance: 'stale-revision',
      reReviewRequested: true,
    });
    expect(byId.get('invalid-self-review')).toMatchObject({ acceptance: 'invalid-authority' });
    // R-24 (P-007): duplicate admission and confidence are never acceptance authority —
    // pinned directly so a symmetric SQL+TS widening of the policy allowlist still fails.
    expect(byId.get('invalid-unknown-policy')).toMatchObject({ acceptance: 'invalid-authority', qualifyingAcceptance: false });
    expect(byId.get('invalid-confidence-authority')).toMatchObject({
      acceptance: 'invalid-authority',
      qualifyingAcceptance: false,
    });
    expect(byId.get('incomplete-missing-contract-version')).toMatchObject({ acceptance: 'incomplete' });
    expect(byId.get('incomplete-newline-only-scope')).toMatchObject({ acceptance: 'incomplete' });
    expect(byId.get('malformed-missing-schema-version')).toMatchObject({ primaryStage: 'unknown', readiness: 'malformed' });
    expect(byId.get('creation-enrollment')).toMatchObject({ primaryStage: 'candidate', readiness: 'unknown' });
  });

  it('computes the same source revision in SQL as in TypeScript', async () => {
    for (const source of [BUG_SOURCE, { ...BUG_SOURCE, summary: null }, { kind: 'task', title: 'ünïcødé — title', summary: 'x' }]) {
      const [row] = await sql<Array<{ revision: string }>>`
        SELECT ${acceptanceSourceRevisionSql(sql as unknown as OrgSql)} AS revision
          FROM (VALUES (${source.kind}::text, ${source.title}::text, ${source.summary ?? null}::text))
            AS fixture(item_kind, title, summary)`;
      expect(row.revision).toBe(acceptanceSourceRevision(source));
    }
  });
});

describe('implementationReadinessNormalExclusionSql (claim floor)', () => {
  const stamp = createImplementationReadiness({
    status: 'unknown',
    source: 'creation-enrollment',
    reason: 'no-acceptance-evidence-at-creation',
    updatedAt: '2026-09-05T00:00:00.000Z',
  });
  const cases: Array<{ id: string; payload: unknown; passes: boolean }> = [
    { id: 'legacy-absent', payload: {}, passes: true },
    { id: 'null-payload', payload: null, passes: true },
    { id: 'creation-enrollment-legacy-equivalent', payload: { implementationReadiness: stamp }, passes: true },
    { id: 'ready', payload: { implementationReadiness: acceptedReadiness() }, passes: true },
    {
      id: 'capture-policy-unknown',
      payload: { implementationReadiness: { ...stamp, source: 'capture-policy' } },
      passes: false,
    },
    {
      id: 'not-ready',
      payload: { implementationReadiness: { ...stamp, status: 'not-ready', source: 'agent-review' } },
      passes: false,
    },
    { id: 'malformed-object', payload: { implementationReadiness: { status: 'ready' } }, passes: false },
    { id: 'malformed-scalar', payload: { implementationReadiness: 'garbage' }, passes: false },
  ];

  it.each(cases)('$id → passes=$passes, never NULL', async ({ payload, passes }) => {
    const [row] = await sql<Array<{ passes: boolean | null; held: boolean | null }>>`
      SELECT ${implementationReadinessNormalExclusionSql(sql as unknown as OrgSql, 'payload')} AS passes,
             NOT ${implementationReadinessNormalExclusionSql(sql as unknown as OrgSql, 'payload')} AS held
        FROM (VALUES (
          ${payload == null ? null : sql.json(payload as postgres.JSONValue)}::jsonb,
          -- The floor also reads the row's acceptance source (kind/title/summary, matching
          -- acceptedReadiness()'s BUG_SOURCE) and created_ts (0 = pre-cutover legacy arm).
          ${BUG_SOURCE.kind}::text, ${TITLE}::text, ${SUMMARY}::text, 0::bigint
        )) AS fixture(payload, item_kind, title, summary, created_ts)`;
    expect(row).toEqual({ passes, held: !passes });
  });
});

describe('intakeStageClaimFloorSql: one stage predicate, TS twin agrees (P-008 / D-038)', () => {
  const enrolled = createImplementationReadiness({
    status: 'unknown',
    source: 'creation-enrollment',
    reason: 'no-acceptance-evidence-at-creation',
    updatedAt: '2026-09-05T00:00:00.000Z',
  });
  const mirror = { ...enrolled, source: 'agent-review', reason: 'awaiting-agent-review' };
  const revision = { ...enrolled, status: 'not-ready', source: 'agent-review', reason: 'agent-review-revision-requested' };
  const review = (status: unknown, submittedBy: unknown = 'su-author') => ({
    status,
    submittedBy,
    ledgerIdeaId: 'idea-1',
    round: 1,
  });
  // `passes` is the PRE-P-008 floor's verdict for each row (agentReviewNormalExclusionSql
  // composed over implementationReadinessNormalExclusionSql), so this table also pins that
  // the rename to one stage predicate changed no claimability.
  const cases: Array<{ id: string; payload: unknown; passes: boolean }> = [
    { id: 'no-review legacy row', payload: {}, passes: true },
    { id: 'null payload', payload: null, passes: true },
    { id: 'review pending holds', payload: { agentReview: review('pending'), implementationReadiness: mirror }, passes: false },
    { id: 'pending holds even with a divergent accepted readiness', payload: { agentReview: review('pending'), implementationReadiness: acceptedReadiness() }, passes: false },
    { id: 'revision requested holds', payload: { agentReview: review('revision-requested'), implementationReadiness: revision }, passes: false },
    // Pins the revision-requested leg on its own: with a not-ready readiness (the row above) the
    // readiness floor would hold the row even if that leg were deleted.
    {
      id: 'revision requested holds even with a divergent accepted readiness',
      payload: { agentReview: review('revision-requested'), implementationReadiness: acceptedReadiness() },
      passes: false,
    },
    {
      id: 'legacy-submitter revision bypasses the readiness floor',
      payload: { agentReview: review('revision-requested', LEGACY_AGENT_REVIEW_SUBMITTER), implementationReadiness: revision },
      passes: true,
    },
    { id: 'legacy-submitter pending still holds', payload: { agentReview: review('pending', LEGACY_AGENT_REVIEW_SUBMITTER) }, passes: false },
    // bug-queue-legitimacy D-006/D-007: a reproduction-only revision is validation work for
    // the drain lane — admitted with readiness still not-ready; a content revision holds.
    {
      id: 'reproduction-validation revision bypasses the readiness floor',
      payload: { agentReview: { ...review('revision-requested'), revisionKind: 'reproduction' }, implementationReadiness: revision },
      passes: true,
    },
    {
      id: 'content revision still holds',
      payload: { agentReview: { ...review('revision-requested'), revisionKind: 'content' }, implementationReadiness: revision },
      passes: false,
    },
    {
      id: 'reproduction kind on a pending review does not admit',
      payload: { agentReview: { ...review('pending'), revisionKind: 'reproduction' }, implementationReadiness: mirror },
      passes: false,
    },
    {
      id: 'non-string revisionKind never matches',
      payload: { agentReview: { ...review('revision-requested'), revisionKind: ['reproduction'] }, implementationReadiness: revision },
      passes: false,
    },
    { id: 'approved + accepted readiness', payload: { agentReview: review('approved'), implementationReadiness: acceptedReadiness() }, passes: true },
    {
      id: 'approved review does not lift a capture-policy hold',
      payload: { agentReview: review('approved'), implementationReadiness: { ...enrolled, source: 'capture-policy' } },
      passes: false,
    },
    { id: 'non-string review status is no review', payload: { agentReview: review(1), implementationReadiness: enrolled }, passes: true },
    { id: 'scalar agentReview is no review', payload: { agentReview: 'garbage' }, passes: true },
    { id: 'malformed readiness holds', payload: { implementationReadiness: { status: 'ready' } }, passes: false },
  ];

  it.each(cases)('$id → passes=$passes in SQL and TS, never NULL', async ({ payload, passes }) => {
    const floor = intakeStageClaimFloorSql(sql as unknown as OrgSql, 'payload');
    const [row] = await sql<Array<{ passes: boolean | null; held: boolean | null }>>`
      SELECT ${floor} AS passes, NOT ${floor} AS held
        FROM (VALUES (
          ${payload == null ? null : sql.json(payload as postgres.JSONValue)}::jsonb,
          ${BUG_SOURCE.kind}::text, ${TITLE}::text, ${SUMMARY}::text, 0::bigint
        )) AS fixture(payload, item_kind, title, summary, created_ts)`;
    expect(row).toEqual({ passes, held: !passes });
    expect(
      intakeStageAdmitsClaim({ payload, kind: BUG_SOURCE.kind, title: TITLE, summary: SUMMARY, createdAtMs: 0 }),
    ).toBe(passes);
  });
});

describe('verifier-conflict SQL twins agree with the JS predicates (P-007 / D-021)', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    verification: {
      schemaVersion: VERIFICATION_TASK_SCHEMA_VERSION,
      subject: 'EI-0',
      check: 'reproduction',
      reporters: ['su-reporter'],
      implementers: ['su-implementer'],
      ...over,
    },
  });
  const cases: Array<{ id: string; payload: unknown; terminalOwner: string | null; claimant: string }> = [
    { id: 'task reporter', payload: task(), terminalOwner: null, claimant: 'su-reporter' },
    { id: 'task implementer', payload: task(), terminalOwner: null, claimant: 'su-implementer' },
    { id: 'independent verifier', payload: task(), terminalOwner: null, claimant: 'su-verifier' },
    { id: 'blank claimant', payload: task({ reporters: [''] }), terminalOwner: null, claimant: ' ' },
    { id: 'missing check (NULL leg)', payload: task({ check: undefined }), terminalOwner: null, claimant: 'su-reporter' },
    { id: 'unknown check', payload: task({ check: 'vibes' }), terminalOwner: null, claimant: 'su-reporter' },
    { id: 'old schema', payload: task({ schemaVersion: 'verification-task-v0' }), terminalOwner: null, claimant: 'su-reporter' },
    { id: 'blank subject', payload: task({ subject: ' ' }), terminalOwner: null, claimant: 'su-reporter' },
    { id: 'scalar reporters', payload: task({ reporters: 'su-reporter' }), terminalOwner: null, claimant: 'su-reporter' },
    { id: 'padded reporter id', payload: task({ reporters: [' su-reporter '] }), terminalOwner: null, claimant: 'su-reporter' },
    { id: 'no block', payload: {}, terminalOwner: null, claimant: 'su-reporter' },
    { id: 'null payload', payload: null, terminalOwner: null, claimant: 'su-reporter' },
    { id: 'auto-filer', payload: { _ei: { created_by: 'improvement-triage' } }, terminalOwner: null, claimant: 'improvement-triage' },
    // A complete review state: JS reads submittedBy only from one (readAgentReviewState),
    // and the review selectors that use this twin already require a complete pending state.
    {
      id: 'submitter',
      payload: { agentReview: { status: 'pending', submittedBy: 'su-sub', ledgerIdeaId: 'WI-7', round: 1 } },
      terminalOwner: null,
      claimant: 'su-sub',
    },
    { id: 'closer', payload: {}, terminalOwner: 'su-closer', claimant: 'su-closer' },
  ];

  it.each(cases)('$id: SQL twins match JS and are never NULL', async ({ payload, terminalOwner, claimant }) => {
    const o = sql as unknown as OrgSql;
    const [row] = await sql<Array<{ task_conflict: boolean | null; keeps: boolean | null; any_conflict: boolean | null }>>`
      SELECT ${verificationTaskConflictSql(o, claimant, 'payload')} AS task_conflict,
             NOT ${verificationTaskConflictSql(o, claimant, 'payload')} AS keeps,
             ${verificationConflictSql(o, claimant, { payload: 'payload', terminalOwner: 'terminal_owner' })} AS any_conflict
        FROM (VALUES (
          ${payload == null ? null : sql.json(payload as postgres.JSONValue)}::jsonb,
          ${terminalOwner}::text
        )) AS fixture(payload, terminal_owner)`;
    const jsTask = verificationTaskConflict(payload, claimant) !== null;
    // createdBy is a column the SQL twin does not read (claimNextAgentReview re-checks it in JS).
    const jsAny = verificationConflict(verificationParties({ terminalOwner, payload }), claimant) !== null;
    expect(row).toEqual({ task_conflict: jsTask, keeps: !jsTask, any_conflict: jsAny });
  });
});
