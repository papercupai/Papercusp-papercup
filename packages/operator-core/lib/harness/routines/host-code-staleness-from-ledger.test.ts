/**
 * WI-1565914 — the ledger-derived host staleness decider.
 *
 * The assertions that matter here are the ones about the EMPTY and PARTIAL populations.
 * A detector that returns "no stale hosts" from a population of zero is the exact bug
 * this module was written to end, and it is invisible in the happy-path tests: the
 * healthy verdict and the vacuous one are the same shape, the same `stale: []`, and
 * differ only in whether anything was measured. So they get controls of their own.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileViaSidecarMock } = vi.hoisted(() => ({ execFileViaSidecarMock: vi.fn() }));
vi.mock('../../fleet/git-via-sidecar', () => ({ execFileViaSidecar: execFileViaSidecarMock }));

import {
  _resetCommitTimeCacheForTests,
  evaluateLedgerHostStaleness,
  hostCodeStalenessFromLedgerSweep,
  ledgerAttributionFloor,
  ledgerHostWindowSec,
  ledgerStaleCodeMaxAgeSec,
  resolveCommitTimeMs,
  type LedgerHostObservation,
} from './host-code-staleness-from-ledger';

const NOW = Date.UTC(2026, 7, 31, 7, 0, 0);
const DAY = 86_400_000;
const MAX_AGE = 2 * DAY;

const obs = (over: Partial<LedgerHostObservation> = {}): LedgerHostObservation => ({
  servingHost: 'port-3070',
  servingProcessId: 'linux:boot-1:100',
  servingBuildSha: 'aaaaaaaaaa',
  calls: 10,
  firstSeenMs: NOW - 60_000,
  lastSeenMs: NOW,
  ...over,
});

const never = () => null;
const at = (map: Record<string, number>) => (sha: string) => map[sha] ?? null;

afterEach(() => {
  _resetCommitTimeCacheForTests();
  execFileViaSidecarMock.mockReset();
});

describe('commit timestamp reads', () => {
  it('uses the governed sidecar seam and preserves cwd, env, and timeout', async () => {
    execFileViaSidecarMock.mockResolvedValue({ stdout: '123\n', stderr: '' });
    expect(await resolveCommitTimeMs('deadbeef')).toBe(123_000);
    expect(await resolveCommitTimeMs('deadbeef')).toBe(123_000);

    expect(execFileViaSidecarMock).toHaveBeenCalledTimes(1);
    expect(execFileViaSidecarMock).toHaveBeenCalledWith('git', ['show', '-s', '--format=%ct', 'deadbeef'], {
      timeoutMs: 5_000,
      subsystem: 'host-code-staleness-from-ledger',
      cwd: process.cwd(),
      env: process.env,
    });
  });
});

describe('tunables and the kill switch', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to a 3-day code-age ceiling and a 15-minute window', () => {
    delete process.env.PAPERCUSP_LEDGER_HOST_STALE_CODE_MAX_AGE_SEC;
    delete process.env.PAPERCUSP_LEDGER_HOST_WINDOW_SEC;
    expect(ledgerStaleCodeMaxAgeSec()).toBe(259_200);
    expect(ledgerHostWindowSec()).toBe(900);
  });

  it('falls back to the defaults on unparseable overrides rather than to 0 or NaN', () => {
    process.env.PAPERCUSP_LEDGER_HOST_STALE_CODE_MAX_AGE_SEC = 'not-a-number';
    process.env.PAPERCUSP_LEDGER_HOST_WINDOW_SEC = 'not-a-number';
    // A NaN ceiling would make every comparison false and silently disable detection;
    // a 0 window would measure an empty population and report it as health.
    expect(ledgerStaleCodeMaxAgeSec()).toBe(259_200);
    expect(ledgerHostWindowSec()).toBe(900);
  });

  /** The kill switch must short-circuit BEFORE any ledger read, so this is also the
   *  assertion that it needs no database. */
  it('the kill switch skips without touching Postgres', async () => {
    process.env.PAPERCUSP_LEDGER_HOST_STALE_CODE_MAX_AGE_SEC = '0';
    const r = await hostCodeStalenessFromLedgerSweep({});
    expect(r).toEqual({ outcome: 'skipped', reason: 'kill switch' });
  });

  it('a skipped sweep is never reported as healthy', async () => {
    process.env.PAPERCUSP_LEDGER_HOST_STALE_CODE_MAX_AGE_SEC = '0';
    const r = await hostCodeStalenessFromLedgerSweep({});
    expect(r.outcome).not.toBe('healthy');
    expect(r.verdict).toBeUndefined();
  });
});

