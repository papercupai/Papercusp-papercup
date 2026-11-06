import { resolve } from 'node:path';
import { loadConfigFromFile } from 'vite';
import { describe, expect, it, vi } from 'vitest';
import { prepareRuntimeReader, waitForRuntimeWitness } from '../vitest.e2e.config';
import { unitExcludedVitestTest } from '../../../scripts/lib/related-tests.mjs';

describe('operator e2e config loading', () => {
  it('observes the owned native verifier on both reads without loading the shared runtime ledger', async () => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'packages/operator-core/test/parked-agent-audit.live-profile.json');
    vi.stubEnv('PAPERCUSP_SID', 'test-session');
    vi.stubEnv('PAPERCUSP_WORKSPACE', 'test-workspace');
    vi.stubEnv('VERIFY_TAURI_PID', '1234');
    vi.stubEnv('VERIFY_TAURI_SOURCE_REF', 'a'.repeat(40));
    const load = vi.fn(); const pg = vi.fn();
    const read = vi.fn().mockReturnValueOnce({ fingerprint: 'before' }).mockReturnValueOnce(null);
    const prepareNativeRuntimeReader = vi.fn(() => read);
    try {
      const reader = await prepareRuntimeReader(load, pg, async () => ({ prepareNativeRuntimeReader }));
      expect(prepareNativeRuntimeReader).toHaveBeenCalledWith(resolve(import.meta.dirname, '../../..'), 'a'.repeat(40));
      expect(await reader!()).toEqual({ fingerprint: 'before' });
      expect(await reader!()).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
      expect(load).not.toHaveBeenCalled();
      expect(pg).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['refused', 'unavailable'])('fails closed on %s native custody without a shared-runtime fallback', async (failure) => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'packages/operator-core/test/parked-agent-audit.live-profile.json');
    vi.stubEnv('PAPERCUSP_SID', 'test-session');
    vi.stubEnv('PAPERCUSP_WORKSPACE', 'test-workspace');
    vi.stubEnv('VERIFY_TAURI_PORT', '23170');
    const load = vi.fn(); const pg = vi.fn();
    try {
      await expect(prepareRuntimeReader(load, pg, async () => ({
        prepareNativeRuntimeReader: () => {
          if (failure === 'refused') throw new Error('native source custody refused');
          return undefined;
        },
      }))).rejects.toThrow(failure === 'refused' ? 'native source custody refused' : 'live-profile-native-runtime-unavailable');
      expect(load).not.toHaveBeenCalled();
      expect(pg).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['PAPERCUSP_SID', 'PAPERCUSP_WORKSPACE'])(
    'refuses missing %s in the parked live profile before loading the live graph', async (name) => {
      vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
        'packages/operator-core/test/parked-agent-audit.live-profile.json');
      vi.stubEnv('PAPERCUSP_SID', 'test-session');
      vi.stubEnv('PAPERCUSP_WORKSPACE', 'test-workspace');
      vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'ledger-workspace');
      vi.stubEnv(name, '  ');
      const load = vi.fn();
      const pg = vi.fn();
      try {
        await expect(prepareRuntimeReader(load, pg)).rejects.toThrow('live-profile-required-env-missing:' + name);
        expect(load).not.toHaveBeenCalled();
        expect(pg).not.toHaveBeenCalled();
      } finally { vi.unstubAllEnvs(); }
    },
  );

  it.each([
    ['staging', 'packages/operator-core/test/fixtures/session-recovery.live-profile.json', 'http://127.0.0.1:9171', '3170'],
    ['release', 'packages/operator-core/test/fixtures/session-recovery-release.live-profile.json', 'http://127.0.0.1:3170', '3070'],
  ])('rejects a %s session-recovery URL that disagrees with its profile before loading runtime code', async (_route, profile, operatorUrl, expectedPort) => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE', profile);
    vi.stubEnv('PAPERCUSP_OPERATOR_URL', operatorUrl);
    vi.stubEnv('PAPERCUSP_SID', 'test-session');
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'test-workspace');
    const load = vi.fn();
    const pg = vi.fn();
    try {
      await expect(prepareRuntimeReader(load, pg)).rejects.toThrow(
        `live-profile-selected-operator-port-mismatch:expected-${expectedPort}`,
      );
      expect(load).not.toHaveBeenCalled();
      expect(pg).not.toHaveBeenCalled();
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    ['staging', 'packages/operator-core/test/fixtures/session-recovery.live-profile.json', 'http://127.0.0.1:3170'],
    ['release', 'packages/operator-core/test/fixtures/session-recovery-release.live-profile.json', 'http://127.0.0.1:3070'],
  ])('accepts the %s session-recovery URL declared by its profile', async (_route, profile, operatorUrl) => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE', profile);
    vi.stubEnv('PAPERCUSP_OPERATOR_URL', operatorUrl);
    vi.stubEnv('PAPERCUSP_SID', 'test-session');
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'test-workspace');
    const load = vi.fn(async () => ({
      listRuntimeVintage: vi.fn(async () => []),
      measureRuntimeVintageEnvironment: vi.fn(() => null),
    }));
    const pg = vi.fn();
    try {
      expect(await prepareRuntimeReader(load, pg)).toBeTypeOf('function');
      expect(load).toHaveBeenCalledOnce();
      expect(pg).toHaveBeenCalledOnce();
    } finally { vi.unstubAllEnvs(); }
  });

  it('waits for a late runtime-vintage fingerprint before selecting the live runtime', async () => {
    const witness = { fingerprint: 'a'.repeat(64) };
    const read = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(witness);
    const sleep = vi.fn(async () => {});
    await expect(waitForRuntimeWitness(read, { sleep })).resolves.toEqual(witness);
    expect(read).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('bounds selected-runtime convergence when the host witness never arrives', async () => {
    let elapsedMs = 0;
    const read = vi.fn(async () => null);
    const sleep = vi.fn(async (milliseconds: number) => { elapsedMs += milliseconds; });
    await expect(waitForRuntimeWitness(read, {
      timeoutMs: 600,
      now: () => elapsedMs,
      sleep,
    })).rejects.toThrow('live-profile-runtime-vintage-not-ready-after-600ms');
    expect(read).toHaveBeenCalledTimes(3);
    expect(elapsedMs).toBe(600);
  });

  it.each(['integration', 'e2e'])('refuses incomplete parked profile inputs while loading the %s config', async (layer) => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'packages/operator-core/test/parked-agent-audit.live-profile.json');
    vi.stubEnv('PAPERCUSP_SID', 'test-session');
    vi.stubEnv('PAPERCUSP_WORKSPACE', '');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadConfigFromFile(
        { command: 'serve', mode: 'test' }, resolve(import.meta.dirname, `../vitest.${layer}.config.ts`),
      )).rejects.toThrow('live-profile-required-env-missing:PAPERCUSP_WORKSPACE');
      expect(consoleError).toHaveBeenCalled();
    } finally { consoleError.mockRestore(); vi.unstubAllEnvs(); }
  });

  it.each(['0', '1'])('requires an owner only for the enabled bounded-current route (flag=%s)', async (flag) => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'packages/operator-core/test/parked-agent-audit.live-profile.json');
    vi.stubEnv('PAPERCUSP_SID', 'test-session');
    vi.stubEnv('PAPERCUSP_WORKSPACE', 'test-workspace');
    vi.stubEnv('PAPERCUSP_PARKED_CURRENT_LIVE', flag);
    vi.stubEnv('PAPERCUSP_PARKED_AUDIT_OWNER', '');
    const load = vi.fn(async () => ({}));
    const pg = vi.fn();
    try {
      if (flag === '1') {
        await expect(prepareRuntimeReader(load, pg)).rejects.toThrow('live-profile-required-env-missing:PAPERCUSP_PARKED_AUDIT_OWNER');
        expect(load).not.toHaveBeenCalled();
      } else {
        expect(await prepareRuntimeReader(load, pg)).toBeTypeOf('function');
        expect(load).toHaveBeenCalledOnce();
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(['integration', 'e2e'])('uses the selected live-profile runtime reader in the %s layer', async (layer) => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/gateway-admission-congestion-only-2026-10-13/live-runtime-profile.json');
    vi.stubEnv('PAPERCUSP_WOE_SERVED_AUDIT', '0');
    vi.stubEnv('PAPERCUSP_TEST_POSTHOG_LIVE', 'false');
    try {
      const loaded = await loadConfigFromFile(
        { command: 'serve', mode: 'test' }, resolve(import.meta.dirname, `../vitest.${layer}.config.ts`),
        undefined, undefined, undefined, 'native',
      );
      expect(loaded!.config.test!.provide!.papercuspTestLayer).toBe(layer);
      expect(loaded!.config.test!.reporters).toEqual(expect.arrayContaining([
        [expect.any(String), expect.objectContaining({ readRuntimeEnvironment: expect.any(Function) })],
      ]));
      expect(loaded!.dependencies.some(path => /runtime-vintage\.ts$/.test(path))).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it('selects paid blueprint routing proof only through the explicit e2e lane', async () => {
    const file = 'lib/blueprint/launch-blueprint-account-route.e2e.test.ts';
    for (const config of ['vitest.config.ts', 'vitest.integration.config.ts']) {
      const loaded = await loadConfigFromFile(
        { command: 'serve', mode: 'test' }, resolve(import.meta.dirname, '..', config),
      );
      expect(loaded!.config.test!.exclude).toContain(file);
    }
    expect(unitExcludedVitestTest(resolve(import.meta.dirname, '..', file))).toBe(true);
    expect(unitExcludedVitestTest('lib/blueprint/launch-blueprint.test.ts')).toBe(false);
    expect(unitExcludedVitestTest('lib/other-existing.e2e.test.ts')).toBe(false);
    const live = await loadConfigFromFile(
      { command: 'serve', mode: 'test' }, resolve(import.meta.dirname, '../vitest.e2e.config.ts'),
    );
    expect(live!.config.test!.provide!.papercuspTestLayer).toBe('e2e');
    expect(live!.config.test!.include).toContain('**/*.e2e.test.ts');
    expect(live!.config.test!.exclude).not.toContain(file);
  });

  it.each(['', 'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json'])(
    'loads the optional runtime reader without bundling operator PG code (profile=%s)', async (profile) => {
      vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE', profile);
      try {
        const loaded = await loadConfigFromFile(
          { command: 'serve', mode: 'test' }, resolve(import.meta.dirname, '../vitest.e2e.config.ts'),
        );
        expect(loaded).not.toBeNull();
        expect(loaded!.config.test?.provide?.papercuspTestLayer).toBe('e2e');
        expect(loaded!.dependencies.some(path => /runtime-vintage\.ts$/.test(path))).toBe(false);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('finishes loader preparation before returning a reader and reuses it for both observations', async () => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json');
    const listRuntimeVintage = vi.fn(async () => []);
    const measureRuntimeVintageEnvironment = vi.fn(() => 'a'.repeat(64));
    const sql = { end: vi.fn(async () => {}) };
    const pg = vi.fn(() => sql);
    let release!: (value: Record<string, unknown>) => void;
    const load = vi.fn(() => new Promise<Record<string, unknown>>(resolve => { release = resolve; }));
    try {
      let prepared = false;
      const preparation = prepareRuntimeReader(load, async () => pg as any)
        .then(reader => { prepared = true; return reader; });
      await Promise.resolve();
      expect(prepared).toBe(false);
      expect(listRuntimeVintage).not.toHaveBeenCalled();
      release({ listRuntimeVintage, measureRuntimeVintageEnvironment });
      const reader = await preparation;
      expect(await reader!()).toMatchObject({ fingerprint: 'a'.repeat(64) });
      expect(await reader!()).toMatchObject({ fingerprint: 'a'.repeat(64) });
      expect(load).toHaveBeenCalledTimes(1);
      expect(listRuntimeVintage).toHaveBeenCalledTimes(2);
      expect(measureRuntimeVintageEnvironment).toHaveBeenCalledTimes(2);
      expect(sql.end).toHaveBeenCalledTimes(2);
    } finally { vi.unstubAllEnvs(); }
  });

  it('reads runtime witnesses from the reporter ledger instead of an embedded app database', async () => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json');
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', 'postgresql://localhost:5432/papercusp');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgresql://embedded.test:24680/papercusp');
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'shared-ledger-workspace');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'verify-tauri-isolated-fixture');
    const sql = { end: vi.fn(async () => {}) };
    const pg = vi.fn(() => sql);
    const rows = [{ unit: 'actual-live-runtime' }];
    const listRuntimeVintage = vi.fn(async (workspace, client) => {
      expect(workspace).toBe('shared-ledger-workspace');
      expect(client).toBe(sql);
      return rows;
    });
    const measureRuntimeVintageEnvironment = vi.fn(() => 'b'.repeat(64));
    try {
      const reader = await prepareRuntimeReader(async () => ({
        listRuntimeVintage, measureRuntimeVintageEnvironment,
      }), async () => pg as any);
      expect(await reader!()).toMatchObject({ fingerprint: 'b'.repeat(64) });
      expect(pg).toHaveBeenCalledWith('postgresql://localhost:5432/papercusp', expect.objectContaining({
        host: '127.0.0.1',
        max: 1,
        connect_timeout: 1,
      }));
      expect(listRuntimeVintage).toHaveBeenCalledWith('shared-ledger-workspace', sql, expect.any(Array));
      expect(measureRuntimeVintageEnvironment).toHaveBeenCalledWith(rows, expect.any(Array));
      expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
    } finally { vi.unstubAllEnvs(); }
  });

  it('closes the observation client when the runtime ledger read fails', async () => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json');
    const sql = { end: vi.fn(async () => {}) };
    const pg = vi.fn(() => sql);
    try {
      const reader = await prepareRuntimeReader(async () => ({
        listRuntimeVintage: async () => { throw new Error('runtime ledger unavailable'); },
        measureRuntimeVintageEnvironment: vi.fn(),
      }), async () => pg as any);
      await expect(reader!()).rejects.toThrow('runtime ledger unavailable');
      expect(sql.end).toHaveBeenCalledWith({ timeout: 0 });
    } finally { vi.unstubAllEnvs(); }
  });

  it.each([
    ['remote plain', 'postgresql://ledger.example:5432/papercusp', ''],
    ['localhost TLS', 'postgresql://localhost:5432/papercusp?sslmode=verify-full', ''],
    ['localhost with PGSSL', 'postgresql://localhost:5432/papercusp', 'require'],
  ])('preserves the %s runtime-witness route', async (_route, url, pgSsl) => {
    vi.stubEnv('PAPERCUSP_APP_OPERATION_LIVE_PROFILE',
      'docs/evidence/app-agent-tasks-durable-execution-2026-10-06/live-e2e-profile-20261007.json');
    vi.stubEnv('PAPERCUSP_TEST_RUNS_DB_URL', url);
    vi.stubEnv('PAPERCUSP_TEST_RUN_WORKSPACE', 'shared-ledger-workspace');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'verify-tauri-isolated-fixture');
    vi.stubEnv('PGSSL', pgSsl);
    const sql = { end: vi.fn(async () => {}) };
    let actualUrl: string | undefined;
    let actualOptions: Record<string, unknown> | undefined;
    const pg = vi.fn((target: string, options: Record<string, unknown>) => {
      actualUrl = target;
      actualOptions = options;
      return sql;
    });
    try {
      const reader = await prepareRuntimeReader(async () => ({
        listRuntimeVintage: async () => [],
        measureRuntimeVintageEnvironment: () => 'c'.repeat(64),
      }), async () => pg as any);
      await reader!();
      expect(actualUrl).toBe(url);
      expect(actualOptions).toMatchObject({
        max: 1,
        connect_timeout: 1,
        onnotice: expect.any(Function),
      });
      expect(actualOptions).not.toHaveProperty('host');
    } finally { vi.unstubAllEnvs(); }
  });
});
