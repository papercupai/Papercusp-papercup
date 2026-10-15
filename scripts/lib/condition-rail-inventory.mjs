/**
 * condition-rail-inventory.mjs — the MEASURING inventory of failure/degradation signals that
 * bypass the condition rail. Plan `degradation-signals-on-condition-rail-2026-10-11`, P-001
 * (BAR R-4), hardened by P-017 (R-4, R-5); the P-006 lint (BAR R-6) is built on this scanner.
 *
 * ── WHAT "THE RAIL" IS ───────────────────────────────────────────────────────────────────────
 * A signal is ON the rail when it raises a durable, keyed condition that the condition bridge
 * turns into an owned work item and later resolves: `broadcastSevereEvent({ conditionKey })` /
 * `broadcastSevereEventResolved`, or the generic `observeFallback` primitive (P-002) whose
 * watchdog (P-003) does that for it. Everything else that notices a failure — a desktop
 * notification, a log line, a boolean on a health payload, a private watchdog loop — is seen by
 * a human only if one happens to be looking. That gap is what let the 2026-10-11 gate reuse
 * collapse (0 of ~7,689 files reused) go unalarmed.
 *
 * ── THE FIVE CLASSES (R-4) ───────────────────────────────────────────────────────────────────
 *   owner-only-alarm          notifyAttention / notifyAttentionOnce / escalateAlarm call with no
 *                             rail call in its own function. Neither API took a conditionKey
 *                             before P-007, so such a call can only page the owner.
 *   log-only-fallback         a log call whose message says the code is falling back / failing
 *                             open / degrading, with no rail call in its own function.
 *   health-flag-no-condition  an alarm-shaped health field (alarm, alert, degraded, unhealthy,
 *                             breached, …) set to a VALUE in a health/watchdog/alarm/monitor file,
 *                             with no rail call in its own function.
 *   bespoke-watchdog          a watchdog module that never calls the rail, or a
 *                             `managedSetInterval('…watchdog…')` with no rail call in its function.
 *   signal-waiver             a `waiver:` on a signal-actor-registry entry — an accepted-risk
 *                             signal with no acting consumer. Never on the rail by definition.
 *
 * ── HOW IT MEASURES ──────────────────────────────────────────────────────────────────────────
 * SITES are found by token: every token is matched in LIVE CODE only — the source is passed
 * through `stripCommentsAndStrings` (length-preserving), so a pattern quoted in a comment, a doc
 * string or a test fixture literal is not a site. Message wording (class 2) and interval names
 * (class 4) live INSIDE strings by nature, so those are read from the raw text — but only at a
 * call whose anchor is live code.
 *
 * WHETHER A SITE IS ON THE RAIL is decided on the TypeScript AST (P-017, D-006), site by site:
 *   - a RAIL CALL is a call expression whose callee is the identifier or member name
 *     `broadcastSevereEvent`, `broadcastSevereEventResolved` or `observeFallback` (optional
 *     chaining included), or an alarm call (`notifyAttention…` / `escalateAlarm`) whose own
 *     argument object carries a `conditionKey` property (the P-007 shape);
 *   - a site is on the rail when a rail call lies inside the span of the site's INNERMOST
 *     enclosing function (closures nested in that function included); a module-level site — and a
 *     watchdog MODULE, which is a site by its file name — uses the whole file.
 * Only CALL POSITIONS count. A rail function merely referenced (an injected alias, a re-export),
 * a variable named `conditionKey`, or a rail call in a sibling function does not put a site on
 * the rail. Before P-017 a rail token anywhere within 40 lines — or anywhere in the file, for
 * classes 3 and 4 — did.
 *
 * ── IDENTITY ─────────────────────────────────────────────────────────────────────────────────
 * Each site has a stable id `class|file|enclosing|ordinal`: `enclosing` is the nearest NAMED
 * enclosing function (declaration, method, const-bound function, property-bound function) or
 * `<module>`; `ordinal` counts 1-based among the sites sharing class|file|enclosing, in source
 * order, on-rail sites included so that migrating one site does not renumber its siblings. The
 * seed manifest (docs/evidence/condition-rail-inventory-seed-2026-10-11.json) is keyed by it.
 *
 * Bypass rows are dispositioned by `class|file` (see condition-rail-dispositions.mjs): a row's
 * disposition is the most specific entry among the exact row ID, `class|file|symbol`,
 * and `class|file`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { stripCommentsAndStrings } from './strip-comments-and-strings.mjs';
import { listFilesIncludingUntracked } from './tracked-files.mjs';
import { DISPOSITIONS } from './condition-rail-dispositions.mjs';

export const CLASSES = Object.freeze([
  'owner-only-alarm',
  'log-only-fallback',
  'health-flag-no-condition',
  'bespoke-watchdog',
  'signal-waiver',
]);

/** Callee names whose CALL puts the enclosing function on the condition rail. */
export const RAIL_FUNCTIONS = Object.freeze(['broadcastSevereEvent', 'broadcastSevereEventResolved', 'observeFallback']);

