import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { extractWorklet, setupElevenLabsRuntime } from '../setup-elevenlabs-runtime.mjs';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const repository = resolve(__dirname, '../../../..');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'elevenlabs-runtime-')); roots.push(root);
  await writeFile(join(root, 'package.json'), '{}');
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir');
  return root;
}

describe('tutorial WebSocket local audio assets', () => {
  it('extracts cooked SDK templates without executing their surrounding code', () => {
    const source = 'throw new Error("must not execute"); createWorkletModuleLoader("test", `registerProcessor("test", Test);\\n`);';
    expect(extractWorklet(source, 'test')).toBe('registerProcessor("test", Test);\n');
  });

  it.each([
    'createWorkletModuleLoader("test", makeSource());',
    'createWorkletModuleLoader("test", `registerProcessor("test", ${unsafe});`);',
    'createWorkletModuleLoader("test", `wrong processor`);',
    'createWorkletModuleLoader("other", `registerProcessor("other", Other);`);',
  ])('refuses unrecognized SDK source: %s', source => {
    expect(() => extractWorklet(source, 'test')).toThrow();
  });

  it('mirrors the installed SDK and samplerate bytes, without rewriting a sibling hard link', async () => {
    const root = await fixture();
    const destination = join(root, 'public', 'elevenlabs-runtime'); await mkdir(destination, { recursive: true });
    const sibling = join(root, 'sibling.js'); await writeFile(sibling, 'old sibling bytes');
    const output = join(destination, 'rawAudioProcessor.js'); await link(sibling, output);
    const original = (await stat(sibling)).ino;
    expect((await stat(output)).ino).toBe(original);
    expect(await setupElevenLabsRuntime(root)).toEqual(['rawAudioProcessor.js', 'audioConcatProcessor.js', 'libsamplerate.worklet.js']);
    expect(await readFile(sibling, 'utf8')).toBe('old sibling bytes');
    expect((await stat(sibling)).ino).toBe(original);
    expect((await stat(output)).ino).not.toBe(original);
    for (const name of ['rawAudioProcessor', 'audioConcatProcessor']) {
      const source = await readFile(join(repository, 'node_modules/@elevenlabs/client/dist/utils', `${name}.generated.js`), 'utf8');
      expect(await readFile(join(destination, `${name}.js`), 'utf8')).toBe(extractWorklet(source, name));
    }
    expect(await readFile(join(destination, 'libsamplerate.worklet.js'))).toEqual(await readFile(join(repository, 'node_modules/@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js')));
  });

  it('fails before publishing when an installed dependency is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'elevenlabs-missing-')); roots.push(root);
    await writeFile(join(root, 'package.json'), '{}');
    await expect(setupElevenLabsRuntime(root)).rejects.toThrow();
    await expect(stat(join(root, 'public', 'elevenlabs-runtime'))).rejects.toThrow();
  });

  it('keeps every generated asset out of source dirtiness so gate pass proofs remain reusable', async () => {
    const names = await setupElevenLabsRuntime(await fixture());
    const paths = names.map(name => `apps/operator/public/elevenlabs-runtime/${name}`);
    const ignored = execFileSync('git', ['-C', repository, 'check-ignore', '--no-index', '--verbose', '--stdin'], {
      input: paths.join('\n') + '\n', encoding: 'utf8',
    }).trim().split('\n');
    // Require the repository rule, not an operator's machine-local global excludes.
    expect(ignored).toHaveLength(paths.length);
    for (const [index, file] of paths.entries()) {
      expect(ignored[index]).toMatch(/^\.gitignore:\d+:apps\/operator\/public\/elevenlabs-runtime\/\t/);
      expect(ignored[index]).toContain('\t' + file);
    }
  });

  it('runs in install and Vite prebuild so clean source builds contain the assets', async () => {
    const app = JSON.parse(await readFile(join(repository, 'apps/operator/package.json'), 'utf8'));
    const vite = JSON.parse(await readFile(join(repository, 'apps/operator-vite/package.json'), 'utf8'));
    expect(app.scripts.postinstall).toContain('node scripts/setup-elevenlabs-runtime.mjs');
    expect(vite.scripts.prebuild).toContain('node ../operator/scripts/setup-elevenlabs-runtime.mjs');
    expect(app.dependencies['@alexanderolsen/libsamplerate-js']).toBe('2.1.2');
  });
});
