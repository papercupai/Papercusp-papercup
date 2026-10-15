import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStateCensusComplete, collectStateCensus, generateStateCensus, backupCacheCensusDeclarations, databaseCensusSnapshotCoverage, type CensusDeclaration } from './state-census';

const declaration: CensusDeclaration = {
  kind: 'path', root: 'app-home', name: 'hives', classification: 'state',
  producer: 'hive-store', descendants: true,
};

describe('producer-derived state census', () => {
  it('reports unknown subtree frontier as failing residue without hiding registered descendants', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontier-census-'));
    try {
      await mkdir(join(root, 'unknown'));
      await writeFile(join(root, 'unknown', 'nested'), 'unclassified');
      const input = { roots: [{ id: 'home', path: root }], declarations: [], readCatalogs: async () => [] };
      const frontier = await collectStateCensus({ ...input, representUnknownSubtrees: true, maxEntries: 1 });
      expect(frontier.ok).toBe(false);
      expect(frontier.residue[0].name).toBe('unknown');
      expect(frontier.representedUnknown[0].disposition).toBe('unclassified-subtree');
      const expanded = await collectStateCensus({ ...input, representUnknownSubtrees: true,
        declarations: [{ kind: 'path', root: 'home', name: 'unknown/nested', classification: 'secret', producer: 'fixture' }] });
      expect(expanded.representedUnknown).toEqual([]);
      expect(expanded.inventory.some(entry => entry.name === 'unknown/nested' && entry.classification === 'secret')).toBe(true);
      await expect(collectStateCensus({ ...input, maxEntries: 1 })).rejects.toThrow('bound');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains producer-owned audit history while refusing cache or conflicting descendant ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'audit-census-'));
    try {
      await mkdir(join(root, 'history'));
      await writeFile(join(root, 'history', 'verdict'), 'audit');
      const owner: CensusDeclaration = { kind: 'path', root: 'home', name: 'history', classification: 'state',
        producer: 'checkpoint', descendants: true, retainedSubtree: { evidenceRef: 'fixture:log-writer' } };
      const input = { roots: [{ id: 'home', path: root }], declarations: [owner], readCatalogs: async () => [] };
      expect((await collectStateCensus({ ...input, maxEntries: 1 })).representedSubtrees[0].disposition).toBe('preserve-state-subtree');
      await expect(collectStateCensus({ ...input, declarations: [{ ...owner, classification: 'cache' }] })).rejects.toThrow('Retained subtree');
      const conflict = await collectStateCensus({ ...input, declarations: [owner,
        { ...owner, name: 'history/verdict', classification: 'secret', retainedSubtree: undefined, descendants: false }] });
      expect(conflict.representedSubtrees).toEqual([]);
      expect(conflict.ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains completed recovery clones without disguising an overridden descendant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'recovery-census-'));
    try {
      await mkdir(join(root, 'clone'));
      await writeFile(join(root, 'clone', 'state'), 'recovery');
      const owner: CensusDeclaration = { kind: 'path', root: 'home', name: 'clone', classification: 'state',
        producer: 'restore-to-clone', descendants: true, recoveryStorage: { restoreEventId: '123', evidenceRef: 'fixture:event' } };
      const input = { roots: [{ id: 'home', path: root }], declarations: [owner], readCatalogs: async () => [] };
      expect((await collectStateCensus({ ...input, maxEntries: 1 })).representedRecoveries[0].disposition).toBe('preserve-state-subtree');
      const conflict = await collectStateCensus({ ...input, declarations: [owner,
        { ...owner, name: 'clone/state', classification: 'secret', recoveryStorage: undefined, descendants: false }] });
      expect(conflict.representedRecoveries).toEqual([]);
      expect(conflict.ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('retains published runtime artifacts as state and refuses nested cache overrides', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-census-'));
    try {
      await mkdir(join(root, 'release'));
      await writeFile(join(root, 'release', 'chunk'), 'runtime');
      const owner: CensusDeclaration = { kind: 'path', root: 'home', name: 'release', classification: 'state',
        producer: 'portal', descendants: true,
        releaseStorage: { manifestSha256: 'a'.repeat(64), evidenceRef: 'fixture:release' } };
      const input = { roots: [{ id: 'home', path: root }], declarations: [owner], readCatalogs: async () => [] };
      expect((await collectStateCensus({ ...input, maxEntries: 1 })).representedReleases[0].disposition).toBe('preserve-state-subtree');
      const conflicting = await collectStateCensus({ ...input, declarations: [owner,
        { ...owner, name: 'release/chunk', classification: 'cache', releaseStorage: undefined, descendants: false }] });
      expect(conflicting.representedReleases).toEqual([]);
      expect(conflicting.ok).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves peer storage while keeping nested conflicting ownership visible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'peer-census-'));
    try {
      await mkdir(join(root, 'peer'));
      await writeFile(join(root, 'peer', 'log'), 'persistent');
      const owner: CensusDeclaration = { kind: 'path', root: 'home', name: 'peer', classification: 'state',
        producer: 'corestore', descendants: true,
        peerStorage: { markerSha256: 'a'.repeat(64), evidenceRef: 'fixture:marker' } };
      const input = { roots: [{ id: 'home', path: root }], declarations: [owner], readCatalogs: async () => [] };
      const census = await collectStateCensus({ ...input, maxEntries: 1 });
      expect(census.ok).toBe(true);
      expect(census.representedPeers[0]).toMatchObject({ name: 'peer', disposition: 'preserve-state-subtree' });
      const conflict = await collectStateCensus({ ...input, declarations: [owner,
        { ...owner, name: 'peer/log', classification: 'cache', peerStorage: undefined, descendants: false }] });
      expect(conflict.representedPeers).toEqual([]);
      expect(conflict.residue[0].name).toBe('peer/log');
      await expect(collectStateCensus({ ...input, declarations: [{ ...owner, classification: 'cache' }] }))
        .rejects.toThrow('Peer storage');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('preserves explicitly measured git metadata rather than labeling local history cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'git-census-'));
    try {
      await mkdir(join(root, '.git'));
      await writeFile(join(root, '.git', 'local-history'), 'fixture');
      const census = await collectStateCensus({ roots: [{ id: 'repo', path: root }],
        declarations: [{ kind: 'path', root: 'repo', name: '.git', classification: 'state', producer: 'git',
          descendants: true, gitStorage: { head: 'a'.repeat(40), evidenceRef: 'fixture:git-head' } }],
        maxEntries: 1, readCatalogs: async () => [], });
      expect(census.representedGit[0].disposition).toBe('preserve-state-subtree');
      expect(census.ok).toBe(true);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('validates external file selections while preserving full-root drift checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'selected-census-'));
    try {
      await writeFile(join(root, 'token'), 'opaque');
      await mkdir(join(root, 'other'));
      const input = { roots: [{ id: 'external', path: root, fileNames: ['token'] }],
        declarations: [], readCatalogs: async () => [] };
      expect((await collectStateCensus(input)).residue.map(entry => entry.name)).toEqual(['token']);
      await expect(collectStateCensus({ ...input, roots: [{ ...input.roots[0], fileNames: ['../token'] }] }))
        .rejects.toThrow('Non-canonical');
      await expect(collectStateCensus({ ...input, roots: [{ ...input.roots[0], fileNames: ['other'] }] }))
        .rejects.toThrow('directory');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('represents measured database storage as preserved state, not a disposable cache', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pg-census-'));
    try {
      await mkdir(join(root, 'pg'));
      await writeFile(join(root, 'pg', 'binary-storage'), 'fixture');
      const census = await collectStateCensus({ roots: [{ id: 'home', path: root }],
        declarations: [{ kind: 'path', root: 'home', name: 'pg', classification: 'state', producer: 'postgres',
          descendants: true, databaseStorage: { systemIdentifier: '123', evidenceRef: 'fixture:pg-control' } }],
        maxEntries: 1, readCatalogs: async () => [],
      });
      expect(census.ok).toBe(true);
      expect(census.representedStorage[0]).toMatchObject({ name: 'pg', disposition: 'preserve-state-subtree' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('keeps snapshot evidence fail-closed and separate from ownership classification', () => {
    const entries = [{ kind: 'database' as const, root: 'postgres-cluster:123', name: 'app' }];
    const report = databaseCensusSnapshotCoverage({ entries, systemIdentifier: '123', status: null, nowEpoch: 1000 });
    expect(report[0].coverage.covered).toBe(false);
    expect(generateStateCensus(entries, []).ok).toBe(false);
    expect(databaseCensusSnapshotCoverage({ entries, systemIdentifier: '456',
      status: { ok: true, systemIdentifier: '456', lastSuccessEpoch: 1000, dumped: ['app'] }, nowEpoch: 1000,
    })[0].coverage.covered).toBe(false);
  });
  it('fails closed on entry limits rather than certifying a truncated inventory', async () => {
    const entries = [declaration, { ...declaration, name: 'other' }];
    await expect(collectStateCensus({ roots: [], declarations: [],
      readCatalogs: async () => entries, maxEntries: 1,
    })).rejects.toThrow('entry bound exceeded');
    await expect(collectStateCensus({ roots: [], declarations: [],
      readCatalogs: async () => [], maxEntries: 0,
    })).rejects.toThrow('Invalid census entry bound');
  });
  it('derives rebuildable caches but never backup-repository or recovery-debris classification from ignores', () => {
    const declarations = backupCacheCensusDeclarations('home');
    const census = generateStateCensus(['node_modules/pkg', 'projects/a/node_modules/pkg', 'venv/lib/site-packages/pkg', 'projects/node_modules-old', 'backups', '.broken-old'].map(name =>
      ({ kind: 'path' as const, root: 'home', name })), declarations);
    expect(census.inventory.find(entry => entry.name === 'node_modules/pkg')?.classification).toBe('cache');
    expect(census.inventory.find(entry => entry.name === 'projects/a/node_modules/pkg')?.classification).toBe('cache');
    expect(census.inventory.find(entry => entry.name === 'venv/lib/site-packages/pkg')?.classification).toBe('cache');
    expect(census.residue.map(entry => entry.name).sort()).toEqual(['.broken-old', 'backups', 'projects/node_modules-old']);
  });
  it('rejects non-canonical paths and empty producer identities', () => {
    for (const name of ['/outside', '../outside', 'hives/../outside', 'hives//project', 'hives\\project']) {
      expect(() => generateStateCensus([{ ...declaration, name }], [declaration]))
        .toThrow('Non-canonical census path');
    }
    expect(() => generateStateCensus([declaration], [{ ...declaration, producer: ' ' }]))
      .toThrow('Missing census producer');
  });
  it('keeps an explicit cache root in inventory while pruning its rebuildable contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await mkdir(join(root, 'cache'));
      await writeFile(join(root, 'cache', 'derived'), 'rebuildable');
      const census = await collectStateCensus({
        roots: [{ id: 'app-home', path: root }], readCatalogs: async () => [],
        declarations: [{ ...declaration, name: 'cache', classification: 'cache', prune: true }],
      });
      expect(census.ok).toBe(true);
      expect(census.inventory.map(entry => entry.name)).toEqual(['cache']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses pruning state, secrets or unowned subtree descendants', async () => {
    for (const invalid of [declaration, { ...declaration, classification: 'secret' as const },
      { ...declaration, classification: 'cache' as const, descendants: false }]) {
      await expect(collectStateCensus({ roots: [], readCatalogs: async () => [],
        declarations: [{ ...invalid, prune: true }],
      })).rejects.toThrow('explicitly owned rebuildable subtree');
    }
  });

  it('collects a real fixture and detects newly introduced unclassified paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await mkdir(join(root, 'hives'));
      await writeFile(join(root, 'hives', 'project'), 'state');
      const read = () => collectStateCensus({
        roots: [{ id: 'app-home', path: root }], declarations: [declaration],
        readCatalogs: async () => [],
      });
      expect((await read()).ok).toBe(true);
      await writeFile(join(root, 'unknown'), 'new state');
      const changed = await read();
      expect(() => assertStateCensusComplete(changed)).toThrow('unknown');
      await expect(collectStateCensus({ roots: [{ id: 'fixture-root', path: root }],
        declarations: [], readCatalogs: async () => [], maxEntries: 1,
      })).rejects.toThrow(/root=fixture-root; path=/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('inventories symlinks without traversing outside the root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await symlink(root, join(root, 'cycle'));
      const census = await collectStateCensus({
        roots: [{ id: 'app-home', path: root }], declarations: [],
        readCatalogs: async () => [],
      });
      expect(census.inventory.map(entry => entry.name)).toEqual(['cycle']);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects unreadable inventory and catalog sources instead of certifying an empty census', async () => {
    await expect(collectStateCensus({ roots: [], declarations: [],
      readCatalogs: async () => { throw new Error('catalog unavailable'); },
    })).rejects.toThrow('catalog unavailable');
    const root = await mkdtemp(join(tmpdir(), 'backup-census-'));
    try {
      await expect(collectStateCensus({ roots: [{ id: 'home', path: join(root, 'missing') }],
        declarations: [], readCatalogs: async () => [],
      })).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('fails drift verification when a new path has no producer declaration', () => {
    const census = generateStateCensus([
      { kind: 'path', root: 'app-home', name: 'hives/project' },
      { kind: 'path', root: 'app-home', name: 'new-state' },
    ], [declaration]);
    expect(census.residue).toHaveLength(1);
    expect(() => assertStateCensusComplete(census)).toThrow('unclassified:path:app-home:new-state');
  });

  it('does not conflate roots or directory-name prefixes', () => {
    const census = generateStateCensus([
      { kind: 'path', root: 'config-home', name: 'hives/project' },
      { kind: 'path', root: 'app-home', name: 'hives-old/project' },
    ], [declaration]);
    expect(census.residue).toHaveLength(2);
  });

  it('fails on conflicting declarations instead of choosing the first', () => {
    const census = generateStateCensus([declaration], [declaration,
      { ...declaration, classification: 'cache', producer: 'other' }]);
    expect(census.inventory[0].classification).toBeNull();
    expect(() => assertStateCensusComplete(census)).toThrow('conflicting');
  });

  it('covers each non-path entry only by exact producer identity', () => {
    const entries: CensusDeclaration[] = ['database', 'unit', 'secret'].map(kind => ({
      kind: kind as CensusDeclaration['kind'], root: 'host', name: kind,
      classification: kind === 'secret' ? 'secret' : 'state', producer: kind,
    }));
    const census = generateStateCensus(entries, entries);
    expect(census.ok).toBe(true);
    expect(() => assertStateCensusComplete(census)).not.toThrow();
  });

  it.each(['database', 'unit', 'secret'] as const)(
    'rejects an unclassified %s without hiding declared catalog entries', kind => {
      const owned: CensusDeclaration = {
        kind, root: 'host', name: 'owned',
        classification: kind === 'secret' ? 'secret' : 'state', producer: 'fixture',
      };
      const baseline = generateStateCensus([owned], [owned]);
      expect(baseline.ok).toBe(true);
      expect(baseline.inventory).toHaveLength(1);
      expect(baseline.inventory[0].classification).toBe(owned.classification);
      expect(() => assertStateCensusComplete(baseline)).not.toThrow();

      const changed = generateStateCensus([
        owned, { kind, root: 'host', name: 'unowned' },
      ], [owned]);
      expect(changed.ok).toBe(false);
      expect(changed.inventory).toHaveLength(2);
      expect(changed.residue.map(entry => entry.name)).toEqual(['unowned']);
      expect(() => assertStateCensusComplete(changed))
        .toThrow(`unclassified:${kind}:host:unowned`);
    },
  );
});
