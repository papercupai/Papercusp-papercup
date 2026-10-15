import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  adminEnd: vi.fn(async () => {}),
  appEnd: vi.fn(async () => {}),
  migrate: vi.fn(async () => ({ ok: true })),
  gate: vi.fn(async () => ({ ok: true })),
}));
vi.mock('@papercusp/db-org', () => ({
  getOrgPg: () => ({ sql: { end: fixture.adminEnd } }),
  getOrgPgApp: () => ({ sql: { end: fixture.appEnd } }),
}));
vi.mock('../../../packages/operator-core/lib/harness-registry', () => ({ loadHarnessRegistry: vi.fn() }));
vi.mock('../../../packages/operator-core/lib/acceptance-bar-migration', () => ({ runAcceptanceBarMigrationInDatabase: fixture.migrate }));
vi.mock('../../../packages/operator-core/lib/agent-tools/plans/plan-start-gate', () => ({ checkPlanStartable: fixture.gate }));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('one-shot plan fixture pool lifecycle', () => {
  it.each(['success', 'migration failure', 'gate refusal'])('closes the admin and migration app pools after %s', async outcome => {
    vi.resetModules();
    fixture.adminEnd.mockClear();
    fixture.appEnd.mockClear();
    fixture.migrate.mockReset().mockResolvedValue({ ok: true });
    fixture.gate.mockReset().mockResolvedValue({ ok: outcome !== 'gate refusal' });
    if (outcome === 'migration failure') fixture.migrate.mockRejectedValue(new Error('migration failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('VERIFY_TAURI_ISOLATED_DB', '1');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'verify-tauri-isolated-lifecycle');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgres://localhost:23456/fixture');
    process.argv = [process.execPath, 'fixture-child.mjs', 'plan', 'e2e-fake-plan', 'fixture-plan'];
    process.exitCode = undefined;
    await (await import('./_fake-llm-fixture-child')).fixtureChildCompletion;
    expect(fixture.adminEnd).toHaveBeenCalledTimes(1);
    expect(fixture.appEnd).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(outcome === 'success' ? undefined : 1);
    expect(fixture.gate).toHaveBeenCalledTimes(outcome === 'migration failure' ? 0 : 1);
  });
});
