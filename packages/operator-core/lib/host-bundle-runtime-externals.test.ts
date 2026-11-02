import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const hostEntry = resolve(__dirname, '../../../apps/operator/dist-host/hono-host.mjs');
const packages = [
  ['undici', 'Agent'],
  ['@dbos-inc/dbos-sdk', 'DBOS'],
  ['mingo', 'aggregate'],
  ['acorn', 'parse'],
  ['fast-check', 'assert'],
  ['@mcp-ui/server', 'createUIResource'],
  ['viem', 'parseEther'],
  ['iconv-lite', 'encode'],
  ['@smithy/core', 'getSmithyContext'],
  ['@aws-sdk/client-ec2', 'EC2Client'],
  ['@aws-sdk/client-ssm', 'SSMClient'],
] as const;

describe('host runtime packages use the plain Node loader', () => {
  it('packages Playwright without resolving its optional BiDi branch or losing package assets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'host-playwright-runtime-'));
    try {
      const packageRoot = dirname(createRequire(hostEntry).resolve('playwright-core'));
      const stagedPackage = join(root, 'node_modules', 'playwright-core');
      mkdirSync(dirname(stagedPackage), { recursive: true });
      // A physical package copy, with no shared node_modules link and no BiDi
      // dependency, reproduces the scoped dependency population of frozen cuts.
      cpSync(packageRoot, stagedPackage, { recursive: true, dereference: true });
      const entry = join(root, 'host.mjs');
      const stagedRequire = createRequire(entry);
      expect(() => stagedRequire.resolve('chromium-bidi/lib/cjs/bidiMapper/BidiMapper')).toThrow();

      const common = resolve(__dirname, '../../../apps/operator/bin/bundle-host-common.sh');
      const producer = readFileSync(resolve(__dirname, '../../../papercusp-desktop/bin/build-desktop-sidecar.sh'), 'utf8');
      const preflight = producer.split('# >>> Playwright runtime preflight (EI-25537398622311917)\n')[1]!
        .split('# <<< Playwright runtime preflight')[0]!;
      expect(producer.indexOf('# >>> Playwright runtime preflight')).toBeLessThan(producer.indexOf('npm --workspace @papercusp/operator-vite run build'));
      const preflightWeb = join(root, 'preflight-web');
      mkdirSync(join(preflightWeb, 'bin'), { recursive: true });
      const stagedCommon = join(preflightWeb, 'bin', 'bundle-host-common.sh');
      const commonSource = readFileSync(common, 'utf8');
      writeFileSync(stagedCommon, commonSource);
      const runPreflight = () => execFileSync('bash', ['-c',
        `set -euo pipefail\nREPO_ROOT="$1"\nWEB_DIR="$2"\n${preflight}\nprintf 'COPY_PACKAGE=%s\\n' "\${NATIVE_PKGS[@]}"`, 'playwright-preflight-test', root, preflightWeb],
      { encoding: 'utf8', timeout: 15_000 });
      expect(runPreflight()).toContain('PLAYWRIGHT_RUNTIME_PREFLIGHT_OK');
      writeFileSync(stagedCommon, commonSource.replace('\n  playwright-core\n', '\n'));
      const legacyPreflight = runPreflight();
      expect(legacyPreflight).toContain('PLAYWRIGHT_RUNTIME_PREFLIGHT_OK');
      expect(legacyPreflight.match(/^COPY_PACKAGE=playwright-core$/gm)).toHaveLength(1);
      expect(legacyPreflight).toContain('COPY_PACKAGE=sharp');
      expect(readFileSync(stagedCommon, 'utf8')).not.toContain('\n  playwright-core\n');
      renameSync(stagedPackage, `${stagedPackage}.unavailable`);
      expect(runPreflight).toThrow(/Cannot find module 'playwright-core'/);
      renameSync(`${stagedPackage}.unavailable`, stagedPackage);
      writeFileSync(stagedCommon, commonSource);

      const external: string[] = JSON.parse(execFileSync('bash', ['-c',
        'source "$1"; node -e "console.log(JSON.stringify(process.argv.slice(1)))" -- "${HOST_COMMON_EXTERNALS[@]}" "${NATIVE_PKGS[@]/#/--external:}"',
        'playwright-boundary-test', common], { encoding: 'utf8' })).map((name: string) => name.replace(/^--external:/, ''));
      const options = {
        stdin: {
          contents: "import { chromium, devices } from 'playwright-core'; console.log(JSON.stringify({ name: chromium.name(), executable: chromium.executablePath(), userAgent: devices['Desktop Chrome'].userAgent }));",
          resolveDir: root,
        },
        bundle: true, platform: 'node' as const, format: 'esm' as const,
        write: false, metafile: true, logLevel: 'silent' as const,
      };
      const result = await build({ ...options, external });
      expect(Object.keys(result.metafile!.inputs).filter(file => file.includes('playwright-core/'))).toEqual([]);
      writeFileSync(entry, result.outputFiles![0]!.contents);
      const runtime = JSON.parse(execFileSync(process.execPath, [entry], { encoding: 'utf8', timeout: 15_000 }));
      expect(runtime.name).toBe('chromium');
      expect(runtime.executable).toMatch(/chrome(?:\.exe)?$/);
      expect(runtime.userAgent).toContain('Chrome/');

      // This counterexample must fail even on a development host that happens
      // to have BiDi through Puppeteer: the package tree above is independent.
      await expect(build({ ...options, external: external.filter(name => name !== 'playwright-core') })).rejects.toThrow(/chromium-bidi/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prepares external dependencies for a custom output, preserving existing trees and refusing broken links', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-external-output-'));
    try {
      const repo = join(root, 'checkout');
      const output = join(root, 'private-output');
      const packageDir = join(repo, 'node_modules', 'external-fixture');
      mkdirSync(packageDir, { recursive: true });
      mkdirSync(output);
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
      writeFileSync(join(packageDir, 'index.js'), 'export const value = "checkout";');
      const entry = join(output, 'host.mjs');
      writeFileSync(entry, 'import { value } from "external-fixture"; console.log(value);');
      expect(() => execFileSync(process.execPath, [entry], { stdio: 'pipe' })).toThrow();

      const recipe = readFileSync(resolve(__dirname, '../../../apps/operator/bin/bundle-host.sh'), 'utf8');
      const prepare = recipe.split('# >>> custom-output runtime dependencies (EI-25510203057543967)\n')[1]!
        .split('# <<< custom-output runtime dependencies')[0]!;
      const run = () => execFileSync('bash', ['-c', `set -euo pipefail\n${prepare}\nprepare_host_runtime_dependencies "$1" "$2"`, 'test', repo, output], { stdio: 'pipe' });
      run();
      run();
      expect(readlinkSync(join(output, 'node_modules'))).toBe(join(repo, 'node_modules'));
      expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('checkout');

      rmSync(join(output, 'node_modules'));
      const supplied = join(output, 'node_modules', 'external-fixture');
      mkdirSync(supplied, { recursive: true });
      writeFileSync(join(supplied, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }));
      writeFileSync(join(supplied, 'index.js'), 'export const value = "caller";');
      run();
      expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('caller');

      rmSync(join(output, 'node_modules'), { recursive: true });
      symlinkSync(join(root, 'missing'), join(output, 'node_modules'));
      expect(run).toThrow();
      expect(readlinkSync(join(output, 'node_modules'))).toBe(join(root, 'missing'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('never nests a dependency link when another caller prepares the destination at the create boundary', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-dependency-link-race-'));
    try {
      const repo = join(root, 'checkout');
      const output = join(root, 'private-output');
      const donor = join(repo, 'node_modules');
      const destination = join(output, 'node_modules');
      mkdirSync(donor, { recursive: true });
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const realLn = execFileSync('sh', ['-c', 'command -v ln'], { encoding: 'utf8' }).trim();
      // Force the same shape as the P006 double-link incident, exactly between
      // the producer's absent-path check and its create syscall. Cover both the
      // old shell create and the atomic Node create so the counterexample fails
      // with the old producer rather than passing without exercising the race.
      for (const [name, executable] of [['ln', realLn], ['node', process.execPath]]) {
        const shim = join(bin, name);
        writeFileSync(shim, '#!/bin/sh\n"$PAPERCUSP_LINK_REAL_LN" -s "$PAPERCUSP_LINK_RACE_SOURCE" "$PAPERCUSP_LINK_RACE_DEST" || exit 1\nexec "$PAPERCUSP_LINK_REAL_COMMAND" "$@"\n');
        chmodSync(shim, 0o755);
        const recipe = readFileSync(resolve(__dirname, '../../../apps/operator/bin/bundle-host.sh'), 'utf8');
        const prepare = recipe.split('# >>> custom-output runtime dependencies (EI-25510203057543967)\n')[1]!
          .split('# <<< custom-output runtime dependencies')[0]!;
        // Only the executable the producer uses is replaced for this run.
        const selectedBin = join(root, `selected-${name}`);
        mkdirSync(selectedBin);
        symlinkSync(shim, join(selectedBin, name));
        rmSync(destination, { force: true });
        execFileSync('bash', ['-c', `set -euo pipefail\n${prepare}\nprepare_host_runtime_dependencies "$1" "$2"`, 'test', repo, output], {
          stdio: 'pipe', timeout: 15_000,
          env: { ...process.env, PATH: `${selectedBin}:${process.env.PATH}`,
            PAPERCUSP_LINK_REAL_LN: realLn, PAPERCUSP_LINK_REAL_COMMAND: executable,
            PAPERCUSP_LINK_RACE_SOURCE: donor, PAPERCUSP_LINK_RACE_DEST: destination },
        });
        expect(readlinkSync(destination)).toBe(donor);
        expect(existsSync(join(donor, 'node_modules'))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the generated AWS SDK source outside the maintained host bundle boundary', async () => {
    const recipe = readFileSync(resolve(__dirname, '../../../apps/operator/bin/bundle-host.sh'), 'utf8');
    const runtimeBoundary = recipe.match(/^HOST_EXTERNALS\+=\(([\s\S]*?)^\)/m)?.[1];
    expect(runtimeBoundary).toBeDefined();
    const external = [...runtimeBoundary!.matchAll(/--external:([^\s#]+)/g)].map(match => match[1]!);
    const options = {
      stdin: {
        contents: "import { EC2Client } from '@aws-sdk/client-ec2'; import { SSMClient } from '@aws-sdk/client-ssm'; console.log(EC2Client.name, SSMClient.name);",
        // The production builder runs from apps/operator. dist-host is a
        // generated output directory and is absent in a clean test checkout.
        resolveDir: resolve(dirname(hostEntry), '..'),
      },
      bundle: true, platform: 'node' as const, format: 'cjs' as const, write: false, metafile: true,
    };
    const result = await build({ ...options, external });
    // Removing either SDK's real recipe boundary pulls megabytes of generated
    // package source into this otherwise tiny graph; loadability is checked below.
    expect(Object.keys(result.metafile!.inputs).filter(file => /node_modules\/(?:@aws-sdk|@smithy)\//.test(file))).toEqual([]);
    expect(result.outputFiles![0]!.contents.byteLength).toBeLessThan(16_384);
    const inlined = await build({ ...options, external: external.filter(name => !name.startsWith('@aws-sdk/')) });
    expect(Object.keys(inlined.metafile!.inputs).some(file => /node_modules\/@aws-sdk\//.test(file))).toBe(true);
    expect(inlined.outputFiles![0]!.contents.byteLength - result.outputFiles![0]!.contents.byteLength).toBeGreaterThan(1_000_000);
  });

  it.each(packages)('%s resolves compiled JavaScript and supplies %s beside the host', (name, symbol) => {
    // Use a fresh plain Node process: Vitest's TypeScript loader would hide a
    // source-only dependency that the bundled production entry cannot load.
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const [entry, name, symbol] = process.argv.slice(1);
      const file = createRequire(entry).resolve(name);
      const value = await import(pathToFileURL(file).href);
      console.log(JSON.stringify({ file, type: typeof (value[symbol] ?? value.default?.[symbol]) }));
    `, hostEntry, name, symbol], { encoding: 'utf8', timeout: 15_000 });
    const result = JSON.parse(output) as { file: string; type: string };
    expect(result.file).toMatch(/\.(?:c|m)?js$/);
    expect(result.type).toBe('function');
  });
});
