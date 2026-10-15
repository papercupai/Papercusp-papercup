/**
 * P-008 real-PostgreSQL proof for bounded plan-history delivery.
 *
 * One canonical plan row and one descendant checkpoint are read through the
 * actual production consumers: plans:get (including exact raw-ref recovery),
 * the launch context bundle, and the complete fleet leader-brief builder.  The
 * baseline-schema fixture keeps every store real while unique ids isolate this
 * suite from concurrent integration files.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { appendGoalHistory } from '@papercusp/agent-mcp';
import { insertGoalRow } from '@papercusp/agent-mcp/goals';
import { PgThreadStore } from '@papercusp/coordination/capabilities';
import { workItemCheckpointScope, setWorkItemCheckpoint } from '../../work-item-checkpoint';
import { getClaimTimePriorAttemptBrief, readGoalHistoryContext, readPlanHistoryContext, resolvePriorAttemptRefs } from '../../prior-attempt-context';
import { postLearnedAtLevel } from '../../effort-thread';
import { getWorkItem } from '../../work-items';
import { buildGoalKickoffBrief } from '../goals/start';
import { DEFAULT_CLAIM_SPEC } from '../../scheduler/claim-spec';
import { fleetSpecBeeKey, setClaimSpec } from '../../scheduler/claim-spec-store';
import { buildLeaderBrief } from '../fleet/leader-brief';
import plansGetTool from './get';
import workItemsGetTool from '../work_items/get';
import { buildPlanContextBundle } from './context-bundle';
import { cleanupPlans, seedPlan, setupPlanPgFixture, type PlanPgFixture } from './__tests__/_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-plan-history-${RUN}`;
const PLAN = `plan-history-consumers-${RUN}`;
const CHILD = `WI-plan-history-${RUN}`;
const DIRECT_GOAL_ITEM = `WI-goal-direct-${RUN}`;
const UNRELATED_ITEM = `WI-goal-unrelated-${RUN}`;
const FLEET = `plan-history-fleet-${RUN}`;
const GOAL = `goal-history-consumers-${RUN}`;
const GOAL_LESSON = 'A measured correction replaced the stale goal stop condition.';
const CHILD_ROOT_CAUSE = 'the delivery cursor advanced before projection';
const CHILD_LESSON =
  'Outcome: the descendant repair shipped. Root cause: the delivery cursor advanced before projection. Residue: preserve the exact recovery reference.';
const DIRECT_GOAL_LESSON =
  'Outcome: the direct goal repair shipped. Root cause: direct goal attachment must survive without a plan. Residue: retain direct-goal recovery.';
const UNRELATED_LESSON =
  'Outcome: unrelated sibling poison. Root cause: this object belongs to a different subject. Residue: never inject it.';

const PLAN_CONTENT = `---
title: Plan history consumer integration
status: active
---

# Plan history consumer integration

## Now

State: proving production history consumers.

Next: retain the descendant lesson in every leader-facing sink.

## Work

- **P-001** \`todo\` — Exercise bounded descendant history.

## Decisions

### D-001 — Preserve the current correction

Date: 2026-09-07

The plan's own authority remains current while child evidence contributes learned history.
`;

const CTX = {
  isSuperuser: true,
  uiClientId: 'su-plan-history-consumer-integration',
  workspaceId: 'default',
  harnessSlug: HARNESS,
  metadata: vi.fn(),
  log: vi.fn(),
  progress: vi.fn(),
} as never;

let fx: PlanPgFixture;
let admin: postgres.Sql;
let previousWorkspaceId: string | undefined;
const capturedThreadIds = new Set<string>();

beforeAll(async () => {
  previousWorkspaceId = process.env.PAPERCUSP_WORKSPACE_ID;
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  process.env.PAPERCUSP_WORKSPACE_ID = fx.workspaceId;

  await seedPlan(admin, fx.workspaceId, HARNESS, PLAN, PLAN_CONTENT);
  await insertGoalRow(admin, {
    id: GOAL,
    installSlug: HARNESS,
    workspaceId: fx.workspaceId,
    title: 'Goal history consumer integration',
    body: 'Prove the goal holder receives goal, plan and item history.',
    killCriterion: 'the bounded history consumer omits an admitted descendant',
    status: 'active',
  });
  await admin`
    UPDATE harness_shared.harness_plans
       SET goal_id = ${GOAL}
     WHERE workspace_id = ${fx.workspaceId}
       AND harness_slug = ${HARNESS}
       AND plan_slug = ${PLAN}
  `;
  await appendGoalHistory(admin, {
    workspaceId: fx.workspaceId,
    goalId: GOAL,
    author: 'su-goal-history-consumer-integration',
    detail: { kind: 'finding', summary: GOAL_LESSON, refs: [CHILD] },
  });
  await admin`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, summary, status,
       source_plan_slug, source_plan_item_ids, goal_id, payload, last_progress_at, created_ts, updated_ts)
    VALUES
      (${fx.workspaceId}, ${HARNESS}, ${CHILD}, 'bug', 'Descendant delivery repair',
       'A completed child with a lesson the plan must inherit.', 'open', ${PLAN}, ARRAY['P-001'],
       ${GOAL}, ${admin.json({
         plan_item: { plan_slug: PLAN, item_id: 'P-001', harness_slug: HARNESS },
       })}, now(), ${Date.now()}, ${Date.now()}),
      (${fx.workspaceId}, ${HARNESS}, ${DIRECT_GOAL_ITEM}, 'bug', 'Direct goal repair',
       'A directly attached goal item with no plan edge.', 'open', NULL, NULL, ${GOAL},
       ${admin.json({})}, now(), ${Date.now()}, ${Date.now()}),
      (${fx.workspaceId}, ${HARNESS}, ${UNRELATED_ITEM}, 'bug', 'Unrelated sibling',
       'A same-harness item outside the goal and plan graph.', 'open', NULL, NULL, NULL,
       ${admin.json({})}, now(), ${Date.now()}, ${Date.now()})
  `;
  await setWorkItemCheckpoint({ harness: HARNESS, workItemId: CHILD, workspaceId: fx.workspaceId }, CHILD_LESSON);
  await setWorkItemCheckpoint(
    { harness: HARNESS, workItemId: DIRECT_GOAL_ITEM, workspaceId: fx.workspaceId },
    DIRECT_GOAL_LESSON,
  );
  await setWorkItemCheckpoint(
    { harness: HARNESS, workItemId: UNRELATED_ITEM, workspaceId: fx.workspaceId },
    UNRELATED_LESSON,
  );

  const stored = await setClaimSpec(
    {
      cupId: fleetSpecBeeKey(FLEET),
      workspaceId: fx.workspaceId,
      updatedBy: 'su-plan-history-consumer-integration',
      spec: {
        ...DEFAULT_CLAIM_SPEC,
        specId: `${FLEET}-lane`,
        view: { filter: { field: 'plan', op: '=', value: PLAN } },
      },
    },
    admin,
  );
  expect(stored).toMatchObject({ ok: true, errors: [] });
}, 90_000);

afterAll(async () => {
  for (const threadId of capturedThreadIds) {
    await admin`
      DELETE FROM harness_shared.coord_thread_posts
       WHERE workspace_id = ${fx.workspaceId} AND thread_id = ${threadId}
    `;
    await admin`
      DELETE FROM harness_shared.coord_threads
       WHERE workspace_id = ${fx.workspaceId} AND thread_id = ${threadId}
    `;
  }
  await admin`
    DELETE FROM harness_shared.carry_notes
     WHERE workspace_id = ${fx.workspaceId}
       AND scope = ANY(${[
         workItemCheckpointScope(HARNESS, CHILD),
         workItemCheckpointScope(HARNESS, DIRECT_GOAL_ITEM),
         workItemCheckpointScope(HARNESS, UNRELATED_ITEM),
       ]})
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.work_items
     WHERE workspace_id = ${fx.workspaceId}
       AND harness_slug = ${HARNESS}
       AND feature_id = ANY(${[CHILD, DIRECT_GOAL_ITEM, UNRELATED_ITEM]})
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.cup_claim_specs
     WHERE workspace_id = ${fx.workspaceId}
       AND bee_id = ${fleetSpecBeeKey(FLEET)}
  `.catch(() => {});
  await cleanupPlans(admin, fx.workspaceId, HARNESS).catch(() => {});
  await admin`
    DELETE FROM harness_shared.audit_log
     WHERE workspace_id = ${fx.workspaceId}
       AND subject = ${GOAL}
  `.catch(() => {});
  await admin`
    DELETE FROM harness_shared.goals
     WHERE workspace_id = ${fx.workspaceId}
       AND id = ${GOAL}
  `.catch(() => {});
  if (previousWorkspaceId === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = previousWorkspaceId;
  await fx?.dispose();
});

function dataOf<T>(value: unknown): T {
  return (value as { data: T }).data;
}

describe('bounded plan history production consumers', () => {
  it('captures a work-item correction at its own level and recovers the exact note from the claim brief', async () => {
    const note = [
      'Root cause: item history was read at the wrong level.',
      'False premise: a plan summary included every item thread.',
      'Outcome: the item claimant recovered the stored correction.',
      'Residue: validate the remaining callers.',
    ].join('\n');
    // Match the real create writer: a hand-seeded null created_ts turns into
    // createdAt:"", which is not a valid timestamp for a new issue thread.
    expect((await getWorkItem(CHILD, HARNESS))?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    capturedThreadIds.add(`issue-thread-${CHILD}`);
    const captured = await postLearnedAtLevel({
      workItemId: CHILD, harness: HARNESS, level: 'work_item', text: note,
      workspaceId: fx.workspaceId, authorId: 'su-item-capture-integration',
    });
    expect(captured, JSON.stringify(captured)).toMatchObject({
      posted: true, level: 'work_item', requestedLevel: 'work_item', fellBack: false,
    });
    expect(captured.post).toBeTruthy();
    capturedThreadIds.add(captured.post!.thread_id);
    const rawRef = `${CHILD}#comment:${captured.post!.id}`;
    const brief = await getClaimTimePriorAttemptBrief({ workItemId: CHILD, harness: HARNESS });
    expect(brief?.authority).toContainEqual(expect.objectContaining({
      rawRef, authority: 'retraction',
      falsePremises: ['a plan summary included every item thread.'],
    }));
    expect(brief?.protectedRefs.residue).toContain(rawRef);
    const raw = await resolvePriorAttemptRefs({
      target: { kind: 'work_item', ref: CHILD, harness: HARNESS }, harness: HARNESS, rawRefs: [rawRef],
    });
    const direct = await resolvePriorAttemptRefs({ workItemId: CHILD, harness: HARNESS, rawRefs: [rawRef] });
    expect(direct?.unresolved).toEqual([]);
    expect(direct?.records[0]?.text).toBe(note);
    expect(raw?.unresolved).toEqual([]);
    expect(raw?.records[0]?.text).toBe(note);
  });

  it.each(['work_item', 'plan', 'goal'] as const)('recovers exact %s archives beyond the recent-post window through real stores', async (level) => {
    const ref = level === 'work_item' ? CHILD : level === 'plan' ? PLAN : GOAL;
    const note = `Original ${level} archive: ${'preserved λ '.repeat(400)}`.trimEnd();
    const captured = await postLearnedAtLevel({
      workItemId: CHILD, harness: HARNESS, level, text: note,
      workspaceId: fx.workspaceId, authorId: 'su-exact-archive-integration',
    });
    expect(captured.post).toBeTruthy();
    const post = captured.post!;
    capturedThreadIds.add(post.thread_id);
    const store = new PgThreadStore({ getSql: () => admin, ensureSchema: async () => {}, workspaceId: fx.workspaceId });
    const ownIds = [post.id];
    const otherThreadId = `issue-thread-${UNRELATED_ITEM}`;
    const foreignWorkspace = `archive-foreign-${RUN}-${level}`;
    const foreignStore = new PgThreadStore({ getSql: () => admin, ensureSchema: async () => {}, workspaceId: foreignWorkspace });
    try {
      for (let index = 0; index < 30; index++) {
        const later = await store.addPost({ thread_id: post.thread_id, author_id: 'su-later-post-integration',
          body: `Later ${level} post ${index}`, created_ts: new Date().toISOString() });
        ownIds.push(later.id);
      }
      expect((await store.listRecentPosts(post.thread_id, 25)).posts.map((row) => row.id)).not.toContain(post.id);
      await store.getOrCreateThread({ kind: 'issue', ref: UNRELATED_ITEM }, {
        thread_id: otherThreadId, created_ts: new Date().toISOString(),
      });
      capturedThreadIds.add(otherThreadId);
      const other = await store.addPost({ thread_id: otherThreadId, body: 'Unrelated archive', created_ts: new Date().toISOString() });
      ownIds.push(other.id);
      await foreignStore.getOrCreateThread({ kind: 'issue', ref: CHILD }, {
        thread_id: post.thread_id, created_ts: new Date().toISOString(),
      });
      const foreign = await foreignStore.addPost({ thread_id: post.thread_id, body: 'Other workspace archive', created_ts: new Date().toISOString() });
      expect(await foreignStore.getPostById(foreign.id)).toMatchObject({ body: foreign.body });
      const prefix = `${level === 'work_item' ? ref : `${level}:${ref}`}#comment:`;
      const rawRef = `${prefix}${post.id}`;
      const excludedRefs = [`${prefix}${other.id}`, `${prefix}${foreign.id}`, `${prefix}999999999`];
      const recovered = await resolvePriorAttemptRefs({
        target: { kind: level, ref, harness: HARNESS }, harness: HARNESS,
        rawRefs: [rawRef, ...excludedRefs], timeoutMs: 10_000,
      });
      expect(recovered?.records).toContainEqual(expect.objectContaining({ rawRef, text: note, actor: post.author_id }));
      expect(recovered?.unresolved).toEqual(excludedRefs);
      if (level === 'work_item') {
        const read = dataOf<{ results: Array<{ priorAttemptRefResolution: { records: Array<{ rawRef: string; text: string }>; unresolved: string[] } }> }>(
          await workItemsGetTool.handler({ id: CHILD, harness: HARNESS, priorAttemptRefs: [rawRef] } as never, CTX),
        );
        expect(read.results[0]?.priorAttemptRefResolution.records).toContainEqual(expect.objectContaining({ rawRef, text: note }));
        expect(read.results[0]?.priorAttemptRefResolution.unresolved).toEqual([]);
      }
    } finally {
      // Restore the shared fixture before the other history-consumer scenarios.
      await admin`DELETE FROM harness_shared.coord_thread_posts WHERE workspace_id = ${fx.workspaceId} AND id = ANY(${ownIds})`;
      await admin`UPDATE harness_shared.coord_threads t SET post_count = (
        SELECT count(*) FROM harness_shared.coord_thread_posts p WHERE p.workspace_id = t.workspace_id AND p.thread_id = t.thread_id
      ) WHERE t.workspace_id = ${fx.workspaceId} AND t.thread_id = ANY(${[post.thread_id, otherThreadId]})`;
      await admin`DELETE FROM harness_shared.coord_thread_posts WHERE workspace_id = ${foreignWorkspace} AND thread_id = ${post.thread_id}`;
      await admin`DELETE FROM harness_shared.coord_threads WHERE workspace_id = ${foreignWorkspace} AND thread_id = ${post.thread_id}`;
    }
  }, 60_000);

  it.each(['plan', 'goal'] as const)('captures %s lessons and distinguishes a failed stored read from missing history', async (level) => {
    const ref = level === 'plan' ? PLAN : GOAL;
    const note = [
      `Root cause: ${level} thread failures were swallowed.`,
      `False premise: empty history proved no ${level} lesson existed.`,
      'Outcome: the actual saved note was recovered.',
      `Residue: retain the ${level} scoped drill-down.`,
    ].join('\n');
    const capture = await postLearnedAtLevel({
      workItemId: CHILD, harness: HARNESS, level, text: note,
      workspaceId: fx.workspaceId, authorId: 'su-capture-fidelity-integration',
    });
    expect(capture).toMatchObject({ posted: true, level, requestedLevel: level, fellBack: false });
    expect(capture.advisory?.missing).toEqual([]);
    expect(capture.post).toBeTruthy();
    capturedThreadIds.add(capture.post!.thread_id);
    const rawRef = `${level}:${ref}#comment:${capture.post!.id}`;
    const read = () => level === 'plan' ? readPlanHistoryContext(PLAN, HARNESS) : readGoalHistoryContext(GOAL);
    const original = PgThreadStore.prototype.getThreadByParent;
    const failure = vi.spyOn(PgThreadStore.prototype, 'getThreadByParent').mockImplementation(function (this: PgThreadStore, parent) {
      if (parent.kind === level && parent.ref === (level === 'plan' ? `${HARNESS}:${PLAN}` : GOAL)) {
        return Promise.reject(new Error('P010 stored effort thread unavailable'));
      }
      return original.call(this, parent);
    });
    let failed: Awaited<ReturnType<typeof read>>;
    try {
      failed = await read();
      expect(failed.status).toBe('unknown');
      expect(failed.brief?.degradedSources).toContain(`${level}-thread`);
      expect(JSON.stringify(failed)).not.toContain(rawRef);
    } finally {
      failure.mockRestore();
    }
    const recovered = await read();
    expect(recovered.status).toBe('available');
    expect(recovered.recovery).toEqual(failed!.recovery);
    expect(recovered.brief?.degradedSources).toEqual([]);
    expect(recovered.brief?.authority).toContainEqual(expect.objectContaining({
      rawRef, authority: 'retraction',
      falsePremises: [expect.stringContaining(`no ${level} lesson existed`)],
    }));
    expect(recovered.brief?.protectedRefs.residue).toContain(rawRef);
    const raw = await resolvePriorAttemptRefs({
      target: level === 'plan' ? { kind: level, ref, harness: HARNESS } : { kind: level, ref },
      harness: HARNESS, rawRefs: [rawRef],
    });
    expect(raw?.unresolved).toEqual([]);
    expect(raw?.records[0]?.text).toBe(note);
  }, 60_000);

  it('delivers one stored child lesson through plans:get, launch context and the full leader builder', async () => {
    const planRead = dataOf<{ results: Array<Record<string, unknown>> }>(
      await plansGetTool.handler({ slug: PLAN, harness: HARNESS, mode: 'full' } as never, CTX),
    );
    const planResult = planRead.results[0] as {
      history: {
        status: string;
        brief: { attempts: Array<{ rawRef: string; text: string }> };
      };
    };
    expect(planResult.history.status).toBe('available');
    const assertPlanScope = (output: string) => {
      expect(output).toContain(CHILD_LESSON);
      expect(output).not.toContain(DIRECT_GOAL_LESSON);
      expect(output).not.toContain(UNRELATED_LESSON);
    };
    const planOutput = JSON.stringify(planResult.history);
    assertPlanScope(planOutput);
    // Use the same final-sink oracle against omitted-descendant and cross-scope
    // faults. A green integration result must not accept either broken output.
    expect(() => assertPlanScope(planOutput.replaceAll(CHILD_LESSON, ''))).toThrow();
    expect(() => assertPlanScope(`${planOutput}\n${UNRELATED_LESSON}`)).toThrow();
    expect(() => assertPlanScope(`${planOutput}\n${DIRECT_GOAL_LESSON}`)).toThrow();
    const rawRef = planResult.history.brief.attempts.find((attempt) => attempt.rawRef.startsWith(`${CHILD}#`))?.rawRef;
    expect(rawRef).toBe(`${CHILD}#checkpoint`);

    const recoveredRead = dataOf<{ results: Array<Record<string, unknown>> }>(
      await plansGetTool.handler(
        { slug: PLAN, harness: HARNESS, heading: 'History', priorAttemptRefs: [rawRef] } as never,
        CTX,
      ),
    );
    expect(JSON.stringify(recoveredRead.results[0])).toContain(CHILD_LESSON);

    const bundle = await buildPlanContextBundle(PLAN, {
      workspaceId: fx.workspaceId,
      harnessSlug: HARNESS,
    });
    expect(bundle?.history?.status).toBe('available');
    expect(bundle?.text).toContain('PLAN HISTORY — own and bounded child evidence');
    expect(bundle?.text).toContain(CHILD_LESSON);
    expect(bundle?.text).toContain(rawRef);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const leader = await buildLeaderBrief(
      { fleet: FLEET, harness: HARNESS, workspace: fx.workspaceId, include_stale: true },
      {
        ownerId: 'su-plan-history-consumer-integration',
        actorWorkspace: fx.workspaceId,
        allowLeadershipWrites: false,
        resolveCallerMembership: false,
      },
    );
    const unexpectedWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => !message.startsWith('[bounded-timeout]'));
    warn.mockRestore();
    expect(unexpectedWarnings).toEqual([]);
    expect(leader.data).toMatchObject({ ok: true, planHistory: { status: 'available' } });
    if (!('planHistory' in leader.data) || !leader.data.planHistory) {
      throw new Error('full leader output omitted planHistory');
    }
    expect(JSON.stringify(leader.data.planHistory)).toContain(CHILD_LESSON);
    expect(JSON.stringify(leader.data.planHistory)).toContain(rawRef);
  }, 60_000);

  it('delivers goal-owned, related-plan and child-item history into the goal holder brief with raw recovery', async () => {
    const history = await readGoalHistoryContext(GOAL);
    const serialized = JSON.stringify(history);
    expect(history.status).toBe('available');
    const assertGoalScope = (output: string) => {
      expect(output).toContain(GOAL_LESSON);
      expect(output).toContain('Preserve the current correction');
      expect(output).toContain(CHILD_ROOT_CAUSE);
      expect(output).toContain('direct goal attachment must survive without a plan');
      expect(output).not.toContain(UNRELATED_LESSON);
    };
    assertGoalScope(serialized);
    for (const omitted of [GOAL_LESSON, 'Preserve the current correction', CHILD_ROOT_CAUSE,
      'direct goal attachment must survive without a plan']) {
      expect(() => assertGoalScope(serialized.replaceAll(omitted, ''))).toThrow();
    }
    expect(() => assertGoalScope(`${serialized}\n${UNRELATED_LESSON}`)).toThrow();
    expect(history.brief?.rawRefs.filter((ref) => ref === `${CHILD}#checkpoint`)).toHaveLength(1);
    expect(history.brief?.rawRefs.filter((ref) => ref === `${DIRECT_GOAL_ITEM}#checkpoint`)).toHaveLength(1);
    expect(history.brief?.fanOut).toMatchObject({ truncated: false });

    const childRef = history.brief?.rawRefs.find((ref) => ref === `${CHILD}#checkpoint`);
    expect(childRef).toBe(`${CHILD}#checkpoint`);
    const recovered = await resolvePriorAttemptRefs({
      target: { kind: 'goal', ref: GOAL },
      rawRefs: [childRef!],
    });
    expect(recovered?.unresolved).toEqual([]);
    expect(recovered?.records[0]?.text).toContain(CHILD_LESSON);

    const kickoff = buildGoalKickoffBrief({
      goalId: GOAL,
      title: 'Goal history consumer integration',
      killCriterion: 'the current goal stop condition',
      history,
    });
    expect(kickoff).toContain('GOAL HISTORY — own and bounded descendant evidence');
    expect(kickoff).toContain(GOAL_LESSON);
    expect(kickoff).toContain('Preserve the current correction');
    expect(kickoff).toContain(CHILD_ROOT_CAUSE);
    expect(kickoff.indexOf('KILL THIS IF — the current goal stop condition')).toBeLessThan(
      kickoff.indexOf('GOAL HISTORY — own and bounded descendant evidence'),
    );
  }, 60_000);
});
