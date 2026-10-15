/**
 * wi10002881-revision-spine-guard.integration.test.ts — every write of plan BYTES leaves a
 * plan_revisions row whose hash matches them, even when the caller wires no revision hook.
 *
 * Incident (2026-09-24T04:02:45Z, plan review-system-rework-reduction-2026-09-23): after
 * plans:add-decision recorded revision 134, the P-031 scope-write cascade restamped the plan's
 * `## Now` BAR-readiness banner through `withPlanLock` with neither `afterWrite` nor
 * `revisionInTransaction`. The plan's current bytes then had NO matching revision, so
 * `plans:audit { phase:'activation' }` refused `plan_revision_unavailable`. Seven earlier bugs
 * fixed this one caller at a time; the guard in `withPlanLock` closes the class.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import {
  withPlanLock,
  REVISION_SPINE_GUARD_AUTHOR,
  TEMPLATE_DATA_LOSS_GUARD_AUTHOR,
} from '../with-plan-lock';
import { listPlanRevisions, planRevisionCapture, type PlanRevisionCtx } from '../revisions';
import { defaultBarReadinessDeps } from '../plan-scope-cascade-deps';
import {
  setupPlanPgFixture,
  cleanupPlans,
  registerHarnessProject,
  type PlanPgFixture,
} from './_pg-tool-fixture';

const HARNESS = `zzz-wi10002881-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

// `draft`, not `active`: a non-template plan entering an activation status is refused by the
// conversation-audit gate, which reports kind:'applied' with a refusal VALUE and writes nothing.
const body = (slug: string, marker: string) => `---
title: ${slug}
slug: ${slug}
status: draft
created: 2026-09-24
updated: 2026-09-24
---

# ${slug}

## Now

**State:** ${marker}
**Next:** ${marker}
`;

const CTX = {
  isSuperuser: true,
  uiClientId: `wi10002881-${Math.random().toString(36).slice(2, 10)}`,
} as unknown as PlanRevisionCtx;

const newSlug = (tag: string) => `zzz-wi10002881-${tag}-${Math.random().toString(36).slice(2, 8)}`;

async function unhookedWrite(slug: string, content: string, intent = 'wi10002881 unhooked write'): Promise<void> {
  const res = await withPlanLock<{ ok: true }>(
    null,
    { slug, intent, harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30 },
    async () => ({ newBody: content, value: { ok: true } }),
  );
  expectWritten(res);
}

/** `kind:'applied'` alone does not prove bytes were written — a gate refusal is also
 *  'applied' with a refusal value — so assert the mutator's own value came back. */
function expectWritten(res: Awaited<ReturnType<typeof withPlanLock<{ ok: true }>>>): void {
  expect(res.kind).toBe('applied');
  expect((res as { value: unknown }).value).toEqual({ ok: true });
}

async function hookedWrite(slug: string, content: string): Promise<void> {
  const rev = planRevisionCapture(CTX, slug, 'hooked write', { harnessSlug: HARNESS });
  const res = await withPlanLock<{ ok: true }>(
    null,
    { slug, intent: 'wi10002881 hooked write', harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30, afterWrite: rev.afterWrite },
    async () => ({ newBody: content, value: { ok: true } }),
  );
  expectWritten(res);
}

interface RevisionRow { seq: number; content_hash: string; author_kind: string; author_id: string; rationale: string | null }

/** Read through the workspace-scoped reader: plan_revisions is RLS-isolated per workspace
 *  (migration 218), so a bare admin SELECT with no workspace context sees no rows. */
async function revisions(slug: string): Promise<RevisionRow[]> {
  const chain = await listPlanRevisions(slug, { harnessSlug: HARNESS, workspaceId: wsId });
  return chain
    .map((r) => ({
      seq: r.seq,
      content_hash: r.contentHash,
      author_kind: r.authorKind,
      author_id: r.authorId,
      rationale: r.rationale,
    }))
    .sort((a, b) => a.seq - b.seq);
}

