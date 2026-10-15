/** Real roles, transactions, concurrent writers and tenant boundaries (monetization P-004). */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';
import type { HostedServiceContextRunner } from '../workos-lifecycle-postgres';
import { PILOT_COST_CATEGORIES } from './unit-economics';
import { buildHostedUsageStatement, type HostedUsageRecord, type HostedUsageScope } from './usage-statement';
import { PostgresHostedUsageStore, type OpenRouterGenerationBinding } from './usage-store';
import { OpenRouterHostedUsageCollector, createOpenRouterHostedUsageCollector, openRouterUsageRecord, type OpenRouterUsageBinding } from './openrouter-usage';
import { createHostedUsageSource } from './usage-service';
import { settleHostedReservation } from './budget-policy';
import { shadowMonthBounds } from '../../../cupboard/shadow-metering-reader';
import { PostgresHostedBudgetStore, createLockedHostedStripeFundingReader, readLockedHostedBudgetPopulation,
  readLockedHostedStripeFundingPopulation, evaluateLockedHostedPrepaidFunding,
  type HostedBudgetContextReader, type HostedBudgetExecutionGrant, type HostedPrepaidFundingReader } from './budget-store';
import { accrueUsageMicros, postMoneyJournalEntry, readLockedMoneyJournalPopulation } from '../../../cupboard/money-journal-store';
import { addMicrosDecimals, journalEntryForMovement, splitMicrosDecimal } from '../../../cupboard/money-journal';
import { pgPaymentReceiptStore } from '../../../cupboard/payment-receipt-store';
import { receiptCommitment } from '../../../cupboard/payment-receipt';
import { createRoutedModelPort } from '../../../agent-loop/provider-router';
import { runAgentLoop } from '../../../agent-loop/loop';
import { createHostedPrincipal } from '../../hosted-principal';
import { createHostedBillingRuntime } from '../../../endpoint-route/hosted-billing-runtime';
import { createHostedCustomerModelPortFactory } from '../../../workspace-host/hosted-customer-loop-ports';

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
let db: OrgTestDb;
const T = Date.UTC(2026, 9, 2);
const MONTH = '2026-10';
const runService: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> =>
  db.appSql.begin(async tx => {
    await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
    await tx.unsafe('SET LOCAL ROLE hosted_service');
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
const store = () => new PostgresHostedUsageStore(runService);

async function tenant(controlWorkspaceId: string = randomUUID(), organizationId: string = randomUUID(), state: 'active' | 'deleted' = 'active', fixtureDb = db): Promise<HostedUsageScope & { customerWorkspaceId: string }> {
  const customerWorkspaceId = randomUUID();
  await fixtureDb.adminSql`
    INSERT INTO papercusp_auth.organizations (id, external_organization_id, display_name)
    VALUES (${organizationId}::uuid, ${'usage-org-' + organizationId}, 'Usage fixture')
    ON CONFLICT (id) DO NOTHING`;
  await fixtureDb.adminSql`
    INSERT INTO harness_shared.workspace_host_connections (workspace_id, id, target, label, credential_ref, status)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'gcp', 'Usage fixture', 'delegation://fixture/gcp', 'connected')`;
  await fixtureDb.adminSql`
    INSERT INTO harness_shared.workspace_hosts
      (workspace_id, id, name, connection_id, target, scope_label, region, size, image, disk_gib, network, desired_state, observed_state)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, 'Usage fixture', ${customerWorkspaceId},
            'gcp', 'fixture-project', 'us-central1', 'n2-standard-2', 'ubuntu-2404', 40, 'default', 'running', 'running')`;
  await fixtureDb.adminSql`
    INSERT INTO harness_shared.customer_workspaces
      (workspace_id, id, organization_id, workspace_host_id, display_name, state, deleted_at, created_by_principal_kind, created_by_principal_id)
    VALUES (${controlWorkspaceId}, ${customerWorkspaceId}, ${organizationId}, ${customerWorkspaceId},
            'Usage fixture', ${state}, ${state === 'deleted' ? new Date(T) : null}, 'user', 'fixture-user')`;
  return { controlWorkspaceId, organizationId, customerWorkspaceId };
}

function record(scope: HostedUsageScope & { customerWorkspaceId: string }, changes: Partial<HostedUsageRecord> = {}): HostedUsageRecord {
  return {
    ...scope, provider: 'fixture-provider', recordId: randomUUID(), usageId: randomUUID(), revision: 1,
    category: 'compute', payer: 'consumption', occurredAtMs: T, observedAtMs: T,
    quantity: 60, unit: 'seconds', costSource: 'estimate', costMicros: 10_001,
    sourceRef: 'provider-fixture:receipt', ...changes,
  };
}
const read = (scope: HostedUsageScope, asOfMs = T + 1000) => store().readRecords({ scope, month: MONTH, asOfMs });

describe('PostgresHostedUsageStore (real Postgres and hosted_service)', () => {
  beforeAll(async () => {
    db = await createOrgTestDb();
    // A reserved draft cannot auto-apply to the shared workspace. Exercise the
    // exact migration in this disposable database, including its second apply.
    const migrationUrl = new URL('../../../../../../libs/papercusp/libs/db/sql/1351-hosted-usage-receipts.sql.DRAFT', import.meta.url);
    const armedUrl = new URL('../../../../../../libs/papercusp/libs/db/sql/1351-hosted-usage-receipts.sql', import.meta.url);
    let migration: string;
    try { migration = readFileSync(migrationUrl, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      migration = readFileSync(armedUrl, 'utf8');
    }
    await db.adminSql.unsafe(migration);
    await db.adminSql.unsafe(migration);
    let exactMigration: string;
    try { exactMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      exactMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1354-hosted-usage-exact-micros.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(exactMigration); await db.adminSql.unsafe(exactMigration);
    let bindingMigration: string;
    try { bindingMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1355-hosted-openrouter-generation-binding.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      bindingMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1355-hosted-openrouter-generation-binding.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(bindingMigration); await db.adminSql.unsafe(bindingMigration);
    let populationMigration: string;
    try { populationMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1382-hosted-usage-population-lock.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      populationMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1382-hosted-usage-population-lock.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(populationMigration); await db.adminSql.unsafe(populationMigration);
    let grantMigration: string;
    try { grantMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1391-hosted-openrouter-budget-binding.sql.DRAFT', import.meta.url), 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      grantMigration = readFileSync(new URL('../../../../../../libs/papercusp/libs/db/sql/1391-hosted-openrouter-budget-binding.sql', import.meta.url), 'utf8');
    }
    await db.adminSql.unsafe(grantMigration); await db.adminSql.unsafe(grantMigration);
  }, 180_000);
  afterAll(async () => { await db?.cleanup(); });

  async function withPopulationHeld(fn: () => Promise<void>, rollback = false) {
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const sentinel = new Error('usage population rollback');
    const held = runService(async sql => {
      await store().readLockedPopulation(sql); ready(); await released;
      if (rollback) throw sentinel;
    }).catch(error => { if (error !== sentinel) throw error; });
    try { await Promise.race([started, held]); await fn(); }
    finally { release(); await held; }
  }
  const boundedWriter = () => new PostgresHostedUsageStore(fn => runService(async sql => {
    await sql.unsafe("SET LOCAL lock_timeout = '100ms'"); return fn(sql);
  }));

  it('locks an empty local population against real receipt/binding writers and direct SQL until commit', async () => {
    const a = await tenant(); const r = record(a); const b: OpenRouterGenerationBinding = {
      scope: a, generationId: 'gen-' + randomUUID(), payer: 'consumption', isByok: false,
      credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: 'a'.repeat(64),
      occurredAtMs: T, observedAtMs: T, evidenceRef: 'execution:population-binding',
    };
    await runService(async sql => {
      const population = await store().readLockedPopulation(sql);
      expect(population).toEqual({ records: [], openRouterBindings: [] });
      expect(Object.hasOwn(population, 'complete')).toBe(false);
    });
    await withPopulationHeld(async () => {
      await expect(boundedWriter().append(r)).rejects.toMatchObject({ code: '55P03' });
      await expect(boundedWriter().bindOpenRouterGeneration(b)).rejects.toMatchObject({ code: '55P03' });
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`INSERT INTO papercusp_auth.hosted_usage_receipts
          (control_workspace_id, organization_id, customer_workspace_id, provider, record_id,
           usage_id, revision, category, payer, occurred_at_ms, observed_at_ms, quantity,
           unit, cost_source, cost_micros, source_ref)
          VALUES (${a.controlWorkspaceId}, ${a.organizationId}, ${a.customerWorkspaceId}, 'fixture-provider',
            ${r.recordId}, ${r.usageId}, 1, 'compute', 'consumption', ${T}, ${T}, 60, 'seconds', 'estimate', 10001,
            'provider-fixture:receipt')`;
      })).rejects.toMatchObject({ code: '55P03' });
    });
    expect(await store().append(r)).toBe('recorded');
    expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    expect(await read(a)).toHaveLength(2);
  });

  it('retains all providers, scopes, times and revisions beyond the rotating 25-binding batch', async () => {
    const a = await tenant(); const otherOrg = await tenant(a.controlWorkspaceId);
    const otherControl = await tenant();
    const old = record(a, { occurredAtMs: Date.UTC(2026, 7, 1), observedAtMs: Date.UTC(2026, 7, 2),
      costSource: 'unpriced', costMicros: null });
    const future = record(otherOrg, { occurredAtMs: Date.UTC(2026, 10, 1), observedAtMs: Date.UTC(2026, 10, 1),
      costSource: 'provider-billed', costMicros: 0, costMicrosExact: '0.0000001' });
    const revised = { ...future, recordId: randomUUID(), revision: 2, observedAtMs: future.observedAtMs + 1,
      costMicrosExact: '0.0000002' };
    const foreign = record(otherControl, { payer: 'customer-direct' });
    for (const r of [old, future, revised, foreign]) expect(await store().append(r)).toBe('recorded');
    const capturedBindings: OpenRouterGenerationBinding[] = Array.from({ length: 30 }, (_, index) => ({
      scope: index % 2 ? a : otherControl, generationId: 'gen-' + randomUUID(),
      payer: index % 2 ? 'consumption' : 'customer-direct', isByok: index % 2 === 0,
      credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: 'b'.repeat(64),
      occurredAtMs: old.occurredAtMs, observedAtMs: old.observedAtMs,
      evidenceRef: 'execution:population-capture',
    }));
    for (const b of capturedBindings) expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    // The constructor's scoped runner cannot substitute a different transaction.
    const localReader = new PostgresHostedUsageStore(async () => { throw new Error('separate runner must not execute'); });
    const population = await runService(sql => localReader.readLockedPopulation(sql));
    expect(population.records).toEqual(expect.arrayContaining([old, future, revised, foreign]));
    const ids = new Set(capturedBindings.map(b => b.generationId));
    expect(population.openRouterBindings.filter(b => ids.has(b.generationId))).toEqual(expect.arrayContaining(capturedBindings));
    expect(population.openRouterBindings.filter(b => ids.has(b.generationId))).toHaveLength(30);
    const allRows = await db.adminSql`SELECT record_id FROM papercusp_auth.hosted_usage_receipts`;
    expect(population.records.map(r => r.recordId).sort()).toEqual(allRows.map(r => r.record_id).sort());
    expect(Object.isFrozen(population)).toBe(true);
    expect(Object.isFrozen(population.records)).toBe(true);
    expect(Object.isFrozen(population.openRouterBindings)).toBe(true);
    expect(population.records.every(Object.isFrozen)).toBe(true);
    expect(population.openRouterBindings.every(b => Object.isFrozen(b) && Object.isFrozen(b.scope))).toBe(true);
    expect(JSON.stringify(population.records)).not.toMatch(/credential|sha256|FIXTURE_OPENROUTER/);
    expect(Object.hasOwn(population, 'complete')).toBe(false);
  });

  it('reads its own uncommitted binding and releases receipt locks and rows on rollback', async () => {
    const a = await tenant(); const generationId = 'gen-' + randomUUID();
    await expect(runService(async sql => {
      const sameTransaction = new PostgresHostedUsageStore(fn => fn(sql));
      expect(await sameTransaction.bindOpenRouterGeneration({ scope: a, generationId, payer: 'consumption', isByok: false,
        credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: 'c'.repeat(64),
        occurredAtMs: T, observedAtMs: T + 1, evidenceRef: 'execution:uncommitted-binding' })).toBe('recorded');
      const population = await sameTransaction.readLockedPopulation(sql);
      expect(population.openRouterBindings.some(b => b.generationId === generationId)).toBe(true);
      expect(population.records.some(r => r.usageId === generationId)).toBe(true);
      throw new Error('uncommitted population rollback');
    })).rejects.toThrow('uncommitted population rollback');
    expect(await read(a)).toEqual([]);
    const r = record(a);
    await withPopulationHeld(async () => {
      await expect(boundedWriter().append(r)).rejects.toMatchObject({ code: '55P03' });
    }, true);
    expect(await store().append(r)).toBe('recorded');
    expect(await read(a)).toEqual([r]);
  });

  it('includes a writer that commits while the population lock is waiting', async () => {
    const a = await tenant(); const r = record(a);
    let inserted!: () => void; let release!: () => void; let readerPid = 0;
    const started = new Promise<void>(resolve => { inserted = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const writer = runService(async sql => {
      expect(await new PostgresHostedUsageStore(fn => fn(sql)).append(r)).toBe('recorded');
      inserted(); await released;
    });
    let reader: ReturnType<PostgresHostedUsageStore['readLockedPopulation']> | undefined;
    try {
      await Promise.race([started, writer]);
      reader = runService(async sql => {
        const [row] = await sql`SELECT pg_backend_pid() AS pid`; readerPid = row!.pid;
        await sql.unsafe("SET LOCAL statement_timeout = '5s'");
        return store().readLockedPopulation(sql);
      });
      await vi.waitFor(async () => {
        const waiting = await db.adminSql`SELECT pid FROM pg_locks WHERE pid = ${readerPid}
          AND relation = 'papercusp_auth.hosted_usage_receipts'::regclass AND mode = 'ShareLock' AND NOT granted`;
        expect(waiting).toHaveLength(1);
      }, { timeout: 3000, interval: 10 });
      release(); await writer;
      expect((await reader).records).toEqual(expect.arrayContaining([r]));
    } finally { release(); await Promise.allSettled([writer, ...(reader ? [reader] : [])]); }
  });

  it('rejects an autocommit pool whose read locks ended between statements', async () => {
    await expect(store().readLockedPopulation(db.adminSql)).rejects.toThrow('usage population requires one transaction');
  });

  it('rejects stale-snapshot isolation in both the reader and the fixed lock helper', async () => {
    for (const isolation of ['REPEATABLE READ', 'SERIALIZABLE']) {
      for (const readPopulation of [true, false]) {
        await expect(db.appSql.begin(async tx => {
          await tx.unsafe(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
          await tx.unsafe('SET LOCAL ROLE hosted_service');
          if (readPopulation) await store().readLockedPopulation(tx as unknown as Sql);
          else await tx`SELECT papercusp_auth.lock_hosted_usage_population()`;
        })).rejects.toThrow('usage population requires read committed');
      }
    }
  });

  it('restricts the fixed lock helper to hosted_service without widening receipt write privileges', async () => {
    await expect(db.appSql`SELECT papercusp_auth.lock_hosted_usage_population()`).rejects.toMatchObject({ code: '42501' });
    await expect(db.appSql.begin(async tx => {
      await tx.unsafe('SET LOCAL ROLE hosted_app'); await tx`SELECT papercusp_auth.lock_hosted_usage_population()`;
    })).rejects.toMatchObject({ code: '42501' });
    for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE']) {
      const [row] = await db.adminSql`SELECT has_table_privilege('hosted_service',
        'papercusp_auth.hosted_usage_receipts', ${privilege}) AS allowed`;
      expect(row!.allowed).toBe(false);
    }
    const [role] = await runService(async sql => {
      await store().readLockedPopulation(sql); return sql`SELECT current_user AS role`;
    });
    expect(role!.role).toBe('hosted_service');
  });

  it('records an exact receipt once across concurrent deliveries and a new store instance', async () => {
    const scope = await tenant(); const r = record(scope);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().append(r)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    expect(await read(scope)).toEqual([r]);
    expect(await store().append({ ...r, costMicros: 99 })).toBe('replay-mismatch');
    expect(await read(scope)).toEqual([r]);
  });

  it('persists submicro provider charges exactly across concurrent replay, corrections and tenant scopes', async () => {
    const scope = await tenant(); const foreign = await tenant(scope.controlWorkspaceId);
    const a = record(scope, { costSource: 'provider-billed', costMicros: 4999, costMicrosExact: '4999.6' });
    const b = record(scope, { costSource: 'provider-billed', costMicros: 5000, costMicrosExact: '5000.6' });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().append(a)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    expect(await store().append({ ...a, costMicrosExact: '4999.7' })).toBe('replay-mismatch');
    expect(await store().append(b)).toBe('recorded');
    const records = await read(scope); expect(records).toHaveLength(2);
    expect(records.find(r => r.recordId === a.recordId)).toEqual(a);
    const projected = () => read(scope).then(records => buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: true, observedAtMs: T + 1000, maximumAgeMs: 0, evidenceRef: 'fixture:exact-census' }, records }));
    expect((await projected()).consumptionBilled).toMatchObject({ wholeCents: 1, microsExact: '10000.2', roundingMicrosExact: '0.2' });
    expect(await store().append({ ...a, recordId: randomUUID(), revision: 2, observedAtMs: T + 1, costMicrosExact: '4999.3' })).toBe('recorded');
    expect((await projected()).consumptionBilled).toMatchObject({ wholeCents: 0, microsExact: '9999.9' });
    expect(await read(foreign)).toEqual([]);
    const tiny = record(scope, { costSource: 'provider-reported', costMicros: 0, costMicrosExact: '0.' + '0'.repeat(317) + '5' });
    expect(await store().append(tiny)).toBe('recorded');
    expect((await read(scope)).find(r => r.recordId === tiny.recordId)).toEqual(tiny);
    await expect(runService(sql => sql`INSERT INTO papercusp_auth.hosted_usage_receipts
      (control_workspace_id, organization_id, customer_workspace_id, provider, record_id, usage_id,
       revision, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros, source_ref, received_at)
      SELECT control_workspace_id, organization_id, customer_workspace_id, provider, ${randomUUID()}, ${randomUUID()},
        1, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source,
        9007199254740991.1, source_ref, received_at FROM papercusp_auth.hosted_usage_receipts WHERE record_id = ${a.recordId}`))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('serializes conflicting revisions and catches a receipt-id collision across different usage streams', async () => {
    const scope = await tenant(); const r = record(scope);
    const revisions = await Promise.all([store().append(r), store().append({ ...r, recordId: randomUUID(), costMicros: 99 })]);
    expect(revisions.sort()).toEqual(['recorded', 'revision-conflict']);
    expect(await read(scope)).toHaveLength(1);
    const id = randomUUID();
    const races = await Promise.all([
      store().append(record(scope, { recordId: id })), store().append(record(scope, { recordId: id })),
    ]);
    expect(races.sort()).toEqual(['recorded', 'replay-mismatch']);
    expect(await read(scope)).toHaveLength(2);
  });

  it('preserves delayed corrections without summing an estimate and its eventual provider bill', async () => {
    const scope = await tenant(); const estimated = record(scope);
    const billed = { ...estimated, recordId: randomUUID(), revision: 2, observedAtMs: T + 100, costSource: 'provider-billed' as const, costMicros: 20_003 };
    // Deliver the correction first: arrival order does not invent a new usage.
    expect(await store().append(billed)).toBe('recorded');
    expect(await store().append(estimated)).toBe('recorded');
    expect(await read(scope, T + 50)).toEqual([estimated]);
    const records = await read(scope);
    expect(records).toEqual([estimated, billed]);
    const statement = buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: true, observedAtMs: T + 1000, maximumAgeMs: 0, evidenceRef: 'fixture:complete-census' }, records });
    expect(statement.consumptionBilled).toEqual({ micros: 20_003, wholeCents: 2, roundingMicros: 3 });
    expect(statement.lines[0]?.usages).toBe(1);
    expect(statement.lines[0]?.estimatedMicros).toBe(0);
  });

  it('rejects conflicting correction history atomically, including a late downgrade', async () => {
    const scope = await tenant(); const r = record(scope, { costSource: 'provider-reported' });
    await store().append(r);
    for (const change of [
      { category: 'egress' as const }, { payer: 'platform' as const }, { unit: 'bytes' },
      { costSource: 'estimate' as const }, { occurredAtMs: T - 1 }, { observedAtMs: T - 1, occurredAtMs: T - 1 },
    ]) {
      await expect(store().append({ ...r, recordId: randomUUID(), revision: 2, observedAtMs: T + 10, ...change })).rejects.toThrow();
    }
    expect(await read(scope)).toEqual([r]);
  });

  it('filters the full composite scope and rejects a foreign organization/customer pair on write', async () => {
    const a = await tenant(); const b = await tenant(a.controlWorkspaceId); const c = await tenant(randomUUID(), a.organizationId);
    const ra = record(a); const rb = record(b); const rc = record(c);
    await Promise.all([store().append(ra), store().append(rb), store().append(rc)]);
    expect(await read(a)).toEqual([ra]);
    expect(await read({ ...a, customerWorkspaceId: null })).toEqual([ra]);
    expect(await read({ ...a, customerWorkspaceId: b.customerWorkspaceId })).toEqual([]);
    await expect(store().append(record({ ...a, customerWorkspaceId: b.customerWorkspaceId }))).rejects.toMatchObject({ code: '23503' });
    expect(await read(b)).toEqual([rb]); expect(await read(c)).toEqual([rc]);
  });

  it('keeps unknown costs distinct from an explicit zero, with exact safe integer round trips', async () => {
    const scope = await tenant();
    const unknown = record(scope, { costSource: 'unpriced', costMicros: null });
    const zero = record(scope, { costSource: 'provider-billed', costMicros: 0 });
    const maximum = record(scope, { revision: Number.MAX_SAFE_INTEGER, quantity: Number.MAX_SAFE_INTEGER, costMicros: Number.MAX_SAFE_INTEGER });
    await Promise.all([unknown, zero, maximum].map(r => store().append(r)));
    const records = await read(scope);
    expect(records).toEqual(expect.arrayContaining([unknown, zero, maximum]));
    expect(records).toHaveLength(3);
  });

  it('accepts every canonical cost category, including retained disks and external IPs', async () => {
    const scope = await tenant();
    for (const category of PILOT_COST_CATEGORIES) expect(await store().append(record(scope, { category }))).toBe('recorded');
    expect((await read(scope)).map(r => r.category).sort()).toEqual([...PILOT_COST_CATEGORIES].sort());
  });

  it('uses an exclusive UTC month end and hides observations not yet known', async () => {
    const scope = await tenant();
    const before = record(scope, { occurredAtMs: Date.UTC(2026, 8, 30), observedAtMs: T });
    const end = record(scope, { occurredAtMs: Date.UTC(2026, 10, 1), observedAtMs: Date.UTC(2026, 10, 1) });
    const later = record(scope, { observedAtMs: T + 2000 });
    await Promise.all([before, end, later].map(r => store().append(r)));
    expect(await read(scope)).toEqual([]);
    expect(await read(scope, T + 2000)).toEqual([later]);
  });

  it('denies public/app reads and changes while even a privileged writer cannot rewrite history', async () => {
    const scope = await tenant(); const r = record(scope); await store().append(r);
    await expect(db.appSql`SELECT * FROM papercusp_auth.hosted_usage_receipts`).rejects.toMatchObject({ code: '42501' });
    await expect(runService(sql => sql`UPDATE papercusp_auth.hosted_usage_receipts SET cost_micros = 1`)).rejects.toMatchObject({ code: '42501' });
    await expect(db.adminSql`UPDATE papercusp_auth.hosted_usage_receipts SET cost_micros = 1`).rejects.toThrow('append-only');
    await expect(db.adminSql`DELETE FROM papercusp_auth.hosted_usage_receipts`).rejects.toThrow('append-only');
    expect(await read(scope)).toEqual([r]);
  });

  it('refuses unsupported content fields and invalid scope/counter inputs instead of returning a free statement', async () => {
    const scope = await tenant();
    await expect(store().append({ ...record(scope), customerContent: 'private' } as HostedUsageRecord)).rejects.toThrow('unsupported fields');
    await expect(store().append(record(scope, { costSource: 'unpriced', costMicros: 0 }))).rejects.toThrow('unknown cost');
    await expect(read({ ...scope, organizationId: '' })).rejects.toThrow('identifier');
    await expect(read(scope, Number.NaN)).rejects.toThrow('safe integers');
    expect(await read(scope)).toEqual([]);
  });

  it('persists authenticated OpenRouter reports once and replaces corrections using real service transactions', async () => {
    const scope = await tenant(); const foreign = await tenant(scope.controlWorkspaceId);
    const generationId = 'gen-' + randomUUID();
    let binding: OpenRouterUsageBinding = { scope, generationId, payer: 'consumption', isByok: true,
      credentialRef: 'secret-ref:fixture-account', revision: 1, occurredAtMs: T,
      observedAtMs: T + 100, evidenceRef: 'receipt:openrouter-report-1' };
    let cost = 0.0015; let keyReads = 0;
    const collector = new OpenRouterHostedUsageCollector({
      readBinding: async () => binding,
      readCredential: async () => { keyReads++; return 'fixture-account-secret'; },
      fetch: async () => new Response(JSON.stringify({ data: {
        id: generationId, is_byok: true, total_cost: cost, cancelled: true,
        upstream_inference_cost: 9, prompts: ['private fixture content'], api_key: 'private fixture key',
      } })),
      append: r => store().append(r),
    });
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => collector.collect({ scope, generationId })));
    expect(outcomes.filter(o => o.outcome === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(o => o.outcome === 'duplicate')).toHaveLength(7);
    const initial = await read(scope); expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({ usageId: generationId, costSource: 'provider-reported', costMicros: 1500, payer: 'consumption' });
    expect(JSON.stringify(initial)).not.toMatch(/private|secret|prompts|upstream/);
    expect(keyReads).toBe(8);
    expect((await collector.collect({ scope: foreign, generationId })).outcome).toBe('unavailable');
    expect(keyReads).toBe(8); expect(await read(foreign)).toEqual([]);
    cost = 0.002;
    expect((await collector.collect({ scope, generationId })).outcome).toBe('revision-conflict');
    expect(await read(scope)).toEqual(initial);
    binding = { ...binding, revision: 2, observedAtMs: T + 200, evidenceRef: 'receipt:openrouter-report-2' };
    expect((await collector.collect({ scope, generationId })).outcome).toBe('recorded');
    const records = await read(scope); expect(records).toHaveLength(2);
    const result = buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: false, observedAtMs: T + 200, maximumAgeMs: 1000, evidenceRef: 'fixture:partial-census' }, records });
    expect(result.lines[0]).toMatchObject({ usages: 1, reportedMicros: 2000, billedMicros: 0 });
    expect(result.settlementEligible).toBe(false);
  });

  const captured = (scope: OpenRouterGenerationBinding['scope']): OpenRouterGenerationBinding => ({
    scope, generationId: 'gen-' + randomUUID(), payer: 'consumption', isByok: false,
    credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: createHash('sha256').update('execution-key').digest('hex'),
    occurredAtMs: T, observedAtMs: T + 10, evidenceRef: 'execution:bound-generation',
  });
  const bindings = (scope: HostedUsageScope, asOfMs = T + 1000) => store().readOpenRouterBindings({ scope, month: MONTH, asOfMs });

  // Exercise the real admission/dispatch writer with fixture-only authority.
  // This context never installs a production funding or entitlement reader.
  const grantContext: HostedBudgetContextReader = async (_sql, request) => {
    const { startMs, endMs } = shadowMonthBounds(request.month);
    return { scope: request.scope, month: request.month, asOfMs: request.asOfMs, evidenceRef: 'fixture:grant-authority',
      policy: { policyId: 'fixture-grant-policy', revision: 1, budgetKey: request.budgetKey,
        effectiveFromMs: startMs, effectiveUntilMs: endMs, warningBps: 8000 },
      limits: [{ customerWorkspaceId: null, entitlements: { budgets: { [request.budgetKey]: 100 } },
        fundedMicros: 1_000_000, externalSpentMicros: 0, retainedReserveMicros: 0, unreconciled: false }] };
  };
  const budgetStore = () => new PostgresHostedBudgetStore({ run: runService, readContext: grantContext, now: () => T });

  const intent = { provider: 'openrouter', modelId: 'vendor/model' };
  const captureRequest = (scope: OpenRouterGenerationBinding['scope']) => ({ scope, reservationId: randomUUID(),
    month: MONTH, budgetKey: 'consumption.usd_cents', maximumCostMicros: 100_000,
    providerLimitRef: 'fixture:enforced-limit-unverified', asOfMs: T });
  const captureContext = () => ({ modelId: intent.modelId, servedAccount: 'local-fixture-account',
    credentialSha256: createHash('sha256').update('execution-key').digest('hex') });
  const captureOptions = (scope: OpenRouterGenerationBinding['scope']) => ({ budget: budgetStore(),
    request: captureRequest(scope), context: captureContext(), credentialRef: 'env:FIXTURE_OPENROUTER_KEY',
    isByok: false, evidenceRef: 'execution:paused-native-capture', now: () => T });

  async function budgetReportFixture() {
    const scope = await tenant(); const options = captureOptions(scope);
    const generationId = 'gen-' + randomUUID();
    const capture = store().createOpenRouterRequestCapture(options);
    await capture(intent); await capture({ ...intent, response: { id: generationId } });
    const [binding] = await bindings(scope);
    if (!binding) throw new Error('missing fixture generation binding');
    const report = (cost: number | null) => openRouterUsageRecord(binding, { data: {
      id: generationId, is_byok: false, total_cost: cost, final: true, status: 'completed',
    } });
    const history = () => runService(async sql => {
      await sql`SELECT papercusp_auth.lock_hosted_stripe_funding_population('budget-writer')`;
      return (await readLockedHostedBudgetPopulation(sql)).history
        .filter(r => r.reservationId === options.request.reservationId);
    });
    return { scope, options, binding, report, history };
  }

  it('joins an authenticated fractional OpenRouter report to its persisted budget without metadata finality', async () => {
    const f = await budgetReportFixture();
    const collector = new OpenRouterHostedUsageCollector({ readBinding: async () => f.binding,
      readCredential: async () => 'execution-key',
      fetch: async () => new Response('{"data":{"id":"' + f.binding.generationId
        + '","is_byok":false,"total_cost":0.00000025,"final":true,"status":"completed"}}'),
      append: r => store().append(r, { observeOpenRouterBudget: true }) });
    const input = { scope: f.scope, generationId: f.binding.generationId };
    const result = await collector.collect(input);
    expect(result.outcome).toBe('recorded');
    expect(await f.history()).toMatchObject([{ revision: 0 }, { revision: f.binding.revision,
      costSource: 'provider-reported', costMicros: 0, costMicrosExact: '0.25', providerFinal: false }]);
    expect((await collector.collect(input)).outcome).toBe('duplicate');
    expect(await f.history()).toHaveLength(2);
    expect(JSON.stringify(result)).not.toMatch(/budgetGrant|reservationId|credential|execution-key/);
    const correction = openRouterUsageRecord({ ...f.binding, revision: 3, observedAtMs: T + 1500 }, { data: {
      id: f.binding.generationId, is_byok: false, total_cost: 0.0000005,
    } });
    expect(await store().append(correction, { observeOpenRouterBudget: true })).toBe('recorded');
    const corrected = (await f.history()).at(-1)!;
    expect(corrected).toMatchObject({ revision: 3, costMicrosExact: '0.5', maximumCostMicros: 100_000,
      reservationId: f.options.request.reservationId, providerFinal: false });
    expect(settleHostedReservation({ reservedMicros: corrected.maximumCostMicros,
      observedCostMicros: corrected.costMicros, observedCostMicrosExact: corrected.costMicrosExact,
      costSource: corrected.costSource, providerFinal: corrected.providerFinal, evidenceRef: corrected.evidenceRef }))
      .toMatchObject({ state: 'pending', chargedMicros: 0, heldMicros: 100_000, releasedMicros: 0 });
  });

  it.each([null, 0.10000025])('keeps unpriced or overrun OpenRouter report %s non-final', async cost => {
    const f = await budgetReportFixture();
    expect(await store().append(f.report(cost), { observeOpenRouterBudget: true })).toBe('recorded');
    const last = (await f.history()).at(-1);
    expect(last).toMatchObject({ providerFinal: false,
      costSource: cost === null ? 'unpriced' : 'provider-reported', costMicros: cost === null ? null : 100_000 });
    if (cost !== null) expect(last?.costMicrosExact).toBe('100000.25');
    expect(settleHostedReservation({ reservedMicros: last!.maximumCostMicros,
      observedCostMicros: last!.costMicros, observedCostMicrosExact: last!.costMicrosExact,
      costSource: last!.costSource, providerFinal: last!.providerFinal, evidenceRef: last!.evidenceRef }))
      .toMatchObject({ state: 'pending', chargedMicros: 0, heldMicros: 100_000, releasedMicros: 0,
        suspend: cost !== null, ...(cost === null ? {} : { overrunMicrosExact: '0.25' }) });
    // Metadata final/completed labels never produce a provider-billed receipt.
    expect((await f.history()).every(r => r.costSource !== 'provider-billed')).toBe(true);
  });

  it('rolls back the budget observation when the usage receipt conflicts', async () => {
    const f = await budgetReportFixture();
    expect(await store().append(f.report(0.000001))).toBe('recorded');
    expect(await store().append(f.report(0.000002), { observeOpenRouterBudget: true })).toBe('revision-conflict');
    expect(await f.history()).toMatchObject([{ revision: 0 }]);
    expect(await f.history()).toHaveLength(1);
    const records = await read(f.scope);
    expect(records.find(r => r.revision === f.binding.revision)?.costMicros).toBe(1);
  });

  it('rolls back usage when the bound reservation already has a conflicting observation', async () => {
    const f = await budgetReportFixture(); const r = f.report(0.000001);
    await f.options.budget.observe({ scope: f.scope, reservationId: f.options.request.reservationId,
      eventId: 'fixture:competing-observation', revision: r.revision, observedAtMs: r.observedAtMs,
      costSource: 'provider-reported', costMicros: 9, providerFinal: false, evidenceRef: 'fixture:competing-cost' });
    expect(await store().append(r, { observeOpenRouterBudget: true })).toBe('replay-mismatch');
    expect(await read(f.scope)).toHaveLength(1);
    expect(await f.history()).toMatchObject([{ revision: 0 }, { costMicros: 9 }]);
  });

  it('refuses an unbound or foreign report and refuses invoice finality on the report composition', async () => {
    const f = await budgetReportFixture();
    const foreign = await tenant();
    expect(await store().append({ ...f.report(0.000001), ...foreign }, { observeOpenRouterBudget: true }))
      .toBe('replay-mismatch');
    const unbound = { ...f.binding, generationId: 'gen-' + randomUUID() };
    expect(await store().append(openRouterUsageRecord(unbound, { data: {
      id: unbound.generationId, is_byok: false, total_cost: 0.000001,
    } }), { observeOpenRouterBudget: true })).toBe('replay-mismatch');
    await expect(store().append({ ...f.report(0.000001), costSource: 'provider-billed' },
      { observeOpenRouterBudget: true })).rejects.toThrow('invalid OpenRouter budget report');
    expect(await read(f.scope)).toHaveLength(1); expect(await f.history()).toHaveLength(1);
  });

  // Join the PRIVATE channel reader and real runtime/store composition. Only
  // the session, provider and funding authority are fixtures; no production
  // callback, paid credential or customer execution host is installed here.
  async function privateCustomerModel(scope: OpenRouterGenerationBinding['scope'], options: {
    readContext?: HostedBudgetContextReader | null;
    afterReservation?: () => void | Promise<void>;
    run?: HostedServiceContextRunner;
  } = {}) {
    const run = options.run ?? runService;
    const usage = new PostgresHostedUsageStore(run);
    const session = { workspaceId: scope.controlWorkspaceId, userId: 'fixture-private-user',
      activeOrganizationId: scope.organizationId, selectedWorkspaceId: scope.customerWorkspaceId,
      sessionId: randomUUID(), sessionVersion: 1 };
    let revoked = false;
    const channel = vi.fn(async (_signal: AbortSignal) => ({ ok: true as const,
      principal: createHostedPrincipal({ ...session, permissions: revoked ? ['workspace:view'] : ['workspace:operate'] }) }));
    const publicResolver = vi.fn(async () => ({ ok: false as const, reason: 'authority_unavailable' as const }));
    const request = captureRequest(scope);
    const budget = new PostgresHostedBudgetStore({ run, now: () => T,
      readContext: options.readContext === null ? undefined : options.readContext ?? grantContext });
    const admissionBudget: Pick<PostgresHostedBudgetStore, 'executeOnce'> = {
      async executeOnce(input, execute) {
        const result = await budget.executeOnce(input, execute);
        await options.afterReservation?.();
        return result;
      },
    };
    const authorize = vi.fn(async () => ({ request, credentialRef: 'env:FIXTURE_OPENROUTER_KEY',
      isByok: false, evidenceRef: 'fixture:private-channel-authority' }));
    const runtime = await createHostedBillingRuntime({ publicOrigin: 'https://fixture.invalid',
      stripeSecretKeyRef: null, stripeWebhookSecretRef: null, plans: [] }, {
      resolvePrincipal: publicResolver, resolveSecret: async () => 'execution-key', runService: run,
      usageStore: usage, openRouterAdmission: { budget: admissionBudget, authorize, now: () => T },
    });
    const generationId = 'gen-' + randomUUID();
    const wire = vi.fn(async () => {
      // Check from a NEW transaction at the actual provider seam. A mocked
      // executeOnce or an uncommitted hold cannot satisfy this assertion.
      expect(await budget.reserve(request)).toMatchObject({ outcome: 'duplicate',
        receipt: { revision: 0, costMicros: null, providerFinal: false } });
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'response-metadata', id: generationId, modelId: intent.modelId });
        controller.enqueue({ type: 'error', error: 'fixture provider ended after identity' }); controller.close();
      } }) };
    });
    const sdkModel: LanguageModelV3 = { specificationVersion: 'v3', provider: 'fixture',
      modelId: intent.modelId, supportedUrls: {}, doStream: wire,
      async doGenerate() { throw new Error('unused'); } };
    const select = vi.fn(() => null);
    const factory = createHostedCustomerModelPortFactory({ billing: runtime, resolvePrincipal: channel,
      openRouterAccounts: { active: () => ({ accountId: 'local-fixture-account', authMode: 'api-key',
        token: async () => 'execution-key' }), select, onExhausted: () => null },
      createLanguageModel: async () => sdkModel });
    const abort = new AbortController();
    const port = await factory(session, abort.signal);
    const consume = async () => {
      const events = [];
      for await (const event of runAgentLoop({ port, model: 'openrouter/vendor/model', messages: [],
        account: 'untrusted-account-label', ownerId: 'untrusted-owner-label', signal: abort.signal })) events.push(event);
      return events;
    };
    return { session, request, budget, usage, channel, publicResolver, authorize, wire, generationId, select, abort,
      consume, revoke: () => { revoked = true; } };
  }

  it('joins the private customer model factory to committed PG admission and a restart-readable generation binding', async () => {
    const scope = await tenant(); const p = await privateCustomerModel(scope);
    const events = await p.consume();
    expect(p.publicResolver).not.toHaveBeenCalled(); expect(p.select).not.toHaveBeenCalled();
    expect(p.wire).toHaveBeenCalledOnce();
    expect(p.channel).toHaveBeenCalledTimes(5);
    expect(await bindings(scope)).toMatchObject([{ generationId: p.generationId, scope,
      credentialRef: 'env:FIXTURE_OPENROUTER_KEY', budgetGrant: { reservationId: p.request.reservationId } }]);
    expect(await read(scope)).toMatchObject([{ provider: 'openrouter', costSource: 'unpriced', costMicros: null }]);
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(JSON.stringify(events)).not.toMatch(/budgetGrant|reservationId|credentialSha256|execution-key|policyId/);
    const replay = await p.consume();
    expect(replay.at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(p.wire).toHaveBeenCalledOnce();
    expect(await bindings(scope)).toHaveLength(1);
  });

  it('refuses the private customer model when the real PG budget has no funding authority reader', async () => {
    const scope = await tenant(); const p = await privateCustomerModel(scope, { readContext: null });
    expect((await p.consume()).at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(p.wire).not.toHaveBeenCalled(); expect(await bindings(scope)).toEqual([]);
    expect(await db.adminSql`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
      WHERE control_workspace_id = ${scope.controlWorkspaceId} AND organization_id = ${scope.organizationId}`)
      .toEqual([]);
  });

  it('retains the real PG reservation and denies wire I/O when channel authority is revoked after commit', async () => {
    const scope = await tenant(); let revoke!: () => void;
    const p = await privateCustomerModel(scope, { afterReservation: () => revoke() }); revoke = p.revoke;
    expect((await p.consume()).at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(p.wire).not.toHaveBeenCalled(); expect(await bindings(scope)).toEqual([]);
    expect(await p.budget.reserve(p.request)).toMatchObject({ outcome: 'duplicate',
      receipt: { revision: 0, costMicros: null, providerFinal: false } });
  });

  it('serializes competing private customer streams against one real PG funding allowance', async () => {
    const scope = await tenant();
    const limited: HostedBudgetContextReader = async (sql, request) => {
      const context = await grantContext(sql, request);
      return context && { ...context, limits: context.limits.map(limit => ({ ...limit,
        entitlements: { budgets: { [request.budgetKey]: 10 } }, fundedMicros: 100_000 })) };
    };
    const [a, b] = await Promise.all([privateCustomerModel(scope, { readContext: limited }),
      privateCustomerModel(scope, { readContext: limited })]);
    await Promise.all([a.consume(), b.consume()]);
    expect(a.wire.mock.calls.length + b.wire.mock.calls.length).toBe(1);
    expect(await bindings(scope)).toHaveLength(1);
    expect(await db.adminSql`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
      WHERE control_workspace_id = ${scope.controlWorkspaceId} AND organization_id = ${scope.organizationId}`)
      .toHaveLength(1);
  });

  it('cancels a private consumer during a real PG admission read without dispatching after its late commit', async () => {
    const scope = await tenant(); let entered!: () => void; let release!: () => void; let committed!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const saved = new Promise<void>(resolve => { committed = resolve; });
    const p = await privateCustomerModel(scope, { readContext: async (sql, request) => {
      entered(); await gate; return grantContext(sql, request);
    }, afterReservation: () => committed() });
    const events = p.consume();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await started; p.abort.abort();
      const outcome = await Promise.race([events.then(value => ({ completed: true as const, value })),
        new Promise<{ completed: false }>(resolve => { timeout = setTimeout(() => resolve({ completed: false }), 500); })]);
      expect(outcome.completed).toBe(true);
      // The loop must keep an uncertain durable capture visible as an error,
      // including when a parent abort overlaps it (loop.test.ts guards this).
      if (outcome.completed) expect(outcome.value.at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
      expect(p.wire).not.toHaveBeenCalled();
    } finally { clearTimeout(timeout); release(); await events; await saved; }
    expect(await p.budget.reserve(p.request)).toMatchObject({ outcome: 'duplicate',
      receipt: { revision: 0, costMicros: null, providerFinal: false } });
    expect(p.wire).not.toHaveBeenCalled(); expect(await bindings(scope)).toEqual([]);
  });

  // Compose the maintained source readers through the admission Sql. Empty
  // Stripe evidence supplies neither cash backing nor entitlements, so this
  // fixture deliberately returns no allowance, even after a successful census.
  async function lockedPrivateFunding(scope: OpenRouterGenerationBinding['scope'], options: {
    accountMismatch?: boolean;
    organizationMismatch?: boolean;
    cashDrift?: boolean;
    incompleteCensus?: boolean;
    fetchImpl?: typeof fetch;
    inspect?: (sql: Sql) => Promise<void>;
  } = {}) {
    const accountId = 'acct_PrivateSourceFixture';
    const customerId = 'cus_' + randomUUID().replaceAll('-', '');
    await runService(sql => sql`INSERT INTO papercusp_auth.hosted_billing_customers
      (organization_id, stripe_customer_id, livemode) VALUES (${scope.organizationId}::uuid, ${customerId}, true)`);
    const calls: string[] = []; let balanceReads = 0;
    const fetchImpl: typeof fetch = options.fetchImpl ?? (async (url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_live_fixture');
      expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.redirect).toBe('error');
      const path = new URL(String(url)).pathname; calls.push(path);
      let body: unknown;
      if (path === '/v1/account') body = { object: 'account', id: options.accountMismatch ? 'acct_Foreign' : accountId };
      else if (path === '/v1/customers/' + customerId) body = { object: 'customer', id: customerId,
        livemode: true, metadata: { organizationId: options.organizationMismatch ? randomUUID() : scope.organizationId } };
      else if (path === '/v1/balance') body = { object: 'balance', livemode: true,
        available: options.cashDrift && ++balanceReads > 1 ? [{ currency: 'usd', amount: 1 }] : [], pending: [] };
      else if (['/v1/charges', '/v1/refunds', '/v1/disputes', '/v1/balance_transactions'].includes(path))
        body = { object: 'list', data: [], has_more: options.incompleteCensus === true };
      else throw new Error('unexpected private funding fixture path');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'request-id': 'req_PrivateSourceFixture' } });
    });
    const built = createLockedHostedStripeFundingReader({ pool: { controlWorkspaceId: scope.controlWorkspaceId,
      stripeAccountId: accountId }, journalWorkspaceId: 'fixture-private-model-journal',
      policy: { daoBasisPoints: 0, refundReserveBasisPoints: 0 }, maximumAgeMs: 1000 },
    // Stripe evidence is stamped by Date.now(), so use the same real server
    // clock here; the budget fixture's historical T cannot qualify that read.
    { secretKey: 'sk_live_fixture', liveModeAllowed: true, fetchImpl,
      maximumDurationMs: options.fetchImpl ? 150 : 10_000 });
    if (!built.ok) throw new Error('invalid funding fixture');
    let fundingResult: Awaited<ReturnType<typeof built.read>> | undefined; let inspected = false;
    let settled!: () => void; const readSettled = new Promise<void>(resolve => { settled = resolve; });
    const readContext: HostedBudgetContextReader = async (sql, request) => {
      try {
        fundingResult = await built.read(sql, request.scope);
        await options.inspect?.(sql);
        inspected = true;
        return null;
      } finally { settled(); }
    };
    return { readContext, calls, readSettled, result: () => fundingResult, inspected: () => inspected };
  }

  it('joins locked funding, journal, usage and budget populations without turning an empty census into admission', async () => {
    const scope = await tenant(); const prior = captureRequest(scope);
    expect(await budgetStore().reserve(prior)).toMatchObject({ outcome: 'reserved' });
    const liabilityId = randomUUID();
    expect(await accrueUsageMicros({ workspaceId: 'fixture-private-model-journal', rollupId: liabilityId,
      accrualId: liabilityId, micros: 1, microsExact: '1.25' }, { sql: db.adminSql })).toMatchObject({ ok: true });
    const funding = await lockedPrivateFunding(scope, { inspect: async sql => {
      const population = await readLockedHostedBudgetPopulation(sql);
      expect(population.latest).toContainEqual(expect.objectContaining({ reservationId: prior.reservationId,
        costMicros: null, providerFinal: false }));
      const journal = await readLockedMoneyJournalPopulation(sql);
      expect(journal.accruals).toContainEqual(expect.objectContaining({ accrualId: liabilityId, microsExact: '1.25' }));
      expect(journal.rollups).toContainEqual(expect.objectContaining({ rollup: expect.objectContaining({
        rollupId: liabilityId, totalMicrosExact: '1.25' }) }));
      await store().readLockedPopulation(sql);
      // Every source lock survives the remote collection and inspection.
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`UPDATE harness_shared.payment_receipts SET workspace_id = workspace_id WHERE false`;
      })).rejects.toMatchObject({ code: '55P03' });
    } });
    const p = await privateCustomerModel(scope, { readContext: funding.readContext });
    expect((await p.consume()).at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(funding.result()).toMatchObject({ ok: true, payments: [], allocations: [], entries: [] });
    expect(funding.inspected()).toBe(true);
    expect(funding.result()).not.toHaveProperty('cashBacking');
    expect(funding.calls).toContain('/v1/balance');
    expect(p.wire).not.toHaveBeenCalled(); expect(await bindings(scope)).toEqual([]);
    expect(await p.budget.reserve(prior)).toMatchObject({ outcome: 'duplicate' });
    expect(await db.adminSql`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
      WHERE control_workspace_id = ${scope.controlWorkspaceId} AND organization_id = ${scope.organizationId}`)
      .toHaveLength(1);
  });

  it.each(['account', 'organization'] as const)('refuses mismatched Stripe %s identity in the private model admission join', async mismatch => {
    const scope = await tenant(); const funding = await lockedPrivateFunding(scope,
      { accountMismatch: mismatch === 'account', organizationMismatch: mismatch === 'organization' });
    const p = await privateCustomerModel(scope, { readContext: funding.readContext });
    expect((await p.consume()).at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(funding.result()).toMatchObject({ ok: false });
    expect(p.wire).not.toHaveBeenCalled(); expect(await bindings(scope)).toEqual([]);
    expect(await db.adminSql`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
      WHERE control_workspace_id = ${scope.controlWorkspaceId} AND organization_id = ${scope.organizationId}`)
      .toEqual([]);
  });

  it.each(['cash-drift', 'incomplete-census'] as const)('refuses %s while composing locked funding with private admission', async fault => {
    const scope = await tenant(); const funding = await lockedPrivateFunding(scope,
      { cashDrift: fault === 'cash-drift', incompleteCensus: fault === 'incomplete-census' });
    const p = await privateCustomerModel(scope, { readContext: funding.readContext });
    expect((await p.consume()).at(-1)).toMatchObject({ type: 'done', stopReason: 'error' });
    expect(funding.result()).toMatchObject({ ok: false,
      reason: fault === 'cash-drift' ? 'stripe-read-changed' : 'unverified-stripe-read' });
    expect(funding.inspected()).toBe(true);
    expect(p.wire).not.toHaveBeenCalled(); expect(await bindings(scope)).toEqual([]);
    expect(await db.adminSql`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
      WHERE control_workspace_id = ${scope.controlWorkspaceId} AND organization_id = ${scope.organizationId}`)
      .toEqual([]);
  });

  it('bounds private cancellation and retains locked Stripe sources until an abort-ignoring transport settles late', async () => {
    const scope = await tenant(); let entered!: () => void; let release!: () => void; let aborted!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const observedAbort = new Promise<void>(resolve => { aborted = resolve; });
    const funding = await lockedPrivateFunding(scope, { fetchImpl: async (_url, init) => {
      init?.signal?.addEventListener('abort', aborted, { once: true });
      entered(); await gate;
      return new Response(JSON.stringify({ object: 'account', id: 'acct_PrivateSourceFixture' }),
        { status: 200, headers: { 'request-id': 'req_PrivateSourceFixture' } });
    } });
    const p = await privateCustomerModel(scope, { readContext: funding.readContext });
    const events = p.consume(); let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([started, events.then(() => { throw new Error('admission ended before Stripe collection'); })]);
      p.abort.abort();
      const completed = await Promise.race([events.then(() => true),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 500); })]);
      expect(completed).toBe(true);
      await observedAbort;
      await expect(db.adminSql.begin(async tx => {
        await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
        await tx`UPDATE harness_shared.payment_receipts SET workspace_id = workspace_id WHERE false`;
      })).rejects.toMatchObject({ code: '55P03' });
    } finally { clearTimeout(timeout); release(); await events; await funding.readSettled; }
    expect(funding.result()).toMatchObject({ ok: false });
    expect(p.wire).not.toHaveBeenCalled(); expect(await bindings(scope)).toEqual([]);
    await db.adminSql.begin(async tx => {
      await tx.unsafe("SET LOCAL lock_timeout = '1s'");
      await tx`UPDATE harness_shared.payment_receipts SET workspace_id = workspace_id WHERE false`;
    });
    expect(await db.adminSql`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts
      WHERE control_workspace_id = ${scope.controlWorkspaceId} AND organization_id = ${scope.organizationId}`)
      .toEqual([]);
  });

  it.each(['positive', 'no-allocation', 'missing-cash', 'short-cash', 'unknown-reserve', 'fractional-prior-charge',
    'stripe-positive', 'stripe-refund', 'stripe-pending', 'stripe-lineage-mismatch', 'stripe-census-gap', 'stripe-missing-cash',
    'stripe-usage-reported', 'stripe-usage-reported-final', 'stripe-usage-final', 'stripe-usage-final-correction',
    'stripe-usage-final-zero', 'stripe-usage-overrun', 'stripe-usage-key-mismatch', 'stripe-usage-unpriced'] as const)
    ('joins persisted prepaid funding to private model admission with %s fixture authority', async mode => {
      // A separate maintained private DB makes the FULL local populations exact
      // without deleting immutable rows or depending on preceding test order.
      const isolated = await createOrgTestDb();
      const stripeMode = mode.startsWith('stripe-');
      const usageMode = mode.startsWith('stripe-usage-');
      // The maintained HTTP reader stamps Date.now(). Keep its source clock
      // identical to the admission fixture, without changing timers or dates.
      const sourceClock = stripeMode ? vi.spyOn(Date, 'now').mockReturnValue(T) : null;
      try {
        const run: HostedServiceContextRunner = <T>(fn: (sql: Sql) => Promise<T>): Promise<T> => isolated.appSql.begin(async tx => {
          await tx`SELECT set_config('app.workspace_id', 'hosted-control-plane-service', true)`;
          await tx.unsafe('SET LOCAL ROLE hosted_service'); return fn(tx as unknown as Sql);
        }) as Promise<T>;
        const scope = await tenant(randomUUID(), randomUUID(), 'active', isolated);
        const accountId = 'acct_' + randomUUID().replaceAll('-', '');
        const customerId = 'cus_' + randomUUID().replaceAll('-', '');
        const journalWorkspaceId = 'fixture-' + randomUUID();
        const transaction = { id: 'txn_' + randomUUID().replaceAll('-', ''), amount: 10,
          fee: 0, currency: 'usd', created: T / 1000 };
        const payment = journalEntryForMovement({ entryId: 'stripe-bt:' + transaction.id,
          occurredAtMs: T, currency: 'USD', externalRef: { kind: 'stripe-balance-transaction', id: transaction.id },
          movement: { kind: 'credit-purchase', grossCents: 10, feeCents: 0, taxCents: 0 } });
        const capital = journalEntryForMovement({ entryId: 'fixture-capital', occurredAtMs: T,
          currency: 'USD', externalRef: { kind: 'stripe-balance-transaction', id: 'txn_FixtureCapital' },
          movement: { kind: 'customer-payment', grossCents: 1, feeCents: 0, taxCents: 0,
            daoCents: 0, refundReserveCents: 0 } });
        if (!payment.ok) throw new Error('payment fixture: ' + payment.detail);
        if (!capital.ok) throw new Error('capital fixture: ' + capital.detail);
        for (const entry of [payment.entry, capital.entry]) expect(await postMoneyJournalEntry(
          { workspaceId: journalWorkspaceId, entry }, { sql: isolated.adminSql, ledgerChain: null })).toMatchObject({ ok: true });
        const salt = 'c'.repeat(64);
        expect(await pgPaymentReceiptStore(isolated.adminSql).insertMissing(journalWorkspaceId, [{ transaction, salt,
          commitment: receiptCommitment(transaction, salt), sourceId: 'ch_Fixture', sourceCustomer: customerId }])).toBe(1);
        const capitalTransaction = { ...transaction, id: 'txn_FixtureCapital', amount: 1 };
        if (stripeMode) expect(await pgPaymentReceiptStore(isolated.adminSql).insertMissing(journalWorkspaceId,
          [{ transaction: capitalTransaction, salt, commitment: receiptCommitment(capitalTransaction, salt),
            sourceId: 'ch_Capital', sourceCustomer: customerId }])).toBe(1);
        await run(sql => sql`INSERT INTO papercusp_auth.hosted_billing_customers
          (organization_id, stripe_customer_id, livemode) VALUES (${scope.organizationId}::uuid, ${customerId}, true)`);
        expect(await accrueUsageMicros({ workspaceId: journalWorkspaceId, rollupId: 'fixture-liability',
          accrualId: 'fixture-liability', micros: 1, microsExact: '1.25' }, { sql: isolated.adminSql })).toMatchObject({ ok: true });

        let fault = false; let expectedLiability = '1.25';
        const refundTransaction = { ...transaction, id: 'txn_FixtureRefund', amount: -1 };
        const calls: string[] = [];
        const fundingResults: Awaited<ReturnType<Extract<ReturnType<typeof createLockedHostedStripeFundingReader>,
          { ok: true }>['read']>>[] = [];
        const charge = (id: string, tx: typeof transaction, prepaid: boolean) => ({ object: 'charge', id,
          customer: customerId, livemode: true, currency: 'usd', status: 'succeeded', paid: true, captured: true,
          amount: tx.amount, amount_captured: tx.amount, amount_refunded: fault && mode === 'stripe-refund' && prepaid ? 1 : 0,
          balance_transaction: tx.id, failure_balance_transaction: null, created: tx.created,
          metadata: prepaid ? { purpose: 'prepaid-credits' } : {}, invoice: null });
        const movement = (tx: typeof transaction, source: Record<string, unknown>, type: string) => ({
          ...tx, object: 'balance_transaction', type, net: tx.amount - tx.fee, available_on: tx.created,
          status: fault && mode === 'stripe-pending' && tx.id === transaction.id ? 'pending' : 'available', source });
        const refund = { object: 'refund', id: 're_Fixture', charge: 'ch_Fixture', customer: customerId,
          currency: 'usd', amount: 1, status: 'succeeded', created: transaction.created,
          balance_transaction: refundTransaction.id, failure_balance_transaction: null };
        const built = stripeMode ? createLockedHostedStripeFundingReader({
          pool: { controlWorkspaceId: scope.controlWorkspaceId, stripeAccountId: accountId }, journalWorkspaceId,
          policy: { daoBasisPoints: 0, refundReserveBasisPoints: 0 }, maximumAgeMs: 1000,
        }, { secretKey: 'sk_live_fixture', liveModeAllowed: true, now: () => T, fetchImpl: async (url, init) => {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer sk_live_fixture');
          expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
          const path = new URL(String(url)).pathname; calls.push(path);
          const original = charge('ch_Fixture', transaction, true);
          const revenue = charge('ch_Capital', capitalTransaction, false);
          const originalMovement = movement(transaction, original, 'charge');
          const revenueMovement = movement(capitalTransaction, revenue, 'charge');
          const refundMovement = movement(refundTransaction, refund, 'refund');
          let body: unknown;
          if (path === '/v1/account') body = { object: 'account', id: accountId };
          else if (path === '/v1/customers/' + customerId) body = { object: 'customer', id: customerId,
            livemode: true, metadata: { organizationId: scope.organizationId } };
          else if (path === '/v1/balance') body = { object: 'balance', livemode: true,
            available: [{ currency: 'usd', amount: fault && mode === 'stripe-pending' ? 1 : fault && mode === 'stripe-refund' ? 10 : 11 }],
            pending: fault && mode === 'stripe-pending' ? [{ currency: 'usd', amount: 10 }] : [] };
          else if (path === '/v1/charges') body = { object: 'list', data: [original, revenue], has_more: false };
          else if (path === '/v1/refunds') body = { object: 'list', data: fault && mode === 'stripe-refund' ? [refund] : [], has_more: false };
          else if (path === '/v1/disputes') body = { object: 'list', data: [], has_more: false };
          else if (path === '/v1/balance_transactions') body = { object: 'list', data: [originalMovement, revenueMovement,
            ...(fault && mode === 'stripe-refund' ? [refundMovement] : [])], has_more: false };
          else if (path === '/v1/charges/ch_Fixture') body = original;
          else if (path === '/v1/charges/ch_Capital') body = revenue;
          else if (path === '/v1/refunds/re_Fixture') body = refund;
          else if (path === '/v1/balance_transactions/' + transaction.id) body = fault && mode === 'stripe-lineage-mismatch'
            ? { ...originalMovement, source: 'ch_Foreign' } : originalMovement;
          else if (path === '/v1/balance_transactions/' + capitalTransaction.id) body = revenueMovement;
          else if (path === '/v1/balance_transactions/' + refundTransaction.id) body = refundMovement;
          else throw new Error('unexpected positive Stripe fixture path: ' + path);
          return new Response(JSON.stringify(body), { headers: { 'request-id': 'req_PositiveFixture' } });
        } }) : null;
        if (built && !built.ok) throw new Error('invalid positive Stripe fixture');
        const readFunding: HostedPrepaidFundingReader = async (sql, request) => {
          const population = await readLockedHostedStripeFundingPopulation(sql, {
            pool: { controlWorkspaceId: scope.controlWorkspaceId, stripeAccountId: accountId }, journalWorkspaceId });
          const journal = await readLockedMoneyJournalPopulation(sql);
          const usage = await new PostgresHostedUsageStore(run).readLockedPopulation(sql);
          const budget = await readLockedHostedBudgetPopulation(sql);
          expect(population.customers).toEqual([{ organizationId: scope.organizationId, stripeCustomerId: customerId, livemode: true }]);
          const hasRefund = fault && ['stripe-refund', 'stripe-census-gap'].includes(mode);
          expect(population.receipts).toHaveLength(stripeMode ? hasRefund ? 3 : 2 : 1);
          expect(journal.entries).toHaveLength(hasRefund ? 3 : 2);
          const liability = splitMicrosDecimal(addMicrosDecimals(...journal.rollups.map(r =>
            r.rollup.roundingMicrosExact ?? String(r.rollup.roundingMicros))));
          expect(liability.exact).toBe(expectedLiability);
          // This fixture owns every row and assigns each generation to its
          // reservation, including its later observations. A production no-overlap/provider census
          // needs independently authenticated joins, never these local labels.
          for (const binding of usage.openRouterBindings) expect(budget.latest).toContainEqual(expect.objectContaining({
            reservationId: binding.budgetGrant?.reservationId,
            ...(usageMode ? {} : { costMicros: null, providerFinal: false }) }));
          const collected = built?.ok ? await built.read(sql, scope) : null;
          if (collected) {
            fundingResults.push(collected);
            if (!collected.ok) return null;
            expect(collected.payments).toHaveLength(1); // The second charge is revenue, never prepaid credit.
            expect(collected).not.toHaveProperty('cashBacking');
            // The authenticated HTTP parser/collector still runs against owned
            // responses. Independent cash and provider/no-overlap joins below
            // remain explicit fixtures, rather than inferred Stripe authority.
            await expect(isolated.adminSql.begin(async tx => {
              await tx.unsafe("SET LOCAL lock_timeout = '100ms'");
              await tx`UPDATE harness_shared.payment_receipts SET workspace_id = workspace_id WHERE false`;
            })).rejects.toMatchObject({ code: '55P03' });
          }
          const { startMs } = shadowMonthBounds(request.month);
          return { scope, budgetKey: request.allocation.budgetKey, windowStartMs: startMs, asOfMs: request.asOfMs,
            snapshot: collected?.ok ? collected.snapshot : { controlWorkspaceId: scope.controlWorkspaceId, organizationId: scope.organizationId,
              stripeAccountId: accountId, stripeCustomerId: customerId, livemode: true, complete: true,
              asOfMs: request.asOfMs, evidenceRef: 'fixture:source-census-not-provider-authority' },
            payments: collected?.ok ? collected.payments : [{ entry: population.entries.find(e => e.entryId === payment.entry.entryId)!,
              receipt: population.receipts[0]!, available: true }], reversals: collected?.ok ? collected.reversals : [],
            priorCharges: fault && mode === 'fractional-prior-charge' ? [{ chargeId: 'fixture-prior',
              organizationId: scope.organizationId, customerWorkspaceId: scope.customerWorkspaceId,
              budgetKey: request.allocation.budgetKey, periodEndMs: startMs, costSource: 'provider-billed',
              providerFinal: true, micros: 0, microsExact: '0.25' }] : [],
            cashBacking: fault && ['missing-cash', 'stripe-missing-cash'].includes(mode) ? null : {
              controlWorkspaceId: scope.controlWorkspaceId, stripeAccountId: accountId, asOfMs: request.asOfMs,
              livemode: true, complete: true, evidenceRef: 'fixture:independent-cash-not-bank-authority',
              journalEntries: journal.entries.map(e => e.entry), availableMicros: usageMode ? 100_002 : 100_001,
              availableMicrosExact: usageMode ? '100002' : fault && mode === 'short-cash' ? '100001' : '100001.25',
              unpaidProviderMicros: liability.micros, unpaidProviderMicrosExact: liability.exact,
              retainedReserveMicros: fault && mode === 'unknown-reserve' ? null : 0 } };
        };
        const allocation = { allocationId: randomUUID(), paymentTransactionId: transaction.id,
          organizationId: scope.organizationId, customerWorkspaceId: scope.customerWorkspaceId,
          budgetKey: 'consumption.usd_cents', micros: 100_000 };
        const allocationRequest = { scope, stripeAccountId: accountId, allocation, month: MONTH, asOfMs: T };
        const prepaid = new PostgresHostedBudgetStore({ run, readPrepaidFunding: readFunding, now: () => T });
        if (mode !== 'no-allocation') expect(await prepaid.allocatePrepaid(allocationRequest)).toMatchObject({
          outcome: 'allocated', funding: { organization: { fundedMicros: 100_000 }, workspace: { fundedMicros: 100_000 } } });
        if (['stripe-refund', 'stripe-census-gap'].includes(mode)) {
          const reversal = journalEntryForMovement({ entryId: 'stripe-bt:' + refundTransaction.id,
            occurredAtMs: T, currency: 'USD', externalRef: { kind: 'stripe-balance-transaction', id: refundTransaction.id },
            movement: { kind: 'refund', amountCents: 1, taxCents: 0 } });
          if (!reversal.ok) throw new Error('refund fixture: ' + reversal.detail);
          expect(await postMoneyJournalEntry({ workspaceId: journalWorkspaceId, entry: reversal.entry },
            { sql: isolated.adminSql, ledgerChain: null })).toMatchObject({ ok: true });
          expect(await pgPaymentReceiptStore(isolated.adminSql).insertMissing(journalWorkspaceId,
            [{ transaction: refundTransaction, salt, commitment: receiptCommitment(refundTransaction, salt),
              sourceId: 're_Fixture', sourceCustomer: customerId }])).toBe(1);
        }
        fault = true;
        const readContext: HostedBudgetContextReader = async (sql, request) => {
          const evidence = await readFunding(sql, { ...allocationRequest, asOfMs: request.asOfMs });
          if (!evidence) return null;
          const funding = await evaluateLockedHostedPrepaidFunding(sql, evidence);
          if (!funding.ok) return null;
          const context = await grantContext(sql, request);
          return context && { ...context, evidenceRef: funding.evidenceRef,
            limits: [{ ...context.limits[0]!, ...funding.organization },
              ...(funding.workspace ? [{ ...context.limits[0]!, customerWorkspaceId: scope.customerWorkspaceId,
                ...funding.workspace }] : [])] };
        };
        const a = await privateCustomerModel(scope, { run, readContext });
        const b = await privateCustomerModel(scope, { run, readContext });
        await Promise.all([a.consume(), b.consume()]);
        const expected = usageMode || ['positive', 'stripe-positive'].includes(mode) ? 1 : 0;
        expect(a.wire.mock.calls.length + b.wire.mock.calls.length).toBe(expected);
        expect(await a.usage.readOpenRouterBindings({ scope, month: MONTH, asOfMs: T + 1000 })).toHaveLength(expected);
        expect(await isolated.adminSql`SELECT reservation_id FROM papercusp_auth.hosted_budget_receipts`).toHaveLength(expected);
        expect(await isolated.adminSql`SELECT allocation_id FROM papercusp_auth.hosted_prepaid_allocations`)
          .toHaveLength(mode === 'no-allocation' ? 0 : 1);
        if (stripeMode) {
          expect(fundingResults[0]).toMatchObject({ ok: true, payments: [{ available: true }], reversals: [] });
          if (mode === 'stripe-refund') {
            expect(fundingResults.at(-1)).toMatchObject({ ok: true, reversals: [{ paymentTransactionId: transaction.id }] });
            expect(calls).toContain('/v1/refunds/re_Fixture');
          } else if (mode === 'stripe-pending') expect(fundingResults.at(-1)).toMatchObject({ ok: true, payments: [{ available: false }] });
          else if (mode === 'stripe-lineage-mismatch') expect(fundingResults.at(-1)).toMatchObject({ ok: false, reason: 'unverified-stripe-read' });
          else if (mode === 'stripe-census-gap') expect(fundingResults.at(-1)).toMatchObject({ ok: false, reason: 'unreconciled-stripe-movement' });
          else expect(fundingResults.at(-1)).toMatchObject({ ok: true });
          expect(calls).toContain('/v1/balance_transactions/' + transaction.id);
        }
        if (expected) {
          const winner = a.wire.mock.calls.length ? a : b;
          await winner.consume(); expect(winner.wire).toHaveBeenCalledOnce();
          expect(await winner.budget.reserve(winner.request)).toMatchObject({ outcome: 'duplicate',
            receipt: { revision: 0, costMicros: null, providerFinal: false } });
          if (usageMode) {
            // Recover the private admission from a NEW store, then use the
            // maintained HTTP collector. Nothing in /generation certifies a
            // final invoice, even when a caller labels that report final.
            const freshUsage = new PostgresHostedUsageStore(run);
            const [binding] = await freshUsage.readOpenRouterBindings({ scope, month: MONTH, asOfMs: T });
            expect(binding?.budgetGrant).toMatchObject({ scope, reservationId: winner.request.reservationId });
            const generationId = winner.generationId;
            let providerCalls = 0;
            const reportedCost = mode === 'stripe-usage-unpriced' ? 'null'
              : mode === 'stripe-usage-overrun' ? '0.10000025'
                : mode === 'stripe-usage-final-zero' ? '0' : '0.00000025';
            const collector = new OpenRouterHostedUsageCollector({
              readBinding: async (requested, id) => {
                expect(requested).toEqual(scope); expect(id).toBe(generationId); return binding ?? null;
              },
              readCredential: async reference => {
                expect(reference).toBe(binding?.credentialRef);
                return mode === 'stripe-usage-key-mismatch' ? 'other-account-key' : 'execution-key';
              },
              fetch: async (url, init) => {
                providerCalls++;
                expect(new URL(String(url)).searchParams.get('id')).toBe(generationId);
                expect(init).toMatchObject({ method: 'GET', redirect: 'error', cache: 'no-store',
                  headers: { Authorization: 'Bearer execution-key' } });
                return new Response('{"data":{"id":"' + generationId + '","is_byok":false,"total_cost":'
                  + reportedCost + ',"upstream_inference_cost":99,"prompt":"private fixture"}}');
              },
              append: r => freshUsage.append(r),
            });
            const collected = await collector.collect({ scope, generationId });
            const budget = new PostgresHostedBudgetStore({ run, readContext, now: () => T });
            const nextRequest = { ...winner.request, reservationId: randomUUID(), maximumCostMicros: 1 };
            if (mode === 'stripe-usage-key-mismatch') {
              expect(collected).toEqual({ outcome: 'unavailable', reason: 'credential-mismatch' });
              expect(providerCalls).toBe(0);
              expect(await budget.reserve(winner.request)).toMatchObject({ outcome: 'duplicate',
                receipt: { revision: 0, costMicros: null, providerFinal: false } });
              expect(await budget.reserve(nextRequest)).toMatchObject({ outcome: 'refused' });
              expect(await freshUsage.readRecords({ scope, month: MONTH, asOfMs: T })).toHaveLength(1);
            } else {
              expect(collected.outcome).toBe('recorded'); expect(providerCalls).toBe(1);
              if (!('record' in collected) || !collected.record) throw new Error('fixture collector omitted its record');
              const report = collected.record;
              expect(report).toMatchObject({ usageId: generationId, revision: 2,
                costSource: mode === 'stripe-usage-unpriced' ? 'unpriced' : 'provider-reported' });
              expect(JSON.stringify(report)).not.toMatch(/private|credential|execution-key|upstream|budgetGrant/);
              const observation = { scope: binding!.budgetGrant!.scope,
                reservationId: binding!.budgetGrant!.reservationId, eventId: report.recordId,
                revision: 1, observedAtMs: report.observedAtMs, costSource: report.costSource,
                costMicros: report.costMicros, costMicrosExact: report.costMicrosExact,
                providerFinal: mode === 'stripe-usage-reported-final', evidenceRef: report.sourceRef };
              const observed = await budget.observe(observation);
              expect(observed).toMatchObject({ outcome: 'recorded', settlement: {
                state: 'pending', chargedMicros: 0, heldMicros: 100_000, releasedMicros: 0,
                suspend: mode === 'stripe-usage-overrun' } });
              if (mode === 'stripe-usage-overrun') expect(observed).toMatchObject({ settlement: { overrunMicrosExact: '0.25' } });
              else if (mode !== 'stripe-usage-unpriced') expect(report).toMatchObject({
                costMicros: 0, ...(mode === 'stripe-usage-final-zero' ? {} : { costMicrosExact: '0.25' }) });
              expect(await budget.observe(observation)).toMatchObject({ outcome: 'duplicate' });
              expect(await budget.observe({ ...observation, scope: { ...scope, customerWorkspaceId: randomUUID() } }))
                .toMatchObject({ outcome: 'unknown', receipt: null });
              const finalMode = ['stripe-usage-final', 'stripe-usage-final-correction', 'stripe-usage-final-zero'].includes(mode);
              if (finalMode) {
                // Explicit trusted-server FINAL BILL FIXTURES, separate from
                // the authenticated-shape reported amount above. They do not
                // install an invoice adapter or grant production authority.
                const costs = mode === 'stripe-usage-final-correction' ? ['0.25', '0.5']
                  : mode === 'stripe-usage-final-zero' ? ['0'] : ['0.25'];
                let previous = '0';
                for (const [index, exact] of costs.entries()) {
                  const cost = splitMicrosDecimal(exact);
                  const final = { ...observation, eventId: 'fixture-invoice:' + randomUUID(), revision: index + 2,
                    costSource: 'provider-billed' as const, costMicros: cost.micros,
                    costMicrosExact: cost.exact.includes('.') ? cost.exact : undefined,
                    providerFinal: true, evidenceRef: 'fixture:independent-final-provider-bill' };
                  expect(await budget.observe(final)).toMatchObject({ outcome: 'recorded', settlement: {
                    state: 'settled', heldMicros: 0, chargedMicros: cost.micros,
                    ...(exact.includes('.') ? { chargedMicrosExact: exact } : {}), suspend: false } });
                  expect(await budget.observe(final)).toMatchObject({ outcome: 'duplicate' });
                  expect(await freshUsage.append({ ...report, recordId: randomUUID(), revision: index + 3,
                    costSource: 'provider-billed', costMicros: cost.micros,
                    costMicrosExact: final.costMicrosExact, sourceRef: final.evidenceRef })).toBe('recorded');
                  if (exact !== '0') {
                    // Append only the exact correction delta to the existing
                    // journal accrual rail; do not double-charge old revisions.
                    const delta = exact === '0.5' && previous === '0.25' ? '0.25' : exact;
                    const amount = splitMicrosDecimal(delta);
                    expect(await accrueUsageMicros({ workspaceId: journalWorkspaceId, rollupId: generationId,
                      accrualId: 'fixture-final:' + index, micros: amount.micros, microsExact: amount.exact },
                    { sql: isolated.adminSql })).toMatchObject({ ok: true });
                  }
                  expectedLiability = addMicrosDecimals('1.25', exact); previous = exact;
                }
                const statement = buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T,
                  source: { complete: false, observedAtMs: T, maximumAgeMs: 0, evidenceRef: 'fixture:partial-provider-population' },
                  records: await freshUsage.readRecords({ scope, month: MONTH, asOfMs: T }) });
                expect(statement.lines[0]).toMatchObject({ usages: 1, billedMicros: 0,
                  ...(previous.includes('.') ? { billedMicrosExact: previous } : {}) });
                expect(statement.settlementEligible).toBe(false);
                const maximum = { ...nextRequest, maximumCostMicros: 100_000 };
                if (previous !== '0') expect(await budget.reserve(maximum)).toMatchObject({ outcome: 'refused' });
                expect(await budget.reserve({ ...maximum, maximumCostMicros: previous === '0' ? 100_000 : 99_999 }))
                  .toMatchObject({ outcome: 'reserved' });
              } else expect(await budget.reserve(nextRequest)).toMatchObject({ outcome: 'refused' });
              expect(await budget.reserve(winner.request)).toMatchObject({ outcome: 'duplicate' });
            }
            expect(winner.wire).toHaveBeenCalledOnce();
            expect(await isolated.adminSql`SELECT allocation_id FROM papercusp_auth.hosted_prepaid_allocations`).toHaveLength(1);
          }
        }
      } finally { sourceClock?.mockRestore(); await isolated.cleanup(); }
    }, 60_000);

  it.each(['error', 'abort-before-wire'] as const)('composes actual native routing with committed admission and early binding on %s', async ending => {
    const scope = await tenant(); const options = captureOptions(scope);
    const abort = new AbortController(); const generationId = 'gen-' + randomUUID(); let wireCalls = 0;
    const sdkModel: LanguageModelV3 = { specificationVersion: 'v3', provider: 'fixture', modelId: 'vendor/model', supportedUrls: {},
      async doGenerate() { throw new Error('unused'); }, async doStream() {
        wireCalls++;
        // This measurement is inside the actual dispatch callback, after the
        // native paused intent: admission must already be durable.
        expect((await budgetStore().reserve(options.request)).outcome).toBe('duplicate');
        return { stream: new ReadableStream({ start(controller) {
          controller.enqueue({ type: 'response-metadata', id: generationId, modelId: intent.modelId });
          controller.enqueue({ type: 'error', error: 'provider failed after generation identity' }); controller.close();
        } }) };
      } };
    const port = createRoutedModelPort({ catalog: null,
      openRouterAccounts: { active: () => ({ accountId: 'local-fixture-account', authMode: 'api-key',
        token: async () => 'execution-key' }), onExhausted: () => null },
      createLanguageModel: async () => sdkModel,
      openRouterRequestCapture: context => store().createOpenRouterRequestCapture({ ...options, context }) });
    const events = [];
    for await (const event of runAgentLoop({ port, model: 'openrouter/vendor/model', messages: [], signal: abort.signal,
      onProviderRequest: async observation => { if (ending === 'abort-before-wire' && !observation.request.response) abort.abort(); } })) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: ending === 'error' ? 'error' : 'aborted', steps: [] });
    expect(wireCalls).toBe(ending === 'error' ? 1 : 0);
    const saved = await bindings(scope);
    if (ending === 'error') {
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ generationId, credentialSha256: createHash('sha256').update('execution-key').digest('hex'),
        budgetGrant: { reservationId: options.request.reservationId } });
    } else expect(saved).toEqual([]);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, providerFinal: false, costMicros: null });
    expect(JSON.stringify(events)).not.toMatch(/budgetGrant|credentialSha256|execution-key|reservationId|policyId/);
    expect(events.flatMap(event => event.type === 'done' ? event.providerRequests ?? [] : [])
      .every(observation => Object.getOwnPropertySymbols(observation).length === 0)).toBe(true);
  });

  it('refuses concurrent use of a request capture closure without reopening its committed hold', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const budget = new PostgresHostedBudgetStore({ run: runService, now: () => T,
      readContext: async (sql, request) => { entered(); await gate; return grantContext(sql, request); } });
    const capture = store().createOpenRouterRequestCapture({ ...options, budget });
    const first = capture(intent).catch(error => error);
    await started;
    await expect(capture(intent)).rejects.toThrow('not resumable');
    release();
    expect(await first).toBeInstanceOf(Error);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, providerFinal: false });
    expect(await read(scope)).toEqual([]);
  });

  it('commits native dispatch intent before a private early binding and preserves an unpriced immutable hold', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    const capture = store().createOpenRouterRequestCapture(options);
    await capture(intent);
    expect((await budgetStore().reserve(options.request)).outcome).toBe('duplicate');
    expect(await read(scope)).toEqual([]);
    const generationId = 'gen-' + randomUUID();
    await capture({ ...intent, response: { id: generationId, modelId: intent.modelId } });
    await capture({ ...intent, response: { id: generationId } });
    const saved = await bindings(scope);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ generationId, credentialSha256: options.context.credentialSha256,
      budgetGrant: { reservationId: options.request.reservationId, maximumCostMicros: 100_000 } });
    expect((await read(scope))[0]).toMatchObject({ costSource: 'unpriced', costMicros: null });
    const replay = await budgetStore().reserve(options.request);
    expect(replay.receipt).toMatchObject({ revision: 0, costMicros: null, providerFinal: false });
    expect(JSON.stringify(await read(scope))).not.toMatch(/budgetGrant|credential|reservationId|local-fixture-account/);
  });

  it('refuses a reused reservation in a new stream and retains a missing-generation hold', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    await store().createOpenRouterRequestCapture(options)(intent);
    await expect(store().createOpenRouterRequestCapture(options)(intent)).rejects.toThrow('not freshly admitted');
    const replay = await budgetStore().reserve(options.request);
    expect(replay).toMatchObject({ outcome: 'duplicate', receipt: { revision: 0, providerFinal: false, costMicros: null } });
    expect(await read(scope)).toEqual([]);
  });

  it.each(['conflict', 'uncertain', 'served-model', 'invalid-id'] as const)('refuses %s identity without rebinding or releasing the admission', async mode => {
    const scope = await tenant(); const options = captureOptions(scope);
    const capture = store().createOpenRouterRequestCapture(options);
    const first = 'gen-' + randomUUID(); await capture(intent);
    await capture({ ...intent, response: { id: first } });
    const next = { ...intent, response: { id: mode === 'conflict' ? 'gen-' + randomUUID() : mode === 'invalid-id' ? 'invalid' : first,
      ...(mode === 'served-model' ? { modelId: 'vendor/other' } : {}) },
      ...(mode === 'uncertain' ? { identityUncertain: true } : {}) };
    await expect(capture(next)).rejects.toThrow();
    await expect(capture({ ...intent, response: { id: first } })).rejects.toThrow('not resumable');
    expect((await bindings(scope)).map(b => b.generationId)).toEqual([first]);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, providerFinal: false });
  });

  it('snapshots server authorization and credential identity before any asynchronous admission', async () => {
    const scope = await tenant(); const base = captureOptions(scope);
    const options = { ...base, request: { ...base.request, scope: { ...scope } } };
    const original = { ...options.request, scope: { ...scope } };
    const hash = options.context.credentialSha256;
    const capture = store().createOpenRouterRequestCapture(options);
    options.request.scope.customerWorkspaceId = randomUUID(); options.request.maximumCostMicros = 1;
    options.context.credentialSha256 = 'b'.repeat(64); options.credentialRef = 'env:OTHER_KEY';
    await capture(intent);
    await capture({ ...intent, response: { id: 'gen-' + randomUUID() } });
    expect((await bindings(scope))[0]).toMatchObject({ credentialRef: 'env:FIXTURE_OPENROUTER_KEY', credentialSha256: hash,
      budgetGrant: { scope, maximumCostMicros: 100_000 } });
    expect((await budgetStore().reserve(original)).outcome).toBe('duplicate');
  });

  it('keeps the admission after a bounded SQL binding failure and never retries the uncertain write', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    const capture = boundedWriter().createOpenRouterRequestCapture(options);
    await capture(intent);
    const observation = { ...intent, response: { id: 'gen-' + randomUUID() } };
    await withPopulationHeld(async () => {
      await expect(capture(observation)).rejects.toMatchObject({ code: '55P03' });
    });
    await expect(capture(observation)).rejects.toThrow('not resumable');
    expect(await read(scope)).toEqual([]);
    expect((await budgetStore().reserve(options.request)).receipt).toMatchObject({ revision: 0, costMicros: null, providerFinal: false });
  });

  it('refuses identity before dispatch intent, unconfigured authority and invalid server clocks', async () => {
    const scope = await tenant(); const options = captureOptions(scope);
    await expect(store().createOpenRouterRequestCapture(options)({ ...intent, response: { id: 'gen-before-admission' } }))
      .rejects.toThrow('dispatch intent');
    const noAuthority = new PostgresHostedBudgetStore({ run: runService, now: () => T });
    await expect(store().createOpenRouterRequestCapture({ ...options, budget: noAuthority })(intent))
      .rejects.toThrow('not freshly admitted');
    const badTime = { ...captureOptions(scope), now: () => T - 1 };
    await expect(store().createOpenRouterRequestCapture(badTime)(intent)).rejects.toThrow('execution time');
    expect((await budgetStore().reserve(badTime.request)).receipt).toMatchObject({ revision: 0, providerFinal: false });
    expect(await read(scope)).toEqual([]);
  });

  async function admittedGrant(scope: OpenRouterGenerationBinding['scope']): Promise<HostedBudgetExecutionGrant> {
    const result = await budgetStore().executeOnce({ scope, reservationId: randomUUID(), month: MONTH,
      budgetKey: 'consumption.usd_cents', maximumCostMicros: 100_000,
      providerLimitRef: 'fixture:opaque-provider-limit', asOfMs: T }, async grant => grant);
    if (result.execution !== 'dispatched') throw new Error('fixture admission was refused');
    return result.value;
  }

  it('joins a real executeOnce admission to one private generation capture, survives restart and excludes the grant from public usage', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    const b = { ...captured(scope), budgetGrant: grant };
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().bindOpenRouterGeneration(b)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    expect((await bindings(scope))[0]?.budgetGrant).toEqual(grant);
    await runService(async sql => {
      const population = await store().readLockedPopulation(sql);
      const saved = population.openRouterBindings.find(x => x.generationId === b.generationId)!;
      expect(saved.budgetGrant).toEqual(grant);
      expect(Object.isFrozen(saved.budgetGrant)).toBe(true);
      expect(Object.isFrozen(saved.budgetGrant!.scope)).toBe(true);
      expect(Object.hasOwn(population, 'complete')).toBe(false);
    });
    const correction = openRouterUsageRecord({ ...b, revision: 2, observedAtMs: T + 20 }, {
      data: { id: b.generationId, is_byok: false, total_cost: 0.0000001 },
    });
    expect(await store().append(correction)).toBe('recorded');
    expect((await bindings(scope))[0]?.budgetGrant).toEqual(grant);
    const records = await read(scope);
    expect(records.at(-1)?.costMicrosExact).toBe('0.1');
    expect(JSON.stringify(records)).not.toMatch(/budgetGrant|reservationId|policyId|providerLimitRef|credential/);
    const statement = buildHostedUsageStatement({ scope, month: MONTH, asOfMs: T + 1000,
      source: { complete: false, observedAtMs: T + 20, maximumAgeMs: 1000, evidenceRef: 'fixture:partial-census' }, records });
    expect(statement.settlementEligible).toBe(false);
    expect(JSON.stringify(statement)).not.toMatch(/budgetGrant|reservationId|policyId|providerLimitRef|credential/);
  });

  it('refuses copied or changed admission fields, foreign tenants, non-consumption payers and execution before admission', async () => {
    const scope = await tenant(); const foreign = await tenant(); const grant = await admittedGrant(scope);
    const b = { ...captured(scope), budgetGrant: grant };
    for (const change of [{ reservationId: randomUUID() }, { month: '2026-11' }, { budgetKey: 'other.usd_cents' },
      { maximumCostMicros: 99_999 }, { providerLimitRef: 'fixture:same-amount-different-limit' },
      { policyId: 'fixture:other-policy' }, { policyRevision: 2 }, { evidenceRef: 'fixture:other-authority' },
      { scope: foreign }]) {
      expect(await store().bindOpenRouterGeneration({ ...b, budgetGrant: { ...grant, ...change } })).toBe('replay-mismatch');
    }
    expect(await store().bindOpenRouterGeneration({ ...b, scope: foreign })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, payer: 'customer-direct' })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, occurredAtMs: T - 1 })).toBe('replay-mismatch');
    expect(await read(scope)).toEqual([]); expect(await read(foreign)).toEqual([]);
  });

  it('serializes two generation captures for one admission across independent generation locks', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    const a = { ...captured(scope), budgetGrant: grant }; const b = { ...captured(scope), budgetGrant: grant };
    expect((await Promise.all([store().bindOpenRouterGeneration(a), store().bindOpenRouterGeneration(b)])).sort())
      .toEqual(['recorded', 'replay-mismatch']);
    const saved = await bindings(scope); expect(saved).toHaveLength(1); expect(saved[0]?.budgetGrant).toEqual(grant);
    expect(await read(scope)).toHaveLength(1);
  });

  it('preserves legacy unjoined bindings and refuses attaching, removing or replacing a grant on replay', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope); const legacy = captured(scope);
    expect(await store().bindOpenRouterGeneration(legacy)).toBe('recorded');
    expect(await store().bindOpenRouterGeneration({ ...legacy, budgetGrant: grant })).toBe('replay-mismatch');
    const b = { ...captured(scope), budgetGrant: grant };
    expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    expect(await store().bindOpenRouterGeneration({ ...b, budgetGrant: undefined })).toBe('replay-mismatch');
    const replacement = await admittedGrant(scope);
    expect(await store().bindOpenRouterGeneration({ ...b, budgetGrant: replacement })).toBe('replay-mismatch');
    const saved = await bindings(scope);
    expect(saved.find(x => x.generationId === legacy.generationId)).not.toHaveProperty('budgetGrant');
    expect(saved.find(x => x.generationId === b.generationId)?.budgetGrant).toEqual(grant);
  });

  it('snapshots private admission fields before the first await and rejects malformed grants before opening a runner', async () => {
    const scope = await tenant(); const original = await admittedGrant(scope);
    const mutable = { ...original, scope: { ...original.scope } };
    const b = { ...captured(scope), budgetGrant: mutable };
    const changing = new PostgresHostedUsageStore(fn => {
      mutable.maximumCostMicros = 1; mutable.scope.customerWorkspaceId = randomUUID(); return runService(fn);
    });
    expect(await changing.bindOpenRouterGeneration(b)).toBe('recorded');
    expect((await bindings(scope))[0]?.budgetGrant).toEqual(original);
    const run = vi.fn(); const malformed = new PostgresHostedUsageStore(fn => { run(); return runService(fn); });
    for (const value of [null, [], { ...original, privateContent: 'secret' }, { ...original, maximumCostMicros: -1 },
      { ...original, policyRevision: 0 }, { ...original, scope: { ...scope, extra: 'secret' } },
      { ...original, month: '2026-13' }]) {
      await expect(malformed.bindOpenRouterGeneration({ ...b, budgetGrant: value } as OpenRouterGenerationBinding))
        .rejects.toThrow();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('enforces the exact admission and one-generation join against direct SQL without widening financial DML grants', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    const a = { ...captured(scope), budgetGrant: grant }; expect(await store().bindOpenRouterGeneration(a)).toBe('recorded');
    const insert = (value: unknown, payer = 'consumption', credential = a.credentialRef) => runService(sql => sql`
      INSERT INTO papercusp_auth.hosted_usage_receipts
        (control_workspace_id, organization_id, customer_workspace_id, provider, record_id, usage_id,
         revision, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros,
         source_ref, openrouter_credential_ref, openrouter_key_sha256, openrouter_is_byok, openrouter_budget_grant)
      VALUES (${scope.controlWorkspaceId}, ${scope.organizationId}, ${scope.customerWorkspaceId}, 'openrouter',
        ${randomUUID()}, ${'gen-' + randomUUID()}, 1, 'inference-fees', ${payer}, ${T}, ${T + 10}, 1, 'generations',
        'unpriced', NULL, 'fixture:direct-capture', ${credential}, ${a.credentialSha256}, false, ${JSON.stringify(value)}::jsonb)`);
    for (const value of [[], { ...grant, maximumCostMicros: 99_999 }, { ...grant, reservationId: randomUUID() },
      { ...grant, scope: { ...scope, customerWorkspaceId: randomUUID() } }, { ...grant, extra: 'content' }]) {
      await expect(insert(value)).rejects.toMatchObject({ code: '23514' });
    }
    await expect(insert(grant, 'customer-direct')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(grant)).rejects.toMatchObject({ code: '23505' });
    await expect(runService(sql => sql`UPDATE papercusp_auth.hosted_usage_receipts SET openrouter_budget_grant = NULL
      WHERE usage_id = ${a.generationId}`)).rejects.toMatchObject({ code: '42501' });
    await expect(runService(sql => sql`DELETE FROM papercusp_auth.hosted_budget_receipts
      WHERE reservation_id = ${grant.reservationId}`)).rejects.toMatchObject({ code: '42501' });
    expect(await read(scope)).toHaveLength(1);
  });

  it('does not bind an uncommitted or rolled-back admission and succeeds only after its durable commit', async () => {
    const scope = await tenant(); const grant = await admittedGrant(scope);
    let ready!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    const b = { ...captured(scope), budgetGrant: { ...grant, reservationId: randomUUID() } };
    const sentinel = new Error('fixture admission rollback');
    const pending = runService(async sql => {
      await sql`INSERT INTO papercusp_auth.hosted_budget_receipts
        SELECT control_workspace_id, organization_id, customer_workspace_id, ${b.budgetGrant.reservationId},
          ${'admission:' + b.budgetGrant.reservationId}, revision, month, budget_key, maximum_cost_micros,
          provider_limit_ref, request_hash, policy_id, policy_revision, observed_at_ms, cost_source,
          cost_micros, provider_final, evidence_ref, received_at
        FROM papercusp_auth.hosted_budget_receipts WHERE reservation_id = ${grant.reservationId} AND revision = 0`;
      ready(); await released; throw sentinel;
    }).catch(error => { if (error !== sentinel) throw error; });
    try {
      await Promise.race([started, pending]);
      expect(await store().bindOpenRouterGeneration(b)).toBe('replay-mismatch');
    } finally { release(); await pending; }
    expect(await store().bindOpenRouterGeneration(b)).toBe('replay-mismatch');
    const actual = { ...captured(scope), budgetGrant: grant };
    expect(await store().bindOpenRouterGeneration(actual)).toBe('recorded');
  });

  it('durably binds once across concurrent execution receipts, survives restart and excludes private metadata from public records', async () => {
    const scope = await tenant(); const b = captured(scope);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => store().bindOpenRouterGeneration(b)));
    expect(outcomes.filter(x => x === 'recorded')).toHaveLength(1);
    expect(outcomes.filter(x => x === 'duplicate')).toHaveLength(7);
    const stored = await read(scope); expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ usageId: b.generationId, costSource: 'unpriced', costMicros: null, revision: 1 });
    expect(JSON.stringify(stored)).not.toMatch(/credential|sha256|execution-key|FIXTURE_OPENROUTER/);
    expect(await bindings(scope)).toEqual([{ ...b, revision: 2, observedAtMs: T + 1000, evidenceRef: 'openrouter:metadata-read' }]);
    const changed = { ...b, credentialSha256: createHash('sha256').update('other-account').digest('hex') };
    expect(await store().bindOpenRouterGeneration(changed)).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, credentialRef: 'env:OTHER_ACCOUNT' })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, isByok: true })).toBe('replay-mismatch');
    expect(await store().bindOpenRouterGeneration({ ...b, payer: 'customer-direct' })).toBe('replay-mismatch');
    expect(await read(scope)).toEqual(stored);
  });

  it('prevents global generation reassignment across racing tenants and hides foreign/time/month bindings', async () => {
    const a = await tenant(randomUUID(), randomUUID(), 'deleted'); const otherOrg = await tenant(a.controlWorkspaceId);
    // Preserve the real one-live-workspace guard. A historical deleted row is
    // enough to exercise same-org foreign-workspace binding reads.
    const otherWorkspace = await tenant(a.controlWorkspaceId, a.organizationId); const otherControl = await tenant();
    const b = captured(a);
    const outcomes = await Promise.all([store().bindOpenRouterGeneration(b), store().bindOpenRouterGeneration({ ...b, scope: otherOrg })]);
    expect(outcomes.sort()).toEqual(['recorded', 'replay-mismatch']);
    const winner = (await read(a)).length ? a : otherOrg; const loser = winner === a ? otherOrg : a;
    expect(await bindings(loser)).toEqual([]); expect(await bindings(otherWorkspace)).toEqual([]);
    expect(await bindings(otherControl)).toEqual([]); expect(await bindings(winner, T + 9)).toEqual([]);
    expect(await store().readOpenRouterBindings({ scope: winner, month: '2026-11', asOfMs: T + 1000 })).toEqual([]);
    expect(await bindings({ ...winner, customerWorkspaceId: null })).toHaveLength(1);
    const report = record(loser, { provider: 'openrouter', usageId: b.generationId, revision: 2,
      category: 'inference-fees', quantity: 1, unit: 'generations', costSource: 'provider-reported' });
    expect(await store().append(report)).toBe('replay-mismatch'); expect(await read(loser)).toEqual([]);
  });

  it('collects through a new store instance, keeps exact corrections, and refuses changed keys before provider reads', async () => {
    const scope = await tenant(); const b = captured(scope); await store().bindOpenRouterGeneration(b);
    let key = 'other-key'; let calls = 0; let cost = '0.001234560000000000001';
    const fresh = store();
    const source = createHostedUsageSource({ store: fresh, maximumAgeMs: 1000, collectors: [createOpenRouterHostedUsageCollector({
      store: fresh, readCredential: async () => key, fetch: async () => {
        calls++;
        return new Response('{"data":{"id":"' + b.generationId + '","is_byok":false,"total_cost":' + cost + ',"prompt":"private"}}');
      },
    })] });
    const input = { scope, month: MONTH, asOfMs: T + 1000 };
    expect((await source(input)).lines[0]).toMatchObject({ unpricedUsages: 1, reportedMicros: 0 });
    expect(calls).toBe(0); expect(await read(scope)).toHaveLength(1);
    key = 'execution-key';
    const first = await source(input); expect(first.lines[0]).toMatchObject({ usages: 1, reportedMicrosExact: '1234.560000000000001' });
    expect(first.settlementEligible).toBe(false); expect(first.forecast.unavailableReason).toBe('incomplete-source');
    expect(JSON.stringify(first)).not.toMatch(/private|credential|execution-key|FIXTURE_OPENROUTER/);
    expect((await bindings(scope))[0]?.revision).toBe(3);
    cost = '0.0000001';
    const correction = await source({ ...input, asOfMs: T + 2000 });
    expect(correction.lines[0]).toMatchObject({ usages: 1, reportedMicrosExact: '0.1', billedMicros: 0 });
    expect(await bindings(scope, T + 1000)).toEqual([]); // Newer committed report cannot reuse its old revision.
    expect(await read(scope, T + 2000)).toHaveLength(3); expect(calls).toBe(2);
  });

  it('rejects malformed durable bindings and SQL bypasses of the private binding constraint', async () => {
    const scope = await tenant(); const b = captured(scope);
    for (const change of [{ credentialRef: 'raw-key-value' }, { credentialSha256: 'not-a-fingerprint' },
      { credentialRef: 'env:KEY\nInjected' }, { generationId: 'not-a-generation' }, { revision: 7 }, { customerContent: 'private' }]) {
      await expect(store().bindOpenRouterGeneration({ ...b, ...change } as OpenRouterGenerationBinding)).rejects.toThrow(/binding/);
    }
    await store().bindOpenRouterGeneration(b);
    const rows = await runService(sql => sql`SELECT openrouter_credential_ref, openrouter_key_sha256, openrouter_is_byok
      FROM papercusp_auth.hosted_usage_receipts WHERE usage_id = ${b.generationId}`);
    expect(rows[0]).toMatchObject({ openrouter_credential_ref: b.credentialRef, openrouter_key_sha256: b.credentialSha256, openrouter_is_byok: false });
    await expect(runService(sql => sql`INSERT INTO papercusp_auth.hosted_usage_receipts
      (control_workspace_id, organization_id, customer_workspace_id, provider, record_id, usage_id,
       revision, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros, source_ref,
       openrouter_credential_ref, openrouter_key_sha256, openrouter_is_byok)
      SELECT control_workspace_id, organization_id, customer_workspace_id, provider, ${randomUUID()}, ${'gen-' + randomUUID()},
        1, category, payer, occurred_at_ms, observed_at_ms, quantity, unit, cost_source, cost_micros, source_ref,
        openrouter_credential_ref, NULL, openrouter_is_byok
      FROM papercusp_auth.hosted_usage_receipts WHERE usage_id = ${b.generationId}`)).rejects.toMatchObject({ code: '23514' });
  });
  it('bounds provider-read batches and rotates oldest observations without asserting full census', async () => {
    const scope = await tenant();
    const population = Array.from({ length: 27 }, () => captured(scope));
    for (const b of population) expect(await store().bindOpenRouterGeneration(b)).toBe('recorded');
    const first = await bindings(scope); expect(first).toHaveLength(25);
    const seen = new Set(first.map(b => b.generationId));
    const missing = population.filter(b => !seen.has(b.generationId)).map(b => b.generationId).sort();
    expect(missing).toHaveLength(2);
    for (const b of first) expect(await store().append(openRouterUsageRecord(b, {
      data: { id: b.generationId, is_byok: b.isByok, total_cost: 0.001 },
    }))).toBe('recorded');
    const next = await bindings(scope, T + 2000); expect(next).toHaveLength(25);
    expect(next.slice(0, 2).map(b => b.generationId).sort()).toEqual(missing);
    expect(next.slice(0, 2).every(b => b.revision === 2)).toBe(true);
    expect(next.slice(2).every(b => b.revision === 3)).toBe(true);
  });
});
