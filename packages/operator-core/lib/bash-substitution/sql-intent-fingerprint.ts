/** Advisory SQL shapes only. Nothing here executes SQL or establishes tool equivalence. */
import { createHmac } from 'node:crypto';
import { parse } from 'pgsql-ast-parser';
import { isSensitiveValueKey, redactSensitiveText } from '../sensitive-text';

export const SQL_INTENT_VERSION = 'pgsql-ast-parser/12.0.2:sql-intent-v1';
export interface SqlIntentScope {
  workspaceId: string;
  sourceBoundary: string;
  epoch: string;
  /** Injected outside the repository. Never returned or used as an unkeyed digest. */
  key: Uint8Array;
  knownSecrets?: readonly string[];
}
export interface SqlIntentFeatures {
  relations: string[];
  projectedFields: string[];
  predicateOperators: string[];
  jsonPaths: string[];
  joins: string[];
  grouping: boolean;
  ordering: boolean;
  limits: string[];
  inputs: string[];
}
export type SqlIntentResult = {
  status: 'supported'; version: string; fingerprint: string; suggestedFamily: string;
  canonical: string; features: SqlIntentFeatures; secretValuesDropped: boolean;
} | {
  status: 'unknown'; version: string;
  reason: 'invalid-scope' | 'incomplete-source' | 'empty' | 'too-large' | 'parse-failed'
    | 'multiple-statements' | 'unsupported-statement' | 'unsupported-syntax';
};
type Obj = Record<string, unknown>;
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const obj = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {};
const list = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const str = (v: unknown): string => typeof v === 'string' ? v : '';
const readStatements = new Set(['select', 'with', 'union', 'union all']);
const statementTypes = new Set(['insert', 'update', 'delete', 'create table', 'drop table',
  'alter table', 'truncate table', 'values', 'with recursive']);
const pureCalls = new Set(['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif',
  'lower', 'upper', 'length', 'trim', 'concat', 'concat_ws', 'now', 'date_trunc',
  'date_part', 'extract', 'greatest', 'least', 'round', 'abs', 'array_agg', 'string_agg',
  'json_agg', 'jsonb_agg', 'json_build_object', 'jsonb_build_object',
  'json_object_agg', 'jsonb_object_agg', 'jsonb_array_length', 'json_array_length']);
const scalarKinds = new Set(['string', 'integer', 'numeric', 'boolean', 'null', 'constant']);
const publicStrings = new Set(['type', 'op', 'order', 'nulls', 'distinct']);

function parameterKind(expr: unknown): string | undefined {
  const e = obj(expr);
  if (e.type === 'cast') return parameterKind(e.operand);
  if (e.type !== 'ref') return undefined;
  const name = str(e.name);
  if (/^(?:id|uuid)$|(?:_id|_uuid)$/.test(name)) return 'entity';
  if (/(?:_at|_date|_time|_timestamp)$|^(?:date|timestamp)$/.test(name)) return 'time';
  return undefined;
}
function sensitiveExpr(expr: unknown): boolean {
  const e = obj(expr);
  if (e.type === 'ref') return isSensitiveValueKey(str(e.name));
  if (e.type === 'member') return isSensitiveValueKey(str(e.member));
  return e.type === 'cast' && sensitiveExpr(e.operand);
}
/** Stable object key ordering; array order (projection, joins, sort) is semantic. */
function stable(v: Json): string {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort()
    .map(k => JSON.stringify(k) + ':' + stable(v[k]!)).join(',') + '}';
  return JSON.stringify(v);
}

/**
 * Call only after source authorization. Scope is mandatory even for public SQL: private
 * identifiers and retained semantic values are keyed within workspace/source/epoch.
 * Incomplete/truncated upstream coverage cannot become a measured supported shape.
 */
