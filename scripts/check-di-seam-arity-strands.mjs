#!/usr/bin/env node
/**
 * check-di-seam-arity-strands.mjs — flags an optional DI seam whose CALL ARITY is
 * narrower than the production default it replaces (EI-19448665215423873).
 *
 * THE CLASS THIS CATCHES (distinct from the sibling `lint:optional-seam-strands`,
 * which flags an optional seam member whose fallback touches REAL/live state — a
 * different failure mode of the same "optional DI seam" family):
 *
 *   ```ts
 *   governorFor?(model: string): RateLimitGovernor;                          // seam
 *   const g = deps.governorFor ? deps.governorFor(model)                     // called
 *                               : governorForBackend('claude-code', model, undefined, accountId); // default
 *   ```
 *
 * `accountId` is in scope at the call site and is passed to the DEFAULT branch but
 * silently dropped from the SEAM branch. Nothing fails: tsc is blind to it (the seam
 * type only promises `(model) => Governor`, and the call site satisfies that), and
 * every test that injects the seam gets a factory that structurally CANNOT vary by
 * the dropped argument — the property it exists to test (here: per-account state)
 * becomes untestable while the test keeps passing. See the source instance at
 * `packages/operator-core/lib/inference-gateway/gateway.ts` (`governorForAccount`,
 * fixed under EI-19448665215423873 by widening the seam to `(model, accountId)`).
 *
 * HEURISTIC (intentionally cheap, advisory only — a false positive costs a glance,
 * a false negative is no worse than not having this guard at all). A SEAM CALL is a
 * call on a property access `X.seam` / `X?.seam`; a DEFAULT CALL is any call. Three
 * spellings of "call the seam if present, else the default" are recognised
 * (WI-6554700010009519 — the guard used to know only the first, and only with
 * un-awaited branches, so `deps.x?.() ?? dflt(key)` and every `await`ed ternary
 * passed unseen):
 *   - ternary  `cond ? seamCall : defaultCall`, where `cond` tests `X.seam` as
 *              `X.seam`, `X.seam != null` / `!== undefined` (either operand order) or
 *              `typeof X.seam === 'function'`; a negated test (`!X.seam`,
 *              `=== undefined`, `typeof … !== 'function'`) swaps which branch is the seam;
 *   - nullish  `X.seam?.(…) ?? defaultCall`;
 *   - or       `X.seam?.(…) || defaultCall`;
 *   - if-else  `if (cond) <P X.seam(…)> else <P defaultCall>`, both branches ONE statement
 *              of the same kind P: `return …`, a bare expression, or an assignment to the
 *              same target (braces around a lone statement are fine);
 *   - if-return `if (cond) return X.seam(…); return defaultCall;` with no else: the NEXT
 *              sibling statement is the default branch.
 *   The statement forms take the ternary's conditions; a negated condition swaps the
 *   branches (WI-6554700010009741: `if (deps.alarm?.notify) await deps.alarm.notify({ title,
 *   body }); else await notifyAttention(input);` hid urgency and routing at 3 sites).
 * Parentheses, `await`, a non-null `!` and `as` / `satisfies` / `<T>` assertions around
 * either call are looked through. `(X.seam ?? dflt)(…)` is NOT a form: both receive
 * identical arguments by construction, so it cannot narrow. NOT recognised: a branch of
 * more than one statement, and flow that reaches the default by any other path.
 *
 * A finding is an argument the default call passes that the seam call does not, matched
 * by name and never by position (the seam and the default rarely share a parameter order):
 *   - a bare Identifier (`accountId`), by name;
 *   - a property access (`request.body`), by its source text (WI-6554700010009845);
 *   - a property NAME that an object-literal argument of the default sets and no
 *     object-literal argument of the seam sets, reported as `{name}`. Compared only when
 *     BOTH calls pass an object literal and no seam-side literal spreads (`...rest` may
 *     carry any name). WI-6554700010009845: `deps.notify({ title, body })` beside
 *     `notifyAttention({ kind, title, body, importance, data })` dropped urgency and
 *     routing, and the guard reported nothing.
 * Literal and call-expression arguments are ignored on both sides, because those are not
 * what "in scope, dropped" looks like syntactically. Three shapes are deliberately NOT
 * findings (each measured as a false positive on the real tree):
 *   - the dropped identifier IS the seam's receiver, or a property access rooted at it
 *     (`opts.read ? opts.read() : dflt(opts)`, `… : dflt(opts.limit)`): whoever supplied
 *     the member supplied the object, so the seam can close over it;
 *   - the seam call DELEGATES to the default (`sql.begin(run) : run(sql)`,
 *     `tx.savepoint((sp) => run(sp)) : run(tx)`): a transaction wrapper supplies the
 *     dropped handle itself. Detected as the default's callee appearing inside the
 *     seam call's arguments;
 *   - both calls are members of ONE receiver (`pool.peek?.() ?? pool.active(keyOf)`):
 *     the arities are that interface's contract, decided where it is declared, not
 *     narrowed at this call site.
 *
 *   node scripts/check-di-seam-arity-strands.mjs                # advisory: name findings
 *   node scripts/check-di-seam-arity-strands.mjs --json
 *   node scripts/check-di-seam-arity-strands.mjs --fail          # exit 1 when findings exist
 *   node scripts/check-di-seam-arity-strands.mjs --files=a.ts,b.ts
 *
 * Exit codes: 0 no findings (or default/advisory mode) · 1 only with --fail and only
 * when findings exist · 2 nothing was examined (EXIT_NOT_CHECKED — zero candidate files).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { presentOnDisk } from './lib/tracked-files.mjs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { EXIT_NOT_CHECKED } from './lib/not-checked.mjs';
import { runGuardWithIndexFaultGuard, withGitIndexFaultRetry } from './lib/git-index-fault.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// EI-22703095921400106: a torn `.git/index` on the shared staging tree made this call throw
// `fatal: .git/index: index file smaller than expected`, which the affected runner read as a
// LINT VIOLATION rather than "the instrument could not read the repository". Retry the
// known-transient index fault (git-sync repairs it), then surrender as NOT CHECKED — never as a
// finding. Every other git error still propagates untouched.
function git(args) {
  return withGitIndexFaultRetry(() =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }),
  );
}

/** Tracked .ts/.tsx source files, excluding tests/dist/node_modules/generated output. */
function defaultCandidateFiles() {
  // WI-10004176: presentOnDisk drops index entries a peer's plain `rm` left until git-sync commits it.
  return presentOnDisk(git(['ls-files', '--', '*.ts', '*.tsx']).split('\n').filter(Boolean))
    .filter((f) => !/\.(test|spec|integration\.test)\.tsx?$/.test(f))
    .filter((f) => !/(^|\/)(dist|build|node_modules|\.papercusp)\//.test(f))
    .filter((f) => !f.startsWith('papercup-release/') && !f.startsWith('papercup-checkpoint/'));
}

/**
 * Bare-identifier argument names of a call expression; non-identifier args are ignored.
 * `undefined` parses as a plain Identifier in the TS AST (it is a global variable, not a
 * keyword) — filtered out so a literal `undefined` placeholder arg never counts as a
 * "dropped in-scope value" (it isn't in scope; it's a constant).
 */
function identifierArgNames(callExpr) {
  return callExpr.arguments.filter(ts.isIdentifier).map((a) => a.text).filter((name) => name !== 'undefined');
}

/**
 * An identifier, or a property chain rooted at an identifier or `this` (`request.body`,
 * `this.cfg?.limit`), as normalised text (`?.` becomes `.`, whitespace dropped) so `a?.b` and
 * `a.b` match. null for anything else: a chain through a call or an element access
 * (`getOrgPg().sql`) is not an in-scope value (WI-6554700010009845).
 */
function valueText(node, sf) {
  let root = node;
  while (ts.isPropertyAccessExpression(root)) root = root.expression;
  if (!ts.isIdentifier(root) && root.kind !== ts.SyntaxKind.ThisKeyword) return null;
  return node.getText(sf).replace(/\s+/g, '').replace(/\?\./g, '.');
}

/** Property-access arguments of a call, as `valueText` (WI-6554700010009845). */
function propertyAccessArgTexts(callExpr, sf) {
  return callExpr.arguments
    .filter(ts.isPropertyAccessExpression)
    .map((a) => valueText(a, sf))
    .filter(Boolean);
}

/**
 * The object-literal arguments of a call: `values` maps each property NAME they set (shorthand,
 * `k: v`, methods, accessors; string/numeric keys by value; a computed `[k]` key is not comparable
 * and is skipped) to its value's `valueText`, or null when the value is not an identifier or a
 * property chain. `literals` counts the object literals; `spread` is true when one spreads
 * another object, which may carry any name.
 */
function objectLiteralArgs(callExpr, sf) {
  const values = new Map();
  let literals = 0;
  let spread = false;
  for (const arg of callExpr.arguments) {
    const lit = unwrap(arg);
    if (!ts.isObjectLiteralExpression(lit)) continue;
    literals += 1;
    for (const prop of lit.properties) {
      if (ts.isSpreadAssignment(prop)) {
        spread = true;
        continue;
      }
      const name = prop.name;
      if (!name || !(ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name))) continue;
      let value = null;
      if (ts.isShorthandPropertyAssignment(prop)) value = name.text;
      else if (ts.isPropertyAssignment(prop)) value = valueText(unwrap(prop.initializer), sf);
      values.set(name.text, value);
    }
  }
  return { values, literals, spread };
}

