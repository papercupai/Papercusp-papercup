/**
 * OP-BRIEF-P007-PLAN integration layer: plans:get { operationalBrief:true }
 * against a real Postgres plan row. The brief must agree with the plan state
 * in the SAME payload (next item, its status and phase), report blockers only
 * from a complete item graph, and keep a missing baseline (no audit, no
 * acceptance rubric) explicit rather than zero.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import plansGetTool from './get';
import { PLAN_ITEM_KIND, planItemRef } from '../../issue-blocks-merge';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-plan-brief-${RUN}`;
const PLAN = `plan-operational-brief-${RUN}`;
const ACCEPTANCE_PLAN = `plan-operational-brief-acceptance-${RUN}`;
const ACCEPTANCE_RUBRIC = `${ACCEPTANCE_PLAN}-rubric`;

const PLAN_CONTENT = `---
title: Plan operational brief integration
slug: ${PLAN}
status: active
---

# Plan operational brief integration

## Now

State: proving the plan brief.

Next: P-002.

## Work

- **P-001** \`done\` — Build the core.
- **P-002** \`todo\` — Build the brief. blocked-by: P-001
- **P-003** \`todo\` — Verify the brief. blocked-by: P-002

## Decisions

### D-001 — Briefs are projections

Date: 2026-09-22

Project from existing plan state only.
`;

// Blocked-item fixture: every remaining item is blocked, so the brief must
// report a blocked next item — never promote one to "actionable".
const BLOCKED_PLAN = `plan-operational-brief-blocked-${RUN}`;
const BLOCKED_PLAN_CONTENT = `---
title: Plan operational brief blocked fixture
slug: ${BLOCKED_PLAN}
status: active
---

# Plan operational brief blocked fixture

## Now

State: waiting on an external dependency.

Next: P-001.

## Work

- **P-001** \`blocked\` — Wait for the dependency.
- **P-002** \`todo\` — Build on the dependency. blocked-by: P-001
`;

const CTX = {
  isSuperuser: true,
  uiClientId: 'su-plan-operational-brief-integration',
  workspaceId: 'default',
  harnessSlug: HARNESS,
  metadata: vi.fn(),
  log: vi.fn(),
  progress: vi.fn(),
} as never;

// derived-status-not-hand-written-2026-10-12 P-001: the same plan with P-002
// already done — `derivedStatus` must reflect the stored item state at read
// time, never list a finished item as actionable.
const DONE_PLAN = `plan-operational-brief-done-${RUN}`;
const HOLDER = 'su-holder-fixture';
const HELD_WORK_ITEM = `WI-brief-held-${RUN}`;
const FREE_WORK_ITEM = `WI-brief-free-${RUN}`;

// Blind review #14 G-1: the same plan with P-002 blocked by an OPEN engineer issue
// (coord_links rel='blocks'). The returned items and derivedStatus must agree.
const ISSUE_PLAN = `plan-operational-brief-issue-${RUN}`;
const BLOCKING_ISSUE = `EI-brief-block-${RUN}`;
// Blind review #14 G-2: a stored Now note written from content, so no now_updated
// event exists for it. Its staleness is measured from its own writtenAt.
const NOTE_PLAN = `plan-operational-brief-note-${RUN}`;
const NOTE_WRITTEN_AT = '2026-10-12T10:00:00.000Z';

type Field = { status: 'known'; value: unknown; source: string } | { status: 'unknown'; reason: string };
type DerivedStatus = {
  counts: Record<string, number>;
  actionable: Array<{ id: string; heldBy: string[] }>;
  blocked: Array<{ id: string; blockedOn: string[]; external: boolean }>;
  holdersMeasured: boolean;
  latestDecision: { id: string } | null;
  next: { itemId: string | null; reason: string };
  text: string;
};
type BriefResult = {
  items: Array<{ id: string; effectiveStatus: string; phase: string | null }>;
  section?: { heading: string; level: number; body: string } | null;
  acceptanceRubric?: unknown;
  lifecycle?: { verdict: string; acceptance?: { rubricActive: boolean; rubricRef: string | null } };
  derivedStatus?: DerivedStatus;
  now?: {
    state?: string;
    note?: { writtenAt: string; eventId: string | null; source: string };
    staleness?: { noteWrittenAt: string | null; basis: string; transitionsSinceNote: number | null };
  };
  operationalBrief?: {
    schemaVersion: string;
    owner: Field;
    blockers: Field;
    lastVerified: Field;
    nextAction: Field;
    unknowns: string[];
    text: string;
    facts: { nextItem: Field; phase: Field; acceptance: Field; authority: Field };
  };
};

let fx: PlanPgFixture;
let previousWorkspaceId: string | undefined;

beforeAll(async () => {
  previousWorkspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  fx = await setupPlanPgFixture();
  process.env.PAPERCUSP_WORKSPACE_ID = fx.workspaceId;
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, PLAN, PLAN_CONTENT);
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, BLOCKED_PLAN, BLOCKED_PLAN_CONTENT);
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, ACCEPTANCE_PLAN, PLAN_CONTENT.replace(PLAN, ACCEPTANCE_PLAN));
  await seedPlan(
    fx.admin,
    fx.workspaceId,
    HARNESS,
    DONE_PLAN,
    PLAN_CONTENT.replace(PLAN, DONE_PLAN).replace('**P-002** `todo`', '**P-002** `done`'),
  );
  // Linked work items for PLAN: P-002 claimed by HOLDER, P-003 unclaimed.
  for (const [id, itemId, takenBy, status] of [
    [HELD_WORK_ITEM, 'P-002', HOLDER, 'wip'],
    [FREE_WORK_ITEM, 'P-003', null, 'open'],
  ] as const) {
    await fx.admin`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, status, title, summary,
         source_plan_slug, source_plan_item_ids, payload, taken_by, created_ts, updated_ts)
      VALUES
        (${fx.workspaceId}, ${HARNESS}, ${id}, 'feature', ${status}, ${`Fixture ${itemId}`}, 'Fixture.',
         ${PLAN}, ARRAY[${itemId}]::text[],
         ${JSON.stringify({ plan_item: { plan_slug: PLAN, item_id: itemId } })}::text::jsonb,
         ${takenBy}, 1, 1)
    `;
  }
  await fx.admin`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, created, updated,
       owner, archived, template, template_data, template_slug, origin)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${ACCEPTANCE_RUBRIC}, '', md5(${ACCEPTANCE_RUBRIC}), 1, ${ACCEPTANCE_RUBRIC},
       'active', '2026-10-07', '2026-10-07', 'integration-fixture', false, 'rubric',
       ${JSON.stringify({ kind: 'acceptance', subjectPlan: ACCEPTANCE_PLAN })}::text::jsonb, NULL, 'local')
  `;
  // G-1 fixture: an open bug blocks ISSUE_PLAN#P-002 through the issues:link edge shape.
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, ISSUE_PLAN, PLAN_CONTENT.replace(PLAN, ISSUE_PLAN));
  await fx.admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, title, summary, created_ts, updated_ts)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${BLOCKING_ISSUE}, 'bug', 'open', 'Fixture blocking issue', 'Fixture.', 1, 1)
  `;
  await fx.admin`
    INSERT INTO harness_shared.coord_links (workspace_id, src_kind, src_ref, rel, dst_kind, dst_ref)
    VALUES (${DEFAULT_COORD_WORKSPACE}, 'issue', ${BLOCKING_ISSUE}, 'blocks', ${PLAN_ITEM_KIND}, ${planItemRef(ISSUE_PLAN, 'P-002')})
  `;
  // G-2 fixture: a content-sourced stored note with no event id.
  await seedPlan(fx.admin, fx.workspaceId, HARNESS, NOTE_PLAN, PLAN_CONTENT.replace(PLAN, NOTE_PLAN));
  await fx.admin`
    UPDATE harness_shared.harness_plans
       SET now_note = ${JSON.stringify({
         state: 'Stored note state.',
         next: 'P-002.',
         author: null,
         writtenAt: NOTE_WRITTEN_AT,
         eventId: null,
         rationale: null,
         source: 'content',
       })}::text::jsonb
     WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS} AND plan_slug = ${NOTE_PLAN}
  `;
}, 60_000);

afterAll(async () => {
  if (fx) {
    await fx.admin`
      DELETE FROM harness_shared.coord_links
       WHERE workspace_id = ${DEFAULT_COORD_WORKSPACE} AND src_kind = 'issue' AND src_ref = ${BLOCKING_ISSUE}
    `.catch(() => {});
    await fx.admin`
      DELETE FROM harness_shared.work_items WHERE workspace_id = ${fx.workspaceId} AND harness_slug = ${HARNESS}
    `.catch(() => {});
    await cleanupPlans(fx.admin, fx.workspaceId, HARNESS).catch(() => {});
  }
  if (previousWorkspaceId === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = previousWorkspaceId;
  await fx?.dispose();
});

async function read(args: Record<string, unknown>, slug = PLAN): Promise<BriefResult> {
  const out = (await plansGetTool.handler({ slug, harness: HARNESS, ...args } as never, CTX)) as {
    data: { results: BriefResult[] };
  };
  return out.data.results[0]!;
}

describe('plans:get derivedStatus (real PG) — derived-status-not-hand-written-2026-10-12 P-001', () => {
  it('returns derivedStatus by default, computed from item state, with linked holders and the latest decision', async () => {
    const ds = (await read({})).derivedStatus!;
    expect(ds).toBeDefined();
    expect(ds.counts).toMatchObject({ total: 3, done: 1, todo: 1, blocked: 1 });
    expect(ds.actionable).toEqual([expect.objectContaining({ id: 'P-002', heldBy: [HOLDER] })]);
    expect(ds.blocked.map((b) => [b.id, b.blockedOn, b.external])).toEqual([['P-003', ['P-002'], false]]);
    expect(ds.holdersMeasured).toBe(true);
    expect(ds.latestDecision?.id).toBe('D-001');
    expect(ds.next).toMatchObject({ itemId: 'P-002', reason: 'actionable' });
  });

  it('CONTROL: with P-002 stored done, the next read lists P-003 actionable and never P-002', async () => {
    const ds = (await read({}, DONE_PLAN)).derivedStatus!;
    expect(ds.actionable.map((a) => a.id)).toEqual(['P-003']);
    expect(ds.blocked).toEqual([]);
    expect(ds.counts).toMatchObject({ done: 2, todo: 1 });
  });

  it('the operational brief names the next item’s holder from derivedStatus', async () => {
    const brief = (await read({ operationalBrief: true })).operationalBrief!;
    expect(brief.owner).toMatchObject({ status: 'known', value: HOLDER });
  });

  it('CONTROL: an unclaimed next item reports a measured owner of none, not the other plan’s holder', async () => {
    const brief = (await read({ operationalBrief: true }, DONE_PLAN)).operationalBrief!;
    // DONE_PLAN has no linked rows: holders were MEASURED (the enrichment ran) and
    // P-003 has none, so the owner is a known null — "unclaimed" — not unknown.
    expect(brief.owner.status).toBe('known');
    expect(brief.owner).toMatchObject({ value: null });
  });
});

describe('plans:get operationalBrief (real PG)', () => {
  it('omits the brief unless requested', async () => {
    const result = await read({});
    expect(result.operationalBrief).toBeUndefined();
  });

  it('agrees with the same read on next item, status and phase, and keeps a missing baseline explicit', async () => {
    const result = await read({ operationalBrief: true });
    const brief = result.operationalBrief!;
    expect(brief.schemaVersion).toBe('operational-brief-v1');

    expect(brief.facts.nextItem).toMatchObject({ status: 'known', value: { id: 'P-002', reason: 'actionable' } });
    const next = brief.facts.nextItem.status === 'known' ? (brief.facts.nextItem.value as { id: string; effectiveStatus: string }) : null;
    const planItem = result.items.find((item) => item.id === next?.id);
    expect(next?.effectiveStatus).toBe(planItem?.effectiveStatus);
    if (planItem?.phase) {
      expect(brief.facts.phase).toMatchObject({ status: 'known', value: planItem.phase });
    } else {
      expect(brief.facts.phase.status).toBe('unknown');
    }

    expect(brief.blockers).toMatchObject({ status: 'known', value: ['P-003 blocked by P-002'] });
    expect(brief.facts.authority).toMatchObject({ status: 'known', value: { decisionCount: 1 } });
    expect(brief.lastVerified.status).toBe('unknown');
    expect(brief.facts.acceptance).toMatchObject({
      status: 'known',
      value: {
        source: 'acceptanceRubric',
        satisfied: null,
        summary: 'no active acceptance rubric is attached; ship verdict not measured (pass shipReadiness:true)',
      },
      source: 'plans:get.lifecycle.acceptance',
    });
    expect(brief.unknowns).toEqual(expect.arrayContaining(['lastVerified']));
    expect(brief.text).toContain('next: Start P-002');
  });

  it('refuses plan-wide blockers from a narrowed items selection', async () => {
    const result = await read({ operationalBrief: true, items: ['P-002'] });
    expect(result.operationalBrief!.blockers.status).toBe('unknown');
    expect(result.operationalBrief!.facts.nextItem).toMatchObject({ status: 'known', value: { id: 'P-002' } });
  });

  it('reports a blocked next item — never an actionable one — when every remaining item is blocked', async () => {
    const result = await read({ operationalBrief: true }, BLOCKED_PLAN);
    const brief = result.operationalBrief!;

    expect(brief.facts.nextItem).toMatchObject({ status: 'known', value: { id: 'P-001', reason: 'blocked' } });
    const next = brief.facts.nextItem.status === 'known' ? (brief.facts.nextItem.value as { id: string; effectiveStatus: string }) : null;
    expect(next?.effectiveStatus).toBe(result.items.find((item) => item.id === 'P-001')?.effectiveStatus);
    expect(next?.effectiveStatus).toBe('blocked');
    expect(brief.nextAction.status === 'known' && String(brief.nextAction.value).startsWith('Unblock P-001')).toBe(true);
    expect(brief.blockers).toMatchObject({
      status: 'known',
      value: expect.arrayContaining(['P-001 explicitly blocked']),
    });
  });

  it('keeps acceptance state aligned when meta mode omits rubric details', async () => {
    const result = await read({ mode: 'meta', operationalBrief: true }, ACCEPTANCE_PLAN);
    const brief = result.operationalBrief!;

    expect(result.acceptanceRubric).toBeUndefined();
    expect(result.lifecycle?.acceptance).toEqual({ rubricActive: true, rubricRef: ACCEPTANCE_RUBRIC });
    expect(brief.facts.acceptance).toMatchObject({
      status: 'known',
      value: {
        source: 'acceptanceRubric',
        satisfied: null,
        summary: `active acceptance rubric ${ACCEPTANCE_RUBRIC} is attached; criteria details were not included in this read`,
      },
      source: 'plans:get.lifecycle.acceptance',
    });
  });
});

describe('plans:get wiring for blind review #14 (real PG) — derived-status-not-hand-written-2026-10-12 P-016', () => {
  it('G-1: an open-issue block on P-002 reaches derivedStatus, so the summary and next pointer agree with the returned items', async () => {
    const result = await read({}, ISSUE_PLAN);
    const ds = result.derivedStatus!;
    // The returned items carry the issue overlay ...
    expect(result.items.find((item) => item.id === 'P-002')?.effectiveStatus).toBe('blocked');
    // ... and the derived summary must say the same thing, not re-derive P-002 as actionable.
    expect(ds.actionable.map((a) => a.id)).not.toContain('P-002');
    expect(ds.blocked.find((b) => b.id === 'P-002')).toEqual(
      expect.objectContaining({ blockedOn: [BLOCKING_ISSUE], external: true }),
    );
    expect(ds.next.itemId === 'P-002' && ds.next.reason === 'actionable').toBe(false);
    expect(ds.text).not.toMatch(/next:\s*(start\s+)?P-002\b/i);
  });

  it('CONTROL G-1: the same graph without the issue edge keeps P-002 actionable', async () => {
    const ds = (await read({})).derivedStatus!;
    expect(ds.actionable.map((a) => a.id)).toContain('P-002');
    expect(ds.blocked.find((b) => b.id === 'P-002')).toBeUndefined();
  });

  it('G-2: a stored note with no now_updated event is exposed with its identity and aged from its own writtenAt', async () => {
    const result = await read({}, NOTE_PLAN);
    expect(result.now?.state).toContain('Stored note state.');
    expect(result.now?.note).toEqual({ writtenAt: NOTE_WRITTEN_AT, eventId: null, source: 'content' });
    // Before the fix the baseline was the latest now_updated event, which does not exist
    // for a content-written note, so staleness read basis 'note-not-in-event-log'.
    expect(result.now?.staleness).toMatchObject({
      noteWrittenAt: NOTE_WRITTEN_AT,
      basis: 'events-after-note',
      transitionsSinceNote: 0,
    });
  });

  it('G-3: heading Now returns the structured note instead of the frozen content section', async () => {
    const result = await read({ heading: 'Now' }, NOTE_PLAN);

    expect(result.section?.heading).toBe('Now');
    expect(result.section?.body).toContain('Stored note state.');
    expect(result.section?.body).toContain('P-002.');
    expect(result.section?.body).not.toContain('proving the plan brief.');
    expect(result).not.toHaveProperty('now');
  });
});
