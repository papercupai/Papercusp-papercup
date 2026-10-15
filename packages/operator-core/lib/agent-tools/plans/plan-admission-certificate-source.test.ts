import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../authority/authority-rpc-envelope';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { canonicalizeHivePolicy, hivePolicySignedBytes } from '../../hive-policy-schema';
import type { ResolvedHivePolicy } from '../../hive-policy-store';
import { governanceAuthorityHash, governanceEventSigningBytes, governanceVoteSigningBytes,
  type GovernanceSigningAuthority } from './governance-authentication';
import type { HiveSettingRecord } from '../../hive-settings-store';
import {
  appendGovernanceVote,
  createGovernanceRound,
  finalizeGovernanceRound,
  type FinalizationCertificate,
  type GovernanceRound,
  type GovernanceVoteEvent,
} from './governance-round';
import type {
  FederatedGovernanceEvent,
  GovernanceEventBody,
} from './governance-federation';
import {
  bridgeFinalizationToAdmissionCertificate,
  createPlanAdmissionCertificateSource,
} from './plan-admission-certificate-source';
import {
  appendPlanAdmissionGovernanceEvent,
  planAdmissionGovernanceEventSettingKey,
  readPlanAdmissionGovernanceSnapshot,
  resolvePlanAdmissionGovernanceAuthority,
  type PlanAdmissionGovernanceSnapshot,
  type PlanAdmissionGovernanceStoreDeps,
} from './plan-admission-governance-store';
import {
  checkPlanAdmission,
  configurePlanAdmissionCertificateSource,
  configurePlanAdmissionPolicySource,
  configurePlanAdmissionShadowSink,
  PLAN_ADMISSION_ENFORCEMENT_ENV,
  planAdmissionEnforcementEnabled,
  type PlanAdmissionShadowObservation,
} from './plan-admission-gate';
import { PLAN_ADMISSION_DOORS } from './plan-admission-enforcement';
import { memoryLedgerChainLinkStore } from '../../cupboard/ledger-chain';
import type { PlanAdmissionPolicy } from './plan-admission-policy';
import type { PlanRow } from './source';

const WORKSPACE_ID = 'workspace-1';
const HARNESS_SLUG = 'harness-1';
const POT_HOME_SLUG = 'pot-home-1';
const POT_ID = 'pot-owner-authored-id';
const PLAN_REVISION = 'sha256:plan-revision-1';
const NOW = 1_700_000_000_000;
const MEMBERS = ['member-a', 'member-b', 'member-c'] as const;

const POLICY: PlanAdmissionPolicy = Object.freeze({
  policyVersion: 7,
  quorumBps: 5_000,
  approvalBps: 6_667,
  ratificationWindowSec: 3_600,
  materiality: Object.freeze({ maxChangedLines: 200, maxChangedItems: 3 }),
});

const rowWith = (contentHash: string) => ({ contentHash }) as unknown as PlanRow;
const KEYS = MEMBERS.map(() => generateEd25519KeypairDer());
const AUTHORITY: GovernanceSigningAuthority = { potId: POT_ID, policy: POLICY,
  members: MEMBERS.map((memberId, i) => ({ memberId, publicKey: KEYS[i]!.pubkeyBase64,
    keyEpoch: 1, originPeerIds: ['peer-1'], roles: ['round-open', 'vote', 'finalize', 'pause', 'resume', 'revoke'] })) };

function signEvent(event: Omit<FederatedGovernanceEvent, 'signature'>): FederatedGovernanceEvent {
  const member = event.authorization?.memberId ?? MEMBERS[0];
  return { ...event, signature: signWithPrivateKeyDer(KEYS[MEMBERS.indexOf(member as typeof MEMBERS[number])]!.privateKeyDer,
    governanceEventSigningBytes(event)).toString('base64') };
}

function federated(
  eventId: string,
  roundId: string,
  body: GovernanceEventBody,
  occurredAtMs: number,
  over: Partial<FederatedGovernanceEvent> = {},
): FederatedGovernanceEvent {
  return signEvent({
    eventId,
    potId: POT_ID,
    roundId,
    originPeerId: 'peer-1',
    occurredAtMs,
    body,
    authorization: { memberId: body.kind === 'vote' ? body.vote.memberId : MEMBERS[0], keyEpoch: 1 },
    ...over,
  });
}

