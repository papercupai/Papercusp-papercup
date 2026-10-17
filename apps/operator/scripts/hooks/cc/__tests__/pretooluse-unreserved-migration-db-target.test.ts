import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reservationDatabaseRoot } from '../pretooluse-unreserved-migration-guard.mjs';
import { resolveScriptPgUrl } from '../../../../../../scripts/lib/pg-url.mjs';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

it('checks the allocator database even when repo-root config pins a different database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'migration-target-')); roots.push(root);
  await mkdir(join(root, 'apps/operator'), { recursive: true });
  await writeFile(join(root, '.env.local'), 'DATABASE_URL=postgres://localhost:19000/sidecar\n');
  await writeFile(join(root, 'apps/operator/.env.local'), 'DATABASE_URL=postgres://localhost:5432/operator\n');
  expect(resolveScriptPgUrl({ root: reservationDatabaseRoot(root), env: {} }).url).toBe('postgres://localhost:5432/operator');
  expect(resolveScriptPgUrl({ root, env: {} }).url).toBe('postgres://localhost:19000/sidecar');
  expect(resolveScriptPgUrl({ root: reservationDatabaseRoot(root), env: { HARNESS_ADMIN_DATABASE_URL: 'postgres://localhost:20000/private' } }).url)
    .toBe('postgres://localhost:20000/private');
});
