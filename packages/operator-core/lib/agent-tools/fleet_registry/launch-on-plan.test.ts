/**
 * launch-on-plan.test.ts — WI-1408 (fleet-registration-persists): the
 * `fleet:launch-on-plan` path builds every member's `psu` invocation via
 * `memberLaunchCommand`. The Queen's brief called this out as one of the TWO
 * launch paths that must thread `--fleet` all the way to registration (the
 * other being a direct `psu --fleet=<slug>` member launch, covered by
 * apps/operator/lib/psu-launcher.test.ts + bootstrap-su/-role's own WI-1408
 * suites). This pins the pure, PG-free half of that contract: the command
 * string a member actually execs always carries `--fleet=<slug>` — the flag
 * bootstrap-su/-role's `resolveFleet` + presence.ts's pending-fleet bridge
 * need to persist a non-null fleetSlug onto the member's presence row (and
 * therefore group it under the fleet in fleet:assignments, per
 * packages/operator-core/lib/fleet/assignments.ts's `groupByAgent`).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import launchOnPlan, {
  fleetAdmissionRefusalResult,
  DEAD_WAVE_OVERRIDE_MIN_AGE_MS,
  deadWaveSlotOverride,
  cloudModelBackendHint,
  memberLaunchCommand,
  isOmpLocalModel,
  resolveFleetAgent,
  buildFleetKindClaimSpec,
  buildFleetPlanClaimSpec,
  isLeaderAuthoredClaimSpec,
  isNonP2pDrainFleetSlug,
  mergeKindIntoClaimSpec,
  clampFleetTopUpToCapacity,
  FLEET_LAUNCH_CANARY_FRESHNESS_MS,
  hasFreshSameProfileCanary,
  composeMemberLaunchContext,
  renderMemberBaseline,
  distributeRemotePlacement,
  remotePlacementUnsupportedArgs,
  resolveRemotePlacementHive,
  isSelfPublishedSeatOffer,
  extractKickoffWorkItemIds,
  runLaunchWavesBeforeVerification,
  looksLikeInlineLaunchContextText,
  computeFleetTopUpWave,
  describeFleetFillOutcome,
  describeZeroOpenFleetHeadline,
  VISIBLE_FLEET_AGENT_REQUIRES_PROCESS_PER_WINDOW,
  persistedFleetLaunchProfileConflicts,
  fleetRouteSwitchConflict,
  requiresExplicitUnprofiledVisibility,
  resolveSuperviseGrant,
  applyGoalLaunchProfileToDefaults,
  type MemberLaunchOpts,
} from './launch-on-plan';
import { DEFAULT_CLAIM_SPEC, validateClaimSpec, positiveIdCohortIds, type ClaimSpec } from '../../scheduler/claim-spec';
import { matchesWorkItemClaimSpec } from '../../scheduler/claim-spec-match';
import type { WorkItem } from '../../work-items';
import { foldLaunchProfile, type GoalLaunchSettings } from '../../goal-launch-settings';
import {
  goalFleetLeaderProfile,
  resolveGoalFleetLeadership,
} from './goal-fleet-launch-options';
import { parseScratchReference } from '../../scratch-reference';
import { applyResultDoorAsync } from '../../result-door';
import { evaluateExactPlanAdmission, type ExactPlanAdmission } from '../plans/plan-admission-preflight';
import type { PlanItem } from '@papercusp/plan-parser';
import workItemsGet from '../work_items/get';
import workItemsClaim from '../work_items/claim';

describe('scoped lane admission', () => {
  const planItem: PlanItem = { id: 'P-001', text: 'unrelated peer lane', storedStatus: 'todo',
    importance: 'normal', blockedBy: [], decisionRefs: [], phase: null, lineNumber: 1, rawLine: '' };
  const duplicatedPlan = { planSlug: 'plan-a', planItems: [planItem], laneHealth: null,
    workItems: ['WI-1', 'WI-2'].map(id => ({ id, family: 'issue' as const,
      sourcePlanItemIds: ['P-001'], payload: null })) };

  it('accepts a lanes-only scope beside an unrelated duplicate-promoted item', () => {
    expect(evaluateExactPlanAdmission({ ...duplicatedPlan, planItemIds: [] })).toMatchObject({
      ready: true, reason: 'ready', promotion: { duplicateActionable: [] }, lane: null,
    });
  });

  it('returns admission_refused when the lane targets a duplicate-promoted item', async () => {
    const admission = evaluateExactPlanAdmission({ ...duplicatedPlan, planItemIds: ['P-001'] });
    const result = await fleetAdmissionRefusalResult({ fleet: 'fleet-a', plan: 'plan-a',
      harness: 'papercusp', workspaceId: 'ws-1', ownerId: 'owner-1', promotionFailsafe: null, admission });
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, error: 'admission_refused',
      reason: 'duplicate-coverage', blockingPlanItemIds: ['P-001'], blockingWorkItemIds: ['WI-1', 'WI-2'] });
  });
});

describe('compact exact-plan admission refusal', () => {
  const input = (admission: Partial<ExactPlanAdmission> | null) => ({
    fleet: 'repair-fleet', plan: 'repair-plan', harness: 'papercusp', workspaceId: 'ws-1', ownerId: 'owner-1',
    admission: admission as ExactPlanAdmission | null, promotionFailsafe: { ran: true, promoted: 1 },
  });

  it('keeps reason, blocking ids, named floor and runnable repair inside 6000 characters with lossless detail', async () => {
    const sandbox = mkdtempSync(join(tmpdir(), 'fleet-admission-receipt-'));
    const previousRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(sandbox, 'scratch');
    try {
      const admission = {
        ready: false, reason: 'floor-gated', message: 'P-001 / WI-17 is excluded by stopTheLine.',
        actionableRows: [{ planItemId: 'P-001', workItemId: 'WI-17' }],
        lane: { effective: { excluded: { claimFloors: 1, stopTheLine: 1 } } },
      } as unknown as ExactPlanAdmission;
      const promotionFailsafe = { ran: true, specQuality: 'full promotion detail '.repeat(4_000) };
      const result = await fleetAdmissionRefusalResult({ ...input(admission), promotionFailsafe });
      const text = result.content[0].text;
      const body = JSON.parse(text);
      expect(text.length).toBeLessThanOrEqual(6000);
      expect(result.isError).toBe(true);
      expect(body).toMatchObject({ error: 'admission_refused', reason: 'floor-gated',
        message: expect.stringContaining(admission.message),
        blockingPlanItemIds: ['P-001'], blockingWorkItemIds: ['WI-17'], namedFloors: { stopTheLine: 1 },
        repairCall: { tool: 'work_items:claim', args: { id: 'WI-17', assignee: 'self', harness: 'papercusp' } } });
      expect(body.namedFloors).not.toHaveProperty('claimFloors');
      expect(workItemsClaim.args.safeParse(body.repairCall.args).success).toBe(true);
      expect(body._projection.cursor.tool).toBe('capability:read');
      const cursor = body._projection.cursor;
      const reference = parseScratchReference(readFileSync(cursor.args.file_path))!;
      const original = JSON.parse(reference.payload.subarray(cursor.bodyOffsetInPayload).toString());
      expect(original.promotionFailsafe).toEqual(promotionFailsafe);
      expect(original.admission).toEqual(admission);
      promotionFailsafe.specQuality = 'changed after return';
      expect(original.promotionFailsafe.specQuality).toHaveLength(88_000);
      // The nested MCP door must retain the same head and frozen cursor.
      const nested = await applyResultDoorAsync(result, { toolName: 'tools:invoke',
        nestedTargetToolName: 'fleet:launch-on-plan', workspaceId: 'ws-1', ownerId: 'owner-1' });
      expect(JSON.parse(nested.content[0].text)).toMatchObject({ reason: 'floor-gated',
        blockingWorkItemIds: ['WI-17'], repairCall: body.repairCall });
    } finally {
      if (previousRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousRoot;
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('names duplicate rows and gives exact-row inspection before choosing a survivor', async () => {
    const result = await fleetAdmissionRefusalResult(input({ ready: false, reason: 'duplicate-coverage',
      message: 'Duplicate promotion of P-001.', promotion: { duplicateActionable: [
        { planItemId: 'P-001', workItemIds: ['WI-17', 'WI-18'] },
      ] } as ExactPlanAdmission['promotion'] }));
    const body = JSON.parse(result.content[0].text);
    expect(body).toMatchObject({ reason: 'duplicate-coverage', blockingPlanItemIds: ['P-001'],
      blockingWorkItemIds: ['WI-17', 'WI-18'], repairCall: { tool: 'work_items:get', effect: 'inspect',
        args: { ids: ['WI-17', 'WI-18'], harness: 'papercusp' } } });
    expect(workItemsGet.args.safeParse(body.repairCall.args).success).toBe(true);
  });

  it('preserves unknown measurements and never offers to claim a held row', async () => {
    const result = await fleetAdmissionRefusalResult(input({ ready: false, reason: 'floor-gated',
      message: 'Row held.', blockingRows: [{ planItemId: 'P-001', workItemId: 'WI-17',
        holder: 'peer', takenAt: null }], lane: { effective: { excluded: { taken: 1, claimFloors: 1 } } } as never }));
    const body = JSON.parse(result.content[0].text);
    expect(body.repairCall).toMatchObject({ tool: 'work_items:get', effect: 'inspect' });
    const unknown = JSON.parse((await fleetAdmissionRefusalResult({ ...input(null),
      admissionError: 'measurement unavailable' })).content[0].text);
    expect(unknown).toMatchObject({ reason: 'lane-unknown', namedFloors: null,
      message: expect.stringContaining('measurement unavailable'), repairCall: { tool: 'plans:get' } });
  });
});

const base: MemberLaunchOpts = {
  fleetSlug: 'atlas-fleet',
  agent: 'claude',
  harness: 'papercup',
  plan: 'p-plan',
};

describe('applyGoalLaunchProfileToDefaults (WI-2146552)', () => {
  const fallback = {
    agent: 'claude' as const,
    model: 'sonnet',
    effort: 'high',
    account: 'default',
    carry: 'warm' as const,
    headless: true,
  };

  it('delivers every command-shaping GOAL profile key, including model', () => {
    expect(
      applyGoalLaunchProfileToDefaults(fallback, {
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'max',
        account: 'auto',
        carry: 'cold',
        contextSize: 'steward',
        compactionLimit: 600_000,
        headless: false,
      }),
    ).toMatchObject({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'max',
      account: 'auto',
      carry: 'cold',
      contextSize: 'steward',
      compactionLimit: 600_000,
      headless: false,
    });
  });

  it('does not let an absent leader profile inherit a member-only model', () => {
    expect(applyGoalLaunchProfileToDefaults(fallback, {})).toEqual(fallback);
  });

  it('composes a delegated leader and members onto distinct model commands', () => {
    const settings = {
      defaults: { agent: 'claude', account: 'auto', carry: 'warm' },
      roles: {
        'plan-fleet-leader': { model: 'opus', effort: 'max' },
        'plan-fleet-member': { model: 'haiku', effort: 'low' },
      },
    } as GoalLaunchSettings;
    const leadership = resolveGoalFleetLeadership({
      goalHolderSubject: 'g-1',
      callerOwnerId: 'su-goal',
    });
    expect(leadership).toMatchObject({ ok: true, leader: 'spawn' });

    const leader = applyGoalLaunchProfileToDefaults(
      fallback,
      goalFleetLeaderProfile({ settings, family: 'plan' }),
    );
    const member = applyGoalLaunchProfileToDefaults(
      fallback,
      foldLaunchProfile(settings, 'plan-fleet-member'),
    );
    expect(memberLaunchCommand({ ...base, ...leader })).toContain('--model=opus:max');
    expect(memberLaunchCommand({ ...base, ...member })).toContain('--model=haiku:low');
  });
});

// R5 (interrupted-member-recovery-hardening-2026-09-01): how an explicit `supervise`
// arg reaches the fleet's durable headcount row. Pure so every branch is provable
// without opening a terminal; the handler only performs the returned `write` and
// echoes the rest as `superviseGrant` on the result.
describe('resolveSuperviseGrant (R5 — per-fleet supervise grant delivery)', () => {
  const config = { plan: 'p', harness: 'h', agent: 'claude' as const, headless: true, carry: 'warm' as const };
  const row = (over: Partial<{ enabled: boolean; target: number; config: typeof config & { supervise?: boolean; model?: string; role?: string } }> = {}) => ({
    enabled: true,
    target: 3,
    config,
    ...over,
  });

  it('is null when the arg is omitted — the stored grant is untouched', () => {
    expect(resolveSuperviseGrant({ supervise: undefined, profile: null, existing: row() })).toBeNull();
  });

  it('needs no write when the fresh-fleet recipe already carries the requested value', () => {
    const r = resolveSuperviseGrant({
      supervise: true,
      profile: { target: 2, config: { ...config, supervise: true } },
      existing: null,
    });
    expect(r).toMatchObject({ requested: true, persisted: true, write: null });
  });

  it('rewrites an ENABLED existing row in place, preserving its target and boot settings', () => {
    const r = resolveSuperviseGrant({ supervise: true, profile: null, existing: row({ config: { ...config, model: 'opus' } }) });
    expect(r).toMatchObject({
      requested: true,
      persisted: true,
      write: { target: 3, config: { ...config, model: 'opus', supervise: true } },
    });
  });

  it('revokes the same way — false is a write, never an omission', () => {
    const r = resolveSuperviseGrant({ supervise: false, profile: null, existing: row({ config: { ...config, supervise: true } }) });
    expect(r?.persisted).toBe(true);
    expect(r?.write?.config.supervise).toBe(false);
  });

  it('REPORTS an undeliverable grant on a disabled row instead of arming it or dropping it', () => {
    const r = resolveSuperviseGrant({ supervise: true, profile: null, existing: row({ enabled: false }) });
    expect(r).toMatchObject({ requested: true, persisted: false, write: null });
    expect(r?.reason).toMatch(/disabled/);
    expect(r?.reason).toMatch(/fleet:headcount-target/);
  });

  it('REPORTS an undeliverable grant when no homogeneous recipe exists (paired / per-member launch)', () => {
    const r = resolveSuperviseGrant({ supervise: true, profile: null, existing: null });
    expect(r).toMatchObject({ requested: true, persisted: false, write: null });
    expect(r?.reason).toMatch(/no homogeneous headcount recipe/);
  });

  it('strips the legacy membership label while rewriting (same normalizer as every other persist)', () => {
    const r = resolveSuperviseGrant({ supervise: true, profile: null, existing: row({ config: { ...config, role: 'member' } }) });
    expect(r?.write?.config).not.toHaveProperty('role');
    expect(r?.write?.config.supervise).toBe(true);
  });
});

describe('persisted fleet launch profile recovery guard (D-004)', () => {
  const saved = {
    plan: 'byoc-plan',
    harness: 'papercusp',
    agent: 'codex' as const,
    model: 'gpt-5.6-sol',
    effort: 'high',
    account: 'default',
    headless: false,
    carry: 'warm' as const,
    contextSize: 'trimmed' as const,
    compactionLimit: 400_000,
  };

  it('accepts omission, repeated values, and a host-placement delta', () => {
    expect(persistedFleetLaunchProfileConflicts({}, saved)).toEqual([]);
    expect(persistedFleetLaunchProfileConflicts({ headless: false }, saved)).toEqual([]);
    expect(persistedFleetLaunchProfileConflicts({ name: 'Profiled Fleet', count: 30, placement: 'local' } as never, saved)).toEqual([]);
    expect(persistedFleetLaunchProfileConflicts({ plan: 'byoc-plan', model: 'gpt-5.6-sol:high' }, saved)).toEqual([]);
  });

  it('rejects conflicting reconstruction', () => {
    expect(persistedFleetLaunchProfileConflicts({ account: 'auto' }, saved)).toEqual([
      { field: 'account', saved: 'default', requested: 'auto' },
    ]);
    expect(persistedFleetLaunchProfileConflicts({ headless: true }, saved)).toEqual([
      { field: 'headless', saved: false, requested: true },
    ]);
  });

  it('rejects per-member reconstruction against a homogeneous saved profile', () => {
    expect(persistedFleetLaunchProfileConflicts({ members: [{ model: 'gpt-5.6-sol:high' }] }, saved)).toEqual([
      { field: 'members', saved: 'fleet-wide persisted profile', requested: '1 member override(s)' },
    ]);
  });
});

describe('launch-spec route + visibility enforcement (EI-21304203620302419)', () => {
  it('refuses the recovered wrong-fleet shape unless the route switch is explicit', () => {
    expect(
      fleetRouteSwitchConflict({
        currentFleet: 'byoc-alpha-max-2026-08-23',
        currentRole: 'leader',
        targetFleet: 'loop-observability-2026-08-24',
      }),
    ).toEqual({
      currentFleet: 'byoc-alpha-max-2026-08-23',
      currentRole: 'leader',
      targetFleet: 'loop-observability-2026-08-24',
    });
  });

  it('allows same-fleet top-ups, explicit switches, and a separately spawned leader', () => {
    expect(
      fleetRouteSwitchConflict({ currentFleet: 'byoc', currentRole: 'leader', targetFleet: 'byoc' }),
    ).toBeNull();
    expect(
      fleetRouteSwitchConflict({
        currentFleet: 'byoc',
        currentRole: 'leader',
        targetFleet: 'other',
        confirmRouteSwitch: true,
      }),
    ).toBeNull();
    expect(
      fleetRouteSwitchConflict({ currentFleet: 'byoc', currentRole: 'leader', targetFleet: 'other', leader: 'spawn' }),
    ).toBeNull();
  });

  it('requires an explicit visibility choice for an unprofiled local launch', () => {
    expect(
      requiresExplicitUnprofiledVisibility({
        savedSpecFound: false,
        placement: 'local',
        count: 5,
      }),
    ).toBe(true);
    expect(
      requiresExplicitUnprofiledVisibility({ savedSpecFound: false, placement: 'local', headless: true, count: 5 }),
    ).toBe(false);
    expect(
      requiresExplicitUnprofiledVisibility({ savedSpecFound: false, placement: 'local', headless: false, count: 5 }),
    ).toBe(false);
  });

  it('preserves saved specs, remote host placement, and explicit mixed member placement', () => {
    expect(requiresExplicitUnprofiledVisibility({ savedSpecFound: true, count: 5 })).toBe(false);
    expect(requiresExplicitUnprofiledVisibility({ savedSpecFound: false, placement: 'remote', count: 5 })).toBe(false);
    expect(
      requiresExplicitUnprofiledVisibility({
        savedSpecFound: false,
        count: 2,
        members: [{ headless: true }, { headless: false }],
      }),
    ).toBe(false);
    expect(
      requiresExplicitUnprofiledVisibility({
        savedSpecFound: false,
        count: 2,
        members: [{ headless: true }],
      }),
    ).toBe(true);
  });
});

describe('memberLaunchCommand (WI-1408 — fleet:launch-on-plan threads --fleet into the member launch)', () => {
  it('keeps mode participation while withholding the launching leader mission and authority from members', () => {
    const launchMode = { mode: 'drain' as const, subject: 'leader-only',
      instructions: 'Lead this fleet as su-leader.', ownerDirected: true };
    const member = memberLaunchCommand({ ...base, launchMode });
    expect(member).toContain('--mode=drain');
    expect(member).not.toContain('--mode-subject');
    expect(member).not.toContain('--mode-instructions');
    expect(member).not.toContain('--mode-owner-directed');
    const leader = memberLaunchCommand({ ...base, fleetRole: 'leader', launchMode });
    expect(leader).toContain('--fleet-role=leader');
    expect(leader).toContain('--mode-subject=leader-only');
    expect(leader).toContain("--mode-instructions='Lead this fleet as su-leader.'");
    expect(leader).toContain('--mode-owner-directed');
  });

  it('always includes --fleet=<slug> — never a colour-only, unfleeted member launch', () => {
    const cmd = memberLaunchCommand(base);
    expect(cmd).toMatch(/(^|\s)--fleet=atlas-fleet(\s|$)/);
  });

  it('the flag carries the REAL fleet slug (not the display name) even with a fancy fleet name-derived slug', () => {
    const cmd = memberLaunchCommand({ ...base, fleetSlug: 'my-new-fleet' });
    expect(cmd).toContain('--fleet=my-new-fleet');
  });

  it('--fleet is present alongside the other required tokens (--no-picker, agent/harness/plan) — parity with a direct member launch', () => {
    const cmd = memberLaunchCommand(base);
    const tokens = cmd.split(' ');
    expect(tokens[0]).toBe('psu');
    expect(tokens).toContain('--no-picker');
    expect(tokens).toContain('--fleet=atlas-fleet');
    expect(tokens).toContain('--agent=claude');
    expect(tokens).toContain('--harness=papercup');
    expect(tokens).toContain('--plan=p-plan');
  });

  it('optional flags (role/account/model/...) never crowd out or duplicate --fleet', () => {
    const cmd = memberLaunchCommand({
      ...base,
      account: 'acct-1',
      role: 'worker',
      stack: ['domain:papercusp-engineer', 'practice:careful-review'],
      model: 'opus:high',
      feature: 'F-001',
      contextSize: 'trimmed',
      brain: true,
    });
    const fleetOccurrences = cmd.match(/--fleet=/g) ?? [];
    expect(fleetOccurrences).toHaveLength(1);
    expect(cmd).toContain('--fleet=atlas-fleet');
    expect(cmd).toContain('--stack=domain:papercusp-engineer');
    expect(cmd).toContain('--stack=practice:careful-review');
  });

  it('allowSubagents (owner mandate 2026-07-02): omitted by default (deny), --allow-subagents when opted in', () => {
    expect(memberLaunchCommand(base)).not.toContain('--allow-subagents');
    expect(memberLaunchCommand({ ...base, allowSubagents: true }).split(' ')).toContain('--allow-subagents');
    expect(memberLaunchCommand({ ...base, allowSubagents: false })).not.toContain('--allow-subagents');
  });

  // P-003 headless fleet: `--headless` forces the managed-pty host on despite non-TTY stdio so
  // the member (no window) stays injectable for warm wakes. Boolean flag like --brain.
  it('headless (P-003): omitted by default (visible), --headless when opted in — and never crowds out --fleet', () => {
    expect(memberLaunchCommand(base)).not.toContain('--headless');
    const cmd = memberLaunchCommand({ ...base, headless: true });
    const tokens = cmd.split(' ');
    expect(tokens).toContain('--headless');
    expect(tokens).toContain('--fleet=atlas-fleet');
    expect(tokens).toContain('--no-picker');
    expect(memberLaunchCommand({ ...base, headless: false })).not.toContain('--headless');
    // exactly one occurrence, coexists with other optional flags
    const both = memberLaunchCommand({ ...base, headless: true, account: 'acct-1', model: 'opus:high' });
    expect((both.match(/--headless/g) ?? [])).toHaveLength(1);
  });
});

// P-004 carry (owner directive 2026-07-10, INDEPENDENT of headless): the warm/cold auto-mode
// knob threads into the member operating baseline. renderMemberBaseline / composeMemberLaunchContext
// always make the selected carry explicit on loop:arm, because a headless caller's omitted
// carry default can otherwise silently override the fleet's warm default.
describe('member baseline carry directive (P-004 — warm/cold auto-mode)', () => {
  const opts = { fleetSlug: 'atlas-fleet', plan: 'p-plan', count: 3 };

  it('WARM (default): arms an explicit warm loop:arm and never mentions cold carry', () => {
    const warm = renderMemberBaseline(opts);
    expect(warm).toContain("`loop:arm { intervalSec, goal, carry: 'warm' }`");
    expect(warm).toContain('`loop:end { acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true }`');
    expect(warm).not.toContain('`loop:arm { intervalSec, goal }`');
    expect(warm).not.toContain("carry: 'cold'");
    expect(warm).not.toContain('COLD');
    // explicit warm is identical to the default
    expect(renderMemberBaseline({ ...opts, carry: 'warm' })).toBe(warm);
  });

  it('COLD: rewrites the loop:arm rule to arm a cold loop and marks the checkpoint load-bearing', () => {
    const cold = renderMemberBaseline({ ...opts, carry: 'cold' });
    expect(cold).toContain("`loop:arm { intervalSec, goal, carry: 'cold' }`");
    expect(cold).not.toContain('`loop:arm { intervalSec, goal }`'); // the warm form is gone
    expect(cold).toMatch(/COLD CARRY makes this LOAD-BEARING/);
    // the STAY ALIVE rule explains a cold wake starts fresh
    expect(cold).toMatch(/FRESH context/);
  });

  it('composeMemberLaunchContext threads carry through to the baseline (warm vs cold)', () => {
    const warm = composeMemberLaunchContext({ ...opts, carry: 'warm' });
    const cold = composeMemberLaunchContext({ ...opts, carry: 'cold' });
    expect(warm).toContain("carry: 'warm'");
    expect(warm).not.toContain("carry: 'cold'");
    expect(cold).toContain("carry: 'cold'");
    // carry does not disturb the leader's per-fleet brief, which still layers below
    const coldWithBrief = composeMemberLaunchContext({ ...opts, carry: 'cold', customBriefText: 'FLEET SPECIAL BRIEF' });
    expect(coldWithBrief).toContain('FLEET SPECIAL BRIEF');
    expect(coldWithBrief).toContain("carry: 'cold'");
  });
});

// P-003: `plan` is optional — a pure claim-spec fleet launches with no plan. The member
// baseline then points members at the fleet claim-lane instead of a named plan.
describe('member baseline without a plan (P-003 — pure claim-spec fleet)', () => {
  it('renderMemberBaseline points at the fleet claim-lane, not a named plan, when plan is omitted', () => {
    const withPlan = renderMemberBaseline({ fleetSlug: 'atlas-fleet', plan: 'p-plan', count: 3 });
    expect(withPlan).toContain('working plan `p-plan`');

    const noPlan = renderMemberBaseline({ fleetSlug: 'atlas-fleet', count: 3 });
    expect(noPlan).not.toContain('working plan');
    expect(noPlan).toContain('draining your fleet claim-lane backlog');
    // the rest of the baseline (fleet id, the pull loop) is unchanged
    expect(noPlan).toContain('fleet `atlas-fleet`');
    expect(noPlan).toContain('scheduler:get_next');
  });

  it('composeMemberLaunchContext composes cleanly with no plan (+ a leader brief still layers below)', () => {
    const composed = composeMemberLaunchContext({
      fleetSlug: 'atlas-fleet',
      count: 2,
      customBriefText: 'DRAIN THE BUGS',
    });
    expect(composed).toContain('draining your fleet claim-lane backlog');
    expect(composed).toContain('DRAIN THE BUGS');
  });
});

// EI-21252547896810039: the launch baseline is the first scheduler:get_next
// instruction a fleet member sees. Keep its states guidance aligned with the
// live pull-tool allowlist so members do not resurrect retired/floor states.
describe('member baseline scheduler states guidance', () => {
  it('documents only open|failing and tells members to omit states unless filtering', () => {
    const baseline = renderMemberBaseline({ fleetSlug: 'atlas-fleet', plan: 'p-plan', count: 3 });

    expect(baseline).toContain('`states` only when filtering and only `open|failing`');
    expect(baseline).toContain('never pass retired `todo` or floor/terminal states');
    expect(baseline).not.toContain("states: ['todo'");
  });
});

// P-003/P-004 arg-schema round-trip: both knobs parse, default undefined (→ visible + warm
// downstream), reject bad values, and are optional.
describe('headless + carry args (P-003/P-004)', () => {
  const parseArgs = (extra: Record<string, unknown>) =>
    (launchOnPlan.args as { parse: (x: unknown) => Record<string, unknown> }).parse({
      name: 'atlas',
      plan: 'p-plan',
      ...extra,
    });

  it('headless: accepts booleans, rejects non-boolean, optional (default undefined)', () => {
    expect(parseArgs({ headless: true }).headless).toBe(true);
    expect(parseArgs({ headless: false }).headless).toBe(false);
    expect(parseArgs({}).headless).toBeUndefined();
    expect(() => parseArgs({ headless: 'yes' })).toThrow();
  });

  it("carry: accepts 'warm'/'cold', rejects other strings, optional (default undefined)", () => {
    expect(parseArgs({ carry: 'warm' }).carry).toBe('warm');
    expect(parseArgs({ carry: 'cold' }).carry).toBe('cold');
    expect(parseArgs({}).carry).toBeUndefined();
    expect(() => parseArgs({ carry: 'lukewarm' })).toThrow();
  });

  it('headless and carry are INDEPENDENT — every combination parses', () => {
    for (const headless of [true, false]) {
      for (const carry of ['warm', 'cold']) {
        expect(() => parseArgs({ headless, carry }), `${headless}/${carry}`).not.toThrow();
      }
    }
  });
});

describe('visible fleet terminal reliability (EI-21010422711013687)', () => {
  it('forces a process-per-window emulator so the terminal cannot open while silently dropping the psu command', () => {
    expect(VISIBLE_FLEET_AGENT_REQUIRES_PROCESS_PER_WINDOW).toBe(true);
  });
});

describe('isOmpLocalModel (agent/model coupling — "thought ornith, got claude" guard, 2026-07-03)', () => {
  it('flags local/gateway models that ONLY the omp backend can run', () => {
    expect(isOmpLocalModel('ollama-cc/maxwell1500/ornith-35b:IQ3_M')).toBe(true); // the exact id the leader passed
    expect(isOmpLocalModel('ollama/llama3')).toBe(true);
    expect(isOmpLocalModel('ornith:35b')).toBe(true);
    expect(isOmpLocalModel('ornith:fast')).toBe(true);
    expect(isOmpLocalModel('  ollama-cc/x ')).toBe(true); // tolerant of surrounding space
  });

  it('does NOT flag claude/codex model ids (they stay on their default backend)', () => {
    expect(isOmpLocalModel('opus:high')).toBe(false);
    expect(isOmpLocalModel('opus[1m]')).toBe(false);
    expect(isOmpLocalModel('claude-sonnet-4-6')).toBe(false);
    expect(isOmpLocalModel('gpt-4o')).toBe(false);
    expect(isOmpLocalModel(undefined)).toBe(false);
    expect(isOmpLocalModel('')).toBe(false);
  });
});

describe('cloudModelBackendHint (native cloud model-family/backend guard)', () => {
  it('recognizes ChatGPT/Codex families, including the owner-reported Luna spec', () => {
    for (const model of ['gpt-5.6-luna:high', 'luna:high', 'gpt-5.6-sol', 'o3', 'gpt-5.3-codex-spark']) {
      expect(cloudModelBackendHint(model), model).toBe('codex');
    }
  });

  it('recognizes Claude families and leaves unknown/open-set ids unclassified', () => {
    for (const model of ['opus:high', 'sonnet[1m]', 'claude-fable-5:xhigh', 'anthropic.claude-3-5-sonnet-v2:0']) {
      expect(cloudModelBackendHint(model), model).toBe('claude');
    }
    expect(cloudModelBackendHint('future-provider/model-1')).toBeNull();
    expect(cloudModelBackendHint('ollama-cc/maxwell1500/ornith-35b:IQ3_M')).toBeNull();
  });
});

describe('resolveFleetAgent (backend + model inheritance — fleet-launch-agent-inheritance-2026-07-03)', () => {
  it('resolves the versioned human alias before inheriting a caller backend', () => {
    expect(resolveFleetAgent({ argModel: 'sol 6.1:xhigh', callerAgent: 'claude' })).toEqual({
      agent: 'codex', model: 'gpt-6.1-sol:xhigh', modelSource: 'explicit',
    });
    expect(resolveFleetAgent({ argModel: '6' })).toMatchObject({ error: expect.stringContaining('ambiguous') });
  });

  it('an explicit `agent` arg wins, but no-picker Codex still requires model authority', () => {
    // Owner directive 2026-09-15 (WI-10001535): a claude member with no explicit and no
    // inheritable model now takes the opus 5 xhigh configured default instead of leaving
    // `model` undefined for the CLI to fill. The `[1m]` marker is asserted because it is
    // what selects the 1M auto-compact window.
    expect(resolveFleetAgent({ argAgent: 'claude' })).toEqual({
      agent: 'claude',
      model: 'opus[1m]:xhigh',
      modelSource: 'configured-default',
    });
    expect(resolveFleetAgent({ argAgent: 'codex', callerAgent: 'omp', callerModel: 'ollama-cc/x' })).toMatchObject({
      error: expect.stringMatching(/Codex model is required/),
    });
  });

  it('rejects the retired Spark model before fleet materialization', () => {
    expect(resolveFleetAgent({ argAgent: 'codex', argModel: 'gpt-5.3-codex-spark:high' })).toMatchObject({
      error: expect.stringMatching(/denied/i),
    });
  });

  it('infers omp from a local/ollama model when no agent is given (and keeps that model)', () => {
    expect(resolveFleetAgent({ argModel: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' })).toEqual({
      agent: 'omp',
      model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M',
    });
  });

  it('infers codex from the exact Luna model when no agent is given (owner incident 2026-07-10)', () => {
    expect(resolveFleetAgent({ argModel: 'gpt-5.6-luna:high', callerAgent: 'claude' })).toEqual({
      agent: 'codex',
      model: 'gpt-5.6-luna:high',
      modelSource: 'explicit',
    });
  });

  it('fails closed when a Codex backend is inherited without a recorded caller model', () => {
    expect(resolveFleetAgent({ callerAgent: 'codex' })).toMatchObject({
      error: expect.stringMatching(/Codex model is required/),
    });
    expect(
      resolveFleetAgent({ callerAgent: 'codex', callerModel: 'gpt-5.5:xhigh' }),
    ).toEqual({
      agent: 'codex',
      model: 'gpt-5.5:xhigh',
      modelSource: 'inherited',
    });
  });

  it('inherits the CALLER backend when neither agent nor a local model is given (the claude-leak fix)', () => {
    expect(resolveFleetAgent({ callerAgent: 'omp' })).toEqual({ agent: 'omp', model: undefined });
  });

  it('inherits the caller MODEL too when the backend is inherited (ornith leader → ornith members)', () => {
    expect(
      resolveFleetAgent({ callerAgent: 'omp', callerModel: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' }),
    ).toEqual({ agent: 'omp', model: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' });
  });

  it('falls back to claude only when nothing is known (or the caller backend is unrecognized)', () => {
    // Owner directive 2026-09-15 (WI-10001535): the claude fallback now also carries the
    // opus 5 xhigh configured default instead of an undefined model. The BACKEND fallback
    // — which is what this case is about — is unchanged.
    expect(resolveFleetAgent({})).toEqual({
      agent: 'claude',
      model: 'opus[1m]:xhigh',
      modelSource: 'configured-default',
    });
    expect(resolveFleetAgent({ callerAgent: 'not-a-backend', callerModel: 'x' })).toEqual({
      agent: 'claude',
      model: 'opus[1m]:xhigh',
      modelSource: 'configured-default',
    });
  });

  it('does NOT bleed the caller model onto a member whose backend was pinned explicitly', () => {
    // explicit agent=omp, caller was claude+opus → member is omp with NO claude model
    expect(resolveFleetAgent({ argAgent: 'omp', callerAgent: 'claude', callerModel: 'opus:high' })).toEqual({
      agent: 'omp',
      model: undefined,
    });
  });

  it('an explicit `model` arg always wins over an inherited caller model', () => {
    expect(
      resolveFleetAgent({ callerAgent: 'omp', callerModel: 'ollama-cc/a', argModel: 'ollama-cc/b' }),
    ).toEqual({ agent: 'omp', model: 'ollama-cc/b' });
  });

  it('rejects an explicit claude/codex + local-model pairing (the thought-ornith-got-claude trap)', () => {
    const r = resolveFleetAgent({ argAgent: 'claude', argModel: 'ollama-cc/maxwell1500/ornith-35b:IQ3_M' });
    expect('error' in r).toBe(true);
    expect('error' in r && r.error).toMatch(/only the `omp` backend can run/);
  });

  it('rejects an explicit native cloud-backend mismatch before terminals open', () => {
    const claudeLuna = resolveFleetAgent({ argAgent: 'claude', argModel: 'gpt-5.6-luna:high' });
    expect('error' in claudeLuna && claudeLuna.error).toMatch(/belongs to the `codex` backend/);

    const codexOpus = resolveFleetAgent({ argAgent: 'codex', argModel: 'opus:high' });
    expect('error' in codexOpus && codexOpus.error).toMatch(/belongs to the `claude` backend/);
  });

  it('allows explicit omp for either cloud family because omp is multi-provider', () => {
    expect(resolveFleetAgent({ argAgent: 'omp', argModel: 'gpt-5.6-luna:high' })).toEqual({
      agent: 'omp',
      model: 'gpt-5.6-luna:high',
    });
  });
});

// The P-005 idempotency guard moved to PG (agent_fleets.last_launch_at, migration 484) so it
// holds across the multi-process :3070 worker pool — semantics are covered by
// agent-fleets-store.integration.test.ts (claimFleetLaunchSlot / releaseFleetLaunchSlot).

// WI-1993: the `model` arg rejects a malformed CLOUD spec at the TOOL BOUNDARY (before opening
// any desktop windows), not just per-member at psu boot. Exercises the real zod schema via
// `.args.parseAsync` — the fuzzyEnumAsync(local) leg fails open (empty local registry in the test
// env), so this isolates the chained validateCloudModelSpec superRefine.
//
// ASYNC ON PURPOSE — do not "simplify" this back to `.parse`. The `model` arg chains
// `fuzzyEnumAsync`, whose superRefine awaits the local-model-id cache, so the schema can ONLY be
// driven with `.parseAsync`. A synchronous `.parse` throws zod's "Encountered Promise during
// synchronous parse" *before* any of our own validation runs — so the block stops testing what it
// claims to test and instead fails on plumbing. That is exactly how candidate a30c867e reddened the
// gate (WI-40233): `launch-on-plan.ts` moved fuzzyEnum -> fuzzyEnumAsync and this helper was left
// behind. Awaiting here also mirrors the real boundary, which awaits it too:
// `agent-mcp/src/server.ts` -> `await runWithValidationWorkspace(..., () => standardValidate(tool.args, ...))`.
describe('model arg — cloud model-spec validation at the tool boundary (WI-1993)', () => {
  const parseModel = (model: string) =>
    (launchOnPlan.args as { parseAsync: (x: unknown) => Promise<unknown> }).parseAsync({
      name: 'atlas',
      plan: 'p-plan',
      model,
    });
  it('rejects a hand-typed [1m] marker on a non-family alias (the fabel5[1m] incident)', async () => {
    await expect(parseModel('fabel5[1m]')).rejects.toThrow(/fable/);
  });
  it('rejects a close-typo alias with a corrective suggestion', async () => {
    await expect(parseModel('opuss')).rejects.toThrow(/opus/);
    await expect(parseModel('sonet')).rejects.toThrow(/sonnet/);
  });
  it('accepts valid cloud specs, full ids, plausible-unknown short ids, and local ornith ids', async () => {
    for (const m of [
      'opus:high', 'fable:xhigh', 'sonnet', 'haiku', 'opus[1m]:max', 'claude-fable-5',
      'o3', 'gpt4', 'ollama-cc/maxwell1500/ornith-35b:IQ3_M',
    ]) {
      await expect(parseModel(m), m).resolves.toBeDefined();
    }
  });
});

// EI-7671: fleet:launch-on-plan previously never set an initial claim spec, so members
// booted and self-pulled via scheduler:get_next under the empty-filter DEFAULT_CLAIM_SPEC
// (admits every kind, including feature/chunk) before the leader got around to calling
// scheduler:set_claim_spec by hand — a drain fleet told "bugs only" could still grab
// feature-family work in that boot-race window. buildFleetKindClaimSpec is the pure spec
// builder the handler now calls BEFORE opening any member terminal.
describe('buildFleetKindClaimSpec (EI-7671 — fleet-level kind-filter claim spec)', () => {
  it('builds a valid-shaped spec restricting to the given kinds', () => {
    const spec = buildFleetKindClaimSpec('atlas-fleet', ['bug', 'change', 'task']);
    expect(spec).toMatchObject({
      specVersion: '1.0',
      revision: 1,
      view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] } },
    });
    expect(typeof spec.specId).toBe('string');
    expect((spec.specId as string).length).toBeGreaterThan(0);
  });

  it('names the fleet in specId so specs for different fleets never collide', () => {
    const a = buildFleetKindClaimSpec('atlas-fleet', ['bug']);
    const b = buildFleetKindClaimSpec('other-fleet', ['bug']);
    expect(a.specId).not.toBe(b.specId);
  });

  it('copies the kinds array (mutating the input after the call does not affect the spec)', () => {
    const kinds = ['bug', 'change'];
    const spec = buildFleetKindClaimSpec('atlas-fleet', kinds);
    kinds.push('feature');
    expect((spec.view as { filter: { value: string[] } }).filter.value).toEqual(['bug', 'change']);
  });

  it('inherits rank + limits unchanged (only view.filter narrows, per D-002)', () => {
    const spec = buildFleetKindClaimSpec('atlas-fleet', ['bug']);
    expect(spec.rank).toBeTruthy();
    expect(spec.limits).toBeTruthy();
  });
});

function issueItem(overrides: Partial<WorkItem> & Pick<WorkItem, 'id' | 'title'>): WorkItem {
  return {
    kind: 'bug',
    family: 'issue',
    harness: 'papercusp',
    summary: '',
    state: 'open',
    assignee: null,
    takenAt: null,
    lastProgressAt: null,
    assignedBy: null,
    severity: 'minor',
    parent: null,
    payload: {},
    rank: null,
    rankWriter: null,
    rankUpdatedAt: null,
    priority: null,
    origin: 'local',
    auditVerdict: null,
    verifiedAuthorGithubUserId: null,
    terminalOwner: null,
    terminalCompletionRef: null,
    terminalCompletionEvidence: null,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
    ...overrides,
  } as WorkItem;
}

// WI-6342: a "nonp2p" drain fleet's auto-generated kind-only claim spec had no
// awareness of the fleet's own P2P-exclusion mandate, so a p2p/dht/federation-
// tagged item (a papercup-isolated-dht liveness bug) was served straight to a
// single-box fleet member who cannot execute it — the same regression class as
// WI-5265/WI-5272/WI-5639/WI-6050 (a missing p2p-lane-fence), now via this NEW
// code path rather than a hand-typed scheduler:set_claim_spec.
describe('isNonP2pDrainFleetSlug + buildFleetKindClaimSpec p2p-lane-fence composition (WI-6342)', () => {
  it('recognizes the established "nonp2p-bug-drain-<date>" naming convention', () => {
    expect(isNonP2pDrainFleetSlug('nonp2p-bug-drain-0727')).toBe(true);
    expect(isNonP2pDrainFleetSlug('nonp2p-bug-drain-0725')).toBe(true);
    expect(isNonP2pDrainFleetSlug('NonP2P-Bug-Drain')).toBe(true); // case-insensitive
  });

  it('does not misfire on an unrelated fleet slug', () => {
    expect(isNonP2pDrainFleetSlug('atlas-fleet')).toBe(false);
    expect(isNonP2pDrainFleetSlug('backlog-drain')).toBe(false);
  });

  it('composes the p2p-lane fence into a "nonp2p"-named fleet\'s spec', () => {
    const spec = buildFleetKindClaimSpec('nonp2p-bug-drain-0727', ['bug', 'change', 'task']);
    expect((spec.view as { fence?: string }).fence).toBe('p2p-lane');
  });

  it('does NOT compose the fence for an ordinary (non-"nonp2p") drain fleet', () => {
    const spec = buildFleetKindClaimSpec('atlas-fleet', ['bug']);
    expect((spec.view as { fence?: string }).fence).toBeUndefined();
  });

  it('end-to-end: the validated "nonp2p" fleet spec excludes a real p2p/dht-tagged item (WI-6342 itself), admits an ordinary bug', () => {
    const rawSpec = buildFleetKindClaimSpec('nonp2p-bug-drain-0727', ['bug', 'change', 'task']);
    const validated = validateClaimSpec(rawSpec);
    expect(validated.ok, `spec invalid: ${validated.ok ? '' : validated.errors.join('; ')}`).toBe(true);
    const spec = validated.spec as ClaimSpec;

    const dhtBug = issueItem({
      id: 'WI-6342',
      title: 'papercup-isolated-dht liveness probe FAILED — bootstrap 172.31.44.1:49838 unreachable/wedged',
    });
    expect(matchesWorkItemClaimSpec(dhtBug, spec)).toBe(false); // excluded

    const ordinaryBug = issueItem({ id: 'WI-y', title: 'Fix dashboard pagination off-by-one' });
    expect(matchesWorkItemClaimSpec(ordinaryBug, spec)).toBe(true); // still admitted
  });

  it('the ordinary (non-fenced) fleet spec still admits the p2p/dht item (proves the fence, not something else, does the excluding)', () => {
    const rawSpec = buildFleetKindClaimSpec('atlas-fleet', ['bug', 'change', 'task']);
    const validated = validateClaimSpec(rawSpec);
    expect(validated.ok).toBe(true);
    const spec = validated.spec as ClaimSpec;
    const dhtBug = issueItem({
      id: 'WI-6342',
      title: 'papercup-isolated-dht liveness probe FAILED — bootstrap 172.31.44.1:49838 unreachable/wedged',
    });
    expect(matchesWorkItemClaimSpec(dhtBug, spec)).toBe(true); // admitted (no fence composed)
  });
});

// EI-10409: fleet:launch-on-plan used to ALWAYS overwrite the fleet claim spec on launch,
// silently clobbering a spec the leader had just hand-authored (e.g. a vetted id-pinned wave)
// and replacing it with a bare `plan=` filter that ordinary (non-promoted) backlog work-items
// don't carry — starving a claimKinds backlog-drain fleet. isLeaderAuthoredClaimSpec is the pure
// classifier that distinguishes a leader-set spec from one this tool generated itself (or the
// untouched default); mergeKindIntoClaimSpec is the pure merge the handler applies instead of
// overwriting when the leader spec must be narrowed by claimKinds.
describe('isLeaderAuthoredClaimSpec (EI-10409 — distinguish a leader-set spec from a generated one)', () => {
  it('is false for the DEFAULT_CLAIM_SPEC sentinel (nothing customized yet)', () => {
    expect(isLeaderAuthoredClaimSpec(DEFAULT_CLAIM_SPEC.specId, 'atlas-fleet')).toBe(false);
  });

  it('is false for a spec this tool generated itself (buildFleetKindClaimSpec)', () => {
    const spec = buildFleetKindClaimSpec('atlas-fleet', ['bug']);
    expect(isLeaderAuthoredClaimSpec(spec.specId as string, 'atlas-fleet')).toBe(false);
  });

  it('is false for a spec this tool generated itself (buildFleetPlanClaimSpec)', () => {
    const spec = buildFleetPlanClaimSpec('atlas-fleet', 'p-plan');
    expect(isLeaderAuthoredClaimSpec(spec.specId as string, 'atlas-fleet')).toBe(false);
  });

  it('is true for any other specId (a leader/human authored it via scheduler:set_claim_spec)', () => {
    expect(isLeaderAuthoredClaimSpec('bug-drain-relaunch-0712b', 'atlas-fleet')).toBe(true);
  });

  it('a self-generated specId for a DIFFERENT fleet still counts as leader-authored (no cross-fleet collision)', () => {
    const spec = buildFleetKindClaimSpec('other-fleet', ['bug']);
    expect(isLeaderAuthoredClaimSpec(spec.specId as string, 'atlas-fleet')).toBe(true);
  });
});

describe('mergeKindIntoClaimSpec (EI-10409 — merge, never discard, a leader-authored spec)', () => {
  it('ANDs the kind leaf onto an existing non-empty filter', () => {
    const existing: ClaimSpec = {
      specVersion: '1.0',
      specId: 'bug-drain-relaunch-0712b',
      revision: 27,
      view: { filter: { field: 'id', op: 'in', value: ['WI-1', 'WI-2'] } },
      rank: DEFAULT_CLAIM_SPEC.rank,
      limits: DEFAULT_CLAIM_SPEC.limits,
    };
    const merged = mergeKindIntoClaimSpec(existing, ['bug', 'change']);
    expect(merged).toMatchObject({
      specId: 'bug-drain-relaunch-0712b',
      revision: 28,
      view: {
        filter: {
          all: [
            { field: 'id', op: 'in', value: ['WI-1', 'WI-2'] },
            { field: 'kind', op: 'in', value: ['bug', 'change'] },
          ],
        },
      },
    });
  });

  it('the kind leaf becomes the whole filter when the existing filter is empty (view: {})', () => {
    const existing: ClaimSpec = { ...DEFAULT_CLAIM_SPEC, specId: 'leader-custom-empty-view', revision: 3 };
    const merged = mergeKindIntoClaimSpec(existing, ['bug']);
    expect(merged).toMatchObject({
      revision: 4,
      view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
    });
  });

  it('preserves specId, rank, and limits from the existing spec', () => {
    const existing: ClaimSpec = {
      specVersion: '1.0',
      specId: 'my-custom-wave',
      revision: 5,
      view: { filter: { field: 'priority', op: '>=', value: 50 } },
      rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
      limits: { maxConcurrentClaims: 3 },
    };
    const merged = mergeKindIntoClaimSpec(existing, ['task']);
    expect(merged.specId).toBe('my-custom-wave');
    expect(merged.rank).toEqual(existing.rank);
    expect(merged.limits).toEqual(existing.limits);
  });

  it('flattens an existing conjunction so a fixed issue-ID cohort remains scheduler-claimable (WI-4756)', () => {
    const existing: ClaimSpec = {
      specVersion: '1.0',
      specId: 'nonp2p-fixed-cohort',
      revision: 2,
      view: {
        filter: {
          all: [
            {
              all: [
                { field: 'kind', op: '=', value: 'bug' },
                { field: 'id', op: 'in', value: ['WI-4674', 'WI-4664'] },
              ],
            },
            { not: { field: 'title', op: 'glob', value: '*p2p*' } },
          ],
        },
      },
      rank: DEFAULT_CLAIM_SPEC.rank,
      limits: DEFAULT_CLAIM_SPEC.limits,
    };

    const merged = mergeKindIntoClaimSpec(existing, ['bug']) as ClaimSpec;

    expect(merged.view.filter).toEqual({
      all: [
        { field: 'kind', op: '=', value: 'bug' },
        { field: 'id', op: 'in', value: ['WI-4674', 'WI-4664'] },
        { not: { field: 'title', op: 'glob', value: '*p2p*' } },
        { field: 'kind', op: 'in', value: ['bug'] },
      ],
    });
    expect(positiveIdCohortIds(merged.view.filter)).toEqual(['WI-4674', 'WI-4664']);
  });
});

describe('claimKinds arg (EI-7671)', () => {
  const parse = (claimKinds: unknown) =>
    (launchOnPlan.args as { parse: (x: unknown) => unknown }).parse({ name: 'atlas', plan: 'p-plan', claimKinds });

  it('accepts a valid kind list', () => {
    expect(() => parse(['bug', 'change', 'task'])).not.toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => parse(['bogus'])).toThrow();
  });

  it('rejects an empty array (min 1)', () => {
    expect(() => parse([])).toThrow();
  });

  it('is optional — omitting it entirely still parses', () => {
    expect(() =>
      (launchOnPlan.args as { parse: (x: unknown) => unknown }).parse({ name: 'atlas', plan: 'p-plan' }),
    ).not.toThrow();
  });
});

// P-003: `plan` is optional at the schema boundary — a pure claim-spec fleet omits it
// (the handler then requires `claimKinds` as the lane). The schema must accept both shapes.
describe('plan arg is optional (P-003 — pure claim-spec fleet)', () => {
  const parse = (x: Record<string, unknown>) =>
    (launchOnPlan.args as { parse: (x: unknown) => unknown }).parse(x);

  it('accepts a plan-less launch (claim-spec fleet)', () => {
    expect(() => parse({ name: 'bug-drain', claimKinds: ['bug'] })).not.toThrow();
  });

  it('still accepts the plan-scoped launch', () => {
    expect(() => parse({ name: 'atlas', plan: 'p-plan' })).not.toThrow();
  });

  it('rejects an empty-string plan (min 1 still applies when present)', () => {
    expect(() => parse({ name: 'atlas', plan: '' })).toThrow();
  });
});

// EI-8807: fleet:launch-on-plan's owner-override for the capacity clamp. Two concurrent fixes each
// added `overrideCapacityClamp`, producing a duplicate object-literal key (TS1117 + a describe that
// referenced a nonexistent `capacityClampOverridden` result field). These lock in the arg's single
// canonical shape AND the override's behavior so neither the arg nor the escape hatch can silently
// regress. `clampFleetTopUpToCapacity` is the pure capacity-clamp authority the tool calls.
describe('overrideCapacityClamp arg + clamp override (EI-8807)', () => {
  const parseArgs = (extra: Record<string, unknown>) =>
    (launchOnPlan.args as { parse: (x: unknown) => Record<string, unknown> }).parse({
      name: 'atlas',
      plan: 'p-plan',
      ...extra,
    });

  it('accepts overrideCapacityClamp:true and surfaces it (single, non-dropped key)', () => {
    // A duplicate object-literal key would keep only the last describe; a dropped/renamed key would
    // strip the value on parse. Assert the boolean survives a round-trip through the args schema.
    expect(parseArgs({ overrideCapacityClamp: true }).overrideCapacityClamp).toBe(true);
    expect(parseArgs({ overrideCapacityClamp: false }).overrideCapacityClamp).toBe(false);
  });

  it('is optional — omitting it still parses (default off downstream)', () => {
    expect(() => parseArgs({})).not.toThrow();
    expect(parseArgs({}).overrideCapacityClamp).toBeUndefined();
  });

  it('rejects a non-boolean overrideCapacityClamp', () => {
    expect(() => parseArgs({ overrideCapacityClamp: 'yes' })).toThrow();
  });

  // The core EI-8807 incident: a gateway-routed launch with a pool reading healthyAccounts:0 was
  // clamped to ZERO despite a full dispatchBudget, and there was no way for an owner to override it.
  const walledPool = { reachable: true, healthyAccounts: 0, dispatchBudget: 13, recommendedHeadroom: 8 };

  it('WITHOUT override: a gateway-routed healthyAccounts:0 pool still suppresses the top-up to 0', () => {
    const clamp = clampFleetTopUpToCapacity(4, walledPool, { gatewayRouted: true });
    expect(clamp).not.toBeNull();
    expect(clamp!.openCount).toBe(0);
    expect(clamp!.clamped).toBe(true);
    expect(clamp!.overridden).toBe(false);
    // The recommendation is legible independent of application.
    expect(clamp!.recommendedOpenCount).toBe(0);
  });

  it('WITH override: launches ALL requested members even at healthyAccounts:0, and reports the override', () => {
    const clamp = clampFleetTopUpToCapacity(4, walledPool, { gatewayRouted: true, override: true });
    expect(clamp).not.toBeNull();
    expect(clamp!.openCount).toBe(4); // owner override defeats the zero-gate
    expect(clamp!.overridden).toBe(true);
    // The recommendation is still COMPUTED + reported — the override is never invisible.
    expect(clamp!.recommendedOpenCount).toBe(0);
    expect(clamp!.reason).toMatch(/OVERRIDDEN/);
  });

  it('a DIRECT-credential member is not gated by pool health at all (no override needed)', () => {
    // fleet-launch-zero-gate-routing-blind: a member on the direct system credential never asks the
    // gateway to authenticate, so an exhausted pool must not suppress it. dispatchBudget is the cap.
    const clamp = clampFleetTopUpToCapacity(4, walledPool, { gatewayRouted: false });
    expect(clamp!.openCount).toBe(4);
    expect(clamp!.clamped).toBe(false);
    expect(clamp!.overridden).toBe(false);
  });

  it('a fresh exact-profile canary bypasses only the stale healthyAccounts:0 gate', () => {
    const clamp = clampFleetTopUpToCapacity(4, walledPool, {
      gatewayRouted: true,
      freshSameProfileCanary: true,
    });
    expect(clamp).toMatchObject({
      openCount: 4,
      clamped: false,
      recommendedOpenCount: 4,
      healthyAccounts: 0,
    });
    expect(clamp!.reason).toMatch(/same-profile canary|healthyAccounts=0/);
  });

  it('keeps dispatchBudget binding when a fresh canary bypasses the zero-account gate', () => {
    const clamp = clampFleetTopUpToCapacity(
      20,
      { ...walledPool, dispatchBudget: 3 },
      { gatewayRouted: true, freshSameProfileCanary: true },
    );
    expect(clamp).toMatchObject({
      openCount: 3,
      clamped: true,
      recommendedOpenCount: 3,
    });
  });

  describe('hasFreshSameProfileCanary', () => {
    const now = 10_000;
    const profile = {
      agent: 'claude',
      model: 'sonnet',
      account: 'auto',
      carry: 'warm' as const,
      headless: false,
    };
    const transaction = (overrides: Record<string, unknown> = {}) =>
      ({
        version: 1,
        transactionId: 'tx-1',
        state: 'verified' as const,
        requestedAt: now - 1_000,
        updatedAt: now - 1_000,
        requestedMemberIds: ['su-canary'],
        openedMemberIds: ['su-canary'],
        verifiedMemberIds: ['su-canary'],
        failed: [],
        waves: [],
        recovery: { retryOwnerIds: [], nextAction: 'none' },
        requestedMembers: [{ index: 0, ownerId: 'su-canary', ...profile }],
        ...overrides,
      }) as never;

    it('accepts a fresh verified exact-profile canary', () => {
      expect(hasFreshSameProfileCanary({ transaction: transaction(), currentProfile: profile, nowMs: now })).toBe(true);
    });

    it('rejects an unknown or still-launching receipt', () => {
      expect(hasFreshSameProfileCanary({ transaction: null, currentProfile: profile, nowMs: now })).toBe(false);
      expect(
        hasFreshSameProfileCanary({
          transaction: transaction({ state: 'launching' }),
          currentProfile: profile,
          nowMs: now,
        }),
      ).toBe(false);
    });

    it('rejects an unverified, mismatched, or stale receipt', () => {
      expect(
        hasFreshSameProfileCanary({
          transaction: transaction({ verifiedMemberIds: [] }),
          currentProfile: profile,
          nowMs: now,
        }),
      ).toBe(false);
      expect(
        hasFreshSameProfileCanary({
          transaction: transaction(),
          currentProfile: { ...profile, model: 'opus' },
          nowMs: now,
        }),
      ).toBe(false);
      expect(
        hasFreshSameProfileCanary({
          transaction: transaction({ updatedAt: now - FLEET_LAUNCH_CANARY_FRESHNESS_MS - 1 }),
          currentProfile: profile,
          nowMs: now,
        }),
      ).toBe(false);
    });
  });
});

// WI-5211: placement:'remote' — one launch-on-plan call spreads members across the
// OTHER machines' federated seat-offers (one signed spawn-request per target).
describe("distributeRemotePlacement (WI-5211 — cross-machine max-spread round-robin)", () => {
  const offer = (publisher: number, offerId: string, host: string | null, seats: number, potSlug?: string | null) => ({
    publisher,
    offerId,
    host,
    seats,
    ...(potSlug !== undefined ? { potSlug } : {}),
  });

  it('count 2 across 2 machines lands exactly 1 member on EACH (the drill contract)', () => {
    const dist = distributeRemotePlacement(2, [
      offer(1, 'seat-aaaa', 'mac-vm', 1),
      offer(2, 'seat-bbbb', 'win-vm', 1),
    ]);
    expect(dist.ok).toBe(true);
    if (!dist.ok) return;
    expect(dist.allocations).toHaveLength(2);
    expect(dist.allocations.map((a) => a.count)).toEqual([1, 1]);
    expect(new Set(dist.allocations.map((a) => a.host))).toEqual(new Set(['mac-vm', 'win-vm']));
  });

  it('spreads 1-per-machine BEFORE any machine gets a second (count 3, seats 2+2)', () => {
    const dist = distributeRemotePlacement(3, [
      offer(1, 'seat-aaaa', 'alpha', 2),
      offer(2, 'seat-bbbb', 'beta', 2),
    ]);
    expect(dist.ok).toBe(true);
    if (!dist.ok) return;
    const byHost = new Map(dist.allocations.map((a) => [a.host, a.count]));
    // Round 1 gives each machine 1; round 2 gives the FIRST sorted machine (alpha) the 3rd.
    expect(byHost.get('alpha')).toBe(2);
    expect(byHost.get('beta')).toBe(1);
  });

  it('respects each offer\'s seat cap (count 3, seats 1+2 → 1 and 2)', () => {
    const dist = distributeRemotePlacement(3, [
      offer(1, 'seat-aaaa', 'alpha', 1),
      offer(2, 'seat-bbbb', 'beta', 2),
    ]);
    expect(dist.ok).toBe(true);
    if (!dist.ok) return;
    const byHost = new Map(dist.allocations.map((a) => [a.host, a.count]));
    expect(byHost.get('alpha')).toBe(1);
    expect(byHost.get('beta')).toBe(2);
  });

  it('is deterministic — sorted by host label then offer id', () => {
    const a = distributeRemotePlacement(2, [
      offer(2, 'seat-bbbb', 'zeta', 1),
      offer(1, 'seat-aaaa', 'alpha', 1),
    ]);
    const b = distributeRemotePlacement(2, [
      offer(1, 'seat-aaaa', 'alpha', 1),
      offer(2, 'seat-bbbb', 'zeta', 1),
    ]);
    expect(a).toEqual(b);
    // Assert the discriminant before narrowing: `toEqual` holds when BOTH results are
    // `{ ok: false }` (two identical refusals are trivially "deterministic"), so the
    // sort assertion below silently skipped and this test verified nothing about
    // ordering — the one thing its name claims. EI-19374102245723119.
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.allocations[0]!.host).toBe('alpha');
  });

  it('refuses (never clamps) when count exceeds the total remote capacity', () => {
    const dist = distributeRemotePlacement(4, [
      offer(1, 'seat-aaaa', 'alpha', 1),
      offer(2, 'seat-bbbb', 'beta', 1),
    ]);
    expect(dist.ok).toBe(false);
    if (dist.ok) return;
    expect(dist.error).toMatch(/1\.\.2/);
    expect(dist.error).toMatch(/alpha=1/);
  });

  it('refuses with the delegate-first hint when there are no usable remote offers', () => {
    for (const offers of [[], [offer(1, 'seat-aaaa', 'alpha', 0)]]) {
      const dist = distributeRemotePlacement(1, offers);
      expect(dist.ok).toBe(false);
      if (dist.ok) return;
      expect(dist.error).toMatch(/resource:delegate/);
    }
  });

  it('P-005: pools fleet-scoped and pot-scoped offers together, spreading across BOTH and carrying potSlug through each allocation', () => {
    // The caller (launch-on-plan.ts) merges this fleet's own fleet-scoped offers
    // with its pot's shared (potSlug-set) offers into ONE list before calling
    // here — this function stays scope-blind and just spreads over what it's given.
    const dist = distributeRemotePlacement(2, [
      offer(1, 'seat-aaaa', 'fleet-vm', 1), // fleet-scoped: no potSlug
      offer(2, 'seat-bbbb', 'pot-vm', 1, 'shared-pot'), // pot-scoped
    ]);
    expect(dist.ok).toBe(true);
    if (!dist.ok) return;
    expect(dist.allocations).toHaveLength(2);
    const byHost = new Map(dist.allocations.map((a) => [a.host, a]));
    expect(byHost.get('fleet-vm')?.potSlug).toBeUndefined();
    expect(byHost.get('pot-vm')?.potSlug).toBe('shared-pot');
  });

  it('the no-usable-offers refusal mentions BOTH the fleet and pot delegation paths (P-005)', () => {
    const dist = distributeRemotePlacement(1, []);
    expect(dist.ok).toBe(false);
    if (dist.ok) return;
    expect(dist.error).toMatch(/fleet or its pot/);
  });
});

// EI-19276371920501216: `launchContext` reads (per its own schema text) as if it
// could carry the brief TEXT directly, and a caller who does that used to die deep
// inside readFileSync with ENAMETOOLONG — silently dropping the brief for every
// member while the launch still reported ok:true. looksLikeInlineLaunchContextText
// is the cheap disambiguator: multi-line, or implausibly long for a filename, means
// "this is text, not a path".
describe('looksLikeInlineLaunchContextText (EI-19276371920501216)', () => {
  it('treats a short, plausible single-line path as a PATH (false)', () => {
    expect(looksLikeInlineLaunchContextText('/tmp/brief.md')).toBe(false);
    expect(looksLikeInlineLaunchContextText('.papercusp/launch-context/fleet-x-launch-context.md')).toBe(false);
  });

  it('treats ANY multi-line value as inline TEXT (true), regardless of length', () => {
    expect(looksLikeInlineLaunchContextText('MISSION: drain the queue\nDo not touch WI-1234.')).toBe(true);
    expect(looksLikeInlineLaunchContextText('short\nbrief')).toBe(true);
  });

  it('treats a single-line value implausibly long for a filename as inline TEXT (true)', () => {
    // Linux NAME_MAX is 255 bytes; the reported 800-character single-line brief
    // must never reach readFileSync as a path (EI-21278091632127108).
    expect(looksLikeInlineLaunchContextText('x'.repeat(800))).toBe(true);
    expect(looksLikeInlineLaunchContextText('x'.repeat(256))).toBe(true);
    // Exactly one valid ASCII filename component remains path-shaped.
    expect(looksLikeInlineLaunchContextText('x'.repeat(255))).toBe(false);
  });

  it('uses UTF-8 byte length for the filesystem component limit', () => {
    expect(looksLikeInlineLaunchContextText('é'.repeat(127))).toBe(false);
    expect(looksLikeInlineLaunchContextText('é'.repeat(128))).toBe(true);
  });
});

// P-014/D-005 — the local-seat leg: a self-delegated seat must be excluded from
// the remote-spawn pool (it's consumed LOCALLY via fromSeats instead), so local
// and remote donors compose into ONE fleet without a self-targeted request that
// would just sit forever.
describe('isSelfPublishedSeatOffer (P-014/D-005 — local-seat leg: exclude self-delegated offers from remote placement)', () => {
  const SELF_GH = 42;
  const SELF_PUBKEY = 'self-device-pubkey';

  it('excludes an offer published by the caller\'s own identity (self-donation)', () => {
    const offer = { publisherGithubUserId: SELF_GH, signerDevicePubkey: SELF_PUBKEY };
    expect(isSelfPublishedSeatOffer(offer, SELF_GH, SELF_PUBKEY)).toBe(true);
  });

  it('does NOT exclude a genuinely remote donor\'s offer (different github user + pubkey)', () => {
    const offer = { publisherGithubUserId: 7, signerDevicePubkey: 'other-device-pubkey' };
    expect(isSelfPublishedSeatOffer(offer, SELF_GH, SELF_PUBKEY)).toBe(false);
  });

  it('requires BOTH identity halves to match — same github id but a different signer device is NOT self (multi-device owner, or a spoof attempt)', () => {
    const offer = { publisherGithubUserId: SELF_GH, signerDevicePubkey: 'a-different-device' };
    expect(isSelfPublishedSeatOffer(offer, SELF_GH, SELF_PUBKEY)).toBe(false);
  });

  it('fails OPEN (never excludes) when the caller\'s own identity could not be resolved', () => {
    const offer = { publisherGithubUserId: SELF_GH, signerDevicePubkey: SELF_PUBKEY };
    expect(isSelfPublishedSeatOffer(offer, null, SELF_PUBKEY)).toBe(false);
    expect(isSelfPublishedSeatOffer(offer, SELF_GH, null)).toBe(false);
    expect(isSelfPublishedSeatOffer(offer, null, null)).toBe(false);
  });

  it('fails OPEN when the offer itself carries no signer identity (malformed/legacy row)', () => {
    const offer = { publisherGithubUserId: null, signerDevicePubkey: null };
    expect(isSelfPublishedSeatOffer(offer, SELF_GH, SELF_PUBKEY)).toBe(false);
  });

  it('composes with distributeRemotePlacement: filtering out a self offer before spreading leaves only genuine remote donors', () => {
    const rawOffers = [
      { publisher: SELF_GH, offerId: 'seat-self', host: 'my-own-box', seats: 3, publisherGithubUserId: SELF_GH, signerDevicePubkey: SELF_PUBKEY },
      { publisher: 7, offerId: 'seat-remote', host: 'peer-box', seats: 2, publisherGithubUserId: 7, signerDevicePubkey: 'other-device-pubkey' },
    ];
    const remoteOnly = rawOffers.filter((o) => !isSelfPublishedSeatOffer(o, SELF_GH, SELF_PUBKEY));
    expect(remoteOnly).toHaveLength(1);
    expect(remoteOnly[0]!.host).toBe('peer-box');

    const dist = distributeRemotePlacement(2, remoteOnly);
    expect(dist.ok).toBe(true);
    if (!dist.ok) return;
    // The self-donated 3-seat offer never enters the remote pool — only the
    // genuine 2-seat remote donor does, so count 2 is satisfied entirely from it.
    expect(dist.allocations).toEqual([expect.objectContaining({ host: 'peer-box', count: 2 })]);
  });
});

describe("placement arg + remotePlacementUnsupportedArgs (WI-5211)", () => {
  const parseArgs = (extra: Record<string, unknown>) =>
    (launchOnPlan.args as { parse: (x: unknown) => Record<string, unknown> }).parse({
      name: 'atlas',
      plan: 'p-plan',
      ...extra,
    });

  it("accepts placement 'local'/'remote', rejects anything else, defaults undefined", () => {
    expect(parseArgs({ placement: 'remote' }).placement).toBe('remote');
    expect(parseArgs({ placement: 'local' }).placement).toBe('local');
    expect(parseArgs({}).placement).toBeUndefined();
    expect(() => parseArgs({ placement: 'auto' })).toThrow();
  });

  it('flags every local-shape arg a remote placement cannot honor', () => {
    expect(
      remotePlacementUnsupportedArgs({
        name: 'atlas',
        plan: 'p-plan',
        placement: 'remote',
        count: 2,
        launchContext: '/tmp/brief.md',
        claimKinds: ['bug'],
        workspace: 'ws-1',
        harness: 'h',
      }),
    ).toEqual([]);
    expect(remotePlacementUnsupportedArgs({ model: 'opus:high', headless: true, seat: 'a:b:c' })).toEqual([
      'model',
      'seat',
      'headless',
    ]);
    // Explicitly-passed false still counts as passed — the honoring host owns the shape.
    expect(remotePlacementUnsupportedArgs({ fromSeats: false })).toEqual(['fromSeats']);
  });
});

// WI-5211 follow-up: a MULTI-hive workspace must not refuse placement:'remote'
// outright — `hive` (or the plan's `harness`) disambiguates, mirroring
// resource:delegate's offer-publishing side.
describe('resolveRemotePlacementHive (WI-5211 — multi-hive disambiguation)', () => {
  const many = { kind: 'many' as const, candidates: ['hello-world-3-pot', 'papercusp', 'test-hive-2'] };

  it('exactly-one workspace resolves alone, with or without a matching explicit hive', () => {
    const one = { kind: 'one' as const, homeSlug: 'papercusp' };
    expect(resolveRemotePlacementHive(one, undefined, null)).toEqual({ ok: true, homeSlug: 'papercusp' });
    expect(resolveRemotePlacementHive(one, 'papercusp', null)).toEqual({ ok: true, homeSlug: 'papercusp' });
  });

  it('multi-hive: explicit hive wins when it names a shared hive', () => {
    expect(resolveRemotePlacementHive(many, 'papercusp', null)).toEqual({ ok: true, homeSlug: 'papercusp' });
  });

  it('multi-hive: falls back to the harness when it names a shared hive', () => {
    expect(resolveRemotePlacementHive(many, undefined, 'papercusp')).toEqual({ ok: true, homeSlug: 'papercusp' });
  });

  it('refuses with the candidate list when nothing disambiguates', () => {
    const res = resolveRemotePlacementHive(many, undefined, 'not-a-hive');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('papercusp');
  });

  it('refuses an explicit hive outside the shared set (never guesses), and a no-shared-hive workspace', () => {
    const bad = resolveRemotePlacementHive(many, 'private-hive', 'papercusp');
    expect(bad.ok).toBe(false);
    const none = resolveRemotePlacementHive({ kind: 'none' }, 'papercusp', 'papercusp');
    expect(none.ok).toBe(false);
  });
});

/**
 * EI-18862608742257943: extractKickoffWorkItemIds — the pure id-extraction half of
 * the kickoff-vs-claim-spec launch check. A member kicked off with a brief naming
 * "WI-6502 ... it is your only job" whose fleet claim spec doesn't admit WI-6502
 * could not claim it at all: assignee stayed NULL, fleet:assignments showed it
 * holding nothing, and the death-resilience reclaim net never engaged. This reuses
 * the SAME id regex the work_items:create mirror-guard already uses (WI-<n> /
 * EI-<n>, case-insensitive, deduped) rather than inventing a second one.
 */
