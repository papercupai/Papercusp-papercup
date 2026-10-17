/**
 * release:test-downgrade — plan green-main-ratchet-convergence-2026-10-17, P-002/P-003.
 *
 * The one door for making a failing test non-blocking for main (D-002: fix, eject, THEN
 * downgrade). `create` refuses an incomplete record; a critical-area test also needs an
 * acknowledgement naming its area and risk, and notifies the owner at once (D-006).
 * `digest` is the daily-digest feed; `revoke` makes the test block again.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import {
  pgTestDowngradeStore,
  startOfUtcDay,
  validateTestDowngrade,
  type TestDowngradeRecord,
  type TestDowngradeStore,
} from '../../release/test-downgrade-store';
import { CRITICAL_AREAS, type CriticalArea } from '../../release/critical-area-registry';
import { resolveAgentIdentity, type AgentIdentity } from '../coordination/identity';
import { sendMessage } from '../coordination/messages';

export interface TestDowngradeDeps {
  store(scope: { workspaceId: string; harnessSlug: string }): TestDowngradeStore;
  notifyOwner(identity: AgentIdentity, notice: { summary: string; body: string; harnessSlug: string }): Promise<void>;
  now(): Date;
}

export const defaultTestDowngradeDeps: TestDowngradeDeps = {
  store: (scope) => pgTestDowngradeStore(getOrgPg().sql, scope),
  async notifyOwner(identity, notice) {
    await sendMessage(identity, { to: ['human'], summary: notice.summary, body: notice.body, expectsReply: false, harnessSlug: notice.harnessSlug });
  },
  now: () => new Date(),
};

export const testDowngradeArgs = z.object({
  op: z.enum(['create', 'list', 'revoke', 'digest']).describe('create a downgrade; list active ones; revoke one; digest = created today'),
  harness: z.string().min(1).max(120).optional().describe('pot slug; defaults to the operator home harness'),
  testFile: z.string().min(1).max(500).optional().describe('create: repo-relative test file, or a gate leg id such as lint:tsc'),
  testCase: z.string().max(1000).optional().describe('create: the full failing case name (D-005: one case, not the file)'),
  reason: z.string().max(4000).optional().describe('create: why it can be neither fixed nor ejected now'),
  owner: z.string().max(200).optional().describe('create: who owns making it blocking again'),
  bugId: z.string().max(120).optional().describe('create: the filed bug for the failure'),
  acknowledgement: z
    .object({ area: z.string().max(60), risk: z.string().max(2000) })
    .optional()
    .describe('create, critical-area tests only: { area: <area id>, risk: <what may break> }'),
  id: z.number().int().positive().optional().describe('revoke: the downgrade id'),
});

type Args = z.infer<typeof testDowngradeArgs>;
type Ctx = { workspaceId?: unknown; harnessSlug?: string | null };

const json = (payload: unknown) => ({ data: payload });

function scopeOf(args: Args, ctx: Ctx) {
  const workspace = typeof ctx.workspaceId === 'string' ? ctx.workspaceId.trim() : '';
  return {
    workspaceId: workspace && workspace !== '*' ? workspace : activeWorkspaceId(),
    harnessSlug: args.harness?.trim() || operatorHomeHarnessSlug(),
  };
}

function criticalNotice(record: TestDowngradeRecord, area: CriticalArea) {
  const target = record.testCase ? `${record.testFile} > ${record.testCase}` : record.testFile;
  return {
    summary: `Critical-area test downgraded (${area.label}): ${target}`.slice(0, 240),
    body: [
      `A failing test in the critical area **${area.label}** was downgraded to non-blocking, so main can promote while it fails.`,
      `Risk: ${area.risk}.`,
      `Test: ${target}`,
      `Reason: ${record.reason}`,
      `Owner: ${record.owner} · Bug: ${record.bugId} · By: ${record.author}`,
      `Acknowledged risk: ${record.riskAcknowledgement ?? ''}`,
      `Revoke: release:test-downgrade { op: 'revoke', id: ${record.id} }`,
    ].join('\n'),
  };
}

export function makeTestDowngradeHandler(deps: TestDowngradeDeps = defaultTestDowngradeDeps) {
  return async function handler(args: Args, ctx: Ctx) {
    let identity: AgentIdentity;
    try {
      identity = resolveAgentIdentity(ctx as never);
    } catch {
      return json({ ok: false, refused: true, reason: 'authentication_required' });
    }
    const scope = scopeOf(args, ctx);
    const store = deps.store(scope);

    if (args.op === 'list') return json({ ok: true, ...scope, active: await store.listActive() });
    if (args.op === 'digest') {
      const since = startOfUtcDay(deps.now());
      return json({ ok: true, ...scope, since: since.toISOString(), createdToday: await store.listCreatedSince(since) });
    }
    if (args.op === 'revoke') {
      if (!args.id) return json({ ok: false, refused: true, reason: 'missing_id' });
      const revoked = await store.revoke(args.id, identity.ownerId, args.reason?.trim() || 'revoked');
      if (!revoked) return json({ ok: false, refused: true, reason: 'not_active', id: args.id });
      return json({ ok: true, revoked, note: 'The test blocks main again.' });
    }

    const validation = validateTestDowngrade({
      testFile: args.testFile ?? '',
      testCase: args.testCase,
      reason: args.reason,
      owner: args.owner,
      bugId: args.bugId,
      author: identity.ownerId,
      acknowledgement: args.acknowledgement,
    });
    if (!validation.ok) {
      return json({
        ok: false,
        refused: true,
        reason: 'incomplete_downgrade_record',
        problems: validation.problems,
        criticalArea: validation.criticalArea,
        ...(validation.criticalArea ? { criticalAreas: CRITICAL_AREAS.map((area) => area.id) } : {}),
      });
    }
    const inserted = await store.insert(validation.record);
    if ('conflict' in inserted) {
      return json({ ok: false, refused: true, reason: 'already_downgraded', existing: inserted.conflict });
    }
    let ownerNotified = false;
    if (validation.criticalArea) {
      await deps.notifyOwner(identity, { ...criticalNotice(inserted, validation.criticalArea), harnessSlug: scope.harnessSlug });
      await store.markOwnerNotified(inserted.id, deps.now());
      ownerNotified = true;
    }
    return json({ ok: true, downgrade: inserted, warning: validation.warning, criticalArea: validation.criticalArea, ownerNotified });
  };
}

export default defineTool({
  name: 'release:test-downgrade',
  profile: 'engineer',
  description:
    'Downgrade ONE failing test case so it stops blocking main promotion, after fixing and ejecting were ruled out. Refused unless reason, owner and a filed bugId are given; a critical-area test also needs acknowledgement { area, risk } and notifies the owner at once. Ops: create, list, revoke (blocking again), digest (created today).',
  capability: 'operator:write',
  requirePrincipal: false,
  skipWorkspaceTx: true,
  agentRoles: [...SU_ROLES, 'release-fixer', 'release-manager'],
  guidance: {
    when: 'A blocking test fails on the gate candidate and can be neither fixed now nor ejected by attribution.',
    notWhen: 'Before trying a fix or an eject, or to silence a whole file: downgrade the failing case only.',
    chaining: 'file the bug → release:test-downgrade { op:create } → fix → { op:revoke }.',
  },
  args: testDowngradeArgs,
  handler: makeTestDowngradeHandler(),
});
