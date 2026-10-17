/**
 * P-005 (green-main-fast-2026-08-25): which gate failures may hold `main` red.
 *
 * On the evening of 2026-08-25 the gate was blocked three separate times, by three
 * DIFFERENT machinery faults, and by ZERO product-test failures: a fossil verdict
 * naming six guard tests that all passed at HEAD; a frozen repair queue waiting on a
 * dead fixer; and a fail-closed prewarm prerequisite that crashed before the suite.
 * Every one froze promotion for the whole fleet. That is the case for splitting the
 * verdict: a failure whose entire remedy is "regenerate a file" should file a work
 * item, not freeze `main`.
 *
 * This module is the DECISION half of that split, and only the decision half. It
 * classifies failures and says whether promotion may proceed; it files nothing,
 * promotes nothing, and calls nothing. Actuation is the caller's, deliberately —
 * same separation as `green-stall-watchdog`'s refire decision, for the same reason:
 * a pure verdict can be exhaustively tested against real inputs, and a decision that
 * cannot act cannot misfire while it is being proven.
 *
 * ## The rule this module exists to enforce: hygiene is a property of the FAILURE,
 * ## never of the file it came from
 *
 * The obvious implementation — "doc-claims are drift guards, so exempt that
 * directory" — is UNSAFE, and measurably so. `doc-claims/gate-candidate-ref.test.ts`
 * lines 97-102 is ONE `it()` block holding three assertions of two different kinds:
 *
 *     expect(verdict.violations).toEqual([]);                          // SUBSTANTIVE
 *     expect(verdict.ok).toBe(true);                                   // SUBSTANTIVE
 *     expect(verdict.candidateSites.length).toBeGreaterThanOrEqual(2); // COVERAGE FLOOR
 *
 * On 2026-08-25 only the third failed: green-checkpoint.ts passed 14,500 lines, its
 * candidate-resolution calls became multi-line, and a per-LINE detector stopped
 * seeing one of them. Pure drift. But the first two assertions in that same block are
 * the pin that catches the gate resolving its candidate from a REMOTE ref, or
 * fetching before it cuts — i.e. the gate judging a sha nobody asked for. Exempt the
 * FILE and you switch that off too, which is the opposite of what P-005 wants.
 *
 * So hygiene-vs-product does not vary by directory, or by file, or even by test. In
 * the block above it varies WITHIN a single `it()`. The only sound unit is the
 * failure's own semantics, which is why the admitted set below is defined as "the
 * entire remedy is regenerate-an-artifact or get-back-under-a-budget, with no
 * behavioural assertion about the running system" — and why doc-claims are NOT in it.
 * Admitting them requires first separating those two assertion kinds inside the
 * guards themselves. That is real work in ~36 files and is explicitly follow-on.
 * Until then a doc-claim red keeps holding the gate, which is today's behaviour and
 * is the safe direction to be wrong in. Recorded as plan decision D-008.
 *
 * ## Everything here fails closed, and the asymmetry is why
 *
 * Misclassifying a PRODUCT failure as hygiene promotes a real regression to `main`.
 * Misclassifying a HYGIENE failure as product merely reproduces today's behaviour —
 * an annoying freeze that a human already knows how to clear. Those costs are not
 * comparable, so every unknown, unparseable, or unregistered entry resolves to
 * `product`. There is no "assume safe" branch anywhere in this file, and the tests
 * assert that by enumeration rather than by example.
 *
 * ## Why the generated-artifact set is DERIVED and not listed
 *
 * A hand-listed set of ~17 `gen:*:check` scripts is exactly the code-describing
 * metadata that drifts (see CLAUDE.md's derive/pin/attest ladder): someone adds an
 * 18th generator, nobody updates the list, and the gate freezes on a stale artifact
 * for reasons no one can find. So the set is derived from a STRUCTURAL fact instead —
 * a script qualifies only if BOTH `gen:X` and `gen:X:check` exist in the root
 * package.json. That pair means "a generator, plus a checker asking whether its
 * output is current", which is precisely the hygiene shape. A lone `gen:foo:check`
 * with no generator behind it does NOT qualify and falls through to product, so the
 * derivation cannot be widened by naming alone.
 */

/** What kind of hygiene failure this is — drives the remedy sentence on the filed item. */
export type HygieneCategory =
  | "generated-artifact-stale"
  | "budget-exceeded"
  | "detector-coverage-drift";

