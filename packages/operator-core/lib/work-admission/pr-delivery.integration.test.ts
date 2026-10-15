/**
 * PR-required admission rules against real Postgres
 * (slack-asana-reproduced-bug-fix-pr-workflow-2026-10-08 P-013, D-015).
 *
 * The rule store, the admission ledger and the evaluation/backfill paths run for real; only the
 * harness registry and the pot's integration-mode read are injected (the store-backed mode read
 * has its own tests in harness/git-sync). Properties:
 *   - a `delivery:'pr'` rule cannot be saved (or enabled) against a harness whose pot would push
 *     straight to the main repository, and nothing is stored when it is refused;
 *   - it saves against a review-mode pot member with a fork;
 *   - an update that keeps the stored lifecycle still binds the new target harness;
 *   - a pot switched back to direct mode AFTER the rule was saved refuses every admission and
 *     every backfill by name, and no work is dispatched (no work_admissions row);
 *   - a `direct` rule never consults the integration mode (today's behaviour is unchanged).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { applyAdmissionRule, evaluateAdmissionRules, setAdmissionRule, type AdmissionRuleDeps } from './admission-rules';
import type { PotIntegrationModeRead } from '../harness/git-sync/pot-integration-mode';
import type { PrDeliveryRegistryEntry } from './pr-delivery';

const WS = 'papercusp-workspace';
const KIND = 'pr-delivery-it';
const FORK = 'https://github.com/papercusp-agents/subject.git';
const PROJECTS: PrDeliveryRegistryEntry[] = [
  { slug: 'subject-pot', self_repo: true },
  { slug: 'subject', hive_slug: 'subject-pot', fork_remote: FORK },
  { slug: 'direct-pot', self_repo: true },
];

let org: OrgTestDb;
let sql: Sql;
let alice: string;
let sourceId: string;
/** The live answer the injected mode read gives, per pot home; tests flip it. */
const modes = new Map<string, PotIntegrationModeRead>();
const modeReads: string[] = [];
const deps: AdmissionRuleDeps = {
  prDelivery: {
    loadProjects: async () => PROJECTS,
    readMode: async (_ws, pot) => {
      modeReads.push(pot);
      return modes.get(pot) ?? { mode: 'direct', source: 'absent' };
    },
  },
};
const MATCH = { labels: { contains: 'papercusp' } };

async function rules(): Promise<Array<{ id: string; harness_slug: string; enabled: boolean; lifecycle: Record<string, unknown> }>> {
  return sql`SELECT id::text, harness_slug, enabled, lifecycle FROM harness_shared.admission_rules
              WHERE workspace_id = ${WS} AND data_source_id = ${sourceId} ORDER BY created_at`;
}

