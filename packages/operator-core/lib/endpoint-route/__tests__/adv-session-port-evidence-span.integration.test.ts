import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type postgres from 'postgres';
import { createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { SESSION_PORT_PROTOCOL_VERSION, SESSION_PORT_TOKEN_ESTIMATOR, SESSION_PORT_TRANSFORM_VERSION } from '../../session-port/types';
import { createRouteDiagnostics, DEFAULT_ROUTE_STACK } from '../route-stack';
import { registerRoute } from '../define-route';

const preparePortMock = vi.hoisted(() => vi.fn());
vi.mock('../../superuser-token', () => ({ readSuperuserToken: () => 'session-port-fixture-key' }));

const state = vi.hoisted(() => ({
  sql: null as unknown,
  sourceRow: null as unknown,
  inspectArgs: null as unknown,
  /** The row the port acquired its transcript for (WI-10003198). */
  acquiredRow: null as unknown,
}));
// consult-backed-parking-2026-10-12#P-010: the live-source preflight's shared read.
// Default = no bound session, so every pre-existing case here is unaffected.
const bindingsMock = vi.hoisted(() => vi.fn());
vi.mock('../routes/agent-mcp/pre-pinned-owner-conflicts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../routes/agent-mcp/pre-pinned-owner-conflicts')>()),
  readPrePinnedOwnerBindings: (...args: unknown[]) => bindingsMock(...args),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: state.sql }) as never,
}));
vi.mock('../../adv-sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../adv-sessions')>()),
  getAdvSessionInWorkspace: async () => state.sourceRow,
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../workspace-registry')>()),
  activeWorkspaceId: () => 'evidence-span-ws',
}));
vi.mock('../../role-launch-spec', () => ({ buildLaunchSpec: async () => ({ promptText: 'fixture launch prompt' }) }));
vi.mock('../../model-context-budget.mjs', () => ({
  readLaunchContextText: () => '',
  appendCodexLaunchContextPrompt: (prompt: string) => prompt,
  buildContextBudget: () => ({ level: 'ok', window: 200_000, availableInputTokens: 100_000 }),
}));
vi.mock('../../session-port/store', () => ({ assertSessionPortStorageReady: async () => {} }));
vi.mock('../../session-port/service', async (importOriginal) => ({
  prepareInspectedSessionPort: (...args: unknown[]) => preparePortMock(...args),
  resolveSessionPortTargetOwner: (await importOriginal<typeof import('../../session-port/service')>()).resolveSessionPortTargetOwner,
  acquireTrackedSessionSource: async (row: unknown, _deps: unknown, diagnostics?: { measure<T>(phase: string, work: () => T): Promise<T> }) => {
    state.acquiredRow = row;
    const stable = {
      bytes: Buffer.from('fixture'), sha256: 'a'.repeat(64), highWaterBytes: 7,
      completeBytes: 7, source: 'archive-manifest', relpath: 'projects/source.jsonl',
    };
    return diagnostics ? diagnostics.measure('port.source.archive-stamp', () => stable) : stable;
  },
  // This is synchronous in production. Keeping the fake synchronous is load-bearing:
  // the inspect route immediately reads the returned inspection's source identity.
  inspectAcquiredSessionPort: (args: unknown) => {
    state.inspectArgs = args;
    return {
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      source: {
        advSessionId: 41, nativeSessionId: 'source-native-session', backend: 'claude',
        workspaceId: 'evidence-span-ws', cwd: '/repo', planSlug: null,
        snapshotKind: 'archive-manifest', highWaterBytes: 7, completeBytes: 7, sha256: 'a'.repeat(64),
      },
      target: {
        backend: 'codex', provider: 'openai', model: null, account: 'default', contextWindow: 200_000,
        availableInputTokens: 100_000, contextSize: 'trimmed', launchContextHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      fullHistoryEstimatedTokens: 7, fullPayloadEstimatedTokens: 7,
      tokenEstimator: SESSION_PORT_TOKEN_ESTIMATOR, requiresSummary: false,
      stats: {
        sourceRecords: 1, activePathRecords: 1, malformedRecords: 0, sidechainRecords: 0, compactedAncestors: 0,
        toolCalls: 0, toolResults: 0, unlinkedToolResults: 0, truncatedToolNarratives: 0, omittedAttachments: 0,
        textAttachments: 0, truncatedAttachments: 0, omittedThinkingBlocks: 0, omittedSignatureBlocks: 0,
        unsupportedBlocks: 0, syntheticRecords: 0, redactions: 0, controlBytesRemoved: 0, delimiterEscapes: 0,
      },
      warnings: [],
      disclosure: { newTargetSession: true, sourceUntouched: true, authorityCarried: true, targetEgress: 'openai/default', summarizerEgress: null },
      internal: {} as never,
    };
  },
  publicSessionPortInspection: (inspection: unknown) => inspection,
}));
vi.mock('../../session-port/telemetry', () => ({
  telemetryFromInspection: () => ({}),
  recordSessionPortTelemetry: async () => {},
}));
// This fixture owns source-index evidence, not the operator's invocation ledger.
vi.mock('../telemetry', () => ({ recordRouteInvocation: vi.fn() }));

type Route = { method: string; path: string; handler: (request: Request, context?: unknown) => Promise<Response> };
const WS = 'evidence-span-ws';
const SESSION = 'source-native-session';
let db: FreshPgDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshPgDb('session-port-evidence-span');
  sql = db.sql;
  state.sql = sql;
  await sql.unsafe(`CREATE TABLE IF NOT EXISTS harness_shared.session_turns (
    workspace_id text NOT NULL DEFAULT 'default', source_kind text NOT NULL, session_id text NOT NULL,
    turn_idx integer NOT NULL, ts timestamptz, speaker text NOT NULL, text text NOT NULL,
    ingested_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (workspace_id, source_kind, session_id, turn_idx)
  )`);
  // The owner bridge an earlier carry-respawn incarnation is resolved through (WI-10003198).
  await sql.unsafe(`ALTER TABLE harness_shared.session_turns ADD COLUMN IF NOT EXISTS owner text`);
}, 120_000);

