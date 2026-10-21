import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { applyPayloadTier } from '@papercusp/tooldef';
import { dispatchProjectedTool, lookupByMcpName, readJsonResult } from '@papercusp/agent-mcp';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { applyResultDoor } from '../../result-door';
import { parseScratchReference } from '../../scratch-reference';
import { safeScratchFilesystemPath } from '../../scratch-uri';

const doorConstants = vi.hoisted(() => vi.fn());
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstants }));

const rubricsMocks = vi.hoisted(() => ({
  amendRubric: vi.fn(),
  previewAcceptanceBarAmendment: vi.fn(),
  rubricCompleteness: vi.fn(),
  getRubric: vi.fn(),
  applyRubricAmendment: vi.fn(),
  mintAmendmentIdempotencyKey: vi.fn(() => 'amend-minted-key'),
  findAmendmentDecisionByKey: vi.fn(),
}));

const reviewMocks = vi.hoisted(() => ({ openAcceptanceBarAmendmentReview: vi.fn() }));
const planMocks = vi.hoisted(() => ({ getPlanRow: vi.fn() }));
vi.mock('../plans/source', () => ({ getPlanRow: planMocks.getPlanRow }));
const workItemMocks = vi.hoisted(() => ({ commentWorkItem: vi.fn() }));
const receiptDb = vi.hoisted(() => {
  type Row = { idempotency_key: string; rubric_ref: string; state: string; started_at: Date; finished_at: Date | null; result_json: Record<string, unknown> | null; error: string | null };
  const rows = new Map<string, Row>();
  const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?');
    if (query.includes('DELETE FROM harness_shared.rubric_amend_receipts')) return [];
    if (query.includes('INSERT INTO harness_shared.rubric_amend_receipts')) {
      const [workspace, rubric, key] = values as string[];
      const id = `${workspace}:${rubric}:${key}`;
      if (rows.has(id)) return [];
      rows.set(id, { idempotency_key: key!, rubric_ref: rubric!, state: 'running', started_at: new Date(), finished_at: null, result_json: null, error: null });
      return [{ idempotency_key: key }];
    }
    if (query.includes('SELECT idempotency_key')) {
      const [workspace, rubric, key] = values as string[];
      const row = rows.get(`${workspace}:${rubric}:${key}`);
      return row ? [row] : [];
    }
    if (query.includes('UPDATE harness_shared.rubric_amend_receipts')) {
      const success = query.includes('result_json =');
      const [workspace, rubric, key] = (success ? values.slice(3) : values.slice(1)) as string[];
      const row = rows.get(`${workspace}:${rubric}:${key}`);
      if (row) {
        row.state = success ? String(values[0]) : 'failed';
        row.result_json = success ? JSON.parse(String(values[1])) : null;
        row.error = success ? values[2] as string | null : String(values[0]);
        row.finished_at = new Date();
      }
      return [];
    }
    throw new Error(`unexpected receipt SQL: ${query}`);
  });
  return { rows, sql };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: receiptDb.sql }),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workspace-registry')>(),
  activeWorkspaceId: () => 'ws-amend-test',
}));

vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'amend-test', workspaceId: 'ws-amend-test' }),
}));
vi.mock('../../consult/acceptance-bar-amendment-review', () => ({
  openAcceptanceBarAmendmentReview: reviewMocks.openAcceptanceBarAmendmentReview,
}));
vi.mock('../../work-items', () => ({ commentWorkItem: workItemMocks.commentWorkItem }));
vi.mock('../../rubrics', () => ({
  AMENDABLE_CRITERION_FIELDS: ['title', 'model', 'method', 'driftMarkers', 'replication'],
  amendRubric: rubricsMocks.amendRubric,
  previewAcceptanceBarAmendment: rubricsMocks.previewAcceptanceBarAmendment,
  rubricCompleteness: rubricsMocks.rubricCompleteness,
  getRubric: rubricsMocks.getRubric,
  applyRubricAmendment: rubricsMocks.applyRubricAmendment,
  effectiveCriterionInstrumentKey: (criterion: { check?: { kind: string; instrumentKey?: string }; instrumentKey?: string }) =>
    criterion.check?.kind === 'instrument' ? criterion.check.instrumentKey ?? null : criterion.instrumentKey ?? null,
  mintAmendmentIdempotencyKey: rubricsMocks.mintAmendmentIdempotencyKey,
  findAmendmentDecisionByKey: rubricsMocks.findAmendmentDecisionByKey,
}));
vi.mock('../../rubrics-replication-sql', () => ({
  validateRubricReplicationSql: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../detached-imports', () => ({
  trackDetached: () => Promise.resolve({ notifySyncInvalidate: vi.fn() }),
}));

import amendTool, { rubricsAmendArgs } from './amend';
import amendStatusTool from './amend-status';
import { BUDGET, promptWeight } from '../tool-guidance-budget';
import type { RouteResult } from '../../consult/relevance-router';

type ToolOutput = { content: Array<{ text: string }> };
const body = async (args: unknown) => {
  const response = await amendTool.handler(args as never, {} as never);
  if ('data' in response) return response.data as Record<string, any>;
  return JSON.parse((response as ToolOutput).content[0]!.text);
};

beforeEach(() => {
  vi.clearAllMocks();
  rubricsMocks.applyRubricAmendment.mockReset();
  receiptDb.rows.clear();
  rubricsMocks.getRubric.mockResolvedValue(undefined);
  planMocks.getPlanRow.mockResolvedValue(null);
});

const criterion = {
  key: 'r-1',
  title: 'Outcome one',
  model: 'Outcome one remains true.',
  bar: 'Outcome one remains true.',
  method: 'Run the focused test.',
  driftMarkers: 'The focused test fails.',
  barKey: 'R-1',
  role: 'outcome' as const,
  mandatory: true,
  requiredScope: ['tree'],
  evidencePlane: 'tree' as const,
  passRatings: ['healthy'],
  check: { kind: 'tests' as const, files: ['packages/operator-core/lib/acceptance-bar-amendment.test.ts'] },
};