describe('extractKickoffWorkItemIds (EI-18862608742257943 — kickoff-vs-claim-spec launch check)', () => {
  it('extracts a WI- id from the exact kickoff phrasing that produced the bug', () => {
    expect(extractKickoffWorkItemIds(['You are taking over WI-6502 ... it is your only job.'])).toEqual(['WI-6502']);
  });

  it('extracts an EI- id too, case-insensitively, deduped across texts', () => {
    expect(
      extractKickoffWorkItemIds(['fix ei-18860001 please', 'EI-18860001 is the one, also see WI-100 and wi-100']),
    ).toEqual(expect.arrayContaining(['EI-18860001', 'WI-100']));
    expect(extractKickoffWorkItemIds(['ei-1 EI-1 Ei-1'])).toEqual(['EI-1']);
  });

  it('collects ids across MULTIPLE brief texts (shared + per-member)', () => {
    const ids = extractKickoffWorkItemIds(['shared brief mentions WI-1', null, 'member brief mentions WI-2', undefined, '']);
    expect(ids.sort()).toEqual(['WI-1', 'WI-2']);
  });

  it('returns empty for briefs with no work-item id, and tolerates all-blank input', () => {
    expect(extractKickoffWorkItemIds(['just build the feature, no ticket'])).toEqual([]);
    expect(extractKickoffWorkItemIds([null, undefined, '', '   '])).toEqual([]);
    expect(extractKickoffWorkItemIds([])).toEqual([]);
  });

  it('does NOT match a bare F- feature id (mirror-guard\'s own documented non-target)', () => {
    expect(extractKickoffWorkItemIds(['work F-AUTO-42 next'])).toEqual([]);
  });
});

