/**
 * MCP transport gating matrix — drives the REAL `tools/list` / `tools/call`
 * request handlers registered by routes/transport/_mcp-handler.ts and pins
 * the auth → role → profile → workspace boundary end-to-end (the
 * "handler-path test for that wiring" that tool-auth-gating.test.ts's header
 * records as still owed).
 *
 * NOT duplicated here (already covered elsewhere):
 *   - tool-auth-gating.test.ts — the projected WRAPPER's principal+tx gate
 *     (`t.fn({}, {})` throws), work_items:list's identity gate, and the
 *     operator-converse allowedTools↔registry sync.
 *   - transport-mcp-notifications.test.ts — buildMcpToolContext's emit /
 *     notifications/progress wiring.
 *   - tool-allowlist.test.ts — parseToolsAllowlist/filterListingsByAllowlist
 *     as unit functions (here we only pin their WIRING into tools/list).
 *   - role-principal-caps.test.ts — loadRoleCapabilities row/blueprint logic
 *     and effectiveDispatchWorkspace as a unit (here: its dispatch wiring).
 *
 * Harness: `createMcpHandler` is mocked to capture the JSON-RPC request
 * handlers; the registry is the REAL one (explicitly warmed through the
 * transport's lazy loader) plus two synthetic probe tools under the 'gating-matrix-test'
 * plugin. PG seams (db-org, spawn-signing, power-user-token, superuser
 * bearer, harness paths) are stubbed; everything between the request handler
 * and the tool fn — tryBuildSpawnContext, the profile gate, the power-user
 * clamp, EI-30 workspace promotion, tx/principal synthesis, the tooldef
 * dispatch stack — runs for real.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, createConnection } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import { UdsMcpTransport } from '@papercusp/tooldef-mcp';
import { AGENT_MCP_AUTH_META, startAgentMcpServer } from '../routes/transport/_mcp-uds';
import type { Principal, UnifiedToolContext } from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS, PAYLOAD_TIER_RATCHET_CHARS, setEntityEnum } from '@papercusp/tooldef';
import { _resetVerifiedSpawns } from '../../spawn-signing';
import { mintConverseChatBinding } from '../../agent-tools/operator/converse-chat-binding';
import { resetResultDoorAggregatesForTests } from '../../result-door';
import { parseScratchReference } from '../../scratch-reference';
import { MAX_PICK_PATHS, NAMED_VIEWS } from '../../result-projection';
import { PLATFORM_POT_SLUG } from '../../platform-pot-slug';
import { MCP_REQUEST_TRACE_HEADER } from '../../mcp-request-trace';
import type { BuiltSpawnContext } from '../routes/transport/_mcp-host';
import type { McpCallResult } from '../routes/transport/mcp-diagnostic-warnings';
import { bindAdmissionAuthority, admissionCredentialDigest } from '../../work-item-admission-authority';
import { configurePrePromptRegistry, clearPrePromptRegistry } from '@papercusp/result-encoding';
import { _resetBatchNudgeState } from '../../code-run-batch-nudge';

const h = vi.hoisted(() => {
  const fakeTx = Object.assign(async (..._a: unknown[]) => [] as unknown[], {
    unsafe: async (..._a: unknown[]) => [] as unknown[],
  });
  const kernelAuthority = {
    rows: null as Array<Record<string, unknown>> | null,
    launchRecord: null as { launch_spec: unknown; launch_spec_xmin: string } | null,
    migrationRead: null as null | (() => Promise<unknown[]>),
    usedToolNames: null as string[] | null,
  };
  const fakeSql = Object.assign(async (...args: unknown[]) => {
    const template = args[0];
    const query = Array.isArray(template) ? template.join(' ') : typeof template === 'string' ? template : '';
    if (kernelAuthority.usedToolNames && query.includes('SELECT DISTINCT tool_name')) {
      return kernelAuthority.usedToolNames.map(tool_name => ({ tool_name }));
    }
    if (kernelAuthority.launchRecord && query.includes('AS launch_spec, n.launch_spec_xmin')) {
      return [kernelAuthority.launchRecord];
    }
    // Serving-generation is part of every real tools/list baseline. Keep this
    // PG-free transport fixture on a known migration frontier so the matrix
    // exercises auth/dispatch wiring instead of failing before listing tools.
    if (query.includes('harness_shared.schema_migrations')) {
      if (kernelAuthority.migrationRead) return kernelAuthority.migrationRead();
      return [
        { filename: '001-core.sql', sha256: 'sha-core' },
        { filename: '1489-fallback-observations-samples.sql', sha256: 'sha-1489' },
      ];
    }
    if (kernelAuthority.rows && query.includes('FROM harness_shared.session_briefs') &&
        query.includes('FROM harness_shared.adv_sessions s')) return kernelAuthority.rows;
    return [] as unknown[];
  }, {
    unsafe: async (..._a: unknown[]) => [] as unknown[],
    begin: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(fakeTx),
    reserve: async (): Promise<unknown> => Object.assign(fakeSql, { release: () => undefined }),
  });
  return {
    realSpawnSigning: null as null | typeof import('../../spawn-signing'),
    signingRows: null as null | Array<{ value_b64: string; rotated_at: string }>,
    fakeTx,
    fakeSql,
    flushPendingTelemetry: vi.fn(async () => {}),
    kernelAuthority,
    nativeSessionBinding: 'unbound' as 'bound' | 'unbound' | 'foreign',
    nativeSessionRows: null as Map<string, Array<{ id: number; session_id: string | null; active: boolean }>> | null,
    livePtyHost: null as {
      ownerId: string; advSessionId: string | null; pid: number; ptyPid: number | null;
      sock: string; command: string; startedAt: number; nativeSessionId?: string | null;
    } | null,
    nativeSessionVerifierFailure: null as { sessionId: string; error: Error } | null,
    nativeSessionCalls: [] as Array<{ ownerId: string; sessionId: string }>,
    nativeSessionWorkspaceScopes: [] as Array<string | undefined>,
    nativeSessionDiagnosticContexts: [] as unknown[],
    nativeVerifierSampling: [] as unknown[][],
    /** EI-21641783475680586: deterministic getRubric seam for the nested transport test. */
    rubricGet: vi.fn(async (_rubricRef: string): Promise<unknown> => null),
    /** EI-25857690731655159: deterministic handler seam for dev:build_status clamp tests. */
    devBuildStatus: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
    devTestFlakeRollup: vi.fn(async (_days: number) => ({ entries: [] as unknown[] })),
    devFlagFlakeSuspects: vi.fn((_entries: unknown[], _days: number) => [] as unknown[]),
    /** EI-22390450916579377: plugin-host warm seam for late projected-tool registration. */
    pluginHostWarm: vi.fn(async (): Promise<unknown> => ({})),
    /** scoped-superuser-workspace-clamp: dispatch tests toggle the flag via this. */
    scopedClampFlag: { value: false },
    /** Hive-tier resolver seam: maps a harness → its hive home slug (null = no hive). */
    potHomeSlugForHarness: vi.fn(
      async (_ws: string, harness: string): Promise<string | null> =>
        harness === 'hiveA-home' || harness === 'hiveA-member'
          ? 'hiveA-home'
          : harness === 'hiveB-home'
            ? 'hiveB-home'
            : null,
    ),
    /**
     * Workspace-tier resolver seam (P-017): maps (preferredWs, harness) → the
     * workspace that carries the harness. 'foreign-ws-harness' lives in another
     * workspace; 'unregistered-harness' is nowhere; everything else resolves to
     * the caller's OWN (preferred) workspace.
     */
    resolveWorkspaceForHarnessSlugIn: vi.fn(
      async (preferredWs: string, harness: string): Promise<string | null> =>
        harness === 'foreign-ws-harness'
          ? 'other-ws'
          : harness === 'unregistered-harness'
            ? null
            : preferredWs,
    ),
    /** Every workspace id the (mocked) withWorkspace opened a tx for. */
    withWorkspaceCalls: [] as string[],
    /** Make the next workspace acquisition fail before the callback starts. */
    failNextWorkspaceAcquire: false,
    /** Inject a non-retryable acquisition failure before the callback starts. */
    workspaceAcquireError: null as Error | null,
    /**
     * EI-19301511582594101 seam. postgres-js `sql.begin` COMMITs when its callback
     * resolves, so a failing COMMIT surfaces as a rejection from withWorkspace
     * AFTER the tool already produced its result. Set this to make the mocked
     * transaction fail exactly there.
     */
    commitFailure: null as Error | null,
    /**
     * Ordered log of the two durability events that must not invert:
     * 'commit' (the tool's tx) then 'store' (the replay receipt).
     */
    txEvents: [] as string[],
    /** Replay receipts the handler asked to persist. */
    replayStores: [] as Array<{ ownerKey: string; idempotencyKey: string; result: unknown }>,
    replayLookupFromStores: false,
    afterReplayStore: null as null | (() => Promise<void>),
    /**
     * WI-6792 seam: the stored outcome `lookupStoredMcpResult` finds, or null for
     * "no stored result" (the default — every other case in this file must keep
     * executing its tool normally).
     */
    storedReplay: null as {
      content: Array<Record<string, unknown>>;
      _meta?: Record<string, unknown>;
      structuredContent?: unknown;
      replaySource?: {
        content: Array<Record<string, unknown>>;
        _meta?: Record<string, unknown>;
        structuredContent?: unknown;
      };
    } | null,
    /**
     * WI-6792: every telemetry row the handler/dispatcher recorded. A replayed
     * call returns before dispatch, so this is the ONLY place its row can come
     * from — an empty log for a replay is exactly the invisible-replay bug.
     */
    deliveryBackfills: [] as Array<{ toolName: string; mcpRequestTraceId?: string | null; metadataJson: Record<string, unknown> }>,
    invocations: [] as Array<{
      toolName: string;
      status: string;
      windowKey: string;
      ctx: {
        role?: string;
        runId?: string | null;
        spawnId?: string;
        harnessSlug?: string;
        workspaceId?: string;
        uiClientId?: string | null;
        advSessionId?: UnifiedToolContext['advSessionId'];
        isSuperuser?: boolean;
        transport?: string;
        principal?: UnifiedToolContext['principal'];
        requestOrigin?: UnifiedToolContext['requestOrigin'];
      };
      args?: unknown;
      metadataJson?: Record<string, unknown> | null;
      errorMessage?: string | null;
      errorCode?: string | null;
    }>,
    handlers: new Map<string, (req: unknown, extra: unknown) => Promise<unknown>>(),
    resourceReads: [] as Array<Record<string, unknown>>,
    verifySpawnParams: vi.fn(
      async (_u: unknown, _options?: { includeKeyDigest?: boolean }): Promise<{ ok: boolean; reason?: string; keySha256?: string }> => ({ ok: true }),
    ),
    logVerificationFailure: vi.fn(async (_rec: unknown): Promise<void> => {}),
    verifyAccessToken: vi.fn(
      async (_bearer: string): Promise<Record<string, unknown> | null> => null,
    ),
    isValidSuperuserBearer: vi.fn(
      (bearer: string | null | undefined): boolean => bearer === 'test-su-bearer',
    ),
    resolveBearer: vi.fn(async (_bearer: string | null): Promise<Principal | null> => null),
    /** SID→adv-row workspace fallback seam (psu-workspace-scoping fix). */
    workspaceForCoordOwner: vi.fn(async (_sid: string): Promise<string | null> => null),
    /** Ambient presence seam for transport harness-scope inheritance tests. */
    getPresence: vi.fn(async (_ownerId: string): Promise<Record<string, unknown> | null> => null),
    /** Presence transport-clamp tests must not launch host liveness/process probes. */
    assemblePresenceSnapshot: vi.fn(),
    /** Durable session-brief harness fallback seam for resumed SU sessions. */
    getSessionBrief: vi.fn(
      async (_query: { ownerId?: string | null }): Promise<{ harnessSlug?: string | null } | null> => null,
    ),
    /** Exact-slug owner proof seam for the narrow resumed-monitor plans:get rebind. */
    verifyExplicitPlanHarness: vi.fn(
      async (_ctx: unknown, _explicitHarness: string, _args: unknown): Promise<boolean> => false,
    ),
    /** EI-223466: transport-only seam for goal-authorized local placement. */
    goalLocalPlacement: {
      allow: false,
      calls: [] as Array<Record<string, string>>,
    },
    /** WI-10007010: isolate the accepted-operation tools/list candidate path. */
    identityListingTest: false,
    identitySurfacePhases: null as { intervals: () => Array<{ phase: string }> } | null,
    identityListingUnresolved: false,
    identityOperationRecord: null as unknown,
    identityAdmittedToolNames: new Set<string>(),
    identityListingRoleCaps: [] as readonly string[],
    identityObservedRoleCaps: [] as string[],
    identityListedCandidateNames: [] as string[],
    readSessionConfinement: vi.fn(async (_owner: string | null | undefined, _workspace?: string):
      Promise<import('../../capability-envelope/session-confinement').SessionToolConfinement | null> => null),
  };
});

// Capture the ListTools/CallTool handlers instead of standing up the real
// streamable-HTTP transport. Keyed by the SDK schema's method literal.
vi.mock('mcp-handler', () => ({
  createMcpHandler: (
    setup: (server: {
      server: { setRequestHandler: (schema: unknown, fn: unknown) => void };
    }) => void,
  ) => {
    setup({
      server: {
        setRequestHandler: (schema: unknown, fn: unknown) => {
          const s = schema as {
            shape?: { method?: { value?: string; _def?: { value?: string } } };
          };
          const method = s?.shape?.method?.value ?? s?.shape?.method?._def?.value;
          h.handlers.set(String(method), fn as (req: unknown, extra: unknown) => Promise<unknown>);
        },
      },
    });
    return async () => new Response(null);
  },
}));

// PG seams. Spread the real modules so the wide agent-tools import graph keeps
// every other export; only the connection/verification leaves are stubbed.
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getOrgPg: () => ({
      sql: h.fakeSql,
      db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => {
        if (!h.signingRows) throw new Error('Signing DB fixture must be explicitly installed');
        return h.signingRows;
      } }) }) }) },
    }),
    withWorkspace: async <T>(ws: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
      h.withWorkspaceCalls.push(ws);
      if (h.workspaceAcquireError) {
        const error = h.workspaceAcquireError;
        h.workspaceAcquireError = null;
        throw error;
      }
      if (h.failNextWorkspaceAcquire) {
        h.failNextWorkspaceAcquire = false;
        const Deadline = actual.DbCallDeadlineError as new (
          label: string,
          deadlineMs: number,
          elapsedMs: number,
          pool?: string,
        ) => Error & { retryable: boolean };
        const error = new Deadline('withWorkspace:acquire(app)', 45_000, 45_000, 'org-app');
        // The real constructor derives this from the acquire registry. The
        // mock does not open a pool, so mark this synthetic error as the
        // measured pool-pressure case the retry wrapper is meant to handle.
        Object.defineProperty(error, 'retryable', { value: true });
        throw error;
      }
      const out = await fn(h.fakeTx);
      // The COMMIT happens HERE — after the callback resolves — which is why a
      // receipt persisted inside the callback could outlive a write that never
      // landed (EI-19301511582594101).
      if (h.commitFailure) throw h.commitFailure;
      h.txEvents.push('commit');
      return out;
    },
  };
});
// scheduler:get_next deliberately uses its own small admin pool so ordinary
// MCP reads cannot starve claims. It imports that accessor from the local pool
// module (not @papercusp/db-org), so pin the exact import seam to this test's
// empty SQL double. Otherwise this unit test escapes to the live scheduler DB
// and its result depends on whatever schema/data happen to be deployed.
vi.mock('../../long-lived-admin-pool', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getLongLivedAdminPool: () => h.fakeSql,
  };
});
// EI-19301511582594101: observe replay-receipt persistence without a live PG.
// Plain functions, not vi.fn(), so the suite-wide vi.resetAllMocks() in beforeEach
// cannot strip these implementations out from under the ordering assertions.
vi.mock('../routes/transport/_mcp-result-replay', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // WI-6792: `null` unless a case arms h.storedReplay — the real lookup tags
    // the envelope `_meta.replayed`, so mirror that here.
    lookupStoredMcpResult: async (ownerKey: string, idempotencyKey: string): Promise<Record<string, unknown> | null> => {
      const stored = h.replayLookupFromStores
        ? [...h.replayStores].reverse().find(row => row.ownerKey === ownerKey && row.idempotencyKey === idempotencyKey)?.result as typeof h.storedReplay
        : h.storedReplay;
      return stored ? { ...stored, _meta: { ...(stored._meta ?? {}), replayed: true } } : null;
    },
    storeMcpResult: async (a: {
      ownerKey: string;
      idempotencyKey: string;
      result: unknown;
      replaySource?: unknown;
    }): Promise<void> => {
      h.txEvents.push('store');
      const result = a.replaySource && a.result && typeof a.result === 'object'
        ? { ...(a.result as Record<string, unknown>), replaySource: a.replaySource }
        : a.result;
      h.replayStores.push({ ownerKey: a.ownerKey, idempotencyKey: a.idempotencyKey, result });
      await h.afterReplayStore?.();
    },
  };
});
// WI-6792: observe the telemetry rows without a live PG. Spread the real deps so
// quota windowing / envelope / override behavior stays REAL — only the terminal
// write is captured. A plain function (not vi.fn()) so the suite-wide
// vi.resetAllMocks() cannot strip it out from under the assertions.
vi.mock('../../projected-tool-deps', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realDeps = actual.PROJECTED_DEPS as Record<string, unknown>;
  return {
    ...actual,
    flushPendingTelemetry: h.flushPendingTelemetry,
    backfillToolInvocationMetadataByMcpRequestTraceId: async (input: (typeof h.deliveryBackfills)[number]) => {
      h.deliveryBackfills.push(input);
    },
    PROJECTED_DEPS: {
      ...realDeps,
      recordInvocation: async (input: (typeof h.invocations)[number]): Promise<void> => {
        h.invocations.push(input);
      },
    },
  };
});
vi.mock('../../capability-envelope/blueprint-envelopes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../capability-envelope/blueprint-envelopes')>();
  return {
    ...actual,
    blueprintWorkerRoleCapabilities: (stateDir: string, role: string) =>
      h.identityListingTest && role === 'calendar-prep-worker'
        ? h.identityListingRoleCaps
        : actual.blueprintWorkerRoleCapabilities(stateDir, role),
  };
});
vi.mock('../../capability-envelope/identity-tool-surface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../capability-envelope/identity-tool-surface')>();
  return {
    ...actual,
    resolveIdentityToolSurface: async (...args: Parameters<typeof actual.resolveIdentityToolSurface>) => {
      if (!h.identityListingTest) return actual.resolveIdentityToolSurface(...args);
      const [ctx, candidates, , expandCandidates, phases] = args;
      h.identitySurfacePhases = phases ?? null;
      const receiptCandidates = expandCandidates?.(h.identityOperationRecord) ?? [];
      h.identityObservedRoleCaps = [...(ctx.principal?.capabilities ?? [])];
      if (h.identityListingUnresolved) return { kind: 'unresolved', key: 'gating-matrix-operation' };
      const admitted = new Set(
        [...candidates, ...receiptCandidates]
          .filter((candidate) => h.identityAdmittedToolNames.has(candidate.name))
          .map((candidate) => candidate.name),
      );
      return { kind: 'governed', key: 'gating-matrix-operation', admitted };
    },
    rememberListedIdentitySurface: (...args: Parameters<typeof actual.rememberListedIdentitySurface>) => {
      if (h.identityListingTest) {
        h.identityListedCandidateNames = args[1].candidates.map((candidate) => candidate.name);
      }
      return actual.rememberListedIdentitySurface(...args);
    },
  };
});
vi.mock('../../capability-envelope/session-confinement-store', async importOriginal => ({
  ...(await importOriginal<typeof import('../../capability-envelope/session-confinement-store')>()),
  readSessionConfinement: (owner: string | null | undefined, workspace?: string) =>
    h.readSessionConfinement(owner, workspace),
}));
vi.mock('../../spawn-signing', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  h.realSpawnSigning = actual as typeof import('../../spawn-signing');
  return {
    ...actual,
    verifySpawnParams: h.verifySpawnParams,
    logVerificationFailure: h.logVerificationFailure,
  };
});
// classifyAndConsumeFailure/recordVerifiedSpawn stay REAL (part of the matrix
// under test) and track state in a process-global Map keyed by spawn id —
// every case here reuses the SAME 'spawn-1' id (see signedUrl()), so a case
// that mocks verifySpawnParams to succeed marks 'spawn-1' verified for the
// rest of the file unless reset; a later failing case then gets misclassified
// as a 'rotation_strand' (console.error incident log) instead of 'unverified'.
vi.mock('../../power-user-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, verifyAccessToken: h.verifyAccessToken };
});
vi.mock('../../superuser-token', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // isLoopbackRequest stays REAL (pure header logic — part of the matrix).
  return { ...actual, isValidSuperuserBearer: h.isValidSuperuserBearer };
});
// PI authentication is the only additional external seam. The MCP context
// builder, capability gate, real ask-choice handler and card correlator run.
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  resolveBearer: h.resolveBearer,
  readResource: async (opts: { uri: string; bearer?: string; principal?: Principal }) => {
    h.resourceReads.push({ ...opts });
    return { ok: true, contents: { uri: opts.uri, mimeType: 'text/plain', text: 'spill contents' } };
  },
}));
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../events/await/psu-pty-discovery')>();
  return {
    ...actual,
    findLiveHost: (ownerId: string, dir?: string, options?: Parameters<typeof actual.findLiveHost>[2]) =>
      ownerId === 'su-owner' && h.livePtyHost
        ? h.livePtyHost
        : actual.findLiveHost(ownerId, dir, options),
  };
});
vi.mock('../../adv-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../adv-sessions')>();
  return {
    ...actual,
    workspaceForCoordOwner: h.workspaceForCoordOwner,
    classifyOwnerNativeSession: async ({
      ownerId,
      sessionId,
      workspaceId,
    }: { ownerId: string; sessionId: string; workspaceId?: string }) => {
      h.nativeSessionCalls.push({ ownerId, sessionId });
      h.nativeSessionWorkspaceScopes.push(workspaceId);
      const { capturePgDiagnosticContext } = await import('@papercusp/db-org');
      h.nativeSessionDiagnosticContexts.push(capturePgDiagnosticContext());
      const verifierFailure = h.nativeSessionVerifierFailure;
      if (verifierFailure?.sessionId === sessionId) {
        const { traceNamedQueryStage } = await import('../../agent-tools/db-diagnostic-correlation-wiring');
        return await traceNamedQueryStage('native-session-verifier-global-transaction', async () => {
          throw verifierFailure.error;
        });
      }
      if (h.nativeSessionRows) {
        return actual.classifyOwnerNativeSessionRows(h.nativeSessionRows.get(ownerId) ?? [], sessionId);
      }
      return {
        binding: h.nativeSessionBinding,
        boundSessionId: h.nativeSessionBinding === 'foreign' ? 'native-parent' : h.nativeSessionBinding === 'bound' ? sessionId : null,
        advSessionId: 1,
      };
    },
  };
});
vi.mock('../../agent-tools/coordination/presence', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getPresence: h.getPresence };
});
// This suite verifies MCP transport authorization, not the host's process
// liveness. The real snapshot can probe desktop windows and the spawner sidecar;
// this PG-free fixture would then report every task-ledger INSERT as a duplicate
// because its SQL double returns no rows. Keep scope resolution real, but stop
// at the snapshot boundary so ambient process state cannot red-pin the clamp test.
vi.mock('../../agent-tools/coordination/presence-snapshot', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, assemblePresenceSnapshot: h.assemblePresenceSnapshot };
});
vi.mock('../../session-brief', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getSessionBrief: h.getSessionBrief };
});
vi.mock('../../resolve-harness-paths', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveHarnessPaths: async () => ({
      projectDir: '/tmp/gating-matrix-proj',
      stateDir: '/tmp/gating-matrix-state',
    }),
  };
});
// scoped-superuser-workspace-clamp: toggle ONLY this flag via h.scopedClampFlag;
// every other flag defers to the real resolver (PG is stubbed → FLAG_DEFAULTS),
// so existing cases see unchanged flag behavior.
vi.mock('@papercusp/flags/server', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getFlag: async (key: string, scope?: string) =>
      key === 'papercusp-scoped-superuser-clamp'
        ? h.scopedClampFlag.value
        : (actual.getFlag as (k: string, s?: string) => Promise<boolean>)(key, scope),
  };
});
vi.mock('../../hive-federation', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, potHomeSlugForHarness: h.potHomeSlugForHarness };
});
// Keep this transport matrix PG-free while dispatching the registered
// rubrics:get implementation through the real nested tools:invoke path.
vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, getRubric: h.rubricGet };
});
// The transport matrix tests the real registered handler path, but keeps the
// host probes and flake scan deterministic and independent of local services.
vi.mock('../../dev-data', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildStatus: h.devBuildStatus,
    testFlakeRollup: h.devTestFlakeRollup,
    flagFlakeSuspects: h.devFlagFlakeSuspects,
  };
});
// P-017 workspace-tier clamp seam — only the foreign-workspace harness resolver
// is stubbed; the rest of harness-core stays real (the wide agent-tools import graph).
vi.mock('../../harness-core', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveWorkspaceForHarnessSlugIn: h.resolveWorkspaceForHarnessSlugIn };
});
// The handler-path matrix supplies the exact-slug owner proof directly. The
// helper's workspace/index semantics are covered in slug-scope.test.ts; this
// seam keeps these tests about the transport clamp and effective dispatch ctx.
vi.mock('../../agent-tools/plans/slug-scope', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, verifyExplicitPlanHarness: h.verifyExplicitPlanHarness };
});
// EI-223466: keep the handler matrix focused on transport wiring; the helper's
// authority/link/visibility proof is covered in goal-local-placement.test.ts.
vi.mock('../routes/transport/goal-local-placement', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    goalHolderMayPlaceIntoLocalPot: async (input: Record<string, string>): Promise<boolean> => {
      h.goalLocalPlacement.calls.push(input);
      return h.goalLocalPlacement.allow;
    },
  };
});
// This matrix verifies transport authorization, not embedding-provider latency.
// Keep the recall tools on their documented lexical fallback so the scoped-safe
// allowlist assertion cannot spend its 5s test budget on a live query embed.
vi.mock('../../agent-tools/search/embedder', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    buildQueryEmbedder: async () => null,
    buildQueryEmbedderResolved: async () => null,
  };
});
vi.mock('../../plugin-host-runtime', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getPluginHost: (): Promise<unknown> => h.pluginHostWarm(),
  };
});
vi.mock('../routes/transport/pgbouncer-pool-sample.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    // A never-settling promise proves verifier failure handling does not await
    // the out-of-band diagnostic before returning its fail-closed auth result.
    samplePgBouncerPools: (...args: unknown[]) => {
      h.nativeVerifierSampling.push(args);
      return new Promise(() => {});
    },
  };
});

// _mcp-handler's transport setup calls a bare `require(...)` for the MCP SDK
// schemas; under vite-node's ESM transform there is no module-scope require,
// so provide the global fallback before the module loads.
(globalThis as { require?: NodeJS.Require }).require ??= createRequire(import.meta.url);
// No pinned tool manifest — tools/list must expose the live registry.
process.env.AGENT_MCP_TOOL_MANIFEST = '/nonexistent/gating-matrix-no-manifest.json';
delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;

const { __buildMcpToolContext_forTests, mcpHandler, resolveMcpTargetAfterPluginHostWarm } =
  await import('../routes/transport/_mcp-handler');
const { registerProjectedTool, unregisterProjectedToolsForPlugin, lookupByMcpName, listMcpProjections, getCatalog, defineTool, subscribeWorkspace, resolveCardResponse } =
  await import('@papercusp/agent-mcp');
const { currentRequestWorkspaceId } = await import('../../workspace-als');
const { registerMcpHost, mcpHostServerOptions, MCP_SERVER_CAPABILITIES, tryBuildSpawnContext, pinVerifiedMcpRequest, runNativeMcpTargetOnOwner } =
  await import('../routes/transport/_mcp-host');

// `_mcp-handler` now defers both the operator tool graph and mcp-handler's
// process-wide cleanup interval until the first real HTTP request. Warm that
// production path once so this fixture can capture the same request handlers
// while keeping direct helper imports one-shot and side-effect-free.
// A LOCAL caller: a real one always sends a loopback Host, and a host-less outside request is
// answered at the edge with the P-006 OAuth 401 before the host (and its handlers) ever load.
await mcpHandler(new Request('http://127.0.0.1/api/mcp', { headers: { host: '127.0.0.1' } }));

/* ─── Synthetic probe tools ──────────────────────────────────────────── */

interface SeenCall {
  tool: string;
  args: unknown;
  ctx: UnifiedToolContext;
  /** The request-scoped ALS workspace at handler time (P-022 pin). */
  alsWorkspace: string | undefined;
}
const seen: SeenCall[] = [];
const LATE_PLUGIN_NAME = 'gating-matrix-late-plugin';
const LATE_PLUGIN_TOOL = 'gating-late.arrives';
const latePluginSeen: unknown[] = [];
const replayValidationSeen: unknown[] = [];
const replayBusinessErrorSeen: unknown[] = [];

function probeFn(name: string) {
  return async (input: unknown, ctx: UnifiedToolContext) => {
    seen.push({ tool: name, args: input, ctx, alsWorkspace: currentRequestWorkspaceId() });
    return { content: [{ type: 'text' as const, text: `${name}-ok` }] };
  };
}

let cancellationProbe: null | {
  started: () => void; aborted: () => void; release: () => void;
} = null;
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'P007 real dispatcher cancellation witness',
  inputSchema: { type: 'object', additionalProperties: false },
  capabilities: [], agentRoles: ['scoper'],
  expose: { mcp: { name: 'gatingtest:cancel' } },
  fn: async (_input, ctx) => {
    await new Promise<void>(resolve => {
      const abort = () => { cancellationProbe!.aborted(); resolve(); };
      cancellationProbe!.release = () => {
        ctx.signal.removeEventListener('abort', abort);
        resolve();
      };
      ctx.signal.addEventListener('abort', abort, { once: true });
      cancellationProbe!.started();
      if (ctx.signal.aborted) abort();
    });
    return { content: [{ type: 'text' as const, text: 'cancelled-fixture' }] };
  },
});

function registerLatePluginTool(): void {
  registerProjectedTool({
    pluginName: LATE_PLUGIN_NAME,
    description: 'test-only plugin tool registered while tools:invoke waits for host warm-up',
    inputSchema: { type: 'object', additionalProperties: false },
    capabilities: [],
    requirePrincipal: false,
    agentRoles: ['operator'],
    expose: { mcp: { name: LATE_PLUGIN_TOOL } },
    fn: async (input) => {
      latePluginSeen.push(input);
      return { content: [{ type: 'text' as const, text: 'late-plugin-ok' }] };
    },
  });
}

registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: role-gated to scoper',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['scoper'],
  needsWorkspaceTx: true,
  expose: { mcp: { name: 'gatingtest:scoped' } },
  fn: probeFn('gatingtest:scoped'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: engineer-profile, operator role',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['operator'],
  profile: 'engineer',
  needsWorkspaceTx: true,
  expose: { mcp: { name: 'gatingtest:engineer' } },
  fn: probeFn('gatingtest:engineer'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: crossWorkspace (spans workspaces)',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['operator'],
  crossWorkspace: true,
  needsWorkspaceTx: true,
  expose: { mcp: { name: 'gatingtest:crossworkspace' } },
  fn: probeFn('gatingtest:crossworkspace'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: txless target retains caller harness scope',
  inputSchema: { type: 'object', additionalProperties: false },
  capabilities: [],
  requirePrincipal: false,
  agentRoles: ['operator'],
  expose: { mcp: { name: 'gatingtest:txless_scope' } },
  fn: probeFn('gatingtest:txless_scope'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: a cross_harness-prefixed tool (reads other harnesses)',
  inputSchema: { type: 'object', additionalProperties: true },
  capabilities: [],
  agentRoles: ['operator'],
  expose: { mcp: { name: 'cross_harness:probe' } },
  fn: probeFn('cross_harness:probe'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: read-only MCP annotation',
  inputSchema: { type: 'object', additionalProperties: false },
  capabilities: [],
  effect: 'read',
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'gatingtest:read_annotation' } },
  fn: probeFn('gatingtest:read_annotation'),
});
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: write MCP annotation',
  inputSchema: { type: 'object', additionalProperties: false },
  capabilities: [],
  effect: 'write',
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'gatingtest:write_annotation' } },
  fn: probeFn('gatingtest:write_annotation'),
});

const deltaRequested: Array<string | undefined> = [];
// P006 uses the existing real dispatcher + mocked persistence/auth fixture,
// rather than maintaining a second copy of the host's dependency mocks.
const parityCalls: Array<{ args: unknown; ctx: UnifiedToolContext }> = [];
const PARITY_ROWS = [{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'done' }];
const LARGE_PARITY_PAYLOAD = {
  rows: Array.from({ length: 100 }, (_, i) => ({
    id: `WI-${i}`,
    state: i % 2 === 0 ? 'todo' : 'done',
    detail: 'structured-content regression '.repeat(8),
  })),
};
defineTool({
  name: 'gatingtest:parity_rows',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({ page: z.string().optional() }),
  result: z.array(z.object({ id: z.string(), state: z.string() })),
  agentRoles: ['scoper'],
  handler: async (args, ctx) => {
    parityCalls.push({ args, ctx });
    return args.page === 'second'
      ? { data: PARITY_ROWS.slice(1) }
      : { data: PARITY_ROWS.slice(0, 1), nextCursor: 'second', degraded: true, degradedReasons: ['fixture'] };
  },
});
defineTool({
  name: 'gatingtest:parity_structured',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  result: z.object({ rows: z.array(z.object({ id: z.string(), state: z.string() })) }),
  agentRoles: ['scoper'],
  handler: async (_args, ctx) => {
    parityCalls.push({ args: {}, ctx });
    return { data: { rows: PARITY_ROWS } };
  },
});
defineTool({
  name: 'gatingtest:replay_structured_write',
  requirePrincipal: false,
  capability: 'work_items:write',
  needsWorkspaceTx: true,
  args: z.object({ large: z.boolean().optional() }),
  result: z.object({
    rows: z.array(z.object({ id: z.string(), state: z.string(), detail: z.string().optional() })),
  }),
  agentRoles: ['reviewer'],
  handler: async (args, ctx) => {
    parityCalls.push({ args, ctx });
    return { data: { rows: args.large ? LARGE_PARITY_PAYLOAD.rows : PARITY_ROWS } };
  },
});
defineTool({
  name: 'gatingtest:parity_structured_large',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  result: z.object({
    rows: z.array(z.object({ id: z.string(), state: z.string(), detail: z.string() })),
  }),
  agentRoles: ['scoper'],
  handler: async (_args, ctx) => {
    parityCalls.push({ args: {}, ctx });
    return { data: LARGE_PARITY_PAYLOAD };
  },
});
defineTool({
  name: 'gatingtest:parity_args',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({
    id: z.string().optional(),
    state: z.enum(['todo', 'done']).optional(),
    count: z.number().int().optional(),
    enabled: z.boolean().optional(),
    body: z.string().optional(),
    items: z.array(z.object({ id: z.string(), state: z.enum(['todo', 'done']) })).optional(),
  }),
  agentRoles: ['scoper'],
  handler: async (args, ctx) => {
    parityCalls.push({ args, ctx });
    return { data: { ok: true, accepted: args } };
  },
});
defineTool({
  name: 'gatingtest:delta_list',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  agentRoles: ['scoper'],
  handler: async (_input, ctx) => {
    deltaRequested.push(ctx.requestedDelta);
    return {
      data: Array.from({ length: 12 }, (_, i) => ({
        id: `r${i}`,
        label: `row-${i}-padding-for-delta-proxy`,
      })),
    };
  },
  delta: {
    itemKey: (row) => (row as { id: string }).id,
    itemKeyField: 'id',
    schemaVersion: 'gating-delta-v1',
  },
});
// NB: the REAL flags:set (crossWorkspace:true, global flag store) is already registered,
// so the clamp-exemption test below calls it directly — registering a 'flags:set' probe
// here would collide (ToolRegistrationError). We assert only that the GATE doesn't deny it
// (no workspace_forbidden); the handler's own arg-validation result is irrelevant.

