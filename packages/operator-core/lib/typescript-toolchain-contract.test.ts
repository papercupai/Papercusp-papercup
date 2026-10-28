import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { listTrackedFiles } from '../../../scripts/lib/tracked-files.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const API_ALIAS = 'npm:@typescript/typescript6@6.0.2';
const NATIVE_ALIAS = 'npm:typescript@7.0.2';
const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
const MANIFEST_ROOTS = ['apps/', 'packages/', 'libs/', 'tools/'] as const;
const SKIP_SEGMENTS = new Set([
  '.git',
  '.papercusp',
  '_retired',
  'coverage',
  'dist',
  'node_modules',
]);

/**
 * Tracked manifests that declare `typescript` but are NOT Papercusp toolchain
 * consumers. Each prefix models a project OUTSIDE Papercusp and deliberately keeps
 * that project's own toolchain, so pinning it to the native CLI would falsify the
 * fixture. Every prefix must still match a TypeScript-declaring manifest (unless it
 * sits in a submodule this checkout did not scan), so a stale entry fails instead of
 * silently widening the exemption.
 */
const OUT_OF_CONTRACT: Record<string, string> = {
  'apps/slack-asana-bug-drill/':
    'bug-drill fixture submodule (@bug-drill/fixture) modelling an external customer repo on its own TypeScript 5.9 toolchain',
  'packages/operator-core/test/fixtures/':
    'test fixtures modelling external plugins (outlook-graph-provider declares typescript "*")',
};

type Manifest = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type TypeScriptManifests = {
  consumers: Array<{ path: string; manifest: Manifest }>;
  exempted: string[];
  unscannedSubmodules: string[];
};

/**
 * Enumerates TRACKED manifests (superproject + every checked-out submodule), never
 * the filesystem: the gate judges an isolated checkout of committed content, so a
 * filesystem walk on the shared tree also counts build output (e.g. a Next.js
 * `.next/standalone/package.json`) and untracked work that no candidate contains.
 */
function manifestsDeclaringTypeScript(): TypeScriptManifests {
  const tracked = listTrackedFiles(REPO_ROOT);
  const paths = (tracked.files as string[]).filter(
    (path) =>
      path === 'package.json' ||
      (path.endsWith('/package.json') &&
        MANIFEST_ROOTS.some((root) => path.startsWith(root)) &&
        !path.split('/').some((segment) => SKIP_SEGMENTS.has(segment))),
  );

  const consumers: TypeScriptManifests['consumers'] = [];
  const exempted: string[] = [];
  for (const path of paths) {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, path), 'utf8')) as Manifest;
    const declaresTypeScript = DEPENDENCY_SECTIONS.some(
      (section) => manifest[section]?.typescript !== undefined,
    );
    if (!declaresTypeScript) continue;
    if (Object.keys(OUT_OF_CONTRACT).some((prefix) => path.startsWith(prefix))) {
      exempted.push(path);
    } else {
      consumers.push({ path, manifest });
    }
  }
  return { consumers, exempted, unscannedSubmodules: tracked.unscanned as string[] };
}

describe('Papercusp TypeScript toolchain contract', () => {
  it('pins every active TypeScript consumer to the native CLI and official API alias', () => {
    const { consumers, exempted, unscannedSubmodules } = manifestsDeclaringTypeScript();
    const relativePaths = consumers.map(({ path }) => path).sort();

    for (const prefix of Object.keys(OUT_OF_CONTRACT)) {
      if (unscannedSubmodules.some((submodule) => prefix.startsWith(`${submodule}/`))) continue;
      expect(
        exempted.some((path) => path.startsWith(prefix)),
        `stale OUT_OF_CONTRACT entry ${prefix}: no TypeScript-declaring manifest matches it`,
      ).toBe(true);
    }

    expect(relativePaths).toEqual([
      'apps/operator-docs/package.json',
      'apps/operator-public/package.json',
      'apps/operator-vite/package.json',
      'apps/operator/package.json',
      'apps/papercusp-docs/package.json',
      'apps/papercusp-publish/package.json',
      'apps/the-swarm-site/package.json',
      'libs/generic/artifact-registry/package.json',
      'libs/generic/dock-workbench/package.json',
      'libs/generic/resumable-download/package.json',
      'libs/generic/sse/package.json',
      'libs/generic/tooldef/package.json',
      'libs/host-platform/package.json',
      'package.json',
      'tools/perf-test/wdio/package.json',
    ]);

    for (const { path, manifest } of consumers) {
      for (const section of DEPENDENCY_SECTIONS) {
        if (manifest[section]?.typescript === undefined) continue;
        expect(manifest[section]?.typescript, path).toBe(API_ALIAS);
      }
      expect(
        manifest.devDependencies?.['@typescript/native'] ??
          manifest.dependencies?.['@typescript/native'],
        path,
      ).toBe(NATIVE_ALIAS);
    }
  });

  it('resolves tsc to 7.0.2 while preserving the TypeScript 6 compiler API', () => {
    const tsc = join(REPO_ROOT, 'node_modules/.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
    expect(
      execFileSync(tsc, ['--version'], {
        encoding: 'utf8',
        timeout: 10_000,
        killSignal: 'SIGKILL',
      }).trim(),
    ).toBe(
      'Version 7.0.2',
    );

    const requireFromRoot = createRequire(join(REPO_ROOT, 'package.json'));
    const apiManifest = requireFromRoot('typescript/package.json') as {
      name: string;
      version: string;
    };
    const ts = requireFromRoot('typescript') as {
      version: string;
      createSourceFile?: unknown;
    };
    expect(apiManifest).toMatchObject({
      name: '@typescript/typescript6',
      version: '6.0.2',
    });
    expect(ts.version).toMatch(/^6\.0\./);
    expect(ts.createSourceFile).toBeTypeOf('function');
  });
});
