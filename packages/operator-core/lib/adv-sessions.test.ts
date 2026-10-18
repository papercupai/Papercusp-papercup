import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbCallDeadlineError } from '@papercusp/db-org';

const {
  advSessionRowsMock,
  advSessionBeginMock,
  appSessionRowsMock,
  workspaceCalls,
  acquireTimeouts,
  acquireRetries,
} = vi.hoisted(() => {
  const sql = vi.fn(async () => [] as unknown[]);
  const begin = vi.fn(async (fn: (tx: typeof sql) => unknown) => fn(sql));
  const appSql = vi.fn(async () => [] as unknown[]);
  return {
    advSessionRowsMock: sql,
    advSessionBeginMock: begin,
    appSessionRowsMock: appSql,
    workspaceCalls: [] as Array<{
      workspaceId: string;
      options?: {
        readOnly?: boolean;
        acquireTimeoutMs?: number;
        acquireRetries?: number;
        statementTimeoutMs?: number;
        lockTimeoutMs?: number;
      };
    }>,
    acquireTimeouts: [] as Array<number | undefined>,
    acquireRetries: [] as Array<number | undefined>,
  };
});
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({ sql: Object.assign(advSessionRowsMock, { begin: advSessionBeginMock }) }),
    withWorkspace: (async (
      workspaceId: string,
      fn: (tx: unknown) => Promise<unknown>,
      options?: {
        readOnly?: boolean;
        acquireTimeoutMs?: number;
        acquireRetries?: number;
        statementTimeoutMs?: number;
        lockTimeoutMs?: number;
      },
    ) => {
      workspaceCalls.push({ workspaceId, options });
      return fn(appSessionRowsMock);
    }) as typeof actual.withWorkspace,
    retryOnRetryableDbDeadline: ((...args: Parameters<typeof actual.retryOnRetryableDbDeadline>) => {
      acquireRetries.push(args[1]?.retries);
      return actual.retryOnRetryableDbDeadline(...args);
    }) as typeof actual.retryOnRetryableDbDeadline,
    withAcquisitionDeadline: ((...args: Parameters<typeof actual.withAcquisitionDeadline>) => {
      acquireTimeouts.push(args[1].ms);
      return actual.withAcquisitionDeadline(...args);
    }) as typeof actual.withAcquisitionDeadline,
  };
});

import {
  isDeadTerminalLaunch,
  isFailedTerminalLaunch,
  acquireAdvSessionResume,
  claimAdvSessionResume,
  classifyOwnerNativeSession,
  fallbackCodexLaunchSpecFromAdvSession,
  hasAdvSessionTerminalEvidence,
  isAdvSessionLocalLivenessEvidence,
  advSessionLivenessEvidenceCoversAgent,
  ADV_SESSION_LIVENESS_EVIDENCE_AGENT,
  getLatestActiveAdvSessionByOwner,
  readAdvSessionLaunchRecordByOwner,
  listResumableSessions,
  markAdvSessionShutdownAcceptedByOwner,
  reactivateAdvSessionByOwner,
  repairStaleAdvSessionTerminalMarkers,
  shutdownAcceptedOwnerIds,
  toIsoTimestamp,
  type AdvSessionRow,
} from './adv-sessions';

const SOURCE = readFileSync(new URL('./adv-sessions.ts', import.meta.url), 'utf8');

beforeEach(() => {
  advSessionRowsMock.mockReset();
  advSessionRowsMock.mockResolvedValue([]);
  appSessionRowsMock.mockReset();
  appSessionRowsMock.mockResolvedValue([]);
  workspaceCalls.length = 0;
  advSessionBeginMock.mockReset();
  advSessionBeginMock.mockImplementation(async (fn: (tx: typeof advSessionRowsMock) => unknown) => fn(advSessionRowsMock));
  acquireTimeouts.length = 0;
  acquireRetries.length = 0;
});

describe('deliberate retirement resume fence (WI-6554700010010429)', () => {
  it.each([['explicit relaunch', new Date(), true], ['crash recovery', null, false]] as const)(
    'allows %s while leaving retirement intact during acquisition', async (_name, retiredAt, allowRetired) => {
      const tx = vi.fn(async (strings: TemplateStringsArray) => {
        if (strings.join(' ').includes('SELECT agent, ended_at')) return [{
          agent: 'claude', ended_at: new Date(), ended_by: 'signal', retired_at: retiredAt,
          started_at: new Date(), resume_claim_key: null, resume_claimed_at: null,
        }];
        return [{ lease_expires_at: new Date(Date.now() + 60_000) }];
      });
      advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));
      await expect(acquireAdvSessionResume(42, 'new-key', 60, 300, undefined, allowRetired))
        .resolves.toMatchObject({ status: 'acquired', acquired: true });
      const write = tx.mock.calls.map(([strings]) => strings.join(' ')).find(sql => sql.includes('UPDATE'));
      expect(write).toBeDefined();
      expect(write).not.toContain('retired_at =');
    },
  );

  it('returns retired for a retired row on the legacy no-key claim path', async () => {
    advSessionRowsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ retired_at: new Date() }]);

    await expect(claimAdvSessionResume(42)).resolves.toBe('retired');

    const statements = (advSessionRowsMock.mock.calls as unknown[][]).map(([template]) =>
      (template as readonly string[]).join(' '),
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('UPDATE harness_shared.adv_sessions');
    expect(statements[0]).toContain('retired_at IS NULL');
    expect(statements[1]).toContain('SELECT retired_at FROM harness_shared.adv_sessions');
  });

  it('refuses a retired row even for a replayed lease and positive absence witness', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) return [{
        agent: 'claude', ended_at: new Date(), ended_by: 'signal',
        retired_at: new Date(), retired_by: 'fleet:kill:operator',
        started_at: new Date(), resume_claim_key: 'replay-key', resume_claimed_at: new Date(),
      }];
      return [{ lease_expires_at: new Date(Date.now() + 60_000) }];
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));
    await expect(acquireAdvSessionResume(42, 'replay-key', 60, 300, {
      version: 1, kind: 'no-live-claude-process',
    })).resolves.toMatchObject({ status: 'retired', acquired: false });
    expect(tx.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE harness_shared'))).toBe(false);
  });
});

