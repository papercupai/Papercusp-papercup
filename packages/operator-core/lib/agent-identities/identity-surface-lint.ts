/**
 * identity-surface-lint — the SHRINK-ONLY detector over the P-001 inventory
 * (identity-system-everything-migration-2026-10-18 P-005, bar R-16; it lives in
 * operator-core beside the census per plan decision #D-009).
 *
 * THE BASELINE is the checked-in census, `identity-surface-census.generated.json`.
 * A fresh derivation of the tree is compared against it; a POLICED surface that the
 * derivation finds and the baseline does not is a violation: a new behavior-shaping
 * surface was added outside the identity system. Its sole writer
 * (`npm run gen:identity-surface-census`) refuses to write a census that adds one, so
 * regenerating cannot launder growth, and {@link IDENTITY_SURFACE_HIGH_WATER} pins the
 * per-class ceiling in code, so a hand-edited or deleted-and-rebuilt baseline cannot
 * grow either. The ceiling is a RATCHET: when a migration retires surfaces, the test
 * asks for the ceiling to come down to the new count (P-018 drives it to zero).
 *
 * WHAT IS POLICED ({@link isPolicedIdentitySurface}), matching R-16's wording:
 *   flat-role-prompt   every one;
 *   prompt-constant    every one;
 *   injection-hook     kind `context` only (a hook that injects agent-facing text).
 *                      `identity-dispatch` hooks are the identity system's own path;
 *                      `guard` hooks are safety rails (R-11 / P-004 owns their move);
 *                      `plumbing` hooks shape no behavior. All three are recorded in
 *                      the census but are not migration targets, so a baseline that
 *                      counted them could never reach zero;
 *   kernel-splice      every one (a splice couples a flat prompt to kernel prose).
 * A hook whose kind CHANGES into `context` is a new context-injection surface.
 *
 * A MOVE IS NOT GROWTH. A policed surface that disappears and reappears under the same
 * class and the same constant/marker name (or file basename) is paired one-to-one and
 * reported as moved, so a refactor that relocates a legacy constant does not red the
 * gate. Moves never change a count.
 *
 * KNOWN LIMIT: a deliberate hand-edit of the generated file that swaps one policed id
 * for another keeps every count equal and passes. Generated files are not hand-edited
 * here (the census header and the generated-file guard say so); the drift test still
 * pins the file to a fresh derivation.
 */
import { basename } from 'node:path';
import {
  IDENTITY_SURFACE_CENSUS_GENERATOR,
  IDENTITY_SURFACE_CLASSES,
  describeIdentitySurfaceCensusDiff,
  diffIdentitySurfaceCensus,
  type IdentitySurfaceCensus,
  type IdentitySurfaceClass,
  type IdentitySurfaceEntry,
} from './identity-surface-census';

/**
 * The per-class ceiling of POLICED surfaces in the checked-in baseline. Shrink-only:
 * lower a value when a migration retires surfaces; never raise one. Seeded at P-005
 * from the P-001 census (282 surfaces, of which 255 are policed).
 */
export const IDENTITY_SURFACE_HIGH_WATER: Readonly<Record<IdentitySurfaceClass, number>> = Object.freeze({
  'flat-role-prompt': 109,
  'prompt-constant': 90,
  'injection-hook': 28,
  'kernel-splice': 28,
});

/** True when a surface counts against the shrink-only baseline (see the module header). */
export function isPolicedIdentitySurface(e: IdentitySurfaceEntry): boolean {
  if (e.inside === true) return false;
  return e.class !== 'injection-hook' || e.kind === 'context';
}

/** Per-class count of POLICED surfaces. */
export function policedIdentitySurfaceCounts(entries: readonly IdentitySurfaceEntry[]): Record<IdentitySurfaceClass, number> {
  const counts = Object.fromEntries(IDENTITY_SURFACE_CLASSES.map((c) => [c, 0])) as Record<IdentitySurfaceClass, number>;
  for (const e of entries) if (isPolicedIdentitySurface(e)) counts[e.class] += 1;
  return counts;
}

const moveKey = (e: IdentitySurfaceEntry) => `${e.class}\0${e.name ?? basename(e.path)}`;

export interface IdentitySurfaceMove {
  from: IdentitySurfaceEntry;
  to: IdentitySurfaceEntry;
}

export interface IdentitySurfaceCeilingBreach {
  class: IdentitySurfaceClass;
  count: number;
  highWater: number;
}

export interface IdentitySurfaceLintResult {
  /** Policed surfaces in the tree that the baseline lacks, and that no retired surface explains as a move. */
  violations: IdentitySurfaceEntry[];
  /** Policed surfaces that left one place and reappeared under the same class and name. */
  moved: IdentitySurfaceMove[];
  /** Policed baseline surfaces that no longer exist (the shrink). */
  retired: IdentitySurfaceEntry[];
  /** Classes whose policed baseline count exceeds the pinned ceiling. */
  overCeiling: IdentitySurfaceCeilingBreach[];
  /** Policed counts of the baseline. */
  baselineCounts: Record<IdentitySurfaceClass, number>;
}

