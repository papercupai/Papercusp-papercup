/**
 * P-017 (green-main-ratchet-convergence-2026-10-17, D-005 / D-007): case-level failure keys.
 *
 * The frozen repair signature used to key every red on its ENTRY id alone: a test FILE, a
 * workspace task, or a whole gate leg. That made two different failures look identical — a
 * second failing case inside an already-red file, or a new type error inside an already-red
 * `lint:tsc` leg, changed nothing the queue could see, so the admission ratchet (P-006) and
 * the round attribution could not notice that an admission added a failure.
 *
 * This module is the vocabulary the signature uses instead:
 *   - a `test-file` entry carries the failed CASE names it was measured red with, and keys as
 *     `<file> > <case>` per case;
 *   - a `lint-leg` entry carries one key per ERROR, `<file>|<TS code or lint rule>`, parsed from
 *     the leg's own output (`parseLegErrorKeys`);
 *   - an entry with neither keys on its id alone (a collection crash, an unparseable leg). It
 *     covers every case of that entry, so it is never weaker than the old file-level key.
 *
 * PURE: no I/O. The queue module persists the details; the gate supplies them from the runner
 * output it already parses.
 */

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

/** `path(12,5): error TS2322: …` — tsc's default (non-pretty) diagnostic. */
const TSC_PAREN = /^\s*(\S(?:.*?\S)?)\((\d+),(\d+)\):\s+error\s+(TS\d+)\s*:/;
/** `path:12:5 - error TS2322: …` — tsc `--pretty`. */
const TSC_PRETTY = /^\s*(\S(?:.*?\S)?):(\d+):(\d+)\s+-\s+error\s+(TS\d+)\s*:/;
/**
 * The per-file baseline-regression row `scripts/lib/tsc-baseline-gate.mjs` prints on a red
 * baseline-gated leg: `   path/to/file.ts: 12 → 14  (+2)`. It names the file and how many errors
 * the file has above its baseline, but not their codes; each excess error becomes one key.
 */
const TSC_BASELINE_ROW = /^\s*(\S+\.[cm]?[jt]sx?):\s+(\d+)\s*(?:→|->|=>)\s*(\d+)\b/;
/** ESLint stylish: a file header line followed by `  12:5  error  message  rule-name` rows. */
const ESLINT_ROW = /^\s+\d+:\d+\s+error\s+.*?\s{2,}(@?[A-Za-z0-9][\w@/.-]*)\s*$/;
const ESLINT_FILE_HEADER = /^(\/\S+|\.{0,2}\/?[\w@.-][^\s:]*\.[cm]?[jt]sx?)\s*$/;

function normalizePath(path: string): string {
  return path.trim().replace(/^\.\//, '');
}

/** Occurrence-indexed key: the first `file|code` is bare, the k-th repeat is `file|code#k`. */
function pushIndexed(out: string[], counts: Map<string, number>, key: string): void {
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  out.push(n === 1 ? key : `${key}#${n}`);
}

/**
 * PURE: one key per typecheck / lint ERROR in a leg's output, `<file>|<TS code or lint rule>`.
 *
 * Repeats of the same file + code are occurrence-indexed (`#2`, `#3`, …), so a second TS2322 in
 * a file that already had one is a NEW key — the "new error inside an already failing leg" R-14
 * requires detecting. A baseline-regression row contributes one `<file>|tsc-baseline` key per
 * error above its baseline. Output in no recognised format yields `[]`: the caller then keys the
 * leg on its id alone, which is fail-closed (it covers every error) rather than a guess.
 */
export function parseLegErrorKeys(output: string): string[] {
  const out: string[] = [];
  const counts = new Map<string, number>();
  let eslintFile: string | null = null;
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    const tsc = TSC_PAREN.exec(raw) ?? TSC_PRETTY.exec(raw);
    if (tsc) {
      pushIndexed(out, counts, `${normalizePath(tsc[1] as string)}|${tsc[4]}`);
      eslintFile = null;
      continue;
    }
    const baseline = TSC_BASELINE_ROW.exec(raw);
    if (baseline) {
      const excess = Number(baseline[3]) - Number(baseline[2]);
      for (let i = 0; i < excess; i += 1) pushIndexed(out, counts, `${normalizePath(baseline[1] as string)}|tsc-baseline`);
      continue;
    }
    const header = ESLINT_FILE_HEADER.exec(raw);
    if (header) {
      eslintFile = normalizePath(header[1] as string);
      continue;
    }
    const row = eslintFile ? ESLINT_ROW.exec(raw) : null;
    if (row && eslintFile) pushIndexed(out, counts, `${eslintFile}|${row[1]}`);
  }
  return out;
}

