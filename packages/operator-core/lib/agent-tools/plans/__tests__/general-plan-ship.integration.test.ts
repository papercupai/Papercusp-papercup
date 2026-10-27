/**
 * General plans at ship (plan-verification-profiles-2026-10-17 P-004, R-10 and R-12; D-002, D-006, D-009).
 *
 * R-10: a `general` plan whose items are non-code deliverables ships on generic evidence alone
 * (work-item / artifact citations). No code/test citation, spec test layer or mutation proof is
 * asked of it. The falsifier is a code-only refusal, so the positive control is the SAME plan and
 * the SAME evidence under the `coding` profile: there every default item is a code deliverable and
 * the ship refuses with `code_deliverable_unverified`.
 *
 * R-12: independent grading stays mandatory for general plans (D-002). A general plan that has an
 * acceptance rubric but no grade is refused with `acceptance_ungraded`; one whose only grade comes
 * from inside its own implementer population is refused with `self_graded_only`.
 *
 * Scope, stated plainly. The R-10 ship cases switch the acceptance-RUBRIC family off through its
 * env override, the same way plan-acceptance-gate-independent-evidence.integration.test.ts does.
 * That family is profile-independent and is exactly what R-12 pins with the flag ON; it is not a
 * code-only reason. The per-plan blind gap review is NOT switched off: each R-10 ship case records
 * a counted review through the real `plans:blind-review` handler, posted by an agent outside the
 * plan's implementer population, so that door is satisfied the way a real plan satisfies it.
 * Everything else in the gate runs for real: the item family, the completion audit, citation
 * resolution, the code-deliverable check and the spec/proof checks. The R-10 ship goes through the
 * real `plans:set-plan-status` handler without `force`, and the positive case asserts the plan is
 * stored as shipped, with no alternative outcome accepted.
 *
 * Plans, items and the rubric are written through the real projected dispatch against a private
 * (isolated) integration PG. Completion audits are seeded as rows, as in the sibling mixed-plan
 * ship test, so each case controls exactly which citations an item carries.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
import '../set-status';
import '../set-plan-status';
import '../audit';
import '../../rubrics/propose';
import blindReviewTool from '../blind-review';
import { emitScorecard } from '../../scorecards/emit';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { evaluatePlanAcceptanceGate } from '../../../plan-acceptance-gate';
import { defaultReadPlanItems, readAcceptanceBarContractSnapshot } from '../../../acceptance-bar-contract-snapshot';
import { resolveVerification } from '../../../plan-verification-profile';
import { hashPlanContent } from '../content-hash';
import { runWithWorkspace } from '../../../workspace-als';
import { getRubric, ensureFirstPartyRubricsSeeded, __resetRubricSeedStateForTests } from '../../../rubrics';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-genship-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const RUBRIC_GATE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_ACCEPTANCE_RUBRIC_COMPLETION_GATE';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let auditSeq = 0;
let prevRubricGateEnv: string | undefined;

function ctx(): never {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plans-general-plan-ship',
    role: 'su',
    // plans:audit and rubrics:propose attribute their writes; an anonymous ctx is refused.
    principal: { kind: 'agent', slug: 'su-genship-author', workspaceId: WS },
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

async function call(
  tool: string,
  args: Record<string, unknown>,
  opts: { withHarness?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  // rubrics:propose declares no `harness` arg and refuses one; every plans:* tool needs it.
  const sent = opts.withHarness === false ? args : { harness: HARNESS, ...args };
  // The MCP transport runs every call inside the caller's workspace ALS; the gate reads
  // activeWorkspaceId(), not ctx.workspaceId.
  const d = await runWithWorkspace(WS, () =>
    dispatchProjectedTool(projected!, tool, sent, ctx(), {}));
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

/** A `results[0]` envelope or a flat result, whichever the tool returned. */
function first(res: Record<string, unknown> | null): Record<string, unknown> {
  const results = (res as { results?: Record<string, unknown>[] } | null)?.results;
  return (Array.isArray(results) && results[0]) || res || {};
}

/**
 * The activation audit refuses a plan without these two sections (plan-declarations.ts),
 * so every fixture plan opts out of both with a reason, as activation-audit-gate does.
 */
const DECLARATION_SECTIONS =
  '\n## Existing infrastructure reused\n\n```reuse\n' +
  '{"searched":[],"reused":[],"newSurfaces":[],"notApplicable":"Test fixture; no code surface."}\n```\n' +
  '\n## Third-party libraries\n\n```libraries\n{"needs":[],"notApplicable":"Test fixture; no library need."}\n```\n';

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 1500);
}

