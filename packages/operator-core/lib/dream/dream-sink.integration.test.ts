/**
 * dream-sink.integration.test.ts — REM dreaming P-004 against real migrated PG.
 *
 * Pins the reuse-first boundary end to end: an independently accepted dream is
 * captured as an ordinary improvement work item, enrolled in the existing
 * routed-idea ledger with origin/lens `dream` and source-fragment provenance,
 * then remains gradeable and outcome-refreshable through Blender's existing
 * machinery. There is deliberately no dream-specific artifact or outcome table.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { teardownTestPg } from '@papercusp/test-config/pg';
import type { OrgTestDb } from '../../test/_org-test-db';
import { rm } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createDreamCapabilityFixture } from '../../test/dream-capability-fixture';
import { verifyCapabilityPacket } from './capability-packets';
import { capabilityReviewEvidenceHash, verifyCapabilityReviewAdmission } from './capability-review';
import { IDEA_ORIGIN_PAYLOAD_KEY } from '../scout/ideation-origin';
import {
  beginDreamRun,
  beginDreamRunCall,
  settleDreamRunCall,
  recordDreamRunSelection,
  recordDreamRunReview,
  getDreamRun,
  finalizeDreamRun,
} from './dream-run-store';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
// Capture, routing, and grading all invalidate the existing Learning snapshot
// asynchronously. The integration boundary under test is PG, not a live SSE bus.
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));

const { sinkDreamInsight } = await import('./dream-sink');
const { gradeRoutedIdea, readRoutedIdeas, refreshScoutOutcomes, recordRoutedIdea } =
  await import('../scout/routed-ledger');
const { captureImprovement } = await import('../harness/improvements/capture-core');
const { mergeIssuePayload } = await import('../issues-engineer');
const { createOrgTestDb } = await import('../../test/_org-test-db');

const WS = 'ws-dream-sink';
const HARNESS = 'papercusp';

describe('accepted dream sink (real PG — P-004)', () => {
  let db: OrgTestDb;
  let workspaceBefore: string | undefined;

  // Keep the original strict oracle. If it fails, retain the reached phase and
  // complete snapshots in stdout before the ledger bounds its error tail.
  async function assertReplayPayload(
    phase: 'post-close-before-replay' | 'post-replay',
    before: unknown,
    after: unknown,
    assertion: () => void,
  ): Promise<void> {
    try {
      assertion();
    } catch (error) {
      let database: unknown;
      let testSha256: string | undefined;
      let sourceCaptureError: string | undefined;
      try {
        testSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');
      } catch (captureError) {
        sourceCaptureError = String(captureError);
      }
      try {
        const [identity] = await db.adminSql`SELECT current_database() AS database,
          current_user AS role, current_setting('server_version') AS server_version`;
        database = identity;
      } catch (captureError) {
        database = { captureError: String(captureError) };
      }
      const diagnostic = JSON.stringify({
        phase,
        testFile: fileURLToPath(import.meta.url),
        testSha256,
        sourceCaptureError,
        nodeVersion: process.version,
        nodeExecutable: process.execPath,
        workspace: process.env.PAPERCUSP_WORKSPACE_ID,
        database,
        before,
        after,
        assertionMessage: error instanceof Error ? error.message : String(error),
        assertionStack: error instanceof Error ? error.stack : undefined,
      });
      throw new Error('DREAM_REPLAY_FAILURE ' + diagnostic, { cause: error });
    }
  }

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;
    workspaceBefore = process.env.PAPERCUSP_WORKSPACE_ID;
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
    const migration = fileURLToPath(
      new URL('../../../../libs/papercusp/libs/db/sql/862-dream-runs-ledger.sql', import.meta.url),
    );
    await db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : migration + '.DRAFT', 'utf8'));
  }, 180_000);

  afterAll(async () => {
    if (workspaceBefore === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = workspaceBefore;
    await db?.cleanup();
    if (!process.env.KEEP_TEST_PG) await teardownTestPg();
  });

  async function seedCapabilityInput(
    f: Awaited<ReturnType<typeof createDreamCapabilityFixture>>,
    runId: string,
  ) {
    const key = { workspaceId: WS, runId };
    await beginDreamRun(db.adminSql, {
      ...key, cycleId: 'capability-pg-cycle', potSlug: HARNESS, mode: 'manual', capability: f.header,
    });
    await recordDreamRunSelection(db.adminSql, { ...key, capability: f.sampling });
    for (const call of f.provenance.calls) {
      await beginDreamRunCall(db.adminSql, {
        ...key, call: { callId: call.callId, phase: call.phase, model: call.model, reservedUsd: call.reservedUsd },
      });
      await settleDreamRunCall(db.adminSql, { ...key, callId: call.callId, usage: call.usage });
    }
    await recordDreamRunReview(db.adminSql, {
      ...key, outcome: { verdict: 'insight', insight: f.insight }, review: { ...f.review },
    });
    return {
      kind: 'capability' as const, sql: db.adminSql, workspaceId: WS, dreamRunId: runId,
      rootPath: f.root, manifest: f.manifest, sources: f.sources,
    };
  }

  it('persists dream provenance, accepts an ordinary grade, and refreshes the routed work-item outcome', async () => {
    const result = await sinkDreamInsight({
      dreamRunId: 'DR-PG-1',
      cycleId: 'dream-cycle-pg',
      harnessSlug: HARNESS,
      workspaceId: WS,
      createdBy: 'system:dream-cycle',
      insight: {
        text: 'Use the completion watermark to suppress repeated fleet recovery wakes.',
        requiresA: 'The observation establishes the repeated recovery symptom.',
        requiresB: 'The memory provides the completion-watermark mechanism.',
        actionable: 'Replay two completion wakes and assert only the first reaches recovery.',
      },
      fragments: [
        {
          id: 'recent-observation',
          kind: 'observation',
          ref: 'wi:EI-RECOVERY-WAKES',
          text: 'A completed lane was re-woken twice.',
          createdAt: '2026-08-20T12:00:00.000Z',
          harness: HARNESS,
        },
        {
          id: 'remote-memory',
          kind: 'memory',
          ref: 'memory:completion-watermark',
          text: 'A monotonic completion watermark suppressed an earlier replay.',
          createdAt: '2026-07-01T12:00:00.000Z',
          harness: HARNESS,
        },
      ],
      review: {
        verdict: 'accept',
        stage: 'grader',
        scores: { dependence: 2, actionability: 2, novelty: 1 },
        note: 'Both fragments are necessary and the replay is falsifiable.',
        priorMatches: [],
        usage: { model: 'independent-reviewer', costUsd: 0.01, inputTokens: 200, outputTokens: 40 },
      },
    });

    expect(result).toMatchObject({
      sunk: true,
      ideaId: 'dream:DR-PG-1',
      created: true,
      sourceRefs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
    });
    if (!result.sunk) throw new Error('accepted dream unexpectedly failed to sink');

    const [issue] = await db.adminSql<{ scope: string; state: string; payload: Record<string, unknown> }[]>`
      SELECT scope, state, payload
        FROM harness_shared.engineer_issues
       WHERE issue_id = ${result.workItemId}`;
    expect(issue).toMatchObject({ scope: `harness:${HARNESS}`, state: 'open' });
    expect(issue.payload).toMatchObject({
      [IDEA_ORIGIN_PAYLOAD_KEY]: 'dream',
      improvementKind: 'feature',
      sourceRole: 'system',
      filedByRole: 'dream',
      watchdogKey: 'dream:DR-PG-1',
      dream: {
        dreamRunId: 'DR-PG-1',
        cycleId: 'dream-cycle-pg',
        sourceRefs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
      },
    });

    await expect(
      gradeRoutedIdea({
        ideaId: 'dream:DR-PG-1',
        grade: 4,
        feedback: 'Concrete and worth trying.',
        gradedBy: 'auto-grader',
      }),
    ).resolves.toEqual({ applied: true });

    const [routed] = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'dream' });
    expect(routed).toMatchObject({
      ideaId: 'dream:DR-PG-1',
      lens: 'dream',
      rail: 'improvement',
      routedRef: `wi:${result.workItemId}`,
      cycleId: 'dream-cycle-pg',
      addressesPatternRefs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
      humanGrade: 4,
      humanFeedback: 'Concrete and worth trying.',
      gradedBy: 'auto-grader',
      createdBy: 'system:dream-cycle',
    });

    await db.adminSql`
      UPDATE harness_shared.engineer_issues
         SET state = 'resolved',
             terminal_owner = 'dream-sink-test',
             terminal_completion_ref = 'real-PG dream sink fixture completed',
             updated_at = now()
       WHERE issue_id = ${result.workItemId}`;
    const report = await refreshScoutOutcomes({ workspaceId: WS, harnessSlug: HARNESS, origin: 'dream' });
    expect(report.total).toBe(1);

    const [ledger] = await db.adminSql<
      {
        origin: string;
        lens: string;
        routed_ref: string;
        addresses_pattern_refs: string[];
        human_grade: number;
        outcome: string;
      }[]
    >`
      SELECT origin, lens, routed_ref, addresses_pattern_refs, human_grade, outcome
        FROM harness_shared.scout_routed_ideas
       WHERE idea_id = 'dream:DR-PG-1'`;
    expect(ledger).toEqual({
      origin: 'dream',
      lens: 'dream',
      routed_ref: `wi:${result.workItemId}`,
      addresses_pattern_refs: ['wi:EI-RECOVERY-WAKES', 'memory:completion-watermark'],
      human_grade: 4,
      outcome: 'won',
    });
  });

  it('admits the maintained capability fixture and refuses an obsolete extraction recipe', async () => {
    const f = await createDreamCapabilityFixture(WS, HARNESS);
    try {
      const packetInput = (packet: (typeof f.packets)[number]) => ({
        rootPath: f.root,
        scope: f.scope,
        unit: f.manifest.units.find(unit => unit.id === packet.unit.id)!,
        manifestRevision: f.manifest.revision,
      });
      for (const packet of f.packets)
        await expect(verifyCapabilityPacket(packet, packetInput(packet))).resolves.toEqual({ fresh: true });
      const admission = {
        candidate: f.candidate,
        selection: f.selection,
        review: f.review,
        rootPath: f.root,
        manifest: f.manifest,
        sources: f.sources,
        dreamerModel: f.header.dreamerModel,
      };
      await expect(verifyCapabilityReviewAdmission(admission)).resolves.toEqual({ admitted: true });

      // Hold source bytes, the reviewed candidate and prior art constant: only
      // the extraction recipe changes, so refusal must come from freshness.
      f.selection.a.packet.extraction.recipeVersion = 'scanned-anchors-and-radius-v2';
      expect(capabilityReviewEvidenceHash(f.selection)).toBe(f.review.evidenceHash);
      await expect(verifyCapabilityPacket(f.selection.a.packet, packetInput(f.selection.a.packet))).resolves.toEqual({
        fresh: false,
        reason: 'Packet scope or manifest changed',
      });
      await expect(verifyCapabilityReviewAdmission(admission)).resolves.toEqual({
        admitted: false,
        reason: 'Reviewed source or prior art is stale, missing, or unavailable',
      });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('replays concurrent and crash-after-capture capability attempts even after the captured idea becomes terminal', async () => {
    const f = await createDreamCapabilityFixture(WS, HARNESS);
    try {
      const key = { workspaceId: WS, runId: 'DR-CAPABILITY-PG' };
      const input = await seedCapabilityInput(f, key.runId);
      const capture = vi.fn(captureImprovement);
      const route = vi.fn(recordRoutedIdea).mockRejectedValueOnce(new Error('crash after capture'));
      const deps = { capture, recordRoutedIdea: route, now: Date.now };
      await expect(sinkDreamInsight(input, deps)).rejects.toThrow('crash after capture');
      expect((await getDreamRun(db.adminSql, key))?.routedRef).toBeNull();
      const [original] = await db.adminSql`SELECT issue_id, payload FROM harness_shared.engineer_issues
        WHERE workspace_id = ${WS} AND payload->>'watchdogKey' = 'dream:DR-CAPABILITY-PG'`;
      expect(original).toBeDefined();
      expect(original!.payload[IDEA_ORIGIN_PAYLOAD_KEY]).toBe('dream');
      await db.adminSql`UPDATE harness_shared.engineer_issues SET state = 'resolved', terminal_owner = 'dream-test',
        terminal_completion_ref = 'terminal identity replay fixture', updated_at = now() WHERE issue_id = ${original!.issue_id}`;
      // The real local-close trigger adds the completion-event intent before
      // replay. Preserve that terminal payload exactly, including its token.
      const [terminal] = await db.adminSql`SELECT payload FROM harness_shared.engineer_issues
        WHERE issue_id = ${original!.issue_id}`;
      await assertReplayPayload('post-close-before-replay', original!.payload, terminal!.payload, () => {
        expect(terminal!.payload).toEqual({
          ...original!.payload,
          _completionEventIntentId: expect.stringMatching(/\S/),
        });
      });
      const replay = await Promise.all([sinkDreamInsight(input, deps), sinkDreamInsight(input, deps)]);
      for (const value of replay)
        expect(value).toMatchObject({ sunk: true, workItemId: original!.issue_id, created: false });
      expect(capture).toHaveBeenCalledTimes(1);
      await finalizeDreamRun(db.adminSql, {
        ...key,
        status: 'accepted',
        dreamUsage: f.provenance.calls[0]!.usage,
        reviewUsage: f.review.usage,
      });
      expect(await sinkDreamInsight({ ...input, createdBy: 'later-replay-actor' }, deps)).toMatchObject({
        sunk: true,
        workItemId: original!.issue_id,
        created: false,
      });
      const artifacts = await db.adminSql`SELECT payload FROM harness_shared.engineer_issues
        WHERE workspace_id = ${WS} AND payload->>'watchdogKey' = 'dream:DR-CAPABILITY-PG'`;
      expect(artifacts).toHaveLength(1);
      await assertReplayPayload('post-replay', terminal!.payload, artifacts[0]!.payload, () => {
        expect(artifacts[0]!.payload).toEqual(terminal!.payload);
      });
      const rows = await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'dream' });
      const routed = rows.filter((r) => r.ideaId === 'dream:DR-CAPABILITY-PG');
      expect(routed).toHaveLength(1);
      expect(routed[0]!.createdBy).not.toBe('later-replay-actor');
      expect(routed[0]!.addressesPatternRefs).toEqual(
        [f.selection.a, f.selection.b].map((e) => e.packet.unit.id + '@' + e.contentVersion),
      );
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('preserves a legacy terminal payload missing origin through concurrent and repeated capability replay', async () => {
    const f = await createDreamCapabilityFixture(WS, HARNESS);
    try {
      const runId = 'DR-CAPABILITY-LEGACY-PG';
      const input = await seedCapabilityInput(f, runId);
      const capture = vi.fn(captureImprovement);
      const route = vi.fn(recordRoutedIdea).mockRejectedValueOnce(new Error('legacy crash after capture'));
      const deps = { capture, recordRoutedIdea: route, now: Date.now };
      await expect(sinkDreamInsight(input, deps)).rejects.toThrow('legacy crash after capture');
      const [original] = await db.adminSql`SELECT issue_id, payload FROM harness_shared.engineer_issues
        WHERE workspace_id = ${WS} AND payload->>'watchdogKey' = ${'dream:' + runId}`;
      expect(original!.payload[IDEA_ORIGIN_PAYLOAD_KEY]).toBe('dream');
      // Model the historical writer through the canonical unset seam. The
      // compatibility view deliberately merges payloads, restoring removed keys.
      const cleared = await mergeIssuePayload(original!.issue_id, {}, {
        unset: [IDEA_ORIGIN_PAYLOAD_KEY], harnessSlug: HARNESS,
      });
      expect(cleared).not.toBeNull();
      const [legacy] = await db.adminSql`SELECT payload FROM harness_shared.engineer_issues
        WHERE issue_id = ${original!.issue_id}`;
      expect(legacy!.payload).not.toHaveProperty(IDEA_ORIGIN_PAYLOAD_KEY);
      await db.adminSql`UPDATE harness_shared.engineer_issues SET state = 'resolved', terminal_owner = 'dream-test',
        terminal_completion_ref = 'legacy terminal replay fixture', updated_at = now()
        WHERE issue_id = ${original!.issue_id}`;
      const [terminal] = await db.adminSql`SELECT payload FROM harness_shared.engineer_issues
        WHERE issue_id = ${original!.issue_id}`;
      await assertReplayPayload('post-close-before-replay', legacy!.payload, terminal!.payload, () => {
        expect(terminal!.payload).toEqual({
          ...legacy!.payload, _completionEventIntentId: expect.stringMatching(/\S/),
        });
      });
      const replay = await Promise.all([sinkDreamInsight(input, deps), sinkDreamInsight(input, deps)]);
      for (const value of replay)
        expect(value).toMatchObject({ sunk: true, workItemId: original!.issue_id, created: false });
      expect(await sinkDreamInsight(input, deps)).toMatchObject({
        sunk: true, workItemId: original!.issue_id, created: false,
      });
      expect(capture).toHaveBeenCalledTimes(1);
      const artifacts = await db.adminSql`SELECT payload FROM harness_shared.engineer_issues
        WHERE workspace_id = ${WS} AND payload->>'watchdogKey' = ${'dream:' + runId}`;
      expect(artifacts).toHaveLength(1);
      await assertReplayPayload('post-replay', terminal!.payload, artifacts[0]!.payload, () => {
        expect(artifacts[0]!.payload).toEqual(terminal!.payload);
      });
      const routed = (await readRoutedIdeas({ workspaceId: WS, harnessSlug: HARNESS, origin: 'dream' }))
        .filter((r) => r.ideaId === 'dream:' + runId);
      expect(routed).toHaveLength(1);
      expect(routed[0]!.routedRef).toBe('wi:' + original!.issue_id);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
