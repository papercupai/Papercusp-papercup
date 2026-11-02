/**
 * P-001 (verification-system-improvements-2026-10-10): pin the verification-system
 * map doc to the code it describes.
 *
 * The map names every refusal code the requirement-contract gates emit. That list
 * is a second copy of a truth the code owns, so (derived-truth ladder) it is
 * PINNED here, in both directions:
 *
 *   omitted  — a gate emits a code the map never names. An agent meets a refusal
 *              the one map does not explain, which is the failure the map exists
 *              to remove (the first audit of this system got it wrong for exactly
 *              that reason).
 *   unknown  — the map names a code no gate declares any more. Worse: it reads as
 *              authoritative and the reader cannot tell it is stale.
 *
 * and per code:
 *
 *   noSource — the code has no source definition (it resolves to nothing).
 *   noTest   — no test asserts on the code, so nothing proves the gate can emit it.
 *
 * The expected code set is DERIVED from typed code unions (see
 * CONTRACT_GATE_CODE_TYPES) by the test, with the TypeScript checker, so adding a
 * member to a gate's union is enough to make this check demand a map entry. Which
 * unions belong to "the contract gates" is the one curated input (rung 4): it is a
 * judgement about scope, not a fact the code states. `findUnregisteredDoorCodes`
 * backstops that curation by flagging a refusal literal in a door module that is
 * neither in a registered union nor classified as operational.
 *
 * This module is pure so the test can feed it fixtures; reading the real doc, the
 * real modules and the real test corpus is the test's job.
 */

/** One typed code union that a contract gate emits from. */
export interface ContractGateCodeType {
  /** The door the agent calls when it meets this refusal. */
  readonly door:
    | 'plans:set-plan-status'
    | 'plans:start'
    | 'plans:bind-spec-evidence'
    | 'plans:acceptance-disposition'
    | 'plans:promote'
    // P-006: the blind gap review door, met first at the awaiting-acceptance writer.
    | 'plans:set-status';
  /** Repo-relative module (from packages/operator-core/lib) that declares the type. */
  readonly module: string;
  /** Exported type (or interface) name. */
  readonly type: string;
  /** When set, the codes are this property's type rather than the type itself. */
  readonly property?: string;
}

/**
 * The requirement-contract gates and the typed unions they refuse from. Ship gate
 * = plans:set-plan-status → shipped (acceptance gate + bar-contract snapshot);
 * plans:start = activation, admission of the contract, spec quality, spec
 * coverage, bar critique; bind-spec-evidence = instrument provenance and binding
 * targets; acceptance drain = typed dispositions.
 *
 * Deliberately NOT here: plan-admission-enforcement's AdmissionRefusalCode (the
 * stop-the-line claim floors gate WHO may claim, not whether the contract holds).
 */
export const CONTRACT_GATE_CODE_TYPES: readonly ContractGateCodeType[] = [
  { door: 'plans:set-plan-status', module: 'plan-acceptance-gate.ts', type: 'PlanAcceptanceGateCode' },
  { door: 'plans:set-plan-status', module: 'acceptance-bar-contract-snapshot.ts', type: 'AcceptanceBarSnapshotCode' },
  { door: 'plans:start', module: 'agent-tools/plans/plan-start-gate.ts', type: 'PlanStartRefusal', property: 'code' },
  { door: 'plans:start', module: 'agent-tools/plans/plan-start-gate.ts', type: 'PlanStartRefusal', property: 'error' },
  { door: 'plans:start', module: 'agent-tools/plans/draft-item-start-gate.ts', type: 'DraftItemStartRefusal', property: 'error' },
  { door: 'plans:start', module: 'agent-tools/plans/plan-activation-gate.ts', type: 'ActivationGateRefusalCode' },
  { door: 'plans:start', module: 'agent-tools/plans/plan-spec-quality-gate.ts', type: 'PlanSpecQualityGateCode' },
  { door: 'plans:start', module: 'agent-tools/plans/plan-spec-coverage-gate.ts', type: 'PlanSpecCoverageGateCode' },
  { door: 'plans:start', module: 'agent-tools/plans/plan-start-critique-gate.ts', type: 'BarCritiqueGateCode' },
  { door: 'plans:start', module: 'agent-tools/plans/start.ts', type: 'PlanStartDoorRefusalCode' },
  { door: 'plans:bind-spec-evidence', module: 'agent-tools/plans/instrument-provenance.ts', type: 'InstrumentRefusalCode' },
  { door: 'plans:bind-spec-evidence', module: 'agent-tools/plans/bind-spec-evidence.ts', type: 'BindSpecEvidenceRefusalCode' },
  { door: 'plans:bind-spec-evidence', module: 'agent-tools/plans/spec-evidence-store.ts', type: 'WorkItemPlanItemRefusalStatus' },
  // P-008: independent-verification refusals, returned as BindSpecEvidenceResult.status.
  { door: 'plans:bind-spec-evidence', module: 'agent-tools/plans/spec-evidence-store.ts', type: 'IndependentVerificationRefusalStatus' },
  { door: 'plans:acceptance-disposition', module: 'agent-tools/plans/acceptance-drain-disposition.ts', type: 'AcceptanceDispositionRefusalCode' },
  // P-006: the blind gap review door's codes, returned by the awaiting-acceptance writers
  // (plans:set-status acceptanceBlocked, the drain sweep's skip) and by the ship gate.
  { door: 'plans:set-status', module: 'blind-review-gate.ts', type: 'BlindReviewGateCode' },
  // P-003: the VAL-* retirement. plans:promote returns 'val-block-retired'; the other two
  // members are returned by the retired VAL write/read paths.
  { door: 'plans:promote', module: 'agent-tools/plans/val-retirement.ts', type: 'ValRetirementRefusalCode' },
];

