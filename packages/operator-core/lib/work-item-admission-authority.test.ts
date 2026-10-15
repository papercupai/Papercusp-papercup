/** Real canonical replay gates with controlled policy I/O; no live datastore. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { KernelEnforcementRequest, UnifiedToolContext } from '@papercusp/agent-mcp';

const h = vi.hoisted(() => ({
  state: {} as Record<string, unknown>, auditMode: false, audit: vi.fn(),
  sql: vi.fn(), token: 'hermetic-test-token', expectedAdvSessionId: null as number | null,
}));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./superuser-token', async (original) => ({
  ...await original<typeof import('./superuser-token')>(), readSuperuserToken: () => h.token,
}));
vi.mock('./modes/store', async (original) => ({
  ...await original<typeof import('./modes/store')>(),
  getModes: async () => h.auditMode ? [{ mode: 'audit' }] : [],
}));
vi.mock('./tool-authz-audit', () => ({ recordToolAuthzEvent: h.audit }));
vi.mock('./capability-envelope/session-confinement-store', () => ({}));
vi.mock('./capability-envelope-overrides', () => ({
  envelopeRoleOverrides: () => ({}), envelopeProtectedAdditions: () => [],
}));
vi.mock('@papercusp/flags/server', async (original) => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => false,
}));

import {
  admissionCredentialDigest, admissionReplayContext, authorizeAdmissionReplay, bindAdmissionAuthority,
} from './work-item-admission-authority';
import { installControlAnchorKernelResolver, readControlAnchorKernelState, setKernelEnforcementResolver } from './projected-tool-deps';
import { setSessionConfinementResolver } from './capability-envelope/session-confinement-port';

const revision = { specificationRevision: 'a'.repeat(64), stateRevision: 'current-a' };
const context = {
  workspaceId: 'ws-policy', harnessSlug: 'original-harness', profile: 'engineer' as const,
  runId: 'original-run', spawnId: 'original-spawn', parentSpawnId: null, chunkId: 'original-chunk',
  featureId: null, planRunSessionId: null, transport: 'mcp' as const,
};
const scope = { workspaceId: 'ws-policy', harnessSlug: 'papercusp', workItemId: 'WI-original' };
function bound(over: Partial<UnifiedToolContext> = {}) {
  return bindAdmissionAuthority({
    ...context, role: 'operator', isSuperuser: true, uiClientId: 'su-policy',
    signal: new AbortController().signal, log: () => {}, emit: () => {}, progress: () => {},
    admissionRecoveryAuthority: {
      kind: 'superuser', role: 'operator', credentialSha256: admissionCredentialDigest(h.token),
    },
    ...over,
  });
}
function activation() {
  return {
    schemaVersion: 1, attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
    desired: revision, prepared: null, applied: revision, status: 'applied',
  };
}
function authorize(authority = bound()) {
  return authorizeAdmissionReplay(h.sql as unknown as Sql, scope, {
    caller: 'su-policy', target: 'su-reviewer', authority,
  });
}

beforeEach(() => {
  h.state = { activation: activation() };
  h.auditMode = false;
  h.expectedAdvSessionId = null;
  h.audit.mockReset();
  h.sql.mockReset().mockImplementation(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?');
    if (!query.includes('FROM harness_shared.session_briefs')) throw new Error(`unexpected policy I/O: ${query}`);
    // The current control-anchor query reads the brief and launch identity
    // together. Six cache-header comparisons are null on this fresh fixture;
    // both subqueries remain bound to the same owner/workspace pair, followed
    // by the exact-session selectors for the legacy or native replay context.
    expect(values).toEqual([
      'su-policy', 'ws-policy',
      ...Array(12).fill(null),
      'su-policy', 'ws-policy',
      h.expectedAdvSessionId, h.expectedAdvSessionId,
    ]);
    return [{
      control_state: h.state, control_generation: 7, workspace_id: 'ws-policy',
      ...(h.expectedAdvSessionId !== null ? {
        adv_session_id: h.expectedAdvSessionId,
        adv_session_xmin: '4200',
        launch_header_known: false,
        launch_spec_type: 'object',
        launch_spec_workspace_id: 'ws-policy',
        launch_spec_harness_slug: 'original-harness',
        launch_spec_has_accepted_operation: false,
        launch_spec_accepted_operation: null,
      } : {}),
    }];
  });
  installControlAnchorKernelResolver(); // same installation as events/index at tool bootstrap
  setSessionConfinementResolver(() => null);
});
afterEach(async () => {
  setKernelEnforcementResolver(null);
  setSessionConfinementResolver(undefined);
  // The production kernel deliberately turns failed authority reads into a
  // denial. A broken SQL fake must also report its original failure here, so
  // contract drift cannot masquerade as the confinement/audit verdict we test.
  const authorityReads = h.sql.mock.calls.flatMap(([parts], index) => {
    if (!Array.isArray(parts) || !parts.join('?').includes('FROM harness_shared.session_briefs')) return [];
    const result = h.sql.mock.results[index];
    return result?.type === 'return' ? [result.value] : [];
  });
  const reads = await Promise.allSettled(authorityReads);
  expect(reads.filter(result => result.status === 'rejected'), 'authority fixture I/O failed').toEqual([]);
});

describe('admission replay policy fidelity', () => {
  it('does not persist the workspace-wide harness sentinel as a replay identity', () => {
    expect(bound({ harnessSlug: '*' })).toBeUndefined();
  });

  it('renews current applied state at both canonical tool seats, without persisting the stamp', async () => {
    const authority = bound({
      appliedExecutionRevision: revision, executionRevision: revision,
      kernelEnforcement: { decision: 'allow', applied: true, revisionSource: 'applied', executionRevision: revision },
    });
    expect(authority?.context).toEqual(context);
    const replay = await admissionReplayContext(h.sql as unknown as Sql, scope, 'su-policy', authority);
    expect(replay).not.toHaveProperty('appliedExecutionRevision');
    await expect(authorize(authority)).resolves.toBeUndefined();
    // coord:dispatch and work_items:claim each traverse preflight AND enforce.
    const anchorReads = h.sql.mock.calls.filter(([parts]) =>
      Array.isArray(parts) && parts.join('?').includes('FROM harness_shared.session_briefs'));
    expect(anchorReads).toHaveLength(4);
    h.state = { lifecycle: { released: { at: 'after-queue' } } };
    await expect(authorize(authority)).rejects.toThrow('revoked');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({
      decision: 'deny', reason: expect.stringContaining('[preflight:kernel-preflight]'),
    }));
  });

  it('preserves the transport-verified native incarnation for exact-session replay selectors', async () => {
    const advSessionId = 42;
    const authority = bound({ advSessionId });
    expect(authority?.context).toEqual({ ...context, advSessionId });

    const replay = await admissionReplayContext(h.sql as unknown as Sql, scope, 'su-policy', authority);
    expect(replay.advSessionId).toBe(advSessionId);

    h.expectedAdvSessionId = advSessionId;
    const request = {
      phase: 'enforce',
      boundary: 'dispatch',
      toolName: 'work_items:claim',
      capabilities: [],
      args: { row: 'WI-original,su-reviewer,papercusp' },
      ctx: replay,
    } satisfies KernelEnforcementRequest;
    const state = await readControlAnchorKernelState(request);
    expect(state?.identityLaunchRecordVersion).toEqual({ sessionId: '42', rowVersion: '4200' });
  });

  it.each([
    { appliedExecutionRevision: revision },
    { appliedExecutionRevision: revision, executionRevision: revision,
      kernelEnforcement: { decision: 'deny' as const, applied: true, revisionSource: 'applied' as const, executionRevision: revision } },
    { kernelState: { appliedRevision: revision } },
    { kernelOwnership: { required: true, resourceOwnerId: 'someone-else' } },
    { requestedExecutionRevision: revision },
    { kernelBoundary: 'reaction' as const },
  ])('refuses unrenewable explicit context without dropping its constraint: %j', (extra) => {
    expect(() => bound(extra)).toThrow('not renewable');
  });

  it('rechecks confinement even for the superuser and at the inner claim seat', async () => {
    const authority = bound();
    setSessionConfinementResolver(() => ({
      denyTools: ['work_items:claim'], reason: 'review only now', imposedBy: 'director',
    }));
    await expect(authorize(authority)).rejects.toThrow('review only now');
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', gate: 'capability' }));
  });

  it('rechecks current audit mode before the inner claim instead of inheriting an earlier allow', async () => {
    const authority = bound();
    await expect(authorize(authority)).resolves.toBeUndefined();
    h.auditMode = true;
    await expect(authorize(authority)).rejects.toThrow('AUDIT mode');
  });
});
