/**
 * R-2 (plan-verification-profiles-2026-10-17): no verification gate keeps a LOCAL
 * non-code exemption outside the resolver (./plan-verification-profile.ts).
 *
 * Before P-001, each gate decided "is this non-code work?" for itself, by comparing a
 * string literal. Every new gate had to remember all six exemptions, and kept
 * forgetting (at least 9 filed bugs). The resolver now owns that decision. This guard
 * parses the operator-core sources and refuses a new local comparison against
 * one of the three non-code signal literals:
 *
 * - `'not-code'` (completion-audit verdict) and `'non-automated'` (spec-clause
 *   behaviour class), anywhere in operator-core lib: both are verification-only words;
 * - `'task'` compared with a `*kind*` operand inside the verification surface (plans,
 *   acceptance bars, scorecards, completion). Elsewhere `task` is an ordinary storage
 *   kind, so it is not a verification exemption there.
 *
 * Three comparison shapes count: equality (`===`, `!==`, `==`, `!=`), a `case` label,
 * and membership (`.includes` / `.has`) on an array or Set literal. Comments and
 * prose inside template strings are not code, so they never match.
 *
 * SHRINK-ONLY: `BASELINE` lists the comparisons that existed when the guard landed and
 * are not exemption decisions. A new finding fails, and so does a baseline entry that
 * no longer exists, so the list can only get shorter. Never add an entry: call the
 * resolver predicate instead (isNonCodeAuditVerdict, isNonCodeWorkItemKind,
 * isNonAutomatedBehaviorClass, executableProofExemption, isReasonedNonCodeAudit).
 *
 * R-7 (plan-item-types-registry-cupboard-2026-10-20): the same guard also refuses code that
 * BRANCHES ON A DELIVERABLE KIND outside the resolver (plan-verification-profile.ts and
 * plan-types/), across packages/operator-core/lib, apps/operator and the plan parser. Item
 * types are open now (`acme/legal-review`), so a branch on one of the six built-in kinds
 * silently misjudges every third-party type: ask the resolver for the module set instead
 * (`resolveVerification(...).codeDeliverable` / `.modules`). Seven shapes count, see
 * `scanSourceForKindBranches`. It has its own shrink-only `KIND_BRANCH_BASELINE`.
 */
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DELIVERABLE_KINDS } from '@papercusp/plan-parser';

const LIB_ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(LIB_ROOT, '../../..');
const RESOLVER_FILE = 'plan-verification-profile.ts';
const SKIPPED_DIRS = new Set(['node_modules', '.vitest-tmp', 'dist', 'coverage', '__snapshots__']);

type Signal = 'not-code' | 'non-automated' | 'task';
type Shape = 'equality' | 'case' | 'membership';

interface BoundaryFinding {
  file: string;
  line: number;
  signal: Signal;
  shape: Shape;
  text: string;
}

/** Files whose `kind === 'task'` comparisons are verification decisions. */
const VERIFICATION_SURFACE: readonly RegExp[] = [
  /^plan-[^/]*\.ts$/,
  /^acceptance-bar-[^/]*\.ts$/,
  /^derive-draft-spec-clauses\.ts$/,
  /^agent-tools\/plans\//,
  /^agent-tools\/scorecards\//,
  /^agent-tools\/work_items\/(complete[^/]*|completion-[^/]*|spec-test-adequacy-gate)\.ts$/,
];

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);
const KIND_OPERAND = /kind/i;

