import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoutLlmAdmission } from './run';
import type { BuildScoutCycleDepsOptions } from './cycle-deps';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

const seams = vi.hoisted(() => ({
  provider: vi.fn(),
  createDraft: vi.fn(async (args: { slug: string }) => ({ slug: args.slug, created: false })),
  revise: vi.fn(async () => ({ provenance: [], revisions: [], costUsd: 0 })),
  buildDeps: vi.fn((opts: any) => opts),
  runCycle: vi.fn(async (deps: any) => {
    await deps.llmCall({ model: 'gpt-5.6-luna:medium', messages: [{ role: 'user', content: 'candidate' }], maxTokens: 1024 });
    return { ideas: [], scored: [], proposals: [], routed: [], costUsd: 0.01 };
  }),
}));
vi.mock('./scout-cycle-action', () => ({ registerScoutCycleAction: vi.fn() }));
vi.mock('@papercusp/flags/server', async importOriginal => ({
  ...(await importOriginal<any>()), getFlag: vi.fn(async () => false),
}));
vi.mock('../llm-testing/llm-client', () => ({
  llmCall: seams.provider,
  backendForLlmCall: () => 'codex',
}));
vi.mock('./cycle-deps', () => ({ buildScoutCycleDeps: seams.buildDeps }));
vi.mock('./cycle', () => ({ runScoutCycle: seams.runCycle }));
vi.mock('./scout-plan-draft', async importOriginal => ({
  ...(await importOriginal<typeof import('./scout-plan-draft')>()), createScoutPlanDraft: seams.createDraft,
}));
vi.mock('./revise', () => ({ runScoutRevisionCycle: seams.revise }));
vi.mock('./dedup-burn-guard', () => ({
  readDedupBurnVerdict: async () => ({ saturated: false }),
  applyDedupBurnToConfig: (config: unknown) => config,
}));
import { noopArchive, productionScoutRunner, resetScoutProviderCapacityCache, setScoutArchiveBuilder } from './register-scout-action';

beforeEach(() => {
  vi.clearAllMocks();
  resetScoutProviderCapacityCache();
  setScoutArchiveBuilder(async () => noopArchive);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith('/stats') ? { healthyAccounts: 0, codexHealthyAccounts: 1 } :
      { providers: { codex: { configured: true, cliAccountCount: 1 } } },
  ))));
  seams.provider.mockResolvedValue({ text: 'ok', costUsd: 0.01, inputTokens: 10, outputTokens: 10 });
});
afterEach(() => { vi.unstubAllGlobals(); resetScoutProviderCapacityCache(); });

const ctx = {
  harnessSlug: 'fixture', workspaceId: 'fixture', cycleId: 'fixture-cycle',
  budget: { maxCostUsd: 1, maxIdeators: 1, maxCriticsPerIdea: 2 },
};
describe('production Scout caller admission', () => {
  it.each([
    ['workspace sentinel', 'ws-scout', operatorHomeHarnessSlug()],
    ['concrete Hive', 'team-hive', 'team-hive'],
  ])('creates plan drafts in the caller workspace for a %s', async (_label, harnessSlug, expectedHive) => {
    await productionScoutRunner({ ...ctx, workspaceId: 'ws-scout', harnessSlug });
    const deps = seams.buildDeps.mock.calls.at(-1)?.[0] as BuildScoutCycleDepsOptions;
    await deps.createPlanDraft({ slug: 'scout-scope', title: 'Scoped draft' });
    expect(seams.createDraft).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'scout-scope', workspaceId: 'ws-scout', harnessSlug: expectedHive,
    }));
    expect(deps.harnessSlug).toBe(harnessSlug);
  });

  it('revises singleton drafts in the same owning Hive and workspace used for creation', async () => {
    await productionScoutRunner({ ...ctx, workspaceId: 'ws-scout', harnessSlug: 'ws-scout', revisionRequests: [{
      planSlug: 'scout-scope', fromOwnerId: 'reviewer', msgId: 'review-1', body: 'Clarify the verification.', ts: '2026-10-18T00:00:00.000Z',
    }] });
    expect(seams.revise).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      planWorkspaceId: 'ws-scout', harnessSlug: operatorHomeHarnessSlug(),
    }));
    expect(seams.buildDeps).not.toHaveBeenCalled();
  });

  it('can refuse the resolved model before any provider invocation', async () => {
    const admitLlmCall: ScoutLlmAdmission = vi.fn(async opts => {
      expect(opts.model).toBe('gpt-5.6-luna:medium');
      expect(opts.priority).toBe('scout');
      throw new Error('study budget exhausted');
    });
    await expect(productionScoutRunner({ ...ctx, admitLlmCall, deferDispatch: true })).rejects.toThrow('study budget exhausted');
    expect(seams.provider).not.toHaveBeenCalled();
    expect(seams.buildDeps).toHaveBeenCalledWith(expect.objectContaining({
      deferDispatch: true,
      workspaceId: ctx.workspaceId,
    }));
  });
  it('uses the original provider exactly once after caller admission', async () => {
    const order: string[] = [];
    seams.provider.mockImplementation(async () => {
      order.push('provider');
      return { text: 'ok', costUsd: 0.01, inputTokens: 10, outputTokens: 10 };
    });
    await productionScoutRunner({ ...ctx, admitLlmCall: async (_opts, invoke) => {
      order.push('admitted');
      return invoke();
    } });
    expect(order).toEqual(['admitted', 'provider']);
    expect(seams.provider).toHaveBeenCalledTimes(1);
  });
  it('refuses revision mutations before bootstrapping deferred evaluation', async () => {
    await expect(productionScoutRunner({ ...ctx, deferDispatch: true, revisionRequests: [{} as any] }))
      .rejects.toThrow('cannot mutate existing drafts');
    expect(seams.buildDeps).not.toHaveBeenCalled();
    expect(seams.provider).not.toHaveBeenCalled();
  });
});
