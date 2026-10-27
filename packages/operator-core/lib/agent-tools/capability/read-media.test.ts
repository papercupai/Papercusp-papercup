import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import readTool from './read';
import { MAX_IMAGE_BYTES } from './read-handler';
import { mkNonRepoTmpDir } from '../locks/non-repo-tmpdir';
import { writeScratchReference } from '../../scratch-reference';

const root = mkNonRepoTmpDir('cap-read-media-');
const ctx = { projectDir: root, workspaceId: 'ws-media' } as never;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5xkAAAAASUVORK5CYII=', 'base64');
let serial = 0;
function fixture(bytes: Buffer, suffix = '.png') {
  const path = join(root, String(serial++) + suffix);
  writeFileSync(path, bytes);
  return path;
}
const read = (args: Record<string, unknown>, caller = ctx) => readTool.handler(args as never, caller);

describe('capability:read raster media (MC-P026-MEDIA)', () => {
  it('returns the original authorized raster bytes in a permitted image block', async () => {
    const path = fixture(png, '.bin');
    const result = await read({ file_path: path });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({ ok: true, file_path: path, byte_length: png.length });
  });

  it('preserves exact byte paging when explicitly requested for an image', async () => {
    const result = await read({ file_path: fixture(png), byte_offset: 0, byte_limit: 8 });
    expect(result.content.every(part => part.type !== 'image')).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toMatchObject({
      encoding: 'base64', data: png.subarray(0, 8).toString('base64'), byte_length: 8,
    });
  });

  it('does not treat a filename extension as raster content', async () => {
    const result = await read({ file_path: fixture(Buffer.from('ordinary text\n')) });
    expect(result.content.every(part => part.type !== 'image')).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('ordinary text');
  });

  it('refuses oversized media rather than returning an unbounded image block', async () => {
    const bytes = Buffer.alloc(MAX_IMAGE_BYTES + 1); png.copy(bytes);
    const result = await read({ file_path: fixture(bytes) });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text).reason).toBe('image_too_large');
    expect(result.content.every(part => part.type !== 'image')).toBe(true);
  });

  it('authorizes a saved raster before returning any media', async () => {
    const path = join(root, 'raster-reference.spill');
    writeScratchReference({ filePath: path, payload: png, workspaceId: 'ws-media',
      audience: 'workspace', mediaType: 'image/png' });
    const authorized = await read({ file_path: path });
    expect(authorized.content).toContainEqual({ type: 'image', data: png.toString('base64'), mimeType: 'image/png' });
    const foreign = await read({ file_path: path }, { projectDir: root, workspaceId: 'other' } as never);
    expect(foreign.isError).toBe(true);
    expect(JSON.parse((foreign.content[0] as { text: string }).text).reason).toBe('workspace_mismatch');
    expect(foreign.content.every(part => part.type !== 'image')).toBe(true);
    expect(JSON.stringify(foreign)).not.toContain(png.toString('base64'));
  });
});
