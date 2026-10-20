/**
 * Mixed plans at ship (plan-verification-profiles-2026-10-17 P-004, R-11 and SPEC-P-004; D-009).
 *
 * A plan can mix deliverables: an item that declares `deliverable: code` keeps full code
 * verification even inside a `general` plan, whose undeclared items default to non-code.
 * At ship, every non-dropped item with an effective completion-audit entry is resolved under
 * the declarations in force NOW; a code deliverable whose entry has no code/test citation that
 * RESOLVES against the tree refuses with `code_deliverable_unverified`. The refusal names the
 * plan's verification profile and the failing verification module (SPEC-P-004).
 *
 * Plans and items are written through the real projected dispatch against a private
 * (isolated) integration PG. Completion audits are seeded as rows, the same way the sibling
 * escape test seeds activation audits, so each case controls exactly which citations an
 * item carries; the gate under test is the real `evaluatePlanAcceptanceGate`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

// The fixture harness is not in the harness registry (operator state the isolated PG does not
// seed), so it has no registered source root and every repo citation would read as broken.
// Root SELECTION is configuration, not the subject: point it at the canonical repo root through
// the function's own no-harness branch. Citation RESOLUTION against that root stays real.
vi.mock('../../../plan-audits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plan-audits')>();
  return {
    ...actual,
    repoCitationContextForHarness: (_harnessSlug: unknown, citations?: Parameters<typeof actual.repoCitationContextForHarness>[1]) =>
      actual.repoCitationContextForHarness(null, citations),
  };
});
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../new';
import '../add-item';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { evaluatePlanAcceptanceGate } from '../../../plan-acceptance-gate';
import { planItemTextHash } from '../../../plan-audits';
import { runWithWorkspace } from '../../../workspace-als';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-mixship-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
/** A tracked source file every checkout has; a `code` citation to it resolves. */
const REAL_CODE = 'packages/operator-core/lib/plan-acceptance-gate.ts';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let auditSeq = 0;

function ctx(): never {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plans-mixed-plan-ship',
    role: 'su',
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  const d = await dispatchProjectedTool(projected!, tool, { harness: HARNESS, ...args }, ctx(), {});
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (structured && typeof structured === 'object') return structured as Record<string, unknown>;
  const text = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
  if (!text) return { error: d.error ?? null };
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { text };
  }
}

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 1200);
}

/** A plan with P-001 declared `deliverable: code` and P-002 on the profile default. */
async function makePlan(slug: string, profile: 'coding' | 'general'): Promise<void> {
  const created = await call('plans:new', { slug, title: `Mixship ${slug}`, verificationProfile: profile, force: true });
  expect(created?.ok, brief(created)).toBe(true);
  const added = await call('plans:add-item', {
    slug,
    phase: 'Phase 1',
    importance: 'normal',
    items: [{ text: 'Build the exporter', deliverable: 'code' }, { text: 'Write the runbook' }],
  });
  expect(added?.ok, brief(added)).toBe(true);
}

/** The item text the gate fingerprints, read from the same index the gate reads. */
async function itemTexts(slug: string): Promise<Map<string, string>> {
  const rows = await admin<{ item_id: string; item_text: string }[]>`
    SELECT item_id, item_text FROM harness_shared.plan_items
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(rows.length, `plan ${slug} must have indexed items`).toBe(2);
  return new Map(rows.map((r) => [r.item_id, r.item_text]));
}

type Citation = Record<string, unknown>;

/** Seed one completion audit. Each item maps to its verdict and citations. */
async function auditCompletion(slug: string, items: Record<string, { verdict: string; citations: Citation[] }>): Promise<void> {
  const texts = await itemTexts(slug);
  const entries = Object.entries(items).map(([itemId, e]) => ({
    itemId,
    verdict: e.verdict,
    citations: e.citations,
    itemTextHash: planItemTextHash(texts.get(itemId) ?? ''),
    note: e.verdict === 'not-code' ? 'fixture: documentation work' : undefined,
  }));
  auditSeq += 1;
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       items, findings)
    VALUES
      (${WS}, ${HARNESS}, ${slug}, ${auditSeq}, 'su-test', 'completion',
       ${JSON.stringify(entries)}::text::jsonb, '[]'::jsonb)`;
}

async function blockers(slug: string, force?: { reason: string }) {
  const verdict = await runWithWorkspace(WS, () =>
    evaluatePlanAcceptanceGate(slug, { harnessSlug: HARNESS, collectAllBlockers: true, ...(force ? { force } : {}) }));
  expect(verdict.satisfied).toBe(false);
  return { verdict, list: verdict.blockers ?? [] };
}

