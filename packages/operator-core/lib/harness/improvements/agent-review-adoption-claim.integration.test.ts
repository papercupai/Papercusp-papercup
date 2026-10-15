/**
 * BQL D-008 (bug-queue-legitimacy-and-actionable-validation-2026-10-10, P-002): revision
 * adoption through the REAL shared claim writer on a fully migrated Postgres.
 *
 * Why this file exists: agent-review-scope.integration.test.ts proves adopt-next's
 * discovery query, but it replaces `claimWorkItem` with a hand-written UPDATE. The real
 * writer's issue intake floor admits a revision-requested row only for its CURRENT payload
 * submitter, and adoption claims BEFORE it rebinds, so every live adoption was refused
 * (adopt-next on :3170: 0 of 25 adopted, 16 claim-refused) while that test stayed green.
 * Here the claim is the production claimWorkItem -> claimIssue path, so the floor and the
 * admission that lifts it are both exercised in SQL.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

const { createIssue, claimIssue } = await import('../../issues-engineer');
const { claimWorkItem, getWorkItem, mergeWorkItemPayload, releaseWorkItem } = await import('../../work-items');
const { adoptAgentReviewRevision } = await import('./agent-review');
const { mintAgentReviewRevisionAdoptionAdmission, readAgentReviewState } = await import('./agent-review-policy');

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 4 });
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

// Full owner ids: a short su- prefix is expanded (or refused) by the claim writer's
// canonicalization before any floor runs, which would test the wrong thing.
const GONE = 'su-0a0a0a0a-1111-4222-8333-444444444444';
const ADOPTER = 'su-0b0b0b0b-1111-4222-8333-444444444444';
const OTHER = 'su-0c0c0c0c-1111-4222-8333-444444444444';

function tag(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

interface Row {
  feature_id: string;
  workspace_id: string;
  harness_slug: string;
  taken_by: string | null;
  payload: Record<string, unknown> | null;
}

async function row(id: string): Promise<Row> {
  const [r] = await db.adminSql<Row[]>`
    SELECT feature_id, workspace_id, harness_slug, taken_by, payload
      FROM harness_shared.work_items WHERE feature_id = ${id}`;
  if (!r) throw new Error(`no work_items row for ${id}`);
  return r;
}

async function patchReview(id: string, review: Record<string, unknown>, takenBy: string | null = null) {
  await db.adminSql`
    UPDATE harness_shared.work_items
       SET payload = COALESCE(payload, '{}'::jsonb) || ${JSON.stringify({ agentReview: review })}::text::jsonb,
           taken_by = ${takenBy}
     WHERE feature_id = ${id}`;
}

/** An open bug whose round-2 CONTENT revision belongs to GONE (the adoptable class). */
async function contentRevision(t: string, takenBy: string | null = null) {
  const issue = await createIssue({
    kind: 'bug',
    title: `export retries drop the idempotency key ${t}`,
    body: `a retried export is written twice because the retry omits the idempotency key ${t}`,
    scope: 'harness:papercusp',
    createdBy: GONE,
  });
  await patchReview(issue.id, {
    status: 'revision-requested',
    submittedBy: GONE,
    ledgerIdeaId: `idea-${t}`,
    round: 2,
    revisionKind: 'content',
  }, takenBy);
  const r = await row(issue.id);
  return { id: issue.id, harness: r.harness_slug, workspace: r.workspace_id };
}

function adoptDeps() {
  return {
    getWorkItem,
    mergeWorkItemPayload,
    releaseWorkItem,
    claimWorkItem,
    // The adoption comment is not under test; the claim and the rebind are.
    getWorkItemDetail: vi.fn(async () => ({ posts: [] })),
    commentWorkItem: vi.fn(async () => ({})),
    resolveSubmitterLiveness: vi.fn(async (ownerId: string) =>
      ({ sessionState: ownerId === GONE ? 'ended' : 'live' }) as const),
    resolveVerifiedSubmitterAlias: vi.fn(async () => null),
    recordRoutedIdea: vi.fn(),
    resolveLedgerIdeaId: vi.fn(),
    readLedgerGrade: vi.fn(),
    deliverRevision: vi.fn(),
    healOwnNodeOrigin: vi.fn(),
  };
}

async function mintFor(id: string, adopter: string) {
  const r = await row(id);
  const review = readAgentReviewState(r.payload);
  if (!review) throw new Error(`${id} carries no agentReview state`);
  return mintAgentReviewRevisionAdoptionAdmission({ itemId: id, adopter, harnessSlug: r.harness_slug, review });
}

