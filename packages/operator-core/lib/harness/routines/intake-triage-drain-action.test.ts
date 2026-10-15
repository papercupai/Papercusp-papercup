/**
 * `system:intake-triage-drain` (observation-candidate-acceptance-promotion-2026-09-30,
 * P-008 / D-020, D-021): every fire outcome says why, the drain seeds a SEPARATE
 * `intake-triage` run of `improvement:<id>` items, and it launches with the owner's
 * saved Inbox resolver profile while authority comes from the standing policy.
 *
 * The SQL population (awaiting predicate, scorecard/terminal/open-run exclusions)
 * is proven against a migrated Postgres in intake-triage-drain-action.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  getRunningRun: vi.fn(async (): Promise<{ runId: string; phase: string } | null> => null),
  readConsecutiveNeverBeatRuns: vi.fn(async () => ({ consecutive: 0, newestCreatedAt: null as string | null })),
  readAgentConfig: vi.fn(async (): Promise<{ resolverProfiles?: Record<string, unknown> }> => ({})),
}));
vi.mock('../../attention/bulk-run-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../attention/bulk-run-store')>()),
  getRunningRun: h.getRunningRun,
  readConsecutiveNeverBeatRuns: h.readConsecutiveNeverBeatRuns,
}));
vi.mock('../../agent-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-config')>()),
  readAgentConfig: h.readAgentConfig,
}));

import { BulkRunAlreadyActiveError } from '../../attention/bulk-run-store';
import { UNATTENDED_INTAKE_REQUESTER } from '../../attention/bulk-run-owner-digest';
import {
  buildIntakeTriageSeedItems,
  INTAKE_TRIAGE_DRAIN_CAP,
  INTAKE_TRIAGE_REQUESTER,
  INTAKE_TRIAGE_RUN_KIND,
  makeIntakeTriageDrainAction,
  type AwaitingIntakeRow,
  type IntakeTriageDrainDeps,
} from './intake-triage-drain-action';

const ctx = { installSlug: 'papercusp', workspaceId: 'ws-1', triggerConfig: {}, payloadTemplate: null };
const NOW = Date.parse('2026-10-01T16:00:00Z');
const ROWS: AwaitingIntakeRow[] = [
  { id: 'EI-2', harnessSlug: 'papercusp', title: 'Observation: gate flaked twice' },
  { id: 'EI-1', harnessSlug: null, title: null },
];
const POLICY = { level: 'L0', mode: 'review-all', minConfidence: 'high' } as never;

function deps(overrides: Partial<IntakeTriageDrainDeps> = {}) {
  const createRun = vi.fn(async () => ({ runId: 'bulk-intake-1' }) as never);
  const setRunPhase = vi.fn(async (_input: { phase: string; error?: string }) => null as never);
  const launch = vi.fn(async (_input: Parameters<IntakeTriageDrainDeps['launch']>[0]) => ({ ok: true }));
  const log = vi.fn();
  const all: Partial<IntakeTriageDrainDeps> = {
    enabled: async () => true,
    runningRun: async () => null,
    readAwaitingIntake: async () => ROWS,
    readLaunchProfile: async () => null,
    recentNeverBeat: async () => ({ consecutive: 0, newestCreatedAt: null }),
    readAutomationPolicy: async () => POLICY,
    createRun: createRun as never,
    setRunPhase: setRunPhase as never,
    nowMs: () => NOW,
    newOwnerId: () => 'su-intake-resolver',
    launch,
    log,
    ...overrides,
  };
  return { all, createRun, setRunPhase, launch, log };
}

beforeEach(() => {
  h.getRunningRun.mockClear();
  h.readConsecutiveNeverBeatRuns.mockClear();
  h.readAgentConfig.mockReset();
  h.readAgentConfig.mockResolvedValue({});
});

describe('buildIntakeTriageSeedItems', () => {
  it('maps awaiting rows to improvement items the P-004/P-006 intake path recognizes', () => {
    expect(buildIntakeTriageSeedItems(ROWS)).toEqual([
      {
        itemId: 'improvement:EI-2',
        kind: 'improvement',
        title: 'Observation: gate flaked twice',
        ref: { kind: 'improvement', issueId: 'EI-2', harnessSlug: 'papercusp' },
        ownerAgentId: null,
      },
      {
        itemId: 'improvement:EI-1',
        kind: 'improvement',
        title: null,
        ref: { kind: 'improvement', issueId: 'EI-1', harnessSlug: null },
        ownerAgentId: null,
      },
    ]);
  });

  it('de-duplicates, drops blank ids and caps at 200', () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ id: `EI-${i}`, harnessSlug: null, title: null }));
    rows.push({ id: 'EI-0', harnessSlug: null, title: null }, { id: '  ', harnessSlug: null, title: null });
    const seeds = buildIntakeTriageSeedItems(rows);
    expect(seeds).toHaveLength(INTAKE_TRIAGE_DRAIN_CAP);
    expect(new Set(seeds.map((s) => s.itemId)).size).toBe(INTAKE_TRIAGE_DRAIN_CAP);
    expect(seeds[0]!.itemId).toBe('improvement:EI-0');
  });
});

describe('intake-triage drain fire outcomes', () => {
  it('does nothing while the shared bulk-resolve kill switch is off', async () => {
    const readAwaitingIntake = vi.fn();
    const d = deps({ enabled: async () => false, readAwaitingIntake });
    expect(await makeIntakeTriageDrainAction(d.all).fire(ctx)).toEqual({ status: 'disabled' });
    expect(readAwaitingIntake).not.toHaveBeenCalled();
  });

  it('is single-flight on its OWN run kind (production wiring), and names the blocking run', async () => {
    h.getRunningRun.mockResolvedValueOnce({ runId: 'bulk-intake-0', phase: 'running' });
    const readAwaitingIntake = vi.fn();
    const d = deps({ readAwaitingIntake });
    delete d.all.runningRun;
    const outcome = await makeIntakeTriageDrainAction(d.all).fire(ctx);
    expect(outcome).toEqual({ status: 'skipped', reason: 'single-flight' });
    expect(h.getRunningRun).toHaveBeenCalledWith('ws-1', 'intake-triage');
    expect(readAwaitingIntake).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('skip: run=bulk-intake-0 is running (single-flight)');
  });

  it('skips with its own reason when nothing awaits intake', async () => {
    const d = deps({ readAwaitingIntake: async () => [] });
    expect(await makeIntakeTriageDrainAction(d.all).fire(ctx)).toEqual({ status: 'skipped', reason: 'no-awaiting-intake' });
    expect(d.createRun).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith('skip: no awaiting intake outside an open run');
  });

  it('backs off after consecutive never-heartbeated intake runs (production wiring reads this kind and requester)', async () => {
    h.readConsecutiveNeverBeatRuns.mockResolvedValueOnce({ consecutive: 3, newestCreatedAt: '2026-10-01T15:50:00Z' });
    const d = deps();
    delete d.all.recentNeverBeat;
    const outcome = await makeIntakeTriageDrainAction(d.all).fire(ctx);
    expect(outcome).toEqual({ status: 'skipped', reason: 'never-beat-backoff' });
    expect(h.readConsecutiveNeverBeatRuns).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      kind: 'intake-triage',
      requestedBy: 'system:intake-triage-drain',
    });
    expect(d.launch).not.toHaveBeenCalled();
  });

  it('seeds a separate intake-triage run as the unattended intake requester, then marks it running', async () => {
    const d = deps();
    const outcome = await makeIntakeTriageDrainAction(d.all).fire(ctx);
    expect(outcome).toEqual({ status: 'launched', runId: 'bulk-intake-1', items: 2 });
    expect(d.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runKind: INTAKE_TRIAGE_RUN_KIND,
        workspaceId: 'ws-1',
        requestedBy: INTAKE_TRIAGE_REQUESTER,
        automationPolicy: POLICY,
        items: buildIntakeTriageSeedItems(ROWS),
      }),
    );
    // The owner digest recognizes exactly this requester as unattended intake (R-27).
    expect(INTAKE_TRIAGE_REQUESTER).toBe(UNATTENDED_INTAKE_REQUESTER);
    expect(d.setRunPhase.mock.calls.map((call) => call[0].phase)).toEqual(['pending', 'running']);
    expect(d.launch).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'bulk-intake-1', itemCount: 2, resolverOwner: 'su-intake-resolver' }),
    );
  });

  it('records a failed launch on the run instead of leaving it pending', async () => {
    const d = deps({ launch: vi.fn(async () => ({ ok: false, error: 'no backend' })) });
    expect(await makeIntakeTriageDrainAction(d.all).fire(ctx)).toEqual({
      status: 'launch-failed',
      runId: 'bulk-intake-1',
      items: 2,
    });
    expect(d.setRunPhase).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'failed', error: 'no backend' }));
  });

  it('reports a lost single-flight race as a skip, and any other error as an error', async () => {
    const raced = deps({
      createRun: vi.fn(async () => {
        throw new BulkRunAlreadyActiveError('bulk-other', 'pending', 'intake-triage');
      }) as never,
    });
    expect(await makeIntakeTriageDrainAction(raced.all).fire(ctx)).toEqual({ status: 'skipped', reason: 'lost-race' });
    const broken = deps({
      createRun: vi.fn(async () => {
        throw new Error('pg down');
      }) as never,
    });
    expect(await makeIntakeTriageDrainAction(broken.all).fire(ctx)).toEqual({ status: 'error', error: 'pg down' });
  });
});

// D-021: the intake drain has no settings pane, so it launches exactly like the
// scheduled Inbox resolver: the owner's saved inbox-resolve profile. A default
// third profile would launch the system login that WI-10004887 found failing.
describe('launch route (D-021)', () => {
  it("launches with the owner's saved inbox-resolve profile through the production wiring", async () => {
    h.readAgentConfig.mockResolvedValue({
      resolverProfiles: {
        'inbox-resolve': { model: 'gpt-6.1-sol', effort: 'xhigh', account: 'default', carry: 'warm' },
        'plan-cleanup': { model: 'sonnet', effort: 'high', account: 'pool-a', carry: 'cold' },
      },
    });
    const d = deps();
    delete d.all.readLaunchProfile;
    await makeIntakeTriageDrainAction(d.all).fire(ctx);
    expect(h.readAgentConfig).toHaveBeenCalled();
    expect(d.launch.mock.calls[0]![0].launch).toMatchObject({
      model: 'gpt-6.1-sol',
      effort: 'xhigh',
      account: 'default',
      backend: 'codex',
      // Authority still comes from the standing policy, never the profile.
      automationMode: 'review-all',
      minConfidence: 'high',
    });
  });

  it('falls back to the launcher default when no profile is saved', async () => {
    const d = deps();
    delete d.all.readLaunchProfile;
    await makeIntakeTriageDrainAction(d.all).fire(ctx);
    expect(d.launch.mock.calls[0]![0].launch).toMatchObject({ model: null, account: 'default' });
  });
});
