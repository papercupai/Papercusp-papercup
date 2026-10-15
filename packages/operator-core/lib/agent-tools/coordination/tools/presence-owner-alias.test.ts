/**
 * coord:presence ownerId compatibility coverage.
 *
 * The roster exposes `ownerId` on each row, so older callers naturally reused
 * that field for the targeted input. The public tool accepts that spelling only
 * at the boundary and must pass the canonical `owner` selector downstream.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPgDiagnosticHooks, pgResultDiagnosticSnapshot, resetAcquireRegistryForTest } from '@papercusp/db-org';
import { installDbDiagnosticCorrelationWiring } from '../../db-diagnostic-correlation-wiring';

const mocks = vi.hoisted(() => ({
  resolvePresenceScope: vi.fn(),
  assemblePresenceSnapshot: vi.fn(),
  readPeerRelations: vi.fn(),
}));

vi.mock('../presence-snapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../presence-snapshot')>()),
  resolvePresenceScope: mocks.resolvePresenceScope,
  assemblePresenceSnapshot: mocks.assemblePresenceSnapshot,
}));

vi.mock('../coupling-divergence-stamp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coupling-divergence-stamp')>()),
  readPeerRelations: mocks.readPeerRelations,
}));

vi.mock('../../locks/identity', () => ({
  readIdentity: vi.fn(() => ({
    ownerId: 'su-caller',
    ownerLabel: 'su caller',
    coordinationDomain: '/tmp/papercusp-test',
  })),
}));

vi.mock('../self-marker', () => ({
  resolveSelfRef: vi.fn(() => null),
  markSelfRows: vi.fn((rows: unknown[]) => rows),
}));

vi.mock('../presence-cursor-overlay', () => ({
  overlayPresenceCursors: vi.fn(async (rows: unknown[]) => rows),
}));

import presenceTool from './presence';

describe('coord:presence ownerId compatibility alias', () => {
  beforeEach(() => {
    resetAcquireRegistryForTest();
    installDbDiagnosticCorrelationWiring();
    mocks.resolvePresenceScope.mockReset().mockResolvedValue({
      scope: 'workspace',
      wsId: 'test-workspace',
      potId: null,
    });
    mocks.assemblePresenceSnapshot.mockReset().mockResolvedValue({
      as_of: '2026-08-26T15:00:00.000Z',
      scope: 'workspace',
      etag: 'etag-1',
      summary: { active: 0, wakeable: 0, byState: {} },
      active: [],
    });
    mocks.readPeerRelations.mockReset().mockResolvedValue(new Map());
  });

  it('normalizes ownerId to the canonical owner selector before scope and snapshot reads', async () => {
    await presenceTool.handler(
      { ownerId: 'su-target' } as never,
      { workspaceId: 'test-workspace', harnessSlug: 'papercusp', isSuperuser: true } as never,
    );

    expect(mocks.resolvePresenceScope).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ targetedOwner: true }),
    );
    expect(mocks.assemblePresenceSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: 'su-target' }),
    );
    expect(mocks.assemblePresenceSnapshot.mock.calls[0]?.[1]).not.toHaveProperty('ownerId');
  });

  it('restricts the private coupling-reader probe to superusers', async () => {
    await expect(presenceTool.handler({ probe_coupling_reader: true } as never,
      { isSuperuser: false } as never)).rejects.toThrow(/requires a superuser session/i);
    expect(mocks.readPeerRelations).not.toHaveBeenCalled();
    expect(mocks.resolvePresenceScope).not.toHaveBeenCalled();
  });

  it('runs only the reader and keeps its timings out of the public result', async () => {
    mocks.readPeerRelations.mockImplementation(async (_ownerId, opts) => {
      opts.onStageTiming({ name: 'assemble-presence-snapshot', elapsedMs: 18, status: 'ok' });
      return new Map([['private-peer-id', ['coord-exchange']]]);
    });
    const metadata = vi.fn();
    const result = await presenceTool.handler(
      { probe_coupling_reader: true, include_coupling: true } as never,
      { workspaceId: 'test-workspace', harnessSlug: 'papercusp', isSuperuser: true, metadata } as never,
    );

    expect(mocks.readPeerRelations).toHaveBeenCalledTimes(1);
    expect(mocks.readPeerRelations).toHaveBeenCalledWith('su-caller', expect.objectContaining({
      workspaceId: 'test-workspace',
      harnessSlug: 'papercusp',
      onStageTiming: expect.any(Function),
    }));
    expect(mocks.resolvePresenceScope).not.toHaveBeenCalled();
    expect(mocks.assemblePresenceSnapshot).not.toHaveBeenCalled();
    expect(result).toEqual({ data: { couplingReadProbe: { complete: true } } });
    expect(JSON.stringify(result)).not.toContain('private-peer-id');
    expect(metadata.mock.calls.at(-1)?.[0]?.presenceCouplingProbe).toMatchObject({
      schemaVersion: 'presence-coupling-probe-v1',
      unit: 'ms',
      timing: 'wall-time-sequential-reader-stages',
      status: 'ok',
      elapsedMs: expect.any(Number),
      stages: [{ name: 'assemble-presence-snapshot', elapsedMs: 18, status: 'ok' }],
    });
  });

  it('links a snapshot query to the measured phase without changing the roster', async () => {
    const snapshot = await mocks.assemblePresenceSnapshot();
    const hooks = createPgDiagnosticHooks('org-app');
    mocks.assemblePresenceSnapshot.mockImplementation(async () => {
      await Promise.resolve();
      hooks.onresult({ connectionId: 1, queryId: 1, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', context: hooks.onquerycontext() });
      return snapshot;
    });
    const metadata = vi.fn();
    const result = await presenceTool.handler({ owner: 'su-target', include_coupling: false } as never,
      { workspaceId: 'test-workspace', isSuperuser: true, metadata } as never);
    expect(result).toMatchObject({ data: { active: [], etag: 'etag-1' } });
    const read = metadata.mock.calls.at(-1)?.[0]?.presenceRead;
    expect(read).toMatchObject({ schemaVersion: 'presence-read-v1', unit: 'ms',
      timing: 'wall-time-sequential-phases' });
    const phase = read.stages.find((stage: { name: string }) => stage.name === 'snapshot');
    expect(phase).toMatchObject({ status: 'ok', elapsedMs: expect.any(Number), queryDiagnostics: {
      rowId: null, attemptId: expect.any(String), stage: 'scope-query',
      timing: 'query-build-to-terminal-not-acquisition',
    } });
    expect(pgResultDiagnosticSnapshot('org-app').results[0]).toMatchObject({
      correlationState: 'linked', correlation: { attemptId: phase.queryDiagnostics.attemptId,
        processInstanceId: phase.queryDiagnostics.processInstanceId, hopId: 1, stage: 'scope-query' },
    });
    expect(hooks.onquerycontext()).toEqual({ state: 'unobserved' });
    expect(JSON.stringify(read)).not.toContain('su-target');
  });

  it('records a failed snapshot and preserves the original error', async () => {
    const error = new Error('snapshot failed');
    mocks.assemblePresenceSnapshot.mockRejectedValue(error);
    const metadata = vi.fn();
    await expect(presenceTool.handler({ owner: 'su-target' } as never,
      { workspaceId: 'test-workspace', isSuperuser: true, metadata } as never)).rejects.toBe(error);
    expect(metadata.mock.calls.at(-1)?.[0]?.presenceRead.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'snapshot', status: 'error' }),
    ]));
    expect(createPgDiagnosticHooks('org-app').onquerycontext()).toEqual({ state: 'unobserved' });
  });

  it('retains exact phase query evidence after unrelated requests evict the ring', async () => {
    const snapshot = await mocks.assemblePresenceSnapshot();
    const hooks = createPgDiagnosticHooks('org-app');
    const record = (queryId: number, context = hooks.onquerycontext()) => hooks.onresult({
      connectionId: 1, queryId, backendPid: 42, query: 'select secret_value from private_table',
      rowCount: 1, wireBytes: 12, status: 'ok', elapsedMs: 200, preBuildMs: 700, context,
    });
    record(1); // Same pool/time window, but outside this presence attempt.
    mocks.assemblePresenceSnapshot.mockImplementation(async () => {
      record(2);
      return snapshot;
    });
    const metadata = vi.fn();
    const result = await presenceTool.handler({ owner: 'su-target', include_coupling: false } as never,
      { workspaceId: 'test-workspace', isSuperuser: true, metadata } as never);
    const phase = metadata.mock.calls.at(-1)?.[0]?.presenceRead.stages
      .find((stage: { name: string }) => stage.name === 'snapshot');
    expect(phase.completedQueries).toMatchObject({
      available: true, matchingRetained: 1, omittedMatching: 0,
      coverage: 'retained-completed-results-for-exact-attempt',
      results: [{ queryId: 2, elapsedMs: 200, preBuildMs: 700,
        correlation: { attemptId: phase.queryDiagnostics.attemptId } }],
    });
    expect(JSON.stringify(phase.completedQueries)).not.toContain('secret_value');
    expect(phase.completedQueries.results[0].queryFamily).toBe('select:private_table');
    for (let queryId = 3; queryId < 40; queryId++) record(queryId);
    expect(pgResultDiagnosticSnapshot('org-app', 32).results.some(row => row.queryId === 2)).toBe(false);
    expect(phase.completedQueries.results).toHaveLength(1);
    expect(phase.completedQueries.results[0].queryId).toBe(2);
    expect(result).toMatchObject({ data: { active: [], etag: 'etag-1' } });
  });

  it('bounds retained phase evidence and reports omitted matching records', async () => {
    const snapshot = await mocks.assemblePresenceSnapshot();
    const hooks = createPgDiagnosticHooks('org-admin');
    mocks.assemblePresenceSnapshot.mockImplementation(async () => {
      for (let queryId = 1; queryId <= 12; queryId++) hooks.onresult({
        connectionId: 1, queryId, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', context: hooks.onquerycontext(),
      });
      return snapshot;
    });
    const metadata = vi.fn();
    await presenceTool.handler({ owner: 'su-target', include_coupling: false } as never,
      { workspaceId: 'test-workspace', isSuperuser: true, metadata } as never);
    const phase = metadata.mock.calls.at(-1)?.[0]?.presenceRead.stages
      .find((stage: { name: string }) => stage.name === 'snapshot');
    expect(phase.completedQueries).toMatchObject({ matchingRetained: 12, omittedMatching: 4 });
    expect(phase.completedQueries.results).toHaveLength(8);
    expect(phase.completedQueries.limitations).toContain('Neither identifies a root cause');
  });

  it('keeps diagnostic sink failures from replacing results or dependency errors', async () => {
    const metadata = vi.fn(() => { throw new Error('diagnostic sink failed'); });
    await expect(presenceTool.handler({ owner: 'su-target' } as never,
      { workspaceId: 'test-workspace', isSuperuser: true, metadata } as never))
      .resolves.toMatchObject({ data: { active: [] } });
    expect(metadata).toHaveBeenCalled();
    const error = new Error('dependency failed');
    mocks.assemblePresenceSnapshot.mockRejectedValue(error);
    await expect(presenceTool.handler({ owner: 'su-target' } as never,
      { workspaceId: 'test-workspace', isSuperuser: true, metadata } as never)).rejects.toBe(error);
  });

  it('isolates query identities across overlapping presence calls', async () => {
    const snapshot = await mocks.assemblePresenceSnapshot();
    const hooks = createPgDiagnosticHooks('org-app');
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const paused = new Promise<void>(resolve => { releaseFirst = resolve; });
    mocks.assemblePresenceSnapshot.mockImplementation(async (_scope, opts) => {
      const first = opts.owner === 'first';
      hooks.onresult({ connectionId: 1, queryId: first ? 1 : 2, backendPid: null, query: 'select 1',
        rowCount: 1, wireBytes: 1, status: 'ok', context: hooks.onquerycontext() });
      if (first) { enteredFirst(); await paused; }
      return snapshot;
    });
    const firstMetadata = vi.fn();
    const secondMetadata = vi.fn();
    const first = presenceTool.handler({ owner: 'first' } as never,
      { workspaceId: 'test-workspace', isSuperuser: true, metadata: firstMetadata } as never);
    await firstEntered;
    try {
      await presenceTool.handler({ owner: 'second' } as never,
        { workspaceId: 'test-workspace', isSuperuser: true, metadata: secondMetadata } as never);
    } finally { releaseFirst(); }
    await first;
    const phase = (metadata: typeof firstMetadata) => metadata.mock.calls.at(-1)?.[0]?.presenceRead.stages
      .find((stage: { name: string }) => stage.name === 'snapshot').queryDiagnostics.attemptId;
    expect(phase(firstMetadata)).not.toBe(phase(secondMetadata));
    for (const metadata of [firstMetadata, secondMetadata]) {
      const snapshotPhase = metadata.mock.calls.at(-1)?.[0]?.presenceRead.stages
        .find((stage: { name: string }) => stage.name === 'snapshot');
      expect(snapshotPhase.completedQueries.results).toHaveLength(1);
      expect(snapshotPhase.completedQueries.results[0].correlation.attemptId).toBe(phase(metadata));
    }
    expect(pgResultDiagnosticSnapshot('org-app').results.map(row => row.correlation?.attemptId))
      .toEqual([phase(firstMetadata), phase(secondMetadata)]);
    expect(hooks.onquerycontext()).toEqual({ state: 'unobserved' });
  });
});
