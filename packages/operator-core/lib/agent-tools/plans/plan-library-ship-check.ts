/**
 * R-6 ship check (plan-reuse-and-library-declarations-2026-10-20, D-013 #4).
 *
 * At `plans:audit phase:completion` the imports of the plan's code are read
 * through the ast-grep facade and compared against what the plan declared:
 *
 *   - a third-party package that is neither named in "## Third-party
 *     libraries" nor a dependency at activation REFUSES the completion audit;
 *   - a declared reuse entry that no inspected file references is a WARNING.
 *
 * Population: every file the completion audit cites (code/test citations,
 * including carried-forward items) plus `filesChanged` from the plan's
 * work-item completions. Files outside both are NOT inspected, and the report
 * says so. Only JavaScript and TypeScript imports are read (static import,
 * export-from, require(), dynamic import(), subpaths); Rust crates are covered
 * at activation by the library checks (R-5).
 *
 * Baseline: the dependency set recorded on the latest activation-phase
 * plan_audits row (`activation.declarationsCheck.dependencyBaseline`). With no
 * baseline, an undeclared package is UNVERIFIED, never refused.
 */
import { builtinModules } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { astGrepFacade, type AstGrepLanguage } from '../../code-intelligence/ast-grep-facade';
import type { CodeIntelAnswer } from '../../code-intelligence/contracts';
import {
  normalisePackageName,
  parseReuseRef,
  type LibrariesDeclaration,
  type ReuseDeclaration,
  type ReuseRefKind,
} from './plan-declarations';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, AstGrepLanguage>> = {
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
};

/** The ast-grep grammar for a JS/TS path, or null for any other file. */
export function importLanguageFor(path: string): AstGrepLanguage | null {
  const extension = /\.[^./]+$/.exec(path)?.[0];
  return extension ? LANGUAGE_BY_EXTENSION[extension] ?? null : null;
}

/**
 * Every JS/TS import form D-013 #4 names. Measured against ast-grep 0.45.1:
 * `import $$$ from $S` matches default, named, namespace, type-only and
 * side-effect imports; export-from only matches with the specifier written
 * inside quotes, so both quote styles are listed.
 */
export const JS_IMPORT_PATTERNS: readonly string[] = [
  'import $$$ from $S',
  'require($S)',
  'import($S)',
  ...(["'", '"'] as const).flatMap((q) => [
    `export * from ${q}$S${q}`,
    `export * as $N from ${q}$S${q}`,
    `export { $$$ } from ${q}$S${q}`,
    `export type { $$$ } from ${q}$S${q}`,
  ]),
];

