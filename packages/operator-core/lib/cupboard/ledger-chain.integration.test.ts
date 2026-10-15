/**
 * agent-economy-flywheel-2026-08-30 P-040 / R-28 — integration layer: the
 * Postgres link table (migration 1283) behind the governance ledger chain.
 *
 * Real: Postgres with the full migration set (append-only trigger, primary and
 * unique keys, RLS), the pot_settings rows the governance store writes, and the
 * production link store. Substituted: pot scope, signing authority and clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChainExport } from '@papercusp/hash-chain';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import type { HiveSettingRecord } from '../hive-settings-store';
import {
  appendPlanAdmissionGovernanceEvent,
  planAdmissionGovernanceLedgerSource,
  type PlanAdmissionGovernanceStoreDeps,
} from '../agent-tools/plans/plan-admission-governance-store';
import type { FederatedGovernanceEvent } from '../agent-tools/plans/governance-federation';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../identity/ed25519';
import { governanceAuthorityHash, governanceEventSigningBytes, type GovernanceSigningAuthority } from '../agent-tools/plans/governance-authentication';
import { DEFAULT_PLAN_ADMISSION_POLICY } from '../agent-tools/plans/plan-admission-policy';
import { exportLedger, pgLedgerChainLinkStore, verifyLedger, witnessLedger } from './ledger-chain';

const WS = 'ws-p040-ledger-chain';
const POT = 'p040-pot';
const T0 = 1_790_000_000_000;
const signer = generateEd25519KeypairDer();
const authority: GovernanceSigningAuthority = { potId: POT, policy: DEFAULT_PLAN_ADMISSION_POLICY,
  members: [{ memberId: 'owner', publicKey: signer.pubkeyBase64, keyEpoch: 1,
    roles: ['round-open', 'pause', 'vote'], originPeerIds: ['peer-a'] }] };

let db: OrgTestDb;

function pauseEvent(i: number): FederatedGovernanceEvent {
  const unsigned: Omit<FederatedGovernanceEvent, 'signature'> = {
    eventId: `evt-${i}`,
    potId: POT,
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

// The real pot_settings table, written directly: the hive-settings store
// additionally requires a registered Hive row, which is not under test here.
async function listPotSettings(workspaceId: string): Promise<HiveSettingRecord[]> {
  const rows = await db.adminSql<{ setting_key: string; value: string | null; created_at: string; updated_at: string }[]>`
    SELECT setting_key, value, created_at, updated_at FROM harness_shared.pot_settings
     WHERE workspace_id = ${workspaceId} AND harness_slug = ${POT} ORDER BY setting_key`;
  return rows.map((row) => ({
    workspaceId,
    potHomeSlug: POT,
    settingKey: row.setting_key,
    value: row.value == null ? null : JSON.parse(row.value),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }));
}

function deps(): PlanAdmissionGovernanceStoreDeps {
  return {
    resolveAuthority: async () => authority,
    nowMs: () => T0 + 1_000,
    resolvePotScope: async () => POT,
    listSettings: (workspaceId) => listPotSettings(workspaceId),
    setSetting: async (input) => {
      await db.adminSql`
        INSERT INTO harness_shared.pot_settings (workspace_id, harness_slug, setting_key, value, created_at, updated_at)
        VALUES (${input.workspaceId}, ${POT}, ${input.settingKey}, ${JSON.stringify(input.value)}, ${T0}, ${T0})
        ON CONFLICT (workspace_id, harness_slug, setting_key) DO NOTHING`;
      return (await listPotSettings(input.workspaceId)).find((row) => row.settingKey === input.settingKey)!;
    },
    ledgerChain: pgLedgerChainLinkStore(db.adminSql),
  };
}

beforeAll(async () => {
  db = await createOrgTestDb();
  for (let i = 0; i < 4; i += 1) {
    await appendPlanAdmissionGovernanceEvent(
      { workspaceId: WS, potHomeSlug: POT, event: pauseEvent(i) },
      db.adminSql,
      deps(),
    );
  }
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

const source = () => planAdmissionGovernanceLedgerSource({ workspaceId: WS, potHomeSlug: POT }, db.adminSql, deps());

describe('governance ledger chain on Postgres', () => {
  it('witnesses each append into ledger_chain_links and verifies clean', async () => {
    const rows = await db.adminSql<{ seq: string; prev_hash: string; entry_hash: string }[]>`
      SELECT seq, prev_hash, entry_hash FROM harness_shared.ledger_chain_links
       WHERE workspace_id = ${WS} AND stream_id = ${`governance.plan-admission:${POT}`} ORDER BY seq`;
    expect(rows.map((r) => Number(r.seq))).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < rows.length; i += 1) expect(rows[i]!.prev_hash).toBe(rows[i - 1]!.entry_hash);
    const report = await verifyLedger(WS, await source(), pgLedgerChainLinkStore(db.adminSql));
    expect(report).toMatchObject({ ok: true, unchainedCount: 0, verdict: { ok: true, length: 4 } });
    expect(verifyChainExport(await exportLedger(WS, await source(), pgLedgerChainLinkStore(db.adminSql))).ok).toBe(true);
  });

  it('refuses UPDATE and DELETE on the link table', async () => {
    await expect(
      db.adminSql`UPDATE harness_shared.ledger_chain_links SET entry_hash = ${'f'.repeat(64)} WHERE workspace_id = ${WS}`,
    ).rejects.toThrow(/append-only/);
    await expect(db.adminSql`DELETE FROM harness_shared.ledger_chain_links WHERE workspace_id = ${WS}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('a losing concurrent append reports conflict instead of forking the chain', async () => {
    const store = pgLedgerChainLinkStore(db.adminSql);
    const [head] = (await store.links(WS, `governance.plan-admission:${POT}`)).slice(-1);
    const forked = await store.append(WS, [
      {
        sourceId: 'governanceEvent.v1.fork',
        link: { ...head!.link, entryDigest: 'c'.repeat(64), entryHash: 'd'.repeat(64) },
      },
    ]);
    expect(forked).toBe('conflict');
  });

  it('an entry edited in place is reported at its position', async () => {
    const settings = await listPotSettings(WS);
    const target = settings.find((row) => (row.value as FederatedGovernanceEvent | null)?.eventId === 'evt-1')!;
    const forged = JSON.stringify({ ...(target.value as Record<string, unknown>), signature: 'forged' });
    await db.adminSql`
      UPDATE harness_shared.pot_settings SET value = ${forged}
       WHERE workspace_id = ${WS} AND harness_slug = ${POT} AND setting_key = ${target.settingKey}`;
    const report = await verifyLedger(WS, await source(), pgLedgerChainLinkStore(db.adminSql));
    expect(report.verdict).toMatchObject({ ok: false, length: 1, firstBreak: { seq: 1, reason: 'entry-mismatch' } });
    // Witnessing again appends nothing: an edited entry keeps its key, so it stays linked and flagged.
    expect((await witnessLedger(WS, await source(), pgLedgerChainLinkStore(db.adminSql))).appended).toBe(0);
  });
});
