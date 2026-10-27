/** Passive successful-workaround demand. Observed sequences are not causal diagnoses. */
import { createHmac } from 'node:crypto';
import { isSensitiveValueKey, redactSensitiveText } from '../sensitive-text';
import type { SqlIntentScope } from '../bash-substitution/sql-intent-fingerprint';
import { collapseRecoveryCopies, fetchOperationObservations, observeResultRecovery,
  type RecoveryCorpusOptions, type RecoveryObservation, type RecoverySource } from './result-recovery';

type Obj = Record<string, unknown>;
const object = (v: unknown): Obj => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const string = (v: unknown) => typeof v === 'string' ? v : '';
export type RepairKind = 'parameter' | 'schema' | 'build' | 'availability';
export interface WorkaroundObservation extends RecoveryObservation {
  contextTokens: string[];
  repair: RepairKind | null;
  buildToken: string | null;
  durationMs: number | null;
  manualRead: boolean;
}
const hash = (scope: SqlIntentScope, kind: string, value: string) => createHmac('sha256', scope.key)
  .update(JSON.stringify(['workaround-v1', scope.workspaceId, scope.sourceBoundary, scope.epoch, kind, value])).digest('hex');

function bodyFacts(value: unknown): { body: Obj; diagnostic: string } {
  let body = object(value), diagnostic = '';
  if (Array.isArray(body.content)) {
    diagnostic = body.content.map(b => string(object(b).text)).join('\n');
    try { body = object(JSON.parse(diagnostic)); } catch { body = {}; }
  }
  if (!diagnostic) diagnostic = JSON.stringify(body);
  return { body, diagnostic };
}
function contextWords(value: unknown, scope: SqlIntentScope, depth = 0): string[] {
  if (depth > 8) return [];
  if (Array.isArray(value)) return value.slice(0, 100).flatMap(v => contextWords(v, scope, depth + 1));
  if (value && typeof value === 'object') return Object.entries(object(value))
    .filter(([k]) => !isSensitiveValueKey(k) && !['projection', 'cursor', 'after', 'limit', 'offset'].includes(k))
    .flatMap(([, v]) => contextWords(v, scope, depth + 1));
  return typeof value === 'string' ? redactSensitiveText(value, scope.knownSecrets).toLowerCase().split(/[^a-z0-9_-]+/)
    .filter(w => w.length >= 4 && !['true', 'false', 'null', 'select', 'from', 'where', 'json', 'query', 'redacted', 'secret'].includes(w)) : [];
}
function sanitized(value: unknown, scope: SqlIntentScope, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === 'string') return redactSensitiveText(value, scope.knownSecrets);
  if (Array.isArray(value)) return value.slice(0, 100).map(v => sanitized(v, scope, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(object(value)).sort(([a], [b]) => a.localeCompare(b))
    .filter(([k]) => !isSensitiveValueKey(k)).map(([k, v]) => [k, sanitized(v, scope, depth + 1)]));
  return value;
}

/** Only exact, complete source/result pairs may establish success. Error strings
 * classify observed friction locally; raw messages, parameters and credentials never leave. */
