import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getFleet: vi.fn(),
  getFleetHeadcountTarget: vi.fn(),
  setFleetHeadcountTarget: vi.fn(),
  resolveHarnessPlansDir: vi.fn(),
  readPlanBySlug: vi.fn(),
}));

vi.mock('../../agent-fleets-store', () => ({
  FLEET_TYPES: ['single', 'paired'] as const,
  getFleet: (...args: unknown[]) => mocks.getFleet(...args),
  getFleetHeadcountTarget: (...args: unknown[]) => mocks.getFleetHeadcountTarget(...args),
  setFleetHeadcountTarget: (...args: unknown[]) => mocks.setFleetHeadcountTarget(...args),
}));
vi.mock('../plans/source', () => ({
  resolveHarnessPlansDir: (...args: unknown[]) => mocks.resolveHarnessPlansDir(...args),
  readPlanBySlug: (...args: unknown[]) => mocks.readPlanBySlug(...args),
}));
vi.mock('./_shared', () => ({
  resolveFleetCaller: () => ({ workspaceId: 'ws-test', ownerId: 'su-leader' }),
  json: (payload: Record<string, unknown>, isError = false) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    isError,
  }),
}));
// P-007 / R-17: silent-member partition IO legs.
const silenceMocks = vi.hoisted(() => ({
  executingOwnersSince: vi.fn(),
  sql: vi.fn(),
}));
vi.mock('../../fleet/assignments', () => ({
  executingOwnersSince: (...args: unknown[]) => silenceMocks.executingOwnersSince(...args),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: (...args: unknown[]) => silenceMocks.sql(...args) }),
}));

import tool, { buildFleetTopUpRule } from './headcount-target';
import {
  FLEET_MEMBER_SILENCE_THRESHOLD_MS,
  partitionSilentFleetMembers,
  readFleetMemberSilence,
} from './silent-member';

describe('silent fleet members (P-007 / R-17)', () => {
  beforeEach(() => {
    silenceMocks.executingOwnersSince.mockReset();
    silenceMocks.sql.mockReset();
  });

  it('uses the 20-minute D-007 threshold', () => {
    expect(FLEET_MEMBER_SILENCE_THRESHOLD_MS).toBe(20 * 60_000);
  });

  it('does not count a heartbeat-only member in an unpaused fleet, and names it silent', () => {
    // `quiet` is live (heartbeating) but made no call inside the threshold and only
    // holds the inbox-wake keepalive await — that is silence.
    const partition = partitionSilentFleetMembers({
      liveMemberIds: ['busy', 'quiet', 'waiting'],
      recentCallerIds: new Set(['busy']),
      awaitingKeysByOwner: new Map([
        ['quiet', ['coord:inbox-wake:quiet']],
        ['waiting', ['work-item:done:WI-1']],
      ]),
      fleetPaused: false,
    });
    expect(partition).not.toBeNull();
    expect(partition!.counted).toEqual(['busy', 'waiting']);
    expect(partition!.silent).toEqual(['quiet']);
    expect(partition!.counted).not.toContain('quiet');
  });

  it('still counts a silent member while the fleet is paused', () => {
    const partition = partitionSilentFleetMembers({
      liveMemberIds: ['busy', 'quiet'],
      recentCallerIds: new Set(['busy']),
      awaitingKeysByOwner: new Map(),
      fleetPaused: true,
    });
    expect(partition!.counted).toEqual(['busy', 'quiet']);
    expect(partition!.silent).toEqual([]);
    expect(partition!.paused).toBe(true);
  });

  it('answers unknown, not "everyone silent", when a leg is unreadable', () => {
    expect(partitionSilentFleetMembers({
      liveMemberIds: ['busy'],
      recentCallerIds: null,
      awaitingKeysByOwner: new Map(),
      fleetPaused: false,
    })).toBeNull();
    expect(partitionSilentFleetMembers({
      liveMemberIds: ['busy'],
      recentCallerIds: new Set(['busy']),
      awaitingKeysByOwner: null,
      fleetPaused: false,
    })).toBeNull();
  });

  it('reads calls over the threshold window and pending awaits for the live set', async () => {
    silenceMocks.executingOwnersSince.mockResolvedValue(new Set(['busy']));
    silenceMocks.sql.mockResolvedValue([
      { subscriber_id: 'quiet', event_key: 'coord:inbox-wake:quiet' },
    ]);
    const partition = await readFleetMemberSilence(['busy', 'quiet'], { fleetPaused: false });
    expect(silenceMocks.executingOwnersSince).toHaveBeenCalledWith(
      ['busy', 'quiet'],
      FLEET_MEMBER_SILENCE_THRESHOLD_MS,
    );
    expect(partition!.counted).toEqual(['busy']);
    expect(partition!.silent).toEqual(['quiet']);
  });

  it('skips the IO legs for a paused fleet', async () => {
    const partition = await readFleetMemberSilence(['quiet'], { fleetPaused: true });
    expect(silenceMocks.executingOwnersSince).not.toHaveBeenCalled();
    expect(partition!.counted).toEqual(['quiet']);
  });
});