export type GateFailureClass = "product" | "hygiene";

/** A hygiene entry that does NOT follow the `gen:X` / `gen:X:check` pair convention
 *  and therefore cannot be derived. Each one is here because its remedy is genuinely
 *  "regenerate or get under the budget" with no behavioural claim attached — the same
 *  bar the derived set meets, just reached by hand because the naming differs. */
export interface ExplicitHygieneEntry {
  category: HygieneCategory;
  /** The command that fixes it, as a reader would type it. */
  remedy: string;
  /** Why this is hygiene and not product. Stated per-entry so a future reader can
   *  audit the judgement instead of inheriting it. */
  why: string;
}

export const EXPLICIT_HYGIENE_GATE_SCRIPTS: Record<string, ExplicitHygieneEntry> = {
  "lint:tool-prompts": {
    category: "budget-exceeded",
    remedy: "npm run lint:tool-prompts",
    why:
      "A prompt-weight cap. Breaching it degrades agent prompts and must be fixed, but it " +
      "asserts nothing about whether the running system is correct, and it cannot corrupt " +
      "`main`. Historically this is the single most common way a tool-description edit " +
      "froze the fleet gate hours after the edit landed.",
  },
  // `lint:migration-fixture-drift:check` (category `fixture-drift`) USED TO SIT HERE and is
  // RETIRED with its npm script (WI-6554700010009165). No gate leg ever ran it, so this entry
  // classified a failure that could not occur. Wiring it instead was measured and rejected:
  // `findFixtureGaps` flags every inline fixture that lacks a new column, deliberate partial
  // stubs included, so 11 of the last 120 migrations would have fired on non-defects. The
  // detector lives on as the advisory PostToolUse nudge, which runs
  // scripts/check-migration-fixture-drift.mjs by path. An unregistered entry fails closed to
  // `product`, so re-adding the script without an entry here holds the gate rather than
  // waving it through.
};

/** ## The one admitted exception to "a test file is never hygiene" (WI-41765, D-010)
 *
 * The header above rejects exempting a doc-claims FILE, and that rejection stands: the
 * measured reason was that `gate-candidate-ref.test.ts` held a SUBSTANTIVE pin and a
 * COVERAGE floor inside ONE `it()`, so a file-level exemption switched off the pin.
 *
 * That premise no longer holds for the block it was measured on. WI-41765 SPLIT those two
 * assertion kinds into separate `it()`s, which is precisely the precondition the header
 * names ("Admitting them requires first separating those two assertion kinds inside the
 * guards themselves"). Once separated, a single failing CASE is a sound unit: its whole
 * body is one kind of claim. The unit here is therefore the CASE, never the file — a file
 * is admitted only when EVERY one of its failing cases is registered below.
 *
 * WHY A REGISTRY AND NOT A HEURISTIC. There is no textual property of a case name that
 * makes it coverage-class; "coverage" in a title is a naming convention, and deriving from
 * it would let any future test opt itself out of the gate by choosing a word. Each entry is
 * a hand-audited judgement about one specific case, exactly like EXPLICIT_HYGIENE_GATE_SCRIPTS.
 *
 * WHY THE re-merge GUARD IS LOAD-BEARING. A registered case is trusted to contain only
 * instrument assertions. If someone later adds a substantive assertion back into it, this
 * registry silently converts a REAL product failure into hygiene — the original D-008 hazard,
 * one level down. `forbiddenSymbols` is what makes that detectable rather than a comment
 * nobody re-reads: gate-hygiene-coverage-cases.test.ts reads the real file and fails if any
 * of them appears in an `expect(...)` inside the registered case. */
export interface CoverageClassCase {
  /** Workspace-relative path, exactly as vitest's `❯ <file> (N tests | M failed)` header
   *  renders it — that header is what `extractFailingCasesByFile` keys its map by, and the
   *  gate's `failingTests` entries use the same shape. */
  file: string;
  /** Repo-relative path to the SAME file. Only the guard test uses it (to read the file);
   *  matching never does. Its presence is what lets the guard prove the workspace-relative
   *  key above resolves to exactly one real file, closing the ambiguity that two workspaces
   *  could both contain a `lib/…/x.test.ts`. */
  repoPath: string;
  /** The LEAF case name, exactly as vitest's `× <name>` row renders it. NOT the
   *  `describe > describe > it` path: a nested describe is emitted on its own `❯` row and
   *  does not prefix the case name (green-checkpoint.test.ts pins both shapes). */
  caseName: string;
  /** Symbols that would make this case substantive again. Presence of any inside an
   *  `expect(...)` in the registered case is a re-merge and fails the guard. */
  forbiddenSymbols: string[];
  /** Why this case is an instrument claim rather than a system claim. */
  why: string;
}

