import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  continueReleasedOperation,
  readReleasedOperationContinuationEligibility,
  type ReleasedOperationContinuationDeps,
} from './continue-released-operation';

const readBindingMock = vi.hoisted(() => vi.fn());
const eligibilitySqlMock = vi.hoisted(() => vi.fn());
const eligibilityUnsafeMock = vi.hoisted(() => vi.fn((text: string) => ({ unsafe: text })));
const eligibilityJsonMock = vi.hoisted(() => vi.fn((value: unknown) => ({ json: value })));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: Object.assign(eligibilitySqlMock, {
    unsafe: eligibilityUnsafeMock, json: eligibilityJsonMock,
  }) }),
}));
vi.mock('../../blueprint/operation-worker-binding', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readActiveOperationWorkerClaimBinding: (...args: unknown[]) => readBindingMock(...args),
}));

const OWNER = 'role-operation-1';
const WORKSPACE = 'workspace-a';
const INPUT = {
  prompt: 'Please continue as an engineer and fix the routing bug.',
  sourceTurnRef: 'native-1:turn-7:' + 'a'.repeat(64),
  sessionRef: 'native-1',
  directiveId: 17,
};
const BINDING = {
  workItemId: 'WI-1', harnessSlug: 'papercusp', storageHarnessSlug: 'papercusp',
  operationId: 'op-1', specificationRevision: 'b'.repeat(64), pin: {}, identity: {},
  stack: ['domain:worker'], requiredTools: ['work_items:complete'],
} as never;
const BOUND_READ = {
  status: 'bound' as const,
  binding: BINDING,
  receipt: {
    sessionId: 91, workspaceId: WORKSPACE, ownerId: OWNER,
    specificationRevision: 'b'.repeat(64), stateRevision: 'c'.repeat(64),
    acceptedOperation: {},
  },
};

let directiveRows: Array<{ id: number }>;
let claimRows: Array<{ ok: number }>;

beforeEach(() => {
  directiveRows = [{ id: INPUT.directiveId }];
  claimRows = [];
  readBindingMock.mockReset().mockResolvedValue(BOUND_READ);
  eligibilityUnsafeMock.mockClear();
  eligibilityJsonMock.mockClear();
  eligibilitySqlMock.mockReset().mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('harness_shared.owner_directives')) {
        const exact = [INPUT.directiveId, WORKSPACE, OWNER, INPUT.sessionRef,
          INPUT.sourceTurnRef, INPUT.prompt].every(value => values.includes(value));
        return Promise.resolve(exact ? directiveRows : []);
      }
      if (query.includes('FROM harness_shared.work_items')) return Promise.resolve(claimRows);
      return { fragment: query, values };
    },
  );
});

function ctx(origin: 'hook' | 'agent' = 'hook') {
  return {
    workspaceId: WORKSPACE,
    uiClientId: OWNER,
    isSuperuser: true,
    requestOrigin: { transport: 'mcp', query: { origin } },
  } as never;
}

function deps(status: 'eligible' | 'active' | 'unavailable' = 'eligible') {
  const readEligibility = vi.fn(async () => status === 'eligible'
    ? { status: 'eligible' as const, binding: BINDING }
    : status === 'active'
      ? { status: 'ineligible' as const, reason: 'claim still active' }
      : { status: 'unavailable' as const, reason: 'database unavailable' });
  const launch = vi.fn(async () => ({
    content: [{ type: 'text' as const, text: 'launched' }],
    data: {
      deduped: false,
      launch: { opened: 1, ownerIds: ['su-engineering-continuation'], tasks: [{ taskId: 'task-1' }] },
      completionReceipt: { status: 'recorded', effectRef: 'agent-launch:released-operation-engineering' },
    },
  }));
  return { readEligibility, launch } as unknown as ReleasedOperationContinuationDeps & {
    readEligibility: typeof readEligibility; launch: typeof launch;
  };
}

