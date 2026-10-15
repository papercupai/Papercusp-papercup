// @vitest-environment node
/**
 * P-015 / R-4 integration layer for the live identity-stack mutation path.
 *
 * `mutateIdentityStack` is the writer behind the Settings → Identities switch and
 * rollback controls. This file drives it against a REAL Postgres and keeps the
 * whole write path real:
 *
 *   - the read of the newest `adv_sessions` launch record,
 *   - the compare-and-swap UPDATE of `launch_spec` (the concurrency guard),
 *   - `identityHistory` construction (the rollback source),
 *   - `requestSessionIdentityActivationInTransaction` — the control-anchor
 *     rebuild, the `session_briefs` upsert and the `desired` row in
 *     `session_identity_activation_events` (migrations 1149 + 1177), all inside
 *     the SAME transaction as the CAS.
 *
 * Mocked, and why:
 *   - `rebuildSuLaunchArtifact` — renders the full su prompt (plan context, mode
 *     runtime, overlays). A deterministic artifact per stack keeps revisions
 *     assertable; the render itself is covered by su-persona-render tests and the
 *     R-4 real-backend e2e.
 *   - `getIdentitySource` / `resolveProjectDir` — identity files on disk.
 *   - `findLiveHostAsync` — controlled PTY discovery; absent hosts report not-queued.
 *   - the peripheral control-anchor READ legs (modes, loop, fleet membership,
 *     goal authority, self-wake) and the Orders SSE push — each is its own
 *     module with its own tests; they contribute no rows this path writes.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyMigrationForTest,
  applyPlanItemClaimMigrations,
  createFreshPgDb,
  type FreshPgDb,
} from '../test/_pg-helpers';

const h = vi.hoisted(() => {
  /** 64-hex deterministic digest (FNV-1a lanes) — hoisted mock factories cannot reach imports. */
  const hex64 = (text: string): string => {
    let out = '';
    for (let lane = 0; lane < 8; lane += 1) {
      let hash = (0x811c9dc5 ^ lane) >>> 0;
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      out += hash.toString(16).padStart(8, '0');
    }
    return out;
  };
  /** Deterministic stand-in for the rendered artifact: one revision per stack. */
  const artifactFor = (stack: readonly string[]) => {
    const specificationRevision = hex64(JSON.stringify(stack));
    const stateRevision = specificationRevision.slice(0, 24);
    return {
      stack: [...stack],
      specificationRevision,
      stateRevision,
      resourceArtifacts: [],
      // The ResolvedAgentSpecification fields the explain/diff path reads.
      specificationArtifact: {
        specificationRevision,
        configuration: { stack: [...stack] },
        inputs: stack.map((ref) => ({ kind: 'identity-layer', ref })),
        provenance: stack.map((ref, index) => ({ path: `configuration.stack[${index}]`, sourceRef: ref })),
      },
    };
  };
  return {
    sql: null as unknown as import('postgres').Sql,
    artifactFor,
    /** Runs inside rebuildSuLaunchArtifact — i.e. between the launch-record read and the CAS. */
    duringRebuild: null as null | (() => Promise<void>),
    goalAuthorityFailure: null as null | Error,
    tagFailure: null as null | Error,
    liveHost: null as null | { ownerId: string; pid: number; sock: string },
    hostLookups: [] as string[],
    injected: [] as Array<{ sock: string; msg: unknown }>,
  };
});

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

vi.mock('./agent-identities/source', () => ({
  listIdentitySources: vi.fn(async () => ({ ok: true, identities: [], unreadable: [], count: 0, scanned: 0, nextAfter: null })),
  getIdentitySource: vi.fn(async (id: string) => ({ ok: true, identity: { id, slots: [{ slot: 'domain' }] } })),
  // The control-anchor refresh reads the selected mode catalog; getModes is mocked to [] below, so no
  // mode ever resolves against it and an empty snapshot is exact.
  getSelectedModeCatalog: vi.fn(async () => ({ revision: 'test-empty-mode-catalog', entries: [] })),
  // role-launch-spec's selected-composition path destructures these; no named root is selected here
  // and the fallback resolver needs no local blueprint directories.
  localDirs: vi.fn(() => []),
  resolveNamedIdentityCompositionSelection: vi.fn(async () => null),
}));

