/**
 * The bundled change-kind catalog (plan change-kind-declared-proof-2026-10-15, P-001 / R-1).
 *
 * An agent working a work-item declares which KINDS of change it is making. The system trusts
 * that declaration and, at a successful close, requires the proof each declared kind calls for
 * (P-002). The catalog ships with Papercusp, so no user has to define adapters (owner turn
 * session_turn:claude:ae72b685-aaa1-48a2-b96c-f0568bef8961:15).
 *
 * This module is the single source of truth for the kind names: the declarations table
 * (migration 1518) stores free text and does not repeat this list in a CHECK constraint.
 *
 * Pure data and pure helpers only — no I/O. Storage lives in work-item-change-kinds.ts.
 */
import { z } from 'zod';

export const CHANGE_KINDS = [
  'ui',
  'service',
  'migration',
  'background-job',
  'logic',
  'refactor',
  'docs',
  'config',
  'test-only',
  'no-code-change',
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

/** The work-item steps that accept a declaration. Mirrors the CHECK on migration 1518's `step`. */
export const CHANGE_KIND_STEPS = ['create', 'claim', 'checkpoint', 'complete'] as const;
export type ChangeKindStep = (typeof CHANGE_KIND_STEPS)[number];

export interface ChangeKindSpec {
  kind: ChangeKind;
  /** One line: what changes of this kind look like. Shown to agents choosing a kind. */
  covers: string;
  /** What a successful close must carry for this kind, in plain words. P-002 enforces it. */
  proof: readonly string[];
  /**
   * Relative cost of this kind's proof. Higher is more expensive. Used to tell when a
   * re-declaration swaps an expensive kind for a cheaper one (P-004 requires a reason).
   */
  proofWeight: number;
}

export const CHANGE_KIND_CATALOG: Readonly<Record<ChangeKind, ChangeKindSpec>> = Object.freeze({
  ui: {
    kind: 'ui',
    covers: 'Anything a person sees or interacts with in the running app: screens, components, layout, styling, client state.',
    proof: [
      'a recorded run of the real app (screenshot, DOM or accessibility snapshot) captured by the stack\'s headless tool',
      'proof that the build the run used contained this change',
      'every user-visible state you changed covered by that run',
      'at least one check whose expected value tells the right result apart from a plausible wrong one',
    ],
    proofWeight: 5,
  },
  service: {
    kind: 'service',
    covers: 'Server-side request handling: API routes, tool handlers, RPC endpoints, auth and sync paths.',
    proof: ['a live call against a running build that contains the change, with its response'],
    proofWeight: 4,
  },
  migration: {
    kind: 'migration',
    covers: 'Database schema or data migrations.',
    proof: ['the migration applied to a disposable database, with the resulting schema or rows checked'],
    proofWeight: 4,
  },
  'background-job': {
    kind: 'background-job',
    covers: 'Scheduled routines, workers, queues and other code that runs without a request.',
    proof: ['one run of the job in an isolated runtime, with its observable effect checked'],
    proofWeight: 4,
  },
  logic: {
    kind: 'logic',
    covers: 'Pure or library code whose behavior a test can fully exercise.',
    proof: ['a passing run of tests that exercise the changed behavior'],
    proofWeight: 3,
  },
  // P-004 / R-4 (code-cleanup-campaigns-2026-10-26): heavier than 'logic' so re-declaring a
  // refactor as logic needs a reason. D-006: its proof refuses regardless of the gate cutover.
  refactor: {
    kind: 'refactor',
    covers: 'A behavior-preserving restructure (extract, merge duplicates, rename, move) that must not change what the code does.',
    proof: [
      "passing test_runs rows for the covering test files at the landing change's parent (beforeRuns)",
      'passing rows for exactly the same test files at the landing change (afterRuns), on a clean tree',
      'covering test files (from the coverage map and git) that cover every touched member and are unchanged by the landing change',
      'the targeted finding absent from the detector output after the change',
      'a clean typecheck and lint:behavioural-strands',
    ],
    proofWeight: 4,
  },
  config: {
    kind: 'config',
    covers: 'Configuration, flags, environment or build settings.',
    proof: ['a read-back of the effective value from the program that consumes it'],
    proofWeight: 2,
  },
  'test-only': {
    kind: 'test-only',
    covers: 'Changes to tests and test fixtures only.',
    proof: ['a passing run of the changed tests'],
    proofWeight: 2,
  },
  docs: {
    kind: 'docs',
    covers: 'Documentation, prompts read by people, comments with no behavior change.',
    proof: ['the changed document read back from where readers get it'],
    proofWeight: 1,
  },
  'no-code-change': {
    kind: 'no-code-change',
    covers: 'Investigation, triage or a decision; nothing in a repository changes.',
    proof: ['an empty filesChanged list'],
    proofWeight: 0,
  },
});

const KIND_ORDER: ReadonlyMap<string, number> = new Map(CHANGE_KINDS.map((k, i) => [k, i]));

export function isChangeKind(value: unknown): value is ChangeKind {
  return typeof value === 'string' && KIND_ORDER.has(value);
}

export type NormalizedChangeKinds =
  | { ok: true; kinds: ChangeKind[] }
  | { ok: false; reason: 'empty' | 'unknown-kind'; unknown: string[] };

/**
 * Validate and canonicalize a declared set: trims, de-duplicates and sorts into catalog order,
 * so two declarations of the same set compare equal. An unknown kind or an empty set is refused.
 */
export function normalizeChangeKinds(input: readonly string[]): NormalizedChangeKinds {
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const raw of input) {
    const k = String(raw).trim();
    if (!k) continue;
    if (!isChangeKind(k)) {
      if (!unknown.includes(k)) unknown.push(k);
      continue;
    }
    seen.add(k);
  }
  if (unknown.length > 0) return { ok: false, reason: 'unknown-kind', unknown };
  if (seen.size === 0) return { ok: false, reason: 'empty', unknown: [] };
  const kinds = [...seen].sort((a, b) => KIND_ORDER.get(a)! - KIND_ORDER.get(b)!) as ChangeKind[];
  return { ok: true, kinds };
}