afterAll(async () => { await db?.cleanup(); });

beforeEach(async () => {
  preparePortMock.mockReset();
  state.sourceRow = {
    id: 41, workspaceId: WS, planSlug: null, agent: 'claude', role: null, sessionId: SESSION,
    coordOwnerId: 'su-source', cwd: '/repo', startedAt: '2026-09-23T08:00:00.000Z', endedAt: '2026-09-23T08:30:00.000Z',
  };
  state.inspectArgs = null;
  state.acquiredRow = null;
  bindingsMock.mockReset().mockResolvedValue({ precursors: [], reclaimableConflicts: [], conflicts: [], sessionState: undefined });
  await sql`TRUNCATE harness_shared.session_turns CASCADE`;
  await sql`
    INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text)
    VALUES
      (${WS}, 'claude', ${SESSION}, 2, '2026-09-23T08:01:00.000Z'::timestamptz, 'user', 'first evidence'),
      (${WS}, 'claude', ${SESSION}, 4, '2026-09-23T08:02:00.000Z'::timestamptz, 'assistant', 'second evidence'),
      (${WS}, 'claude', 'other-session', 2, '2026-09-23T08:01:00.000Z'::timestamptz, 'user', 'wrong source'),
      ('other-workspace', 'claude', ${SESSION}, 2, '2026-09-23T08:01:00.000Z'::timestamptz, 'user', 'wrong workspace')
  `;
});

async function inspect(body: Record<string, unknown>, routeDiagnostics?: ReturnType<typeof createRouteDiagnostics>): Promise<Response> {
  const routes = (await import('../routes/adv/sessions')).default as Route[];
  const route = routes.find((candidate) => candidate.method === 'POST' && candidate.path === '/adv/sessions/port/inspect');
  if (!route) throw new Error('session-port inspection route was not registered');
  return route.handler(new Request('http://localhost:3170/api/adv/sessions/port/inspect', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION, transformVersion: SESSION_PORT_TRANSFORM_VERSION,
      workspace: WS, sourceAdvSessionId: 41, targetBackend: 'codex',
      consultEvidenceSpan: { sessionId: SESSION, turnIndices: [4, 2], contextTurns: 2 }, ...body,
    }),
  }), { routeDiagnostics });
}

