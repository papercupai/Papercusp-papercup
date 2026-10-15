/** Real-PG guard: default interactive lineage reads release a stalled backend. */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';

const state = vi.hoisted(() => ({ sql: undefined as Sql | undefined, backendPid: 0 }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...await importOriginal<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: state.sql }),
}));

const { createOrgTestDb } = await import('../test/_org-test-db');
const {
  acceptanceLineageClosure, acceptanceLineageAncestors,
  areAcceptanceLineageRelated, lineagePartyKeys, isAcceptanceAuthorIdentity,
} = await import('./acceptance-author-identity');
let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  state.sql = new Proxy(db.adminSql, {
    get(target, key, receiver) {
      if (key !== 'begin') return Reflect.get(target, key, receiver);
      return (fn: (sql: Sql) => Promise<unknown>) => target.begin(async (tx) => {
        const stalled = new Proxy(tx, {
          apply(query, receiver, args: unknown[]) {
            const first = args[0];
            if (Array.isArray(first) && /^\s*WITH RECURSIVE/.test(first[0])) {
              // Delay the actual database statement on the SAME connection as
              // the production reader, rather than simulating a JS timeout.
              return (async () => {
                const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
                state.backendPid = backend.pid;
                await tx`SELECT pg_sleep(10)`;
                return Reflect.apply(query, receiver, args);
              })();
            }
            return Reflect.apply(query, receiver, args);
          },
        });
        return fn(stalled as unknown as Sql);
      });
    },
  });
}, 180_000);

afterAll(async () => { await db?.cleanup(); });

const workspaceId = 'bounded-default-lineage';
const readers = [
  ['closure', () => acceptanceLineageClosure('a', { workspaceId })],
  ['ancestors', () => acceptanceLineageAncestors('a', { workspaceId })],
  ['pairwise', () => areAcceptanceLineageRelated('a', 'b', { workspaceId })],
  ['parties', () => lineagePartyKeys(['a', 'b'], { workspaceId })],
] as const;

for (const [name, read] of readers) {
  it(`bounds the default ${name} reader and releases its stalled backend`, async () => {
    await expect(read()).rejects.toMatchObject({ code: '57014' });
    const [backend] = await db.adminSql`SELECT state, query FROM pg_stat_activity WHERE pid=${state.backendPid}`;
    expect(backend?.state === 'active' && backend?.query.includes('pg_sleep')).toBe(false);
    expect((await db.adminSql`SELECT 1 AS healthy`)[0].healthy).toBe(1);
  }, 15_000);
}

it('fails author continuity closed after the same real database timeout', async () => {
  expect(await isAcceptanceAuthorIdentity('a', 'b', { workspaceId })).toBe(false);
  const [backend] = await db.adminSql`SELECT state, query FROM pg_stat_activity WHERE pid=${state.backendPid}`;
  expect(backend?.state === 'active' && backend?.query.includes('pg_sleep')).toBe(false);
}, 15_000);
