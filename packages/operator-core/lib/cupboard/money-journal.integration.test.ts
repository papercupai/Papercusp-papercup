/**
 * agent-economy-flywheel-2026-08-30 P-042 / R-30, integration layer: the money
 * journal on real Postgres (migration 1286) with the P-040 hash chain.
 *
 * Real: Postgres with every migration applied, the store, the database guards,
 * the ledger_chain_links stream. Substituted: nothing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createOrgTestDb } from '../../test/_org-test-db';
import { pgLedgerChainLinkStore, verifyLedger } from './ledger-chain';
import {
  MICROS_PER_CENT,
  journalEntryForMovement,
  rollupInvariant,
  trialBalance,
  type ExternalRef,
  type MoneyMovement,
} from './money-journal';
import {
  accrueUsageMicros,
  moneyJournalLedgerSource,
  postMoneyJournalEntry,
  readLockedMoneyJournalPopulation,
  readMicrosRollup,
  readMoneyJournalEntries,
  settleUsageRollup,
  type MoneyJournalStoreDeps,
} from './money-journal-store';

const WS = 'ws-p042-money-journal';
let db: OrgTestDb;
let deps: MoneyJournalStoreDeps;

const chainRef = (n: number): ExternalRef => ({ kind: 'chain-tx', chainId: 84532, txHash: `0x${n.toString(16).padStart(64, '0')}` });

function entryFor(entryId: string, movement: MoneyMovement, externalRef: ExternalRef, occurredAtMs = 1_790_000_000_000) {
  const built = journalEntryForMovement({ entryId, occurredAtMs, currency: 'USD', externalRef, movement });
  if (!built.ok) throw new Error(`${built.code}: ${built.detail}`);
  return built.entry;
}

beforeAll(async () => {
  db = await createOrgTestDb({ adminPoolMax: 6 });
  let migration: string;
  try { migration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql.DRAFT', import.meta.url), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    migration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql', import.meta.url), 'utf8');
  }
  await db.adminSql.unsafe(migration); await db.adminSql.unsafe(migration);
  try { migration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1385-hosted-journal-liability-population.sql.DRAFT', import.meta.url), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    migration = readFileSync(new URL('../../../../libs/papercusp/libs/db/sql/1385-hosted-journal-liability-population.sql', import.meta.url), 'utf8');
  }
  await db.adminSql.unsafe(migration); await db.adminSql.unsafe(migration);
  deps = { sql: db.adminSql, ledgerChain: pgLedgerChainLinkStore(db.adminSql) };
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

const serviceRead = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => db.appSql.begin(async tx => {
  await tx.unsafe('SET LOCAL ROLE hosted_service');
  return fn(tx as unknown as Sql);
}) as Promise<T>;
const noWitness: MoneyJournalStoreDeps = { get sql() { return db.adminSql; }, ledgerChain: null };

describe('locked local journal liabilities (monetization P005)', () => {
  async function withPopulationHeld(fn: () => Promise<void>, rollback = false) {
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const sentinel = new Error('journal population rollback');
    const held = serviceRead(async sql => {
      await readLockedMoneyJournalPopulation(sql); ready(); await released;
      if (rollback) throw sentinel;
    }).catch(error => { if (error !== sentinel) throw error; });
    try { await Promise.race([started, held]); await fn(); }
    finally { release(); await held; }
  }

  it('protects empty sources against actual accrual/posting and direct inserts until commit', async () => {
    expect(await serviceRead(readLockedMoneyJournalPopulation)).toEqual({ entries: [], rollups: [], accruals: [] });
    let accrual!: ReturnType<typeof accrueUsageMicros>; let posting!: ReturnType<typeof postMoneyJournalEntry>;
    const workspaceId = WS + '-empty-population';
    await withPopulationHeld(async () => {
      accrual = accrueUsageMicros({ workspaceId, rollupId: 'empty', accrualId: 'a', micros: 7 }, noWitness);
      posting = postMoneyJournalEntry({ workspaceId, entry: entryFor('post', { kind: 'provider-payment', amountCents: 1 }, chainRef(200)) }, noWitness);
      await vi.waitFor(async () => {
        const blocked = await db.adminSql`SELECT c.relname AS relation FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
          WHERE NOT granted AND mode = 'RowExclusiveLock' AND relation IN
            ('harness_shared.money_journal_rollups'::regclass, 'harness_shared.money_journal_entries'::regclass)
            AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        expect(blocked.map(row => row.relation).sort()).toEqual(['money_journal_entries', 'money_journal_rollups']);
      }, { timeout: 3000 });
      for (const table of ['money_journal_lines', 'money_journal_micro_accruals']) {
        await expect(db.adminSql.begin(async tx => {
          await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
          if (table === 'money_journal_lines') {
            await tx`INSERT INTO harness_shared.money_journal_lines (workspace_id, entry_id, line_no, account, side, cents)
              VALUES (${workspaceId}, 'direct', 0, 'operating', 'debit', 1)`;
          } else {
            await tx`INSERT INTO harness_shared.money_journal_micro_accruals (workspace_id, rollup_id, accrual_id, micros)
              VALUES (${workspaceId}, 'direct', 'direct', 1)`;
          }
        })).rejects.toMatchObject({ code: '55P03' });
      }
    });
    expect(await accrual).toMatchObject({ ok: true, totalMicros: 7 });
    expect(await posting).toMatchObject({ ok: true, duplicate: false });
  });

  it('preserves full workspace-local identities, exact residue, currencies, history and immutable output', async () => {
    const a = WS + '-population-a'; const b = WS + '-population-b';
    for (const [workspaceId, cents] of [[a, 2], [b, 5]] as const) {
      await postMoneyJournalEntry({ workspaceId, entry: entryFor('shared-entry', { kind: 'provider-payment', amountCents: cents }, chainRef(cents), 1) }, noWitness);
      await accrueUsageMicros({ workspaceId, rollupId: 'shared-rollup', accrualId: 'shared-accrual', micros: 10000, microsExact: '10000.2', currency: workspaceId === a ? 'USD' : 'EUR' }, noWitness);
    }
    for (let i = 0; i < 30; i++) {
      await accrueUsageMicros({ workspaceId: a, rollupId: 'shared-rollup', accrualId: 'extra-' + i, micros: 0, microsExact: '0.000001' }, noWitness);
    }
    await settleUsageRollup({ workspaceId: a, rollupId: 'shared-rollup', entryId: 'settled', occurredAtMs: 1, externalRef: chainRef(201), daoBasisPoints: 0 }, noWitness);
    const population = await serviceRead(readLockedMoneyJournalPopulation);
    expect(population.entries.filter(row => row.entry.entryId === 'shared-entry')).toEqual([
      { workspaceId: a, entry: entryFor('shared-entry', { kind: 'provider-payment', amountCents: 2 }, chainRef(2), 1) },
      { workspaceId: b, entry: entryFor('shared-entry', { kind: 'provider-payment', amountCents: 5 }, chainRef(5), 1) },
    ]);
    expect(population.rollups.find(row => row.workspaceId === a)).toMatchObject({
      rollup: { rollupId: 'shared-rollup', totalMicrosExact: '10000.20003', settledCents: 1, roundingMicrosExact: '0.20003' },
      accrualIds: expect.arrayContaining(['shared-accrual', 'extra-29']),
    });
    expect(population.rollups.find(row => row.workspaceId === b)).toMatchObject({ rollup: { currency: 'EUR', settledCents: 0, roundingMicrosExact: '10000.2' }, accrualIds: ['shared-accrual'] });
    expect(population.accruals.filter(row => row.workspaceId === a)).toHaveLength(31);
    expect(population.accruals.find(row => row.accrualId === 'extra-29')).toMatchObject({ microsExact: '0.000001', recordedAtMs: expect.any(Number) });
    expect(Object.hasOwn(population, 'complete')).toBe(false);
    expect(Object.hasOwn(population, 'paid')).toBe(false);
    expect(() => (population.entries as unknown[]).push({})).toThrow();
    expect(() => (population.entries[0]!.entry.lines as unknown[]).push({})).toThrow();
    expect(() => (population.rollups[0]!.accrualIds as string[]).push('forged')).toThrow();
  });

  it('reads caller-uncommitted rows and releases its locks and writes on rollback', async () => {
    const workspaceId = WS + '-uncommitted';
    await expect(db.adminSql.begin(async tx => {
      await tx`INSERT INTO harness_shared.money_journal_rollups (workspace_id, rollup_id, currency, total_micros, rounding_micros)
        VALUES (${workspaceId}, 'pending', 'USD', 0.25, 0.25)`;
      await tx`INSERT INTO harness_shared.money_journal_micro_accruals (workspace_id, rollup_id, accrual_id, micros)
        VALUES (${workspaceId}, 'pending', 'pending', 0.25)`;
      await tx.unsafe('SET LOCAL ROLE hosted_service');
      const population = await readLockedMoneyJournalPopulation(tx as unknown as Sql);
      expect(population.rollups.find(row => row.workspaceId === workspaceId)).toMatchObject({ rollup: { totalMicrosExact: '0.25' } });
      expect(population.accruals.find(row => row.workspaceId === workspaceId)).toMatchObject({ microsExact: '0.25' });
      throw new Error('uncommitted rollback');
    })).rejects.toThrow('uncommitted rollback');
    expect((await serviceRead(readLockedMoneyJournalPopulation)).rollups.some(row => row.workspaceId === workspaceId)).toBe(false);
    expect(await accrueUsageMicros({ workspaceId, rollupId: 'pending', accrualId: 'pending', micros: 1 }, noWitness)).toMatchObject({ ok: true, totalMicros: 1 });
    await withPopulationHeld(async () => {
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`UPDATE harness_shared.money_journal_rollups SET updated_at = now() WHERE workspace_id = ${workspaceId}`;
      })).rejects.toMatchObject({ code: '55P03' });
    }, true);
    expect(await accrueUsageMicros({ workspaceId, rollupId: 'pending', accrualId: 'after-rollback', micros: 1 }, noWitness)).toMatchObject({ ok: true, totalMicros: 2 });
  });

  it('rejects autocommit and stale isolation, including callers using the bridge directly', async () => {
    await expect(readLockedMoneyJournalPopulation(db.adminSql)).rejects.toThrow('journal population requires one transaction');
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
      for (const direct of [false, true]) {
        await expect(db.adminSql.begin(async tx => {
          await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          if (direct) await tx`SELECT papercusp_auth.lock_hosted_stripe_funding_population()`;
          else await readLockedMoneyJournalPopulation(tx as unknown as Sql);
        })).rejects.toThrow(direct ? 'funding population requires read committed' : 'journal population requires read committed');
      }
    }
  });

  it('exposes read-only columns to hosted_service and keeps customer/app roles out', async () => {
    for (const role of ['harness_app', 'hosted_app']) {
      await expect(db.appSql.begin(async tx => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT papercusp_auth.lock_hosted_stripe_funding_population()`;
      })).rejects.toMatchObject({ code: '42501' });
    }
    for (const table of ['money_journal_rollups', 'money_journal_micro_accruals']) {
      for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
        const [row] = await db.adminSql`SELECT has_table_privilege('hosted_service', ${'harness_shared.' + table}, ${privilege}) AS allowed`;
        expect(row!.allowed).toBe(false);
      }
    }
  });

  it('waits for an actual staged settlement at the first rollup lock and then reads its complete commit', async () => {
    const workspaceId = WS + '-staged-settlement';
    await accrueUsageMicros({ workspaceId, rollupId: 'staged', accrualId: 'a', micros: 12345 }, noWitness);
    await db.adminSql.unsafe(`CREATE FUNCTION harness_shared.test_pause_settlement_population() RETURNS trigger LANGUAGE plpgsql AS $body$
      BEGIN IF NEW.workspace_id = '${WS}-staged-settlement' THEN PERFORM pg_advisory_xact_lock(200042, 1); END IF; RETURN NEW; END $body$;
      CREATE TRIGGER test_pause_settlement_population BEFORE INSERT ON harness_shared.money_journal_entries
        FOR EACH ROW EXECUTE FUNCTION harness_shared.test_pause_settlement_population();`);
    let ready!: () => void; let release!: () => void; let readerPid = 0;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const controller = db.adminSql.begin(async tx => { await tx`SELECT pg_advisory_xact_lock(200042, 1)`; ready(); await released; });
    const results = <T>(p: Promise<T>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    let settlement: ReturnType<typeof results<Awaited<ReturnType<typeof settleUsageRollup>>>> | undefined;
    let reader: ReturnType<typeof results<Awaited<ReturnType<typeof readLockedMoneyJournalPopulation>>>> | undefined;
    try {
      await Promise.race([started, controller]);
      settlement = results(settleUsageRollup({ workspaceId, rollupId: 'staged', entryId: 'staged', occurredAtMs: 1,
        externalRef: chainRef(202), daoBasisPoints: 0 }, noWitness));
      await vi.waitFor(async () => {
        const waiting = await db.adminSql`SELECT pid FROM pg_locks WHERE locktype = 'advisory'
          AND classid = 200042 AND objid = 1 AND NOT granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
        expect(waiting).toHaveLength(1);
      }, { timeout: 3000 });
      reader = results(serviceRead(async sql => {
        const [row] = await sql`SELECT pg_backend_pid() AS pid`; readerPid = row!.pid;
        await sql.unsafe("SET LOCAL statement_timeout = '5s'");
        return readLockedMoneyJournalPopulation(sql);
      }));
      await vi.waitFor(async () => {
        const waiting = await db.adminSql`SELECT pid FROM pg_locks WHERE pid = ${readerPid}
          AND relation = 'harness_shared.money_journal_rollups'::regclass AND mode = 'ShareLock' AND NOT granted`;
        expect(waiting).toHaveLength(1);
      }, { timeout: 2000 });
    } finally {
      release(); await controller;
      await Promise.all([settlement, reader]);
      await db.adminSql.unsafe('DROP TRIGGER test_pause_settlement_population ON harness_shared.money_journal_entries; DROP FUNCTION harness_shared.test_pause_settlement_population();');
    }
    expect(await settlement).toMatchObject({ ok: true, value: { ok: true, settledCents: 1 } });
    const result = await reader; if (!result?.ok) throw result?.error ?? new Error('population reader did not run');
    expect(result.value.rollups.find(row => row.workspaceId === workspaceId)).toMatchObject({ rollup: { totalMicros: 12345, settledCents: 1, roundingMicros: 2345 } });
    expect(result.value.entries.find(row => row.workspaceId === workspaceId)).toMatchObject({ entry: { entryId: 'staged', movement: 'usage-settlement' } });
  });

  it('distinguishes the old ROW SHARE upgrade cycle from the corrected actual settlement', async () => {
    // A causal counterexample in the disposable DB, without mutating product
    // source: reproduce the old writer's three lock phases exactly. The
    // previous test exercises the real, corrected settleUsageRollup instead.
    const workspaceId = WS + '-old-upgrade';
    await accrueUsageMicros({ workspaceId, rollupId: 'old', accrualId: 'a', micros: 10000 }, noWitness);
    let ready!: () => void; let release!: () => void; let readerPid = 0;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const results = <T>(p: Promise<T>) => p.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
    const oldWriter = results(db.adminSql.begin(async tx => {
      await tx.unsafe("SET LOCAL deadlock_timeout = '50ms'");
      await tx`SELECT rollup_id FROM harness_shared.money_journal_rollups
        WHERE workspace_id = ${workspaceId} AND rollup_id = 'old' FOR UPDATE`;
      await tx`INSERT INTO harness_shared.money_journal_entries
        (workspace_id, entry_id, occurred_at, currency, movement, external_ref_kind, external_ref, rollup_id, memo)
        VALUES (${workspaceId}, 'old', now(), 'USD', 'usage-settlement', 'bank-transaction', 'fixture-old', 'old', '')`;
      await tx`INSERT INTO harness_shared.money_journal_lines (workspace_id, entry_id, line_no, account, side, cents)
        VALUES (${workspaceId}, 'old', 0, 'provider-cost', 'debit', 1),
          (${workspaceId}, 'old', 1, 'operating', 'credit', 1)`;
      ready(); await released;
      await tx`UPDATE harness_shared.money_journal_rollups SET settled_cents = 1, rounding_micros = 0
        WHERE workspace_id = ${workspaceId} AND rollup_id = 'old'`;
    }) as Promise<unknown>);
    let reader: ReturnType<typeof results<Awaited<ReturnType<typeof readLockedMoneyJournalPopulation>>>> | undefined;
    try {
      await Promise.race([started, oldWriter]);
      reader = results(serviceRead(async sql => {
        const [row] = await sql`SELECT pg_backend_pid() AS pid`; readerPid = row!.pid;
        await sql.unsafe("SET LOCAL statement_timeout = '5s'");
        return readLockedMoneyJournalPopulation(sql);
      }));
      await vi.waitFor(async () => {
        const locks = await db.adminSql`SELECT relation, granted FROM pg_locks WHERE pid = ${readerPid}
          AND mode = 'ShareLock' AND relation IN ('harness_shared.money_journal_entries'::regclass,
            'harness_shared.money_journal_rollups'::regclass)`;
        expect(locks).toHaveLength(2);
        expect(locks.filter(row => !row.granted)).toHaveLength(1);
      }, { timeout: 2000 });
    } finally { release(); await Promise.all([oldWriter, reader]); }
    const outcomes = [await oldWriter, await reader];
    expect(outcomes.filter(row => row && !row.ok && row.error.code === '40P01')).toHaveLength(1);
    expect(outcomes.filter(row => row?.ok)).toHaveLength(1);
  });
});

describe('money journal on Postgres (P-042, R-30)', () => {
  it('keeps exact residue in durable rollups under concurrent replay and settlement', async () => {
    const workspaceId = WS + '-exact';
    const rollupId = 'exact-decimal';
    const input = { workspaceId, rollupId, accrualId: 'decimal-a', micros: 4999, microsExact: '4999.6' };
    const deliveries = await Promise.all(Array.from({ length: 8 }, () => accrueUsageMicros(input, deps)));
    expect(deliveries.filter(r => r.ok && !r.duplicate)).toHaveLength(1);
    expect(deliveries.filter(r => r.ok && r.duplicate)).toHaveLength(7);
    expect(await accrueUsageMicros({ ...input, microsExact: '4999.7' }, deps)).toMatchObject({ ok: false, detail: 'accrual replay mismatch' });
    expect(await accrueUsageMicros({ ...input, accrualId: 'decimal-b', micros: 5000, microsExact: '5000.6' }, deps)).toMatchObject({ ok: true, totalMicrosExact: '10000.2' });
    const settle = { workspaceId, rollupId, entryId: 'exact-cent', occurredAtMs: 1_790_000_000_000, externalRef: chainRef(1234), daoBasisPoints: 0 };
    const results = await Promise.all([settleUsageRollup(settle, deps), settleUsageRollup(settle, deps)]);
    expect(results.filter(r => r.ok && !r.duplicate)).toHaveLength(1);
    const rollup = await readMicrosRollup(workspaceId, rollupId, deps);
    expect(rollup).toMatchObject({ totalMicros: 10000, totalMicrosExact: '10000.2', settledCents: 1, roundingMicros: 0, roundingMicrosExact: '0.2' });
    expect(rollupInvariant(await readMoneyJournalEntries(workspaceId, deps), rollup!).holds).toBe(true);
    expect(await verifyLedger(workspaceId, moneyJournalLedgerSource(workspaceId, deps), deps.ledgerChain!)).toMatchObject({ ok: true, unchainedCount: 0 });
    const other = await readMicrosRollup('other-workspace', rollupId, deps); expect(other).toBeNull();
    await expect(db.adminSql`UPDATE harness_shared.money_journal_rollups SET rounding_micros = 0.3 WHERE workspace_id = ${workspaceId} AND rollup_id = ${rollupId}`)
      .rejects.toMatchObject({ code: '23514' });
  });
  it('posts balanced entries for each movement, reads them back exactly, and is idempotent on entryId', async () => {
    const entries = [
      entryFor('pay-1', { kind: 'customer-payment', grossCents: 10_000, feeCents: 320, taxCents: 800, daoCents: 920, refundReserveCents: 100 }, { kind: 'stripe-balance-transaction', id: 'txn_1Pay' }),
      entryFor('cred-1', { kind: 'credit-purchase', grossCents: 2_000, feeCents: 88, taxCents: 0 }, { kind: 'stripe-balance-transaction', id: 'txn_1Cred' }),
      entryFor('ref-1', { kind: 'refund', amountCents: 500, taxCents: 40 }, { kind: 'stripe-balance-transaction', id: 'txn_1Ref' }),
      entryFor('prov-1', { kind: 'provider-payment', amountCents: 3_000 }, { kind: 'bank-transaction', id: 'BANK-2026-10-01-7' }),
      entryFor('dao-1', { kind: 'dao-transfer', amountCents: 900 }, chainRef(1)),
      entryFor('tax-1', { kind: 'tax-remittance', amountCents: 760 }, { kind: 'bank-transaction', id: 'BANK-2026-10-01-8' }),
    ];
    for (const entry of entries) {
      expect(await postMoneyJournalEntry({ workspaceId: WS, entry }, deps)).toMatchObject({ ok: true, duplicate: false });
    }
    const stored = await readMoneyJournalEntries(WS, deps);
    expect(stored).toEqual(entries);
    expect(trialBalance(stored).balanced).toBe(true);

    expect(await postMoneyJournalEntry({ workspaceId: WS, entry: entries[0] }, deps)).toMatchObject({ ok: true, duplicate: true });
    const altered = { ...entries[0]!, memo: 'different' };
    expect(await postMoneyJournalEntry({ workspaceId: WS, entry: altered }, deps)).toMatchObject({ ok: false, code: 'entry-id-conflict' });
    expect(await readMoneyJournalEntries(WS, deps)).toHaveLength(entries.length);
  });

  it('refuses an entry without its reference before touching the database', async () => {
    const { externalRef: _ref, ...noRef } = entryFor('noref', { kind: 'provider-payment', amountCents: 1 }, { kind: 'bank-transaction', id: 'B' });
    expect(await postMoneyJournalEntry({ workspaceId: WS, entry: noRef }, deps)).toMatchObject({ ok: false, code: 'missing-external-reference' });
    const [{ n }] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.money_journal_entries WHERE entry_id = 'noref'`;
    expect(n).toBe(0);
  });

  it('the database refuses an unbalanced or one-sided entry from a writer that bypasses the module, and refuses edits', async () => {
    await expect(
      db.adminSql.begin(async (tx) => {
        await tx`INSERT INTO harness_shared.money_journal_entries (workspace_id, entry_id, occurred_at, currency, movement, external_ref_kind, external_ref)
                 VALUES (${WS}, 'raw-unbalanced', now(), 'USD', 'provider-payment', 'bank-transaction', 'RAW-1')`;
        await tx`INSERT INTO harness_shared.money_journal_lines (workspace_id, entry_id, line_no, account, side, cents)
                 VALUES (${WS}, 'raw-unbalanced', 0, 'provider-cost', 'debit', 500), (${WS}, 'raw-unbalanced', 1, 'operating', 'credit', 499)`;
      }),
    ).rejects.toThrow(/unbalanced/);
    await expect(
      db.adminSql`INSERT INTO harness_shared.money_journal_entries (workspace_id, entry_id, occurred_at, currency, movement, external_ref_kind, external_ref)
                  VALUES (${WS}, 'raw-empty', now(), 'USD', 'provider-payment', 'bank-transaction', 'RAW-2')`,
    ).rejects.toThrow(/has no debit line/);
    await expect(
      db.adminSql`UPDATE harness_shared.money_journal_lines SET cents = cents + 1 WHERE workspace_id = ${WS} AND entry_id = 'pay-1'`,
    ).rejects.toThrow(/append-only/);
    await expect(
      db.adminSql`INSERT INTO harness_shared.money_journal_lines (workspace_id, entry_id, line_no, account, side, cents)
                  VALUES (${WS}, 'pay-1', 9, 'revenue', 'credit', 1)`,
    ).rejects.toThrow(/unbalanced/);
  });

  it('micros roll up outside the journal; settlement moves whole cents in and keeps the residue, exactly', async () => {
    const rollupId = 'per-use:identity-A';
    for (const [i, micros] of [3_333, 3_333, 3_333, 1, 25_001, 4_999].entries()) {
      expect(await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: `nonce-${i}`, micros }, deps)).toMatchObject({ ok: true, duplicate: false });
    }
    // A replayed meter nonce is not double-counted.
    expect(await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'nonce-4', micros: 25_001 }, deps)).toMatchObject({ ok: true, duplicate: true, totalMicros: 40_000 });
    expect(await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'bad', micros: 1.5 }, deps)).toMatchObject({ ok: false, code: 'invalid-micros' });

    const settled = await settleUsageRollup(
      { workspaceId: WS, rollupId, entryId: 'settle-A-1', occurredAtMs: 1_790_000_100_000, externalRef: chainRef(2), daoBasisPoints: 1_000 },
      deps,
    );
    expect(settled).toMatchObject({ ok: true, settledCents: 4, roundingMicros: 0, duplicate: false });
    expect(await settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-A-1', occurredAtMs: 1_790_000_100_000, externalRef: chainRef(2), daoBasisPoints: 1_000 }, deps)).toMatchObject({ ok: true, duplicate: true, settledCents: 0 });

    await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'nonce-9', micros: 9_999 }, deps);
    expect(await settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-A-2', occurredAtMs: 1, externalRef: chainRef(3), daoBasisPoints: 1_000 }, deps)).toMatchObject({ ok: true, settledCents: 0, entry: null });

    const rollup = await readMicrosRollup(WS, rollupId, deps);
    const entries = await readMoneyJournalEntries(WS, deps);
    expect(rollup).toMatchObject({ totalMicros: 49_999, settledCents: 4, roundingMicros: 9_999 });
    const inv = rollupInvariant(entries, rollup!);
    expect(inv).toMatchObject({ holds: true, journalCents: 4 });
    expect(inv.journalCents * MICROS_PER_CENT + inv.roundingMicros).toBe(49_999);
    expect(trialBalance(entries).balanced).toBe(true);
  });

  it('two concurrent settlers never settle the same micros twice', async () => {
    const rollupId = 'per-use:identity-B';
    await accrueUsageMicros({ workspaceId: WS, rollupId, accrualId: 'n1', micros: 123_456 }, deps);
    const [a, b] = await Promise.all([
      settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-B-a', occurredAtMs: 1, externalRef: chainRef(10), daoBasisPoints: 1_000 }, deps),
      settleUsageRollup({ workspaceId: WS, rollupId, entryId: 'settle-B-b', occurredAtMs: 1, externalRef: chainRef(11), daoBasisPoints: 1_000 }, deps),
    ]);
    const cents = [a, b].map((r) => (r.ok ? r.settledCents : -1)).sort((x, y) => x - y);
    expect(cents).toEqual([0, 12]);
    const rollup = await readMicrosRollup(WS, rollupId, deps);
    expect(rollup).toMatchObject({ totalMicros: 123_456, settledCents: 12, roundingMicros: 3_456 });
    expect(rollupInvariant(await readMoneyJournalEntries(WS, deps), rollup!).holds).toBe(true);
  });

  it('every posted entry is chained in the money-journal stream, and an edited entry breaks verification', async () => {
    const source = moneyJournalLedgerSource(WS, deps);
    const report = await verifyLedger(WS, source, deps.ledgerChain!);
    expect(report).toMatchObject({ ok: true, unchainedCount: 0 });
    const entries = await readMoneyJournalEntries(WS, deps);
    const [{ n }] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.ledger_chain_links WHERE workspace_id = ${WS} AND stream_id = 'money-journal'`;
    expect(n).toBe(entries.length);

    // Tamper with history behind the append-only guard: verify must name the break.
    await db.adminSql.unsafe(`
      ALTER TABLE harness_shared.money_journal_entries DISABLE TRIGGER money_journal_entries_append_only_trg;
      UPDATE harness_shared.money_journal_entries SET memo = 'edited' WHERE workspace_id = '${WS}' AND entry_id = 'prov-1';
      ALTER TABLE harness_shared.money_journal_entries ENABLE TRIGGER money_journal_entries_append_only_trg;`);
    const tampered = await verifyLedger(WS, source, deps.ledgerChain!);
    expect(tampered.ok).toBe(false);
    expect(tampered.verdict.ok).toBe(false);
  });
});
