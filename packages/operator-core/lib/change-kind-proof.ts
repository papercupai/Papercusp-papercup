/**
 * The change-kind close gate (plan change-kind-declared-proof-2026-10-15, P-002 / R-2, R-6).
 *
 * An agent declares which kinds of change its work makes (P-001 stores the declaration). At a
 * successful terminal close, `work_items:complete` asks this module whether the completion
 * carries the proof each declared kind requires. The answer is one of:
 *
 *   - not applicable   — not a successful close, so nothing is checked;
 *   - pass             — every declared kind has its proof;
 *   - warn             — no declaration, but the claim began before the cutover (D-003);
 *   - refuse           — a declaration or a proof is missing (D-001, D-002).
 *
 * The caller turns `refuse` into a stateError: the completion record is kept and returned, the
 * terminal transition is refused, and the item stays open (D-002 — the same behavior as the
 * existing live-drove-ui check).
 *
 * Per-kind checks REUSE the validators in completion-audit.ts rather than restating them:
 * `isBackedLiveDroveUiClaim` + `verifyLiveDroveUiArtifacts` for ui artifacts,
 * `isBackedLiveServiceClaim` for service calls, `TEST_RUNNER_COMMAND_RE` for test runs. The
 * file-reading artifact check and the scratch-retention check are injected (`deps`) so the
 * decision logic stays testable without a filesystem.
 */
import {
  CHANGE_KIND_CATALOG,
  type ChangeKind,
  type ChangeKindEvidence,
} from './change-kind-catalog';
import {
  TEST_RUNNER_COMMAND_RE,
  isBackedLiveDroveUiClaim,
  isBackedLiveServiceClaim,
  touchesLayoutBearingFiles,
  type LiveDroveUiArtifactVerdict,
} from './completion-audit';
import type { CompletionVerificationEvidence } from './coord-lifecycle/records';
import type { ChangeKindsView } from './work-item-change-kinds';
import { renderStackProofGuidance } from './change-kind-stack';

/**
 * D-003: claims that began before this instant and carry no declaration close with a warning
 * instead of a refusal. Every claim at or after it is enforced. A claim whose start is unknown
 * (no takenAt and no createdAt) is treated as pre-cutover: warn, never refuse.
 *
 * PLACEHOLDER until P-002 is live on :3070 (change-kind-declared-proof-2026-10-15#D-008): this
 * value is deliberately later than any realistic release, so the first release is warn-only and
 * a claim taken between this constant and the actual deploy is never refused by code it never
 * saw. At ship it is re-pinned to the actual :3070 release instant of P-002 — that re-pin is
 * what makes D-003's "set to the release time of P-002" true. Tests derive their fixtures from
 * this constant, so moving it never strands them.
 */
export const CHANGE_KIND_GATE_CUTOVER = '2026-10-21T00:00:00.000Z';
const CUTOVER_MS = Date.parse(CHANGE_KIND_GATE_CUTOVER);

/** The root completion fields a single-kind close may use as its proof. */
export interface RootCompletionProof {
  summary?: string;
  testsRun?: string;
  testResult?: string;
  filesChanged?: readonly string[];
  filesDeleted?: readonly string[];
}

export interface ChangeKindProofDeps {
  /** The live-drove-ui artifact reader (verifyLiveDroveUiArtifacts). Omit to skip the file read. */
  verifyUiArtifacts?: (evidence: CompletionVerificationEvidence) => Promise<LiveDroveUiArtifactVerdict>;
  /** Cited ui artifacts that live only in session scratch and so will not survive for review. */
  unretainedUiArtifacts?: (evidence: CompletionVerificationEvidence) => Promise<string[]>;
  /** Repository root used to choose the bundled stack default proof tool. */
  repoRoot?: string | null;
  /** Harness slug used by Papercusp's serving-runtimes route overrides. */
  harnessSlug?: string | null;
  /** Optional maintained current-build test class that overrides the manifest default. */
  testClass?: string | null;
}

export interface ChangeKindMissingProof {
  kind: ChangeKind;
  missing: string[];
  /** The catalog's proof list for this kind, shown so the caller sees the whole requirement. */
  proof: readonly string[];
}

