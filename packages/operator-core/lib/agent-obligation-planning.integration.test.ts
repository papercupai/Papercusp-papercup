/** Real review writer -> scoped tick reader -> obligation provider, on isolated PG. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from './_baseline-coord-fixture';
import { getModes, setMode } from './modes/store';
import { defaultAgentObligationReaderDeps, projectAgentTurnStartObligationBrief, readAgentObligationAgenda } from './agent-obligation-reader';
import {
  buildTurnStartOrientationBlock, ORIENTATION_CURSOR_SURFACE,
  TURN_START_IDENTITY_DELIVERY_KEY, type OrientationDeps,
} from './turn-start-orientation';
import { drainDetached } from './detached-imports';
import { recordScoutTick } from './scout/tick-ledger';
import recordTool, { ideatePassRecordArgs } from './agent-tools/scout/ideate-pass-record';
import modeGetTool from './agent-tools/mode/get';
import { clearPresence, writePresence } from './agent-tools/coordination/presence';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER = `su-planning-${RUN}`;
const GOAL = `goal-planning-${RUN}`;
const WS = 'default';
let fx: BaselineCoordFixture;

beforeAll(async () => {
  fx = await setupBaselineCoordFixture();
  await insertGoalRow(fx.admin, { id: GOAL, workspaceId: WS, installSlug: 'papercusp',
    title: 'Planning obligation integration', body: 'Recover failed checkout', status: 'active',
    killCriterion: 'Uncovered needs do not reach the obligation agenda.' });
  expect((await setMode({ workspaceId: WS, ownerId: OWNER, modeId: 'goal', subject: GOAL,
    enabled: true, reason: 'Isolated planning reader integration', setBy: OWNER, sql: fx.admin })).ok).toBe(true);
}, 150_000);
afterEach(async () => {
  await drainDetached();
  await clearPresence(OWNER);
  await fx.admin`DELETE FROM harness_shared.scout_ticks WHERE workspace_id = ${WS} AND detail->>'owner' IN (${OWNER}, ${`${OWNER}-noise`})`;
  await fx.admin`DELETE FROM harness_shared.coord_read_cursors WHERE owner_id = ${OWNER}`;
});
afterAll(async () => {
  if (!fx) return;
  await fx.admin`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS} AND owner_id = ${OWNER}`;
  await fx.admin`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS} AND id = ${GOAL}`;
  await fx.dispose();
});

async function record(disposition: 'plan-needed' | 'existing-plans-sufficient') {
  const args = ideatePassRecordArgs.parse({ ideasFiled: 0, goalReview: {
    goalId: GOAL, disposition, rationale: 'Fixture review of checkout recovery.', evidenceRefs: [`goal:${GOAL}`],
    ...(disposition === 'plan-needed' ? { uncoveredOutcome: 'Recover failed checkout' } : { coverage: [] }),
  } });
  const result = await recordTool.handler(args, {
    isSuperuser: true, uiClientId: OWNER, workspaceId: WS, harnessSlug: 'papercusp',
    metadata: vi.fn(), log: vi.fn(), progress: vi.fn(), signal: new AbortController().signal,
    emit: vi.fn(async () => {}),
  });
  expect('isError' in result && result.isError === true).toBe(false);
}

async function readAgenda() {
  return readAgentObligationAgenda({ workspaceId: WS, ownerId: OWNER,
    // Only unrelated sources are stubbed. Goal mode, portfolio, review and ownership use production reads.
    deps: { planSlugs: async () => [], ownerDirectives: async () => [], waitingOn: async () => [], 
      fleetStaffing: async () => [],
      strandedGoalWork: async (_ws: string, goalId: string) => ({ goalId, thresholdMs: 0, total: 0, refusedCount: 0, sample: [], truncatedByLimit: false }),
      ownerReport: async () => null,
      goalLaunch: async () => ({ goalId: GOAL, settings: null, goalBrief: null, effective: {},
        ceilings: { maxAgents: null, maxPerFleet: null }, headcount: { total: 0, fleet: null },
        budget: null, refusal: null, degraded: false, degradedReasons: [] }),
      planFleet: async () => ({ status: 'known', alert: null, applicablePlanCount: 0 }),
    },
  });
}

async function planning() {
  const read = await readAgenda();
  return read.agenda.evaluations.find((row) => row.family === 'planning-needed');
}

describe('production planning-needed consumer', () => {
  it('turns a goal-local uncovered outcome into an actionable obligation without Blender input', async () => {
    await record('plan-needed');
    const obligation = await planning();
    expect(obligation).toMatchObject({ status: 'due', applicableDemand: 1, action: { kind: 'continue' } });
    expect(obligation?.reason).toContain('Recover failed checkout');
    expect(obligation?.action?.summary).toContain('verify real claims');
  }, 90_000);
  it('allows a supported zero-idea review, then invalidates it on changed outcomes', async () => {
    await record('existing-plans-sufficient');
    expect((await planning())?.status).toBe('satisfied');
    await fx.admin`UPDATE harness_shared.goals SET body = 'A changed outcome' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    try { expect((await planning())?.status).toBe('due'); }
    finally { await fx.admin`UPDATE harness_shared.goals SET body = 'Recover failed checkout' WHERE workspace_id = ${WS} AND id = ${GOAL}`; }
  }, 90_000);
  it('filters other owners before LIMIT rather than hiding this goal review behind newer noise', async () => {
    await record('plan-needed');
    await recordScoutTick({ workspaceId: WS, installSlug: 'papercusp', origin: 'su-ideate', status: 'ran',
      detail: { owner: `${OWNER}-noise`, goalReview: { goalId: GOAL, disposition: 'invalid-other-owner' } } });
    const read = await defaultAgentObligationReaderDeps().goalPlanning(WS, OWNER, GOAL);
    expect(read.review?.disposition).toBe('plan-needed');
  }, 90_000);

  it.each(['codex', 'claude'])('delivers exact goal revisions through the real %s hook across warm/cold/compaction and omission', async (client) => {
    await writePresence({ ownerId: OWNER, ownerLabel: 'Planning hook fixture',
      source: 'omp-hook-session', workspaceId: WS, userId: null }, {
      intent: 'Verify planning obligation delivery', currentPlanSlug: null, capabilityTags: [],
    });
    await record('plan-needed');
    let read = await readAgenda();
    let brief = projectAgentTurnStartObligationBrief(read.agenda);
    const original = read.agenda.primary.find((row) => row.family === 'planning-needed')!;
    expect(brief.projection.entries.some((row) => row.id === original.id)).toBe(true);
    let epoch = 1;
    let budgetChars = 600;
    const deps: OrientationDeps = {
      held: async () => [], ownerDirectives: async () => [], historyUpdates: async () => [],
      effortUpdates: async () => [], openChecks: async () => [], planDecisions: async () => undefined,
      lockTransitions: async () => undefined, coupledPeers: async () => null,
      inbox: async () => ({ count: 0, newest: [] }), announcedGates: async () => [], openAsks: async () => null,
      modes: async () => (await getModes(WS, OWNER, fx.admin)).map((row) => ({
        axisKey: row.axisKey, mode: row.mode, reason: row.reason, setBy: row.setBy,
        setBySelf: row.setBy === OWNER, ownerDirected: row.ownerDirected,
        impliedBy: row.impliedBy?.mode ?? null,
      })), authorityVerdict: async () => null, loopArmed: async () => true,
      loopFireWithheld: async () => false, improvementTriage: async () => null,
      executableFrontier: async () => null, obligations: async () => brief,
      neverDropFacts: async () => [], toolSurface: async () => null, carryBlindWindow: async () => null,
      contextEpoch: async () => epoch,
    };
    const receipts: Array<{ confirmed: unknown; offered: string | null; elapsedMs: number }> = [];
    const startedRequests: number[] = [];
    const serverErrors: unknown[] = [];
    // Only HTTP transport is local. The canonical reader/provider, final composer,
    // PG cursor, real hook process, native adapter and stdout ledger are exercised.
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { void (async () => {
        const startedAt = Date.now();
        startedRequests.push(startedAt);
        const request = JSON.parse(body) as { confirmedDelivery?: string | null };
        const delivery = await buildTurnStartOrientationBlock({ ownerId: OWNER, workspaceId: WS, deps,
          budgetChars, confirmedDeliveryToken: request.confirmedDelivery ?? null });
        receipts.push({ confirmed: request.confirmedDelivery, offered: delivery.deliveryToken,
          elapsedMs: Date.now() - startedAt });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: delivery.block, deliveryToken: delivery.deliveryToken }));
      })().catch((error) => { serverErrors.push(error); res.writeHead(500); res.end('{}'); }); });
    });
    const hookHome = await mkdtemp(join(tmpdir(), 'goal-brief-hook-'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback fixture port');
    const hook = fileURLToPath(new URL('../../../apps/operator/scripts/hooks/inject/index.mjs', import.meta.url));
    const nativeTurn = async () => {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = execFile(process.execPath, [hook, `--client=${client}`, '--event=UserPromptSubmit'], {
          timeout: 20_000, env: { ...process.env, PAPERCUSP_SID: OWNER, PAPERCUSP_WORKSPACE: WS,
            PAPERCUSP_HOME: hookHome, PAPERCUSP_OPERATOR_URL: `http://127.0.0.1:${address.port}` },
        }, (error, output) => error ? reject(error) : resolve(output));
        child.stdin?.end(JSON.stringify({ prompt: 'Continue the goal', cwd: process.cwd() }));
      });
      if (!stdout.trim()) {
        const cursor = await fx.admin`SELECT committed, pending FROM harness_shared.coord_read_cursors
          WHERE owner_id = ${OWNER} AND surface = ${ORIENTATION_CURSOR_SURFACE}`;
        throw new Error('native hook returned an empty payload: ' +
          JSON.stringify({ serverErrors, receipts, startedRequests: startedRequests.length,
            activeRequestAgeMs: startedRequests.length ? Date.now() - startedRequests.at(-1)! : null,
            cursor: cursor[0] ?? null }));
      }
      const output = JSON.parse(stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
      expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
      return output.hookSpecificOutput.additionalContext;
    };
    const expectExact = (text: string, obligation = original) => {
      expect(text).toContain(obligation.id);
      expect(text).toContain(obligation.sourceGeneration);
      expect(text).toContain(obligation.ruleRevision);
      expect(text).toContain(obligation.action!.summary);
    };
    try {
      expectExact(await nativeTurn()); // first turn
      expect(receipts[0]?.confirmed).toBeNull();
      expect(receipts[0]?.offered).toEqual(expect.any(String));
      expectExact(await nativeTurn()); // unchanged warm turn: still unresolved
      expect(receipts[1]?.confirmed).toBe(receipts[0]?.offered);
      epoch += 1;
      expectExact(await nativeTurn()); // cold context
      epoch += 1;
      expectExact(await nativeTurn()); // post-compaction context

      await fx.admin`UPDATE harness_shared.goals SET body = 'A newly changed goal outcome' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
      await record('plan-needed');
      read = await readAgenda();
      brief = projectAgentTurnStartObligationBrief(read.agenda);
      const current = read.agenda.primary.find((row) => row.family === 'planning-needed')!;
      expect(current.id).not.toBe(original.id);
      expect(current.sourceGeneration).not.toBe(original.sourceGeneration);
      budgetChars = 200;
      const omitted = await nativeTurn();
      expect(omitted).toContain(brief.detailRef);
      expect(omitted).not.toContain(current.id);
      const cursors = await fx.admin`SELECT pending FROM harness_shared.coord_read_cursors WHERE owner_id = ${OWNER} AND surface = ${ORIENTATION_CURSOR_SURFACE}`;
      expect(cursors).toHaveLength(1);
      expect(cursors[0].pending.obligations).not.toBe(brief.sourceGeneration);
      budgetChars = 600;
      const recovered = await nativeTurn();
      expectExact(recovered, current);
      expect(recovered).not.toContain(original.id);
      await drainDetached();
      const identityRows = await fx.admin`SELECT pending FROM harness_shared.coord_read_cursors
        WHERE owner_id = ${OWNER} AND surface = ${ORIENTATION_CURSOR_SURFACE}`;
      const identityReceipt = identityRows[0]?.pending?.[TURN_START_IDENTITY_DELIVERY_KEY];
      expect(identityReceipt, JSON.stringify(identityReceipt?.root)).toMatchObject({
        status: 'bound', deliveryToken: receipts.at(-1)?.offered,
        root: { identityId: 'su', contributions: expect.arrayContaining([
          expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound' }),
          expect.objectContaining({ contributionId: 'current-assignment', status: 'bound' }),
        ]) },
        practice: { identityId: 'su.practice', contributions: expect.arrayContaining([
          expect.objectContaining({ contributionId: 'turn-start-orientation', status: 'bound' }),
        ]) },
      });
      const modeGet = await modeGetTool.handler({ agent: OWNER, contracts: true }, {
        isSuperuser: true, uiClientId: OWNER, workspaceId: WS,
      } as never);
      const modeGetData = (modeGet as unknown as { data: { ok: boolean; modes: Array<{
        mode: string; definitionRevision?: string; sourceRevision?: string;
      }> } }).data;
      expect(modeGetData.ok).toBe(true);
      const goalDefinition = modeGetData.modes.find((mode) => mode.mode === 'goal');
      expect(goalDefinition?.definitionRevision).toEqual(expect.any(String));
      expect(identityRows[0]?.pending?.[TURN_START_IDENTITY_DELIVERY_KEY]?.goal).toMatchObject({
        identityId: 'su.mode-goal', sourceRevision: goalDefinition?.sourceRevision,
        definitionRevision: goalDefinition?.definitionRevision,
        contributions: expect.arrayContaining([
          expect.objectContaining({ contributionId: 'current-mode-state', status: 'bound' }),
          expect.objectContaining({ contributionId: 'goal-obligations', status: 'bound' }),
        ]),
      });
      // Losing authoritative presence must remain an explicit partial receipt,
      // even while the native hook still delivers the goal obligation exactly.
      await clearPresence(OWNER);
      expectExact(await nativeTurn(), current);
      await drainDetached();
      const missingPresenceRows = await fx.admin`SELECT pending FROM harness_shared.coord_read_cursors
        WHERE owner_id = ${OWNER} AND surface = ${ORIENTATION_CURSOR_SURFACE}`;
      expect(missingPresenceRows[0]?.pending?.[TURN_START_IDENTITY_DELIVERY_KEY]).toMatchObject({
        status: 'partial',
        root: { identityId: 'su', status: 'unavailable', errorRef: 'turn-start:root-binding-failed' },
        goal: { contributions: expect.arrayContaining([
          expect.objectContaining({ contributionId: 'goal-obligations', status: 'bound' }),
        ]) },
      });
      expect(serverErrors).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(hookHome, { recursive: true, force: true });
      await fx.admin`UPDATE harness_shared.goals SET body = 'Recover failed checkout' WHERE workspace_id = ${WS} AND id = ${GOAL}`;
    }
  }, 90_000);
});
