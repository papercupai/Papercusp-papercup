/**
 * git-sync:send-green (P-020) — the agent door onto sendStandingPrNow. The behaviour of
 * sendStandingPrNow itself is covered against real git in
 * harness/git-sync/working-copy-standing-pr.integration.test.ts; this pins the tool's
 * wiring: slug/workspace resolution, the fixed `main` ref, and the ok flag per outcome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CTX = { log: vi.fn(), signal: new AbortController().signal, progress: vi.fn(), role: 'operator' } as never;

function parse(result: unknown): Record<string, unknown> {
  const output = result as { data?: Record<string, unknown>; content?: Array<{ text: string }> };
  return output.data ?? JSON.parse(output.content![0].text);
}

function mockCommon(repoDir: string | null) {
  vi.doMock('../../harness/operator-home-harness', () => ({ operatorHomeHarnessSlug: () => 'home-pot' }));
  vi.doMock('../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-1' }));
  vi.doMock('../../operator-notes', () => ({ projectDirForSlug: vi.fn(async () => repoDir) }));
}

function mockSend(outcome: unknown) {
  const send = vi.fn(async () => outcome);
  vi.doMock('../../harness/git-sync/promotion-push-target', () => ({
    sendStandingPrNow: send,
    createDefaultSendStandingPrNowDeps: vi.fn(async () => ({ marker: 'deps' })),
  }));
  return send;
}

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.doUnmock('../../harness/operator-home-harness');
  vi.doUnmock('../../workspace-registry');
  vi.doUnmock('../../operator-notes');
  vi.doUnmock('../../harness/git-sync/promotion-push-target');
});

describe('git-sync:send-green', () => {
  it('sends the working copy main for the resolved pot and reports the PR', async () => {
    mockCommon('/repos/pot');
    const send = mockSend({
      kind: 'sent',
      potHomeSlug: 'pot',
      sha: 'a'.repeat(40),
      standingPr: { ok: true, action: 'updated', number: 7 },
    });
    const { default: tool } = await import('./send_green');

    const result = parse(await tool.handler({ harness: 'pot' }, CTX));

    expect(send).toHaveBeenCalledWith({ repoPath: '/repos/pot', workspaceId: 'ws-1', ref: 'main' }, { marker: 'deps' });
    expect(result).toMatchObject({ ok: true, slug: 'pot', kind: 'sent', sha: 'a'.repeat(40) });
  });

  it('defaults to the operator home harness and reports a failed PR refresh as not ok', async () => {
    mockCommon('/repos/home');
    mockSend({
      kind: 'sent',
      potHomeSlug: 'home-pot',
      sha: 'b'.repeat(40),
      standingPr: { ok: false, stage: 'setup', error: 'no GitHub token' },
    });
    const { default: tool } = await import('./send_green');

    const result = parse(await tool.handler({}, CTX));

    expect(result).toMatchObject({ ok: false, slug: 'home-pot', kind: 'sent' });
  });

  it('passes direct-mode and nothing-green answers through as ok', async () => {
    mockCommon('/repos/pot');
    mockSend({ kind: 'nothing-green', message: 'nothing has passed the gate' });
    const { default: tool } = await import('./send_green');

    expect(parse(await tool.handler({ installSlug: 'pot' }, CTX))).toMatchObject({ ok: true, kind: 'nothing-green' });
  });

  it('refuses when the pot has no registered repository, without touching git', async () => {
    mockCommon(null);
    const send = mockSend({ kind: 'not-review', message: 'x' });
    const { default: tool } = await import('./send_green');

    const result = parse(await tool.handler({ harness: 'ghost' }, CTX));

    expect(send).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: false, slug: 'ghost' });
  });

  it('reports a thrown error instead of failing the call', async () => {
    mockCommon('/repos/pot');
    vi.doMock('../../harness/git-sync/promotion-push-target', () => ({
      sendStandingPrNow: vi.fn(async () => {
        throw new Error('ls-remote failed');
      }),
      createDefaultSendStandingPrNowDeps: vi.fn(async () => ({})),
    }));
    const { default: tool } = await import('./send_green');

    expect(parse(await tool.handler({ harness: 'pot' }, CTX))).toMatchObject({ ok: false, error: 'ls-remote failed' });
  });

  it('rejects unknown args', async () => {
    mockCommon('/repos/pot');
    mockSend({ kind: 'not-review', message: 'x' });
    const { default: tool } = await import('./send_green');

    expect(tool.args.safeParse({ ref: 'staging' }).success).toBe(false);
  });
});
