import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { dbRefOriginLookup, isOwnerTurnVerdict } from '../../activation-item-provenance';
import { astGrepFacade, type AstGrepLanguage } from '../../code-intelligence/ast-grep-facade';
import { lspFacade } from '../../code-intelligence/lsp-facade';
import { indexDeclaredPackages, readWorkspaceManifests, type DeclaredPackageIndex } from '../../workspace-manifests';
import type { LibraryCheckDeps, ReferenceLookup, ReuseReferenceResolvers } from './plan-declarations';
import type { DependencyBaseline } from './plan-library-ship-check';

/**
 * Production lookups for the plan reuse reference resolver (R-4). Kept apart
 * from plan-declarations.ts so the lifecycle gate, which imports the schemas,
 * does not load the code-intelligence and tool-registry graphs.
 *
 *   file     → the tree (fs.stat under the plan's repo root)
 *   symbol   → lsp:query workspace symbols, ast-grep fallback
 *   tool     → the projected tool registry
 *   table    → the PG catalog (to_regclass)
 *   package  → workspace manifests (workspace-manifests.ts)
 *   routine  → harness_shared.routines by name
 *   doc      → harness_shared.harness_docs by slug
 *
 * Every lookup returns `unavailable` (→ "unverified") when its backend is down,
 * so a broken server never refuses a plan and never passes one as found.
 */

const AST_GREP_LANGUAGE_BY_EXT: Record<string, AstGrepLanguage> = {
  '.ts': 'ts', '.mts': 'ts', '.cts': 'ts', '.tsx': 'tsx',
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'jsx',
  '.rs': 'rust', '.py': 'python', '.pyi': 'python', '.go': 'go',
};
const LSP_TYPESCRIPT_EXTS = new Set(['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx']);

const unavailable = (reason: string): ReferenceLookup => ({ outcome: 'unavailable', reason });
const found = (via: string): ReferenceLookup => ({ outcome: 'found', via });
const notFound = (via: string): ReferenceLookup => ({ outcome: 'not-found', via });

function insideRoot(repoRoot: string, relPath: string): string | null {
  const abs = path.resolve(repoRoot, relPath);
  const rel = path.relative(repoRoot, abs);
  return rel.startsWith('..') || path.isAbsolute(rel) ? null : abs;
}

async function pathExists(repoRoot: string, relPath: string): Promise<ReferenceLookup> {
  const abs = insideRoot(repoRoot, relPath);
  if (!abs) return notFound('path escapes the repository root');
  try {
    const info = await stat(abs);
    return found(info.isDirectory() ? 'directory in the tree' : 'file in the tree');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return notFound('no such path in the tree');
    return unavailable(`tree read failed: ${code ?? String(error)}`);
  }
}

export interface DefaultReuseResolverOptions {
  /** Repository root the plan's paths are relative to (the citation root); null when it could not be resolved. */
  repoRoot: string | null;
  /** Operator database handle for the table, routine and doc lookups. */
  sql?: postgres.Sql<any> | null;
  workspaceId?: string | null;
}

/**
 * Production lookups for the library checks (R-5): the shared manifest walk, the
 * session-turn origin classifier the item-provenance check uses, and installed
 * dependencies' package descriptions for the researched-row advice. Any lookup
 * that cannot be built is null, which leaves its rows unverified.
 */
export async function defaultLibraryCheckDeps(options: DefaultReuseResolverOptions): Promise<LibraryCheckDeps> {
  const { repoRoot, sql, workspaceId } = options;
  const manifests = repoRoot ? await readWorkspaceManifests(repoRoot).catch(() => null) : null;
  const packages = manifests ? indexDeclaredPackages(manifests) : null;
  const lookupOrigins = sql && workspaceId ? dbRefOriginLookup(sql as Parameters<typeof dbRefOriginLookup>[0], workspaceId) : null;
  return {
    packages,
    ownerTurns: lookupOrigins
      ? async (refs) => {
          const verdicts = await lookupOrigins(refs);
          return new Map([...verdicts].map(([ref, verdict]) => [ref, isOwnerTurnVerdict(verdict) ? 'owner' as const : 'not-owner' as const]));
        }
      : null,
    dependencyDescriptions: manifests && repoRoot
      ? async () => {
          const names = [...new Set(manifests.filter((m) => m.ecosystem === 'npm').flatMap((m) => m.dependencies))];
          const entries = await Promise.all(names.map(async (name) => {
            try {
              const pkg = JSON.parse(await readFile(path.join(repoRoot, 'node_modules', name, 'package.json'), 'utf8')) as { description?: unknown };
              return typeof pkg.description === 'string' ? [name, pkg.description] as const : null;
            } catch {
              return null;
            }
          }));
          return new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null));
        }
      : null,
  };
}

