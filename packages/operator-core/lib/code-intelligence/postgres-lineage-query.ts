/** Bounded filesystem adapter for the maintained SQL lineage parser. */
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import fg from 'fast-glob';
import { buildPostgresLineage, queryPostgresLineage, type SyncLineageRegistry } from './postgres-lineage';
import { loadVendoredTypescript } from './typescript-service';
import { LSP_VENDOR_DIR } from './lsp-adapter';

export async function readPostgresLineage(rootPath: string, paths: readonly string[], signal?: AbortSignal,
  registry?: readonly SyncLineageRegistry[]) {
  if (!paths.length || paths.length > 50) throw new Error('SQL lineage requires 1–50 bounded repository paths');
  const root = await realpath(rootPath);
  const files = new Set<string>();
  const omitted: { path: string; line1: number; reason: string }[] = [];
  const inside = (path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
  for (const path of paths) {
    signal?.throwIfAborted();
    if (isAbsolute(path) || path.split('/').includes('..')) throw new Error('SQL lineage paths must stay within the registered repository');
    const absolute = await realpath(join(root, path));
    if (!inside(absolute)) throw new Error('SQL lineage symlink escapes the registered repository');
    if ((await stat(absolute)).isDirectory()) {
      const matches = fg.stream('**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,sql}', { cwd: absolute, onlyFiles: true,
        followSymbolicLinks: false, ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/vendor/**'], deep: 8 });
      for await (const match of matches) {
        signal?.throwIfAborted();
        if (files.size >= 200) { omitted.push({ path, line1: 1, reason: 'Directory exceeds 200-file SQL lineage budget' }); break; }
        files.add(relative(root, join(absolute, String(match))).replaceAll('\\', '/'));
      }
    } else files.add(relative(root, absolute).replaceAll('\\', '/'));
  }
  const sources: { path: string; text: string }[] = [];
  let bytes = 0;
  for (const path of [...files].sort()) {
    signal?.throwIfAborted();
    const absolute = await realpath(join(root, path));
    if (!inside(absolute)) throw new Error('SQL source escapes the registered repository');
    const size = (await stat(absolute)).size;
    if (sources.length >= 200 || size > 256_000 || bytes + size > 2_000_000) {
      omitted.push({ path, line1: 1, reason: 'SQL lineage source budget exceeded' }); continue;
    }
    if (!/\.(?:[cm]?[jt]sx?|sql)$/.test(path)) { omitted.push({ path, line1: 1, reason: 'Unsupported SQL source file type' }); continue; }
    const text = await readFile(absolute, { encoding: 'utf8', signal }); bytes += Buffer.byteLength(text);
    sources.push({ path, text });
  }
  // Only the real dispatch registry supplies sync names/backing tables; undeclared means unknown.
  let entries = registry;
  if (!entries && sources.some(source => source.path.includes('sync-resolver/') || /\bnotifySyncInvalidate\s*\(/.test(source.text))) {
    const { knownQueryNamesV2, getRegistryEntryV2 } = await import('../sync-resolver');
    entries = knownQueryNamesV2().flatMap(queryName => {
      const tables = getRegistryEntryV2(queryName)?.backingTables;
      return tables ? [{ queryName, tables }] : [];
    });
  }
  const report = buildPostgresLineage(loadVendoredTypescript(LSP_VENDOR_DIR), sources, entries ?? []);
  report.unknown.push(...omitted);
  // Do not publish a mixed snapshot if sources changed while parsing/loading the registry.
  const { createHash } = await import('node:crypto');
  for (const source of report.sourceFiles) {
    signal?.throwIfAborted();
    const resolved = await realpath(join(root, source.path));
    if (!inside(resolved)) throw new Error('SQL source escaped the repository during capture');
    const actual = createHash('sha256').update(await readFile(resolved, { signal })).digest('hex');
    if (actual !== source.contentHash) throw new Error(`SQL source changed during capture: ${source.path}`);
  }
  return report;
}

export async function postgresLineageQuery(root: string, args: { table?: string; column?: string; paths?: string[] }) {
  if (!args.table || !args.paths?.length) return { error: 'sql-lineage requires table and bounded paths; column is optional',
    sites: [], complete: false, coverage: 'unknown' };
  try { return queryPostgresLineage(await readPostgresLineage(root, args.paths), args.table, args.column); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error), sites: [], complete: false, coverage: 'unknown' }; }
}
