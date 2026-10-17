/** Local authorship extends the shared registry and wearer executor (D-006). */
import { withWorkspace } from '@papercusp/db-org';
import { evaluateDataCondition, type DataCondition, type MatchedAction } from '@papercusp/rules';
import { computeDedupId } from '@papercusp/event-reaction';
import { listLocalRules, localRuleSource, type LocalAuthoredRule } from './local-rule-store';
import { registerStandaloneReactionRule } from './standalone-rules';
import { listReactionRules, registerReactionRule, unregisterReactionRule, matchReactions } from './registry';
import { executeIdentityReaction, type IdentityReactionPayload } from './identity-reaction';
import { readIdentityWearer } from '../agent-identities/identity-async-rules';
import { setLocalSyncRulesReader, type WornSyncRules } from '../agent-identities/sync-hook-rules';
import { keyMatchesPattern } from './await/pattern';
import { setLocalRuleMatcher } from './engine';
import type { ReactionCause, ToolInvocationEvent } from './types';

export const LOCAL_RULE_PREFIX = 'standalone:local:';
export function localRuleRegistrationId(row: LocalAuthoredRule): string {
  return LOCAL_RULE_PREFIX + encodeURIComponent(JSON.stringify([row.workspaceId, row.potSlug, row.id, row.revision, row.authorId]));
}
export function localReactionPayload(event: ToolInvocationEvent, cause: ReactionCause): IdentityReactionPayload {
  if (!cause.ruleId.startsWith(LOCAL_RULE_PREFIX)) throw new Error('not_local_rule');
  const [workspaceId, potSlug, id, revision, ownerId] = JSON.parse(decodeURIComponent(cause.ruleId.slice(LOCAL_RULE_PREFIX.length))) as [string, string | null, string, number, string];
  if (workspaceId !== event.ctx.workspaceId) throw new Error('local_rule_workspace_mismatch');
  const trigger = { tool: event.tool, args: event.args, result: event.result,
    key: event.tool.startsWith('event:') ? event.tool.slice(6) : event.tool,
    payload: event.tool.startsWith('event:') ? (event.args as { payload?: unknown })?.payload : event.result.data };
  return {
    receiptId: computeDedupId({ rule: { id: cause.ruleId, on: event.tool, fire: '' }, event, cause, rootRunId: event.ctx.runId }),
    workspaceId, ownerId, revisionTag: String(revision), pinRef: cause.ruleId,
    subscriberId: '', eventKey: event.tool, fireId: event.ctx.runId ?? cause.rootRunId ?? '',
    eventPayload: event.result.data,
    localRule: { id, potSlug, revision, trigger, cause },
  };
}
export async function fireLocalReaction(event: ToolInvocationEvent, cause: ReactionCause) {
  const result = await executeIdentityReaction(localReactionPayload(event, cause));
  return result.status === 'fired' || result.status === 'replayed' ? { ok: true } :
    { ok: false, error: result.status === 'refused' ? result.code + ': ' + result.reason : result.error };
}

/** Serialize refresh+match per workspace: one registry, no stale/partial snapshots. */
const refreshing = new Map<string, Promise<unknown>>();
export async function matchLocalRules(event: ToolInvocationEvent): Promise<MatchedAction<ToolInvocationEvent, string>[]> {
  const workspaceId = event.ctx.workspaceId;
  if (!workspaceId) return [];
  const prior = refreshing.get(workspaceId) ?? Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    const rows = await withWorkspace(workspaceId, tx => listLocalRules({ workspaceId }, { allPots: true, enabledOnly: true }, tx));
    const current = new Set(rows.map(localRuleRegistrationId));
    for (const registered of listReactionRules()) {
      if (!registered.id.startsWith(LOCAL_RULE_PREFIX)) continue;
      const address = JSON.parse(decodeURIComponent(registered.id.slice(LOCAL_RULE_PREFIX.length))) as unknown[];
      if (address[0] === workspaceId && !current.has(registered.id)) unregisterReactionRule(registered.id);
    }
    let potSlug: string | null = null;
    if (event.ctx.harnessSlug && event.ctx.harnessSlug !== '*') {
      const { resolvePotSlugsForHarnesses } = await import('../memory/hive-scope');
      potSlug = (await resolvePotSlugsForHarnesses(workspaceId, [event.ctx.harnessSlug]))[0] ?? null;
    }
    const eligible = new Set<string>();
    for (const row of rows) {
      const rule = row.definition;
      if (rule.delivery !== 'async' || (potSlug && row.potSlug && row.potSlug !== potSlug) || !keyMatchesPattern(rule.on, event.tool)) continue;
      const id = localRuleRegistrationId(row);
      eligible.add(id);
      const result = await withWorkspace(workspaceId, tx =>
        registerStandaloneReactionRule(tx, workspaceId, { ...rule, id: id.slice('standalone:'.length), on: event.tool }));
      if (!result.ok) throw new Error(result.error);
      const registered = listReactionRules().find(r => r.id === id)!;
      // Local data uses the ordinary pure matcher; execution always re-reads the row.
      registerReactionRule({ ...registered, mode: 'sync', source: localRuleSource(row), when: (e: ToolInvocationEvent) =>
        e.ctx.workspaceId === workspaceId && keyMatchesPattern(rule.on, e.tool) &&
        (!rule.when || evaluateDataCondition(rule.when as DataCondition, {
          tool: e.tool, args: e.args, result: e.result,
          key: e.tool.startsWith('event:') ? e.tool.slice(6) : e.tool,
          payload: e.tool.startsWith('event:') ? (e.args as { payload?: unknown })?.payload : e.result.data,
        })) });
    }
    return matchReactions(event).filter(action => eligible.has(action.rule.id));
  });
  refreshing.set(workspaceId, task);
  try { return await task; } finally { if (refreshing.get(workspaceId) === task) refreshing.delete(workspaceId); }
}

/** Called only in an operator host. Each trigger reloads authoritative enabled rows,
 * including after a restart; no process cache can keep an edited rule enabled. */
export async function readLocalSyncRules(ownerId: string, workspaceId: string): Promise<WornSyncRules> {
  const wearer = await readIdentityWearer(ownerId, workspaceId);
  if (!wearer?.harnessSlug) return { rules: [], unreadable: [] };
  const { resolvePotSlugsForHarnesses } = await import('../memory/hive-scope');
  const potSlug = (await resolvePotSlugsForHarnesses(workspaceId, [wearer.harnessSlug]))[0];
  if (!potSlug) return { rules: [], unreadable: [] };
  const rows = await withWorkspace(workspaceId, tx =>
    listLocalRules({ workspaceId, potSlug }, { includeWorkspace: true, enabledOnly: true }, tx));
  return { rules: rows.flatMap(row => row.authorId === ownerId && row.definition.delivery === 'sync'
    ? [{ identityId: localRuleRegistrationId(row), pinRef: localRuleRegistrationId(row), rule: row.definition }] : []), unreadable: [] };
}
export function startLocalRuleRuntime(): void {
  setLocalRuleMatcher(matchLocalRules, fireLocalReaction);
  setLocalSyncRulesReader(readLocalSyncRules);
}
