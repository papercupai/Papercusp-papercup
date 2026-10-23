/**
 * The git-sync QUARANTINE-IMPORT guard (EI-19932544083689229 remedy #1 — ATOMICITY).
 *
 * Pure + seam-injected (readText only — no real repo, no git subprocess). Pins the
 * load-bearing behavior: a dirty file that imports an ALREADY-QUARANTINED path is
 * itself quarantined (so `commitOneRepo` excludes it too), a chain of dirty importers
 * is caught to a fixed point, an unrelated dirty file is left alone, and a read
 * failure is skipped (fail open) rather than blocking the commit.
 */
import { describe, it, expect } from 'vitest';
import {
  collectDirtyImportEdges,
  detectQuarantineImporters,
  detectStagedProvidersOfHeldImporters,
  extractSideEffectOnlySpecifiers,
} from './quarantine-import-guard';

describe('detectStagedProvidersOfHeldImporters read budget', () => {
  it.each([
    ['unchanged exports', 'export const value = 1;', 'export const value = 2;'],
    ['additive exports', 'export const value = 1;', 'export const value = 1; export const added = 2;'],
    ['new provider', null, 'export const value = 1;'],
  ])('does not read held consumers for %s', async (_label, head, index) => {
    const headReads: string[] = [];
    const held = Array.from({ length: 256 }, (_, n) => `held/consumer-${n}.ts`);
    const offenders = await detectStagedProvidersOfHeldImporters({
      stagedFiles: ['provider.ts'],
      heldImporters: held,
      readHeadText: async path => {
        headReads.push(path);
        return path === 'provider.ts' ? head : "import { value } from '../provider';";
      },
      readIndexText: async path => path === 'provider.ts' ? index : null,
    });
    expect(offenders).toEqual([]);
    expect(headReads).toEqual(['provider.ts']);
  });

  it('still follows removed exports through held providers to a fixed point', async () => {
    const head: Record<string, string> = {
      'consumer.ts': "import { first } from './first';",
      'first.ts': "import { second } from './second'; export const first = second;",
      'second.ts': 'export const second = 1;',
    };
    const index: Record<string, string> = {
      'first.ts': 'export const replacement = 1;',
      'second.ts': 'export const replacement = 2;',
    };
    const offenders = await detectStagedProvidersOfHeldImporters({
      stagedFiles: Object.keys(index),
      heldImporters: ['consumer.ts'],
      readHeadText: async path => head[path] ?? null,
      readIndexText: async path => index[path] ?? null,
    });
    expect(offenders.map(row => row.file)).toEqual(['first.ts', 'second.ts']);
  });

  it('does not scan unrelated staged providers when held consumers are the smaller set', async () => {
    const unrelated = Array.from({ length: 256 }, (_, n) => `unrelated-${n}.ts`);
    const reads: string[] = [];
    const offenders = await detectStagedProvidersOfHeldImporters({
      stagedFiles: ['provider.ts', ...unrelated],
      heldImporters: ['consumer.ts'],
      readHeadText: async path => {
        reads.push(path);
        if (path === 'consumer.ts') return "import { value } from './provider';";
        return path.endsWith('.ts') ? 'export const value = 1;' : null;
      },
      readIndexText: async path => { reads.push(path); return 'export const value = 2;'; },
    });
    expect(offenders).toEqual([]);
    expect(reads.filter(path => unrelated.includes(path))).toEqual([]);
  });

  it.each([
    ['default', "import old from './provider';", 'export default 1;', 'export const replacement = 1;'],
    ['namespace', "import * as old from './provider';", 'export const old = 1;', 'export const replacement = 1;'],
    ['star edge', "import { old } from './provider';", "export * from './old';", "export * from './replacement';"],
  ])('preserves the removal guard for a %s binding', async (_label, consumer, before, after) => {
    const offenders = await detectStagedProvidersOfHeldImporters({
      stagedFiles: ['provider.ts'],
      heldImporters: ['consumer.ts'],
      readHeadText: async path => path === 'provider.ts' ? before : path === 'consumer.ts' ? consumer : null,
      readIndexText: async path => path === 'provider.ts' ? after : null,
    });
    expect(offenders.map(row => row.file)).toEqual(['provider.ts']);
  });

  it('bounds concurrent consumer reads while avoiding a serial Git round trip per consumer', async () => {
    let active = 0;
    let peak = 0;
    const offenders = await detectStagedProvidersOfHeldImporters({
      stagedFiles: ['provider.ts'],
      heldImporters: Array.from({ length: 40 }, (_, n) => `held/consumer-${n}.ts`),
      readHeadText: async path => {
        if (path === 'provider.ts') return 'export const old = 1;';
        if (!path.startsWith('held/')) return null;
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        return "import { old } from '../provider';";
      },
      readIndexText: async () => 'export const replacement = 1;',
    });
    expect(offenders.map(row => row.file)).toEqual(['provider.ts']);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});

describe('collectDirtyImportEdges (WI-6554700010019415)', () => {
  const files: Record<string, string> = {
    'scripts/lib/test-pass-reuse.mjs': 'export const reuse = 1;\n',
    'scripts/affected-tests.mjs': "import { reuse } from './lib/test-pass-reuse.mjs';\n",
    'packages/core/lib/__tests__/drift.test.ts':
      "import { reuse } from '../../../../scripts/lib/test-pass-reuse.mjs';\nimport { x } from '@scope/pkg/x';\n",
    'packages/pkg/package.json': JSON.stringify({ name: '@scope/pkg', exports: { './x': './src/x.ts' } }),
    'packages/pkg/src/x.ts': 'export const x = 1;\n',
    'lib/hub.ts': "import './tool';\n",
    'lib/tool.ts': 'export const tool = 1;\n',
    'lib/unrelated.ts': "import { y } from './not-dirty';\n",
  };
  const readText = async (rel: string) => files[rel] ?? null;

  it('resolves relative and repository-package binding edges among the given files only', async () => {
    const edges = await collectDirtyImportEdges({ readText, files: Object.keys(files) });
    const pairs = edges.map((e) => `${e.importer} -> ${e.provider}`).sort();
    expect(pairs).toEqual([
      'packages/core/lib/__tests__/drift.test.ts -> packages/pkg/src/x.ts',
      'packages/core/lib/__tests__/drift.test.ts -> scripts/lib/test-pass-reuse.mjs',
      'scripts/affected-tests.mjs -> scripts/lib/test-pass-reuse.mjs',
    ]);
  });

  it('skips a side-effect-only edge, which never holds its provider', async () => {
    const edges = await collectDirtyImportEdges({ readText, files: ['lib/hub.ts', 'lib/tool.ts'] });
    expect(edges).toEqual([]);
  });

  it('skips an unreadable file instead of failing', async () => {
    const edges = await collectDirtyImportEdges({
      readText: async (rel) => {
        if (rel === 'scripts/affected-tests.mjs') throw new Error('EACCES');
        return files[rel] ?? null;
      },
      files: ['scripts/affected-tests.mjs', 'scripts/lib/test-pass-reuse.mjs'],
    });
    expect(edges).toEqual([]);
  });
});

describe('detectQuarantineImporters', () => {
  it('EI-25795290390864278: holds a generated declaration with its turn-held .mjs source', async () => {
    const source = 'apps/operator/scripts/example-launcher.mjs';
    const declaration = 'apps/operator/scripts/example-launcher.d.mts';
    const files: Record<string, string> = {
      [declaration]:
        '#!/usr/bin/env node\n' +
        '// GENERATED by `npm run gen:declarations` from apps/operator/scripts/example-launcher.mjs. DO NOT EDIT.\n' +
        'export declare function main(): void;\n',
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: [declaration],
      alreadyQuarantined: [source], // turn hold excludes the source, but source is not dirty
      exclusionReasonFor: (path) => path === source ? 'turn hold by su-test' : undefined,
    });
    expect(offenders.map((offender) => offender.file)).toEqual([declaration]);
    expect(offenders[0]).toMatchObject({
      detectorKey: 'quarantined-importer',
      excludedRoot: source,
      excludedRootReason: 'turn hold by su-test',
    });
    expect(offenders[0]?.error).toContain('paired with source');
  });

  it('does not hold a same-named handwritten declaration without the generator banner', async () => {
    const source = 'scripts/example.mjs';
    const declaration = 'scripts/example.d.mts';
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => rel === declaration ? 'export declare function main(): void;\n' : null,
      dirtyFiles: [declaration],
      alreadyQuarantined: [source],
    });
    expect(offenders).toEqual([]);
  });

  it('EI-19932544083689229: quarantines a dirty *.test.ts sibling that imports an already-quarantined source', async () => {
    const files: Record<string, string> = {
      'lib/cup-spawn-health-watchdog.test.ts':
        `import { evaluateCupSpawnHealth } from './cup-spawn-health-watchdog';\n` +
        `it('works', () => { evaluateCupSpawnHealth(); });\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/cup-spawn-health-watchdog.ts', 'lib/cup-spawn-health-watchdog.test.ts'],
      alreadyQuarantined: ['lib/cup-spawn-health-watchdog.ts'], // content-guard already excluded the NUL-byte source
    });
    expect(offenders).toEqual([
      {
        file: 'lib/cup-spawn-health-watchdog.test.ts',
        detectorKey: 'quarantined-importer',
        error: expect.stringContaining('lib/cup-spawn-health-watchdog.ts'),
        fixerRole: 'content-fixer',
        excludedRoot: 'lib/cup-spawn-health-watchdog.ts',
        excludedRootReason: 'content/deletion guard',
      },
    ]);
  });

  it('does not quarantine an importer when the excluded dependency still resolves from HEAD', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async () => `import './tracked-source';\n`,
      dirtyFiles: ['lib/tracked-source.ts', 'lib/importer.test.ts'],
      alreadyQuarantined: ['lib/tracked-source.ts'],
      isResolvableAtHead: async (path) => path === 'lib/tracked-source.ts',
    });
    expect(offenders).toEqual([]);
  });

  it('catches a CHAIN of dirty importers to a fixed point (C imports B imports quarantined A)', async () => {
    const files: Record<string, string> = {
      'lib/b.ts': `export { x } from './a';\n`,
      'lib/c.ts': `import { x } from './b';\nexport const y = x;\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/a.ts', 'lib/b.ts', 'lib/c.ts'],
      alreadyQuarantined: ['lib/a.ts'],
    });
    const flaggedFiles = offenders.map((o) => o.file).sort();
    expect(flaggedFiles).toEqual(['lib/b.ts', 'lib/c.ts']);
  });

  it('does NOT flag a dirty file that does not import anything quarantined (no false positive)', async () => {
    const files: Record<string, string> = {
      'lib/unrelated.ts': `import { z } from './other-clean-module';\nexport const w = z;\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'lib/unrelated.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('returns [] immediately when nothing is quarantined yet (the common case — no wasted reads)', async () => {
    let reads = 0;
    const offenders = await detectQuarantineImporters({
      readText: async () => {
        reads++;
        return 'irrelevant';
      },
      dirtyFiles: ['lib/a.ts', 'lib/b.ts'],
      alreadyQuarantined: [],
    });
    expect(offenders).toEqual([]);
    expect(reads).toBe(0);
  });

  it('never flags the already-quarantined file itself, or a same-named file elsewhere that does not actually import it', async () => {
    const files: Record<string, string> = {
      'other/dir/unrelated.ts': `import { x } from './a-different-module';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'other/dir/unrelated.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('a deletion in the dirty set (readText -> null) is skipped, not flagged (fail open on gone/unreadable files)', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async () => null, // every candidate reads as gone/unreadable
      dirtyFiles: ['lib/deleted-thing.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('a readText THROW is skipped (fail open — a guard bug must never block the commit)', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async () => {
        throw new Error('EACCES');
      },
      dirtyFiles: ['lib/maybe-importer.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
      log: () => {},
    });
    expect(offenders).toEqual([]);
  });

  it('ignores an external package specifier without a repository package manifest', async () => {
    const files: Record<string, string> = {
      'lib/importer.ts': `import { x } from '@papercusp/quarantined';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'lib/importer.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });

  it('holds a named consumer when the excluded tracked provider may have new exports', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async () => `import { newlyAdded } from './tracked-source';\n`,
      dirtyFiles: ['lib/tracked-source.ts', 'lib/consumer.ts'],
      alreadyQuarantined: ['lib/tracked-source.ts'],
      isResolvableAtHead: async () => true,
    });
    expect(offenders.map(row => row.file)).toEqual(['lib/consumer.ts']);
  });

  it('holds package-export alias consumers and their relative consumers to a fixed point', async () => {
    const files: Record<string, string> = {
      'packages/operator-core/package.json': JSON.stringify({ name: '@papercusp/operator-core',
        exports: { './lib/*': './lib/*.ts' } }),
      'packages/agent-mcp/src/create.ts': `import { recordExpertiseRoutingInvocation } from '@papercusp/operator-core/lib/endpoint-route/telemetry';\n`,
      'packages/agent-mcp/src/index.ts': `export { create } from './create';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async path => files[path] ?? null,
      dirtyFiles: ['packages/agent-mcp/src/create.ts', 'packages/agent-mcp/src/index.ts'],
      alreadyQuarantined: ['packages/operator-core/lib/endpoint-route/telemetry.ts'],
      isResolvableAtHead: async () => true,
    });
    expect(offenders.map(row => row.file)).toEqual([
      'packages/agent-mcp/src/create.ts', 'packages/agent-mcp/src/index.ts',
    ]);
  });

  it('uses manifest export remapping instead of guessing a package directory from its name', async () => {
    const files: Record<string, string> = {
      'libs/unusually-named/package.json': JSON.stringify({ name: '@example/public-api',
        exports: { './telemetry': { types: './types/telemetry.d.ts', default: './src/recorder.ts' } } }),
      'packages/consumer.ts': `import { record } from '@example/public-api/telemetry';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async path => files[path] ?? null,
      dirtyFiles: ['packages/consumer.ts'],
      alreadyQuarantined: ['libs/unusually-named/src/recorder.ts'],
    });
    expect(offenders.map(row => row.file)).toEqual(['packages/consumer.ts']);
  });

  it('does not hold a tracked package alias used only for side effects', async () => {
    const files: Record<string, string> = {
      'packages/provider/package.json': JSON.stringify({ name: '@example/provider', exports: { '.': './src/index.ts' } }),
      'packages/consumer.ts': `import '@example/provider';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async path => files[path] ?? null,
      dirtyFiles: ['packages/consumer.ts'],
      alreadyQuarantined: ['packages/provider/src/index.ts'],
      sideEffectTargetAtHead: async () => true,
    });
    expect(offenders).toEqual([]);
  });

  it('resolves a directory-style import against a quarantined index file', async () => {
    const files: Record<string, string> = {
      'lib/consumer.ts': `import { thing } from '../feature';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['feature/index.ts', 'lib/consumer.ts'],
      alreadyQuarantined: ['feature/index.ts'],
    });
    expect(offenders).toEqual([
      {
        file: 'lib/consumer.ts',
        detectorKey: 'quarantined-importer',
        error: expect.stringContaining('feature/index.ts'),
        fixerRole: 'content-fixer',
        excludedRoot: 'feature/index.ts',
        excludedRootReason: 'content/deletion guard',
      },
    ]);
  });

  it('does not re-scan a *.d.ts sibling (type-only — cannot break at runtime)', async () => {
    const files: Record<string, string> = {
      'lib/types.d.ts': `import type { X } from './quarantined';\n`,
    };
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/quarantined.ts', 'lib/types.d.ts'],
      alreadyQuarantined: ['lib/quarantined.ts'],
    });
    expect(offenders).toEqual([]);
  });
});

// WI-10006940: the live-lock pass treated bare side-effect imports as infectious, so a
// registration hub (agent-tools/index.ts) bridged a peer's lock on one tool file into
// every route that imports the hub for registration. Shape mirrors the measured chain:
// locked tool deps -> dirty complete.ts (binding) -> dirty index.ts (side-effect) ->
// dirty device/plans.ts (side-effect) -> dirty plans.test.ts (binding).
describe('detectQuarantineImporters — side-effect edges (WI-10006940)', () => {
  const chain: Record<string, string> = {
    'tools/complete.ts': `import { gate } from './spec-store';\nexport const complete = gate;\n`,
    'tools/index.ts': `import './calendar/delete';\nimport './complete';\n`,
    'routes/plans.ts': `import '../tools/index';\nexport const route = 1;\n`,
    'routes/plans.test.ts': `import { route } from './plans';\nit('r', () => route);\n`,
  };
  const dirty = ['tools/spec-store.ts', ...Object.keys(chain)];
  const files = (rel: string) => Promise.resolve(chain[rel] ?? null);

  it('(a) commits a dirty hub whose side-effect import target is tracked in HEAD; holds only the binding importer', async () => {
    const headChecks: string[] = [];
    const offenders = await detectQuarantineImporters({
      readText: files,
      dirtyFiles: dirty,
      alreadyQuarantined: ['tools/spec-store.ts'],
      sideEffectTargetAtHead: async (rel) => {
        headChecks.push(rel);
        return true; // complete.ts is a tracked, modified file
      },
    });
    expect(offenders.map((o) => o.file)).toEqual(['tools/complete.ts']);
    expect(headChecks).toEqual(['tools/complete.ts']);
  });

  it('(b) still holds the side-effect importer when its target is ABSENT from HEAD (a new file)', async () => {
    const offenders = await detectQuarantineImporters({
      readText: files,
      dirtyFiles: dirty,
      alreadyQuarantined: ['tools/spec-store.ts'],
      sideEffectTargetAtHead: async () => false,
    });
    expect(offenders.map((o) => o.file).sort()).toEqual(
      ['routes/plans.test.ts', 'routes/plans.ts', 'tools/complete.ts', 'tools/index.ts'].sort(),
    );
  });

  it('(c) a BINDING import of a locked tracked file is still held even when it is present in HEAD', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => (rel === 'lib/user.ts' ? `import { x } from './locked';\n` : null),
      dirtyFiles: ['lib/locked.ts', 'lib/user.ts'],
      alreadyQuarantined: ['lib/locked.ts'],
      sideEffectTargetAtHead: async () => true,
    });
    expect(offenders.map((o) => o.file)).toEqual(['lib/user.ts']);
  });

  it('a HEAD-check failure on a side-effect target fails safe (held)', async () => {
    const offenders = await detectQuarantineImporters({
      readText: async (rel) => (rel === 'lib/hub.ts' ? `import './locked';\n` : null),
      dirtyFiles: ['lib/locked.ts', 'lib/hub.ts'],
      alreadyQuarantined: ['lib/locked.ts'],
      sideEffectTargetAtHead: async () => {
        throw new Error('git unavailable');
      },
    });
    expect(offenders.map((o) => o.file)).toEqual(['lib/hub.ts']);
  });

  it('without the seam, side-effect edges keep the historical infectious behavior', async () => {
    const offenders = await detectQuarantineImporters({
      readText: files,
      dirtyFiles: dirty,
      alreadyQuarantined: ['tools/spec-store.ts'],
    });
    expect(offenders).toHaveLength(4);
  });
});

describe('extractSideEffectOnlySpecifiers', () => {
  it('keeps bare imports and drops any specifier also consumed through a binding form', () => {
    const text = [
      `import './a';`,
      `import "./b";`,
      `import { y } from './b';`,
      `// import './commented';`,
      `const z = await import('./c');`,
      `import './d'; import './e';`,
      `export * from './e';`,
    ].join('\n');
    expect([...extractSideEffectOnlySpecifiers(text)].sort()).toEqual(['./a', './d']);
  });
});

