import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AdvSessionRow } from '../adv-sessions';
import type { SessionPortRow } from './store';
import {
  acquireTrackedClaudeSource,
  acquireTrackedSessionSource,
  deriveSessionPortIdempotencyKey,
  inspectAcquiredSessionPort,
  prepareInspectedSessionPort,
  publicSessionPortInspection,
  selectSessionPortEvidenceSpan,
} from './service';
import type { SessionArchiveStore } from '../session-archive';
import type { StableSource } from './source';
import type { PortableTurn } from './types';
import { verifySessionPortSeed } from './render';
import { SESSION_PORT_PROTOCOL_VERSION, SESSION_PORT_TRANSFORM_VERSION } from './types';
import { createRouteDiagnostics } from '../endpoint-route/route-stack';

const row: AdvSessionRow = {
  id: 41,
  workspaceId: 'ws',
  planSlug: 'plan-a',
  agent: 'claude',
  role: null,
  feature: null,
  mode: 'console',
  terminalBin: null,
  pid: null,
  windowId: null,
  ompThreadId: null,
  label: null,
  cwd: '/workspace',
  coordOwnerId: 'su-source',
  sessionId: '11111111-1111-4111-8111-111111111111',
  display: null,
  launchArgv: null,
  launchedAt: null,
  startedAt: '2026-07-14T00:00:00.000Z',
  endedAt: null,
  exitCode: null,
  endedBy: null,
  endedSignal: null,
};

const source = (text: string): StableSource => {
  const bytes = Buffer.from([
    JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: text } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: 'done' } }),
    '',
  ].join('\n'));
  return {
    bytes,
    sha256: 'a'.repeat(64),
    highWaterBytes: bytes.length,
    completeBytes: bytes.length,
    source: 'live-jsonl',
    relpath: null,
  };
};

const target = {
  backend: 'codex' as const,
  provider: 'openai',
  model: 'gpt-5.5',
  account: 'default',
  contextWindow: 200_000,
  availableInputTokens: 40_000,
  contextSize: 'trimmed' as const,
  launchContextHash: '0'.repeat(64),
};