describe('describeFleetFillOutcome (P-006 — `count` is a TARGET fleet size, and a short fleet must never render as a full one)', () => {
  /**
   * THE REAL INCIDENT (plan knowledge-at-symptom-time-2026-08-09, P-006): an owner asked for
   * 10 members; capacity clamped the deficit 10→4; 4 terminals opened; the agent reported that
   * 10 were coming. The pre-fix headline was `${opened.length}/${openCount}` — a ratio whose
   * DENOMINATOR is the post-clamp attempt — so it rendered "4/4 members opened".
   */
  const INCIDENT = { requested: 10, liveMembers: 0, attempted: 4, opened: 4 } as const;

  it('PERMANENT FALSIFIABILITY CONTROL: the PRE-FIX render reads as complete success on the real incident input', () => {
    // The exact pre-fix expression, kept here forever so this suite cannot go vacuously green.
    const preFix = `${INCIDENT.opened}/${INCIDENT.attempted} members opened`;
    expect(preFix).toBe('4/4 members opened');
    // A caller cannot tell that from a genuinely complete 4-member fleet:
    expect(/^(\d+)\/\1 members opened$/.test(preFix)).toBe(true);
    // ...while the truth is that 6 of the 10 requested members never launched.
    expect(describeFleetFillOutcome(INCIDENT).shortfall).toBe(6);
  });

  it('the FIXED render names the shortfall against the target and is not readable as complete', () => {
    const r = describeFleetFillOutcome(INCIDENT);
    expect(r.complete).toBe(false);
    expect(r.fleetSize).toBe(4);
    expect(r.shortfall).toBe(6);
    expect(r.clause).toContain('4 of the 10 requested');
    expect(r.clause).toContain('SHORT BY 6');
    // the clamped case must say every attempted terminal DID open, so nobody hunts a launch failure
    expect(r.clause).toContain('capacity-clamped');
    expect(r.clause).not.toMatch(/\b4\/4\b/);
  });

  it('a genuine deficit top-up that REACHES the target reads as complete (fleet 2 of 2, not "1 opened")', () => {
    const r = describeFleetFillOutcome({ requested: 2, liveMembers: 1, attempted: 1, opened: 1 });
    expect(r.complete).toBe(true);
    expect(r.fleetSize).toBe(2);
    expect(r.shortfall).toBe(0);
    expect(r.clause).toContain('1 member opened');
    expect(r.clause).toContain('fleet is now 2 of the 2 requested');
    expect(r.clause).not.toContain('SHORT BY');
  });

  it('distinguishes a capacity clamp from terminals that FAILED to open', () => {
    const failed = describeFleetFillOutcome({ requested: 3, liveMembers: 0, attempted: 3, opened: 2 });
    expect(failed.shortfall).toBe(1);
    expect(failed.clause).toContain("1 of this wave's 3 terminals failed to open");
    expect(failed.clause).not.toContain('capacity-clamped');
  });

  it('a full wave with no live members reads as complete', () => {
    const r = describeFleetFillOutcome({ requested: 5, liveMembers: 0, attempted: 5, opened: 5 });
    expect(r.complete).toBe(true);
    expect(r.clause).toBe('5 members opened — fleet is now 5 of the 5 requested');
  });

  it('pluralizes on the OPENED count and honors the headless noun', () => {
    expect(describeFleetFillOutcome({ requested: 1, liveMembers: 0, attempted: 1, opened: 1 }).clause).toContain(
      '1 member opened',
    );
    expect(
      describeFleetFillOutcome({ requested: 2, liveMembers: 0, attempted: 2, opened: 2, noun: 'HEADLESS member' })
        .clause,
    ).toContain('2 HEADLESS members opened');
  });

  it('never reports a negative shortfall when MORE members are live than requested', () => {
    const r = describeFleetFillOutcome({ requested: 2, liveMembers: 3, attempted: 0, opened: 0 });
    expect(r.shortfall).toBe(0);
    expect(r.complete).toBe(true);
  });

  it('names the per-wave limit when a successful bounded wave leaves a larger target short', () => {
    const r = describeFleetFillOutcome({
      requested: 50,
      liveMembers: 27,
      attempted: 12,
      opened: 12,
      limitedBy: 'wave',
    });
    expect(r.complete).toBe(false);
    expect(r.shortfall).toBe(11);
    expect(r.clause).toMatch(/per-wave launch limit/);
    expect(r.clause).not.toMatch(/capacity-clamped/);
  });

  it('tolerates non-finite/negative inputs rather than emitting NaN into the launch message', () => {
    const r = describeFleetFillOutcome({
      requested: Number.NaN,
      liveMembers: -3,
      attempted: Number.POSITIVE_INFINITY,
      opened: -1,
    });
    expect(r.clause).not.toContain('NaN');
    expect(r.fleetSize).toBe(0);
    expect(r.shortfall).toBe(0);
  });
});