/**
 * Look through the wrappers that do not change WHICH call is made: parentheses, `await`,
 * a non-null `x!`, and `as` / `satisfies` / `<T>` type assertions.
 */
function unwrap(node) {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAwaitExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

/** `X.member` / `X?.member` (an optional chain is still a PropertyAccessExpression), else null. */
function propAccess(node) {
  return ts.isPropertyAccessExpression(node) ? node : null;
}

/** Strip an optional-chain `?.` / plain `.` down to the base `X.member` text for comparison. */
function propAccessKey(node) {
  const access = propAccess(node);
  return access ? `${access.expression.getText()}.${access.name.text}` : null;
}

function isNullishLiteral(node) {
  return node.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(node) && node.text === 'undefined');
}

/**
 * Which seam a ternary condition tests, and whether a TRUE condition means the seam is
 * PRESENT (the recognised spellings are listed in the header). null for anything else.
 */
function testedSeam(cond) {
  const c = unwrap(cond);
  const key = propAccessKey(c);
  if (key) return { key, present: true };
  if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = testedSeam(c.operand);
    return inner && { key: inner.key, present: !inner.present };
  }
  if (!ts.isBinaryExpression(c)) return null;
  const op = c.operatorToken.kind;
  const eq = op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsEqualsToken;
  const neq = op === ts.SyntaxKind.ExclamationEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken;
  if (!eq && !neq) return null;
  const left = unwrap(c.left);
  const right = unwrap(c.right);
  for (const [a, b] of [
    [left, right],
    [right, left],
  ]) {
    const tested = propAccessKey(a);
    if (tested && isNullishLiteral(b)) return { key: tested, present: neq };
    if (ts.isTypeOfExpression(a) && ts.isStringLiteral(b)) {
      const typed = propAccessKey(unwrap(a.expression));
      if (typed && b.text === 'function') return { key: typed, present: eq };
      if (typed && b.text === 'undefined') return { key: typed, present: neq };
    }
  }
  return null;
}

