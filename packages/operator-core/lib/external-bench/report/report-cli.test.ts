import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sql: vi.fn(async (_query: TemplateStringsArray, ..._values: unknown[]) => []),
  resolveDb: vi.fn(),
  emitReport: vi.fn(async () => '/reports/report-r1.html'),
  attribution: vi.fn(),
}));
vi.mock('../reproducibility/db', () => ({ resolveDb: mocks.resolveDb }));
vi.mock('./report-builder-pg', () => ({ emitReport: mocks.emitReport }));
vi.mock('./capability-attribution-report', () => ({
  buildRunCapabilityAttribution: mocks.attribution,
  formatRunAttributionMarkdown: vi.fn(),
}));

let cli: typeof import('./report-cli');
beforeAll(async () => {
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('Importing the report CLI must not execute or exit it');
  });
  mocks.resolveDb.mockReturnValue({ sql: mocks.sql, ws: 'resolved-default' });
  try { cli = await import('./report-cli'); } finally { exit.mockRestore(); }
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveDb.mockReturnValue({ sql: mocks.sql, ws: 'resolved-default' });
});

describe('benchmark report CLI', () => {
  it('imports without querying the database or emitting a report', () => {
    expect(mocks.resolveDb).not.toHaveBeenCalled();
    expect(mocks.emitReport).not.toHaveBeenCalled();
  });

  it.each([
    ['--workspace', 'private-ws'],
    ['--out', '/tmp/reports'],
    ['--control', 'vanilla'],
    ['--workspace=private-ws'],
  ])('does not treat option values as run IDs: %s', (...args) => {
    expect(cli.parseReportArgs(args).runId).toBeUndefined();
  });

  it('parses options before and after the one run ID', () => {
    expect(cli.parseReportArgs(['--workspace', 'private-ws', 'r1', '--out=/reports', '--attribution', '--control', 'solo']))
      .toEqual({ runId: 'r1', workspace: 'private-ws', outDir: '/reports', attribution: true, control: 'solo' });
  });

  it.each([
    ['--workspace'], ['--out', '--attribution'], ['--control='],
    ['--unknown'], ['r1', 'r2'], ['--workspace=a', '--workspace=b'],
  ])('rejects ambiguous or incomplete arguments: %s', (...args) => {
    expect(() => cli.parseReportArgs(args)).toThrow();
  });

  it('scopes recent-run listing by the requested AND resolved workspace', async () => {
    mocks.resolveDb.mockReturnValue({ sql: mocks.sql, ws: 'private-ws' });
    await cli.listRecentRuns('private-ws');
    expect(mocks.resolveDb).toHaveBeenCalledWith({ workspaceId: 'private-ws' });
    const [query, ...values] = mocks.sql.mock.calls[0];
    expect(Array.from(query).join('?')).toMatch(/WHERE workspace_id = \?/);
    expect(values).toEqual(['private-ws']);
  });

  it('also filters recent-run listing when the workspace is implicit', async () => {
    await cli.listRecentRuns();
    expect(mocks.resolveDb).toHaveBeenCalledWith({});
    expect(mocks.sql.mock.calls[0].slice(1)).toEqual(['resolved-default']);
  });

  it('lists recent runs when only workspace/options are supplied', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cli.runReportCli(['--workspace', 'private-ws', '--out', '/reports'])).toBe(1);
      expect(mocks.resolveDb).toHaveBeenCalledWith({ workspaceId: 'private-ws' });
      expect(mocks.emitReport).not.toHaveBeenCalled();
    } finally { error.mockRestore(); }
  });

  it('passes the parsed run and workspace to report emission', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await cli.runReportCli(['--workspace', 'private-ws', 'r1', '--out', '/reports'])).toBe(0);
      expect(mocks.emitReport).toHaveBeenCalledWith('r1', { workspace: 'private-ws', outDir: '/reports' });
      expect(mocks.resolveDb).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
