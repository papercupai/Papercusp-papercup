import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {} from 'vitest';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    operatorIntegrationSubstrate?: 'postgres' | 'none';
  }
}

// Self-contained fixtures: no shared baseline. Some own a private native cluster
// with an explicit teardown; others use no database. Keep integration reporting.
const NO_SHARED_PG_TESTS = new Set([
  // Read-only metadata worker over isolated filesystem fixtures; no SQL.
  '../lib/storage/retention-census-walk.integration.test.ts',
  // Installed Codex processes use an isolated home and local provider/MCP server; no SQL.
  '../lib/codex-managed-tools.native.integration.test.ts',
  // Installed Claude + private API; authority case owns a migrated native PG.
  '../lib/su-session-claude-mcp.integration.test.ts',
  // Actual OMP engine owns a private migrated native PG and offline provider.
  '../lib/su-session-omp-authority.integration.test.ts',
  '../lib/agent-tools/capability/vm-copy-authority-bridge.integration.test.ts',
  // Isolated repository fixtures and the provisioned syntax parser; no SQL or PG runtime.
  '../lib/agent-tools/plans/plan-native-declarations.integration.test.ts',
  // Disposable tracked Git repositories and notification AST classification; no database.
  '../lib/fire-and-forget-classification.integration.test.ts',
  '../lib/integration-substrate-selection.integration.test.ts',
  // Exercises the installed compiler socket and process identity; no database access.
  '../lib/tsc-service.integration.test.ts',
  // Real graph facade over isolated filesystem/AST fixtures; no database reads.
  '../lib/code-intelligence/reuse-graph.integration.test.ts',
  // Frozen clone corpus and current migrated source bodies; compiler/filesystem only.
  '../lib/code-intelligence/clone-remediation.integration.test.ts',
  // Owns a dedicated native PG cluster and applies only its isolated migration.
  '../lib/code-intelligence/test-coverage-map.integration.test.ts',
  // Supplies explicit in-memory providers; never initializes the native SQL adapters.
  '../lib/code-intelligence/reuse-brief-providers.integration.test.ts',
  // Owns a dedicated native cluster and migrates its private org database.
  '../lib/harness/routines/reconcile-loop-routines.integration.test.ts',
  // Owns a dedicated native cluster and migrates its private org database.
  '../lib/harness/routines/loop-turn-start-reconcile.integration.test.ts',
  // Owns its native PG cluster, confined endpoint, and observed teardown.
  '../lib/release/grading-audit-runtime.integration.test.ts',
  // Archives and DDL controls own a disposable native cluster, without a baseline.
  '../lib/search/bench/selected-corpus-schema.integration.test.ts',
  // Runs the ingest and completion readers in its own disposable current-build runtime.
  '../lib/search/session-ingest-loop-namespace.integration.test.ts',
  // Canonical HTTP bootstrap and real native CLI run in its disposable API/PG runtime.
  '../lib/search/loop-namespace-native.integration.test.ts',
].map(path => fileURLToPath(new URL(path, import.meta.url))));

export function integrationNeedsPostgres(selectedPaths: readonly string[]): boolean {
  // Vitest records selected specifications before globalSetup. Empty, mixed,
  // unknown and full-suite selections retain the existing database setup.
  return selectedPaths.length === 0 || selectedPaths.some(path => !NO_SHARED_PG_TESTS.has(resolve(path)));
}

type Teardown = () => void | Promise<void>;
type Setup<P> = (project: P) => Promise<void | Teardown>;
type Loaders<P> = { baseline: () => Promise<Setup<P>>; org: () => Promise<Setup<P>> };

const defaultLoaders: Loaders<TestProject> = {
  baseline: async () => (await import('../../../libs/test-config/src/baseline-schema-global-setup.ts')).default,
  org: async () => (await import('./_org-template.globalSetup.ts')).default,
};

export async function setupIntegrationSubstrate<P>(project: P, selectedPaths: readonly string[], loaders: Loaders<P>) {
  if (!integrationNeedsPostgres(selectedPaths)) return;
  // Lazy loading matters: PG-free selections must not import or initialize the
  // schema/container graph just to decide that they do not need it.
  const baseline = await loaders.baseline();
  const teardown = await baseline(project);
  try {
    const org = await loaders.org();
    await org(project);
  } catch (error) {
    await teardown?.();
    throw error;
  }
  return teardown;
}

export default async function setup(project: TestProject) {
  const selectedPaths = project.vitest.state.getPaths();
  project.provide('operatorIntegrationSubstrate', integrationNeedsPostgres(selectedPaths) ? 'postgres' : 'none');
  return setupIntegrationSubstrate(project, selectedPaths, defaultLoaders);
}
