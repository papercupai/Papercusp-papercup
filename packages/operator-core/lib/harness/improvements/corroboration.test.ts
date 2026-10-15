import { describe, expect, it } from 'vitest';

import {
  createImplementationReadiness,
  evaluateImplementationAcceptance,
  sealImplementationAcceptance,
  type ImplementationAcceptanceAuthority,
  type ImplementationAcceptanceSource,
} from './agent-review-policy';
import {
  CORROBORATION_FILING_KINDS,
  CORROBORATION_NOTE,
  corroborationReportersSql,
  readReporterKinds,
  summarizeCorroboration,
} from './corroboration';

// unified-bug-pipeline-and-honest-queue-2026-10-05 P-012 (D-049).

const BUG_SOURCE: ImplementationAcceptanceSource = {
  kind: 'bug',
  title: 'Bounded parser drops the trailing token',
  summary: 'The bounded parser drops the last token of every line.',
};
const PROPOSAL = {
  problem: 'The bounded parser drops the trailing token of a line.',
  evidence: ['parser.test.ts trailing-token fixture fails on HEAD'],
  outcome: 'Every token of a line survives parsing.',
  scope: 'Fix the bounded parser defect only.',
  completionCheck: 'The trailing-token regression fixture passes.',
};
const AUTHORITY: ImplementationAcceptanceAuthority = { kind: 'agent-review', reviewer: 'su-reviewer', submittedBy: 'su-author', round: 1 };
const RECEIPT = { kind: 'failing-test', ref: 'packages/operator-core/lib/example.test.ts', buildSha: 'abcdef1' } as const;

/** Every corroboration signal the pipeline records, turned all the way up. */
const HEAVY_CORROBORATION = {
  repeatCount: 2943,
  reporterKinds: ['agent', 'watchdog', 'end-user', 'chat'],
  reporter: { kind: 'end-user', id: 'person-1', basis: 'explicit', at: '2026-10-06T00:00:00.000Z' },
  toolFailureProbation: { reporters: Array.from({ length: 676 }, (_, i) => `su-reporter-${i}`) },
  corroboration: { reporters: 676, filings: 2943 },
};

function contractFor(withReceipt: boolean) {
  const sealed = sealImplementationAcceptance({
    proposal: PROPOSAL,
    authority: AUTHORITY,
    reason: 'agent-review-approved (grade 5/5)',
    source: BUG_SOURCE,
    acceptedAt: '2026-09-05T00:00:00.000Z',
    reproduction: RECEIPT,
  });
  if (!sealed.ok) throw new Error(`fixture contract must seal: ${JSON.stringify(sealed)}`);
  if (withReceipt) return sealed.contract as unknown as Record<string, unknown>;
  // The same contract a writer could store if it skipped the receipt: the seal's
  // verification marker is the only thing removed.
  const { verification: _dropped, ...rest } = sealed.contract as unknown as Record<string, unknown>;
  return rest;
}

function payloadFor(contract: Record<string, unknown>, extra: Record<string, unknown>) {
  return {
    ...extra,
    implementationReadiness: createImplementationReadiness({
      status: 'ready',
      source: 'agent-review',
      reason: 'agent-review-approved',
      updatedAt: '2026-09-05T00:00:00.000Z',
      evidence: { acceptance: contract },
    }),
  };
}

describe('SPEC-P-012: corroboration is never a substitute for the verification receipt', () => {
  it('holds a heavily corroborated bug with no reproduction receipt as incomplete (missing verification)', () => {
    const verdict = evaluateImplementationAcceptance(payloadFor(contractFor(false), HEAVY_CORROBORATION), BUG_SOURCE);
    expect(verdict.state).toBe('incomplete');
    expect(verdict.missing).toEqual(['verification']);
  });

  it('refuses to seal a bug with no receipt however corroborated it is (the seal takes no corroboration input)', () => {
    const sealed = sealImplementationAcceptance({
      proposal: PROPOSAL,
      authority: AUTHORITY,
      reason: 'agent-review-approved',
      source: BUG_SOURCE,
      acceptedAt: '2026-09-05T00:00:00.000Z',
    });
    expect(sealed.ok).toBe(false);
  });

  it('gives the same verdict with or without corroboration, receipt or not (calibration)', () => {
    for (const withReceipt of [true, false]) {
      const contract = contractFor(withReceipt);
      const bare = evaluateImplementationAcceptance(payloadFor(contract, {}), BUG_SOURCE);
      const heavy = evaluateImplementationAcceptance(payloadFor(contract, HEAVY_CORROBORATION), BUG_SOURCE);
      expect(heavy).toEqual(bare);
      expect(bare.state).toBe(withReceipt ? 'qualifying' : 'incomplete');
    }
  });
});

describe('corroboration summary (shown on the item)', () => {
  it('reads the reporter-kind tally in canonical order and drops unknown kinds', () => {
    expect(readReporterKinds({ reporterKinds: ['end-user', 'bogus', 'agent', 7, 'agent'] })).toEqual(['agent', 'end-user']);
    expect(readReporterKinds({ reporterKinds: 'agent' })).toEqual([]);
    expect(readReporterKinds(null)).toEqual([]);
  });

  it('combines the ledger counts with the payload tally and always carries the not-a-receipt note', () => {
    const ledger = { reporters: 3, filings: 9, firstFiledAt: '2026-10-01T00:00:00.000Z', lastFiledAt: '2026-10-06T00:00:00.000Z' };
    expect(summarizeCorroboration(ledger, { reporterKinds: ['watchdog', 'agent'] })).toEqual({
      ...ledger,
      reporterKinds: ['agent', 'watchdog'],
      note: CORROBORATION_NOTE,
    });
    expect(CORROBORATION_NOTE).toMatch(/never a verification receipt/);
  });

  it('reads an item with no ledger rows as zero, not missing', () => {
    expect(summarizeCorroboration(undefined, {})).toMatchObject({ reporters: 0, filings: 0, firstFiledAt: null, reporterKinds: [] });
  });

  it("does not count 'promoted' rows as filings (an admission step, not a report)", () => {
    expect(CORROBORATION_FILING_KINDS).not.toContain('promoted');
    expect([...CORROBORATION_FILING_KINDS].sort()).toEqual(['canonical-created', 'coalesced', 'duplicate', 'regression']);
  });
});

describe('corroboration reporter lookup SQL', () => {
  it('keeps the direct and distinct-promotion probes in separate indexable branches', () => {
    const fakeSql = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.reduce((text, part, index) => text + part + (index < values.length ? String(values[index]) : ''), ''),
      { unsafe: (value: string) => value },
    );
    const statement = String(corroborationReportersSql(fakeSql as never));

    const branches = statement.split('UNION ALL');
    expect(branches).toHaveLength(2);
    expect(branches[0]).toContain('o.canonical_work_item_id = wi.feature_id');
    expect(branches[1]).toContain("o.canonical_work_item_id = (source.payload -> 'intakeSource' ->> 'id')");
    expect(statement).not.toContain('canonical_work_item_id = wi.feature_id OR');
  });
});
