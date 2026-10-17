import { describe, expect, it } from 'vitest';
import { checkpointProof, claimProof, judgeContinuation, verifyCheckpoint } from './bench-work-item-continuations';

describe('controlled live continuation evidence oracle', () => {
  const good = { wallMs: 10, successfulReadback: true, heldAtReadback: true, ordered: true,
    claimWallMs: 10, claimSuccessfulReadback: true, claimHeldAtReadback: true,
    cancelledAbsent: true, rejectedNotForwarded: true, unknownReceipt: true,
    unknownPersisted: true, sourceStable: true };
  it('requires matching authoritative hash, verified receipt, and exact identity', () => {
    const receipt = { ok: true, results: [{ id: 'EI-1', ok: true, verified: true, contentHash: 'abc' }] };
    const read = { results: [{ id: 'EI-1', ok: true, checkpointContentHash: 'abc', checkpoint: 'marker' }] };
    expect(verifyCheckpoint(receipt, read, 'EI-1')).toBe(true);
    expect(verifyCheckpoint(receipt, read, 'EI-2')).toBe(false);
    expect(verifyCheckpoint(receipt, {}, 'EI-1')).toBe(false);
    expect(verifyCheckpoint(receipt, { results: [{ ...read.results[0], checkpointContentHash: 'def' }] }, 'EI-1')).toBe(false);
    expect(verifyCheckpoint({ ...receipt, ok: false }, read, 'EI-1')).toBe(false);
    expect(verifyCheckpoint({ results: [{ id: 'EI-1', ok: true, contentHash: 'abc' }] }, read, 'EI-1')).toBe(false);
  });
  it('fails slow, non-finite, unverified, or post-stall writes', () => {
    expect(judgeContinuation(good).every(row => row.passed)).toBe(true);
    for (const bad of [{ wallMs: 20_001 }, { wallMs: NaN }, { wallMs: -1 },
      { successfulReadback: false }, { heldAtReadback: false }]) {
      expect(judgeContinuation({ ...good, ...bad })[0]!.passed).toBe(false);
    }
  });
  it('preserves a committed verifier failure without copying checkpoint content', () => {
    const receipt = { ok: false, results: [{ id: 'WI-1', ok: false,
      errorCode: 'checkpoint_verify_failed', writeCommitted: true,
      storedContentHash: 'old-hash', error: 'private checkpoint narrative' }] };
    const readback = { results: [{ id: 'WI-1', checkpointContentHash: 'new-hash',
      checkpoint: 'private checkpoint narrative' }] };
    const proof = checkpointProof(receipt, readback, 'WI-1');
    expect(proof).toEqual({ id: 'WI-1', responseOk: false, itemOk: false,
      verified: false, errorCode: 'checkpoint_verify_failed', writeCommitted: true,
      contentHash: 'old-hash', readBackContentHash: 'new-hash' });
    expect(JSON.stringify(proof)).not.toContain('private checkpoint narrative');
  });
  it('requires an actual claim timestamp change and matching authoritative identity and owner', () => {
    const before = '2026-10-16T00:00:00.000Z';
    const item = { id: 'WI-1', assignee: 'su-self', takenAt: '2026-10-16T00:00:01.000Z' };
    const receipt = { ok: true, results: [{ id: 'WI-1', ok: true, workItem: item }] };
    const row = { id: 'WI-1', ok: true, availability: 'available', workItem: item };
    const proof = (r: unknown, s: unknown, prior = before) => claimProof(r, s, 'WI-1', 'su-self', prior);
    expect(proof(receipt, { results: [row] }).verified).toBe(true);
    for (const bad of [{ ...row, ok: false }, { ...row, availability: 'unavailable' },
      { ...row, workItem: { ...item, id: 'WI-2' } }, { ...row, workItem: { ...item, assignee: 'su-other' } },
      { ...row, workItem: { ...item, takenAt: before } }]) {
      expect(proof(receipt, { results: [bad] }).verified).toBe(false);
    }
    expect(proof(receipt, { results: [row] }, item.takenAt).verified).toBe(false);
    expect(proof(receipt, { results: [row] }, 'invalid').verified).toBe(false);
    expect(proof({ ...receipt, ok: false }, { results: [row] }).verified).toBe(false);
    expect(proof({ ok: true, results: [{ ...receipt.results[0], workItem: { ...item, id: 'WI-2' } }] },
      { results: [row] }).verified).toBe(false);
  });
  it('fails slow or unverified claims even when the checkpoint succeeds', () => {
    for (const bad of [{ claimWallMs: 20_001 }, { claimWallMs: NaN }, { claimWallMs: -1 },
      { claimSuccessfulReadback: false }, { claimHeldAtReadback: false }]) {
      expect(judgeContinuation({ ...good, ...bad }).find(row => row.id === 'unrelated-claim-within-20s')!.passed).toBe(false);
    }
  });
  it('cannot treat cancellation, missing ordering or lost acknowledgement as successful forwarding', () => {
    for (const key of ['ordered', 'cancelledAbsent', 'rejectedNotForwarded', 'unknownReceipt', 'unknownPersisted', 'sourceStable'] as const) {
      expect(judgeContinuation({ ...good, [key]: false }).every(row => row.passed)).toBe(false);
    }
  });
});
