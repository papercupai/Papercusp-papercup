/**
 * P-040 hash-chained ledgers, against REAL SQLite with the shipped migrations
 * (the append-only triggers and the (stream_id, seq) primary key are the
 * properties under test, which a string-matching fake could not enforce).
 */
import { describe, expect, it } from 'vitest';
import { parseChainExport, exportChain, verifyChainExport } from '@papercusp/hash-chain';
import { makeSqliteDb } from './sqlite-d1';
import { listSafeDeployments, recordSafeDeployment } from '../treasury-store';
import {
  exportLedgerStream,
  verifyLedgerStream,
  witnessLedgerStream,
} from '../ledger-chain-store';

type Raw = ReturnType<typeof makeSqliteDb>['raw'];

function insertLedgerEvent(raw: Raw, id: string, occurredAtMs: number, amountMinor = 1000): void {
  raw
    .prepare(
      'INSERT INTO commerce_ledger_events (ledger_event_id, kind, occurred_at_ms, provider, provider_event_id, payload_json) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'order.paid', occurredAtMs, 'stripe', `evt_${id}`, JSON.stringify({ amountMinor, currency: 'USD' }));
}

function insertTransfer(raw: Raw, id: string, createdAtMs: number): void {
  raw
    .prepare(
      `INSERT INTO treasury_transfers (transfer_id, batch_id, channel_id, principal_id, settlement_id, receipt_hash,
         split_manifest_hash, share, role, chain_id, safe_address, roles_module_address, token, recipient,
         amount_micros, safe_tx_hash, transaction_hash, block_number, proof_event_id, created_at_ms)
       VALUES (?, 'b1', 'c1', 'p1', 's1', ?, 'm1', 'dao', 'settlement', 84532, '0xsafe', '0xroles', '0xusdc',
         '0xdao', 1500000, '0xsafetx', ?, '123', NULL, ?)`,
    )
    .run(id, `r_${id}`, `0xtx_${id}`, createdAtMs);
}

function dropAppendOnlyTriggers(raw: Raw): void {
  raw.exec('DROP TRIGGER ledger_chain_links_no_update; DROP TRIGGER ledger_chain_links_no_delete;');
}

async function seeded(n = 4) {
  const { db, raw } = makeSqliteDb();
  for (let i = 1; i <= n; i += 1) insertLedgerEvent(raw, `le${i}`, 1000 + i);
  const witnessed = await witnessLedgerStream(db, 'commerce.ledger', 5000);
  return { db, raw, witnessed };
}

describe('ledger chain on D1', () => {
  it('chains existing rows in fold order and verifies clean', async () => {
    const { db, witnessed } = await seeded();
    expect(witnessed.appended).toBe(4);
    expect(witnessed.head?.seq).toBe(3);
    const report = await verifyLedgerStream(db, 'commerce.ledger');
    expect(report).toMatchObject({ ok: true, unchainedCount: 0, verdict: { ok: true, length: 4 } });
  });

  it('is idempotent and appends only new rows', async () => {
    const { db, raw } = await seeded();
    expect((await witnessLedgerStream(db, 'commerce.ledger', 6000)).appended).toBe(0);
    insertLedgerEvent(raw, 'le5', 900); // earlier timestamp, arrives late: chained at the tail
    const again = await witnessLedgerStream(db, 'commerce.ledger', 6001);
    expect(again).toMatchObject({ appended: 1, head: { seq: 4 } });
    expect((await verifyLedgerStream(db, 'commerce.ledger')).ok).toBe(true);
  });

  it('detects an edited ledger row at its position', async () => {
    const { db, raw } = await seeded();
    raw.prepare("UPDATE commerce_ledger_events SET payload_json = ? WHERE ledger_event_id = 'le3'").run(
      JSON.stringify({ amountMinor: 1, currency: 'USD' }),
    );
    const report = await verifyLedgerStream(db, 'commerce.ledger');
    expect(report.ok).toBe(false);
    expect(report.verdict.ok === false && report.verdict.firstBreak).toMatchObject({ seq: 2, reason: 'entry-mismatch' });
  });

  it('detects a deleted ledger row', async () => {
    const { db, raw } = await seeded();
    raw.prepare("DELETE FROM commerce_ledger_events WHERE ledger_event_id = 'le2'").run();
    const report = await verifyLedgerStream(db, 'commerce.ledger');
    expect(report.verdict.ok === false && report.verdict.firstBreak).toMatchObject({ seq: 1, reason: 'entry-missing' });
  });

  it('refuses link edits and deletes, and detects them when the triggers are dropped', async () => {
    const { db, raw } = await seeded();
    expect(() => raw.prepare("DELETE FROM ledger_chain_links WHERE seq = 1").run()).toThrow(/append-only/);
    expect(() => raw.prepare("UPDATE ledger_chain_links SET prev_hash = entry_hash WHERE seq = 2").run()).toThrow(/append-only/);
    dropAppendOnlyTriggers(raw);
    raw.prepare("DELETE FROM ledger_chain_links WHERE stream_id = 'commerce.ledger' AND seq = 1").run();
    const report = await verifyLedgerStream(db, 'commerce.ledger');
    expect(report.verdict.ok === false && report.verdict.firstBreak).toMatchObject({ seq: 2, reason: 'seq-gap' });
    // The row whose link was deleted is now also visible as unchained.
    expect(report.unchainedSample).toContain('le2');
  });

  it('reports a row inserted around the store as unchained until witnessed', async () => {
    const { db, raw } = await seeded();
    insertLedgerEvent(raw, 'sneaky', 2000);
    const before = await verifyLedgerStream(db, 'commerce.ledger');
    expect(before).toMatchObject({ ok: false, unchainedCount: 1, unchainedSample: ['sneaky'], verdict: { ok: true } });
    await witnessLedgerStream(db, 'commerce.ledger', 7000);
    expect((await verifyLedgerStream(db, 'commerce.ledger')).ok).toBe(true);
  });

  it('detects tail truncation only against an expected head', async () => {
    const { db, raw, witnessed } = await seeded();
    dropAppendOnlyTriggers(raw);
    raw.prepare("DELETE FROM ledger_chain_links WHERE stream_id = 'commerce.ledger' AND seq = 3").run();
    raw.prepare("DELETE FROM commerce_ledger_events WHERE ledger_event_id = 'le4'").run();
    expect((await verifyLedgerStream(db, 'commerce.ledger')).ok).toBe(true);
    const anchored = await verifyLedgerStream(db, 'commerce.ledger', { expectedHead: witnessed.head });
    expect(anchored.verdict.ok === false && anchored.verdict.firstBreak.reason).toBe('head-mismatch');
  });

  it('serializes a concurrent witness on the (stream_id, seq) key instead of forking', async () => {
    const { db, raw } = await seeded(2);
    insertLedgerEvent(raw, 'le3', 1003);
    // A competitor claims seq 2 for another row after our head read: our batch
    // collides on the primary key, rolls back whole, and retries from the new head.
    let injected = false;
    const racing: D1Database = {
      ...db,
      prepare: (sql: string) => db.prepare(sql),
      batch: async (stmts) => {
        if (!injected) {
          injected = true;
          insertLedgerEvent(raw, 'le4', 1004);
          await witnessLedgerStream(db, 'commerce.ledger', 8000);
        }
        return db.batch(stmts);
      },
    } as D1Database;
    await witnessLedgerStream(racing, 'commerce.ledger', 8001);
    const report = await verifyLedgerStream(db, 'commerce.ledger');
    expect(report).toMatchObject({ ok: true, verdict: { length: 4 } });
  });

  it('chains the treasury transfer stream independently', async () => {
    const { db, raw } = makeSqliteDb();
    insertTransfer(raw, 't1', 10);
    insertTransfer(raw, 't2', 20);
    expect((await witnessLedgerStream(db, 'treasury.transfers', 30)).appended).toBe(2);
    expect((await verifyLedgerStream(db, 'treasury.transfers')).ok).toBe(true);
    expect((await verifyLedgerStream(db, 'commerce.ledger')).verdict).toMatchObject({ ok: true, length: 0 });
    raw.prepare("UPDATE treasury_transfers SET recipient = '0xattacker' WHERE transfer_id = 't2'").run();
    const report = await verifyLedgerStream(db, 'treasury.transfers');
    expect(report.verdict.ok === false && report.verdict.firstBreak).toMatchObject({ seq: 1, reason: 'entry-mismatch' });
  });

  it.each(['commerce.ledger', 'treasury.transfers'] as const)(
    'reports the earliest altered or deleted entry in %s, even with a later break',
    async (streamId) => {
      const { db, raw } = makeSqliteDb();
      for (let i = 1; i <= 4; i += 1) {
        if (streamId === 'commerce.ledger') insertLedgerEvent(raw, `le${i}`, i);
        else insertTransfer(raw, `t${i}`, i);
      }
      expect((await witnessLedgerStream(db, streamId, 10)).appended).toBe(4);
      expect(await verifyLedgerStream(db, streamId)).toMatchObject({ ok: true, verdict: { length: 4 } });

      if (streamId === 'commerce.ledger') {
        raw.prepare("UPDATE commerce_ledger_events SET payload_json = '{}' WHERE ledger_event_id = 'le2'").run();
        raw.prepare("DELETE FROM commerce_ledger_events WHERE ledger_event_id = 'le4'").run();
      } else {
        raw.prepare("UPDATE treasury_transfers SET recipient = '0xattacker' WHERE transfer_id = 't2'").run();
        raw.prepare("DELETE FROM treasury_transfers WHERE transfer_id = 't4'").run();
      }
      const altered = await verifyLedgerStream(db, streamId);
      expect(altered).toMatchObject({ ok: false });
      expect(altered.verdict.ok === false && altered.verdict.firstBreak).toMatchObject({ seq: 1, reason: 'entry-mismatch' });

      if (streamId === 'commerce.ledger') raw.prepare("DELETE FROM commerce_ledger_events WHERE ledger_event_id = 'le1'").run();
      else raw.prepare("DELETE FROM treasury_transfers WHERE transfer_id = 't1'").run();
      const deleted = await verifyLedgerStream(db, streamId);
      expect(deleted).toMatchObject({ ok: false });
      expect(deleted.verdict.ok === false && deleted.verdict.firstBreak).toMatchObject({ seq: 0, reason: 'entry-missing' });
    },
  );

  it('keeps every Safe deployment record in a chained log, including values a re-record overwrote', async () => {
    const { db, raw } = makeSqliteDb();
    const deployment = {
      chainId: 84532,
      safeAddress: '0x1111111111111111111111111111111111111111',
      rolesModuleAddress: '0x2222222222222222222222222222222222222222',
      rolesVersion: 'v2' as const,
      deploymentTxHash: `0x${'a'.repeat(64)}`,
      network: 'testnet' as const,
      deployedAtMs: 1000,
    };
    const base = { owners: ['0x3333333333333333333333333333333333333333'], threshold: 1, recordedBy: 'op' };
    await recordSafeDeployment(db, {
      ...base,
      deployment,
      automationSigner: '0x4444444444444444444444444444444444444444',
      nowMs: 2000,
    });
    // A roles-module upgrade re-records the same Safe: the registry row is
    // overwritten, but the log keeps both versions and both are chained.
    await recordSafeDeployment(db, {
      ...base,
      deployment: { ...deployment, rolesModuleAddress: '0x5555555555555555555555555555555555555555' },
      automationSigner: '0x4444444444444444444444444444444444444444',
      nowMs: 3000,
    });
    expect(await listSafeDeployments(db)).toHaveLength(1);
    const report = await verifyLedgerStream(db, 'treasury.safe-deployment-records');
    expect(report).toMatchObject({ ok: true, unchainedCount: 0 });
    expect(report.verdict).toMatchObject({ ok: true, length: 2 });
    const exported = parseChainExport(await exportLedgerStream(db, 'treasury.safe-deployment-records'));
    expect(exported.records).toHaveLength(2);
    expect(exported.records[0]!.entry).toMatchObject({
      roles_module_address: '0x2222222222222222222222222222222222222222',
    });
    expect(exported.records[1]!.entry).toMatchObject({
      roles_module_address: '0x5555555555555555555555555555555555555555',
    });

    // The log refuses edits; with the trigger dropped, an edit to the overwritten
    // (older) record is reported at its own position.
    expect(() =>
      raw.prepare("UPDATE treasury_safe_deployment_records SET automation_signer = '0xattacker'").run(),
    ).toThrow(/append-only/);
    expect(() => raw.prepare('DELETE FROM treasury_safe_deployment_records').run()).toThrow(/append-only/);
    raw.exec('DROP TRIGGER treasury_safe_deployment_records_no_update;');
    raw
      .prepare(
        "UPDATE treasury_safe_deployment_records SET automation_signer = '0xattacker' WHERE recorded_at_ms = 2000",
      )
      .run();
    const tampered = await verifyLedgerStream(db, 'treasury.safe-deployment-records');
    expect(tampered.verdict.ok === false && tampered.verdict.firstBreak).toMatchObject({
      seq: 0,
      reason: 'entry-mismatch',
    });
  });

  it.each(['commerce.ledger', 'treasury.transfers'] as const)(
    'exports %s in the stable format, round-trips byte-exactly, and verifies offline',
    async (streamId) => {
      const { db, raw } = makeSqliteDb();
      for (let i = 1; i <= 4; i += 1) {
        if (streamId === 'commerce.ledger') insertLedgerEvent(raw, `le${i}`, i);
        else insertTransfer(raw, `t${i}`, i);
      }
      await witnessLedgerStream(db, streamId, 10);
      const text = await exportLedgerStream(db, streamId);
      const parsed = parseChainExport(text);
      expect(parsed.header).toMatchObject({ streamId, length: 4 });
      expect(exportChain(streamId, parsed.records)).toBe(text);
      expect(verifyChainExport(text)).toMatchObject({ ok: true, length: 4 });
      expect(parsed.records[0]!.entry).toMatchObject(
        streamId === 'commerce.ledger' ? { ledger_event_id: 'le1', provider: 'stripe' } : { transfer_id: 't1', recipient: '0xdao' },
      );
    },
  );
});
