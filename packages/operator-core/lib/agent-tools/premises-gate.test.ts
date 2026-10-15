import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  defineTool, lookupByMcpName, dispatchProjectedTool,
  type DispatchProjectedDeps, type ProjectedTool, type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { premiseFactStatus, resolveDispatchPremises, type PremiseFact } from './premises-gate';

// Registry inspection must not start the release config's boot-time PG refresh.
vi.mock('../release-checkpoint-config', () => ({
  releaseCheckpointConfigReady: Promise.resolve(),
  releaseCheckpointConfig: () => ({ stallReds: 3, stallAgeMs: 21600000,
    chronicFlakeCount: 3, flakeNotifyCooldownMs: 86400000, deployBackoffMs: 3600000 }),
}));

const ctx = (): UnifiedToolContext => ({ log: vi.fn(), emit: vi.fn(), progress: vi.fn(),
  signal: new AbortController().signal, workspaceId: 'premises-test', role: 'su' });
const fact: PremiseFact = { id: 1, confidence: 'verified', retracted_at: null, superseded_at: null, expired: false };
const tool = (fn: ProjectedTool['fn'] = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })), irreversible = true): ProjectedTool => ({
  pluginName: 'test', description: 'test', inputSchema: { type: 'object' }, capabilities: [],
  expose: { mcp: { name: 'test:premises' } }, irreversible, fn,
});

