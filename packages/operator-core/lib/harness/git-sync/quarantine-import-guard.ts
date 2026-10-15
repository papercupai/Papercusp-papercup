/**
 * The git-sync QUARANTINE-IMPORT guard (EI-19932544083689229 remedy #1 — ATOMICITY).
 *
 * content-guard.ts and deletion-import-guard.ts already EXCLUDE ("quarantine") a
 * broken dirty file from this commit's `git add -A` (D-001: quarantine-don't-stall).
 * But quarantining a file P ALONE is unsafe when this SAME commit also contains a
 * clean file that imports P: the importer commits (nothing wrong with ITS text),
 * P does not (still dirty on disk), and HEAD now carries an unresolvable relative
 * import with no local recovery — every ISOLATED checkout (what green-checkpoint
 * builds candidates from) gets the importer WITHOUT its subject and fails
 * deterministically on every candidate, forever, while every standard staleness
 * probe reads "stale red, ignore it" (the working tree still has P sitting right
 * there, undetectably to `git log`/`git status`, which know nothing about it).
 *
 * MEASURED LIVE 2026-08-09 (EI-19932544083689229): content-guard quarantined a
 * NUL-byte source (`cup-spawn-health-watchdog.ts`); its clean sibling
 * `cup-spawn-health-watchdog.test.ts` — which `import`s it via a relative
 * specifier — committed anyway. This red-pinned the fleet's release gate for ~6h.
 * Neither content-guard (per-file, never looks at OTHER dirty files) nor
 * deletion-import-guard (only checks DELETIONS, not quarantines) catches this — it
 * needs a THIRD cross-file check: does any surviving dirty file import an
 * ALREADY-QUARANTINED file?
 *
 * Mirrors deletion-import-guard's shape and reuses its specifier extraction/
 * resolution helpers, but:
 *   - the "at risk" set is the QUARANTINED-OFFENDER set (oversized + content +
 *     deletion offenders already computed this tick), not deletions;
 *   - candidates are drawn from THIS TICK's DIRTY files only (an already-committed
 *     importer sitting in HEAD cannot import a file that has never been committed —
 *     there is nothing to protect there), never a repo-wide `git grep` — cheaper
 *     and exactly scoped to the class this guard exists for;
 *   - it runs to a FIXED POINT so a chain (C imports B imports quarantined A) is
 *     caught too, not just the direct importer (quarantine the WHOLE infected
 *     component, never just one edge of it).
 *
 * Feeds the SAME `ContentOffender`/exclude-pathspec pipeline `commitOneRepo`
 * already wires through content-guard + deletion-guard — no new commit-path
 * plumbing. Same fail-open posture throughout: a read error skips that file,
 * never blocks the commit (a guard bug must never wedge the whole fleet's commit).
 */
import type { ContentOffender } from './content-guard';
import { posix } from 'node:path';
import { resolveRelativeSpecifier, normalizeModulePath, RESOLVABLE_EXTS } from './deletion-import-guard';

export interface QuarantineImportGuardDeps {
  /** Read a repo-relative file's CURRENT working-tree text; null when unreadable/gone
   *  (a deletion in the dirty set, or a genuinely unreadable file — either way, nothing
   *  to scan for imports). */
  readText: (relPath: string) => Promise<string | null>;
  /** The dirty file paths under consideration for THIS commit (same path-space as
   *  content-guard/deletion-guard's `git status --porcelain -z -uall` listing — may
   *  include deletions; `readText` naturally returns null for those and they're
   *  skipped). */
  dirtyFiles: string[];
  /** Paths ALREADY excluded from this commit before this guard runs (oversized +
   *  content-guard + deletion-guard offenders) — the "infectious" set an importer
   *  must be held back alongside. */
  alreadyQuarantined: string[];
  /** Legacy HEAD-presence seam, used only for side-effect imports. A named
   *  consumer can require a new export even when the old provider exists at HEAD. */
  isResolvableAtHead?: (relPath: string) => Promise<boolean>;
  /** WI-10006940: whether the TARGET of a bare side-effect import (`import './x'`)
   *  is present in HEAD. A side-effect import consumes no symbols, so when its target
   *  is tracked in HEAD, committing the importer leaves HEAD resolvable and
   *  type-consistent even though the target's own edit is held back. When provided,
   *  a side-effect-ONLY edge propagates the hold only when its target is ABSENT from
   *  HEAD (or the check fails — fail safe). Binding edges (`from`, dynamic `import()`,
   *  `require`) keep the conservative rule. Omitted ⇒ every edge is infectious (the
   *  historical behavior). Without this, a registration hub (agent-tools/index.ts,
   *  all bare `import './…'`) bridged ANY peer's lock on one tool file into every
   *  route that imports the hub for registration. */
  sideEffectTargetAtHead?: (relPath: string) => Promise<boolean>;
  /** Human-readable source of the exclusion for the diagnostic; defaults to the
   *  historical content/deletion guard wording. */
  exclusionLabel?: string;
  /** WI-6554700010008496: why one seeded path was excluded (e.g. "turn hold by
   *  su-ab12 …"). Each importer finding carries its chain root's reason; a path
   *  this does not answer falls back to `exclusionLabel`. */
  exclusionReasonFor?: (relPath: string) => string | undefined;
  log?: (m: string) => void;
}

