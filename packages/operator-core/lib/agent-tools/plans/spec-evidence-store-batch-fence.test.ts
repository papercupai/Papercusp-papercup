import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// listSpecEvidence fences a whole batch of bindings with one lock-queue read per
// repository before the reads and one after, instead of two per binding (a ~233-binding
// plan issued 466 reads per call and pushed the GOAL portfolio read past its 900ms
// budget). These pin both halves: the read count, and that a probe still fails exactly
// the bindings it overlaps.

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  measurementRoot: '',
  activeLocks: [] as Array<{ coordinationDomain: string; path: string; intent: string }>,
  // Locks that appear only from the Nth readQueue call on: a probe starting mid-batch.
  lateLocks: null as null | { fromCall: number; locks: Array<{ coordinationDomain: string; path: string; intent: string }> },
  calls: [] as Array<{ coordinationDomain: string; paths: string[]; includeWaiting: boolean }>,
  failNextRead: false,
}));

vi.mock('../locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(async (_pool: unknown, args: { coordinationDomain: string; paths: string[]; includeWaiting?: boolean }) => {
    h.calls.push({
      coordinationDomain: args.coordinationDomain,
      paths: [...args.paths].sort(),
      includeWaiting: args.includeWaiting ?? true,
    });
    if (h.failNextRead) {
      h.failNextRead = false;
      throw new Error('lock queue unavailable');
    }
    const late = h.lateLocks && h.calls.length >= h.lateLocks.fromCall ? h.lateLocks.locks : [];
    // The store's SQL lock_path_overlaps, written out independently of the code under test.
    const overlaps = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    return {
      active_locks: [...h.activeLocks, ...late]
        .filter((lock) => lock.coordinationDomain === args.coordinationDomain
          && args.paths.some((path) => overlaps(lock.path, path)))
        .map((lock) => ({ coordination_domain: lock.coordinationDomain, path: lock.path, intent: lock.intent })),
      waiting: [],
      completed: [],
    };
  }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: unknown) => Promise<T>) => {
      const tx = ((strings: TemplateStringsArray | string[]) =>
        Promise.resolve(Array.from(strings).join(' ').includes('provisional') ? [] : h.rows)) as unknown;
      return fn(tx);
    },
  };
});

vi.mock('./source', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./source')>();
  return { ...actual, resolvePlanScope: async () => ({ workspaceId: 'workspace-test', harnessSlug: 'papercusp' }) };
});

vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness-registry')>();
  return { ...actual, loadHarnessRegistry: async () => ({}) as never, resolveHarnessContentPath: () => h.measurementRoot };
});

const { listSpecEvidence, lockPathOverlaps } = await import('./spec-evidence-store');

let root: string;
let nestedRoot: string;

function binding(id: number, sourcePaths: string[]): Record<string, unknown> {
  return {
    id,
    work_item_id: `WI-${id}`,
    plan_slug: 'plan-one',
    spec_id: `SPEC-001-0${id}`,
    source_val_id: `VAL-001-0${id}`,
    spec_revision: 1,
    current_revision: 1,
    spec_fingerprint: 'sha256:spec-v1',
    evidence_kind: 'test',
    evidence_ref: `vitest:binding-${id}`,
    source_fingerprint: 'sha256:graded',
    test_fingerprint: null,
    fixture_fingerprint: null,
    rubric_fingerprint: null,
    environment_fingerprint: null,
    coverage_evidence_ref: null,
    coverage_evidence_present: false,
    test_run_id: null,
    test_run_present: false,
    details: { currentMeasurement: { schemaVersion: 1, kind: 'repo-files', sourcePaths } },
    observed_at: '2026-08-20 17:10:00-04',
    binding_fingerprint: `sha256:binding-${id}`,
    created_by: 'su-test',
    created_at: '2026-08-20T21:10:01.000Z',
    spec_is_current: true,
  };
}

const list = () => listSpecEvidence({ harnessSlug: 'papercusp', planSlugs: ['plan-one'] });

beforeEach(() => {
  root = resolve(mkdtempSync(join(tmpdir(), 'spec-evidence-batch-fence-')));
  nestedRoot = join(root, 'libs', 'papercusp');
  mkdirSync(join(root, '.git'));
  mkdirSync(nestedRoot, { recursive: true });
  writeFileSync(join(nestedRoot, '.git'), 'gitdir: ../.git/modules/papercusp\n');
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'b.ts'), 'export const b = 1;\n');
  writeFileSync(join(nestedRoot, 'c.ts'), 'export const c = 1;\n');
  h.measurementRoot = root;
  h.rows = [binding(1, ['a.ts']), binding(2, ['b.ts', 'a.ts']), binding(3, ['libs/papercusp/c.ts'])];
  h.activeLocks = [];
  h.lateLocks = null;
  h.calls = [];
  h.failNextRead = false;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('lockPathOverlaps mirrors the lock store SQL', () => {
  it('matches the newest lock_path_overlaps definition', () => {
    const dir = fileURLToPath(new URL('../../../../../libs/papercusp/packages/locks/src/sql/', import.meta.url));
    const definitions = readdirSync(dir)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) => readFileSync(join(dir, name), 'utf8'))
      .filter((text) => /FUNCTION\s+lock_path_overlaps\s*\(/.test(text));
    // Positive control: an empty scan would make the comparison below vacuous.
    expect(definitions.length).toBeGreaterThan(0);
    const latest = definitions.at(-1) ?? '';
    const body = latest.slice(latest.search(/FUNCTION\s+lock_path_overlaps\s*\(/)).split('$func$')[1] ?? '';
    // If this fails the SQL semantics moved: update lockPathOverlaps to match, then this.
    expect(body.replace(/\s+/g, ' ').trim()).toBe(
      "SELECT p_left = p_right OR left(p_left, length(p_right) + 1) = p_right || '/' OR left(p_right, length(p_left) + 1) = p_left || '/'",
    );
  });

  it('is equality or a directory prefix in either direction', () => {
    expect(lockPathOverlaps('a/b.ts', 'a/b.ts')).toBe(true);
    expect(lockPathOverlaps('a', 'a/b.ts')).toBe(true);
    expect(lockPathOverlaps('a/b.ts', 'a')).toBe(true);
    expect(lockPathOverlaps('a/b', 'a/bc.ts')).toBe(false);
    expect(lockPathOverlaps('a/b.ts', 'a/b.tsx')).toBe(false);
  });
});

