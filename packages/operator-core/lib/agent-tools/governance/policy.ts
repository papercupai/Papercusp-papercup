/**
 * governance:policy — the MCP door onto inherited organization/department/workspace policy
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, WI-10007900).
 *
 * A THIN wrapper: every op delegates to governance-policy/control.ts, the one implementation
 * the admin pane's routes and sync query also use, so a tool call and a pane click take the
 * same path and record the same version row.
 *
 * The tool name is load-bearing: enforce.ts#GOVERNANCE_ADMIN_TOOLS exempts exactly
 * 'governance:policy' from the policy seat so a bad policy can always be repaired (anti-lockout).
 * Because the seat does not guard it, the WRITE ops gate on the operator-config-write role here.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES, isOperatorConfigWriteRole } from '@papercusp/agent-mcp';
import {
  addGovernancePolicyException,
  applyGovernancePolicyChange,
  explainGovernancePolicy,
  getGovernancePolicyState,
  governancePolicyAddExceptionSchema,
  governancePolicyApplySchema,
  governancePolicyAuthoritySchema,
  governancePolicyExplainSchema,
  governancePolicyGetSchema,
  governancePolicyPrepareSchema,
  governancePolicySetSchema,
  governancePolicySimulateSchema,
  parseGovernedRequest,
  prepareGovernancePolicyChange,
  readGovernanceAuthority,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
  type PrepareChangeRequest,
  type ProposedLayer,
  type SetLayerRequest,
} from '../../governance-policy/control';
import type { GovernedRequest } from '../../governance-policy/inherited-policy';
import { resolveAgentIdentity } from '../coordination/identity';

type AddExceptionRequest = Parameters<typeof addGovernancePolicyException>[0];

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

/**
 * The actor stamped on a policy version row. Same order as reports/_shared#resolveOwnerId:
 * `ctx.ownerId` is not a field of UnifiedToolContext (some dispatch paths attach one, most do
 * not), so an explicit one wins and the canonical resolver covers the rest. Falls back to the
 * role so a write is never recorded with no actor at all.
 */
function writeActor(ctx: Parameters<typeof resolveAgentIdentity>[0] & { role?: string; ownerId?: string }): string {
  if (ctx.ownerId) return ctx.ownerId;
  try {
    const owner = resolveAgentIdentity(ctx).ownerId;
    if (owner) return owner;
  } catch {
    /* malformed power-user context: fall through to the role */
  }
  return `role:${ctx.role ?? 'unknown'}`;
}

function requireRequest(raw: unknown): GovernedRequest {
  const parsed = parseGovernedRequest(raw);
  if (!parsed.ok) throw new Error(`governance:policy: ${parsed.error}`);
  return parsed.request;
}

export default defineTool({
  name: 'governance:policy',
  profile: 'engineer',
  description:
    'Inherited organization > department > workspace policy over models, tools, plugins, egress, dataUse and actions. ' +
    'get = chain + layers + version history; explain = the verdict the enforcement seat would reach for a request, and which layer decided; ' +
    'simulate = before/after verdicts for a proposed layer (writes nothing); set = write a layer version (actor + reason); ' +
    'add-exception = append an expiring exception. A lower layer can never widen an ancestor. ' +
    'Org/department changes are sensitive: prepare (simulates), a distinct human admin approves in the admin pane, then apply (once, 15 min); authority = delegations + open requests.',
  capability: 'operator:write',
  guidance: {
    when: 'An action was refused with org_policy:* and you need to know which layer refused it and why (explain), or an admin must change or except a policy.',
    notWhen: 'Work-scope (which repos/paths a session may touch) is work-scope:*, not this.',
    chaining: 'simulate a proposed layer before set; pass expectedVersion from get to avoid overwriting a concurrent edit.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  rolesQuota: { operator: { perRun: 40 } },
  args: z.discriminatedUnion('op', [
    governancePolicyGetSchema.extend({ op: z.literal('get') }),
    governancePolicyExplainSchema.extend({ op: z.literal('explain') }),
    governancePolicySimulateSchema.extend({ op: z.literal('simulate') }),
    governancePolicySetSchema.extend({ op: z.literal('set') }),
    governancePolicyAddExceptionSchema.extend({ op: z.literal('add-exception') }),
    governancePolicyPrepareSchema.extend({ op: z.literal('prepare') }),
    governancePolicyApplySchema.extend({ op: z.literal('apply') }),
    governancePolicyAuthoritySchema.extend({ op: z.literal('authority') }),
  ]),
  async handler(args, ctx) {
    if (args.op === 'authority') {
      const { op: _op, ...req } = args;
      return json(await readGovernanceAuthority({ ...req, workspaceId: req.workspaceId ?? ctx.workspaceId }));
    }
    // An agent is a SERVICE identity (P-006, D-015): it may prepare and apply a sensitive change,
    // but approving one is a human administrator's act in the admin pane, so there is no decide op.
    if (args.op === 'prepare' || args.op === 'apply') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        throw new Error(`governance:policy ${args.op} requires operator, architect, or mug role`);
      }
      const actor = writeActor(ctx);
      if (args.op === 'prepare') {
        const { op: _op, requests, ...req } = args;
        return json(
          await prepareGovernancePolicyChange(
            { ...(req as Omit<PrepareChangeRequest, 'requests'>), requests: requests?.map(requireRequest) },
            actor,
          ),
        );
      }
      const { op: _op, ...req } = args;
      return json(await applyGovernancePolicyChange(req, actor));
    }
    if (args.op === 'set' || args.op === 'add-exception') {
      if (!isOperatorConfigWriteRole(ctx.role)) {
        throw new Error(`governance:policy ${args.op} requires operator, architect, or mug role`);
      }
      const actor = writeActor(ctx);
      // The wire schemas keep category keys as plain strings on purpose: control.ts validates
      // them against the governed set (validateLayerInput) and names that set in its error, which
      // a zod enum refusal would not. These casts hand the parsed shape to that validator.
      if (args.op === 'set') {
        const { op: _op, ...req } = args;
        return json(await setGovernancePolicyLayer(req as SetLayerRequest, actor));
      }
      const { op: _op, ...req } = args;
      return json(await addGovernancePolicyException(req as AddExceptionRequest, actor));
    }

    const workspaceId = args.workspaceId ?? ctx.workspaceId;
    if (!workspaceId) throw new Error('governance:policy: pass workspaceId (this session has no workspace)');

    if (args.op === 'get') {
      return json(await getGovernancePolicyState(workspaceId, { versionLimit: args.versionLimit }));
    }
    if (args.op === 'explain') {
      return json(await explainGovernancePolicy(workspaceId, requireRequest(args.request)));
    }
    return json(
      await simulateGovernancePolicy(workspaceId, args.proposed as ProposedLayer, args.requests.map(requireRequest)),
    );
  },
});
