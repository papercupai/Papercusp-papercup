/**
 * operator-sentinel-handoff-deps.test.ts — WI-2200 (EI-3643): the real-substrate
 * `surfaceForApproval` dep must pin a STABLE dedup identity on the escalation it
 * opens, so a re-proposal of the SAME (capability, harness) gate — worded
 * differently each turn by the Sentinel's own restatement — bumps the existing
 * open escalation (openEscalation's built-in dedup) instead of minting a fresh
 * duplicate. Live evidence: 34 open, never-resolved, differently-worded
 * escalations for capability=work_items:create/fleet:spawn harness=workspace before this
 * fix — openEscalation's default subjectSignature falls back to the raw summary
 * text, and the summary is NEVER the same twice.
 *
 * Mocks the `escalations` module's openEscalation (the only real substrate call
 * this dep makes) so the test asserts the exact args without touching PG.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('./degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));

const openEscalationSpy = vi.fn(async (_identity: unknown, input: unknown) => ({ ...(input as object), msg_id: 'esc-1' }));
const refreshCandidatesSpy = vi.fn(async () => {});

vi.mock('./agent-tools/coordination/escalations', () => ({
  openEscalation: (...args: unknown[]) => openEscalationSpy(...(args as [unknown, unknown])),
}));
vi.mock('./operator-standing-candidates', () => ({
  refreshCandidates: () => refreshCandidatesSpy(),
}));
// `surfaceForApproval` lazy-imports `./delegated-tasks` ONLY for the
// OPERATOR_COORD_OWNER const — but the real module pulls in the heavy PG chain
// (@papercusp/db-org → ./work-items → ./issues-engineer), whose one-time cold
// transform (~26s here) exceeds the 60s per-test timeout under the loaded
// green-checkpoint box. That timeout then leaks the pending openEscalation call
// into the NEXT test (the "expected 2, got 3" symptom). Mock it so the test
// stays hermetic and fast, matching this file's "without touching PG" intent.
vi.mock('./delegated-tasks', () => ({
  OPERATOR_COORD_OWNER: 'operator',
}));

// WI-37616 / P-052: `nudgeRecipient` (was `nudgeMug`) reaches two more substrate
// modules — the coord `sendMessage` it delivers on, and the SHARED nudge ladder it
// resolves the recipient through. Both are mocked so the routing decision is
// asserted directly, with no PG and no real presence/liveness oracle.
const sendMessageSpy = vi.fn(async (_identity: unknown, _input: unknown) => ({ msg_id: 'msg-1' }));
type Recipient =
  | { kind: 'mug'; ownerId: string; why: string }
  | { kind: 'su'; ownerId: string; ownerLabel: string; why: string }
  | { kind: 'escalate'; why: string }
  | { kind: 'unresolved'; why: string };
let nextRecipient: Recipient = { kind: 'su', ownerId: 'su-live-1', ownerLabel: 'su · live', why: 'test default' };
const resolveNudgeRecipientSpy = vi.fn(async (_opts: unknown) => nextRecipient);

vi.mock('./agent-tools/coordination/messages', () => ({
  sendMessage: (...args: unknown[]) => sendMessageSpy(...(args as [unknown, unknown])),
}));
vi.mock('./scout/nudge-recipient', () => ({
  resolveNudgeRecipient: (...args: unknown[]) => resolveNudgeRecipientSpy(...(args as [unknown])),
}));

import { defaultSentinelHandoffDeps } from './operator-sentinel-handoff-deps';

/**
 * WI-37616 / retire-mug-kettle-su-only-2026-08-09 P-052 — the sentinel handoff must
 * nudge someone who EXISTS.
 *
 * The defect these guard: `nudgeMug` sent every NON-URGENT handoff to the `@role:mug`
 * coord slot. That slot is drained only by a Mug, and with the Mug/Kettle tier retired
 * behind `papercusp-mug-kettle-system` (default OFF) no Mug ever spawns — so a
 * user-requested handoff was filed and then stranded with nobody signalled. The urgent
 * path escaped the bug only incidentally, by using the escalation channel.
 *
 * FALSIFIABILITY: the first test below fails against the OLD implementation, which sent
 * to '@role:mug' unconditionally on the non-urgent path regardless of who was live. The
 * `mug`-recipient test is its calibration case — it asserts the legacy park is still
 * produced when the ladder DOES name a Mug, so these are not passing merely because the
 * legacy path was deleted outright.
 */