/** Owner-alarm APIs: a call to one is a class-1 site, and on the rail when it passes a conditionKey. */
export const ALARM_FUNCTIONS = Object.freeze(['notifyAttention', 'notifyAttentionOnce', 'escalateAlarm']);

/** The enclosing-symbol value of a site that sits outside every function. */
export const MODULE_SCOPE = '<module>';

/** Directories scanned. Generated bundles, tests and retired code are excluded by isScannable. */
export const SCAN_ROOTS = Object.freeze(['packages/', 'apps/', 'orchestrator/', 'bin/', 'scripts/', 'libs/']);

const CODE_EXT_RE = /\.(?:[cm]?ts|tsx|[cm]?js)$/;

/** Is this tracked path a source file the inventory should read? Pure. */
export function isScannable(file) {
  if (!SCAN_ROOTS.some((r) => file.startsWith(r))) return false;
  if (!CODE_EXT_RE.test(file) || file.endsWith('.d.ts') || file.endsWith('.d.mts')) return false;
  if (/(^|\/)(node_modules|_retired|__fixtures__|fixtures|coverage)\//.test(file)) return false;
  if (/(^|\/)dist[^/]*\//.test(file) || /(^|\/)\.vitest-tmp\//.test(file)) return false;
  if (/(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec|bench)\.[cm]?[jt]sx?$/.test(file)) return false;
  if (/(^|\/)(sidecar|target|build|out|public|vendor|storybook-static)\//.test(file)) return false; // bundles / vendored assets
  // This scanner and its dispositions name every token on purpose.
  if (/scripts\/lib\/condition-rail-(inventory|dispositions)\.mjs$/.test(file)) return false;
  return true;
}

// ── Live-code token patterns (matched against the MASKED text) ────────────────────────────────
// Exported so the census test (condition-rail-census.test.ts) greps the tree for the SAME anchors.
export const ALARM_CALL_RE = /\b(notifyAttention|notifyAttentionOnce|escalateAlarm)\s*\(/g;
export const LOG_CALL_RE = /\b(?:console\.(?:warn|error|log|info)|(?:log|logger|LOG)\.(?:warn|error|info))\s*\(/g;
export const FALLBACK_WORDING_RE = /fall(?:ing|s)?[ -]?back|fail(?:ing|s)?[ -]?open|fail(?:ed|ing)? open|degrad(?:ed|ing) to/i;
export const HEALTH_FIELD_RE = /\b(alarm|alarming|alert|alerting|degraded|unhealthy|breached)\s*:\s*([^,;\n}]+)/g;
export const HEALTH_PATH_RE = /(health|watchdog|alarm|monitor)/i;
export const TYPE_ONLY_VALUE_RE = /^(?:boolean|string|number|null|undefined|unknown|true\s*\|\s*false|[A-Z]\w*(?:\[\])?)\s*$/;
export const INTERVAL_RE = /\bmanagedSetInterval\s*\(/g;
export const DEFINE_SIGNAL_RE = /\bdefineSignal\s*\(/;
export const WAIVER_RE = /\bwaiver\s*:\s*\{/g;
const SIGNAL_ID_RE = /\bid\s*:\s*['"`]([^'"`]+)['"`]/g;

/** Cheap raw pre-filter: a file with none of these tokens cannot hold a site. */
const PREFILTER_RE =
  /notifyAttention|escalateAlarm|fall(?:ing|s)?[ -]?back|fail(?:ing|s|ed)?[ -]?open|degrad|alarm|alert|unhealthy|breached|watchdog|waiver/i;

/** Does this file's BASENAME make it a watchdog module (a class-4 site by name alone)? */
export function isWatchdogModule(file) {
  return /watchdog/i.test(file.slice(file.lastIndexOf('/') + 1));
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1; // 1-based
}

/** Read a complete call span using live-code parentheses; literal parentheses cannot end it. */
function callArgsRaw(raw, openParen, masked) {
  let depth = 0;
  for (let i = openParen; i < raw.length; i++) {
    const ch = masked[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return raw.slice(openParen + 1, i);
    }
  }
  return raw.slice(openParen + 1);
}

function nearestSignalId(raw, masked, index) {
  let id = null;
  SIGNAL_ID_RE.lastIndex = 0;
  // The id literal is a string (blanked in masked); its KEY is live code. Take the last id
  // whose key is live and precedes the waiver, i.e. the entry the waiver belongs to.
  for (let m; (m = SIGNAL_ID_RE.exec(raw)) && m.index < index; ) {
    if (raw[m.index] === masked[m.index]) id = m[1];
  }
  return id;
}

// ── The AST half: function spans and rail-call positions ──────────────────────────────────────

function scriptKindFor(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  if (file.endsWith('.jsx')) return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function propertyNameText(name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return null;
}

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** The name a function-like node is known by, or null for an anonymous callback. */
function functionName(node) {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
    return propertyNameText(node.name);
  }
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) return propertyNameText(parent.name);
  return null;
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text; // `a.b(…)` and `a?.b(…)`
  return null;
}

function hasConditionKeyProperty(arg) {
  return (
    !!arg &&
    ts.isObjectLiteralExpression(arg) &&
    arg.properties.some(
      (p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && propertyNameText(p.name) === 'conditionKey',
    )
  );
}

const RAIL_FUNCTION_SET = new Set(RAIL_FUNCTIONS);
const ALARM_FUNCTION_SET = new Set(ALARM_FUNCTIONS);

/** True when a binding name — an identifier OR a destructuring pattern — introduces `text`. */
function bindsName(name, text) {
  if (ts.isIdentifier(name)) return name.text === text;
  return name.elements.some((element) => !ts.isOmittedExpression(element) && bindsName(element.name, text));
}

/** Read literal alternatives used by a log, including preceding lexical const bindings. */
function logLiteralText(node, sf, seen = new Set()) {
  if (!node || seen.has(node)) return '';
  const nextSeen = new Set(seen).add(node);
  const read = (child) => logLiteralText(child, sf, nextSeen);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((span) => read(span.expression) + span.literal.text).join('');
  }
  if (ts.isConditionalExpression(node)) return `${read(node.whenTrue)} ${read(node.whenFalse)}`;
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return read(node.left) + read(node.right);
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
    return read(node.expression);
  }
  if (!ts.isIdentifier(node)) return '';
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (isFunctionLike(scope) && scope.parameters.some((p) => bindsName(p.name, node.text))) {
      return ''; // A parameter shadows an outer constant, even if its value is unknown.
    }
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    let binding = null;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        // A destructured name shadows too; its value is not a statically-known literal.
        if (bindsName(declaration.name, node.text)) {
          binding = {
            declaration,
            constant: ts.isIdentifier(declaration.name) && !!(statement.declarationList.flags & ts.NodeFlags.Const),
          };
        }
      }
    }
    if (binding) {
      return binding.constant && binding.declaration.end < node.getStart(sf) ? read(binding.declaration.initializer) : '';
    }
  }
  return '';
}

/**
 * Parse one source text into the structure the rail predicate needs: every function-like node's
 * span and name chain, and the start offset of every rail call. Pure.
 */
export function railStructure(raw, file) {
  const sf = ts.createSourceFile(file, raw, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const functions = []; // { start, end, name, parentIndex }
  const railCalls = []; // start offsets
  const logMessages = new Map();
  const visit = (node, parentIndex) => {
    let here = parentIndex;
    if (isFunctionLike(node)) {
      functions.push({ start: node.getStart(sf), end: node.end, name: functionName(node), parentIndex });
      here = functions.length - 1;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (ts.isPropertyAccessExpression(node.expression) &&
          /^(warn|error|log|info)$/.test(name ?? '') &&
          /^(console|log|logger|LOG)$/.test(node.expression.expression.getText(sf))) {
        logMessages.set(node.getStart(sf), node.arguments.map((arg) => logLiteralText(arg, sf)).join(' '));
      }
      if (name && RAIL_FUNCTION_SET.has(name)) railCalls.push(node.getStart(sf));
      else if (name && ALARM_FUNCTION_SET.has(name) && hasConditionKeyProperty(node.arguments[0])) {
        railCalls.push(node.getStart(sf));
      }
    }
    ts.forEachChild(node, (child) => visit(child, here));
  };
  visit(sf, -1);
  return { functions, railCalls, logMessages, length: raw.length };
}

/** Index of the innermost function containing `offset`, or -1 at module scope. */
function innermostFunction(structure, offset) {
  let best = -1;
  for (let i = 0; i < structure.functions.length; i++) {
    const f = structure.functions[i];
    if (f.start <= offset && offset < f.end && (best === -1 || f.start >= structure.functions[best].start)) best = i;
  }
  return best;
}

/** The nearest NAMED function at or above function `index`, else MODULE_SCOPE. */
function enclosingName(structure, index) {
  for (let i = index; i !== -1; i = structure.functions[i].parentIndex) {
    const name = structure.functions[i].name;
    if (name) return name;
  }
  return MODULE_SCOPE;
}

/**
 * Locate one site in the AST: its enclosing symbol and whether a rail call lies in its own
 * function's span (the whole file for a module-level site). Pure.
 */
export function locateSite(structure, offset, { moduleLevel = false } = {}) {
  const fn = moduleLevel ? -1 : innermostFunction(structure, offset);
  const span = fn === -1 ? { start: 0, end: structure.length + 1 } : structure.functions[fn];
  const onRail = structure.railCalls.some((p) => p >= span.start && p < span.end);
  return { enclosing: moduleLevel ? MODULE_SCOPE : enclosingName(structure, fn), onRail };
}

/**
 * Find every candidate SITE in one source text, on the rail or not. Pure: (raw, file) → sites.
 * `file` is the repo-relative path; it selects the parser kind and drives the path-scoped classes
 * (health fields, watchdog modules).
 *
 * @param {string} raw
 * @param {string} file
 * @returns {Array<{ id: string, class: string, file: string, line: number, symbol: string, key: string, enclosing: string, ordinal: number, onRail: boolean }>}
 */
export function scanSites(raw, file) {
  const watchdogModule = isWatchdogModule(file);
  // A watchdog MODULE is a site by its name alone, so the content pre-filter cannot skip it.
  if (!PREFILTER_RE.test(raw) && !watchdogModule) return [];
  const masked = stripCommentsAndStrings(raw, file);
  const starts = lineStarts(masked);
  const found = []; // { class, index, symbol, moduleLevel, railExempt }
  let structure;
  const getStructure = () => (structure ??= railStructure(raw, file));
  const add = (cls, index, symbol, opts = {}) => found.push({ class: cls, index, symbol, ...opts });

  // 1. owner alarms
  ALARM_CALL_RE.lastIndex = 0;
  for (let m; (m = ALARM_CALL_RE.exec(masked)); ) {
    const before = masked.slice(Math.max(0, m.index - 24), m.index);
    if (/\bfunction\s*\*?\s*$/.test(before)) continue; // the declaration, not a call
    add('owner-only-alarm', m.index, m[1]);
  }

  // 2. fallback decisions announced in a log line
  LOG_CALL_RE.lastIndex = 0;
  for (let m; (m = LOG_CALL_RE.exec(masked)); ) {
    const rawArgs = callArgsRaw(raw, m.index + m[0].length - 1, masked);
    const args = FALLBACK_WORDING_RE.test(rawArgs) ? rawArgs : (getStructure().logMessages.get(m.index) ?? rawArgs);
    if (!FALLBACK_WORDING_RE.test(args)) continue;
    add('log-only-fallback', m.index, args.match(FALLBACK_WORDING_RE)[0].toLowerCase().replace(/\s+/g, '-'));
  }

  // 3. health fields carrying alarm flags
  if (HEALTH_PATH_RE.test(file)) {
    HEALTH_FIELD_RE.lastIndex = 0;
    for (let m; (m = HEALTH_FIELD_RE.exec(masked)); ) {
      const prev = masked[m.index - 1];
      if (prev === '.' || prev === '?') continue; // obj.alarm ? a : b  /  a?.alarm
      if (masked.slice(m.index + m[1].length).match(/^\s*\?\s*:/)) continue; // optional type member
      const value = m[2].trim();
      if (!value || TYPE_ONLY_VALUE_RE.test(value)) continue; // interface member / type annotation
      add('health-flag-no-condition', m.index, m[1]);
    }
  }

  // 4. bespoke watchdogs: the module by name, else each named watchdog interval
  if (watchdogModule) {
    add('bespoke-watchdog', 0, file.slice(file.lastIndexOf('/') + 1).replace(CODE_EXT_RE, ''), { moduleLevel: true });
  } else {
    INTERVAL_RE.lastIndex = 0;
    for (let m; (m = INTERVAL_RE.exec(masked)); ) {
      const name = callArgsRaw(raw, m.index + m[0].length - 1, masked).match(/^\s*['"`]([^'"`]*watchdog[^'"`]*)['"`]/i);
      if (name) add('bespoke-watchdog', m.index, name[1]);
    }
  }

  // 5. signal-actor-registry waivers — a waiver is an accepted-risk bypass whatever surrounds it
  if (DEFINE_SIGNAL_RE.test(masked)) {
    WAIVER_RE.lastIndex = 0;
    for (let m; (m = WAIVER_RE.exec(masked)); ) {
      add('signal-waiver', m.index, nearestSignalId(raw, masked, m.index) ?? 'unknown-signal', { railExempt: true });
    }
  }

  if (found.length === 0) return [];
  structure = getStructure();
  found.sort((a, b) => a.index - b.index);
  const ordinals = new Map();
  return found.map((f) => {
    const { enclosing, onRail } = locateSite(structure, f.index, { moduleLevel: !!f.moduleLevel });
    const group = `${f.class}|${file}|${enclosing}`;
    const ordinal = (ordinals.get(group) ?? 0) + 1;
    ordinals.set(group, ordinal);
    return {
      id: `${group}|${ordinal}`,
      class: f.class,
      file,
      line: lineOf(starts, f.index),
      symbol: f.symbol,
      key: `${f.class}|${file}`,
      enclosing,
      ordinal,
      onRail: f.railExempt ? false : onRail,
    };
  });
}

/**
 * Scan ONE source text for the sites that BYPASS the rail. Pure: (raw, file) → rows.
 *
 * @param {string} raw
 * @param {string} file
 * @returns {Array<{ id: string, class: string, file: string, line: number, symbol: string, key: string, enclosing: string, ordinal: number, onRail: boolean }>}
 */
export function scanSource(raw, file) {
  return scanSites(raw, file).filter((s) => !s.onRail);
}

/**
 * Resolve one row's disposition from a dispositions map. Most specific key wins:
 * exact row ID (`class|file|enclosing|ordinal`), then `class|file|symbol`, then
 * `class|file`. Returns null when the site is undispositioned.
 */
export function dispositionFor(row, dispositions) {
  return (row.id ? dispositions[row.id] : null) ??
    dispositions[`${row.key}|${row.symbol}`] ?? dispositions[row.key] ?? null;
}

/** Is a disposition entry well-formed? migrate needs a P-NNN item; not-applicable a reason. */
export function dispositionProblem(d) {
  if (!d || typeof d !== 'object') return 'missing';
  if (d.disposition === 'migrate') return /^P-\d{3,}$/.test(d.item ?? '') ? null : 'migrate without a P-NNN item';
  if (d.disposition === 'not-applicable') {
    return typeof d.reason === 'string' && d.reason.trim().length >= 20 ? null : 'not-applicable without a reason (>=20 chars)';
  }
  return `unknown disposition ${JSON.stringify(d.disposition)}`;
}

/**
 * Inventory a set of repo-relative files under `root`. `readFile` is injectable for tests.
 * Returns every bypass row with its resolved disposition, every site (on the rail or not), and
 * coverage counters.
 */
export function inventory({ root, files, dispositions = {}, readFile }) {
  const read = readFile ?? ((f) => readFileSync(join(root, f), 'utf8'));
  const rows = [];
  const sites = [];
  let scanned = 0;
  let unreadable = 0;
  for (const f of files) {
    if (!isScannable(f)) continue;
    let text;
    try {
      text = read(f);
    } catch {
      unreadable++;
      continue;
    }
    scanned++;
    for (const site of scanSites(text, f)) {
      sites.push(site);
      if (site.onRail) continue;
      const d = dispositionFor(site, dispositions);
      rows.push({ ...site, disposition: d, problem: dispositionProblem(d) });
    }
  }
  const order = (a, b) => a.class.localeCompare(b.class) || a.file.localeCompare(b.file) || a.line - b.line;
  rows.sort(order);
  sites.sort(order);
  const byClass = Object.fromEntries(CLASSES.map((c) => [c, rows.filter((r) => r.class === c).length]));
  const undispositioned = rows.filter((r) => r.problem).length;
  // A disposition key that no longer matches any bypass row is dead weight (fixed or renamed):
  // report it, and --check fails on it (D-006) so a migrated cluster cannot keep its entry.
  const liveKeys = new Set(rows.flatMap((r) => [r.id, r.key, `${r.key}|${r.symbol}`]));
  const staleDispositions = Object.keys(dispositions).filter((k) => !liveKeys.has(k));
  return { rows, sites, scanned, unreadable, byClass, undispositioned, staleDispositions };
}

/** The canonical tree inventory used by the CLI and manifest checks. @param {string} root */
export function inventoryTree(root) {
  const listed = listFilesIncludingUntracked(root);
  const files = Array.isArray(listed) ? listed : listed.files;
  return inventory({ root, files, dispositions: DISPOSITIONS });
}

/**
 * Validate the immutable audit against live sites. In-progress migrate rows must retain their
 * original disposition; completed rows must be on the rail. The final acceptance run passes
 * requireAllMigrated:true. Only a reviewed amendment may remove or re-disposition a seed row.
 * @param {any} manifest
 * @param {any} live
 * @param {{ completedItems?: string[], requireAllMigrated?: boolean }} [options]
 */
export function manifestProblems(manifest, live, options = {}) {
  const { completedItems = [], requireAllMigrated = false } = options;
  const problems = [];
  const ids = new Set();
  const sites = new Map(live.sites.map((site) => [site.id, site]));
  const bypasses = new Map(live.rows.map((row) => [row.id, row]));
  const amendments = new Map();
  for (const amendment of manifest.amendments ?? []) {
    if (!amendment.rowId || !amendment.reason?.trim() || !amendment.author?.trim() ||
        !amendment.reviewerRef?.trim() || amendment.reviewerRef === amendment.author ||
        !amendment.change || !['removed', 'migrate', 'not-applicable'].includes(amendment.change.disposition)) {
      problems.push(`invalid amendment: ${amendment.rowId ?? '<missing row ID>'}`);
      continue;
    }
    if (amendments.has(amendment.rowId)) problems.push(`duplicate amendment: ${amendment.rowId}`);
    amendments.set(amendment.rowId, amendment);
  }
  for (const row of manifest.rows) {
    if (ids.has(row.id)) problems.push(`duplicate seed ID: ${row.id}`);
    ids.add(row.id);
    const amendment = amendments.get(row.id);
    const effective = amendment ? { ...row, ...amendment.change } : row;
    if (effective.disposition === 'removed') continue;
    const problem = dispositionProblem(effective);
    if (problem) problems.push(`${row.id}: ${problem}`);
    if (!['condition', 'observation'].includes(effective.route)) problems.push(`${row.id}: missing route`);
    const site = sites.get(row.id);
    if (!site) { problems.push(`${row.id}: seed site absent without removal amendment`); continue; }
    if (effective.disposition === 'migrate') {
      const mustBeMigrated = requireAllMigrated || completedItems.includes(effective.item);
      if (mustBeMigrated && !site.onRail) problems.push(`${row.id}: completed migration still bypasses rail`);
      if (!site.onRail) {
        const disposition = bypasses.get(row.id)?.disposition;
        if (disposition?.disposition !== 'migrate' || disposition.item !== effective.item) {
          problems.push(`${row.id}: migrate disposition changed without amendment`);
        }
      }
    } else if (!site.onRail && bypasses.get(row.id)?.disposition?.reason?.trim() !== effective.reason?.trim()) {
      problems.push(`${row.id}: not-applicable reason changed without amendment`);
    }
  }
  for (const id of amendments.keys()) if (!ids.has(id)) problems.push(`amendment names unknown seed ID: ${id}`);
  return problems;
}

/** Generate the immutable row-ID -> executable test-case matrix; missing completed rows fail. */
export function migrationCoverageProblems(manifest, cases, completedItems, registeredMechanisms) {
  const problems = [];
  const byRow = new Map();
  for (const testCase of cases) {
    if (typeof testCase.run !== 'function') problems.push(`${testCase.id}: no executable case`);
    for (const id of testCase.rowIds) {
      if (byRow.has(id)) problems.push(`${id}: duplicate coverage`);
      byRow.set(id, testCase);
    }
  }
  const seeds = new Set(manifest.rows.map((row) => row.id));
  for (const id of byRow.keys()) if (!seeds.has(id)) problems.push(`${id}: coverage names unknown row`);
  for (const row of manifest.rows) {
    const amendment = (manifest.amendments ?? []).find((a) => a.rowId === row.id);
    const effective = amendment ? { ...row, ...amendment.change } : row;
    if (effective.disposition === 'removed') continue;
    if (!['condition', 'observation'].includes(effective.route)) problems.push(`${row.id}: missing route`);
    if (effective.disposition !== 'migrate') continue;
    const testCase = byRow.get(row.id);
    if (!testCase) {
      if (completedItems.includes(effective.item)) problems.push(`${row.id}: completed migration has no case`);
      continue;
    }
    if (testCase.item !== effective.item || testCase.route !== effective.route) problems.push(`${row.id}: case route/item mismatch`);
    if (testCase.route === 'observation' && !registeredMechanisms.includes(testCase.mechanism)) {
      problems.push(`${row.id}: unregistered observation mechanism`);
    }
  }
  return problems;
}

/** Final structural acceptance: every immutable migrate row needs rail placement AND a case. */
export function acceptanceProblems(manifest, live, cases, registeredMechanisms) {
  const amended = new Map((manifest.amendments ?? []).map((entry) => [entry.rowId, entry.change]));
  const effectiveRows = manifest.rows.map((row) => ({ ...row, ...amended.get(row.id) }));
  const items = [...new Set(effectiveRows.filter((row) => row.disposition === 'migrate').map((row) => row.item))];
  return [
    ...(live.unreadable > 0 ? [`${live.unreadable} unreadable source file(s)`] : []),
    ...(live.undispositioned > 0 ? [`${live.undispositioned} undispositioned site(s)`] : []),
    ...live.staleDispositions.map((key) => `stale disposition: ${key}`),
    ...manifestProblems(manifest, live, { requireAllMigrated: true }),
    ...migrationCoverageProblems(manifest, cases, items, registeredMechanisms),
  ];
}

/**
 * The lint ratchet admits only existing bypass IDs. Dispositions alone cannot waive new
 * sites: exclusions need a reasoned amendment, and removed baseline IDs cannot return.
 * @param {any} live
 * @param {{ rowIds: string[], amendments?: any[] }} baseline
 * @param {{ rowIds: string[], amendments?: any[] }} committedBaseline
 * @param {any} manifest
 */
export function lintProblems(live, baseline, committedBaseline, manifest) {
  const problems = [];
  const known = new Set(baseline.rowIds);
  const prior = new Set(committedBaseline.rowIds);
  if (known.size !== baseline.rowIds.length) problems.push('duplicate baseline row ID');
  for (const id of known) if (!prior.has(id)) problems.push(`${id}: baseline grew`);
  const exclusions = new Map(manifest.rows.filter((row) => row.disposition === 'not-applicable')
    .map((row) => [row.id, row.reason]));
  const amendments = new Map();
  for (const entry of [...(manifest.amendments ?? []), ...(baseline.amendments ?? [])]) {
    if (!entry.rowId || !entry.author?.trim() || (entry.reason?.trim().length ?? 0) < 20) {
      problems.push(`invalid lint amendment: ${entry.rowId ?? '<missing row ID>'}`);
      continue;
    }
    if (amendments.has(entry.rowId)) problems.push(`duplicate lint amendment: ${entry.rowId}`);
    amendments.set(entry.rowId, entry);
    if (entry.change?.disposition === 'not-applicable') exclusions.set(entry.rowId, entry.change.reason ?? entry.reason);
  }
  for (const row of live.rows) {
    const disposition = row.disposition;
    if (disposition?.disposition === 'not-applicable') {
      if (exclusions.get(row.id)?.trim() !== disposition.reason?.trim()) {
        problems.push(`${row.id}: not-applicable disposition lacks matching amendment-log reason`);
      }
    } else if (!known.has(row.id)) problems.push(`${row.id}: new rail bypass`);
  }
  const liveBypasses = new Set(live.rows.map((row) => row.id));
  for (const id of known) if (!liveBypasses.has(id)) problems.push(`${id}: obsolete baseline entry; remove it`);
  if (live.unreadable > 0) problems.push(`${live.unreadable} unreadable source file(s)`);
  if (live.undispositioned > 0) problems.push(`${live.undispositioned} undispositioned site(s)`);
  for (const key of live.staleDispositions) problems.push(`stale disposition: ${key}`);
  return problems;
}

/** A committed removal is permanent, including across intervening metadata-only commits.
 * @param {{ rowIds: string[] }} initial
 * @param {{ rowIds: string[] }[]} history
 */
export function baselineCeiling(initial, history) {
  let allowed = new Set(initial.rowIds);
  for (const prior of history) {
    const ids = new Set(prior.rowIds);
    allowed = new Set([...allowed].filter((id) => ids.has(id)));
  }
  return { rowIds: [...allowed] };
}
