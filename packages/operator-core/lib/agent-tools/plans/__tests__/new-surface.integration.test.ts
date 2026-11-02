/**
 * new-surface.integration.test.ts — plans:new pinned AT THE TOOL SURFACE (WI-10002169).
 *
 * The independent acceptance grader of plan
 * frontier-remediation-work-on-everything-60d3a8-2026-09-20 found two shipped behaviours
 * pinned only BELOW the surface their acceptance bars name:
 *
 *   - R-3 at dedupTokens / findSimilarPlans (new-dedup.test.ts), rather than at a
 *     plans:new refusal that actually carries `similar_exists`;
 *   - R-4 at buildCorrectedCall (libs/generic/tooldef corrected-call.test.ts), rather than
 *     at a plans:new `invalid_input` response.
 *
 * A unit pin proves the PREDICATE, not the seam that makes the predicate observable to a
 * caller: a refactor that keeps `findSimilarPlans` correct while breaking the plans:new
 * wiring (listPlanIndexRows scope, the force gate, the refusal body), or that keeps
 * `buildCorrectedCall` correct while the dispatch stack stops appending its output, passes
 * every lower-level test. So each case here goes through the REAL projected dispatch —
 * `lookupByMcpName('plans:new')` → `dispatchProjectedTool` — against the integration-tier
 * baseline-schema PG (setupPlanPgFixture), never `tool.handler` directly (which would skip
 * the args schema and therefore the whole invalid_input path) and never a mocked index.
 *
 * Every positive case has a CONTROL that would also pass if the behaviour were simply
 * always-on: a refusal that fires on every call proves nothing about overlap detection, and
 * a corrected-call hint that is appended to every refusal proves nothing about unknown keys.
 *
 * Run: npm run test:file -- packages/operator-core/lib/agent-tools/plans/__tests__/new-surface.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
// Importing the tool module is what registers `plans:new` in the projection registry.
import '../new';
import '../add-item';
import '../get';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { setupPlanPgFixture, seedPlan, cleanupPlans, type PlanPgFixture } from './_pg-tool-fixture';
import { BENCHMARK_SCRATCH_PLAN_TOOLS, evaluateSessionConfinement } from '../../../capability-envelope/session-confinement';
import { setSessionConfinementResolver } from '../../../capability-envelope/session-confinement-port';
import * as reuseAuthoring from '../../../code-intelligence/reuse-authoring';
import * as researchTrail from '../../../code-intelligence/research-trail';

const HARNESS = `zzz-newsurf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const WS = DEFAULT_WORKSPACE_ID;

// A deliberately rare three-token topic so the overlap is DISTINCTIVE (findSimilarPlans
// requires >=1 shared non-corpus-generic token) without depending on the rest of the
// baseline DB's contents.
const SEEDED_SLUG = 'zzz-quasar-ledger-reconcile-2026-09-01';
const SEEDED_TITLE = 'Quasar ledger reconcile';
const OVERLAPPING_SLUG = 'zzz-quasar-ledger-reconcile-rework-2026-09-30';
const OVERLAPPING_TITLE = 'Quasar ledger reconcile rework';
const UNRELATED_SLUG = 'zzz-heliotrope-marmalade-2026-09-30';
const UNRELATED_TITLE = 'Heliotrope marmalade';

function seededPlanBody(): string {
  return `---
title: ${SEEDED_TITLE}
slug: ${SEEDED_SLUG}
created: 2026-09-01
updated: 2026-09-01
status: active
---

# ${SEEDED_TITLE}

## Now

**State:** Seeded so plans:new has an existing topic to overlap with.

**Next:** None.

## Decisions
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function ctx(): never {
  return {
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    emit: vi.fn(),
    metadata: vi.fn(),
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plans-new-surface',
    role: 'su',
    isSuperuser: true,
    uiClientId: 'su-private-plan-surface',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

type Dispatched = Awaited<ReturnType<typeof dispatchProjectedTool>>;

/** Dispatch plans:new through the real projected stack, scoped to the throwaway harness. */
async function callNew(args: Record<string, unknown>): Promise<{ d: Dispatched; payload: Record<string, unknown> | null }> {
  const projected = lookupByMcpName('plans:new');
  expect(projected, 'plans:new must be registered in the projection registry').toBeTruthy();
  const d = await dispatchProjectedTool(projected!, 'plans:new', { harness: HARNESS, ...args }, ctx(), {});
  // A refusal the HANDLER returns arrives as tool-result text (isError); a refusal the
  // DISPATCH stack produces (args schema) arrives as `d.error`. Parse whichever is present.
  const content = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content;
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  let payload: Record<string, unknown> | null = null;
  if (structured && typeof structured === 'object') payload = structured as Record<string, unknown>;
  else if (content?.[0]?.text) {
    try {
      payload = JSON.parse(content[0].text) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return { d, payload };
}

/** A small picked summary for assertion messages — vitest truncates long ones. */
function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 700);
}

