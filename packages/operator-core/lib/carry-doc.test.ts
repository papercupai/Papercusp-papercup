/** Deterministic carry-document builder (deterministic-context-carry P-009):
 *  the seam-driven assembly (identity + session-mode + plan-state + asks + tail
 *  layered on the carry brief) and the pure full-document renderer. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { CarryBrief } from './carry-brief';
import type { AutomaticCompactionRecovery } from './agent-tools/coordination/compaction-recovery';
import {
  buildCarryDoc,
  renderCarryDoc,
  completeRecoveryInstruction,
  deriveContinuation,
  gateOpenOwnerQuestion,
  carryDocBudgetChars,
  CARRY_DOC_BUDGET_FRACTION,
  CARRY_DOC_SLOTS,
  CARRY_DOC_SHED_LADDER,
  SELF_RECALL_POINTER,
  REORIENT_BANNER,
  CARRY_DOC_MAX_TAIL_TURNS,
  CARRY_DOC_MAX_PLAN_ITEMS,
  CARRY_DOC_MAX_BACKGROUND_TASKS,
  flagAsksAgainstFacts,
  detectRetractedContinuationRefs,
  renderRetractionGuard,
  renderBuiltAtStamp,
  type CarryDoc,
  type CarryDocPlanItem,
  type CarryDocAsk,
  type CarryDocTailTurn,
  type CarryDocContinuation,
  type CarryDocSlotKind,
  type CarryDocBackgroundTask,
} from './carry-doc';
import type { ProjectedTool } from '@papercusp/tooldef';

const NOW = 1_800_000_000_000;

function automaticRecovery(complete = true): AutomaticCompactionRecovery {
  return {
    marker: {
      schemaVersion: 'post-compaction-recovery-v1',
      complete,
      memoryEpoch: 23,
      controlGeneration: complete ? 17 : null,
      controlStateHash: complete ? 'state-hash-17' : null,
      fallback: {
        verb: 'coord:orient',
        args: { afterCompaction: true },
        when: [
          'marker-absent',
          'marker-incomplete',
          'control-state-mismatch',
          'legacy-control-generation-mismatch',
        ],
      },
    },
    recovery: {
      selfRecall: "sessions:search { session:'self', mode:'verbatim' }",
      loop: complete ? { active: true, intervalSec: 60 } : null,
      control: complete
        ? {
            schemaVersion: 'ctrl-v1',
            generation: 17,
            state: {
              modes: ['auto'],
              loop: { active: true, intervalSec: 60 },
              wakeSource: 'loop',
              carry: 'warm',
              route: { kind: 'self' },
              scope: {
                workspace: 'ws-1',
                harness: 'papercusp',
                plan: 'fleet-deltas-leader-primitives-2026-07-10',
                items: ['P-017'],
              },
            },
            provenance: {
              source: 'harness_shared.session_briefs.control_state',
              ownerId: 'su-1',
              updatedAt: '2026-08-25T00:00:00.000Z',
            },
            resync: {
              on: ['missing-base', 'schema-mismatch', 'generation-mismatch'],
              verb: 'coord:orient',
              args: { afterCompaction: true },
              rule: 'replace-full-never-merge-behind',
            },
            budget: { estimatedTokens: 100, maxTokens: 384 },
          }
        : null,
      planAuthority: complete
        ? {
            resolution: 'current',
            controlGeneration: 17,
            workspaceId: 'ws-1',
            harness: 'papercusp',
            planSlug: 'fleet-deltas-leader-primitives-2026-07-10',
            version: 31,
            contentHash: 'current-plan-hash',
            planStatus: 'ready',
            decisions: [{
              id: 'D-009',
              title: 'current authority wins',
              body: 'Use the current plan before any carried checkpoint.',
              truncated: false,
            }],
            items: [{ id: 'P-017', status: 'wip', text: 'current item', missing: false }],
            specs: [{
              specId: 'SPEC-P-017',
              revision: 4,
              contentHash: 'current-spec-hash',
              planItemId: 'P-017',
            }],
          }
        : null,
      checkpoints: [
        {
          id: 'WI-41558',
          harness: 'papercusp',
          title: 'automatic recovery',
          body: 'reuse the deterministic carry boundary',
          checkpoint: 'P-017 in progress',
        },
      ],
      coverage: {
        selfSession: true,
        control: complete,
        heldItems: true,
        planAuthority: complete,
        staleness: null,
      },
    },
  };
}

/** The holder proof a carried item must present for a renderer to show its
 *  title/body/checkpoint as the successor's OWN lane. Absent or mismatched proof
 *  fails closed to a read-only ownership warning (carry-brief.ts,
 *  assessHeldItemOwnership) — so a fixture that omits it is asserting the
 *  warning path, not the checkpoint path. */
const HOLDER_PROOF = { ownerId: 'su-1', workspaceId: 'ws-1' } as const;

function brief(over: Partial<CarryBrief> = {}): CarryBrief {
  return {
    ownerId: 'su-1',
    workspaceId: 'ws-1',
    loop: { harness: 'papercusp', active: true, intervalSec: 60, goal: null, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW },
    heldItems: [],
    directives: [],
    directivesTotalOpen: 0,
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
    ...over,
  };
}

function projectedTool(
  name: string,
  over: Partial<Pick<ProjectedTool, 'agentRoles' | 'capabilities' | 'effect'>> = {},
): ProjectedTool {
  return {
    expose: { mcp: { name } },
    inputSchema: {},
    capabilities: [],
    effect: 'write',
    ...over,
  } as ProjectedTool;
}

describe('flagAsksAgainstFacts (WI-5682 — decided-directive-re-asked guard)', () => {
  it('flags an open ask that re-litigates a decided standing fact', () => {
    const asks: CarryDocAsk[] = [{
      id: 'conv-mrssq5xh',
      question:
        "Fleet-drain scope decision: 55 open bugs live under harness_slug='operator:papercusp-workspace' outside the papercusp drain lane — fold them in?",
      askedAtMs: NOW,
    }];
    const facts = [{
      key: 'work-item-pot-binding-integrity',
      body:
        'operator:papercusp-workspace is NOT a real pot; MOVE those work-items to the papercusp pot; 37 open bugs orphaned under harness_slug.',
    }];
    const [flagged] = flagAsksAgainstFacts(asks, facts);
    expect(flagged.possiblyDecidedBy).toEqual(['work-item-pot-binding-integrity']);
  });

  it('does NOT flag a genuinely unrelated open question', () => {
    const asks: CarryDocAsk[] = [{
      id: 'conv-x',
      question: 'Should we bump the gateway timeout for the nightly bench run?',
      askedAtMs: NOW,
    }];
    const facts = [{
      key: 'work-item-pot-binding-integrity',
      body: 'operator:papercusp-workspace is not a real pot; move work-items to the papercusp pot.',
    }];
    expect(flagAsksAgainstFacts(asks, facts)[0].possiblyDecidedBy).toBeUndefined();
  });

  it('is a no-op with no facts (never invents a collision)', () => {
    const asks: CarryDocAsk[] = [{ id: 'c', question: 'anything at all in here', askedAtMs: null }];
    expect(flagAsksAgainstFacts(asks, [])).toEqual(asks);
  });
});