function advSessionTableReads(): unknown[][] {
  return (advSessionRowsMock.mock.calls as unknown[][]).filter(([template]) =>
    Array.isArray(template) && template.join(' ').includes('FROM harness_shared.adv_sessions'),
  );
}

describe('P040 unkeyed retained-wake claim contract', () => {
  it.each([null, '', '  '] as const)('keeps the no-key transition distinct from keyed finalization (%j)', async (key) => {
    advSessionRowsMock.mockResolvedValueOnce([{ id: 42 }]);

    await expect(claimAdvSessionResume(42, key, undefined, 'su-retained-codex')).resolves.toBe(true);

    expect(advSessionBeginMock).not.toHaveBeenCalled();
    expect(advSessionRowsMock).toHaveBeenCalledOnce();
    const [template, ...values] = advSessionRowsMock.mock.calls[0] as unknown[];
    const statement = (template as readonly string[]).join(' ');
    expect(values).toContain('su-retained-codex');
    expect(statement).toContain('coord_owner_id =');
    expect(statement).toContain('successor.id > adv_sessions.id');
    for (const field of ['ended_at', 'exit_code', 'ended_by', 'ended_signal', 'shutdown_accepted_at',
      'resume_claim_key', 'resume_claimed_at']) {
      expect(statement).toContain(`${field} = NULL`);
    }
    // The legacy claim changes liveness only. Real receipt preservation and
    // rollback are asserted by the sibling PostgreSQL integration suite.
    expect(statement).not.toContain('launch_spec =');
    expect(statement).not.toContain('agent_launch_idempotency');
  });

  it('propagates an unevaluated claim instead of reporting a lost election', async () => {
    const failure = new Error('P040 unkeyed claim datastore failure');
    advSessionRowsMock.mockRejectedValueOnce(failure);
    await expect(claimAdvSessionResume(42, null, undefined, 'su-retained-codex')).rejects.toBe(failure);
    expect(advSessionRowsMock).toHaveBeenCalledOnce();
  });
});

function appAdvSessionTableReads(): unknown[][] {
  return (appSessionRowsMock.mock.calls as unknown[][]).filter(([template]) =>
    Array.isArray(template) && template.join(' ').includes('FROM harness_shared.adv_sessions'),
  );
}

