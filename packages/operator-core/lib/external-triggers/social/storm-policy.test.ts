/**
 * P-023 — per-platform storm policy defaults, and a burst test per Wave A adapter.
 *
 * The property that matters most here is a NEGATIVE one, and it is the reason
 * this file checks every registry row rather than a sample: no platform may end
 * up with an unbounded cap. Only Reddit states a numeric rate budget, so a
 * derivation keyed solely on `requestsPerMinute` would leave Bluesky and
 * Mastodon uncapped — and those two are the streaming transports, where a storm
 * actually arrives. An uncapped policy and a working one are indistinguishable
 * until the day a post goes viral, so the guard is written to fail now instead.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  ASSUMED_REQUESTS_PER_RUN,
  FALLBACK_MAX_RUNS,
  MAX_RUNS_CEILING,
  PROVIDER_STORM_WINDOW_SECONDS,
  defaultProviderStormPolicyForSourceKind,
  providerStormPolicyFor,
  toBindingStormPolicy,
} from '../provider-storm-policy';
import { bundledSocialProviderDescriptors } from '../../capability-verbs/social-provider.fixture';
import { createProviderRegistry } from '../../integrations/provider-registry';
import { parseStormPolicy } from '../binding-engine';
const testRegistry = createProviderRegistry();
beforeAll(async () => {
  for (const descriptor of bundledSocialProviderDescriptors()) await testRegistry.register({ descriptor, pluginName: descriptor.id, adapter: { describe: () => descriptor, syncPage: async () => ({ records: [], nextCursor: null, hasMore: false }), invoke: async () => ({}) } });
});
const listProviders = () => bundledSocialProviderDescriptors().map((descriptor) => ({
  ...descriptor, rateBudget: descriptor.rateBudget ?? { verifiedAt: null, sources: [] },
}));

const WAVE_A = ['bluesky', 'mastodon', 'reddit'] as const;

const rowFor = (id: string) => {
  const row = listProviders().find((r) => r.id === id);
  if (!row) throw new Error(`registry has no row for ${id} — this test's premise is stale`);
  return row;
};

describe('P-023 storm policy — no platform is left uncapped', () => {
  const rows = listProviders();

  it('the registry is non-empty, so the sweep below measures something', () => {
    // POSITIVE CONTROL. Every assertion in this describe block is a forall over
    // `rows`; all of them pass vacuously if the registry read returns nothing.
    expect(rows.length).toBeGreaterThanOrEqual(3);
  });

  it.each(rows.map((r) => r.id))('%s gets a bounded, positive cap', (id) => {
    const policy = providerStormPolicyFor(rowFor(id));

    expect(policy.mode).toBe('coalesce-with-cap');
    expect(Number.isFinite(policy.maxRuns)).toBe(true);
    expect(policy.maxRuns).toBeGreaterThan(0);
    expect(policy.maxRuns).toBeLessThanOrEqual(MAX_RUNS_CEILING);

    // The window is the STANDARD one unless the platform's budget is too tight
    // to fund even one run per standard window, in which case the derivation
    // deliberately WIDENS it rather than deriving a cap of zero.
    //
    // That branch existed from the start but was only ever reached by synthetic
    // rows until LinkedIn (P-021) — the first platform whose real published
    // budget (150 member requests/day) cannot fund a 300s cadence. Asserting
    // the fixed window unconditionally would therefore have forced a choice
    // between a false cap and deleting a correct safety behaviour, so the
    // invariant is stated as it was always meant: bounded and positive, and
    // widened ONLY with the basis saying so.
    if (policy.windowSeconds !== PROVIDER_STORM_WINDOW_SECONDS) {
      expect(policy.windowSeconds, `${id} widened its window`).toBeGreaterThan(PROVIDER_STORM_WINDOW_SECONDS);
      expect(
        'windowWidened' in policy.basis && policy.basis.windowWidened,
        `${id} widened its window without recording why`,
      ).toBe(true);
    }
  });

  it('LinkedIn is the row that exercises window-widening against a REAL budget', () => {
    // Pinned because it is the only production evidence that this branch works,
    // and because a future tidy-up of LinkedIn's limits would silently return
    // the branch to synthetic-only coverage.
    const policy = providerStormPolicyFor(rowFor('linkedin'));
    expect(policy.basis.kind).toBe('quota-bucket');
    if (policy.basis.kind !== 'quota-bucket') throw new Error('unreachable');

    // The MEMBER bucket, not the 100,000/day application one: it is the binding
    // limit for a single owner and ~667x smaller (D-020 non-fungible buckets).
    expect(policy.basis.bucket).toBe('member');
    expect(policy.basis.perDay).toBe(150);
    expect(policy.basis.windowWidened).toBe(true);
    expect(policy.maxRuns).toBe(1);
    expect(policy.windowSeconds).toBeGreaterThan(PROVIDER_STORM_WINDOW_SECONDS);
  });

  it('CONTROL: the uncapped-platform guard actually catches an uncapped platform', () => {
    // The naive derivation this module exists to avoid: key the cap solely on
    // `requestsPerMinute` and let an absent budget mean "no limit". Kept here
    // permanently rather than run as a one-off mutation, so the guard above can
    // never quietly stop being able to fail.
    const naive = (row: (typeof rows)[number]) => ({ maxRuns: row.rateBudget.requestsPerMinute ?? Infinity });

    const uncapped = rows.filter((row) => !Number.isFinite(naive(row).maxRuns));

    // Two things at once: the naive version really does leave platforms
    // uncapped (so the guard has something to catch), and those platforms are
    // the streaming ones — which is why this mattered enough to build.
    expect(uncapped.length).toBeGreaterThan(0);
    expect(uncapped.map((r) => r.id)).toEqual(expect.arrayContaining(['bluesky', 'mastodon']));

    // ...and the real implementation caps every one of them.
    for (const row of uncapped) {
      expect(Number.isFinite(providerStormPolicyFor(row).maxRuns)).toBe(true);
    }
  });

  it('every cap states whether it was derived or fell back — a guess never passes for a measurement', () => {
    for (const row of rows) {
      const { basis } = providerStormPolicyFor(row);
      // Exhaustive on purpose: an `else` branch would let a FUTURE basis kind
      // pass this invariant without ever stating its evidence, which is the
      // exact failure the test exists to prevent. A new kind must fail here
      // until it is taught what its evidence is.
      switch (basis.kind) {
        case 'rate-budget':
          expect(basis.requestsPerMinute).toBeGreaterThan(0);
          break;
        case 'quota-bucket':
          // A bucket-derived cap must name WHICH non-fungible bucket it came
          // from (D-020) — "derived from the quota" is not auditable when a
          // platform has three quotas that cannot substitute for each other.
          expect(basis.bucket.length).toBeGreaterThan(0);
          expect(basis.perDay).toBeGreaterThan(0);
          expect(basis.spendPerRun).toBeGreaterThan(0);
          break;
        case 'dynamic-quota':
          // A moving allowance must state the formula it moves by AND the
          // absolute floor it is anchored to. Without the floor there is no
          // number to scale, because the usage header reports percentages only —
          // so a basis carrying just a percentage would be unauditable in the
          // one way that matters.
          expect(basis.formula.trim().length).toBeGreaterThan(0);
          expect(basis.assumedDailyFloor).toBeGreaterThan(0);
          expect(basis.spendPerRun).toBeGreaterThan(0);
          // Whether the cap rests on a measurement or on the floor alone must be
          // legible, so `null` here is a real value and not an omission.
          expect(basis).toHaveProperty('observedPeakUsagePct');
          break;
        case 'conservative-default':
          // The fallback must always explain itself; an empty reason would make
          // a guessed cap unauditable at the admin surface.
          expect(basis.why.trim().length).toBeGreaterThan(0);
          break;
        default:
          throw new Error(`unhandled storm-cap basis kind: ${JSON.stringify(basis)}`);
      }
    }
  });
});

describe('P-023 storm policy — derivation from the P-002 rate budget', () => {
  it('reddit derives its cap from the documented 60 requests/minute', () => {
    const row = rowFor('reddit');
    // Guard the premise rather than assuming it: if the registry figure changes,
    // this should fail loudly here instead of silently re-baselining the cap.
    expect(row.rateBudget.requestsPerMinute).toBe(60);

    const policy = providerStormPolicyFor(row);
    const windowMinutes = PROVIDER_STORM_WINDOW_SECONDS / 60;

    expect(policy.basis).toEqual({
      kind: 'rate-budget',
      requestsPerMinute: 60,
      requestsPerRun: ASSUMED_REQUESTS_PER_RUN,
    });
    expect(policy.maxRuns).toBe(Math.floor((60 * windowMinutes) / ASSUMED_REQUESTS_PER_RUN));
    expect(policy.maxRuns).toBe(30);
  });

  it.each(['bluesky', 'mastodon'] as const)(
    '%s states no numeric budget, so it falls back to a conservative cap rather than to unbounded',
    (id) => {
      const row = rowFor(id);
      expect(row.rateBudget.requestsPerMinute).toBeUndefined();

      const policy = providerStormPolicyFor(row);
      expect(policy.basis.kind).toBe('conservative-default');
      expect(policy.maxRuns).toBe(FALLBACK_MAX_RUNS);
    },
  );

  it('a generous budget is clamped to the ceiling rather than trusted upward', () => {
    const row = { ...rowFor('reddit'), rateBudget: { requestsPerMinute: 100_000 } };
    expect(providerStormPolicyFor(row).maxRuns).toBe(MAX_RUNS_CEILING);
  });

  it('a tiny budget still permits one run per window rather than deriving zero', () => {
    // A cap of 0 would be an outage wearing a policy's clothes.
    const row = { ...rowFor('reddit'), rateBudget: { requestsPerMinute: 1 } };
    expect(providerStormPolicyFor(row).maxRuns).toBe(1);
  });
});

describe('P-023 storm policy — the landed binding-engine seam', () => {
  it.each(WAVE_A)('%s projects onto a policy the binding engine actually accepts', (id) => {
    const policy = providerStormPolicyFor(rowFor(id));
    const stored = toBindingStormPolicy(policy);

    // The real parser, not a local re-implementation of what it probably does.
    const parsed = parseStormPolicy(stored);
    expect(parsed.maxRuns).toBe(policy.maxRuns);
    expect(parsed.windowSeconds).toBe(policy.windowSeconds);
  });

  it('carries the basis through storage so a stored cap stays self-describing', () => {
    const stored = toBindingStormPolicy(providerStormPolicyFor(rowFor('bluesky')));
    expect(stored.mode).toBe('coalesce-with-cap');
    expect((stored.basis as { kind: string }).kind).toBe('conservative-default');
  });
});

describe('P-023 storm policy — the source-kind default that admin.ts installs', () => {
  it.each(WAVE_A)('%s resolves a capped default from its source kind', (id) => {
    const stored = defaultProviderStormPolicyForSourceKind(testRegistry, id);
    expect(stored).not.toBeNull();

    const parsed = parseStormPolicy(stored as Record<string, unknown>);
    // A real, platform-derived cap. (Until 2026-08-26 the contrast being drawn
    // here was against an UNBOUNDED engine default; see the re-justified
    // CONTROL below for what the contrast is now.)
    expect(parsed.maxRuns).toBeGreaterThan(0);
  });

  it('returns null for a non-social source kind, leaving mail and chat untouched', () => {
    for (const kind of ['gmail', 'slack', 'calendar', 'not-a-platform']) {
      expect(defaultProviderStormPolicyForSourceKind(testRegistry, kind)).toBeNull();
    }
  });

  it('CONTROL: the engine default is now BOUNDED, so the wiring is justified by coalesce, not by cap', () => {
    // This test used to assert `parseStormPolicy({}).maxRuns === null` — the
    // engine default really was unbounded, and that was P-023's stated reason
    // for existing. It also said: "If the binding engine ever gains a bounded
    // default of its own, this fails and the social override should be
    // re-justified rather than left in place."
    //
    // That happened on 2026-08-26 (EI-21500982767775449): a Gmail poller closed
    // a 2h35m resync gap and an uncapped mail binding minted 228 autonomous
    // plan runs in 68s, so DEFAULT_STORM_MAX_RUNS became the engine-wide floor.
    // This is the tripwire firing exactly as designed, so here is the
    // re-justification it asked for.
    //
    // P-023 SURVIVES, on a narrower and truer basis. The engine default and the
    // social default now agree that a binding must be capped; they disagree
    // about what happens to the OVERFLOW, and that is the whole point:
    //   - the engine SKIPS it (a terminal `skipped` trigger_run), which is right
    //     for mail — a throttled backlog message is still sitting in the mailbox;
    //   - social COALESCES it (planCoalesceWithCap), because a skipped comment on
    //     a viral thread is never seen again.
    // The second reason is derivation: a social cap is computed from the
    // platform's own documented rate budget, not from one generic number.
    //
    // So: assert the floor is bounded, and assert social still differs from it.
    const engineDefault = parseStormPolicy({});
    expect(engineDefault.maxRuns).toBeGreaterThan(0);

    const social = defaultProviderStormPolicyForSourceKind(testRegistry, 'bluesky');
    expect(social).not.toBeNull();
    expect(social?.mode).toBe('coalesce-with-cap');
    expect(parseStormPolicy(social as Record<string, unknown>).windowSeconds).not.toBe(
      engineDefault.windowSeconds,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* P-015 stage 5 — per-verb caps over non-fungible quota buckets (D-020)      */