function ratifiedRound(input: {
  roundId?: string;
  planRevisionHash?: string;
  policyVersion?: number;
  createdAtMs?: number;
  finalizedAtMs?: number;
  authority?: GovernanceSigningAuthority;
} = {}): {
  round: GovernanceRound;
  votes: readonly GovernanceVoteEvent[];
  certificate: FinalizationCertificate;
  events: readonly FederatedGovernanceEvent[];
} {
  const roundId = input.roundId ?? 'round-1';
  const createdAtMs = input.createdAtMs ?? NOW - 10_000;
  const finalizedAtMs = input.finalizedAtMs ?? NOW;
  const authority = input.authority ?? AUTHORITY;
  const created = createGovernanceRound({
    roundId,
    planRevisionHash: input.planRevisionHash ?? PLAN_REVISION,
    policyVersion: input.policyVersion ?? authority.policy.policyVersion,
    eligibleMemberIds: [...MEMBERS],
    createdAtMs,
    authorityHash: governanceAuthorityHash(authority),
  });
  if (!created.ok) throw new Error(`fixture round refused: ${created.code} ${created.detail}`);

  let votes: GovernanceVoteEvent[] = [];
  MEMBERS.forEach((memberId, index) => {
    const ballot = {
      eventId: `${roundId}-vote-${index + 1}`,
      roundId,
      memberId,
      choice: 'approve' as const,
      sequence: index + 1,
      keyEpoch: authority.members.find(m => m.memberId === memberId)!.keyEpoch,
    };
    const appended = appendGovernanceVote(created.value, votes, { ...ballot,
      signature: signWithPrivateKeyDer(KEYS[index]!.privateKeyDer,
        governanceVoteSigningBytes(authority, created.value, ballot)).toString('base64') });
    if (!appended.ok) throw new Error(`fixture vote refused: ${appended.code} ${appended.detail}`);
    votes = appended.value;
  });

  const finalized = finalizeGovernanceRound({
    round: created.value,
    events: votes,
    policy: authority.policy,
    members: authority.members,
    nowMs: finalizedAtMs,
  });
  if (!finalized.ok) {
    throw new Error(`fixture finalization refused: ${finalized.code} ${finalized.detail}`);
  }

  return {
    round: created.value,
    votes,
    certificate: finalized.value,
    events: [
      federated(`${roundId}-open`, roundId, { kind: 'round-open', round: created.value }, createdAtMs,
        { authorization: { memberId: MEMBERS[0], keyEpoch: authority.members[0]!.keyEpoch } }),
      ...votes.map((vote, index) =>
        federated(
          `${roundId}-vote-event-${index + 1}`,
          roundId,
          { kind: 'vote', vote },
          createdAtMs + index + 1,
          { authorization: { memberId: vote.memberId, keyEpoch: vote.keyEpoch! } },
        ),
      ),
      federated(
        `${roundId}-finalize`,
        roundId,
        { kind: 'finalize', certificate: finalized.value },
        finalizedAtMs,
        { authorization: { memberId: MEMBERS[0], keyEpoch: authority.members[0]!.keyEpoch } },
      ),
    ],
  };
}

function settingFor(
  event: FederatedGovernanceEvent,
  over: Partial<HiveSettingRecord> = {},
): HiveSettingRecord {
  return {
    workspaceId: WORKSPACE_ID,
    potHomeSlug: POT_ID,
    settingKey: planAdmissionGovernanceEventSettingKey(event),
    value: event,
    createdAt: event.occurredAtMs,
    updatedAt: event.occurredAtMs,
    ...over,
  };
}

async function snapshotFrom(
  events: readonly FederatedGovernanceEvent[],
  extraRows: readonly HiveSettingRecord[] = [],
): Promise<PlanAdmissionGovernanceSnapshot> {
  return readPlanAdmissionGovernanceSnapshot(
    { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG },
    undefined,
    {
      resolvePotScope: async () => POT_ID,
      listSettings: async () => [...events.map((event) => settingFor(event)), ...extraRows],
      resolveAuthority: async () => AUTHORITY,
      nowMs: () => NOW + 1,
    },
  );
}

