import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSystemAction } from './system-actions';
import './gitnexus-reindex-action';

const fixture = vi.hoisted(() => ({ snapshot: '', indexReads: [] as string[], sql: vi.fn(), spawn: vi.fn() }));
vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>();
  return { ...original, readFileSync: (...args: unknown[]) => {
    if (String(args[0]).includes('.gitnexus')) fixture.indexReads.push(String(args[0]));
    return Reflect.apply(original.readFileSync, original, args);
  } };
});
vi.mock('@papercusp/db-org', async importOriginal => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: { unsafe: fixture.sql } }),
}));
vi.mock('../../alarm-attention', async importOriginal => ({
  ...await importOriginal<typeof import('../../alarm-attention')>(),
  resolveAlarm: vi.fn(async () => false),
}));
vi.mock('../../task-manager/managed-spawn', () => ({ managedSpawn: fixture.spawn }));
vi.mock('../../code-intelligence/dependency-snapshot-path', () => ({ dependencySnapshotPath: () => fixture.snapshot }));
vi.mock('../operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'snapshot-fixture' }));

let root: string;
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-17T00:00:00Z'));
  root = mkdtempSync(join(tmpdir(), 'gitnexus-source-only-'));
  fixture.snapshot = join(root, 'dependency-snapshot.json');
  fixture.indexReads = [];
  fixture.sql.mockReset().mockImplementation(async (query: string) => {
    // Default maintenance must never fall through into capacity/index health writes.
    if (!query.includes('dependencySnapshot')) throw new Error('unexpected optional-index SQL');
    return query.startsWith('SELECT') ? [{ ds: null }] : [];
  });
  fixture.spawn.mockReset().mockImplementation(() => { throw new Error('unexpected analyzer/producer spawn'); });
  vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  writeFileSync(fixture.snapshot, JSON.stringify({ schema: 'graph-dependency-snapshot-v1',
    index: { lastCommit: 'a'.repeat(40), backend: 'first-party-imports' }, generatedAt: new Date(Date.now() - 7_200_000).toISOString(),
    edges: [{ importer: 'app/use.ts', imported: 'lib/target.ts', importerSha256: 'b'.repeat(64) }] }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('registered hourly source-only maintenance', () => {
  it.each([{}, { analyze_enabled: false }, { analyze_enabled: 'true' }, { analyze_enabled: 1 }])(
    'refreshes and records a fresh snapshot without touching the optional index: %j', async triggerConfig => {
      const result = await getSystemAction('gitnexus-reindex')!({ installSlug: 'snapshot-fixture', workspaceId: 'fixture',
        triggerConfig, payloadTemplate: null });
      expect(result).toEqual({ diagnostics: { maintenanceMode: 'first-party-snapshot',
        snapshotBackend: 'first-party-imports', analyzeEnabled: false,
        dependencySnapshot: { backend: 'first-party-imports', status: 'fresh', reason: null,
          checkedAt: Date.now(), generatedAt: '2026-10-16T22:00:00.000Z', ageMs: 7_200_000,
          edges: 1, selectorCeilingMs: 86_400_000, producerRan: false, producerExit: null } } });
      expect(fixture.sql).toHaveBeenCalledTimes(2);
      expect(fixture.sql.mock.calls[1]?.[1]?.[1]).toContain('"status":"fresh"');
      expect(fixture.indexReads).toEqual([]);
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('dependency snapshot fresh'));
    },
  );

  it('records an unavailable measurement and soft error when the initial health read fails', async () => {
    fixture.sql.mockRejectedValueOnce(new Error('health read unavailable'));
    const result = await getSystemAction('gitnexus-reindex')!({ installSlug: 'snapshot-fixture', workspaceId: 'fixture',
      triggerConfig: {}, payloadTemplate: null });
    expect(result).toEqual({ diagnostics: { maintenanceMode: 'first-party-snapshot',
      snapshotBackend: 'first-party-imports', analyzeEnabled: false,
      dependencySnapshot: { unavailable: 'health read unavailable' } },
      softError: 'dependency snapshot: health read unavailable' });
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('retains the measured snapshot with a separate tracking error when metadata persistence fails', async () => {
    fixture.sql.mockImplementation(async (query: string) => {
      if (query.startsWith('SELECT')) return [{ ds: null }];
      throw new Error('metadata write unavailable');
    });
    const result = await getSystemAction('gitnexus-reindex')!({ installSlug: 'snapshot-fixture', workspaceId: 'fixture',
      triggerConfig: {}, payloadTemplate: null });
    expect(result).toMatchObject({ diagnostics: { dependencySnapshot: { status: 'fresh',
      checkedAt: Date.now(), generatedAt: '2026-10-16T22:00:00.000Z', ageMs: 7_200_000,
      trackingError: 'metadata write unavailable' } }, softError: 'dependency snapshot: metadata write unavailable' });
    expect(fixture.spawn).not.toHaveBeenCalled();
  });

  it('refuses a graph-produced snapshot without explicit analyzer admission', async () => {
    await expect(getSystemAction('gitnexus-reindex')!({ installSlug: 'snapshot-fixture', workspaceId: 'fixture',
      triggerConfig: { snapshot_backend: 'gitnexus' }, payloadTemplate: null }))
      .rejects.toThrow('requires analyze_enabled:true');
    expect(fixture.sql).not.toHaveBeenCalled();
    expect(fixture.indexReads).toEqual([]);
    expect(fixture.spawn).not.toHaveBeenCalled();
  });
});