describe('dispatch-level premises', () => {
  it('marks forced deploy, destructive database and outward publishing calls irreversible', async () => {
    await import('./release/deploy');
    await import('./db/migrate');
    await import('./social/post');
    await import('./social/reply');
    await import('./mail/send');
    await import('./backup/restore');
    await import('./backup/rollback');
    await import('./backup/restore_clone_cleanup');
    for (const name of ['db:migrate', 'social:post', 'social:reply', 'mail:send', 'backup:rollback', 'backup:restore_clone_cleanup']) {
      expect(lookupByMcpName(name)?.irreversible, name).toBe(true);
    }
    const deploy = lookupByMcpName('release:deploy')!.irreversible as (args: unknown) => boolean;
    expect(deploy({ op: 'force', confirm: true })).toBe(true);
    expect(deploy({ op: 'force', confirm: false })).toBe(true);
    expect(deploy({ op: 'force', confirm: 'true' })).toBe(true);
    expect(deploy({ op: 'force' })).toBe(true);
    expect(deploy({ op: 'status' })).toBe(false);
    const restore = lookupByMcpName('backup:restore')!.irreversible as (args: unknown) => boolean;
    expect(restore({ mode: 'in_place' })).toBe(true);
    expect(restore({ mode: 'clone' })).toBe(false);
  }, 60_000);

  it.each(['missing', 'retracted', 'superseded', 'expired', 'provisional', 'suspected', 'unknown'] as const)(
    'refuses an irreversible call naming its %s premise before invoking', async status => {
      const fn = vi.fn();
      const recordInvocation = vi.fn();
      const result = await dispatchProjectedTool(tool(fn), 'test:premises', { premises: ['safe-to-publish'] }, ctx(), {
        resolvePremises: async refs => refs.map(ref => ({ ref, status })), recordInvocation,
      });
      expect(result.error?.code).toBe('premise_unconfirmed');
      expect(result.error?.message).toContain('safe-to-publish');
      expect(fn).not.toHaveBeenCalled();
      expect(recordInvocation.mock.calls[0][0].metadataJson.premises.refs).toEqual(['safe-to-publish']);
    });

  it('executes a confirmed call and protects the recorded premises from handler metadata', async () => {
    const recordInvocation = vi.fn();
    const fn = vi.fn(async (_args: unknown, context: UnifiedToolContext) => {
      context.metadata!({ premises: { provided: false }, other: 'kept' });
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    });
    const result = await dispatchProjectedTool(tool(fn), 'test:premises', { value: 7, premises: ['verified'] }, ctx(), {
      resolvePremises: async refs => refs.map(ref => ({ ref, status: 'confirmed', factId: 1 })), recordInvocation,
    });
    expect(result.ok).toBe(true);
    expect(fn.mock.calls[0][0]).toEqual({ value: 7 });
    expect(recordInvocation.mock.calls[0][0].metadataJson).toMatchObject({ other: 'kept',
      premises: { provided: true, refs: ['verified'], resolutions: [{ ref: 'verified', status: 'confirmed', factId: 1 }] } });
  });

  it('allows an irreversible call without premises and records that absence', async () => {
    const recordInvocation = vi.fn();
    expect((await dispatchProjectedTool(tool(), 'test:premises', {}, ctx(), { recordInvocation })).ok).toBe(true);
    expect(recordInvocation.mock.calls[0][0].metadataJson.premises).toMatchObject({ provided: false, refs: [], irreversible: true });
  });

  it.each(['missing', 'retracted'] as const)('records %s premises on reversible calls without blocking them', async status => {
    const recordInvocation = vi.fn();
    expect((await dispatchProjectedTool(tool(undefined, false), 'test:premises', { premises: ['unconfirmed'] }, ctx(), {
      resolvePremises: async () => [{ ref: 'unconfirmed', status }], recordInvocation,
    })).ok).toBe(true);
    expect(recordInvocation.mock.calls[0][0].metadataJson.premises.resolutions[0].status).toBe(status);
  });

  it('fails closed on a resolver failure when premises were supplied', async () => {
    const fn = vi.fn();
    const result = await dispatchProjectedTool(tool(fn), 'test:premises', { premises: ['known'] }, ctx(), {
      resolvePremises: async () => { throw new Error('store unavailable'); },
    });
    expect(result.error?.code).toBe('premise_unconfirmed');
    expect(fn).not.toHaveBeenCalled();
  });

  it('accepts premises before strict tool validation while preserving required and unknown-field checks', async () => {
    const run = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    defineTool({ name: 'test:strict-premises', requirePrincipal: false as const, capability: 'test:read', description: 'fixture',
      args: z.object({ value: z.number() }).strict(), handler: run });
    const projected = lookupByMcpName('test:strict-premises')!;
    expect((await dispatchProjectedTool(projected, 'test:strict-premises', { value: 4, premises: [] }, ctx(), {})).ok).toBe(true);
    expect((await dispatchProjectedTool(projected, 'test:strict-premises', { premises: [] }, ctx(), {})).error?.code).toBe('invalid_input');
    expect((await dispatchProjectedTool(projected, 'test:strict-premises', { value: 4, typo: true, premises: [] }, ctx(), {})).error?.code).toBe('invalid_input');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'key', [42], [''], Array(33).fill('key')])('refuses malformed premises %j', async premises => {
    const fn = vi.fn();
    expect((await dispatchProjectedTool(tool(fn), 'test:premises', { premises }, ctx(), {})).error?.code).toBe('invalid_input');
    expect(fn).not.toHaveBeenCalled();
  });

  it('forwards outer premises through tools:invoke without mutating the caller envelope', async () => {
    const fn = vi.fn(async (_args: unknown) => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
    const input = { name: 'target', args: { value: 4, premises: ['inner'] }, premises: ['outer'] };
    await dispatchProjectedTool(tool(fn, false), 'tools:invoke', input, ctx(), {});
    expect(fn.mock.calls[0][0]).toEqual({ name: 'target', args: { value: 4, premises: ['outer', 'inner'] } });
    expect(input.args.premises).toEqual(['inner']);
  });

  it('enforces forwarded outer premises at the actual irreversible target', async () => {
    const target = vi.fn();
    const outer = tool(async (args) => {
      const envelope = args as { args: unknown };
      const result = await dispatchProjectedTool(tool(target), 'publish:target', envelope.args, ctx(), {
        resolvePremises: async refs => refs.map(ref => ({ ref, status: 'suspected' })),
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    }, false);
    const result = await dispatchProjectedTool(outer, 'tools:invoke',
      { name: 'publish:target', args: {}, premises: ['outer-safety'] }, ctx(), {});
    expect(result.result?.content[0]).toMatchObject({ text: expect.stringContaining('premise_unconfirmed') });
    expect(target).not.toHaveBeenCalled();
  });

  it('threads static and call-sensitive irreversible markers through defineTool projections', async () => {
    defineTool({ name: 'test:marked-premises', capability: 'test:write', requirePrincipal: false as const,
      irreversible: args => args.force, args: z.object({ force: z.boolean() }),
      async handler() { return { data: { ok: true } }; } });
    const marked = lookupByMcpName('test:marked-premises')!;
    expect(typeof marked.irreversible).toBe('function');
    const deps: DispatchProjectedDeps = { resolvePremises: async refs => refs.map(ref => ({ ref, status: 'suspected' })) };
    expect((await dispatchProjectedTool(marked, 'test:marked-premises', { force: true, premises: ['safe'] }, ctx(), deps)).error?.code).toBe('premise_unconfirmed');
    expect((await dispatchProjectedTool(marked, 'test:marked-premises', { force: false, premises: ['safe'] }, ctx(), deps)).ok).toBe(true);
  });
});

describe('fact premise resolution', () => {
  it.each([
    [{ retracted_at: 'now' }, 'retracted'], [{ superseded_at: 'now' }, 'superseded'],
    [{ expired: true }, 'expired'], [{ confidence: 'provisional' }, 'provisional'],
    [{ confidence: 'suspected' }, 'suspected'], [{}, 'confirmed'],
  ] as const)('classifies fact state %j', (patch, status) => {
    expect(premiseFactStatus({ ...fact, ...patch })).toBe(status);
  });

  it('resolves missing and ambiguous identities conservatively and scopes SQL to the caller workspace', async () => {
    const sql = vi.fn((parts: TemplateStringsArray, ...values: unknown[]) => {
      if (!parts.join('').includes('SELECT id, confidence')) return { fragment: true };
      if (values.includes('absent')) return Promise.resolve([]);
      if (values.includes('ambiguous')) return Promise.resolve([fact, { ...fact, id: 2 }]);
      return Promise.resolve([fact]);
    });
    const results = await resolveDispatchPremises(['absent', 'ambiguous', 'exists'], ctx(), sql as never);
    expect(results.map(row => row.status)).toEqual(['missing', 'unknown', 'confirmed']);
    const queries = sql.mock.calls.filter(([parts]) => parts.join('').includes('SELECT id, confidence'));
    expect(queries[0]).toContain('premises-test');
    expect(queries[2]).toContain('exists');
  });
});
