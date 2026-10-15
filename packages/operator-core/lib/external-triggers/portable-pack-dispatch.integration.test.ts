/**
 * R-9 (generalized-integrations-google-migration-cupboard-workflows-2026-10-05
 * P-012, D-013): materialized trigger-pack bindings execute through the
 * EXISTING binding engine and target executors — the same trigger_runs outbox,
 * storm cap and dispatcher as every other binding. There is no pack dispatcher:
 * an edge is one more ingested event on the internal `trigger-pack-edge`
 * source. Unsupported target, edge and source kinds are refused at install.
 *
 * Drives ingestion → binding sink → dispatchPendingTriggerRuns → launch-plan
 * against a migrated throwaway Postgres, with an Outlook-shaped fixture source.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  fakeRegistry,
  FOLLOW_SLUG,
  PACK_GITHUB_URL,
  PLUGIN,
  portablePackManifest,
  REPLY_SLUG,
  seedPackWorkspace,
  writePackDir,
} from '../../test/_trigger-pack-fixtures';
import { installPluginFromCupboardCore, type InstallPluginCoreDeps, InstallPluginError } from '../cupboard/install-plugin-core';
import { materializeTriggerPack, type TriggerPackInstallation } from '../cupboard/trigger-pack-materialize';
import { createExternalTriggerSource } from './admin';
import { dispatchPendingTriggerRuns } from './binding-engine';
import { ingestExternalTriggerEvent } from './ingestion';

const h = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: Sql) => Promise<T>) => fn(h.sql),
  };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const BASE_WS = 'portable-pack-dispatch-e2e';
let WS = BASE_WS;
let workspaceSeq = 0;
const HARNESS = 'pack-home';

let org: OrgTestDb;
let sql: Sql;
let scratch: string;
let packDir: string;

const emit = vi.fn(async () => ({
  ok: true as const,
  key: 'ext:outlook-fixture:message.received',
  woken: 0,
  notified: [],
  msgId: null,
  waiters: 0,
}));

interface RunRow {
  id: string;
  bindingId: string;
  status: string;
  error: string | null;
  planRunRef: string | null;
  args: { trigger?: { payload?: Record<string, unknown> } } & Record<string, unknown>;
  outcome: Record<string, unknown>;
}

async function runs(bindingId?: string): Promise<RunRow[]> {
  return sql<RunRow[]>`
    SELECT id::text AS id, binding_id::text AS "bindingId", status, error,
           plan_run_ref AS "planRunRef", args, outcome
      FROM harness_shared.trigger_runs
     WHERE workspace_id = ${WS}
       AND (${bindingId ?? null}::uuid IS NULL OR binding_id = ${bindingId ?? null}::uuid)
     ORDER BY triggered_at, id`;
}

async function installPack(): Promise<{ installation: TriggerPackInstallation; sourceId: string; inbound: string; edge: string }> {
  const outlook = await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
  const installation = await materializeTriggerPack(
    sql,
    WS,
    { manifest: portablePackManifest() as never, pluginDir: packDir, harnessSlug: HARNESS, inputs: { tone: 'warm' } },
    { registry: fakeRegistry },
  );
  expect(installation.status).toBe('configured');
  return {
    installation,
    sourceId: outlook.id,
    inbound: installation.resources.bindings['inbound-mail']!.triggerBindingId,
    edge: installation.resources.bindings['after-reply']!.triggerBindingId,
  };
}

async function arm(installationId: string): Promise<void> {
  await sql`
    UPDATE harness_shared.trigger_bindings SET armed = TRUE
     WHERE workspace_id = ${WS} AND pack_installation_id = ${installationId}::uuid`;
}

/** One Outlook-shaped (Graph message) event from the fixture source. */
async function ingestMail(
  sourceId: string,
  id: string,
  options: { datatypeId?: string; direction?: string } = {},
) {
  const datatypeId = options.datatypeId ?? 'email-message';
  const payload = {
    id,
    conversationId: `conversation-${id}`,
    from: 'Ada <ada@example.com>',
    subject: `Hello ${id}`,
    internetMessageId: `<${id}@example.com>`,
    direction: options.direction ?? 'inbound',
  };
  return ingestExternalTriggerEvent(
    sql,
    {
      workspaceId: WS,
      sourceId,
      source: 'outlook-fixture',
      event: 'message.received',
      externalId: id,
      datatypeId,
      adapterPayload: payload,
      normalize: () => payload,
      dedupeKey: `outlook-fixture:${datatypeId}:${id}`,
    },
    { emit },
  );
}

const dispatchDeps = { announceRunWork: async () => undefined };

