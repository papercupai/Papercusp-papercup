import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/**
 * Regression guard for EI-21297913810967409 — the CLASS that let EI-21291109975568717 hide.
 *
 * THE BUG: `green-stall-watchdog.ts` runs five passes over the release safety net, each wrapped
 * in a try/catch that emits `console.warn(... (non-fatal))` and returns an empty result. From
 * outside, a pass that CANNOT RUN and a pass that ran and found nothing are indistinguishable —
 * both produce silence. The stranded-pause scan queried a column that does not exist, so
 * Postgres rejected the whole statement on every run for as long as the predicate had been
 * there; the guard never returned a row in its life and the only witness was a console line
 * nobody greps.
 *
 * THE PROPERTY: every one of those swallows now reports its outcome to
 * `recordWatchdogPassOutcome`, which writes `{ lastError, lastErrorAt, consecutiveFailures }`
 * onto the routine row the pass watches and clears it on the next clean pass. The tolerance is
 * deliberately unchanged — one broken scan must not take down the other four. What changes is
 * that it stops being invisible.
 *
 * WHY STATIC: the failure mode is a MISSING call, and nothing at runtime notices an absence. A
 * new pass added later with the same copy-pasted swallow would be silent again, and no
 * behavioural test can fail for a code path nobody wrote. This check fails instead.
 *
 * WHY `finally` AND NOT THE TAIL OF THE TRY: every one of these passes has early `return out`
 * paths (`alreadyAlarmed`, "no deploy target declared"). A clear reached only by the tail would
 * leave a stale marker standing while the pass is in fact succeeding — a watchdog falsely
 * reported broken, which is the same class of wrong reading as the silence being removed. So
 * this file asserts the call site is a `finally`, not merely that it exists somewhere.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) instead of mutating this shared checkout, where the
// git-sync sweep can commit the mutant mid-probe.
const WATCHDOG = process.env.PROBE_WATCHDOG_SRC
  ? resolve(process.env.PROBE_WATCHDOG_SRC)
  : resolve(HERE, 'green-stall-watchdog.ts');
const HEALTH_MODULE = resolve(HERE, 'watchdog-health.ts');

const RECORDER = 'recordWatchdogPassOutcome';

/** How many source lines after the swallow the `finally` may appear within. */
const FINALLY_LOOKAHEAD = 14;

interface SwallowSite {
  line: number; // 1-indexed
  text: string;
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8').split('\n');
}

/**
 * Swallow sites: a `console.warn` whose text carries the `(non-fatal)` marker. Comment lines are
 * excluded — this file documents the pattern in prose in several places, and counting those as
 * sites would inflate the census and hide a real one going missing.
 */
function findSwallowSites(lines: string[]): SwallowSite[] {
  const out: SwallowSite[] = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const trimmed = text.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
    if (!text.includes('console.warn(')) continue;
    if (!text.includes('(non-fatal)')) continue;
    out.push({ line: i + 1, text: trimmed });
  }
  return out;
}

/**
 * The install-scoped recording route inside the watchdog's `run` closure: from the
 * `invokeScopedPass` declaration to the boot `run()` call. Both markers must exist, so a
 * restructure fails loudly here instead of silently widening or emptying the census.
 */
