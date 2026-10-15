import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertFixtureApiSuccess, assertFixturePlanReadback, fixtureChildFailure, fixtureChildWasGateRefusal, seedFakeLlmHarness, seedFakeLlmPlanAcceptance } from './_fake-llm-fixture';

const childCalls = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  execFile: (file: string, args: string[], options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
    childCalls(file, args, options);
    callback(null, '', '');
  },
}));

afterEach(() => vi.unstubAllEnvs());

describe('isolated chat fixture write boundary', () => {
  it('verifies exact persisted raw bytes and the CAS revision before migration', () => {
    const authored = '\n## Requirements\n\n**R-1 — Actual gate.**\n';
    expect(() => assertFixturePlanReadback({ ok: true, contentHash: 'saved', raw: authored }, 'saved', authored)).not.toThrow();
    // The real default sections response has no raw document. Neither its
    // section index nor a legacy content field proves an exact round trip.
    expect(() => assertFixturePlanReadback({ ok: true, contentHash: 'saved', sectionIndex: [{ heading: 'Requirements' }] }, 'saved', authored)).toThrow('hasRaw');
    expect(() => assertFixturePlanReadback({ ok: true, contentHash: 'saved', content: authored }, 'saved', authored)).toThrow('mismatch');
    expect(() => assertFixturePlanReadback({ ok: true, contentHash: 'old', raw: authored }, 'saved', authored)).toThrow('mismatch');
    expect(() => assertFixturePlanReadback({ ok: true, contentHash: 'saved', raw: authored.trim() }, 'saved', authored)).toThrow('mismatch');
    expect(() => assertFixturePlanReadback({ ok: true, raw: authored }, undefined, authored)).toThrow('mismatch');
    expect(() => assertFixturePlanReadback({ error: 'not_found' }, 'saved', authored)).toThrow('refused');
  });
  it('rejects HTTP-success domain refusals before continuing fixture setup', () => {
    expect(() => assertFixtureApiSuccess('set-content', { error: 'lint_failed', slug: 'fixture' })).toThrow('lint_failed');
    expect(() => assertFixtureApiSuccess('set-content', {})).toThrow('refused');
    expect(() => assertFixtureApiSuccess('set-content', { ok: false })).toThrow('refused');
    expect(() => assertFixtureApiSuccess('set-content', { ok: true, error: 'stale' })).toThrow('stale');
    expect(() => assertFixtureApiSuccess('set-content', { ok: true, contentHash: 'new' })).not.toThrow();
  });
  it('runs both fixtures from the frozen plain-node bundle with the original deadline', async () => {
    vi.stubEnv('VERIFY_TAURI_ISOLATED_DB', '1');
    vi.stubEnv('OPERATOR_SOURCE_ROOT', '/frozen-source');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', 'verify-tauri-isolated-test');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgres://localhost:23456/fixture');
    childCalls.mockClear();
    expect(await seedFakeLlmHarness({ hive: true })).toBe('e2e-fake-plan');
    await seedFakeLlmPlanAcceptance('e2e-fake-plan', 'authored-plan');
    expect(childCalls.mock.calls.map(call => call.slice(0, 2))).toEqual([
      [process.execPath, ['/frozen-source/apps/operator/dist-verify/fake-llm-fixture-child.mjs', 'harness', 'e2e-fake-plan']],
      [process.execPath, ['/frozen-source/apps/operator/dist-verify/fake-llm-fixture-child.mjs', 'plan', 'e2e-fake-plan', 'authored-plan']],
    ]);
    for (const [, , options] of childCalls.mock.calls) {
      expect(options).toMatchObject({ cwd: '/frozen-source', timeout: 30_000, env: { DATABASE_URL: 'postgres://localhost:23456/fixture' } });
    }
  });
  it('does not mistake gate text echoed in the command for a real child refusal', () => {
    const timeout = fixtureChildFailure({
      message: "Command failed: node -e throw new Error('Plan fixture launch precondition failed:')",
      code: null, signal: 'SIGTERM', killed: true,
      stdout: '', stderr: 'plan-fixture stage=migration-import:start\n',
    });
    expect(fixtureChildWasGateRefusal(timeout)).toBe(false);
    expect(fixtureChildWasGateRefusal(fixtureChildFailure({
      code: 1, stderr: 'Error: Plan fixture launch precondition failed: missing BAR\n    at fixture',
    }))).toBe(true);
    expect(fixtureChildWasGateRefusal(fixtureChildFailure({
      code: 1, message: 'Plan fixture launch precondition failed:', stderr: 'Error: unrelated failure',
    }))).toBe(false);
    expect(fixtureChildWasGateRefusal(null)).toBe(false);
  });
  it('retains child stderr and distinguishes a timeout from a gate refusal', () => {
    const timeout = fixtureChildFailure({ message: 'Command failed', killed: true, signal: 'SIGTERM', stdout: 'stage: import' });
    const refusal = fixtureChildFailure({ message: 'Command failed', code: 1, stderr: 'Plan fixture launch precondition failed: missing BAR' });
    expect(timeout.message).toContain('SIGTERM');
    expect(timeout.message).toContain('stage: import');
    expect(refusal.message).toContain('missing BAR');
    expect(refusal.message).toContain('"code":1');
  });
  it.each([
    ['papercusp-workspace', 'postgres://localhost:23456/fixture'],
    ['verify-tauri-isolated-test', 'postgres://localhost:5432/papercusp'],
    ['verify-tauri-isolated-test', 'postgres://remote.example:23456/fixture'],
    ['verify-tauri-isolated-test', 'postgres://localhost/fixture'],
  ])('refuses workspace %s and database %s before starting a fixture writer', async (workspace, database) => {
    vi.stubEnv('VERIFY_TAURI_ISOLATED_DB', '1');
    // A nonexistent source would produce a child-loader error if the guard
    // let the shared/remote database through.
    vi.stubEnv('OPERATOR_SOURCE_ROOT', '/nonexistent-chat-fixture-root');
    vi.stubEnv('PAPERCUSP_WORKSPACE_ID', workspace);
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', database);
    await expect(seedFakeLlmHarness()).rejects.toThrow(/Missing isolated chat fixture context|Refusing shared chat fixture database/);
  });

  it('does not seed an existing workspace outside the maintained isolated rig', async () => {
    vi.stubEnv('VERIFY_TAURI_ISOLATED_DB', '0');
    vi.stubEnv('HARNESS_ADMIN_DATABASE_URL', 'postgres://remote.example:5432/live');
    expect(await seedFakeLlmHarness()).toBe('main');
  });
});
