/**
 * The census corpus driven through `jsonSchemaToArbitrary` — every live surface, no per-surface
 * authoring. Plan: design-to-code-coverage-seam-2026-09-02 (P-023), Decisions D-042/D-043/D-044.
 *
 * WHY THIS LIVES IN operator-core AND NOT BESIDE ITS SUBJECT. The converter is in
 * `libs/testing-shell`, but the CORPUS is the three live census providers, which live here.
 * testing-shell cannot import operator-core (that is the wrong dependency direction), so the
 * measurement has to run on this side of the seam. `schema-arbitrary.test.ts` over in
 * testing-shell holds the fixture-level regressions; this holds the population-level one.
 *
 * WHY IT ENUMERATES INSTEAD OF READING `harness_shared.testing_surfaces`. `enumerate()` needs no
 * database — it reads the same registries that serve production traffic — so this stays a plain
 * unit test (~4s over ~1,000 schemas) rather than an integration test gated on Postgres. It also
 * measures the CURRENT registries, so a tool whose schema gains a keyword the converter cannot
 * model is caught by the next run of this file rather than by a surprised agent later.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * THE ASSERTION SHAPE IS THE POINT: "zero non-conforming" IS TRIVIALLY SATISFIABLE BY REFUSING
 * EVERY SCHEMA. A converter that threw `UnsupportedSchemaError` on all 1,000 inputs would emit
 * no values, and therefore no non-conforming values, and this file would go green while
 * measuring nothing. That is the same zero-work false green that let the original bug ship (see
 * the format control below). So the derivation FLOOR is asserted with equal weight — the suite
 * fails both when the converter lies and when it quietly stops doing any work.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import fc from 'fast-check';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  jsonSchemaToArbitrary,
  UnsatisfiableSchemaError,
  UnsupportedSchemaError,
  type CensusContext,
} from '@papercusp/testing-shell/census';
import { censusProviders } from './provider-registry';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

const ctx: CensusContext = {
  workspaceId: 'schema-arbitrary-corpus',
  harnessSlug: 'papercusp',
  config: {},
  repoRoot,
};

const ajv = new Ajv2020({ strict: false, allErrors: true });
/**
 * REQUIRED. Without it ajv silently IGNORES `format`, and every `format` case passes no matter
 * what the generator emits. That is not hypothetical: the converter shipped emitting
 * "+275760-09-13T00:00:00.000Z" for `format: date-time` and a 35/35 green suite reported it as
 * correct, because the validator was not checking the keyword under test. The control in
 * `formatIsEnforced` below is what turns a dropped `addFormats` into a failure instead of silence.
 */
addFormats(ajv);

interface CorpusEntry {
  kind: string;
  surfaceId: string;
  schema: Record<string, unknown>;
}

/** Every live surface that declares a schema, across all three providers. */
async function loadCorpus(): Promise<CorpusEntry[]> {
  const out: CorpusEntry[] = [];
  for (const provider of censusProviders()) {
    for (const surface of await provider.enumerate(ctx)) {
      const schema = surface.schemaRef;
      if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
        out.push({
          kind: surface.kind,
          surfaceId: surface.surfaceId,
          schema: schema as Record<string, unknown>,
        });
      }
    }
  }
  return out;
}

const corpus = await loadCorpus();

/**
 * Floors, not exact counts. The corpus grows and shrinks with the tool catalogue every day, so
 * pinning a total would make this file fail for reasons that are not defects. A floor still
 * catches the failure that matters — enumeration or derivation silently collapsing to nothing.
 * Measured 2026-09-03: 1,033 schemas, 1,028 derived (99.5%), 5 refused, 0 non-conforming.
 */
const MIN_CORPUS_SIZE = 500;
const MIN_DERIVED_RATIO = 0.95;
/**
 * 10, not 25. This runs ~1,000 schemas, and a non-conformance that only shows at sample 25 but
 * not at sample 10 is vanishingly rare next to the cost of quadrupling the loop in CI. The
 * explicit per-test timeout below matters more than the sample count: an arbitrary built from a
 * `pattern` composed with a length filter can in principle starve, and fast-check's `filter`
 * retries without a ceiling, so an unbounded test would hang rather than fail.
 */
const SAMPLES_PER_SCHEMA = 10;
/** Cold transform of the operator graph alone is ~38s; the loop adds ~10s. */
const CORPUS_TEST_TIMEOUT_MS = 180_000;

describe('census corpus → jsonSchemaToArbitrary', () => {
  it('the corpus is real (positive control on the instrument)', () => {
    // An empty enumeration would make every assertion below vacuously true. Fail loudly here
    // instead, where the message names the actual cause.
    expect(corpus.length).toBeGreaterThanOrEqual(MIN_CORPUS_SIZE);
  });

  it('ajv is actually enforcing `format` (control on the validator)', () => {
    const validate = ajv.compile({ type: 'string', format: 'date-time' });
    expect(validate('nope')).toBe(false);
    expect(validate('+275760-09-13T00:00:00.000Z')).toBe(false);
    expect(validate('2020-01-01T00:00:00.000Z')).toBe(true);
  });

  it('derives a CONFORMING arbitrary for every schema it accepts', { timeout: CORPUS_TEST_TIMEOUT_MS }, () => {
    const refused: string[] = [];
    const nonConforming: string[] = [];
    let derived = 0;

    for (const { kind, surfaceId, schema } of corpus) {
      const ref = `${kind} ${surfaceId}`;
      let arb: fc.Arbitrary<unknown>;
      try {
        arb = jsonSchemaToArbitrary(schema);
      } catch (err) {
        // A refusal is an ACCEPTABLE outcome — the converter declining to model something it
        // cannot model faithfully is the whole design. It is counted, not ignored, because the
        // ratio below is what stops "refuse everything" from passing as success.
        if (err instanceof UnsupportedSchemaError || err instanceof UnsatisfiableSchemaError) {
          refused.push(`${ref}: ${err.message}`);
          continue;
        }
        throw err;
      }
      derived++;

      let validate: ReturnType<typeof ajv.compile>;
      try {
        validate = ajv.compile(schema);
      } catch {
        // ajv cannot compile it, so this schema cannot judge anything. Not the converter's fault.
        continue;
      }

      // Sampled directly rather than through fc.assert so the ajv message survives intact;
      // "Property failed after 1 tests" names no cause and cost a full re-instrumentation once.
      for (const value of fc.sample(arb, SAMPLES_PER_SCHEMA)) {
        if (validate(value)) continue;
        nonConforming.push(
          `${ref}: ${ajv.errorsText(validate.errors)} :: ${JSON.stringify(value)?.slice(0, 200)}`,
        );
        break;
      }
    }

    // Asserted BEFORE the conformance check: if derivation has collapsed, "zero non-conforming"
    // is meaningless and this is the message that should be read first.
    expect(
      derived / corpus.length,
      `derivation collapsed — only ${derived}/${corpus.length} schemas derived. ` +
        `Refusals:\n${refused.slice(0, 15).join('\n')}`,
    ).toBeGreaterThanOrEqual(MIN_DERIVED_RATIO);

    expect(
      nonConforming,
      `generator emitted values its own schema rejects:\n${nonConforming.slice(0, 15).join('\n')}`,
    ).toHaveLength(0);
  });
});