// EI-19386035445533031: a `defineTool`-based probe with a genuinely CLOSED arg
// shape (strictArgs — EI-10883), unlike the `registerProjectedTool` probes
// above which declare `additionalProperties: true` and so can never reproduce
// the bug (an unknown key never fails their schema in the first place).
const invokeProbeSeen: unknown[] = [];
defineTool({
  name: 'gatingtest:invoke_target',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({ probe: z.string().optional() }),
  agentRoles: ['scoper'],
  handler: async (input) => {
    invokeProbeSeen.push(input);
    if (input.probe === 'deep') {
      return {
        data: {
          results: [
            {
              threadWindow: {
                posts: [
                  {
                    body: `selected-body-${'x'.repeat(7_000)}`,
                    author_id: 'agent-1',
                    created_ts: '2026-10-06T00:00:00.000Z',
                  },
                ],
              },
            },
          ],
        },
      };
    }
    if (input.probe === 'deep-many') {
      return {
        data: {
          results: [{
            id: 'selected-row',
            checkpoint: 'C'.repeat(10_000),
            threadWindow: {
              posts: Array.from({ length: 6 }, (_, index) => ({
                id: 50 + index,
                thread_id: `thread-${index}`,
                author_id: `agent-${index}`,
                created_ts: `2026-10-06T00:00:0${index}.000Z`,
                body: `selected-body-${index}-${'x'.repeat(1_000)}`,
              })),
            },
          }],
        },
      };
    }
    if (input.probe === 'observation') {
      return {
        data: {
          payload: {
            observation: {
              ratings: [{ clarity: 5, comments: `selected-rating-${'r'.repeat(7_000)}` }],
              subject: `selected-subject-${'s'.repeat(7_000)}`,
            },
          },
        },
      };
    }
    return { data: { lines: ['alpha', 'beta', 'gamma'] } };
  },
});

defineTool({
  name: 'gatingtest:replay_validation',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  effect: 'write',
  args: z.object({ accepted: z.string() }),
  agentRoles: ['scoper'],
  handler: async (input) => {
    replayValidationSeen.push(input);
    return { data: { ok: true, accepted: input.accepted } };
  },
});

defineTool({
  name: 'gatingtest:replay_business_error',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  effect: 'write',
  args: z.object({ value: z.string().optional() }),
  agentRoles: ['scoper'],
  handler: async (input) => {
    replayBusinessErrorSeen.push(input);
    return {
      content: [{ type: 'text' as const, text: 'business failure' }],
      isError: true,
    };
  },
});

// EI-20226130855047135: this role-gated recovery-shaped probe must not open a
// short principal-synthesis transaction for a privileged caller. Signed role
// callers still exercise the normal synthesis path below.
const txlessRoleProbeSeen: UnifiedToolContext[] = [];
registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: role-gated recovery tool with no ambient tx',
  inputSchema: { type: 'object', additionalProperties: false },
  capabilities: ['agent_tools:read'],
  requirePrincipal: false,
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'gatingtest:txless_role' } },
  fn: async (_input, ctx) => {
    txlessRoleProbeSeen.push(ctx);
    return { content: [{ type: 'text' as const, text: 'gatingtest:txless_role-ok' }] };
  },
});

registerProjectedTool({
  pluginName: 'gating-matrix-test',
  description: 'test-only probe: undeclared ctx.tx access fails loudly',
  inputSchema: { type: 'object', additionalProperties: false },
  capabilities: ['agent_tools:read'],
  requirePrincipal: false,
  agentRoles: ['scoper'],
  expose: { mcp: { name: 'gatingtest:undeclared_tx_read' } },
  fn: async (_input, ctx) => {
    void ctx.tx;
    return { content: [{ type: 'text' as const, text: 'unreachable' }] };
  },
});

// EI-19389430626961976: a pair of probes whose ONLY difference is
// `skipResultDoor`, both returning a body well over the resultEach door
// budget (~6000 chars at the baked 1500-token floor) — for pinning that the
// `runDispatch` choke point in _mcp-handler.ts actually READS
// `projected.skipResultDoor` before calling applyResultDoor, not just that
// the flag is threaded through define-tool.ts/tool-projection.ts.
const DOOR_TEST_BIG_TEXT = 'x'.repeat(20000);
const FULL_SOURCE_CHECKPOINT_TAIL = 'CURRENT_CHECKPOINT_TAIL_EI_211604';
const FULL_SOURCE_CHECKPOINT = `${DOOR_TEST_BIG_TEXT}${FULL_SOURCE_CHECKPOINT_TAIL}`;
const NESTED_RUBRIC_ID = 'nested-rubric-result-door';
const NESTED_RUBRIC = {
  rubricId: NESTED_RUBRIC_ID,
  workspaceId: 'ws-test',
  kind: 'standard',
  characteristic: 'nested result-door completeness',
  title: 'Nested result-door completeness',
  description: 'A deliberately large rubric fixture for the nested transport regression.',
  methodRef: 'docs/methods/nested-result-door',
  ratingScale: ['pass', 'weak', 'fail'],
  criteria: Array.from({ length: 26 }, (_, i) => ({
    key: `criterion-${i + 1}`,
    title: `Criterion ${i + 1} ${'t'.repeat(120)}`,
    model: `model-${i + 1} ${'m'.repeat(120)}`,
    method: `method-${i + 1} ${'m'.repeat(140)}`,
    driftMarkers: `drift-${i + 1} ${'d'.repeat(140)}`,
    replication: `replication-${i + 1} ${'r'.repeat(140)}`,
    instrumentKey: `instrument-${i + 1}`,
  })),
};
defineTool({
  name: 'gatingtest:door_default',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  agentRoles: ['scoper'],
  handler: async () => ({ data: { big: DOOR_TEST_BIG_TEXT } }),
});
defineTool({
  name: 'gatingtest:door_skip',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  agentRoles: ['scoper'],
  skipResultDoor: 'programmatic-caller',
  handler: async () => ({ data: { big: DOOR_TEST_BIG_TEXT } }),
});
// WI-37843: the OTHER skip reason. Same door-skipping effect, opposite prose
// treatment — a model-facing tool that is oversize by design (coord:orient)
// must keep the annotations a programmatic caller has to be spared.
defineTool({
  name: 'gatingtest:door_skip_oversize',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  agentRoles: ['scoper'],
  skipResultDoor: 'oversize-by-design',
  handler: async () => ({
    data: {
      big: DOOR_TEST_BIG_TEXT,
      codexLocks: { lockMode: 'automatic' },
    },
  }),
});

// P-008 faithful coord:orient ordering probe. Unlike the smaller synthetic
// control above, this carries the four defineTool traits that matter on the
// live orient path: the model-facing door exemption, a per-tool hard ceiling,
// the session-tier opt-out, and a domain shaper that can still miss the
// ceiling. The no-op shaper deliberately models that last-resort overshoot so
// the framework's generic bounded projection drops the late codexLocks field
// before the transport-level caller projection gets a chance to select it.
defineTool({
  name: 'gatingtest:orient_ceiling_projection',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  agentRoles: ['scoper'],
  skipResultDoor: 'oversize-by-design',
  payloadTierCeilingChars: 18_000,
  ignoreSessionPayloadTier: true,
  shape: {
    standard: (data) => data,
    trimmed: (data) => data,
  },
  handler: async () => ({
    data: {
      ...Object.fromEntries(
        Array.from({ length: 60 }, (_, i) => [`noise${i}`, DOOR_TEST_BIG_TEXT.slice(0, 500)]),
      ),
      codexLocks: { lockMode: 'automatic' },
    },
  }),
});

// EI-21160410643006790: an explicit full-tier nested dispatch must reach the
// outer result-door with the TARGET's unshaped source. This synthetic target
// deliberately has a lossy shaper; the spill assertion below is the durable
// proof that `tools:invoke(... payloadTier:'full')` bypasses it before the
// outer door writes the recoverable result.
defineTool({
  name: 'gatingtest:full_source_spill',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  agentRoles: ['scoper'],
  payloadTierCeilingChars: 18_000,
  shape: {
    standard: () => ({ checkpoint: 'SHAPED_CHECKPOINT_MARKER' }),
    trimmed: () => ({ checkpoint: 'SHAPED_CHECKPOINT_MARKER' }),
  },
  handler: async () => ({ data: { checkpoint: FULL_SOURCE_CHECKPOINT } }),
});
defineTool({
  name: 'gatingtest:truncated_source_spill',
  requirePrincipal: false,
  capability: 'agent_tools:read',
  args: z.object({}),
  agentRoles: ['scoper'],
  payloadTierCeilingChars: 18_000,
  shape: {
    standard: () => ({ checkpoint: 'SHAPED_TRUNCATED_SOURCE_MARKER' }),
    trimmed: () => ({ checkpoint: 'SHAPED_TRUNCATED_SOURCE_MARKER' }),
  },
  handler: async () => ({
    data: {
      priorAttempts: {
        attempts: [{
          rawRef: 'fixture#completion',
          textTruncated: true,
          text: 'completion prefix…[TRUNCATED +1200 chars]',
        }],
      },
      checkpoint: FULL_SOURCE_CHECKPOINT,
    },
  }),
});

afterAll(() => {
  unregisterProjectedToolsForPlugin('gating-matrix-test');
  unregisterProjectedToolsForPlugin(LATE_PLUGIN_NAME);
});

/* ─── Drivers ────────────────────────────────────────────────────────── */

const MCP = 'http://127.0.0.1:3070/api/mcp';

/** mcp-handler-shaped `extra` (requestInfo.{url,headers}) on a loopback host. */
function extraFor(url: string, headers: Record<string, string> = {}): unknown {
  return { requestInfo: { url, headers: { host: '127.0.0.1:3070', ...headers } } };
}

/** A per-spawn signed URL (sig verification itself is mocked OK by default). */
function signedUrl(over: Record<string, string> = {}): string {
  const u = new URL(MCP);
  const params: Record<string, string> = {
    harness: 'papercup',
    workspace: 'ws-test',
    role: 'scoper',
    run: 'run-1',
    spawn: 'spawn-1',
    exp: '9999999999',
    sig: 'test-sig',
    ...over,
  };
  for (const [k, v] of Object.entries(params)) if (v !== '') u.searchParams.set(k, v);
  return u.toString();
}

function superuserExtra(query = '', headers: Record<string, string> = {}): unknown {
  return extraFor(`${MCP}?superuser=1${query}`, {
    authorization: 'Bearer test-su-bearer',
    ...headers,
  });
}

const POWER_CLAIMS = {
  t: 'access',
  workspaceId: 'ws-claim',
  userId: 'u-1',
  authSessionId: 'sess-1',
  exp: 9999999999,
};

interface ToolsListEntry {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}
interface ToolsListResult {
  tools: ToolsListEntry[];
}
/**
 * DERIVED from the transport's own `McpCallResult` so a field added there
 * cannot silently strand these tests. The hand-mirrored copy this replaces
 * drifted exactly that way: `structuredContent` was added to the handler and
 * the replay path, the mirror kept typechecking, and the gap only surfaced
 * when a test finally asserted the field (TS2339, EI-21573072389650825).
 *
 * `content` is deliberately re-narrowed to the text-bearing shape these tests
 * assert on; the production union widens it to `Record<string, unknown>`,
 * under which `.text` degrades to `unknown` and breaks `JSON.parse(...)` here.
 */
type CallResult = Omit<McpCallResult, 'content'> & {
  content: Array<{ type: string; text?: string }>;
};

async function listTools(extra: unknown): Promise<ToolsListResult> {
  return (await h.handlers.get('tools/list')!({}, extra)) as ToolsListResult;
}
async function callTool(
  name: string,
  args: Record<string, unknown>,
  extra: unknown,
  meta?: Record<string, unknown>,
): Promise<CallResult> {
  return (await h.handlers.get('tools/call')!(
    { params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) } },
    extra,
  )) as CallResult;
}
const textOf = (r: CallResult): string => r.content.map((c) => c.text ?? '').join('');

function projectionRefusalText(result: CallResult): string {
  const door = result._meta?.resultDoor as { reason?: string; spillPath?: string; spillUri?: string } | undefined;
  if (!door) return textOf(result);
  expect(door.reason).toBe('under-budget-partial-result');
  const partial = JSON.parse(textOf(result));
  // Partial reads preserve the refusal's machine-readable fields inline and
  // retain the exact emitted body behind their scratch-page cursor.
  expect(partial).toMatchObject({
    _partial: true,
    projection_refused: 'pick_matched_nothing',
    _projection: { truncated: true, cursor: { kind: 'scratch-page', tool: 'capability:read', bodyComplete: false } },
  });
  const reference = parseScratchReference(readFileSync(door.spillPath!));
  expect(reference).not.toBeNull();
  expect(door.spillUri).toEqual(expect.any(String));
  expect(partial._projection.cursor.args.file_path).toBe(door.spillUri);
  return reference!.payload.toString('utf8');
}
/** Read one JSON payload block without concatenating separate advisory text blocks. */
function jsonOf(r: CallResult): unknown {
  for (const item of r.content) {
    if (typeof item.text !== 'string') continue;
    try {
      return JSON.parse(item.text);
    } catch {
      // MCP results may carry non-JSON advisory text in separate content blocks.
    }
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  throw new Error('MCP result did not contain a JSON text item or structuredContent');
}

/** Exercise the SDK lifecycle independently of the HTTP adapter's handler capture. */
async function withSdkHost<T>(extra: unknown, run: (client: Client) => Promise<T>, connection: 'memory' | 'uds' | 'listener' | 'http'): Promise<T> {
  if (connection === 'http') {
    // This arm is a REAL loopback HTTP socket, unlike h.handlers' HTTP-factory
    // capture. Use the same production registration/dispatch as the UDS arm.
    const hosts: Array<{ server: McpServer; transport: StreamableHTTPServerTransport }> = [];
    const errors: unknown[] = [];
    const http = createHttpServer(async (req, res) => {
      const server = new McpServer({ name: 'shared-host-parity', version: '1' }, mcpHostServerOptions());
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      hosts.push({ server, transport });
      try {
        registerMcpHost(server);
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        errors.push(error);
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    const client = new Client({ name: 'http-host-contract', version: '1' });
    try {
      http.listen(0, '127.0.0.1');
      await once(http, 'listening');
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('missing_http_fixture_address');
      const info = (extra as { requestInfo: { url: string; headers: Record<string, string> } }).requestInfo;
      const url = new URL(info.url);
      url.host = `127.0.0.1:${address.port}`;
      const { host: _host, ...headers } = info.headers;
      await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers } }));
      const result = await run(client);
      expect(errors).toEqual([]);
      return result;
    } finally {
      await client.close();
      await Promise.all(hosts.map(async ({ server, transport }) => {
        await transport.close();
        await server.close();
      }));
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  }
  if (connection === 'listener') {
    const listener = await startAgentMcpServer({ port: 3070, host: {
      register: registerMcpHost, options: mcpHostServerOptions(),
      verify: tryBuildSpawnContext, pin: pinVerifiedMcpRequest,
    } });
    const client = new Client({ name: 'authenticated-host-contract', version: '1' });
    const wire = new UdsMcpTransport({ path: listener.endpoint.socketPath });
    const originalSend = wire.send.bind(wire);
    const info = (extra as { requestInfo: { url: string; headers: Record<string, string> } }).requestInfo;
    const { host: _host, ...headers } = info.headers;
    wire.send = message => originalSend('method' in message && message.method === 'initialize'
      ? { ...message, params: { ...message.params, _meta: { [AGENT_MCP_AUTH_META]: {
        version: 1, operatorId: listener.endpoint.operatorId, generation: listener.endpoint.generation,
        url: info.url, headers,
      } } } } : message);
    try { await client.connect(wire); return await run(client); }
    finally { await client.close(); await listener.close(); }
  }
  let [clientWire, serverWire]: [Transport, Transport] = InMemoryTransport.createLinkedPair();
  let cleanupWire = async () => {};
  if (connection === 'uds') {
    const root = await mkdtemp(join(tmpdir(), 'host-parity-'));
    const path = join(root, 'mcp.sock');
    const listener = createServer({ pauseOnConnect: true });
    listener.listen(path);
    await once(listener, 'listening');
    const accepted = once(listener, 'connection');
    const clientSocket = createConnection(path);
    const [serverSocket] = await accepted;
    clientWire = new UdsMcpTransport({ socket: clientSocket });
    serverWire = new UdsMcpTransport({ socket: serverSocket });
    cleanupWire = async () => {
      clientSocket.destroy();
      serverSocket.destroy();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    };
  }
  let requestInfo: MessageExtraInfo | undefined;
  const transport: Transport = {
    async start() {
      serverWire.onmessage = (message) => transport.onmessage?.(message, requestInfo);
      serverWire.onclose = () => transport.onclose?.();
      serverWire.onerror = (error) => transport.onerror?.(error);
      await serverWire.start();
    },
    send: (message) => serverWire.send(message),
    close: () => serverWire.close(),
  };
  const server = new McpServer({ name: 'shared-host-parity', version: '1' }, mcpHostServerOptions());
  registerMcpHost(server);
  const client = new Client({ name: 'shared-host-contract', version: '1' });
  try {
    await server.connect(transport);
    // Bare initialize keeps HTTP probe behavior and avoids unrelated memory reads.
    await client.connect(clientWire);
    requestInfo = extra as MessageExtraInfo;
    return await run(client);
  } finally {
    await client.close();
    await server.close();
    await cleanupWire();
  }
}

describe('final report delivery through the MCP host', () => {
  it.each(['direct', 'nested', 'projected', 'spill'])(
    'backfills only the caller-visible edition after the final door: %s', async route => {
      const tool = lookupByMcpName('reports:get');
      if (!tool) throw new Error('Expected the production report tool registration');
      const original = tool.fn, body = 'Complete native handler report é'.repeat(route === 'spill' ? 600 : 1);
      const bodySha256 = createHash('sha256').update(body).digest('hex');
      tool.fn = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [{
        ok: true, id: 'rpt-delivery', report: { body_md: body, body_sha256: bodySha256,
          body_bytes: Buffer.byteLength(body), visibility: 'owner', published_at: '2026-10-24T00:00:00Z' },
      }] }) }], ...(route === 'spill' ? { _meta: { explicitFullRequest: true } } : {}) });
      const trace = 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e';
      try {
        const args = { id: 'rpt-delivery', ...(route === 'projected' ? { projection: { pick: ['results[].id'] } } : {}) };
        const result = await callTool(route === 'nested' ? 'tools:invoke' : 'reports:get',
          route === 'nested' ? { name: 'reports:get', args } : args,
          superuserExtra('&workspace=ws-test&client=su-final-delivery', { [MCP_REQUEST_TRACE_HEADER]: trace }),
          { format: 'json' });
        expect(result.isError).not.toBe(true);
        const receipt = h.deliveryBackfills.find(row => row.toolName === 'reports:get' && row.metadataJson.reportResultDelivery);
        expect(receipt?.mcpRequestTraceId).toBe(trace);
        expect(receipt?.metadataJson).toMatchObject({ reportResultDelivery: { version: 1,
          inline: route === 'projected' || route === 'spill' ? [] : [{ id: 'rpt-delivery', bodySha256, bodyBytes: Buffer.byteLength(body) }],
          ...(route === 'spill' ? { spill: { reports: [{ id: 'rpt-delivery', bodySha256 }] } } : {}),
        } });
        expect(textOf(result).includes(body)).toBe(route !== 'projected' && route !== 'spill');
      } finally { tool.fn = original; }
    });

  it.each([
    { route: 'direct-inline', nested: false, scratch: false, trace: 'e57ef6b3-46ef-4cc5-8214-fec83b2c1461' },
    { route: 'nested-scratch', nested: true, scratch: true, trace: 'e57ef6b3-46ef-4cc5-8214-fec83b2c1462' },
  ])('backfills capability:read delivery metadata only for scratch pages ($route)', async ({ nested, scratch, trace }) => {
    const tool = lookupByMcpName('capability:read');
    if (!tool) throw new Error('Expected the production capability:read tool registration');
    const original = tool.fn;
    const scratchUri = 'papercusp://scratch/ws-test/capability-read/result.md';
    tool.fn = async () => ({ content: [{ type: 'text', text: JSON.stringify({
      ok: true,
      file_path: scratch ? scratchUri : 'README.md',
      encoding: 'base64',
      data: 'YWJj',
      byte_offset: 0,
      byte_length: 3,
      total_bytes: 3,
      reference: { byteCount: 3, sha256: 'a'.repeat(64) },
    }) }] });
    try {
      const args = { file_path: 'README.md' };
      const result = await callTool(
        nested ? 'tools:invoke' : 'capability:read',
        nested ? { name: 'capability:read', args } : args,
        superuserExtra(`&workspace=ws-test&client=su-read-delivery-${nested ? 'nested' : 'direct'}`, {
          [MCP_REQUEST_TRACE_HEADER]: trace,
        }),
        { format: 'json' },
      );
      expect(result.isError).not.toBe(true);
      const receipts = h.deliveryBackfills.filter(row =>
        row.toolName === 'capability:read' && Object.hasOwn(row.metadataJson, 'scratchResultDelivery'));
      if (scratch) {
        expect(receipts).toHaveLength(1);
        expect(receipts[0]).toMatchObject({
          mcpRequestTraceId: trace,
          metadataJson: { scratchResultDelivery: {
            version: 1, uri: scratchUri, sha256: 'a'.repeat(64), totalBytes: 3, offset: 0, bytes: 3,
          } },
        });
      } else expect(receipts).toHaveLength(0);
    } finally { tool.fn = original; }
  });
});

describe('tools/list schema cache preserves actual-use detail', () => {
  it.each(['full-first', 'compact-first'])('isolates discovery schemas and compact schemas with %s', async order => {
    const name = 'gating-cache:detail';
    const pluginName = 'gating-cache-regression';
    const schema = {
      type: 'object',
      properties: { value: { type: 'string', description: 'Original argument guidance must survive promotion.' } },
      additionalProperties: false,
    };
    registerProjectedTool({
      pluginName, description: 'Original complete definition. Further guidance for continued use.',
      // MCP discovery and flattened model schemas need not share an object.
      inputSchema: structuredClone(schema), discoveryInputSchema: schema,
      capabilities: [], expose: { mcp: { name } }, fn: probeFn(name),
    });
    const { recordSessionToolUse, sessionToolSurfaceKey } = await import('../routes/transport/tool-allowlist');
    const owner = `su-schema-cache-${order}`;
    const listing = async (compact: boolean) => (await listTools(superuserExtra(
      `&workspace=ws-test&client=${owner}-${compact ? 'compact' : 'full'}&tools=${name}` +
      (compact ? `&tools_compact=${name}` : ''),
    ))).tools.find(tool => tool.name === name)!;
    try {
      let full: Awaited<ReturnType<typeof listing>>;
      let compact: Awaited<ReturnType<typeof listing>>;
      if (order === 'full-first') { full = await listing(false); compact = await listing(true); }
      else { compact = await listing(true); full = await listing(false); }
      expect(full.inputSchema).toEqual(schema);
      expect(compact.inputSchema).not.toEqual(schema);
      expect(recordSessionToolUse(sessionToolSurfaceKey(`${owner}-compact`, 'ws-test'), [name])).toBe(true);
      const promoted = await listing(true);
      expect(promoted.description).toBe(full.description);
      expect(promoted.inputSchema).toEqual(schema);
      expect((await listing(false)).inputSchema).toEqual(schema);
    } finally {
      unregisterProjectedToolsForPlugin(pluginName);
    }
  });
});

function assertCatalogParity(native: { tools: { name: string }[] }, http: unknown) {
  expect(native).toEqual(http);
  expect(native.tools.some((tool) => tool.name === 'gatingtest:scoped')).toBe(true);
  expect(native.tools.some((tool) => tool.name === 'gatingtest:engineer')).toBe(false);
}

function assertPolicyResultParity(
  native: { isError?: boolean; content?: unknown; _meta?: Record<string, unknown> },
  http: { isError?: boolean; content?: unknown; _meta?: Record<string, unknown> },
) {
  // The build-stamp annotator may add its once-per-owner advisory block before
  // projection. That legitimately changes linesIn and the metrics footer, but
  // the projection result and its essential metadata must still agree.
  expect(native.isError).toBe(http.isError);
  expect(http.isError).not.toBe(true);
  expect(native._meta?.resultProjection).toMatchObject({ applied: true, linesOut: 1 });
  expect(http._meta?.resultProjection).toMatchObject({ applied: true, linesOut: 1 });
  const payloadContent = (result: { content?: unknown }): unknown => {
    if (!Array.isArray(result.content)) return result.content;
    return result.content.filter((item: unknown) => {
      if (!item || typeof item !== 'object') return true;
      const text = item as { type?: unknown; text?: unknown };
      return !(text.type === 'text' && typeof text.text === 'string' && text.text.startsWith('\n[projection:'));
    });
  };
  expect(payloadContent(native)).toEqual(payloadContent(http));
  expect(payloadContent(native)).toEqual([{ type: 'text', text: 'gatingtest:scoped-ok' }]);
}

describe.each(['memory', 'uds', 'listener'] as const)('launch ceiling listing — %s transport', connection => {
  const extra = () => superuserExtra('&workspace=ws-test&client=su-ceiling&tools=gatingtest:engineer,gatingtest:txless_scope');
  const policy = (denyOutside: string[]) => ({ denyTools: [], denyOutside,
    reason: 'metered benchmark', imposedBy: 'benchmark-host' });
  it('advertises the assigned maintained workflow without treating a listing as execution', async () => {
    const verbs = ['work_items:get', 'work_items:checkpoint', 'work_items:complete'];
    h.readSessionConfinement.mockResolvedValue({ ...policy(verbs), denyAmbientContext: true,
      denyWorkItemsOutside: { id: 'F-own', harness: 'bench', checkout: '/private/assignment' } });
    const scoped = superuserExtra(`&workspace=ws-test&client=su-assignment&tools=${verbs.join(',')}`);
    await withSdkHost(scoped, async client => {
      expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([...verbs].sort());
    }, connection);
  });
  it('advertises only launch-authorized tools through HTTP assembly and the native SDK', async () => {
    h.readSessionConfinement.mockResolvedValue(policy(['gatingtest:engineer']));
    const http = await listTools(extra());
    expect(http.tools.map(tool => tool.name)).toEqual(['gatingtest:engineer']);
    expect(h.readSessionConfinement).toHaveBeenCalledWith('su-ceiling', 'ws-test');
    await withSdkHost(extra(), async client => {
      const native = await client.listTools();
      expect(native).toEqual(http);
      expect(native.tools.map(tool => tool.name)).toEqual(['gatingtest:engineer']);
    }, connection);
  });
  it('rechecks authoritative policy on every listing and preserves an expired empty ceiling', async () => {
    h.readSessionConfinement.mockResolvedValue(policy(['gatingtest:engineer']));
    await withSdkHost(extra(), async client => {
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['gatingtest:engineer']);
      h.readSessionConfinement.mockResolvedValue(policy(['gatingtest:txless_scope']));
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['gatingtest:txless_scope']);
      h.readSessionConfinement.mockResolvedValue(policy([]));
      expect((await client.listTools()).tools).toEqual([]);
    }, connection);
  });
  it('fails closed when the stored launch authority cannot be read', async () => {
    h.readSessionConfinement.mockRejectedValue(new Error('private policy unavailable'));
    await expect(listTools(extra())).rejects.toThrow('session_confinement_unavailable');
    await withSdkHost(extra(), async client => {
      await expect(client.listTools()).rejects.toThrow('session_confinement_unavailable');
    }, connection);
  });
});

describe.each(['memory', 'uds', 'listener'] as const)('shared MCP host — %s SDK parity with the real HTTP assembly', (connection) => {
  it('negotiates existing capabilities and exposes the same allowed catalog', async () => {
    const extra = extraFor(signedUrl({ tools: 'gatingtest:scoped,gatingtest:engineer' }));
    const http = await listTools(extra);
    await withSdkHost(extra, async (client) => {
      expect(client.getServerCapabilities()).toEqual(MCP_SERVER_CAPABILITIES);
      const native = await client.listTools();
      assertCatalogParity(native, http);
      expect(await client.listResources()).toEqual(await h.handlers.get('resources/list')!({}, extra));
      expect(await client.listPrompts()).toEqual(await h.handlers.get('prompts/list')!({}, extra));
    }, connection);
  });

  it('preserves policy metadata, dispatcher scope and compact content through the SDK', async () => {
    const extra = superuserExtra('&workspace=ws-test');
    const args = { projection: { pipe: [{ op: 'grep', pattern: 'gatingtest:scoped-ok', fixed: true }] } };
    const http = await withSdkHost(
      extra,
      client => client.callTool({ name: 'gatingtest:scoped', arguments: args }),
      'http',
    );
    await withSdkHost(extra, async (client) => {
      const native = await client.callTool({ name: 'gatingtest:scoped', arguments: args });
      assertPolicyResultParity(native, http);
      expect(seen.at(-1)?.ctx.workspaceId).toBe('ws-test');
      expect(seen.at(-1)?.ctx.transport).toBe('mcp');
      expect(seen.at(-1)?.args).toEqual({});
    }, connection);
  });

  it('calibrates the catalog oracle by rejecting a UDS-only unauthorized tool', async () => {
    const extra = extraFor(signedUrl({ tools: 'gatingtest:scoped,gatingtest:engineer' }));
    const http = await listTools(extra);
    await withSdkHost(extra, async (client) => {
      const native = await client.listTools();
      assertCatalogParity(native, http);
      const bad = { ...native, tools: [...native.tools, { ...native.tools[0], name: 'gatingtest:engineer' }] };
      expect(() => assertCatalogParity(bad, http)).toThrow();
    }, connection);
  });

  it('calibrates the result oracle by rejecting lost policy metadata and changed content', async () => {
    const extra = superuserExtra('&workspace=ws-test');
    const args = { projection: { pipe: [{ op: 'grep', pattern: 'gatingtest:scoped-ok', fixed: true }] } };
    const http = await callTool('gatingtest:scoped', args, extra);
    await withSdkHost(extra, async (client) => {
      const native = await client.callTool({ name: 'gatingtest:scoped', arguments: args });
      assertPolicyResultParity(native, http);
      expect(() => assertPolicyResultParity({ ...native, _meta: {} }, http)).toThrow();
      expect(() => assertPolicyResultParity({ ...native, content: [] }, http)).toThrow();
    }, connection);
  });

  it('rejects invalid credentials before discovery and execution on both assemblies', async () => {
    const extra = superuserExtra('&workspace=ws-test', { authorization: 'Bearer invalid' });
    await expect(listTools(extra)).rejects.toThrow('mcp_auth_failed');
    const run = withSdkHost(extra, async (client) => {
      await expect(client.listTools()).rejects.toThrow('mcp_auth_failed');
      const result = await client.callTool({ name: 'gatingtest:scoped', arguments: {} });
      expect(result.isError).toBe(true);
      expect(seen).toHaveLength(0);
    }, connection);
    if (connection === 'listener') await expect(run).rejects.toThrow('uds_auth_failed');
    else await run;
  });
});

function assertAgentAttribution(actual: Record<string, unknown>): void {
  expect(actual).toMatchObject({
    workspaceId: 'ws-test', harnessSlug: 'papercup', uiClientId: 'su-uds-original',
    role: 'scoper', runId: 'run-1', spawnId: 'spawn-1', transport: 'mcp',
  });
  expect(actual.isSuperuser).not.toBe(true);
}

describe('authenticated listener — real signed envelope verification', () => {
  async function signedFixture() {
    // Only the key store is fake. Canonicalization, HMAC, expiry, timing-safe
    // verification and the host→SDK→dispatcher path are production functions.
    h.signingRows = [{ value_b64: Buffer.alloc(32, 9).toString('base64'), rotated_at: '2026-01-01' }];
    const actual = h.realSpawnSigning!;
    actual._resetSpawnSigningKeyCache();
    h.verifySpawnParams.mockImplementation((input, options) => actual.verifySpawnParams(input as URL, options));
    const url = new URL(signedUrl({ client: 'su-uds-original', tools: 'gatingtest:scoped' }));
    await actual.signSpawnParams(url.searchParams);
    return { url, clear: () => { h.signingRows = null; actual._resetSpawnSigningKeyCache(); } };
  }

  it.each(['workspace', 'role', 'exp'])('rejects tampered signed %s before catalog/dispatch', async field => {
    const fixture = await signedFixture();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Positive control proves this exact signer/fixture/path can authenticate.
      await withSdkHost(extraFor(fixture.url.href), client => client.listTools(), 'listener');
      _resetVerifiedSpawns(); // A new tampered client is not a rotation incident.
      fixture.url.searchParams.set(field, field === 'exp' ? '1' : 'forged');
      await expect(withSdkHost(extraFor(fixture.url.href), client => client.listTools(), 'listener'))
        .rejects.toThrow('uds_auth_failed');
      expect(seen).toHaveLength(0);
      expect(h.logVerificationFailure).toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(
        field === 'exp' ? 'expired' : 'invalid_signature',
      ));
      expect(warning.mock.calls.flat().join(' ')).not.toContain(fixture.url.searchParams.get('sig')!);
    } finally { warning.mockRestore(); fixture.clear(); }
  });

  it('records the original agent identity, not the trusted UI operator principal', async () => {
    const fixture = await signedFixture();
    try {
      await withSdkHost(extraFor(fixture.url.href), async client => {
        const result = await client.callTool({ name: 'gatingtest:scoped', arguments: {} });
        expect(result.isError).not.toBe(true);
      }, 'listener');
      expect(seen).toHaveLength(1);
      assertAgentAttribution(seen[0].ctx as unknown as Record<string, unknown>);
      const invocation = h.invocations.find(row => row.toolName === 'gatingtest:scoped');
      expect(invocation).toBeDefined();
      assertAgentAttribution(invocation!.ctx as unknown as Record<string, unknown>);
      expect(() => assertAgentAttribution({
        ...invocation!.ctx, uiClientId: 'trusted-webview', role: 'operator', isSuperuser: true,
      })).toThrow();
    } finally { fixture.clear(); }
  });
});

