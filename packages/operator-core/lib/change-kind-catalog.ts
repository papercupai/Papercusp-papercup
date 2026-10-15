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
