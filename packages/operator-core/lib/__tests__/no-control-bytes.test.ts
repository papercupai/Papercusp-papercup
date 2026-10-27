import { describe, expect, it } from 'vitest';

const loadGuard = () => import(new URL('../../../../scripts/check-no-control-bytes.mjs', import.meta.url).href);
const digest = 'a'.repeat(64);

describe('control-byte guard scope for retained evaluator code', () => {
  it.each([
    `docs/evidence/audit/run.json.modules/${digest}.js`,
    `docs/evidence/another/future/run.group-2.json.modules/${digest}.js`,
  ])('preserves byte-exact generated evidence at %s', async (path) => {
    const { isScannedPath } = await loadGuard();
    expect(isScannedPath(path)).toBe(false);
  });

  it.each([
    'docs/evidence/audit/run.json',
    'docs/evidence/audit/authored.js',
    'docs/evidence/audit/run.json.modules/authored.js',
    `docs/evidence/audit/run.json.modules/${'a'.repeat(63)}.js`,
    `docs/evidence/audit/run.json.modules/${digest.toUpperCase()}.js`,
    `docs/evidence/audit/run.json.modules/${digest}.ts`,
    `docs/evidence/audit/run.json.modules/nested/${digest}.js`,
    `packages/feature/run.json.modules/${digest}.js`,
  ])('retains authored-source and manifest coverage at %s', async (path) => {
    const { isScannedPath } = await loadGuard();
    expect(isScannedPath(path)).toBe(true);
  });

  it('still detects the observed raw byte in authored source', async () => {
    const { findControlBytes, isScannedPath } = await loadGuard();
    const path = 'docs/evidence/audit/authored.js';
    expect(isScannedPath(path)).toBe(true);
    expect(findControlBytes(path, Buffer.from([0x61, 0x19, 0x62])))
      .toEqual([expect.objectContaining({ path, offset: 1, byte: 0x19 })]);
  });
});
