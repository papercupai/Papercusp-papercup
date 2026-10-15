/**
 * An INDEPENDENTLY PACKAGED provider, end to end through the real plugin
 * contract (generalized-integrations-google-migration-cupboard-workflows-
 * 2026-10-05, P-001 / D-006).
 *
 * Unlike plugin-provider-wiring.test.ts (which injects in-memory LoadedPlugin
 * objects), this writes real plugin PACKAGES to disk — a `papercusp.json`
 * manifest declaring a `provider` plus a CommonJS entry exporting a
 * `providerAdapter` — and drives them through the real `loadPlugins`
 * discovery and the host's `registerPluginProviders`. Nothing here edits
 * operator-core source or writes a shared table: the package is the only
 * input, which is the property the plan's contract promises a third-party
 * author.
 *
 * Covers spec clauses AUTO-BAR-R-1-P-001 (registers descriptor + adapter with
 * a capability subset) and ITEM-P-001-contract (a second package declaring an
 * already-registered provider id is refused with the named
 * `duplicate-provider` error, and the first registration survives).
 *
 * It also carries R-1's drift detectors (vetting post thread-post:1157810):
 * registration must need no operator-core internal import, operator-core's
 * registration and connection path must not branch on a provider name, and no
 * parallel provider table may appear. Each detector is first proven live on a
 * planted sample (positive control) and on a planted clean sample (negative
 * control) before it scans the real tree, so a broken detector cannot pass
 * vacuously.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPlugins } from '@papercusp/plugin-loader';
import { stripCommentsOnly, stripSqlComments } from '../../../../scripts/lib/strip-comments-and-strings.mjs';
import { registerPluginProviders, type ProviderRegistrationFailure } from '../plugin-host-runtime';
import { createProviderRegistry } from './provider-registry';

const ROOT = join(tmpdir(), `papercusp-provider-package-it-${process.pid}-${Date.now()}`);

function descriptor(id: string, capabilities: string[]): Record<string, unknown> {
  return {
    id,
    contractVersion: 1,
    datatypes: ['email-message'],
    capabilities,
    egressHosts: ['mail.example.com'],
  };
}

/** Write one plugin package exactly as an outside author would publish it. */
async function writeProviderPackage(projectDir: string, name: string, provider: Record<string, unknown>) {
  const dir = join(projectDir, 'plugins', name);
  await fs.mkdir(dir, { recursive: true });
  const manifest = { name, version: '0.1.0', papercusp: '^0.1.0', capabilities: [], tools: [], provider };
  await fs.writeFile(join(dir, 'papercusp.json'), JSON.stringify(manifest), 'utf8');
  await fs.writeFile(
    join(dir, 'index.cjs'),
    [
      `const provider = ${JSON.stringify(provider)};`,
      'module.exports = {',
      `  name: ${JSON.stringify(name)}, version: '0.1.0', papercusp: '^0.1.0', capabilities: [],`,
      '  providerAdapter: {',
      '    describe: () => provider,',
      "    syncPage: async () => ({ records: [{ id: 'm1' }], nextCursor: null, hasMore: false }),",
      "    invoke: async (req) => ({ ok: true, echoed: req && req.capability }),",
      '  },',
      '};',
    ].join('\n'),
    'utf8',
  );
}

async function discover(projectDir: string) {
  const emptyGlobal = join(projectDir, 'no-global-plugins');
  await fs.mkdir(emptyGlobal, { recursive: true });
  return loadPlugins({ projectDir, harnessSlugs: [], globalPluginsDir: emptyGlobal });
}

