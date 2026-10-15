import { describe, expect, it } from 'vitest';

import {
  buildRedLegsAtR1,
  decideKnownGoodFreezeCut,
  formatFreezeCutLine,
  redLegsOfRound,
  R1_SUITE_LEG,
  R1_UNATTRIBUTED_LEG,
  type FreezeCutInput,
} from './known-good-freeze';

// A linear staging history: MAIN <- A <- KG <- B <- TIP, plus an unrelated OFF commit.
const ORDER = ['main', 'a', 'kg', 'b', 'tip'];
const isAncestor = async (anc: string, desc: string): Promise<boolean> => {
  const i = ORDER.indexOf(anc);
  const j = ORDER.indexOf(desc);
  return i >= 0 && j >= 0 && i <= j;
};

const input = (over: Partial<FreezeCutInput> = {}): FreezeCutInput => ({
  tip: 'tip',
  candidate: 'b',
  lastReady: 'main',
  knownGood: 'kg',
  isAncestor,
  ...over,
});

describe('decideKnownGoodFreezeCut (P-012)', () => {
  it('judges the newest per-sync-passed commit instead of the tip-side candidate', async () => {
    const cut = await decideKnownGoodFreezeCut(input());
    expect(cut).toEqual({ source: 'known-good', reason: 'known-good-selected', candidate: 'kg', tip: 'tip', knownGood: 'kg' });
  });

  it('selects a known-good commit even when it is newer than the quiet-cut pick', async () => {
    const cut = await decideKnownGoodFreezeCut(input({ candidate: 'a' }));
    expect(cut.candidate).toBe('kg');
    expect(cut.source).toBe('known-good');
  });

  it('keeps the candidate when no commit has passed the per-sync check', async () => {
    const cut = await decideKnownGoodFreezeCut(input({ knownGood: null }));
    expect(cut).toMatchObject({ source: 'staging-tip', reason: 'no-known-good', candidate: 'b' });
  });

  it('names an unreadable known-good record instead of reporting it as absent', async () => {
    const cut = await decideKnownGoodFreezeCut(input({ knownGood: null, knownGoodUnreadable: true }));
    expect(cut.reason).toBe('known-good-unreadable');
    expect(cut.candidate).toBe('b');
  });

  it('ignores a known-good commit that is not on the tip lineage', async () => {
    const cut = await decideKnownGoodFreezeCut(input({ knownGood: 'off' }));
    expect(cut).toMatchObject({ source: 'staging-tip', reason: 'known-good-not-on-tip-lineage', candidate: 'b' });
  });

  it('never re-judges or regresses the green pin: equal or behind falls back to the candidate', async () => {
    const equal = await decideKnownGoodFreezeCut(input({ knownGood: 'main' }));
    expect(equal).toMatchObject({ source: 'staging-tip', reason: 'known-good-not-ahead-of-green', candidate: 'b' });
    const behind = await decideKnownGoodFreezeCut(input({ lastReady: 'b', knownGood: 'kg' }));
    expect(behind).toMatchObject({ source: 'staging-tip', reason: 'known-good-not-ahead-of-green', candidate: 'b' });
  });

  it('accepts a known-good commit on a first promotion (no green pin yet)', async () => {
    const cut = await decideKnownGoodFreezeCut(input({ lastReady: null }));
    expect(cut.candidate).toBe('kg');
  });

  it('a reachability probe that throws reads as unusable, never as a crash', async () => {
    const cut = await decideKnownGoodFreezeCut(
      input({
        isAncestor: async () => {
          throw new Error('git unavailable');
        },
      }),
    );
    expect(cut).toMatchObject({ source: 'staging-tip', reason: 'known-good-not-on-tip-lineage', candidate: 'b' });
  });

  it('formats one greppable line', () => {
    expect(
      formatFreezeCutLine({ source: 'known-good', reason: 'known-good-selected', candidate: 'kg', tip: 'tip', knownGood: 'kg' }),
    ).toBe('GATE_FREEZE_CUT source=known-good reason=known-good-selected candidate=kg tip=tip knownGood=kg');
  });
});

describe('red legs at R1 (P-012)', () => {
  it('a green round records an EMPTY leg list, not an absent record', () => {
    expect(redLegsOfRound({ green: true, failingFiles: [], postSuiteLegs: [{ id: 'lint:tsc', status: 'passed' }] })).toEqual([]);
  });

  it('names the suite and every failed post-suite leg, once each, in order', () => {
    expect(
      redLegsOfRound({
        green: false,
        failingFiles: ['x.test.ts'],
        postSuiteLegs: [
          { id: 'lint:tsc', status: 'failed' },
          { id: 'perf', status: 'passed' },
          { id: 'desktop', status: 'skipped' },
          { id: 'lint:tsc', status: 'failed' },
        ],
      }),
    ).toEqual([R1_SUITE_LEG, 'lint:tsc']);
  });

  it('a red round with no named file or failed leg is recorded as unattributed, never as green', () => {
    expect(redLegsOfRound({ green: false, failingFiles: [] })).toEqual([R1_UNATTRIBUTED_LEG]);
  });

  it('an unmeasured round (no verdict) records nothing', () => {
    expect(redLegsOfRound({ green: null, failingFiles: ['x.test.ts'] })).toBeNull();
    expect(
      buildRedLegsAtR1(
        { source: 'known-good', reason: 'known-good-selected', candidate: 'kg', tip: 'tip', knownGood: 'kg' },
        { green: null, failingFiles: [] },
      ),
    ).toBeNull();
  });

  it('binds the R1 record to the cut candidate and its source', () => {
    expect(
      buildRedLegsAtR1(
        { source: 'staging-tip', reason: 'no-known-good', candidate: 'b', tip: 'tip', knownGood: null },
        { green: false, failingFiles: ['x.test.ts'] },
      ),
    ).toEqual({ candidate: 'b', source: 'staging-tip', legs: [R1_SUITE_LEG] });
  });
});
