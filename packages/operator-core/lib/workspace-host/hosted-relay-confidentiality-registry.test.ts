import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import {
  HOSTED_CONTROL_PLANE_FIELD_REGISTRY,
  HOSTED_CONTROL_PLANE_WRITER_REGISTRY,
  HOSTED_RELAY_FRAME_REGISTRY,
  PLAINTEXT_CONSUMERS,
} from './hosted-relay-confidentiality-registry';

const REPO = resolve(__dirname, '../../../..');

/** Every source that defines or dispatches a hosted relay frame type. */
const FRAME_SOURCES = [
  'packages/operator-core/lib/workspace-host/hosted-session-host.ts',
  'packages/operator-core/lib/workspace-host/hosted-app-relay.ts',
  'packages/operator-core/lib/workspace-host/hosted-operator-http.ts',
  'packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts',
  'apps/operator/app/cloud-workspaces/hosted-desktop-viewer-protocol.ts',
  'apps/operator/app/cloud-workspaces/hosted-workspace-session-protocol.ts',
];

/**
 * Literals the frame-type regex also matches that are NOT frame types: channel/open
 * kinds (`HostedHostOpenKind`), handoff discriminants and a `typeof` check.
 */
const NON_FRAME_LITERALS = new Set([
  'pty', 'psu', 'desktop', 'operator-http', 'app-http', 'app-key-mint',
  'file', 'directory', 'string', 'enrollment', 'session',
]);

const FRAME_RE = /(?:case|type ===|type !==|type:)\s*(['"])([a-z0-9_.-]+)\1/g;

function frameLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const rel of FRAME_SOURCES) {
    const src = readFileSync(resolve(REPO, rel), 'utf8');
    for (const m of src.matchAll(FRAME_RE)) {
      const lit = m[2]!;
      if (NON_FRAME_LITERALS.has(lit)) continue;
      found.set(lit, [...(found.get(lit) ?? []), rel]);
    }
  }
  return found;
}

function interfaceKeys(rel: string, name: string): string[] {
  const src = readFileSync(resolve(REPO, rel), 'utf8');
  const start = src.indexOf(`export interface ${name} {`);
  expect(start, `${name} not found in ${rel}`).toBeGreaterThanOrEqual(0);
  const body = src.slice(start, src.indexOf('\n}', start));
  return [...body.matchAll(/^\s+([a-zA-Z]+)\??:/gm)].map((m) => m[1]!);
}

/** Scan the literal INSERT column lists, including every writer of this table. */
function routeInvocationColumns(source: string): string[] {
  const columns = new Set<string>();
  const inserts = /\bINSERT\s+INTO\s+harness_shared\.route_invocations\s*\(([^)]+)\)/gi;
  for (const match of source.matchAll(inserts)) {
    for (const column of match[1]!.split(',')) columns.add(column.trim());
  }
  return [...columns].sort();
}

function addRouteInvocationColumn(source: string, column: string): string {
  return source.replace(
    /(\bINSERT\s+INTO\s+harness_shared\.route_invocations\s*\([^)]*)\)/i,
    `$1, ${column})`,
  );
}


