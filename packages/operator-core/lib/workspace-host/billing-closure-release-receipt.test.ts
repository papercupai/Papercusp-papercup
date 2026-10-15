import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_HOST_BILLING_CLOSURE_STAGE,
  parseWorkspaceHostReleaseClosurePointer,
  recordWorkspaceHostBillingClosure,
  workspaceHostBillingClosureOutcome,
  workspaceHostBillingClosureStage,
  workspaceHostReleaseClosurePointer,
  type SettledWorkspaceHostSpendFinality,
} from './billing-closure-release-receipt';
import {
  BUNDLE,
  OTHER_BUNDLE,
  TASK_ID,
  builtReceipts,
  labelJournal,
  memoryReleaseLedger,
  receipt,
} from './release-journal-test-support';
import { WorkspaceHostReleaseBindingError } from './release-stage-receipt';
import { openWorkspaceHostTeardownRelease } from './teardown-release-receipt';

const RUN_ID = 'canary-run-1';
const SUBJECT = { runId: RUN_ID, maxSpendCents: 2_500 };
const HOST = { workspaceId: 'workspace-1', hostId: 'host-1' };

function settled(budgetCents: number): SettledWorkspaceHostSpendFinality {
  return {
    status: 'settled',
    retryable: false,
    observationCount: 3,
    stableObservationCount: 2,
    stableSince: '2026-08-26T01:00:00.000Z',
    stableForMs: 1_800_000,
    requiredStableWindowMs: 1_800_000,
    observation: {
      currency: 'USD',
      grossMicros: '712000',
      creditMicros: '0',
      netMicros: '712000',
      observedAt: '2026-08-26T01:30:00.000Z',
      providerEvidenceRef: 'gcp://bigquery/papercusp_billing/job-1',
      budgetCents,
    },
  };
}

function releaseLedger() {
  return memoryReleaseLedger(
    labelJournal([...builtReceipts(), receipt('publish.finalize', 'committed', [`provider:bundle:${BUNDLE}`], 2)]),
  );
}

function billingReceipts(journal: ReturnType<typeof releaseLedger>) {
  return journal.journal.receipts.filter((entry) => entry.stage === WORKSPACE_HOST_BILLING_CLOSURE_STAGE);
}

/** What the release-bound destroy leaves behind: an open billing intent and the pointer to it. */
async function destroyOpened(journal: ReturnType<typeof releaseLedger>) {
  const recorder = await openWorkspaceHostTeardownRelease({
    ...HOST,
    releaseTaskId: TASK_ID,
    operationId: 'op-destroy-1',
    provider: 'gcp',
    billing: SUBJECT,
    ledger: journal,
    readHostRuntimeRelease: async () => ({ bundleSha256: BUNDLE }),
  });
  await recorder.begin('billing-closure');
  return workspaceHostReleaseClosurePointer({ releaseTaskId: TASK_ID, operationId: 'op-destroy-1', subject: SUBJECT });
}

function record(
  journal: ReturnType<typeof releaseLedger>,
  pointer: ReturnType<typeof workspaceHostReleaseClosurePointer>,
  budgetCents: number,
  bundle = BUNDLE,
) {
  return recordWorkspaceHostBillingClosure({
    ...HOST,
    pointer,
    finality: settled(budgetCents),
    ledger: journal,
    readHostRuntimeRelease: async () => ({ bundleSha256: bundle }),
  });
}

