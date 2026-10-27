/**
 * AUTO-BAR-R-7-P-009 — the published tool-delivery doc must state the MEASURED
 * before/after bytes alongside the two corrections (callers-not-calls; three tiers not
 * two). Sibling of `gate-candidate-ref.test.ts`, same doc-claims family.
 *
 * The FIXTURE CONTROLS are load-bearing for the reason the siblings state: once the live
 * assertion goes green it stops being evidence that the detector works at all. Each
 * fixture reproduces a shape that MUST be caught — above all the "impressive numbers that
 * do not reconcile" case, because that is what a hand-updated doc looks like after the
 * generator has moved underneath it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { judgeToolDeliveryDoc } from './tool-delivery-doc-measurements';
import { measureToolDeliveryHalves } from '../../../../scripts/gen-tool-delivery';
import { getEncoding } from 'js-tiktoken';
import { compactInputSchema, summaryGuidanceDescription } from '@papercusp/tooldef';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOC = join(
  ROOT,
  'apps/operator-docs/src/content/docs/agent-insights/how-tool-definition-delivery-is-decided.mdx',
);

/** A minimal body that PASSES, used as the base each control mutates one way. */
const GOOD = `
Rank by distinct callers, not by raw invocation count.
There are three tiers: full, compact and deferred.
\`\`\`
WIRE_BYTES       full=1599477  compact=649761  savedByCompact=949716
GUIDANCE_BYTES   full=334797   summary=81030   savedBySummary=253767
DEFINITION_BYTES  full=369616  compact=100418  savedByCompact=269198
DEFINITION_TOKENS full=109945  compact=38329   savedByCompact=71616 provenance=measured
SCHEMA_BYTES full=2000 compact=1200 savedByCompact=800
SCHEMA_TOKENS full=900 compact=600 savedByCompact=300 provenance=measured tokenizer=o200k_base scope=fixture serialization=JSON.stringify
GUIDANCE_TOKENS full=100 summary=20 savedBySummary=80 provenance=measured tokenizer=o200k_base scope=fixture serialization=raw-description
DEFS_N1_BYTES  refs=1  inlined=800   referenced=855  addedByFactoring=55
DEFS_N2_BYTES  refs=2  inlined=1526  referenced=941  savedByFactoring=585
\`\`\`
The byte figure is an UPPER BOUND on the context actually saved.
`;