function literalValue(node: ts.Node | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The string literals of an array literal, or of `new Set([...])`, used as a membership receiver. */
function literalMembers(receiver: ts.Expression): string[] {
  const target = unwrap(receiver);
  const array = ts.isArrayLiteralExpression(target)
    ? target
    : ts.isNewExpression(target) && ts.isIdentifier(target.expression) && target.expression.text === 'Set' &&
        target.arguments?.[0] && ts.isArrayLiteralExpression(unwrap(target.arguments[0]))
      ? (unwrap(target.arguments[0]) as ts.ArrayLiteralExpression)
      : null;
  if (!array) return [];
  return array.elements.map((element) => literalValue(element)).filter((v): v is string => v !== null);
}

function scanSourceForLocalExemptions(relPath: string, text: string): BoundaryFinding[] {
  const inSurface = VERIFICATION_SURFACE.some((re) => re.test(relPath));
  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: BoundaryFinding[] = [];
  const signalOf = (value: string | null, operand: ts.Node | undefined): Signal | null => {
    if (value === 'not-code' || value === 'non-automated') return value;
    if (value === 'task' && inSurface && operand && KIND_OPERAND.test(operand.getText(sf))) return 'task';
    return null;
  };
  const record = (node: ts.Node, signal: Signal, shape: Shape) => {
    findings.push({
      file: relPath,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      signal,
      shape,
      text: node.getText(sf).replace(/\s+/g, ' ').trim(),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      const signal = signalOf(literalValue(node.left), node.right) ?? signalOf(literalValue(node.right), node.left);
      if (signal) record(node, signal, 'equality');
    } else if (ts.isCaseClause(node)) {
      const switchStatement = node.parent.parent;
      const signal = signalOf(
        literalValue(node.expression),
        ts.isSwitchStatement(switchStatement) ? switchStatement.expression : undefined,
      );
      if (signal) record(node.expression, signal, 'case');
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === 'includes' || node.expression.name.text === 'has') &&
      node.arguments.length > 0
    ) {
      for (const member of literalMembers(node.expression.expression)) {
        const signal = signalOf(member, node.arguments[0]);
        if (signal) {
          record(node, signal, 'membership');
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function listSourceFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...listSourceFiles(path.join(dir, entry.name), relPath));
      continue;
    }
    if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts') || relPath === RESOLVER_FILE) continue;
    out.push(relPath);
  }
  return out;
}

const findingKey = (f: Pick<BoundaryFinding, 'file' | 'signal' | 'text'>) => `${f.file} :: ${f.signal} :: ${f.text}`;

/**
 * Comparisons that existed when the guard landed and are NOT non-code exemption
 * decisions. Shrink-only: delete an entry when its site goes away; never add one.
 */
const BASELINE: readonly string[] = [
  // Maps a work-item kind to the issue family for lock endpoints; not a verification exemption.
  "agent-tools/plans/with-plan-lock.ts :: task :: ['bug', 'change', 'task'].includes(row.item_kind)",
];

function checkBoundary(overrides: ReadonlyMap<string, string> = new Map()) {
  const findings: BoundaryFinding[] = [];
  for (const relPath of listSourceFiles(LIB_ROOT)) {
    const text = overrides.get(relPath) ?? readFileSync(path.join(LIB_ROOT, relPath), 'utf8');
    if (!text.includes('not-code') && !text.includes('non-automated') && !text.includes('task')) continue;
    findings.push(...scanSourceForLocalExemptions(relPath, text));
  }
  const remaining = new Map<string, number>();
  for (const key of BASELINE) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const unexpected: BoundaryFinding[] = [];
  for (const finding of findings) {
    const key = findingKey(finding);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else unexpected.push(finding);
  }
  const stale = [...remaining].flatMap(([key, count]) => Array.from({ length: count }, () => key));
  return { files: listSourceFiles(LIB_ROOT), findings, unexpected, stale };
}

const SEEDED_GATE = `
export function localGate(entry: { verdict: string }, item: { kind: string; workItemKind?: string }, clause: { behaviorClass: string }) {
  if (entry.verdict === 'not-code') return true;
  if (item.kind === 'task') return true;
  if (clause.behaviorClass !== 'non-automated') return false;
  switch (entry.verdict) { case 'not-code': return true; }
  if (['task'].includes(item.workItemKind ?? '')) return true;
  return new Set(['non-automated']).has(clause.behaviorClass);
}
`;

// ─────────────────────────── R-7: deliverable-kind branches ───────────────────────────

type KindShape =
  | 'literal-equality'
  | 'literal-membership'
  | 'list-membership'
  | 'kind-comparison'
  | 'kind-switch'
  | 'kind-keyed-lookup';

interface KindBranchFinding {
  file: string;
  line: number;
  shape: KindShape;
  text: string;
}

const KIND_LITERALS: ReadonlySet<string> = new Set(DELIVERABLE_KINDS);

/** The roots R-7 names, as repo-relative prefixes. */
const KIND_SCAN_ROOTS: readonly string[] = ['packages/operator-core/lib', 'apps/operator', 'libs/generic/plan-parser/src'];

/** The resolver owns kind policy; the parser vocabulary DEFINES the kinds (grammar only, R-4). */
const KIND_POLICY_OWNERS: readonly RegExp[] = [
  /^packages\/operator-core\/lib\/plan-verification-profile\.ts$/,
  /^packages\/operator-core\/lib\/plan-types\//,
  /^libs\/generic\/plan-parser\/src\/verification-vocabulary\.ts$/,
];

const KIND_SKIPPED_DIRS = new Set([
  ...SKIPPED_DIRS, 'dist-host', '.next', 'sidecar', 'target', 'public', 'e2e', 'src-tauri', 'out',
]);

/**
 * A deliverable-KIND operand: an expression whose own name says it holds an item's deliverable
 * (`item.deliverable`, `declaredDeliverable`, `row['deliverable']`, `x.deliverable ?? null`).
 * `codeDeliverable` is the resolver's code-ness ANSWER, not a kind, and mail "deliverability"
 * / "undeliverable" are unrelated words.
 */
const KIND_OPERAND_NAME = /deliverable/i;
const NOT_A_KIND_NAME = /codeDeliverable|undeliverable|deliverabilit|deliverables$/i;

function operandName(node: ts.Expression): string | null {
  const target = unwrap(node);
  if (ts.isNonNullExpression(target)) return operandName(target.expression);
  if (
    ts.isBinaryExpression(target) &&
    (target.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || target.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return operandName(target.left);
  }
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target)) {
    const key = literalValue(target.argumentExpression);
    return key ?? null;
  }
  return null;
}

function isKindOperand(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  const name = operandName(node);
  return name !== null && KIND_OPERAND_NAME.test(name) && !NOT_A_KIND_NAME.test(name);
}

/** A kind LIST: `DELIVERABLE_KINDS`, `deliverableKinds`, `CODE_DELIVERABLES`... */
function isKindListName(node: ts.Expression): boolean {
  const name = operandName(node);
  return name !== null && /deliverable/i.test(name) && /kinds?$|deliverables$/i.test(name);
}

function isNullishLiteral(node: ts.Expression): boolean {
  const target = unwrap(node);
  return (
    target.kind === ts.SyntaxKind.NullKeyword ||
    target.kind === ts.SyntaxKind.TrueKeyword ||
    target.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(target) && target.text === 'undefined')
  );
}

