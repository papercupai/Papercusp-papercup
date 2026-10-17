/** Side effect free replay. History is evidence, never a dispatch input. */
import { withWorkspace } from '@papercusp/db-org';
import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import { evaluatePreToolGuards, ruleMatchesTool } from '../agent-identities/sync-hook-rules';
import { keyMatchesPattern } from './await/pattern';
import type { LocalRuleDefinition, LocalRuleScope } from './local-rule-store';

export interface RuleReplaySample {
  id: string; tool: string; args: unknown; ok: boolean; payload?: unknown;
  source: 'tool-ledger' | 'event-latch' | 'fixture'; inputComplete?: boolean;
  result?: unknown; sink?: string; client?: string;
}
export interface RuleReplayOutcome {
  id: string; tool: string; matched: boolean; eligible?: boolean; action: 'fire' | 'deny' | 'context' | 'none' | 'unknown';
  proposed?: unknown; reason?: string;
}

/** Missing result bodies and truncated arguments must never turn into passing proof. */
function needsUnavailable(condition: unknown, sample: RuleReplaySample): boolean {
  if (!condition || typeof condition !== 'object') return false;
  if (Array.isArray(condition)) return condition.some(c => needsUnavailable(c, sample));
  return Object.entries(condition).some(([path, value]) =>
    ((path === 'result' || path.startsWith('result.')) && sample.result === undefined) ||
    (path === 'client' && sample.client === undefined) ||
    ((path === 'args' || path.startsWith('args.') || path === 'input' || path.startsWith('input.')) && sample.inputComplete === false) ||
    needsUnavailable(value, sample));
}

/** Uses the exact production condition/guard evaluators; no executor/provider imports. */
export function replayRule(rule: LocalRuleDefinition, samples: RuleReplaySample[]): RuleReplayOutcome[] {
  return samples.map(sample => {
    const out = { id: sample.id, tool: sample.tool, matched: false, eligible: false, action: 'none' as RuleReplayOutcome['action'] };
    if (rule.delivery === 'async') {
      if (!keyMatchesPattern(rule.on, sample.tool) || (rule.onlyOnSuccess !== false && !sample.ok)) return out;
      out.eligible = true;
      if (needsUnavailable(rule.when, sample)) return { ...out, action: 'unknown', reason: 'history does not retain the condition inputs' };
      try {
        const trigger = { tool: sample.tool, args: sample.args, key: sample.tool.startsWith('event:') ? sample.tool.slice(6) : sample.tool,
          payload: sample.payload, result: sample.result };
        if (rule.when && !evaluateDataCondition(rule.when as DataCondition, trigger)) return out;
        return { ...out, matched: true, action: 'fire', proposed: { fire: rule.fire, args: rule.args ?? {} } };
      } catch (error) { return { ...out, action: 'unknown', reason: String(error) }; }
    }
    if (!ruleMatchesTool(rule.tools, sample.tool)) return out;
    if (rule.context) return sample.sink === rule.sink ? { ...out, eligible: true, matched: true, action: 'context', proposed: { sink: rule.sink, ...rule.context } } : out;
    out.eligible = true;
    if (needsUnavailable(rule.guard, sample)) return { ...out, action: 'unknown', reason: 'history does not retain the guard inputs' };
    const verdict = evaluatePreToolGuards({ rules: [{ identityId: 'replay', pinRef: 'replay', rule }], unreadable: [] },
      { tool: sample.tool, input: sample.args, client: sample.client ?? '', inputTruncated: sample.inputComplete === false });
    return verdict.decision === 'deny' ? { ...out, matched: true, action: 'deny', reason: verdict.reason } : out;
  });
}

/** Bound at the database, tenant-filtered, newest first. The event latch retains
 * only the latest payload per key: disclose this rather than invent a full log. */
export async function readRuleReplaySamples(scope: LocalRuleScope, rule: LocalRuleDefinition, limit: number,
  harnessSlug?: string): Promise<RuleReplaySample[]> {
  // The invocation ledger has no native turn-start/stop/compaction sink records.
  // Explicit fixtures cover those hooks; never substitute ordinary tool calls.
  if (rule.delivery === 'sync' && rule.context && rule.sink !== 'post-tool') return [];
  const bounded = Math.max(1, Math.min(200, Math.trunc(limit)));
  const event = rule.delivery === 'async' && rule.on.startsWith('event:');
  const patterns = rule.delivery === 'async' ? [rule.on] : rule.tools ?? ['*'];
  const exact = patterns.filter(p => !p.endsWith('*'));
  const prefixes = patterns.filter(p => p.endsWith('*')).map(p => p.slice(0, -1));
  return withWorkspace(scope.workspaceId, async sql => {
    if (event) {
      const pattern = rule.on.slice(6);
      const prefix = pattern.endsWith('*');
      const rows = await sql.unsafe<{ event_key: string; last_payload: unknown; last_fired_at: Date }[]>(
        'SELECT event_key,last_payload,last_fired_at FROM harness_shared.event_key_fires WHERE workspace_id=$1 AND (CASE WHEN $2::boolean THEN starts_with(event_key,$3) ELSE event_key=$3 END) ORDER BY last_fired_at DESC LIMIT $4',
        [scope.workspaceId, prefix, prefix ? pattern.slice(0, -1) : pattern, bounded]);
      return rows.map(row => ({ id: 'event:' + row.event_key + ':' + new Date(row.last_fired_at).toISOString(),
        tool: 'event:' + row.event_key, args: { key: row.event_key, payload: row.last_payload }, payload: row.last_payload,
        ok: true, source: 'event-latch' as const, inputComplete: true }));
    }
    const rows = await sql.unsafe<{ id: string; tool_name: string; args_json: unknown; status: string }[]>(
      'SELECT id::text,tool_name,args_json,status FROM harness_shared.tool_invocations WHERE workspace_id=$1 AND ($2::text IS NULL OR harness_slug=$2) AND (tool_name=ANY($3::text[]) OR EXISTS (SELECT 1 FROM unnest($4::text[]) AS p(prefix) WHERE starts_with(tool_name,p.prefix))) ORDER BY invoked_at DESC,id DESC LIMIT $5',
      [scope.workspaceId, scope.potSlug ? harnessSlug ?? null : null, exact, prefixes, bounded]);
    return rows.map(row => ({ id: 'tool:' + row.id, tool: row.tool_name, args: row.args_json,
      ok: row.status === 'success' || row.status === 'ok', source: 'tool-ledger' as const, sink: 'post-tool',
      inputComplete: row.args_json != null && !(typeof row.args_json === 'object' && (row.args_json as Record<string, unknown>)._truncated === true) }));
  });
}
