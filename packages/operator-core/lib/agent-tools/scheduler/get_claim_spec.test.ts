/**
 * scheduler:get_claim_spec — arg-schema tests (EI-7678).
 *
 * The refine mirrors set_claim_spec's exactly-one-of cupId|fleet gate.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ZodTypeAny } from 'zod';
import getClaimSpecTool from './get_claim_spec';
import { fleetSpecBeeKey } from '../../scheduler/claim-spec-store';

const getClaimSpecRecord = vi.hoisted(() => vi.fn());
const latestFleetMembership = vi.hoisted(() => vi.fn());

vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/claim-spec-store')>()),
  getClaimSpecRecord: (...args: unknown[]) => getClaimSpecRecord(...args),
}));

vi.mock('../../fleet-membership-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet-membership-store')>()),
  latestFleetMembership: (...args: unknown[]) => latestFleetMembership(...args),
}));

const args = (getClaimSpecTool as { args: ZodTypeAny }).args;

describe('scheduler:get_claim_spec — args', () => {
  it('opts out of the dispatcher ambient workspace transaction', () => {
    expect((getClaimSpecTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  it('accepts cupId alone', () => {
    expect(args.safeParse({ cupId: 'su-bee-1' }).success).toBe(true);
  });

  it('rejects the literal self sentinel with an actionable handler error before reading a row', async () => {
    getClaimSpecRecord.mockClear();
    const ctx = { uiClientId: 'su-caller', isSuperuser: true, workspaceId: 'ws-1' };
    const tool = getClaimSpecTool as unknown as {
      handler: (input: unknown, context: unknown) => Promise<unknown>;
    };

    await expect(tool.handler({ cupId: 'self' }, ctx)).rejects.toMatchObject({
      code: 'invalid_claim_spec_selector',
      message: expect.stringContaining("{ cupId: 'su-caller' }"),
    });
    expect(getClaimSpecRecord).not.toHaveBeenCalled();
  });

  it('reads the exact caller owner id and preserves its fleet-inherited result', async () => {
    getClaimSpecRecord.mockResolvedValueOnce({
      source: 'fleet',
      spec: { specId: 'fleet-lane' },
      revision: 12,
      updatedBy: 'fleet-leader',
      updatedAt: '2026-10-07T00:00:00.000Z',
      harnessSlug: 'papercusp',
      fleetSlug: 'fleet-a',
    });
    const ctx = { uiClientId: 'su-caller', isSuperuser: true, workspaceId: 'ws-1' };
    const tool = getClaimSpecTool as unknown as {
      handler: (input: unknown, context: unknown) => Promise<{ data: Record<string, unknown> }>;
    };

    const result = await tool.handler({ cupId: 'su-caller' }, ctx);

    expect(getClaimSpecRecord).toHaveBeenCalledWith({ cupId: 'su-caller', workspaceId: 'ws-1' });
    expect(result.data).toMatchObject({ source: 'fleet', revision: 12, fleetSlug: 'fleet-a' });
  });

  it('accepts fleet alone', () => {
    expect(args.safeParse({ fleet: 'my-fleet' }).success).toBe(true);
  });

  it('executes a fleet selector without trimming an absent cupId', async () => {
    getClaimSpecRecord.mockReset();
    latestFleetMembership.mockReset().mockResolvedValueOnce({ fleetSlug: 'my-fleet', fleetRole: 'leader' });
    getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      spec: { specId: 'fleet-lane' },
      revision: 12,
      updatedBy: 'fleet-leader',
      updatedAt: '2026-10-07T00:00:00.000Z',
      harnessSlug: 'papercusp',
      fleetSlug: 'my-fleet',
    });
    const ctx = { uiClientId: 'su-caller', isSuperuser: true, workspaceId: 'ws-1' };
    const tool = getClaimSpecTool as unknown as {
      handler: (input: unknown, context: unknown) => Promise<{ data: Record<string, unknown> }>;
    };

    const result = await tool.handler({ fleet: 'my-fleet' }, ctx);

    expect(getClaimSpecRecord).toHaveBeenCalledWith({
      cupId: fleetSpecBeeKey('my-fleet'),
      workspaceId: 'ws-1',
    });
    expect(result.data).toMatchObject({
      source: 'fleet',
      revision: 12,
      subject: { kind: 'fleet-sentinel', fleetSlug: 'my-fleet' },
      appliesToCaller: false,
      callerEffective: { fleetRole: 'leader' },
    });
    expect(result.data.warning).toContain('you are the fleet leader');
  });

  it('reports a fleet sentinel as applicable to a caller with member role', async () => {
    getClaimSpecRecord.mockReset();
    latestFleetMembership.mockReset().mockResolvedValueOnce({ fleetSlug: 'my-fleet', fleetRole: 'member' });
    getClaimSpecRecord.mockResolvedValue({
      source: 'fleet',
      spec: { specId: 'fleet-lane' },
      revision: 12,
      updatedBy: 'fleet-leader',
      updatedAt: '2026-10-07T00:00:00.000Z',
      harnessSlug: 'papercusp',
      fleetSlug: 'my-fleet',
    });
    const ctx = { uiClientId: 'su-caller', isSuperuser: true, workspaceId: 'ws-1' };
    const tool = getClaimSpecTool as unknown as {
      handler: (input: unknown, context: unknown) => Promise<{ data: Record<string, any> }>;
    };

    const result = await tool.handler({ fleet: 'my-fleet' }, ctx);

    expect(result.data).toMatchObject({
      appliesToCaller: true,
      callerEffective: { source: 'fleet', revision: 12, fleetSlug: 'my-fleet', fleetRole: 'member' },
    });
    expect(result.data.warning).toBeUndefined();
  });

  it('rejects neither cupId nor fleet', () => {
    expect(args.safeParse({}).success).toBe(false);
  });

  it('rejects BOTH cupId and fleet (ambiguous target)', () => {
    expect(args.safeParse({ cupId: 'su-bee-1', fleet: 'my-fleet' }).success).toBe(false);
  });

  it('accepts an optional workspace override alongside cupId', () => {
    expect(args.safeParse({ cupId: 'su-bee-1', workspace: 'ws-1' }).success).toBe(true);
  });

  it('rejects generic wake-context keys instead of accepting them as selectors', () => {
    for (const key of ['harness', 'planSlug']) {
      const parsed = args.safeParse({ fleet: 'my-fleet', [key]: 'context-value' });
      expect(parsed.success, `unexpectedly accepted ${key}`).toBe(false);
    }
  });

  it('accepts a bounded history window', () => {
    expect(args.safeParse({ fleet: 'my-fleet', history: 0 }).success).toBe(true);
    expect(args.safeParse({ fleet: 'my-fleet', history: 5 }).success).toBe(true);
    expect(args.safeParse({ cupId: 'su-bee-1', history: 1 }).success).toBe(true);
  });

  it('rejects a history window outside the bound (an unbounded read of a jsonb column)', () => {
    for (const history of [-1, 21, 2.5]) {
      expect(args.safeParse({ fleet: 'my-fleet', history }).success, `accepted ${history}`).toBe(
        false,
      );
    }
  });

  it('guidance warns fleet callers about the selector-only contract', () => {
    const when = getClaimSpecTool.guidance?.when ?? '';
    expect(when).toMatch(/selector-only/i);
    expect(when).toContain('harness');
    expect(when).toContain('planSlug');
    expect(when).toMatch(/rejected/i);
  });
});