/** Bounded-concurrency map (avoid a serial fs loop — CLAUDE.md perf anti-patterns). */
async function mapPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      await fn(items[idx]);
    }
  });
  await Promise.all(workers);
}

const MAX_READ_CONCURRENCY = 16;

/** Only resolvable JS/TS source is worth scanning for import specifiers — mirrors
 *  deletion-import-guard's `isCheckedModuleDeletion` extension gate (no `.d.ts`, since
 *  a type-only declaration file is not what breaks a runtime `import`). */
function isScannableCandidate(path: string): boolean {
  if (path.endsWith('.d.ts')) return false;
  return RESOLVABLE_EXTS.some((ext) => path.endsWith(ext));
}

const GENERATED_DECLARATION_BANNER = '// GENERATED by `npm run gen:declarations`';

function declarationForMjs(source: string): string | null {
  return source.endsWith('.mjs') ? source.replace(/\.mjs$/, '.d.mts') : null;
}

function isGeneratedDeclarationFor(text: string, source: string): boolean {
  return text.split(/\r?\n/).some((line) =>
    line.startsWith(GENERATED_DECLARATION_BANNER) && line.includes(` from ${source}. DO NOT EDIT.`),
  );
}

const BARE_SIDE_EFFECT_IMPORT_RE = /(?:^|[;{}])[ \t]*import[ \t]*['"]([^'"]+)['"]/gm;
const BINDING_IMPORT_RE =
  /from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function extractImportSpecifiers(text: string): string[] {
  const specs = new Set<string>();
  const re = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(re)) specs.add(match[1] ?? match[2]);
  return [...specs];
}

interface RepositoryPackage { root: string; name: string; exports: Record<string, unknown> }

/** Preserve runtime condition alternatives; declaration-only targets do not run. */
function runtimeExportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(runtimeExportTargets);
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).filter(([key]) => key !== 'types').flatMap(([, target]) => runtimeExportTargets(target));
}

function resolvePackageSpecifier(pkg: RepositoryPackage, spec: string): string[] {
  const key = spec === pkg.name ? '.' : spec.startsWith(pkg.name + '/') ? './' + spec.slice(pkg.name.length + 1) : null;
  if (key === null) return [];
  let selected = pkg.exports[key];
  let wildcard = '';
  if (!(key in pkg.exports)) {
    // Match the most specific declared export, including null blockers.
    const patterns = Object.keys(pkg.exports).filter(pattern => pattern.includes('*'))
      .sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length);
    for (const pattern of patterns) {
      const [prefix, suffix] = pattern.split('*');
      if (key.startsWith(prefix) && key.endsWith(suffix) && key.length >= prefix.length + suffix.length) {
        selected = pkg.exports[pattern];
        wildcard = key.slice(prefix.length, suffix.length ? -suffix.length : undefined);
        break;
      }
    }
  }
  return runtimeExportTargets(selected).flatMap(target => {
    if (!target.startsWith('./')) return [];
    const path = posix.normalize(posix.join(pkg.root, target.replaceAll('*', wildcard)));
    if (pkg.root !== '.' && !path.startsWith(pkg.root + '/')) return [];
    return [normalizeModulePath(path)];
  });
}

/**
 * Specifiers that a file reaches ONLY through bare side-effect imports
 * (`import './x';`). A specifier that also appears in any binding form (`from`,
 * `export … from`, dynamic `import()`, `require`) is excluded — the conservative
 * reading wins whenever a file consumes symbols from the module anywhere.
 */
