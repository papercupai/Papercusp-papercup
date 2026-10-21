/**
 * Migration 1542 widens `plan_items_deliverable_check` to namespaced item-type slugs
 * (plan-item-types-registry-cupboard-2026-10-20 P-002, requirement R-4).
 *
 * The parser accepts any `<namespace>/<name>` slug for `deliverable:` and checks grammar only
 * (TYPE_SLUG_PATTERN in @papercusp/plan-parser). The column CHECK must accept exactly what the
 * parser accepts — the six built-in kinds, NULL, and grammatical namespaced slugs — and refuse
 * everything else. Falsifiers, each a case below:
 *   (1) the DB refuses a namespaced slug the parser accepts (a plan line that parses can't persist);
 *   (2) the DB accepts a malformed value the parser refuses;
 *   (3) a built-in kind or NULL is refused (1542 regressed today's values).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { DELIVERABLE_KINDS, isTypeSlug } from '@papercusp/plan-parser';
import { DEFAULT_WORKSPACE_ID } from '../workspace-registry';
import {
  setupPlanPgFixture,
  cleanupPlans,
  registerHarnessProject,
  seedPlan,
  type PlanPgFixture,
} from '../agent-tools/plans/__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-ptcheck1542-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
const SLUG = `deliverable-check-1542-${RUN}-2026-10-21`;

/** Grammatical namespaced slugs: the parser accepts every one. */
const NAMESPACED = ['acme/legal-review', 'a/b', 'team-7/design-qa', '0x/9-lives'];
/** Malformed values: the parser refuses every one. */
const MALFORMED = [
  'Acme/legal-review',
  'acme/Legal',
  'acme/',
  '/legal',
  'acme',
  'acme/legal/review',
  '-acme/legal',
  'acme/-legal',
  'acme legal/review',
  'acme_x/review',
  '',
];

let fx: PlanPgFixture;
let admin: postgres.Sql;
let seq = 0;

async function insertItem(deliverable: string | null): Promise<void> {
  seq += 1;
  await admin`
    INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status, deliverable)
    VALUES (${WS}, ${HARNESS}, ${SLUG}, ${`P-${String(seq).padStart(3, '0')}`}, ${seq}, ${`Item ${seq}`}, 'todo', ${deliverable})`;
}

async function checkViolation(deliverable: string | null): Promise<string | null> {
  try {
    await insertItem(deliverable);
    return null;
  } catch (err) {
    const e = err as { code?: string; constraint_name?: string };
    return `${e.code ?? 'no-code'}:${e.constraint_name ?? 'no-constraint'}`;
  }
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
  await seedPlan(admin, WS, HARNESS, SLUG, `---\ntitle: ${SLUG}\nslug: ${SLUG}\nstatus: draft\n---\n\n# ${SLUG}\n`);
}, 180_000);

afterAll(async () => {
  if (!admin) return;
  await admin`DELETE FROM harness_shared.plan_items WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`;
  await cleanupPlans(admin, WS, HARNESS);
  await fx.dispose();
});

describe('plan_items.deliverable CHECK after migration 1542 (R-4)', () => {
  it('accepts every namespaced slug the parser accepts', async () => {
    for (const slug of NAMESPACED) {
      expect(isTypeSlug(slug), `fixture: parser accepts ${slug}`).toBe(true);
      expect(await checkViolation(slug), slug).toBeNull();
    }
  });

  it('refuses every malformed value the parser refuses, by the deliverable CHECK', async () => {
    for (const value of MALFORMED) {
      expect(isTypeSlug(value), `fixture: parser refuses ${JSON.stringify(value)}`).toBe(false);
      expect(await checkViolation(value), JSON.stringify(value)).toBe('23514:plan_items_deliverable_check');
    }
  });

  it('still accepts every built-in kind and NULL', async () => {
    for (const kind of DELIVERABLE_KINDS) expect(await checkViolation(kind), kind).toBeNull();
    expect(await checkViolation(null), 'NULL').toBeNull();
  });
});
