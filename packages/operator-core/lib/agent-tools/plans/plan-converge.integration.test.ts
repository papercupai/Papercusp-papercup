/** Recipe controls plus real PostgreSQL evaluator/audit/certifier composition.
 * The condition-upsert integration suite separately exercises the actual filing
 * writer, terminal replay, revision/workspace isolation and concurrent retries. */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProjectedTool } from '@papercusp/tooldef';
import { setupPlanPgFixture, seedPlan, type PlanPgFixture } from './__tests__/_pg-tool-fixture';
import { setSpecClause } from './spec-clauses-store';
import evaluateTool from './evaluate-spec-test-adequacy';
import auditTool from './audit';
import certifyTool from './certify-spec-clauses';
import { validateRecipeBindings } from '../../recipe-contract';
import { DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS } from '../../output-envelope';
import { PAPERCUSP_WORKSPACE_ID } from '../../harness/papercusp-workspace';
import { bindSpecEvidence, measureRepoFilesEvidenceDetailedAtCommit } from './spec-evidence-store';
import { createOneWorkItem } from '../work_items/_create-core';
import { parseTestRunExecutionDetails, type TestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { resolveLocalRubric } from '../../cupboard/rubric-store';
import { provisionPinnedRubric } from '../../rubrics';
import { validateRecipeScriptAgainstCatalog } from '../recipes/recipe-schema-validation';
import { runToolOrchestration } from '@papercusp/agent-mcp';
import { bindCurrentCallerDispatch } from '../orchestration/current-caller-dispatch';

// Fix external class/root metadata for the isolated baseline. Clause/evidence
// reads and all three handlers use their real production SQL and file measurers.
vi.mock('../../harness-registry', async original => ({
  ...(await original<typeof import('../../harness-registry')>()),
  loadHarnessRegistry: async () => ({ projects: [{ slug: 'papercusp',
    path: fileURLToPath(new URL('../../../../../', import.meta.url)) }] }),
}));
vi.mock('../../rubrics', async original => ({
  ...(await original<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: async () => [{ rubricId: 'converge-acceptance', classRef: 'plan-class-feature-ship' }],
  getRetiredAcceptanceRubricsForPlan: async () => [],
}));
// A written spec-test-adequacy card triggers the detached grading-integrity
// dispatcher, which launches a real auditor agent. Keep that outward effect out
// of the disposable database test; the call itself is the observable that a
// card was actually persisted (same seam as frozen-tests-gate.integration).
const auditDispatch = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../grading-integrity', async original => ({
  ...(await original<typeof import('../../grading-integrity')>()),
  dispatchPendingGradingAudits: async () => { auditDispatch.calls += 1; return { requestedTargetIds: [], receipts: [] }; },
}));
const script = readFileSync(new URL('./fixtures/plan-converge.recipe.txt', import.meta.url), 'utf8');
const bindingSchema = JSON.parse(readFileSync(new URL('./fixtures/plan-converge.bindings.json', import.meta.url), 'utf8'));
const auditItems = [{ itemId: 'P-003', verdict: 'implemented', citations: [
  { kind: 'test', path: 'packages/operator-core/lib/agent-tools/plans/plan-converge.integration.test.ts' },
] }];
type Body = Record<string, any>;
function execute(tools: Body, inputs: Body = {}) {
  const bindings = { values: { planSlug: 'converge-pg', harness: 'papercusp', classRef: 'plan-class-feature-ship', auditItems, ...inputs } };
  const checked = validateRecipeBindings({ schema: bindingSchema, bindings });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  return vm.runInNewContext(`(async () => {\n${script}\n})()`, { tools, inputs: checked.value.inputs }) as Promise<Body>;
}
function controls(rows: Body[], options: { audit?: Body; certify?: Body; filed?: Body } = {}) {
  // Typed as the recipe sees it (an untyped tool envelope), so a case can resolve a
  // deliberately malformed body — e.g. `{ ok: true }` with no rows — without a mock cast.
  const evaluate = vi.fn(async (_args: Body): Promise<Body> => ({ ok: true, rows }));
  const audit = vi.fn(async () => options.audit ?? { ok: true });
  const certify = vi.fn(async (_args: Body) => options.certify ?? { ok: true, counts: { filed: 0 } });
  const create = vi.fn(async () => options.filed ?? { ok: true, results: [{ ok: true, id: 'WI-gap', workItem: { id: 'WI-gap', assignee: 'converge-owner' } }] });
  const tools = { plans: { evaluateSpecTestAdequacy: evaluate, audit, certifySpecClauses: certify },
    coord: { whoami: async () => ({ ownerId: 'converge-owner' }) }, workItems: { create } };
  return { tools, evaluate, audit, certify, create };
}
const row = (overrides: Body = {}) => ({ specId: 'SPEC-A', specRevision: 3, planItemId: 'P-003', verdict: 'unknown', wouldBlock: ['falsifiability'], ...overrides });