vi.mock('./spawn-config', () => ({ resolveProjectDir: vi.fn(async () => null) }));

vi.mock('./events/await/psu-pty-discovery', () => ({
  findLiveHostAsync: vi.fn(async (ownerId: string) => {
    h.hostLookups.push(ownerId);
    return h.liveHost;
  }),
  injectIntoHost: vi.fn(async (sock: string, msg: unknown) => {
    h.injected.push({ sock, msg });
    return false;
  }),
}));

vi.mock('./turn-provenance/turn-provenance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./turn-provenance/turn-provenance')>();
  return {
    ...actual,
    tagTurnForInjection: vi.fn(async (args: Parameters<typeof actual.tagTurnForInjection>[0]) => {
      if (h.tagFailure) throw h.tagFailure;
      return actual.tagTurnForInjection(args);
    }),
  };
});

vi.mock('./su-persona-render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./su-persona-render')>();
  return {
    ...actual,
    rebuildSuLaunchArtifact: vi.fn(async (input: { stack?: readonly string[] }) => {
      if (h.duringRebuild) await h.duringRebuild();
      return { artifact: h.artifactFor([...(input.stack ?? [])]) };
    }),
  };
});

vi.mock('./modes/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./modes/store')>()),
  getModes: vi.fn(async () => []),
}));
vi.mock('./harness/routines/loop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./harness/routines/loop')>()),
  getLoopStatus: vi.fn(async () => null),
}));
vi.mock('./fleet-membership-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./fleet-membership-store')>()),
  latestFleetMembership: vi.fn(async () => null),
}));
vi.mock('./goals/holder-authority', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./goals/holder-authority')>()),
  readGoalHolderAuthority: vi.fn(async () => {
    if (h.goalAuthorityFailure) throw h.goalAuthorityFailure;
    return { status: 'none', goalId: null, electedOwnerId: null, electedEpoch: null, handoffExpiresAt: null };
  }),
}));
vi.mock('./agent-tools/coordination/presence-selfwake', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-tools/coordination/presence-selfwake')>()),
  fetchSelfWake: vi.fn(async () => new Map()),
}));
vi.mock('./agent-orders-notify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-orders-notify')>()),
  notifyAgentOrdersChanged: vi.fn(async () => {}),
}));

import { restoreRawJsonbSerializer } from '@papercusp/db-org';
import { mutateIdentityStack as mutateCurrentIdentityStack } from './identity-management';
import { buildControlAnchorState, refreshControlAnchorAfterMutation } from './agent-tools/coordination/control-anchor';

// Reuse the standard copy-out probe without mutating the shared identity writer.
const mutateIdentityStack: typeof mutateCurrentIdentityStack = process.env.PAPERCUSP_MUTATION_PROBE_SOURCE
  ? (await import(pathToFileURL(process.env.PAPERCUSP_MUTATION_PROBE_SOURCE).href)).mutateIdentityStack
  : mutateCurrentIdentityStack;

const artifactFor = h.artifactFor;

const here = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(here, '../../../libs/papercusp/libs/db/sql');
const WS = 'identity-mutation-integration';
const ENGINEER = ['domain:papercusp-engineer'];
const WRITER = ['domain:writer'];

let db: FreshPgDb;
let nextSessionId = 1;

