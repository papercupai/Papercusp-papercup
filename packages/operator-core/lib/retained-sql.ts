/** Bounded SQL source capture. Reuses the maintained parser and provenance store.
 * Only one explicitly scoped base relation and deterministic SELECT/CTE expressions
 * are supported. Unsupported/oversized/redacted inputs never become a replay.
 */
import { createHash } from 'node:crypto';
import { astMapper, parse, toSql, type SelectFromStatement } from 'pgsql-ast-parser';

export const SQL_INPUT_COLUMN = '__papercusp_measurement_sql_inputs_v1';
const MAX_ROWS = 32;
const MAX_BYTES = 6_000;
const sourceName = '__pc_retained_source';
const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const literal = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const pureCalls = new Set(['count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif',
  'round', 'abs', 'greatest', 'least', 'percentile_disc', 'percentile_cont',
  'now', 'transaction_timestamp']);
const types: Record<string, string> = {
  '16': 'bool', '20': 'int8', '21': 'int2', '23': 'int4', '25': 'text',
  '700': 'float4', '701': 'float8', '1043': 'varchar', '1700': 'numeric',
  '1184': 'timestamptz', '1114': 'timestamp', '1082': 'date', '1186': 'interval',
  '114': 'json', '3802': 'jsonb', '2950': 'uuid',
};
const castNames = new Set([...Object.values(types), 'bigint', 'integer', 'smallint',
  'boolean', 'real', 'double precision', 'timestamp with time zone', 'timestamp without time zone',
  'character varying']);

function plan(sql: string) {
  if (sql.includes('__pc_') || sql.includes('__papercusp_measurement_')) return null;
  let statements: ReturnType<typeof parse>;
  try { statements = parse(sql); } catch { return null; }
  const select = statements[0];
  if (statements.length !== 1 || (select?.type !== 'select' && select?.type !== 'with')) return null;
  // Deliberately support one nonrecursive WITH scope. Every unqualified FROM
  // must name one of its bindings; it must never resolve a current search_path.
  const bindings = select.type === 'with' ? select.bind.map(b => b.alias.name) : [];
  if (new Set(bindings).size !== bindings.length) return null;
  const sources: SelectFromStatement[] = [];
  let table: { schema?: string; name: string; alias?: string } | undefined;
  let valid = true;
  const kinds = new Set(['with', 'select', 'table', 'ref', 'binary', 'unary', 'call', 'cast',
    'case', 'integer', 'numeric', 'string', 'boolean', 'null', 'constant', 'list', 'member']);
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const n = value as Record<string, any>;
    if (typeof n.type === 'string' && !kinds.has(n.type)) valid = false;
    if (n.type === 'with' && n !== select) valid = false;
    if (n.type === 'select') {
      if (n.for || n.skip || n.limit || n.from?.length > 1) valid = false;
      const from = n.from?.[0];
      if (from && (from.type !== 'table' || from.join)) valid = false;
      if (from?.type === 'table' && from.name.schema) {
        if (table && (from.name.schema !== table.schema || from.name.name !== table.name)) valid = false;
        table ??= from.name;
        // The capture runs outside WITH. A base filter must depend only on
        // this row, never a CTE/subquery or a correlated outer alias.
        const independent = (value: unknown): boolean => {
          if (!value || typeof value !== 'object') return true;
          const expr = value as Record<string, any>;
          if (expr.type === 'select' || expr.type === 'with' ||
              (expr.type === 'ref' && expr.table &&
                (expr.table.name !== (from.name.alias ?? from.name.name) ||
                  (expr.table.schema && expr.table.schema !== from.name.schema)))) return false;
          return Object.values(expr).every(independent);
        };
        if (!independent(n.where)) valid = false;
        sources.push(n as SelectFromStatement);
      }
    }
    if (n.type === 'table' && !n.name.schema && !bindings.includes(n.name.name)) valid = false;
    if (n.opSchema || n.collate) valid = false;
    if (n.type === 'call' && (!pureCalls.has(n.function.name) ||
        (n.function.schema && n.function.schema !== 'pg_catalog'))) valid = false;
    if (n.type === 'cast' && (n.to.kind !== undefined || !castNames.has(n.to.name) ||
        (n.to.schema && n.to.schema !== 'pg_catalog') || n.to.config)) valid = false;
    Object.values(n).forEach(visit);
  };
  visit(select);
  return valid && table && sources.length ? { select, table, sources } : null;
}

/** The aggregate and source export are one SQL statement, hence one MVCC
 * snapshot. The source repeats the union of the base WHERE scopes. OR over
 * the original relation retains actual duplicate rows without duplicating
 * rows that satisfy several CTE filters. Each CTE reapplies its exact filter. It
 * never changes the aggregate's population or substitutes the capped rows.
 * Plain tables only: views, foreign tables and volatile statistic readers are
 * deliberately unavailable. Every source value is exported as text by PG so
 * JSON parsing cannot round bigint/numeric inputs.
 */