/**
 * Refusal-shaped literals in door modules that are NOT contract refusals: lookup
 * misses, concurrency, input validation, and the claim-floor admission gate. Each
 * entry says why. A literal that appears in a door module and is in neither this
 * table nor a registered union fails `findUnregisteredDoorCodes`, so a new
 * contract refusal cannot be added without being classified.
 */
export const OPERATIONAL_DOOR_CODES: Readonly<Record<string, string>> = {
  not_found: 'lookup miss on the subject, not a contract verdict',
  plan_not_found: 'lookup miss on the plan',
  busy: 'concurrency: another writer holds the plan',
  noop: 'the requested status equals the current one',
  no_status_line: 'malformed plan frontmatter, not a contract verdict',
  unexpected_status: 'input validation on the requested status',
  grading_sweep_paused: 'operational kill-switch on the grading sweep',
  plan_terminal: 'the plan is already shipped/dropped; nothing to start',
  plan_locked: 'concurrency: the plan row is locked by another start',
  plan_changed: 'optimistic-concurrency: the plan moved during start',
  plan_revision_unavailable: 'storage read failure, retryable',
  plan_start_revalidation_unavailable: 'storage read failure, retryable',
  plan_start_authority_unavailable: 'operational failure to issue start authority; this is not a contract verdict and earlier side effects may have committed',
  plan_admission_unavailable: 'promotion preflight could not read admission state; operational read failure, retryable',
  plan_source_unavailable: 'promotion preflight could not read plan frontmatter; operational read failure, retryable',
  invalid_consult_id: 'input validation on the critique consult id',
  consult_available: 'routing advice: a critique consult can still be opened',
  admission_refused: 'stop-the-line claim floors (who may claim), not the contract',
  custom: 'zod issue code, not a refusal',
  adequacy_attestation_unchecked: 'advisory attached to a SUCCESSFUL bind, not a refusal',
};

export interface MapCodeFacts {
  /** Codes the map doc names (first-column inline code of its refusal tables). */
  readonly mapCodes: readonly string[];
  /** Codes derived from the registered unions, keyed to where each is defined. */
  readonly derived: ReadonlyMap<string, { readonly door: string; readonly source: string | null }>;
  /** For each derived code, the first test file that asserts on it, or null. */
  readonly triggeringTest: ReadonlyMap<string, string | null>;
}

export interface MapFindings {
  readonly omitted: readonly string[];
  readonly unknown: readonly string[];
  readonly noSource: readonly string[];
  readonly noTest: readonly string[];
}

export function judgeVerificationSystemMap(facts: MapCodeFacts): MapFindings {
  const named = new Set(facts.mapCodes);
  const omitted = [...facts.derived.keys()].filter((c) => !named.has(c)).sort();
  const unknown = [...named].filter((c) => !facts.derived.has(c)).sort();
  const noSource = [...facts.derived].filter(([, v]) => !v.source).map(([c]) => c).sort();
  const noTest = [...facts.derived.keys()].filter((c) => !facts.triggeringTest.get(c)).sort();
  return { omitted, unknown, noSource, noTest };
}

const CODE_CELL = /^\|\s*`([a-z][a-z0-9]*(?:[_-][a-z0-9]+)*)`\s*\|/;

/**
 * Codes named by the map: the first-column inline-code cell of every table row
 * inside the `## Refusal codes` section. Structure, not prose, so a tool name or
 * file path elsewhere on the page is never mistaken for a code.
 */