function installDeps(dir: string): InstallPluginCoreDeps {
  return {
    cloneRepo: async (_url, dest) => {
      await fs.cp(dir, dest, { recursive: true });
    },
    globalPluginsDir: () => join(scratch, 'global-plugins'),
    tmpDir: () => join(scratch, 'tmp'),
    grant: async () => undefined,
    invalidateHost: async () => undefined,
    materializeTriggerPack: (args) => materializeTriggerPack(sql, WS, args, { registry: fakeRegistry }),
  };
}

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
}, 120_000);

afterAll(async () => {
  await org?.cleanup();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  // The dispatcher claims pending runs across every workspace, so an earlier
  // test's undispatched runs must not leak into this test's dispatch counts.
  await sql`DELETE FROM harness_shared.trigger_runs WHERE status = 'pending'`;
  WS = `${BASE_WS}-${++workspaceSeq}`;
  await seedPackWorkspace(sql, WS, HARNESS, ['email-message', 'calendar-event']);
  scratch = await fs.mkdtemp(join(tmpdir(), 'portable-pack-dispatch-'));
  await fs.mkdir(join(scratch, 'tmp'), { recursive: true });
  packDir = join(scratch, 'pack');
  await writePackDir(packDir, portablePackManifest());
  emit.mockClear();
});

