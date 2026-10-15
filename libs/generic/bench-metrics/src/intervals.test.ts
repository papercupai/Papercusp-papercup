import { describe, it, expect } from 'vitest';
import { wilsonInterval, bootstrapMeanCI, meanStderr, pairedBootstrapCI, pairedRepositoryPowerPlan, mcnemarExact } from './intervals';

describe('pairedRepositoryPowerPlan', () => {
  const controls = { minimumEffect: 0.2, alpha: 0.05, power: 0.8 };

  it('recovers the analytic equal-repository bound and its rejection threshold', () => {
    const expected = 2 * (Math.sqrt(Math.log(40)) + Math.sqrt(Math.log(5))) ** 2 / 0.2 ** 2;
    const below = pairedRepositoryPowerPlan(Array(Math.floor(expected)).fill(1), controls);
    const above = pairedRepositoryPowerPlan(Array(Math.ceil(expected)).fill(1), controls);
    expect(above.requiredEffectiveRepositories).toBeCloseTo(expected, 10);
    expect(above.minimumEqualSizeRepositories).toBe(Math.ceil(expected));
    expect(below.meetsTarget).toBe(false);
    expect(below.powerLowerBound).toBeLessThan(0.8);
    expect(above.meetsTarget).toBe(true);
    expect(above.powerLowerBound).toBeGreaterThanOrEqual(0.8);
    // Under the null this exact threshold controls the two-sided tail at alpha.
    expect(2 * Math.exp(-(above.nullCriticalValue ** 2) * above.independentRepositories / 2)).toBeCloseTo(0.05, 12);
  });

  it('does not treat more correlated tasks as more independent repositories', () => {
    const oneTaskEach = pairedRepositoryPowerPlan([1, 1], controls);
    const repeated = pairedRepositoryPowerPlan([500, 500], controls);
    expect(repeated.pairedTasks).toBe(1000);
    expect(repeated.independentRepositories).toBe(2);
    expect(repeated.effectiveRepositories).toBe(2);
    expect(repeated.powerLowerBound).toBe(oneTaskEach.powerLowerBound);
    expect(repeated.detectableEffectBound).toBe(oneTaskEach.detectableEffectBound);
    expect(repeated.meetsTarget).toBe(false);
  });

  it('penalizes repository imbalance and permits an honestly insufficient single repository', () => {
    const balanced = pairedRepositoryPowerPlan([50, 50], controls);
    const imbalanced = pairedRepositoryPowerPlan([99, 1], controls);
    expect(imbalanced.effectiveRepositories).toBeLessThan(balanced.effectiveRepositories);
    expect(imbalanced.detectableEffectBound).toBeGreaterThan(balanced.detectableEffectBound);
    expect(pairedRepositoryPowerPlan([100], controls)).toMatchObject({ independentRepositories: 1, meetsTarget: false, powerLowerBound: 0 });
  });

  it('requires more information for smaller effects, stricter alpha or higher power', () => {
    const base = pairedRepositoryPowerPlan([1, 1], controls);
    for (const changed of [{ ...controls, minimumEffect: 0.1 }, { ...controls, alpha: 0.01 }, { ...controls, power: 0.9 }]) {
      expect(pairedRepositoryPowerPlan([1, 1], changed).requiredEffectiveRepositories).toBeGreaterThan(base.requiredEffectiveRepositories);
    }
    expect(pairedRepositoryPowerPlan([1, 99], controls)).toEqual(pairedRepositoryPowerPlan([99, 1], controls));
  });

  it.each([
    { sizes: [], controls }, { sizes: [0], controls }, { sizes: [1.5], controls }, { sizes: [Number.NaN], controls },
    { sizes: [Number.MAX_SAFE_INTEGER, 1], controls }, { sizes: [1], controls: { ...controls, minimumEffect: 0 } },
    { sizes: [1], controls: { ...controls, minimumEffect: 1.1 } }, { sizes: [1], controls: { ...controls, alpha: 0 } },
    { sizes: [1], controls: { ...controls, power: 1 } }, { sizes: [1], controls: { ...controls, power: Number.NaN } },
    { sizes: [1], controls: { ...controls, minimumEffect: Number.MIN_VALUE } },
  ])('refuses malformed or unrepresentable planning input %#', ({ sizes, controls: opts }) => {
    expect(() => pairedRepositoryPowerPlan(sizes, opts)).toThrow(/pairedRepositoryPowerPlan/);
  });
});

