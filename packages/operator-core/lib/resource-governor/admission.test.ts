import { describe, expect, it, vi } from 'vitest';
import {
  AdmissionAuthorizationError,
  AdmissionIdempotencyConflictError,
  AdmissionValidationError,
  AdmitImmediatelyDriver,
  Governor,
  normalizeAdmissionRequest,
} from './admission';

function deterministicGovernor(options: { bypassKeys?: Set<string> } = {}) {
  let id = 0;
  return new Governor(new AdmitImmediatelyDriver(), {
    now: () => 1_700_000_000_000,
    idFactory: () => `request-${++id}`,
    bypassKeys: options.bypassKeys,
  });
}

describe('Governor admission contract', () => {
  it('normalizes requests without introducing a capacity ceiling', () => {
    const request = normalizeAdmissionRequest({
      idempotencyKey: '  req-1  ',
      admissionClass: 'agent',
      demand: { memoryBytes: 1024, custom: { gpu: 0.5 } },
    });

    expect(request).toEqual({
      idempotencyKey: 'req-1',
      admissionClass: 'agent',
      priority: 0,
      deadlineAtMs: null,
      demand: { memoryBytes: 1024, custom: { gpu: 0.5 } },
      payloadRef: null,
      coalesceKey: null,
      parent: null,
      bypassKey: null,
      metadata: {},
    });
    expect(JSON.stringify(request)).not.toMatch(/max|ceiling|limit/i);
  });

  it('normalizes durable payload and coalescing references', () => {
    expect(
      normalizeAdmissionRequest({
        idempotencyKey: 'req-refs',
        admissionClass: 'transfer',
        payloadRef: '  work-item:WI-7  ',
        coalesceKey: '  sync:main  ',
      }),
    ).toMatchObject({ payloadRef: 'work-item:WI-7', coalesceKey: 'sync:main' });
  });

  it.each([
    [{ idempotencyKey: '', admissionClass: 'agent' }, 'idempotencyKey'],
    [{ idempotencyKey: 'x', admissionClass: '' }, 'admissionClass'],
    [{ idempotencyKey: 'x', admissionClass: 'agent', priority: Number.NaN }, 'priority'],
    [{ idempotencyKey: 'x', admissionClass: 'agent', demand: { memoryBytes: -1 } }, 'memoryBytes'],
  ])('rejects invalid request %j', (request, field) => {
    expect(() => normalizeAdmissionRequest(request)).toThrowError(AdmissionValidationError);
    expect(() => normalizeAdmissionRequest(request)).toThrow(field);
  });

  it('deduplicates concurrent retry and rejects conflicting idempotency reuse', async () => {
    const driver = new AdmitImmediatelyDriver();
    const admit = vi.spyOn(driver, 'admit');
    const governor = new Governor(driver, { idFactory: () => 'request-1', now: () => 10 });

    const input = { idempotencyKey: 'same', admissionClass: 'mcp' } as const;
    const [first, retry] = await Promise.all([governor.admit(input), governor.admit(input)]);
    expect(retry).toBe(first);
    expect(admit).toHaveBeenCalledTimes(1);

    await expect(governor.admit({ ...input, priority: 2 })).rejects.toBeInstanceOf(AdmissionIdempotencyConflictError);
  });

  it('propagates lineage while charging only child incremental demand', async () => {
    const governor = deterministicGovernor();
    const root = await governor.admit({
      idempotencyKey: 'root',
      admissionClass: 'agent',
      demand: { memoryBytes: 4_000 },
    });
    expect(root.kind).toBe('admitted');
    if (root.kind !== 'admitted') throw new Error('unreachable');

    const child = await governor.admit({
      idempotencyKey: 'child',
      admissionClass: 'inference',
      parent: root.context,
      demand: { providerRequests: 1 },
    });
    expect(child.context).toMatchObject({
      requestId: 'request-2',
      rootRequestId: 'request-1',
      parentRequestId: 'request-1',
      depth: 1,
      demand: { providerRequests: 1 },
    });
  });

  it('deduplicates agent retries with a fresh goal observation and retains the first snapshot', async () => {
    const driver = new AdmitImmediatelyDriver();
    const admit = vi.spyOn(driver, 'admit');
    const governor = new Governor(driver);
    const input = {
      idempotencyKey: 'observed-agent', admissionClass: 'agent',
      metadata: { goalId: 'goal', fleetSlug: 'fleet', targetOwnerId: 'target', goalReservation: true,
        goalAdmission: JSON.stringify({ measuredAt: 'first', headcount: 1 }) },
    };
    const [first, retry] = await Promise.all([
      governor.admit(input),
      governor.admit({ ...input, metadata: { ...input.metadata,
        goalAdmission: JSON.stringify({ measuredAt: 'retry', headcount: 2 }) } }),
    ]);
    expect(retry).toBe(first);
    expect(retry.context.metadata?.goalAdmission).toBe(input.metadata.goalAdmission);
    expect(admit).toHaveBeenCalledOnce();
    for (const [field, value] of Object.entries({ goalId: 'other-goal', fleetSlug: 'other-fleet',
      targetOwnerId: 'other-target', goalReservation: false })) {
      await expect(governor.admit({ ...input, metadata: { ...input.metadata, [field]: value } }))
        .rejects.toBeInstanceOf(AdmissionIdempotencyConflictError);
    }
  });

  it('fails closed for an unregistered bypass and permits a registered one', async () => {
    const governor = deterministicGovernor({ bypassKeys: new Set(['control.health']) });

    await expect(
      governor.admit({ idempotencyKey: 'bad', admissionClass: 'control', bypassKey: 'caller.defined' }),
    ).rejects.toBeInstanceOf(AdmissionAuthorizationError);

    await expect(
      governor.admit({ idempotencyKey: 'good', admissionClass: 'control', bypassKey: 'control.health' }),
    ).resolves.toMatchObject({ kind: 'bypass', bypassKey: 'control.health' });
  });

  it('makes cancellation and release idempotent', async () => {
    const governor = deterministicGovernor();
    const admitted = await governor.admit({ idempotencyKey: 'request', admissionClass: 'process' });

    expect(await governor.cancel('request')).toMatchObject({ cancelled: true, state: 'cancelled' });
    expect(await governor.cancel('request')).toMatchObject({ cancelled: false, state: 'cancelled' });
    expect(await governor.release(admitted.context)).toEqual({ requestId: 'request-1', released: true });
    expect(await governor.release(admitted.context)).toEqual({ requestId: 'request-1', released: false });
  });
});