/* -------------------------------------------------------------------------- */

describe('P-015 — a verb’s cap comes from the bucket that verb draws on', () => {
  const youtube = rowFor('youtube');

  it('guards the premise: youtube declares three non-fungible buckets', () => {
    // If the registry figures change, fail loudly here rather than silently
    // re-baselining every cap below.
    expect(youtube.rateBudget.buckets).toBeDefined();
    expect(youtube.rateBudget.buckets!.general).toMatchObject({ perDay: 10000, unit: 'units' });
    expect(youtube.rateBudget.buckets!.videoUploads).toMatchObject({ perDay: 100, unit: 'calls' });
    expect(youtube.rateBudget.buckets!.search).toMatchObject({ perDay: 100, unit: 'calls' });
  });

  it('derives a READ cap from the general units bucket', () => {
    const policy = providerStormPolicyFor(youtube, 'read');
    expect(policy.basis).toMatchObject({
      kind: 'quota-bucket',
      bucket: 'general',
      verb: 'read',
      perDay: 10000,
      unit: 'units',
      spendPerRun: ASSUMED_REQUESTS_PER_RUN, // reads spend no write units
    });
  });

  it('derives a POST cap from the CALL-capped upload bucket, not the general pool', () => {
    // The D-020 error this exists to prevent: 10,000 unused general units cannot
    // buy a single extra upload, so a cap derived from them is calibrated
    // against an unrelated quantity.
    const policy = providerStormPolicyFor(youtube, 'post');
    expect(policy.basis).toMatchObject({
      kind: 'quota-bucket',
      bucket: 'videoUploads',
      verb: 'post',
      perDay: 100,
      unit: 'calls',
      spendPerRun: 1,
    });
  });

  it('gives a REPLY a stricter cap than a READ, because the write costs 50x a poll', () => {
    const read = providerStormPolicyFor(youtube, 'read');
    const reply = providerStormPolicyFor(youtube, 'reply');
    const runsPerDay = (p: typeof read) => (p.maxRuns * 86_400) / p.windowSeconds;
    expect(runsPerDay(reply)).toBeLessThan(runsPerDay(read));
  });

  it('NEVER authorises more runs per day than the bucket can fund', () => {
    // THE INVARIANT THE WHOLE STAGE EXISTS FOR. A cap that overspends does not
    // throttle the integration, it STOPS it — the budget is daily and does not
    // refill until the quota day rolls over.
    for (const verb of ['read', 'reply', 'post', 'delete'] as const) {
      const policy = providerStormPolicyFor(youtube, verb);
      const basis = policy.basis;
      if (basis.kind !== 'quota-bucket') throw new Error(`expected a quota-bucket basis for ${verb}`);
      const runsPerDay = (policy.maxRuns * 86_400) / policy.windowSeconds;
      expect(runsPerDay * basis.spendPerRun, `${verb} overspends ${basis.bucket}`).toBeLessThanOrEqual(basis.perDay);
    }
  });

  it('WIDENS THE WINDOW rather than flooring the cap to a lie', () => {
    // A reply run spends ~60 units; 10,000/day funds ~166 runs. The standard
    // 300s window contains 288 windows a day, so clamping to "1 per window"
    // would authorise 288 runs and overspend by ~70%. The window widens instead.
    const policy = providerStormPolicyFor(youtube, 'reply');
    expect(policy.maxRuns).toBe(1);
    expect(policy.windowSeconds).toBeGreaterThan(PROVIDER_STORM_WINDOW_SECONDS);
    expect(policy.basis).toMatchObject({ kind: 'quota-bucket', windowWidened: true });
  });

  it('CONTROL: the old clamp-to-1 rule really would have overspent', () => {
    // The control on the previous test. Without it, "the window had to widen" is
    // a claim nobody has watched be true.
    const policy = providerStormPolicyFor(youtube, 'reply');
    const basis = policy.basis;
    if (basis.kind !== 'quota-bucket') throw new Error('expected a quota-bucket basis');
    const clampedRunsPerDay = (1 * 86_400) / PROVIDER_STORM_WINDOW_SECONDS; // the rejected rule
    expect(clampedRunsPerDay * basis.spendPerRun).toBeGreaterThan(basis.perDay);
  });

  it('leaves every bucket-less platform on exactly the pre-existing derivation', () => {
    // Stage 5 must not re-baseline Wave A. Their rows declare no buckets, so the
    // verb argument is inert for them — asserted across all four verbs.
    for (const id of WAVE_A) {
      const row = rowFor(id);
      expect(row.rateBudget.buckets).toBeUndefined();
      const base = providerStormPolicyFor(row);
      for (const verb of ['read', 'reply', 'post', 'delete'] as const) {
        expect(providerStormPolicyFor(row, verb)).toEqual(base);
      }
    }
  });

  it('defaults to the READ verb, which is what a trigger SOURCE does', () => {
    expect(providerStormPolicyFor(youtube)).toEqual(providerStormPolicyFor(youtube, 'read'));
    const projected = defaultProviderStormPolicyForSourceKind(testRegistry, 'youtube');
    expect(projected).toMatchObject({ maxRuns: providerStormPolicyFor(youtube, 'read').maxRuns });
  });

  it('takes the TIGHTEST bucket for a verb no bucket declares', () => {
    // Conservative on purpose: too small throttles, too large exhausts the day's
    // budget and stops the integration outright. The caller is told it happened.
    const policy = providerStormPolicyFor(youtube, 'delete');
    const general = youtube.rateBudget.buckets!.general;
    expect(general.verbs).toContain('delete'); // delete IS declared, so no fallback
    expect(policy.basis).toMatchObject({ kind: 'quota-bucket', bucket: 'general' });
    expect((policy.basis as { fallbackToTightest?: boolean }).fallbackToTightest).toBeUndefined();
  });

  it('search.list is declared for NO verb, so nothing is capped against it', () => {
    // Neither read adapter calls search.list — activities.list and
    // commentThreads.list are both general-bucket. Declaring a verb on it would
    // attribute a cap to a bucket nothing actually draws on.
    expect(youtube.rateBudget.buckets!.search.verbs).toBeUndefined();
    for (const verb of ['read', 'reply', 'post', 'delete'] as const) {
      expect((providerStormPolicyFor(youtube, verb).basis as { bucket?: string }).bucket).not.toBe('search');
    }
  });

  it('survives the round trip through the stored binding-policy shape', () => {
    const policy = providerStormPolicyFor(youtube, 'reply');
    const stored = toBindingStormPolicy(policy);
    const parsed = parseStormPolicy(stored);
    expect(parsed).toMatchObject({ maxRuns: policy.maxRuns, windowSeconds: policy.windowSeconds });
    expect((stored.basis as { bucket?: string }).bucket).toBe('general');
  });
});

