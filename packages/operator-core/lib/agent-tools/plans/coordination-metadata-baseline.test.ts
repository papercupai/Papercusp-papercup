/**
 * P-001 characterization, NOT acceptance of the old behavior.
 *
 * P-002 compares the repaired workflow against the frozen P-001 inputs/targets.
 * Retain the original BEFORE receipt; it is not renewed by this suite.
 * Counts below are oracle/handler calls in a hermetic
 * fixture, NOT network round trips, fleet telemetry, elapsed user time, or a
 * claim that the whole imported source tree was pinned.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { evaluatePlanStartReadiness } from './plan-input-validation';
import { computeSpecSetHash } from './spec-clause-compiler';
import { evaluatePlanSpecQuality } from './spec-quality';
import { hashPlanContent } from './content-hash';
import { evaluatePlanSpecQualityGate } from './plan-spec-quality-gate';
import {
  metadataClause, metadataClauseWrite, metadataHarness, metadataInputSchema, metadataPlanSlug,
  metadataWorkflowTargets,
} from './coordination-metadata-fixtures';
import { specClauseContentHash } from './spec-clauses-store';
import { composePickup } from '../work_items/pickup';
import type { InnerCall } from '../_compound-dispatch';

// Real evaluator/tool/validators; only store IO is replaced. Unexpected store
// access fails instead of falling through to the shared workspace database.
const stores = vi.hoisted(() => ({
  readPlan: vi.fn(),
  getPlanRow: vi.fn(),
  listClauses: vi.fn(),
  listRubrics: vi.fn(),
}));
const metadataSnapshot = '---\ntitle: Metadata fixture\nstatus: ready\n---\n## Items\n- **P-001** `todo` Accept events';
vi.mock('./revisions', async (importOriginal) => ({
  ...await importOriginal<typeof import('./revisions')>(),
  getPlanRevisionSnapshot: async () => ({ contentSnapshot: metadataSnapshot, contentSnapshotHash: hashPlanContent(metadataSnapshot) }),
}));
vi.mock('./source', async (importOriginal) => ({
  ...await importOriginal<typeof import('./source')>(),
  readPlanBySlug: async (...args: Parameters<typeof stores.readPlan>) => {
    const read = await stores.readPlan(...args);
    return read ? { ...read, row: { ...read.row, contentHash: hashPlanContent(metadataSnapshot) } } : read;
  },
  getPlanRow: stores.getPlanRow,
}));
vi.mock('./spec-clauses-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./spec-clauses-store')>(),
  listSpecClauses: stores.listClauses,
}));
vi.mock('../../rubrics', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../rubrics')>(),
  getAcceptanceRubricsForPlan: stores.listRubrics,
}));

import evaluateTool from './evaluate-spec-quality';
import getInputSchemaTool from './get-input-schema';

const context: UnifiedToolContext = {
  harnessSlug: metadataHarness,
  workspaceId: 'metadata-fixture-workspace',
  log: () => {},
  signal: new AbortController().signal,
  progress: () => {},
  emit: () => {},
};

beforeEach(() => {
  vi.resetAllMocks();
  stores.readPlan.mockResolvedValue({
    row: {
      items: [{ id: 'P-001' }],
      template: null,
      inputSchema: metadataInputSchema.inputSchema,
      templateData: { attempts: 'invalid' },
    },
    parsed: { items: [{ id: 'P-001' }] },
  });
  stores.listClauses.mockResolvedValue([metadataClause()]);
  stores.getPlanRow.mockImplementation(() => {
    throw new Error('unexpected plan-row IO: inject the readiness workflow state');
  });
  stores.listRubrics.mockImplementation(() => {
    throw new Error('unexpected acceptance-rubric IO: inject the test dependency');
  });
});

describe('P-002 workflow measurements against frozen P-001 targets', () => {
  it('discovers both defects in one input-tool request and confirms the joint repair in one more', async () => {
    for (const templateData of [
      { attempts: 'invalid' },
      { harness: 'fixture', attempts: 1 },
    ]) {
      stores.getPlanRow.mockResolvedValueOnce({
        planSlug: metadataPlanSlug, ...metadataInputSchema, templateData, version: 1,
      });
    }
    const args = getInputSchemaTool.args.parse({ harness: metadataHarness, slug: metadataPlanSlug });
    const responses = [
      await getInputSchemaTool.handler(args, context),
      await getInputSchemaTool.handler(args, context),
    ];
    expect(responses).toHaveLength(metadataWorkflowTargets.readinessToolRequests.maxAfter);
    expect(stores.getPlanRow).toHaveBeenCalledTimes(metadataWorkflowTargets.readinessToolRequests.maxAfter);
    expect(responses[0]).toMatchObject({
      data: { results: [{ ready: false, code: 'missing_required', missing: ['harness'], issues: [expect.stringContaining('attempts')] }] },
    });
    expect(responses[1]).toMatchObject({ data: { results: [{ ready: true, missing: [] }] } });
    // Actual handler request/response pairs, with persisted-state reads injected.
    // No network transport or caller repair WRITE is counted by this instrument.
  });

  it('needs two readiness oracle calls to discover and confirm repair of the same two defects', () => {
    const calls = [
      evaluatePlanStartReadiness(metadataInputSchema, { attempts: 'invalid' }),
      evaluatePlanStartReadiness(metadataInputSchema, { harness: 'fixture', attempts: 1 }),
    ];
    expect(calls).toHaveLength(metadataWorkflowTargets.readinessCalls.maxAfter);
    expect(calls[0]).toMatchObject({
      ready: false, code: 'missing_required', missing: ['harness'], issues: [expect.stringContaining('attempts')],
    });
    expect(calls[1]).toEqual({ ready: true, source: 'input-schema' });
  });

  it('produces no draft for invalid inputs and reports an unavailable policy in the same request', async () => {
    const args = evaluateTool.args.parse({
      harness: metadataHarness, slug: metadataPlanSlug, classRef: 'plan-class-feature-ship',
    });
    const result = await evaluateTool.handler(args, context);
    expect(evaluatePlanStartReadiness(metadataInputSchema, { attempts: 'invalid' }).ready).toBe(false);
    expect(result).toMatchObject({ data: {
      ok: false, error: 'plan_prerequisites_not_ready', unknownChecks: ['class'],
      wouldBlock: expect.arrayContaining(['missing_required', 'class_read_unavailable']),
    } });
    expect(result).not.toHaveProperty('data.scorecardDraft');
    expect(stores.readPlan).toHaveBeenCalledTimes(1);
    expect(stores.listClauses).toHaveBeenCalledTimes(1);
    expect(stores.listRubrics).toHaveBeenCalledWith(metadataPlanSlug, { harnessSlug: metadataHarness, strict: true });
  });

  it('derives the unambiguous persisted class with no caller metadata and stable retry identity', async () => {
    stores.readPlan.mockResolvedValue({
      row: { items: [{ id: 'P-001' }], ...metadataInputSchema, templateData: { harness: 'fixture', attempts: 1 } },
      parsed: { items: [{ id: 'P-001' }] },
    });
    stores.listRubrics.mockResolvedValue([{ classRef: 'plan-class-feature-ship' }]);
    const args = evaluateTool.args.parse({ harness: metadataHarness, slug: metadataPlanSlug });
    expect(Object.keys(args).filter((key) => key === 'classRef'))
      .toHaveLength(metadataWorkflowTargets.callerClassSelections.maxAfter);
    const first = await evaluateTool.handler(args, context);
    expect(first).toMatchObject({ data: {
      ok: true, classRef: 'plan-class-feature-ship', verdict: 'pass', scorecardDraft: { rubricRef: 'spec-quality' },
    } });
    expect(await evaluateTool.handler(args, context)).toEqual(first);
  });

  it('refuses a replay when expectedSpecSetHash differs from current clauses and returns no draft', async () => {
    stores.readPlan.mockResolvedValue({
      row: { items: [{ id: 'P-001' }], ...metadataInputSchema, templateData: { harness: 'fixture', attempts: 1 } },
      parsed: { items: [{ id: 'P-001' }] },
    });
    stores.listRubrics.mockResolvedValue([{ classRef: 'plan-class-feature-ship' }]);
    const expectedSpecSetHash = '0'.repeat(64);
    const args = evaluateTool.args.parse({
      harness: metadataHarness,
      slug: metadataPlanSlug,
      expectedSpecSetHash,
    });

    const result = await evaluateTool.handler(args, context);

    expect(result).toMatchObject({ data: {
      ok: false,
      error: 'spec_set_hash_mismatch',
      expectedSpecSetHash,
      blockers: [expect.objectContaining({ check: 'clauses', state: 'blocked', code: 'spec_set_hash_mismatch' })],
      wouldBlock: ['spec_set_hash_mismatch'],
    } });
    const data = (result as { data: { specSetHash?: unknown } }).data;
    expect(data).toHaveProperty('specSetHash');
    expect(data.specSetHash).not.toBe(expectedSpecSetHash);
    expect(result).not.toHaveProperty('data.scorecardDraft');
  });

  it.each([
    ['missing', [], 'spec_quality_class_missing'],
    ['ambiguous', [{ classRef: 'plan-class-feature-ship' }, { classRef: 'plan-class-bugfix' }], 'spec_quality_class_ambiguous'],
    ['invalid', [{ classRef: 'arbitrary-policy' }], 'spec_quality_class_invalid'],
    ['mismatched', [{ classRef: 'plan-class-bugfix' }], 'spec_quality_class_mismatch'],
  ] as const)('refuses %s persisted class together with invalid inputs without a draft', async (_name, rubrics, code) => {
    stores.listRubrics.mockResolvedValue(rubrics);
    const args = evaluateTool.args.parse({
      harness: metadataHarness, slug: metadataPlanSlug, classRef: 'plan-class-feature-ship',
    });
    const result = await evaluateTool.handler(args, context);
    expect(result).toMatchObject({ data: {
      ok: false, wouldBlock: expect.arrayContaining(['missing_required', code]),
    } });
    expect(result).not.toHaveProperty('data.scorecardDraft');
  });

  it('reports all independent unavailable reads as unknown rather than a pass or an empty corpus', async () => {
    stores.readPlan.mockRejectedValue(new Error('plan unavailable'));
    stores.listClauses.mockRejectedValue(new Error('clauses unavailable'));
    stores.listRubrics.mockRejectedValue(new Error('policy unavailable'));
    const result = await evaluateTool.handler(evaluateTool.args.parse({ slug: metadataPlanSlug }), context);
    expect(result).toMatchObject({ data: { ok: false, unknownChecks: ['plan', 'clauses', 'class'] } });
    expect(result).not.toHaveProperty('data.scorecardDraft');
  });

  it('does not manufacture a spec-quality draft for a legacy/no-clause plan', async () => {
    stores.readPlan.mockResolvedValue({
      row: { items: [], template: null, inputSchema: null, templateData: null },
      parsed: { items: [] },
    });
    stores.listClauses.mockResolvedValue([]);
    stores.listRubrics.mockResolvedValue([]);
    const result = await evaluateTool.handler(evaluateTool.args.parse({ slug: metadataPlanSlug }), context);
    expect(result).toMatchObject({ data: {
      ok: false, readiness: { ready: true, source: 'none' },
      wouldBlock: expect.arrayContaining(['spec_quality_class_missing', 'no_first_class_spec_clauses']),
    } });
    expect(result).not.toHaveProperty('data.scorecardDraft');
  });

  it('still refuses invalid inputs with an otherwise valid class and clause set', async () => {
    stores.listRubrics.mockResolvedValue([{ classRef: 'plan-class-feature-ship' }]);
    const result = await evaluateTool.handler(evaluateTool.args.parse({ slug: metadataPlanSlug }), context);
    expect(result).toMatchObject({ data: { ok: false, wouldBlock: ['missing_required'], unknownChecks: [] } });
    if (!('data' in result) || !result.data || typeof result.data !== 'object') {
      throw new Error('Expected structured prerequisite result');
    }
    expect(Number(Object.hasOwn(result.data, 'scorecardDraft')))
      .toBe(metadataWorkflowTargets.prematureDrafts.maxAfter);
  });
});

describe('P-001 safety fixtures — remain enforced throughout implementation', () => {
  it.each([
    ['missing', [], 'spec_quality_class_missing'],
    ['ambiguous', [{ classRef: 'plan-class-feature-ship' }, { classRef: 'plan-class-bugfix' }], 'spec_quality_class_ambiguous'],
    ['invalid', [{ classRef: 'arbitrary-policy' }], 'spec_quality_class_invalid'],
  ] as const)('does not read or accept a scorecard for %s persisted class', async (_name, rubrics, code) => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: metadataHarness, planSlug: metadataPlanSlug, planItemIds: ['P-001'] },
      { listClauses: async () => [metadataClause()], listAcceptanceRubrics: async () => rubrics, listCards },
    );
    expect(result).toMatchObject({ satisfied: false, code });
    expect(listCards).not.toHaveBeenCalled();
  });

  it('keeps an unavailable persisted policy distinct from a valid class', async () => {
    const listCards = vi.fn(async () => []);
    const result = await evaluatePlanSpecQualityGate(
      { harnessSlug: metadataHarness, planSlug: metadataPlanSlug, planItemIds: ['P-001'] },
      {
        listClauses: async () => [metadataClause()],
        listAcceptanceRubrics: async () => { throw new Error('policy unavailable'); },
        listCards,
      },
    );
    expect(result.satisfied).toBe(false);
    expect(listCards).not.toHaveBeenCalled();
  });

  it('already preserves semantic identity across formatting and storage revision changes', () => {
    const original = metadataClause();
    const formatted = metadataClause({
      behavior: '  POST /events returns 202 for a valid request  ',
      revision: 2, currentRevision: 2, contentHash: 'different-storage-hash',
    });
    expect(computeSpecSetHash([formatted])).toBe(computeSpecSetHash([original]));
    expect(specClauseContentHash(metadataClauseWrite({ behavior: formatted.behavior })))
      .toBe(specClauseContentHash(metadataClauseWrite()));
    expect(Number(computeSpecSetHash([formatted]) !== computeSpecSetHash([original])))
      .toBe(metadataWorkflowTargets.formattingIdentityChanges.before);
  });

  it.each([
    { behavior: 'POST /events returns 403 for a valid request' },
    { requiredTestLayers: ['unit'] },
    { requiredEvidence: ['different-source-receipt'] },
    { acceptanceRef: `${metadataPlanSlug}#D-002` },
    { mutationRequired: true },
  ])('invalidates semantic identity for substantive change %j', (change) => {
    expect(computeSpecSetHash([metadataClause(change)]))
      .not.toBe(computeSpecSetHash([metadataClause()]));
  });

  it('keeps policy class in the reviewed subject even when clause semantics are identical', () => {
    const input = {
      planSlug: metadataPlanSlug, harnessSlug: metadataHarness,
      planItemIds: ['P-001'], clauses: [metadataClause()],
    };
    const feature = evaluatePlanSpecQuality({ ...input, classRef: 'plan-class-feature-ship' });
    const bugfix = evaluatePlanSpecQuality({ ...input, classRef: 'plan-class-bugfix' });
    expect(feature.specSetHash).toBe(bugfix.specSetHash);
    expect(feature.scorecardDraft.subject.ref).not.toBe(bugfix.scorecardDraft.subject.ref);
    expect(bugfix.wouldBlock).toContain('plan-class-specialization');
  });
});

/**
 * The real composition with injected dispatch responses, not a second handoff
 * implementation. These counters measure dispatched stages only. No network,
 * reviewer session, admission policy, or elapsed pickup latency is exercised.
 * P-003 must retain these inputs when replacing the pre-change false-success
 * expectation. A successful claim is not evidence that a reviewer took a turn.
 */
