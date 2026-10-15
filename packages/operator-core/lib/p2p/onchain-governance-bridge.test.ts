import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/authority-rpc-envelope';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { governanceAuthorityHash, governanceEventSigningBytes, governanceVoteSigningBytes,
  type GovernanceSigningAuthority } from '../agent-tools/plans/governance-authentication';
import { createPlanAdmissionCertificateSource } from '../agent-tools/plans/plan-admission-certificate-source';
import type { FederatedGovernanceEvent, GovernanceEventBody } from '../agent-tools/plans/governance-federation';
import {
  appendGovernanceVote,
  createGovernanceRound,
  finalizeGovernanceRound,
  verifyFinalizationCertificate,
  type FinalizationCertificate,
  type GovernanceVoteEvent,
} from '../agent-tools/plans/governance-round';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../agent-tools/plans/plan-admission-policy';
import { createPaymentChannel } from './payment-channel';
import type { SafeTreasuryConfig } from './treasury-controls';
import type { EvmSettlementConfig } from './evm-settlement';
import {
  createInMemoryMirrorLedger,
  createOnChainGovernanceSource,
  executeOnChainMirror,
  governanceActionHash,
  isMirrorableActionKind,
  planOnChainMirror,
  P2P_ONLY_DECISION_KINDS,
  type BridgeAction,
  type MirrorPlan,
  type OnChainSubmitter,
} from './onchain-governance-bridge';

const token = '0x1111111111111111111111111111111111111111';
const recipient = '0x2222222222222222222222222222222222222222';
const CREATED_AT_MS = 1_000;
const NOW_MS = 2_000;
const records = new Map<string, { authority: GovernanceSigningAuthority; events: FederatedGovernanceEvent[];
  sign: (event: Omit<FederatedGovernanceEvent, 'signature'>) => FederatedGovernanceEvent }>();

function decision(cert: FinalizationCertificate) {
  return { certificate: cert, governance: { roundId: cert.roundId, status: 'finalized' as const,
    quarantineReason: null, revokedReason: null } };
}

function governance(cert: FinalizationCertificate, nowMs = NOW_MS) {
  const stored = records.get(cert.certificateHash);
  if (!stored) throw new Error('signed source fixture missing');
  return createOnChainGovernanceSource({ slug: 'plan', door: 'start', policy: stored.authority.policy,
    opts: { workspaceId: 'workspace', harnessSlug: 'harness' }, nowMs: () => nowMs },
    createPlanAdmissionCertificateSource({ resolvePotHomeSlug: async () => 'pot',
      resolveAuthority: async () => stored.authority,
      readSnapshot: async () => ({ potId: 'pot', events: stored.events,
        conflictedRoundIds: new Set(), integrityErrors: [] }) }));
}

const treasury: SafeTreasuryConfig = {
  chainId: 42161,
  safeAddress: '0x3333333333333333333333333333333333333333',
  owners: ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555'],
  threshold: 2,
  automationSigner: '0x7777777777777777777777777777777777777777',
  roles: {
    settlement: { enabled: true, maxAmountMicros: 1_000n, allowedRecipients: [recipient], allowedTokens: [token] },
    'host-payout': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
    'reserve-transfer': { enabled: false, maxAmountMicros: 100n, allowedRecipients: [recipient], allowedTokens: [token] },
    'emergency-pause': { enabled: true, maxAmountMicros: 0n, allowedRecipients: [recipient], allowedTokens: [token] },
  },
};

const evm: EvmSettlementConfig = {
  chainId: 8453,
  settlementContract: '0x7777777777777777777777777777777777777777',
  stablecoin: '0x8888888888888888888888888888888888888888',
  maxBatchSize: 10,
};