async function currentHash(slug: string): Promise<string> {
  const [r] = await admin<Array<{ content_hash: string }>>`
    SELECT content_hash FROM harness_shared.harness_plans
     WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return r!.content_hash;
}

/** The invariant plans:audit's activation phase depends on. */
async function expectCurrentBytesHaveRevision(slug: string): Promise<void> {
  const hash = await currentHash(slug);
  expect((await revisions(slug)).some((r) => r.content_hash === hash)).toBe(true);
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
}, 60_000);

beforeEach(async () => {
  await registerHarnessProject(admin, wsId, HARNESS);
});

afterEach(async () => {
  await cleanupPlans(admin, wsId, HARNESS);
});

afterAll(async () => {
  await fx?.dispose();
});

describe('WI-10002881 — the with-plan-lock revision-spine guard', () => {
  it('an unhooked content write records a system revision matching the written bytes', async () => {
    const slug = newSlug('unhooked');
    await unhookedWrite(slug, body(slug, 'one'), 'intent-under-test');
    await unhookedWrite(slug, body(slug, 'two'), 'intent-under-test');

    const rows = await revisions(slug);
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    for (const r of rows) {
      expect(r.author_kind).toBe('system');
      expect(r.author_id).toBe(REVISION_SPINE_GUARD_AUTHOR);
      expect(r.rationale).toMatch(/intent-under-test/);
    }
    await expectCurrentBytesHaveRevision(slug);
  }, 60_000);

  it('the incident path — the scope-write cascade restamp after a hooked write — keeps the spine current', async () => {
    const slug = newSlug('cascade');
    await hookedWrite(slug, body(slug, 'decision recorded'));
    const before = await revisions(slug);
    expect(before).toHaveLength(1);

    const restamped = await defaultBarReadinessDeps(null, 'su-test-actor').restampNow(
      slug,
      { workspaceId: wsId, harnessSlug: HARNESS },
      { state: 'blocked', codes: ['bar_snapshot_proof_missing'], nextRepair: { code: 'bar_snapshot_proof_missing', barKey: 'R-1', action: 'Bind evidence.' } },
      'decision-added',
    );
    expect(restamped).toMatchObject({ stamped: true });

    // P-004 ("note in, note out"): the cascade restamp now writes the Now NOTE column
    // (newBody: null), not plan bytes. The spine guard covers BYTE writes only, so a
    // note-only restamp must leave the content hash — and therefore the spine — exactly
    // as it was: no new revision row, and the current bytes still have their revision.
    // (The unhooked BYTE-write path the guard exists for is pinned by the first test.)
    const after = await revisions(slug);
    expect(after).toHaveLength(before.length);
    expect(after.map((r) => r.content_hash)).toEqual(before.map((r) => r.content_hash));
    await expectCurrentBytesHaveRevision(slug);
  }, 60_000);

  it('a write whose caller wires afterWrite records exactly one revision — the guard does not double-record', async () => {
    const slug = newSlug('hooked');
    await hookedWrite(slug, body(slug, 'hooked'));
    const rows = await revisions(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.author_id).not.toBe(REVISION_SPINE_GUARD_AUTHOR);
    await expectCurrentBytesHaveRevision(slug);
  }, 60_000);

  it('a write whose caller wires revisionInTransaction records exactly one revision', async () => {
    const slug = newSlug('strict');
    const rev = planRevisionCapture(CTX, slug, 'strict write', { harnessSlug: HARNESS });
    expect(rev.inTransaction).toBeDefined();
    const res = await withPlanLock<{ ok: true }>(
      null,
      { slug, intent: 'wi10002881 strict write', harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30, revisionInTransaction: rev.inTransaction! },
      async () => ({ newBody: body(slug, 'strict'), value: { ok: true } }),
    );
    expectWritten(res);
    const rows = await revisions(slug);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.author_id).not.toBe(REVISION_SPINE_GUARD_AUTHOR);
  }, 60_000);

  it('a read-only mutator (newBody null) records nothing', async () => {
    const slug = newSlug('readonly');
    await unhookedWrite(slug, body(slug, 'seed'));
    const res = await withPlanLock<{ ok: true }>(
      null,
      { slug, intent: 'wi10002881 read', harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30 },
      async () => ({ newBody: null, value: { ok: true } }),
    );
    expect(res.kind).toBe('applied');
    expect(await revisions(slug)).toHaveLength(1);
  }, 60_000);

  it('the author constants stay distinct, so the EI-14579 marker and this guard remain separately queryable', () => {
    expect(REVISION_SPINE_GUARD_AUTHOR).not.toBe(TEMPLATE_DATA_LOSS_GUARD_AUTHOR);
  });
});