export function fingerprintSqlIntent(sql: string, scope: SqlIntentScope,
  coverage: 'complete' | 'unknown' | 'truncated' = 'complete'): SqlIntentResult {
  const unknown = (reason: Extract<SqlIntentResult, { status: 'unknown' }>['reason']): SqlIntentResult =>
    ({ status: 'unknown', version: SQL_INTENT_VERSION, reason });
  if (!scope || !scope.workspaceId || !scope.sourceBoundary || !scope.epoch
    || !(scope.key instanceof Uint8Array) || scope.key.byteLength < 32) return unknown('invalid-scope');
  if (coverage !== 'complete') return unknown('incomplete-source');
  if (typeof sql !== 'string' || !sql.trim()) return unknown('empty');
  if (sql.length > 64_000) return unknown('too-large');
  let statements: ReturnType<typeof parse>;
  try { statements = parse(sql); } catch { return unknown('parse-failed'); }
  if (statements.length !== 1) return unknown('multiple-statements');
  if (!readStatements.has(statements[0]!.type)) return unknown('unsupported-statement');
  const features: SqlIntentFeatures = { relations: [], projectedFields: [], predicateOperators: [],
    jsonPaths: [], joins: [], grouping: false, ordering: false, limits: [], inputs: [] };
  let dropped = false;
  const scrub = (value: string): string => {
    // Known credentials can be short opaque fixtures too: unlike diagnostic text,
    // recurrence identity must never preserve even a keyed digest of a credential.
    if (scope.knownSecrets?.some(secret => secret.length > 0 && value.includes(secret))) {
      dropped = true; return '[secret-dropped]';
    }
    try {
      const hasCredential = (v: unknown): boolean => Array.isArray(v) ? v.some(hasCredential)
        : v !== null && typeof v === 'object' && Object.entries(v)
          .some(([key, child]) => isSensitiveValueKey(key) || hasCredential(child));
      if (hasCredential(JSON.parse(value))) { dropped = true; return '[secret-dropped]'; }
    } catch { /* A SQL string need not contain JSON. */ }
    const clean = redactSensitiveText(value, scope.knownSecrets);
    if (clean !== value) { dropped = true; return '[secret-dropped]'; }
    return value;
  };
  // Domain-separated tuples prevent ambiguous scope concatenation and cross-source linkage.
  const token = (domain: string, value: string): string => createHmac('sha256', scope.key)
    .update(JSON.stringify([SQL_INTENT_VERSION, scope.workspaceId, scope.sourceBoundary,
      scope.epoch, domain, value])).digest('hex');
  const safeToken = (domain: string, value: string): string => {
    const clean = scrub(value);
    return clean === '[secret-dropped]' ? clean : token(domain, clean);
  };
  const bindings = new Map<string, number>();
  const placeholder = (kind: string, value: unknown): Json => {
    const clean = typeof value === 'string' ? scrub(value) : value;
    if (clean === '[secret-dropped]') return { dropped: 'secret' };
    const identity = JSON.stringify([kind, clean]);
    if (!bindings.has(identity)) bindings.set(identity, bindings.size + 1);
    features.inputs.push(kind);
    return { input: kind, slot: bindings.get(identity)! };
  };
  // Inspect the same SELECT/WITH/UNION syntax used by postgres-lineage. Keep
  // this tree rather than flattening lineage: predicates and projection order matter.
  const normalize = (value: unknown, field = '', inputKind?: string, sensitive = false): Json => {
    if (value === undefined || value === null) return null;
    if (Array.isArray(value)) return value.map(v => normalize(v, field, inputKind, sensitive));
    if (typeof value === 'string') {
      const clean = scrub(value);
      if (clean === '[secret-dropped]') return { dropped: 'secret' };
      return publicStrings.has(field) ? clean : safeToken(field, clean);
    }
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    const e = obj(value), type = str(e.type);
    if ((field === 'limit' || field === 'offset') && type) features.limits.push(`${field}:${type}`);
    if (statementTypes.has(type) || e.for || e.skip) throw new Error('unsupported-statement');
    if (type === 'call') {
      const fn = obj(e.function);
      if (fn.schema || !pureCalls.has(str(fn.name))) throw new Error('unsupported-syntax');
      // Object-builder arguments alternate semantic keys and values: conservatively
      // reject credential-bearing keys instead of fingerprinting their value argument.
      const args = list(e.args);
      if (str(fn.name).includes('object') && args.some(a => isSensitiveValueKey(str(obj(a).value)))) {
        throw new Error('unsupported-syntax');
      }
    }
    if (scalarKinds.has(type)) {
      if (sensitive) { dropped = true; return { dropped: 'secret' }; }
      const raw = typeof e.value === 'string' ? scrub(e.value) : e.value;
      if (raw === '[secret-dropped]') return { dropped: 'secret' };
      if (type === 'null') return { type: 'null' };
      if (inputKind) return placeholder(`${inputKind}:${type === 'integer' || type === 'numeric' ? 'number' : type}`, raw);
      // Preserve enum/status, JSON values, intervals and numeric semantics exactly,
      // but never persist their plaintext or an unkeyed dictionary-attackable digest.
      return { type, semantic: safeToken('literal', JSON.stringify(raw)),
        ...(e.dataType ? { dataType: normalize(e.dataType) } : {}) };
    }
    if (type === 'parameter') return placeholder('parameter', e.name);
    if (field === 'columns') features.projectedFields.push(safeToken('projection', stable(normalize(e.expr))));
    if (type === 'member') features.jsonPaths.push(safeToken('json-path', String(e.member)));
    if (type === 'table') features.relations.push(safeToken('relation', JSON.stringify(e.name)));
    if (type === 'binary' || type === 'unary' || type === 'ternary') features.predicateOperators.push(str(e.op));
    if (e.join) features.joins.push(str(obj(e.join).type));
    if (e.groupBy) features.grouping = true;
    if (e.orderBy) features.ordering = true;
    const result: Record<string, Json> = {};
    for (const key of Object.keys(e).sort()) {
      if (key === '_location') continue;
      let kind = inputKind, secret = sensitive;
      if (type === 'binary' && (key === 'left' || key === 'right')) {
        const other = key === 'left' ? e.right : e.left;
        // Only entity/time predicate operands are replaceable; never JSON operators.
        if (['=', '!=', '>', '>=', '<', '<=', 'IN', 'NOT IN'].includes(str(e.op))) {
          kind = parameterKind(other); secret = sensitiveExpr(other);
        }
      }
      if (type === 'ternary' && (key === 'lo' || key === 'hi')) {
        kind = parameterKind(e.value); secret = sensitiveExpr(e.value);
      }
      result[key] = normalize(e[key], key, kind, secret);
    }
    return result;
  };
  try {
    const tree = normalize(statements[0]);
    const canonical = stable(tree);
    const broaden = (v: Json): Json => {
      if (Array.isArray(v)) return v.map(broaden);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v)
        .map(([k, x]) => [k, k === 'semantic' ? '[semantic-value]' : broaden(x)]));
      return v;
    };
    for (const key of ['relations', 'projectedFields', 'predicateOperators', 'jsonPaths', 'joins', 'limits', 'inputs'] as const) {
      features[key] = [...new Set(features[key])].sort();
    }
    return { status: 'supported', version: SQL_INTENT_VERSION,
      fingerprint: token('exact', canonical), suggestedFamily: token('suggested-family', stable(broaden(tree))),
      canonical, features, secretValuesDropped: dropped };
  } catch (error) {
    return unknown(error instanceof Error && error.message === 'unsupported-statement'
      ? 'unsupported-statement' : 'unsupported-syntax');
  }
}

/** One explicit residue record per input, including parse failures and absent coverage. */
export function fingerprintSqlIntents(inputs: readonly { sql: string; coverage?: 'complete' | 'unknown' | 'truncated' }[], scope: SqlIntentScope) {
  const results = inputs.map(input => fingerprintSqlIntent(input.sql, scope, input.coverage));
  return { results, supported: results.filter(r => r.status === 'supported').length,
    unknown: results.filter(r => r.status === 'unknown').length };
}
