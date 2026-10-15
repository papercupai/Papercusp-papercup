import { describe, expect, it, vi } from 'vitest';
import {
  buildHarnessFeaturesProjection,
  normalizeTakenBy,
  _testing,
  type HarnessFeatureRow,
} from '../harness-features';
import { COLLISION_CREATED_AT_TOLERANCE_MS, isDistinctEntityCollision } from '../distinct-entity-collision';

function feature(over: Partial<HarnessFeatureRow> = {}): HarnessFeatureRow {
  return {
    harness_slug: 'sheets',
    feature_id: 'F-001',
    title: 'Auth flow',
    summary: 'JWT + session',
    status: 'in_queue',
    attempts: 0,
    claims: null,
    notes: null,
    metadata: { source: 'scoper' },
    kind: 'feature',
    project_id: null,
    expected_cost_cents: 500,
    tags: ['auth', 'security'],
    needs_human_review: false,
    ts: 1700000000000,
    created_ts: 1700000000000,
    updated_ts: 1700000010000,
    parent_id: null,
    goal_id: 'G-1',
    taken_by: null,
    taken_at: null,
    expires_at: null,
    ...over,
  };
}

describe('harness_features projection', () => {
  it('composeKey returns the feature_id', () => {
    expect(_testing.composeKey(feature())).toBe('F-001');
  });

  it('decodeValue accepts a valid row', () => {
    expect(_testing.decodeValue(feature())).toEqual(feature());
  });

  it('decodeValue accepts all nullable fields as null', () => {
    const r = feature({
      title: null, summary: null, status: null, attempts: null,
      claims: null, notes: null, kind: null, project_id: null,
      expected_cost_cents: null, needs_human_review: null,
      ts: null, created_ts: null, updated_ts: null, parent_id: null,
      goal_id: null, taken_by: null, taken_at: null, expires_at: null,
    });
    expect(_testing.decodeValue(r)).toEqual(r);
  });

  it('decodeValue rejects missing harness_slug', () => {
    const bad = { ...feature(), harness_slug: '' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects missing feature_id', () => {
    const bad = { ...feature(), feature_id: '' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects non-string status', () => {
    const bad = { ...feature(), status: 42 };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects non-number attempts', () => {
    const bad = { ...feature(), attempts: '5' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects non-bool needs_human_review', () => {
    const bad = { ...feature(), needs_human_review: 'yes' };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue rejects NaN ts', () => {
    const bad = { ...feature(), ts: NaN };
    expect(_testing.decodeValue(bad)).toBeNull();
  });

  it('decodeValue accepts arbitrary JSONB shapes for metadata + tags', () => {
    const r = feature({ metadata: null, tags: { complex: { nested: true } } });
    expect(_testing.decodeValue(r)).not.toBeNull();
    const r2 = feature({ metadata: ['array', 'of', 'strings'], tags: 'string' });
    expect(_testing.decodeValue(r2)).not.toBeNull();
  });

  it('decodeValue rejects null / non-object input', () => {
    expect(_testing.decodeValue(null)).toBeNull();
    expect(_testing.decodeValue('string')).toBeNull();
    expect(_testing.decodeValue(42)).toBeNull();
    expect(_testing.decodeValue([])).toBeNull();
  });

  it('buildHarnessFeaturesProjection exposes features-by-id tag', () => {
    const p = buildHarnessFeaturesProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.tableTag).toBe('features-by-id');
  });

  it('buildHarnessFeaturesProjection composeKey passes through', () => {
    const p = buildHarnessFeaturesProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.composeKey(feature({ feature_id: 'F-999' }))).toBe('F-999');
  });

  it('buildHarnessFeaturesProjection decodeValue passes through', () => {
    const p = buildHarnessFeaturesProjection({ workspaceId: 'w1', harnessSlug: 'sheets' });
    expect(p.decodeValue(feature())).toEqual(feature());
    expect(p.decodeValue({})).toBeNull();
  });

  // EI-7939: the "unassigned ⟺ taken_by IS NULL OR taken_by = ''" invariant every
  // claim floor relies on — enforced at the federation ingest boundary.
  it('EI-7939: normalizeTakenBy collapses empty-ish / `unassigned` placeholders to NULL and preserves a real holder', () => {
    // Placeholders → NULL (would otherwise starve the item on the claim floor AND
    // trip the P-013 orphan sweep into a false "dead holder" incident).
    expect(normalizeTakenBy('unassigned')).toBeNull();
    expect(normalizeTakenBy('UNASSIGNED')).toBeNull();
    expect(normalizeTakenBy('  unassigned  ')).toBeNull();
    expect(normalizeTakenBy('')).toBeNull();
    expect(normalizeTakenBy('   ')).toBeNull();
    expect(normalizeTakenBy(null)).toBeNull();
    expect(normalizeTakenBy(undefined)).toBeNull();
    // A real holder id passes through untouched.
    expect(normalizeTakenBy('su-6c0b54c0')).toBe('su-6c0b54c0');
    expect(normalizeTakenBy('improvement-runner')).toBe('improvement-runner');
  });

  it('EI-7939: writeToPg normalizes a `unassigned` placeholder taken_by to NULL on ingest (never persists the invariant-violating string)', async () => {
    const sql = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), {
      json: vi.fn((x: unknown) => ({ __json: x })),
    });
    const p = buildHarnessFeaturesProjection({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'sheets', // own-slug op — member-content guard short-circuits to 'apply'
      sql: sql as never,
    });
    await p.writeToPg(feature({ taken_by: 'unassigned' }), { origin: 'remote', authorPubkey: '' });
    // P-012: the resident-row read, then the INSERT.
    expect(sql).toHaveBeenCalledTimes(2);
    const values = insertValues(sql);
    // The invariant-violating placeholder never reaches the bound INSERT values —
    // EXCLUDED.taken_by (and thus the ON CONFLICT UPDATE + LWW digest) inherit NULL.
    expect(values).not.toContain('unassigned');
  });

  it('EI-7939: writeToPg preserves a REAL holder id on ingest', async () => {
    const sql = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), {
      json: vi.fn((x: unknown) => ({ __json: x })),
    });
    const p = buildHarnessFeaturesProjection({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'sheets',
      sql: sql as never,
    });
    await p.writeToPg(feature({ taken_by: 'su-real-agent-7f3a' }), { origin: 'remote', authorPubkey: '' });
    const values = insertValues(sql);
    expect(values).toContain('su-real-agent-7f3a');
  });

  it('WI-1612: writeToPg ALWAYS binds workspace_id explicitly on the INSERT — never left NULL for the incomplete fill_ws_features_trg fallback', async () => {
    const sql = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), {
      json: vi.fn((x: unknown) => ({ __json: x })),
    });
    const p = buildHarnessFeaturesProjection({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'sheets', // own-slug op — member-content guard short-circuits to 'apply'
      sql: sql as never,
    });
    await p.writeToPg(feature(), { origin: 'local', authorPubkey: '' });
    expect(sql).toHaveBeenCalledTimes(2);
    const values = insertValues(sql);
    // workspace_id is the FIRST bound column in the INSERT (see writeToPg).
    expect(values[0]).toBe('papercusp-workspace');
  });

  it('P-012: refuses an op whose id the workspace already keeps under another harness, instead of minting a twin', async () => {
    const sql = sqlHolding([{ harness_slug: 'papercusp', created_ts: 1700000000000 }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = buildHarnessFeaturesProjection({
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'sheets',
        sql: sql as never,
      });
      await p.writeToPg(feature({ feature_id: 'WI-385' }), {
        origin: 'remote', authorPubkey: 'carried-author', sourceLogKeyHex: 'resident-source-log',
      });
      const read = sql.mock.calls.find((c) => statementText(c[0]).includes('SELECT harness_slug, created_ts'))!;
      const [strings, ...values] = read as unknown as [TemplateStringsArray, ...unknown[]];
      expect(statementText(strings)).not.toContain('INSERT');
      // The one read is scoped to this workspace and this id, under every harness.
      expect(values).toEqual(['papercusp-workspace', 'WI-385']);
      const counters = sql.mock.calls.filter((c) => statementText(c[0]).includes('INSERT INTO harness_shared.federation_refused_op_counters'));
      expect(counters).toHaveLength(1);
      expect(sql.mock.calls.some((c) => statementText(c[0]).includes('INSERT INTO harness_shared.work_items'))).toBe(false);
      expect(counters[0].slice(1)).toEqual([
        'papercusp-workspace', 'sheets', 'resident-source-log', 'features-by-id', 'resident-row-collision',
      ]);
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('P-012 resident-row refusal: feature_id=WI-385');
    } finally {
      warn.mockRestore();
    }
  });

  // scope-unique-identifiers-2026-07-26 P-015 (D-019): the same-harness upsert is the
  // ON CONFLICT target, so without this check a federated op for a DIFFERENT item that
  // shares the WI- id (the D-005/D-006 residue) would overwrite the local item.
  it('P-015: refuses a same-harness op whose created_ts names a DIFFERENT local item, and never upserts', async () => {
    const sql = sqlHolding([{ harness_slug: 'sheets', created_ts: '1700000000000' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const p = buildHarnessFeaturesProjection({
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'sheets',
        sql: sql as never,
      });
      // One hour apart: a different item allocated the same id, not a re-delivery.
      await p.writeToPg(feature({ feature_id: 'WI-10000294', created_ts: 1700003600000 }), {
        origin: 'remote', authorPubkey: 'distinct-source-log',
      });
      expect(sql.mock.calls.some((c) => statementText(c[0]).includes('INSERT INTO harness_shared.work_items'))).toBe(false);
      const counters = sql.mock.calls.filter((c) => statementText(c[0]).includes('INSERT INTO harness_shared.federation_refused_op_counters'));
      expect(counters).toHaveLength(1);
      expect(counters[0].slice(1)).toEqual([
        'papercusp-workspace', 'sheets', 'distinct-source-log', 'features-by-id', 'distinct-entity-collision',
      ]);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('P-015 distinct-entity refusal: feature_id=WI-10000294');
      expect(logged).toContain('2023-11-14T22:13:20.000Z');
    } finally {
      warn.mockRestore();
    }
  });

  it('P-015: a genuine re-delivery of the SAME item (created_ts within the 5s tolerance) still lands', async () => {
    const sql = sqlHolding([{ harness_slug: 'sheets', created_ts: '1700000000000' }]);
    const p = buildHarnessFeaturesProjection({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'sheets',
      sql: sql as never,
    });
    await p.writeToPg(feature({ feature_id: 'WI-10000294', created_ts: 1700000004000 }), { origin: 'remote', authorPubkey: '' });
    expect(insertValues(sql)).toContain('WI-10000294');
    expect(sql.mock.calls.some((c) => statementText(c[0]).includes('federation_refused_op_counters'))).toBe(false);
  });

  it('P-015 / WI-6327: an op or a stored row without created_ts cannot be judged and fails open', async () => {
    for (const [incoming, stored] of [[null, '1700000000000'], [1700003600000, null]] as const) {
      const sql = sqlHolding([{ harness_slug: 'sheets', created_ts: stored }]);
      const p = buildHarnessFeaturesProjection({
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'sheets',
        sql: sql as never,
      });
      await p.writeToPg(feature({ feature_id: 'WI-10000680', created_ts: incoming }), { origin: 'remote', authorPubkey: '' });
      expect(insertValues(sql)).toContain('WI-10000680');
    }
  });

  it('P-015: isDistinctEntityCollision is one shared check with a 5s tolerance (engineer-issues uses the same module)', () => {
    expect(COLLISION_CREATED_AT_TOLERANCE_MS).toBe(5_000);
    expect(isDistinctEntityCollision(1700000005000, 1700000000000)).toEqual({ collided: false });
    expect(isDistinctEntityCollision(1700000005001, 1700000000000)).toEqual({
      collided: true,
      existingCreatedAtIso: '2023-11-14T22:13:20.000Z',
    });
    expect(isDistinctEntityCollision(Number.NaN, 1700000000000)).toEqual({ collided: false });
    expect(isDistinctEntityCollision(1700000000000, Number('not-a-number'))).toEqual({ collided: false });
  });

  it('P-012: an op whose id no other harness holds in the workspace is written', async () => {
    const sql = Object.assign(vi.fn(async (..._a: unknown[]) => [] as unknown[]), {
      json: vi.fn((x: unknown) => ({ __json: x })),
    });
    const p = buildHarnessFeaturesProjection({
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'sheets',
      sql: sql as never,
    });
    await p.writeToPg(feature({ feature_id: 'WI-386' }), { origin: 'remote', authorPubkey: '' });
    expect(insertValues(sql)).toContain('WI-386');
  });
});

/** A fake `sql` whose existing-row read (the only SELECT writeToPg issues) returns `rows`. */
function sqlHolding(rows: Array<{ harness_slug: string; created_ts: string | number | null }>) {
  return Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ..._a: unknown[]) =>
      statementText(strings).includes('SELECT harness_slug, created_ts') ? rows : [],
    ),
    { json: vi.fn((x: unknown) => ({ __json: x })) },
  );
}

function statementText(strings: TemplateStringsArray | unknown): string {
  return Array.isArray(strings) ? (strings as readonly string[]).join('?') : String(strings);
}

/** Bound values of the one INSERT writeToPg issued (the resident-row read precedes it). */
function insertValues(sql: { mock: { calls: unknown[][] } }): unknown[] {
  const inserts = sql.mock.calls.filter((c) => statementText(c[0]).includes('INSERT INTO harness_shared.work_items'));
  expect(inserts).toHaveLength(1);
  return inserts[0]!.slice(1);
}