describe('converge recipe controls (not PostgreSQL proof)', () => {
  it('classifies gaps through the actual dispatch wrapper without certifying after a stopped evaluation', async () => {
    const c = controls([row(), row({ specId: 'SPEC-PASS', verdict: 'pass', wouldBlock: [] })]);
    const calls: string[] = [];
    const tool = (name: string, effect: 'read' | 'write', handler: (args: Body) => Promise<Body>): ProjectedTool => ({
      pluginName: 'converge-dispatch-regression', description: name,
      inputSchema: { type: 'object' }, capabilities: [], effect, expose: { mcp: { name } },
      fn: async args => {
        calls.push(name);
        return { content: [{ type: 'text', text: JSON.stringify(await handler(z.record(z.string(), z.unknown()).parse(args))) }] };
      },
    });
    const result = await runToolOrchestration(script, {
      ctx: { workspaceId: 'converge-dispatch-fixture', harnessSlug: 'papercusp', role: 'su',
        isSuperuser: true, log: vi.fn(), progress: vi.fn(), emit: vi.fn() } as never,
      deps: {}, inputs: { planSlug: 'converge-pg', harness: 'papercusp',
        classRef: 'plan-class-feature-ship', auditItems },
      tools: [tool('plans:audit', 'read', () => c.audit()),
        tool('plans:certify-spec-clauses', 'write', args => c.certify(args)),
        tool('plans:evaluate-spec-test-adequacy', 'read', args => c.evaluate(args))],
      wrapDispatch: bindCurrentCallerDispatch,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, summary: { ok: true, nonPassing: 1 } });
    expect(calls).toEqual(['plans:audit', 'plans:certify-spec-clauses', 'plans:evaluate-spec-test-adequacy']);
    expect(c.certify).toHaveBeenCalledOnce();
    expect(c.create).not.toHaveBeenCalled();
  });
  it('passes preflight against the current evaluator, audit and certifier output schemas', async () => {
    const catalog = [evaluateTool, auditTool, certifyTool].map((tool): ProjectedTool => ({
      pluginName: 'converge-preflight',
      description: tool.name,
      inputSchema: z.toJSONSchema(tool.args as z.ZodType),
      outputJsonSchema: z.toJSONSchema(tool.result as z.ZodType),
      capabilities: [],
      expose: { mcp: { name: tool.name } },
      fn: (async () => ({ content: [] })) as never,
    }));
    expect(await validateRecipeScriptAgainstCatalog(script, catalog)).toMatchObject({
      ok: true,
      issues: [],
    });
  });
  it('refuses missing classification rows without filing gaps or retrying certification', async () => {
    const c = controls([]);
    c.evaluate.mockResolvedValueOnce({ ok: true });
    expect(await execute(c.tools)).toMatchObject({ ok: false, phase: 'evaluate' });
    expect(c.audit).toHaveBeenCalledOnce();
    expect(c.certify).toHaveBeenCalledOnce();
    expect(c.create).not.toHaveBeenCalled();
  });
  it('defaults to an actually executed read-only audit/certifier preview', async () => {
    const c = controls([row(), row({ specId: 'SPEC-PASS', verdict: 'pass', wouldBlock: [] })]);
    expect(await execute(c.tools)).toMatchObject({ ok: true, dryRun: true, nonPassing: 1,
      gaps: [{ classification: 'major', action: 'would-file' }] });
    expect(c.audit).toHaveBeenCalledWith(expect.objectContaining({ phase: 'completion', dryRun: true, items: auditItems }));
    expect(c.evaluate.mock.calls[0][0]).not.toHaveProperty('planItemIds');
    expect(c.certify).toHaveBeenCalledWith(expect.objectContaining({ planItemIds: ['P-003'], dryRun: true }));
    expect(c.create).not.toHaveBeenCalled();
  });
  it('preserves existing-card refusal unless the caller explicitly acknowledges it', async () => {
    const c = controls([row()]);
    c.certify.mockImplementation(async args => args.acknowledgeExisting === true
      ? { ok: true, counts: { filed: 0, refused: 0 } }
      : { ok: false, counts: { refused: 1 }, error: 'existing_independent_scorecards' });
    expect(await execute(c.tools)).toMatchObject({ ok: false, phase: 'certify' });
    expect(await execute(c.tools, { acknowledgeExisting: true }))
      .toMatchObject({ ok: true, dryRun: true, nonPassing: 1 });
    expect(c.certify.mock.calls.map(([args]) => args.acknowledgeExisting)).toEqual([false, true]);
    expect(c.evaluate).toHaveBeenCalledOnce();
    expect(c.create).not.toHaveBeenCalled();
  });
  it('keeps critical/major/minor/outdated distinct and maps outdated to the existing issue vocabulary', async () => {
    for (const [blockers, verdict, classification, severity] of [
      [['falsifiability'], 'missing', 'critical', 'critical'],
      [['falsifiability'], 'implemented', 'major', 'major'],
      [['traceability'], 'implemented', 'minor', 'minor'],
      [['freshness'], 'implemented', 'outdated', 'minor'],
    ] as const) {
      const c = controls([row({ wouldBlock: [...blockers] })]);
      const result = await execute(c.tools, { dryRun: false, auditItems: [{ ...auditItems[0], verdict }] });
      expect(result).toMatchObject({ ok: true, gaps: [{ classification, severity, id: 'WI-gap' }] });
      expect(c.create).toHaveBeenCalledWith(expect.objectContaining({ severity, assign_to: 'converge-owner',
        conditionReplay: 'include-terminal', conditionKey: 'spec-gap:papercusp/converge-pg/SPEC-A@3',
        links: [{ rel: 'about', target_kind: 'plan', target_ref: 'converge-pg', target_harness: 'papercusp' }] }));
    }
  });
  it('does not certify passing tests when the reviewed implementation is incomplete', async () => {
    const c = controls([row({ verdict: 'pass', wouldBlock: [] })]);
    expect(await execute(c.tools, { dryRun: false, auditItems: [{ itemId: 'P-003', verdict: 'partial' }] }))
      .toMatchObject({ ok: true, nonPassing: 1, gaps: [{ blockers: ['code-truth'] }] });
    expect(c.certify).not.toHaveBeenCalled();
    const stale = controls([row({ wouldBlock: ['freshness', 'falsifiability', 'plan-class-risk-floor'],
      ratings: { freshness: { rating: 'fail' } }, measurementEvidence: { selectedBindings: 1 } })]);
    expect(await execute(stale.tools)).toMatchObject({ ok: true, gaps: [{ classification: 'outdated' }] });
    const unbound = controls([row({ wouldBlock: ['freshness', 'falsifiability'],
      ratings: { freshness: { rating: 'fail' } }, measurementEvidence: { selectedBindings: 0 } })]);
    expect(await execute(unbound.tools)).toMatchObject({ ok: true, gaps: [{ classification: 'major' }] });
    const unreviewed = controls([row({ planItemId: 'P-004', verdict: 'pass', wouldBlock: [] })]);
    expect(await execute(unreviewed.tools)).toMatchObject({ ok: true, nonPassing: 1, gaps: [{ blockers: ['code-truth'] }] });
  });
  it('refuses partial audits, certification failures, invalid identity and unaccountable filings', async () => {
    const partial = controls([row()], { audit: { ok: true, partial: true, rejectedItemIds: ['P-003'] } });
    expect(await execute(partial.tools)).toMatchObject({ ok: false, phase: 'code-truth' });
    expect(partial.create).not.toHaveBeenCalled(); expect(partial.certify).not.toHaveBeenCalled();
    const cert = controls([row()], { certify: { ok: false, error: 'replay_failed' } });
    expect(await execute(cert.tools)).toMatchObject({ ok: false, phase: 'certify' });
    expect(cert.evaluate).not.toHaveBeenCalled();
    const refused = controls([row()], { certify: { ok: true, counts: { refused: 1 } } });
    expect(await execute(refused.tools)).toMatchObject({ ok: false, phase: 'certify' });
    expect(refused.create).not.toHaveBeenCalled();
    const identity = controls([row({ specRevision: 0 })]);
    expect(await execute(identity.tools)).toMatchObject({ ok: false, error: 'invalid_clause_identity' });
    const owner = controls([row()], { filed: { ok: true, results: [{ ok: true, workItem: { id: 'WI-unclaimed' } }] } });
    expect(await execute(owner.tools, { dryRun: false })).toMatchObject({ ok: false, phase: 'file' });
    const links = controls([row()], { filed: { ok: true, results: [{ ok: true,
      workItem: { id: 'WI-unlinked', assignee: 'converge-owner' }, inlineLinkWarnings: ['link refused'] }] } });
    expect(await execute(links.tools, { dryRun: false })).toMatchObject({ ok: false, phase: 'file' });
  });
  it('keeps every return within the orchestrate:run summary budget and counts what it omits', async () => {
    // A live preview on a real plan returned 2237 chars and orchestrate:run refused it.
    const bulky = 'x'.repeat(5000);
    const many = Array.from({ length: 12 }, (_, i) => row({ specId: `SPEC-${i}` }));
    const big = controls(many, { audit: { ok: true, preview: true, itemsAuditedThisPass: 1, detail: bulky },
      certify: { ok: true, counts: { clauses: 12, filed: 0, notPassing: 12 }, rows: bulky } });
    const preview = await execute(big.tools);
    expect(preview).toMatchObject({ ok: true, nonPassing: 12, gapsOmitted: 7, byClassification: { major: 12 },
      audit: { preview: true, itemsAuditedThisPass: 1 }, certification: { counts: { clauses: 12 } } });
    expect(preview.gaps).toHaveLength(5);
    expect(JSON.stringify(preview).length).toBeLessThanOrEqual(DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS);
    const failing = controls(many, { certify: { ok: false, error: bulky } });
    const refused = await execute(failing.tools);
    expect(refused).toMatchObject({ ok: false, phase: 'certify' });
    expect(JSON.stringify(refused).length).toBeLessThanOrEqual(DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS);
  });
  it('fits a realistic worst case by measuring the serialized return, never by row count alone', async () => {
    // The second live preview (real plan: long AUTO-BAR spec ids, several blockers per row,
    // object-valued audit/certifier fields) returned 1676 chars after the row cap of five.
    expect(script).toContain(`const SUMMARY_BUDGET = ${DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS};`);
    const nested = { detail: 'y'.repeat(3000), rows: Array.from({ length: 40 }, (_, i) => ({ i, note: 'z'.repeat(50) })) };
    const blockers = ['falsifiability', 'freshness', 'traceability', 'reachability', 'oracle'];
    const longRows = Array.from({ length: 31 }, (_, i) => row({
      specId: `AUTO-BAR-R-${String(i).padStart(2, '0')}-P-031-spec-driven-tooling-integration-clause`,
      wouldBlock: blockers }));
    const worst = controls(longRows, { audit: { ok: true, preview: nested, itemsAuditedThisPass: 1 },
      certify: { ok: true, counts: { clauses: 31, filed: 0, notPassing: 31, byReason: nested } } });
    for (const dryRun of [true, false]) {
      const result = await execute(worst.tools, { dryRun });
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS);
      expect(result).toMatchObject({ ok: true, nonPassing: 31, byClassification: { major: 31 } });
      expect(result.gaps.length).toBeGreaterThan(0);
      expect(result.gaps.length + result.gapsOmitted).toBe(31);
    }
    const refusedWorst = await execute(controls(longRows, { certify: { ok: false, error: nested, counts: nested } }).tools);
    expect(JSON.stringify(refusedWorst).length).toBeLessThanOrEqual(DEFAULT_OUTPUT_SUMMARY_BUDGET_CHARS);
    expect(refusedWorst).toMatchObject({ ok: false, phase: 'certify' });
  });
});

