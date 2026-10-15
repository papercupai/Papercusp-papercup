import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';

let sql: postgres.Sql;
let admin: postgres.Sql;
const database = `owner_history_${randomUUID().replaceAll('-', '')}`;

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql }),
}));

import { backfillFromOwnerSessionTurns, decodeOwnerHistoryCursor } from '../../owner-sessions/transcript';

beforeAll(async () => {
  const uri = await getTestPg();
  admin = postgres(uri, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await markManagedTestDatabase(admin, database);
  const target = new URL(uri);
  target.pathname = `/${database}`;
  sql = postgres(target.toString(), { max: 1, onnotice: () => {} });
  await sql`CREATE SCHEMA harness_shared`;
  await sql`CREATE TABLE harness_shared.session_turns (
    owner text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL,
    turn_idx int NOT NULL, ts timestamptz, ingested_at timestamptz NOT NULL,
    speaker text, text text,
    PRIMARY KEY (source_kind, session_id, turn_idx)
  )`;
}, 120_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  if (admin) {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end({ timeout: 5 });
  }
});

describe('owner history SQL pagination', () => {
  it('walks every tied ordering key over four pages without losing, duplicating, or leaking turns', async () => {
    const expected: string[] = [];
    // Every row shares its effective timestamp, including NULL-ts fallback rows.
    // Cursor boundaries must therefore retain all three remaining tie breakers.
    for (const source of ['claude', 'codex', 'omp']) {
      for (const epoch of ['a', 'b']) {
        for (const turn of [0, 1]) {
          const text = `${source}/${epoch}/${turn}`;
          expected.push(text);
          for (const owner of ['owner-a', 'owner-b']) {
            await sql`INSERT INTO harness_shared.session_turns
              (owner, source_kind, session_id, turn_idx, ts, ingested_at, speaker, text)
              VALUES (${owner}, ${source}, ${`${owner}-${epoch}`}, ${turn},
                ${turn === 0 ? null : '2026-09-05T12:00:00.123456Z'}::text::timestamptz,
                '2026-09-05T12:00:00.123456Z', 'user', ${owner === 'owner-a' ? text : `FOREIGN:${text}`})`;
          }
        }
      }
    }

    const pages: string[][] = [];
    let cursor = null as ReturnType<typeof decodeOwnerHistoryCursor>;
    const seenCursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < 5; pageIndex++) {
      const page = await backfillFromOwnerSessionTurns('owner-a', { cap: 3, cursor });
      expect(page).not.toBeNull();
      expect(page!.entries).toHaveLength(3);
      const texts = page!.entries.map((entry) => entry.text!);
      expect(texts.some((text) => text.startsWith('FOREIGN:'))).toBe(false);
      pages.unshift(texts);
      if (!page!.hasMore) {
        expect(page!.cursor).toBeNull();
        break;
      }
      expect(page!.cursor).not.toBeNull();
      expect(seenCursors.has(page!.cursor!)).toBe(false);
      seenCursors.add(page!.cursor!);
      cursor = decodeOwnerHistoryCursor(page!.cursor!);
      expect(cursor).not.toBeNull();
      expect(cursor!.at).toContain('.123456');
    }
    expect(pages.flat()).toEqual(expected);
    expect(pages).toHaveLength(4);
    expect(new Set(pages.flat()).size).toBe(expected.length);
    expect(await backfillFromOwnerSessionTurns('unknown-owner', { cap: 3 })).toBeNull();
  });
});
