/**
 * P-010 (verification-system-improvements-2026-10-10), AUTO-BAR-R-10-P-010: instrument provenance
 * against REAL git, no fake.
 *
 * The cases in instrument-provenance.test.ts drive the rule through an in-memory git fake keyed by
 * (repo, commit, path). These pin the same committed / not-committed / not-importing verdicts with
 * the PRODUCTION git runner against THIS repository at HEAD: no fake git and no fixture tree. The
 * cited instrument and tests are real committed files of this checkout, so the fake cannot drift
 * from real `git cat-file` / `git show` behaviour unnoticed.
 *
 * Kept in its own file so adding it did not change the fingerprint of instrument-provenance.test.ts,
 * which other P-010 clauses bind as their test evidence.
 */
import { describe, expect, it } from 'vitest';
import { defaultGitRunner } from './evidence-measurement-pin';
import {
  instrumentProvenanceRefusal,
  type InstrumentProvenanceDeps,
  type InstrumentRefusalCode,
} from './instrument-provenance';

const PLANS = 'packages/operator-core/lib/agent-tools/plans';

const operational = (instrument: { path: string; testPath: string }) => ({
  evidenceKind: 'operational',
  details: { instrument },
});

async function realDeps(): Promise<InstrumentProvenanceDeps> {
  const root = (await defaultGitRunner(__dirname, ['rev-parse', '--show-toplevel'])).trim();
  return { git: defaultGitRunner, primaryRoot: async () => root, checkoutRoot: async () => null };
}

async function refusalCode(
  binding: ReturnType<typeof operational>,
  d: InstrumentProvenanceDeps,
): Promise<InstrumentRefusalCode | null> {
  return (await instrumentProvenanceRefusal(binding, undefined, d))?.error ?? null;
}

describe('instrument provenance — real git, no fake (AUTO-BAR-R-10-P-010)', () => {
  it('accepts a real committed instrument whose real committed test imports it', async () => {
    const d = await realDeps();
    const binding = operational({ path: `${PLANS}/evidence-measurement-pin.ts`, testPath: `${PLANS}/evidence-measurement-pin.test.ts` });
    expect(await refusalCode(binding, d)).toBeNull();
  });

  it('refuses an instrument path with no blob at HEAD as not committed', async () => {
    const d = await realDeps();
    const binding = operational({ path: `${PLANS}/never-committed-instrument.ts`, testPath: `${PLANS}/evidence-measurement-pin.test.ts` });
    const refusal = await instrumentProvenanceRefusal(binding, undefined, d);
    expect(refusal?.error).toBe('instrument_not_committed');
    expect(refusal?.reason.length).toBeGreaterThan(20);
  });

  it('refuses a real committed test that does not import the instrument', async () => {
    const d = await realDeps();
    const binding = operational({
      path: `${PLANS}/evidence-measurement-pin.ts`,
      testPath: 'packages/operator-core/lib/search/bench/aggregate-correctness.test.ts',
    });
    const refusal = await instrumentProvenanceRefusal(binding, undefined, d);
    expect(refusal?.error).toBe('instrument_test_not_importing');
    expect(refusal?.reason.length).toBeGreaterThan(20);
  });
});