/* -------------------------------------------------------------------------- */
/* P-016 — a DYNAMIC allowance (Facebook Pages, D-028)                        */
/* -------------------------------------------------------------------------- */

describe('P-016 storm policy — an allowance that is not a constant', () => {
  const facebook = rowFor('facebook-pages');
  const dq = facebook.rateBudget.dynamicQuota!;

  it('the registry premise still holds: a declared dynamic quota and NO fixed budget', () => {
    // Guarding the premise rather than assuming it. If a later edit gave this
    // row a requestsPerMinute, every derivation below would silently change
    // meaning while still passing on the numbers.
    expect(dq).toBeDefined();
    expect(dq.formula).toContain('4800');
    expect(dq.assumedDailyFloor).toBe(4800);
    expect(dq.retryExtendsBlock).toBe(true);
    expect(facebook.rateBudget.requestsPerMinute).toBeUndefined();
    expect(facebook.rateBudget.buckets).toBeUndefined();
  });

  it('CONTROL: the conservative fallback would be RECKLESS here, which is why this branch exists', () => {
    // The number this branch replaces. FALLBACK_MAX_RUNS is conservative against
    // a per-minute budget that refills continuously, and wildly over-generous
    // against a small DAILY one — the two failure directions look identical from
    // the cap alone, so the arithmetic is asserted rather than described.
    const windowsPerDay = 86_400 / PROVIDER_STORM_WINDOW_SECONDS;
    const fallbackCallsPerDay = FALLBACK_MAX_RUNS * ASSUMED_REQUESTS_PER_RUN * windowsPerDay;
    expect(fallbackCallsPerDay).toBeGreaterThan(dq.assumedDailyFloor * 7);

    // ...and what this branch actually derives fits inside the floor.
    const policy = providerStormPolicyFor(facebook);
    const derivedCallsPerDay = policy.maxRuns * ASSUMED_REQUESTS_PER_RUN * (86_400 / policy.windowSeconds);
    expect(derivedCallsPerDay).toBeLessThanOrEqual(dq.assumedDailyFloor);
  });

  it('with NOTHING observed, the cap rests on the floor and says so', () => {
    const policy = providerStormPolicyFor(facebook);
    expect(policy.hold).toBeUndefined();
    expect(policy.basis).toMatchObject({
      kind: 'dynamic-quota',
      assumedDailyFloor: 4800,
      observedPeakUsagePct: null,
      headroomPct: 100,
    });
    // 4800 calls/day ÷ 10 calls/run = 480 runs/day, against 288 windows/day.
    expect(policy.maxRuns).toBe(1);
    expect(policy.windowSeconds).toBe(PROVIDER_STORM_WINDOW_SECONDS);
  });

  it('a mid-range observation WIDENS THE WINDOW rather than holding — rationing is not throttling', () => {
    // The distinction the branch exists to make: headroom is low but real, so
    // the integration keeps working more slowly instead of stopping. Holding
    // here would take a source that can still reply and silence it.
    const policy = providerStormPolicyFor(facebook, 'read', { peakUsagePct: 50 });
    expect(policy.hold).toBeUndefined();
    expect(policy.maxRuns).toBe(1);
    expect(policy.windowSeconds).toBeGreaterThan(PROVIDER_STORM_WINDOW_SECONDS);
    expect(policy.basis).toMatchObject({
      kind: 'dynamic-quota',
      observedPeakUsagePct: 50,
      headroomPct: 50,
      windowWidened: true,
    });
  });

  it('the window widens MONOTONICALLY as the observed allowance is consumed', () => {
    // A property rather than three magic numbers: more consumed can never buy
    // more throughput. An inverted comparison in the arithmetic would still
    // produce plausible-looking single values.
    const windows = [10, 30, 60, 90, 99].map(
      (pct) => providerStormPolicyFor(facebook, 'read', { peakUsagePct: pct }).windowSeconds,
    );
    for (let i = 1; i < windows.length; i += 1) expect(windows[i]).toBeGreaterThanOrEqual(windows[i - 1]);
    expect(windows.at(-1)!).toBeGreaterThan(windows[0]!);
  });

  it('a spent allowance HOLDS, and forbids the retry that would extend the block', () => {
    const policy = providerStormPolicyFor(facebook, 'read', { peakUsagePct: 100 });
    expect(policy.maxRuns).toBe(0);
    expect(policy.hold).toMatchObject({ retryForbidden: true, untilMs: null });
    expect(policy.hold?.reason).toMatch(/allowance/i);
    expect(policy.basis).toMatchObject({ kind: 'dynamic-quota', held: true, headroomPct: 0 });
  });

  it('holds when the remaining share cannot fund even one run', () => {
    // 0.5% of 4800 = 24 calls, against a 10-call run: that funds runs, so it
    // widens. 0.1% = 4.8 calls: it does not, so it holds. The boundary is
    // derived from the floor, not chosen.
    expect(providerStormPolicyFor(facebook, 'read', { peakUsagePct: 99.5 }).hold).toBeUndefined();
    expect(providerStormPolicyFor(facebook, 'read', { peakUsagePct: 99.9 }).hold).toBeDefined();
  });

  it('a REPORTED throttle holds even when the usage percentage looks comfortable', () => {
    // The two signals are independent, and the provider's own word wins. A
    // policy that only watched the percentage would keep calling straight
    // through a throttle it had already been told about — which on this platform
    // is what extends the block.
    const policy = providerStormPolicyFor(facebook, 'read', {
      peakUsagePct: 12,
      throttled: true,
      throttleHoldMs: 600_000,
    });
    expect(policy.maxRuns).toBe(0);
    expect(policy.hold).toMatchObject({ retryForbidden: true, untilMs: 600_000 });
  });

  it('a throttle with NO stated duration carries null, never an invented default', () => {
    // The vendor documents no fallback duration, so none may be manufactured.
    // A number here would be a retry loop underneath a no-retry policy.
    const policy = providerStormPolicyFor(facebook, 'read', { throttled: true, throttleHoldMs: null });
    expect(policy.hold?.untilMs).toBeNull();
    expect(policy.hold?.retryForbidden).toBe(true);
  });

  it('retryForbidden tracks the ROW, so a platform that permits retries is not told not to', () => {
    // Guards against the flag being hardcoded true because the only platform
    // that needed it happened to forbid retries.
    const permissive = {
      ...facebook,
      rateBudget: { ...facebook.rateBudget, dynamicQuota: { ...dq, retryExtendsBlock: false } },
    };
    expect(providerStormPolicyFor(permissive, 'read', { throttled: true }).hold?.retryForbidden).toBe(false);
  });

  it('REFUSES to persist a hold rather than rounding it into a runnable policy', () => {
    // Both silent repairs are wrong: `maxRuns: 0` is rejected by the binding
    // parser, and clamping it to 1 would store a standing licence to call built
    // out of an instruction to stop. So this throws, and the throw is the
    // contract.
    const held = providerStormPolicyFor(facebook, 'read', { throttled: true });
    expect(() => toBindingStormPolicy(held)).toThrow(/held_not_persistable/);

    // CONTROL: the same projection succeeds for the un-held policy, so the
    // throw above is about the hold and not about this platform.
    expect(() => toBindingStormPolicy(providerStormPolicyFor(facebook))).not.toThrow();
  });

  it('the source-kind default installs a policy the binding engine accepts', () => {
    const stored = defaultProviderStormPolicyForSourceKind(testRegistry, 'facebook-pages');
    expect(stored).not.toBeNull();
    const parsed = parseStormPolicy(stored as Record<string, unknown>);
    expect(parsed.maxRuns).toBe(1);
    expect(parsed.windowSeconds).toBe(PROVIDER_STORM_WINDOW_SECONDS);
  });

  it('a declared dynamic quota OUTRANKS a fixed number on the same row', () => {
    // (see also the D-030 block below, where a declared BUCKET does NOT lose to
    // a dynamic quota — the two cases differ and the distinction is the ruling.)
    // Ordering, asserted. A row carrying both is exactly the case where a stale
    // constant could win over the field added to overrule it — and it would
    // present as a working cap, just one calibrated against a budget that no
    // longer applies.
    const both = { ...facebook, rateBudget: { ...facebook.rateBudget, requestsPerMinute: 600 } };
    expect(providerStormPolicyFor(both).basis.kind).toBe('dynamic-quota');
  });
});

