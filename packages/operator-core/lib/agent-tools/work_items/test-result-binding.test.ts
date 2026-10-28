/**
 * P-002 / D-017 (plan `design-to-code-coverage-seam-2026-09-02`).
 *
 * The property under test is asymmetric and the tests are shaped around it: a FALSE
 * contradiction lowers an honest agent's grade and teaches the fleet the signal is noise,
 * while a false clean verdict merely leaves today's behaviour in place. So the bulk of
 * these cases assert SILENCE — each is one concrete way the probe could otherwise
 * manufacture a confident accusation.
 */
import { describe, expect, it } from 'vitest';

import type { CompletionVerificationEvidence } from '../../coord-lifecycle/records';
import {
  MAX_TEST_BINDING_LOOKBACK_MS,
  TEST_BINDING_WINDOW_SLACK_MS,
  testResultContradictedByRun as evaluateTestResultContradictedByRun,
  type TestingRunInvocation,
  type TestRunLedgerRow,
  type TestResultBindingProbe,
} from './test-result-binding';

const NOW = new Date('2026-09-02T18:00:00.000Z');

/** The exact defect P-002 closes: a non-empty string that says the run FAILED. */
const CLAIMS_PASSED: CompletionVerificationEvidence = {
  verifiedHow: 'unit',
  testsRun: 'testing:run { files: ["a.test.ts"] }',
  testResult: 'passed',
} as CompletionVerificationEvidence;

function run(overrides: Partial<TestingRunInvocation> = {}): TestingRunInvocation {
  return {
    invokedAt: new Date(NOW.getTime() - 60_000),
    durationMs: 5_000,
    workItemId: 'WI-1',
    files: ['a.test.ts', 'b.test.ts'],
    ...overrides,
  };
}

function row(overrides: Partial<TestRunLedgerRow> = {}): TestRunLedgerRow {
  return { filePath: 'a.test.ts', status: 'pass', runGroupId: 'group-1', ...overrides };
}

function probe(opts: {
  latest?: TestingRunInvocation | null | undefined;
  rows?: readonly TestRunLedgerRow[] | undefined;
  throwOnRun?: boolean;
  throwOnRows?: boolean;
  onWindow?: (paths: readonly string[], from: Date, to: Date) => void;
}): TestResultBindingProbe {
  return {
    latestTestingRun: async () => {
      if (opts.throwOnRun) throw new Error('pg down');
      return opts.latest;
    },
    ledgerRowsInWindow: async (paths, from, to) => {
      if (opts.throwOnRows) throw new Error('pg down');
      opts.onWindow?.(paths, from, to);
      return opts.rows;
    },
    now: () => NOW,
  };
}

function testResultContradictedByRun(
  evidence: CompletionVerificationEvidence | null | undefined,
  bindingProbe: TestResultBindingProbe,
) {
  return evaluateTestResultContradictedByRun(evidence, 'WI-1', bindingProbe);
}

describe('testResultContradictedByRun — the finding', () => {
  it('uses exact native green despite an older red and concurrent peer red', async () => {
    expect(await testResultContradictedByRun(CLAIMS_PASSED, probe({
      latest: run({ runGroupId: 'native-green' }),
      rows: [row({ status: 'fail', runGroupId: 'old-tool-red' }),
        row({ runGroupId: 'native-green' }), row({ status: 'fail', runGroupId: 'peer' })],
    }))).toBeUndefined();
  });
  it('still contradicts a native red beside a peer green', async () => {
    expect(await testResultContradictedByRun(CLAIMS_PASSED, probe({
      latest: run({ runGroupId: 'native-red' }),
      rows: [row({ status: 'fail', runGroupId: 'native-red' }), row({ runGroupId: 'peer' })],
    }))).toEqual({ runGroupId: 'native-red', failingFiles: ['a.test.ts'], filesInRun: 1 });
  });
  it('reports a contradiction when the latest run has a failing row', async () => {
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({ latest: run(), rows: [row(), row({ filePath: 'b.test.ts', status: 'fail' })] }),
    );
    expect(found).toEqual({ runGroupId: 'group-1', failingFiles: ['b.test.ts'], filesInRun: 2 });
  });

  it('treats `error` as failing too — a file that could not even collect is not a pass', async () => {
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({ latest: run(), rows: [row({ status: 'error' })] }),
    );
    expect(found?.failingFiles).toEqual(['a.test.ts']);
  });

  it('fires regardless of what the declared string SAYS — "3 failed" is the measured defect', async () => {
    // Before this check, this exact completion earned `committed`: the gate read that a
    // test field was present, never that it said anything true.
    const evidence = { ...CLAIMS_PASSED, testResult: '3 failed' } as CompletionVerificationEvidence;
    const found = await testResultContradictedByRun(
      evidence,
      probe({ latest: run(), rows: [row({ status: 'fail' })] }),
    );
    expect(found?.runGroupId).toBe('group-1');
  });

  it('deduplicates and sorts failing files so the citation is stable', async () => {
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({
        latest: run(),
        rows: [
          row({ filePath: 'z.test.ts', status: 'fail' }),
          row({ filePath: 'z.test.ts', status: 'error' }),
          row({ filePath: 'a.test.ts', status: 'fail' }),
        ],
      }),
    );
    expect(found?.failingFiles).toEqual(['a.test.ts', 'z.test.ts']);
  });

  it('queries the ledger over [invokedAt, invokedAt + duration + slack]', async () => {
    let seen: { paths: readonly string[]; from: Date; to: Date } | undefined;
    const invocation = run({ durationMs: 5_000 });
    await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({
        latest: invocation,
        rows: [row({ status: 'fail' })],
        onWindow: (paths, from, to) => {
          seen = { paths, from, to };
        },
      }),
    );
    expect(seen?.paths).toEqual(['a.test.ts', 'b.test.ts']);
    expect(seen?.from.getTime()).toBe(invocation.invokedAt.getTime());
    expect(seen?.to.getTime()).toBe(invocation.invokedAt.getTime() + 5_000 + TEST_BINDING_WINDOW_SLACK_MS);
  });
});