/** A plan with two items on the profile default: non-code under general, code under coding. */
async function makePlan(slug: string, profile: 'coding' | 'general'): Promise<void> {
  const created = await call('plans:new', { slug, title: `Genship ${slug}`, verificationProfile: profile, force: true, content: DECLARATION_SECTIONS });
  expect(created?.ok, brief(created)).toBe(true);
  const added = await call('plans:add-item', {
    slug,
    phase: 'Phase 1',
    importance: 'normal',
    items: [{ text: 'Write the onboarding runbook' }, { text: 'Publish the vendor comparison memo' }],
  });
  expect(added?.ok, brief(added)).toBe(true);
  await auditActivation(slug);
}

/**
 * Record an activation audit over the plan's current content, seeded as a row the way the
 * sibling escape test does. Items on a draft plan cannot start until one exists.
 */
async function auditActivation(slug: string, createdBy = 'su-test'): Promise<void> {
  const [row] = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(row, `plan ${slug} must exist`).toBeTruthy();
  // The real plans:audit also numbers this plan's audits, so take the next free number.
  const [{ next }] = await admin<{ next: number }[]>`
    SELECT COALESCE(MAX(audit_seq), 0)::int + 1 AS next FROM harness_shared.plan_audits
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  auditSeq = Math.max(auditSeq + 1, next);
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${WS}, ${HARNESS}, ${slug}, ${auditSeq}, ${createdBy}, 'activation',
       ${JSON.stringify({ sourceRanges: [], mappings: [], repairedOmissions: [], rejectedOrSuperseded: [], unresolvedBlockers: [] })}::text::jsonb,
       ${auditSeq}, ${auditSeq}, ${hashPlanContent(row!.content)}, '[]'::jsonb, '[]'::jsonb)`;
}

/** Finish both items, through the real item-status handler. */
async function finishItems(slug: string): Promise<void> {
  for (const item of ['P-001', 'P-002']) {
    const res = first(await call('plans:set-status', { slug, item, status: 'done', note: 'fixture: delivered' }));
    expect(res.ok, brief(res)).toBe(true);
  }
}

/** The item text the gate fingerprints, read from the same index the gate reads. */
async function itemTexts(slug: string): Promise<Map<string, string>> {
  const rows = await admin<{ item_id: string; item_text: string }[]>`
    SELECT item_id, item_text FROM harness_shared.plan_items
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(rows.length, `plan ${slug} must have indexed items`).toBe(2);
  return new Map(rows.map((r) => [r.item_id, r.item_text]));
}

/**
 * Record one completion audit, through the real `plans:audit` tool, in which every item cites
 * only generic evidence: an external snapshot. The tool stamps what the ship gate later compares.
 */
async function auditGenericOnly(slug: string, expectOk = true): Promise<Record<string, unknown>> {
  expect((await itemTexts(slug)).size).toBe(2);
  const res = first(await call('plans:audit', {
    slug,
    phase: 'completion',
    items: ['P-001', 'P-002'].map((itemId) => ({
      itemId,
      verdict: 'implemented',
      citations: [{ kind: 'external', url: 'https://example.com/onboarding-runbook', snapshotHash: 'a'.repeat(64) }],
    })),
  }));
  if (expectOk) expect(res.ok, brief(res)).toBe(true);
  return res;
}

/**
 * Refusal families that apply to EVERY plan whatever its verification profile: the acceptance
 * ceremony (rubric, BAR contract, vetting, grading, verdict), blind gap review and independent
 * verification. None of them is a code-only reason.
 */
const PROFILE_INDEPENDENT = new RegExp(
  '^(' +
    [
      'acceptance_rubric_missing', 'acceptance_rubric_ambiguous', 'acceptance_rubric_unvetted',
      'acceptance_rubric_revision_unreadable', 'acceptance_rubric_vetted_after_grading',
      'acceptance_lineage_unreadable', 'acceptance_ungraded', 'self_graded_only', 'acceptance_bar_not_met',
      'acceptance_not_recorded', 'acceptance_bar_contract_not_ready',
    ].join('|') +
    ')$|^(blind_review_|independent_verification_)',
);
// Deliberately NOT listed: `acceptance_unaudited` (no completion audit) is the code-truth
// family despite its prefix, and the coding control below relies on seeing it.

/** An agent outside the plan's implementer population that has never read the plan. */
const BLIND_REVIEWER = 'su-genship-blind-reviewer';

/**
 * Record a counted blind gap review with no gaps for the plan's latest activation audit, through
 * the real `plans:blind-review` handler (the sanctioned writer the ship door reads). Asserts the
 * review counts and satisfies the door, so a later ship refusal cannot be the blind review.
 */
async function recordBlindReview(slug: string): Promise<void> {
  const reviewerCtx = {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    workspaceId: WS,
    principal: { kind: 'agent', slug: BLIND_REVIEWER, workspaceId: WS },
    ownerId: BLIND_REVIEWER,
    coordOwnerId: BLIND_REVIEWER,
  } as never;
  const res = (await runWithWorkspace(WS, () => blindReviewTool.handler(
    { harness: HARNESS, slug, op: 'post', outcome: 'conclusive', gaps: [] } as never, reviewerCtx,
  ))) as { content?: Array<{ text: string }> };
  const posted = JSON.parse(res.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  expect(posted, brief(posted)).toMatchObject({ ok: true, counts: true, door: { satisfied: true } });
}

async function storedStatus(slug: string): Promise<string | null> {
  const [row] = await admin<{ status: string | null }[]>`
    SELECT status FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  return row?.status ?? null;
}