describe('isolated answering identity on the maintained session port', () => {
  it('binds a distinct answer owner into the logical request without carrying source authority', () => {
    const continuing = inspectAcquiredSessionPort({ sourceRow: row, stableSource: source('evidence'), target });
    const isolated = inspectAcquiredSessionPort({
      sourceRow: row, stableSource: source('evidence'), target: { ...target, ownerId: 'su-answer-owner' },
    });
    const another = inspectAcquiredSessionPort({
      sourceRow: row, stableSource: source('evidence'), target: { ...target, ownerId: 'su-other-answer' },
    });
    expect(continuing.disclosure.authorityCarried).toBe(true);
    expect(isolated.disclosure.authorityCarried).toBe(false);
    expect(isolated.source).toEqual(continuing.source);
    expect(deriveSessionPortIdempotencyKey(isolated)).not.toBe(deriveSessionPortIdempotencyKey(continuing));
    expect(deriveSessionPortIdempotencyKey(another)).not.toBe(deriveSessionPortIdempotencyKey(isolated));
    expect(row.coordOwnerId).toBe('su-source');
  });

  it.each(['su-source', '', 'not-an-owner', null, 42])('refuses invalid or source-equal isolated owner %s', (ownerId) => {
    expect(() => inspectAcquiredSessionPort({
      sourceRow: row, stableSource: source('evidence'), target: { ...target, ownerId } as never,
    })).toThrow(/isolated target owner/);
  });

  it('persists the isolated owner and disclosure in the existing prepared contract', async () => {
    const inspection = inspectAcquiredSessionPort({
      sourceRow: row, stableSource: source('exact evidence'), target: { ...target, ownerId: 'su-answer-owner' },
    });
    const artifactRoot = mkdtempSync(join(tmpdir(), 'consult-port-isolated-'));
    const createPrepared = vi.fn(async (input: any) => ({ ...input, status: 'prepared' }) as SessionPortRow);
    try {
      const prepared = await prepareInspectedSessionPort({
        inspection, expectedSourceHash: inspection.source.sha256, tokenKey: 'server-only-key',
        artifactRoot, findExisting: async () => null, createPrepared,
      });
      expect(prepared.summary.target.ownerId).toBe('su-answer-owner');
      expect(createPrepared.mock.calls[0]![0].metadata).toMatchObject({
        sourceCoordOwnerId: 'su-source', disclosure: { authorityCarried: false },
        summary: { target: { ownerId: 'su-answer-owner' } },
      });
      expect(readFileSync(createPrepared.mock.calls[0]![0].artifactPath, 'utf8')).toContain('exact evidence');
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it.each([true, false])('renders and budgets the prepared identity disclosure (authorityCarried=%s)', async (authorityCarried) => {
    const inspection = inspectAcquiredSessionPort({
      sourceRow: row, stableSource: source('exact evidence'),
      target: authorityCarried ? target : { ...target, ownerId: 'su-answer-owner' },
    });
    const artifactRoot = mkdtempSync(join(tmpdir(), 'consult-port-identity-'));
    const createPrepared = vi.fn(async (input: any) => ({ ...input, status: 'prepared' }) as SessionPortRow);
    try {
      const prepared = await prepareInspectedSessionPort({
        inspection, expectedSourceHash: inspection.source.sha256, tokenKey: 'server-only-key',
        artifactRoot, findExisting: async () => null, createPrepared,
      });
      const persisted = createPrepared.mock.calls[0]![0];
      const seed = readFileSync(persisted.artifactPath, 'utf8');
      expect(inspection.disclosure.authorityCarried).toBe(authorityCarried);
      expect(persisted.metadata.disclosure.authorityCarried).toBe(authorityCarried);
      expect(seed).toContain(authorityCarried
        ? 'This session continues the source coordination identity.'
        : 'This is a fresh session identity.');
      expect(seed.includes('This is a fresh session identity.')).toBe(!authorityCarried);
      expect(inspection.fullPayloadEstimatedTokens).toBe(Buffer.byteLength(seed, 'utf8'));
      expect(prepared.summary.budget.finalPayloadEstimatedTokens).toBe(Buffer.byteLength(seed, 'utf8'));
      expect(verifySessionPortSeed(seed, prepared.summary.hashes.rendered)).toBe(true);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });
});

describe('session-port current-version test fixtures', () => {
  it('derives protocol and transform versions instead of copying the current numbers', () => {
    const fixtureFiles = [
      new URL('../endpoint-route/__tests__/adv-session-port-failure-route.test.ts', import.meta.url),
      new URL('../endpoint-route/__tests__/bootstrap-su.test.ts', import.meta.url),
      new URL('./store.integration.test.ts', import.meta.url),
      new URL('./service.test.ts', import.meta.url),
      new URL('../../../../apps/operator/lib/psu-launcher.test.ts', import.meta.url),
    ];
    const copiedWireVersion = /(?:\bprotocolVersion\b|\btransformVersion\b)\s*:\s*\d+\b|\bversions\s*:\s*\{[^}]*\btransform\s*:\s*\d+\b/s;

    for (const file of fixtureFiles) {
      expect(readFileSync(file, 'utf8'), file.pathname).not.toMatch(copiedWireVersion);
    }
  });
});

describe('consult evidence-span session ports (P-007)', () => {
  it('prepares a seed from the evidence window instead of retaining the full adapted history', async () => {
    const inspection = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('needle evidence'),
      target,
      evidenceSpan: {
        sessionId: row.sessionId!,
        turnIndices: [0],
        contextTurns: 0,
        evidenceTurns: [{ turnIdx: 0, timestamp: null, speaker: 'user', text: 'needle evidence' }],
      },
    });

    expect(inspection.internal.turns.map((turn) => turn.id)).toEqual(['u1']);
    expect(inspection.warnings).toContain('consult evidence span: 1 matched turn(s), ±0 surrounding turn(s)');
    const artifactRoot = mkdtempSync(join(tmpdir(), 'consult-port-evidence-'));
    const createPrepared = vi.fn(async (input: any): Promise<SessionPortRow> => ({
      ...input,
      status: 'prepared',
      targetAdvSessionId: null,
      error: null,
      preparedAt: '2026-09-23T00:00:00.000Z',
      pendingAt: null,
      deliveredAt: null,
      failedAt: null,
    }));
    try {
      const prepared = await prepareInspectedSessionPort({
        inspection,
        expectedSourceHash: inspection.source.sha256,
        tokenKey: 'server-only-key',
        artifactRoot,
        findExisting: async () => null,
        createPrepared,
      });
      const seedPath = createPrepared.mock.calls[0]![0].artifactPath;
      const seed = readFileSync(seedPath, 'utf8');
      expect(verifySessionPortSeed(seed, prepared.summary.hashes.rendered)).toBe(true);
      expect(seed).toContain('needle evidence');
      expect(seed).not.toContain('done');
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
    expect(() => inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('needle evidence'),
      target,
      evidenceSpan: {
        sessionId: 'different-session',
        turnIndices: [0],
        contextTurns: 0,
        evidenceTurns: [{ turnIdx: 0, timestamp: null, speaker: 'user', text: 'needle evidence' }],
      },
    })).toThrow(/exact tracked source session/);
  });

  it('maps exact indexed refs and includes only their bounded neighboring turns', () => {
    const turns: PortableTurn[] = Array.from({ length: 6 }, (_unused, index) => ({
      id: `turn-${index}`,
      parentId: index === 0 ? null : `turn-${index - 1}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      timestamp: `2026-09-23T00:00:0${index}.000Z`,
      blocks: [{ type: 'text', text: `source turn ${index}` }],
    }));

    const selected = selectSessionPortEvidenceSpan(turns, {
      sessionId: 'source-session',
      turnIndices: [3],
      contextTurns: 1,
      evidenceTurns: [{
        turnIdx: 3,
        timestamp: '2026-09-23T00:00:03.000Z',
        speaker: 'assistant',
        text: 'source turn 3',
      }],
    });

    expect(selected.turns.map((turn) => turn.id)).toEqual(['turn-2', 'turn-3', 'turn-4']);
    expect(selected.matchedTurnCount).toBe(1);
    expect(selected.contextTurns).toBe(1);
    expect(selected.turns.some((turn) => turn.id === 'turn-0' || turn.id === 'turn-5')).toBe(false);
  });

  it('refuses an unmatched or ambiguous evidence ref instead of widening to full history', () => {
    const turns: PortableTurn[] = [{
      id: 'one', parentId: null, role: 'user', timestamp: '2026-09-23T00:00:00.000Z',
      blocks: [{ type: 'text', text: 'same text' }],
    }, {
      id: 'two', parentId: 'one', role: 'user', timestamp: '2026-09-23T00:00:00.000Z',
      blocks: [{ type: 'text', text: 'same text' }],
    }];
    const span = {
      sessionId: 'source-session', turnIndices: [9], contextTurns: 1,
      evidenceTurns: [{ turnIdx: 9, timestamp: '2026-09-23T00:00:00.000Z', speaker: 'user', text: 'same text' }],
    };
    expect(() => selectSessionPortEvidenceSpan(turns, span)).toThrow(/ambiguously/);
    expect(() => selectSessionPortEvidenceSpan(turns, { ...span, evidenceTurns: [] })).toThrow(/absent/);
  });
});

describe('tracked Claude source acquisition', () => {
  it.each([null, '2026-10-13T00:00:00.000Z'])('ports the exact retained transcript without an archive (endedAt=%s)', async (endedAt) => {
    const config = mkdtempSync(join(tmpdir(), 'port-retained-claude-'));
    const project = join(config, 'projects', 'cwd');
    mkdirSync(project, { recursive: true });
    const path = join(project, `${row.sessionId}.jsonl`);
    const original = source('selected retained history').bytes;
    writeFileSync(path, original);
    // A later incarnation in the same tracked home must never replace the
    // selected history merely because the archive stamp is absent.
    writeFileSync(join(project, '22222222-2222-4222-8222-222222222222.jsonl'), source('unrelated later history').bytes);
    const readStamp = vi.fn(async () => null);
    const readFiles = vi.fn();
    const archiveStore = { readStamp, readFiles } as unknown as SessionArchiveStore;
    const selected = { ...row, endedAt };
    try {
      const acquired = await acquireTrackedClaudeSource(selected, {
        configDirForOwner: () => config,
        archiveStore: () => archiveStore,
      });
      const inspection = publicSessionPortInspection(inspectAcquiredSessionPort({
        sourceRow: selected, stableSource: acquired, target,
      }));
      expect(acquired.bytes).toEqual(original);
      expect(inspection.source).toMatchObject({
        nativeSessionId: row.sessionId,
        snapshotKind: 'live-jsonl',
        completeBytes: original.length,
        sha256: createHash('sha256').update(original).digest('hex'),
      });
      expect(acquired.fileIdentity?.path).toBe(path);
      expect(readFileSync(path)).toEqual(original);
      expect(readFiles).not.toHaveBeenCalled();
      if (endedAt) expect(readStamp).toHaveBeenCalledWith('claude', row.sessionId);
      else expect(readStamp).not.toHaveBeenCalled();
    } finally {
      rmSync(config, { recursive: true, force: true });
    }
  });

  it('falls back to the canonical archive when cleanup deletes the inspected live JSONL', async () => {
    const archived = {
      ...source('archived history'),
      source: 'archive-manifest' as const,
      relpath: `projects/cwd/${row.sessionId}.jsonl`,
    };
    const readArchive = vi.fn(async () => archived);

    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => { throw new Error('canonical live Claude JSONL is missing'); },
      readArchive,
      archiveStore: () => ({} as never),
    })).resolves.toBe(archived);
    expect(readArchive).toHaveBeenCalledWith({ sessionId: row.sessionId }, expect.anything());
  });

  it('falls back when the live JSONL disappears after its path was resolved', async () => {
    const archived = {
      ...source('archived history'),
      source: 'archive-manifest' as const,
      relpath: `projects/cwd/${row.sessionId}.jsonl`,
    };
    const gone = Object.assign(new Error('open live JSONL: no such file'), { code: 'ENOENT' });

    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => '/config/projects/cwd/session.jsonl',
      readLive: async () => { throw gone; },
      readArchive: async () => archived,
      archiveStore: () => ({} as never),
    })).resolves.toBe(archived);
  });

  it('does not hide an ambiguous or unsafe live-source failure behind the archive', async () => {
    const readArchive = vi.fn();
    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => { throw new Error('canonical live Claude JSONL is ambiguous'); },
      readArchive,
      archiveStore: () => ({} as never),
    })).rejects.toThrow(/ambiguous/);
    expect(readArchive).not.toHaveBeenCalled();
  });

  it('reports both source tiers unavailable when the archive fallback also misses', async () => {
    await expect(acquireTrackedClaudeSource(row, {
      configDirForOwner: () => '/config',
      findLive: async () => { throw new Error('canonical live Claude JSONL is missing'); },
      readArchive: async () => { throw new Error('canonical Claude archive not found'); },
      archiveStore: () => ({} as never),
    })).rejects.toThrow(/live JSONL is missing and archive fallback failed/);
  });
});

describe.each(['claude', 'codex', 'omp'] as const)('ended %s source acquisition', (backend) => {
  const ended = { ...row, agent: backend, endedAt: '2026-10-03T00:00:00.000Z' };
  const stable = source('exact retained incarnation');
  const acquire = (readArchive: () => Promise<StableSource>, findLive = vi.fn(async () => '/tracked/exact.jsonl')) => {
    const readLive = vi.fn(async () => stable);
    const deps = { readArchive, findLive, readLive, archiveStore: () => ({} as never),
      rootForSource: () => '/tracked/sessions', configDirForOwner: () => '/tracked' };
    return { result: backend === 'claude' ? acquireTrackedClaudeSource(ended, deps)
      : acquireTrackedSessionSource(ended, deps), findLive, readLive };
  };

  it('prefers the immutable archive when it exists', async () => {
    const archived = { ...stable, source: 'archive-manifest' as const };
    const { result, findLive, readLive } = acquire(async () => archived);
    await expect(result).resolves.toBe(archived);
    expect(findLive).not.toHaveBeenCalled();
    expect(readLive).not.toHaveBeenCalled();
  });

  it('reads the exact retained incarnation when only its archive is absent', async () => {
    const { result, findLive, readLive } = acquire(async () => {
      throw new Error(`canonical ${backend === 'claude' ? 'Claude' : backend} archive not found`);
    });
    await expect(result).resolves.toBe(stable);
    expect(findLive).toHaveBeenCalledWith(...(backend === 'claude'
      ? ['/tracked', ended.sessionId] : ['/tracked/sessions', backend, ended.sessionId]));
    expect(readLive).toHaveBeenCalledWith('/tracked/exact.jsonl');
  });

  it.each(['archive sha mismatch', 'archive is ambiguous', 'archive manifest/file metadata mismatch'])(
    'refuses %s without using a retained transcript', async (message) => {
      const error = new Error(message);
      const { result, findLive, readLive } = acquire(async () => { throw error; });
      await expect(result).rejects.toBe(error);
      expect(findLive).not.toHaveBeenCalled();
      expect(readLive).not.toHaveBeenCalled();
    },
  );

  it('preserves both missing-archive and unsafe-local evidence when neither source is usable', async () => {
    const archiveError = new Error(`canonical ${backend === 'claude' ? 'Claude' : backend} archive not found`);
    const liveError = new Error('canonical exact local source is ambiguous');
    const { result, readLive } = acquire(async () => { throw archiveError; },
      vi.fn(async () => { throw liveError; }));
    const failure = await result.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([archiveError, liveError]);
    expect(readLive).not.toHaveBeenCalled();
  });
});

describe.each(['claude', 'codex', 'omp'] as const)('%s source acquisition diagnostics', (backend) => {
  it('retains live lookup/read and archive fallback evidence in the same recorder', async () => {
    const diagnostics = createRouteDiagnostics();
    const stable = source('exact private source');
    const missing = Object.assign(new Error('live source disappeared'), { code: 'ENOENT' });
    const deps = {
      rootForSource: () => '/tracked', configDirForOwner: () => '/tracked',
      findLive: async () => '/tracked/private.jsonl',
      readLive: async () => { throw missing; },
      readArchive: async () => stable, archiveStore: () => ({} as never),
    };
    const result = backend === 'claude'
      ? await acquireTrackedClaudeSource(row, deps, diagnostics)
      : await acquireTrackedSessionSource({ ...row, agent: backend }, deps, diagnostics);
    expect(result).toBe(stable);
    expect(Object.keys(diagnostics.snapshot())).toEqual(['port.source.live-lookup', 'port.source.live-read']);
    expect(JSON.stringify(diagnostics.snapshot())).not.toMatch(/private|tracked/);
  });
});

describe('session-port preparation service', () => {
  it.each((['codex', 'omp'] as const).flatMap((backend) =>
    (['claude', 'codex', 'omp'] as const).map((targetBackend) => ({ backend, targetBackend }))))(
    'prepares $backend → $targetBackend with source lineage and content-free durable metadata', async ({ backend, targetBackend }) => {
      const records = backend === 'codex' ? [
        { type: 'session_meta', payload: { id: row.sessionId } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'exact native history' }] } },
      ] : [
        { type: 'session', id: row.sessionId },
        { type: 'message', id: 'native-evidence', parentId: null, message: { role: 'user', content: 'exact native history' } },
      ];
      const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
      const inspection = inspectAcquiredSessionPort({ sourceRow: { ...row, agent: backend },
        stableSource: { ...source(''), bytes }, target: { ...target, backend: targetBackend } });
      const artifactRoot = mkdtempSync(join(tmpdir(), 'native-port-prepare-'));
      const createPrepared = vi.fn(async (input: any): Promise<SessionPortRow> => ({ ...input, status: 'prepared',
        targetAdvSessionId: null, error: null, preparedAt: new Date().toISOString(), pendingAt: null, deliveredAt: null, failedAt: null }));
      try {
        const prepared = await prepareInspectedSessionPort({ inspection, expectedSourceHash: inspection.source.sha256,
          tokenKey: 'server-only-key', artifactRoot, findExisting: async () => null, createPrepared });
        expect(prepared.port.sourceBackend).toBe(backend);
        expect(prepared.port.targetBackend).toBe(targetBackend);
        expect(prepared.summary.source.nativeSessionId).toBe(row.sessionId);
        expect(JSON.stringify(prepared.port.metadata)).not.toContain('exact native history');
        expect(prepared.port.metadata.sourceCoordOwnerId).toBe(row.coordOwnerId);
        const seed = readFileSync(prepared.port.artifactPath, 'utf8');
        expect(verifySessionPortSeed(seed, prepared.port.renderedHash)).toBe(true);
        expect(seed).toContain(`source-backend: ${backend}`);
        expect(seed).toContain(`target-backend: ${targetBackend}`);
        expect(seed).toContain('exact native history');
      } finally { rmSync(artifactRoot, { recursive: true, force: true }); }
    },
  );

  it.each(['codex', 'omp'] as const)('inspects an exact %s source into the existing portable contract', (backend) => {
    const nativeId = row.sessionId!;
    const records = backend === 'codex' ? [
      { type: 'session_meta', payload: { id: nativeId } },
      { type: 'response_item', timestamp: '2026-10-03T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'exact evidence' }] } },
    ] : [
      { type: 'session', id: nativeId },
      { type: 'message', id: 'evidence', parentId: null, timestamp: '2026-10-03T00:00:00Z', message: { role: 'user', content: 'exact evidence' } },
    ];
    const bytes = Buffer.from(records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const inspection = inspectAcquiredSessionPort({
      sourceRow: { ...row, agent: backend, ...(backend === 'omp' ? { sessionId: null, ompThreadId: nativeId } : {}) },
      stableSource: { ...source(''), bytes }, target: { ...target, backend: 'claude' },
      evidenceSpan: { sessionId: nativeId, turnIndices: [3], contextTurns: 0,
        evidenceTurns: [{ turnIdx: 3, timestamp: '2026-10-03T00:00:00Z', speaker: 'user', text: 'exact evidence' }] },
    });
    expect(inspection.source.backend).toBe(backend);
    expect(inspection.source.nativeSessionId).toBe(nativeId);
    expect(inspection.internal.turns).toHaveLength(1);
    expect(inspection.internal.turns[0]?.blocks[0]).toEqual({ type: 'text', text: 'exact evidence' });
    expect(inspection.internal.sourceRow.coordOwnerId).toBe(row.coordOwnerId);
  });

  it.each(['codex', 'omp'] as const)('acquires the exact tracked %s home and falls back only on missing source', async (backend) => {
    const sourceRow = { ...row, agent: backend, ompThreadId: backend === 'omp' ? row.sessionId : null };
    const stable = source('native source');
    const findLive = vi.fn(async () => '/exact/source.jsonl');
    await expect(acquireTrackedSessionSource(sourceRow, {
      rootForSource: () => '/tracked/home/sessions', findLive,
      readLive: async () => stable,
    })).resolves.toBe(stable);
    expect(findLive).toHaveBeenCalledWith('/tracked/home/sessions', backend, row.sessionId);
    const archived = { ...stable, source: 'archive-manifest' as const };
    const readArchive = vi.fn(async () => archived);
    await expect(acquireTrackedSessionSource(sourceRow, {
      findLive: async () => { throw new Error(`canonical live ${backend} JSONL is missing`); },
      readArchive, archiveStore: () => ({} as never),
    })).resolves.toBe(archived);
    expect(readArchive).toHaveBeenCalledWith({ backend, sessionId: row.sessionId }, expect.anything());
    readArchive.mockClear();
    await expect(acquireTrackedSessionSource(sourceRow, {
      findLive: async () => { throw new Error(`canonical live ${backend} JSONL is ambiguous`); },
      readArchive,
    })).rejects.toThrow(/ambiguous/);
    expect(readArchive).not.toHaveBeenCalled();
  });

  it('inspects without exposing internal transcript data and redacts before persistence', async () => {
    const inspection = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('token sk-ant-abcdefghijklmnop and \u001b[31mred'),
      target,
      currentInstruction: `continue\r\nwith API_KEY=${'z'.repeat(24)}`,
    });
    expect(inspection.stats.redactions).toBe(2);
    expect(inspection.stats.controlBytesRemoved).toBeGreaterThan(0);
    expect(publicSessionPortInspection(inspection)).not.toHaveProperty('internal');

    const createPrepared = vi.fn(async (input: any): Promise<SessionPortRow> => ({
      ...input,
      status: 'prepared',
      targetAdvSessionId: null,
      error: null,
      preparedAt: '2026-07-14T00:00:00.000Z',
      pendingAt: null,
      deliveredAt: null,
      failedAt: null,
    }));
    const out = await prepareInspectedSessionPort({
      inspection,
      expectedSourceHash: inspection.source.sha256,
      tokenKey: 'server-only-key',
      artifactRoot: mkdtempSync(join(tmpdir(), 'port-service-')),
      findExisting: async () => null,
      createPrepared,
    });
    expect(out.summary.hashes.source).toBe(inspection.source.sha256);
    expect(out.summary.budget).toMatchObject({
      estimator: 'utf8-byte-upper-bound-v1',
      availableInputTokens: target.availableInputTokens,
    });
    expect(JSON.stringify(out.summary)).not.toContain('sk-ant-');
    const persisted = createPrepared.mock.calls[0][0];
    const seed = readFileSync(persisted.artifactPath, 'utf8');
    expect(seed).toContain('continue\nwith API_KEY=[redacted]');
    expect(seed).not.toContain('z'.repeat(24));
    expect(verifySessionPortSeed(seed, persisted.renderedHash)).toBe(true);
    expect(inspection.disclosure.authorityCarried).toBe(true);
    expect(persisted.metadata.sourceCoordOwnerId).toBe('su-source');
    expect(persisted.metadata).not.toHaveProperty('contract');
    expect(JSON.stringify(persisted.metadata)).not.toContain('history');
    expect(JSON.stringify(persisted.metadata)).not.toContain('done');
    expect(out.port.id).toBe(out.token.split('.')[0]);
    expect(createPrepared).toHaveBeenCalledTimes(1);
  });

  it('derives stable idempotency and reproduces the same token without a second target artifact', async () => {
    const inspection = inspectAcquiredSessionPort({ sourceRow: row, stableSource: source('history'), target });
    expect(deriveSessionPortIdempotencyKey(inspection)).toBe(deriveSessionPortIdempotencyKey(inspection));
    const existing: SessionPortRow = {
      id: '22222222-2222-4222-8222-222222222222',
      workspaceId: 'ws',
      idempotencyKey: deriveSessionPortIdempotencyKey(inspection),
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      sourceAdvSessionId: 41,
      targetAdvSessionId: null,
      sourceBackend: 'claude',
      targetBackend: 'codex',
      targetModel: 'gpt-5.5',
      status: 'prepared',
      sourceHash: inspection.source.sha256,
      normalizedHash: inspection.internal.normalizedHash,
      renderedHash: 'b'.repeat(64),
      tokenHash: 'c'.repeat(64),
      artifactPath: '/managed/path',
      metadata: {
        summary: {
          protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
          source: {
            backend: 'claude',
            workspaceId: 'ws',
            advSessionId: 41,
            nativeSessionId: row.sessionId,
            cwd: '/workspace',
            harnessSlug: null,
            planSlug: 'plan-a',
            snapshot: {
              kind: 'live-jsonl',
              highWaterBytes: 1,
              completeBytes: 1,
              sha256: inspection.source.sha256,
              archiveRelpath: null,
            },
          },
          target,
          fidelity: 'full',
          versions: {
            adapter: 1,
            transform: SESSION_PORT_TRANSFORM_VERSION,
            renderer: 2,
            summaryPrompt: null,
          },
          hashes: {
            source: inspection.source.sha256,
            normalized: inspection.internal.normalizedHash,
            rendered: 'b'.repeat(64),
          },
          budget: {
            estimator: 'utf8-byte-upper-bound-v1',
            availableInputTokens: target.availableInputTokens,
            finalPayloadEstimatedTokens: 100,
            summarizerOutputBudgetTokens: null,
          },
          stats: inspection.stats,
          summary: null,
          warnings: [],
        },
      },
      error: null,
      preparedAt: '2026-07-14T00:00:00.000Z',
      pendingAt: null,
      deliveredAt: null,
      failedAt: null,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const a = await prepareInspectedSessionPort({
      inspection, expectedSourceHash: inspection.source.sha256, tokenKey: 'key', findExisting: async () => existing,
    });
    const b = await prepareInspectedSessionPort({
      inspection, expectedSourceHash: inspection.source.sha256, tokenKey: 'key', findExisting: async () => existing,
    });
    expect(a.reused).toBe(true);
    expect(a.token).toBe(b.token);
  });

  it('creates a linked new attempt after the prior semantic request failed', async () => {
    const inspection = inspectAcquiredSessionPort({ sourceRow: row, stableSource: source('history'), target });
    const failed: SessionPortRow = {
      id: '11111111-1111-4111-8111-111111111111',
      workspaceId: 'ws',
      idempotencyKey: deriveSessionPortIdempotencyKey(inspection),
      retryOfPortId: null,
      protocolVersion: SESSION_PORT_PROTOCOL_VERSION,
      sourceAdvSessionId: 41,
      targetAdvSessionId: 99,
      sourceBackend: 'claude',
      targetBackend: 'codex',
      targetModel: 'gpt-5.5',
      status: 'failed',
      sourceHash: inspection.source.sha256,
      normalizedHash: inspection.internal.normalizedHash,
      renderedHash: 'b'.repeat(64),
      tokenHash: 'c'.repeat(64),
      artifactPath: '/expired/attempt',
      metadata: {},
      error: 'bootstrap failed',
      preparedAt: '2026-07-14T00:00:00.000Z',
      pendingAt: '2026-07-14T00:00:01.000Z',
      deliveredAt: null,
      failedAt: '2026-07-14T00:00:02.000Z',
      expiresAt: '2026-07-14T00:15:00.000Z',
    };
    const createPrepared = vi.fn(
      async (input: any): Promise<SessionPortRow> => ({
        ...input,
        status: 'prepared',
        targetAdvSessionId: null,
        error: null,
        preparedAt: '2026-07-14T00:01:00.000Z',
        pendingAt: null,
        deliveredAt: null,
        failedAt: null,
      }),
    );

    const retried = await prepareInspectedSessionPort({
      inspection,
      expectedSourceHash: inspection.source.sha256,
      tokenKey: 'server-only-key',
      artifactRoot: mkdtempSync(join(tmpdir(), 'port-retry-')),
      findExisting: async () => failed,
      createPrepared,
    });

    expect(retried.reused).toBe(false);
    expect(retried.port.id).not.toBe(failed.id);
    expect(createPrepared).toHaveBeenCalledWith(expect.objectContaining({ retryOfPortId: failed.id }));
  });

  it('fails when the live snapshot changed after inspection', async () => {
    const inspection = inspectAcquiredSessionPort({ sourceRow: row, stableSource: source('history'), target });
    await expect(prepareInspectedSessionPort({
      inspection,
      expectedSourceHash: 'different',
      tokenKey: 'key',
    })).rejects.toThrow(/changed/);
  });

  it('binds currentInstruction into normalized identity and rejects an oversized complete payload honestly', async () => {
    const a = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('history'),
      target,
      currentInstruction: 'continue A',
    });
    const b = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('history'),
      target,
      currentInstruction: 'continue B',
    });
    expect(a.internal.normalizedHash).not.toBe(b.internal.normalizedHash);
    expect(deriveSessionPortIdempotencyKey(a)).not.toBe(deriveSessionPortIdempotencyKey(b));
    const contextChanged = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('history'),
      target: { ...target, launchContextHash: '1'.repeat(64) },
      currentInstruction: 'continue A',
    });
    expect(deriveSessionPortIdempotencyKey(a)).not.toBe(deriveSessionPortIdempotencyKey(contextChanged));

    const tinyTarget = { ...target, availableInputTokens: 64 };
    const oversized = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: source('history'),
      target: tinyTarget,
      currentInstruction: 'x'.repeat(1_000),
    });
    expect(oversized.requiresSummary).toBe(true);
    expect(oversized.fit).toMatchObject({
      feasible: false,
      fidelity: 'summary-tail',
      reason: expect.stringMatching(/latest required atomic|bounded summary output/),
    });
    expect(oversized.fit.minimumRequiredTokens).toBeGreaterThan(tinyTarget.availableInputTokens);
    await expect(prepareInspectedSessionPort({
      inspection: oversized,
      expectedSourceHash: oversized.source.sha256,
      tokenKey: 'key',
      findExisting: async () => null,
    })).rejects.toThrow(/no summarizer/);
  });

  it('redacts secrets before a bounded summarizer receives any historical bytes', async () => {
    const secret = `sk-${'q'.repeat(32)}`;
    const records = [
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: `old secret ${secret} ${'word '.repeat(1_000)}` } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: 'old answer' } },
      { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: 'recent request' } },
      { type: 'assistant', uuid: 'a2', parentUuid: 'u2', message: { role: 'assistant', content: 'recent answer' } },
    ];
    const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    const inspection = inspectAcquiredSessionPort({
      sourceRow: row,
      stableSource: {
        bytes,
        sha256: 'd'.repeat(64),
        highWaterBytes: bytes.length,
        completeBytes: bytes.length,
        source: 'live-jsonl',
        relpath: null,
      },
      target: { ...target, availableInputTokens: 2_000 },
    });
    expect(inspection.requiresSummary).toBe(true);
    const summarizer = vi.fn(async ({ text }: { text: string }) => {
      expect(text).not.toContain(secret);
      expect(text).toContain('[redacted]');
      return { text: 'Older work was summarized safely.', model: 'summary-model', provider: 'gateway' };
    });
    await expect(prepareInspectedSessionPort({
      inspection,
      expectedSourceHash: inspection.source.sha256,
      tokenKey: 'key',
      artifactRoot: mkdtempSync(join(tmpdir(), 'port-summary-')),
      summarizer,
      findExisting: async () => null,
      createPrepared: async (input: any) => ({
        ...input,
        status: 'prepared',
        targetAdvSessionId: null,
        error: null,
        preparedAt: '2026-07-14T00:00:00.000Z',
        pendingAt: null,
        deliveredAt: null,
        failedAt: null,
      }),
    })).resolves.toMatchObject({ summary: { fidelity: 'summary-tail' } });
    expect(summarizer).toHaveBeenCalledTimes(1);
  });
});
