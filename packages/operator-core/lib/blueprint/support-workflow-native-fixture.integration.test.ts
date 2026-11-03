import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Sql } from 'postgres';
import type { ZodTypeAny } from 'zod';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { prepareSupportWorkerAccountReferences, seedSupportWorkflowNativeFixture, supportWorkflowNativeLoginScript, setSupportWorkflowNativeReviewerAccess,
  type SupportWorkflowNativeFixture } from '../../../../apps/operator/e2e/_support-workflow-native-fixture';
import { registerRoute, type RouteDefinition } from '../endpoint-route/define-route';
import authLogin from '../endpoint-route/routes/auth/login';
import authMe from '../endpoint-route/routes/auth/me';
import { principalFromCookie } from '../auth/principal/from-cookie';
import { submitBlueprintOperation } from './operation-service';
import { resolveAcceptedOperationWorkerBinding } from './operation-worker-binding';
import { readHostedAllocationReport } from '../auth/hosted/billing/allocation-store';
import { replacePermissionListMembers, searchOrganizationDocuments } from '../data-sources/documents-corpus';
import { runWithWorkspace } from '../workspace-als';
import { resolveProjectDir } from '../spawn-config';
import { assembleRolePrompt } from '@papercusp/orchestrator/role-prompt';
import { readWorkflowAdministration } from './support-workflow-administration';
import { loadExternalTriggerAdminSnapshot } from '../external-triggers/admin';
import { currentBenchCodexSubscriptionContract } from '../external-bench/current-su';

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
const workerAccount = vi.hoisted(() => ({ resolve: vi.fn() }));
const accountPool = vi.hoisted(() => ({ load: vi.fn(), update: vi.fn() }));
vi.mock('../deployment/account-pool-store', () => ({ loadAccountPool: accountPool.load, updateAccountPool: accountPool.update }));
vi.mock('../endpoint-route/routes/agent-mcp/bootstrap-su', () => ({ resolveAccountPin: workerAccount.resolve }));
vi.mock('@papercusp/db-org', async original => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: connection.sql }),
}));

let db: OrgTestDb;
let fixture: SupportWorkflowNativeFixture;
const workspaceId = 'verify-tauri-isolated-support-pg';
beforeAll(async () => {
  db = await createOrgTestDb(); connection.sql = db.adminSql;
  fixture = await seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId });
}, 120_000);
afterAll(async () => db?.cleanup(), 120_000);

