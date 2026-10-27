/** P-014 / R-10. Static Postgres lineage; positive evidence is always a lower bound. */
import { createHash } from 'node:crypto';
import { parse } from 'pgsql-ast-parser';
import type * as TS from 'typescript';
import type { Ts } from './typescript-service';
import type { ReuseBriefProvider, ReuseProviderContext } from './reuse-brief-providers';

export const POSTGRES_LINEAGE_VERSION = 'pgsql-ast-parser/12.0.2:lineage-v1';
export interface LineageSource { path: string; text: string }
export interface LineageSite {
  path: string; line1: number; functionName: string; contentHash: string;
  table: string; column: string | null;
  access: 'read' | 'write' | 'ddl' | 'invalidate';
  queryName?: string;
  evidence: 'syntax' | 'declared-registry';
}
export interface LineageUnknown { path: string; line1: number; reason: string }
export interface PostgresLineage {
  version: string; sourceFingerprint: string; sourceFiles: { path: string; contentHash: string }[];
  sites: LineageSite[]; unknown: LineageUnknown[];
  coverage: 'bounded-static-lower-bound';
}
/** Registry entries carry the real query identifier and its declared tables. */
export interface SyncLineageRegistry { queryName: string; tables: readonly string[] }
type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const qualified = (value: unknown): string | undefined => {
  const n = obj(value), name = str(n.name);
  return name ? (str(n.schema) ? `${n.schema}.${name}` : name) : undefined;
};
interface Relation { table: string; columns?: Map<string, { table: string; column: string }[]> }
type Scope = Map<string, Relation>;

