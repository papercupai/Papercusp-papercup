/**
 * spec-predicate-partition.integration.test.ts — the claim-spec predicate partition against REAL
 * Postgres (EI-23760081161304754 · plan dry-run-for-claims…, P-005).
 *
 * THE POINT. `previewSpecPoolEffect` returns `{ pool, matched }`. A claim spec whose filter is a
 * conjunction over a NULLABLE field cannot be diagnosed from that pair: a row whose severity key is
 * ABSENT makes `severity in [...]` UNKNOWN rather than false, so it falls out of `matched` exactly
 * as a row that is genuinely refused does — `pool - matched` lumps "refused" and "unknown" into one
 * number. That is the starved-fleet shape (EI-13306). The partition separates them: every pool row
 * lands in exactly one labelled cell and a NULL in a `d<N>` column IS the fall-through population.
 *
 * Fixture (all open, unclaimed, issue-kind unless noted), filter
 *   all:[ kind in [bug,change], severity in [critical,major] ]
 *     B-crit   severity critical        → true  | true     (admitted)
 *     B-major  severity major           → true  | true     (admitted)
 *     B-minor  severity minor           → true  | false    (genuinely refused)
 *     B-nosev  no payload               → true  | NULL     (UNKNOWN — the trap)
 *     B-empty  payload {}               → true  | NULL     (UNKNOWN — the trap)
 *     F-feat   feature, no severity     → false | NULL
 *
 * Run:
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     lib/scheduler/spec-predicate-partition.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { FLAG_DEFAULTS, type FlagKey } from '@papercusp/flags';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  HARNESS_FEATURES_CONSOLIDATED_DDL,
  USER_TRUST_LIST_DDL,
  WORK_ITEM_DEPS_DDL,
} from '../../test/_work-items-schema';
import type { ClaimSpec, FilterNode } from './claim-spec';
import type { OrgSql } from '../work-items';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return { ...actual, getFlag: async (key: FlagKey) => FLAG_DEFAULTS[key] ?? false };
});

const { previewSpecPoolEffect } = await import('./spec-pool-preview');
const { previewSpecFilterPartition, planSpecPartition } = await import('./spec-predicate-partition');
const { validateClaimSpec } = await import('./claim-spec');

const H = 'papercup';
const WS = 'default';
let db: FreshPgDb;

function spec(filter: FilterNode, states?: string[]): ClaimSpec {
  const s: ClaimSpec = {
    specVersion: '1.0',
    specId: 'partition-it',
    revision: 1,
    view: { filter },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
    ...(states ? { states } : {}),
  };
  const v = validateClaimSpec(s);
  expect(v.ok, `spec invalid: ${v.errors.join('; ')}`).toBe(true);
  return s;
}

async function seed(
  id: string,
  opts: { kind?: string; status?: string; payload?: Record<string, unknown> | null; harness?: string } = {},
) {
  await db.sql`
    INSERT INTO harness_shared.work_items
      (harness_slug, feature_id, item_kind, status, taken_by, workspace_id,
       created_ts, updated_ts, source_plan_slug, title, payload)
    VALUES (${opts.harness ?? H}, ${id}, ${opts.kind ?? 'bug'}, ${opts.status ?? 'open'},
       NULL, ${WS}, 0, 0, NULL, ${id},
       ${opts.payload ? db.sql.json(opts.payload as postgres.JSONValue) : null})`;
}

const KIND_ISSUE: FilterNode = { field: 'kind', op: 'in', value: ['bug', 'change'] };
const SEVERITY_HIGH: FilterNode = { field: 'severity', op: 'in', value: ['critical', 'major'] };
const TWO_PREDICATES: FilterNode = { all: [KIND_ISSUE, SEVERITY_HIGH] };

async function seedTrapFixture() {
  await seed('B-crit', { payload: { severity: 'critical' } });
  await seed('B-major', { payload: { severity: 'major' } });
  await seed('B-minor', { payload: { severity: 'minor' } });
  await seed('B-nosev'); // NULL payload → severity key ABSENT
  await seed('B-empty', { payload: {} });
  await seed('F-feat', { kind: 'feature' });
}

beforeAll(async () => {
  db = await createFreshPgDb('sched-spec-partition');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
  await db.sql.unsafe(USER_TRUST_LIST_DDL);
  await db.sql.unsafe(WORK_ITEM_DEPS_DDL).simple();
}, 90_000);
afterAll(async () => {
  await db?.cleanup();
});
beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.work_items, harness_shared.work_item_deps `;
});

describe('previewSpecFilterPartition — separates "refused" from "UNKNOWN"', () => {
  it('the matched COUNT alone cannot distinguish a refused row from a NULL-poisoned one', async () => {
    await seedTrapFixture();
    const effect = await previewSpecPoolEffect(spec(TWO_PREDICATES), { workspaceId: WS, harness: H });
    // 6 in the pool, 2 admitted. The other 4 are THREE different things (1 refused by severity,
    // 2 UNKNOWN on severity, 1 refused by kind) and `pool - matched` cannot say which.
    expect(effect.pool).toBe(6);
    expect(effect.matched).toBe(2);
  });

  it('the partition shows every pool row in exactly one cell, and the NULL cells ARE the fall-through', async () => {
    await seedTrapFixture();
    const out = (await previewSpecFilterPartition(spec(TWO_PREDICATES), { workspaceId: WS, harness: H }))!;
    expect(out).not.toBeNull();

    // legend: which filter node each column is
    expect(out).toContain('d1 = kind in ');
    expect(out).toContain('d2 = severity in ');

    // the cells, executed against the real pool
    expect(out).toContain('true | true → 2'); //  B-crit, B-major — admitted
    expect(out).toContain('true | false → 1'); // B-minor — genuinely refused
    expect(out).toContain('true | NULL → 2'); //  B-nosev, B-empty — UNKNOWN, dropped by the claim path
    expect(out).toContain('false | NULL → 1'); // F-feat — refused by kind AND unknown on severity

    // the per-dimension NULL tally and the sum check the advisory asks the reader to run
    expect(out).toContain('PER-DIMENSION NULL ROWS: d1=0, d2=3');
    expect(out).toContain('PARTITION TOTAL: 6 of 6');
    // …which equals the preview's pool: the cells are exhaustive over the SAME population
    const effect = await previewSpecPoolEffect(spec(TWO_PREDICATES), { workspaceId: WS, harness: H });
    expect(effect.pool).toBe(6);

    // and a sample drawn from the fall-through population specifically
    expect(out).toContain('FALL-THROUGH SAMPLE');
    expect(out).toMatch(/B-nosev|B-empty|F-feat/);
  });

  it('measures the SAME pool the count does: floors exclude observation-lane, claim-held, taken and wrong-status rows', async () => {
    await seedTrapFixture();
    await seed('B-obs', { payload: { lane: 'observation' } });
    await seed('B-held', { payload: { severity: 'critical', _claimHold: true } });
    await seed('B-done', { status: 'done', payload: { severity: 'critical' } });
    await db.sql`UPDATE harness_shared.work_items SET taken_by = 'bee-1' WHERE feature_id = 'B-minor'`;
    const out = (await previewSpecFilterPartition(spec(TWO_PREDICATES), { workspaceId: WS, harness: H }))!;
    const effect = await previewSpecPoolEffect(spec(TWO_PREDICATES), { workspaceId: WS, harness: H });
    expect(effect.pool).toBe(5); // 6 seeded − B-minor (taken); obs / held / done never enter the pool
    expect(out).toContain(`PARTITION TOTAL: ${effect.pool} of ${effect.pool}`);
  });

  it('honours harness scoping the way the count does', async () => {
    await seedTrapFixture();
    await seed('B-elsewhere', { harness: 'other-harness', payload: { severity: 'critical' } });
    const scoped = (await previewSpecFilterPartition(spec(TWO_PREDICATES), { workspaceId: WS, harness: H }))!;
    expect(scoped).toContain('PARTITION TOTAL: 6 of 6');
    const wide = (await previewSpecFilterPartition(spec(TWO_PREDICATES), { workspaceId: WS }))!;
    expect(wide).toContain('PARTITION TOTAL: 7 of 7');
  });

  it('a not:{plan} fence (EI-13306) shows as a NON-NULL partition: the null-safe compiler admits NULL-plan rows', async () => {
    await seed('B-noplan-1', { payload: { severity: 'critical' } });
    await seed('B-noplan-2', { payload: { severity: 'critical' } });
    const out = (await previewSpecFilterPartition(
      spec({ all: [KIND_ISSUE, { not: { field: 'plan', op: '=', value: 'some-peer-plan' } }] }),
      { workspaceId: WS, harness: H },
    ))!;
    expect(out).not.toBeNull();
    // both rows are admitted by BOTH predicates — no NULL cell, no fall-through. This is the
    // positive control for the trap fixture above: the partition reports NULL only where it is real.
    expect(out).toContain('true | true → 2');
    expect(out).toContain('PER-DIMENSION NULL ROWS: d1=0, d2=0');
    expect(out).toContain('FALL-THROUGH SAMPLE: none');
  });
});

describe('previewSpecFilterPartition — boundaries', () => {
  it('a narrow filter (one non-jsonb dimension) is null: narrow specs are reported exactly as before', async () => {
    await seedTrapFixture();
    expect(await previewSpecFilterPartition(spec(KIND_ISSUE), { workspaceId: WS, harness: H })).toBeNull();
    expect(planSpecPartition(spec(KIND_ISSUE), { workspaceId: WS, harness: H })).toBeNull();
  });

  it('FAILS OPEN against a live pool: a client that errors yields statements-only text, not "no cells"', async () => {
    await seedTrapFixture();
    const broken = {
      begin: () => {
        throw new Error('simulated probe failure');
      },
    } as unknown as OrgSql;
    const out = (await previewSpecFilterPartition(spec(TWO_PREDICATES), {
      workspaceId: WS,
      harness: H,
      client: broken,
    }))!;
    expect(out).toContain('CLAIM-SPEC PARTITION');
    expect(out).toContain('GROUP BY 1, 2');
    expect(out).not.toContain('PARTITION TOTAL');
    expect(out).not.toContain('PARTITION: the probe returned no cells');
  });

  it('an `any` conjunct is partitioned as ONE predicate (admit / refuse / UNKNOWN), not split by arm', async () => {
    await seedTrapFixture();
    const out = (await previewSpecFilterPartition(
      spec({
        all: [
          { any: [SEVERITY_HIGH, { field: 'title', op: 'glob', value: 'F-*' }] },
          KIND_ISSUE,
        ],
      }),
      { workspaceId: WS, harness: H },
    ))!;
    expect(out).toContain('d1 = any:[');
    expect(out).toContain('d2 = kind in ');
    expect(out).toContain('PARTITION TOTAL: 6 of 6');
  });
});