/** Inspect SQL template literals, omitting JS expressions so nested commas cannot hide columns. */
function sqlWriterColumns(source: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const tree = ts.createSourceFile('writer.ts', source, ts.ScriptTarget.Latest, true);
  function assignments(table: string, sql: string) {
    const columns = found.get(table) ?? new Set<string>();
    for (const match of sql.matchAll(/(?:^|,)\s*([a-z_]+)\s*=/gi)) columns.add(match[1]!);
    found.set(table, columns);
  }
  function visit(node: ts.Node) {
    if (ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || ts.isStringLiteral(node)) {
      const sql = (ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map((span) => ' __binding__ ' + span.literal.text).join('')
        : node.text
      ).replace(/--[^\n]*/g, '');
      for (const match of sql.matchAll(/\bINSERT\s+INTO\s+([a-z_]+\.[a-z_]+)\s*\(([^)]+)\)/gi)) {
        const table = match[1]!;
        const columns = found.get(table) ?? new Set<string>();
        for (const column of match[2]!.split(',')) columns.add(column.trim());
        found.set(table, columns);
        const upsert = sql.match(/\bDO\s+UPDATE\s+SET\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i);
        if (upsert) assignments(table, upsert[1]!);
      }
      for (const match of sql.matchAll(/\bUPDATE\s+([a-z_]+\.[a-z_]+)(?:\s+(?:AS\s+)?[a-z_]+)?\s+SET\s+([\s\S]*?)\bWHERE\b/gi)) {
        assignments(match[1]!, match[2]!);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

/** Bind Drizzle row fields to their insert target; unresolved targets fail closed. */
function auditObjectFields(source: string): { rows: Record<string, string[]>; details: string[]; dynamic: string[] } {
  const rows = new Map<string, Set<string>>();
  const details = new Set<string>();
  const dynamic: string[] = [];
  const tree = ts.createSourceFile('audit.ts', source, ts.ScriptTarget.Latest, true);
  function tableTarget(expression: ts.Expression, seen = new Set<ts.Node>()): string | undefined {
    if (seen.has(expression)) return undefined;
    seen.add(expression);
    if (ts.isParenthesizedExpression(expression)) return tableTarget(expression.expression, seen);
    if (ts.isPropertyAccessExpression(expression)) return expression.getText(tree);
    if (!ts.isIdentifier(expression)) return undefined;
    // Resolve const aliases in their nearest lexical scope. A same-named local
    // declaration or parameter must never resolve to a different outer table.
    for (let scope: ts.Node | undefined = expression.parent; scope; scope = scope.parent) {
      if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
        for (const statement of scope.statements) {
          if (!ts.isVariableStatement(statement)) continue;
          const declaration = statement.declarationList.declarations.find((candidate) =>
            ts.isIdentifier(candidate.name) && candidate.name.text === expression.text);
          if (declaration) {
            if (!(statement.declarationList.flags & ts.NodeFlags.Const)
              || declaration.pos >= expression.pos || !declaration.initializer) return undefined;
            return tableTarget(declaration.initializer, seen);
          }
        }
      }
      if (ts.isFunctionLike(scope) && scope.parameters.some((parameter) =>
        ts.isIdentifier(parameter.name) && parameter.name.text === expression.text)) return undefined;
    }
    return undefined;
  }
  function objectKeys(object: ts.ObjectLiteralExpression, fields: Set<string>) {
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        // Hosted optional fields use conditional spreads of literal objects.
        let objects = 0;
        function nested(node: ts.Node) {
          if (ts.isObjectLiteralExpression(node)) { objects++; objectKeys(node, fields); }
          else ts.forEachChild(node, nested);
        }
        nested(property.expression);
        if (!objects) dynamic.push(property.getText(tree));
      } else if (property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        fields.add(property.name.text);
      } else dynamic.push(property.getText(tree));
    }
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'values'
      && ts.isCallExpression(node.expression.expression)
      && ts.isPropertyAccessExpression(node.expression.expression.expression)
      && node.expression.expression.expression.name.text === 'insert') {
      const insert = node.expression.expression;
      const target = insert.arguments.length === 1 && insert.arguments[0]
        ? tableTarget(insert.arguments[0]) : undefined;
      if (!target) {
        dynamic.push(node.getText(tree));
        ts.forEachChild(node, visit);
        return;
      }
      const row = rows.get(target) ?? new Set<string>();
      rows.set(target, row);
      const value = node.arguments[0];
      if (value && ts.isObjectLiteralExpression(value)) objectKeys(value, row);
      else dynamic.push(node.getText(tree));
    }
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'hostedDesktopAuditRow') {
      function hosted(child: ts.Node) {
        if (ts.isVariableDeclaration(child) && child.name.getText(tree) === 'details') {
          if (child.initializer && ts.isObjectLiteralExpression(child.initializer)) objectKeys(child.initializer, details);
          else dynamic.push(child.getText(tree));
        }
        ts.forEachChild(child, hosted);
      }
      hosted(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return {
    rows: Object.fromEntries([...rows].map(([table, fields]) => [table, [...fields].sort()])),
    details: [...details].sort(),
    dynamic,
  };
}

/** Census the arguments reaching console, including a newly introduced method/site. */
function consoleArgumentFields(source: string): string[] {
  const fields: string[] = [];
  const counts = new Map<string, number>();
  const tree = ts.createSourceFile('warnings.ts', source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(tree) === 'console') {
      const method = node.expression.name.text;
      const ordinal = counts.get(method) ?? 0;
      counts.set(method, ordinal + 1);
      node.arguments.forEach((_, index) => fields.push(`${method}.${ordinal}.argument.${index}`));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return fields.sort();
}

/** Callback warnings reach the runtime console transitively, outside its census. */
function dynamicHostWarnings(source: string): string[] {
  const found: string[] = [];
  const tree = ts.createSourceFile('host-warnings.ts', source, ts.ScriptTarget.Latest, true);
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)
      && ['warn', 'this.warn', 'this.options.onWarning'].includes(node.expression.getText(tree).replace(/\?\./g, '.'))) {
      if (node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0]!)) found.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return found;
}

