/**
 * tiers-set.test.ts — config:tiers-set / config:tiers-get (context-trimming-tiers P-005).
 *
 * Mocks the stored agent config; validation is the REAL parseTiers (that's the
 * contract: the tool persists exactly what the store would accept). Asserts:
 * replace-wholesale · invalid rows dropped + reported · compactionLimit clamped
 * to the spec ceiling · [] clears to defaults · get annotates effective limits.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/config/tiers-set.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readMock, writeMock, readOmpCatalogMock } = vi.hoisted(() => ({
  readMock: vi.fn(),
  writeMock: vi.fn(),
  readOmpCatalogMock: vi.fn(),
}));
vi.mock('../../agent-config', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../agent-config')>();
  return { ...real, readAgentConfig: readMock, writeAgentConfig: writeMock };
});
vi.mock('../../omp-config', () => ({ readOmpModelCatalog: readOmpCatalogMock }));

const setTool = (await import('./tiers-set')).default;
const getTool = (await import('./tiers-get')).default;
type ToolOut = { data: Record<string, never> & { tiers: Array<Record<string, unknown>>; [k: string]: unknown } };

beforeEach(() => {
  vi.clearAllMocks();
  readMock.mockResolvedValue({ backend: 'auto', cmd: '', models: {}, tiers: [], tierCeilings: {} });
  writeMock.mockImplementation(async (cfg: { tiers: unknown[] }) => cfg);
  readOmpCatalogMock.mockResolvedValue({ models: [] });
});

describe('config:tiers-set', () => {
  it('exposes versioned launch aliases through the existing catalog read', async () => {
    const out = (await getTool.handler({}, {} as never)) as ToolOut;
    expect(out.data.launchAliases).toContainEqual(expect.objectContaining({
      agent: 'codex', model: 'gpt-6.1-sol', aliases: expect.arrayContaining(['sol 6.1']),
    }));
  });

  it('persists a valid menu with clamped compaction limits; drops invalid rows loudly', async () => {
    const out = (await setTool.handler(
      {
        tiers: [
          // BARE sonnet really runs a 200k auto-compact window (no [1m] marker,
          // live-verified 2026-07-02) → its limit clamps to the 158k derived
          // ceiling, NOT the [1m] 500k cap.
          { name: 'lean', spec: 'sonnet', compactionLimit: 900_000 },
          { name: 'wide', spec: 'opus[1m]:high' }, // derived 400k ([1m] cap, owner directive 2026-07-03)
          { name: 'lean', spec: 'haiku' }, // duplicate name — dropped
        ],
      },
      {} as never,
    )) as ToolOut;
    expect(writeMock).toHaveBeenCalledTimes(1);
    const persisted = writeMock.mock.calls[0][0].tiers;
    expect(persisted).toEqual([
      { name: 'lean', spec: 'sonnet', compactionLimit: 158_000 },
      { name: 'wide', spec: 'opus[1m]:high' },
    ]);
    expect(out.data.droppedInvalid).toBe(1);
    expect(out.data.tiers[1].effectiveCompactionLimit).toBe(450_000);
    expect(out.data.tiers[1].modelWindow).toBe(1_000_000);
  });

  it('tiers: [] clears back to the committed defaults', async () => {
    const out = (await setTool.handler({ tiers: [] }, {} as never)) as ToolOut;
    expect(writeMock.mock.calls[0][0].tiers).toEqual([]);
    expect(out.data.stored).toBe(false);
  });

  it('hydrates an OMP tier from the exact backend catalog selector before clamping', async () => {
    readOmpCatalogMock.mockResolvedValue({
      models: [{ selector: 'openrouter/stealth/ox-alpha', contextWindow: 1_048_576 }],
    });
    const out = (await setTool.handler({
      tiers: [{
        name: 'ox-alpha',
        spec: 'openrouter/stealth/ox-alpha:max',
        backend: 'omp',
        compactionLimit: 400_000,
      }],
    }, {} as never)) as ToolOut;
    expect(writeMock.mock.calls[0][0].tiers).toEqual([{
      name: 'ox-alpha',
      spec: 'openrouter/stealth/ox-alpha:max',
      backend: 'omp',
      contextWindow: 1_048_576,
      compactionLimit: 400_000,
    }]);
    expect(out.data.tiers[0]).toMatchObject({
      modelWindow: 1_048_576,
      effectiveCompactionLimit: 400_000,
      loopCapability: {
        executable: true,
        provider: 'openrouter',
      },
    });
  });
});

describe('config:tiers-get', () => {
  it('falls back to DEFAULT_MODEL_TIERS and annotates each tier with its effective limit', async () => {
    const out = (await getTool.handler({}, {} as never)) as ToolOut;
    expect(out.data.stored).toBe(false);
    const std = out.data.tiers.find((t) => t.name === 'standard')!;
    expect(std.effectiveCompactionLimit).toBe(450_000); // sonnet alias → sonnet-5 → the leader/solo 1M cap (450k, owner directive 2026-09-21)
    expect(std.compactionLimitSource).toBe('model-default');
  });

  it('reports an explicit per-tier limit as explicit', async () => {
    readMock.mockResolvedValue({
      backend: 'auto', cmd: '', models: {},
      tiers: [{ name: 'lean', spec: 'sonnet', compactionLimit: 90_000 }],
      tierCeilings: {},
    });
    const out = (await getTool.handler({}, {} as never)) as ToolOut;
    expect(out.data.stored).toBe(true);
    expect(out.data.tiers[0].effectiveCompactionLimit).toBe(90_000);
    expect(out.data.tiers[0].compactionLimitSource).toBe('explicit');
  });

  it('reports a persisted OMP catalog window instead of the 200k fallback', async () => {
    readMock.mockResolvedValue({
      backend: 'auto', cmd: '', models: {},
      tiers: [{
        name: 'ox-alpha', spec: 'openrouter/stealth/ox-alpha:max', backend: 'omp',
        contextWindow: 1_048_576, compactionLimit: 400_000,
      }],
      tierCeilings: {},
    });
    const out = (await getTool.handler({}, {} as never)) as ToolOut;
    expect(out.data.tiers[0]).toMatchObject({ modelWindow: 1_048_576, effectiveCompactionLimit: 400_000 });
    expect(out.data.tiers[0].loopCapability).toMatchObject({
      executable: true,
      provider: 'openrouter',
    });
  });
});
