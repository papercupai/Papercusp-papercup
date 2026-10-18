import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * `ast-grep` — the STRUCTURAL leg of the code-intelligence triad
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`, P-014).
 *
 * ── The routing distinction this leg exists to hold ────────────────────────
 * Three backends answer three genuinely different questions, and the failure
 * mode P-014 names is using one to answer another's question:
 *
 *   lsp.*     TYPE TRUTH.  "What IS this symbol?" Compiler-resolved: follows
 *             re-exports, generics and cross-package boundaries, and knows a
 *             shadowed local is not the import. Cannot answer about code that
 *             does not typecheck, and costs a resident server per language.
 *   gitnexus  TOPOLOGY.    "What CALLS this, and what does it reach?" A graph
 *             over the repo. Answers impact and call chains; does not know
 *             types, and its index can lag HEAD.
 *   ast-grep  SHAPE.       "Where does this CODE PATTERN occur?" Parses to a
 *             syntax tree and matches structure, so `foo($X)` finds every call
 *             regardless of whitespace, line breaks or the argument's text —
 *             and does NOT match the same characters inside a string or a
 *             comment. Knows nothing about types or meaning: it cannot tell two
 *             identically-shaped `foo` calls from different modules apart.
 *
 * The practical rule: reach here when the question is about FORM (a lint-shaped
 * pattern, a codemod's blast radius, an idiom sweep), and reach for `lsp.*` the
 * moment the answer depends on which declaration a name resolves to. A
 * structural match set is a superset of the type-correct one, and treating it
 * as the type-correct one is precisely the mistake this comment is here to
 * prevent — ast-grep says "this looks like the thing", never "this IS the thing".
 *
 * ── ⚠ THE `sg` TRAP — why resolution is by EXPLICIT PATH ONLY ─────────────
 * ast-grep's documented short alias is `sg`. On Linux `/usr/bin/sg` ALREADY
 * EXISTS: it is shadow-utils' "substitute group" (`sg group [[-c] command]`,
 * from the `login` package), present on this box right now. Measured
 * 2026-08-21, and the reason this is a rail rather than a footnote:
 *
 *   $ command -v sg      →  /usr/bin/sg          (looks provisioned)
 *   $ sg --version       →  "Usage: sg group…"   AND EXITS 0
 *
 * So the two checks anyone would write to confirm ast-grep is installed — a
 * PATH lookup and a `--version` probe judged by exit code — BOTH pass against
 * a completely unrelated binary. A provisioning guard built on either would
 * report healthy while every structural query silently did nothing.
 *
 * Hence: the binary is resolved ONLY at its pinned vendor path, never through
 * PATH, and `astGrepIdentity()` verifies the version STRING rather than the
 * exit code. `assertIsAstGrep()` is the reusable predicate, and its test feeds
 * it the real `/usr/bin/sg` output as a negative control.
 *
 * ── READ-ONLY by construction ─────────────────────────────────────────────
 * ast-grep applies a rewrite only when passed `--update-all`/`-U`. This module
 * never constructs that flag — `rewrite` returns the sites a codemod WOULD
 * change and the file stays byte-identical (verified in the test, not asserted
 * here). Applying structural rewrites on this shared checkout must go through
 * the lock-arbitrated writer (P-013 / D-038), because an unarbitrated
 * offset-based multi-file rewrite is exactly what that machinery exists to
 * prevent. Until it is wired, this leg previews and does not write.
 */

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

import {
  DEFAULT_RESOURCE_BUDGET,
  toOneIndexed,
  type CodeIntelAnswer,
  type CodeIntelIntent,
  type SymbolSite,
  versionedSymbolIdentity,
  type CodeIntelSourceFile,
} from './contracts.ts';

let execFileAsync: ((...args: any[]) => Promise<any>) | undefined;
const runExecFile = (...args: any[]) => (execFileAsync ??= promisify(execFile) as any)(...args);

/** The pinned vendor root. Provisioned by P-014, never installed at runtime. */
export const AST_GREP_VENDOR_DIR = papercuspPath('vendor', 'ast-grep');

/**
 * The pinned binary, or `null` when it is not provisioned.
 *
 * ⚠ Deliberately NOT a PATH lookup — see the `sg` trap above. It also does not
 * fall back to any `ast-grep` that happens to be installed globally: a floating
 * structural-search engine changes which sites a codemod rewrites between runs,
 * which is the same class of silent drift the pinned language servers exist to
 * avoid (P-007).
 */
export function resolveAstGrepBin(): string | null {
  const bin = join(AST_GREP_VENDOR_DIR, 'node_modules', '.bin', 'ast-grep');
  return existsSync(bin) ? bin : null;
}

/**
 * Is this `--version` output really ast-grep?
 *
 * Judged on the STRING, never on the exit code, because `/usr/bin/sg` exits 0
 * for `--version` while printing its own usage. Pure + exported so the negative
 * control in the test can feed it real shadow-utils output.
 */
export function assertIsAstGrep(versionOutput: string): { ok: true; version: string } | { ok: false; reason: string } {
  const text = versionOutput.trim();
  const m = /^ast-grep\s+(\d+\.\d+\.\d+)/.exec(text);
  if (!m) {
    return {
      ok: false,
      reason:
        `the resolved binary does not identify as ast-grep (it printed ${JSON.stringify(
          text.slice(0, 80),
        )}). On Linux \`sg\` is shadow-utils' substitute-group command, which exits 0 for ` +
        `--version — so an exit-code check would have passed here.`,
    };
  }
  return { ok: true, version: m[1] };
}

