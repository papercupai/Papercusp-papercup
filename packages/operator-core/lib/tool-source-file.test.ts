/**
 * tool-source-file (P-002 / EI-25176539351759672): the defining file of a tool, in any
 * runtime — including the esbuild bundle the bg-host runs, where tooldef's stack-only
 * lookup is null for every tool and the deployment-staleness screen therefore stamped
 * `deployment-freshness-unknown` on every promoted tool-failure it triaged.
 *
 * The first block is the regression guard that matters: a REAL esbuild bundle run under
 * plain node. Every earlier staleness test injected a `sourceFileFor` stub, which is why
 * the bundled failure went unseen in production while all of them stayed green.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { bundlerWorkDir, resetToolSourceFileCache, resolveBundledDefinitionSite, resolveToolSourceFile } from './tool-source-file';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

describe('a tool defined inside a real esbuild bundle', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'tool-source-file-')));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('resolves to its own module, where the stack-only lookup answers null', async () => {
    writeFileSync(
      path.join(dir, 'fixture-tool.ts'),
      [
        "import { z } from 'zod';",
        "import { defineTool } from '@papercusp/tooldef';",
        'defineTool({',
        "  name: 'bundlee2e:sourced',",
        '  requirePrincipal: false,',
        "  capability: 'harness:read',",
        "  description: 'fixture',",
        '  args: z.object({}),',
        '  handler: async () => ({ ok: true }),',
        '} as never);',
      ].join('\n'),
    );
    writeFileSync(
      path.join(dir, 'entry.ts'),
      [
        "import './fixture-tool';",
        "import { projectedToolSourceFile } from '@papercusp/tooldef';",
        `import { resolveToolSourceFile } from ${JSON.stringify(path.join(HERE, 'tool-source-file.ts'))};`,
        "const direct = projectedToolSourceFile('bundlee2e:sourced');",
        "const resolved = await resolveToolSourceFile('bundlee2e:sourced');",
        'console.log(JSON.stringify({ direct, resolved }));',
      ].join('\n'),
    );
    const outfile = path.join(dir, 'dist', 'out.mjs');
    mkdirSync(path.dirname(outfile), { recursive: true });
    // The production host bundle's shape: ESM, platform node, not minified (which is
    // what keeps esbuild's `// <path>` module markers in the output).
    await build({
      entryPoints: [path.join(dir, 'entry.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      outfile,
      absWorkingDir: dir,
      nodePaths: [path.join(REPO_ROOT, 'node_modules')],
      logLevel: 'silent',
    });

    const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8', timeout: 60_000 });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}') as { direct: unknown; resolved: unknown };
    // The failure this closes: inside a bundle every frame is the bundle file.
    expect(out.direct).toBeNull();
    // The fix: the frames' lines resolve through the module markers to the fixture.
    expect(out.resolved).toBe(path.join(dir, 'fixture-tool.ts'));
  }, 120_000);
});

describe('resolveToolSourceFile guards', () => {
  const BUNDLE_FILE = '/repo/apps/operator/dist-host/hono-host.mjs';
  const SELF = '../../libs/generic/tooldef/src/define-tool.ts';
  const TOOL = '../../packages/operator-core/lib/agent-tools/coord/send.ts';
  const text = ['// ' + SELF, 'function capture() {}', '// ' + TOOL, 'defineTool({});'].join('\n');
  const site = { file: BUNDLE_FILE, lines: [2, 4] };
  const exists = (p: string) => p === '/repo/libs/generic/tooldef/src/define-tool.ts';

  beforeEach(() => resetToolSourceFileCache());

  const deps = (over: { mtimeMs?: number; startedAt?: number } = {}) => ({
    bundleMtime: async () => over.mtimeMs ?? 1_000,
    readBundle: async () => ({ text, mtimeMs: over.mtimeMs ?? 1_000 }),
    processStartedAtMs: () => over.startedAt ?? 2_000,
    exists,
  });

  it('calibrates the working directory against tooldef’s own marker and resolves the tool module', async () => {
    expect(bundlerWorkDir(BUNDLE_FILE, SELF, exists)).toBe('/repo/apps/operator');
    expect(await resolveBundledDefinitionSite(site, deps())).toBe(
      '/repo/packages/operator-core/lib/agent-tools/coord/send.ts',
    );
  });

  it('is unknown when the bundle was rewritten after this process started', async () => {
    expect(await resolveBundledDefinitionSite(site, deps({ mtimeMs: 3_000, startedAt: 2_000 }))).toBeNull();
  });

  it('is unknown when no ancestor holds the source tree (a bundle shipped without it)', async () => {
    expect(await resolveBundledDefinitionSite(site, { ...deps(), exists: () => false })).toBeNull();
  });

  it('prefers the stack-captured path and never reads a bundle for it', async () => {
    let read = 0;
    const resolved = await resolveToolSourceFile('coord:send', {
      sourceFileFor: () => '/abs/send.ts',
      bundledSiteFor: () => site,
      ...deps(),
      readBundle: async () => {
        read += 1;
        return { text, mtimeMs: 1_000 };
      },
    });
    expect(resolved).toBe('/abs/send.ts');
    expect(read).toBe(0);
  });

  it('is null for a tool with neither a path nor a bundled site', async () => {
    expect(await resolveToolSourceFile('nope:nope', { sourceFileFor: () => null, bundledSiteFor: () => null })).toBeNull();
  });
});
