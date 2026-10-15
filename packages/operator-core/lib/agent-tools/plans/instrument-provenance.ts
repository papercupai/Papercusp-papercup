/**
 * P-010 (verification-system-improvements-2026-10-10; D-010, D-014 §R-10 scope, D-015):
 * measurement-kind evidence must name the instrument that produced it.
 *
 * An `operational` or `manual` binding records a number or an observation that some
 * program measured. When that program is a throwaway script — a `.papercusp/scratch`
 * probe, a `/tmp` file, an uncommitted edit — nobody can re-run it, review it, or notice
 * that it divides by the wrong denominator (the recall@1 incident: an AVG that dropped
 * NULL rows reported a healthy number for a broken instrument). So at BIND TIME the binding
 * must either cite `details.instrument = { path, testPath }` — an instrument file and the
 * test that imports it, BOTH committed blobs — or declare `details.instrument = { none:
 * true, reason }` that it used no instrument at all.
 *
 * Scope rules (each pinned by a clause):
 *  - Only `operational` / `manual` evidence (D-014): test/mutation/check evidence already
 *    names its executable subject.
 *  - BIND TIME ONLY (SPEC-P-010-BIND-TIME-ONLY): this is called from the
 *    plans:bind-spec-evidence handler and nowhere else. Re-measurement of an already-bound
 *    row (a scorecard re-emit, a freshness recompute) never re-judges provenance, so
 *    evidence bound before the rule landed is not retroactively refused.
 *  - The bound commit is the as-committed run's commit when the binding carries one
 *    (SPEC-P-010-AS-COMMITTED), else the checkout's HEAD. The run's recorded ROOT (a
 *    disposable `/tmp` clone) is never consulted — only the instrument's own path is.
 *  - A registered sibling checkout is accepted when it carries an explicit commit pin
 *    (SPEC-P-010-INSTRUMENT-PROVENANCE): its HEAD moves independently of ours, so an
 *    unpinned citation names no reproducible bytes.
 */
import { posix } from 'node:path';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { defaultGitRunner, type GitRunner } from './evidence-measurement-pin';

export const INSTRUMENT_EVIDENCE_KINDS: ReadonlySet<string> = new Set(['operational', 'manual']);

export const INSTRUMENT_REFUSAL_CODES = [
  'instrument_undeclared',
  'instrument_scratch_probe',
  'instrument_outside_repo',
  'instrument_not_committed',
  'instrument_test_not_importing',
  'instrument_sibling_unpinned',
] as const;
export type InstrumentRefusalCode = (typeof INSTRUMENT_REFUSAL_CODES)[number];

export interface InstrumentProvenanceRefusal {
  error: InstrumentRefusalCode;
  reason: string;
  instrument: unknown;
}

export interface InstrumentProvenanceDeps {
  git: GitRunner;
  /** Absolute root of the harness checkout the binding belongs to. */
  primaryRoot: () => Promise<string>;
  /** Absolute root of a REGISTERED checkout by harness slug; null when the slug is unregistered. */
  checkoutRoot: (checkout: string) => Promise<string | null>;
}

const SCRATCH_PREFIX = '.papercusp/scratch/';
const COMMIT_PIN_RE = /^[0-9a-f]{7,40}$/i;
const TEST_FILE_RE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const STRIPPABLE_EXT_RE = /\.(d\.ts|[cm]?[jt]sx?)$/;
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"\n]+)['"]/g;

const DECLARE_HINT =
  'Cite details.instrument = { path, testPath } — the instrument file and the committed test that imports it, ' +
  'both repository-relative — or declare details.instrument = { none: true, reason: "<why no instrument was used>" }.';

function refusal(error: InstrumentRefusalCode, reason: string, instrument: unknown): InstrumentProvenanceRefusal {
  return { error, reason, instrument: instrument ?? null };
}

function isOutsideRepo(path: string): boolean {
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:[\\/]/.test(path)) return true;
  return posix.normalize(path).split('/').includes('..');
}

function stripExt(path: string): string {
  return path.replace(STRIPPABLE_EXT_RE, '').replace(/\/index$/, '');
}

/**
 * Does the committed test body reference the instrument? A relative import/require that
 * resolves to it, a path-alias import whose tail names it, or the instrument's
 * repo-relative path written as a literal (how a test drives a shell/SQL instrument).
 */
export function testReferencesInstrument(testBody: string, testPath: string, instrumentPath: string): boolean {
  const target = stripExt(posix.normalize(instrumentPath));
  if (testBody.includes(instrumentPath)) return true;
  const testDir = posix.dirname(posix.normalize(testPath));
  for (const match of testBody.matchAll(SPECIFIER_RE)) {
    const spec = match[1]!;
    if (spec.startsWith('.')) {
      if (stripExt(posix.join(testDir, spec)) === target) return true;
      continue;
    }
    const segments = stripExt(spec).split('/').filter(Boolean);
    if (segments.length >= 2 && target.endsWith(`/${segments.slice(-2).join('/')}`)) return true;
  }
  return false;
}