describe('portable trigger-pack dispatch (R-9)', () => {
  it('runs the external binding and its edge through the binding engine with inherited correlation', async () => {
    const { installation, sourceId, inbound, edge } = await installPack();

    // Materialized bindings start disarmed: an event queues nothing.
    await expect(ingestMail(sourceId, 'msg-before-arm')).resolves.toMatchObject({ ok: true });
    expect(await runs()).toEqual([]);

    await arm(installation.id);
    await expect(ingestMail(sourceId, 'msg-1')).resolves.toMatchObject({ ok: true });
    const [queued] = await runs(inbound);
    expect(queued).toMatchObject({ status: 'pending' });
    expect(queued!.args.trigger?.payload).toMatchObject({ id: 'msg-1', direction: 'inbound' });

    // The engine's own dispatcher launches the reply plan with the pack's input overlay.
    const first = await dispatchPendingTriggerRuns(sql, dispatchDeps);
    expect(first, (await runs(inbound))[0]?.error ?? 'dispatch failed without an error').toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    const [upstream] = await runs(inbound);
    expect(upstream).toMatchObject({ status: 'succeeded', error: null });
    expect(upstream!.planRunRef).toBeTruthy();
    expect(upstream!.outcome).not.toHaveProperty('triggerPackEdgeError');
    const [replyRun] = await sql<Array<{ planSlug: string; harnessSlug: string; inputs: Record<string, unknown> }>>`
      SELECT plan_slug AS "planSlug", harness_slug AS "harnessSlug", inputs
        FROM harness_shared.plan_runs
       WHERE workspace_id = ${WS} AND id = ${Number(upstream!.planRunRef)}`;
    expect(replyRun).toMatchObject({ planSlug: REPLY_SLUG, harnessSlug: HARNESS, inputs: { tone: 'warm' } });

    // Success emitted ONE edge event through ordinary ingestion, queued on the edge binding.
    const [edgeRun] = await runs(edge);
    expect(edgeRun).toMatchObject({ status: 'pending' });
    expect(edgeRun!.args.trigger?.payload).toMatchObject({
      upstreamBindingId: inbound,
      upstreamTriggerRunId: upstream!.id,
      correlationId: upstream!.id,
      packInstallationId: installation.id,
      actionType: 'launch-plan',
      planRunId: Number(upstream!.planRunRef),
    });

    const second = await dispatchPendingTriggerRuns(sql, dispatchDeps);
    expect(second, (await runs(edge))[0]?.error ?? 'edge dispatch failed without an error').toMatchObject({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    const [edgeDone] = await runs(edge);
    expect(edgeDone).toMatchObject({ status: 'succeeded', error: null });
    const [followRun] = await sql<Array<{ planSlug: string; inputs: Record<string, unknown> }>>`
      SELECT plan_slug AS "planSlug", inputs FROM harness_shared.plan_runs
       WHERE workspace_id = ${WS} AND id = ${Number(edgeDone!.planRunRef)}`;
    expect(followRun).toMatchObject({ planSlug: FOLLOW_SLUG, inputs: { tone: 'warm' } });

    // The chain terminates: nothing listens on the edge binding's completion.
    await expect(dispatchPendingTriggerRuns(sql, dispatchDeps)).resolves.toMatchObject({ claimed: 0 });
    expect(await runs()).toHaveLength(2);
  });

  it('matches on datatype and payload filter, so mismatched events queue nothing', async () => {
    const { installation, sourceId, inbound } = await installPack();
    await arm(installation.id);

    // Same source, same event name, a different datatype: not this binding's input.
    await expect(ingestMail(sourceId, 'cal-1', { datatypeId: 'calendar-event' })).resolves.toMatchObject({ ok: true });
    // Right datatype, filtered out by the pack's `direction: inbound` matcher.
    await expect(ingestMail(sourceId, 'sent-1', { direction: 'outbound' })).resolves.toMatchObject({ ok: true });
    expect(await runs()).toEqual([]);

    await expect(ingestMail(sourceId, 'msg-1')).resolves.toMatchObject({ ok: true });
    expect((await runs(inbound)).map((run) => run.status)).toEqual(['pending']);
  });

  it('applies the engine storm cap to pack bindings', async () => {
    const { installation, sourceId, inbound } = await installPack();
    await arm(installation.id);

    for (const id of ['msg-1', 'msg-2', 'msg-3']) {
      await expect(ingestMail(sourceId, id)).resolves.toMatchObject({ ok: true });
    }
    const queued = await runs(inbound);
    expect(queued.map((run) => run.status)).toEqual(['pending', 'pending', 'skipped']);
    expect(queued[2]!.error).toMatch(/^external_trigger_storm_limit:2\/3600s/);
  });

  it('refuses unsupported target, edge and source kinds at install, writing nothing', async () => {
    await createExternalTriggerSource(sql, WS, { kind: 'outlook-fixture', status: 'connected' });
    const base = portablePackManifest();
    const pack = base.triggerPack;
    const variants: Array<{ name: string; triggerPack: Record<string, unknown>; expected: Record<string, unknown> }> = [
      {
        name: 'recipe target',
        triggerPack: {
          ...pack,
          targets: [...pack.targets, { id: 'tool-call', kind: 'recipe', ref: 'recipe:demo', argsSchema: { type: 'object' } }],
          bindings: [
            ...pack.bindings,
            {
              id: 'mail-to-tool',
              source: { kind: 'external', datatype: 'email-message' },
              target: 'tool-call',
              eventPattern: 'ext:*:message.received',
              mapping: { mode: 'type-match' },
              retry: { maxAttempts: 1, onExhausted: 'dead-letter' },
            },
          ],
        },
        expected: { status: 422, code: 'trigger_pack_unsupported_target:recipe' },
      },
      {
        name: 'plan-completed edge',
        triggerPack: {
          ...pack,
          bindings: [
            pack.bindings[0],
            { id: 'after-reply', source: { kind: 'internal', event: 'plan-completed' }, target: 'follow-up' },
          ],
          edges: [{ from: 'inbound-mail', to: 'after-reply', event: 'plan-completed', correlation: 'inherit' }],
        },
        expected: { status: 422, code: 'trigger_pack_unsupported_edge:plan-completed' },
      },
      {
        name: 'edge from a manual binding',
        triggerPack: {
          ...pack,
          edges: [{ from: 'manual-follow-up', to: 'after-reply', event: 'binding-run-completed', correlation: 'inherit' }],
        },
        expected: { status: 422, code: 'trigger_pack_unsupported_edge:manual-upstream' },
      },
      {
        name: 'schedule source',
        triggerPack: {
          ...pack,
          bindings: [...pack.bindings, { id: 'cadence', source: { kind: 'schedule', scheduleRef: 'daily' }, target: 'reply' }],
        },
        expected: { status: 422, message: expect.stringContaining('source kind "schedule"') },
      },
    ];

    for (const variant of variants) {
      const dir = join(scratch, variant.name.replace(/\W+/g, '-'));
      await writePackDir(dir, { ...base, triggerPack: variant.triggerPack });
      const refusal = await installPluginFromCupboardCore(
        { githubUrl: PACK_GITHUB_URL, harness: HARNESS, triggerPackConfig: { inputs: { tone: 'warm' } } },
        installDeps(dir),
      ).catch((error: unknown) => error);
      expect(refusal, variant.name).toBeInstanceOf(InstallPluginError);
      expect(refusal, variant.name).toMatchObject(variant.expected);
    }

    const [counts] = await sql<Array<{ installations: number; plans: number; bindings: number }>>`
      SELECT (SELECT count(*)::int FROM harness_shared.trigger_pack_installations WHERE workspace_id = ${WS}) AS installations,
             (SELECT count(*)::int FROM harness_shared.harness_plans WHERE workspace_id = ${WS}) AS plans,
             (SELECT count(*)::int FROM harness_shared.trigger_bindings WHERE workspace_id = ${WS}) AS bindings`;
    expect(counts).toEqual({ installations: 0, plans: 0, bindings: 0 });
    await expect(fs.stat(join(scratch, 'global-plugins', PLUGIN))).rejects.toThrow();
  });
});
