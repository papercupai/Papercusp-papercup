/**
 * automation-policy.test.ts — the inbox:automation-policy control tool (P-006).
 *
 * The standing policy helper and control harness are mocked independently so
 * this suite verifies the tool's role gate, patch semantics, and dry-run path
 * without requiring a live Postgres connection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../attention/automation-policy', () => ({
  readStandingBulkAutomationPolicy: vi.fn(),
  writeStandingBulkAutomationPolicy: vi.fn(),
  resetStandingBulkAutomationPolicy: vi.fn(),
}));
vi.mock('../../gateway-control/control-harness', () => ({
  runControlMutation: vi.fn(async (spec: any, opts: any = {}) => {
    const prev = await spec.capturePrev();
    if (opts.dryRun) {
      return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
    }
    const next = await spec.apply();
    const verify = spec.verify ? await spec.verify(next) : undefined;
    return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
  }),
}));

import {
  readStandingBulkAutomationPolicy,
  resetStandingBulkAutomationPolicy,
  writeStandingBulkAutomationPolicy,
} from '../../attention/automation-policy';

const readM = vi.mocked(readStandingBulkAutomationPolicy);
const resetM = vi.mocked(resetStandingBulkAutomationPolicy);
const writeM = vi.mocked(writeStandingBulkAutomationPolicy);

const tool = (await import('./automation-policy')).default;

// Accept EITHER ToolResponse shape (the ratchet's established repoint pattern):
// canonical `{ data }` today, legacy inline-JSON `content[0].text` if it ever regresses.
type Out = { data?: unknown; content?: { text: string }[] };
const body = (value: unknown) => {
  const out = value as Out;
  return 'data' in out ? out.data : JSON.parse(out.content![0]!.text);
};

beforeEach(() => {
  vi.clearAllMocks();
  readM.mockResolvedValue({ level: 'L0', minConfidence: 'high' });
  resetM.mockResolvedValue({ level: 'L0', minConfidence: 'high' });
  writeM.mockResolvedValue({ level: 'L2', minConfidence: 'medium' });
});

describe('inbox:automation-policy', () => {
  it('permits policy reads as probes while preserving write classification for every mutation', async () => {
    expect(tool.effect).toBe('write');
    expect(tool.effectForCall?.({ op: 'get' })).toBe('read');
    const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(result).toEqual({ policy: { level: 'L0', minConfidence: 'high' } });
    expect(writeM).not.toHaveBeenCalled();
    expect(resetM).not.toHaveBeenCalled();
    for (const args of [
      { op: 'set', level: 'L2' },
      { op: 'set', level: 'L2', dryRun: true },
      { op: 'reset' },
      { op: 'reset', dryRun: true },
    ] as const) {
      expect(tool.effectForCall?.(args)).toBe('write');
    }
  });

  it('persists and verifies an explicit grant for all three risk levels', async () => {
    const riskLevels = { low: 'automatic', medium: 'automatic', high: 'automatic' } as const;
    writeM.mockResolvedValue({ level: 'L0', minConfidence: 'high', riskLevels });
    const result = body(await tool.handler({ op: 'set', riskLevels } as never, { role: 'operator' } as never));
    expect(writeM).toHaveBeenCalledWith({ riskLevels });
    expect(result).toMatchObject({ applied: true, verify: { ok: true }, next: { riskLevels } });
  });

  it('rejects incomplete risk maps at the tool boundary', () => {
    expect(tool.args.safeParse({ op: 'set', riskLevels: { low: 'automatic' } }).success).toBe(false);
  });
  it('get returns the standing policy', async () => {
    const result = body(await tool.handler({ op: 'get' } as never, { role: 'su' } as never));
    expect(result).toEqual({ policy: { level: 'L0', minConfidence: 'high' } });
    expect(readM).toHaveBeenCalledWith(undefined, { strict: true });
  });

  it('surfaces an unreadable saved policy and does not allow a write using synthetic defaults', async () => {
    readM.mockRejectedValue(new Error('policy storage unavailable'));
    await expect(tool.handler({ op: 'get' } as never, { role: 'operator' } as never))
      .rejects.toThrow('policy storage unavailable');
    await expect(tool.handler({ op: 'set', minConfidence: 'medium' } as never, { role: 'operator' } as never))
      .rejects.toThrow('policy storage unavailable');
    expect(writeM).not.toHaveBeenCalled();
  });

  it('set rejects a role without operator-config write authority', async () => {
    await expect(
      tool.handler({ op: 'set', level: 'L1' } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
    expect(writeM).not.toHaveBeenCalled();
  });

  it('set requires at least one policy axis', async () => {
    await expect(
      tool.handler({ op: 'set' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/at least one/i);
  });

  it('set applies both independent axes and verifies the result', async () => {
    const result = body(
      await tool.handler(
        { op: 'set', level: 'L2', minConfidence: 'medium' } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(writeM).toHaveBeenCalledWith({ level: 'L2', minConfidence: 'medium' });
    expect(result).toMatchObject({ ok: true, applied: true, verify: { ok: true } });
  });

  it('reset writes the conservative default', async () => {
    const result = body(await tool.handler({ op: 'reset' } as never, { role: 'operator' } as never));
    expect(resetM).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, applied: true, next: { level: 'L0', minConfidence: 'high' } });
  });

  it('dryRun does not write', async () => {
    const result = body(
      await tool.handler(
        { op: 'set', minConfidence: 'low', dryRun: true } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(writeM).not.toHaveBeenCalled();
    expect(resetM).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, applied: false });
  });
});