describe('classifyOwnerNativeSession exact incarnation (get-feedback D-006)', () => {
  const ownerId = 'su-incarnation-source';
  const nativeId = 'native-source';
  const rejected = { binding: 'foreign', boundSessionId: null, advSessionId: null };

  it('accepts a bound match from the read-only RLS-scoped app pool', async () => {
    appSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      return query.includes('FROM harness_shared.adv_sessions')
        ? [{ id: 541, session_id: nativeId, active: true }]
        : [];
    });

    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId, workspaceId: 'ws-fast-path' }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: nativeId, advSessionId: 541 });

    expect(workspaceCalls).toHaveLength(1);
    expect(workspaceCalls[0]).toMatchObject({
      workspaceId: 'ws-fast-path',
      options: {
        readOnly: true,
        acquireTimeoutMs: 7_500,
        acquireRetries: 0,
        statementTimeoutMs: 2_000,
        lockTimeoutMs: 1_000,
      },
    });
    expect(appAdvSessionTableReads()).toHaveLength(1);
    expect(advSessionTableReads()).toHaveLength(0);
  });

  it('captures relative verifier transaction and lookup timings without changing its acquire budget', async () => {
    appSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      return query.includes('FROM harness_shared.adv_sessions')
        ? [{ id: 541, session_id: nativeId, active: true }]
        : [];
    });
    const { namedQueryStageTimings, withNamedQueryDiagnosticContext } = await import('./agent-tools/db-diagnostic-correlation-wiring');

    const result = await withNamedQueryDiagnosticContext('mcp.nativeSessionVerifier', async () => {
      const binding = await classifyOwnerNativeSession({ ownerId, sessionId: nativeId, workspaceId: 'ws-timing' });
      return { binding, timing: namedQueryStageTimings() };
    }, 'e57ef6b3-46ef-4cc5-8214-fec83f2a463e');

    expect(result.binding).toEqual({ binding: 'bound', boundSessionId: nativeId, advSessionId: 541 });
    expect(result.timing?.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stage: 'native-session-verifier-workspace-transaction',
        elapsedMs: expect.any(Number),
        outcome: 'fulfilled',
      }),
      expect.objectContaining({
        stage: 'native-session-verifier-owner-candidate-rows-lookup',
        elapsedMs: expect.any(Number),
        outcome: 'fulfilled',
      }),
    ]));
    expect(result.timing?.stages.length).toBeLessThanOrEqual(8);
    expect(workspaceCalls[0]).toMatchObject({
      workspaceId: 'ws-timing',
      options: { acquireTimeoutMs: 7_500, acquireRetries: 0 },
    });
  });

  it.each([
    {
      label: 'unbound',
      rows: [] as unknown[],
      expected: { binding: 'unbound', boundSessionId: null, advSessionId: null },
    },
    {
      label: 'foreign',
      rows: [{ id: 542, session_id: 'native-other', active: true }],
      expected: { binding: 'foreign', boundSessionId: 'native-other', advSessionId: 542 },
    },
  ])('uses the global classifier fallback for a scoped $label result', async ({ rows, expected }) => {
    appSessionRowsMock.mockResolvedValue(rows);
    advSessionRowsMock.mockResolvedValue(rows);

    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId, workspaceId: 'ws-fallback' }))
      .resolves.toEqual(expected);

    expect(workspaceCalls).toHaveLength(1);
    expect(advSessionTableReads()).toHaveLength(1);
  });

  it('does not coalesce in-flight reads across different workspace scopes', async () => {
    appSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      return query.includes('FROM harness_shared.adv_sessions')
        ? [{ id: 541, session_id: nativeId, active: true }]
        : [];
    });

    const results = await Promise.all([
      classifyOwnerNativeSession({ ownerId, sessionId: nativeId, workspaceId: 'ws-a' }),
      classifyOwnerNativeSession({ ownerId, sessionId: nativeId, workspaceId: 'ws-b' }),
    ]);

    expect(results).toEqual([
      { binding: 'bound', boundSessionId: nativeId, advSessionId: 541 },
      { binding: 'bound', boundSessionId: nativeId, advSessionId: 541 },
    ]);
    expect(workspaceCalls.map(({ workspaceId }) => workspaceId)).toEqual(['ws-a', 'ws-b']);
  });

  it('uses a measured-queue acquisition budget and explicit statement bounds', async () => {
    advSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      return query.includes('FROM harness_shared.adv_sessions')
        ? [{ id: 541, session_id: nativeId, active: true }]
        : [];
    });

    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: nativeId, advSessionId: 541 });

    const calls = advSessionRowsMock.mock.calls as unknown[][];
    const statements = calls.map(([template]) => Array.isArray(template) ? template.join(' ') : '');
    expect(statements[0]).toContain('SET TRANSACTION READ ONLY');
    expect(statements[1]).toContain("set_config('lock_timeout'");
    expect(calls[1]?.slice(1)).toEqual(['1000ms', '2000ms']);
    expect(statements[2]).toContain('FROM harness_shared.adv_sessions');
    expect(acquireTimeouts).toContain(7_500);
    expect(acquireTimeouts).not.toContain(1_000);
    expect(acquireRetries).toEqual([0]);
  });

  it('coalesces identical in-flight verifier reads but does not cache settled authority', async () => {
    let releaseRead!: () => void;
    let markReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => { markReadStarted = resolve; });
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    let rowReadCount = 0;
    advSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      if (!query.includes('FROM harness_shared.adv_sessions')) return [];
      rowReadCount += 1;
      if (rowReadCount === 1) {
        markReadStarted();
        await readGate;
      }
      return [{ id: 541, session_id: nativeId, active: true }];
    });

    const first = classifyOwnerNativeSession({ ownerId, sessionId: nativeId });
    const second = classifyOwnerNativeSession({ ownerId, sessionId: nativeId });
    await readStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(advSessionBeginMock).toHaveBeenCalledTimes(1);
      expect(rowReadCount).toBe(1);
    } finally {
      releaseRead();
    }

    const expected = { binding: 'bound', boundSessionId: nativeId, advSessionId: 541 };
    await expect(Promise.all([first, second])).resolves.toEqual([expected, expected]);

    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId })).resolves.toEqual(expected);
    expect(advSessionBeginMock).toHaveBeenCalledTimes(2);
    expect(rowReadCount).toBe(2);
  });

  it('does not coalesce in-flight verifications for distinct explicit adv-session ids', async () => {
    let releaseReads!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseReads = resolve; });
    let rowReadCount = 0;
    advSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      if (!query.includes('FROM harness_shared.adv_sessions')) return [];
      rowReadCount += 1;
      await readGate;
      return [{ id: Number(args[1]), session_id: nativeId, active: true }];
    });

    const first = classifyOwnerNativeSession({ ownerId, sessionId: nativeId, advSessionId: 541 });
    const second = classifyOwnerNativeSession({ ownerId, sessionId: nativeId, advSessionId: 542 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    try {
      expect(advSessionBeginMock).toHaveBeenCalledTimes(2);
      expect(rowReadCount).toBe(2);
    } finally {
      releaseReads();
    }

    await expect(Promise.all([first, second])).resolves.toEqual([
      { binding: 'bound', boundSessionId: nativeId, advSessionId: 541 },
      { binding: 'bound', boundSessionId: nativeId, advSessionId: 542 },
    ]);
  });

  it('fails closed after one retryable acquisition timeout without retrying a queued begin', async () => {
    const timeout = new DbCallDeadlineError('boundedOrgTxn:begin(admin)', 7_500, 7_500, 'org-admin');
    Object.defineProperty(timeout, 'retryable', { value: true });
    advSessionBeginMock.mockRejectedValue(timeout);

    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId })).rejects.toBe(timeout);
    expect((timeout as DbCallDeadlineError & { nativeSessionVerificationPhase?: string }).nativeSessionVerificationPhase)
      .toBe('transaction_setup');

    expect(advSessionBeginMock).toHaveBeenCalledTimes(1);
    expect(advSessionRowsMock).not.toHaveBeenCalled();
    expect(acquireRetries).toEqual([0]);
  });

  it.each([
    { advSessionId: null, expectedPhase: 'owner_candidate_rows_lookup' },
    { advSessionId: 541, expectedPhase: 'owner_row_lookup_by_id' },
  ])('tags verifier statement failures at $expectedPhase', async ({ advSessionId, expectedPhase }) => {
    const timeout = Object.assign(new Error('statement timeout'), { name: 'OrgTxnTimeoutError', pgCode: '57014' });
    advSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      if (query.includes('FROM harness_shared.adv_sessions')) throw timeout;
      return [];
    });

    await expect(classifyOwnerNativeSession({
      ownerId,
      sessionId: nativeId,
      ...(advSessionId == null ? {} : { advSessionId }),
    })).rejects.toBe(timeout);
    expect((timeout as Error & { nativeSessionVerificationPhase?: string }).nativeSessionVerificationPhase)
      .toBe(expectedPhase);
  });

  it.each(['missing', 'owned by another session'])('does not replace an explicit %s row with another matching owner row', async () => {
    // The id/owner predicate returns no row in either case. A second lookup
    // could incorrectly find a different incarnation with the presented id.
    advSessionRowsMock.mockImplementation(async (...args: unknown[]) => {
      const template = args[0];
      const query = Array.isArray(template) ? template.join(' ') : String(template ?? '');
      if (!query.includes('FROM harness_shared.adv_sessions')) return [];
      return query.includes('WHERE id =') ? [] : [{ id: 543, session_id: nativeId, active: true }];
    });
    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId, advSessionId: 541 }))
      .resolves.toEqual(rejected);
    const reads = advSessionTableReads();
    expect(reads).toHaveLength(1);
    expect((reads[0]?.[0] as TemplateStringsArray).join(' ')).toContain('WHERE id =');
    expect(reads[0]?.slice(1)).toEqual([541, ownerId]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid explicit row %s before reading another incarnation', async (advSessionId) => {
    advSessionRowsMock.mockResolvedValue([{ id: 543, session_id: nativeId, active: true }]);
    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId, advSessionId }))
      .resolves.toEqual(rejected);
    expect(advSessionRowsMock).not.toHaveBeenCalled();
  });

  it.each([541, 543])('retains an exact legitimate row %s for the same owner', async (advSessionId) => {
    advSessionRowsMock.mockResolvedValue([{ id: advSessionId, session_id: nativeId, active: true }]);
    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId, advSessionId }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: nativeId, advSessionId });
    expect(advSessionTableReads()).toHaveLength(1);
    const call = advSessionTableReads()[0] ?? [];
    expect(call.slice(1)).toEqual([advSessionId, ownerId]);
  });

  it('retains first binding for an existing pending exact row', async () => {
    advSessionRowsMock.mockResolvedValue([{ id: 541, session_id: null, active: true }]);
    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId, advSessionId: 541 }))
      .resolves.toEqual({ binding: 'unbound', boundSessionId: null, advSessionId: 541 });
    expect(advSessionTableReads()).toHaveLength(1);
  });

  it.each([undefined, null])('keeps owner-wide lookup when an exact row is omitted (%s)', async (advSessionId) => {
    advSessionRowsMock.mockResolvedValue([
      { id: 543, session_id: 'native-continuation', active: true },
      { id: 541, session_id: nativeId, active: true },
    ]);
    await expect(classifyOwnerNativeSession({ ownerId, sessionId: nativeId, advSessionId }))
      .resolves.toEqual({ binding: 'bound', boundSessionId: nativeId, advSessionId: 541 });
    expect(advSessionTableReads()).toHaveLength(1);
  });
});

