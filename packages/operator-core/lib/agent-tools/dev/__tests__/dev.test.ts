/**
 * dev:* tools — 12 tools backing the /dev page.
 *
 * Each tool is a thin projection of a function in lib/dev-data.ts (or
 * lib/omp-sessions.ts for dev:omp_session). Tests mock the underlying
 * lib function and assert the tool's payload shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MAKE_CTX = (over: Record<string, unknown> = {}) =>
  ({
    log: vi.fn(),
    signal: new AbortController().signal,
    progress: vi.fn(),
    workspaceId: 'default',
    harnessSlug: 'sheets',
    role: 'architect' as const,
    runId: 'r',
    spawnId: 's',
    ...over,
  } as never);

function parsePayload(result: { data?: Record<string, unknown>; content?: Array<{ text: string }> }): Record<string, unknown> {
  if (result.data) return result.data;
  return JSON.parse(result.content![0].text);
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../../../dev-data');
  vi.doUnmock('../../../omp-sessions');
  vi.doUnmock('../../../why-chain');
});

// ── dev:activity ────────────────────────────────────────────────────

describe('dev:activity', () => {
  it('returns count + entries from activityFeed', async () => {
    const entries = [
      { id: '1', workspace_id: 'default', harness_slug: 'sheets', tool_name: 'foo', role: null, spawn_id: null, invoked_at: 'now', duration_ms: 10, status: 'ok', error_message: null },
    ];
    vi.doMock('../../../dev-data', () => ({ activityFeed: vi.fn(async () => ({ entries })) }));
    const { default: tool } = await import('../activity');
    const result = await tool.handler({ limit: 50 }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, entries });
  });

  it('passes workspaceIds=null when omitted', async () => {
    const mock = vi.fn(async () => ({ entries: [] }));
    vi.doMock('../../../dev-data', () => ({ activityFeed: mock }));
    const { default: tool } = await import('../activity');
    await tool.handler({}, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith({ workspaceIds: null, limit: undefined });
  });
});

// ── dev:audit ───────────────────────────────────────────────────────

describe('dev:audit', () => {
  it('returns count + entries from auditFeed', async () => {
    const entries = [{ id: 'a1', ts: 1, workspace_id: 'default', actor: 'u', action: 'x', subject: 's', details: {} }];
    vi.doMock('../../../dev-data', () => ({ auditFeed: vi.fn(async () => ({ entries })) }));
    const { default: tool } = await import('../audit');
    const result = await tool.handler({ hours: 24 }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, entries });
  });
});

// ── dev:build_status ────────────────────────────────────────────────

describe('dev:build_status', () => {
  it('passes through buildStatus output', async () => {
    const data = {
      prodBuild: { exists: true, mtimeMs: 1000 },
      devBuild: { exists: true, mtimeMs: 1000 },
      prodLogTail: null,
      dev3055Reachable: true,
      prod3070Reachable: true,
      dev3055ApiReachable: true,
      awaitable: {
        hint: 'Waiting on a build/deploy? Don\'t re-poll — events:await the deploy or the gate (or use deploy:await / checkpoint:await), then END YOUR TURN. Full list: events:catalog.',
        events: ['release:deployed', 'release:green'],
        sugar: ['deploy:await', 'checkpoint:await'],
      },
    };
    // build_status also folds a best-effort flake-suspect scan (EI-7443): it
    // calls testFlakeRollup + flagFlakeSuspects from dev-data. Stub both so the
    // handler doesn't hit its catch → console.warn (which fails the gate under
    // vitest-fail-on-console), and expect the additive `flake_suspects` key.
    vi.doMock('../../../dev-data', () => ({
      buildStatus: vi.fn(async () => data),
      testFlakeRollup: vi.fn(async () => ({ entries: [] })),
      flagFlakeSuspects: vi.fn(() => []),
    }));
    const { default: tool } = await import('../build_status');
    const result = await tool.handler({}, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ ...data, flake_suspects: [] });
  });

  it('accepts an ambient harness argument without narrowing the cross-workspace feed', async () => {
    const data = {
      prodBuild: { exists: true, mtimeMs: 1000 },
      devBuild: { exists: true, mtimeMs: 1000 },
      prodLogTail: null,
      dev3055Reachable: true,
      prod3070Reachable: true,
      dev3055ApiReachable: true,
    };
    vi.doMock('../../../dev-data', () => ({
      buildStatus: vi.fn(async () => data),
      testFlakeRollup: vi.fn(async () => ({ entries: [] })),
      flagFlakeSuspects: vi.fn(() => []),
    }));
    const { default: tool } = await import('../build_status');
    const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/tooldef');
    const projected = lookupByMcpName('dev:build_status');
    expect(projected).toBeDefined();

    const result = await dispatchProjectedTool(
      projected!,
      'dev:build_status',
      { harness: 'papercusp' },
      MAKE_CTX({ emit: vi.fn() }),
      {},
    );

    expect(result.ok).toBe(true);
    expect(parsePayload(result.result as never)).toMatchObject({ ...data, flake_suspects: [] });
  });

  it('bounds oversized default output and exposes a full-detail re-read path', async () => {
    const suspects = Array.from({ length: 40 }, (_, i) => ({
      file_path: `${'very/long/path/'.repeat(30)}${i}.test.ts`,
      fails: 20 + i,
      passes: 40,
      both_status_shas: 4,
      flake_rate: 0.333,
      last_fail: '2026-08-13T00:00:00.000Z',
      last_pass: '2026-08-13T01:00:00.000Z',
      reason: 'flake-shaped '.repeat(300),
    }));
    const data = {
      prodBuild: { exists: true, mtimeMs: 1000 },
      devBuild: { exists: true, mtimeMs: 1000 },
      prodLogTail: 'build output '.repeat(1000),
      dev3055Reachable: true,
      prod3070Reachable: true,
      dev3055ApiReachable: true,
    };
    vi.doMock('../../../dev-data', () => ({
      buildStatus: vi.fn(async () => data),
      testFlakeRollup: vi.fn(async () => ({ entries: [] })),
      flagFlakeSuspects: vi.fn(() => suspects),
    }));
    const { default: tool, BUILD_STATUS_RESPONSE_BUDGET_CHARS } = await import('../build_status');

    const result = await tool.handler({ harness: 'papercusp' }, MAKE_CTX());
    const payload = parsePayload(result as never);
    expect(JSON.stringify(payload).length).toBeLessThanOrEqual(BUILD_STATUS_RESPONSE_BUDGET_CHARS);
    expect(payload.projection).toMatchObject({
      kind: 'bounded',
      truncated: true,
      fullRead: { tool: 'dev:build_status', args: { harness: 'papercusp', detail: 'full' } },
    });
    expect(payload.prodLogTail_truncated).toBe(true);
    expect(payload.prodLogTail_full_chars).toBe(data.prodLogTail.length);
    expect(payload.dev3055ApiReachable).toBe(true);
    expect(payload.flake_suspects_truncated).toBe(true);
    expect(payload.flake_suspects_total).toBe(suspects.length);
    expect((payload.flake_suspects as unknown[]).length).toBeLessThan(suspects.length);

    const full = await tool.handler({ harness: 'papercusp', detail: 'full' }, MAKE_CTX());
    expect(parsePayload(full as never)).toEqual({ ...data, flake_suspects: suspects, awaitable: expect.anything() });
  });
});

// ── dev:why ─────────────────────────────────────────────────────────

describe('dev:why', () => {
  it('returns the computed causal chain scoped from args/context', async () => {
    const data = {
      generatedAtMs: 123,
      stages: [{ stage: 'gate', status: 'blocked', reason: 'gate stalled' }],
      rootCause: { stage: 'gate', status: 'blocked', reason: 'gate stalled' },
      summary: 'ROOT CAUSE: gate — gate stalled',
      recentFailingFiles: ['packages/operator-core/lib/x.test.ts'],
    };
    const computeWhyChain = vi.fn(async () => data);
    vi.doMock('../../../why-chain', () => ({ computeWhyChain }));

    const { default: tool } = await import('../why');
    const result = await tool.handler({ workspace: 'ws-1' }, MAKE_CTX({ harnessSlug: 'papercusp' }));

    expect(computeWhyChain).toHaveBeenCalledWith({ workspaceId: 'ws-1', harnessSlug: 'papercusp' });
    expect(parsePayload(result as never)).toEqual(data);
  });
});

// ── dev:harnesses ───────────────────────────────────────────────────

describe('dev:harnesses', () => {
  it('returns count + harnesses with health', async () => {
    const harnesses = [
      { slug: 'sheets', path: '/x', workspaceId: 'default', workspaceName: 'Default', health: { ok: true } },
    ];
    vi.doMock('../../../dev-data', () => ({
      listAllHarnessesWithHealth: vi.fn(async () => ({ harnesses })),
    }));
    const { default: tool } = await import('../harnesses');
    const result = await tool.handler({}, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, harnesses });
  });

  it('passes workspaceIds when provided', async () => {
    const mock = vi.fn(async () => ({ harnesses: [] }));
    vi.doMock('../../../dev-data', () => ({ listAllHarnessesWithHealth: mock }));
    const { default: tool } = await import('../harnesses');
    await tool.handler({ workspaceIds: ['default', 'ws2'] }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith(['default', 'ws2']);
  });
});

// ── dev:omp_session ─────────────────────────────────────────────────

describe('dev:omp_session', () => {
  it('mode=find returns matched session', async () => {
    const match = {
      id: '019x',
      filePath: '/tmp/x.jsonl',
      cwd: '/tmp',
      timestamp: '2026-05-11T00:00:00Z',
      title: '',
      matchKind: 'time-only',
      timeDriftMs: 0,
    };
    vi.doMock('../../../omp-sessions', () => ({
      findOmpSessionForSpawn: vi.fn(async () => match),
      readOmpSession: vi.fn(),
    }));
    const { default: tool } = await import('../omp_session');
    const result = await tool.handler({ spawnId: 's', mode: 'find' }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual(match);
  });

  it('mode=find returns error envelope on miss', async () => {
    vi.doMock('../../../omp-sessions', () => ({
      findOmpSessionForSpawn: vi.fn(async () => null),
      readOmpSession: vi.fn(),
    }));
    const { default: tool } = await import('../omp_session');
    const result = await tool.handler({ spawnId: 'unknown', mode: 'find' }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ error: 'no match' });
  });

  it('mode=read returns header + turns', async () => {
    const read = { header: { type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/c' }, turns: [], totalLines: 1, truncated: false };
    vi.doMock('../../../omp-sessions', () => ({
      findOmpSessionForSpawn: vi.fn(),
      readOmpSession: vi.fn(() => read),
    }));
    const { default: tool } = await import('../omp_session');
    const result = await tool.handler({ filePath: '/tmp/x.jsonl', mode: 'read' }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual(read);
  });

  it('mode=read with spawnId resolves filePath via find', async () => {
    const find = vi.fn(async () => ({ filePath: '/tmp/x.jsonl' }));
    const read = vi.fn(() => ({ header: { type: 'session', version: 3, id: 'x', timestamp: 't', cwd: '/c' }, turns: [], totalLines: 0, truncated: false }));
    vi.doMock('../../../omp-sessions', () => ({ findOmpSessionForSpawn: find, readOmpSession: read }));
    const { default: tool } = await import('../omp_session');
    await tool.handler({ spawnId: 's', mode: 'read' }, MAKE_CTX());
    expect(find).toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith({ filePath: '/tmp/x.jsonl', limit: undefined });
  });
});

// ── dev:pg_health ───────────────────────────────────────────────────

describe('dev:pg_health', () => {
  it('returns pgHealth output', async () => {
    const data = { version: 'PostgreSQL 18', totalConnections: 5, activeConnections: 1, idleConnections: 4 };
    vi.doMock('../../../dev-data', () => ({ pgHealth: vi.fn(async () => data) }));
    const { default: tool } = await import('../pg_health');
    const payload = parsePayload((await tool.handler({}, MAKE_CTX())) as never) as Record<string, any>;
    expect(payload).toMatchObject(data);
    expect(payload.processDiagnostics).toMatchObject({
      source: 'current-process',
      pid: expect.any(Number),
      capturedAt: expect.any(String),
      coverage: 'completed-results-and-recent-failures-in-selected-pools-only',
      resultLimitPerPool: 4,
      pools: expect.arrayContaining([
        expect.objectContaining({ pool: 'org-app', observed: false }),
        expect.objectContaining({ pool: 'org-admin', observed: false }),
        expect.objectContaining({ pool: 'org-admin-lossless-bigint', observed: false }),
      ]),
    });
  });
});

// ── dev:pg_active_queries ───────────────────────────────────────────

describe('dev:pg_active_queries', () => {
  it('returns count + queries', async () => {
    const queries = [{ pid: 1, state: 'active', query: 'SELECT 1', duration_seconds: 0.1, application_name: 'psql', client_addr: '127.0.0.1' }];
    vi.doMock('../../../dev-data', () => ({ pgActiveQueries: vi.fn(async () => ({ queries })) }));
    const { default: tool } = await import('../pg_active_queries');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, queries });
  });
});

// ── dev:pg_table_sizes ──────────────────────────────────────────────

describe('dev:pg_table_sizes', () => {
  it('returns count + tables', async () => {
    const tables = [{ schema: 'harness_shared', table: 't', total_bytes: 1024, index_bytes: 128, rows_estimate: 10 }];
    vi.doMock('../../../dev-data', () => ({ pgTableSizes: vi.fn(async () => ({ tables })) }));
    const { default: tool } = await import('../pg_table_sizes');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, tables });
  });

  it('forwards schema arg', async () => {
    const mock = vi.fn(async () => ({ tables: [] }));
    vi.doMock('../../../dev-data', () => ({ pgTableSizes: mock }));
    const { default: tool } = await import('../pg_table_sizes');
    await tool.handler({ schema: 'public', limit: 5 }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith('public', 5);
  });
});

// ── dev:processes ───────────────────────────────────────────────────

describe('dev:processes', () => {
  it('returns count + processes', async () => {
    const processes = [
      {
        pid: 1,
        kind: 'omp',
        executable: 'omp',
        role: 'member',
        build: '0.1.0+abc123',
        started_at: '2026-08-27T04:00:00.000Z',
        cwd: '/x',
        started_seconds_ago: 1,
        harness_slug: null,
        workspace_id: null,
      },
    ];
    vi.doMock('../../../dev-data', () => ({ listProcesses: vi.fn(async () => ({ processes })) }));
    const { default: tool } = await import('../processes');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, processes });
  });

  it('forwards kinds filter', async () => {
    const mock = vi.fn(async () => ({ processes: [] }));
    vi.doMock('../../../dev-data', () => ({ listProcesses: mock }));
    const { default: tool } = await import('../processes');
    await tool.handler({ kinds: ['paperclip'] }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith({ kinds: ['paperclip'] });
  });

  // ── P-012 / D-009: the description must not out-claim the implementation ──
  //
  // listProcesses() drops every cmdline classified 'other', so this tool
  // structurally CANNOT answer "what is running on this host" (822 atoms,
  // 51.4% of the process/job family) or "is my job done" (vitest/tsc/gate).
  // It used to advertise itself as "the unified diagnostic view", which made
  // it the #1 tools:find hit for the whole-host inventory question it drops
  // on the floor. These guards fail if that over-claim comes back.

  it('discloses that it filters, so an empty result is never read as "nothing is running"', async () => {
    const { default: tool } = await import('../processes');
    const text = `${tool.description} ${tool.guidance?.when ?? ''} ${tool.guidance?.notWhen ?? ''}`;
    // Names the limitation explicitly...
    expect(text).toMatch(/not a general process list|NOT a general process list/i);
    expect(text).toMatch(/drop|filter/i);
    // ...and specifically warns against the empty-means-idle misreading.
    expect(tool.description).toMatch(/never "nothing is running"|no agent processes/i);
    // ...and never re-adopts the phrase that caused the false match.
    expect(text).not.toMatch(/unified diagnostic view/i);
  });

  it('redirects both superseded intents (whole-host inventory, and "is my job done")', async () => {
    const { default: tool } = await import('../processes');
    const notWhen = tool.guidance?.notWhen ?? '';
    // whole-host inventory -> plain ps/pgrep, which D-009 keeps as correct, never-gated bash
    expect(notWhen).toMatch(/\bps\b|pgrep/);
    // "is my job done" -> the job-handle surface (P-022), not a process scan
    expect(notWhen).toContain('capability:bash_output');
    // and the compaction trap that makes the native handle unsafe
    expect(notWhen).toContain('EI-16611');
  });

  it('keeps the advertised kind list in step with the real KIND_ENUM', async () => {
    // If someone widens the classifier + enum, the description must be widened
    // with it — otherwise the doc silently under-reports what is returned.
    // Pinned to the EXPORTED enum, not a copy, so it cannot pass vacuously.
    const { default: tool, KIND_ENUM } = await import('../processes');
    expect(KIND_ENUM.length).toBe(6);
    for (const kind of KIND_ENUM) {
      expect(tool.description).toContain(kind);
    }
    // 'other' is the dropped bucket — never a selectable kind.
    expect(KIND_ENUM as readonly string[]).not.toContain('other');
  });
});

// ── dev:session_detail ──────────────────────────────────────────────

describe('dev:session_detail', () => {
  it('returns detail when getSessionDetail succeeds', async () => {
    const detail = { spawn_id: 's', agent: null, invocations: [], children: [], related_chats: [] };
    vi.doMock('../../../dev-data', () => ({ getSessionDetail: vi.fn(async () => detail) }));
    const { default: tool } = await import('../session_detail');
    expect(parsePayload((await tool.handler({ spawnId: 's' }, MAKE_CTX())) as never)).toEqual(detail);
  });

  it('passes the native sessionId alias to the same detail resolver', async () => {
    const detail = { spawn_id: 'spawn', agent: null, invocations: [], children: [], related_chats: [] };
    const getSessionDetail = vi.fn(async () => detail);
    vi.doMock('../../../dev-data', () => ({ getSessionDetail }));
    const { default: tool } = await import('../session_detail');

    expect(parsePayload((await tool.handler({ sessionId: 'native-session' }, MAKE_CTX())) as never)).toEqual(detail);
    expect(getSessionDetail).toHaveBeenCalledWith('native-session');
  });

  it('returns error envelope when spawn not found', async () => {
    vi.doMock('../../../dev-data', () => ({ getSessionDetail: vi.fn(async () => null) }));
    const { default: tool } = await import('../session_detail');
    expect(parsePayload((await tool.handler({ spawnId: 'missing' }, MAKE_CTX())) as never)).toEqual({
      error: 'spawn not found',
    });
  });
});

// ── dev:sessions ────────────────────────────────────────────────────

describe('dev:sessions', () => {
  it('returns count + entries', async () => {
    const entries = [{ spawn_id: 's1', parent_spawn_id: null, workspace_id: 'default', harness_slug: null, role: null, run_id: null, coord_owner_id: 'su-abc', started_at: 'now', ended_at: 'now', tool_count: 1, error_count: 0, total_duration_ms: 100 }];
    vi.doMock('../../../dev-data', () => ({ listSessions: vi.fn(async () => ({ entries })) }));
    const { default: tool } = await import('../sessions');
    expect(parsePayload((await tool.handler({}, MAKE_CTX())) as never)).toEqual({ count: 1, entries });
  });
});

// ── dev:resolve_owner ───────────────────────────────────────────────

describe('dev:resolve_owner', () => {
  it('passes the ownerId through and returns the resolution payload', async () => {
    const resolution = {
      owner_id: 'su-5988767d',
      sessions: [
        {
          source: 'adv_sessions',
          owner_id: 'su-5988767d',
          session_id: 'fe9419e7-4430-4248-ab1a-b3ae0b8a1b1f',
          omp_thread_id: null,
          spawn_id: null,
          run_id: null,
          agent: 'claude',
          role: null,
          mode: 'console',
          harness_slug: null,
          plan_slug: null,
          cwd: '/x',
          status: null,
          started_at: 'then',
          ended_at: 'now',
        },
      ],
      activity: [],
    };
    const mock = vi.fn(async () => resolution);
    vi.doMock('../../../dev-data', () => ({ resolveOwnerSessions: mock }));
    const { default: tool } = await import('../resolve_owner');
    const result = await tool.handler({ ownerId: 'su-5988767d' }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith('su-5988767d');
    expect(parsePayload(result as never)).toEqual(resolution);
  });

  it('advertises an object result and preserves a large resolution in structuredContent', async () => {
    const resolution = {
      owner_id: 'su-ended',
      sessions: Array.from({ length: 50 }, (_, i) => ({
        source: i % 2 === 0 ? 'adv_sessions' : 'spawned_agents',
        owner_id: 'su-ended',
        session_id: `session-${i}`,
        omp_thread_id: i % 2 === 0 ? `omp-${i}` : null,
        spawn_id: i % 2 === 0 ? null : `spawn-${i}`,
        run_id: i % 2 === 0 ? null : `run-${i}`,
        agent: i % 2 === 0 ? 'codex' : null,
        role: 'debugger',
        mode: i % 2 === 0 ? 'console' : null,
        harness_slug: i % 2 === 0 ? null : 'papercusp',
        plan_slug: 'nonp2p-bug-drain-headless-0812',
        cwd: `/tmp/${'x'.repeat(220)}`,
        status: i % 2 === 0 ? null : 'done',
        started_at: '2026-08-12T09:00:00.000Z',
        ended_at: '2026-08-12T10:00:00.000Z',
      })),
      activity: Array.from({ length: 100 }, (_, i) => ({
        spawn_id: `spawn-${i}`,
        workspace_id: 'default',
        harness_slug: 'papercusp',
        tool_count: i + 1,
        error_count: i % 7 === 0 ? 1 : 0,
        started_at: '2026-08-12T09:00:00.000Z',
        ended_at: '2026-08-12T10:00:00.000Z',
      })),
    };
    vi.doMock('../../../dev-data', () => ({ resolveOwnerSessions: vi.fn(async () => resolution) }));
    await import('../resolve_owner');
    const { dispatchProjectedTool, lookupByMcpName } = await import('@papercusp/agent-mcp');
    const projected = lookupByMcpName('dev:resolve_owner');
    expect(projected).toBeDefined();

    const dispatched = await dispatchProjectedTool(
      projected!,
      'dev:resolve_owner',
      { ownerId: 'su-ended' },
      {
        log: vi.fn(),
        signal: new AbortController().signal,
        progress: vi.fn(),
        emit: vi.fn(),
        workspaceId: 'default',
        runId: 'resolve-owner-test',
        role: 'operator',
        gateBypass: { role: true, capability: true, quota: true },
        transport: 'mcp',
        requestedFormat: 'json',
        requestedStructured: true,
        tx: vi.fn(async () => []),
      },
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(projected!.outputJsonSchema?.type).toBe('object');
    expect(dispatched.result?.structuredContent).toMatchObject({ owner_id: 'su-ended' });
    const structured = dispatched.result?.structuredContent as typeof resolution;
    expect(structured.sessions).toHaveLength(50);
    expect(structured.activity).toHaveLength(100);
    expect(structured.sessions[49]?.cwd).toBe(`/tmp/${'x'.repeat(220)}`);
  });
});

// ── dev:telemetry ───────────────────────────────────────────────────

describe('dev:telemetry', () => {
  it('returns count + poll_suspects + entries', async () => {
    const entries = [{ tool_name: 'x', call_count: 5, error_count: 0, refused_count: 0, p50_ms: 10, p95_ms: 20, workspaces: ['default'] }];
    const observability = { initialized: false, observerFailures: 0, posthog: null, tracing: null };
    // Keep the REAL flagPollSuspects (EI-7029) — only the PG-backed rollup is mocked.
    vi.doMock('../../../dev-data', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../dev-data')>()),
      telemetryRollup: vi.fn(async () => ({ entries })),
    }));
    vi.doMock('../../../observability/runtime', () => ({
      runtimeObservabilityHealth: vi.fn(() => observability),
    }));
    const { default: tool } = await import('../telemetry');
    expect(parsePayload((await tool.handler({ hours: 24 }, MAKE_CTX())) as never)).toEqual({
      count: 1,
      // 5 calls/24h is nowhere near poll-shaped → the guard stays quiet.
      poll_suspects: [],
      observability,
      entries,
    });
  });

  it('flags a poll-shaped storm in poll_suspects (EI-7029)', async () => {
    const entries = [
      // 6000/24h from 5 callers = 250/hr aggregate, 50/hr per caller → poll-shaped.
      { tool_name: 'activity:recent', call_count: 6000, error_count: 0, refused_count: 0, p50_ms: 10, p95_ms: 20, total_bytes: 1000, avg_bytes: 1, repeat_within_spawn: 5990, distinct_callers: 5, workspaces: ['default'] },
    ];
    vi.doMock('../../../dev-data', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../../dev-data')>()),
      telemetryRollup: vi.fn(async () => ({ entries })),
    }));
    const { default: tool } = await import('../telemetry');
    const payload = parsePayload((await tool.handler({ hours: 24 }, MAKE_CTX())) as never) as {
      poll_suspects: Array<{ tool_name: string }>;
    };
    expect(payload.poll_suspects).toHaveLength(1);
    expect(payload.poll_suspects[0].tool_name).toBe('activity:recent');
  });
});

// ── dev:tool_cooccurrence ───────────────────────────────────────────

describe('dev:tool_cooccurrence', () => {
  it('returns count + total_turns + entries', async () => {
    const entries = [
      { tool_a: 'locks:acquire', tool_b: 'locks:release', support: 9, turns_a: 10, turns_b: 10, confidence: 0.9, lift: 9 },
    ];
    vi.doMock('../../../dev-data', () => ({ toolCooccurrence: vi.fn(async () => ({ totalTurns: 100, entries })) }));
    const { default: tool } = await import('../tool_cooccurrence');
    const result = await tool.handler({ hours: 24 }, MAKE_CTX());
    expect(parsePayload(result as never)).toEqual({ count: 1, total_turns: 100, entries });
  });

  it('forwards args with workspaceIds defaulted to null', async () => {
    const mock = vi.fn(async () => ({ totalTurns: 0, entries: [] }));
    vi.doMock('../../../dev-data', () => ({ toolCooccurrence: mock }));
    const { default: tool } = await import('../tool_cooccurrence');
    await tool.handler({ minSupport: 5, orderBy: 'lift' }, MAKE_CTX());
    expect(mock).toHaveBeenCalledWith({
      workspaceIds: null,
      hours: undefined,
      minSupport: 5,
      limit: undefined,
      orderBy: 'lift',
    });
  });
});
