/**
 * agent-economy-flywheel-2026-08-30 P-040 / R-28 — a tampered ledger entry is
 * detected. Unit layer: the Postgres-side chain (witness / verify / export)
 * over the per-pot plan-admission governance event log, with in-memory pot
 * settings and an in-memory link store. The Postgres link table and its
 * append-only triggers are covered by ledger-chain.integration.test.ts; the
 * Cupboard D1 commerce + treasury streams by
 * apps/operator-public/src/__tests__/ledger-chain-store.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { entryDigest, parseChainExport, verifyChainExport, exportChain } from '@papercusp/hash-chain';
import type { HiveSettingRecord } from '../hive-settings-store';
import {
  PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX,
  appendPlanAdmissionGovernanceEvent,
  planAdmissionGovernanceLedgerSource,
  type PlanAdmissionGovernanceStoreDeps,
} from '../agent-tools/plans/plan-admission-governance-store';
import type { FederatedGovernanceEvent } from '../agent-tools/plans/governance-federation';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { governanceAuthorityHash, governanceEventSigningBytes, type GovernanceSigningAuthority } from '../agent-tools/plans/governance-authentication';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../agent-tools/plans/plan-admission-policy';
import {
  exportLedger,
  memoryLedgerChainLinkStore,
  verifyLedger,
  witnessLedger,
  type LedgerSource,
} from './ledger-chain';

const WS = 'ws-ledger-chain';
const POT_HOME = 'pot-home';
const POT_ID = 'pot-chain';
const T0 = 1_790_000_000_000;
const signer = generateEd25519KeypairDer();
const authority: GovernanceSigningAuthority = { potId: POT_ID, policy: DEFAULT_PLAN_ADMISSION_POLICY,
  members: [{ memberId: 'owner', publicKey: signer.pubkeyBase64, keyEpoch: 1,
    roles: ['round-open', 'pause', 'vote'], originPeerIds: ['peer-a'] }] };

function pauseEvent(i: number): FederatedGovernanceEvent {
  const unsigned: Omit<FederatedGovernanceEvent, 'signature'> = {
    eventId: `evt-${i}`,
    potId: POT_ID,
    roundId: 'round-1',
    originPeerId: 'peer-a',
    occurredAtMs: T0 + i,
    body: i === 0 ? { kind: 'round-open', round: { roundId: 'round-1', planRevisionHash: 'revision',
      policyVersion: 1, eligibleMemberIds: ['owner'], createdAtMs: T0, authorityHash: governanceAuthorityHash(authority) } }
      : { kind: 'pause', expiresAtMs: T0 + 1_000 + i },
    authorization: { memberId: 'owner', keyEpoch: 1 },
  };
  return { ...unsigned, signature: signWithPrivateKeyDer(signer.privateKeyDer,
    governanceEventSigningBytes(unsigned)).toString('base64') };
}

function harness() {
  const rows: HiveSettingRecord[] = [];
  const chain = memoryLedgerChainLinkStore();
  const deps: PlanAdmissionGovernanceStoreDeps = {
    resolveAuthority: async () => authority,
    nowMs: () => T0 + 1_000,
    resolvePotScope: async () => POT_ID,
    listSettings: async () => rows.map((row) => ({ ...row })),
    setSetting: async (input) => {
      const record: HiveSettingRecord = {
        workspaceId: input.workspaceId,
        potHomeSlug: POT_ID,
        settingKey: input.settingKey,
        value: input.value,
        createdAt: T0,
        updatedAt: T0,
      };
      rows.push(record);
      return record;
    },
    ledgerChain: chain,
  };
  const input = { workspaceId: WS, potHomeSlug: POT_HOME };
  const source = () => planAdmissionGovernanceLedgerSource(input, undefined, deps);
  const append = (event: FederatedGovernanceEvent) =>
    appendPlanAdmissionGovernanceEvent({ ...input, event }, undefined, deps);
  return { rows, chain, deps, source, append };
}

async function seeded(n: number) {
  const h = harness();
  for (let i = 0; i < n; i += 1) await h.append(pauseEvent(i));
  return h;
}

describe('governance ledger hash chain', () => {
  it('chains every appended governance event onto its pot stream, each carrying the previous hash', async () => {
    const h = await seeded(4);
    const source = await h.source();
    expect(source.streamId).toBe(`governance.plan-admission:${POT_ID}`);
    const links = await h.chain.links(WS, source.streamId);
    expect(links.map((l) => l.link.seq)).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < links.length; i += 1) {
      expect(links[i]!.link.prevHash).toBe(links[i - 1]!.link.entryHash);
    }
    // Each link commits to the stored entry it names.
    const entries = await source.list();
    expect(links.map((l) => l.sourceId)).toEqual(entries.map((e) => e.sourceId));
    expect(links[2]!.link.entryDigest).toBe(entryDigest(entries[2]!.entry));
    const report = await verifyLedger(WS, source, h.chain);
    expect(report).toMatchObject({ ok: true, unchainedCount: 0, verdict: { ok: true, length: 4 } });
  });

  it('a replayed append is idempotent and does not extend the chain', async () => {
    const h = await seeded(3);
    await h.append(pauseEvent(1));
    const source = await h.source();
    expect(await h.chain.links(WS, source.streamId)).toHaveLength(3);
  });

  it('an entry altered in place is reported at its own position, not a later one', async () => {
    const h = await seeded(5);
    const target = h.rows.find((row) => (row.value as FederatedGovernanceEvent).eventId === 'evt-2')!;
    target.value = { ...(target.value as FederatedGovernanceEvent), signature: 'forged' };
    const report = await verifyLedger(WS, await h.source(), h.chain);
    expect(report.ok).toBe(false);
    expect(report.verdict).toMatchObject({
      ok: false,
      length: 2,
      firstBreak: { seq: 2, reason: 'entry-mismatch' },
    });
  });

  it('a deleted entry is reported at its own position', async () => {
    const h = await seeded(5);
    const index = h.rows.findIndex((row) => (row.value as FederatedGovernanceEvent).eventId === 'evt-1');
    h.rows.splice(index, 1);
    const report = await verifyLedger(WS, await h.source(), h.chain);
    expect(report.verdict).toMatchObject({ ok: false, length: 1, firstBreak: { seq: 1, reason: 'entry-missing' } });
  });

  it('with an entry altered AND another deleted, verify names the first broken position', async () => {
    const h = await seeded(6);
    const altered = h.rows.find((row) => (row.value as FederatedGovernanceEvent).eventId === 'evt-4')!;
    altered.value = { ...(altered.value as FederatedGovernanceEvent), originPeerId: 'peer-z' };
    h.rows.splice(
      h.rows.findIndex((row) => (row.value as FederatedGovernanceEvent).eventId === 'evt-3'),
      1,
    );
    const report = await verifyLedger(WS, await h.source(), h.chain);
    expect(report.verdict).toMatchObject({ ok: false, firstBreak: { seq: 3, reason: 'entry-missing' } });
  });

  it('a rewritten link (spliced history) and a truncated tail are both detected', async () => {
    const h = await seeded(4);
    const source = await h.source();
    const truncated = await verifyLedger(WS, source, h.chain, { expectedHead: { seq: 5, entryHash: 'a'.repeat(64) } });
    expect(truncated.verdict).toMatchObject({ ok: false, firstBreak: { reason: 'head-mismatch' } });

    const stored = h.chain.rows.find((row) => row.link.seq === 1)!;
    (stored as { link: { entryHash: string } }).link.entryHash = 'b'.repeat(64);
    const spliced = await verifyLedger(WS, source, h.chain);
    expect(spliced.verdict).toMatchObject({ ok: false, firstBreak: { seq: 1, reason: 'link-hash-mismatch' } });
  });

  it('an entry that arrived without a witness pass is unchained, not a break, until witnessed', async () => {
    const h = await seeded(2);
    const late = pauseEvent(9);
    h.rows.push({
      workspaceId: WS,
      potHomeSlug: POT_ID,
      settingKey: `${PLAN_ADMISSION_GOVERNANCE_EVENT_PREFIX}late`,
      value: late,
      createdAt: T0,
      updatedAt: T0,
    });
    const source = await h.source();
    const before = await verifyLedger(WS, source, h.chain);
    expect(before).toMatchObject({ ok: false, unchainedCount: 1, verdict: { ok: true } });
    expect(await witnessLedger(WS, source, h.chain)).toMatchObject({ appended: 1, head: { seq: 2 } });
    expect((await verifyLedger(WS, source, h.chain)).ok).toBe(true);
  });

  it('export, then import, then verify is clean and the re-export is byte-equal', async () => {
    const h = await seeded(5);
    const exported = await exportLedger(WS, await h.source(), h.chain);
    expect(verifyChainExport(exported).ok).toBe(true);
    const parsed = parseChainExport(exported);
    expect(parsed.header).toMatchObject({ streamId: `governance.plan-admission:${POT_ID}`, length: 5 });
    expect(exportChain(parsed.header.streamId, parsed.records)).toBe(exported);
  });

  it('a concurrent witness that loses the race retries from the new head and never forks', async () => {
    const chain = memoryLedgerChainLinkStore();
    const entries = [0, 1, 2].map((i) => ({ sourceId: `s${i}`, entry: { i } }));
    let calls = 0;
    const racing: LedgerSource = {
      streamId: 'race',
      async list() {
        calls += 1;
        // A peer witnesses the first entry between this pass's read and its append.
        if (calls === 1) await witnessLedger(WS, { streamId: 'race', list: async () => entries.slice(0, 1) }, chain);
        return entries;
      },
    };
    const result = await witnessLedger(WS, racing, chain);
    expect(result).toMatchObject({ appended: 2, head: { seq: 2 } });
    expect((await verifyLedger(WS, { streamId: 'race', list: async () => entries }, chain)).ok).toBe(true);
  });
});
