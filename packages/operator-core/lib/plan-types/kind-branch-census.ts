/**
 * R-7 (plan-item-types-registry-cupboard-2026-10-20): the DELIVERABLE-KIND BRANCH census.
 *
 * Item types are open (`acme/legal-review`), so code that branches on one of the six built-in
 * deliverable kinds outside the resolver (plan-verification-profile.ts and plan-types/) silently
 * misjudges every third-party type. This module holds the census rules: which files are scanned,
 * which seven syntactic shapes count as a kind branch, and the shrink-only baseline.
 *
 * Two readers share it, so they cannot drift apart:
 * - plan-verification-profile-boundary.test.ts walks the working tree and asserts the census is
 *   clean (no unexpected finding, no stale baseline entry);
 * - the `deliverable-kind-branch-census` tree instrument (agent-tools/plans/tree-instruments.ts)
 *   re-runs the same census over a COMMITTED tree, so a spec-evidence binding of that test reads
 *   current exactly while the committed census output is unchanged (WI-6554700010018633's
 *   mechanism: a broad tree scan cannot be witnessed by a bounded file set).
 *
 * The module lives under plan-types/, which the census itself skips as a kind-policy owner.
 */
import ts from 'typescript';
import { DELIVERABLE_KINDS } from '@papercusp/plan-parser';

export type KindShape =
  | 'literal-equality'
  | 'literal-membership'
  | 'list-membership'
  | 'kind-comparison'
  | 'kind-switch'
  | 'kind-keyed-lookup';

export interface KindBranchFinding {
  file: string;
  line: number;
  shape: KindShape;
  text: string;
}

const KIND_LITERALS: ReadonlySet<string> = new Set(DELIVERABLE_KINDS);

/** The roots R-7 names, as repo-relative prefixes. */
export const KIND_SCAN_ROOTS: readonly string[] = ['packages/operator-core/lib', 'apps/operator', 'libs/generic/plan-parser/src'];

/** The resolver owns kind policy; the parser vocabulary DEFINES the kinds (grammar only, R-4). */
export const KIND_POLICY_OWNERS: readonly RegExp[] = [
  /^packages\/operator-core\/lib\/plan-verification-profile\.ts$/,
  /^packages\/operator-core\/lib\/plan-types\//,
  /^libs\/generic\/plan-parser\/src\/verification-vocabulary\.ts$/,
];

/** Directory names the walk never descends into, at any depth below a root. */
export const KIND_SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules', '.vitest-tmp', 'dist', 'coverage', '__snapshots__',
  'dist-host', '.next', 'sidecar', 'target', 'public', 'e2e', 'src-tauri', 'out',
]);

/**
 * Whether the census scans repo-relative `relPath`: a non-test, non-declaration `.ts`/`.tsx`
 * file under a scan root, below no skipped directory, and not a kind-policy owner. The
 * working-tree walk applies the same rule one directory at a time.
 */
export function isKindScanPath(relPath: string): boolean {
  const root = KIND_SCAN_ROOTS.find((prefix) => relPath.startsWith(`${prefix}/`));
  if (!root) return false;
  const segments = relPath.slice(root.length + 1).split('/');
  const name = segments.pop() ?? '';
  if (segments.some((segment) => KIND_SKIPPED_DIRS.has(segment))) return false;
  if (!/\.tsx?$/.test(name)) return false;
  if (/\.test\.tsx?$/.test(name) || /\.spec\.tsx?$/.test(name) || name.endsWith('.d.ts')) return false;
  return !KIND_POLICY_OWNERS.some((re) => re.test(relPath));
}

const EQUALITY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

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

/** Every kind branch in one source file, in source order. */
export function scanSourceForKindBranches(relPath: string, text: string): KindBranchFinding[] {
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

/** A finding's identity without its line, so an unrelated edit above a site does not move it. */
export const kindFindingKey = (f: Pick<KindBranchFinding, 'file' | 'shape' | 'text'>) => `${f.file} :: ${f.shape} :: ${f.text}`;

/**
 * Kind branches that existed when R-7 landed. SHRINK-ONLY: delete an entry when its site goes
 * away; never add one — route the decision through the resolver instead. Each entry says why it
 * is not (yet) routed.
 */
export const KIND_BRANCH_BASELINE: readonly string[] = [
  // Not a branch: a doc-claim pin comparing the documented default kind with the resolver's own answer.
  'packages/operator-core/lib/doc-claims/verification-profiles-doc.ts :: kind-comparison :: deliverable[0] !== expected.deliverable',
];

/** Cheap pre-filter: a file that never says "deliverable" cannot hold a kind branch. */
export function mayHoldKindBranch(text: string): boolean {
  return /deliverable|isDeliverableKind/i.test(text);
}

export interface KindBranchCensus {
  findings: KindBranchFinding[];
  /** Findings no baseline entry accounts for: each one fails R-7. */
  unexpected: KindBranchFinding[];
  /** Baseline entries with no remaining site: each one fails R-7 (the baseline is shrink-only). */
  stale: string[];
}

/** Reconcile per-file findings against the shrink-only baseline. */
export function reconcileKindBranchFindings(findings: readonly KindBranchFinding[]): KindBranchCensus {
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
  return { findings: [...findings], unexpected, stale };
}

/** The census over `files` (repo-relative scan paths), reading each body with `read`. */
export function kindBranchCensus(files: readonly string[], read: (relPath: string) => string): KindBranchCensus {
  const findings: KindBranchFinding[] = [];
  for (const relPath of files) {
    const text = read(relPath);
    if (!mayHoldKindBranch(text)) continue;
    findings.push(...scanSourceForKindBranches(relPath, text));
  }
  return reconcileKindBranchFindings(findings);
}

/**
 * The line-free, order-free projection of a census that the tree instrument digests: exactly
 * what R-7 asserts (unexpected, stale) plus the finding keys behind it. Unrelated commits leave
 * it unchanged; a planted or removed kind branch changes it.
 */
export function kindBranchCensusOutput(census: KindBranchCensus): { findings: string[]; unexpected: string[]; stale: string[] } {
  return {
    findings: census.findings.map(kindFindingKey).sort(),
    unexpected: census.unexpected.map(kindFindingKey).sort(),
    stale: [...census.stale].sort(),
  };
}
