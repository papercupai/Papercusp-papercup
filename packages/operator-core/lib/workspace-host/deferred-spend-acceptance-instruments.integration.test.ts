/** Source controls over the real PG artifact store; no provider or live acceptance evidence. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { deferredSpendAcceptanceFixture } from './deferred-spend-acceptance-fixtures';
import { DEFERRED_SPEND_INSTRUMENT_KEYS as keys, measureDeferredSpendAcceptance } from './deferred-spend-acceptance-instruments';
import { deferredSpendFingerprint } from './deferred-spend-acceptance-contract';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';

const h = vi.hoisted(() => ({ db: undefined as unknown, sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async orig => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => h,
}));
vi.mock('../harness-registry', async orig => ({
  ...await orig<typeof import('../harness-registry')>(), loadHarnessRegistry: async () => ({ projects: [] }),
}));
vi.mock('../sync-sse', async orig => ({
  ...await orig<typeof import('../sync-sse')>(), notifySyncInvalidate: vi.fn(async () => {}),
}));
vi.mock('../workspace-registry', async orig => ({
  ...await orig<typeof import('../workspace-registry')>(), activeWorkspaceId: () => 'ws',
}));
const { loadTextArtifact, saveTextArtifact } = await import('../text-artifacts');
let db: OrgTestDb;
beforeAll(async () => {
  db = await createOrgTestDb(); h.db = drizzle(db.adminSql); h.sql = db.adminSql;
}, 90_000);
afterAll(async () => { await db?.cleanup(); });

describe('DS-P010-DISTINCT-OBSERVATIONS retained-read and PG integration', () => {
  it.each(['unknown', 'fail'] as const)('retains independent R008 %s with both keys referencing the same complete durable manifest', async verdict => {
    const f = deferredSpendAcceptanceFixture();
    if (verdict === 'fail') f.records.operations.push(f.row('03-prohibited', 'original', 'provision'));
    const measure = vi.fn(async () => measureDeferredSpendAcceptance(f.request, { read: f.read }));
    const snapshots = await resolveScorecardInstrumentSnapshots({ rubric: f.rubric, subject: f.subject }, { deferredSpend: measure });
    expect(measure).toHaveBeenCalledTimes(1);
    expect(snapshots?.[keys.r007]?.verdict).toBe('pass');
    expect(snapshots?.[keys.r008]?.verdict).toBe(verdict);
    const ref = snapshots?.[keys.r007]?.evidenceRef;
    expect(ref).toMatch(/^artifact:papercusp:evidence\/deferred-spend\/[a-f0-9]{64}\.json$/);
    expect(snapshots?.[keys.r008]?.evidenceRef).toBe(ref);
    const path = ref!.replace('artifact:papercusp:', '');
    const stored = JSON.parse((await loadTextArtifact('papercusp', path))!);
    expect(path).toBe('evidence/deferred-spend/' + deferredSpendFingerprint(stored) + '.json');
    expect(stored.criteria.r007.verdict).toBe('pass'); expect(stored.criteria.r008.verdict).toBe(verdict);
    expect(stored.source.snapshot.identity.subject.kind).toBe('source');
    expect(stored.source.derivation).toMatchObject({ state: 'unjoined', outputIdentity: null });
    expect(f.hostReads).toHaveBeenCalledTimes(1); expect(f.actionReads).toHaveBeenCalledTimes(1);
  });
  it('counterexample: a conflicting durable manifest makes both observations UNKNOWN and preserves the stored bytes', async () => {
    const f = deferredSpendAcceptanceFixture();
    const first = await measureDeferredSpendAcceptance(f.request, { read: f.read });
    const path = first.manifestRef!.replace('artifact:papercusp:', '');
    await saveTextArtifact('papercusp', path, 'conflicting manifest');
    const result = await measureDeferredSpendAcceptance(f.request, { read: f.read });
    expect(result.criteria.r007.verdict).toBe('unknown'); expect(result.criteria.r008.verdict).toBe('unknown');
    expect(result.manifestRef).toBeUndefined();
    expect(await loadTextArtifact('papercusp', path)).toBe('conflicting manifest');
  });
});
