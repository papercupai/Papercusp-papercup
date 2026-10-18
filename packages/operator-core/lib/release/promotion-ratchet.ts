/**
 * Promotion rule for the green checkpoint (plan green-main-ratchet-convergence-2026-10-17,
 * P-004 / R-3, decisions D-002, D-005, D-006).
 *
 * Every failing test BLOCKS main by default. A failing test is non-blocking only while an
 * ACTIVE downgrade record (harness_shared.test_downgrades, P-002) covers exactly its file and
 * case. The gate promotes a red candidate only when every failure it located is covered.
 *
 * The rule FAILS CLOSED everywhere it cannot prove coverage:
 *   - a failure whose repo path cannot be resolved stays blocking;
 *   - a workspace entry with no per-file failure list (a collection crash, an aborted run)
 *     stays blocking — there is no named test a downgrade could cover;
 *   - a critical-area downgrade without a risk acknowledgement does not count (D-006 is
 *     enforced at creation, and re-checked here so a row written around the verb is inert);
 *   - a case-specific downgrade does not cover a file-level failure (D-005: the case list is
 *     what makes a case downgrade meaningful; until a failing row names its cases, only a
 *     file-level downgrade — `test_case = ''` — covers the file).
 *
 * Pure apart from `readActiveTestDowngradesForGate`, which is the one Postgres read.
 */

import { classifyCriticalArea } from './critical-area-registry';
import { isTestBlocking, pgTestDowngradeStore, type TestDowngradeRecord } from './test-downgrade-store';

/** One failing test file as the gate's runner reports it (workspace-relative path). */
export interface RatchetFailingFile {
  workspace: string;
  file: string;
}

export type RatchetDowngrade = Pick<
  TestDowngradeRecord,
  'testFile' | 'testCase' | 'revokedAt' | 'criticalArea' | 'riskAcknowledgement'
>;

export interface PromotionRatchetInput {
  /** The gate's failing entries: test file paths (bare or `workspace::file`), workspace names
   *  (a workspace's test task failed), and non-test gate leg ids (`lint:tsc`, a build). */
  failingTests: readonly string[];
  /** Per-file failures parsed from the suite output. */
  failingFiles: readonly RatchetFailingFile[];
  /** Downgrade rows read for this harness. Revoked rows are ignored. */
  downgrades: readonly RatchetDowngrade[];
  /** Repo-relative path of a failing file (`packages/x/lib/y.test.ts`), or null when the
   *  owning workspace directory cannot be resolved uniquely. */
  repoPathOf: (file: RatchetFailingFile) => string | null;
  /** P-017 (D-005): the failing case names of a file, parsed from the suite output. When a
   *  file's cases are known, case-level downgrades can cover it (every failing case needs
   *  one). Absent or empty means unknown: only a file-level downgrade covers the file. */
  failingCasesOf?: (file: RatchetFailingFile) => readonly string[] | null | undefined;
}

/**
 * PURE (P-017, D-005): whether usable downgrades cover one failing file. A file-level row
 * (empty case) covers every case. Otherwise each known failing case needs its own row, and a
 * file whose cases are unknown stays blocking — a case-level row cannot cover cases nobody named.
 */
export function failingFileCovered(
  usable: readonly RatchetDowngrade[],
  repoPath: string,
  cases?: readonly string[] | null,
): boolean {
  if (!isTestBlocking(usable, repoPath, '')) return true;
  const named = (cases ?? []).map((c) => c.trim()).filter(Boolean);
  if (named.length === 0) return false;
  return named.every((c) => !isTestBlocking(usable, repoPath, c));
}

export interface PromotionRatchetVerdict {
  /** True only when there was at least one failure and every one is covered. */
  allFailuresDowngraded: boolean;
  /** `failingTests` minus the entries a downgrade covers — what still holds the gate. */
  blockingFailingTests: string[];
  /** Labels of failures that still block (repo path, `workspace::file`, or the entry). */
  blocking: string[];
  /** Labels of failures an active downgrade covers. */
  downgraded: string[];
  /** Downgrade rows ignored because a critical-area row lacks its acknowledgement. */
  ignoredDowngrades: string[];
}