describe('public Papercup PI card transport (EI-22679615443261276)', () => {
  const principal: Principal = {
    kind: 'pi', slug: 'pi:test-public-chat', workspaceId: 'ws-pi-card',
    authMethod: 'bearer-token', trust: 'verified', capabilities: new Set(['chat:write']),
  };
  const cardInput = {
    question: 'Two routes to a new app — which?',
    options: JSON.stringify([
      { id: 'template', label: 'From a template' },
      { id: 'browse', label: 'Show me the templates' },
    ]),
  };
  const piExtra = (workspace = principal.workspaceId) => extraFor(
    `${MCP}?principal=pi&workspace=${workspace}&tools=chat%3Aask_choice`,
    { authorization: 'Bearer test-pi-card-bearer' },
  );

  it('verifies a signed parent while minting independent PI child runs and retaining current credential checks', async () => {
    h.signingRows = [{ value_b64: Buffer.alloc(32, 9).toString('base64'), rotated_at: '2026-01-01' }];
    const actual = h.realSpawnSigning!;
    actual._resetSpawnSigningKeyCache();
    h.verifySpawnParams.mockImplementation((input, options) => actual.verifySpawnParams(input as URL, options));
    h.resolveBearer.mockResolvedValue(principal);
    try {
      const parent = { workspaceId: principal.workspaceId, conversationId: 'conv-parent', turnId: 'turn-parent', runId: 'parent-run',
        authority: { kind: 'system' as const, principalId: 'system:operator', credentialSha256: 'a'.repeat(64) } };
      const token = await mintConverseChatBinding(parent, 'test-pi-card-bearer');
      const request = () => extraFor(`${MCP}?principal=pi&workspace=${parent.workspaceId}&chat_binding=${encodeURIComponent(token)}`,
        { authorization: 'Bearer test-pi-card-bearer' });
      const first = await tryBuildSpawnContext(request());
      const second = await tryBuildSpawnContext(request());
      expect(first.kind).toBe('ok');
      expect(second.kind).toBe('ok');
      if (first.kind !== 'ok' || second.kind !== 'ok') throw new Error('parent-positive-control-failed');
      expect(first.ctx.chatParent).toMatchObject(parent);
      expect(second.ctx.chatParent).toEqual(first.ctx.chatParent);
      expect(first.ctx.runId).not.toBe(parent.runId);
      expect(second.ctx.runId).not.toBe(first.ctx.runId);
      expect(first.ctx.isSuperuser).not.toBe(true);
      expect(await tryBuildSpawnContext(extraFor(`${MCP}?principal=pi&workspace=${parent.workspaceId}&chat_binding=${encodeURIComponent(token)}`,
        { authorization: 'Bearer another-valid-pi-bearer' }))).toMatchObject({ kind: 'failed', reason: 'chat_parent_invalid_binding' });
      h.resolveBearer.mockResolvedValue({ ...principal, capabilities: new Set() });
      const denied = await callTool('chat:ask_choice', cardInput, request());
      expect(denied.isError).toBe(true);
      expect(textOf(denied)).toContain('chat:write');
      h.resolveBearer.mockResolvedValue(null);
      expect(await tryBuildSpawnContext(request())).toMatchObject({ kind: 'failed', reason: 'pi_principal_invalid_bearer' });
    } finally { h.signingRows = null; actual._resetSpawnSigningKeyCache(); }
  });

  it('carries the signed parent through owner dispatch without trusting raw run or conversation parameters', async () => {
    h.signingRows = [{ value_b64: Buffer.alloc(32, 9).toString('base64'), rotated_at: '2026-01-01' }];
    const actual = h.realSpawnSigning!;
    actual._resetSpawnSigningKeyCache();
    h.verifySpawnParams.mockImplementation((input, options) => actual.verifySpawnParams(input as URL, options));
    try {
      const parent = { workspaceId: 'ws-test', conversationId: 'conv-owner', turnId: 'turn-owner', runId: 'parent-owner',
        authority: { kind: 'system' as const, principalId: 'system:operator', credentialSha256: 'a'.repeat(64) } };
      const token = await mintConverseChatBinding(parent, 'test-su-bearer');
      const raw = '&workspace=ws-test&run=forged-child&conversationId=forged&turnId=forged';
      const unsigned = await tryBuildSpawnContext(superuserExtra(raw));
      expect(unsigned.kind).toBe('ok');
      if (unsigned.kind !== 'ok') throw new Error('owner-positive-control-failed');
      expect(unsigned.ctx.chatParent).toBeUndefined();
      expect(unsigned.ctx.interactiveCardCapability).toBeUndefined();
      const query = `${raw}&chat_binding=${encodeURIComponent(token)}`;
      for (let index = 0; index < 2; index++) {
        const result = await callTool('gatingtest:scoped', {}, superuserExtra(query));
        expect(result.isError, textOf(result)).not.toBe(true);
      }
      expect(seen).toHaveLength(2);
      for (const call of seen) {
        expect(call.ctx.chatParent).toMatchObject(parent);
        expect(call.ctx.interactiveCardCapability).toBe(true);
        expect(call.ctx.askUser).toEqual(expect.any(Function));
        expect(call.ctx.runId).not.toBe(parent.runId);
        expect(call.ctx.runId).not.toBe('forged-child');
      }
      expect(seen[0].ctx.runId).not.toBe(seen[1].ctx.runId);
      expect(await tryBuildSpawnContext(superuserExtra(`${query}&chat_binding=${encodeURIComponent(token)}`)))
        .toMatchObject({ kind: 'failed', reason: 'chat_parent_invalid_transport' });
    } finally { h.signingRows = null; actual._resetSpawnSigningKeyCache(); }
  });

  it('displays and answers an actual ask_choice through authenticated tools/call', async () => {
    h.resolveBearer.mockResolvedValue(principal);
    let correlationId: string | undefined;
    let foreignAnswer: unknown;
    let acceptedAnswer: unknown;
    const off = subscribeWorkspace(principal.workspaceId, (frame) => {
      const card = frame.snapshot.openCards?.[0];
      if (!card || correlationId) return;
      correlationId = card.correlationId;
      foreignAnswer = resolveCardResponse({
        correlationId, action: 'submit', payload: { picks: ['browse'] }, expectedWorkspaceId: 'another-workspace',
      });
      acceptedAnswer = resolveCardResponse({
        correlationId, action: 'submit', payload: { picks: ['browse'] }, expectedWorkspaceId: principal.workspaceId,
      });
    });
    try {
      const result = await callTool('chat:ask_choice', cardInput, piExtra(), { format: 'json' });
      expect(result.isError, textOf(result)).not.toBe(true);
      expect(correlationId).toBeTruthy();
      expect(foreignAnswer).toMatchObject({ ok: false, status: 404 });
      expect(acceptedAnswer).toEqual({ ok: true });
      expect(jsonOf(result)).toMatchObject({
        ok: true, picks: [{ option_id: 'browse', label: 'Show me the templates' }],
      });
      expect(h.resolveBearer).toHaveBeenCalledWith('test-pi-card-bearer');
    } finally {
      off();
      if (correlationId) resolveCardResponse({ correlationId, action: 'cancel', expectedWorkspaceId: principal.workspaceId });
    }
  });

  it('refuses invalid credentials and a workspace different from the authenticated principal', async () => {
    const invalid = await callTool('chat:ask_choice', cardInput, piExtra());
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain('pi_principal_invalid_bearer');
    h.resolveBearer.mockResolvedValue(principal);
    const foreign = await callTool('chat:ask_choice', cardInput, piExtra('another-workspace'));
    expect(foreign.isError).toBe(true);
    expect(textOf(foreign)).toContain('pi_principal_workspace_mismatch');
  });

  it('keeps the independent chat:write capability gate', async () => {
    h.resolveBearer.mockResolvedValue({ ...principal, capabilities: new Set() });
    const result = await callTool('chat:ask_choice', cardInput, piExtra());
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('chat:write');
  });
});

describe('MCP scratch resource authentication', () => {
  describe.each(['memory', 'uds', 'listener'] as const)('frozen context protocol — %s', connection => {
    const extra = () => superuserExtra('&workspace=ws-test&client=su-frozen-resources');
    it('refuses resource content before calling its registered reader', async () => {
      h.readSessionConfinement.mockResolvedValue({ denyTools: [], denyOutside: ['work_items:get'],
        denyAmbientContext: true, reason: 'frozen corpus', imposedBy: 'benchmark-host' });
      await withSdkHost(extra(), async client => {
        await expect(client.readResource({ uri: 'papercusp://ambient/neighbor-corpus' })).rejects.toThrow(/frozen assignment context/);
        expect(h.resourceReads).toHaveLength(0);
      }, connection);
    });
    it('lists no ambient resources or prompts and refuses direct prompt lookup', async () => {
      h.readSessionConfinement.mockResolvedValue({ denyTools: [], denyOutside: ['work_items:get'],
        denyAmbientContext: true, reason: 'frozen corpus', imposedBy: 'benchmark-host' });
      await withSdkHost(extra(), async client => {
        expect(await client.listResources()).toEqual({ resources: [] });
        expect(await client.listPrompts()).toEqual({ prompts: [] });
        await expect(client.getPrompt({ name: 'agent:role', arguments: { role: 'su' } })).rejects.toThrow(/frozen assignment context/);
      }, connection);
    });
    it('fails closed if authoritative policy cannot be read', async () => {
      h.readSessionConfinement.mockRejectedValue(new Error('policy unavailable'));
      await withSdkHost(extra(), async client => {
        await expect(client.readResource({ uri: 'papercusp://ambient/neighbor-corpus' })).rejects.toThrow(/frozen assignment context/);
        expect(h.resourceReads).toHaveLength(0);
      }, connection);
    });
  });
  it('uses the same signed-session owner for a tools:invoke spill and its resource read', async () => {
    const extra = extraFor(signedUrl({ client: 'scoper-session-spill' }));
    const result = await callTool(
      'tools:invoke',
      { name: 'gatingtest:door_default', args: {} },
      extra,
    );
    expect(result.isError).not.toBe(true);
    const body = JSON.parse(textOf(result)) as {
      _projection: { cursor: { uri: string; args: { file_path: string } } };
    };
    const reference = parseScratchReference(readFileSync(body._projection.cursor.args.file_path));
    expect(reference).not.toBeNull();

    await withSdkHost(extra, async client => {
      await client.readResource({ uri: body._projection.cursor.uri });
    }, 'memory');
    expect(h.resourceReads).toHaveLength(1);
    expect(reference?.manifest.ownerId).toBe(
      (h.resourceReads[0]?.principal as Principal).slug,
    );
  });

  it('reads a judge scratch spill with its verified signed-spawn identity', async () => {
    const uri = 'papercusp://scratch/ws-test/tools:invoke/11111111-2222-4333-8444-555555555555/result.spill';
    await withSdkHost(
      extraFor(signedUrl({ role: 'judge', client: 'judge-session-1' })),
      async client => {
        const result = await client.readResource({ uri });
        expect(result.contents).toEqual([{ uri, mimeType: 'text/plain', text: 'spill contents' }]);
        expect(h.resourceReads).toHaveLength(1);
        expect(h.resourceReads[0]).toMatchObject({
          uri,
          principal: {
            kind: 'harness',
            slug: 'judge-session-1',
            workspaceId: 'ws-test',
            authMethod: 'spawn-url',
            trust: 'trusted',
          },
        });
        expect(h.resourceReads[0]).not.toHaveProperty('bearer');
      },
      'memory',
    );
  });

  it('reads a power-user scratch spill within the token workspace', async () => {
    h.verifyAccessToken.mockResolvedValueOnce(POWER_CLAIMS);
    const uri = 'papercusp://scratch/ws-claim/tools:invoke/11111111-2222-4333-8444-555555555555/result.spill';
    await withSdkHost(
      extraFor(`${MCP}?power_user=1`, { authorization: 'Bearer pu-token' }),
      async client => {
        const result = await client.readResource({ uri });
        expect(result.contents).toEqual([{ uri, mimeType: 'text/plain', text: 'spill contents' }]);
        expect(h.resourceReads).toHaveLength(1);
        expect(h.resourceReads[0]).toMatchObject({
          uri,
          principal: {
            kind: 'system',
            slug: 'sess-1',
            workspaceId: 'ws-claim',
            authMethod: 'bearer-token',
            trust: 'trusted',
          },
        });
        expect(h.resourceReads[0]).not.toHaveProperty('bearer');
        // Confinement and resource authorization must use the same verified
        // request identity, without a second token verification or new spawn.
        expect(h.verifyAccessToken).toHaveBeenCalledTimes(1);
      },
      'memory',
    );
  });
});

describe('authenticated admission binding through the real MCP handler', () => {
  it('binds the resolved SU workspace and original ephemeral run, not a recovery UUID', async () => {
    const result = await callTool('gatingtest:scoped', {}, superuserExtra('&workspace=ws-test&harness=papercup&sid=su-binding'));
    expect(result.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const ctx = seen[0]!.ctx;
    expect(bindAdmissionAuthority(ctx)).toMatchObject({
      kind: 'superuser', role: 'operator', credentialSha256: admissionCredentialDigest('test-su-bearer'),
      context: { workspaceId: 'ws-test', harnessSlug: 'papercup', profile: 'engineer',
        transport: 'mcp', runId: ctx.runId, spawnId: ctx.spawnId },
    });
  });

  it('binds a verified signed spawn to its original run, chunk, feature and signer', async () => {
    h.verifySpawnParams.mockResolvedValue({ ok: true, keySha256: 'a'.repeat(64) });
    const result = await callTool('gatingtest:scoped', {}, extraFor(signedUrl({
      run: 'bound-run', spawn: 'bound-spawn', chunk: 'bound-chunk', feature: 'bound-feature',
    })));
    expect(result.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(bindAdmissionAuthority(seen[0]!.ctx)).toMatchObject({
      kind: 'signed-spawn', role: 'scoper', credentialSha256: 'a'.repeat(64), expiresAtSec: 9999999999,
      context: { runId: 'bound-run', spawnId: 'bound-spawn', chunkId: 'bound-chunk',
        featureId: 'bound-feature', workspaceId: 'ws-test', transport: 'mcp' },
    });
  });

  it('does not issue a renewable binding for an unsigned soft-allowed spawn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.verifySpawnParams.mockResolvedValue({ ok: false, reason: 'unsigned' });
    try {
      const result = await callTool('gatingtest:scoped', {}, extraFor(signedUrl({ sig: '', exp: '', spawn: 'admission-unsigned' })));
      expect(result.isError).toBeUndefined();
      expect(seen).toHaveLength(1);
      expect(bindAdmissionAuthority(seen[0]!.ctx)).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('accepting UNSIGNED'));
    } finally {
      warn.mockRestore();
    }
  });

  it('retains an authenticated SU power-profile restriction', async () => {
    const result = await callTool(
      'gatingtest:scoped', {}, superuserExtra('&workspace=ws-test&harness=papercup&profile=power'),
    );
    expect(result.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(bindAdmissionAuthority(seen[0]!.ctx)?.context?.profile).toBe('power');
  });
});

describe('P007 recovery through the real shared dispatcher', () => {
  it('replays a committed write after losing its response, isolated by the original caller and key', async () => {
    h.replayLookupFromStores = true;
    const extra = (client = 'p007-caller') => extraFor(signedUrl({ client, tools: 'gatingtest:scoped' }));
    const call = { name: 'gatingtest:scoped', arguments: {}, _meta: { idempotencyKey: 'p007-lost-response' } };
    await withSdkHost(extra(), async client => {
      // Drop the ACTUAL socket after the transaction/receipt seam, before the
      // SDK can send the response. The persistence leaf is fake; dispatch and
      // authentication adapter, SDK and both socket endpoints are production.
      h.afterReplayStore = async () => { await client.close(); };
      await expect(client.callTool(call)).rejects.toThrow();
    }, 'listener');
    h.afterReplayStore = null;
    expect(h.txEvents).toEqual(['commit', 'store']);
    expect(seen.filter(x => x.tool === call.name)).toHaveLength(1);
    expect(h.replayStores[0].ownerKey).toBe('p007-caller');
    const stored = h.replayStores[0].result as McpCallResult;
    await withSdkHost(extra(), async client => {
      const result = await client.callTool(call);
      expect(result.content).toEqual(stored.content);
      expect(result._meta).toMatchObject({ replayed: true });
      expect(seen.filter(x => x.tool === call.name)).toHaveLength(1);
    }, 'listener');
    // Positive counterexamples: a different caller OR key really executes.
    await withSdkHost(extra('p007-other'), async client => {
      await client.callTool(call);
    }, 'listener');
    await withSdkHost(extra(), async client => {
      await client.callTool({ ...call, _meta: { idempotencyKey: 'p007-new-key' } });
    }, 'listener');
    expect(seen.filter(x => x.tool === call.name)).toHaveLength(3);
    expect(h.txEvents).toEqual(['commit', 'store', 'commit', 'store', 'commit', 'store']);
  });

  it('delivers client cancellation to the running projected tool over authenticated UDS', async () => {
    let resolveStarted!: () => void;
    const started = new Promise<void>(resolve => { resolveStarted = resolve; });
    const aborted = vi.fn();
    cancellationProbe = { started: resolveStarted, aborted, release: () => {} };
    try {
      await withSdkHost(extraFor(signedUrl({ tools: 'gatingtest:cancel' })), async client => {
        const controller = new AbortController();
        const pending = client.callTool({ name: 'gatingtest:cancel', arguments: {} }, undefined, {
          signal: controller.signal, timeout: 5_000,
        }).catch(error => error);
        await started;
        expect(aborted).not.toHaveBeenCalled();
        controller.abort();
        await pending;
        try { await vi.waitFor(() => expect(aborted).toHaveBeenCalledOnce(), { timeout: 1_000 }); }
        finally { cancellationProbe!.release(); }
      }, 'listener');
    } finally { cancellationProbe = null; }
  });

  it.each(['http', 'listener'] as const)('records protocol=mcp separately from physical connection on %s', async connection => {
    await withSdkHost(extraFor(signedUrl({ tools: 'gatingtest:scoped', connection: 'spoofed' })), async client => {
      const result = await client.callTool({
        name: 'gatingtest:scoped', arguments: {},
        _meta: { connection: 'spoofed', transport: 'spoofed' },
      });
      expect(result.content).toEqual([{ type: 'text', text: 'gatingtest:scoped-ok' }]);
      const ctx = seen.at(-1)!.ctx;
      expect(ctx.transport).toBe('mcp');
      expect(ctx.requestOrigin).toMatchObject({
        transport: 'mcp', connection: connection === 'listener' ? 'uds' : 'http',
      });
      // The dispatcher gives handlers a derived context with its composed
      // abort signal. Attribution must match; object identity must NOT.
      expect([...h.invocations].reverse().find(row => row.toolName === 'gatingtest:scoped')?.ctx).toMatchObject({
        transport: 'mcp', requestOrigin: ctx.requestOrigin,
        workspaceId: ctx.workspaceId, harnessSlug: ctx.harnessSlug, spawnId: ctx.spawnId,
      });
    }, connection);
  });
});

describe('P006 full dispatcher semantics over real HTTP and authenticated UDS', () => {
  afterEach(() => clearPrePromptRegistry());
  // Catalogs are role-filtered even when SU dispatch may bypass the role gate.
  // Use the same signed scoper identity as these probes' advertised role.
  const parityExtra = (format?: string, structured = false) => extraFor(signedUrl({
    tools: 'gatingtest:parity_rows,gatingtest:parity_args,gatingtest:parity_structured,gatingtest:delta_list',
    ...(format ? { format } : {}),
    ...(structured ? { structured: '1' } : {}),
  }));

  function configureColumns() {
    configurePrePromptRegistry([
      { name: 'gatingtest:parity_rows', read: 'csv' },
      {
        name: 'gatingtest:parity_args', write: 'positional',
        writeColumnNames: ['id', 'state', 'count', 'enabled', 'body'],
        writeRequiredColumnNames: ['id', 'state'],
        writeKeyedFallback: true,
      },
    ]);
  }

  it('applies fleet:status tiers at the actual CallToolRequestSchema boundary', async () => {
    const handlerContexts: Array<Record<string, unknown>> = [];
    const memberIds = (count: number, first = 0) => Array.from({ length: count }, (_, index) => {
      const id = String(first + index);
      return `su-${id.padStart(8, '0')}-0000-0000-0000-${id.padStart(12, '0')}`;
    });
    const source = {
      ok: true,
      slug: 'rocket',
      leaderId: 'su-tier-leader',
      memberCount: 59,
      members: Array.from({ length: 59 }, (_, index) => ({
        agentId: index === 0 ? 'su-tier-leader' : `su-tier-member-${index}`,
        label: `Member ${index}`,
        fleetRole: index === 0 ? 'leader' : 'member',
        intent: `tier test ${index}`,
        heartbeatFresh: true,
        sessionState: 'live',
        lastActiveSecAgo: 1,
        doing: `WI-${index}`,
        load: 1,
        lastToolCallAt: '2026-11-01T12:00:00Z',
      })),
      launchTransaction: {
        requestedMemberIds: memberIds(53, 10000),
        failed: [],
        governor: {
          history: Array.from({ length: 32 }, (_, index) => ({
            at: index,
            action: 'observe',
            reason: `event ${index} ${'x'.repeat(500)}`,
          })),
          terminalVerdict: {
            outcome: 'unknown',
            action: 'maintain',
            decidedAt: 1,
            target: 50,
            productiveCapacityFloor: 1,
            liveMemberIds: memberIds(53, 20000),
            workerReadyMemberIds: memberIds(3, 21000),
            unreadyMemberIds: [],
            unverifiedMemberIds: memberIds(50, 22000),
            reason: 'live members without typed worker attestation remain unknown',
          },
        },
      },
      populationLifecycle: {
        schemaVersion: 'fleet-population-lifecycle.v1',
        fleet: 'rocket',
        currentRunnableRoster: { census: { total: 52 }, ownerIds: memberIds(52, 30000) },
        relevantRoster: { census: { total: 54 }, ownerIds: memberIds(54, 31000) },
        everMembers: {
          population: 'ever-members',
          basis: 'membership events',
          writer: 'harness_shared.fleet_membership_events',
          available: true,
          counted: 2705,
          ownerIds: memberIds(2705, 40000),
        },
        membersLost: {
          population: 'ever-members-absent-from-roster',
          basis: 'ever members minus every identity still present on the fleet roster',
          writer: 'harness_shared.fleet_membership_events',
          available: true,
          count: 2646,
          ownerIds: memberIds(2646, 43000),
          timing: {
            status: 'not-measured',
            reason: 'current roster read does not provide last activity for membersLost',
            insteadRead: 'coord_presence.last_active_at per member',
          },
        },
        target: { count: 50 },
        liveness: { status: 'measured' },
        claimFlow: { status: 'measured' },
      },
    };
    expect(JSON.stringify(source).length).toBeGreaterThan(250_000);
    const fullSource = {
      ...source,
      memberCount: 20,
      members: source.members.slice(0, 20),
      populationLifecycle: undefined,
      launchTransaction: {
        ...source.launchTransaction,
        requestedMemberIds: memberIds(20, 10000),
        governor: {
          ...source.launchTransaction.governor,
          terminalVerdict: {
            ...source.launchTransaction.governor.terminalVerdict,
            liveMemberIds: memberIds(20, 20000),
            unverifiedMemberIds: memberIds(20, 22000),
          },
        },
      },
    };

    const findStatusPayload = (value: unknown): Record<string, unknown> | null => {
      const pending: unknown[] = [value];
      const seen = new Set<object>();
      while (pending.length > 0) {
        const current = pending.pop();
        if (typeof current === 'string') {
          try { pending.push(JSON.parse(current)); } catch { /* non-JSON text block */ }
          continue;
        }
        if (!current || typeof current !== 'object' || seen.has(current)) continue;
        seen.add(current);
        if (!Array.isArray(current) && Array.isArray((current as Record<string, unknown>).members) &&
            (current as Record<string, unknown>).launchTransaction) {
          return current as Record<string, unknown>;
        }
        pending.push(...(Array.isArray(current) ? current : Object.values(current)));
      }
      return null;
    };

    const assertTier = (result: CallResult, tier: 'standard' | 'trimmed') => {
      expect(result.isError).not.toBe(true);
      const out = findStatusPayload(result);
      expect(out).not.toBeNull();
      const memberCap = tier === 'standard' ? 12 : 8;
      const historyCap = tier === 'standard' ? 24 : 12;
      const members = out!.members as Array<Record<string, unknown>>;
      const transaction = out!.launchTransaction as Record<string, unknown> & { governor: Record<string, unknown> };
      const governor = transaction.governor;
      expect(members).toHaveLength(memberCap + 1);
      expect(members.at(-1)?.agentId).toBe('(truncated)');
      expect(governor.history as unknown[]).toHaveLength(historyCap);
      expect(governor.historyTotal).toBe(32);
      expect(transaction.requestedMemberIds).toHaveLength(memberCap);
      expect(transaction.requestedMemberIdsTotal).toBe(53);
      const verdict = governor.terminalVerdict as Record<string, unknown>;
      expect(verdict.liveMemberIds).toHaveLength(memberCap);
      expect(verdict.liveMemberIdsTotal).toBe(53);
      expect(verdict.unverifiedMemberIds).toHaveLength(memberCap);
      expect(verdict.unverifiedMemberIdsTotal).toBe(50);
      const lifecycle = out!.populationLifecycle as Record<string, unknown>;
      const lost = lifecycle.membersLost as Record<string, unknown>;
      expect(lost.count).toBe(2646);
      expect(lost.ownerIds).toHaveLength(memberCap);
      expect(lost.ownerIdsTruncated).toBe(2646);
      expect(JSON.stringify(out).length).toBeLessThan(30_000);
    };

    await withSdkHost(
      superuserExtra('&workspace=ws-test&client=su-tier-shaping&harness=papercup&role=operator'),
      async client => {
        const listing = await client.listTools();
        expect(listing.tools.some(tool => tool.name === 'fleet:status')).toBe(true);
        // Role-gated tools (requirePrincipal:false) register in the projected
        // registry, not the legacy principal-gated getCatalog() list.
        const statusDefinition = (await import('../../agent-tools/fleet_registry/status')).default;
        const mutableStatus = statusDefinition as unknown as {
          handler: (args: unknown, ctx: UnifiedToolContext) => Promise<unknown>;
          shape?: { standard?: unknown; trimmed?: unknown };
        };
        expect(mutableStatus.shape?.standard).toBeTypeOf('function');
        expect(mutableStatus.shape?.trimmed).toBeTypeOf('function');

        const originalHandler = mutableStatus.handler;
        mutableStatus.handler = async (_args, ctx) => {
          const context = ctx as unknown as Record<string, unknown>;
          handlerContexts.push({
            transport: context.transport,
            requestedStructured: context.requestedStructured,
            payloadTierOverride: context.payloadTierOverride,
          });
          // fleet:status's production handler returns a ToolResponse `{ data }`
          // envelope. Exercise that real registration path here: a raw JSON
          // ToolResult takes a separate MCP-only re-encoding branch and can
          // pass this boundary without proving the production data shaper ran.
          return { data: context.payloadTierOverride === 'full' ? fullSource : source };
        };

        try {
          const directStandard = await client.callTool({
            name: 'fleet:status',
            arguments: { fleet: 'rocket', payloadTier: 'standard' },
            _meta: { format: 'json' },
          }) as CallResult;
          assertTier(directStandard, 'standard');

          const nestedStandard = await client.callTool({
            name: 'tools:invoke',
            arguments: {
              name: 'fleet:status',
              args: { fleet: 'rocket' },
              payloadTier: 'standard',
            },
            _meta: { format: 'json' },
          }) as CallResult;
          assertTier(nestedStandard, 'standard');

          const directTrimmed = await client.callTool({
            name: 'fleet:status',
            arguments: { fleet: 'rocket', payloadTier: 'trimmed' },
            _meta: { format: 'json' },
          }) as CallResult;
          assertTier(directTrimmed, 'trimmed');

          const directFull = await client.callTool({
            name: 'fleet:status',
            arguments: { fleet: 'rocket', payloadTier: 'full' },
            _meta: { format: 'json' },
          }) as CallResult;
          expect(directFull.isError).not.toBe(true);
          const full = findStatusPayload(directFull);
          expect(full).not.toBeNull();
          expect(full!.members).toHaveLength(20);
          expect(full!.members_note).toBeUndefined();
          expect((full!.launchTransaction as { governor: { history: unknown[] } }).governor.history)
            .toHaveLength(32);
        } finally {
          mutableStatus.handler = originalHandler;
        }
      },
      'http',
    );

    expect(handlerContexts).toEqual([
      { transport: 'mcp', requestedStructured: false, payloadTierOverride: 'standard' },
      { transport: 'mcp', requestedStructured: false, payloadTierOverride: 'standard' },
      { transport: 'mcp', requestedStructured: false, payloadTierOverride: 'trimmed' },
      { transport: 'mcp', requestedStructured: false, payloadTierOverride: 'full' },
    ]);
  });

  // Compare literal payload and all semantic metadata, not JSON byte size or
  // a "format" label alone. Controlled corruptions below calibrate this oracle.
  function assertSameResult(actual: CallResult, expected: CallResult) {
    const payload = (result: CallResult) => {
      const { _buildStamp, ...meta } = result._meta ?? {};
      const buildId = (_buildStamp as { buildId?: unknown } | undefined)?.buildId;
      // The real annotator emits this notice once per owner, so two transports
      // can legitimately receive different notices. Match its metadata too;
      // arbitrary extra text must still fail parity.
      const content = result.content.filter(item => !(typeof buildId === 'string' &&
        item.type === 'text' && item.text?.startsWith(`ℹ served by build ${buildId} (up `)));
      return { content, meta: result._meta === undefined ? undefined : meta };
    };
    expect(payload(actual)).toEqual(payload(expected));
    expect(actual.structuredContent).toEqual(expected.structuredContent);
    expect(actual.isError).toEqual(expected.isError);
  }

  it('reconstructs positional scalars/free text and preserves keyed bulk arguments', async () => {
    configureColumns();
    const cases = [
      { wire: { row: 'WI-7, done,3,true,fixed it, added tests' },
        expected: { id: 'WI-7', state: 'done', count: 3, enabled: true, body: 'fixed it, added tests' } },
      { wire: { row: 'WI-8,todo' }, expected: { id: 'WI-8', state: 'todo' } },
      { wire: { id: 'WI-9', state: 'done', count: 0, enabled: false }, expected: { id: 'WI-9', state: 'done', count: 0, enabled: false } },
      { wire: { items: [{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'done' }] },
        expected: { items: [{ id: 'WI-1', state: 'todo' }, { id: 'WI-2', state: 'done' }] } },
    ];
    const arms: CallResult[][] = [];
    for (const connection of ['http', 'listener'] as const) {
      const results = await withSdkHost(parityExtra(), async client => {
        const listings = await client.listTools();
        const argsSchema = listings.tools.find(tool => tool.name === 'gatingtest:parity_args')?.inputSchema;
        expect(argsSchema).toBeDefined();
        expect(argsSchema?.oneOf).toHaveLength(2);
        const output: CallResult[] = [];
        for (const testCase of cases) {
          parityCalls.length = 0;
          const result = await client.callTool({ name: 'gatingtest:parity_args', arguments: testCase.wire }) as CallResult;
          expect(result.isError).toBeUndefined();
          expect(parityCalls).toHaveLength(1);
          expect(parityCalls[0]?.args).toEqual(testCase.expected);
          expect(parityCalls[0]?.ctx).toMatchObject({ transport: 'mcp', workspaceId: 'ws-test' });
          output.push(result);
        }
        return output;
      }, connection);
      arms.push(results);
    }
    arms[0]!.forEach((http, i) => assertSameResult(arms[1]![i]!, http));
  });

  it('negotiates compact/JSON/CSV, headerless columns, pagination and projection through dispatch', async () => {
    const arms: CallResult[][] = [];
    for (const connection of ['http', 'listener'] as const) {
      clearPrePromptRegistry();
      const results = await withSdkHost(parityExtra('json'), async client => {
        const call = async (args: Record<string, unknown>, meta?: Record<string, unknown>) =>
          await client.callTool({ name: 'gatingtest:parity_rows', arguments: args, _meta: meta }) as CallResult;
        // Per-call compact overrides the connection's requested JSON.
        const compact = await call({}, { format: 'compact' });
        expect(textOf(compact)).toMatch(/^format: toon\n/);
        const json = await call({});
        expect(JSON.parse(textOf(json))).toEqual(PARITY_ROWS.slice(0, 1));
        const csv = await call({}, { format: 'csv' });
        expect(textOf(csv)).toBe('format: csv\nid,state\nWI-1,todo');
        expect(compact._meta).toMatchObject({ nextCursor: 'second', degraded: true, degradedReasons: ['fixture'] });
        const page = await call({ page: compact._meta!.nextCursor });
        expect(JSON.parse(textOf(page))).toEqual(PARITY_ROWS.slice(1));
        expect(page._meta?.nextCursor).toBeUndefined();
        const projected = await call({ page: 'second', projection: { pick: ['[].id'] } });
        expect(JSON.parse(projected.content[0]!.text!)).toEqual([{ id: 'WI-2' }]);
        expect(projected._meta?.resultProjection).toMatchObject({ applied: true });
        expect(parityCalls.at(-1)?.args).toEqual({ page: 'second' });
        configureColumns();
        const headerless = await call({}, { format: 'compact' });
        expect(textOf(headerless)).toBe('format: csv\n[1]\nWI-1,todo');
        return [compact, json, csv, page, projected, headerless];
      }, connection);
      arms.push(results);
    }
    arms[0]!.forEach((http, i) => assertSameResult(arms[1]![i]!, http));
    const good = arms[1]![0]!;
    expect(() => assertSameResult({ ...good, content: [{ type: 'text', text: JSON.stringify(PARITY_ROWS) }] }, good)).toThrow();
    expect(() => assertSameResult({ ...good, _meta: {} }, good)).toThrow();
  });

  it.each(['http', 'listener'] as const)('%s rejects bad rows before execution and honors explicit delta cursors', async connection => {
    configureColumns();
    await withSdkHost(parityExtra(), async client => {
      await client.listTools();
      for (const row of ['WI-7,unknown', 'WI-7,done,not-a-number,true', 'WI-7,done,2,not-a-boolean']) {
        parityCalls.length = 0;
        const result = await client.callTool({ name: 'gatingtest:parity_args', arguments: { row } });
        expect(result.isError).toBe(true);
        expect(parityCalls).toEqual([]);
      }
      deltaRequested.length = 0;
      const first = await client.callTool({ name: 'gatingtest:delta_list', arguments: {}, _meta: { delta: 'full' } }) as CallResult;
      expect(first.isError).toBeUndefined();
      expect(deltaRequested).toEqual(['full']);
      const delta = first._meta?.delta as { cursor?: string; mode?: string };
      expect(delta).toMatchObject({ mode: 'full', cursor: expect.any(String) });
      const request = `not_modified~${delta.cursor}`;
      const second = await client.callTool({ name: 'gatingtest:delta_list', arguments: {}, _meta: { delta: request } }) as CallResult;
      expect(second.isError).toBeUndefined();
      expect(deltaRequested).toEqual(['full', request]);
      expect(second._meta?.delta).toMatchObject({ mode: 'not_modified', cursor: expect.any(String) });
      expect(textOf(second)).toContain('not_modified');
      const invalidBase = await client.callTool({
        name: 'gatingtest:delta_list', arguments: {}, _meta: { delta: 'not_modified~invalid-cursor' },
      }) as CallResult;
      expect(invalidBase._meta?.delta).toMatchObject({ mode: 'full' });
      expect(textOf(first)).toMatch(/^format: toon\n/);
      expect(textOf(first)).toContain('[12]');
      expect(invalidBase.content).toEqual(first.content);
    }, connection);
  });

  it.each([false, true])('negotiates output schema and structured content on the connection (structured=%s)', async structured => {
    const arms: CallResult[] = [];
    for (const connection of ['http', 'listener'] as const) {
      arms.push(await withSdkHost(parityExtra('json', structured), async client => {
        const catalog = await client.listTools();
        const schema = catalog.tools.find(tool => tool.name === 'gatingtest:parity_structured')?.outputSchema;
        if (structured) expect(schema).toMatchObject({ type: 'object', required: ['rows'] });
        else expect(schema).toBeUndefined();
        const result = await client.callTool({
          name: 'gatingtest:parity_structured', arguments: {},
          _meta: { format: 'json' },
        }) as CallResult;
        expect(result.structuredContent).toEqual(structured ? { rows: PARITY_ROWS } : undefined);
        expect(jsonOf(result)).toEqual({ rows: PARITY_ROWS });
        expect(parityCalls.at(-1)?.ctx).toMatchObject({
          transport: 'mcp', requestedFormat: 'json', requestedStructured: structured,
        });
        return result;
      }, connection));
    }
    assertSameResult(arms[1]!, arms[0]!);
    expect(() => assertSameResult({ ...arms[1]!, structuredContent: { rows: [] } }, arms[0]!)).toThrow();
    expect(() => assertSameResult({ ...arms[1]!, content: [
      ...arms[1]!.content, { type: 'text', text: 'unexpected payload text' },
    ] }, arms[0]!)).toThrow();
  });

  it.each(['http', 'listener'] as const)(
    '%s returns SDK-valid structuredContent when an opted-in write replays an older JSON receipt',
    async connection => {
      const payload = { rows: PARITY_ROWS };
      h.storedReplay = { content: [{ type: 'text', text: JSON.stringify(payload) }], _meta: { format: 'json' } };
      await withSdkHost(
        extraFor(signedUrl({ tools: 'gatingtest:replay_structured_write', role: 'reviewer', structured: '1' })),
        async client => {
          const catalog = await client.listTools();
          const replayTool = catalog.tools.find(tool => tool.name === 'gatingtest:replay_structured_write');
          expect(replayTool).toBeDefined();
          expect(replayTool?.outputSchema)
            .toMatchObject({ type: 'object', required: ['rows'] });
          parityCalls.length = 0;

          const replayed = await client.callTool({
            name: 'gatingtest:replay_structured_write',
            arguments: {},
            _meta: { structured: true, idempotencyKey: 'idem-replay-structured-rehydrate' },
          }) as CallResult;
          expect(replayed.structuredContent).toEqual(payload);
          expect(replayed._meta).toMatchObject({ replayed: true, structured: true });
          expect(JSON.parse(textOf(replayed))).toEqual(payload);
          expect(parityCalls).toEqual([]); // a replay returns without re-running the write
        },
        connection,
      );
    },
  );

  it.each([
    { firstCallMode: 'catalog-backed', resultShape: 'plain-object', large: false },
    { firstCallMode: 'catalog-backed', resultShape: 'output-envelope', large: true },
    { firstCallMode: 'catalog-bypass', resultShape: 'plain-object', large: false },
    { firstCallMode: 'catalog-bypass', resultShape: 'output-envelope', large: true },
  ] as const)(
    '$firstCallMode first call replays a $resultShape result to a schema-aware client',
    async ({ firstCallMode, resultShape, large }) => {
      parityCalls.length = 0;
      const name = 'gatingtest:replay_structured_write';
      const idempotencyKey = `idem-replay-mode-matrix-${firstCallMode}-${resultShape}`;
      const args = large ? { large: true } : {};
      const expected = large ? LARGE_PARITY_PAYLOAD : { rows: PARITY_ROWS };
      const outputGroupId = `output-group-replay-mode-matrix-${firstCallMode}-${resultShape}`;
      const extra = extraFor(signedUrl({ tools: name, role: 'reviewer',
        ...(firstCallMode === 'catalog-backed' ? { structured: '1' } : {}) }));
      const firstMeta = {
        idempotencyKey,
        format: 'json',
        outputGroupId,
        ...(firstCallMode === 'catalog-backed' ? { structured: true } : {}),
      };
      h.replayLookupFromStores = true;

      if (firstCallMode === 'catalog-backed') {
        await withSdkHost(extra, async client => {
          const catalog = await client.listTools();
          expect(catalog.tools.find(tool => tool.name === name)?.outputSchema)
            .toMatchObject({ type: 'object', required: ['rows'] });

          if (large) {
            // Exhaust the aggregate cohort so the idempotent call's stored
            // model content is a result-door envelope. Direct handler calls
            // avoid the SDK's outputSchema check for these seed results.
            for (let i = 0; i < 2; i += 1) {
              const seed = await callTool(name, { large: true }, extra, { format: 'json', outputGroupId });
              expect(seed.isError).not.toBe(true);
            }
          }

          const first = await client.callTool({ name, arguments: args, _meta: firstMeta }) as CallResult;
          expect(first.isError, textOf(first)).not.toBe(true);
          expect(parityCalls.at(-1)?.ctx).toMatchObject({ requestedFormat: 'json', requestedStructured: true });
          expect(first.structuredContent).toEqual(expected);
          expect(h.replayStores).toHaveLength(1);
          const stored = h.replayStores[0]!.result as CallResult;
          expect(stored.structuredContent).toEqual(expected);
          if (large) {
            const modelContent = jsonOf(stored) as { schemaVersion?: unknown; state?: unknown };
            expect(modelContent.schemaVersion).toBe('papercusp.output-envelope/v1');
            expect(modelContent.state).toBe('incomplete');
          } else {
            expect(jsonOf(stored)).toEqual(expected);
          }

          const replayed = await client.callTool({
            name,
            arguments: args,
            _meta: { idempotencyKey, format: 'json', structured: true, outputGroupId },
          }) as CallResult;
          expect(replayed.structuredContent).toEqual(expected);
          expect(replayed._meta).toMatchObject({ replayed: true, structured: true });
          expect(parityCalls).toHaveLength(large ? 3 : 1);
        }, 'http');
        return;
      }

      // The first transport call bypasses tools/list and the SDK's outputSchema
      // validator, matching a catalog-bypass client that requests JSON text only.
      if (large) {
        for (let i = 0; i < 2; i += 1) {
          const seed = await callTool(name, { large: true }, extra, { format: 'json', outputGroupId });
          expect(seed.isError).not.toBe(true);
        }
      }
      const first = await callTool(name, args, extra, firstMeta);
      expect(first.structuredContent).toBeUndefined();
      expect(h.replayStores).toHaveLength(1);
      const stored = h.replayStores[0]!.result as CallResult;
      expect(stored.structuredContent).toBeUndefined();
      if (large) {
        const modelContent = jsonOf(stored) as { schemaVersion?: unknown; state?: unknown };
        expect(modelContent.schemaVersion).toBe('papercusp.output-envelope/v1');
        expect(modelContent.state).toBe('incomplete');
        const replaySource = (stored as CallResult & { replaySource?: CallResult }).replaySource;
        expect(replaySource).toBeDefined();
        expect(jsonOf(replaySource as CallResult)).toEqual(expected);
      } else {
        expect(jsonOf(stored)).toEqual(expected);
      }

      const handlerCallsBeforeReplay = parityCalls.length;
      const recoveryExtra = extraFor(signedUrl({ tools: name, role: 'reviewer', structured: '1' }));
      await withSdkHost(recoveryExtra, async client => {
        const catalog = await client.listTools();
        expect(catalog.tools.find(tool => tool.name === name)?.outputSchema)
          .toMatchObject({ type: 'object', required: ['rows'] });
        const replay = client.callTool({
          name,
          arguments: args,
          _meta: { idempotencyKey, format: 'json', structured: true, outputGroupId },
        });
        if (large) {
          // The first receipt's content is an incomplete result-door envelope,
          // but its retained pre-door source must satisfy this structured retry.
          const replayed = await replay as CallResult;
          expect(replayed.isError).not.toBe(true);
          expect(replayed.structuredContent).toEqual(expected);
          expect(replayed._meta).toMatchObject({ replayed: true, structured: true });
        } else {
          const replayed = await replay as CallResult;
          expect(replayed.structuredContent).toEqual(expected);
          expect(replayed._meta).toMatchObject({ replayed: true, structured: true });
        }
      }, 'http');
      expect(parityCalls).toHaveLength(handlerCallsBeforeReplay);
    },
  );

  it.each(['http', 'listener'] as const)(
    '%s keeps structuredContent output-schema-valid after trimmed payload shaping',
    async connection => {
      await withSdkHost(
        extraFor(signedUrl({
          tools: 'gatingtest:parity_structured_large',
          ctx_tier: 'trimmed',
          structured: '1',
        })),
        async client => {
          const catalog = await client.listTools();
          expect(catalog.tools.find(tool => tool.name === 'gatingtest:parity_structured_large')?.outputSchema)
            .toMatchObject({ type: 'object', required: ['rows'] });

          // The direct tools/call path is the schema validator's enforcement
          // point. Before the fix, generic trimmed-tier projection wrapped this
          // large payload and the SDK rejected it for missing/extra fields.
          const result = await client.callTool({
            name: 'gatingtest:parity_structured_large',
            arguments: {},
            _meta: { format: 'json', structured: true },
          }) as CallResult;
          expect(result.structuredContent).toEqual(LARGE_PARITY_PAYLOAD);
          // The model-facing text may be a result-door reference envelope when
          // the raw structured payload is larger than the inline budget; the
          // schema-bearing field above remains the authoritative full value.
          expect(result.content[0]?.text).toBeDefined();
          expect(parityCalls.at(-1)?.ctx).toMatchObject({
            contextTier: 'trimmed', requestedStructured: true,
          });
        },
        connection,
      );
    },
  );
});

beforeEach(() => {
  // Each case reuses spawn-1; a prior case's legitimate nudge must not
  // contaminate another case's literal model-content oracle.
  _resetBatchNudgeState();
  vi.resetAllMocks(); // restores the vi.fn() originals, drops *Once queues
  h.readSessionConfinement.mockResolvedValue(null);
  h.getSessionBrief.mockResolvedValue(null);
  h.kernelAuthority.rows = null;
  h.kernelAuthority.launchRecord = null;
  h.kernelAuthority.migrationRead = null;
  h.kernelAuthority.usedToolNames = null;
  seen.length = 0;
  h.resourceReads.length = 0;
  deltaRequested.length = 0;
  h.withWorkspaceCalls.length = 0;
  h.nativeSessionBinding = 'unbound';
  h.nativeSessionRows = null;
  h.livePtyHost = null;
  h.nativeSessionVerifierFailure = null;
  h.nativeSessionCalls.length = 0;
  h.nativeSessionWorkspaceScopes.length = 0;
  h.nativeSessionDiagnosticContexts.length = 0;
  h.nativeVerifierSampling.length = 0;
  h.workspaceAcquireError = null;
  h.getPresence.mockResolvedValue(null);
  h.assemblePresenceSnapshot.mockResolvedValue({
    as_of: '2026-01-01T00:00:00.000Z',
    scope: 'workspace',
    summary: {
      active: 0,
      stale: 0,
      federated: 0,
      wakeable: 0,
      onDesktop: 0,
      viewerAttached: 0,
      byState: { live: 0, parked: 0, ended: 0, recorded: 0 },
      byContextPressure: { high: 0, critical: 0 },
    },
    active: [],
    etag: 'gating-matrix-empty-presence',
  });
  h.rubricGet.mockResolvedValue(null);
  h.pluginHostWarm.mockResolvedValue({});
  h.commitFailure = null;
  h.txEvents.length = 0;
  h.replayStores.length = 0;
  h.replayLookupFromStores = false;
  h.afterReplayStore = null;
  h.storedReplay = null;
  h.invocations.length = 0;
  h.deliveryBackfills.length = 0;
  replayValidationSeen.length = 0;
  replayBusinessErrorSeen.length = 0;
  resetResultDoorAggregatesForTests();
  h.scopedClampFlag.value = false;
  h.verifyExplicitPlanHarness.mockResolvedValue(false);
  h.goalLocalPlacement.allow = false;
  h.goalLocalPlacement.calls.length = 0;
  invokeProbeSeen.length = 0;
  txlessRoleProbeSeen.length = 0;
  latePluginSeen.length = 0;
  unregisterProjectedToolsForPlugin(LATE_PLUGIN_NAME);
  delete process.env.PAPERCUSP_REQUIRE_SPAWN_SIG;
  _resetVerifiedSpawns(); // every case reuses spawn='spawn-1' — isolate the real verified-spawn tracker per test

  // tools/list applies every registered entity-enum loader while building the
  // advertised schemas. This is a unit-tier handler test: keep the route
  // assertions independent of the production DB-backed pot/harness loaders.
  // The loaders are over-cap anyway, so empty stubs preserve the published
  // schema while preventing a swallowed unit-tier DB reach from red-pinning
  // the suite.
  setEntityEnum('pot', async () => []);
  setEntityEnum('harness', async () => []);
  h.identityListingTest = false;
  h.identityListingUnresolved = false;
  h.identityOperationRecord = null;
  h.identityAdmittedToolNames = new Set();
  h.identityListingRoleCaps = [];
  h.identityObservedRoleCaps = [];
  h.identityListedCandidateNames = [];
});

/* ─── caller-specified result projection (P-020 / D-041) ────────────────── */

describe('projection — the caller-specified reduction stage at the dispatch layer', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('STRIPS `projection` before the tool sees it — tool schemas are additionalProperties:false', () => {
    // The whole point of a dispatch-level reserved arg: it must never reach the
    // tool's own schema validation, or every tool in the catalog rejects it as
    // an unknown key.
    return callTool(
      'gatingtest:scoped',
      { probe: 'v', projection: { pipe: [{ op: 'head', n: 1 }] } },
      scoped('ws-test'),
    ).then(() => {
      expect(seen).toHaveLength(1);
      expect(seen[0].args).toEqual({ probe: 'v' });
      expect(seen[0].args).not.toHaveProperty('projection');
    });
  });

  it('applies the projection to the result and reports it in _meta', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      { projection: { pipe: [{ op: 'count' }] } },
      scoped('ws-test'),
    );
    expect(res.isError).not.toBe(true);
    // The probe returns one line; `count` (wc -l) turns the body into "1".
    expect(res.content[0]?.text).toBe('1');
    expect(textOf(res)).toContain('[projection: wc -l');
    expect(res._meta?.resultProjection).toMatchObject({ applied: true, linesIn: 1, linesOut: 1 });
  });

  it('keeps the default rendering for line projections and requests JSON for picks', async () => {
    await callTool(
      'gatingtest:parity_rows',
      { projection: { pipe: [{ op: 'grep', pattern: 'WI-1' }] } },
      scoped('ws-test'),
    );
    expect(parityCalls.at(-1)?.ctx.requestedFormat).toBeUndefined();

    await callTool(
      'gatingtest:parity_rows',
      { projection: { pick: ['[0].id'] } },
      scoped('ws-test'),
    );
    expect(parityCalls.at(-1)?.ctx.requestedFormat).toBe('json');
  });

  it('materializes an implicit compact direct result as JSON before structured pick', async () => {
    const res = await callTool(
      'gatingtest:invoke_target',
      { projection: { pick: ['lines[0]'] } },
      scoped('ws-test'),
    );
    expect(res.isError).not.toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ lines: ['alpha'] });
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
  });

  it('a projection that filters everything out returns an empty body, not the unfiltered result', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      { projection: { pipe: [{ op: 'grep', pattern: 'definitely-not-present' }] } },
      scoped('ws-test'),
    );
    // EI-20720054720826414: an emptied body is a DEGRADED verdict, and degraded
    // verdicts now LEAD the content (head-truncation-proof) — so content[0] is
    // the REMOVED-EVERYTHING warning and the empty body follows it.
    expect(res.content[0]?.text).toContain('REMOVED EVERYTHING');
    expect(res.content[1]?.text).toBe('');
    expect(textOf(res)).not.toContain('gatingtest:scoped-ok');
  });

  it('an INVALID projection fails CLOSED — the tool never runs', async () => {
    // Fail-closed is the point: a caller who asked for a reduction must not be
    // silently handed the full result (and its token bill) instead.
    const res = await callTool(
      'gatingtest:scoped',
      { projection: { pipe: [{ op: 'grep', pattern: '[[:digit:]]' }] } },
      scoped('ws-test'),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('projection_invalid');
    expect(textOf(res)).toContain('POSIX');
    expect(seen).toHaveLength(0); // the tool was never dispatched
  });

  it('explains the pick-list ceiling when a direct projection is too large', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      { projection: { pick: Array.from({ length: MAX_PICK_PATHS + 1 }, (_, i) => `field${i}`) } },
      scoped('ws-test'),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`projection.pick accepts at most ${MAX_PICK_PATHS} paths`);
    expect(textOf(res)).toContain(`A single \`pick\` list accepts at most ${MAX_PICK_PATHS} paths`);
    expect(seen).toHaveLength(0);
  });

  it('no `projection` arg leaves the result byte-identical (the overwhelmingly common path)', async () => {
    const res = await callTool('gatingtest:scoped', { probe: 'v' }, scoped('ws-test'));
    expect(textOf(res)).toBe('gatingtest:scoped-ok');
    expect(res._meta?.resultProjection).toBeUndefined();
  });
});

