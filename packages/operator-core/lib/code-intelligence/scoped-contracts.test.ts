import { describe, expect, it, vi } from 'vitest';
import { scopedContractQuery, type ScopedContractEffects } from './scoped-contracts';

const principal = { slug: 'test:reader', workspaceId: 'workspace-a', capabilities: new Set(['intel:read']) };
const context = { principal, workspaceId: 'workspace-a', harnessSlug: '*', role: 'operator' as const };
const effects = () => ({ registry: vi.fn(), worker: vi.fn() }) as ScopedContractEffects & {
  registry: ReturnType<typeof vi.fn>; worker: ReturnType<typeof vi.fn>;
};
describe('native P019 contract authorization before registry or source IO', () => {
  it.each([
    { ...context, principal: undefined },
    { ...context, principal: { ...principal, workspaceId: '*' } },
    { ...context, principal: { ...principal, capabilities: new Set<string>() } },
    { ...context, workspaceId: 'workspace-b' },
  ])('fails closed for missing, wildcard, ungranted or conflicting workspace principals', async ctx => {
    const io = effects();
    const result = await scopedContractQuery({ harnesses: ['service'] }, ctx, io);
    expect(result.status).toBe('unknown'); expect(result.error).toBeTruthy();
    expect(result.repositories).toEqual([]); expect(result.relationships).toEqual([]);
    expect(io.registry).not.toHaveBeenCalled(); expect(io.worker).not.toHaveBeenCalled();
  });
  it('rejects an explicit foreign workspace before loading its registry', async () => {
    const io = effects();
    const result = await scopedContractQuery({ workspace: 'workspace-b', harnesses: ['service'] }, context, io);
    expect(result.error).toContain('workspace'); expect(io.registry).not.toHaveBeenCalled();
  });
  it('never expands a transport-bound harness through caller-supplied selectors', async () => {
    const io = effects();
    const result = await scopedContractQuery({ harnesses: ['service', 'secret'] }, { ...context, harnessSlug: 'service' }, io);
    expect(result.error).toContain('harness scope'); expect(io.registry).not.toHaveBeenCalled(); expect(io.worker).not.toHaveBeenCalled();
  });
  it('keeps operator cross-harness admission distinct from a concrete caller harness', async () => {
    const io = effects(); io.registry.mockResolvedValue({ projects: [] });
    const result = await scopedContractQuery({ harnesses: ['service'] }, context, io);
    expect(io.registry).toHaveBeenCalledWith('workspace-a');
    expect(result.error).toContain('not registered');
  });
  it.each([[], ['*'], ['all']].map(harnesses => ({ harnesses })))('does not interpret an absent/wildcard cohort as a global registry read', async ({ harnesses }) => {
    const io = effects();
    expect((await scopedContractQuery({ harnesses }, context, io)).error).toBeTruthy();
    expect(io.registry).not.toHaveBeenCalled();
  });
  it('uses the existing operator/oracle cross-harness boundary', async () => {
    const io = effects();
    expect((await scopedContractQuery({ harnesses: ['service'] }, { ...context, role: 'worker' as never }, io)).error).toBeTruthy();
    expect(io.registry).not.toHaveBeenCalled();
  });
  it('does not launch source workers for an unregistered repository', async () => {
    const io = effects(); io.registry.mockResolvedValue({ projects: [] });
    const result = await scopedContractQuery({ harnesses: ['secret'] }, context, io);
    expect(io.registry).toHaveBeenCalledWith('workspace-a'); expect(io.worker).not.toHaveBeenCalled();
    expect(result.error).toContain('not registered'); expect(result.candidates).toEqual([]);
  });
});
