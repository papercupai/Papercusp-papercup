/** P-017: independent, tracked-tree git-grep census; scanner predicates are not the enumerator. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { isScannable, scanSites } from '../../../../scripts/lib/condition-rail-inventory.mjs';
import { stripCommentsAndStrings } from '../../../../scripts/lib/strip-comments-and-strings.mjs';
import { presentOnDisk } from '../../../../scripts/lib/tracked-files.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function readCensusSource(file: string, sourceRoot = root): string | null {
  try {
    return readFileSync(resolve(sourceRoot, file), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

it('tolerates a tracked source deleted before the census read', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'condition-census-deleted-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: fixture });
    writeFileSync(resolve(fixture, 'deleted-watchdog.ts'), 'export const alarm = true;\n');
    execFileSync('git', ['add', 'deleted-watchdog.ts'], { cwd: fixture });
    rmSync(resolve(fixture, 'deleted-watchdog.ts'));
    expect(execFileSync('git', ['ls-files'], { cwd: fixture, encoding: 'utf8' })).toContain('deleted-watchdog.ts');
    expect(readCensusSource('deleted-watchdog.ts', fixture)).toBeNull();
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

it('does not suppress census source read errors other than a missing file', () => {
  expect(() => readCensusSource('.', root)).toThrow();
});
const pattern = 'notifyAttention|escalateAlarm|console\\.(warn|error|log|info)|logger\\.(warn|error|info)|LOG\\.(warn|error|info)|log\\.(warn|error|info)|managedSetInterval|waiver[[:space:]]*:|(alarm|alarming|alert|alerting|degraded|unhealthy|breached)[[:space:]]*:';

type Candidate = { class: string; line: number };

/** Independent AST enumerator; never imports the scanner's detection predicates. */
function enumerate(raw: string, file: string) {
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true);
  const candidates: Candidate[] = [];
  const exclusions = new Map<number, string[]>();
  const masked = stripCommentsAndStrings(raw, file);
  const watchdogModule = /watchdog/i.test(file.split('/').at(-1) ?? '');
  const healthPath = /health|watchdog|alarm|monitor/i.test(file);
  let signalRegistry = false;
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const exclude = (line: number, reason: string) => exclusions.set(line, [...(exclusions.get(line) ?? []), reason]);
  const add = (cls: string, node: ts.Node) => candidates.push({ class: cls, line: lineOf(node) });
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    nodes.push(node);
    if (ts.isCallExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : '';
      if (name === 'defineSignal') signalRegistry = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  // A log message can carry its wording through a preceding const it interpolates
  // (`const outcome = … 'fallback to local execution'; console.warn(`… ${outcome}`)`).
  // Bindings are collected top-down and a name resolves to its INNERMOST enclosing
  // binding — a different mechanism from the scanner's bottom-up scope walk, so a
  // scoping/shadowing defect in either shows up here as a count mismatch.
  type Binding = { scope: ts.Node; end: number; initializer?: ts.Expression; constant: boolean };
  const bindings = new Map<string, Binding[]>();
  const bind = (name: ts.BindingName, scope: ts.Node, binding: Omit<Binding, 'scope'>): void => {
    if (ts.isIdentifier(name)) bindings.set(name.text, [...(bindings.get(name.text) ?? []), { scope, ...binding }]);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name, scope, { end: element.end, constant: false });
  };
  for (const node of nodes) {
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const declared = ts.isVariableDeclarationList(list);
      const scope = !declared ? list : ts.isVariableStatement(list.parent) ? list.parent.parent : list.parent;
      const constant = declared && !!(list.flags & ts.NodeFlags.Const) && ts.isIdentifier(node.name);
      bind(node.name, scope, { end: node.end, initializer: node.initializer, constant });
    } else if (ts.isParameter(node)) bind(node.name, node.parent, { end: node.end, constant: false });
  }
  const span = (node: ts.Node) => node.end - node.getStart(sf);
  const resolveName = (id: ts.Identifier, seen: Set<Binding>): string => {
    const at = id.getStart(sf);
    const visible = (bindings.get(id.text) ?? []).filter((b) => b.scope.getStart(sf) <= at && at < b.scope.end);
    if (visible.length === 0) return '';
    const innermost = Math.min(...visible.map((b) => span(b.scope)));
    const binding = visible.filter((b) => span(b.scope) === innermost).at(-1)!;
    if (!binding.constant || !binding.initializer || binding.end >= at || seen.has(binding)) return '';
    return literalAlternatives(binding.initializer, new Set(seen).add(binding));
  };
  const literalAlternatives = (node: ts.Node, seen = new Set<Binding>()): string => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      return node.head.text + node.templateSpans.map((s) => literalAlternatives(s.expression, seen) + s.literal.text).join('');
    }
    if (ts.isConditionalExpression(node)) return `${literalAlternatives(node.whenTrue, seen)} ${literalAlternatives(node.whenFalse, seen)}`;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return literalAlternatives(node.left, seen) + literalAlternatives(node.right, seen);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return literalAlternatives(node.expression, seen);
    }
    return ts.isIdentifier(node) ? resolveName(node, seen) : '';
  };
  if (watchdogModule) candidates.push({ class: 'bespoke-watchdog', line: 1 });
  for (const node of nodes) {
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      const name = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : '';
      if (['notifyAttention', 'notifyAttentionOnce', 'escalateAlarm'].includes(name)) add('owner-only-alarm', node);
      if (ts.isPropertyAccessExpression(expression) &&
          /^(?:console|logger|LOG|log)$/.test(expression.expression.getText(sf)) &&
          /^(?:warn|error|log|info)$/.test(name)) {
        const fallbackWording = /fall(?:ing|s)?[ -]?back|fail(?:ing|s)?[ -]?open|fail(?:ed|ing)? open|degrad(?:ed|ing) to/i;
        const args = node.arguments.map((arg) => arg.getText(sf)).join(' ');
        const literals = () => node.arguments.map((arg) => literalAlternatives(arg)).join(' ');
        if (fallbackWording.test(args) || fallbackWording.test(literals())) add('log-only-fallback', node);
        else exclude(lineOf(node), 'log call has no fallback wording in its complete arguments');
      }
      if (name === 'managedSetInterval') {
        const first = node.arguments[0];
        if (watchdogModule) exclude(lineOf(node), 'interval represented by the watchdog module site');
        else if (first && ts.isStringLiteralLike(first) && /watchdog/i.test(first.text)) add('bespoke-watchdog', node);
        else exclude(lineOf(node), 'interval first argument is not a literal watchdog name');
      }
    }
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      if (/^(?:alarm|alarming|alert|alerting|degraded|unhealthy|breached)$/.test(name)) {
        if (!healthPath) exclude(lineOf(node), 'health field outside a health, watchdog, alarm or monitor path');
        else {
          // The inventory excludes empty/string-only and type-shaped values. Inspect the
          // initializer itself, rather than assuming every health token is a type/reference.
          const value = masked.slice(node.initializer.getStart(sf), node.initializer.end).trim();
          if (!value || /^(?:boolean|string|number|null|undefined|unknown|true\s*\|\s*false|[A-Z]\w*(?:\[\])?)\s*$/.test(value)) {
            exclude(lineOf(node), 'health initializer is string-only or type-shaped');
          } else add('health-flag-no-condition', node);
        }
      }
      if (name === 'waiver') {
        if (signalRegistry && ts.isObjectLiteralExpression(node.initializer)) add('signal-waiver', node);
        else exclude(lineOf(node), 'waiver is not an object in a module calling defineSignal');
      }
    }
    if (ts.isPropertySignature(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) {
      exclude(lineOf(node), ts.isParameter(node) ? 'parameter annotation is not a health write' : ts.isVariableDeclaration(node)
        ? 'variable declaration annotation is not an assigned object field' : 'type member has no runtime initializer');
      // The pinned scanner deliberately has a broad syntactic census: compound health
      // types remain pinned rows, some incorrectly marked migrate. Enumerate those
      // annotations explicitly too; correcting their dispositions needs reviewed seed
      // amendments, while this census must still catch missed runtime fields.
      if (healthPath && ts.isIdentifier(node.name) && /^(?:alarm|alarming|alert|alerting|degraded|unhealthy|breached)$/.test(node.name.text) &&
          (ts.isVariableDeclaration(node) || !node.questionToken) && node.type) {
        // A parameter's annotation may be followed by `) => ...` on the same line;
        // those closing tokens are part of the scanner's broad syntactic row span.
        const value = (masked.slice(node.type.getStart(sf)).match(/^[^,;\n}]+/)?.[0] ?? '').trim();
        if (value && !/^(?:boolean|string|number|null|undefined|unknown|true\s*\|\s*false|[A-Z]\w*(?:\[\])?)\s*$/.test(value)) {
          add('health-flag-no-condition', node);
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && /^(?:alarm|alarming|alert|alerting|degraded|unhealthy|breached)$/.test(node.name.text)) {
      exclude(lineOf(node), 'property reference in an expression is not an assigned health field');
    }
    if (ts.isJsxText(node)) {
      const first = sf.getLineAndCharacterOfPosition(node.pos).line + 1;
      for (let i = 0; i < node.getFullText(sf).split('\n').length; i++) exclude(first + i, 'JSX text is display content, not a health write');
    }
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) exclude(lineOf(node), 'function or method declaration is not a call');
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) exclude(lineOf(node), 'import or export is not a call');
    if (ts.isBindingElement(node)) exclude(lineOf(node), 'destructuring binding is not a health write');
  }
  return { candidates, exclusions };
}

