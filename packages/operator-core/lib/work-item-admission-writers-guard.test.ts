/**
 * The admission-writers GUARD's own correctness + its blocking-path execution
 * (plan work-queue-admission-and-bulk-dedup-2026-08-24, P-002 item e).
 *
 * Two jobs, and the second is why this is a `.test.ts` rather than only an npm
 * script: `check-lint-guard-reachability.mjs` classifies a `lint:*` script as
 * BLOCKING when a test EXECUTES it over the real tree. A guard on no blocking path
 * is not a guard — it rots, accrues false positives unseen, and then fails closed on
 * innocent files the day someone wires it up (WI-6683 / EI-19452618085391226).
 *
 *   1. PREDICATE correctness against synthetic sources — a guard that only ever runs
 *      against a clean tree would pass identically if its predicate were
 *      `return false`. The deliberately-wrong control below makes that falsifiable.
 *   2. THE REAL TREE has no unstamped work-item writer.
 */
import { describe, it, expect } from 'vitest';
import {
  isUnstampedWorkItemWriter,
  mintsWorkItems,
  ALLOWLIST,
  scan,
} from '../../../scripts/check-work-item-admission-writers.mjs';

/** A path in no map, so only the PREDICATE decides the verdict. */
const NEW = 'packages/operator-core/lib/brand-new-filer.ts';

const RAW_FILER = `
import { createWorkItem } from './work-items';
export async function file(title: string) {
  return createWorkItem({ kind: 'bug', title, createdBy: 'me' });
}`;

/**
 * THE PERMANENTLY-WRONG CONTROL (falsifiability without mutating the shared tree —
 * an in-tree mutation probe would be committed by the git-sync sweep while it ran).
 *
 * It is the guard someone reaches for first: "does the file contain the literal
 * `admission: 'pending'`?". That is wrong in BOTH directions, and each case below
 * asserts the real predicate disagrees with it — which is what makes those cases
 * discriminating rather than green against any predicate at all.
 */
const LITERAL_PENDING_PREDICATE = (source: string): boolean =>
  /createWorkItem\s*\(|createIssue\s*\(/.test(source) && !/admission:\s*'pending'/.test(source);

describe('isUnstampedWorkItemWriter (the predicate)', () => {
  it('FAILS a new filer that never decides admission', () => {
    expect(isUnstampedWorkItemWriter(NEW, RAW_FILER)).toBe(true);
  });

  it('passes once the filer stamps born-pending', () => {
    const stamped = RAW_FILER.replace('kind:', "admission: 'pending', kind:");
    expect(isUnstampedWorkItemWriter(NEW, stamped)).toBe(false);
  });

  it('passes a filer that decides the OTHER way — an explicit bypass is a decision too', () => {
    const bypassed = RAW_FILER.replace('kind:', "admission: 'auto', admittedBy: 'bypass:plan-item', kind:");
    expect(isUnstampedWorkItemWriter(NEW, bypassed)).toBe(false);
    // DISCRIMINATING: the naive control still fails this file, because it only ever
    // looks for the literal 'pending'. A bypass is a judged answer, not a miss.
    expect(LITERAL_PENDING_PREDICATE(bypassed)).toBe(true);
  });

  it('passes a filer that FORWARDS admission from its caller', () => {
    const forwarding = RAW_FILER.replace('kind:', 'admission: input.admission, kind:');
    expect(isUnstampedWorkItemWriter(NEW, forwarding)).toBe(false);
    expect(LITERAL_PENDING_PREDICATE(forwarding)).toBe(true);
  });

  it('does NOT let PROSE about admission buy an exemption the code never earned', () => {
    // The false-negative direction — the one that silently loses real findings.
    const proseOnly = `// TODO: decide admission for this filer one day.\n${RAW_FILER}`;
    expect(isUnstampedWorkItemWriter(NEW, proseOnly)).toBe(true);
  });

  it('does NOT flag a file that merely DISCUSSES createWorkItem in a comment', () => {
    const docOnly = `/** Historically this called createWorkItem() directly. */\nexport const x = 1;`;
    expect(mintsWorkItems(NEW, docOnly)).toBe(false);
    // DISCRIMINATING: the naive control scores this doc-only file an offender.
    expect(LITERAL_PENDING_PREDICATE(docOnly)).toBe(true);
  });

  it('sees a minting call behind a DI seam (`deps.createIssue(...)`)', () => {
    const viaDeps = `export const f = (deps, i) => deps.createIssue(i);`;
    expect(mintsWorkItems(NEW, viaDeps)).toBe(true);
  });

  it('honours the allowlist, and every entry states a reason', () => {
    const [firstAllowed] = [...ALLOWLIST.keys()];
    expect(firstAllowed).toBeTruthy();
    expect(isUnstampedWorkItemWriter(firstAllowed as string, RAW_FILER)).toBe(false);
    for (const [path, reason] of ALLOWLIST) {
      expect(typeof reason, `${path} needs a reason`).toBe('string');
      expect((reason as string).length, `${path}'s reason is too thin to review`).toBeGreaterThan(40);
    }
  });
});

describe('the real tree', () => {
  it('has no work-item writer that mints without deciding admission', () => {
    // Use the exact population and verdict function the CLI uses. The count is a
    // positive control: a broken/empty scan cannot make this pass vacuously.
    const { minting, offenders } = scan();
    expect(minting.length, 'scan found no work-item writers at all — the instrument is broken').toBeGreaterThan(5);
    expect(offenders).toEqual([]);
  });
});