/** The fields of a signature entry this module reads. Structural, so the queue module's
 * `RepairSignatureEntry` and plain fixtures both fit. */
export interface CaseKeyedEntry {
  kind: string;
  id: string;
  /** `test-file`: the failed case names this entry was measured red with. */
  cases?: readonly string[];
  /** `lint-leg`: per-error keys from {@link parseLegErrorKeys}. */
  errors?: readonly string[];
}

function detailOf(entry: CaseKeyedEntry): readonly string[] | null {
  const detail = entry.kind === 'test-file' ? entry.cases : entry.kind === 'lint-leg' ? entry.errors : undefined;
  return detail && detail.length > 0 ? detail : null;
}

function keyFor(entry: CaseKeyedEntry, detail: string): string {
  return entry.kind === 'test-file' ? `${entry.id} > ${detail}` : `${entry.id} :: ${detail}`;
}

/** PURE: the case-level keys of ONE entry — per case / per error, or its id when it has none. */
export function entryCaseKeys(entry: CaseKeyedEntry): string[] {
  const detail = detailOf(entry);
  return detail ? [...new Set(detail)].map((d) => keyFor(entry, d)) : [entry.id];
}

/** PURE: the frozen signature's identity at case level — what P-017 keys the signature on. */
export function repairSignatureCaseKeys(signature: readonly CaseKeyedEntry[]): string[] {
  return [...new Set(signature.flatMap(entryCaseKeys))].sort();
}

/**
 * PURE: the case-level keys `next` adds over `prior`, entry by entry (matched on kind + id).
 *  - an entry absent before: every one of its keys is new;
 *  - an entry that was red on its id alone before: nothing is new — a whole-entry red already
 *    covered every case of it;
 *  - an entry that was red with named cases / errors: each key not named before is new, and an
 *    entry now red on its id alone (it crashed where it used to fail case by case) is new too.
 */
export function newRepairSignatureKeys(
  prior: readonly CaseKeyedEntry[],
  next: readonly CaseKeyedEntry[],
): string[] {
  const priorByKey = new Map(prior.map((entry) => [`${entry.kind}:${entry.id}`, entry] as const));
  const out: string[] = [];
  for (const entry of next) {
    const before = priorByKey.get(`${entry.kind}:${entry.id}`);
    if (!before) {
      out.push(...entryCaseKeys(entry));
      continue;
    }
    const priorDetail = detailOf(before);
    if (!priorDetail) continue;
    const detail = detailOf(entry);
    if (!detail) {
      out.push(entry.id);
      continue;
    }
    const known = new Set(priorDetail);
    for (const d of new Set(detail)) if (!known.has(d)) out.push(keyFor(entry, d));
  }
  return out;
}

/**
 * PURE: look up the failed cases recorded for a test-file id. Runner output names a file
 * workspace-relative while the signature may hold it repo-relative (or the reverse), so an exact
 * match wins and otherwise ONE unambiguous path-suffix match is accepted; two candidates mean
 * the pairing is unknown and nothing is attached (the entry stays whole-file, fail-closed).
 */
export function casesForFile(
  casesByFile: Readonly<Record<string, readonly string[]>> | ReadonlyMap<string, readonly string[]> | undefined,
  id: string,
): string[] | undefined {
  if (!casesByFile) return undefined;
  const entries: Array<[string, readonly string[]]> =
    casesByFile instanceof Map ? [...casesByFile.entries()] : Object.entries(casesByFile);
  const exact = entries.find(([file]) => file === id);
  const match = exact ?? (() => {
    const suffix = entries.filter(([file]) => id.endsWith(`/${file}`) || file.endsWith(`/${id}`));
    return suffix.length === 1 ? suffix[0] : undefined;
  })();
  const cases = match?.[1].filter((c) => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim());
  return cases && cases.length > 0 ? [...new Set(cases)].sort() : undefined;
}
