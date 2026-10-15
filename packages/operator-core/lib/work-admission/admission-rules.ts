/**
 * Per-data-source admission rules (enterprise-data-sources-2026-10-01 P-020 / D-004 / D-030).
 *
 * A rule says "records of THIS data source that match THIS condition become work in THIS
 * harness", for example tasks assigned to the Papercusp agents user
 * ({"assignees":{"contains":"papercusp-agents"}}) or everything in one project
 * ({"container":{"eq":"acme/api"}}). A record no enabled rule matches is never admitted
 * automatically: it stays DATA until a person admits it with work_items:admit.
 *
 * A match is field -> condition over the record's canonical payload. Every field must match.
 *   {"eq": v}        the field equals v
 *   {"in": [v, ...]} the field equals one of the values
 *   {"contains": v}  the field is an array that contains v
 *   {"after": iso}   a timestamp is strictly later than this explicit activation boundary
 * String comparison is case-insensitive (GitHub logins and repository names are). An unknown
 * operator is refused when the rule is saved, and never matches if one reaches the evaluator.
 *
 * Rules run through admitWorkItem with admitter { via:'rule' }, so a rule admission is
 * attributable, idempotent and linked exactly like a person's.
 */
import { getOrgPg } from '@papercusp/db-org';
import { z } from 'zod';
import { admitWorkItem, ADMITTED_KINDS, type AdmitDeps, type AdmitResult, type AdmittedKind } from './admit';
import type { AdmissionDb } from './admission-sources';
import { RECORD_SOURCE_KIND } from './record-source';
import { parseAdmissionLifecycle, resolveAdmissionLifecycle, type AdmissionDelivery, type AdmissionLifecycle } from './lifecycle-config';
import { checkPrDelivery, type PrDeliveryDeps, type PrDeliveryVerdict } from './pr-delivery';

export const ADMISSION_MATCH_OPS = ['eq', 'in', 'contains', 'after'] as const;
export type AdmissionMatchOp = (typeof ADMISSION_MATCH_OPS)[number];
export type AdmissionMatch = Record<string, Partial<Record<AdmissionMatchOp, unknown>>>;

/** Cap on records one backfill pass evaluates, so one call stays bounded. */
export const ADMISSION_BACKFILL_MAX = 500;

export interface AdmissionRule {
  id: string;
  workspaceId: string;
  dataSourceId: string;
  /** Always 'record': rules admit ingested records (chat rules left with the Slack packages, cupboard-distributable-integrations D-025). */
  sourceKind: string;
  title: string;
  match: AdmissionMatch;
  harness: string;
  workKind: AdmittedKind;
  enabled: boolean;
  /** What the rule's admitted items tell their source, and how they react to it (lifecycle.ts, P-003). */
  lifecycle: AdmissionLifecycle;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface RuleDbRow {
  id: string;
  workspace_id: string;
  data_source_id: string;
  source_kind: string;
  action: string;
  title: string;
  match: AdmissionMatch;
  harness_slug: string;
  work_kind: string;
  enabled: boolean;
  lifecycle: unknown;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : String(v));

function toRule(r: RuleDbRow): AdmissionRule {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    dataSourceId: r.data_source_id,
    sourceKind: r.source_kind,
    title: r.title,
    match: r.match,
    harness: r.harness_slug,
    workKind: r.work_kind as AdmittedKind,
    enabled: r.enabled,
    lifecycle: resolveAdmissionLifecycle(r.lifecycle),
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function scalar(v: unknown): string | null {
  if (typeof v === 'string') return v.trim().toLowerCase();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v).toLowerCase();
  return null;
}

const admissionTimestampSchema = z.string().datetime({ offset: true });
function timestamp(value: unknown): number {
  const parsed = admissionTimestampSchema.safeParse(value);
  return parsed.success ? Date.parse(parsed.data) : NaN;
}

/** Throws `admission_rule_invalid:<why>` when a match is malformed. */
export function validateAdmissionMatch(match: unknown): asserts match is AdmissionMatch {
  if (!match || typeof match !== 'object' || Array.isArray(match)) throw new Error('admission_rule_invalid: match must be an object');
  const entries = Object.entries(match as Record<string, unknown>);
  if (entries.length === 0) throw new Error('admission_rule_invalid: match needs at least one field');
  for (const [field, cond] of entries) {
    if (!field.trim()) throw new Error('admission_rule_invalid: empty field name');
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) {
      throw new Error(`admission_rule_invalid: ${field} must map to {eq|in|contains|after: value}`);
    }
    const ops = Object.keys(cond);
    if (ops.length === 0) throw new Error(`admission_rule_invalid: ${field} has no condition`);
    for (const op of ops) {
      if (!(ADMISSION_MATCH_OPS as readonly string[]).includes(op)) {
        throw new Error(`admission_rule_invalid: ${field} uses unknown operator '${op}' (use ${ADMISSION_MATCH_OPS.join(', ')})`);
      }
      const value = (cond as Record<string, unknown>)[op];
      if (op === 'in') {
        if (!Array.isArray(value) || value.length === 0 || value.some((x) => scalar(x) === null)) {
          throw new Error(`admission_rule_invalid: ${field}.in must be a non-empty array of scalars`);
        }
      } else if (op === 'after') {
        if (!Number.isFinite(timestamp(value))) {
          throw new Error(`admission_rule_invalid: ${field}.after must be an ISO timestamp with timezone`);
        }
      } else if (scalar(value) === null) {
        throw new Error(`admission_rule_invalid: ${field}.${op} must be a string, number or boolean`);
      }
    }
  }
}

