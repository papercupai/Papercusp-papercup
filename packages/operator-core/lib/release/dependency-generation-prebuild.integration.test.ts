/** Real Postgres acceptance for prerequisite-ready scheduling on the existing routine. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { CHECKPOINT_QUALIFICATION_METADATA_KEY } from './checkpoint-qualification-transaction';
import {
  dependencyPrebuildKey,
  emitDependencyPrebuildTerminal,
  type DependencyPrebuildReadyState,
} from './dependency-generation-prebuild';

const candidate = 'a'.repeat(40);
const successor = 'b'.repeat(40);
const inputFingerprint = 'c'.repeat(64);
const target = { workspaceId: 'ws-prebuild-ready-schedule', installSlug: 'papercusp' };
const ready: DependencyPrebuildReadyState = {
  schema: 1, status: 'ready', key: dependencyPrebuildKey(candidate, inputFingerprint),
  candidate, inputFingerprint, attemptId: 'prebuild-attempt', queuedAtMs: 100,
  startedAtMs: 101, updatedAtMs: 110, completedAtMs: 110,
  producerPid: 7, childPid: null, identity: `v1-${'d'.repeat(64)}`,
  token: `v2:${'e'.repeat(64)}`, reused: true,
};

let org: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
});
afterAll(async () => { await org?.cleanup(); });
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.routines WHERE id = 'rt-prebuild-ready-schedule'`;
});

async function seed(options: {
  workspaceId?: string; installSlug?: string; role?: string; active?: boolean;
  phase?: string; candidate?: string; runner?: object | null;
  pause?: object; repairHead?: string; scheduledAt?: Date | null;
} = {}): Promise<{ scheduledAt: Date | null; metadata: Record<string, unknown> }> {
  const scheduledAt = options.scheduledAt === undefined ? new Date(Date.now() + 3_600_000) : options.scheduledAt;
  const metadata = {
    [CHECKPOINT_QUALIFICATION_METADATA_KEY]: {
      attemptId: 'checkpoint-attempt', candidate: options.candidate ?? candidate,
      phase: options.phase ?? 'waiting', currentPhysicalRunner: options.runner ?? null,
    },
    ...(options.pause ? { pause: options.pause } : {}),
    ...(options.repairHead ? { repair_queue: { repairHead: options.repairHead } } : {}),
  };
  await sql`
    INSERT INTO harness_shared.routines
      (id, install_slug, name, trigger_kind, trigger_config, target_role, active, workspace_id, metadata, next_fire_at)
    VALUES ('rt-prebuild-ready-schedule', ${options.installSlug ?? target.installSlug}, 'green-checkpoint',
      'cron', '{}'::jsonb, ${options.role ?? 'system:green-checkpoint'}, ${options.active ?? true},
      ${options.workspaceId ?? target.workspaceId}, ${JSON.stringify(metadata)}::text::jsonb, ${scheduledAt})
  `;
  return { scheduledAt, metadata };
}

async function readSchedule() {
  const [row] = await sql<{ next_fire_at: Date | null; metadata: Record<string, unknown>; delay_ms: number | null }[]>`
    SELECT next_fire_at, metadata, EXTRACT(EPOCH FROM (next_fire_at - now())) * 1000 AS delay_ms
      FROM harness_shared.routines WHERE id = 'rt-prebuild-ready-schedule'
  `;
  return row!;
}

describe('dependency prebuild readiness scheduling (real Postgres)', () => {
  it.each(['waiting', 'ready'])('pulls the matching idle %s attempt forward without changing its identity or metadata', async (phase) => {
    const original = await seed({ phase });
    const emit = vi.fn(async () => ({}));
    await emitDependencyPrebuildTerminal(target, ready, { sql, emit: emit as never });
    const row = await readSchedule();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(Number(row.delay_ms)).toBeGreaterThan(0);
    expect(Number(row.delay_ms)).toBeLessThanOrEqual(60_000);
    expect(row.next_fire_at!.getTime()).toBeLessThan(original.scheduledAt!.getTime());
    expect(row.metadata).toEqual(original.metadata);
  });

  it('schedules the same idle attempt for its exact admitted repair head', async () => {
    const original = await seed({ candidate: successor, repairHead: candidate });
    await emitDependencyPrebuildTerminal(target, ready, { sql, emit: async () => ({}) as never });
    const row = await readSchedule();
    expect(Number(row.delay_ms)).toBeGreaterThan(0);
    expect(Number(row.delay_ms)).toBeLessThanOrEqual(60_000);
    expect(row.metadata).toEqual(original.metadata);
  });

  it.each([
    { name: 'successor candidate', candidate: successor },
    { name: 'paused attempt', pause: { reason: 'intentional hold' } },
    { name: 'inactive routine', active: false },
    { name: 'live runner reservation', runner: { runnerId: 'incumbent', runId: 'run-1' } },
    { name: 'running attempt', phase: 'running' },
    { name: 'terminal attempt', phase: 'terminal' },
    { name: 'another workspace', workspaceId: 'ws-prebuild-other' },
    { name: 'another install', installSlug: 'other-install' },
    { name: 'another routine role', role: 'system:git-sync' },
  ])('preserves the schedule and metadata for $name', async ({ name: _name, ...options }) => {
    const original = await seed(options);
    await emitDependencyPrebuildTerminal(target, ready, { sql, emit: async () => ({}) as never });
    const row = await readSchedule();
    expect(row.next_fire_at).toEqual(original.scheduledAt);
    expect(row.metadata).toEqual(original.metadata);
  });

  it('retains an earlier scheduled fire instead of postponing it', async () => {
    const original = await seed({ scheduledAt: new Date(Date.now() + 20_000) });
    await emitDependencyPrebuildTerminal(target, ready, { sql, emit: async () => ({}) as never });
    expect((await readSchedule()).next_fire_at).toEqual(original.scheduledAt);
  });

  it('schedules the persisted ready prerequisite even when event delivery fails', async () => {
    await seed({ scheduledAt: null });
    const emit = vi.fn(async () => { throw new Error('delivery unavailable'); });
    await expect(emitDependencyPrebuildTerminal(target, ready, { sql, emit: emit as never }))
      .rejects.toThrow('delivery unavailable');
    // Promise.all can reject before the independent SQL query finishes. Wait for that
    // observable write rather than turning notification timing into a false failure.
    await expect.poll(async () => (await readSchedule()).next_fire_at, { timeout: 2_000 }).not.toBeNull();
    const row = await readSchedule();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(Number(row.delay_ms)).toBeGreaterThan(0);
    expect(Number(row.delay_ms)).toBeLessThanOrEqual(60_000);
  });

  it('leaves a failed prerequisite asleep without manufacturing a ready transition', async () => {
    const original = await seed();
    await emitDependencyPrebuildTerminal(target, {
      ...ready, status: 'failed', error: 'publisher failed',
    }, { sql, emit: async () => ({}) as never });
    const row = await readSchedule();
    expect(row.next_fire_at).toEqual(original.scheduledAt);
    expect(row.metadata).toEqual(original.metadata);
  });
});
