import { describe, expect, it } from 'vitest';

import type {
  AppendTaskReleaseReceiptResult,
  TaskReleaseJournal,
  TaskReleaseReceipt,
  TaskReleaseReceiptInput,
  PriorCommittedTaskReleaseReceipt,
} from '@papercusp/operator-core/lib/task-manager/store';
import {
  assertReleaseTaskIdentity,
  beginReleaseTaskStage,
  inspectReleaseTaskStage,
  releaseStageInputHash,
  releaseStageRequestIdentity,
  releaseTaskStageContentIdentity,
  releaseTaskStageInputHash,
  settleReleaseTaskStage,
  type ReleaseTaskLedger,
  type ReleaseTaskStageContext,
} from './release-task-journal.mjs';

const SOURCE_SHA = 'a'.repeat(40);
const GITLINK = 'b'.repeat(40);
const OPERATION_ID = 'release-operation-1';
const TASK_ID = 'release-task-1';

function journal(overrides: Partial<TaskReleaseJournal> = {}): TaskReleaseJournal {
  return {
    schemaVersion: 1,
    operationId: OPERATION_ID,
    source: { sha: SOURCE_SHA, gitlinks: { 'papercusp-desktop': GITLINK } },
    artifactIdentity: {
      kind: 'papercusp-desktop-release',
      sourceSha: SOURCE_SHA,
      version: '0.0.19-nightly',
      channel: 'nightly',
    },
    cursor: 0,
    currentStage: null,
    currentState: null,
    spentOperationIds: [],
    receipts: [],
    ...overrides,
  };
}

function ledger(
  initial = journal(),
  reusable: PriorCommittedTaskReleaseReceipt | null = null,
): ReleaseTaskLedger & { journal: TaskReleaseJournal } {
  const state = { journal: initial };
  return {
    get journal() {
      return state.journal;
    },
    async getTask(taskId) {
      return taskId === TASK_ID ? { detail: { release: state.journal } } : null;
    },
    taskReleaseJournalFromDetail(detail) {
      return detail?.release === state.journal ? state.journal : null;
    },
    async findPriorCommittedTaskReleaseReceipt() {
      return reusable;
    },
    async appendTaskReleaseReceipt(taskId, expectedCursor, input): Promise<AppendTaskReleaseReceiptResult> {
      if (taskId !== TASK_ID) return { ok: false, reason: 'task_not_found', journal: null };
      if (state.journal.cursor !== expectedCursor) {
        return { ok: false, reason: 'cursor_mismatch', journal: state.journal };
      }
      const matching = state.journal.receipts.filter(
        (receipt) => receipt.requestIdentity === input.requestIdentity,
      );
      const prior = matching.at(-1);
      const valid =
        input.state === 'intent'
          ? matching.length === 0
          : input.state === 'unknown'
            ? prior?.state === 'intent'
            : prior?.state === 'intent' || prior?.state === 'unknown';
      if (!valid) return { ok: false, reason: 'invalid_transition', journal: state.journal };
      const receipt: TaskReleaseReceipt = {
        sequence: state.journal.cursor,
        operationId: input.operationId,
        requestIdentity: input.requestIdentity,
        stage: input.stage,
        state: input.state,
        inputHash: input.inputHash,
        inputIdentity: input.inputIdentity ?? null,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        credentialGeneration: input.credentialGeneration ?? null,
        credentialExpiresAt: input.credentialExpiresAt ?? null,
        reuseSource: input.reuseSource ?? null,
        lookupElapsedMs: input.lookupElapsedMs ?? null,
        queueWaitMs: input.queueWaitMs ?? null,
        preparationElapsedMs: input.preparationElapsedMs ?? null,
        reuseExpiresAt: input.reuseExpiresAt ?? null,
        recordedAt: input.recordedAt ?? new Date(0).toISOString(),
      };
      state.journal.receipts.push(receipt);
      state.journal.cursor += 1;
      state.journal.currentStage = receipt.stage;
      state.journal.currentState = receipt.state;
      if (receipt.state === 'intent') state.journal.spentOperationIds.push(receipt.requestIdentity);
      return { ok: true, journal: state.journal, receipt };
    },
  };
}

function context(store = ledger()): ReleaseTaskStageContext {
  return {
    taskId: TASK_ID,
    operationId: OPERATION_ID,
    ledger: store,
    identity: {
      sourceSha: SOURCE_SHA,
      gitlinks: { 'papercusp-desktop': GITLINK },
      version: '0.0.19-nightly',
      channel: 'nightly',
    },
  };
}

const stage = { stage: 'release.build.linux', identity: 'linux|gui|0.0.19-nightly' };

