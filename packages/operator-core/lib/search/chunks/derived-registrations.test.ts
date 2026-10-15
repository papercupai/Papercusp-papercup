/**
 * R-15 of generic-rag-chunking-2026-09-29 (P-005): every chunk store in the
 * registry reaches all five host registrations, and a registration list that
 * drops one fails this guard.
 *
 * Four lists DERIVE from CHUNK_STORES (the embed sweep's TARGETS, the prose
 * width columns, the search coverage gate, the retention map); the backup
 * package cannot import operator-core, so its hot-snapshot exclusion list is
 * PINNED here. Each assertion goes through `missingChunkStores`, and the
 * controls at the bottom keep a list with a store removed permanently in this
 * file, so the guard is proven able to fail without mutating the tree.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { HOT_SNAPSHOT_EXCLUDED_TABLE_DATA } from '@papercusp/backup/hook';
import { TARGETS } from '../embed-backfill';
import { PROSE_VECTOR_COLUMNS } from '../prose-vector-dims';
import { SEARCH_SOURCE_SURFACES } from '../coverage-gate';
import { RETENTION_COVERED_ELSEWHERE } from '../../storage/storage-growth-alarm';
import {
  bareTableName,
  CHUNK_STORES,
  CHUNK_SURFACES,
  missingChunkStores,
  surfaceStoreTable,
  TEXT_CHUNKS_TABLE,
  withChunkSearchColumns,
  type ChunkStoreRegistration,
  type PapercuspChunkSurface,
} from './registry';

/** Every registration list, as the table names it covers. */
function registrationLists(): Record<string, string[]> {
  return {
    'embed-backfill TARGETS': TARGETS.map((t) => t.table),
    PROSE_VECTOR_COLUMNS: PROSE_VECTOR_COLUMNS.map((c) => c.table),
    'backup HOT_SNAPSHOT_EXCLUDED_TABLE_DATA': [...HOT_SNAPSHOT_EXCLUDED_TABLE_DATA],
    // Keyed by bare name; mapped back to qualified below.
    RETENTION_COVERED_ELSEWHERE: Object.keys(RETENTION_COVERED_ELSEWHERE).map((t) => `harness_shared.${t}`),
  };
}

/*
 * Mutation-probe seam: PAPERCUSP_COVERAGE_GATE_SUBJECT is an absolute path to a
 * copy of ../coverage-gate.ts (scripts/mutation-probe.sh points it at a mutant
 * that stops deriving from the registry, so the tracked file is never
 * modified). Unset, the real SEARCH_SOURCE_SURFACES is checked.
 */
let searchSourceSurfaces = SEARCH_SOURCE_SURFACES;
beforeAll(async () => {
  const subject = process.env.PAPERCUSP_COVERAGE_GATE_SUBJECT;
  if (subject) {
    searchSourceSurfaces = ((await import(subject)) as { SEARCH_SOURCE_SURFACES: typeof SEARCH_SOURCE_SURFACES })
      .SEARCH_SOURCE_SURFACES;
  }
});

describe('chunk-store registrations derive from the registry (R-15)', () => {
  it('the registry names both known stores, each once', () => {
    const tables = CHUNK_STORES.map((s) => s.table);
    expect(tables).toContain(TEXT_CHUNKS_TABLE);
    expect(tables).toContain('harness_shared.session_turn_chunks');
    expect(new Set(tables).size).toBe(tables.length);
  });

  it.each(Object.keys(registrationLists()))('%s holds every registry store', (name) => {
    expect(missingChunkStores(registrationLists()[name])).toEqual([]);
  });

  it('every registry store is in the retention map with its own evidence', () => {
    for (const s of CHUNK_STORES) {
      expect(RETENTION_COVERED_ELSEWHERE[bareTableName(s.table)]).toBe(s.retention);
    }
  });

  it('every store reaches the coverage gate for each search source that reads it', () => {
    for (const s of CHUNK_STORES) {
      for (const source of s.searchSources) {
        expect(searchSourceSurfaces[source]).toContain(`${s.table}.${s.embedCol}`);
      }
    }
    // The pre-P-005 hand-listed union survives the derivation unchanged.
    expect(searchSourceSurfaces.session_turn).toEqual([
      'harness_shared.session_turns.text_embedding',
      'harness_shared.session_turn_chunks.embedding',
    ]);
  });

  it('the embed sweep target for a store is exactly its registration', () => {
    for (const s of CHUNK_STORES) {
      const t = TARGETS.find((x) => x.table === s.table);
      expect(t).toMatchObject({
        embedCol: s.embedCol,
        bodySql: s.embeddedTextSql,
        keyCols: [...s.keyCols],
        orderBySql: 'updated_at DESC',
        recencyCol: 'updated_at',
        recencyColKind: 'timestamptz',
      });
    }
  });

  it('every registered surface writes to a registered store', () => {
    const tables = new Set(CHUNK_STORES.map((s) => s.table));
    for (const surface of CHUNK_SURFACES) expect(tables.has(surfaceStoreTable(surface))).toBe(true);
  });
});

describe('a new store or entry reaches the derived lists with no other edit', () => {
  const extra: ChunkStoreRegistration = {
    table: 'harness_shared.fixture_chunks',
    embedCol: 'embedding',
    keyCols: ['id', 'chunk_idx'],
    embeddedTextSql: 'content',
    retention: 'fixture',
    searchSources: ['fixture_source'],
  };
  const stores = [...CHUNK_STORES, extra];

  it('coverage columns: a dedicated store names its source; a shared-store entry names its own', () => {
    const entry = {
      surface: 'fixture',
      searchSource: 'work_item',
    } as unknown as PapercuspChunkSurface;
    const map = withChunkSearchColumns({ work_item: ['harness_shared.work_items.embedding'] }, stores, [entry]);
    expect(map.fixture_source).toEqual(['harness_shared.fixture_chunks.embedding']);
    expect(map.work_item).toEqual(['harness_shared.work_items.embedding', `${TEXT_CHUNKS_TABLE}.embedding:fixture`]);
    expect(map.session_turn).toEqual(['harness_shared.session_turn_chunks.embedding']);
  });

  it('the guard reports a store that a list lacks', () => {
    expect(missingChunkStores(registrationLists()['embed-backfill TARGETS'], stores)).toEqual([extra.table]);
  });
});

describe('controls: the guard fails on a list with a store removed', () => {
  // Permanent deliberately-wrong inputs (never a mutation of the real files).
  it.each(Object.keys(registrationLists()))('dropping %s’s shared-store entry is caught', (name) => {
    const dropped = registrationLists()[name].filter((t) => t !== TEXT_CHUNKS_TABLE);
    expect(missingChunkStores(dropped)).toEqual([TEXT_CHUNKS_TABLE]);
  });

  it.each(Object.keys(registrationLists()))('dropping %s’s session-turn entry is caught', (name) => {
    const dropped = registrationLists()[name].filter((t) => t !== 'harness_shared.session_turn_chunks');
    expect(missingChunkStores(dropped)).toEqual(['harness_shared.session_turn_chunks']);
  });
});
