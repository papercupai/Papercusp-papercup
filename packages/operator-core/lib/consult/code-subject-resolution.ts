/**
 * Code-subject resolution for the consult relevance router
 * (plan code-intel-relevance-routing-2026-10-21, R-1 / P-001).
 *
 * The router's authorship signal used to fire only when a question named a
 * literal file path (6.6% of routings over 30 days). Most code questions name
 * an IDENTIFIER instead ("why does routeConsult drop aged experts?"). This
 * module turns a question into the set of repository files it is about:
 *
 *   - explicit paths, exactly as `extractPathTokens` finds them; plus
 *   - identifiers resolved to the files that DEFINE them, through an injected
 *     resolver seam. Production uses `gitGrepSymbolResolver` (D-002): `git grep`
 *     over the tracked files of the router host's checkout for an exported
 *     declaration, bounded by a timeout and a per-identifier file cap. No new
 *     index or table.
 *
 * A question with no code subject resolves to an empty set, so the router can
 * skip every extra query and route exactly as before (R-4).
 */
import { execFile } from 'node:child_process';
import { extractPathTokens } from './relevance-router';

/** identifier → defining files (repo-relative). A missing key = unresolved. */
export type SymbolResolver = (identifiers: readonly string[]) => Promise<Map<string, string[]>>;

export interface CodeSubjects {
  /** Literal paths named in the question. */
  paths: string[];
  /** Identifier tokens found in the question (capped). */
  identifiers: string[];
  /** identifier → its defining files, for the identifiers that resolved. */
  resolved: Record<string, string[]>;
  /** Union of `paths` and every resolved defining file, de-duplicated. */
  files: string[];
  /** 'unavailable' when the resolver threw: identifiers stayed unresolved. */
  resolver: 'ok' | 'unavailable' | 'skipped';
}

export const CODE_SUBJECT_MAX_IDENTIFIERS = 4;
export const CODE_SUBJECT_MAX_FILES_PER_IDENTIFIER = 3;
export const CODE_SUBJECT_RESOLVER_TIMEOUT_MS = 1_000;

const IDENTIFIER_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** lowerCamel with at least one hump (routeConsult), or PascalCase with two (BlendWeights). */
const CAMEL_TOKEN = /(?<![\w$.:/-])(?:[a-z_$][a-z0-9_$]*[A-Z][A-Za-z0-9_$]*|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+)(?![\w$:/-])/g;
/** `snake_case` or other identifiers count only when code-quoted. */
const QUOTED_TOKEN = /`([A-Za-z_$][A-Za-z0-9_$]{2,})(?:\(\))?`/g;
/** Public product names that are camel-shaped but are not repository code. */
const NOT_CODE = new Set(['macOS', 'iOS', 'iPadOS', 'iPhone', 'iPad', 'GitHub', 'PostHog', 'TypeScript', 'JavaScript', 'PostgreSQL', 'OpenAI', 'YouTube', 'LinkedIn']);

