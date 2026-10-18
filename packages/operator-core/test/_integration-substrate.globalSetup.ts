import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {} from 'vitest';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  interface ProvidedContext {
    operatorIntegrationSubstrate?: 'postgres' | 'none';
  }
}

// Real private HTTP/MCP transport, with fictional authorities and no database.
// Keep the integration layer/reporters; only omit substrates this suite never uses.
const PG_FREE_TESTS = new Set([
  '../lib/agent-tools/capability/vm-copy-authority-bridge.integration.test.ts',
  '../lib/integration-substrate-selection.integration.test.ts',
].map(path => fileURLToPath(new URL(path, import.meta.url))));

export function integrationNeedsPostgres(selectedPaths: readonly string[]): boolean {
  // Vitest records selected specifications before globalSetup. Empty, mixed,
  // unknown and full-suite selections retain the existing database setup.
  return selectedPaths.length === 0 || selectedPaths.some(path => !PG_FREE_TESTS.has(resolve(path)));
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