beforeAll(async () => {
  await fs.mkdir(ROOT, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('independently packaged provider through the plugin contract (P-001)', () => {
  it('registers the descriptor and a callable adapter with exactly the declared capability subset', async () => {
    const projectDir = join(ROOT, 'single');
    await writeProviderPackage(projectDir, 'acme-mail', descriptor('acme-mail', ['mail.read']));

    const { loaded, errors } = await discover(projectDir);
    expect(errors).toEqual([]);
    const pkg = loaded.find((lp) => lp.plugin.name === 'acme-mail');
    expect(pkg?.provider?.id).toBe('acme-mail');

    const registry = createProviderRegistry();
    const failures: ProviderRegistrationFailure[] = [];
    const registered = await registerPluginProviders(loaded, (f) => failures.push(f), registry);

    expect(failures).toEqual([]);
    expect(registered).toEqual(['acme-mail']);
    const entry = registry.get('acme-mail');
    expect(entry?.pluginName).toBe('acme-mail');
    expect(entry?.runtime).toBe('js');
    // A capability SUBSET: the provider serves mail.read only, so a lookup for
    // a capability it did not declare must not route to it.
    expect(entry?.descriptor.capabilities).toEqual(['mail.read']);
    expect(registry.forDatatype('email-message', 'mail.read').map((p) => p.descriptor.id)).toEqual(['acme-mail']);
    expect(registry.forDatatype('email-message', 'mail.send')).toEqual([]);
    // The adapter that registered is the package's own code, and it answers.
    const page = await entry!.adapter!.syncPage({ source: 'src-1', cursor: null } as never, {} as never);
    expect(page).toMatchObject({ records: [{ id: 'm1' }], hasMore: false });
  });

  it('refuses a second package declaring an already-registered provider id with duplicate-provider', async () => {
    const projectDir = join(ROOT, 'duplicate');
    await writeProviderPackage(projectDir, 'acme-mail', descriptor('shared-mail', ['mail.read']));
    await writeProviderPackage(projectDir, 'copycat-mail', descriptor('shared-mail', ['mail.read', 'mail.send']));

    const { loaded, errors } = await discover(projectDir);
    expect(errors).toEqual([]);
    expect(loaded.filter((lp) => lp.provider?.id === 'shared-mail')).toHaveLength(2);

    const registry = createProviderRegistry();
    const failures: ProviderRegistrationFailure[] = [];
    const registered = await registerPluginProviders(loaded, (f) => failures.push(f), registry);

    expect(registered).toEqual(['shared-mail']);
    expect(failures).toHaveLength(1);
    const [failure] = failures;
    expect(failure.code).toBe('duplicate-provider');
    expect(failure.provider).toBe('shared-mail');
    const winner = registry.get('shared-mail')!.pluginName;
    expect(failure.plugin).not.toBe(winner);
    expect(failure.error).toContain(`already registered by plugin "${winner}"`);
    // The refusal leaves the first registration intact, capabilities unwidened.
    expect(registry.list()).toHaveLength(1);
    expect(registry.forDatatype('email-message', 'mail.send')).toEqual(
      winner === 'copycat-mail' ? registry.list() : [],
    );
  });
});

// ── R-1 drift detectors ─────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'libs/papercusp/libs/db/sql');

/** Operator-core's provider REGISTRATION path: generic, and it never writes a table. */
const REGISTRATION_PATH = [
  'packages/operator-core/lib/integrations/provider-registry.ts',
  'packages/operator-core/lib/plugin-host-runtime.ts',
  'libs/generic/plugin-loader/src/loader.ts',
  'libs/generic/plugin-loader/src/manifest-validator.ts',
];
/** Plus the generic CONNECTION path (P-003): it may write data_sources, but names no provider. */
const PROVIDER_NEUTRAL_PATH = [
  ...REGISTRATION_PATH,
  'packages/operator-core/lib/integrations/connection-lifecycle.ts',
  'packages/operator-core/lib/endpoint-route/routes/oauth/start.ts',
  'packages/operator-core/lib/endpoint-route/routes/oauth/callback.ts',
];

/**
 * Tables whose name mentions "provider" that predate this plan and are not an
 * integration-provider registry (capability classes, coverage census, search
 * credentials, identity mappings). The provider registry lives in plugin
 * manifests, so this set may only shrink.
 */
const PRE_EXISTING_PROVIDER_TABLES = [
  'capability_class_provider_bindings',
  'census_provider_registrations',
  'operator_search_provider_credentials',
  'provider_identity_mappings',
];

interface Site {
  line: number;
  text: string;
}

function sitesOf(code: string, pattern: RegExp): Site[] {
  const out: Site[] = [];
  code.split('\n').forEach((text, index) => {
    pattern.lastIndex = 0;
    if (pattern.test(text)) out.push({ line: index + 1, text: text.trim() });
  });
  return out;
}

const PROVIDER_TOKEN_AT_WORD_START = /(?<![A-Za-z0-9])(?:gmail|gcal|google|facebook|outlook|microsoft|github)/i;
const PROVIDER_TOKEN_AT_CAMEL_HUMP = /(?<=[a-z0-9])(?:Gmail|Gcal|Google|Facebook|Outlook|Microsoft|Git[Hh]ub)/;

/** Any provider name in CODE (literal or identifier), ignoring comments. */
function providerNameSites(source: string, fileName: string): Site[] {
  const code = stripCommentsOnly(source, fileName);
  return [
    ...sitesOf(code, PROVIDER_TOKEN_AT_WORD_START),
    ...sitesOf(code, PROVIDER_TOKEN_AT_CAMEL_HUMP),
  ].filter((site, index, all) => all.findIndex((other) => other.line === site.line) === index);
}

const SQL_WRITE = /\bsql\s*`|\bsql\.unsafe\(|\.query\(|\bINSERT\s+INTO\b|\bCREATE\s+TABLE\b/i;

/** Any table write or query from code, ignoring comments. */
function sqlWriteSites(source: string, fileName: string): Site[] {
  return sitesOf(stripCommentsOnly(source, fileName), SQL_WRITE);
}

const MODULE_SPECIFIER = /\b(?:require|import)\s*\(\s*['"`]([^'"`]+)['"`]|\bfrom\s+['"`]([^'"`]+)['"`]/g;

/** Imports a provider package must not need: operator-core or any path outside the package. */
function internalImports(source: string, fileName: string): string[] {
  const code = stripCommentsOnly(source, fileName);
  const found: string[] = [];
  for (const match of code.matchAll(MODULE_SPECIFIER)) {
    const specifier = match[1] ?? match[2];
    if (!specifier) continue;
    if (specifier.startsWith('../') || specifier.startsWith('/')) found.push(specifier);
    else if (specifier.startsWith('@papercusp/') && specifier !== '@papercusp/plugin-sdk') found.push(specifier);
  }
  return found;
}

const CREATE_TABLE = /\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?[a-z_]+"?\.)?"?([a-z_][a-z0-9_]*)"?/gi;

/** Provider-named tables created by a migration body, ignoring SQL comments. */
function providerTablesCreated(sql: string): string[] {
  const names: string[] = [];
  for (const match of stripSqlComments(sql).matchAll(CREATE_TABLE)) {
    const table = match[1];
    if (table && /provider/i.test(table)) names.push(table.toLowerCase());
  }
  return names;
}

/**
 * Read a scanned repo file. `R1_DRIFT_SCAN_FILE_OVERRIDE=<repo path>=<absolute path>` substitutes
 * one subject, so scripts/mutation-probe.sh can prove the scan catches drift in a mutated COPY
 * without ever touching the shared tree.
 */
function repoFile(path: string): string {
  const override = process.env.R1_DRIFT_SCAN_FILE_OVERRIDE;
  const separator = override?.indexOf('=') ?? -1;
  if (override && separator > 0 && override.slice(0, separator) === path) {
    return readFileSync(override.slice(separator + 1), 'utf8');
  }
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

describe('R-1 drift detectors: registration needs no internal import, no provider-name branch, no provider table', () => {
  it('each detector fires on planted drift and stays quiet on a planted clean sample', () => {
    // Positive controls: a planted instance of every drift marker is reported.
    expect(providerNameSites("if (provider.id === 'gmail') return gmailAdapter;", 'planted.ts')).toHaveLength(1);
    expect(providerNameSites('const uri = client.redirectUri ?? googleOAuthRedirectUri();', 'planted.ts')).toHaveLength(1);
    expect(providerNameSites("switch (kind) { case 'google-workspace': break; }", 'planted.ts')).toHaveLength(1);
    expect(sqlWriteSites('await sql`INSERT INTO harness_shared.providers VALUES (${id})`;', 'planted.ts')).toHaveLength(1);
    expect(internalImports("const r = require('@papercusp/operator-core/lib/integrations/provider-registry');", 'p.cjs')).toEqual([
      '@papercusp/operator-core/lib/integrations/provider-registry',
    ]);
    expect(internalImports("import { db } from '../../packages/operator-core/lib/db';", 'p.ts')).toEqual([
      '../../packages/operator-core/lib/db',
    ]);
    expect(providerTablesCreated('CREATE TABLE IF NOT EXISTS harness_shared.integration_providers (id text);')).toEqual([
      'integration_providers',
    ]);
    // Negative controls: comments, the supported SDK import and unrelated tables are not drift.
    expect(providerNameSites('// the gmail adapter lives elsewhere\nconst id = descriptor.id;', 'clean.ts')).toEqual([]);
    expect(providerNameSites('const api = registry.forDatatype(datatype, capability);', 'clean.ts')).toEqual([]);
    expect(sqlWriteSites('/* INSERT INTO nothing */\nregistry.register(entry);', 'clean.ts')).toEqual([]);
    expect(internalImports("const sdk = require('@papercusp/plugin-sdk');\nconst path = require('node:path');", 'p.cjs')).toEqual([]);
    expect(providerTablesCreated('-- CREATE TABLE harness_shared.providers\nCREATE TABLE harness_shared.data_sources (id text);')).toEqual([]);
  });

  it('operator-core registration and connection path name no provider, and registration writes no table', () => {
    for (const path of PROVIDER_NEUTRAL_PATH) {
      expect({ path, sites: providerNameSites(repoFile(path), path) }).toEqual({ path, sites: [] });
    }
    for (const path of REGISTRATION_PATH) {
      expect({ path, sites: sqlWriteSites(repoFile(path), path) }).toEqual({ path, sites: [] });
    }
  });

  it('an independently packaged provider registers with no operator-core or out-of-package import', async () => {
    const projectDir = join(ROOT, 'import-scan');
    await writeProviderPackage(projectDir, 'acme-mail', descriptor('acme-mail', ['mail.read']));
    const { loaded, errors } = await discover(projectDir);
    expect(errors).toEqual([]);
    const registry = createProviderRegistry();
    const failures: ProviderRegistrationFailure[] = [];
    expect(await registerPluginProviders(loaded, (f) => failures.push(f), registry)).toEqual(['acme-mail']);
    expect(failures).toEqual([]);

    const packageDir = join(projectDir, 'plugins', 'acme-mail');
    const files = readdirSync(packageDir);
    expect(files.sort()).toEqual(['index.cjs', 'papercusp.json']);
    for (const file of files.filter((name) => name.endsWith('.cjs'))) {
      expect({ file, imports: internalImports(readFileSync(join(packageDir, file), 'utf8'), file) }).toEqual({ file, imports: [] });
    }
  });

  it('no migration creates a parallel provider table', () => {
    const migrations = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql'));
    // Positive control on the corpus itself: the scan reads every armed migration.
    expect(migrations.length).toBeGreaterThan(1000);
    const created = new Set<string>();
    for (const name of migrations) {
      for (const table of providerTablesCreated(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'))) created.add(table);
    }
    expect([...created].sort()).toEqual(PRE_EXISTING_PROVIDER_TABLES);
  });
});