function scanSourceForKindBranches(relPath: string, text: string): KindBranchFinding[] {
  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    true,
    relPath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const findings: KindBranchFinding[] = [];
  const record = (node: ts.Node, shape: KindShape) => {
    findings.push({
      file: relPath,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      shape,
      text: node.getText(sf).replace(/\s+/g, ' ').trim(),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      // `item.deliverable === 'code'` / `before.deliverable !== after.deliverable` / `deliverable === wanted`
      for (const [kindSide, other] of [[node.left, node.right], [node.right, node.left]] as const) {
        if (!isKindOperand(kindSide)) continue;
        const literal = literalValue(unwrap(other));
        if (literal !== null) {
          if (KIND_LITERALS.has(literal)) record(node, 'literal-equality');
        } else if (!isNullishLiteral(other) && !ts.isTypeOfExpression(unwrap(other))) {
          record(node, 'kind-comparison');
        }
        break;
      }
    } else if (ts.isSwitchStatement(node) && isKindOperand(node.expression)) {
      record(node.expression, 'kind-switch');
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (ts.isIdentifier(callee) && callee.text === 'isDeliverableKind') {
        // The parser's own grammar check, called to BRANCH on "is it a built-in kind".
        record(node, 'list-membership');
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'includes' || callee.name.text === 'has') &&
        arg
      ) {
        const members = literalMembers(callee.expression);
        if (members.some((member) => KIND_LITERALS.has(member)) && isKindOperand(arg)) {
          record(node, 'literal-membership');
        } else if (isKindListName(callee.expression) || (isKindOperand(arg) && members.length === 0)) {
          record(node, 'list-membership');
        }
      }
    } else if (ts.isElementAccessExpression(node) && isKindOperand(node.argumentExpression)) {
      // `MODULES_BY_KIND[item.deliverable]`
      record(node, 'kind-keyed-lookup');
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return findings;
}

function listKindScanFiles(root: string): string[] {
  const walk = (dir: string, rel: string): string[] => {
    const out: string[] = [];
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!KIND_SKIPPED_DIRS.has(entry.name)) out.push(...walk(path.join(dir, entry.name), relPath));
        continue;
      }
      if (!entry.isFile() || !/\.tsx?$/.test(entry.name)) continue;
      if (/\.test\.tsx?$/.test(entry.name) || /\.spec\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      if (KIND_POLICY_OWNERS.some((re) => re.test(relPath))) continue;
      out.push(relPath);
    }
    return out;
  };
  return walk(path.join(REPO_ROOT, root), root);
}

const kindFindingKey = (f: Pick<KindBranchFinding, 'file' | 'shape' | 'text'>) => `${f.file} :: ${f.shape} :: ${f.text}`;