function certificate(choices: readonly GovernanceVoteEvent['choice'][], action: BridgeAction | null = transfer): FinalizationCertificate {
  const memberIds = choices.map((_, i) => `member-${i}`);
  const keys = choices.map(() => generateEd25519KeypairDer());
  const authority: GovernanceSigningAuthority = { potId: 'pot', policy: DEFAULT_PLAN_ADMISSION_POLICY,
    members: memberIds.map((memberId, i) => ({ memberId, publicKey: keys[i]!.pubkeyBase64,
      keyEpoch: 1, roles: ['round-open', 'vote', 'finalize', 'pause', 'resume', 'revoke'], originPeerIds: ['peer'] })) };
  const round = createGovernanceRound({
    roundId: 'round-1',
    planRevisionHash: 'plan-rev-hash',
    policyVersion: DEFAULT_PLAN_ADMISSION_POLICY.policyVersion,
    eligibleMemberIds: memberIds,
    createdAtMs: CREATED_AT_MS,
    authorityHash: governanceAuthorityHash(authority),
    ...(action ? { approvedActionHash: governanceActionHash(action) } : {}),
  });
  if (!round.ok) throw new Error(round.detail);
  const envelopes: FederatedGovernanceEvent[] = [];
  const envelope = (body: GovernanceEventBody, eventId: string, memberIndex: number, occurredAtMs: number) => {
    const unsigned = { eventId, roundId: 'round-1', potId: 'pot', originPeerId: 'peer', occurredAtMs, body,
      authorization: { memberId: memberIds[memberIndex]!, keyEpoch: 1 } };
    return { ...unsigned, signature: signWithPrivateKeyDer(keys[memberIndex]!.privateKeyDer,
      governanceEventSigningBytes(unsigned)).toString('base64') };
  };
  envelopes.push(envelope({ kind: 'round-open', round: round.value }, 'open', 0, CREATED_AT_MS));
  let events: GovernanceVoteEvent[] = [];
  choices.forEach((choice, i) => {
    const unsigned = {
      eventId: `event-${i}`,
      roundId: 'round-1',
      memberId: memberIds[i]!,
      choice,
      sequence: i,
      keyEpoch: 1,
    };
    const vote = { ...unsigned, signature: signWithPrivateKeyDer(keys[i]!.privateKeyDer,
      governanceVoteSigningBytes(authority, round.value, unsigned)).toString('base64') };
    const appended = appendGovernanceVote(round.value, events, vote);
    if (!appended.ok) throw new Error(appended.detail);
    events = appended.value;
    envelopes.push(envelope({ kind: 'vote', vote }, `vote-envelope-${i}`, i, CREATED_AT_MS + i + 1));
  });
  const finalized = finalizeGovernanceRound({ round: round.value, events, members: authority.members,
    policy: DEFAULT_PLAN_ADMISSION_POLICY, nowMs: NOW_MS });
  if (!finalized.ok) throw new Error(finalized.detail);
  envelopes.push(envelope({ kind: 'finalize', certificate: finalized.value }, 'finalize', 0, NOW_MS));
  records.set(finalized.value.certificateHash, { authority, events: envelopes,
    sign: event => ({ ...event, signature: signWithPrivateKeyDer(keys[0]!.privateKeyDer,
      governanceEventSigningBytes(event)).toString('base64') }) });
  return finalized.value;
}

const admitted = (action: BridgeAction = transfer) => certificate(['approve', 'approve', 'approve'], action);
const rejected = () => certificate(['approve', 'reject', 'reject']);

const transfer: BridgeAction = {
  kind: 'treasury-transfer',
  treasury,
  request: { role: 'settlement', token, recipient, amountMicros: 750n, settlementReceiptHash: 'receipt-hash', policyApproved: true },
};

const settlementBatch: BridgeAction = {
  kind: 'settlement-batch',
  evm,
  channel: createPaymentChannel('channel-1', 'evm-x402', 10_000n),
  amountMicros: 900n,
  voucherDigests: ['digest-a', 'digest-b'],
};

function mirror(action: BridgeAction, cert: FinalizationCertificate = admitted(action)) {
  return planOnChainMirror({ certificate: cert, authorizedByCertificateHash: cert.certificateHash, action }, decision(cert));
}

function recordingSubmitter(txHash = '0xtx'): OnChainSubmitter & { calls: MirrorPlan[] } {
  const calls: MirrorPlan[] = [];
  return {
    calls,
    submit: async (plan) => {
      calls.push(plan);
      return { ok: true, txHash };
    },
  };
}