/** Rows that may make a failure non-blocking: active, and acknowledged when critical. */
export function usableDowngrades(downgrades: readonly RatchetDowngrade[]): {
  usable: RatchetDowngrade[];
  ignored: string[];
} {
  const usable: RatchetDowngrade[] = [];
  const ignored: string[] = [];
  for (const row of downgrades) {
    if (row.revokedAt !== null) continue;
    const area = classifyCriticalArea(row.testFile);
    if (area && !(row.riskAcknowledgement ?? '').trim()) {
      ignored.push(row.testCase ? `${row.testFile} > ${row.testCase}` : row.testFile);
      continue;
    }
    usable.push(row);
  }
  return { usable, ignored };
}

export function decidePromotionRatchet(input: PromotionRatchetInput): PromotionRatchetVerdict {
  const { usable, ignored } = usableDowngrades(input.downgrades);
  const covered = (testFile: string) => !isTestBlocking(usable, testFile, '');

  // Per-file status, addressable by every spelling a failingTests entry may use.
  const fileStatus = new Map<string, boolean>();
  const filesByWorkspace = new Map<string, boolean[]>();
  const blocking: string[] = [];
  const downgraded: string[] = [];
  for (const f of input.failingFiles) {
    const repoPath = input.repoPathOf(f);
    const isCovered = repoPath !== null && failingFileCovered(usable, repoPath, input.failingCasesOf?.(f));
    const label = repoPath ?? `${f.workspace}::${f.file}`;
    (isCovered ? downgraded : blocking).push(label);
    fileStatus.set(f.file, isCovered && (fileStatus.get(f.file) ?? true));
    fileStatus.set(`${f.workspace}::${f.file}`, isCovered);
    if (repoPath) fileStatus.set(repoPath, isCovered);
    const list = filesByWorkspace.get(f.workspace) ?? [];
    list.push(isCovered);
    filesByWorkspace.set(f.workspace, list);
  }

  const blockingFailingTests: string[] = [];
  for (const entry of input.failingTests) {
    const known = fileStatus.get(entry);
    if (known !== undefined) {
      if (!known) blockingFailingTests.push(entry);
      continue;
    }
    const wsFiles = filesByWorkspace.get(entry);
    if (wsFiles) {
      if (!wsFiles.every(Boolean)) blockingFailingTests.push(entry);
      continue;
    }
    // A gate leg id (lint:tsc, a build) or an entry with no per-file evidence: covered only
    // by a downgrade naming exactly that entry. A workspace name never reaches here with
    // files attached, so a bare workspace failure without a per-file list stays blocking
    // unless someone downgraded that exact entry.
    if (covered(entry)) downgraded.push(entry);
    else {
      blockingFailingTests.push(entry);
      blocking.push(entry);
    }
  }

  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const blockingLabels = uniq(blocking);
  return {
    allFailuresDowngraded:
      (input.failingTests.length > 0 || input.failingFiles.length > 0) &&
      blockingFailingTests.length === 0 &&
      blockingLabels.length === 0,
    blockingFailingTests,
    blocking: blockingLabels,
    downgraded: uniq(downgraded),
    ignoredDowngrades: uniq(ignored),
  };
}

/**
 * The downgrade evidence the frozen repair-head verification needs, as plain data: it is
 * recorded with the decision's inputs for replay, so it cannot be a closure.
 */
export interface RepairDowngradeCoverage {
  downgrades: RatchetDowngrade[];
  /** npm workspace name → repo-relative directory (`@papercusp/ui` → `packages/ui`). */
  dirByWorkspace: Record<string, string>;
}

/**
 * Whether a failing file at the repair head is non-blocking under the same rule as
 * `decidePromotionRatchet`: an active, acknowledged-if-critical, file-level downgrade on its
 * repo path. Absent coverage, or a workspace with no known directory, covers nothing.
 */
