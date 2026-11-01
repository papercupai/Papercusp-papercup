/**
 * su-session-restart-journey.integration.test.ts — the P-010 restart journey
 * for ALL THREE SU backends against a REAL fully-migrated Postgres.
 *
 * ## What this file proves that the unit suites cannot
 * `su-session-persistence.test.ts` already covers `classifySuSessionRuntime`
 * as a pure function, and `su-session-host.test.ts` covers the host in
 * isolation. Both share one process with the code under test, so BOTH are
 * satisfied by an implementation that keeps its state in the module-scoped
 * host registry and never writes a row — which is precisely the failure this
 * journey exists to exclude. The restart being modelled is
 * `_resetSuSessionHostsForTest()`: after it the in-memory registry is EMPTY,
 * exactly as it is in a fresh operator process, so every host rebuilt below
 * can only have come from `adv_sessions`. The direct table read in
 * `describe('durability')` is the assertion no in-process cleverness can fake.
 *
 * ## Why the fixture needs no live agent processes
 * An earlier reading of this gap held that a three-backend restart journey
 * needed three LIVE chat-bound runtimes, and repeated probes for such runtimes
 * to appear reported "fixture-blocked" every time. That was a misreading of a
 * real mechanism: `launch-su.ts`'s defer_spawn branch calls
 * `bindSuSessionToAdvSession({ advSessionId, agentChatId })` with NO
 * descriptor, and `rehydrateRegisteredSuSessionHost` requires
 * `record.descriptor` — so a deferred row correctly refuses to rehydrate
 * (no runtime has ever existed, so there is nothing to reattach to). The
 * journey does not need three live runtimes; it needs three PERSISTED
 * DESCRIPTORS, and the binding API takes a descriptor argument. Every row
 * below is therefore written through the REAL production binding call against
 * a REAL database, with no agent process anywhere. The deferred-row case is
 * pinned as intended behaviour in `describe('deferred launch')` so a future
 * reader does not re-diagnose it as a defect.
 *
 * ## The three cases are three DIFFERENT reconciliation verdicts, on purpose
 * Running the same verdict three times would only re-prove the backend enum is
 * carried. Each backend here lands on a distinct branch of
 * `RuntimeReconciliation`, so the journey covers the reconciliation surface
 * and the multi-backend surface at once:
 *
 *   claude → ended/archived row      → { rematerialize, ended_archived }
 *   codex  → live pid + native id    → { reattach, live_pid }
 *   omp    → no pid + native id      → { reattach, native_identity }
 *
 * The claude case is the one that motivated the whole clause: an ended session
 * and a live one are indistinguishable to PUI without `runtimeReconciliation`,
 * and both render as an empty pane.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { RouteContext } from '@papercusp/agent-mcp';
import type {
  SuSessionBackend,
  SuSessionCapabilities,
  SuSessionDescriptor,
  SuSessionLifecycleState,
} from '@papercusp/chat-protocol';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));

vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getOrgPg: () => ({ sql: h.sql }),
}));

const { bindSuSessionToAdvSession, readDurableSuSession, persistSuSessionDescriptor } = await import('./su-session-persistence');
const {
  _resetSuSessionHostsForTest,
  getRegisteredSuSessionHost,
  rehydrateRegisteredSuSessionHost,
} = await import('./su-session-host');
const { suSessionRoutes } = await import('./endpoint-route/routes/agent-chats/su-session');
const { createOrgTestDb } = await import('../test/_org-test-db');

const [snapshotRoute] = suSessionRoutes;

const WORKSPACE = 'papercusp-workspace';
const HARNESS = 'papercusp';
type DescriptorMutation = (descriptor: SuSessionDescriptor) => unknown;
const descriptorIdentityMismatches: ReadonlyArray<[string, DescriptorMutation]> = [
  ['agentChatId', descriptor => ({
    ...descriptor, identity: { ...descriptor.identity, agentChatId: 'chat-restart-foreign' },
  })],
  ['advSessionId', descriptor => ({
    ...descriptor, identity: { ...descriptor.identity, advSessionId: descriptor.identity.advSessionId + 1 },
  })],
  ['workspaceId', descriptor => ({
    ...descriptor, identity: { ...descriptor.identity, workspaceId: 'other-workspace' },
  })],
  ['backend', descriptor => ({
    ...descriptor, identity: { ...descriptor.identity, backend: 'omp' },
  })],
  ['ownerId', descriptor => ({
    ...descriptor, identity: { ...descriptor.identity, ownerId: 'su-restart-journey-foreign' },
  })],
  ['nativeSessionId', descriptor => ({
    ...descriptor, identity: { ...descriptor.identity, nativeSessionId: 'foreign-native-session' },
  })],
];

let db: OrgTestDb;
let sql: Sql;
let priorWorkspaceEnv: string | undefined;

beforeAll(async () => {
  db = await createOrgTestDb();
  sql = db.adminSql;
  h.sql = sql;
  // The route resolves its workspace through activeWorkspaceId(); pin it so the
  // route-level journey addresses the same rows the direct calls do.
  priorWorkspaceEnv = process.env.PAPERCUSP_WORKSPACE_ID;
  process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE;
}, 180_000);

afterAll(async () => {
  if (priorWorkspaceEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
  else process.env.PAPERCUSP_WORKSPACE_ID = priorWorkspaceEnv;
  await db?.cleanup();
});

beforeEach(async () => {
  _resetSuSessionHostsForTest();
  await sql`DELETE FROM harness_shared.adv_sessions WHERE workspace_id = ${WORKSPACE}`;
});

afterEach(() => {
  _resetSuSessionHostsForTest();
});

const supported = { state: 'supported', implementation: 'native' } as const;
const hostSupported = { state: 'supported', implementation: 'host' } as const;

function capabilities(): SuSessionCapabilities {
  return {
    commands: {
      owner_turn: supported,
      interrupt: supported,
      resume: supported,
      fork: { state: 'unsupported', reason: 'restart-journey fixture has no fork' },
      focus: hostSupported,
      end: supported,
    },
    features: {
      'tool-events': supported,
      'interactive-cards': supported,
      'reasoning-stream': supported,
      usage: supported,
      compaction: supported,
      approvals: supported,
      context: supported,
      modes: supported,
    },
  };
}

function backendExtension(backend: SuSessionBackend): SuSessionDescriptor['backendExtension'] {
  if (backend === 'claude') {
    return { backend: 'claude', configDir: '/tmp/restart-journey-claude', configDirSource: 'live-process' };
  }
  if (backend === 'codex') return { backend: 'codex', codexHome: '/tmp/restart-journey-codex' };
  return { backend: 'omp', agentHome: '/tmp/restart-journey-omp' };
}

function descriptorFor(input: {
  backend: SuSessionBackend;
  agentChatId: string;
  advSessionId: number;
  nativeSessionId: string;
  lifecycle: SuSessionLifecycleState;
  runtimeGeneration?: number;
}): SuSessionDescriptor {
  return {
    identity: {
      agentChatId: input.agentChatId,
      advSessionId: input.advSessionId,
      backend: input.backend,
      nativeSessionId: input.nativeSessionId,
      ownerId: `su-restart-journey-${input.backend}`,
      workspaceId: WORKSPACE,
      harnessSlug: HARNESS,
    },
    lifecycle: input.lifecycle,
    runtimeGeneration: input.runtimeGeneration ?? 3,
    role: 'su',
    model: null,
    accountServed: null,
    accountRoute: 'default',
    carry: 'warm',
    modes: ['auto'],
    capabilities: capabilities(),
    backendExtension: backendExtension(input.backend),
  } as SuSessionDescriptor;
}

/**
 * Insert the bare adv row a launch creates BEFORE any descriptor exists, then
 * bind through the real production call. Returns the durable adv id, which is
 * the stable identity the whole journey is addressed by.
 */