describe('P-001 pickup stage baseline', () => {
  const item = { id: 'WI-METADATA-FIXTURE', assignee: 'fixture-reviewer' };

  function dispatcher(claimOk: boolean, declareOk: boolean) {
    const calls: string[] = [];
    const call: InnerCall = async (name) => {
      calls.push(name);
      switch (name) {
        case 'work_items:get':
          return { ok: true, results: [{ ok: true, workItem: item }] };
        case 'work_items:claim':
          return {
            ok: true,
            results: [claimOk
              ? { ok: true, workItem: item }
              : { ok: false, error: 'fleet_scope_violation' }],
          };
        case 'coord:declare-intent':
          return declareOk
            ? {
              ok: true, presence: { intent: 'Review exact fixture' },
              claims: { claimed: ['P-001'], alreadyHeld: [], conflicts: [] },
            }
            : { ok: false, error: 'claim_conflict' };
        default:
          throw new Error(`unexpected fixture dispatch: ${name}`);
      }
    };
    return { call, calls };
  }

  const args = {
    id: item.id,
    intent: 'Review exact fixture',
    plan: metadataPlanSlug,
    items: ['P-001'],
  };

  it('uses three dispatched stages for a successful get/claim/declaration', async () => {
    const { call, calls } = dispatcher(true, true);
    expect(await composePickup(args, call)).toMatchObject({
      ok: true, claimed: true, intentDeclared: true,
    });
    expect(calls).toEqual(['work_items:get', 'work_items:claim', 'coord:declare-intent']);
    expect(calls).toHaveLength(metadataWorkflowTargets.successfulPickupDispatches.before);
  });

  it('stops after a denied claim without retrying, declaring, or creating another item', async () => {
    const { call, calls } = dispatcher(false, true);
    expect(await composePickup(args, call)).toMatchObject({
      ok: false, claimed: false, step: 'claim', error: 'fleet_scope_violation',
    });
    expect(calls).toEqual(['work_items:get', 'work_items:claim']);
    expect(calls).toHaveLength(metadataWorkflowTargets.deniedPickupDispatches.before);
  });

  it('reports the declaration failure without hiding the already-completed claim (P-003)', async () => {
    const { call, calls } = dispatcher(true, false);
    expect(await composePickup(args, call)).toMatchObject({
      ok: false, step: 'declare-intent', claimed: true, intentDeclared: false, laneClaimed: false,
      presence: { ok: false, error: 'claim_conflict' },
    });
    expect(calls).toEqual(['work_items:get', 'work_items:claim', 'coord:declare-intent']);
  });
});
