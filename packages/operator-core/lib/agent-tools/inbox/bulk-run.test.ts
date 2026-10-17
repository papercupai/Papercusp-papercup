/**
 * inbox:bulk-run-act / report recurrence guards (WI-41022).
 *
 * The store integration suite proves the run-row lock ordering. These tests
 * pin the tool boundary around that store primitive: only `act` may create an
 * auto-resolved outcome, it reuses the shared terminal dispatcher, a Stop
 * refusal never enters the dispatcher, and a persistence failure after an
 * external effect is surfaced as a non-retryable reconciliation incident.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { schemaToText } from '../../cupboard/tools-discovery';
import { withInlinedSchemaRefs } from '../schema-ref-inline';

const h = vi.hoisted(() => ({
  getFlag: vi.fn(),
  getRun: vi.fn(),
  getActiveRun: vi.fn(),
  getRunItems: vi.fn(),
  executeBulkRunAction: vi.fn(),
  failRunIfExecuting: vi.fn(),
  recordRunHeartbeat: vi.fn(),
  reportOutcomes: vi.fn(),
  setRunPhase: vi.fn(),
  settleRunPhase: vi.fn(),
  callPlansRead: vi.fn(),
  readInboxWindow: vi.fn(),
  readAckedMsgIds: vi.fn(),
  inProcessCall: vi.fn(),
  innerCall: vi.fn(),
  dispatchAttentionTerminalAction: vi.fn(),
  readStandingBulkAutomationPolicy: vi.fn(),
  upsertTriage: vi.fn(),
  notifySyncInvalidate: vi.fn(),
}));

vi.mock('@papercusp/flags/server', () => ({ getFlag: h.getFlag }));
vi.mock('../../attention/bulk-run-store', () => ({
  getRun: h.getRun,
  getActiveRun: h.getActiveRun,
  getRunItems: h.getRunItems,
  executeBulkRunAction: h.executeBulkRunAction,
  failRunIfExecuting: h.failRunIfExecuting,
  recordRunHeartbeat: h.recordRunHeartbeat,
  reportOutcomes: h.reportOutcomes,
  setRunPhase: h.setRunPhase,
  settleRunPhase: h.settleRunPhase,
  RUNNING_PHASES: ['pending', 'running'],
}));
vi.mock('../../attention/triage-store', () => ({ upsertTriage: h.upsertTriage }));
vi.mock('../../attention/terminal-action-dispatch', () => ({
  dispatchAttentionTerminalAction: h.dispatchAttentionTerminalAction,
}));
vi.mock('../../attention/automation-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention/automation-policy')>()),
  readStandingBulkAutomationPolicy: h.readStandingBulkAutomationPolicy,
}));
vi.mock('../plans/read-dispatch', () => ({ callPlansRead: h.callPlansRead }));
vi.mock('../coordination/messages', () => ({
  readInboxWindow: h.readInboxWindow,
  readAckedMsgIds: h.readAckedMsgIds,
}));
vi.mock('../_compound-dispatch', () => ({ inProcessCall: h.inProcessCall }));
vi.mock('../coordination/identity', () => ({
  ADMIN_COORD_UI_OWNER: 'pc-admin-coord-ui',
  resolveAgentIdentity: () => ({ ownerId: 'su-resolver' }),
}));
vi.mock('../coordination/inbox-reply', () => ({ deliverInboxOwnerReply: vi.fn() }));
vi.mock('../../sync-sse', () => ({ notifySyncInvalidate: h.notifySyncInvalidate }));

import { bulkRunAct, bulkRunManifest, bulkRunReport } from './bulk-run';

type ToolBody = Record<string, unknown>;
type ExecuteInput = {
  runId: string;
  itemId: string;
  actionId: string;
  rationale: string;
  execute: () => Promise<unknown>;
  audit?: (tx: unknown) => Promise<void>;
};

function body(result: unknown): ToolBody {
  const data = (result as { data?: unknown } | null)?.data;
  if (data != null && typeof data === 'object' && !Array.isArray(data)) {
    return data as ToolBody;
  }
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
  if (typeof text !== 'string') throw new Error(`not a tool response: ${JSON.stringify(result)}`);
  return JSON.parse(text) as ToolBody;
}

const run = {
  runId: 'run-1',
  workspaceId: 'ws-1',
  harnessSlug: 'papercusp',
  phase: 'running',
  autoResolved: 0,
  recommended: 0,
  skipped: 0,
  failed: 0,
};

const item = {
  runId: run.runId,
  itemId: 'attention-1',
  position: 0,
  kind: 'coord-message',
  title: 'Acknowledge this message',
  ref: { kind: 'coord-message', msgId: 'msg-1' },
  ownerAgentId: 'su-asker',
  outcome: 'pending',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getFlag.mockResolvedValue(true);
  h.getRun.mockResolvedValue(run);
  h.getRunItems.mockResolvedValue([item]);
  h.recordRunHeartbeat.mockResolvedValue(run);
  h.failRunIfExecuting.mockResolvedValue({ ...run, phase: 'failed' });
  h.reportOutcomes.mockResolvedValue({ updated: [], unknown: [], preserved: [], refused: null });
  h.callPlansRead.mockResolvedValue({
    groups: [{ items: [{ id: item.itemId, ref: item.ref, actions: [{ id: 'ack', label: 'Acknowledge' }] }] }],
  });
  h.readInboxWindow.mockResolvedValue({ entries: [], exhausted: true, rowsScanned: 0, pages: 0 });
  h.readAckedMsgIds.mockResolvedValue(new Set<string>());
  h.inProcessCall.mockReturnValue(h.innerCall);
  h.dispatchAttentionTerminalAction.mockResolvedValue({ resolved: true });
  h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L1', minConfidence: 'high' });
  h.upsertTriage.mockResolvedValue(undefined);
  h.notifySyncInvalidate.mockResolvedValue(undefined);
});

describe('inbox:bulk-run-report auto_resolved rail', () => {
  it('rejects auto_resolved in both shorthand and bulk forms while accepting recommendations', () => {
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        itemId: item.itemId,
        outcome: 'auto_resolved',
        actionId: 'ack',
        rationale: 'Handled.',
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        items: [{ itemId: item.itemId, outcome: 'auto_resolved', actionId: 'ack', rationale: 'Handled.' }],
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        itemId: item.itemId,
        outcome: 'recommended',
        actionId: 'ack',
        rationale: 'The message only needs acknowledgement.',
      }).success,
    ).toBe(true);
  });
});

describe('inbox:bulk-run-report conditional error contract', () => {
  it('advertises and enforces non-empty reasons for skipped/failed outcomes in both report forms', () => {
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        items: [{ itemId: item.itemId, outcome: 'skipped' }],
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        items: [{ itemId: item.itemId, outcome: 'failed', error: '   ' }],
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        items: [{ itemId: item.itemId, outcome: 'skipped', error: 'No action applies.' }],
      }).success,
    ).toBe(true);

    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        itemId: item.itemId,
        outcome: 'failed',
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        itemId: item.itemId,
        outcome: 'skipped',
        error: '   ',
      }).success,
    ).toBe(false);
    expect(
      bulkRunReport.args.safeParse({
        runId: run.runId,
        itemId: item.itemId,
        outcome: 'skipped',
        error: 'No action applies.',
      }).success,
    ).toBe(true);

    const schemaText =
      schemaToText(withInlinedSchemaRefs(z.toJSONSchema(bulkRunReport.args as never))) ?? '';
    expect(schemaText).toContain('constraint:items[]');
    expect(schemaText).toContain('constraint:$');
    expect(schemaText).toContain('skipped or failed');
    expect(schemaText).toContain('non-empty reason');
  });
});

describe('inbox:bulk-run-report late-return evidence', () => {
  it('returns the exact rows updated when a bulk report partially matches the run snapshot', async () => {
    const unknownItemId = 'attention-outside-run';
    h.reportOutcomes.mockResolvedValue({
      updated: [item.itemId],
      unknown: [unknownItemId],
      preserved: [],
      refused: null,
    });

    const result = body(
      await bulkRunReport.handler(
        {
          runId: run.runId,
          items: [
            { itemId: item.itemId, outcome: 'failed', error: 'The resolver could not handle this item.' },
            { itemId: unknownItemId, outcome: 'failed', error: 'This id is not in the run snapshot.' },
          ],
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(result).toMatchObject({ runId: run.runId, wrote: 1, updatedItemIds: [item.itemId] });
    expect(result.ignored).toMatchObject({ itemIds: [unknownItemId] });
  });

  it('returns explicit zero-write evidence when the active run is absent', async () => {
    h.getActiveRun.mockResolvedValueOnce(null);

    const result = body(
      await bulkRunReport.handler(
        { itemId: item.itemId, outcome: 'failed', error: 'No run is active.' },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'no_active_run',
      runId: null,
      wrote: 0,
      updatedItemIds: [],
    });
  });
});

describe('inbox:bulk-run-manifest canonical action vocabulary', () => {
  it('bypasses the UI list projection, which intentionally strips actions', async () => {
    const result = body(
      await bulkRunManifest.handler({ runId: run.runId, includeReported: false }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(h.callPlansRead).toHaveBeenCalledWith('attention', {}, { uiProjection: false });
    expect(h.callPlansRead).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: true,
      items: [
        expect.objectContaining({
          itemId: item.itemId,
          actions: [{ id: 'ack', label: 'Acknowledge', terminal: true }],
        }),
      ],
    });
  });

  it('returns a typed retryable failure when the canonical action snapshot read fails', async () => {
    h.callPlansRead.mockRejectedValue(new Error('temporary attention read failure'));

    const result = body(
      await bulkRunManifest.handler({ runId: run.runId, includeReported: false }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'action_discovery_failed',
      retryable: true,
      runId: run.runId,
    });
    expect(result.items).toBeUndefined();
  });

  it('preserves a valid empty action snapshot as a successful manifest', async () => {
    h.callPlansRead.mockResolvedValue({ groups: [] });

    const result = body(
      await bulkRunManifest.handler({ runId: run.runId, includeReported: false }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(result).toMatchObject({
      ok: true,
      items: [expect.objectContaining({ itemId: item.itemId, actions: [] })],
    });
  });

  it('does not treat a malformed action snapshot as a valid empty snapshot', async () => {
    h.callPlansRead.mockResolvedValue({});

    const result = body(
      await bulkRunManifest.handler({ runId: run.runId, includeReported: false }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'action_discovery_failed',
      retryable: true,
      runId: run.runId,
    });
  });

  it('loads one canonical action snapshot for a max-size 200-item manifest', async () => {
    const items = Array.from({ length: 200 }, (_, position) => ({
      ...item,
      itemId: `attention-${position + 1}`,
      position,
    }));
    h.getRunItems.mockResolvedValue(items);
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: items.map((row) => ({
            id: row.itemId,
            ref: row.ref,
            actions: [{ id: 'ack', label: 'Acknowledge' }],
          })),
        },
      ],
    });

    const result = body(
      await bulkRunManifest.handler({ runId: run.runId, includeReported: false }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(h.callPlansRead).toHaveBeenCalledTimes(1);
    expect(result.items).toHaveLength(200);
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: 'attention-200',
          actions: [{ id: 'ack', label: 'Acknowledge', terminal: true }],
        }),
      ]),
    );
  });

  it('hydrates a selected coord-message from the exact inbox window when the latest attention page omits it', async () => {
    const stale = {
      ...item,
      itemId: 'coord-message:older-message',
      ref: { kind: 'coord-message', msgId: 'older-message' },
    };
    h.getRunItems.mockResolvedValue([stale]);
    h.callPlansRead.mockResolvedValue({ groups: [] });
    h.readInboxWindow.mockResolvedValue({
      entries: [{
        msg_id: 'older-message',
        ts: '2026-10-16T12:00:00.000Z',
        kind: 'message',
        from: 'su-sender',
        to: ['human'],
        summary: 'An older selected message',
        body: 'The message is still live.',
      }],
      exhausted: true,
      rowsScanned: 1,
      pages: 1,
    });

    const result = body(
      await bulkRunManifest.handler({ runId: run.runId }, { workspaceId: run.workspaceId } as never),
    );

    expect(h.readInboxWindow).toHaveBeenCalledWith(
      'human',
      { kinds: ['message'] },
      expect.any(Function),
    );
    expect(result).toMatchObject({
      ok: true,
      items: [expect.objectContaining({
        itemId: stale.itemId,
        actions: [
          { id: 'ack', label: 'Acknowledge', terminal: true },
          { id: 'discuss', label: 'Discuss', terminal: false },
        ],
      })],
    });
  });
});

describe('inbox:bulk-run-report live-action snapshot reuse', () => {
  it('validates a batch from one canonical action snapshot', async () => {
    const second = { ...item, itemId: 'attention-2', position: 1 };
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: [item, second].map((row) => ({
            id: row.itemId,
            ref: row.ref,
            actions: [{ id: 'ack', label: 'Acknowledge' }],
          })),
        },
      ],
    });

    await bulkRunReport.handler(
      {
        runId: run.runId,
        items: [item, second].map((row) => ({
          itemId: row.itemId,
          outcome: 'recommended' as const,
          actionId: 'ack',
          rationale: 'The message only needs acknowledgement.',
        })),
      },
      { workspaceId: run.workspaceId } as never,
    );

    expect(h.callPlansRead).toHaveBeenCalledTimes(1);
    expect(h.reportOutcomes).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        outcomes: expect.arrayContaining([
          expect.objectContaining({ itemId: item.itemId, actionId: 'ack' }),
          expect.objectContaining({ itemId: second.itemId, actionId: 'ack' }),
        ]),
      }),
    );
  });
});

describe('inbox:bulk-run-report standing-policy auto-accept', () => {
  type ReportTestItem = {
    runId: string;
    itemId: string;
    position: number;
    kind: string;
    title: string;
    ref: Record<string, unknown>;
    ownerAgentId: string;
    outcome: string;
  };

  function reportItem(
    overrides: Partial<{
      itemId: string;
      actionId: string;
      rationale: string;
      confidenceLevel: 'high' | 'medium' | 'low' | 'insufficient';
      recommendationKind: 'owner_action' | 'cleanup_candidate' | 'retry_needed' | 'routed' | 'investigate';
      recommendationLabel: string;
      recommendationRationale: string;
      evidenceBasis: string[];
      responsibility: 'owner' | 'agent' | 'system' | 'engineering' | 'unknown';
      retryCondition: string;
    }> = {},
  ) {
    return {
      itemId: item.itemId,
      outcome: 'recommended' as const,
      actionId: 'ack',
      rationale: 'The live evidence supports this terminal action.',
      confidenceLevel: 'high' as const,
      ...overrides,
    };
  }

  function arrangeSuccessfulAction(activeItem: ReportTestItem = item, actionId = 'ack') {
    h.getRunItems.mockResolvedValue([activeItem]);
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: [
            {
              id: activeItem.itemId,
              ref: activeItem.ref,
              actions: [{ id: actionId, label: 'Resolve' }],
            },
          ],
        },
      ],
    });
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => ({
      actionResult: await input.execute(),
      item: {
        ...activeItem,
        outcome: 'auto_resolved',
        actionId: input.actionId,
        rationale: input.rationale,
      },
      run: { ...run, autoResolved: 1 },
      refused: null,
    }));
  }

  it('returns the canonical receipt and skips auto-accept for a stale report', async () => {
    const receipt = {
      ...item,
      outcome: 'auto_resolved',
      actionId: 'ack',
      rationale: 'Canonical action completed.',
      disposition: 'auto_resolved',
      decidedAt: '2026-10-11T12:00:00.000Z',
      revertHandle: {
        kind: 'attention-bulk-item',
        version: 1,
        workspaceId: run.workspaceId,
        runId: run.runId,
        itemId: item.itemId,
      },
      reversalWindowUntil: '2026-10-11T13:00:00.000Z',
    };
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L0', minConfidence: 'high' });
    arrangeSuccessfulAction();
    h.reportOutcomes.mockResolvedValue({
      updated: [],
      unknown: [],
      preserved: [receipt],
      run: { ...run, autoResolved: 1 },
      refused: null,
    });

    const result = body(
      await bulkRunReport.handler({ runId: run.runId, items: [reportItem()] }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(result.preservedOutcomes).toEqual([
      expect.objectContaining({
        itemId: item.itemId,
        outcome: 'auto_resolved',
        actionId: 'ack',
        rationale: 'Canonical action completed.',
        disposition: 'auto_resolved',
        decidedAt: receipt.decidedAt,
        revertHandle: receipt.revertHandle,
        reversalWindowUntil: receipt.reversalWindowUntil,
      }),
    ]);
    expect(result.autoAccept).toMatchObject({
      reportedRecommendations: 0,
      actionCandidates: 0,
      terminalCandidates: 0,
      attempted: 0,
      resolved: 0,
      leftForReview: 0,
    });
    expect(h.executeBulkRunAction).not.toHaveBeenCalled();
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
    expect(h.upsertTriage).not.toHaveBeenCalled();
  });

  it.each(['auto_resolved', 'dismissed'] as const)(
    'excludes a preserved %s receipt while auto-accepting an ordinary pending sibling',
    async (outcome) => {
      const sibling = { ...item, itemId: `${item.itemId}-pending` };
      arrangeSuccessfulAction(sibling);
      h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L1', minConfidence: 'high' });
      h.reportOutcomes.mockResolvedValue({
        updated: [sibling.itemId], unknown: [],
        preserved: [{ ...item, outcome, rationale: 'Canonical protected decision.' }],
        run, refused: null,
      });
      const result = body(await bulkRunReport.handler({
        runId: run.runId,
        items: [reportItem(), reportItem({ itemId: sibling.itemId })],
      }, { workspaceId: run.workspaceId } as never));
      expect(result.preservedOutcomes).toEqual([
        expect.objectContaining({ itemId: item.itemId, outcome, rationale: 'Canonical protected decision.' }),
      ]);
      expect(result.autoAccept).toMatchObject({
        reportedRecommendations: 1, actionCandidates: 1, terminalCandidates: 1,
        attempted: 1, resolved: 1, unresolved: [],
      });
      expect(h.executeBulkRunAction).toHaveBeenCalledTimes(1);
      expect(h.executeBulkRunAction).toHaveBeenCalledWith(expect.objectContaining({ itemId: sibling.itemId }));
      expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    },
  );

  it('returns a retryable action-discovery error before accepting a report', async () => {
    h.callPlansRead.mockRejectedValue(new Error('temporary attention read failure'));

    const result = body(
      await bulkRunReport.handler({ runId: run.runId, items: [reportItem()] }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'action_discovery_failed',
      retryable: true,
      runId: run.runId,
    });
    expect(h.reportOutcomes).not.toHaveBeenCalled();
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('returns a canonical receipt when a late report is refused after Stop', async () => {
    const receipt = {
      ...item,
      outcome: 'auto_resolved',
      actionId: 'ack',
      rationale: 'Canonical action completed.',
      disposition: 'auto_resolved',
      decidedAt: '2026-10-11T12:00:00.000Z',
      revertHandle: {
        kind: 'attention-bulk-item',
        version: 1,
        workspaceId: run.workspaceId,
        runId: run.runId,
        itemId: item.itemId,
      },
      reversalWindowUntil: '2026-10-11T13:00:00.000Z',
    };
    h.reportOutcomes.mockResolvedValue({
      updated: [],
      unknown: [item.itemId],
      preserved: [receipt],
      run: { ...run, phase: 'review', autoResolved: 1 },
      refused: { reason: 'run_not_accepting_reports', phase: 'review' },
    });

    const result = body(
      await bulkRunReport.handler({ runId: run.runId, items: [reportItem()] }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(result).toMatchObject({
      ok: false,
      refused: 'run_not_accepting_reports',
      phase: 'review',
      runId: run.runId,
      wrote: 0,
      preservedOutcomes: [
        expect.objectContaining({
          itemId: item.itemId,
          outcome: 'auto_resolved',
          actionId: 'ack',
          rationale: 'Canonical action completed.',
          revertHandle: receipt.revertHandle,
        }),
      ],
    });
    expect(h.executeBulkRunAction).not.toHaveBeenCalled();
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
    expect(h.upsertTriage).not.toHaveBeenCalled();
  });

  it.each([
    ['coord-message', 'ack'],
    ['work-item-needs-human', 'resolve'],
    ['smoke-fail', 'resolve'],
  ])('automatically applies a recommended %s action with an explicit all-risk grant', async (kind, actionId) => {
    const riskLevels = { low: 'automatic', medium: 'automatic', high: 'automatic' } as const;
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L0', minConfidence: 'high', riskLevels });
    arrangeSuccessfulAction({ ...item, kind, ref: { kind } }, actionId);
    const result = body(await bulkRunReport.handler({ runId: run.runId,
      items: [reportItem({ actionId })] }, { workspaceId: run.workspaceId } as never));
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    expect(result.autoAccept).toMatchObject({ attempted: 1, resolved: 1, leftForReview: 0 });
  });

  it('rechecks a revoked grant inside the action window and leaves the recommendation for review', async () => {
    arrangeSuccessfulAction();
    h.readStandingBulkAutomationPolicy.mockResolvedValueOnce({ level: 'L1', minConfidence: 'high' })
      .mockResolvedValue({ level: 'L0', minConfidence: 'high' });
    const result = body(await bulkRunReport.handler({ runId: run.runId,
      items: [reportItem()] }, { workspaceId: run.workspaceId } as never));
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
    expect(result.autoAccept).toMatchObject({ resolved: 0, leftForReview: 1 });
  });

  it('persists first, then auto-accepts an above-floor L1 recommendation through bulk-run-act', async () => {
    arrangeSuccessfulAction();

    const result = body(
      await bulkRunReport.handler(
        {
          runId: run.runId,
          items: [
            reportItem({
              recommendationKind: 'routed',
              recommendationLabel: 'Acknowledge message',
              recommendationRationale: 'The canonical recommendation rationale.',
              evidenceBasis: ['The message is informational and offers Acknowledge.'],
              responsibility: 'agent',
              retryCondition: 'Retry if acknowledgement fails before dispatch.',
            }),
          ],
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.reportOutcomes.mock.invocationCallOrder[0]).toBeLessThan(
      h.executeBulkRunAction.mock.invocationCallOrder[0]!,
    );
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    expect(h.executeBulkRunAction).toHaveBeenCalledWith(
      expect.objectContaining({
        confidenceLevel: 'high',
        recommendationKind: 'routed',
        recommendationLabel: 'Acknowledge message',
        recommendationRationale: 'The canonical recommendation rationale.',
        evidenceBasis: ['The message is informational and offers Acknowledge.'],
        responsibility: 'agent',
        retryCondition: 'Retry if acknowledgement fails before dispatch.',
      }),
    );
    expect(result.autoAccept).toMatchObject({
      reportedRecommendations: 1,
      actionCandidates: 1,
      terminalCandidates: 1,
      attempted: 1,
      resolved: 1,
      leftForReview: 0,
      unresolved: [],
    });
  });

  it.each([
    [{ level: 'L0', minConfidence: 'high' }, 'high', 'review-all'],
    [{ level: 'L1', minConfidence: 'high' }, 'medium', 'confidence-below-floor'],
  ] as const)(
    'leaves a recommendation reviewable when policy %j refuses confidence %s',
    async (policy, confidenceLevel, reason) => {
      h.readStandingBulkAutomationPolicy.mockResolvedValue(policy);

      const result = body(
        await bulkRunReport.handler({ runId: run.runId, items: [reportItem({ confidenceLevel })] }, {
          workspaceId: run.workspaceId,
        } as never),
      );

      expect(h.reportOutcomes).toHaveBeenCalledTimes(1);
      expect(h.executeBulkRunAction).not.toHaveBeenCalled();
      expect(result.autoAccept).toMatchObject({
        attempted: 1,
        resolved: 0,
        leftForReview: 1,
        unresolved: [
          expect.objectContaining({
            itemId: item.itemId,
            refused: 'automation_policy',
            reason,
          }),
        ],
      });
      expect((result.autoAccept as { unresolved: Array<{ message: string }> }).unresolved[0]!.message).toContain(
        'standing authority',
      );
    },
  );

  it('keeps never-auto recommendations reviewable even at L2 above the floor', async () => {
    const protectedItem = { ...item, kind: 'smoke-fail', ref: { kind: 'smoke-fail' } };
    h.getRunItems.mockResolvedValue([protectedItem]);
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: [{ id: protectedItem.itemId, ref: protectedItem.ref, actions: [{ id: 'resolve', label: 'Resolve' }] }],
        },
      ],
    });
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L2', minConfidence: 'low' });

    const result = body(
      await bulkRunReport.handler(
        {
          runId: run.runId,
          items: [reportItem({ actionId: 'resolve', confidenceLevel: 'high' })],
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.executeBulkRunAction).not.toHaveBeenCalled();
    expect(result.autoAccept).toMatchObject({
      attempted: 1,
      resolved: 0,
      leftForReview: 1,
      unresolved: [expect.objectContaining({ refused: 'automation_policy', reason: 'never-auto' })],
    });
  });

  it('lets L2 auto-accept an above-floor owner-by-right recommendation', async () => {
    const ownerItem = {
      ...item,
      kind: 'work-item-needs-human',
      ref: { kind: 'work-item-needs-human', workItemId: 'WI-owner' },
    };
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L2', minConfidence: 'high' });
    arrangeSuccessfulAction(ownerItem, 'resolve');

    const result = body(
      await bulkRunReport.handler(
        {
          runId: run.runId,
          items: [reportItem({ actionId: 'resolve', confidenceLevel: 'high' })],
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    expect(result.autoAccept).toMatchObject({ attempted: 1, resolved: 1, leftForReview: 0 });
  });

  it('does not auto-attempt typed recommendations without a terminal action', async () => {
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: [
            {
              id: item.itemId,
              ref: item.ref,
              actions: [{ id: 'discuss', label: 'Discuss' }],
            },
          ],
        },
      ],
    });

    const result = body(
      await bulkRunReport.handler(
        {
          runId: run.runId,
          items: [
            reportItem({ actionId: 'discuss' }),
            reportItem({
              itemId: 'attention-2',
              actionId: undefined,
              recommendationKind: 'owner_action',
              recommendationLabel: 'Owner decision',
              recommendationRationale: 'This item has no terminal action.',
              responsibility: 'owner',
            }),
          ],
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.executeBulkRunAction).not.toHaveBeenCalled();
    expect(result.autoAccept).toMatchObject({
      reportedRecommendations: 2,
      actionCandidates: 1,
      terminalCandidates: 0,
      attempted: 0,
      resolved: 0,
      leftForReview: 2,
    });
  });

  it('surfaces an auto-accept failure while preserving the persisted recommendation', async () => {
    h.executeBulkRunAction.mockRejectedValue(new Error('store action failed'));

    const result = body(
      await bulkRunReport.handler({ runId: run.runId, items: [reportItem()] }, {
        workspaceId: run.workspaceId,
      } as never),
    );

    expect(h.reportOutcomes).toHaveBeenCalledTimes(1);
    expect(result.autoAccept).toMatchObject({
      attempted: 1,
      resolved: 0,
      leftForReview: 1,
      unresolved: [
        expect.objectContaining({
          itemId: item.itemId,
          error: 'terminal_action_failed',
          message: 'store action failed',
        }),
      ],
    });
  });
});

describe('inbox:bulk-run-act authority boundary', () => {
  async function arrangeSuccessfulAction(
    overrides: Partial<Omit<typeof item, 'kind' | 'ref'>> & {
      kind?: string;
      ref?: Record<string, unknown>;
    } = {},
  ) {
    const activeItem = { ...item, ...overrides };
    h.getRunItems.mockResolvedValue([activeItem]);
    h.callPlansRead.mockResolvedValue({
      groups: [
        {
          items: [
            {
              id: activeItem.itemId,
              ref: activeItem.ref,
              actions: [{ id: 'resolve', label: 'Resolve' }],
            },
          ],
        },
      ],
    });
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => ({
      actionResult: await input.execute(),
      item: {
        ...activeItem,
        outcome: 'auto_resolved',
        actionId: input.actionId,
        rationale: input.rationale,
      },
      run: { ...run, autoResolved: 1 },
      refused: null,
    }));
    return activeItem;
  }

  it('uses the live standing confidence floor rather than the run receipt', async () => {
    h.getRun.mockResolvedValue({
      ...run,
      automationPolicy: { level: 'L2', mode: 'safe-high', minConfidence: 'low' },
    });
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L1', minConfidence: 'high' });
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'Evidence is incomplete.',
          confidenceLevel: 'medium',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({
      ok: false,
      refused: 'automation_policy',
      reason: 'confidence-below-floor',
    });
    expect(h.readStandingBulkAutomationPolicy).toHaveBeenCalledWith(run.workspaceId);
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('keeps L0 review-all even for above-floor delegable kinds', async () => {
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L0', minConfidence: 'high' });
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'High-confidence acknowledgement.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: 'automation_policy', reason: 'review-all' });
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('lets L1 auto-apply an above-floor delegable kind', async () => {
    await arrangeSuccessfulAction();
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'The delegable item has decisive evidence.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, outcome: 'auto_resolved', actionDispatched: true });
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
  });

  it('re-validates a selected coord-message through the exact inbox window after attention pagination moves', async () => {
    const activeItem = {
      ...item,
      itemId: 'coord-message:older-message',
      ref: { kind: 'coord-message', msgId: 'older-message' },
    };
    h.getRunItems.mockResolvedValue([activeItem]);
    h.callPlansRead.mockResolvedValue({ groups: [] });
    h.readInboxWindow.mockResolvedValue({
      entries: [{
        msg_id: 'older-message',
        ts: '2026-10-16T12:00:00.000Z',
        kind: 'message',
        from: 'su-sender',
        to: ['human'],
        summary: 'An older selected message',
        body: 'The message is still live.',
      }],
      exhausted: true,
      rowsScanned: 1,
      pages: 1,
    });
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => ({
      actionResult: await input.execute(),
      item: { ...activeItem, outcome: 'auto_resolved', actionId: input.actionId, rationale: input.rationale },
      run: { ...run, autoResolved: 1 },
      refused: null,
    }));

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: activeItem.itemId,
          actionId: 'ack',
          rationale: 'The selected message is still live and should be acknowledged.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(result).toMatchObject({ ok: true, outcome: 'auto_resolved', actionDispatched: true });
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable action-discovery error before dispatching a terminal action', async () => {
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => {
      await input.execute();
      throw new Error('unreachable after a successful execution callback');
    });
    h.callPlansRead.mockRejectedValue(new Error('temporary attention read failure'));

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'The message has decisive evidence.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(result).toMatchObject({
      ok: false,
      error: 'action_discovery_failed',
      retryable: true,
      actionDispatched: false,
      reconciliationRequired: false,
    });
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
    expect(h.upsertTriage).not.toHaveBeenCalled();
  });

  it('keeps owner-by-right kinds unreachable at L1', async () => {
    h.getRunItems.mockResolvedValue([
      {
        ...item,
        kind: 'work-item-needs-human',
        ref: { kind: 'work-item-needs-human', msgId: 'msg-owner' },
      },
    ]);
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'The item is ready to resume.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: 'automation_policy', reason: 'owner-by-right' });
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('lets L2 auto-ratify an above-floor owner-by-right judgment kind', async () => {
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L2', minConfidence: 'high' });
    await arrangeSuccessfulAction({
      kind: 'work-item-needs-human',
      ref: { kind: 'work-item-needs-human', msgId: 'msg-owner' },
    });
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'The owner gate is satisfied by decisive evidence.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: true, outcome: 'auto_resolved', actionDispatched: true });
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
  });

  it('keeps never-auto kinds unreachable even at L2 and above the floor', async () => {
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L2', minConfidence: 'low' });
    h.getRunItems.mockResolvedValue([{ ...item, kind: 'smoke-fail', ref: { kind: 'smoke-fail' } }]);
    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'resolve',
          rationale: 'Must remain protected.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
    expect(result).toMatchObject({ ok: false, refused: 'automation_policy', reason: 'never-auto' });
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it.each(['L0', 'L1', 'L2'] as const)(
    'scheduled resolver keeps protected standing-approval never-auto at %s',
    async (level) => {
      // P-011: the scheduled path must share the same permanent floor as the
      // owner-triggered path. `standing-approval` is the protected
      // system-control category; even L2 + a low confidence floor cannot let
      // an unattended resolver grant or dismiss it.
      h.readStandingBulkAutomationPolicy.mockResolvedValue({ level, minConfidence: 'low' });
      h.getRunItems.mockResolvedValue([
        {
          ...item,
          kind: 'standing-approval',
          ref: { kind: 'standing-approval', capability: 'harness:write', targetHarness: 'sheets' },
        },
      ]);

      const result = body(
        await bulkRunAct.handler(
          {
            runId: run.runId,
            itemId: item.itemId,
            actionId: 'grant',
            rationale: 'Protected decisions remain owner-controlled.',
            confidenceLevel: 'high',
          },
          { workspaceId: run.workspaceId } as never,
        ),
      );

      expect(result).toMatchObject({ ok: false, refused: 'automation_policy', reason: 'never-auto' });
      expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
    },
  );

  it('dispatches through the shared map and joins the required audit to the store transaction', async () => {
    const tx = { transaction: 'bulk-act' };
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => {
      const actionResult = await input.execute();
      await input.audit?.(tx);
      return {
        actionResult,
        item: { ...item, outcome: 'auto_resolved', actionId: input.actionId, rationale: input.rationale },
        run: { ...run, autoResolved: 1 },
        refused: null,
      };
    });

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'The owner has read the message.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        item: expect.objectContaining({ id: item.itemId, ref: item.ref }),
        actionId: 'ack',
      }),
    );
    expect(h.upsertTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: item.itemId,
        action: 'resolve',
        note: 'Bulk resolve: The owner has read the message.',
        triagedBy: 'su-resolver',
        workspaceId: run.workspaceId,
        sql: tx,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      outcome: 'auto_resolved',
      actionDispatched: true,
      counters: { autoResolved: 1 },
    });
  });

  it('does not enter the dispatcher when Stop has already revoked run authority', async () => {
    h.executeBulkRunAction.mockResolvedValue({
      actionResult: null,
      item: null,
      run: { ...run, phase: 'review' },
      refused: { reason: 'run_authority_revoked', phase: 'review' },
    });

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'Must not run after Stop.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
    expect(h.upsertTriage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: false,
      refused: 'run_authority_revoked',
      actionDispatched: false,
    });
  });

  it('surfaces a post-dispatch audit failure as reconciliation-required and never retries', async () => {
    const tx = { transaction: 'bulk-act-failed' };
    h.upsertTriage.mockRejectedValue(new Error('audit insert failed'));
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => {
      await input.execute();
      await input.audit?.(tx);
      throw new Error('unreachable');
    });

    const result = body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: item.itemId,
          actionId: 'ack',
          rationale: 'The message was acknowledged before audit persistence failed.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );

    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledTimes(1);
    expect(h.upsertTriage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      error: 'post_dispatch_persistence_failed',
      actionDispatched: true,
      reconciliationRequired: true,
    });
  });
});

// WI-41370 — the plan-item terminal actions failed live because this wiring passed
// `itemId` to plans:set-status (which accepts only `item` and REJECTS undeclared keys,
// EI-10883) and `dropped` additionally requires a nonblank rationale. Pin the wire
// contract so a key rename or a dropped-reason regression fails here, not in the field.
describe('terminalDependencies plan-item wire contract (WI-41370)', () => {
  it('setPlanItemStatus calls plans:set-status with item (never itemId) and threads the rationale', async () => {
    const { terminalDependencies } = await import('./bulk-run');
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const call = async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { ok: true };
    };
    const deps = terminalDependencies({ call: call as never });

    await deps.setPlanItemStatus({ slug: 'a-plan', itemId: 'P-010', status: 'dropped', rationale: 'why it is moot' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('plans:set-status');
    expect(calls[0]!.args).toMatchObject({ slug: 'a-plan', item: 'P-010', status: 'dropped' });
    expect(calls[0]!.args).not.toHaveProperty('itemId');
    expect(String(calls[0]!.args.rationale)).toContain('why it is moot');

    // `dropped` REQUIRES a nonblank reason server-side: the wiring must supply a
    // fallback even when the caller omitted one.
    await deps.setPlanItemStatus({ slug: 'a-plan', itemId: 'P-011', status: 'done' });
    expect(String(calls[1]!.args.rationale ?? '').trim()).not.toBe('');
  });

  it('preserves a failed plans:set-status member detail from its outer bulk envelope', async () => {
    const { terminalDependencies } = await import('./bulk-run');
    const deps = terminalDependencies({
      call: (async () => ({
        ok: false,
        results: [{ ok: false, item: 'P-010', error: 'unexpected_status', detail: 'current status is shipped' }],
        counts: { ok: 0, failed: 1 },
      })) as never,
    });

    await expect(
      deps.setPlanItemStatus({
        slug: 'a-plan',
        itemId: 'P-010',
        status: 'dropped',
        rationale: 'the work is moot',
      }),
    ).rejects.toThrow('plans:set-status: unexpected_status: current status is shipped');
  });

  it('retractStandingFact calls facts:retract with the exact projected coordinates', async () => {
    const { terminalDependencies } = await import('./bulk-run');
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const deps = terminalDependencies({
      call: (async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { ok: true };
      }) as never,
    });

    await deps.retractStandingFact({
      scope: 'harness',
      scopeRef: 'papercusp',
      key: 'wall:voice-credential',
      reason: 'credential installed',
    });
    expect(calls).toEqual([
      {
        name: 'facts:retract',
        args: {
          scope: 'harness',
          scopeRef: 'papercusp',
          key: 'wall:voice-credential',
          reason: 'credential installed',
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// observation-candidate-acceptance-promotion-2026-09-30 P-004 — intake inputs
// in a saved bulk run (BARs R-3, R-18, R-19).
// ---------------------------------------------------------------------------

const intakeItem = {
  ...item,
  itemId: 'obs-1',
  position: 1,
  kind: 'improvement',
  title: 'Observation: gate flaked twice',
  ref: { kind: 'improvement', id: 'EI-1' },
  ownerAgentId: null,
};

type WrittenOutcome = {
  itemId: string;
  outcome: string;
  disposition: string | null;
  recommendationKind: string | null;
  responsibility: string | null;
  retryCondition: string | null;
  rationale: string | null;
  intakeDecision: Record<string, unknown> | null;
};

function written(): WrittenOutcome[] {
  return h.reportOutcomes.mock.calls.flatMap((call) => (call[0] as { outcomes: WrittenOutcome[] }).outcomes);
}

async function reportIntake(items: Record<string, unknown>[]) {
  return body(
    await bulkRunReport.handler({ runId: run.runId, items } as never, { workspaceId: run.workspaceId } as never),
  );
}

describe('P-004 intake: the manifest offers six typed dispositions (R-3)', () => {
  it('attaches the six-way offer to intake inputs only, each requiring a reason', async () => {
    h.getRunItems.mockResolvedValue([item, intakeItem]);
    const result = body(
      await bulkRunManifest.handler({ runId: run.runId }, { workspaceId: run.workspaceId } as never),
    );
    const items = result.items as Array<Record<string, unknown>>;
    const intake = items.find((row) => row.itemId === intakeItem.itemId)!.intake as {
      dispositions: { disposition: string; requires: string[] }[];
      decision: unknown;
    };
    expect(intake.dispositions.map((d) => d.disposition)).toEqual([
      'promote',
      'merge',
      'investigate',
      'retain',
      'reject',
      'retry',
    ]);
    expect(intake.dispositions.every((d) => d.requires.includes('reason'))).toBe(true);
    expect(intake.dispositions.find((d) => d.disposition === 'merge')!.requires).toContain('targetRef');
    expect(intake.dispositions.find((d) => d.disposition === 'retry')!.requires).toContain('missingInformation');
    expect(intake.decision).toBeNull();
    expect(items.find((row) => row.itemId === item.itemId)).not.toHaveProperty('intake');
  });

  it('refuses a reject without a reason and writes nothing for it', async () => {
    h.getRunItems.mockResolvedValue([intakeItem]);
    const result = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'high',
        intakeDecision: { disposition: 'reject' },
      },
    ]);
    expect(JSON.stringify(result)).toContain('requires a non-blank reason');
    expect(h.reportOutcomes).not.toHaveBeenCalled();
  });

  it('accepts a reject with a reason', async () => {
    h.getRunItems.mockResolvedValue([intakeItem]);
    await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'high',
        intakeDecision: { disposition: 'reject', reason: 'Duplicate of an already-fixed gate flake.' },
      },
    ]);
    expect(written()).toEqual([
      expect.objectContaining({
        itemId: intakeItem.itemId,
        intakeDecision: expect.objectContaining({
          disposition: 'reject',
          reason: 'Duplicate of an already-fixed gate flake.',
        }),
      }),
    ]);
  });
});

describe('P-004 intake: every report carries an attributable decision or an actionable failure (R-18)', () => {
  beforeEach(() => {
    h.getRunItems.mockResolvedValue([item, intakeItem]);
  });

  it('persists the decision with its decider, owner and the projected recommendation columns', async () => {
    await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'medium',
        intakeDecision: { disposition: 'retry', reason: 'Cannot tell which gate.', missingInformation: 'the run id' },
      },
    ]);
    const [row] = written();
    expect(row).toMatchObject({
      itemId: intakeItem.itemId,
      outcome: 'recommended',
      disposition: 'retry_needed',
      recommendationKind: 'retry_needed',
      responsibility: 'agent',
      retryCondition: 'the run id',
      rationale: 'Cannot tell which gate.',
    });
    expect(row.intakeDecision).toMatchObject({
      disposition: 'retry',
      decidedBy: 'su-resolver',
      owner: 'agent',
      missingInformation: 'the run id',
    });
    expect(typeof row.intakeDecision!.decidedAt).toBe('string');
  });

  it('refuses an intake report that carries no intake decision, and refuses skipping one', async () => {
    const result = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        recommendationKind: 'investigate',
        recommendationLabel: 'Look into it',
        rationale: 'Unclear.',
        responsibility: 'agent',
        confidenceLevel: 'low',
      },
    ]);
    expect(JSON.stringify(result)).toContain('is an intake input');
    const skipped = await reportIntake([{ itemId: intakeItem.itemId, outcome: 'skipped', error: 'not now' }]);
    expect(JSON.stringify(skipped)).toContain('is an intake input');
    expect(h.reportOutcomes).not.toHaveBeenCalled();
  });

  it('accepts an explicit failure with its error as the actionable outcome', async () => {
    await reportIntake([
      { itemId: intakeItem.itemId, outcome: 'failed', error: 'Evidence link 404s; re-capture needed.' },
    ]);
    expect(written()).toEqual([
      expect.objectContaining({ itemId: intakeItem.itemId, outcome: 'failed', intakeDecision: null }),
    ]);
  });

  it('refuses merge without a target, missing confidence, contradictory kinds, and decisions on non-intake rows', async () => {
    const result = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'high',
        intakeDecision: { disposition: 'merge', reason: 'Same root cause.' },
      },
    ]);
    expect(JSON.stringify(result)).toContain('requires targetRef');
    const noConfidence = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        intakeDecision: { disposition: 'promote', reason: 'Real defect with a repro.' },
      },
    ]);
    expect(JSON.stringify(noConfidence)).toContain('needs confidenceLevel');
    const contradicts = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'high',
        recommendationKind: 'investigate',
        recommendationLabel: 'x',
        responsibility: 'agent',
        rationale: 'x',
        intakeDecision: { disposition: 'promote', reason: 'Real defect with a repro.' },
      },
    ]);
    expect(JSON.stringify(contradicts)).toContain('contradicts intake disposition');
    const nonIntake = await reportIntake([
      {
        itemId: item.itemId,
        outcome: 'recommended',
        confidenceLevel: 'high',
        intakeDecision: { disposition: 'promote', reason: 'n/a' },
      },
    ]);
    expect(JSON.stringify(nonIntake)).toContain('only valid for intake inputs');
    expect(h.reportOutcomes).not.toHaveBeenCalled();
  });
});

describe('P-004 intake: unresolved rows stay visible and resumable (R-19)', () => {
  it('writes the decided rows of a mixed batch and leaves the refused row for the next pass', async () => {
    const second = { ...intakeItem, itemId: 'obs-2', position: 2 };
    h.getRunItems.mockResolvedValue([intakeItem, second]);
    const result = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'high',
        intakeDecision: { disposition: 'promote', reason: 'Reproduced on staging.' },
      },
      { itemId: second.itemId, outcome: 'recommended', confidenceLevel: 'high', intakeDecision: { disposition: 'retry' } },
    ]);
    expect(written().map((row) => row.itemId)).toEqual([intakeItem.itemId]);
    expect(JSON.stringify(result)).toContain(second.itemId);
  });

  it('a resumed manifest shows only pending rows, and includeReported shows prior decisions and failures', async () => {
    const decision = {
      disposition: 'promote',
      reason: 'Reproduced on staging.',
      decidedBy: 'su-earlier',
      owner: 'engineering',
      targetRef: null,
      missingInformation: null,
      decidedAt: '2026-10-01T10:00:00.000Z',
    };
    const decided = { ...intakeItem, outcome: 'recommended', intakeDecision: decision };
    const failed = { ...intakeItem, itemId: 'obs-3', position: 3, outcome: 'failed', intakeDecision: null };
    const pending = { ...intakeItem, itemId: 'obs-2', position: 2 };
    h.getRunItems.mockResolvedValue([decided, pending, failed]);

    const resumed = body(await bulkRunManifest.handler({ runId: run.runId }, { workspaceId: run.workspaceId } as never));
    expect((resumed.items as Array<{ itemId: string }>).map((row) => row.itemId)).toEqual(['obs-2']);
    expect(resumed.remaining).toBe(1);

    const all = body(
      await bulkRunManifest.handler({ runId: run.runId, includeReported: true }, {
        workspaceId: run.workspaceId,
      } as never),
    );
    const rows = all.items as Array<{ itemId: string; outcome: string; intake: { decision: unknown } }>;
    expect(rows.find((row) => row.itemId === 'obs-1')!.intake.decision).toEqual(decision);
    expect(rows.find((row) => row.itemId === 'obs-3')!.outcome).toBe('failed');
  });
});

// P-008 (R-7, D-020): an intake-triage run's rows are observation-lane improvements,
// which the attention feed only admits when flagged for a human. Feed membership
// therefore cannot be their liveness check: the intake executor re-reads the source
// row under its lock instead. Every other run kind keeps the feed gate.
describe('P-008 intake-triage runs: source liveness instead of feed membership (R-7)', () => {
  const decision = {
    disposition: 'retain',
    reason: 'Known flake, tracked elsewhere.',
    decidedBy: 'su-resolver',
    owner: 'system',
    targetRef: null,
    missingInformation: null,
    decidedAt: '2026-10-01T16:00:00.000Z',
    workKind: null,
    acceptance: null,
    sourceRevision: 'src-v1:abc',
  };
  const triageRow = {
    ...intakeItem,
    itemId: 'improvement:EI-7',
    ref: { kind: 'improvement', issueId: 'EI-7', harnessSlug: 'papercusp' },
    outcome: 'recommended',
    intakeDecision: decision,
  };

  function arrange(runKind: string) {
    const kindRun = { ...run, runKind };
    h.getRun.mockResolvedValue(kindRun);
    h.recordRunHeartbeat.mockResolvedValue(kindRun);
    h.getRunItems.mockResolvedValue([triageRow]);
    // The feed does not carry the observation at all.
    h.callPlansRead.mockResolvedValue({ groups: [] });
    h.readStandingBulkAutomationPolicy.mockResolvedValue({ level: 'L2', minConfidence: 'low' });
    h.executeBulkRunAction.mockImplementation(async (input: ExecuteInput) => ({
      actionResult: await input.execute(),
      item: { ...triageRow, outcome: 'auto_resolved', actionId: input.actionId, rationale: input.rationale },
      run: { ...kindRun, autoResolved: 1 },
      refused: null,
    }));
  }

  async function applyIntake() {
    return body(
      await bulkRunAct.handler(
        {
          runId: run.runId,
          itemId: triageRow.itemId,
          actionId: 'apply-intake',
          rationale: 'Apply the recorded retain decision.',
          confidenceLevel: 'high',
        },
        { workspaceId: run.workspaceId } as never,
      ),
    );
  }

  it('applies a recorded decision on an intake-triage run without reading the feed', async () => {
    arrange('intake-triage');
    await applyIntake();
    expect(h.callPlansRead).not.toHaveBeenCalled();
    expect(h.dispatchAttentionTerminalAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'apply-intake',
        intake: { decision, runId: run.runId },
        item: expect.objectContaining({ id: triageRow.itemId, ref: expect.objectContaining({ issueId: 'EI-7' }) }),
      }),
    );
  });

  it('keeps the feed-membership gate for an Inbox run: a non-member is not applied', async () => {
    arrange('inbox-resolve');
    await applyIntake();
    expect(h.callPlansRead).toHaveBeenCalled();
    expect(h.dispatchAttentionTerminalAction).not.toHaveBeenCalled();
  });

  it('the manifest of an intake-triage run skips the feed read; an Inbox run still reads it', async () => {
    arrange('intake-triage');
    h.getRunItems.mockResolvedValue([{ ...triageRow, outcome: 'pending', intakeDecision: null }]);
    const manifest = body(await bulkRunManifest.handler({ runId: run.runId }, { workspaceId: run.workspaceId } as never));
    expect((manifest.items as Array<{ itemId: string }>).map((row) => row.itemId)).toEqual([triageRow.itemId]);
    expect(h.callPlansRead).not.toHaveBeenCalled();

    arrange('inbox-resolve');
    h.getRunItems.mockResolvedValue([{ ...triageRow, outcome: 'pending', intakeDecision: null }]);
    await bulkRunManifest.handler({ runId: run.runId }, { workspaceId: run.workspaceId } as never);
    expect(h.callPlansRead).toHaveBeenCalled();
  });
});

// P-008 (R-26, D-020 §4): an uncertain report cannot become accepted fix work. A
// low/insufficient-confidence promote is refused when REPORTED and writes nothing;
// the same uncertainty may still be recorded as an investigation or a retry.
describe('P-008 intake: uncertain promotes are refused at report time (R-26)', () => {
  beforeEach(() => {
    h.getRunItems.mockResolvedValue([intakeItem]);
  });

  it.each(['low', 'insufficient'])('refuses a %s-confidence promote and writes nothing', async (level) => {
    const result = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: level,
        intakeDecision: { disposition: 'promote', reason: 'Looks like a real defect.' },
      },
    ]);
    expect(JSON.stringify(result)).toContain('cannot become accepted work');
    expect(h.reportOutcomes).not.toHaveBeenCalled();
  });

  it('refuses the legacy low confidence field the same way', async () => {
    const result = await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidence: 'low',
        intakeDecision: { disposition: 'promote', reason: 'Looks like a real defect.' },
      },
    ]);
    expect(JSON.stringify(result)).toContain('cannot become accepted work');
    expect(h.reportOutcomes).not.toHaveBeenCalled();
  });

  it('records the same uncertainty as an investigation, and a medium-confidence promote', async () => {
    await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'low',
        intakeDecision: { disposition: 'investigate', reason: 'Cause unclear; needs a scoped probe.' },
      },
    ]);
    await reportIntake([
      {
        itemId: intakeItem.itemId,
        outcome: 'recommended',
        confidenceLevel: 'medium',
        intakeDecision: { disposition: 'promote', reason: 'Reproduced on staging.' },
      },
    ]);
    expect(written().map((row) => row.intakeDecision?.disposition)).toEqual(['investigate', 'promote']);
  });
});

// P-009 (R-31, D-019): the bulk tool's kill-switch read happens at entry, before the
// run-row lock. recheckIntakeApply re-reads the switch and the run's stop state at
// APPLICATION time, and fails closed when the flag cannot be read.
describe('terminalDependencies.recheckIntakeApply', () => {
  async function recheck() {
    const { terminalDependencies } = await import('./bulk-run');
    const deps = terminalDependencies({ call: (async () => ({ ok: true })) as never, workspaceId: 'ws-1' });
    return deps.recheckIntakeApply!({ runId: 'run-1', itemId: 'attention-1' });
  }

  it('allows application while the switch is on and the run is still running', async () => {
    expect(await recheck()).toEqual({ allowed: true });
    expect(h.getRun).toHaveBeenCalledWith('run-1', 'ws-1');
  });

  it('refuses when the kill switch was flipped after the entry check', async () => {
    h.getFlag.mockResolvedValue(false);
    const result = await recheck();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('papercusp-inbox-bulk-resolve is off');
    expect(h.getRun).not.toHaveBeenCalled();
  });

  it('fails closed when the flag backend errors', async () => {
    h.getFlag.mockRejectedValue(new Error('flag store unreachable'));
    expect((await recheck()).allowed).toBe(false);
  });

  it.each(['review', 'complete', 'failed'])('refuses when the run was stopped (phase %s)', async (phase) => {
    h.getRun.mockResolvedValue({ ...run, phase });
    const result = await recheck();
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(`is ${phase}`);
  });

  it('refuses when the run no longer exists', async () => {
    h.getRun.mockResolvedValue(null);
    expect(await recheck()).toEqual({ allowed: false, reason: 'run run-1 not found' });
  });
});