async function seedBoundSession(input: {
  backend: SuSessionBackend;
  agentChatId: string;
  nativeSessionId: string | null;
  pid: number | null;
  endedAt: Date | null;
  lifecycle: SuSessionLifecycleState;
  withDescriptor?: boolean;
}): Promise<number> {
  const rows = await sql<{ id: number }[]>`
    INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, agent, session_id, omp_thread_id, coord_owner_id, pid, ended_at)
    VALUES (
      ${WORKSPACE}, 'omp', ${input.backend},
      ${input.backend === 'omp' ? null : input.nativeSessionId},
      ${input.backend === 'omp' ? input.nativeSessionId : null},
      ${`su-restart-journey-${input.backend}`}, ${input.pid}, ${input.endedAt}
    )
    RETURNING id`;
  const advSessionId = Number(rows[0].id);

  const result = await bindSuSessionToAdvSession({
    advSessionId,
    agentChatId: input.agentChatId,
    workspaceId: WORKSPACE,
    descriptor:
      input.withDescriptor === false
        ? undefined
        : descriptorFor({
            backend: input.backend,
            agentChatId: input.agentChatId,
            advSessionId,
            nativeSessionId: input.nativeSessionId ?? '',
            lifecycle: input.lifecycle,
          }),
  });
  expect(result.status).toBe('bound');
  return advSessionId;
}

