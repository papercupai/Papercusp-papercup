/**
 * P-009 — harness:generate-from-repo tool envelope tests. The dryRun / skip /
 * bad-path branches are PG-free (they never reach harness:create), so the ctx is
 * a minimal stub. The create branch is covered indirectly by the create tool's
 * own path; here we prove detection → override → validate → preview composes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import tool from '../generate_from_repo';

const mocks = vi.hoisted(() => ({
  createHandler: vi.fn(),
  resolveUpstreamRepoSource: vi.fn(),
  mutateHarnessRegistry: vi.fn(),
  seedGitSyncRoutineForMember: vi.fn(),
  claimPendingMcpResult: vi.fn(),
  finalizePendingMcpResult: vi.fn(),
  recordFromRepoStep: vi.fn(),
}));

vi.mock('../create', () => ({ default: { handler: mocks.createHandler } }));
vi.mock('../../../harness/upstream-repo-context', () => ({
  resolveUpstreamRepoSource: mocks.resolveUpstreamRepoSource,
}));
vi.mock('../../../harness-registry', () => ({
  mutateHarnessRegistry: mocks.mutateHarnessRegistry,
  // EI-9039: p2p/revocation-reaper top-level-imports this export and is reached
  // transitively from the subject, so it resolves against THIS partial mock.
  // Nothing here calls it — the stub only keeps collection from dying.
  deregisterEphemeralForeignHarness: vi.fn(async () => false),
}));
vi.mock('../../../harness/git-sync/git-sync-routine', () => ({
  seedGitSyncRoutineForMember: mocks.seedGitSyncRoutineForMember,
}));
vi.mock('../../../endpoint-route/routes/transport/_mcp-result-replay', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    claimPendingMcpResult: mocks.claimPendingMcpResult,
    finalizePendingMcpResult: mocks.finalizePendingMcpResult,
  };
});
vi.mock('../../../harness/from-repo-progress', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, recordFromRepoStep: mocks.recordFromRepoStep };
});

// Keep the object-typed base separate: spreading a `never`-typed value is a TS6 error (TS2698).
const CTX_BASE = { log() {}, workspaceId: 'ws', role: 'operator' };
const CTX = CTX_BASE as never;
const run = async (args: Record<string, unknown>, ctx = CTX) => {
  const res = (await tool.handler(args as never, ctx)) as { content: { text: string }[] };
  return JSON.parse(res.content[0].text);
};
const flushImmediate = () => new Promise<void>((resolve) => setImmediate(resolve));

const created: string[] = [];
// Background create runs the repo's real test command (npm -> node). Under gate load that is
// seconds, not milliseconds, so the two async-completion cases wait on observed state with a
// generous ceiling and carry a per-test timeout above it (the 5 s default would cut them first).
const BACKGROUND_COMPLETION_TIMEOUT_MS = 30_000;
const BACKGROUND_COMPLETION_TEST_TIMEOUT_MS = BACKGROUND_COMPLETION_TIMEOUT_MS + 15_000;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'p009-tool-'));
  created.push(root);
  mkdirSync(join(root, '.git'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}
afterEach(() => {
  for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.resetAllMocks();
});

describe('harness:generate-from-repo', () => {
  it('dryRun: detects + builds + validates an extends:coding override without creating', async () => {
    const root = fixture({
      'package.json': JSON.stringify({
        name: 'x',
        version: '1.0.0',
        scripts: { test: 'true' },
        dependencies: { vue: '^3' },
      }),
      'pnpm-lock.yaml': '',
      'CLAUDE.md': '# rules\n',
    });
    const r = await run({ slug: 'my-app', path: root, dryRun: true, runTests: false });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    expect(r.override.extends).toBe('coding-factory');
    expect(r.override.knobs.testCommand).toBe('pnpm test');
    expect(r.override.knobs.uiQa).toEqual({ enabled: true }); // vue → frontend → ui-qa
    expect(r.validation.ok).toBe(true);
    expect(r.validation.errors).toEqual([]);
    // The previewed YAML round-trips.
    expect(parseYaml(r.yaml).extends).toBe('coding-factory');
    expect(r.detection.testCommand.verified).toBeNull(); // runTests:false
    expect(r.detection.flags.frontend).toBe(true);
  });

  it('skips a repo that already has a blueprint', async () => {
    const root = fixture({ '.papercusp/blueprint.yaml': 'id: existing\n' });
    const r = await run({ slug: 'dup', path: root, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.skipped).toBe(true);
    expect(r.reason).toContain('already has');
  });

  it('errors on a non-existent path', async () => {
    const r = await run({ slug: 'nope', path: '/no/such/path/xyz', dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('does not exist');
  });

  it('persists discovered upstream coordinates and seeds recurring git-sync after create', async () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'mobile', scripts: { test: 'true' } }),
      'package-lock.json': '',
    });
    mocks.createHandler.mockResolvedValue({
      content: [
        { type: 'text', text: JSON.stringify({ ok: true, slug: 'mobile', path: root, provisioning: { ok: true } }) },
      ],
    });
    mocks.resolveUpstreamRepoSource.mockResolvedValue({
      github_remote: 'https://github.com/Papercusp/mobile.git',
      default_branch: 'master',
      owner: 'Papercusp',
      repo: 'mobile',
      source: 'git-remote',
    });

    let persisted: Record<string, unknown> | undefined;
    mocks.mutateHarnessRegistry.mockImplementation(
      async (mutator: (reg: Record<string, unknown>) => Record<string, unknown>, workspaceId: string) => {
        persisted = mutator({ projects: [{ slug: 'mobile', path: root }] });
        return persisted;
      },
    );
    mocks.seedGitSyncRoutineForMember.mockResolvedValue({
      seeded: true,
      active: true,
      push: true,
      pushReason: 'creator_can_push',
      cron: '0 5,15,25,35,45,55 * * * *',
      branch: 'master',
    });

    const r = await run({ slug: 'mobile', path: root, dryRun: false, runTests: false });

    expect(r.ok).toBe(true);
    expect(r.upstream).toEqual({
      remote: 'https://github.com/Papercusp/mobile.git',
      defaultBranch: 'master',
      source: 'git-remote',
    });
    expect(r.gitSync).toMatchObject({ seeded: true, active: true, push: true, branch: 'master' });
    expect(mocks.mutateHarnessRegistry).toHaveBeenCalledWith(expect.any(Function), 'ws');
    expect(persisted).toMatchObject({
      projects: [
        {
          slug: 'mobile',
          path: root,
          github_remote: 'https://github.com/Papercusp/mobile.git',
          github_default_branch: 'master',
        },
      ],
    });
    expect(mocks.seedGitSyncRoutineForMember).toHaveBeenCalledWith({
      workspaceId: 'ws',
      installSlug: 'mobile',
      entry: {
        slug: 'mobile',
        path: root,
        github_remote: 'https://github.com/Papercusp/mobile.git',
        github_default_branch: 'master',
      },
      joinerSide: false,
    });
  });

  it('accepts an idempotent MCP create before async detection/test verification completes', async () => {
    const root = fixture({
      'package.json': JSON.stringify({
        name: 'slow-mobile',
        scripts: { test: 'node -e "setTimeout(() => {}, 150)"' },
      }),
      'package-lock.json': '',
    });
    const dispatchTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe('harness:create');
      expect(args).toMatchObject({ slug: 'slow-mobile', path: root });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, slug: 'slow-mobile', path: root, provisioning: { ok: true } }),
          },
        ],
      };
    });
    let pending: Record<string, unknown> | undefined;
    mocks.claimPendingMcpResult.mockImplementation(async (input: { result: Record<string, unknown> }) => {
      pending = input.result;
      return { claimed: true, pending: true, result: input.result };
    });
    mocks.finalizePendingMcpResult.mockResolvedValue(true);
    const ctx = {
      ...CTX_BASE,
      transport: 'mcp',
      idempotencyKey: 'generate-slow-1',
      uiClientId: 'client-1',
      spawnId: 'spawn-1',
      dispatchTool,
      emit: vi.fn(),
      progress: vi.fn(),
    } as never;

    const r = await run(
      { slug: 'slow-mobile', path: root, dryRun: false, runTests: true, testTimeoutMs: 300_000 },
      ctx,
    );

    // Acceptance precedes completion, asserted by ORDER rather than a 100 ms wall-clock bound:
    // the detected test command alone sleeps 150 ms, so finalize cannot have fired yet unless
    // run() awaited the background work.
    expect(mocks.finalizePendingMcpResult).not.toHaveBeenCalled();
    expect(r).toMatchObject({
      ok: true,
      accepted: true,
      status: 'in_progress',
      slug: 'slow-mobile',
    });
    expect(typeof r.progressId).toBe('string');
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(mocks.claimPendingMcpResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKey: 'client-1',
        idempotencyKey: 'generate-slow-1',
        toolName: 'harness:generate-from-repo',
        workspaceId: 'ws',
        result: expect.objectContaining({
          _meta: expect.objectContaining({
            state: 'pending',
            progressId: r.progressId,
          }),
        }),
      }),
    );

    // Wait for the OBSERVABLE completion, not a fixed wall-clock budget. Background detection
    // spawns the repo's real test command (npm -> node), and under green-checkpoint load that
    // took past a 3 s budget (run 014f2801 on c697f739: file 3180 ms, dispatchTool 0 calls).
    // The ceiling only matters on failure; success returns as soon as finalize fires.
    await vi.waitFor(() => expect(mocks.finalizePendingMcpResult).toHaveBeenCalled(), {
      timeout: BACKGROUND_COMPLETION_TIMEOUT_MS,
      interval: 20,
    });
    expect(pending).toBeDefined();
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(mocks.finalizePendingMcpResult).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerKey: 'client-1',
        idempotencyKey: 'generate-slow-1',
        toolName: 'harness:generate-from-repo',
        workspaceId: 'ws',
        result: expect.objectContaining({
          content: [
            expect.objectContaining({
              text: expect.stringContaining('"ok":true'),
            }),
          ],
        }),
      }),
    );
    expect(mocks.recordFromRepoStep).toHaveBeenCalledWith(
      r.progressId,
      'detect',
      'running',
      expect.any(Object),
    );
    expect(mocks.recordFromRepoStep).toHaveBeenCalledWith(
      r.progressId,
      'seed',
      'done',
      expect.any(Object),
    );
  }, BACKGROUND_COMPLETION_TEST_TIMEOUT_MS);

  it('does not launch a duplicate background create when the same idempotency key is retried while pending', async () => {
    const root = fixture({
      'package.json': JSON.stringify({ name: 'retry-mobile', scripts: { test: 'true' } }),
      'package-lock.json': '',
    });
    const dispatchTool = vi.fn(async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok: true, slug: 'retry-mobile', path: root, provisioning: { ok: true } }),
        },
      ],
    }));
    const pendingResults: Record<string, unknown>[] = [];
    mocks.claimPendingMcpResult
      .mockImplementationOnce(async (input: { result: Record<string, unknown> }) => {
        pendingResults.push(input.result);
        return { claimed: true, pending: true, result: input.result };
      })
      .mockImplementationOnce(async () => ({
        claimed: false,
        pending: true,
        result: pendingResults[0],
      }));
    mocks.finalizePendingMcpResult.mockResolvedValue(true);
    const ctx = {
      ...CTX_BASE,
      transport: 'mcp',
      idempotencyKey: 'generate-retry-1',
      uiClientId: 'client-retry',
      spawnId: 'spawn-retry',
      dispatchTool,
      emit: vi.fn(),
      progress: vi.fn(),
    } as never;

    const first = await run(
      { slug: 'retry-mobile', path: root, dryRun: false, runTests: false, testTimeoutMs: 300_000 },
      ctx,
    );
    const second = await run(
      { slug: 'retry-mobile', path: root, dryRun: false, runTests: false, testTimeoutMs: 300_000 },
      ctx,
    );

    expect(first).toMatchObject({ accepted: true, status: 'in_progress' });
    expect(second).toMatchObject({ accepted: true, status: 'in_progress', progressId: first.progressId });
    expect(dispatchTool).not.toHaveBeenCalled();

    await flushImmediate();
    await flushImmediate();
    await vi.waitFor(() => expect(mocks.finalizePendingMcpResult).toHaveBeenCalled(), {
      timeout: BACKGROUND_COMPLETION_TIMEOUT_MS,
      interval: 10,
    });
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(mocks.claimPendingMcpResult).toHaveBeenCalledTimes(2);
    expect(mocks.finalizePendingMcpResult).toHaveBeenCalledTimes(1);
  }, BACKGROUND_COMPLETION_TEST_TIMEOUT_MS);
});