describe('rubrics:amend complete acceptance criteria input', () => {
  it('public guidance teaches requestReview before manual preview posting', () => {
    const schema = JSON.stringify(z.toJSONSchema(rubricsAmendArgs));
    expect(schema).toContain('requestReview');
    const dryRun = (z.toJSONSchema(rubricsAmendArgs) as any).properties.dryRun.description as string;
    expect(dryRun.indexOf('requestReview')).toBeGreaterThanOrEqual(0);
    expect(dryRun.indexOf('reviewPreviewPost')).toBeGreaterThanOrEqual(0);
    expect(dryRun.indexOf('requestReview')).toBeLessThan(dryRun.indexOf('reviewPreviewPost'));
    const chaining = amendTool.guidance!.chaining!;
    expect(chaining.indexOf('requestReview')).toBeGreaterThanOrEqual(0);
    expect(chaining.indexOf('reviewPreviewPost')).toBeGreaterThanOrEqual(0);
    expect(chaining.indexOf('requestReview')).toBeLessThan(chaining.indexOf('reviewPreviewPost'));
  });

  it('a slow amend returns a durable receipt before a shorter production dispatcher deadline', async () => {
    vi.useFakeTimers();
    let release!: (value: any) => void;
    const run = new Promise<any>(resolve => { release = resolve; });
    rubricsMocks.previewAcceptanceBarAmendment.mockImplementation(() => run);
    const args = { rubricRef: 'acceptance-deadline', dryRun: true, criteria: [criterion] };
    const deadlineAtMs = Date.now() + 100;
    try {
      const projected = lookupByMcpName('rubrics:amend')!;
      const answered = dispatchProjectedTool(
        { ...projected, timeoutSec: 0.1 }, 'rubrics:amend', args,
        {
          signal: new AbortController().signal, deadlineAtMs,
          log: vi.fn(), progress: vi.fn(), emit: vi.fn(), workspaceId: 'ws-amend-test',
          runId: 'amend-short-deadline', isSuperuser: true, uiClientId: 'amend-test', role: 'su',
          gateBypass: { role: true, capability: true, quota: true }, transport: 'mcp',
          requestedFormat: 'json', contextTier: 'trimmed', tx: {},
        }, {},
      ).then(result => ({ result, answeredAt: Date.now() }));
      await vi.advanceTimersByTimeAsync(40_100);
      const { result, answeredAt } = await answered;
      expect(result.error).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(answeredAt).toBeLessThan(deadlineAtMs);
      const payload = readJsonResult(result.result!) as any;
      expect(payload).toMatchObject({ ok: true, pending: true, receipt: { rubricRef: args.rubricRef } });
      release({ approvalRequired: false, approval: {}, changes: [] });
      await vi.advanceTimersByTimeAsync(1);
      const status = await amendStatusTool.handler(payload.receipt.poll.args, {} as never) as { data: any };
      expect(status.data).toMatchObject({ state: 'previewed', result: { ok: true } });
    } finally {
      release({ approvalRequired: false, approval: {}, changes: [] });
      vi.useRealTimers();
    }
  });

  it.each(['trimmed', 'standard'] as const)('bounds actual serialized %s preview replies and retains a complete recovery reference', async tier => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({
      approvalRequired: true,
      approval: { rubricRef: 'acceptance-large', changes: Array.from({ length: 100 }, (_, n) => ({ barKey: `R-${n}`, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) })) },
      changes: Array.from({ length: 100 }, (_, n) => ({ barKey: `R-${n}`, detail: 'explanation '.repeat(100) })),
    });
    const args = { rubricRef: 'acceptance-large', dryRun: true };
    const response = await amendTool.handler(args, {} as never);
    const shaped = applyPayloadTier({ toolName: 'rubrics:amend', shape: amendTool.shape, response: response as never, tier, args }).data as any;
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(5_000);
    expect(JSON.stringify(shaped)).not.toContain('[undefined]');
    expect(shaped.receipt.poll).toMatchObject({ tool: 'rubrics:amend-status', args: { rubricRef: args.rubricRef } });
    const full = await amendStatusTool.handler(shaped.receipt.poll.args, {} as never) as { data: any };
    expect(full.data.result.preview.approval.changes).toHaveLength(100);
  });

  it.each(['trimmed', 'standard'] as const)('preserves a usable receipt through a non-default configured output door (%s)', async tier => {
    const scratchRoot = mkdtempSync(join(tmpdir(), 'amend-output-door-'));
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = scratchRoot;
    const constants = { ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 6_400 };
    const budget = computeTurnDoors(0, constants).resultEach * CHARS_PER_TOKEN_ESTIMATE;
    expect(budget).toBeLessThan(5_000);
    doorConstants.mockReturnValue(constants);
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({
      approvalRequired: true,
      approval: { changes: Array.from({ length: 100 }, (_, n) => ({ barKey: `R-${n}`, afterHash: 'b'.repeat(64) })) },
      changes: Array.from({ length: 100 }, (_, n) => ({ barKey: `R-${n}`, detail: 'explanation '.repeat(100) })),
    });
    try {
      const args = { rubricRef: `acceptance-configured-${tier}`, dryRun: true };
      const response = await amendTool.handler(args, {} as never);
      const shaped = applyPayloadTier({ toolName: 'rubrics:amend', shape: amendTool.shape, response: response as never, tier, args }).data as any;
      const result = applyResultDoor({ content: [{ type: 'text', text: JSON.stringify(shaped) }] }, {
        toolName: 'rubrics:amend', ownerId: 'amend-test', workspaceId: 'ws-amend-test',
        preservePaths: ['receipt'],
      });
      const text = result.content.map(item => item.text).join('');
      expect(text.length).toBeLessThanOrEqual(budget);
      let delivered = JSON.parse(text) as any;
      if (!delivered.receipt) {
        const cursor = delivered._projection?.cursor;
        const uri = delivered.content?.[0]?.uri;
        expect(cursor?.args?.file_path ?? uri).toEqual(expect.any(String));
        const path = cursor?.args?.file_path ?? safeScratchFilesystemPath(uri);
        const reference = parseScratchReference(readFileSync(path));
        expect(reference).not.toBeNull();
        expect(reference!.manifest).toMatchObject({ workspaceId: 'ws-amend-test', ownerId: 'amend-test' });
        const recovered = JSON.parse(reference!.payload.subarray(reference!.manifest.bodyOffsetInPayload ?? 0).toString('utf8'));
        delivered = recovered.content ? JSON.parse(recovered.content[0].text) : recovered;
      }
      expect(delivered.receipt.poll).toMatchObject({ tool: 'rubrics:amend-status', args: { rubricRef: args.rubricRef } });
      const full = await amendStatusTool.handler(delivered.receipt.poll.args, {} as never) as { data: any };
      expect(full.data.result.preview.approval.changes).toHaveLength(100);
    } finally {
      doorConstants.mockReturnValue(BAKED_DOOR_CONSTANTS);
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it.each([true, false])('production cancellation preserves only a confirmed durable receipt (registered=%s)', async registered => {
    vi.useFakeTimers();
    let releaseRegistration: (() => void) | undefined;
    let releasePreview!: (value: any) => void;
    const preview = new Promise<any>(resolve => { releasePreview = resolve; });
    rubricsMocks.previewAcceptanceBarAmendment.mockImplementation(() => preview);
    if (!registered) receiptDb.sql.mockImplementationOnce(() => new Promise(resolve => { releaseRegistration = () => resolve([]); }));
    try {
      const projected = lookupByMcpName('rubrics:amend')!;
      const resultPromise = dispatchProjectedTool(
        { ...projected, timeoutSec: 0.1 }, 'rubrics:amend',
        { rubricRef: 'acceptance-cancellation', dryRun: true, criteria: [criterion] },
        {
          signal: new AbortController().signal, log: vi.fn(), progress: vi.fn(), emit: vi.fn(),
          workspaceId: 'ws-amend-test', runId: `amend-cancel-${registered}`, isSuperuser: true,
          uiClientId: 'amend-test', role: 'su', gateBypass: { role: true, capability: true, quota: true },
          transport: 'mcp', requestedFormat: 'json', contextTier: 'trimmed', tx: {},
        }, {},
      );
      await vi.advanceTimersByTimeAsync(200);
      const result = await resultPromise;
      if (registered) {
        expect(result.error).toBeUndefined();
        const payload = readJsonResult(result.result!) as any;
        expect(payload).toMatchObject({ pending: true, receipt: { registered: true } });
        const status = await amendStatusTool.handler(payload.receipt.poll.args, {} as never) as { data: any };
        expect(status.data.state).toBe('running');
      } else {
        expect(result.ok).toBe(false);
        expect(result.error?.code).toBe('timeout');
        expect(receiptDb.rows.size).toBe(0);
      }
      releaseRegistration?.();
      releasePreview({ approvalRequired: false, approval: {}, changes: [] });
      await vi.advanceTimersByTimeAsync(1);
    } finally {
      releaseRegistration?.();
      releasePreview({ approvalRequired: false, approval: {}, changes: [] });
      vi.useRealTimers();
    }
  });

  it('stays within the shared P-011 prompt-weight budget', () => {
    expect(promptWeight(amendTool as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

  it('keeps the complete tool schema JSON-Schema-representable', () => {
    expect(() => z.toJSONSchema(amendTool.args as never)).not.toThrow();
  });

  it('does not expose the test-only faultInjection rollback probe to tool callers (WI-6554700010018783)', () => {
    const properties = (z.toJSONSchema(rubricsAmendArgs) as { properties: Record<string, unknown> }).properties;
    // Positive control: the reader sees the real public args.
    expect(properties).toHaveProperty('approvalRef');
    expect(Object.keys(properties)).not.toContain('faultInjection');
  });

  it('publishes the structured/legacy alias equality contract before payload construction', () => {
    const schema = z.toJSONSchema(amendTool.args as never);
    const rendered = JSON.stringify(schema);

    expect(rendered).toContain('must match after canonical normalization');
    expect(rendered).toContain('`bar`/`model`');
    expect(rendered).toContain('`acceptance.condition`');
    expect(rendered).toContain('`requirement_alias_conflict`');
    expect(rendered).toContain('omit legacy aliases');
  });

  it('documents the routed review for outside-lineage approval JSON', () => {
    const rendered = JSON.stringify({ description: amendTool.description, guidance: amendTool.guidance });

    expect(rendered).toContain('work_items:comment');
    expect(rendered).toContain("reviewPreviewPost:'thread-post:");
    expect(rendered).toContain('relevance router');
    expect(rendered).toContain('workspace/id');
    expect(rendered).toMatch(/do not create a counter-sign work-item/i);
    expect(rendered).toContain("approvalRef:'thread-post:");
    expect(rendered).toContain('approve thread-post:<preview-post-id>');
    expect(rendered).toContain('immutable');
    expect(rendered).toContain('no hash transcription');
    expect(rendered).not.toContain('point the reviewer at THAT thread post');
  });

  it('documents the live plan mapping prerequisite and structured refusal for changed BARs', () => {
    const rendered = JSON.stringify({ description: amendTool.description, guidance: amendTool.guidance });

    expect(rendered).toContain('subject plan');
    expect(rendered).toContain('`## Requirements`');
    expect(rendered).toContain('`### Bar-to-work map for this plan`');
    expect(rendered).toContain('non-dropped P-NNN item');
    expect(rendered).toContain('acceptance_bar_amendment_no_live_discharge_mapping');
    expect(rendered).toContain('{ ok:false, code, error, next }');
  });

  it('returns the expected missing-map dry-run refusal as a result instead of a tool error', async () => {
    const error = new Error("acceptance_bar_amendment_no_live_discharge_mapping: BAR 'R-9' has no live mapped plan item");
    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(error);

    const result = await body({ rubricRef: 'acceptance-example', dryRun: true, criteria: [{
      ...criterion,
      key: 'r-9',
      barKey: 'R-9',
      title: 'New outcome',
    }] });

    expect(result).toMatchObject({
      ok: false,
      dryRun: true,
      code: 'acceptance_bar_amendment_no_live_discharge_mapping',
      error: error.message,
      next: expect.stringContaining('Bar-to-work map for this plan'),
    });
  });

  it('returns the same expected missing-map refusal for an apply without swallowing unrelated errors', async () => {
    const error = new Error("acceptance_bar_amendment_no_live_discharge_mapping: BAR 'R-9' has no live mapped plan item");
    rubricsMocks.amendRubric.mockRejectedValueOnce(error);

    const result = await body({
      rubricRef: 'acceptance-example',
      idempotencyKey: 'unmapped-r9-apply',
      criteria: [{ ...criterion, key: 'r-9', barKey: 'R-9', title: 'New outcome' }],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'acceptance_bar_amendment_no_live_discharge_mapping',
      error: error.message,
    });

    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(new Error('unexpected database failure'));
    await expect(body({ rubricRef: 'acceptance-example', dryRun: true })).rejects.toThrow('unexpected database failure');

    rubricsMocks.amendRubric.mockRejectedValueOnce(new Error('unexpected apply failure'));
    await expect(body({
      rubricRef: 'acceptance-example',
      idempotencyKey: 'unrelated-apply-error',
      criteria: [criterion],
    })).rejects.toThrow('unexpected apply failure');
  });

  it('returns acceptance BAR contract validation failures as structured refusals', async () => {
    const error = new Error(
      'acceptance_bar_amendment_test_layer_unrecordable: R-6: requiredTestLayers declares manual-provenance, ' +
      'which the test-run ledger never records (recorded layers: unit, integration, e2e, llm, browser)',
    );
    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(error);

    const dryRunResult = await body({
      rubricRef: 'acceptance-example',
      dryRun: true,
      criteria: [criterion],
    });

    expect(dryRunResult).toMatchObject({
      ok: false,
      dryRun: true,
      code: 'acceptance_bar_amendment_test_layer_unrecordable',
      error: error.message,
      next: expect.stringContaining('unit, integration, e2e, llm, or browser'),
    });

    rubricsMocks.amendRubric.mockRejectedValueOnce(error);
    const applyResult = await body({
      rubricRef: 'acceptance-example',
      idempotencyKey: 'unrecordable-layer-apply',
      criteria: [criterion],
    });

    expect(applyResult).toMatchObject({
      ok: false,
      code: 'acceptance_bar_amendment_test_layer_unrecordable',
      error: error.message,
      next: expect.stringContaining('unit, integration, e2e, llm, or browser'),
    });
  });

  it('returns proposeRubric validation failures as structured invalid_args refusals', async () => {
    const error = new Error(
      "invalid_args: proposeRubric: rubric 'acceptance-example' contains off-scale rating instructions — " +
      "criterion 'r-1' method explicitly instructs rating 'unverified', but its effective ratingScale is " +
      '[healthy | degraded | broken | unknown]. Use a value from the effective ratingScale or revise the procedure prose.',
    );
    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(error);

    const dryRunResult = await body({
      rubricRef: 'acceptance-example',
      dryRun: true,
      criteria: [criterion],
    });

    expect(dryRunResult).toMatchObject({
      ok: false,
      dryRun: true,
      code: 'invalid_args',
      error: error.message,
      next: expect.stringContaining('effective ratingScale'),
    });

    rubricsMocks.amendRubric.mockRejectedValueOnce(error);
    const applyResult = await body({
      rubricRef: 'acceptance-example',
      idempotencyKey: 'off-scale-apply',
      criteria: [criterion],
    });

    expect(applyResult).toMatchObject({
      ok: false,
      code: 'invalid_args',
      error: error.message,
      next: expect.stringContaining('effective ratingScale'),
    });
  });

  it('returns missing outside-lineage approval as a structured refusal instead of a tool error', async () => {
    const error = new Error(
      'acceptance_bar_approval_required: use thread-post:<id> from an authenticated reviewer post containing the preview approval JSON',
    );
    rubricsMocks.amendRubric.mockRejectedValueOnce(error);

    const result = await body({
      rubricRef: 'acceptance-example',
      idempotencyKey: 'missing-approval-apply',
      criteria: [criterion],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'acceptance_bar_approval_required',
      error: error.message,
      next: expect.stringContaining("reviewPreviewPost:'thread-post:<preview-id>'"),
    });
  });

  it('accepts a full criterion set with structured checks', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [criterion],
      reason: 'Bind the runnable acceptance check.',
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.criteria?.[0]?.bar).toBe(criterion.bar);
  });

  it('accepts a full criteria replacement with both optimistic revision guards', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      dryRun: true,
      reason: 'Repair the accepted-content detector.',
      criteria: [criterion],
      idempotencyKey: 'amend-criteria-revision-guards',
      expectedRubricRevision: 7,
      expectedSubjectPlanRevision: 11,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        idempotencyKey: 'amend-criteria-revision-guards',
        expectedRubricRevision: 7,
        expectedSubjectPlanRevision: 11,
      });
    }
  });

  it('accepts a serving runtime in a complete BAR amendment', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...criterion, evidencePlane: 'live', evidenceRuntime: 'staging-operator' }],
      dryRun: true,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.criteria?.[0]?.evidenceRuntime).toBe('staging-operator');

    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        criteria: [{ ...criterion, evidencePlane: 'live', evidenceRuntime: 'unknown-runtime' }],
        dryRun: true,
      }).success,
    ).toBe(false);
  });

  it('rejects approval authorization without an amendment patch', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      approvalRef: 'thread-post:773433',
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining('approvalRef authorizes a patch but does not supply one'),
          }),
        ]),
      );
    }
  });

  it('accepts approval authorization when an amendment patch is supplied', () => {
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        approvalRef: 'thread-post:773433',
        criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Also inspect the log.' },
      }).success,
    ).toBe(true);
  });

  it('allows passRatings: [] for disclosure criteria and rejects the same shape for outcomes', () => {
    const disclosure = {
      ...criterion,
      role: 'disclosure' as const,
      mandatory: false,
      passRatings: [],
      coversBarKeys: ['R-1'],
    };
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        criteria: [disclosure],
      }).success,
    ).toBe(true);
    expect(
      rubricsAmendArgs.safeParse({
        rubricRef: 'acceptance-example',
        requirement: { key: 'r-1', acceptance: { role: 'disclosure', passRatings: [] } },
      }).success,
    ).toBe(true);

    const invalid = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...disclosure, role: 'outcome', mandatory: true }],
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining("role:'disclosure'"),
          }),
        ]),
      );
    }

    const invalidDisclosure = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [{ ...disclosure, passRatings: ['healthy'] }],
    });
    expect(invalidDisclosure.success).toBe(false);
    if (!invalidDisclosure.success) {
      expect(invalidDisclosure.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['criteria', 0, 'passRatings'],
            message: expect.stringContaining('must be empty'),
          }),
        ]),
      );
    }
  });

  it('retains a missing-class binding without requiring replacement criteria', () => {
    const parsed = rubricsAmendArgs.parse({
      rubricRef: 'acceptance-example',
      classRef: ' plan-class-investigation ',
    });
    expect(parsed.classRef).toBe('plan-class-investigation');
    expect(parsed.criteria).toBeUndefined();
    expect(rubricsAmendArgs.safeParse({ rubricRef: 'acceptance-example', classRef: '  ' }).success).toBe(false);
  });

  it('refuses an ambiguous full-set plus single-criterion patch', () => {
    const parsed = rubricsAmendArgs.safeParse({
      rubricRef: 'acceptance-example',
      criteria: [criterion],
      criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Also inspect the log.' },
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ['criteria'], message: expect.stringContaining('cannot be combined') }),
        ]),
      );
    }
  });

  it('reports an actionable refusal when dryRun cannot resolve the rubric', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(null);

    const result = await body({
      rubricRef: 'missing-rubric',
      dryRun: true,
      reason: 'Preview the requested amendment.',
      criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Run the focused check.' },
    });

    expect(result).toEqual({
      ok: false,
      dryRun: true,
      code: 'rubric_not_found',
      error: "no rubric 'missing-rubric' — rubrics:list to see refs",
      rubricRef: 'missing-rubric',
    });
  });

  it('refuses an unregistered instrument before posting or launching its review', async () => {
    const changed = { ...criterion, check: { kind: 'instrument' as const, instrumentKey: 'unregistered:outcome' } };
    rubricsMocks.getRubric.mockResolvedValue({ criteria: [criterion] });
    rubricsMocks.applyRubricAmendment.mockReturnValue({ criteria: [changed] });

    const result = await body({
      rubricRef: 'acceptance-example', dryRun: true, criteria: [changed],
      requestReview: { workItemId: 'WI-9' },
    });

    expect(result).toMatchObject({
      ok: false, dryRun: true, code: 'unregistered_instrument',
      refused: [{ criterion: 'r-1', instrumentKey: 'unregistered:outcome', priorInstrumentKey: null }],
    });
    expect(rubricsMocks.previewAcceptanceBarAmendment).not.toHaveBeenCalled();
    expect(workItemMocks.commentWorkItem).not.toHaveBeenCalled();
    expect(reviewMocks.openAcceptanceBarAmendmentReview).not.toHaveBeenCalled();
    expect(rubricsMocks.amendRubric).not.toHaveBeenCalled();
  });

  it('returns a non-blocking methodLint advisory for native-shell acceptance methods', async () => {
    const method = 'Read /proc/<pid>/environ after using pgrep -f the proxy.';
    rubricsMocks.rubricCompleteness.mockReturnValue({ complete: true });
    rubricsMocks.amendRubric.mockResolvedValue({
      rubricId: 'acceptance-example',
      kind: 'acceptance',
      criteria: [{ ...criterion, method }],
      methodRef: null,
    });

    const result = await body({
      rubricRef: 'acceptance-example',
      criteria: [{ ...criterion, method }],
      reason: 'Refresh the acceptance procedure.',
    });

    expect(result.methodLint).toEqual([
      expect.objectContaining({
        code: 'acceptance-method-native-shell',
        criterionKey: 'r-1',
        markers: ['proc-path', 'pgrep'],
      }),
    ]);
  });
});

