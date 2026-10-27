import { describe, expect, it, vi } from 'vitest';
import type { RecordOperationalRunDeps } from './record-run';
import {
  CONSULT_RECEIPT_CHECK_PATH,
  executeConsultReceiptMatrix,
  judgeConsultReceiptMatrix,
  type ConsultReceiptMatrixArtifact,
  type ConsultReceiptRows,
} from './native-check-consult-receipts';

const PLAN = 'get-feedback-reliability-usefulness-adoption-2026-10-03';
const REQUESTER = 'su-requester';
const EVIDENCE = 'docs/evidence/gf-native-live-test.json';

const CELLS = [
  { cell: 'claude-ended-to-claude-fork', mode: 'fork', conv: 'conv-request-a', source: 'su-src-a', answering: 'su-ans-a',
    port: null, agent: 'claude', operation: 'fork' },
  { cell: 'claude-ended-to-codex-conversion', mode: 'port', conv: 'conv-request-b', source: 'su-src-b', answering: 'su-ans-b',
    port: { id: 'port-b', source_backend: 'claude', target_backend: 'codex' }, agent: 'codex', operation: 'convert' },
  { cell: 'codex-live-to-codex-session-port', mode: 'port', conv: 'conv-request-c', source: 'su-src-c', answering: 'su-ans-c',
    port: { id: 'port-c', source_backend: 'codex', target_backend: 'codex' }, agent: 'codex', operation: 'convert' },
] as const;

function artifact(): ConsultReceiptMatrixArtifact {
  return {
    plan: PLAN,
    requesterId: REQUESTER,
    matrix: { cells: CELLS.map(c => ({ cell: c.cell, mode: c.mode, requestKey: `key-${c.cell}`, conversationId: c.conv,
      portId: c.port?.id ?? null, sourceOwnerId: c.source, answeringOwnerId: c.answering })) },
  };
}

function rows(): Pick<ConsultReceiptRows, 'consults' | 'posts' | 'ports'> {
  return {
    consults: CELLS.map(c => ({ conversation_id: c.conv, requester_id: REQUESTER, state: 'closed_answered',
      dispatch_attempts: [{ agent: c.agent, operation: c.operation, sourceOwnerId: c.source, answeringOwnerId: c.answering }] })),
    posts: CELLS.flatMap((c, i) => [
      { id: 100 + i * 2, thread_id: `thr-${c.conv}`, author_id: c.answering, len: 1800 },
      // A requester follow-up is never the answer, however long.
      { id: 101 + i * 2, thread_id: `thr-${c.conv}`, author_id: REQUESTER, len: 900 },
    ]),
    ports: CELLS.flatMap(c => c.port ? [{ id: c.port.id, source_backend: c.port.source_backend,
      target_backend: c.port.target_backend, status: 'delivered', delivered_at: '2026-10-27T07:30:00Z', error: null,
      source_adv_session_id: `adv-src-${c.cell}`, target_adv_session_id: `adv-tgt-${c.cell}` }] : []),
  };
}

const DEFINITION = {
  'claude-ended-to-claude-fork': { mode: 'fork', targetBackend: 'claude' },
  'claude-ended-to-codex-conversion': { mode: 'port', sourceBackend: 'claude', targetBackend: 'codex' },
  'codex-live-to-codex-session-port': { mode: 'port', sourceBackend: 'codex', targetBackend: 'codex' },
} as const;

const failedIds = (assertions: Array<{ id: string; passed: boolean }>) => assertions.filter(a => !a.passed).map(a => a.id);