/**
 * Ticket admission presets (linear-asana-task-sync-2026-10-05 D-012): shorthand for the rules
 * people ask for on a workflow tracker, each a match over CANONICAL ticket fields, so one
 * vocabulary covers every ticket provider and nothing here names a provider:
 *   delegated-to-papercusp  the ticket is delegated to the connected account (Linear agents)
 *   assigned-to-papercusp   the ticket is assigned to the connected account
 *   label <X>               the ticket carries label X (Asana tags arrive as labels)
 *   team <X>                the ticket's container is X (a Linear team key)
 *   project <X>             the ticket belongs to project X
 * "The connected account" is whichever account the data source is connected as; the provider
 * marks it per ticket in `selfRoles`, so no rule has to name a person. A preset whose field a
 * provider never fills matches nothing, which the rules-set backfill count makes visible.
 */
export const TICKET_RULE_PRESETS = ['delegated-to-papercusp', 'assigned-to-papercusp', 'label', 'team', 'project'] as const;
export type TicketRulePreset = (typeof TICKET_RULE_PRESETS)[number];

/** The match a ticket preset stands for. `value` is required for label/team/project and refused otherwise. */
export function ticketRulePreset(preset: TicketRulePreset, value?: string): AdmissionMatch {
  const v = (value ?? '').trim();
  if (preset === 'delegated-to-papercusp' || preset === 'assigned-to-papercusp') {
    if (v) throw new Error(`admission_rule_invalid: preset '${preset}' takes no value`);
    return { selfRoles: { contains: preset === 'delegated-to-papercusp' ? 'delegate' : 'assignee' } };
  }
  if (!v) throw new Error(`admission_rule_invalid: preset '${preset}' needs a value (the ${preset} name)`);
  if (preset === 'label') return { labels: { contains: v } };
  if (preset === 'team') return { container: { eq: v } };
  return { projects: { contains: v } };
}

/**
 * The work kind a matched record admits as: a record its provider labels `bug` is a bug,
 * anything else the rule's own kind (D-012). Matching is case-insensitive, like rule matches.
 */
export function admittedKindFor(ruleKind: AdmittedKind, payload: Record<string, unknown>): AdmittedKind {
  const labels = payload.labels;
  return Array.isArray(labels) && labels.some((label) => scalar(label) === 'bug') ? 'bug' : ruleKind;
}

/** True when `payload` satisfies every field condition of `match`. */
export function matchAdmissionRule(match: AdmissionMatch, payload: Record<string, unknown>): boolean {
  const entries = Object.entries(match ?? {});
  if (entries.length === 0) return false;
  for (const [field, cond] of entries) {
    const actual = payload[field];
    for (const [op, expected] of Object.entries(cond ?? {})) {
      if (op === 'eq') {
        const a = scalar(actual);
        if (a === null || a !== scalar(expected)) return false;
      } else if (op === 'in') {
        const a = scalar(actual);
        if (a === null || !Array.isArray(expected) || !expected.some((x) => scalar(x) === a)) return false;
      } else if (op === 'contains') {
        const e = scalar(expected);
        if (!Array.isArray(actual) || e === null || !actual.some((x) => scalar(x) === e)) return false;
      } else if (op === 'after') {
        const cutoff = timestamp(expected);
        const created = timestamp(actual);
        if (!Number.isFinite(cutoff) || !Number.isFinite(created) || created <= cutoff) return false;
      } else {
        return false;
      }
    }
  }
  return true;
}