/* ─── applyResultDoor choke point honors projected.skipResultDoor (EI-19389430626961976) ──
 *
 * `skipResultDoor` was threaded end-to-end through define-tool.ts /
 * tool-projection.ts and set `true` on the real activity:report tool
 * (EI-19386201256023240), but the ONE call site that invokes
 * `applyResultDoor` never read it — every tools/call result was doored
 * regardless of the flag, so the opt-out was dead code. These pin that the
 * choke point actually branches on it, not just that the flag exists on the
 * type.
 */
describe('applyResultDoor choke point honors projected.skipResultDoor', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('doors (truncates + spills) an oversized result by default', async () => {
    const res = await callTool('gatingtest:door_default', {}, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toMatchObject({ truncated: true, structural: true });
    expect(textOf(res)).not.toContain(DOOR_TEST_BIG_TEXT);
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(body._projection.cursor).toMatchObject({
      kind: 'scratch-page',
      tool: 'capability:read',
      args: { byte_offset: 0, byte_limit: 3_072 },
    });
  });

  it("skipResultDoor:'programmatic-caller' on the tool definition skips the door entirely — full body, no spill", async () => {
    const res = await callTool('gatingtest:door_skip', {}, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(textOf(res)).toContain(DOOR_TEST_BIG_TEXT);
  });

  // WI-37843: the reason must not become decorative. BOTH reasons skip the door
  // — if this ever regressed to matching only the original literal, coord:orient
  // would silently start being truncated again at 1500 tokens, which is exactly
  // the state this work removed and is invisible without an assertion.
  it("skipResultDoor:'oversize-by-design' also skips the door — full body, no spill", async () => {
    const res = await callTool('gatingtest:door_skip_oversize', {}, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(textOf(res)).toContain(DOOR_TEST_BIG_TEXT);
  });

  it('projects an orient-shaped oversize-by-design result before applying its door exemption', async () => {
    const res = await callTool(
      'gatingtest:door_skip_oversize',
      { projection: { pick: ['codexLocks.lockMode'] } },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      codexLocks: { lockMode: 'automatic' },
    });
    expect(textOf(res)).not.toContain(DOOR_TEST_BIG_TEXT);
  });

  it('projects the unshaped orient payload before its defineTool hard ceiling can discard the selected field', async () => {
    const res = await callTool(
      'gatingtest:orient_ceiling_projection',
      { projection: { pick: ['codexLocks.lockMode'] } },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      codexLocks: { lockMode: 'automatic' },
    });
    expect(textOf(res)).not.toContain(DOOR_TEST_BIG_TEXT);
  });

  // EI-23774219620725180: an all-miss on an oversized promoted body no longer fails
  // open into the full source (which then needed the door to bound it) — it REFUSES
  // with the key list, so the door never has anything oversized to bound.
  it('refuses with the key list — never the promoted full source — when an orient projection misses', async () => {
    const res = await callTool(
      'gatingtest:orient_ceiling_projection',
      { projection: { pick: ['notARealOrientField'] } },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultProjection).toMatchObject({
      applied: true,
      notes: expect.arrayContaining([expect.stringContaining('WITHHELD')]),
    });
    const refused = projectionRefusalText(res);
    expect(refused).toContain('projection_refused');
    // 61 root keys: the list is bounded (40) and says how many it elided.
    expect(refused).toContain('noise0 (string)');
    expect(refused).toContain('… +21 more');
    expect(refused).not.toContain(DOOR_TEST_BIG_TEXT);
  });
});

/* ─── nested result-door exemption survives tools:invoke (EI-20311977175786095) ── */
// The inner target owns the `skipResultDoor` declaration, but the outer
// tools:invoke wrapper is the result that reaches the transport choke point.
// This must preserve the target's machine-readable body instead of appending a
// truncation footer that makes the JSON unusable to ptool.
describe('tools:invoke inherits the nested target result-door exemption', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('keeps an oversized programmatic target body parseable', async () => {
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:door_skip', args: {} },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(textOf(res)).toContain(DOOR_TEST_BIG_TEXT);
  });

  it('keeps the real rubrics:get criteria complete through nested tools:invoke', async () => {
    const rubricJsonChars = JSON.stringify({
      ok: true,
      results: [{ ok: true, rubricId: NESTED_RUBRIC_ID, rubric: NESTED_RUBRIC }],
      counts: { ok: 1, failed: 0 },
    }).length;
    expect(rubricJsonChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rubricJsonChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    h.rubricGet.mockResolvedValueOnce(NESTED_RUBRIC);

    const res = await callTool(
      'tools:invoke',
      { name: 'rubrics:get', args: { rubricRef: NESTED_RUBRIC_ID, detail: 'full' } },
      scoped('ws-test'),
      { format: 'json' },
    );

    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(h.rubricGet).toHaveBeenCalledWith(NESTED_RUBRIC_ID);
    const payload = JSON.parse(res.content[0]?.text ?? '') as {
      results: Array<{
        rubric: {
          criteria: Array<{ key: string; model: string; method: string; driftMarkers: string }>;
        };
      }>;
    };
    expect(payload.results[0]?.rubric.criteria).toHaveLength(NESTED_RUBRIC.criteria.length);
    expect(payload.results[0]?.rubric.criteria.map((criterion) => criterion.key)).toEqual(
      NESTED_RUBRIC.criteria.map((criterion) => criterion.key),
    );
    expect(payload.results[0]?.rubric.criteria.every((criterion) =>
      criterion.model.length > 100 && criterion.method.length > 100 && criterion.driftMarkers.length > 100,
    )).toBe(true);
  });

  it('projects an orient-shaped oversize-by-design target before carrying its outer exemption', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:door_skip_oversize',
        args: { projection: { pick: ['codexLocks.lockMode'] } },
      },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      codexLocks: { lockMode: 'automatic' },
    });
    expect(textOf(res)).not.toContain(DOOR_TEST_BIG_TEXT);
  });

  it('projects a hard-ceiling orient target before nested tools:invoke carries it outward', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:orient_ceiling_projection',
        args: { projection: { pick: ['codexLocks.lockMode'] } },
      },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toBeUndefined();
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({
      codexLocks: { lockMode: 'automatic' },
    });
  });

  it('structurally bounds an ordinary oversized target body at the outer shared door', async () => {
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:door_default', args: {} },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toMatchObject({ truncated: true, structural: true });
    const body = JSON.parse((res.content[0] as { text: string }).text);
    expect(body._projection).toMatchObject({
      kind: 'bounded-payload',
      cursor: { kind: 'scratch-page', tool: 'capability:read' },
    });
    expect(textOf(res)).not.toContain(DOOR_TEST_BIG_TEXT);
  });

  it('spills the exact unshaped checkpoint from an explicit-full nested target', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:full_source_spill',
        args: { payloadTier: 'full' },
      },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    // EI-22167228731928620 moved an OVERFLOWING explicit-full body off the generic
    // bounded-payload reprojection and onto the hard-spill reference envelope: that
    // generic walk is field-blind, and the raw body here is LARGER than a 'trimmed'
    // call's precisely because the explicit-full exemption skipped the shaper, so
    // reprojecting it could leave less inline than the tier the caller opted out of.
    // The property THIS test guards is unchanged — the spilled bytes must be the
    // TARGET's unshaped source, never its lossy shaper's output — but the spill path
    // is now advertised on the door meta rather than in a body `_projection`. Pin the
    // route by name too, so a silent re-route back to the field-blind walk fails here
    // instead of quietly changing what an explicit-full caller can recover.
    const door = res._meta?.resultDoor as
      | { truncated?: boolean; structural?: boolean; reason?: string; spillFailed?: boolean; spillPath?: string }
      | undefined;
    expect(door).toMatchObject({
      truncated: true,
      structural: true,
      reason: 'explicit-full-request-overflow',
      spillFailed: false,
    });

    const spillPath = door?.spillPath;
    expect(typeof spillPath).toBe('string');
    const spill = readFileSync(spillPath as string, 'utf8');
    expect(spill).toContain(FULL_SOURCE_CHECKPOINT);
    expect(spill).not.toContain('SHAPED_CHECKPOINT_MARKER');
  });

  it('uses the nested target name for tool-specific truncation recovery guidance', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:truncated_source_spill',
        args: { payloadTier: 'full' },
      },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    const envelope = JSON.parse(textOf(res));
    expect(envelope.incomplete).toMatchObject({
      reason: 'explicit-full-request-overflow',
      recoverable: false,
    });
    expect(envelope.incomplete.note).toContain('gatingtest:truncated_source_spill');
    expect(envelope.incomplete.note).toContain('documented field-specific recovery handle');
    expect(envelope.incomplete.note).not.toContain('wider per-field limit');
  });

  it('refuses an implicit nested projection miss with its key list, without labeling it explicit full', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:full_source_spill',
        args: { projection: { pick: ['notARealCheckpointField'] } },
      },
      scoped('ws-test'),
      { format: 'json' },
    );

    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultProjection).toMatchObject({
      applied: true,
      notes: expect.arrayContaining([expect.stringContaining('pick matched NOTHING')]),
    });
    // The partial result may use a reference envelope; its payload must remain
    // the bounded refusal, and must never become the promoted full source.
    const refused = projectionRefusalText(res);
    expect(refused).toContain('projection_refused');
    expect(refused).not.toContain(FULL_SOURCE_CHECKPOINT_TAIL);
    expect(res._meta?.resultDoor).not.toMatchObject({ reason: 'explicit-full-request-overflow' });
  });
});

/* ─── in-process tools:invoke payload-tier forwarding (EI-21584932731440718) ── */

describe('in-process ctx.dispatchTool forwards an outer payloadTier to tools:invoke targets', () => {
  const spawn: BuiltSpawnContext = {
    workspaceId: 'ws-test',
    harnessSlug: 'papercup',
    role: 'scoper',
    featureId: null,
    chunkId: null,
    runId: 'in-process-payload-tier-run',
    spawnId: 'in-process-payload-tier-spawn',
    parentSpawnId: null,
    uiClientId: null,
    detectorSessionKey: null,
    isSuperuser: true,
  };

  it('preserves the target source when code/recipe dispatch supplies payloadTier full on the wrapper', async () => {
    const ctx = await __buildMcpToolContext_forTests(spawn, undefined, undefined);
    const res = await ctx.dispatchTool!('tools:invoke', {
      name: 'gatingtest:full_source_spill',
      args: {},
      payloadTier: 'full',
    });

    expect(res.isError).not.toBe(true);
    expect(JSON.stringify(res)).toContain(FULL_SOURCE_CHECKPOINT);
    expect(JSON.stringify(res)).not.toContain('SHAPED_CHECKPOINT_MARKER');
  });
});

/* ─── plugin-host-aware tools:invoke miss recovery (EI-22390450916579377) ── */

describe('tools:invoke re-resolves plugin-shaped misses after a bounded host warm', () => {
  it('dispatches a plugin tool that registers while the cached host promise settles', async () => {
    h.pluginHostWarm.mockImplementationOnce(async () => {
      registerLatePluginTool();
      return {};
    });

    const res = await callTool(
      'tools:invoke',
      { name: LATE_PLUGIN_TOOL, args: {} },
      superuserExtra('&workspace=ws-test&harness=papercup'),
    );

    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('late-plugin-ok');
    expect(latePluginSeen).toEqual([{}]);
    expect(h.pluginHostWarm).toHaveBeenCalledTimes(1);
  });

  it('does not warm the plugin host for a core ns:verb miss', async () => {
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:still-missing', args: {} },
      superuserExtra('&workspace=ws-test&harness=papercup'),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('unknown_tool');
    expect(h.pluginHostWarm).not.toHaveBeenCalled();
  });

  it('returns after the short budget when plugin discovery stays pending', async () => {
    vi.useFakeTimers();
    try {
      const resolve = vi.fn(() => undefined);
      const warm = vi.fn(() => new Promise<never>(() => {}));
      const pending = resolveMcpTargetAfterPluginHostWarm('gating-late.never', {
        resolve,
        warm,
        budgetMs: 25,
      });

      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeUndefined();
      expect(warm).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

/* ─── projection through the tools:invoke re-dispatch path (EI-19386035445533031) ── */
//
// The result-door footer tells a caller whose result overflowed to nest
// `projection` inside `args`: `tools:invoke({ name, args: { ..., projection } })`.
// The top-level dispatch strip above (the `projection — the caller-specified …`
// describe block) only ever sees `projection` as a SIBLING of `name`/`args` on
// the OUTER tools:invoke call, so it does nothing here — the re-dispatch closure
// (`dispatchTool` in _mcp-handler.ts) must do its own strip+apply, or the target
// tool's closed-shape validator (EI-10883) rejects `projection` as an unknown key.

describe('tools:invoke re-dispatch — `projection` nested in the target call\'s `args`', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);
  // format:'json' — the target's plain-object return otherwise negotiates
  // compact TOON encoding by default (P-009), which is beside the point here.
  const invokeCall = (targetArgs: Record<string, unknown>, ws = 'ws-test') =>
    callTool('tools:invoke', { name: 'gatingtest:invoke_target', args: targetArgs }, scoped(ws), { format: 'json' });

  it('forwards a top-level projection into the target call instead of projecting the wrapper', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:invoke_target',
        args: {},
        projection: { pick: ['lines[0]'] },
      },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(invokeProbeSeen).toEqual([{}]);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ lines: ['alpha'] });
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
  });

  it('forwards a top-level projection when tools:invoke target args arrive JSON-stringified', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:invoke_target',
        // ptool deliberately uses this wire shape so shell-heavy nested args
        // survive the host/MCP boundary exactly once.
        args: JSON.stringify({ probe: 'encoded' }),
        projection: { pick: ['lines[0]'] },
      },
      scoped('ws-test'),
      { format: 'json' },
    );
    expect(res.isError).not.toBe(true);
    expect(invokeProbeSeen).toEqual([{ probe: 'encoded' }]);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ lines: ['alpha'] });
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
  });

  it('strips `projection` before the TARGET tool\'s own (closed-shape) validator sees it', async () => {
    const res = await invokeCall({ probe: 'v', projection: { pipe: [{ op: 'head', n: 1 }] } });
    expect(res.isError).not.toBe(true);
    expect(invokeProbeSeen).toEqual([{ probe: 'v' }]);
  });

  it('applies the projection to the re-dispatched result, same as a direct call', async () => {
    const res = await invokeCall({ projection: { pick: ['lines[0]'] } });
    expect(res.isError).not.toBe(true);
    // Only content[0] is the JSON body — tools:invoke's own declared
    // `guidance.seeAlso` appends a SEPARATE "See also: …" content item, so
    // joining the whole thing (textOf) would concatenate two JSON-adjacent
    // texts into invalid JSON.
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ lines: ['alpha'] });
  });

  it('preserves outer projection pick paths through the final result door', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:invoke_target',
        args: { probe: 'deep' },
        projection: {
          pick: [
            'results[].threadWindow.posts[].body',
            'results[].threadWindow.posts[].author_id',
            'results[].threadWindow.posts[].created_ts',
          ],
        },
      },
      scoped('ws-test'),
      { format: 'json' },
    );

    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toMatchObject({ truncated: true });
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text) as {
      results: Array<{
        threadWindow: { posts: Array<{ body?: string; author_id?: string; created_ts?: string }> };
      }>;
    };
    const post = payload.results[0]?.threadWindow.posts[0];
    expect(post).toMatchObject({ author_id: 'agent-1', created_ts: '2026-10-06T00:00:00.000Z' });
    expect(post?.body).toMatch(/^selected-body-/);
  });

  it('preserves nested tools:invoke projection paths through raw JSON re-encoding and the final result door', async () => {
    const paths = [
      'results[].threadWindow.posts[].body',
      'results[].threadWindow.posts[].author_id',
      'results[].threadWindow.posts[].created_ts',
    ];
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:invoke_target',
        args: { probe: 'deep', projection: { pick: paths } },
      },
      scoped('ws-test'),
      { format: 'json' },
    );

    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toMatchObject({ truncated: true });
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text) as {
      results: Array<{
        threadWindow: { posts: Array<{ body?: string; author_id?: string; created_ts?: string }> };
      }>;
    };
    const post = payload.results[0]?.threadWindow.posts[0];
    expect(post).toMatchObject({ author_id: 'agent-1', created_ts: '2026-10-06T00:00:00.000Z' });
    expect(post?.body).toMatch(/^selected-body-/);
  });

  it('preserves selected leaf fields across six rows through the tools:invoke result door', async () => {
    const paths = [
      'results[].threadWindow.posts[].body',
      'results[].threadWindow.posts[].author_id',
      'results[].threadWindow.posts[].created_ts',
    ];
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:invoke_target',
        args: { probe: 'deep-many' },
        projection: { pick: paths },
      },
      scoped('ws-test'),
      { format: 'json' },
    );

    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toMatchObject({ truncated: true });
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text) as {
      results: Array<{
        threadWindow: { posts: Array<{ body?: string; author_id?: string; created_ts?: string }> };
      }>;
    };
    const posts = payload.results[0]?.threadWindow.posts;
    expect(posts).toHaveLength(6);
    expect(posts?.map((post) => post.author_id)).toEqual(Array.from({ length: 6 }, (_, i) => `agent-${i}`));
    expect(posts?.map((post) => post.created_ts)).toEqual(
      Array.from({ length: 6 }, (_, i) => `2026-10-06T00:00:0${i}.000Z`),
    );
    expect(posts?.map((post, i) => post.body?.startsWith(`selected-body-${i}-`))).toEqual(
      Array.from({ length: 6 }, () => true),
    );
  });

  it('preserves selected payload.observation leaves through the final result door', async () => {
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:invoke_target',
        args: { probe: 'observation' },
        projection: { pick: ['payload.observation.ratings', 'payload.observation.subject'] },
      },
      scoped('ws-test'),
      { format: 'json' },
    );

    expect(res.isError).not.toBe(true);
    expect(res._meta?.resultDoor).toMatchObject({ truncated: true });
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text) as {
      payload: { observation?: { ratings?: Array<{ clarity?: number; comments?: string }>; subject?: string } };
    };
    const observation = payload.payload.observation;
    expect(observation?.ratings?.[0]).toMatchObject({ clarity: 5 });
    expect(observation?.ratings?.[0]?.comments).toMatch(/^selected-rating-/);
    expect(observation?.subject).toMatch(/^selected-subject-/);
  });

  it('materializes an implicit compact nested result as JSON before structured pick', async () => {
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:invoke_target', args: { projection: { pick: ['lines[0]'] } } },
      scoped('ws-test'),
    );
    expect(res.isError).not.toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ lines: ['alpha'] });
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
  });

  it('materializes an explicit-full compact nested result as JSON before structured pick', async () => {
    // An explicit target payloadTier is authoritative for shaping but must not
    // force the intermediate projection source to remain compact TOON. This is
    // the exact work_items:get shape reported by EI-21640976904886373.
    const res = await callTool(
      'tools:invoke',
      {
        name: 'gatingtest:invoke_target',
        args: { payloadTier: 'full', projection: { pick: ['lines[0]'] } },
      },
      scoped('ws-test'),
    );
    expect(res.isError).not.toBe(true);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ lines: ['alpha'] });
    expect(res._meta?.resultProjection).toMatchObject({ applied: true });
    expect(textOf(res)).not.toContain('pick SKIPPED');
  });

  it('applies a registered named view on a real nested target before the shared result door', async () => {
    const declared = NAMED_VIEWS['work_items:get']!.capsule!;
    const res = await callTool(
      'tools:invoke',
      {
        name: 'work_items:get',
        args: { id: 'EI-gating-matrix', view: 'capsule' },
      },
      scoped('ws-test'),
      { format: 'json' },
    );

    // `view` is not in work_items:get's closed schema. Reaching a successful
    // real handler result proves the nested dispatcher stripped it first.
    expect(res.isError).not.toBe(true);
    const receipt = res._meta?.namedView as
      | {
          view: string;
          version: number;
          applied: boolean;
          fields: string[];
          budgetChars: number;
          returnedChars: number;
        }
      | undefined;
    expect(receipt).toMatchObject({
      view: 'capsule',
      version: declared.version,
      applied: true,
      budgetChars: declared.budgetChars,
    });
    expect(receipt?.fields).toEqual(declared.fields);
    expect(receipt!.returnedChars).toBeLessThanOrEqual(receipt!.budgetChars);

    // The receipt must survive in both channels, and the view must keep the
    // outer generic door from replacing the capsule with a spill projection.
    const firstText = res.content[0]?.text ?? '';
    expect(firstText).toContain(`ⓘ view "capsule" v${declared.version} applied`);
    expect(res._meta?.resultDoor).toBeUndefined();
    const [capsuleText] = firstText.split('\nⓘ view ');
    expect(Object.keys(JSON.parse(capsuleText!) as Record<string, unknown>)).toEqual(['results']);
  });

  it('an INVALID nested projection fails CLOSED — the target tool is never dispatched', async () => {
    const res = await invokeCall({ projection: { pipe: [{ op: 'grep', pattern: '[[:digit:]]' }] } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('projection_invalid');
    expect(invokeProbeSeen).toEqual([]); // never reached the target tool
  });

  it('explains the pick-list ceiling when a nested projection is too large', async () => {
    const res = await invokeCall({
      projection: { pick: Array.from({ length: MAX_PICK_PATHS + 1 }, (_, i) => `field${i}`) },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(`projection.pick accepts at most ${MAX_PICK_PATHS} paths`);
    expect(textOf(res)).toContain(`A single \`pick\` list accepts at most ${MAX_PICK_PATHS} paths`);
    expect(invokeProbeSeen).toEqual([]);
  });

  it('no `projection` arg leaves the re-dispatched result byte-identical', async () => {
    const res = await invokeCall({ probe: 'v' });
    expect(res.isError).not.toBe(true);
    expect(invokeProbeSeen).toEqual([{ probe: 'v' }]);
    expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual({ lines: ['alpha', 'beta', 'gamma'] });
  });
});

/* ─── replay receipt durability ordering (EI-19301511582594101) ─────────── */

describe('replay receipt is persisted only AFTER the tool transaction commits', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('persists the receipt AFTER the commit, never before', async () => {
    const res = await callTool('gatingtest:scoped', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-ordering-1',
    });
    expect(res.isError).not.toBe(true);
    // The tool really did take the needsTx branch — otherwise this test proves nothing.
    expect(h.withWorkspaceCalls).toEqual(['ws-test']);
    expect(h.replayStores.map((s) => s.idempotencyKey)).toEqual(['idem-ordering-1']);
    // The whole fix in one assertion: commit first, receipt second. Reversing these
    // two lines is exactly the durable-false-success bug.
    expect(h.txEvents).toEqual(['commit', 'store']);
  });

  it('persists NO receipt when the tool transaction fails to COMMIT', async () => {
    h.commitFailure = new Error('COMMIT failed: connection closed unexpectedly');
    // Whether the handler rethrows or converts to an isError envelope is not the
    // point under test — that a receipt is never written for a rolled-back write is.
    await callTool('gatingtest:scoped', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-rolled-back-1',
    }).catch(() => undefined);
    expect(h.replayStores).toEqual([]);
    expect(h.txEvents).not.toContain('store');
  });

  it('writes no receipt at all when the caller supplied no idempotencyKey', async () => {
    const res = await callTool('gatingtest:scoped', {}, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(h.replayStores).toEqual([]);
    expect(h.txEvents).toEqual(['commit']);
  });
});