export function makeDowngradeCoverage(
  coverage: RepairDowngradeCoverage | null | undefined,
): (file: RatchetFailingFile, cases?: readonly string[] | null) => boolean {
  if (!coverage || coverage.downgrades.length === 0) return () => false;
  const { usable } = usableDowngrades(coverage.downgrades);
  return (file, cases) => {
    const dir = coverage.dirByWorkspace[file.workspace];
    if (!dir) return false;
    return failingFileCovered(usable, `${dir.replace(/\/+$/, '')}/${file.file}`, cases);
  };
}

/** What the gate records in gate_health.promotionRatchet (R-3). */
export interface PromotionRatchetHealth {
  /** False when the downgrade read failed: the red verdict was kept (fail closed). */
  measured: boolean;
  blockingFailureCount: number;
  downgradedFailingCount: number;
  /** Bounded samples for a reader; the counts are the totals. */
  blocking: string[];
  downgraded: string[];
  ignoredDowngrades: string[];
  promotedBecauseAllDowngraded: boolean;
  error?: string;
}

const SAMPLE = 20;

export function promotionRatchetHealth(verdict: PromotionRatchetVerdict): PromotionRatchetHealth {
  return {
    measured: true,
    blockingFailureCount: verdict.blocking.length,
    downgradedFailingCount: verdict.downgraded.length,
    blocking: verdict.blocking.slice(0, SAMPLE),
    downgraded: verdict.downgraded.slice(0, SAMPLE),
    ignoredDowngrades: verdict.ignoredDowngrades.slice(0, SAMPLE),
    promotedBecauseAllDowngraded: verdict.allFailuresDowngraded,
  };
}

/** The health record for a run whose suite had no failures at all. */
export function cleanPromotionRatchetHealth(): PromotionRatchetHealth {
  return {
    measured: true,
    blockingFailureCount: 0,
    downgradedFailingCount: 0,
    blocking: [],
    downgraded: [],
    ignoredDowngrades: [],
    promotedBecauseAllDowngraded: false,
  };
}

/** The health record when the downgrade read failed and the red verdict was kept. */
export function unmeasuredPromotionRatchetHealth(error: string, blockingEntries: readonly string[]): PromotionRatchetHealth {
  return {
    measured: false,
    blockingFailureCount: blockingEntries.length,
    downgradedFailingCount: 0,
    blocking: [...blockingEntries].slice(0, SAMPLE),
    downgraded: [],
    ignoredDowngrades: [],
    promotedBecauseAllDowngraded: false,
    error: error.slice(0, 300),
  };
}

/** Parse a persisted record back (gate_health readers); null when the shape is wrong. */
export function parsePromotionRatchetHealth(value: unknown): PromotionRatchetHealth | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
  const strs = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, SAMPLE) : []);
  const blockingFailureCount = num(v.blockingFailureCount);
  const downgradedFailingCount = num(v.downgradedFailingCount);
  if (typeof v.measured !== 'boolean' || blockingFailureCount === null || downgradedFailingCount === null) return null;
  return {
    measured: v.measured,
    blockingFailureCount,
    downgradedFailingCount,
    blocking: strs(v.blocking),
    downgraded: strs(v.downgraded),
    ignoredDowngrades: strs(v.ignoredDowngrades),
    promotedBecauseAllDowngraded: v.promotedBecauseAllDowngraded === true,
    ...(typeof v.error === 'string' ? { error: v.error.slice(0, 300) } : {}),
  };
}

/** The one Postgres read: active downgrades for the gate's install. */
export async function readActiveTestDowngradesForGate(target: {
  workspaceId: string;
  installSlug: string;
}): Promise<TestDowngradeRecord[]> {
  const { getOrgPg } = await import('@papercusp/db-org');
  return pgTestDowngradeStore(getOrgPg().sql, {
    workspaceId: target.workspaceId,
    harnessSlug: target.installSlug,
  }).listActive();
}