function reconcile(expected: Candidate[], actual: Candidate[], file: string) {
  const counts = (rows: Candidate[]) => {
    const result = new Map<string, number>();
    for (const row of rows) {
      const key = `${file}:${row.line}:${row.class}`;
      result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  };
  const a = counts(expected);
  const b = counts(actual);
  return [...new Set([...a.keys(), ...b.keys()])].flatMap((key) =>
    a.get(key) === b.get(key) ? [] : [`${key}: enumerator=${a.get(key) ?? 0}, scanner=${b.get(key) ?? 0}`]);
}

it('accounts for independently grepped signal tokens as sites or reasoned exclusions', () => {
  const output = execFileSync('git', ['grep', '--recurse-submodules', '-n', '-E', pattern, '--', 'packages', 'apps', 'orchestrator', 'bin', 'scripts', 'libs'],
    { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const files = new Map<string, Set<number>>();
  for (const line of output.split('\n')) {
    const hit = line.match(/^(.+?):(\d+):/);
    if (!hit) continue;
    const lines = files.get(hit[1]) ?? new Set<number>();
    lines.add(Number(hit[2]));
    files.set(hit[1], lines);
  }
  // Watchdog modules are sites by filename even when their bodies contain no grep token.
  const tracked = execFileSync('git', ['ls-files', '--recurse-submodules'], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  for (const file of tracked.split('\n')) {
    if (/watchdog/i.test(file.split('/').at(-1) ?? '') && isScannable(file) && !files.has(file)) files.set(file, new Set());
  }
  expect(files.size).toBeGreaterThan(0);
  const missing: string[] = [];
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  for (const file of presentOnDisk([...files.keys()], root)) {
    const lines = files.get(file)!;
    if (!isScannable(file)) { exclude('test, generated, vendored, retired, declaration, or non-source path'); continue; }
    const raw = readCensusSource(file);
    if (raw === null) { exclude('tracked source disappeared before read'); continue; }
    const masked = stripCommentsAndStrings(raw, file);
    const maskedLines = masked.split('\n');
    const sites = scanSites(raw, file);
    const independent = enumerate(raw, file);
    missing.push(...reconcile(independent.candidates, sites, file));
    for (const line of lines) {
      if (independent.candidates.some((site) => site.line === line)) continue;
      const code = maskedLines[line - 1] ?? '';
      if (!/notifyAttention|escalateAlarm|console\.|logger\.|LOG\.|log\.|managedSetInterval|waiver|alarm|alert|degraded|unhealthy|breached/.test(code)) {
        exclude('signal token is in a comment or string literal'); continue;
      }
      const reasons = independent.exclusions.get(line);
      if (reasons?.length) { for (const reason of reasons) exclude(reason); continue; }
      // Grep intentionally includes references, shorthand fields and comparisons. A live
      // detection-shaped token cannot use this reference exclusion to hide an omitted site.
      if (/\b(?:notifyAttention(?:Once)?|escalateAlarm|managedSetInterval)\s*\(|\b(?:waiver|alarm|alarming|alert|alerting|degraded|unhealthy|breached)\s*:/.test(code)) {
        missing.push(`${file}:${line}: unclassified live signal token`);
      } else exclude('reference or comparison has no call or assigned field');
    }
  }
  expect(Object.keys(exclusions).length).toBeGreaterThan(0);
  expect(missing).toEqual([]);
}, 120_000);

describe('independent census omission controls', () => {
  it.each([
    ['owner-only-alarm', 'packages/x/check.ts', 'notifyAttention({}); notifyAttentionOnce({});'],
    ['log-only-fallback', 'packages/x/check.ts', "console.warn('falling back');"],
    ['log-only-fallback', 'packages/x/check.ts', "const outcome = ok ? 'rejected' : 'fallback to local execution'; console.warn(`sidecar ${outcome}`);"],
    ['health-flag-no-condition', 'packages/x/health.ts', 'function check() { return { degraded: n > 5 }; }'],
    ['bespoke-watchdog', 'packages/x/check.ts', "managedSetInterval('x-watchdog', 60, run);"],
    ['bespoke-watchdog', 'packages/x/empty-watchdog.ts', 'export const x = 1;'],
    ['signal-waiver', 'packages/x/registry.ts', "defineSignal({ id: 'x', waiver: { reason: 'accepted' } });"],
  ])('fails when the scanner omits %s in %s', (cls, file, raw) => {
    const expected = enumerate(raw, file).candidates;
    const actual = scanSites(raw, file);
    expect(reconcile(expected, actual, file)).toEqual([]);
    expect(expected.some((row) => row.class === cls)).toBe(true);
    expect(reconcile(expected, actual.filter((row) => row.class !== cls), file).join()).toContain(cls);
  });

  it('counts repeated same-line calls and requires reasoned health, timer and waiver exclusions', () => {
    const raw = `interface Health { degraded: boolean; }
      const health = { degraded: n > 5 };
      managedSetInterval('heartbeat', 60, run);
      const policy = { waiver: { reason: 'accepted' } };`;
    const enumerated = enumerate(raw, 'packages/x/plain.ts');
    expect(enumerated.candidates).toEqual([]);
    expect([...enumerated.exclusions.values()].flat()).toEqual(expect.arrayContaining([
      'type member has no runtime initializer',
      'health field outside a health, watchdog, alarm or monitor path',
      'interval first argument is not a literal watchdog name',
      'waiver is not an object in a module calling defineSignal',
    ]));
    const calls = enumerate('notifyAttention({}); notifyAttention({});', 'packages/x/check.ts').candidates;
    expect(calls).toHaveLength(2);
    expect(reconcile(calls, calls.slice(1), 'packages/x/check.ts').join()).toContain('enumerator=2, scanner=1');
  });

  it.each([
    ['a const interpolated into a template', "const outcome = ok ? 'rejected' : 'fallback to local execution'; console.warn(`[x] ${outcome}: ${reason}`);", 1],
    ['a nested-conditional const reached through concatenation',
      "const why = a ? '' : b ? `, swap (page-delta fallback)` : ''; console.info(`[p] run ${id}: ` + `load${why})`);", 1],
    ['a const shadowed by a parameter', "const outcome = 'fallback'; function f(outcome: string) { console.warn(`${outcome}`); }", 0],
    ['a const shadowed by a destructured binding',
      "const outcome = 'fallback'; function f() { const { outcome } = load(); console.warn(`${outcome}`); }", 0],
    ['a const read before its declaration', "console.warn(`${later}`); const later = 'fallback';", 0],
    ['a let binding, whose value is not known statically', "let mode = 'fallback'; console.warn(`${mode}`);", 0],
  ])('resolves log wording carried by %s, in agreement with the scanner', (_label, raw, count) => {
    const file = 'packages/x/check.ts';
    const expected = enumerate(raw, file).candidates;
    expect(expected.filter((row) => row.class === 'log-only-fallback')).toHaveLength(count);
    expect(reconcile(expected, scanSites(raw, file), file)).toEqual([]);
  });

  it('reconciles compound parameter spans without treating simple annotations as runtime writes', () => {
    const raw = `interface Deps { raise: (alarm: PumpFailureAlarm) => Promise<void>; }
      function raise(alarm: PumpFailureAlarm, host: string) {}
      function format(alert: Pick<Alert, 'id' | 'reason'>): string { return ''; }
      const alert: SomeAlert = { value: true };`;
    const file = 'packages/x/health.ts';
    expect(reconcile(enumerate(raw, file).candidates, scanSites(raw, file), file)).toEqual([]);
    expect(enumerate(raw, file).candidates).toHaveLength(3);
  });
});