export function extractMapRefusalCodes(docText: string): string[] {
  const start = docText.search(/^## Refusal codes\b/m);
  if (start < 0) return [];
  const rest = docText.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next < 0 ? rest : rest.slice(0, next);
  const codes: string[] = [];
  for (const line of section.split('\n')) {
    const m = CODE_CELL.exec(line.trim());
    if (m) codes.push(m[1]!);
  }
  return codes;
}

/** Longest expect statement (in lines) the span scan follows before giving up. */
const MAX_EXPECT_STATEMENT_LINES = 40;

/**
 * Start of an assertion statement: `expect(`, an assertion helper named by convention
 * (`expectRefused(`, `assertCode(`), or node's `assert(` / `assert.equal(`.
 */
const ASSERTION_CALL = /\b(?:expect|assert)(?:[A-Z_]\w*)?(?:\.\w+)?\(/;
/** A line that DEFINES an assertion helper rather than calling one. */
const ASSERTION_HELPER_DEFINITION =
  /\bfunction\s+(?:expect|assert)\w*\s*\(|\b(?:const|let|var)\s+(?:expect|assert)\w*\s*=/;

/**
 * True when `testText` asserts on `code`: the quoted literal appears inside an
 * assertion statement — `expect(…)`, an `expect*`/`assert*` helper call, or node's
 * `assert`. The statement runs from the call until its parentheses balance on a line
 * that ends the statement, so a code deep inside a multi-line `toMatchObject({ … })`
 * counts. A code that only appears in fixture construction, or in a helper's own
 * definition line, does not.
 */
export function testAssertsOnCode(testText: string, code: string): boolean {
  const quoted = [`'${code}'`, `"${code}"`, '`' + code + '`'];
  const lines = testText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    // On a helper's definition line, look only past the definition head, so the
    // helper's own name/defaults never count but an inline `expect(` in its body does.
    const def = ASSERTION_HELPER_DEFINITION.exec(lines[i]!);
    const from = def ? def.index + def[0].length : 0;
    const rel = lines[i]!.slice(from).search(ASSERTION_CALL);
    if (rel < 0) continue;
    const at = from + rel;
    let depth = 0;
    const end = Math.min(lines.length, i + MAX_EXPECT_STATEMENT_LINES);
    for (let j = i; j < end; j += 1) {
      const line = j === i ? lines[j]!.slice(at) : lines[j]!;
      if (quoted.some((q) => line.includes(q))) return true;
      for (const ch of line) {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      // A balanced line ending in `)` still continues when the next line chains a
      // matcher (`expect(x)\n  .toMatchObject({ … })`), so look ahead before stopping.
      if (depth <= 0 && /[;)]\s*$/.test(line.trimEnd()) && !/^\s*\./.test(lines[j + 1] ?? '')) {
        break;
      }
    }
  }
  return false;
}

const DOOR_LITERAL = /\b(?:code|error)\s*:\s*'([a-z][a-z0-9]*(?:_[a-z0-9]+)+|[a-z]+)'/g;

/**
 * Refusal-shaped literals (`code: '…'` / `error: '…'`) in a door module that are
 * neither derived from a registered union nor classified as operational.
 */
export function findUnregisteredDoorCodes(
  moduleText: string,
  derived: ReadonlySet<string>,
  operational: Readonly<Record<string, string>> = OPERATIONAL_DOOR_CODES,
): string[] {
  const out = new Set<string>();
  for (const m of moduleText.matchAll(DOOR_LITERAL)) {
    const code = m[1]!;
    if (!derived.has(code) && !(code in operational)) out.add(code);
  }
  return [...out].sort();
}

/**
 * SPEC-P-001-BAR-TIMING: CLAUDE.md and the plan-completion runbook must state the
 * same moment for authoring acceptance bars — seeded at plan activation from the
 * plan's requirements, amended to as-built at completion — and neither may keep
 * the retired "author the rubric after implementation" instruction.
 */
export const BAR_TIMING_REQUIRED: readonly RegExp[] = [
  /acceptance bars are seeded at plan activation/i,
  /amend(?:ed)? (?:them |the rubric |it )?to as-built/i,
];
export const BAR_TIMING_RETIRED: readonly RegExp[] = [/author the rubric after implementation/i];

export function judgeBarTiming(docs: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const [name, text] of Object.entries(docs)) {
    for (const re of BAR_TIMING_REQUIRED) if (!re.test(text)) problems.push(`${name}: missing ${re}`);
    for (const re of BAR_TIMING_RETIRED) if (re.test(text)) problems.push(`${name}: still says ${re}`);
  }
  return problems;
}
