import { describe, expect, it } from 'vitest';
import {
  OWNER_QUOTE_BANNER,
  applyOwnerQuoteProvenance,
  claimsOwnerQuote,
} from './owner-quote-provenance';

// EI-26515229747561182 — a memory that attributes words to the owner arrived at
// recall with full apparent authority for two months after its quote was shown to
// come only from machine-generated compaction summaries.
describe('claimsOwnerQuote', () => {
  it.each([
    // The incident's own wording (name replaced).
    'DESKTOP RELEASE CUTS MUST COME FROM THE LATEST GREEN `main`. Owner directive, Jane, 2026-08-13, verbatim: "the cuts should only come from the latest main gate"',
    'Decisions settled in discussion [owner:Jane 2026-09-22] (1) every owner-typed message is a directive',
    "The owner's instruction was to keep the gate frozen.",
    'The owner said to never deploy past a red gate.',
    'Quoted verbatim from the owner: "ship it on Friday".',
  ])('flags an owner attribution: %s', (text) => {
    expect(claimsOwnerQuote(text)).toBe(true);
  });

  it.each([
    'release:deploy force is owner-gated and loud.',
    'The owner-only flag lives in libs/flags/src/types.ts.',
    'Ask the owner before spending money.',
    'git-sync commits the tree verbatim on a schedule.',
    'PLUR is decommissioned; plur_* tools are dead.',
  ])('does not flag a mere mention: %s', (text) => {
    expect(claimsOwnerQuote(text)).toBe(false);
  });
});

describe('applyOwnerQuoteProvenance', () => {
  it('prepends the banner and the structured verdict to a claimed owner quote', () => {
    const body = 'Owner directive, Jane, 2026-08-13, verbatim: "cut from main".';
    const [row] = applyOwnerQuoteProvenance([{ id: 'm1', memory: body, score: 0.9 }]);
    expect(row.memory).toBe(`${OWNER_QUOTE_BANNER}${body}`);
    expect(row.provenance).toEqual({ owner_quote: 'unverified' });
    expect(row.score).toBe(0.9);
  });

  it('returns a row that claims nothing untouched and by identity', () => {
    const rows = [{ id: 'm1', memory: 'tests ship with the feature', score: 0.5 }];
    const out = applyOwnerQuoteProvenance(rows);
    expect(out[0]).toBe(rows[0]);
  });

  it('is idempotent: a second pass does not stack a second banner', () => {
    const once = applyOwnerQuoteProvenance([{ id: 'm1', memory: 'The owner said ship it.' }]);
    const twice = applyOwnerQuoteProvenance(once);
    expect(twice[0].memory).toBe(once[0].memory);
  });

  it('keeps the warning inside orient\'s 200-char per-hit clip, ahead of a stale banner', () => {
    const stale = '⚠ STALE — dead anchors: file:packages/x.ts. Verify, don\'t rely. ';
    const [row] = applyOwnerQuoteProvenance([{ id: 'm1', memory: `${stale}The owner said ${'x'.repeat(400)}` }]);
    const folded = String(row.memory).slice(0, 200);
    expect(folded.startsWith(OWNER_QUOTE_BANNER)).toBe(true);
    expect(folded).toContain('STALE');
  });

  it('ignores rows without a string body', () => {
    const rows = [{ id: 'm1', memory: 42 }, { id: 'm2' }];
    const out = applyOwnerQuoteProvenance(rows as Array<Record<string, unknown>>);
    expect(out[0]).toBe(rows[0]);
    expect(out[1]).toBe(rows[1]);
  });
});