const savedProfile = {
  workspaceId: 'ws-test',
  fleetSlug: 'byoc',
  target: 1,
  config: {
    plan: 'byoc-plan',
    harness: 'papercusp',
    agent: 'codex' as const,
    model: 'gpt-5.6-sol',
    effort: 'xhigh',
    account: 'default',
    headless: true,
    carry: 'warm' as const,
    contextSize: 'trimmed' as const,
  },
  nextAttemptAt: null,
  backoffMs: 0,
  lastError: null,
};

function parse(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getFleet.mockResolvedValue({ fleetSlug: 'byoc' });
  mocks.getFleetHeadcountTarget.mockResolvedValue(savedProfile);
  mocks.setFleetHeadcountTarget.mockResolvedValue(undefined);
  mocks.resolveHarnessPlansDir.mockResolvedValue({ workspaceId: 'ws-test', harnessSlug: 'papercusp' });
  mocks.readPlanBySlug.mockResolvedValue({ slug: 'byoc-plan' });
});

describe('fleet:headcount-target canonical launch profile', () => {
  it('accepts a planless claim-spec target while still requiring its harness', async () => {
    const planlessArgs = {
      fleet: 'byoc',
      target: 50,
      productiveCapacityFloor: 1,
      harness: 'papercusp',
      agent: 'codex',
      model: 'gpt-6-luna',
      effort: 'max',
      account: 'auto',
      headless: true,
      carry: 'warm',
      supervise: true,
    } as const;
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce(null);

    expect(tool.args.safeParse({ fleet: 'byoc', target: 50, harness: 'papercusp' }).success).toBe(true);
    expect(tool.args.safeParse({ fleet: 'byoc', target: 50 }).success).toBe(false);

    const result = await tool.handler(planlessArgs as never, {} as never);

    expect(parse(result)).toMatchObject({
      ok: true,
      target: 50,
      config: {
        harness: 'papercusp',
        agent: 'codex',
        model: 'gpt-6-luna',
        effort: 'max',
        account: 'auto',
        headless: true,
        carry: 'warm',
        supervise: true,
      },
    });
    expect(parse(result).config).not.toHaveProperty('plan');
    expect(mocks.resolveHarnessPlansDir).toHaveBeenCalledWith('papercusp', { workspaceId: 'ws-test' });
    expect(mocks.readPlanBySlug).not.toHaveBeenCalled();
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 50,
      config: expect.objectContaining({ harness: 'papercusp', agent: 'codex', account: 'auto' }),
    });
  });

  it('preserves and revalidates an existing plan when an update omits plan', async () => {
    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp' } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({ ok: true, config: savedProfile.config });
    expect(mocks.readPlanBySlug).toHaveBeenCalledWith('byoc-plan', {
      harnessSlug: 'papercusp',
      workspaceId: 'ws-test',
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: savedProfile.config,
    });
  });

  it('disables the governor as an attributed, expiring no-top-up rule and keeps the saved profile (P-005 / D-030)', async () => {
    // Every real read sets `enabled`; the shared legacy fixture predates it.
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce({ ...savedProfile, enabled: true });
    const before = Date.now();
    const result = await tool.handler(
      {
        fleet: 'byoc', target: null, harness: 'papercusp', plan: 'byoc-plan', replaceExisting: false,
        reason: 'D-001: no waves while the migration lands',
      } as never,
      {} as never,
    );
    const body = parse(result);
    expect(body).toMatchObject({
      ok: true,
      disabled: true,
      launchProfilePreserved: true,
      topUpRule: {
        kind: 'target-disabled',
        ratifiedBy: 'su-leader',
        reason: 'D-001: no waves while the migration lands',
        // The target in force is what the expiry restores, not something lost.
        suspendedTarget: 1,
        suspendedSupervise: null,
      },
    });
    const rule = body.topUpRule as { until: number; ratifiedAt: number };
    expect(rule.until - rule.ratifiedAt).toBe(24 * 3_600_000);
    expect(rule.ratifiedAt).toBeGreaterThanOrEqual(before);
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test', fleetSlug: 'byoc', target: null, topUpRule: body.topUpRule,
    });
  });

  it('reports no stored rule when a disabled fleet has no saved recipe to restore', async () => {
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce(null);
    const result = await tool.handler(
      { fleet: 'byoc', target: null, reason: 'never staffed' } as never,
      {} as never,
    );
    expect(parse(result)).toMatchObject({ ok: true, disabled: true, launchProfilePreserved: false, topUpRule: null });
  });

  it('requires a reason for every no-top-up rule and bounds its lifetime', () => {
    const disable = { fleet: 'byoc', target: null, harness: 'papercusp' };
    expect(tool.args.safeParse(disable).success).toBe(false);
    expect(tool.args.safeParse({ ...disable, reason: 'hold' }).success).toBe(true);
    expect(tool.args.safeParse({ ...disable, reason: 'hold', untilHours: 72 }).success).toBe(true);
    expect(tool.args.safeParse({ ...disable, reason: 'hold', untilHours: 73 }).success).toBe(false);
    expect(
      tool.args.safeParse({ fleet: 'byoc', target: 2, harness: 'papercusp', supervise: false }).success,
    ).toBe(false);
    expect(
      tool.args.safeParse({ fleet: 'byoc', target: 2, harness: 'papercusp', supervise: false, reason: 'pause' }).success,
    ).toBe(true);
    // untilHours only means something on a rule; elsewhere it would be silently ignored.
    expect(tool.args.safeParse({ fleet: 'byoc', target: 2, harness: 'papercusp', untilHours: 4 }).success).toBe(false);
  });

  it('refuses target:null recipe fields instead of silently dropping them', async () => {
    const result = await tool.handler(
      {
        fleet: 'byoc',
        target: null,
        harness: 'papercusp',
        plan: 'byoc-plan',
        agent: 'claude',
        model: 'fable[1m]',
        effort: 'high',
        account: 'default',
        replaceExisting: true,
        reason: 'repair the saved launch profile while disabled',
      } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({
      ok: false,
      error: 'invalid_args',
      // `reason` is no longer offending here: it is the rule's required reason.
      offending: ['agent', 'model', 'effort', 'account', 'replaceExisting'],
    });
    expect(parse(result).message).toContain('would be ignored');
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();
    expect(mocks.getFleetHeadcountTarget).not.toHaveBeenCalled();
  });

  it('preserves every omitted boot-baked setting when the target is re-enabled', async () => {
    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(result)).toMatchObject({
      ok: true,
      launchProfile: { existed: true, replaced: false },
      config: savedProfile.config,
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test', fleetSlug: 'byoc', target: 4, config: savedProfile.config,
    });
  });

  it('does not persist the legacy fleet membership label as a psu persona', async () => {
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce({
      ...savedProfile,
      config: { ...savedProfile.config, role: 'member' },
    });

    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    const payload = parse(result);

    expect(payload.config).not.toHaveProperty('role');
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: savedProfile.config,
    });
  });

  it('fails closed on a silent boot-setting change and allows only an explicitly reasoned replacement', async () => {
    const refused = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan', headless: false } as never,
      {} as never,
    );
    expect(parse(refused)).toMatchObject({
      ok: false,
      error: 'saved_launch_spec_conflict',
      conflicts: [expect.objectContaining({ field: 'headless', saved: true, requested: false })],
    });
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();

    const replaced = await tool.handler(
      {
        fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan',
        headless: false, replaceExisting: true, reason: 'move fleet to visible terminals',
      } as never,
      {} as never,
    );
    expect(parse(replaced)).toMatchObject({
      ok: true,
      config: { ...savedProfile.config, headless: false },
      launchProfile: {
        existed: true,
        replaced: true,
        conflicts: [expect.objectContaining({ field: 'headless' })],
        reason: 'move fleet to visible terminals',
      },
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: { ...savedProfile.config, headless: false },
    });
  });

  it('persists the productive-capacity floor on the existing canonical recipe', async () => {
    const result = await tool.handler(
      {
        fleet: 'byoc', target: 4, productiveCapacityFloor: 2,
        harness: 'papercusp', plan: 'byoc-plan',
      } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({
      ok: true,
      target: 4,
      config: { ...savedProfile.config, productiveCapacityFloor: 2 },
    });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 4,
      config: { ...savedProfile.config, productiveCapacityFloor: 2 },
    });
  });

  it('refuses prose launchContext before persisting a recipe that respawn would consume as a path', async () => {
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce(null);
    const result = await tool.handler(
      {
        fleet: 'byoc',
        target: 4,
        harness: 'papercusp',
        plan: 'byoc-plan',
        launchContext: 'Read the assigned work item and complete it with evidence.',
      } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({
      ok: false,
      error: 'invalid_launch_context',
      launchContext: 'Read the assigned work item and complete it with evidence.',
    });
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();
  });

  it('also refuses an inherited invalid launchContext instead of perpetuating a broken profile', async () => {
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce({
      ...savedProfile,
      config: {
        ...savedProfile.config,
        launchContext: 'resume the assigned task from the previous member',
      },
    });

    const result = await tool.handler(
      { fleet: 'byoc', target: 4, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );

    expect(parse(result)).toMatchObject({ ok: false, error: 'invalid_launch_context' });
    expect(mocks.setFleetHeadcountTarget).not.toHaveBeenCalled();
  });

  it('accepts and trims a readable launchContext path before persisting it', async () => {
    const contextDir = mkdtempSync(join(tmpdir(), 'papercusp-headcount-context-'));
    const contextPath = join(contextDir, 'brief.md');
    writeFileSync(contextPath, '# Fleet brief\n', 'utf8');
    mocks.getFleetHeadcountTarget.mockResolvedValueOnce(null);

    try {
      const result = await tool.handler(
        {
          fleet: 'byoc',
          target: 1,
          harness: 'papercusp',
          plan: 'byoc-plan',
          launchContext: ` ${contextPath} `,
        } as never,
        {} as never,
      );

      expect(parse(result)).toMatchObject({ ok: true, config: { launchContext: contextPath } });
      expect(mocks.setFleetHeadcountTarget).toHaveBeenCalledWith({
        workspaceId: 'ws-test',
        fleetSlug: 'byoc',
        target: 1,
        config: expect.objectContaining({ launchContext: contextPath }),
      });
    } finally {
      rmSync(contextDir, { recursive: true, force: true });
    }
  });

  // R5 (interrupted-member-recovery-hardening-2026-09-01): the supervise grant is a
  // governance knob, not a boot setting — it never trips the saved-spec conflict gate
  // (no replaceExisting needed), omission preserves the stored value, and false revokes.
  it('grants, preserves, and revokes the supervise flag without replaceExisting', async () => {
    const granted = await tool.handler(
      { fleet: 'byoc', target: 1, supervise: true, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(granted)).toMatchObject({ ok: true, config: { ...savedProfile.config, supervise: true } });
    expect(mocks.setFleetHeadcountTarget).toHaveBeenLastCalledWith({
      workspaceId: 'ws-test',
      fleetSlug: 'byoc',
      target: 1,
      config: { ...savedProfile.config, supervise: true },
    });

    mocks.getFleetHeadcountTarget.mockResolvedValue({
      ...savedProfile,
      config: { ...savedProfile.config, supervise: true },
    });
    const preserved = await tool.handler(
      { fleet: 'byoc', target: 2, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(preserved)).toMatchObject({ ok: true, target: 2, config: { ...savedProfile.config, supervise: true } });

    const revoked = await tool.handler(
      {
        fleet: 'byoc', target: 2, supervise: false, harness: 'papercusp', plan: 'byoc-plan',
        reason: 'hand-staffing during the cutover', untilHours: 6,
      } as never,
      {} as never,
    );
    // P-005 / D-030: a revoke is a no-top-up rule that remembers the grant it
    // suspended, so its expiry puts supervision back.
    const revokedBody = parse(revoked);
    expect(revokedBody).toMatchObject({
      ok: true,
      config: { ...savedProfile.config, supervise: false },
      topUpRule: {
        kind: 'supervise-revoked',
        ratifiedBy: 'su-leader',
        reason: 'hand-staffing during the cutover',
        suspendedTarget: 2,
        suspendedSupervise: true,
      },
    });
    const revokedRule = revokedBody.topUpRule as { until: number; ratifiedAt: number };
    expect(revokedRule.until - revokedRule.ratifiedAt).toBe(6 * 3_600_000);
    expect(mocks.setFleetHeadcountTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ config: { ...savedProfile.config, supervise: false }, topUpRule: revokedBody.topUpRule }),
    );

    // A recipe edit that does not touch supervise keeps the standing rule…
    mocks.getFleetHeadcountTarget.mockResolvedValue({
      ...savedProfile,
      target: 2,
      config: { ...savedProfile.config, supervise: false, topUpRule: revokedBody.topUpRule },
    });
    const edited = await tool.handler(
      { fleet: 'byoc', target: 3, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(edited)).toMatchObject({ ok: true, topUpRule: revokedBody.topUpRule });
    expect(parse(edited).config).not.toHaveProperty('topUpRule');

    // …and re-granting supervision ends it.
    const regranted = await tool.handler(
      { fleet: 'byoc', target: 3, supervise: true, harness: 'papercusp', plan: 'byoc-plan' } as never,
      {} as never,
    );
    expect(parse(regranted)).toMatchObject({ ok: true, topUpRule: null, config: { supervise: true } });
    expect(parse(regranted).config).not.toHaveProperty('topUpRule');
    expect(mocks.setFleetHeadcountTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: 3, topUpRule: undefined }),
    );
  });
});