describe('listSpecEvidence batch mutation-probe fence', () => {
  it('fences the batch with one pre- and one post-read per repository, not two per binding', async () => {
    const rows = await list();

    expect(rows.map((row) => (row as { serverMeasurement?: { status: string } }).serverMeasurement?.status))
      .toEqual(['measured', 'measured', 'measured']);
    const union = [
      { coordinationDomain: root, paths: ['a.ts', 'b.ts'], includeWaiting: false },
      { coordinationDomain: nestedRoot, paths: ['c.ts'], includeWaiting: false },
    ];
    expect(h.calls).toHaveLength(4);
    expect(h.calls.slice(0, 2)).toEqual(expect.arrayContaining(union));
    expect(h.calls.slice(2)).toEqual(expect.arrayContaining(union));
  });

  it('a probe that locks mid-batch fails exactly the bindings it overlaps', async () => {
    // Calls 1-2 are the clean pre-read union; from call 3 (post-read) a probe holds b.ts.
    h.lateLocks = { fromCall: 3, locks: [{ coordinationDomain: root, path: 'b.ts', intent: 'mutation probe' }] };

    const rows = await list();
    const status = rows.map((row) => (row as { serverMeasurement?: { status: string; reason?: string } }).serverMeasurement);

    expect(status[0]?.status).toBe('measured');
    expect(status[1]).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining(`repo_measurement_mutation_probe_active:${root}:b.ts`),
    });
    expect(status[2]?.status).toBe('measured');
  });

  it('a probe live before the reads fails only the bindings it overlaps, with no per-binding reads', async () => {
    // Live mutation probes are routine on this fleet; one must not cost every binding its
    // own lock-queue round trips.
    h.activeLocks = [{ coordinationDomain: nestedRoot, path: 'c.ts', intent: 'mutation probe' }];

    const rows = await list();
    const status = rows.map((row) => (row as { serverMeasurement?: { status: string; reason?: string } }).serverMeasurement);

    expect(status[0]?.status).toBe('measured');
    expect(status[1]?.status).toBe('measured');
    expect(status[2]).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining(`repo_measurement_mutation_probe_active:${nestedRoot}:c.ts`),
    });
    expect(h.calls).toHaveLength(4);
  });

  it('a directory-level probe lock refuses every binding beneath it, and only those', async () => {
    h.activeLocks = [{ coordinationDomain: root, path: 'libs', intent: 'mutation probe' }];
    mkdirSync(join(root, 'libs', 'other'), { recursive: true });
    writeFileSync(join(root, 'libs', 'other', 'd.ts'), 'export const d = 1;\n');
    h.rows = [...h.rows, binding(4, ['libs/other/d.ts'])];

    const rows = await list();
    const status = rows.map((row) => (row as { serverMeasurement?: { status: string; reason?: string } }).serverMeasurement);

    // c.ts lives in the nested repository, a different lock domain from the root's 'libs'.
    expect(status.slice(0, 3).map((s) => s?.status)).toEqual(['measured', 'measured', 'measured']);
    expect(status[3]).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining(`repo_measurement_mutation_probe_active:${root}:libs`),
    });
  });

  it('an unreadable lock queue falls back to the per-binding fence instead of skipping it', async () => {
    h.failNextRead = true;
    h.activeLocks = [{ coordinationDomain: root, path: 'b.ts', intent: 'mutation probe' }];

    const rows = await list();
    const status = rows.map((row) => (row as { serverMeasurement?: { status: string; reason?: string } }).serverMeasurement);

    expect(status[0]?.status).toBe('measured');
    expect(status[1]).toMatchObject({
      status: 'unavailable',
      reason: expect.stringContaining(`repo_measurement_mutation_probe_active:${root}:b.ts`),
    });
    expect(status[2]?.status).toBe('measured');
  });

  it('an unresolvable path fails only its own binding and keeps the batch fence', async () => {
    h.rows = [...h.rows, binding(4, ['missing.ts'])];

    const rows = await list();
    const status = rows.map((row) => (row as { serverMeasurement?: { status: string; reason?: string } }).serverMeasurement);

    expect(status.slice(0, 3).map((s) => s?.status)).toEqual(['measured', 'measured', 'measured']);
    expect(status[3]).toMatchObject({ status: 'unavailable', reason: expect.stringContaining('ENOENT') });
    expect(h.calls).toHaveLength(4);
  });
});
