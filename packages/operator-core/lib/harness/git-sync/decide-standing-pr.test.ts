import { describe, expect, it } from 'vitest';
import { decideStandingPr, type StandingPrInput } from './decide-standing-pr';

const PROMOTED = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const FORK = 'https://github.com/pot-bot/repo.git';

const input = (over: Partial<StandingPrInput> = {}): StandingPrInput => ({
  integration: { mode: 'review', source: 'set' },
  forkRemote: FORK,
  promotedSha: PROMOTED,
  openPr: null,
  trigger: 'promotion',
  ...over,
});

describe('decideStandingPr (P-020 / D-007)', () => {
  it('does nothing for a pot that commits straight into its repository (set or default)', () => {
    expect(decideStandingPr(input({ integration: { mode: 'direct', source: 'set' } }))).toMatchObject({
      action: 'skip',
      reason: 'not-working-copy',
    });
    expect(decideStandingPr(input({ integration: { mode: 'direct', source: 'absent' } }))).toMatchObject({
      action: 'skip',
      reason: 'not-working-copy',
    });
  });

  it('never opens a pull request when the mode could not be read (fail closed)', () => {
    for (const source of ['error', 'malformed'] as const) {
      expect(decideStandingPr(input({ integration: { mode: 'direct', source } }))).toMatchObject({
        action: 'skip',
        reason: 'mode-unknown',
      });
    }
  });

  it('skips a working-copy pot whose fork is not configured', () => {
    expect(decideStandingPr(input({ forkRemote: undefined }))).toMatchObject({ action: 'skip', reason: 'fork-missing' });
    expect(decideStandingPr(input({ forkRemote: '  ' }))).toMatchObject({ action: 'skip', reason: 'fork-missing' });
  });

  it('skips when nothing has passed the test suite, with an on-demand message', () => {
    const d = decideStandingPr(input({ promotedSha: null, trigger: 'on-demand' }));
    expect(d).toMatchObject({ action: 'skip', reason: 'nothing-promoted' });
    expect(d.detail).toMatch(/nothing to send/);
  });

  it('opens the standing PR at exactly the promoted commit when none is open', () => {
    expect(decideStandingPr(input())).toEqual(expect.objectContaining({ action: 'open', headSha: PROMOTED }));
  });

  it('updates the open PR to the newly promoted commit', () => {
    expect(decideStandingPr(input({ openPr: { number: 7, headSha: OLD } }))).toEqual(
      expect.objectContaining({ action: 'update', prNumber: 7, fromSha: OLD, headSha: PROMOTED }),
    );
  });

  it('is a no-op when the open PR already holds the promoted commit', () => {
    expect(decideStandingPr(input({ openPr: { number: 7, headSha: PROMOTED } }))).toMatchObject({
      action: 'noop',
      reason: 'already-current',
      prNumber: 7,
    });
  });
});