describe('describeZeroOpenFleetHeadline (EI-22168623726023643 — a ZERO-member wave must not render as a benign no-op)', () => {
  /**
   * THE REAL INCIDENT: two fleet:launch-on-plan calls returned ok:true with a spawned,
   * registered leader while the capacity clamp suppressed every member —
   * requested:2, liveMembers:0, fleetSize:0, shortfall:2, capacityClamp.openCount:0.
   * P-006 already made `describeFleetFillOutcome` compute the ⚠ shortfall clause AND the
   * cause... and the zero-open branch of the headline then THREW BOTH AWAY, emitting a flat
   * "No member terminals were started for fleet `X`." That is the one branch where the
   * diagnosis matters most: the caller is left holding a live leader and an EMPTY fleet.
   */
  const SUPPRESSED = { requested: 2, liveMembers: 0, attempted: 0, opened: 0, limitedBy: 'capacity' as const };

  it('PERMANENT FALSIFIABILITY CONTROL: the PRE-FIX render reads as a benign no-op on the real incident input', () => {
    // The exact pre-fix expression, kept here forever so this suite cannot go vacuously green.
    const preFix = 'No member terminals were started for fleet `silent-wrong-answers-2026-08-01-plan-fleet`.';
    // Nothing in it marks a problem: no warning, no shortfall, no cause, no remedy.
    expect(preFix).not.toMatch(/⚠|SHORT BY|capacity|clamp/i);
    // ...while the truth is that a full fleet was requested and none of it exists.
    expect(describeFleetFillOutcome(SUPPRESSED).shortfall).toBe(2);
  });

  it('names the shortfall, the cause and the remedy when a suppressed wave leaves the fleet empty', () => {
    const fill = describeFleetFillOutcome(SUPPRESSED);
    const headline = describeZeroOpenFleetHeadline({
      fleetSlug: 'silent-wrong-answers-2026-08-01-plan-fleet',
      fill,
      clampReason: 'capacity allows 0 new member terminals now (healthyAccounts 0)',
    });
    expect(headline).toMatch(/⚠/);
    expect(headline).toContain('SHORT BY 2');
    expect(headline).toContain('capacity-clamped');
    expect(headline).toContain('healthyAccounts 0');
    // The remedy must be named, since the caller otherwise reads this as "nothing to do".
    expect(headline).toMatch(/re-call|retry|recover/i);
    // It must NOT read as the benign pre-fix sentence.
    expect(headline).not.toBe('No member terminals were started for fleet `silent-wrong-answers-2026-08-01-plan-fleet`.');
  });

  it('stays benign when zero opened because the fleet is ALREADY at target — that is not a shortfall', () => {
    const fill = describeFleetFillOutcome({ requested: 2, liveMembers: 3, attempted: 0, opened: 0 });
    expect(fill.complete).toBe(true);
    const headline = describeZeroOpenFleetHeadline({ fleetSlug: 'f', fill, clampReason: null });
    // No false alarm: an at-target fleet opening nothing is the correct outcome.
    expect(headline).not.toMatch(/⚠|SHORT BY/);
  });

  it('still warns when the members were ATTEMPTED and all failed, not merely suppressed', () => {
    const fill = describeFleetFillOutcome({ requested: 3, liveMembers: 0, attempted: 3, opened: 0 });
    const headline = describeZeroOpenFleetHeadline({ fleetSlug: 'f', fill, clampReason: null });
    expect(headline).toMatch(/⚠/);
    expect(headline).toContain('SHORT BY 3');
  });

  it('uses the caller noun so a headless fleet does not claim desktop terminals', () => {
    const fill = describeFleetFillOutcome({ ...SUPPRESSED, noun: 'HEADLESS member' });
    const headline = describeZeroOpenFleetHeadline({ fleetSlug: 'f', fill, clampReason: null });
    expect(headline).toContain('HEADLESS member');
  });
});

