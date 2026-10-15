/**
 * hold_open.test.ts — work_items:hold_open handler.
 *
 * EI-18672701535825889: before this fix, `clear` only consulted
 * readWorkItemHeldOpenBy (the `held_open_by` LEASE convention) to decide whether a
 * non-holder needed `force:true`. A row held ONLY via the sibling `claim_hold_by`
 * DURABLE-PARK convention (release{claimHold:true}) read as having no prior holder
 * at all, so ANY agent could clear it — no ownership check, no force required. These
 * tests pin both the closed gap (durable-park clears now need force, same as a
 * lease) and the new policy-gate override (force:true alone must not lift a hold
 * whose reason names a deliberate policy-tier gate).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const identity = vi.hoisted(() => ({ ownerId: 'me', workspaceId: 'ws-1' as string | null }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: identity.ownerId, workspaceId: identity.workspaceId }),
}));

// D-009: keep the REAL pure planner + fingerprint (the CAS semantics under test), mock only
// the two database seams. The real-store path is pinned by hold_open.integration.test.ts.
const readDurableParkControlRow = vi.fn();
const runWorkItemDurableParkReconciliation = vi.fn();
vi.mock('../../work-items-durable-park-audit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readDurableParkControlRow: (...a: unknown[]) => readDurableParkControlRow(...a),
  runWorkItemDurableParkReconciliation: (...a: unknown[]) => runWorkItemDurableParkReconciliation(...a),
}));

const getWorkItem = vi.fn();
const setWorkItemClaimHold = vi.fn();
vi.mock('../../work-items', async (importOriginal) => ({
  // Keep the REAL readWorkItemClaimHoldProvenance (+ its readers) — it's a pure
  // payload reader and is exactly the unified-read fix this suite exercises.
  ...(await importOriginal<object>()),
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  setWorkItemClaimHold: (...a: unknown[]) => setWorkItemClaimHold(...a),
}));

const sendMessage = vi.fn();
vi.mock('../coordination/messages', () => ({
  sendMessage: (...a: unknown[]) => sendMessage(...a),
}));

const holdOpen = (await import('./hold_open')).default;
const { durableParkFingerprint, durableParkSingleReconcileRunId } = await import('../../work-items-durable-park-audit');

const parse = (x: unknown) => (holdOpen.args as { parse: (x: unknown) => unknown }).parse(x);
const call = async (x: unknown, ctx: unknown = {}) => {
  const res = (await holdOpen.handler(parse(x) as never, ctx as never)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(res.content[0].text);
};

function itemWith(payload: Record<string, unknown> | null) {
  return { id: 'WI-9', harness: 'papercup', payload };
}

beforeEach(() => {
  vi.clearAllMocks();
  identity.ownerId = 'me';
  identity.workspaceId = 'ws-1';
  sendMessage.mockResolvedValue(undefined);
  setWorkItemClaimHold.mockResolvedValue({ id: 'WI-9', harness: 'papercup', hold: false, applicable: true });
});

describe('work_items:hold_open clear — claim-hold ownership gate', () => {
  it('clears your OWN held_open lease without force', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, held_open_by: 'me', held_open_reason: 'verifying' }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'me' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });

  it('WI-6746: an unreadable item reports a READ FAILURE, never "not found"', async () => {
    // A caller placing or clearing a HOLD who is told "not found" re-files or re-creates
    // the item; one told the read failed retries. Same null, opposite correct action.
    getWorkItem.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('work_item_unreadable');
    expect(out.error).not.toMatch(/not found/i);
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('refuses to clear a PEER\'s held_open lease without force (pre-existing behavior)', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, held_open_by: 'peer', held_open_reason: 'reviewing' }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: false, error: 'not_holder', heldBy: 'peer' });
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('EI-18672701535825889 (the fix): refuses to clear a PEER\'s durable claim_hold PARK without force — previously silently succeeded', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'do not re-pick-up' }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: false, error: 'not_holder', heldBy: 'peer', convention: 'claim_hold (durable park)' });
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('clears a peer\'s durable park WITH force:true (ordinary, non-policy reason)', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'do not re-pick-up' }));
    const out = await call({ id: 'WI-9', clear: true, force: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'peer' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });

  it('EI-18672701535825889 suggestion #5: force:true ALONE is refused on a policy-tier gate (D-NNN reason)', async () => {
    getWorkItem.mockResolvedValue(
      itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'Explicit policy-tier human gate (D-003): git-sync' }),
    );
    const out = await call({ id: 'WI-9', clear: true, force: true });
    expect(out).toMatchObject({ ok: false, error: 'policy_gate_requires_owner_override', heldBy: 'peer' });
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
  });

  it('policy-tier gate lifts only with BOTH force:true and ownerOverride:true', async () => {
    getWorkItem.mockResolvedValue(
      itemWith({ _claimHold: true, claim_hold_by: 'peer', claim_hold_reason: 'triageDecision:"gate" — security review' }),
    );
    const out = await call({ id: 'WI-9', clear: true, force: true, ownerOverride: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'peer' });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });

  it('self-clearing your OWN policy-gate hold needs neither force nor ownerOverride', async () => {
    getWorkItem.mockResolvedValue(
      itemWith({ _claimHold: true, claim_hold_by: 'me', claim_hold_reason: 'D-003 policy-tier gate' }),
    );
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: 'me' });
  });

  it('a row with NEITHER convention (genuinely unattributed) clears freely, as before', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true }));
    const out = await call({ id: 'WI-9', clear: true });
    expect(out).toMatchObject({ ok: true, held: false, clearedFrom: null });
    expect(setWorkItemClaimHold).toHaveBeenCalledWith('WI-9', false, { harness: 'papercup' });
  });
});

/**
 * EI-20710656847511624 — the hold RESPONSE must disclose that the hold expires.
 *
 * Three agents in a row fenced the same owner-gated live-money items with hold_open
 * intending "permanent" and each got "until I die": the dead-owner sweeps match
 * `held_open_by = <dead owner>` and lift the hold + `_claimHold`. Every one of them had
 * verified the hold APPLIED and stopped there, because `{ ok:true, held:true }` reads as
 * a completed fence. These pin the disclosure so a refactor cannot quietly drop it.
 */
