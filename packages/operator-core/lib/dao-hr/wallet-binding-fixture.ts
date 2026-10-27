/**
 * Typed loader for scripts/fixtures/dao-hr-wallet-binding.ts.
 *
 * That fixture serves the real operator-public wallet-binding route, so it
 * imports operator-public sources typed against Cloudflare Workers ambient
 * globals (D1Database, KVNamespace, R2Bucket, ...). Those globals are declared
 * only in operator-public's program (`types: ["@cloudflare/workers-types"]`),
 * which includes the fixture and typechecks it. operator-core's program loads
 * `types: ["node"]` only, so a static import from an operator-core test pulled
 * the operator-public files in without their globals and red-pinned the
 * operator-core tsc leg (WI-6554700010009313).
 *
 * The specifier below is deliberately non-literal: tsc does not follow it, and
 * Vitest still resolves it at run time. The return type comes from a
 * Workers-free contract that the fixture's own signature is annotated with.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DaoHrWalletBindingFixture } from '../../../../scripts/fixtures/dao-hr-wallet-binding-contract';
import { moduleRepoRoot } from '../module-repo-root';

export type { DaoHrWalletBindingFixture };

const FIXTURE_MODULE = pathToFileURL(join(moduleRepoRoot(import.meta.url), 'scripts/fixtures/dao-hr-wallet-binding.ts')).href;

export async function startDaoHrWalletBindingFixture(): Promise<DaoHrWalletBindingFixture> {
  const fixture = (await import(FIXTURE_MODULE)) as {
    startDaoHrWalletBindingFixture(): Promise<DaoHrWalletBindingFixture>;
  };
  return fixture.startDaoHrWalletBindingFixture();
}