/** Compare a fresh derivation (`current`) against the checked-in `baseline`. Pure. */
export function lintIdentitySurfaces(
  baseline: Pick<IdentitySurfaceCensus, 'entries'>,
  current: Pick<IdentitySurfaceCensus, 'entries'>,
  highWater: Readonly<Record<IdentitySurfaceClass, number>> = IDENTITY_SURFACE_HIGH_WATER,
): IdentitySurfaceLintResult {
  const before = new Map(baseline.entries.filter(isPolicedIdentitySurface).map((e) => [e.id, e] as const));
  const after = current.entries.filter(isPolicedIdentitySurface);
  const afterIds = new Set(after.map((e) => e.id));

  const pool = new Map<string, IdentitySurfaceEntry[]>();
  for (const gone of [...before.values()].filter((e) => !afterIds.has(e.id))) {
    const k = moveKey(gone);
    pool.set(k, [...(pool.get(k) ?? []), gone]);
  }
  const moved: IdentitySurfaceMove[] = [];
  const violations: IdentitySurfaceEntry[] = [];
  for (const added of after.filter((e) => !before.has(e.id))) {
    const from = pool.get(moveKey(added))?.shift();
    if (from) moved.push({ from, to: added });
    else violations.push(added);
  }

  const baselineCounts = policedIdentitySurfaceCounts(baseline.entries);
  const overCeiling = IDENTITY_SURFACE_CLASSES.filter((c) => baselineCounts[c] > highWater[c]).map((c) => ({
    class: c,
    count: baselineCounts[c],
    highWater: highWater[c],
  }));
  return { violations, moved, retired: [...pool.values()].flat(), overCeiling, baselineCounts };
}

export function identitySurfaceLintFailed(r: IdentitySurfaceLintResult): boolean {
  return r.violations.length > 0 || r.overCeiling.length > 0;
}

/** One line per finding, naming the surface and the remediation. */
export function describeIdentitySurfaceLint(r: IdentitySurfaceLintResult): string[] {
  return [
    ...r.violations.map(
      (e) =>
        `NEW ${e.class} outside the identity system: ${e.id} (${e.kind}). Author it as an identity document ` +
        '(a blueprint declaring `slots:`, or a domain / practice layer) instead — the baseline is shrink-only (R-16).',
    ),
    ...r.overCeiling.map(
      (b) =>
        `baseline GREW: ${b.count} policed ${b.class} surfaces exceed IDENTITY_SURFACE_HIGH_WATER (${b.highWater}). ` +
        'The ceiling is shrink-only; restore the generated inventory instead of raising it.',
    ),
  ];
}

export interface IdentitySurfaceCheckOutcome {
  exitCode: 0 | 1;
  lines: string[];
}

/**
 * The generator's `--check` mode (and `lint:identity-surfaces`): lint first, then drift.
 * Exit 1 on a violation or ceiling breach (R-16), and exit 1 when the checked-in
 * inventory is stale (a retired, moved or reclassified surface awaits regeneration).
 */
export function runIdentitySurfaceCheck(
  baseline: IdentitySurfaceCensus,
  current: IdentitySurfaceCensus,
  highWater: Readonly<Record<IdentitySurfaceClass, number>> = IDENTITY_SURFACE_HIGH_WATER,
): IdentitySurfaceCheckOutcome {
  const lint = lintIdentitySurfaces(baseline, current, highWater);
  if (identitySurfaceLintFailed(lint)) {
    return { exitCode: 1, lines: [`IDENTITY_SURFACE_LINT fail (${lint.violations.length + lint.overCeiling.length})`, ...describeIdentitySurfaceLint(lint)] };
  }
  const drift = describeIdentitySurfaceCensusDiff(diffIdentitySurfaceCensus(baseline, current));
  if (drift.length > 0) {
    return { exitCode: 1, lines: [`IDENTITY_SURFACE_CENSUS drift (${drift.length}) — run: ${IDENTITY_SURFACE_CENSUS_GENERATOR}`, ...drift] };
  }
  return { exitCode: 0, lines: [`IDENTITY_SURFACE_LINT clean: ${current.entries.length} surfaces, policed ${JSON.stringify(lint.baselineCounts)}`] };
}

/**
 * What the generator may write. It refuses a census that adds a policed surface or
 * breaches the ceiling — the inventory's only writer cannot grow the baseline. A
 * missing baseline (first write) is checked against the ceiling alone.
 */
export function planIdentitySurfaceInventoryWrite(
  baseline: IdentitySurfaceCensus | null,
  current: IdentitySurfaceCensus,
  highWater: Readonly<Record<IdentitySurfaceClass, number>> = IDENTITY_SURFACE_HIGH_WATER,
): { ok: true; moved: number; retired: number } | { ok: false; lines: string[] } {
  const lint = lintIdentitySurfaces(baseline ?? current, current, highWater);
  // Without a baseline, the ceiling is judged against what would be written.
  if (identitySurfaceLintFailed(lint)) return { ok: false, lines: describeIdentitySurfaceLint(lint) };
  return { ok: true, moved: lint.moved.length, retired: lint.retired.length };
}