describe('count arg description (P-006 recurrence guard — the doc must not re-drift from the behaviour)', () => {
  const countDescription = (launchOnPlan.args as unknown as { shape: { count: { description?: string } } }).shape.count
    .description;

  it('states the TARGET-fleet-size semantics the code actually implements', () => {
    expect(countDescription).toBeTruthy();
    const d = String(countDescription);
    expect(d).toMatch(/TARGET fleet size/i);
    expect(d).toMatch(/deficit/i);
    // the actionable escape hatch for "add N more" (there is no add-N argument)
    expect(d).toMatch(/count = liveMembers \+ N/i);
  });

  it('does NOT reintroduce the pre-fix wording, which described a behaviour the tool never had', () => {
    expect(String(countDescription)).not.toMatch(/^Number of member terminals to open/);
  });

  it('points the reader at the machine-readable fill verdict rather than the opened count', () => {
    const d = String(countDescription);
    expect(d).toMatch(/fleetSize/);
    expect(d).toMatch(/shortfall/);
  });

  it('documents the pre-spawn executable-width refusal and its machine-readable diagnostics', () => {
    const d = String(countDescription);
    expect(d).toMatch(/executable DAG frontier/i);
    expect(d).toMatch(/requestedSeats\/executableWidth\/seatShortfall/);
    expect(d).toMatch(/exact blocker diagnostics/i);
  });

  it('accepts a large-fleet target above the 12-terminal wave cap', () => {
    const parsed = launchOnPlan.args.safeParse({ name: 'large-fleet', plan: 'p-plan', count: 28 });
    expect(parsed.success).toBe(true);
  });

  it('documents governed admission without a local per-call terminal cap', () => {
    expect(String(countDescription)).toMatch(/governed admission/i);
    expect(String(countDescription)).not.toMatch(/at most 12 NEW terminals/i);
  });
});