describe('session-port live-source preflight (consult-backed-parking-2026-10-12#P-010)', () => {
  const liveBinding = {
    precursors: [], reclaimableConflicts: [], sessionState: 'live',
    conflicts: [{ id: '39975', display: null, has_session: true, launched: false, liveness: 'live' }],
  };

  it('refuses a source-identity port while that identity is bound to a live session, before reading the transcript', async () => {
    bindingsMock.mockResolvedValueOnce(liveBinding);
    const response = await inspect({ consultEvidenceSpan: null });
    expect(response.status).toBe(409);
    const body = await response.json() as { code?: string; error?: string };
    expect(body.code).toBe('source_session_still_live');
    expect(body.error).toMatch(/source session 41 \(su-source\) is still running \(sessionState=live\)/);
    expect(body.error).toMatch(/Exit the source session first/);
    expect(bindingsMock).toHaveBeenCalledWith('su-source');
    expect(state.acquiredRow).toBeNull();
    expect(state.inspectArgs).toBeNull();
  });

  it('never consults the binding read for an isolated-owner (consult) port', async () => {
    bindingsMock.mockResolvedValue(liveBinding);
    const response = await inspect({ targetOwnerId: 'su-answer-owner' });
    expect(response.status).toBe(200);
    expect(bindingsMock).not.toHaveBeenCalled();
  });

  it('is fail-soft: a failed binding read leaves the launch guard as the authority', async () => {
    bindingsMock.mockRejectedValueOnce(new Error('relation "harness_shared.adv_sessions" does not exist'));
    const response = await inspect({ consultEvidenceSpan: null });
    expect(response.status).toBe(200);
    expect(bindingsMock).toHaveBeenCalledTimes(1);
    expect(state.acquiredRow).toMatchObject({ id: 41, coordOwnerId: 'su-source' });
  });
});