/** The three-backend fleet, seeded exactly as a pre-restart operator left it. */
async function seedFleet(): Promise<Record<SuSessionBackend, number>> {
  return {
    // An ENDED session: the archived transcript PUI must rematerialise rather
    // than render as an empty live pane.
    claude: await seedBoundSession({
      backend: 'claude',
      agentChatId: 'chat-restart-claude',
      nativeSessionId: 'claude-native-restart',
      pid: null,
      endedAt: new Date('2026-08-28T01:00:00Z'),
      lifecycle: 'ended',
    }),
    // A LIVE runtime: this test process's own pid is the only pid guaranteed
    // alive for the duration of the assertion.
    codex: await seedBoundSession({
      backend: 'codex',
      agentChatId: 'chat-restart-codex',
      nativeSessionId: 'codex-native-restart',
      pid: process.pid,
      endedAt: null,
      lifecycle: 'running',
    }),
    // No pid recorded, but a native identity to resume from.
    omp: await seedBoundSession({
      backend: 'omp',
      agentChatId: 'chat-restart-omp',
      nativeSessionId: 'omp-native-restart',
      pid: null,
      endedAt: null,
      lifecycle: 'waiting-for-owner',
    }),
  };
}

function chatIdFor(backend: SuSessionBackend): string {
  return `chat-restart-${backend}`;
}

async function rehydrate(backend: SuSessionBackend, overrides: { harnessSlug?: string | null; workspaceId?: string } = {}) {
  return rehydrateRegisteredSuSessionHost({
    workspaceId: overrides.workspaceId ?? WORKSPACE,
    harnessSlug: overrides.harnessSlug === undefined ? HARNESS : overrides.harnessSlug,
    agentChatId: chatIdFor(backend),
  });
}

describe('durability', () => {
  it.each(['claude', 'codex', 'omp'] as const)('links asynchronous %s native identity without replacing an existing binding', async (backend) => {
    const id = await seedBoundSession({ backend, agentChatId: `chat-native-${backend}`,
      nativeSessionId: null, pid: null, endedAt: null, lifecycle: 'starting' });
    const descriptor = descriptorFor({ backend, agentChatId: `chat-native-${backend}`,
      advSessionId: id, nativeSessionId: `native-${backend}`, lifecycle: 'ready' });
    expect(await persistSuSessionDescriptor(id, descriptor, WORKSPACE)).toBe(true);
    const readBinding = () => sql<{ session_id: string | null; omp_thread_id: string | null; native_id: string }[]>`
      SELECT session_id, omp_thread_id, su_session_descriptor->'identity'->>'nativeSessionId' AS native_id
      FROM harness_shared.adv_sessions WHERE id = ${id}`;
    const expected = { session_id: backend === 'omp' ? null : `native-${backend}`,
      omp_thread_id: backend === 'omp' ? `native-${backend}` : null, native_id: `native-${backend}` };
    expect((await readBinding())[0]).toEqual(expected);
    expect(await persistSuSessionDescriptor(id, descriptor, WORKSPACE)).toBe(true);
    const conflicting = structuredClone(descriptor);
    conflicting.identity.nativeSessionId = 'different-thread';
    expect(await persistSuSessionDescriptor(id, conflicting, WORKSPACE)).toBe(false);
    expect((await readBinding())[0]).toEqual(expected);
  });

  it('persists every backend descriptor to the adv row itself', async () => {
    const ids = await seedFleet();

    const rows = await sql<
      { id: number; su_agent_chat_id: string; su_session_state: string; su_runtime_generation: number; backend: string }[]
    >`
      SELECT id, su_agent_chat_id, su_session_state, su_runtime_generation,
             su_session_descriptor->'identity'->>'backend' AS backend
        FROM harness_shared.adv_sessions
       WHERE workspace_id = ${WORKSPACE} AND su_session_descriptor IS NOT NULL
       ORDER BY id`;

    // The discriminator: a host registry that never wrote a row fails here,
    // and no in-process state can satisfy it.
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.backend)).toEqual(['claude', 'codex', 'omp']);
    expect(rows.map((r) => Number(r.id))).toEqual([ids.claude, ids.codex, ids.omp]);
    expect(rows.map((r) => r.su_agent_chat_id)).toEqual([
      chatIdFor('claude'),
      chatIdFor('codex'),
      chatIdFor('omp'),
    ]);
    // The descriptor's lifecycle/generation are lifted onto the row's own
    // columns by the binding SQL, not merely buried in the JSON blob.
    expect(rows.map((r) => r.su_session_state)).toEqual(['ended', 'running', 'waiting-for-owner']);
    expect(rows.every((r) => Number(r.su_runtime_generation) === 3)).toBe(true);
  });
});

