import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Stats } from 'node:fs';

const fs = vi.hoisted(() => ({
  openSync: vi.fn(), closeSync: vi.fn(), fstatSync: vi.fn(), lstatSync: vi.fn(), readSync: vi.fn(),
}));
vi.mock('node:fs', async importOriginal => ({ ...(await importOriginal<object>()), ...fs }));
import { constants } from 'node:fs';
import { MANAGED_UPDATE_POLICY_PATH, readManagedUpdateChannel } from './managed-update-policy';

const realPlatform = process.platform;
let content: Buffer;
function stat(directory = false, overrides: Partial<Stats> = {}): Stats {
  return {
    uid: 0, mode: directory ? 0o40755 : 0o100644, nlink: 1,
    size: content.length, mtimeMs: 1, ctimeMs: 1,
    isDirectory: () => directory, isFile: () => !directory,
    ...overrides,
  } as Stats;
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux' });
  vi.resetAllMocks();
  content = Buffer.from(JSON.stringify({ version: 1, update_channel: 'stable' }));
  fs.openSync.mockReturnValue(41);
  fs.lstatSync.mockImplementation(() => stat(true));
  fs.fstatSync.mockImplementation(() => stat());
  let offset = 0;
  fs.readSync.mockImplementation((_fd, buffer: Buffer, start: number, length: number) => {
    const count = content.copy(buffer, start, offset, offset + length);
    offset += count;
    return count;
  });
});
afterEach(() => Object.defineProperty(process, 'platform', { value: realPlatform }));

describe('Linux administrator update policy', () => {
  it.each(['alpha', 'beta', 'stable'])('accepts the trusted %s lane using a bounded no-follow descriptor', channel => {
    content = Buffer.from(JSON.stringify({ version: 1, update_channel: channel }));
    expect(readManagedUpdateChannel()).toBe(channel);
    expect(fs.lstatSync.mock.calls.map(call => call[0])).toEqual(['/', '/etc', '/etc/papercusp']);
    expect(fs.openSync).toHaveBeenCalledWith(MANAGED_UPDATE_POLICY_PATH, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    expect(fs.readSync.mock.calls[0]?.[1].length).toBe(16_385);
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it('leaves other platforms unmanaged without reading a Linux policy', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    expect(readManagedUpdateChannel()).toBeNull();
    expect(fs.lstatSync).not.toHaveBeenCalled();
  });

  it('treats a missing policy directory or file as unmanaged', () => {
    fs.lstatSync.mockImplementation(path => {
      if (path === '/etc/papercusp') throw Object.assign(new Error(), { code: 'ENOENT' });
      return stat(true);
    });
    expect(readManagedUpdateChannel()).toBeNull();
    expect(fs.openSync).not.toHaveBeenCalled();
    fs.lstatSync.mockImplementation(() => stat(true));
    fs.openSync.mockImplementation(() => { throw Object.assign(new Error(), { code: 'ENOENT' }); });
    expect(readManagedUpdateChannel()).toBeNull();
  });

  it.each([
    ['user-owned directory', { uid: 1000 }],
    ['group-writable directory', { mode: 0o40775 }],
    ['world-writable directory', { mode: 0o40777 }],
    ['symlink ancestor', { isDirectory: () => false }],
  ] as const)('refuses %s before opening a policy', (_name, overrides) => {
    fs.lstatSync.mockReturnValue(stat(true, overrides));
    expect(readManagedUpdateChannel).toThrow(expect.objectContaining({ code: 'managed_policy_invalid' }));
    expect(fs.openSync).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'ELOOP', 'EIO'])('fails closed on %s, without treating it as absence', code => {
    fs.openSync.mockImplementation(() => { throw Object.assign(new Error('sensitive content'), { code }); });
    expect(readManagedUpdateChannel).toThrow(expect.objectContaining({ code: 'managed_policy_invalid' }));
    expect(readManagedUpdateChannel).not.toThrow('sensitive content');
  });

  it.each([
    ['user-owned file', { uid: 1000 }],
    ['group-writable file', { mode: 0o100664 }],
    ['world-writable file', { mode: 0o100646 }],
    ['non-regular file', { isFile: () => false }],
    ['hard link', { nlink: 2 }],
    ['empty file', { size: 0 }],
    ['oversized file', { size: 16_385 }],
  ] as const)('refuses %s and closes the descriptor', (_name, overrides) => {
    fs.fstatSync.mockReturnValue(stat(false, overrides));
    expect(readManagedUpdateChannel).toThrow(expect.objectContaining({ code: 'managed_policy_invalid' }));
    expect(fs.readSync).not.toHaveBeenCalled();
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it.each([
    '{', 'null', '[]', '{}',
    '{"version":2,"update_channel":"stable"}',
    '{"version":1,"update_channel":"nightly"}',
    '{"version":1,"update_channel":"stable","unrecognised":true}',
  ])('rejects malformed/unsupported policy %s', raw => {
    content = Buffer.from(raw);
    expect(readManagedUpdateChannel).toThrow(expect.objectContaining({ code: 'managed_policy_invalid' }));
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it('rejects a file changed while reading instead of using partial policy', () => {
    fs.fstatSync.mockReturnValueOnce(stat()).mockReturnValueOnce(stat(false, { mtimeMs: 2 }));
    expect(readManagedUpdateChannel).toThrow(expect.objectContaining({ code: 'managed_policy_invalid' }));
    expect(fs.closeSync).toHaveBeenCalledWith(41);
  });

  it('bounds reads even if the file grows after the initial stat', () => {
    fs.fstatSync.mockReturnValue(stat());
    content = Buffer.alloc(32_768, 32);
    expect(readManagedUpdateChannel).toThrow(expect.objectContaining({ code: 'managed_policy_invalid' }));
    expect(fs.readSync).toHaveBeenCalledTimes(1);
  });
});