const WORK_ITEM_CITATION: Citation = { kind: 'work-item', ref: 'WI-MIXSHIP-FIXTURE' };

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
}, 180_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

describe('R-11: a code item inside a general plan keeps code verification at ship', () => {
  it('refuses a general plan whose code item cites only generic evidence, naming the profile and the failing module', async () => {
    const slug = 'zzz-mixship-general-generic-2026-10-20';
    await makePlan(slug, 'general');
    await auditCompletion(slug, {
      'P-001': { verdict: 'partial', citations: [WORK_ITEM_CITATION] },
      'P-002': { verdict: 'implemented', citations: [WORK_ITEM_CITATION] },
    });

    const { list } = await blockers(slug);
    const hit = list.find((b) => b.code === 'code_deliverable_unverified');
    expect(hit, brief(list.map((b) => b.code))).toBeTruthy();
    // Only the declared code item; P-002 is a non-code deliverable under the general profile.
    expect(hit!.message).toContain('1 code deliverable(s)');
    expect(hit!.message).toContain("P-001 (deliverable 'code' from declared");
    expect(hit!.message).not.toContain('P-002 (');
    // SPEC-P-004: the refusal names the verification profile and the failing module.
    expect(hit!.message).toContain("Verification profile 'general' (declared)");
    expect(hit!.message).toContain("failing verification module 'code' (check 'code-truth-audit')");
  });

  it('does not refuse once the code item cites a code file that resolves against the tree', async () => {
    const slug = 'zzz-mixship-general-resolving-2026-10-20';
    await makePlan(slug, 'general');
    await auditCompletion(slug, {
      'P-001': { verdict: 'implemented', citations: [{ kind: 'code', path: REAL_CODE }] },
      'P-002': { verdict: 'implemented', citations: [WORK_ITEM_CITATION] },
    });

    const { list } = await blockers(slug);
    expect(list.map((b) => b.code), brief(list)).not.toContain('code_deliverable_unverified');
  });

  it('a code citation that does not resolve does not count as verification', async () => {
    const slug = 'zzz-mixship-general-unresolved-2026-10-20';
    await makePlan(slug, 'general');
    await auditCompletion(slug, {
      'P-001': { verdict: 'implemented', citations: [{ kind: 'code', path: 'packages/operator-core/lib/no-such-exporter.ts' }] },
      'P-002': { verdict: 'implemented', citations: [WORK_ITEM_CITATION] },
    });

    const { list } = await blockers(slug);
    const codes = list.map((b) => b.code);
    expect(codes, brief(list)).toContain('code_deliverable_unverified');
    expect(codes, brief(list)).toContain('audit_citations_unresolved');
  });
});

describe('R-11 in the coding profile: the same rule, every default item is code', () => {
  it('refuses both the declared and the profile-default code item when neither cites resolving code', async () => {
    const slug = 'zzz-mixship-coding-generic-2026-10-20';
    await makePlan(slug, 'coding');
    await auditCompletion(slug, {
      'P-001': { verdict: 'partial', citations: [WORK_ITEM_CITATION] },
      'P-002': { verdict: 'partial', citations: [WORK_ITEM_CITATION] },
    });

    const { list } = await blockers(slug);
    const hit = list.find((b) => b.code === 'code_deliverable_unverified');
    expect(hit, brief(list.map((b) => b.code))).toBeTruthy();
    expect(hit!.message).toContain('2 code deliverable(s)');
    expect(hit!.message).toContain("P-001 (deliverable 'code' from declared");
    expect(hit!.message).toContain('P-002 (');
    expect(hit!.message).toContain("Verification profile 'coding' (declared)");
  });

  it('force waives it as a code-truth check and records the waiver', async () => {
    const slug = 'zzz-mixship-coding-forced-2026-10-20';
    await makePlan(slug, 'coding');
    await auditCompletion(slug, {
      'P-001': { verdict: 'partial', citations: [WORK_ITEM_CITATION] },
      'P-002': { verdict: 'partial', citations: [WORK_ITEM_CITATION] },
    });

    // Unforced, the same plan refuses (the case above); forced, the check is waived while the
    // acceptance blockers force never touches still refuse. forcedPast.checks itself is
    // pinned by plan-code-audit-gate.test.ts.
    const { list } = await blockers(slug, { reason: 'fixture: waive the code-truth checks' });
    const codes = list.map((b) => b.code);
    expect(codes, brief(list)).not.toContain('code_deliverable_unverified');
    expect(codes.length, brief(list)).toBeGreaterThan(0);
  });
});