export const COVERAGE_CLASS_TEST_CASES: readonly CoverageClassCase[] = [
  {
    file: "lib/doc-claims/gate-candidate-ref.test.ts",
    repoPath: "packages/operator-core/lib/doc-claims/gate-candidate-ref.test.ts",
    caseName:
      "detector coverage: still sees both candidate-resolution sites (instrument health, not a system claim)",
    forbiddenSymbols: ["violations", "verdict.ok"],
    why:
      "Asserts the detector can still SEE both candidate-resolution sites. It makes no claim " +
      "about what the gate does — the sibling case 'cuts the candidate from the LOCAL " +
      "integration branch, and never fetches' holds that pin and stays product. On 2026-08-25 " +
      "this case alone failed because green-checkpoint.ts passed 14,500 lines and its calls " +
      "became multi-line: pure measurement drift, which froze every agent's promotions.",
  },
];

export interface ClassifiedGateFailure {
  /** The failing entry exactly as the gate reported it. */
  entry: string;
  klass: GateFailureClass;
  /** Why it landed in that class — always populated, including for `product`, so a
   *  frozen gate can explain itself without a second investigation. */
  reason: string;
  category?: HygieneCategory;
  remedy?: string;
}

export interface HygieneClassificationContext {
  /** The root package.json `scripts` map, passed in rather than read, so this module
   *  stays pure and the pair derivation is testable against synthetic script sets. */
  rootScripts: Record<string, string>;
  /** Failing CASE names attributed to the file they failed in, from the gate's own
   *  `extractFailingCasesByFile`. ABSENT ⇒ every test file classifies product, which is
   *  byte-identical to the behaviour before WI-41765 — the attribution can only ever
   *  ADMIT a file, never hold one it would otherwise have promoted. */
  failingCasesByFile?: ReadonlyMap<string, readonly string[]>;
}

/** `<workspace> :: <script>` → the script half; a bare id → itself; a bare workspace
 *  name → null (a whole workspace failing names no single check and is never hygiene). */
function scriptIdOf(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;

  const scoped = /^(@[^\s]+)\s*::\s*(.+)$/.exec(trimmed);
  if (scoped) return scoped[2].trim() || null;

  // A bare workspace name (`@papercusp/web`) names a whole suite, not a check.
  if (trimmed.startsWith("@")) return null;

  // A path is a test file. Never hygiene — see the header on doc-claims.
  if (trimmed.includes("/")) return null;

  return trimmed;
}

/** The derived half of the hygiene set: `gen:X:check` qualifies only when its `gen:X`
 *  generator also exists. Exported so the guard test can assert the derivation against
 *  the REAL package.json rather than a restated copy of its results. */
export function deriveGeneratedArtifactHygiene(
  rootScripts: Record<string, string>,
): Map<string, string> {
  const derived = new Map<string, string>();
  for (const key of Object.keys(rootScripts ?? {})) {
    const m = /^(gen:.+):check$/.exec(key);
    if (!m) continue;
    const generator = m[1];
    // The pair IS the evidence. A checker with no generator behind it is not a
    // freshness check, whatever it is named.
    if (!(generator in rootScripts)) continue;
    derived.set(key, `npm run ${generator}`);
  }
  return derived;
}

/** The file half of `scriptIdOf`'s `null` branch: the entries that are test-file paths,
 *  as opposed to bare workspaces or unparseable text. Mirrors `scriptIdOf`'s ordering
 *  deliberately — `@papercusp/web` contains a `/` too, and is a whole suite, not a file. */
function testFilePathOf(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("@")) return null;
  if (!trimmed.includes("/")) return null;
  return trimmed;
}

