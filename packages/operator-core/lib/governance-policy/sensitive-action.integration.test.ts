/**
 * P-006 (plan papercusp-enterprise-readiness-roadmap-2026-10-09, WI-10007901, D-015) over real Postgres.
 *
 * ENT-P-006-OUTCOME: a separated sensitive action executes only after the required distinct authorized
 * approvers approve it. The sample sensitive action is an organization/department governance policy
 * change, driven through the same control functions every door (governance:policy tool, admin pane
 * route) calls. Fixture: org-acme > dept-a > ws-a, org-acme > dept-b > ws-b, with delegations:
 *   admin:root      bootstrap root on org-acme (prepare, approve, delegate)
 *   admin:alice     approve + prepare on org-acme
 *   su-agent-1      prepare on org-acme (a SERVICE identity: an agent session)
 *   admin:dept-a    prepare + approve on dept-a only (a delegated department administrator)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import {
  applyGovernancePolicyChange,
  decideGovernancePolicyChange,
  prepareGovernancePolicyChange,
  setGovernancePolicyLayer,
  type GovernancePolicyControlDeps,
  type PrepareChangeRequest,
} from './control';
import {
  authorize,
  createOrganizationLayer,
  grantDelegation,
  recordBootstrapDelegation,
  revokeDelegation,
} from './authority';
import {
  decideSensitiveAction,
  executeSensitiveAction,
  getSensitiveAction,
  prepareSensitiveAction,
  SENSITIVE_ACTION_EXECUTION_WINDOW_MS,
} from './sensitive-action';
import { listVersions, loadChainForWorkspace, loadLayer, upsertLayer, type UpsertLayerInput } from './store';
import { evaluateInheritedPolicy } from './inherited-policy';

const SQL_DIR = '../../../../libs/papercusp/libs/db/sql/';
const MIGRATIONS = ['1497-governance-policy-layers.sql', '1498-governance-sensitive-actions.sql'].map((f) =>
  fileURLToPath(new URL(`${SQL_DIR}${f}`, import.meta.url)),
);

let sql: postgres.Sql;
let clock: Date;
const HOUR = 60 * 60_000;

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `govsensitive_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
  await sql.unsafe(`CREATE SCHEMA harness_shared`);
  for (const file of MIGRATIONS) await sql.unsafe(readFileSync(file, 'utf8'));
}, 60_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

/** Control deps bound to the throwaway database and the test clock. */
function pg(): Partial<GovernancePolicyControlDeps> {
  return {
    loadChain: (workspaceId) => loadChainForWorkspace(workspaceId, sql),
    loadLayer: (layerId) => loadLayer(layerId, sql),
    upsertLayer: (input) => upsertLayer(input, sql),
    authorize: (principal, layerId, capability) => authorize(principal, layerId, capability, { now: clock, sql }),
    createOrganization: async (input) => (await createOrganizationLayer(input, sql)).layer,
    prepareAction: (input) => prepareSensitiveAction(input, sql),
    decideAction: (input) => decideSensitiveAction(input, sql),
    executeAction: (input, run) => executeSensitiveAction(input, run, sql),
    invalidateCache: () => {},
    notify: async () => {},
    now: () => clock,
  };
}

function layer(over: Partial<UpsertLayerInput> & Pick<UpsertLayerInput, 'layerId' | 'level' | 'scopeRef'>): UpsertLayerInput {
  return { parentLayerId: null, rules: {}, exceptions: [], actor: 'admin:root', reason: 'pilot baseline', ...over };
}

async function grant(grantor: string, principal: string, layerId: string, capabilities: string[], hours = 24) {
  return grantDelegation(
    { grantor, principal, layerId, capabilities, reason: 'pilot administration', expiresAt: new Date(clock.getTime() + hours * HOUR), now: clock },
    sql,
  );
}

