/** Result door (deterministic-context-carry P-006 leg C) — cap a model-facing MCP
 *  tool result at the resultEach door, spill the FULL text to scratch behind a
 *  pointer; delta results and the kill-switch bypass; fail-soft on spill failure. */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE } from './context-doors';
import { applyPayloadTier } from '@papercusp/tooldef';
import { encode } from '@papercusp/result-encoding';
import { shapeCodeRunSummary } from './agent-tools/code/run';

// P-023: the door resolves its constants through the config surface per call — stub it
// (the config module has its own suite) so these tests run PG-free and one case can
// exercise a per-session override widening the budget.
const { doorConstantsMock } = vi.hoisted(() => ({ doorConstantsMock: vi.fn() }));
vi.mock('./context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

import type { DoorableResult } from './result-door';
import {
  applyResultDoor,
  applyResultDoorAsync,
  beginResultDoorAggregate,
  buildProjectionHint,
  detectResultEvidence,
  measureResultContextBytes,
  resetResultDoorAggregatesForTests,
  RESULT_DOOR_TOKENS,
} from './result-door';
import { applyResultProjection } from './result-projection/apply';
import { parseProjection } from './result-projection/parse';
import * as scratchReference from './scratch-reference';
import { senderBodyDeliveryDiagnostics } from './agent-tools/coordination/tools/inbox-content-bounds';

const BUDGET_CHARS = RESULT_DOOR_TOKENS * CHARS_PER_TOKEN_ESTIMATE;
const RUN_ID = '11111111-2222-4333-8444-555555555555';

let sandbox: string;
let prevScratchRoot: string | undefined;
let prevKillSwitch: string | undefined;

beforeEach(() => {
  // os.homedir() reads /etc/passwd not $HOME on Linux — the env-var override is
  // the one seam that redirects scratch writes (same setup as scratch-gc.test.ts).
  sandbox = mkdtempSync(join(tmpdir(), 'papercusp-result-door-test-'));
  prevScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
  prevKillSwitch = process.env.PAPERCUSP_RESULT_DOOR_OFF;
  delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  doorConstantsMock.mockReset();
  doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
  resetResultDoorAggregatesForTests();
});

afterEach(() => {
  if (prevScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = prevScratchRoot;
  if (prevKillSwitch === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
  else process.env.PAPERCUSP_RESULT_DOOR_OFF = prevKillSwitch;
  rmSync(sandbox, { recursive: true, force: true });
});

function longText(chars: number): string {
  return Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `line ${i} of a very long tool result`)
    .join('\n')
    .slice(0, chars);
}

describe('discovery schema integrity', () => {
  it.each([
    { toolName: 'tools:find' },
    { toolName: 'tools:invoke', nestedTargetToolName: 'tools:find' },
  ])('keeps schemas atomic through $toolName spill failure', (route) => {
    writeFileSync(join(sandbox, 'scratch'), 'not a directory');
    const small = JSON.stringify({ type: 'object', properties: {
      body: { type: 'string', description: 'é'.repeat(1_000) },
    }, required: ['body'], additionalProperties: false });
    const oversized = JSON.stringify({ type: 'object', properties: {
      body: { type: 'string', description: 'large schema '.repeat(2_000) },
    } });
    const source = { hits: [
      { tool: 'work_items:comment', argSchema: small },
      { tool: 'coord:send', argSchema: oversized },
    ] };
    const text = JSON.stringify(source);
    const result = { content: [{ type: 'text' as const, text }],
      structuredContent: source, _meta: { explicitFullRequest: true } };
    const out = applyResultDoor(result, { ...route, workspaceId: 'ws-1', runId: RUN_ID });
    const body = boundedBody(out) as any;
    expect(body.hits[0].argSchema).toBe(small);
    expect(JSON.parse(body.hits[0].argSchema)).toEqual(JSON.parse(small));
    expect(body.hits[1]).toMatchObject({ tool: 'coord:send', argSchemaUnavailable: true });
    expect(body.hits[1]).not.toHaveProperty('argSchema');
    expect(body._projection.cursor).toMatchObject({
      kind: 'volatile-scratch-page', reason: 'spill-write-failed', tool: 'capability:read',
    });
    const recovered = scratchReference.readVolatileScratchReference(body._projection.cursor.uri,
      { workspaceId: 'ws-1' });
    expect(recovered.payload.subarray(body._projection.cursor.bodyOffsetInPayload)
      .toString('utf8')).toBe(text);
    expect(() => scratchReference.readVolatileScratchReference(body._projection.cursor.uri,
      { workspaceId: 'another-workspace' })).toThrow();
    expect(out.structuredContent).toBe(source);
    expect(measureResultContextBytes(out)).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it('preserves compact signatures atomically on ordinary projection without changing other tools', () => {
    const signature = 'body:string ' + 'field guidance '.repeat(90);
    const source = { hits: [{ tool: 'work_items:comment', argSchema: signature }],
      padding: 'P'.repeat(BUDGET_CHARS * 3) };
    const content = [{ type: 'text' as const, text: JSON.stringify(source) }];
    const out = applyResultDoor({ content },
      { toolName: 'tools:find', workspaceId: 'ws-1', runId: RUN_ID });
    const body = boundedBody(out) as any;
    expect(body.hits[0].argSchema).toBe(signature);
    expect(readSpill('ws-1', 'tools:find', RUN_ID)).toContain(signature);
    expect(measureResultContextBytes(out)).toBeLessThanOrEqual(BUDGET_CHARS);
    const unrelated = applyResultDoor({ content },
      { toolName: 'other:read', workspaceId: 'ws-1', runId: RUN_ID });
    expect((boundedBody(unrelated) as any).hits[0].argSchema).not.toBe(signature);
  });
});

describe('fleet admission receipt recovery', () => {
  it('keeps the repair header and original full-details cursor through a nested partial-result door', () => {
    const source = { ok: false, error: 'admission_refused', reason: 'floor-gated',
      message: 'P-001 / WI-17 is excluded by stopTheLine.', blockingPlanItemIds: ['P-001'],
      blockingWorkItemIds: ['WI-17'], namedFloors: { stopTheLine: 1 },
      repairCall: { tool: 'work_items:claim', args: { id: 'WI-17', assignee: 'self', harness: 'papercusp' },
        effect: 'claim' }, promotionFailsafe: { diagnostic: longText(20_000) } };
    const first = applyResultDoor({ content: [{ type: 'text', text: JSON.stringify(source) }], isError: true },
      { toolName: 'fleet:launch-on-plan', workspaceId: 'ws-1', runId: RUN_ID });
    const firstBody = boundedBody(first) as any;
    const nested = applyResultDoor(first, { toolName: 'tools:invoke', nestedTargetToolName: 'fleet:launch-on-plan',
      workspaceId: 'ws-1', runId: RUN_ID });
    const body = boundedBody(nested) as any;
    expect(JSON.stringify(body).length).toBeLessThanOrEqual(6000);
    expect(nested.isError).toBe(true);
    expect(body).toMatchObject({ reason: 'floor-gated', message: source.message,
      blockingPlanItemIds: ['P-001'], blockingWorkItemIds: ['WI-17'], namedFloors: { stopTheLine: 1 },
      repairCall: source.repairCall });
    expect(body._projection.cursor).toEqual(firstBody._projection.cursor);
    const cursor = body._projection.cursor;
    const reference = scratchReference.parseScratchReference(readFileSync(cursor.args.file_path))!;
    expect(JSON.parse(reference.payload.subarray(cursor.bodyOffsetInPayload).toString())).toEqual(source);
  });
});

describe('release:repair-queue signature evidence projection', () => {
  function repairQueueResponse() {
    const signature = Array.from({ length: 50 }, (_, index) => ({
      kind: 'test-file',
      id: `packages/operator-core/lib/failure-${index}.test.ts`,
      recipe: `npm run test:file -- packages/operator-core/lib/failure-${index}.test.ts`,
      workspace: '@papercusp/operator-core',
      admittedRound: 1,
      measuredHead: 'a'.repeat(40),
      cases: Array.from({ length: 8 }, (_, caseIndex) => `case-${index}-${caseIndex}`),
      errors: Array.from({ length: 7 }, (_, errorIndex) => `error-${index}-${errorIndex}`),
    }));
    return {
      ok: true,
      op: 'get',
      callerAuthorization: { status: 'authorized-delegate', authorized: true, callerSpawnId: 'fixer-1' },
      repairQueueRead: { status: 'value', schemaVersion: 4 },
      repairQueue: {
        phase: 'awaiting-fixer',
        candidate: 'b'.repeat(40),
        repairHead: 'c'.repeat(40),
        decision: 'recover-dead-fixer',
        nextAction: "release:repair-queue { op: 'admit', paths: ['<your changed path>'] }",
        signature,
        failingTests: signature.map((entry) => entry.id),
        ...Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`diagnostic${index}`, 'D'.repeat(900)])),
      },
    };
  }

  it('keeps total signature cardinality and bounded case/error evidence through a nested rewalk', () => {
    const source = repairQueueResponse();
    const raw = { content: [{ type: 'text' as const, text: JSON.stringify(source) }] };
    expect(raw.content[0]!.text.length).toBeGreaterThan(BUDGET_CHARS);

    const direct = applyResultDoor(raw, { toolName: 'release:repair-queue', workspaceId: 'ws-1', runId: RUN_ID });
    const directBody = boundedBody(direct) as any;
    expect(directBody.repairQueue).toMatchObject({
      signatureCount: 50,
      signatureShownCount: 6,
      signatureOmittedCount: 44,
      signatureComplete: false,
    });
    expect(directBody.repairQueue.signature).toHaveLength(6);
    expect(directBody.repairQueue.signature[0]).toMatchObject({
      kind: 'test-file',
      id: source.repairQueue.signature[0].id,
      recipe: source.repairQueue.signature[0].recipe,
      cases: source.repairQueue.signature[0].cases.slice(0, 6),
      casesCount: 8,
      casesOmittedCount: 2,
      errors: source.repairQueue.signature[0].errors.slice(0, 6),
      errorsCount: 7,
      errorsOmittedCount: 1,
    });
    expect(directBody._compactProjection).toMatchObject({ kind: 'release:repair-queue' });
    expect(measureResultContextBytes(direct)).toBeLessThanOrEqual(BUDGET_CHARS);

    const nested = applyResultDoor(direct, {
      toolName: 'tools:invoke',
      nestedTargetToolName: 'release:repair-queue',
      workspaceId: 'ws-1',
      runId: RUN_ID,
    });
    const nestedBody = boundedBody(nested) as any;
    expect(nestedBody.repairQueue).toMatchObject({
      signatureCount: 50,
      signatureShownCount: 6,
      signatureOmittedCount: 44,
    });
    expect(nestedBody.repairQueue.signature).toHaveLength(6);
    expect(nestedBody.repairQueue.signature[0]).toMatchObject({
      id: source.repairQueue.signature[0].id,
      casesCount: 8,
      errorsCount: 7,
    });
    expect(measureResultContextBytes(nested)).toBeLessThanOrEqual(BUDGET_CHARS);

    const control = applyResultDoor(raw, { toolName: 'plans:list', workspaceId: 'ws-1', runId: RUN_ID });
    const controlBody = boundedBody(control) as any;
    expect(controlBody.repairQueue?.signatureCount).toBeUndefined();
  });
});

describe('plans:start write receipt recovery', () => {
  const receipt = () => ({
    ok: false, counts: { ok: 0, failed: 1 }, results: [{
      ok: false, slug: 'receipt-plan', harnessSlug: 'papercusp', error: 'admission_refused',
      autoApproved: true, transitioned: false,
      promotion: { promoted: 3, skipped: 2, flagOff: false },
      promotedBlock: { changed: true, rows: 5 },
      admission: { ready: false, reason: 'floor-gated', message: 'P-001 is excluded by claim floors.', diagnostics: longText(20_000) },
    }],
  });

  it.each(['plans:start', 'tools:invoke'])('retains the refusal and committed legs through %s and pages the original bytes', (toolName) => {
    const source = receipt();
    const out = applyResultDoor({ content: [{ type: 'text', text: JSON.stringify(source) }] }, {
      toolName, nestedTargetToolName: toolName === 'tools:invoke' ? 'plans:start' : undefined,
      workspaceId: 'ws-1', runId: RUN_ID,
    });
    const body = boundedBody(out) as any;
    expect(body.results[0]).toMatchObject({
      error: 'admission_refused', autoApproved: true,
      promotion: { promoted: 3, skipped: 2 }, promotedBlock: { changed: true, rows: 5 },
      admission: { ready: false, reason: 'floor-gated' },
    });
    expect(body._projection.cursor.tool).toBe('capability:read');
    expect(body._projection.next).not.toMatch(/Re-call plans:start|Call plans:start again/);
    const payload = scratchReference.parseScratchReference(readFileSync(body._projection.cursor.args.file_path))!.payload;
    expect(JSON.parse(payload.subarray(body._projection.cursor.bodyOffsetInPayload).toString())).toEqual(source);
  });

  it('does not recommend replay when an upstream projection already lost the receipt', () => {
    const tiered = applyPayloadTier({ toolName: 'plans:start', shape: undefined,
      response: { data: receipt() }, tier: 'trimmed', args: { slug: 'receipt-plan' }, log: vi.fn() });
    const out = applyResultDoor({ content: [{ type: 'text', text: JSON.stringify(tiered.data) }],
      _meta: { payloadProjection: tiered.payloadProjection } }, {
      toolName: 'plans:start', workspaceId: 'ws-1', runId: RUN_ID,
    });
    const body = boundedBody(out) as any;
    expect(body._projection.next).toContain('Do NOT repeat plans:start');
    expect(body._projection.next).not.toMatch(/Re-call plans:start|Call plans:start again/);
  });

  it('retains the committed receipt and a read-only recovery after a scratch failure', () => {
    const blockedRoot = join(sandbox, 'not-a-directory');
    writeFileSync(blockedRoot, 'blocked');
    process.env.PAPERCUSP_SCRATCH_ROOT = blockedRoot;
    const out = applyResultDoor({ content: [{ type: 'text', text: JSON.stringify(receipt()) }] }, {
      toolName: 'plans:start', workspaceId: 'ws-1', runId: RUN_ID,
    });
    const body = boundedBody(out) as any;
    expect(body.results[0]).toMatchObject({ autoApproved: true,
      promotion: { promoted: 3 }, admission: { reason: 'floor-gated' } });
    expect(body._projection.cursor.tool).toBe('capability:read');
    expect(body._projection.next).toContain('Do NOT repeat plans:start');
  });
});

describe('plans:bind-spec-evidence target refusal recovery', () => {
  const refusal = (index: number) => {
    const target = 'PARITY-P003-' + index;
    const runId = 21257392 + index;
    return {
      ok: false,
      slug: 'cloud-portal-desktop-parity-closure-2026-10-09',
      error: 'mutation_target_rejected',
      clause: target + '@1',
      targeted: null,
      acceptedTargets: [target],
      reason: target + '@1: this mutation binding carries no adequacy.targeted; accepted target: ' + target + '.',
      correctedCall: {
        tool: 'plans:bind-spec-evidence',
        args: {
          harness: 'papercusp',
          slug: 'cloud-portal-desktop-parity-closure-2026-10-09',
          items: [{
            workItemId: 'WI-10007845',
            specId: target,
            specRevision: 1,
            fromTestRun: runId,
            details: { adequacy: { targeted: target } },
          }],
        },
      },
      derivedFromTestRun: { testRunId: runId, outputTail: 'D'.repeat(5_000) },
    };
  };

  it.each([
    { toolName: 'plans:bind-spec-evidence' },
    { toolName: 'tools:invoke', nestedTargetToolName: 'plans:bind-spec-evidence' },
  ])('keeps the target correction inline through $toolName', (route) => {
    const source = {
      ok: false,
      counts: { ok: 0, failed: 4 },
      results: [1, 2, 3, 4].map(refusal),
    };
    const out = applyResultDoor(
      { content: [{ type: 'text', text: JSON.stringify(source) }] },
      { ...route, workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(out) as any;

    expect(body._projection.truncated).toBe(true);
    expect(body.results).toHaveLength(4);
    for (const row of body.results) {
      expect(row).toMatchObject({
        ok: false,
        error: 'mutation_target_rejected',
        targeted: null,
        acceptedTargets: expect.any(Array),
        reason: expect.stringContaining('accepted target'),
        correctedCall: { tool: 'plans:bind-spec-evidence', args: { items: expect.any(Array) } },
      });
    }
    expect(measureResultContextBytes(out)).toBeLessThanOrEqual(BUDGET_CHARS);
    const payload = scratchReference.parseScratchReference(readFileSync(body._projection.cursor.args.file_path))!.payload;
    expect(JSON.parse(payload.subarray(body._projection.cursor.bodyOffsetInPayload).toString())).toEqual(source);
  });
});

/** The single spill file written under <scratchRoot>/<ws>/<tool>/<runId>/. */
function readSpill(ws: string, tool: string, runId: string): string {
  const dir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, ws, tool, runId);
  const files = readdirSync(dir);
  expect(files).toHaveLength(1);
  const bytes = readFileSync(join(dir, files[0]));
  const reference = scratchReference.parseScratchReference(bytes);
  expect(reference).not.toBeNull();
  return reference!.payload.toString('utf8');
}

function readVolatilePayloadText(uri: string): string {
  const payload = scratchReference.readVolatileScratchReference(uri, { workspaceId: 'ws-1' }).payload.toString('utf8');
  const parsed = JSON.parse(payload) as { content?: Array<{ text?: string }> };
  return parsed.content?.[0]?.text ?? '';
}

function boundedBody(result: DoorableResult): {
  text?: string;
  review?: unknown;
  summaryNotice?: Record<string, unknown>;
  _projection: {
    cursor: Record<string, unknown>;
    next: string;
    kind: string;
    truncated: boolean;
  };
} {
  const textItems = result.content.filter((item) => (item as { type?: unknown }).type === 'text') as Array<{
    text: string;
  }>;
  expect(textItems).toHaveLength(1);
  return JSON.parse(textItems[0].text) as {
    text?: string;
    review?: unknown;
    summaryNotice?: Record<string, unknown>;
    _projection: {
      cursor: Record<string, unknown>;
      next: string;
      kind: string;
      truncated: boolean;
    };
  };
}

describe('applyResultDoor', () => {
  describe('EI-25185987580518406 coordination send receipts', () => {
    it.each([421, 700])('keeps a complete %i-character delivery receipt inline', (chars) => {
      const diagnostics = senderBodyDeliveryDiagnostics('x'.repeat(chars))!;
      const receipt = {
        ok: !diagnostics.bodyTruncated,
        results: [{ ok: true, msg_id: 'already-persisted', ...diagnostics,
          bodyReadRef: { tool: 'coord:read', msg_id: 'already-persisted' } }],
        counts: { ok: 1, failed: 0 },
      };
      const result = { content: [{ type: 'text' as const, text: JSON.stringify(receipt) }] };
      expect(applyResultDoor(result, { toolName: 'coord:send', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it('keeps nested coord:send inbox-page diagnostics from marking a complete receipt partial', () => {
      const diagnostics = senderBodyDeliveryDiagnostics('x'.repeat(570))!;
      expect(diagnostics).toMatchObject({ bodyTruncated: false, bodyMayBeTruncated: true });
      const result = {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: true,
          results: [{ ok: true, msg_id: 'already-persisted', ...diagnostics }],
          counts: { ok: 1, failed: 0 },
        }) }],
      };

      expect(applyResultDoor(result, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'coord:send',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      })).toBe(result);

      const unrelated = applyResultDoor(result, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'plans:list',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const envelope = JSON.parse((unrelated.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('under-budget-partial-result');
    });

    it.each(['field', 'upstream'] as const)('recovers genuinely %s-partial receipts by reading without repeating the send', (kind) => {
      const result = {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: true, results: [{ msg_id: 'already-persisted', _partial: true }],
        }) }],
        ...(kind === 'upstream' ? { _meta: { payloadProjection: {
          truncated: true, tier: 'trimmed', originalChars: 9_000, returnedChars: 500, omittedCount: 1,
        } } } : {}),
      };
      const out = applyResultDoor(result, { toolName: 'coord:send', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((out.content[0] as { text: string }).text);
      expect(envelope.incomplete).toMatchObject({ reason: 'under-budget-partial-result', recoverable: false });
      expect(envelope.incomplete.note).toContain('coord:read');
      expect(envelope.incomplete.note).toContain('Do not repeat coord:send');
      expect(envelope.incomplete.note).not.toMatch(/re-call|re-send/i);
    });

    it('does not treat inbox output clipping as a complete send receipt', () => {
      const result = { content: [{ type: 'text' as const, text: JSON.stringify({
        entries: [{ msg_id: 'already-persisted', body_truncated: true }],
      }) }] };
      const out = applyResultDoor(result, { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID });
      expect(JSON.parse((out.content[0] as { text: string }).text).incomplete.recoverable).toBe(false);
    });
  });

  describe('bounded artifacts:load pages', () => {
    const pageResult = () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({
        ok: true,
        results: [{
          ok: true,
          slug: 'engineering',
          rel_path: 'agent-insights/example.md',
          found: true,
          content: 'x'.repeat(1_200),
          updated_at: 1,
          content_total_chars: 5_000,
          content_offset: 0,
          content_truncated: true,
        }],
        counts: { ok: 1, failed: 0 },
      }) }],
    });

    it.each(['direct', 'nested'] as const)(
      'keeps a valid %s artifacts:load page inline without requiring scratch persistence',
      (route) => {
        const result = pageResult();
        const out = applyResultDoor(result, {
          toolName: route === 'direct' ? 'artifacts:load' : 'tools:invoke',
          ...(route === 'nested' ? { nestedTargetToolName: 'artifacts:load' } : {}),
          workspaceId: 'ws-1',
          runId: RUN_ID,
          scratchWriteFailure: { error: Object.assign(new Error('scratch must not be needed'), { code: 'ENOSPC' }) },
        });

        expect(out).toBe(result);
      },
    );

    it('keeps malformed content_truncated metadata on the conservative spill path', () => {
      const result = {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: true,
          results: [{ ok: true, found: true, content: 'short page', content_truncated: true }],
          counts: { ok: 1, failed: 0 },
        }) }],
      };

      const out = applyResultDoor(result, {
        toolName: 'artifacts:load',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });

      expect(out).not.toBe(result);
          expect(((out as DoorableResult)._meta as { resultDoor?: { reason?: string } } | undefined)?.resultDoor?.reason)
        .toBe('under-budget-partial-result');
    });
  });

  describe('conversations:get spill-failure recovery', () => {
    it.each(['direct', 'nested'] as const)(
      'explains per-post recovery for a %s full-thread read when both spill stores fail',
      (route) => {
        const volatileStore = vi.spyOn(scratchReference, 'storeVolatileScratchReference').mockReturnValue(null);
        try {
          const aggregateScope = beginResultDoorAggregate({
            sessionKey: 'conversation-spill-failure',
            outputGroupId: `turn-${route}`,
          });
          const filler = { content: [{ type: 'text' as const, text: 'x'.repeat(BUDGET_CHARS) }] };
          for (let index = 0; index < 2; index += 1) {
            applyResultDoor(filler, {
              toolName: 'plans:get',
              workspaceId: 'ws-1',
              runId: RUN_ID,
              aggregateScope,
            });
          }

          const conversationResult = {
            content: [{ type: 'text' as const, text: JSON.stringify({
              ok: true,
              results: [{
                ok: true,
                id: 'conv-large-thread',
                conversation: { id: 'conv-large-thread', title: 'review' },
                posts: [{ id: 42, author_id: 'su-reviewer', body: 'x'.repeat(BUDGET_CHARS) }],
              }],
              counts: { ok: 1, failed: 0 },
            }) }],
          };
          const out = applyResultDoor(conversationResult, {
            toolName: route === 'direct' ? 'conversations:get' : 'tools:invoke',
            ...(route === 'nested' ? { nestedTargetToolName: 'conversations:get' } : {}),
            workspaceId: 'ws-1',
            runId: RUN_ID,
            aggregateScope,
            scratchWriteFailure: {
              error: Object.assign(new Error('scratch persistence unavailable'), { code: 'EIO' }),
            },
          });
          const envelope = JSON.parse((out.content[0] as { text: string }).text);

          expect(envelope.error).toMatchObject({ code: 'output_spill_failed', retryable: true });
          expect(envelope.error.message).toContain('projection');
          expect(envelope.error.message).toContain('results[].posts[].id');
          expect(envelope.error.message).toContain('thread-post:<postId>');
          expect(JSON.stringify(envelope).length).toBeLessThanOrEqual(BUDGET_CHARS);
        } finally {
          volatileStore.mockRestore();
        }
      },
    );
  });

  it('a result within the budget passes through as the SAME object (no copy, no spill)', () => {
    const result = { content: [{ type: 'text' as const, text: 'small result' }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it('an over-door text result is structurally bounded + pointered, and the spill holds the original', () => {
    const original = longText(BUDGET_CHARS * 3);
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored);
    const resultDoor = (doored as unknown as { _meta: { resultDoor: { originalBytes: number } } })._meta.resultDoor;
    expect(resultDoor.originalBytes).toBe(Buffer.byteLength(original, 'utf8'));
    expect(measureResultContextBytes(doored)).toBeLessThan(Buffer.byteLength(original, 'utf8'));
    expect(body.text).toContain('line 0 of a very long tool result');
    expect(body.text).not.toBe(original);
    expect(body._projection).toMatchObject({ kind: 'bounded-payload', truncated: true });
    expect(JSON.stringify(body._projection.cursor)).toContain('papercusp://scratch/ws-1/plans:get/' + RUN_ID);
    const spill = readSpill('ws-1', 'plans:get', RUN_ID);
    expect(spill).toContain('# tool: plans:get');
    expect(spill.endsWith(original)).toBe(true);
  });

  it('EI-21566007420787313: a bounded work_items:get batch never emits an unmarked partial row', () => {
    const results = Array.from({ length: 3 }, (_, i) => {
      const id = `WI-${42_200 + i}`;
      return {
        ok: true,
        id,
        workItem: {
          id,
          kind: 'bug',
          family: 'issue',
          state: 'open',
          title: `work item ${i}`,
          summary: 'S'.repeat(2_000),
          assignee: `su-${i}`,
          takenAt: '2026-08-27T00:53:51.717Z',
          ...Object.fromEntries(Array.from({ length: 32 }, (_, j) => [`diagnostic${j}`, `D${j}`.repeat(40)])),
        },
        holder: { goalRef: id, agreement: 'sole', detail: 'H'.repeat(800) },
        checkpoint: 'C'.repeat(1_500),
        checkpointAgeMs: 100,
        checkpointUpdatedAtMs: 200,
      };
    });
    const source = { ok: true, results, counts: { ok: results.length, failed: 0 } };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      results: Array<Record<string, unknown>>;
    };
    expect(Array.isArray(projected.results)).toBe(true);

    const realRows = projected.results.filter((row) => row._truncated !== true);
    expect(realRows.length).toBeGreaterThan(0);
    let sawPartial = false;
    for (const row of realRows) {
      // The live failure was a terminal `{ok:true}` husk. Correlation identity
      // must win the final bytes of every real row.
      expect(row.id).toEqual(expect.stringMatching(/^WI-/));
      const original = results.find((candidate) => candidate.id === row.id)!;
      const rootLostField = Object.keys(original).some((key) => !(key in row));
      const workItem = row.workItem as Record<string, unknown> | undefined;
      const workItemLostField =
        workItem != null && Object.keys(original.workItem).some((key) => !(key in workItem));
      if (rootLostField) {
        sawPartial = true;
        expect(row._partial).toBe(true);
      }
      if (workItemLostField) {
        sawPartial = true;
        expect(row._partial).toBe(true);
      }
      if (workItem) expect(workItem).not.toHaveProperty('_partial');
    }
    // Calibration: if this turns false, the fixture no longer exercises the
    // dangerous field-loss direction and the assertions above are vacuous.
    expect(sawPartial).toBe(true);
  });

  it('EI-23196202383663962: the result door forwards custom bulk-envelope semantics so a tail failure stays visible', () => {
    const entries = [
      ...Array.from({ length: 16 }, (_, i) => ({
        outcome: 'ok',
        key: `WI-${i}`,
        detail: 'x'.repeat(4_000),
      })),
      { outcome: 'failed', key: 'WI-tail-failure', detail: 'x'.repeat(4_000) },
    ];
    const source = { accepted: true, entries, tally: { ok: 16, failed: 1 } };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      {
        toolName: 'plans:bind-spec-evidence',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        bulkEnvelope: { resultsKey: 'entries', failureKey: 'outcome', countsKey: 'tally' },
      },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      entries: Array<Record<string, unknown>>;
      tally: { ok: number; failed: number };
    };

    const visibleRows = projected.entries.filter((row) => row._truncated !== true);
    expect(visibleRows.map((row) => row.key)).toEqual(
      [...visibleRows]
        .sort((a, b) => entries.findIndex((source) => source.key === a.key) - entries.findIndex((source) => source.key === b.key))
        .map((row) => row.key),
    );
    expect(visibleRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        outcome: 'failed',
        key: 'WI-tail-failure',
      }),
    ]));
    expect(visibleRows.at(-1)).toMatchObject({
      outcome: 'failed',
      key: 'WI-tail-failure',
    });
    expect(projected.tally).toEqual({ ok: 16, failed: 1 });
  });

  it('EI-22468133965181704: work_items:links keeps the full selected-set receipt when result rows are bounded', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `EI-${String(i + 1).padStart(18, '0')}`);
    const results = ids.map((id) => ({
      ok: true,
      id,
      direction: 'out',
      links: [{ rel: 'relates', dst: { kind: 'issue', ref: `${id}-linked-target` } }],
    }));
    const source = {
      ok: true,
      results,
      counts: { ok: 100, failed: 0 },
      coverage: {
        selectedCount: 100,
        checkedCount: 100,
        complete: true,
        linkedCount: 100,
      },
    };
    expect(JSON.stringify(source).length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: JSON.stringify(source) }] },
      { toolName: 'work_items:links', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as unknown as {
      results: Array<Record<string, unknown>>;
      _partial?: boolean;
      coverage: {
        selectedCount: number;
        checkedCount: number;
        complete: boolean;
        linkedCount: number;
      };
    };
    const visibleRows = body.results.filter((row) => row._truncated !== true);

    expect(body.coverage).toEqual({
      selectedCount: 100,
      checkedCount: 100,
      complete: true,
      linkedCount: 100,
    });
    expect(visibleRows.length).toBeLessThan(body.coverage.linkedCount);
    expect(body._partial).toBe(true);
    expect(body.results.every((row) =>
      typeof row.id === 'string' && row.kind !== 'projection-truncation',
    )).toBe(true);
  });

  it.each([
    { toolName: 'work_items:get' },
    { toolName: 'tools:invoke', nestedTargetToolName: 'work_items:get' },
  ])('reconciles requested-ID receipts through $toolName after a narrow caller pick', (route) => {
    const source = {
      results: [{ id: 'WI-found', workItem: { title: 'Found', summary: 'omit me' } }],
      receipt: [{ id: 'WI-found', delivered: true }, { id: 'WI-dropped', delivered: true }],
      read: { schemaVersion: 'work-items-get-read-v1', requested: 2, receiptComplete: true },
    };
    const parsed = parseProjection({ pick: ['results[].workItem.title'] });
    if (!parsed.ok) throw new Error(parsed.error);
    const picked = applyResultProjection(
      { content: [{ type: 'text' as const, text: JSON.stringify(source) }] },
      parsed.spec, { toolName: route.toolName },
    );
    const out = applyResultDoor(picked, { ...route, workspaceId: 'ws-1', runId: RUN_ID });
    const body = JSON.parse((out.content[0] as { text: string }).text);
    expect(body.results).toEqual([{ id: 'WI-found', workItem: { title: 'Found' } }]);
    expect(body.receipt).toEqual([
      { id: 'WI-found', delivered: true },
      { id: 'WI-dropped', delivered: false, reason: 'projection' },
    ]);
    expect(body.read).toMatchObject({ requested: 2, receiptComplete: true });
  });

  it.each([
    { toolName: 'work_items:get' },
    { toolName: 'tools:invoke', nestedTargetToolName: 'work_items:get' },
  ])('discloses bounded manifest loss and never marks a dropped row delivered through $toolName', (route) => {
    const ids = Array.from({ length: 100 }, (_, i) => `WI-receipt-${i}`);
    const source = {
      results: ids.map((id) => ({ id, workItem: { title: 'T'.repeat(500) } })),
      receipt: ids.map((id) => ({ id, delivered: true })),
      read: { schemaVersion: 'work-items-get-read-v1', requested: ids.length, receiptComplete: true },
    };
    const out = applyResultDoor(
      { content: [{ type: 'text' as const, text: JSON.stringify(source) }] },
      { ...route, workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(out) as unknown as {
      results: Array<{ id: string }>;
      receipt: Array<{ id: string; delivered: boolean; reason?: string }>;
      read: { requested: number; receiptComplete: boolean; receiptOmitted?: number };
    };
    const visible = new Set((body.results ?? []).map((row) => row.id));
    expect(body.receipt.length).toBeGreaterThan(0);
    expect(body.read.requested).toBe(ids.length);
    expect(body.read.receiptComplete).toBe(body.receipt.length === ids.length);
    if (!body.read.receiptComplete) expect(body.read.receiptOmitted).toBe(ids.length - body.receipt.length);
    for (const entry of body.receipt) {
      expect(entry.delivered).toBe(visible.has(entry.id));
      if (!entry.delivered) expect(entry.reason).toBe('projection');
    }
  });

  it('work_items:get preserves row reread handles ahead of get-shape counts through the result door', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `WI-${String(i + 1).padStart(5, '0')}`);
    const source = {
      ok: true,
      results: ids.map((id) => ({
        ok: true,
        id,
        availability: 'available',
        workItem: { id, summary: 'detail '.repeat(300) },
      })),
      counts: { ok: 100, failed: 0 },
      read: {
        schemaVersion: 'work-items-get-read-v1',
        mode: 'complete',
        requested: 100,
        available: 100,
        absent: 0,
        unavailable: 0,
        detailRows: 100,
        stubbedRows: 0,
      },
      _shapeNote: {
        tier: 'trimmed',
        dropped: ['workItem.summary'],
        stubbed: { count: 0, note: 're-read an id alone for detail' },
      },
    };
    expect(JSON.stringify(source).length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: JSON.stringify(source) }] },
      { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as unknown as {
      results: Array<Record<string, unknown>>;
      read: Record<string, unknown>;
      _shapeNote: { dropped: string[]; stubbed: { count: number } };
    };

    expect(body.read).toMatchObject({
      requested: 100,
      available: 100,
      absent: 0,
      unavailable: 0,
      detailRows: 100,
      stubbedRows: 0,
    });
    expect(body._shapeNote).toMatchObject({
      dropped: ['workItem.summary'],
      stubbed: { count: 0 },
    });
    expect(body.results.some((row) => typeof row.id === 'string')).toBe(true);
    expect((doored as any)._meta?.resultDoor).toMatchObject({ truncated: true, spillUri: expect.any(String) });
  });

  it('work_items:get preserves explicitly selected bounded thread bodies ahead of checkpoint detail', () => {
    const selectedBody = 'The reviewer objected that the acceptance evidence is incomplete.';
    const source = {
      ok: true,
      results: [{
        ok: true,
        id: 'WI-thread-body',
        availability: 'available',
        checkpoint: 'C'.repeat(10_000),
        checkpointContentHash: 'checkpoint-sha',
        checkpointUpdatedAtMs: 123,
        checkpointBody: {
          notes: Array.from({ length: 20 }, (_, i) => `checkpoint note ${i}: ${'N'.repeat(1_200)}`),
        },
        threadWindow: {
          posts: [{
            id: 37,
            thread_id: 'thread-37',
            author_id: 'su-reviewer',
            body: selectedBody,
            created_ts: '2026-10-08T05:00:00.000Z',
          }],
          shown: 1,
          total: 5,
          topics: [],
          createdAt: '2026-10-08T04:00:00.000Z',
        },
      }],
      counts: { ok: 1, failed: 0 },
      read: {
        schemaVersion: 'work-items-get-read-v1',
        mode: 'complete',
        requested: 1,
        available: 1,
        absent: 0,
        unavailable: 0,
        detailRows: 1,
        stubbedRows: 0,
      },
      _shapeNote: { tier: 'standard', dropped: [] },
    };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      {
        toolName: 'work_items:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666667',
        preservePaths: ['results[].threadWindow.total', 'results[].threadWindow.posts[].body'],
      },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      results: Array<{ threadWindow?: { total?: number; posts?: Array<{ body?: string }> } }>;
    };

    expect(projected.results[0]?.threadWindow?.total).toBe(5);
    expect(projected.results[0]?.threadWindow?.posts?.[0]?.body).toBe(selectedBody);
  });

  it('tools:invoke work_items:get preserves bounded thread bodies through its outer depth-limited door', () => {
    const selectedBody = 'The latest approval objection remains unresolved.';
    const source = {
      ok: true,
      results: [{
        ok: true,
        id: 'WI-nested-thread-body',
        checkpoint: 'C'.repeat(10_000),
        checkpointBody: { notes: Array.from({ length: 20 }, () => 'N'.repeat(350)) },
        threadWindow: {
          posts: [{
            id: 41,
            thread_id: 'thread-41',
            author_id: 'su-reviewer',
            body: selectedBody,
            created_ts: '2026-10-08T05:00:00.000Z',
          }],
          shown: 1,
          total: 3,
          topics: [],
          createdAt: null,
        },
      }],
      counts: { ok: 1, failed: 0 },
    };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'work_items:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666668',
      },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      results: Array<{ threadWindow?: { total?: number; posts?: Array<{ id?: number; body?: string }> } }>;
    };

    expect(projected.results[0]?.threadWindow?.total).toBe(3);
    expect(projected.results[0]?.threadWindow?.posts?.[0]).toMatchObject({ id: 41, body: selectedBody });
  });

  it('tools:invoke work_items:get preserves explicitly picked thread post leaves through the outer door', () => {
    const selectedPost = {
      id: 43,
      author_id: 'su-reviewer',
      created_ts: '2026-10-08T05:00:00.000Z',
      body: 'The reviewer needs the original objection before approving this change.',
    };
    const source = {
      ok: true,
      results: [{
        ok: true,
        id: 'WI-explicit-thread-leaf-pick',
        checkpoint: 'C'.repeat(10_000),
        checkpointBody: { notes: Array.from({ length: 20 }, () => 'N'.repeat(350)) },
        threadWindow: {
          posts: [selectedPost],
          shown: 1,
          total: 3,
          topics: [],
          createdAt: null,
        },
      }],
      counts: { ok: 1, failed: 0 },
    };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'work_items:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666670',
        preservePaths: [
          'results[].threadWindow.posts[].id',
          'results[].threadWindow.posts[].author_id',
          'results[].threadWindow.posts[].created_ts',
          'results[].threadWindow.posts[].body',
        ],
      },
    );
    const projected = JSON.parse((doored.content[0] as { type: 'text'; text: string }).text) as {
      results: Array<{ threadWindow?: { posts?: Array<typeof selectedPost> } }>;
    };

    expect(projected.results[0]?.threadWindow?.posts?.[0]).toMatchObject(selectedPost);
  });

  it('tools:invoke work_items:get keeps post bodies when projection selects the enclosing threadWindow', () => {
    const selectedBody = 'The reviewer requested the full comment text.';
    const source = {
      ok: true,
      results: [{
        ok: true,
        id: 'WI-nested-parent-pick',
        checkpoint: 'C'.repeat(10_000),
        checkpointBody: { notes: Array.from({ length: 20 }, () => 'N'.repeat(350)) },
        threadWindow: {
          posts: [{
            id: 42,
            thread_id: 'thread-42',
            author_id: 'su-reviewer',
            body: selectedBody,
            created_ts: '2026-10-08T05:00:00.000Z',
          }],
          shown: 1,
          total: 4,
          topics: [],
          createdAt: null,
        },
      }],
      counts: { ok: 1, failed: 0 },
    };
    const text = JSON.stringify(source);
    expect(text.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text }] },
      {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'work_items:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666669',
        preservePaths: ['results[].checkpoint', 'results[].threadWindow'],
      },
    );
    const projected = JSON.parse((doored.content[0] as { type: 'text'; text: string }).text) as {
      results: Array<{ threadWindow?: { total?: number; posts?: Array<{
        id?: number;
        thread_id?: string;
        author_id?: string;
        body?: string;
        created_ts?: string;
      }> } }>;
    };

    expect(projected.results[0]?.threadWindow?.total).toBe(4);
    expect(projected.results[0]?.threadWindow?.posts?.[0]).toMatchObject({
      id: 42,
      thread_id: 'thread-42',
      author_id: 'su-reviewer',
      body: selectedBody,
      created_ts: '2026-10-08T05:00:00.000Z',
    });
  });

  it('recipes:run nested work-item rows retain identity, state, and full-detail recovery through both shapers', () => {
    const recipeId = 'read-existing-agent-operability-work-items';
    const expectedIds = Array.from({ length: 10 }, (_, i) => 'WI-' + (4600 + i));
    const source = {
      ok: true,
      results: [{
        ok: true,
        id: recipeId,
        result: {
          ok: true,
          summary: expectedIds.map((id, i) => ({
            ok: true,
            results: [{
              ok: true,
              id,
              workItem: {
                id,
                title: 'Operability item ' + i,
                state: i % 2 === 0 ? 'todo' : 'passed',
                summary: 'detail '.repeat(1_000),
              },
            }],
            counts: { ok: 1, failed: 0 },
          })),
          logs: [],
          dryRun: false,
          plannedMutations: [],
        },
      }],
      counts: { ok: 1, failed: 0 },
    };
    expect(JSON.stringify(source).length).toBeGreaterThan(BUDGET_CHARS);

    // This is the framework's generic recipes:run payload-tier path followed by
    // the model-facing result door. It is a producer-shape fixture, not a replay
    // of the saved recipe: recipes:get currently reports that recipe unrunnable.
    const tiered = applyPayloadTier({
      toolName: 'recipes:run',
      shape: undefined,
      response: { data: source },
      tier: 'trimmed',
      args: { id: recipeId },
      rawDispatchTemplate: "tools:invoke { name:'{tool}', args:{ …original args, payloadTier:'full' } }",
      log: vi.fn(),
    });
    expect(tiered.payloadProjection).toMatchObject({ truncated: true, tier: 'trimmed' });

    const tieredBody = tiered.data as any;
    const tieredRows = tieredBody.results[0].result.summary as any[];
    expect(tieredRows).toHaveLength(expectedIds.length);
    expect(tieredRows.map((row) => row.results[0].id)).toEqual(expectedIds);
    expect(tieredRows.map((row) => row.results[0].workItem.state)).toEqual(
      expectedIds.map((_, i) => (i % 2 === 0 ? 'todo' : 'passed')),
    );
    for (const row of tieredRows) {
      expect(row.results[0]).toMatchObject({ _partial: true });
      expect(row.results[0].workItem).not.toHaveProperty('_partial');
      expect(row.results[0].workItem).not.toHaveProperty('_omitted');
    }
    expect(tieredBody._projection.cursor).toEqual({
      kind: 'full-detail',
      tool: 'recipes:run',
      args: { id: recipeId, payloadTier: 'full' },
    });
    expect(tieredBody._projection.next).toContain("tools:invoke { name:'recipes:run'");

    const doored = applyResultDoor(
      {
        content: [{ type: 'text' as const, text: JSON.stringify(tieredBody) }],
        _meta: { payloadProjection: tiered.payloadProjection },
      },
      { toolName: 'recipes:run', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const envelope = boundedBody(doored) as any;
    expect((doored as any)._meta?.resultDoor).toMatchObject({
      truncated: true,
      spillUri: expect.any(String),
      upstreamProjected: true,
    });
    expect(envelope).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'incomplete',
      incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      content: [expect.objectContaining({ kind: expect.stringMatching(/reference/), uri: expect.any(String) })],
    });
    expect(envelope.incomplete.note).toContain('capability:read');
    expect(envelope.incomplete.note).toContain("payloadTier:'full'");
    expect((doored as any)._meta.resultDoor.outputEnvelope).toEqual(envelope);
    expect((doored as any)._meta.resultDoor.spillUri).toBe(envelope.content[0].uri);

    const spill = JSON.parse(readSpill('ws-1', 'recipes:run', RUN_ID)) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(spill.content).toHaveLength(1);
    const emitted = JSON.parse(spill.content[0].text) as any;
    const emittedRows = emitted.results[0].result.summary as any[];
    expect(emittedRows).toHaveLength(expectedIds.length);
    expect(emittedRows.map((row) => row.results[0].id)).toEqual(expectedIds);
    expect(emittedRows.map((row) => row.results[0].workItem.state)).toEqual(
      expectedIds.map((_, i) => (i % 2 === 0 ? 'todo' : 'passed')),
    );
    expect(emitted._projection.cursor).toEqual(tieredBody._projection.cursor);
  });

  it('EI-251528: code:run reduction stays visibly partial through a later result-door projection', () => {
    const produced = shapeCodeRunSummary({
      ok: true,
      summary: {
        markerCount: 9,
        rows: Array.from({ length: 18 }, (_, index) => ({
          id: `row-${index}`,
          status: index % 2 === 0 ? 'pass' : 'fail',
          evidence: `evidence-${index} `.repeat(90),
        })),
      },
    }) as any;
    expect(produced.summaryNotice).toMatchObject({ truncated: true });

    const sourceText = JSON.stringify({ ...produced, padding: 'p'.repeat(BUDGET_CHARS * 2) });
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: sourceText }] },
      { toolName: 'code:run', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const inline = boundedBody(doored);

    expect(inline._projection.truncated).toBe(true);
    expect(inline._projection.next).toContain('source is already partial');
    expect((doored as any)._meta.resultDoor.innerTruncationMarkers).toContain('summaryNotice.truncated');
    expect(readSpill('ws-1', 'code:run', RUN_ID)).toContain(sourceText);
  });

  it('EI-25795936191004283: four nested bindings keep their count and marker through code:run and tools:invoke', () => {
    const bindings = Array.from({ length: 4 }, (_, index) => ({
      id: 39_369 + index,
      specId: 'AUTO-BAR-R-7-P-022',
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, field) => [
          `evidence${field}`,
          `binding-${index}-${field}-` + 'x'.repeat(300),
        ]),
      ),
    }));
    const produced = shapeCodeRunSummary({
      ok: true,
      summary: {
        evs: [{
          slug: 'green-main-cycle-time-2026-10-08',
          count: bindings.length,
          bindings,
        }],
        gsTopKeys: ['ok', 'slug', 'harnessSlug', 'bounded', 'detail', 'evidence', 'count', 'currentness'],
        padding: 'p'.repeat(1_000),
      },
    }) as any;

    const shapedBindings = produced.summary.evs[0].bindings as unknown[];
    expect(shapedBindings).toHaveLength(bindings.length);
    expect(shapedBindings).toContain('[omitted]');
    expect(produced.summary.gsTopKeys).toHaveLength(8);
    expect(produced.summaryNotice.arrayOriginalLengths).toMatchObject({
      'summary.evs[0].bindings': 4,
      'summary.gsTopKeys': 8,
    });

    const sourceText = JSON.stringify(produced);
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: sourceText }] },
      { toolName: 'tools:invoke', nestedTargetToolName: 'code:run', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const envelope = JSON.parse((doored.content[0] as { text: string }).text) as {
      schemaVersion?: string;
      state?: string;
      content?: Array<{ uri?: string }>;
    };
    expect(envelope).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'incomplete',
      content: [expect.objectContaining({ uri: expect.any(String) })],
    });
    expect((doored as any)._meta.resultDoor.innerTruncationMarkers).toContain('summaryNotice.truncated');
    const spill = JSON.parse(readSpill('ws-1', 'tools:invoke', RUN_ID)) as {
      content: Array<{ text: string }>;
    };
    expect(JSON.parse(spill.content[0].text)).toEqual(produced);
  });

  it('EI-251528: evaluator rating-map payload-tier omissions remain explicitly incomplete at the result door', () => {
    const criteria = Array.from({ length: 9 }, (_, index) => `criterion-${index + 1}`);
    const ratings = Object.fromEntries(criteria.map((criterion, index) => [criterion, {
      rating: index % 2 === 0 ? 'fail' : 'unknown',
      evidence: `${criterion} evidence `.repeat(35),
      suggestion: `${criterion} suggestion `.repeat(30),
    }]));
    const source = {
      ok: true,
      slug: 'adequacy-plan',
      count: 1,
      rows: [{ specId: 'SPEC-1', planItemId: 'P-001', verdict: 'fail', ratings }],
      padding: 'p'.repeat(20_000),
    };
    const tiered = applyPayloadTier({
      toolName: 'plans:evaluate-spec-test-adequacy',
      shape: undefined,
      response: { data: source },
      tier: 'trimmed',
      args: { slug: 'adequacy-plan' },
      rawDispatchTemplate: "tools:invoke { name:'{tool}', args:{ …original args, payloadTier:'full' } }",
      log: vi.fn(),
    });
    expect(tiered.payloadProjection).toMatchObject({ truncated: true, tier: 'trimmed' });

    const tieredBody = tiered.data as any;
    expect(tieredBody._projection).toMatchObject({ truncated: true });
    expect(tieredBody._projection.omittedCount).toBeGreaterThan(0);
    const row = tieredBody.rows?.[0] ?? {};
    const visibleRatings = row.ratings ?? {};
    const missingRatings = criteria.filter((criterion) => !Object.prototype.hasOwnProperty.call(visibleRatings, criterion));
    expect(missingRatings.length).toBeGreaterThan(0);
    expect(row._partial).toBe(true);
    expect(visibleRatings).not.toHaveProperty('_partial');
    expect(tieredBody._projection.omitted).toContainEqual(expect.objectContaining({
      path: `$.rows[0].ratings.${missingRatings[0]}`,
      reason: 'remaining fields omitted to fit projection budget',
    }));
    expect(tieredBody._projection.omittedCount).toBeGreaterThanOrEqual(missingRatings.length);

    const doored = applyResultDoor(
      {
        content: [{ type: 'text' as const, text: JSON.stringify(tieredBody) }],
        _meta: { payloadProjection: tiered.payloadProjection },
      },
      { toolName: 'plans:evaluate-spec-test-adequacy', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const inline = JSON.parse((doored.content[0] as { text: string }).text) as any;
    expect((doored as any)._meta.resultDoor).toMatchObject({ truncated: true, upstreamProjected: true });
    if (inline.schemaVersion === 'papercusp.output-envelope/v1') {
      expect(inline).toMatchObject({
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      });
    } else {
      expect(inline._projection).toMatchObject({ truncated: true });
    }
    expect(readSpill('ws-1', 'plans:evaluate-spec-test-adequacy', RUN_ID)).toContain('full-detail');
  });

  it('EI-251528: oversized rubrics:amend output signals projection and keeps the routed review actionable inline and in spill', () => {
    const output = {
      ok: true,
      dryRun: true,
      preview: { changes: Array.from({ length: 180 }, (_, index) => ({
        barKey: `R-${index}`,
        detail: `preview-${index} `.repeat(50),
      })) },
      review: {
        state: 'routed',
        conversationId: 'conv-review-1',
        previewPostRef: 'thread-post:42',
        next: "events:await { event:'consult:reply:conv-review-1' }",
      },
    };
    const sourceText = JSON.stringify(output);
    expect(sourceText.length).toBeGreaterThan(BUDGET_CHARS);
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: sourceText }] },
      { toolName: 'rubrics:amend', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const inline = boundedBody(doored);
    const spill = readSpill('ws-1', 'rubrics:amend', RUN_ID);

    expect(inline._projection.truncated).toBe(true);
    expect(inline.review).toMatchObject(output.review);
    expect((doored as any)._meta.resultDoor.spillUri).toContain('papercusp://scratch/ws-1/rubrics:amend/');
    expect(spill).toContain('thread-post:42');
    expect(spill).toContain('consult:reply:conv-review-1');
  });

  it('EI-21986877021459153: plans:get keeps nested item text through the generic result-door fallback', () => {
    const noise = (prefix: string) => Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`${prefix}-${i}`, `noise-${i}`]),
    );
    const itemText = 'Read this plan item before acting on the associated work.';
    const source = {
      ok: true,
      results: [{
        ...noise('result-noise'),
        ok: true,
        slug: 'detail-plan',
        items: [{
          ...noise('item-noise'),
          id: 'P-001',
          text: itemText,
          storedStatus: 'todo',
          effectiveStatus: 'todo',
        }],
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = JSON.stringify(source);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      results: Array<{ items?: Array<{ id?: string; text?: string }> }>;
    } & { _projection: { truncated: true } };
    const item = projected.results[0]?.items?.[0];

    // The result-door must retain the requested item rather than reducing the
    // row to identity/status fields. A short text remains byte-complete; if a
    // future budget change clips it, the projector's explicit marker is the
    // only acceptable alternative to a silent disappearance.
    expect(item).toMatchObject({ id: 'P-001' });
    expect(item?.text).toBe(itemText);
    expect(projected._projection.truncated).toBe(true);
  });

  it('plans:get preserves selected item status and default item text through nested tools:invoke', () => {
    const noise = (prefix: string) => Object.fromEntries(
      Array.from({ length: 128 }, (_, i) => [`${prefix}-${i}`, `noise-${i}`]),
    );
    const itemText = 'Read this selected plan item before acting.';
    const source = {
      ok: true,
      results: [{
        ...noise('result-noise'),
        ok: true,
        slug: 'detail-plan',
        items: [{
          ...noise('item-noise'),
          id: 'P-001',
          text: itemText,
          storedStatus: 'todo',
          effectiveStatus: 'todo',
        }],
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = JSON.stringify(source);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'plans:get',
        // Simulate the host forwarding the caller's explicit status pick. Item
        // text is also a plans:get detail field and must survive by tool policy.
        preservePaths: ['results[].items[].storedStatus'],
        workspaceId: 'ws-1',
        runId: RUN_ID,
      },
    );
    const projected = boundedBody(doored) as unknown as {
      results: Array<{ items?: Array<Record<string, unknown>> }>;
      _projection: { truncated: true };
    };
    const item = projected.results[0]?.items?.[0];

    expect(item).toMatchObject({ id: 'P-001', text: itemText, storedStatus: 'todo' });
    expect(projected._projection.truncated).toBe(true);

    // Falsifiability control: the same bytes and caller-selected status through
    // an unrelated nested target do not inherit plans:get's semantic text rule.
    const control = boundedBody(applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'plans:list',
        preservePaths: ['results[].items[].storedStatus'],
        workspaceId: 'ws-1',
        runId: RUN_ID,
      },
    )) as unknown as { results: Array<{ items?: Array<Record<string, unknown>> }> };
    expect(control.results[0]?.items?.[0]).toMatchObject({ id: 'P-001', storedStatus: 'todo' });
    expect(control.results[0]?.items?.[0]).not.toHaveProperty('text');
  });

  it('EI-20435986111760474: oversized code:tools TypeScript stays valid JSON for direct and nested calls', () => {
    const signatures = Array.from(
      { length: 80 },
      (_, i) => `declare const tools${i}: { dev: { pgQuery(args: { sql: string }): Promise<unknown> } };`,
    ).join('\n');
    expect(signatures.length).toBeGreaterThan(BUDGET_CHARS);

    for (const toolName of ['code:tools', 'tools:invoke']) {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: signatures }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      const body = boundedBody(doored);
      expect(body.text).toContain('declare const tools0');
      expect(body._projection).toMatchObject({
        kind: 'bounded-payload',
        truncated: true,
        cursor: { kind: 'scratch-page', tool: 'capability:read' },
      });
      expect((doored._meta!.resultDoor as { structural: boolean }).structural).toBe(true);
    }
  });

  it('structurally projects oversized text without corrupting schema-bearing structuredContent', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `WI-${i}`,
      state: 'open',
      detail: 'x'.repeat(200),
    }));
    const original = JSON.stringify({ ok: true, rows });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }], structuredContent: { ok: true, rows } },
      { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID },
    ) as DoorableResult;
    const textItems = doored.content.filter((item) => (item as { type?: string }).type === 'text') as Array<{
      text: string;
    }>;
    expect(textItems).toHaveLength(1);
    expect(textItems[0].text.length).toBeLessThan(BUDGET_CHARS);
    const parsed = JSON.parse(textItems[0].text) as {
      _projection: {
        kind: string;
        cursor: { kind: string; tool: string; args: Record<string, unknown> };
        next: string;
      };
    };
    expect(parsed._projection.kind).toBe('bounded-payload');
    expect(parsed._projection.cursor).toMatchObject({
      kind: 'scratch-page',
      tool: 'capability:read',
      args: {
        byte_offset: 0,
        byte_limit: 3_072,
      },
    });
    expect(parsed._projection.cursor.args.file_path).toBe(
      (doored._meta!.resultDoor as { spillPath: string }).spillPath,
    );
    expect(parsed._projection.next).toContain('follow next_cursor;');
    // EI-20335562969900283: the bounded text projection is intentionally not
    // valid against an arbitrary tool's full output schema (it may omit rows
    // or required fields).  structuredContent was explicitly requested as the
    // lossless schema-bearing response and must therefore survive unchanged.
    expect(doored.structuredContent).toEqual({ ok: true, rows });
    expect((doored.structuredContent as { rows: typeof rows }).rows).toHaveLength(300);
    expect(
      (doored.structuredContent as { rows: typeof rows }).rows.every(
        (row) => typeof row.id === 'string' && typeof row.state === 'string' && typeof row.detail === 'string',
      ),
    ).toBe(true);
    expect((doored._meta!.resultDoor as { structural: boolean }).structural).toBe(true);
    expect(readSpill('ws-1', 'work_items:list', RUN_ID).endsWith(original)).toBe(true);
  });

  it('preserves a top-level array root for list-shaped JSON while retaining door recovery metadata', () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      id: `WI-${i}`,
      state: 'open',
      detail: 'x'.repeat(200),
    }));
    const original = JSON.stringify(rows);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }], structuredContent: rows },
      { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID },
    ) as DoorableResult;
    const textItems = doored.content.filter((item) => (item as { type?: string }).type === 'text') as Array<{
      text: string;
    }>;
    expect(textItems).toHaveLength(1);
    expect(textItems[0].text.length).toBeLessThan(BUDGET_CHARS);

    const parsed = JSON.parse(textItems[0].text) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).not.toHaveProperty('_projection');
    expect(parsed).not.toHaveProperty('items');
    expect((parsed as unknown[]).length).toBeLessThan(rows.length);
    expect((parsed as unknown[]).at(-1)).toEqual(expect.objectContaining({
      kind: 'projection-truncation',
      type: 'projection-truncation',
      _truncated: true,
    }));

    const resultDoor = (doored._meta!.resultDoor as {
      structural: boolean;
      recoveryCursor: { kind: string; tool: string; args: Record<string, unknown> };
    });
    expect(resultDoor.structural).toBe(true);
    expect(resultDoor.recoveryCursor).toMatchObject({ kind: 'scratch-page', tool: 'capability:read' });
    expect(resultDoor.recoveryCursor.args.file_path).toBe(
      (doored._meta!.resultDoor as { spillPath: string }).spillPath,
    );
    expect(readSpill('ws-1', 'work_items:list', RUN_ID).endsWith(original)).toBe(true);
    expect(doored.structuredContent).toBe(rows);
  });

  it('REGRESSION (EI-23481355842555588): coord:thread keeps message arrays domain-only and marks the containing envelope partial', () => {
    const entries = Array.from({ length: 300 }, (_, index) => ({
      msg_id: `coord-${index}`,
      kind: 'message',
      from: 'peer',
      summary: `reply-${index} ` + 'x'.repeat(240),
    }));
    const original = JSON.stringify({
      root: 'coord-0',
      entries,
      entries_shown: entries.length,
      entries_total: entries.length,
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'coord:thread', workspaceId: 'ws-1', runId: RUN_ID },
    ) as DoorableResult;
    const projected = JSON.parse((doored.content[0] as { text: string }).text) as {
      entries: Array<Record<string, unknown>>;
      _partial?: boolean;
      _projection: { truncated: boolean; omitted?: Array<{ path: string; reason: string }> };
    };

    expect(projected._projection.truncated).toBe(true);
    expect(projected._partial).toBe(true);
    expect(projected.entries.length).toBeLessThan(entries.length);
    expect(projected.entries.every((entry) =>
      entry.kind === 'message' && typeof entry.msg_id === 'string',
    )).toBe(true);
    expect(projected._projection.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: `$.entries[${projected.entries.length}]`,
        reason: expect.stringContaining('array item(s) omitted'),
      }),
    ]));
  });

  it.each([
    { toolName: 'coord:thread' },
    { toolName: 'tools:invoke', nestedTargetToolName: 'coord:thread' },
  ])('EI-25974584172289918: $toolName keeps projected nested arrays domain-only with recovery', (route) => {
    const source = {
      entries: Array.from({ length: 200 }, (_, index) => ({
        msg_id: `message-${index}`, kind: 'message', summary: 'reply '.repeat(100),
      })),
      values: Array.from({ length: 100 }, (_, index) => index),
    };
    const original = JSON.stringify(source);
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { ...route, workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      entries: Array<Record<string, unknown>>;
      _partial?: boolean;
    };
    const entries = body.entries;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThan(source.entries.length);
    expect(entries.every((row) => row.kind === 'message' && typeof row.msg_id === 'string')).toBe(true);
    expect(body._partial).toBe(true);
    expect(body._projection.truncated).toBe(true);
    expect(body._projection.cursor).toMatchObject({ kind: 'scratch-page', tool: 'capability:read' });
    expect(readSpill('ws-1', route.toolName, RUN_ID).endsWith(original)).toBe(true);
    expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it('REGRESSION (EI-23481355842555588): coord:send delivery verdicts survive generic result-door trimming', () => {
    const noise = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`detail${index}`, 'n'.repeat(900)]),
    );
    const payload = {
      ok: true,
      results: [{
        ok: true,
        ...noise,
        msg_id: 'coord-send-verified-123',
        wake: {
          targets: ['peer-1'],
          queued: 1,
          woken: 1,
          wakeOutcome: 'queued',
          pickupConfirmed: false,
          recipient_absent: false,
          diagnostic: 'd'.repeat(BUDGET_CHARS * 2),
        },
        summary: 'delivery receipt ' + 's'.repeat(BUDGET_CHARS),
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const door = (toolName: string) => {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      return JSON.parse((doored.content[0] as { text: string }).text) as {
        results: Array<Record<string, any>>;
        _projection: { truncated: boolean };
      };
    };

    const parsed = door('coord:send');
    expect(parsed._projection.truncated).toBe(true);
    expect(parsed.results[0]).toMatchObject({
      msg_id: 'coord-send-verified-123',
      wake: {
        queued: 1,
        woken: 1,
        wakeOutcome: 'queued',
        pickupConfirmed: false,
        recipient_absent: false,
      },
    });

    // FALSIFIABILITY CONTROL: the same receipt-shaped bytes through an unrelated
    // tool have no coord:send preservation declaration, so the delivery verdict
    // is not passing merely because the fixture happened to fit.
    const control = door('plans:list');
    expect(control._projection.truncated).toBe(true);
    expect(control.results[0]).not.toHaveProperty('wake');
  });

  it('REGRESSION (EI-22186855527494865): plans:get shipReadiness survives the door while unrequested bulk does not', () => {
    // shipReadiness is OPT-IN and default-OFF: a caller only sees it by asking
    // for it by name, so its ABSENCE reads as "nothing is blocking this plan" —
    // a false green on a ship gate. Measured before the fix on a real read:
    // ok:true, omittedCount:24, omitted:[], and no shipReadiness key at all.
    const bulk = (prefix: string, n: number, len: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, 'x'.repeat(len)]));
    const payload = {
      ok: true,
      results: [{
        ok: true,
        slug: 'effort-scoped-continuity-2026-09-02',
        title: 'Effort-scoped continuity',
        status: 'draft',
        counts: { items: 126, decisions: 16, sections: 11 },
        harness: 'papercusp',
        // Unrequested default payload that outweighs the whole budget — the
        // eviction pressure that dropped the requested field.
        lifecycle: bulk('lc', 40, 400),
        frontmatter: bulk('fm', 40, 400),
        now: bulk('now', 40, 400),
        items: Array.from({ length: 126 }, (_, i) => ({ id: `P-${i}`, text: 'i'.repeat(400) })),
        // Assigned LAST by plans/get.ts, which is why insertion order could not
        // be relied on to save it.
        shipReadiness: {
          planSlug: 'effort-scoped-continuity-2026-09-02',
          satisfied: false,
          code: 'acceptance_ungraded',
          message: 'No acceptance rubric has been graded.',
        },
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const door = (toolName: string) => {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      const textItems = doored.content.filter(
        (item) => (item as { type?: string }).type === 'text',
      ) as Array<{ text: string }>;
      return JSON.parse(textItems[0].text) as {
        results: Array<Record<string, unknown>>;
        _projection: { truncated: boolean; omittedPreserved?: string[] };
      };
    };

    const parsed = door('plans:get');
    expect(parsed._projection.truncated).toBe(true);
    expect(parsed.results[0].shipReadiness).toMatchObject({
      satisfied: false,
      code: 'acceptance_ungraded',
    });
    // Nothing explicitly selected went missing, so the never-shed marker is absent.
    expect(parsed._projection.omittedPreserved).toBeUndefined();

    // FALSIFIABILITY CONTROL: the SAME bytes through a tool with no preserve
    // declaration lose the field to the same budget. Without this the assertion
    // above would also pass on a payload that simply fit.
    const control = door('plans:list');
    expect(control._projection.truncated).toBe(true);
    expect(control.results[0]).not.toHaveProperty('shipReadiness');
  });

  it('REGRESSION (EI-22626647927619840): work_items:complete keeps authority verdicts on later batch rows', () => {
    const results = Array.from({ length: 3 }, (_, i) => {
      const id = `EI-${22_626_647_927_619_840 + i}`;
      return {
        ok: true,
        id,
        completionAuthority: 'proposed',
        countsTowardBurnDown: false,
        authorityWarning:
          "completionAuthority:'proposed' — this close was recorded, but content identity was not committed at write time and the item is NOT counted toward burn-down.",
        requirementShortfallWarning:
          'Completion requirements were deferred because no requirementDisposition was supplied; verify the close before relying on it.',
        workItem: {
          id,
          kind: 'bug',
          state: 'resolved',
          title: `completion row ${i}`,
          summary: 'S'.repeat(3_000),
        },
        completion: { summary: 'C'.repeat(3_000), testsRun: ['focused'] },
      };
    });
    const payload = { ok: true, results, counts: { ok: results.length, failed: 0 } };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const door = (toolName: string) => {
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        { toolName, workspaceId: 'ws-1', runId: RUN_ID },
      ) as DoorableResult;
      const textItems = doored.content.filter(
        (item) => (item as { type?: string }).type === 'text',
      ) as Array<{ text: string }>;
      return JSON.parse(textItems[0].text) as {
        results: Array<Record<string, unknown>>;
        _projection: { truncated: boolean };
      };
    };

    const parsed = door('work_items:complete');
    expect(parsed._projection.truncated).toBe(true);
    const realRows = parsed.results.filter((row) => row._truncated !== true);
    expect(realRows).toHaveLength(results.length);
    for (const row of realRows) {
      expect(row.id).toEqual(expect.stringMatching(/^EI-/));
      expect(row.completionAuthority).toBe('proposed');
      expect(row.countsTowardBurnDown).toBe(false);
      expect(row.authorityWarning).toEqual(expect.any(String));
      expect(row.requirementShortfallWarning).toEqual(expect.any(String));
    }

    // FALSIFIABILITY CONTROL: the same bytes through an unrelated tool have no
    // work_items:complete preservation declaration, so the authority fields are
    // shed by the same generic budget rather than passing because the fixture fits.
    const control = door('plans:list');
    expect(control.results.some((row) => row.completionAuthority === undefined)).toBe(true);
  });

  it('REGRESSION (EI-25394627440656634): preserves committed blocker writes when the ordinary spill fails', () => {
    const noise = Object.fromEntries(
      Array.from({ length: 18 }, (_, index) => [`detail${index}`, 'n'.repeat(900)]),
    );
    const payload = {
      ok: true,
      results: [{
        ok: true,
        id: 'EI-blocker-write-1',
        changed: true,
        ...noise,
        workItem: { id: 'EI-blocker-write-1', state: 'blocked', harness: 'papercup', payload: noise },
        activeBlockers: [{
          kind: 'runtime',
          ref: 'runtime:worker',
          capability: 'live-dependency',
          summary: 'Worker runtime is not ready.',
          nextVerb: 'events:await { event: "runtime:worker" }',
          status: 'active',
        }],
        capabilityDispositions: [{ capability: 'live-dependency', disposition: 'await-event' }],
        blockerHistory: noise,
      }],
      counts: { ok: 1, failed: 0 },
    };
    const original = `format: toon\n${encode(payload, 'toon')}`;
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);
    // Make the normal spill fail deterministically after a committed mutation.
    writeFileSync(join(sandbox, 'scratch'), 'not a directory');

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }], _meta: { format: 'toon' } },
      {
        toolName: 'work_items:set_blocker',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      },
    ) as DoorableResult;
    const output = JSON.parse((doored.content[0] as { text: string }).text) as {
      results: Array<Record<string, any>>;
      _projection: { truncated: boolean; cursor: Record<string, unknown>; next: string };
    };

    expect(output.results[0]).toMatchObject({
      ok: true,
      id: 'EI-blocker-write-1',
      changed: true,
      workItem: { id: 'EI-blocker-write-1', state: 'blocked', harness: 'papercup' },
      activeBlockers: [{
        kind: 'runtime',
        ref: 'runtime:worker',
        capability: 'live-dependency',
        status: 'active',
      }],
      capabilityDispositions: [{ capability: 'live-dependency', disposition: 'await-event' }],
    });
    expect(output._projection).toMatchObject({
      truncated: true,
      cursor: {
        kind: 'volatile-scratch-page',
        tool: 'capability:read',
      },
    });
    expect(output._projection.next).toContain('Do NOT repeat this mutation');
    expect(output._projection.next).toContain('work_items:get');
    expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
      spillFailed: true,
      spillPath: null,
      spillUri: null,
    });
    expect((doored.content[0] as { text: string }).text.length).toBeLessThan(original.length);
  });

  it('REGRESSION (EI-22652581729405439): evaluator compact preview keeps all eight ratings and verdict metadata', () => {
    const criteria = [
      'traceability', 'fixture-calibration', 'falsifiability', 'correct-layer',
      'oracle-independence', 'execution-integrity', 'freshness', 'plan-class-risk-floor',
    ];
    const ratings = Object.fromEntries(criteria.map((criterion, index) => [criterion, {
      rating: index % 2 === 0 ? 'fail' : 'unknown',
      evidence: `${criterion} evidence `.repeat(120),
      suggestion: `${criterion} suggestion `.repeat(80),
    }]));
    const row = {
      specId: 'SPEC-22652581729405439', specRevision: 5, planItemId: 'P-001', ratings,
      requiredProofFloor: 'l4', verdict: 'fail', wouldBlock: criteria.slice(0, 3),
      scorecardDraft: {
        rubricRef: 'spec-test-adequacy', subject: { kind: 'plan', ref: 'adequacy-plan' },
        title: 'Adequacy draft', body: 'draft body '.repeat(800), ratings,
        rerunRecipe: { evaluator: 'plans:evaluate-spec-test-adequacy', args: { slug: 'adequacy-plan' } },
        terminal: true,
      },
    };
    const payload = {
      ok: true, slug: 'adequacy-plan', harnessSlug: 'papercusp',
      classRef: 'plan-class-feature-ship', rubricRef: 'spec-test-adequacy', rows: [row], count: 1,
      verdicts: { pass: 0, fail: 1, unknown: 0 },
      wouldBlock: [{ specId: row.specId, revision: row.specRevision, criteria: row.wouldBlock }],
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:evaluate-spec-test-adequacy', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const kept = JSON.parse((doored.content[0] as { text: string }).text) as any;
    expect(kept._projection.truncated).toBe(true);
    expect(Object.keys(kept.rows[0].ratings)).toEqual(criteria);
    expect(Object.values(kept.rows[0].ratings).every((entry: any) =>
      entry && typeof entry === 'object' && entry._partial === undefined,
    )).toBe(true);
    expect(Object.fromEntries(Object.entries(kept.rows[0].ratings).map(([key, value]: any) => [key, value.rating]))).toEqual(
      Object.fromEntries(criteria.map((criterion, index) => [criterion, index % 2 === 0 ? 'fail' : 'unknown'])),
    );
    expect(kept.rows[0]).toMatchObject({
      _partial: true,
      requiredProofFloor: 'l4',
      verdict: 'fail',
      wouldBlock: criteria.slice(0, 3),
    });
    expect(kept.verdicts).toEqual({ pass: 0, fail: 1, unknown: 0 });
    expect(kept.wouldBlock).toEqual(payload.wouldBlock);
    expect(kept._compactProjection).toMatchObject({ kind: 'evaluator-specific' });
    expect(kept.rows[0].scorecardDraft).toMatchObject({ terminal: true, rubricRef: 'spec-test-adequacy' });
    expect(kept.rows[0].scorecardDraft.body).toBeUndefined();
    expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);

    const control = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:list', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const controlBody = JSON.parse((control.content[0] as { text: string }).text) as any;
    expect(Object.keys(controlBody.rows[0].ratings ?? {})).not.toEqual(criteria);
  });

  it('REGRESSION (EI-22663465512565342, EI-25574253034038454): pipeline verdicts and test route survive a generic door re-projection', () => {
    const marker = 'pipeline-marker-added-by-this-change';
    const currentBuildTestRoute = {
      testClass: 'operator-api',
      readiness: 'ready',
      route: 'staging',
    };
    const admissions = Array.from({ length: 24 }, (_, index) => ({
      paths: [`packages/operator-core/lib/changed-${index}.ts`],
      unchanged: [`packages/operator-core/lib/unchanged-${index}.ts`],
      detail: `admission detail ${index} `.repeat(180),
    }));
    const payload = {
      input: { path: 'packages/operator-core/lib/changed.ts', sha: null },
      positions: { committedLocal: true, onStaging: true, inMain: false, deployed: false },
      positionsMarker: { marker, inMain: true, deployed: true },
      gate: {
        stalled: false,
        repairQueue: { status: 'frozen', admissions },
      },
      ...Object.fromEntries(
        Array.from({ length: 24 }, (_, index) => [`queueNoise${index}`, 'q'.repeat(900)]),
      ),
      changeInCandidate: {
        judgingSha: 'judged-sha',
        judgingShaSource: 'marker',
        judgingContainsPath: false,
        nextCandidateSha: 'next-sha',
        nextContainsPath: false,
        missingReason: 'newer-commit',
        markerJudging: { marker, present: true, count: 1 },
        markerNext: { marker, present: true, count: 1 },
        detail: 'marker settles the judged candidate and next candidate',
      },
      summary: 'pipeline summary',
      // Handler extras are appended after the compact pipeline fields. Keep this
      // late so the generic control reproduces the real omission under pressure.
      currentBuildTestRoute,
    };
    const original = JSON.stringify(payload);
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'dev:pipeline_position', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const kept = JSON.parse((doored.content[0] as { text: string }).text) as any;
    expect(kept._projection.truncated).toBe(true);
    expect(kept.changeInCandidate).toMatchObject({
      judgingSha: 'judged-sha',
      nextCandidateSha: 'next-sha',
      markerJudging: { marker, present: true, count: 1 },
      markerNext: { marker, present: true, count: 1 },
    });
    expect(kept.positions).toMatchObject({ inMain: false, deployed: false });
    expect(kept.positionsMarker).toMatchObject({ marker, inMain: true, deployed: true });
    expect(kept.currentBuildTestRoute).toEqual(currentBuildTestRoute);

    const nestedDoored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'dev:pipeline_position',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      },
    );
    const nestedKept = JSON.parse((nestedDoored.content[0] as { text: string }).text) as any;
    expect(nestedKept._projection.truncated).toBe(true);
    expect(nestedKept.currentBuildTestRoute).toEqual(currentBuildTestRoute);

    // FALSIFIABILITY CONTROL: the same oversized bytes through an ordinary tool
    // have no marker-verdict policy and should still demonstrate the old drop.
    const control = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'plans:list', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const controlBody = JSON.parse((control.content[0] as { text: string }).text) as any;
    expect(controlBody._projection.truncated).toBe(true);
    expect(controlBody.changeInCandidate).toBeUndefined();
    expect(controlBody.currentBuildTestRoute).toBeUndefined();
  });

  it('preserves exact event identity and state while marking overflowed default history incomplete', () => {
    const event = 'harness:papercusp:wi-40086-qualified-current-tip';
    const original = JSON.stringify({
      ok: true,
      event_inspection: {
        event,
        current_generation: 17,
        current_state: 'declared',
        declarations: [{ generation: 17, state: 'declared', note: 'qualification gate' }],
        waiters: Array.from({ length: 200 }, (_, i) => ({
          await_id: i + 1,
          subscriber_id: `su-${i}`,
          policy: 'wake',
          state: 'registered',
          registered_at: '2026-08-23T00:00:00.000Z',
          note: 'x'.repeat(320),
        })),
        wake_outcomes: [],
        resync: {
          required: false,
          reason: 'in_sync',
          consumer_generation: 17,
          authoritative_generation: 17,
        },
      },
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: original }] },
      { toolName: 'events:status', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      _partial?: boolean;
      _projection: ReturnType<typeof boundedBody>['_projection'] & {
        omittedCount: number;
        omitted?: Array<{ path: string; reason: string }>;
        omittedSamplesDropped?: true;
      };
      ok?: boolean;
      event_inspection?: {
        event?: string;
        current_generation?: number;
        current_state?: string;
        waiters?: unknown[];
      };
    };

    expect(body._projection.truncated).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.event_inspection).toMatchObject({
      event,
      current_generation: 17,
      current_state: 'declared',
    });
    expect(body._projection.cursor).toMatchObject({ kind: 'scratch-page', tool: 'capability:read' });
    expect(body._projection.next).toContain('capability:read');
    expect(body._partial).toBe(true);
    const visibleWaiters = body.event_inspection?.waiters ?? [];
    expect(visibleWaiters.length).toBeGreaterThan(0);
    expect(visibleWaiters.length).toBeLessThan(200);
    expect(visibleWaiters.every((row) =>
      row !== null && typeof row === 'object' && (row as { kind?: string }).kind !== 'projection-truncation',
    )).toBe(true);
    const arrayOmission = body._projection.omitted?.find((row) =>
      row.path === `$.event_inspection.waiters[${visibleWaiters.length}]`,
    );
    if (arrayOmission) {
      expect(arrayOmission.reason).toMatch(/\d+ array item\(s\) omitted; showing \d+ of 200 rendered input entries/);
    } else {
      // The payload tier may shed omission samples to keep useful rows in the
      // body. That fallback must disclose the sample loss and retain the exact
      // omission count; the envelope's `_partial` remains the in-band warning.
      expect(body._projection.omittedSamplesDropped).toBe(true);
      expect(body._projection.omittedCount).toBeGreaterThanOrEqual(200 - visibleWaiters.length);
    }

    // The visible summary keeps the requested key/state so ok:true cannot read as
    // absence; the named cursor still recovers every row that the bounded body cut.
    const spillText = readSpill('ws-1', 'events:status', RUN_ID);
    const bodyOffset = (body._projection.cursor as { bodyOffsetInPayload?: number }).bodyOffsetInPayload;
    expect(bodyOffset).toEqual(expect.any(Number));
    const spill = JSON.parse(Buffer.from(spillText, 'utf8').subarray(bodyOffset!).toString('utf8')) as {
      event_inspection: { event: string; current_generation: number; current_state: string; waiters: unknown[] };
    };
    expect(spill.event_inspection).toMatchObject({
      event,
      current_generation: 17,
      current_state: 'declared',
    });
    expect(spill.event_inspection.waiters).toHaveLength(200);
  });

  it('preserves exact event identity through an explicit projection before history overflow', () => {
    // Exercise the tight-budget edge deterministically. The output hint shares
    // this budget with the retained event identity and omission diagnostics.
    doorConstantsMock.mockReturnValue({
      ...BAKED_DOOR_CONSTANTS,
      maxTurnFloorTokens: 7_000,
      maxTurnCapTokens: 7_000,
    });
    const event = 'harness:papercusp:explicit-event-projection';
    const original = JSON.stringify({
      ok: true,
      event_inspection: {
        event,
        current_generation: 23,
        current_state: 'fired',
        waiters: Array.from({ length: 200 }, (_, i) => ({
          await_id: i + 1,
          subscriber_id: `su-explicit-${i}`,
          state: 'registered',
          note: 'y'.repeat(320),
        })),
      },
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const parsed = parseProjection({ pick: [
      'ok',
      'event_inspection.event',
      'event_inspection.current_generation',
      'event_inspection.current_state',
      'event_inspection.waiters',
    ] });
    if (!parsed.ok) throw new Error(parsed.error);
    const projected = applyResultProjection(
      { content: [{ type: 'text' as const, text: original }] },
      parsed.spec,
      { toolName: 'events:status', effect: 'read' },
    );
    const doored = applyResultDoor(projected, {
      toolName: 'events:status',
      workspaceId: 'ws-2',
      runId: RUN_ID,
    });
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      _partial?: boolean;
      _projection: ReturnType<typeof boundedBody>['_projection'] & {
        omitted?: Array<{ path: string; reason: string }>;
      };
      ok?: boolean;
      event_inspection?: {
        event?: string;
        current_generation?: number;
        current_state?: string;
        waiters?: unknown[];
      };
    };

    expect(body._projection.truncated).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.event_inspection).toMatchObject({
      event,
      current_generation: 23,
      current_state: 'fired',
    });
    expect(body._projection.cursor).toMatchObject({ kind: 'scratch-page', tool: 'capability:read' });
    expect(body._projection.next).toContain('capability:read');
    expect(body._partial).toBe(true);
    const visibleWaiters = body.event_inspection?.waiters ?? [];
    expect(visibleWaiters.length).toBeGreaterThan(0);
    expect(visibleWaiters.length).toBeLessThan(200);
    expect(visibleWaiters.every((row) =>
      row !== null && typeof row === 'object' && (row as { kind?: string }).kind !== 'projection-truncation',
    )).toBe(true);
    expect(body._projection.omitted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '$.event_inspection.waiters[' + visibleWaiters.length + ']',
        reason: expect.stringMatching(/\d+ array item\(s\) omitted; showing \d+ of 200 rendered input entries/),
      }),
    ]));

    const spillText = readSpill('ws-2', 'events:status', RUN_ID);
    const bodyOffset = (body._projection.cursor as { bodyOffsetInPayload?: number }).bodyOffsetInPayload;
    expect(bodyOffset).toEqual(expect.any(Number));
    const spill = JSON.parse(Buffer.from(spillText, 'utf8').subarray(bodyOffset!).toString('utf8')) as {
      event_inspection: { event: string; current_generation: number; current_state: string; waiters: unknown[] };
    };
    expect(spill.event_inspection).toMatchObject({
      event,
      current_generation: 23,
      current_state: 'fired',
    });
    expect(spill.event_inspection.waiters).toHaveLength(200);
  });

  it('finds and structurally projects JSON accompanied by advisory prose', () => {
    const original = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({ id: i, detail: 'z'.repeat(100) })),
    });
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: 'See also: work_items:claimable' },
          { type: 'text' as const, text: original },
        ],
      },
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const textItems = doored.content.filter((item) => (item as { type?: string }).type === 'text') as Array<{
      text: string;
    }>;
    expect(textItems).toHaveLength(1);
    expect(() => JSON.parse(textItems[0].text)).not.toThrow();
    expect(JSON.parse(textItems[0].text)._projection.cursor.tool).toBe('capability:read');
    expect(readSpill('ws-1', 'tools:invoke', RUN_ID)).toContain('See also: work_items:claimable');
  });

  it('keeps a JSON payload parseable when advisory text follows it in the MCP result', () => {
    const original = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({ id: `WI-${i}`, detail: 'x'.repeat(120) })),
    });
    const advisory = 'See also: work_items:claimable (the claim floors as a tool)';
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: original },
          { type: 'text' as const, text: advisory },
        ],
      },
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      _projection: { cursor: { bodyOffsetInPayload?: number } };
    };
    const offset = body._projection.cursor.bodyOffsetInPayload;
    expect(offset).toEqual(expect.any(Number));

    const spill = readSpill('ws-1', 'tools:invoke', RUN_ID);
    const spillBytes = Buffer.from(spill, 'utf8');
    const parsed = JSON.parse(spillBytes.subarray(offset!).toString('utf8')) as {
      rows: Array<{ id: string }>;
    };
    expect(parsed.rows).toHaveLength(300);
    expect(spill.endsWith(original)).toBe(true);

    const advisoryLine = spill
      .split('\n')
      .find((line) => line.startsWith('# advisory-text-items-json: '));
    expect(advisoryLine).toBeDefined();
    expect(JSON.parse(advisoryLine!.slice('# advisory-text-items-json: '.length))).toEqual([advisory]);
  });

  it('keeps a JSON payload parseable when advisory prose shares its text item', () => {
    const original = JSON.stringify({
      rows: Array.from({ length: 300 }, (_, i) => ({ id: `WI-${i}`, detail: 'x'.repeat(120) })),
    });
    const advisory = 'See also: work_items:observe (claimability without taking these ids)';
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: `${original}\n\n${advisory}` }] },
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const body = boundedBody(doored) as ReturnType<typeof boundedBody> & {
      _projection: { cursor: { bodyOffsetInPayload?: number } };
    };
    const spill = readSpill('ws-1', 'tools:invoke', RUN_ID);
    const parsed = JSON.parse(
      Buffer.from(spill, 'utf8').subarray(body._projection.cursor.bodyOffsetInPayload!).toString('utf8'),
    ) as { rows: Array<{ id: string }> };

    expect(parsed.rows).toHaveLength(300);
    expect(spill.endsWith(original)).toBe(true);
    expect(spill).toContain(`# advisory-text-items-json: ${JSON.stringify([advisory])}`);
  });

  it('preserves typed evidence selectors on ordinary JSON spill references', () => {
    const original = JSON.stringify({
      ok: true,
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `EI-${i}`,
        workItem: { id: `EI-${i}`, state: 'open' },
        detail: 'x'.repeat(120),
      })),
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const input: DoorableResult = { content: [{ type: 'text' as const, text: original }] };
    const doored = applyResultDoor(
      input,
      { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const spillPath = (doored._meta!.resultDoor as { spillPath: string }).spillPath;
    const parsed = scratchReference.parseScratchReference(readFileSync(spillPath))!;

    expect(parsed.manifest.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceClass: 'work-item',
          contentIndex: 0,
          jsonPointers: expect.arrayContaining(['/results/0/workItem']),
        }),
      ]),
    );
  });

  it('preserves a degraded projection warning when structurally bounding its oversized JSON body', () => {
    const original = JSON.stringify({
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `WI-${i}`,
        title: `work item ${i}`,
        detail: 'x'.repeat(120),
      })),
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    // A PARTIAL miss keeps the oversized body (the matched path still returns every
    // row) while carrying a degraded warning — the combination this test needs. An
    // ALL-miss no longer qualifies: EI-23774219620725180 made that case REFUSE with
    // a bounded key list instead of failing open into the full body, so it never
    // reaches structural bounding at all (covered in result-projection/apply.test.ts).
    const parsed = parseProjection({ pick: ['results[].id', 'results[].detail', 'results[].missing'] });
    if (!parsed.ok) throw new Error(parsed.error);
    const projected = applyResultProjection(
      { content: [{ type: 'text' as const, text: original }] },
      parsed.spec,
      { toolName: 'work_items:list', effect: 'read' },
    );
    const projectedWarning = (projected.content[0] as { text: string }).text;
    expect(projectedWarning).toMatch(/^⚠/);
    expect(projectedWarning).toContain('matched nothing');

    const doored = applyResultDoor(projected, {
      toolName: 'work_items:list',
      workspaceId: 'ws-1',
      runId: RUN_ID,
    });
    const textItems = doored.content.filter(
      (item) => (item as { type?: string }).type === 'text',
    ) as Array<{ text: string }>;

    // The warning is the first model-facing item; the bounded JSON remains a
    // separately parseable second item. The old implementation returned only
    // the latter and silently erased the degraded verdict.
    expect(textItems).toHaveLength(2);
    expect(textItems[0].text).toBe(projectedWarning);
    const bounded = JSON.parse(textItems[1].text) as {
      results: Array<Record<string, unknown>>;
      _projection: { truncated: boolean };
    };
    expect(bounded._projection.truncated).toBe(true);
    expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);
    expect(readSpill('ws-1', 'work_items:list', RUN_ID)).toContain('matched nothing');
  });

  it('CONTROL: a clean projection footer remains spill-only during structural bounding', () => {
    const original = JSON.stringify({
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `WI-${i}`,
        detail: 'x'.repeat(120),
      })),
    });
    expect(original.length).toBeGreaterThan(BUDGET_CHARS);

    const parsed = parseProjection({ pick: ['results[].detail'] });
    if (!parsed.ok) throw new Error(parsed.error);
    const projected = applyResultProjection(
      { content: [{ type: 'text' as const, text: original }] } as DoorableResult,
      parsed.spec,
      { toolName: 'work_items:list', effect: 'read' },
    );
    expect((projected._meta?.resultProjection as { notes: string[] }).notes).toEqual([]);

    const doored = applyResultDoor(projected, {
      toolName: 'work_items:list',
      workspaceId: 'ws-1',
      runId: RUN_ID,
    });
    const textItems = doored.content.filter(
      (item) => (item as { type?: string }).type === 'text',
    ) as Array<{ text: string }>;

    expect(textItems).toHaveLength(1);
    expect(textItems[0].text).not.toMatch(/^⚠/);
    expect(JSON.parse(textItems[0].text)).toMatchObject({
      _projection: { truncated: true },
    });
  });

  it('caps an unusually verbose degraded projection warning before preserving it', () => {
    const warning = `⚠ ${'warning '.repeat(400)}`;
    const original = JSON.stringify({
      results: Array.from({ length: 300 }, (_, i) => ({
        id: `WI-${i}`,
        detail: 'x'.repeat(120),
      })),
    });
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: warning },
          { type: 'text' as const, text: original },
        ],
        _meta: { resultProjection: { applied: true, notes: ['synthetic degraded warning'] } },
      },
      { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const warningItem = doored.content.find(
      (item) => (item as { type?: string }).type === 'text' &&
        (item as { text?: string }).text?.startsWith('⚠'),
    ) as { text: string } | undefined;
    expect(warningItem?.text).toHaveLength(1_200);
    expect(warningItem?.text.startsWith('⚠')).toBe(true);
    expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);
  });

  it('a multi-line text spill teaches the bounded saved-result query recovery path', () => {
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }] },
      { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
    );
    const next = boundedBody(doored)._projection.next;
    expect(next).toContain('capability:read { file_path, query:"terms" }');
    expect(next).toContain('all terms, context and coverage');
  });

  it('D-021: mixed over-budget text/non-text is stored once behind a typed reference', () => {
    const img = { type: 'image', data: 'aaaa', mimeType: 'image/png' };
    const doored = applyResultDoor(
      {
        content: [
          { type: 'text' as const, text: longText(BUDGET_CHARS * 2) },
          img,
          { type: 'text' as const, text: 'trailing text fully over budget' },
        ],
      },
      { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
    );
    expect(doored.content).not.toContainEqual(img);
    expect(doored.content.filter((c) => (c as { type?: string }).type === 'text')).toHaveLength(1);
    const envelope = JSON.parse((doored.content[0] as { text: string }).text);
    expect(envelope).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      summaryProvenance: 'authored',
      state: 'incomplete',
      // The three blocks were RELOCATED into the spill, not dropped, so they are
      // reported as `spilledItems`; `omittedItems` is reserved for bytes that
      // were never serialized and must be absent here (EI-21954450841272611).
      incomplete: { reason: 'non-text-result-budget-exceeded', spilledItems: 3, recoverable: true },
      content: [
        {
          kind: 'reference',
          byteCount: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresAt: expect.any(String),
          audience: 'workspace',
        },
      ],
    });
    expect(envelope.incomplete.note).toContain('framed scratch-reference container, not a raw JSON file');
    expect(envelope.incomplete.note).toContain('`capability:read`');
    const spill = readSpill('ws-1', 'plans:get', RUN_ID);
    expect(spill).toContain('trailing text fully over budget');
    expect(spill).toContain('"type":"image"');
    // EI-21282689413153947 recurrence guards: (a) the spill NAME must not claim
    // a strict machine format the self-describing wrapper (magic + manifest +
    // payload) breaks — a `.json` file jq cannot parse whole was the exact
    // reported failure; (b) the payload behind the canonical reader
    // (parseScratchReference, applied inside readSpill) stays parseable JSON.
    const spillDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'plans:get', RUN_ID);
    expect(readdirSync(spillDir)[0].endsWith('.json')).toBe(false);
    expect(() => JSON.parse(spill)).not.toThrow();
  });

  it('P-029: aggregate evidence is stored once and exposed as typed per-class references', () => {
    const aggregateScope = beginResultDoorAggregate({ sessionKey: 'su-owner', outputGroupId: 'turn-evidence' });
    applyResultDoor(
      { content: [{ type: 'text' as const, text: 'prelude'.repeat(1_000) }] },
      { toolName: 'code:run', workspaceId: 'ws-1', ownerId: 'su-owner', aggregateScope },
    );
    // One aggregate cohort admits exactly two per-result door slots. Fill both
    // before the evidence-bearing third result proves the overflow route.
    applyResultDoor(
      { content: [{ type: 'text' as const, text: 'second prelude'.repeat(1_000) }] },
      { toolName: 'code:run', workspaceId: 'ws-1', ownerId: 'su-owner', aggregateScope },
    );
    const evidence = {
      workItems: [{ id: 'WI-1', state: 'done' }],
      events: [{ event: 'gate:ready', status: 'fired' }],
      fleet: { slug: 'orch-unify', alive: 3 },
      capacity: { available: 2 },
      accounts: [{ id: 'default', status: 'ready' }],
      release: { gate: 'green' },
      padding: 'x'.repeat(BUDGET_CHARS),
    };
    const result = applyResultDoor(
      { content: [{ type: 'text' as const, text: JSON.stringify(evidence) }] },
      {
        toolName: 'code:run',
        workspaceId: 'ws-1',
        ownerId: 'su-owner',
        runId: RUN_ID,
        aggregateScope,
      },
    );
    const envelope = JSON.parse((result.content[0] as { text: string }).text);
    expect(envelope.content).toEqual(
      ['work-item', 'event', 'fleet', 'capacity', 'account', 'release'].map((evidenceClass) =>
        expect.objectContaining({
          kind: 'evidence-reference',
          evidenceClass,
          uri: expect.stringContaining('/code:run/'),
        }),
      ),
    );
    expect(new Set(envelope.content.map((item: { uri: string }) => item.uri)).size).toBe(1);
    const spillDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'code:run', RUN_ID);
    expect(readdirSync(spillDir)).toHaveLength(1);
    const parsed = scratchReference.parseScratchReference(readFileSync(join(spillDir, readdirSync(spillDir)[0])))!;
    expect(parsed.manifest.evidence?.map((entry) => entry.evidenceClass)).toEqual([
      'work-item', 'event', 'fleet', 'capacity', 'account', 'release',
    ]);
    expect(JSON.parse(parsed.payload.toString('utf8')).content[0].text).toBe(JSON.stringify(evidence));
  });

  it('a genuine delta ENVELOPE result (_meta.delta.mode !== "full") is NEVER doored — its text is client-parsed JSON', () => {
    const result = {
      content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      _meta: { delta: { mode: 'reconstructed' } },
    };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it('EI-19325631662380565: a delta-CAPABLE result whose body is normal (mode:"full", reason:"no_request") IS doored', () => {
    // Regression guard: every delta-capable tool stamps `_meta.delta` on an
    // ORDINARY full response to advertise the capability + carry a cursor — the
    // mere presence of the block used to skip the door entirely for the whole
    // list-tool family (work_items:list, coord:orient, ...), the fattest
    // population the door exists to cap. `mode` is the discriminator, not presence.
    const result = {
      content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      _meta: { delta: { mode: 'full', reason: 'no_request', itemKeyField: 'id' } },
    };
    const doored = applyResultDoor(result, { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID });
    expect(doored).not.toBe(result);
    const totalChars = doored.content
      .filter((c) => (c as { type?: string }).type === 'text')
      .reduce((n, c) => n + (c as { text: string }).text.length, 0);
    expect(totalChars).toBeLessThan(longText(BUDGET_CHARS * 2).length);
    expect((doored.content.at(-1) as { text: string }).text).toContain('result-door');
  });

  it('EI-19325631662380565: a proxy-RECONSTRUCTED full body (mode:"full", reason:"proxy_reconstructed") IS doored too', () => {
    const result = {
      content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      _meta: { delta: { mode: 'full', reason: 'proxy_reconstructed' }, deltaProxy: { reconstructedFull: true } },
    };
    const doored = applyResultDoor(result, { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID });
    expect(doored).not.toBe(result);
  });

  it('kill-switch PAPERCUSP_RESULT_DOOR_OFF=1 bypasses entirely', () => {
    process.env.PAPERCUSP_RESULT_DOOR_OFF = '1';
    const result = { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] };
    expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
  });

  it("an unscoped caller ('*' workspace) spills under 'unscoped'; a non-UUID runId gets a fresh UUID", () => {
    const reportedRunId = 'bbc9c2b7-872b-496a-b3f4-4127e25c8e868d';
    const doored = applyResultDoor(
      { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] },
      { toolName: 'plans:get', workspaceId: '*', runId: reportedRunId },
    );
    const pointer = (doored.content.at(-1) as { text: string }).text;
    expect(pointer).toContain('papercusp://scratch/unscoped/plans:get/');
    expect(pointer).not.toContain(reportedRunId);
    expect(pointer).toMatch(
      /papercusp:\/\/scratch\/unscoped\/plans:get\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i,
    );
  });

  it('P-023: a per-session override widens the door — the same over-baked result passes through', () => {
    const original = longText(BUDGET_CHARS * 2); // over the BAKED 1500-token door
    // The session's resolved constants double the floor → resultEach 3000 tokens.
    doorConstantsMock.mockReturnValue({ ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 16_000 });
    const result = { content: [{ type: 'text' as const, text: original }] };
    expect(
      applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID, ownerId: 'su-x' }),
    ).toBe(result);
    expect(doorConstantsMock).toHaveBeenCalledWith('su-x'); // keyed on the caller's identity
  });

  describe('D-021 non-text payloads share the hard output budget', () => {
    const bigImage = (chars: number) => ({
      type: 'image',
      data: 'A'.repeat(chars),
      mimeType: 'image/png',
    });

    it('spills an over-budget image and returns only a typed reference envelope', () => {
      const result: DoorableResult = {
        content: [{ type: 'text' as const, text: 'tiny caption' }, bigImage(BUDGET_CHARS * 3)],
      };
      const doored = applyResultDoor(result, {
        toolName: 'computer:screenshot',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });

      expect(doored.content).not.toContainEqual(bigImage(BUDGET_CHARS * 3));
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.state).toBe('incomplete');
      expect(envelope.content[0]).toMatchObject({
        kind: 'reference',
        uri: expect.stringContaining('papercusp://scratch/ws-1/computer:screenshot/'),
        byteCount: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        truncated: true,
        structural: true,
        reason: 'non-text-result-budget-exceeded',
        nonTextBytes: BUDGET_CHARS * 3,
      });
      expect(readSpill('ws-1', 'computer:screenshot', RUN_ID)).toContain('tiny caption');
    });

    it('CONTROL: a SMALL non-text item keeps the identity fast-path byte-identical', () => {
      // Without this, the assertion above would also pass against a door that had
      // started appending a notice to every result carrying any non-text block —
      // which would be a regression dressed as this fix.
      const result = {
        content: [{ type: 'text' as const, text: 'small' }, bigImage(64)],
      };
      expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it('counts non-text UTF-8 bytes in structural metadata when the result is doored', () => {
      const input: DoorableResult = {
        content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }, bigImage(5_000)],
      };
      const doored = applyResultDoor(input, {
        toolName: 'computer:screenshot',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const meta = (doored._meta as { resultDoor?: { nonTextBytes?: number } } | undefined)?.resultDoor;
      expect(meta?.nonTextBytes).toBe(5_000);
    });

    it('spill failure returns a bounded explicit error and never re-exposes binary data', () => {
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');
      const original = bigImage(BUDGET_CHARS * 3);
      const input: DoorableResult = { content: [original] };
      const doored = applyResultDoor(input, { toolName: 'computer:screenshot', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope).toMatchObject({
        state: 'incomplete',
        incomplete: { recoverable: true },
      });
      expect(envelope.content[0]).toMatchObject({ kind: 'reference' });
      expect((doored.content[0] as { text: string }).text).not.toContain(original.data);
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
      });
    });
  });

  describe('P-006 aggregate budget spans one explicit or compatibility cohort', () => {
    const medium = (): DoorableResult => ({
      content: [{ type: 'text' as const, text: 'm'.repeat(5_000) }],
    });
    const expectVolatileEnvelope = (envelope: {
      state?: string;
      error?: unknown;
      content?: Array<Record<string, unknown>>;
      incomplete?: { recoverable?: boolean; note?: string };
    }, expectedText: string) => {
      expect(envelope.state).toBe('incomplete');
      expect(envelope.error).toBeUndefined();
      expect(envelope.incomplete?.recoverable).toBe(true);
      const reference = envelope.content?.find((item) => item.kind === 'reference');
      expect(reference?.uri).toEqual(expect.stringMatching(/^papercusp:\/\/scratch-memory\//));
      expect(reference?.expiresAt).toEqual(expect.any(String));
      if (typeof reference?.uri !== 'string') throw new Error('missing volatile reference URI');
      expect(readVolatilePayloadText(reference.uri)).toBe(expectedText);
      expect(JSON.stringify(envelope)).not.toContain(sandbox);
      return envelope.incomplete?.note ?? '';
    };

    it.each([
      { label: 'direct', toolName: 'scorecards:emit' },
      { label: 'nested', toolName: 'tools:invoke', nestedTargetToolName: 'scorecards:emit' },
    ])('preserves the scorecard write receipt after a $label spill failure', ({ toolName, nestedTargetToolName }) => {
      const noise = Object.fromEntries(
        Array.from({ length: 18 }, (_, index) => [`detail${index}`, 'n'.repeat(900)]),
      );
      const receipt = {
        ok: true,
        completionReceipt: { status: 'recorded', effectRef: 'scorecard-emit-1' },
        canonicalRatings: { 'degenerate-distribution': { rating: 'preserved-rating' } },
        created: true,
        issueId: 'scorecard-emit-1',
        ...noise,
      };
      const original = JSON.stringify(receipt);
      expect(original.length).toBeGreaterThan(BUDGET_CHARS);
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');

      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        {
          toolName,
          ...(nestedTargetToolName ? { nestedTargetToolName } : {}),
          workspaceId: 'ws-1',
          runId: RUN_ID,
        },
      ) as DoorableResult;
      const output = JSON.parse((doored.content[0] as { text: string }).text) as {
        completionReceipt: Record<string, unknown>;
        canonicalRatings: Record<string, { rating: unknown }>;
        created: boolean;
        issueId: string;
        _projection: { kind: string; truncated: boolean; cursor: Record<string, unknown>; next: string };
      };

      expect(output).toMatchObject({
        completionReceipt: { status: 'recorded', effectRef: 'scorecard-emit-1' },
        canonicalRatings: { 'degenerate-distribution': { rating: 'preserved-rating' } },
        created: true,
        issueId: 'scorecard-emit-1',
      });
      expect(output._projection).toMatchObject({
        kind: 'bounded-payload',
        truncated: true,
        cursor: { kind: 'volatile-scratch-page', tool: 'capability:read', reason: 'spill-write-failed' },
      });
      expect(output._projection.next).toContain('Do NOT repeat this non-idempotent emit');
      expect(output._projection.next).toContain('completionReceipt');
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
      });
      expect((doored.content[0] as { text: string }).text.length).toBeLessThan(original.length);
    });

    it('preserves every canonical rating through the outer tools:invoke result door', () => {
      const canonicalRatingKeys = [
        'base-rate-check',
        'instrument-split',
        'terminal-re-rate',
        'platform-telemetry-excluded',
        're-runnable-evidence',
        'degenerate-distribution',
      ] as const;
      const canonicalRatings = Object.fromEntries(
        canonicalRatingKeys.map((key) => [key, {
          rating: `${key}:pass`,
          evidence: 'e'.repeat(1_100),
        }]),
      );
      const source = {
        ok: true,
        committed: true,
        completionReceipt: { status: 'recorded', effectRef: 'scorecard-all-ratings-1' },
        canonicalRatings,
        created: true,
        issueId: 'scorecard-all-ratings-1',
        detail: 'd'.repeat(BUDGET_CHARS * 2),
      };
      const original = JSON.stringify(source);
      expect(original.length).toBeGreaterThan(BUDGET_CHARS);

      const doored = applyResultDoor(
        {
          content: [{ type: 'text' as const, text: original }],
          structuredContent: source,
        },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'scorecards:emit',
          workspaceId: 'ws-1',
          runId: RUN_ID,
        },
      );
      const output = JSON.parse((doored.content[0] as { text: string }).text) as {
        canonicalRatings: Record<string, { rating?: string }>;
        _projection?: { truncated?: boolean };
      };

      expect(output._projection?.truncated).toBe(true);
      for (const key of canonicalRatingKeys) {
        expect(output.canonicalRatings[key]).toMatchObject({ rating: `${key}:pass` });
      }
      expect((doored.content[0] as { text: string }).text.length).toBeLessThan(original.length);
      expect(readSpill('ws-1', 'tools:invoke', RUN_ID)).toContain('scorecard-all-ratings-1');
    });

    it.each([
      { label: 'direct', toolName: 'scorecards:emit' },
      { label: 'nested', toolName: 'tools:invoke', nestedTargetToolName: 'scorecards:emit' },
    ])('preserves a committed scorecard receipt after $label aggregate spill failure', async ({ toolName, nestedTargetToolName }) => {
      const scope = () => beginResultDoorAggregate({ sessionKey: 'scorecard-emit-hard-failure', outputGroupId: 'turn-1' });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');

      const noise = Object.fromEntries(
        Array.from({ length: 18 }, (_, index) => [`detail${index}`, 'n'.repeat(900)]),
      );
      const receipt = {
        ok: true,
        completionReceipt: { status: 'recorded', effectRef: 'scorecard-emit-hard-1' },
        canonicalRatings: { 'degenerate-distribution': { rating: 'preserved-rating' } },
        created: true,
        issueId: 'scorecard-emit-hard-1',
        ...noise,
      };
      const original = JSON.stringify(receipt);
      const doored: DoorableResult = await applyResultDoorAsync(
        { content: [{ type: 'text' as const, text: original }], structuredContent: receipt },
        {
          toolName,
          ...(nestedTargetToolName ? { nestedTargetToolName } : {}),
          workspaceId: 'ws-1',
          runId: RUN_ID,
          aggregateScope: scope(),
        },
      );
      const output = JSON.parse((doored.content[0] as { text: string }).text) as {
        committed?: boolean;
        completionReceipt?: Record<string, unknown>;
        canonicalRatings?: Record<string, { rating: unknown }>;
        created?: boolean;
        issueId?: string;
        _projection?: { cursor?: Record<string, unknown>; next?: string };
        error?: Record<string, unknown>;
      };

      expect(output).toMatchObject({
        ok: true,
        committed: true,
        completionReceipt: { status: 'recorded', effectRef: 'scorecard-emit-hard-1' },
        canonicalRatings: { 'degenerate-distribution': { rating: 'preserved-rating' } },
        created: true,
        issueId: 'scorecard-emit-hard-1',
      });
      expect(output.error).toBeUndefined();
      expect(output._projection?.cursor).toMatchObject({
        kind: 'volatile-scratch-page',
        tool: 'capability:read',
        reason: 'spill-write-failed',
      });
      expect(output._projection?.next).toContain('Do NOT repeat this non-idempotent emit');
      expect(doored.structuredContent).toEqual(receipt);
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
        reason: 'aggregate-output-budget-exceeded',
      });
      expect((doored.content[0] as { text: string }).text.length).toBeLessThan(original.length);
    });

    it.each([
      { label: 'direct', toolName: 'scorecards:emit' },
      { label: 'nested', toolName: 'tools:invoke', nestedTargetToolName: 'scorecards:emit' },
    ])('marks a $label scorecard hard-spill failure non-retryable when no receipt is available', ({ toolName, nestedTargetToolName }) => {
      const scope = () => beginResultDoorAggregate({ sessionKey: 'scorecard-emit-no-receipt', outputGroupId: 'turn-1' });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');

      const receipt = {
        ok: true,
        ...Object.fromEntries(Array.from({ length: 18 }, (_, index) => [`detail${index}`, 'n'.repeat(900)])),
      };
      const original = JSON.stringify(receipt);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        {
          toolName,
          ...(nestedTargetToolName ? { nestedTargetToolName } : {}),
          workspaceId: 'ws-1',
          runId: RUN_ID,
          aggregateScope: scope(),
        },
      );
      const output = JSON.parse((doored.content[0] as { text: string }).text) as {
        state?: string;
        error?: { code?: string; message?: string; retryable?: boolean };
        content?: Array<Record<string, unknown>>;
        incomplete?: { note?: string };
      };

      const note = expectVolatileEnvelope(output, original);
      expect(note).toContain('Do NOT repeat this non-idempotent emit');
      expect(note).toContain('scorecard ledger');
    });

    it('retains a nested coord:send receipt when the aggregate hard-spill write fails', () => {
      // Two ordinary results consume 10KB of the 12KB cohort. The third result
      // must take the hard whole-result spill route; making scratch unavailable
      // exercises the failure path without an environmental race.
      const scope = () => beginResultDoorAggregate({ sessionKey: 'owner-receipt-fallback', outputGroupId: 'turn-1' });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');

      const receipt = {
        ok: true,
        results: [{
          ok: true,
          msg_id: 'persisted-message',
          queued: true,
          woken: 1,
          wakeOutcome: 'queued',
          body: 'x'.repeat(4_800),
        }],
        counts: { ok: 1, failed: 0 },
      };
      const input: DoorableResult = {
        content: [{ type: 'text' as const, text: JSON.stringify(receipt) }],
      };
      const doored = applyResultDoor(input, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'coord:send',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        aggregateScope: scope(),
      });

      const output = JSON.parse((doored.content[0] as { text: string }).text) as {
        results: Array<Record<string, unknown>>;
        _projection: { kind: string; truncated: boolean; cursor: Record<string, unknown>; next: string };
      };
      expect(output.results).toMatchObject([{
        msg_id: 'persisted-message',
        queued: true,
        woken: 1,
        wakeOutcome: 'queued',
      }]);
      expect(output._projection).toMatchObject({
        kind: 'bounded-payload',
        truncated: true,
        cursor: { kind: 'volatile-scratch-page', tool: 'capability:read', reason: 'spill-write-failed' },
      });
      expect(output._projection.next).toContain('Do not repeat coord:send');
      expect(output._projection.next).toContain('coord:read');
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
      });
      expect((doored.content[0] as { text: string }).text.length).toBeLessThan(JSON.stringify(receipt).length);
    });

    it('retains a nested work_items:complete write receipt when the aggregate spill fails', () => {
      const scope = () => beginResultDoorAggregate({ sessionKey: 'owner-completion-receipt', outputGroupId: 'turn-1' });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });

      const completion = {
        ok: true,
        results: [{
          ok: true,
          id: 'EI-completion-receipt-1',
          completionAuthority: 'committed',
          countsTowardBurnDown: true,
          workItem: { id: 'EI-completion-receipt-1', state: 'resolved' },
          completion: { summary: 'C'.repeat(4_500) },
        }],
        counts: { ok: 1, failed: 0 },
      };
      const original = JSON.stringify(completion);
      expect(original.length).toBeGreaterThan(4_500);

      const failure = Object.assign(new Error('workspace quota exhausted'), { code: 'SCRATCH_QUOTA_EXCEEDED' });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'work_items:complete',
          workspaceId: 'ws-1',
          runId: RUN_ID,
          aggregateScope: scope(),
          scratchWriteFailure: { error: failure },
        },
      ) as DoorableResult;
      const output = JSON.parse((doored.content[0] as { text: string }).text) as {
        results: Array<Record<string, any>>;
        _projection: { truncated: boolean; cursor: Record<string, unknown>; next: string };
      };

      expect(output.results[0]).toMatchObject({
        ok: true,
        id: 'EI-completion-receipt-1',
        completionAuthority: 'committed',
        countsTowardBurnDown: true,
        workItem: { id: 'EI-completion-receipt-1', state: 'resolved' },
      });
      expect(output._projection).toMatchObject({
        truncated: true,
        cursor: {
          kind: 'volatile-scratch-page',
          tool: 'capability:read',
          reason: 'spill-write-failed',
          errorCode: 'SCRATCH_QUOTA_EXCEEDED',
        },
      });
      expect(output._projection.next).toContain('Do NOT repeat work_items:complete');
      expect(output._projection.next).toContain('work_items:get');
      const cursorUri = output._projection.cursor.uri;
      if (typeof cursorUri !== 'string') throw new Error('missing volatile completion cursor URI');
      expect(readVolatilePayloadText(cursorUri)).toBe(original);
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        spillFailed: true,
        spillPath: null,
        spillUri: null,
        spillErrorCode: 'SCRATCH_QUOTA_EXCEEDED',
      });
      expect((doored.content[0] as { text: string }).text.length).toBeLessThan(original.length);
    });

    it('retains committed work_items:set_blocker verdicts when the aggregate spill fails', () => {
      const scope = () => beginResultDoorAggregate({ sessionKey: 'owner-blocker-receipt', outputGroupId: 'turn-1' });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });

      const receipt = {
        ok: true,
        results: [{
          ok: true,
          id: 'EI-blocker-write-2',
          changed: true,
          workItem: { id: 'EI-blocker-write-2', state: 'blocked', harness: 'papercup' },
          activeBlockers: [{ kind: 'runtime', ref: 'runtime:worker', status: 'active' }],
          blockerHistory: 'B'.repeat(4_800),
        }],
        counts: { ok: 1, failed: 0 },
      };
      const original = JSON.stringify(receipt);
      const failure = Object.assign(new Error('workspace quota exhausted'), { code: 'SCRATCH_QUOTA_EXCEEDED' });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'work_items:set_blocker',
          workspaceId: 'ws-1',
          runId: RUN_ID,
          aggregateScope: scope(),
          scratchWriteFailure: { error: failure },
        },
      ) as DoorableResult;
      const output = JSON.parse((doored.content[0] as { text: string }).text) as {
        results: Array<Record<string, any>>;
        _projection: { truncated: boolean; cursor: Record<string, unknown>; next: string };
      };

      expect(output.results[0]).toMatchObject({
        ok: true,
        id: 'EI-blocker-write-2',
        changed: true,
        workItem: { id: 'EI-blocker-write-2', state: 'blocked', harness: 'papercup' },
        activeBlockers: [{ kind: 'runtime', ref: 'runtime:worker', status: 'active' }],
      });
      expect(output._projection).toMatchObject({
        truncated: true,
        cursor: {
          kind: 'volatile-scratch-page',
          tool: 'capability:read',
        },
      });
      expect(output._projection.next).toContain('Do NOT repeat this mutation');
      expect(output._projection.next).toContain('work_items:get');
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        spillFailed: true,
        spillErrorCode: 'SCRATCH_QUOTA_EXCEEDED',
        spillPath: null,
        spillUri: null,
      });
      expect((doored.content[0] as { text: string }).text.length).toBeLessThan(original.length);
    });

    it('makes a nested work_items:set_blocker hard-spill failure non-retryable without a parseable receipt', () => {
      const scope = () => beginResultDoorAggregate({ sessionKey: 'owner-blocker-no-receipt', outputGroupId: 'turn-1' });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });

      const failure = Object.assign(new Error('workspace quota exhausted'), { code: 'SCRATCH_QUOTA_EXCEEDED' });
      const original = 'x'.repeat(4_800);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'work_items:set_blocker',
          workspaceId: 'ws-1',
          runId: RUN_ID,
          aggregateScope: scope(),
          scratchWriteFailure: { error: failure },
        },
      ) as DoorableResult;
      const envelope = JSON.parse((doored.content[0] as { text: string }).text) as {
        error?: { code?: string; message?: string; retryable?: boolean };
        state?: string;
        content?: Array<Record<string, unknown>>;
        incomplete?: { note?: string };
      };

      const note = expectVolatileEnvelope(envelope, original);
      expect(note).toContain('Do NOT repeat it');
      expect(note).toContain('work_items:get');
    });

    it('makes a nested work_items:complete hard-spill failure non-retryable when no receipt parses', () => {
      const scope = () => beginResultDoorAggregate({ sessionKey: 'owner-completion-no-receipt', outputGroupId: 'turn-1' });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });
      applyResultDoor(medium(), { toolName: 'tools:invoke', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope() });

      const failure = Object.assign(new Error('workspace quota exhausted'), { code: 'SCRATCH_QUOTA_EXCEEDED' });
      const original = 'x'.repeat(4_800);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'work_items:complete',
          workspaceId: 'ws-1',
          runId: RUN_ID,
          aggregateScope: scope(),
          scratchWriteFailure: { error: failure },
        },
      ) as DoorableResult;
      const envelope = JSON.parse((doored.content[0] as { text: string }).text) as {
        error?: { code?: string; message?: string; retryable?: boolean };
        state?: string;
        content?: Array<Record<string, unknown>>;
        incomplete?: { note?: string };
      };

      const note = expectVolatileEnvelope(envelope, original);
      expect(note).toContain('Do NOT repeat this call');
      expect(note).toContain('work_items:get');
    });

    it('marks a nested coord:send hard-spill failure non-retryable when no receipt can be recovered', () => {
      const failure = Object.assign(new Error('scratch filesystem full'), { code: 'ENOSPC' });
      const original = 'x'.repeat(BUDGET_CHARS * 2);
      const doored = applyResultDoor(
        {
          content: [{ type: 'text' as const, text: original }],
          _meta: { explicitFullRequest: true },
        },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'coord:send',
          workspaceId: 'ws-1',
          runId: RUN_ID,
          scratchWriteFailure: { error: failure },
        },
      );
      const envelope = JSON.parse((doored.content[0] as { type: 'text'; text: string }).text) as {
        error?: { code?: string; message?: string; retryable?: boolean };
        state?: string;
        content?: Array<Record<string, unknown>>;
        incomplete?: { note?: string };
      };

      const note = expectVolatileEnvelope(envelope, original);
      expect(note).toContain('do NOT repeat the send');
      expect(note).toContain('coord:feed');
      expect(note).toContain('coord:inbox');
    });

    it('uses one budget across explicit fan-out and spills the result that crosses it', () => {
      const firstScope = beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-7' });
      const secondScope = beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-7' });
      const thirdScope = beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-7' });
      const opts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID };

      const first = applyResultDoor(medium(), { ...opts, aggregateScope: firstScope });
      const second = applyResultDoor(medium(), { ...opts, aggregateScope: secondScope });
      const third = applyResultDoor(medium(), { ...opts, aggregateScope: thirdScope });

      expect((first._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
      expect((second._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
      const envelope = JSON.parse((third.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');
      // EI-23761431768707969: code:run avoids the aggregate budget only when its bounded
      // summary is enough. Complete long text must stay in the recoverable spill or use slices.
      expect(envelope.incomplete.note).toMatch(/ONE code:run only for compact output/i);
      expect(envelope.incomplete.note).toContain('summaryNotice.truncated');
      expect(envelope.incomplete.note).toMatch(/complete long text, page this spill or fetch bounded slices/i);
      expect(envelope.incomplete.note).not.toContain('fold the calls into ONE code:run');
      const aggregate = (third._meta as { resultDoor?: { aggregate?: Record<string, unknown> } }).resultDoor?.aggregate;
      expect(aggregate).toMatchObject({
        mode: 'explicit',
        budgetBytes: 12_000,
        consumedBeforeBytes: 10_000,
        chargedBytes: 5_000,
        sourceBytes: 5_000,
        acceptedBytes: 2_000,
        consumedAfterBytes: 12_000,
        exceeded: true,
      });
      expect(JSON.stringify(aggregate)).not.toContain('turn-7');
      expect(readSpill('ws-1', 'plans:get', RUN_ID)).toContain('m'.repeat(100));
    });

    it('keeps direct and nested scratch-reference byte pages readable after the aggregate cohort is exhausted', () => {
      const scope = beginResultDoorAggregate({ sessionKey: 'owner-read-recovery', outputGroupId: 'turn-recovery' });
      const normalOpts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope };
      applyResultDoor(medium(), normalOpts);
      applyResultDoor(medium(), normalOpts);
      applyResultDoor(medium(), normalOpts);

      const pageContent = (reference?: Record<string, unknown>): DoorableResult => ({
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            file_path: '/scratch/result-door.spill',
            encoding: 'base64',
            byte_offset: 0,
            byte_length: 1_024,
            total_bytes: 2_048,
            ...(reference ? { reference } : {}),
            eof: false,
            data: Buffer.alloc(1_024).toString('base64'),
            next_cursor: { tool: 'capability:read', args: { byte_offset: 1_024, byte_limit: 1_024 } },
          }),
        }],
      });

      const recoveryPage = applyResultDoor(pageContent({ uri: 'papercusp://scratch/ws-1/plans:get/page' }), {
        toolName: 'capability:read',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        aggregateScope: scope,
      });
      expect(JSON.parse((recoveryPage.content[0] as { text: string }).text)).toMatchObject({
        ok: true,
        encoding: 'base64',
        byte_length: 1_024,
      });
      expect((recoveryPage._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();

      const nestedRecoveryPage = applyResultDoor(pageContent({ uri: 'papercusp://scratch/ws-1/plans:get/page' }), {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'capability:read',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        aggregateScope: scope,
      });
      expect(JSON.parse((nestedRecoveryPage.content[0] as { text: string }).text)).toMatchObject({
        ok: true,
        encoding: 'base64',
        byte_length: 1_024,
      });
      expect((nestedRecoveryPage._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();

      // The real nested tools:invoke response also carries its own
      // guidance.seeAlso text item after the target page. That advisory must
      // not turn an otherwise safe recovery page back into aggregate output.
      const nestedRecoveryPageWithAdvisory = applyResultDoor({
        ...pageContent({ uri: 'papercusp://scratch/ws-1/plans:get/page' }),
        content: [
          ...pageContent({ uri: 'papercusp://scratch/ws-1/plans:get/page' }).content,
          { type: 'text' as const, text: 'See also: tools:find (discover tools)' },
        ],
      }, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'capability:read',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        aggregateScope: scope,
      });
      expect(JSON.parse((nestedRecoveryPageWithAdvisory.content[0] as { text: string }).text)).toMatchObject({
        ok: true,
        encoding: 'base64',
        byte_length: 1_024,
      });
      expect((nestedRecoveryPageWithAdvisory._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();

      const ordinaryPage = applyResultDoor(pageContent(), {
        toolName: 'capability:read',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        aggregateScope: scope,
      });
      const ordinaryEnvelope = JSON.parse((ordinaryPage.content[0] as { text: string }).text);
      expect(ordinaryEnvelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');

      const nestedOrdinaryPage = applyResultDoor(pageContent(), {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'capability:read',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        aggregateScope: scope,
      });
      const nestedOrdinaryEnvelope = JSON.parse((nestedOrdinaryPage.content[0] as { text: string }).text);
      expect(nestedOrdinaryEnvelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');
    });

    it.each([
      ['direct capability:read', 'capability:read', undefined, 'turn-content-index-direct'],
      ['nested capability:read', 'tools:invoke', 'capability:read', 'turn-content-index-nested'],
    ] as const)(
      'keeps %s scratch-reference content-index reads readable after the aggregate cohort is exhausted',
      (_shape, toolName, nestedTargetToolName, outputGroupId) => {
        const scope = beginResultDoorAggregate({ sessionKey: 'owner-content-index-recovery', outputGroupId });
        const normalOpts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID, aggregateScope: scope };
        applyResultDoor(medium(), normalOpts);
        applyResultDoor(medium(), normalOpts);
        applyResultDoor(medium(), normalOpts);

        const selectedContent: DoorableResult = {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              file_path: '/scratch/result-door.spill',
              reference: { uri: 'papercusp://scratch/ws-1/plans:get/result-door.spill' },
              selected_indexes: [0],
              total_content_items: 1,
              content: [{ type: 'text', text: 'selected recovery payload' }],
            }),
          }],
          _meta: { capabilityRead: { source: 'scratch-reference' } },
        };

        const recovered = applyResultDoor(selectedContent, {
          toolName,
          ...(nestedTargetToolName ? { nestedTargetToolName } : {}),
          workspaceId: 'ws-1',
          runId: RUN_ID,
          aggregateScope: scope,
        });

        expect(JSON.parse((recovered.content[0] as { text: string }).text)).toMatchObject({
          selected_indexes: [0],
          content: [{ type: 'text', text: 'selected recovery payload' }],
        });
        expect((recovered._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
      },
    );

    // EI-21954450841272611, and independently EI-21733745031882912 /
    // EI-21573289806322713 against two other tools: all three read
    // `omittedItems: N` on an aggregate spill and concluded N rows had been
    // LOST — one of them reported the underlying field as unavailable when it
    // was sitting intact in the spill. The bytes are relocated, never dropped,
    // so the envelope must not describe them with the unrecoverable word, and
    // must say what to do instead.
    it('describes an aggregate spill as recoverable and never claims omitted items', () => {
      const opts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID };
      const scopeFor = (id: string) => beginResultDoorAggregate({ sessionKey: 'owner-recoverable', outputGroupId: id });
      applyResultDoor(medium(), { ...opts, aggregateScope: scopeFor('turn-r') });
      applyResultDoor(medium(), { ...opts, aggregateScope: scopeFor('turn-r') });
      const overflowed = applyResultDoor(medium(), { ...opts, aggregateScope: scopeFor('turn-r') });

      const envelope = JSON.parse((overflowed.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');
      // The load-bearing assertion: the unrecoverable field must be ABSENT.
      expect(envelope.incomplete).not.toHaveProperty('omittedItems');
      expect(envelope.incomplete.recoverable).toBe(true);
      expect(envelope.incomplete.spilledItems).toBe(1);
      // The note must not promise that another request in this cohort succeeds.
      expect(envelope.incomplete.note).toMatch(/explicit output cohort/i);
      expect(envelope.incomplete.note).toMatch(/new output cohort/i);
      expect(envelope.incomplete.note).toMatch(/same cohort can spill again/i);
      expect(envelope.incomplete.note).toMatch(/nothing was lost/i);
      // ...and it must not be too large on its own, which the caller cannot
      // otherwise tell apart from a genuinely oversized result.
      expect(envelope.incomplete.note).toMatch(/not too large on its own/i);
    });

    it('does not misidentify sequential compatibility requests as parallel siblings', () => {
      const opts = { toolName: 'scorecards:get', workspaceId: 'ws-1', runId: RUN_ID };
      let overflowed: DoorableResult | undefined;
      for (const startedAtMs of [1_000, 1_100, 1_200]) {
        overflowed = applyResultDoor(medium(), {
          ...opts,
          aggregateScope: beginResultDoorAggregate({ sessionKey: 'sequential-cli', startedAtMs }),
        });
      }
      const envelope = JSON.parse((overflowed!.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('aggregate-output-budget-exceeded');
      expect(envelope.incomplete.note).toMatch(/2-second compatibility cohort/i);
      expect(envelope.incomplete.note).toMatch(/does not prove they were parallel siblings/i);
    });

    // The sibling reason reaches the same route but has the OPPOSITE retry
    // advice: re-running alone spills again, so the note must not tell the
    // caller to retry.
    it('gives a non-text spill its own recovery advice rather than the aggregate one', () => {
      const doored = applyResultDoor(
        {
          content: [
            { type: 'image' as const, data: 'x'.repeat(9_000), mimeType: 'image/png' },
            { type: 'text' as const, text: 'caption' },
          ],
        } as unknown as DoorableResult,
        { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.incomplete.reason).toBe('non-text-result-budget-exceeded');
      expect(envelope.incomplete).not.toHaveProperty('omittedItems');
      expect(envelope.incomplete.recoverable).toBe(true);
      expect(envelope.incomplete.note).toMatch(/nothing was lost/i);
      expect(envelope.incomplete.note).toMatch(/cannot be\s+sliced|cannot be sliced/i);
      expect(envelope.incomplete.note).not.toMatch(/sibling/i);
    });

    it('bounds a 35K fan-out cohort and writes every aggregate overflow as a distinct spill', () => {
      const results: DoorableResult[] = Array.from({ length: 7 }, (_, index) =>
        applyResultDoor(
          {
            content: [
              {
                type: 'text' as const,
                text: `${index}:` + String(index).repeat(4_998),
              },
            ],
          } as DoorableResult,
          {
            toolName: 'plans:get',
            workspaceId: 'ws-1',
            runId: RUN_ID,
            aggregateScope: beginResultDoorAggregate({
              sessionKey: 'owner-35k',
              outputGroupId: 'turn-35k',
            }),
          },
        ),
      );

      expect(results.reduce((sum, result) => sum + Number(
        (result._meta as { resultDoor?: { aggregate?: { sourceBytes?: number } } } | undefined)
          ?.resultDoor?.aggregate?.sourceBytes ?? 5_000,
      ), 0)).toBe(35_000);
      const spilled = results.filter((result) =>
        (result._meta as { resultDoor?: { reason?: string } } | undefined)?.resultDoor?.reason ===
        'aggregate-output-budget-exceeded',
      );
      expect(spilled).toHaveLength(5);
      expect(results.slice(0, 2).every((result) => result.content[0]?.type === 'text')).toBe(true);

      const spillDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'plans:get', RUN_ID);
      const spillFiles = readdirSync(spillDir);
      expect(spillFiles).toHaveLength(5);
      const spillPayloads = spillFiles.map((file) => {
        const parsed = scratchReference.parseScratchReference(readFileSync(join(spillDir, file)));
        expect(parsed).not.toBeNull();
        return parsed!.payload.toString('utf8');
      });
      for (const index of [2, 3, 4, 5, 6]) {
        expect(spillPayloads.some((payload) => payload.includes(`${index}:${String(index).repeat(100)}`))).toBe(true);
      }
    });

    it('re-applies the hard door when a projection footer expands an otherwise fitting result', () => {
      const raw = {
        content: [{ type: 'text' as const, text: 'p'.repeat(BUDGET_CHARS - 10) }],
      };
      const direct = applyResultDoor(raw, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666666',
      });
      expect(direct).toBe(raw);

      const parsed = parseProjection({ pipe: [{ op: 'head', n: 1 }] });
      if (!parsed.ok) throw new Error(parsed.error);
      const projected = applyResultProjection(raw, parsed.spec, { toolName: 'plans:get', effect: 'read' });
      expect(measureResultContextBytes(projected)).toBeGreaterThan(BUDGET_CHARS);

      const doored = applyResultDoor(projected, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: '22222222-3333-4444-8555-666666666666',
      });
      expect(
        ((doored as DoorableResult)._meta as { resultDoor?: { truncated?: boolean } }).resultDoor?.truncated,
      ).toBe(true);
      expect(measureResultContextBytes(doored)).toBeLessThan(measureResultContextBytes(projected));
      expect(readSpill('ws-1', 'plans:get', '22222222-3333-4444-8555-666666666666')).toContain('[projection:');
    });

    it('keeps separate explicit turns independent', () => {
      const opts = { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID };
      for (let i = 0; i < 2; i += 1) {
        applyResultDoor(medium(), {
          ...opts,
          aggregateScope: beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-a' }),
        });
      }
      const other = applyResultDoor(medium(), {
        ...opts,
        aggregateScope: beginResultDoorAggregate({ sessionKey: 'owner-1', outputGroupId: 'turn-b' }),
      });
      expect((other._meta as { resultDoor?: unknown } | undefined)?.resultDoor).toBeUndefined();
    });

    it('declares and deterministically groups the <=2s compatibility fallback at request start', () => {
      const a = beginResultDoorAggregate({ sessionKey: 'owner-compat', startedAtMs: 1_000 });
      const b = beginResultDoorAggregate({ sessionKey: 'owner-compat', startedAtMs: 2_999 });
      const c = beginResultDoorAggregate({ sessionKey: 'owner-compat', startedAtMs: 5_001 });
      expect(a).toEqual(b);
      expect(a.mode).toBe('compatibility');
      expect(c.key).not.toBe(a.key);
    });
  });

  // WI-36047 (borrow item 9 from the opencode/OMP research). This block REPLACES
  // a test that asserted the OPPOSITE — "an unwritable scratch root returns the
  // ORIGINAL result untouched". That contract was deliberate and wrong, and the
  // test pinned it, which is why it survived: the door's cap is a side-effect of
  // "park the full copy first", so ONE `try` covered both the spill AND the cap,
  // and a failed WRITE silently inherited the cap's correct answer.
  //
  // The two failures need opposite answers. A failed CAP returning the original is
  // right. A failed SPILL must still stay bounded — returning the original re-exposes
  // the entire payload the door exists to bound, especially for payloadTier:'full'
  // (which bypasses payload-tier's 30k ceiling upstream). A bounded volatile page is
  // allowed when the in-process cache can retain the spill bytes.
  //
  // OMP has the identical bug with the sign flipped: correct on save-FAILED
  // (output-meta.ts:684-692, truncates anyway, under a comment saying a save
  // failure must never re-expose the full output), wrong on store-ABSENT (:656,
  // returns uncapped). Same function, opposite answers — which is what makes this
  // shape worth a named guard rather than a one-line fix.
  describe('spill write fails → truncate and offer volatile recovery, never no-cap (WI-36047)', () => {
    /** A regular FILE where the scratch root dir should be → mkdirSync throws. */
    function breakScratchRoot(): void {
      writeFileSync(join(sandbox, 'scratch'), 'not a directory');
    }

    it('still CAPS the result instead of passing the full payload through', () => {
      breakScratchRoot();
      const original = longText(BUDGET_CHARS * 2);
      const result = { content: [{ type: 'text' as const, text: original }] };
      const doored = applyResultDoor(result, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });

      // The whole point: NOT the identity fast-path any more.
      expect(doored).not.toBe(result);
      const text = doored.content.map((c) => (c as { text?: string }).text ?? '').join('');
      // Capped: the kept body is a fraction of the original, not all of it.
      expect(text).not.toContain(original);
      expect(text.length).toBeLessThan(original.length);
    });

    it('offers a volatile page without advertising a missing filesystem path', () => {
      breakScratchRoot();
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }] },
        { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const bounded = boundedBody(doored);
      const footer = bounded._projection.next;

      expect(footer).toContain('Primary scratch persistence failed');
      expect(footer).toContain('in-process copy is available');
      expect(bounded._projection.cursor).toMatchObject({
        kind: 'volatile-scratch-page',
        tool: 'capability:read',
      });
      // No scratch URI in prose and no filesystem path; the cursor carries only
      // the short-lived, capability:read reference.
      expect(footer).not.toContain('papercusp://scratch');
      expect(footer).not.toContain(sandbox);
    });

    it('keeps useful checkpoint text and its stored identity when a work_items:get spill cannot be written', () => {
      breakScratchRoot();
      const checkpoint =
        'RETAINED-CHECKPOINT-BEGIN\n' +
        'Resume by checking the saved acceptance evidence and continue from the next action. '.repeat(180) +
        '\nRETAINED-CHECKPOINT-END';
      const original = JSON.stringify({
        ok: true,
        results: [{
          ok: true,
          id: 'WI-checkpoint-spill-failure',
          availability: 'available',
          workItem: {
            id: 'WI-checkpoint-spill-failure',
            kind: 'bug',
            state: 'open',
            title: 'continuation checkpoint',
            summary: 'S'.repeat(1_200),
            payload: { diagnostics: 'P'.repeat(2_000) },
          },
          checkpoint,
          checkpointContentHash: 'checkpoint-hash-123456',
          checkpointUpdatedAtMs: 123,
          checkpointBody: { chars: checkpoint.length, cap: 32_000, remaining: 32_000 - checkpoint.length },
        }],
        counts: { ok: 1, failed: 0 },
      });
      expect(original.length).toBeGreaterThan(BUDGET_CHARS);

      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const bounded = boundedBody(doored) as unknown as {
        results: Array<{
          checkpoint?: string;
          checkpointContentHash?: string;
          checkpointUpdatedAtMs?: number;
          checkpointBody?: unknown;
        }>;
        _projection: { cursor: Record<string, unknown> };
      };

      expect(bounded._projection.cursor).toMatchObject({
        kind: 'volatile-scratch-page',
        tool: 'capability:read',
        reason: 'spill-write-failed',
      });
      expect(bounded.results[0].checkpoint).toContain('RETAINED-CHECKPOINT-BEGIN');
      expect(bounded.results[0].checkpoint!.length).toBeGreaterThan(800);
      expect(bounded.results[0].checkpoint).toContain('TRUNCATED');
      expect(bounded.results[0].checkpointContentHash).toBe('checkpoint-hash-123456');
      expect(bounded.results[0].checkpointUpdatedAtMs).toBe(123);
      expect(bounded.results[0].checkpointBody).toEqual({
        chars: checkpoint.length,
        cap: 32_000,
        remaining: 32_000 - checkpoint.length,
      });
      expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(BUDGET_CHARS);
    });

    it('keeps selected comment bodies for nested work_items:get when spill persistence fails', () => {
      breakScratchRoot();
      const selectedBody = 'RETAINED-COMMENT: the reviewer requested the bounded continuation evidence.';
      const original = JSON.stringify({
        ok: true,
        results: [{
          ok: true,
          id: 'WI-thread-spill-failure',
          availability: 'available',
          workItem: {
            id: 'WI-thread-spill-failure',
            kind: 'bug',
            state: 'open',
            title: 'bounded continuation comment',
            summary: 'S'.repeat(1_200),
          },
          threadWindow: {
            shown: 1,
            total: 4,
            posts: [{
              id: 42,
              thread_id: 'thread-42',
              author_id: 'su-reviewer',
              body: selectedBody,
              created_ts: '2026-10-08T05:00:00.000Z',
            }],
          },
          checkpoint: 'C'.repeat(40_000),
          checkpointContentHash: 'checkpoint-hash-123456',
        }],
        counts: { ok: 1, failed: 0 },
      });
      expect(original.length).toBeGreaterThan(BUDGET_CHARS);

      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }] },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'work_items:get',
          workspaceId: 'ws-1',
          runId: RUN_ID,
        },
      );
      const bounded = boundedBody(doored) as unknown as {
        results: Array<{
          threadWindow?: { total?: number; shown?: number; posts?: Array<{ body?: string }> };
          checkpointContentHash?: string;
        }>;
        _projection: { cursor: Record<string, unknown> };
      };

      expect(bounded._projection.cursor).toMatchObject({
        kind: 'volatile-scratch-page',
        tool: 'capability:read',
        reason: 'spill-write-failed',
      });
      expect(bounded.results[0].threadWindow).toMatchObject({
        total: 4,
        shown: 1,
        posts: [{ body: selectedBody }],
      });
      expect(bounded.results[0].checkpointContentHash).toBe('checkpoint-hash-123456');
      expect(JSON.stringify(bounded).length).toBeLessThanOrEqual(BUDGET_CHARS);
    });

    it('stamps the failure structurally so a machine reader is not left parsing prose', () => {
      breakScratchRoot();
      // Typed as DoorableResult, not left to inference: `applyResultDoor` returns
      // the INPUT type `T`, so a bare object literal narrows T to `{ content: … }`
      // and `doored._meta` — the very field the door stamps — is not on the type.
      const input: DoorableResult = {
        content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      };
      const doored = applyResultDoor(input, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const meta = (doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor;

      expect(meta?.truncated).toBe(true);
      expect(meta?.spillFailed).toBe(true);
      // null, not a string: _mcp-handler's outputRef backfill guards on spillUri
      // truthiness, so this is what stops it advertising a nonexistent artifact.
      expect(meta?.spillPath).toBeNull();
      expect(meta?.spillUri).toBeNull();
      expect(typeof meta?.spillError).toBe('string');
    });

    it('CONTROL: with a writable scratch root the same input DOES spill and DOES name a path', () => {
      // Calibration for the three tests above — without this, they would all pass
      // against a door that had simply stopped spilling entirely, which is a
      // different bug wearing this fix's clothes.
      const input: DoorableResult = {
        content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 2) }],
      };
      const doored = applyResultDoor(input, {
        toolName: 'plans:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const footer = boundedBody(doored)._projection.next;
      const meta = (doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor;

      expect(JSON.stringify(boundedBody(doored)._projection.cursor)).toContain('papercusp://scratch');
      expect(footer).not.toContain('THE OVERFLOW WAS DISCARDED');
      expect(meta?.spillFailed).toBe(false);
      expect(typeof meta?.spillPath).toBe('string');
    });
  });

  // EI-13918: `result.data` may have ALREADY been replaced upstream by a lossy
  // payload-tier projection (payload-tier.ts) before this door ever ran — in
  // which case the "FULL result is at <path>" footer is FALSE: the spilled
  // file holds only that already-partial projection, and the genuinely
  // omitted content was never serialized, so paging can never recover it.
  // `_meta.payloadProjection` (serialize-result.ts) is how the door learns
  // this without parsing the body.
  describe('upstream payload-tier truncation (_meta.payloadProjection)', () => {
    const payloadProjection = {
      truncated: true as const,
      tier: 'trimmed',
      forced: true,
      originalChars: 37343,
      returnedChars: 7058,
      omittedCount: 39,
    };

    it('does NOT claim the spill is the "FULL" result — footer + spill header say it is already-projected and unrecoverable-by-paging', () => {
      const doored = applyResultDoor(
        {
          content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }],
          _meta: { payloadProjection },
        },
        { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = (doored.content.at(-1) as { text: string }).text;
      expect(pointer).not.toContain('The FULL result is at');
      expect(pointer).toContain('NOT the tool');
      expect(pointer).toContain('omittedCount=39');
      expect(pointer).toContain("payloadTier:'full'");

      const spill = readSpill('ws-1', 'coord:orient', RUN_ID);
      expect(spill).not.toContain('FULL tool result');
      expect(spill).toContain('ALREADY-PROJECTED');
      expect(spill).toContain('originalChars=37343');
      expect(spill).toContain('returnedChars=7058');
      expect(spill).toContain('NOT recoverable from this file');
    });

    it('an upstream-projected JSON spill keeps its locator and marks the body incomplete', () => {
      const text = JSON.stringify({
        rows: Array.from({ length: 300 }, (_, index) => ({ id: `row-${index}`, evidence: 'e'.repeat(80) })),
      });
      expect(text.length).toBeGreaterThan(BUDGET_CHARS);

      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }], _meta: { payloadProjection } },
        { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const body = boundedBody(doored) as {
        _projection: {
          cursor: { bodyOffsetInPayload?: number; bodyComplete?: boolean };
          next: string;
        };
      };

      expect(body._projection.cursor.bodyOffsetInPayload).toEqual(expect.any(Number));
      expect(body._projection.cursor.bodyComplete).toBe(false);
      expect(body._projection.next).toContain('upstream payloadProjection');
      expect(body._projection.next).toContain('this JSON is partial (bodyComplete:false)');
      expect(body._projection.next).toContain('paging cannot recover omitted fields');
      expect(body._projection.next).toContain("Re-call coord:orient with payloadTier:'full'");
    });

    it('keeps complete explicit projections inline with the upstream partial warning', () => {
      const text = JSON.stringify({
        selected: { value: 'complete-selected-value' },
        unrelated: { _partial: true, _omitted: 1, value: 'partial-unselected-value' },
      });
      const parsed = parseProjection({ pick: ['selected.value'] });
      if (!parsed.ok) throw new Error(parsed.error);

      const projected = applyResultProjection(
        { content: [{ type: 'text' as const, text }], _meta: { payloadProjection } },
        parsed.spec,
        { toolName: 'reports:get', effect: 'read' },
      );
      const doored = applyResultDoor(projected, {
        toolName: 'reports:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const emittedText = doored.content
        .map((item) => item.type === 'text' ? item.text : '')
        .join('\n');

      expect(emittedText).toContain('complete-selected-value');
      expect(emittedText).not.toContain('partial-unselected-value');
      expect(emittedText).toContain('ALREADY TRUNCATED');
      expect(emittedText).toContain('⚠');
    });

    it('keeps a nested projection inline when its upstream partial warning survived only in metadata', () => {
      const pick = [
        'snapshot.contentHash',
        'snapshot.updatedAtMs',
        'snapshot.noteRowsOmitted',
        'snapshot.length',
      ];
      const note = 'the corpus this projection filtered was ALREADY TRUNCATED before this stage ran ' +
        '(payload tier=trimmed, 39 field(s)/row(s) omitted upstream) — matches shown come from the ' +
        'RETAINED portion only. For an exhaustive answer, re-call loop:checkpoint with payloadTier:\'full\'.';
      const body = {
        snapshot: { contentHash: 'abc123', updatedAtMs: 1793225079195, noteRowsOmitted: 2, length: 4 },
      };
      const result = {
        content: [{ type: 'text' as const, text: JSON.stringify(body) }],
        _meta: {
          payloadProjection,
          resultProjection: { applied: true, spec: { pick }, notes: [note] },
        },
      };

      const doored = applyResultDoor(result, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'loop:checkpoint',
        effect: 'read',
        workspaceId: 'ws-1',
        runId: RUN_ID,
        preservePaths: pick,
        // This regression is specifically about avoiding a synchronous spill
        // for small, already-selected metadata when its omitted source fields
        // are explicitly disclosed.
        scratchWriteFailure: { error: Object.assign(new Error('scratch must not be touched'), { code: 'EIO' }) },
      });
      const textItems = doored.content.filter(
        (item) => item.type === 'text',
      ) as Array<{ type: 'text'; text: string }>;

      expect(textItems).toHaveLength(2);
      expect(textItems[0].text).toContain('ALREADY TRUNCATED');
      expect(JSON.parse(textItems[1].text)).toMatchObject(body);
      expect(JSON.stringify(doored)).not.toContain('papercusp.output-envelope/v1');
      expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);
    });

    it('limits spill evidence references to caller-selected paths', () => {
      const content = [{
        type: 'text' as const,
        text: JSON.stringify({
          summary: 'run complete',
          similarRecipes: [{ authorityRefs: { fleets: ['fleet-1'] } }],
        }),
      }];

      expect(detectResultEvidence(content, ['summary'])).toEqual([]);
      expect(detectResultEvidence(content, ['similarRecipes[].authorityRefs.fleets'])).toMatchObject([
        { evidenceClass: 'fleet', jsonPointers: ['/similarRecipes/0/authorityRefs/fleets'] },
      ]);
    });

    it(
      'a result WITHOUT any marker gets the HONEST default wording — never an unconditional ' +
        '"FULL result" claim (EI-18762253154342502: no marker firing proves nothing was cut ' +
        'upstream, only that no known marker fired — a tool can silently truncate a field with ' +
        'a bare ellipsis and no `_truncated` flag, as plans:items did before its own fix)',
      () => {
        const doored = applyResultDoor(
          { content: [{ type: 'text' as const, text: longText(BUDGET_CHARS * 3) }] },
          { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
        );
        const pointer = boundedBody(doored)._projection.next;
        expect(pointer).not.toContain('The FULL result is at');
        expect(pointer).toMatch(/JSON starts after cursor\.bodyOffsetInPayload|the spill opens with a text header/);
        expect(pointer).toContain('No upstream truncation marker was detected');
        const spill = readSpill('ws-1', 'plans:get', RUN_ID);
        expect(spill).not.toContain('# result-door spill — FULL tool result');
        expect(spill).toContain('# result-door spill — the text as it reached this door');
      },
    );

    // EI-19361771982678588: a partial source now takes the typed incomplete
    // route even when its emitted body fits the per-result byte budget.
    it('an under-budget upstream projection returns an incomplete envelope and keeps the emitted body inspectable', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small already-projected result' }],
        _meta: { payloadProjection },
      };
      const doored = applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(doored.content).toHaveLength(1);
      expect(envelope).toMatchObject({
        schemaVersion: 'papercusp.output-envelope/v1',
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
        content: [{ kind: 'reference', uri: expect.stringContaining('papercusp://scratch/ws-1/coord:orient/') }],
      });
      expect(envelope.incomplete.note).toContain('lossy upstream projection');
      expect(envelope.incomplete.note).toContain("payloadTier:'full'");
      expect(readSpill('ws-1', 'coord:orient', RUN_ID)).toContain('small already-projected result');
    });

    it.each([false, true])('P008 G1 retains a small measured status when only auxiliary text is partial (nested=%s)', (nested) => {
      const body = {
        ok: true,
        snapshot: { runId: 'run-partial-log', status: 'fail', exitCode: 1,
          passed: 7, failed: 1, output: 'already clipped ' + 'x'.repeat(3_000), textTruncated: true },
      };
      const result = { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
      const doored = applyResultDoor(result, {
        toolName: nested ? 'tools:invoke' : 'testing:run-status',
        ...(nested ? { nestedTargetToolName: 'testing:run-status' } : {}),
        effect: 'read', workspaceId: 'ws-1', runId: RUN_ID,
      });
      const inline = JSON.parse((doored.content[0] as { text: string }).text);
      expect(inline.snapshot).toMatchObject({ runId: 'run-partial-log', status: 'fail', exitCode: 1, passed: 7, failed: 1 });
      expect(inline._partial).toBe(true);
      expect(inline._projection.cursor).toMatchObject({ tool: 'capability:read', bodyComplete: false });
      expect(inline._projection.next).toContain('testing:run-status');
      expect(inline._projection.next).toContain('cannot recover');
      expect(Buffer.byteLength(JSON.stringify(inline))).toBeLessThanOrEqual(BUDGET_CHARS);
      expect(readSpill('ws-1', nested ? 'tools:invoke' : 'testing:run-status', RUN_ID)).toContain('already clipped');
    });

    it('P008 G1 retains a count and record identities without requiring a status field', () => {
      const body = { count: 2, results: [{ id: 'case-a', title: 'clipped', textTruncated: true }, { id: 'case-b' }] };
      const doored = applyResultDoor({ content: [{ type: 'text' as const, text: JSON.stringify(body) }] }, {
        toolName: 'testing:runs', effect: 'read', workspaceId: 'ws-1', runId: RUN_ID,
      });
      const inline = JSON.parse((doored.content[0] as { text: string }).text);
      expect(inline).toMatchObject({ count: 2, results: [{ id: 'case-a' }, { id: 'case-b' }], _partial: true });
      expect(inline._projection.cursor).toMatchObject({ tool: 'capability:read', bodyComplete: false });
    });

    it('uses the nested target in recovery advice for an under-budget tools:invoke result', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small nested partial result' }],
        _meta: { payloadProjection },
      };
      const doored = applyResultDoor(result, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'work_items:get',
        effect: 'read',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope.incomplete).toMatchObject({
        reason: 'under-budget-partial-result',
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain("Re-call work_items:get with payloadTier:'full'");
      expect(envelope.incomplete.note).toContain(
        "tools:invoke { name:'work_items:get', args:{ …original args, payloadTier:'full' } }",
      );
      expect(envelope.incomplete.note).not.toContain("name:'tools:invoke'");
    });

    it.each([
      ['scorecards:emit', 'Do NOT repeat this non-idempotent emit', 'scorecard ledger'],
      ['mail:send', 'Do NOT repeat the write', 'authoritative state'],
    ])('does not recommend replaying nested write %s to recover an upstream projection', (target, warning, recovery) => {
      const result = {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, created: true, issueId: 'EI-emit-1' }) }],
        _meta: { payloadProjection },
      };
      const doored = applyResultDoor(result, {
        toolName: 'tools:invoke',
        nestedTargetToolName: target,
        effect: 'write',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope.incomplete).toMatchObject({
        reason: 'under-budget-partial-result',
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain(warning);
      expect(envelope.incomplete.note).toContain(recovery);
      expect(envelope.incomplete.note).not.toMatch(/Re-call (scorecards:emit|mail:send) with payloadTier:'full'/);
    });

    it('preserves work-item field recovery when upstream projection metadata is also present', () => {
      const result = {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            results: [{
              id: 'EI-1',
              priorAttempts: {
                attempts: [{ rawRef: 'EI-1#completion', textTruncated: true, text: 'prefix…' }],
              },
            }],
          }),
        }],
        _meta: { payloadProjection },
      };
      const doored = applyResultDoor(result, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'work_items:get',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope.incomplete).toMatchObject({
        reason: 'under-budget-partial-result',
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain('checkpointOnly:true');
      expect(envelope.incomplete.note).toContain('rawRef');
      expect(envelope.incomplete.note).toContain('checkpointPage.nextOffset');
      expect(envelope.incomplete.note).toContain('For other fields omitted by the upstream payload projection');
      expect(envelope.incomplete.note).toContain("Re-call work_items:get with payloadTier:'full'");
      const resultDoorMeta = (doored as unknown as {
        _meta?: { resultDoor?: { innerTruncationMarkers?: string[] } };
      })._meta?.resultDoor;
      expect(resultDoorMeta?.innerTruncationMarkers).toContain('textTruncated');
    });

    it('shows a schema-compatible dispatch path for framework-reserved payloadTier', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small partial list result' }],
        _meta: { payloadProjection },
      };
      const doored = applyResultDoor(result, { toolName: 'work_items:list', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope.incomplete.note).toContain("Re-call work_items:list with payloadTier:'full'");
      expect(envelope.incomplete.note).toContain(
        "tools:invoke { name:'work_items:list', args:{ …original args, payloadTier:'full' } }",
      );
    });

    it('an UNtruncated small result keeps the identity fast-path (no note, no copy)', () => {
      const result = { content: [{ type: 'text' as const, text: 'small result' }] };
      expect(applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it('a small result whose marker says truncated:false also keeps the fast-path', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small result' }],
        _meta: { payloadProjection: { ...payloadProjection, truncated: false as unknown as true } },
      };
      expect(applyResultDoor(result, { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it.each([
      [
        'array row',
        JSON.stringify({ rows: [{ id: 'row-1', _partial: true, title: 'visible row' }] }),
        '_partial',
      ],
      [
        'keyed map',
        JSON.stringify({ ratings: { criterionA: { rating: 'pass' }, _partial: true } }),
        '_partial',
      ],
      [
        'clipped string',
        JSON.stringify({ evidence: 'evidence prefix…[TRUNCATED +17 chars — re-read with payloadTier:full]' }),
        'textTruncated',
      ],
    ] as const)('returns an incomplete envelope for an under-budget %s marker', (_shape, text, marker) => {
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(BUDGET_CHARS);
      const input: DoorableResult = { content: [{ type: 'text' as const, text }] };
      const doored = applyResultDoor(
        input,
        { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope).toMatchObject({
        schemaVersion: 'papercusp.output-envelope/v1',
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
        content: [{ kind: 'reference', uri: expect.stringContaining('papercusp://scratch/ws-1/plans:get/') }],
      });
      expect(envelope.incomplete.note).toContain('paging this reference cannot recover');
      expect((doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor).toMatchObject({
        innerTruncationMarkers: [marker],
      });
      const spill = JSON.parse(readSpill('ws-1', 'plans:get', RUN_ID)) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(spill.content[0].text).toBe(text);
    });

    it.each([
      ['direct work_items:get', 'work_items:get', undefined],
      ['nested work_items:get', 'tools:invoke', 'work_items:get'],
    ] as const)(
      'gives %s a field-specific recovery route for clipped comment bodies',
      (_shape, toolName, nestedTargetToolName) => {
        const text = JSON.stringify({
          results: [{
            id: 'WI-1',
            threadWindow: { posts: [{ body: 'comment prefix…', bodyChars: 1_874, bodyTruncated: true }] },
          }],
        });
        const doored = applyResultDoor(
          { content: [{ type: 'text' as const, text }], _meta: {} },
          {
            toolName,
            ...(nestedTargetToolName ? { nestedTargetToolName } : {}),
            workspaceId: 'ws-1',
            runId: RUN_ID,
          },
        );
        const envelope = JSON.parse((doored.content[0] as { text: string }).text);

        expect(envelope.incomplete).toMatchObject({
          reason: 'under-budget-partial-result',
          recoverable: false,
        });
        expect(envelope.incomplete.note).toContain('bodyTruncated/bodyChars');
        expect(envelope.incomplete.note).toContain("payloadTier:'full'");
        expect(envelope.incomplete.note).toContain('results[].threadWindow.posts[].body');
        expect(envelope.incomplete.note).toContain('a spill cannot restore body bytes omitted by the upstream shaper');
        expect((doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor).toMatchObject({
          innerTruncationMarkers: ['bodyTruncated'],
        });
      },
    );

    it('gives capability:read a schema-compatible recovery path for truncated evidence', () => {
      const text = JSON.stringify({
        evidence: 'evidence prefix…[TRUNCATED +17 chars — re-read with payloadTier:full]',
      });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'capability:read', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope.incomplete.note).toContain('`byte_offset` + `byte_limit`');
      expect(envelope.incomplete.note).toContain('(without `evidence_class`)');
      expect(envelope.incomplete.note).toContain('per-field limit');
      expect(envelope.incomplete.note).not.toContain('wider per-field limit');
    });

    it.each([
      ['direct capability:read', 'capability:read', undefined],
      ['nested capability:read', 'tools:invoke', 'capability:read'],
    ] as const)('%s does not recursively wrap markers stored in a scratch reference', (_shape, toolName, nestedTargetToolName) => {
      const result: DoorableResult = {
        content: [{
          type: 'text',
          text: '/tmp/result-door-1.md (1 lines)\n     1\t{"outputTailTruncated":true,"textTruncated":true}',
        }],
        _meta: { capabilityRead: { source: 'scratch-reference' } },
      };

      expect(applyResultDoor(result, {
        toolName,
        ...(nestedTargetToolName ? { nestedTargetToolName } : {}),
        workspaceId: 'ws-1',
        runId: RUN_ID,
      })).toBe(result);
    });

    it('still reports a transport projection on a scratch-reference read', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'visible bytes from a scratch reference' }],
        _meta: {
          capabilityRead: { source: 'scratch-reference' },
          payloadProjection,
        },
      };
      const doored = applyResultDoor(result, { toolName: 'capability:read', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope).toMatchObject({
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      });
    });

    it('does not treat an escaped partial-marker example inside a JSON string as a real marker', () => {
      const result = {
        content: [{ type: 'text' as const, text: JSON.stringify({ note: 'Example syntax: "_partial": true' }) }],
      };
      expect(applyResultDoor(result, { toolName: 'plans:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });
  });

  // EI-22167228731928620: an EXPLICIT payloadTier:'full' request (or an
  // equivalent transport-cap exemption) that still overflows the transport
  // door must not be handed a WORSE result than a plain 'trimmed' call would
  // have produced. `_meta.explicitFullRequest` (serialize-result.ts, set by
  // payload-tier.ts's explicitFullRequest exempt path) tells the door this
  // body is the tool's true raw, unshaped output — the door spills it whole
  // and points at it instead of re-projecting it with the generic,
  // field-blind bounded-payload walk.
  describe('explicit full-request overflow (_meta.explicitFullRequest)', () => {
    const RUN_ID_2 = '66666666-7777-4888-9999-aaaaaaaaaaaa';

    it('spills the RAW body whole and returns a clean reference envelope instead of a generic re-projection', () => {
      // A flat repeated-char body, not `longText()` — the reference envelope's
      // spill JSON-stringifies the whole `content` array as ONE nested string,
      // so a body containing newlines would appear ESCAPED (`\\n`) in the spill
      // file and never substring-match the raw multi-line original.
      const original = 'X'.repeat(BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: original }], _meta: { explicitFullRequest: true } },
        { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.state).toBe('incomplete');
      expect(envelope.incomplete).toMatchObject({ reason: 'explicit-full-request-overflow', recoverable: true });
      expect(envelope.incomplete.note).toContain("payloadTier:'full'");
      expect(envelope.content[0]).toMatchObject({
        kind: 'reference',
        uri: expect.stringContaining('papercusp://scratch/ws-1/work_items:get/'),
        byteCount: expect.any(Number),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const spillDir = join(process.env.PAPERCUSP_SCRATCH_ROOT!, 'ws-1', 'work_items:get', RUN_ID);
      const spillFiles = readdirSync(spillDir);
      expect(spillFiles).toHaveLength(1);
      const reference = scratchReference.parseScratchReference(readFileSync(join(spillDir, spillFiles[0])));
      expect(reference).not.toBeNull();
      expect(reference!.manifest).toMatchObject({ mediaType: 'application/json', bodyOffsetInPayload: 0 });
      const rawEnvelope = JSON.parse(
        reference!.payload.subarray(reference!.manifest.bodyOffsetInPayload!).toString('utf8'),
      ) as { content: Array<{ type: string; text?: string }> };
      expect(rawEnvelope.content[0]?.text).toBe(original);
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        truncated: true,
        structural: true,
        reason: 'explicit-full-request-overflow',
      });
    });

    it('marks a hard spill non-recoverable when the tool already truncated a field', () => {
      const text = JSON.stringify({
        results: [{
          id: 'WI-1',
          checkpoint: 'checkpoint prefix…[TRUNCATED +1200 chars — re-read with payloadTier:\'full\']',
          textTruncated: true,
          padding: 'P'.repeat(BUDGET_CHARS * 3),
        }],
      });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }], _meta: { explicitFullRequest: true } },
        { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope.incomplete).toMatchObject({
        reason: 'explicit-full-request-overflow',
        spilledItems: 1,
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain('upstream partial marker(s)');
      expect(envelope.incomplete.note).toContain('textTruncated');
      expect((doored._meta as { resultDoor?: Record<string, unknown> }).resultDoor).toMatchObject({
        upstreamProjected: false,
        innerTruncationMarkers: ['textTruncated'],
      });
      expect(readSpill('ws-1', 'work_items:get', RUN_ID)).toContain('checkpoint prefix');
    });

    it('routes work_items:get prior-attempt truncation to exact source pages', () => {
      const text = JSON.stringify({
        results: [{
          id: 'WI-1',
          priorAttempts: {
            attempts: [{
              rawRef: 'WI-1#completion',
              textTruncated: true,
              text: 'completion prefix…[TRUNCATED +1200 chars]',
            }],
          },
          padding: 'P'.repeat(BUDGET_CHARS * 3),
        }],
      });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }], _meta: { explicitFullRequest: true } },
        { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.incomplete).toMatchObject({
        reason: 'explicit-full-request-overflow',
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain('checkpointOnly:true');
      expect(envelope.incomplete.note).toContain('sourceRef:<rawRef>');
      expect(envelope.incomplete.note).toContain('checkpointPage.nextOffset');
      expect(envelope.incomplete.note).toContain('rawRef');
      expect(envelope.incomplete.note).not.toContain('wider per-field limit');
    });

    it('routes clipped work-item checkpoints to checkpointOnly pages', () => {
      const text = JSON.stringify({
        results: [{
          id: 'WI-checkpoint',
          checkpoint: 'checkpoint prefix…[TRUNCATED +1200 chars — re-read with payloadTier:\'full\']',
          checkpointTruncated: true,
          padding: 'P'.repeat(BUDGET_CHARS * 3),
        }],
      });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }], _meta: { explicitFullRequest: true } },
        { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.incomplete).toMatchObject({
        reason: 'explicit-full-request-overflow',
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain('checkpointOnly:true');
      expect(envelope.incomplete.note).toContain('checkpointPage.nextOffset');
      expect(envelope.incomplete.note).not.toContain('priorAttemptRefs');
      expect(envelope.incomplete.note).not.toContain('retry now with payloadTier');
    });

    it('routes a nested tools:invoke work_items:get textTruncated marker to exact source pages', () => {
      const text = JSON.stringify({
        results: [{
          id: 'EI-1',
          priorAttempts: {
            attempts: [{ rawRef: 'EI-1#completion', textTruncated: true, text: 'prefix…' }],
          },
          padding: 'P'.repeat(BUDGET_CHARS * 3),
        }],
      });
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }], _meta: { explicitFullRequest: true } },
        {
          toolName: 'tools:invoke',
          nestedTargetToolName: 'work_items:get',
          workspaceId: 'ws-1',
          runId: '88888888-7777-4888-9999-bbbbbbbbbbbb',
        },
      );
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope.incomplete).toMatchObject({
        reason: 'explicit-full-request-overflow',
        recoverable: false,
      });
      expect(envelope.incomplete.note).toContain('checkpointOnly:true');
      expect(envelope.incomplete.note).toContain('sourceRef:<rawRef>');
      expect(envelope.incomplete.note).toContain('checkpointPage.nextOffset');
      expect(envelope.incomplete.note).not.toContain('Re-call tools:invoke with a wider per-field limit');
    });

    it('a small explicit-full body that FITS the door passes through untouched (no spill, no note)', () => {
      const result = {
        content: [{ type: 'text' as const, text: 'small full result' }],
        _meta: { explicitFullRequest: true },
      };
      expect(applyResultDoor(result, { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID })).toBe(
        result,
      );
    });

    it(
      'regression: an over-budget explicit-full body is never WORSE than the generic reprojection of the ' +
        "SAME body without the marker — the concrete repro was a `summary` field the tool's own shaper " +
        'would prioritize getting crowded out by sibling raw fields once that shaper is skipped for `full`',
      () => {
        const body = { summary: 'S'.repeat(4_000), extra: 'E'.repeat(BUDGET_CHARS * 2) };
        const text = JSON.stringify(body);
        expect(text.length).toBeGreaterThan(BUDGET_CHARS);

        // Un-marked: takes the generic bounded-payload walk (pre-existing behavior).
        const generic = applyResultDoor(
          { content: [{ type: 'text' as const, text }] },
          { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID_2 },
        );
        const genericProjected = JSON.parse((generic.content[0] as { text: string }).text) as { summary?: string };
        const genericSummaryChars = genericProjected.summary?.length ?? 0;
        // The field-blind walk is not guaranteed to keep the whole 4,000-char
        // field — asserting it here pins down the actual defect this fix
        // addresses (it does NOT keep it in full for this shape).
        expect(genericSummaryChars).toBeLessThan(4_000);

        // Marked: routes to the hard-overflow spill instead of that walk.
        const marked = applyResultDoor(
          { content: [{ type: 'text' as const, text }], _meta: { explicitFullRequest: true } },
          { toolName: 'work_items:get', workspaceId: 'ws-1', runId: RUN_ID },
        );
        const envelope = JSON.parse((marked.content[0] as { text: string }).text);
        expect(envelope.incomplete.reason).toBe('explicit-full-request-overflow');
        // The FULL summary — and everything else — is recoverable in full from
        // the spill: strictly more than whatever fraction the generic walk
        // kept inline, never worse.
        expect(readSpill('ws-1', 'work_items:get', RUN_ID)).toContain('S'.repeat(4_000));
      },
    );
  });

  // EI-18745696571494110: a tool with no `_meta.payloadProjection` can still have
  // truncated an individual FIELD inside its own body (coord:inbox's per-entry
  // `body_truncated`) — the door has no structured signal for this (each tool
  // bakes its own field-level cutoff into the serialized body), so it must detect
  // the generic `"<name>_truncated": true` shape textually and stop telling the
  // reader to page a spill that can never contain what the tool never serialized.
  describe('tool-internal field truncation (no _meta marker — detected in the body text)', () => {
    /** Prepends a small JSON snippet carrying the marker, then pads with `longText`
     *  past the door budget so the door actually spills (detection only matters
     *  on the over-budget path). */
    function withMarker(markerJson: string, totalChars: number): string {
      return markerJson + longText(Math.max(0, totalChars - markerJson.length));
    }

    it('a body_truncated:true marker gives recovery guidance instead of suggesting paging the spill', () => {
      const text = withMarker('{"entries":[{"id":"m1","body_truncated":true}]}\n', BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      expect(pointer).not.toContain('page it with a bounded read');
      expect(pointer).toContain('TOOL ITSELF already truncated');
      expect(pointer).toContain('body_truncated');
      expect(pointer).toContain('coord:inbox result already marked a field as truncated');
      expect(pointer).toContain("Re-read using that field's documented recovery handle or narrower arguments");

      const spill = readSpill('ws-1', 'coord:inbox', RUN_ID);
      expect(spill).toContain('TOOL ITSELF already truncated');
      expect(spill).toContain('body_truncated');
      expect(spill).not.toContain('# result-door spill — FULL tool result\n');
    });

    it('several distinct *_truncated markers are all named, deduplicated', () => {
      const text = withMarker(
        '{"a":{"summary_truncated":true},"b":{"body_truncated":true},"c":{"body_truncated":true}}\n',
        BUDGET_CHARS * 3,
      );
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'plans:items', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      expect(pointer).toContain('summary_truncated');
      expect(pointer).toContain('body_truncated');
      // deduped: body_truncated appears twice in the source but once in the marker list
      expect(pointer.match(/body_truncated/g)).toHaveLength(1);
    });

    it('camelCase *Truncated markers from build:typecheck TOON output are detected with recovery guidance', () => {
      const text = withMarker(
        'errorsTruncated: true\nbyFileTruncated: true\n',
        BUDGET_CHARS * 3,
      );
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'build:typecheck', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      expect(pointer).toContain('TOOL ITSELF already truncated');
      expect(pointer).toContain('errorsTruncated');
      expect(pointer).toContain('byFileTruncated');
      expect(pointer).toContain('build:typecheck result already marked a field as truncated');
      expect(pointer).toContain("Re-read using that field's documented recovery handle or narrower arguments");
    });

    it('detects code:run middle-elision markers with lower-case text and a space after the ellipsis', () => {
      const text = withMarker(
        'result head … [truncated 1227 chars] … result tail\n',
        BUDGET_CHARS * 3,
      );
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'code:run', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      const spill = readSpill('ws-1', 'code:run', RUN_ID);

      expect(pointer).toContain('TOOL ITSELF already truncated');
      expect(pointer).toContain('textTruncated');
      expect(pointer).not.toContain('No upstream truncation marker was detected');
      expect(spill).toContain('TOOL ITSELF already truncated');
      expect(spill).toContain('truncated 1227 chars');
    });

    it('code:run summaryNotice.truncated points to the raw summary spill and marks the outer spill partial', () => {
      const text = JSON.stringify({
        summary: 'S'.repeat(3_500),
        summaryNotice: {
          truncated: true,
          originalChars: 9_296,
          returnedChars: 3_500,
          rawSummaryCursor: {
            status: 'available',
            tool: 'capability:read',
            args: { uri: 'papercusp://scratch/ws-1/code:run/123e4567-e89b-42d3-a456-426614174000/raw-summary.json', byte_offset: 0, byte_limit: 3072 },
            bodyOffsetInPayload: 0,
          },
        },
        padding: 'P'.repeat(BUDGET_CHARS * 3),
      });
      const input: DoorableResult = { content: [{ type: 'text' as const, text }] };
      const doored = applyResultDoor(
        input,
        { toolName: 'code:run', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      const spill = readSpill('ws-1', 'code:run', RUN_ID);

      expect(pointer).toContain('source is already partial');
      expect(pointer).toContain('summaryNotice.truncated');
      expect(pointer).toContain('summaryNotice.rawSummaryCursor');
      expect(pointer).toContain('capability:read');
      expect(pointer).toContain('smaller return');
      expect(pointer).toContain('bounded slices');
      expect(boundedBody(doored).summaryNotice?.rawSummaryCursor).toMatchObject({
        status: 'available',
        args: { uri: 'papercusp://scratch/ws-1/code:run/123e4567-e89b-42d3-a456-426614174000/raw-summary.json' },
      });
      expect(spill).toContain('summaryNotice.truncated');
      expect(spill).toContain('summaryNotice.rawSummaryCursor');
      expect((doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor).toMatchObject({
        innerTruncationMarkers: ['summaryNotice.truncated'],
      });
    });

    it('summaryNotice.truncated:false is not treated as a partial-result marker', () => {
      const text = JSON.stringify({
        summary: 'S'.repeat(3_500),
        summaryNotice: { truncated: false, originalChars: 3_500, returnedChars: 3_500 },
        padding: 'P'.repeat(BUDGET_CHARS * 3),
      });
      const input: DoorableResult = { content: [{ type: 'text' as const, text }] };
      const doored = applyResultDoor(
        input,
        { toolName: 'code:run', workspaceId: 'ws-1', runId: RUN_ID },
      );

      expect(boundedBody(doored)._projection.next).not.toContain('source is already partial');
      expect((doored._meta as { resultDoor?: Record<string, unknown> } | undefined)?.resultDoor).toMatchObject({
        innerTruncationMarkers: [],
      });
    });

    it('a *_truncated:false field is NOT mistaken for a truncation marker', () => {
      const text = withMarker('{"entries":[{"id":"m1","body_truncated":false}]}\n', BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text }] },
        { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = boundedBody(doored)._projection.next;
      // The recovery footer is "JSON starts after cursor.bodyOffsetInPayload…" when the body parses
      // as JSON, else "the spill opens with a text header." (the literal `recover spill;` lead-in was
      // dropped by the Codex no-base64 pointer rewrite) — either way a recovery footer must be present.
      expect(pointer).toMatch(/JSON starts after cursor\.bodyOffsetInPayload|the spill opens with a text header/);
      expect(pointer).not.toContain('TOOL ITSELF already truncated');
    });

    it('upstream payloadProjection takes priority over a body-level marker when both are present', () => {
      const text = withMarker('{"entries":[{"id":"m1","body_truncated":true}]}\n', BUDGET_CHARS * 3);
      const doored = applyResultDoor(
        {
          content: [{ type: 'text' as const, text }],
          _meta: {
            payloadProjection: {
              truncated: true as const,
              tier: 'trimmed',
              forced: true,
              originalChars: 50_000,
              returnedChars: 8_000,
              omittedCount: 12,
            },
          },
        },
        { toolName: 'coord:orient', workspaceId: 'ws-1', runId: RUN_ID },
      );
      const pointer = (doored.content.at(-1) as { text: string }).text;
      expect(pointer).toContain('ALREADY tier-projected upstream');
      expect(pointer).not.toContain('TOOL ITSELF already truncated');
    });

    it.each([
      'entries_truncated',
      'thread_metadata_truncated',
      'thread_entry_truncated',
      'summary_truncated',
      'body_truncated',
      'sections_truncated',
      'to_truncated',
    ])('passes through documented coord:thread continuation marker %s', (marker) => {
      const result = {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ entries: [{ msg_id: 'm1' }], [marker]: true }),
        }],
      };

      expect(applyResultDoor(result, { toolName: 'coord:thread', workspaceId: 'ws-1', runId: RUN_ID })).toBe(result);
    });

    it('passes through documented coord:thread markers nested through tools:invoke', () => {
      const result = {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ entries_truncated: true, thread_metadata_truncated: true }),
        }],
      };

      expect(applyResultDoor(result, {
        toolName: 'tools:invoke',
        nestedTargetToolName: 'coord:thread',
        workspaceId: 'ws-1',
        runId: RUN_ID,
      })).toBe(result);
    });

    it('still marks an unknown coord:thread truncation marker incomplete', () => {
      const result = {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ entries: [{ msg_id: 'm1' }], unknown_truncated: true }),
        }],
      };
      const doored = applyResultDoor(result, { toolName: 'coord:thread', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);

      expect(envelope).toMatchObject({
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      });
      expect(envelope.incomplete.note).toContain('unknown_truncated');
    });

    it('a true truncation marker under the door budget returns an incomplete envelope', () => {
      const result = {
        content: [{ type: 'text' as const, text: '{"entries":[{"id":"m1","body_truncated":true}]}' }],
      };
      const doored = applyResultDoor(result, { toolName: 'coord:inbox', workspaceId: 'ws-1', runId: RUN_ID });
      const envelope = JSON.parse((doored.content[0] as { text: string }).text);
      expect(envelope).toMatchObject({
        state: 'incomplete',
        incomplete: { reason: 'under-budget-partial-result', recoverable: false },
      });
      expect(envelope.incomplete.note).toContain('body_truncated');
    });

    it('keeps selected metadata inline when its truncation warning names an excluded field', () => {
      const source = JSON.stringify({
        rows: [{ msg_id: 'm1', summary: 'selected-summary', body: 'x'.repeat(2_000), body_truncated: true }],
      });
      const parsed = parseProjection({ pick: ['rows[].msg_id', 'rows[].summary'] });
      if (!parsed.ok) throw new Error(parsed.error);

      const projected = applyResultProjection(
        { content: [{ type: 'text' as const, text: source }] } as DoorableResult,
        parsed.spec,
        { toolName: 'coord:feed', effect: 'read' },
      );
      const projection = (projected._meta as {
        resultProjection?: { applied?: boolean; bodyContentIndex?: number; notes?: string[] };
      }).resultProjection;
      expect(projection?.applied).toBe(true);
      expect(projection?.notes?.join('\n')).toContain('body_truncated');
      expect(projection?.bodyContentIndex).toEqual(expect.any(Number));
      const selected = JSON.parse(
        (projected.content[projection!.bodyContentIndex!] as { text: string }).text,
      );
      expect(selected).toEqual({ rows: [{ msg_id: 'm1', summary: 'selected-summary' }] });

      const doored = applyResultDoor(projected, {
        toolName: 'coord:feed',
        workspaceId: 'ws-1',
        runId: 'coord-feed-projected-field-warning',
        scratchWriteFailure: { error: Object.assign(new Error('scratch must not be needed'), { code: 'ENOSPC' }) },
      });
      expect(doored).toBe(projected);
      expect(doored.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n'))
        .toContain('body_truncated');
    });

    it('keeps coord:feed metadata inline when upstream projection truncation and excluded body_truncated overlap', () => {
      const source = JSON.stringify({
        rows: [{
          msg_id: 'm1',
          summary: 'selected-summary',
          body: 'x'.repeat(2_000),
          body_truncated: true,
        }],
      });
      const parsed = parseProjection({ pick: ['rows[].msg_id', 'rows[].summary'] });
      if (!parsed.ok) throw new Error(parsed.error);

      const projected = applyResultProjection(
        {
          content: [{ type: 'text' as const, text: source }],
          _meta: {
            payloadProjection: {
              truncated: true as const,
              tier: 'trimmed',
              forced: true,
              originalChars: 9_000,
              returnedChars: 2_000,
              omittedCount: 1,
            },
          },
        } as DoorableResult,
        parsed.spec,
        { toolName: 'coord:feed', effect: 'read' },
      );
      const projection = (projected._meta as {
        resultProjection?: { bodyContentIndex?: number; notes?: string[] };
      }).resultProjection;
      expect(projection?.notes?.join('\n')).toContain('ALREADY TRUNCATED');
      // payloadProjection is the stronger upstream signal, so this projection
      // does not duplicate the excluded field-level marker in its warning.
      expect(projection?.notes?.join('\n')).not.toContain('body_truncated');

      const doored = applyResultDoor(projected, {
        toolName: 'coord:feed',
        workspaceId: 'ws-1',
        runId: 'coord-feed-upstream-and-field-truncated',
        scratchWriteFailure: { error: Object.assign(new Error('scratch must not be needed'), { code: 'ENOSPC' }) },
      });
      const textItems = doored.content.filter(
        (item) => item.type === 'text',
      ) as Array<{ type: 'text'; text: string }>;

      expect(textItems.map((item) => item.text).join('\n')).toContain('ALREADY TRUNCATED');
      expect(textItems.map((item) => item.text).join('\n')).not.toContain('body_truncated');
      expect(JSON.parse(textItems.at(-1)!.text)).toEqual({
        rows: [{ msg_id: 'm1', summary: 'selected-summary' }],
      });
      expect(JSON.stringify(doored)).not.toContain('papercusp.output-envelope/v1');
      expect(measureResultContextBytes(doored)).toBeLessThanOrEqual(BUDGET_CHARS);
    });
  });
});

