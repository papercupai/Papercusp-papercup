/**
 * The first-party definition hashes are FIXED here (plan-item-types-registry-cupboard P-005,
 * D-006). Migration 1545 backfills every pre-registry activated plan's pins with these same
 * literals, and a pinned plan whose definition no longer matches its pin fails safe to the
 * strictest module set. So editing a first-party definition in builtin-catalog.ts must fail
 * this test: the edit needs a new revision, not a silent change to revision 1.
 */
import { describe, expect, it } from 'vitest';
import { BUILTIN_CATALOG } from './builtin-catalog';
import { definitionContentHash } from './content-hash';
import { buildTypeRegistrySnapshot } from './registry';

const FIRST_PARTY_HASHES: Record<string, string> = {
  'papercusp/code': 'b3845721014d94609a14b7076381cc25e033979c00d077620ede2fd7da8d63a8',
  'papercusp/doc': '03961bf29818a0811a1be0714ea416d707dcbda53ff03ebcd849a3b8d9a2ff10',
  'papercusp/decision': 'b4b4381dbcdacf850fc06c4c972f3e91c9edda6fa5ecb5bb4092fa984381db33',
  'papercusp/research': '01f4fe2ffe230eb3f4e4185841bb63f59f1d9e19c9d552e972cb7c34e113c48f',
  'papercusp/operation': '3248c2c0a553462bf8fc542131c12a2be87d2a5e6807a96eafba4e7ffd97c82a',
  'papercusp/artifact': 'bab794a1a29e1e663be6659bf5bcec54fe687a9f62375507f9157d2e74448d80',
  'papercusp/coding': '1a12288396d2c39c6169e92eb7a50a882e9612172b6bcd45bbb4286e70c3e1cf',
  'papercusp/general': '7caa0494d37bce4d8e64c310853c03a9059edca6daf4bfa4265f4ceca77ced37',
};

describe('definition content hashes', () => {
  it('fixes every first-party revision-1 hash (edit a built-in only with a new revision)', () => {
    const actual = Object.fromEntries(
      [...BUILTIN_CATALOG.itemTypes, ...BUILTIN_CATALOG.planTypes].map((d) => [d.id, definitionContentHash(d)]),
    );
    expect(actual).toEqual(FIRST_PARTY_HASHES);
  });

  it('matches the literals migration 1545 backfills into plan_type_pins', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const sqlPath = fileURLToPath(
      new URL('../../../../libs/papercusp/libs/db/sql/1545-plan-type-pins.sql', import.meta.url),
    );
    const sql = await readFile(sqlPath, 'utf8');
    for (const [id, hash] of Object.entries(FIRST_PARTY_HASHES)) {
      expect(sql, id).toMatch(new RegExp(`'${id}',\\s*'${hash}'`));
    }
  });

  it('ignores key order but not content', () => {
    const a = { schemaVersion: 1, id: 'acme/x', revision: 1, title: 'X', modules: ['generic-core'] };
    const b = { modules: ['generic-core'], title: 'X', revision: 1, id: 'acme/x', schemaVersion: 1 };
    expect(definitionContentHash(a)).toBe(definitionContentHash(b));
    expect(definitionContentHash({ ...a, title: 'Y' })).not.toBe(definitionContentHash(a));
    expect(definitionContentHash({ ...a, modules: ['generic-core', 'code'] })).not.toBe(definitionContentHash(a));
  });

  it('the registry snapshot carries the stored definition hash on every candidate', () => {
    const registry = buildTypeRegistrySnapshot();
    expect(registry.itemType('papercusp/code')?.contentHash).toBe(FIRST_PARTY_HASHES['papercusp/code']);
    expect(registry.planTypeAt('papercusp/general', 1)?.contentHash).toBe(FIRST_PARTY_HASHES['papercusp/general']);
  });
});