// RSR-P-008-C (review-system-rework-reduction-2026-09-23): rubrics:amend that
// would exceed its timeout returns a pollable receipt. Falsifier: the caller
// receives a timeout error with an unknown commit state. Probe: run amend with a
// slow stub, assert the receipt, then poll it.
describe('rubrics:amend routed review (P-006, RR-P-006-amend-opens-routed-review)', () => {
  const patchArgs = {
    rubricRef: 'acceptance-demo',
    dryRun: true,
    reason: 'Tighten the falsifier.',
    criterion: { key: 'r-1', field: 'driftMarkers' as const, mode: 'append' as const, text: 'Also fails when X.' },
  };
  const approvalRequired = {
    approvalRequired: true,
    approval: { schemaVersion: 1, rubricRef: 'acceptance-demo', bars: [] },
    changes: [{ barKey: 'R-1', kinds: ['bar-meaning'], fields: ['falsifier'] }],
  };

  it('an approval-required dry run with its preview post returns a routed review reference', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({
      state: 'routed',
      conversationId: 'conv-review-1',
      responderId: 'outside-expert',
      screenedOut: [],
      previewPostRef: 'thread-post:42',
      next: "events:await { event:'consult:reply:conv-review-1' }",
    });

    const result = await body({ ...patchArgs, reviewPreviewPost: 'thread-post:42' });

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      review: { state: 'routed', conversationId: 'conv-review-1', previewPostRef: 'thread-post:42' },
    });
    const call = reviewMocks.openAcceptanceBarAmendmentReview.mock.calls[0]![0];
    expect(call).toMatchObject({
      rubricRef: 'acceptance-demo',
      previewPostRef: 'thread-post:42',
      reason: 'Tighten the falsifier.',
      workspaceId: 'ws-amend-test',
      patch: { criterion: patchArgs.criterion },
      preview: approvalRequired,
    });
    // WI-10003299: the tool context reaches the opener so a fresh-reviewer
    // launch can run (re-attributed to the review's system principal).
    expect(call).toHaveProperty('launchCtx');
    expect(call.launchCtx).toEqual({});
    expect(Object.keys(call.patch)).toEqual(['criterion']);
  });

  // P-004 (plan-verification-friction-reduction-2026-10-11), AUTO-BAR-R-4 marker 1.
  it('a requestReview dry run posts the preview approval JSON server-side and returns its post id with the routed review handle', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    workItemMocks.commentWorkItem.mockResolvedValue({ id: 77 });
    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementation(async (input: { previewPostRef: string }) => ({
      state: 'routed',
      conversationId: 'conv-review-2',
      responderId: 'outside-expert',
      screenedOut: [],
      previewPostRef: input.previewPostRef,
      next: "events:await { event:'consult:reply:conv-review-2' }",
    }));

    const result = await body({ ...patchArgs, requestReview: { workItemId: 'WI-9', harness: 'papercusp' } });

    expect(workItemMocks.commentWorkItem).toHaveBeenCalledTimes(1);
    const [workItemId, postedBody, authorId, opts] = workItemMocks.commentWorkItem.mock.calls[0]!;
    expect(workItemId).toBe('WI-9');
    expect(authorId).toBe('amend-test');
    expect(opts).toMatchObject({ workspaceId: 'ws-amend-test', harness: 'papercusp' });
    expect(opts).not.toHaveProperty('writerOwnerId');
    // The post IS the preview's approval JSON, byte for byte, not an echo of the request.
    expect(postedBody).toBe(JSON.stringify(approvalRequired.approval));
    expect(JSON.parse(postedBody as string)).toEqual(approvalRequired.approval);
    expect(reviewMocks.openAcceptanceBarAmendmentReview.mock.calls[0]![0]).toMatchObject({
      previewPostRef: 'thread-post:77',
      preview: approvalRequired,
      patch: { criterion: patchArgs.criterion },
    });
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      review: { state: 'routed', conversationId: 'conv-review-2', previewPostRef: 'thread-post:77' },
    });

    // A preview that needs no outside approval posts nothing and opens no review.
    vi.clearAllMocks();
    receiptDb.rows.clear();
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({ ...approvalRequired, approvalRequired: false });
    const quiet = await body({ ...patchArgs, requestReview: { workItemId: 'WI-9' } });
    expect(quiet).toMatchObject({ ok: true, dryRun: true });
    expect(quiet.review).toBeUndefined();
    expect(workItemMocks.commentWorkItem).not.toHaveBeenCalled();
    expect(reviewMocks.openAcceptanceBarAmendmentReview).not.toHaveBeenCalled();
    // A dry-run-only lever that excludes a caller-posted preview.
    expect(rubricsAmendArgs.safeParse({ ...patchArgs, dryRun: false, requestReview: { workItemId: 'WI-9' } }).success).toBe(false);
    expect(
      rubricsAmendArgs.safeParse({ ...patchArgs, reviewPreviewPost: 'thread-post:42', requestReview: { workItemId: 'WI-9' } }).success,
    ).toBe(false);
  });

  it('settles a credit-walled fresh reviewer as a failed receipt', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({
      state: 'no-eligible-reviewer',
      conversationId: null,
      reason: 'no_available_responder',
      screenedOut: [],
      previewPostRef: 'thread-post:42',
      next: 'retry after the provider account recovers',
      freshReviewer: {
        state: 'blocked',
        reason: 'account-walled',
        evidence: 'Credit balance is too low',
        recovery: { state: 'stopped', evidence: 'stopped task task-1' },
      },
    });

    const result = await body({ ...patchArgs, reviewPreviewPost: 'thread-post:42' });
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      review: { state: 'no-eligible-reviewer', freshReviewer: { state: 'blocked', reason: 'account-walled' } },
    });

    const status = await amendStatusTool.handler(result.receipt.poll.args, {} as never) as { data: Record<string, unknown> };
    expect(status.data).toMatchObject({
      state: 'failed',
      source: 'receipt',
      error: 'account-walled',
      result: { ok: true, dryRun: true },
    });
  });

  // P-004, AUTO-BAR-R-4 marker 2: a slow requestReview answers with a receipt, and a retry never re-posts.
  it('an amend still running at the response deadline returns a pending receipt pollable through rubrics:amend-status', async () => {
    process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS = '20';
    try {
      rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
      workItemMocks.commentWorkItem.mockResolvedValue({ id: 78 });
      let release: (() => void) | undefined;
      reviewMocks.openAcceptanceBarAmendmentReview.mockImplementation(
        (input: { previewPostRef: string }) =>
          new Promise((resolve) => {
            release = () =>
              resolve({ state: 'routed', conversationId: 'conv-review-3', previewPostRef: input.previewPostRef, next: 'await' });
          }),
      );
      const args = { ...patchArgs, requestReview: { workItemId: 'WI-9' } };

      const answered = await body(args);
      expect(answered).toMatchObject({
        ok: true,
        dryRun: true,
        pending: true,
        receipt: { rubricRef: 'acceptance-demo', poll: { tool: 'rubrics:amend-status' } },
      });
      const poll = answered.receipt.poll.args;
      const status = async () =>
        ((await amendStatusTool.handler(poll as never, {} as never)) as { data: Record<string, unknown> }).data;
      expect(await status()).toMatchObject({ state: 'running', source: 'receipt' });

      // A retry while it runs replays the same receipt: the preview is posted exactly once.
      expect((await body(args)).pending).toBe(true);
      expect(workItemMocks.commentWorkItem).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => expect(release).toBeDefined());
      release!();
      await vi.waitFor(async () => {
        expect(await status()).toMatchObject({
          source: 'receipt',
          result: { ok: true, dryRun: true, review: { previewPostRef: 'thread-post:78' } },
        });
      });
    } finally {
      delete process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS;
    }
  });

  it('deduplicates concurrent retries of the same normalized review request', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let resolveReview!: (value: Record<string, unknown>) => void;
    const reviewResult = new Promise<Record<string, unknown>>((resolve) => { resolveReview = resolve; });
    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementation(() => {
      markStarted();
      return reviewResult;
    });
    const args = { ...patchArgs, reviewPreviewPost: 'thread-post:42' };
    const retriedArgs = {
      ...args,
      criterion: { text: args.criterion.text, mode: args.criterion.mode, field: args.criterion.field, key: args.criterion.key },
    };

    const first = body(args);
    await started;
    const concurrentRetry = await body(retriedArgs);

    expect(concurrentRetry).toMatchObject({ ok: true, pending: true });
    expect(rubricsMocks.previewAcceptanceBarAmendment).toHaveBeenCalledTimes(1);
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(1);
    expect(receiptDb.rows.size).toBe(1);

    resolveReview({
      state: 'routed',
      conversationId: 'conv-review-retry',
      screenedOut: [],
      previewPostRef: 'thread-post:42',
      next: 'await reviewer',
    });
    const completed = await first;
    const replay = await body(retriedArgs);

    expect(completed).toMatchObject({ ok: true, review: { state: 'routed', conversationId: 'conv-review-retry' } });
    expect(replay).toEqual(completed);
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(1);
  });

  it.each(['expectedRubricRevision', 'expectedSubjectPlanRevision', 'idempotencyKey'] as const)(
    'does not replay a routed preview after %s changes', async field => {
      rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
      reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({ state: 'routed', conversationId: 'conv-current' });
      rubricsMocks.getRubric.mockResolvedValue({ revision: 3 });
      const args = { ...patchArgs, reviewPreviewPost: 'thread-post:42',
        expectedRubricRevision: 3, expectedSubjectPlanRevision: 8, idempotencyKey: 'request-a' };
      const first = await body(args);
      expect(await body({ ...args })).toEqual(first);
      const changed = await body({ ...args, [field]: field === 'idempotencyKey' ? 'request-b' : 9 });
      expect(changed.receipt.idempotencyKey).not.toBe(first.receipt.idempotencyKey);
      expect(rubricsMocks.previewAcceptanceBarAmendment).toHaveBeenCalledTimes(2);
      expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['rubric', 'subject'] as const)('remeasures live %s revision when preview expectations were omitted', async kind => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({ state: 'routed', conversationId: 'conv-current' });
    rubricsMocks.getRubric.mockResolvedValue({ revision: 3, workspaceId: 'subject-workspace',
      subjectPlan: 'subject-plan', subjectHarnessSlug: 'subject-harness' });
    planMocks.getPlanRow.mockResolvedValue({ version: 8 });
    const args = { ...patchArgs, reviewPreviewPost: 'thread-post:42' };
    const first = await body(args);
    expect(await body({ ...args })).toEqual(first);
    if (kind === 'rubric') rubricsMocks.getRubric.mockResolvedValue({ revision: 4, workspaceId: 'subject-workspace',
      subjectPlan: 'subject-plan', subjectHarnessSlug: 'subject-harness' });
    else planMocks.getPlanRow.mockResolvedValue({ version: 9 });
    const changed = await body(args);
    expect(changed.receipt.idempotencyKey).not.toBe(first.receipt.idempotencyKey);
    expect(planMocks.getPlanRow).toHaveBeenCalledWith('subject-plan', {
      workspaceId: 'subject-workspace', harnessSlug: 'subject-harness',
    });
    expect(rubricsMocks.previewAcceptanceBarAmendment).toHaveBeenCalledTimes(2);
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(2);
  });

  it('D-034: the actual handler and local relevance-router preserve the actionable review ahead of a large preview', async () => {
    const largePreview = {
      ...approvalRequired,
      changes: Array.from({ length: 180 }, (_, index) => ({
        barKey: `R-${index}`,
        kinds: ['bar-meaning'],
        fields: ['falsifier'],
        detail: `preview-${index} `.repeat(50),
      })),
    };
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(largePreview);

    const actualReview = await vi.importActual<typeof import('../../consult/acceptance-bar-amendment-review')>(
      '../../consult/acceptance-bar-amendment-review',
    );
    const candidates = [
      { ownerId: 'related-member', score: 0.95 },
      { ownerId: 'local-reviewer', score: 0.9 },
    ];
    const routeFixture = {
      verdict: 'routed',
      qualified: candidates,
      snapshot: { candidates },
    } as unknown as RouteResult;
    let selectedOwners: string[] = [];
    const feedback = async (
      _request: unknown,
      _identity: unknown,
      options: { filterRoute: (route: RouteResult) => Promise<RouteResult> },
    ) => {
      const filtered = await options.filterRoute(routeFixture);
      selectedOwners = filtered.qualified.map((candidate) => candidate.ownerId);
      return {
        verdict: 'routed',
        conversation_id: 'conv-local-review',
        responder: { ownerId: selectedOwners[0] },
      };
    };

    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementationOnce((input) =>
      actualReview.openAcceptanceBarAmendmentReview(input as never, {
        verifyPreviewPost: async () => undefined,
        route: (routeInput) => actualReview.routeAcceptanceBarAmendmentReview(routeInput, {
          resolveScreen: async () => ({
            check: async (ownerId) => ownerId === 'related-member'
              ? { eligible: false, reason: 'related_to_plan_implementer' }
              : { eligible: true, reason: 'eligible' },
          }),
          feedback: feedback as never,
        }),
      }),
    );

    const args = { ...patchArgs, reviewPreviewPost: 'thread-post:42' };
    const response = await amendTool.handler(args as never, {} as never);
    expect(response).toHaveProperty('data');
    const tiered = applyPayloadTier({
      toolName: 'rubrics:amend',
      shape: amendTool.shape,
      response: response as never,
      tier: 'trimmed',
      args,
    });
    const shaped = tiered.data as Record<string, any>;

    expect(selectedOwners).toEqual(['local-reviewer']);
    expect(shaped).toMatchObject({
      ok: true,
      dryRun: true,
      review: {
        state: 'routed',
        conversationId: 'conv-local-review',
        previewPostRef: 'thread-post:42',
        next: expect.stringContaining("events:await { event:'consult:reply:conv-local-review' }"),
      },
    });
    expect(shaped._projection).toMatchObject({ kind: 'bounded-payload', truncated: true });
    expect(shaped.preview.changes.length).toBeLessThan(largePreview.changes.length);
    expect(JSON.stringify(shaped).length).toBeLessThan(JSON.stringify((response as any).data).length);
    expect(JSON.stringify(shaped).length).toBeLessThanOrEqual(5_000);
  });

  it('returns a structured refusal when the requested reviewer model is outside the workspace allowlist', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    const error = new Error(
      'reviewer_model_not_allowed: codex/gpt-6-sol is absent from the workspace expert allowlist',
    );
    reviewMocks.openAcceptanceBarAmendmentReview.mockRejectedValueOnce(error);

    const result = await body({
      ...patchArgs,
      reviewPreviewPost: 'thread-post:42',
      reviewerModel: { agent: 'codex', model: 'gpt-6-sol' },
    });

    expect(result).toMatchObject({
      ok: false,
      dryRun: true,
      code: 'reviewer_model_not_allowed',
      error: error.message,
      next: expect.stringContaining('workspace expert model allowlist'),
    });
    expect(JSON.stringify(z.toJSONSchema(amendTool.args as never))).toContain(
      'workspace expert-model allowlist entry',
    );

    const unrelated = new Error('unexpected review failure');
    reviewMocks.openAcceptanceBarAmendmentReview.mockRejectedValueOnce(unrelated);
    await expect(body({
      ...patchArgs,
      reviewPreviewPost: 'thread-post:42',
      reviewerModel: { agent: 'codex', model: 'gpt-6-sol-next' },
    })).rejects.toThrow(unrelated.message);
  });

  it('an approval-required dry run without a preview post says how to open the routed review, not whom to message', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);

    const result = await body(patchArgs);

    expect(result.review.state).toBe('not-requested');
    expect(result.review.next).toContain("reviewPreviewPost:'thread-post:");
    expect(result.review.next).not.toMatch(/coord:send/);
    expect(result.review.next).toContain('one-agent/no-additional-agents implementation route');
    expect(result.review.next).toContain('no owner exception is needed');
    expect(result.review.next).toContain('requestReview');
    expect(reviewMocks.openAcceptanceBarAmendmentReview).not.toHaveBeenCalled();
  });

  it('a dry run that needs no approval carries no review', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({ ...approvalRequired, approvalRequired: false });

    const result = await body(patchArgs);

    expect(result).toMatchObject({ ok: true, dryRun: true, preview: { ...approvalRequired, approvalRequired: false }, receipt: { registered: true } });
  });

  it('refuses reviewPreviewPost outside a dry run', () => {
    const { dryRun: _dryRun, ...applyArgs } = patchArgs;
    const parsed = rubricsAmendArgs.safeParse({ ...applyArgs, reviewPreviewPost: 'thread-post:42' });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain('requires dryRun:true');
  });

  it('passes an explicit reviewer model to the routed review and requires a preview post', async () => {
    const reviewerModel = { agent: 'codex', model: 'sol', effort: 'xhigh' };
    expect(rubricsAmendArgs.safeParse({ ...patchArgs, reviewerModel }).success).toBe(false);
    expect(rubricsAmendArgs.safeParse({
      ...patchArgs, reviewPreviewPost: 'thread-post:42',
      reviewerModel: { ...reviewerModel, model: 'sol; unexpected-flag' },
    }).success).toBe(false);
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({
      state: 'routed', conversationId: 'conv-model', responderId: 'reviewer',
      screenedOut: [], previewPostRef: 'thread-post:42', next: 'await reviewer',
    });
    await body({ ...patchArgs, reviewPreviewPost: 'thread-post:42', reviewerModel });
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledWith(
      expect.objectContaining({ reviewerModel }),
    );
  });

  it('re-reviews a retained preview with evidence using a distinct receipt and reuses that receipt on retry', async () => {
    const request = { ...patchArgs, reviewPreviewPost: 'thread-post:42' };
    const evidence = { ...request, reviewEvidencePost: 'thread-post:50' };
    expect(rubricsAmendArgs.safeParse({ ...patchArgs, reviewEvidencePost: 'thread-post:50' }).success).toBe(false);
    expect(rubricsAmendArgs.safeParse({ ...evidence, dryRun: false }).success).toBe(false);
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValue({ state: 'routed', conversationId: 'conv-evidence',
      responderId: 'reviewer', screenedOut: [], previewPostRef: 'thread-post:42', next: 'await reviewer' });
    const original = await body(request);
    const rereview = await body(evidence);
    const retry = await body(evidence);
    expect(original.receipt.idempotencyKey).not.toBe(rereview.receipt.idempotencyKey);
    expect(retry.receipt.idempotencyKey).toBe(rereview.receipt.idempotencyKey);
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(2);
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenLastCalledWith(expect.objectContaining({
      previewPostRef: 'thread-post:42', reviewEvidencePost: 'thread-post:50' }));
  });

  it('no amend or check-approver guidance tells the implementer to message a reviewer directly (D-001)', async () => {
    const { default: checkApproverTool } = await import('./check-approver');
    const rendered = JSON.stringify([
      { description: amendTool.description, guidance: amendTool.guidance, args: z.toJSONSchema(amendTool.args as never) },
      { description: checkApproverTool.description, guidance: checkApproverTool.guidance },
    ]);
    expect(rendered).not.toContain('coord:send');
    expect(rendered).not.toMatch(/send (it|its post id|the post|a pointer)[^.]*reviewer/i);
    expect(rendered).not.toMatch(/route only eligible candidates/i);
  });
});