describe('getLatestActiveAdvSessionByOwner', () => {
  it('maps the newest active row and binds the exact owner/workspace predicates', async () => {
    // boundedOrgTxn applies lock_timeout + statement_timeout in ONE set_config
    // statement before the read (WI-10003631 merged the two round trips).
    advSessionRowsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 28143,
      workspace_id: 'request-workspace',
      plan_slug: 'retrieval-soft-budget-hard-deadline-2026-09-13',
      agent: 'codex',
      role: null,
      feature: null,
      mode: 'console',
      terminal_bin: null,
      pid: null,
      window_id: '0x01e70b14',
      omp_thread_id: null,
      label: null,
      cwd: '/repo',
      coord_owner_id: 'su-8ee55568',
      session_id: '01a09697-7bd2-78f1-9e1b-f8592b50a23c',
      started_at: '2026-09-12T23:18:15.000Z',
      ended_at: null,
      exit_code: null,
      ended_by: null,
      ended_signal: null,
      }]);

    const result = await getLatestActiveAdvSessionByOwner(' su-8ee55568 ', 'request-workspace');
    expect(result).toMatchObject({ id: 28143, coordOwnerId: 'su-8ee55568', windowId: '0x01e70b14' });
    const queryCall = (advSessionRowsMock.mock.calls as unknown[][]).at(-1);
    const sql = (queryCall?.[0] as readonly string[]).join(' ');
    expect(queryCall?.slice(1)).toContain('request-workspace');
    expect(sql).toContain('coord_owner_id =');
    expect(sql).toContain('ended_at IS NULL');
    expect(sql).toContain('successor.id > a.id');
    expect(sql).toContain('ORDER BY id DESC');
    expect(sql).toContain('LIMIT 1');
  });

  it('does not query for a blank owner id', async () => {
    await expect(getLatestActiveAdvSessionByOwner('   ')).resolves.toBeNull();
    expect(advSessionRowsMock).not.toHaveBeenCalled();
  });
});

describe('readAdvSessionLaunchRecordByOwner', () => {
  it('maps the newest owner-scoped launch record and keeps the query schema-safe', async () => {
    const launchSpec = { v: 1, workspaceId: 'ws-test', fleet: { slug: 'byoc' } };
    const launchArgv = ['psu', '--fleet=byoc'];
    // WI-6055: the first sql-tag call constructs the conditional workspace
    // fragment; only the outer call executes the SELECT and receives rows.
    advSessionRowsMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { workspace_id: 'ws-test', agent: 'codex', launch_spec: launchSpec, launch_argv: launchArgv },
      ]);

    await expect(readAdvSessionLaunchRecordByOwner('su-member', 'ws-test')).resolves.toEqual({
      workspaceId: 'ws-test',
      agent: 'codex',
      launchSpec,
      launchArgv,
    });
    const template = (advSessionRowsMock.mock.calls as unknown[][]).at(-1)?.[0];
    expect(Array.isArray(template)).toBe(true);
    expect((template as readonly string[]).join(' ')).toContain("to_jsonb(a)->'launch_spec'");
    expect((template as readonly string[]).join(' ')).toContain("to_jsonb(a)->'launch_argv'");
    expect((template as readonly string[]).join(' ')).toContain('agent');
  });
});

describe('listResumableSessions launch provenance', () => {
  it('returns the recorded psu argv needed for source-aware Codex resume inheritance', async () => {
    const launchArgv = [
      'psu',
      '--agent=codex',
      '--headless',
      '--model=gpt-5.6-terra:high',
      '--model-source=explicit',
    ];
    advSessionRowsMock.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 7,
        workspace_id: 'ws-test',
        plan_slug: null,
        agent: 'codex',
        role: null,
        feature: null,
        mode: 'console',
        terminal_bin: null,
        pid: null,
        window_id: null,
        omp_thread_id: null,
        label: null,
        cwd: '/repo',
        coord_owner_id: 'su-7',
        session_id: null,
        launch_argv: launchArgv,
        started_at: '2026-09-07T00:00:00.000Z',
        last_active_at: '2026-09-07T00:00:00.000Z',
        ended_at: null,
        exit_code: null,
        ended_by: null,
        ended_signal: null,
      },
    ]);

    const rows = await listResumableSessions(1);
    expect(rows[0]?.launchArgv).toEqual(launchArgv);
    const template = (advSessionRowsMock.mock.calls as unknown[][]).at(-1)?.[0];
    expect((template as readonly string[]).join(' ')).toContain('a.launch_argv');
  });
});