/** True when `node`'s subtree mentions `text` as an identifier or a property access. */
function mentions(node, text, sf) {
  if ((ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) && node.getText(sf) === text) return true;
  return ts.forEachChild(node, (child) => (mentions(child, text, sf) ? true : undefined)) === true;
}

/** The one statement a branch holds: itself, or the sole statement of a `{ … }` block. */
function single(stmt) {
  if (stmt && ts.isBlock(stmt)) return stmt.statements.length === 1 ? stmt.statements[0] : null;
  return stmt ?? null;
}

/**
 * What one branch statement does with its call, so two branches can be compared:
 * `return E` · a bare expression statement `E` · an assignment `T = E`. null otherwise.
 */
function payload(stmt, sf) {
  if (!stmt) return null;
  if (ts.isReturnStatement(stmt)) return stmt.expression ? { kind: 'return', expr: stmt.expression } : null;
  if (!ts.isExpressionStatement(stmt)) return null;
  const e = stmt.expression;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return { kind: 'assign', expr: e.right, target: e.left.getText(sf) };
  }
  return { kind: 'expr', expr: e };
}

/**
 * Findings from ONE source file:
 * [{ file, line, form, seam, missing: string[], seamCallText, defaultCallText }]
 */
export function findArityStrandsInSource(sourceText, fileName = 'f.ts') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const findings = [];

  function consider(node, form, seam, seamExpr, defaultExpr) {
    const seamCall = unwrap(seamExpr);
    const defaultCall = unwrap(defaultExpr);
    if (!ts.isCallExpression(seamCall) || !ts.isCallExpression(defaultCall)) return;
    // The seam branch must call the SAME property the condition tested.
    const seamAccess = propAccess(unwrap(seamCall.expression));
    if (!seamAccess || propAccessKey(seamAccess) !== seam) return;
    const receiver = seamAccess.expression.getText(sf);
    const defaultCallee = unwrap(defaultCall.expression);
    // Both members of ONE receiver: the arities are that interface's contract.
    const defaultAccess = propAccess(defaultCallee);
    if (defaultAccess && defaultAccess.expression.getText(sf) === receiver) return;
    // The seam delegates to the default: a transaction wrapper supplies the handle itself.
    const calleeText = defaultCallee.getText(sf);
    if (seamCall.arguments.some((arg) => mentions(arg, calleeText, sf))) return;
    const seamLiterals = objectLiteralArgs(seamCall, sf);
    // What the seam receives: its identifier and property-chain arguments, plus every such
    // VALUE its object literals carry. Passing an identifier carries every chain rooted at it
    // (`read({ call })` carries `call.signal`).
    const carried = new Set([
      ...identifierArgNames(seamCall),
      ...propertyAccessArgTexts(seamCall, sf),
      ...[...seamLiterals.values.values()].filter(Boolean),
    ]);
    // Dropping the seam's own receiver, or a value rooted at it, is not a strand: its supplier
    // supplied the object, so the seam can close over it.
    const receiverKey = valueText(unwrap(seamAccess.expression), sf) ?? receiver;
    const isCarried = (v) =>
      v === receiverKey || v.startsWith(`${receiverKey}.`) || carried.has(v) || carried.has(v.split('.')[0]);
    const missing = [...identifierArgNames(defaultCall), ...propertyAccessArgTexts(defaultCall, sf)].filter(
      (a) => !isCarried(a),
    );
    // Object literals on BOTH sides that share at least one name: a name the default sets and
    // the seam never does, unless its value is carried anyway (WI-6554700010009845). No shared
    // name means two vocabularies (a high-level input beside low-level dispatch options), so
    // comparing them proves nothing; a seam-side spread may carry any name.
    const defaultLiterals = objectLiteralArgs(defaultCall, sf);
    const shared = [...defaultLiterals.values.keys()].some((name) => seamLiterals.values.has(name));
    if (shared && !seamLiterals.spread) {
      for (const [name, value] of defaultLiterals.values) {
        if (!seamLiterals.values.has(name) && !(value && isCarried(value))) missing.push(`{${name}}`);
      }
    }
    if (missing.length === 0) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    findings.push({
      file: fileName,
      line: line + 1,
      form,
      seam,
      missing,
      seamCallText: seamCall.getText(sf),
      defaultCallText: defaultCall.getText(sf),
    });
  }

  /** The statement spellings `if-else` / `if-return` (see the header). */
  function considerIf(node, tested) {
    const thenP = payload(single(node.thenStatement), sf);
    let form = 'if-else';
    let otherP;
    if (node.elseStatement) {
      otherP = payload(single(node.elseStatement), sf);
    } else {
      // No else: only a `return` makes the NEXT sibling the default branch.
      form = 'if-return';
      if (thenP?.kind !== 'return') return;
      const p = node.parent;
      const siblings =
        p && (ts.isBlock(p) || ts.isSourceFile(p) || ts.isModuleBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p))
          ? p.statements
          : null;
      const idx = siblings ? siblings.indexOf(node) : -1;
      otherP = idx >= 0 ? payload(siblings[idx + 1], sf) : null;
      if (otherP?.kind !== 'return') return;
    }
    if (!thenP || !otherP || thenP.kind !== otherP.kind) return;
    if (thenP.kind === 'assign' && thenP.target !== otherP.target) return;
    const [seamP, defaultP] = tested.present ? [thenP, otherP] : [otherP, thenP];
    consider(node, form, tested.key, seamP.expr, defaultP.expr);
  }

  function visit(node) {
    if (ts.isConditionalExpression(node)) {
      const tested = testedSeam(node.condition);
      if (tested) {
        const [seamBranch, defaultBranch] = tested.present
          ? [node.whenTrue, node.whenFalse]
          : [node.whenFalse, node.whenTrue];
        consider(node, 'ternary', tested.key, seamBranch, defaultBranch);
      }
    } else if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      // Only an OPTIONAL call (`X.seam?.(…)`) marks a seam: `cache.get(k) ?? build(k, ctx)`
      // is an ordinary fallback, not a substitution.
      const left = unwrap(node.left);
      if (ts.isCallExpression(left) && left.questionDotToken) {
        const seam = propAccessKey(unwrap(left.expression));
        const form = node.operatorToken.kind === ts.SyntaxKind.BarBarToken ? 'or' : 'nullish';
        if (seam) consider(node, form, seam, left, node.right);
      }
    } else if (ts.isIfStatement(node)) {
      const tested = testedSeam(node.expression);
      if (tested) considerIf(node, tested);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return findings;
}

