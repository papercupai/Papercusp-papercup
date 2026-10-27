import { afterEach, describe, expect, it, vi } from 'vitest';

describe('adv_sessions port-column rollout compatibility (WI-4936)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('./workspace-registry');
  });

  function installSql(result: unknown[] = []) {
    const sql = vi.fn(async (..._args: unknown[]) => result);
    // `getAdvSession` runs its read inside `boundedOrgTxn`, which calls
    // `sql.begin(fn)`. A bare tag function has no `.begin`, so without this the
    // read throws "sql.begin is not a function", the surface swallows it via
    // warnUnlessMissingTable, and the assertions below see an EMPTY query — a
    // failure that reads like "the SQL lost its to_jsonb() guard" rather than
    // "the mock is missing a method". Re-entering the SAME mock keeps every
    // query recorded on one call list.
    (sql as unknown as { begin: (fn: (tx: unknown) => unknown) => unknown }).begin = async (
      fn: (tx: unknown) => unknown,
    ) => fn(sql);
    // SPREAD the real module and override ONLY getOrgPg. A hand-listed factory
    // ({ getOrgPg }) strands the moment adv-sessions reaches for any OTHER
    // db-org export: the import throws `No "X" export is defined on the mock`,
    // warnUnlessMissingTable swallows it, and the assertions below see an EMPTY
    // query — indistinguishable from "the SQL lost its to_jsonb() guard". That
    // is exactly how this test broke on DEFAULT_TX_ACQUIRE_DEADLINE_MS (which
    // boundedOrgTxn began reading), holding the release gate. Spreading keeps a
    // future export from re-breaking it.
    vi.doMock('@papercusp/db-org', async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      getOrgPg: () => ({ sql }),
    }));
    vi.doMock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    return sql;
  }

  /** Recorded query texts, EXCLUDING the transaction setup statements boundedOrgTxn
   *  issues to arm read-only mode and SET LOCAL statement_timeout/lock_timeout. Those are txn
   *  plumbing, not read surfaces under test — counting them would shift every
   *  positional assertion below by two the moment a surface adopts the txn. */
  const queriesOf = (sql: ReturnType<typeof vi.fn>): string[] =>
    sql.mock.calls
      .map((c) => (c?.[0] as TemplateStringsArray | undefined)?.join('?') ?? '')
      .filter((q) => !q.includes('set_config') && !q.includes('SET TRANSACTION READ ONLY'));

  const textOf = (sql: ReturnType<typeof vi.fn>, call = 0) => queriesOf(sql)[call] ?? '';

  it('ordinary recordAdvSession keeps the legacy INSERT while migration 611 is pending', async () => {
    const sql = installSql([{ id: 7 }]);
    const mod = await import('./adv-sessions');
    await expect(mod.recordAdvSession({ mode: 'console', agent: 'claude', cwd: '/repo' })).resolves.toBe(7);
    expect(textOf(sql)).not.toContain('port_id');
    expect(textOf(sql)).not.toContain('port_status');
  });

  it('only an actual port target opts into the post-611 INSERT and fails closed on old schema', async () => {
    const sql = installSql([{ id: 8 }]);
    const mod = await import('./adv-sessions');
    await expect(mod.recordAdvSession({
      mode: 'console', agent: 'codex', cwd: '/repo',
      portId: '22222222-2222-4222-8222-222222222222',
      portSourceAdvSessionId: 7,
      portStatus: 'pending',
    })).resolves.toBe(8);
    expect(textOf(sql)).toContain('port_id');
    expect(textOf(sql)).toContain('port_status');
  });

  it('ordinary read surfaces extract optional lineage through to_jsonb(row), never a parse-time column reference', async () => {
    const sql = installSql([]);
    const mod = await import('./adv-sessions');
    await mod.listAdvSessions();
    await mod.getAdvSession(1);
    await mod.getAdvSessionInWorkspace(1, 'ws-test');
    for (let i = 0; i < 3; i++) {
      const query = textOf(sql, i);
      expect(query).toContain("to_jsonb(a)->>'port_id'");
      expect(query).toContain("to_jsonb(a)->>'port_status'");
      expect(query).not.toMatch(/exit_code,\s*port_id,/);
    }
  });

  it('getAdvSession restores the persisted harness scope for cold-wake resumes', async () => {
    const launchArgv = ['psu', '--account=default'];
    const sql = installSql([{ id: 42, workspace_id: 'ws-test', harness_slug: 'papercusp', launch_argv: launchArgv }]);
    const mod = await import('./adv-sessions');

    const row = await mod.getAdvSession(42);

    expect(row?.harnessSlug).toBe('papercusp');
    expect(row?.launchArgv).toEqual(launchArgv);
    expect(textOf(sql)).toContain("to_jsonb(a)->'launch_spec'->>'harnessSlug' AS harness_slug");
    expect(textOf(sql)).toContain("to_jsonb(a)->'launch_argv' AS launch_argv");
  });

  it('cancels an in-flight port source lookup when its caller aborts', async () => {
    const sql = installSql();
    const controller = new AbortController();
    const reason = new Error('port request abandoned');
    let started!: () => void;
    let finish!: (rows: unknown[]) => void;
    let rejectQuery!: (error: unknown) => void;
    const queryStarted = new Promise<void>((resolve) => { started = resolve; });
    const query = Object.assign(new Promise<unknown[]>((resolve, reject) => {
      finish = resolve;
      rejectQuery = reject;
    }), {
      executed: true,
      active: true,
      cancel: vi.fn(() => { rejectQuery(reason); }),
    });
    sql.mockImplementation((strings) => {
      if (Array.isArray(strings) && strings.join('').includes('FROM harness_shared.adv_sessions a')) {
        started();
        return query;
      }
      return Promise.resolve([]);
    });
    const mod = await import('./adv-sessions');
    const outcome = mod.getAdvSessionInWorkspace(42, 'ws-test', { signal: controller.signal }).then(
      () => ({ kind: 'resolved' }),
      (error: unknown) => ({ kind: 'rejected', error }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await queryStarted;
      controller.abort(reason);
      const observed = await Promise.race([
        outcome,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: 'still-running' }), 500); }),
      ]);
      expect(observed).toEqual({ kind: 'rejected', error: reason });
      expect(query.cancel).toHaveBeenCalledTimes(1);
    } finally {
      if (timer) clearTimeout(timer);
      finish([]);
      await outcome;
    }
  });

  it('refuses a pre-aborted port source lookup without starting SQL', async () => {
    const sql = installSql();
    const mod = await import('./adv-sessions');
    const controller = new AbortController();
    const reason = new Error('port request already abandoned');
    controller.abort(reason);

    await expect(mod.getAdvSessionInWorkspace(42, 'ws-test', { signal: controller.signal })).rejects.toBe(reason);
    expect(sql).not.toHaveBeenCalled();
  });

  it('reports a bounded source-read timeout instead of a missing session', async () => {
    const sql = installSql();
    sql.mockImplementation((strings) => {
      if (Array.isArray(strings) && strings.join('').includes('FROM harness_shared.adv_sessions a')) {
        return Promise.reject(Object.assign(new Error('statement timeout'), { code: '57014' }));
      }
      return Promise.resolve([]);
    });
    const mod = await import('./adv-sessions');

    await expect(mod.getAdvSessionInWorkspace(42, 'ws-test')).rejects.toMatchObject({
      name: 'OrgTxnTimeoutError', pgCode: '57014', timeoutSource: 'pg',
    });
  });

  it.each([false, true])('resumable filtering probes port-column availability (present=%s) without whole-row JSON scans', async (present) => {
    const sql = installSql([]).mockResolvedValueOnce([{ present }]);
    const mod = await import('./adv-sessions');
    await mod.listResumableSessions();
    expect(textOf(sql)).toContain('pg_attribute');
    expect(textOf(sql, 1)).toContain(present ? "COALESCE(a.port_status, 'delivered') = 'delivered'" : 'TRUE');
    expect(textOf(sql, 2)).not.toContain("to_jsonb(a)->>'port_status'");
  });
});
