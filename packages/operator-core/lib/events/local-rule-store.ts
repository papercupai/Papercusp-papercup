/** Durable local authorship; portable rule validation and execution stay shared. */
import type postgres from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { parseRulePackage, type AsyncRuleDeclaration, type SyncRuleDeclaration } from '../cupboard/rule-store';

export type LocalRuleDefinition = AsyncRuleDeclaration | SyncRuleDeclaration;
/** Stable budget/provenance key across edits; revisions must not reset a fire budget. */
export function localRuleSource(row: { workspaceId: string; potSlug: string | null; id: string }): string {
  return 'standalone:local:' + encodeURIComponent(JSON.stringify([row.workspaceId, row.potSlug, row.id]));
}
export interface LocalRuleScope { workspaceId: string; potSlug?: string | null }
export interface LocalAuthoredRule {
  workspaceId: string;
  potSlug: string | null;
  id: string;
  authorId: string;
  definition: LocalRuleDefinition;
  revision: number;
  testedRevision: number | null;
  testReceipt: Record<string, unknown> | null;
  enabled: boolean;
}
interface StoredRule {
  workspace_id: string; pot_slug: string; rule_id: string; author_id: string;
  definition: unknown; revision: number; tested_revision: number | null;
  test_receipt: Record<string, unknown> | null; enabled: boolean;
}
type Sql = postgres.Sql | postgres.TransactionSql;
const managementTools = ['create', 'validate', 'get', 'list', 'test', 'enable', 'disable', 'delete'].map((verb) => 'rules:' + verb);

/** Same package grammar as Cupboard; a local guard must preserve its recovery tools. */
export function validateLocalRule(value: unknown): LocalRuleDefinition {
  const parsed = parseRulePackage(value);
  if (!parsed.ok) throw new Error('invalid_rule: ' + parsed.error);
  const rule = parsed.rule;
  if (rule.delivery === 'sync' && rule.guard) {
    const matchesRecovery = !rule.tools || rule.tools.some((pattern) =>
      managementTools.some((tool) => pattern.endsWith('*') ? tool.startsWith(pattern.slice(0, -1)) : tool === pattern));
    if (matchesRecovery) throw new Error('rule_lockout: local guards need explicit tool filters excluding rules:*');
  }
  return rule;
}
function decode(row: StoredRule): LocalAuthoredRule {
  const definition = validateLocalRule({ schemaVersion: 1, ...(row.definition as Record<string, unknown>) });
  if (definition.id !== row.rule_id) throw new Error('rule_id_mismatch: stored definition differs from its key');
  return { workspaceId: row.workspace_id, potSlug: row.pot_slug || null, id: row.rule_id, authorId: row.author_id,
    definition, revision: row.revision, testedRevision: row.tested_revision, testReceipt: row.test_receipt, enabled: row.enabled };
}
function scopeParams(scope: LocalRuleScope, id: string) {
  if (!scope.workspaceId.trim() || !id.trim()) throw new Error('rule_scope_required');
  return [scope.workspaceId, scope.potSlug ?? '', id];
}
export async function getLocalRule(scope: LocalRuleScope, id: string, sql: Sql = getOrgPg().sql): Promise<LocalAuthoredRule | null> {
  const rows = await sql.unsafe<StoredRule[]>('SELECT * FROM harness_shared.local_rules WHERE workspace_id=$1 AND pot_slug=$2 AND rule_id=$3', scopeParams(scope, id));
  return rows[0] ? decode(rows[0]) : null;
}