describe('restart journey', () => {
  it('rebuilds all three backends from the durable rows alone, each with its own verdict', async () => {
    const ids = await seedFleet();

    // THE RESTART. Everything below must come out of Postgres.
    _resetSuSessionHostsForTest();

    // Positive control: without this the rehydrate assertions could be
    // satisfied by a host left over from seeding, and would pass against a
    // rehydrate that did nothing at all.
    for (const backend of ['claude', 'codex', 'omp'] as const) {
      expect(getRegisteredSuSessionHost({ workspaceId: WORKSPACE, harnessSlug: HARNESS, agentChatId: chatIdFor(backend) })).toBeNull();
    }

    const claude = await rehydrate('claude');
    const codex = await rehydrate('codex');
    const omp = await rehydrate('omp');
    expect(claude).not.toBeNull();
    expect(codex).not.toBeNull();
    expect(omp).not.toBeNull();

    // Stable identity: the SAME adv row, not a freshly minted one.
    expect(claude!.descriptor().identity.advSessionId).toBe(ids.claude);
    expect(codex!.descriptor().identity.advSessionId).toBe(ids.codex);
    expect(omp!.descriptor().identity.advSessionId).toBe(ids.omp);
    expect(claude!.descriptor().identity.backend).toBe('claude');
    expect(codex!.descriptor().identity.backend).toBe('codex');
    expect(omp!.descriptor().identity.backend).toBe('omp');
    expect(codex!.descriptor().identity.nativeSessionId).toBe('codex-native-restart');

    // Each backend lands on a DIFFERENT reconciliation branch.
    expect(claude!.snapshot().runtimeReconciliation).toEqual({
      action: 'rematerialize',
      reason: 'ended_archived',
      stalePid: false,
    });
    expect(codex!.snapshot().runtimeReconciliation).toEqual({
      action: 'reattach',
      reason: 'live_pid',
      stalePid: false,
    });
    expect(omp!.snapshot().runtimeReconciliation).toEqual({
      action: 'reattach',
      reason: 'native_identity',
      stalePid: false,
    });

    // The archived pane is terminal; the two live ones are not. Without this
    // split PUI renders all three identically.
    expect(claude!.snapshot().terminal).toBe(true);
    expect(codex!.snapshot().terminal).toBe(false);
    expect(omp!.snapshot().terminal).toBe(false);
  });

  it('never registers a duplicate host for the same chat', async () => {
    await seedFleet();
    _resetSuSessionHostsForTest();

    for (const backend of ['claude', 'codex', 'omp'] as const) {
      const first = await rehydrate(backend);
      const second = await rehydrate(backend);
      const looked = getRegisteredSuSessionHost({
        workspaceId: WORKSPACE,
        harnessSlug: HARNESS,
        agentChatId: chatIdFor(backend),
      });
      expect(first).not.toBeNull();
      // Same instance, not merely an equal snapshot: a second registration
      // would fork the event channel and split the pane's stream.
      expect(second).toBe(first);
      expect(looked).toBe(first);
    }
  });

  it('keeps the three hosts on distinct channels', async () => {
    await seedFleet();
    _resetSuSessionHostsForTest();

    const keys = await Promise.all(
      (['claude', 'codex', 'omp'] as const).map(async (backend) => (await rehydrate(backend))!.channelKey),
    );
    expect(new Set(keys).size).toBe(3);
  });

  it('resolves the same host from the durable row after a SECOND restart', async () => {
    const ids = await seedFleet();
    _resetSuSessionHostsForTest();
    const before = await rehydrate('codex');
    expect(before).not.toBeNull();

    _resetSuSessionHostsForTest();
    const after = await rehydrate('codex');

    expect(after).not.toBeNull();
    // A NEW host object (the old registry is gone) bound to the SAME identity.
    expect(after).not.toBe(before);
    expect(after!.descriptor().identity.advSessionId).toBe(ids.codex);
    expect(after!.snapshot().runtimeReconciliation?.action).toBe('reattach');
  });
});