describe('validation refusals do not reserve MCP replay keys', () => {
  const replayExtra = extraFor(signedUrl({ client: 'validation-replay-caller' }));

  it('revalidates a corrected payload while preserving replay for handler isError results', async () => {
    h.replayLookupFromStores = true;
    const validationKey = 'idem-validation-refusal-1';
    const invalid = await callTool(
      'gatingtest:replay_validation',
      { rejected: true },
      replayExtra,
      { idempotencyKey: validationKey },
    );
    expect(invalid.isError).toBe(true);
    expect(textOf(invalid)).toContain('invalid_input');
    expect(replayValidationSeen).toEqual([]);
    expect(h.replayStores).toEqual([]);

    const corrected = await callTool(
      'gatingtest:replay_validation',
      { accepted: 'ok' },
      replayExtra,
      { idempotencyKey: validationKey },
    );
    expect(corrected.isError).toBeUndefined();
    expect(jsonOf(corrected)).toEqual({ ok: true, accepted: 'ok' });
    expect(replayValidationSeen).toHaveLength(1);
    expect(h.replayStores.map((row) => row.idempotencyKey)).toEqual([validationKey]);

    const businessKey = 'idem-business-error-1';
    const firstBusinessError = await callTool(
      'gatingtest:replay_business_error',
      { value: 'first' },
      replayExtra,
      { idempotencyKey: businessKey },
    );
    expect(firstBusinessError.isError).toBe(true);
    expect(textOf(firstBusinessError)).toBe('business failure');
    expect(replayBusinessErrorSeen).toHaveLength(1);
    expect(h.replayStores.map((row) => row.idempotencyKey)).toEqual([validationKey, businessKey]);

    const replayedBusinessError = await callTool(
      'gatingtest:replay_business_error',
      { value: 'corrected-but-not-rerun' },
      replayExtra,
      { idempotencyKey: businessKey },
    );
    expect(replayedBusinessError.isError).toBe(true);
    expect(textOf(replayedBusinessError)).toBe('business failure');
    expect(replayedBusinessError._meta?.replayed).toBe(true);
    expect(replayBusinessErrorSeen).toHaveLength(1);
  });
});

/* ─── replayed calls are visible to telemetry (WI-6792) ─────────────────── */

describe('a replayed call records a tool_invocation row', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);
  const REPLAYED = { content: [{ type: 'text', text: '{"ok":true,"created":"WI-42"}' }] };

  it('emits exactly one row, status "replayed", without running the tool', async () => {
    h.storedReplay = REPLAYED;
    const before = seen.length;
    const res = await callTool('gatingtest:scoped', { probe: 'v' }, scoped('ws-test'), {
      idempotencyKey: 'idem-replay-1',
    });

    // The stored outcome was served verbatim and the tool never ran — otherwise
    // this is testing the normal dispatch path, not the replay branch.
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toBe('{"ok":true,"created":"WI-42"}');
    expect(res._meta?.replayed).toBe(true);
    expect(seen.length).toBe(before);
    // No dispatch ⇒ no tx and no fresh receipt: the replay is a pure read.
    expect(h.withWorkspaceCalls).toEqual([]);
    expect(h.replayStores).toEqual([]);

    // The whole bug in one assertion: this array used to be EMPTY for a replay,
    // so a retry storm looked like a fleet-wide write gap.
    expect(h.invocations).toHaveLength(1);
    const row = h.invocations[0]!;
    expect(row.status).toBe('replayed');
    expect(row.toolName).toBe('gatingtest:scoped');
    expect(row.args).toEqual({ probe: 'v' });
    // The retry key rides metadata so a storm is groupable by the key re-sent.
    expect(row.metadataJson).toMatchObject({ replayIdempotencyKey: 'idem-replay-1' });
  });

  it('preserves structuredContent through the real handler replay branch', async () => {
    const structuredContent = {
      ok: true,
      item: null,
      reason: 'no_match',
    };
    h.storedReplay = { ...REPLAYED, structuredContent };
    const before = seen.length;

    const res = await callTool('gatingtest:scoped', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-replay-structured-content',
    });

    // EI-21562975493479202: outputSchema clients validate this field on the
    // replayed tools/call response. The serializer/store tests cover the DB
    // receipt; this assertion covers the handler branch that returns it.
    expect(res.structuredContent).toEqual(structuredContent);
    expect(res._meta?.replayed).toBe(true);
    expect(seen.length).toBe(before);
    expect(h.withWorkspaceCalls).toEqual([]);
    expect(h.replayStores).toEqual([]);
  });

  it('does not synthesize unrequested structure or parse result-door envelopes', async () => {
    const payload = { ok: true, item: null, reason: 'no_match' };
    h.storedReplay = { content: [{ type: 'text', text: JSON.stringify(payload) }], _meta: { format: 'json' } };
    const unrequested = await callTool('gatingtest:scoped', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-replay-structured-not-requested',
    });
    expect(unrequested.structuredContent).toBeUndefined();

    const envelope = {
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'incomplete',
      content: [{ kind: 'evidence-reference', uri: 'papercusp://scratch/example' }],
    };
    h.storedReplay = { content: [{ type: 'text', text: JSON.stringify(envelope) }], _meta: { format: 'json' } };
    const doorResult = await callTool('gatingtest:scoped', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-replay-result-door-envelope',
      structured: true,
    });
    expect(doorResult.structuredContent).toBeUndefined();
    expect(JSON.parse(textOf(doorResult))).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'incomplete',
    });
  });

  it('counts replayed output in the same explicit aggregate cohort', async () => {
    h.storedReplay = { content: [{ type: 'text', text: 'r'.repeat(4_500) }] };
    const meta = { idempotencyKey: 'idem-replay-budget', outputGroupId: 'turn-replay-budget' };
    const signed = extraFor(signedUrl({ role: 'scoper', spawn: 'spawn-replay-budget' }));

    const first = await callTool('gatingtest:scoped', {}, signed, meta);
    const second = await callTool('gatingtest:scoped', {}, signed, meta);
    const third = await callTool('gatingtest:scoped', {}, signed, meta);

    expect(textOf(first)).toBe('r'.repeat(4_500));
    expect(textOf(second)).toBe('r'.repeat(4_500));
    const envelope = JSON.parse(third.content[0]!.text!);
    expect(envelope).toMatchObject({
      schemaVersion: 'papercusp.output-envelope/v1',
      state: 'incomplete',
      incomplete: { reason: 'aggregate-output-budget-exceeded' },
    });
    expect(third._meta).toMatchObject({
      replayed: true,
      resultDoor: {
        aggregate: {
          mode: 'explicit',
          budgetBytes: 12_000,
          consumedBeforeBytes: 9_000,
          consumedAfterBytes: 12_000,
          exceeded: true,
        },
      },
    });
    expect(seen).toHaveLength(0);
    expect(h.replayStores).toEqual([]);
  });

  it('attributes the row exactly as a fresh call would — the point of building ctx first', async () => {
    // The SIGNED driver, deliberately: it pins run/spawn, so "same attribution"
    // is a real comparison. (A superuser call synthesizes a fresh run id per
    // request, which no placement of the lookup could make match.) Its OWN spawn
    // id, because the code:run batch-nudge counter is process-global and keyed by
    // session — two calls on the shared 'spawn-1' would push a later case over
    // the threshold and append a `[batch-hint]` to its result.
    const signed = extraFor(signedUrl({ role: 'scoper', spawn: 'spawn-replay-attrib' }));

    // Baseline: what the SAME call records when it really dispatches.
    const fresh = await callTool('gatingtest:scoped', {}, signed, {
      idempotencyKey: 'idem-attrib-fresh',
    });
    expect(fresh.isError).toBeUndefined();
    expect(h.invocations).toHaveLength(1);
    const freshRow = h.invocations[0]!;
    expect(freshRow.status).toBe('ok');

    h.invocations.length = 0;
    h.storedReplay = REPLAYED;
    await callTool('gatingtest:scoped', {}, signed, {
      idempotencyKey: 'idem-attrib-replay',
    });
    expect(h.invocations).toHaveLength(1);
    const replayRow = h.invocations[0]!;
    expect(replayRow.status).toBe('replayed');

    // Same window key ⇒ the replay groups with the real calls it accompanies,
    // which is what makes "how much of this window was replay?" one query.
    expect(replayRow.windowKey).toBe(freshRow.windowKey);
    expect(replayRow.ctx.role).toBe(freshRow.ctx.role);
    expect(replayRow.ctx.runId).toBe(freshRow.ctx.runId);
    expect(replayRow.ctx.spawnId).toBe(freshRow.ctx.spawnId);
    expect(replayRow.ctx.harnessSlug).toBe(freshRow.ctx.harnessSlug);
  });

  it('serves the replay even when recording its telemetry throws', async () => {
    // A telemetry failure must cost a row, never a re-executed write: if the
    // throw escaped to the lookup's catch, the handler would fall through and
    // run the tool again — double-applying the mutation replay exists to guard.
    h.storedReplay = REPLAYED;
    const boom = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = (await import('../../projected-tool-deps')).PROJECTED_DEPS as {
      recordInvocation?: (i: unknown) => Promise<void>;
    };
    const real = deps.recordInvocation;
    deps.recordInvocation = async () => {
      throw new Error('telemetry queue exploded');
    };
    try {
      const before = seen.length;
      const res = await callTool('gatingtest:scoped', {}, scoped('ws-test'), {
        idempotencyKey: 'idem-replay-telemetry-throws',
      });
      expect(textOf(res)).toBe('{"ok":true,"created":"WI-42"}');
      expect(seen.length).toBe(before); // the tool did NOT re-run
      expect(h.withWorkspaceCalls).toEqual([]);
      // The detached rejection handler runs after the replay response's
      // microtask; let it settle while the expected-warning spy is installed.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(boom).toHaveBeenCalledWith(expect.stringContaining('telemetry queue exploded'));
    } finally {
      deps.recordInvocation = real;
      boom.mockRestore();
    }
  });

  it('serves the replay without waiting for a never-settling telemetry write', async () => {
    // Invocation-ledger writes can wait on a contended row/advisory lock. The
    // stored mutation result must still return promptly; telemetry is detached
    // because it is observability, not replay durability.
    h.storedReplay = REPLAYED;
    const deps = (await import('../../projected-tool-deps')).PROJECTED_DEPS as {
      recordInvocation?: (i: unknown) => Promise<void>;
    };
    const real = deps.recordInvocation;
    deps.recordInvocation = async () => new Promise<void>(() => {});
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        callTool('gatingtest:scoped', {}, scoped('ws-test'), {
          idempotencyKey: 'idem-replay-telemetry-never-settles',
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('replay waited on telemetry')), 250);
        }),
      ]);
      expect(textOf(res)).toBe('{"ok":true,"created":"WI-42"}');
      expect(seen.length).toBe(0); // the tool did NOT re-run
      expect(h.withWorkspaceCalls).toEqual([]);
    } finally {
      if (timeout) clearTimeout(timeout);
      deps.recordInvocation = real;
    }
  });

  it('records nothing extra for a call with no stored result', async () => {
    const res = await callTool('gatingtest:scoped', {}, scoped('ws-test'), {
      idempotencyKey: 'idem-no-stored-result',
    });
    expect(res.isError).not.toBe(true);
    expect(h.invocations.map((r) => r.status)).toEqual(['ok']);
  });
});

/* ─── caller backend/model stamping (fleet-launch-agent-inheritance-2026-07-03) ─── */

describe('caller backend/model stamping', () => {
  it('folds ?agent= and ?model= from a superuser MCP URL onto ctx.callerAgent/callerModel', async () => {
    await callTool(
      'gatingtest:crossworkspace',
      {},
      superuserExtra('&workspace=ws-test&agent=omp&model=ollama-cc/maxwell1500/ornith-35b:IQ3_M'),
    );
    const call = seen.at(-1)!;
    expect(call.ctx.callerAgent).toBe('omp');
    expect(call.ctx.callerModel).toBe('ollama-cc/maxwell1500/ornith-35b:IQ3_M');
  });

  it('prefers the x-papercusp-agent/-model headers over URL params (the omp carrier)', async () => {
    await callTool(
      'gatingtest:crossworkspace',
      {},
      superuserExtra('&workspace=ws-test&agent=claude&model=opus', {
        'x-papercusp-agent': 'omp',
        'x-papercusp-model': 'ollama-cc/ornith',
      }),
    );
    const call = seen.at(-1)!;
    expect(call.ctx.callerAgent).toBe('omp');
    expect(call.ctx.callerModel).toBe('ollama-cc/ornith');
  });

  it('leaves callerAgent/callerModel null when the launcher did not stamp them', async () => {
    await callTool('gatingtest:crossworkspace', {}, superuserExtra('&workspace=ws-test'));
    const call = seen.at(-1)!;
    expect(call.ctx.callerAgent ?? null).toBeNull();
    expect(call.ctx.callerModel ?? null).toBeNull();
  });
});

/* ─── harness resolution (WI-4393) ──────────────────────────────────────── */

describe('harness resolution — x-papercusp-harness header vs ?harness= param', () => {
  it('prefers the x-papercusp-harness header over ?harness= (the OMP carrier — OMP cannot env-interpolate ?harness= into its static MCP url)', async () => {
    await callTool(
      'gatingtest:crossworkspace',
      {},
      superuserExtra('&workspace=ws-test&harness=stale-url-value', {
        'x-papercusp-harness': 'papercup',
      }),
    );
    const call = seen.at(-1)!;
    expect(call.ctx.harnessSlug).toBe('papercup');
  });

  it('falls back to ?harness= when no header is present (claude/codex env-interpolated url carrier)', async () => {
    await callTool('gatingtest:crossworkspace', {}, superuserExtra('&workspace=ws-test&harness=papercup'));
    const call = seen.at(-1)!;
    expect(call.ctx.harnessSlug).toBe('papercup');
  });

  it('falls back to \'*\' when neither header nor param is present', async () => {
    await callTool('gatingtest:crossworkspace', {}, superuserExtra('&workspace=ws-test'));
    const call = seen.at(-1)!;
    expect(call.ctx.harnessSlug).toBe('*');
  });
});

describe('request-origin telemetry context', () => {
  it('folds sanitized MCP request provenance onto ctx without auth or signature fields', async () => {
    await callTool(
      'gatingtest:crossworkspace',
      {},
      superuserExtra('&workspace=ws-test&client=su-test&agent=codex&model=gpt-5&sig=secret-sig&exp=999', {
        authorization: 'Bearer test-su-bearer',
        'x-papercusp-client': 'su-header',
        'x-papercusp-mcp-trace-id': 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e',
        'user-agent': 'codex-cli-test',
        referer: 'http://127.0.0.1:3055/admin',
      }),
    );

    const origin = seen.at(-1)!.ctx.requestOrigin!;
    expect(origin).toMatchObject({
      transport: 'mcp',
      path: '/api/mcp',
      mcpRequestTraceId: 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e',
      query: {
        superuser: '1',
        workspace: 'ws-test',
        client: 'su-test',
        agent: 'codex',
        model: 'gpt-5',
      },
      headers: {
        host: '127.0.0.1:3070',
        'x-papercusp-client': 'su-header',
        'user-agent': 'codex-cli-test',
        referer: 'http://127.0.0.1:3055/admin',
      },
    });
    expect(origin.query).not.toHaveProperty('sig');
    expect(origin.query).not.toHaveProperty('exp');
    expect(origin.headers).not.toHaveProperty('authorization');
  });
});

/* ─── scoped-superuser-workspace-clamp (P-006 / P-007) ───────────────── */

describe('scoped-superuser-workspace-clamp', () => {
  // A scoped superuser session = ?superuser=1 + a concrete ?workspace=.
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  it('flag OFF: a scoped superuser may call a crossWorkspace tool (today’s behavior)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:crossworkspace-ok');
  });

  it('flag ON: a scoped superuser is DENIED a crossWorkspace tool (workspace_forbidden)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('workspace_forbidden');
  });

  it('flag ON: an UNSCOPED (?workspace=*) superuser may still call a crossWorkspace tool', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('*'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:crossworkspace-ok');
  });

  it('flag ON: a scoped superuser MAY call autonomy:decide — a scoped-safe self-confining crossWorkspace tool (EI-1810)', async () => {
    // The Overwatch role runs workspace-scoped and its prompt MANDATES autonomy:decide,
    // but the clamp made it deterministically unusable. The scoped-safe allowlist exempts
    // it: it's crossWorkspace only for the unscoped path, yet self-scopes to the caller's
    // own workspace + is read-only, so a scoped session calling it never reads another ws.
    h.scopedClampFlag.value = true;
    const res = await callTool('autonomy:decide', { action: 'improvements:capture' }, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
    // …and it reached the handler, which self-scoped to the caller's OWN workspace.
    expect(textOf(res)).toContain('"workspaceId": "ws-test"');
  });

  it('flag ON: a scoped superuser MAY call autonomy:record_disposition — the WRITE sibling, same scoped-safe self-confining profile (EI-1934)', async () => {
    // record_disposition self-scopes to the caller's OWN workspace (ws from
    // principal / activeWorkspaceId) and records the disposition row only there —
    // the same class as autonomy:decide. Without the exemption the Queen's
    // decision-ledger audit was workspace_forbidden from its normal scoped seat.
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'autonomy:record_disposition',
      { action: 'improvements:capture', disposition: 'no-op', why: 'gate test' },
      scoped('ws-test'),
    );
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp (reached its handler)
  });

  it('flag ON: a scoped superuser MAY call memory:search — a scoped-safe user/harness-scoped tool (EI-2378)', async () => {
    // After EI-2378, memory:search's crossWorkspace:true survives projection (so an
    // unscoped psu gets the admin handle). For a SCOPED session it must NOT be clamped:
    // the memory store is partitioned by user-id/harness-slug, not workspace, so a scoped
    // session reads only its OWN user's memory — no cross-workspace tenant-data access.
    // The SCOPED_SAFE_CROSSWORKSPACE allowlist exempts it (it reaches its handler rather
    // than being denied; the handler erroring on the stubbed PG is irrelevant to the gate).
    h.scopedClampFlag.value = true;
    const res = await callTool('memory:search', { query: 'pricing' }, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
  });

  it('flag ON: a scoped superuser MAY call memory:get — a scoped-safe user/harness-scoped read', async () => {
    // memory:get has no caller-selected workspace argument; it resolves only the
    // caller's user/harness memory pools. It shares memory:*'s crossWorkspace
    // declaration for the unscoped psu path, so the scoped clamp must let it reach
    // its handler just like search/list/update/forget.
    h.scopedClampFlag.value = true;
    const res = await callTool('memory:get', { id: 'known-memory-id' }, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
  });

  it('flag ON: a scoped superuser MAY call search:fulltext + sessions:search — scoped-safe read-only recall (session-search-scope-2026-07-05)', async () => {
    // The prose-search family is crossWorkspace only so an unscoped psu gets the
    // admin handle for the host-global operator_turns table (P-062 Phase 4); from a
    // scoped session the engine confines every source by the handed ctx workspaceId,
    // and session_turns' 'default' rows are host-local transcripts, not tenant data.
    // The clamp denying these made prose recall AND the flagship compaction-recovery
    // flow (sessions:search { session:'self' }) unusable for every workspace-scoped
    // psu session — the EI-1810 failure shape. The allowlist exempts them (reaching
    // the handler is the assertion; a handler error on stubbed PG is irrelevant).
    h.scopedClampFlag.value = true;
    for (const name of ['search:fulltext', 'search:semantic', 'sessions:search', 'sessions:read', 'sessions:list', 'sessions:timeline', 'sessions:digest']) {
      const res = await callTool(name, { query: 'pricing' }, scoped('ws-test'));
      expect(textOf(res), name).not.toContain('workspace_forbidden'); // NOT denied by the clamp
    }
  });

  it('flag ON: a scoped superuser MAY call flags:set — a GLOBAL-config meta-control exempt from the clamp (no tenant data; fixes the circular lockout)', async () => {
    // flags:set is crossWorkspace:true (it writes the global flag store + audit log), but it
    // touches NO per-workspace tenant data — and denying it would lock the operator out of the
    // very control that GOVERNS this clamp (a scoped superuser couldn't disable it). The
    // SUPERUSER_GLOBAL_FLAG_ADMIN exemption lets a scoped superuser reach the flag system.
    h.scopedClampFlag.value = true;
    const res = await callTool('flags:set', {}, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
  });

  it('flag ON: a scoped superuser MAY call pot_git:secrets_exemptions — the no-restart recovery lever for a guard that freezes git egress (WI-6641)', async () => {
    // A secrets-guard false positive freezes ALL git egress for the hive until it is
    // cleared, and the guard's own refusal message tells the reader to run this tool.
    // Every agent that trips the guard is workspace-scoped, so the clamp made the
    // documented remedy unreachable by exactly the population that needs it (the
    // EI-1810 shape; it cost ~8h of frozen publish on 2026-07-28 and a manual psql
    // INSERT). The table is keyed (workspace_id, path) and the handler pins ws to the
    // caller's principal, so a scoped call crosses no boundary.
    h.scopedClampFlag.value = true;
    const res = await callTool('pot_git:secrets_exemptions', { action: 'list' }, scoped('ws-test'));
    expect(textOf(res)).not.toContain('workspace_forbidden'); // NOT denied by the clamp
  });

  it('flag ON: a scoped caller’s foreign `workspaceId` ARG is clamped to its own workspace (WI-6641 — the clamp covers BOTH spellings)', async () => {
    // The allowlist entry above is only sound while a scoped caller cannot point the
    // tool at another workspace. The clamp overwrites the workspace-target arg — but
    // it used to hardcode the spelling `workspace`, so `workspaceId` (this tool,
    // plus both substrate:revoke_* WRITES) went through untouched. If this regresses,
    // pot_git:secrets_exemptions must come OFF SCOPED_SAFE_CROSSWORKSPACE.
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'pot_git:secrets_exemptions',
      { action: 'list', workspaceId: 'ws-someone-else' },
      scoped('ws-test'),
    );
    expect(textOf(res)).not.toContain('ws-someone-else'); // never reached the foreign workspace
  });

  it('flag ON: the workspace-target arg clamp is keyed on the ARG NAME, not a tool list (WI-6641)', async () => {
    // Regression guard for the generalisation itself: a scoped caller's `workspaceId`
    // must be rewritten for ANY tool that accepts it, so a future tool adding the arg
    // inherits the defense instead of quietly reopening the hole.
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { workspaceId: 'other-ws' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.args).toMatchObject({ workspaceId: 'ws-test' });
  });

  it('flag ON: a NON-exempt crossWorkspace tool is STILL denied (clamp intact for tenant-data tools)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:crossworkspace', {}, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('workspace_forbidden'); // the clamp's data-isolation is unchanged
  });

  it('flag ON: a scoped superuser is DENIED blueprint:publish because its arbitrary repoDir/global write cannot self-confine', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'blueprint:publish',
      {
        blueprintId: 'test-blueprint',
        title: 'Test blueprint',
        description: 'Transport clamp contract',
        repoDir: '/tmp/test-blueprint-repo',
        workspace: 'ws-test',
      },
      scoped('ws-test'),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('workspace_forbidden');
  });

  it('flag ON: a scoped superuser’s foreign `workspace` ARG is overwritten with its own workspace', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { workspace: 'other-ws' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.args).toMatchObject({ workspace: 'ws-test' });
  });

  it('flag ON: a superuser with an UNRESOLVED workspace is scoped to the ACTIVE workspace (never rejected, never god-mode)', async () => {
    // mcp-outage-triage-2026-07-02: the old hard-reject left untracked/resumed
    // sessions permanently toolless (the client stops retrying tools/list). The
    // clamp now falls back to activeWorkspaceId() — one concrete workspace, so
    // the no-silent-'*' guarantee is intact while the session stays usable.
    h.scopedClampFlag.value = true;
    process.env.PAPERCUSP_WORKSPACE_ID = 'ws-active-pin'; // activeWorkspaceId() precedence #2
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); // the fallback warns by design
    try {
      const res = await callTool('gatingtest:scoped', {}, superuserExtra()); // no ?workspace=, no header
      expect(res.isError).not.toBe(true);
      expect(seen.at(-1)?.ctx.workspaceId).toBe('ws-active-pin');
      expect(h.withWorkspaceCalls).toEqual(['ws-active-pin']);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('scoping to the active workspace'));
    } finally {
      delete process.env.PAPERCUSP_WORKSPACE_ID;
      warnSpy.mockRestore();
    }
  });

  it('flag OFF: an unresolved-workspace superuser still gets unscoped god-mode (unchanged)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:crossworkspace', {}, superuserExtra());
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:crossworkspace-ok');
  });

  it('flag ON: rejects the harness:\'all\' global escape for a (workspace-)scoped session', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'all' }, superuserExtra('&workspace=ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  // F-A1 (leaks D-4 / clamp D-002): for a WORKSPACE-scoped session, harness:'all'/'*'
  // on plans:list RE-RESOLVES to a workspace-wide read of the session's OWN workspace
  // (drop the wildcard + workspaceWide), instead of the harness_forbidden reject — the
  // global escape (→ PAPERCUSP_WORKSPACE_ID/papercup) is never reached because the
  // dispatch tx is pinned to ctx.workspaceId. Narrowly scoped: plans:list ONLY, the
  // workspace tier ONLY; everything else still rejects (proven by the cases below).
  it('flag ON / F-A1: a workspace-scoped session\'s harness:\'all\' on plans:list is RE-RESOLVED (not harness_forbidden)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('plans:list', { harness: 'all' }, scoped('ws-test'));
    // The clamp re-resolved to a workspace-wide read instead of rejecting; plans:list
    // may then return empty/err against the mocked PG, but it is NOT the clamp reject,
    // and it never took the harness:'all' → global-papercup path.
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON / F-A1: harness:\'*\' on plans:list is likewise re-resolved for a workspace-scoped session', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('plans:list', { harness: '*' }, scoped('ws-test'));
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON / F-A1: harness:\'all\' on loop:arm is re-resolved to the workspace home pot', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'loop:arm',
      { harness: 'all', intervalSec: 60, goal: 'transport gating probe' },
      scoped('ws-test'),
    );
    // The handler may be disabled or have no formal home in this mocked workspace;
    // the transport contract under test is that it receives the call instead of
    // rejecting the documented workspace-global scope at the clamp.
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON / F-A1: the re-resolution is plans:list-ONLY — harness:\'all\' on ANOTHER plans verb (plans:get) still rejects', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('plans:get', { harness: 'all', slug: 'x' }, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON / F-A1: a HIVE-pinned session\'s harness:\'all\' on plans:list is NOT re-resolved — still rejected (no sibling-hive plans)', async () => {
    h.scopedClampFlag.value = true;
    // hive-pinned = ?harness=hiveA-home (a concrete harness, ctx.harnessSlug != '*').
    const res = await callTool('plans:list', { harness: 'all' }, superuserExtra('&workspace=ws-test&harness=hiveA-home'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON / F-A1: an UNSCOPED (?workspace=*) superuser\'s harness:\'all\' on plans:list is unchanged (no clamp; global papercup is legitimate)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('plans:list', { harness: 'all' }, scoped('*'));
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  // P-017: a per-call `harness` arg that resolves to a DIFFERENT workspace must be
  // rejected even for a workspace-only (non-hive) scoped session. The plan/work-item
  // readers resolve a harness→workspace from the REGISTRY (not the clamped ctx.workspaceId),
  // so without this dispatch clamp a scoped session could read a foreign workspace's plans
  // by naming its harness — the gap the active-ws-first fallback alone left open.
  it('flag ON: rejects a per-call `harness` that belongs to ANOTHER workspace (workspace-only scope)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'foreign-ws-harness' }, scoped('ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(textOf(res)).toContain('other-ws');
    expect(h.resolveWorkspaceForHarnessSlugIn).toHaveBeenCalledWith(
      'ws-test', 'foreign-ws-harness', expect.objectContaining({ track: expect.any(Function) }),
    );
  });

  it('flag ON: ALLOWS a per-call `harness` that belongs to the session\'s OWN workspace', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'own-ws-harness' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag ON: ALLOWS an UNREGISTERED harness (fail-open; the tool resolves/fails loud, not the clamp)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'unregistered-harness' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag OFF: a foreign-workspace `harness` arg is NOT clamped (today\'s behavior)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:scoped', { harness: 'foreign-ws-harness' }, scoped('ws-test'));
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag ON: an UNSCOPED (?workspace=*) superuser is NOT P-017-clamped on a foreign harness', async () => {
    // The clamp is gated on workspaceId !== '*', so an unscoped session is never
    // harness_forbidden here (it may still fail downstream for needing a concrete
    // workspace tx — that's a separate gate, not this clamp).
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'foreign-ws-harness' }, scoped('*'));
    expect(textOf(res)).not.toContain('harness_forbidden');
    expect(h.resolveWorkspaceForHarnessSlugIn).not.toHaveBeenCalled();
  });
});

/* ─── scoped-superuser HIVE clamp (P-014a — auto-confine on harness) ──── */

