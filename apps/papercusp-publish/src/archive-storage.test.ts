import { describe, expect, it } from 'vitest';
import { gcsTestProvider } from '../../../libs/generic/artifact-registry/src/gcs-test-provider.ts';
import { sha256Hex } from '@papercusp/artifact-registry';
import { archivePath, writeFile, writeManifest, deletePrefix } from './r2-archive.ts';
import type { Env } from './env.ts';

describe('publish archive through private GCS', () => {
  it('restores admitted file bytes and manifest metadata under the exact tenant/deployment identity', async () => {
    const p = gcsTestProvider(); const env = { ARCHIVE: p.store, ARCHIVE_PREFIX: 'publish/' } as Env;
    const bytes = new TextEncoder().encode('admitted published bytes'); const hash = await sha256Hex(bytes);
    const manifest = JSON.stringify({ files: [{ sha256: hash, sizeBytes: bytes.length }] });
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes); c.close(); } });
    await writeFile(env, 'tenant-a', 'deployment-a', hash, body);
    await writeManifest(env, 'tenant-a', 'deployment-a', manifest);
    const prefix = archivePath(env, 'tenant-a', 'deployment-a');
    const restored = await p.store.get(`${prefix}files/${hash}.bin`);
    const restoredBytes = new Uint8Array(await restored!.arrayBuffer());
    expect(restoredBytes).toEqual(bytes); expect(await sha256Hex(restoredBytes)).toBe(hash);
    const storedManifest = await p.store.get(`${prefix}manifest.json`);
    expect(await storedManifest!.text()).toBe(manifest); expect(storedManifest!.httpMetadata.contentType).toBe('application/json');
    expect(await p.store.get(`${archivePath(env, 'tenant-b', 'deployment-a')}files/${hash}.bin`)).toBeNull();
  });

  it('deletes one archive without crossing tenant/deployment boundaries', async () => {
    const p = gcsTestProvider(); const env = { ARCHIVE: p.store, ARCHIVE_PREFIX: 'publish/' } as Env;
    await writeManifest(env, 'a', 'one', 'one'); await writeManifest(env, 'a', 'two', 'two'); await writeManifest(env, 'b', 'one', 'three');
    await deletePrefix(env, 'a', 'one');
    expect([...p.objects.keys()].sort()).toEqual(['publish/a/two/manifest.json', 'publish/b/one/manifest.json']);
  });

  it('propagates Google authorization failure instead of reporting an empty archive', async () => {
    const p = gcsTestProvider(); const env = { ARCHIVE: p.store, ARCHIVE_PREFIX: 'publish/' } as Env;
    p.setDenied(); await expect(deletePrefix(env, 'a', 'one')).rejects.toMatchObject({ code: 403 });
  });
});