describe('accepted session shutdown marker (EI-21266145962856513)', () => {
  it('marks only the newest still-open row for an owner', async () => {
    advSessionRowsMock.mockResolvedValueOnce([{ id: 42 }]);
    await expect(markAdvSessionShutdownAcceptedByOwner('su-holder')).resolves.toBe(true);
    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    expect((template as readonly string[]).join(' ')).toContain('shutdown_accepted_at = now()');
    expect((template as readonly string[]).join(' ')).toContain('ended_at IS NULL');
    expect((template as readonly string[]).join(' ')).toContain('ORDER BY started_at DESC');
  });

  it('reads the marker only from each owner\'s newest row', async () => {
    advSessionRowsMock.mockResolvedValueOnce([
      { coord_owner_id: 'su-marked', shutdown_accepted_at: '2026-08-23T19:00:00Z' },
      { coord_owner_id: 'su-live', shutdown_accepted_at: null },
    ]);
    await expect(shutdownAcceptedOwnerIds(['su-marked', 'su-live', 'fed:remote'])).resolves.toEqual(
      new Set(['su-marked']),
    );
    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    expect((template as readonly string[]).join(' ')).toContain('DISTINCT ON (coord_owner_id)');
    expect((template as readonly string[]).join(' ')).toContain('ORDER BY coord_owner_id, started_at DESC');
  });

  it('clears accepted shutdown across every reactivation and re-anchor path', () => {
    for (const fn of [
      'claimAdvSessionResume',
      'reactivateAdvSessionByOwner',
      'reanchorAdvSessionNativeId',
      'reanchorAdvSessionNativeIdByOwner',
    ]) {
      const from = SOURCE.indexOf('export async function ' + fn);
      expect(from, fn).toBeGreaterThan(-1);
      const tail = SOURCE.slice(from, from + 3000);
      expect(tail, fn).toMatch(/shutdown_accepted_at = NULL/);
    }
  });
});

describe('resume helper contract separation (psu-resume-claim-cutover D-001)', () => {
  it('retires the numeric helper while preserving the owner-keyed activity repair', () => {
    // The negative assertion is paired with a positive control deliberately: a moved,
    // renamed, or empty source file must not make selective retirement look green.
    expect(SOURCE).not.toMatch(/export async function reactivateAdvSession\s*\(/);
    expect(SOURCE).toMatch(/export async function reactivateAdvSessionByOwner\s*\(/);
  });
});

describe('stale adv-session terminal marker repair (EI-21365346411486602)', () => {
  it('treats either half of the terminal tuple as positive death evidence', () => {
    expect(hasAdvSessionTerminalEvidence({ endedAt: null, endedBy: 'reconciler' })).toBe(true);
    expect(hasAdvSessionTerminalEvidence({ endedAt: '2026-08-24T20:00:00Z', endedBy: null })).toBe(true);
    expect(hasAdvSessionTerminalEvidence({ endedAt: null, endedBy: null })).toBe(false);
  });

  it('fills only the missing terminal timestamp for the requested owner', async () => {
    advSessionRowsMock.mockResolvedValueOnce([{ id: 17840 }, { id: 17841 }]);

    await expect(repairStaleAdvSessionTerminalMarkers('su-stale')).resolves.toBe(2);

    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    const sql = (template as readonly string[]).join(' ');
    expect(sql).toContain('SET ended_at = now()');
    expect(sql).toContain('coord_owner_id');
    expect(sql).toContain('ended_at IS NULL');
    expect(sql).toContain('ended_by IS NOT NULL');
    expect(sql).toContain('RETURNING id');
  });

  it('is a no-op for a blank owner and does not touch the database', async () => {
    await expect(repairStaleAdvSessionTerminalMarkers('   ')).resolves.toBe(0);
    expect(advSessionRowsMock).not.toHaveBeenCalled();
  });

  it('reactivates either half of the terminal tuple only when no keyed resume owns the row', async () => {
    advSessionRowsMock.mockResolvedValueOnce([{ id: 17842 }]);

    await expect(reactivateAdvSessionByOwner('su-half-terminal')).resolves.toBe(true);

    const template = (advSessionRowsMock.mock.calls as unknown[][])[0]?.[0];
    const sql = (template as readonly string[]).join(' ');
    expect(sql).toContain('(ended_at IS NOT NULL OR ended_by IS NOT NULL)');
    expect(sql).toContain('ended_at = NULL');
    expect(sql).toContain('ended_by = NULL');
    expect(sql).toContain('ended_signal = NULL');
    expect(sql).toContain('AND resume_claim_key IS NULL');
    expect(sql).not.toContain('resume_claim_key = NULL');
    expect(sql).not.toContain('resume_claimed_at = NULL');
  });
});

describe('fallbackCodexLaunchSpecFromAdvSession', () => {
  const row = (over: Partial<AdvSessionRow> = {}): AdvSessionRow =>
    ({
      id: 16512,
      workspaceId: 'papercusp-workspace',
      harnessSlug: null,
      planSlug: 'drain-plan',
      agent: 'codex',
      coordOwnerId: 'su-current',
      ...over,
    }) as AdvSessionRow;

  it('reconstructs a conservative workspace-scoped Codex launch record', () => {
    expect(fallbackCodexLaunchSpecFromAdvSession(row(), 'su-current')).toEqual({
      v: 1,
      agent: 'codex',
      workspaceId: 'papercusp-workspace',
      harnessSlug: null,
      profile: 'engineer',
      contextSize: 'trimmed',
      personaTier: null,
      model: null,
      planSlug: 'drain-plan',
      launchedBy: null,
      autoMode: false,
      drainMode: false,
      loopArmed: false,
      headless: false,
      fleet: null,
    });
  });

  it('marks the record headless only when the recorded launch argv carried --headless', () => {
    expect(
      fallbackCodexLaunchSpecFromAdvSession(row({ launchArgv: ['--fleet=x', '--headless'] } as Partial<AdvSessionRow>), 'su-current')
        ?.headless,
    ).toBe(true);
    expect(
      fallbackCodexLaunchSpecFromAdvSession(row({ launchArgv: ['--fleet=x'] } as Partial<AdvSessionRow>), 'su-current')?.headless,
    ).toBe(false);
  });

  it('preserves a recorded concrete harness when one exists', () => {
    expect(fallbackCodexLaunchSpecFromAdvSession(row({ harnessSlug: 'papercusp' }), 'su-current')?.harnessSlug).toBe(
      'papercusp',
    );
  });

  it('refuses a different owner or non-Codex session', () => {
    expect(fallbackCodexLaunchSpecFromAdvSession(row(), 'su-other')).toBeNull();
    expect(fallbackCodexLaunchSpecFromAdvSession(row({ agent: 'claude' }), 'su-current')).toBeNull();
  });
});

describe('Codex resume local-liveness evidence (EI-21584243912058462)', () => {
  it('accepts exactly the closed positive discriminant', () => {
    expect(isAdvSessionLocalLivenessEvidence({
      version: 1,
      kind: 'no-live-codex-writer',
    })).toBe(true);
    for (const value of [
      null,
      undefined,
      [],
      { version: 1, kind: 'no-live-codex-writer', extra: true },
      { version: '1', kind: 'no-live-codex-writer' },
      { version: 1, kind: 'free' },
    ]) {
      expect(isAdvSessionLocalLivenessEvidence(value)).toBe(false);
    }
  });

  it('uses the witness only inside the locked Codex recent-active transaction', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('SELECT agent, ended_at')) {
        return [{
          agent: 'codex',
          ended_at: null,
          ended_by: null,
          started_at: new Date(),
          resume_claim_key: null,
          resume_claimed_at: null,
        }];
      }
      if (sql.includes('UPDATE harness_shared.adv_sessions')) {
        return [{ lease_expires_at: new Date(Date.now() + 60_000).toISOString() }];
      }
      return [];
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(
      42,
      'resume-key',
      60,
      300,
      { version: 1, kind: 'no-live-codex-writer' },
    )).resolves.toMatchObject({ status: 'acquired', acquired: true });
    expect(tx.mock.calls.some(([strings]) => strings.join(' ').includes('FOR UPDATE'))).toBe(true);
    expect(tx.mock.calls.some(([strings]) => strings.join(' ').includes('UPDATE harness_shared.adv_sessions'))).toBe(true);
  });

  it('keeps a recent row live when the evidence is malformed or unknown', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) {
        return [{
          agent: 'codex',
          ended_at: null,
          ended_by: null,
          started_at: new Date(),
          resume_claim_key: null,
          resume_claimed_at: null,
        }];
      }
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(42, 'resume-key', 60, 300, {
      version: 1,
      kind: 'unknown',
    })).resolves.toEqual({ status: 'live', acquired: false });
  });
});