describe('wilsonInterval', () => {
  it('is centered on p̂ and symmetric for p=0.5', () => {
    const i = wilsonInterval(5, 10);
    expect(i.point).toBeCloseTo(0.5, 10);
    // Known Wilson 95% interval for 5/10 ≈ [0.2366, 0.7634]
    expect(i.lower).toBeCloseTo(0.2366, 3);
    expect(i.upper).toBeCloseTo(0.7634, 3);
  });

  it('clamps to [0,1] at the extremes', () => {
    const hi = wilsonInterval(10, 10);
    expect(hi.point).toBe(1);
    expect(hi.upper).toBeCloseTo(1, 9); // analytically 1; FP lands at 0.999…9
    expect(hi.upper).toBeLessThanOrEqual(1);
    expect(hi.lower).toBeGreaterThan(0.7);
    expect(hi.lower).toBeLessThan(1);
  });

  it('returns a degenerate interval for n=0', () => {
    expect(wilsonInterval(0, 0)).toEqual({ point: 0, lower: 0, upper: 1, ci: 0.95 });
  });

  it('validates inputs', () => {
    expect(() => wilsonInterval(11, 10)).toThrow();
    expect(() => wilsonInterval(2.5, 10)).toThrow();
  });
});

describe('meanStderr', () => {
  it('computes mean and standard error of the mean', () => {
    const r = meanStderr([2, 4, 6]);
    expect(r.mean).toBeCloseTo(4, 10);
    expect(r.stderr).toBeCloseTo(Math.sqrt(4 / 3), 10); // sample var 4, /n=3
    expect(r.n).toBe(3);
  });

  it('handles single and empty samples', () => {
    expect(meanStderr([5])).toEqual({ mean: 5, stderr: 0, n: 1 });
    expect(meanStderr([])).toEqual({ mean: 0, stderr: 0, n: 0 });
  });
});

describe('bootstrapMeanCI', () => {
  it('is deterministic given the same seed', () => {
    const v = [0, 0, 1, 1, 0, 1];
    const a = bootstrapMeanCI(v, { seed: 7, iterations: 2000 });
    const b = bootstrapMeanCI(v, { seed: 7, iterations: 2000 });
    expect(a).toEqual(b);
  });

  it('brackets the observed mean and stays in [0,1] for a 0/1 sample', () => {
    const v = [0, 0, 1, 1];
    const i = bootstrapMeanCI(v, { seed: 3, iterations: 5000 });
    expect(i.point).toBeCloseTo(0.5, 10);
    expect(i.lower).toBeGreaterThanOrEqual(0);
    expect(i.lower).toBeLessThanOrEqual(i.point);
    expect(i.upper).toBeLessThanOrEqual(1);
    expect(i.upper).toBeGreaterThanOrEqual(i.point);
  });

  it('collapses for single/empty samples', () => {
    expect(bootstrapMeanCI([0.5])).toEqual({ point: 0.5, lower: 0.5, upper: 0.5, ci: 0.95 });
    expect(bootstrapMeanCI([])).toEqual({ point: 0, lower: 0, upper: 0, ci: 0.95 });
  });
});