export interface ChangeKindGateInput {
  itemId: string;
  /** Only a successful terminal close is gated; everything else is not applicable. */
  successfulClose: boolean;
  /** Kinds passed on this call (`changeKinds`), already validated by the tool schema. */
  declaredAtClose?: readonly ChangeKind[] | null;
  /** `changeKindReason` passed on this call. */
  declaredReason?: string | null;
  /** The stored declaration and history (readChangeKinds), or null when the read failed. */
  stored: ChangeKindsView | null;
  storedReadError?: string;
  /** When the current claim began (takenAt), falling back to the item's creation time. */
  claimStartedAt?: string | Date | null;
  kindEvidence?: readonly ChangeKindEvidence[] | null;
  root: RootCompletionProof;
}

export type ChangeKindGateResult =
  | { applicable: false }
  | {
      applicable: true;
      outcome: 'pass';
      kinds: ChangeKind[];
      /** R-4: layout-bearing files this close changed without declaring 'ui' — explained by the reason. */
      mismatchFiles?: string[];
    }
  | { applicable: true; outcome: 'warn'; kinds: null; warning: string }
  /**
   * R-4: every declared kind carries its proof, but a kind declared earlier was dropped, or a
   * layout-bearing file changed without 'ui', and no `changeKindReason` explains it. The close
   * lands with authority 'proposed' (out of burn-down); the handler applies that grade.
   */
  | {
      applicable: true;
      outcome: 'propose';
      kinds: ChangeKind[];
      warning: string;
      narrowed: ChangeKind[];
      mismatchFiles: string[];
    }
  | {
      applicable: true;
      outcome: 'refuse';
      kinds: ChangeKind[] | null;
      error: string;
      missing: ChangeKindMissingProof[];
      problems: string[];
    };

// ── evidence helpers ─────────────────────────────────────────────────────────

const trimmed = (v: string | null | undefined): string | undefined => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t ? t : undefined;
};