/**
 * WI-2141892 — the same reconciliation for CLAUDE, and the binding that keeps the
 * two oracles from being interchangeable.
 *
 * The bug: a claude session that exited without an end witness (ended_at,
 * exit_code and shutdown_accepted_at all NULL — window closed, host killed) left
 * a row that is non-terminal and recent, so this function refused `live` for the
 * whole 300s window with NO override. `PSU_FORCE_RESUME=1` gates only psu's local
 * double-host guard and never reaches here, so the owner's only routes were to
 * wait or to `--fork`, which mints a fresh identity and abandons the coord
 * ownerId every lock, await and presence row is keyed on.
 */
describe('Claude resume local-liveness evidence (WI-2141892)', () => {
  const recentActiveClaudeRow = () => ({
    agent: 'claude',
    ended_at: null,
    ended_by: null,
    started_at: new Date(), // inside the recent-active window
    resume_claim_key: null,
    resume_claimed_at: null,
  });

  const txFor = (row: Record<string, unknown>) =>
    vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const sql = strings.join(' ');
      if (sql.includes('SELECT agent, ended_at')) return [row];
      if (sql.includes('UPDATE harness_shared.adv_sessions')) {
        return [{ lease_expires_at: new Date(Date.now() + 60_000).toISOString() }];
      }
      return [];
    });

  it('accepts both closed discriminants and nothing else', () => {
    expect(isAdvSessionLocalLivenessEvidence({ version: 1, kind: 'no-live-claude-process' })).toBe(true);
    expect(isAdvSessionLocalLivenessEvidence({ version: 1, kind: 'no-live-codex-writer' })).toBe(true);
    for (const value of [
      { version: 1, kind: 'no-live-claude-process', extra: true },
      { version: 2, kind: 'no-live-claude-process' },
      { version: 1, kind: 'no-live-claude-writer' },
      { version: 1, kind: 'clean-scan' },
      { version: 1 },
    ]) {
      expect(isAdvSessionLocalLivenessEvidence(value)).toBe(false);
    }
  });

  it('binds each witness kind to the ONE backend whose oracle produced it', () => {
    expect(ADV_SESSION_LIVENESS_EVIDENCE_AGENT).toEqual({
      'no-live-codex-writer': 'codex',
      'no-live-claude-process': 'claude',
      'no-live-omp-process': 'omp',
    });
    // WI-2142101: omp joins on the same terms. claude and omp share one PROBE
    // (both resumes name the session in argv) but NOT one witness kind — a kind
    // names the oracle AND the row it may speak for, so sharing a mechanism must
    // not become sharing an identity.
    expect(isAdvSessionLocalLivenessEvidence({ version: 1, kind: 'no-live-omp-process' })).toBe(true);
    expect(advSessionLivenessEvidenceCoversAgent('omp', { version: 1, kind: 'no-live-omp-process' })).toBe(true);
    expect(advSessionLivenessEvidenceCoversAgent('claude', { version: 1, kind: 'no-live-omp-process' })).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('omp', { version: 1, kind: 'no-live-claude-process' })).toBe(false);
    const claudeWitness = { version: 1, kind: 'no-live-claude-process' };
    const codexWitness = { version: 1, kind: 'no-live-codex-writer' };
    expect(advSessionLivenessEvidenceCoversAgent('claude', claudeWitness)).toBe(true);
    expect(advSessionLivenessEvidenceCoversAgent('codex', codexWitness)).toBe(true);
    // Cross-application is the unearned liveness claim: codex's flock says
    // nothing about a claude process, and a /proc scan says nothing about a
    // codex thread's writer.
    expect(advSessionLivenessEvidenceCoversAgent('codex', claudeWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('claude', codexWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('omp', claudeWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent(null, claudeWitness)).toBe(false);
    expect(advSessionLivenessEvidenceCoversAgent('claude', null)).toBe(false);
  });

  it('reconciles a recent-active CLAUDE row that the local probe found dead', async () => {
    const tx = txFor(recentActiveClaudeRow());
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toMatchObject({ status: 'acquired', acquired: true });
  });

  it('POSITIVE CONTROL — the same row without a witness still refuses live', async () => {
    // Without this the test above would pass for the wrong reason (e.g. if the
    // row were being read as stale rather than reconciled).
    const tx = txFor(recentActiveClaudeRow());
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300))
      .resolves.toEqual({ status: 'live', acquired: false });
  });

  it('refuses a CLAUDE row presented with a codex witness', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) return [recentActiveClaudeRow()];
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300, {
      version: 1,
      kind: 'no-live-codex-writer',
    })).resolves.toEqual({ status: 'live', acquired: false });
  });

  it('refuses a CODEX row presented with a claude witness', async () => {
    const tx = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) {
        return [{ ...recentActiveClaudeRow(), agent: 'codex' }];
      }
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(tx as typeof advSessionRowsMock));

    await expect(acquireAdvSessionResume(22127, 'resume-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toEqual({ status: 'live', acquired: false });
  });

  it('never lets a witness override a HELD reservation or a missing row', async () => {
    // The witness reconciles the recent-active liveness read only. It must not
    // touch the single-winner lease or invent a row.
    const held = vi.fn(async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      if (strings.join(' ').includes('SELECT agent, ended_at')) {
        return [{
          ...recentActiveClaudeRow(),
          resume_claim_key: 'another-launchers-key',
          resume_claimed_at: new Date(),
        }];
      }
      throw new Error('unexpected write');
    });
    advSessionBeginMock.mockImplementation(async (fn) => fn(held as typeof advSessionRowsMock));
    await expect(acquireAdvSessionResume(22127, 'my-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toMatchObject({ status: 'reserved', acquired: false });

    const missing = vi.fn(async () => []);
    advSessionBeginMock.mockImplementation(async (fn) => fn(missing as typeof advSessionRowsMock));
    await expect(acquireAdvSessionResume(22127, 'my-key', 60, 300, {
      version: 1,
      kind: 'no-live-claude-process',
    })).resolves.toEqual({ status: 'missing', acquired: false });
  });
});

