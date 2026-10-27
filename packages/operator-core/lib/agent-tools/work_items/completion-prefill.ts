/**
 * P-008 / R-7 (plan derived-status-not-hand-written-2026-10-12): `work_items:complete`
 * fills ABSENT `testsRun`, `testResult` and `filesChanged` from the ledgers instead of
 * asking the agent to retype what the system already recorded.
 *
 * The values come from the same read-time mechanics section `work_items:get` shows
 * (`_mechanics.ts`, D-004): the holder's recorded edits since the claim, and the latest
 * `test_runs` row per related test file. Mutation-probe rows are already excluded there,
 * so a deliberate mutant FAIL can never become a prefilled `testResult`.
 *
 * Three rules, each pinned by `completion-prefill.test.ts`:
 *   1. A field is filled only when the caller supplied no value for it, in either the
 *      canonical `verification` object or a legacy top-level alias. A supplied value is
 *      never overwritten, even an empty-looking one that still carries text.
 *   2. Every filled field is DISCLOSED in the returned `CompletionPrefill`, which the tool
 *      echoes as `completionPrefill`. Nothing is filled silently.
 *   3. The attribution limit travels with the value: test_runs has no owner column, so a
 *      prefilled test result says it was matched by path and claim window, not that the
 *      holder ran it, and a failing run is reported as failing.
 */
import type { WorkItemMechanics } from './_mechanics';

export type PrefillableField = 'filesChanged' | 'testsRun' | 'testResult';

export interface CompletionPrefill {
  /**
   * The fields this close filled, in fixed order. Empty only when `skipped` is the whole
   * disclosure (a field the ledger could have filled was deliberately left alone).
   */
  fields: PrefillableField[];
  source: 'read-time-mechanics';
  attribution: 'path-and-claim-window';
  /** Set when filesChanged was filled from a capped list: listed < total. */
  filesChangedTruncated?: { listed: number; total: number };
  /** The verdict behind a prefilled testResult. */
  testVerdict?: 'all-pass' | 'all-skipped' | 'failing';
  /** Fields the ledger had values for that this close deliberately did not fill. */
  skipped?: Array<{ field: PrefillableField; reason: string; ledgerPaths: number }>;
  note: string;
}

export interface CompletionPrefillOptions {
  /**
   * EI-27112155694647220: leave filesChanged as supplied. Set when the close declares the
   * `no-code-change` kind, whose proof IS an empty filesChanged list: the claim-window ledger
   * attributes every file the holder edited (for any item it holds) to this one, so filling
   * it would turn the kind's own proof into a refusal. The skip is disclosed in `skipped`.
   */
  skipFilesChanged?: { reason: string };
}

type EvidenceShape = {
  filesChanged?: unknown;
  testsRun?: unknown;
  testResult?: unknown;
  tests?: unknown;
  verification?: unknown;
};

export const NO_CODE_CHANGE_PREFILL_SKIP_REASON =
  "the close declares change kind 'no-code-change', whose proof is an empty filesChanged list; " +
  "the claim-window ledger counts the holder's edits for every item it holds, not only this one";

/**
 * EI-27112155694647220: the prefill options for a close, from its EFFECTIVE change kinds,
 * resolved the way the change-kind gate resolves them: the kinds declared at close, else the
 * stored declaration. `readStored` is only called when nothing was declared at close; a read
 * error resolves to no kinds, which keeps the ordinary fill.
 */
export async function prefillOptionsForDeclaredKinds(input: {
  declaredAtClose: readonly string[] | null | undefined;
  readStored: () => Promise<readonly string[] | null | undefined>;
}): Promise<CompletionPrefillOptions> {
  const kinds = input.declaredAtClose?.length
    ? input.declaredAtClose
    : await input.readStored().catch(() => null);
  return kinds?.includes('no-code-change') ? { skipFilesChanged: { reason: NO_CODE_CHANGE_PREFILL_SKIP_REASON } } : {};
}

