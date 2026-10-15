/**
 * auto-close-listopen-scope.test.ts — WI-4532.
 *
 * The recurrence guard for a defect that shipped BECAUSE it was untestable by the
 * existing suite: every other auto-close test injects a fake `AutoCloseDeps`, so the
 * REAL `defaultAutoCloseDeps().listOpen` query had zero coverage. The bug lived there.
 *
 * THE DEFECT (measured on the live box 2026-08-04): `listOpen` read
 * `listIssues({ state:'open', limit:500 })` and the sweep then narrowed to watchdog
 * items in JS. But that read is `ORDER BY created_at DESC LIMIT n`, so post-filtering
 * in JS yields "watchdog items among the 500 NEWEST issues" — a RECENCY WINDOW, not a
 * set. With 17,154 open bug|change issues that window was ~7.5 HOURS wide. A watchdog
 * item that went green after ageing out could never be auto-resolved: the watchdog
 * could raise an alarm but never lower it, which is precisely what WI-4532 filed
 * (EI-18691336095110558 sat open 9 days while its named test recorded 46 passing runs).
 *
 * WHY THIS ASSERTION AND NOT A ROW-COUNT ONE: the failure is not "too few rows", it is
 * "the wrong SELECTION RULE". Only pushing the predicate into SQL turns the window back
 * into a set, so the guard pins the predicate's PLACEMENT. Raising the cap is not an
 * alternative fix and must not be mistaken for one — ISSUES_MAX_LIMIT is 2000 against
 * 17,154 open rows, so no legal limit covers the backlog.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const listIssuesSpy = vi.fn(async (_filter: unknown) => [] as unknown[]);

vi.mock('../../issues-engineer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../issues-engineer')>();
  return { ...actual, listIssues: (f: unknown) => listIssuesSpy(f) };
});

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: Object.assign(() => undefined, { unsafe: () => undefined }) }),
}));

import { defaultAutoCloseDeps, AUTO_CLOSE_CENSUS_LIMIT, AUTO_CLOSE_ELIGIBLE_SOURCES } from './auto-close';

describe('WI-4532: defaultAutoCloseDeps().listOpen must select watchdog items in SQL', () => {
  beforeEach(() => listIssuesSpy.mockClear());

  it('pushes the watchdog-keyed predicate INTO the read (not a JS post-filter)', async () => {
    await defaultAutoCloseDeps('papercusp-workspace').listOpen();

    expect(listIssuesSpy).toHaveBeenCalledTimes(1);
    const filter = listIssuesSpy.mock.calls[0][0] as Record<string, unknown>;

    // The whole fix. Without this the LIMIT below silently becomes a recency horizon.
    expect(
      filter.watchdogKeyed,
      'listOpen must pass watchdogKeyed:true — a JS post-filter over an ' +
        'ORDER BY created_at DESC LIMIT read is a recency window, not a set (WI-4532)',
    ).toBe(true);

    expect(filter.state).toBe('open');
  });

  it('does not attempt to solve the horizon by raising the cap (ISSUES_MAX_LIMIT=2000 < the backlog)', async () => {
    await defaultAutoCloseDeps('papercusp-workspace').listOpen();
    const filter = listIssuesSpy.mock.calls[0][0] as Record<string, unknown>;

    // A future edit that drops watchdogKeyed and bumps the limit instead would restore
    // the bug in a form that LOOKS fixed. Any limit is fine ONLY while the predicate is
    // in SQL; this pins that the cap is not doing the work.
    expect(filter.watchdogKeyed).toBe(true);
    expect(typeof filter.limit === 'number' && (filter.limit as number) > 0).toBe(true);
  });

  // WI-10005102: `watchdogKeyed` alone became a window again (11,598 open watchdog rows on
  // 2026-10-01, 9,615 of them repeated-tool-error with no source-level close route). The
  // census must be narrowed, in SQL, to rows a closing route can act on.
  it('narrows the census to closing routes in SQL, including red-test (WI-10005102)', async () => {
    await defaultAutoCloseDeps('papercusp-workspace').listOpen();
    const filter = listIssuesSpy.mock.calls[0][0] as {
      watchdogCloseRoutes?: { closableSources: readonly string[] };
      includeBody?: boolean;
    };

    expect(filter.watchdogCloseRoutes, 'listOpen must pass watchdogCloseRoutes (WI-10005102)').toBeDefined();
    const sources = new Set(filter.watchdogCloseRoutes!.closableSources);
    // Every absence-closable source, or a quiet tick can never close it.
    for (const s of AUTO_CLOSE_ELIGIBLE_SOURCES) expect(sources.has(s), `missing absence source ${s}`).toBe(true);
    // red-test is not absence-closable but has the positive green-run route.
    expect(sources.has('red-test')).toBe(true);
    // repeated-tool-error closes only via the row-level repair-evidence branch; listing the
    // whole source here would re-admit its ~9,600 rows and restore the window.
    expect(sources.has('repeated-tool-error')).toBe(false);
    expect(filter.includeBody).toBe(false);
  });

  it('reports a saturated census instead of treating a full page as the whole set', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    listIssuesSpy.mockResolvedValueOnce(new Array(AUTO_CLOSE_CENSUS_LIMIT).fill({}));
    await defaultAutoCloseDeps('papercusp-workspace').listOpen();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('census read SATURATED'));
    warn.mockRestore();
  });
});