/** WI-41765 / D-010. Admits a failing test FILE as hygiene only when every one of its
 *  failing cases is a registered coverage-class case.
 *
 *  Every early return here is a fall-through to `product`, and each is a distinct way the
 *  evidence could be too weak to promote on:
 *    no attribution map  — the gate did not supply one; cannot know what failed inside.
 *    not a file path     — a bare workspace names a whole suite, never one case.
 *    no parsed cases     — the file failed with no `×` rows we could read (a crash, a
 *                          collection error, a reporter shape we do not parse). A file that
 *                          died before naming a case has NOT shown its failures are benign.
 *    any unregistered    — THE ONE THAT MATTERS: a file whose failing cases are not ALL
 *                          coverage-class stays product, so a substantive red sharing a
 *                          file with a coverage red still holds `main`. */
function classifyCoverageClassFailure(
  entry: string,
  ctx: HygieneClassificationContext,
): ClassifiedGateFailure | null {
  const byFile = ctx.failingCasesByFile;
  if (!byFile) return null;

  const filePath = testFilePathOf(entry);
  if (filePath === null) return null;

  const failingCases = byFile.get(filePath);
  if (!failingCases || failingCases.length === 0) return null;

  const registeredNames = new Set(
    COVERAGE_CLASS_TEST_CASES.filter((c) => c.file === filePath).map((c) => c.caseName),
  );
  if (registeredNames.size === 0) return null;

  const unregistered = failingCases.filter((name) => !registeredNames.has(name));
  if (unregistered.length > 0) return null;

  return {
    entry,
    klass: "hygiene",
    category: "detector-coverage-drift",
    reason:
      `Every failing case in '${filePath}' is a registered coverage-class case ` +
      `(${failingCases.map((n) => `'${n}'`).join(", ")}) — an assertion about whether the ` +
      `detector can still SEE what it measures, not about whether the system is correct.`,
    remedy:
      "Widen the detector to the shape it stopped recognising — never lower the floor it " +
      "asserts. Lowering it converts a loud instrument failure into a quiet false-clean, " +
      "which is strictly worse than the red it removes.",
  };
}

export function classifyGateFailure(
  entry: string,
  ctx: HygieneClassificationContext,
): ClassifiedGateFailure {
  const scriptId = scriptIdOf(entry);

  if (scriptId === null) {
    const coverageClass = classifyCoverageClassFailure(entry, ctx);
    if (coverageClass) return coverageClass;
    return {
      entry,
      klass: "product",
      reason:
        "Not a single named check (a test file, a bare workspace, or unparseable). " +
        "Fails closed to product.",
    };
  }

  const explicit = EXPLICIT_HYGIENE_GATE_SCRIPTS[scriptId];
  if (explicit) {
    return {
      entry,
      klass: "hygiene",
      reason: `Registered hygiene check (${explicit.category}): ${explicit.why}`,
      category: explicit.category,
      remedy: explicit.remedy,
    };
  }

  const derivedRemedy = deriveGeneratedArtifactHygiene(ctx.rootScripts).get(scriptId);
  if (derivedRemedy) {
    return {
      entry,
      klass: "hygiene",
      reason:
        `Generated-artifact freshness check: both '${scriptId}' and its generator ` +
        `exist in the root package.json, so its whole remedy is to regenerate.`,
      category: "generated-artifact-stale",
      remedy: derivedRemedy,
    };
  }

  return {
    entry,
    klass: "product",
    reason:
      `'${scriptId}' is not a registered or derivable hygiene check. Unknown checks ` +
      `hold the gate — promoting past an unclassified failure is the one error this ` +
      `split must never make.`,
  };
}

export interface PromotionInput {
  /** The gate's failing entries. */
  failures: readonly string[];
  /** Did this run actually RENDER a verdict? A crash/abort produces no verdict at all
   *  (`green: null`), and "no product failures were observed" is then vacuously true —
   *  which would promote a candidate nothing ever judged. Passing `false` here refuses,
   *  so that reading can never be reached through this function. */
  verdictRendered: boolean;
  ctx: HygieneClassificationContext;
}

/** The filing-identity prefix. Lives HERE, in the module with no imports, because both
 *  draft producers need it and the dependency chain runs gate-hygiene-filing →
 *  gate-auto-repair → gate-hygiene-split. Defining it in the filing module and importing
 *  it back would close that chain into a cycle; duplicating the literal in both would put
 *  a second copy of a convention in the tree, which is the drift this repo's derived-truth
 *  rule exists to prevent. One definition, at the base. */
const KEY_PREFIX = "gate-hygiene-unrepaired";