function installScopedRegion(lines: string[]): { start: number; end: number } {
  const start = lines.findIndex((l) => /const invokeScopedPass = \(/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^\s*run\(\);/.test(l));
  expect(start, 'invokeScopedPass declaration not found').toBeGreaterThanOrEqual(0);
  expect(end, 'boot run() call after invokeScopedPass not found').toBeGreaterThan(start);
  return { start, end };
}

/** Pass names given as a string literal to the recorder in `src`. */
function namedRecorderPasses(src: string): string[] {
  return [...src.matchAll(new RegExp(`${RECORDER}\\(\\s*sql,\\s*'([^']+)'`, 'g'))].map((m) => m[1]);
}

/** The declared `WatchdogPassName` union members, read from the writer rather than re-typed. */
function declaredPassNames(): string[] {
  const src = readFileSync(HEALTH_MODULE, 'utf8');
  const block = /export type WatchdogPassName =([\s\S]*?);/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('green-stall-watchdog: every (non-fatal) swallow is observable', () => {
  it('finds the swallow sites at all (coverage control — a guard that inspects nothing passes vacuously)', () => {
    // The instrument check FIRST. Every assertion below is of the form "for each site, ...",
    // which is trivially true of an empty set: rename the log text or restructure the file and
    // this guard would silently degrade to checking nothing while still reporting green. That
    // is precisely the shape of the bug it exists to catch, so the census is pinned explicitly.
    const sites = findSwallowSites(readLines(WATCHDOG));
    expect(sites.length).toBeGreaterThanOrEqual(5);
  });

  it('routes every swallow to the health recorder from a finally block', () => {
    const lines = readLines(WATCHDOG);
    const sites = findSwallowSites(lines);
    const unrouted: string[] = [];

    for (const site of sites) {
      // The `finally` follows its catch block, so look ahead a bounded window from the warn.
      const window = lines.slice(site.line - 1, site.line - 1 + FINALLY_LOOKAHEAD);
      const finallyAt = window.findIndex((l) => /}\s*finally\s*{/.test(l));
      const recordsAfterFinally =
        finallyAt >= 0 && window.slice(finallyAt).some((l) => l.includes(RECORDER));
      if (!recordsAfterFinally) unrouted.push(`${WATCHDOG}:${site.line} — ${site.text}`);
    }

    expect(
      unrouted,
      `These swallowed watchdog failures are invisible again — each needs a \`finally\` calling ` +
        `${RECORDER}(sql, '<pass>', <scope>, passError). See EI-21297913810967409:\n${unrouted.join('\n')}`,
    ).toEqual([]);
  });

  it('records exactly once per swallow — no pass double-reports or shares another pass name', () => {
    const lines = readLines(WATCHDOG);
    const sites = findSwallowSites(lines);
    // The install-scoped passes record through a second, deliberate route (see the next case),
    // so the swallow census excludes that one region and the region is pinned on its own.
    const { start, end } = installScopedRegion(lines);
    const outside = [...lines.slice(0, start), ...lines.slice(end)];
    const calls = outside.filter((l) => !l.trim().startsWith('//') && l.includes(`${RECORDER}(`));
    expect(calls.length).toBe(sites.length);

    // Each call must name a DISTINCT pass, or two passes write over each other's marker and one
    // of them becomes exactly as invisible as before.
    const named = namedRecorderPasses(outside.join('\n'));
    expect(named.length).toBe(sites.length);
    expect(new Set(named).size).toBe(named.length);
  });

  it('records each install-scoped pass once when it throws, and once each when the install read fails', () => {
    // runInstallScopedWatchdogs runs one handler per pass per install. A handler that rejects is
    // recorded by invokeScopedPass's single generic call; if the install-scope read itself fails,
    // no handler ran, so the fan-out records every scoped pass once. A pass missing from the
    // fan-out is invisible exactly when the read is broken; a name listed twice double-reports.
    const lines = readLines(WATCHDOG);
    const { start, end } = installScopedRegion(lines);
    const region = lines.slice(start, end);
    const text = region.join('\n');

    const scoped = [...text.matchAll(/invokeScopedPass\(\s*'([^']+)'/g)].map((m) => m[1]);
    expect(scoped.length).toBeGreaterThanOrEqual(1);
    expect(new Set(scoped).size).toBe(scoped.length);

    const fanout = namedRecorderPasses(text);
    expect([...fanout].sort()).toEqual([...scoped].sort());

    const calls = region.filter((l) => !l.trim().startsWith('//') && l.includes(`${RECORDER}(`));
    // one generic call inside invokeScopedPass + one named call per scoped pass, nothing else
    expect(calls.length).toBe(fanout.length + 1);
    expect(calls.filter((l) => new RegExp(`${RECORDER}\\(\\s*sql,\\s*pass,`).test(l))).toHaveLength(1);
  });

  it('uses only pass names the writer actually declares (a typo would create a phantom key)', () => {
    // A misspelled pass name is not a type error at the call site if the union ever widens to
    // `string`, and it would write a marker under a key no reader looks for.
    const declared = declaredPassNames();
    expect(declared.length).toBeGreaterThanOrEqual(5);

    const src = readFileSync(WATCHDOG, 'utf8');
    const named = [...src.matchAll(new RegExp(`${RECORDER}\\(\\s*sql,\\s*'([^']+)'`, 'g'))].map((m) => m[1]);
    expect(named.filter((n) => !declared.includes(n))).toEqual([]);
  });

  it('keeps the swallow NON-FATAL — the fix is visibility, not intolerance', () => {
    // If a future edit "fixes" this by rethrowing, one broken scan takes down the other four.
    // The passes must still return their empty result.
    const lines = readLines(WATCHDOG);
    const sites = findSwallowSites(lines);
    const rethrows: string[] = [];
    for (const site of sites) {
      const window = lines.slice(site.line - 1, site.line - 1 + 4);
      if (window.some((l) => /^\s*throw\b/.test(l))) rethrows.push(`${WATCHDOG}:${site.line}`);
    }
    expect(rethrows).toEqual([]);
  });
});