// WI-6554700010008496: two agents each spent 30+ min walking imports by hand because a
// held importer named only its direct neighbour, never the excluded file at the bottom
// of the chain, and never WHY that file was excluded.
describe('detectQuarantineImporters — every finding names its chain root and the root\'s reason', () => {
  const files: Record<string, string> = {
    'lib/root.ts': `export const v = 1;`,
    'lib/middle.ts': `import { v } from './root';\nexport const w = v;`,
    'lib/leaf.ts': `import { w } from './middle';\nexport const x = w;`,
  };
  const scan = (exclusionReasonFor?: (p: string) => string | undefined) =>
    detectQuarantineImporters({
      readText: async (rel) => files[rel] ?? null,
      dirtyFiles: ['lib/root.ts', 'lib/middle.ts', 'lib/leaf.ts'],
      alreadyQuarantined: ['lib/root.ts'],
      exclusionLabel: 'live-lock exclusion',
      ...(exclusionReasonFor ? { exclusionReasonFor } : {}),
    });

  it('a transitive importer names the ROOT, not the intermediate importer it imports directly', async () => {
    const byFile = new Map((await scan()).map((o) => [o.file, o]));
    expect(byFile.get('lib/middle.ts')).toMatchObject({ excludedRoot: 'lib/root.ts' });
    const leaf = byFile.get('lib/leaf.ts');
    expect(leaf).toMatchObject({ excludedRoot: 'lib/root.ts', excludedRootReason: 'live-lock exclusion' });
    // The direct edge is still reported, and the message now also names the root.
    expect(leaf?.error).toContain(`→ 'lib/middle.ts'`);
    expect(leaf?.error).toContain(`'lib/root.ts'`);
    expect(leaf?.error).toContain(`until 'lib/root.ts' is resolved`);
  });

  it('carries the per-root reason the caller supplies, falling back to the label for an unknown path', async () => {
    const reasonFor = (p: string) => (p === 'lib/root.ts' ? 'turn hold by su-abc (WI-1)' : undefined);
    const leaf = (await scan(reasonFor)).find((o) => o.file === 'lib/leaf.ts');
    expect(leaf).toMatchObject({ excludedRoot: 'lib/root.ts', excludedRootReason: 'turn hold by su-abc (WI-1)' });
    expect(leaf?.error).toContain('turn hold by su-abc (WI-1)');

    const blank = (await scan(() => '  ')).find((o) => o.file === 'lib/leaf.ts');
    expect(blank?.excludedRootReason).toBe('live-lock exclusion');
  });
});
