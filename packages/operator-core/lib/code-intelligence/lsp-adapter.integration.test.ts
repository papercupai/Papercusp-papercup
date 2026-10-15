/**
 * P-008 pilot proof: drive the thin in-operator LSP adapter against the REAL
 * pinned language server and score it on the frozen acceptance corpus
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`).
 *
 * This is deliberately an integration test, not a mock. A mocked language
 * server would prove only that our own translation layer round-trips — it
 * could not catch the failures that actually matter here: the D-009 tsserver
 * resolution, the zero-indexed wire protocol, and whether the server really
 * follows a bare specifier across a package boundary.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb } from '@papercusp/test-config/pg';
import type { ManagedSpawnResult } from '../task-manager/managed-spawn';

const capabilityDb = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined }));
const spawnedClient = vi.hoisted(() => ({ latest: null as ManagedSpawnResult | null }));
// The adapter is under test here, not the task ledger. The real registerTask
// writes the LIVE task_ledger, which the integration harness refuses
// (WI-10006585); the warn it logs then fails the test via fail-on-console.
// Same stub as lsp-daemon-managed.integration.test.ts (WI-6554700010012311).
vi.mock('../task-manager/enabled', () => ({ isTaskManagerEnabled: async () => true }));
vi.mock('../task-manager/store', () => ({
  registerTask: async (_spec: unknown, opts: { taskId: string }) => ({ taskId: opts.taskId, state: 'pending' }),
  markSpawned: async () => {}, closeTask: async () => {},
}));
vi.mock('../task-manager/managed-spawn', async original => {
  const actual = await original<typeof import('../task-manager/managed-spawn')>();
  return { ...actual, managedSpawn: async (...args: Parameters<typeof actual.managedSpawn>) => {
    const result = await actual.managedSpawn(...args);
    spawnedClient.latest = result;
    return result;
  } };
});
vi.mock('./lsp-capability-matrix', async original => {
  const actual = await original<typeof import('./lsp-capability-matrix')>();
  return { ...actual, lspCapabilityStore: new actual.PgLspCapabilityStore(() => {
    if (!capabilityDb.sql) throw new Error('isolated capability database is not initialized');
    return capabilityDb.sql;
  }) };
});

import {
  LSP_VENDOR_DIR,
  languageForFile,
  lspClientInventory,
  lspQuery,
  resolveServerBin,
  resolveTsserverPath,
  shutdownAllLspClients,
} from './lsp-adapter.ts';
import { corpusCase } from './acceptance-corpus.ts';
import { isTrustworthyEmpty } from './contracts.ts';
import { lspCapabilityStore } from './lsp-capability-matrix';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * Provisioned by P-007. When absent we SKIP rather than fail — but the skip
 * names exactly what is missing, because a silently-green skip is the same
 * false-negative this corpus exists to prevent.
 */
const TS_SERVER_PRESENT = resolveServerBin('typescript') !== null;
const skipReason = TS_SERVER_PRESENT
  ? ''
  : `pinned typescript-language-server not provisioned under ${LSP_VENDOR_DIR} — run P-007 provisioning`;
let dropCapabilityDb: (() => Promise<unknown>) | undefined;

afterAll(async () => {
  await shutdownAllLspClients();
  await capabilityDb.sql?.end({ timeout: 5 });
  await dropCapabilityDb?.();
});

describe('adapter wiring (no server needed)', () => {
  it('maps files to the language server that can answer for them', () => {
    expect(languageForFile('/x/a.ts')).toBe('typescript');
    expect(languageForFile('/x/a.tsx')).toBe('typescript');
    expect(languageForFile('/x/a.rs')).toBe('rust');
    expect(languageForFile('/x/a.py')).toBe('python');
    expect(languageForFile('/x/a.go')).toBe('go');
    expect(languageForFile('/x/README.md')).toBeNull();
  });

  it('declines an intent it does not serve, without pretending to be empty', async () => {
    const answer = await lspQuery('pack', {
      file: '/x/a.ts',
      line1: 1,
      character: 0,
      rootPath: REPO_ROOT,
    });
    expect(answer.sites).toHaveLength(0);
    expect(answer.error).toMatch(/not served/);
    // The critical property: an unserved intent must NOT read as "no results".
    expect(answer.freshness.health).toBe('unknown');
    expect(isTrustworthyEmpty(answer)).toBe(true); // trustworthy because it is LOUD
  });

  it('declines a file with no pinned server rather than guessing', async () => {
    const answer = await lspQuery('definition', {
      file: '/x/a.cpp',
      line1: 1,
      character: 0,
      rootPath: REPO_ROOT,
    });
    expect(answer.error).toMatch(/no pinned language server/);
    expect(answer.sites).toHaveLength(0);
  });
});