/** Kinds present in `previous` but missing from `next` — a narrowed declaration (P-004). */
export function droppedChangeKinds(
  previous: readonly ChangeKind[] | null | undefined,
  next: readonly ChangeKind[],
): ChangeKind[] {
  if (!previous || previous.length === 0) return [];
  const keep = new Set(next);
  return previous.filter((k) => !keep.has(k));
}

/** Highest proofWeight in a set, or -1 for an empty set. */
export function changeKindsProofWeight(kinds: readonly ChangeKind[]): number {
  return kinds.reduce((max, k) => Math.max(max, CHANGE_KIND_CATALOG[k].proofWeight), -1);
}

/** One-line catalog summary for tool descriptions and refusals. */
export function describeChangeKindCatalog(): string {
  return CHANGE_KINDS.map((k) => `${k} (${CHANGE_KIND_CATALOG[k].covers})`).join('; ');
}

// ── Shared zod arg shapes, so every work_items entry point validates identically ──

export const changeKindsArg = () =>
  z
    .array(z.enum(CHANGE_KINDS))
    .min(1)
    .max(CHANGE_KINDS.length)
    .describe(
      'The kind(s) of change this work makes, from the bundled catalog: ' +
        CHANGE_KINDS.join(', ') +
        '. A successful close must carry each kind\'s proof. Re-declaring later keeps the earlier declaration in history.',
    );

export const changeKindReasonArg = () =>
  z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe('Why the declared kinds changed or were first declared late. Stored with the declaration.');

// ── Per-kind proof carried by a close (P-002 / R-2, R-6) ──
//
// `verifiedHow` is one label, so a close covering several kinds carries one entry per kind in
// `completion.kindEvidence`. A single-kind close may keep using the completion's root
// summary/testsRun/testResult/filesChanged; an entry for that kind then adds to (and overrides)
// them. Which fields each kind needs is CHANGE_KIND_CATALOG[kind].proof; change-kind-proof.ts
// checks them. Lives here (zod only) so coord-lifecycle/records.ts can embed it without an
// import cycle through completion-audit.ts.