async function ship(slug: string): Promise<Record<string, unknown>> {
  return first(await call('plans:set-plan-status', { slug, status: 'shipped' }));
}

beforeAll(async () => {
  prevRubricGateEnv = process.env[RUBRIC_GATE_ENV];
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
  // In a real process the loadAllRubrics choke point seeds the bundled library on first read;
  // under vitest that auto-hook is guarded off, so drive the ordinary seed pass explicitly. The
  // general plan CLASS rubric the R-12 rubric binds to comes from this seed.
  // Seed inside the fixture workspace: every tool call below runs in WS's ALS, and the seed
  // writes to activeWorkspaceId().
  __resetRubricSeedStateForTests();
  await runWithWorkspace(WS, () => ensureFirstPartyRubricsSeeded());
}, 180_000);

afterEach(() => {
  if (prevRubricGateEnv === undefined) delete process.env[RUBRIC_GATE_ENV];
  else process.env[RUBRIC_GATE_ENV] = prevRubricGateEnv;
});

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

async function blockerCodes(slug: string): Promise<string[]> {
  const verdict = await runWithWorkspace(WS, () =>
    evaluatePlanAcceptanceGate(slug, { harnessSlug: HARNESS, collectAllBlockers: true }));
  return verdict.satisfied ? [] : (verdict.blockers ?? []).map((b) => b.code);
}

describe('R-10: a general plan ships on generic evidence alone', () => {
  it('raises no code-only refusal for a general plan whose items cite only generic evidence', async () => {
    const slug = 'zzz-genship-general-generic-2026-10-20';
    await makePlan(slug, 'general');
    await finishItems(slug);
    await auditGenericOnly(slug);

    // Every check runs (collect mode). Whatever still refuses must be the ceremony every plan
    // owes; the code-truth, citation, spec-layer and proof checks must all pass.
    const codes = await blockerCodes(slug);
    expect(codes.filter((code) => !PROFILE_INDEPENDENT.test(code)), brief(codes)).toEqual([]);
  });

  it('ships once the profile-independent ceremony is out of the way', async () => {
    // The acceptance-rubric family is profile-independent and pinned with the flag ON by R-12,
    // so it is switched off here. The per-plan blind gap review stays ON and is satisfied by a
    // real counted review. Forcing past the code-truth family must not be what lets the plan
    // through, so the ship goes unforced, and it must actually ship.
    process.env[RUBRIC_GATE_ENV] = '0';
    const slug = 'zzz-genship-general-ships-2026-10-20';
    await makePlan(slug, 'general');
    await finishItems(slug);
    await auditGenericOnly(slug);
    await recordBlindReview(slug);

    expect(await blockerCodes(slug)).toEqual([]);
    const res = await ship(slug);
    expect(res.ok, brief(res)).toBe(true);
    expect(await storedStatus(slug)).toBe('shipped');
  });

  it('control: the same plan and evidence under the coding profile is refused for a code-only reason', async () => {
    // Same ceremony switches as the case above (rubric family off, a counted blind review), so
    // the only variable is the profile. Whatever refuses the ship must then be code-only.
    process.env[RUBRIC_GATE_ENV] = '0';
    const slug = 'zzz-genship-coding-generic-2026-10-20';
    await makePlan(slug, 'coding');
    await finishItems(slug);
    await recordBlindReview(slug);
    // Under coding every default item is a code deliverable, so the audit itself refuses
    // generic-only evidence, and the ship refuses for a code-truth reason. Both are code-only,
    // which is what proves the general-plan assertions above can see one.
    const audit = await auditGenericOnly(slug, false);
    expect(audit.ok, brief(audit)).toBe(false);
    expect(brief(audit)).toContain('implemented_without_code');

    const codes = await blockerCodes(slug);
    expect(codes.length, brief(codes)).toBeGreaterThan(0);
    expect(codes.filter((code) => PROFILE_INDEPENDENT.test(code)), brief(codes)).toEqual([]);
    const res = await ship(slug);
    expect(res.ok, brief(res)).not.toBe(true);
    expect(String(res.error ?? res.code ?? ''), brief(res)).not.toMatch(PROFILE_INDEPENDENT);
    expect(String(res.error ?? res.code ?? ''), brief(res)).not.toBe('');
    expect(await storedStatus(slug)).not.toBe('shipped');
  });
});

