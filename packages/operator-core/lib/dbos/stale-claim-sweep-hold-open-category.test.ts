/**
 * stale-claim-sweep-hold-open-category.test.ts — EI-18183171615661851.
 *
 * The `stale-claim-sweep` tick's hold-open-sweep broadcast (WI-4531, in the
 * `to: ['*']` sendMessage call inside in-process-periodic.ts) went out with NO
 * `category`, unlike every sibling system-routine broadcast (service-health,
 * doc-drift, agent-governor, resource-locks — see coord:inbox's
 * AMBIENT_CATEGORIES). Because the message differs (a different feature_id) on
 * every fire, coord:inbox's exact-text `coalesceRepeatedBroadcasts` can never
 * fold repeats — and with no `category`, `isAmbientBroadcast` couldn't
 * default-exclude them either. On a fleet where holds expire in a trickle, this
 * produced a run of near-identical "lifted N EXPIRED hold(s)" broadcasts (5 in
 * one wake's digest was the reported case) burying real signal.
 *
 * Regression: assert the tick tags this broadcast `category: 'service-health'`
 * — the same category the sibling system routines use — so it is silenced by
 * coord:inbox's default ambient exclusion (still visible via include_ambient).
 * Every OTHER reclaim leg in the tick is mocked to a no-op release set so this
 * test isolates the hold-open broadcast path alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessage, staleClaimState, recordInvoluntaryClaimReleases } = vi.hoisted(() => ({
  sendMessage: vi.fn(async (_identity: unknown, _opts: Record<string, unknown>) => ({})),
  staleClaimState: { released: [] as Record<string, unknown>[] },
  recordInvoluntaryClaimReleases: vi.fn(
    async (_sql: unknown, _opts: Record<string, unknown>) => ({ audited: 1, notified: 0, failures: [] as string[] }),
  ),
}));

vi.mock('../agent-tools/coordination/messages', () => ({ sendMessage }));
vi.mock('../claim-release-notice', () => ({ recordInvoluntaryClaimReleases }));

// A minimal callable tagged-template stub — the P-017 lease-backstop leg (not
// under test here) calls `sql\`...\`` directly rather than through a mocked
// reclaim function; returning [] keeps it a real no-op instead of a caught
// "sql is not a function" exception (non-fatal, but it logs a console.warn
// that would otherwise trip this repo's fail-on-console test setup).
const sqlStub = Object.assign(async () => [], {}) as unknown as (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<unknown[]>;
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlStub }),
}));

vi.mock('@papercusp/flags', () => ({ FLAGS: { RECLAIM_STALLED: 'RECLAIM_STALLED' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: async () => false }));

vi.mock('../coord-liveness-config', () => ({
  readCoordLivenessConfig: async () => ({
    reclaimGraceMs: 10 * 60_000,
    reclaimParkedGraceMs: 30 * 60_000,
    reclaimRequeueCap: 3,
    holdOpenGraceMs: 2 * 3600_000,
    assignmentReclaimGraceMs: 3600_000,
  }),
}));

// PARTIAL mock (importOriginal) — stale-claim-sweep's tick() DESTRUCTURES every export
// it uses in ONE statement, up front, OUTSIDE the per-reaper try/catch. So a factory that
// omits an export production later adds doesn't just skip that leg — it throws
// "No <x> export is defined on the mock" and fails the WHOLE tick, in a test that has
// nothing to do with the new export (EI-18715782165335169: WI-6039 added
// reconcileStrandedWipWorkItems and this factory went stale). Spreading the real module
// keeps that drift from recurring; the three async DB-touching exports are still stubbed
// explicitly below. Every remaining export is a constant or a pure SQL-fragment builder.
vi.mock('../work-items-stale-claims', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../work-items-stale-claims')>()),
  reclaimStaleWorkItemClaims: async () => ({ released: staleClaimState.released }),
  reclaimStaleIssueClaims: async () => ({ released: [], orphanLeasesCleared: 0 }),
  reconcileStrandedWipWorkItems: async () => [],
}));

vi.mock('../dead-owner-control-sweep', () => ({
  sweepDeadOwnerControlState: async () => ({ owners: [], loopsTerminated: 0, holdsLifted: 0 }),
}));

// The one reaper this test exercises for real output. TWO NON-terminal expired
// holds, so the broadcast branch (`starved.length > 0`) fires AND the batching
// assertion below is not vacuous (EI-16016 — with the single-hold fixture this
// file used to carry, `toHaveBeenCalledTimes(1)` was satisfied just as well by a
// per-hold send loop, so batching was untestable here). The third hold is
// already TERMINAL: inert residue the broadcast must neither name nor count.
const starvedHoldA = {
  workspace_id: 'ws-1',
  harness_slug: 'papercusp',
  feature_id: 'EI-1',
  item_kind: 'issue',
  status: 'open',
  former_holder: 'su-dead',
  former_reason: 'long-running gate',
  held_open_at: new Date().toISOString(),
};
const starvedHoldB = {
  workspace_id: 'ws-1',
  harness_slug: 'papercusp',
  feature_id: 'EI-2',
  item_kind: 'issue',
  status: 'open',
  former_holder: 'su-dead-2',
  former_reason: 'long-running gate',
  held_open_at: new Date().toISOString(),
};
const terminalResidueHold = {
  workspace_id: 'ws-1',
  harness_slug: 'papercusp',
  feature_id: 'EI-3',
  item_kind: 'issue',
  status: 'resolved',
  former_holder: 'su-dead-3',
  former_reason: 'long-running gate',
  held_open_at: new Date().toISOString(),
};
vi.mock('../work-items-hold-open', () => ({
  reclaimStaleHoldOpens: async () => ({
    expired: [starvedHoldA, starvedHoldB, terminalResidueHold],
  }),
}));

vi.mock('../plan-items/stale-claims', () => ({
  reclaimExpiredPlanItemClaims: async () => ({ released: [] }),
  reclaimStaleDeadHolderPlanItemAssignments: async () => ({ released: [] }),
  reclaimStalledLivePlanItemAssignments: async () => ({ released: [] }),
}));

vi.mock('../work-queue-health', () => ({
  recordSweepRun: async () => {},
  STALE_CLAIM_SWEEP_NAME: 'stale-claim-sweep',
}));

import { buildDefaultChecks } from './in-process-periodic';

beforeEach(() => {
  vi.clearAllMocks();
  staleClaimState.released = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stale-claim-sweep tick — hold-open-sweep broadcast category (EI-18183171615661851)', () => {
  it('tags the hold-open-sweep "*" broadcast category: service-health', async () => {
    // The tick's own [hold-open] summary line (informational, not under test
    // here) is expected given the one starved hold this test manufactures.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tick = buildDefaultChecks().find((c) => c.name === 'stale-claim-sweep')!.tick;
    await tick();
    warnSpy.mockRestore();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = sendMessage.mock.calls[0] as [
      { ownerId: string },
      { to: string[]; summary: string; category?: string },
    ];
    expect(identity.ownerId).toBe('hold-open-sweep');
    expect(opts.to).toEqual(['*']);
    expect(opts.summary).toContain('hold-open sweep');
    // The regression: this must carry an ambient category so coord:inbox's
    // isAmbientBroadcast/coalesceRepeatedBroadcasts can default-exclude repeats
    // of it instead of every distinct-feature_id fire piling up as visible spam.
    expect(opts.category).toBe('service-health');
  });

  it('batches every starved hold into ONE broadcast per sweep run (EI-16016)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tick = buildDefaultChecks().find((c) => c.name === 'stale-claim-sweep')!.tick;
    await tick();
    warnSpy.mockRestore();

    // ONE message for TWO starved holds. EI-16016 (filed 2026-07-18) reported this
    // sweep sending "one coord:send broadcast PER individual expired hold" and
    // proposed batching — but the broadcast has accumulated all holds of a run into
    // a single message since its very first commit (52787dd, 2026-07-13, five days
    // BEFORE that filing). The real multiplicity was many 60s sweep RUNS each
    // lifting one hold, fixed separately by the ambient `category` stamp asserted
    // above. So the batching was never missing — only ever UNGUARDED, because the
    // fixture manufactured a single hold and a per-hold loop would have passed too.
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, opts] = sendMessage.mock.calls[0] as [unknown, { summary: string }];
    expect(opts.summary).toContain('EI-1');
    expect(opts.summary).toContain('EI-2');
    // The count is of STARVED holds, not of every expired hold: the already-resolved
    // third hold is inert residue that must not be named or counted.
    expect(opts.summary).toContain('lifted 2 EXPIRED hold(s)');
    expect(opts.summary).not.toContain('EI-3');
  });

  it('audits each work-item release with its reason while preserving the direct holder notice', async () => {
    staleClaimState.released = [
      {
        workspace_id: 'ws-1',
        harness_slug: 'papercusp',
        feature_id: 'EI-claim-source',
        item_kind: 'bug',
        former_taken_by: 'su-former-holder',
        former_status: 'wip',
        new_status: 'open',
        requeue_count: 1,
        action: 'requeued',
        reason: 'dead',
      },
      {
        workspace_id: 'ws-1',
        harness_slug: 'papercusp',
        feature_id: 'EI-claim-source-exit',
        item_kind: 'bug',
        former_taken_by: 'su-dead-spawn',
        former_status: 'wip',
        new_status: 'open',
        requeue_count: 1,
        action: 'requeued',
        reason: 'spawn-exit',
      },
    ];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tick = buildDefaultChecks().find((c) => c.name === 'stale-claim-sweep')!.tick;
    await tick();

    expect(recordInvoluntaryClaimReleases).toHaveBeenCalledTimes(2);
    expect(recordInvoluntaryClaimReleases.mock.calls.map(([, opts]) => opts)).toEqual([
      expect.objectContaining({
        workspaceId: 'ws-1',
        harness: 'papercusp',
        actor: 'reaper:dead',
        reason: 'dead',
        released: [{ workItemId: 'EI-claim-source', takenBy: 'su-former-holder', reason: 'dead' }],
        notify: false,
      }),
      expect.objectContaining({
        workspaceId: 'ws-1',
        harness: 'papercusp',
        actor: 'reaper:spawn-exit',
        reason: 'spawn-exit',
        released: [{ workItemId: 'EI-claim-source-exit', takenBy: 'su-dead-spawn', reason: 'spawn-exit' }],
        notify: false,
      }),
    ]);
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'stale-claim-sweep' }),
      expect.objectContaining({
        to: ['su-former-holder'],
        summary: expect.stringContaining('Your claim on EI-claim-source was reclaimed (reason: dead'),
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'stale-claim-sweep' }),
      expect.objectContaining({
        to: ['su-dead-spawn'],
        summary: expect.stringContaining('Your claim on EI-claim-source-exit was reclaimed (reason: spawn-exit'),
      }),
    );
    warnSpy.mockRestore();
  });
});