/**
 * Stable filing identity, keyed on the ENTRY alone — never on the verdict, and never on
 * which pass observed it. A re-run that produces a different verdict for the same failing
 * checker must REFRESH the same item, not open a sibling.
 *
 * Deliberately SHARED between the gate's promotion drafts and the repair pass's filings:
 * "gen:contract:check is failing" is ONE condition, whether the gate promoted past it or
 * the repair pass could not fix it. Keying those separately would open two items for one
 * broken checker and split its history exactly when someone is trying to read it.
 */
export function filingConditionKey(entry: string): string {
  return `${KEY_PREFIX}:${entry}`;
}

export interface HygieneWorkItemDraft {
  title: string;
  category: HygieneCategory;
  remedy: string;
  entry: string;
  /**
   * Refresh-not-duplicate identity for `work_items:create { conditionKey }`.
   *
   * REQUIRED, not optional, and that is the point. The gate PUBLISHES these drafts and a
   * caller with harness context files them — green-checkpoint.ts runs live from the staging
   * tree for every co-hosted install, so it must never file work items itself (see
   * scripts/repair-stale-generated-artifacts.ts, which states the same boundary). Without a
   * key, a correct external consumer opens a NEW item on every gate run. A hygiene check
   * stays failing across many runs by definition — that is what makes it hygiene rather
   * than a flake — so an unkeyed draft duplicates hardest in exactly the case it matters.
   */
  conditionKey: string;
}

export interface PromotionDecision {
  promote: boolean;
  reason: string;
  productFailures: ClassifiedGateFailure[];
  hygieneFailures: ClassifiedGateFailure[];
  /** Drafts for the caller to file. Populated whenever hygiene failures exist —
   *  including when promotion is BLOCKED by a product failure, because the hygiene
   *  debt is real either way and dropping it is how a split quietly becomes a
   *  suppression. */
  hygieneWorkItems: HygieneWorkItemDraft[];
}

export function decidePromotion(input: PromotionInput): PromotionDecision {
  const { failures, verdictRendered, ctx } = input;

  const classified = (failures ?? []).map((f) => classifyGateFailure(f, ctx));
  const productFailures = classified.filter((c) => c.klass === "product");
  const hygieneFailures = classified.filter((c) => c.klass === "hygiene");

  const hygieneWorkItems: HygieneWorkItemDraft[] = hygieneFailures.map((h) => ({
    title: `Gate hygiene: ${h.entry} is failing`,
    category: h.category ?? "generated-artifact-stale",
    remedy: h.remedy ?? "",
    entry: h.entry,
    conditionKey: filingConditionKey(h.entry),
  }));

  if (!verdictRendered) {
    return {
      promote: false,
      reason:
        "No verdict was rendered by this run, so there is nothing to promote. An empty " +
        "product-failure list here means 'nothing was measured', not 'nothing failed'.",
      productFailures,
      hygieneFailures,
      hygieneWorkItems,
    };
  }

  if (productFailures.length > 0) {
    return {
      promote: false,
      reason:
        `${productFailures.length} product-correctness failure(s) hold the gate: ` +
        productFailures.map((p) => p.entry).join(", "),
      productFailures,
      hygieneFailures,
      hygieneWorkItems,
    };
  }

  if (hygieneFailures.length > 0) {
    return {
      promote: true,
      reason:
        `Promoting: every failure is hygiene (${hygieneFailures
          .map((h) => h.entry)
          .join(", ")}). ${hygieneWorkItems.length} work item(s) to file. ` +
        `No product-correctness test failed.`,
      productFailures,
      hygieneFailures,
      hygieneWorkItems,
    };
  }

  return {
    promote: true,
    reason: "Promoting: the run rendered a verdict and nothing failed.",
    productFailures,
    hygieneFailures,
    hygieneWorkItems,
  };
}

/** Exact observations at the measured-suite decision boundary, not a new suite run. */
export interface GateSuiteDecisionInput {
  green: boolean | null;
  infraFault: boolean;
  failures: string[];
  rootScripts: Record<string, string> | null;
  failingCasesByFile: Array<[string, string[]]> | null;
}

export interface GateSuiteDecisionSignature {
  disposition: 'green' | 'hygiene-green' | 'red' | 'inconclusive';
  productFailures: string[];
  hygieneFailures: string[];
  hygieneConditionKeys: string[];
}

