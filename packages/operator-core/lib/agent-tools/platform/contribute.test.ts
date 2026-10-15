/**
 * contribute.test.ts — the platform:contribute HANDLER guards, delegation, and the
 * audit-only-when-sent rule (the composition contributeUpstream is seam-injected +
 * unit-tested separately). platform:contribute is the OUTWARD-FACING leg of platform
 * mode (git push / PR / Comb publish), so its handler discipline matters:
 *   • ROOT-ONLY — a bee (source 'fleet-spawn') is refused;
 *   • it passes the kind + resolved workspace + the per-kind args through;
 *   • it records an audit ONLY for a genuinely SENT contribution — a prepared/dry-run
 *     (the default "prepared, not sent" result) must NOT leave an outward audit trail.
 * A regression that audits a dry-run, or lets a bee contribute upstream, is what this
 * catches.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/platform/contribute.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../workspace-registry', () => ({
  activeWorkspaceId: vi.fn(() => 'default'),
  resolveConcreteWorkspaceId: vi.fn((...candidates: Array<string | null | undefined>) =>
    candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() && candidate.trim() !== '*')?.trim() ?? 'default',
  ),
}));
vi.mock('../../flag-audit', () => ({ recordFlagAudit: vi.fn() }));
vi.mock('../../pot/contribute-upstream', () => ({ contributeUpstream: vi.fn() }));
vi.mock('../../pot/enable-platform-mode', () => ({ PLATFORM_SELF_POT_SLUG: 'papercusp-platform' }));

import { resolveAgentIdentity } from '../coordination/identity';
import type { AgentIdentity } from '../coordination/identity';
import { contributeUpstream } from '../../pot/contribute-upstream';
import { recordFlagAudit } from '../../flag-audit';
const ident = vi.mocked(resolveAgentIdentity);
const contribM = vi.mocked(contributeUpstream);
const auditM = vi.mocked(recordFlagAudit);
/** Partial identity — the handler reads only `source`. A checked assertion, not `as never`. */
const identity = (source: AgentIdentity['source']) => ({ source }) as AgentIdentity;
const tool = (await import('./contribute')).default;

type Out = { content: { text: string }[] };
const ctx = { workspaceId: 'ws-1', principal: { slug: 'avi', workspaceId: 'ws-1' } };
const call = (args: Record<string, unknown>) =>
  tool.handler({ reason: 'contributing for tests', ...args } as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  ident.mockReturnValue({ source: 'operator' } as never);
  contribM.mockResolvedValue({ ok: true, prepared: true, needs: ['fork_remote'] } as never);
  auditM.mockResolvedValue(undefined);
});

describe('platform:contribute guards + delegation', () => {
  it('refuses a bee (fleet-spawn) — root-only — with no outward action', async () => {
    ident.mockReturnValue(identity('fleet-spawn'));
    const b = body(await call({ kind: 'knowledge-pack' }));
    expect(b).toMatchObject({ ok: false, error: 'platform_contribute_root_only' });
    expect(contribM).not.toHaveBeenCalled();
  });

  it('delegates with the kind + resolved workspace and returns the composition result', async () => {
    const b = body(await call({ kind: 'knowledge-pack' }));
    expect(b).toMatchObject({ ok: true, prepared: true, needs: ['fork_remote'] });
    expect(contribM).toHaveBeenCalledTimes(1);
    expect(contribM.mock.calls[0]![0]).toMatchObject({ kind: 'knowledge-pack', workspaceId: 'ws-1' });
  });

  it('passes per-kind pr args through to the composition', async () => {
    await call({ kind: 'pr', confirm: true, featureBranch: 'fix/x', prTitle: 'Fix x' });
    expect(contribM.mock.calls[0]![0]).toMatchObject({
      kind: 'pr', confirm: true, featureBranch: 'fix/x', prTitle: 'Fix x',
    });
  });

  it('passes a report through the same contribution core and retains queued status', async () => {
    const report = { text: 'Export crashes', reportContext: { appVersion: '0.0.1' } };
    contribM.mockResolvedValue({ ok: true, kind: 'report', queued: true } as never);
    const result = body(await call({ kind: 'report', confirm: true, report }));
    expect(result).toMatchObject({ queued: true });
    expect(result).not.toHaveProperty('sent');
    expect(contribM.mock.calls[0]![0]).toMatchObject({ kind: 'report', confirm: true, workspaceId: 'ws-1', report });
    expect(auditM).not.toHaveBeenCalled();
  });

  it('keeps reports root-only too, without invoking the contribution core', async () => {
    ident.mockReturnValue(identity('fleet-spawn'));
    expect(body(await call({ kind: 'report', confirm: true, report: { text: 'Export crashes' } })))
      .toMatchObject({ error: 'platform_contribute_root_only' });
    expect(contribM).not.toHaveBeenCalled();
  });
});

describe('platform:contribute audit-only-when-sent', () => {
  it('does NOT audit a prepared (not-sent) contribution', async () => {
    contribM.mockResolvedValue({ ok: true, prepared: true } as never);
    await call({ kind: 'knowledge-pack', confirm: true });
    expect(auditM).not.toHaveBeenCalled();
  });

  it('audits a genuinely sent contribution', async () => {
    contribM.mockResolvedValue({ ok: true, sent: true, kind: 'knowledge-pack' } as never);
    await call({ kind: 'knowledge-pack', confirm: true });
    expect(auditM).toHaveBeenCalledTimes(1);
    expect(String(auditM.mock.calls[0]![3]?.reason)).toMatch(/platform:contribute \(knowledge-pack\)/);
  });
});