beforeEach(async () => {
  clock = new Date();
  await sql.unsafe(`TRUNCATE harness_shared.sensitive_action_approvals, harness_shared.sensitive_action_requests,
    harness_shared.governance_delegations, harness_shared.governance_policy_layer_versions,
    harness_shared.governance_policy_layers`);
  await upsertLayer(layer({ layerId: 'org-acme', level: 'organization', scopeRef: 'acme', rules: { models: { allow: ['claude-*'] } } }), sql);
  await upsertLayer(layer({ layerId: 'dept-a', level: 'department', scopeRef: 'a', parentLayerId: 'org-acme' }), sql);
  await upsertLayer(layer({ layerId: 'dept-b', level: 'department', scopeRef: 'b', parentLayerId: 'org-acme' }), sql);
  await upsertLayer(layer({ layerId: 'ws-a', level: 'workspace', scopeRef: 'ws-a', parentLayerId: 'dept-a' }), sql);
  await upsertLayer(layer({ layerId: 'ws-b', level: 'workspace', scopeRef: 'ws-b', parentLayerId: 'dept-b' }), sql);
  await recordBootstrapDelegation(sql, { principal: 'admin:root', layerId: 'org-acme', now: clock });
  await grant('admin:root', 'admin:alice', 'org-acme', ['prepare', 'approve']);
  await grant('admin:root', 'su-agent-1', 'org-acme', ['prepare']);
  await grant('admin:root', 'admin:dept-a', 'dept-a', ['prepare', 'approve']);
});

/** A department-level change that denies processes:kill below dept-a, simulated against ws-a. */
const lockDeptA: PrepareChangeRequest = {
  layerId: 'dept-a',
  level: 'department',
  scopeRef: 'a',
  parentLayerId: 'org-acme',
  rules: { tools: { deny: ['processes:kill'] } },
  workspaceId: 'ws-a',
  reason: 'lock process control for the pilot',
  requests: [{ tools: ['processes:kill'] }],
};

async function prepared(actor = 'su-agent-1', change: PrepareChangeRequest = lockDeptA): Promise<string> {
  const out = await prepareGovernancePolicyChange(change, actor, pg());
  if (!out.ok) throw new Error(`prepare failed: ${out.code} ${out.error}`);
  return out.request.requestId;
}

async function deptAVersion(): Promise<number> {
  return (await loadLayer('dept-a', sql))!.version;
}

