// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileAgentSpecification, type ResolvedCapabilityProviderInput } from '@papercusp/orchestrator/blueprint';
import { dispatchProjectedTool, type ProjectedTool, type UnifiedToolContext } from '@papercusp/agent-mcp';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import type { IdentityGrantPolicy } from '../capability-envelope/identity-grants-port';

const io = vi.hoisted(() => ({ sql: null as unknown, readPolicy: vi.fn() }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: io.sql }),
}));
vi.mock('../pot-membership', async (original) => ({
  ...(await original<typeof import('../pot-membership')>()),
  workItemStorageSlug: async (harness: string) => harness === 'sales-app' ? 'sales' : harness,
}));
vi.mock('../capability-envelope/identity-grants-port', async (original) => {
  const actual = await original<typeof import('../capability-envelope/identity-grants-port')>();
  return {
    ...actual,
    checkIdentityGrantKernel: (request: never, state: never, record: unknown) =>
      actual.checkIdentityGrantKernel(request, state, record, io.readPolicy),
  };
});

import {
  controlAnchorKernelResolver,
  installControlAnchorKernelResolver,
  wrapOperatorKernelSpawn,
} from '../projected-tool-deps';

const WS = 'operation-worker-integration';
const OWNER = 'role-operation-worker-integration';
const CLASS = 'mail.provider@1.0.0';
let db: FreshPgDb;

function ctx(kernelBoundary?: 'dispatch' | 'indirect-dispatch'): UnifiedToolContext {
  return {
    workspaceId: WS, uiClientId: OWNER, isSuperuser: true,
    ...(kernelBoundary ? { kernelBoundary } : {}),
    log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), emit: vi.fn(),
  } as unknown as UnifiedToolContext;
}

function tool(name: string, fn: ProjectedTool['fn']): ProjectedTool {
  return { pluginName: 'operation-worker-fixture', description: 'fixture',
    inputSchema: { type: 'object' }, capabilities: [], expose: { mcp: { name } }, fn };
}