async function planRowExists(slug: string): Promise<boolean> {
  const rows = await admin<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
  `;
  return Number(rows[0]?.n ?? 0) === 1;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, WS, HARNESS, SEEDED_SLUG, seededPlanBody());
}, 180_000);

afterAll(async () => {
  await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  await fx?.dispose();
});

describe('plans:new similar_exists — at the tool surface (R-3)', () => {
  it('refuses a plan overlapping an existing one with similar_exists + the candidate, and creates NOTHING', async () => {
    const { d, payload } = await callNew({ slug: OVERLAPPING_SLUG, title: OVERLAPPING_TITLE });

    expect(payload?.error, brief({ ok: d.ok, payload, error: d.error })).toBe('similar_exists');
    const candidates = (payload?.candidates ?? payload?.similar ?? []) as Array<{ slug?: string }>;
    expect(
      candidates.map((c) => c.slug),
      brief(payload),
    ).toContain(SEEDED_SLUG);
    // The refusal is a REFUSAL: nothing was written for the proposed slug.
    expect(await planRowExists(OVERLAPPING_SLUG)).toBe(false);
  });

  it('force:true bypasses the refusal and creates the plan', async () => {
    const { d, payload } = await callNew({ slug: OVERLAPPING_SLUG, title: OVERLAPPING_TITLE, force: true });

    expect(payload?.error, brief({ ok: d.ok, payload, error: d.error })).toBeUndefined();
    expect(d.ok, brief({ payload, error: d.error })).toBe(true);
    expect(await planRowExists(OVERLAPPING_SLUG)).toBe(true);
  });

  it('CONTROL — a non-overlapping plan is created WITHOUT force (the refusal is not always-on)', async () => {
    const { d, payload } = await callNew({ slug: UNRELATED_SLUG, title: UNRELATED_TITLE });

    expect(payload?.error, brief({ ok: d.ok, payload, error: d.error })).toBeUndefined();
    expect(d.ok, brief({ payload, error: d.error })).toBe(true);
    expect(await planRowExists(UNRELATED_SLUG)).toBe(true);
  });
});

describe('plans:new invalid_input — at the tool surface (R-4)', () => {
  it('an unrecognized key is refused invalid_input with a CORRECTED CALL that drops it and keeps the rest', async () => {
    const { d } = await callNew({ slug: 'zzz-corrected-call-probe-2026-09-30', title: 'Corrected call probe', bogusKey: true });

    expect(d.ok, brief(d)).toBe(false);
    expect(d.error?.code, brief(d.error)).toBe('invalid_input');
    const message = d.error?.message ?? '';
    // The refusal names the rejected key...
    expect(message, brief(message)).toContain('bogusKey');
    // ...and carries the corrected-call block (the buildCorrectedCall output), which keeps
    // the caller's valid args so the next call can be copied rather than re-derived.
    expect(message, brief(message)).toMatch(/corrected call/i);
    expect(message, brief(message)).toContain('zzz-corrected-call-probe-2026-09-30');
    // Nothing was created by a refused call.
    expect(await planRowExists('zzz-corrected-call-probe-2026-09-30')).toBe(false);
  });

  it('CONTROL — a valid call carries no invalid_input and no corrected-call block', async () => {
    const { d, payload } = await callNew({ slug: 'zzz-control-valid-call-2026-09-30', title: 'Control valid call' });

    expect(d.error?.code, brief({ payload, error: d.error })).not.toBe('invalid_input');
    expect(JSON.stringify(d.error ?? {})).not.toMatch(/corrected call/i);
    expect(d.ok, brief({ payload, error: d.error })).toBe(true);
  });
});

describe('benchmark native planning — maintained plan handlers', () => {
  it('creates a private draft, adds its task and reads it through the real schemas and PostgreSQL', async () => {
    const boundary = { scratchPrefix: 'benchmark-scratch-abc123def456-', reviewedSlug: 'benchmark-observer-private', harness: HARNESS };
    const confinement = { denyTools: [], denyOutside: BENCHMARK_SCRATCH_PLAN_TOOLS, denyPlansOutside: boundary,
      denyAmbientContext: true as const,
      imposedBy: 'benchmark-host', reason: 'private draft planning' };
    setSessionConfinementResolver(() => confinement);
    const reuse = vi.spyOn(reuseAuthoring, 'authoringReuse');
    const research = vi.spyOn(researchTrail, 'suggestResearchAnchors');
    try {
    // Match the native brief's actual argument shape; this is not the harmless
    // execution witness used by the separate persisted-dispatch boundary suite.
    const own = { harness: HARNESS, slug: `${boundary.scratchPrefix}solution-2026-11-02` };
    const create = { ...own, title: 'Private benchmark solution', status: 'draft', force: true };
    expect(evaluateSessionConfinement({ toolName: 'plans:new', args: create, confinement }).allowed).toBe(true);
    const { d, payload } = await callNew(create);
    expect(d.ok, brief({ payload, error: d.error })).toBe(true);
    expect(payload?.error, brief(payload)).toBeUndefined();
    expect(await planRowExists(own.slug)).toBe(true);
    const add = { ...own, phase: 'Phase 1 — Solve', text: 'Inspect the failure and verify the fix', importance: 'normal' };
    expect(evaluateSessionConfinement({ toolName: 'plans:add-item', args: add, confinement }).allowed).toBe(true);
    const added = await dispatchProjectedTool(lookupByMcpName('plans:add-item')!, 'plans:add-item', add, ctx(), {});
    expect(added.ok, brief(added)).toBe(true);
    expect(added.result?.isError, brief(added.result)).not.toBe(true);
    expect(evaluateSessionConfinement({ toolName: 'plans:get', args: own, confinement }).allowed).toBe(true);
    const read = await dispatchProjectedTool(lookupByMcpName('plans:get')!, 'plans:get', own, ctx(), {});
    expect(read.ok, brief(read)).toBe(true);
    const text = JSON.stringify(read.result);
    expect(text).toContain('Inspect the failure and verify the fix');
    expect(text).toContain('draft');
    expect(reuse).not.toHaveBeenCalled();
    expect(research).not.toHaveBeenCalled();
    expect(JSON.stringify(d.result)).not.toContain('reuseAdvice');
    expect(JSON.stringify(added.result)).not.toContain('suggestedAnchors');
    // A frozen-only pass must not hide an accidental blanket removal of advice.
    setSessionConfinementResolver(() => null);
    reuse.mockResolvedValue(undefined);
    research.mockResolvedValue({ anchors: [], manualEntry: true });
    const control = await callNew({ ...create, slug: `${boundary.scratchPrefix}control-2026-11-02` });
    expect(control.d.ok, brief(control)).toBe(true);
    expect(control.payload?.error, brief(control)).toBeUndefined();
    expect(reuse).toHaveBeenCalledOnce();
    expect(research).toHaveBeenCalledExactlyOnceWith(WS, 'su-private-plan-surface', HARNESS);
    } finally {
      reuse.mockRestore(); research.mockRestore(); setSessionConfinementResolver(undefined);
    }
  });
});