export function defaultReuseReferenceResolvers(options: DefaultReuseResolverOptions): ReuseReferenceResolvers {
  const { repoRoot, sql } = options;
  let packageIndex: Promise<DeclaredPackageIndex> | null = null;
  const noRoot = unavailable('the plan\'s repository root could not be resolved');
  const packages = (root: string) => (packageIndex ??= readWorkspaceManifests(root).then(indexDeclaredPackages));

  return {
    file: async (ref) => (repoRoot ? pathExists(repoRoot, ref.path!) : noRoot),

    symbol: async (ref) => {
      if (!repoRoot) return noRoot;
      const file = ref.path!;
      const exists = await pathExists(repoRoot, file);
      if (exists.outcome !== 'found') return exists;
      const name = ref.symbol!.split('.').at(-1)!;
      const ext = path.extname(file).toLowerCase();
      let lspDetail = 'lsp not consulted for this language';
      if (LSP_TYPESCRIPT_EXTS.has(ext)) {
        try {
          const answer = await lspFacade('workspace_symbols', { name, file, rootPath: repoRoot, limit: 50 }, { workspaceId: options.workspaceId ?? undefined });
          if (!answer.error && answer.sites.some((site) => site.path === file)) return found('lsp workspace symbol');
          lspDetail = answer.error ? `lsp unavailable: ${answer.error}` : 'lsp found no declaration in that file';
        } catch (error) {
          lspDetail = `lsp unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const language = AST_GREP_LANGUAGE_BY_EXT[ext];
      if (!language) return unavailable(`${lspDetail}; ast-grep has no grammar for ${ext || 'this file'}`);
      const syntax = await astGrepFacade('search', { pattern: name, language, paths: [file], rootPath: repoRoot, limit: 1 })
        .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error), sites: [] }));
      if (syntax.error) return unavailable(`${lspDetail}; ast-grep unavailable: ${syntax.error}`);
      return syntax.sites.length > 0
        ? found('ast-grep syntax match (identifier present; definition not certified)')
        : notFound(`${ref.symbol} does not occur in ${file}`);
    },

    tool: async (ref) => {
      let names: Set<string>;
      try {
        names = new Set(listAllProjectedTools().flatMap((tool) => [tool.expose.mcp?.name, (tool as { name?: string }).name]).filter((n): n is string => !!n));
      } catch (error) {
        return unavailable(`tool registry unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (names.size === 0) return unavailable('tool registry is empty');
      if (names.has(ref.name!)) return found('projected tool registry');
      // Plugin tools (server.verb) are not projected into the registry.
      if (!ref.name!.includes(':')) return unavailable('plugin tools (server.verb) are not in the projected tool registry');
      return notFound('no such tool in the projected tool registry');
    },

    table: async (ref) => {
      if (!sql) return unavailable('no database handle');
      try {
        const rows = await sql<{ present: boolean }[]>`SELECT to_regclass(${`${ref.schema}.${ref.table}`}) IS NOT NULL AS present`;
        return rows[0]?.present ? found('PG catalog') : notFound('no such relation in the PG catalog');
      } catch (error) {
        return unavailable(`PG catalog unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    package: async (ref) => {
      if (!repoRoot) return noRoot;
      try {
        const matches = (await packages(repoRoot)).find(ref.name!);
        return matches.length > 0 ? found(`declared in ${matches[0]!.path}`) : notFound('declared in no workspace manifest');
      } catch (error) {
        return unavailable(`workspace manifests unreadable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    routine: async (ref) => {
      if (!sql) return unavailable('no database handle');
      try {
        const rows = await sql`SELECT 1 FROM harness_shared.routines WHERE name = ${ref.name!} LIMIT 1`;
        return rows.length > 0 ? found('routine registry') : notFound('no routine with that name');
      } catch (error) {
        return unavailable(`routine registry unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    doc: async (ref) => {
      if (!sql) return unavailable('no database handle');
      try {
        const rows = await sql`SELECT 1 FROM harness_shared.harness_docs WHERE doc_id = ${ref.name!} LIMIT 1`;
        return rows.length > 0 ? found('docs store') : notFound('no doc with that slug');
      } catch (error) {
        return unavailable(`docs store unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}

/**
 * R-6 baseline (D-013 #4): every dependency name the workspace manifests declare
 * at activation, recorded on the activation audit row. Null when the manifests
 * cannot be read, which leaves the ship check unverified rather than wrong.
 */
export async function captureDependencyBaseline(repoRoot: string | null): Promise<DependencyBaseline | null> {
  if (!repoRoot) return null;
  const manifests = await readWorkspaceManifests(repoRoot).catch(() => null);
  if (!manifests) return null;
  const packages = new Set(manifests.filter((manifest) => manifest.ecosystem === 'npm').flatMap((manifest) => manifest.dependencies));
  return { packages: [...packages].sort(), manifests: manifests.length, capturedAt: new Date().toISOString() };
}

/** The npm workspace packages' own names: imports of these are first-party, not third-party. */
export async function readWorkspacePackageNames(repoRoot: string): Promise<Set<string> | null> {
  const manifests = await readWorkspaceManifests(repoRoot).catch(() => null);
  if (!manifests) return null;
  return new Set(manifests.flatMap((manifest) => (manifest.ecosystem === 'npm' && manifest.name ? [manifest.name] : [])));
}

/**
 * `filesChanged` from the completions of the plan's work-items (linked by
 * source_plan_slug or by the plan_item payload), the ship check's second
 * population source. Null when the ledger cannot be read.
 */
export async function readPlanCompletionFilesChanged(input: {
  sql: postgres.Sql<any>;
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}): Promise<string[] | null> {
  try {
    const rows = await input.sql<{ path: string }[]>`
      SELECT DISTINCT p.path
        FROM harness_shared.work_items wi
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(wi.payload->'_completionEvidence'->'filesChanged') = 'array'
               THEN wi.payload->'_completionEvidence'->'filesChanged' ELSE '[]'::jsonb END
          || CASE WHEN jsonb_typeof(wi.payload->'_completionEvidence'->'verification'->'filesChanged') = 'array'
               THEN wi.payload->'_completionEvidence'->'verification'->'filesChanged' ELSE '[]'::jsonb END) p(path)
       WHERE wi.workspace_id = ${input.workspaceId}
         AND wi.harness_slug = ${input.harnessSlug}
         AND (wi.source_plan_slug = ${input.planSlug} OR wi.payload->'plan_item'->>'plan_slug' = ${input.planSlug})
       ORDER BY p.path
       LIMIT 2000`;
    return rows.map((row) => row.path).filter((p) => p.length > 0 && !p.startsWith('/') && !p.split('/').includes('..'));
  } catch {
    return null;
  }
}