/**
 * Kind branches that existed when R-7 landed. SHRINK-ONLY: delete an entry when its site goes
 * away; never add one — route the decision through the resolver instead. Each entry says why it
 * is not (yet) routed.
 */
const KIND_BRANCH_BASELINE: readonly string[] = [
  // Not a branch: a doc-claim pin comparing the documented default kind with the resolver's own answer.
  'packages/operator-core/lib/doc-claims/verification-profiles-doc.ts :: kind-comparison :: deliverable[0] !== expected.deliverable',
];

function checkKindBoundary(overrides: ReadonlyMap<string, string> = new Map()) {
  const files = KIND_SCAN_ROOTS.flatMap((root) => listKindScanFiles(root));
  const findings: KindBranchFinding[] = [];
  for (const relPath of files) {
    const text = overrides.get(relPath) ?? readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    if (!/deliverable|isDeliverableKind/i.test(text)) continue;
    findings.push(...scanSourceForKindBranches(relPath, text));
  }
  const remaining = new Map<string, number>();
  for (const key of KIND_BRANCH_BASELINE) remaining.set(key, (remaining.get(key) ?? 0) + 1);
  const unexpected: KindBranchFinding[] = [];
  for (const finding of findings) {
    const key = kindFindingKey(finding);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else unexpected.push(finding);
  }
  const stale = [...remaining].flatMap(([key, count]) => Array.from({ length: count }, () => key));
  return { files, findings, unexpected, stale };
}

const SEEDED_KIND_BRANCHES = `
import { DELIVERABLE_KINDS, isDeliverableKind } from '@papercusp/plan-parser';
const MODULES_BY_KIND: Record<string, string[]> = {};
export function localKindGate(item: { deliverable: string | null }, before: { deliverable: string | null }, wanted: string) {
  if (item.deliverable === 'code') return 1;
  if (['doc', 'research'].includes(item.deliverable ?? '')) return 2;
  if (DELIVERABLE_KINDS.includes(item.deliverable as never)) return 3;
  if (item.deliverable !== before.deliverable) return 4;
  switch (item.deliverable) { case 'decision': return 5; }
  if (isDeliverableKind(item.deliverable)) return 6;
  return MODULES_BY_KIND[item.deliverable ?? ''] ?? wanted;
}
`;

describe('plan-verification-profile boundary guard — R-7 deliverable-kind branches', () => {
  it('positive control: every seeded literal and non-literal kind-branch shape is detected', () => {
    const found = scanSourceForKindBranches('packages/operator-core/lib/plan-acceptance-gate.ts', SEEDED_KIND_BRANCHES);
    expect(found.map((f) => f.shape)).toEqual([
      'literal-equality',
      'literal-membership',
      'list-membership',
      'kind-comparison',
      'kind-switch',
      'list-membership',
      'kind-keyed-lookup',
    ]);
  });

  it('negative control: resolver answers, null checks, typeof guards and unrelated words are not findings', () => {
    const routed = `
import { resolveVerification } from './plan-verification-profile';
export function routedKindGate(item: { deliverable: string | null; codeDeliverable: boolean }, mail: { deliverability: string }) {
  // a comment saying item.deliverable === 'code' is not code
  if (item.deliverable === null || item.deliverable !== undefined) return 0;
  if (typeof item.deliverable === 'string') return 1;
  if (item.codeDeliverable === true) return 2;
  if (mail.deliverability === 'code') return 3;
  const citation = { kind: 'code' };
  if (citation.kind === 'code') return 4;
  return resolveVerification({}, { deliverable: item.deliverable }).codeDeliverable;
}
`;
    expect(scanSourceForKindBranches('packages/operator-core/lib/plan-acceptance-gate.ts', routed)).toEqual([]);
  });

  it('the real tree has no deliverable-kind branch outside the resolver and the shrink-only baseline', () => {
    const { files, unexpected, stale } = checkKindBoundary();
    // Reachability: every named root was walked, and the resolver itself was not.
    for (const root of KIND_SCAN_ROOTS) expect(files.some((f) => f.startsWith(`${root}/`)), root).toBe(true);
    expect(files).toEqual(expect.arrayContaining([
      'packages/operator-core/lib/plan-acceptance-gate.ts',
      'packages/operator-core/lib/agent-tools/plans/add-item.ts',
      'apps/operator/app/admin/plans/PlanRail.tsx',
      'libs/generic/plan-parser/src/parser.ts',
    ]));
    expect(files).not.toContain('packages/operator-core/lib/plan-verification-profile.ts');
    expect(files.some((f) => f.startsWith('packages/operator-core/lib/plan-types/'))).toBe(false);
    expect(
      unexpected.map((f) => `${f.file}:${f.line} [${f.shape}] ${f.text}`),
      'A deliverable-kind branch outside the resolver. Item types are open (acme/legal-review), so ask the ' +
        'resolver instead: resolveVerification(plan, item).codeDeliverable / .modules / .itemType.',
    ).toEqual([]);
    expect(stale, 'Baseline entries with no remaining site: delete them (the baseline is shrink-only).').toEqual([]);
  }, 120_000);

  it('a kind branch seeded into a real gate file fails the tree check', () => {
    const gateFile = 'packages/operator-core/lib/plan-acceptance-gate.ts';
    const seeded =
      `${readFileSync(path.join(REPO_ROOT, gateFile), 'utf8')}\n` +
      "export const seededKindBranch = (item: { deliverable: string }) => item.deliverable === 'code';\n";
    const { unexpected } = checkKindBoundary(new Map([[gateFile, seeded]]));
    expect(unexpected.map((f) => `${f.file} ${f.text}`)).toContain(`${gateFile} item.deliverable === 'code'`);
  }, 120_000);
});

