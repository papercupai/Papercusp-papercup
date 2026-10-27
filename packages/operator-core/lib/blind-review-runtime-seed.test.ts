import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { assertRuntimeSeed, createRuntimeSeed, runtimeSeedSchema } from './blind-review-runtime-seed';

const lease = () => ({ id: randomUUID(), lease_epoch: '1', runtime_nonce: randomUUID() });
describe('disposable runtime seed custody', () => {
  it('generates fresh isolated identities and only the fixed maintained ready fixture', () => {
    const a = lease(), b = lease(), first = createRuntimeSeed(a), second = createRuntimeSeed(b);
    assertRuntimeSeed(first, a); assertRuntimeSeed(second, b);
    expect(first.workspace.id).not.toBe(second.workspace.id);
    expect(first.workspace.slug).not.toBe(second.workspace.slug);
    expect(first.actors).toEqual([]); expect(first.fixtures).toEqual(['ready']);
    expect(Object.isFrozen(first.workspace)).toBe(true);
    expect(Object.isFrozen(first.actors)).toBe(true);
    expect(Object.isFrozen(first.fixtures)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it.each(['copy', 'lease', 'epoch', 'nonce'])(
    'refuses borrowed or reconstructed custody (%s)', defect => {
      const a = lease(), seed = createRuntimeSeed(a);
      const supplied = defect === 'copy' ? JSON.parse(JSON.stringify(seed)) : seed;
      const target = defect === 'lease' ? { ...a, id: randomUUID() }
        : defect === 'epoch' ? { ...a, lease_epoch: '2' }
          : defect === 'nonce' ? { ...a, runtime_nonce: randomUUID() } : a;
      expect(() => assertRuntimeSeed(supplied, target)).toThrow('broker_seed_origin_invalid');
    });

  it.each(['url', 'credential', 'raw-text', 'foreign-fixture', 'actors', 'too-many-fixtures', 'traversal'])(
    'rejects inputs outside the bounded v1 grammar (%s)', defect => {
      const seed = JSON.parse(JSON.stringify(createRuntimeSeed(lease())));
      if (defect === 'url') seed.url = 'https://host.invalid';
      // Low-entropy stand-in: the schema must reject the credential FIELD, whatever its value.
      if (defect === 'credential') seed.workspace.apiKey = 'stand-in';
      if (defect === 'raw-text') seed.workspace.name = 'arbitrary owner/review text';
      if (defect === 'foreign-fixture') seed.fixtures = ['live-workspace'];
      if (defect === 'actors') seed.actors = [{ id: randomUUID(), fixtureKey: 'live-owner' }];
      if (defect === 'too-many-fixtures') seed.fixtures = Array(9).fill('ready');
      if (defect === 'traversal') seed.workspace.slug = '../live-profile';
      expect(runtimeSeedSchema.safeParse(seed).success).toBe(false);
    });

  it('rejects invalid lease identities before creating a seed', () => {
    expect(() => createRuntimeSeed({ ...lease(), lease_epoch: '0' })).toThrow('broker_seed_lease_invalid');
    expect(() => createRuntimeSeed({ ...lease(), runtime_nonce: 'borrowed' })).toThrow('broker_seed_lease_invalid');
  });
});