/**
 * WI-6589 — `first_seen_at` must stay a BIRTH, so nothing may bump it.
 *
 * This is a source-level guard rather than a behavioural one on purpose: the bug
 * it prevents is invisible to any unit test that seeds rows itself. The old
 * floor read `MIN(started_at)`, and `started_at` IS bumped in place by four
 * resume/re-anchor paths in this file — so production kept exactly one row per
 * coord owner and MIN === MAX === the latest launch. A test that seeds two rows
 * for one owner asserts a shape production cannot produce and passes while the
 * system is broken (measured: 6,957 targeted messages across 78 owners sat below
 * their computed floor). The only durable invariant is the one enforced here:
 * `first_seen_at` is written at INSERT and never again.
 */
describe('adv_sessions birth timestamp (WI-6589)', () => {
  it('the coord-owner birth floor reads first_seen_at, never the bumped started_at', () => {
    expect(SOURCE).toMatch(/SELECT MIN\(first_seen_at\) AS started_at/);
    expect(SOURCE).not.toMatch(/SELECT MIN\(started_at\)/);
  });

  it('no UPDATE statement in this module touches first_seen_at', () => {
    const offending = SOURCE.split('UPDATE harness_shared.adv_sessions')
      .slice(1)
      // Each fragment runs to the end of its tagged-template literal.
      .map((tail) => tail.slice(0, tail.indexOf('`')))
      .filter((stmt) => stmt.includes('first_seen_at'));
    expect(offending).toEqual([]);
  });

  it('recordAdvSession leaves first_seen_at to its column DEFAULT', () => {
    // Naming it in the INSERT would let a caller pass a value, which is the same
    // hole by another route.
    const inserts = SOURCE.split('INSERT INTO harness_shared.adv_sessions')
      .slice(1)
      .map((tail) => tail.slice(0, tail.indexOf('`')));
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.filter((stmt) => stmt.includes('first_seen_at'))).toEqual([]);
  });
});

/**
 * WI-37743/P-002 — `adoptStartingTerminalLaunch` COMPLETES a launcher's own
 * starting row instead of inserting a duplicate beside it. Its entire safety
 * rests on the identity + lifecycle predicates in one WHERE clause, so they are
 * guarded here.
 *
 * Source-level, like the birth-timestamp guards above and for the same reason:
 * the failure this prevents is a row-SELECTION bug, and a unit test that seeds
 * its own rows proves only that the statement runs — it cannot show which rows
 * a weakened predicate would ALSO have matched. Dropping `session_id IS NULL`
 * is the dangerous one: the UPDATE would then overwrite the session_id of a
 * LIVE session's row, silently re-pointing the board at the wrong process. That
 * is invisible to a behavioural test that never seeds a live row to be stolen.
 */
describe('adoptStartingTerminalLaunch is narrowly guarded (WI-37743)', () => {
  const adopt = (() => {
    const from = SOURCE.indexOf('export async function adoptStartingTerminalLaunch');
    expect(from).toBeGreaterThan(-1);
    const stmt = SOURCE.slice(from);
    return stmt.slice(0, stmt.indexOf('RETURNING id'));
  })();

  it('only ever touches a row that has NO session yet', () => {
    // Without this, adopting steals a live session's row.
    expect(adopt).toMatch(/AND session_id IS NULL/);
  });

  it('only ever touches a row that has not ended', () => {
    // A reconciler-stamped row is a CLOSED launch; completing it would resurrect it.
    expect(adopt).toMatch(/AND ended_at IS NULL/);
  });

  it('allows only a terminal precursor or an already-claimed workbench precursor', () => {
    expect(adopt).toContain('display = ${DISPLAY_TERMINAL_LAUNCH}');
    expect(adopt).toContain("display = 'workbench' AND launched_at IS NOT NULL");
  });

  it('never adopts an unclaimed workbench row', () => {
    // launched_at is the server-side claim PUI wins BEFORE opening the pane.
    // Omitting this guard would let copied argv route around the single launcher.
    expect(adopt).not.toMatch(/OR\s+display = 'workbench'\s*[)\n]/);
  });

  it('is pinned to one explicit row id — never a predicate-only match', () => {
    // The caller resolves WHICH precursor (newest wins); this statement must not
    // widen that to "any starting row for this owner".
    expect(adopt).toMatch(/WHERE id = \$\{opts\.id\}/);
  });

  it('COALESCEs the optional columns so adopting cannot blank existing values', () => {
    // The launcher's row already carries plan_slug/label/cwd; a plain assignment
    // would null them out whenever bootstrap happens not to pass one.
    for (const col of ['role', 'feature', 'plan_slug', 'label', 'cwd', 'mode', 'launch_argv']) {
      expect(adopt).toMatch(new RegExp(`${col}\\s*=\\s*COALESCE\\(`));
    }
  });

  it('assigns session_id unconditionally — it is the whole point of adopting', () => {
    // COALESCE here would make the adopt a no-op on the column that matters.
    expect(adopt).toMatch(/SET session_id = \$\{opts\.sessionId\}/);
  });
});