export function extractSideEffectOnlySpecifiers(text: string): Set<string> {
  const bare = new Set<string>();
  for (const m of text.matchAll(BARE_SIDE_EFFECT_IMPORT_RE)) bare.add(m[1]);
  if (bare.size === 0) return bare;
  for (const m of text.matchAll(BINDING_IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) bare.delete(spec);
  }
  return bare;
}

/**
 * Detect dirty files that (transitively) import an already-quarantined path. Returns
 * `ContentOffender`-shaped records so `commitOneRepo` can fold them into the SAME
 * exclude/quarantine/escalation pipeline as an oversized blob, a broken .mdx, or an
 * unsafe deletion — no new commit-path plumbing.
 */
export async function detectQuarantineImporters(deps: QuarantineImportGuardDeps): Promise<ContentOffender[]> {
  const {
    readText,
    dirtyFiles,
    alreadyQuarantined,
    isResolvableAtHead,
    sideEffectTargetAtHead,
    exclusionLabel = 'content/deletion guard',
    exclusionReasonFor,
    log,
  } = deps;
  if (alreadyQuarantined.length === 0) return [];
  // File existence does not prove that an old provider exports a consumer's new
  // symbols. Only a side-effect-only edge may use the HEAD-presence exemption.
  const infectiousPaths = [...new Set(alreadyQuarantined)];
  const dirty = new Set(dirtyFiles);
  const pairedDeclarations: Array<{ path: string; source: string }> = [];
  await mapPool(infectiousPaths, MAX_READ_CONCURRENCY, async (source) => {
    const declaration = declarationForMjs(source);
    if (!declaration || !dirty.has(declaration)) return;
    try {
      const text = await readText(declaration);
      if (text !== null && isGeneratedDeclarationFor(text, source)) {
        pairedDeclarations.push({ path: declaration, source });
      }
    } catch (e) {
      log?.(`[quarantine-import-guard] could not read generated declaration ${declaration} paired with held source ${source} — skipping (not blocking): ${errMsg(e)}`);
    }
  });
  for (const pair of pairedDeclarations) infectiousPaths.push(pair.path);
  const headTarget = sideEffectTargetAtHead ?? isResolvableAtHead;
  // Resolve package aliases from the provider's own manifest. Do not infer a
  // package directory from its name or substitute an installed dependency.
  const packages = new Map<string, RepositoryPackage>();
  const manifests = new Map<string, Promise<RepositoryPackage | null>>();
  const registerPackage = async (path: string) => {
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      let pending = manifests.get(dir);
      if (!pending) {
        pending = (async () => {
          try {
            const text = await readText(posix.join(dir, 'package.json'));
            if (text === null) return null;
            const manifest = JSON.parse(text);
            if (typeof manifest.name !== 'string' || !manifest.exports) return null;
            const declared = manifest.exports;
            const exports = typeof declared === 'object' && !Array.isArray(declared)
              && Object.keys(declared).some(key => key.startsWith('.')) ? declared : { '.': declared };
            return { root: dir, name: manifest.name, exports };
          } catch { return null; }
        })();
        manifests.set(dir, pending);
      }
      const pkg = await pending;
      if (pkg) { packages.set(pkg.root, pkg); return; }
      if (dir === '.') return;
    }
  };
  await mapPool(infectiousPaths, MAX_READ_CONCURRENCY, registerPackage);

  const quarantined = new Set(infectiousPaths);
  // Normalized targets an importer's resolved specifier must match — precomputed once.
  const quarantinedNormalized = new Set(infectiousPaths.map((p) => normalizeModulePath(p)));

  const candidates = [...new Set(dirtyFiles)].filter((f) => isScannableCandidate(f) && !quarantined.has(f));
  // A paired generated declaration is itself an offender (emitted below) even when no other
  // dirty file remains to scan — short-circuiting on `candidates` alone silently dropped it.
  if (candidates.length === 0 && pairedDeclarations.length === 0) return [];

  // Read every candidate's specifiers ONCE (fixed-point iteration below reuses this —
  // no re-reading a file just because it wasn't infected on an earlier pass).
  const specsByFile = new Map<string, string[]>();
  const sideEffectOnlyByFile = new Map<string, Set<string>>();
  await mapPool(candidates, MAX_READ_CONCURRENCY, async (file) => {
    let text: string | null;
    try {
      text = await readText(file);
    } catch (e) {
      log?.(`[quarantine-import-guard] could not read ${file} — skipping (not blocking): ${errMsg(e)}`);
      return;
    }
    if (text == null) return; // gone/unreadable (e.g. a deletion in the dirty set)
    specsByFile.set(file, extractImportSpecifiers(text));
    if (headTarget) sideEffectOnlyByFile.set(file, extractSideEffectOnlySpecifiers(text));
  });

  // Actual repo path behind each normalized infectious target, so a side-effect edge
  // can ask HEAD about the real file (seeded paths + importers quarantined below).
  const actualPathByNormalized = new Map<string, string>();
  for (const p of infectiousPaths) {
    const n = normalizeModulePath(p);
    if (!actualPathByNormalized.has(n)) actualPathByNormalized.set(n, p);
  }
  // WI-6554700010008496: the excluded path at the bottom of each chain. A seeded path
  // is its own root; an importer held below inherits the root of the file it imports,
  // so a finding three hops down still names the one file that actually blocks it.
  const pairSourceByDeclaration = new Map(pairedDeclarations.map(({ path, source }) => [path, source]));
  const rootByPath = new Map<string, string>(
    infectiousPaths.map((p) => [p, pairSourceByDeclaration.get(p) ?? p]),
  );
  const rootReason = (root: string): string => {
    const reason = exclusionReasonFor?.(root)?.trim();
    return reason ? reason : exclusionLabel;
  };
  const headPresence = new Map<string, Promise<boolean>>();
  const targetPresentAtHead = (path: string): Promise<boolean> => {
    let cached = headPresence.get(path);
    if (!cached) {
      cached = (headTarget as (p: string) => Promise<boolean>)(path).catch((e) => {
        log?.(`[quarantine-import-guard] could not check side-effect target ${path} in HEAD — treating it as absent (fail safe): ${errMsg(e)}`);
        return false;
      });
      headPresence.set(path, cached);
    }
    return cached;
  };

  const offenders: ContentOffender[] = pairedDeclarations.map(({ path, source }) => {
    const reason = rootReason(source);
    return {
      file: path,
      detectorKey: 'quarantined-importer',
      error:
        `generated declaration '${path}' is paired with source '${source}', which is EXCLUDED from this commit (${reason}). ` +
        `Holding the declaration back until its source is resolved so the source/declaration pair lands together.`,
      fixerRole: 'content-fixer',
      excludedRoot: source,
      excludedRootReason: reason,
    };
  });
  // Fixed point: newly-quarantined importers can themselves be imported by another
  // dirty file, so keep sweeping until a pass adds nothing new.
  let changed = true;
  while (changed) {
    changed = false;
    for (const file of candidates) {
      if (quarantined.has(file)) continue;
      const specs = specsByFile.get(file);
      if (!specs || specs.length === 0) continue;
      const sideEffectOnly = sideEffectOnlyByFile.get(file);
      for (const spec of specs) {
        const targets = spec.startsWith('.') ? [resolveRelativeSpecifier(file, spec)]
          : [...packages.values()].flatMap(pkg => resolvePackageSpecifier(pkg, spec));
        const resolved = targets.find(target => quarantinedNormalized.has(target));
        if (!resolved) continue;
        // Which quarantined path this resolves to (for the error message — several
        // could normalize the same; report the first match).
        const target = actualPathByNormalized.get(resolved) ?? resolved;
        // WI-10006940: a bare side-effect import consumes no symbols — it only needs
        // the target to EXIST in HEAD. Propagate through it only when it does not.
        if (sideEffectOnly?.has(spec) && (await targetPresentAtHead(target))) continue;
        quarantined.add(file);
        await registerPackage(file);
        const fileNormalized = normalizeModulePath(file);
        quarantinedNormalized.add(fileNormalized);
        if (!actualPathByNormalized.has(fileNormalized)) actualPathByNormalized.set(fileNormalized, file);
        const root = rootByPath.get(target) ?? target;
        rootByPath.set(file, root);
        const reason = rootReason(root);
        const exclusion =
          root === target ? reason : `held back because it imports, via its own chain, '${root}' — ${reason}`;
        offenders.push({
          file,
          detectorKey: 'quarantined-importer',
          error:
            `imports '${spec}' → '${target}', which is EXCLUDED from this commit (${exclusion}). ` +
            `Committing this file alone could leave HEAD without the dependency changes its import needs — ` +
            `holding it back until '${root}' is resolved.`,
          fixerRole: 'content-fixer',
          excludedRoot: root,
          excludedRootReason: reason,
        });
        changed = true;
        break; // one match is enough to quarantine this file; move to the next candidate
      }
    }
  }
  return offenders;
}

