/**
 * journal-window-diagnosis.test.ts — WI-7133.
 *
 * journalctl parses `--since`/`--until` in the host's LOCAL time while every
 * papercusp surface reports UTC. On a UTC-4 box, pasting a UTC stamp into `since`
 * queries a window ~4h in the FUTURE, which journalctl answers with a clean exit
 * and zero lines — indistinguishable from "that event was never logged". During a
 * live fleet-death investigation that empty result was read as confirmation of a
 * cause that was already wrong; the real window held the whole story.
 *
 * The subject is `readJournal`'s `windowOutsideJournal` field: an empty result
 * that explains its own emptiness.
 *
 * ⚠ The rule these tests exist to pin is NOT "always diagnose". It is *never
 * diagnose unless it is provable* — a false "your timezone is wrong" misdirects
 * exactly as badly as the silence it replaces. So every un-provable case below
 * asserts NULL, and those are the tests that matter most.
 */
import { describe, it, expect } from 'vitest';
import {
  readJournal as readJournalImpl,
  type JournalExec,
  type UnitCanonicalizer,
  type WindowResolver,
} from './journal-read';

const NEWEST_MS = Date.parse('2026-08-16T21:35:07.000Z');
const PROBE_MARKER = '--output-fields=__REALTIME_TIMESTAMP,MESSAGE';

/** journalctl's own record shape, as the newest-entry probe would receive it. */
function newestEntryStdout(atMs: number): string {
  return JSON.stringify({
    __REALTIME_TIMESTAMP: String(atMs * 1000),
    PRIORITY: '6',
    MESSAGE: 'the newest line in the journal',
  });
}

/**
 * Main query returns nothing; the unfiltered newest-entry probe returns a record.
 * Distinguished by the probe's own `--output-fields`, so the fake cannot drift
 * from the real call shape without this test noticing.
 */
function execEmptyWithNewest(atMs: number | null): JournalExec {
  return async (args) => {
    if (args.includes(PROBE_MARKER)) {
      return { stdout: atMs === null ? '' : newestEntryStdout(atMs) };
    }
    return { stdout: '' };
  };
}

const noUnknownUnits = async () => [];
const resolvesTo = (ms: number | null): WindowResolver => async () => ms;
const keepRequestedUnitNames: UnitCanonicalizer = async (units) => units;

// These cases isolate window diagnosis from systemd's external name resolver.
const readJournal = (
  opts: Parameters<typeof readJournalImpl>[0],
  exec?: Parameters<typeof readJournalImpl>[1],
  probeUnits?: Parameters<typeof readJournalImpl>[2],
  resolveWindow?: Parameters<typeof readJournalImpl>[3],
) => readJournalImpl(opts, exec, probeUnits, resolveWindow, keepRequestedUnitNames);