describe('pairedBootstrapCI', () => {
  /** Deterministic per-item difficulty + a constant shift for arm B. */
  function correlatedArms(n: number, shift: number): { a: number[]; b: number[] } {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < n; i++) {
      // Wide spread ACROSS items, so the unpaired variance is large...
      const difficulty = ((i * 37) % 100) / 100;
      a.push(difficulty);
      b.push(difficulty + shift); // ...but the per-item difference is constant.
    }
    return { a, b };
  }

  it('recovers the observed delta as the point estimate', () => {
    const { a, b } = correlatedArms(120, 0.02);
    const r = pairedBootstrapCI(a, b);
    expect(r.delta.point).toBeCloseTo(0.02, 10);
    expect(r.meanB - r.meanA).toBeCloseTo(0.02, 10);
    expect(r.n).toBe(120);
  });

  /**
   * THE property this function exists for. The arms below differ by a constant
   * 0.02 while spreading over the full [0,1] range, so an UNPAIRED interval on
   * either arm's mean is an order of magnitude wider than the effect and sees
   * nothing. Resampling pairs cancels the shared difficulty and the same data
   * resolves the shift cleanly.
   *
   * If pairedBootstrapCI ever regressed to independent resampling, this test is
   * what catches it — and nothing else here would, because the point estimate
   * would stay exactly right while the interval silently became useless.
   */
  it('EXPLOITS the pairing: resolves a shift the unpaired interval cannot see', () => {
    const { a, b } = correlatedArms(120, 0.02);
    const paired = pairedBootstrapCI(a, b);
    expect(paired.rho).toBeCloseTo(1, 6); // constant offset ⇒ perfectly correlated
    expect(paired.significant).toBe(true);
    expect(paired.halfWidth).toBeLessThan(0.001);

    // The unpaired view of the same data: each arm's own mean CI is wide and
    // hugely overlapping, so the 0.02 shift is invisible.
    const unpairedA = bootstrapMeanCI(a);
    const unpairedB = bootstrapMeanCI(b);
    expect(unpairedB.lower).toBeLessThan(unpairedA.upper); // overlapping ⇒ no verdict
    expect(unpairedA.upper - unpairedA.point).toBeGreaterThan(10 * paired.halfWidth);
  });

  it('reports a null WITH the effect it could have detected', () => {
    const { a } = correlatedArms(120, 0);
    const b = a.map((x, i) => x + (i % 2 === 0 ? 0.3 : -0.3)); // noisy, zero mean shift
    const r = pairedBootstrapCI(a, b);
    expect(r.delta.point).toBeCloseTo(0, 6);
    expect(r.significant).toBe(false);
    // A null is only interpretable next to a resolution — and 80% power always
    // demands a LARGER effect than the CI half-width alone.
    expect(r.mde80).toBeGreaterThan(r.halfWidth);
    expect(r.mde80).toBeGreaterThan(0);
  });

  it('is deterministic across runs and sensitive to the seed', () => {
    // NOTE: the per-item difference must VARY. With a constant offset every
    // resample returns the identical delta — a point-mass bootstrap where no
    // seed can move the interval, which is correct behaviour but tests nothing.
    const { a } = correlatedArms(60, 0);
    const b = a.map((x, i) => x + 0.05 + ((i * 13) % 7) / 100);
    expect(pairedBootstrapCI(a, b, { seed: 7 })).toEqual(pairedBootstrapCI(a, b, { seed: 7 }));
    expect(pairedBootstrapCI(a, b, { seed: 7 }).delta.lower).not.toBe(
      pairedBootstrapCI(a, b, { seed: 8 }).delta.lower,
    );
  });

  /**
   * The point-mass case the test above sidesteps, asserted directly: when every
   * pair shifts by exactly the same amount there is no uncertainty about the
   * delta, and the interval must collapse onto it rather than manufacture width.
   */
  it('collapses to a zero-width interval when every pair shifts identically', () => {
    const { a, b } = correlatedArms(60, 0.05);
    const r = pairedBootstrapCI(a, b);
    expect(r.delta.lower).toBeCloseTo(0.05, 10);
    expect(r.delta.upper).toBeCloseTo(0.05, 10);
    expect(r.halfWidth).toBeCloseTo(0, 10);
    expect(r.mde80).toBeCloseTo(0, 10);
    expect(r.significant).toBe(true);
  });

  it('rejects misaligned arms rather than silently comparing a prefix', () => {
    expect(() => pairedBootstrapCI([1, 2, 3], [1, 2])).toThrow(/index-aligned/);
  });

  it('degrades honestly on empty and single-pair samples', () => {
    const empty = pairedBootstrapCI([], []);
    expect(empty).toMatchObject({ n: 0, rho: 0, significant: false });
    const one = pairedBootstrapCI([0.4], [0.9]);
    expect(one.delta.point).toBeCloseTo(0.5, 10);
    expect(one.significant).toBe(false); // n=1 can never be significant
  });

  it('reports rho=0 when an arm is constant (the pairing provably bought nothing)', () => {
    const r = pairedBootstrapCI([0.5, 0.5, 0.5, 0.5], [0.1, 0.9, 0.2, 0.8]);
    expect(r.rho).toBe(0);
  });

  it('keeps correlated repository blocks together rather than treating their tasks as independent', () => {
    const a = Array(1000).fill(0.5);
    const b = a.map((_, i) => i < 500 ? 0.7 : 0.3);
    const clusterIds = a.map((_, i) => i < 500 ? 'repo-a' : 'repo-b');
    const task = pairedBootstrapCI(a, b, { seed: 17 });
    const repository = pairedBootstrapCI(a, b, { seed: 17, clusterIds });
    expect(task.halfWidth).toBeLessThan(0.02);
    expect(repository.halfWidth).toBeGreaterThan(0.19);
    expect(repository).toMatchObject({ n: 1000, independentUnits: 2, resamplingUnit: 'cluster', significant: false });
    expect(repository.delta.point).toBeCloseTo(0);
    expect(pairedBootstrapCI(a, b, { seed: 17, clusterIds })).toEqual(repository);
  });

  it('retains task weighting when repository sizes differ', () => {
    const r = pairedBootstrapCI(Array(10).fill(0), [...Array(9).fill(1), 0], {
      clusterIds: [...Array(9).fill('large'), 'small'],
    });
    expect(r.delta).toEqual({ point: 0.9, lower: 0, upper: 1, ci: 0.95 });
    expect(r.independentUnits).toBe(2);
  });

  it.each([{ clusterIds: ['repo'] }, { clusterIds: ['repo', ''] }, { clusterIds: ['repo', 'repo'] }])
    ('rejects malformed or single-cluster inference %j', ({ clusterIds }) => {
    expect(() => pairedBootstrapCI([0, 0], [1, 1], { clusterIds })).toThrow(/index-aligned|independent clusters/);
  });
});

