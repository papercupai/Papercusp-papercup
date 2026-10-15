/**
 * scope-unique-identifiers-2026-07-26 P-005 — feature-family ids must not be
 * numbered per harness.
 *
 * F-FIX (promote-issue.ts) and F-IDEA (brainstorm route) used to be
 * MAX(existing) + 1 over ONE harness's rows, so every harness of a workspace
 * minted F-FIX-001 — measured live twins F-FIX-001 (hiveloop-hive / papercusp)
 * and F-FIX-008 (papercup / papercusp). These tests pin the replacement:
 * a time + random tail that needs no row scan, keeps the `F-` prefix every
 * feature-id validator expects, and never repeats across harnesses.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ statements: [] as string[], harnesses: [] as string[] }));

vi.mock('@papercusp/db-org', () => ({
  harnessQuery: async (slug: string, fn: (sql: unknown) => Promise<unknown>) => {
    h.harnesses.push(slug);
    const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      h.statements.push(strings.join('?') + ' | ' + JSON.stringify(values));
      return [];
    };
    return fn(sql);
  },
}));
vi.mock('./feature-audit', () => ({ auditFeatureChange: () => undefined }));
vi.mock('./harness-issues', () => ({ loadIssuesOrSeed: async () => [], saveIssues: async () => undefined }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));

const { newCollisionResistantIdTail, newFeatureId } = await import('./collision-resistant-id');
const { mintFixFeatureRow } = await import('./promote-issue');

/** The validators readers apply to feature ids (operator-notes.ts, FeatureEditor). */
const FEATURE_ID_VALIDATOR = /^F-[A-Z0-9-]+$/;

describe('newFeatureId / newCollisionResistantIdTail', () => {
  it('mints F-<KIND>-<digits> that every feature-id validator accepts', () => {
    for (const kind of ['FIX', 'IDEA']) {
      const id = newFeatureId(kind);
      expect(id).toMatch(new RegExp(`^F-${kind}-\\d+$`));
      expect(id).toMatch(FEATURE_ID_VALIDATOR);
    }
  });

  it('keeps a burst of mints in ONE millisecond distinct up to the 20-bit birthday bound', () => {
    // Pin the clock so every draw really shares one millisecond; otherwise the
    // burst spreads over a machine-dependent number of ms and the test measures
    // the runner's speed instead of the id's entropy.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 11, 9, 0, 0));
    try {
      const ids = new Set(Array.from({ length: 2000 }, () => newFeatureId('FIX')));
      // Birthday bound: 2000 draws from 2^20 values give C(2000,2)/2^20 ≈ 1.9
      // expected colliding pairs, so a handful of repeats is NORMAL (a floor of
      // 1998 failed ~30% of one-ms bursts — WI-6554700010008506). Losing 20+ ids
      // has probability ≈ 1e-14. A per-harness counter or a zero-entropy tail
      // produces exactly ONE distinct value here, so this floor still separates
      // them by three orders of magnitude.
      expect(ids.size).toBeGreaterThanOrEqual(1980);
    } finally {
      now.mockRestore();
    }
  });

  it('fits a signed 64-bit integer for two centuries and orders by time', () => {
    // The tail is NOT a JS-safe integer (it passed 2^53 within days of the epoch),
    // so readers must treat it as a string; it only has to fit Postgres bigint.
    const in200Years = Date.UTC(2226, 0, 1);
    const tail = BigInt(newCollisionResistantIdTail(in200Years));
    expect(tail < 2n ** 63n).toBe(true);
    expect(BigInt(newCollisionResistantIdTail(in200Years + 1000)) > tail).toBe(true);
  });

  it('rejects a kind that would break the F- id shape', () => {
    expect(() => newFeatureId('fix')).toThrow(/uppercase tag/);
    expect(() => newFeatureId('FIX-1')).toThrow(/uppercase tag/);
  });
});

describe('mintFixFeatureRow (promote-issue.ts)', () => {
  beforeEach(() => {
    h.statements.length = 0;
    h.harnesses.length = 0;
  });

  const issue = {
    id: 'EI-1',
    title: 'broken thing',
    severity: 'major',
    source: 'validator',
    foundAt: '2026-10-10T00:00:00.000Z',
    status: 'open',
    attempts: 0,
    notes: [],
    codePointer: 'lib/x.ts:12',
  } as never;

  it('mints distinct F-FIX ids for two harnesses of one workspace without scanning existing rows', async () => {
    const a = await mintFixFeatureRow({ slug: 'harness-a' } as never, issue, { workspaceId: 'ws-1' });
    const b = await mintFixFeatureRow({ slug: 'harness-b' } as never, issue, { workspaceId: 'ws-1' });

    expect(a.id).toMatch(/^F-FIX-\d+$/);
    expect(b.id).toMatch(/^F-FIX-\d+$/);
    expect(a.id).not.toBe(b.id);
    expect(h.harnesses).toEqual(['harness-a', 'harness-b']);

    // The old counter read `feature_id LIKE 'F-FIX-%'` over the harness's rows;
    // the only statements now are the INSERTs (no foundDuring parent lookup).
    expect(h.statements.some((s) => /LIKE 'F-FIX-%'/.test(s))).toBe(false);
    expect(h.statements).toHaveLength(2);
    expect(h.statements[0]).toContain(a.id);
    expect(h.statements[0]).toContain('ws-1');
    expect(h.statements[1]).toContain(b.id);

    // The validation claim is named after the minted id.
    expect(a.claims).toEqual([`VAL-${a.id.slice(2)} @ lib/x.ts:12`]);
  });
});