describe('computeFleetTopUpWave (WI-40199 — target size opens only the live deficit)', () => {
  it('opens one canary when a 27-member fleet targets 28', () => {
    expect(computeFleetTopUpWave(28, 27)).toEqual({
      remainingDeficit: 1,
      requestedOpenCount: 1,
      waveCapped: false,
    });
  });

  it('returns the full deficit when it exceeds the former 12-member ceiling', () => {
    expect(computeFleetTopUpWave(50, 27)).toEqual({
      remainingDeficit: 23,
      requestedOpenCount: 23,
      waveCapped: false,
    });
  });
});

describe('runLaunchWavesBeforeVerification (WI-39368 — slow verification cannot starve later members)', () => {
  it('opens every bounded wave before a slow first-wave verifier is allowed to settle', async () => {
    const events: string[] = [];
    let releaseVerification!: () => void;
    let resolveVerificationStarted!: () => void;
    const verificationStarted = new Promise<void>((resolve) => {
      resolveVerificationStarted = resolve;
    });
    const verificationGate = new Promise<void>((resolve) => {
      releaseVerification = resolve;
    });

    const run = runLaunchWavesBeforeVerification(
      [[0], [1, 2, 3]],
      ['member-1', 'member-2', 'member-3', 'member-4'],
      async (_waveIndex, _indices, ownerIds) => {
        events.push(`spawn:${ownerIds.join(',')}`);
        return { payload: ownerIds.join(','), stopAfterSpawn: false };
      },
      async ({ payload }) => {
        events.push(`verify:${payload}`);
        if (payload === 'member-1') {
          resolveVerificationStarted();
          await verificationGate;
        }
      },
    );

    try {
      await verificationStarted;
      expect(events).toEqual(['spawn:member-1', 'spawn:member-2,member-3,member-4', 'verify:member-1']);
    } finally {
      releaseVerification();
    }
    await run;
    expect(events).toEqual([
      'spawn:member-1',
      'spawn:member-2,member-3,member-4',
      'verify:member-1',
      'verify:member-2,member-3,member-4',
    ]);
  });
});

