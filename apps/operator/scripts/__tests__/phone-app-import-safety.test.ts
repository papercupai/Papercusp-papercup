import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('node:child_process');
  vi.resetModules();
});

describe('Phone subprocess import safety', () => {
  it.each(['media-config', 'phone-ops-alert'])('imports %s with a narrow child_process mock', async (name) => {
    vi.resetModules();
    vi.doMock('node:child_process', () => ({ execFile: undefined }));
    if (name === 'media-config') {
      await expect(import('../../../../infra/phone-app/media-config.mjs')).resolves.toHaveProperty('localPhoneReadiness');
    } else {
      await expect(import('../../../../infra/phone-app/phone-ops-alert.mjs')).resolves.toHaveProperty('deliverPhoneOpsNotice');
    }
  });

  it('defers the default notification subprocess until invocation and preserves its arguments', async () => {
    vi.resetModules();
    const execute = vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => {
      callback(null, '');
    });
    vi.doMock('node:child_process', () => ({ execFile: execute }));
    const { deliverPhoneOpsNotice } = await import('../../../../infra/phone-app/phone-ops-alert.mjs');
    expect(execute).not.toHaveBeenCalled();
    const notice = { title: 'Fixture notice' };
    await deliverPhoneOpsNotice(notice);
    await deliverPhoneOpsNotice(notice);
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [file, args, options] of execute.mock.calls) {
      expect(file).toBe(process.execPath);
      expect(args).toContain('notifications:send_owner');
      expect(args).toContain(JSON.stringify(notice));
      expect(options).toMatchObject({ timeout: 15_000, maxBuffer: 16_384 });
    }
  });
});