describe('readJournal — an empty window explains itself (WI-7133)', () => {
  it('DIAGNOSES a window that resolves AFTER the newest record', async () => {
    // The exact trap: a UTC stamp pasted into a local-time parser, landing 4h ahead.
    const sinceMs = NEWEST_MS + 4 * 3_600_000;
    const out = await readJournal(
      { units: ['papercup-bg-host.service'], since: '2026-08-16 21:35:07' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(sinceMs),
    );

    expect(out.entries).toEqual([]);
    expect(out.journalError).toBeNull(); // a CLEAN read — that is what makes it dangerous
    expect(out.windowOutsideJournal).not.toBeNull();
    expect(out.windowOutsideJournal!.aheadByMs).toBe(4 * 3_600_000);
    expect(out.windowOutsideJournal!.newestEntryUtc).toBe('2026-08-16T21:35:07.000Z');
    expect(out.windowOutsideJournal!.resolvedSinceUtc).toBe(new Date(sinceMs).toISOString());
    // The hint must name the CAUSE and the FIX, not merely restate the emptiness.
    expect(out.windowOutsideJournal!.hint).toMatch(/LOCAL/);
    expect(out.windowOutsideJournal!.hint).toMatch(/relative window/i);
  });

  it('CALIBRATION: says nothing when the window sits INSIDE the journal', async () => {
    // Without this control, an implementation that diagnosed unconditionally would
    // pass the test above and be worse than no feature at all.
    const out = await readJournal(
      { units: ['a.service'], since: '-30 min' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(NEWEST_MS - 30 * 60_000),
    );
    expect(out.entries).toEqual([]);
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the window resolves EXACTLY to the newest record', async () => {
    // Boundary: equal is inside, not after. An off-by-one here would fire the
    // diagnosis on a perfectly legitimate `--since <newest>` read.
    const out = await readJournal(
      { units: ['a.service'], since: 'whatever' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(NEWEST_MS),
    );
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the window cannot be resolved', async () => {
    // No systemd-analyze, or a spec it will not parse. Reporting nothing is the
    // required behaviour — the same rule unitIsUnknownTo follows.
    const out = await readJournal(
      { units: ['a.service'], since: 'gibberish' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(null),
    );
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the journal has no records to compare against', async () => {
    // An empty journal cannot prove a window is "past the end" of anything.
    const out = await readJournal(
      { units: ['a.service'], since: 'whenever' },
      execEmptyWithNewest(null),
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 4 * 3_600_000),
    );
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the read actually FAILED — a failure is not a clean window', async () => {
    // journalError already carries the meaning here; adding a window diagnosis on
    // top would invite fixing the timezone when the real problem was a timeout.
    const exec: JournalExec = async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    };
    const out = await readJournal(
      { units: ['a.service'], since: 'whenever' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 4 * 3_600_000),
    );
    expect(out.journalError).not.toBeNull();
    expect(out.matched).toBeNull();
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('says nothing when the read RETURNED rows, however far ahead the window parsed', async () => {
    // The field is only ever about explaining an EMPTY result.
    const exec: JournalExec = async (args) => {
      if (args.includes(PROBE_MARKER)) return { stdout: newestEntryStdout(NEWEST_MS) };
      return { stdout: newestEntryStdout(NEWEST_MS) };
    };
    const out = await readJournal(
      { units: ['a.service'], since: 'whenever' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 4 * 3_600_000),
    );
    expect(out.entries.length).toBe(1);
    expect(out.windowOutsideJournal).toBeNull();
  });

  it('the newest-entry probe requests MESSAGE, or it would silently never fire', async () => {
    // Regression guard for a bug in the FIRST draft of this feature: the probe
    // asked for __REALTIME_TIMESTAMP alone, but parseJournalJson DROPS any record
    // whose MESSAGE will not decode — so every record parsed to nothing and the
    // diagnosis could never fire. That failure mode is invisible (a feature that
    // never triggers looks exactly like a window that is always fine), so the call
    // shape itself is pinned here rather than left to the other tests to imply.
    const seen: string[][] = [];
    const exec: JournalExec = async (args) => {
      seen.push(args);
      if (args.includes(PROBE_MARKER)) return { stdout: newestEntryStdout(NEWEST_MS) };
      return { stdout: '' };
    };
    await readJournal(
      { units: ['a.service'], since: 'whenever' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS + 1000),
    );
    // Select by the probe's OWN output-fields spec. Matching on '-n' or a bare
    // '--output-fields=' prefix instead picks up the MAIN query, which carries both
    // — and then the -u assertion below passes/fails for the wrong reason.
    const probe = seen.find((a) => a.includes(PROBE_MARKER));
    expect(probe).toBeDefined();
    expect(seen.length).toBeGreaterThan(1); // main query AND probe both ran
    expect(probe!.join(' ')).toContain('MESSAGE');
    // and it must NOT be narrowed by the caller's unit filter, or an empty unit
    // would masquerade as an empty journal
    expect(probe).not.toContain('-u');
  });
});

/**
 * P-022 (silent-wrong-answers-2026-08-01), building on the same WI-7133 incident.
 *
 * `windowOutsideJournal` above only fires for the subset that is PROVABLY wrong —
 * `since` resolved past the newest record. That leaves the far larger case
 * uncovered: a window that is merely DIFFERENT from the one the caller meant.
 * The result echoed back `since`/`until` as SPECS, which look identical whether
 * they named the intended instant or one four hours away, so a zero-row read
 * still could not say WHICH hours it searched.
 *
 * These pin the fix: on the zero-row path the result states the ABSOLUTE UTC
 * window, and an `until` that crossed `since` — invisible to the probe above,
 * because `since` itself is perfectly fine — is called out as unmatchable by
 * construction.
 */
describe('readJournal — a zero-row result states the window it searched (P-022)', () => {
  /** Resolver keyed by the SPEC, so `since` and `until` can resolve differently. */
  const resolvesBySpec = (bySpec: Record<string, number | null>): WindowResolver =>
    async (spec) => (spec in bySpec ? bySpec[spec] : null);

  it('states the resolved absolute window even when nothing is provably wrong', async () => {
    // The calibration case from the block above — window INSIDE the journal, no
    // diagnosis — is exactly where the old result was least informative and the
    // reader least able to check it by hand.
    const sinceMs = NEWEST_MS - 30 * 60_000;
    const out = await readJournal(
      { units: ['a.service'], since: '-30 min' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(sinceMs),
    );

    expect(out.entries).toEqual([]);
    expect(out.windowOutsideJournal).toBeNull(); // nothing provably wrong…
    expect(out.window.resolved).not.toBeNull(); // …and it STILL says what it searched
    expect(out.window.resolved!.sinceUtc).toBe(new Date(sinceMs).toISOString());
    expect(out.window.resolved!.untilRequested).toBe(false);
    expect(out.window.resolved!.untilUtc).toBeNull();
    expect(out.window.resolved!.invertedHint).toBeNull();
  });

  it('resolves and reports the `until` bound too', async () => {
    const sinceMs = NEWEST_MS - 2 * 3_600_000;
    const untilMs = NEWEST_MS - 3_600_000;
    const out = await readJournal(
      { units: ['a.service'], since: '-2 hours', until: '-1 hour' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesBySpec({ '-2 hours': sinceMs, '-1 hour': untilMs }),
    );

    expect(out.window.resolved!.sinceUtc).toBe(new Date(sinceMs).toISOString());
    expect(out.window.resolved!.untilUtc).toBe(new Date(untilMs).toISOString());
    expect(out.window.resolved!.untilRequested).toBe(true);
    expect(out.window.resolved!.invertedHint).toBeNull();
  });

  it('DIAGNOSES an inverted window — the half the newest-record probe cannot see', async () => {
    // The mixed-grammar shape: a relative `since` (correct) plus a UTC stamp in
    // `until` that a LOCAL-time parser pulls 4h earlier, behind `since`. The
    // existing diagnosis is silent here by construction — `since` is fine — so
    // without this the read is a clean, confident, permanently empty answer.
    const sinceMs = NEWEST_MS - 3_600_000;
    const untilMs = NEWEST_MS - 5 * 3_600_000;
    const out = await readJournal(
      { units: ['a.service'], since: '-1 hour', until: '2026-08-16 20:35:07' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesBySpec({ '-1 hour': sinceMs, '2026-08-16 20:35:07': untilMs }),
    );

    expect(out.entries).toEqual([]);
    expect(out.journalError).toBeNull();
    expect(out.windowOutsideJournal).toBeNull(); // proves this is a NEW answer, not the old one
    const hint = out.window.resolved!.invertedHint;
    expect(hint).not.toBeNull();
    // Name the cause and the fix, not merely the emptiness — same bar as above.
    expect(hint!).toMatch(/INVERTED/);
    expect(hint!).toMatch(/LOCAL/);
    expect(hint!).toMatch(/relative window/i);
    expect(hint!).toContain(new Date(untilMs).toISOString());
    expect(hint!).toContain(new Date(sinceMs).toISOString());
  });

  it('diagnoses an inverted window even when the journal has NO records', async () => {
    // The whole point of the inverted check: the two boundary stamps contradict
    // each other on their own, so it must not inherit windowOutsideJournal's
    // dependence on a newest-entry probe that often cannot answer.
    const out = await readJournal(
      { units: ['a.service'], since: '-1 hour', until: '-5 hours' },
      execEmptyWithNewest(null),
      noUnknownUnits,
      resolvesBySpec({ '-1 hour': NEWEST_MS - 3_600_000, '-5 hours': NEWEST_MS - 5 * 3_600_000 }),
    );

    expect(out.windowOutsideJournal).toBeNull(); // no newest record to compare against
    expect(out.window.resolved!.invertedHint).not.toBeNull();
  });

  it('CALIBRATION: an equal `until` and `since` is NOT inverted', async () => {
    // Boundary. An off-by-one here would fire on a legitimate point-in-time read.
    const out = await readJournal(
      { units: ['a.service'], since: 'x', until: 'y' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesBySpec({ x: NEWEST_MS, y: NEWEST_MS }),
    );
    expect(out.window.resolved!.invertedHint).toBeNull();
  });

  it('an UNRESOLVABLE spec is a null FIELD in a PRESENT object, not an absent window', async () => {
    // The distinction this whole plan is about: "we could not tell" must not
    // render as "there was nothing to tell". `resolved: null` means NOT ATTEMPTED;
    // an attempted-but-unparseable spec reports itself.
    const out = await readJournal(
      { units: ['a.service'], since: 'gibberish' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolvesTo(null),
    );
    expect(out.window.resolved).not.toBeNull();
    expect(out.window.resolved!.sinceUtc).toBeNull();
    expect(out.window.resolved!.invertedHint).toBeNull(); // never guessed from a half-resolved window
  });

  it('does NOT resolve when the read returned rows — resolution is not paid where it buys nothing', async () => {
    const exec: JournalExec = async () => ({ stdout: newestEntryStdout(NEWEST_MS) });
    const out = await readJournal(
      { units: ['a.service'], since: '-30 min' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS - 30 * 60_000),
    );
    expect(out.entries.length).toBe(1);
    expect(out.window.resolved).toBeNull();
  });

  it('does NOT resolve when the read FAILED — the window is not why it is empty', async () => {
    const exec: JournalExec = async () => {
      throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' });
    };
    const out = await readJournal(
      { units: ['a.service'], since: '-30 min' },
      exec,
      noUnknownUnits,
      resolvesTo(NEWEST_MS - 30 * 60_000),
    );
    expect(out.journalError).not.toBeNull();
    expect(out.window.resolved).toBeNull();
  });

  it('does not pay an `until` resolution the caller never asked for', async () => {
    // One exec per bound, and only for bounds that exist. A resolver call for an
    // absent `until` would be a wasted systemd-analyze spawn on every empty read.
    const asked: string[] = [];
    const resolver: WindowResolver = async (spec) => {
      asked.push(spec);
      return NEWEST_MS - 30 * 60_000;
    };
    await readJournal(
      { units: ['a.service'], since: '-30 min' },
      execEmptyWithNewest(NEWEST_MS),
      noUnknownUnits,
      resolver,
    );
    expect(asked).toEqual(['-30 min']);
  });
});