describe('plan-verification-profile boundary guard', () => {
  it('positive control: every seeded local exemption shape is detected', () => {
    const found = scanSourceForLocalExemptions('plan-acceptance-gate.ts', SEEDED_GATE);
    expect(found.map((f) => `${f.signal}/${f.shape}`)).toEqual([
      'not-code/equality',
      'task/equality',
      'non-automated/equality',
      'not-code/case',
      'task/membership',
      'non-automated/membership',
    ]);
  });

  it('task comparisons count only inside the verification surface', () => {
    const found = scanSourceForLocalExemptions('coord/condition-upsert.ts', SEEDED_GATE);
    expect(found.map((f) => f.signal)).not.toContain('task');
    expect(found.filter((f) => f.signal !== 'task')).toHaveLength(4);
  });

  it('negative control: routed predicate calls, prose and non-kind task strings are not findings', () => {
    const routed = `
import { isNonCodeAuditVerdict, isNonCodeWorkItemKind } from './plan-verification-profile';
export function routedGate(entry: { verdict: string }, kind: string, label: string) {
  // a comment saying verdict === 'not-code' is not code
  const message = \`the verdict is 'not-code' (with a note)\`;
  if (label === 'task') return message;
  return isNonCodeAuditVerdict(entry.verdict) || isNonCodeWorkItemKind(kind);
}
`;
    expect(scanSourceForLocalExemptions('plan-acceptance-gate.ts', routed)).toEqual([]);
  });

  it('the real tree has no local exemption outside the resolver and the shrink-only baseline', () => {
    const { files, unexpected, stale } = checkBoundary();
    // Reachability: an empty walk would pass vacuously, so prove it visited the gates.
    expect(files).toEqual(expect.arrayContaining([
      'plan-acceptance-gate.ts',
      'plan-requirement-realization.ts',
      'agent-tools/plans/spec-test-adequacy.ts',
      'agent-tools/work_items/complete.ts',
      'agent-tools/scorecards/emit.ts',
    ]));
    expect(files).not.toContain(RESOLVER_FILE);
    expect(
      unexpected.map((f) => `${f.file}:${f.line} [${f.signal}/${f.shape}] ${f.text}`),
      'Local non-code exemption outside plan-verification-profile.ts. Call the resolver predicate ' +
        '(isNonCodeAuditVerdict / isNonCodeWorkItemKind / isNonAutomatedBehaviorClass / ' +
        'executableProofExemption / isReasonedNonCodeAudit) instead of comparing the literal.',
    ).toEqual([]);
    expect(stale, 'Baseline entries with no remaining site: delete them (the baseline is shrink-only).').toEqual([]);
  }, 60_000);

  it('a local exemption seeded into a real gate file fails the tree check', () => {
    const gateFile = 'plan-acceptance-gate.ts';
    const seeded = `${readFileSync(path.join(LIB_ROOT, gateFile), 'utf8')}\nexport const seededLocalExemption = (verdict: string) => verdict === 'not-code';\n`;
    const { unexpected } = checkBoundary(new Map([[gateFile, seeded]]));
    expect(unexpected.map((f) => `${f.file} ${f.text}`)).toContain(`${gateFile} verdict === 'not-code'`);
  }, 60_000);
});
