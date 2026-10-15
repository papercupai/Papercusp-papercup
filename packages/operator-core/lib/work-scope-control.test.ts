import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkScopePolicy } from './work-scope-policy';

type ControlStep = {
  apply: () => Promise<WorkScopePolicy | null>;
  verify: (stored: WorkScopePolicy | null) => Promise<{ ok: boolean; detail?: string }>;
  describe: (previous: WorkScopePolicy | null) => unknown;
};

const fixture = vi.hoisted(() => ({
  policy: {} as Record<string, unknown>,
  step: undefined as ControlStep | undefined,
  dropExceptions: false,
}));

vi.mock('./gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (step: ControlStep) => {
    fixture.step = step;
    return { outcome: 'preview' };
  }),
}));
vi.mock('./pot-control-policy', () => ({
  placementOverride: () => fixture.policy,
  readPotControlPolicy: vi.fn(async () => fixture.policy),
  refreshPotControlPolicy: vi.fn(async () => undefined),
  writePotControlPolicy: vi.fn(async (patch: Record<string, unknown>) => {
    fixture.policy = { ...fixture.policy, ...patch };
    if (fixture.dropExceptions && patch.workScope) {
      fixture.policy.workScope = { ...(patch.workScope as WorkScopePolicy), exceptions: [] };
    }
    return fixture.policy;
  }),
}));

const { applyWorkScopeSet, workScopeExceptionSchema, workScopeSetSchema } = await import('./work-scope-control');
const { readPotControlPolicy } = await import('./pot-control-policy');

beforeEach(() => {
  vi.clearAllMocks();
  fixture.policy = {};
  fixture.step = undefined;
  fixture.dropExceptions = false;
});

function step(): ControlStep {
  if (!fixture.step) throw new Error('control mutation was not registered');
  return fixture.step;
}

const base = {
  mode: 'enforce' as const,
  allowHarnesses: ['papercusp'],
  exceptions: [{ harness: 'portal', reason: 'temporary source preparation' }],
  reason: 'bounded engineering profile',
};

describe('work-scope authoring contract', () => {
  it('preserves a timezone-qualified expiry through the real shared input schema', () => {
    const expiry = '2030-01-02T03:04:05+02:00';
    expect(workScopeSetSchema.parse({ ...base, exceptions: [{ ...base.exceptions[0], expiresAt: expiry }] }))
      .toMatchObject({ exceptions: [{ expiresAt: expiry }] });
    expect(workScopeExceptionSchema.parse(base.exceptions[0])).toEqual(base.exceptions[0]);
  });

  it.each(['not-a-date', '', '2030-01-02', '2030-02-31T00:00:00Z', null, 1893456000000])(
    'rejects malformed present expiry %j', (expiresAt) => {
      expect(workScopeExceptionSchema.safeParse({ ...base.exceptions[0], expiresAt }).success).toBe(false);
    },
  );

  it('persists expiry and actor metadata in the existing mutation and audit patch', async () => {
    const expiresAt = '2030-01-02T03:04:05Z';
    await applyWorkScopeSet({ ...base, exceptions: [{ ...base.exceptions[0], expiresAt }] }, 'admin:fixture');
    const returned = await step().apply();
    expect(fixture.policy.workScope).toMatchObject({ exceptions: [{ expiresAt, setBy: 'admin:fixture' }] });
    expect(step().describe(null)).toMatchObject({ patch: { exceptions: [{ expiresAt, setBy: 'admin:fixture' }] } });
    const readsBeforeVerification = vi.mocked(readPotControlPolicy).mock.calls.length;
    expect(await step().verify(returned)).toEqual({ ok: true, detail: undefined });
    expect(readPotControlPolicy).toHaveBeenCalledTimes(readsBeforeVerification + 1);
  });

  it('accepts equivalent JSONB key order and omitted undefined optional properties', async () => {
    await applyWorkScopeSet({ ...base, exceptions: [{ ...base.exceptions[0], expiresAt: undefined }] }, 'admin:fixture');
    const returned = await step().apply();
    const jsonStored = JSON.parse(JSON.stringify(fixture.policy.workScope)) as WorkScopePolicy;
    fixture.policy.workScope = {
      ...jsonStored,
      exceptions: jsonStored.exceptions?.map((entry) => Object.fromEntries(Object.entries(entry).reverse())),
    };
    expect(await step().verify(returned)).toEqual({ ok: true, detail: undefined });
  });

  it('rejects a stored policy whose exception is lost despite a successful returned object', async () => {
    fixture.dropExceptions = true;
    await applyWorkScopeSet(base, 'admin:fixture');
    const returned = await step().apply();
    expect(returned?.exceptions).toHaveLength(1);
    expect((fixture.policy.workScope as WorkScopePolicy).exceptions).toEqual([]);
    expect(await step().verify(returned)).toMatchObject({ ok: false });
  });

  it('rejects altered stored expiry instead of trusting the returned write object', async () => {
    const expiresAt = '2030-01-02T03:04:05Z';
    await applyWorkScopeSet({ ...base, exceptions: [{ ...base.exceptions[0], expiresAt }] }, 'admin:fixture');
    const returned = await step().apply();
    const stored = fixture.policy.workScope as WorkScopePolicy;
    fixture.policy.workScope = { ...stored, exceptions: stored.exceptions?.map((entry) => ({ ...entry, expiresAt: '2099-01-01T00:00:00Z' })) };
    expect(await step().verify(returned)).toMatchObject({ ok: false });
  });

  it('an unreadable authoritative policy cannot verify the write', async () => {
    await applyWorkScopeSet(base, 'admin:fixture');
    const returned = await step().apply();
    vi.mocked(readPotControlPolicy).mockRejectedValueOnce(new Error('policy read unavailable'));
    await expect(step().verify(returned)).rejects.toThrow('policy read unavailable');
  });
});