describe('ENT-P-006-OUTCOME: a separated sensitive action executes only after distinct authorized approval', () => {
  it('an agent prepares, cannot approve or execute alone, and executes once after a distinct human approves', async () => {
    const id = await prepared();
    const pending = await getSensitiveAction(id, sql);
    expect(pending).toMatchObject({ status: 'pending', preparedBy: 'su-agent-1', baseVersion: 1, authorityLayerId: 'dept-a' });
    expect(pending!.simulation).toMatchObject({ affectsWorkspace: true, changedCount: 1 });

    // Missing approval: execution is refused and nothing is written.
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'not-approved' });
    expect(await deptAVersion()).toBe(1);

    // The agent is a service identity: it can never approve, not even someone else's request.
    expect(await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'lgtm' }, 'su-agent-1', pg())).toMatchObject({
      ok: false,
      code: 'self-approval',
    });
    const otherAgent = await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'lgtm' }, 'su-agent-2', pg());
    // The refusal names the human-only rule, not a missing grant: granting authority can never make a
    // service identity an approver (authority.ts filters approve out and the DB check constraint agrees).
    expect(otherAgent).toMatchObject({ ok: false, code: 'forbidden', error: expect.stringContaining('only a human administrator can decide') });

    const approved = await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'reviewed the simulation' }, 'admin:alice', pg());
    expect(approved).toMatchObject({ ok: true, request: { status: 'approved' } });

    const applied = await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg());
    expect(applied).toMatchObject({ ok: true, revision: 'dept-a@v2', request: { status: 'executed', executedBy: 'su-agent-1' } });
    const history = await listVersions('dept-a', 5, sql);
    expect(history[0]).toMatchObject({ version: 2, actor: 'su-agent-1' });
    expect(history[0]!.reason).toContain('approved by admin:alice');

    // The enforcement path sees the change: ws-a now refuses processes:kill, inherited from dept-a.
    const load = await loadChainForWorkspace('ws-a', sql);
    if (load.status !== 'ok') throw new Error(`chain ${load.status}`);
    expect(evaluateInheritedPolicy(load.chain, { tools: ['processes:kill'] }).allow).toBe(false);

    // Replay: the one-time authorization is spent.
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'replayed' });
    expect(await deptAVersion()).toBe(2);
  });

  it('the same identity can never satisfy both roles: self-approval is refused in code and by the database', async () => {
    const id = await prepared('admin:alice');
    expect(await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'mine' }, 'admin:alice', pg())).toMatchObject({
      ok: false,
      code: 'self-approval',
    });
    await expect(
      sql`INSERT INTO harness_shared.sensitive_action_approvals (request_id, approver, decision, reason) VALUES (${id}, 'admin:alice', 'approve', 'bypass')`,
    ).rejects.toMatchObject({ code: '42501' });
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'pending', approvals: [] });
  });

  it('two required approvals need two DISTINCT authorized approvers', async () => {
    const out = await prepareGovernancePolicyChange({ ...lockDeptA, requiredApprovals: 2 }, 'su-agent-1', pg());
    if (!out.ok) throw new Error(out.error);
    const id = out.request.requestId;
    await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'one' }, 'admin:alice', pg());
    expect(await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'again' }, 'admin:alice', pg())).toMatchObject({
      ok: false,
      code: 'already-decided',
    });
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'not-approved' });
    const second = await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'two' }, 'admin:dept-a', pg());
    expect(second).toMatchObject({ ok: true, request: { status: 'approved' } });
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: true });
  });

  it('an approver without authority over the scope is refused; a delegated department admin approves only its own department', async () => {
    const deptChange = await prepared();
    expect(await decideGovernancePolicyChange({ requestId: deptChange, decision: 'approve', reason: 'x' }, 'admin:mallory', pg())).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    const orgChange = await prepared('su-agent-1', {
      ...lockDeptA,
      layerId: 'org-acme',
      level: 'organization',
      scopeRef: 'acme',
      parentLayerId: null,
      rules: { models: { allow: ['claude-*', 'gpt-*'] } },
    });
    expect(await decideGovernancePolicyChange({ requestId: orgChange, decision: 'approve', reason: 'x' }, 'admin:dept-a', pg())).toMatchObject({
      ok: false,
      code: 'forbidden',
    });
    expect(await decideGovernancePolicyChange({ requestId: deptChange, decision: 'approve', reason: 'mine to approve' }, 'admin:dept-a', pg())).toMatchObject({
      ok: true,
      request: { status: 'approved' },
    });
  });

  it('an expired authorization is refused, and the request is closed', async () => {
    const id = await prepared();
    await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'ok' }, 'admin:alice', pg());
    clock = new Date(clock.getTime() + SENSITIVE_ACTION_EXECUTION_WINDOW_MS + 60_000);
    expect(await applyGovernancePolicyChange({ requestId: id }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'expired' });
    expect(await getSensitiveAction(id, sql)).toMatchObject({ status: 'expired' });
    expect(await deptAVersion()).toBe(1);
  });

  it('apply refuses without a fresh simulation: a change approved against an older chain is cancelled as stale', async () => {
    const first = await prepared();
    const second = await prepared('su-agent-1', { ...lockDeptA, rules: { tools: { deny: ['capability:bash'] } } });
    for (const id of [first, second]) {
      await decideGovernancePolicyChange({ requestId: id, decision: 'approve', reason: 'ok' }, 'admin:alice', pg());
    }
    expect(await applyGovernancePolicyChange({ requestId: first }, 'su-agent-1', pg())).toMatchObject({ ok: true });
    expect(await applyGovernancePolicyChange({ requestId: second }, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'stale' });
    expect(await getSensitiveAction(second, sql)).toMatchObject({ status: 'cancelled' });
    expect((await loadLayer('dept-a', sql))!.rules).toEqual(lockDeptA.rules);
  });
});

