import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BG_INPUTS, makeBgCompilerCandidate } from './source-preview.fixture';
import { createBgVerifierCompilerCustody } from '../../../scripts/source-preview.mjs';

// Exercise the maintained compiler against private fixture generations. These
// source controls do not authorize preparation or activation of a real BG host.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function candidate() {
  const root = mkdtempSync(join(tmpdir(), 'bg-dependency-boundary-'));
  roots.push(root);
  const fixture = await makeBgCompilerCandidate(root);
  const custody = createBgVerifierCompilerCustody(fixture);
  const compile = () => build({
    absWorkingDir: fixture.prepared.root, entryPoints: [BG_INPUTS[0]!],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
    // A tempting ambient fallback is deliberately available to the resolver.
    // Its bytes must never be accepted as part of the selected generation.
    nodePaths: [join(fixture.c.fixture.repo, 'node_modules')], plugins: [custody.plugin],
  });
  const ambient = join(fixture.c.fixture.repo, 'node_modules/fixture-dependency');
  mkdirSync(ambient, { recursive: true });
  writeFileSync(join(ambient, 'package.json'), '{"name":"fixture-dependency","main":"index.js"}');
  writeFileSync(join(ambient, 'index.js'), 'export default 99;\n');
  return { ...fixture, custody, compile, ambient, root };
}

async function ordinary(f: Awaited<ReturnType<typeof candidate>>) {
  const compiled = await f.compile();
  const loaded = await import('data:text/javascript;base64,'
    + Buffer.from(compiled.outputFiles[0]!.contents).toString('base64'));
  expect({ y: loaded.y, dep: loaded.dep }).toEqual({ y: 2, dep: 41 });
  const consumed = f.custody.verifyBeforePublication();
  expect(consumed).toContainEqual(expect.objectContaining({
    path: 'node_modules/fixture-dependency/index.js',
    realpath: join(f.prepared.root, 'node_modules/fixture-dependency/index.js'),
  }));
  for (const input of consumed) expect(realpathSync(join(f.prepared.root, input.path))).toBe(input.realpath);
}

describe('BG private dependency compiler boundaries', () => {
  it('canonical-dependency-mutation-isolated compiles accepted private bytes while the canonical dependency changes', async () => {
    const f = await candidate();
    const receipt = readFileSync(join(f.prepared.root, '.verifier-source.json'));
    await ordinary(f);
    writeFileSync(join(f.ambient, 'index.js'), 'export default 77;\n');
    await ordinary(f);
    expect(readFileSync(join(f.ambient, 'index.js'), 'utf8')).toBe('export default 77;\n');
    expect(readFileSync(join(f.prepared.root, '.verifier-source.json'))).toEqual(receipt);
  });

  it('dependency-realpath-closed-positive records only physical inputs from the accepted generation', async () => {
    await ordinary(await candidate());
  });

  it('deleted-private-dependency-no-fallback refuses compilation despite an available ambient dependency', async () => {
    const f = await candidate();
    await ordinary(f);
    rmSync(join(f.prepared.root, 'node_modules/fixture-dependency'), { recursive: true });
    await expect(f.compile()).rejects.toThrow(/escaped selected generation|Could not resolve/);
    expect(() => f.custody.verifyBeforePublication()).toThrow();
    expect(readFileSync(join(f.ambient, 'index.js'), 'utf8')).toBe('export default 99;\n');
  });

  it('dependency-realpath-escape refuses a private dependency redirected to the canonical tree', async () => {
    const f = await candidate();
    await ordinary(f);
    const dependency = join(f.prepared.root, 'node_modules/fixture-dependency');
    rmSync(dependency, { recursive: true });
    symlinkSync(f.ambient, dependency, 'dir');
    await expect(f.compile()).rejects.toThrow('escaped selected generation');
    expect(() => f.custody.verifyBeforePublication()).toThrow();
    expect(realpathSync(dependency)).toBe(f.ambient);
  });

  it('workspace-link-escape refuses a relative workspace link outside the selected generation', async () => {
    const f = await candidate();
    await ordinary(f);
    const workspace = join(f.root, 'workspace-dependency');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'package.json'), '{"name":"fixture-dependency","main":"index.js"}');
    writeFileSync(join(workspace, 'index.js'), 'export default 88;\n');
    const dependency = join(f.prepared.root, 'node_modules/fixture-dependency');
    rmSync(dependency, { recursive: true });
    symlinkSync('../../workspace-dependency', dependency, 'dir');
    await expect(f.compile()).rejects.toThrow('escaped selected generation');
    expect(() => f.custody.verifyBeforePublication()).toThrow();
    expect(readFileSync(join(workspace, 'index.js'), 'utf8')).toBe('export default 88;\n');
  });
});
