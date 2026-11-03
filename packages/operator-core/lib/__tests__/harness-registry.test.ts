import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable fixtures the mocks read/write.
type RegistryPayload = { projects: unknown[] } & Record<string, unknown>;
let prevState: RegistryPayload | null = null;
const writes: Array<{ table: string; payload: RegistryPayload; ws?: string }> = [];
const auditParams: unknown[][] = [];

vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => 'default' }));

// notifyRegistryChanged() fans out through sync-sse's pg_notify on the org pool,
// which the getOrgPg mock below models only for the audit write's `sql.unsafe`.
vi.mock('../sync-sse', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sync-sse')>()),
  notifySyncInvalidate: vi.fn(async () => {}),
}));

vi.mock('../operator-state-pg', () => ({
  readOperatorState: async () => prevState,
  writeOperatorState: async (table: string, payload: RegistryPayload, ws?: string) => {
    writes.push({ table, payload, ws });
  },
  // Emulates the FOR UPDATE read-mutate-upsert tx: mutate the committed
  // value, commit the result, surface it as a write.
  updateOperatorState: async (
    table: string,
    defaultValue: RegistryPayload,
    mutator: (cur: RegistryPayload) => RegistryPayload,
    ws?: string,
  ) => {
    const next = mutator(prevState ?? defaultValue);
    prevState = next;
    writes.push({ table, payload: next, ws });
    return next;
  },
}));

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({
    sql: {
      unsafe: async (_q: string, params: unknown[]) => {
        auditParams.push(params);
      },
    },
  }),
}));

import { dedupeProjectsBySlug, mutateHarnessRegistry, saveHarnessRegistry } from '../harness-registry';

beforeEach(() => {
  prevState = null;
  writes.length = 0;
  auditParams.length = 0;
});

describe('saveHarnessRegistry — catastrophic-empty guard', () => {
  it('throws (and never writes) when emptying a populated registry without allowEmpty', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }, { slug: 'b', path: '/b' }] };
    await expect(saveHarnessRegistry({ projects: [] })).rejects.toThrow(/allowEmpty/);
    expect(writes).toHaveLength(0);
  });

  it('allows emptying with { allowEmpty: true }', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({ projects: [] }, undefined, { allowEmpty: true });
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.projects).toHaveLength(0);
  });

  it('allows growing a registry (guard only targets populated→empty)', async () => {
    prevState = { projects: [] };
    await saveHarnessRegistry({ projects: [{ slug: 'a', path: '/a' }] });
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.projects).toHaveLength(1);
  });

  it('allows an already-empty registry to stay empty', async () => {
    prevState = { projects: [] };
    await saveHarnessRegistry({ projects: [] });
    expect(writes).toHaveLength(1);
  });
});

describe('saveHarnessRegistry — audit trail', () => {
  it('reports read, write, audit and notification boundaries in order', async () => {
    prevState = { projects: [] };
    const progress: string[] = [];
    await saveHarnessRegistry({ projects: [{ slug: 'a', path: '/a' }] }, undefined,
      { onProgress: stage => progress.push(stage) });
    expect(progress).toEqual([
      'read-start', 'read-complete', 'write-start', 'write-complete',
      'audit-start', 'audit-complete', 'notification-start', 'notification-complete',
    ]);
  });

  it('emits a harness_registry.write audit row when the count changes', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({
      projects: [{ slug: 'a', path: '/a' }, { slug: 'b', path: '/b' }],
    });
    expect(auditParams).toHaveLength(1);
    // params order: [id, ts, actor, action, subject, detailsJson, ws]
    const p = auditParams[0];
    expect(p[3]).toBe('harness_registry.write');
    expect(p[6]).toBe('default');
    const details = JSON.parse(p[5] as string) as Record<string, number>;
    expect(details).toMatchObject({ prevCount: 1, nextCount: 2, delta: 1 });
  });

  it('does not audit when the project count is unchanged', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({ projects: [{ slug: 'a', path: '/moved' }] });
    expect(writes).toHaveLength(1);
    expect(auditParams).toHaveLength(0);
  });
});

describe('saveHarnessRegistry — sibling-field preservation', () => {
  it('persists hiveDirectoryMeta (was silently dropped on every save)', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({
      projects: [{ slug: 'a', path: '/a' }],
      hiveDirectoryMeta: { h1: { potId: 'h1', title: 'Hive', description: '', visibility: 'public', memberTopics: [], createdAt: 1 } },
    } as never);
    expect(writes[0].payload.hiveDirectoryMeta).toBeTruthy();
  });
});

