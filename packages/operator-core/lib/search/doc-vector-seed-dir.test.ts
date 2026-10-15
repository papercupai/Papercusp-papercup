import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_VECTOR_SEED_RESOURCE, resolveDocVectorSeedDir } from './doc-vector-seed-dir';

// Installed .deb layout: resources are siblings under usr/lib/<Product>/.
const ROOT = '/usr/lib/Papercusp Server';
const PG_SQL_DIR = join(ROOT, 'sidecar', 'db-sql');
const PACKAGED = join(ROOT, 'doc-vector-seed');

function existsOnly(...dirsWithManifest: string[]) {
  const files = new Set(dirsWithManifest.map((d) => join(d, 'manifest.json')));
  return (p: string) => files.has(p);
}

describe('resolveDocVectorSeedDir', () => {
  it('uses the bundle resource name the Server config ships', () => {
    expect(DOC_VECTOR_SEED_RESOURCE).toBe('doc-vector-seed');
  });

  it('finds the packaged seed as a sibling of sidecar/ from PAPERCUSP_PG_SQL_DIR', () => {
    expect(resolveDocVectorSeedDir({ env: { PAPERCUSP_PG_SQL_DIR: PG_SQL_DIR }, exists: existsOnly(PACKAGED) })).toBe(PACKAGED);
  });

  it('finds it from any of the hive-seed sibling envs', () => {
    const env = { PAPERCUSP_PROMPTS_DIR: join(ROOT, 'sidecar', 'prompts') };
    expect(resolveDocVectorSeedDir({ env, exists: existsOnly(PACKAGED) })).toBe(PACKAGED);
  });

  it('an explicit PAPERCUSP_DOC_VECTOR_SEED_DIR wins, even without a manifest', () => {
    const env = { PAPERCUSP_DOC_VECTOR_SEED_DIR: ' /opt/seed ', PAPERCUSP_PG_SQL_DIR: PG_SQL_DIR };
    expect(resolveDocVectorSeedDir({ env, exists: existsOnly(PACKAGED) })).toBe('/opt/seed');
  });

  it('a manifest-less placeholder dir (build.rs) reads as no seed', () => {
    expect(resolveDocVectorSeedDir({ env: { PAPERCUSP_PG_SQL_DIR: PG_SQL_DIR }, exists: existsOnly() })).toBeNull();
  });

  it('returns null when no resource env is set', () => {
    expect(resolveDocVectorSeedDir({ env: {}, exists: existsOnly(PACKAGED) })).toBeNull();
  });
});