/**
 * R-10 for a plan WITH requirements (D-010). A requirement BAR carries a test layer, so the ship
 * snapshot grades each BAR clause through the deliverable resolver, fed by the plan's stamped
 * profile and each item's declared deliverable. The projection is pinned in
 * acceptance-bar-contract-snapshot.test.ts; this case pins the half a unit test cannot see: the
 * SQL that reads both values out of real Postgres.
 */
describe('R-10 with requirements: the ship snapshot reads profile and deliverables from Postgres', () => {
  async function makeDeclaredPlan(slug: string, profile: 'coding' | 'general'): Promise<void> {
    const created = await call('plans:new', { slug, title: `Genship ${slug}`, verificationProfile: profile, force: true, content: DECLARATION_SECTIONS });
    expect(created?.ok, brief(created)).toBe(true);
    const added = await call('plans:add-item', {
      slug,
      phase: 'Phase 1',
      importance: 'normal',
      items: [
        { text: 'Write the onboarding runbook' },
        { text: 'Publish the vendor comparison memo', deliverable: 'doc' },
        { text: 'Ship the account import script', deliverable: 'code' },
      ],
    });
    expect(added?.ok, brief(added)).toBe(true);
  }

  async function codeDeliverableByItem(slug: string): Promise<{ profile: string | null; code: Record<string, boolean> }> {
    const snapshot = await runWithWorkspace(WS, () => readAcceptanceBarContractSnapshot(slug, {}, { harnessSlug: HARNESS }));
    expect(snapshot.plan, `snapshot must read plan ${slug}`).toBeTruthy();
    const items = await runWithWorkspace(WS, () => defaultReadPlanItems(snapshot.plan!));
    expect(items.rows.map((row) => row.itemId)).toEqual(['P-001', 'P-002', 'P-003']);
    const code: Record<string, boolean> = {};
    for (const row of items.rows) {
      code[row.itemId] = resolveVerification(
        { verificationProfile: snapshot.plan!.verificationProfile ?? null },
        { deliverable: row.deliverable ?? null },
      ).codeDeliverable;
    }
    return { profile: snapshot.plan!.verificationProfile ?? null, code };
  }

  it('resolves an undeclared item in a general plan as non-code and keeps a declared code item code', async () => {
    const slug = 'zzz-genship-general-reqs-2026-10-20';
    await makeDeclaredPlan(slug, 'general');
    const { profile, code } = await codeDeliverableByItem(slug);
    expect(profile).toBe('general');
    expect(code).toEqual({ 'P-001': false, 'P-002': false, 'P-003': true });
  });

  // CONTROL: the same items under the coding profile. Only the stamped profile differs, so the
  // undeclared item flipping to code proves the read profile (not a constant) drives the verdict.
  it('control: the same items under the coding profile resolve the undeclared item as code', async () => {
    const slug = 'zzz-genship-coding-reqs-2026-10-20';
    await makeDeclaredPlan(slug, 'coding');
    const { profile, code } = await codeDeliverableByItem(slug);
    expect(profile).toBe('coding');
    expect(code).toEqual({ 'P-001': true, 'P-002': false, 'P-003': true });
  });
});