export interface SetAdmissionRuleInput {
  workspaceId: string;
  dataSourceId: string;
  title: string;
  match: unknown;
  harness: string;
  workKind?: AdmittedKind;
  createdBy: string;
  /** Update this rule instead of creating one. */
  id?: string;
  enabled?: boolean;
  /** Lifecycle switches (lifecycle-config.ts). Omitted on create = the defaults; on update = unchanged. */
  lifecycle?: unknown;
}

/** Seams for the PR-delivery precondition (P-013); production reads the registry and pot_settings. */
export interface AdmissionRuleDeps {
  prDelivery?: PrDeliveryDeps;
}

/**
 * Throws `<code>: <message>` when a PR-required rule's target harness cannot deliver through a
 * PR (pr-delivery.ts). The error keeps the refusal code as its prefix, like the other
 * `admission_rule_*` errors, so callers surface it by code.
 */
async function assertPrDeliveryReady(
  workspaceId: string,
  harness: string,
  sql: AdmissionDb,
  deps: AdmissionRuleDeps,
): Promise<void> {
  const verdict = await checkPrDelivery(workspaceId, harness, { sql: sql as never, deps: deps.prDelivery });
  if (!verdict.ok) throw new Error(`${verdict.code}: ${verdict.message}`);
}

export async function setAdmissionRule(
  input: SetAdmissionRuleInput,
  sql: AdmissionDb = getOrgPg().sql,
  deps: AdmissionRuleDeps = {},
): Promise<AdmissionRule> {
  validateAdmissionMatch(input.match);
  const workKind = input.workKind ?? 'change';
  if (!(ADMITTED_KINDS as readonly string[]).includes(workKind)) throw new Error(`admission_rule_invalid: workKind must be one of ${ADMITTED_KINDS.join(', ')}`);
  const title = input.title.trim();
  if (!title) throw new Error('admission_rule_invalid: title is required');
  // Stored as given (only the keys the caller set), so a later change to a default reaches it.
  let lifecycle: unknown = null;
  let delivery: AdmissionDelivery = 'direct';
  if (input.lifecycle !== undefined) {
    delivery = parseAdmissionLifecycle(input.lifecycle).delivery;
    lifecycle = input.lifecycle;
  }
  const [source] = await sql<{ id: string }[]>`
    SELECT id FROM harness_shared.data_sources WHERE workspace_id = ${input.workspaceId} AND id = ${input.dataSourceId}`;
  if (!source) throw new Error(`admission_rule_invalid: no data source '${input.dataSourceId}' in this workspace`);
  if (input.id && lifecycle === null) {
    // An update that leaves the lifecycle unchanged keeps the stored delivery, which still
    // binds the (possibly new) target harness.
    const [current] = await sql<{ lifecycle: unknown }[]>`
      SELECT lifecycle FROM harness_shared.admission_rules
       WHERE workspace_id = ${input.workspaceId} AND id = ${input.id} AND data_source_id = ${input.dataSourceId}`;
    if (current) delivery = resolveAdmissionLifecycle(current.lifecycle).delivery;
  }
  // P-013 (D-015): a PR-required rule may only be enabled against a harness that delivers
  // through a PR. A disabled rule admits nothing, so it may be prepared ahead of the switch.
  if (delivery === 'pr' && (input.enabled ?? true)) {
    await assertPrDeliveryReady(input.workspaceId, input.harness, sql, deps);
  }
  if (input.id) {
    const [row] = await sql<RuleDbRow[]>`
      UPDATE harness_shared.admission_rules
         SET title = ${title}, match = ${sql.json(input.match as never)}, harness_slug = ${input.harness},
             work_kind = ${workKind}, enabled = ${input.enabled ?? true},
             lifecycle = COALESCE(${lifecycle === null ? null : sql.json(lifecycle as never)}::jsonb, lifecycle), updated_at = now()
       WHERE workspace_id = ${input.workspaceId} AND id = ${input.id} AND data_source_id = ${input.dataSourceId}
       RETURNING *`;
    if (!row) throw new Error(`admission_rule_not_found:${input.id}`);
    return toRule(row);
  }
  const [row] = await sql<RuleDbRow[]>`
    INSERT INTO harness_shared.admission_rules
      (workspace_id, data_source_id, source_kind, action, title, match, harness_slug, work_kind, enabled, created_by, lifecycle)
    VALUES
      (${input.workspaceId}, ${input.dataSourceId}, ${RECORD_SOURCE_KIND}, 'admit', ${title},
       ${sql.json(input.match as never)}, ${input.harness}, ${workKind}, ${input.enabled ?? true}, ${input.createdBy},
       ${sql.json((lifecycle ?? {}) as never)})
    RETURNING *`;
  return toRule(row!);
}

