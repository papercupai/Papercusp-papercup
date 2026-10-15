import { afterEach, describe, expect, it, vi } from 'vitest';

/** A full snake_case adv_sessions DB row (what postgres-js hands back). */
const dbRow = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 1,
  workspace_id: 'ws1',
  plan_slug: null,
  agent: 'claude',
  role: 'worker',
  feature: 'F-001',
  mode: 'console',
  terminal_bin: null,
  pid: 100,
  window_id: null,
  omp_thread_id: null,
  label: null,
  cwd: '/repo',
  coord_owner_id: 'su-1',
  started_at: '2026-06-02T00:00:00.000Z',
  ended_at: null,
  exit_code: null,
  ...over,
});

describe('adv-sessions coord_owner_id wiring (P-001/P-003)', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@papercusp/db-org');
    vi.doUnmock('./workspace-registry');
    vi.doUnmock('./blueprint/support-workflow-native-launch');
    vi.doUnmock('./session-end-lease-release-hook');
    vi.doUnmock('./session-archive-hook');
  });

  function mockSql(impl: (...a: unknown[]) => Promise<unknown>): ReturnType<typeof vi.fn> {
    const sql = vi.fn(impl);
    vi.doMock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql }) }));
    vi.doMock('./workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
    return sql;
  }

  it('releases a private native route only after the exact session terminal CAS wins', async () => {
    const sql = mockSql(async () => [{ id: 7 }]);
    const stop = vi.fn(async () => {});
    vi.doMock('./blueprint/support-workflow-native-launch', () => ({ stopSupportOperationNativeLaunch: stop }));
    vi.doMock('./session-end-lease-release-hook', () => ({ scheduleSessionEndLeaseRelease: vi.fn() }));
    vi.doMock('./session-archive-hook', () => ({ scheduleArchiveForAdvSession: vi.fn() }));
    const mod = await import('./adv-sessions');
    await expect(mod.markAdvSessionEnded(7, 0, 'self')).resolves.toBe(true);
    expect(stop).toHaveBeenCalledExactlyOnceWith(7);
    sql.mockResolvedValueOnce([]);
    await expect(mod.markAdvSessionEnded(7, 0, 'self', { observedAt: new Date(0) })).resolves.toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('recordAdvSession passes coordOwnerId into the INSERT params', async () => {
    const sql = mockSql(async () => [{ id: 7 }]);
    const mod = await import('./adv-sessions');
    await expect(
      mod.recordAdvSession({ mode: 'console', coordOwnerId: 'su-abc', label: 't' }),
    ).resolves.toBe(7);
    const values = sql.mock.calls[0]?.slice(1) ?? [];
    expect(values).toContain('su-abc'); // the SID lands in the row
  });

  it('advSessionsByCoordOwner keys by coord_owner_id, most-recent (first) wins, skips null owners', async () => {
    mockSql(async () => [
      dbRow({ id: 2, coord_owner_id: 'su-1', role: 'newer' }), // ORDER BY started_at DESC → first = newest
      dbRow({ id: 1, coord_owner_id: 'su-1', role: 'older' }),
      dbRow({ id: 3, coord_owner_id: 'su-2', role: 'other' }),
      dbRow({ id: 4, coord_owner_id: null }), // no owner → not in the map
    ]);
    const mod = await import('./adv-sessions');
    const map = await mod.advSessionsByCoordOwner();
    expect(map.size).toBe(2);
    expect(map.get('su-1')?.id).toBe(2);
    expect(map.get('su-1')?.role).toBe('newer'); // first wins
    expect(map.get('su-2')?.role).toBe('other');
  });

  it('latestLiveAdvSessionByLabel threads label+workspace params and maps the row (docs-agent reuse)', async () => {
    const sql = mockSql(async () => [dbRow({ id: 5, label: 'docs-tutor', coord_owner_id: 'su-tutor' })]);
    const mod = await import('./adv-sessions');
    const row = await mod.latestLiveAdvSessionByLabel('docs-tutor', 'ws-x');
    expect(row?.id).toBe(5);
    expect(row?.coordOwnerId).toBe('su-tutor');
    const values = sql.mock.calls[0]?.slice(1) ?? [];
    expect(values).toContain('docs-tutor'); // label filter
    expect(values).toContain('ws-x'); // workspace scope
  });

  it('latestLiveAdvSessionByLabel returns null when no live labelled session exists', async () => {
    mockSql(async () => []);
    const mod = await import('./adv-sessions');
    await expect(mod.latestLiveAdvSessionByLabel('docs-tutor', 'ws-x')).resolves.toBeNull();
  });

  it('listEndedAdvSessions maps rows and threads the workspace scope + limit params', async () => {
    const sql = mockSql(async () => [dbRow({ id: 9, ended_at: '2026-06-02T01:00:00.000Z' })]);
    const mod = await import('./adv-sessions');
    const rows = await mod.listEndedAdvSessions({ workspaceId: 'ws9', limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(9);
    expect(rows[0]?.endedAt).toBe('2026-06-02T01:00:00.000Z');
    expect(rows[0]?.coordOwnerId).toBe('su-1');
    // WI-6055: workspace scope is carried by a nested postgres.js fragment;
    // inspect both the fragment-construction and outer-query calls.
    const values = sql.mock.calls.flatMap((call) => call.slice(1));
    expect(values).toContain('ws9'); // scope param interpolated
    expect(values).toContain(10); // limit
  });

  it('listResumableSessions restores harness scope from the persisted launch spec', async () => {
    const sql = mockSql(async () => [dbRow({
      id: 12,
      harness_slug: 'papercusp',
      launch_spec: { v: 1, workspaceId: 'ws1', harnessSlug: 'papercusp' },
    })]);
    const mod = await import('./adv-sessions');
    const rows = await mod.listResumableSessions();
    expect(rows[0]?.harnessSlug).toBe('papercusp');

    const strings = sql.mock.calls.at(-1)?.[0] as TemplateStringsArray | undefined;
    const query = strings ? Array.from(strings).join(' ? ') : '';
    expect(query).toContain("'launch_spec'");
    expect(query).toContain("'harnessSlug'");
  });

  /*
   * WI-6510 regression guard. `launch_argv` is OPTIONAL on `AdvSessionDbRow`
   * ("only the pending-launch query SELECTs it"), so removing it from this
   * query's column list is NOT a type error: `mapAdvSessionRow` maps the absent
   * column to null, the roster's `adv?.launchArgv ?? []` turns that into an
   * empty argv, and the chat MODEL pill then reports "no model recorded" for
   * EVERY live agent while the DB row holds the full spec.
   *
   * That is exactly what shipped: unit tests and typecheck were green and the
   * pill did not render at all in a live drive. Both halves are asserted here
   * because either one alone passes while the feature is broken — the column
   * must be SELECTed, and it must survive the mapping onto the entry.
   */
  it('advSessionsByCoordOwner SELECTs launch_argv and maps it onto the entry (WI-6510)', async () => {
    const argv = ['psu', '--agent=claude', '--model=sonnet[1m]:high'];
    const sql = mockSql(async () => [dbRow({ id: 11, coord_owner_id: 'su-live', launch_argv: argv })]);
    const mod = await import('./adv-sessions');
    const map = await mod.advSessionsByCoordOwner();

    // Half 1 — the column is actually loaded.
    // postgres.js builds empty/conditional fragments before executing SELECT.
    const strings = sql.mock.calls
      .map((call) => call[0] as TemplateStringsArray | undefined)
      .find((parts) => parts && Array.from(parts).join(' ').includes('SELECT'));
    const query = strings ? Array.from(strings).join(' ? ') : '';
    expect(query).toContain('launch_argv');

    // Half 2 — it survives onto the mapped row the roster reads.
    expect(map.get('su-live')?.launchArgv).toEqual(argv);
  });

  it('listEndedAdvSessions excludes handleless terminal wrappers from agent history (WI-5103)', async () => {
    const sql = mockSql(async () => []);
    const mod = await import('./adv-sessions');
    await mod.listEndedAdvSessions({ workspaceId: 'ws9', limit: 30 });

    // The conditional workspace fragment is call 0; the SELECT is the final call.
    const strings = sql.mock.calls.at(-1)?.[0] as TemplateStringsArray | undefined;
    const query = strings ? Array.from(strings).join(' ? ') : '';
    // `/api/adv/sessions/ended` feeds the Agents-running inactive dropdown.
    // A `resume · …` console-launch wrapper has none of these three handles,
    // so it must never reach the UI as an unclickable pseudo-session. Each real
    // backend remains represented by the handle its transcript viewer accepts.
    expect(query).toContain("NULLIF(BTRIM(session_id), '') IS NOT NULL");
    expect(query).toContain("NULLIF(BTRIM(omp_thread_id), '') IS NOT NULL");
    expect(query).toContain("OR agent = 'codex'");
  });
});
