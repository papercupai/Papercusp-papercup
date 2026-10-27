#!/usr/bin/env -S npx tsx
/** Partial writer-root diagnostic, explicitly not a whole-install ship verdict. */
import { collectStateCensus, backupCacheCensusDeclarations } from '../packages/backup/src/state-census';
import { installedRootCensusProducers, postgresStorageDeclaration, gitStorageDeclaration, peerStorageDeclaration, portalReleaseStorageDeclaration, restoredCloneCensusDeclarations, mergeNestedCensusRoots, virtualenvCacheDeclaration } from '../packages/operator-core/lib/backup/state-census-producers';
import { readdir, lstat, readFile } from 'node:fs/promises';
import { join, relative, dirname, basename, sep, isAbsolute } from 'node:path';
import { workspacesRoot, readRegistry } from '../packages/operator-core/lib/workspace-registry';
import { defaultClonesDir } from '../packages/operator-core/lib/harness/clone-github';
import postgres from 'postgres';
import { getHarnessAdminUrl } from '../packages/operator-core/lib/embedded-pg-discovery';
import { physicalDatabaseCensusEntries, integrationBaselineCensusDeclarations, templateDatabaseCensusDeclarations, unitCensusEntries, installedUnitCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';
import type { CensusEntry } from '../packages/backup/src/state-census';
import { configuredOperatorDatabaseCensusDeclarations, unitDatabaseCensusDeclarations, affectedTestCacheCensusProducer } from '../packages/operator-core/lib/backup/state-census-producers';
import { migrationProducerTables, migrationDatabaseCensusDeclarations, registeredProjectMigrationSources, canonicalSqlMigrationCensusSources, type MigrationCensusSource } from '../packages/operator-core/lib/backup/state-census-producers';
import { loadHarnessRegistry } from '../packages/operator-core/lib/harness-registry';
import { accountCredentialCensusProducer, runtimeSidefileCensusProducer, cliSetupHomeCensusProducer, templateStoreCensusProducer, planTemplateStoreCensusProducer } from '../packages/operator-core/lib/backup/state-census-producers';
import { loadAccountPool } from '../packages/operator-core/lib/deployment/account-pool-store';
import { buildExpected } from './templates-mirror-sync.mjs';
import { historicalGitBlobIdentityResolver, workspaceTemplateStoreCensusProducer } from '../packages/operator-core/lib/backup/state-census-producers';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from '@papercusp/operator-core/lib/util/cli-entry';
import { reapArchiveCensusProducer, maintenanceDatabaseCensusDeclarations } from '../packages/operator-core/lib/backup/state-census-producers';
import { listTasks } from '../packages/operator-core/lib/task-manager/store';
import { historicalHostedProfileCensusProducer, historicalPlaywrightStateCensusProducer, recoverHistoricalCensusWriterEvidence, type HostedProfileWriterEvidence, type IndexedCensusWriterEvidence, type PlaywrightStateWriterEvidence } from '../packages/operator-core/lib/backup/state-census-producers';
import { papercuspRoot, papercuspRootForWorkspace } from '../packages/operator-core/lib/papercusp-root';
import { checkpointLogDirFromEnv } from '../packages/operator-core/lib/release/checkpoint-log-dir';

/** Reuse the setup writer's exact ownership rules across workspace homes. */
export async function readWorkspaceSetupHomes(
  workspaces: readonly { id: string }[],
  resolveRoot: (workspace: string) => string = papercuspRootForWorkspace,
  activeRoot = papercuspRoot(),
) {
  const paths = [...new Set([activeRoot, ...workspaces.map(workspace => resolveRoot(workspace.id))])];
  const producers = await Promise.all(paths.map(async (path, index) => {
    const producer = await cliSetupHomeCensusProducer(path);
    const id = `cli-setup-homes-${index}`;
    return { roots: producer.roots.map(root => ({ ...root, id })),
      declarations: producer.declarations.map(declaration => ({ ...declaration, root: id })) };
  }));
  return { roots: producers.flatMap(producer => producer.roots),
    declarations: producers.flatMap(producer => producer.declarations) };
}

/** Credential ownership is workspace-scoped; the active pool is not a host census. */
export async function readWorkspaceCensusAccounts(
  workspaces: readonly { id: string }[],
  readPool: (workspace: string) => Promise<{ accounts: { credentialRef: string }[] }> = loadAccountPool,
) {
  const pools = await Promise.all([...new Set(workspaces.map(workspace => workspace.id))]
    .map(workspace => readPool(workspace)));
  return pools.flatMap(pool => pool.accounts);
}

/** Read only source-backed tables; unrelated schemas cannot exhaust this census. */
export async function readMigrationCensusColumns(sql: ReturnType<typeof postgres>, sources: readonly MigrationCensusSource[]) {
  const tables = [...new Set(sources.flatMap(source => [...source.tables]))];
  if (!tables.length) return [];
  const rows = await sql<{ table_schema: string; table_name: string; column_name: string; data_type: string; udt_schema: string; udt_name: string }[]>`
    SELECT table_schema, table_name, column_name, data_type, udt_schema, udt_name FROM information_schema.columns
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
      AND (table_schema || '.' || table_name) = ANY(${tables})
    ORDER BY table_schema, table_name, ordinal_position LIMIT 20001`;
  if (rows.length > 20000) throw new Error('Database schema census bound exceeded');
  return rows;
}

/** Importing this entry performs no census or host-catalog reads. */
export async function runRootCensus(options: { args?: string[]; checkpointLogDir?: string; hostedProfileEvidence?: HostedProfileWriterEvidence[] } = {}) {
const args = options.args ?? [];
const installed = installedRootCensusProducers();
let hostedEvidence = options.hostedProfileEvidence ?? [];
let playwrightEvidence: PlaywrightStateWriterEvidence[] = [];
if (args.includes('--host-catalogs') && options.hostedProfileEvidence === undefined) {
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
  try {
    // Bound the writer dialect, not its filenames. A new destination is derived
    // from the retained command AST and must still pass installed-content proof.
    const indexedEvidence = await sql<IndexedCensusWriterEvidence[]>`
      SELECT 'session-part:' || writer.source_kind || ':' || writer.session_id || ':' || writer.part_idx AS ref,
        writer.session_id AS "sessionId", writer.text AS "toolInput", writer.ts::text AS "startedAt", receipt.ts::text AS "finishedAt"
      FROM harness_shared.session_turn_parts writer
      JOIN harness_shared.session_turn_parts receipt USING (workspace_id, source_kind, session_id)
      WHERE writer.workspace_id = 'default' AND writer.source_kind = 'codex' AND writer.part_kind = 'tool_use'
        AND (writer.text LIKE '%writeFileSync(destination,encrypt(%'
          OR (writer.text LIKE '%chromium%' AND writer.text LIKE '%statePath%'))
        AND receipt.part_idx = writer.part_idx + 1 AND receipt.part_kind = 'tool_result'
      LIMIT 101
    `;
    const recovered = await recoverHistoricalCensusWriterEvidence(indexedEvidence);
    // Full index entries remain usable if their archive was never retained;
    // truncated entries still fail the whole-program validator. Browser state
    // always needs a canonical call-id-paired receipt as well as its writer.
    hostedEvidence = [...indexedEvidence.filter(indexed => !recovered.some(record => record.indexedRef === indexed.ref)), ...recovered];
    playwrightEvidence = recovered;
  } finally { await sql.end(); }
}
const historicalHosted = await historicalHostedProfileCensusProducer(hostedEvidence);
const historicalPlaywright = await historicalPlaywrightStateCensusProducer(playwrightEvidence);
const combinedHosted = mergeNestedCensusRoots({ roots: [...installed.roots, ...historicalHosted.roots, ...historicalPlaywright.roots],
  declarations: [...installed.declarations, ...historicalHosted.declarations, ...historicalPlaywright.declarations] });
installed.roots = combinedHosted.roots;
installed.declarations = combinedHosted.declarations;
// Query exact archive identities BEFORE the ledger limit; a batch is smaller
// than the cap. Missing/GCed rows remain residue, never inferred from filenames.
const reapArchive = await reapArchiveCensusProducer(undefined, [], args.includes('--host-catalogs')
  ? async taskIds => {
    const retained: string[] = [];
    for (const workspace of readRegistry().workspaces) {
      retained.push(...(await listTasks({ workspaceId: workspace.id, includeEnded: true, taskIds, limit: 2000 })).map(task => task.taskId));
    }
    return retained;
  } : undefined);
const affectedCache = await affectedTestCacheCensusProducer();
const sidefiles = await runtimeSidefileCensusProducer();
const setupHomes = await readWorkspaceSetupHomes(readRegistry().workspaces);
const templateExpected = (await buildExpected()).expected;
const historicalTemplateIdentity = historicalGitBlobIdentityResolver(fileURLToPath(new URL('..', import.meta.url)));
const templateStore = await templateStoreCensusProducer(undefined, templateExpected, historicalTemplateIdentity);
const workspaceTemplateStores = await workspaceTemplateStoreCensusProducer(undefined, templateExpected, historicalTemplateIdentity);
const planTemplateStore = await planTemplateStoreCensusProducer();
const hostCatalogs = args.includes('--host-catalogs');
const credentials = await accountCredentialCensusProducer(hostCatalogs
  ? await readWorkspaceCensusAccounts(readRegistry().workspaces) : []);
const checkpointLogDir = options.checkpointLogDir ?? checkpointLogDirFromEnv();
const producers = mergeNestedCensusRoots({ roots: [...installed.roots, ...affectedCache.roots, ...credentials.roots, ...sidefiles.roots, ...setupHomes.roots, ...templateStore.roots, ...workspaceTemplateStores.roots, ...planTemplateStore.roots,
  { id: 'checkpoint-logs-parent', path: dirname(checkpointLogDir) }], declarations: [...installed.declarations, ...affectedCache.declarations, ...credentials.declarations, ...sidefiles.declarations, ...setupHomes.declarations, ...templateStore.declarations, ...workspaceTemplateStores.declarations, ...planTemplateStore.declarations, {
  kind: 'path', root: 'checkpoint-logs-parent', name: basename(checkpointLogDir), classification: 'state',
  producer: 'green-checkpoint-log-writer', descendants: true,
  retainedSubtree: { evidenceRef: 'release-config:checkpointLogDir' },
}] });
const withReapArchive = mergeNestedCensusRoots({ roots: [...producers.roots, ...reapArchive.roots], declarations: [...producers.declarations, ...reapArchive.declarations] });
producers.roots = withReapArchive.roots;
producers.declarations = withReapArchive.declarations;
const declarations = [...producers.declarations,
  ...producers.roots.flatMap(root => backupCacheCensusDeclarations(root.id))];
const catalogEntries: CensusEntry[] = [];
const migrationSources: MigrationCensusSource[] = [];
if (hostCatalogs) {
  migrationSources.push(...await canonicalSqlMigrationCensusSources());
  for (const workspace of readRegistry().workspaces) {
    const registry = await loadHarnessRegistry(workspace.id, { fresh: true });
    migrationSources.push(...await registeredProjectMigrationSources(registry.projects));
  }
}
if (args.includes('--restore-events') || hostCatalogs) {
  const sql = postgres(getHarnessAdminUrl(), { max: 1, connect_timeout: 5 });
  try {
    for (const workspace of readRegistry().workspaces) {
      declarations.push(...await restoredCloneCensusDeclarations(sql, workspace.id, join(workspacesRoot(), workspace.id), producers.roots));
    }
    if (hostCatalogs) {
      const databases = await physicalDatabaseCensusEntries(sql);
      catalogEntries.push(...databases);
      declarations.push(...integrationBaselineCensusDeclarations(databases));
      if (databases.length) declarations.push(...await maintenanceDatabaseCensusDeclarations(sql, databases[0].root));
      if (databases.length) declarations.push(...await templateDatabaseCensusDeclarations(sql, databases[0].root));
      if (databases.length) declarations.push(...configuredOperatorDatabaseCensusDeclarations(databases[0].root, getHarnessAdminUrl()));
      const unitDeclarations = [];
      for (const scope of ['user', 'system'] as const) {
        catalogEntries.push(...await unitCensusEntries(scope));
        unitDeclarations.push(...await installedUnitCensusDeclarations(scope));
      }
      migrationSources.push(...await registeredProjectMigrationSources([], unitDeclarations));
      declarations.push(...unitDeclarations, ...await unitDatabaseCensusDeclarations(unitDeclarations, databases, getHarnessAdminUrl(), producers.roots.map(root => root.path)));
      // Catalog only declared secret paths that exist; never read their values.
      // Unknown secret locations still appear as filesystem residue.
      const secretPaths = producers.declarations.filter(entry => entry.classification === 'secret');
      for (const declaration of secretPaths.filter((entry, index) => secretPaths.findIndex(other =>
        other.root === entry.root && other.name === entry.name) === index)) {
        const root = producers.roots.find(entry => entry.id === declaration.root)!;
        try { await lstat(join(root.path, declaration.name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const entry: CensusEntry = { kind: 'secret', root: declaration.root, name: declaration.name };
        catalogEntries.push(entry);
        declarations.push({ ...declaration, kind: 'secret' });
      }
    }
  } finally { await sql.end(); }
}
for (const root of producers.roots) {
  const topLevel = await readdir(root.path, { withFileTypes: true });
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    try { await lstat(join(root.path, directory.name, 'PG_VERSION')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    declarations.push(await postgresStorageDeclaration(root, directory.name));
  }
  // Bounded marker discovery in the home and its direct artifact containers.
  // Symlinks and retained trees are not followed or reclassified.
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    const children = await readdir(join(root.path, directory.name), { withFileTypes: true });
    const candidates = [directory.name, ...children.filter(entry => entry.isDirectory()).map(entry => `${directory.name}/${entry.name}`)];
    for (const name of candidates) {
      try { await lstat(join(root.path, name, 'pyvenv.cfg')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      declarations.push(await virtualenvCacheDeclaration(root, name));
    }
  }
  for (const directory of topLevel.filter(entry => entry.isDirectory())) {
    let metadata;
    try { metadata = await lstat(join(root.path, directory.name, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // External worktree pointers do not own their referenced Git metadata.
    // Leave them visible for cross-root qualification rather than following.
    if (!metadata.isDirectory()) continue;
    declarations.push(await gitStorageDeclaration(root, directory.name, true));
  }
  // Only the producer's exact per-workspace layout; scoped stores stay distinct.
  const workspacePrefix = relative(root.path, workspacesRoot());
  const ownsWorkspaces = !workspacePrefix.startsWith('..') && !workspacePrefix.startsWith('/');
  const workspaces = ownsWorkspaces ? await readdir(workspacesRoot(), { withFileTypes: true }) : [];
  const layouts = workspaces.filter(entry => entry.isDirectory()).map(entry => ({ name: entry.name }));
  // restoreToClone's exact default shape. Probe embedded producer evidence,
  // keeping the clone and snapshot containers themselves unclassified.
  for (const workspace of [...layouts]) {
    let snapshots;
    try { snapshots = await readdir(join(workspacesRoot(), workspace.name, '.restored'), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const snapshot of snapshots.filter(entry => entry.isDirectory())) {
      const clones = await readdir(join(workspacesRoot(), workspace.name, '.restored', snapshot.name), { withFileTypes: true });
      for (const clone of clones.filter(entry => entry.isDirectory())) {
        const name = `${workspace.name}/.restored/${snapshot.name}/${clone.name}`;
        const qualified = [workspacePrefix, name].filter(Boolean).join('/');
        if (declarations.some(entry => entry.root === root.id && entry.name === qualified && entry.recoveryStorage)) continue;
        layouts.push({ name });
        if (layouts.length > 1000) throw new Error('Recovery layout census bound exceeded');
      }
    }
  }
  for (const workspace of layouts) {
    const parent = join(workspacesRoot(), workspace.name, '.papercusp');
    let harnesses;
    try { harnesses = await readdir(parent, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Recognize producer evidence inside preserved copies too; the enclosing
    // unknown directories remain residue, never inferred state from their names.
    for (const appContainer of harnesses.filter(entry => entry.isDirectory())) {
    const appsPrefix = [workspacePrefix, workspace.name, '.papercusp', appContainer.name].filter(Boolean).join('/');
    let apps;
    try { apps = await readdir(join(root.path, appsPrefix), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const app of apps ?? []) {
      if (!app.isDirectory() || app.name.startsWith('.')) continue;
      const appName = `${appsPrefix}/${app.name}`;
      try {
        const source = await readFile(join(root.path, appName, 'packages', 'data', 'src', 'migrations.ts'), 'utf8');
        const tables = migrationProducerTables(source);
        if (tables.length >= 2) migrationSources.push({ producer: `app-migrations:${root.id}:${appName}`, tables });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      let hasGit = false;
      try { await lstat(join(root.path, appName, '.git')); hasGit = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (hasGit) {
        // Full preservation includes untracked state; avoid a competing nested
        // cache override that would invalidate this opaque worktree manifest.
        declarations.push(await gitStorageDeclaration(root, appName, true));
        continue;
      }
      let buildProducer;
      try { buildProducer = await readFile(join(root.path, appName, 'scripts', 'build-standalone.mjs'), 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      // Pin this exception to the actual Next build writer, not a generic
      // filename heuristic: published releases are separately retained state.
      if (buildProducer?.includes('const buildDistDir = ".next-build";')) {
        const output = await readdir(join(root.path, appName), { withFileTypes: true });
        for (const child of output) {
          if (child.isDirectory() && /^\.next-build(?:-\d+-\d+-[0-9a-f]+)?$/.test(child.name)) {
            declarations.push({ kind: 'path', root: root.id, name: `${appName}/${child.name}`,
              classification: 'cache', producer: 'portal-build-standalone', descendants: true, prune: true });
          }
        }
      }
    }
    const runtimePrefix = `${appsPrefix}/.portal-runtime`;
    let runtimes;
    try { runtimes = await readdir(join(root.path, runtimePrefix), { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const runtime of runtimes ?? []) {
      if (!runtime.isDirectory()) continue;
      const releasePrefix = `${runtimePrefix}/${runtime.name}/releases`;
      let releases;
      try { releases = await readdir(join(root.path, releasePrefix), { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      for (const release of releases) {
        if (release.isDirectory()) declarations.push(await portalReleaseStorageDeclaration(root, `${releasePrefix}/${release.name}`));
      }
    }
    }
    for (const harness of harnesses.filter(entry => entry.isDirectory())) {
      const pgName = [workspacePrefix, workspace.name, '.papercusp', harness.name].filter(Boolean).join('/');
      let hasPgControl = false;
      try { await lstat(join(root.path, pgName, 'PG_VERSION')); hasPgControl = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (hasPgControl) declarations.push(await postgresStorageDeclaration(root, pgName));
      for (const store of ['hyperbee', 'hyperbee-scoped']) {
        const name = [workspacePrefix, workspace.name, '.papercusp', harness.name, store].filter(Boolean).join('/');
        // Legacy or uninitialized directories have no device marker. Walk them
        // normally so they remain visible residue instead of assuming ownership.
        try { await lstat(join(root.path, name, 'CORESTORE')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        declarations.push(await peerStorageDeclaration(root, name));
      }
    }
  }
  // Derive the container from the clone writer, including relocated workspace roots.
  const clonePath = defaultClonesDir();
  const clonePrefix = relative(root.path, clonePath).split(sep).join('/');
  let clones;
  if (clonePrefix && clonePrefix !== '..' && !clonePrefix.startsWith('../') && !isAbsolute(clonePrefix)) {
    try { clones = await readdir(clonePath, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (clones) declarations.push({ kind: 'path', root: root.id, name: clonePrefix, classification: 'state', producer: 'clone-github-container' });
  }
  for (const clone of clones ?? []) {
    if (!clone.isDirectory()) continue;
    try { await lstat(join(clonePath, clone.name, '.git')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    // Entire worktree is carried, including untracked files and linked pointers.
    declarations.push(await gitStorageDeclaration(root, `${clonePrefix}/${clone.name}`, true));
  }
  let children;
  try { children = await readdir(join(root.path, '.shared'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
  for (const child of children) {
    if (child.isDirectory() && child.name.startsWith('embedded-pg-data')) {
      declarations.push(await postgresStorageDeclaration(root, `.shared/${child.name}`));
    }
  }
}
if (hostCatalogs && migrationSources.length) {
  const operatorUrl = getHarnessAdminUrl();
  for (const database of catalogEntries.filter(entry => entry.kind === 'database' &&
    !declarations.some(declaration => declaration.kind === 'database' && declaration.root === entry.root && declaration.name === entry.name))) {
    const url = new URL(operatorUrl);
    url.pathname = `/${encodeURIComponent(database.name)}`;
    const sql = postgres(url.toString(), { max: 1, connect_timeout: 5 });
    try {
      const rows = await readMigrationCensusColumns(sql, migrationSources);
      declarations.push(...migrationDatabaseCensusDeclarations(database,
        [...new Set(rows.map(row => `${row.table_schema}.${row.table_name}`))], migrationSources,
        rows.map(row => ({ table: `${row.table_schema}.${row.table_name}`, name: row.column_name, type: row.data_type, udtSchema: row.udt_schema, udtName: row.udt_name }))));
    } finally { await sql.end(); }
  }
}
const census = await collectStateCensus({
  ...producers, declarations, representUnknownSubtrees: true,
  // This diagnostic intentionally does not certify catalogs.
  readCatalogs: async () => catalogEntries,
});
return {
  scope: hostCatalogs ? 'implemented-writer-filesystem-roots-and-host-catalogs' : 'implemented-writer-filesystem-roots-only', wholeInstallVerified: false,
  roots: producers.roots, ...census,
};
}

if (isCliEntry(import.meta.url)) {
  const census = await runRootCensus({ args: process.argv.slice(2) });
  console.log(JSON.stringify(census, null, 2));
  if (!census.ok) process.exitCode = 1;
}