export function buildPostgresLineage(ts: Ts, sources: readonly LineageSource[],
  registry: readonly SyncLineageRegistry[] = []): PostgresLineage {
  const sourceFiles = sources.map(s => ({ path: s.path, contentHash: digest(s.text) })).sort((a,b) => a.path.localeCompare(b.path));
  const report: PostgresLineage = { version: POSTGRES_LINEAGE_VERSION,
    sourceFingerprint: digest(JSON.stringify({ sourceFiles, registry, version: POSTGRES_LINEAGE_VERSION })),
    sourceFiles, sites: [], unknown: [], coverage: 'bounded-static-lower-bound' };
  for (const source of sources) {
    const contentHash = digest(source.text);
    const sf = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true,
      source.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const location = (node?: TS.Node) => ({ path: source.path,
      line1: node ? sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 : 1,
      functionName: node ? enclosingName(node) : '<migration>', contentHash });
    const enclosingName = (node: TS.Node): string => {
      const names: string[] = [];
      for (let p: TS.Node | undefined = node.parent; p && p !== sf; p = p.parent) {
        if (ts.isFunctionLike(p)) {
          const named = 'name' in p && p.name ? p.name.getText(sf) :
            (ts.isVariableDeclaration(p.parent) || ts.isPropertyAssignment(p.parent)) ? p.parent.name.getText(sf) : undefined;
          names.unshift(named ?? `<anonymous@${sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1}>`);
        }
      }
      return names.join('.') || '<module>';
    };
    const unknown = (reason: string, node?: TS.Node) => { const loc = location(node);
      report.unknown.push({ path: loc.path, line1: loc.line1, reason }); };
    const emit = (access: LineageSite['access'], table: string, column: string | null, node?: TS.Node, queryName?: string,
      evidence: LineageSite['evidence'] = 'syntax') => {
      report.sites.push({ ...location(node), table, column, access, evidence, ...(queryName ? { queryName } : {}) });
    };
    const sql = (text: string, node?: TS.Node, queryName?: string) => {
      const add = (access: LineageSite['access'], table: string, column: string | null) => emit(access, table, column, node, queryName);
      const issue = (reason: string) => unknown(reason, node);
      const resolve = (ref: Obj, scope: Scope): { table: string; column: string }[] => {
        const column = str(ref.name);
        if (!column) return [];
        const qualifier = qualified(ref.table);
        const relations = qualifier ? [scope.get(qualifier)].filter((r): r is Relation => Boolean(r)) : [...new Set(scope.values())];
        if (relations.length !== 1) { issue(`Unresolved or ambiguous SQL column ${qualifier ? qualifier + '.' : ''}${column}`); return []; }
        const relation = relations[0]!;
        if (relation.columns) {
          const columns = relation.columns.get(column);
          if (!columns) { issue(`Unresolved derived column ${column}`); return []; }
          return columns;
        }
        if (column === '*') { issue('Wildcard column membership is unmeasured'); return []; }
        return [{ table: relation.table, column }];
      };
      const refs = (value: unknown, scope: Scope): { table: string; column: string }[] => {
        if (Array.isArray(value)) return value.flatMap(v => refs(v, scope));
        const v = obj(value);
        if (v.type === 'ref') return resolve(v, scope);
        if (['select', 'with', 'union', 'union all'].includes(str(v.type) ?? '')) { statement(v, new Map(scope)); return []; }
        return Object.values(v).flatMap(child => child && typeof child === 'object' ? refs(child, scope) : []);
      };
      const statement = (s: Obj, ctes: Scope): Map<string, { table: string; column: string }[]> => {
        const output = new Map<string, { table: string; column: string }[]>();
        if (s.type === 'with') {
          const local = new Map(ctes);
          for (const bind of list(s.bind)) {
            const b = obj(bind), name = qualified(b.alias);
            const columns = statement(obj(b.statement), local);
            if (name) local.set(name, { table: name, columns });
          }
          return statement(obj(s.in), local);
        }
        if (s.type === 'union' || s.type === 'union all') {
          statement(obj(s.left), ctes); statement(obj(s.right), ctes); issue('Union output column mapping is partial'); return output;
        }
        const scope: Scope = new Map();
        const relation = (name: unknown, access: LineageSite['access']): string | undefined => {
          const table = qualified(name), n = obj(name);
          if (!table) { issue('Unresolved SQL relation'); return undefined; }
          const derived = ctes.get(table);
          const r = derived ?? { table };
          scope.set(str(n.alias) ?? table, r);
          if (!n.alias) scope.set(str(n.name)!, r);
          if (!derived) add(access, table, null);
          return derived ? undefined : table;
        };
        const readRefs = (value: unknown) => { const found = refs(value, scope); for (const r of found) add('read', r.table, r.column); return found; };
        const from = (value: unknown) => {
          for (const raw of list(value)) {
            const f = obj(raw);
            if (f.type === 'table') relation(f.name, 'read');
            else if (f.type === 'statement') {
              const columns = statement(obj(f.statement), ctes), alias = str(f.alias);
              if (alias) scope.set(alias, { table: alias, columns }); else issue('Subquery has no resolvable alias');
            } else issue(`Unsupported FROM ${String(f.type)}`);
          }
        };
        if (s.type === 'select') {
          from(s.from);
          for (const raw of list(s.columns)) {
            const c = obj(raw), found = readRefs(c.expr), name = qualified(c.alias) ?? str(obj(c.expr).name);
            if (name) output.set(name, found);
          }
          for (const f of list(s.from)) readRefs(obj(f).join);
          readRefs(s.where); readRefs(s.groupBy); readRefs(s.having); readRefs(s.orderBy);
        } else if (s.type === 'update') {
          const table = relation(s.table, 'write'); from(s.from);
          for (const raw of list(s.sets)) { const set = obj(raw), column = qualified(set.column);
            if (table && column) add('write', table, column); readRefs(set.value); }
          readRefs(s.where); readRefs(s.returning);
        } else if (s.type === 'insert') {
          const table = relation(s.into, 'write');
          if (!list(s.columns).length) issue('INSERT without explicit columns has unknown column membership');
          for (const c of list(s.columns)) { const column = qualified(c); if (table && column) add('write', table, column); }
          const insert = obj(s.insert);
          if (insert.type === 'values') readRefs(insert.values); else statement(insert, ctes);
          if (s.onConflict) issue('ON CONFLICT update mapping is partial');
          readRefs(s.returning);
        } else if (s.type === 'delete') {
          relation(s.from, 'write'); from(s.using); readRefs(s.where); readRefs(s.returning);
          issue('DELETE writes whole rows; per-column mutation is unmeasured');
        } else if (s.type === 'create table') {
          const table = qualified(s.name); if (table) { add('ddl', table, null);
            for (const c of list(s.columns)) { const col = obj(c); if (col.kind === 'column') {
              const name = qualified(col.name); if (name) add('ddl', table, name);
            } }
          }
        } else if (s.type === 'alter table') {
          const table = qualified(s.table); if (table) { add('ddl', table, null);
            for (const c of list(s.changes)) { const change = obj(c);
              const column = qualified(obj(change.column).name) ?? qualified(change.column);
              if (column) add('ddl', table, column); else issue('ALTER TABLE change has unknown column mapping'); }
          }
        } else issue(`Unsupported Postgres statement ${String(s.type)}`);
        return output;
      };
      try { for (const s of parse(text)) statement(obj(s), new Map()); }
      catch (error) { issue(`Postgres parse failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
    };
    if (source.path.endsWith('.sql')) { sql(source.text); continue; }
    const diagnostics = (sf as TS.SourceFile & { parseDiagnostics?: readonly TS.Diagnostic[] }).parseDiagnostics;
    if (diagnostics?.length) { unknown('TypeScript source has parse diagnostics'); continue; }
    const literal = (n: TS.Node | undefined): string | undefined => n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : undefined;
    const queryNameFor = (node: TS.Node): string | undefined => {
      for (let p: TS.Node | undefined = node; p && p !== sf; p = p.parent) {
        if (ts.isPropertyAssignment(p)) { const name = literal(p.name);
          if (name && registry.some(r => r.queryName === name)) return name; }
        if (ts.isCaseClause(p)) { const name = literal(p.expression);
          if (name && registry.some(r => r.queryName === name)) return name; }
      }
      return undefined;
    };
    const visit = (n: TS.Node) => {
      if (ts.isPropertyAssignment(n)) {
        const name = literal(n.name), entry = registry.find(r => r.queryName === name);
        if (entry) for (const table of entry.tables) emit('read', table, null, n.name, entry.queryName, 'declared-registry');
      }
      if (ts.isCallExpression(n)) {
        const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text :
          ts.isIdentifier(n.expression) ? n.expression.text : '';
        if (callee === 'notifySyncInvalidate') {
          const queryName = literal(n.arguments[0]), entry = registry.find(r => r.queryName === queryName);
          if (entry) for (const table of entry.tables) emit('invalidate', table, null, n, entry.queryName, 'declared-registry');
          else unknown('Invalidation query name or typed registry table mapping unresolved', n);
        }
        if (['query', 'unsafe', 'execute', 'exec'].includes(callee)) {
          const arg = n.arguments[0], text = literal(arg);
          if (text !== undefined) sql(text, arg, queryNameFor(n));
          else unknown('SQL query uses dynamic/helper text; readers and writers unknown', n);
        }
      }
      if (ts.isTaggedTemplateExpression(n) && (/(?:^|\.)(?:sql|raw|tx)$/.test(n.tag.getText(sf))
        || /^\s*(?:select|with|insert|update|delete|create|alter|drop)\b/i.test(
          ts.isTemplateExpression(n.template) ? n.template.head.text : n.template.text))) {
        const text = literal(n.template);
        if (text !== undefined) sql(text, n.template, queryNameFor(n));
        else unknown('SQL template interpolation may change identifiers/fragments; lineage unknown', n);
      }
      // Integration fixture authoring can be detected even outside a query call.
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /^\s*(?:create|alter)\s+table\b/i.test(n.text)
        && !(ts.isCallExpression(n.parent) && n.parent.arguments[0] === n)
        && !ts.isTaggedTemplateExpression(n.parent)) sql(n.text, n);
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  report.sites = [...new Map(report.sites.map(s => [JSON.stringify(s), s])).values()];
  report.unknown = [...new Map(report.unknown.map(s => [JSON.stringify(s), s])).values()];
  return report;
}

export function queryPostgresLineage(report: PostgresLineage, table: string, column?: string) {
  // A whole-row write/invalidation applies to the table, but is never a proved column writer.
  const sites = report.sites.filter(s => s.table === table && (!column || s.column === column || s.column === null && s.access === 'invalidate'));
  return { ...report, sites, query: { table, column: column ?? null },
    complete: false as const, limitations: ['Static bounded inputs only; absent sites never prove no readers or writers.'] };
}

/** Same provider identity on claim, authoring and completion; the composer owns caps/issuance. */
export function postgresLineageProvider(read: (context: ReuseProviderContext, signal: AbortSignal) => Promise<{
  report: PostgresLineage; sourceVersion: string;
} | null>): ReuseBriefProvider {
  return { id: 'sql', async read(context, signal) {
    const captured = await read(context, signal);
    if (!captured || captured.sourceVersion !== context.sourceVersion || signal.aborted)
      return { status: 'unknown', lines: [], sourceVersion: null, indexVersion: null };
    const report = captured.report;
    if (context.surface === 'completion' && !context.checkedPaths)
      return { status: 'unknown', lines: [], sourceVersion: captured.sourceVersion, indexVersion: report.sourceFingerprint };
    const touched = report.sites.filter(s => context.paths.includes(s.path));
    const tables = new Set(touched.map(s => s.table));
    let sites = report.sites.filter(s => tables.has(s.table));
    let prefix = 'SQL readers/writers (static lower bound)';
    if (context.surface === 'authoring') { sites = sites.filter(s => s.access === 'ddl' && /(?:test|fixture)/i.test(s.path)); prefix = 'Hand-rolled affected SQL fixture'; }
    if (context.surface === 'completion') { sites = sites.filter(s => s.access === 'read' && !context.checkedPaths!.includes(s.path)); prefix = 'SQL reader left unchecked in bound source scope'; }
    const lines = sites.slice(0, 8).map(s => `${prefix}: ${s.table}${s.column ? '.' + s.column : ''} ${s.access} ${s.functionName} ${s.path}:${s.line1}`);
    if (report.unknown.length) lines.push(`SQL lineage partial: ${report.unknown.length} unresolved source locations; query graph:query op sql-lineage for recovery.`);
    return { status: 'measured', lines, sourceVersion: captured.sourceVersion, indexVersion: report.sourceFingerprint,
      citedPaths: [...new Set(sites.map(s => s.path))] };
  } };
}
