/**
 * Anti-escape guards for plan verification declarations
 * (plan-verification-profiles-2026-10-17 P-005, R-14 and R-15; D-004, D-008).
 *
 * R-14: after activation, lowering an item's deliverable (code -> non-code, a plan content
 * write) or the plan profile (coding -> general, plans:set-verification-profile) needs a
 * Decision that is ALREADY recorded plus a latest activation audit covering the current
 * revision. Drafts and raising are free.
 *
 * R-15: a closed work item whose plan item resolves to a non-code deliverable may not carry
 * code-change evidence (a filesChanged list, or the `bug` kind). Completion checks it through
 * readNonCodeDeliverableCloseEvidence; ship re-checks every closed work item against the
 * declarations in force at ship time (readNonCodeDeliverableShipEvidence + the gate), which
 * is what catches the EI-25342785339330316 direction: code work relabelled non-code after it
 * closed.
 *
 * Every write goes through the real projected dispatch against a private (isolated)
 * integration PG; activation and audits are seeded with direct rows, as the sibling
 * activation-audit-gate test does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../new';
import '../set-content';
import '../add-item';
import '../add-decision';
import '../set-verification-profile';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { hashPlanContent } from '../content-hash';
import {
  readNonCodeDeliverableCloseEvidence,
  readNonCodeDeliverableShipEvidence,
} from '../../../plan-verification-escape';
import { evaluatePlanAcceptanceGate } from '../../../plan-acceptance-gate';
import { runWithWorkspace } from '../../../workspace-als';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-vescape-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let auditSeq = 0;
const workItemIds: string[] = [];

function ctx(): never {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plans-verification-profile-escape',
    role: 'su',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

type Dispatched = Awaited<ReturnType<typeof dispatchProjectedTool>>;

async function call(tool: string, args: Record<string, unknown>): Promise<{ d: Dispatched; payload: Record<string, unknown> | null }> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  const d = await dispatchProjectedTool(projected!, tool, { harness: HARNESS, ...args }, ctx(), {});
  const content = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  let payload: Record<string, unknown> | null = null;
  if (structured && typeof structured === 'object') payload = structured as Record<string, unknown>;
  else if (content?.[0]?.text) {
    try {
      payload = JSON.parse(content[0].text) as Record<string, unknown>;
    } catch {
      payload = { text: content[0].text };
    }
  }
  return { d, payload };
}

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 900);
}

/** The refusal code, wherever the dispatch envelope put it (depth <= 4). */
function findKey(x: unknown, key: string, depth = 0): unknown {
  if (!x || typeof x !== 'object' || depth > 4) return undefined;
  const rec = x as Record<string, unknown>;
  if (key in rec) return rec[key];
  for (const v of Object.values(rec)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

async function planRow(slug: string): Promise<{ content: string; verification_profile: string | null; verification_profile_source: string | null }> {
  const rows = await admin<{ content: string; verification_profile: string | null; verification_profile_source: string | null }[]>`
    SELECT content, verification_profile, verification_profile_source FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(rows[0], `plan ${slug} must exist`).toBeTruthy();
  return rows[0]!;
}

/** A plan with P-001 declared `deliverable: code` and P-002 on the profile default. */
async function makePlan(slug: string, profile: 'coding' | 'general'): Promise<void> {
  const created = await call('plans:new', { slug, title: `Vescape ${slug}`, verificationProfile: profile, force: true });
  expect(created.payload?.ok, brief({ payload: created.payload, error: created.d.error })).toBe(true);
  const added = await call('plans:add-item', {
    slug,
    phase: 'Phase 1',
    importance: 'normal',
    items: [{ text: 'Build the exporter', deliverable: 'code' }, { text: 'Write the runbook' }],
  });
  expect(added.payload?.ok, brief({ payload: added.payload, error: added.d.error })).toBe(true);
  expect((await planRow(slug)).content).toContain('Build the exporter deliverable: code');
}

/**
 * Mark the plan activated. isPlanActivated treats a recorded activation audit as activation
 * whatever the status column says, and writing `status` directly would make it disagree with
 * the plan markdown (content writes then refuse with plan_status_change_requires_lifecycle_writer).
 * So activation here is the baseline activation audit over the current content.
 */
async function activate(slug: string): Promise<void> {
  await auditActivation(slug);
}

/** Record an activation audit over `content` (default: the plan's current content). */
async function auditActivation(slug: string, content?: string): Promise<void> {
  const body = content ?? (await planRow(slug)).content;
  auditSeq += 1;
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${WS}, ${HARNESS}, ${slug}, ${auditSeq}, 'su-test', 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       ${auditSeq}, ${auditSeq}, ${hashPlanContent(body)}, '[]'::jsonb, '[]'::jsonb)`;
}

async function addDecision(slug: string, title: string, body: string): Promise<string> {
  const res = await call('plans:add-decision', { slug, title, body });
  expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
  const id = findKey(res.payload, 'decisionId') ?? findKey(res.payload, 'id');
  expect(typeof id, brief(res.payload)).toBe('string');
  return id as string;
}

async function lowerP001(slug: string, to = 'doc') {
  const before = await planRow(slug);
  return call('plans:set-content', {
    slug,
    content: before.content.replace('Build the exporter deliverable: code', `Build the exporter deliverable: ${to}`),
  });
}

async function closedWorkItem(slug: string, itemId: string, opts: { kind?: string; filesChanged?: string[] }): Promise<string> {
  const id = `WI-VESC-${RUN}-${workItemIds.length + 1}`;
  workItemIds.push(id);
  const payload = { _completionEvidence: { summary: 'fixture close', filesChanged: opts.filesChanged ?? [] } };
  await admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, status, title, summary,
       source_plan_slug, source_plan_item_ids, payload, created_ts, updated_ts)
    VALUES
      (${WS}, ${HARNESS}, ${id}, ${opts.kind ?? 'feature'}, 'done', 'Vescape fixture', 'Closed fixture.',
       ${slug}, ARRAY[${itemId}]::text[], ${JSON.stringify(payload)}::text::jsonb, 1, 1)`;
  return id;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
}, 180_000);

afterAll(async () => {
  if (admin) {
    if (workItemIds.length > 0) {
      await admin`DELETE FROM harness_shared.work_items WHERE workspace_id = ${WS} AND feature_id = ANY(${workItemIds}::text[])`.catch(() => {});
    }
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

describe('R-14: lowering a deliverable through a content write', () => {
  it('a draft plan may lower a deliverable freely', async () => {
    const slug = 'zzz-vescape-draft-2026-10-20';
    await makePlan(slug, 'coding');
    const res = await lowerP001(slug);
    expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
    expect((await planRow(slug)).content).toContain('Build the exporter deliverable: doc');
  });

  it('an activated plan refuses a lowering with no recorded Decision', async () => {
    const slug = 'zzz-vescape-nodecision-2026-10-20';
    await makePlan(slug, 'coding');
    await activate(slug);
    await auditActivation(slug);
    const res = await lowerP001(slug);
    expect(res.payload?.ok === true, brief(res.payload)).toBe(false);
    expect(findKey(res.payload, 'code'), brief(res.payload)).toBe('verification_lowering_requires_decision');
    expect((await planRow(slug)).content).toContain('Build the exporter deliverable: code');
  });

  it('a recorded Decision is not enough while the activation audit predates it', async () => {
    const slug = 'zzz-vescape-staleaudit-2026-10-20';
    await makePlan(slug, 'coding');
    await activate(slug);
    await auditActivation(slug);
    await addDecision(slug, 'P-001 is documentation work', 'P-001 deliverable changes from code to doc: the exporter already exists.');
    const res = await lowerP001(slug);
    expect(res.payload?.ok === true, brief(res.payload)).toBe(false);
    expect(findKey(res.payload, 'code'), brief(res.payload)).toBe('verification_lowering_requires_fresh_activation_audit');
    expect((await planRow(slug)).content).toContain('Build the exporter deliverable: code');
  });

  it('a recorded Decision plus a fresh activation audit allows the lowering', async () => {
    const slug = 'zzz-vescape-allowed-2026-10-20';
    await makePlan(slug, 'coding');
    await activate(slug);
    await addDecision(slug, 'P-001 is documentation work', 'P-001 deliverable changes from code to doc: the exporter already exists.');
    await auditActivation(slug);
    const res = await lowerP001(slug);
    expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
    expect((await planRow(slug)).content).toContain('Build the exporter deliverable: doc');
  });

  it('raising a deliverable to code needs no Decision on an activated plan', async () => {
    const slug = 'zzz-vescape-raise-2026-10-20';
    await makePlan(slug, 'general');
    const before = await planRow(slug);
    await activate(slug);
    await auditActivation(slug);
    const res = await call('plans:set-content', {
      slug,
      content: before.content.replace('Write the runbook', 'Write the runbook deliverable: code'),
    });
    expect(res.payload?.ok, brief({ payload: res.payload, error: res.d.error })).toBe(true);
    expect((await planRow(slug)).content).toContain('Write the runbook deliverable: code');
  });
});

describe('R-14: lowering the plan profile through plans:set-verification-profile', () => {
  it('an activated plan refuses coding -> general without a decisionId', async () => {
    const slug = 'zzz-vescape-profile-nodecision-2026-10-20';
    await makePlan(slug, 'coding');
    await activate(slug);
    await auditActivation(slug);
    const res = await call('plans:set-verification-profile', { slug, profile: 'general' });
    expect(findKey(res.payload, 'code'), brief(res.payload)).toBe('verification_lowering_requires_decision');
    expect((await planRow(slug)).verification_profile).toBe('coding');
  });

  it('refuses when the activation audit has not reviewed the named Decision', async () => {
    const slug = 'zzz-vescape-profile-stale-2026-10-20';
    await makePlan(slug, 'coding');
    await activate(slug);
    await auditActivation(slug);
    const decisionId = await addDecision(slug, 'This plan is operations work', 'The plan produces runbooks, not code.');
    const res = await call('plans:set-verification-profile', { slug, profile: 'general', decisionId });
    expect(findKey(res.payload, 'code'), brief(res.payload)).toBe('verification_lowering_requires_fresh_activation_audit');
    expect((await planRow(slug)).verification_profile).toBe('coding');
  });

  it('allows the lowering with a recorded Decision and a fresh audit, stamping source declared', async () => {
    const slug = 'zzz-vescape-profile-allowed-2026-10-20';
    await makePlan(slug, 'coding');
    await activate(slug);
    const decisionId = await addDecision(slug, 'This plan is operations work', 'The plan produces runbooks, not code.');
    await auditActivation(slug);
    const res = await call('plans:set-verification-profile', { slug, profile: 'general', decisionId });
    expect(findKey(res.payload, 'ok'), brief(res.payload)).toBe(true);
    const row = await planRow(slug);
    expect(row.verification_profile).toBe('general');
    expect(row.verification_profile_source).toBe('declared');
  });

  it('raising general -> coding needs no Decision', async () => {
    const slug = 'zzz-vescape-profile-raise-2026-10-20';
    await makePlan(slug, 'general');
    await activate(slug);
    await auditActivation(slug);
    const res = await call('plans:set-verification-profile', { slug, profile: 'coding' });
    expect(findKey(res.payload, 'ok'), brief(res.payload)).toBe(true);
    expect((await planRow(slug)).verification_profile).toBe('coding');
  });
});

describe('R-15: code-change evidence under a non-code deliverable', () => {
  const slug = 'zzz-vescape-r15-close-2026-10-20';
  const base = () => ({ workspaceId: WS, harnessSlug: HARNESS, planSlug: slug });

  beforeAll(async () => {
    await makePlan(slug, 'general');
  });

  it('refuses a completion listing filesChanged on a profile-default (non-code) item', async () => {
    const hit = await readNonCodeDeliverableCloseEvidence({
      ...base(),
      planItemIds: ['P-002'],
      filesChanged: ['packages/x/runbook-helper.ts'],
      workItemKind: 'feature',
    });
    expect(hit?.itemId).toBe('P-002');
    expect(hit?.evidence.signals).toEqual(['files-changed']);
    expect(hit?.evidence.profile).toBe('general');
  });

  it('refuses a bug-kind work item on a non-code item (the EI-25342785339330316 direction)', async () => {
    const hit = await readNonCodeDeliverableCloseEvidence({
      ...base(),
      planItemIds: ['P-002'],
      filesChanged: [],
      workItemKind: 'bug',
    });
    expect(hit?.evidence.signals).toEqual(['bug-kind']);
  });

  it('does not treat the promotion kind feature as code evidence', async () => {
    const hit = await readNonCodeDeliverableCloseEvidence({
      ...base(),
      planItemIds: ['P-002'],
      filesChanged: [],
      workItemKind: 'feature',
    });
    expect(hit).toBeNull();
  });

  it('allows code evidence on an item that declares deliverable code', async () => {
    const hit = await readNonCodeDeliverableCloseEvidence({
      ...base(),
      planItemIds: ['P-001'],
      filesChanged: ['packages/x/exporter.ts'],
      workItemKind: 'bug',
    });
    expect(hit).toBeNull();
  });
});

describe('R-15 at ship: a deliverable lowered after a code close is caught', () => {
  it('the ship reader and the gate flag a code close once its item is lowered to non-code', async () => {
    const slug = 'zzz-vescape-r15-ship-2026-10-20';
    await makePlan(slug, 'coding');
    const workItemId = await closedWorkItem(slug, 'P-001', { filesChanged: ['packages/x/exporter.ts'] });
    await closedWorkItem(slug, 'P-002', { filesChanged: [] });

    // While P-001 still declares code, its code close is legitimate.
    expect(await readNonCodeDeliverableShipEvidence({ workspaceId: WS, harnessSlug: HARNESS, planSlug: slug })).toEqual([]);

    // Lower it properly (Decision + fresh audit), after the work item closed with code.
    await activate(slug);
    await addDecision(slug, 'P-001 is documentation work', 'P-001 deliverable changes from code to doc after the fact.');
    await auditActivation(slug);
    const lowered = await lowerP001(slug);
    expect(lowered.payload?.ok, brief({ payload: lowered.payload, error: lowered.d.error })).toBe(true);

    const hits = await readNonCodeDeliverableShipEvidence({ workspaceId: WS, harnessSlug: HARNESS, planSlug: slug });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ itemId: 'P-001', workItemId });
    expect(hits[0]!.evidence.signals).toEqual(['files-changed']);
    expect(hits[0]!.evidence.deliverable).toBe('doc');

    // The gate reads activeWorkspaceId(), not a ctx, so run it inside the fixture workspace.
    const verdict = await runWithWorkspace(WS, () =>
      evaluatePlanAcceptanceGate(slug, { harnessSlug: HARNESS, collectAllBlockers: true }));
    expect(verdict.satisfied).toBe(false);
    const codes = (verdict.blockers ?? []).map((b) => b.code);
    expect(codes, brief(verdict.blockers)).toContain('non_code_deliverable_code_evidence');

    // force waives code-truth evidence checks, never this one.
    const forced = await runWithWorkspace(WS, () =>
      evaluatePlanAcceptanceGate(slug, {
        harnessSlug: HARNESS,
        collectAllBlockers: true,
        force: { reason: 'fixture: force must not waive R-15' },
      }));
    expect((forced.blockers ?? []).map((b) => b.code), brief(forced.blockers)).toContain('non_code_deliverable_code_evidence');
  });
});