describe('mutateHarnessRegistry — atomic RMW (audit P-006 / EI-82)', () => {
  it('mutates from the CURRENT committed value, not a stale snapshot', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    // First mutator adds b; second removes a. Each must see the prior commit —
    // the lost-update shape would leave a in place or drop b.
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: [...reg.projects, { slug: 'b', path: '/b' }],
    }));
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: reg.projects.filter((p) => p.slug !== 'a'),
    }));
    expect(prevState!.projects).toEqual([{ slug: 'b', path: '/b' }]);
  });

  it('enforces the catastrophic-empty guard inside the transaction', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    const before = writes.length;
    await expect(
      mutateHarnessRegistry(() => ({ projects: [] })),
    ).rejects.toThrow(/allowEmpty/);
    // The throwing mutator still ran through updateOperatorState's mutator,
    // but a real PG tx rolls back — here we just assert it threw before any
    // post-commit bookkeeping (no audit row).
    expect(auditParams).toHaveLength(0);
    expect(writes.length).toBe(before); // mock writes only after mutator returns
  });

  it('allows emptying with { allowEmpty: true } and audits the change', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await mutateHarnessRegistry(() => ({ projects: [] }), undefined, { allowEmpty: true });
    expect(prevState!.projects).toHaveLength(0);
    expect(auditParams).toHaveLength(1);
    const details = JSON.parse(auditParams[0][5] as string) as Record<string, number>;
    expect(details).toMatchObject({ prevCount: 1, nextCount: 0, delta: -1 });
  });

  it('preserves hiveControlFrames + hiveDirectoryMeta through a projects-only mutation', async () => {
    prevState = {
      projects: [{ slug: 'a', path: '/a' }],
      hiveControlFrames: { hv: { id: 'f1' } },
      hiveDirectoryMeta: { hv: { potId: 'hv', createdAt: 1 } },
    };
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: [...reg.projects, { slug: 'b', path: '/b' }],
    }));
    expect(prevState!.hiveControlFrames).toBeTruthy();
    expect(prevState!.hiveDirectoryMeta).toBeTruthy();
    expect(prevState!.projects).toHaveLength(2);
  });
});

/**
 * Gap 2 — registry slug-uniqueness invariant (the store-layer guard).
 * `slug` is the registry's primary key: every insert path guards with
 * `some(p=>p.slug===…)` and every update replaces in place, so a duplicate
 * slug is always a caller bug — and one makes the ubiquitous downstream
 * `find(p=>p.slug===…)` non-deterministic. `dedupeProjectsBySlug` enforces the
 * invariant at the write boundary (last-write-wins) so a buggy/future caller
 * can never persist two rows for one slug.
 */
describe('dedupeProjectsBySlug — uniqueness invariant (pure)', () => {
  it('returns the SAME reference when there is no duplicate (common case pays nothing)', () => {
    const input = [{ slug: 'a', path: '/a' }, { slug: 'b', path: '/b' }];
    expect(dedupeProjectsBySlug(input)).toBe(input);
  });

  it('collapses a duplicate slug LAST-WRITE-WINS, preserving surviving order', () => {
    const out = dedupeProjectsBySlug([
      { slug: 'a', path: '/old-a' },
      { slug: 'b', path: '/b' },
      { slug: 'a', path: '/new-a' },
    ]);
    expect(out).toEqual([
      // 'a' survives at its LAST position with the LAST value; 'b' keeps its slot.
      { slug: 'b', path: '/b' },
      { slug: 'a', path: '/new-a' },
    ]);
  });

  it('reports each collapsed slug via onCollapse', () => {
    const collapsed: string[] = [];
    dedupeProjectsBySlug(
      [{ slug: 'a', path: '/1' }, { slug: 'a', path: '/2' }, { slug: 'a', path: '/3' }],
      (s) => collapsed.push(s),
    );
    // Two earlier 'a' rows are collapsed (the last wins).
    expect(collapsed).toEqual(['a', 'a']);
  });
});

describe('registry write paths enforce slug uniqueness', () => {
  it('saveHarnessRegistry dedupes a duplicate slug before persisting (last wins) + warns', async () => {
    // The collapse is a caller-bug signal — it logs. Assert the warning
    // explicitly (the suite fails on unexpected console output otherwise).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await saveHarnessRegistry({
      projects: [{ slug: 'a', path: '/a' }, { slug: 'a', path: '/dup' }],
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].payload.projects).toEqual([{ slug: 'a', path: '/dup' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("collapsed duplicate slug 'a'"));
    warn.mockRestore();
  });

  it('mutateHarnessRegistry dedupes a duplicate slug the mutator returned (last wins, in-tx) + warns', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    // A buggy mutator that appends a second {slug:'a'} instead of guarding.
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: [...reg.projects, { slug: 'a', path: '/dup' }],
    }));
    expect(prevState!.projects).toEqual([{ slug: 'a', path: '/dup' }]);
    // Count is unchanged (1 → 1 after collapse), so no spurious audit row.
    expect(auditParams).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("collapsed duplicate slug 'a'"));
    warn.mockRestore();
  });

  it('mutateHarnessRegistry still grows the registry for a genuinely new slug', async () => {
    prevState = { projects: [{ slug: 'a', path: '/a' }] };
    await mutateHarnessRegistry((reg) => ({
      ...reg,
      projects: [...reg.projects, { slug: 'b', path: '/b' }],
    }));
    expect(prevState!.projects).toEqual([
      { slug: 'a', path: '/a' },
      { slug: 'b', path: '/b' },
    ]);
    expect(auditParams).toHaveLength(1);
  });
});