function sourceFor(snapshot: PlanAdmissionGovernanceSnapshot) {
  return createPlanAdmissionCertificateSource({
    resolvePotHomeSlug: async (workspaceId, harnessSlug) => {
      expect(workspaceId).toBe(WORKSPACE_ID);
      expect(harnessSlug).toBe(HARNESS_SLUG);
      return POT_HOME_SLUG;
    },
    readSnapshot: async (input) => {
      expect(input).toMatchObject({ workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG });
      return snapshot;
    },
    resolveAuthority: async () => AUTHORITY,
  });
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  configurePlanAdmissionPolicySource(null);
  configurePlanAdmissionCertificateSource(null);
  configurePlanAdmissionShadowSink(null);
});

describe('plan-admission governance event store', () => {
  it('appends content-addressed immutable events, replays idempotently, and rejects event-id mutation', async () => {
    const rows: HiveSettingRecord[] = [];
    let writes = 0;
    const ledgerChain = memoryLedgerChainLinkStore();
    const deps: PlanAdmissionGovernanceStoreDeps = {
      resolveAuthority: async () => AUTHORITY,
      nowMs: () => NOW + 1,
      ledgerChain,
      resolvePotScope: async () => POT_ID,
      listSettings: async () => [...rows],
      setSetting: async (input) => {
        writes += 1;
        const record: HiveSettingRecord = {
          workspaceId: input.workspaceId,
          potHomeSlug: POT_ID,
          settingKey: input.settingKey,
          value: input.value,
          createdAt: NOW,
          updatedAt: NOW,
        };
        const index = rows.findIndex((row) => row.settingKey === record.settingKey);
        if (index < 0) rows.push(record);
        else rows[index] = record;
        return record;
      },
    };
    const { events } = ratifiedRound();
    const event = events[0];

    const first = await appendPlanAdmissionGovernanceEvent(
      { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG, event },
      undefined,
      deps,
    );
    const replay = await appendPlanAdmissionGovernanceEvent(
      { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG, event },
      undefined,
      deps,
    );

    expect(first.settingKey).toBe(planAdmissionGovernanceEventSettingKey(event));
    expect(replay).toEqual(first);
    expect(rows).toHaveLength(1);
    expect(writes).toBe(1);
    // P-040: the append is witnessed into the pot's hash chain exactly once.
    expect(ledgerChain.rows.map((row) => [row.link.streamId, row.link.seq, row.sourceId])).toEqual([
      [`governance.plan-admission:${POT_ID}`, 0, first.settingKey],
    ]);

    const mutated = { ...event, occurredAtMs: event.occurredAtMs + 1 };
    await expect(
      appendPlanAdmissionGovernanceEvent(
        { workspaceId: WORKSPACE_ID, potHomeSlug: POT_HOME_SLUG, event: mutated },
        undefined,
        deps,
      ),
    ).rejects.toThrow(`immutable conflict for event '${event.eventId}'`);
    expect(rows).toHaveLength(1);
    expect(writes).toBe(1);
  });

  it('marks divergent event ids as conflicted and reports malformed, key-mismatched, and foreign-pot rows', async () => {
    const { events } = ratifiedRound();
    const original = events[0];
    const { signature: _sig, ...unsigned } = original;
    const divergent = signEvent({ ...unsigned, occurredAtMs: original.occurredAtMs + 1 });
    const foreign = { ...events[1], eventId: 'foreign', potId: 'other-pot' };
    const malformed: HiveSettingRecord = {
      workspaceId: WORKSPACE_ID,
      potHomeSlug: POT_ID,
      settingKey: 'governanceEvent.v1.malformed',
      value: { nope: true },
      createdAt: NOW,
      updatedAt: NOW,
    };
    const keyMismatch = settingFor(events[2], {
      settingKey: 'governanceEvent.v1.wrong-digest',
    });

    const snapshot = await snapshotFrom(
      [original, divergent, foreign],
      [malformed, keyMismatch],
    );

    expect(snapshot.events.map((event) => event.eventId)).toEqual([
      original.eventId,
    ]);
    expect(snapshot.conflictedRoundIds).toEqual(new Set([original.roundId]));
    expect(snapshot.integrityErrors).toHaveLength(4);
    expect(snapshot.integrityErrors.join('\n')).toContain('invalid governance event');
    expect(snapshot.integrityErrors.join('\n')).toContain('content digest does not match key');
    expect(snapshot.integrityErrors.join('\n')).toContain("event belongs to pot 'other-pot'");
  });
});