describe('maintained native support seed and production cookie switching', () => {
  it('transfers only explicit eligible account references into the disposable workspace', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'support-account-reference-'));
    const path = join(directory, 'references.json');
    const environmentKey = 'PAPERCUSP_NATIVE_REFERENCE_TEST';
    const previous = process.env[environmentKey];
    process.env[environmentKey] = 'synthetic-test-only-never-export';
    const { registerAccount } = await import('../deployment/account-pool');
    const pool = registerAccount({ accounts: [] }, { id: 'native-test', provider: 'codex',
      credentialRef: `env:${environmentKey}` }, Date.now());
    accountPool.load.mockResolvedValue(pool);
    try {
      await expect(prepareSupportWorkerAccountReferences('', path)).rejects.toThrow(/explicit source/);
      await prepareSupportWorkerAccountReferences('source-test-workspace', path);
      expect(accountPool.load).toHaveBeenCalledWith('source-test-workspace');
      const content = await readFile(path, 'utf8');
      expect(content).not.toContain(process.env[environmentKey]);
      expect((await stat(path)).mode & 0o077).toBe(0);
      workerAccount.resolve.mockResolvedValueOnce({ provider: 'codex', gatewayAuto: true });
      await seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId, workerAccountReferenceFile: path,
        requireWorkerAccount: true });
      expect(accountPool.update).toHaveBeenLastCalledWith(expect.any(Function), workspaceId);
      const imported = accountPool.update.mock.calls.at(-1)![0]({ accounts: [] });
      expect(imported.accounts).toMatchObject([{ id: 'native-test', boundTo: [], softPin: [], credentialRef: `env:${environmentKey}` }]);
      const subscription = { ...pool.accounts[0], credentialRef: 'codex-cli:/unread-subscription-home' };
      accountPool.load.mockResolvedValueOnce({ accounts: [subscription] });
      await expect(prepareSupportWorkerAccountReferences('source-test-workspace', join(directory, 'subscription.json')))
        .rejects.toThrow(/Codex API-key account/);
      await writeFile(path, JSON.stringify({ accounts: [subscription] }), { mode: 0o600 });
      const updatesBefore = accountPool.update.mock.calls.length;
      await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId, workerAccountReferenceFile: path,
        requireWorkerAccount: true })).rejects.toThrow(/Codex API-key accounts/);
      expect(accountPool.update).toHaveBeenCalledTimes(updatesBefore);
      await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId,
        workerAccountReferenceFile: 'relative.json' })).rejects.toThrow(/outside the checkout/);
    } finally {
      if (previous === undefined) delete process.env[environmentKey]; else process.env[environmentKey] = previous;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('refuses unavailable private worker routing before creating journey users', async () => {
    const users = () => db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.users`;
    const before = await users();
    for (const route of [
      { error: 'no allowed codex account', provider: null },
      { provider: 'claude', gatewayAuto: true },
      { provider: 'codex', gatewayAuto: false },
    ]) {
      workerAccount.resolve.mockResolvedValueOnce(route);
      await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId, requireWorkerAccount: true }))
        .rejects.toThrow(/worker account preflight refused/);
    }
    expect(workerAccount.resolve).toHaveBeenLastCalledWith(workspaceId, 'auto', 'codex', undefined, false, 'gpt-6.1-sol');
    expect(await users()).toEqual(before);
    workerAccount.resolve.mockResolvedValueOnce({ provider: 'codex', gatewayAuto: true });
    const admitted = await seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId, requireWorkerAccount: true });
    expect(admitted.workspaceId).toBe(workspaceId);
  });

  it('imports only the explicitly selected subscription payer and freezes its distinct native contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'support-subscription-reference-'));
    const path = join(directory, 'references.json');
    const secret = 'never-emit-me';
    const nativePayer = { payer: 'subscription' as const, inputTokenCeiling: 500, outputTokenCeiling: 500 };
    const { registerAccount } = await import('../deployment/account-pool');
    const subscription = registerAccount({ accounts: [] }, { id: 'native-subscription', provider: 'codex',
      credentialRef: `codex-cli:${directory}` }, Date.now()).accounts[0]!;
    const apiKey = { ...subscription, id: 'excluded-api-key', credentialRef: 'env:UNREAD_API_KEY' };
    accountPool.load.mockResolvedValueOnce({ accounts: [apiKey, subscription] });
    try {
      await writeFile(join(directory, 'auth.json'), JSON.stringify({ access_token: secret }));
      await writeFile(join(directory, 'models_cache.json'), JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', context_window: 500, max_context_window: 500 },
      ] }));
      await prepareSupportWorkerAccountReferences('source-test-workspace', path, nativePayer);
      const content = await readFile(path, 'utf8');
      expect(content).not.toContain(secret);
      expect((await stat(path)).mode & 0o077).toBe(0);
      expect(JSON.parse(content)).toMatchObject({ nativePayer, accounts: [{ id: subscription.id }] });
      expect(JSON.parse(content).accounts).toHaveLength(1);
      workerAccount.resolve.mockResolvedValueOnce({ provider: 'codex', gatewayAuto: true });
      const seeded = await seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId,
        workerAccountReferenceFile: path, requireWorkerAccount: true });
      expect(accountPool.update.mock.calls.at(-1)![0]({ accounts: [] }).accounts)
        .toMatchObject([{ id: subscription.id, credentialRef: subscription.credentialRef, boundTo: [], softPin: [] }]);
      expect(seeded.blueprint.operations![0]!.policy.supportCase).toMatchObject({ maximumCostMicros: 100_000,
        native: { ...nativePayer, account: 'auto', model: 'gpt-6.1-sol', effort: 'medium',
          inputTokenCeilingSourceSha256: currentBenchCodexSubscriptionContract('gpt-6.1-sol', 500, 500) } });
      // Re-read metadata on import: a previously prepared bundle cannot retain
      // smaller limits after its selected account advertises a larger window.
      await writeFile(join(directory, 'models_cache.json'), JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', context_window: 1000, max_context_window: 1000 },
      ] }));
      const updatesBefore = accountPool.update.mock.calls.length;
      await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId,
        workerAccountReferenceFile: path, requireWorkerAccount: true })).rejects.toThrow(/each cover.*model window/);
      expect(accountPool.update).toHaveBeenCalledTimes(updatesBefore);
      // A newly frozen simulation allocation is explicit and keeps the same
      // operation/ancestor budget writers. It is never inferred from routing.
      const largerPayer = { payer: 'subscription' as const, inputTokenCeiling: 1000,
        outputTokenCeiling: 1000, simulationBudgetMicros: 2_000_000 };
      accountPool.load.mockResolvedValueOnce({ accounts: [apiKey, subscription] });
      const largerPath = join(directory, 'larger-reference.json');
      await prepareSupportWorkerAccountReferences('source-test-workspace', largerPath, largerPayer);
      const larger = await seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId,
        workerAccountReferenceFile: largerPath });
      expect(larger.blueprint.operations![0]!.policy.supportCase).toMatchObject({ maximumCostMicros: 2_000_000,
        native: { payer: 'subscription', inputTokenCeiling: 1000, outputTokenCeiling: 1000 } });
      const allocations = (await readHostedAllocationReport(db.adminSql, larger.funding)).byCostClass.model.allocations;
      expect(allocations).toHaveLength(3);
      for (const allocation of allocations)
        expect(allocation).toMatchObject({ capMicros: 2_000_000, maxUnreconciledMicros: 2_000_000 });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses missing limits, payer mismatches and over-budget full-window reservations before importing or creating users', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'support-subscription-refusal-'));
    const path = join(directory, 'references.json');
    const users = () => db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.users`;
    const before = await users(), updatesBefore = accountPool.update.mock.calls.length;
    const { registerAccount } = await import('../deployment/account-pool');
    const account = registerAccount({ accounts: [] }, { id: 'wrong-payer', provider: 'codex',
      credentialRef: 'env:UNREAD_API_KEY' }, Date.now()).accounts[0]!;
    try {
      for (const [nativePayer, error] of [
        [{ payer: 'subscription' }, /explicit positive provider token ceilings/],
        [{ payer: 'subscription', inputTokenCeiling: 0, outputTokenCeiling: 100 }, /explicit positive/],
        [{ payer: 'subscription', inputTokenCeiling: 872_000, outputTokenCeiling: 128_000 }, /full-limit reservation.*exceeds.*unchanged/],
        [{ payer: 'subscription', inputTokenCeiling: 1000, outputTokenCeiling: 100 }, /Codex subscription accounts/],
        [{ payer: 'unknown' }, /payer selection is invalid/],
        [{ payer: 'subscription', inputTokenCeiling: 500, outputTokenCeiling: 500, simulationBudgetMicros: 0 }, /simulation budget must be positive/],
        [{ payer: 'subscription', inputTokenCeiling: 500, outputTokenCeiling: 500, simulationBudgetMicros: 1_000_000_001 }, /simulation budget must be positive/],
        [{ payer: 'api-key', simulationBudgetMicros: 2_000_000 }, /payer selection is invalid/],
      ] as const) {
        await writeFile(path, JSON.stringify({ accounts: [account], nativePayer }), { mode: 0o600 });
        await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId,
          workerAccountReferenceFile: path, requireWorkerAccount: true })).rejects.toThrow(error);
      }
      await expect(prepareSupportWorkerAccountReferences('source-test-workspace', join(directory, 'not-created.json'),
        { payer: 'subscription', inputTokenCeiling: 872_000, outputTokenCeiling: 128_000 }))
        .rejects.toThrow(/full-limit reservation.*exceeds.*unchanged/);
      expect(accountPool.update).toHaveBeenCalledTimes(updatesBefore);
      expect(await users()).toEqual(before);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('requires model metadata and refuses an undersized input or output ceiling for a subscription', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'support-subscription-limits-'));
    const path = join(directory, 'references.json');
    const { registerAccount } = await import('../deployment/account-pool');
    const account = registerAccount({ accounts: [] }, { id: 'subscription-limits', provider: 'codex',
      credentialRef: `codex-cli:${directory}` }, Date.now()).accounts[0]!;
    const updatesBefore = accountPool.update.mock.calls.length;
    try {
      await writeFile(path, JSON.stringify({ accounts: [account], nativePayer: {
        payer: 'subscription', inputTokenCeiling: 500, outputTokenCeiling: 500,
      } }), { mode: 0o600 });
      await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId,
        workerAccountReferenceFile: path })).rejects.toThrow(/requires installed provider model-window metadata/);
      await writeFile(join(directory, 'models_cache.json'), JSON.stringify({ models: [
        { slug: 'gpt-6.1-sol', context_window: 500, max_context_window: 500 },
      ] }));
      for (const [inputTokenCeiling, outputTokenCeiling] of [[499, 500], [500, 499]]) {
        await writeFile(path, JSON.stringify({ accounts: [account], nativePayer: {
          payer: 'subscription', inputTokenCeiling, outputTokenCeiling,
        } }), { mode: 0o600 });
        await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId,
          workerAccountReferenceFile: path })).rejects.toThrow(/each cover.*model window/);
      }
      expect(accountPool.update).toHaveBeenCalledTimes(updatesBefore);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('refuses a shared workspace and a forged isolated label before any mutation', async () => {
    const forbidden = vi.fn();
    await expect(seedSupportWorkflowNativeFixture(forbidden as unknown as Sql,
      { workspaceId: 'papercusp-workspace' })).rejects.toThrow(/isolated workspace/);
    expect(forbidden).not.toHaveBeenCalled();
    forbidden.mockResolvedValue([{ name: 'papercusp', directory: '/live/pgdata' }]);
    await expect(seedSupportWorkflowNativeFixture(forbidden as unknown as Sql, { workspaceId }))
      .rejects.toThrow(/isolated PostgreSQL/);
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it('refuses a registry writer on a different database before creating any users', async () => {
    const users = () => db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.users`;
    const before = await users();
    connection.sql = vi.fn().mockResolvedValue([{ name: 'live', directory: '/live/pgdata' }]) as unknown as Sql;
    try {
      await expect(seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId }))
        .rejects.toThrow(/registry must use the same isolated PostgreSQL/);
    } finally { connection.sql = db.adminSql; }
    expect(await users()).toEqual(before);
  });

  it('installs a disarmed support operation in the Workflows catalog without execution evidence', async () => {
    const catalog = await loadExternalTriggerAdminSnapshot(db.adminSql, workspaceId);
    const bindings = catalog.bindings.filter(binding =>
      binding.action.type === 'blueprint-operation'
      && binding.action.operationHarnessSlug === fixture.harnessSlug
      && binding.action.operationId === fixture.operationId);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ armed: false, sourceKind: 'slack',
      eventPattern: 'ext:slack:message.received', createdBy: fixture.actors.admin.id });
    expect(catalog.sources.find(source => source.id === bindings[0]!.sourceId))
      .toMatchObject({ kind: 'slack', status: 'unconfigured', credentialRef: null });
    expect(catalog.recentRuns).toEqual([]);
    const [invocations] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id=${workspaceId}
      AND harness_slug=${fixture.harnessSlug}`;
    expect(invocations?.n).toBe(0);
  });

  it('switches three real password-authenticated cookie principals and admits only accessible source input', async () => {
    expect(fixture.role).toBe('operator');
    const app = new Hono();
    type Route = RouteDefinition<ZodTypeAny | undefined>;
    for (const route of [authLogin, ...authMe] as Route[]) registerRoute(app, route);
    let cookie = '';
    const evaluate = (actor: keyof typeof fixture.actors) => runInNewContext(
      supportWorkflowNativeLoginScript(fixture, actor), { fetch: async (path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (cookie) headers.set('cookie', cookie);
        const response = await app.request(`http://localhost${path.replace(/^\/api/, '')}`, { ...init, headers });
        if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]!;
        return response;
      } });
    const principals = [];
    for (const actor of ['employee', 'reviewer', 'admin'] as const) {
      expect(await evaluate(actor)).toMatchObject({ actor, userId: fixture.actors[actor].id, workspaceId });
      const principal = await principalFromCookie(new Headers({ cookie }));
      expect(principal).toMatchObject({ kind: 'user', trust: 'verified', authMethod: 'cookie-session',
        slug: fixture.actors[actor].id, workspaceId });
      principals.push(principal!.slug);
    }
    expect(new Set(principals).size).toBe(3);
    const report = await readHostedAllocationReport(db.adminSql, fixture.funding);
    expect(report.byCostClass.model.allocations.find(a => a.allocationId === fixture.funding.allocationId))
      .toMatchObject({ level: 'project', capMicros: 1_000_000 });
    await evaluate('employee');
    const principal = await principalFromCookie(new Headers({ cookie }));
    if (!principal) throw new Error('Authenticated employee cookie principal is missing');
    const found = await runWithWorkspace(workspaceId, () => searchOrganizationDocuments(db.adminSql,
      { workspaceId, role: 'operator', harnessSlug: fixture.harnessSlug }, {
        workspaceId, principalUserId: principal!.slug, agentOwnerId: principal!.slug,
        query: fixture.query, sources: ['slack'], documentIds: [fixture.documentId], limit: 1,
      }));
    expect(found.allowed).toBe(true);
    if (!found.allowed) throw new Error(`Fixture corpus access refused: ${found.reason}`);
    expect(found.results.map(document => document.id)).toEqual([fixture.documentId]);
    const submit = (requestKey: string) => submitBlueprintOperation(db.adminSql, { workspaceId,
      harnessSlug: fixture.harnessSlug, operationId: fixture.operationId, callerId: `${principal!.slug}/employee`,
      requestKey, expectedSpecificationRevision: fixture.approvedRevision, input: fixture.input }, { principal });
    const handle = await submit('native-fixture-employee');
    expect(handle).toMatchObject({ workspaceId, specificationRevision: fixture.approvedRevision });
    if (handle.target.kind !== 'work-item') throw new Error('Native fixture must admit a worker target');
    const worker = await resolveAcceptedOperationWorkerBinding({ sql: db.adminSql, workspaceId,
      harnessSlug: fixture.harnessSlug, workItemId: handle.target.id, role: fixture.role,
      repoDir: fileURLToPath(new URL('../../../../', import.meta.url)) });
    expect(worker).toMatchObject({ workItemId: handle.target.id,
      identity: { ref: 'blueprint-operation-worker' },
      modelPolicy: { mode: 'exact', models: ['gpt-6.1-sol'], effort: 'medium' },
      requiredTools: ['blueprint:read-private-input'] });
    // Bootstrap reads the registry and role prompt after resolving the pin.
    // Admission and a resolvable identity alone do not make a runnable worker.
    const projectDir = await resolveProjectDir(fixture.harnessSlug, workspaceId);
    expect(projectDir).toBe(fileURLToPath(new URL('../../../../', import.meta.url)));
    if (!projectDir) throw new Error('Native support fixture has no registered launch checkout');
    const featureId = handle.target.id;
    expect(() => assembleRolePrompt({ slug: fixture.harnessSlug, role: fixture.role,
      projectDir, mode: 'chat', featureId })).not.toThrow();
    expect(await submit('native-fixture-employee')).toEqual(handle);
    await replacePermissionListMembers(db.adminSql, workspaceId, fixture.listId, [fixture.identities.reviewer]);
    await expect(submit('native-fixture-revoked')).rejects.toThrow(/unavailable|revoked/);
    const [count] = await db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id=${workspaceId}
      AND request_key='native-fixture-revoked'`;
    expect(count?.n).toBe(0);
  }, 30_000);

  it('retains an unapproved local candidate without changing the native fixture approval', async () => {
    const administration = await readWorkflowAdministration(db.adminSql, { workspaceId,
      harness: fixture.harnessSlug, operationId: fixture.operationId, principalId: fixture.actors.admin.id });
    expect(administration).toMatchObject({ approvedRevision: fixture.approvedRevision, version: '1',
      accountableOwner: fixture.actors.admin.id, reviewerPrincipals: [fixture.actors.reviewer.id] });
    expect(fixture.candidateRevision).not.toBe(fixture.approvedRevision);
    expect(administration.retainedRevisions).toContainEqual({ revision: fixture.candidateRevision, version: '2' });
    expect(administration.history).toEqual([]);
  });

  it('measures reviewer grant and source ACL denials independently without manufacturing execution evidence', async () => {
    const selected = await seedSupportWorkflowNativeFixture(db.adminSql, { workspaceId });
    const keys = await db.adminSql<{ key: string }[]>`SELECT encode(public_key, 'hex') AS key
      FROM harness_shared.pots WHERE workspace_id=${workspaceId}
      AND pot_home_slug IN (${fixture.harnessSlug}, ${selected.harnessSlug})`;
    expect(keys).toHaveLength(2);
    expect(new Set(keys.map(row => row.key)).size).toBe(2);
    const evidence = () => db.adminSql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM harness_shared.blueprint_operation_invocations WHERE workspace_id=${workspaceId}
      AND harness_slug=${selected.harnessSlug}`;
    const before = await evidence();
    expect(await setSupportWorkflowNativeReviewerAccess(db.adminSql, selected, 'no-grant'))
      .toMatchObject({ allowed: false, documentIds: [], reason: 'no_live_grant' });
    expect(await setSupportWorkflowNativeReviewerAccess(db.adminSql, selected, 'no-source-acl'))
      .toMatchObject({ allowed: true, documentIds: [] });
    expect(await setSupportWorkflowNativeReviewerAccess(db.adminSql, selected, 'allowed'))
      .toMatchObject({ allowed: true, documentIds: [selected.documentId] });
    expect(await evidence()).toEqual(before);
    const forbidden = vi.fn();
    await expect(setSupportWorkflowNativeReviewerAccess(forbidden as unknown as Sql,
      { ...selected, workspaceId: 'papercusp-workspace' }, 'no-grant')).rejects.toThrow(/isolated workspace/);
    expect(forbidden).not.toHaveBeenCalled();
    await expect(setSupportWorkflowNativeReviewerAccess(db.adminSql,
      { ...selected, listId: crypto.randomUUID() }, 'no-grant')).rejects.toThrow(/does not match/);
    expect(await setSupportWorkflowNativeReviewerAccess(db.adminSql, selected, 'allowed'))
      .toMatchObject({ allowed: true, documentIds: [selected.documentId] });
  }, 30_000);
});