describe('delegated administration and ordinary permitted work (R-3)', () => {
  const wsWrite = (layerId: string, parentLayerId: string) => ({
    layerId,
    level: 'workspace' as const,
    scopeRef: layerId,
    parentLayerId,
    rules: { tools: { allow: ['work_items:*'] } },
    reason: 'workspace tool allowance',
  });

  it('a department admin writes its own workspaces directly but nothing outside its delegated scope', async () => {
    expect(await setGovernancePolicyLayer(wsWrite('ws-a', 'dept-a'), 'admin:dept-a', pg())).toMatchObject({ ok: true, revision: 'ws-a@v2' });
    expect(await setGovernancePolicyLayer(wsWrite('ws-b', 'dept-b'), 'admin:dept-a', pg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await setGovernancePolicyLayer(wsWrite('ws-a', 'dept-b'), 'admin:dept-a', pg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect((await loadLayer('ws-b', sql))!.version).toBe(1);
    // An org- or department-level edit is never a direct write, even for the root administrator.
    expect(
      await setGovernancePolicyLayer({ ...wsWrite('dept-a', 'org-acme'), level: 'department', scopeRef: 'a' }, 'admin:root', pg()),
    ).toMatchObject({ ok: false, code: 'approval-required' });
  });

  it('authority is bounded: no self-grant, no escalation beyond the grantor, no approve for a service identity', async () => {
    await expect(grant('admin:dept-a', 'admin:eve', 'org-acme', ['prepare'])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(grant('admin:dept-a', 'admin:dept-a', 'dept-a', ['prepare'])).rejects.toMatchObject({ code: 'forbidden' });
    await expect(grant('admin:root', 'su-agent-2', 'org-acme', ['approve'])).rejects.toMatchObject({ code: 'invalid' });
    await expect(grant('admin:root', 'admin:eve', 'org-acme', ['prepare'], 24 * 120)).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      sql`INSERT INTO harness_shared.governance_delegations (principal, principal_kind, layer_id, capabilities, granted_by, reason, expires_at)
          VALUES ('su-agent-9', 'service', 'org-acme', ARRAY['approve'], 'admin:root', 'bypass', now() + interval '1 day')`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('revoked and expired delegations stop authorizing, and grant rows are revoke-only', async () => {
    const short = await grant('admin:root', 'admin:temp', 'dept-b', ['prepare'], 1);
    expect(await authorize('admin:temp', 'ws-b', 'prepare', { now: clock, sql })).toBe(true);
    expect(await authorize('admin:temp', 'ws-b', 'prepare', { now: new Date(clock.getTime() + 2 * HOUR), sql })).toBe(false);
    await revokeDelegation({ delegationId: short.delegationId, revoker: 'admin:root', reason: 'pilot ended', now: clock }, sql);
    expect(await authorize('admin:temp', 'ws-b', 'prepare', { now: clock, sql })).toBe(false);
    await expect(sql`DELETE FROM harness_shared.governance_delegations WHERE delegation_id = ${short.delegationId}`).rejects.toMatchObject({
      code: '55000',
    });
  });

  it('only a human can bootstrap a new organization, and an administered organization cannot be re-rooted', async () => {
    const org = { layerId: 'org-new', level: 'organization' as const, scopeRef: 'new', parentLayerId: null, rules: {}, reason: 'new tenant' };
    expect(await setGovernancePolicyLayer(org, 'su-agent-1', pg())).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await setGovernancePolicyLayer(org, 'admin:founder', pg())).toMatchObject({ ok: true, revision: 'org-new@v1' });
    expect(await authorize('admin:founder', 'org-new', 'delegate', { now: clock, sql })).toBe(true);
    await expect(recordBootstrapDelegation(sql, { principal: 'admin:usurper', layerId: 'org-new', now: clock })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
