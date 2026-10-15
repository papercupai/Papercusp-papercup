/**
 * Canonical dependency mutation admission against real PostgreSQL.
 *
 * The properties under test are transactional: candidate validation and writes
 * must share one SERIALIZABLE snapshot, a rejected batch must leave no prefix
 * behind, and reciprocal disjoint writers may not both commit. A mock would
 * merely restate the intended interleaving and cannot prove any of those.
 *
 * These are P-005 seam proofs, not yet registry-wide `@covers` claims. INV-16
 * becomes true only after P-006 routes every writer; INV-17 also needs companion
 * state/event rollback proofs; INV-18's every-door claim needs the P-007 matrix.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../test/_work-items-schema';
import {
  mirrorWorkItemBlockingEdge,
  mutateWorkItemDependencies,
  removeMirroredWorkItemBlockingEdge,
  syncWorkItemDepEdges,
  WorkItemDependencyAdmissionError,
  type WorkItemDependencyBatchInput,
  type WorkItemDepEndpoint,
} from './work-item-deps-store';

const EDGE_WS = 'default';
const ITEM_WS = 'tenant-a';
const H = 'admission-harness';

const issue = (ref: string): WorkItemDepEndpoint => ({ kind: 'issue', ref });
const feature = (ref: string, harness = H): WorkItemDepEndpoint => ({ kind: 'feature', ref: `${harness}#${ref}` });

let db: FreshPgDb;

async function seedItem(
  id: string,
  opts: { kind?: string; status?: string; takenBy?: string | null; workspaceId?: string; harness?: string } = {},
): Promise<void> {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, status, taken_by, item_kind, created_ts, updated_ts, payload)
    VALUES
      (${opts.workspaceId ?? ITEM_WS}, ${opts.harness ?? H}, ${id}, ${`item ${id}`},
       ${opts.status ?? 'open'}, ${opts.takenBy ?? null}, ${opts.kind ?? 'task'}, 0, 0, '{}'::jsonb)`;
}

async function storedEdges(): Promise<
  Array<{ blocked_kind: string; blocked_ref: string; blocker_kind: string; blocker_ref: string }>
> {
  return db.sql`
    SELECT blocked_kind, blocked_ref, blocker_kind, blocker_ref
      FROM harness_shared.work_item_deps
     WHERE workspace_id = ${EDGE_WS} AND dep_type = 'blocks'
     ORDER BY blocked_kind, blocked_ref, blocker_kind, blocker_ref`;
}

const mutate = (mutations: WorkItemDependencyBatchInput['mutations']) =>
  mutateWorkItemDependencies(
    { workspaceId: EDGE_WS, itemWorkspaceId: ITEM_WS, mutations },
    {
      sql: db.sql as Sql,
      retry: { maxRetries: 8, baseDelayMs: 0, sleep: async () => {} },
    },
  );

const writerOpts = () => ({
  sql: db.sql as Sql,
  itemWorkspaceId: ITEM_WS,
  retry: { maxRetries: 8, baseDelayMs: 0, sleep: async () => {} },
});

async function admissionError(promise: Promise<unknown>): Promise<WorkItemDependencyAdmissionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(WorkItemDependencyAdmissionError);
    return error as WorkItemDependencyAdmissionError;
  }
  throw new Error('expected dependency admission to reject');
}

beforeAll(async () => {
  db = await createFreshPgDb('work-item-deps-admission');
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_item_deps, harness_shared.work_items CASCADE`;
});

describe('canonical dependency batch admission', () => {
  it('commits one safe cross-family edge while keeping edge and item workspace axes distinct', async () => {
    await seedItem('F-dependent', { kind: 'feature' });
    await seedItem('EI-blocker');

    const result = await mutate([
      { op: 'add', blocked: feature('F-dependent'), blocker: issue('EI-blocker'), createdBy: 'test' },
    ]);

    expect(result).toMatchObject({ inserted: 1, removed: 0 });
    expect(result.telemetry).toMatchObject({
      schemaVersion: 'dependency-graph-performance-v1',
      event: 'dependency-mutation-committed',
      operation: 'mutation',
      policyCodes: [],
      inserted: 1,
      removed: 0,
      nodes: 2,
      edges: 1,
      budgetMs: 2_000,
      budgetStatus: 'within-budget',
    });
    expect(result.after.endpointDefects).toEqual([]);
    expect(result.after.strandedClosure).toEqual([]);
    expect(await storedEdges()).toEqual([
      {
        blocked_kind: 'feature',
        blocked_ref: `${H}#F-dependent`,
        blocker_kind: 'issue',
        blocker_ref: 'EI-blocker',
      },
    ]);
  });

  it('rejects a cyclic multi-edge candidate with exact paths and writes no prefix', async () => {
    await seedItem('EI-A');
    await seedItem('EI-B');

    const error = await admissionError(
      mutate([
        { op: 'add', blocked: issue('EI-A'), blocker: issue('EI-B') },
        { op: 'add', blocked: issue('EI-B'), blocker: issue('EI-A') },
      ]),
    );

    expect(error.findings.map((finding) => finding.policy.code)).toEqual(['cycle', 'stranded-set-increase']);
    expect(error.telemetry).toMatchObject({
      schemaVersion: 'dependency-graph-performance-v1',
      event: 'dependency-mutation-rejected',
      operation: 'mutation',
      policyCodes: ['cycle', 'stranded-set-increase'],
      nodes: 2,
      edges: 2,
    });
    const cycle = error.findings[0]!.cycles[0]!.cyclePath.map((node) => node.ref);
    expect(cycle[0]).toBe(cycle.at(-1));
    expect(new Set(cycle.slice(0, -1))).toEqual(new Set(['EI-A', 'EI-B']));
    expect(error.message).toMatch(/issue:EI-[AB].*issue:EI-[AB].*issue:EI-[AB]/);
    expect(await storedEdges()).toEqual([]);
  });

  it('rolls back an invalid replacement and preserves the prior complete blocker set', async () => {
    await seedItem('EI-dependent');
    await seedItem('EI-old');
    await seedItem('EI-new');
    await mutate([{ op: 'add', blocked: issue('EI-dependent'), blocker: issue('EI-old') }]);

    const error = await admissionError(
      mutate([
        {
          op: 'replace',
          blocked: issue('EI-dependent'),
          blockers: [issue('EI-new'), issue('EI-missing')],
        },
      ]),
    );

    expect(error.findings.map((finding) => finding.policy.code)).toEqual([
      'executable-endpoint-missing',
      'stranded-set-increase',
    ]);
    expect(await storedEdges()).toEqual([
      {
        blocked_kind: 'issue',
        blocked_ref: 'EI-dependent',
        blocker_kind: 'issue',
        blocker_ref: 'EI-old',
      },
    ]);
  });

  it('classifies a form-valid declaration for the wrong target family as an identity mismatch', async () => {
    await seedItem('EI-dependent');
    await seedItem('WI-actual-issue');

    const error = await admissionError(
      mutate([
        {
          op: 'add',
          blocked: issue('EI-dependent'),
          blocker: feature('WI-actual-issue'),
        },
      ]),
    );

    const mismatch = error.findings.find((finding) => finding.policy.code === 'endpoint-identity-mismatch');
    expect(mismatch?.endpointDefects).toMatchObject([
      {
        code: 'mismatched',
        role: 'blocker',
        declared: { kind: 'feature', ref: `${H}#WI-actual-issue` },
        resolvedAs: { kind: 'issue', ref: 'WI-actual-issue' },
      },
    ]);
    expect(await storedEdges()).toEqual([]);
  });

  it('rejects one cycle spanning both work-item families and two harnesses', async () => {
    const otherHarness = 'other-harness';
    await seedItem('F-A', { kind: 'feature', harness: H });
    await seedItem('EI-B', { harness: otherHarness });

    const error = await admissionError(
      mutate([
        { op: 'add', blocked: feature('F-A', H), blocker: issue('EI-B') },
        { op: 'add', blocked: issue('EI-B'), blocker: feature('F-A', H) },
      ]),
    );

    const cycle = error.findings.find((finding) => finding.policy.code === 'cycle')!.cycles[0]!;
    expect(new Set(cycle.members.map((node) => `${node.kind}:${node.ref}`))).toEqual(
      new Set([`feature:${H}#F-A`, 'issue:EI-B']),
    );
    expect(await storedEdges()).toEqual([]);
  });

  it('rejects an endpoint that exists only in another item workspace', async () => {
    await seedItem('EI-dependent');
    await seedItem('EI-other-workspace', { workspaceId: 'tenant-b' });

    const error = await admissionError(
      mutate([{ op: 'add', blocked: issue('EI-dependent'), blocker: issue('EI-other-workspace') }]),
    );

    const crossWorkspace = error.findings.find((finding) => finding.policy.code === 'cross-workspace-inert-edge');
    expect(crossWorkspace?.endpointDefects).toMatchObject([
      { code: 'missing', role: 'blocker', declared: { kind: 'issue', ref: 'EI-other-workspace' } },
    ]);
    expect(error.findings.some((finding) => finding.policy.code === 'executable-endpoint-missing')).toBe(false);
    expect(await storedEdges()).toEqual([]);
  });

  it('permits a monotonic repair of a pre-existing legacy cycle', async () => {
    await seedItem('EI-A');
    await seedItem('EI-B');
    await db.sql`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref, dep_type)
      VALUES
        (${EDGE_WS}, 'issue', 'EI-A', 'issue', 'EI-B', 'blocks'),
        (${EDGE_WS}, 'issue', 'EI-B', 'issue', 'EI-A', 'blocks')`;

    const result = await mutate([{ op: 'remove', blocked: issue('EI-B'), blocker: issue('EI-A') }]);

    expect(result).toMatchObject({ inserted: 0, removed: 1 });
    expect(result.before.stronglyConnectedComponents).toHaveLength(1);
    expect(result.after.stronglyConnectedComponents).toEqual([]);
    expect(await storedEdges()).toEqual([
      {
        blocked_kind: 'issue',
        blocked_ref: 'EI-A',
        blocker_kind: 'issue',
        blocker_ref: 'EI-B',
      },
    ]);
  });

  it('serializes reciprocal disjoint writers so exactly one valid edge commits', async () => {
    await seedItem('EI-A');
    await seedItem('EI-B');

    const outcomes = await Promise.allSettled([
      mutate([{ op: 'add', blocked: issue('EI-A'), blocker: issue('EI-B') }]),
      mutate([{ op: 'add', blocked: issue('EI-B'), blocker: issue('EI-A') }]),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({ status: 'rejected' });
    expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(WorkItemDependencyAdmissionError);
    expect(await storedEdges()).toHaveLength(1);
  });

  it('keeps concurrent identical adds idempotent and reports the one actual insert', async () => {
    await seedItem('EI-dependent');
    await seedItem('EI-blocker');
    const mutation = [{ op: 'add', blocked: issue('EI-dependent'), blocker: issue('EI-blocker') }] as const;

    const results = await Promise.all([mutate(mutation), mutate(mutation)]);

    expect(results.map((result) => result.inserted).sort()).toEqual([0, 1]);
    expect(results.every((result) => result.removed === 0)).toBe(true);
    expect(await storedEdges()).toHaveLength(1);
  });

  it('EI-252075: idempotent adds preserve SUCCESS unless a new requirement is explicit', async () => {
    await seedItem('EI-dependent');
    await seedItem('EI-blocker');
    const edge = { op: 'add', blocked: issue('EI-dependent'), blocker: issue('EI-blocker') } as const;
    await mutate([{ ...edge, satisfaction: 'success', createdBy: 'manual-source' }]);
    const read = () => db.sql`
      SELECT id, satisfaction, created_by, created_at FROM harness_shared.work_item_deps`;
    const before = await read();
    expect(before).toHaveLength(1);
    expect(before[0].satisfaction).toBe('success');

    const repeated = await mutate([edge]);

    expect(repeated.inserted).toBe(0);
    expect(repeated.removed).toBe(0);
    expect(await read()).toEqual(before);
    await mutate([{ ...edge, satisfaction: 'settled' }]);
    expect(await read()).toEqual([{ ...before[0], satisfaction: 'settled' }]);
  });

  it('routes mirror + unlink facades through canonical admission', async () => {
    await seedItem('EI-A');
    await seedItem('EI-B');

    await mirrorWorkItemBlockingEdge(issue('EI-A'), issue('EI-B'), writerOpts());
    await expect(mirrorWorkItemBlockingEdge(issue('EI-B'), issue('EI-A'), writerOpts())).rejects.toBeInstanceOf(
      WorkItemDependencyAdmissionError,
    );
    expect(await storedEdges()).toEqual([
      {
        blocked_kind: 'issue',
        blocked_ref: 'EI-B',
        blocker_kind: 'issue',
        blocker_ref: 'EI-A',
      },
    ]);

    await removeMirroredWorkItemBlockingEdge(issue('EI-A'), issue('EI-B'), writerOpts());
    expect(await storedEdges()).toEqual([]);
  });

  it('allows the active dependant holder to add an unresolved blocker and refuses a non-holder', async () => {
    await seedItem('EI-dependent-same-holder', { takenBy: 'su-holder' });
    await seedItem('EI-dependent-other-author', { takenBy: 'su-holder' });
    await seedItem('EI-blocker');

    await mirrorWorkItemBlockingEdge(issue('EI-blocker'), issue('EI-dependent-same-holder'), {
      ...writerOpts(),
      createdBy: 'su-holder',
    });

    const refusal = await admissionError(
      mirrorWorkItemBlockingEdge(issue('EI-blocker'), issue('EI-dependent-other-author'), {
        ...writerOpts(),
        createdBy: 'su-other',
      }),
    );

    expect(refusal.findings.map((finding) => finding.policy.code)).toContain('active-dependant-unreconciled');
    expect(
      await db.sql<{ blocked_ref: string; created_by: string | null }[]>`
        SELECT blocked_ref, created_by
          FROM harness_shared.work_item_deps
         WHERE workspace_id = ${EDGE_WS} AND dep_type = 'blocks'
         ORDER BY blocked_ref`,
    ).toEqual([{ blocked_ref: 'EI-dependent-same-holder', created_by: 'su-holder' }]);
  });

  it('routes sync/replace through canonical admission and preserves the prior set on rejection', async () => {
    await seedItem('F-dependent', { kind: 'feature' });
    await seedItem('F-old', { kind: 'feature' });
    await seedItem('F-new', { kind: 'feature' });

    await syncWorkItemDepEdges(H, 'F-dependent', ['F-old'], writerOpts());
    await expect(syncWorkItemDepEdges(H, 'F-dependent', ['F-new', 'F-missing'], writerOpts())).rejects.toBeInstanceOf(
      WorkItemDependencyAdmissionError,
    );
    expect(await storedEdges()).toEqual([
      {
        blocked_kind: 'feature',
        blocked_ref: `${H}#F-dependent`,
        blocker_kind: 'feature',
        blocker_ref: `${H}#F-old`,
      },
    ]);
  });
});