interface BoundModuleReference {
  specifier: string;
  names: string[];
}

/** Binding imports/re-exports consume names from a provider; side-effect imports do not. */
function extractBoundModuleReferences(text: string): BoundModuleReference[] {
  const bySpecifier = new Map<string, Set<string>>();
  const add = (specifier: string, names: Iterable<string>) => {
    let set = bySpecifier.get(specifier);
    if (!set) bySpecifier.set(specifier, set = new Set());
    for (const name of names) set.add(name);
  };
  const declarations = /\b(?:import|export)\s+(?:type\s+)?([^;'\"]*?)\s+from\s*['\"]([^'\"]+)['\"]/g;
  for (const match of text.matchAll(declarations)) {
    const clause = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\r\n]*/g, '')
      .trim();
    const names = new Set<string>();
    const named = /\{([^}]*)\}/.exec(clause);
    if (named) {
      const defaultBinding = clause.slice(0, named.index).replace(/,\s*$/, '').trim();
      if (defaultBinding) names.add('default');
      for (const entry of named[1].split(',')) {
        const imported = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (imported) names.add(imported);
      }
    } else if (clause.startsWith('*')) {
      names.add('*');
    } else if (clause) {
      names.add('default');
    }
    if (names.size > 0) add(match[2], names);
  }
  // Dynamic imports and CommonJS require expose a module namespace to the caller.
  for (const match of text.matchAll(/\bimport\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g)) add(match[1], ['*']);
  for (const match of text.matchAll(/\brequire\s*\(\s*['\"]([^'\"]+)['\"]\s*\)/g)) add(match[1], ['*']);
  return [...bySpecifier].map(([specifier, names]) => ({ specifier, names: [...names] }));
}

interface ExportSurface {
  names: Set<string>;
  starSources: Set<string>;
}

/** Names the current file directly exports; star re-exports remain opaque but tracked. */
function extractExportSurface(text: string): ExportSurface {
  const names = new Set<string>();
  const starSources = new Set<string>();
  const declarations = /\bexport\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of text.matchAll(declarations)) names.add(match[1]);
  if (/\bexport\s+default\b/.test(text) || /\bexport\s*=\s*/.test(text)) names.add('default');
  const lists = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['\"][^'\"]+['\"])?/g;
  for (const match of text.matchAll(lists)) {
    for (const entry of match[1].split(',')) {
      const namesInEntry = entry.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      const exported = (namesInEntry[1] ?? namesInEntry[0]).trim();
      if (exported) names.add(exported);
    }
  }
  const stars = /\bexport\s+\*\s*(?:(?:as)\s+([A-Za-z_$][\w$]*)\s+)?from\s*['\"]([^'\"]+)['\"]/g;
  for (const match of text.matchAll(stars)) {
    if (match[1]) names.add(match[1]);
    else starSources.add(match[2]);
  }
  return { names, starSources };
}

function removedConsumedExports(names: string[], before: ExportSurface, after: ExportSurface): string[] {
  if (names.includes('*')) {
    const removed = [...before.names].filter(name => !after.names.has(name));
    for (const source of before.starSources) {
      if (!after.starSources.has(source)) removed.push(`* from ${source}`);
    }
    return removed;
  }
  return names.filter(name => {
    const wasExported = before.names.has(name) || (name !== 'default' && before.starSources.size > 0);
    if (!wasExported || after.names.has(name)) return false;
    // A name supplied only through the same star edge remains opaque but stable.
    return name === 'default' || ![...before.starSources].some(source => after.starSources.has(source));
  });
}

export interface StagedProviderGuardDeps {
  /** Paths present in the exact commit index, not merely the working tree. */
  stagedFiles: string[];
  /** Excluded/held paths plus importers quarantined by the forward guard. */
  heldImporters: string[];
  /** Read a path from the current HEAD tree; null when absent or unreadable. */
  readHeadText: (relPath: string) => Promise<string | null>;
  /** Read a path from this commit's exact index; null when absent or unreadable. */
  readIndexText: (relPath: string) => Promise<string | null>;
  log?: (message: string) => void;
}

/**
 * Hold staged providers that remove exports still consumed by a held importer's HEAD
 * version. This is the reverse edge of detectQuarantineImporters: after a working-tree
 * importer is excluded, HEAD keeps its old imports, so a provider must not publish an
 * incompatible API by itself. New providers discovered here join the held set and are
 * scanned to a fixed point. Only module-source paths and statically resolvable package or
 * relative specifiers are considered; uncertain reads fail open like the forward guard.
 */
export async function detectStagedProvidersOfHeldImporters(
  deps: StagedProviderGuardDeps,
): Promise<ContentOffender[]> {
  const stagedFiles = [...new Set(deps.stagedFiles)].filter(isScannableCandidate);
  const heldQueue = [...new Set(deps.heldImporters)].filter(isScannableCandidate);
  if (stagedFiles.length === 0 || heldQueue.length === 0) return [];

  const stagedByModule = new Map<string, string[]>();
  for (const path of stagedFiles) {
    const key = normalizeModulePath(path);
    const paths = stagedByModule.get(key) ?? [];
    paths.push(path);
    stagedByModule.set(key, paths);
  }

  const headCache = new Map<string, Promise<string | null>>();
  const indexCache = new Map<string, Promise<string | null>>();
  const readHeadText = (path: string): Promise<string | null> => {
    let pending = headCache.get(path);
    if (!pending) {
      pending = deps.readHeadText(path).catch(error => {
        deps.log?.(`[quarantine-provider-guard] could not read HEAD ${path} — skipping (fail open): ${errMsg(error)}`);
        return null;
      });
      headCache.set(path, pending);
    }
    return pending;
  };
  const readIndexText = (path: string): Promise<string | null> => {
    let pending = indexCache.get(path);
    if (!pending) {
      pending = deps.readIndexText(path).catch(error => {
        deps.log?.(`[quarantine-provider-guard] could not read index ${path} — skipping (fail open): ${errMsg(error)}`);
        return null;
      });
      indexCache.set(path, pending);
    }
    return pending;
  };

  // Resolve package aliases against HEAD's manifest: the held importer is the old HEAD
  // text, so its old package export map defines where that specifier points.
  const packages = new Map<string, RepositoryPackage>();
  const manifestReads = new Map<string, Promise<RepositoryPackage | null>>();
  const registerHeadPackage = async (path: string) => {
    for (let dir = posix.dirname(path); ; dir = posix.dirname(dir)) {
      let pending = manifestReads.get(dir);
      if (!pending) {
        pending = (async () => {
          try {
            const text = await readHeadText(posix.join(dir, 'package.json'));
            if (text === null) return null;
            const manifest = JSON.parse(text);
            if (typeof manifest.name !== 'string' || !manifest.exports) return null;
            const declared = manifest.exports;
            const exports = typeof declared === 'object' && !Array.isArray(declared)
              && Object.keys(declared).some(key => key.startsWith('.')) ? declared : { '.': declared };
            return { root: dir, name: manifest.name, exports };
          } catch { return null; }
        })();
        manifestReads.set(dir, pending);
      }
      const pkg = await pending;
      if (pkg) { packages.set(pkg.root, pkg); return; }
      if (dir === '.') return;
    }
  };
  await mapPool(stagedFiles, MAX_READ_CONCURRENCY, registerHeadPackage);

  const heldSet = new Set(heldQueue);
  const offenders = new Map<string, ContentOffender>();
  for (let cursor = 0; cursor < heldQueue.length; cursor++) {
    const importer = heldQueue[cursor];
    const headText = await readHeadText(importer);
    if (headText === null) continue;
    for (const reference of extractBoundModuleReferences(headText)) {
      const targets = reference.specifier.startsWith('.')
        ? [resolveRelativeSpecifier(importer, reference.specifier)]
        : [...packages.values()].flatMap(pkg => resolvePackageSpecifier(pkg, reference.specifier));
      const providers = [...new Set(targets.flatMap(target => stagedByModule.get(target) ?? []))];
      for (const provider of providers) {
        if (heldSet.has(provider)) continue;
        const [headProvider, stagedProvider] = await Promise.all([
          readHeadText(provider),
          readIndexText(provider),
        ]);
        if (headProvider === null || stagedProvider === null) continue;
        const removed = removedConsumedExports(
          reference.names,
          extractExportSurface(headProvider),
          extractExportSurface(stagedProvider),
        );
        if (removed.length === 0) continue;
        heldSet.add(provider);
        heldQueue.push(provider);
        offenders.set(provider, {
          file: provider,
          detectorKey: 'quarantined-provider',
          error:
            `the HEAD version of held importer '${importer}' still consumes ${removed.join(', ')} ` +
            `from '${reference.specifier}', but this staged provider removes those exports; ` +
            `holding the provider so HEAD cannot land with an unresolved import.`,
          fixerRole: 'content-fixer',
        });
      }
    }
  }
  return [...offenders.values()];
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