describe('mcnemarExact', () => {
  it('matches the hand-computable exact binomial on a clean split', () => {
    // 5 discordant pairs, all favouring B: p = 2·P(X≤0 | n=5,½) = 2/32 = 0.0625
    const a = [false, false, false, false, false, true, false];
    const b = [true, true, true, true, true, true, false];
    const r = mcnemarExact(a, b);
    expect(r).toMatchObject({ onlyA: 0, onlyB: 5, concordant: 2 });
    expect(r.p).toBeCloseTo(0.0625, 10);
  });

  it('counts only DISCORDANT pairs — concordant ones carry no evidence', () => {
    const base = mcnemarExact([false, false], [true, true]);
    // Adding 500 pairs both arms agree on must not move the p-value at all.
    const padded = mcnemarExact(
      [false, false, ...Array(500).fill(true)],
      [true, true, ...Array(500).fill(true)],
    );
    expect(padded.p).toBeCloseTo(base.p, 12);
    expect(padded.concordant).toBe(500);
  });

  it('gives p=1 when the arms never disagree — a power statement, not equivalence', () => {
    const same = [true, false, true, true];
    expect(mcnemarExact(same, same)).toMatchObject({ onlyA: 0, onlyB: 0, p: 1 });
  });

  it('is symmetric in the arms', () => {
    const a = [true, false, true, false, false, true];
    const b = [false, false, true, true, true, true];
    expect(mcnemarExact(a, b).p).toBeCloseTo(mcnemarExact(b, a).p, 12);
  });

  it('stays finite for large discordant counts (log-space summation)', () => {
    // 2000 discordant pairs: the binomial coefficients overflow a naive product.
    const a = [...Array(1200).fill(true), ...Array(800).fill(false)];
    const b = [...Array(1200).fill(false), ...Array(800).fill(true)];
    const r = mcnemarExact(a, b);
    expect(Number.isFinite(r.p)).toBe(true);
    expect(r.p).toBeGreaterThan(0);
    expect(r.p).toBeLessThan(1e-10); // 1200 vs 800 is overwhelming evidence
  });

  it('never exceeds p=1 on a perfectly balanced split', () => {
    const a = [true, false, true, false];
    const b = [false, true, false, true];
    expect(mcnemarExact(a, b).p).toBeLessThanOrEqual(1);
  });

  it('rejects misaligned arms', () => {
    expect(() => mcnemarExact([true], [true, false])).toThrow(/index-aligned/);
  });
});
