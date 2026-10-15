import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as pagefind from 'pagefind';
import { expect, it } from 'vitest';

it('Pagefind writeFiles finishes every asset before the service closes', async () => {
  const outputPath = await mkdtemp(join(tmpdir(), 'papercusp-pagefind-output-'));
  try {
    const created = await pagefind.createIndex();
    expect(created.errors).toEqual([]);
    if (!created.index) throw new Error('Pagefind did not create an index');
    const added = await created.index.addHTMLFile({
      url: '/docs/accounts-and-billing',
      content: '<html lang="en"><body><main data-pagefind-body><h1>Accounts and billing</h1><p>Record the time and displayed Billing status.</p></main></body></html>',
    });
    expect(added.errors).toEqual([]);
    const expected = await created.index.getFiles();
    expect(expected.errors).toEqual([]);
    if (!expected.files) throw new Error('Pagefind returned no assets');
    expect(expected.files.map((file) => file.path)).toContain('wasm.unknown.pagefind');
    for (const file of expected.files) {
      if (file.path.endsWith('.pagefind')) {
        expect(() => gunzipSync(file.content), `invalid backend asset: ${file.path}`).not.toThrow();
      }
    }
    const written = await created.index.writeFiles({ outputPath });
    expect(written.errors).toEqual([]);
    await pagefind.close();
    for (const file of expected.files) {
      const actual = await readFile(join(outputPath, file.path));
      expect(actual.length, `unfinished write: ${file.path}`).toBe(file.content.length);
      const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
      expect(digest(actual), `changed asset: ${file.path}`).toBe(digest(file.content));
    }
  } finally {
    await pagefind.close();
    await rm(outputPath, { recursive: true, force: true });
  }
}, 15_000);