describe('BQL D-008 revision adoption through the real claim writer', () => {
  it('control: the intake floor refuses a plain by-id claim of someone else\'s content revision', async () => {
    const { id, harness } = await contentRevision(tag());
    expect(await claimWorkItem(id, ADOPTER, { harness })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('adopts an unheld orphan content revision: claimed by the adopter and rebound to it', async () => {
    const { id, harness } = await contentRevision(tag());
    const deps = adoptDeps();

    const result = await adoptAgentReviewRevision({ id, adopter: ADOPTER, harnessSlug: harness }, deps as never);

    expect(result).toMatchObject({ adopted: true, brief: { lane: 'revision-adoption', round: 2, previousSubmitter: GONE } });
    const after = await row(id);
    expect(after.taken_by).toBe(ADOPTER);
    expect(after.payload?.agentReview).toMatchObject({ status: 'revision-requested', submittedBy: ADOPTER, round: 2 });
    expect(after.payload?.agentReviewAdoption).toMatchObject({ from: GONE, sessionState: 'ended', adoptedBy: ADOPTER });
    expect(deps.resolveSubmitterLiveness).toHaveBeenCalledWith(GONE, { claimsHeld: false });
  });

  it('adopts a revision still held by its gone submitter through the expected-holder CAS', async () => {
    const { id, harness } = await contentRevision(tag(), GONE);

    const result = await adoptAgentReviewRevision({ id, adopter: ADOPTER, harnessSlug: harness }, adoptDeps() as never);

    expect(result).toMatchObject({ adopted: true });
    const after = await row(id);
    expect(after.taken_by).toBe(ADOPTER);
    expect(after.payload?.agentReview).toMatchObject({ submittedBy: ADOPTER });
  });

  it('refuses a live submitter\'s revision without claiming or rebinding it', async () => {
    const { id, harness } = await contentRevision(tag());
    await patchReview(id, { submittedBy: OTHER, status: 'revision-requested', ledgerIdeaId: 'idea-live', round: 2, revisionKind: 'content' });

    const result = await adoptAgentReviewRevision({ id, adopter: ADOPTER, harnessSlug: harness }, adoptDeps() as never);

    expect(result).toMatchObject({ adopted: false, reason: 'not-submitter' });
    const after = await row(id);
    expect(after.taken_by).toBeNull();
    expect(after.payload?.agentReview).toMatchObject({ submittedBy: OTHER });
  });

  it('refuses a forged plain-object admission', async () => {
    const { id, harness } = await contentRevision(tag());
    const forged = { itemId: id, adopter: ADOPTER, harnessSlug: harness, previousSubmitter: GONE, round: 2 };

    expect(await claimWorkItem(id, ADOPTER, { harness, revisionAdoptionAdmission: forged as never })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('refuses an admission minted for a different adopter', async () => {
    const { id, harness } = await contentRevision(tag());
    const admission = await mintFor(id, OTHER);
    expect(admission).not.toBeNull();

    expect(await claimWorkItem(id, ADOPTER, { harness, revisionAdoptionAdmission: admission! })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('refuses a stale admission once the revision round moves (writer re-derivation)', async () => {
    const { id, harness } = await contentRevision(tag());
    const admission = await mintFor(id, ADOPTER);
    expect(admission).not.toBeNull();
    await patchReview(id, { status: 'revision-requested', submittedBy: GONE, ledgerIdeaId: 'idea-moved', round: 3, revisionKind: 'content' });

    expect(await claimWorkItem(id, ADOPTER, { harness, revisionAdoptionAdmission: admission! })).toBeNull();
    expect((await row(id)).taken_by).toBeNull();
  });

  it('the SQL twin alone refuses a stale admission the writer did not re-check', async () => {
    // claimIssue validates only the admission's identity fields; the revision snapshot is
    // re-checked inside the UPDATE. Bypass claimWorkItem's re-derivation to prove that leg.
    const { id, workspace } = await contentRevision(tag());
    const admission = await mintFor(id, ADOPTER);
    expect(admission).not.toBeNull();
    await patchReview(id, { status: 'revision-requested', submittedBy: GONE, ledgerIdeaId: 'idea-moved', round: 3, revisionKind: 'content' });

    try {
      await claimIssue(id, ADOPTER, { workspaceId: workspace, revisionAdoptionAdmission: admission! });
    } catch {
      /* refused */
    }
    expect((await row(id)).taken_by).toBeNull();

    // Calibration: the same direct call with a CURRENT admission is admitted, so the refusal
    // above is the snapshot check and not some other floor.
    const fresh = await mintFor(id, ADOPTER);
    await claimIssue(id, ADOPTER, { workspaceId: workspace, revisionAdoptionAdmission: fresh! });
    expect((await row(id)).taken_by).toBe(ADOPTER);
  });

  it('does not admit a reproduction-only revision through the adoption leg', async () => {
    const { id } = await contentRevision(tag());
    const r = await row(id);
    const review = readAgentReviewState({
      agentReview: { status: 'revision-requested', submittedBy: GONE, ledgerIdeaId: 'idea-repro', round: 2, revisionKind: 'reproduction' },
    });
    expect(review).not.toBeNull();
    expect(mintAgentReviewRevisionAdoptionAdmission({ itemId: id, adopter: ADOPTER, harnessSlug: r.harness_slug, review: review! })).toBeNull();
  });
});