describe.skipIf(!TS_SERVER_PRESENT)(`LSP adapter against the pinned server ${skipReason}`, () => {
  beforeAll(async () => {
    const db = await createFreshTestDb({ prefix: 'lsp_pinned_caps' });
    dropCapabilityDb = db.drop;
    capabilityDb.sql = postgres(db.url, { max: 2, prepare: false, onnotice: () => {} });
    await capabilityDb.sql.unsafe('CREATE SCHEMA harness_shared');
    await capabilityDb.sql.unsafe(readFileSync(
      join(REPO_ROOT, 'libs/papercusp/libs/db/sql/1361-lsp-capability-matrix.sql'), 'utf8',
    ));
  }, 120_000);

  it('refuses failed capability initialization and gracefully exits the unregistered pinned server', async () => {
    const failedWrite = vi.spyOn(lspCapabilityStore, 'observe').mockRejectedValue(new Error('capability write unavailable'));
    try {
      const answer = await lspQuery('definition', {
        file: join(REPO_ROOT, 'libs/generic/search/src/leg-health.ts'), line1: 41,
        character: 11, rootPath: REPO_ROOT,
      });
      expect(answer.error).toMatch(/capability initialization failed: capability write unavailable/);
      expect(answer.freshness.health).toBe('unhealthy');
      expect(lspClientInventory()).toHaveLength(0);
      expect(spawnedClient.latest?.child.exitCode).toBe(0);
      expect(spawnedClient.latest?.child.killed).toBe(false);
    } finally { failedWrite.mockRestore(); }
  }, 30_000);

  it('resolves tsserver.js despite the repo TypeScript shipping none (D-009)', () => {
    const p = resolveTsserverPath();
    expect(existsSync(p)).toBe(true);
    expect(p).toMatch(/tsserver\.js$/);
    // The whole point of D-009: it must NOT come from the repo's pinned
    // @typescript/typescript6, which has no tsserver.js at all.
    expect(existsSync(join(LSP_VENDOR_DIR, 'node_modules/typescript/lib/tsserver.js'))).toBe(false);
  });

  it(
    'answers the corpus definition case across a package boundary, one-indexed',
    { timeout: 90_000 },
    async () => {
      const kase = corpusCase('definition-cross-package-bare-specifier');
      expect(kase, 'corpus case missing').toBeDefined();
      const expectedSite = kase!.expectedSites[0];

      // Ask from the IMPORT site — libs/generic/search/src/leg-health.ts line 41
      // imports pinModuleState by the bare specifier '@papercusp/module-singleton'.
      // Resolving this requires following the npm-workspace symlink, which is
      // exactly what a text-matching backend cannot do.
      const file = join(REPO_ROOT, 'libs/generic/search/src/leg-health.ts');
      const sourceHash = createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex');
      const answer = await lspQuery('definition', {
        file,
        line1: 41,
        character: 11,
        rootPath: REPO_ROOT,
      });

      expect(answer.error, `LSP definition failed: ${answer.error}`).toBeNull();
      expect(answer.freshness.health).toBe('healthy');
      expect(answer.sites.length).toBeGreaterThan(0);

      const hit = answer.sites[0];
      expect(hit.path).toBe(expectedSite.path);
      // THE off-by-one guard. The LSP wire is zero-indexed and reports 105; the
      // adapter must hand back 106, matching the corpus fixture that was
      // measured independently with grep. If someone removes toOneIndexed(),
      // this is the test that fails.
      expect(hit.line1).toBe(expectedSite.line1);
      expect(hit.line1).toBe(106);
      expect(answer.evidence!.sourceScope.supportingFiles).toContainEqual({
        path: 'libs/generic/search/src/leg-health.ts', contentHash: sourceHash,
        language: 'typescript', representation: 'full-source',
      });
      // The server loaded the target without didOpen. Its location is real,
      // but a later disk hash would invent an unobserved input version.
      expect(answer.evidence!.siteIdentities[0]).toMatchObject({
        sourcePath: expectedSite.path, contentHash: null, versionedSymbolId: null,
      });
      expect(answer.evidence!.relationships[0]).toMatchObject({
        origin: 'compiler', knowledge: 'observed', runtimeExecution: 'unknown',
      });
      expect(answer.freshness.staleVsDisk).toBeNull();
    },
  );

  it('enrolls the language server in the task ledger, not as a bare spawn', async () => {
    const inv = lspClientInventory();
    expect(inv.length).toBeGreaterThan(0);
    const ts = inv.find((c) => c.language === 'typescript');
    expect(ts, 'no typescript client in the inventory').toBeDefined();
    // managedSpawn-issued taskId is what makes the child killable by id and
    // visible in processes:list — never killable by name.
    expect(ts!.taskId).toBeTruthy();
    expect(ts!.pid).toBeGreaterThan(0);
    expect(ts!.health).toBe('healthy');
  });

  it('reports a real latency and never a negative one', async () => {
    const file = join(REPO_ROOT, 'libs/generic/search/src/leg-health.ts');
    const answer = await lspQuery('definition', {
      file,
      line1: 41,
      character: 11,
      rootPath: REPO_ROOT,
    });
    expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
    expect(answer.latencyMs).toBeLessThan(30_000);
    expect(answer.backend).toBe('lsp-adapter');
  });
});