export function retainedSqlCaptureExpression(sql: string): string | null {
  const p = plan(sql);
  if (!p) return null;
  const relation = ident(p.table.schema!) + '.' + ident(p.table.name);
  const unqualified = astMapper(() => ({ ref: ref => ({ ...ref, table: undefined }) }));
  const scopes = p.sources.map(s => s.where ? toSql.expr(unqualified.expr(s.where)!) : 'true');
  const filtered = `SELECT * FROM ${relation} WHERE ${scopes.map(s => `(${s})`).join(' OR ')}`;
  return `(WITH __pc_rows AS MATERIALIZED (SELECT * FROM (${filtered}) __pc_filtered LIMIT ${MAX_ROWS + 1}),
    __pc_input AS (SELECT pg_catalog.jsonb_build_object(
      'version',1,'relation',${literal(relation)},
      'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'typeOid',a.atttypid::text) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a WHERE a.attrelid=${literal(relation)}::pg_catalog.regclass AND a.attnum>0 AND NOT a.attisdropped),
      'rows',coalesce(pg_catalog.jsonb_agg((SELECT pg_catalog.jsonb_object_agg(e.key,e.value #>> '{}')
        FROM pg_catalog.jsonb_each(pg_catalog.to_jsonb(r)) e)),'[]'::jsonb),
      'truncated',count(*)>${MAX_ROWS}) payload FROM __pc_rows r)
    SELECT CASE WHEN pg_catalog.octet_length(payload::text)<=${MAX_BYTES}
      AND (SELECT c.relkind IN ('r','p') FROM pg_catalog.pg_class c WHERE c.oid=${literal(relation)}::pg_catalog.regclass)
      THEN payload ELSE pg_catalog.jsonb_build_object('version',1,'truncated',true) END FROM __pc_input)`;
}

/** Closed replay query: its only relation is a typed literal recordset. No
 * source table, view, clock, arbitrary function, custom type or operator is
 * dispatched. The existing read-only SQL executor supplies timeout/row caps.
 */
export function compileRetainedSql(sql: string, input: unknown, transactionAt: string): string | null {
  const p = plan(sql);
  if (!p || !Number.isFinite(Date.parse(transactionAt)) || !input || typeof input !== 'object') return null;
  const s = input as Record<string, any>;
  const relation = ident(p.table.schema!) + '.' + ident(p.table.name);
  if (s.version !== 1 || s.relation !== relation || s.truncated !== false ||
      !Array.isArray(s.columns) || !s.columns.length || s.columns.length > 32 ||
      !Array.isArray(s.rows) || s.rows.length > MAX_ROWS ||
      Buffer.byteLength(JSON.stringify(s), 'utf8') > MAX_BYTES) return null;
  const columns: Array<{ name: string; typeOid: string }> = s.columns;
  if (columns.some(c => !c || typeof c.name !== 'string' || !c.name || !types[c.typeOid]) ||
      new Set(columns.map(c => c.name)).size !== columns.length ||
      s.rows.some((row: unknown) => !row || typeof row !== 'object' || Array.isArray(row) ||
        Object.keys(row).length !== columns.length || columns.some(c => !Object.hasOwn(row, c.name)) ||
        Object.values(row).some(v => v !== null && typeof v !== 'string'))) return null;
  const mapper = astMapper(map => ({
    fromTable: from => from.name.schema
      ? { ...from, name: { name: sourceName, alias: from.name.alias ?? from.name.name } } : from,
    ref: ref => ref.table?.schema ? { ...ref, table: { name: ref.table.name } } : ref,
    cast: c => ({ ...map.super().cast(c)!, to: { ...c.to, schema: 'pg_catalog' } }),
    call: c => c.function.name === 'now' || c.function.name === 'transaction_timestamp'
      ? { type: 'cast', operand: { type: 'string', value: transactionAt }, to: { name: 'timestamptz', schema: 'pg_catalog' } }
      : { ...map.super().call(c)!, function: { ...c.function, schema: 'pg_catalog' } },
  }));
  const query = toSql.statement(mapper.statement(p.select)!);
  const fields = columns.map(c => ident(c.name) + ' pg_catalog.' + types[c.typeOid]).join(',');
  return `WITH ${ident(sourceName)} AS (SELECT * FROM pg_catalog.jsonb_to_recordset(${literal(JSON.stringify(s.rows))}::pg_catalog.jsonb) AS __pc_values(${fields})) SELECT * FROM (${query}) __pc_replayed_query`;
}

export function retainedSqlImplementationSha256(): string {
  return createHash('sha256').update(JSON.stringify({ parser: 'pgsql-ast-parser/12.0.2', version: 1,
    helpers: [plan, retainedSqlCaptureExpression, compileRetainedSql, ident, literal].map(fn => fn.toString()),
    pureCalls: [...pureCalls], types, castNames: [...castNames], MAX_ROWS, MAX_BYTES, sourceName })).digest('hex');
}