/**
 * R-10 drift marker (4): a no-instrument declaration is a claim that no program measured the
 * evidence. A script path, a run id or captured output anywhere in the evidence record says a
 * program did, so the two contradict and the declaration cannot stand.
 *
 * Scanned: `evidenceRef`, the top-level `testRunId`, and every key/string under `details` except
 * the declaration itself and the server-stamped measurement keys (`measurementPin`,
 * `currentMeasurement`, `declaredConfiguration`) and the schema-validated `adequacy` metadata.
 *
 * Boundaries: an evidence artifact (`docs/evidence/*.json`), a tool read (`plans:verification-health`),
 * a work-item / thread / scorecard ref and an ordinary source module (`lib/foo.ts`, which an honest
 * code-reading observation cites) are NOT scripts. Scripts are: anything under `scripts/`,
 * `.papercusp/scratch/`, `/tmp/` or `~/`; a test file; a file whose extension is a script language
 * (sh, bash, zsh, py, mjs, cjs, mts, cts, sql, pl, rb); a `.js` file named with a directory.
 */
const UNSCANNED_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'instrument',
  'measurementPin',
  'currentMeasurement',
  'declaredConfiguration',
  'adequacy',
]);
/** Detail keys (lower-cased, `_`/`-` removed) whose non-empty value is a run id. */
const RUN_ID_KEYS: ReadonlySet<string> = new Set(['runid', 'runids', 'testrun', 'testrunid', 'testrunids', 'rungroup', 'rungroupid']);
/** Detail keys (normalised as above) whose non-empty value is captured program output. */
const CAPTURED_OUTPUT_KEYS: ReadonlySet<string> = new Set([
  'capturedoutput',
  'output',
  'outputtail',
  'rawoutput',
  'commandoutput',
  'consoleoutput',
  'stdout',
  'stderr',
  'log',
  'logs',
]);
const SCRIPT_EXT_RE = /\.(sh|bash|zsh|py|mjs|cjs|mts|cts|sql|pl|rb)$/i;
const RUN_ID_TEXT_RE =
  /\b(?:test[-_ ]?run(?:[-_ ]?id)?|run[-_ ]?(?:group[-_ ]?)?id|run\s*#)\s*[#:=-]?\s*\d+|\brun\s+\d{4,}\b/i;
const TOKEN_SPLIT_RE = /[\s"'`()[\]{}<>,;=|]+/;
const MAX_SCANNED_STRINGS = 500;

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[-_]/g, '');
}

function nonEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/** Is this whitespace/punctuation-delimited token a path to a script? (exported for the boundary test) */
export function isScriptPathToken(token: string): boolean {
  const t = token.replace(/^[:@]+/, '').replace(/(?::\d+){1,2}$/, '').replace(/[.:]+$/, '');
  if (!t) return false;
  if (t.startsWith('/tmp/') || t.startsWith('~/') || t.includes(SCRATCH_PREFIX)) return true;
  if (/(?:^|\/)scripts\/[^/]+/.test(t)) return true;
  if (TEST_FILE_RE.test(t)) return true;
  if (SCRIPT_EXT_RE.test(t)) return true;
  return /\/[^/]+\.js$/i.test(t);
}

function scriptPathIn(text: string): string | null {
  for (const token of text.split(TOKEN_SPLIT_RE)) if (isScriptPathToken(token)) return token;
  return null;
}

/**
 * The first program trace in a no-instrument binding's evidence record, as a human-readable
 * "<what> (<where>)" string, or null when the record names none.
 */
