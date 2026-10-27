import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareSuSessionInput } from './su-session-input';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9YkAAAAASUVORK5CYII=', 'base64');
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'su-input-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const authority = () => ({ workspaceId: 'workspace-a', root, now: Date.parse('2026-10-25T12:00:00Z') });
function file(bytes = png, extra = {}) {
  return { type: 'file' as const, uri: 'project:picture.png', mediaType: 'image/png',
    workspaceId: 'workspace-a', sha256: createHash('sha256').update(bytes).digest('hex'), ...extra };
}
describe('SU native typed input', () => {
  it('preserves exact legacy text', async () => {
    expect(await prepareSuSessionInput({ content: '  λ\n' }, authority())).toEqual({ claude: '  λ\n', codex: [{ type: 'text', text: '  λ\n' }] });
  });
  it('carries actual image bytes into both native protocols without flattening', async () => {
    const prepared = await prepareSuSessionInput({ content: 'What color?', input: [{ type: 'image', mediaType: 'image/png', data: png.toString('base64') }] }, authority());
    expect(prepared.claude).toEqual([{ type: 'text', text: 'What color?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }]);
    expect(prepared.codex[1]).toEqual({ type: 'image', url: `data:image/png;base64,${png.toString('base64')}` });
  });
  it('re-resolves the same pinned reference on reconnect and preserves its bytes', async () => {
    await writeFile(join(root, 'picture.png'), png);
    const turn = { content: '', input: [file()] };
    const first = await prepareSuSessionInput(turn, authority());
    expect(await prepareSuSessionInput(JSON.parse(JSON.stringify(turn)), authority())).toEqual(first);
  });
  it('refuses changed content under the same filename', async () => {
    await writeFile(join(root, 'picture.png'), Buffer.concat([png, Buffer.from('changed')]));
    await expect(prepareSuSessionInput({ content: '', input: [file()] }, authority())).rejects.toMatchObject({ code: 'input_identity_changed' });
  });
  it('refuses a foreign workspace even when the path and bytes match', async () => {
    await writeFile(join(root, 'picture.png'), png);
    await expect(prepareSuSessionInput({ content: '', input: [file(png, { workspaceId: 'workspace-b' })] }, authority())).rejects.toMatchObject({ code: 'input_workspace_mismatch' });
  });
  it('refuses expired references', async () => {
    await expect(prepareSuSessionInput({ content: '', input: [file(png, { expiresAt: '2026-10-24T12:00:00Z' })] }, authority())).rejects.toMatchObject({ code: 'input_expired' });
  });
  it('refuses revoked filesystem permissions on replay', async () => {
    await writeFile(join(root, 'picture.png'), png);
    await prepareSuSessionInput({ content: '', input: [file()] }, authority());
    await chmod(join(root, 'picture.png'), 0o000);
    await expect(prepareSuSessionInput({ content: '', input: [file()] }, authority())).rejects.toMatchObject({ code: 'input_unreadable' });
  });
  it('refuses a moved file without looking for the same basename', async () => {
    await writeFile(join(root, 'picture.png'), png);
    await rename(join(root, 'picture.png'), join(root, 'moved.png'));
    await expect(prepareSuSessionInput({ content: '', input: [file()] }, authority())).rejects.toMatchObject({ code: 'input_unreadable' });
  });
  it('refuses symlinks outside the project', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'su-input-outside-'));
    try {
      await writeFile(join(outside, 'picture.png'), png);
      await symlink(join(outside, 'picture.png'), join(root, 'picture.png'));
      await expect(prepareSuSessionInput({ content: '', input: [file()] }, authority())).rejects.toMatchObject({ code: 'input_outside_project' });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
  it('carries supported UTF-8 file content and rejects unsupported binary media', async () => {
    const bytes = Buffer.from('answer = λ');
    await writeFile(join(root, 'picture.png'), bytes);
    const prepared = await prepareSuSessionInput({ content: '', input: [file(bytes, { mediaType: 'text/plain' })] }, authority());
    expect(prepared.codex).toEqual([{ type: 'text', text: 'File project:picture.png\nanswer = λ' }]);
    await expect(prepareSuSessionInput({ content: '', input: [file(bytes, { mediaType: 'application/zip' })] }, authority())).rejects.toMatchObject({ code: 'unsupported_input_media_type' });
  });
  it('refuses a false MIME type and malformed inline base64', async () => {
    await expect(prepareSuSessionInput({ content: '', input: [{ type: 'image', mediaType: 'image/jpeg', data: png.toString('base64') }] }, authority())).rejects.toMatchObject({ code: 'input_media_mismatch' });
    await expect(prepareSuSessionInput({ content: '', input: [{ type: 'image', mediaType: 'image/png', data: 'not base64' }] }, authority())).rejects.toMatchObject({ code: 'input_encoding_invalid' });
  });
  it('refuses unpinned, network and oversized inputs before delivery', async () => {
    await expect(prepareSuSessionInput({ content: '', input: [file(png, { sha256: undefined })] }, authority())).rejects.toMatchObject({ code: 'input_identity_missing' });
    await expect(prepareSuSessionInput({ content: '', input: [file(png, { uri: 'https://example.org/image.png' })] }, authority())).rejects.toMatchObject({ code: 'unsupported_input_reference' });
    await expect(prepareSuSessionInput({ content: '', input: [{ type: 'image', mediaType: 'image/png', data: 'a'.repeat(7 * 1024 * 1024) }] }, authority())).rejects.toMatchObject({ code: 'input_too_large' });
  });
});