describe('toIsoTimestamp', () => {
  it('passes Date objects through to ISO', () => {
    const value = new Date('2026-05-24T20:38:01.608Z');
    expect(toIsoTimestamp(value)).toBe('2026-05-24T20:38:01.608Z');
  });

  it('normalizes postgres text timestamps to ISO', () => {
    expect(toIsoTimestamp('2026-05-24 16:38:01.608162-04')).toBe('2026-05-24T20:38:01.608Z');
  });

  it('returns null for nullish values', () => {
    expect(toIsoTimestamp(null)).toBeNull();
    expect(toIsoTimestamp(undefined)).toBeNull();
  });

  it('throws on invalid timestamps', () => {
    expect(() => toIsoTimestamp('not-a-timestamp')).toThrow(/invalid timestamp/i);
  });
});

/**
 * WI-6821 — the owner clicked "+ new session", the launch died, and the popup sat
 * on "Starting up — waiting for this session to come online…" because NOTHING
 * ever marked the row failed. A dead launch and a still-booting one were
 * indistinguishable, so the roster advertised the corpse for the whole window and
 * the only correction was a 60s client-side timer (a guess, not evidence).
 *
 * These pin the two predicates that make the difference an OBSERVATION. Both are
 * pure with an injected `pidAlive`, so the decision is provable without spawning
 * real processes — which is the point: detection must be testable, not merely
 * watched in production.
 */
describe('terminal-launch death detection (WI-6821)', () => {
  const launch = (over: Partial<AdvSessionRow> = {}): AdvSessionRow =>
    ({
      id: 1,
      display: 'terminal',
      pid: 4242,
      sessionId: null,
      endedAt: null,
      ...over,
    }) as AdvSessionRow;

  const gone = () => false;
  const alive = () => true;

  describe('isDeadTerminalLaunch', () => {
    it('calls a terminal launch dead when its pid is gone and it never registered', () => {
      expect(isDeadTerminalLaunch(launch(), gone)).toBe(true);
    });

    it('never calls a launch dead while its terminal process is still alive', () => {
      expect(isDeadTerminalLaunch(launch(), alive)).toBe(false);
    });

    // The safe direction, and the one that matters under pid-wrap (~daily on this
    // box): a RECYCLED pid can only ever read alive, so wrap can make us MISS a
    // dead launch — it can never make us declare a live one dead.
    it('treats a registered session as booted even if its recorded pid is gone', () => {
      expect(isDeadTerminalLaunch(launch({ sessionId: 'sess-1' }), gone)).toBe(false);
    });

    // No handle means NO EVIDENCE. Guessing here would fabricate a diagnosis,
    // which is the exact bug class this item exists to remove.
    it('says nothing about a launch with no recorded pid', () => {
      expect(isDeadTerminalLaunch(launch({ pid: null }), gone)).toBe(false);
    });

    it('leaves an already-reconciled row alone', () => {
      expect(isDeadTerminalLaunch(launch({ endedAt: '2026-08-02T02:25:00.000Z' }), gone)).toBe(
        false,
      );
    });

    // Only `display='terminal'` rows are local by construction, which is what
    // makes the pid a sound liveness handle without a host column.
    it('refuses to probe a row that is not a terminal launch', () => {
      expect(isDeadTerminalLaunch(launch({ display: 'workbench' }), gone)).toBe(false);
      expect(isDeadTerminalLaunch(launch({ display: null }), gone)).toBe(false);
    });
  });

  describe('isFailedTerminalLaunch', () => {
    it('reads failure off PERSISTED state — ended, never registered', () => {
      expect(isFailedTerminalLaunch(launch({ endedAt: '2026-08-02T02:25:00.000Z' }))).toBe(true);
    });

    it('is false while the launch is still within its boot window', () => {
      expect(isFailedTerminalLaunch(launch())).toBe(false);
    });

    // A session that booted and later ended is an ORDINARY end and belongs in the
    // `ended` list — calling it a failed launch would be a second kind of lie.
    it('is false for a session that registered before it ended', () => {
      expect(
        isFailedTerminalLaunch(launch({ endedAt: '2026-08-02T02:25:00.000Z', sessionId: 'sess-1' })),
      ).toBe(false);
    });
  });

  // We never reap this process — it is not our child — so we never observe a
  // status. Writing a sentinel would invent a fact, which is precisely the
  // failure mode being fixed; `session_id IS NULL` is the marker we actually know.
  it('the reconciler stamps ended_at and does NOT invent an exit_code', () => {
    const stmt = SOURCE.split('UPDATE harness_shared.adv_sessions')
      .slice(1)
      .map((tail) => tail.slice(0, tail.indexOf('`')))
      .find((s) => s.includes('session_id IS NULL') && s.includes('ended_at = now()'));
    expect(stmt).toBeDefined();
    expect(stmt).not.toMatch(/exit_code\s*=/);
  });

  // Dropping the row instead of flagging it would leave SessionChatModal to fall
  // through to "No recent Claude session found for this agent" — replacing a
  // spinner with a shrug. The tier must still SELECT the failed row.
  it('the starting tier still selects launches that ended without registering', () => {
    expect(SOURCE).toMatch(/AND \(ended_at IS NULL OR session_id IS NULL\)/);
  });
});