/**
 * D-012 (plan agent-context-firewall-and-output-spill-2026-08-02) — the spill
 * footer must be a FUNCTION of the payload, not a constant.
 *
 * The bug this replaces: the footer led with `pipe` "for text" on EVERY result,
 * including the one-line JSON bodies that are most of what this door cuts —
 * where the line operators are provably all-or-nothing and a `grep` no-match
 * returns an empty body that reads like a successful filter
 * (EI-19387749343846381).
 *
 * TEETH: these do not merely assert today's wording. Every case drives the door
 * with a DIFFERENT body shape and requires the output to FOLLOW it, and the
 * third case uses a payload placement that only the shared
 * `classifyProjectionBody` finds — a re-hardcoded `JSON.parse(joined)`
 * classifier passes the first two and fails that one.
 */
describe('buildProjectionHint — D-012 payload-aware spill footer', () => {
  /** A COMPACT (single-line) JSON object over `chars` — the shape this door cuts most. */
  function longJson(chars: number): string {
    const rows: Array<Record<string, string>> = [];
    while (JSON.stringify({ items: rows }).length < chars) {
      rows.push({ id: `WI-${rows.length}`, state: 'open', title: 'a work item title with some length to it' });
    }
    return JSON.stringify({ items: rows });
  }

  function footerFor(content: Array<{ type: 'text'; text: string }>, toolName = 'work_items:list'): string {
    const doored = applyResultDoor({ content }, { toolName, workspaceId: 'ws-1', runId: RUN_ID });
    return boundedBody(doored)._projection.next;
  }

  it('a JSON body leads with `pick` and says `pipe` filters the indented rendering (D-005)', () => {
    const footer = footerFor([{ type: 'text', text: longJson(BUDGET_CHARS * 2) }]);
    expect(footer).toContain('`pick` is what reduces it');
    // oversized-tool-results-reduction-2026-10-12#D-005: applyProjection renders a
    // pipe-only JSON body indented, so `pipe` does cut it. The old claim is now false.
    expect(footer).toContain('`pipe` filters the indented lines');
    expect(footer).not.toContain('all-or-nothing');
    expect(footer).toContain('1 line(s)');
    // The actual defect was ORDER: the pipe form was advertised first.
    expect(footer.indexOf('pick')).toBeLessThan(footer.indexOf('pipe'));
    // The operator list belongs to the text variant only — it is dead weight here.
    expect(footer).not.toContain('grep (fixed/ignoreCase');
    // The constant this replaced said exactly this; its return would be a regression.
    expect(footer).not.toContain('for text, or');
  });

  it('a multi-line non-JSON spill recommends a bounded saved-result query', () => {
    const footer = footerFor([{ type: 'text', text: longText(BUDGET_CHARS * 2) }], 'capability:bash');
    expect(footer).toContain('lines of non-JSON text');
    expect(footer).toContain('capability:read { file_path, query:"terms" }');
    expect(footer).toContain('all terms, context and coverage');
    expect(footer).not.toContain('projection: { pipe:');
  });

  it('uses byte pages when multi-line non-JSON text contains a line too large for a line window', () => {
    const oversizedLine = 'x'.repeat(BUDGET_CHARS * 2);
    const footer = footerFor([
      { type: 'text', text: `line before\n${oversizedLine}\nline after` },
    ], 'capability:read');

    expect(footer).toContain('include a line over');
    expect(footer).toContain('byte_offset+byte_limit; no raw');
    expect(footer).toContain('follow next_cursor');
    expect(footer).not.toContain('op:"grep"');
  });

  it('finds the JSON payload even when it is neither the joined body nor the first item', () => {
    // The live shape: a JSON payload accompanied by advisory prose, so the
    // JOINED text does not parse. A classifier that only tries the join — or
    // only the first item — calls this "text" and emits the wrong operator.
    const footer = footerFor([
      { type: 'text', text: 'See also: work_items:claimable (the claim floors as a tool)' },
      { type: 'text', text: longJson(BUDGET_CHARS * 2) },
    ]);
    expect(footer).toContain('`pick` is what reduces it');
    expect(footer).not.toContain('lines of non-JSON text');
  });

  it('does not advertise `pipe` on a body it just wrote to the spill AS JSON (EI-20071580479842384)', () => {
    // The seam the separate-item test above does NOT reach: the advisory rides
    // in the SAME text item as the payload, so `classifyProjectionBody` misses
    // on both the join and the per-item pass. The spill writer still recovers
    // the payload via `findJsonPrefixSlice` — and the footer used to re-derive
    // the shape with only the weaker half, so ONE string claimed both "JSON at
    // response.data[cursor.bodyOffsetInPayload]" and "`pick` does not apply here".
    // That sent the reader to `pipe`, which on a JSON body is the all-or-nothing
    // trap this very hint exists to warn about.
    const footer = footerFor([
      { type: 'text', text: `${longJson(BUDGET_CHARS * 2)}\n\nSee also: work_items:claimable (the claim floors as a tool)` },
    ]);
    expect(footer).toContain('JSON at response.data[cursor.bodyOffsetInPayload]');
    expect(footer).toContain('`pick` is what reduces it');
    expect(footer).not.toContain('lines of non-JSON text');
    expect(footer).not.toContain('`pick` does not apply');
  });

  it('honors a caller-supplied classification over re-deriving a weaker one', () => {
    // Unit-level falsifier for the wiring itself: same textItems, opposite
    // advice, decided solely by the shape the caller already acted on.
    const sameItemSuffix = [{ text: '{"items":[{"id":"WI-1"}]}\n\nSee also: work_items:list' }];
    expect(buildProjectionHint(sameItemSuffix, 'work_items:list')).toContain('non-JSON text');
    expect(
      buildProjectionHint(sameItemSuffix, 'work_items:list', {
        json: { parsed: { items: [{ id: 'WI-1' }] }, itemIndex: 0 },
        lineCount: 3,
      }),
    ).toContain('`pick` is what reduces it');
  });

  it('a single-line non-JSON body over byte-page size points to capability:read', () => {
    const footer = footerFor([{ type: 'text', text: 'x'.repeat(BUDGET_CHARS * 2) }], 'capability:read');
    expect(footer).toContain('include a line over 4096 bytes; use capability:read cursor.args');
    expect(footer).not.toContain('`projection` cannot help');
    expect(footer).not.toContain('op:"grep"');
    // Byte paging is the recovery path; neither projection nor search is advertised.
    expect(footer).not.toContain('query:"terms"');
  });

  it('advertises the one-call saved-result search on JSON and multi-line spills (token-efficiency P-005)', () => {
    const jsonHint = buildProjectionHint([{ text: '{"a":1}' }], 'plans:get');
    const textHint = buildProjectionHint([{ text: 'line one\nline two\nline three' }], 'plans:get');
    for (const hint of [jsonHint, textHint]) {
      expect(hint).toContain('capability:read { file_path, query:"terms" }');
    }
    // The JSON variant's `next` shares a budget with the retained preview (WI-5656): adding the search
    // route was paid for by trimming, so it must not grow past its pre-P-005 length of 356 chars.
    expect(jsonHint.length).toBeLessThanOrEqual(356);
    // And it reaches the real spill footer, after the projection advice.
    const footer = footerFor([{ type: 'text', text: longJson(BUDGET_CHARS * 2) }]);
    expect(footer.indexOf('query:"terms"')).toBeGreaterThan(footer.indexOf('`pick` is what reduces it'));
  });

  it('the hint is derived from the body, not fixed: the same tool gets DIFFERENT advice for JSON vs text', () => {
    const jsonHint = buildProjectionHint([{ text: '{"a":1}' }], 'plans:get');
    const textHint = buildProjectionHint([{ text: 'line one\nline two\nline three' }], 'plans:get');
    expect(jsonHint).not.toEqual(textHint);
    expect(jsonHint).toContain('pick');
    expect(jsonHint).toContain('1 line(s)');
    expect(textHint).toContain('3 lines of non-JSON text');
    // Reader-capability leg: the reachable form for a schema-driven client.
    expect(jsonHint).toContain('JSON STRING');
    expect(textHint).toContain('JSON STRING');
  });

  it('fails soft to payload-agnostic wording rather than losing the hint', () => {
    // A getter that throws stands in for any future classifier fault; the door's
    // contract is that a hint problem never costs the caller the footer.
    const hostile = [
      {
        get text(): string {
          throw new Error('boom');
        },
      },
    ] as unknown as Array<{ text: string }>;
    const hint = buildProjectionHint(hostile, 'plans:get');
    expect(hint).toContain('pick');
    expect(hint).toContain('pipe');
  });
});
