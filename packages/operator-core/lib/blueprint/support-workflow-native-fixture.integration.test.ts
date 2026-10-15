import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';
import type { ZodTypeAny } from 'zod';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { seedSupportWorkflowNativeFixture, supportWorkflowNativeLoginScript,
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

const connection = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
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
});