beforeAll(async () => {
  db = await createFreshPgDb('identity-mutation');
  // Mirror the canonical getOrgPg client (libs/db connection.ts): the CAS binds
  // `${JSON.stringify(record)}::jsonb`, which only round-trips under the raw
  // jsonb serializer. A bare client double-encodes it into a jsonb STRING and
  // the guard then refuses every write as "changed concurrently".
  restoreRawJsonbSerializer(db.sql);
  h.sql = db.sql;
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY,
      workspace_id text NOT NULL,
      mode text NOT NULL,
      coord_owner_id text,
      session_id text,
      launch_spec jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      ended_by text
    );
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY,
      workspace_id text NOT NULL,
      native_session_id text,
      current_plan_slug text,
      harness_slug text,
      source text,
      control_generation bigint NOT NULL DEFAULT 0,
      control_delivered_generation bigint NOT NULL DEFAULT 0,
      control_state jsonb,
      control_updated_at timestamptz,
      control_transition jsonb
    );
    CREATE TABLE harness_shared.tool_invocations (
      id bigint PRIMARY KEY, workspace_id text NOT NULL,
      coord_owner_id text, invoked_at timestamptz NOT NULL
    );
    CREATE TABLE harness_shared.agent_usage_samples (
      id bigint PRIMARY KEY, workspace_id text NOT NULL,
      session_id text, ts bigint NOT NULL
    );
    CREATE TABLE harness_shared.session_archives (
      adv_session_id bigint, session_id text NOT NULL
    );
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL, source_kind text NOT NULL,
      session_id text NOT NULL, owner text
    );
  `);
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '1149-session-identity-activation-spans.sql'));
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '1177-identity-usage-carry-correlation.sql'));
  // The activation recorder stamps specification_layer_refs (WI-10004494 gap 3).
  await applyMigrationForTest(db.sql, resolve(SQL_DIR, '1295-activation-event-specification-layer-refs.sql'));
  await applyPlanItemClaimMigrations(db.sql);
}, 120_000);

afterAll(async () => db?.cleanup(), 300_000);

beforeEach(() => {
  h.duringRebuild = null;
  h.goalAuthorityFailure = null;
  h.tagFailure = null;
  h.liveHost = null;
  h.hostLookups = [];
  h.injected = [];
});

/** Seed one live session running `stack`, with that revision already APPLIED. */
async function seedSession(owner: string, stack: readonly string[],
  selectedIdentity?: { ref: string; sourceRevision: string }) {
  const current = artifactFor(stack);
  const record = {
    v: 1,
    agent: 'claude',
    workspaceId: WS,
    harnessSlug: null,
    contextSize: 'trimmed',
    stack: current.stack,
    ...(selectedIdentity ? { selectedIdentity } : {}),
    specificationRevision: current.specificationRevision,
    stateRevision: current.stateRevision,
    specificationArtifact: current.specificationArtifact,
  };
  const revision = { specificationRevision: current.specificationRevision, stateRevision: current.stateRevision };
  const activation = {
    schemaVersion: 1,
    attribution: { actorId: owner, principalId: owner, sessionId: owner },
    desired: revision,
    prepared: revision,
    applied: revision,
    status: 'applied',
  };
  const id = nextSessionId++;
  await db.sql`
    INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode, coord_owner_id, session_id, launch_spec)
    VALUES (${id}, ${WS}, 'console', ${owner}, ${`native-${owner}`}, ${JSON.stringify(record)}::text::jsonb)`;
  await db.sql`
    INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, native_session_id, control_generation, control_state)
    VALUES (${owner}, ${WS}, ${`native-${owner}`}, 3,
            ${JSON.stringify({ activation, stack: current.stack, modes: [] })}::text::jsonb)`;
  return { id, revision };
}

async function launchSpec(owner: string) {
  const [row] = await db.sql<Array<{ launch_spec: Record<string, unknown> }>>`
    SELECT launch_spec FROM harness_shared.adv_sessions WHERE workspace_id = ${WS} AND coord_owner_id = ${owner}`;
  return row!.launch_spec as {
    stack: string[];
    selectedIdentity?: { ref: string; sourceRevision: string } | null;
    specificationRevision: string;
    stateRevision: string;
    identityHistory?: Array<{ stack: string[]; selectedIdentity?: { ref: string; sourceRevision: string } | null;
      specificationRevision: string; stateRevision: string }>;
  };
}

async function brief(owner: string) {
  const [row] = await db.sql<Array<{ control_generation: number; control_state: Record<string, any> }>>`
    SELECT control_generation, control_state FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
  return row!;
}