describe('R-12: independent grading stays mandatory for general plans', () => {
  it('refuses a general plan whose acceptance rubric has no non-implementer grade with acceptance_ungraded', async () => {
    delete process.env[RUBRIC_GATE_ENV]; // the shipped default: the rubric family is ON
    const slug = 'zzz-genship-general-ungraded-2026-10-20';
    await makePlan(slug, 'general');
    await finishItems(slug);
    await auditGenericOnly(slug);
    // Precondition: the bundled general CLASS rubric the acceptance rubric binds to is seeded.
    const cls = await runWithWorkspace(WS, () => getRubric('plan-class-general'));
    expect(cls?.kind, 'plan-class-general must be seeded before an acceptance rubric can bind to it').toBe('standard');
    const proposed = first(await call('rubrics:propose', {
      rubricRef: `acceptance-${slug}`,
      kind: 'acceptance',
      subjectPlan: slug,
      classRef: 'plan-class-general',
      characteristic: 'plan-verification-profiles',
      title: `Acceptance for ${slug}`,
      // Class-only: the rubric inherits plan-class-general's criteria (P-006).
      criteria: [],
    }, { withHarness: false }));
    // The rubric must really exist, or the gate stops at acceptance_rubric_missing and this
    // case would prove nothing about grading.
    expect((proposed as { error?: unknown }).error ?? null, brief(proposed)).toBeNull();
    const stored = await runWithWorkspace(WS, () => getRubric(`acceptance-${slug}`));
    expect(stored, `rubric acceptance-${slug}: ${brief(proposed)}`).toMatchObject({
      kind: 'acceptance',
      classRef: 'plan-class-general',
    });

    const codes = await blockerCodes(slug);
    expect(codes, brief(codes)).toContain('acceptance_ungraded');
    // A general plan carries no code deliverable, so nothing code-only joins the refusal.
    expect(codes.filter((code) => !PROFILE_INDEPENDENT.test(code)), brief(codes)).toEqual([]);

    const res = await ship(slug);
    expect(res.ok, brief(res)).not.toBe(true);
    expect(await storedStatus(slug)).not.toBe('shipped');
  });

  // The other half of R-12: a grading by someone inside the plan's own implementer population
  // does not count. scorecards:emit refuses a grader who is ALREADY in that population
  // (grader_in_implementer_lineage), so the way a general plan reaches this state for real is a
  // grader who filed an independent card and later shaped the plan. The gate re-reads the
  // population at ship time, so that card stops counting and the refusal is self_graded_only.
  it('refuses a general plan graded only by its own implementer with self_graded_only', async () => {
    delete process.env[RUBRIC_GATE_ENV]; // the shipped default: the rubric family is ON
    const slug = 'zzz-genship-general-selfgraded-2026-10-20';
    const rubricRef = `acceptance-${slug}`;
    const grader = 'su-genship-grader';
    await makePlan(slug, 'general');
    await finishItems(slug);
    await auditGenericOnly(slug);
    const proposed = first(await call('rubrics:propose', {
      rubricRef,
      kind: 'acceptance',
      subjectPlan: slug,
      classRef: 'plan-class-general',
      characteristic: 'plan-verification-profiles',
      title: `Acceptance for ${slug}`,
      criteria: [],
    }, { withHarness: false }));
    expect((proposed as { error?: unknown }).error ?? null, brief(proposed)).toBeNull();
    const stored = await runWithWorkspace(WS, () => getRubric(rubricRef));
    expect(stored, `rubric ${rubricRef}: ${brief(proposed)}`).toMatchObject({ kind: 'acceptance', classRef: 'plan-class-general' });
    // A class-only rubric stores no criteria of its own; it is graded on the class's criteria.
    const cls = await runWithWorkspace(WS, () => getRubric('plan-class-general'));
    const keys = [...new Set([...(cls?.criteria ?? []), ...(stored?.criteria ?? [])].map((criterion) => criterion.key))];
    expect(keys.length, 'plan-class-general must carry the criteria a general plan is graded on').toBeGreaterThan(0);

    // A complete grading through the real scorecard writer, by an agent outside the lineage.
    const ratings = Object.fromEntries(keys.map((key) => [key, {
      rating: 'pass',
      evidence: `fixture: ${grader} checked ${key} against the plan's cited external snapshot`,
    }]));
    const emitted = await runWithWorkspace(WS, () => emitScorecard(
      { rubricRef, subject: { kind: 'plan', ref: slug }, ratings } as never,
      { createdBy: grader, workspaceId: WS },
    ));
    expect((emitted as { ok?: unknown }).ok, brief(emitted)).toBe(true);

    // CONTROL: while the grader is outside the implementer population its card is the
    // independent grading, so neither grading refusal fires.
    const before = await blockerCodes(slug);
    expect(before, brief(before)).not.toContain('acceptance_ungraded');
    expect(before, brief(before)).not.toContain('self_graded_only');

    // The grader then records an activation audit on the plan, which makes it a plan implementer.
    await auditActivation(slug, grader);

    const codes = await blockerCodes(slug);
    expect(codes, brief(codes)).toContain('self_graded_only');
    expect(codes.filter((code) => !PROFILE_INDEPENDENT.test(code)), brief(codes)).toEqual([]);

    const res = await ship(slug);
    expect(res.ok, brief(res)).not.toBe(true);
    expect(await storedStatus(slug)).not.toBe('shipped');
  });
});
