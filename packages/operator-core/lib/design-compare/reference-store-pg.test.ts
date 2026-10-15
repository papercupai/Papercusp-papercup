/**
 * WI-1202547 — the store must resolve its client PER CALL, never once at construction.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE INTEGRATION SUITE. That suite hands the store
 * a live handle and asserts the SQL is right, so it passes identically whether the client
 * is resolved once or every time — it cannot see the difference this change is about. The
 * defect being repaired is precisely a binding resolved once and then trusted forever, so
 * a reviewer reverting `getSql` to a captured `const sql = getSql()` would break nothing
 * any other test can observe. This one fails.
 *
 * The failure mode it guards is expensive and near-invisible in production: when the admin
 * endpoint moves (embedded-pg dying, or `~/.papercusp/embedded-pg.json` being DELETED,
 * which correctly restores the healthy native :5432) a captured handle keeps presenting a
 * binding that no longer applies. On 2026-08-30 a store in exactly that shape surfaced as
 * `password authentication failed for user "harness_admin"` on the design-evidence
 * completion gate — an error that names the CREDENTIAL, so it reads as a rotation rather
 * than a stale handle, and it cost the fleet real time being argued about.
 *
 * No database: the property is about WHICH client is asked, which a stub observes exactly.
 */
import { describe, it, expect } from 'vitest';
import { createPgReferenceStore, type SqlTag } from './reference-store-pg';

/** A client that records that IT, specifically, was the one asked. */
function stubSql(label: string, log: string[]): SqlTag {
  return (<T = Record<string, unknown>>(
    _strings: TemplateStringsArray,
    ..._values: unknown[]
  ): Promise<T[]> => {
    log.push(label);
    return Promise.resolve([] as T[]);
  }) as SqlTag;
}

const SCOPE = { harnessSlug: 'papercusp', featureId: 'WI-1202547' };

describe('WI-1202547: createPgReferenceStore resolves its client per call', () => {
  it('CALIBRATION: the stub is actually reached, so a silent no-op cannot pass as success', async () => {
    const log: string[] = [];
    const store = createPgReferenceStore({ getSql: () => stubSql('only', log) });
    await store.listFeatureReferenceIds(SCOPE);
    expect(log).toEqual(['only']);
  });

  it('follows the client when it MOVES between calls (a captured handle fails this)', async () => {
    const log: string[] = [];
    // The seam the store is built on. Reassigning `handle` is the test's stand-in for the
    // admin endpoint moving underneath a long-lived, memoised deps bundle.
    let handle = stubSql('before-move', log);
    const store = createPgReferenceStore({ getSql: () => handle });

    await store.listFeatureReferenceIds(SCOPE);
    handle = stubSql('after-move', log);
    await store.listFeatureReferenceIds(SCOPE);

    // A store that captured at construction would log ['before-move', 'before-move'] —
    // still green on every other assertion in the suite, and wrong in the one way that
    // took down work_items:complete.
    expect(log).toEqual(['before-move', 'after-move']);
  });

  it('CONTROL: the PRE-FIX captured shape genuinely FAILS this property', async () => {
    // Falsifiability, kept permanently rather than proven once by mutating the shared tree
    // (CLAUDE.md puts an imported module at that tier). Without this, the assertion above
    // could be passing for a reason that has nothing to do with re-resolution — a reader
    // has no way to know the moving-`handle` instrument can distinguish the two shapes at
    // all. This reproduces the exact pre-fix construction and shows it cannot follow.
    const log: string[] = [];
    let handle = stubSql('before-move', log);

    // VERBATIM the old shape: resolve ONCE at construction, then close over the handle.
    const capturedStore = ((sql: SqlTag) => ({
      listFeatureReferenceIds: () => sql`SELECT 1`,
    }))(handle);

    await capturedStore.listFeatureReferenceIds();
    handle = stubSql('after-move', log);
    await capturedStore.listFeatureReferenceIds();

    // Still talking to the client that no longer applies — the production failure, in two lines.
    expect(log).toEqual(['before-move', 'before-move']);
    expect(log).not.toContain('after-move');
  });

  it('re-resolves for EVERY method, not just the one that happened to be tested', async () => {
    // The adapter is built once in createPgReferenceStore and shared by all methods, so
    // this is what makes that a property of the STORE rather than of listFeatureReferenceIds.
    // A future method added without per-call resolution is caught here.
    const log: string[] = [];
    let handle = stubSql('first', log);
    const store = createPgReferenceStore({ getSql: () => handle });

    await store.listFeatureReferenceIds(SCOPE);
    handle = stubSql('second', log);
    await store.listRevisions({ ...SCOPE, referenceId: 'ref-1' });
    handle = stubSql('third', log);
    await store.listEvidence({ ...SCOPE, referenceId: 'ref-1' });

    expect(log).toEqual(['first', 'second', 'third']);
  });

  it('retries a read after a connect-phase timeout, then returns the query result', async () => {
    const log: string[] = [];
    let attempts = 0;
    const store = createPgReferenceStore({
      getSql: () => (<T = Record<string, unknown>>(
        _strings: TemplateStringsArray,
        ..._values: unknown[]
      ): Promise<T[]> => {
        attempts += 1;
        if (attempts === 1) {
          const error = Object.assign(new Error('write CONNECT_TIMEOUT localhost:5432'), {
            code: 'CONNECT_TIMEOUT',
          });
          return Promise.reject(error);
        }
        log.push('read-succeeded');
        return Promise.resolve([{ reference_id: 'ref-a' }] as T[]);
      }) as SqlTag,
    });

    await expect(store.listFeatureReferenceIds(SCOPE)).resolves.toEqual(['ref-a']);
    expect(attempts).toBe(2);
    expect(log).toEqual(['read-succeeded']);
  });

  it('does not retry a non-connect query error', async () => {
    let attempts = 0;
    const store = createPgReferenceStore({
      getSql: () => (<T = Record<string, unknown>>(
        _strings: TemplateStringsArray,
        ..._values: unknown[]
      ): Promise<T[]> => {
        attempts += 1;
        return Promise.reject(Object.assign(new Error('permission denied'), { code: '42501' }));
      }) as SqlTag,
    });

    await expect(store.listFeatureReferenceIds(SCOPE)).rejects.toMatchObject({ code: '42501' });
    expect(attempts).toBe(1);
  });
});