describe('finalization certificate verification', () => {
  it('accepts an untouched certificate and rejects one edited after finalization', () => {
    const cert = rejected();
    expect(verifyFinalizationCertificate(cert)).toBe(true);
    expect(verifyFinalizationCertificate({ ...cert, admitted: true })).toBe(false);
    expect(verifyFinalizationCertificate({ ...cert, reason: 'approved' })).toBe(false);
    expect(verifyFinalizationCertificate({ ...cert, certificateHash: '' })).toBe(false);
  });
});

describe('on-chain governance bridge — what may reach a chain', () => {
  it('mirrors a ratified treasury transfer through the bounded Safe adapter', () => {
    const result = mirror(transfer);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ kind: 'treasury-transfer', roundId: 'round-1', chainId: treasury.chainId, settlement: null });
    expect(result.plan.safeTxHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan.mirrorId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('mirrors a ratified settlement batch through the EVM adapter', () => {
    const result = mirror(settlementBatch);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.plan).toMatchObject({ kind: 'settlement-batch', chainId: evm.chainId, safeTxHash: null });
    expect(result.plan.settlement?.calldata.startsWith('0x')).toBe(true);
  });

  it('refuses a decision the pot did not admit', () => {
    const cert = rejected();
    expect(cert.admitted).toBe(false);
    expect(mirror(transfer, cert)).toMatchObject({ ok: false, code: 'certificate-not-admitted' });
  });

  it('refuses a certificate whose contents were edited after finalization', () => {
    const forged = { ...rejected(), admitted: true };
    const result = planOnChainMirror({ certificate: forged, authorizedByCertificateHash: forged.certificateHash, action: transfer });
    expect(result).toMatchObject({ ok: false, code: 'certificate-tampered' });
  });

  it('refuses an action authorized under a different round', () => {
    const cert = admitted();
    const result = planOnChainMirror({ certificate: cert, authorizedByCertificateHash: 'some-other-round-hash', action: transfer }, decision(cert));
    expect(result).toMatchObject({ ok: false, code: 'action-not-bound-to-certificate' });
  });

  it('refuses legacy certificates without an action commitment', () => {
    const cert = certificate(['approve', 'approve', 'approve'], null);
    expect(verifyFinalizationCertificate(cert)).toBe(true);
    expect(mirror(transfer, cert)).toMatchObject({ ok: false, code: 'action-not-bound-to-certificate' });
  });

  it('refuses substitutions under the same admitted certificate even within role limits', () => {
    if (transfer.kind !== 'treasury-transfer') throw new Error('treasury fixture required');
    const cert = admitted(transfer);
    expect(cert.approvedActionHash).toBe(governanceActionHash(transfer));
    const changes: BridgeAction[] = [
      { ...transfer, request: { ...transfer.request, amountMicros: 749n } },
      { ...transfer, request: { ...transfer.request, recipient: treasury.safeAddress } },
      { ...transfer, request: { ...transfer.request, token: evm.stablecoin } },
      { ...transfer, request: { ...transfer.request, role: 'emergency-pause' } },
      { ...transfer, request: { ...transfer.request, settlementReceiptHash: 'other-receipt' } },
      { ...transfer, treasury: { ...treasury, chainId: 8453 } },
      { ...transfer, treasury: { ...treasury, safeAddress: recipient } },
      settlementBatch,
    ];
    for (const changed of changes) expect(mirror(changed, cert)).toMatchObject({ ok: false, code: 'action-not-bound-to-certificate' });
    expect(verifyFinalizationCertificate({ ...cert, approvedActionHash: governanceActionHash(changes[0]!) })).toBe(false);
    expect(mirror(transfer, cert)).toMatchObject({ ok: true });
  });

  it('binds settlement amount, channel, chain, contract, stablecoin and exact vouchers', () => {
    if (settlementBatch.kind !== 'settlement-batch') throw new Error('settlement fixture required');
    const cert = admitted(settlementBatch);
    const changes: BridgeAction[] = [
      { ...settlementBatch, amountMicros: 901n },
      { ...settlementBatch, channel: { ...settlementBatch.channel, channelId: 'other-channel' } },
      { ...settlementBatch, evm: { ...evm, chainId: 42161 } },
      { ...settlementBatch, evm: { ...evm, settlementContract: token } },
      { ...settlementBatch, evm: { ...evm, stablecoin: token } },
      { ...settlementBatch, voucherDigests: ['digest-c'] },
    ];
    for (const changed of changes) expect(mirror(changed, cert)).toMatchObject({ ok: false, code: 'action-not-bound-to-certificate' });
    expect(mirror(settlementBatch, cert)).toMatchObject({ ok: true });
  });

  it('never mirrors a P2P-authoritative decision kind, even when ratified', () => {
    for (const kind of P2P_ONLY_DECISION_KINDS) {
      expect(isMirrorableActionKind(kind)).toBe(false);
      expect(mirror({ kind })).toMatchObject({ ok: false, code: 'decision-not-mirrorable' });
    }
  });

  it('does not let ratification bypass the bounded treasury role caps', () => {
    const overCap: BridgeAction = { kind: 'treasury-transfer', treasury, request: { role: 'settlement', token, recipient, amountMicros: 5_000n, settlementReceiptHash: 'r', policyApproved: true } };
    expect(mirror(overCap)).toMatchObject({ ok: false, code: 'treasury-refused' });
    const disabledRole: BridgeAction = { kind: 'treasury-transfer', treasury, request: { role: 'host-payout', token, recipient, amountMicros: 10n, settlementReceiptHash: 'r', policyApproved: true } };
    expect(mirror(disabledRole)).toMatchObject({ ok: false, code: 'treasury-refused' });
  });

  it('refuses a settlement batch the EVM adapter rejects', () => {
    const wrongRail: BridgeAction = { kind: 'settlement-batch', evm, channel: createPaymentChannel('channel-2', 'lightning', 10_000n), amountMicros: 10n, voucherDigests: ['d'] };
    expect(mirror(wrongRail)).toMatchObject({ ok: false, code: 'settlement-refused' });
  });
});

