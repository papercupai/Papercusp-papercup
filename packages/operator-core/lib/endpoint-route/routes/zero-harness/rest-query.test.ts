import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgDiagnosticHooks, pgResultDiagnosticSnapshot, resetAcquireRegistryForTest,
  resetPgDiagnosticContextResolver } from '@papercusp/db-org/acquire-registry';
import { installDbDiagnosticCorrelationWiring } from '../../../agent-tools/db-diagnostic-correlation-wiring';

const resolveNamedQueryMock = vi.fn();
const observeResolveMock = vi.fn();
const serializeJsonResponseMock = vi.fn(async (value: unknown, _itemCount?: number) => JSON.stringify(value));

vi.mock('../../../sync-resolver', () => ({
  resolveNamedQueryV2: (...args: unknown[]) => resolveNamedQueryMock(...args),
  isRegisteredV2: (name: string) => ['workItems.byHarness', 'plans.list', 'workItems.stats'].includes(name),
  NAME_NOT_FOUND: Symbol('NAME_NOT_FOUND'),
}));
vi.mock('../../../sync-resolver/resolve-observability', () => ({
  observeResolve: (input: unknown) => observeResolveMock(input),
}));
vi.mock('../../../sync-resolver/resource-delta-config', () => ({ resourceDeltaConfig: () => undefined }));
vi.mock('@papercusp/tooldef', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/tooldef')>()),
  negotiateRowsDelta: vi.fn() }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  defineTool: (input: unknown) => input }));
vi.mock('../../../cpu-task-worker', () => ({
  serializeJsonResponse: (value: unknown, itemCount: number) => serializeJsonResponseMock(value, itemCount),
}));

type RestRoute = {
  auth?: unknown;
  handler: (req: Request) => Promise<Response>;
};

async function route(): Promise<RestRoute> {
  return (await import('./rest-query')).default as unknown as RestRoute;
}

beforeEach(() => {
  vi.clearAllMocks();
  serializeJsonResponseMock.mockImplementation(async (value: unknown, _itemCount?: number) => JSON.stringify(value));
  resetAcquireRegistryForTest();
  installDbDiagnosticCorrelationWiring();
});

afterEach(() => { resetPgDiagnosticContextResolver(); resetAcquireRegistryForTest(); });