describe('judgeConsultReceiptMatrix (R-6 receipt oracle)', () => {
  it('passes every defined cell when each native receipt and substantive dispatched answer is present', () => {
    const assertions = judgeConsultReceiptMatrix({ artifact: artifact(), definition: DEFINITION, rows: rows() });
    expect(failedIds(assertions)).toEqual([]);
    expect(assertions.map(a => a.id)).toEqual([
      'cell:claude-ended-to-claude-fork', 'cell:claude-ended-to-codex-conversion',
      'cell:codex-live-to-codex-session-port', 'matrix:all-defined-cells-checked']);
  });

  it('fails when the artifact omits a defined path instead of shrinking the matrix', () => {
    const a = artifact();
    a.matrix.cells = a.matrix.cells.filter(cell => cell.cell !== 'codex-live-to-codex-session-port');
    const assertions = judgeConsultReceiptMatrix({ artifact: a, definition: DEFINITION, rows: rows() });
    expect(failedIds(assertions)).toEqual(['cell:codex-live-to-codex-session-port', 'matrix:all-defined-cells-checked']);
  });

  it('fails a cell claimed successful from startup without a delivered port receipt', () => {
    const r = rows();
    r.ports[0] = { ...r.ports[0]!, status: 'pending', delivered_at: null };
    const assertions = judgeConsultReceiptMatrix({ artifact: artifact(), definition: DEFINITION, rows: r });
    expect(failedIds(assertions)).toEqual(['cell:claude-ended-to-codex-conversion', 'matrix:all-defined-cells-checked']);
    expect(assertions[1]!.evidence).toContain('port_delivered');
  });

  it('fails a fork dispatched to a backend other than the defined one', () => {
    const r = rows();
    r.consults[0] = { ...r.consults[0]!, dispatch_attempts: [{ agent: 'codex', operation: 'fork',
      sourceOwnerId: 'su-src-a', answeringOwnerId: 'su-ans-a' }] };
    const assertions = judgeConsultReceiptMatrix({ artifact: artifact(), definition: DEFINITION, rows: r });
    expect(failedIds(assertions)).toContain('cell:claude-ended-to-claude-fork');
    expect(assertions[0]!.evidence).toContain('fork_backend_matches_definition');
  });

  it('fails when only the requester posted, or the dispatched answer is below the substantive floor', () => {
    const silent = rows();
    silent.posts = silent.posts.filter(post => post.author_id === REQUESTER);
    expect(failedIds(judgeConsultReceiptMatrix({ artifact: artifact(), definition: DEFINITION, rows: silent })))
      .toHaveLength(4);
    const terse = rows();
    terse.posts = terse.posts.map(post => post.author_id === 'su-ans-b' ? { ...post, len: 120 } : post);
    const assertions = judgeConsultReceiptMatrix({ artifact: artifact(), definition: DEFINITION, rows: terse });
    expect(failedIds(assertions)).toEqual(['cell:claude-ended-to-codex-conversion', 'matrix:all-defined-cells-checked']);
    expect(assertions[1]!.evidence).toContain('substantive_answer_posted');
  });

  it('fails when the durable dispatch names a different answering session than the artifact claims', () => {
    const a = artifact();
    a.matrix.cells[2] = { ...a.matrix.cells[2]!, answeringOwnerId: 'su-someone-else' };
    const assertions = judgeConsultReceiptMatrix({ artifact: a, definition: DEFINITION, rows: rows() });
    expect(failedIds(assertions)).toContain('cell:codex-live-to-codex-session-port');
    expect(assertions[2]!.evidence).toContain('dispatched_session_matches_claim');
  });
});

describe('executeConsultReceiptMatrix (native, runtime-witnessed)', () => {
  function fixture(opts: { artifactText?: string; executedPort?: number } = {}) {
    const persist = vi.fn(async (_params: Parameters<RecordOperationalRunDeps['persist']>[0]) => ({ written: 1, ids: [91] }));
    const readRuntime = vi.fn(async (_units: string[], _workspaceId: string) => 'c'.repeat(64));
    const execution = { sourceRoot: vi.fn(async () => process.cwd()),
      snapshot: vi.fn(() => ({ commit: 'b'.repeat(40), porcelain: '' })),
      readRuntime, verifyDefinition: vi.fn(async () => true), persist };
    const readSource = vi.fn(async (_path: string) => opts.artifactText ?? JSON.stringify(artifact()));
    let calls = 0;
    const query = vi.fn(async (_ws: string, conversations: string[], _ports: string[]) => {
      calls += 1;
      const port = calls > 1 && opts.executedPort ? opts.executedPort : 5432;
      return { database: 'papercusp', port, ...(conversations.length ? rows() : { consults: [], posts: [], ports: [] }) };
    });
    const ctx = { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() };
    return { persist, readRuntime, query, readSource, ctx, deps: { readSource, query, execution } };
  }
  const recorded = (f: ReturnType<typeof fixture>) => f.persist.mock.calls[0]![0].rows[0]!;

  it('records a passing row against the committed check definition, witnessing only the database unit', async () => {
    const f = fixture();
    const result = await executeConsultReceiptMatrix(EVIDENCE, f.ctx, f.deps);
    expect(result).toMatchObject({ ok: true, status: 'pass', testRunIds: [91], runtimeEnvironmentMeasured: true });
    expect(f.readRuntime.mock.calls[0]![0]).toEqual(['postgres:5432']);
    expect(f.query.mock.calls[1]!.slice(1)).toEqual([['conv-request-a', 'conv-request-b', 'conv-request-c'], ['port-b', 'port-c']]);
    const row = recorded(f);
    expect(row.filePath).toBe(CONSULT_RECEIPT_CHECK_PATH);
    expect(row.execution).toMatchObject({ runtimeEnvironmentBefore: { units: ['postgres:5432'] },
      runtimeEnvironmentAfter: { units: ['postgres:5432'] } });
  });

  it('records a failing row when the matrix has no committed definition for its plan', async () => {
    const f = fixture({ artifactText: JSON.stringify({ ...artifact(), plan: 'some-other-plan' }) });
    expect(await executeConsultReceiptMatrix(EVIDENCE, f.ctx, f.deps)).toMatchObject({ ok: true, status: 'fail' });
    expect(recorded(f).outputTail).toContain('definition:matrix-defined');
  });

  it('records a failing row when execution reaches a different database than the one witnessed', async () => {
    const f = fixture({ executedPort: 6543 });
    expect(await executeConsultReceiptMatrix(EVIDENCE, f.ctx, f.deps)).toMatchObject({ ok: true, status: 'fail' });
    expect(recorded(f).outputTail).toContain('scope:database-unchanged');
  });

  it('refuses a path outside docs/evidence without executing or recording anything', async () => {
    const f = fixture();
    expect(await executeConsultReceiptMatrix('../etc/passwd.json', f.ctx, f.deps))
      .toEqual({ ok: false, error: 'invalid_evidence_file' });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.persist).not.toHaveBeenCalled();
  });
});
