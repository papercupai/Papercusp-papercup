import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { applyPayloadTier } from '@papercusp/tooldef';
import { dispatchProjectedTool, lookupByMcpName, readJsonResult } from '@papercusp/agent-mcp';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { applyResultDoor } from '../../result-door';
import { parseScratchReference } from '../../scratch-reference';
import { safeScratchFilesystemPath } from '../../scratch-uri';
import { readProcessIdentity } from '../../process-identity';
import { AcceptanceBarCandidateError } from '../../acceptance-bar-projection';

const doorConstants = vi.hoisted(() => vi.fn());
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstants }));

const rubricsMocks = vi.hoisted(() => ({
  amendRubric: vi.fn(),
  autoRatifyRubricOnFirstScorecard: vi.fn().mockResolvedValue(null),
  previewAcceptanceBarAmendment: vi.fn(),
  rubricCompleteness: vi.fn(),
  getRubric: vi.fn(),
  applyRubricAmendment: vi.fn(),
  mintAmendmentIdempotencyKey: vi.fn(() => 'amend-minted-key'),
  findAmendmentDecisionByKey: vi.fn(),
}));

const reviewMocks = vi.hoisted(() => ({
  inspectFreshAmendmentReviewer: vi.fn(),
  openAcceptanceBarAmendmentReview: vi.fn(),
}));
const planMocks = vi.hoisted(() => ({ getPlanRow: vi.fn() }));
const runtimeMocks = vi.hoisted(() => ({
  hostIdentity: vi.fn(() => 'pid-test'),
  guardResource: vi.fn(),
  heartbeat: vi.fn(),
  held: new Set<string>(),
  terminalWrite: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('../../serving-host-identity', () => ({ hostIdentity: runtimeMocks.hostIdentity }));
vi.mock('../locks/identity', () => ({
  readIdentity: () => ({ ownerId: 'amend-test', ownerLabel: 'amend test' }),
}));
vi.mock('../locks/coordination-domain', () => ({
  resourceLockDomain: (resource: string) => `host-global:${resource}`,
}));
vi.mock('../locks/resource-lock-guard', () => ({ guardResource: runtimeMocks.guardResource }));
vi.mock('../locks/su-lock-store', () => ({ heartbeatSharedResourceAtomic: runtimeMocks.heartbeat }));
vi.mock('../plans/source', () => ({ getPlanRow: planMocks.getPlanRow }));
const workItemMocks = vi.hoisted(() => ({ commentWorkItem: vi.fn(), getWorkItemsByIds: vi.fn() }));
const receiptDb = vi.hoisted(() => {
  type Row = { idempotency_key: string; rubric_ref: string; state: string; started_at: Date; finished_at: Date | null; result_json: Record<string, unknown> | null; error: string | null; executor_host?: string; executor_pid?: number; executor_process_id?: string };
  const rows = new Map<string, Row>();
  const progressControl = {
    beforeWrite: undefined as (() => Promise<void>) | undefined,
    afterWrite: undefined as (() => void) | undefined,
  };
  const progressWrites = { count: 0 };
  const sql = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    // postgres' bulk insert helper is called before its tagged statement.
    if (!Array.isArray(parts) || !('raw' in parts)) return [];
    const query = parts.join('?');
    if (query.includes('INSERT INTO harness_shared.fallback_observations')) return [];
    if (query.includes('DELETE FROM harness_shared.rubric_amend_receipts')) return [];
    if (query.includes('INSERT INTO harness_shared.rubric_amend_receipts')) {
      const [workspace, rubric, key] = values as string[];
      const id = `${workspace}:${rubric}:${key}`;
      if (rows.has(id)) return [];
      rows.set(id, { idempotency_key: key!, rubric_ref: rubric!, state: 'running', started_at: new Date(), finished_at: null,
        result_json: values[6] ? JSON.parse(String(values[6])) : null, error: null });
      return [{ idempotency_key: key }];
    }
    if (query.includes('SELECT idempotency_key')) {
      const [workspace, rubric, key] = values as string[];
      const row = rows.get(`${workspace}:${rubric}:${key}`);
      return row ? [row] : [];
    }
    if (query.includes('UPDATE harness_shared.rubric_amend_receipts')) {
      if (query.includes('SET result_json = jsonb_set(')) {
        progressWrites.count++;
        await progressControl.beforeWrite?.();
        const [snapshot, workspace, rubric, key, token] = values as string[];
        const row = rows.get(`${workspace}:${rubric}:${key}`);
        if (row && (!query.includes("AND state = 'running'") || row.state === 'running')
          && (!query.includes("AND result_json->>'_progressRun'") || row.result_json?._progressRun === token)) {
          row.result_json = { ...row.result_json, progress: JSON.parse(snapshot!) };
          progressControl.afterWrite?.();
          return [{ idempotency_key: key }];
        }
        progressControl.afterWrite?.();
        return [];
      }
      if (query.includes("SET state = 'running'") && query.includes("AND (state = 'failed'")) {
        const [initialResult, workspace, rubric, key, inspected, taskId, nativeRef, previewPostRef] = values;
        const row = rows.get(`${workspace}:${rubric}:${key}`);
        const review = row?.result_json?.review as Record<string, unknown> | undefined;
        const reviewer = review?.freshReviewer as Record<string, unknown> | undefined;
        const failed = row?.state === 'failed';
        const unstaffed = row?.state === 'previewed'
          && review?.state === 'no-eligible-reviewer' && reviewer?.state !== 'launched';
        const inspectedReviewer = row?.state === 'previewed' && inspected === true
          && review?.state === 'no-eligible-reviewer' && reviewer?.state === 'launched'
          && reviewer.taskId === taskId && (reviewer.nativeRef ?? null) === nativeRef
          && review?.previewPostRef === previewPostRef;
        if (row && (failed || unstaffed || inspectedReviewer)) {
          row.state = 'running';
          row.result_json = initialResult ? JSON.parse(String(initialResult)) : null;
          row.error = null;
          row.started_at = new Date();
          row.finished_at = null;
          return [{ idempotency_key: key }];
        }
        return [];
      }
      const failed = query.includes("SET state = 'failed'");
      if (query.includes('SET state =')) await runtimeMocks.terminalWrite?.();
      const [workspace, rubric, key] = values.slice(failed ? 2 : 3) as string[];
      const row = rows.get(`${workspace}:${rubric}:${key}`);
      if (row) {
        if (query.includes('AND (NOT') && values.at(-2) === true
          && (row.state !== 'running' || row.result_json?._progressRun !== values.at(-1))) return [];
        row.state = failed ? 'failed' : String(values[0]);
        row.result_json = JSON.parse(String(values[1]));
        row.error = failed ? String(values[0]) : values[2] as string | null;
        row.finished_at = new Date();
      }
      return [];
    }
    throw new Error(`unexpected receipt SQL: ${query}`);
  });
  return { rows, sql, progressControl, progressWrites };
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
  inspectFreshAmendmentReviewer: reviewMocks.inspectFreshAmendmentReviewer,
  openAcceptanceBarAmendmentReview: reviewMocks.openAcceptanceBarAmendmentReview,
}));
vi.mock('../../work-items', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-items')>(),
  commentWorkItem: workItemMocks.commentWorkItem,
  getWorkItemsByIds: workItemMocks.getWorkItemsByIds,
}));
vi.mock('../../rubrics', () => ({
  AMENDABLE_CRITERION_FIELDS: ['title', 'model', 'method', 'driftMarkers', 'replication'],
  amendRubric: rubricsMocks.amendRubric,
  autoRatifyRubricOnFirstScorecard: rubricsMocks.autoRatifyRubricOnFirstScorecard,
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

afterEach(() => workItemMocks.commentWorkItem.mockReset());

beforeEach(() => {
  vi.clearAllMocks();
  reviewMocks.inspectFreshAmendmentReviewer.mockReset().mockResolvedValue({ state: 'unknown' });
  runtimeMocks.hostIdentity.mockReturnValue('pid-test');
  runtimeMocks.held.clear();
  runtimeMocks.terminalWrite = undefined;
  runtimeMocks.heartbeat.mockReset().mockResolvedValue({ extended: true, expires_ts: new Date() });
  runtimeMocks.guardResource.mockReset().mockImplementation(async (spec, run) => {
    runtimeMocks.held.add(spec.ownerId);
    try {
      return { acquired: true, result: await run({ lockId: spec.ownerId }), lock_id: spec.ownerId };
    } finally {
      runtimeMocks.held.delete(spec.ownerId);
    }
  });
  rubricsMocks.applyRubricAmendment.mockReset();
  receiptDb.rows.clear();
  receiptDb.progressControl.beforeWrite = undefined;
  receiptDb.progressControl.afterWrite = undefined;
  receiptDb.progressWrites.count = 0;
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
    expect(amendStatusTool.description).toContain('does not prove a requestReview');
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

  it('dispatches no review for a failed whole candidate and dispatches once after correction', async () => {
    const invalid = new AcceptanceBarCandidateError({ criteria: [criterion] }, [
      'AUTO-BAR-R-1-P-001.falsifier: observation_empty',
      'criteria.0.check.cases: invalid case',
      'criteria.0.requiredScope: invalid scope',
    ]);
    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(invalid);
    const request = {
      rubricRef: 'acceptance-whole-candidate', dryRun: true, criteria: [criterion],
      requestReview: { workItemId: 'WI-9', harness: 'papercusp' },
    };
    expect(await body(request)).toMatchObject({
      ok: false, dryRun: true, code: 'acceptance_bar_candidate_invalid',
      candidateValidation: invalid.candidateValidation,
    });
    expect(workItemMocks.commentWorkItem).not.toHaveBeenCalled();
    expect(reviewMocks.openAcceptanceBarAmendmentReview).not.toHaveBeenCalled();

    const corrected = { ...criterion, driftMarkers: 'The canonical BAR is missing.' };
    const preview = {
      approvalRequired: true, approval: { schemaVersion: 1, rubricRef: request.rubricRef, bars: [] },
      candidateValidation: { candidateHash: 'a'.repeat(64), generatedSpecCount: 1 },
    };
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValueOnce(preview);
    workItemMocks.commentWorkItem.mockResolvedValueOnce({ id: 901 });
    reviewMocks.openAcceptanceBarAmendmentReview.mockResolvedValueOnce({ state: 'routed', previewPostRef: 'thread-post:901' });
    expect(await body({ ...request, criteria: [corrected] })).toMatchObject({ ok: true, preview });
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(1);
    expect(workItemMocks.commentWorkItem).toHaveBeenCalledTimes(1);
    expect(reviewMocks.openAcceptanceBarAmendmentReview.mock.calls[0]![0]).toMatchObject({ preview });
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

  it('returns acceptance BAR check-layer mismatches as structured refusals', async () => {
    const error = new Error(
      'acceptance_bar_amendment_check_layer_mismatch: R-5: a manual check cannot declare required test layers',
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
      code: 'acceptance_bar_amendment_check_layer_mismatch',
      error: error.message,
      next: expect.stringContaining('Correct the acceptance BAR contract'),
    });

    rubricsMocks.amendRubric.mockRejectedValueOnce(error);
    const applyResult = await body({
      rubricRef: 'acceptance-example',
      idempotencyKey: 'check-layer-mismatch-apply',
      criteria: [criterion],
    });

    expect(applyResult).toMatchObject({
      ok: false,
      code: 'acceptance_bar_amendment_check_layer_mismatch',
      error: error.message,
      next: expect.stringContaining('Correct the acceptance BAR contract'),
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
      requestReview: { workItemId: 'WI-9' },
    });

    expect(result).toEqual({
      ok: false,
      dryRun: true,
      code: 'rubric_not_found',
      error: "no rubric 'missing-rubric' — rubrics:list to see refs",
      rubricRef: 'missing-rubric',
    });
    expect(workItemMocks.commentWorkItem).not.toHaveBeenCalled();
    expect(reviewMocks.openAcceptanceBarAmendmentReview).not.toHaveBeenCalled();
  });

  it('reports a retryable read failure before posting or launching an amendment review', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockRejectedValueOnce(
      new Error("rubric_read_failed: could not read rubric 'active-rubric'"),
    );

    const result = await body({
      rubricRef: 'active-rubric',
      dryRun: true,
      criterion: { key: 'r-1', field: 'method', mode: 'append', text: 'Run the focused check.' },
      requestReview: { workItemId: 'WI-9' },
    });

    expect(result).toMatchObject({
      ok: false,
      dryRun: true,
      code: 'rubric_read_failed',
      rubricRef: 'active-rubric',
      retryable: true,
    });
    expect(result.next).toContain('Retry');
    expect(workItemMocks.commentWorkItem).not.toHaveBeenCalled();
    expect(reviewMocks.openAcceptanceBarAmendmentReview).not.toHaveBeenCalled();
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

  it('surfaces terminal dependency scope mismatch after amendment and accepts the owned pending correction', async () => {
    rubricsMocks.rubricCompleteness.mockReturnValue({ complete: true });
    for (const [dependencyId, state, shouldWarn] of [
      ['WI-6554700010014915', 'done', true],
      ['WI-6554700010023061', 'open', false],
    ] as const) {
      const method = `Missing detector branches remain unknown. Their implementation dependency is ${dependencyId}, assigned to the leader.`;
      const item = { ...criterion, key: 'r-6', barKey: 'R-6', method };
      workItemMocks.getWorkItemsByIds.mockResolvedValue([{
        id: dependencyId, state,
        terminalCompletionEvidence: state === 'done' ? { coverage: { checked: ['R1 scope detector', 'R9 deployment detector'] } } : null,
      }]);
      rubricsMocks.amendRubric.mockResolvedValue({
        rubricId: 'acceptance-example', kind: 'acceptance', subjectHarnessSlug: 'papercusp', criteria: [item], methodRef: null,
      });
      const result = await body({ rubricRef: 'acceptance-example', criteria: [item], reason: 'Correct implementation dependency.', idempotencyKey: `dependency-${dependencyId}` });
      expect(result.ok).toBe(true);
      expect(result.methodLint).toEqual(shouldWarn ? [expect.objectContaining({
        code: 'acceptance-method-dependency-coverage', criterionKey: 'r-6', dependencyId,
      })] : []);
    }
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

  it('retains the same approval comment key when the worker loses its receipt after posting', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    const posts = new Map<string, number>();
    workItemMocks.commentWorkItem.mockImplementation(async (_id, _body, _author, opts) => {
      const key = opts.idempotencyKey ?? `unkeyed-${posts.size}`;
      if (!posts.has(key)) posts.set(key, 80 + posts.size);
      return { id: posts.get(key) };
    });
    reviewMocks.openAcceptanceBarAmendmentReview.mockRejectedValueOnce(new Error('worker died after approval post'));
    const args = { ...patchArgs, requestReview: { workItemId: 'WI-9' } };
    await expect(body(args)).rejects.toThrow('worker died after approval post');
    // The thread write survived; the executor's receipt did not. Recovery must
    // reuse the durable comment identity before it starts review again.
    receiptDb.rows.clear();
    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementation(async input => ({
      state: 'routed', conversationId: 'conv-recovered', previewPostRef: input.previewPostRef,
    }));
    const recovered = await body(args);
    expect(posts.size).toBe(1);
    expect(recovered.review.previewPostRef).toBe('thread-post:80');
    const keys = workItemMocks.commentWorkItem.mock.calls.map(call => call[3].idempotencyKey);
    expect(keys[0]).toMatch(/^review-/);
    expect(keys[1]).toBe(keys[0]);
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
      candidateValidation: { candidateHash: 'a'.repeat(64), generatedSpecCount: 1 },
      rubricRevision: 4,
      subjectPlanRevision: 9,
      approval: { ...approvalRequired.approval, subjectPlan: 'acceptance-subject' },
      changes: Array.from({ length: 180 }, (_, index) => ({
        barKey: `R-${index}`,
        kinds: ['bar-meaning'],
        fields: ['falsifier'],
        detail: `preview-${index} `.repeat(50),
      })),
    };
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(largePreview);
    rubricsMocks.getRubric.mockResolvedValue({
      rubricId: 'acceptance-demo',
      revision: 4,
      subjectPlan: 'acceptance-subject',
      subjectHarnessSlug: 'papercusp',
      criteria: [criterion],
    });
    planMocks.getPlanRow.mockResolvedValue({
      planSlug: 'acceptance-subject',
      harnessSlug: 'papercusp',
      version: 9,
      content: '## Requirements\n\nR-1 — Acceptance review fixture.',
      contentHash: 'acceptance-subject-fixture',
    });

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
      'workspace expert-model allowlist',
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

  it('reclaims a failed retained reviewer without reposting its original approval', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    workItemMocks.commentWorkItem.mockResolvedValue({ id: 77 });
    reviewMocks.openAcceptanceBarAmendmentReview
      .mockResolvedValueOnce({ state: 'no-eligible-reviewer', previewPostRef: 'thread-post:77',
        freshReviewer: { state: 'launched', taskId: 'reviewer-old', ownerId: 'reviewer-1', nativeRef: '/retained/reviewer-old.jsonl' } })
      .mockResolvedValueOnce({ state: 'no-eligible-reviewer', previewPostRef: 'thread-post:77',
        freshReviewer: { state: 'launched', taskId: 'reviewer-new', ownerId: 'reviewer-2', nativeRef: '/retained/reviewer-new.jsonl' } });
    reviewMocks.inspectFreshAmendmentReviewer.mockResolvedValue({
      state: 'reclaimable', taskId: 'reviewer-old', nativeRef: '/retained/reviewer-old.jsonl',
    });
    const args = { ...patchArgs, requestReview: { workItemId: 'WI-9', harness: 'papercusp' } };

    const first = await body(args);
    const retried = await body(args);

    expect(first.review).toMatchObject({ previewPostRef: 'thread-post:77', freshReviewer: { taskId: 'reviewer-old' } });
    expect(retried.review).toMatchObject({ previewPostRef: 'thread-post:77', freshReviewer: { taskId: 'reviewer-new' } });
    expect(reviewMocks.inspectFreshAmendmentReviewer).toHaveBeenCalledWith({
      workspaceId: 'ws-amend-test',
      previewPostRef: 'thread-post:77',
      reviewer: expect.objectContaining({ taskId: 'reviewer-old', nativeRef: '/retained/reviewer-old.jsonl' }),
    });
    expect(workItemMocks.commentWorkItem).toHaveBeenCalledTimes(1);
    expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ previewPostRef: 'thread-post:77' }));
  });

  it('keeps the new evidence boundary when reclaiming a retained re-review receipt', async () => {
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue(approvalRequired);
    reviewMocks.openAcceptanceBarAmendmentReview
      .mockResolvedValueOnce({ state: 'no-eligible-reviewer', previewPostRef: 'thread-post:42',
        freshReviewer: { state: 'launched', taskId: 'reviewer-old', ownerId: 'reviewer-1' } })
      .mockResolvedValueOnce({ state: 'no-eligible-reviewer', previewPostRef: 'thread-post:42',
        freshReviewer: { state: 'launched', taskId: 'reviewer-new', ownerId: 'reviewer-2' } });
    reviewMocks.inspectFreshAmendmentReviewer.mockResolvedValue({ state: 'reclaimable', taskId: 'reviewer-old' });
    const args = { ...patchArgs, reviewPreviewPost: 'thread-post:42', reviewEvidencePost: 'thread-post:50' };
    await body(args);
    const retried = await body(args);
    expect(retried.review).toMatchObject({ freshReviewer: { taskId: 'reviewer-new' } });
    expect(reviewMocks.inspectFreshAmendmentReviewer).toHaveBeenCalledWith(expect.objectContaining({
      previewPostRef: 'thread-post:42', reviewEvidencePost: 'thread-post:50' }));
    expect(workItemMocks.commentWorkItem).not.toHaveBeenCalled();
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

  it('reports current fresh-reviewer health without rewriting the retained launch receipt', async () => {
    const idempotencyKey = 'reviewer-health-status';
    const result = {
      ok: true,
      dryRun: true,
      review: {
        state: 'no-eligible-reviewer',
        previewPostRef: 'thread-post:42',
        reviewEvidencePost: 'thread-post:50',
        freshReviewer: {
          state: 'launched',
          taskId: 'reviewer-1',
          ownerId: 'reviewer-owner',
          nativeRef: '/retained/reviewer-1.jsonl',
        },
      },
    };
    const key = 'ws-amend-test:acceptance-example:' + idempotencyKey;
    const row = {
      idempotency_key: idempotencyKey,
      rubric_ref: 'acceptance-example',
      state: 'previewed',
      started_at: new Date(),
      finished_at: new Date(),
      result_json: result,
      error: null,
    };
    receiptDb.rows.set(key, row);
    reviewMocks.inspectFreshAmendmentReviewer.mockResolvedValue({
      state: 'reclaimable',
      taskId: 'reviewer-1',
      taskState: 'running',
      reason: 'provider-error',
      evidence: 'gateway returned 429: all accounts throttled',
    });

    const status = await statusBody({ rubricRef: 'acceptance-example', idempotencyKey });

    expect(status).toMatchObject({
      state: 'previewed',
      source: 'receipt',
      freshReviewerHealth: {
        state: 'reclaimable',
        reason: 'provider-error',
        evidence: 'gateway returned 429: all accounts throttled',
      },
      note: expect.stringContaining('same idempotency key and original arguments'),
    });
    expect(reviewMocks.inspectFreshAmendmentReviewer).toHaveBeenCalledWith({
      workspaceId: 'ws-amend-test',
      previewPostRef: 'thread-post:42',
      reviewEvidencePost: 'thread-post:50',
      reviewer: result.review.freshReviewer,
    });
    expect(row.result_json).toEqual(result);
  });

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

  it.each(['apply', 'preview'] as const)('holds the runtime lease after a pending %s response through terminal receipt persistence', async (kind) => {
    runtimeMocks.hostIdentity.mockReturnValue('port-3170');
    const slow = deferred<any>();
    const terminalWrite = deferred<void>();
    const writing = deferred<void>();
    runtimeMocks.terminalWrite = () => { writing.resolve(); return terminalWrite.promise; };
    if (kind === 'apply') rubricsMocks.amendRubric.mockReturnValue(slow.promise);
    else rubricsMocks.previewAcceptanceBarAmendment.mockReturnValue(slow.promise);
    const answered = await body({ ...amendArgs, ...(kind === 'preview' ? { dryRun: true } : {}) });
    expect(answered).toMatchObject({ pending: true, receipt: { registered: true } });
    expect(runtimeMocks.held.size).toBe(1);
    slow.resolve(kind === 'apply'
      ? { rubricId: 'acceptance-example', kind: 'standard', criteria: [] }
      : { approvalRequired: false });
    await writing.promise;
    expect(runtimeMocks.held.size).toBe(1);
    expect([...receiptDb.rows.values()][0]!.state).toBe('running');
    terminalWrite.resolve();
    await vi.waitFor(() => expect(runtimeMocks.held.size).toBe(0));
    expect([...receiptDb.rows.values()][0]!.state).toBe(kind === 'apply' ? 'committed' : 'previewed');
  });

  it('releases the runtime lease after an execution failure has persisted its failed receipt', async () => {
    runtimeMocks.hostIdentity.mockReturnValue('port-3170');
    rubricsMocks.amendRubric.mockRejectedValue(new Error('amend failed'));
    runtimeMocks.terminalWrite = async () => { expect(runtimeMocks.held.size).toBe(1); };
    await expect(body(amendArgs)).rejects.toThrow('amend failed');
    expect([...receiptDb.rows.values()][0]!.state).toBe('failed');
    expect(runtimeMocks.held.size).toBe(0);
  });

  it.each([false, true])('does not register or execute an amendment when the runtime is draining (preview=%s)', async (dryRun) => {
    runtimeMocks.hostIdentity.mockReturnValue('port-3170');
    runtimeMocks.guardResource.mockResolvedValue({ acquired: false, reason: 'draining', holders: [] });
    expect(await body({ ...amendArgs, dryRun })).toMatchObject({
      ok: false, code: 'amendment_runtime_unavailable', reason: 'resource_draining', resource: 'staging-server',
    });
    expect(receiptDb.rows.size).toBe(0);
    expect(rubricsMocks.amendRubric).not.toHaveBeenCalled();
    expect(rubricsMocks.previewAcceptanceBarAmendment).not.toHaveBeenCalled();
  });

  it.each([
    ['port-3170', 'staging-server'], ['port-3070', 'dev-server'],
    ['port-3270', null], ['pid-test', null],
  ] as const)('protects only the actual serving operator runtime (%s)', async (host, resource) => {
    runtimeMocks.hostIdentity.mockReturnValue(host);
    rubricsMocks.amendRubric.mockResolvedValue({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    expect(await body(amendArgs)).toMatchObject({ ok: true });
    if (resource === null) expect(runtimeMocks.guardResource).not.toHaveBeenCalled();
    else expect(runtimeMocks.guardResource).toHaveBeenCalledWith(expect.objectContaining({
      coordinationDomain: `host-global:${resource}`, resource, mode: 'shared',
      ownerId: expect.stringMatching(/^amend-test:rubrics-amend:/),
    }), expect.any(Function));
  });

  it('keeps concurrent amendments independently protected when the first finishes', async () => {
    runtimeMocks.hostIdentity.mockReturnValue('port-3170');
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    rubricsMocks.amendRubric.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await body({ ...amendArgs, idempotencyKey: 'runtime-first' });
    await body({ ...amendArgs, idempotencyKey: 'runtime-second' });
    expect(runtimeMocks.held.size).toBe(2);
    first.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    await vi.waitFor(() => expect(runtimeMocks.held.size).toBe(1));
    expect(receiptDb.rows.get('ws-amend-test:acceptance-example:runtime-second')!.state).toBe('running');
    second.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    await vi.waitFor(() => expect(runtimeMocks.held.size).toBe(0));
  });

  it('renews a detached amendment lease beyond its initial TTL and stops renewing after settlement', async () => {
    vi.useFakeTimers();
    const slow = deferred<unknown>();
    const rubric = { rubricId: 'acceptance-example', kind: 'standard', criteria: [] };
    try {
      runtimeMocks.hostIdentity.mockReturnValue('port-3170');
      rubricsMocks.amendRubric.mockReturnValue(slow.promise);
      const answer = body(amendArgs);
      await vi.advanceTimersByTimeAsync(25);
      expect(await answer).toMatchObject({ pending: true });
      await vi.advanceTimersByTimeAsync(1_200_005);
      expect(runtimeMocks.heartbeat).toHaveBeenCalledTimes(2);
      expect(runtimeMocks.heartbeat).toHaveBeenCalledWith(expect.objectContaining({
        coordinationDomain: 'host-global:staging-server', resource: 'staging-server',
        owner: [...runtimeMocks.held][0], lockId: [...runtimeMocks.held][0], ttlSec: 1200,
      }));
      expect(runtimeMocks.held.size).toBe(1);
      slow.resolve(rubric);
      await vi.advanceTimersByTimeAsync(1);
      expect(runtimeMocks.held.size).toBe(0);
      await vi.advanceTimersByTimeAsync(1_200_005);
      expect(runtimeMocks.heartbeat).toHaveBeenCalledTimes(2);
    } finally {
      slow.resolve(rubric);
      vi.useRealTimers();
    }
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

  it('persists safe apply phases and skips phases inside the plan-locked transaction', async () => {
    const slow = deferred<Record<string, unknown>>();
    let reportPhase!: (phase: string) => void;
    rubricsMocks.amendRubric.mockImplementation((input) => {
      reportPhase = input.onPhase;
      reportPhase('acceptance-contract-snapshot');
      reportPhase('acceptance-locked-plan-read');
      return slow.promise;
    });

    const answered = await body({ ...amendArgs, idempotencyKey: 'apply-safe-phase-progress' });
    expect(answered).toMatchObject({ ok: true, pending: true });
    const poll = { rubricRef: 'acceptance-example', idempotencyKey: 'apply-safe-phase-progress' };
    await vi.waitFor(async () => {
      expect(await statusBody(poll)).toMatchObject({
        state: 'running',
        progress: { phase: 'acceptance-contract-snapshot', phaseStartedAt: expect.any(Number) },
      });
    });

    const writesBeforeLockedPhase = receiptDb.progressWrites.count;
    reportPhase('acceptance-write-subject');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(receiptDb.progressWrites.count).toBe(writesBeforeLockedPhase);
    expect(await statusBody(poll)).toMatchObject({
      state: 'running',
      progress: { phase: 'acceptance-contract-snapshot' },
    });

    slow.resolve({ ok: true, rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
    await vi.waitFor(async () => expect(await statusBody(poll)).toMatchObject({ state: 'committed' }));
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
    Object.assign(receiptDb.rows.get('ws-amend-test:acceptance-example:stranded-key')!, {
      executor_host: hostname(), executor_pid: process.pid, executor_process_id: 'previous-executor-identity',
    });
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue({
      decisionId: 'D-42', subjectPlan: 'example-plan',
    });
    expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'stranded-key' }))
      .toMatchObject({ state: 'committed', source: 'decision', decisionId: 'D-42' });
    slow.resolve({ rubricId: 'acceptance-example', kind: 'standard', criteria: [] });
  });

  it.each([
    ['dead', 'orphaned'],
    ['reused-pid', 'orphaned'],
    ['live', 'running'],
    ['unknown', 'running'],
    ['remote', 'running'],
  ])('reports a running preview with a %s executor as %s', async (executor, state) => {
    const identity = readProcessIdentity(process.pid);
    expect(identity).toBeTruthy();
    const key = `preview-executor-${executor}`;
    receiptDb.rows.set(`ws-amend-test:acceptance-example:${key}`, {
      idempotency_key: key, rubric_ref: 'acceptance-example', state: 'running',
      started_at: new Date(), finished_at: null, result_json: null, error: null,
      executor_host: executor === 'remote' ? `${hostname()}-remote` : hostname(),
      executor_pid: executor === 'dead' ? 99999999 : process.pid,
      ...(executor === 'unknown' ? {} : {
        executor_process_id: executor === 'live' ? identity! : 'previous-executor-identity',
      }),
    });
    expect(await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: key }))
      .toMatchObject({ state, source: 'receipt', ...(state === 'orphaned' ? {
        reclaimableAt: expect.any(Number), note: expect.stringContaining('dryRun:true again for a fresh preview'),
      } : {}) });
    expect(rubricsMocks.findAmendmentDecisionByKey).not.toHaveBeenCalled();
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

  it('reports a timestamped routing phase while the retained preview review is still pending', async () => {
    const slow = deferred<Record<string, unknown>>();
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({ approvalRequired: true, approval: {}, changes: [] });
    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementationOnce((input) => {
      input.onPhase?.('review-route');
      return slow.promise;
    });
    const args = { ...amendArgs, dryRun: true, reviewPreviewPost: 'thread-post:42' };
    const startedAt = Date.now();
    try {
      const answered = await body(args);
      expect(answered).toMatchObject({ pending: true, receipt: { progress: {
        phase: 'review-route', phaseStartedAt: expect.any(Number), observedAt: expect.any(Number),
      } } });
      const snapshot = { ...answered.receipt.progress };
      expect(snapshot.phaseStartedAt).toBeGreaterThanOrEqual(startedAt);
      expect(snapshot.observedAt).toBeGreaterThanOrEqual(snapshot.phaseStartedAt);
      const retry = await body(args);
      expect(retry.receipt.idempotencyKey).toBe(answered.receipt.idempotencyKey);
      expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(1);
      expect(rubricsMocks.amendRubric).not.toHaveBeenCalled();
      expect(await statusBody(answered.receipt.poll.args)).toMatchObject({ state: 'running' });
      slow.resolve({ state: 'routed', conversationId: 'conv-late', next: 'retain this review' });
      await vi.waitFor(async () => {
        expect(await statusBody(answered.receipt.poll.args)).toMatchObject({ state: 'previewed',
          result: { review: { conversationId: 'conv-late' } } });
      });
      // The earlier response is a snapshot, not a claim about later live state.
      expect(answered.receipt.progress).toEqual(snapshot);
    } finally {
      slow.resolve({ state: 'routed', conversationId: 'conv-late', next: 'retain this review' });
    }
  });

  it('shares preview progress with a fresh status module without refreshing its observation or starting another review', async () => {
    const slow = deferred<Record<string, unknown>>();
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({ approvalRequired: true, approval: {}, changes: [] });
    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementationOnce(input => {
      input.onPhase?.('review-route');
      return slow.promise;
    });
    const args = { ...amendArgs, dryRun: true, reviewPreviewPost: 'thread-post:42' };
    try {
      const answered = await body(args);
      vi.resetModules();
      const workerB = (await import('./amend-status')).default;
      const read = async () => ((await workerB.handler(answered.receipt.poll.args, {} as never)) as { data: any }).data;
      await vi.waitFor(async () => expect(await read()).toMatchObject({ state: 'running', progress: {
        phase: 'review-route', phaseStartedAt: expect.any(Number), observedAt: expect.any(Number),
      } }));
      const first = await read();
      expect(first.result).toBeUndefined();
      expect((await read()).progress).toEqual(first.progress);
      expect((await body(args)).pending).toBe(true);
      expect(reviewMocks.openAcceptanceBarAmendmentReview).toHaveBeenCalledTimes(1);
      slow.resolve({ state: 'routed', conversationId: 'conv-progress' });
      await vi.waitFor(async () => expect(await read()).toMatchObject({ state: 'previewed',
        result: { review: { conversationId: 'conv-progress' } } }));
      expect((await read()).progress).toBeUndefined();
    } finally { slow.resolve({ state: 'routed' }); }
  });

  it.each(['terminal', 'new-attempt'])('fences a delayed preview progress write after %s', async mode => {
    const slow = deferred<Record<string, unknown>>();
    const blockedWrite = deferred<void>();
    const writeFinished = deferred<void>();
    receiptDb.progressControl.beforeWrite = () => blockedWrite.promise;
    receiptDb.progressControl.afterWrite = () => writeFinished.resolve();
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({ approvalRequired: true, approval: {}, changes: [] });
    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementationOnce(input => {
      input.onPhase?.('review-route');
      return slow.promise;
    });
    try {
      const answered = await body({ ...amendArgs, dryRun: true, reviewPreviewPost: 'thread-post:42' });
      const row = [...receiptDb.rows.values()][0]!;
      expect(row.result_json?._progressRun).toEqual(expect.any(String));
      if (mode === 'terminal') {
        slow.resolve({ state: 'routed', conversationId: 'conv-terminal' });
        await vi.waitFor(() => expect(row.state).toBe('previewed'));
      } else {
        row.result_json = { _progressRun: 'new-owner-attempt', progress: { phase: 'new-phase' } };
      }
      const before = JSON.stringify(row.result_json);
      blockedWrite.resolve();
      await writeFinished.promise;
      expect(JSON.stringify(row.result_json)).toBe(before);
      if (mode === 'terminal') {
        expect(await statusBody(answered.receipt.poll.args)).toMatchObject({ state: 'previewed' });
        expect((await body({ ...amendArgs, dryRun: true, reviewPreviewPost: 'thread-post:42' })).review)
          .toEqual({ state: 'routed', conversationId: 'conv-terminal' });
      } else {
        slow.resolve({ state: 'routed', conversationId: 'conv-superseded' });
        await vi.waitFor(() => expect(receiptDb.sql.mock.calls.some(([parts]) => Array.isArray(parts)
          && parts.join('?').includes('SET state = ?'))).toBe(true));
        expect(JSON.stringify(row.result_json)).toBe(before);
      }
    } finally {
      blockedWrite.resolve();
      slow.resolve({ state: 'routed' });
      await writeFinished.promise;
    }
  });

  it('a failed progress publication does not delay or fail the preview result', async () => {
    const slow = deferred<Record<string, unknown>>();
    receiptDb.progressControl.beforeWrite = async () => { throw new Error('progress storage unavailable'); };
    rubricsMocks.previewAcceptanceBarAmendment.mockResolvedValue({ approvalRequired: true, approval: {}, changes: [] });
    reviewMocks.openAcceptanceBarAmendmentReview.mockImplementationOnce(input => {
      input.onPhase?.('review-route');
      return slow.promise;
    });
    const args = { ...amendArgs, dryRun: true, reviewPreviewPost: 'thread-post:42' };
    try {
      const answered = await body(args);
      expect(answered.pending).toBe(true);
      slow.resolve({ state: 'routed', conversationId: 'conv-progress-failure' });
      await vi.waitFor(async () => expect(await statusBody(answered.receipt.poll.args)).toMatchObject({
        state: 'previewed', result: { ok: true, review: { conversationId: 'conv-progress-failure' } },
      }));
      expect((await body(args)).review).toEqual({ state: 'routed', conversationId: 'conv-progress-failure' });
    } finally { slow.resolve({ state: 'routed' }); }
  });

  it('keeps apply phase tracking off the shared progress writer', async () => {
    const { trackAmendRun } = await import('./amend-receipts');
    expect(await trackAmendRun('apply-progress-guard', 'acceptance-example', async onPhase => {
      onPhase('acceptance-locked-plan-read');
      onPhase('acceptance-write-rubric');
      return { ok: true };
    })).toEqual({ ok: true });
    expect(receiptDb.sql.mock.calls.some(([parts]) => Array.isArray(parts)
      && parts.join('?').includes('SET result_json = jsonb_set('))).toBe(false);
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

  it('with neither a receipt nor a Decision it does not claim a review dry-run is safe to repeat', async () => {
    rubricsMocks.findAmendmentDecisionByKey.mockResolvedValue(null);
    const status = await statusBody({ rubricRef: 'acceptance-example', idempotencyKey: 'review-unknown' });
    expect(status).toMatchObject({ state: 'not_found', source: 'none' });
    expect(status.note).toContain('does not establish that a dry-run had no external review side effects');
    expect(status.note).not.toMatch(/same-key retry is safe|re-issuing .* is safe/i);
  });
});
