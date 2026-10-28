import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { seedPlan, setupPlanPgFixture, type PlanPgFixture } from './agent-tools/plans/__tests__/_pg-tool-fixture';
import { acquirePlanAdvisoryLock, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { createCanonicalRuntimeCustodyStore } from './blind-review-runtime-authority';
import { blindReviewerConfinement } from './blind-reviewer-mint';
import { BLIND_REVIEWER_BACKENDS } from './blind-reviewer-backends';
import { assertMigrationPassesPreApplyLints } from './migration-preapply-lint';
import { brokerSourceFixture } from './blind-review-source.fixture';
import { buildRuntimeGeneratedInputs } from './blind-review-generated-inputs';
import { packRuntimeSourceImage } from './blind-review-source-image';
import { consumeRuntimeSourceImage } from './blind-review-source-custody';
import { provisionRuntimeNamespace, releaseRuntimeNamespace,
  type RuntimeNamespaceBackend } from './blind-review-runtime-lifecycle';
import { assertRuntimeSeed } from './blind-review-runtime-seed';
import { reconcileRuntimeNamespaces, retireRuntimeNamespacesForBinding,
  retireRuntimeNamespacesForNativeEnd } from './blind-review-runtime-recovery';
import { _endLongLivedAdminPoolForTests } from './long-lived-admin-pool';
import { createRuntimeCustodyStore, RUNTIME_RESOURCE_KINDS, runtimeCustodyFingerprint,
  type RuntimeResourceIntent, type RuntimeReviewerIdentity, type RuntimeSourceAdmission } from './blind-review-runtime-custody';

// Exercises transaction/authority boundaries and a real managed guest failure.
// Full product readiness still requires separate runtime acceptance controls.
let fx: PlanPgFixture;
let serial = 0;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const migrationName = '1578-blind-review-runtime-custody.sql';
const sqlRoot = new URL('../../../libs/papercusp/libs/db/sql/', import.meta.url);
function migration(name: string) {
  return readFileSync(new URL(existsSync(new URL(name, sqlRoot)) ? name : name + '.DRAFT', sqlRoot), 'utf8');
}
beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  const [replacement] = await fx.admin`SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'harness_shared' AND table_name = 'plan_blind_review_sessions' AND column_name = 'attempt_seq'`;
  if (!replacement) await fx.admin.begin(tx => tx.unsafe(migration('1567-blind-review-replacement-attempts.sql')));
  const [present] = await fx.admin`SELECT to_regclass('harness_shared.blind_review_runtime_leases') AS table_name`;
  if (!present!.table_name) await fx.admin.begin(tx => tx.unsafe(migration(migrationName)));
}, 120_000);
afterAll(async () => {
  await _endLongLivedAdminPoolForTests('blind-review-runtime-lifecycle');
  await fx?.dispose();
});

async function fixture() {
  const n = ++serial;
  const owner = 'su-custody-' + n, native = 'native-custody-' + n;
  const [adv] = await fx.admin`INSERT INTO harness_shared.adv_sessions
    (workspace_id, mode, coord_owner_id, session_id, agent)
    VALUES ('default', 'omp', ${owner}, ${native}, 'codex') RETURNING id`;
  const [binding] = await fx.admin`INSERT INTO harness_shared.plan_blind_review_sessions
    (workspace_id, harness_slug, plan_slug, activation_audit_seq, reviewer_owner_id,
     adv_session_id, native_session_id, launch_parent_owner, confinement_snapshot, status)
    VALUES ('default', 'custody-fixture', ${'custody-fixture-' + n}, 1, ${owner}, ${adv!.id}, ${native},
      'system:blind-gap-review', '{}', 'ready') RETURNING id`;
  const identity: RuntimeReviewerIdentity = { workspaceId: 'default', bindingId: Number(binding!.id),
    activationAuditSeq: 1, replacementEpoch: 0, reviewerOwnerId: owner, nativeSessionId: native,
    confinementFingerprint: 'c'.repeat(64) };
  const source: RuntimeSourceAdmission = { repositoryId: 'custody-fixture', sourceCommit: 'a'.repeat(40),
    sourceTreeHash: 'b'.repeat(64), sourceInputsHash: 'd'.repeat(64), censusGeneration: 'fixture-1',
    censusStatus: 'admit', sourceImageNonce: randomUUID() };
  let allowed = true;
  const makeStore = () => createRuntimeCustodyStore({ sql: fx.admin as never,
    checkAuthority: async (_tx, current) => allowed && runtimeCustodyFingerprint(current) === runtimeCustodyFingerprint(identity) });
  const store = makeStore();
  const reserve = () => store.reserve(identity, 'request-' + n, 'e'.repeat(64));
  const allocate = async () => {
    const lease = await reserve();
    const receipt = await store.recordAdmission(identity, lease.id, source);
    return { lease: await store.consumeAdmission(identity, lease.id, receipt), receipt };
  };
  return { identity, source, store, makeStore, reserve, allocate, deny: () => { allowed = false; } };
}

function recoveryBackend() {
  const teardowns: string[] = [];
  let absent = true;
  const backend: RuntimeNamespaceBackend = {
    async provision() { throw new Error('recovery_must_not_provision'); },
    async teardown(lease) {
      const [cutoff] = await fx.admin`SELECT state, revoked_at FROM harness_shared.blind_review_runtime_leases
        WHERE id = ${lease.id}`;
      expect(cutoff!.state).toBe('releasing'); expect(cutoff!.revoked_at).not.toBeNull();
      teardowns.push(lease.id);
    },
    async inspect(_lease, resources) {
      return { creatorStopped: true, scopeAbsent: absent,
        absentIntentIds: absent ? resources.map(r => r.id) : [], checkedKinds: [...RUNTIME_RESOURCE_KINDS] };
    },
  };
  return { backend, teardowns, keepLive: () => { absent = false; } };
}

