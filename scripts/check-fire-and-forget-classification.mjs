#!/usr/bin/env node
/**
 * P-008: derive notification sites, then check curated delivery judgments.
 * Reuses the repository enumerator and TypeScript syntax tree; no runtime store.
 * --list --json is the reproducible seed, including source digests and gaps.
 * Scope: tracked JS/TS product source, including initialized submodules. Tests,
 * declarations, generated bundles and documentation are explicit exclusions.
 * This is conservative syntax/call-graph evidence, never delivery/restart proof.
 */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { coverageOf, listTrackedFiles } from './lib/tracked-files.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const ts = require('typescript');
const digest = (s) => createHash('sha256').update(s).digest('hex');
const notificationName = (s) => /^(?:(?:notify|send|escalate)(?:$|[A-Z_])|(?:create|publish|push)Notification|(?:raise|create|emit)Escalation)/.test(s);
// Immutable genesis population: the records may shrink; new sites declare at source.
export const BASELINE_SEED_SHA256 = '3054ec6d5b42d3624d91f76a0553cc7005a69cda5d539bcdbe65c411cfdd3e00';
const transparent = (n) => ts.isParenthesizedExpression(n) || ts.isAsExpression(n)
  || ts.isNonNullExpression(n) || ts.isTypeAssertionExpression(n) || ts.isSatisfiesExpression(n);

export function inScope(path) {
  return /\.[cm]?[jt]sx?$/.test(path)
    && !/\.(?:d|test|spec|stories)\.[cm]?[jt]sx?$/.test(path)
    && !/(?:^|\/)(?:node_modules|\.git|\.papercusp|dist[^/]*|build|coverage|vendor|fixtures|__fixtures__|__tests__|test|tests|vitest-shims|e2e|docs|env-sidecars|storybook-static|\.astro|\.next|\.output|\.svelte-kit|out|target)(?:\/|$)/.test(path)
    && !path.startsWith('apps/operator-docs/');
}

function tokens(node, sourceFile) {
  // Reuse parser-resolved tokens. A standalone scan() does not resume template
  // tails or recognize regex literals in their expression context: it can hash
  // comments as template content and erase meaningful whitespace inside regexes.
  const out = [];
  function visit(token) {
    if (token.kind === ts.SyntaxKind.EndOfFileToken || token.kind === ts.SyntaxKind.JSDocComment) return;
    if (token.kind >= ts.SyntaxKind.FirstToken && token.kind <= ts.SyntaxKind.LastToken) {
      out.push(token.getText(sourceFile));
      return;
    }
    for (const child of token.getChildren(sourceFile)) visit(child);
  }
  visit(node);
  return out.join(' ');
}

/** Await/return and Promise combinators retain custody; catch alone does not. */
function discarded(node) {
  let n = node;
  while (n.parent) {
    const p = n.parent;
    if (ts.isAwaitExpression(p) || ts.isReturnStatement(p)) return false;
    if (ts.isArrowFunction(p) && p.body === n) return false;
    if (ts.isVoidExpression(p)) return true;
    if (transparent(p) || ts.isArrayLiteralExpression(p) || ts.isConditionalExpression(p)) { n = p; continue; }
    if (ts.isPropertyAccessExpression(p) && p.expression === n && /^(then|catch|finally)$/.test(p.name.text)) { n = p; continue; }
    if (ts.isCallExpression(p)) {
      if (p.expression === n || /^Promise\.(all|allSettled|race|any)$/.test(p.expression.getText())) { n = p; continue; }
    }
    return true;
  }
  return true;
}

/**
 * Small lexical graph rather than a repository-wide typechecking Program. Imports,
 * re-exports, assignments, destructuring, callback arguments and wrapper bodies
 * share the same fixed-point propagation. Shadowed bindings stay lexical.
 */