const nonEmpty = () => z.string().trim().min(1).max(4000);

const testResultPhaseSchema = z
  .object({
    phase: z.enum(['baseline', 'current']),
    testsRun: nonEmpty().describe('The command or probe for this phase.'),
    testResult: nonEmpty().describe('The observed result for this phase.'),
  })
  .strict();

const testResultPhasesSchema = z
  .array(testResultPhaseSchema)
  .min(2)
  .max(10)
  .superRefine((phases, ctx) => {
    const currentCount = phases.filter((phase) => phase.phase === 'current').length;
    if (currentCount !== 1) {
      ctx.addIssue({ code: 'custom', message: 'testResultPhases must contain exactly one current phase.' });
    }
  });

export const ChangeKindEvidenceSchema = z
  .object({
    kind: z.enum(CHANGE_KINDS),
    summary: nonEmpty().optional(),
    testsRun: nonEmpty().optional().describe('The command or probe run for this kind.'),
    testResult: nonEmpty().optional().describe('The current run result. Use testResultPhases when retaining baseline results.'),
    testResultPhases: testResultPhasesSchema
      .optional()
      .describe(
        'Structured test history: at least one baseline phase and exactly one current phase. Only the current phase proves passing behavior; historical baseline failures remain visible without being treated as current failures.',
      ),
    artifacts: z
      .array(nonEmpty())
      .max(50)
      .optional()
      .describe('ui: retained artifact paths or URLs from the real-app run (screenshot, capture, DOM snapshot).'),
    build: nonEmpty()
      .optional()
      .describe(
        'ui/service: the build the run or call used, proving it contained this change — its commit/build sha ' +
          '(for example from /api/health) or a VERIFY_TAURI_ASSERT_SNAPSHOT_CONTAINS check.',
      ),
    states: z
      .array(z.object({ name: nonEmpty(), evidence: nonEmpty() }).strict())
      .max(50)
      .optional()
      .describe('ui: every user-visible state you changed, each with where the run covered it.'),
    distinguishingChecks: z
      .array(
        z
          .object({
            assertion: nonEmpty().describe('What the check asserted.'),
            expected: nonEmpty().describe('The value the right result produces.'),
            plausibleWrong: nonEmpty().describe('The value a plausible wrong result would produce instead.'),
          })
          .strict(),
      )
      .max(20)
      .optional()
      .describe('ui: at least one check whose expected value tells the right result apart from a plausible wrong one.'),
    database: nonEmpty().optional().describe('migration: the disposable database the migration was applied to.'),
    runtime: nonEmpty().optional().describe('background-job: the isolated runtime the job ran in.'),
    readBack: nonEmpty()
      .optional()
      .describe('config: the effective value read back from its consumer. docs: the document read back from where readers get it.'),
    landingCommit: nonEmpty().optional().describe('refactor: the sha of the commit that landed the refactor.'),
    beforeRuns: z
      .array(z.number().int().positive())
      .max(200)
      .optional()
      .describe("refactor: test_runs row ids for the covering test files at the landing change's parent."),
    afterRuns: z
      .array(z.number().int().positive())
      .max(200)
      .optional()
      .describe('refactor: test_runs row ids for exactly the same test files at the landing change.'),
    finding: nonEmpty().optional().describe('refactor: the targeted finding (for example a clone-family key) that must be absent on re-scan.'),
    typecheck: nonEmpty().optional().describe('refactor: the lint:tsc result for the changed files (for example "LINT_TSC_RESULT status=clean").'),
    behaviouralStrands: nonEmpty().optional().describe('refactor: the lint:behavioural-strands result (exit 0, no strands).'),
  })
  .strict();

export type ChangeKindEvidence = z.infer<typeof ChangeKindEvidenceSchema>;

export const kindEvidenceArg = () =>
  z
    .array(ChangeKindEvidenceSchema)
    .min(1)
    .max(CHANGE_KINDS.length)
    .describe(
      'Proof per declared change kind: one { kind, ... } entry each. Required when more than one kind is declared; ' +
        'a single-kind close may use the root summary/testsRun/testResult instead.',
    );