function parseArgs(argv) {
  const opts = { json: false, fail: false, files: null };
  for (const a of argv) {
    if (a === '--json') opts.json = true;
    else if (a === '--fail') opts.fail = true;
    else if (a.startsWith('--files=')) opts.files = a.slice('--files='.length).split(',').filter(Boolean);
  }
  return opts;
}

/**
 * SHRINK-ONLY baseline — the findings that already existed when this guard was
 * WIRED onto a blocking path (2026-08-16, WI-39420 gate-green work; the
 * check-lint-guard-reachability meta-guard demanded wire-or-retire, and wiring
 * `--fail` unbaselined would have red-pinned the fleet on defects that accrued
 * while the guard ran nowhere — its documented rot mode).
 *
 * Keyed by `file::seam::sorted-missing` — deliberately LINE-INDEPENDENT so
 * unrelated edits above a finding don't churn the baseline, while any CHANGE in
 * which identifiers the seam drops re-surfaces as a NEW finding.
 *
 * Rules: entries may only be REMOVED (fix the seam, or judge it fine and widen
 * the seam signature — then delete the row). Never append; a new arity-strand
 * fails the gate, which is the whole point of wiring. Each entry carries the
 * pending judgment it awaits.
 */
const FAIL_BASELINE = new Map([
  [
    'packages/operator-core/lib/agent-plane-measurement-sweep.ts::deps.lastMeasuredAtMs::harnessSlug,workspaceId',
    'pre-wiring finding (2026-08-16): seam cannot vary by workspace/harness — judge whether per-scope measurement is load-bearing',
  ],
  [
    'packages/operator-core/lib/search/self-session.ts::opts.codexHomeForSession::home',
    'pre-wiring finding (2026-08-16): seam cannot vary by home dir — judge whether a non-default HOME matters for injected resolvers',
  ],
]);