function hasText(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

function hasList(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0;
}

/** True when the caller supplied a value for `field`, nested or as a legacy alias. */
export function completionSuppliesField(input: object, field: PrefillableField): boolean {
  const completion = input as EvidenceShape;
  const nested = (completion.verification && typeof completion.verification === 'object'
    ? completion.verification
    : {}) as EvidenceShape;
  if (field === 'filesChanged') return hasList(nested.filesChanged) || hasList(completion.filesChanged);
  if (field === 'testsRun')
    return hasText(nested.testsRun) || hasText(completion.testsRun) || hasText(completion.tests);
  return hasText(nested.testResult) || hasText(completion.testResult);
}

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 10) : 'unknown-commit';
}

function describeRun(r: WorkItemMechanics['tests']['latest'][number]): string {
  const counts =
    r.passed !== null || r.failed !== null
      ? ` (${r.passed ?? 0} passed${r.failed ? `, ${r.failed} failed` : ''})`
      : '';
  return `${r.file}: ${r.status}${counts} @ ${shortSha(r.commitSha)}${r.dirtyTree ? '+dirty' : ''}${r.at ? ` ${r.at}` : ''}`;
}

/**
 * Pure: returns a copy of `completion` with absent fields filled from `mechanics`, plus
 * the disclosure. Returns `prefill: null` and the input unchanged when nothing was filled.
 */
export function prefillCompletionFromMechanics<C extends object>(
  completion: C,
  mechanics: WorkItemMechanics | null | undefined,
  options: CompletionPrefillOptions = {},
): { completion: C; prefill: CompletionPrefill | null } {
  if (!mechanics) return { completion, prefill: null };

  const fill: { filesChanged?: string[]; testsRun?: string; testResult?: string } = {};
  const fields: PrefillableField[] = [];
  const skipped: NonNullable<CompletionPrefill['skipped']> = [];
  let filesChangedTruncated: CompletionPrefill['filesChangedTruncated'];
  let testVerdict: CompletionPrefill['testVerdict'];

  const written = mechanics.filesWritten;
  if (!completionSuppliesField(completion, 'filesChanged') && written.paths.length > 0) {
    if (options.skipFilesChanged) {
      skipped.push({ field: 'filesChanged', reason: options.skipFilesChanged.reason, ledgerPaths: written.total });
    } else {
      fill.filesChanged = [...written.paths];
      fields.push('filesChanged');
      if (written.truncated) filesChangedTruncated = { listed: written.paths.length, total: written.total };
    }
  }

  const latest = mechanics.tests.latest;
  if (latest.length > 0 && mechanics.tests.verdict !== 'none') {
    if (!completionSuppliesField(completion, 'testsRun')) {
      fill.testsRun =
        `test_runs ledger, ${latest.length} related file(s) since the claim: ` +
        latest.map((r) => r.file).join(', ');
      fields.push('testsRun');
    }
    if (!completionSuppliesField(completion, 'testResult')) {
      testVerdict = mechanics.tests.verdict;
      fill.testResult =
        `${
          testVerdict === 'all-pass'
            ? 'all passing'
            : testVerdict === 'all-skipped'
              ? 'NOT RUN — every related run was skipped; none passed'
              : 'FAILING'
        } — ` +
        latest.map(describeRun).join('; ') +
        ' (matched by path and claim window; not proof the holder ran them)';
      fields.push('testResult');
    }
  }

  if (fields.length === 0 && skipped.length === 0) return { completion, prefill: null };

  const supplied = (completion as EvidenceShape).verification;
  const existingVerification =
    supplied && typeof supplied === 'object' ? (supplied as Record<string, unknown>) : {};
  const next =
    fields.length > 0 ? ({ ...completion, verification: { ...existingVerification, ...fill } } as C) : completion;

  const notes: string[] = [];
  if (fields.length > 0) {
    notes.push(
      `Filled ${fields.join(', ')} from the ledgers because the completion omitted them. ` +
        'Supplied values are never overwritten; pass the field explicitly to replace a prefilled value.',
    );
  }
  for (const s of skipped) {
    notes.push(`Did not fill ${s.field} (${s.ledgerPaths} path(s) in the claim window): ${s.reason}.`);
  }

  return {
    completion: next,
    prefill: {
      fields,
      source: 'read-time-mechanics',
      attribution: 'path-and-claim-window',
      ...(filesChangedTruncated ? { filesChangedTruncated } : {}),
      ...(testVerdict ? { testVerdict } : {}),
      ...(skipped.length > 0 ? { skipped } : {}),
      note: notes.join(' '),
    },
  };
}
