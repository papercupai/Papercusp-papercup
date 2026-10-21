import { describe, expect, it } from 'vitest';
import { reachabilityAdvice } from './await-inbox';
import type { WakeReachabilityVerdict } from '../../../events/await/wake-reachability';

const reachable: WakeReachabilityVerdict = {
  reachable: true,
  channel: 'psu-socket',
  durableWhileAlive: true,
  summary: 'reachable through the live psu socket',
  awaitRepairable: false,
  wouldBeChannel: 'psu-socket',
};

describe('coord:await-inbox reachability advice', () => {
  it('distinguishes a reachable standing watch from a guaranteed timed wake', () => {
    const advice = reachabilityAdvice(reachable, reachable);

    expect(advice).toContain('unbounded standing watch');
    expect(advice).toContain('not a guaranteed timed wake');
    expect(advice).toContain('unfinished work in an autonomy mode and have neither an armed loop nor a guaranteed wake');
    expect(advice).toContain('bounded events:await');
    expect(advice).toContain('complete the work, or release it');
    expect(advice).not.toContain('END YOUR TURN; a coord:send');
  });

  it('keeps the same caveat when refreshing repairs an unreachable watch', () => {
    const advice = reachabilityAdvice(null, reachable);

    expect(advice).toContain('now wake-reachable via psu-socket');
    expect(advice).toContain('not a guaranteed timed wake');
    expect(advice).toContain('If no unfinished work remains or a guaranteed wake is active, END YOUR TURN.');
  });

  it('does not claim that unknown reachability is safe for held autonomous work', () => {
    const advice = reachabilityAdvice(null, null);

    expect(advice).toContain('could not be measured');
    expect(advice).toContain('do not end yet');
    expect(advice).toContain('If no unfinished work remains or a loop/guaranteed wake exists, END YOUR TURN.');
  });
});