async function clean(): Promise<void> {
  if (!sourceId) return;
  await sql`DELETE FROM harness_shared.work_admissions WHERE workspace_id = ${WS} AND data_source_id = ${sourceId}`;
  await sql`DELETE FROM harness_shared.admission_rules WHERE workspace_id = ${WS} AND data_source_id = ${sourceId}`;
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  const [a] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.users (username, display_name) VALUES (${`pr-delivery-alice-${Date.now()}`}, 'alice') RETURNING id`;
  alice = a!.id;
  const [s] = await sql<{ id: string }[]>`
    INSERT INTO harness_shared.data_sources
      (workspace_id, kind, owner_user_id, provider_account_id, status, config, scope, destination_policy, permission_mapping)
    VALUES (${WS}, ${KIND}, ${alice}, ${`${KIND}-account-${Date.now()}`}, 'connected',
            ${sql.json({ harnessSlug: 'subject' })}, 'organization', ${sql.json({ ticket: ['record'] })},
            ${sql.json({ mode: 'source-acl' })})
    RETURNING id::text`;
  sourceId = s!.id;
});

afterAll(async () => {
  if (org) {
    await clean().catch(() => {});
    await sql`DELETE FROM harness_shared.data_sources WHERE workspace_id = ${WS} AND kind = ${KIND}`.catch(() => {});
    await org.cleanup();
  }
});

beforeEach(async () => {
  await clean();
  modes.clear();
  modeReads.length = 0;
  modes.set('subject-pot', { mode: 'review', source: 'set' });
});

const prRule = (harness: string, extra: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  dataSourceId: sourceId,
  title: 'delegated bugs',
  match: MATCH,
  harness,
  workKind: 'bug' as const,
  createdBy: 'pr-delivery-it',
  lifecycle: { delivery: 'pr' },
  ...extra,
});

describe('PR-required admission rules (P-013)', () => {
  it('refuses to save a PR-required rule against a direct-mode pot, storing nothing', async () => {
    await expect(setAdmissionRule(prRule('direct-pot'), sql, deps)).rejects.toThrow(/^pr_delivery_requires_review_mode: .*'direct'/);
    expect(await rules()).toEqual([]);
  });

  it('refuses review mode without a fork and a harness outside any pot', async () => {
    modes.set('subject-pot', { mode: 'review', source: 'set' });
    await expect(setAdmissionRule(prRule('subject-pot'), sql, deps)).rejects.toThrow(/^pr_delivery_requires_review_mode: .*metadata repository/);
    await expect(setAdmissionRule(prRule('not-registered'), sql, deps)).rejects.toThrow(/^pr_delivery_unknown_harness:/);
    expect(await rules()).toEqual([]);
  });

  it('saves against a review-mode pot member with a fork, keeping delivery on the stored rule', async () => {
    const rule = await setAdmissionRule(prRule('subject'), sql, deps);
    expect(rule.lifecycle.delivery).toBe('pr');
    expect(modeReads).toEqual(['subject-pot']);
    expect((await rules()).map((r) => [r.harness_slug, r.lifecycle.delivery])).toEqual([['subject', 'pr']]);
  });

  it('binds the stored delivery when an update leaves the lifecycle unchanged', async () => {
    const rule = await setAdmissionRule(prRule('subject'), sql, deps);
    const { lifecycle: _omit, ...withoutLifecycle } = prRule('direct-pot', { id: rule.id });
    void _omit;
    await expect(setAdmissionRule(withoutLifecycle, sql, deps)).rejects.toThrow(/^pr_delivery_requires_review_mode:/);
    expect((await rules())[0]!.harness_slug).toBe('subject');
  });

  it('lets a DISABLED PR-required rule be prepared ahead of the switch, and refuses enabling it', async () => {
    const rule = await setAdmissionRule(prRule('direct-pot', { enabled: false }), sql, deps);
    expect(rule.enabled).toBe(false);
    await expect(setAdmissionRule(prRule('direct-pot', { id: rule.id, enabled: true }), sql, deps)).rejects.toThrow(
      /^pr_delivery_requires_review_mode:/,
    );
    expect((await rules())[0]!.enabled).toBe(false);
  });

  it('refuses every admission and every backfill once the pot is switched back to direct mode', async () => {
    const rule = await setAdmissionRule(prRule('subject'), sql, deps);
    modes.set('subject-pot', { mode: 'direct', source: 'set' });

    const evaluation = await evaluateAdmissionRules(
      { workspaceId: WS, recordId: 'DSR-pr-delivery-it-1', dataSourceId: sourceId, payload: { labels: ['papercusp'] } },
      { sql, ...deps },
    );
    expect(evaluation.matched).toBe(1);
    expect(evaluation.results).toEqual([
      { ruleId: rule.id, result: expect.objectContaining({ ok: false, code: 'pr_delivery_requires_review_mode' }) },
    ]);
    await expect(applyAdmissionRule(WS, rule.id, { sql, ...deps })).rejects.toThrow(/^pr_delivery_requires_review_mode:/);

    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.work_admissions WHERE workspace_id = ${WS} AND data_source_id = ${sourceId}`;
    expect(n).toBe(0);
  });

  it('refuses when the mode cannot be read, rather than assuming direct is fine', async () => {
    const rule = await setAdmissionRule(prRule('subject'), sql, deps);
    modes.set('subject-pot', { mode: 'direct', source: 'error' });
    const evaluation = await evaluateAdmissionRules(
      { workspaceId: WS, recordId: 'DSR-pr-delivery-it-2', dataSourceId: sourceId, payload: { labels: ['papercusp'] } },
      { sql, ...deps },
    );
    expect(evaluation.results[0]).toEqual({ ruleId: rule.id, result: expect.objectContaining({ ok: false, code: 'pr_delivery_mode_unreadable' }) });
  });

  it('leaves a direct rule untouched: it never consults the integration mode', async () => {
    const rule = await setAdmissionRule({ ...prRule('direct-pot'), lifecycle: undefined }, sql, deps);
    expect(rule.lifecycle.delivery).toBe('direct');
    expect(modeReads).toEqual([]);
  });
});