function environmentKeys(source: string, constants: Readonly<Record<string, string>> = {}): { keys: string[]; dynamic: string[] } {
  const keys = new Set<string>();
  const dynamic: string[] = [];
  const tree = ts.createSourceFile('config.ts', source, ts.ScriptTarget.Latest, true);
  function isEnvironment(node: ts.Node) {
    return ['env', 'process.env'].includes(node.getText(tree));
  }
  function visit(node: ts.Node) {
    if (ts.isPropertyAccessExpression(node) && isEnvironment(node.expression)) {
      keys.add(node.name.text);
    } else if (ts.isElementAccessExpression(node) && isEnvironment(node.expression)) {
      if (ts.isStringLiteral(node.argumentExpression)) keys.add(node.argumentExpression.text);
      else if (ts.isIdentifier(node.argumentExpression) && constants[node.argumentExpression.text]) keys.add(constants[node.argumentExpression.text]!);
      else dynamic.push(node.getText(tree));
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { keys: [...keys].sort(), dynamic };
}

describe('hosted relay confidentiality registry (P-001)', () => {
  it('classifies every frame type literal in the relay sources', () => {
    const found = frameLiterals();
    // Positive control: the scan must see a known content frame, or it is blind.
    expect(found.has('pty.output')).toBe(true);
    expect(found.has('http.request')).toBe(true);
    const unclassified = [...found.keys()].filter((t) => !(t in HOSTED_RELAY_FRAME_REGISTRY));
    expect(unclassified, 'new frame types must be classified in hosted-relay-confidentiality-registry.ts').toEqual([]);
  });

  it('has no stale registry entries (every classified type still exists in source)', () => {
    const found = frameLiterals();
    const stale = Object.keys(HOSTED_RELAY_FRAME_REGISTRY).filter((t) => !found.has(t));
    expect(stale).toEqual([]);
  });

  it('classifies every control-plane audit field', () => {
    const sinks: Array<[string, string, string]> = [
      ['broker-audit', 'packages/operator-core/lib/endpoint-route/hosted-workspace-session.ts', 'HostedWorkspaceSessionAuditEvent'],
      ['host-audit', 'packages/operator-core/lib/workspace-host/hosted-session-host.ts', 'HostedHostAuditEvent'],
      ['app-relay-audit', 'packages/operator-core/lib/workspace-host/hosted-app-relay.ts', 'HostedAppRelayAuditEvent'],
    ];
    for (const [sink, rel, name] of sinks) {
      const keys = interfaceKeys(rel, name);
      expect(keys.length).toBeGreaterThan(0);
      expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]!).sort()).toEqual([...keys].sort());
    }
  });

  it('records no audit field as content (control-plane sinks are metadata-only)', () => {
    for (const sink of ['broker-audit', 'host-audit', 'app-relay-audit']) {
      const fields = HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]!;
      for (const cls of Object.values(fields)) expect(cls.sensitivity).toBe('control');
    }
  });


  it('classifies every column written by both route telemetry INSERT paths', () => {
    const source = readFileSync(resolve(REPO, 'packages/operator-core/lib/endpoint-route/telemetry.ts'), 'utf8');
    const columns = routeInvocationColumns(source);
    // Positive controls distinguish the ordinary route and internal receipt writers.
    expect(columns).toContain('resolved_path');
    expect(columns).toContain('metadata_json');
    expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocations']!).sort()).toEqual(columns);
  });

  it('detects a new persisted telemetry field instead of silently ignoring it', () => {
    const source = readFileSync(resolve(REPO, 'packages/operator-core/lib/endpoint-route/telemetry.ts'), 'utf8');
    const changed = addRouteInvocationColumn(source, 'customer_payload');
    expect(changed).not.toBe(source);
    const registered = HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocations']!;
    expect(routeInvocationColumns(changed).filter((column) => !(column in registered))).toEqual(['customer_payload']);
  });

  it.each([
    'INSERT INTO harness_shared.route_invocations (workspace_id, resolved_path, response_bytes)',
    'INSERT INTO harness_shared.route_invocations\n (workspace_id, resolved_path, response_bytes, metadata_json)',
    'insert into harness_shared.route_invocations\n (workspace_id, metadata_json, response_bytes, resolved_path)',
  ])('detects an added telemetry column across SQL layouts: %s', (source) => {
    const changed = addRouteInvocationColumn(source, 'customer_payload');
    expect(changed).not.toBe(source);
    const registered = HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocations']!;
    expect(routeInvocationColumns(changed).filter((column) => !(column in registered))).toEqual(['customer_payload']);
  });

  it('does not classify unallowlisted telemetry paths or structured receipts as control metadata', () => {
    const fields = HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocations']!;
    for (const field of ['resolved_path', 'error_message', 'metadata_json']) {
      expect(fields[field]!.sensitivity).toBe('content');
    }
  });


  it('classifies INSERT, UPDATE and upsert columns for every registered SQL writer source', () => {
    const population = new Map<string, Set<string>>();
    const sqlWriters = Object.entries(HOSTED_CONTROL_PLANE_WRITER_REGISTRY)
      .flatMap(([sink, writer]) => 'table' in writer ? [{ sink, table: writer.table, sources: [...writer.sources] }] : []);
    const sources = new Set(sqlWriters.flatMap((writer) => writer.sources));
    for (const source of sources) {
      const writes = sqlWriterColumns(readFileSync(resolve(REPO, source), 'utf8'));
      expect(writes.size, source).toBeGreaterThan(0);
      for (const [table, columns] of writes) {
        const writer = sqlWriters.find((candidate) => candidate.table === table);
        expect(writer, 'new literal SQL sink in ' + source + ': ' + table).toBeDefined();
        expect(writer!.sources, 'unregistered writer source for ' + table).toContain(source);
        const union = population.get(table) ?? new Set<string>();
        for (const column of columns) union.add(column);
        population.set(table, union);
      }
    }
    for (const { sink, table } of sqlWriters) {
      expect(population.get(table)?.size, sink + ' positive control').toBeGreaterThan(0);
      expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]!).sort(), sink)
        .toEqual([...population.get(table)!].sort());
    }
    // These are UPDATE-only; an INSERT-only census would omit the actual content sinks.
    expect(population.get('harness_shared.workspace_host_initialization_steps')).toContain('public_evidence');
    expect(population.get('harness_shared.workspace_host_operations')).toContain('orphaned_at');
    expect(population.get('harness_shared.workspace_hosts')).toContain('health_checks');
  });

  it('detects new receipt UPDATE fields and new SQL sinks with binding commas present', () => {
    const source = readFileSync(resolve(REPO, 'packages/operator-core/lib/workspace-host/initialization-replay-store.ts'), 'utf8');
    const changed = source.replace('public_evidence =', 'customer_payload =');
    expect(changed).not.toBe(source);
    const fields = HOSTED_CONTROL_PLANE_FIELD_REGISTRY['workspace-host-initialization-steps']!;
    expect([...sqlWriterColumns(changed).get('harness_shared.workspace_host_initialization_steps')!]
      .filter((field) => !(field in fields))).toEqual(['customer_payload']);
    const extra = source + '\n tx' + String.fromCharCode(96)
      + 'INSERT INTO harness_shared.unclassified_sink (customer_payload) VALUES (' + String.fromCharCode(36) + '{fn(1, 2)})'
      + String.fromCharCode(96) + ';';
    expect(sqlWriterColumns(extra).get('harness_shared.unclassified_sink')).toEqual(new Set(['customer_payload']));
  });

  it('binds configuration classification to both production environment readers', () => {
    const constantsSource = readFileSync(resolve(REPO, 'packages/operator-core/lib/auth/hosted/first-workspace-dependencies.ts'), 'utf8');
    const constant = constantsSource.match(/export const HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV = '([^']+)'/);
    expect(constant, 'production imported configuration key positive control').not.toBeNull();
    const constants = { HOSTED_FIRST_WORKSPACE_ORGANIZATIONS_ENV: constant![1]! };
    for (const sink of ['vendor-runtime-config', 'customer-host-config'] as const) {
      const writer = HOSTED_CONTROL_PLANE_WRITER_REGISTRY[sink];
      const keys = new Set<string>();
      for (const source of writer.sources) {
        const result = environmentKeys(readFileSync(resolve(REPO, source), 'utf8'), constants);
        expect(result.dynamic, 'dynamic environment keys need an explicit census').toEqual([]);
        for (const key of result.keys) keys.add(key);
      }
      expect(keys.size, sink + ' positive control').toBeGreaterThan(0);
      expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]!).sort()).toEqual([...keys].sort());
    }
    expect(environmentKeys("env['CUSTOMER_PAYLOAD']; process.env[computedKey];"))
      .toEqual({ keys: ['CUSTOMER_PAYLOAD'], dynamic: ['process.env[computedKey]'] });
  });

  it('classifies the real Drizzle audit row, hosted detail objects and console argument populations', () => {
    const writer = HOSTED_CONTROL_PLANE_WRITER_REGISTRY['desktop-audit-row'];
    const source = readFileSync(resolve(REPO, writer.sources[0]), 'utf8');
    const found = auditObjectFields(source);
    expect(found.dynamic).toEqual([]);
    expect(Object.keys(found.rows), 'new Drizzle sink must be registered with its own fields').toEqual([writer.drizzleTable]);
    expect(found.rows[writer.drizzleTable]).toContain('details');
    expect(found.details).toContain('detail');
    expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY['desktop-audit-row']!).sort()).toEqual(found.rows[writer.drizzleTable]);
    expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY['hosted-desktop-audit-details']!).sort()).toEqual(found.details);
    for (const sink of ['desktop-audit-warnings', 'hosted-handler-warnings', 'customer-host-warnings', 'route-invocation-warnings'] as const) {
      const writer = HOSTED_CONTROL_PLANE_WRITER_REGISTRY[sink];
      const fields = writer.sources.flatMap((path) => consoleArgumentFields(readFileSync(resolve(REPO, path), 'utf8')));
      expect(fields.length, sink + ' positive control').toBeGreaterThan(0);
      expect(Object.keys(HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]!).sort()).toEqual(fields.sort());
    }
  });

  it('detects new Drizzle fields, nested audit content, dynamic objects and console sites', () => {
    const source = readFileSync(resolve(REPO, 'packages/operator-core/lib/desktop/desktop-audit.ts'), 'utf8');
    const rowChange = source.replace('details: row.details as never,', 'details: row.details as never, customerPayload: row.details,');
    const detailChange = source.replace("target: 'hosted',", "target: 'hosted', customerPayload: event.detail,");
    expect(rowChange).not.toBe(source);
    expect(detailChange).not.toBe(source);
    const table = HOSTED_CONTROL_PLANE_WRITER_REGISTRY['desktop-audit-row'].drizzleTable;
    expect(auditObjectFields(rowChange).rows[table]!.filter((field) => !(field in HOSTED_CONTROL_PLANE_FIELD_REGISTRY['desktop-audit-row']!)))
      .toEqual(['customerPayload']);
    expect(auditObjectFields(detailChange).details.filter((field) => !(field in HOSTED_CONTROL_PLANE_FIELD_REGISTRY['hosted-desktop-audit-details']!)))
      .toEqual(['customerPayload']);
    expect(auditObjectFields('drizzle(tx).insert(table).values(unclassified);').dynamic).toHaveLength(1);
    const registered = HOSTED_CONTROL_PLANE_FIELD_REGISTRY['desktop-audit-warnings']!;
    expect(consoleArgumentFields(source + '\nconsole.error(customerPayload);').filter((field) => !(field in registered)))
      .toEqual(['error.0.argument.0']);
  });

  it('keeps transitive runtime and adapter warning arguments fixed, with a raw-error negative control', () => {
    for (const path of [
      'packages/operator-core/lib/workspace-host/hosted-workspace-host-runtime.ts',
      'packages/operator-core/lib/workspace-host/hosted-session-host.ts',
    ]) {
      expect(dynamicHostWarnings(readFileSync(resolve(REPO, path), 'utf8')), path).toEqual([]);
    }
    expect(dynamicHostWarnings("warn('envelope failed: ' + String(error)); this.warn(error.message); this.options.onWarning?.(customerPayload);"))
      .toHaveLength(3);
  });

  it('detects redirected and additional Drizzle tables even when their fields are already classified', () => {
    const writer = HOSTED_CONTROL_PLANE_WRITER_REGISTRY['desktop-audit-row'];
    const source = readFileSync(resolve(REPO, writer.sources[0]), 'utf8');
    const redirected = source.replace('const table = generated.auditLogInHarnessShared;',
      'const table = generated.unclassifiedAudit;');
    expect(redirected).not.toBe(source);
    const redirectedRows = auditObjectFields(redirected).rows;
    expect(Object.keys(redirectedRows)).toEqual(['generated.unclassifiedAudit']);
    expect(redirectedRows['generated.unclassifiedAudit']).toEqual(auditObjectFields(source).rows[writer.drizzleTable]);
    const extra = source + '\nfunction extraWriter() { const table = generated.unclassifiedAudit;'
      + ' drizzle(tx).insert(table).values({ id: row.id, details: row.details }); }';
    expect(Object.keys(auditObjectFields(extra).rows).filter((target) => target !== writer.drizzleTable))
      .toEqual(['generated.unclassifiedAudit']);
  });

  it('resolves local const table aliases and refuses dynamic or shadowed Drizzle targets', () => {
    const source = 'const table = generated.auditLogInHarnessShared;'
      + ' function known() { const alias = table; drizzle(tx).insert(alias).values({ id: row.id }); }'
      + ' function separate() { const table = generated.otherAudit; drizzle(tx).insert(table).values({ details: row.details }); }';
    expect(auditObjectFields(source)).toEqual({ rows: {
      'generated.auditLogInHarnessShared': ['id'], 'generated.otherAudit': ['details'],
    }, details: [], dynamic: [] });
    for (const unknown of [
      'drizzle(tx).insert(getTable()).values({ id: row.id });',
      'const table = generated.auditLogInHarnessShared; function shadow(table) { drizzle(tx).insert(table).values({ id: row.id }); }',
      'let table = generated.auditLogInHarnessShared; drizzle(tx).insert(table).values({ id: row.id });',
    ]) {
      expect(auditObjectFields(unknown).rows).toEqual({});
      expect(auditObjectFields(unknown).dynamic).toHaveLength(1);
    }
  });

  it('keeps diagnostic, configuration and structured persistence fields content-bearing', () => {
    const content: Record<string, string[]> = {
      'workspace-host-connections': ['provider_config', 'status_detail', 'credential_ref'],
      'workspace-hosts': ['desired_spec', 'health_checks', 'endpoint'],
      'workspace-host-operations': ['request', 'error', 'message', 'teardown_reason'],
      'workspace-host-events': ['details', 'message'],
      'workspace-host-logs': ['message', 'metadata', 'unit'],
      'workspace-host-initialization-steps': ['public_evidence'],
      'customer-host-config': ['PAPERCUSP_HOSTED_CONNECTOR_BEARER', 'PAPERCUSP_HOSTED_WORKSPACE_ROOT'],
      'workspace-connectors': ['route_label'],
      'connector-tickets': ['route_label', 'audience'],
      'desktop-audit-row': ['actor', 'action', 'subject', 'details'],
      'hosted-desktop-audit-details': ['detail'],
      'customer-host-warnings': ['warn.3.argument.0'],
    };
    for (const field of ['warn.0.argument.0', 'warn.0.argument.1']) {
      expect(HOSTED_CONTROL_PLANE_FIELD_REGISTRY['route-invocation-warnings']![field]!.sensitivity).toBe('control');
    }
    for (const [sink, fields] of Object.entries(content)) {
      for (const field of fields) expect(HOSTED_CONTROL_PLANE_FIELD_REGISTRY[sink]![field]!.sensitivity, sink + '.' + field).toBe('content');
    }
    expect(HOSTED_CONTROL_PLANE_WRITER_REGISTRY['customer-host-config'].placement).toBe('customer-host-environment');
    expect(HOSTED_CONTROL_PLANE_WRITER_REGISTRY['workspace-host-operations'].placement).toBe('controller-database');
  });

  it('every content-bearing plane has at least one content frame', () => {
    for (const plane of ['workspace-session', 'operator-http', 'app-http', 'desktop-viewer'] as const) {
      expect(Object.values(HOSTED_RELAY_FRAME_REGISTRY).some((c) => c.planes.includes(plane) && c.sensitivity === 'content')).toBe(true);
    }
  });

  it('names the control-plane plaintext consumers the census found', () => {
    expect(PLAINTEXT_CONSUMERS.filter((c) => c.readsContent).map((c) => c.site)).toEqual([
      'hosted-app-relay.ts handleHostedAppRelay() (portal)',
      'hosted-app-relay.ts portal token relay',
    ]);
  });
});