describe('session-port evidence-span route (P-007)', () => {
  it('retains content-free phase evidence for an isolated reviewer inspection', async () => {
    const diagnostics = createRouteDiagnostics();
    const response = await inspect({ targetOwnerId: 'su-answer-owner' }, diagnostics);
    expect(response.status).toBe(200);
    const phases = diagnostics.snapshot();
    for (const phase of ['port.imports', 'port.storage-ready', 'port.tracked-source', 'port.evidence-turns',
      'port.launch-spec', 'port.context-budget', 'port.acquire-source', 'port.source.archive-stamp', 'port.transform', 'port.telemetry']) {
      expect(phases[phase]).toEqual(expect.any(Number));
    }
    expect(JSON.stringify(phases)).not.toContain('first evidence');
    expect(phases['port.owner-bindings']).toBeUndefined();
  });

  it.each(['claude', 'codex', 'omp'] as const)('binds an isolated answer owner on the %s target without changing the source row', async (backend) => {
    const sourceBefore = structuredClone(state.sourceRow);
    const response = await inspect({ targetBackend: backend, targetOwnerId: 'su-answer-owner' });
    expect(response.status).toBe(200);
    expect(state.inspectArgs).toMatchObject({ target: { backend, ownerId: 'su-answer-owner' } });
    expect(state.sourceRow).toEqual(sourceBefore);
  });

  it.each(['su-source', null, '', 42])('refuses invalid isolated target owner %s before reading the transcript', async (targetOwnerId) => {
    const response = await inspect({ targetOwnerId });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/isolated target owner/) });
    expect(state.acquiredRow).toBeNull();
  });

  it.each(['codex', 'omp'] as const)('selects the exact %s source kind even when another backend has the same native id', async (backend) => {
    state.sourceRow = { ...(state.sourceRow as Record<string, unknown>), agent: backend,
      ...(backend === 'omp' ? { sessionId: null, ompThreadId: SESSION } : {}) };
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text)
      VALUES (${WS}, ${backend}, ${SESSION}, 2, '2026-09-23T08:01:00Z'::timestamptz, 'user', 'native source evidence')
    `;
    const response = await inspect({ consultEvidenceSpan: { sessionId: SESSION, turnIndices: [2], contextTurns: 0 } });
    expect(response.status).toBe(200);
    expect(state.acquiredRow).toMatchObject({ agent: backend, sessionId: SESSION });
    expect(state.inspectArgs).toMatchObject({ evidenceSpan: { evidenceTurns: [{ text: 'native source evidence' }] } });
  });

  it.each(['codex', 'omp'] as const)('refuses %s evidence that exists only under a different source kind', async (backend) => {
    state.sourceRow = { ...(state.sourceRow as Record<string, unknown>), agent: backend,
      ...(backend === 'omp' ? { sessionId: null, ompThreadId: SESSION } : {}) };
    const response = await inspect({ consultEvidenceSpan: { sessionId: SESSION, turnIndices: [2], contextTurns: 0 } });
    expect(response.status).toBe(409);
    expect(state.acquiredRow).toBeNull();
  });

  it('resolves turns only from the exact source workspace/session and passes them to inspection', async () => {
    const response = await inspect({});
    expect(response.status).toBe(200);
    const args = state.inspectArgs as { evidenceSpan?: {
      sessionId: string; turnIndices: number[]; contextTurns: number;
      evidenceTurns: Array<{ turnIdx: number; speaker: string; text: string }>;
    } };
    expect(args.evidenceSpan).toMatchObject({ sessionId: SESSION, turnIndices: [4, 2], contextTurns: 2 });
    expect(args.evidenceSpan?.evidenceTurns.map((turn) => [turn.turnIdx, turn.speaker, turn.text]).sort((a, b) => Number(a[0]) - Number(b[0])))
      .toEqual([[2, 'user', 'first evidence'], [4, 'assistant', 'second evidence']]);
  });

  it('refuses evidence refs that name another tracked source session', async () => {
    const response = await inspect({ consultEvidenceSpan: { sessionId: 'wrong-session', turnIndices: [2], contextTurns: 2 } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('exact source session') });
    expect(state.inspectArgs).toBeNull();
  });
});

describe('session-port preparation committed receipt (EI-26728335329243377)', () => {
  async function prepareThroughStack(): Promise<{ response: Response; signal: AbortSignal }> {
    const routes = (await import('../routes/adv/sessions')).default;
    const route = routes.find((candidate) => candidate.method === 'POST' && candidate.path === '/adv/sessions/port/prepare') as Parameters<typeof registerRoute>[1];
    if (!route) throw new Error('session-port preparation route was not registered');
    const app = new Hono();
    let signal: AbortSignal | undefined;
    registerRoute(app, {
      ...route,
      timeoutSec: 0.001,
      handler(request, context) {
        signal = context.signal;
        return route.handler(request, context);
      },
    }, DEFAULT_ROUTE_STACK.filter((step) => step.name === 'invoke'));
    const response = await app.request(route.path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: SESSION_PORT_PROTOCOL_VERSION, transformVersion: SESSION_PORT_TRANSFORM_VERSION,
        workspace: WS, sourceAdvSessionId: 41, targetBackend: 'codex', targetOwnerId: 'su-answer-owner',
        expectedSourceHash: 'a'.repeat(64),
      }),
    });
    if (!signal) throw new Error('route did not receive its deadline signal');
    return { response, signal };
  }

  it.each([false, true])('returns the durable preparation receipt after the deadline (reused=%s)', async (reused) => {
    const portId = '22222222-2222-4222-8222-222222222222';
    const token = `${portId}.${'b'.repeat(64)}`;
    preparePortMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
        port: { id: portId, status: 'prepared', metadata: { estimatedTokens: 7 }, retryOfPortId: null,
          targetAdvSessionId: null, expiresAt: '2099-01-01T00:00:00.000Z' },
        token, reused, summary: { fidelity: 'full', hashes: { source: 'a'.repeat(64) }, stats: {}, summary: null },
      };
    });
    const { response, signal } = await prepareThroughStack();
    expect(signal.aborted).toBe(true);
    expect(preparePortMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, portId, token, reused, status: 'prepared' });
  });

  it('keeps the timeout refusal when preparation fails without a durable receipt', async () => {
    preparePortMock.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      throw new Error('preparation did not commit');
    });
    const { response, signal } = await prepareThroughStack();
    expect(signal.aborted).toBe(true);
    expect(preparePortMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { code: 'timeout' } });
  });
});

describe('session-port evidence in an earlier carry-respawn incarnation (WI-10003198)', () => {
  // A carry-respawn rewrites its owner's row in place, so the router's matched
  // turns routinely live in a session the row no longer names. Measured shape:
  // fa2b9674 is an earlier incarnation of su-5078d176, whose row carries f56ecb13.
  const EARLIER = 'fa2b9674-2646-42fa-9135-3909f93fcd9a';
  const seedEarlier = async (owner: string) => {
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, ts, speaker, text, owner)
      VALUES
        (${WS}, 'claude', ${EARLIER}, 2, '2026-09-23T07:01:00.000Z'::timestamptz, 'user', 'earlier evidence', ${owner}),
        (${WS}, 'claude', ${EARLIER}, 4, '2026-09-23T07:02:00.000Z'::timestamptz, 'assistant', 'earlier answer', ${owner})
    `;
  };

  it('ports the exact selected incarnation without requiring consult evidence', async () => {
    await seedEarlier('su-source');
    const response = await inspect({ sourceNativeSessionId: EARLIER, consultEvidenceSpan: null });
    expect(response.status).toBe(200);
    expect(state.acquiredRow).toMatchObject({ id: 41, coordOwnerId: 'su-source', sessionId: EARLIER });
    expect(state.inspectArgs).toMatchObject({ sourceRow: { sessionId: EARLIER } });
    expect(state.sourceRow).toMatchObject({ sessionId: SESSION });
  });

  it('verifies ownership once when selected incarnation and consult evidence identify the same source', async () => {
    await seedEarlier('su-source');
    let ownershipReads = 0;
    state.sql = new Proxy(sql, {
      apply(target, thisArg, args) {
        const template = args[0] as TemplateStringsArray;
        if (Array.isArray(template) && template.join(' ').includes('SELECT t.owner')) ownershipReads++;
        return Reflect.apply(target, thisArg, args);
      },
    });
    try {
      const response = await inspect({
        sourceNativeSessionId: EARLIER,
        consultEvidenceSpan: { sessionId: EARLIER, turnIndices: [2, 4], contextTurns: 2 },
      });
      expect(response.status).toBe(200);
      expect(state.acquiredRow).toMatchObject({ coordOwnerId: 'su-source', sessionId: EARLIER });
      expect(state.inspectArgs).toMatchObject({
        sourceRow: { sessionId: EARLIER }, evidenceSpan: { sessionId: EARLIER },
      });
      expect(ownershipReads).toBe(1);
    } finally {
      state.sql = sql;
    }
  });

  it('refuses a selected incarnation belonging to another owner before reading any transcript', async () => {
    await seedEarlier('su-someone-else');
    const response = await inspect({ sourceNativeSessionId: EARLIER, consultEvidenceSpan: null });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('sourceNativeSessionId') });
    expect(state.acquiredRow).toBeNull();
    expect(state.inspectArgs).toBeNull();
  });

  it('refuses a selected incarnation indexed only under another backend', async () => {
    await sql`
      INSERT INTO harness_shared.session_turns (workspace_id, source_kind, session_id, turn_idx, speaker, text, owner)
      VALUES (${WS}, 'codex', ${EARLIER}, 2, 'user', 'foreign backend', 'su-source')
    `;
    const response = await inspect({ sourceNativeSessionId: EARLIER, consultEvidenceSpan: null });
    expect(response.status).toBe(400);
    expect(state.acquiredRow).toBeNull();
  });

  it.each([null, '', ' ', 42, {}])('refuses malformed exact source selection %j', async (sourceNativeSessionId) => {
    const response = await inspect({ sourceNativeSessionId, consultEvidenceSpan: null });
    expect(response.status).toBe(400);
    expect(state.acquiredRow).toBeNull();
  });

  it('accepts the explicitly selected current session without requiring an owner index', async () => {
    const response = await inspect({ sourceNativeSessionId: SESSION, consultEvidenceSpan: null });
    expect(response.status).toBe(200);
    expect(state.acquiredRow).toMatchObject({ sessionId: SESSION });
  });

  it('refuses consult evidence that would replace the explicitly selected session', async () => {
    await seedEarlier('su-source');
    const response = await inspect({ sourceNativeSessionId: EARLIER });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'consultEvidenceSpan must match sourceNativeSessionId' });
    expect(state.acquiredRow).toBeNull();
  });

  it('ports the earlier incarnation when session_turns names the row owner as its latest owner', async () => {
    await seedEarlier('su-source');
    const response = await inspect({ consultEvidenceSpan: { sessionId: EARLIER, turnIndices: [2, 4], contextTurns: 2 } });
    expect(response.status).toBe(200);
    // The transcript acquired and inspected is the earlier incarnation's, under
    // the row's own identity — never the row's current session.
    expect(state.acquiredRow).toMatchObject({ id: 41, coordOwnerId: 'su-source', sessionId: EARLIER });
    const args = state.inspectArgs as { sourceRow: { sessionId: string }; evidenceSpan: { sessionId: string; evidenceTurns: unknown[] } };
    expect(args.sourceRow.sessionId).toBe(EARLIER);
    expect(args.evidenceSpan.sessionId).toBe(EARLIER);
    expect(args.evidenceSpan.evidenceTurns).toHaveLength(2);
  });

  it('refuses a session latest-owned by a different owner, before acquiring anything', async () => {
    await seedEarlier('su-someone-else');
    const response = await inspect({ consultEvidenceSpan: { sessionId: EARLIER, turnIndices: [2, 4], contextTurns: 2 } });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('earlier incarnation of its owner') });
    expect(state.acquiredRow).toBeNull();
    expect(state.inspectArgs).toBeNull();
  });
});