describe('rubrics:amend receipts (RSR-P-008-C)', () => {
  const statusBody = async (args: unknown) =>
    ((await amendStatusTool.handler(args as never, {} as never)) as { data: Record<string, unknown> }).data;
  const amendArgs = { rubricRef: 'acceptance-example', criteria: [criterion], reason: 'Refresh the procedure.' };
  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  beforeEach(() => {
    receiptDb.rows.clear();
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue(null);
    rubricsMocks.rubricCompleteness.mockReturnValue({ complete: true });
    rubricsMocks.getRubric.mockResolvedValue({ revision: 3 });
    process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS = '20';
  });
  afterEach(() => {
    delete process.env.PAPERCUSP_RUBRICS_AMEND_FOREGROUND_MS;
  });

  it('a fast amend answers synchronously and names the receipt key it minted', async () => {
    rubricsMocks.amendRubric.mockResolvedValue({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    const result = await body(amendArgs);
    expect(result).toMatchObject({ ok: true, idempotencyKey: 'amend-minted-key' });
    expect(result.pending).toBeUndefined();
    // The minted key is what the amendment commits under, so its Decision can be found by it.
    expect(rubricsMocks.amendRubric).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'amend-minted-key' }));
    expect(rubricsMocks.mintAmendmentIdempotencyKey).toHaveBeenCalledWith(expect.anything(), 3);
  });

  it('keeps a caller-supplied key instead of minting one', async () => {
    rubricsMocks.amendRubric.mockResolvedValue({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    const result = await body({ ...amendArgs, idempotencyKey: 'caller-key' });
    expect(result.idempotencyKey).toBe('caller-key');
    expect(rubricsMocks.mintAmendmentIdempotencyKey).not.toHaveBeenCalled();
  });

  it('a slow amend returns a receipt instead of timing out, and the receipt polls to committed', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);

    const answered = await body(amendArgs);
    expect(answered).toMatchObject({
      ok: true,
      pending: true,
      receipt: {
        idempotencyKey: 'amend-minted-key',
        rubricRef: 'acceptance-example',
        poll: { tool: 'rubrics:amend-status', args: { rubricRef: 'acceptance-example', idempotencyKey: 'amend-minted-key' } },
      },
    });

    expect(await statusBody(answered.receipt.poll.args)).toMatchObject({ ok: true, state: 'running', source: 'receipt' });

    slow.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    await vi.waitFor(async () => {
      expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
        state: 'committed',
        source: 'receipt',
        result: { ok: true, rubric: { rubricId: 'acceptance-example' } },
      });
    });
  });

  it('a different worker reads the running receipt and a same-key retry does not start another amend', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);
    const first = await body({ ...amendArgs, idempotencyKey: 'shared-key' });
    expect(first.pending).toBe(true);

    // A fresh module registry models a second worker. The mocked PG rows survive
    // independently of either module's process-local state.
    vi.resetModules();
    const workerB = (await import('./amend-status')).default;
    const status = ((await workerB.handler({ rubricRef: 'acceptance-example', idempotencyKey: 'shared-key' } as never, {} as never)) as { data: Record<string, unknown> }).data;
    expect(status).toMatchObject({ state: 'running', source: 'receipt' });

    const retry = await body({ ...amendArgs, idempotencyKey: 'shared-key' });
    expect(retry.pending).toBe(true);
    expect(rubricsMocks.amendRubric).toHaveBeenCalledTimes(1);
    slow.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    await vi.waitFor(async () => {
      expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'shared-key' }))
        .toMatchObject({ state: 'committed', source: 'receipt' });
    });
  });

  it('reports a committed Decision when its worker left a running receipt behind', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);
    const first = await body({ ...amendArgs, idempotencyKey: 'stranded-key' });
    expect(first.pending).toBe(true);
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue({
      decisionId: 'D-42', subjectPlan: 'example-plan',
    });
    expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'stranded-key' }))
      .toMatchObject({ state: 'committed', source: 'decision', decisionId: 'D-42' });
    slow.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
  });

  it('a slow amend that then fails polls to failed with the error, never to committed', async () => {
    const slow = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValue(slow.promise);
    const answered = await body(amendArgs);
    slow.reject(new Error('acceptance_bar_amendment_conflict'));
    await vi.waitFor(async () => {
      expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
        state: 'failed',
        error: 'acceptance_bar_amendment_conflict',
      });
    });
  });

  it('separate slow preview-only dry runs get fresh pollable receipts without applying the amendment', async () => {
    const slow = deferred<unknown>();
    const secondSlow = deferred<unknown>();
    rubricsMocks.previewAcceptanceBarAmendment
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(secondSlow.promise);

    const answered = await body({ ...amendArgs, dryRun: true, approvedBy: 'outside-reviewer' });
    expect(answered).toMatchObject({
      ok: true,
      dryRun: true,
      pending: true,
      receipt: {
        rubricRef: 'acceptance-example',
        poll: { tool: 'rubrics:amend-status', args: { rubricRef: 'acceptance-example' } },
      },
    });
    expect(answered.receipt.idempotencyKey).toMatch(/^preview-/);
    expect(rubricsMocks.amendRubric).not.toHaveBeenCalled();
    expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
      state: 'running',
      source: 'receipt',
    });

    const separatelyRequested = await body({ ...amendArgs, dryRun: true, approvedBy: 'outside-reviewer' });
    expect(separatelyRequested.receipt.idempotencyKey).toMatch(/^preview-/);
    expect(separatelyRequested.receipt.idempotencyKey).not.toBe(answered.receipt.idempotencyKey);

    slow.resolve({ changedBars: ['R-1'] });
    secondSlow.resolve({ changedBars: ['R-1'] });
    await vi.waitFor(async () => {
      expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
        state: 'previewed',
        source: 'receipt',
        result: { ok: true, dryRun: true, preview: { changedBars: ['R-1'] } },
      });
    });
  });

  it('after a restart (no in-process receipt) the committed Decision still answers committed', async () => {
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue({
      decisionId: 'D-007',
      subjectPlan: 'subject-plan',
      subjectHarnessSlug: 'papercusp',
    });
    expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'amend-lost' })).toMatchObject({
      state: 'committed',
      source: 'decision',
      decisionId: 'D-007',
    });
  });

  it('with neither a receipt nor a Decision it answers not_found and says a same-key retry is safe', async () => {
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue(null);
    const status = await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'amend-unknown' });
    expect(status).toMatchObject({ state: 'not_found', source: 'none' });
    expect(status.note).toMatch(/same rubrics:amend with this idempotencyKey is safe/);
  });
});