describe('the population rule — a zero is unutterable from an empty population', () => {
  it('an empty window is INCONCLUSIVE, not healthy', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(false);
    expect(v.stale).toEqual([]);
    expect(v.reason).toContain('MEASURED NOTHING');
    // The distinguishing assertion: it must NOT read as an all-clear.
    expect(v.reason).not.toMatch(/no stale host/i);
  });

  /**
   * The bootstrap case, and the one that will actually occur: hosts are serving calls
   * but none has restarted onto migration-1043 code yet, so every serving_build_sha is
   * NULL. A naive scan finds no stale sha and reports health.
   */
  it('hosts present but NONE reporting a sha is INCONCLUSIVE, and names them', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [
        obs({ servingHost: 'port-3070', servingBuildSha: null }),
        obs({ servingHost: 'port-3271', servingBuildSha: null }),
      ],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(false);
    expect(v.stale).toEqual([]);
    expect(v.population).toMatchObject({ hostsSeen: 2, hostsReporting: 0, hostsSilent: 2 });
    expect(v.population.silentHosts).toEqual(['port-3070', 'port-3271']);
    expect(v.reason).toContain('NONE reported a build sha');
    expect(v.reason).not.toMatch(/no stale host/i);
  });

  it('an unresolvable tree HEAD is INCONCLUSIVE rather than "nothing differs from HEAD"', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs()],
      headSha: null,
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(false);
    expect(v.reason).toContain('MEASURED NOTHING');
  });

  /**
   * The partial case — a real measurement that must not be read as a total one. The
   * reporting subset is genuinely judgeable, so the verdict IS conclusive; what the
   * reason may never do is stay silent about the hosts it could not see.
   *
   * WI-1401990 CORRECTED THIS CASE'S NUMBERS. It was written with callsUnattributed:844
   * against 20 attributed calls — 2.3% coverage — and asserted `conclusive: true`. That
   * is the very shape this module's header calls "a confident all-clear that actually
   * means NOBODY IS REPORTING YET", and it was measured live on 2026-08-31 returning an
   * all-clear while a 152-commit-stale host served traffic. Conclusiveness at that
   * coverage now belongs to the coverage-floor block below; this case keeps the property
   * it was actually written to pin — that a conclusive verdict NAMES its remainder — and
   * so carries a remainder small enough to stay above the floor.
   */
  it('a conclusive verdict still names the unmeasured remainder', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [
        obs({ servingHost: 'port-3170', servingBuildSha: 'headsha123' }),
        obs({ servingHost: 'port-3070', servingBuildSha: null }),
      ],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
      callsUnattributed: 15,
    });
    expect(v.conclusive).toBe(true);
    expect(v.stale).toEqual([]);
    expect(v.reason).toContain('No stale host among 1 of 2 host(s)');
    expect(v.reason).toContain('NOT MEASURED');
    expect(v.reason).toContain('port-3070');
    expect(v.reason).toContain('15 call(s)');
  });

  /** Calibration: with a full population and nothing stale, there is no remainder note —
   *  otherwise the assertions above would pass even when the suffix is unconditional. */
  it('says nothing about a remainder when there is none', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'headsha123' })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(true);
    expect(v.reason).not.toContain('NOT MEASURED');
  });
});

/**
 * Falsifiability control. The population assertions above would pass just as happily
 * against a decider that never checks a population at all, if the property they encode
 * were weaker than it looks — so this pins a deliberately-wrong implementation IN the
 * test file (never a mutation of the shared tree) and proves the property actually
 * separates the two.
 */