export interface GateSuiteVerdictReplay {
  version: 1;
  candidate: string;
  runId: string | null;
  measuredAtMs: number;
  input: GateSuiteDecisionInput;
  expected: GateSuiteDecisionSignature;
  /** Ordered observations of the actual downstream decisions. Absent on legacy captures. */
  decisions?: GateDecisionReplay[];
  /** False for selective-repair/queue decisions that rendered without a canonical suite. */
  suiteMeasured?: boolean;
}

export interface GateDecisionReplay {
  kind: string;
  args: unknown[];
  expected: unknown;
}

export function gateActionBlocks(action: 'pass' | 'warn' | 'block' | null): boolean {
  return action === 'block';
}

export function gateVerdictAppliesToHead(actualHead: string, measuredHead: string): boolean {
  return actualHead === measuredHead;
}

/** JSONB may reorder keys. Compare meaning, not serialization order or display copy. */
export function gateReplayCanonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(gateReplayCanonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value)
    .filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ':' + gateReplayCanonical(v)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}

export function gateDecisionSignature(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const { summary: _summary, replay: _replay, ...signature } = value as Record<string, unknown>;
  return signature;
}

/** Copy the exact IO observations/clock before another retry can mutate them. */
export function captureGateDecisionReplay(kind: string, args: unknown[], output: unknown): GateDecisionReplay {
  return JSON.parse(JSON.stringify({ kind, args, expected: gateDecisionSignature(output) })) as GateDecisionReplay;
}

/** A narrowly scoped v1 replay-shape transition for one measured decision. */
export interface GateReplayDecisionFieldAddition {
  candidate: string;
  runId: string;
  measuredAtMs: number;
  decisionIndex: number;
  decisionKind: string;
  fields: readonly { path: readonly (string | number)[] }[];
}

interface GateReplayBaselineTransitionBase {
  decisionRef: string;
  reason: string;
}

/** Explicit, source-reviewed transition. The usual form pins complete canonical snapshots.
 * The field-addition form is event-bound and accepts only when the same suite, every decision
 * input, every other decision, and every other output field reproduce exactly. It preserves the
 * append-only measurement while permitting reviewed additive projections on that exact row. */
export type GateReplayBaselineTransition =
  | (GateReplayBaselineTransitionBase & { previous: string; accepted: string; fieldAddition?: never })
  | (GateReplayBaselineTransitionBase & { fieldAddition: GateReplayDecisionFieldAddition; previous?: never; accepted?: never });

export const GATE_REPLAY_BASELINE_TRANSITIONS: readonly GateReplayBaselineTransition[] = Object.freeze([
  {
    decisionRef: 'green-main-cycle-time-2026-10-08#D-005',
    reason: 'P-014 added measured repair-leg output and round failure identities; preserve only pipeline_events row 695659 and its unchanged frozen-repair decision.',
    fieldAddition: {
      candidate: '0e2f2291d5778a59fd18c5f0ef29f76b2ed7ae0e',
      runId: 'd30e00ab-fe0c-4999-9f5d-bdcd4a717027',
      measuredAtMs: 1792076057300,
      decisionIndex: 5,
      decisionKind: 'frozen-repair-red',
      fields: [
        { path: ['legs'] },
        { path: ['convergenceRounds', 1, 'failingTests'] },
      ],
    },
  },
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwnReplayPath(value: unknown, path: readonly (string | number)[]): boolean {
  if (path.length === 0) return false;
  let current: unknown = value;
  for (const part of path) {
    if (Array.isArray(current)) {
      if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || !Object.hasOwn(current, part)) return false;
      current = current[part];
    } else if (isRecord(current)) {
      if (typeof part !== 'string' || !Object.hasOwn(current, part)) return false;
      current = current[part];
    } else return false;
  }
  return current !== undefined;
}

function deleteReplayPath(value: unknown, path: readonly (string | number)[]): boolean {
  if (path.length === 0 || typeof path[path.length - 1] !== 'string') return false;
  let parent: unknown = value;
  for (const part of path.slice(0, -1)) {
    if (Array.isArray(parent)) {
      if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || !Object.hasOwn(parent, part)) return false;
      parent = parent[part];
    } else if (isRecord(parent)) {
      if (typeof part !== 'string' || !Object.hasOwn(parent, part)) return false;
      parent = parent[part];
    } else return false;
  }
  const field = path[path.length - 1] as string;
  if (!isRecord(parent) || !Object.hasOwn(parent, field)) return false;
  delete parent[field];
  return true;
}