describe('runtime cutoff hooks and restart recovery', () => {
  it('commits a posted binding cutoff before teardown and can recover unrecorded resource intents', async () => {
    const f = await fixture(), { lease } = await f.allocate(), b = recoveryBackend();
    const plan = await f.store.beginProvisioning(f.identity, lease.id);
    expect(plan.resources.every(r => r.identity === null)).toBe(true);
    const result = await retireRuntimeNamespacesForBinding({ workspaceId: f.identity.workspaceId,
      bindingId: f.identity.bindingId, reason: 'review-posted' }, { sql: fx.admin as never, store: f.store, backend: b.backend });
    expect(result).toMatchObject({ cutoff: 1, released: 1, pending: 0 });
    expect(b.teardowns).toEqual([lease.id]);
    await expect(f.store.checkProvisioning(f.identity, lease.id)).rejects.toThrow('allocation_not_active');
  });

  it('requires the exact original native identity and never retires a successor from a stale end', async () => {
    const f = await fixture(), { lease } = await f.allocate(), b = recoveryBackend();
    const [binding] = await fx.admin`SELECT adv_session_id FROM harness_shared.plan_blind_review_sessions
      WHERE id = ${f.identity.bindingId}`;
    const deps = { sql: fx.admin as never, store: f.store, backend: b.backend };
    expect(await retireRuntimeNamespacesForNativeEnd({ workspaceId: f.identity.workspaceId,
      advSessionId: Number(binding!.adv_session_id), nativeSessionId: 'foreign-or-successor' }, deps))
      .toMatchObject({ cutoff: 0, released: 0 });
    await f.store.checkProvisioning(f.identity, lease.id);
    expect(await retireRuntimeNamespacesForNativeEnd({ workspaceId: f.identity.workspaceId,
      advSessionId: Number(binding!.adv_session_id), nativeSessionId: f.identity.nativeSessionId }, deps))
      .toMatchObject({ cutoff: 1, released: 1 });
  });

  it('cuts off expired authority while a live creator owns the lifecycle lock, then reaps after it fences', async () => {
    const f = await fixture(), { lease } = await f.allocate(), b = recoveryBackend();
    await f.store.beginProvisioning(f.identity, lease.id);
    const entered = deferred<void>(), finish = deferred<void>();
    const held = f.store.withLifecycle(f.identity, lease.id, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    try {
      await fx.admin`UPDATE harness_shared.blind_review_runtime_leases SET expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${lease.id}`;
      await reconcileRuntimeNamespaces({ sql: fx.admin as never, store: f.store, backend: b.backend });
      const [row] = await fx.admin`SELECT state, revoked_at FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
      expect(row!.state).toBe('releasing'); expect(row!.revoked_at).not.toBeNull();
      expect(b.teardowns).not.toContain(lease.id);
    } finally { finish.resolve(); await held; }
    await reconcileRuntimeNamespaces({ sql: fx.admin as never, store: f.store, backend: b.backend });
    expect(b.teardowns).toContain(lease.id);
  });

  it('preserves an authorized active creator and reaps its interrupted allocation after the lock is gone', async () => {
    const f = await fixture(), { lease } = await f.allocate(), b = recoveryBackend();
    await f.store.beginProvisioning(f.identity, lease.id);
    await fx.admin`UPDATE harness_shared.blind_review_runtime_leases SET updated_at = clock_timestamp() - interval '1 minute'
      WHERE id = ${lease.id}`;
    const entered = deferred<void>(), finish = deferred<void>();
    const held = f.store.withLifecycle(f.identity, lease.id, async () => { entered.resolve(); await finish.promise; });
    await entered.promise;
    try {
      await reconcileRuntimeNamespaces({ sql: fx.admin as never, store: f.store, backend: b.backend });
      await f.store.checkProvisioning(f.identity, lease.id);
      expect(b.teardowns).not.toContain(lease.id);
    } finally { finish.resolve(); await held; }
    await reconcileRuntimeNamespaces({ sql: fx.admin as never, store: f.store, backend: b.backend });
    expect(b.teardowns).toContain(lease.id);
    const [row] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
    expect(row!.state).toBe('released');
  });

  it('rechecks canonical authority and keeps unknown absence in releasing', async () => {
    const f = await fixture(), { lease } = await f.allocate(), b = recoveryBackend(); b.keepLive(); f.deny();
    const result = await reconcileRuntimeNamespaces({ sql: fx.admin as never, store: f.store, backend: b.backend });
    expect(result.pending).toBeGreaterThan(0);
    const [row] = await fx.admin`SELECT state, revoked_at FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
    expect(row!.state).toBe('releasing'); expect(row!.revoked_at).not.toBeNull();
    expect(b.teardowns).toContain(lease.id);
  });

  it('rotates healthy first-page entries so a later expired lease cannot be starved', async () => {
    const leases: string[] = [];
    for (let index = 0; index < 33; index++) {
      const f = await fixture(), { lease } = await f.allocate();
      const plan = await f.store.beginProvisioning(f.identity, lease.id);
      for (const resource of plan.resources) await f.store.recordResource(f.identity, lease.id, resource.id, { private: 'fixture' });
      await f.store.markReady(f.identity, lease.id); leases.push(lease.id);
    }
    const target = leases.at(-1)!;
    await fx.admin`UPDATE harness_shared.blind_review_runtime_leases
      SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${target}`;
    const store = createRuntimeCustodyStore({ sql: fx.admin as never, checkAuthority: async () => true });
    const b = recoveryBackend(); b.keepLive();
    for (let round = 0; round < 8 && !b.teardowns.includes(target); round++) {
      await reconcileRuntimeNamespaces({ sql: fx.admin as never, store, backend: b.backend });
    }
    // Absence is deliberately unknown, so the target remains releasing; the
    // required outcome is that its cutoff/cleanup was reached despite 32 live
    // healthy rows ahead of it, not a fabricated successful absence claim.
    expect(b.teardowns).toContain(target);
    const [row] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${target}`;
    expect(row!.state).toBe('releasing');
  });
});

async function canonicalFixture() {
  const f = await fixture();
  const slug = 'custody-fixture-' + serial;
  await seedPlan(fx.admin, 'default', 'custody-fixture', slug, `---\ntitle: Custody\nslug: ${slug}\nstatus: active\n---\n`);
  await fx.admin`INSERT INTO harness_shared.plan_audits
    (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind, activation,
     audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash)
    VALUES ('default', 'custody-fixture', ${slug}, 1, 'custody-author', 'activation', '{}', 1, 1, ${'a'.repeat(64)})`;
  const confinement = JSON.parse(JSON.stringify(blindReviewerConfinement(slug)));
  f.identity.confinementFingerprint = runtimeCustodyFingerprint(confinement);
  await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET account_route = 'auto',
    confinement_snapshot = ${JSON.stringify(confinement)}::jsonb WHERE id = ${f.identity.bindingId}`;
  await fx.admin`UPDATE harness_shared.adv_sessions SET launch_spec =
    ${JSON.stringify({ launchedBy: 'system:blind-gap-review', account: 'auto', headless: true })}::jsonb
    WHERE coord_owner_id = ${f.identity.reviewerOwnerId}`;
  await fx.admin`INSERT INTO harness_shared.operator_session_confinements (workspace_id, payload, updated_at)
    VALUES ('default', '{}', 0) ON CONFLICT (workspace_id) DO NOTHING`;
  await fx.admin`UPDATE harness_shared.operator_session_confinements SET payload = jsonb_set(payload,
    '{sessions}', COALESCE(payload->'sessions', '{}') ||
      ${JSON.stringify({ [f.identity.reviewerOwnerId]: { confinement, expiresAt: new Date(Date.now() + 60_000).toISOString() } })}::jsonb)
    WHERE workspace_id = 'default'`;
  return { ...f, slug, confinement, store: createCanonicalRuntimeCustodyStore(fx.admin as never) };
}

async function withAdmittedRuntime(run: (context: {
  f: Awaited<ReturnType<typeof fixture>>; leaseId: string;
  image: Awaited<ReturnType<typeof packRuntimeSourceImage>>;
}) => Promise<void>) {
  const roots: string[] = [];
  const source = await brokerSourceFixture(roots, { gitCheckout: true });
  const generated = await buildRuntimeGeneratedInputs(source);
  const image = await packRuntimeSourceImage({ ...source, generated });
  try {
    const f = await fixture(), lease = await f.reserve();
    await consumeRuntimeSourceImage({ store: f.store, identity: f.identity, leaseId: lease.id,
      image, repositoryId: 'custody-fixture' });
    await run({ f, leaseId: lease.id, image });
  } finally {
    await image.handle.close();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
}

describe('blind reviewer runtime custody on private PostgreSQL', () => {
  it('reaps a real managed guest after workspace creation fails before its durable append', async () => {
    const { createLinuxRuntimeNamespaceBackend, runtimeManagedTaskId } = await import('./blind-review-runtime-backend');
    await withAdmittedRuntime(async ({ f, leaseId, image }) => {
      const backend = createLinuxRuntimeNamespaceBackend();
      const lease = await f.store.checkProvisioning(f.identity, leaseId);
      let unrecordedIntent: string | undefined;
      const store: typeof f.store = {
        ...f.store,
        async recordResource(identity, id, intentId, observed) {
          if (observed.path === '/tmp/workspaces') {
            // The trusted guest reports only after mkdir. Verify its owning
            // scope is live before injecting the append failure, so an absent
            // launch or an early refusal cannot satisfy this cleanup control.
            expect(await backend.inspect(lease, [], AbortSignal.timeout(5_000)))
              .toMatchObject({ scopeAbsent: false, creatorStopped: false });
            unrecordedIntent = intentId;
            throw new Error('test_create_before_append');
          }
          await f.store.recordResource(identity, id, intentId, observed);
        },
      };
      try {
        await expect(provisionRuntimeNamespace({ store, identity: f.identity, leaseId, image, backend,
          signal: AbortSignal.timeout(30_000) })).rejects.toThrow('test_create_before_append');
        expect(unrecordedIntent).toBeDefined();
        const [current] = await fx.admin`SELECT state, revoked_at FROM harness_shared.blind_review_runtime_leases
          WHERE id = ${leaseId}`;
        expect(current!.state).toBe('released'); expect(current!.revoked_at).not.toBeNull();
        const resources = await fx.admin<RuntimeResourceIntent[]>`SELECT * FROM harness_shared.blind_review_runtime_resources
          WHERE lease_id = ${leaseId}`;
        expect(resources.find(row => row.kind === 'managed-scope')!.identity)
          .toMatchObject({ taskId: runtimeManagedTaskId(lease) });
        expect(resources.find(row => row.id === unrecordedIntent)).toMatchObject({
          kind: 'workspace', identity: null,
        });
        const absence = await backend.inspect(lease, resources, AbortSignal.timeout(5_000));
        expect(absence).toMatchObject({ scopeAbsent: true, creatorStopped: true });
        expect(absence.absentIntentIds.sort()).toEqual(resources.map(row => row.id).sort());
        await expect(f.store.checkProvisioning(f.identity, leaseId)).rejects.toThrow();
      } finally {
        // A failed assertion must not strand the real scope or private inputs.
        expect(await releaseRuntimeNamespace({ store: f.store, identity: f.identity, leaseId, backend,
          reason: 'test-finally' })).toBe(true);
      }
    });
  }, 90_000);

  it('consumes the measured retained image into canonical custody and refuses copies and post-cutoff retries', async () => {
    const roots: string[] = [];
    const source = await brokerSourceFixture(roots, { gitCheckout: true });
    const generated = await buildRuntimeGeneratedInputs(source);
    const image = await packRuntimeSourceImage({ ...source, generated });
    try {
      const f = await canonicalFixture();
      const lease = await f.store.reserve(f.identity, 'sealed-source-admission', 'e'.repeat(64));
      const options = { store: f.store, identity: f.identity, leaseId: lease.id,
        image, repositoryId: 'custody-fixture' };
      await expect(consumeRuntimeSourceImage({ ...options, image: { ...image } }))
        .rejects.toThrow('broker_source_origin_unavailable');
      expect(await fx.admin`SELECT id FROM harness_shared.blind_review_runtime_admissions WHERE lease_id = ${lease.id}`)
        .toHaveLength(0);
      const admitted = await consumeRuntimeSourceImage(options);
      expect(admitted.image).toBe(image);
      expect(admitted.lease.state).toBe('allocating');
      expect(admitted.lease.admission).toMatchObject({ sourceImageNonce: image.sourceImageNonce,
        sourceInputsHash: image.sourceInputsHash, censusStatus: 'admit' });
      const retry = await consumeRuntimeSourceImage(options);
      expect(retry.receiptId).toBe(admitted.receiptId);
      expect(retry.lease.id).toBe(lease.id);
      expect(await fx.admin`SELECT id FROM harness_shared.blind_review_runtime_admissions WHERE lease_id = ${lease.id}`)
        .toHaveLength(1);
      expect(await fx.admin`SELECT id FROM harness_shared.blind_review_runtime_resources WHERE lease_id = ${lease.id}`)
        .toHaveLength(0);
      await f.store.revoke(f.identity, lease.id, 'cutoff-control');
      await expect(f.store.consumeAdmission(f.identity, lease.id, admitted.receiptId))
        .rejects.toMatchObject({ code: 'allocation_not_active' });
      await expect(consumeRuntimeSourceImage(options)).rejects.toMatchObject({ code: 'allocation_not_active' });
    } finally {
      await image.handle.close();
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('uses canonical binding, native launch and fresh confinement for production admission', async () => {
    const f = await canonicalFixture();
    const lease = await f.store.reserve(f.identity, 'canonical-admit', 'e'.repeat(64));
    const receipt = await f.store.recordAdmission(f.identity, lease.id, f.source);
    expect((await f.store.consumeAdmission(f.identity, lease.id, receipt)).state).toBe('allocating');
    await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = clock_timestamp()
      WHERE coord_owner_id = ${f.identity.reviewerOwnerId}`;
    await expect(f.store.intendResource(f.identity, lease.id, 'process', 'late'))
      .rejects.toMatchObject({ code: 'reviewer_authority_invalid' });
    expect((await f.store.revoke(f.identity, lease.id, 'native-ended')).state).toBe('releasing');
  });

  it('admits a reviewer launched on every backend-ladder rung under canonical authority', async () => {
    // EI-27127088253419654: canonical authority pinned `agent === 'codex'` after the launch
    // ladder went Opus-first, so an Opus reviewer would launch and then be refused custody.
    for (const backend of BLIND_REVIEWER_BACKENDS) {
      const f = await canonicalFixture();
      await fx.admin`UPDATE harness_shared.adv_sessions SET agent = ${backend.agent},
        launch_spec = launch_spec || ${JSON.stringify(backend.model ? { model: backend.model } : {})}::jsonb
        WHERE coord_owner_id = ${f.identity.reviewerOwnerId}`;
      await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET model_spec = ${backend.model ?? null}
        WHERE id = ${f.identity.bindingId}`;
      const lease = await f.store.reserve(f.identity, 'ladder-' + backend.agent, 'e'.repeat(64));
      expect(lease.id, backend.agent).toBeTruthy();
    }
  });

  it('refuses terminal, stale, foreign, widened, expired and missing canonical authority before reservation', async () => {
    const edits = [
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => {
        // An agent off the backend ladder never holds reviewer authority.
        await fx.admin`UPDATE harness_shared.adv_sessions SET agent = 'omp' WHERE coord_owner_id = ${f.identity.reviewerOwnerId}`;
      },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => {
        await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET status = 'closed' WHERE id = ${f.identity.bindingId}`;
      },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => {
        await fx.admin`UPDATE harness_shared.plan_audits SET audit_seq = 2 WHERE plan_slug = ${f.slug}`;
      },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => { f.identity.replacementEpoch = 1; },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => { f.identity.nativeSessionId = 'foreign'; },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => {
        await fx.admin`UPDATE harness_shared.adv_sessions SET launch_spec = '{}' WHERE coord_owner_id = ${f.identity.reviewerOwnerId}`;
      },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => {
        const widened = { ...f.confinement, denyOutside: ['capability:bash', 'plans:get'] };
        f.identity.confinementFingerprint = runtimeCustodyFingerprint(widened);
        await fx.admin`UPDATE harness_shared.plan_blind_review_sessions SET confinement_snapshot = ${JSON.stringify(widened)}::jsonb
          WHERE id = ${f.identity.bindingId}`;
        await fx.admin`UPDATE harness_shared.operator_session_confinements SET payload = jsonb_set(payload,
          ARRAY['sessions', ${f.identity.reviewerOwnerId}, 'confinement'], ${JSON.stringify(widened)}::jsonb) WHERE workspace_id = 'default'`;
      },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => {
        await fx.admin`UPDATE harness_shared.operator_session_confinements SET payload = jsonb_set(payload,
          ARRAY['sessions', ${f.identity.reviewerOwnerId}, 'expiresAt'], '"2000-01-01T00:00:00Z"') WHERE workspace_id = 'default'`;
      },
      async (f: Awaited<ReturnType<typeof canonicalFixture>>) => {
        await fx.admin`UPDATE harness_shared.operator_session_confinements SET payload = payload #- ARRAY['sessions', ${f.identity.reviewerOwnerId}]
          WHERE workspace_id = 'default'`;
      },
    ];
    for (const edit of edits) {
      const f = await canonicalFixture();
      await edit(f);
      await expect(f.store.reserve(f.identity, 'must-refuse', 'e'.repeat(64)))
        .rejects.toMatchObject({ code: 'reviewer_authority_invalid' });
      expect(await fx.admin`SELECT id FROM harness_shared.blind_review_runtime_leases WHERE binding_id = ${f.identity.bindingId}`).toHaveLength(0);
    }
  });

  it('waits for the canonical activation writer and evaluates its committed result', async () => {
    const f = await canonicalFixture();
    let dispatched!: () => void, announce!: () => void;
    const ready = new Promise<void>(resolve => { announce = resolve; });
    const barrier = new Promise<void>(resolve => { dispatched = resolve; });
    const key = planAdvisoryLockKey('default', 'custody-fixture', f.slug);
    const writer = fx.admin.begin(async tx => {
      await acquirePlanAdvisoryLock(tx, key);
      await tx`UPDATE harness_shared.plan_audits SET audit_seq = 2 WHERE plan_slug = ${f.slug}`;
      announce(); await barrier;
      // Observe the actual waiter using the writer's connection. Merely
      // creating a promise before commit would not prove the race occurred.
      const deadline = Date.now() + 3000;
      let blocked = false;
      do {
        const [waiter] = await tx`SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objsubid = 2
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND classid::bigint = (hashtext('harness_plans')::bigint & 4294967295)
          AND objid::bigint = (hashtext(${key})::bigint & 4294967295) AND NOT granted`;
        blocked = !!waiter;
        if (!blocked) await new Promise(resolve => setTimeout(resolve, 10));
      } while (!blocked && Date.now() < deadline);
      expect(blocked).toBe(true);
    });
    await ready;
    const allocation = f.store.reserve(f.identity, 'raced-activation', 'e'.repeat(64));
    const refused = expect(allocation).rejects.toMatchObject({ code: 'reviewer_authority_invalid' });
    dispatched(); await writer; await refused;
  });

  it('passes migration safety and gives metadata reservations no runtime authority', async () => {
    expect(() => assertMigrationPassesPreApplyLints({ filename: migrationName, sqlText: migration(migrationName),
      sqlDir: sqlRoot.pathname })).not.toThrow();
    const f = await fixture();
    const row = await f.reserve();
    expect(row).toMatchObject({ state: 'requested', receipt_id: null, admission: null, expires_at: null });
    await expect(f.store.intendResource(f.identity, row.id, 'managed-scope', 'main'))
      .rejects.toMatchObject({ code: 'lease_identity_mismatch' });
    const resources = await fx.admin`SELECT * FROM harness_shared.blind_review_runtime_resources WHERE lease_id = ${row.id}`;
    expect(resources).toHaveLength(0);
  });

  it('serializes duplicate request and receipt retries across independent store instances', async () => {
    const f = await fixture();
    const reserved = await Promise.all(Array.from({ length: 8 }, () => f.makeStore().reserve(f.identity, 'request-' + serial, 'e'.repeat(64))));
    expect(new Set(reserved.map(x => x.id)).size).toBe(1);
    const id = reserved[0]!.id;
    const receipt = await f.store.recordAdmission(f.identity, id, f.source);
    const allocated = await Promise.all(Array.from({ length: 8 }, () => f.makeStore().consumeAdmission(f.identity, id, receipt)));
    expect(allocated.every(x => x.id === id && x.state === 'allocating' && x.receipt_id === receipt)).toBe(true);
    const receipts = await fx.admin`SELECT * FROM harness_shared.blind_review_runtime_admissions WHERE lease_id = ${id}`;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.consumed_at).not.toBeNull();
    expect((await f.reserve()).id).toBe(id);
  });

  it('refuses changed request hashes, foreign receipts, and source tuple changes without allocating', async () => {
    const f = await fixture(), other = await fixture();
    const lease = await f.reserve(), foreign = await other.reserve();
    const receipt = await f.store.recordAdmission(f.identity, lease.id, f.source);
    await expect(f.store.reserve(f.identity, lease.request_id, 'f'.repeat(64)))
      .rejects.toMatchObject({ code: 'allocation_request_conflict' });
    await expect(f.store.reserve(f.identity, 'another-request', lease.request_hash))
      .rejects.toMatchObject({ code: 'allocation_request_conflict' });
    await expect(other.store.consumeAdmission(other.identity, foreign.id, receipt))
      .rejects.toMatchObject({ code: 'admission_invalid_or_expired' });
    await expect(f.store.recordAdmission(f.identity, lease.id, { ...f.source, sourceInputsHash: 'f'.repeat(64) }))
      .rejects.toMatchObject({ code: 'admission_tuple_changed' });
    const [stored] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
    expect(stored!.state).toBe('requested');
    expect((await f.store.consumeAdmission(f.identity, lease.id, receipt)).state).toBe('allocating');
  });

  it('refuses expired, unknown, and tampered admission while the valid control consumes', async () => {
    const f = await fixture();
    const lease = await f.reserve(), receipt = await f.store.recordAdmission(f.identity, lease.id, f.source);
    await expect(f.store.consumeAdmission(f.identity, lease.id, randomUUID())).rejects.toMatchObject({ code: 'admission_invalid_or_expired' });
    await fx.admin`UPDATE harness_shared.blind_review_runtime_admissions SET issued_at = clock_timestamp() - interval '2 minutes',
      expires_at = clock_timestamp() - interval '1 minute' WHERE id = ${receipt}`;
    await expect(f.store.consumeAdmission(f.identity, lease.id, receipt)).rejects.toMatchObject({ code: 'admission_invalid_or_expired' });
    await fx.admin`UPDATE harness_shared.blind_review_runtime_admissions SET expires_at = clock_timestamp() + interval '1 minute',
      tuple = tuple || '{"censusStatus":"unknown"}'::jsonb WHERE id = ${receipt}`;
    await expect(f.store.consumeAdmission(f.identity, lease.id, receipt)).rejects.toMatchObject({ code: 'admission_tuple_mismatch' });
    const control = await fixture();
    expect((await control.allocate()).lease.state).toBe('allocating');
  });

  it('authorizes only the exact ready runtime and rechecks canonical native liveness after dispatch', async () => {
    const f = await canonicalFixture(), { lease } = await f.allocate();
    const runtime = { leaseEpoch: String(lease.lease_epoch), runtimeNonce: lease.runtime_nonce };
    await expect(f.store.authorize(f.identity, lease.id, runtime))
      .rejects.toMatchObject({ code: 'runtime_not_ready' });
    for (const kind of RUNTIME_RESOURCE_KINDS.filter(kind => kind !== 'capture')) {
      const intent = await f.store.intendResource(f.identity, lease.id, kind, 'main');
      await f.store.recordResource(f.identity, lease.id, intent.id, { tag: intent.ownership_tag });
    }
    await f.store.markReady(f.identity, lease.id);
    await expect(f.store.authorize(f.identity, lease.id, { ...runtime, runtimeNonce: randomUUID() }))
      .rejects.toMatchObject({ code: 'runtime_identity_mismatch' });
    await expect(f.store.authorize(f.identity, lease.id, { ...runtime, leaseEpoch: String(BigInt(runtime.leaseEpoch) + 1n) }))
      .rejects.toMatchObject({ code: 'runtime_identity_mismatch' });
    expect((await f.store.authorize(f.identity, lease.id, runtime)).state).toBe('ready');
    await fx.admin`UPDATE harness_shared.adv_sessions SET ended_at = clock_timestamp()
      WHERE coord_owner_id = ${f.identity.reviewerOwnerId}`;
    await expect(f.store.authorize(f.identity, lease.id, runtime))
      .rejects.toMatchObject({ code: 'reviewer_authority_invalid' });
    expect((await f.store.revoke(f.identity, lease.id, 'native-ended')).state).toBe('releasing');
  });

  it('refuses a consumed receipt retry after its lease expires', async () => {
    const f = await fixture(), { lease, receipt } = await f.allocate();
    await fx.admin`UPDATE harness_shared.blind_review_runtime_leases
      SET expires_at = clock_timestamp() - interval '1 minute' WHERE id = ${lease.id}`;
    await expect(f.store.consumeAdmission(f.identity, lease.id, receipt))
      .rejects.toMatchObject({ code: 'lease_expired_or_revoked' });
    await expect(f.store.recordAdmission(f.identity, lease.id, f.source))
      .rejects.toMatchObject({ code: 'lease_expired_or_revoked' });
  });

  it('rolls back receipt consumption when custody commit fails, then recovers the same request', async () => {
    const f = await fixture();
    const lease = await f.reserve(), receipt = await f.store.recordAdmission(f.identity, lease.id, f.source);
    await fx.admin.unsafe(`CREATE FUNCTION harness_shared.custody_test_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.state = 'allocating' THEN RAISE EXCEPTION 'custody commit crash'; END IF; RETURN NEW; END $$`);
    await fx.admin.unsafe(`CREATE TRIGGER custody_test_crash BEFORE UPDATE ON harness_shared.blind_review_runtime_leases
      FOR EACH ROW EXECUTE FUNCTION harness_shared.custody_test_crash()`);
    try {
      await expect(f.store.consumeAdmission(f.identity, lease.id, receipt)).rejects.toThrow('custody commit crash');
      const [r] = await fx.admin`SELECT consumed_at FROM harness_shared.blind_review_runtime_admissions WHERE id = ${receipt}`;
      const [l] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
      expect(r!.consumed_at).toBeNull(); expect(l!.state).toBe('requested');
    } finally {
      await fx.admin.unsafe('DROP TRIGGER custody_test_crash ON harness_shared.blind_review_runtime_leases');
      await fx.admin.unsafe('DROP FUNCTION harness_shared.custody_test_crash()');
    }
    expect((await f.makeStore().consumeAdmission(f.identity, lease.id, receipt)).state).toBe('allocating');
  });

  it('retains create-before-append intents and permits cleanup after reviewer authority ends', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    const intent = await f.store.intendResource(f.identity, lease.id, 'process', 'driver');
    expect(intent.identity).toBeNull();
    expect((await f.makeStore().intendResource(f.identity, lease.id, 'process', 'driver')).id).toBe(intent.id);
    f.deny();
    await expect(f.store.intendResource(f.identity, lease.id, 'process', 'another'))
      .rejects.toMatchObject({ code: 'reviewer_authority_invalid' });
    const cutoff = await f.store.revoke(f.identity, lease.id, 'native-ended');
    expect(cutoff.state).toBe('releasing'); expect(cutoff.revoked_at).not.toBeNull();
    const observed = { pid: '123', startTicks: '456', namespace: intent.ownership_tag };
    await f.makeStore().recordResource(f.identity, lease.id, intent.id, observed);
    await expect(f.store.recordResource(f.identity, lease.id, intent.id, { ...observed, startTicks: '789' }))
      .rejects.toMatchObject({ code: 'resource_identity_changed' });
    const again = await f.store.revoke(f.identity, lease.id, 'retry');
    expect(again.revoked_at).toEqual(cutoff.revoked_at);
  });

  it('grants exactly one creator across stores and retains the complete plan after a create-before-append crash', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    const plans = await Promise.all([
      f.store.beginProvisioning(f.identity, lease.id),
      f.makeStore().beginProvisioning(f.identity, lease.id),
    ]);
    expect(plans.filter(plan => plan.claimed)).toHaveLength(1);
    const winner = plans.find(plan => plan.claimed)!;
    expect(winner.resources.map(resource => resource.kind).sort())
      .toEqual(RUNTIME_RESOURCE_KINDS.filter(kind => kind !== 'capture').sort());
    expect(winner.resources.every(resource => resource.identity === null)).toBe(true);
    expect(new Set(winner.resources.map(resource => resource.ownership_tag)).size).toBe(winner.resources.length);
    const retry = await f.makeStore().beginProvisioning(f.identity, lease.id);
    expect(retry.claimed).toBe(false);
    expect(retry.resources.map(resource => resource.id).sort())
      .toEqual(winner.resources.map(resource => resource.id).sort());
    // No readiness follows from a claim or a retry: every actual identity is
    // still missing, including an OS creation whose append never committed.
    await expect(f.store.markReady(f.identity, lease.id)).rejects.toMatchObject({ code: 'runtime_inventory_incomplete' });
    await expect(f.store.checkProvisioning(f.identity, lease.id)).resolves.toMatchObject({ state: 'allocating' });
    await f.store.revoke(f.identity, lease.id, 'provisioner-crash');
    await expect(f.store.checkProvisioning(f.identity, lease.id)).rejects.toMatchObject({ code: 'allocation_not_active' });
    await expect(f.store.beginProvisioning(f.identity, lease.id)).rejects.toMatchObject({ code: 'allocation_not_active' });
    expect(await f.store.confirmReleased(f.identity, lease.id, async resources => ({
      scopeAbsent: true, absentIntentIds: resources.map(resource => resource.id), checkedKinds: [...RUNTIME_RESOURCE_KINDS],
    }))).toBe(true);
  });

  it('runs one host provisioner, returns pending to overlap, and never reexecutes a ready retry', async () => {
    await withAdmittedRuntime(async ({ f, leaseId, image }) => {
      const entered = deferred<void>(), finish = deferred<void>();
      let creates = 0;
      const backend: RuntimeNamespaceBackend = {
        async provision(input) {
          creates++;
          assertRuntimeSeed(input.seed, input.lease);
          expect(input.seed.fixtures).toEqual(['ready']);
          expect(input.seed.actors).toEqual([]);
          expect(input.seed.workspace.id).not.toBe(f.identity.workspaceId);
          expect(input.image.handle).toBe(image.handle);
          expect(input.resources).toHaveLength(RUNTIME_RESOURCE_KINDS.length - 1);
          entered.resolve(); await finish.promise;
          for (const resource of input.resources) {
            await input.beforeCreate();
            await input.record(resource.id, { fixtureIdentity: resource.ownership_tag });
          }
        },
        async teardown() {},
        async inspect(_lease, resources) {
          return { scopeAbsent: true, creatorStopped: true,
            absentIntentIds: resources.map(resource => resource.id), checkedKinds: [...RUNTIME_RESOURCE_KINDS] };
        },
      };
      const input = { store: f.store, identity: f.identity, leaseId, image, backend };
      const boot = provisionRuntimeNamespace(input);
      try {
        await entered.promise;
        expect(await provisionRuntimeNamespace({ ...input, store: f.makeStore() })).toEqual({ state: 'pending' });
      } finally { finish.resolve(); }
      expect((await boot).state).toBe('ready');
      expect((await provisionRuntimeNamespace({ ...input, store: f.makeStore() })).state).toBe('ready');
      expect(creates).toBe(1);
      expect(await releaseRuntimeNamespace({ ...input, reason: 'exercise-ended' })).toBe(true);
    });
  }, 60_000);

  it('commits cutoff while a creator is active and refuses release until independent discovery fences that creator', async () => {
    await withAdmittedRuntime(async ({ f, leaseId, image }) => {
      const entered = deferred<void>(), finish = deferred<void>();
      let creatorStopped = false, teardownCalls = 0;
      const backend: RuntimeNamespaceBackend = {
        async provision(input) {
          await input.beforeCreate();
          const resource = input.resources[0]!;
          await input.record(resource.id, { fixtureIdentity: resource.ownership_tag });
          entered.resolve(); await finish.promise;
          await input.beforeCreate(); // Must observe the committed cutoff.
        },
        async teardown() { teardownCalls++; },
        async inspect(_lease, resources) {
          return { creatorStopped, scopeAbsent: true, checkedKinds: [...RUNTIME_RESOURCE_KINDS],
            absentIntentIds: resources.map(resource => resource.id) };
        },
      };
      const input = { store: f.store, identity: f.identity, leaseId, image, backend };
      const boot = provisionRuntimeNamespace(input);
      const failed = expect(boot).rejects.toMatchObject({ code: 'allocation_not_active' });
      try {
        await entered.promise;
        expect(await releaseRuntimeNamespace({ ...input, store: f.makeStore(), reason: 'native-ended' })).toBe(false);
        const [cutoff] = await fx.admin`SELECT state, revoked_at FROM harness_shared.blind_review_runtime_leases WHERE id = ${leaseId}`;
        expect(cutoff!.state).toBe('releasing'); expect(cutoff!.revoked_at).not.toBeNull();
        expect(teardownCalls).toBe(0); // The active creator still holds lifecycle custody.
      } finally { finish.resolve(); }
      await failed;
      expect(teardownCalls).toBe(1);
      const [unfenced] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${leaseId}`;
      expect(unfenced!.state).toBe('releasing');
      creatorStopped = true;
      expect(await releaseRuntimeNamespace({ ...input, reason: 'reaper-retry' })).toBe(true);
    });
  }, 60_000);

  it('reaps a crashed provisioning plan without replaying creation or adopting its partial identities', async () => {
    await withAdmittedRuntime(async ({ f, leaseId, image }) => {
      const plan = await f.store.beginProvisioning(f.identity, leaseId);
      await f.store.recordResource(f.identity, leaseId, plan.resources[0]!.id, { fixtureIdentity: 'created-before-crash' });
      let created = false, reaped = false;
      const backend: RuntimeNamespaceBackend = {
        async provision() { created = true; },
        async teardown() { reaped = true; },
        async inspect(_lease, resources) {
          expect(resources.filter(resource => resource.identity === null)).toHaveLength(resources.length - 1);
          return { creatorStopped: true, scopeAbsent: true, checkedKinds: [...RUNTIME_RESOURCE_KINDS],
            absentIntentIds: resources.map(resource => resource.id) };
        },
      };
      await expect(provisionRuntimeNamespace({ store: f.makeStore(), identity: f.identity, leaseId, image, backend }))
        .rejects.toMatchObject({ code: 'runtime_provisioning_interrupted' });
      expect(created).toBe(false); expect(reaped).toBe(true);
      const [row] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${leaseId}`;
      expect(row!.state).toBe('released');
    });
  }, 60_000);

  it('does not wait for a canceled backend that ignores its signal and blocks its late resource writes', async () => {
    await withAdmittedRuntime(async ({ f, leaseId, image }) => {
      const entered = deferred<Parameters<RuntimeNamespaceBackend['provision']>[0]>();
      const finish = deferred<void>();
      const controller = new AbortController();
      let inspectCalls = 0;
      const backend: RuntimeNamespaceBackend = {
        async provision(input) { entered.resolve(input); await finish.promise; },
        async teardown() {},
        async inspect(_lease, resources) {
          inspectCalls++;
          return { creatorStopped: false, scopeAbsent: true, checkedKinds: [...RUNTIME_RESOURCE_KINDS],
            absentIntentIds: resources.map(resource => resource.id) };
        },
      };
      const input = { store: f.store, identity: f.identity, leaseId, image, backend, signal: controller.signal };
      const boot = provisionRuntimeNamespace(input);
      const failure = expect(boot).rejects.toThrow('caller-canceled');
      try {
        const active = await entered.promise;
        controller.abort(new Error('caller-canceled'));
        await failure; // Must settle before the non-cooperative backend returns.
        expect(inspectCalls).toBe(1);
        await expect(active.beforeCreate()).rejects.toThrow('caller-canceled');
        await expect(active.record(active.resources[0]!.id, { late: 'identity' })).rejects.toThrow('caller-canceled');
        const [row] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${leaseId}`;
        expect(row!.state).toBe('releasing'); // An unfenced creator is not gone.
      } finally { finish.resolve(); }
    });
  }, 60_000);

  it('cleans up a synchronous backend exception without leaving an unhandled abort rejection', async () => {
    await withAdmittedRuntime(async ({ f, leaseId, image }) => {
      let reaped = false;
      const backend: RuntimeNamespaceBackend = {
        provision() { throw new Error('synchronous-backend-failure'); },
        async teardown() { reaped = true; },
        async inspect(_lease, resources) {
          return { creatorStopped: true, scopeAbsent: true, checkedKinds: [...RUNTIME_RESOURCE_KINDS],
            absentIntentIds: resources.map(resource => resource.id) };
        },
      };
      await expect(provisionRuntimeNamespace({ store: f.store, identity: f.identity, leaseId, image, backend }))
        .rejects.toThrow('synchronous-backend-failure');
      expect(reaped).toBe(true);
      const [row] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${leaseId}`;
      expect(row!.state).toBe('released');
    });
  }, 60_000);

  it('serializes host lifecycle work across connections while allowing immediate durable revocation', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    const outer = await f.store.withLifecycle(f.identity, lease.id, async () => {
      const contender = await f.makeStore().withLifecycle(f.identity, lease.id, async () => {
        throw new Error('duplicate lifecycle executor');
      });
      expect(contender).toEqual({ acquired: false });
      // The pinned lifecycle connection must not hold the binding/lease row
      // lock: cutoff must commit before the lifecycle holder finishes.
      expect((await f.makeStore().revoke(f.identity, lease.id, 'cancel-during-boot')).state).toBe('releasing');
      await expect(f.store.checkProvisioning(f.identity, lease.id)).rejects.toMatchObject({ code: 'allocation_not_active' });
      return 'finished';
    });
    expect(outer).toEqual({ acquired: true, value: 'finished' });
    await expect(f.store.withLifecycle(f.identity, lease.id, async () => {
      throw new Error('interrupted lifecycle');
    })).rejects.toThrow('interrupted lifecycle');
    expect(await f.makeStore().withLifecycle(f.identity, lease.id, async () => 'recovery'))
      .toEqual({ acquired: true, value: 'recovery' });
  });

  it('keeps lifecycle locks on a direct session even when the query pool cannot reserve a server session', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    const pooled = new Proxy(fx.admin, {
      get(target, key, receiver) {
        if (key === 'reserve') return () => { throw new Error('transaction-pooler-cannot-pin-session'); };
        return Reflect.get(target, key, receiver);
      },
    });
    const store = createRuntimeCustodyStore({ sql: pooled as never, checkAuthority: async () => true });
    expect(await store.withLifecycle(f.identity, lease.id, async () => {
      expect(await f.makeStore().withLifecycle(f.identity, lease.id, async () => 'duplicate'))
        .toEqual({ acquired: false });
      return 'direct-session';
    })).toEqual({ acquired: true, value: 'direct-session' });
    expect(await f.makeStore().withLifecycle(f.identity, lease.id, async () => 'released'))
      .toEqual({ acquired: true, value: 'released' });
  });

  it('never reclaims a partial boot inventory or rolls a failed plan transaction into creation authority', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    await fx.admin.unsafe(`CREATE FUNCTION harness_shared.custody_plan_crash() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.kind = 'database' THEN RAISE EXCEPTION 'plan commit crash'; END IF; RETURN NEW; END $$`);
    await fx.admin.unsafe(`CREATE TRIGGER custody_plan_crash BEFORE INSERT ON harness_shared.blind_review_runtime_resources
      FOR EACH ROW EXECUTE FUNCTION harness_shared.custody_plan_crash()`);
    try {
      await expect(f.store.beginProvisioning(f.identity, lease.id)).rejects.toThrow('plan commit crash');
      expect(await fx.admin`SELECT id FROM harness_shared.blind_review_runtime_resources WHERE lease_id = ${lease.id}`)
        .toHaveLength(0);
    } finally {
      await fx.admin.unsafe('DROP TRIGGER custody_plan_crash ON harness_shared.blind_review_runtime_resources');
      await fx.admin.unsafe('DROP FUNCTION harness_shared.custody_plan_crash()');
    }
    const partial = await f.store.intendResource(f.identity, lease.id, 'managed-scope', 'main');
    const retry = await f.makeStore().beginProvisioning(f.identity, lease.id);
    expect(retry.claimed).toBe(false);
    expect(retry.resources).toEqual([partial]);
    await fx.admin`UPDATE harness_shared.blind_review_runtime_leases
      SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lease.id}`;
    await expect(f.store.beginProvisioning(f.identity, lease.id)).rejects.toMatchObject({ code: 'lease_expired_or_revoked' });
    await expect(f.store.checkProvisioning(f.identity, lease.id)).rejects.toMatchObject({ code: 'lease_expired_or_revoked' });
  });

  it('refuses ready until the complete boot inventory is recorded and blocks expired allocation', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    await expect(f.store.markReady(f.identity, lease.id)).rejects.toMatchObject({ code: 'runtime_inventory_incomplete' });
    for (const kind of RUNTIME_RESOURCE_KINDS.filter(k => k !== 'capture')) {
      const intent = await f.store.intendResource(f.identity, lease.id, kind, 'main');
      await f.store.recordResource(f.identity, lease.id, intent.id, { fixtureIdentity: intent.ownership_tag });
    }
    expect((await f.store.markReady(f.identity, lease.id)).state).toBe('ready');
    const capture = await f.store.intendResource(f.identity, lease.id, 'capture', 'first');
    await f.store.recordResource(f.identity, lease.id, capture.id, { opaqueId: randomUUID() });
    await fx.admin`UPDATE harness_shared.blind_review_runtime_leases SET expires_at = clock_timestamp() - interval '1 second' WHERE id = ${lease.id}`;
    await expect(f.store.intendResource(f.identity, lease.id, 'capture', 'second')).rejects.toMatchObject({ code: 'lease_expired_or_revoked' });
  });

  it('never marks release from unknown, surviving, or incomplete discovery; a complete absent census releases', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    const resource = await f.store.intendResource(f.identity, lease.id, 'managed-scope', 'main');
    await f.store.revoke(f.identity, lease.id, 'exercise-ended');
    const proof = { scopeAbsent: true, absentIntentIds: [resource.id], checkedKinds: [...RUNTIME_RESOURCE_KINDS] };
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => { throw new Error('unknown discovery'); })).toBe(false);
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => ({ ...proof, scopeAbsent: false }))).toBe(false);
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => ({ ...proof, absentIntentIds: [] }))).toBe(false);
    expect(await f.store.confirmReleased(f.identity, lease.id, async () => ({ ...proof, checkedKinds: ['managed-scope'] }))).toBe(false);
    // The resource was created but not identity-appended; discovery must still
    // establish absence using its durable ownership tag, not drop it from scope.
    expect(await f.makeStore().confirmReleased(f.identity, lease.id, async resources => {
      expect(resources[0]).toMatchObject({ id: resource.id, identity: null }); return proof;
    })).toBe(true);
    const [row] = await fx.admin`SELECT state FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`;
    expect(row!.state).toBe('released');
    await expect(f.store.intendResource(f.identity, lease.id, 'process', 'late')).rejects.toMatchObject({ code: 'allocation_not_active' });
  });

  it('keeps workspace rows isolated through RLS and composite resource foreign keys', async () => {
    const f = await fixture(), { lease } = await f.allocate();
    await fx.admin.begin(async tx => {
      await tx`SET LOCAL ROLE harness_app`;
      await tx`SELECT set_config('app.workspace_id', 'foreign-workspace', true)`;
      expect(await tx`SELECT * FROM harness_shared.blind_review_runtime_leases WHERE id = ${lease.id}`).toHaveLength(0);
    });
    await expect(fx.admin`INSERT INTO harness_shared.blind_review_runtime_resources
      (id, workspace_id, lease_id, kind, slot, ownership_tag)
      VALUES (${randomUUID()}, 'foreign-workspace', ${lease.id}, 'process', 'foreign', ${'f'.repeat(64)})`)
      .rejects.toMatchObject({ code: '23503' });
  });
});