describe('testResultContradictedByRun — silence is the default, and each cause is separate', () => {
  it('is silent when the run is GREEN', async () => {
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({ latest: run(), rows: [row(), row({ filePath: 'b.test.ts' })] }),
    );
    expect(found).toBeUndefined();
  });

  it('is silent for skip / cancelled / running — none is a verdict against the work', async () => {
    for (const status of ['skip', 'cancelled', 'running']) {
      const found = await testResultContradictedByRun(
        CLAIMS_PASSED,
        probe({ latest: run(), rows: [row({ status })] }),
      );
      expect(found, `status ${status} must be silent`).toBeUndefined();
    }
  });

  it('is silent when the window spans MORE THAN ONE run group (the concurrent-peer case)', async () => {
    // This is the property that makes misattribution structurally impossible rather than
    // merely unlikely: no column says which of the two groups is ours, so neither is judged
    // — even though one of them is definitively red.
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({
        latest: run(),
        rows: [row({ runGroupId: 'group-1' }), row({ filePath: 'b.test.ts', status: 'fail', runGroupId: 'group-2' })],
      }),
    );
    expect(found).toBeUndefined();
  });

  it('is silent when the ledger rows carry no run group id', async () => {
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({ latest: run(), rows: [row({ status: 'fail', runGroupId: null })] }),
    );
    expect(found).toBeUndefined();
  });

  it('is silent when the latest run is older than the lookback window', async () => {
    const stale = run({ invokedAt: new Date(NOW.getTime() - MAX_TEST_BINDING_LOOKBACK_MS - 1) });
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({ latest: stale, rows: [row({ status: 'fail' })] }),
    );
    expect(found).toBeUndefined();
  });

  it('is silent when the agent has no recent testing:run at all', async () => {
    expect(await testResultContradictedByRun(CLAIMS_PASSED, probe({ latest: null }))).toBeUndefined();
    expect(await testResultContradictedByRun(CLAIMS_PASSED, probe({ latest: undefined }))).toBeUndefined();
  });

  it('is silent when the run executed no files', async () => {
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({ latest: run({ files: [] }), rows: [row({ status: 'fail' })] }),
    );
    expect(found).toBeUndefined();
  });

  it('is silent when the ledger has no rows for that window (a refused or unreported run)', async () => {
    expect(await testResultContradictedByRun(CLAIMS_PASSED, probe({ latest: run(), rows: [] }))).toBeUndefined();
    expect(
      await testResultContradictedByRun(CLAIMS_PASSED, probe({ latest: run(), rows: undefined })),
    ).toBeUndefined();
  });

  it('is silent when the invocation timestamp is unusable', async () => {
    const found = await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({ latest: run({ invokedAt: new Date('nonsense') }), rows: [row({ status: 'fail' })] }),
    );
    expect(found).toBeUndefined();
  });

  it('is silent when either probe throws — a database fault must never read as a red run', async () => {
    expect(await testResultContradictedByRun(CLAIMS_PASSED, probe({ throwOnRun: true }))).toBeUndefined();
    expect(
      await testResultContradictedByRun(CLAIMS_PASSED, probe({ latest: run(), throwOnRows: true })),
    ).toBeUndefined();
  });

  it('is silent when the completion declared no test evidence at all', async () => {
    // `no-test-run-or-result` already owns that case upstream and reports a better remedy;
    // firing here too would hand the agent the wrong repair.
    const noTests = { verifiedHow: 'unit' } as CompletionVerificationEvidence;
    const found = await testResultContradictedByRun(
      noTests,
      probe({ latest: run(), rows: [row({ status: 'fail' })] }),
    );
    expect(found).toBeUndefined();
  });

  it('is silent for null/undefined evidence', async () => {
    expect(await testResultContradictedByRun(null, probe({ latest: run() }))).toBeUndefined();
    expect(await testResultContradictedByRun(undefined, probe({ latest: run() }))).toBeUndefined();
  });

  it('tolerates a null duration by falling back to slack alone', async () => {
    let to: Date | undefined;
    const invocation = run({ durationMs: null });
    await testResultContradictedByRun(
      CLAIMS_PASSED,
      probe({
        latest: invocation,
        rows: [row({ status: 'fail' })],
        onWindow: (_p, _f, t) => {
          to = t;
        },
      }),
    );
    expect(to?.getTime()).toBe(invocation.invokedAt.getTime() + TEST_BINDING_WINDOW_SLACK_MS);
  });
});

describe('work item attribution', () => {
  it('does not use a failing run without an explicit work-item id', async () => {
    let queriedLedger = false;
    const found = await evaluateTestResultContradictedByRun(
      CLAIMS_PASSED,
      'WI-1',
      probe({
        latest: run({ workItemId: null }),
        rows: [row({ status: 'fail' })],
        onWindow: () => {
          queriedLedger = true;
        },
      }),
    );

    expect(found).toBeUndefined();
    expect(queriedLedger).toBe(false);
  });

  it('does not use a failing run attributed to another work-item', async () => {
    let queriedLedger = false;
    const found = await evaluateTestResultContradictedByRun(
      CLAIMS_PASSED,
      'WI-1',
      probe({
        latest: run({ workItemId: 'WI-other' }),
        rows: [row({ status: 'fail' })],
        onWindow: () => {
          queriedLedger = true;
        },
      }),
    );

    expect(found).toBeUndefined();
    expect(queriedLedger).toBe(false);
  });
});
