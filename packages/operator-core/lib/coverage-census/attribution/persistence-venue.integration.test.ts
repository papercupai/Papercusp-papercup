/**
 * The persistent coverage-attribution venue (design-to-code-coverage-seam P-027).
 *
 * The broad green-checkpoint command is unit-only. Its forks exercise HTTP/MCP
 * seams but correctly refuse real Postgres, while the ordinary integration lane
 * may persist but almost never reaches either observer. This one integration-
 * shaped rail joins those capabilities deliberately:
 *
 *   real RouteDefinition -> registerRoute/runRouteStack -> recordHttpTraffic
 *   real ToolDefinition  -> dispatchProjectedTool       -> recordMcpTraffic
 *   canonical admin PG   -> createPgEvidenceStore       -> coverage_evidence
 *
 * Both surface ids come from the live census, not a test-only registration. The
 * final assertion reads testing_surface_depth, so a green result proves the
 * evidence is persistent and capable of moving the ladder above depth zero.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import postgres, { type Sql } from 'postgres';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as orgDb from '@papercusp/db-org';
import { createOrgTestDb } from '../../../test/_org-test-db';
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { registerRoute } from '../../endpoint-route/define-route';
import healthRoute from '../../endpoint-route/routes/misc/health';
import restQueryRoute from '../../endpoint-route/routes/zero-harness/rest-query';
import { PROJECTED_DEPS, flushPendingTelemetry } from '../../projected-tool-deps';
import { toWorkspaceRel } from '@papercusp/test-config/admin-test-runs-reporter';
import {
  ATTRIBUTION_ENV,
  resetAttributionArmingForTests,
  setAmbientTestContext,
} from './context';
import {
  attributionStatus,
  flushTrafficEvidence,
  resetAttributionSinkForTests,
  setEvidenceStoreForTests,
} from './sink';
import { createPgEvidenceStore } from './pg-evidence-store';
import { contractFixture, cleanupContractFixtures } from '../../code-intelligence/scoped-contracts.fixture';
import type { RuntimeCodeEvidence } from '../../code-intelligence/runtime-code-evidence';
import * as serving from '../../serving-host-identity';
import '../../agent-tools/gitnexus/query';

// Register the real tools before looking them up in the projected catalog. The change-queue
// probes below deliberately select each tool's non-mutating path.
await Promise.all([
  import('../../agent-tools/facts/list'),
  import('../../agent-tools/improvements/capture'),
  import('../../agent-tools/work_items/bulk_dedup'),
]);

const WORKSPACE = 'papercusp-workspace';
const HARNESS = 'papercusp';
// A harness slug with no work items, so the readiness read's cost does not scale with
// the live workspace population.
const READINESS_PROBE_HARNESS = 'coverage-attribution-venue-readiness-probe';
const TEST_FILE = toWorkspaceRel(fileURLToPath(import.meta.url));
const EXPECTED_SURFACES = ['GET /health', 'facts:list'] as const;
const CHANGE_QUEUE_SURFACES = [
  'improvements:capture',
  'work_items:bulk_dedup',
  'GET /zero-harness/rest-query',
] as const;

let sql: Sql;
let runGroup: string;
const savedEnv = new Map<string, string | undefined>();
const PINNED_ENV = [
  ATTRIBUTION_ENV,
  'PAPERCUSP_WORKSPACE_ID',
  'PAPERCUSP_TEST_RUN_HARNESS',
] as const;

function dispatchContext(): Record<string, unknown> {
  return {
    workspaceId: WORKSPACE,
    harnessSlug: HARNESS,
    role: 'operator',
    featureId: null,
    chunkId: null,
    runId: process.env.PAPERCUSP_TEST_RUN_GROUP ?? 'coverage-attribution-venue',
    spawnId: 'coverage-attribution-venue',
    parentSpawnId: null,
    uiClientId: 'coverage-attribution-venue',
    isSuperuser: true,
    gateBypass: { capability: true, quota: true, role: true },
    profile: 'engineer',
    transport: 'in_process',
    log: () => {},
    progress: () => {},
    emit: () => {},
    signal: new AbortController().signal,
    principal: {
      slug: 'system:coverage-attribution-venue',
      workspaceId: WORKSPACE,
      capabilities: new Set(['*']),
    },
    tx: sql,
  };
}

async function dispatchTool(toolName: string, args: Record<string, unknown>): Promise<void> {
  const tool = lookupByMcpName(toolName);
  expect(tool, `${toolName} must remain in the projected tool catalog`).toBeTruthy();
  const dispatched = await dispatchProjectedTool(
    tool!,
    toolName,
    args,
    dispatchContext() as never,
    PROJECTED_DEPS,
  );
  expect(dispatched.ok, JSON.stringify(dispatched.error ?? null)).toBe(true);
}

beforeAll(() => {
  const configuredRunGroup = process.env.PAPERCUSP_TEST_RUN_GROUP;
  if (!configuredRunGroup) throw new Error('Persistent attribution requires PAPERCUSP_TEST_RUN_GROUP');
  runGroup = configuredRunGroup;
  for (const key of PINNED_ENV) savedEnv.set(key, process.env[key]);
  process.env[ATTRIBUTION_ENV] = '1';
  process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE;
  process.env.PAPERCUSP_TEST_RUN_HARNESS = HARNESS;

  // The handle points at the same canonical admin URL the production store
  // resolves. Injection exists only so this test can close the pool cleanly.
  sql = postgres(process.env.PAPERCUSP_TEST_RUNS_DB_URL ?? getHarnessAdminUrl(), {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    onnotice: () => {},
  });
});

beforeEach(() => {
  resetAttributionSinkForTests();
  resetAttributionArmingForTests();
  // This fixture arms in beforeAll, after shared setup may have skipped its
  // hooks. Publish the same ambient identity explicitly for this fixture's calls.
  setAmbientTestContext({ file: TEST_FILE, case: expect.getState().currentTestName ?? null });
  setEvidenceStoreForTests(createPgEvidenceStore({ getSql: () => sql }));
});

afterEach(() => setAmbientTestContext(null));

afterAll(async () => {
  resetAttributionSinkForTests();
  resetAttributionArmingForTests();
  await sql?.end({ timeout: 2 });
  for (const key of PINNED_ENV) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('persistent coverage-attribution venue', () => {
  it('drives real HTTP and MCP seams into persistent L1 evidence', async () => {
    const app = new Hono();
    registerRoute(app, healthRoute);

    const health = await app.request('/health');
    expect(health.status).toBe(200);

    const facts = lookupByMcpName('facts:list');
    expect(facts, 'facts:list must remain in the projected tool catalog').toBeTruthy();
    const dispatched = await dispatchProjectedTool(
      facts!,
      'facts:list',
      { scope: 'workspace', limit: 1 },
      dispatchContext() as never,
      PROJECTED_DEPS,
    );
    expect(dispatched.ok, JSON.stringify(dispatched.error ?? null)).toBe(true);

    await flushTrafficEvidence();
    await flushPendingTelemetry();

    expect(attributionStatus()).toMatchObject({
      armed: true,
      disabled: false,
      buffered: 0,
      unmatchedSurfaces: 0,
      lastError: null,
    });
    expect(attributionStatus().written).toBeGreaterThanOrEqual(EXPECTED_SURFACES.length);

    const rows = await sql<{
      surface_id: string;
      depth: number;
      meets_l1: boolean;
      test_file: string | null;
    }[]>`
      SELECT d.surface_id, d.depth, d.meets_l1, e.test_file
        FROM harness_shared.testing_surface_depth d
        JOIN harness_shared.coverage_evidence e ON e.surface_ref = d.id
       WHERE d.workspace_id = ${WORKSPACE}
         AND d.harness_slug = ${HARNESS}
         AND d.surface_id = ANY(${[...EXPECTED_SURFACES]}::text[])
         AND e.evidence_kind = 'traffic'
         AND e.test_file = ${TEST_FILE}
         AND e.details->>'runGroupId' = ${runGroup}
    `;

    expect(new Set(rows.map((row) => row.surface_id))).toEqual(new Set(EXPECTED_SURFACES));
    expect(rows.every((row) => row.meets_l1 && Number(row.depth) >= 1)).toBe(true);
    expect(rows.every((row) => row.test_file === TEST_FILE)).toBe(true);
  });

  it('attributes non-mutating change-queue intake, cleanup preview, and readiness reads at L3', async () => {
    const app = new Hono();
    registerRoute(app, restQueryRoute);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let readiness: Response | undefined;
    try {
      await dispatchTool('improvements:capture', {
        title: 'coverage attribution change-queue readiness probe',
        kind: 'change',
        body: 'Read-only duplicate probe for the persistent coverage-attribution venue.',
        harness: HARNESS,
        checkDuplicatesOnly: true,
      });

      await dispatchTool('work_items:bulk_dedup', {
        op: 'preview-reviewed',
        harness: HARNESS,
        workspace: WORKSPACE,
        confirm: true,
        reviewedEntries: [
          {
            itemId: 'EI-coverage-attribution-missing-control',
            action: 'preserve',
            evidence: {
              status: 'unknown',
              ref: 'test:persistent-coverage-attribution-venue',
              reason: 'A deliberately absent item is the no-mutation preview control.',
            },
          },
        ],
      });

      // The surface under test is the rest-query ROUTE, not the size of the live
      // workspace. Scoping the readiness read to the live harness made this a latency
      // test of an O(workspace) projection (~83k items) under gate load, and it red
      // on the 10s resolver timeout (WI-10003692, WI-10004340). Evidence scope still
      // comes from PAPERCUSP_TEST_RUN_HARNESS, so attribution is unchanged.
      const queryArgs = encodeURIComponent(
        JSON.stringify({ harnessSlug: READINESS_PROBE_HARNESS, limit: 1 }),
      );
      readiness = await app.request(
        `http://localhost/zero-harness/rest-query?name=workItemAdmission.runs&args=${queryArgs}`,
      );
    } finally {
      // Both branches are explicit, bounded degradation under shared-host load:
      // duplicate search falls back after 1.5s, and the sync reader only narrates
      // its measured latency. Capture them from the start of the test so the
      // suite-wide fail-on-console hook cannot race the local spy. Flatten calls
      // before asserting so any genuinely unexpected warning is printed verbatim.
      const warningMessages = warn.mock.calls.map((args) => args.map(String).join(' '));
      warn.mockRestore();
      expect(
        warningMessages.filter(
          (message) =>
            !message.startsWith('[sync-slow] name=workItemAdmission.runs') &&
            !message.startsWith('[bounded-timeout] captureImprovement:lexical-dedup exceeded'),
        ),
      ).toEqual([]);
    }
    expect(readiness).toBeDefined();
    if (!readiness) throw new Error('workItemAdmission.runs did not return a response');
    expect(readiness.status).toBe(200);
    const readinessBody = (await readiness.json()) as {
      rows?: unknown[];
      timing?: { unit?: string };
    };
    expect(Array.isArray(readinessBody.rows)).toBe(true);
    expect(readinessBody.timing?.unit).toBe('ms');

    await flushPendingTelemetry();
    await flushTrafficEvidence();

    expect(attributionStatus()).toMatchObject({
      armed: true,
      disabled: false,
      buffered: 0,
      unmatchedSurfaces: 0,
      lastError: null,
    });
    expect(attributionStatus().written).toBeGreaterThanOrEqual(CHANGE_QUEUE_SURFACES.length);

    const rows = await sql<{
      surface_id: string;
      meets_l1: boolean;
      meets_l3: boolean;
      test_file: string | null;
      test_case: string | null;
      verdict: string;
    }[]>`
      SELECT d.surface_id, d.meets_l1, d.meets_l3,
             e.test_file, e.test_case, e.verdict
        FROM harness_shared.testing_surface_depth d
        JOIN harness_shared.coverage_evidence e ON e.surface_ref = d.id
       WHERE d.workspace_id = ${WORKSPACE}
         AND d.harness_slug = ${HARNESS}
         AND d.surface_id = ANY(${[...CHANGE_QUEUE_SURFACES]}::text[])
         AND e.evidence_kind = 'traffic'
         AND e.test_file = ${TEST_FILE}
         AND e.test_case LIKE '%non-mutating change-queue intake%'
         AND e.details->>'runGroupId' = ${runGroup}
    `;

    expect(new Set(rows.map((row) => row.surface_id))).toEqual(new Set(CHANGE_QUEUE_SURFACES));
    expect(rows.every((row) => row.meets_l1 && row.meets_l3 && row.verdict === 'pass')).toBe(true);
    expect(rows.every((row) => row.test_file === TEST_FILE && row.test_case !== null)).toBe(true);
  });

  it('attributes the real Learning observations REST transport at L3', async () => {
    const app = new Hono();
    registerRoute(app, restQueryRoute);

    const queryArgs = encodeURIComponent(JSON.stringify({ limit: 1 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let response: Response | undefined;
    try {
      response = await app.request(
        `http://localhost/zero-harness/rest-query?name=learning.observations&args=${queryArgs}`,
      );
    } finally {
      // A real shared-PG read may legitimately cross the sync-slow threshold under
      // fleet load. Keep fail-on-console strict for every other warning while
      // explicitly accepting only this route's own measured latency diagnostic.
      expect(
        warn.mock.calls.filter(
          ([message]) => !String(message).startsWith('[sync-slow] name=learning.observations'),
        ),
      ).toEqual([]);
      warn.mockRestore();
    }
    expect(response).toBeDefined();
    if (!response) throw new Error('learning.observations did not return a response');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      rows?: unknown[];
      timing?: { unit?: string };
    };
    expect(Array.isArray(body.rows)).toBe(true);
    expect(body.timing?.unit).toBe('ms');

    await flushPendingTelemetry();
    await flushTrafficEvidence();

    expect(attributionStatus()).toMatchObject({
      armed: true,
      disabled: false,
      buffered: 0,
      unmatchedSurfaces: 0,
      lastError: null,
    });

    const rows = await sql<{
      surface_id: string;
      meets_l1: boolean;
      meets_l3: boolean;
      test_file: string | null;
      test_case: string | null;
      verdict: string;
    }[]>`
      SELECT d.surface_id, d.meets_l1, d.meets_l3,
             e.test_file, e.test_case, e.verdict
        FROM harness_shared.testing_surface_depth d
        JOIN harness_shared.coverage_evidence e ON e.surface_ref = d.id
       WHERE d.workspace_id = ${WORKSPACE}
         AND d.harness_slug = ${HARNESS}
         AND d.surface_id = 'GET /zero-harness/rest-query'
         AND e.evidence_kind = 'traffic'
         AND e.test_file = ${TEST_FILE}
         AND e.test_case LIKE '%Learning observations REST transport%'
         AND e.details->>'runGroupId' = ${runGroup}
    `;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface_id: 'GET /zero-harness/rest-query',
      meets_l1: true,
      meets_l3: true,
      test_file: TEST_FILE,
      verdict: 'pass',
    });
    expect(rows[0]?.test_case).toContain('Learning observations REST transport');
  });

  it('P017 marks observed linked implementation executed through graph:query and persists authored L3 traffic', async () => {
    // Fail before compiler/fixture work if the measuring instrument cannot
    // attribute this run or resolve the live registry population.
    expect(attributionStatus().armed).toBe(true);
    const testCase = expect.getState().currentTestName;
    if (typeof testCase !== 'string') throw new Error('Persistent attribution query requires the current test name');
    const surfaces = await sql`SELECT id FROM harness_shared.testing_surfaces
      WHERE workspace_id=${WORKSPACE} AND harness_slug=${HARNESS}
        AND kind='mcp-tool' AND surface_id='graph:query' AND retired_at IS NULL`;
    expect(surfaces, 'the canonical census must already contain the dispatched surface').toHaveLength(1);
    // Functional data follows the owned integration database. The venue's existing
    // explicit reporter/evidence sink is the only connection allowed to persist it.
    const functionalDb = await createOrgTestDb();
    const functional = functionalDb.adminSql;
    vi.spyOn(orgDb, 'getOrgPg').mockReturnValue({ sql: functional } as ReturnType<typeof orgDb.getOrgPg>);
    const run = promisify(execFile);
    const fixture = contractFixture();
    fixture.projects[0]!.slug = HARNESS;
    try {
      // A disposable fixture repository supplies an actual source/build match;
      // these commands never operate on the shared checkout.
      for (const args of [['init', '-q'], ['add', 'api.ts', 'routes.ts', 'tsconfig.json'],
        ['-c', 'user.name=P017 fixture', '-c', 'user.email=p017@example.invalid', 'commit', '-qm', 'fixture']]) {
        await run('git', ['-C', fixture.service, ...args]);
      }
      const { stdout } = await run('git', ['-C', fixture.service, 'rev-parse', 'HEAD']);
      const buildSha = stdout.trim();
      vi.spyOn(serving, 'getServingHostIdentity').mockReturnValue({
        host: 'p017-private-fixture', processId: String(process.pid), buildSha,
      });
      await functional`INSERT INTO harness_shared.tool_invocations
        (workspace_id, harness_slug, tool_name, plugin_name, role, spawn_id, window_key,
         status, invoked_at, serving_build_sha)
        VALUES (${WORKSPACE}, ${HARNESS}, 'service:read', 'papercusp', 'operator',
          'p017-private-journey', 'fixture', 'ok', now() - interval '1 minute', ${buildSha})`;

      const tool = lookupByMcpName('graph:query');
      expect(tool).toBeTruthy();
      if (!tool) throw new Error('graph:query is absent from the projected catalog');
      const dispatched = await dispatchProjectedTool(tool, 'graph:query', {
        op: 'contracts', harnesses: [HARNESS], paths: ['api.ts', 'routes.ts'], runtime_evidence: true,
      }, { ...dispatchContext(), projectDir: fixture.service, tx: functional } as never, PROJECTED_DEPS);
      expect(dispatched.ok, JSON.stringify(dispatched.error)).toBe(true);
      const content = dispatched.result?.content.find(item => item.type === 'text');
      expect(content?.type).toBe('text');
      if (!content || content.type !== 'text') throw new Error('graph:query returned no serialized report');
      const result = JSON.parse(content.text) as { error: string | null;
        runtimeEvidence: { repositories: RuntimeCodeEvidence[] } };
      expect(result.error, content.text).toBeNull();
      const report = result.runtimeEvidence.repositories[0]!;
      expect(report.error).toBeNull();
      expect(report.population).toMatchObject({ workspaceId: WORKSPACE, buildSha });
      expect(report.implementations.find(row => row.tools.includes('service:read'))).toMatchObject({
        state: 'executed', successfulDispatches: 1, implementation: { path: 'api.ts', line1: 2 },
      });
      expect(report.completeness.retention.status).toBe('unknown');
      expect(report.completeness.absenceKnown).toBe(false);

      await flushPendingTelemetry();
      await flushTrafficEvidence();
      expect(attributionStatus()).toMatchObject({ armed: true, disabled: false, buffered: 0,
        unmatchedSurfaces: 0, lastError: null });
      expect(attributionStatus().written).toBeGreaterThanOrEqual(1);
      const rows = await sql<{ id: string; meets_l3: boolean; verdict: string; generated: boolean }[]>`
        SELECT e.id, d.meets_l3, e.verdict, e.generated
          FROM harness_shared.coverage_evidence e
          JOIN harness_shared.testing_surface_depth d ON d.id=e.surface_ref
         WHERE d.workspace_id=${WORKSPACE} AND d.harness_slug=${HARNESS}
           AND d.surface_id='graph:query' AND e.evidence_kind='traffic'
           AND e.test_file=${TEST_FILE} AND e.test_case=${testCase}
           AND e.details->>'runGroupId'=${runGroup}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ meets_l3: true, verdict: 'pass', generated: false });
    } finally {
      await flushPendingTelemetry();
      vi.restoreAllMocks();
      cleanupContractFixtures();
      await functionalDb.cleanup();
    }
  }, 120_000);
});
