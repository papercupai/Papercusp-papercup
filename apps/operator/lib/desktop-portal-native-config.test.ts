import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import nativeConfig, { prepareDesktopNativeRuntimeReader } from '../vitest.e2e.config';

afterEach(() => vi.unstubAllEnvs());

describe('desktop portal native evidence configuration', () => {
  it('preserves ordinary e2e collection without loading the native runtime graph', async () => {
    vi.stubEnv('VERIFY_TAURI_PID', '');
    vi.stubEnv('VERIFY_TAURI_PORT', '');
    const load = vi.fn();
    expect(await prepareDesktopNativeRuntimeReader(load)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    const config = await nativeConfig();
    expect(config.test?.provide?.papercuspTestLayer).toBe('e2e');
    expect(config.test?.include).toEqual(['**/*.e2e.test.ts', 'bin/desktop-portal-native.test.ts']);
  });

  it('reads current native custody separately before and after the assertion', async () => {
    vi.stubEnv('VERIFY_TAURI_PID', '1234');
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', 'a'.repeat(40));
    const read = vi.fn().mockReturnValueOnce({ fingerprint: 'before' }).mockReturnValueOnce(null);
    const prepareNativeRuntimeReader = vi.fn(() => read);
    const reader = await prepareDesktopNativeRuntimeReader(async () => ({ prepareNativeRuntimeReader }));
    expect(prepareNativeRuntimeReader).toHaveBeenCalledWith(resolve(import.meta.dirname, '../../..'), 'a'.repeat(40));
    expect(await reader!()).toEqual({ fingerprint: 'before' });
    expect(await reader!()).toBeNull();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it.each(['refused', 'unavailable'])('refuses %s native custody instead of running without a witness', async failure => {
    vi.stubEnv('VERIFY_TAURI_PID', '');
    vi.stubEnv('VERIFY_TAURI_PORT', '23170');
    await expect(prepareDesktopNativeRuntimeReader(async () => ({
      prepareNativeRuntimeReader: () => {
        if (failure === 'refused') throw new Error('native source custody refused');
        return undefined;
      },
    }))).rejects.toThrow(failure === 'refused' ? 'native source custody refused' : 'desktop-native-runtime-unavailable');
  });
});
