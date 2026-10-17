/** Agent-authored lifecycle: portable definitions, scoped rows, revision-bound proof. */
import { z } from 'zod';
import { HOOK_SINKS } from '@papercusp/orchestrator/blueprint';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { withWorkspace } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { resolvePotSlugsForHarnesses } from '../../memory/hive-scope';
import { validateClassFireTarget } from '../../events/class-fire-target';
import { listReactionRules } from '../../events/registry';
import { enumerateSelfDescribingDirs } from '../../cupboard/self-describing-store';
import { readRuleDir, ruleRoots } from '../../cupboard/rule-store';
import { getLocalRule, listLocalRules, putLocalRule, setLocalRuleEnabled, deleteLocalRule,
  validateLocalRule, recordLocalRuleTest, type LocalRuleScope } from '../../events/local-rule-store';
import { readRuleReplaySamples, replayRule } from '../../events/authored-rule-test';

const scopeArgs = { scope: z.enum(['pot', 'workspace']).default('pot') };
const idArgs = { ...scopeArgs, id: z.string().trim().min(1).max(200) };
const definition = z.record(z.string(), z.unknown());
const metadata = {
  requirePrincipal: false, agentRoles: [...SU_ROLES],
  guidance: {
    when: 'Author or inspect a local rule. Creates and edits start disabled; replay its current revision before enabling.',
    notWhen: 'To change built-in/plugin rules or grant capabilities. Local rules run as their author within current wearer and pot ceilings.',
    chaining: 'rules:validate → rules:create → rules:test → rules:enable; rules:disable or rules:delete recovers a bad rule.',
    seeAlso: ['rules:list', 'rules:test', 'rules:disable'],
  },
};
async function address(args: { scope: 'pot' | 'workspace' }, ctx: { workspaceId?: string; harnessSlug?: string }) {
  const identity = resolveAgentIdentity(ctx as Parameters<typeof resolveAgentIdentity>[0]);
  if (!identity.workspaceId || !identity.ownerId) throw new Error('rule_identity_required');
  const harness = ctx.harnessSlug;
  let potSlug: string | null = null;
  if (args.scope === 'pot') {
    if (!harness || harness === '*') throw new Error('rule_pot_scope_requires_harness');
    potSlug = (await resolvePotSlugsForHarnesses(identity.workspaceId, [harness]))[0] ?? null;
    if (!potSlug) throw new Error('rule_pot_scope_unresolved');
  }
  return { scope: { workspaceId: identity.workspaceId, potSlug } satisfies LocalRuleScope, ownerId: identity.ownerId, harness };
}
async function validated(value: Record<string, unknown>, scope: LocalRuleScope) {
  const rule = validateLocalRule({ schemaVersion: 1, ...value });
  if (rule.delivery === 'async') {
    const check = await withWorkspace(scope.workspaceId, sql => validateClassFireTarget(sql, scope.workspaceId, rule.fire));
    if (!check.ok) throw new Error(check.error);
  }
  return rule;
}
export const validateRuleTool = defineTool({
  ...metadata, name: 'rules:validate', capability: 'intel:read',
  description: 'Validate a portable async or sync rule using the shared grammar, condition bounds, class targets and hook budgets. Writes nothing.',
  args: z.object({ ...scopeArgs, definition }),
  async handler(args, ctx) {
    const { scope } = await address(args, ctx);
    return { data: { ok: true, rule: await validated(args.definition, scope) } };
  },
});
export const createRuleTool = defineTool({
  ...metadata, name: 'rules:create', capability: 'coord:write',
  description: 'Create a disabled local rule in Postgres, or edit your rule with expectedRevision. Edits invalidate prior replay proof and disable execution.',
  args: z.object({ ...scopeArgs, definition, expectedRevision: z.number().int().min(1).optional() }),
  async handler(args, ctx) {
    const { scope, ownerId } = await address(args, ctx);
    const rule = await validated(args.definition, scope);
    return { data: { ok: true, source: 'local', rule: await withWorkspace(scope.workspaceId, sql =>
      putLocalRule({ ...scope, authorId: ownerId, definition: { schemaVersion: 1, ...rule }, expectedRevision: args.expectedRevision }, sql)) } };
  },
});
export const listRulesTool = defineTool({
  ...metadata, name: 'rules:list', capability: 'intel:read',
  description: 'List local, built-in, plugin and inert Cupboard rules with explicit source and enabled state. Local scope defaults to the current pot.',
  args: z.object({ ...scopeArgs, q: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(100) }),
  async handler(args, ctx) {
    const { scope } = await address(args, ctx);
    const local = await withWorkspace(scope.workspaceId, sql => listLocalRules(scope, { includeWorkspace: args.scope === 'pot' }, sql));
    const registered = listReactionRules().filter(r => !r.id.startsWith('standalone:local:')).map(r => ({
      id: r.id, source: r.source?.startsWith('plugin:') ? 'plugin' : 'builtin', provenance: r.source ?? 'builtin', on: r.on, fire: r.fire, enabled: true,
    }));
    const packages = enumerateSelfDescribingDirs(ruleRoots(), readRuleDir).map(rule => ({
      id: rule.id, ref: rule.ref, source: 'cupboard', delivery: rule.delivery, enabled: false, activation: 'wear through a blueprint',
    }));
    const rows = [...local.map(rule => ({ source: 'local', ...rule })), ...registered, ...packages]
      .filter(row => !args.q || JSON.stringify(row).toLowerCase().includes(args.q.toLowerCase()));
    return { data: { ok: true, rules: rows.slice(0, args.limit), total: rows.length, truncated: rows.length > args.limit } };
  },
});
export const getRuleTool = defineTool({
  ...metadata, name: 'rules:get', capability: 'intel:read', description: 'Read a local rule definition, revision, enabled state and replay receipt in the requested scope.',
  args: z.object(idArgs),
  async handler(args, ctx) {
    const { scope } = await address(args, ctx);
    const rule = await withWorkspace(scope.workspaceId, sql => getLocalRule(scope, args.id, sql));
    return { data: { ok: rule !== null, source: 'local', rule } };
  },
});
export const enableRuleTool = defineTool({
  ...metadata, name: 'rules:enable', capability: 'coord:write', description: 'Enable a local rule only when rules:test passed for its current revision. Execution still rechecks author identity and ceilings.',
  args: z.object(idArgs),
  async handler(args, ctx) {
    const { scope } = await address(args, ctx);
    const row = await withWorkspace(scope.workspaceId, sql => getLocalRule(scope, args.id, sql));
    if (!row) throw new Error('rule_missing');
    await validated({ schemaVersion: 1, ...row.definition }, scope);
    return { data: { ok: true, rule: await withWorkspace(scope.workspaceId, sql => setLocalRuleEnabled(scope, args.id, true, sql)) } };
  },
});
export const disableRuleTool = defineTool({
  ...metadata, name: 'rules:disable', capability: 'coord:write', description: 'Disable any local rule in this scope immediately. No passing test or author ownership is required to recover from a bad rule.',
  args: z.object(idArgs),
  async handler(args, ctx) {
    const { scope } = await address(args, ctx);
    return { data: { ok: true, rule: await withWorkspace(scope.workspaceId, sql => setLocalRuleEnabled(scope, args.id, false, sql)) } };
  },
});
export const deleteRuleTool = defineTool({
  ...metadata, name: 'rules:delete', capability: 'coord:write', description: 'Delete a local rule in this scope; the runtime re-reads authoritative rows before execution.',
  args: z.object(idArgs),
  async handler(args, ctx) {
    const { scope } = await address(args, ctx);
    return { data: { ok: await withWorkspace(scope.workspaceId, sql => deleteLocalRule(scope, args.id, sql)) } };
  },
});
export const testRuleTool = defineTool({
  ...metadata, name: 'rules:test', capability: 'coord:write',
  description: 'Dry-run a draft or saved rule over at most 200 matching historical triggers. Never dispatches actions or providers. Saved rules get revision-bound proof only with nonempty, complete evidence. Event history retains the latest payload per key, not every occurrence; tool result bodies are unavailable.',
  args: z.object({ ...scopeArgs, id: z.string().trim().min(1).max(200).optional(), definition: definition.optional(),
    fixtures: z.array(z.object({ tool: z.string().min(1).max(200), input: z.unknown().optional(), result: z.unknown().optional(),
      payload: z.unknown().optional(), ok: z.boolean().default(true), sink: z.enum(HOOK_SINKS).optional(), client: z.string().max(80).optional(),
    })).max(20).optional().describe('Optional bounded fixtures for unavailable result bodies or native hook sinks. Evaluated by the same pure matcher; never dispatches providers.'),
    limit: z.number().int().min(1).max(200).default(50) }).refine(a => Boolean(a.id) !== Boolean(a.definition), 'provide exactly one of id or definition'),
  async handler(args, ctx) {
    const { scope, harness } = await address(args, ctx);
    const saved = args.id ? await withWorkspace(scope.workspaceId, sql => getLocalRule(scope, args.id!, sql)) : null;
    if (args.id && !saved) throw new Error('rule_missing');
    const rule = await validated(args.definition ?? { schemaVersion: 1, ...saved!.definition }, scope);
    const history = await readRuleReplaySamples(scope, rule, args.limit, harness);
    const samples = [...history, ...(args.fixtures ?? []).map((fixture, index) => ({ ...fixture, args: fixture.input,
      id: 'fixture:' + index, source: 'fixture' as const, inputComplete: true }))];
    const outcomes = replayRule(rule, samples);
    const passed = outcomes.some(o => o.eligible !== false) && outcomes.every(o => o.action !== 'unknown');
    const receipt = { passed, samples: samples.length, fixtureSamples: args.fixtures?.length ?? 0, matched: outcomes.filter(o => o.matched).length,
      history: rule.delivery === 'async' && rule.on.startsWith('event:') ? 'latest-per-event-key' : 'tool-invocation-arguments-without-result-bodies',
      sampleRefs: samples.map(s => s.id), outcomes, testedAt: new Date().toISOString() };
    if (saved && samples.length) await withWorkspace(scope.workspaceId, sql => recordLocalRuleTest(scope, saved.id, saved.revision, receipt, sql));
    return { data: { ok: true, ...receipt, ...(saved ? { id: saved.id, revision: saved.revision } : {}) } };
  },
});
