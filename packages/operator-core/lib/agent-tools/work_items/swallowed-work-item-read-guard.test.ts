/**
 * Recurrence guard for WI-6746 — `getWorkItem(...).catch(...)` must not come back.
 *
 * `getWorkItem` returns null ONLY for a zero-row result; it never catches, so a PG fault
 * throws through it. Swallowing that to null collapses "it is not there" with "I could not
 * ask", and two SAFETY GUARDS that derived their refusal from the collapsed value therefore
 * FAILED OPEN exactly when the database was unhealthy (work_items:claim's claim-hold guard,
 * work_items:checkpoint's not_holder guard — neither underlying write re-checks). Use
 * `lookupWorkItem()` from ./_lookup instead, and match on `status`.
 *
 * WHY A GUARD AND NOT A ONE-OFF SWEEP: the bad sites were found by a scripted scan, not by
 * reading — a hand grep only encodes the call forms you happened to think of that day, and
 * one written an hour earlier had already missed them.
 *
 * WHY IT COUNTS OCCURRENCES RATHER THAN ALLOWLISTING FILES (WI-6727's lesson, paid for once
 * already): a FILE-granular allowlist answers "is this file known?", which stays truthfully
 * green while a SECOND, unreviewed seam is added a few lines below the reviewed one.
 *
 * WHY THE SCANNER IS PAREN-BALANCED AND COMMENT-STRIPPED rather than one regex: the regex
 * version of this guard was written first and was WRONG in both directions — it matched
 * this file's own prose describing the bug, and it spanned from a `getWorkItem(...)` across
 * an unrelated ternary into a `.catch(` belonging to a different expression. It would have
 * red-flagged three innocent files on its first run. The scanner is therefore itself under
 * test below ("the scanner detects what it claims to detect"): a guard nobody has proven
 * can FAIL is not evidence of anything.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIB_ROOT = join(__dirname, '..', '..');

/**
 * Sites where collapsing "missing" and "unreadable" is genuinely harmless: the value is a
 * DECORATION or a query NARROWING, and nothing downstream asserts on it — no prose claiming
 * the item is absent, no guard deciding whether to proceed. That is the whole triage rule.
 * If a site's null ever starts feeding an assertion, it belongs in the fix, not in here.
 */
const ALLOWED: { file: string; count: number; why: string }[] = [
  {
    file: 'handoff-context.ts',
    count: 1,
    why: 'predecessor-item enrichment for a handoff brief — an absent predecessor omits a hint line; nothing asserts the item does not exist',
  },
  {
    file: 'external-bench/hive-backlog-live.ts',
    count: 1,
    why: 'bench harness reporting — a skipped row costs a bench datapoint, never a guard decision or a claim about absence',
  },
  {
    file: 'fleet/placement-gather.ts',
    count: 1,
    why: 'placement candidate enrichment — an unreadable item is simply not enriched; placement never concludes it is absent',
  },
  {
    file: 'agent-tools/work_items/_assumptions.ts',
    count: 1,
    why: 'DELIBERATE fail-open (documented at the site): the harness derive only NARROWS an assumption selector, so a blip degrades to "no harness selector" — the pre-existing behaviour — rather than refusing a close. Nothing asserts absence from it',
  },
  {
    file: 'harness/improvements/capture-core.ts',
    count: 1,
    why: 'withPromotionReviewEnrolment refreshes a known committed promotion after review enrolment. A missing or unreadable optional refresh returns that promoted issue, never absence; capture-core.test.ts exercises both outcomes through the real promotion path.',
  },
];