describe('work_items:hold_open hold — lease-expiry disclosure', () => {
  beforeEach(() => {
    setWorkItemClaimHold.mockResolvedValue({ id: 'WI-9', harness: 'papercup', hold: true, applicable: true });
    getWorkItem.mockResolvedValue(itemWith(null));
  });

  it('an ordinary hold discloses that it is a LEASE and names the durable alternative', async () => {
    const out = await call({ id: 'WI-9', reason: 'verifying the fix before anyone closes it' });
    expect(out).toMatchObject({ ok: true, held: true, heldBy: 'me' });
    expect(out.durability).toBe('lease (expires when you do)');
    // The two things a caller must be told: it expires, and what to use instead.
    expect(out.leaseNote).toMatch(/LEASE, NOT a permanent fence/);
    expect(out.leaseNote).toMatch(/release \{ claimHold:true \}/);
  });

  it('a POLICY-TIER reason is reported exempt, but still warns the exemption keys off wording', async () => {
    const out = await call({ id: 'WI-9', reason: 'Explicit policy-tier human gate (D-003): owner sign-off' });
    expect(out.durability).toBe('lease (policy-tier exempt from reaping)');
    expect(out.leaseNote).toMatch(/exempt/);
    expect(out.leaseNote).toMatch(/WORDING, not intent/);
    expect(out.leaseNote).toMatch(/release \{ claimHold:true \}/);
  });

  it('the disclosure is UNCONDITIONAL — a terse reason still gets it', async () => {
    // The failure mode was a caller concluding "fenced" from { ok:true, held:true } alone,
    // so the warning must not depend on how the reason happens to be phrased.
    const out = await call({ id: 'WI-9', reason: 'gate' });
    expect(out.leaseNote).toBeTruthy();
    expect(out.durability).toMatch(/^lease/);
  });

  it('re-stamping a peer\'s hold keeps BOTH the re-stamp note and the lease disclosure', async () => {
    getWorkItem.mockResolvedValue(itemWith({ _claimHold: true, held_open_by: 'peer', held_open_reason: 'theirs' }));
    const out = await call({ id: 'WI-9', reason: 'taking over the gate' });
    expect(out.note).toMatch(/re-stamped \(was held by peer\)/);
    expect(out.leaseNote).toMatch(/LEASE/);
  });
});

/**
 * Plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 D-009 — the AGENT DOOR to the
 * evidence-based durable-park clearer. Before it, a park whose release condition was met could
 * be lifted by an agent only with force:true, which bypasses the fingerprint/evidence contract.
 */
