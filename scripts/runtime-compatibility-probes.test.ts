import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_EXPECTATIONS, performNativeCapability } from './lib/runtime-compatibility-probes.mjs';

const manifest = resolve('packages/operator-core/package.json');
describe('isolated native semantic baseline under the existing Node generation', () => {
  it.each(Object.entries(NATIVE_EXPECTATIONS))('%s completes its actual operation', async (id, expected) => {
    expect(await performNativeCapability(id, manifest)).toEqual(expected);
  }, 15_000);
  it('refuses an unknown capability rather than substituting an import check', async () => {
    await expect(performNativeCapability('unknown', manifest)).rejects.toThrow('Unknown native capability');
  });
  it('requires an explicit absolute dependency resolution root', async () => {
    await expect(performNativeCapability('udx-loopback', 'package.json')).rejects.toThrow('Absolute candidate');
  });
});
