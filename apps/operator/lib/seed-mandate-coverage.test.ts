import { describe, it, expect } from 'vitest';
import { ALL_PAIRS } from '@papercusp/operator-core/lib/bash-substitution/pairs/index';
import type { SubstitutionPair } from '@papercusp/operator-core/lib/bash-substitution/types';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain .mjs launcher script, no type declarations (same import shape
// psu-launcher.test.ts uses).
import { claudeSeedToolNames } from '../scripts/psu-launcher.mjs';
import {
  MANDATE_SEED_EXEMPT,
  isMcpToolName,
  promotedMandateToolNames,
  seedMandateGaps,
  staleExemptions,
} from './seed-mandate-coverage';

/**
 * P-004 of psu-seed-prompt-mandate-alignment-2026-08-09 — the guard for the class
 * behind WI-37534, EI-19500729376783421 and EI-19321552629556165: a tool the
 * PROMPTS mandate that the SEED never advertises reads to an agent as "this tool
 * does not exist".
 */
describe('seed ↔ prompt-mandate coverage (P-004)', () => {
  const seed: string[] = claudeSeedToolNames({});

  it('sees a genuinely-populated registry and seed (a vacuous green is worse than a red)', () => {
    // Both inputs can degrade to empty without erroring, and an empty input makes
    // every assertion below pass while measuring nothing — the exact shape that let
    // `listAllProjectedTools()` report "0 violations" from a standalone probe
    // (EI-19377066316560032). Floors first, so a broken import is loud.
    expect(ALL_PAIRS.length).toBeGreaterThan(10);
    // EI-23319364088969722: this floor is a BROKEN-IMPORT TRIPWIRE, not a seed budget.
    // It was 30 when the seed was 64 names; the seed is now a deliberate 31-name minimal
    // list (measured 432,714 B -> 113,588 B on the wire), so a floor just under it would
    // fail on an intentional trim instead of on the defect it exists to catch — and the
    // defect is always the SAME shape: a failed import yields 0. Keep it comfortably below
    // the intended size and well above 0.
    expect(seed.length).toBeGreaterThan(12);
    // The sharper non-vacuity check for a minimal seed: a seed that degraded to junk would
    // not carry the two verbs the whole trim depends on for catalog reachability.
    expect(seed).toContain('tools:invoke');
    expect(seed).toContain('tools:find');
    expect(promotedMandateToolNames(ALL_PAIRS).length).toBeGreaterThan(5);
  });

  it('every promoted routing-table mandate is seeded or explicitly exempt', () => {
    const gaps = seedMandateGaps(seed, ALL_PAIRS);
    expect(
      gaps,
      gaps.length
        ? `\n\nUNREACHABLE MANDATE(S) — the prompts route agents to these, the seed does not advertise them:\n` +
          gaps.map((g) => `  • ${g.tool}\n      ${g.hint}`).join('\n') +
          `\n\nFIX ONE OF TWO WAYS:\n` +
          `  (a) REGENERATE the maintained delivery map with npm run gen:tool-delivery.\n` +
          `      Routing-table mandates are derived floors for the default seed;\n` +
          `      the historical full-seed literals do not control that seed.\n` +
          `  (b) EXEMPT it — add to MANDATE_SEED_EXEMPT with the MEASUREMENT that justifies\n` +
          `      it (reaches/callers over 14d + wire bytes). Seeding is not free: plan D-001\n` +
          `      budgets the tools/list WIRE payload, which argSchema dominates.\n`
        : undefined,
    ).toEqual([]);
  });

  it('carries no exemption for a tool that is no longer a promoted mandate', () => {
    // Keeps the exempt list honest: a stale entry silently re-permits a gap if the
    // tool is ever re-promoted.
    expect(staleExemptions(ALL_PAIRS)).toEqual([]);
  });

  it('every exemption states its evidence, not just an opinion', () => {
    for (const [tool, reason] of MANDATE_SEED_EXEMPT) {
      expect(reason.length, `${tool}: exemption reason is too thin to audit`).toBeGreaterThan(40);
      expect(
        /\d/.test(reason),
        `${tool}: exemption cites no NUMBER. An exemption is a budget decision; it needs the ` +
          `measurement (reaches/callers/bytes) that justifies it, or the next auditor cannot tell ` +
          `a considered call from a shrug.`,
      ).toBe(true);
    }
  });

  it('ignores registry entries that are not callable MCP tools', () => {
    // `gitnexus.context` is a dot-namespaced plugin tool and `npm run install:safe` is a
    // shell command — neither is seedable via ?tools=, so demanding it would be incoherent.
    expect(isMcpToolName('gitnexus.context')).toBe(false);
    expect(isMcpToolName('npm run install:safe')).toBe(false);
    expect(isMcpToolName('capability:read')).toBe(true);
    expect(isMcpToolName('work_items:claimable')).toBe(true);
    expect(isMcpToolName('dev:pg_query')).toBe(true);
  });

  // ── FALSIFIABILITY CONTROLS ────────────────────────────────────────────────
  // A guard that has never failed is a guard nobody has tested. These prove it CAN
  // fail, and they live permanently in the test file rather than being demonstrated
  // by mutating the tree — the copy-out/in-place tiers of the repo's own
  // falsifiability guidance exist because a probe that edits a shared file can be
  // committed by the git-sync sweep mid-run (db6d7b02b1). Nothing here touches disk.

  it('CONTROL: reports a gap when a mandated tool is absent from the seed', () => {
    const mandated = promotedMandateToolNames(ALL_PAIRS).find(
      (t) => !MANDATE_SEED_EXEMPT.has(t) && seed.includes(t),
    );
    expect(mandated, 'expected at least one seeded, non-exempt mandate to use as a control').toBeTruthy();

    const crippled = seed.filter((t) => t !== mandated);
    const gaps = seedMandateGaps(crippled, ALL_PAIRS);
    expect(gaps.map((g) => g.tool)).toContain(mandated);
  });

  it('CONTROL: reports a gap for a NEWLY promoted mandate nobody has seeded yet', () => {
    // The real-world trigger: someone adds a substitution pair and never touches the
    // seed. Uses a synthetic pair so the control cannot rot when the registry changes.
    const invented = { toolName: 'notreal:verb', expectedVerdict: 'equivalent' } as SubstitutionPair;
    const gaps = seedMandateGaps(seed, [...ALL_PAIRS, invented]);
    expect(gaps.map((g) => g.tool)).toContain('notreal:verb');
  });

  it('CONTROL: does NOT report a gap for a pair the table never promotes', () => {
    // Guards the opposite error — a guard that fires on un-promoted rows would push
    // people to seed tools the docs never actually route them to.
    const notPromoted = {
      toolName: 'alsonotreal:verb',
      expectedVerdict: 'not-a-substitute',
      policyTier: null,
    } as unknown as SubstitutionPair;
    const gaps = seedMandateGaps(seed, [...ALL_PAIRS, notPromoted]);
    expect(gaps.map((g) => g.tool)).not.toContain('alsonotreal:verb');
  });
});