describe('production plan-admission certificate source', () => {
  const resolve = (source: ReturnType<typeof sourceFor>, policy = POLICY) => source.resolve({
    slug: 'plan-1', door: 'start', planRevisionHash: PLAN_REVISION, policy, nowMs: NOW + 1,
    opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
  });

  it('exposes the same authenticated full certificate to governed execution', async () => {
    const ratified = ratifiedRound();
    const source = sourceFor(await snapshotFrom(ratified.events));
    const full = await source.resolveFinalization({ slug: 'plan-1', door: 'start',
      planRevisionHash: PLAN_REVISION, policy: POLICY, nowMs: NOW + 1,
      opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG } });
    expect(full.certificate).toEqual(ratified.certificate);
    expect(full.governance?.status).toBe('finalized');
    expect((await resolve(source)).certificate?.certificateHash).toBe(full.certificate?.certificateHash);
  });

  it('reconstructs real signed replacements and rejects a same-sequence replay', async () => {
    const ratified = ratifiedRound();
    const original = ratified.votes[0]!;
    const signedVote = (sequence: number, choice: GovernanceVoteEvent['choice']) => {
      const { signature: _signature, ...unsigned } = original;
      const body = { ...unsigned, sequence, choice, eventId: `replacement-${sequence}` };
      return { ...body, signature: signWithPrivateKeyDer(KEYS[0]!.privateKeyDer,
        governanceVoteSigningBytes(AUTHORITY, ratified.round, body)).toString('base64') };
    };
    const reject = signedVote(4, 'reject');
    const approve = signedVote(5, 'approve');
    const ballots = [...ratified.votes, reject, approve];
    const finalized = finalizeGovernanceRound({ round: ratified.round, events: ballots,
      policy: POLICY, members: AUTHORITY.members, nowMs: NOW });
    if (!finalized.ok) throw new Error(finalized.detail);
    expect(finalized.value.tally.replacements).toBe(2);
    const events = [...ratified.events.filter(e => e.body.kind !== 'finalize'),
      federated('replacement-reject', ratified.round.roundId, { kind: 'vote', vote: reject }, NOW - 2),
      federated('replacement-approve', ratified.round.roundId, { kind: 'vote', vote: approve }, NOW - 1),
      federated('revised-finalization', ratified.round.roundId, { kind: 'finalize', certificate: finalized.value }, NOW)];
    expect((await resolve(sourceFor(await snapshotFrom(events)))).certificate).toMatchObject({ admitted: true });
    const replay = signedVote(5, 'reject');
    const replayed = [...events, federated('sequence-replay', ratified.round.roundId, { kind: 'vote', vote: replay }, NOW)];
    expect((await resolve(sourceFor(await snapshotFrom(replayed)))).certificate).toBeNull();
  });

  it('refuses forged stored ballot and control signatures even when a custom snapshot claims integrity', async () => {
    const ratified = ratifiedRound();
    for (const kind of ['vote', 'finalize'] as const) {
      const events = ratified.events.map(e => e.body.kind === kind ? { ...e, signature: 'forged' } : e);
      const stored = await snapshotFrom(events);
      expect(stored.integrityErrors.join(';')).toContain('unverified-signature');
      expect((await resolve(sourceFor({ potId: POT_ID, events,
        integrityErrors: [], conflictedRoundIds: new Set() }))).certificate).toBeNull();
    }
  });

  it('refuses a governor-signed forged inner ballot and never writes a forged append', async () => {
    const ratified = ratifiedRound();
    const vote = ratified.votes[0]!;
    const forged = federated('forged-inner', ratified.round.roundId,
      { kind: 'vote', vote: { ...vote, signature: 'forged' } }, NOW);
    const snapshot = await snapshotFrom([ratified.events[0]!, forged]);
    expect(snapshot.integrityErrors.join(';')).toContain('unverified-ballot');
    let writes = 0;
    await expect(appendPlanAdmissionGovernanceEvent({ workspaceId: WORKSPACE_ID,
      potHomeSlug: POT_HOME_SLUG, event: forged }, undefined, {
      resolvePotScope: async () => POT_ID, resolveAuthority: async () => AUTHORITY,
      nowMs: () => NOW, ledgerChain: null, listSettings: async () => [settingFor(ratified.events[0]!)],
      setSetting: async () => { writes++; throw new Error('unexpected write'); },
    })).rejects.toThrow('unverified-ballot');
    expect(writes).toBe(0);
  });

  it('refuses stale authority epochs and changed policy thresholds at the production consumer', async () => {
    const ratified = ratifiedRound();
    const raw: PlanAdmissionGovernanceSnapshot = { potId: POT_ID, events: ratified.events,
      integrityErrors: [], conflictedRoundIds: new Set() };
    const stale = createPlanAdmissionCertificateSource({ resolvePotHomeSlug: async () => POT_HOME_SLUG,
      readSnapshot: async () => raw, resolveAuthority: async () => ({ ...AUTHORITY,
        members: AUTHORITY.members.map(m => ({ ...m, keyEpoch: 2 })) }) });
    expect((await resolve(stale)).certificate).toBeNull();
    expect((await resolve(sourceFor(raw), { ...POLICY, quorumBps: 1 })).certificate).toBeNull();
    const absent = createPlanAdmissionCertificateSource({ resolvePotHomeSlug: async () => POT_HOME_SLUG,
      readSnapshot: async () => raw, resolveAuthority: async () => null });
    expect((await resolve(absent)).certificate).toBeNull();
  });

  it('reconstructs certificates from authenticated ballots rather than trusting a signed self-computable hash', async () => {
    const ratified = ratifiedRound();
    const { certificateHash: _hash, ...base } = ratified.certificate;
    const altered = { ...base, tally: { ...base.tally, approveWeight: 100 } };
    const certificate = { ...altered, certificateHash: createHash('sha256').update(canonicalJson(altered)).digest('hex') };
    const wrong = federated('false-finalize', ratified.round.roundId, { kind: 'finalize', certificate }, NOW);
    const resolved = await resolve(sourceFor(await snapshotFrom([
      ...ratified.events.filter(e => e.body.kind !== 'finalize'), wrong,
    ])));
    expect(resolved.certificate).toBeNull();
    expect(resolved.governance?.status).toBe('quarantined');
    const missingBallots = await resolve(sourceFor(await snapshotFrom(
      ratified.events.filter(e => e.body.kind !== 'vote'))));
    expect(missingBallots.certificate).toBeNull();
    expect(missingBallots.governance?.status).toBe('quarantined');
  });

  it('authenticates out-of-order snapshots and makes exact replay idempotent', async () => {
    const ratified = ratifiedRound();
    const events = [...ratified.events].reverse();
    const resolved = await resolve(sourceFor(await snapshotFrom([...events, ...events])));
    expect(resolved.certificate?.certificateHash).toBe(ratified.certificate.certificateHash);
  });

  it('permits fresh re-ratification after policy and signer epochs change while retaining immutable history', async () => {
    const old = ratifiedRound({ roundId: 'old-round', createdAtMs: NOW - 20_000, finalizedAtMs: NOW - 15_000 });
    for (const changed of [
      { ...AUTHORITY, policy: { ...POLICY, policyVersion: POLICY.policyVersion + 1 } },
      { ...AUTHORITY, members: AUTHORITY.members.map(m => ({ ...m, keyEpoch: 2 })) },
    ]) {
      const fresh = ratifiedRound({ roundId: 'fresh-round', authority: changed });
      const rows = [...old.events, ...fresh.events].map(e => settingFor(e));
      const source = createPlanAdmissionCertificateSource({
        resolvePotHomeSlug: async () => POT_HOME_SLUG, resolveAuthority: async () => changed,
        readSnapshot: input => readPlanAdmissionGovernanceSnapshot(input, undefined, {
          resolvePotScope: async () => POT_ID, resolveAuthority: async () => changed,
          nowMs: () => NOW + 1, listSettings: async () => rows,
        }),
      });
      const result = await resolve(source, changed.policy);
      expect(result.certificate?.certificateHash).toBe(fresh.certificate.certificateHash);
      expect(rows).toHaveLength(old.events.length + fresh.events.length);
    }
  });
  it('bridges a verified finalization for the exact revision and returns controls from the same round', async () => {
    const ratified = ratifiedRound();
    const source = sourceFor(await snapshotFrom(ratified.events));

    const resolved = await source.resolve({
      slug: 'plan-1',
      door: 'start',
      planRevisionHash: PLAN_REVISION,
      policy: POLICY,
      nowMs: NOW + 1,
      opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
    });

    expect(resolved.certificate).toEqual(
      bridgeFinalizationToAdmissionCertificate(
        ratified.certificate,
        POLICY.ratificationWindowSec,
      ),
    );
    expect(resolved.governance).toEqual({
      roundId: ratified.round.roundId,
      status: 'finalized',
      quarantineReason: null,
      revokedReason: null,
    });
  });

  it('lets the newest exact round control admission instead of falling back to an older certificate', async () => {
    const older = ratifiedRound({
      roundId: 'round-older',
      createdAtMs: NOW - 20_000,
      finalizedAtMs: NOW - 15_000,
    });
    const newer = createGovernanceRound({
      roundId: 'round-newer',
      planRevisionHash: PLAN_REVISION,
      policyVersion: POLICY.policyVersion,
      eligibleMemberIds: [...MEMBERS],
      createdAtMs: NOW - 1_000,
      authorityHash: governanceAuthorityHash(AUTHORITY),
    });
    if (!newer.ok) throw new Error(`fixture newer round refused: ${newer.code} ${newer.detail}`);
    const newerOpen = federated(
      'round-newer-open',
      newer.value.roundId,
      { kind: 'round-open', round: newer.value },
      newer.value.createdAtMs,
    );
    const source = sourceFor(await snapshotFrom([...older.events, newerOpen]));

    const resolved = await source.resolve({
      slug: 'plan-1',
      door: 'promotion',
      planRevisionHash: PLAN_REVISION,
      policy: POLICY,
      nowMs: NOW,
      opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
    });

    expect(resolved.certificate).toBeNull();
    expect(resolved.governance).toEqual({
      roundId: 'round-newer',
      status: 'open',
      quarantineReason: null,
      revokedReason: null,
    });
  });
});