describe('billing.closure', () => {
  it('is keyed by the run whose spend is judged and the ceiling it is judged against', () => {
    expect(workspaceHostBillingClosureStage(SUBJECT)).toEqual({
      stage: 'billing.closure',
      identity: { provider: 'gcp', source: 'gcp-billing-export-v1', runId: RUN_ID, maxSpendCents: 2_500 },
    });
  });

  it('round-trips the pointer the destroy writes and reads anything malformed as absent', () => {
    const pointer = workspaceHostReleaseClosurePointer({ releaseTaskId: TASK_ID, operationId: 'op-1', subject: SUBJECT });
    expect(parseWorkspaceHostReleaseClosurePointer(JSON.parse(JSON.stringify(pointer)))).toEqual(pointer);
    expect(
      parseWorkspaceHostReleaseClosurePointer({ ...pointer, maxSpendCents: null }),
    ).toMatchObject({ maxSpendCents: null });

    for (const malformed of [
      null,
      [],
      { ...pointer, schemaVersion: 'workspace-host-release-closure-v0' },
      { ...pointer, releaseTaskId: '../other-task' },
      { ...pointer, runRef: 'initialize-operation:op-1' },
      { ...pointer, runRef: 'destroy-operation:' },
      { ...pointer, runId: ' ' },
      { ...pointer, maxSpendCents: -1 },
      { ...pointer, maxSpendCents: 12.5 },
    ]) {
      expect(parseWorkspaceHostReleaseClosurePointer(malformed)).toBeNull();
    }
  });

  it('commits a settled spend within its ceiling and refuses one over it', () => {
    const within = workspaceHostBillingClosureOutcome({ subject: SUBJECT, finality: settled(72) });
    expect(within.outcome).toBe('committed');
    expect(within.evidenceRefs).toEqual([
      'billing-run:canary-run-1',
      'billing-observation:gcp://bigquery/papercusp_billing/job-1',
      'billing-net-micros:USD:712000',
      'billing-budget-cents:72',
      'billing-max-spend-cents:2500',
      'billing-stable-since:2026-08-26T01:00:00.000Z',
      'billing-stable-for-ms:1800000/1800000',
      'billing-stable-observations:2/3',
    ]);

    // The ceiling is inclusive; one cent over refuses the receipt and says why.
    expect(workspaceHostBillingClosureOutcome({ subject: SUBJECT, finality: settled(2_500) }).outcome).toBe('committed');
    const over = workspaceHostBillingClosureOutcome({ subject: SUBJECT, finality: settled(2_501) });
    expect(over.outcome).toBe('refused');
    expect(over.evidenceRefs).toContain('billing-over-budget');

    const undeclared = workspaceHostBillingClosureOutcome({
      subject: { runId: RUN_ID, maxSpendCents: null },
      finality: settled(1_000_000),
    });
    expect(undeclared.outcome).toBe('committed');
    expect(undeclared.evidenceRefs).toContain('billing-max-spend-cents:undeclared');
  });

  it('settles the intent the destroy opened, on the same request, naming the destroy first', async () => {
    const journal = releaseLedger();
    const pointer = await destroyOpened(journal);

    await expect(record(journal, pointer, 72)).resolves.toMatchObject({ outcome: 'committed' });

    const [intent, settledReceipt, ...rest] = billingReceipts(journal);
    expect(rest).toEqual([]);
    expect(intent).toMatchObject({ state: 'intent' });
    expect(settledReceipt).toMatchObject({ state: 'committed', requestIdentity: intent!.requestIdentity });
    expect(settledReceipt!.evidenceRefs[0]).toBe('destroy-operation:op-destroy-1');
    expect(settledReceipt!.evidenceRefs).toContain('billing-budget-cents:72');
  });

  it('records an over-budget run as refused, not committed', async () => {
    const journal = releaseLedger();
    const pointer = await destroyOpened(journal);

    await record(journal, pointer, 9_999);

    const settledReceipt = billingReceipts(journal).at(-1)!;
    expect(settledReceipt.state).toBe('refused');
    expect(settledReceipt.evidenceRefs).toContain('billing-over-budget');
  });

  it('writes nothing when a reconcile repeats after its receipt already landed', async () => {
    const journal = releaseLedger();
    const pointer = await destroyOpened(journal);
    await record(journal, pointer, 72);
    const cursor = journal.journal.cursor;

    await expect(record(journal, pointer, 72)).resolves.toMatchObject({ outcome: 'committed' });
    expect(journal.journal.cursor).toBe(cursor);
  });

  it('refuses to close billing for a host that runs other bytes than the release', async () => {
    const journal = releaseLedger();
    const pointer = await destroyOpened(journal);
    const cursor = journal.journal.cursor;

    const error = await record(journal, pointer, 72, OTHER_BUNDLE).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceHostReleaseBindingError);
    expect(error).toMatchObject({ reason: 'bundle-mismatch' });
    expect(journal.journal.cursor).toBe(cursor);
  });
});