export async function listAdmissionRules(
  workspaceId: string,
  filter: { dataSourceId?: string; includeDisabled?: boolean } = {},
  sql: AdmissionDb = getOrgPg().sql,
): Promise<AdmissionRule[]> {
  const rows = await sql<RuleDbRow[]>`
    SELECT * FROM harness_shared.admission_rules
     WHERE workspace_id = ${workspaceId}
       ${filter.dataSourceId ? sql`AND data_source_id = ${filter.dataSourceId}` : sql``}
       ${filter.includeDisabled ? sql`` : sql`AND enabled`}
     ORDER BY created_at`;
  return rows.map(toRule);
}

export async function disableAdmissionRule(workspaceId: string, id: string, sql: AdmissionDb = getOrgPg().sql): Promise<AdmissionRule> {
  const [row] = await sql<RuleDbRow[]>`
    UPDATE harness_shared.admission_rules SET enabled = false, updated_at = now()
     WHERE workspace_id = ${workspaceId} AND id = ${id}
     RETURNING *`;
  if (!row) throw new Error(`admission_rule_not_found:${id}`);
  return toRule(row);
}

export interface RuleEvaluation {
  matched: number;
  results: Array<{ ruleId: string; result: AdmitResult }>;
}

/**
 * The dispatch-time half of P-013: before a PR-required rule admits anything, re-check that its
 * target harness still delivers through a PR (a pot can be switched back to direct mode after
 * the rule was saved). Memoised per harness for one evaluation pass.
 */
function prDeliveryGate(workspaceId: string, sql: AdmissionDb, deps: AdmissionRuleDeps) {
  const seen = new Map<string, Promise<PrDeliveryVerdict>>();
  return async (rule: AdmissionRule): Promise<AdmitResult | null> => {
    if (rule.lifecycle.delivery !== 'pr') return null;
    let verdict = seen.get(rule.harness);
    if (!verdict) {
      verdict = checkPrDelivery(workspaceId, rule.harness, { sql: sql as never, deps: deps.prDelivery });
      seen.set(rule.harness, verdict);
    }
    const v = await verdict;
    return v.ok ? null : { ok: false, code: v.code, message: v.message };
  };
}

/**
 * Evaluates the enabled record rules of the record's data source and admits the record under
 * every rule that matches. Admission is idempotent on the record, so once the first matching
 * rule has admitted it, any later rule (or re-poll) returns the existing admission.
 */
export async function evaluateAdmissionRules(
  input: { workspaceId: string; recordId: string; dataSourceId: string; payload: Record<string, unknown> },
  deps: AdmitDeps & { sql?: AdmissionDb } & AdmissionRuleDeps = {},
): Promise<RuleEvaluation> {
  const sql = deps.sql ?? getOrgPg().sql;
  const rules = await sql<RuleDbRow[]>`
    SELECT * FROM harness_shared.admission_rules
     WHERE workspace_id = ${input.workspaceId} AND data_source_id = ${input.dataSourceId}
       AND source_kind = ${RECORD_SOURCE_KIND} AND enabled
     ORDER BY created_at`;
  const out: RuleEvaluation = { matched: 0, results: [] };
  const prGate = prDeliveryGate(input.workspaceId, sql, deps);
  for (const rule of rules.map(toRule)) {
    if (!matchAdmissionRule(rule.match, input.payload)) continue;
    out.matched += 1;
    // P-013: a PR-required rule never dispatches work into a harness that would push directly.
    // The refusal fails this delivery (datatype-destination-sink), so the record stays DATA,
    // the failure is visible by code, and a later retry admits it once the pot is ready.
    const refused = await prGate(rule);
    if (refused) {
      out.results.push({ ruleId: rule.id, result: refused });
      continue;
    }
    const result = await admitWorkItem(
      {
        workspaceId: input.workspaceId,
        harness: rule.harness,
        source: { kind: RECORD_SOURCE_KIND, recordId: input.recordId },
        admitter: { via: 'rule', ruleId: rule.id, dataSourceId: rule.dataSourceId },
        kind: admittedKindFor(rule.workKind, input.payload),
      },
      deps,
    );
    out.results.push({ ruleId: rule.id, result });
  }
  return out;
}

