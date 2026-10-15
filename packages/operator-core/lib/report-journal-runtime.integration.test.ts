/** R8: automatic journal ingestion, detector and observation storage against private migrated PG. */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import { disposeBaselineCoordFixture, setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';

// Other turn-end duties are outside this Reports contract. Transcript parsing,
// journal SQL, the bounded Reports detector, publication lookup and filing stay real.
vi.mock('./goal-placement-turn-receipts', () => ({
  boundedRecordGoalPlacementTurnEnd: async () => ({ recorded: false, reason: 'no-canonical-goal' }),
}));
vi.mock('./turn-provenance/turn-ref', () => ({ resolveCurrentTurnStamp: async () => null }));
vi.mock('./turn-end-tracking-io', async original => {
  const actual = await original<typeof import('./turn-end-tracking-io')>();
  return {
    ...actual,
    boundedArtifactSweep: async () => null,
    boundedOpenTaskReminderSweep: async () => null,
    boundedUnguardedHaltSweep: async () => null,
    boundedAutoCheckpoint: async () => [],
    boundedCoordWatermarkSettle: async () => null,
    // Observe completion of the real detached callback before fixture teardown.
    boundedUnpublishedReportTurn: vi.fn(actual.boundedUnpublishedReportTurn),
  };
});

const { createOrgTestDb } = await import('../test/_org-test-db');
const { activeWorkspaceId } = await import('./workspace-registry');
const { FILE_ADAPTERS } = await import('./search/session-ingest');
const { drainDetached } = await import('./detached-imports');
const { publishReport } = await import('./report-library');
const io = await import('./turn-end-tracking-io');
const observer = vi.mocked(io.boundedUnpublishedReportTurn);
const { default: journal } = await import('./agent-tools/journal/record-turn');

/** Narrow a tool result union to its `data` payload; a result without one fails the test. */
function responseData(result: object): unknown {
  if (!('data' in result)) throw new Error('tool result carried no data payload');
  return result.data;
}

const body = '# Architecture audit\n\n## Findings\n' + 'Measured architecture evidence. '.repeat(24)
  + '\n\n## Verdict\nThe fixture audit is complete.';

describe('Reports automatic journal runtime against migrated private PostgreSQL', () => {
  let db: OrgTestDb;
  let routing: BaselineCoordFixture | undefined;
  let transcriptRoot: string;
  beforeAll(async () => {
    db = await createOrgTestDb();
    routing = await setupBaselineCoordFixture({ dsn: db.adminDsn });
    // Vitest transforms lazy modules on first import. Prepare the real graph
    // before measuring a callback whose production budget is four seconds.
    const loaderStartedAt = performance.now();
    await Promise.all([import('./harness/improvements/capture-core'), import('./agent-tools/reports/_shared')]);
    console.info(`REPORTS_JOURNAL_FIXTURE modulePreparationMs=${Math.round(performance.now() - loaderStartedAt)}`);
    transcriptRoot = await mkdtemp(join(tmpdir(), 'reports-journal-runtime-'));
    const adapter = FILE_ADAPTERS.find(candidate => candidate.sourceKind === 'codex');
    if (!adapter) throw new Error('Reports journal fixture requires the registered Codex adapter');
    // Relocate only the allowed transcript root; use the production parser and resolver.
    vi.spyOn(adapter, 'roots').mockReturnValue([{ root: transcriptRoot, dirDepth: 0 }]);
  }, 180_000);
  afterEach(async () => {
    for (const result of observer.mock.results) if (result.type === 'return') await result.value;
    observer.mockClear();
    await drainDetached();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await drainDetached();
    await disposeBaselineCoordFixture(routing);
    await db?.cleanup();
    if (transcriptRoot) await rm(transcriptRoot, { recursive: true, force: true });
  });

  async function turn(text = body) {
    vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '1');
    vi.stubEnv('PAPERCUSP_AMBIENT_CURSOR', '0');
    const sessionId = randomUUID();
    const ownerId = `su-reports-journal-${sessionId}`;
    const timestamp = new Date().toISOString();
    const file = join(transcriptRoot, `rollout-${sessionId}.jsonl`);
    await writeFile(file, JSON.stringify({ timestamp, type: 'response_item', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text }],
    } }) + '\n');
    return { sessionId, ownerId, timestamp, file, workspaceId: activeWorkspaceId() };
  }

  function ingest(input: Awaited<ReturnType<typeof turn>>) {
    return journal.handler({ owner: input.ownerId, agent: 'codex', session_id: input.sessionId,
      source_kind: 'codex', transcript_path: input.file, harness: 'papercusp' }, {
      uiClientId: input.ownerId, isSuperuser: true, workspaceId: input.workspaceId, harnessSlug: 'papercusp',
    } as never);
  }

  async function observations(input: Awaited<ReturnType<typeof turn>>) {
    const turnRef = `${input.sessionId}:${input.timestamp}`;
    const key = `unpublished-report:${createHash('sha256').update(turnRef).digest('hex')}`;
    return db.adminSql`SELECT issue_id, state, created_by, body, payload FROM harness_shared.engineer_issues
      WHERE payload->>'watchdogKey' = ${key}`;
  }

  async function finishObservation() {
    await vi.waitFor(() => expect(observer).toHaveBeenCalledTimes(1));
    return observer.mock.results[0].value;
  }

  it('automatically records exact journal provenance and files one terminal unpublished-report observation', async () => {
    const input = await turn();
    expect(await ingest(input)).toMatchObject({ data: { ok: true, recorded: true,
      turn_ts: input.timestamp, unpublishedReportObservationScheduled: true } });
    expect(await finishObservation()).toBe(true);
    const rows = await observations(input);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: 'done', created_by: input.ownerId, payload: { lane: 'observation' } });
    expect(rows[0].body).toContain(`${input.sessionId}:${input.timestamp}`);
    expect(await db.adminSql`SELECT workspace_id, owner_id, source_kind, session_id, harness_slug
      FROM harness_shared.session_turn_journal WHERE session_id = ${input.sessionId}`).toEqual([
      { workspace_id: input.workspaceId, owner_id: input.ownerId, source_kind: 'codex',
        session_id: input.sessionId, harness_slug: 'papercusp' },
    ]);
    expect(await ingest(input)).toMatchObject({ data: { ok: true, recorded: false, deduped: true } });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(await observations(input)).toHaveLength(1);
  });

  it('returns journal success while the actual detector publication lookup is blocked in PostgreSQL', async () => {
    const input = await turn();
    const lock = await db.adminSql.reserve();
    await lock`BEGIN`;
    await lock`LOCK TABLE harness_shared.report_library IN ACCESS EXCLUSIVE MODE`;
    try {
      const result = await ingest(input);
      expect(result).toMatchObject({ data: { ok: true, recorded: true, unpublishedReportObservationScheduled: true } });
      expect(responseData(result)).not.toHaveProperty('unpublishedReportObserved');
      await expect.poll(async () => db.adminSql`SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%SELECT report_id FROM harness_shared.report_library%'`, { timeout: 2_000 }).not.toHaveLength(0);
      expect(await db.adminSql`SELECT id FROM harness_shared.session_turn_journal
        WHERE session_id = ${input.sessionId}`).toHaveLength(1);
      expect(await observations(input)).toHaveLength(0);
    } finally {
      await lock`ROLLBACK`;
      lock.release();
    }
    expect(await finishObservation()).toBe(true);
    expect(await observations(input)).toHaveLength(1);
  });

  it('suppresses automatic filing for a same-author publication in the journal turn window', async () => {
    const input = await turn();
    await publishReport(db.adminSql, { workspaceId: input.workspaceId, title: 'Journal publication fixture',
      bodyMd: body, visibility: 'owner' }, { harnessSlug: 'papercusp',
      authorOwnerId: input.ownerId, authorSessionRef: input.sessionId });
    expect(await ingest(input)).toMatchObject({ data: { ok: true, recorded: true } });
    expect(await finishObservation()).toBe(false);
    expect(await observations(input)).toHaveLength(0);
  });

  it.each(['ordinary progress', 'disabled library'])('records the journal without filing for %s', async kind => {
    const input = await turn(kind === 'ordinary progress' ? 'Still verifying.' : body);
    if (kind === 'disabled library') vi.stubEnv('PAPERCUSP_FLAG_PAPERCUSP_REPORTS_LIBRARY', '0');
    expect(await ingest(input)).toMatchObject({ data: { ok: true, recorded: true } });
    expect(await finishObservation()).toBe(false);
    expect(await observations(input)).toHaveLength(0);
  });
});
