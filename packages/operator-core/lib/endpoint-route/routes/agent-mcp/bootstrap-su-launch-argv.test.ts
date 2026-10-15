/**
 * Unit tests for the bootstrap-su launch-argv + AUTO-mode helpers (WI-1343 / WI-1356).
 *
 * These are the pure, server-side pieces of the launch-path fixes:
 *   - normalizeLaunchArgv  — validate/cap a caller-supplied launch_argv.
 *   - reconstructPsuLaunchArgv — the server-side FALLBACK argv when the caller omits it.
 *   - AUTO_MODE_DIRECTIVE  — the durable AUTO activation baked into the prompt + kickoff.
 *
 * The DB-touching sibling modules are mocked so importing the route doesn't reach for
 * @papercusp/db-org (mirrors launch-su.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const budgetMocks = vi.hoisted(() => ({ getPresence: vi.fn() }));
beforeEach(() => {
  budgetMocks.getPresence.mockReset();
  budgetMocks.getPresence.mockResolvedValue(null);
});

vi.mock('../../../adv-sessions', async (orig) => ({ ...(await orig<typeof import('../../../adv-sessions')>()), endedRecordedOwnerIds: vi.fn(async () => new Set<string>()),
  recordAdvSession: vi.fn(async () => 1),
  markAdvSessionEnded: vi.fn(async () => {}),
  claimAdvSessionResume: vi.fn(async () => false),
  reanchorAdvSessionNativeId: vi.fn(async () => ({ reanchored: true, owner: null })),
}));
// Keep the (PG-backed) presence module out of this pure argv test — bootstrap-su
// only dynamic-imports touchHeartbeat from it (WI-1893 removed setPendingFleet).
vi.mock('../../../agent-tools/coordination/presence', () => ({
  touchHeartbeat: vi.fn(async () => {}),
  getPresence: budgetMocks.getPresence,
}));

import {
  normalizeLaunchArgv,
  reconstructPsuLaunchArgv,
  codexCompactionLimitFromLaunchArgv,
  codexCompactionLimitForBootstrap,
  AUTO_MODE_DIRECTIVE,
} from './bootstrap-su';

describe('normalizeLaunchArgv (WI-1343)', () => {
  it('accepts a clean string[] and returns it', () => {
    expect(normalizeLaunchArgv(['psu', '--no-picker', '--agent=claude'])).toEqual([
      'psu', '--no-picker', '--agent=claude',
    ]);
  });
  it('returns null for a non-array or empty/all-non-string input', () => {
    expect(normalizeLaunchArgv(undefined)).toBeNull();
    expect(normalizeLaunchArgv('psu --no-picker')).toBeNull();
    expect(normalizeLaunchArgv([])).toBeNull();
    expect(normalizeLaunchArgv([1, 2, {}])).toBeNull();
  });
  it('drops non-string elements and caps element length + array length', () => {
    expect(normalizeLaunchArgv(['psu', 42, '--agent=claude', null])).toEqual(['psu', '--agent=claude']);
    const long = 'x'.repeat(5000);
    expect(normalizeLaunchArgv([long])![0]!.length).toBe(2000);
    const huge = Array.from({ length: 300 }, (_, i) => `--f${i}`);
    expect(normalizeLaunchArgv(huge)!.length).toBe(128);
  });
});

describe('codexCompactionLimitFromLaunchArgv (P-005)', () => {
  it('reads the per-session soft ceiling from the persisted psu argv', () => {
    expect(codexCompactionLimitFromLaunchArgv(['psu', '--compaction-limit=250000'])).toBe(250_000);
    expect(codexCompactionLimitFromLaunchArgv(['psu', '--compaction-limit', '250000'])).toBe(250_000);
  });

  it('falls through when the launch argv has no valid explicit ceiling', () => {
    expect(codexCompactionLimitFromLaunchArgv(['psu', '--no-picker'])).toBeNull();
    expect(codexCompactionLimitFromLaunchArgv(['psu', '--compaction-limit=lots'])).toBeNull();
  });
});

describe('registered Codex bootstrap budget (WI-6554700010011827)', () => {
  it.each([
    { argv: ['psu', '--compaction-limit=250000'] },
    { argv: ['psu'] },
  ])('retains the current owner budget over $argv', async ({ argv }) => {
    budgetMocks.getPresence.mockResolvedValue({ compactionLimit: 225_000 });
    expect(await codexCompactionLimitForBootstrap('su-current-budget', argv)).toBe(225_000);
    expect(budgetMocks.getPresence).toHaveBeenCalledWith('su-current-budget');
  });

  it('preserves legacy argv when no current owner budget exists', async () => {
    expect(await codexCompactionLimitForBootstrap('su-legacy-budget', ['psu', '--compaction-limit=250000']))
      .toBe(250_000);
  });

  it('refuses unreadable metadata before native materialization', async () => {
    budgetMocks.getPresence.mockRejectedValueOnce(new Error('budget metadata unavailable'));
    await expect(codexCompactionLimitForBootstrap('su-current-budget', ['psu']))
      .rejects.toThrow('budget metadata unavailable');
  });
});

describe('reconstructPsuLaunchArgv (WI-1343 server-side fallback)', () => {
  it('reconstructs a plan-bound claude launch', () => {
    expect(reconstructPsuLaunchArgv({ agent: 'claude', harnessSlug: 'h1', planSlug: 'p1' })).toEqual([
      'psu', '--no-picker', '--agent=claude', '--harness=h1', '--plan=p1',
    ]);
  });
  it('emits --no-plan, and includes fleet/account/profile/context when set', () => {
    expect(
      reconstructPsuLaunchArgv({
        agent: 'omp',
        harnessSlug: null,
        planSlug: null,
        profile: 'power',
        contextSize: 'full',
        account: 'acct1',
        fleet: 'shared-hive-testing',
      }),
    ).toEqual([
      'psu', '--no-picker', '--agent=omp', '--no-plan',
      '--profile=power', '--context-size=full', '--account=acct1', '--fleet=shared-hive-testing',
    ]);
  });
  it('omits the default engineer profile', () => {
    expect(reconstructPsuLaunchArgv({ agent: 'claude', profile: 'engineer' })).not.toContain('--profile=engineer');
  });
});

describe('reconstructPsuLaunchArgv — role param (WI-1347, extended to bootstrap-role.ts)', () => {
  it('emits --role= instead of --profile= for a role-scoped launch', () => {
    expect(
      reconstructPsuLaunchArgv({ agent: 'claude', harnessSlug: 'h1', planSlug: 'p1', role: 'engineer' }),
    ).toEqual(['psu', '--no-picker', '--agent=claude', '--role=engineer', '--harness=h1', '--plan=p1']);
  });

  it('retains repeatable stack bindings in the fallback argv', () => {
    expect(
      reconstructPsuLaunchArgv({
        agent: 'claude',
        role: 'reviewer',
        stack: ['domain:papercusp-engineer', 'practice:careful-review'],
      }),
    ).toEqual(expect.arrayContaining(['--stack=domain:papercusp-engineer', '--stack=practice:careful-review']));
  });

  it('role and profile are mutually exclusive — role wins, profile is never emitted', () => {
    const argv = reconstructPsuLaunchArgv({ agent: 'claude', role: 'reviewer', profile: 'power' });
    expect(argv).toContain('--role=reviewer');
    expect(argv).not.toContain('--profile=power');
  });

  it('omitting role is byte-identical to the pre-WI-1347 reconstruction', () => {
    const withoutRole = reconstructPsuLaunchArgv({ agent: 'claude', harnessSlug: 'h1', planSlug: 'p1' });
    const explicitNullRole = reconstructPsuLaunchArgv({
      agent: 'claude', harnessSlug: 'h1', planSlug: 'p1', role: null,
    });
    expect(explicitNullRole).toEqual(withoutRole);
    expect(withoutRole.some((a) => a.startsWith('--role='))).toBe(false);
  });
});

describe('AUTO_MODE_DIRECTIVE (WI-1356)', () => {
  it('names AUTO mode and the act/loop standing state', () => {
    expect(AUTO_MODE_DIRECTIVE).toMatch(/AUTO mode is ON/i);
    expect(AUTO_MODE_DIRECTIVE).toMatch(/do not stop to ask/i);
    expect(AUTO_MODE_DIRECTIVE).toMatch(/loop continuously/i);
  });
  it('tells a fleet agent to arm a self-sustaining loop (not park after turn 1)', () => {
    expect(AUTO_MODE_DIRECTIVE).toMatch(/loop:arm/i);
    expect(AUTO_MODE_DIRECTIVE).toMatch(/loop:end/i);
    expect(AUTO_MODE_DIRECTIVE).toMatch(/park/i);
  });
});
