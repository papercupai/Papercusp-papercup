import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '@tanstack/router-generator';
import { candidateDirectory, candidatePublicAssets, prepareCandidate, writeCandidateFiles } from '../../desktop-portal-candidate';
import { operatorRouterOptions } from '../../vite.config';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function root() {
  const path = mkdtempSync(resolve(tmpdir(), 'desktop-candidate-'));
  directories.push(path);
  return path;
}

describe('private desktop candidate publication boundary', () => {
  it('keeps router temporary files on the output filesystem despite a foreign caller or temp override', () => {
    const appRoot = fileURLToPath(new URL('../../', import.meta.url));
    vi.stubEnv('TSR_TMP_DIR', resolve(root(), 'foreign-router-temp'));
    const config = getConfig(operatorRouterOptions, appRoot);
    expect(config.generatedRouteTree).toBe(resolve(appRoot, 'src/routeTree.gen.ts'));
    expect(config.tmpDir.startsWith(appRoot)).toBe(true);
    expect(config.tmpDir).not.toBe(process.env.TSR_TMP_DIR);
  });

  it('accepts a new private output without creating it and refuses ordinary or previously written outputs', () => {
    const repo = root();
    const boundary = resolve(root(), 'private');
    const output = resolve(boundary, 'one');
    expect(candidateDirectory(repo, output, boundary)).toBe(output);
    expect(existsSync(output)).toBe(false);
    expect(() => candidateDirectory(repo, resolve(repo, 'apps/operator-vite/dist'), boundary)).toThrow('desktop-candidates');
    expect(() => candidateDirectory(repo, resolve(repo, '.papercusp/private/one'), resolve(repo, '.papercusp/private'))).toThrow('outside the repository');
    expect(() => candidateDirectory(repo, '.papercusp/private-desktop-candidates/one')).toThrow('absolute');
    mkdirSync(output, { recursive: true });
    expect(() => candidateDirectory(repo, output, boundary)).toThrow('already exists');
  });

  it('refuses symlinked private parents before any build or write', () => {
    const repo = root();
    const outside = root();
    const boundary = resolve(root(), 'private');
    symlinkSync(outside, boundary);
    expect(() => candidateDirectory(repo, resolve(boundary, 'one'), boundary)).toThrow('symlinks');
    expect(existsSync(resolve(outside, 'one'))).toBe(false);
  });

  it('retains static bytes, creates missing private parents, and refuses collisions before writing', () => {
    const repo = root();
    const boundary = resolve(root(), 'missing/private');
    const output = resolve(boundary, 'one');
    const publicDir = resolve(root(), 'public');
    mkdirSync(resolve(publicDir, 'nested'), { recursive: true });
    writeFileSync(resolve(publicDir, 'wordmark.svg'), '<svg/>');
    writeFileSync(resolve(publicDir, 'nested/icon.png'), Buffer.from([0, 128, 255]));
    const files = candidatePublicAssets(publicDir).map(file => ({ ...file, path: resolve(output, 'spa', file.path) }));
    expect(() => writeCandidateFiles(repo, output, [files[0], files[0]], boundary)).toThrow('collided');
    expect(existsSync(output)).toBe(false);
    writeCandidateFiles(repo, output, files, boundary);
    expect(readFileSync(resolve(output, 'spa/wordmark.svg'), 'utf8')).toBe('<svg/>');
    expect(readFileSync(resolve(output, 'spa/nested/icon.png'))).toEqual(Buffer.from([0, 128, 255]));
    expect(() => writeCandidateFiles(repo, output, files, boundary)).toThrow('already exists');
    expect(candidatePublicAssets(false)).toEqual([]);
  });

  it('refuses public asset symlinks before materializing output', () => {
    const publicDir = root();
    symlinkSync(root(), resolve(publicDir, 'outside'));
    expect(() => candidatePublicAssets(publicDir)).toThrow('symlinks');
  });

  it('refuses an unspecified output before loading or compiling the maintained portal', async () => {
    await expect(prepareCandidate([])).rejects.toThrow('--output');
  });
});
