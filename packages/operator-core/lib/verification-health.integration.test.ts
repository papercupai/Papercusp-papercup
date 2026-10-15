/**
 * SPEC-P-003-VAL-LIVE-CENSUS (verification-system-improvements-2026-10-10#P-003), integration layer.
 *
 * Runs the REAL `VERIFICATION_HEALTH_PLANS_QUERY` through `runVerificationHealth` against a real
 * Postgres and pins what `valBlockPlans` counts: a non-archived plan whose content carries an
 * inline `[VAL-` assertion BLOCK header. Prose that merely mentions the token — which is exactly
 * what the live corpus still holds after the retirement (measured 2026-10-11: 0 block plans, 4
 * prose mentions) — must NOT count, or the cell could never read 0. Archived plans and other
 * harnesses (when scoped) are excluded.
 *
 * Subject override: `VERIFICATION_HEALTH_SUBJECT` points the test at a copy of
 * verification-health.ts so `scripts/mutation-probe.sh` can prove falsifiability in copy-out
 * mode without touching the shared tree. The module has no runtime imports, so a copy loads alone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import type { VerificationHealthMeasures, VerificationHealthSql } from './verification-health';

type Subject = typeof import('./verification-health');

const WORKSPACE = 'verification-health-val-census-test';
const HARNESS = 'papercusp';
const OTHER_HARNESS = 'portal';
const here = dirname(fileURLToPath(import.meta.url));
const migration = (name: string) => resolve(here, '../../../libs/papercusp/libs/db/sql', name);
const SUBJECT_PATH = process.env.VERIFICATION_HEALTH_SUBJECT ?? resolve(here, 'verification-health.ts');

/** Lane-2 measures are not under test here; they reject, so their readings go null (D-019). */
const measures: VerificationHealthMeasures<VerificationHealthSql> = {
  measureContractTriage: async () => {
    throw new Error('not under test');
  },
  measureStaleAcceptance: async () => {
    throw new Error('not under test');
  },
};

let db: FreshPgDb;
let subject: Subject;

beforeAll(async () => {
  subject = (await import(/* @vite-ignore */ SUBJECT_PATH)) as Subject;
  db = await createFreshPgDb('verification-health-val');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      title text,
      status text,
      content text NOT NULL,
      content_hash text NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      owner text,
      template text,
      template_slug text,
      template_data jsonb,
      archived boolean NOT NULL DEFAULT false,
      is_legacy boolean NOT NULL DEFAULT false,
      items jsonb NOT NULL DEFAULT '[]'::jsonb,
      decisions jsonb NOT NULL DEFAULT '[]'::jsonb,
      now_state text,
      now_next text,
      created text,
      updated text,
      forced_past jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      origin text NOT NULL DEFAULT 'local',
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      seq integer NOT NULL,
      status text NOT NULL,
      item_text text NOT NULL,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id)
    );
    CREATE TABLE harness_shared.spec_evidence_bindings (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      spec_id text NOT NULL,
      spec_revision integer NOT NULL,
      retracted_at timestamptz
    );
  `);
  await applyMigrationForTest(db.sql, migration('851-first-class-plan-spec-clauses.sql'));
  await applyMigrationForTest(db.sql, migration('929-spec-clause-falsifier.sql'));
  await applyMigrationForTest(db.sql, migration('1111-acceptance-bar-contract-seed.sql'));
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.spec_evidence_bindings, harness_shared.plan_spec_clause_revisions, harness_shared.plan_spec_clauses, harness_shared.plan_items, harness_shared.harness_plans CASCADE`;
});

async function insertPlan(planSlug: string, content: string, opts: { archived?: boolean; harness?: string } = {}) {
  await db.sql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, title, status, content, content_hash, archived)
    VALUES (${WORKSPACE}, ${opts.harness ?? HARNESS}, ${planSlug}, ${planSlug}, 'active', ${content},
            md5(${content}), ${opts.archived ?? false})`;
}

async function census(harnessSlug?: string) {
  const report = await subject.runVerificationHealth(
    db.sql as unknown as VerificationHealthSql,
    { workspaceId: WORKSPACE, harnessSlug: harnessSlug ?? null, now: new Date('2026-10-11T06:30:00Z') },
    measures,
  );
  return report.health;
}

const VAL_BLOCK_PLAN = [
  '## Phase 1',
  '- [ ] **P-001** Ship the thing',
  '  - **[VAL-001]** The thing returns 200 for a valid request.',
  '  - [VAL-002] Unbolded header form is still a block.',
].join('\n');

/** The shapes the live corpus actually holds after retirement: mentions, not blocks. */
const PROSE_MENTION_PLANS = [
  'VAL-* inline assertions are retired; a `[VAL-` block is now refused in favour of the requirement contract.',
  '## Decisions\n\nD-001: retire the [VAL-001] style assertions; see spec/validation-assertion-format.',
  '- [ ] **P-003** Retire VAL-* inline assertions ([VAL- blocks) and update the doc.',
];

describe('runVerificationHealth valBlockPlans (real Postgres) — SPEC-P-003-VAL-LIVE-CENSUS', () => {
  it('counts a non-archived plan carrying a [VAL- block header', async () => {
    await insertPlan('has-val-block', VAL_BLOCK_PLAN);
    const health = await census();
    expect(health.valBlockPlans).toBe(1);
  });

  it('reads 0 for a corpus that only MENTIONS [VAL- in prose (the post-retirement live shape)', async () => {
    for (const [i, content] of PROSE_MENTION_PLANS.entries()) await insertPlan(`prose-${i}`, content);
    const naive = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND content LIKE '%[VAL-%'`;
    // Calibration: every fixture really contains the token, so a 0 below is the detector's
    // judgment, not an empty or mis-seeded corpus.
    expect(naive[0]?.n).toBe(PROSE_MENTION_PLANS.length);
    const health = await census();
    expect(health.valBlockPlans).toBe(0);
  });

  it('excludes archived plans even when they carry a [VAL- block', async () => {
    await insertPlan('archived-val', VAL_BLOCK_PLAN, { archived: true });
    await insertPlan('live-val', VAL_BLOCK_PLAN);
    const health = await census();
    expect(health.valBlockPlans).toBe(1);
  });

  it('honours the harness scope and counts the whole workspace when unscoped', async () => {
    await insertPlan('papercusp-val', VAL_BLOCK_PLAN);
    await insertPlan('portal-val', VAL_BLOCK_PLAN, { harness: OTHER_HARNESS });
    expect((await census(HARNESS)).valBlockPlans).toBe(1);
    expect((await census()).valBlockPlans).toBe(2);
  });
});