export function observeWorkaround(source: RecoverySource, scope: SqlIntentScope): WorkaroundObservation | null {
  const identity = observeResultRecovery(source, scope);
  if (!identity) return null;
  const paired = source.identityAuthority !== 'unknown' && !!source.callId && source.result?.complete === true
    && source.result.callId === source.callId && source.result.provider === source.provider && source.result.namespace === source.namespace;
  const { body, diagnostic } = paired ? bodyFacts(source.result!.body) : { body: {}, diagnostic: '' };
  // Text MCP errors are not JSON objects but still carry an explicit settled refusal.
  const failed = paired && (identity.outcome === 'error' || identity.outcome === 'refused'
    || object(source.result!.body).isError === true || body.state === 'error' || body.success === false
    || body.error != null && body.error !== false && body.error !== ''
    || /^(?:handler_error|stale_tool_contract|invalid_input):/i.test(diagnostic));
  const repair: RepairKind | null = !failed ? null
    : /stale_tool_contract|server.*running build|build[_ -](?:mismatch|outdated)|runtime[_ -]mismatch/i.test(diagnostic) ? 'build'
      : /(?:relation|column).*does not exist|schema[_ -](?:mismatch|lookup)|undefined_column|undefined_table/i.test(diagnostic) ? 'schema'
        : /tool[_ -]not[_ -]found|unknown[_ -]tool|unavailable|not[_ -]installed|no matching.*tool/i.test(diagnostic) ? 'availability'
          : /invalid[_ -](?:args|input|parameter)|unrecognized key|expected.*received|required.*(?:field|argument)/i.test(diagnostic) ? 'parameter' : null;
  const build = string(body.servingBuild) || /server.*running build\s+([a-f0-9]{7,64})/i.exec(diagnostic)?.[1] || '';
  const command = string(object(source.args).command) || string(object(source.args).cmd);
  const manualRead = ['capability:bash', 'capability:terminal', 'exec_command'].includes(source.tool)
    && /^(?:rg|grep|git\s+grep|cat)\s/.test(command.trim()) && !/[;|&`\n]|\$\(/.test(command);
  const shell = object(object(source.result?.body).structuredContent);
  const settled = Object.keys(shell).length ? shell : body;
  const shellExit = settled.exit_code ?? settled.exitCode;
  // Preserve completeness at both the transport wrapper and the actual shell
  // result. A settled zero exit cannot prove that bounded output was recovered.
  const manualIdentity = manualRead ? observeResultRecovery({ ...source,
    result: source.result ? { ...source.result, body: settled } : null }, scope) : null;
  const outcome = failed ? 'error' : !manualRead ? identity.outcome
    : !paired || identity.outcome !== 'success' || manualIdentity?.outcome !== 'success'
      || typeof shellExit !== 'number' || settled.running === true || settled.yielded === true ? 'UNKNOWN'
      : shellExit === 0 ? 'success' : 'error';
  return { ...identity, requestToken: hash(scope, 'request', JSON.stringify([source.tool, sanitized(source.args, scope)])),
    outcome,
    contextTokens: [...new Set(contextWords(source.args, scope).map(w => hash(scope, 'context', w)))].sort(),
    repair, buildToken: build ? hash(scope, 'build', build) : null,
    durationMs: typeof source.durationMs === 'number' && Number.isFinite(source.durationMs) && source.durationMs >= 0 ? source.durationMs : null,
    manualRead,
  };
}
export interface WorkaroundEpisode {
  id: string; scopeToken: string; actorToken: string; tool: string; repair: RepairKind;
  operations: WorkaroundObservation[]; extraCalls: number; elapsedMs: number; callTimeMs: number | null;
  finalOutcomeRef: string | null; evidence: 'observed-sequence' | 'incomplete';
  changes: { parameters: boolean; build: boolean; schemaLookup: boolean; manualReconstruction: boolean };
}
/** Bounded request-context grouping is a hypothesis about demand, never causal proof.
 * Competing parents are excluded rather than resolved by actor/timing proximity. */
export function groupWorkarounds(observations: readonly WorkaroundObservation[], gapMs = 120_000) {
  if (!Number.isFinite(gapMs) || gapMs < 1 || gapMs > 30 * 60_000) throw new Error('invalid_workaround_gap');
  const grouped = collapseRecoveryCopies(observations), evidenceGaps = new Set(grouped.evidenceGaps);
  const episodes: WorkaroundEpisode[] = [];
  for (const row of grouped.operations) {
    if (!row.operationToken) { evidenceGaps.add('unverified-operation-identity'); continue; }
    const parents = episodes.filter(e => {
      const root = e.operations[0]!, prior = e.operations.at(-1)!;
      return !e.finalOutcomeRef && root.scopeToken === row.scopeToken && root.actorToken === row.actorToken
        && root.providerNamespaceToken === row.providerNamespaceToken && Date.parse(row.at) > Date.parse(prior.at)
        && Date.parse(row.at) - Date.parse(root.at) <= gapMs
        && (root.requestToken === row.requestToken || root.contextTokens.some(t => row.contextTokens.includes(t)))
        && (row.tool === root.tool || row.manualRead || ['tools:find', 'docs:search', 'dev:pg_query'].includes(row.tool));
    });
    if (parents.length > 1) { evidenceGaps.add('ambiguous-workaround-parent'); continue; }
    const e = parents[0];
    if (e) {
      const root = e.operations[0]!;
      e.operations.push(row); e.extraCalls++;
      e.elapsedMs = Date.parse(row.at) - Date.parse(root.at);
      e.callTimeMs = e.callTimeMs === null || row.durationMs === null ? null : e.callTimeMs + row.durationMs;
      e.changes.parameters ||= row.tool === root.tool && row.requestToken !== root.requestToken;
      e.changes.build ||= !!root.buildToken && !!row.buildToken && root.buildToken !== row.buildToken;
      e.changes.schemaLookup ||= row.tool === 'dev:pg_query' || row.tool === 'docs:search';
      e.changes.manualReconstruction ||= row.manualRead;
      // A discovery/lookup success is only an intermediate step, not proof that
      // the original operation or manual reconstruction eventually succeeded.
      if (row.outcome === 'success' && (row.tool === root.tool || row.manualRead)) {
        e.finalOutcomeRef = row.operationToken; e.evidence = 'observed-sequence';
      }
    } else if (row.repair) episodes.push({ id: row.operationToken, scopeToken: row.scopeToken, actorToken: row.actorToken,
      tool: row.tool, repair: row.repair, operations: [row], extraCalls: 0, elapsedMs: 0, callTimeMs: row.durationMs,
      finalOutcomeRef: null, evidence: 'incomplete', changes: { parameters: false, build: false, schemaLookup: false, manualReconstruction: false } });
  }
  if (episodes.some(e => !e.finalOutcomeRef)) evidenceGaps.add('incomplete-final-outcome');
  return { ...grouped, episodes, evidenceGaps: [...evidenceGaps].sort() };
}
const recommendations: Record<RepairKind, string> = {
  parameter: 'Improve the existing tool parameter contract and correction guidance.',
  schema: 'Improve the existing tool schema guidance and supported filters.',
  build: 'Expose serving-build compatibility and refresh guidance for the existing tool.',
  availability: 'Improve existing-tool availability and discovery of the supported fallback.',
};
export function rankWorkarounds(observations: readonly WorkaroundObservation[]) {
  const grouped = groupWorkarounds(observations);
  const families = new Map<string, WorkaroundEpisode[]>();
  for (const e of grouped.episodes.filter(e => e.finalOutcomeRef && e.extraCalls > 0)) {
    const key = JSON.stringify([e.scopeToken, e.tool, e.repair]);
    const rows = families.get(key) ?? []; rows.push(e); families.set(key, rows);
  }
  return { ...grouped, rankings: [...families.values()].filter(es => es.length >= 2).map(es => ({
    scopeToken: es[0]!.scopeToken, tool: es[0]!.tool, repair: es[0]!.repair, episodes: es,
    successfulEpisodes: es.length, extraCalls: es.reduce((n, e) => n + e.extraCalls, 0),
    elapsedMs: es.reduce((n, e) => n + e.elapsedMs, 0), finalOutcomeRefs: es.map(e => e.finalOutcomeRef!),
    recommendation: recommendations[es[0]!.repair], confidence: 'observed-sequence' as const,
    causalClaim: 'Sequence observed; the cause and counterfactual savings are unproven.',
  })).sort((a, b) => b.extraCalls - a.extraCalls || a.tool.localeCompare(b.tool)) };
}
/** Reuses the existing authorized invocation census, cursor and output hydration. */
export function fetchWorkaroundFunnels(opts: RecoveryCorpusOptions) {
  return fetchOperationObservations(opts, observeWorkaround);
}
