import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { randomBytes, randomUUID } from 'node:crypto';
import { readRepoFile } from '@papercusp/test-config';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { createMetricsCollector, getMetricsSummary, getMetricsPercentiles } from './collectors';

describe('IQ Battery Metrics Collectors', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const adminUri = await getTestPg();
    const dbName = `iq_battery_${randomBytes(5).toString('hex')}`;
    const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe(`CREATE DATABASE "${dbName}"`);
      await markManagedTestDatabase(admin, dbName);
    } finally {
      await admin.end({ timeout: 5 });
    }
    const u = new URL(adminUri);
    u.pathname = `/${dbName}`;
    sql = postgres(u.toString(), { max: 8, onnotice: () => {} });

    await sql.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
    // Apply the migration DDL — depth-/machine-proof walk-up (DG-6 P-049).
    const ddl = readRepoFile(__dirname, 'libs/papercusp/libs/db/sql/179-iq-battery-corpus.sql');
    await sql.unsafe(ddl);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  beforeEach(async () => {
    // Clear tables before each test
    await sql.unsafe('TRUNCATE TABLE iq_battery_metrics, iq_battery_cases');
  });

  describe('Individual metric collectors', () => {
    it('collects success metric: true when status is done and not escalated', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'fix-injected-bug',
        workItemStatus: 'done',
        escalated: false,
      });
      expect(metrics.success).toBe(true);
    });

    it('collects success metric: false when status is not in completion set', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'fix-injected-bug',
        workItemStatus: 'open',
        escalated: false,
      });
      expect(metrics.success).toBe(false);
    });

    it('collects success metric: false when escalated', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'fix-injected-bug',
        workItemStatus: 'done',
        escalated: true,
      });
      expect(metrics.success).toBe(false);
    });

    it('collects tokens-per-solved-task: sum of input+output when successful', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'fix-injected-bug',
        workItemStatus: 'done',
        escalated: false,
        inputTokens: 100,
        outputTokens: 50,
      });
      expect(metrics.tokensPerSolvedTask).toBe(150);
    });

    it('collects tokens-per-solved-task: null when not successful', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'fix-injected-bug',
        workItemStatus: 'open',
        escalated: false,
        inputTokens: 100,
        outputTokens: 50,
      });
      expect(metrics.tokensPerSolvedTask).toBeNull();
    });

    it('collects time-to-green: seconds elapsed from created to resolved', async () => {
      const collector = await createMetricsCollector(sql);
      const created = new Date('2026-06-06T10:00:00Z');
      const resolved = new Date('2026-06-06T10:05:30Z');

      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'build-spec',
        workItemStatus: 'done',
        escalated: false,
        workItemCreatedAt: created,
        workItemResolvedAt: resolved,
      });

      expect(metrics.timeToGreenSecs).toBe(330); // 5.5 minutes
    });

    it('collects first-attempt-pass: true when attempts=1 and successful', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'find-the-flaw',
        workItemStatus: 'done',
        escalated: false,
        workItemAttempts: 1,
      });
      expect(metrics.firstAttemptPass).toBe(true);
    });

    it('collects first-attempt-pass: false when attempts > 1', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'find-the-flaw',
        workItemStatus: 'done',
        escalated: false,
        workItemAttempts: 3,
      });
      expect(metrics.firstAttemptPass).toBe(false);
    });

    it('collects escalation: true when escalated flag is set', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        escalated: true,
      });
      expect(metrics.escalation).toBe(true);
    });

    it('collects escalation: false when not escalated', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        escalated: false,
      });
      expect(metrics.escalation).toBe(false);
    });

    it('collects recall-hit: Jaccard similarity of retrieved vs expected sources', async () => {
      const collector = await createMetricsCollector(sql);

      // Perfect match: 2/2 sources match
      let metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        retrievedSources: ['doc-a', 'doc-b'],
        expectedSources: ['doc-a', 'doc-b'],
      });
      expect(metrics.recallHit).toBe(1.0);

      // Partial match: 1 retrieved correct, 1 extra, 1 missed
      metrics = await collector.collectMetrics({
        runId: 'run-2',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        retrievedSources: ['doc-a', 'doc-c'],
        expectedSources: ['doc-a', 'doc-b'],
      });
      expect(metrics.recallHit).toBeCloseTo(1 / 3, 1); // 1 match, 3 total unique

      // No match: different sources
      metrics = await collector.collectMetrics({
        runId: 'run-3',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        retrievedSources: ['doc-x', 'doc-y'],
        expectedSources: ['doc-a', 'doc-b'],
      });
      expect(metrics.recallHit).toBe(0);

      // Empty retrieved when empty expected: perfect match
      metrics = await collector.collectMetrics({
        runId: 'run-4',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        retrievedSources: [],
        expectedSources: [],
      });
      expect(metrics.recallHit).toBe(1.0);

      // Empty retrieved but expected sources: mismatch
      metrics = await collector.collectMetrics({
        runId: 'run-5',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        retrievedSources: [],
        expectedSources: ['doc-a'],
      });
      expect(metrics.recallHit).toBe(0);
    });

    it('stores metrics in database', async () => {
      // Table should already exist from migration
      // Just verify it exists before running test
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'iq_battery_metrics'
      `;
      if (tables.length === 0) {
        throw new Error('iq_battery_metrics table does not exist');
      }

      // run_id/case_id are UUID columns; case_id has an FK to iq_battery_cases
      const runId = randomUUID();
      const caseId = randomUUID();
      await sql`
        INSERT INTO iq_battery_cases (id, variant, title, prompt, ground_truth, rubric)
        VALUES (${caseId}, 'fix-injected-bug', 'store test case', 'p', '{}'::jsonb, '{}'::jsonb)
      `;

      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId,
        caseId,
        variant: 'fix-injected-bug',
        workItemStatus: 'done',
        escalated: false,
        inputTokens: 100,
        outputTokens: 50,
      });

      await collector.storeMetrics(metrics);

      // Verify stored (postgres-js returns the row array directly; numeric comes back as string)
      const result = await sql`
        SELECT success, tokens_per_solved_task
        FROM iq_battery_metrics
        WHERE run_id = ${runId}
      `;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(true);
      expect(Number(result[0].tokens_per_solved_task)).toBe(150);
    });
  });

  describe('Aggregation functions', () => {
    // case_id is a UUID with an FK to iq_battery_cases — seed the cases first
    const CASE_BUG = '650e8400-e29b-41d4-a716-446655440101';
    const CASE_SPEC = '650e8400-e29b-41d4-a716-446655440102';

    beforeEach(async () => {
      // Seed test data (table already exists from migration)
      await sql.unsafe(`
        INSERT INTO iq_battery_cases (id, variant, title, prompt, ground_truth, rubric) VALUES
          ('${CASE_BUG}', 'fix-injected-bug', 'agg case bug', 'p', '{}'::jsonb, '{}'::jsonb),
          ('${CASE_SPEC}', 'build-spec', 'agg case spec', 'p', '{}'::jsonb, '{}'::jsonb)
      `);
      await sql.unsafe(`
        INSERT INTO iq_battery_metrics
          (run_id, case_id, variant, success, tokens_per_solved_task, time_to_green_secs,
           first_attempt_pass, recurrence, escalation, recall_hit, collected_at)
        VALUES
          ('550e8400-e29b-41d4-a716-446655440001', '${CASE_BUG}', 'fix-injected-bug', true, 100, 60, true, 1, false, 0.9, NOW()),
          ('550e8400-e29b-41d4-a716-446655440002', '${CASE_BUG}', 'fix-injected-bug', true, 120, 70, false, 2, false, 0.8, NOW()),
          ('550e8400-e29b-41d4-a716-446655440003', '${CASE_BUG}', 'fix-injected-bug', false, null, null, false, 3, true, 0.5, NOW()),
          ('550e8400-e29b-41d4-a716-446655440004', '${CASE_SPEC}', 'build-spec', true, 200, 120, true, 1, false, 0.95, NOW()),
          ('550e8400-e29b-41d4-a716-446655440005', '${CASE_SPEC}', 'build-spec', true, 220, 140, false, 2, false, 0.85, NOW())
      `);
    });

    it('computes summary metrics per variant', async () => {
      const summary = await getMetricsSummary(sql, 'fix-injected-bug');
      expect(summary.length).toBeGreaterThan(0);
      const bugVariant = summary[0] as any;

      expect(bugVariant.variant).toBe('fix-injected-bug');
      // count() comes back from PG as a bigint string
      expect(Number(bugVariant.success_count)).toBe(2);
      expect(Number(bugVariant.total_count)).toBe(3);
      expect(parseFloat(bugVariant.success_rate)).toBeCloseTo(66.67, 1);
      expect(parseFloat(bugVariant.avg_tokens)).toBeCloseTo(110, 0);
      // first_attempt_rate is over ALL attempts (1 of 3), same denominator as success_rate
      expect(parseFloat(bugVariant.first_attempt_rate)).toBeCloseTo(33.33, 1);
      expect(parseFloat(bugVariant.escalation_rate)).toBeCloseTo(33.33, 1);
    });

    it('filters summary by variant', async () => {
      const summary = await getMetricsSummary(sql);
      expect(summary.length).toBe(2); // Two variants

      const buildSpec = (summary as any[]).find((row: any) => row.variant === 'build-spec');
      expect(buildSpec).toBeDefined();
      expect(Number(buildSpec?.success_count)).toBe(2);
      expect(Number(buildSpec?.total_count)).toBe(2);
    });

    it('computes percentile distributions', async () => {
      const percentiles = await getMetricsPercentiles(sql, 'fix-injected-bug');
      expect(percentiles.length).toBeGreaterThan(0);
      const bugVariant = percentiles[0] as any;

      expect(bugVariant.variant).toBe('fix-injected-bug');
      // percentile_cont interpolates: over {100,120} p50=110, p95=119; over {60,70} p50=65, p95=69.5
      expect(Number(bugVariant.p50_tokens)).toBe(110);
      expect(Number(bugVariant.p95_tokens)).toBe(119);
      expect(Number(bugVariant.p50_time_secs)).toBe(65);
      expect(Number(bugVariant.p95_time_secs)).toBe(69.5);
    });
  });

  describe('Edge cases', () => {
    it('handles missing token data gracefully', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'fix-injected-bug',
        workItemStatus: 'done',
        escalated: false,
        // Missing inputTokens and outputTokens
      });
      expect(metrics.tokensPerSolvedTask).toBeNull();
    });

    it('handles missing date data gracefully', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'build-spec',
        workItemStatus: 'done',
        escalated: false,
        // Missing dates
      });
      expect(metrics.timeToGreenSecs).toBeNull();
    });

    it('handles undefined arrays in recall-hit calculation', async () => {
      const collector = await createMetricsCollector(sql);
      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'answer-from-colony-memory',
        // Missing retrievedSources and expectedSources
      });
      expect(metrics.recallHit).toBe(0);
    });

    it('computes accurate time differences across date boundaries', async () => {
      const collector = await createMetricsCollector(sql);
      const created = new Date('2026-06-05T23:00:00Z');
      const resolved = new Date('2026-06-06T01:00:00Z');

      const metrics = await collector.collectMetrics({
        runId: 'run-1',
        caseId: 'case-1',
        variant: 'find-the-flaw',
        workItemStatus: 'done',
        escalated: false,
        workItemCreatedAt: created,
        workItemResolvedAt: resolved,
      });

      expect(metrics.timeToGreenSecs).toBe(7200); // 2 hours
    });
  });
});