describe('defaultSentinelHandoffDeps().nudgeRecipient — routes to someone who can act (WI-37616)', () => {
  const nudge = (over: Partial<Parameters<ReturnType<typeof defaultSentinelHandoffDeps>['nudgeRecipient']>[0]> = {}) => ({
    workItemId: 'WI-101',
    summary: 'draft the auth module',
    urgent: false,
    harness: 'papercup',
    workspaceId: 'ws-1',
    ...over,
  });

  beforeEach(() => {
    openEscalationSpy.mockClear();
    sendMessageSpy.mockClear();
    resolveNudgeRecipientSpy.mockClear();
    nextRecipient = { kind: 'su', ownerId: 'su-live-1', ownerLabel: 'su · live', why: 'test default' };
  });

  it('a live su gets the nudge DIRECTLY — never the retired @role:mug slot', async () => {
    await defaultSentinelHandoffDeps().nudgeRecipient(nudge());

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [, input] = sendMessageSpy.mock.calls[0]!;
    const to = (input as { to: string[] }).to;
    // The whole point: addressed to a REAL session id...
    expect(to).toEqual(['su-live-1']);
    // ...and emphatically NOT parked in the slot with no drainer. This is the
    // assertion the old implementation fails.
    expect(to).not.toContain('@role:mug');
  });

  it('threads the caller workspaceId into the ladder — resolution is workspace-scoped', async () => {
    await defaultSentinelHandoffDeps().nudgeRecipient(nudge({ workspaceId: 'ws-42' }));
    expect(resolveNudgeRecipientSpy).toHaveBeenCalledTimes(1);
    expect(resolveNudgeRecipientSpy.mock.calls[0]![0]).toMatchObject({ workspaceId: 'ws-42' });
  });

  it('CALIBRATION: when the ladder names a Mug, the legacy @role:mug park is still produced', async () => {
    // Guards against the lazy "fix" of deleting the Mug path outright: while the tier
    // flag is ON as a testing escape hatch, a Mug recipient must still be served.
    nextRecipient = { kind: 'mug', ownerId: 'mug-1', why: 'tier running' };
    await defaultSentinelHandoffDeps().nudgeRecipient(nudge());
    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    expect((sendMessageSpy.mock.calls[0]![1] as { to: string[] }).to).toEqual(['@role:mug']);
  });

  it('nobody live (escalate) surfaces to the owner instead of vanishing into the slot', async () => {
    nextRecipient = { kind: 'escalate', why: 'no Mug and no live su' };
    await defaultSentinelHandoffDeps().nudgeRecipient(nudge());
    expect(openEscalationSpy).toHaveBeenCalledTimes(1);
    expect(sendMessageSpy).not.toHaveBeenCalled();
    const [, input] = openEscalationSpy.mock.calls[0]!;
    expect((input as { body: string }).body).toContain('no Mug and no live su');
  });

  it('an UNRESOLVED ladder does NOT page the owner — a dependency hiccup is not evidence nobody is home', async () => {
    // The ladder's own documented contract: escalating on `unresolved` would page the
    // owner every time presence/liveness stutters and train them to ignore the channel.
    // The filed work_item remains durable and claimable, so this is a quiet degrade.
    nextRecipient = { kind: 'unresolved', why: 'presence unreadable' };
    // The degrade is deliberately NOT silent — it warns so the fallback is greppable
    // in the operator log. Asserted explicitly (rather than suppressed) because
    // `vitest-fail-on-console` treats an unasserted warn as a defect, and because a
    // quiet fallback here is exactly the failure mode this whole item is about.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnCalls: unknown[][] = [];
    try {
      await defaultSentinelHandoffDeps().nudgeRecipient(nudge());
      // SNAPSHOT the record BEFORE restoring: `mockRestore()` resets the mock as well
      // as un-patching it, which CLEARS mock.calls — asserting after the `finally`
      // reads an empty history and fails with "called 0 times" on a warn that really
      // did fire.
      warnCalls = warn.mock.calls.map((c) => [...c]);
    } finally {
      warn.mockRestore();
    }
    expect(openEscalationSpy).not.toHaveBeenCalled();
    expect((sendMessageSpy.mock.calls[0]![1] as { to: string[] }).to).toEqual(['@role:mug']);
    expect(warnCalls).toHaveLength(1);
    expect(String(warnCalls[0]![0])).toContain('nudge recipient unresolved for WI-101');
  });

  it('urgency picks the CHANNEL, not the destination: an urgent su nudge still goes to the su', async () => {
    await defaultSentinelHandoffDeps().nudgeRecipient(nudge({ urgent: true }));
    expect((sendMessageSpy.mock.calls[0]![1] as { to: string[] }).to).toEqual(['su-live-1']);
    expect((sendMessageSpy.mock.calls[0]![1] as { expectsReply: boolean }).expectsReply).toBe(true);
  });
});