describe('release task journal identity', () => {
  it('uses canonical stable hashes and attempt-distinct provider-safe request IDs', () => {
    expect(releaseStageInputHash({ b: [2, 3], a: 1 })).toBe(
      releaseStageInputHash({ a: 1, b: [2, 3] }),
    );
    const hash = releaseStageInputHash(stage);
    const first = releaseStageRequestIdentity(OPERATION_ID, stage.stage, hash, 0);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(releaseStageRequestIdentity(OPERATION_ID, stage.stage, hash, 1)).not.toBe(first);
  });

  it('fails closed when source, gitlink, version, or channel identity changes', () => {
    const value = journal();
    expect(() => assertReleaseTaskIdentity(value, context().identity)).not.toThrow();
    expect(() =>
      assertReleaseTaskIdentity(value, { ...context().identity, gitlinks: { 'papercusp-desktop': 'c'.repeat(40) } }),
    ).toThrow(/gitlink tuple/);
    expect(() => assertReleaseTaskIdentity(value, { ...context().identity, version: '0.0.20' })).toThrow(
      /artifact identity/,
    );
  });

  it('binds a digest-identified (workspace-host) journal by bundle digest, failing closed both ways', () => {
    const digest = 'd'.repeat(64);
    const bundleJournal = journal({ artifactIdentity: { bundleSha256: digest } });
    const bound = { ...context().identity, version: '0.0.20-p318r37', channel: 'workspace-host', bundleSha256: digest };
    expect(() => assertReleaseTaskIdentity(bundleJournal, bound)).not.toThrow();
    expect(() => assertReleaseTaskIdentity(bundleJournal, { ...bound, bundleSha256: 'e'.repeat(64) })).toThrow(
      /artifact digest d{64} does not match e{64}/,
    );
    // A label-bound (desktop) caller never matches a digest-only journal...
    expect(() => assertReleaseTaskIdentity(bundleJournal, context().identity)).toThrow(/artifact identity/);
    // ...and a digest-bound caller never matches a label-identified journal.
    expect(() => assertReleaseTaskIdentity(journal(), bound)).toThrow(/artifact digest \(none\)/);
    // The digest still sits behind the source + gitlink checks.
    expect(() => assertReleaseTaskIdentity(bundleJournal, { ...bound, sourceSha: 'f'.repeat(40) })).toThrow(/source/);
  });

  it('leaves a label-bound stage preimage unchanged and binds a digest-bound one to its digest', () => {
    const label = releaseTaskStageContentIdentity(context(), stage);
    expect((label.release as Record<string, unknown>).bundleSha256).toBeUndefined();
    const bound = releaseTaskStageContentIdentity(
      { ...context(), identity: { ...context().identity, bundleSha256: 'd'.repeat(64) } },
      stage,
    );
    expect((bound.release as Record<string, unknown>).bundleSha256).toBe('d'.repeat(64));
  });

  it('content-addresses complete source, dependency/toolchain/profile/policy/signer/audit identity by stage', () => {
    const base = context();
    const complete = {
      stage: 'release.build.linux',
      identity: {
        dependencies: 'generation-a',
        toolchain: 'toolchain-a',
        profile: 'profile-a',
        policy: 'policy-a',
        signing: 'signer-a',
        audit: 'audit-a',
      },
    };
    const hash = releaseTaskStageInputHash(base, complete);
    for (const key of ['dependencies', 'toolchain', 'profile', 'policy', 'signing', 'audit']) {
      expect(releaseTaskStageInputHash(base, {
        ...complete,
        identity: { ...complete.identity, [key]: `${key}-b` },
      })).not.toBe(hash);
    }
    expect(releaseTaskStageInputHash({ ...base, identity: { ...base.identity, sourceSha: 'c'.repeat(40) } }, complete)).not.toBe(hash);
    expect(releaseTaskStageInputHash({ ...base, identity: { ...base.identity, gitlinks: { 'papercusp-desktop': 'd'.repeat(40) } } }, complete)).not.toBe(hash);

    const manifest = { stage: 'release.manifest', identity: { artifacts: 'bytes-a' }, sourceScope: 'stage' as const };
    expect(releaseTaskStageInputHash(base, manifest)).toBe(
      releaseTaskStageInputHash({ ...base, identity: { ...base.identity, sourceSha: 'e'.repeat(40) } }, manifest),
    );
    expect(releaseTaskStageInputHash(base, { ...manifest, identity: { artifacts: 'bytes-b' } })).not.toBe(
      releaseTaskStageInputHash(base, manifest),
    );
    expect(releaseTaskStageContentIdentity(base, manifest)).toMatchObject({
      sourceScope: 'stage',
      release: { version: '0.0.19-nightly', channel: 'nightly' },
    });
  });
});

