import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./injection', () => ({
  buildMemoryContextBlock: vi.fn(),
}));
vi.mock('./insights-index', async () => {
  const actual = await vi.importActual<typeof import('./insights-index')>('./insights-index');
  return {
    ...actual,
    readInsightsDir: vi.fn(),
  };
});
vi.mock('./mid-turn-admission', () => ({
  withOptionalMemoryAdmission: vi.fn(async (run: () => Promise<unknown>) => ({
    admitted: true,
    value: await run(),
  })),
}));

import { buildMcpPrelude, initializeQueryForHarness, _testing } from './mcp-prelude';
import { buildMemoryContextBlock } from './injection';
import { readInsightsDir } from './insights-index';
import { withOptionalMemoryAdmission } from './mid-turn-admission';
import { setSessionConfinementResolver } from '../capability-envelope/session-confinement-port';

const origEnv = { ...process.env };

beforeEach(() => {
  setSessionConfinementResolver(() => null);
  vi.mocked(buildMemoryContextBlock).mockReset();
  vi.mocked(readInsightsDir).mockReset();
  vi.mocked(withOptionalMemoryAdmission).mockReset();
  vi.mocked(withOptionalMemoryAdmission).mockImplementation(async (run) => ({
    admitted: true,
    value: await run(),
  }));
  process.env = { ...origEnv, PAPERCUSP_SU_MEMORY_INJECTION: 'on' };
});

afterEach(() => {
  setSessionConfinementResolver(undefined);
  process.env = origEnv;
});

it('suppresses both live recall and the insights index for a frozen native session', async () => {
  setSessionConfinementResolver(() => ({ denyTools: [], denyOutside: ['coord:whoami'],
    denyAmbientContext: true, reason: 'frozen benchmark', imposedBy: 'host' }));
  expect(await buildMcpPrelude({ userId: 'u1', workspaceId: 'private', sessionId: 'su-frozen', harnessSlug: 'xbench' })).toBeNull();
  expect(buildMemoryContextBlock).not.toHaveBeenCalled();
  expect(readInsightsDir).not.toHaveBeenCalled();
});

describe('injectionEnabled', () => {
  it('on when env=on', () => {
    process.env.PAPERCUSP_SU_MEMORY_INJECTION = 'on';
    expect(_testing.injectionEnabled()).toBe(true);
  });

  it('off when env=off', () => {
    process.env.PAPERCUSP_SU_MEMORY_INJECTION = 'off';
    expect(_testing.injectionEnabled()).toBe(false);
  });

  it('default on in NODE_ENV=development', () => {
    delete process.env.PAPERCUSP_SU_MEMORY_INJECTION;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
    expect(_testing.injectionEnabled()).toBe(true);
  });

  it('default ON in production too (P-050: never ships dark; =off is the kill switch)', () => {
    delete process.env.PAPERCUSP_SU_MEMORY_INJECTION;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
    expect(_testing.injectionEnabled()).toBe(true);
  });
});

describe('buildMcpPrelude — flag gating', () => {
  it('returns null when flag off', async () => {
    process.env.PAPERCUSP_SU_MEMORY_INJECTION = 'off';
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1' });
    expect(r).toBeNull();
    expect(buildMemoryContextBlock).not.toHaveBeenCalled();
  });
});

describe('buildMcpPrelude — harness slug resolution + launch-profile query (D-005)', () => {
  it('reads harness from URL param and queries with the harness identity', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    const url = new URL('http://op/api/mcp?superuser=1&harness=sheets');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1', url });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith({
      userId: 'u1',
      workspaceId: 'w1',
      harnessSlugs: ['sheets'],
      // D-005 owner-approved rung: harness-bound sessions DO vector-query
      // at initialize, with the harness-identity query.
      queryContext: initializeQueryForHarness('sheets'),
    });
    expect(initializeQueryForHarness('sheets')).toContain('sheets');
    expect(r?.sources.harnessSlug).toBe('sheets');
    expect(r?.sources.harnessSource).toBe('env');
  });

  it('WI-4393: explicit harnessSlug override wins over ?harness= (the OMP carrier — OMP cannot env-interpolate ?harness= into its URL, so callers resolve it via header precedence and pass it here)', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    const url = new URL('http://op/api/mcp?superuser=1&harness=stale-url-value');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1', url, harnessSlug: 'papercusp' });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith({
      userId: 'u1',
      workspaceId: 'w1',
      harnessSlugs: ['papercusp'],
      queryContext: initializeQueryForHarness('papercusp'),
    });
    expect(r?.sources.harnessSlug).toBe('papercusp');
  });

  it('WI-4393: harnessSlug override alone (no url at all — OMP session) resolves harness', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1', harnessSlug: 'papercusp' });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlugs: ['papercusp'] }),
    );
    expect(r?.sources.harnessSlug).toBe('papercusp');
  });

  it('bare session (no harness): empty query — recall defers to turn-start', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1' });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith({
      userId: 'u1',
      workspaceId: 'w1',
      harnessSlugs: [],
      queryContext: '',
    });
    expect(initializeQueryForHarness(null)).toBe('');
    expect(r?.sources.harnessSlug).toBeNull();
  });

  it('explicit queryContext overrides the derived one (P-007 resolver seam)', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    const url = new URL('http://op/api/mcp?superuser=1&harness=sheets');
    await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1', url, queryContext: 'RESOLVER Q' });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith(
      expect.objectContaining({ queryContext: 'RESOLVER Q' }),
    );
  });

  it('sessionId plumbs the epoch-ledger identity under port initialize (P-002)', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- foo');
    await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1', sessionId: 'sid-42' });
    expect(buildMemoryContextBlock).toHaveBeenCalledWith(
      expect.objectContaining({ session: { sessionId: 'sid-42', port: 'initialize' } }),
    );
  });
});