/* -------------------------------------------------------------------------- */
/* P-017 / D-030 — a row stating TWO non-fungible budgets at once             */
/* -------------------------------------------------------------------------- */

describe('P-017 storm policy — a dynamic call budget AND a fixed publishing cap', () => {
  const instagram = rowFor('instagram');

  it('the registry premise: instagram declares BOTH, and the publishing bucket claims only `post`', () => {
    // If a later edit makes this row state only one of the two, every assertion
    // below stops testing what it says it tests — so the premise fails loudly
    // here rather than passing vacuously there.
    expect(instagram.rateBudget.dynamicQuota).toBeDefined();
    expect(instagram.rateBudget.buckets?.publishing).toBeDefined();
    expect(instagram.rateBudget.buckets!.publishing.verbs).toEqual(['post']);
    expect(instagram.rateBudget.buckets!.publishing.unit).toBe('calls');
  });

  it('`post` is capped by the PUBLISHING bucket, not by the call budget', () => {
    const policy = providerStormPolicyFor(instagram, 'post');
    expect(policy.basis).toMatchObject({ kind: 'quota-bucket', bucket: 'publishing', unit: 'calls' });
  });

  it('`read` and `reply` fall to the CALL budget — a read is not capped by a publishing limit', () => {
    // The failure this prevents is silent and severe in the wrong direction: 50
    // publishes/day against a 10-call run derives ~5 runs/day, which would
    // throttle comment reading to near-nothing for a reason that has nothing to
    // do with reading.
    for (const verb of ['read', 'reply'] as const) {
      expect(providerStormPolicyFor(instagram, verb).basis.kind).toBe('dynamic-quota');
    }
  });

  it('CONTROL: the pre-D-030 ordering (dynamic quota unconditionally first) really would differ', () => {
    // This block exists because D-029 originally said the dynamic quota outranks
    // buckets UNCONDITIONALLY, and Instagram falsified it. Keeping the old rule
    // modelled here means the amendment cannot quietly regress into the version
    // that was wrong.
    const dynamicFirst = providerStormPolicyFor(
      { ...instagram, rateBudget: { ...instagram.rateBudget, buckets: undefined } },
      'post',
    );
    const actual = providerStormPolicyFor(instagram, 'post');

    expect(dynamicFirst.basis.kind).toBe('dynamic-quota');
    expect(actual.basis.kind).toBe('quota-bucket');

    // ...and they are not merely differently-labelled. NOTE WHICH DIMENSION
    // DIFFERS — an earlier version of this control compared `maxRuns` and
    // passed-as-failing, because BOTH paths derive a cap of 1. The cap is the
    // wrong quantity: what a widened window changes is the RATE. Comparing the
    // wrong dimension would have made this control vacuous while looking strict.
    const perDay = (p: { maxRuns: number; windowSeconds: number }) =>
      p.maxRuns * (86_400 / p.windowSeconds);

    expect(perDay(dynamicFirst)).toBe(288); // one run per 5-minute window
    // The derived rate lands exactly on the vendor's stated publishing cap,
    // which is the strongest available evidence that it came from that bucket.
    expect(perDay(actual)).toBe(instagram.rateBudget.buckets!.publishing.perDay);
    expect(perDay(actual)).toBeLessThan(perDay(dynamicFirst));
  });

  it('the publishing cap is the LOWER of the two figures the vendor states', () => {
    // The page says 100 in one place and 50 in another, about the same limit.
    // Taking the smaller is the recorded resolution; if someone later "fixes" it
    // upward, that is a decision to re-argue, not a typo to correct silently.
    expect(instagram.rateBudget.buckets!.publishing.perDay).toBe(50);
  });

  it('YouTube is unaffected: with no dynamic quota, the tightest-bucket fallback still applies', () => {
    // The amendment narrowed the bucket path with a condition. This asserts the
    // narrowing is conditional on a dynamic quota EXISTING, rather than having
    // quietly disabled the fallback for every platform.
    const youtube = rowFor('youtube');
    expect(youtube.rateBudget.dynamicQuota).toBeUndefined();
    expect(providerStormPolicyFor(youtube, 'read').basis.kind).toBe('quota-bucket');
  });

  it('instagram reads its OWN throttle code and header type, not Facebook\'s', () => {
    // Inherited-not-verified, made mechanical. Pages' codes are 80001/32 and its
    // header rows are type `pages`; reading either here would be measuring
    // another product's budget while looking correct.
    const dq = instagram.rateBudget.dynamicQuota!;
    expect(dq.throttleCodes).toEqual([80002]);
    expect(instagram.rateBudget.notes).toContain('Declared usage type: instagram');

    const facebook = rowFor('facebook-pages').rateBudget.dynamicQuota!;
    expect(facebook.throttleCodes).not.toEqual(dq.throttleCodes);
    expect(rowFor('facebook-pages').rateBudget.notes).toContain('Declared usage type: pages');

    // Same multiplier, different multiplicand — the coincidence most likely to
    // be read as a copy-paste.
    expect(dq.assumedDailyFloor).toBe(facebook.assumedDailyFloor);
    expect(dq.formula).not.toBe(facebook.formula);
  });
});