// Reuse the exact identities in two independent databases. This catches both
// retained clause revisions and the fixed proof WI leaking between runs.
describe.each([1, 2])('converge real PostgreSQL composition (isolated run %i)', () => {
  let fx: PlanPgFixture;
  let previousWorkspaceId: string | undefined;
  const slug = 'converge-real-pg-fixture';
  const ctx = { isSuperuser: true, uiClientId: 'su-converge-pg', ownerId: 'su-converge-pg',
    workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: 'papercusp', log: () => {}, metadata: () => {},
    dispatchTool: (name: string, args: Body) => replayDispatch(name, args) } as never;
  const call = async (tool: typeof evaluateTool | typeof auditTool | typeof certifyTool, args: Body) =>
    (await tool.handler(tool.args.parse(args) as never, ctx) as { data: Body }).data;
  // Production ctx.dispatchTool re-enters the tool registry. scorecards:emit uses
  // it to replay the evaluator before persisting any spec-test-adequacy card, and
  // refuses the card outright without it. Route that replay to the same real
  // evaluator handler, so the certifier's actual writer path runs end to end.
  // Like the real dispatcher, consume transport-level args (payloadTier,
  // projection, view) before the tool's own strict schema sees the call.
  const replayDispatch = async (name: string, args: Body) => {
    if (name !== 'plans:evaluate-spec-test-adequacy') throw new Error(`unexpected nested dispatch: ${name}`);
    const { payloadTier: _tier, projection: _projection, view: _view, ...toolArgs } = args;
    return evaluateTool.handler(evaluateTool.args.parse(toolArgs) as never, ctx);
  };
  beforeAll(async () => {
    // setup-hermetic-env clears inherited workspace pins so tests cannot leak a
    // fleet runner's scope. This fixture intentionally seeds the operator-home
    // sentinel below; pin the same scope while the real handlers read it.
    previousWorkspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = PAPERCUSP_WORKSPACE_ID;
    fx = await setupPlanPgFixture({ isolated: true });
    expect(await fx.admin`SELECT spec_id FROM harness_shared.plan_spec_clauses
      WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = 'papercusp' AND plan_slug = ${slug}`)
      .toHaveLength(0);
    expect(await fx.admin`SELECT feature_id FROM harness_shared.work_items
      WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND feature_id = 'WI-CONVERGE-PROOF'`)
      .toHaveLength(0);
    // The certifier writes through scorecards:emit, which resolves its own
    // spec-test-adequacy rubric from the workspace store. Seed the bundled
    // production rubric into this disposable database so this composition test
    // exercises that real writer path rather than a missing-rubric refusal.
    const adequacyRubric = resolveLocalRubric('spec-test-adequacy');
    expect(adequacyRubric).not.toBeNull();
    await provisionPinnedRubric(adequacyRubric!, PAPERCUSP_WORKSPACE_ID);
    // Operator-home scope intentionally resolves to PAPERCUSP_WORKSPACE_ID.
    // Seed that same key rather than the generic fixture's default workspace.
    await seedPlan(fx.admin, PAPERCUSP_WORKSPACE_ID, 'papercusp', slug,
      `---\nslug: ${slug}\ntitle: Converge fixture\nstatus: active\n---\n# Converge fixture\n\n## Tasks\n\n- **P-003** \`todo\` Reject unproved completion.\n`);
    await fx.admin`INSERT INTO harness_shared.plan_items
      (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status)
      VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${slug}, 'P-003', 0, 'Reject unproved completion.', 'todo')
      ON CONFLICT (workspace_id, harness_slug, plan_slug, item_id) DO NOTHING`;
    const written = await setSpecClause({ harnessSlug: 'papercusp', planSlug: slug, specId: 'SPEC-UNBOUND',
      expectedRevision: 0, planItemId: 'P-003', behavior: 'Reject completion without measured proof.',
      behaviorClass: 'boundary', requiredEvidence: ['real PostgreSQL row'], requiredTestLayers: ['integration'],
      lifecycleStatus: 'active', acceptanceRef: 'fixture-accepted', actorId: 'su-converge-pg',
      falsifier: { observation: 'Unproved completion succeeds.', probeMethod: 'Attempt completion without proof.' } });
    expect(written, JSON.stringify(written)).toMatchObject({ status: 'created' });
  }, 120_000);
  afterAll(async () => {
    await fx?.dispose();
    if (previousWorkspaceId === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = previousWorkspaceId;
  }, 30_000);
  it('reads a persisted unbound clause through all three real handlers and writes no gap in default preview', async () => {
    const evaluate = vi.fn((args: Body) => call(evaluateTool, args));
    const audit = vi.fn((args: Body) => call(auditTool, args));
    const certify = vi.fn((args: Body) => call(certifyTool, args));
    const create = vi.fn();
    const result = await execute({ plans: { evaluateSpecTestAdequacy: evaluate, audit, certifySpecClauses: certify },
      workItems: { create } }, { planSlug: slug });
    expect(result).toMatchObject({ ok: true, dryRun: true, evaluated: 1, nonPassing: 1,
      gaps: [{ specId: 'SPEC-UNBOUND', revision: 1, classification: 'major', action: 'would-file' }] });
    expect(audit).toHaveBeenCalledOnce(); expect(certify).toHaveBeenCalledOnce();
    expect(result.audit).toMatchObject({ preview: true, itemsAuditedThisPass: 1 });
    expect(result.certification.counts).toMatchObject({ clauses: 1, filed: 0, notPassing: 1 });
    expect(create).not.toHaveBeenCalled();
    const rows = await fx.admin`SELECT feature_id FROM harness_shared.work_items
      WHERE payload->'specConformanceGap'->>'planSlug' = ${slug}`;
    expect(rows).toHaveLength(0);
  }, 120_000);

  it('files only non-passing persisted clauses, preserves passing proof and reuses the exact revision on a second run', async () => {
    const root = fileURLToPath(new URL('../../../../../', import.meta.url));
    const testPath = 'packages/operator-core/lib/agent-tools/plans/plan-converge.integration.test.ts';
    const measurement = { schemaVersion: 1 as const, kind: 'repo-files' as const,
      sourcePaths: ['packages/operator-core/lib/agent-tools/plans/fixtures/plan-converge.recipe.txt'],
      testPaths: [testPath], fixturePaths: ['packages/operator-core/lib/agent-tools/plans/fixtures/plan-converge.bindings.json'] };
    // The real reader measures committed repository bytes. Match its input
    // contract instead of binding mutable working-tree hashes as current proof.
    const commitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const measured = await measureRepoFilesEvidenceDetailedAtCommit(root, measurement, commitSha);
    // This ledger is fixture INPUT, not a claimed test run. Production evidence
    // reads must distinguish its pass/fail outcomes and stale measured bytes.
    await fx.admin`INSERT INTO harness_shared.work_items
      (feature_id, workspace_id, harness_slug, title, status, item_kind, payload, created_ts)
      VALUES ('WI-CONVERGE-PROOF', ${PAPERCUSP_WORKSPACE_ID}, 'papercusp', 'Proof fixture', 'open', 'feature', '{}', 0)`;
    for (const [specId, itemId, status, stale] of [
      ['SPEC-PASS', 'P-004', 'pass', false], ['SPEC-FAIL', 'P-005', 'fail', false],
      ['SPEC-STALE', 'P-006', 'pass', true],
    ] as const) {
      await fx.admin`INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status)
        VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${slug}, ${itemId}, ${Number(itemId.slice(2))}, ${specId}, 'todo')`;
      expect(await setSpecClause({ harnessSlug: 'papercusp', planSlug: slug, specId, expectedRevision: 0,
        planItemId: itemId, behavior: `Observe ${specId} through the real evaluator.`, behaviorClass: 'boundary',
        requiredEvidence: ['integration'], requiredTestLayers: ['integration'], lifecycleStatus: 'active',
        acceptanceRef: 'fixture-accepted', actorId: 'su-converge-pg',
        falsifier: { observation: 'The wrong proof outcome passes.', probeMethod: 'Read the persisted test outcome.' } }))
        .toMatchObject({ status: 'created' });
      const execution: TestRunExecutionDetails = { schemaVersion: 1, root, filePath: testPath,
        runGroupId: null, workspaceId: PAPERCUSP_WORKSPACE_ID, harnessSlug: 'papercusp',
        testNamePattern: null, testLayer: 'integration', mutationPhase: null, commitSha, worktreeDirty: false,
        ...(status === 'pass' ? { passedCaseTitles: ['persisted proof fixture'] } : { failedCaseTitles: ['persisted proof fixture'] }),
        passed: status === 'pass' ? 1 : 0, failed: status === 'fail' ? 1 : 0, skipped: 0, collectionFailed: false };
      // Validate fixtures with the very parser the evidence reader consumes;
      // incomplete status-only rows must never masquerade as passing proof.
      expect(parseTestRunExecutionDetails(execution)).toEqual(execution);
      const [run] = await fx.admin`INSERT INTO harness_shared.test_runs
        (workspace_id, harness_slug, file_path, framework, status, source, commit_sha, worktree_dirty, execution_details)
        VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${testPath}, 'vitest', ${status}, 'local', ${commitSha}, false,
          ${JSON.stringify(execution)}::text::jsonb) RETURNING id`;
      await fx.admin`INSERT INTO harness_shared.test_case_runs (test_run_id, case_index, case_key, status)
        VALUES (${run.id}, 0, 'persisted proof fixture', ${status})`;
      const { sourceFingerprint, testFingerprint, fixtureFingerprint } = measured;
      const fingerprints = { sourceFingerprint, testFingerprint, fixtureFingerprint };
      expect(await bindSpecEvidence({ harnessSlug: 'papercusp', planSlug: slug, specId,
        workItemId: 'WI-CONVERGE-PROOF', evidenceKind: 'test', evidenceRef: `test-run:${run.id}:${testPath}`,
        testRunId: Number(run.id), ...fingerprints,
        ...(stale ? { sourceFingerprint: 'deliberately-stale-source' } : {}), actorId: 'su-converge-pg',
        details: { currentMeasurement: measurement, adequacy: { fixtureCalibrated: true, falsifiable: true,
          pathReachable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
          outcome: 'passed', targeted: specId, testLayer: 'integration', testCases: ['persisted proof fixture'],
          coverageRungs: { l3: true } } } })).toMatchObject({ status: 'created' });
      if (status === 'pass') {
        // Seed the canonical negative-control leg as evaluator INPUT alongside
        // its passing baseline. A boolean attestation cannot make proof pass.
        const mutant: TestRunExecutionDetails = { ...execution, mutationPhase: 'mutant', passed: 0, failed: 1,
          passedCaseTitles: [], failedCaseTitles: ['persisted proof fixture'] };
        expect(parseTestRunExecutionDetails(mutant)).toEqual(mutant);
        const [red] = await fx.admin`INSERT INTO harness_shared.test_runs
          (workspace_id, harness_slug, file_path, framework, status, source, commit_sha, worktree_dirty, execution_details, output_tail)
          VALUES (${PAPERCUSP_WORKSPACE_ID}, 'papercusp', ${testPath}, 'vitest', 'fail', 'mutation-probe', ${commitSha}, false,
            ${JSON.stringify(mutant)}::text::jsonb, 'persisted proof fixture: expected true to be false') RETURNING id`;
        await fx.admin`INSERT INTO harness_shared.test_case_runs (test_run_id, case_index, case_key, status)
          VALUES (${red.id}, 0, 'persisted proof fixture', 'fail')`;
        expect(await bindSpecEvidence({ harnessSlug: 'papercusp', planSlug: slug, specId,
          workItemId: 'WI-CONVERGE-PROOF', evidenceKind: 'mutation', evidenceRef: `test-run:${red.id}:${testPath}`,
          testRunId: Number(red.id), ...fingerprints,
          ...(stale ? { sourceFingerprint: 'deliberately-stale-source' } : {}), actorId: 'su-converge-pg',
          details: { currentMeasurement: measurement, adequacy: { fixtureCalibrated: true,
            pathReachable: true, oracleIndependent: true, collected: true, skipped: false, executed: true,
            outcome: 'killed', targeted: specId, testLayer: 'integration', testCases: ['persisted proof fixture'] } } }))
          .toMatchObject({ status: 'created' });
      }
    }
    const reviewed = ['P-003', 'P-004', 'P-005', 'P-006'].map(itemId => ({
      ...auditItems[0], itemId, verdict: itemId === 'P-005' ? 'missing' : 'implemented',
    }));
    const create = vi.fn(async (args: Body) => {
      const result = await createOneWorkItem(args as never, ctx);
      return { ok: result.ok, results: [result.ok ? { ...result, id: result.workItem.id } : result] };
    });
    const tools = { plans: {
      evaluateSpecTestAdequacy: (args: Body) => call(evaluateTool, args),
      audit: (args: Body) => call(auditTool, args), certifySpecClauses: (args: Body) => call(certifyTool, args),
    }, coord: { whoami: async () => ({ ownerId: 'su-converge-pg' }) }, workItems: { create } };
    const evaluated = await call(evaluateTool, { harness: 'papercusp', slug, classRef: 'plan-class-feature-ship', detail: 'full' });
    const passing = evaluated.rows.find((entry: Body) => entry.specId === 'SPEC-PASS');
    expect(passing.verdict, JSON.stringify(passing.ratings)).toBe('pass');
    const preview = await execute(tools, { planSlug: slug, auditItems: reviewed });
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true, dryRun: true, evaluated: 4, nonPassing: 3 });
    expect(create).not.toHaveBeenCalled();
    const first = await execute(tools, { planSlug: slug, auditItems: reviewed, dryRun: false });
    expect(first, JSON.stringify(first)).toMatchObject({ ok: true, nonPassing: 3 });
    // The passing clause's card went through scorecards:emit's real writer.
    expect(auditDispatch.calls).toBeGreaterThan(0);
    expect(first.gaps.map((gap: Body) => gap.specId).sort()).toEqual(['SPEC-FAIL', 'SPEC-STALE', 'SPEC-UNBOUND']);
    expect(first.gaps.find((gap: Body) => gap.specId === 'SPEC-FAIL')).toMatchObject({ classification: 'critical' });
    expect(first.gaps.find((gap: Body) => gap.specId === 'SPEC-STALE')).toMatchObject({ classification: 'outdated' });
    const second = await execute(tools, { planSlug: slug, auditItems: reviewed, dryRun: false });
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
    expect(second.gaps.map((gap: Body) => gap.id)).toEqual(first.gaps.map((gap: Body) => gap.id));
    const stored = await fx.admin`SELECT feature_id, taken_by, payload FROM harness_shared.work_items
      WHERE payload->'specConformanceGap'->>'planSlug' = ${slug}`;
    expect(stored).toHaveLength(3);
    expect(stored.every(item => item.taken_by === 'su-converge-pg')).toBe(true);
    const links = await fx.admin`SELECT count(*)::int AS count FROM harness_shared.coord_links
      WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND src_ref IN ${fx.admin(stored.map(item => item.feature_id))}
        AND dst_kind = 'plan' AND dst_ref = ${slug} AND rel = 'about'`;
    expect(links[0].count).toBe(3);
  }, 120_000);
});