/**
 * Backfill: evaluates one rule against the records its data source already holds (a rule
 * created after the tickets were ingested). Bounded by ADMISSION_BACKFILL_MAX per call.
 */
export async function applyAdmissionRule(
  workspaceId: string,
  ruleId: string,
  deps: AdmitDeps & { sql?: AdmissionDb; limit?: number } & AdmissionRuleDeps = {},
): Promise<{
  scanned: number;
  admitted: number;
  /** Bugs the intake attached to an existing bug: an admission row, no new work item. */
  folded: number;
  existing: number;
  refused: Array<{ recordId: string; code: string }>;
  truncated: boolean;
}> {
  const sql = deps.sql ?? getOrgPg().sql;
  const [ruleRow] = await sql<RuleDbRow[]>`
    SELECT * FROM harness_shared.admission_rules WHERE workspace_id = ${workspaceId} AND id = ${ruleId}`;
  if (!ruleRow) throw new Error(`admission_rule_not_found:${ruleId}`);
  const rule = toRule(ruleRow);
  if (!rule.enabled) throw new Error(`admission_rule_disabled:${ruleId}`);
  // Only record rules have held records to scan (migration 1418 pins every rule to 'record').
  if (rule.sourceKind !== RECORD_SOURCE_KIND) throw new Error(`admission_rule_backfill_unsupported:${rule.sourceKind}`);
  // P-013: refuse the whole backfill, before scanning, when a PR-required rule's harness cannot
  // deliver through a PR; nothing is admitted and the caller sees the named refusal.
  if (rule.lifecycle.delivery === 'pr') await assertPrDeliveryReady(workspaceId, rule.harness, sql, deps);
  const limit = Math.min(Math.max(1, deps.limit ?? ADMISSION_BACKFILL_MAX), ADMISSION_BACKFILL_MAX);
  const records = await sql<{ feature_id: string; payload: Record<string, unknown> | null }[]>`
    SELECT feature_id, payload FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId} AND nature = 'record' AND payload->>'dataSourceId' = ${rule.dataSourceId}
     ORDER BY feature_id
     LIMIT ${limit + 1}`;
  const truncated = records.length > limit;
  const summary = { scanned: 0, admitted: 0, folded: 0, existing: 0, refused: [] as Array<{ recordId: string; code: string }>, truncated };
  for (const rec of records.slice(0, limit)) {
    summary.scanned += 1;
    if (!matchAdmissionRule(rule.match, rec.payload ?? {})) continue;
    const res = await admitWorkItem(
      {
        workspaceId,
        harness: rule.harness,
        source: { kind: RECORD_SOURCE_KIND, recordId: rec.feature_id },
        admitter: { via: 'rule', ruleId: rule.id, dataSourceId: rule.dataSourceId },
        kind: admittedKindFor(rule.workKind, rec.payload ?? {}),
      },
      deps,
    );
    if (!res.ok) summary.refused.push({ recordId: rec.feature_id, code: res.code });
    else if (res.reason === 'admitted') summary.admitted += 1;
    // A bug the intake folded onto an existing bug: a new admission, but no new work item.
    else if (res.reason === 'folded') summary.folded += 1;
    else summary.existing += 1;
  }
  return summary;
}

export interface SetAdmissionRuleResult {
  rule: AdmissionRule;
  /** For an enabled record rule: what applying it to the records its source already holds did. */
  backfill?: Awaited<ReturnType<typeof applyAdmissionRule>>;
}

/**
 * Sets a rule and, when it is an enabled record rule, applies it to the records its data source
 * already holds (linear-asana-task-sync D-012), so adding "delegated to Papercusp" admits the
 * delegated tickets synced before the rule existed. Admission is idempotent per record, so
 * re-setting a rule never duplicates work.
 */
export async function setAdmissionRuleAndBackfill(
  input: SetAdmissionRuleInput,
  deps: AdmitDeps & { sql?: AdmissionDb } & AdmissionRuleDeps = {},
): Promise<SetAdmissionRuleResult> {
  const sql = deps.sql ?? getOrgPg().sql;
  const rule = await setAdmissionRule(input, sql, deps);
  if (!rule.enabled || rule.sourceKind !== RECORD_SOURCE_KIND) return { rule };
  return { rule, backfill: await applyAdmissionRule(input.workspaceId, rule.id, { ...deps, sql }) };
}