describe('owner-signed governance authority resolution', () => {
  function signedPolicy() {
    const owner = generateEd25519KeypairDer();
    const policy = { governance: { planAdmission: POLICY,
      signingAuthority: { members: AUTHORITY.members } } };
    const policyJson = canonicalizeHivePolicy(policy);
    const row: ResolvedHivePolicy = { workspaceId: WORKSPACE_ID, potHomeSlug: POT_ID,
      policy, policyJson, policyVersion: 10, ownerPubkey: owner.pubkeyBase64,
      signature: signWithPrivateKeyDer(owner.privateKeyDer, hivePolicySignedBytes({
        workspaceId: WORKSPACE_ID, potHomeSlug: POT_ID, policyVersion: 10, canonicalPolicyJson: policyJson,
      })).toString('base64'), fedHlc: null, updatedAt: NOW };
    return { owner, row };
  }

  it('reads policy at federated scope and verifies it against the independently registered local owner', async () => {
    const { owner, row } = signedPolicy();
    const result = await resolvePlanAdmissionGovernanceAuthority({ workspaceId: WORKSPACE_ID,
      potHomeSlug: POT_HOME_SLUG, potId: POT_ID }, undefined, {
      getPolicy: async (ws, scope) => { expect([ws, scope]).toEqual([WORKSPACE_ID, POT_ID]); return row; },
      getOwner: async (ws, handle) => { expect([ws, handle]).toEqual([WORKSPACE_ID, POT_HOME_SLUG]);
        return { pubkeyBase64: owner.pubkeyBase64 }; },
    });
    expect(result).toEqual({ ...AUTHORITY, delegations: undefined });
  });

  it('refuses forged signatures, edited signed policy, self-appointed keys and foreign scope', async () => {
    const { owner, row } = signedPolicy();
    const attacker = generateEd25519KeypairDer();
    for (const bad of [{ ...row, signature: 'forged' }, { ...row, potHomeSlug: 'other' },
      { ...row, policy: { governance: { ...row.policy.governance, planAdmission: { ...POLICY, quorumBps: 0 } } } },
      { ...row, ownerPubkey: attacker.pubkeyBase64 }]) {
      expect(await resolvePlanAdmissionGovernanceAuthority({ workspaceId: WORKSPACE_ID,
        potHomeSlug: POT_HOME_SLUG, potId: POT_ID }, undefined, {
        getPolicy: async () => bad, getOwner: async () => ({ pubkeyBase64: owner.pubkeyBase64 }),
      })).toBeNull();
    }
  });
});

