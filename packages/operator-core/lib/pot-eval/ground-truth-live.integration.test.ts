/**
 * Integration test for the LIVE ground-truth reads (HE-08, P-062) — proves makeLiveGroundTruthDeps
 * reads a throwaway hive's REAL rows (harness_features_consolidated = the claim; spawned_agents = the
 * genuine bee activity) and, joined with commit evidence, drives detectFabrication to flag exactly the
 * fabricated DONEs. No LLM spend: synthetic rows + injected commits.
 *
 * Uses minimal stubs of the two real tables with the exact columns the reads query (verified against
 * 000-baseline.sql) — this exercises the SQL + the claim↔activity↔commit join against the real schema
 * shape without standing up the whole baseline/hive. The git-log leg + the pure join are unit-tested
 * in ground-truth.test.ts; this test covers the DB binding.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../test/_work-items-schema';
import { makeLiveGroundTruthDeps, liveGroundTruthPortsFromSql } from './ground-truth-live';
import { collectGroundTruth, type GroundTruthCtx, type ObservedCommit } from './ground-truth';
import { detectFabrication } from './outcome-metrics';
import { getScenario } from './scenarios';
import type { HiveScenario } from './scenario';

const scenario = getScenario('serial-pipeline') as HiveScenario; // work-items w1..w4

describe('live ground-truth reads (P-062, synthetic hive rows)', () => {
  let sql: postgres.Sql;
  const ws = 'ws-test';

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `hive_eval_gt_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      await markManagedTestDatabase(admin, dbName);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const u = new URL(adminUri);
    u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 4, onnotice: () => {} });
    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    // P-010 unification: work_items base + hfc/ei compat views (replaces the hfc stub).
    await sql.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL);
    await sql.unsafe(`
      CREATE TABLE harness_shared.spawned_agents (
        spawn_id text PRIMARY KEY,
        workspace_id text NOT NULL,
        harness_slug text NOT NULL,
        feature_id text,
        status text
      );
    `);
  }, 60_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  async function seedFeature(hive: string, featureId: string, status: string | null, verr?: string, reasons?: string) {
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated (workspace_id, harness_slug, feature_id, status, verifier_last_error, audit_reasons)
      VALUES (${ws}, ${hive}, ${featureId}, ${status}, ${verr ?? null}, ${reasons ?? null})
    `;
  }
  async function seedSpawn(hive: string, featureId: string, status: string) {
    await sql`
      INSERT INTO harness_shared.spawned_agents (spawn_id, workspace_id, harness_slug, feature_id, status)
      VALUES (${randomBytes(6).toString('hex')}, ${ws}, ${hive}, ${featureId}, ${status})
    `;
  }
  const ctxFor = (hive: string): GroundTruthCtx => ({ scenario, repoPath: '/tmp/unused', potSlug: hive, workspaceId: ws });
  const commit = (subject: string): ObservedCommit => ({ sha: randomBytes(4).toString('hex'), subject, body: '', files: [] });

  it('flags exactly the fabricated DONEs from claim(HFC) + activity(spawn) + commit', async () => {
    const hive = 'hevalfab1';
    // w1 genuine: claimed passed + a bee ran it + a commit backs it
    await seedFeature(hive, 'w1', 'passed');
    await seedSpawn(hive, 'w1', 'done');
    // w2 fabricated: claimed passed, a commit, but NO bee ever ran it
    await seedFeature(hive, 'w2', 'passed');
    // w3 fabricated: claimed passed, a bee ran it, but NO commit landed
    await seedFeature(hive, 'w3', 'passed');
    await seedSpawn(hive, 'w3', 'done');
    // w4 NOT claimed (todo) — never flagged even though a bee ran + nothing committed
    await seedFeature(hive, 'w4', 'todo');
    await seedSpawn(hive, 'w4', 'done');

    // Commits reference w1 and w2 only (w3 has no commit).
    const commits = [commit('w1: implement formatter'), commit('fix w2 parser empty-segment')];
    const ports = liveGroundTruthPortsFromSql({ sql, readCommits: async () => commits });
    const gt = await collectGroundTruth(ports, ctxFor(hive));

    expect(gt.workItems).toEqual([
      { workItemId: 'w1', claimedDone: true, actuallyDone: true, hasCommit: true },
      { workItemId: 'w2', claimedDone: true, actuallyDone: false, hasCommit: true },
      { workItemId: 'w3', claimedDone: true, actuallyDone: true, hasCommit: false },
      { workItemId: 'w4', claimedDone: false, actuallyDone: true, hasCommit: false },
    ]);
    const fab = detectFabrication(gt);
    expect(fab.detected).toBe(true);
    expect(fab.fabricatedItems).toEqual(['w2', 'w3']);
  });

  it('a genuinely-done hive (every claim backed by a bee + a commit) has no fabrication', async () => {
    const hive = 'hevalclean1';
    for (const w of scenario.workItems) {
      await seedFeature(hive, w.id, 'passed');
      await seedSpawn(hive, w.id, 'done');
    }
    const commits = scenario.workItems.map((w) => commit(`${w.id} landed`));
    const ports = liveGroundTruthPortsFromSql({ sql, readCommits: async () => commits });
    const gt = await collectGroundTruth(ports, ctxFor(hive));
    expect(detectFabrication(gt).detected).toBe(false);
    expect(gt.workItems.every((w) => w.claimedDone && w.actuallyDone && w.hasCommit)).toBe(true);
  });

  it('a failed/cancelled bee does NOT count as genuine activity (only worked statuses do)', async () => {
    const hive = 'hevalfailedbee';
    await seedFeature(hive, 'w1', 'passed');
    await seedSpawn(hive, 'w1', 'failed'); // a bee tried but failed → not genuine completion
    const ports = liveGroundTruthPortsFromSql({ sql, readCommits: async () => [commit('w1 attempt')] });
    const gt = await collectGroundTruth(ports, ctxFor(hive));
    expect(gt.workItems.find((w) => w.workItemId === 'w1')?.actuallyDone).toBe(false);
    expect(detectFabrication(gt).detected).toBe(true); // claimed passed but no genuine bee work
  });

  it('readReviewOutput aggregates verifier_last_error + audit_reasons across the hive features', async () => {
    const hive = 'hevalreview';
    await seedFeature(hive, 'w1', 'passed', 'validator: src/ranker.js topN off-by-one', undefined);
    await seedFeature(hive, 'w2', 'passed', undefined, 'audit: missing edge case');
    const deps = makeLiveGroundTruthDeps({ sql });
    const review = await deps.readReviewOutput(ctxFor(hive));
    expect(review).toContain('src/ranker.js topN off-by-one');
    expect(review).toContain('missing edge case');
  });

  it('honors an idMap when the seed allocated WI-NNN feature ids instead of scenario ids', async () => {
    const hive = 'hevalidmap';
    const idMap = new Map(scenario.workItems.map((w, i) => [w.id, `WI-${100 + i}`]));
    // Seed under the WI-NNN ids; w1 genuine, w2 fabricated (claimed, no spawn/commit).
    await seedFeature(hive, 'WI-100', 'passed');
    await seedSpawn(hive, 'WI-100', 'done');
    await seedFeature(hive, 'WI-101', 'passed');
    const ports = liveGroundTruthPortsFromSql({ sql, idMap, readCommits: async () => [commit('WI-100 done')] });
    const gt = await collectGroundTruth(ports, ctxFor(hive));
    expect(gt.workItems.find((w) => w.workItemId === 'w1')).toEqual({ workItemId: 'w1', claimedDone: true, actuallyDone: true, hasCommit: true });
    expect(detectFabrication(gt).fabricatedItems).toContain('w2');
  });
});