describe('deadWaveSlotOverride (EI-20361787885323735 — owner-killed wave holds the launch slot)', () => {
  const MIN = DEAD_WAVE_OVERRIDE_MIN_AGE_MS;
  it('overrides when the prior wave is past the boot gap and ZERO members are live', () => {
    expect(deadWaveSlotOverride({ priorAtMs: 1_000_000, nowMs: 1_000_000 + MIN, liveMembers: 0 })).toBe(true);
  });
  it('keeps the suppression while the prior wave is still inside the boot gap (members may not have registered)', () => {
    expect(deadWaveSlotOverride({ priorAtMs: 1_000_000, nowMs: 1_000_000 + MIN - 1, liveMembers: 0 })).toBe(false);
  });
  it('keeps the suppression when ANY member is live — the guard is protecting a real wave', () => {
    expect(deadWaveSlotOverride({ priorAtMs: 1_000_000, nowMs: 1_000_000 + MIN * 10, liveMembers: 1 })).toBe(false);
  });
  it('honors an explicit minAgeMs', () => {
    expect(deadWaveSlotOverride({ priorAtMs: 0, nowMs: 5_000, liveMembers: 0, minAgeMs: 4_000 })).toBe(true);
    expect(deadWaveSlotOverride({ priorAtMs: 0, nowMs: 3_000, liveMembers: 0, minAgeMs: 4_000 })).toBe(false);
  });
});