describe('sessions:continue-released-operation', () => {
  describe('durable continuation eligibility', () => {
    it('accepts only the exact hook-captured directive after the operation claim is released', async () => {
      await expect(readReleasedOperationContinuationEligibility({
        workspaceId: WORKSPACE, ownerId: OWNER, ...INPUT,
      })).resolves.toEqual({ status: 'eligible', binding: BINDING });
      expect(readBindingMock).toHaveBeenCalledWith(WORKSPACE, OWNER);
      expect(eligibilityUnsafeMock).toHaveBeenCalledWith('wi.taken_by');
    });

    it.each([
      ['prompt', { prompt: INPUT.prompt + ' altered' }],
      ['source turn', { sourceTurnRef: INPUT.sourceTurnRef + '-other' }],
      ['session', { sessionRef: INPUT.sessionRef + '-other' }],
      ['directive id', { directiveId: INPUT.directiveId + 1 }],
    ])('rejects a mismatched stored %s', async (_label, changed) => {
      await expect(readReleasedOperationContinuationEligibility({
        workspaceId: WORKSPACE, ownerId: OWNER, ...INPUT, ...changed,
      })).resolves.toEqual({
        status: 'ineligible', reason: 'no exact hook-captured owner directive backs this continuation',
      });
    });

    it('rejects continuation while the exact accepted-operation effect claim is still held', async () => {
      claimRows = [{ ok: 1 }];
      await expect(readReleasedOperationContinuationEligibility({
        workspaceId: WORKSPACE, ownerId: OWNER, ...INPUT,
      })).resolves.toEqual({
        status: 'ineligible', reason: 'the accepted operation still holds its exact effect claim',
      });
    });

    it.each([
      [{ status: 'none' }, 'the current session has no applied accepted-operation receipt'],
      [{ status: 'unavailable', reason: 'receipt store unavailable' }, 'receipt store unavailable'],
    ] as const)('fails closed for unreadable or absent operation authority', async (bindingRead, reason) => {
      readBindingMock.mockResolvedValueOnce(bindingRead);
      await expect(readReleasedOperationContinuationEligibility({
        workspaceId: WORKSPACE, ownerId: OWNER, ...INPUT,
      })).resolves.toEqual({
        status: bindingRead.status === 'unavailable' ? 'unavailable' : 'ineligible', reason,
      });
      expect(eligibilitySqlMock).not.toHaveBeenCalled();
    });
  });

  it('refuses a model-originated call before reading operation state', async () => {
    const d = deps();
    const result = await continueReleasedOperation(INPUT, ctx('agent'), d);
    expect(result).toMatchObject({ data: { ok: false, launched: false, error: 'hook_origin_required' } });
    expect(d.readEligibility).not.toHaveBeenCalled();
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('keeps an active operation claim on the old restricted assignment', async () => {
    const d = deps('active');
    const result = await continueReleasedOperation(INPUT, ctx(), d);
    expect(result).toMatchObject({ data: { ok: true, launched: false, status: 'ineligible' } });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('fails closed when durable authority cannot be read', async () => {
    const d = deps('unavailable');
    const result = await continueReleasedOperation(INPUT, ctx(), d);
    expect(result).toMatchObject({ data: { ok: false, launched: false, status: 'unavailable' } });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('launches a distinct base-SU assignment with the exact owner prompt', async () => {
    const d = deps();
    const result = await continueReleasedOperation(INPUT, ctx(), d);
    expect(d.readEligibility).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      ownerId: OWNER,
      prompt: INPUT.prompt,
      sourceTurnRef: INPUT.sourceTurnRef,
      sessionRef: INPUT.sessionRef,
      directiveId: INPUT.directiveId,
    });
    expect(d.launch).toHaveBeenCalledWith(expect.objectContaining({
      brief: INPUT.prompt,
      harness: 'papercusp',
      independent: true,
      headless: false,
      label: 'Engineering continuation',
      idempotencyKey: expect.stringMatching(/^released-operation-engineering:[a-f0-9]{64}$/),
    }), expect.anything());
    expect(result).toMatchObject({ data: {
      ok: true,
      launched: true,
      assignmentRef: expect.stringMatching(/^released-operation-engineering:[a-f0-9]{64}$/),
      launch: {
        opened: 1,
        ownerIds: ['su-engineering-continuation'],
        tasks: [{ taskId: 'task-1' }],
      },
      completionReceipt: {
        status: 'recorded',
        effectRef: 'agent-launch:released-operation-engineering',
      },
    } });
  });

  it('derives a stable retry key from the exact owner turn and changes it for a new turn', async () => {
    const d = deps();
    await continueReleasedOperation(INPUT, ctx(), d);
    await continueReleasedOperation(INPUT, ctx(), d);
    await continueReleasedOperation({ ...INPUT, sourceTurnRef: INPUT.sourceTurnRef + '-next' }, ctx(), d);
    const calls = (d.launch as unknown as { mock: { calls: Array<[Record<string, unknown>, unknown]> } }).mock.calls;
    const keys = calls.map(([args]) => String(args.idempotencyKey));
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});