describe('deferred launch', () => {
  it('refuses to rehydrate a row bound without a descriptor', async () => {
    // Exactly launch-su.ts's defer_spawn call shape: a binding with no
    // descriptor, because no runtime has ever existed for it.
    await seedBoundSession({
      backend: 'claude',
      agentChatId: chatIdFor('claude'),
      nativeSessionId: null,
      pid: null,
      endedAt: null,
      lifecycle: 'starting',
      withDescriptor: false,
    });
    _resetSuSessionHostsForTest();

    const record = await readDurableSuSession({ agentChatId: chatIdFor('claude'), workspaceId: WORKSPACE });
    expect(record).not.toBeNull();
    expect(record!.descriptor).toBeNull();

    // Correct behaviour, not a gap: there is no runtime to reattach to, which
    // is what the route surfaces as su_session_not_attached.
    expect(await rehydrate('claude')).toBeNull();
  });
});

describe('the route PUI actually attaches through', () => {
  function routeContext(chatId: string): RouteContext {
    return {
      principal: null,
      input: undefined,
      params: { slug: HARNESS, chatId },
      log: () => {},
      signal: new AbortController().signal,
    };
  }

  async function snapshotResponse(chatId: string): Promise<Response> {
    return snapshotRoute.handler(
      new Request(`http://127.0.0.1/harness/${HARNESS}/agent-chats/${chatId}/su-session`),
      routeContext(chatId),
    ) as Promise<Response>;
  }

  it('serves every rebuilt backend, each carrying its own reconciliation verdict', async () => {
    const ids = await seedFleet();
    _resetSuSessionHostsForTest();

    const expected = {
      claude: { action: 'rematerialize', reason: 'ended_archived', advSessionId: ids.claude },
      codex: { action: 'reattach', reason: 'live_pid', advSessionId: ids.codex },
      omp: { action: 'reattach', reason: 'native_identity', advSessionId: ids.omp },
    } as const;

    for (const backend of ['claude', 'codex', 'omp'] as const) {
      const res = await snapshotResponse(chatIdFor(backend));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        descriptor: SuSessionDescriptor;
        runtimeReconciliation: { action: string; reason: string } | null;
      };
      expect(body.ok).toBe(true);
      expect(body.descriptor.identity.backend).toBe(backend);
      expect(body.descriptor.identity.advSessionId).toBe(expected[backend].advSessionId);
      // The field PUI reads to tell "attached to a running runtime" from
      // "rebuilt out of the archive". Serialized over the wire, not merely
      // present on the in-process object.
      expect(body.runtimeReconciliation).toMatchObject({
        action: expected[backend].action,
        reason: expected[backend].reason,
      });
    }
  });

  it('refuses a deferred chat with the typed not-attached code rather than an empty pane', async () => {
    await seedBoundSession({
      backend: 'codex',
      agentChatId: chatIdFor('codex'),
      nativeSessionId: null,
      pid: null,
      endedAt: null,
      lifecycle: 'starting',
      withDescriptor: false,
    });
    _resetSuSessionHostsForTest();

    const res = await snapshotResponse(chatIdFor('codex'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'su_session_not_attached' });
  });
});