async function activationEvents(owner: string) {
  return db.sql<Array<{ phase: string; source: string; specification_revision: string; stack_refs: string[] }>>`
    SELECT phase, source, specification_revision, stack_refs
      FROM harness_shared.session_identity_activation_events
     WHERE workspace_id = ${WS} AND owner_id = ${owner}
     ORDER BY id`;
}

const mutate = (owner: string, action: 'switch' | 'rollback', identityId?: string) =>
  mutateIdentityStack({
    workspaceId: WS,
    ownerId: owner,
    action,
    identityId: identityId ?? null,
    slot: identityId ? 'domain' : null,
    operatorBaseUrl: 'http://127.0.0.1:0',
    modeSection: '',
  });

describe('mutateIdentityStack against real Postgres (R-4 integration layer)', () => {
  async function superseded(owner: string, ended: boolean, stack: readonly string[]) {
    const old = await seedSession(owner, ENGINEER);
    const original = await launchSpec(owner);
    const id = nextSessionId++;
    const successor = { ...original, ...artifactFor(stack) };
    await db.sql`
      INSERT INTO harness_shared.adv_sessions (id, workspace_id, mode, coord_owner_id, session_id, launch_spec, started_at, ended_at)
      VALUES (${id}, ${WS}, 'console', ${owner}, ${`native-${owner}-successor`},
              ${JSON.stringify(successor)}::text::jsonb, now() - interval '1 hour', ${ended ? new Date() : null})`;
    await db.sql`UPDATE harness_shared.adv_sessions SET started_at = now() + interval '1 hour' WHERE id = ${old.id}`;
    return { oldId: old.id, id, original, successor };
  }

  it.each([false, true])('mutates the current registration after predecessor activity (successor ended=%s)', async (ended) => {
    const owner = `su-identity-registration-${ended}`;
    const seeded = await superseded(owner, ended, WRITER);
    await mutate(owner, 'switch', 'other-domain');
    const rows = await db.sql<Array<{ id: number; launch_spec: typeof seeded.original }>>`
      SELECT id, launch_spec FROM harness_shared.adv_sessions WHERE coord_owner_id = ${owner} ORDER BY id`;
    expect(rows[0].launch_spec).toEqual(seeded.original);
    expect(rows[1].launch_spec.stack).toEqual(['domain:other-domain']);
    expect(rows[1].launch_spec.identityHistory?.[0]?.stack).toEqual(WRITER);
    const events = await db.sql<Array<{ adv_session_id: number; native_session_id: string }>>`
      SELECT adv_session_id, native_session_id FROM harness_shared.session_identity_activation_events
      WHERE owner_id = ${owner}`;
    expect(events).toHaveLength(1);
    expect(Number(events[0].adv_session_id)).toBe(seeded.id);
    expect(events[0].native_session_id).toBe(`native-${owner}-successor`);
  });

  it.each([false, true])('builds control from the current registration stack (successor ended=%s)', async (ended) => {
    const owner = `su-control-stack-registration-${ended}`;
    await superseded(owner, ended, WRITER);
    const state = await buildControlAnchorState(owner, WS, { sql: db.sql });
    expect(state.stack).toEqual(WRITER);
  });

  it.each([false, true])('carries a control activation receipt only on the current registration (successor ended=%s)', async (ended) => {
    const owner = `su-control-receipt-registration-${ended}`;
    const seeded = await superseded(owner, ended, ENGINEER);
    const anchor = await refreshControlAnchorAfterMutation({ ownerId: owner, workspaceId: WS,
      actorId: owner, origin: 'agent', source: 'mode:set', sql: db.sql });
    expect(anchor?.state.activation?.status).toBe('desired');
    const rows = await db.sql<Array<{ id: number; launch_spec: typeof seeded.original }>>`
      SELECT id, launch_spec FROM harness_shared.adv_sessions WHERE coord_owner_id = ${owner} ORDER BY id`;
    expect(rows[0].launch_spec).toEqual(seeded.original);
    expect(rows[1].launch_spec.identityHistory?.[0]).toMatchObject(anchor!.state.activation!.desired);
    const events = await db.sql<Array<{ adv_session_id: number }>>`
      SELECT adv_session_id FROM harness_shared.session_identity_activation_events WHERE owner_id = ${owner}`;
    expect(events).toHaveLength(1);
    expect(Number(events[0].adv_session_id)).toBe(seeded.id);
  });

  it('does not inject raw identity text when turn-provenance tagging throws', async () => {
    const owner = 'su-identity-nudge-tag-error';
    await seedSession(owner, ENGINEER);
    h.liveHost = { ownerId: owner, pid: 7, sock: '/run/test-identity-nudge.sock' };
    h.tagFailure = new Error('synthetic tagger failure');

    const result = await mutate(owner, 'switch', 'writer');

    expect(result.ok).toBe(true);
    expect(result.nudge).toMatchObject({
      queued: false,
      reason: expect.stringContaining('turn-provenance tagging failed'),
    });
    expect(h.hostLookups).toEqual([owner]);
    expect(h.injected).toEqual([]);
  });

  it('clears a named root on explicit switch and restores its exact pin on rollback', async () => {
    const owner = 'su-p006-named-selection';
    const selectedIdentity = { ref: 'composition:review-suite', sourceRevision: 'a'.repeat(64) };
    await seedSession(owner, WRITER, selectedIdentity);
    await mutate(owner, 'switch', 'other-domain');
    const switched = await launchSpec(owner);
    expect(switched.selectedIdentity).toBeNull();
    expect(switched.identityHistory?.[0]?.selectedIdentity).toEqual(selectedIdentity);
    await mutate(owner, 'rollback');
    const restored = await launchSpec(owner);
    expect(restored.stack).toEqual(WRITER);
    expect(restored.selectedIdentity).toEqual(selectedIdentity);
  });

  it('switch persists the new stack, receipts the prior artifact, and requests (not applies) the new revision in one transaction', async () => {
    const owner = 'su-identity-switch';
    const { revision: engineer } = await seedSession(owner, ENGINEER);
    const writer = artifactFor(WRITER);

    const result = await mutate(owner, 'switch', 'writer');

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      action: 'switch',
      delivery: 'relaunch-with-carry',
      stack: WRITER,
      replaced: 'papercusp-engineer',
      specificationRevision: writer.specificationRevision,
    });
    // No live host in this process: the nudge must SAY it was not delivered.
    expect(result.nudge.queued).toBe(false);
    expect(result.nudge.reason).toMatch(/not currently reachable/);
    expect(h.hostLookups).toEqual([owner]);

    const spec = await launchSpec(owner);
    expect(spec.stack).toEqual(WRITER);
    expect(spec.specificationRevision).toBe(writer.specificationRevision);
    expect(spec.identityHistory?.[0]).toMatchObject({
      stack: ENGINEER,
      specificationRevision: engineer.specificationRevision,
      stateRevision: engineer.stateRevision,
    });

    const after = await brief(owner);
    expect(Number(after.control_generation)).toBe(4);
    const activation = after.control_state.activation;
    expect(activation.desired).toEqual({
      specificationRevision: writer.specificationRevision,
      stateRevision: writer.stateRevision,
    });
    // The switch is a REQUEST: the prior revision stays applied until the host acknowledges.
    expect(activation.applied).toEqual(engineer);
    expect(activation.status).toBe('desired');
    // The anchor's explicit stack was read inside the same transaction, after the CAS.
    expect(after.control_state.stack).toContain('domain:writer');
    expect(result.activation?.desired?.specificationRevision).toBe(writer.specificationRevision);

    const events = await activationEvents(owner);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: 'desired',
      source: 'restart',
      specification_revision: writer.specificationRevision,
    });
    expect(events[0]!.stack_refs).toContain('domain:writer');
  }, 60_000);

  it('refuses a switch when the launch record changed after it was read, and writes nothing', async () => {
    const owner = 'su-identity-race';
    const { id } = await seedSession(owner, ENGINEER);
    const beforeBrief = await brief(owner);
    // A concurrent writer rewrites the record between our read and our CAS.
    const concurrent = { ...(await launchSpec(owner)), stack: ['domain:concurrent-peer'] };
    h.duringRebuild = async () => {
      h.duringRebuild = null;
      await db.sql`UPDATE harness_shared.adv_sessions SET launch_spec = ${JSON.stringify(concurrent)}::text::jsonb WHERE id = ${id}`;
    };

    await expect(mutate(owner, 'switch', 'writer')).rejects.toThrow(/changed concurrently/);

    expect((await launchSpec(owner)).stack).toEqual(['domain:concurrent-peer']);
    const afterBrief = await brief(owner);
    expect(Number(afterBrief.control_generation)).toBe(Number(beforeBrief.control_generation));
    expect(afterBrief.control_state).toEqual(beforeBrief.control_state);
    expect(await activationEvents(owner)).toHaveLength(0);
  }, 60_000);

  it('rollback restores the prior stack from identityHistory and receipts the revision it replaces', async () => {
    const owner = 'su-identity-rollback';
    const { revision: engineer } = await seedSession(owner, ENGINEER);
    const writer = artifactFor(WRITER);
    await mutate(owner, 'switch', 'writer');

    const result = await mutate(owner, 'rollback');

    expect(result).toMatchObject({
      changed: true,
      action: 'rollback',
      delivery: 'relaunch-with-carry',
      stack: ENGINEER,
      specificationRevision: engineer.specificationRevision,
    });
    const spec = await launchSpec(owner);
    expect(spec.stack).toEqual(ENGINEER);
    expect(spec.specificationRevision).toBe(engineer.specificationRevision);
    expect(spec.identityHistory?.[0]).toMatchObject({ stack: WRITER, specificationRevision: writer.specificationRevision });
    // History is de-duplicated by revision: the original engineer receipt is not doubled.
    const revisions = (spec.identityHistory ?? []).map((entry) => entry.specificationRevision);
    expect(new Set(revisions).size).toBe(revisions.length);

    const activation = (await brief(owner)).control_state.activation;
    expect(activation.desired).toEqual(engineer);
    expect(activation.status).toBe('desired');
    expect((await activationEvents(owner)).map((event) => event.specification_revision)).toEqual([
      writer.specificationRevision,
      engineer.specificationRevision,
    ]);
  }, 60_000);

  it('rolls the launch_spec write back when the activation request fails inside the transaction', async () => {
    const owner = 'su-identity-atomic';
    await seedSession(owner, ENGINEER);
    const beforeSpec = await launchSpec(owner);
    const beforeBrief = await brief(owner);
    h.goalAuthorityFailure = new Error('goal authority leg unreadable');

    await expect(mutate(owner, 'switch', 'writer')).rejects.toThrow(/goal authority leg unreadable/);

    // The CAS UPDATE ran first; the activation failure must undo it.
    expect(await launchSpec(owner)).toEqual(beforeSpec);
    expect(await brief(owner)).toEqual(beforeBrief);
    expect(await activationEvents(owner)).toHaveLength(0);
  }, 60_000);

  it('rejects a rollback when no prior revision exists, without touching the session', async () => {
    const owner = 'su-identity-no-history';
    await seedSession(owner, ENGINEER);
    const beforeSpec = await launchSpec(owner);

    await expect(mutate(owner, 'rollback')).rejects.toThrow(/No prior identity revision/);

    expect(await launchSpec(owner)).toEqual(beforeSpec);
    expect(await activationEvents(owner)).toHaveLength(0);
  }, 60_000);
});