export interface AstGrepIdentity {
  bin: string;
  version: string;
}

/** Resolve AND verify identity. Every operation goes through this. */
export async function astGrepIdentity(): Promise<
  { ok: true; identity: AstGrepIdentity } | { ok: false; reason: string }
> {
  const bin = resolveAstGrepBin();
  if (!bin) {
    return {
      ok: false,
      reason:
        `pinned ast-grep is not provisioned. Expected it under ${AST_GREP_VENDOR_DIR}. ` +
        `Provision it (P-014) rather than falling back to a PATH lookup — on Linux that ` +
        `resolves shadow-utils' \`sg\`, not ast-grep.`,
    };
  }
  try {
    const { stdout } = await runExecFile(bin, ['--version'], { timeout: 10_000 });
    const verdict = assertIsAstGrep(stdout);
    return verdict.ok ? { ok: true, identity: { bin, version: verdict.version } } : verdict;
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** The languages we let callers name, mapped to ast-grep's own `-l` values. */
export const AST_GREP_LANGUAGES = Object.freeze({
  ts: 'ts',
  tsx: 'tsx',
  js: 'js',
  jsx: 'jsx',
  rust: 'rust',
  python: 'python',
  go: 'go',
} as const);

export type AstGrepLanguage = keyof typeof AST_GREP_LANGUAGES;

/** One `--json=compact` match, narrowed to the fields we read. */
interface AstGrepMatch {
  text?: string;
  file?: string;
  range?: { start?: { line?: number; column?: number } };
  replacement?: string;
}

/**
 * Parse ast-grep's `--json=compact` output into shared `SymbolSite`s.
 *
 * Pure + exported so the line-base conversion is tested against a real captured
 * payload rather than against a live process. `toOneIndexed` is the shared
 * converter: ast-grep is ZERO-indexed, and every line this repo prints is
 * one-indexed, so skipping it produces citations that are silently off by one —
 * the exact defect the LINE_INDEX_BASE table was built after finding.
 */
export function parseAstGrepMatches(stdout: string, rootPath: string): SymbolSite[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const sites: SymbolSite[] = [];
  for (const raw of parsed as AstGrepMatch[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.file !== 'string') continue;
    const line0 = raw.range?.start?.line;
    // ast-grep preserves the caller's path shape: an absolute input produces
    // an absolute `file`, while a repo-relative input produces a repo-relative
    // one. Relativizing the latter against an absolute root invents a chain of
    // `../../..` segments and corrupts an otherwise-correct citation. Normalize
    // both branches into the shared repo-relative POSIX convention.
    const pathFromRoot = isAbsolute(raw.file) ? relative(rootPath, raw.file) : raw.file;
    const normalizedPath = normalize(pathFromRoot).split(sep).join('/').replace(/^\.\//, '');
    sites.push({
      path: normalizedPath || raw.file,
      line1: toOneIndexed('ast-grep', typeof line0 === 'number' ? line0 : null),
      kind: 'match',
      // For a rewrite preview this is what the site WOULD become; for a search
      // it is what is there now. Both are the caller's answer.
      detail: raw.replacement ?? raw.text ?? null,
    });
  }
  return sites;
}

export type AstGrepOp = 'search' | 'rewrite_preview' | 'syntax_index';

/** Builtin Tree-sitter grammars of the provisioned MIT ast-grep 0.45.1.
 * Grammar dependencies: ast-grep/ast-grep@0.45.1/crates/language/Cargo.toml.
 * Each tree-sitter/{tree-sitter-typescript,javascript,rust,python,go} LICENSE is MIT.
 * These rules admit syntax only; imports/impls never certify symbol resolution. */
export const SYNTAX_INDEX_KINDS = Object.freeze({
  ts: { declaration: ['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration'], imports: ['import_statement'], inheritance: ['extends_clause', 'implements_clause'] },
  tsx: { declaration: ['function_declaration', 'class_declaration', 'interface_declaration', 'type_alias_declaration'], imports: ['import_statement'], inheritance: ['extends_clause', 'implements_clause'] },
  js: { declaration: ['function_declaration', 'class_declaration'], imports: ['import_statement'], inheritance: ['class_heritage'] },
  jsx: { declaration: ['function_declaration', 'class_declaration'], imports: ['import_statement'], inheritance: ['class_heritage'] },
  rust: { declaration: ['function_item', 'struct_item', 'enum_item', 'trait_item', 'type_item'], imports: ['use_declaration'], inheritance: ['impl_item'] },
  python: { declaration: ['function_definition', 'class_definition'], imports: ['import_statement', 'import_from_statement'], inheritance: [] },
  go: { declaration: ['function_declaration', 'method_declaration', 'type_declaration'], imports: ['import_spec'], inheritance: [] },
} satisfies Record<AstGrepLanguage, Record<'declaration' | 'imports' | 'inheritance', string[]>>);

const SYNTAX_LANG_NAMES = { ts: 'TypeScript', tsx: 'Tsx', js: 'JavaScript', jsx: 'JavaScript', rust: 'Rust', python: 'Python', go: 'Go' } as const;
const SYNTAX_EXTENSIONS = { ts: ['.ts', '.mts', '.cts'], tsx: ['.tsx'], js: ['.js', '.mjs', '.cjs'], jsx: ['.jsx'], rust: ['.rs'], python: ['.py', '.pyi'], go: ['.go'] } as const;

export function buildSyntaxIndexArgs(language: AstGrepLanguage): string[] {
  const kinds = SYNTAX_INDEX_KINDS[language];
  if (!kinds) throw new Error('unsupported syntax-index language');
  const rules = Object.entries(kinds).filter(([, nodes]) => nodes.length).map(([role, nodes]) => JSON.stringify({
    id: role, language: SYNTAX_LANG_NAMES[language], rule: { any: nodes.map(kind => ({ kind })) },
    message: role, severity: 'info',
  }));
  if (language === 'python') rules.push(JSON.stringify({ id: 'inheritance', language: 'Python', rule: { all: [{ kind: 'class_definition' }, { has: { field: 'superclasses', regex: '.+' } }] }, message: 'inheritance', severity: 'info' }));
  // stdin supplies the exact hashed input. No index or later disk read stands in for it.
  return ['scan', '--stdin', '--inline-rules', rules.join('\n---\n'), '--json=compact'];
}

/** Bounded syntax index through the existing parser/process seam, using immutable stdin inputs. */
export async function astGrepSyntaxIndex(args: Omit<AstGrepArgs, 'pattern'>): Promise<CodeIntelAnswer> {
  const started = Date.now();
  const fail = (reason: string) => refusal('structural-search', 'syntax_index', reason, started);
  if (!SYNTAX_INDEX_KINDS[args.language]) return fail('unsupported syntax-index language; refusing an uncertified empty');
  if (!(await getFlag(FLAGS.CODE_INTEL_AST_GREP, 'system').catch(() => false))) return fail('structural search is disabled');
  if (!args.paths?.length || args.paths.length > 16) return fail('syntax_index requires 1..16 explicit source files');
  const identity = await astGrepIdentity();
  if (!identity.ok) return fail(identity.reason);
  if (identity.identity.version !== '0.45.1') return fail('unsupported syntax-index grammar generation: expected ast-grep 0.45.1');
  const sources: CodeIntelSourceFile[] = [];
  const sites: SymbolSite[] = [];
  const limitations = ['Syntax relationships are inferred; compiler resolution, calls and runtime execution are unverified.', 'Generated files and dynamic/evaluated source are excluded.'];
  const limit = Math.max(1, Math.min(args.limit ?? MAX_AST_GREP_SITES, MAX_AST_GREP_SITES));
  let root: string;
  try { root = realpathSync(args.rootPath); } catch { return fail('syntax-index project root is unavailable'); }
  try {
    for (const requested of [...new Set(args.paths)].sort()) {
      const absolute = realpathSync(resolve(root, requested));
      const path = relative(root, absolute).split(sep).join('/');
      if (!path || path.split('/').includes('..') || isAbsolute(path) || !statSync(absolute).isFile()) return fail('syntax-index input is outside project scope or is not a file');
      if (path.split('/').some(part => ['node_modules', 'dist', 'build', 'target', 'coverage', '.git'].includes(part))) {
        limitations.push('Excluded generated/vendor path: ' + path); continue;
      }
      if (!SYNTAX_EXTENSIONS[args.language].some(extension => path.endsWith(extension))) return fail('unsupported source extension for syntax-index grammar: ' + path);
      if (statSync(absolute).size > 1024 * 1024) return fail('syntax-index source exceeds the 1 MiB input bound');
      const bytes = readFileSync(absolute);
      const text = bytes.toString('utf8');
      if (/[@]generated|DO NOT EDIT|Code generated/.test(text.slice(0, 500))) { limitations.push('Excluded generated source: ' + path); continue; }
      const result = await new Promise<{ stdout: string }>((resolveRun, rejectRun) => {
        const child = execFile(identity.identity.bin, buildSyntaxIndexArgs(args.language), {
          cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
          if (error && !(error.code === 1 && !stderr.trim())) rejectRun(error);
          else resolveRun({ stdout });
        });
        child.stdin?.on('error', rejectRun);
        child.stdin?.end(bytes);
      });
      const rows: unknown = JSON.parse(result.stdout.trim() || '[]');
      if (!Array.isArray(rows)) return fail('syntax parser returned malformed match evidence');
      sources.push({ path, contentHash: createHash('sha256').update(bytes).digest('hex'), language: args.language, representation: 'full-source' });
      for (const row of rows) {
        const match = row as { ruleId?: string; text?: string; range?: { start?: { line?: number } } };
        if (!['declaration', 'imports', 'inheritance'].includes(match.ruleId ?? '') || typeof match.range?.start?.line !== 'number') return fail('syntax parser returned unclassified match evidence');
        sites.push({ path, line1: toOneIndexed('ast-grep', match.range.start.line), kind: match.ruleId!, detail: match.text ?? null });
      }
    }
  } catch (error) { return fail('syntax index failed: ' + (error instanceof Error ? error.message : String(error))); }
  if (args.language === 'go') limitations.push('Go has no class inheritance; embedding resolution is unsupported for this grammar profile.');
  const result = answer('structural-search', 'syntax_index', sites, started, limit, identity.identity.version);
  const repositoryId = 'local-root:' + createHash('sha256').update(root).digest('hex');
  return { ...result, coverage: { basis: 'syntax', sourceCompleteness: 'unverified', limitations }, evidence: {
    schemaVersion: 1,
    sourceScope: { repositoryId, identityKind: 'local-root', sourceFingerprint: createHash('sha256').update(JSON.stringify(sources)).digest('hex'), paths: sources.map(source => source.path), supportingFiles: sources },
    graphScope: { basis: 'syntax', sourceCompleteness: 'unverified', limitations },
    languageCapabilities: [{ language: args.language, intent: 'structural-search', status: 'syntax-only' }],
    siteIdentities: result.sites.map((site, siteIndex) => { const source = sources.find(value => value.path === site.path); return { siteIndex, sourcePath: site.path, contentHash: source?.contentHash ?? null, versionedSymbolId: versionedSymbolIdentity(repositoryId, site, source) }; }),
    relationships: result.sites.map((_site, siteIndex) => ({ siteIndex, kind: 'structural-search', origin: 'syntax', knowledge: 'inferred', runtimeExecution: 'unknown' })),
  } };
}

export interface AstGrepArgs {
  /** The structural pattern, e.g. `foo($X)` or `if ($C) { $$$BODY }`. */
  pattern: string;
  /** Which grammar to parse with. A pattern is parsed BY a language. */
  language: AstGrepLanguage;
  /** Files or directories to search. Defaults to the project root. */
  paths?: string[];
  /** `rewrite_preview` only: the replacement template. NOTHING is written. */
  rewrite?: string;
  rootPath: string;
  limit?: number;
}

/** Result-set cap, derived from the shared budget rather than re-invented. */
export const MAX_AST_GREP_SITES = Math.max(
  1,
  Math.floor(DEFAULT_RESOURCE_BUDGET.resultTokensMax / 12),
);

/**
 * Build the argv.
 *
 * Pure + exported so the READ-ONLY property is testable as a property of the
 * argv rather than as a claim in a comment: the test asserts that no produced
 * argv ever contains `--update-all`/`-U`, for any input including a caller who
 * tries to smuggle one through `pattern` or `rewrite`.
 */
export function buildAstGrepArgs(args: AstGrepArgs, op: AstGrepOp): string[] {
  if (op === 'syntax_index') return buildSyntaxIndexArgs(args.language);
  const argv = ['run', '--pattern', args.pattern, '--lang', AST_GREP_LANGUAGES[args.language]];
  if (op === 'rewrite_preview' && args.rewrite !== undefined) {
    argv.push('--rewrite', args.rewrite);
  }
  argv.push('--json=compact');
  // `--` terminates option parsing, so a path that begins with a dash can never
  // be re-read as a flag. Values above are passed as SEPARATE argv entries (not
  // `--pattern=…`), and execFile takes an argv array with no shell, so a pattern
  // containing spaces, quotes or `$` cannot become another argument.
  argv.push('--');
  argv.push(...(args.paths?.length ? args.paths : [args.rootPath]));
  return argv;
}

function answer(
  intent: CodeIntelIntent,
  query: string,
  sites: SymbolSite[],
  startedAt: number,
  limit: number,
  version: string | null,
): CodeIntelAnswer {
  const truncated = sites.length > limit;
  return {
    backend: 'ast-grep',
    intent,
    query,
    sites: truncated ? sites.slice(0, limit) : sites,
    truncation: {
      truncated,
      totalAvailable: sites.length,
      continuation: null,
    },
    freshness: {
      // ast-grep parses the file on disk every run — there is no index to be
      // stale against, which is the one thing it has over gitnexus.
      health: 'healthy',
      indexedAt: null,
      staleVsDisk: false,
      indexedCommit: version,
    },
    latencyMs: Date.now() - startedAt,
    error: null,
  };
}

function refusal(intent: CodeIntelIntent, query: string, error: string, startedAt: number): CodeIntelAnswer {
  return {
    backend: 'ast-grep',
    intent,
    query,
    sites: [],
    truncation: { truncated: false, totalAvailable: null, continuation: null },
    // NOT 'healthy': an empty answer from a refusal must never satisfy
    // isTrustworthyEmpty, or "ast-grep is not installed" reads as "no matches".
    freshness: { health: 'unknown', indexedAt: null, staleVsDisk: null, indexedCommit: null },
    latencyMs: Date.now() - startedAt,
    error,
  };
}

/**
 * Run a structural search, or preview a codemod. NEVER writes.
 *
 * Refusals are answers, exactly as in the `lsp.*` facade: a disabled flag, an
 * unprovisioned binary, an impostor `sg` and a genuinely-empty match set are
 * four different states, and each returns an answer that says which one.
 */
export async function astGrepFacade(op: AstGrepOp, args: AstGrepArgs): Promise<CodeIntelAnswer> {
  if (op === 'syntax_index') return astGrepSyntaxIndex(args);
  const started = Date.now();
  const intent: CodeIntelIntent = 'structural-search';
  const query = op === 'rewrite_preview' ? `${args.pattern} → ${args.rewrite ?? ''}` : args.pattern;
  const limit = Math.min(args.limit ?? MAX_AST_GREP_SITES, MAX_AST_GREP_SITES);

  if (!(await getFlag(FLAGS.CODE_INTEL_AST_GREP, 'system').catch(() => false))) {
    return refusal(intent, query, `structural search is disabled (${FLAGS.CODE_INTEL_AST_GREP} is off)`, started);
  }
  if (op === 'rewrite_preview' && !args.rewrite) {
    return refusal(intent, query, `rewrite_preview requires 'rewrite'`, started);
  }

  const id = await astGrepIdentity();
  if (!id.ok) return refusal(intent, query, id.reason, started);

  try {
    const { stdout } = await runExecFile(id.identity.bin, buildAstGrepArgs(args, op), {
      cwd: args.rootPath,
      timeout: 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return answer(intent, query, parseAstGrepMatches(stdout, args.rootPath), started, limit, id.identity.version);
  } catch (err) {
    // ast-grep exits non-zero for "no matches" on some paths; an empty stdout
    // with no stderr is a genuine no-match, not a failure. Anything with real
    // stderr is reported LOUDLY rather than becoming a plausible empty.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stderr && e.stderr.trim().length > 0) {
      return refusal(intent, query, e.stderr.trim().slice(0, 500), started);
    }
    if (typeof e.stdout === 'string') {
      return answer(intent, query, parseAstGrepMatches(e.stdout, args.rootPath), started, limit, id.identity.version);
    }
    return refusal(intent, query, e.message ?? String(err), started);
  }
}