describe('real governance certificates at the common seven-door gate', () => {
  it('admits every lifecycle door with the production source and refuses every door for an unratified revision', async () => {
    const ratified = ratifiedRound();
    configurePlanAdmissionPolicySource(async () => POLICY);
    configurePlanAdmissionCertificateSource(
      sourceFor(await snapshotFrom(ratified.events)),
    );
    const opts = { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG };

    const admitted = await Promise.all(
      PLAN_ADMISSION_DOORS.map((door) =>
        checkPlanAdmission({
          slug: 'plan-1',
          door,
          row: rowWith(PLAN_REVISION),
          nowMs: NOW + 1,
          opts,
        }),
      ),
    );
    expect(admitted).toHaveLength(PLAN_ADMISSION_DOORS.length);
    expect(admitted.every((verdict) => verdict.admitted && verdict.skipped === undefined)).toBe(true);
    expect(
      admitted.map((verdict) =>
        verdict.admitted && verdict.skipped === undefined
          ? verdict.certificate.certificateHash
          : null,
      ),
    ).toEqual(PLAN_ADMISSION_DOORS.map(() => ratified.certificate.certificateHash));

    const refused = await Promise.all(
      PLAN_ADMISSION_DOORS.map((door) =>
        checkPlanAdmission({
          slug: 'plan-1',
          door,
          row: rowWith('sha256:unratified-revision'),
          nowMs: NOW + 1,
          opts,
        }),
      ),
    );
    expect(
      refused.map((verdict) =>
        verdict.admitted
          ? null
          : { door: verdict.refusal.door, code: verdict.refusal.code },
      ),
    ).toEqual(
      PLAN_ADMISSION_DOORS.map((door) => ({
        door,
        code: 'missing-certificate',
      })),
    );
  });

  it('keeps enforcement default-on and turns the same seven typed refusals into shadow observations only when the kill switch is explicitly off', async () => {
    expect(planAdmissionEnforcementEnabled({})).toBe(true);
    expect(
      planAdmissionEnforcementEnabled({
        [PLAN_ADMISSION_ENFORCEMENT_ENV]: 'off',
      }),
    ).toBe(false);

    const previous = process.env[PLAN_ADMISSION_ENFORCEMENT_ENV];
    const observations: PlanAdmissionShadowObservation[] = [];
    try {
      process.env[PLAN_ADMISSION_ENFORCEMENT_ENV] = 'off';
      configurePlanAdmissionPolicySource(async () => POLICY);
      configurePlanAdmissionCertificateSource(
        sourceFor(await snapshotFrom([])),
      );
      configurePlanAdmissionShadowSink({
        record: (observation) => void observations.push(observation),
      });

      const verdicts = await Promise.all(
        PLAN_ADMISSION_DOORS.map((door) =>
          checkPlanAdmission({
            slug: 'plan-1',
            door,
            row: rowWith(PLAN_REVISION),
            nowMs: NOW,
            opts: { workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG },
          }),
        ),
      );

      expect(verdicts.every((verdict) => verdict.admitted && verdict.skipped === 'shadow-mode')).toBe(true);
      expect(observations.map(({ door, wouldAdmit, code }) => ({ door, wouldAdmit, code }))).toEqual(
        PLAN_ADMISSION_DOORS.map((door) => ({
          door,
          wouldAdmit: false,
          code: 'missing-certificate',
        })),
      );
    } finally {
      restoreEnv(PLAN_ADMISSION_ENFORCEMENT_ENV, previous);
    }
  });
});