describe('buildMcpPrelude — composition', () => {
  it('runs initialize recall through the host-wide optional-memory admission', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- admitted');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1', harnessSlug: 'papercusp' });

    expect(withOptionalMemoryAdmission).toHaveBeenCalledOnce();
    expect(buildMemoryContextBlock).toHaveBeenCalledOnce();
    expect(r?.text).toContain('admitted');
  });

  it('keeps the cheap insights prelude when host admission sheds memory', async () => {
    vi.mocked(withOptionalMemoryAdmission).mockResolvedValueOnce({ admitted: false, reason: 'at_capacity' });
    vi.mocked(readInsightsDir).mockResolvedValue([
      { slug: 'foo', title: 'Foo', description: 'Bar.', status: 'active', tags: [] },
    ]);

    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      harnessSlug: 'papercusp',
      insightsDir: '/fake/dir',
    });

    expect(buildMemoryContextBlock).not.toHaveBeenCalled();
    expect(r?.text).toContain('## Agent insights');
    expect(r?.sources.userMemoryIncluded).toBe(false);
  });

  it('returns memory block alone when insights not provided', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- u prefers terse');
    const r = await buildMcpPrelude({ userId: 'u1', workspaceId: 'w1' });
    expect(r?.text).toContain('## Memory');
    expect(r?.sources.userMemoryIncluded).toBe(true);
    expect(r?.sources.insightsIncluded).toBe(false);
  });

  it('returns insights block alone when memory is empty', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue(null);
    vi.mocked(readInsightsDir).mockResolvedValue([
      { slug: 'foo', title: 'Foo', description: 'Bar.', status: 'active', tags: [] },
    ]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.text).toContain('## Agent insights');
    expect(r?.sources.userMemoryIncluded).toBe(false);
    expect(r?.sources.insightsIncluded).toBe(true);
  });

  it('composes memory + insights together', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- u prefers terse');
    vi.mocked(readInsightsDir).mockResolvedValue([
      { slug: 'foo', title: 'Foo', description: 'Bar.', status: 'active', tags: [] },
    ]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.text).toContain('## Memory');
    expect(r?.text).toContain('## Agent insights');
  });

  it('returns null when both sources produce nothing', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue(null);
    vi.mocked(readInsightsDir).mockResolvedValue([]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r).toBeNull();
  });
});

describe('buildMcpPrelude — failure handling', () => {
  it('survives buildMemoryContextBlock throwing', async () => {
    vi.mocked(buildMemoryContextBlock).mockRejectedValue(new Error('mem0 down'));
    vi.mocked(readInsightsDir).mockResolvedValue([
      { slug: 'foo', title: 'Foo', description: 'Bar.', status: 'active', tags: [] },
    ]);
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.sources.userMemoryIncluded).toBe(false);
    expect(r?.sources.insightsIncluded).toBe(true);
  });

  it('survives readInsightsDir throwing', async () => {
    vi.mocked(buildMemoryContextBlock).mockResolvedValue('## Memory\n- x');
    vi.mocked(readInsightsDir).mockRejectedValue(new Error('fs down'));
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r?.sources.userMemoryIncluded).toBe(true);
    expect(r?.sources.insightsIncluded).toBe(false);
  });

  it('returns null when everything throws + nothing else available', async () => {
    vi.mocked(buildMemoryContextBlock).mockRejectedValue(new Error('mem0 down'));
    vi.mocked(readInsightsDir).mockRejectedValue(new Error('fs down'));
    const r = await buildMcpPrelude({
      userId: 'u1',
      workspaceId: 'w1',
      insightsDir: '/fake/dir',
    });
    expect(r).toBeNull();
  });
});