describe('on-chain governance bridge — execution is at-most-once and one-way', () => {
  it('serializes concurrent submissions of the same authenticated mirror', async () => {
    const cert = admitted();
    const submitter = recordingSubmitter();
    const ledger = createInMemoryMirrorLedger();
    const request = { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer };
    const outcomes = await Promise.all(Array.from({ length: 3 }, () =>
      executeOnChainMirror({ request, submitter, ledger, governance: governance(cert) })));
    expect(outcomes.every(result => result.ok)).toBe(true);
    expect(submitter.calls).toHaveLength(1);
    expect(outcomes.filter(result => result.ok && !result.replayed)).toHaveLength(1);
  });

  it('submits once and replays the recorded mirror instead of double-executing', async () => {
    const submitter = recordingSubmitter('0xdeadbeef');
    const ledger = createInMemoryMirrorLedger();
    const cert = admitted();
    const request = { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer };

    const first = await executeOnChainMirror({ request, submitter, ledger, governance: governance(cert) });
    expect(first).toMatchObject({ ok: true, txHash: '0xdeadbeef', replayed: false, decisionStanding: true });

    const second = await executeOnChainMirror({ request, submitter, ledger, governance: governance(cert) });
    expect(second).toMatchObject({ ok: true, replayed: true, decisionStanding: true });
    expect(submitter.calls).toHaveLength(1);
    expect(ledger.entries().size).toBe(1);
  });

  it('produces the same mirrorId for the same certificate and action, and a different one per round', () => {
    const a = mirror(transfer);
    const b = mirror(transfer);
    const otherRound = certificate(['approve', 'approve', 'approve', 'approve']);
    const c = planOnChainMirror({ certificate: otherRound, authorizedByCertificateHash: otherRound.certificateHash, action: transfer }, decision(otherRound));
    // Every leg must have produced a plan, or the comparisons below prove nothing.
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected all three mirrors to plan successfully');

    expect(a.plan.mirrorId).toBe(b.plan.mirrorId);
    expect(a.plan.certificateHash).not.toBe(c.plan.certificateHash);
    expect(a.plan.mirrorId).not.toBe(c.plan.mirrorId);
  });

  it('keeps the ratified decision standing when the chain submission fails, and retries cleanly', async () => {
    const failing: OnChainSubmitter = { submit: vi.fn(async () => ({ ok: false as const, detail: 'rpc timeout' })) };
    const ledger = createInMemoryMirrorLedger();
    const cert = admitted();
    const request = { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer };

    const failed = await executeOnChainMirror({ request, submitter: failing, ledger, governance: governance(cert) });
    expect(failed).toMatchObject({ ok: false, code: 'submission-failed', decisionStanding: true });
    expect(ledger.entries().size).toBe(0);

    const retry = await executeOnChainMirror({ request, submitter: recordingSubmitter('0xretry'), ledger, governance: governance(cert) });
    expect(retry).toMatchObject({ ok: true, txHash: '0xretry', replayed: false });
  });

  it('reports decisionStanding false only when it refused before reaching the chain', async () => {
    const submitter = recordingSubmitter();
    const cert = rejected();
    const refused = await executeOnChainMirror({
      request: { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer },
      submitter,
      ledger: createInMemoryMirrorLedger(),
      governance: governance(cert),
    });
    expect(refused).toMatchObject({ ok: false, code: 'certificate-not-admitted', decisionStanding: false });
    expect(submitter.calls).toHaveLength(0);
  });

  it('refuses omitted or forged authority and self-rehashed certificates before submission', async () => {
    const cert = admitted();
    const submitter = recordingSubmitter();
    const ledger = createInMemoryMirrorLedger();
    const request = { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer };
    expect(planOnChainMirror(request)).toMatchObject({ ok: false, code: 'unverified-governance' });
    expect(await executeOnChainMirror({ request, submitter, ledger })).toMatchObject({ ok: false, code: 'unverified-governance' });
    const { certificateHash: _hash, ...base } = cert;
    void _hash;
    const changed = { ...base, tally: { ...base.tally, approveWeight: base.tally.approveWeight + 1 } };
    const forged = { ...changed, certificateHash: createHash('sha256').update(canonicalJson(changed)).digest('hex') };
    expect(verifyFinalizationCertificate(forged)).toBe(true);
    expect(await executeOnChainMirror({ request: { ...request, certificate: forged, authorizedByCertificateHash: forged.certificateHash },
      submitter, ledger, governance: governance(cert) })).toMatchObject({ ok: false, code: 'unverified-governance' });
    const stored = records.get(cert.certificateHash)!;
    stored.events[1] = { ...stored.events[1]!, signature: 'forged' };
    expect(await executeOnChainMirror({ request, submitter, ledger, governance: governance(cert) }))
      .toMatchObject({ ok: false, code: 'unverified-governance' });
    expect(submitter.calls).toHaveLength(0);
  });

  it('rechecks signed pause, revocation, conflict and expiry controls at execution', async () => {
    for (const kind of ['pause', 'revoke', 'conflict', 'expired'] as const) {
      const cert = admitted();
      const stored = records.get(cert.certificateHash)!;
      if (kind !== 'expired') {
        const original = stored.events[0]!;
        const { signature: _sig, ...unsigned } = original;
        void _sig;
        if (original.body.kind !== 'round-open') throw new Error('round required');
        const body: GovernanceEventBody = kind === 'conflict' ? { kind: 'round-open', round: { ...original.body.round, approvedActionHash: '0'.repeat(64) } }
          : kind === 'pause' ? { kind: 'pause' } : { kind: 'revoke', reason: 'halt' };
        const control = { ...unsigned, eventId: kind === 'conflict' ? original.eventId : kind, body, occurredAtMs: NOW_MS };
        stored.events.push(stored.sign(control));
      }
      const submitter = recordingSubmitter();
      expect(await executeOnChainMirror({ request: { certificate: cert, authorizedByCertificateHash: cert.certificateHash, action: transfer },
        submitter, ledger: createInMemoryMirrorLedger(), governance: governance(cert,
          kind === 'expired' ? NOW_MS + DEFAULT_PLAN_ADMISSION_POLICY.ratificationWindowSec * 1_000 + 1 : NOW_MS) }))
        .toMatchObject({ ok: false, code: 'unverified-governance' });
      expect(submitter.calls).toHaveLength(0);
    }
  });
});
