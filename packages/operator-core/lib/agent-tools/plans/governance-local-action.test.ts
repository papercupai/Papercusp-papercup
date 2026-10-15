import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { authenticateGovernanceEvent, type GovernanceSigningAuthority } from './governance-authentication';
import { DEFAULT_PLAN_ADMISSION_POLICY } from './plan-admission-policy';
import { createLocalGovernanceEvent, localGovernanceActor, type LocalGovernanceAction } from './governance-local-action';
import type { PlanAdmissionGovernanceSnapshot } from './plan-admission-governance-store';
import type { FederatedGovernanceEvent } from './governance-federation';

function fixture() {
  const key = generateEd25519KeypairDer();
  const authority: GovernanceSigningAuthority = { potId: 'private-dao', policy: DEFAULT_PLAN_ADMISSION_POLICY,
    members: [{ memberId: 'member', publicKey: key.pubkeyBase64, originPeerIds: [key.pubkeyBase64], keyEpoch: 3,
      roles: ['round-open', 'vote', 'finalize'], weight: 1 }] };
  const signer = { publicKey: key.pubkeyBase64, originPeerId: key.pubkeyBase64,
    sign: async (bytes: Buffer) => signWithPrivateKeyDer(key.privateKeyDer, bytes) };
  const snapshot = { potId: authority.potId, events: [] as FederatedGovernanceEvent[], integrityErrors: [] as string[], conflictedRoundIds: new Set<string>() } satisfies PlanAdmissionGovernanceSnapshot;
  const base = { authority, signer, snapshot, planRevisionHash: 'reviewed-revision', expectedRevisionHash: 'reviewed-revision', nowMs: 1000 };
  const act = (action: LocalGovernanceAction) => createLocalGovernanceEvent({ ...base, action });
  return { authority, signer, snapshot, base, act };
}

describe('policy-bound desktop governance', () => {
  it('opens, signs a ballot and finalizes through the existing verifiers and weighted reducer', async () => {
    const f = fixture();
    const opened = await f.act({ kind: 'open' });
    expect(opened.body.kind).toBe('round-open');
    if (opened.body.kind !== 'round-open') throw new Error('Missing round');
    f.snapshot.events.push(opened);
    const ballot = await f.act({ kind: 'vote', roundId: opened.roundId, choice: 'approve' });
    expect(authenticateGovernanceEvent({ authority: f.authority, event: ballot, round: opened.body.round, nowMs: 1000 })).toEqual({ ok: true });
    f.snapshot.events.push(ballot);
    const final = await f.act({ kind: 'finalize', roundId: opened.roundId });
    expect(final.body).toMatchObject({ kind: 'finalize', certificate: { admitted: true, tally: { approveWeight: 1 } } });
    f.snapshot.events.push(final);
    await expect(f.act({ kind: 'vote', roundId: opened.roundId, choice: 'reject' })).rejects.toThrow('no longer open');
  });
  it('advances replacement sequence and re-signs both domains', async () => {
    const f = fixture(), opened = await f.act({ kind: 'open' });
    f.snapshot.events.push(opened);
    f.snapshot.events.push(await f.act({ kind: 'vote', roundId: opened.roundId, choice: 'approve' }));
    const replacement = await f.act({ kind: 'vote', roundId: opened.roundId, choice: 'reject' });
    expect(replacement.body).toMatchObject({ kind: 'vote', vote: { choice: 'reject', sequence: 1, keyEpoch: 3 } });
    f.snapshot.events.push(replacement);
    const final = await f.act({ kind: 'finalize', roundId: opened.roundId });
    expect(final.body).toMatchObject({ kind: 'finalize', certificate: { admitted: false, tally: { rejectWeight: 1, replacements: 1 } } });
  });
  it('rejects stale review, foreign organization, and conflicted evidence before signing', async () => {
    const f = fixture();
    for (const changed of [
      { expectedRevisionHash: 'old-revision' },
      { snapshot: { ...f.snapshot, potId: 'another-dao' } },
      { snapshot: { ...f.snapshot, integrityErrors: ['bad signature'] } },
      { snapshot: { ...f.snapshot, conflictedRoundIds: new Set(['conflict']) } },
    ]) await expect(createLocalGovernanceEvent({ ...f.base, ...changed, action: { kind: 'open' } })).rejects.toThrow();
  });
  it('refuses missing, revoked, expired, wrong-origin and role-ineligible signers', async () => {
    const f = fixture();
    expect(localGovernanceActor(f.authority, null, 1000)).toBeNull();
    expect(localGovernanceActor(f.authority, { ...f.signer, originPeerId: 'foreign' }, 1000)).toBeNull();
    for (const changed of [{ revoked: true }, { expiresAtMs: 1000 }, { roles: ['vote'] as const }]) {
      const authority = { ...f.authority, members: [{ ...f.authority.members[0], ...changed }] };
      await expect(createLocalGovernanceEvent({ ...f.base, authority, action: { kind: 'open' } })).rejects.toThrow();
    }
  });
  it('refuses duplicate live rounds and votes after expiry', async () => {
    const f = fixture(), opened = await f.act({ kind: 'open' });
    f.snapshot.events.push(opened);
    await expect(f.act({ kind: 'open' })).rejects.toThrow('already has an active');
    await expect(createLocalGovernanceEvent({ ...f.base, nowMs: 1000 + f.authority.policy.ratificationWindowSec * 1000,
      action: { kind: 'vote', roundId: opened.roundId, choice: 'approve' } })).rejects.toThrow('expired');
  });
});