describe('binding faults', () => {
  it('reports a genuinely absent adv row as not_found', async () => {
    // The positive control for the `error` status added alongside the alias
    // fix: `not_found` must still mean "no such row", or the new status would
    // simply be the old silent swallow under a different name.
    const missing = await bindSuSessionToAdvSession({
      advSessionId: 2_147_000_111,
      agentChatId: 'chat-restart-nonexistent',
      workspaceId: WORKSPACE,
    });
    expect(missing.status).toBe('not_found');
  });

  it('reports the FIRST descriptor bind as bound and only a repeat as already_bound', async () => {
    const rows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.adv_sessions (workspace_id, mode, agent, session_id, coord_owner_id)
      VALUES (${WORKSPACE}, 'omp', 'claude', 'claude-native-first-bind', 'su-restart-journey-claude') RETURNING id`;
    const advSessionId = Number(rows[0].id);
    const descriptor = descriptorFor({
      backend: 'claude',
      agentChatId: 'chat-restart-first-bind',
      advSessionId,
      nativeSessionId: 'claude-native-first-bind',
      lifecycle: 'ready',
    });

    const first = await bindSuSessionToAdvSession({
      advSessionId,
      agentChatId: 'chat-restart-first-bind',
      workspaceId: WORKSPACE,
      descriptor,
    });
    const second = await bindSuSessionToAdvSession({
      advSessionId,
      agentChatId: 'chat-restart-first-bind',
      workspaceId: WORKSPACE,
      descriptor,
    });

    // The discriminator has to read the row as it was BEFORE the write, or the
    // first bind of a descriptor is indistinguishable from a re-bind.
    expect(first.status).toBe('bound');
    expect(second.status).toBe('already_bound');
    const [saved] = await sql<{ su_runtime_generation: number }[]>`
      SELECT su_runtime_generation FROM harness_shared.adv_sessions WHERE id = ${advSessionId}`;
    expect(saved!.su_runtime_generation).toBe(3);
  });

  it.each(descriptorIdentityMismatches)(
    'refuses a %s descriptor mismatch without changing the target row',
    async (_identityField, mutate) => {
      const agentChatId = 'chat-restart-identity-mismatch';
      const nativeSessionId = 'codex-native-identity-mismatch';
      const ownerId = 'su-restart-journey-codex';
      const rows = await sql<{ id: number }[]>`
        INSERT INTO harness_shared.adv_sessions
          (workspace_id, mode, agent, session_id, coord_owner_id, su_runtime_generation)
        VALUES (${WORKSPACE}, 'omp', 'codex', ${nativeSessionId}, ${ownerId}, 4)
        RETURNING id`;
      const advSessionId = Number(rows[0]!.id);
      const descriptor = descriptorFor({
        backend: 'codex', agentChatId, advSessionId, nativeSessionId,
        lifecycle: 'ready', runtimeGeneration: 5,
      });

      const result = await bindSuSessionToAdvSession({
        advSessionId, agentChatId, workspaceId: WORKSPACE, descriptor: mutate(descriptor) as SuSessionDescriptor,
      });

      expect(result).toEqual({ status: 'conflict', reason: 'identity_mismatch' });
      const [unchanged] = await sql<{
        su_agent_chat_id: string | null;
        su_session_descriptor: SuSessionDescriptor | null;
        su_session_state: SuSessionLifecycleState | null;
        su_runtime_generation: number;
      }[]>`
        SELECT su_agent_chat_id, su_session_descriptor, su_session_state, su_runtime_generation
          FROM harness_shared.adv_sessions WHERE id = ${advSessionId}`;
      expect(unchanged).toMatchObject({
        su_agent_chat_id: null, su_session_descriptor: null, su_session_state: null, su_runtime_generation: 4,
      });
    },
  );

  it('rejects a stale runtime generation without replacing the current descriptor', async () => {
    const agentChatId = 'chat-restart-generation-guard';
    const nativeSessionId = 'codex-native-generation-guard';
    const ownerId = 'su-restart-journey-codex';
    const rows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, agent, session_id, coord_owner_id, su_runtime_generation)
      VALUES (${WORKSPACE}, 'omp', 'codex', ${nativeSessionId}, ${ownerId}, 5)
      RETURNING id`;
    const advSessionId = Number(rows[0]!.id);
    const current = descriptorFor({
      backend: 'codex', agentChatId, advSessionId, nativeSessionId,
      lifecycle: 'running', runtimeGeneration: 5,
    });
    const first = await bindSuSessionToAdvSession({ advSessionId, agentChatId, workspaceId: WORKSPACE, descriptor: current });
    const stale = { ...current, lifecycle: 'ready', runtimeGeneration: 4 } as SuSessionDescriptor;
    const second = await bindSuSessionToAdvSession({ advSessionId, agentChatId, workspaceId: WORKSPACE, descriptor: stale });

    expect(first.status).toBe('bound');
    expect(second).toEqual({ status: 'conflict', reason: 'identity_mismatch' });
    const [saved] = await sql<{
      su_session_descriptor: SuSessionDescriptor;
      su_session_state: SuSessionLifecycleState;
      su_runtime_generation: number;
    }[]>`
      SELECT su_session_descriptor, su_session_state, su_runtime_generation
        FROM harness_shared.adv_sessions WHERE id = ${advSessionId}`;
    expect(saved).toMatchObject({
      su_session_descriptor: current, su_session_state: 'running', su_runtime_generation: 5,
    });
  });

  it('checks an OMP descriptor native id against omp_thread_id', async () => {
    const agentChatId = 'chat-restart-omp-native-guard';
    const nativeSessionId = 'omp-thread-canonical';
    const rows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, agent, session_id, omp_thread_id, coord_owner_id)
      VALUES (
        ${WORKSPACE}, 'omp', 'omp', 'legacy-generic-session', ${nativeSessionId}, 'su-restart-journey-omp'
      )
      RETURNING id`;
    const advSessionId = Number(rows[0]!.id);
    const descriptor = descriptorFor({
      backend: 'omp', agentChatId, advSessionId, nativeSessionId: 'legacy-generic-session',
      lifecycle: 'ready', runtimeGeneration: 4,
    });

    const result = await bindSuSessionToAdvSession({ advSessionId, agentChatId, workspaceId: WORKSPACE, descriptor });

    expect(result).toEqual({ status: 'conflict', reason: 'identity_mismatch' });
    const [unchanged] = await sql<{ su_agent_chat_id: string | null; su_session_descriptor: SuSessionDescriptor | null }[]>`
      SELECT su_agent_chat_id, su_session_descriptor FROM harness_shared.adv_sessions WHERE id = ${advSessionId}`;
    expect(unchanged).toMatchObject({ su_agent_chat_id: null, su_session_descriptor: null });
  });

  it('refuses to bind a chat that another adv row already owns', async () => {
    const ids = await seedFleet();
    const rows = await sql<{ id: number }[]>`
      INSERT INTO harness_shared.adv_sessions (workspace_id, mode, agent)
      VALUES (${WORKSPACE}, 'omp', 'codex') RETURNING id`;

    const stolen = await bindSuSessionToAdvSession({
      advSessionId: Number(rows[0].id),
      agentChatId: chatIdFor('codex'),
      workspaceId: WORKSPACE,
    });

    // Whatever the reason, the second row must NOT come back 'bound' — that is
    // the duplicate-pane guard at launch, and it can only fire if this call
    // returns a real verdict instead of an exception rendered as not_found.
    expect(stolen.status).toBe('conflict');
    const winner = await readDurableSuSession({ agentChatId: chatIdFor('codex'), workspaceId: WORKSPACE });
    expect(winner?.advSessionId).toBe(ids.codex);
  });
});

describe('identity guards', () => {
  it('refuses a rehydrate whose harness does not match the persisted identity', async () => {
    await seedFleet();
    _resetSuSessionHostsForTest();

    expect(await rehydrate('codex', { harnessSlug: 'some-other-harness' })).toBeNull();
    expect(
      getRegisteredSuSessionHost({
        workspaceId: WORKSPACE,
        harnessSlug: 'some-other-harness',
        agentChatId: chatIdFor('codex'),
      }),
    ).toBeNull();
  });

  it('does not see a row from another workspace', async () => {
    await seedFleet();
    _resetSuSessionHostsForTest();

    expect(await rehydrate('codex', { workspaceId: 'some-other-workspace' })).toBeNull();
  });
});
