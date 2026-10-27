import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../vendor/proximus/', import.meta.url));
const revision = 'a989f7b35c95c0fd30603290da3c923b7898cba8';
const sourceTree = 'c17d01f8b105710b78f24547edc6ada120bcfec3';
const objectHash = (kind: 'blob' | 'tree', bytes: Buffer) => createHash('sha1')
  .update(`${kind} ${bytes.length}\0`).update(bytes).digest();

describe('official Proximus research reference source (D-059)', () => {
  it('preserves the complete upstream Git tree, including the lockfile and license', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'UPSTREAM.json'), 'utf8')) as {
      repository: string; revision: string; tree: string;
      files: Array<{ path: string; mode: string; gitBlobSha1: string; sha256: string }>;
    };
    expect(manifest.repository).toBe('https://github.com/Proximal-Labs/proximus');
    expect(manifest.revision).toBe(revision);
    expect(manifest.tree).toBe(sourceTree);
    const observed: string[] = [];
    function tree(relative: string): Buffer {
      const entries = readdirSync(join(root, relative), { withFileTypes: true })
        .filter(entry => relative !== '' || entry.name !== 'UPSTREAM.json')
        .sort((a, b) => Buffer.compare(Buffer.from(a.name + (a.isDirectory() ? '/' : '')),
          Buffer.from(b.name + (b.isDirectory() ? '/' : ''))));
      return objectHash('tree', Buffer.concat(entries.map(entry => {
        const path = relative ? `${relative}/${entry.name}` : entry.name;
        const stat = lstatSync(join(root, path));
        expect(stat.isSymbolicLink(), path).toBe(false);
        if (entry.isDirectory()) return Buffer.concat([Buffer.from(`40000 ${entry.name}\0`), tree(path)]);
        expect(stat.isFile(), path).toBe(true);
        const bytes = readFileSync(join(root, path));
        const mode = stat.mode & 0o111 ? '100755' : '100644';
        const hash = objectHash('blob', bytes);
        expect(manifest.files.find(file => file.path === path), path).toEqual({
          path, mode, gitBlobSha1: hash.toString('hex'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
        });
        observed.push(path);
        return Buffer.concat([Buffer.from(`${mode} ${entry.name}\0`), hash]);
      })));
    }
    expect(tree('').toString('hex')).toBe(sourceTree);
    expect(observed.sort()).toEqual(manifest.files.map(file => file.path).sort());
    for (const required of ['LICENSE', 'NOTICE', 'uv.lock', 'pyproject.toml',
      'src/harbor_proximus/proximus.py', 'tests/test_proximus_loop.py']) {
      expect(observed).toContain(required);
    }
  });

  it('retains the official package and Harbor version contract', () => {
    const project = readFileSync(join(root, 'pyproject.toml'), 'utf8');
    expect(project).toContain('name = "harbor-proximus"');
    expect(project).toContain('version = "0.1.0a1"');
    expect(project).toContain('requires-python = ">=3.12"');
    expect(project).toContain('"harbor==0.23.0"');
    expect(project).toContain('license-files = ["LICENSE", "NOTICE"]');
  });
});
