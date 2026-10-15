import { describe, it, expect, vi } from 'vitest';

// The snapshot + obligation renderers are the canonical shared ones (D-003); this suite pins
// how the wake block COMPOSES them, so they are stubbed to stable sentinels here.
vi.mock('./goal-launch-settings', () => ({
  renderGoalPortfolioBrief: vi.fn((brief: { __text?: string }) => brief.__text ?? 'GOAL PORTFOLIO SNAPSHOT — stub'),
}));
vi.mock('./agent-obligation-reader', () => ({
  readAgentObligationAgenda: vi.fn(async () => {
    throw new Error('unit tests must inject readAgenda');
  }),
  projectAgentTurnStartObligationBrief: vi.fn((agenda: { __text?: string; __n?: number }) => ({
    detailRef: 'coord:orient for the complete obligation agenda',
    projection: { text: agenda.__text ?? '', entries: Array.from({ length: agenda.__n ?? 0 }) },
  })),
}));

import {
  GOAL_HOLDER_WAKE_PORTFOLIO_MAX_CHARS,
  readGoalHolderWakeState,
  renderGoalHolderWakeState,
  type GoalHolderWakeRead,
} from './goal-holder-wake-state';

const FIRED_AT = Date.parse('2026-10-08T18:00:00.000Z');
const loop = { fireNumber: 7, intervalSec: 900, firedAtMs: FIRED_AT };

function read(over: Partial<GoalHolderWakeRead> & { portfolioText?: string; obligations?: string; n?: number } = {}) {
  const { portfolioText, obligations, n, ...rest } = over;
  return {
    goalId: 'goal-60d3a8',
    observedAt: '2026-10-08T18:00:00.500Z',
    degradedSources: [],
    portfolio: { __text: portfolioText ?? 'GOAL PORTFOLIO SNAPSHOT — assembled now' } as never,
    agenda: { __text: obligations ?? '1. send the owner report (due 18:30Z)', __n: n ?? 1 } as never,
    ...rest,
  } as GoalHolderWakeRead;
}

describe('renderGoalHolderWakeState (P-007)', () => {
  it('carries the goal snapshot, loop cadence and obligations, and names what not to re-fetch', () => {
    const text = renderGoalHolderWakeState({ read: read(), loop })!;
    expect(text).toContain('GOAL-HOLDER STATE — goal goal-60d3a8');
    expect(text).toContain('do NOT re-fetch it with loop:status / goals:get');
    expect(text).toContain('wake #7, every 900s, next fire ≈ 2026-10-08T18:15:00.000Z');
    expect(text).toContain("loop:checkpoint response's `continuation`");
    expect(text).toContain('GOAL PORTFOLIO SNAPSHOT — assembled now');
    expect(text).toContain('Obligations (top 1; coord:orient for the complete obligation agenda): 1. send the owner report');
  });

  it('is null for an owner whose read names no goal, so a non-holder wake is unchanged', () => {
    expect(renderGoalHolderWakeState({ read: read({ goalId: null }), loop })).toBeNull();
  });

  it('never claims a snapshot it does not carry: a failed portfolio read names the recovery call', () => {
    const text = renderGoalHolderWakeState({ read: read({ portfolio: null }), loop })!;
    expect(text).toContain("Goal snapshot: UNAVAILABLE at fire time — call goals:get { id: 'goal-60d3a8' } once.");
    expect(text).toContain('do NOT re-fetch it with loop:status.');
    expect(text).not.toContain('loop:status / goals:get');
  });

  it('clips an oversized snapshot with a pointer to the full read', () => {
    // A glyph no other section of the block emits, so counting it measures ONLY the
    // snapshot body that survived — the whole block also carries header, loop and
    // agenda lines, so comparing total length to the raw snapshot proves nothing.
    const glyph = '█';
    const big = glyph.repeat(GOAL_HOLDER_WAKE_PORTFOLIO_MAX_CHARS + 500);
    const text = renderGoalHolderWakeState({ read: read({ portfolioText: big }), loop })!;
    expect(text).toContain(`[clipped at ${GOAL_HOLDER_WAKE_PORTFOLIO_MAX_CHARS} of ${big.length} chars — goals:get`);
    expect(text).not.toContain(big);
    expect(text.split(glyph).length - 1).toBe(GOAL_HOLDER_WAKE_PORTFOLIO_MAX_CHARS);
  });

  it('says "none open" for an empty agenda and lists degraded sources to re-read', () => {
    const text = renderGoalHolderWakeState({
      read: read({ obligations: '', n: 0, degradedSources: ['owner-report', 'plan-placement'] }),
      loop,
    })!;
    expect(text).toContain('Obligations (top 0; coord:orient for the complete obligation agenda): none open.');
    expect(text).toContain('Degraded at fire time: owner-report, plan-placement — re-read only those.');
  });

  it('omits the next-fire estimate when the cadence is unknown', () => {
    const text = renderGoalHolderWakeState({ read: read(), loop: { ...loop, intervalSec: null } })!;
    expect(text).toContain('Loop: active — wake #7. Read the re-wake verdict');
  });
});

describe('readGoalHolderWakeState (P-007)', () => {
  const base = { workspaceId: 'papercusp-workspace', ownerId: 'su-holder', loop };

  it('renders the block from one agenda read', async () => {
    const readAgenda = vi.fn(async () => read());
    const text = await readGoalHolderWakeState({ ...base, readAgenda });
    expect(readAgenda).toHaveBeenCalledTimes(1);
    expect(readAgenda).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'papercusp-workspace', ownerId: 'su-holder' }));
    expect(text).toContain('GOAL-HOLDER STATE — goal goal-60d3a8');
  });

  it('fails soft to null on a read error', async () => {
    const readAgenda = vi.fn(async () => {
      throw new Error('pg down');
    });
    await expect(readGoalHolderWakeState({ ...base, readAgenda })).resolves.toBeNull();
  });

  it('is bounded: a read that never settles yields null at the timeout', async () => {
    const readAgenda = vi.fn(() => new Promise<GoalHolderWakeRead>(() => {}));
    await expect(readGoalHolderWakeState({ ...base, readAgenda, timeoutMs: 20 })).resolves.toBeNull();
  });
});