describe('release task stage transitions', () => {
  it('begins once under a concurrent race and sends the loser to reconciliation', async () => {
    const store = ledger();
    const [left, right] = await Promise.all([
      beginReleaseTaskStage(context(store), stage),
      beginReleaseTaskStage(context(store), stage),
    ]);
    expect([left.action, right.action].sort()).toEqual(['reconcile', 'run']);
    expect(store.journal.receipts).toHaveLength(1);
    expect(store.journal.spentOperationIds).toEqual([left.requestIdentity ?? right.requestIdentity]);
  });

  it('resumes an intent through reconciliation, then reuses committed evidence', async () => {
    const store = ledger();
    const begun = await beginReleaseTaskStage(context(store), stage);
    expect(begun.action).toBe('run');
    const resumed = await beginReleaseTaskStage(context(store), stage);
    expect(resumed).toMatchObject({ action: 'reconcile', state: 'intent' });
    await settleReleaseTaskStage(context(store), {
      ...stage,
      requestIdentity: begun.requestIdentity!,
      state: 'committed',
      evidenceRefs: ['artifact:sha256:123'],
    });
    await expect(beginReleaseTaskStage(context(store), stage)).resolves.toMatchObject({
      action: 'reuse',
      state: 'committed',
    });
  });

  it('resumes after an injected interruption at every desktop release phase without replaying committed work', async () => {
    const store = ledger();
    const phases = [
      'release.build.linux',
      'release.build.windows',
      'release.build.mac',
      'release.manifest',
    ];

    for (const phase of phases) {
      const input = { stage: phase, identity: { phase, artifact: `${phase}-bytes` } };
      const started = await beginReleaseTaskStage(context(store), input);
      expect(started, `${phase} did not start a fresh attempt`).toMatchObject({ action: 'run', state: 'intent' });

      const interrupted = await settleReleaseTaskStage(context(store), {
        ...input,
        requestIdentity: started.requestIdentity!,
        state: 'unknown',
        evidenceRefs: [`fault:interrupted-after:${phase}`],
      });
      expect(interrupted).toMatchObject({ action: 'reconcile', state: 'unknown' });

      const resumed = await beginReleaseTaskStage(context(store), input);
      expect(resumed, `${phase} replayed instead of reconciling the interrupted request`).toMatchObject({
        action: 'reconcile',
        state: 'unknown',
        requestIdentity: started.requestIdentity,
      });

      const committed = await settleReleaseTaskStage(context(store), {
        ...input,
        requestIdentity: started.requestIdentity!,
        state: 'committed',
        evidenceRefs: [`artifact-set:verified:${phase}`],
      });
      expect(committed).toMatchObject({ action: 'reuse', state: 'committed' });

      const replay = await beginReleaseTaskStage(context(store), input);
      expect(replay, `${phase} did not reuse its verified receipt`).toMatchObject({
        action: 'reuse',
        state: 'committed',
        requestIdentity: started.requestIdentity,
      });
    }

    expect(store.journal.receipts.map(({ stage, state }) => ({ stage, state }))).toEqual(
      phases.flatMap((stage) => [
        { stage, state: 'intent' },
        { stage, state: 'unknown' },
        { stage, state: 'committed' },
      ]),
    );
  });

  it('seeds a prior committed hit only as a fresh reconcile intent, then records measured preparation', async () => {
    const priorReceipt: TaskReleaseReceipt = {
      sequence: 4,
      operationId: 'release-operation-prior',
      requestIdentity: 'prior-request',
      stage: stage.stage,
      state: 'committed',
      inputHash: 'resolved-by-lookup',
      evidenceRefs: ['artifact-set:hash-signature-verified'],
      credentialGeneration: 'generation-7',
      credentialExpiresAt: '2026-09-10T00:00:00.000Z',
      recordedAt: '2026-09-09T00:00:00.000Z',
      reuseExpiresAt: '2026-09-10T00:00:00.000Z',
    };
    const store = ledger(journal(), {
      taskId: 'release-task-prior',
      operationId: priorReceipt.operationId,
      receipt: priorReceipt,
    });
    const ticks = [10, 14];
    const reusableContext: ReleaseTaskStageContext = {
      ...context(store),
      credentialGeneration: 'generation-7',
      credentialExpiresAt: '2026-09-10T00:00:00.000Z',
      reuseMaxAgeMs: 86_400_000,
      reuseExpiresAt: '2026-09-10T12:00:00.000Z',
      queueWaitMs: 7,
      now: () => new Date('2026-09-09T12:00:00.000Z'),
      monotonicNow: () => ticks.shift()!,
    };
    const begun = await beginReleaseTaskStage(reusableContext, {
      ...stage,
      requiredReuseEvidenceRefs: ['artifact-set:hash-signature-verified'],
    });
    expect(begun).toMatchObject({
      action: 'reconcile',
      state: 'intent',
      lookupElapsedMs: 4,
      reuseSource: { taskId: 'release-task-prior', operationId: 'release-operation-prior', sequence: 4 },
    });
    expect(store.journal.receipts).toHaveLength(1);
    expect(store.journal.receipts[0]).toMatchObject({
      state: 'intent',
      queueWaitMs: 7,
      reuseExpiresAt: null,
    });
    const committed = await settleReleaseTaskStage(reusableContext, {
      ...stage,
      requiredReuseEvidenceRefs: ['artifact-set:hash-signature-verified'],
      requestIdentity: begun.requestIdentity!,
      state: 'committed',
      evidenceRefs: ['artifact-set:hash-signature-verified'],
      preparationElapsedMs: 25,
    });
    expect(committed).toMatchObject({ action: 'reuse', freshness: 'fresh' });
    expect(store.journal.receipts.at(-1)).toMatchObject({
      preparationElapsedMs: 25,
      reuseExpiresAt: '2026-09-10T12:00:00.000Z',
      reuseSource: { taskId: 'release-task-prior', sequence: 4 },
    });
  });

  it('refuses an operation-local committed receipt at its audit-expiry boundary', async () => {
    let now = new Date('2026-09-09T12:00:00.000Z');
    const store = ledger();
    const expiringContext: ReleaseTaskStageContext = {
      ...context(store),
      reuseMaxAgeMs: 60_000,
      reuseExpiresAt: '2026-09-09T12:01:00.000Z',
      now: () => now,
    };
    const begun = await beginReleaseTaskStage(expiringContext, stage);
    expect(begun.action).toBe('run');
    await expect(settleReleaseTaskStage(expiringContext, {
      ...stage,
      requestIdentity: begun.requestIdentity!,
      state: 'committed',
      evidenceRefs: ['artifact-set:hash-signature-verified'],
    })).resolves.toMatchObject({ action: 'reuse', freshness: 'fresh' });

    now = new Date('2026-09-09T12:01:00.000Z');
    await expect(inspectReleaseTaskStage(expiringContext, stage)).resolves.toMatchObject({
      action: 'refused',
      state: 'committed',
      freshness: 'expired',
    });
    await expect(beginReleaseTaskStage(expiringContext, stage)).resolves.toMatchObject({
      action: 'refused',
      state: 'committed',
      freshness: 'expired',
    });
    expect(store.journal.receipts).toHaveLength(2);
  });

  it('records confirmed absence before minting a new one-use attempt', async () => {
    const store = ledger();
    const first = await beginReleaseTaskStage(context(store), stage);
    await settleReleaseTaskStage(context(store), {
      ...stage,
      requestIdentity: first.requestIdentity!,
      state: 'unknown',
      evidenceRefs: ['process:interrupted'],
    });
    await settleReleaseTaskStage(context(store), {
      ...stage,
      requestIdentity: first.requestIdentity!,
      state: 'refused',
      evidenceRefs: ['reconcile:confirmed-absent'],
    });
    const retry = await beginReleaseTaskStage(context(store), stage);
    expect(retry.action).toBe('run');
    expect(retry.requestIdentity).not.toBe(first.requestIdentity);
    expect(store.journal.spentOperationIds).toHaveLength(2);
  });

  it('names changed input identity fields when refusing changed stage inputs', async () => {
    const store = ledger();
    const originalStage = {
      ...stage,
      identity: { toolchain: { node: 'v25.9.0', npm: '11.12.1' } },
    };
    const changedStage = {
      ...stage,
      identity: { toolchain: { node: 'v22.21.1', npm: '10.9.4' } },
    };
    const first = await beginReleaseTaskStage(context(store), originalStage);
    await expect(
      inspectReleaseTaskStage(context(store), changedStage),
    ).rejects.toThrow(
      /stageIdentity\.toolchain\.node: "v25\.9\.0" -> "v22\.21\.1"; stageIdentity\.toolchain\.npm: "11\.12\.1" -> "10\.9\.4"/,
    );
    await expect(
      settleReleaseTaskStage(context(store), {
        ...originalStage,
        requestIdentity: 'wrong-request',
        state: 'committed',
      }),
    ).rejects.toThrow(/does not match/);
    expect(first.action).toBe('run');
  });
});