/** Identifier tokens a question names, in order of first appearance, capped. */
export function extractIdentifierTokens(question: string, cap = CODE_SUBJECT_MAX_IDENTIFIERS): string[] {
  const found: Array<{ token: string; at: number }> = [];
  for (const m of question.matchAll(QUOTED_TOKEN)) found.push({ token: m[1]!, at: m.index ?? 0 });
  for (const m of question.matchAll(CAMEL_TOKEN)) found.push({ token: m[0], at: m.index ?? 0 });
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  for (const { token } of found) {
    if (!IDENTIFIER_SHAPE.test(token) || NOT_CODE.has(token) || seen.has(token)) continue;
    seen.add(token);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

export async function resolveQuestionCodeSubjects(
  question: string,
  deps: { resolveSymbol?: SymbolResolver | null },
): Promise<CodeSubjects> {
  const paths = extractPathTokens(question);
  const identifiers = extractIdentifierTokens(question);
  const resolved: Record<string, string[]> = {};
  let resolver: CodeSubjects['resolver'] = 'skipped';
  if (identifiers.length > 0 && deps.resolveSymbol) {
    try {
      const byIdentifier = await deps.resolveSymbol(identifiers);
      for (const identifier of identifiers) {
        const files = [...new Set(byIdentifier.get(identifier) ?? [])].slice(0, CODE_SUBJECT_MAX_FILES_PER_IDENTIFIER);
        if (files.length > 0) resolved[identifier] = files;
      }
      resolver = 'ok';
    } catch {
      resolver = 'unavailable';
    }
  }
  const files = [...new Set([...paths, ...Object.values(resolved).flat()])];
  return { paths, identifiers, resolved, files, resolver };
}

/** True when the question named any code at all (a path or an identifier). */
export function hasCodeSubjects(subjects: CodeSubjects): boolean {
  return subjects.files.length > 0;
}

const DECLARATION_KINDS = '(default[[:space:]]+)?(async[[:space:]]+)?(function\\*?|const|let|var|class|abstract[[:space:]]+class|interface|type|enum)';
const SOURCE_GLOBS = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'];

function escapeEre(identifier: string): string {
  return identifier.replace(/\$/g, '\\$');
}

/** Rank so a production definition beats a test or fixture that re-declares the name. */
function definitionRank(file: string): number {
  if (/(?:^|\/)(?:__tests__|__fixtures__|fixtures?|e2e)\//.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return 2;
  if (/(?:^|\/)(?:dist|build|scripts)\//.test(file)) return 1;
  return 0;
}

const DECLARATION_KINDS_PCRE = '(?:default\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|abstract\\s+class|interface|type|enum)';

/** Every pathspec is anchored at the repository top (`:(top)`): the operator
 * hosts run with cwd `<checkout>/apps/operator`, and a bare `*.ts` pathspec
 * would search only that subtree, missing every definition in `packages/`. */
const TOP_SOURCE_PATHSPECS = SOURCE_GLOBS.map((glob) => `:(top)${glob}`);

type GrepOutcome = { kind: 'matched'; stdout: string } | { kind: 'no-match' } | { kind: 'failed'; reason: string; pcreUnsupported: boolean };

function runGitGrep(cwd: string, flag: '-P' | '-E', pattern: string, timeoutMs: number): Promise<GrepOutcome> {
  return new Promise((resolve) => {
    // Git's automatic worker count adds enough startup/coordination overhead on
    // large hosts to consume this lookup's deadline. Bound it per invocation;
    // command-level config also overrides inherited repository thread settings.
    execFile('git', ['-c', 'grep.threads=8', 'grep', '-o', '-I', '--full-name', flag, '-e', pattern, '--', ...TOP_SOURCE_PATHSPECS], {
      cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: 'utf8',
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ kind: 'matched', stdout: String(stdout ?? '') });
      // execFile reports the child's exit status as a NUMBER code and a spawn
      // failure (ENOENT) as a STRING code, so `code` is deliberately wider than
      // NodeJS.ErrnoException's string-only field.
      const e = err as { code?: number | string | null; killed?: boolean; message: string };
      // git grep exits 1 for "no match"; anything else (timeout kill, 128 for
      // a non-repo cwd or an unsupported -P, a missing git) is a failed lookup.
      if (e.code === 1 && !e.killed) return resolve({ kind: 'no-match' });
      const text = String(stderr ?? '');
      resolve({
        kind: 'failed',
        reason: e.killed ? `timeout after ${timeoutMs}ms` : (text.trim().split('\n')[0] || String(e.message)),
        pcreUnsupported: flag === '-P' && !e.killed && /perl|pcre/i.test(text),
      });
    });
  });
}

/**
 * Production resolver (D-002): ONE `git grep -o` over the tracked sources of
 * the whole checkout containing `cwd` (repo-relative paths via `--full-name`)
 * for `export <kind> <identifier>`, every identifier in one alternation. PCRE
 * first (measured 2-3x faster than ERE over ~22k tracked files), ERE when the
 * local git lacks PCRE. A timeout, a non-repo cwd or a missing git REJECTS, so
 * the caller records the resolver as `unavailable` instead of reporting that
 * nothing defines the identifier; "no match" resolves to an empty map.
 */
export function gitGrepSymbolResolver(opts: {
  cwd: string;
  timeoutMs?: number;
  maxFilesPerIdentifier?: number;
}): SymbolResolver {
  const timeoutMs = opts.timeoutMs ?? CODE_SUBJECT_RESOLVER_TIMEOUT_MS;
  const cap = opts.maxFilesPerIdentifier ?? CODE_SUBJECT_MAX_FILES_PER_IDENTIFIER;
  return async (identifiers) => {
    const wanted = [...new Set(identifiers.filter((id) => IDENTIFIER_SHAPE.test(id)))];
    if (wanted.length === 0) return new Map();
    const alternation = wanted.map(escapeEre).join('|');
    let outcome = await runGitGrep(opts.cwd, '-P', `export\\s+${DECLARATION_KINDS_PCRE}\\s+(?:${alternation})(?![A-Za-z0-9_$])`, timeoutMs);
    if (outcome.kind === 'failed' && outcome.pcreUnsupported) {
      outcome = await runGitGrep(opts.cwd, '-E', `export[[:space:]]+${DECLARATION_KINDS}[[:space:]]+(${alternation})([^A-Za-z0-9_$]|$)`, timeoutMs);
    }
    if (outcome.kind === 'failed') throw new Error(`symbol resolver unavailable: ${outcome.reason}`);
    if (outcome.kind === 'no-match') return new Map();
    const byIdentifier = new Map<string, Set<string>>();
    for (const line of outcome.stdout.split('\n')) {
      // `-o` prints `<path>:<match>` and every match starts with `export`;
      // the ERE form's trailing character can itself be `:` (`export const x:`).
      const sep = line.indexOf(':export');
      if (sep <= 0) continue;
      const file = line.slice(0, sep);
      const identifier = /([A-Za-z_$][A-Za-z0-9_$]*)[^A-Za-z0-9_$]?$/.exec(line.slice(sep + 1).trim())?.[1];
      if (!identifier || !wanted.includes(identifier)) continue;
      let files = byIdentifier.get(identifier);
      if (!files) byIdentifier.set(identifier, (files = new Set()));
      files.add(file);
    }
    const out = new Map<string, string[]>();
    for (const [identifier, files] of byIdentifier) {
      out.set(identifier, [...files]
        .sort((a, b) => definitionRank(a) - definitionRank(b) || a.length - b.length || a.localeCompare(b))
        .slice(0, cap));
    }
    return out;
  };
}
