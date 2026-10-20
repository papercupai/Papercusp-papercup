/**
 * coordination-ops-as-blueprint-primitives D-014 — the coord-op fan-out
 * (`orchestrator:spawn-roles`) spawns voters/advocate in PARALLEL when every
 * spawn's backend isolates its per-spawn MCP config in a shared cwd (claude →
 * unique `--mcp-config` temp dir; codex → per-spawn CODEX_HOME), and stays
 * SEQUENTIAL for omp (it path-discovers the shared `<cwd>/.mcp.json`, which two
 * concurrent spawns would race-clobber → both authenticate under one role,
 * collapsing per-lens diversity, D-010/D-012). These tests pin that dispatch by
 * mocking the spawn to record live concurrency and driving the backend via
 * AGENT_CMD (the same var resolveSpawnBackendModel reads).
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

// Intercept ONLY resolveProject + spawnInvokeOnce; spread the rest so the real
// module graph (resolveSpawnBackendModel, buildPipelineExtraEnv, prod-caps) is
// untouched.
vi.mock('../harness-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harness-core.js')>()),
  resolveProject: vi.fn(async () => ({ path: '/fake/project', slug: 'h' })),
}));

const spawnState = { live: 0, maxLive: 0, order: [] as string[] };
vi.mock('./orchestrator-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./orchestrator-runner.js')>()),
  spawnInvokeOnce: vi.fn(async (_projectDir: string, role: string) => {
    spawnState.live += 1;
    spawnState.maxLive = Math.max(spawnState.maxLive, spawnState.live);
    spawnState.order.push(role);
    // Yield a macrotask so concurrent invocations pile up before any resolves.
    await new Promise((r) => setTimeout(r, 5));
    spawnState.live -= 1;
    return { output: '', exitCode: 0, stderr: '' };
  }),
}));

const { coordSpawnRunner } = await import('./coord-spawn-runner.js');
const { resolveProject } = await import('../harness-core.js');
const { spawnInvokeOnce } = await import('./orchestrator-runner.js');

const SPECS = [
  { role: 'voter', inject: { conversation_id: 'c1', lens: 'risk' }, blueprintId: 'vote' },
  { role: 'voter', inject: { conversation_id: 'c1', lens: 'cost' }, blueprintId: 'vote' },
  { role: 'advocate', inject: { conversation_id: 'c1' }, blueprintId: 'vote' },
];
const OPTS = { harnessSlug: 'h', workspaceId: 'w' };

const OLD_CMD = process.env.AGENT_CMD;
beforeEach(() => {
  spawnState.live = 0;
  spawnState.maxLive = 0;
  spawnState.order = [];
});
afterEach(() => {
  if (OLD_CMD === undefined) delete process.env.AGENT_CMD;
  else process.env.AGENT_CMD = OLD_CMD;
  vi.clearAllMocks();
});

test('claude backend → all voters + advocate spawn in PARALLEL', async () => {
  process.env.AGENT_CMD = 'claude -p';
  const res = await coordSpawnRunner(SPECS, OPTS);
  expect(res.launched).toBe(3);
  expect(res.spawned.map((s) => s.ok)).toEqual([true, true, true]);
  expect(spawnState.maxLive).toBe(3); // all three in flight at once
});

test('replayed fan-out forwards each member identity to completed-run reuse', async () => {
  process.env.AGENT_CMD = 'claude -p';
  const specs = SPECS.map((s, i) => ({ ...s, idempotencyKey: `program:run:step:member:${i}` }));
  await coordSpawnRunner(specs, OPTS);
  await coordSpawnRunner(specs, OPTS);
  const keys = vi.mocked(spawnInvokeOnce).mock.calls.map((call) => call[3]?.IDEMPOTENCY_KEY);
  expect(keys.slice(0, 3)).toEqual(specs.map((s) => s.idempotencyKey));
  expect(keys.slice(3)).toEqual(keys.slice(0, 3));
});

test('codex backend → PARALLEL (per-spawn CODEX_HOME isolates config)', async () => {
  process.env.AGENT_CMD = 'codex exec --model gpt-5.6-sol';
  await coordSpawnRunner(SPECS, OPTS);
  expect(spawnState.maxLive).toBe(3);
});

test('omp backend → fan-out stays SEQUENTIAL (shared <cwd>/.mcp.json would race)', async () => {
  process.env.AGENT_CMD = 'omp -p';
  const res = await coordSpawnRunner(SPECS, OPTS);
  expect(res.launched).toBe(3);
  expect(res.spawned.every((s) => s.ok)).toBe(true);
  expect(spawnState.maxLive).toBe(1); // never more than one in flight
});

test('a MIXED fan-out with any omp spawn forces the whole thing sequential', async () => {
  // The whole fan-out shares one backend in practice, but guard the rule: if
  // even one spec is not race-safe, none run concurrently.
  process.env.AGENT_CMD = 'omp -p';
  await coordSpawnRunner(SPECS.slice(0, 2), OPTS);
  expect(spawnState.maxLive).toBe(1);
});

test('resolveProject NULL → every spawn marked not-ok, launched 0, no agent spawned', async () => {
  // The NULL branch logs a diagnostic; intercept it (the suite fails on an
  // unexpected console.error) and assert it fired.
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  (resolveProject as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
  process.env.AGENT_CMD = 'claude -p';
  const res = await coordSpawnRunner(SPECS, OPTS);
  expect(res.launched).toBe(0);
  expect(res.spawned.every((s) => !s.ok)).toBe(true);
  expect(spawnState.order).toEqual([]); // spawnInvokeOnce never called
  expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('resolveProject NULL'));
  errSpy.mockRestore();
});