describe('the population rule is falsifiable', () => {
  /** The shape this module exists to forbid: scan for a stale sha, and call the absence
   *  of one "healthy" — with no notion of how many hosts were measurable. */
  function naiveDecider(observations: LedgerHostObservation[], headSha: string) {
    const stale = observations.filter((o) => o.servingBuildSha && o.servingBuildSha !== headSha);
    return { conclusive: true, reason: stale.length ? `${stale.length} stale` : 'no stale host', stale };
  }

  const emptyPopulation = [
    obs({ servingHost: 'port-3070', servingBuildSha: null }),
    obs({ servingHost: 'port-3271', servingBuildSha: null }),
  ];

  it('CONTROL: the naive decider reports health from a population it could not measure', () => {
    const bad = naiveDecider(emptyPopulation, 'headsha123');
    expect(bad.conclusive).toBe(true);
    expect(bad.reason).toMatch(/no stale host/i);
    expect(bad.stale).toEqual([]);
  });

  it('SUBJECT: the real decider refuses that same input', () => {
    const good = evaluateLedgerHostStaleness({
      observations: emptyPopulation,
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(good.conclusive).toBe(false);
    expect(good.reason).not.toMatch(/no stale host/i);
  });

  /** Calibration: on a genuinely stale population BOTH agree, so the split above is the
   *  population rule doing work — not the control being broken for unrelated reasons. */
  it('CALIBRATION: both flag a genuinely stale host', () => {
    const stalePopulation = [obs({ servingBuildSha: 'oldsha0000' })];
    expect(naiveDecider(stalePopulation, 'headsha123').stale).toHaveLength(1);
    expect(
      evaluateLedgerHostStaleness({
        observations: stalePopulation,
        headSha: 'headsha123',
        commitTimeMs: at({ oldsha0000: NOW - 18 * DAY }),
        now: NOW,
        maxCodeAgeMs: MAX_AGE,
      }).stale,
    ).toHaveLength(1);
  });
});

describe('staleness by ABSOLUTE code age', () => {
  it('flags a host whose loaded code is older than the threshold', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingHost: 'port-3070', servingBuildSha: 'oldsha0000', calls: 297 })],
      headSha: 'headsha123',
      commitTimeMs: at({ oldsha0000: NOW - 18 * DAY }),
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.conclusive).toBe(true);
    expect(v.stale).toHaveLength(1);
    expect(v.stale[0]).toMatchObject({ servingHost: 'port-3070', buildSha: 'oldsha0000', calls: 297 });
    expect(v.stale[0]!.codeAgeMs).toBe(18 * DAY);
    // The magnitude the in-process check could never report: it measured hours since
    // boot, which tops out long before an 18-day-old binary becomes visible.
    expect(v.reason).toContain('18.0 days old');
  });

  it('does not flag a host running recent code that merely differs from HEAD', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'recentsha1' })],
      headSha: 'headsha123',
      commitTimeMs: at({ recentsha1: NOW - 60_000 }),
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale).toEqual([]);
  });

  it('treats a sha equal to HEAD as fresh without needing its commit time', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'headsha123' })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale).toEqual([]);
  });

  it('matches a short sha against a full HEAD (and the reverse)', () => {
    for (const [loaded, head] of [
      ['f488ad47df', 'f488ad47df0011223344556677889900aabbccdd'],
      ['f488ad47df0011223344556677889900aabbccdd', 'f488ad47df'],
    ]) {
      const v = evaluateLedgerHostStaleness({
        observations: [obs({ servingBuildSha: loaded })],
        headSha: head,
        commitTimeMs: never,
        now: NOW,
        maxCodeAgeMs: MAX_AGE,
      });
      expect(v.stale, `${loaded} vs ${head}`).toEqual([]);
    }
  });

  /**
   * A differing sha whose age cannot be established must still be REPORTED. Dropping it
   * would let an unresolvable commit pass as fresh — an absence of evidence rendered as
   * evidence of health, which is this lane's whole failure mode.
   */
  it('reports a differing sha with an unresolvable commit time rather than passing it', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingBuildSha: 'ghostsha00' })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale).toHaveLength(1);
    expect(v.stale[0]!.codeAgeMs).toBeNull();
    expect(v.reason).toContain('an unresolvable age');
  });

  it('ranks the oldest host first', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [
        obs({ servingHost: 'port-3170', servingBuildSha: 'mid0000000' }),
        obs({ servingHost: 'port-3070', servingBuildSha: 'ancient000' }),
      ],
      headSha: 'headsha123',
      commitTimeMs: at({ mid0000000: NOW - 5 * DAY, ancient000: NOW - 18 * DAY }),
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
    });
    expect(v.stale.map((s) => s.servingHost)).toEqual(['port-3070', 'port-3170']);
  });
});

