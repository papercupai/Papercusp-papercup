import { describe, expect, it } from 'vitest';
import { encode } from '@papercusp/result-encoding';
import { type BuiltSpawnContext } from '../_mcp-host';
import { withMcpDiagnosticWarnings, type McpCallResult } from '../mcp-diagnostic-warnings';

function context(overrides: Partial<BuiltSpawnContext> = {}): BuiltSpawnContext {
  return {
    workspaceId: 'papercusp-workspace',
    harnessSlug: 'papercusp',
    role: 'operator',
    featureId: null,
    chunkId: null,
    runId: 'run-1',
    spawnId: 'spawn-1',
    parentSpawnId: null,
    uiClientId: 'su-1',
    ...overrides,
    detectorSessionKey: overrides.detectorSessionKey ?? null,
  };
}

describe('withMcpDiagnosticWarnings', () => {
  it('adds the proxy degradation warning to a JSON tool result', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [] }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );
    const body = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(body.ok).toBe(true);
    expect(body._dataPlaneMayBeDegraded).toContain('2026-09-04T20:00:00.000Z');
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('does not warn for an explicitly authoritative empty result', () => {
    const body = { ecosystem: 'react-tailwind', results: [], authoritative: true };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated successful result', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, results: [{ id: 'WI-10000979' }] }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );
    const body = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(body).toEqual({ ok: true, results: [{ id: 'WI-10000979' }] });
    expect(annotated._meta).toBeUndefined();
  });

  it.each([
    ['line body', {
      ok: true,
      file_path: '/tmp/result.spill',
      body: 'requested file content',
      total_lines: 1,
      start_line: 1,
      end_line: 1,
      has_more: false,
    }],
    ['empty file body', {
      ok: true,
      file_path: '/tmp/empty.txt',
      body: '',
      total_lines: 0,
      start_line: null,
      end_line: null,
      has_more: false,
    }],
    ['empty byte page', {
      ok: true,
      file_path: '/tmp/empty.txt',
      encoding: 'base64',
      byte_offset: 0,
      byte_length: 0,
      total_bytes: 0,
      eof: true,
      data: '',
      next_cursor: null,
    }],
    ['selected scratch content', {
      ok: true,
      file_path: '/tmp/result.spill',
      reference: { uri: 'papercusp://scratch/result.spill' },
      selected_indexes: [0],
      total_content_items: 1,
      content: [{ type: 'text', text: 'requested file content' }],
    }],
  ])('does not warn on a successful capability:read %s result', (_mode, structuredContent) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: 'capability:read result' }],
      structuredContent,
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it.each([
    ['returned matches', [{ line: 12, text: 'measurementPin', before: [], after: [] }], 3],
    ['positive count', [], 3],
  ])('does not warn on a populated capability:read query with %s', (_case, matches, matchCount) => {
    const body = {
      ok: true,
      file_path: '/tmp/result.spill',
      query: 'measurementPin',
      terms: ['measurementPin'],
      view: 'json-pretty',
      matches,
      matchCount,
      nextFromLine: null,
      coverage: {
        payloadBytes: 31543,
        searchedLines: 40,
        fromLine: 1,
        scannedToEnd: true,
        upstreamPartialMarkers: 0,
      },
      next_cursor: null,
      read_around: {
        tool: 'capability:read',
        args: { file_path: '/tmp/result.spill', view_lines: { offset: 9, limit: 40 } },
      },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };

    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-15T08:54:26.113Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('still warns on an empty capability:read query result', () => {
    const resultBody = {
      ok: true,
      file_path: '/tmp/result.spill',
      query: 'measurementPin',
      terms: ['measurementPin'],
      view: 'json-pretty',
      matches: [],
      matchCount: 0,
      nextFromLine: null,
      coverage: {
        payloadBytes: 31543,
        searchedLines: 40,
        fromLine: 1,
        scannedToEnd: true,
        upstreamPartialMarkers: 0,
      },
      next_cursor: null,
      note: 'No line in the searched view contains every term.',
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(resultBody) }],
    };

    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-15T08:54:26.113Z') }),
    );
    const body = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('does not warn on a populated sessions:read result with turns', () => {
    const body = {
      ok: true,
      session_id: 'session-1',
      turn_count: 1,
      turns: [{ turn_idx: 0, speaker: 'assistant', text: 'stored transcript turn' }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not warn for successful capability:git-evidence result envelopes', () => {
    const bodies = [
      {
        ok: true,
        op: 'readFileAtCommit',
        commitSha: 'a'.repeat(40),
        path: 'empty.txt',
        bytes: 0,
        content: '',
      },
      {
        ok: true,
        op: 'readFileAtCommit',
        commitSha: 'b'.repeat(40),
        path: 'large.txt',
        encoding: 'base64',
        byte_offset: 0,
        byte_length: 1,
        total_bytes: 2,
        eof: false,
        data: 'YQ==',
        next_cursor: {
          tool: 'capability:git-evidence',
          args: { op: 'readFileAtCommit', commitSha: 'b'.repeat(40), path: 'large.txt', byte_offset: 1, byte_limit: 1 },
        },
      },
      {
        ok: true,
        op: 'isAncestor',
        ancestorSha: 'c'.repeat(40),
        descendantSha: 'd'.repeat(40),
        isAncestor: false,
      },
    ];

    for (const body of bodies) {
      const result: McpCallResult = {
        content: [{ type: 'text', text: JSON.stringify(body) }],
      };
      const annotated = withMcpDiagnosticWarnings(
        result,
        context({ dataPlaneDegradedAtMs: Date.parse('2026-10-09T12:09:30.235Z') }),
      );

      expect(annotated).toBe(result);
      expect(annotated._meta).toBeUndefined();
    }
  });

  it('does not warn for a populated coord:await-inbox watch result', () => {
    const body = {
      ok: true,
      watch: { id: 42, pattern: 'coord:inbox-wake:su-test', wake: true, once: false },
      inbox_wake_key: 'coord:inbox-wake:su-test',
      reachability: { before: { reachable: true }, after: { reachable: true } },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };

    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-08T10:23:20.854Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not warn for a populated sessions:list result', () => {
    const body = { ok: true, count: 1, total: 1, sessions: [{ session_id: 'session-1' }] };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };

    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-09T06:10:34.376Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not warn for populated structuredContent when the MCP result has no text block', () => {
    const result: McpCallResult = {
      content: [],
      structuredContent: {
        ok: true,
        results: [{ ok: true, id: 'WI-10000979', workItem: { id: 'WI-10000979' } }],
        counts: { ok: 1, failed: 0 },
      },
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-07T19:21:35.306Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not warn for a populated successful code:run summary wrapper', () => {
    const body = {
      ok: true,
      summary: { results: [{ id: 'EI-25259151188281694' }] },
      logs: [],
      dryRun: false,
      dispatchCount: 1,
      intermediateBytes: 128,
      runtimeObservations: {},
      plannedMutations: [],
      okFalseMutations: [],
      childFailures: [],
      partial: false,
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T19:18:34.058Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('keeps the warning for an empty successful code:run summary wrapper', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          summary: { results: [] },
          logs: [],
          dryRun: false,
          dispatchCount: 0,
          intermediateBytes: 0,
          runtimeObservations: {},
          plannedMutations: [],
          okFalseMutations: [],
          childFailures: [],
          partial: false,
        }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T19:18:34.058Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)._dataPlaneMayBeDegraded)
      .toContain('unexpected empty/not-found');
  });

  it('does not warn for a populated singular facts:assert fact result', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, fact: { key: 'guard-rail:example', body: 'verified result' } }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T19:18:34.058Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('keeps the warning for an empty singular fact result', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, fact: {} }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T19:18:34.058Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)._dataPlaneMayBeDegraded)
      .toContain('unexpected empty/not-found');
  });

  it('does not warn for a populated dev:pg_query rows result', () => {
    const body = {
      mode: 'query',
      rowCount: 38,
      truncated: false,
      fields: ['n'],
      elapsedMs: 322,
      rows: Array.from({ length: 38 }, (_, index) => ({ n: index + 1 })),
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T10:08:38.199Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for a populated fleet:assignments agents result', () => {
    const body = {
      ok: true,
      self: { ownerId: 'su-1' },
      summary: { agents: 1 },
      agents: [{ agentId: 'su-1', claims: [], present: true }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T13:54:40.696Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('keeps the warning for an empty fleet:assignments agents result', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true, agents: [] }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T13:54:40.696Z') }),
    );
    const body = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(body._dataPlaneMayBeDegraded).toContain('2026-10-06T13:54:40.696Z');
  });

  it.each([
    ['loop:status', { ok: true, ownerId: 'su-1', loop: { active: true, goal: 'keep working' } }],
    ['scheduler:get_next', { ok: true, workItem: { id: 'EI-25212384048274593', state: 'open' } }],
    ['scheduler:get_claim_spec', { ok: true, source: 'fleet', spec: { kinds: ['bug'] } }],
    ['events:status', { ok: true, event_inspection: { current_generation: 1, current_state: 'fired', waiters: [{ await_id: 229122, state: 'fired' }] } }],
  ])('does not warn for a populated %s result envelope', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T09:18:42.036Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it.each([
    ['scorecards:list', { ok: true, count: 1, scorecards: [{ issueId: 'EI-1' }] }],
    ['plans:get-specs', { ok: true, count: 1, specs: [{ specId: 'SPEC-001' }] }],
    ['plans:get-spec-evidence', { ok: true, count: 1, evidence: [{ bindingId: 1 }] }],
    ['plans:evaluate-spec-test-adequacy', { ok: true, count: 1, rows: [{ specId: 'SPEC-001' }] }],
  ])('does not warn for populated %s data arrays', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T21:21:10.000Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it.each([
    ['plans:get-spec-evidence', { evidence: [{ details: { adequacy: { outcome: 'caught' } } }] }],
    ['scorecards:get', { scorecard: { gradingAudit: { state: 'pending' }, auditTarget: { id: 'EI-1' }, evidenceFingerprint: 'abc123' } }],
  ])('does not warn for a populated %s result without an ok field', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T12:09:48.129Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it.each([
    ['scorecards:list', { ok: true, count: 0, scorecards: [] }],
    ['plans:get-specs', { ok: true, count: 0, specs: [] }],
    ['plans:get-spec-evidence', { ok: true, count: 0, evidence: [] }],
    ['plans:evaluate-spec-test-adequacy', { ok: true, count: 0, rows: [] }],
  ])('keeps the warning for empty %s data arrays', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T21:21:10.000Z') }),
    );
    const annotatedBody = JSON.parse((annotated.content[0] as { text: string }).text);

    expect(annotatedBody._dataPlaneMayBeDegraded).toContain('DATA PLANE MAY BE DEGRADED');
  });

  it.each([
    ['improvements:capture', {
      ok: true,
      created: false,
      reason: 'coalesced',
      coalescedOnto: { id: 'EI-22040058994011473', repeatCount: 2 },
      issue: { id: 'EI-22040058994011473', kind: 'change', state: 'open' },
    }],
    ['locks:acquire', {
      ok: true,
      lock_id: '29ee5601-ba68-487e-9136-f0534ced9aa4',
      held: ['packages/operator-core/lib/endpoint-route/routes/transport/mcp-diagnostic-warnings.ts'],
      newly_held: ['packages/operator-core/lib/endpoint-route/routes/transport/mcp-diagnostic-warnings.ts'],
    }],
  ])('does not warn for a populated %s domain result', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T13:28:18.593Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for a populated scorecards:get result with complete criterion evidence', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        scorecard: {
          issueId: 'EI-24800707337861422',
          criteria: [{ key: 'oracle-independence', rating: 'pass', evidence: 'complete criterion evidence' }],
        },
        evidenceRead: { complete: true, scope: 'selected-criterion', offset: 2540, totalChars: 5081 },
      }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T02:32:07.251Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toMatchObject({
      scorecard: { issueId: 'EI-24800707337861422' },
      evidenceRead: { complete: true },
    });
  });

  it('does not warn for a scorecards:emit result with a recorded completion receipt', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({
        ok: true,
        created: true,
        issueId: 'EI-24889905021992714',
        completionReceipt: { status: 'recorded', effectRef: 'EI-24889905021992714' },
      }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T17:34:18.330Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
  });

  it.each([
    ['facts:list', { ok: true, mode: 'key', found: true, count: 1, facts: [{ key: 'guard-rail:example' }] }],
    ['tools:find', { ok: true, hits: [{ tool: 'facts:list' }] }],
  ])('does not warn for populated %s result arrays', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not warn for a populated tools:find envelope without an ok field', () => {
    const body = {
      query: 'mcp-diagnostic-warnings',
      count: 1,
      totalMatches: 1,
      truncated: false,
      activated: false,
      hits: [{ tool: 'facts:list' }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T06:26:03.371Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for a populated testing:runs ledger envelope without an ok field', () => {
    const body = {
      count: 3,
      total: 3,
      truncatedByLimit: false,
      latestPerFile: false,
      effectiveSourceFilter: 'none (exact testRunIds receipt lookup)',
      omittedBySourceFilter: 0,
      runs: [{ id: 20649884, filePath: 'packages/operator-core/lib/example.test.ts', status: 'pass' }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-03T07:06:23.421Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('does not warn for populated activity:tool-log counts', () => {
    const body = {
      ok: true,
      calls: 11,
      rawRows: 14,
      span: { from: '2026-10-05T17:44:30Z', to: '2026-10-05T17:52:30Z' },
      log: 'tools_invoke ×11 ·',
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-05T17:52:29.000Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('keeps the warning for empty activity:tool-log counts', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: true,
          calls: 0,
          rawRows: 0,
          span: { from: '2026-10-05T17:44:30Z', to: '2026-10-05T17:52:30Z' },
          log: '',
        }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-05T17:52:29.000Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('keeps the warning for an empty tools:find envelope without an ok field', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({ query: 'mcp-diagnostic-warnings', count: 0, totalMatches: 0, hits: [] }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-02T06:26:03.371Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('keeps the proxy degradation warning on an empty facts:list key lookup', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({ ok: true, mode: 'key', key: 'guard-rail:absent', found: false, count: 0, facts: [] }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('does not add the proxy degradation warning to a populated TOON bulk result', () => {
    const body = {
      ok: true,
      results: [{ ok: true, id: 'EI-22641900519389010', post: { id: 203955 } }],
      counts: { ok: 1, failed: 0 },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: `format: toon\n${encode(body, 'toon')}` }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    expect(annotated).toEqual(result);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not warn on a recoverable output envelope containing evidence references', () => {
    const body = {
      schemaVersion: 'papercusp.output-envelope/v1',
      summary: '',
      summaryProvenance: 'authored',
      content: [{
        kind: 'evidence-reference',
        uri: 'papercusp://scratch/papercusp-workspace/scorecards:get/result.spill',
        preview: 'criterion page',
        byteCount: 2048,
        sha256: 'abc123',
        expiresAt: '2026-10-07T00:00:00.000Z',
        ownerId: 'su-1',
        audience: 'owner',
        evidenceClass: 'work-item',
      }],
      state: 'incomplete',
      incomplete: {
        reason: 'aggregate-output-budget-exceeded',
        spilledItems: 1,
        recoverable: true,
        note: 'Read the evidence reference to recover the complete result.',
      },
      metrics: {},
      accounting: { summaryChars: 0, summaryBytes: 0, contentBytes: 128, totalBytes: 128, summaryBudgetChars: 0 },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };

    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-06T02:24:09.000Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it.each([
    ['loop:end', { ok: true, ended: true }],
    ['events:await', { ok: true, await_id: 158065 }],
    ['loop:checkpoint', { ok: true, verified: true, contentHash: '81efa6f12cc1' }],
  ])('does not add the proxy degradation warning to a successful %s lifecycle result', (_tool, body) => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:19:37.402Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated coord:declare-intent result', () => {
    const body = {
      ok: true,
      presence: { ownerId: 'su-1', intent: 'verify warning classification' },
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated coord:whoami identity result', () => {
    const body = {
      ownerId: 'su-1',
      ownerLabel: 'su · su-1',
      source: 'omp-hook-session',
      workspaceId: 'papercusp-workspace',
      inbox_wake_key: 'coord-wake:su-1',
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('does not add the proxy degradation warning to a populated coord:inbox result without ok', () => {
    const body = {
      owner_id: 'su-1',
      summary: { total: 1, returned: 1 },
      entries: [{ msg_id: 'coord-send-1' }],
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
    expect(annotated._meta).toBeUndefined();
  });

  it('keeps the proxy degradation warning on an empty coord:inbox result', () => {
    const result: McpCallResult = {
      content: [{
        type: 'text',
        text: JSON.stringify({ owner_id: 'su-1', summary: { total: 0, returned: 0 }, entries: [] }),
      }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-06T17:27:06.548Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('keeps the warning for an unknown successful envelope shape', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') }),
    );

    const body = JSON.parse((annotated.content[0] as { text: string }).text);
    expect(body._dataPlaneMayBeDegraded).toContain('unexpected empty/not-found');
  });

  it('does not warn on a successful work_items:park receipt during the retry window', () => {
    // The observed park response had this receipt shape with released:true and noted:true.
    // Lengths are deterministic fixture values; the classification depends on the receipt.
    const body = {
      ok: true,
      id: 'WI-10005876',
      harness: 'papercusp',
      priorLength: 96,
      checkpointChars: 420,
      released: true,
      noted: true,
      by: 'su-5bcbcf19-e213-4f86-b2c6-185c12636983',
    };
    const result: McpCallResult = {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };

    const annotated = withMcpDiagnosticWarnings(
      result,
      context({ dataPlaneDegradedAtMs: Date.parse('2026-10-07T04:44:01.054Z') }),
    );

    expect(annotated).toBe(result);
    expect(annotated._meta).toBeUndefined();
    expect(JSON.parse((annotated.content[0] as { text: string }).text)).toEqual(body);
  });

  it('uses _meta for non-JSON text and composes with the scope warning', () => {
    const result: McpCallResult = {
      content: [{ type: 'text', text: 'plain text result' }],
      _meta: { preserved: true },
    };
    const annotated = withMcpDiagnosticWarnings(
      result,
      context({
        workspaceResolution: 'registry-fallback',
        dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z'),
      }),
    );

    expect(annotated._meta).toMatchObject({
      preserved: true,
      scopeGuessWarning: expect.stringContaining('SCOPE GUESSED'),
      dataPlaneMayBeDegraded: expect.stringContaining('DATA PLANE MAY BE DEGRADED'),
    });
  });

  it('is a byte-identical no-op without a diagnostic signal or for an error result', () => {
    const healthy: McpCallResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const failed: McpCallResult = {
      content: [{ type: 'text', text: 'failed' }],
      isError: true,
    };

    expect(withMcpDiagnosticWarnings(healthy, context())).toBe(healthy);
    expect(
      withMcpDiagnosticWarnings(failed, context({ dataPlaneDegradedAtMs: Date.parse('2026-09-04T20:00:00.000Z') })),
    ).toBe(failed);
  });
});