describe('buildFleetTopUpRule (P-005 / D-030)', () => {
  const now = 1_800_000_000_000;
  const base = { ratifiedBy: 'su-new-leader', reason: 'still frozen', now };

  it('carries the originally suspended target forward when a disable is re-ratified', () => {
    const first = buildFleetTopUpRule({
      ...base, kind: 'target-disabled', targetInForce: null,
      existing: { ...savedProfile, enabled: true, target: 4, config: { ...savedProfile.config, supervise: true } },
    });
    expect(first).toMatchObject({ suspendedTarget: 4, suspendedSupervise: true });

    // The row is now disabled (target column NULL, read back as target=1); the
    // renewal must still restore 4 + the grant, not the placeholder 1.
    const renewed = buildFleetTopUpRule({
      ...base, kind: 'target-disabled', targetInForce: null, untilHours: 48,
      existing: { ...savedProfile, enabled: false, target: 1, config: { ...savedProfile.config, topUpRule: first } },
    });
    expect(renewed).toMatchObject({ suspendedTarget: 4, suspendedSupervise: true, ratifiedBy: 'su-new-leader' });
    expect(renewed.until).toBe(now + 48 * 3_600_000);
  });

  it('suspends nothing restorable for a fleet that never had a target or a grant', () => {
    expect(
      buildFleetTopUpRule({ ...base, kind: 'target-disabled', targetInForce: null, existing: null }),
    ).toMatchObject({ suspendedTarget: null, suspendedSupervise: null });
  });

  it('clamps the lifetime to the maximum even if a caller bypasses the schema', () => {
    const rule = buildFleetTopUpRule({
      ...base, kind: 'supervise-revoked', targetInForce: 2, existing: null, untilHours: 1_000,
    });
    expect(rule.until).toBe(now + 72 * 3_600_000);
    expect(rule.suspendedTarget).toBe(2);
  });
});