describe('work_items:hold_open clear+reconcile — evidence-based durable-park settlement (D-009)', () => {
  const PARK = {
    _claimHold: 'true',
    claim_hold_by: 'peer',
    claim_hold_reason: 'parked until 768c5d609 is deployed to :3070',
    claim_hold_at: '2026-10-08T10:00:00.000Z',
  };
  const EVIDENCE = 'deploy.3070.sha=d740fc3802 contains 768c5d609 (git merge-base --is-ancestor; blob equal at the fix path)';
  const controlRow = (payload: Record<string, unknown>, takenBy: string | null = null) => ({
    id: 'WI-9', state: 'blocked', takenBy, payload,
  });
  const fpOf = (payload: Record<string, unknown>, takenBy: string | null = null) =>
    durableParkFingerprint({ state: 'blocked', takenBy, payload });
  const reconcileResult = (row: Record<string, unknown>) => ({
    schemaVersion: 'durable-park-reconcile-v1', runId: 'rid', inputSha256: 'x', workspaceId: 'ws-1',
    harnessSlug: 'papercup', generatedAt: '2026-10-10T19:00:00.000Z', actor: 'me', requested: 1,
    cleared: row.outcome === 'cleared' ? 1 : 0, unchanged: row.outcome === 'cleared' ? 0 : 1,
    rows: [row], artifactPath: 'reports/durable-parks/rid-reconcile.json',
  });

  beforeEach(() => {
    getWorkItem.mockResolvedValue(itemWith(PARK));
    readDurableParkControlRow.mockResolvedValue(controlRow(PARK));
  });

  it('omitting the fingerprint is a DRY RUN: returns the CAS fingerprint and writes nothing', async () => {
    const out = await call({ id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE } });
    expect(out).toMatchObject({ ok: true, dryRun: true, outcome: 'cleared', wouldClear: true, ownerOverrideRequired: false });
    expect(out.observedParkFingerprint).toBe(fpOf(PARK));
    expect(out.next).toContain(fpOf(PARK));
    expect(readDurableParkControlRow).toHaveBeenCalledWith({ workspaceId: 'ws-1', harnessSlug: 'papercup', id: 'WI-9' });
    expect(runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('dryRun:true with a fingerprint previews a STALE one without writing', async () => {
    const out = await call({
      id: 'WI-9', clear: true,
      reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE, expectedParkFingerprint: 'a'.repeat(64), dryRun: true },
    });
    expect(out).toMatchObject({ ok: true, dryRun: true, outcome: 'stale-fingerprint', wouldClear: false });
    expect(out.next).toMatch(/Re-read with reconcile.dryRun/);
    expect(runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
  });

  it('a dry run reports a live holder as `assigned` (real planner: never cleared from under a claim)', async () => {
    readDurableParkControlRow.mockResolvedValue(controlRow(PARK, 'someone-live'));
    const out = await call({ id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE } });
    expect(out).toMatchObject({ dryRun: true, outcome: 'assigned', wouldClear: false, takenBy: 'someone-live' });
  });

  it('clears a PEER\'s park with evidence + fingerprint and NO force — via the reconciler, never setWorkItemClaimHold', async () => {
    const fp = fpOf(PARK);
    runWorkItemDurableParkReconciliation.mockResolvedValue(reconcileResult({
      id: 'WI-9', outcome: 'cleared', expectedParkFingerprint: fp, observedParkFingerprint: fp,
      reasonCode: 'condition-satisfied', evidence: EVIDENCE, preservedLease: false, takenBy: null,
    }));
    const out = await call({
      id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE, expectedParkFingerprint: fp },
    });
    expect(out).toMatchObject({ ok: true, outcome: 'cleared', held: false, clearedFrom: 'peer', runId: 'rid' });
    const decision = { id: 'WI-9', expectedParkFingerprint: fp, reasonCode: 'condition-satisfied', evidence: EVIDENCE };
    expect(runWorkItemDurableParkReconciliation).toHaveBeenCalledWith({
      workspaceId: 'ws-1', harnessSlug: 'papercup', actor: 'me', decisions: [decision],
      runId: durableParkSingleReconcileRunId({ workspaceId: 'ws-1', harnessSlug: 'papercup', actor: 'me', decision: decision as never }),
    });
    expect(setWorkItemClaimHold).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ extra: { lifecycle: 'durable_park_reconcile', work_item: 'WI-9' } });
  });

  it('returns a non-clearing reconciler verdict VERBATIM as a refusal with a next step, and broadcasts nothing', async () => {
    const fp = fpOf(PARK);
    runWorkItemDurableParkReconciliation.mockResolvedValue(reconcileResult({
      id: 'WI-9', outcome: 'stale-fingerprint', expectedParkFingerprint: fp, observedParkFingerprint: 'b'.repeat(64),
      reasonCode: 'condition-satisfied', evidence: EVIDENCE, preservedLease: false, takenBy: null,
    }));
    const out = await call({
      id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE, expectedParkFingerprint: fp },
    });
    expect(out).toMatchObject({ ok: false, outcome: 'stale-fingerprint', error: 'reconcile_stale-fingerprint' });
    expect(out.hint).toMatch(/dryRun/);
    expect(out.observedParkFingerprint).toBe('b'.repeat(64));
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('a policy-tier park is previewable but its WRITE needs ownerOverride — evidence alone does not lift an owner gate', async () => {
    const gated = { ...PARK, claim_hold_reason: 'Explicit policy-tier human gate (D-003): owner decides' };
    getWorkItem.mockResolvedValue(itemWith(gated));
    readDurableParkControlRow.mockResolvedValue(controlRow(gated));
    const preview = await call({ id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE } });
    expect(preview).toMatchObject({ ok: true, dryRun: true, ownerOverrideRequired: true, wouldClear: false });
    const overridden = await call({ id: 'WI-9', clear: true, ownerOverride: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE } });
    expect(overridden).toMatchObject({ ok: true, dryRun: true, ownerOverrideRequired: true, wouldClear: true });
    const out = await call({
      id: 'WI-9', clear: true,
      reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE, expectedParkFingerprint: fpOf(gated) },
    });
    expect(out).toMatchObject({ ok: false, error: 'policy_gate_requires_owner_override', heldBy: 'peer' });
    expect(runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
  });

  it('operator-directed asserts an owner instruction, so it needs ownerOverride:true', async () => {
    const out = await call({
      id: 'WI-9', clear: true,
      reconcile: { reasonCode: 'operator-directed', evidence: 'owner said so', expectedParkFingerprint: fpOf(PARK) },
    });
    expect(out).toMatchObject({ ok: false, error: 'operator_directed_requires_owner_override' });
    expect(runWorkItemDurableParkReconciliation).not.toHaveBeenCalled();
  });

  it('refuses without a workspace scope rather than reading or writing an unscoped row', async () => {
    identity.workspaceId = null;
    const out = await call({ id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE } });
    expect(out).toMatchObject({ ok: false, error: 'reconcile_scope_unresolved' });
    expect(readDurableParkControlRow).not.toHaveBeenCalled();
  });

  it('reconcile without clear:true, a bad reason code, blank evidence or a malformed fingerprint are schema refusals', () => {
    expect(() => parse({ id: 'WI-9', reason: 'x', reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE } })).toThrow(/clear:true/);
    expect(() => parse({ id: 'WI-9', clear: true, reconcile: { reasonCode: 'stale-age', evidence: EVIDENCE } })).toThrow();
    expect(() => parse({ id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: '   ' } })).toThrow();
    expect(() => parse({ id: 'WI-9', clear: true, reconcile: { reasonCode: 'condition-satisfied', evidence: EVIDENCE, expectedParkFingerprint: 'abc' } })).toThrow();
  });

  it('the runId is deterministic for identical input and changes when any decision input changes', () => {
    const base = { workspaceId: 'ws-1', harnessSlug: 'papercup', actor: 'me' };
    const d = { id: 'WI-9', expectedParkFingerprint: 'c'.repeat(64), reasonCode: 'condition-satisfied' as const, evidence: EVIDENCE };
    const a = durableParkSingleReconcileRunId({ ...base, decision: d });
    expect(durableParkSingleReconcileRunId({ ...base, decision: { ...d } })).toBe(a);
    expect(a).toContain(':reconcile:tool:WI-9:');
    expect(durableParkSingleReconcileRunId({ ...base, decision: { ...d, evidence: `${EVIDENCE} (rechecked)` } })).not.toBe(a);
    expect(durableParkSingleReconcileRunId({ ...base, decision: { ...d, expectedParkFingerprint: 'd'.repeat(64) } })).not.toBe(a);
    expect(durableParkSingleReconcileRunId({ ...base, actor: 'other', decision: d })).not.toBe(a);
  });
});