/** Every .ts file under operator-core/lib, excluding tests. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts') && !entry.endsWith('.d.ts')) acc.push(full);
  }
  return acc;
}

/** Blank out comments so prose ABOUT the bug never counts as an instance OF it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, '');
}

/** Index of the `)` closing the `(` at `openIdx`, or -1. */
function matchParen(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const READERS = /\b(getWorkItem|getIssue|getFeatureWorkItemOnly)\s*\(/g;

/**
 * Count reads whose OWN promise chain ends in `.catch(` — matching any handler, not just
 * `() => null`, since `.catch(() => undefined)` collapses the same two facts.
 */
export function countSwallowedReads(rawSrc: string): number {
  const src = stripComments(rawSrc);
  let n = 0;
  for (const m of src.matchAll(READERS)) {
    const open = src.indexOf('(', m.index);
    const close = matchParen(src, open);
    if (close < 0) continue;
    let i = close + 1;
    for (;;) {
      const link = src.slice(i).match(/^\s*\.\s*(then|finally|catch)\s*\(/);
      if (!link) break;
      if (link[1] === 'catch') {
        n++;
        break;
      }
      const linkOpen = src.indexOf('(', i + link[0].length - 1);
      const linkClose = matchParen(src, linkOpen);
      if (linkClose < 0) break;
      i = linkClose + 1;
    }
  }
  return n;
}

function swallowedSites(): Map<string, number> {
  const found = new Map<string, number>();
  for (const full of sourceFiles(LIB_ROOT)) {
    const n = countSwallowedReads(readFileSync(full, 'utf8'));
    if (n > 0) found.set(full.slice(LIB_ROOT.length + 1), n);
  }
  return found;
}

describe('the scanner detects what it claims to detect', () => {
  it('counts the exact pre-fix shape', () => {
    expect(countSwallowedReads('const item = await getWorkItem(args.id, hint).catch(() => null);')).toBe(1);
  });

  it('counts a swallow reached through a .then chain, and any handler shape', () => {
    expect(countSwallowedReads('await getWorkItem(id).then((wi) => wi?.harness ?? null).catch(() => null);')).toBe(1);
    expect(countSwallowedReads('await getWorkItem(id).catch(() => undefined);')).toBe(1);
    expect(countSwallowedReads('await getWorkItem(id).catch((e) => { log(e); return null; });')).toBe(1);
  });

  it('does NOT count the fixed shape', () => {
    expect(countSwallowedReads('const l = await lookupWorkItem(args.id, hint);')).toBe(0);
    expect(countSwallowedReads('const item = await getWorkItem(args.id, hint);')).toBe(0);
  });

  it('does NOT count prose in comments — the false positive that broke the first version', () => {
    expect(countSwallowedReads('// getWorkItem(x).catch(() => null) is the bug this file guards')).toBe(0);
    expect(countSwallowedReads('/**\n * `getWorkItem(...)` ... `.catch(` ...\n */')).toBe(0);
  });

  it('does NOT span past its own call into an unrelated .catch — the other false positive', () => {
    const src = 'const a = ids.map((id) => getWorkItem(id, h)).filter(Boolean);\nconst b = other(x).catch(() => null);';
    expect(countSwallowedReads(src)).toBe(0);
  });

  it('counts each occurrence separately within one file', () => {
    expect(countSwallowedReads('getWorkItem(a).catch(() => null); getWorkItem(b).catch(() => null);')).toBe(2);
  });
});

describe('WI-6746 — a swallowed work-item read must not render as absence', () => {
  it('no un-allowlisted site swallows a work-item read', () => {
    const found = swallowedSites();
    const allowed = new Map(ALLOWED.map((a) => [a.file, a]));
    const offenders = [...found.entries()].filter(([file]) => !allowed.has(file));

    expect(
      offenders.map(([file, n]) => `${file} (${n} site${n === 1 ? '' : 's'})`),
      'A read failure must not be indistinguishable from "item absent". Use lookupWorkItem() ' +
        'from agent-tools/work_items/_lookup and match on status: unreadable => refuse/report ' +
        'the read failure (FAIL CLOSED if the value gates a guard), missing => the honest ' +
        'not-found. If the value is genuinely only a decoration that nothing asserts on, add ' +
        'it to ALLOWED here with a why that says what would break if it were wrong.',
    ).toEqual([]);
  });

  it('every allowlisted file still has exactly the reviewed number of swallowed reads', () => {
    // Occurrence-granular on purpose: a second, unreviewed swallow added to an
    // already-allowlisted file must fail here rather than inherit its neighbour's exemption.
    const found = swallowedSites();
    expect(
      ALLOWED.map((a) => `${a.file}=${found.get(a.file) ?? 0}`),
      'A count mismatch means a swallowed read was ADDED to (or removed from) an allowlisted file — review the new site on its own merits, do not just bump the count.',
    ).toEqual(ALLOWED.map((a) => `${a.file}=${a.count}`));
  });

  it('the allowlist has no stale entries (a fixed site must be removed from it)', () => {
    const found = swallowedSites();
    expect(
      ALLOWED.filter((a) => !found.has(a.file)).map((a) => a.file),
      'These files no longer swallow a work-item read — drop them from ALLOWED so it keeps describing reality.',
    ).toEqual([]);
  });

  it('the fixed surfaces route through lookupWorkItem rather than a bare swallow', () => {
    // Pins the POSITIVE half: a revert that removed the fail-closed handling would otherwise
    // only surface here if it also re-added a `.catch`.
    const fixed = [
      'agent-tools/work_items/claim.ts',
      'agent-tools/work_items/checkpoint.ts',
      'agent-tools/work_items/hold_open.ts',
      'agent-tools/work_items/park.ts',
      'agent-tools/work_items/request_release.ts',
      'agent-tools/work_items/decline_release_request.ts',
    ];
    expect(
      fixed.filter((f) => !readFileSync(join(LIB_ROOT, f), 'utf8').includes('lookupWorkItem')),
      'These surfaces derive a guard or an error message from a work-item read and must use lookupWorkItem().',
    ).toEqual([]);
  });
});