describe('buildCarryDoc (seam-driven assembly)', () => {
  const base = {
    workspaceId: 'ws-1',
    harness: 'papercusp',
    ownerLabel: 'su · su-1',
    buildCarryBriefFn: async () => brief(),
    buildAutomaticRecoveryFn: async () => automaticRecovery(),
    getModesFn: async () => [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }],
  };

  it('assembles identity + session-mode from the brief + seams', async () => {
    const doc = await buildCarryDoc('su-1', base);
    expect(doc.identity).toMatchObject({ ownerId: 'su-1', harness: 'papercusp', workspaceId: 'ws-1', ownerLabel: 'su · su-1' });
    expect(doc.sessionMode.loopActive).toBe(true);
    expect(doc.sessionMode.loopIntervalSec).toBe(60);
    expect(doc.sessionMode.modes).toEqual([{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }]);

    const judgeDoc = await buildCarryDoc('su-1', { ...base, role: 'judge' });
    expect(judgeDoc.identity.role).toBe('judge');
  });

  it('reuses the brief-resolved workspace for every follow-on read when the caller omits it (EI-25752506657737963)', async () => {
    const seen: Record<string, string[]> = {
      recovery: [], witness: [], modes: [], planItems: [], asks: [], backgroundTasks: [],
    };
    const build = async (workspaceId?: string) => {
      const resolvedWorkspace = workspaceId ?? 'ws-resolved-by-brief';
      return buildCarryDoc('su-1', {
        ...(workspaceId ? { workspaceId } : {}),
        harness: 'papercusp',
        buildCarryBriefFn: async () => brief({ workspaceId: resolvedWorkspace }),
        buildAutomaticRecoveryFn: async (_ownerId, recoveryWorkspace) => {
          seen.recovery.push(recoveryWorkspace);
          const recovery = automaticRecovery();
          if (recovery.recovery.control) {
            recovery.recovery.control.state.scope.workspace = recoveryWorkspace;
          }
          return recovery;
        },
        // Carry assembly can re-arm a control witness. Keep this preview-like test read-only.
        armControlWitnessFn: async (_ownerId, witnessWorkspace) => {
          seen.witness.push(witnessWorkspace);
          return null;
        },
        getModesFn: async (modeWorkspace) => {
          seen.modes.push(modeWorkspace);
          return [];
        },
        getPlanItemsFn: async (_ownerId, planWorkspace) => {
          seen.planItems.push(planWorkspace);
          return [];
        },
        getAsksFn: async (_ownerId, askWorkspace) => {
          seen.asks.push(askWorkspace);
          return [];
        },
        getBackgroundTasksFn: async (_ownerId, taskWorkspace) => {
          seen.backgroundTasks.push(taskWorkspace);
          return [];
        },
        getTailFn: async () => [],
      });
    };

    const inferred = await build();
    expect(inferred.identity.workspaceId).toBe('ws-resolved-by-brief');
    expect(inferred.automaticRecovery?.marker.complete).toBe(true);
    expect(seen).toEqual({
      recovery: ['ws-resolved-by-brief'],
      witness: ['ws-resolved-by-brief'],
      modes: ['ws-resolved-by-brief'],
      planItems: ['ws-resolved-by-brief'],
      asks: ['ws-resolved-by-brief'],
      backgroundTasks: ['ws-resolved-by-brief'],
    });

    // An explicit caller scope remains authoritative and is passed through every leg.
    const explicit = await build('ws-explicit');
    expect(explicit.identity.workspaceId).toBe('ws-explicit');
    expect(seen.recovery.at(-1)).toBe('ws-explicit');
    expect(seen.modes.at(-1)).toBe('ws-explicit');
    expect(seen.planItems.at(-1)).toBe('ws-explicit');
    expect(seen.asks.at(-1)).toBe('ws-explicit');
    expect(seen.backgroundTasks.at(-1)).toBe('ws-explicit');
  });

  it('downgrades a complete recovery marker from another workspace and does not re-arm its witness', async () => {
    const witness = vi.fn(async () => null);
    const recovery = automaticRecovery();
    if (!recovery.recovery.control) throw new Error('fixture control anchor is required');
    recovery.recovery.control.state.scope.workspace = 'ws-other';

    const doc = await buildCarryDoc('su-1', {
      ...base,
      workspaceId: 'ws-1',
      buildCarryBriefFn: async () => brief({ workspaceId: 'ws-1' }),
      buildAutomaticRecoveryFn: async () => recovery,
      armControlWitnessFn: witness,
    });

    expect(doc.identity.workspaceId).toBe('ws-1');
    expect(doc.automaticRecovery?.marker.complete).toBe(false);
    expect(doc.automaticRecovery?.marker).toMatchObject({ controlGeneration: null, controlStateHash: null });
    expect(doc.automaticRecovery?.recovery).toMatchObject({
      loop: null,
      control: null,
      planAuthority: null,
      coverage: { control: false, planAuthority: false },
    });
    expect(doc.automaticRecovery?.recovery.coverage.control).toBe(false);
    expect(witness).not.toHaveBeenCalled();
  });

  // WI-10002058. Every caller of buildCarryDoc is a context-wipe producer, and the
  // ⟦CTRL:…⟧ block that would correct a stale marker only fires when the control
  // generation exceeds an owner-scoped, advance-only delivery watermark. The wipe
  // destroys the context that was "told" but leaves the watermark high, so the
  // block stays silent and its silence reads as agreement with a marker stamped at
  // BUILD time. Re-arming against this document's own stamp is what makes silence
  // mean "still current" instead of "nobody checked".
  it('re-arms the control witness against the stamp the document actually carries', async () => {
    const rearms: Array<[string, string, number]> = [];
    const doc = await buildCarryDoc('su-1', {
      ...base,
      armControlWitnessFn: async (ownerId, workspaceId, stampedGeneration) => {
        rearms.push([ownerId, workspaceId, stampedGeneration]);
        return { rearmed: true };
      },
    });

    // The stamp handed to the re-arm must be the SAME generation the delivered
    // marker claims. A re-arm against any other value re-arms for a document
    // nobody is reading.
    expect(rearms).toEqual([['su-1', 'ws-1', 17]]);
    expect(doc.automaticRecovery?.marker.controlGeneration).toBe(17);
  });

  it('skips the re-arm when the marker carries no stamp to re-arm against', async () => {
    const rearms: number[] = [];
    await buildCarryDoc('su-1', {
      ...base,
      buildAutomaticRecoveryFn: async () => automaticRecovery(false),
      armControlWitnessFn: async (_o, _w, stampedGeneration) => {
        rearms.push(stampedGeneration);
        return null;
      },
    });

    // An incomplete marker already routes the successor through the orient
    // fallback, and there is no generation to roll back to. Re-arming to a
    // guessed value would be worse than not re-arming.
    expect(rearms).toEqual([]);
  });

  it('still produces a document when the re-arm fails', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      armControlWitnessFn: async () => {
        throw new Error('session_briefs unreachable');
      },
    });

    // A failed re-arm costs the automatic correction — the pre-existing
    // behaviour — never the carry document the successor boots on.
    expect(doc.identity.ownerId).toBe('su-1');
    expect(doc.automaticRecovery?.marker.complete).toBe(true);
  });

  it('records role-infeasible mutating carry references without changing the live text', async () => {
    const projectedTools = [
      projectedTool('work_items:complete', { agentRoles: ['worker'] }),
      projectedTool('git-sync:run', { agentRoles: ['worker'] }),
      projectedTool('code:run', { agentRoles: ['judge', 'worker'], capabilities: ['capability:bash'] }),
      projectedTool('coord:declare-intent', { agentRoles: ['judge', 'worker'] }),
      projectedTool('work_items:get', { agentRoles: ['judge', 'worker'], effect: 'read' }),
    ];
    const carried = brief({
      loop: {
        harness: 'papercusp',
        active: true,
        intervalSec: 60,
        goal: null,
        carryNote: 'Next: work_items:complete, then git-sync:run and code:run.',
        carryNoteUpdatedAtMs: NOW,
      },
      heldItems: [
        {
          id: 'EI-unsafe',
          title: 'finish with work_items:complete',
          body: 'git-sync:run after the code:run verification',
          harness: 'papercusp',
          checkpoint: 'coord:declare-intent { items: [] }',
          holderProof: HOLDER_PROOF,
        },
        {
          id: 'EI-safe',
          title: 'read current state with work_items:get',
          body: 'coord:declare-intent is an allowed control for this role',
          harness: 'papercusp',
          checkpoint: 'coord:declare-intent { items: [] }',
          holderProof: HOLDER_PROOF,
        },
      ],
    });
    const doc = await buildCarryDoc('su-1', {
      ...base,
      role: 'judge',
      projectedToolsFn: () => projectedTools,
      buildCarryBriefFn: async () => carried,
    });

    expect(doc.roleSafety).toEqual({
      role: 'judge',
      blockedToolNames: ['code:run', 'git-sync:run', 'work_items:complete'],
      heldItemIds: ['EI-unsafe'],
      deferredItemIds: [],
      sources: ['held-item', 'loop'],
    });
    const text = renderCarryDoc(doc, NOW);
    expect(text).toContain('Routed/stranded carry handoff (role-infeasible)');
    expect(text).toContain('EI-unsafe');
    expect(text).toContain('EI-safe');
    expect(text).toContain('coord:declare-intent');
    for (const forbidden of ['work_items:complete', 'git-sync:run', 'code:run']) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('preserves the same carried controls for a write-capable non-judge role', async () => {
    const projectedTools = [
      projectedTool('work_items:complete', { agentRoles: ['worker'] }),
      projectedTool('git-sync:run', { agentRoles: ['worker'] }),
      projectedTool('code:run', { agentRoles: ['judge', 'worker'], capabilities: ['capability:bash'] }),
      projectedTool('coord:declare-intent', { agentRoles: ['judge', 'worker'] }),
    ];
    const carried = brief({
      heldItems: [
        {
          id: 'EI-worker',
          title: 'finish with work_items:complete',
          body: 'git-sync:run after code:run',
          harness: 'papercusp',
          checkpoint: 'git-sync:run after code:run; coord:declare-intent { items: [] }',
          holderProof: HOLDER_PROOF,
        },
      ],
    });
    const doc = await buildCarryDoc('su-1', {
      ...base,
      role: 'worker',
      projectedToolsFn: () => projectedTools,
      buildCarryBriefFn: async () => carried,
    });

    expect(doc.roleSafety).toBeNull();
    const text = renderCarryDoc(doc, NOW);
    expect(text).toContain('work_items:complete');
    expect(text).toContain('git-sync:run');
    expect(text).toContain('code:run');
    expect(text).toContain('coord:declare-intent');
    expect(text).not.toContain('Routed/stranded carry handoff');
  });

  it('builds one automatic recovery from the already-read carry held-items snapshot', async () => {
    const heldItems = [
      {
        id: 'WI-41558',
        title: 'automatic recovery',
        body: 'reuse the deterministic carry boundary',
        harness: 'papercusp',
        checkpoint: 'P-017 in progress',
        checkpointUpdatedAtMs: NOW,
      },
    ];
    const buildAutomaticRecoveryFn = vi.fn(async () => automaticRecovery());
    const built = await buildCarryDoc('su-1', {
      ...base,
      buildCarryBriefFn: async () => brief({ heldItems }),
      buildAutomaticRecoveryFn,
    });

    expect(buildAutomaticRecoveryFn).toHaveBeenCalledOnce();
    expect(buildAutomaticRecoveryFn).toHaveBeenCalledWith('su-1', 'ws-1', {
      sessionHarness: 'papercusp',
      heldItems,
    });
    expect(built.automaticRecovery).toEqual(automaticRecovery());
  });

  it('does not infer caller/session scope from a different persisted loop harness', async () => {
    const buildAutomaticRecoveryFn = vi.fn(async () => automaticRecovery());
    const { harness: _callerHarness, ...baseWithoutHarness } = base;
    const built = await buildCarryDoc('su-1', {
      ...baseWithoutHarness,
      buildCarryBriefFn: async () =>
        brief({
          loop: {
            harness: 'persisted-loop-scope',
            active: true,
            intervalSec: 60,
            goal: null,
            carryNote: '## Next\ngo',
            carryNoteUpdatedAtMs: NOW,
          },
        }),
      buildAutomaticRecoveryFn,
    });

    expect(buildAutomaticRecoveryFn).toHaveBeenCalledWith('su-1', 'ws-1', {
      sessionHarness: null,
      heldItems: [],
    });
    expect(built.identity.harness).toBeNull();
  });

  /**
   * EI-20072281215342526 — the carry document printed the loop's INTERVAL and not its
   * GOAL, so a respawned successor was told a loop existed but not what it was FOR.
   * That asymmetry is the bug: the successor inherits its held work-items without the
   * mission that generated them, and does not halt — it re-orients, sees unclaimed
   * backlog, and confidently starts something else.
   */
  describe('the loop GOAL is carried — the mission, not just the cadence', () => {
    const withGoal = (goal: string | null) => ({
      ...base,
      buildCarryBriefFn: async () =>
        brief({
          loop: { harness: 'papercusp', active: true, intervalSec: 60, goal, carryNote: '## Next\ngo', carryNoteUpdatedAtMs: NOW },
        }),
    });

    it('carries the goal onto sessionMode and renders it VERBATIM', async () => {
      const mission = 'Drive plan retire-mug-kettle-su-only-2026-08-09 (harness papercusp) to completion.';
      const doc = await buildCarryDoc('su-1', withGoal(mission));
      expect(doc.sessionMode.loopGoal).toBe(mission);
      const text = renderCarryDoc(doc, NOW);
      // Verbatim, not summarised: the successor's whole problem is that it holds no
      // other copy of this text.
      expect(text).toContain(mission);
      expect(text).toContain('YOUR MISSION');
      // It must still say the goal is frozen — carrying it more prominently without
      // that caveat would just move the staleness problem into the carry document.
      expect(text).toMatch(/frozen at arm time/);
    });

    it('renders NO mission line when the loop has no goal — never a blank one', async () => {
      const doc = await buildCarryDoc('su-1', withGoal(null));
      expect(doc.sessionMode.loopGoal).toBeNull();
      const text = renderCarryDoc(doc, NOW);
      expect(text).not.toContain('YOUR MISSION');
      // The loop line itself is untouched.
      expect(text).toContain('loop: ARMED (every 60s)');
    });
  });

  it('a throwing brief build degrades to an empty brief, never throws', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      buildCarryBriefFn: async () => {
        throw new Error('db down');
      },
    });
    expect(doc.brief.heldItems).toEqual([]);
    expect(doc.sessionMode.loopActive).toBe(false);
  });

  it('a throwing mode seam yields no modes, never a failed document', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      getModesFn: async () => {
        throw new Error('modes down');
      },
    });
    expect(doc.sessionMode.modes).toEqual([]);
  });

  it('caps the tail to the most-recent N turns', async () => {
    const turns: CarryDocTailTurn[] = Array.from({ length: CARRY_DOC_MAX_TAIL_TURNS + 4 }, (_, i) => ({
      speaker: 'assistant',
      text: `turn ${i}`,
      ts: null,
    }));
    const doc = await buildCarryDoc('su-1', { ...base, getTailFn: async () => turns });
    expect(doc.tail).toHaveLength(CARRY_DOC_MAX_TAIL_TURNS);
    expect(doc.tail[doc.tail.length - 1].text).toBe(`turn ${CARRY_DOC_MAX_TAIL_TURNS + 3}`);
  });

  it('the plan-state seam flows through and is capped to the max', async () => {
    const many: CarryDocPlanItem[] = Array.from({ length: CARRY_DOC_MAX_PLAN_ITEMS + 3 }, (_, i) => ({
      itemId: `P-${i}`,
      planSlug: 'plan-x',
      status: 'wip',
      disposition: 'active',
    }));
    const doc = await buildCarryDoc('su-1', { ...base, getPlanItemsFn: async () => many });
    expect(doc.planItems).toHaveLength(CARRY_DOC_MAX_PLAN_ITEMS);
    expect(doc.planItems[0]).toMatchObject({ itemId: 'P-0', planSlug: 'plan-x', disposition: 'active' });
  });

  it('the asks seam surfaces only the caller-asked open questions', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      getPlanItemsFn: async () => [],
      getAsksFn: async () => [
        { id: 'c1', question: 'which backend?', askedAtMs: NOW },
        { id: 'c2', question: 'ship gate?', askedAtMs: null },
      ],
    });
    expect(doc.asks.map((a) => a.id)).toEqual(['c1', 'c2']);
  });

  it('asks / tail degrade to empty when the readers find nothing / no transcript', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      getPlanItemsFn: async () => [],
      getAsksFn: async () => [],
    });
    expect(doc.asks).toEqual([]);
    expect(doc.tail).toEqual([]);
  });

  it('the real tail leg reads a transcript file and MECHANICALLY stamps user turns (D-003)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-carry-doc-test-'));
    try {
      const f = join(dir, 'sess.jsonl');
      const line = (role: 'user' | 'assistant', text: string, ts: string) =>
        JSON.stringify({ type: role, timestamp: ts, sessionId: 's', message: { role, content: [{ type: 'text', text }] } });
      writeFileSync(
        f,
        [
          line('user', 'ship the carry doc', '2026-07-14T10:00:00Z'),
          line('assistant', 'wiring the tail reader', '2026-07-14T10:00:05Z'),
          line('user', '⟦turn-origin:wake-pump nonce:6b5c8079e022af6b⟧ loop wake — continue', '2026-07-14T10:01:00Z'),
        ].join('\n') + '\n',
      );
      const doc = await buildCarryDoc('su-1', { ...base, getPlanItemsFn: async () => [], transcriptPath: f });
      expect(doc.tail.map((t) => t.text)).toEqual([
        'ship the carry doc',
        'wiring the tail reader',
        '⟦turn-origin:wake-pump nonce:6b5c8079e022af6b⟧ loop wake — continue',
      ]);
      expect(doc.tail[0].ts).toBe('2026-07-14T10:00:00.000Z');
      // The stamp is decided by the recorded envelope, not the prose: no
      // envelope → owner-typed; an envelope → agent-injected with its origin.
      expect(doc.tail[0].provenance).toEqual({ verdict: 'owner-typed', origin: null });
      expect(doc.tail[1].provenance).toBeNull(); // assistant turns carry none
      expect(doc.tail[2].provenance).toEqual({ verdict: 'agent-injected', origin: 'wake-pump' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Codex bootstrap plus a loop-fire prompt do not create an unanswered owner message', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'papercusp-carry-doc-test-'));
    try {
      const f = join(dir, 'sess.jsonl');
      const line = (text: string, ts: string) =>
        JSON.stringify({ type: 'user', timestamp: ts, sessionId: 's', message: { role: 'user', content: [{ type: 'text', text }] } });
      writeFileSync(
        f,
        [
          line('# AGENTS.md instructions\n\n<INSTRUCTIONS>session setup</INSTRUCTIONS>', '2026-07-14T10:00:00Z'),
          line('⟦turn-origin:loop-fire nonce:6b5c8079e022af6b⟧ continue from the loop checkpoint', '2026-07-14T10:01:00Z'),
        ].join('\n') + '\n',
      );
      const doc = await buildCarryDoc('su-1', {
        ...base,
        getPlanItemsFn: async () => [],
        boundaryDeliberate: true,
        transcriptPath: f,
      });
      expect(doc.tail.map((t) => t.provenance)).toEqual([
        { verdict: 'machine-surface', origin: null },
        { verdict: 'agent-injected', origin: 'loop-fire' },
      ]);
      expect(doc.continuation.lastOwnerMessage).toBeNull();
      expect(doc.continuation.pendingOwnerMessages ?? []).toEqual([]);
      expect(gateOpenOwnerQuestion(doc.continuation).crossesOpenOwnerMessage).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('same-session retracted continuation guard (EI-22416629442936687)', () => {
  const machineContinuation: CarryDocTailTurn = {
    speaker: 'user',
    text: 'Continue the ship path for EI-20191442676357637.',
    ts: '2026-09-05T10:15:31.000Z',
    provenance: { verdict: 'agent-injected', origin: 'self-compaction' },
  };
  const withdrawal: CarryDocTailTurn = {
    speaker: 'assistant',
    text: 'Stop — the carry handed me another agents live work. I will not take over covered work.',
    ts: '2026-09-05T10:16:53.000Z',
    provenance: null,
  };

  it('records ids only from an explicitly withdrawn machine continuation', () => {
    expect(detectRetractedContinuationRefs([machineContinuation, withdrawal])).toEqual([
      'EI-20191442676357637',
    ]);
    const explicitCorrection: CarryDocTailTurn = {
      speaker: 'assistant',
      text: 'I retract the preceding continuation instruction for EI-20191442676357637.',
      ts: null,
      provenance: null,
    };
    expect(detectRetractedContinuationRefs([machineContinuation, explicitCorrection])).toEqual([
      'EI-20191442676357637',
    ]);
    expect(detectRetractedContinuationRefs([{ speaker: 'assistant', text: 'I corrected EI-7', ts: null }])).toEqual([]);
  });

  it('ignores an unrelated audit-request withdrawal even when it names held continuation items', () => {
    const heldItemsContinuation: CarryDocTailTurn = {
      ...machineContinuation,
      text: 'Continue work on WI-10002911 and EI-24129745455846833.',
    };
    const auditRequestWithdrawal: CarryDocTailTurn = {
      speaker: 'assistant',
      text: 'The audit request for WI-10002911 and EI-24129745455846833 was withdrawn after I rerouted it to another agent.',
      ts: null,
      provenance: null,
    };
    expect(detectRetractedContinuationRefs([heldItemsContinuation, auditRequestWithdrawal])).toEqual([]);
  });

  it('renders a high-priority guard that makes the tail non-operative', () => {
    const guard = renderRetractionGuard(['EI-20191442676357637']);
    expect(guard).toContain('RETRACTED CONTINUATION DIRECTIVE');
    expect(guard).toContain('Do NOT reissue, claim, or act');
    expect(renderRetractionGuard([])).toBe('');
  });

  it('carries the guard into the deterministic addendum before the verbatim tail', async () => {
    const built = await buildCarryDoc('su-1', {
      workspaceId: 'ws-1',
      harness: 'papercusp',
      ownerLabel: 'su · su-1',
      buildCarryBriefFn: async () => brief(),
      buildAutomaticRecoveryFn: async () => automaticRecovery(),
      getModesFn: async () => [],
      getPlanItemsFn: async () => [],
      getTailFn: async () => [machineContinuation, withdrawal],
    });
    expect(built.retractedContinuationRefs).toEqual(['EI-20191442676357637']);
    const text = renderCarryDoc(built, NOW);
    expect(text.indexOf('Retraction guard')).toBeLessThan(text.indexOf('Verbatim tail'));
  });
});

describe('renderBuiltAtStamp (EI-18697157970421032, pure)', () => {
  it('renders the exact ISO build time and a concrete staleness window', () => {
    const stamp = renderBuiltAtStamp(NOW);
    expect(stamp).toContain(new Date(NOW).toISOString());
    expect(stamp).toContain('Carry document built at');
    expect(stamp).toMatch(/30 minutes/);
  });

  it('is deterministic (same input, same output)', () => {
    expect(renderBuiltAtStamp(NOW)).toBe(renderBuiltAtStamp(NOW));
    expect(renderBuiltAtStamp(NOW)).not.toBe(renderBuiltAtStamp(NOW + 1));
  });

  it('warns about the build-to-death blind window (EI-18894888815338094)', () => {
    // A successor's own pre-respawn session can keep doing real, durable work
    // (finishing an experiment, writing an artifact) AFTER this stamp but before
    // it actually dies — none of that is reflected in an already-frozen document.
    // The stamp must tell the reader this document is a LOWER BOUND, not a
    // complete record, and to check the filesystem/work-item before redoing work.
    const stamp = renderBuiltAtStamp(NOW);
    expect(stamp).toMatch(/BLIND WINDOW/);
    expect(stamp).toContain('may have kept working');
    expect(stamp).toMatch(/check the filesystem/);
  });

  it('warns that a RETRACTED CLAIM can ride the same blind window (EI-19340500312449463)', () => {
    // A pre-respawn session can report a finding, catch it overstated the
    // claim, and retract it (coord:send correction / work-item comment /
    // loop:checkpoint) — all AFTER this document was assembled but before it
    // actually died. Without an explicit warning, a successor reads the
    // already-frozen (and since-withdrawn) claim as this system-injected
    // document's own framing — MORE apparent authority than the peer-authored
    // correction it superseded. The stamp must name this explicitly (not just
    // "artifacts/experiments") and point at coord:feed / the work-item's
    // comments as the authority instead.
    const stamp = renderBuiltAtStamp(NOW);
    expect(stamp).toMatch(/RETRACTED CLAIMS/);
    expect(stamp).toContain('coord:feed');
    expect(stamp).toMatch(/more apparent authority/i);
  });
});

describe('renderCarryDoc (pure)', () => {
  const planItems: CarryDocPlanItem[] = [
    { itemId: 'P-009', planSlug: 'deterministic-context-carry-2026-07-14', status: 'wip', disposition: 'claimed' },
  ];
  const asks: CarryDocAsk[] = [{ id: '7', question: 'Which backend for the sweep?', askedAtMs: NOW }];
  const tail: CarryDocTailTurn[] = [
    { speaker: 'owner', text: 'ship it', ts: '2026-07-14T10:00:00Z' },
    { speaker: 'assistant', text: 'on it', ts: '2026-07-14T10:00:05Z' },
  ];

  function doc(over: Partial<CarryDoc> = {}): CarryDoc {
    return {
      brief: brief(),
      identity: { ownerId: 'su-1', ownerLabel: 'su · su-1', harness: 'papercusp', workspaceId: 'ws-1', fleet: { slug: 'f1', role: 'leader' }, account: 'default' },
      sessionMode: { modes: [{ mode: 'auto', ownerDirected: true, reason: 'owner set it' }], loopActive: true, loopIntervalSec: 60 },
      planItems,
      asks,
      tail,
      continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true },
      ...over,
    };
  }

  it('renders a complete generation-stamped recovery as already delivered, with declare-intent as the next call', () => {
    const text = renderCarryDoc(doc({ automaticRecovery: automaticRecovery() }), NOW);
    expect(text).toContain('⟦post-compaction-recovery⟧');
    expect(text).toContain('"schemaVersion":"post-compaction-recovery-v1"');
    expect(text).toContain('"memoryEpoch":23');
    expect(text).toContain('"controlGeneration":17');
    expect(text).toContain('Do NOT call coord:orient');
    expect(text).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    expect(text).not.toContain('planItems');
    expect(text).toContain('control generation 17');
    expect(text).toContain('control state hash state-hash-17');
    expect(text).toContain('current plan authority (PRECEDES carried summaries)');
    expect(text).toContain('version=31 contentHash=current-plan-hash');
    expect(text).toContain('D-009 current authority wins');
    expect(text).toContain('P-017=wip');
    expect(text).toContain('SPEC-P-017@4#current-spec-hash');
    expect(text.indexOf('current plan authority (PRECEDES carried summaries)')).toBeLessThan(
      text.indexOf('## Standing carry'),
    );
  });

  it('renders an unavailable plan authority as an incomplete recovery instruction', () => {
    const recovery = automaticRecovery(false);
    recovery.marker.controlGeneration = 17;
    recovery.recovery.control = automaticRecovery(true).recovery.control;
    recovery.recovery.planAuthority = {
      resolution: 'unavailable',
      controlGeneration: 17,
      workspaceId: 'ws-1',
      harness: 'wrong-harness',
      planSlug: 'fleet-deltas-leader-primitives-2026-07-10',
      reason: 'not-found-in-control-harness',
    };
    recovery.recovery.coverage.control = true;
    recovery.recovery.coverage.planAuthority = false;

    const text = renderCarryDoc(doc({ automaticRecovery: recovery }), NOW);
    expect(text).toContain('current plan authority: UNAVAILABLE');
    expect(text).toContain('reason=not-found-in-control-harness');
    expect(text).toContain('recovery marker is incomplete');
  });

  it('renders judge recovery with self-only transcript recall and without engineering directives', () => {
    const base = doc();
    const text = renderCarryDoc(
      {
        ...base,
        identity: { ...base.identity, role: 'judge' },
        automaticRecovery: automaticRecovery(),
      },
      NOW,
    );

    expect(text).toContain('- role: judge');
    expect(text).toContain('assigned evaluation');
    expect(text).toContain("sessions:read { session:'self', order:'asc', limit:40 }");
    for (const forbidden of [
      'coord:orient',
      'coord:declare-intent',
      'scheduler:get_next',
      'loop:status',
      'code:run',
      'sessions:search',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it('keeps judge fallback recovery self-scoped when the marker is absent or incomplete', () => {
    const base = doc();
    for (const recovery of [null, automaticRecovery(false)]) {
      const text = renderCarryDoc(
        { ...base, identity: { ...base.identity, role: 'judge' }, automaticRecovery: recovery },
        NOW,
      );
      expect(text).toContain('evaluation kickoff');
      expect(text).toContain("sessions:read { session:'self', order:'asc', limit:40 }");
      expect(text).not.toContain('coord:orient');
      expect(text).not.toContain('sessions:search');
    }
  });

  /** P-011: the instruction BESIDE a complete marker must defer to a later
   * ⟦CTRL:…⟧ generation. The marker JSON always carried
   * `control-generation-mismatch` in `fallback.when`, but the adjacent prose —
   * the line a reader actually acts on — said "Do NOT call coord:orient" with
   * no condition, so a successor delivered after the control state moved on
   * skipped a re-orient it was owed. These bind the RENDERED DOCUMENT, not just
   * the helper: a correct helper behind an unwired seam is the failure mode
   * this plan exists to close. */
  describe('complete-marker recovery instruction defers to a later control generation (P-011)', () => {
    it('names the stamped generation and states the mismatch escape in the rendered document', () => {
      const text = renderCarryDoc(doc({ automaticRecovery: automaticRecovery() }), NOW);
      // The stamped generation is named inline so the comparison against the
      // turn's CTRL block is mechanical rather than requiring marker parsing.
      expect(text).toContain('Automatic recovery is complete for control generation 17');
      expect(text).toContain('⟦CTRL:…⟧ still reports the same control state hash state-hash-17');
      // The escape itself must be present and must name the verb to call.
      expect(text).toContain('reports a DIFFERENT control state hash');
      expect(text).toContain('this recovery is STALE for it');
      expect(text).toContain('does NOT apply');
      expect(text).toContain('Call `coord:orient { afterCompaction: true }` exactly once');
    });

    it('still tells a matching-generation reader NOT to re-fetch, and to declare its lane', () => {
      const text = renderCarryDoc(doc({ automaticRecovery: automaticRecovery() }), NOW);
      expect(text).toContain('Do NOT call coord:orient to re-fetch it');
      expect(text).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    });

    it('is a CONDITIONAL do-not-re-fetch: the unconditional sentence is gone', () => {
      const text = renderCarryDoc(doc({ automaticRecovery: automaticRecovery() }), NOW);
      // The exact pre-fix sentence. Its whole defect was that it terminated at
      // "re-fetch it" with no generation condition anywhere in the clause.
      expect(text).not.toContain(
        'Automatic recovery is complete for the stamped control generation. Do NOT call coord:orient to re-fetch it;',
      );
    });

    it('falls back to generic wording rather than printing a null generation', () => {
      const recovery = automaticRecovery();
      recovery.marker.controlGeneration = null;
      const text = renderCarryDoc(doc({ automaticRecovery: recovery }), NOW);
      expect(text).toContain('Automatic recovery is complete for the stamped control generation');
      expect(text).not.toContain('control generation null');
      // The mismatch escape must survive the degraded-stamp path.
      expect(text).toContain('legacy block without a hash, a DIFFERENT generation');
    });

    it('gives the judge a stale-generation escape that never names coord:orient', () => {
      const judge = completeRecoveryInstruction(17, true, 'state-hash-17');
      expect(judge).toContain('control generation 17');
      expect(judge).toContain('control state hash state-hash-17');
      expect(judge).toContain('reports a DIFFERENT control state hash');
      expect(judge).toContain('STALE for it');
      expect(judge).not.toContain('coord:orient');
      expect(judge).not.toContain('coord:declare-intent');
    });
  });

  it('treats a generation-only carry restart as current when the control state hash matches', () => {
    const matching = completeRecoveryInstruction(17, false, 'same-state');
    expect(matching).toContain('same control state hash same-state');
    expect(matching).toContain('reports a DIFFERENT control state hash');
    expect(matching).not.toContain('reports a DIFFERENT generation');
    expect(matching).toContain('legacy block without a hash');
  });

  it('renders exactly one orient fallback instruction when the marker is absent or incomplete', () => {
    for (const automatic of [undefined, automaticRecovery(false)]) {
      const text = renderCarryDoc(doc({ automaticRecovery: automatic }), NOW);
      expect(text.match(/Call `coord:orient \{ afterCompaction: true \}` exactly once/g)).toHaveLength(1);
      expect(text).not.toContain('Do NOT call coord:orient');
    }
  });

  it('renders every section in priority order with the banner + self-recall', () => {
    const text = renderCarryDoc(doc(), NOW);
    expect(text).toContain('# Carry document (deterministic');
    expect(text).toContain(REORIENT_BANNER);
    expect(text).toContain(renderBuiltAtStamp(NOW));
    expect(text.indexOf(REORIENT_BANNER)).toBeLessThan(text.indexOf(renderBuiltAtStamp(NOW)));
    expect(text.indexOf(renderBuiltAtStamp(NOW))).toBeLessThan(text.indexOf('## Identity'));
    expect(text).toContain('## Identity');
    expect(text).toContain('su-id: su-1 (su · su-1)');
    expect(text).toContain('fleet: f1 (leader)');
    expect(text).toContain('## Session mode');
    expect(text).toContain('AUTO: on (owner-directed)');
    expect(text).toContain('loop: ARMED (every 60s)');
    expect(text).toContain('## Standing carry');
    expect(text).toContain('P-009 [wip] deterministic-context-carry-2026-07-14 (claimed)');
    expect(text).toContain('## Open owner asks');
    expect(text).toContain('Which backend for the sweep?');
    expect(text).toContain('## Verbatim tail');
    expect(text).toContain('### OWNER @2026-07-14T10:00:00Z');
    expect(text).toContain('ship it');
    expect(text).toContain('## Self-recall');
    expect(text).toContain(SELF_RECALL_POINTER);
    // Order: identity precedes session mode precedes standing carry precedes tail.
    expect(text.indexOf('## Identity')).toBeLessThan(text.indexOf('## Session mode'));
    expect(text.indexOf('## Session mode')).toBeLessThan(text.indexOf('## Standing carry'));
    expect(text.indexOf('## Verbatim tail')).toBeLessThan(text.indexOf('## Self-recall'));
  });

  it('EI-18684357744098956: a held checkpoint written well before the latest tail turn renders SUPERSEDED', () => {
    // The verified incident's shape: a checkpoint written, then real session
    // activity continued past it (here, the tail's latest turn is 10 minutes
    // later) without the checkpoint being refreshed — the carry doc must not
    // hand that stale claim over with the same authority as a current one.
    const checkpointUpdatedAtMs = Date.parse('2026-07-14T09:50:00Z');
    const text = renderCarryDoc(
      doc({
        brief: brief({
          heldItems: [
            {
              id: 'WI-5943',
              title: 'hyperdht instrumentation',
              body: null,
              harness: 'papercusp',
              checkpoint: 'ZERO CODE HAS BEEN WRITTEN. No file is edited. Nothing is half-done.',
              checkpointUpdatedAtMs,
              holderProof: HOLDER_PROOF,
            },
          ],
        }),
        // tail's latest turn is 2026-07-14T10:00:05Z — 10m+ after the checkpoint.
      }),
      NOW,
    );
    expect(text).toContain('⚠ SUPERSEDED');
    expect(text).toContain('ZERO CODE HAS BEEN WRITTEN'); // never dropped, just flagged
  });

  it('a checkpoint written AT/after the latest tail turn renders as plain fact (not superseded)', () => {
    const checkpointUpdatedAtMs = Date.parse('2026-07-14T10:00:04Z'); // 1s before the last turn
    const text = renderCarryDoc(
      doc({
        brief: brief({
          heldItems: [
            { id: 'WI-1', title: null, body: null, harness: 'papercusp', checkpoint: 'landed and verified', checkpointUpdatedAtMs, holderProof: HOLDER_PROOF },
          ],
        }),
      }),
      NOW,
    );
    expect(text).not.toContain('SUPERSEDED');
    expect(text).toContain('checkpoint: landed and verified');
  });

  it('omits empty optional sections but always keeps banner/identity/mode/self-recall', () => {
    const text = renderCarryDoc(doc({ planItems: [], asks: [], tail: [] }), NOW);
    expect(text).not.toContain('## Plan state');
    expect(text).not.toContain('## Open owner asks');
    expect(text).not.toContain('## Verbatim tail');
    expect(text).toContain('## Identity');
    expect(text).toContain('## Session mode');
    expect(text).toContain('## Self-recall');
  });

  it('a not-armed loop renders the halt warning', () => {
    const text = renderCarryDoc(doc({ sessionMode: { modes: [], loopActive: false, loopIntervalSec: null } }), NOW);
    expect(text).toContain('loop: not armed');
    expect(text).toContain('- no active modes');
  });

  // WI-6949 — AUTO with no loop is an ALARM, not a neutral fact. The prior wording buried
  // the consequence behind an "unless an owner is present" get-out, which a successor
  // reading it WITH an owner present correctly resolved to "fine" — and then inherited the
  // halt when the owner left. These pin that the two cases read differently.
  describe('the AUTO × no-loop combination escalates', () => {
    const render = (
      modes: { mode: string; ownerDirected: boolean; reason: string }[],
      loopActive: boolean,
      awaits: CarryBrief['awaits'] = [],
    ) =>
      renderCarryDoc(
        doc({
          brief: brief({ awaits }),
          sessionMode: { modes, loopActive, loopIntervalSec: loopActive ? 60 : null },
        }),
        NOW,
      );

    it('shouts when an autonomy mode is on and no loop is armed', () => {
      const text = render([{ mode: 'auto', ownerDirected: true, reason: 'owner said keep going' }], false);
      expect(text).toContain('NOT ARMED, AND AN AUTONOMY MODE IS ON');
      expect(text).toContain('HALTS');
      expect(text).toContain('loop:arm');
    });

    it('escalates for cold-auto and drain too, not just auto', () => {
      for (const mode of ['cold-auto', 'drain']) {
        expect(render([{ mode, ownerDirected: true, reason: 'r' }], false)).toContain('NOT ARMED, AND AN AUTONOMY MODE IS ON');
      }
    });

    it('does NOT escalate for a non-autonomy mode alone (ideate)', () => {
      const text = render([{ mode: 'ideate', ownerDirected: true, reason: 'r' }], false);
      expect(text).not.toContain('AN AUTONOMY MODE IS ON');
      expect(text).toContain('loop: not armed');
    });

    it('does NOT escalate when the loop IS armed, however autonomous the mode', () => {
      const text = render([{ mode: 'auto', ownerDirected: true, reason: 'r' }], true);
      expect(text).not.toContain('NOT ARMED');
      expect(text).toContain('loop: ARMED');
    });

    it('does NOT claim there is NO wake source when a live await is carried', () => {
      const text = render(
        [{ mode: 'auto', ownerDirected: true, reason: 'owner said keep going' }],
        false,
        [{ eventKey: 'work-item:claimable', note: 'lane refilled' }],
      );
      expect(text).toContain('LIVE EVENT AWAITS PROVIDE A WAKE SOURCE RIGHT NOW');
      expect(text).toContain('Your armed awaits are still live and WILL wake you');
      expect(text).not.toContain('You have NO wake source');
    });

    it('even the no-modes line names the owner as a wake source that can disappear', () => {
      const text = render([], false);
      expect(text).toMatch(/only wake source is the owner speaking/i);
    });
  });

  it('the mechanical stamp OUTRANKS the speaker in tail headers (WI-3532 class)', () => {
    const text = renderCarryDoc(
      doc({
        tail: [
          { speaker: 'user', text: 'ship it', ts: null, provenance: { verdict: 'owner-typed', origin: null } },
          { speaker: 'user', text: 'use route B', ts: null, provenance: { verdict: 'owner-dialog', origin: null } },
          { speaker: 'user', text: 'loop wake', ts: null, provenance: { verdict: 'agent-injected', origin: 'wake-pump' } },
          { speaker: 'user', text: '/compact ran', ts: null, provenance: { verdict: 'synthetic', origin: null } },
          { speaker: 'user', text: 'no ledger era', ts: null },
        ],
      }),
      NOW,
    );
    expect(text).toContain('### OWNER (typed — mechanically classified)');
    expect(text).toContain('### OWNER (dialog answer — mechanically classified)');
    expect(text).toContain('### machine-injected (wake-pump) — NOT the owner');
    expect(text).toContain('### machine (harness-synthetic) — NOT the owner');
    expect(text).toContain('### user (unclassified)');
  });

  it('an OPEN owner message renders as the first prompt and is NOT quoted in the tail (P-010)', () => {
    const text = renderCarryDoc(
      doc({
        tail: [
          { speaker: 'assistant', text: 'earlier work', ts: null },
          { speaker: 'user', text: 'now fix the migration', ts: null, provenance: { verdict: 'owner-typed', origin: null } },
        ],
        continuation: { lastOwnerMessage: { text: 'now fix the migration', ts: null }, answered: false, deliberate: true, selfRequested: true },
      }),
      NOW,
    );
    expect(text).toContain('## Continuation (last-turn handling)');
    expect(text).toContain('Boundary: DELIBERATE');
    expect(text).toContain('OPEN (unanswered)');
    expect(text).toContain('ACTUAL FIRST');
    expect(text).toContain('Preview: «now fix the migration»');
    // "never quoted material": the open owner turn is delivered live, not quoted.
    expect(text).not.toContain('### OWNER (typed — mechanically classified)');
    expect(text).toContain('### you'); // the assistant history turn still shows
  });

  it('an ANSWERED owner message stays quoted in the tail and a FORCED boundary is flagged', () => {
    const text = renderCarryDoc(
      doc({
        tail: [
          { speaker: 'user', text: 'ship it', ts: null, provenance: { verdict: 'owner-typed', origin: null } },
          { speaker: 'assistant', text: 'shipped', ts: null },
        ],
        continuation: { lastOwnerMessage: { text: 'ship it', ts: null }, answered: true, deliberate: false, selfRequested: false },
      }),
      NOW,
    );
    expect(text).toContain('Boundary: FORCED');
    expect(text).toContain('ANSWERED before this boundary');
    expect(text).toContain('### OWNER (typed — mechanically classified)'); // still quoted as history
  });

  it('no owner turn in the tail renders the standing-work continuation line', () => {
    const text = renderCarryDoc(doc({ tail: [], continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true } }), NOW);
    expect(text).toContain('No owner turn in the recent tail');
  });

  it('a CLEAN watchdog-initiated boundary never claims the session flushed (2026-07-18 provenance mislabel)', () => {
    const text = renderCarryDoc(
      doc({ tail: [], continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: false } }),
      NOW,
    );
    expect(text).toContain('Boundary: CLEAN but WATCHDOG-INITIATED');
    expect(text).toContain('did NOT request this cut');
    expect(text).not.toContain('state was flushed');
    expect(text).not.toContain('Boundary: DELIBERATE');
  });
});

describe('P-005-request-settlement-regressions: deriveContinuation (pure, P-010)', () => {
  const ownerTurn = (text: string, requestId = 'request-1'): CarryDocTailTurn => ({ speaker: 'user', text, ts: null, requestId, provenance: { verdict: 'owner-typed', origin: null } });
  const ownerDialog = (text: string, requestId = 'dialog-1'): CarryDocTailTurn => ({ speaker: 'user', text, ts: null, requestId, provenance: { verdict: 'owner-dialog', origin: null } });
  const wake = (text: string): CarryDocTailTurn => ({ speaker: 'user', text, ts: null, provenance: { verdict: 'agent-injected', origin: 'wake-pump' } });
  const model = (
    text: string,
    requestId = 'request-1',
    responseDisposition: CarryDocTailTurn['responseDisposition'] = 'progress',
  ): CarryDocTailTurn => ({ speaker: 'assistant', text, ts: null, requestId, responseDisposition });
  const lifecycle = (
    requestId: string,
    requestDisposition: NonNullable<CarryDocTailTurn['requestDisposition']>,
  ): CarryDocTailTurn => ({
    speaker: 'user',
    text: 'typed request lifecycle record',
    ts: null,
    requestId,
    requestDisposition,
    provenance: { verdict: 'agent-injected', origin: 'wake-pump' },
  });

  it('identifies the final OWNER-typed turn — not a later agent-injected user turn (WI-3532 class)', () => {
    const cont = deriveContinuation([ownerTurn('do the thing'), model('on it'), wake('loop wake — continue')], true);
    expect(cont.lastOwnerMessage?.text).toBe('do the thing');
  });

  it('treats an AskUserQuestion dialog answer as owner speech across the boundary', () => {
    const cont = deriveContinuation([ownerTurn('earlier'), model('asked'), ownerDialog('use route B')], true);
    expect(cont.lastOwnerMessage?.text).toBe('use route B');
    expect(cont.answered).toBe(false);
  });

  it('requires a matching delivered response; acknowledgement, interruption and unrelated delivery stay open', () => {
    expect(deriveContinuation([ownerTurn('q'), model('ack')], true).answered).toBe(false);
    expect(deriveContinuation([ownerTurn('q'), model('partial', 'request-1', 'interrupted')], true).answered).toBe(false);
    expect(deriveContinuation([ownerTurn('q'), model('other answer', 'request-2', 'delivered')], true).answered).toBe(false);
    expect(deriveContinuation([ownerTurn('q'), model('answer', 'request-1', 'delivered')], true).answered).toBe(true);
    // A machine wake after the owner message does NOT answer it.
    expect(deriveContinuation([ownerTurn('q'), wake('w')], true).answered).toBe(false);
  });

  // EI-23580220186598636 — the turn writing the carry doc is still executing, so it
  // can never carry the `delivered` receipt; without the caller's attestation the
  // owner message it is answering is re-delivered to the successor as a duplicate.
  describe('in-flight final turn (finalTurnInFlight)', () => {
    it('credits the live answering turn that cannot yet be delivered', () => {
      const tail = [ownerTurn('q'), model('answering now', 'request-1', 'progress')];
      // Without the attestation this is indistinguishable from an acknowledgement.
      expect(deriveContinuation(tail, true).answered).toBe(false);
      expect(deriveContinuation(tail, true, true, { finalTurnInFlight: true }).answered).toBe(true);
    });

    it('does not settle an interrupted live turn — an explicit non-delivery', () => {
      const tail = [ownerTurn('q'), model('died', 'request-1', 'interrupted')];
      expect(deriveContinuation(tail, true, true, { finalTurnInFlight: true }).answered).toBe(false);
    });

    it('settles ONLY the request the live turn shares an id with, keeping others open', () => {
      const cont = deriveContinuation(
        [ownerTurn('first', 'request-1'), ownerTurn('second', 'request-2'), model('on the second', 'request-2', 'progress')],
        true,
        true,
        { finalTurnInFlight: true },
      );
      expect(cont.answered).toBe(true);
      expect(cont.pendingOwnerMessages?.map((r) => r.text)).toEqual(['first']);
    });

    it('credits only the FINAL turn — an earlier progress turn stays an acknowledgement', () => {
      const cont = deriveContinuation(
        [ownerTurn('q'), model('ack', 'request-1', 'progress'), wake('machine wake')],
        true,
        true,
        { finalTurnInFlight: true },
      );
      expect(cont.answered).toBe(false);
    });
  });

  it('preserves multiple simultaneous requests and settles only the matching one', () => {
    const cont = deriveContinuation([
      ownerTurn('first', 'request-1'),
      ownerTurn('second', 'request-2'),
      model('second answer', 'request-2', 'delivered'),
    ], true);
    expect(cont.answered).toBe(true); // the latest owner request is answered
    expect(cont.pendingOwnerMessages).toEqual([
      { requestId: 'request-1', text: 'first', ts: null },
    ]);
    expect(gateOpenOwnerQuestion(cont).crossesOpenOwnerMessage).toBe(true);
  });

  // EI-25227743201307257 — a dialog answer acted on before the agent raised the
  // next dialog never meets a delivered response of its own id.
  describe('dialog-answer chains (parentRequestId)', () => {
    const chained = (text: string, requestId: string, parentRequestId: string): CarryDocTailTurn => ({
      ...ownerDialog(text, requestId),
      parentRequestId,
    });
    const chainTail = (final: CarryDocTailTurn): CarryDocTailTurn[] => [
      ownerTurn('start the session', 'request-1'),
      model('asking', 'request-1'),
      chained('re-plugged', 'dialog-1', 'request-1'),
      model('acting on it, asking again', 'dialog-1'),
      chained('not at the machine', 'dialog-2', 'dialog-1'),
      final,
    ];

    it('a delivered answer to the last dialog settles every link of the chain', () => {
      const cont = deriveContinuation(chainTail(model('understood', 'dialog-2', 'delivered')), true);
      expect(cont.answered).toBe(true);
      expect(cont.pendingOwnerMessages).toBeUndefined();
      expect(gateOpenOwnerQuestion(cont).crossesOpenOwnerMessage).toBe(false);
    });

    it('the in-flight final turn settles the chain the same way', () => {
      const tail = chainTail(model('flushing, then compacting', 'dialog-2', 'progress'));
      const cont = deriveContinuation(tail, true, true, { finalTurnInFlight: true });
      expect(cont.answered).toBe(true);
      expect(cont.pendingOwnerMessages).toBeUndefined();
    });

    it('an undelivered final answer leaves every link open', () => {
      const cont = deriveContinuation(chainTail(model('noted', 'dialog-2', 'progress')), true);
      expect(cont.answered).toBe(false);
      expect(cont.pendingOwnerMessages?.map((r) => r.text)).toEqual(['start the session', 're-plugged', 'not at the machine']);
    });

    it('without the structural link nothing chains (unknown is never guessed from position)', () => {
      const tail = [
        ownerTurn('start the session', 'request-1'),
        model('asking', 'request-1'),
        ownerDialog('re-plugged', 'dialog-1'),
        model('asking again', 'dialog-1'),
        ownerDialog('not at the machine', 'dialog-2'),
        model('understood', 'dialog-2', 'delivered'),
      ];
      expect(deriveContinuation(tail, true).pendingOwnerMessages?.map((r) => r.text)).toEqual(['start the session', 're-plugged']);
    });

    it('an owner-TYPED message never chains, even when it carries a parent link', () => {
      const cont = deriveContinuation([
        ownerTurn('first request', 'request-1'),
        model('working', 'request-1'),
        { ...ownerTurn('separate request', 'request-2'), parentRequestId: 'request-1' },
        model('answered the separate one', 'request-2', 'delivered'),
      ], true);
      expect(cont.pendingOwnerMessages?.map((r) => r.text)).toEqual(['first request']);
    });

    it('supersession of the last dialog does not cascade to its ancestors', () => {
      const cont = deriveContinuation([
        ...chainTail(model('noted', 'dialog-2', 'progress')),
        lifecycle('dialog-2', 'superseded'),
      ], true);
      expect(cont.pendingOwnerMessages?.map((r) => r.text)).toEqual(['start the session', 're-plugged']);
    });
  });

  it('accepts typed cancellation and supersession but never scans prose for those words', () => {
    expect(deriveContinuation([
      ownerTurn('first', 'request-1'),
      lifecycle('request-1', 'cancelled'),
    ], true).pendingOwnerMessages).toBeUndefined();

    const superseded = deriveContinuation([
      ownerTurn('first', 'request-1'),
      {
        ...ownerTurn('replacement', 'request-2'),
        supersedesRequestIds: ['request-1'],
      },
    ], true);
    expect(superseded.pendingOwnerMessages).toEqual([
      { requestId: 'request-2', text: 'replacement', ts: null },
    ]);

    const proseOnly = deriveContinuation([
      ownerTurn('first', 'request-1'),
      model('I cancelled and superseded it', 'request-1', 'progress'),
    ], true);
    expect(proseOnly.answered).toBe(false);
  });

  it('no owner turn ⇒ null message, vacuously answered, boundary flag flows through', () => {
    const cont = deriveContinuation([model('a'), wake('w')], false);
    expect(cont).toEqual({ lastOwnerMessage: null, answered: true, deliberate: false, selfRequested: false });
  });

  it('keeps truncated or unreadable request history explicitly unknown instead of no-demand', () => {
    for (const requestHistoryStatus of ['truncated', 'unreadable'] as const) {
      const cont = deriveContinuation([{
        speaker: 'user',
        text: '',
        ts: null,
        requestHistoryStatus,
        provenance: { verdict: 'agent-injected', origin: 'wake-pump' },
      }], true);
      expect(cont).toMatchObject({
        lastOwnerMessage: null,
        answered: false,
        requestHistoryStatus,
      });
      expect(gateOpenOwnerQuestion(cont)).toMatchObject({
        crossesOpenOwnerMessage: true,
        basis: 'history-uncertain',
        historyStatus: requestHistoryStatus,
      });
    }
  });

  // ── WI-10002032: a bounded tail's `truncated` flag is not evidence ──────────
  //
  // readVerbatimTail sets it mechanically (`start > 0 || out.length > maxTurns`) from a
  // 256 KiB byte window over transcripts that measure ~2.8 MB here, so it is a CONSTANT
  // for every real session rather than a measurement. Fed to gateOpenOwnerQuestion's
  // history-uncertain branch that became a permanent, unfalsifiable alarm on
  // agent-launched sessions which never had an owner at all. The durable ledger can
  // answer what the byte window cannot.
  it('clears a truncated history ONLY when the ledger proves this owner never received owner speech', () => {
    const cont = deriveContinuation([{
      speaker: 'user',
      text: '',
      ts: null,
      requestHistoryStatus: 'truncated',
      provenance: { verdict: 'agent-injected', origin: 'wake-pump' },
    }], true, true, { ownerSpeechCensus: 'none' });
    expect(cont).toEqual({
      lastOwnerMessage: null,
      answered: true,
      deliberate: true,
      selfRequested: true,
    });
    expect(cont).not.toHaveProperty('requestHistoryStatus');
    expect(gateOpenOwnerQuestion(cont)).toEqual({ crossesOpenOwnerMessage: false });
  });

  // The safety direction, and the reason the census has THREE states rather than a
  // boolean: 'unknown' is what an unreachable or not-yet-ingested ledger returns. If it
  // collapsed into 'none', ingestion lag would silently suppress a REAL owner question
  // — the one failure this fix must not introduce. `undefined` covers every existing
  // caller that passes no census at all.
  it('keeps a truncated history uncertain for every census value other than none', () => {
    for (const ownerSpeechCensus of ['unknown', 'some', undefined] as const) {
      const cont = deriveContinuation([{
        speaker: 'user',
        text: '',
        ts: null,
        requestHistoryStatus: 'truncated',
        provenance: { verdict: 'agent-injected', origin: 'wake-pump' },
      }], true, true, { ownerSpeechCensus });
      expect(cont).toMatchObject({ answered: false, requestHistoryStatus: 'truncated' });
      expect(gateOpenOwnerQuestion(cont)).toMatchObject({
        crossesOpenOwnerMessage: true,
        basis: 'history-uncertain',
        historyStatus: 'truncated',
      });
    }
  });

  // A census of `none` must never override an owner question the tail can SEE. The
  // pending-request branch is checked first and is unaffected by the census.
  it('never lets the census clear a known-unanswered owner request', () => {
    const cont = deriveContinuation([ownerTurn('do the thing'), wake('loop wake — continue')], true, true, {
      ownerSpeechCensus: 'none',
    });
    expect(cont.answered).toBe(false);
    expect(gateOpenOwnerQuestion(cont)).toMatchObject({
      crossesOpenOwnerMessage: true,
      basis: 'known-unanswered',
    });
  });

  it('selfRequested defaults to the deliberate flag (historical meaning preserved) and can be overridden false', () => {
    expect(deriveContinuation([model('a')], true).selfRequested).toBe(true);
    expect(deriveContinuation([model('a')], true, false).selfRequested).toBe(false);
    // Invariant: a forced boundary can never read as self-requested.
    expect(deriveContinuation([model('a')], false, true).selfRequested).toBe(false);
  });

  it('picks the LAST owner turn when several are present', () => {
    const cont = deriveContinuation([
      ownerTurn('first', 'request-1'),
      model('a', 'request-1', 'delivered'),
      ownerTurn('second', 'request-2'),
    ], true);
    expect(cont.lastOwnerMessage?.text).toBe('second');
    expect(cont.answered).toBe(false);
  });
});

describe('gateOpenOwnerQuestion (pure, P-010)', () => {
  const open: CarryDocContinuation = { lastOwnerMessage: { text: 'answer me', ts: null }, answered: false, deliberate: true, selfRequested: true };

  it('trips only on a DELIBERATE boundary across an UNANSWERED owner message', () => {
    const gate = gateOpenOwnerQuestion(open);
    expect(gate.crossesOpenOwnerMessage).toBe(true);
    expect(gate.basis).toBe('known-unanswered');
    expect(gate.refusalText).toContain('UNANSWERED');
    expect(gate.refusalText).toContain('first prompt');
  });

  it('does NOT trip on a forced boundary, an answered message, or no owner message', () => {
    expect(gateOpenOwnerQuestion({ ...open, deliberate: false }).crossesOpenOwnerMessage).toBe(false);
    expect(gateOpenOwnerQuestion({ ...open, answered: true }).crossesOpenOwnerMessage).toBe(false);
    expect(gateOpenOwnerQuestion({ lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true }).crossesOpenOwnerMessage).toBe(false);
  });
});

describe('buildCarryDoc continuation leg (P-010)', () => {
  const base = {
    workspaceId: 'ws-1',
    harness: 'papercusp',
    ownerLabel: 'su · su-1',
    buildCarryBriefFn: async () => brief(),
    getModesFn: async () => [] as { mode: string; ownerDirected: boolean; reason: string | null }[],
    getPlanItemsFn: async () => [] as CarryDocPlanItem[],
    getAsksFn: async () => [] as CarryDocAsk[],
  };

  it('derives the continuation from the tail + boundaryDeliberate opt', async () => {
    const doc = await buildCarryDoc('su-1', {
      ...base,
      boundaryDeliberate: true,
      getTailFn: async () => [
        { speaker: 'assistant', text: 'prior', ts: null } as CarryDocTailTurn,
        { speaker: 'user', text: 'open question', ts: null, provenance: { verdict: 'owner-typed', origin: null } } as CarryDocTailTurn,
      ],
    });
    expect(doc.continuation).toEqual({
      lastOwnerMessage: { text: 'open question', ts: null },
      answered: false,
      pendingOwnerMessages: [{ requestId: null, text: 'open question', ts: null }],
      deliberate: true,
      selfRequested: true,
    });
    expect(gateOpenOwnerQuestion(doc.continuation).crossesOpenOwnerMessage).toBe(true);
  });

  it('defaults boundaryDeliberate to false (forced/unknown — the safe under-promise)', async () => {
    const doc = await buildCarryDoc('su-1', { ...base, getTailFn: async () => [] });
    expect(doc.continuation.deliberate).toBe(false);
  });
});

describe('constant budget B + slot audit (P-011)', () => {
  it('budget is a constant fraction of the window, invariant in N (floored at one tail)', () => {
    expect(CARRY_DOC_BUDGET_FRACTION).toBe(0.1);
    // 10% of the window × 4 chars/token.
    expect(carryDocBudgetChars(200_000)).toBe(80_000);
    // Floor = one coherent verbatim tail (CARRY_DOC_MAX_TAIL_TURNS × 4000).
    const floor = CARRY_DOC_MAX_TAIL_TURNS * 4000;
    expect(carryDocBudgetChars(80_000)).toBe(floor); // exactly at the floor
    expect(carryDocBudgetChars(10_000)).toBe(floor); // floor binds
    expect(carryDocBudgetChars(0)).toBe(floor);
    expect(carryDocBudgetChars(Number.NaN)).toBe(floor);
    // Invariant in N: the budget is a pure function of the window — no turn/hop input.
    expect(carryDocBudgetChars(200_000)).toBe(carryDocBudgetChars(200_000));
  });

  it('every carry slot maps to a bounded kind — none append-only-in-context', () => {
    const admissible = new Set<CarryDocSlotKind>(['snapshot', 'sliding-window', 'top-k', 'derived']);
    for (const s of CARRY_DOC_SLOTS) expect(admissible.has(s.kind)).toBe(true);
    const slots = new Set(CARRY_DOC_SLOTS.map((s) => s.slot));
    for (const req of ['identity', 'sessionMode', 'planItems', 'asks', 'tail', 'continuation', 'brief']) {
      expect(slots.has(req)).toBe(true);
    }
    // The shed ladder sheds the fully re-derivable code working set first, then the
    // re-injectable brief, and the blocking asks last.
    expect([...CARRY_DOC_SHED_LADDER]).toEqual(['codeWorkingSet', 'brief', 'tail', 'planState', 'asks']);
  });
});

describe('aging ladder / budget fit (P-011)', () => {
  const cont: CarryDocContinuation = { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true };
  function fitDoc(over: Partial<CarryDoc> = {}): CarryDoc {
    return {
      brief: brief(),
      identity: { ownerId: 'su-1', ownerLabel: 'su · su-1', harness: 'papercusp', workspaceId: 'ws-1', fleet: null, account: 'default' },
      sessionMode: { modes: [{ mode: 'auto', ownerDirected: true, reason: 'r' }], loopActive: true, loopIntervalSec: 60 },
      planItems: [{ itemId: 'P-1', planSlug: 'plan-x', status: 'wip', disposition: 'claimed' }],
      asks: [{ id: '1', question: 'which backend?', askedAtMs: NOW }],
      tail: [{ speaker: 'assistant', text: 'recent work', ts: null }],
      continuation: cont,
      ...over,
    };
  }

  it('no budget (or a budget above the full render) returns the full document unchanged', () => {
    const doc = fitDoc();
    const full = renderCarryDoc(doc, NOW);
    expect(renderCarryDoc(doc, NOW, {})).toBe(full);
    expect(renderCarryDoc(doc, NOW, { budgetChars: full.length })).toBe(full);
    expect(renderCarryDoc(doc, NOW, { budgetChars: full.length + 5000 })).toBe(full);
  });

  it('over budget: the standing brief sheds FIRST to a pointer; always-keep sections survive; result fits B', () => {
    // A huge verbatim carry-note makes the brief the largest sheddable slot.
    const bigNote = '## Next\n' + 'X'.repeat(50_000);
    const doc = fitDoc({ brief: brief({ loop: { harness: 'papercusp', active: true, intervalSec: 60, goal: null, carryNote: bigNote, carryNoteUpdatedAtMs: NOW } }) });
    const B = 40_000;
    const out = renderCarryDoc(doc, NOW, { budgetChars: B });
    expect(out.length).toBeLessThanOrEqual(B);
    // brief dropped to its pointer (still headed), everything else survived.
    expect(out).toContain('## Standing carry');
    expect(out).toContain('dropped to fit the carry budget');
    expect(out).not.toContain('X'.repeat(200));
    expect(out).toContain('## Identity');
    expect(out).toContain('## Session mode');
    expect(out).toContain('## Continuation (last-turn handling)');
    expect(out).toContain('## Self-recall');
    expect(out).toContain('recent work'); // the small tail survived
  });

  it('the tail AGES oldest-turn-first when the budget is too tight for all of it', () => {
    const turn = (n: number) => ({ speaker: 'assistant' as const, text: `T${n}:` + 'y'.repeat(3900), ts: null });
    const doc = fitDoc({ tail: [turn(1), turn(2), turn(3), turn(4)] });
    // Budget large enough for the always-keep + small slots + ~2 turns, not all 4.
    const out = renderCarryDoc(doc, NOW, { budgetChars: 12_000 });
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain('T4:'); // newest kept
    expect(out).not.toContain('T1:'); // oldest aged out
    expect(out).toContain('## Self-recall'); // always-keep survives
  });

  it('a tiny budget still emits the minimum viable orientation (never below the floor sections)', () => {
    const out = renderCarryDoc(fitDoc(), NOW, { budgetChars: 1 });
    expect(out).toContain('## Identity');
    expect(out).toContain('## Session mode');
    expect(out).toContain('## Self-recall');
    expect(out).toContain('## Continuation (last-turn handling)');
  });
});

/**
 * EI-21600998523239527 — the carry document must surface the agent's OWN
 * still-running `capability:bash` background jobs.
 *
 * The bug this guards: every other continuity surface the document reclaims is
 * inert while unattended; a background job is not. One measured orphan survived a
 * carry-respawn and burned 24,244 CPU-seconds / 18.5 GB peak RSS across 161
 * processes, competing for pc-heavy admission against a fleet-blocking red gate,
 * and nothing told the successor it existed.
 */
describe('background tasks slot (EI-21600998523239527)', () => {
  const task = (over: Partial<CarryDocBackgroundTask> = {}): CarryDocBackgroundTask => ({
    taskId: '0mtbao3bd1xotmym10a',
    command: 'npm run test:affected -- --changed-paths packages/operator-core/lib/carry-doc.ts',
    state: 'running',
    startedAtMs: NOW - 75 * 60_000,
    deadlineAtMs: NOW + 160 * 60_000,
    ...over,
  });

  function bgDoc(tasks: CarryDocBackgroundTask[] | undefined): CarryDoc {
    return {
      brief: brief(),
      identity: { ownerId: 'su-1', ownerLabel: 'su · su-1', harness: 'papercusp', workspaceId: 'ws-1', fleet: null, account: 'default' },
      sessionMode: { modes: [], loopActive: false, loopIntervalSec: null },
      planItems: [],
      asks: [],
      tail: [],
      continuation: { lastOwnerMessage: null, answered: true, deliberate: true, selfRequested: true },
      backgroundTasks: tasks,
    };
  }

  it('renders the owned job with its age, deadline and command', () => {
    const text = renderCarryDoc(bgDoc([task()]), NOW);
    expect(text).toContain('## Your still-running background tasks');
    expect(text).toContain('0mtbao3bd1xotmym10a');
    expect(text).toContain('75m old');
    expect(text).toContain('npm run test:affected');
    expect(text).toContain('running');
  });

  it('hands over the DURABLE task_id handle, never bash_id', () => {
    // A bash_id resolves only "in the original launching context" — exactly what a
    // carry-respawn destroyed. Rendering it would produce a handle that reads
    // plausible and then fails at the moment of use.
    const text = renderCarryDoc(bgDoc([task()]), NOW);
    expect(text).toContain("capability:bash_output { task_id: '0mtbao3bd1xotmym10a' }");
    expect(text).toContain("processes:kill { taskId: '0mtbao3bd1xotmym10a' }");
    expect(text).not.toContain('bash_id');
  });

  it('states the lifetime honestly instead of implying a durable handle', () => {
    // Otherwise the fix becomes a NEW false-confidence surface — the same class of
    // bug as the one it exists to fix.
    const text = renderCarryDoc(bgDoc([task()]), NOW);
    expect(text).toContain('NOT restart-durable');
    expect(text).toContain('re-verify');
    // And the state shown must be sourced from the ledger, not from output bytes:
    // a 0-byte .output after a respawn is not evidence the job died
    // (EI-20692923474318761).
    expect(text).toContain("State is the LEDGER's");
  });

  it('renders NOTHING — not an empty header — when the agent owns no background jobs', () => {
    // The section's mere presence is the signal; an always-present empty header
    // would train the successor to skip it.
    for (const empty of [[], undefined]) {
      const text = renderCarryDoc(bgDoc(empty), NOW);
      expect(text).not.toContain('## Your still-running background tasks');
    }
  });

  it('is ALWAYS-KEPT: it survives a budget that sheds every sheddable slot', () => {
    // This is the assertion that guards the actual bug. Budget pressure correlates
    // with a busy session, which is precisely when an orphan is most likely to
    // exist — a document that sheds this slot re-creates the reported failure.
    const text = renderCarryDoc(bgDoc([task()]), NOW, { budgetChars: 1 });
    expect(text).toContain('## Your still-running background tasks');
    expect(text).toContain('0mtbao3bd1xotmym10a');
    // Control: a genuinely sheddable slot IS dropped at the same budget, so this
    // test cannot pass merely because nothing was shed at all.
    expect(text).not.toContain('## Standing carry');
  });

  it('bounds the list and reports the overflow as a count', () => {
    const many = Array.from({ length: CARRY_DOC_MAX_BACKGROUND_TASKS + 3 }, (_, i) =>
      task({ taskId: `task-${i}` }),
    );
    const text = renderCarryDoc(bgDoc(many), NOW);
    expect(text).toContain(`task-${CARRY_DOC_MAX_BACKGROUND_TASKS - 1}`);
    expect(text).not.toContain(`task-${CARRY_DOC_MAX_BACKGROUND_TASKS}`);
    expect(text).toContain('and 3 more');
    expect(text).toContain("processes:list { launchedBy: 'self', state: 'running' }");
  });

  it('tolerates a missing start time and a job with no deadline', () => {
    const text = renderCarryDoc(bgDoc([task({ startedAtMs: null, deadlineAtMs: null })]), NOW);
    expect(text).toContain('age unknown');
    expect(text).toContain('no deadline');
  });

  it('buildCarryDoc reads the seam, and a throwing read yields no rows rather than a failed document', async () => {
    const opts = {
      workspaceId: 'ws-1',
      harness: 'papercusp',
      buildCarryBriefFn: async () => brief(),
      buildAutomaticRecoveryFn: async () => automaticRecovery(),
      getModesFn: async () => [],
      getPlanItemsFn: async () => [],
      getAsksFn: async () => [],
      getTailFn: async () => [],
    };

    const seen: Array<[string, string]> = [];
    const built = await buildCarryDoc('su-1', {
      ...opts,
      getBackgroundTasksFn: async (ownerId: string, workspaceId: string) => {
        seen.push([ownerId, workspaceId]);
        return [task()];
      },
    });
    expect(seen).toEqual([['su-1', 'ws-1']]);
    expect(built.backgroundTasks).toEqual([task()]);

    const degraded = await buildCarryDoc('su-1', {
      ...opts,
      getBackgroundTasksFn: async () => {
        throw new Error('ledger unreachable');
      },
    });
    expect(degraded.backgroundTasks).toEqual([]);
    expect(degraded.identity.ownerId).toBe('su-1');
  });

  it('registers the slot in the bounded-slot audit', () => {
    const slot = CARRY_DOC_SLOTS.find((s) => s.slot === 'backgroundTasks');
    expect(slot).toBeDefined();
    expect(slot!.kind).toBe('top-k');
    expect(slot!.boundedBy).toContain(String(CARRY_DOC_MAX_BACKGROUND_TASKS));
    // It is deliberately NOT on the shed ladder — see the always-kept test above.
    expect([...CARRY_DOC_SHED_LADDER]).not.toContain('backgroundTasks');
  });
});