function acceptsEventBoundFieldAddition(previous: unknown, accepted: unknown,
  addition: GateReplayDecisionFieldAddition): boolean {
  if (!isRecord(previous) || !isRecord(accepted) || previous.version !== 1 || accepted.version !== 1 ||
    previous.candidate !== addition.candidate || accepted.candidate !== addition.candidate ||
    previous.runId !== addition.runId || accepted.runId !== addition.runId ||
    previous.measuredAtMs !== addition.measuredAtMs || accepted.measuredAtMs !== addition.measuredAtMs ||
    !Array.isArray(previous.decisions) || !Array.isArray(accepted.decisions) ||
    previous.decisions.length !== accepted.decisions.length ||
    !Number.isInteger(addition.decisionIndex) || addition.decisionIndex < 0 ||
    addition.decisionIndex >= previous.decisions.length) return false;

  const previousBase = { ...previous, expected: undefined, decisions: undefined };
  const acceptedBase = { ...accepted, expected: undefined, decisions: undefined };
  if (gateReplayCanonical(previousBase) !== gateReplayCanonical(acceptedBase) ||
    gateReplayCanonical(previous.expected) !== gateReplayCanonical(accepted.expected)) return false;

  if (addition.fields.length === 0) return false;
  const paths = addition.fields.map(({ path }) => path);
  const pathKeys = paths.map((path) => JSON.stringify(path));
  if (paths.some((path, index) => path.length === 0 || pathKeys.indexOf(pathKeys[index] as string) !== index)) return false;
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const a = paths[left] as readonly (string | number)[];
      const b = paths[right] as readonly (string | number)[];
      const shorter = a.length <= b.length ? a : b;
      const longer = a.length <= b.length ? b : a;
      if (shorter.every((part, index) => part === longer[index])) return false;
    }
  }

  for (let index = 0; index < previous.decisions.length; index++) {
    const before = previous.decisions[index];
    const after = accepted.decisions[index];
    if (!isRecord(before) || !isRecord(after)) return false;
    if (index !== addition.decisionIndex) {
      if (gateReplayCanonical(before) !== gateReplayCanonical(after)) return false;
      continue;
    }
    if (before.kind !== addition.decisionKind || after.kind !== addition.decisionKind ||
      !Array.isArray(before.args) || !Array.isArray(after.args) ||
      gateReplayCanonical(before.args) !== gateReplayCanonical(after.args) ||
      !isRecord(before.expected) || !isRecord(after.expected)) return false;
    let acceptedWithoutFields: unknown;
    try {
      acceptedWithoutFields = JSON.parse(JSON.stringify(after.expected)) as unknown;
    } catch {
      return false;
    }
    for (const path of paths) {
      if (hasOwnReplayPath(before.expected, path) || !hasOwnReplayPath(after.expected, path) ||
        !deleteReplayPath(acceptedWithoutFields, path)) return false;
    }
    if (gateReplayCanonical(before.expected) !== gateReplayCanonical(acceptedWithoutFields)) return false;
  }
  return true;
}