export function evidenceRecordProgramTrace(binding: {
  evidenceRef?: string | undefined;
  testRunId?: number | null | undefined;
  details?: Record<string, unknown> | undefined;
}): string | null {
  if (binding.testRunId !== null && binding.testRunId !== undefined) {
    return `a run id (testRunId ${binding.testRunId})`;
  }
  if (typeof binding.evidenceRef === 'string') {
    const script = scriptPathIn(binding.evidenceRef);
    if (script) return `a script path (evidenceRef names "${script}")`;
    const run = RUN_ID_TEXT_RE.exec(binding.evidenceRef);
    if (run) return `a run id (evidenceRef names "${run[0]}")`;
  }
  let scanned = 0;
  const walk = (value: unknown, path: string, depth: number): string | null => {
    if (scanned >= MAX_SCANNED_STRINGS) return null;
    if (typeof value === 'string') {
      scanned += 1;
      const script = scriptPathIn(value);
      if (script) return `a script path (${path} names "${script}")`;
      const run = RUN_ID_TEXT_RE.exec(value);
      if (run) return `a run id (${path} names "${run[0]}")`;
      return null;
    }
    if (depth >= 6 || value === null || typeof value !== 'object') return null;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    for (const [key, child] of entries) {
      const childPath = Array.isArray(value) ? `${path}[${key}]` : `${path}.${key}`;
      if (!Array.isArray(value)) {
        const norm = normaliseKey(key);
        if (RUN_ID_KEYS.has(norm) && nonEmpty(child)) return `a run id (${childPath})`;
        if (CAPTURED_OUTPUT_KEYS.has(norm) && nonEmpty(child)) return `captured output (${childPath})`;
      }
      const hit = walk(child, childPath, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const [key, value] of Object.entries(binding.details ?? {})) {
    if (UNSCANNED_DETAIL_KEYS.has(key)) continue;
    const norm = normaliseKey(key);
    if (RUN_ID_KEYS.has(norm) && nonEmpty(value)) return `a run id (details.${key})`;
    if (CAPTURED_OUTPUT_KEYS.has(norm) && nonEmpty(value)) return `captured output (details.${key})`;
    const hit = walk(value, `details.${key}`, 1);
    if (hit) return hit;
  }
  return null;
}

async function blobExists(git: GitRunner, repo: string, commit: string, rel: string): Promise<boolean> {
  try {
    await git(repo, ['cat-file', '-e', `${commit}:${rel}`]);
    return true;
  } catch {
    return false;
  }
}

/** The innermost git repository holding `rel` under `root` (submodules included). */
async function locateRepo(git: GitRunner, root: string, rel: string): Promise<{ repo: string; rel: string }> {
  let dir = posix.dirname(rel);
  while (dir !== '.' && dir !== '/') {
    try {
      const top = (await git(posix.join(root, dir), ['rev-parse', '--show-toplevel'])).trim();
      if (top && top !== root) return { repo: top, rel: posix.relative(top, posix.join(root, rel)) };
      break;
    } catch {
      dir = posix.dirname(dir);
    }
  }
  return { repo: root, rel };
}

export async function instrumentProvenanceRefusal(
  binding: {
    evidenceKind: string;
    evidenceRef?: string | undefined;
    testRunId?: number | null | undefined;
    details?: Record<string, unknown> | undefined;
  },
  asCommitted: { commitSha: string; repoPrefix: string | null } | undefined,
  deps: InstrumentProvenanceDeps,
): Promise<InstrumentProvenanceRefusal | null> {
  if (!INSTRUMENT_EVIDENCE_KINDS.has(binding.evidenceKind)) return null;
  const raw = binding.details?.instrument;
  const kind = binding.evidenceKind;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return refusal('instrument_undeclared', `${kind} evidence names no instrument. ${DECLARE_HINT}`, raw);
  }
  const instrument = raw as Record<string, unknown>;
  if (instrument.none === true) {
    const reason = typeof instrument.reason === 'string' ? instrument.reason.trim() : '';
    if (instrument.path !== undefined || instrument.testPath !== undefined) {
      return refusal('instrument_undeclared', `details.instrument declares none:true AND cites a path; pick one. ${DECLARE_HINT}`, raw);
    }
    if (!reason) {
      return refusal('instrument_undeclared', `details.instrument = { none: true } needs a non-empty reason. ${DECLARE_HINT}`, raw);
    }
    // R-10 drift marker (4): "no instrument" is contradicted by a program trace in the record.
    const trace = evidenceRecordProgramTrace(binding);
    if (trace) {
      return refusal(
        'instrument_undeclared',
        `details.instrument declares none:true, but the evidence record names ${trace}. A script, a run or captured output means a program produced this evidence: ` +
          'cite that program as details.instrument = { path, testPath } (committed instrument + the committed test that imports it), ' +
          'or, if the observation genuinely used no program, remove the script/run/output from the record.',
        raw,
      );
    }
    return null;
  }
  const path = typeof instrument.path === 'string' ? instrument.path.trim() : '';
  const testPath = typeof instrument.testPath === 'string' ? instrument.testPath.trim() : '';
  if (!path || !testPath) {
    return refusal(
      'instrument_undeclared',
      `details.instrument must carry both path and testPath (got path=${JSON.stringify(path || null)}, testPath=${JSON.stringify(testPath || null)}). ${DECLARE_HINT}`,
      raw,
    );
  }
  for (const [field, value] of [['path', path], ['testPath', testPath]] as const) {
    if (isOutsideRepo(value)) {
      return refusal(
        'instrument_outside_repo',
        `details.instrument.${field} "${value}" is not a repository-relative path inside the checkout (absolute, /tmp, ~ or ../ paths cannot be re-run by anyone else). ` +
          'Commit the instrument into the repository and cite its repo-relative path; for a registered sibling checkout pass checkout + commitPin.',
        raw,
      );
    }
    if (posix.normalize(value).startsWith(SCRATCH_PREFIX)) {
      return refusal(
        'instrument_scratch_probe',
        `details.instrument.${field} "${value}" is a .papercusp/scratch probe — gitignored, untested and invisible to review. ` +
          "Promote it: move the measuring code into a committed module, cover it with a test in the project's real suite (e.g. <package>/lib/**/<name>.test.ts), then cite that path and test.",
        raw,
      );
    }
  }
  const checkout = typeof instrument.checkout === 'string' ? instrument.checkout.trim() : '';
  const commitPin = typeof instrument.commitPin === 'string' ? instrument.commitPin.trim() : '';
  let repoTarget: { repo: string; rel: string; testRel: string; commit: string };
  if (checkout) {
    const root = await deps.checkoutRoot(checkout);
    if (!root) {
      return refusal(
        'instrument_outside_repo',
        `details.instrument.checkout "${checkout}" is not a registered harness checkout in this workspace, so its bytes cannot be resolved. Cite a registered checkout's harness slug.`,
        raw,
      );
    }
    if (!COMMIT_PIN_RE.test(commitPin)) {
      return refusal(
        'instrument_sibling_unpinned',
        `details.instrument cites sibling checkout "${checkout}" without a commitPin (a 7–40 hex commit sha). A sibling's HEAD moves independently, so record the commit the instrument ran at.`,
        raw,
      );
    }
    repoTarget = { repo: root, rel: path, testRel: testPath, commit: commitPin };
  } else {
    const root = await deps.primaryRoot();
    if (asCommitted) {
      const sub = (asCommitted.repoPrefix ?? '').replace(/\/+$/, '');
      const prefix = sub ? `${sub}/` : '';
      const strip = (p: string) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
      repoTarget = {
        repo: prefix && path.startsWith(prefix) ? posix.join(root, sub) : root,
        rel: strip(path),
        testRel: strip(testPath),
        commit: asCommitted.commitSha,
      };
    } else {
      const located = await locateRepo(deps.git, root, path);
      const locatedTest = await locateRepo(deps.git, root, testPath);
      if (located.repo !== locatedTest.repo) {
        return refusal(
          'instrument_test_not_importing',
          `details.instrument.path and testPath live in different repositories (${located.repo} vs ${locatedTest.repo}); the importing test must sit beside its instrument.`,
          raw,
        );
      }
      repoTarget = { repo: located.repo, rel: located.rel, testRel: locatedTest.rel, commit: 'HEAD' };
    }
  }
  const { repo, rel, testRel, commit } = repoTarget;
  for (const [field, value] of [['path', rel], ['testPath', testRel]] as const) {
    if (!(await blobExists(deps.git, repo, commit, value))) {
      return refusal(
        'instrument_not_committed',
        `details.instrument.${field} "${value}" is not a committed blob at ${commit} in ${repo}. ` +
          'Leave the file in the shared tree until git-sync commits it (dev:pipeline_position shows when), then bind.',
        raw,
      );
    }
  }
  if (rel === testRel) {
    if (TEST_FILE_RE.test(rel)) return null;
    return refusal(
      'instrument_test_not_importing',
      `details.instrument.testPath equals path, but "${rel}" is not a test file. Cite the test that imports the instrument.`,
      raw,
    );
  }
  let body: string;
  try {
    body = await deps.git(repo, ['show', `${commit}:${testRel}`]);
  } catch {
    return refusal('instrument_not_committed', `details.instrument.testPath "${testRel}" could not be read at ${commit}.`, raw);
  }
  if (!testReferencesInstrument(body, testRel, rel)) {
    return refusal(
      'instrument_test_not_importing',
      `The committed test "${testRel}" does not import or reference the instrument "${rel}". ` +
        'An instrument is tested only by a test that exercises it — import it there (or cite the test that does).',
      raw,
    );
  }
  return null;
}

/** Production wiring: the bound harness root and the registry's checkouts, resolved once per call. */
export function defaultInstrumentProvenanceDeps(
  resolveWorkspaceId: () => Promise<string>,
  harnessSlug: string,
): InstrumentProvenanceDeps {
  let registry: Promise<Awaited<ReturnType<typeof loadHarnessRegistry>>> | undefined;
  const load = () => (registry ??= resolveWorkspaceId().then((workspaceId) => loadHarnessRegistry(workspaceId)));
  return {
    git: defaultGitRunner,
    primaryRoot: async () => {
      const root = resolveHarnessContentPath(await load(), harnessSlug);
      if (!root) throw new Error(`instrument_provenance_root_unavailable:${harnessSlug}`);
      return root;
    },
    checkoutRoot: async (checkout) => resolveHarnessContentPath(await load(), checkout) ?? null,
  };
}