describe('P011 named HTTP request exact object guards', () => {
  it('links raw Pg, mapped rows and the HTTP envelope without adding diagnostics to the response', async () => {
    const raw = [{ id: 1 }];
    const rows = [{ id: 1 }];
    const hooks = createPgDiagnosticHooks('org-app');
    resolveNamedQueryMock.mockImplementationOnce(async () => {
      hooks.onresult({ connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', result: raw, context: hooks.onquerycontext() });
      return rows;
    });
    const response = await (await route()).handler(new Request(
      'http://localhost:3170/api/zero-harness/rest-query?name=workItems.byHarness&args=%7B%22secret%22%3A%22never-retain-args%22%7D',
    ));
    const [diagnostic] = pgResultDiagnosticSnapshot('org-app', 1, { includeObjectRefs: true }).results;
    expect(diagnostic.correlation).toMatchObject({ operation: 'workItems.byHarness', requestId: expect.any(String) });
    expect(response.headers.get('x-papercusp-request-id')).toBe(diagnostic.correlation!.requestId);
    expect(response.headers.get('x-papercusp-request-id')).toMatch(/^[a-f0-9-]{36}$/i);
    expect(diagnostic.objectRefs?.decodedResult?.deref()).toBe(raw);
    expect(diagnostic.objectRefs?.resolvedRows?.deref()).toBe(rows);
    expect(diagnostic.objectRefs?.responseValue?.deref()).toBe(serializeJsonResponseMock.mock.calls[0][0]);
    expect(diagnostic.objectRefs).not.toHaveProperty('workerClone');
    const body = await response.text();
    expect(JSON.parse(body).rows).toEqual(rows);
    expect(body).not.toContain(diagnostic.correlation!.requestId!);
    expect(JSON.stringify(pgResultDiagnosticSnapshot('org-app'))).not.toContain('never-retain-args');
    expect(hooks.onquerycontext()).toEqual({ state: 'unobserved' });
  });

  it('returns distinct server-generated request IDs for concurrent requests despite a caller-supplied ID', async () => {
    const hooks = createPgDiagnosticHooks('org-app');
    let queryId = 0;
    resolveNamedQueryMock.mockImplementation(async () => {
      const id = ++queryId;
      await new Promise(resolve => setTimeout(resolve, id === 1 ? 10 : 0));
      const rows = [{ id }];
      hooks.onresult({ connectionId: 1, queryId: id, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', result: rows, context: hooks.onquerycontext() });
      return rows;
    });
    const handler = (await route()).handler;
    const responses = await Promise.all([1, 2].map(() => handler(new Request(
      'http://localhost:3170/api/zero-harness/rest-query?name=workItems.byHarness',
      { headers: { 'x-papercusp-request-id': 'caller-secret' } },
    ))));
    const diagnostics = pgResultDiagnosticSnapshot('org-app').results;
    const ids = responses.map(response => response.headers.get('x-papercusp-request-id'));
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain('caller-secret');
    for (const response of responses) {
      const id = response.headers.get('x-papercusp-request-id');
      const body = await response.json();
      expect(diagnostics.find(row => row.correlation?.requestId === id)?.queryId).toBe(body.rows[0].id);
    }
    expect(JSON.stringify(diagnostics)).not.toContain('caller-secret');
  });

  it('does not record an unregistered caller-provided operation name', async () => {
    const hooks = createPgDiagnosticHooks('org-app');
    resolveNamedQueryMock.mockImplementationOnce(async () => {
      hooks.onresult({ connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', context: hooks.onquerycontext() });
      return [];
    });
    await (await route()).handler(new Request('http://localhost:3170/api/zero-harness/rest-query?name=secretToken'));
    const snapshot = pgResultDiagnosticSnapshot('org-app');
    expect(snapshot.results[0].correlation).toHaveProperty('requestId');
    expect(snapshot.results[0].correlation).not.toHaveProperty('operation');
    expect(JSON.stringify(snapshot)).not.toContain('secretToken');
  });
});

describe('GET /zero-harness/rest-query stale-process diagnosis', () => {
  it('calibrates in-process audit bytes against the actual UTF-8 response envelope', async () => {
    const { measureSyncReadPayloadsInProcess, PAYLOAD_BUDGET_BYTES } =
      await import('../../../sync-resolver/sync-read-audit');
    const rows = [{ title: '界'.repeat(PAYLOAD_BUDGET_BYTES / 2) }];
    resolveNamedQueryMock.mockResolvedValueOnce(rows).mockResolvedValueOnce(rows);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1_790_240_000_000);
    try {
      const response = await (await route()).handler(new Request(
        'http://localhost:3170/api/zero-harness/rest-query?name=workItems.stats&args=%7B%7D',
      ));
      expect(response.status).toBe(200);
      const expectedBytes = (await response.arrayBuffer()).byteLength;
      const report = await measureSyncReadPayloadsInProcess({ fixtures: { 'workItems.stats': {} } });
      expect(report.measured[0]).toMatchObject({ bytes: expectedBytes, overBytes: true });
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps the sync read surface loopback-only', async () => {
    expect((await route()).auth).toBe('loopback');
  });

  it('turns an ESM link failure into an actionable stale-operator response', async () => {
    resolveNamedQueryMock.mockRejectedValueOnce(
      new Error(
        "The requested module '@papercusp/orchestrator/codex-gateway-config' does not provide an export named 'codexManagedFeaturesToml'",
      ),
    );

    const response = await (await route()).handler(
      new Request(
        'http://localhost:3070/api/zero-harness/rest-query?name=agentDetail.byOwner&args=%7B%7D',
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      name: 'agentDetail.byOwner',
      code: 'stale_operator_module_link',
      staleOperator: true,
    });
    expect(body.error).toMatchObject(expect.any(String));
    expect(body.error).toContain('Restart the operator process');
  });

  it('returns the server request ID on resolver failures so PG diagnostics remain joinable', async () => {
    const hooks = createPgDiagnosticHooks('org-app');
    resolveNamedQueryMock.mockImplementationOnce(async () => {
      hooks.onresult({ connectionId: 1, queryId: 1, backendPid: null,
        query: 'select * from harness_shared.work_items', rowCount: 0, wireBytes: 0,
        status: 'error', errorCode: '57014', context: hooks.onquerycontext() });
      throw new Error('workItems.byHarness rows exceeded the read budget');
    });

    const response = await (await route()).handler(new Request(
      'http://localhost:3170/api/zero-harness/rest-query?name=workItems.byHarness&args=%7B%7D',
    ));
    const requestId = response.headers.get('x-papercusp-request-id');
    const body = await response.json();
    const [diagnostic] = pgResultDiagnosticSnapshot('org-app').results;

    expect(response.status).toBe(500);
    expect(requestId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(diagnostic.correlation).toMatchObject({
      operation: 'workItems.byHarness',
      requestId,
    });
    expect(body).toEqual({ error: 'workItems.byHarness rows exceeded the read budget', name: 'workItems.byHarness' });
  });

  it('keeps ordinary resolver failures as ordinary 500 responses', async () => {
    resolveNamedQueryMock.mockRejectedValueOnce(new Error('database connection refused'));

    const response = await (await route()).handler(
      new Request('http://localhost:3070/api/zero-harness/rest-query?name=plans.list&args=%7B%7D'),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'database connection refused', name: 'plans.list' });
    expect(observeResolveMock).toHaveBeenCalledTimes(1);
  });

  it('records a post-resolver response failure before returning 500', async () => {
    resolveNamedQueryMock.mockResolvedValueOnce([{ id: 'run-1' }]);
    serializeJsonResponseMock.mockRejectedValueOnce(new Error('serialization worker unavailable'));

    const response = await (await route()).handler(
      new Request(
        'http://localhost:3070/api/zero-harness/rest-query?name=workItemAdmission.runs&args=%7B%22harnessSlug%22%3A%22papercusp%22%2C%22limit%22%3A200%7D',
      ),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: 'serialization worker unavailable',
      name: 'workItemAdmission.runs',
    });
    expect(observeResolveMock).toHaveBeenCalledTimes(2);
    expect(observeResolveMock.mock.calls[1]?.[0]).toMatchObject({
      name: 'workItemAdmission.runs',
      argsJson: '{"harnessSlug":"papercusp","limit":200}',
      error: expect.objectContaining({
        message: 'post-resolve response failed: serialization worker unavailable',
      }),
    });
  });

  it('carries resolver timing with an explicit millisecond unit on successful reads', async () => {
    resolveNamedQueryMock.mockResolvedValueOnce([{ id: 'p-1' }]);

    const response = await (await route()).handler(
      new Request('http://localhost:3070/api/zero-harness/rest-query?name=plans.list&args=%7B%7D'),
    );
    const body = (await response.json()) as {
      timing?: {
        unit: string;
        resolverStartedAtMs: number;
        resolverCompletedAtMs: number;
        resolverMs: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.timing?.unit).toBe('ms');
    expect(body.timing?.resolverCompletedAtMs).toBeGreaterThanOrEqual(body.timing?.resolverStartedAtMs ?? 0);
    expect(body.timing?.resolverMs).toBe(
      body.timing!.resolverCompletedAtMs - body.timing!.resolverStartedAtMs,
    );
  });
});