/**
 * WI-1401990: the population rule guarded absolute zero but not NEAR-zero, so a
 * handful of attributed calls beside a window of unattributed ones produced a
 * confident all-clear. Measured live 2026-08-31T09:00Z: 4 attributed vs 1,686
 * unattributed calls returned `conclusive: true, stale: []` while :3270 was live
 * 152 commits behind HEAD.
 */
describe('an all-clear needs COVERAGE, not just a non-empty sample', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  /** The exact live shape that produced the false all-clear. */
  it('refuses to call a no-stale answer conclusive when the window is mostly unattributed', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingHost: 'port-3170', servingBuildSha: 'headsha123', calls: 4 })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
      callsUnattributed: 1686,
    });
    expect(v.stale).toEqual([]);
    expect(v.conclusive).toBe(false);
    expect(v.reason).toContain('MEASURED TOO LITTLE');
    // The remainder must stay visible next to the refusal, not replace it.
    expect(v.reason).toContain('1686');
    expect(v.population.callsAttributed).toBe(4);
  });

  /** Anti-regression control: the fix must not turn every all-clear inconclusive. */
  it('still calls a no-stale answer conclusive when coverage is good', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingHost: 'port-3170', servingBuildSha: 'headsha123', calls: 900 })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
      callsUnattributed: 100,
    });
    expect(v.stale).toEqual([]);
    expect(v.conclusive).toBe(true);
    expect(v.reason).toContain('No stale host');
  });

  /**
   * The asymmetry is the point: low coverage may not manufacture an all-clear, but it
   * also may not SUPPRESS a real finding. "This host is stale" is an existence claim
   * that a small sample establishes and a large unmeasured remainder cannot falsify.
   */
  it('keeps a POSITIVE stale finding conclusive even at the same low coverage', () => {
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingHost: 'port-3270', servingBuildSha: 'oldsha0000', calls: 4 })],
      headSha: 'headsha123',
      commitTimeMs: at({ oldsha0000: NOW - 9 * DAY }),
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
      callsUnattributed: 1686,
    });
    expect(v.conclusive).toBe(true);
    expect(v.stale.map((s) => s.servingHost)).toEqual(['port-3270']);
  });

  it('the floor kill switch (<=0) restores the pre-fix behaviour', () => {
    process.env.PAPERCUSP_LEDGER_ATTRIBUTION_FLOOR = '0';
    const v = evaluateLedgerHostStaleness({
      observations: [obs({ servingHost: 'port-3170', servingBuildSha: 'headsha123', calls: 4 })],
      headSha: 'headsha123',
      commitTimeMs: never,
      now: NOW,
      maxCodeAgeMs: MAX_AGE,
      callsUnattributed: 1686,
    });
    expect(v.conclusive).toBe(true);
  });

  it('defaults to a 50% floor and falls back to it on an unparseable override', () => {
    delete process.env.PAPERCUSP_LEDGER_ATTRIBUTION_FLOOR;
    expect(ledgerAttributionFloor()).toBe(0.5);
    // A NaN floor would make `coverage < floor` false and silently re-enable the bug.
    process.env.PAPERCUSP_LEDGER_ATTRIBUTION_FLOOR = 'not-a-number';
    expect(ledgerAttributionFloor()).toBe(0.5);
  });
});