/** A git/build sha, or the headless runner's snapshot-contains assertion. */
const BUILD_IDENTITY_RE = /\b[0-9a-f]{7,40}\b|\bVERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS\b/i;
/** A test file named directly, for runners the regex above does not list. */
const TEST_FILE_RE = /[\w./-]+\.(?:test|spec)\.[cm]?[jt]sx?\b|[\w./-]*_test\.(?:go|py)\b|\btest_\w+\.py\b/i;
const PASSING_RESULT_RE = /\b(?:pass(?:ed|es|ing)?|green|ok)\b|\b0\s+fail(?:ed|ures?|ing)?\b/i;
const FAILING_RESULT_RE = /\b[1-9]\d*\s+(?:failed|failing|failures?)\b|\bFAIL\b/;
/** The live operator database on this box: a migration applied there is not disposable. */
const LIVE_OPERATOR_DB_RE = /^papercusp$|(?:127\.0\.0\.1|localhost):5432\/papercusp\b/i;
/** The shared operator runtimes: a job run there is not isolated. */
const SHARED_RUNTIME_RE = /(?:127\.0\.0\.1|localhost)?:(?:3070|3170)\b/;

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** The fields one kind is checked against: its entry, plus the root fields for a single-kind close. */
function evidenceFor(
  kind: ChangeKind,
  entry: ChangeKindEvidence | undefined,
  root: RootCompletionProof,
  singleKind: boolean,
): ChangeKindEvidence {
  const base: ChangeKindEvidence = singleKind
    ? {
        kind,
        ...(trimmed(root.summary) ? { summary: trimmed(root.summary)! } : {}),
        ...(trimmed(root.testsRun) ? { testsRun: trimmed(root.testsRun)! } : {}),
        ...(trimmed(root.testResult) ? { testResult: trimmed(root.testResult)! } : {}),
      }
    : { kind };
  return entry ? { ...base, ...stripUndefined(entry) } : base;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function citesPassingTestRun(e: ChangeKindEvidence): string[] {
  const missing: string[] = [];
  const run = e.testsRun ?? '';
  if (!TEST_RUNNER_COMMAND_RE.test(run) && !TEST_FILE_RE.test(run)) {
    missing.push('`testsRun` naming the test command or test files that ran (for example `testing:run { files }`)');
  }
  const result = e.testResult ?? '';
  if (!result) missing.push('`testResult` reporting the run passed');
  else if (FAILING_RESULT_RE.test(result) || !PASSING_RESULT_RE.test(result)) {
    missing.push(`\`testResult\` reporting a passing run (got "${result.slice(0, 120)}")`);
  }
  return missing;
}

function citesBuild(e: ChangeKindEvidence, what: string): string[] {
  if (e.build && BUILD_IDENTITY_RE.test(e.build)) return [];
  return [
    `\`build\` proving the ${what} used a build containing this change — its commit/build sha (for example from ` +
      '/api/health) or a VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS check',
  ];
}

async function checkUi(e: ChangeKindEvidence, root: RootCompletionProof, singleKind: boolean, deps: ChangeKindProofDeps) {
  const missing: string[] = [];
  const uiEvidence: CompletionVerificationEvidence = {
    verifiedHow: 'live-drove-ui',
    ...(e.testsRun ? { testsRun: e.testsRun } : {}),
    ...(e.testResult ? { testResult: e.testResult } : {}),
    filesChanged: [...(e.artifacts ?? []), ...(singleKind ? (root.filesChanged ?? []) : [])],
  };
  // isBackedLiveDroveUiClaim reads `summary`, which the evidence type does not declare.
  const withSummary = { ...uiEvidence, summary: e.summary } as CompletionVerificationEvidence;
  if (!isBackedLiveDroveUiClaim(withSummary)) {
    missing.push(
      'a recorded run of the real app: cite its artifact in `artifacts` (a screenshot/capture path), a ' +
        '`tauri-agent-tools check` run in `testsRun`, or a URL with its HTTP status',
    );
  } else {
    const verdict = deps.verifyUiArtifacts ? await deps.verifyUiArtifacts(withSummary) : null;
    if (verdict && verdict.ok === false) missing.push(`a real-app artifact that holds up — ${verdict.reason}`);
    const unretained = deps.unretainedUiArtifacts ? await deps.unretainedUiArtifacts(withSummary) : [];
    if (unretained.length > 0) {
      missing.push(`retained artifacts — ${unretained.join(', ')} live only in session scratch; copy them to a retained path`);
    }
  }
  missing.push(...citesBuild(e, 'run'));
  if (!e.states?.length) {
    missing.push('`states: [{ name, evidence }]` naming every user-visible state you changed and where the run covered it');
  }
  const checks = e.distinguishingChecks ?? [];
  if (checks.length === 0) {
    missing.push(
      '`distinguishingChecks: [{ assertion, expected, plausibleWrong }]` — at least one check whose expected value ' +
        'tells the right result apart from a plausible wrong one',
    );
  } else if (!checks.some((c) => norm(c.expected) !== norm(c.plausibleWrong))) {
    missing.push('a distinguishing check whose `expected` differs from its `plausibleWrong` (every one given is identical)');
  }
  return missing;
}

function checkService(e: ChangeKindEvidence): string[] {
  const missing: string[] = [];
  const serviceEvidence: CompletionVerificationEvidence = {
    verifiedHow: 'live-service',
    ...(e.testsRun ? { testsRun: e.testsRun } : {}),
    ...(e.testResult ? { testResult: e.testResult } : {}),
  };
  if (!isBackedLiveServiceClaim(serviceEvidence)) {
    missing.push(
      'a live call: `testsRun`/`testResult` naming the service, unit or process called and a falsifiable observation ' +
        '(an HTTP status such as `GET /api/x -> 200`, `MainPID=`, or `ActiveState=`)',
    );
  }
  missing.push(...citesBuild(e, 'call'));
  return missing;
}

function checkMigration(e: ChangeKindEvidence): string[] {
  const missing: string[] = [];
  if (!e.database) missing.push('`database` naming the disposable database the migration was applied to');
  else if (LIVE_OPERATOR_DB_RE.test(e.database.trim())) {
    missing.push(`a disposable database — \`database\` "${e.database}" is the live operator database`);
  }
  if (!e.testsRun) missing.push('`testsRun` with how the migration was applied');
  if (!e.testResult) missing.push('`testResult` with the resulting schema or rows that were checked');
  return missing;
}

function checkBackgroundJob(e: ChangeKindEvidence): string[] {
  const missing: string[] = [];
  if (!e.runtime) missing.push('`runtime` naming the isolated runtime the job ran in');
  else if (SHARED_RUNTIME_RE.test(e.runtime)) {
    missing.push(`an isolated runtime — \`runtime\` "${e.runtime}" is a shared operator`);
  }
  if (!e.testsRun) missing.push('`testsRun` with how the job was run');
  if (!e.testResult) missing.push('`testResult` with the observable effect that was checked');
  return missing;
}

function checkReadBack(e: ChangeKindEvidence, what: string): string[] {
  return e.readBack ? [] : [`\`readBack\` with ${what}`];
}

function checkNoCodeChange(root: RootCompletionProof): string[] {
  const changed = [...(root.filesChanged ?? []), ...(root.filesDeleted ?? [])];
  return changed.length === 0
    ? []
    : [`an empty filesChanged list — this close lists ${changed.length} changed or deleted path(s)`];
}

/** The proof gaps for one kind. Pure apart from the injected artifact readers. */
export async function missingProofForKind(
  kind: ChangeKind,
  entry: ChangeKindEvidence | undefined,
  root: RootCompletionProof,
  singleKind: boolean,
  deps: ChangeKindProofDeps = {},
): Promise<string[]> {
  const e = evidenceFor(kind, entry, root, singleKind);
  let missing: string[] = [];
  switch (kind) {
    case 'ui':
      missing = await checkUi(e, root, singleKind, deps);
      break;
    case 'service':
      missing = checkService(e);
      break;
    case 'migration':
      missing = checkMigration(e);
      break;
    case 'background-job':
      missing = checkBackgroundJob(e);
      break;
    case 'logic':
    case 'test-only':
      missing = citesPassingTestRun(e);
      break;
    case 'config':
      missing = checkReadBack(e, 'the effective value read back from the program that consumes it');
      break;
    case 'docs':
      missing = checkReadBack(e, 'the changed document read back from where readers get it');
      break;
    case 'no-code-change':
      missing = checkNoCodeChange(root);
      break;
  }
  // R-3 makes the default actionable at the exact refusal point. Keep this advisory
  // alongside the missing proof rather than changing the catalog's stable proof list.
  if (missing.length > 0 && (kind === 'ui' || kind === 'background-job')) {
    missing.push(
      await renderStackProofGuidance({
        repoRoot: deps.repoRoot,
        harnessSlug: deps.harnessSlug,
        testClass: deps.testClass,
        kind,
      }),
    );
  }
  return missing;
}

// ── the gate ─────────────────────────────────────────────────────────────────

function claimStartMs(at: string | Date | null | undefined): number | null {
  if (at == null) return null;
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}

/** D-001: was any change kind declared before close (create, claim or checkpoint)? */
function declaredBeforeClose(stored: ChangeKindsView | null): boolean {
  return (stored?.history ?? []).some((h) => h.step !== 'complete');
}

/** D-001: did an earlier close-time declaration already say why it was late? */
function closeReasonOnRecord(stored: ChangeKindsView | null): boolean {
  return (stored?.history ?? []).some((h) => h.step === 'complete' && Boolean(h.reason?.trim()));
}

/**
 * R-4: kinds dropped from an earlier declaration with no reason recorded for the drop. Walks the
 * declaration history oldest-first, then this call's close-time declaration (reasonless here: the
 * caller only asks when this call carries no `changeKindReason`). A drop is explained by a reason
 * on the entry that made it; a kind declared again later is no longer dropped. A reasonless
 * narrowing recorded by an earlier close attempt therefore stays unexplained on the retry.
 */
function unexplainedNarrowing(stored: ChangeKindsView | null, declaredNow: readonly ChangeKind[] | null): ChangeKind[] {
  const steps: Array<{ kinds: readonly ChangeKind[]; reason?: string | null }> = [...(stored?.history ?? [])];
  if (declaredNow) steps.push({ kinds: declaredNow, reason: null });
  const unexplained = new Set<ChangeKind>();
  let previous: ReadonlySet<ChangeKind> | null = null;
  for (const step of steps) {
    const next = new Set<ChangeKind>(step.kinds);
    if (previous && !step.reason?.trim()) {
      for (const kind of previous) if (!next.has(kind)) unexplained.add(kind);
    }
    for (const kind of next) unexplained.delete(kind);
    previous = next;
  }
  return [...unexplained];
}

/** R-4: the layout-bearing files (the existing `geometry-unverified` heuristic) this close changed. */
function layoutBearingFiles(filesChanged: readonly string[] | undefined): string[] {
  return (filesChanged ?? []).filter((file) => touchesLayoutBearingFiles([file]));
}

/** Was this claim taken before the cutover? An unknown start counts as before (no claim recorded). */
export function claimPredatesChangeKindCutover(at: string | Date | null | undefined): boolean {
  const ms = claimStartMs(at);
  return ms === null || ms < CUTOVER_MS;
}

const DECLARE_HINT =
  'Declare them with `changeKinds: [...]` on this call (kinds: ' +
  Object.keys(CHANGE_KIND_CATALOG).join(', ') +
  ') plus `changeKindReason` when it is the first declaration, then send each kind\'s proof.';

function renderRefusal(
  itemId: string,
  kinds: ChangeKind[] | null,
  missing: ChangeKindMissingProof[],
  problems: string[],
): string {
  const lines: string[] = [];
  lines.push(
    kinds
      ? `REJECTED — ${itemId} declares change kind(s) ${kinds.join(', ')}, but this close does not carry the proof they ` +
          'require. The completion is recorded; the item stays open.'
      : `REJECTED — ${itemId} has no change-kind declaration, so this close cannot show the proof its change requires. ` +
          'The completion is recorded; the item stays open.',
  );
  for (const p of problems) lines.push(`- ${p}`);
  for (const m of missing) {
    lines.push(`- ${m.kind}: missing ${m.missing.join('; ')}. Required for ${m.kind}: ${m.proof.join('; ')}.`);
  }
  if (missing.length > 0) {
    lines.push(
      'Send the proof as `completion.kindEvidence: [{ kind, ... }]`, one entry per declared kind (a single-kind ' +
        'close may use the root testsRun/testResult instead). If the declaration is wrong, re-declare with ' +
        '`changeKinds` + `changeKindReason`.',
    );
  }
  return lines.join('\n');
}

/**
 * Decide the change-kind gate for one completion. Pure except for the injected artifact readers.
 * Callers pass only facts they already have: the stored declaration is read once, by the caller.
 */
export async function evaluateChangeKindGate(
  input: ChangeKindGateInput,
  deps: ChangeKindProofDeps = {},
): Promise<ChangeKindGateResult> {
  if (!input.successfulClose) return { applicable: false };

  const declaredNow = input.declaredAtClose?.length ? [...input.declaredAtClose] : null;
  const storedCurrent = input.stored?.current ?? null;
  const kinds = declaredNow ?? storedCurrent;
  const reason = trimmed(input.declaredReason ?? undefined);
  const problems: string[] = [];

  if (!kinds) {
    if (claimPredatesChangeKindCutover(input.claimStartedAt)) {
      const started = claimStartMs(input.claimStartedAt);
      return {
        applicable: true,
        outcome: 'warn',
        kinds: null,
        warning:
          `${input.itemId} closed without a change-kind declaration. Its claim ` +
          (started === null ? 'start is not recorded' : `began ${new Date(started).toISOString()}`) +
          `, before the change-kind gate's cutover (${CHANGE_KIND_GATE_CUTOVER}), so this close is allowed with this ` +
          'warning. Closes of claims taken after the cutover are refused until they declare `changeKinds` and carry ' +
          'each kind\'s proof.' +
          (input.storedReadError ? ` (The stored declaration could not be read: ${input.storedReadError}.)` : ''),
      };
    }
    problems.push(
      input.storedReadError
        ? `the stored declaration could not be read (${input.storedReadError}), and this call declares none. ${DECLARE_HINT}`
        : `no change kind has been declared for this item. ${DECLARE_HINT}`,
    );
    return { applicable: true, outcome: 'refuse', kinds: null, error: renderRefusal(input.itemId, null, [], problems), missing: [], problems };
  }

  // D-001: a declaration that first arrives at close must say why it is late. "Before close" means
  // a create/claim/checkpoint declaration. A close-time declaration is recorded even when that
  // close is refused (completeChangeKindEligibility), so a reasonless refused attempt must not
  // count as an earlier declaration on the retry, or D-001 falls to two calls.
  if (!reason) {
    if (input.storedReadError) {
      if (declaredNow) {
        problems.push(
          `\`changeKindReason\` — the stored declaration could not be read (${input.storedReadError}), so this close ` +
            'cannot confirm an earlier declaration exists; pass a reason with `changeKinds`',
        );
      }
    } else if (!declaredBeforeClose(input.stored) && !closeReasonOnRecord(input.stored)) {
      problems.push(
        '`changeKindReason` — no change kind was declared before close (at create, claim or checkpoint), so the ' +
          'declaration made at close must say why it is late',
      );
    }
  }

  const entries = input.kindEvidence ?? [];
  const declaredSet = new Set<ChangeKind>(kinds);
  const seen = new Set<ChangeKind>();
  for (const entry of entries) {
    if (seen.has(entry.kind)) problems.push(`\`kindEvidence\` has more than one entry for '${entry.kind}'`);
    seen.add(entry.kind);
    if (!declaredSet.has(entry.kind)) {
      problems.push(
        `\`kindEvidence\` carries proof for '${entry.kind}', which is not declared — declare it in \`changeKinds\` or drop the entry`,
      );
    }
  }

  const singleKind = kinds.length === 1;
  const missing: ChangeKindMissingProof[] = [];
  for (const kind of kinds) {
    const entry = entries.find((e) => e.kind === kind);
    const gaps =
      !singleKind && !entry && kind !== 'no-code-change'
        ? [`a \`kindEvidence\` entry for '${kind}' (a multi-kind close carries one entry per declared kind)`]
        : await missingProofForKind(kind, entry, input.root, singleKind, deps);
    if (gaps.length > 0) missing.push({ kind, missing: gaps, proof: CHANGE_KIND_CATALOG[kind].proof });
  }

  if (missing.length === 0 && problems.length === 0) {
    const mismatchFiles = kinds.includes('ui') ? [] : layoutBearingFiles(input.root.filesChanged);
    if (reason) return { applicable: true, outcome: 'pass', kinds, ...(mismatchFiles.length ? { mismatchFiles } : {}) };
    const narrowed = unexplainedNarrowing(input.stored, declaredNow);
    if (narrowed.length === 0 && mismatchFiles.length === 0) return { applicable: true, outcome: 'pass', kinds };
    const why: string[] = [];
    if (narrowed.length) {
      why.push(`it drops ${narrowed.map((k) => `'${k}'`).join(', ')}, declared earlier for this item`);
    }
    if (mismatchFiles.length) {
      why.push(`it changes UI-looking files (${mismatchFiles.slice(0, 3).join(', ')}${mismatchFiles.length > 3 ? ', …' : ''}) without declaring 'ui'`);
    }
    return {
      applicable: true,
      outcome: 'propose',
      kinds,
      narrowed,
      mismatchFiles,
      warning:
        `${input.itemId} landed authority:'proposed' (out of burn-down): ${why.join(', and ')}, and no ` +
        '`changeKindReason` says why. Re-close with a one-line `changeKindReason` (and `changeKinds` if the ' +
        "declared set is wrong — add 'ui' when the change is visible) to count it toward done.",
    };
  }
  return {
    applicable: true,
    outcome: 'refuse',
    kinds,
    error: renderRefusal(input.itemId, kinds, missing, problems),
    missing,
    problems,
  };
}