describe('scoped-superuser hive clamp', () => {
  // Flag ON, scoped to ws-test, launched ON a hive harness ⇒ hive-confined.
  const hiveScoped = () => superuserExtra('&workspace=ws-test&harness=hiveA-home');

  it('flag ON: denies a cross_harness:* tool (it reads other harnesses)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('cross_harness:probe', {}, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: rejects a per-call `harness` in a DIFFERENT hive', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'hiveB-home' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: treats dev:build_status harness as ambient through direct handler dispatch', async () => {
    h.scopedClampFlag.value = true;
    h.devBuildStatus.mockResolvedValueOnce({
      prodBuild: { exists: true, mtimeMs: 1000 },
      devBuild: { exists: true, mtimeMs: 1000 },
      prodLogTail: null,
      dev3055Reachable: true,
      prod3070Reachable: true,
    });
    h.devTestFlakeRollup.mockResolvedValueOnce({ entries: [] });
    h.devFlagFlakeSuspects.mockReturnValueOnce([]);

    const res = await callTool('dev:build_status', { harness: 'foreign-ws-harness' }, hiveScoped());

    expect(res.isError).not.toBe(true);
    expect(textOf(res)).not.toContain('harness_forbidden');
    expect(h.devBuildStatus).toHaveBeenCalledOnce();
    expect(h.withWorkspaceCalls).not.toContain('other-ws');
  });

  const GOAL_LOCAL_LAUNCH_TOOLS = [
    'fleet:launch-on-plan',
    'fleet:create',
    'capability:launch-agent',
  ] as const;

  it('flag ON: keeps sibling-hive launch tools denied without goal-holder proof', async () => {
    h.scopedClampFlag.value = true;
    for (const name of GOAL_LOCAL_LAUNCH_TOOLS) {
      const res = await callTool(name, { harness: 'hiveB-home' }, hiveScoped());
      expect(res.isError, name).toBe(true);
      expect(textOf(res), name).toContain('harness_forbidden');
    }
    expect(h.goalLocalPlacement.calls).toHaveLength(GOAL_LOCAL_LAUNCH_TOOLS.length);
  });

  it('flag ON: lets the elected goal holder reach sibling-hive launch validation for a local pot', async () => {
    h.scopedClampFlag.value = true;
    h.goalLocalPlacement.allow = true;
    const extra = superuserExtra('&workspace=ws-test&harness=hiveA-home&client=goal-holder');

    // Deliberately omit each launch door's required launch fields. Passing the
    // transport clamp is the assertion; target validation must stop the call
    // before a fleet/window/agent can be created in this matrix.
    for (const name of GOAL_LOCAL_LAUNCH_TOOLS) {
      const res = await callTool(name, { harness: 'hiveB-home' }, extra);
      expect(textOf(res), name).not.toContain('harness_forbidden');
    }

    expect(h.goalLocalPlacement.calls).toEqual(
      GOAL_LOCAL_LAUNCH_TOOLS.map(() => ({
        workspaceId: 'ws-test',
        callerOwnerId: 'goal-holder',
        scopeHive: 'hiveA-home',
        targetHarness: 'hiveB-home',
      })),
    );
  });

  it('flag ON: allows git-sync:run to name the canonical platform Pot explicitly (EI-22344259264889593)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'git-sync:run',
      { installSlug: PLATFORM_POT_SLUG, dryRun: true },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON: allows git-sync:run\'s documented `harness` alias for the exact platform Pot', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'git-sync:run',
      { harness: PLATFORM_POT_SLUG, dryRun: true },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON: allows routines:list to inspect only the canonical platform Pot git-sync routine', async () => {
    h.scopedClampFlag.value = true;
    for (const target of [
      { installSlug: PLATFORM_POT_SLUG, name: 'git-sync' },
      { harness: PLATFORM_POT_SLUG, name: 'git-sync' },
    ]) {
      const res = await callTool('routines:list', target, hiveScoped());
      expect(textOf(res), JSON.stringify(target)).not.toContain('harness_forbidden');
    }
  });

  it('flag ON: allows routines:set to address an exact reserved harness-less Scout routine', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'routines:set',
      {
        name: 'bp-singleton-scout-0',
        installSlug: '@singleton',
        active: false,
        reason: 'transport regression probe',
        dryRun: true,
      },
      hiveScoped(),
    );
    // The mocked routine store may reject the dry-run lookup; the transport
    // assertion is that the reserved host reaches the handler rather than
    // being rejected as a foreign hive.
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON: allows routines:list to inspect an exact reserved harness-less Scout routine', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'routines:list',
      { installSlug: '@singleton', name: 'bp-singleton-scout-0' },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it.each([
    ['installSlug', { installSlug: '@singleton' }],
    ['the harness alias', { harness: '@singleton' }],
  ])('flag ON: allows routines:fire for one exact reserved harness-less routine via %s', async (_case, target) => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'routines:fire',
      { ...target, name: 'bp-singleton-memory-precision-0' },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it.each([
    ['a broad reserved-host read', { installSlug: '@singleton' }],
    ['a reserved-host rollup', { installSlug: '@singleton', name: 'bp-singleton-scout-0', rollup: true }],
  ])('flag ON: still rejects non-exact reserved-host routines:list targets (%s)', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('routines:list', args, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it.each([
    ['an id-only fire', { id: 'routine-id', installSlug: '@singleton' }],
    ['a wildcard fire', { name: '*', installSlug: '@singleton' }],
    ['a catch-all fire', { name: 'ALL', installSlug: '@singleton' }],
    ['a sibling-hive routine', { name: 'bp-singleton-memory-precision-0', installSlug: 'hiveB-home' }],
  ])('flag ON: still rejects routines:fire without a safe exact target (%s)', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('routines:fire', args, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it.each([
    [
      'an omitted ownerId',
      { read: true, harness: 'hiveB-home' },
      hiveScoped(),
    ],
    [
      'the caller ownerId',
      { read: true, harness: 'hiveB-home', ownerId: 'loop-owner' },
      superuserExtra('&workspace=ws-test&harness=hiveA-home&client=loop-owner'),
    ],
  ])(
    'flag ON: allows a self-owned loop:checkpoint READ to recover a concrete sibling-hive note (%s)',
    async (_case, args, extra) => {
      h.scopedClampFlag.value = true;
      const res = await callTool('loop:checkpoint', args, extra);
      // The real handler may report an empty/no-harness note in this PG-free
      // matrix; transport gating is the assertion, so only the hive refusal is
      // disallowed here.
      expect(textOf(res)).not.toContain('harness_forbidden');
    },
  );

  it.each([
    ['the global `all` harness', { read: true, harness: 'all' }],
    ['the wildcard `*` harness', { read: true, harness: '*' }],
    ['another owner\'s note', { read: true, harness: 'hiveB-home', ownerId: 'other-owner' }],
    ['a cross-hive WRITE', { did: 'must remain routine-scoped', harness: 'hiveB-home' }],
  ])('flag ON: still rejects loop:checkpoint %s', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('loop:checkpoint', args, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: allows an issue-family work_items:checkpoint WRITE for a concrete sibling-hive harness', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'work_items:checkpoint',
      {
        id: 'EI-self-owned-checkpoint',
        checkpoint: 'transport reaches the handler ownership guard',
        harness: 'hiveB-home',
      },
      hiveScoped(),
    );

    // The PG-free fixture may return the handler's normal unresolved-item result;
    // the transport assertion is that this EI write is not stopped by the hive
    // clamp before the handler can apply its authoritative not_holder check.
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it.each([
    ['a feature-family WI- checkpoint', { id: 'WI-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: 'hiveB-home' }],
    ['a feature-family F- checkpoint', { id: 'F-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: 'hiveB-home' }],
    ['the global `all` harness', { id: 'EI-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: 'all' }],
    ['the wildcard `*` harness', { id: 'EI-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: '*' }],
  ])('flag ON: still rejects work_items:checkpoint %s', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('work_items:checkpoint', args, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it.each([
    ['a broad canonical routine read', { installSlug: PLATFORM_POT_SLUG }],
    ['another canonical routine', { installSlug: PLATFORM_POT_SLUG, name: 'green-checkpoint' }],
    ['a rollup that ignores its exact filters', { installSlug: PLATFORM_POT_SLUG, name: 'git-sync', rollup: true }],
    ['a sibling install git-sync routine', { installSlug: 'hiveB-home', name: 'git-sync' }],
  ])('flag ON: still rejects routines:list targeting %s', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('routines:list', args, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: still rejects git-sync:run targeting any other foreign install', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('git-sync:run', { installSlug: 'hiveB-home', dryRun: true }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: rebinds a resumed exact-slug plans:get only after the owner proof passes', async () => {
    h.scopedClampFlag.value = true;
    h.verifyExplicitPlanHarness.mockResolvedValue(true);
    const args = { harness: 'hiveB-home', slug: 'recovered-plan' };

    const res = await callTool('plans:get', args, hiveScoped());

    expect(h.verifyExplicitPlanHarness).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', harnessSlug: 'hiveA-home' }),
      'hiveB-home',
      args,
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
    // The proof changes the dispatch context, not the signed ambient context.
    expect(h.invocations[0]?.ctx.harnessSlug).toBe('hiveB-home');
  });

  it('flag ON: keeps sibling-hive plans:get denied when the exact-slug owner proof fails', async () => {
    h.scopedClampFlag.value = true;
    h.verifyExplicitPlanHarness.mockResolvedValue(false);
    const res = await callTool(
      'plans:get',
      { harness: 'hiveB-home', slug: 'unverified-plan' },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(h.verifyExplicitPlanHarness).toHaveBeenCalledTimes(1);
  });

  it('flag ON: rebinds an exact-slug plans:add-decision after the owner proof passes', async () => {
    h.scopedClampFlag.value = true;
    h.verifyExplicitPlanHarness.mockResolvedValue(true);
    const args = {
      harness: 'hiveB-home',
      slug: 'recovered-plan',
      title: 'Cross-lane ruling',
      body: 'Record the verified ruling on its owning plan.',
    };

    const res = await callTool('plans:add-decision', args, hiveScoped());

    expect(h.verifyExplicitPlanHarness).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', harnessSlug: 'hiveA-home' }),
      'hiveB-home',
      args,
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
    expect(h.invocations[0]?.ctx.harnessSlug).toBe('hiveB-home');
  });

  it('flag ON: keeps sibling-hive plans:add-decision denied when the exact-slug owner proof fails', async () => {
    h.scopedClampFlag.value = true;
    h.verifyExplicitPlanHarness.mockResolvedValue(false);
    const res = await callTool(
      'plans:add-decision',
      {
        harness: 'hiveB-home',
        slug: 'unverified-plan',
        title: 'Unverified ruling',
        body: 'Must not cross the hive boundary without ownership proof.',
      },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(h.verifyExplicitPlanHarness).toHaveBeenCalledTimes(1);
  });

  it('flag ON: rebinds coord:declare-intent for a verified exact cross-hive plan lane', async () => {
    h.scopedClampFlag.value = true;
    h.verifyExplicitPlanHarness.mockResolvedValue(true);
    const args = {
      harness: 'hiveB-home',
      current_plan_slug: 'recovered-plan',
      items: ['P-006'],
      intent: 'continue the bound plan lane',
    };

    const res = await callTool('coord:declare-intent', args, hiveScoped());

    expect(h.verifyExplicitPlanHarness).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-test', harnessSlug: 'hiveA-home' }),
      'hiveB-home',
      args,
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
    expect(h.invocations[0]?.ctx.harnessSlug).toBe('hiveB-home');
  });

  it('flag ON: keeps coord:declare-intent cross-hive plan lanes denied when owner proof fails', async () => {
    h.scopedClampFlag.value = true;
    h.verifyExplicitPlanHarness.mockResolvedValue(false);
    const res = await callTool(
      'coord:declare-intent',
      {
        harness: 'hiveB-home',
        current_plan_slug: 'unverified-plan',
        items: ['P-006'],
        intent: 'must not claim an unverified cross-hive plan lane',
      },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(h.verifyExplicitPlanHarness).toHaveBeenCalledTimes(1);
  });

  it('flag ON: does not extend the exact-slug rebind to plans:items', async () => {
    h.scopedClampFlag.value = true;
    h.verifyExplicitPlanHarness.mockResolvedValue(true);
    const res = await callTool(
      'plans:items',
      { harness: 'hiveB-home', slug: 'recovered-plan' },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(h.verifyExplicitPlanHarness).not.toHaveBeenCalled();
  });

  it('flag ON: explains the supported federated route for a cross-hive work_items:claim', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'work_items:claim',
      {
        id: 'EI-cross-hive-probe',
        harness: 'hiveB-home',
        force: true,
        ownerOverride: true,
        reason: 'gating matrix probe',
      },
      hiveScoped(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(textOf(res)).toContain('discovery:pots');
    expect(textOf(res)).toContain('pot:request_work');
    expect(textOf(res)).toContain('outbound work-request grant');
    expect(textOf(res)).toContain('direct work_items:claim is per-Hive');
  });

  it('flag ON: gives work_items:get the caller-harness retry after a canonical cross-hive slug is rejected — and, for an EI- (issue-family) id, says the retry WILL find the row (EI-21920346945864571)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'work_items:get',
      { id: 'EI-cross-hive-read', harness: 'hiveB-home' },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(textOf(res)).toContain('retry with the caller\'s harness "hiveA-home"');
    expect(textOf(res)).toContain('do not copy a returned row\'s canonical harness');
    // EI-21920346945864571: an agent reported this hint as untrustworthy for an
    // EI-prefixed id and skipped the retry — `getWorkItem`'s issue-family branch
    // ignores `harness` entirely, so the retry this hint suggests actually
    // resolves the row. Say so explicitly.
    expect(textOf(res)).toContain('EI-prefixed id resolves WORKSPACE-wide');
    expect(textOf(res)).toContain('this retry WILL find the row');
  });

  it('flag ON: gives work_items:get a DIFFERENT caveat for a WI-/F- (feature-family) id — the retry will NOT find a row owned by another harness (EI-21920346945864571)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'work_items:get',
      { id: 'WI-cross-hive-read', harness: 'hiveB-home' },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(textOf(res)).toContain('retry with the caller\'s harness "hiveA-home"');
    expect(textOf(res)).toContain('do not copy a returned row\'s canonical harness');
    expect(textOf(res)).toContain('WI-/F- (feature-family) id genuinely IS scoped to its owning harness');
    expect(textOf(res)).toContain('this retry will NOT resolve a row that belongs to a different one');
    // The EI- specific reassurance must NOT leak into the feature-family message.
    expect(textOf(res)).not.toContain('this retry WILL find the row');
  });

  it('flag ON: work_items:get with `ids` (batch) also gets the issue-family reassurance when every id is EI-prefixed (EI-21920346945864571)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'work_items:get',
      { ids: ['EI-cross-hive-read-1', 'EI-cross-hive-read-2'], harness: 'hiveB-home' },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('this retry WILL find the row');
  });

  it('flag ON: work_items:get with a MIXED batch (EI- and WI-/F-) falls back to the feature-family caveat (EI-21920346945864571)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'work_items:get',
      { ids: ['EI-cross-hive-read-1', 'WI-cross-hive-read-2'], harness: 'hiveB-home' },
      hiveScoped(),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('this retry will NOT resolve a row that belongs to a different one');
    expect(textOf(res)).not.toContain('this retry WILL find the row');
  });

  it('flag ON: rejects a harness:\'all\' escape', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'all' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: ALLOWS a harness within the same hive subtree (a member)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness: 'hiveA-member' }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.tool).toBe('gatingtest:scoped');
  });

  it('flag ON: allows docs:get engineering sentinel through the hive clamp', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'docs:get',
      { harness: 'engineering', slugs: ['__gating_matrix_missing__'] },
      hiveScoped(),
    );
    // The handler may return a normal per-slug not-found envelope, but the
    // transport must not reject the static engineering docs surface as a
    // foreign hive before docs:get can handle it.
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON: allows docs:author engineering sentinel through the hive clamp', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'docs:author',
      {
        harness: 'engineering',
        // Invalid slug stops in the pure handler validation before any file or
        // canonical-row write, while still proving the transport clamp lets the
        // engineering authoring surface through.
        slug: 'invalid/slug',
        title: 'gating matrix probe',
        description: 'gating matrix probe',
        body: 'gating matrix probe',
      },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  // P-016/P-014b: confine the workspace-GLOBAL read surfaces per-hive. A `hive`
  // arg naming a DIFFERENT hive is a cross-hive read on ANY tool → rejected;
  // coord:presence's workspace roster selector widens past the hive → rejected.
  // A targeted `{ owner }` lookup is allowed to spell scope:'workspace'
  // explicitly because that lookup already defaults workspace-wide in the tool;
  // scope:'all' still crosses the workspace boundary and remains forbidden.
  it('flag ON: rejects a `hive` arg naming a DIFFERENT hive (any tool)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { hive: 'hiveB-home' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('hive_forbidden');
  });

  it('flag ON: ALLOWS a `hive` arg equal to the session\'s own hive', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { hive: 'hiveA-home' }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.tool).toBe('gatingtest:scoped');
  });

  it('flag ON: rejects coord:presence scope:\'workspace\' (widens past the hive)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('coord:presence', { scope: 'workspace' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('hive_forbidden');
    expect(h.assemblePresenceSnapshot).not.toHaveBeenCalled();
  });

  it('flag ON: allows targeted coord:presence scope:\'workspace\' (same scope as its owner default)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'coord:presence',
      { scope: 'workspace', workspace: 'ws-1', owner: 'su-known-peer', include_coupling: false },
      hiveScoped(),
    );
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).not.toContain('hive_forbidden');
    expect(h.assemblePresenceSnapshot).toHaveBeenCalledTimes(1);
    expect(h.assemblePresenceSnapshot.mock.calls[0]?.[1]).toMatchObject({ owner: 'su-known-peer' });
  });

  it.each([
    ['ownerId', { ownerId: 'su-known-peer' }],
    ['owners', { owners: ['su-known-peer'] }],
    ['ownerIds', { ownerIds: ['su-known-peer'] }],
  ])('flag ON: allows targeted coord:presence scope:\'workspace\' through the %s alias', async (_alias, selector) => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'coord:presence',
      { scope: 'workspace', workspace: 'ws-1', ...selector, include_coupling: false },
      hiveScoped(),
    );
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).not.toContain('hive_forbidden');
  });

  it('flag ON: rejects coord:presence scope:\'all\' (every-workspace roster)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('coord:presence', { scope: 'all' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('hive_forbidden');
  });

  it('flag ON: rejects targeted coord:presence scope:\'all\' (still crosses workspaces)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('coord:presence', { scope: 'all', owner: 'su-known-peer' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('hive_forbidden');
  });

  // P-016/P-014b: the search + memory surfaces scope by `harness_slug` (not the
  // `harness` arg the P-014a check keys on). memory:* are scoped-safe crossWorkspace
  // → they REACH this clamp; reject a `harness_slug` targeting a sibling hive.
  it('flag ON: rejects a `harness_slug` outside the hive subtree (search/memory key)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness_slug: 'hiveB-home' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: rejects memory:search targeting a SIBLING hive via harness_slug', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('memory:search', { query: 'x', harness_slug: 'hiveB-home' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: ALLOWS a `harness_slug` within the hive subtree', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { harness_slug: 'hiveA-member' }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.tool).toBe('gatingtest:scoped');
  });

  // WI-1345963: a harness can also be named through `scope` — improvements:capture
  // takes scope:'harness:<slug>' (the spelling its own schema RECOMMENDS over the
  // `harness` alias), and facts:* take scope:'harness' + scopeRef. Both bypassed the
  // clamp: a hive-'papercusp' session planted EI-21891461660239266 into hive
  // 'calendar' and could then neither claim, comment on, nor close it.
  it("flag ON: rejects scope:'harness:<slug>' naming a SIBLING hive (the confirmed bypass)", async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { scope: 'harness:hiveB-home' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
    expect(textOf(res)).toContain('hiveB-home');
  });

  it("flag ON: rejects scope:'harness' + scopeRef naming a SIBLING hive (facts:* spelling)", async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { scope: 'harness', scopeRef: 'hiveB-home' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it("flag ON: rejects the scope:'harness:all' global escape", async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { scope: 'harness:all' }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  // The other direction: the gate must not over-block, or it would be indistinguishable
  // from a broken clamp that rejects everything.
  it("flag ON: ALLOWS scope:'harness:<slug>' WITHIN the hive subtree", async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('gatingtest:scoped', { scope: 'harness:hiveA-member' }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(seen.at(-1)?.tool).toBe('gatingtest:scoped');
  });

  it('flag ON: leaves a NON-harness scope selector untouched (workspace/owner/role)', async () => {
    h.scopedClampFlag.value = true;
    for (const scope of ['workspace', 'owner', 'role', 'work_item']) {
      const res = await callTool('gatingtest:scoped', { scope, scopeRef: 'hiveB-home' }, hiveScoped());
      expect(res.isError, `scope:'${scope}' must not be treated as a harness name`).not.toBe(true);
    }
  });

  it("flag OFF: a hive-harness session may pass a foreign scope:'harness:<slug>' (unchanged)", async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:scoped', { scope: 'harness:hiveB-home' }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag OFF: a hive-harness session may pass a foreign `hive` arg (unchanged)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('gatingtest:scoped', { hive: 'hiveB-home' }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:scoped-ok');
  });

  it('flag OFF: a hive-harness session may still use cross_harness:* (unchanged)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('cross_harness:probe', {}, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('cross_harness:probe-ok');
  });
});

/* ─── tools/list ─────────────────────────────────────────────────────── */

describe('tools/list — strict-mode listing matrix', () => {
  it('handlers were captured for both verbs', () => {
    expect(h.handlers.has('tools/list')).toBe(true);
    expect(h.handlers.has('tools/call')).toBe(true);
  });

  it('a spawn URL that FAILS signature verification throws a LOUD auth error, not a silent empty list (WI-574)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.verifySpawnParams.mockResolvedValueOnce({ ok: false, reason: 'expired' });
      // WI-574: a rejected auth ctx no longer silently lists zero tools (which looked like a
      // healthy-but-empty server) — tools/list throws mcp_auth_failed with the reason.
      await expect(listTools(extraFor(signedUrl()))).rejects.toThrow(/mcp_auth_failed.*spawn_sig_expired/);
      // The failure is still audited (before the throw), not silent.
      expect(h.logVerificationFailure).toHaveBeenCalledTimes(1);
      expect(h.logVerificationFailure.mock.calls[0][0]).toMatchObject({
        reason: 'expired',
        claimedRole: 'scoper',
        claimedWorkspace: 'ws-test',
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[spawn-signing] rejected MCP request: expired'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('records native-session verifier diagnostics when tools/list rejects before listing tools', async () => {
    const nativeThread = 'native-list-verifier-session';
    h.nativeSessionVerifierFailure = {
      sessionId: nativeThread,
      error: Object.assign(new Error(`verification timed out for ${nativeThread} and su-owner`), {
        name: 'OrgTxnTimeoutError',
        pgCode: '57014',
        nativeSessionVerificationPhase: 'owner_candidate_rows_lookup',
      }),
    };
    const meta = { threadId: nativeThread };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner') as Record<string, unknown>),
      _meta: meta,
    };

    await expect(listTools(extra)).rejects.toThrow(/mcp_auth_failed.*superuser_native_session_verifier_unavailable/);

    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-owner', sessionId: nativeThread }]);
    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]).toMatchObject({
      toolName: 'tools/list',
      status: 'error',
      errorCode: 'mcp_auth_failed',
      errorMessage: 'superuser_native_session_verifier_unavailable',
      metadataJson: {
        mcpAuthFailure: {
          reason: 'superuser_native_session_verifier_unavailable',
          contextVerified: false,
          nativeSession: {
            carrier: 'meta:threadId',
            candidateAdvSessionId: null,
            verifierFailure: {
              name: 'OrgTxnTimeoutError',
              code: '57014',
              phase: 'owner_candidate_rows_lookup',
            },
          },
        },
      },
    });
    expect(JSON.stringify(h.invocations[0]?.metadataJson)).not.toContain(nativeThread);
    expect(JSON.stringify(h.invocations[0]?.metadataJson)).not.toContain('su-owner');
  });

  it('?superuser=1 from a NON-loopback host is a failed ctx → throws loud auth error (WI-574, real isLoopbackRequest)', async () => {
    await expect(
      listTools(
        extraFor(`${MCP}?superuser=1`, {
          host: 'evil.example.com',
          authorization: 'Bearer test-su-bearer',
        }),
      ),
    ).rejects.toThrow(/mcp_auth_failed.*superuser_non_loopback/);
  });

  it('tools/list attributes a pending generation read and retains the completed catalog baseline', async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    let release!: (rows: unknown[]) => void;
    let entered!: () => void;
    const readStarted = new Promise<void>(resolve => { entered = resolve; });
    const migrationRows = new Promise<unknown[]>(resolve => { release = resolve; });
    h.kernelAuthority.migrationRead = () => {
      entered();
      return migrationRows;
    };
    const rows = [{ filename: '1489-fallback-observations-samples.sql', sha256: 'sha-1489' }];
    try {
      const request = listTools(superuserExtra('&workspace=ws-test'));
      await readStarted;
      await vi.advanceTimersByTimeAsync(5_000);
      const records = () => info.mock.calls.flatMap(([message]) => {
        const text = String(message);
        return text.startsWith('[mcp-request-trace] ')
          ? [JSON.parse(text.slice('[mcp-request-trace] '.length))] : [];
      });
      expect(records()).toContainEqual(expect.objectContaining({
        toolName: 'tools/list', stage: 'tools_list_pending',
        toolsListPhases: expect.objectContaining({
          pending: [expect.objectContaining({ phase: 'servingGeneration' })],
        }),
      }));
      release(rows);
      const catalog = await request;
      expect(catalog.tools.length).toBeGreaterThan(0);
      expect(catalog.tools.every(tool => Boolean(tool._meta?.['papercusp/servingGeneration']))).toBe(true);
      expect(records()).toContainEqual(expect.objectContaining({
        toolName: 'tools/list', stage: 'tools_list_completed', outcome: 'success',
        toolsListPhases: expect.objectContaining({ pending: [] }),
      }));
      const count = records().length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(records()).toHaveLength(count);
    } finally {
      release(rows);
      h.kernelAuthority.migrationRead = null;
      info.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a verified role-scoped caller sees ONLY tools its role admits', async () => {
    const res = await listTools(extraFor(signedUrl({ role: 'scoper' })));
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:scoped');
    expect(names).not.toContain('gatingtest:engineer'); // operator-only
    // Full-matrix invariant: nothing listed excludes scoper in its allowlist.
    const violations = names.filter((n) => {
      const reg = lookupByMcpName(n);
      return Boolean(reg?.agentRoles && !reg.agentRoles.includes('scoper'));
    });
    expect(violations).toEqual([]);
  });

  it('derives readOnlyHint from projected.effect without dropping listing _meta', async () => {
    const res = await listTools(extraFor(signedUrl({ role: 'scoper' })));
    const read = res.tools.find((tool) => tool.name === 'gatingtest:read_annotation');
    const write = res.tools.find((tool) => tool.name === 'gatingtest:write_annotation');

    expect(read?.annotations).toMatchObject({ readOnlyHint: true });
    expect(write?.annotations).toMatchObject({ readOnlyHint: false });
    expect(read?._meta).toMatchObject({
      'papercusp/toolRegistryRevision': expect.any(String),
      'papercusp/toolRegistrySource': 'projected-tool-registry',
    });
    expect(write?._meta).toMatchObject({
      'papercusp/toolRegistryRevision': expect.any(String),
      'papercusp/toolRegistrySource': 'projected-tool-registry',
    });
  });

  it('a different role does NOT see the scoper-only tool', async () => {
    const res = await listTools(extraFor(signedUrl({ role: 'worker' })));
    expect(res.tools.map((t) => t.name)).not.toContain('gatingtest:scoped');
  });

  it('adds only receipt-listed tools admitted by the identity surface for a custom app worker', async () => {
    h.identityListingTest = true;
    h.identityOperationRecord = {
      acceptedOperation: {
        kind: 'blueprint-operation-worker',
        requiredTools: ['work_items:claim', 'work_items:checkpoint', 'plans:set-status'],
      },
    };
    h.identityAdmittedToolNames = new Set(['work_items:claim']);
    h.identityListingRoleCaps = ['work_items:read', 'work_items:write'];
    h.potHomeSlugForHarness.mockResolvedValueOnce('calendar');

    const role = 'calendar-prep-worker';
    expect(listMcpProjections(role as never, 'engineer').some((tool) => tool.name === 'work_items:claim')).toBe(false);
    expect(lookupByMcpName('work_items:claim')?.capabilities).toContain('work_items:write');
    expect(lookupByMcpName('plans:set-status')?.capabilities).toContain('plans:write');

    const res = await listTools({
      ...extraFor(signedUrl({ harness: 'calendar', role })) as object,
      sessionId: 'mcp-accepted-operation-listing',
    });
    const names = res.tools.map((tool) => tool.name);

    expect(h.identitySurfacePhases?.intervals().map(({ phase }) => phase))
      .toContain('identitySurface.context');
    expect(h.identityListedCandidateNames).toContain('work_items:claim');
    expect(h.identityListedCandidateNames).toContain('work_items:checkpoint');
    expect(h.identityListedCandidateNames).toContain('plans:set-status');
    expect(names).toContain('work_items:claim');
    expect(names).not.toContain('work_items:checkpoint'); // receipt-required, but the identity surface did not admit it
    expect(names).not.toContain('plans:set-status'); // receipt-required, but not admitted by the identity surface
    expect(names).not.toContain('gatingtest:engineer'); // absent from the receipt
    expect(h.identityObservedRoleCaps).toContain('work_items:write');
    expect(h.identityObservedRoleCaps).not.toContain('plans:write');
  });

  it('keeps receipt-required tools discoverable during initial identity activation', async () => {
    h.identityListingTest = true;
    h.identityListingUnresolved = true;
    h.identityOperationRecord = {
      acceptedOperation: {
        kind: 'blueprint-operation-worker',
        requiredTools: ['work_items:claim', 'work_items:checkpoint', 'plans:set-status'],
      },
    };
    h.identityListingRoleCaps = ['work_items:read', 'work_items:write'];
    h.potHomeSlugForHarness.mockResolvedValueOnce('calendar');
    const u = new URL(signedUrl({ harness: 'calendar', role: 'calendar-prep-worker' }));
    u.searchParams.set('tools', 'coord:send');

    const res = await listTools({
      ...extraFor(u.toString()) as object,
      sessionId: 'mcp-pending-operation-listing',
    });

    expect(res.tools.map(tool => tool.name).sort())
      .toEqual(['work_items:checkpoint', 'work_items:claim']);
    expect(h.identityObservedRoleCaps).not.toContain('plans:write');
  });

  it('?tools= allowlist narrows the listing to exactly the named set', async () => {
    const u = new URL(signedUrl({ role: 'scoper' }));
    u.searchParams.set('tools', 'gatingtest:scoped, definitely:not-registered');
    const res = await listTools(extraFor(u.toString()));
    expect(res.tools.map((t) => t.name)).toEqual(['gatingtest:scoped']);
  });

  it('seeded discovery and post-call refresh finish without joining unrelated telemetry persistence', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    h.flushPendingTelemetry.mockImplementation(() => blocked);
    h.kernelAuthority.usedToolNames = ['gatingtest:engineer', 'gatingtest:scoped', 'retired:tool'];
    const sendNotification = vi.fn(async () => {});
    const extra = { ...superuserExtra('&workspace=ws-test&client=su-discovery-flush-stall&tools=tools:invoke') as object,
      sendNotification };
    try {
      const listing = await listTools(extra);
      const names = listing.tools.map(tool => tool.name);
      expect(names).toContain('gatingtest:engineer');
      expect(names).not.toContain('gatingtest:scoped');
      expect(names).not.toContain('retired:tool');
      h.kernelAuthority.usedToolNames.push('gatingtest:txless_scope');
      const result = await callTool('gatingtest:engineer', {}, extra);
      expect(result.isError).not.toBe(true);
      expect(seen.map(call => call.tool)).toContain('gatingtest:engineer');
      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledWith({
        method: 'notifications/tools/list_changed', params: {},
      }));
      expect(h.flushPendingTelemetry).not.toHaveBeenCalled();
      expect(listing.tools.every(tool => Boolean(tool._meta?.['papercusp/servingGeneration']))).toBe(true);
    } finally {
      release();
    }
  });

  it('superuser listing is operator-role-filtered (call-time bypass does NOT widen the list)', async () => {
    const res = await listTools(superuserExtra());
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:engineer'); // agentRoles: ['operator']
    expect(names).not.toContain('gatingtest:scoped'); // scoper-only stays hidden
  });

  it('superuser ?profile=power hides engineer-profile tools from the listing', async () => {
    const res = await listTools(superuserExtra('&profile=power'));
    const names = res.tools.map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('gatingtest:engineer');
  });

  it('superuser ?role=<r> narrows the listing to that role catalog (token-usage P-011 — SU-bearer fleet spawns)', async () => {
    const res = await listTools(superuserExtra('&role=scoper'));
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:scoped'); // scoper-allowlisted
    expect(names).not.toContain('gatingtest:engineer'); // operator-only no longer advertised
    // Full-matrix invariant: nothing listed excludes scoper in its allowlist.
    const violations = names.filter((n) => {
      const reg = lookupByMcpName(n);
      return Boolean(reg?.agentRoles && !reg.agentRoles.includes('scoper'));
    });
    expect(violations).toEqual([]);
  });

  it('a bare probe (no spawn params at all) keeps the soft, UNfiltered listing', async () => {
    const res = await listTools(extraFor(MCP));
    const names = res.tools.map((t) => t.name);
    expect(names).toContain('gatingtest:scoped');
    expect(names).toContain('gatingtest:engineer');
  });
});

/* ─── tools/call — auth rejection BEFORE dispatch ────────────────────── */

describe('tools/call — auth failures reject before any dispatch', () => {
  it('an invalid/expired spawn signature → request_rejected, no fall-through to bearer dispatch', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      h.verifySpawnParams.mockResolvedValueOnce({ ok: false, reason: 'expired' });
      // Use a LEGACY catalog tool name: if the handler wrongly fell through to
      // bearer dispatch we would see `invalid_bearer`, not `request_rejected`.
      const legacyName = getCatalog()[0]?.name;
      expect(legacyName).toBeTruthy();
      const res = await callTool(legacyName!, {}, extraFor(signedUrl()));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/^request_rejected: spawn_sig_expired\b/);
      expect(textOf(res)).toMatch(/scripts\/mcp-call\.mjs/);
      expect(textOf(res)).toMatch(/RE-SPAWN/);
      expect(h.logVerificationFailure).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('PAPERCUSP_REQUIRE_SPAWN_SIG=1: an UNSIGNED URL that claims a spawn ctx is rejected + audited', async () => {
    process.env.PAPERCUSP_REQUIRE_SPAWN_SIG = '1';
    const res = await callTool('gatingtest:scoped', {}, extraFor(signedUrl({ sig: '', exp: '' })));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^request_rejected: spawn_sig_missing_sig_required_mode\b/);
    expect(h.logVerificationFailure).toHaveBeenCalledTimes(1);
    expect(h.logVerificationFailure.mock.calls[0][0]).toMatchObject({
      reason: 'missing_sig_required_mode',
      claimedRole: 'scoper',
    });
    expect(seen).toEqual([]);
  });

  it('?superuser=1 with a bad bearer → superuser_invalid_bearer, tool never executes', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      extraFor(`${MCP}?superuser=1&workspace=ws-test`, { authorization: 'Bearer wrong' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: superuser_invalid_bearer');
    expect(seen).toEqual([]);

    // Auth rejection happens before the projected dispatcher builds its ctx,
    // so this row is the detector's only evidence that the session attempted a
    // call. The rejected request's args remain intentionally absent.
    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]).toMatchObject({
      toolName: 'gatingtest:scoped',
      status: 'error',
      errorCode: 'mcp_auth_failed',
      errorMessage: 'superuser_invalid_bearer',
      ctx: {
        workspaceId: 'ws-test',
        harnessSlug: '*',
        isSuperuser: true,
        transport: 'mcp',
      },
      metadataJson: {
        mcpAuthFailure: { reason: 'superuser_invalid_bearer', contextVerified: false },
      },
    });
    expect(h.invocations[0]?.args).toBeUndefined();
  });

  it('?superuser=1 from a non-loopback origin → superuser_non_loopback', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      extraFor(`${MCP}?superuser=1`, {
        host: 'evil.example.com',
        authorization: 'Bearer test-su-bearer',
      }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: superuser_non_loopback');
    expect(seen).toEqual([]);
  });

  it('?power_user=1 with an invalid/expired access token → power_user_invalid_token', async () => {
    // verifyAccessToken default-resolves null (expired / tampered / unknown).
    const res = await callTool(
      'gatingtest:scoped',
      {},
      extraFor(`${MCP}?power_user=1`, { authorization: 'Bearer stale-token' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: power_user_invalid_token');
    expect(seen).toEqual([]);
  });

  it('unknown tool name → unknown_tool error envelope with the discovery referral (EI-9011)', async () => {
    const res = await callTool('gatingtest:does-not-exist', {}, extraFor(MCP));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('unknown_tool: no tool named "gatingtest:does-not-exist"');
    // Moment-of-failure referral: the error itself routes the caller to the
    // universal fallbacks instead of letting a miss read as "doesn't exist".
    expect(textOf(res)).toContain('tools:invoke');
    expect(textOf(res)).toContain('tools:find');
  });

  it('a projected tool called WITHOUT any spawn ctx → invalid_request_context (not unknown)', async () => {
    const res = await callTool('gatingtest:scoped', {}, extraFor(MCP));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^invalid_request_context: /);
    expect(textOf(res)).toContain('harness/workspace/role/run/spawn');
    expect(seen).toEqual([]);
  });

  it('legacy bearer fallback: catalog tool + no bearer → invalid_bearer BEFORE the handler runs', async () => {
    const legacyName = getCatalog()[0]?.name;
    expect(legacyName).toBeTruthy();
    const res = await callTool(legacyName!, {}, extraFor(MCP)); // no Authorization header
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('invalid_bearer: Bearer token did not resolve to a principal');
  });
});