/** The module specifier of one matched import, or null when it is not a string literal. */
export function specifierFromImportText(text: string): string | null {
  const trimmed = text.trim();
  if (/^(?:require|import)\s*\(/.test(trimmed)) {
    const call = /^(?:require|import)\s*\(\s*(['"`])([^'"`$]+)\1\s*[,)]/.exec(trimmed);
    return call ? call[2]! : null;
  }
  const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(trimmed);
  if (from) return from[2]!;
  const bare = /^import\s*(['"])([^'"]+)\1/.exec(trimmed);
  return bare ? bare[2]! : null;
}

export type SpecifierKind = 'relative' | 'builtin' | 'alias' | 'workspace' | 'third-party';

const NODE_BUILTINS: ReadonlySet<string> = new Set(builtinModules);

/** Classify a specifier; `package` is the normalised package name for package specifiers. */
export function classifySpecifier(
  specifier: string,
  workspacePackages: ReadonlySet<string>,
): { kind: SpecifierKind; package?: string } {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return { kind: 'relative' };
  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0]!)) return { kind: 'builtin' };
  // URL schemes (virtual:, bun:), subpath imports (#x) and the repo's path aliases are not packages.
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) || specifier.startsWith('#') || specifier.startsWith('@/') || specifier.startsWith('~/')) {
    return { kind: 'alias' };
  }
  const pkg = normalisePackageName(specifier);
  return workspacePackages.has(pkg) ? { kind: 'workspace', package: pkg } : { kind: 'third-party', package: pkg };
}

export interface ImportSite {
  path: string;
  line1: number | null;
  specifier: string;
}

/** One structural search; the default runs the ast-grep facade (read-only). */
export type ImportSearch = (input: {
  pattern: string;
  language: AstGrepLanguage;
  paths: string[];
  rootPath: string;
}) => Promise<Pick<CodeIntelAnswer, 'sites' | 'error' | 'truncation'>>;

const defaultImportSearch: ImportSearch = ({ pattern, language, paths, rootPath }) =>
  astGrepFacade('search', { pattern, language, paths, rootPath });

/** Files per ast-grep invocation: small enough that the facade's site cap is not reached. */
const IMPORT_BATCH_SIZE = 20;

/**
 * Read the imports of JS/TS files. A batch whose search failed or was truncated
 * is reported in `unread`, so a partial read is never mistaken for "no imports".
 */
export async function readJsImports(input: {
  files: readonly string[];
  repoRoot: string;
  search?: ImportSearch;
}): Promise<{ imports: ImportSite[]; unread: Array<{ path: string; reason: string }> }> {
  const search = input.search ?? defaultImportSearch;
  const byLanguage = new Map<AstGrepLanguage, string[]>();
  for (const file of input.files) {
    const language = importLanguageFor(file);
    if (language) byLanguage.set(language, [...(byLanguage.get(language) ?? []), file]);
  }
  const imports: ImportSite[] = [];
  const unread: Array<{ path: string; reason: string }> = [];
  for (const [language, files] of byLanguage) {
    for (let start = 0; start < files.length; start += IMPORT_BATCH_SIZE) {
      const batch = files.slice(start, start + IMPORT_BATCH_SIZE);
      const batchSet = new Set(batch);
      const answers = await Promise.all(JS_IMPORT_PATTERNS.map((pattern) =>
        search({ pattern, language, paths: batch, rootPath: input.repoRoot })
          .catch((error: unknown) => ({ sites: [], error: error instanceof Error ? error.message : String(error), truncation: { truncated: false, totalAvailable: null, continuation: null } }))));
      const failure = answers.find((answer) => answer.error || answer.truncation?.truncated);
      if (failure) {
        const reason = failure.error ? `import read failed: ${failure.error}` : 'import read truncated';
        for (const path of batch) unread.push({ path, reason });
        continue;
      }
      const seen = new Set<string>();
      for (const answer of answers) {
        for (const site of answer.sites) {
          const specifier = specifierFromImportText(site.detail ?? '');
          if (!specifier || !batchSet.has(site.path)) continue;
          const key = `${site.path}\u0000${site.line1}\u0000${specifier}`;
          if (seen.has(key)) continue;
          seen.add(key);
          imports.push({ path: site.path, line1: site.line1 ?? null, specifier });
        }
      }
    }
  }
  return { imports, unread };
}

export interface DependencyBaseline {
  /** Every dependency name declared in a workspace manifest at activation. */
  packages: string[];
  manifests: number;
  capturedAt: string;
}

/** The baseline recorded by an activation audit, or null when there is none. */
export function dependencyBaselineFrom(activation: unknown): DependencyBaseline | null {
  const check = (activation as { declarationsCheck?: { dependencyBaseline?: unknown } } | null | undefined)?.declarationsCheck;
  const baseline = check?.dependencyBaseline as Partial<DependencyBaseline> | undefined;
  if (!baseline || !Array.isArray(baseline.packages)) return null;
  return {
    packages: baseline.packages.filter((name): name is string => typeof name === 'string'),
    manifests: typeof baseline.manifests === 'number' ? baseline.manifests : 0,
    capturedAt: typeof baseline.capturedAt === 'string' ? baseline.capturedAt : '',
  };
}

export interface ShipCheckBlocker {
  code: 'undeclared_third_party_package';
  package: string;
  files: string[];
}

export interface ReuseReferenceWarning {
  ref: string;
  kind: ReuseRefKind;
  detail: string;
}

export interface LibraryShipCheckReport {
  status: 'pass' | 'refuse' | 'unverified';
  blockers: ShipCheckBlocker[];
  /** Why part of the check could not be decided; never refuses. */
  unverified: string[];
  warnings: ReuseReferenceWarning[];
  /** Third-party packages found, and what admitted each. */
  packages: Array<{ package: string; admittedBy: 'libraries-section' | 'activation-baseline' | 'none'; files: string[] }>;
  inspected: string[];
  notInspected: Array<{ path: string; reason: string }>;
  scope: string;
}

export const SHIP_CHECK_SCOPE =
  'Only the files this completion audit cites and the filesChanged of the plan\'s work-item completions are inspected; ' +
  'other files are not. Only JavaScript/TypeScript imports are read.';

const MAX_REFERENCE_TEXT_BYTES = 1024 * 1024;

function defaultReadText(absolutePath: string): string | null {
  try {
    if (!statSync(absolutePath).isFile() || statSync(absolutePath).size > MAX_REFERENCE_TEXT_BYTES) return null;
    return readFileSync(absolutePath, 'utf8');
  } catch {
    return null;
  }
}

function basenameStem(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

/**
 * Is a reuse entry referenced by the inspected population? Textual by design:
 * the warning asks the auditor to look, it never refuses.
 */
function reuseEntryReferenced(
  entry: { ref: string; kind: ReuseRefKind },
  files: ReadonlyArray<{ path: string; text: string | null }>,
  importedPackages: ReadonlySet<string>,
): boolean {
  const parsed = parseReuseRef(entry.kind, entry.ref);
  if (!parsed.ok) return true; // malformed entries were refused at activation; nothing to warn about here
  const ref = parsed.parsed;
  const contains = (needle: string) => needle.length > 0 && files.some((file) => file.text?.includes(needle));
  switch (ref.kind) {
    case 'file':
      return files.some((file) => file.path === ref.path || file.path.startsWith(`${ref.path}/`)) || contains(basenameStem(ref.path!));
    case 'symbol':
      return files.some((file) => file.path === ref.path) || contains(ref.symbol!.split('.').pop()!);
    case 'package':
      return importedPackages.has(ref.name!) || contains(ref.name!);
    case 'table':
      return contains(`${ref.schema}.${ref.table}`) || contains(ref.table!);
    case 'tool':
    case 'routine':
    case 'doc':
      return contains(ref.name!);
  }
}

/**
 * Decide the ship check. Pure apart from the injected import search and file
 * reader, so the unit cases run against fixture files.
 */
export async function runLibraryShipCheck(input: {
  /** Population: cited files and work-item filesChanged, repo-relative. */
  files: readonly string[];
  repoRoot: string;
  libraries: LibrariesDeclaration | null;
  reuse: ReuseDeclaration | null;
  baseline: DependencyBaseline | null;
  workspacePackages: ReadonlySet<string>;
  search?: ImportSearch;
  readText?: (absolutePath: string) => string | null;
}): Promise<LibraryShipCheckReport> {
  const readText = input.readText ?? defaultReadText;
  const population = [...new Set(input.files.map((file) => file.replace(/^\.\//, '')))].sort();
  const notInspected: Array<{ path: string; reason: string }> = [];
  const present: string[] = [];
  for (const path of population) {
    if (existsSync(resolve(input.repoRoot, path))) present.push(path);
    else notInspected.push({ path, reason: 'not present in the tree' });
  }
  const jsFiles = present.filter((path) => importLanguageFor(path) !== null);
  for (const path of present) {
    if (importLanguageFor(path) === null) notInspected.push({ path, reason: 'not JavaScript/TypeScript (imports not read)' });
  }

  const { imports, unread } = await readJsImports({ files: jsFiles, repoRoot: input.repoRoot, search: input.search });
  const unreadPaths = new Set(unread.map((entry) => entry.path));
  notInspected.push(...unread);
  const inspected = jsFiles.filter((path) => !unreadPaths.has(path));

  const thirdParty = new Map<string, Set<string>>();
  const importedPackages = new Set<string>();
  for (const site of imports) {
    const classified = classifySpecifier(site.specifier, input.workspacePackages);
    if (classified.package) importedPackages.add(classified.package);
    if (classified.kind !== 'third-party') continue;
    const files = thirdParty.get(classified.package!) ?? new Set<string>();
    files.add(site.path);
    thirdParty.set(classified.package!, files);
  }

  const declared = new Set((input.libraries?.needs ?? [])
    .flatMap((need) => (need.package ? [normalisePackageName(need.package)] : [])));
  const baseline = input.baseline ? new Set(input.baseline.packages.map(normalisePackageName)) : null;
  const blockers: ShipCheckBlocker[] = [];
  const unverified: string[] = [];
  const packages: LibraryShipCheckReport['packages'] = [];
  for (const [pkg, fileSet] of [...thirdParty].sort(([a], [b]) => a.localeCompare(b))) {
    const files = [...fileSet].sort();
    if (declared.has(pkg)) packages.push({ package: pkg, admittedBy: 'libraries-section', files });
    else if (baseline?.has(pkg)) packages.push({ package: pkg, admittedBy: 'activation-baseline', files });
    else {
      packages.push({ package: pkg, admittedBy: 'none', files });
      if (baseline) blockers.push({ code: 'undeclared_third_party_package', package: pkg, files });
      else unverified.push(`${pkg}: no activation dependency baseline, so whether it is new cannot be decided`);
    }
  }
  if (unread.length > 0) unverified.push(`${unread.length} file(s) whose imports could not be read: ${unread[0]!.reason}`);

  const warnings: ReuseReferenceWarning[] = [];
  if (input.reuse && input.reuse.notApplicable === null && input.reuse.reused.length > 0) {
    const texts = present.map((path) => ({ path, text: readText(resolve(input.repoRoot, path)) }));
    for (const entry of input.reuse.reused) {
      if (!reuseEntryReferenced(entry, texts, importedPackages)) {
        warnings.push({ ref: entry.ref, kind: entry.kind, detail: 'declared as reused, but no inspected file references it' });
      }
    }
  }

  const status: LibraryShipCheckReport['status'] =
    blockers.length > 0 ? 'refuse' : unverified.length > 0 ? 'unverified' : 'pass';
  return { status, blockers, unverified, warnings, packages, inspected, notInspected, scope: SHIP_CHECK_SCOPE };
}
