/**
 * EI-27112155694647220 — the WIRING guard for the no-code-change prefill skip.
 *
 * `completion-prefill.test.ts` proves the behaviour (`prefillOptionsForDeclaredKinds` resolves the
 * effective kinds; `prefillCompletionFromMechanics` leaves an explicit `filesChanged: []` alone when
 * told to). Neither fails if `complete.ts` stops passing those options to the prefill, or resolves
 * the kinds from something other than what the caller declared at close. That gap is the bug this
 * file guards: before the fix, a holder closing an item with `changeKinds: ['no-code-change']` and
 * `filesChanged: []` had the list back-filled with its claim-window edits for OTHER items, and the
 * change-kind gate then refused the close for listing changed paths.
 *
 * Source-level, like `complete.change-kinds.test.ts`, so it adds no fingerprint to the handler
 * suite that other plans' spec evidence measures.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';

const source = readFileSync(nodePath.join(__dirname, 'complete.ts'), 'utf8');

/** The prefill block, from the mechanics read to the evidence the gates read. */
function prefillBlock(): string {
  const start = source.indexOf("const mechanics = await track('mechanics'");
  const end = source.indexOf('const completionEvidenceForGate = completionEvidenceFromRecord(it.completion);', start);
  expect(start, 'the prefill block must exist in complete.ts').toBeGreaterThan(-1);
  expect(end, 'the prefill must run before the gates read the evidence').toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('complete.ts passes the no-code-change skip into the completion prefill (EI-27112155694647220)', () => {
  it('the prefill call receives the options resolved for this close', () => {
    expect(prefillBlock()).toMatch(
      /prefillCompletionFromMechanics\(it\.completion, mechanics, prefillOptions\)/,
    );
  });

  it('the options come from the shared resolver, fed the kinds the caller declared at close', () => {
    const block = prefillBlock();
    expect(block).toMatch(/await prefillOptionsForDeclaredKinds\(\{\s*\n\s*declaredAtClose: it\.changeKinds,/);
    expect(source).not.toMatch(/function\s+prefillOptionsForDeclaredKinds\s*\(/);
  });

  it('with nothing declared at close, the stored declaration for this item is read', () => {
    expect(prefillBlock()).toMatch(/readChangeKinds\(kindsWorkspace, prefillKindIds\)/);
  });

  it('the resolution only runs when the ledger could fill filesChanged', () => {
    expect(prefillBlock()).toMatch(
      /mechanics && mechanics\.filesWritten\.paths\.length > 0 && !completionSuppliesField\(it\.completion, 'filesChanged'\)/,
    );
  });
});