/** Create disabled; edits use compare-and-swap and always invalidate the replay receipt. */
export async function putLocalRule(input: LocalRuleScope & { authorId: string; definition: unknown; expectedRevision?: number }, sql: Sql = getOrgPg().sql): Promise<LocalAuthoredRule> {
  const rule = validateLocalRule(input.definition);
  if (!input.authorId.trim()) throw new Error('rule_author_required');
  const params = [...scopeParams(input, rule.id), input.authorId, JSON.stringify(rule)];
  const rows = input.expectedRevision === undefined
    ? await sql.unsafe<StoredRule[]>('INSERT INTO harness_shared.local_rules (workspace_id,pot_slug,rule_id,author_id,definition) VALUES ($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING RETURNING *', params)
    : await sql.unsafe<StoredRule[]>('UPDATE harness_shared.local_rules SET definition=$5::jsonb, revision=revision+1, enabled=false, tested_revision=NULL, test_receipt=NULL, updated_at=now() WHERE workspace_id=$1 AND pot_slug=$2 AND rule_id=$3 AND author_id=$4 AND revision=$6 RETURNING *', [...params, input.expectedRevision]);
  if (!rows[0]) throw new Error(input.expectedRevision === undefined ? 'rule_exists' : 'rule_revision_or_author_changed');
  return decode(rows[0]);
}

/** A receipt is tied to exactly the bytes/revision replayed, never a later edit. */
export async function recordLocalRuleTest(scope: LocalRuleScope, id: string, revision: number,
  receipt: { passed: boolean; samples: number; [key: string]: unknown }, sql: Sql = getOrgPg().sql): Promise<LocalAuthoredRule> {
  if (!Number.isInteger(receipt.samples) || receipt.samples < 1) throw new Error('rule_test_requires_samples');
  const passed = receipt.passed === true;
  const rows = await sql.unsafe<StoredRule[]>('UPDATE harness_shared.local_rules SET tested_revision=CASE WHEN $5::boolean THEN revision ELSE NULL END, test_receipt=$6::jsonb, enabled=enabled AND $5::boolean, updated_at=now() WHERE workspace_id=$1 AND pot_slug=$2 AND rule_id=$3 AND revision=$4 RETURNING *',
    [...scopeParams(scope, id), revision, passed, JSON.stringify(receipt)]);
  if (!rows[0]) throw new Error('rule_revision_changed');
  return decode(rows[0]);
}
export async function setLocalRuleEnabled(scope: LocalRuleScope, id: string, enabled: boolean, sql: Sql = getOrgPg().sql): Promise<LocalAuthoredRule> {
  const rows = await sql.unsafe<StoredRule[]>('UPDATE harness_shared.local_rules SET enabled=$4,updated_at=now() WHERE workspace_id=$1 AND pot_slug=$2 AND rule_id=$3 AND (NOT $4::boolean OR (tested_revision=revision AND test_receipt IS NOT NULL)) RETURNING *',
    [...scopeParams(scope, id), enabled]);
  if (!rows[0]) throw new Error('rule_missing_or_untested_revision');
  return decode(rows[0]);
}
export async function deleteLocalRule(scope: LocalRuleScope, id: string, sql: Sql = getOrgPg().sql): Promise<boolean> {
  const rows = await sql.unsafe('DELETE FROM harness_shared.local_rules WHERE workspace_id=$1 AND pot_slug=$2 AND rule_id=$3 RETURNING rule_id', scopeParams(scope, id));
  return rows.length > 0;
}
export async function listLocalRules(scope: LocalRuleScope, opts: { includeWorkspace?: boolean; enabledOnly?: boolean; allPots?: boolean } = {}, sql: Sql = getOrgPg().sql): Promise<LocalAuthoredRule[]> {
  if (!scope.workspaceId.trim()) throw new Error('rule_scope_required');
  const rows = await sql.unsafe<StoredRule[]>('SELECT * FROM harness_shared.local_rules WHERE workspace_id=$1 AND ($5::boolean OR pot_slug=$2 OR ($3::boolean AND pot_slug=\'\')) AND (NOT $4::boolean OR enabled) ORDER BY pot_slug,rule_id',
    [scope.workspaceId, scope.potSlug ?? '', opts.includeWorkspace ?? false, opts.enabledOnly ?? false, opts.allPots ?? false]);
  return rows.map(decode);
}

/** Export bytes, never grants, test receipts or enabled state. */
export function localRulePackage(rule: LocalAuthoredRule): Record<string, unknown> {
  return { schemaVersion: 1, ...rule.definition };
}
