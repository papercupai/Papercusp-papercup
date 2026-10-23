/** Real-PostgreSQL coverage for the bounded ledger/work-item rolling cutover. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { CodeIntelAnswer } from '../code-intelligence/contracts';
import { lspAdmissionClass, lspAdmissionController, runLspAdmission } from '../code-intelligence/lsp-admission';
import { Governor } from './admission';
import { PgAdmissionCutoverQueueStore } from './admission-cutover-store';
import * as execution from './execution';
import { PgWorkItemAdmissionQueueStore, WorkItemAdmissionQueueDriver } from './queue';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(
  resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1062-resource-governor-admission-ledger.sql'),
  'utf8',
);
const OVERLAP_GUARD_MIGRATION = readFileSync(
  resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1067-resource-governor-cutover-collision-guard.sql'),
  'utf8',
);
const RETIRED_WRITER_GUARD_MIGRATION = readFileSync(
  resolve(HERE, '../../../../libs/papercusp/libs/db/sql/1076-resource-governor-retired-writer-guard.sql'),
  'utf8',
);

const WORKSPACE = 'ws-cutover';
const NAMESPACE = 'cutover-integration';
let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('resource-governor-admission-cutover');
  await db.sql
    .unsafe(
      `
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS harness_shared;
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      ended_at timestamptz, resume_claim_key text, resume_claimed_at timestamptz
    );
    CREATE SEQUENCE harness_shared.work_item_seq;
    CREATE OR REPLACE FUNCTION harness_shared.next_work_item_id()
    RETURNS text
    LANGUAGE sql
    AS $function$
      SELECT 'WI-' || nextval('harness_shared.work_item_seq')::text
    $function$;
    CREATE TABLE harness_shared.operator_settings (
      key text PRIMARY KEY,
      value text NOT NULL,
      description text,
      updated_at bigint NOT NULL DEFAULT 0,
      workspace_id text
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL DEFAULT '',
      feature_id text NOT NULL,
      title text,
      summary text,
      status text,
      attempts integer NOT NULL DEFAULT 0,
      item_kind text,
      payload jsonb,
      taken_by text,
      taken_at timestamptz,
      origin text,
      ts bigint,
      created_ts bigint NOT NULL,
      updated_ts bigint NOT NULL,
      needs_design boolean NOT NULL DEFAULT false,
      needs_human_review boolean NOT NULL DEFAULT false,
      PRIMARY KEY (workspace_id, harness_slug, feature_id)
    );
  `,
    )
    .simple();
  await db.sql.unsafe(MIGRATION).simple();
  await db.sql.unsafe(OVERLAP_GUARD_MIGRATION).simple();
  await db.sql.unsafe(RETIRED_WRITER_GUARD_MIGRATION).simple();
}, 60_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`
    TRUNCATE harness_shared.resource_governor_admissions,
             harness_shared.adv_sessions,
             harness_shared.operator_settings,
             harness_shared.work_items`;
  await db.sql`ALTER SEQUENCE harness_shared.work_item_seq RESTART WITH 1`;
});

const resolveLive = (async (subjects: readonly { ownerId: string }[]) =>
  new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'live' as const }]))) as never;

function runtime(
  kind: 'legacy' | 'cutover',
  label: string,
  options: {
    now?: () => number;
    namespace?: string;
    resolveSessionStatesFn?: unknown;
  } = {},
) {
  let requestNo = 0;
  let leaseNo = 0;
  const now = options.now ?? (() => 10_000);
  const shared = {
    sql: db.sql,
    workspaceId: WORKSPACE,
    resolveSessionStatesFn: (options.resolveSessionStatesFn ?? resolveLive) as never,
  };
  const store =
    kind === 'legacy' ? new PgWorkItemAdmissionQueueStore(shared) : new PgAdmissionCutoverQueueStore(shared);
  const driver = new WorkItemAdmissionQueueDriver(store, {
    namespace: options.namespace ?? NAMESPACE,
    now,
    leaseIdFactory: () => `${label}-lease-${++leaseNo}`,
  });
  return {
    store,
    driver,
    governor: new Governor(driver, {
      now,
      idFactory: () => `${label}-request-${++requestNo}`,
    }),
  };
}

describe('PgAdmissionCutoverQueueStore', () => {
  it.each(['legacy', 'cutover'] as const)('starts an ended-source lease on %s with a live launcher, then restores child death and expiry protection', async (kind) => {
    const clock = { now: 50_000 };
    let childLive = false;
    let launcherLive = true;
    const resolve = (async (subjects: readonly { ownerId: string }[]) => new Map(subjects.map(({ ownerId }) => [
      ownerId, { sessionState: ownerId === 'launcher' ? launcherLive ? 'live' : 'ended' : childLive ? 'live' : 'ended' },
    ]))) as never;
    await db.sql`INSERT INTO harness_shared.adv_sessions
      (id, workspace_id, coord_owner_id, ended_at, resume_claim_key, resume_claimed_at)
      VALUES (11, ${WORKSPACE}, 'ended-source', to_timestamp(1), 'exact-resume', to_timestamp(50))`;
    const d = runtime(kind, 'resume', { now: () => clock.now, namespace: 'agent-process', resolveSessionStatesFn: resolve });
    // Place the real competing maintenance pass in the dangerous window, after
    // the real lease commits and before beginGovernedExecution marks it running.
    const leaseReceipt = d.driver.leaseReceipt.bind(d.driver);
    vi.spyOn(d.driver, 'leaseReceipt').mockImplementation(async (input) => {
      const claim = await leaseReceipt(input);
      await d.store.reconcileExpired?.('agent-process', clock.now);
      return claim;
    });
    // Counterfactual: the same real ended source and live launcher fail at the
    // original transition when the receipt lacks this exact reservation proof.
    await expect(execution.beginGovernedExecution({ idempotencyKey: 'unprotected', admissionClass: 'agent' },
      { owner: 'ended-source' }, d)).rejects.toMatchObject({
        governedAdmissionTransition: { state: 'queued', decision: 'owner-ended', leasePresent: false },
      });
    const start = (key: string, ttlMs = 10_000) => execution.beginGovernedExecution({
      idempotencyKey: key, admissionClass: 'agent', metadata: {
        targetOwnerId: 'ended-source', launchedBy: 'launcher', resumeAdvSessionId: 11,
        resumeClaimKey: 'exact-resume', resumeStartupExpiresAtMs: 55_000,
      },
    }, { owner: 'ended-source', leaseTtlMs: ttlMs }, d);

    // Real leaseReceipt -> owner scan -> markRunning: this failed owner-ended
    // before the reservation-aware startup transition, despite the live launcher.
    const running = await start('exact');
    expect(running.lease.owner).toBe('ended-source');
    expect(await d.governor.status('exact')).toMatchObject({ state: 'running' });
    const [source] = await db.sql`SELECT ended_at FROM harness_shared.adv_sessions WHERE id = 11`;
    expect(source.ended_at).not.toBeNull();

    // An unrelated old lease of the same ended owner is still reclaimable.
    const prior = await d.governor.admit({ idempotencyKey: 'old-owner-lease', admissionClass: 'agent' });
    if (prior.kind !== 'queued') throw new Error('expected queued prior lease');
    await d.driver.leaseReceipt({ receiptId: prior.receipt.receiptId, owner: 'ended-source', ttlMs: 10_000 });
    await d.store.reconcileExpired?.('agent-process', clock.now);
    expect(await d.governor.status('old-owner-lease')).toMatchObject({ state: 'queued' });
    expect(await d.governor.status('exact')).toMatchObject({ state: 'running' });

    // Child readiness consumes the reservation; the real child remains owner.
    childLive = true;
    await db.sql`UPDATE harness_shared.adv_sessions SET ended_at = NULL,
      resume_claim_key = NULL, resume_claimed_at = NULL WHERE id = 11`;
    await d.store.reconcileExpired?.('agent-process', clock.now);
    expect(await d.governor.status('exact')).toMatchObject({ state: 'running' });
    childLive = false;
    await d.store.reconcileExpired?.('agent-process', clock.now);
    expect(await d.governor.status('exact')).toMatchObject({ state: 'queued' });

    // Restore startup, then prove launcher death, startup expiry, and ordinary
    // lease expiry independently remove protection without a child exit callback.
    await db.sql`UPDATE harness_shared.adv_sessions SET ended_at = to_timestamp(1),
      resume_claim_key = 'exact-resume', resume_claimed_at = to_timestamp(50) WHERE id = 11`;
    await start('launcher-dies');
    launcherLive = false;
    await d.store.reconcileExpired?.('agent-process', clock.now);
    expect(await d.governor.status('launcher-dies')).toMatchObject({ state: 'queued' });
    launcherLive = true;
    await start('startup-expires');
    clock.now = 55_000;
    await d.store.reconcileExpired?.('agent-process', clock.now);
    expect(await d.governor.status('startup-expires')).toMatchObject({ state: 'queued' });
    clock.now = 50_000;
    await start('lease-expires', 1_000);
    clock.now = 51_001;
    await d.store.reconcileExpired?.('agent-process', clock.now);
    expect(await d.governor.status('lease-expires')).toMatchObject({ state: 'queued' });
  });

  it('persists LSP pressure through the production store and agrees with controller readback until settlement', async () => {
    // Reuse the production cutover store on the isolated database. Only the
    // process-global connection lookup and owner liveness are substituted.
    const deps = runtime('cutover', 'lsp', { now: Date.now, namespace: 'lsp-query' });
    const connection = vi.spyOn(execution, 'governedExecutionRuntime').mockImplementation((workspaceId, namespace) => {
      expect(workspaceId).toBe(WORKSPACE);
      expect(namespace).toBe('lsp-query');
      return deps;
    });
    const observer = new PgAdmissionCutoverQueueStore({ sql: db.sql, workspaceId: WORKSPACE, resolveSessionStatesFn: resolveLive });
    const base = { workspaceId: WORKSPACE, requestId: 'pg-base', language: 'typescript', projectRoot: '/fixture', op: 'references',
      query: '/fixture/source.ts', queryKey: 'fixture:source:1', deadlineAtMs: Date.now() + 30_000 };
    const answer: CodeIntelAnswer = {
      backend: 'lsp-adapter', intent: 'references', query: base.query,
      sites: [{ path: base.query, line1: 1, kind: 'reference' }],
      truncation: { truncated: false, totalAvailable: 1, continuation: null },
      freshness: { health: 'healthy', indexedAt: null, staleVsDisk: false, indexedCommit: null }, latencyMs: 1, error: null,
    };
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending: Promise<unknown>[] = [];
    const track = (promise: Promise<CodeIntelAnswer>) => { pending.push(promise); void promise.catch(() => undefined); return promise; };
    const controller = lspAdmissionController(WORKSPACE);
    const first = track(runLspAdmission({ ...base, requestId: 'pg-held', actor: 'agent-a' }, async () => { await held; return answer; }));
    const idempotencyKey = `lsp:${createHash('sha256').update(JSON.stringify([WORKSPACE, 'pg-queued'])).digest('hex')}`;
    try {
      await vi.waitFor(() => expect(controller.snapshot()).toMatchObject({ inFlight: 1 }));
      const queued = track(runLspAdmission({ ...base, requestId: 'pg-queued', actor: 'agent-b' }, async () => {
        // A second store instance reads the committed execution lease before
        // the LSP task returns; this cannot pass from an in-memory receipt.
        expect(await observer.find('lsp-query', idempotencyKey)).toMatchObject({ record: { state: 'running', lease: { owner: 'agent-b' } } });
        return answer;
      }));
      await vi.waitFor(async () => {
        expect(controller.snapshot()).toMatchObject({ queued: 1, inFlight: 1 });
        expect(await observer.find('lsp-query', idempotencyKey)).toMatchObject({
          receiptId: expect.stringMatching(/^RG-/),
          record: { state: 'queued', admissionClass: lspAdmissionClass(base), metadata: { actor: 'agent-b', op: 'references', language: 'typescript' } },
        });
      });
      const cheap = await runLspAdmission({ ...base, requestId: 'pg-cheap', actor: 'agent-c', op: 'symbol' }, async () => ({ ...answer, intent: 'definition' }));
      expect(cheap.error).toBeNull();
      expect(controller.snapshot()).toMatchObject({ queued: 1, inFlight: 1 });
      release();
      expect((await first).error).toBeNull();
      expect((await queued).error).toBeNull();
      await vi.waitFor(async () => {
        expect(controller.snapshot()).toMatchObject({ assessment: 'idle', queued: 0, inFlight: 0, settlementFailures: [] });
        const completed = await observer.find('lsp-query', idempotencyKey);
        expect(completed).toMatchObject({ record: { state: 'completed' } });
        expect(completed!.record.lease).toBeUndefined();
      });
      const rows = await db.sql<Array<{ state: string; namespace: string; lease_id: string | null; owner: string | null }>>`
        SELECT state, namespace, record->'lease'->>'leaseId' AS lease_id, record->'lease'->>'owner' AS owner
          FROM harness_shared.resource_governor_admissions WHERE workspace_id = ${WORKSPACE}`;
      expect(rows).toEqual([{ state: 'completed', namespace: 'lsp-query', lease_id: null, owner: null }]);
    } finally {
      release();
      await Promise.allSettled(pending);
      connection.mockRestore();
    }
  }, 20_000);

  it('resumes and exactly settles a pre-cutover WI receipt, then writes only RG receipts', async () => {
    const legacy = runtime('legacy', 'old');
    const prior = await legacy.governor.admit({
      idempotencyKey: 'already-live',
      admissionClass: 'process',
    });
    if (prior.kind !== 'queued') throw new Error('expected a queued legacy receipt');
    expect(prior.receipt.receiptId).toMatch(/^WI-/);

    const modern = runtime('cutover', 'modern');
    const resumed = await modern.governor.admit({
      idempotencyKey: 'already-live',
      admissionClass: 'process',
    });
    if (resumed.kind !== 'queued') throw new Error('expected the pre-cutover receipt');
    expect(resumed.receipt.receiptId).toBe(prior.receipt.receiptId);

    const claim = await modern.driver.leaseReceipt({
      receiptId: resumed.receipt.receiptId,
      owner: 'owner-a',
      ttlMs: 5_000,
    });
    if (!claim) throw new Error('expected the legacy receipt to remain leaseable');
    expect((await modern.driver.markRunning(claim.receiptId, claim.lease.leaseId))?.changed).toBe(true);
    expect((await modern.driver.complete(claim.receiptId, claim.lease.leaseId, 'result:legacy'))?.changed).toBe(true);

    const overlapNow = Date.now() + 1_000;
    const staleBinary = runtime('legacy', 'stale-binary', { now: () => overlapNow });
    const overlap = await staleBinary.governor.admit({
      idempotencyKey: 'post-latch-old-writer',
      admissionClass: 'process',
    });
    if (overlap.kind !== 'queued') throw new Error('expected a bounded overlap receipt');
    expect(overlap.receipt.receiptId).toMatch(/^WI-/);
    const overlapModern = runtime('cutover', 'overlap-modern', { now: () => overlapNow + 1_000 });
    const overlapResumed = await overlapModern.governor.admit({
      idempotencyKey: 'post-latch-old-writer',
      admissionClass: 'process',
    });
    if (overlapResumed.kind !== 'queued') throw new Error('expected the overlap receipt');
    expect(overlapResumed.receipt.receiptId).toBe(overlap.receipt.receiptId);
    const overlapClaim = await overlapModern.driver.leaseReceipt({
      receiptId: overlap.receipt.receiptId,
      owner: 'owner-overlap',
      ttlMs: 5_000,
    });
    if (!overlapClaim) throw new Error('expected the overlap receipt to remain leaseable');
    await overlapModern.driver.complete(overlapClaim.receiptId, overlapClaim.lease.leaseId, 'result:overlap');

    const fresh = await modern.governor.admit({
      idempotencyKey: 'ledger-only',
      admissionClass: 'agent',
    });
    if (fresh.kind !== 'queued') throw new Error('expected a new ledger receipt');
    expect(fresh.receipt.receiptId).toMatch(/^RG-/);

    const rows = await db.sql<Array<{ feature_id: string; state: string }>>`
      SELECT feature_id, payload->'resource_governor'->>'state' AS state
        FROM harness_shared.work_items
       WHERE workspace_id = ${WORKSPACE}
       ORDER BY feature_id`;
    expect(rows).toEqual([
      { feature_id: prior.receipt.receiptId, state: 'completed' },
      { feature_id: overlap.receipt.receiptId, state: 'completed' },
    ]);
    await expect((modern.store as PgAdmissionCutoverQueueStore).readCutoverCensus()).resolves.toMatchObject({
      cutoverLatched: true,
      legacyWritersRetired: false,
      ledgerTotal: 1,
      ledgerActive: 1,
      legacyTotal: 2,
      legacyActive: 0,
      legacyTerminal: 2,
      legacyCreatedAfterCutover: 1,
      legacyCreatedAfterRetirement: 0,
      terminalLegacyDeletionReady: false,
    });
  });

  it('lets an unrelated old writer overlap but rejects ledger identity and active coalesce collisions', async () => {
    const modern = runtime('cutover', 'ledger-owner');
    const ledger = await modern.governor.admit({
      idempotencyKey: 'ledger-identity',
      admissionClass: 'process',
    });
    if (ledger.kind !== 'queued') throw new Error('expected ledger identity');
    expect(ledger.receipt.receiptId).toMatch(/^RG-/);

    await expect(
      runtime('legacy', 'identity-collider').governor.admit({
        idempotencyKey: 'ledger-identity',
        admissionClass: 'process',
      }),
    ).rejects.toThrow(/identity already exists in the ledger|cross.store.identity.guard/i);

    await modern.governor.admit({
      idempotencyKey: 'ledger-coalesce-owner',
      admissionClass: 'embedding',
      coalesceKey: 'shared-index',
    });
    await expect(
      runtime('legacy', 'coalesce-collider').governor.admit({
        idempotencyKey: 'old-coalesce-request',
        admissionClass: 'embedding',
        coalesceKey: 'shared-index',
      }),
    ).rejects.toThrow(/active coalesce peer already exists in the ledger|cross.store.coalesce.guard/i);

    const unrelated = await runtime('legacy', 'unrelated-old-writer').governor.admit({
      idempotencyKey: 'unrelated-overlap',
      admissionClass: 'agent',
    });
    if (unrelated.kind !== 'queued') throw new Error('expected unrelated overlap admission');
    expect(unrelated.receipt.receiptId).toMatch(/^WI-/);
  });

  it('serializes an old/new identity race to exactly one durable receipt', async () => {
    const input = {
      idempotencyKey: 'cross-version-race',
      admissionClass: 'embedding',
    } as const;
    const [oldResult, modernResult] = await Promise.allSettled([
      runtime('legacy', 'old-racer').governor.admit(input),
      runtime('cutover', 'modern-racer').governor.admit(input),
    ]);
    expect(modernResult.status).toBe('fulfilled');

    const counts = await db.sql<Array<{ ledger: number; legacy: number }>>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.resource_governor_admissions) AS ledger,
        (SELECT count(*)::int FROM harness_shared.work_items
          WHERE payload ? 'resource_governor') AS legacy`;
    expect((counts[0]?.ledger ?? 0) + (counts[0]?.legacy ?? 0)).toBe(1);

    if (oldResult.status === 'fulfilled' && modernResult.status === 'fulfilled') {
      if (oldResult.value.kind !== 'queued' || modernResult.value.kind !== 'queued') {
        throw new Error('expected queued race outcomes');
      }
      expect(modernResult.value.receipt.receiptId).toBe(oldResult.value.receipt.receiptId);
      expect(modernResult.value.receipt.receiptId).toMatch(/^WI-/);
    } else if (oldResult.status === 'rejected') {
      expect(String(oldResult.reason)).toMatch(/identity already exists|cross.store.identity.guard/i);
      expect(counts[0]).toEqual({ ledger: 1, legacy: 0 });
    } else {
      throw new Error('the modern cutover writer must always converge or create the receipt');
    }
  });

  it('supersedes an active legacy coalesce peer in the same ledger enqueue transaction', async () => {
    const legacy = runtime('legacy', 'old-coalesce');
    const old = await legacy.governor.admit({
      idempotencyKey: 'old-index',
      admissionClass: 'embedding',
      coalesceKey: 'index:main',
    });
    if (old.kind !== 'queued') throw new Error('expected queued legacy receipt');

    const modern = runtime('cutover', 'new-coalesce');
    const replacement = await modern.governor.admit({
      idempotencyKey: 'new-index',
      admissionClass: 'embedding',
      coalesceKey: 'index:main',
    });
    if (replacement.kind !== 'queued') throw new Error('expected queued ledger receipt');
    expect(replacement.receipt.receiptId).toMatch(/^RG-/);

    await expect(modern.governor.status('old-index')).resolves.toMatchObject({ state: 'superseded' });
    await expect(modern.governor.status('new-index')).resolves.toMatchObject({
      state: 'queued',
      receipt: { receiptId: replacement.receipt.receiptId },
    });
  });

  it('fails closed when one identity exists in both persistence stores', async () => {
    const legacy = runtime('legacy', 'duplicate-source');
    await legacy.governor.admit({
      idempotencyKey: 'contradictory',
      admissionClass: 'process',
    });
    const records = await db.sql<Array<{ record: unknown }>>`
      SELECT payload->'resource_governor' AS record
        FROM harness_shared.work_items
       WHERE workspace_id = ${WORKSPACE}`;
    await db.sql`
      INSERT INTO harness_shared.resource_governor_admissions (workspace_id, record)
      VALUES (${WORKSPACE}, ${JSON.stringify(records[0]?.record)}::text::jsonb)`;

    const modern = runtime('cutover', 'duplicate-reader');
    await expect(modern.governor.status('contradictory')).rejects.toThrow(/exists in both/i);
    await expect(
      modern.governor.admit({
        idempotencyKey: 'contradictory',
        admissionClass: 'process',
      }),
    ).rejects.toThrow(/exists in both/i);
  });

  it('serializes an explicit retired-writers watermark and rejects every later legacy insert', async () => {
    const modern = runtime('cutover', 'retirement-control');
    await modern.governor.admit({ idempotencyKey: 'ledger-control', admissionClass: 'agent' });
    const retiredAtMs = Date.now() + 5_000;
    const store = modern.store as PgAdmissionCutoverQueueStore;
    const before = await store.readCutoverCensus();
    expect(before.legacyNewestCreatedMs).toBeNull();
    await expect(store.markLegacyWritersRetired(before.legacyNewestCreatedMs, retiredAtMs)).resolves.toMatchObject({
      legacyWritersRetired: true,
      legacyWritersRetiredAtMs: retiredAtMs,
      legacyActive: 0,
      legacyCreatedAfterRetirement: 0,
      terminalLegacyDeletionReady: true,
    });

    const lateLegacy = runtime('legacy', 'late-legacy', { now: () => retiredAtMs + 1_000 });
    await expect(
      lateLegacy.governor.admit({ idempotencyKey: 'late-legacy', admissionClass: 'process' }),
    ).rejects.toThrow(/legacy writers are retired|retired.writer.guard/i);
    await expect(store.readCutoverCensus()).resolves.toMatchObject({
      legacyWritersRetired: true,
      legacyActive: 0,
      legacyCreatedAfterRetirement: 0,
      terminalLegacyDeletionReady: true,
    });
  });

  it('refuses to mark retirement from a stale newest-legacy-row census', async () => {
    const modern = runtime('cutover', 'retirement-cas');
    await modern.governor.admit({ idempotencyKey: 'ledger-control', admissionClass: 'agent' });
    const store = modern.store as PgAdmissionCutoverQueueStore;
    const before = await store.readCutoverCensus();
    expect(before.legacyNewestCreatedMs).toBeNull();

    await runtime('legacy', 'census-racer', { now: () => Date.now() }).governor.admit({
      idempotencyKey: 'arrived-after-census',
      admissionClass: 'process',
    });
    await expect(store.markLegacyWritersRetired(before.legacyNewestCreatedMs)).rejects.toThrow(
      /legacy receipt census changed before retirement/i,
    );
    await expect(store.readCutoverCensus()).resolves.toMatchObject({
      legacyWritersRetired: false,
      legacyTotal: 1,
      legacyActive: 1,
    });
  });

  it('reclaims an explicitly ended ledger owner but preserves a lease renewed after the liveness read', async () => {
    const clock = { now: 50_000 };
    const resolveEnded = (async (subjects: readonly { ownerId: string }[]) =>
      new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'ended' as const }]))) as never;
    const ended = runtime('cutover', 'ended-owner', {
      now: () => clock.now,
      resolveSessionStatesFn: resolveEnded,
    });
    const admitted = await ended.governor.admit({
      idempotencyKey: 'ended-owner',
      admissionClass: 'agent',
    });
    if (admitted.kind !== 'queued') throw new Error('expected queued ledger receipt');
    const claim = await ended.driver.leaseReceipt({
      receiptId: admitted.receipt.receiptId,
      owner: 'owner-ended',
      ttlMs: 10_000,
    });
    if (!claim) throw new Error('expected ledger lease');
    await ended.driver.markRunning(claim.receiptId, claim.lease.leaseId);
    await expect(ended.store.reconcileExpired?.(NAMESPACE, clock.now)).resolves.toMatchObject({
      requeued: 1,
      total: 1,
    });
    await expect(ended.governor.status('ended-owner')).resolves.toMatchObject({
      state: 'queued',
      receipt: { receiptId: admitted.receipt.receiptId },
    });

    let staleReceiptId = '';
    const resolveAfterRenewal = (async (subjects: readonly { ownerId: string }[]) => {
      const rows = await db.sql<Array<{ record: Record<string, unknown> }>>`
        SELECT record
          FROM harness_shared.resource_governor_admissions
         WHERE workspace_id = ${WORKSPACE}
           AND receipt_id = ${staleReceiptId}`;
      const record = rows[0]?.record;
      if (!record) throw new Error('expected the stale-verdict control receipt');
      const renewed = {
        ...record,
        updatedAtMs: clock.now + 1,
        lease: {
          leaseId: 'renewed-lease',
          owner: 'owner-renewed',
          generation: 99,
          expiresAtMs: clock.now + 20_000,
        },
      };
      await db.sql`
        UPDATE harness_shared.resource_governor_admissions
           SET record = ${JSON.stringify(renewed)}::text::jsonb
         WHERE workspace_id = ${WORKSPACE}
           AND receipt_id = ${staleReceiptId}`;
      return new Map(subjects.map(({ ownerId }) => [ownerId, { sessionState: 'ended' as const }]));
    }) as never;
    const stale = runtime('cutover', 'stale-verdict', {
      now: () => clock.now,
      resolveSessionStatesFn: resolveAfterRenewal,
    });
    const staleAdmitted = await stale.governor.admit({
      idempotencyKey: 'stale-verdict',
      admissionClass: 'process',
    });
    if (staleAdmitted.kind !== 'queued') throw new Error('expected queued stale-verdict receipt');
    staleReceiptId = staleAdmitted.receipt.receiptId;
    const staleClaim = await stale.driver.leaseReceipt({
      receiptId: staleReceiptId,
      owner: 'owner-original',
      ttlMs: 10_000,
    });
    if (!staleClaim) throw new Error('expected stale-verdict ledger lease');
    await stale.driver.markRunning(staleClaim.receiptId, staleClaim.lease.leaseId);

    await expect(stale.store.reconcileExpired?.(NAMESPACE, clock.now)).resolves.toMatchObject({
      requeued: 0,
      total: 0,
    });
    const rows = await db.sql<Array<{ state: string; lease_id: string; owner: string }>>`
      SELECT state,
             record->'lease'->>'leaseId' AS lease_id,
             lease_owner AS owner
        FROM harness_shared.resource_governor_admissions
       WHERE workspace_id = ${WORKSPACE}
         AND receipt_id = ${staleReceiptId}`;
    expect(rows[0]).toEqual({ state: 'running', lease_id: 'renewed-lease', owner: 'owner-renewed' });
  });
});