/* ─── tools/call — role / profile / workspace dispatch matrix ────────── */

describe('tools/call — role, profile, and workspace gating through the dispatcher', () => {
  it('out-of-role call → role_not_allowed, handler NOT executed', async () => {
    const res = await callTool('gatingtest:scoped', {}, extraFor(signedUrl({ role: 'worker' })));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'role_not_allowed: Role "worker" cannot call tool "gatingtest:scoped" (allowed roles: scoper)',
    );
    expect(seen).toEqual([]);
    // The allowlist is knowable from the target definition; a denial must not
    // wait for principal synthesis via withWorkspace.
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('rejects judge from docs:search before synthesizing a workspace principal', async () => {
    const res = await callTool(
      'docs:search',
      { query: 'authorization ordering regression fixture' },
      extraFor(signedUrl({ role: 'judge' })),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('role_not_allowed:');
    expect(textOf(res)).toContain('docs:search');
    expect(h.withWorkspaceCalls).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('in-role call dispatches with a synthesized least-privilege principal + workspace tx + ALS pin', async () => {
    const res = await callTool('gatingtest:scoped', { a: 1 }, extraFor(signedUrl({ role: 'scoper' })));
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('gatingtest:scoped-ok');
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.args).toEqual({ a: 1 });
    expect(call.ctx.workspaceId).toBe('ws-test');
    expect(call.ctx.role).toBe('scoper');
    // tx synthesized via withWorkspace(ws-test); principal is the role's own,
    // NOT a bypass (gateBypass all-false for signed role-scoped callers).
    expect(h.withWorkspaceCalls).toEqual(['ws-test']);
    expect(call.ctx.tx).toBe(h.fakeTx);
    expect(call.ctx.principal?.slug).toBe('system:scoper');
    expect(call.ctx.principal?.capabilities.has('agent_tools:read')).toBe(true);
    expect(call.ctx.gateBypass).toEqual({ role: false, capability: false, quota: false });
    // P-022: the request-scoped workspace ALS is pinned for the handler.
    expect(call.alsWorkspace).toBe('ws-test');
  });

  it('EI-20241887270783191: retries a measured pre-handler pool deadline without rerunning the handler', async () => {
    h.failNextWorkspaceAcquire = true;
    const res = await callTool('gatingtest:scoped', { a: 1 }, extraFor(signedUrl({ spawn: 'spawn-retry' })));
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('gatingtest:scoped-ok');
    expect(h.withWorkspaceCalls).toEqual(['ws-test', 'ws-test']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.args).toEqual({ a: 1 });
  });

  it('records a non-retryable pre-dispatch acquisition deadline without running the handler', async () => {
    const { DbCallDeadlineError } = await import('@papercusp/db-org');
    const deadline = new DbCallDeadlineError('withWorkspace:acquire(app)', 45_000, 45_000);
    h.workspaceAcquireError = deadline;

    await expect(
      callTool('gatingtest:scoped', { a: 1 }, extraFor(signedUrl({ spawn: 'spawn-pre-dispatch' }))),
    ).rejects.toBe(deadline);

    expect(seen).toEqual([]);
    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]).toMatchObject({
      toolName: 'gatingtest:scoped',
      status: 'error',
      args: { a: 1 },
      errorMessage: deadline.message,
    });
  });

  it('delta proxy: a generic repeated MCP read sends an internal cursor and reconstructs a full result', async () => {
    const extra = extraFor(signedUrl({ role: 'scoper', spawn: 'spawn-delta' }));
    const first = await callTool('gatingtest:delta_list', {}, extra);
    expect(first.isError).toBeUndefined();
    expect(deltaRequested).toEqual([undefined]);

    const second = await callTool('gatingtest:delta_list', {}, extra);
    expect(second.isError).toBeUndefined();
    expect(deltaRequested).toHaveLength(2);
    expect(deltaRequested[1]).toEqual(expect.any(String));
    expect(deltaRequested[1]).not.toBe('full');
    expect(second._meta?.deltaProxy).toMatchObject({
      servedMode: 'not_modified',
      reconstructedFull: true,
    });
    expect(JSON.parse(textOf(second))).toHaveLength(12);
  });

  it('delta proxy: explicit client _meta.delta is honored, not overwritten by the proxy cache', async () => {
    const extra = extraFor(signedUrl({ role: 'scoper', spawn: 'spawn-explicit-delta' }));
    await callTool('gatingtest:delta_list', {}, extra, { delta: 'full' });
    expect(deltaRequested).toEqual(['full']);
  });

  it('superuser BYPASSES the role allowlist on the same tool (workspace-scoped call)', async () => {
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&workspace=ws-test'));
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('gatingtest:scoped-ok');
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.isSuperuser).toBe(true);
    expect(call.ctx.principal?.slug).toBe('system:operator');
    expect(call.ctx.gateBypass).toEqual({ role: true, capability: true, quota: true });
    expect(h.withWorkspaceCalls).toEqual(['ws-test']);
  });

  it('EI-20226130855047135: privileged role-gated recovery calls skip principal synthesis', async () => {
    const projected = lookupByMcpName('tools:find');
    expect(projected?.requirePrincipal).toBe(false);
    expect(projected?.needsWorkspaceTx).toBeFalsy();

    const res = await callTool('gatingtest:txless_role', {}, superuserExtra('&workspace=ws-test'));
    expect(res.isError).toBeUndefined();
    expect(textOf(res)).toBe('gatingtest:txless_role-ok');
    expect(txlessRoleProbeSeen).toHaveLength(1);
    expect(() => txlessRoleProbeSeen[0].tx).toThrowError('workspace_tx_not_declared');
    // No DB-backed principal synthesis occurs, but the transport still carries
    // a lightweight provenance principal for telemetry.
    expect(txlessRoleProbeSeen[0].principal).toMatchObject({
      kind: 'system',
      slug: 'system:operator',
      workspaceId: 'ws-test',
    });
    expect(txlessRoleProbeSeen[0].gateBypass?.capability).toBe(true);
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('a signed role caller gets only a short principal-synthesis tx for a default tool', async () => {
    const res = await callTool(
      'gatingtest:txless_role',
      {},
      extraFor(signedUrl({ role: 'scoper' })),
    );
    expect(res.isError).toBeUndefined();
    expect(txlessRoleProbeSeen).toHaveLength(1);
    expect(() => txlessRoleProbeSeen[0].tx).toThrowError('workspace_tx_not_declared');
    expect(h.withWorkspaceCalls).toEqual(['ws-test']);
  });

  it('an undeclared ctx.tx access fails immediately with the named contract error', async () => {
    const res = await callTool(
      'gatingtest:undeclared_tx_read',
      {},
      superuserExtra('&workspace=ws-test'),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('workspace_tx_not_declared');
    expect(textOf(res)).toContain('needsWorkspaceTx: true');
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('EI-20228655954419996: privileged work_items:get does not queue on org-app', async () => {
    const projected = lookupByMcpName('work_items:get');
    expect(projected?.requirePrincipal).toBe(false);
    expect(projected?.needsWorkspaceTx).toBeFalsy();

    // The real handler is intentionally allowed to return its normal not-found
    // result against this test's empty fake store. The load-bearing assertion is
    // that a scoped superuser reaches it without the short principal-synthesis
    // transaction, so a saturated org-app pool cannot strand this recovery read
    // at withWorkspace:acquire(app).
    const res = await callTool('work_items:get', { id: 'EI-gating-matrix' }, superuserExtra('&workspace=ws-test'));
    expect(res.isError).toBeUndefined();
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('EI-20229910901734876: privileged scheduler:get_next does not queue on org-app', async () => {
    const projected = lookupByMcpName('scheduler:get_next');
    expect(projected?.requirePrincipal).toBe(false);
    expect(projected?.needsWorkspaceTx).toBeFalsy();

    // scheduler:get_next owns its DB accessors and already opts out of retaining
    // an ambient workspace transaction. The privileged dispatcher must also skip
    // the short principal-synthesis probe; otherwise a saturated org-app pool
    // can fail the pull before the scheduler evaluates its claim lane.
    const res = await callTool(
      'scheduler:get_next',
      { harness: 'papercusp' },
      superuserExtra('&workspace=ws-test'),
    );
    expect(res.isError).toBeUndefined();
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('EI-20229273881874423: privileged locks:queue does not queue on org-app', async () => {
    const projected = lookupByMcpName('locks:queue');
    expect(projected?.requirePrincipal).toBe(false);
    expect(projected?.needsWorkspaceTx).toBeFalsy();

    // locks:queue owns its read pool and does not use ctx.tx. The privileged
    // dispatcher must therefore skip the short principal-synthesis probe as
    // well as the ambient transaction, or a saturated org-app pool can make a
    // self-verification read fail before the handler starts.
    const res = await callTool(
      'locks:queue',
      { owner: 'su-1336ba21-d2bc-44f7-bec4-fe2f0314199f' },
      superuserExtra('&workspace=ws-test'),
    );
    expect(res.isError).toBeUndefined();
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('power-profile callers cannot invoke engineer-profile tools by name (mirrors the list filter)', async () => {
    h.verifyAccessToken.mockResolvedValueOnce(POWER_CLAIMS);
    const res = await callTool(
      'gatingtest:engineer',
      {},
      extraFor(`${MCP}?power_user=1`, { authorization: 'Bearer pu-token' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      'tool_not_available_for_profile: "gatingtest:engineer" is not available in the power-engineer profile',
    );
    expect(seen).toEqual([]);
  });

  it('superuser testing ?profile=power hits the SAME profile gate (no superuser carve-out)', async () => {
    const res = await callTool('gatingtest:engineer', {}, superuserExtra('&profile=power&workspace=ws-test'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^tool_not_available_for_profile: /);
    expect(seen).toEqual([]);
  });

  it('power-user workspace is CLAMPED to the token claim — URL ?workspace= and the workspace ARG are both overridden', async () => {
    h.verifyAccessToken.mockResolvedValueOnce(POWER_CLAIMS);
    const res = await callTool(
      'gatingtest:scoped',
      { workspace: 'evil-workspace', x: 1 },
      extraFor(`${MCP}?power_user=1&workspace=evil-workspace`, {
        authorization: 'Bearer pu-token',
      }),
    );
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('ws-claim'); // token claim, never the URL
    expect((call.args as Record<string, unknown>).workspace).toBe('ws-claim'); // arg overwritten
    expect(call.ctx.isPowerUser).toBe(true);
    // Power-user bypasses role+capability but NOT quota.
    expect(call.ctx.gateBypass).toEqual({ role: true, capability: true, quota: false });
    expect(h.withWorkspaceCalls).toEqual(['ws-claim']);
  });

  it('EI-30: an UNSCOPED superuser passing a per-call `workspace` arg dispatches under THAT workspace', async () => {
    const res = await callTool('gatingtest:scoped', { workspace: 'ws-arg' }, superuserExtra());
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('ws-arg');
    expect(call.ctx.principal?.slug).toBe('system:operator');
    expect(call.ctx.tx).toBe(h.fakeTx);
    expect(h.withWorkspaceCalls).toEqual(['ws-arg']);
    expect(call.alsWorkspace).toBe('ws-arg');
  });

  it('EI-25982690010642755: harness:get and harness:status expose the per-call workspace tx path', async () => {
    const getRes = await callTool(
      'harness:get',
      { slug: 'missing-project', workspace: 'ws-get' },
      superuserExtra(),
    );
    expect(textOf(getRes)).not.toContain('requires a workspace-scoped call');
    expect(h.withWorkspaceCalls).toEqual(['ws-get']);

    const statusRes = await callTool(
      'harness:status',
      { slug: 'missing-project', workspace: 'ws-status' },
      superuserExtra(),
    );
    expect(textOf(statusRes)).not.toContain('requires a workspace-scoped call');
    expect(h.withWorkspaceCalls).toEqual(['ws-get', 'ws-status']);
  });

  it('an UNSCOPED superuser call with NO workspace gets neither tx nor principal nor ALS pin', async () => {
    const res = await callTool('gatingtest:scoped', {}, superuserExtra());
    expect(res.isError).toBeUndefined(); // this probe tool itself needs no principal
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('*');
    expect(() => call.ctx.tx).toThrowError('workspace_tx_unavailable');
    expect(call.ctx.principal).toBeNull();
    expect(call.alsWorkspace).toBeUndefined();
    expect(h.withWorkspaceCalls).toEqual([]);
    // No SID rode the request → the adv-row fallback is never consulted.
    expect(h.workspaceForCoordOwner).not.toHaveBeenCalled();
  });

  // ── psu-workspace-scoping fix: header carrier + SID→adv-row fallback ──

  it('x-papercusp-workspace header scopes a superuser call (OMP per-launch carrier) and beats ?workspace=', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&workspace=ws-url', { 'x-papercusp-workspace': 'ws-header' }),
    );
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call.ctx.workspaceId).toBe('ws-header');
    expect(call.ctx.tx).toBe(h.fakeTx);
    expect(h.withWorkspaceCalls).toEqual(['ws-header']);
    expect(call.alsWorkspace).toBe('ws-header');
    expect(h.workspaceForCoordOwner).not.toHaveBeenCalled(); // explicit scope → no lookup
  });

  it('no explicit workspace + a client SID → the adv-row fallback scopes the call', async () => {
    h.workspaceForCoordOwner.mockResolvedValueOnce('ws-adv');
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-xyz'));
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(h.workspaceForCoordOwner).toHaveBeenCalledWith('su-xyz');
    expect(call.ctx.workspaceId).toBe('ws-adv');
    expect(call.ctx.tx).toBe(h.fakeTx);
    // Harness inheritance now performs four bounded pre-dispatch reads (claim,
    // plan, fleet, brief) before the tool's own workspace transaction. Every
    // acquisition must stay pinned to the SID-resolved workspace.
    expect(h.withWorkspaceCalls).toEqual(Array(5).fill('ws-adv'));
    expect(call.alsWorkspace).toBe('ws-adv');
  });

  it('a client SID with NO adv row falls through to unscoped `*` (pre-fix behavior)', async () => {
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-unknown'));
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(h.workspaceForCoordOwner).toHaveBeenCalledWith('su-unknown');
    expect(call.ctx.workspaceId).toBe('*');
    expect(() => call.ctx.tx).toThrowError('workspace_tx_unavailable');
    expect(h.withWorkspaceCalls).toEqual([]);
  });

  it('explicit workspace scope does not inherit a stale ambient plan binding', async () => {
    h.getPresence.mockResolvedValueOnce({
      currentPlanSlug: 'identities-v1-2026-08-30',
      workspaceId: 'papercusp',
    });

    const result = await tryBuildSpawnContext(
      superuserExtra('&workspace=scratch&client=stale-plan-sid'),
    );

    expect(result).toMatchObject({ kind: 'ok', ctx: { workspaceId: 'scratch' } });
    expect(result).not.toEqual(expect.objectContaining({
      kind: 'failed',
      reason: expect.stringContaining('harness_scope_stale'),
    }));
    expect(h.getPresence).toHaveBeenCalledWith('stale-plan-sid', h.fakeTx);
  });

  it('x-papercusp-profile header gates like ?profile=power (psu --profile per-launch carrier)', async () => {
    const res = await callTool(
      'gatingtest:engineer',
      {},
      superuserExtra('&workspace=ws-test', { 'x-papercusp-profile': 'power' }),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^tool_not_available_for_profile: /);
    expect(seen).toEqual([]);
  });

  it('a principal-gated BUILT-IN under an unscoped superuser fails with the workspace-scoping error (handler path)', async () => {
    // The wrapper-level version of this gate is pinned in tool-auth-gating.test.ts;
    // this is the handler-path wiring its header records as owed.
    // (console silenced: the dispatch stack's invoke catch currently carries a
    // transient `[DBG dispatch-stack catch]` console.error from an in-flight
    // debugging session on the shared tree — not part of this contract.)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(lookupByMcpName('features:get')).toBeTruthy();
      const res = await callTool('features:get', {}, superuserExtra());
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/^unauthorized: /);
      expect(textOf(res)).toContain('requires a workspace-scoped call');
    } finally {
      err.mockRestore();
    }
  });
});

/* ─── cross-workspace-denial invariant (workspace-data-isolation-leaks #4) ──
 *
 * The isolation plan's Verification §, invariant #4: "authenticate as workspace B,
 * attempt to read A's data through every surface, assert denial." The
 * scoped-superuser-workspace-clamp is the enforcement; the synthetic-probe
 * MECHANISM is pinned above. This block wires the invariant on the REAL
 * WORKSPACE-partitioned cross-workspace READ surfaces a foreign reader would use:
 *   - papercusp:list_workspaces — the workspace ENUMERATOR (reads every workspace's
 *     registry off the admin handle).
 *   - search:fulltext / search:semantic — cross-workspace prose/embedding search.
 * Each is crossWorkspace:true (runs on the getOrgPg admin handle, which bypasses
 * per-workspace RLS) and is NOT on the scoped-safe / global-flag-admin allowlists,
 * so a SCOPED session is denied (workspace_forbidden) and only an UNSCOPED
 * (--all-workspaces) superuser may span. A NEW such read surface added without
 * confinement (or without an explicit allowlist review) makes this fail loudly.
 *
 * NOT asserted here (confined by a DIFFERENT axis, not the workspace clamp):
 *   - memory:search — the memory store is partitioned by user-id/harness-slug, NOT
 *     by workspace, so it is not a "read workspace A's data" surface. (Its declared
 *     crossWorkspace:true also does not reach the clamp — it dispatches on a
 *     workspace-scoped tx, not the admin-handle path; tracked separately as a
 *     declared-vs-projected discrepancy, not a workspace leak.)
 */
describe('cross-workspace-denial invariant (isolation-plan #4)', () => {
  const scoped = (ws: string) => superuserExtra(`&workspace=${ws}`);

  const FOREIGN_READ_SURFACES = [
    'papercusp:list_workspaces',
    // search:fulltext / search:semantic — MOVED to SCOPED_SAFE_CROSSWORKSPACE after
    // the explicit allowlist review this comment block calls for (session-search-
    // scope-2026-07-05): every SearchSource SQL confines by the workspaceId the
    // ENGINE is handed, and the handlers hand it ctx.workspaceId (the session's own
    // scoped workspace — never a caller-controlled arg), so a ws-b session can only
    // ever read ws-b rows (+ the session/coord sources' workspace_id='default' rows,
    // which are THIS HOST's local transcript files, not another workspace's tenant
    // data). crossWorkspace:true exists only so the UNSCOPED path gets the admin
    // handle for the non-RLS operator_turns table (P-062 Phase 4). The MAY-call
    // side is asserted in the scoped-safe allowlist tests above.
  ] as const;

  for (const tool of FOREIGN_READ_SURFACES) {
    it(`flag ON: a session scoped to ws-b is DENIED ${tool} (cannot read another workspace's data)`, async () => {
      // Guard: the invariant must run against a tool that is actually registered +
      // crossWorkspace — a silently-unregistered surface would vacuously "pass".
      expect(lookupByMcpName(tool), `${tool} must be a registered MCP tool`).toBeTruthy();
      h.scopedClampFlag.value = true;
      const res = await callTool(tool, { query: 'secret-from-ws-a' }, scoped('ws-b'));
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('workspace_forbidden');
    });
  }

  it('flag ON: a session scoped to ws-b is DENIED reading another workspace\'s plans by naming its harness', async () => {
    // The harness-arg vector (P-017): plan/work-item readers derive harness→workspace
    // from the registry, so naming a foreign-workspace harness would otherwise read it.
    h.scopedClampFlag.value = true;
    const res = await callTool('plans:get', { harness: 'foreign-ws-harness', slug: 'anything' }, scoped('ws-b'));
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag OFF: the invariant is a no-op (today\'s behavior — the surfaces are reachable)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool('papercusp:list_workspaces', {}, scoped('ws-b'));
    expect(textOf(res)).not.toContain('workspace_forbidden');
  });

  it('an UNSCOPED (--all-workspaces, ?workspace=*) superuser may still span — the invariant confines only SCOPED sessions', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('papercusp:list_workspaces', {}, scoped('*'));
    expect(textOf(res)).not.toContain('workspace_forbidden');
  });
});

/* ─── tools:invoke re-dispatch synthesizes the target's tx (EI-6982) ────── */

describe('tools:invoke threads the TARGET tool\'s tx/principal, not the tx-less meta-tool ctx (EI-6982)', () => {
  // Root cause: dispatchTool (the tools:invoke engine) reused the OUTER call's
  // ctx — built for tools:invoke itself (requirePrincipal:false ⇒ NO tx). So a
  // crossWorkspace/needsTx TARGET dispatched via tools:invoke saw ctx.tx ===
  // undefined and its projected wrapper threw "requires a workspace-scoped call".
  // Every memory:* / flags:set / harness:list call via tools:invoke from an
  // unscoped psu/fleet session hit this. dispatchWithSynthesizedTx now binds the
  // target's tx on BOTH the direct and the re-dispatch paths.

  it('a REAL crossWorkspace tool (memory:search) via tools:invoke from an UNSCOPED superuser does NOT hit the workspace-tx gate', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool(
      'tools:invoke',
      { name: 'memory:search', args: { query: 'ei6982' } },
      superuserExtra('&workspace=*'),
    );
    // The exact EI-6982 symptom string must be gone. (memory:search's handler may
    // still error on the stubbed backend — irrelevant; the GATE is what regressed.)
    expect(textOf(res)).not.toContain('requires a workspace-scoped call');
    expect(textOf(res)).not.toContain('no workspace transaction');
  });

  it('routes the ADMIN handle to a crossWorkspace target (unscoped superuser)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:crossworkspace', args: {} },
      superuserExtra('&workspace=*'),
    );
    expect(res.isError).not.toBe(true);
    expect(textOf(res)).toContain('gatingtest:crossworkspace-ok');
    // The INNER tool received the admin handle (getOrgPg().sql) + a synthesized
    // principal — proof the crossWorkspace synthesis ran on the re-dispatch path.
    const inner = seen.at(-1);
    expect(inner?.tool).toBe('gatingtest:crossworkspace');
    expect(inner?.ctx.tx).toBe(h.fakeSql);
    expect(inner?.ctx.principal).toBeTruthy();
  });

  it('opens a WORKSPACE tx for a needsTx target dispatched via tools:invoke (scoped session)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:engineer', args: {} },
      superuserExtra('&workspace=ws-test'), // a scoped superuser session
    );
    expect(res.isError).not.toBe(true);
    const inner = seen.at(-1);
    expect(inner?.tool).toBe('gatingtest:engineer');
    // A concrete workspace ⇒ the harness_app workspace tx (fakeTx), opened for ws-test.
    expect(inner?.ctx.tx).toBe(h.fakeTx);
    expect(h.withWorkspaceCalls).toContain('ws-test');
  });

  it('rejects a nested out-of-role target before synthesizing its workspace principal', async () => {
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:scoped', args: {} },
      extraFor(signedUrl({ role: 'worker' })),
    );

    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain(
      'role_not_allowed: Role "worker" cannot call tool "gatingtest:scoped"',
    );
    // The wrapper call still synthesizes its own principal; the forbidden target
    // must not add another workspace acquisition.
    expect(h.withWorkspaceCalls).toEqual(['ws-test']);
    expect(seen).toEqual([]);
  });

  it('preserves the caller harness on a nested target (EI-21238811054889658)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:crossworkspace', args: {} },
      superuserExtra('&workspace=ws-test&harness=papercup'),
    );
    expect(res.isError).not.toBe(true);
    const inner = seen.at(-1);
    expect(inner?.tool).toBe('gatingtest:crossworkspace');
    expect(inner?.ctx.harnessSlug).toBe('papercup');
  });

  it('preserves the caller harness on a txless nested target (EI-21238811054889658)', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:txless_scope', args: {} },
      superuserExtra('&workspace=ws-test&harness=papercup'),
    );
    expect(res.isError).not.toBe(true);
    const inner = seen.at(-1);
    expect(inner?.tool).toBe('gatingtest:txless_scope');
    expect(inner?.ctx.harnessSlug).toBe('papercup');
    expect(() => inner?.ctx.tx).toThrowError('workspace_tx_not_declared');
    expect(inner?.ctx.principal).toMatchObject({
      kind: 'system',
      slug: 'system:operator',
      workspaceId: 'ws-test',
    });
  });

  it('recovers the caller harness from the session brief when only a client SID is present (EI-21238811054889658)', async () => {
    h.getSessionBrief.mockResolvedValueOnce({ harnessSlug: 'papercup' });
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:txless_scope', args: {} },
      superuserExtra('&workspace=ws-test&client=su-brief-sid'),
    );
    expect(res.isError).not.toBe(true);
    expect(h.getSessionBrief).toHaveBeenCalledWith({ ownerId: 'su-brief-sid' }, h.fakeTx);
    const inner = seen.at(-1);
    expect(inner?.tool).toBe('gatingtest:txless_scope');
    expect(inner?.ctx.harnessSlug).toBe('papercup');
  });
});

/* ─── nested tools:invoke inherits the hive/workspace clamp (EI-22052744493834331) ─── */

