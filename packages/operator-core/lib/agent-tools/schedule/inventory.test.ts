import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ schedules: vi.fn(), startup: vi.fn() }));
vi.mock('@papercusp/agent-mcp', () => ({ defineTool: (definition: unknown) => definition, SU_ROLES: ['su'] }));
vi.mock('../../schedule-inventory', () => ({
  SCHEDULE_SOURCES: ['dbos', 'routines', 'in-process', 'managed', 'external-process'],
  collectScheduleInventory: calls.schedules,
  summarizeInventory: (rows: unknown[]) => ({ total: rows.length }),
}));
vi.mock('../../startup-activity', () => ({ collectCurrentStartupActivity: calls.startup }));
import definition from './inventory';

// Exercise the declared handler and real argument schema, without the MCP transport.
const tool = definition as unknown as {
  args: { parse: (input: unknown) => Record<string, unknown> };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};
beforeEach(() => { vi.clearAllMocks(); });

describe('schedule inventory startup view', () => {
  it('preserves the default schedule contract and forwards schedule filters', async () => {
    calls.schedules.mockResolvedValueOnce([{ name: 'example' }]);
    const args = tool.args.parse({ name: 'example' });
    expect(await tool.handler(args)).toEqual({ data: { summary: { total: 1 }, rows: [{ name: 'example' }] } });
    expect(calls.schedules).toHaveBeenCalledWith({}, args);
    expect(calls.startup).not.toHaveBeenCalled();
  });

  it('routes startup reads through the concrete provider with its source health and census', async () => {
    const snapshot = { features: [], history: [], unavailable: ['policy'], census: { complete: false, problems: ['missing:routine-dispatch'] } };
    calls.startup.mockResolvedValueOnce(snapshot);
    expect(await tool.handler(tool.args.parse({ view: 'startup' }))).toEqual({ data: snapshot });
    expect(calls.startup).toHaveBeenCalledOnce();
    expect(calls.schedules).not.toHaveBeenCalled();
  });

  it('rejects partial schedule filters on startup rather than misrepresenting coverage', () => {
    for (const filters of [{ name: 'example' }, { group: '' }, { source: 'dbos' }, { tier: 'durable' }, { installSlug: 'x' }])
      expect(() => tool.args.parse({ view: 'startup', ...filters })).toThrow('Schedule filters require');
  });
});