describe('fixture controls (the detector must be able to FAIL)', () => {
  it('rejects swapped schema/guidance methods even when each count reconciles', () => {
    const swapped = GOOD.replace('serialization=JSON.stringify', 'serialization=SWAP')
      .replace('serialization=raw-description', 'serialization=JSON.stringify')
      .replace('serialization=SWAP', 'serialization=raw-description');
    expect(judgeToolDeliveryDoc(swapped).violations).toEqual(expect.arrayContaining([
      'schema-token-measurement-method-mismatch', 'guidance-token-measurement-method-mismatch',
    ]));
  });

  it.each(['scope=fixture', 'tokenizer=o200k_base'])('rejects halves measured on different subjects: %s', (field) => {
    expect(judgeToolDeliveryDoc(GOOD.replace(field, field + '-other')).violations).toContain('component-token-subject-mismatch');
  });
  it('rejects a wire total presented without a schema byte measurement', () => {
    expect(judgeToolDeliveryDoc(GOOD.replace(/SCHEMA_BYTES.*\n/, '')).violations).toContain('missing-schema-bytes-measurement');
    expect(judgeToolDeliveryDoc(GOOD.replace('savedByCompact=800', 'savedByCompact=801')).violations).toContain('schema-bytes-do-not-reconcile');
  });
  it.each(['SCHEMA_TOKENS', 'GUIDANCE_TOKENS'])('rejects a missing %s even with a valid total token count', (marker) => {
    const verdict = judgeToolDeliveryDoc(GOOD.split('\n').filter((line) => !line.startsWith(marker)).join('\n'));
    expect(verdict.ok).toBe(false);
    expect(verdict.violations).toContain(`missing-${marker === 'SCHEMA_TOKENS' ? 'schema' : 'guidance'}-token-measurement`);
  });

  it.each([
    ['savedByCompact=300', 'savedByCompact=301', 'schema-tokens-do-not-reconcile'],
    ['savedBySummary=80', 'savedBySummary=81', 'guidance-tokens-do-not-reconcile'],
    ['provenance=measured tokenizer=o200k_base scope=fixture', 'provenance=inferred tokenizer=o200k_base scope=fixture', 'missing-schema-token-provenance'],
  ])('rejects damaged component evidence: %s', (before, after, violation) => {
    expect(judgeToolDeliveryDoc(GOOD.replace(before, after)).violations).toContain(violation);
  });
  it('CALIBRATION: the passing fixture really passes, so the controls are not vacuous', () => {
    const v = judgeToolDeliveryDoc(GOOD);
    expect(v.violations).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('catches a doc that boasts a saving whose arithmetic does not reconcile', () => {
    // THE case this guard exists for: the generator moved, someone refreshed one number
    // by hand, and the doc still reads authoritatively.
    const v = judgeToolDeliveryDoc(GOOD.replace('savedByCompact=949716', 'savedByCompact=900000'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('wire-bytes-do-not-reconcile');
  });

  it('catches a stale guidance saving independently of the wire saving', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace('savedBySummary=253767', 'savedBySummary=253000'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('guidance-bytes-do-not-reconcile');
    // the wire half must still be judged clean — the two are measured separately (D-011)
    expect(v.violations).not.toContain('wire-bytes-do-not-reconcile');
  });

  it('catches a doc that states a saving with no before/after to check it against', () => {
    const v = judgeToolDeliveryDoc(`
      Rank by distinct callers, not by raw invocation count.
      There are three tiers: full, compact and deferred.
      The compact tier saves about 59% of the wire.
    `);
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-wire-bytes-measurement');
  });

  it('catches a doc that drops the callers-not-calls correction', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace(/Rank by distinct callers.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-callers-not-calls-correction');
  });

  it('catches a doc that drops the three-tier correction', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace('There are three tiers: full, compact and deferred.', ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-three-tiers-correction');
  });

  it('catches a doc that states bytes but NO token figure', () => {
    // The specific gap this clause was added for: every byte triple reconciles, the doc
    // reads as fully measured, and it is silent on the only unit the provider bills.
    const v = judgeToolDeliveryDoc(GOOD.replace(/DEFINITION_TOKENS.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-definition-token-measurement');
  });

  it('catches a token triple whose arithmetic does not reconcile', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace('savedByCompact=71616', 'savedByCompact=80000'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('definition-tokens-do-not-reconcile');
    // the byte halves must still be judged clean — they are separate measurements
    expect(v.violations).not.toContain('definition-bytes-do-not-reconcile');
    expect(v.violations).not.toContain('wire-bytes-do-not-reconcile');
  });

  it('catches a doc that drops the UPPER BOUND label', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace(/The byte figure is an UPPER BOUND.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-upper-bound-label');
  });

  it('catches numbers that no longer SUPPORT the upper-bound label', () => {
    // THE case the label alone cannot catch: the prose still says "upper bound" while the
    // doc's own numbers now show the token saving overtaking the byte saving. A stale
    // claim that was once true is exactly what a prose-only check preserves.
    const v = judgeToolDeliveryDoc(
      GOOD.replace('DEFINITION_TOKENS full=109945  compact=38329   savedByCompact=71616',
                   'DEFINITION_TOKENS full=109945  compact=10000   savedByCompact=99945'),
    );
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('byte-saving-not-an-upper-bound');
  });

  it('CALIBRATION: the passing fixture really does satisfy the upper-bound arithmetic', () => {
    // Without this, the control above could pass because the detector is broken in the
    // other direction — flagging everything, including a correct doc.
    const v = judgeToolDeliveryDoc(GOOD);
    expect(v.violations).not.toContain('byte-saving-not-an-upper-bound');
    // and the relationship it asserts is real on the published numbers: 65.1% < 72.8%
    const tokenSaving = (109945 - 38329) / 109945;
    const byteSaving = (369616 - 100418) / 369616;
    expect(tokenSaving).toBeLessThan(byteSaving);
  });

  // ── the $defs N=1 limit, and the token figure's provenance ────────────────────────
  //
  // Added after a rubric re-vet found R-7 VIOLATED BY ITS OWN SUBJECT: the published doc
  // claimed -72.8% and 65.1% with zero mentions of `$defs`, `$ref`, `N=1` or a net loss,
  // and nothing in this file could see it — every check was green while the bar was
  // breached. These controls are what stop that recurring, so each one asserts a
  // DIRECTION rather than the presence of a sentence.

  it('catches a doc that claims the saving but never states the $defs N=1 limit', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace(/DEFS_N1_BYTES.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-defs-n1-limit');
    // the N>1 payoff half is a separate statement and must still read clean
    expect(v.violations).not.toContain('missing-defs-payoff-threshold');
  });

  it('catches an N=1 triple whose arithmetic does not reconcile', () => {
    const v = judgeToolDeliveryDoc(GOOD.replace('addedByFactoring=55', 'addedByFactoring=90'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('defs-n1-bytes-do-not-reconcile');
  });

  it('catches numbers that show factoring WINNING at N=1 — the limit contradicted', () => {
    // THE case prose cannot catch: the caveat is still written out above the block while
    // the block's own numbers now say factoring one reference is free. A doc in that state
    // has stopped stating this limit however faithfully it recites it.
    const v = judgeToolDeliveryDoc(
      GOOD.replace('inlined=800   referenced=855  addedByFactoring=55', 'inlined=800   referenced=800  addedByFactoring=0'),
    );
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('defs-n1-not-a-net-loss');
  });

  it('catches a swapped N=1 pair, where the labelled cost has the wrong sign', () => {
    // Writing the win-direction numbers under a `addedByFactoring` label cannot reconcile:
    // 745 - 800 is not +55. The parser deliberately carries no negatives, so a doc trying
    // to state a saving here fails the identity rather than quietly redefining the key.
    const v = judgeToolDeliveryDoc(GOOD.replace('inlined=800   referenced=855', 'inlined=855   referenced=800'));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('defs-n1-bytes-do-not-reconcile');
  });

  it('catches a doc that states the N=1 loss but never where factoring starts to PAY', () => {
    // "It is a net loss at N=1" on its own reads as an argument against `$defs`. The
    // threshold is what makes it a limit rather than a prohibition.
    const v = judgeToolDeliveryDoc(GOOD.replace(/DEFS_N2_BYTES.*\n/, ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-defs-payoff-threshold');
    expect(v.violations).not.toContain('missing-defs-n1-limit');
  });

  it('catches an N=2 triple that does not reconcile, and one that does not pay', () => {
    const stale = judgeToolDeliveryDoc(GOOD.replace('savedByFactoring=585', 'savedByFactoring=500'));
    expect(stale.violations).toContain('defs-n2-bytes-do-not-reconcile');

    const flat = judgeToolDeliveryDoc(
      GOOD.replace('inlined=1526  referenced=941  savedByFactoring=585', 'inlined=1526  referenced=1526  savedByFactoring=0'),
    );
    expect(flat.violations).toContain('defs-n2-does-not-pay');
  });

  it('catches a token figure published with no provenance label', () => {
    // R-7 requires a published token figure to be MEASURED, never inferred from the byte
    // ratio, and before this rule nothing checked it at all. The label is the half that is
    // checkable; the arithmetic half is `byte-saving-not-an-upper-bound`, which an
    // inferred figure trips by reproducing the byte ratio exactly.
    const v = judgeToolDeliveryDoc(GOOD.replace(' provenance=measured', ''));
    expect(v.ok).toBe(false);
    expect(v.violations).toContain('missing-token-provenance');
    // and the triple itself is untouched, so this is the provenance rule firing alone
    expect(v.violations).not.toContain('missing-definition-token-measurement');
    expect(v.violations).not.toContain('definition-tokens-do-not-reconcile');
  });

  it('CALIBRATION: the passing fixture satisfies every new rule, so none is vacuous', () => {
    const v = judgeToolDeliveryDoc(GOOD);
    for (const code of [
      'missing-defs-n1-limit',
      'defs-n1-bytes-do-not-reconcile',
      'defs-n1-not-a-net-loss',
      'missing-defs-payoff-threshold',
      'defs-n2-bytes-do-not-reconcile',
      'defs-n2-does-not-pay',
      'missing-token-provenance',
    ]) {
      expect(v.violations, code).not.toContain(code);
    }
    // and the flip the two lines encode is real on the published numbers
    expect(855 - 800).toBeGreaterThan(0);
    expect(1526 - 941).toBeGreaterThan(0);
  });

  it('does NOT confuse the wire `full` with the guidance `full` (both lines carry one)', () => {
    // The scoping bug this guards: a document-wide lookup returns the WIRE full for the
    // guidance identity, so a correct doc reports as broken — a false positive, which is
    // how a guard gets weakened rather than fixed.
    const v = judgeToolDeliveryDoc(GOOD);
    expect(v.violations).not.toContain('guidance-bytes-do-not-reconcile');
    // and the parser did see four distinct `full` pairs, so the risk was real — each of
    // the four measurement lines carries one, which is why every lookup is line-scoped
    expect(v.pairs.filter((p) => p.key === 'full').map((p) => p.value)).toEqual([
      1599477, 334797, 369616, 109945, 2000, 900, 100,
    ]);
  });
});

describe('token measurement uses each actual schema and guidance half', () => {
  it('matches independently tokenised source strings and keeps prose out of schema totals', () => {
    const encoding = getEncoding('o200k_base');
    const count = (text: string) => encoding.encode(text, [], []).length;
    const schema = { type: 'object', properties: { value: { type: 'string', description: 'a long explanation '.repeat(20) } } };
    const description = 'Select a value. '.repeat(15);
    const measured = measureToolDeliveryHalves([{ inputSchema: schema, description }], count);
    expect(measured.schema).toEqual({ full: count(JSON.stringify(schema)), compact: count(JSON.stringify(compactInputSchema(schema))) });
    expect(measured.guidance).toEqual({ full: count(description), summary: count(summaryGuidanceDescription(description)) });
    expect(measureToolDeliveryHalves([{ inputSchema: schema, description: '' }], count).schema).toEqual(measured.schema);
    expect(measured.schema.full).toBeGreaterThan(measured.schema.compact);
    expect(measured.guidance.full).toBeGreaterThan(measured.guidance.summary);
  });
});

describe('the published doc satisfies AUTO-BAR-R-7-P-009', () => {
  const body = readFileSync(DOC, 'utf8');

  it('exists and is not a stub (a vacuous green is worse than a red)', () => {
    expect(body.length).toBeGreaterThan(2000);
  });

  it('states both corrections and both reconciling before/after measurements', () => {
    const v = judgeToolDeliveryDoc(body);
    expect(v.violations, v.violations.join(', ')).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('names the budget the measurements are judged against', () => {
    // A saving with no ceiling is not a decision. D-009 unified all three agent kinds
    // DOWN onto the tightest of the three live budgets.
    expect(body).toMatch(/budget=100000/);
  });
});