/** The line-independent identity a baseline row matches on (see FAIL_BASELINE). */
function findingKey(f) {
  return `${f.file}::${f.seam}::${[...f.missing].sort().join(',')}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const files = opts.files ?? defaultCandidateFiles();

  if (files.length === 0) {
    console.log('check-di-seam-arity-strands: ⚠ NOT CHECKED — zero candidate files (nothing examined, this proves nothing).');
    process.exit(EXIT_NOT_CHECKED);
  }

  const allFindings = [];
  for (const relPath of files) {
    const abs = resolve(ROOT, relPath);
    let text;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted-but-still-tracked-in-index edge case
    }
    for (const f of findArityStrandsInSource(text, relPath)) {
      allFindings.push(f);
    }
  }

  // Split against the shrink-only baseline: only NEW findings block in --fail
  // mode; baselined ones stay visible as advisory debt. A baseline row whose
  // finding no longer exists is STALE — the seam was fixed (or the code moved):
  // prune the row. Stale rows are loud-advisory, never a failure, so a genuine
  // fix can land without a lockstep baseline edit.
  const newFindings = allFindings.filter((f) => !FAIL_BASELINE.has(findingKey(f)));
  const baselined = allFindings.filter((f) => FAIL_BASELINE.has(findingKey(f)));
  const liveKeys = new Set(allFindings.map(findingKey));
  const staleBaseline = [...FAIL_BASELINE.keys()].filter((k) => !liveKeys.has(k));

  if (opts.json) {
    console.log(
      JSON.stringify(
        { ok: true, examined: files.length, findings: allFindings, newFindings, baselinedCount: baselined.length, staleBaseline },
        null,
        2,
      ),
    );
  } else if (allFindings.length === 0) {
    console.log(`check-di-seam-arity-strands: ✓ examined ${files.length} files, no arity-narrower DI seams found.`);
  } else {
    console.log(
      `check-di-seam-arity-strands: found ${allFindings.length} DI seam(s) narrower than the default they replace ` +
        `(examined ${files.length} files):\n`,
    );
    for (const f of allFindings) {
      const mark = FAIL_BASELINE.has(findingKey(f)) ? '  [baselined — pre-wiring debt]' : '';
      console.log(`  ${f.file}:${f.line}  seam \`${f.seam}\` (${f.form})${mark}`);
      console.log(`    called:  ${f.seamCallText}`);
      console.log(`    default: ${f.defaultCallText}`);
      console.log(`    dropped from the seam call: ${f.missing.join(', ')}\n`);
    }
    console.log(
      'A finding here does not prove a real bug, only that the seam cannot vary by the\n' +
        'dropped identifier — check whether that argument is load-bearing for what the\n' +
        'seam is meant to let a caller substitute (EI-19448665215423873).\n' +
        `--fail blocks on NEW findings only (${newFindings.length} new, ${baselined.length} baselined).`,
    );
  }
  if (staleBaseline.length > 0) {
    // --json already carries staleBaseline; the prose goes to stderr there so stdout stays parseable.
    (opts.json ? console.error : console.log)(
      `\n⚠ ${staleBaseline.length} STALE baseline row(s) — the finding no longer exists; prune from FAIL_BASELINE:\n` +
        staleBaseline.map((k) => `    ${k}`).join('\n'),
    );
  }

  if (opts.fail && newFindings.length > 0) process.exit(1);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGuardWithIndexFaultGuard(main, { guard: 'di-seam-arity-strands' });
}