describe('defaultSentinelHandoffDeps().surfaceForApproval — WI-2200 stable dedup identity', () => {
  beforeEach(() => {
    openEscalationSpy.mockClear();
    refreshCandidatesSpy.mockClear();
  });

  it('pins meta.dedupKind + subjectSignature to the (capability, harness) pair, NOT the free-text summary', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({
      summary: 'overhaul user onboarding flow end to end across the three harnesses currently owning it',
      tier: 'high',
      capability: 'work_items:create',
      harness: 'workspace',
    });
    expect(openEscalationSpy).toHaveBeenCalledTimes(1);
    const [, input] = openEscalationSpy.mock.calls[0]!;
    expect((input as { meta: { dedupKind: string; subjectSignature: string } }).meta).toEqual({
      dedupKind: 'sentinel-handoff-approval',
      subjectSignature: 'work_items:create:workspace',
    });
  });

  it('a DIFFERENTLY-WORDED re-proposal for the SAME (capability, harness) produces the SAME dedup identity', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'Add a CSV export button to the runs table', tier: 'high', capability: 'work_items:create', harness: 'workspace' });
    await deps.surfaceForApproval({ summary: 'plan and ship the new export feature EXP-2847', tier: 'high', capability: 'work_items:create', harness: 'workspace' });
    expect(openEscalationSpy).toHaveBeenCalledTimes(2);
    const sig1 = (openEscalationSpy.mock.calls[0]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    const sig2 = (openEscalationSpy.mock.calls[1]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    // Identical dedup identity despite completely different summaries — this is what
    // lets openEscalation's own findOpenDuplicate/tryBumpProjectionDuplicate collapse
    // them into one bumped-repeatCount escalation instead of two open duplicates.
    expect(sig1).toBe(sig2);
    expect(sig1).toBe('work_items:create:workspace');
  });

  it('a DIFFERENT harness produces a DISTINCT subjectSignature (never over-collapses unrelated gates)', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'x', tier: 'high', capability: 'work_items:create', harness: 'workspace' });
    await deps.surfaceForApproval({ summary: 'y', tier: 'high', capability: 'work_items:create', harness: 'analytics-core' });
    const sig1 = (openEscalationSpy.mock.calls[0]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    const sig2 = (openEscalationSpy.mock.calls[1]![1] as { meta: { subjectSignature: string } }).meta.subjectSignature;
    expect(sig1).not.toBe(sig2);
  });

  it('a null harness falls back to the "workspace" label (matches the escalation body text)', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'x', tier: 'medium', capability: 'work_items:create', harness: null });
    const input = openEscalationSpy.mock.calls[0]![1] as { meta: { subjectSignature: string }; body: string };
    expect(input.meta.subjectSignature).toBe('work_items:create:workspace');
    expect(input.body).toContain('harness=workspace');
  });

  it('still refreshes standing-approval candidates after opening the escalation', async () => {
    const deps = defaultSentinelHandoffDeps();
    await deps.surfaceForApproval({ summary: 'x', tier: 'high', capability: 'work_items:create', harness: 'workspace' });
    expect(refreshCandidatesSpy).toHaveBeenCalledTimes(1);
  });
});