export function acceptedGateReplayTransition(previous: unknown, accepted: unknown,
  transitions: readonly GateReplayBaselineTransition[] = GATE_REPLAY_BASELINE_TRANSITIONS): string | null {
  const from = gateReplayCanonical(previous), to = gateReplayCanonical(accepted);
  for (const transition of transitions) {
    if (!/^[-a-z0-9]+#D-\d+$/.test(transition.decisionRef) || !transition.reason.trim()) continue;
    if ('fieldAddition' in transition && transition.fieldAddition !== undefined) {
      if (acceptsEventBoundFieldAddition(previous, accepted, transition.fieldAddition)) return transition.decisionRef;
      continue;
    }
    if (!('previous' in transition) || !('accepted' in transition)) continue;
    if (transition.previous !== transition.accepted && transition.previous === from && transition.accepted === to) {
      return transition.decisionRef;
    }
  }
  return null;
}

/** Shared by the real gate and replay. Preserve the existing four fail-closed axes. */
export function decideGateSuite(input: GateSuiteDecisionInput): {
  hygieneSplit: PromotionDecision | null;
  signature: GateSuiteDecisionSignature;
} {
  const hygieneSplit = input.green === false && !input.infraFault &&
    input.failures.length > 0 && input.rootScripts !== null
    ? decidePromotion({ failures: input.failures, verdictRendered: true, ctx: {
        rootScripts: input.rootScripts,
        ...(input.failingCasesByFile === null ? {} : {
          failingCasesByFile: new Map(input.failingCasesByFile),
        }),
      } })
    : null;
  return { hygieneSplit, signature: {
    disposition: input.green === true ? 'green' : hygieneSplit?.promote ? 'hygiene-green'
      : input.infraFault ? 'inconclusive' : 'red',
    productFailures: (hygieneSplit?.productFailures.map(f => f.entry) ?? []).sort(),
    hygieneFailures: (hygieneSplit?.hygieneFailures.map(f => f.entry) ?? []).sort(),
    hygieneConditionKeys: (hygieneSplit?.hygieneWorkItems.map(f => f.conditionKey) ?? []).sort(),
  } };
}

/** Copy every input so later retries/mutations cannot rewrite the historical measurement. */
export function captureGateSuiteVerdictReplay(
  identity: Pick<GateSuiteVerdictReplay, 'candidate' | 'runId' | 'measuredAtMs'>,
  input: GateSuiteDecisionInput,
): GateSuiteVerdictReplay {
  const copied: GateSuiteDecisionInput = { ...input, failures: [...input.failures],
    rootScripts: input.rootScripts === null ? null : { ...input.rootScripts },
    failingCasesByFile: input.failingCasesByFile === null ? null
      : input.failingCasesByFile.map(([file, cases]) => [file, [...cases]]),
  };
  return { version: 1, ...identity, input: copied, expected: decideGateSuite(copied).signature, decisions: [] };
}

/** JSON/version boundary: malformed history must not be mistaken for a bootstrap. */
export function parseGateSuiteVerdictReplay(value: unknown): GateSuiteVerdictReplay | null {
  const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
  if (!object(value) || value.version !== 1 || typeof value.candidate !== 'string' || !value.candidate ||
    !(value.runId === null || typeof value.runId === 'string') || typeof value.measuredAtMs !== 'number' ||
    !Number.isFinite(value.measuredAtMs) || value.measuredAtMs < 0 || !object(value.input) || !object(value.expected)) return null;
  const { input, expected } = value;
  if (!(input.green === null || typeof input.green === 'boolean') || typeof input.infraFault !== 'boolean' ||
    !strings(input.failures) || !(input.rootScripts === null || (object(input.rootScripts) &&
      Object.values(input.rootScripts).every(v => typeof v === 'string'))) ||
    !(input.failingCasesByFile === null || (Array.isArray(input.failingCasesByFile) && input.failingCasesByFile.every(
      row => Array.isArray(row) && row.length === 2 && typeof row[0] === 'string' && strings(row[1])))) ||
    !['green', 'hygiene-green', 'red', 'inconclusive'].includes(String(expected.disposition)) ||
    !strings(expected.productFailures) || !strings(expected.hygieneFailures) || !strings(expected.hygieneConditionKeys) ||
    !(value.suiteMeasured === undefined || typeof value.suiteMeasured === 'boolean') ||
    !(value.decisions === undefined || (Array.isArray(value.decisions) && value.decisions.every(d =>
      object(d) && typeof d.kind === 'string' && d.kind.length > 0 && Array.isArray(d.args) &&
      Object.hasOwn(d, 'expected'))))) return null;
  return value as unknown as GateSuiteVerdictReplay;
}

/** Re-evaluate old observations with CURRENT decision code. No tests, writes, or promotion. */
export function checkGateSuiteVerdictReplay(replay: GateSuiteVerdictReplay): { ok: boolean; detail: string } {
  const current = decideGateSuite(replay.input).signature;
  const changes = (Object.keys(current) as Array<keyof GateSuiteDecisionSignature>)
    .filter(key => JSON.stringify(current[key]) !== JSON.stringify(replay.expected[key]));
  return changes.length === 0
    ? { ok: true, detail: `measured suite verdict reproduced for ${replay.candidate} (${current.disposition})` }
    : { ok: false, detail: `measured suite verdict changed for ${replay.candidate}: ${changes.join(', ')} ` +
        `(was ${replay.expected.disposition}, now ${current.disposition})` };
}