beforeAll(async () => {
  db = await createFreshPgDb('operation-worker-kernel');
  io.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      role text,
      launch_spec jsonb, started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz, ended_by text
    );
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY, workspace_id text NOT NULL,
      control_state jsonb, control_generation integer
    );
    CREATE TABLE harness_shared.work_items (
      workspace_id text NOT NULL, feature_id text NOT NULL, harness_slug text NOT NULL,
      payload jsonb, taken_by text
    );
  `);
}, 90_000);

afterAll(async () => db?.cleanup(), 300_000);

describe('accepted operation worker at the real PostgreSQL identity receipt', () => {
  it.each(['sales', 'sales-app'])('permits only current claimed effects for launch harness %s, including a pot member stored at its home', async (launchHarness) => {
    await db.sql`DELETE FROM harness_shared.work_items`;
    await db.sql`DELETE FROM harness_shared.session_briefs`;
    await db.sql`DELETE FROM harness_shared.adv_sessions`;
    const provider: ResolvedCapabilityProviderInput = {
      kind: 'capability-provider', ref: CLASS, providerPackage: 'mail-provider',
      providerVersion: '1.0.0', conformanceRunId: 'run-a', registryRevision: 'registry-a',
      verbBindings: { send: 'mail:send', read: 'mail:read' },
    };
    const artifact = compileAgentSpecification({
      source: { id: 'operation-worker-fixture', workItem: { kind: 'feature' },
        spine: { edges: { DONE: { to: 'done' } } }, grants: { requires: [CLASS] } },
      prompt: { role: 'worker', text: 'Execute the accepted operation.' }, inputClosure: [provider],
    });
    const revision = { specificationRevision: artifact.specificationRevision, stateRevision: 'state-a' };
    const pin = { kind: 'blueprint-operation', harnessSlug: launchHarness, operationId: 'send',
      specificationRevision: 'a'.repeat(64), operationVersion: '1.0.0', input: {} };
    const acceptedOperation = { kind: 'blueprint-operation-worker', workItemId: 'WI-1',
      operationId: 'send', specificationRevision: 'a'.repeat(64), pin,
      identity: { ref: 'operation-worker-fixture', revision: '1.0.0', contentHash: 'b'.repeat(64) },
      requiredTools: ['mail:send'] };
    const launchSpec = { workspaceId: WS, harnessSlug: launchHarness, role: 'worker', ...revision,
      specificationArtifact: artifact, acceptedOperation };
    const activation = { schemaVersion: 1,
      attribution: { actorId: OWNER, principalId: OWNER, sessionId: OWNER },
      desired: revision, prepared: null, applied: revision, status: 'applied' };
    await db.sql`
      INSERT INTO harness_shared.adv_sessions (id, workspace_id, coord_owner_id, role, launch_spec)
      VALUES (1, ${WS}, ${OWNER}, 'worker', ${db.sql.json(JSON.parse(JSON.stringify(launchSpec)))})
    `;
    await db.sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, control_state, control_generation)
      VALUES (${OWNER}, ${WS}, ${db.sql.json({ activation })}, 1)
    `;
    await db.sql`INSERT INTO harness_shared.work_items (workspace_id, feature_id, harness_slug, payload, taken_by)
      VALUES (${WS}, 'WI-1', 'sales', ${db.sql.json({ blueprintOperation: pin })}, ${OWNER})`;
    const binding = {
      classRef: CLASS, providerPackage: provider.providerPackage,
      providerVersion: provider.providerVersion, conformanceRunId: provider.conformanceRunId,
      registryRevision: provider.registryRevision, verbBindings: provider.verbBindings,
      status: 'active' as const, conformanceStatus: 'passed' as const,
      behavioralStatus: 'not-required' as const, behavioralRunRef: null,
      potSlug: 'sales', boundBy: 'admin', boundAt: '2026-09-24', updatedAt: '2026-09-24',
    };
    const policy: IdentityGrantPolicy = {
      policyRevision: 'policy-a', potSlug: 'sales', bindings: [binding],
      ceilings: [{ allowCapabilities: ['mail:send', 'mail:read'] }],
      tools: new Map([['mail:send', ['mail:send']], ['mail:read', ['mail:read']]]),
      protectedAdditions: [],
    };
    io.readPolicy.mockResolvedValue(policy);
    const send = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'sent' }] }));
    const read = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'read' }] }));

    expect((await dispatchProjectedTool(tool('mail:send', send), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    })).ok).toBe(true);
    expect(send).toHaveBeenCalledOnce();
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'replacement-worker' WHERE feature_id = 'WI-1'`;
    for (const boundary of ['dispatch', 'indirect-dispatch'] as const) {
      const stale = await dispatchProjectedTool(tool('mail:send', send), 'mail:send', {}, ctx(boundary), {
        kernelEnforcement: controlAnchorKernelResolver,
      });
      expect(stale.ok).toBe(false);
      expect(stale.error?.message).toContain('no longer holds the item');
    }
    expect(send).toHaveBeenCalledOnce();
    await db.sql`UPDATE harness_shared.work_items SET taken_by = ${OWNER} WHERE feature_id = 'WI-1'`;
    for (const boundary of ['dispatch', 'indirect-dispatch'] as const) {
      const refused = await dispatchProjectedTool(tool('mail:read', read), 'mail:read', {}, ctx(boundary), {
        kernelEnforcement: controlAnchorKernelResolver,
      });
      expect(refused.ok).toBe(false);
      expect(refused.error?.message).toContain('outside-ceiling');
    }
    expect(read).not.toHaveBeenCalled();

    installControlAnchorKernelResolver();
    const spawn = vi.fn(async () => ({ stdout: '', stderr: '', code: 0, killed: false }));
    await expect(wrapOperatorKernelSpawn(spawn, ctx(), ['mail:send'])('sh', ['-c', 'true']))
      .rejects.toThrow('outside-ceiling');
    expect(spawn).not.toHaveBeenCalled();

    io.readPolicy.mockResolvedValue({ ...policy, policyRevision: 'policy-revoked', bindings: [] });
    const revoked = await dispatchProjectedTool(tool('mail:send', send), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    });
    expect(revoked.ok).toBe(false);
    expect(revoked.error?.message).toContain('provider-unbound');
    expect(send).toHaveBeenCalledOnce();

    io.readPolicy.mockResolvedValue(policy);
    await db.sql`
      UPDATE harness_shared.adv_sessions SET launch_spec = ${db.sql.json(JSON.parse(JSON.stringify({
        ...launchSpec, acceptedOperation: { ...acceptedOperation, requiredTools: [] },
      })))} WHERE id = 1
    `;
    const narrowed = await dispatchProjectedTool(tool('mail:send', send), 'mail:send', {}, ctx(), {
      kernelEnforcement: controlAnchorKernelResolver,
    });
    expect(narrowed.ok).toBe(false);
    expect(narrowed.error?.message).toContain('outside-ceiling');
    expect(send).toHaveBeenCalledOnce();
  }, 90_000);
});
