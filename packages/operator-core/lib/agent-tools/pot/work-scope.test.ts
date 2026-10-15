import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../work-scope-policy', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-scope-policy')>(),
  readWorkScopePolicy: vi.fn(),
}));
vi.mock('../../work-scope-control', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-scope-control')>(),
  applyWorkScopeSet: vi.fn(),
  applyWorkScopeClear: vi.fn(),
}));

import { readWorkScopePolicy } from '../../work-scope-policy';
import { applyWorkScopeClear, applyWorkScopeSet } from '../../work-scope-control';
import tool from './work-scope';

const read = vi.mocked(readWorkScopePolicy);
const instant = Date.parse('2030-01-02T03:04:05Z');
const draft = { mode: 'enforce' as const, allowHarnesses: ['draft-allowed'], reason: 'Review the proposed scope' };
type Output = { content: { text: string }[] };
async function check(input: unknown) {
  const result = await tool.handler(tool.args.parse(input), { role: 'su' } as never);
  return JSON.parse((result as Output).content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  read.mockResolvedValue({ mode: 'enforce', allowHarnesses: ['stored-allowed'], reason: 'Stored policy' });
  vi.spyOn(Date, 'now').mockReturnValue(instant);
});
afterEach(() => vi.restoreAllMocks());

describe('workspace:work_scope proposed policy simulation', () => {
  it('uses an allowing draft instead of the denying live policy without reading or activating it', async () => {
    const proposedPolicy = { ...draft, allowHarnesses: ['portal'] };
    const before = structuredClone(proposedPolicy);
    expect(await check({ op: 'check', harness: 'portal', proposedPolicy })).toMatchObject({
      ok: true, simulated: true, verdict: { allowed: true, reason: 'in-scope' },
    });
    expect(proposedPolicy).toEqual(before);
    expect(read).not.toHaveBeenCalled();
    expect(applyWorkScopeSet).not.toHaveBeenCalled();
    expect(applyWorkScopeClear).not.toHaveBeenCalled();
  });

  it('explains a draft denial even when the live policy permits the subject', async () => {
    read.mockResolvedValue({ mode: 'enforce', allowHarnesses: ['portal'] });
    expect(await check({ op: 'check', harness: 'portal', proposedPolicy: draft })).toMatchObject({
      ok: true, simulated: true,
      verdict: { allowed: false, code: 'scope_denied', allowHarnesses: ['draft-allowed'], reason: draft.reason },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('simulates mode off without clearing an enforced live policy', async () => {
    expect(await check({ op: 'check', harness: 'portal', proposedPolicy: { ...draft, mode: 'off' } })).toMatchObject({
      simulated: true, verdict: { allowed: true, reason: 'mode-off' },
    });
    expect(read).not.toHaveBeenCalled();
    expect(applyWorkScopeClear).not.toHaveBeenCalled();
  });

  const axes = ['harness', 'plan', 'goal', 'workItem'] as const;
  const boundaries = [['future', 1], ['exact', 0], ['past', -1], ['indefinite', null]] as const;
  it.each(axes.flatMap((axis) => boundaries.map(([boundary, offset]) => ({ axis, boundary, offset }))))(
    '$axis draft exception at $boundary boundary uses the proposed decision', async ({ axis, offset }) => {
      const value = axis === 'harness' ? 'portal' : 'fixture-subject';
      const exception = {
        [axis]: value, reason: 'Proposed temporary grant',
        ...(offset === null ? {} : { expiresAt: new Date(instant + offset).toISOString() }),
      };
      const result = await check({
        op: 'check', harness: 'portal', [axis]: value, proposedPolicy: { ...draft, exceptions: [exception] },
      });
      expect(result.simulated).toBe(true);
      expect(result.verdict.allowed).toBe(offset === null || offset > 0);
      expect(result.verdict.allowed ? result.verdict.reason : result.verdict.code)
        .toBe(offset === null || offset > 0 ? 'exception' : 'scope_denied');
      expect(read).not.toHaveBeenCalled();
      expect(applyWorkScopeSet).not.toHaveBeenCalled();
    },
  );

  it('an expired wildcard draft cannot override a later active exception', async () => {
    const proposedPolicy = { ...draft, exceptions: [
      { harness: '*', reason: 'Expired wildcard', expiresAt: new Date(instant).toISOString() },
      { harness: 'portal', reason: 'Active grant', expiresAt: new Date(instant + 1).toISOString() },
    ] };
    expect((await check({ op: 'check', harness: 'portal', proposedPolicy })).verdict)
      .toMatchObject({ allowed: true, exception: { reason: 'Active grant' } });
    expect((await check({ op: 'check', harness: 'other', proposedPolicy })).verdict.allowed).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });

  it.each(['not-a-date', '', '2030-01-02', '2030-02-31T00:00:00Z', null, 1893456000000])(
    'real shared input validation rejects malformed draft expiry %j before a policy read', async (expiresAt) => {
      await expect(check({ op: 'check', harness: 'portal', proposedPolicy: {
        ...draft, exceptions: [{ harness: '*', reason: 'Malformed expiry', expiresAt }],
      } })).rejects.toThrow();
      expect(read).not.toHaveBeenCalled();
      expect(applyWorkScopeSet).not.toHaveBeenCalled();
      expect(applyWorkScopeClear).not.toHaveBeenCalled();
    },
  );

  it('real shared input validation rejects a selectorless draft exception', async () => {
    await expect(check({ op: 'check', harness: 'portal', proposedPolicy: {
      ...draft, exceptions: [{ reason: 'No bounded subject' }],
    } })).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  });
});

describe('workspace:work_scope stored policy check', () => {
  it('without a draft, reads and evaluates the stored policy with the existing response', async () => {
    expect(await check({ op: 'check', harness: 'stored-allowed' }))
      .toEqual({ ok: true, verdict: { allowed: true, reason: 'in-scope' } });
    expect(read).toHaveBeenCalledOnce();
    expect(applyWorkScopeSet).not.toHaveBeenCalled();
  });

  it('without a draft, preserves absent-policy behavior', async () => {
    read.mockResolvedValue(null);
    expect(await check({ op: 'check', harness: 'portal' }))
      .toEqual({ ok: true, verdict: { allowed: true, reason: 'no-policy' } });
    expect(read).toHaveBeenCalledOnce();
  });

  it('does not claim a simulated verdict when the live policy is unreadable', async () => {
    read.mockRejectedValue(new Error('policy unavailable'));
    await expect(check({ op: 'check', harness: 'portal' })).rejects.toThrow('policy unavailable');
    expect(read).toHaveBeenCalledOnce();
  });
});
