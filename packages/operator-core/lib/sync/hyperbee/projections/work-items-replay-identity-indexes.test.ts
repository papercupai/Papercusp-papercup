/**
 * Recurrence guard for the WI-2142873 wedge class: a UNIQUE index on
 * harness_shared.work_items that the engineer-issues replay path does not know
 * about turns one duplicate peer op into a deterministic 23505 that pins the
 * merge cursor for the whole peer log. It happened on migration 1157's index,
 * then again on migration 986's.
 *
 * This scans every migration (files in numeric order, so a later DROP INDEX
 * retires an earlier CREATE) and requires each live unique index to carry an
 * explicit replay policy, and every "coalesced" policy to have a resolver.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { COALESCED_REPLAY_IDENTITY_INDEXES } from './engineer-issues';
import {
  INTAKE_PROMOTION_IDENTITY_INDEX,
  RESOURCE_GOVERNOR_IDENTITY_INDEX,
  WORK_ITEMS_UNIQUE_INDEX_REPLAY_POLICY,
  coalescedReplayIdentityIndexes,
} from './work-items-replay-identity-indexes';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..', '..', '..', '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'libs/papercusp/libs/db/sql');

function stripSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

const CREATE_UNIQUE_ON_WORK_ITEMS =
  /CREATE\s+UNIQUE\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:harness_shared\.)?"?([a-z0-9_]+)"?\s+ON\s+(?:ONLY\s+)?harness_shared\.work_items\b/gi;
const DROP_INDEX = /DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(?:harness_shared\.)?"?([a-z0-9_]+)"?/gi;

function migrationNumber(file: string): number {
  const match = /^(\d+)-/.exec(file);
  return match ? Number(match[1]) : -1;
}

/** Unique indexes on work_items still standing after every migration applies. */
function liveUniqueWorkItemsIndexes(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b) || a.localeCompare(b));
  const live = new Set<string>();
  for (const file of files) {
    const sql = stripSqlComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
    const events: { at: number; kind: 'create' | 'drop'; name: string }[] = [];
    for (const m of sql.matchAll(CREATE_UNIQUE_ON_WORK_ITEMS)) {
      events.push({ at: m.index ?? 0, kind: 'create', name: m[1]!.toLowerCase() });
    }
    for (const m of sql.matchAll(DROP_INDEX)) {
      events.push({ at: m.index ?? 0, kind: 'drop', name: m[1]!.toLowerCase() });
    }
    events.sort((a, b) => a.at - b.at);
    for (const event of events) {
      if (event.kind === 'create') live.add(event.name);
      else live.delete(event.name);
    }
  }
  return [...live].sort();
}

describe('work_items unique-index replay policy (WI-2142873 wedge class)', () => {
  it('finds the known logical-identity indexes (positive control for the scan)', () => {
    const live = liveUniqueWorkItemsIndexes();
    // If the scan regex or the migrations path breaks, this fails instead of the
    // coverage check below passing vacuously over an empty list.
    expect(live).toEqual(
      expect.arrayContaining([
        'work_items_watchdog_identity_uq',
        'work_items_keyless_title_identity_uq',
        RESOURCE_GOVERNOR_IDENTITY_INDEX,
        INTAKE_PROMOTION_IDENTITY_INDEX,
        'work_items_condition_key_uq',
      ]),
    );
  });

  it('every live unique index on work_items has an explicit replay policy', () => {
    const missing = liveUniqueWorkItemsIndexes().filter((name) => !(name in WORK_ITEMS_UNIQUE_INDEX_REPLAY_POLICY));
    expect(
      missing,
      'Each new UNIQUE index on harness_shared.work_items needs an entry in ' +
        'work-items-replay-identity-indexes.ts. A logical-identity index needs a resolver in ' +
        'engineer-issues.ts resolveIdentityConflict, or a replayed duplicate wedges the merge cursor.',
    ).toEqual([]);
  });

  it('every coalesced policy has a resolver, and every resolver is declared', () => {
    expect([...COALESCED_REPLAY_IDENTITY_INDEXES].sort()).toEqual(coalescedReplayIdentityIndexes());
  });
});
