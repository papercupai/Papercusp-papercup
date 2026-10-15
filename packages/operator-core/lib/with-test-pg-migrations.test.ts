import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// @ts-expect-error Node-only launcher helper has no TypeScript dependencies.
import { snapshotMigrationSource } from '../../../scripts/lib/with-test-pg-migrations.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'isolated-migration-source-'));
  roots.push(root);
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, '000-baseline.sql'), 'SELECT 1;');
  return { root, source, destination: join(root, 'snapshot') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('isolated runtime migration custody', () => {
  it('keeps bootstrap and restart on the admitted bytes while the shared source changes', () => {
    const { source, destination } = fixture();
    writeFileSync(join(source, '1510-existing.sql'), 'SELECT 2;');
    writeFileSync(join(source, '1510-existing.sql.forward-compat.json'), '{"approved":true}');
    writeFileSync(join(source, '1511-work-in-progress.sql.DRAFT'), 'not admitted');
    expect(snapshotMigrationSource(source, destination)).toBe(destination);
    writeFileSync(join(source, '1510-existing.sql'), 'SELECT 3;');
    writeFileSync(join(source, '1511-new.sql'), 'SELECT 4;');
    // These are the actual files used by bootstrap and subsequent boot reads.
    expect(readFileSync(join(destination, '1510-existing.sql'), 'utf8')).toBe('SELECT 2;');
    expect(readFileSync(join(destination, '1510-existing.sql.forward-compat.json'), 'utf8')).toBe('{"approved":true}');
    expect(() => readFileSync(join(destination, '1511-new.sql'))).toThrow();
    expect(() => readFileSync(join(destination, '1511-work-in-progress.sql.DRAFT'))).toThrow();
  });

  it('refuses links to mutable migration bytes outside the captured source', () => {
    const { root, source, destination } = fixture();
    const outside = join(root, 'mutable.sql');
    writeFileSync(outside, 'SELECT 5;');
    symlinkSync(outside, join(source, '1511-linked.sql'));
    expect(() => snapshotMigrationSource(source, destination)).toThrow('must be a regular file');
  });

  it('refuses to overwrite an existing snapshot and retains its evidence', () => {
    const { source, destination } = fixture();
    snapshotMigrationSource(source, destination);
    writeFileSync(join(source, '000-baseline.sql'), 'SELECT 6;');
    expect(() => snapshotMigrationSource(source, destination)).toThrow();
    expect(readFileSync(join(destination, '000-baseline.sql'), 'utf8')).toBe('SELECT 1;');
  });
});
