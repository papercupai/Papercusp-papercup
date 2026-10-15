import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { lookupByMcpName, listAllProjectedTools } from '@papercusp/tooldef';
import { _resetForTests } from '@papercusp/db-org';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { orgTemplateKey, provisionOrgTemplate } from '../../test/_org-test-db';
import { flushFallbackObservations } from '../degradation/fallback-observations';
import { buildSidecarAwareReranker, resolveProcessSidecarUrl } from '../memory/embed-sidecar-wiring';
import { isEmbedSidecarRunning, probeSidecarHealth, readEmbedSidecarRecord, stopEmbedSidecar } from '../memory/embed-sidecar-spawn';
import { scoreSubjectEvidence, subjectEvidenceQuery, SUBJECT_EVIDENCE_MIN_SCORE } from './relevance-router';
import { evaluateSubjectCases, HELD_OUT_SUBJECT_CASES, NATURAL_QUESTION_SUBJECT_CASES } from './subject-evidence.fixtures';
import '../agent-tools/index';

describe('registered subject evidence with the real local scorer', () => {
  let configuredPrivateWarmup = false;
  let privateHome: string | undefined;
  let privateDb: MigratedTestDb | undefined;
  const savedHome = process.env.PAPERCUSP_HOME;
  const savedPort = process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
  const savedEnable = process.env.PAPERCUSP_EMBED_SIDECAR;
  const databaseEnvKeys = ['HARNESS_ADMIN_DATABASE_URL', 'HARNESS_DATABASE_URL',
    'DATABASE_URL', 'PAPERCUSP_PGBOUNCER', 'PAPERCUSP_SKIP_PG_DISCOVERY'] as const;
  const savedDatabaseEnv = databaseEnvKeys.map(key => [key, process.env[key]] as const);
  beforeAll(async () => {
    // A plain test:file invocation must exercise an owned source runtime too.
    // Preserve explicit in-process/shared-runtime choices as distinct evidence.
    if (savedEnable === undefined && !process.env.PAPERCUSP_EMBED_SIDECAR_URL) {
      process.env.PAPERCUSP_EMBED_SIDECAR = '1';
    }
    // A scorer-only test owns its lazily spawned sidecar. The default Gemma
    // startup is unrelated to this fixture and can overlap the first bounded
    // measurements. Reuse the maintained reranker-only warm profile; explicit
    // shared-sidecar URLs and caller-selected profiles retain their settings.
    if (process.env.PAPERCUSP_EMBED_SIDECAR === '1' &&
        !process.env.PAPERCUSP_EMBED_SIDECAR_URL) {
      // This test changes the product DB URL so its spawned sidecar cannot
      // escape into the live/native database. Retire any process-wide pools
      // created during module setup before changing that target.
      await _resetForTests();
      // No explicit URL does not imply a private scorer: the spawner otherwise
      // adopts a sibling from the tenant's home or its inherited fixed port.
      // Reuse its maintained tenant boundary so this run executes source code.
      privateHome = mkdtempSync(join(tmpdir(), 'subject-scorer-'));
      process.env.PAPERCUSP_HOME = privateHome;
      delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
      // The non-Vitest child opens the admission governor's real PG pool.
      // An ambient explicit DSN outranks the wrapper's private port, so pin
      // every product resolver to an owned, fully migrated database instead.
      privateDb = await createFreshTestDb({ prefix: 'subjectscorer', template: {
        key: orgTemplateKey(), provision: provisionOrgTemplate,
      } });
      process.env.HARNESS_ADMIN_DATABASE_URL = privateDb.url;
      process.env.HARNESS_DATABASE_URL = privateDb.url;
      process.env.DATABASE_URL = privateDb.url;
      process.env.PAPERCUSP_PGBOUNCER = '0';
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      if (process.env.PAPERCUSP_EMBED_SIDECAR_WARM === undefined) {
        process.env.PAPERCUSP_EMBED_SIDECAR_WARM = 'rerank';
        configuredPrivateWarmup = true;
      }
    }
  }, 120_000);
  afterAll(async () => {
    if (privateHome) {
      try {
        await stopEmbedSidecar();
      } finally {
        try {
          // Fallback observations are deferred on a timer. Flush them while
          // their private DB still exists, then clear its pools before restoring
          // the process environment so no later flush rebinds or targets a
          // dropped test database.
          await flushFallbackObservations();
        } finally {
          try {
            await _resetForTests();
          } finally {
            try {
              await privateDb?.drop();
            } finally {
              for (const [key, value] of savedDatabaseEnv) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
              if (savedHome === undefined) delete process.env.PAPERCUSP_HOME;
              else process.env.PAPERCUSP_HOME = savedHome;
              if (savedPort === undefined) delete process.env.PAPERCUSP_EMBED_SIDECAR_PORT;
              else process.env.PAPERCUSP_EMBED_SIDECAR_PORT = savedPort;
              if (configuredPrivateWarmup) delete process.env.PAPERCUSP_EMBED_SIDECAR_WARM;
              rmSync(privateHome, { recursive: true, force: true });
            }
          }
        }
      }
    }
    if (configuredPrivateWarmup) delete process.env.PAPERCUSP_EMBED_SIDECAR_WARM;
    if (savedEnable === undefined) delete process.env.PAPERCUSP_EMBED_SIDECAR;
    else process.env.PAPERCUSP_EMBED_SIDECAR = savedEnable;
  });

  it('measures labelled held-out top choice, recall and explicit no-expert outcomes', async () => {
    for (const name of ['computer:provision_desktop', 'computer:observe', 'db:migrate']) {
      expect(lookupByMcpName(name)?.description).toBeTruthy();
    }
    expect(listAllProjectedTools().length).toBeGreaterThan(100);
    const url = await resolveProcessSidecarUrl(undefined, ['POST /rerank']);
    const health = url ? await (await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) })).json() : null;
    const runtime = { endpoint: url, engine: url ? 'sidecar' : 'in-process',
      warmProfile: process.env.PAPERCUSP_EMBED_SIDECAR_WARM ?? 'default',
      build: health?.sha ?? null, modelState: health?.models?.rerank ?? null,
      execution: health?.rerankExecutionHealth?.active ?? null };
    console.info('subject-scorer-preflight', JSON.stringify(runtime));
    if (privateHome) {
      // Fail before measurements if a shared/installed runtime was adopted.
      expect(isEmbedSidecarRunning(), 'owned scorer must be spawned by this test').toBe(true);
      const record = readEmbedSidecarRecord();
      expect(record?.port, 'owned launch record must name the serving endpoint').toBe(Number(new URL(url!).port));
      expect(Number.isInteger(health?.pid)).toBe(true);
      if (process.platform === 'linux') {
        // Source launches use npx -> tsx -> node; the record names npx,
        // while health names node. Verify the actual ancestry, not PID equality.
        const ancestry: number[] = [];
        let pid = health.pid as number;
        for (let depth = 0; depth < 8 && pid > 1; depth++) {
          ancestry.push(pid);
          if (pid === record?.pid) break;
          const status = readFileSync(`/proc/${pid}/status`, 'utf8');
          pid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
        }
        console.info('subject-scorer-ownership', JSON.stringify({ launchPid: record?.pid, ancestry }));
        expect(ancestry, 'serving scorer must descend from the owned launch').toContain(record?.pid);
      }
      expect(privateDb?.name).toMatch(/^subjectscorer_/);
      expect(process.env.HARNESS_ADMIN_DATABASE_URL).toBe(privateDb?.url);
    }
    const failures: { contracts: string[]; reason: string }[] = [];
    const baseScorer = await buildSidecarAwareReranker();
    const scorer: typeof baseScorer = async (query, contracts, opts) => {
      try {
        const scores = await baseScorer(query, contracts, opts);
        console.info('subject-contract-scores', JSON.stringify({ contracts: contracts.map(c => c.split('\n')[0]), scores }));
        if (contracts[0]?.includes('?')) {
          console.info('subject-natural-contract-pairs', JSON.stringify({ passage: query, contracts, scores }));
        }
        return scores;
      } catch (error) {
        const failure = { contracts: contracts.map(c => c.split('\n')[0]),
          reason: error instanceof Error ? error.message.slice(0, 300) : 'unknown' };
        failures.push(failure);
        console.info('subject-contract-unavailable', JSON.stringify(failure));
        throw error;
      }
    };
    // Cold model construction is an evaluation prerequisite, not time granted
    // to production qualification. Every measured scenario retains its 4s cap.
    const warmStart = Date.now();
    try {
      if (url && privateHome && process.env.PAPERCUSP_EMBED_SIDECAR_WARM?.split(',').includes('rerank')) {
        // READY means the socket is listening; models.warm means construction
        // finished. Await the first governed boot inference as well, so its
        // admission cannot consume the bounded scoring prerequisite.
        let lastState: string | undefined;
        const readyState = await vi.waitUntil(async () => {
          const readyHealth = await probeSidecarHealth(url, 5000) as {
            models?: Record<string, string>; warmups?: Record<string, string>;
          } | null;
          const state = readyHealth ? readyHealth.warmups?.rerank ?? 'absent' : 'unavailable';
          if (state !== lastState) {
            console.info('subject-scorer-model-transition', JSON.stringify({ elapsedMs: Date.now() - warmStart,
              state, construction: readyHealth?.models?.rerank ?? null }));
            lastState = state;
          }
          return state === 'warm' || state === 'failed' ? state : false;
        }, { timeout: 120_000, interval: 250 });
        expect(readyState, 'owned boot reranker must finish its first inference before scoring').toBe('warm');
      }
      await scorer('SQL migration file', ['Apply a numbered PostgreSQL DDL transaction.'], { deadline: Date.now() + 15_000 });
    } catch (error) {
      // Preserve the distinction between model construction and admission before
      // teardown removes the owned process and database. Never infer either
      // from endpoint liveness or a missing model slot alone.
      console.info('subject-scorer-failed-health', JSON.stringify(url ? await probeSidecarHealth(url, 5000) : null));
      if (privateDb) {
        const sql = postgres(privateDb.url, { max: 1, connect_timeout: 5, onnotice: () => {} });
        try {
          await sql`SET statement_timeout = '5000ms'`;
          const admissions = await sql`
            SELECT receipt_id, record
            FROM harness_shared.resource_governor_admissions
            ORDER BY receipt_id LIMIT 8
          `;
          const activity = await sql`
            SELECT state, wait_event_type, wait_event, left(query, 200) AS query
            FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
            LIMIT 8
          `;
          console.info('subject-scorer-failed-admission', JSON.stringify({ database: privateDb.name, admissions, activity }));
        } catch (diagnosticError) {
          console.info('subject-scorer-diagnostic-unavailable', String(diagnosticError));
        } finally {
          await sql.end({ timeout: 5 });
        }
      }
      throw error;
    }
    console.info('subject-scorer-ready', JSON.stringify({ warmupMs: Date.now() - warmStart }));
    const naturalMeasurements = [];
    for (const scenario of NATURAL_QUESTION_SUBJECT_CASES) {
      // Keep the production direction separate from this diagnostic. The same
      // primary question and passages, on the same owned runtime, distinguish
      // a query/document representation error from missing contrast contracts.
      const primary = subjectEvidenceQuery(scenario.subject)!;
      const forward = await scorer(primary, scenario.passages.map(p => p.text), { deadline: Date.now() + 4000 });
      console.info('subject-natural-forward-pairs', JSON.stringify({ id: scenario.id, query: primary,
        passages: scenario.passages, scores: forward }));
      const scores = await scoreSubjectEvidence(scenario.subject, scenario.passages.map(p => p.text),
        Date.now() + 4000, { scorer });
      naturalMeasurements.push({ id: scenario.id, scores });
    }
    const natural = evaluateSubjectCases(naturalMeasurements, SUBJECT_EVIDENCE_MIN_SCORE,
      NATURAL_QUESTION_SUBJECT_CASES);
    console.info('subject-natural-question-metrics', JSON.stringify(natural.cases));
    console.info('subject-natural-question-summary', JSON.stringify(natural.summary));
    const measurements = [];
    for (const scenario of HELD_OUT_SUBJECT_CASES) {
      const scores = await scoreSubjectEvidence(scenario.subject, scenario.passages.map(p => p.text), Date.now() + 4000, { scorer });
      measurements.push({ id: scenario.id, scores });
    }
    // Persisted in the normal Vitest evidence; labels and full population are
    // independent of score/ranking. Empty-truth cases are assessed separately,
    // rather than misreading the shared evaluator's null recall as zero.
    const { cases: measured, summary } = evaluateSubjectCases(measurements, SUBJECT_EVIDENCE_MIN_SCORE);
    console.info('subject-held-out-metrics', JSON.stringify(measured));
    console.info('subject-held-out-summary', JSON.stringify(summary));
    expect(natural.summary.unavailable, 'natural-question measurements must be available').toBe(0);
    expect(natural.cases[0].selected).toEqual(['lease-auditor']);
    expect(natural.cases[1].selected).toEqual([]);
    expect(natural.summary.falseExpertSelections).toBe(0);
    const positives = measured.filter(r => r.relevant.length);
    const negatives = measured.filter(r => !r.relevant.length);
    expect(summary.unavailable, `all labelled measurements must be available: ${JSON.stringify({ runtime, failures })}`).toBe(0);
    expect(positives[0].selected[0]).toBe('display-repair');
    expect(negatives[0].selected).toEqual([]);
    expect(summary.topChoicePrecision).toBeGreaterThanOrEqual(2 / 3);
    expect(summary.recallAt1).toBeGreaterThanOrEqual(2 / 3);
    expect(summary.falseExpertSelections, 'irrelevant alternatives must not enter the responder menu').toBe(0);
    expect(negatives.filter(r => r.selected.length)).toEqual([]);
  }, 180_000);
});