describe('tools:invoke re-dispatch inherits the scoped-superuser hive clamp (EI-22052744493834331)', () => {
  // Root cause: ctx.dispatchTool (the tools:invoke re-dispatch engine) never called
  // applyScopedSuperuserTransportClamp at all — only the direct tools/call path did.
  // A scoped superuser confined to hive hiveA-home could read a sibling hive
  // (hiveB-home) by routing the SAME call through tools:invoke instead of calling it
  // directly. Mirrors the "scoped-superuser hive clamp" describe block's direct-call
  // assertions, through the nested path.
  const hiveScoped = () => superuserExtra('&workspace=ws-test&harness=hiveA-home');

  it('avoids an unused hive-home read for argument-free local tools', async () => {
    h.scopedClampFlag.value = true;
    h.potHomeSlugForHarness.mockClear();
    const res = await callTool('gatingtest:scoped', {}, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(h.potHomeSlugForHarness).not.toHaveBeenCalled();
  });

  it('avoids a second hive-home read for an argument-free nested target', async () => {
    h.scopedClampFlag.value = true;
    h.potHomeSlugForHarness.mockClear();
    const res = await callTool('tools:invoke', { name: 'gatingtest:scoped', args: {} }, hiveScoped());
    expect(res.isError).not.toBe(true);
    expect(h.potHomeSlugForHarness).toHaveBeenCalledTimes(1);
  });

  it('flag ON: rejects a per-call `harness` in a DIFFERENT hive via nested tools:invoke, same as direct', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:scoped', args: { harness: 'hiveB-home' } },
      hiveScoped(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: treats dev:build_status harness as ambient through nested handler dispatch', async () => {
    h.scopedClampFlag.value = true;
    h.devBuildStatus.mockResolvedValueOnce({
      prodBuild: { exists: true, mtimeMs: 1000 },
      devBuild: { exists: true, mtimeMs: 1000 },
      prodLogTail: null,
      dev3055Reachable: true,
      prod3070Reachable: true,
    });
    h.devTestFlakeRollup.mockResolvedValueOnce({ entries: [] });
    h.devFlagFlakeSuspects.mockReturnValueOnce([]);

    const res = await callTool(
      'tools:invoke',
      { name: 'dev:build_status', args: { harness: 'foreign-ws-harness' } },
      hiveScoped(),
    );

    expect(res.isError).not.toBe(true);
    expect(textOf(res)).not.toContain('harness_forbidden');
    expect(h.devBuildStatus).toHaveBeenCalledOnce();
    expect(h.withWorkspaceCalls).not.toContain('other-ws');
  });

  const GOAL_LOCAL_LAUNCH_TOOLS = [
    'fleet:launch-on-plan',
    'fleet:create',
    'capability:launch-agent',
  ] as const;

  it('flag ON: keeps sibling-hive launch tools denied without goal-holder proof via nested tools:invoke', async () => {
    h.scopedClampFlag.value = true;
    for (const name of GOAL_LOCAL_LAUNCH_TOOLS) {
      const res = await callTool(
        'tools:invoke',
        { name, args: { harness: 'hiveB-home' } },
        hiveScoped(),
      );
      expect(res.isError, name).toBe(true);
      expect(textOf(res), name).toContain('harness_forbidden');
    }
    expect(h.goalLocalPlacement.calls).toHaveLength(GOAL_LOCAL_LAUNCH_TOOLS.length);
  });

  it('flag ON: lets the elected goal holder reach sibling-hive launch validation via nested tools:invoke', async () => {
    h.scopedClampFlag.value = true;
    h.goalLocalPlacement.allow = true;
    const extra = superuserExtra('&workspace=ws-test&harness=hiveA-home&client=goal-holder');

    for (const name of GOAL_LOCAL_LAUNCH_TOOLS) {
      const res = await callTool(
        'tools:invoke',
        { name, args: { harness: 'hiveB-home' } },
        extra,
      );
      expect(textOf(res), name).not.toContain('harness_forbidden');
    }

    expect(h.goalLocalPlacement.calls).toEqual(
      GOAL_LOCAL_LAUNCH_TOOLS.map(() => ({
        workspaceId: 'ws-test',
        callerOwnerId: 'goal-holder',
        scopeHive: 'hiveA-home',
        targetHarness: 'hiveB-home',
      })),
    );
  });

  it('flag ON: allows nested git-sync:run to name the canonical platform Pot explicitly', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'git-sync:run', args: { installSlug: PLATFORM_POT_SLUG, dryRun: true } },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON: allows nested routines:list to inspect only the canonical platform Pot git-sync routine', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'routines:list', args: { installSlug: PLATFORM_POT_SLUG, name: 'git-sync' } },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON: allows nested routines:set to address an exact reserved harness-less Scout routine', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      {
        name: 'routines:set',
        args: {
          name: 'bp-singleton-scout-0',
          installSlug: '@singleton',
          active: false,
          reason: 'transport regression probe',
          dryRun: true,
        },
      },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag ON: allows nested routines:list to inspect an exact reserved harness-less Scout routine', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'routines:list', args: { installSlug: '@singleton', name: 'bp-singleton-scout-0' } },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it.each([
    ['installSlug', { installSlug: '@singleton' }],
    ['the harness alias', { harness: '@singleton' }],
  ])('flag ON: allows nested routines:fire for one exact reserved harness-less routine via %s', async (_case, target) => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'routines:fire', args: { ...target, name: 'bp-singleton-memory-precision-0' } },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it.each([
    ['a broad reserved-host read', { installSlug: '@singleton' }],
    ['a reserved-host rollup', { installSlug: '@singleton', name: 'bp-singleton-scout-0', rollup: true }],
  ])('flag ON: nested routines:list still rejects non-exact reserved-host targets (%s)', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('tools:invoke', { name: 'routines:list', args }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it.each([
    ['an id-only fire', { id: 'routine-id', installSlug: '@singleton' }],
    ['a wildcard fire', { name: '*', installSlug: '@singleton' }],
    ['a catch-all fire', { name: 'ALL', installSlug: '@singleton' }],
    ['a sibling-hive routine', { name: 'bp-singleton-memory-precision-0', installSlug: 'hiveB-home' }],
  ])('flag ON: nested routines:fire still rejects unsafe targets (%s)', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('tools:invoke', { name: 'routines:fire', args }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: allows a nested self-owned loop:checkpoint READ to recover a concrete sibling-hive note', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      {
        name: 'loop:checkpoint',
        args: { read: true, harness: 'hiveB-home', ownerId: 'nested-loop-owner' },
      },
      superuserExtra('&workspace=ws-test&harness=hiveA-home&client=nested-loop-owner'),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it.each([
    ['another owner\'s note', { read: true, harness: 'hiveB-home', ownerId: 'other-owner' }],
    ['a cross-hive WRITE', { did: 'must remain routine-scoped', harness: 'hiveB-home' }],
  ])('flag ON: nested loop:checkpoint still rejects %s', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'loop:checkpoint', args },
      hiveScoped(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: allows a nested issue-family work_items:checkpoint WRITE for a concrete sibling-hive harness', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      {
        name: 'work_items:checkpoint',
        args: {
          id: 'EI-nested-self-owned-checkpoint',
          checkpoint: 'nested transport reaches the handler ownership guard',
          harness: 'hiveB-home',
        },
      },
      hiveScoped(),
    );

    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it.each([
    ['a feature-family WI- checkpoint', { id: 'WI-nested-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: 'hiveB-home' }],
    ['a feature-family F- checkpoint', { id: 'F-nested-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: 'hiveB-home' }],
    ['the global `all` harness', { id: 'EI-nested-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: 'all' }],
    ['the wildcard `*` harness', { id: 'EI-nested-cross-hive-checkpoint', checkpoint: 'must stay scoped', harness: '*' }],
  ])('flag ON: nested still rejects work_items:checkpoint %s', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('tools:invoke', { name: 'work_items:checkpoint', args }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it.each([
    ['a broad canonical routine read', { installSlug: PLATFORM_POT_SLUG }],
    ['another canonical routine', { installSlug: PLATFORM_POT_SLUG, name: 'green-checkpoint' }],
    ['a rollup that ignores its exact filters', { installSlug: PLATFORM_POT_SLUG, name: 'git-sync', rollup: true }],
    ['a sibling install git-sync routine', { installSlug: 'hiveB-home', name: 'git-sync' }],
  ])('flag ON: nested routines:list still rejects %s', async (_case, args) => {
    h.scopedClampFlag.value = true;
    const res = await callTool('tools:invoke', { name: 'routines:list', args }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: nested git-sync:run still rejects any other foreign install', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'git-sync:run', args: { installSlug: 'hiveB-home', dryRun: true } },
      hiveScoped(),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: denies a nested cross_harness:* tool (it reads other harnesses)', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool('tools:invoke', { name: 'cross_harness:probe', args: {} }, hiveScoped());
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('harness_forbidden');
  });

  it('flag ON: allows a same-hive per-call `harness` via nested tools:invoke', async () => {
    h.scopedClampFlag.value = true;
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:scoped', args: { harness: 'hiveA-member' } },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });

  it('flag OFF: no clamp applied — nested cross-hive harness read is not rejected by this gate', async () => {
    h.scopedClampFlag.value = false;
    const res = await callTool(
      'tools:invoke',
      { name: 'gatingtest:scoped', args: { harness: 'hiveB-home' } },
      hiveScoped(),
    );
    expect(textOf(res)).not.toContain('harness_forbidden');
  });
});

/* ─── su identity precedence (EI-7066 — explicit SID outranks the transport id) ─── */

describe('su identity precedence (EI-7066: explicit SID before Mcp-Session-Id)', () => {
  it('?client= and ?detector= preserve separate public and private session identities', async () => {
    // The regression: a claude session that reconnects mid-life (cold-loop recycle,
    // transport drop) presents a fresh Mcp-Session-Id. Identity must STAY the SID.
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&client=su-stable-sid&detector=private-detector-session', {
        'mcp-session-id': 'transport-conn-1',
      }),
    );
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx.uiClientId).toBe('su-stable-sid');
    expect(seen[0].ctx.failureLoopSessionKey).toBe('private-detector-session');
  });

  it('x-papercusp-client header outranks both ?client= and Mcp-Session-Id', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&client=su-machine-static', {
        'x-papercusp-client': 'su-header-sid',
        'mcp-session-id': 'transport-conn-2',
      }),
    );
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx.uiClientId).toBe('su-header-sid');
  });

  it('binds Codex per-call thread metadata instead of an inherited process header', async () => {
    const native = '01a1154e-07f6-7450-a631-8b89b496cfa7';
    const inherited = '01a1152c-db72-7be2-8a02-57c018d99469';
    h.nativeSessionRows = new Map([['su-owner', [{ id: 36488, session_id: native, active: true }]]]);
    const meta = { threadId: native, sessionId: native };
    const extra = {
      // As in the existing successful-native audit, keep the positive fixture
      // unscoped: the PG-free harness has no persisted workspace launch row.
      ...(superuserExtra('&client=su-owner&native_session=stale-query', {
        'x-papercusp-native-session': inherited,
      }) as Record<string, unknown>),
      // The SDK copies request.params._meta to RequestHandlerExtra._meta.
      _meta: meta,
    };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError, textOf(res)).toBeUndefined();
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-owner', sessionId: native }]);
    expect(seen[0].ctx).toMatchObject({ uiClientId: 'su-owner', advSessionId: 36488 });
    expect(h.invocations[0]?.ctx.requestOrigin).toMatchObject({ nativeSession: {
      carrier: 'meta:threadId',
      valueFingerprint: createHash('sha256').update(native).digest('hex'),
      binding: 'bound',
      candidateAdvSessionId: 36488,
    } });
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toContain(native);
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toContain(inherited);
  });

  it('rejects a foreign per-call thread even when its inherited header matches the owner', async () => {
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: 'native-owner', active: true }]]]);
    const meta = { threadId: 'native-nested', sessionId: 'native-owner' };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner', {
        'x-papercusp-native-session': 'native-owner',
      }) as Record<string, unknown>),
      _meta: meta,
    };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError).toBe(true);
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-owner', sessionId: 'native-nested' }]);
    expect(seen).toHaveLength(0);
    expect(h.invocations[0]).toMatchObject({ errorCode: 'mcp_auth_failed', metadataJson: {
      mcpAuthFailure: { reason: 'superuser_foreign_native_session', nativeSession: {
        carrier: 'meta:threadId',
        valueFingerprint: createHash('sha256').update('native-nested').digest('hex'),
        candidateAdvSessionId: 541,
      } },
    } });
  });

  it.each([null, 42, '', '   ', ['native-owner']].map((threadId) => ({ threadId })))('fails closed on malformed per-call thread metadata $threadId', async ({ threadId }) => {
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: 'native-owner', active: true }]]]);
    const meta = { threadId };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner', {
        'x-papercusp-native-session': 'native-owner',
      }) as Record<string, unknown>),
      _meta: meta,
    };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('superuser_native_session_unverified');
    expect(textOf(res)).toContain('Reconnect the MCP client so it resends the active thread ID.');
    expect(h.nativeSessionCalls).toHaveLength(0);
    expect(seen).toHaveLength(0);
    expect(h.invocations[0]).toMatchObject({
      status: 'error',
      errorCode: 'mcp_auth_failed',
      errorMessage: 'superuser_native_session_unverified',
      metadataJson: {
        mcpAuthFailure: {
          reason: 'superuser_native_session_unverified',
          contextVerified: false,
        },
      },
    });
  });

  it('fails closed with a retryable verifier reason when per-call verification throws despite a matching inherited SID', async () => {
    const nativeThread = 'native-child-session';
    const inheritedSession = 'native-parent-session';
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: inheritedSession, active: true }]]]);
    h.nativeSessionVerifierFailure = {
      sessionId: nativeThread,
      error: Object.assign(new Error(`verification timed out for ${nativeThread} and su-owner`), {
        name: 'OrgTxnTimeoutError',
        pgCode: '57014',
      }),
    };
    const meta = { threadId: nativeThread };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner', {
        'x-papercusp-native-session': inheritedSession,
      }) as Record<string, unknown>),
      _meta: meta,
    };

    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('superuser_native_session_verifier_unavailable');
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-owner', sessionId: nativeThread }]);
    expect(seen).toHaveLength(0);
    expect(h.invocations[0]).toMatchObject({
      status: 'error',
      errorMessage: 'superuser_native_session_verifier_unavailable',
      metadataJson: {
        mcpAuthFailure: {
          reason: 'superuser_native_session_verifier_unavailable',
          nativeSession: {
            carrier: 'meta:threadId',
            candidateAdvSessionId: null,
            verifierFailure: {
              name: 'OrgTxnTimeoutError',
              code: '57014',
              message: 'verification timed out for [redacted] and [redacted]',
              durationMs: expect.any(Number),
              stageTimings: {
                omittedStages: 0,
                stages: [expect.objectContaining({
                  stage: 'native-session-verifier-global-transaction',
                  elapsedMs: expect.any(Number),
                  outcome: 'rejected',
                })],
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(h.invocations[0]?.metadataJson)).toContain('[redacted]');
    expect(JSON.stringify(h.invocations[0]?.metadataJson)).not.toContain(nativeThread);
    expect(JSON.stringify(h.invocations[0]?.metadataJson)).not.toContain('su-owner');
  });

  it.each(['acquire', 'begin', 'setup-read-only', 'setup-timeouts'])(
    'retains typed %s deadline diagnostics when native verification fails closed', async (phase) => {
    const { DbCallDeadlineError, beginAcquire, recordPoolMax, resetAcquireRegistryForTest } = await import('@papercusp/db-org');
    const { withNamedQueryDiagnosticContext } = await import('../../agent-tools/db-diagnostic-correlation-wiring');
    resetAcquireRegistryForTest();
    recordPoolMax('org-admin', 19);
    const waitingTicket = beginAcquire('org-admin');
    const heldTicket = beginAcquire('org-admin');
    heldTicket.acquired();
    const traceId = 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e';
    const nativeThread = 'native-deadline-session';
    const label = `boundedOrgTxn:${phase}(admin)`;
    const deadline = withNamedQueryDiagnosticContext('mcp.nativeSessionVerifier', () => {
      const verifierTicket = beginAcquire('org-admin');
      const error = new DbCallDeadlineError(label, 1_000, 1_771, 'org-admin');
      verifierTicket.release();
      return error;
    }, traceId);
    h.nativeSessionVerifierFailure = { sessionId: nativeThread, error: deadline };
    const meta = { threadId: nativeThread };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner', {
        'x-papercusp-native-session': 'native-inherited-session',
        [MCP_REQUEST_TRACE_HEADER]: traceId,
      }) as Record<string, unknown>),
      _meta: meta,
    };

    try {
      const res = await callTool('gatingtest:scoped', {}, extra, meta);

      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain('superuser_native_session_verifier_unavailable');
      expect(seen).toHaveLength(0);
      expect(h.invocations[0]).toMatchObject({
        metadataJson: { mcpAuthFailure: { nativeSession: { verifierFailure: {
          name: 'DbCallDeadlineError',
          acquisition: {
            label,
            pool: 'org-admin',
            deadlineMs: 1_000,
            elapsedMs: 1_771,
            retryable: deadline.retryable,
            pressure: {
              pid: process.pid,
              pool: 'org-admin',
              waiting: 1,
              held: 1,
              max: 19,
              lastAcquiredAgoMs: expect.any(Number),
              totalAcquired: 1,
            },
            ticketSample: {
              capacity: 8,
              active: 3,
              omitted: 0,
              tickets: expect.arrayContaining([
                expect.objectContaining({
                  state: 'waiting',
                  requestId: traceId,
                  operation: 'mcp.nativeSessionVerifier',
                }),
              ]),
            },
          },
        } } } },
      });
      expect(JSON.stringify(h.invocations[0]?.metadataJson)).not.toContain(nativeThread);
      expect(h.nativeSessionDiagnosticContexts[0]).toMatchObject({
        state: 'linked',
        correlation: { requestId: traceId, operation: 'mcp.nativeSessionVerifier' },
      });
      expect(h.nativeVerifierSampling).toEqual([[
        'native-session-verifier-deadline',
        {
          pid: process.pid,
          requestFingerprint: createHash('sha256').update(traceId, 'utf8').digest('hex').slice(0, 16),
        },
      ]]);
    } finally {
      waitingTicket.release();
      heldTicket.release();
      resetAcquireRegistryForTest();
    }
  });

  it('does not accept deadline-shaped fields on an ordinary verifier error as acquisition measurements', async () => {
    const nativeThread = 'native-shaped-error-session';
    h.nativeSessionVerifierFailure = {
      sessionId: nativeThread,
      error: Object.assign(new Error('verification unavailable'), {
        name: 'DbCallDeadlineError',
        label: 'unmeasured-label',
        pool: 'org-admin',
        deadlineMs: 1_000,
        elapsedMs: 1_771,
        retryable: true,
      }),
    };
    const meta = { threadId: nativeThread };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner') as Record<string, unknown>),
      _meta: meta,
    };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);

    expect(res.isError).toBe(true);
    expect(seen).toHaveLength(0);
    const metadata = h.invocations[0]?.metadataJson as {
      mcpAuthFailure?: { nativeSession?: { verifierFailure?: Record<string, unknown> } };
    };
    expect(metadata.mcpAuthFailure?.nativeSession?.verifierFailure).not.toHaveProperty('acquisition');
    expect(h.nativeVerifierSampling).toHaveLength(0);
  });

  it.each([
    ['statement timeout', 'canceling statement due to statement timeout', true],
    ['caller cancellation', 'canceling statement due to user request', false],
  ] as const)('fingerprints native verifier SQLSTATE 57014 failures and samples only %s', async (_case, message, shouldSample) => {
    const nativeThread = 'native-query-timeout-session';
    const traceId = '8bc88a29-a84c-4c90-a10e-620e682fd841';
    const requestFingerprint = createHash('sha256').update(traceId, 'utf8').digest('hex').slice(0, 16);
    h.nativeSessionVerifierFailure = {
      sessionId: nativeThread,
      error: Object.assign(new Error(message), {
        name: 'PostgresError',
        code: '57014',
        nativeSessionVerificationPhase: 'owner_candidate_rows_lookup',
      }),
    };
    const meta = { threadId: nativeThread };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner', {
        'x-papercusp-native-session': 'native-inherited-session',
        [MCP_REQUEST_TRACE_HEADER]: traceId,
      }) as Record<string, unknown>),
      _meta: meta,
    };

    const res = await callTool('gatingtest:scoped', {}, extra, meta);

    expect(res.isError).toBe(true);
    expect(h.nativeVerifierSampling).toEqual(shouldSample ? [[
      'native-session-verifier-statement-timeout',
      { pid: process.pid, requestFingerprint },
    ]] : []);
    expect(h.invocations[0]).toMatchObject({
      metadataJson: {
        mcpAuthFailure: {
          nativeSession: {
            verifierFailure: { name: 'PostgresError', code: '57014', requestFingerprint },
          },
        },
      },
    });
  });

  it('redacts identifiers and connection URLs in typed native verifier deadline fields', async () => {
    const { DbCallDeadlineError } = await import('@papercusp/db-org');
    const nativeThread = 'native-redacted-deadline-session';
    const connection = 'postgresql://secret:credential@localhost/database';
    const deadline = new DbCallDeadlineError(`${nativeThread} su-owner ${connection}`, 1_000, 1_771, nativeThread);
    h.nativeSessionVerifierFailure = { sessionId: nativeThread, error: deadline };
    const meta = { threadId: nativeThread };
    const extra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner') as Record<string, unknown>),
      _meta: meta,
    };

    const res = await callTool('gatingtest:scoped', {}, extra, meta);

    expect(res.isError).toBe(true);
    expect(seen).toHaveLength(0);
    expect(h.invocations[0]).toMatchObject({
      metadataJson: { mcpAuthFailure: { nativeSession: { verifierFailure: {
        acquisition: {
          label: '[redacted] [redacted] [redacted-connection]',
          pool: '[redacted]',
          deadlineMs: 1_000,
          elapsedMs: 1_771,
        },
      } } } },
    });
    const recorded = JSON.stringify(h.invocations[0]?.metadataJson);
    for (const sensitive of [nativeThread, 'su-owner', connection, 'secret', 'credential']) {
      expect(recorded).not.toContain(sensitive);
    }
  });

  it('rejects an inherited owner SID when the native CLI session is bound elsewhere', async () => {
    h.nativeSessionBinding = 'foreign';
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&workspace=ws-test&client=su-parent-sid', {
        'x-papercusp-native-session': 'native-child-session',
      }),
    );
    expect(res.isError).toBe(true);
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-parent-sid', sessionId: 'native-child-session' }]);
    expect(seen).toHaveLength(0);
    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]).toMatchObject({
      status: 'error',
      errorCode: 'mcp_auth_failed',
      errorMessage: 'superuser_foreign_native_session',
      metadataJson: {
        mcpAuthFailure: {
          reason: 'superuser_foreign_native_session',
          contextVerified: false,
          nativeSession: {
            carrier: 'header:x-papercusp-native-session',
            valueFingerprint: createHash('sha256').update('native-child-session', 'utf8').digest('hex'),
            candidateAdvSessionId: 1,
          },
        },
      },
    });
    expect(h.invocations[0]?.args).toBeUndefined();
    expect(JSON.stringify(h.invocations[0]?.metadataJson)).not.toContain('native-child-session');
  });

  it('records the native-session URL carrier without persisting its value', async () => {
    h.nativeSessionBinding = 'foreign';
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&workspace=ws-test&client=su-parent-sid&native_session=native-child-session'),
    );
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe('request_rejected: superuser_foreign_native_session');
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-parent-sid', sessionId: 'native-child-session' }]);
    expect(seen).toHaveLength(0);
    expect(h.invocations).toHaveLength(1);
    expect(h.invocations[0]?.metadataJson).toMatchObject({
      mcpAuthFailure: {
        reason: 'superuser_foreign_native_session',
        contextVerified: false,
        nativeSession: {
          carrier: 'query:native_session',
          valueFingerprint: createHash('sha256').update('native-child-session', 'utf8').digest('hex'),
          candidateAdvSessionId: 1,
        },
      },
    });
    expect(JSON.stringify(h.invocations[0]?.metadataJson)).not.toContain('native-child-session');
  });

  it('allows the owner incarnation when Claude supplies its native session in the URL', async () => {
    h.nativeSessionBinding = 'bound';
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&client=su-owner&native_session=native-owner-session'),
    );
    expect(res.isError).toBeUndefined();
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-owner', sessionId: 'native-owner-session' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx.uiClientId).toBe('su-owner');
    expect(seen[0].ctx.advSessionId).toBe(1);
  });

  it('allows the owner incarnation when Codex supplies its native session in the header', async () => {
    h.nativeSessionBinding = 'bound';
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('&client=su-owner', {
        'x-papercusp-native-session': 'native-owner-session',
      }),
    );
    expect(res.isError).toBeUndefined();
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-owner', sessionId: 'native-owner-session' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx.uiClientId).toBe('su-owner');
    expect(seen[0].ctx.advSessionId).toBe(1);
  });

  it('Mcp-Session-Id still identifies a caller that supplied NO SID at all', async () => {
    const res = await callTool(
      'gatingtest:scoped',
      {},
      superuserExtra('', { 'mcp-session-id': 'transport-only-id' }),
    );
    expect(res.isError).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx.uiClientId).toBe('transport-only-id');
  });
});

describe('successful native-session audit (get-feedback D-006)', () => {
  function bindNativeOwnerSession(native: string): void {
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: native, active: true }]]]);
    // Native-owner dispatch requires a concrete workspace and its persisted
    // adv_sessions authority row for either supported correlation carrier.
    h.kernelAuthority.rows = [{
      control_state: null,
      control_generation: null,
      workspace_id: 'ws-test',
      adv_session_id: 541,
      adv_session_xmin: 'native-test-row-version',
      launch_header_known: false,
      launch_spec_type: 'object',
      launch_spec_workspace_id: 'ws-test',
      launch_spec_harness_slug: 'papercup',
      launch_spec_has_accepted_operation: false,
      launch_spec_accepted_operation: null,
    }];
    h.kernelAuthority.launchRecord = {
      launch_spec: { workspaceId: 'ws-test', harnessSlug: 'papercup' },
      launch_spec_xmin: 'native-test-row-version',
    };
  }

  it.each([
    ['wildcard workspace', { spawn: { workspaceId: '*' }, native: {} }],
    ['mismatched adv-session id', { spawn: {}, native: { candidateAdvSessionId: 542 } }],
    ['invalid adv-session id', { spawn: { advSessionId: 0 }, native: {} }],
    ['malformed call fingerprint', { spawn: {}, native: { callIdFingerprint: 'not-a-sha256' } }],
    ['malformed session fingerprint', { spawn: {}, native: { valueFingerprint: 'not-a-sha256' } }],
  ])('isolates native_tool_owner_invalid_lineage for a %s', async (_case, over) => {
    const local = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'local-dispatch' }] }));
    const { spawn: spawnOver, native: nativeOver } = over;
    const request = {
      toolName: 'gatingtest:scoped',
      args: {},
      spawn: {
        workspaceId: 'ws-test',
        advSessionId: 541,
        uiClientId: 'su-owner',
        ...spawnOver,
        requestOrigin: { nativeSession: {
          carrier: 'meta:threadId',
          binding: 'bound',
          candidateAdvSessionId: 541,
          callIdFingerprint: 'a'.repeat(64),
          valueFingerprint: 'b'.repeat(64),
          ...nativeOver,
        } },
      } as unknown as BuiltSpawnContext,
      fullSource: false,
      structuredSource: false,
      indirect: false,
    };

    await expect(runNativeMcpTargetOnOwner(request, local, 1_000))
      .rejects.toThrow('native_tool_owner_invalid_lineage');
    expect(local).not.toHaveBeenCalled();
  });

  it('retains exact native call correlation only with a bound per-call thread', async () => {
    const native = 'native-owner-session', callId = 'call_exact-native-item';
    bindNativeOwnerSession(native);
    const meta = { threadId: native, callId };
    const extra = { ...(superuserExtra('&workspace=ws-test&client=su-owner') as Record<string, unknown>), _meta: meta };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError, textOf(res)).toBeUndefined();
    expect(h.nativeSessionWorkspaceScopes).toEqual(['ws-test']);
    expect(h.invocations[0]?.ctx.requestOrigin).toMatchObject({ nativeSession: {
      carrier: 'meta:threadId', binding: 'bound', candidateAdvSessionId: 541,
      callIdFingerprint: createHash('sha256').update(callId, 'utf8').digest('hex'),
    } });
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toContain(callId);
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toContain(native);
  });

  it('retains Claude native call correlation as diagnostics on its verified header carrier', async () => {
    const native = 'native-owner-session', callId = 'toolu_claude-native-item';
    bindNativeOwnerSession(native);
    const meta = { 'claudecode/toolUseId': callId };
    const extra = { ...(superuserExtra('&workspace=ws-test&client=su-owner', { 'x-papercusp-native-session': native }) as Record<string, unknown>), _meta: meta };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError, textOf(res)).toBeUndefined();
    expect(h.nativeSessionWorkspaceScopes).toEqual(['ws-test']);
    expect(h.invocations[0]?.ctx.advSessionId).toBe(541);
    expect(h.invocations[0]?.ctx.requestOrigin).toMatchObject({ nativeSession: {
      carrier: 'header:x-papercusp-native-session', binding: 'bound', candidateAdvSessionId: 541,
      callIdFingerprint: createHash('sha256').update(callId, 'utf8').digest('hex'),
    } });
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toContain(callId);
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toContain(native);
    expect(h.invocations[0]?.ctx.principal).toEqual({
      kind: 'system', slug: 'system:operator', workspaceId: 'ws-test',
      authMethod: 'bearer-token', trust: 'trusted', capabilities: new Set(),
    });
  });

  it.each([undefined, '', ' leading-space', 'trailing-space ', 'a/b', 'x'.repeat(257), 7, { callId: 'nested' }])(
    'omits malformed Claude native call correlation %j', async callId => {
      const native = 'native-owner-session';
      h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: native, active: true }]]]);
      const meta = { 'claudecode/toolUseId': callId };
      const extra = { ...(superuserExtra('&client=su-owner', { 'x-papercusp-native-session': native }) as Record<string, unknown>), _meta: meta };
      const res = await callTool('gatingtest:scoped', {}, extra, meta);
      expect(res.isError, textOf(res)).toBeUndefined();
      expect(h.invocations[0]?.ctx.requestOrigin?.nativeSession).not.toHaveProperty('callIdFingerprint');
    },
  );

  it.each(['unbound', 'query', 'thread'] as const)('cannot borrow Claude native call correlation from a %s carrier', async kind => {
    const native = 'native-owner-session';
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: kind === 'unbound' ? null : native, active: true }]]]);
    const meta = { 'claudecode/toolUseId': 'toolu_unproven', ...(kind === 'thread' ? { threadId: native } : {}) };
    const extra = { ...(superuserExtra('&client=su-owner' + (kind === 'query' ? `&native_session=${native}` : ''),
      kind === 'query' ? {} : { 'x-papercusp-native-session': native }) as Record<string, unknown>), _meta: meta };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError, textOf(res)).toBeUndefined();
    expect(h.invocations[0]?.ctx.requestOrigin?.nativeSession).not.toHaveProperty('callIdFingerprint');
  });

  it.each([undefined, '', ' leading-space', 'trailing-space ', 'a/b', 'x'.repeat(257), 7, { callId: 'nested' }])(
    'omits malformed native call correlation %j without changing ordinary authorization', async (callId) => {
      const native = 'native-owner-session';
      h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: native, active: true }]]]);
      const meta = { threadId: native, callId };
      const extra = { ...(superuserExtra('&client=su-owner') as Record<string, unknown>), _meta: meta };
      const res = await callTool('gatingtest:scoped', {}, extra, meta);
      expect(res.isError, textOf(res)).toBeUndefined();
      expect(h.invocations[0]?.ctx.requestOrigin?.nativeSession).not.toHaveProperty('callIdFingerprint');
    },
  );

  it.each(['header', 'unbound'])('cannot borrow native call correlation from a %s session carrier', async (kind) => {
    const native = 'native-owner-session';
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: kind === 'unbound' ? null : native, active: true }]]]);
    const meta = { ...(kind === 'unbound' ? { threadId: native } : {}), callId: 'call_unproven' };
    const extra = { ...(superuserExtra('&client=su-owner', { 'x-papercusp-native-session': native }) as Record<string, unknown>), _meta: meta };
    const res = await callTool('gatingtest:scoped', {}, extra, meta);
    expect(res.isError, textOf(res)).toBeUndefined();
    expect(h.invocations[0]?.ctx.requestOrigin?.nativeSession).not.toHaveProperty('callIdFingerprint');
  });

  it.each([
    { carrier: 'header:x-papercusp-native-session', query: '&client=su-owner', headers: { 'x-papercusp-native-session': 'native-owner-session' } },
    { carrier: 'query:native_session', query: '&client=su-owner&native_session=native-owner-session', headers: {} as Record<string, string> },
  ])('persists the $carrier fingerprint and bound row on the invocation context', async ({ carrier, query, headers }) => {
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: 'native-owner-session', active: true }]]]);
    const res = await callTool('gatingtest:scoped', {}, superuserExtra(query, headers));
    expect(res.isError, textOf(res)).toBeUndefined();
    const invocation = h.invocations.find(row => row.toolName === 'gatingtest:scoped');
    expect(invocation?.ctx.requestOrigin).toMatchObject({
      nativeSession: {
        carrier,
        valueFingerprint: createHash('sha256').update('native-owner-session', 'utf8').digest('hex'),
        binding: 'bound',
        candidateAdvSessionId: 541,
      },
    });
    expect(JSON.stringify(invocation?.ctx.requestOrigin)).not.toContain('native-owner-session');
  });

  it('distinguishes an unbound presentation from an omitted native carrier without changing dispatch', async () => {
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: null, active: true }]]]);
    const presented = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-owner&native_session=unbound-value'));
    expect(presented.isError, textOf(presented)).toBeUndefined();
    expect(seen[0].ctx.advSessionId).toBeUndefined();
    expect(h.invocations[0]?.ctx.requestOrigin).toMatchObject({
      nativeSession: {
        carrier: 'query:native_session',
        valueFingerprint: createHash('sha256').update('unbound-value', 'utf8').digest('hex'),
        binding: 'unbound',
        candidateAdvSessionId: 541,
      },
    });
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toContain('unbound-value');
    const omitted = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-owner'));
    expect(omitted.isError, textOf(omitted)).toBeUndefined();
    expect(h.invocations[1]?.ctx.requestOrigin).not.toHaveProperty('nativeSession');
  });

  it('audits the winning header when both native carriers are supplied', async () => {
    h.nativeSessionRows = new Map([['su-owner', [{ id: 541, session_id: 'native-header', active: true }]]]);
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-owner&native_session=native-query', {
      'x-papercusp-native-session': 'native-header',
    }));
    expect(res.isError, textOf(res)).toBeUndefined();
    expect(h.nativeSessionCalls).toEqual([{ ownerId: 'su-owner', sessionId: 'native-header' }]);
    expect(h.invocations[0]?.ctx.requestOrigin).toMatchObject({ nativeSession: {
      carrier: 'header:x-papercusp-native-session',
      valueFingerprint: createHash('sha256').update('native-header', 'utf8').digest('hex'),
      binding: 'bound',
      candidateAdvSessionId: 541,
    } });
    expect(JSON.stringify(h.invocations[0]?.ctx.requestOrigin)).not.toMatch(/native-header|native-query/);
  });

  it('refuses a stale same-owner native session after a carry starts its successor', async () => {
    const predecessor = 'native-carry-predecessor';
    const successor = 'native-carry-successor';
    h.nativeSessionRows = new Map([['su-owner', [
      { id: 541, session_id: predecessor, active: true },
      { id: 543, session_id: successor, active: true },
    ]]]);
    h.kernelAuthority.rows = [{
      control_state: null,
      control_generation: null,
      workspace_id: 'ws-test',
      adv_session_id: 543,
      adv_session_xmin: 'native-successor-row-version',
      launch_header_known: false,
      launch_spec_type: 'object',
      launch_spec_workspace_id: 'ws-test',
      launch_spec_harness_slug: 'papercup',
      launch_spec_has_accepted_operation: false,
      launch_spec_accepted_operation: null,
    }];
    h.kernelAuthority.launchRecord = {
      launch_spec: { workspaceId: 'ws-test', harnessSlug: 'papercup' },
      launch_spec_xmin: 'native-successor-row-version',
    };
    h.livePtyHost = {
      ownerId: 'su-owner', advSessionId: '543', pid: 1234, ptyPid: 5678,
      sock: '/tmp/current-host.sock', command: 'codex', startedAt: 1,
      nativeSessionId: successor,
    };

    const staleMeta = { threadId: predecessor, callId: 'call_stale-carry-predecessor' };
    const staleExtra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner') as Record<string, unknown>),
      _meta: staleMeta,
    };
    const stale = await callTool('gatingtest:scoped', {}, staleExtra, staleMeta);
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toBe('request_rejected: superuser_foreign_native_session');
    expect(seen).toHaveLength(0);

    const currentMeta = { threadId: successor, callId: 'call_current-carry-successor' };
    const currentExtra = {
      ...(superuserExtra('&workspace=ws-test&client=su-owner') as Record<string, unknown>),
      _meta: currentMeta,
    };
    const current = await callTool('gatingtest:scoped', {}, currentExtra, currentMeta);
    expect(current.isError, textOf(current)).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it('records caller consistency without claiming physical actor proof for a different connection', async () => {
    h.nativeSessionRows = new Map([['su-owner', [{ id: 543, session_id: 'native-owner-continuation', active: true }]]]);
    const res = await callTool('gatingtest:scoped', {}, superuserExtra('&client=su-owner&native_session=native-owner-continuation', {
      'mcp-session-id': 'different-answerer-connection',
    }));
    expect(res.isError, textOf(res)).toBeUndefined();
    expect(seen[0].ctx).toMatchObject({ uiClientId: 'su-owner', advSessionId: 543 });
    expect(h.invocations[0]?.ctx.requestOrigin).toMatchObject({ nativeSession: {
      binding: 'bound',
      candidateAdvSessionId: 543,
    } });
    expect(h.invocations[0]?.ctx.requestOrigin).not.toHaveProperty('nativeSession.physicalActorVerified');
  });
});

describe('isolated consult native identity guard (get-feedback D-006)', () => {
  it.each([
    { sourceBackend: 'claude', targetBackend: 'claude', operation: 'fork' },
    { sourceBackend: 'claude', targetBackend: 'codex', operation: 'convert' },
    { sourceBackend: 'codex', targetBackend: 'claude', operation: 'convert' },
    { sourceBackend: 'codex', targetBackend: 'codex', operation: 'convert' },
  ])('$sourceBackend → $targetBackend $operation rejects source identity before dispatch while both owners remain usable', async ({ sourceBackend, targetBackend }) => {
    const sourceOwner = 'su-consult-source';
    const answeringOwner = 'su-consult-answerer';
    const sourceNative = 'native-consult-source';
    const sourceContinuation = 'native-consult-source-continuation';
    const answeringNative = 'native-consult-answerer';
    // Use the production row classifier, not a preselected "foreign" verdict.
    // The transport must bind each call to its owner's actual native row.
    h.nativeSessionRows = new Map([
      [sourceOwner, [
        { id: 543, session_id: sourceContinuation, active: true },
        { id: 541, session_id: sourceNative, active: true },
      ]],
      [answeringOwner, [{ id: 542, session_id: answeringNative, active: true }]],
    ]);
    // Reuse the suite's ungoverned launch-row fixture for concrete-workspace
    // Codex calls. This verifies transport attribution, not identity grants.
    const caller = (owner: string, native: string, backend: string) => {
      const extra = superuserExtra(
        `&client=${owner}${backend === 'claude' ? `&native_session=${native}` : '&workspace=ws-test'}`,
        backend === 'codex' ? { 'x-papercusp-native-session': native } : {},
      );
      if (backend !== 'codex') return { extra, meta: undefined };
      const id = native === answeringNative ? 542 : native === sourceContinuation ? 543 : 541;
      h.kernelAuthority.rows = [{
        control_state: null, control_generation: null, workspace_id: 'ws-test',
        adv_session_id: id, adv_session_xmin: `consult-row-${id}`,
        launch_header_known: false, launch_spec_type: 'object',
        launch_spec_workspace_id: 'ws-test', launch_spec_harness_slug: 'papercup',
        launch_spec_has_accepted_operation: false, launch_spec_accepted_operation: null,
      }];
      h.kernelAuthority.launchRecord = {
        launch_spec: { workspaceId: 'ws-test', harnessSlug: 'papercup' },
        launch_spec_xmin: `consult-row-${id}`,
      };
      const meta = { threadId: native, callId: `call_consult-${native}` };
      return { extra: { ...(extra as Record<string, unknown>), _meta: meta }, meta };
    };
    const callAs = (owner: string, native: string, backend: string) => {
      const { extra, meta } = caller(owner, native, backend);
      return callTool('gatingtest:scoped', {}, extra, meta);
    };

    // Independent source work is valid even during a consult window.
    const sourceCall = await callAs(sourceOwner, sourceNative, sourceBackend);
    expect(sourceCall.isError, textOf(sourceCall)).toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0].ctx).toMatchObject({ uiClientId: sourceOwner, advSessionId: 541 });

    // Every legitimate source incarnation remains usable; attribution cannot
    // assume the newest row is the only native session belonging to the owner.
    const continuationCall = await callAs(sourceOwner, sourceContinuation, sourceBackend);
    expect(continuationCall.isError, textOf(continuationCall)).toBeUndefined();
    expect(seen).toHaveLength(2);
    expect(seen[1].ctx).toMatchObject({ uiClientId: sourceOwner, advSessionId: 543 });

    // A claim followed by a release could leave identical census endpoints.
    // Neither nested call may reach even the existing dispatcher witness when
    // the answerer's native session presents the source's coordination SID.
    for (const action of ['claim', 'release']) {
      const meta = targetBackend === 'codex'
        ? { threadId: answeringNative, callId: `call_spoof-${action}` }
        : undefined;
      const extra = superuserExtra(
        `&workspace=ws-test&client=${sourceOwner}&native_session=${targetBackend === 'codex' ? sourceContinuation : answeringNative}`,
        // The inherited process header is legitimately source-owned. Codex's
        // actual per-call thread must still win and reject the answering actor.
        targetBackend === 'codex' ? { 'x-papercusp-native-session': sourceContinuation } : {},
      );
      const attempted = await callTool(
        'tools:invoke',
        { name: 'gatingtest:scoped', args: { action, id: 'WI-source-claim' } },
        // Auth-failure telemetry records only an explicitly claimed workspace.
        // Rejection precedes the kernel lookup, so this adds no fake launch row.
        meta ? { ...(extra as Record<string, unknown>), _meta: meta } : extra,
        meta,
      );
      expect(attempted.isError).toBe(true);
      expect(textOf(attempted)).toBe('request_rejected: superuser_foreign_native_session');
      expect(seen).toHaveLength(2);
      expect(h.invocations.at(-1)).toMatchObject({
        status: 'error',
        errorCode: 'mcp_auth_failed',
        errorMessage: 'superuser_foreign_native_session',
        metadataJson: { mcpAuthFailure: { nativeSession: { candidateAdvSessionId: 543 } } },
      });
    }

    // Endpoint equality must not cause a guard to freeze legitimate source
    // work. A source-owned port/continuation remains usable after the spoof.
    const continued = await callAs(sourceOwner, sourceContinuation, sourceBackend);
    expect(continued.isError, textOf(continued)).toBeUndefined();
    expect(seen).toHaveLength(3);
    expect(seen[2].ctx).toMatchObject({ uiClientId: sourceOwner, advSessionId: 543 });

    const answerCall = await callAs(answeringOwner, answeringNative, targetBackend);
    expect(answerCall.isError, textOf(answerCall)).toBeUndefined();
    expect(seen).toHaveLength(4);
    expect(seen[3].ctx).toMatchObject({ uiClientId: answeringOwner, advSessionId: 542 });
    if (targetBackend === 'codex') {
      expect(h.invocations.at(-1)?.ctx.requestOrigin).toMatchObject({ nativeSession: {
        carrier: 'meta:threadId', binding: 'bound', candidateAdvSessionId: 542,
        valueFingerprint: createHash('sha256').update(answeringNative).digest('hex'),
        callIdFingerprint: createHash('sha256').update(`call_consult-${answeringNative}`).digest('hex'),
      } });
    }
    expect(h.nativeSessionCalls).toEqual([
      { ownerId: sourceOwner, sessionId: sourceNative },
      { ownerId: sourceOwner, sessionId: sourceContinuation },
      { ownerId: sourceOwner, sessionId: answeringNative },
      { ownerId: sourceOwner, sessionId: answeringNative },
      { ownerId: sourceOwner, sessionId: sourceContinuation },
      { ownerId: answeringOwner, sessionId: answeringNative },
    ]);
  });
});