export function censusSources(sources) {
  const files = new Map(Object.entries(sources).filter(([p]) => inScope(p)).sort(([a], [b]) => a.localeCompare(b)));
  const symbols = new Map();
  const modules = new Map();
  const calls = [];
  const gaps = [];
  const manifests = new Map();
  const configs = new Map();
  for (const [path, source] of Object.entries(sources)) if (/(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(path)) {
    const parsed = ts.parseConfigFileTextToJson(path, source);
    if (parsed.error) { gaps.push({ path, kind: 'invalid-resolution-manifest' }); continue; }
    if (path.endsWith('package.json') && parsed.config.name) manifests.set(parsed.config.name, { dir: posix.dirname(path), data: parsed.config });
    if (path.endsWith('tsconfig.json')) configs.set(posix.dirname(path), parsed.config.compilerOptions ?? {});
  }
  let serial = 0;
  function symbol(name, scope) {
    const s = { id: ++serial, name, scope, edges: [], aliases: [], roots: new Set(), params: [] };
    symbols.set(s.id, s);
    return s;
  }
  const named = (scope, name) => ({ scope, name });
  const root = (name) => ({ root: name });
  function modulePath(from, specifier) {
    function candidate(base) {
      base = posix.normalize(base);
      const stem = base.replace(/\.[cm]?jsx?$/, '');
      return [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].flatMap(e => [stem + e, posix.join(base, 'index' + e)])].find(p => files.has(p)) ?? null;
    }
    if (specifier.startsWith('.')) return candidate(posix.join(posix.dirname(from), specifier));
    // Reuse source-owned paths/exports rather than a parallel hand-maintained map.
    const owner = [...configs].filter(([dir]) => dir === '.' || from.startsWith(dir + '/')).sort(([a], [b]) => b.length - a.length)[0];
    if (owner) for (const [pattern, paths] of Object.entries(owner[1].paths ?? {})) {
      const [prefix, suffix = ''] = pattern.split('*');
      if (!(pattern.includes('*') ? specifier.startsWith(prefix) && specifier.endsWith(suffix) : specifier === pattern)) continue;
      const part = specifier.slice(prefix.length, suffix.length ? -suffix.length : undefined);
      for (const p of paths) { const hit = candidate(posix.join(owner[0], owner[1].baseUrl ?? '.', p.replace('*', part))); if (hit) return hit; }
    }
    const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
    const pkg = manifests.get(name);
    if (!pkg) return null;
    const sub = specifier.slice(name.length).replace(/^\//, '');
    const key = sub ? './' + sub : '.';
    let entry = typeof pkg.data.exports === 'string' || !pkg.data.exports?.['.'] ? pkg.data.exports : pkg.data.exports[key];
    if (sub && pkg.data.exports && typeof pkg.data.exports === 'object') {
      entry = pkg.data.exports[key];
      if (!entry) for (const [pattern, value] of Object.entries(pkg.data.exports)) if (pattern.includes('*') && key.startsWith(pattern.split('*')[0]) && key.endsWith(pattern.split('*')[1])) {
        const middle = key.slice(pattern.split('*')[0].length, pattern.split('*')[1].length ? -pattern.split('*')[1].length : undefined);
        entry = JSON.parse(JSON.stringify(value).replaceAll('*', middle));
      }
    }
    const strings = v => typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : [];
    for (const p of [...strings(entry), ...(sub ? [sub, 'src/' + sub, 'lib/' + sub] : [pkg.data.source, pkg.data.module, pkg.data.main, 'src/index', 'lib/index', 'index'])].filter(Boolean)) {
      for (const variant of [p, p.replace(/^\.\/dist\//, './src/').replace(/\.d\.[cm]?ts$/, '.ts')]) {
        const hit = candidate(posix.join(pkg.dir, variant)); if (hit) return hit;
      }
    }
    return null;
  }
  let parsed = 0;
  for (const [path, source] of files) {
    if (process.env.NOTIFY_CENSUS_PROGRESS && parsed++ % 1000 === 0) console.error(`NOTIFY_CENSUS_PROGRESS parsed=${parsed - 1}/${files.size}`);
    const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, /[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lines = source.split('\n');
    for (const d of sf.parseDiagnostics) gaps.push({ path, kind: 'parse', offset: d.start, message: ts.flattenDiagnosticMessageText(d.messageText, ' ') });
    const top = { parent: null, names: new Map(), owner: null, label: '<module>' };
    const exports = new Map();
    const stars = [];
    modules.set(path, { exports, stars });
    const functionIds = new WeakMap();
    const objectIds = new WeakMap();
    const bind = (scope, name) => {
      if (!scope.names.has(name)) scope.names.set(name, symbol(name, scope));
      return scope.names.get(name);
    };
    const imported = (specifier, name) => ({ module: modulePath(path, specifier), name, external: specifier });
    function ref(n, scope) {
      if (!n) return null;
      if (transparent(n) || ts.isAwaitExpression(n)) return ref(n.expression, scope);
      if (ts.isIdentifier(n)) return named(scope, n.text);
      if (ts.isStringLiteralLike(n)) return { literal: n.text };
      if (n.kind === ts.SyntaxKind.ThisKeyword) {
        let s = scope; while (s && !s.classSymbol) s = s.parent;
        return s?.classSymbol ? { id: s.classSymbol.id } : null;
      }
      if (ts.isObjectLiteralExpression(n)) return objectIds.has(n) ? { id: objectIds.get(n).id } : null;
      if (ts.isFunctionLike(n)) return functionIds.get(n)?.id ? { id: functionIds.get(n).id } : null;
      if (ts.isPropertyAccessExpression(n)) return { base: ref(n.expression, scope), member: n.name.text };
      if (ts.isElementAccessExpression(n) && n.argumentExpression && ts.isStringLiteralLike(n.argumentExpression)) return { base: ref(n.expression, scope), member: n.argumentExpression.text };
      if (ts.isElementAccessExpression(n) && n.argumentExpression) return { base: ref(n.expression, scope), memberRef: ref(n.argumentExpression, scope) };
      if (ts.isNewExpression(n)) return ref(n.expression, scope);
      if (ts.isCallExpression(n)) {
        if ((n.expression.kind === ts.SyntaxKind.ImportKeyword || n.expression.getText(sf) === 'require') && ts.isStringLiteralLike(n.arguments[0])) return imported(n.arguments[0].text, '*');
        return ref(n.expression, scope);
      }
      return null;
    }
    function binding(n, value, scope) {
      if (ts.isIdentifier(n)) { const s = bind(scope, n.text); if (value) { s.edges.push(value); s.aliases.push(value); } return s; }
      if (ts.isObjectBindingPattern(n)) for (const e of n.elements) binding(e.name, { base: value, member: e.propertyName?.text ?? e.name.getText(sf) }, scope);
      if (ts.isArrayBindingPattern(n)) for (const e of n.elements) if (ts.isBindingElement(e)) binding(e.name, value, scope);
      return null;
    }
    function visit(n, scope) {
      if (ts.isClassDeclaration(n) || ts.isClassExpression(n)) {
        const s = n.name ? bind(scope, n.name.text) : symbol('<class>', scope);
        s.members = new Map();
        const child = { parent: scope, names: new Map(), owner: scope.owner, label: `${scope.label}/${n.name?.text ?? '<class>'}`, classSymbol: s };
        for (const m of n.members) {
          visit(m, child);
          if (m.name) {
            const member = symbol(m.name.getText(sf), child);
            member.edges.push(ref(ts.isPropertyDeclaration(m) ? m.initializer : m, child));
            member.aliases.push(...member.edges); s.members.set(member.name, member);
          }
        }
        if (n.name && n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.set(n.name.text, { id: s.id });
        return;
      }
      if (ts.isImportDeclaration(n) && ts.isStringLiteralLike(n.moduleSpecifier) && !n.importClause?.isTypeOnly) {
        const c = n.importClause;
        if (c?.name) binding(c.name, imported(n.moduleSpecifier.text, 'default'), scope);
        if (c?.namedBindings && ts.isNamespaceImport(c.namedBindings)) binding(c.namedBindings.name, imported(n.moduleSpecifier.text, '*'), scope);
        if (c?.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) if (!e.isTypeOnly) binding(e.name, imported(n.moduleSpecifier.text, e.propertyName?.text ?? e.name.text), scope);
      }
      if (ts.isExportDeclaration(n) && !n.isTypeOnly) {
        const spec = n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
        if (n.exportClause && ts.isNamedExports(n.exportClause)) for (const e of n.exportClause.elements) exports.set(e.name.text, spec ? imported(spec, e.propertyName?.text ?? e.name.text) : named(scope, e.propertyName?.text ?? e.name.text));
        else if (spec) stars.push(imported(spec, '*'));
      }
      if (ts.isFunctionLike(n) && n.body) {
        const localName = n.name?.getText(sf) ?? (ts.isVariableDeclaration(n.parent) ? n.parent.name.getText(sf) : ts.isPropertyAssignment(n.parent) ? n.parent.name.getText(sf) : '<callback>');
        const s = symbol(localName, scope);
        functionIds.set(n, s);
        if (n.name && ts.isFunctionDeclaration(n)) {
          const b = bind(scope, localName); b.edges.push({ id: s.id }); b.aliases.push({ id: s.id });
        }
        const child = { parent: scope, names: new Map(), owner: s, label: `${scope.label}/${localName}` };
        s.params = n.parameters.map(p => binding(p.name, null, child));
        s.calls = [];
        s.hasRest = n.parameters.some(p => p.dotDotDotToken);
        if (n.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.set(n.modifiers.some(m => m.kind === ts.SyntaxKind.DefaultKeyword) ? 'default' : localName, { id: s.id });
        for (const p of n.parameters) if (p.initializer) visit(p.initializer, child);
        s.defaults = n.parameters.map(p => ({ present: !!p.initializer, ref: ref(p.initializer, child) }));
        visit(n.body, child);
        return;
      }
      if (ts.isBlock(n) || ts.isCatchClause(n)) {
        const child = { parent: scope, names: new Map(), owner: scope.owner, label: scope.label };
        if (ts.isCatchClause(n) && n.variableDeclaration) binding(n.variableDeclaration.name, null, child);
        ts.forEachChild(n, c => visit(c, child));
        return;
      }
      // Visit children first so arrow/function-valued aliases have an identity.
      ts.forEachChild(n, c => visit(c, scope));
      if (ts.isObjectLiteralExpression(n)) {
        const s = symbol('<object>', scope); s.members = new Map(); objectIds.set(n, s);
        for (const p of n.properties) {
          if (ts.isSpreadAssignment(p)) { s.aliases.push(ref(p.expression, scope)); continue; }
          const member = symbol(p.name?.getText(sf) ?? '<property>', scope);
          member.edges.push(ref(ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : p, scope));
          member.aliases.push(...member.edges); s.members.set(member.name, member);
        }
      }
      if (ts.isVariableDeclaration(n)) {
        const s = binding(n.name, ref(n.initializer, scope), scope);
        if (s && n.parent.parent.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) exports.set(n.name.getText(sf), { id: s.id });
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
        let targetScope = scope; while (targetScope.parent && !targetScope.names.has(n.left.text)) targetScope = targetScope.parent;
        binding(n.left, ref(n.right, scope), targetScope);
      }
      if (ts.isExportAssignment(n)) exports.set('default', ref(n.expression, scope));
      if (ts.isCallExpression(n)) {
        const callee = ref(n.expression, scope);
        const args = n.arguments.map(a => ref(a, scope));
        const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
        const annotations = lines.slice(Math.max(0, line - 4), line).join('\n').matchAll(/notify-classification:\s*(\{[^\n]*\})/g);
        const declarations = [];
        for (const annotation of annotations) {
          try { declarations.push(JSON.parse(annotation[1])); }
          catch { gaps.push({ path, kind: 'invalid-classification-json', offset: n.getStart(sf) }); }
        }
        const call = { path, line, owner: scope.owner, context: scope.label, callee, args, declarations, discarded: discarded(n), expression: tokens(n, sf) };
        calls.push(call);
        if (scope.owner) { scope.owner.edges.push(callee); scope.owner.calls.push(call); }
      }
    }
    visit(sf, top);
  }
  function targets(r, seen = new Set(), context = null) {
    if (!r || seen.has(r)) return [];
    seen.add(r);
    if (r.literal !== undefined) return [{ literal: r.literal }];
    if (r.id) {
      if (context?.has(r.id)) {
        const bound = context.get(r.id);
        return targets(bound.ref, seen, bound.context);
      }
      const s = symbols.get(r.id);
      if (!s || seen.has(`id:${r.id}`)) return [];
      seen.add(`id:${r.id}`);
      return [context ? { ...s, boundContext: context } : s, ...s.aliases.flatMap(a => targets(a, seen, context))];
    }
    if (r.root) return [{ roots: new Set([r.root]) }];
    if (r.module !== undefined) {
      const key = `module:${r.module}:${r.name}`;
      if (seen.has(key)) return [];
      seen.add(key);
      const m = modules.get(r.module);
      if (r.name === '*') return [{ module: m }];
      return [...targets(m?.exports.get(r.name), seen, context), ...(m?.stars ?? []).flatMap(s => targets({ ...s, name: r.name }, seen, context)), ...(notificationName(r.name) ? targets(root(r.name), seen) : [])];
    }
    if (r.memberRef !== undefined) {
      const keys = targets(r.memberRef, new Set(seen), context).map(t => t.literal).filter(k => k !== undefined);
      // Unknown computed dispatch is included conservatively, never silently clean.
      return keys.length ? keys.flatMap(member => targets({ base: r.base, member }, new Set(seen), context)) : [{ roots: new Set(['<unresolved-computed-dispatch>']) }];
    }
    if (r.member) {
      const bases = targets(r.base, seen, context);
      if (/^(call|apply|bind)$/.test(r.member)) return bases;
      return [...bases.flatMap(b => b.module ? [...targets(b.module.exports.get(r.member), new Set(seen), context), ...b.module.stars.flatMap(s => targets({ ...s, name: r.member }, new Set(seen), context))] : b.members?.has(r.member) ? targets({ id: b.members.get(r.member).id }, new Set(seen), b.boundContext ?? context) : []), ...(notificationName(r.member) ? targets(root(r.member), seen) : [])];
    }
    let scope = r.scope;
    while (scope && !scope.names.has(r.name)) scope = scope.parent;
    return [...(scope ? targets({ id: scope.names.get(r.name).id }, seen, context) : []), ...(notificationName(r.name) ? targets(root(r.name), seen) : [])];
  }
  // Parameter injection also reveals wrappers whose names contain no notify token.
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS graph symbols=${symbols.size} calls=${calls.length}`);
  for (const c of calls) for (const target of targets(c.callee)) c.args.forEach((a, i) => { if (target.params?.[i]) { target.params[i].edges.push(a); target.params[i].aliases.push(a); } });
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS injected at=${Date.now()}`);
  const reverse = new Map();
  const forward = new Map();
  for (const s of symbols.values()) for (const e of s.edges) for (const t of targets(e)) {
    if (t.id) {
      if (!reverse.has(t.id)) reverse.set(t.id, new Set()); reverse.get(t.id).add(s.id);
      if (!forward.has(s.id)) forward.set(s.id, new Set()); forward.get(s.id).add(t.id);
    }
    else for (const r of t.roots ?? []) s.roots.add(r);
  }
  const queue = [...symbols.values()].filter(s => s.roots.size).map(s => s.id);
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS linked at=${Date.now()} rooted=${queue.length}`);
  const queued = new Set(queue);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]; queued.delete(id);
    for (const receiver of reverse.get(id) ?? []) {
      const s = symbols.get(receiver); let changed = false;
      for (const r of symbols.get(id).roots) if (!s.roots.has(r)) { s.roots.add(r); changed = true; }
      if (changed && !queued.has(receiver)) { queued.add(receiver); queue.push(receiver); }
    }
  }
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS propagated at=${Date.now()}`);
  for (const c of calls) { c.targets = targets(c.callee); c.argumentTargets = c.args.flatMap(a => targets(a)); }
  if (process.env.NOTIFY_CENSUS_PROGRESS) console.error(`NOTIFY_CENSUS_PROGRESS resolved at=${Date.now()}`);
  const detached = new Set();
  const detachedQueue = [];
  const mark = (id) => { if (id && !detached.has(id)) { detached.add(id); detachedQueue.push(id); } };
  for (const c of calls) {
    if (c.discarded) for (const t of [...c.targets, ...c.argumentTargets]) mark(t.id);
    if (c.owner) for (const t of [...c.targets, ...c.argumentTargets]) if (t.id) {
      if (!forward.has(c.owner.id)) forward.set(c.owner.id, new Set()); forward.get(c.owner.id).add(t.id);
    }
  }
  for (let i = 0; i < detachedQueue.length; i++) for (const id of forward.get(detachedQueue[i]) ?? []) mark(id);

  // Keep the global graph for discovery and conservative fallback, but do not
  // reuse its union of every caller's callback arguments as a call's own roots.
  // Bind arguments at each invocation, including the lexical context of forwarded
  // closures. Unsupported signatures, recursion and exhausted work budgets retain
  // the original roots instead of silently certifying a path as notification-free.
  const globalRoots = c => [...new Set(targets(c.callee).flatMap(t => [...t.roots ?? []]))];
  function callRoots(c, context = new Map(), visiting = new Set(), budget = { remaining: 256 }) {
    if (--budget.remaining < 0 || visiting.size >= 24 || /^(call|apply|bind)$/.test(c.callee?.member ?? '')) return globalRoots(c);
    const roots = new Set();
    for (const t of targets(c.callee, new Set(), context)) {
      if (!t.id) { for (const r of t.roots ?? []) roots.add(r); continue; }
      if (!t.calls) {
        // Alias targets are also returned above. Their globally propagated roots
        // would reintroduce the caller union we are deliberately substituting.
        if (!t.aliases.length) for (const r of t.roots) roots.add(r);
        continue;
      }
      if (visiting.has(t.id) || t.hasRest || t.params.some(p => !p)) {
        for (const r of t.roots) roots.add(r);
        continue;
      }
      const bound = new Map(t.boundContext ?? context);
      let unsupported = false;
      t.params.forEach((p, i) => {
        const value = c.args[i];
        const fallback = t.defaults[i];
        if (value) bound.set(p.id, { ref: value, context });
        else if (fallback?.present) {
          if (!fallback.ref) unsupported = true;
          else bound.set(p.id, { ref: fallback.ref, context: bound });
        } else bound.set(p.id, { ref: null, context });
      });
      if (unsupported) { for (const r of t.roots) roots.add(r); continue; }
      const nested = new Set(visiting); nested.add(t.id);
      for (const call of t.calls) for (const r of callRoots(call, bound, nested, budget)) roots.add(r);
    }
    return [...roots];
  }
  const occurrences = new Map();
  const sites = [];
  let refined = 0;
  for (const c of calls) {
    // This pass refines existing candidates; the global graph remains the
    // discovery authority. Do not recursively revisit the much larger clean
    // population or calls whose custody never becomes detached.
    if (!c.targets.some(t => t.roots?.size) || (!c.discarded && !detached.has(c.owner?.id))) continue;
    if (process.env.NOTIFY_CENSUS_PROGRESS && refined++ % 10000 === 0) console.error(`NOTIFY_CENSUS_PROGRESS refined=${refined - 1} at=${Date.now()}`);
    const roots = callRoots(c).sort();
    if (!roots.length || (!c.discarded && !detached.has(c.owner?.id))) continue;
    const key = `${c.path}#${c.context}:${digest(c.expression).slice(0, 20)}`;
    const ordinal = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, ordinal);
    const id = `${key}:${ordinal}`;
    // Resolve exact IDs after occurrence assignment, so neighboring declarations
    // cannot shadow one another or leak to nested calls. Preserve legacy unscoped
    // declarations only when no exact declaration names this site.
    const declaration = c.declarations.find(d => d?.id === id) ?? c.declarations.find(d => d && !d.id);
    sites.push({ id, path: c.path, line: c.line, context: c.context, expression: c.expression, roots, mode: c.discarded ? 'discarded' : 'detached-wrapper', ...(declaration ? { declaration } : {}) });
  }
  const resolutionFiles = Object.entries(sources).filter(([p]) => /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(p));
  return { schemaVersion: 1, files: [...files, ...resolutionFiles].map(([path, source]) => ({ path, sha256: digest(source) })).sort((a,b) => a.path.localeCompare(b.path)), sites: sites.sort((a, b) => a.id.localeCompare(b.id)), gaps };
}

export function validateClassifications(census, records, seedIds = []) {
  const errors = census.gaps.map(g => `coverage gap: ${g.path}: ${g.message ?? g.kind}`);
  const byId = new Map();
  for (const r of records) {
    if (byId.has(r.id)) errors.push(`duplicate classification: ${r.id}`);
    byId.set(r.id, r);
    if (!['durable', 'safe-to-lose'].includes(r.classification) || !r.reason?.trim() || !r.path?.trim()) errors.push(`incomplete classification: ${r.id}`);
    if (r.classification === 'durable' && !r.durablePath?.trim()) errors.push(`missing durable path: ${r.id}`);
  }
  const active = new Set(census.sites.map(s => s.id));
  if (active.size !== census.sites.length) errors.push('duplicate census site ID');
  for (const s of census.sites) {
    const r = byId.get(s.id);
    if (!r) { errors.push(`unclassified: ${s.id}`); continue; }
    if (r.path !== s.path) errors.push(`path mismatch: ${s.id}`);
    if (r.classification === 'safe-to-lose' && (r.mandatory || /owner|human|escalat|grading|grader|lease.*expir|reap|approval|attention|alarm/i.test(`${s.path} ${s.expression} ${s.roots.join(' ')}`))) errors.push(`mandatory notice cannot be safe-to-lose: ${s.id}`);
  }
  for (const id of byId.keys()) if (!active.has(id)) errors.push(`stale classification (remove it): ${id}`);
  for (const id of seedIds) if (!byId.has(id) && active.has(id)) errors.push(`seed classification removed while site remains: ${id}`);
  return errors;
}

export function validateSeed(registry, expectedHash = BASELINE_SEED_SHA256) {
  const ids = registry.seedIds;
  if (!Array.isArray(ids) || new Set(ids).size !== ids.length || digest(JSON.stringify([...ids].sort())) !== expectedHash) return ['baseline seed changed; preserve the --list genesis population'];
  const seed = new Set(ids);
  return registry.records.filter(r => !seed.has(r.id)).map(r => `baseline grew: ${r.id}; classify the new site at source instead`);
}

export function inlineClassifications(census) {
  return census.sites.filter(s => s.declaration).map(s => ({ ...s.declaration, id: s.id, path: s.path }));
}

/**
 * A conservative policy seed, NOT a claim that delivery already is durable.
 * P-009 must verify the terminal consequence; wrapper records share that path,
 * never require one additional workflow per wrapper invocation. Lossy exemptions
 * need a specific reviewed reason and must still pass the mandatory-notice gate.
 */
export function seedClassifications(census) {
  if (census.gaps.length || !census.files.length || census.sourceDigest !== digest(JSON.stringify(census.files))) throw new Error('Refusing to seed an incomplete or unpinned census');
  const seedIds = census.sites.map(s => s.id).sort();
  if (new Set(seedIds).size !== seedIds.length) throw new Error('Refusing duplicate census site IDs');
  return {
    schemaVersion: 1,
    policy: 'Durable is a requirement. Delivery is UNVERIFIED until P-009 proves the terminal path; wrappers share that path, not separate workflows. No safe-to-lose exemption is inferred from a name.',
    seedSourceDigest: census.sourceDigest,
    seedCensusDigest: digest(JSON.stringify(census)),
    seedFiles: census.files,
    seedCoverage: census.coverage,
    seedIds,
    records: census.sites.map(s => ({
      id: s.id, path: s.path, classification: 'durable',
      reason: `No safe-to-lose proof recorded. This call reaches ${s.roots.slice(0, 6).join(', ')}; retain its terminal delivery obligation, including through aliases/wrappers.`,
      durablePath: 'UNVERIFIED requirement: plan:dbos-durability-right-sizing-2026-10-21#P-009',
      deliveryState: 'unverified',
    })),
  };
}

export function scanRepository(cwd = ROOT) {
  const tracked = listTrackedFiles(cwd);
  const coverage = coverageOf(tracked.files, cwd);
  const sources = {};
  const unreadable = [];
  for (const path of tracked.files.filter(p => inScope(p) || /(?:^|\/)(?:package|tsconfig[^/]*)\.json$/.test(p) && !/(?:^|\/)(?:node_modules|env-sidecars|dist[^/]*|storybook-static|\.papercusp)(?:\/|$)/.test(p))) {
    try { sources[path] = readFileSync(resolve(cwd, path), 'utf8'); }
    catch (e) { unreadable.push({ path, kind: 'unreadable', message: e.message }); }
  }
  const census = censusSources(sources);
  census.gaps.push(...unreadable, ...coverage.unscannedPresent.map(path => ({ path, kind: 'unscanned-present' })));
  if (!census.files.length) census.gaps.push({ path: '.', kind: 'empty-source-population' });
  return { ...census, coverage, excluded: tracked.files.filter(p => /\.[cm]?[jt]sx?$/.test(p) && !inScope(p)), sourceDigest: digest(JSON.stringify(census.files)) };
}

function main() {
  const seedFrom = process.argv.indexOf('--seed-from');
  if (seedFrom !== -1) {
    const seed = seedClassifications(JSON.parse(readFileSync(process.argv[seedFrom + 1], 'utf8')));
    console.log(JSON.stringify(seed, null, 2));
    console.error(`NOTIFY_BASELINE_SEED_SHA256=${digest(JSON.stringify(seed.seedIds))}`);
    return;
  }
  const census = scanRepository();
  if (process.argv.includes('--list')) {
    console.log(process.argv.includes('--json') ? JSON.stringify(census, null, 2) : census.sites.map(s => `${s.id}\t${s.path}:${s.line}\t${s.roots.join(',')}`).join('\n'));
    if (census.gaps.length) process.exitCode = 2;
    return;
  }
  const registry = JSON.parse(readFileSync(new URL('./fire-and-forget-classification.json', import.meta.url), 'utf8'));
  const errors = [...validateSeed(registry), ...validateClassifications(census, [...registry.records, ...inlineClassifications(census)], registry.seedIds)];
  console.log(JSON.stringify({ scope: 'classification guard; not a durable-delivery verdict', sites: census.sites.length, files: census.files.length, sourceDigest: census.sourceDigest, coverage: census.coverage, unverifiedDurable: registry.records.filter(r => r.classification === 'durable' && r.deliveryState !== 'verified').length, errors }));
  process.exitCode = errors.length ? 1 : 0;
}
// Bundling changes import.meta.url to the host entrypoint. URL equality alone
// would then run this CLI while the host imports its reusable census functions.
if (process.argv[1] && basename(process.argv[1]) === 'check-fire-and-forget-classification.mjs'
  && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) main();
