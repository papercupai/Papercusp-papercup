import { describe, expect, it } from 'vitest';
import type { OrchestrationCallRecord, ProjectedTool } from '@papercusp/tooldef';
import { fingerprintShellOperation, normalizeExecutionTrace, readableOperationEvidence, type OperationAdapterEvidence } from './orchestration-trace';
import { fingerprintSqlIntent, type SqlIntentScope } from './bash-substitution/sql-intent-fingerprint';

function tool(name: string, capabilities: string[], effect: 'read' | 'write' = 'read'): ProjectedTool {
  return {
    pluginName: 'test',
    description: name,
    inputSchema: { type: 'object' },
    capabilities,
    effect,
    expose: { mcp: { name } },
    fn: async () => ({ content: [] }),
  } as unknown as ProjectedTool;
}

const TOOLS = [
  tool('work_items:get', ['work:read']),
  tool('capability:write_stdin', ['capability:bash'], 'write'),
  tool('assets:render', ['assets:read']),
];

const SCOPE: SqlIntentScope = { workspaceId: 'workspace-a', sourceBoundary: 'source-private', epoch: 'epoch-1', key: new Uint8Array(32).fill(31) };
const shell = (overrides: Partial<Parameters<typeof fingerprintShellOperation>[0]> = {}, scope = SCOPE) =>
  fingerprintShellOperation({ command: 'printf "%s" "$MODE" | cat > result.txt', cwd: '/work/alpha', environment: { MODE: 'report' }, effect: 'write', ...overrides }, scope);
function operation(overrides: Partial<OperationAdapterEvidence> = {}): OperationAdapterEvidence {
  return {
    operationId: 'invocation:100', family: 'shell', adapterVersion: 'shell-quote:operation-v1',
    semanticIdentity: { version: 'shell-quote:operation-v1', fingerprint: 'a'.repeat(64),
      workspaceId: SCOPE.workspaceId, sourceBoundary: SCOPE.sourceBoundary, epoch: SCOPE.epoch },
    source: { ref: 'native-receipt:100', authorityRef: 'source-acl:100', observedAt: '2026-11-05T12:00:00Z',
      expiresAt: '2026-11-07T12:00:00Z', providerCallId: 'call:100', parentOperationId: 'invocation:99' },
    outcome: { status: 'success', final: true, receiptRef: 'result:100' }, replayClass: 'read-only',
    bindingSchema: { version: 1, properties: { cwd: { type: 'string', lifetime: { kind: 'invocation-ephemeral' } } }, additionalProperties: false },
    decisionRefs: ['review:edition-1'], ...overrides,
  };
}

describe('P002 operation adapter contracts', () => {
  it('shell-equivalent-format: canonicalizes safe token formatting while retaining operators and bindings', () => {
    expect(shell()).toMatchObject({ status: 'supported' });
    expect(shell({ command: ' printf   %s  "${MODE}" | cat > result.txt' })).toMatchObject({ status: 'unknown' });
    expect(shell({ command: ' printf   %s  "$MODE"  | cat > result.txt # a comment' })).toEqual(shell());
    expect(shell({ command: 'printf %s \'$MODE\' | cat > result.txt' })).not.toEqual(shell());
  });

  it.each([
    ['shell-cwd', { cwd: '/work/beta' }],
    ['shell-environment', { environment: { MODE: 'different' } }],
    ['shell-environment-type', { environment: { MODE: 1 } }],
    ['shell-effects', { effect: 'read' as const }],
    ['shell-operators', { command: 'printf "%s" "$MODE" && cat > result.txt' }],
    ['shell-redirection', { command: 'printf "%s" "$MODE" | cat >> result.txt' }],
  ])('%s: distinguishes a meaningful shell change', (_name, change) => {
    const first = shell(), second = shell(change);
    expect(first.status).toBe('supported'); expect(second.status).toBe('supported');
    expect(second).not.toEqual(first);
  });

  it('retains typed environment values, key ordering and scope boundaries without retaining raw values', () => {
    expect(shell({ environment: { MODE: 'report', LIMIT: 1 } })).toEqual(shell({ environment: { LIMIT: 1, MODE: 'report' } }));
    expect(shell({ environment: { MODE: '1' } })).not.toEqual(shell({ environment: { MODE: 1 } }));
    expect(shell({}, { ...SCOPE, sourceBoundary: 'another-source' })).not.toEqual(shell());
    expect(shell({}, { ...SCOPE, workspaceId: 'workspace-b' })).not.toEqual(shell());
    expect(shell({}, { ...SCOPE, epoch: 'epoch-2' })).not.toEqual(shell());
    expect(JSON.stringify(shell())).not.toContain('/work/alpha');
    expect(JSON.stringify(shell())).not.toContain('report');
  });

  it.each(['echo $(id)', 'echo `id`', 'cat *.sql', 'echo x\necho y', 'cat <<EOF', 'if true; then echo x; fi'])('keeps unsupported shell syntax unknown: %s', command => {
    expect(shell({ command })).toMatchObject({ status: 'unknown' });
  });

  it('refuses secret-bearing shell identity and invalid key scope rather than hashing credentials', () => {
    expect(shell({ environment: { API_TOKEN: 'short' } })).toMatchObject({ status: 'unknown', reason: 'secret-bearing-source' });
    expect(shell({ command: 'echo opaque-secret' }, { ...SCOPE, knownSecrets: ['opaque-secret'] })).toMatchObject({ status: 'unknown' });
    expect(shell({}, { ...SCOPE, key: new Uint8Array(1) })).toMatchObject({ status: 'unknown', reason: 'invalid-scope' });
  });

  it('serializes scoped SQL/parser identity, bindings, outcome and decision editions without raw source or author privilege', async () => {
    const sql = "select id, payload->>'state' from events where status = 'ready' order by id limit 5";
    const identity = fingerprintSqlIntent(sql, SCOPE);
    expect(identity.status).toBe('supported');
    if (identity.status !== 'supported') throw new Error(identity.reason);
    const input = operation({ family: 'sql', adapterVersion: identity.version,
      semanticIdentity: { ...operation().semanticIdentity, version: identity.version, fingerprint: identity.fingerprint } });
    Object.assign(input, { rawSql: sql, authorPrincipal: 'system:superuser' });
    const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: TOOLS, operations: [input] });
    const readback = JSON.parse(JSON.stringify(trace));
    expect(readback.schemaVersion).toBe(2);
    expect(readback.operations).toEqual([operation({ family: 'sql', adapterVersion: identity.version,
      semanticIdentity: { ...operation().semanticIdentity, version: identity.version, fingerprint: identity.fingerprint } })]);
    expect(JSON.stringify(readback)).not.toContain(sql);
    expect(JSON.stringify(readback)).not.toContain('system:superuser');
    input.source.authorityRef = 'revoked-after-copy'; input.decisionRefs.push('late:change');
    expect(readback.operations[0].source.authorityRef).toBe('source-acl:100');
    expect(trace.operations![0].decisionRefs).toEqual(['review:edition-1']);
  });

  it('does not use shared tool/table names to collapse distinct SQL semantics', async () => {
    const queries = [
      'select id from events where status = \'ready\' order by id limit 5',
      'select status from events where status = \'ready\' order by id limit 5',
      'select id from events where status = \'failed\' order by id limit 5',
      'select id from events where status = \'ready\' order by id desc limit 5',
      'select id from events where status = \'ready\' order by id limit 6',
      'select payload->>\'left\' from events', 'select payload->>\'right\' from events',
      'select e.id from events e join actors a on e.actor_id = a.id',
      'select e.id from events e left join actors a on e.actor_id = a.id',
      'select status, count(*) from events group by status',
      'select id, count(*) from events group by id',
    ];
    const fingerprints = await Promise.all(queries.map(async sql => {
      const semantic = fingerprintSqlIntent(sql, SCOPE);
      expect(semantic.status).toBe('supported');
      if (semantic.status !== 'supported') throw new Error(semantic.reason);
      const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: TOOLS,
        operations: [operation({ family: 'sql', adapterVersion: semantic.version,
          semanticIdentity: { ...operation().semanticIdentity, version: semantic.version, fingerprint: semantic.fingerprint } })] });
      return trace.structuralFingerprint;
    }));
    expect(new Set(fingerprints).size).toBe(queries.length);
  });

  it('preserves outcome/provenance without letting them change semantic identity', async () => {
    const a = operation(), b = operation({ operationId: 'invocation:200', outcome: { status: 'refused', final: true },
      source: { ...operation().source, ref: 'source:other', providerCallId: 'call:other' }, decisionRefs: ['review:edition-2'] });
    const make = (op: OperationAdapterEvidence) => normalizeExecutionTrace({ script: 'return 1;', tools: TOOLS, operations: [op] });
    const [first, second] = await Promise.all([make(a), make(b)]);
    expect(first.structuralFingerprint).toBe(second.structuralFingerprint);
    expect(second.operations![0].outcome.status).toBe('refused');
  });

  it('rechecks current workspace, ACL and expiry on every evidence read and fails closed on unknown time', async () => {
    const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: TOOLS, operations: [operation()] });
    const now = Date.parse('2026-11-06T12:00:00Z');
    let authorized = true;
    const context = { workspaceId: SCOPE.workspaceId, now, canRead: () => authorized };
    expect(readableOperationEvidence(trace, context)).toHaveLength(1);
    authorized = false;
    expect(readableOperationEvidence(trace, context)).toEqual([]);
    expect(readableOperationEvidence(trace, { ...context, canRead: () => true, workspaceId: 'workspace-b' })).toEqual([]);
    expect(readableOperationEvidence(trace, { ...context, canRead: () => true, now: Date.parse('2026-11-07T12:00:00Z') })).toEqual([]);
    expect(readableOperationEvidence(trace, { ...context, canRead: () => true, now: NaN })).toEqual([]);
  });

  it('keeps source/runtime order distinct from explicit observed dependencies; refuses invalid graphs', async () => {
    const ops = [operation(), operation({ operationId: 'invocation:101' })];
    const make = (dependencies: Parameters<typeof normalizeExecutionTrace>[0]['dependencies']) =>
      normalizeExecutionTrace({ script: 'return 1;', tools: TOOLS, operations: ops, dependencies });
    const first = await make([]);
    expect(first.dependencies).toEqual([]);
    const edge = { fromOperationId: 'invocation:100', toOperationId: 'invocation:101', kind: 'data' as const, evidenceRef: 'binding-receipt:1' };
    const dependent = await make([edge]);
    expect(dependent.structuralFingerprint).not.toBe(first.structuralFingerprint);
    await expect(make([{ ...edge, toOperationId: 'missing:operation' }])).rejects.toThrow('invalid_operation_dependency');
    await expect(make([edge, { ...edge, fromOperationId: edge.toOperationId, toOperationId: edge.fromOperationId }])).rejects.toThrow('invalid_operation_dependency');
  });

  it.each(['search-reformulation', 'result-recovery', 'workaround-funnel'] as const)('keeps %s evidence in the existing trace rail', async family => {
    const trace = await normalizeExecutionTrace({ script: 'return 1;', tools: TOOLS, operations: [operation({ family })] });
    expect(JSON.parse(JSON.stringify(trace)).operations[0].family).toBe(family);
    expect(readableOperationEvidence({ operations: undefined }, { workspaceId: SCOPE.workspaceId, now: 1, canRead: () => true })).toEqual([]);
  });

  it('refuses duplicate operation IDs, raw content in references and invalid binding lifetimes', async () => {
    const make = (operations: OperationAdapterEvidence[]) => normalizeExecutionTrace({ script: 'return 1;', tools: TOOLS, operations });
    await expect(make([operation(), operation()])).rejects.toThrow('invalid_operation_evidence');
    await expect(make([operation({ source: { ...operation().source, ref: 'select private_data from users' } })])).rejects.toThrow('invalid_operation_evidence');
    await expect(make([operation({ bindingSchema: { version: 1, additionalProperties: false,
      properties: { credential: { type: 'secret-ref', lifetime: { kind: 'stable' } } } } })])).rejects.toThrow('secret-ref');
  });
});

describe('normalizeExecutionTrace (P-013)', () => {
  it('parameterizes stable authority bindings and excludes their values from the fingerprint', async () => {
    const first = await normalizeExecutionTrace({
      script: `return tools.workItems.get({ id: 'WI-100', harness: 'alpha' });`,
      tools: TOOLS,
    });
    const second = await normalizeExecutionTrace({
      script: `return tools.workItems.get({ id: 'WI-999', harness: 'omega' });`,
      tools: TOOLS,
    });

    expect(first.stableBindings).toEqual([
      { parameter: 'harness:1', kind: 'harness', value: 'alpha' },
      { parameter: 'item:1', kind: 'item', value: 'WI-100' },
    ]);
    expect(first.toolGraph.staticCalls[0]?.args).toEqual({
      harness: { $binding: 'harness:1' },
      id: { $binding: 'item:1' },
    });
    expect(first.structuralFingerprint).toBe(second.structuralFingerprint);
  });

  it('removes secret-bearing values and classifies ephemeral session/process/path values without retaining them', async () => {
    const trace = await normalizeExecutionTrace({
      script: `return tools.capability.writeStdin({
        sessionId: 'pty-secret-session',
        pid: 424242,
        cursor: 'cursor-secret-value',
        path: '/tmp/private-20260822.log',
        apiKey: 'top-secret-key',
        chars: 'Authorization: bearer also-secret'
      });`,
      tools: TOOLS,
    });
    const serialized = JSON.stringify(trace);

    expect(serialized).not.toContain('pty-secret-session');
    expect(serialized).not.toContain('424242');
    expect(serialized).not.toContain('cursor-secret-value');
    expect(serialized).not.toContain('/tmp/private-20260822.log');
    expect(serialized).not.toContain('top-secret-key');
    expect(serialized).not.toContain('also-secret');
    expect(trace.redactedSecretPaths).toEqual(['staticCalls[0].args.apiKey']);
    expect(trace.ephemeralValues.map((entry) => entry.kind)).toEqual([
      'cursor',
      'temp-path',
      'process-id',
      'session-id',
    ]);
    expect(trace.portability).toEqual({
      host: 'same',
      replayability: 'mixed',
      ephemeralKinds: ['cursor', 'process-id', 'session-id', 'temp-path'],
    });
  });

  it('preserves validated output-reference identity but excludes it and runtime outcomes from the fingerprint', async () => {
    const record = (uri: string, sha256: string, disposition: OrchestrationCallRecord['disposition']): OrchestrationCallRecord => ({
      ordinal: 0,
      tool: 'assets:render',
      effect: 'read',
      disposition,
      outputReferences: [{ uri, byteCount: 42, sha256, audience: 'workspace' }],
    });
    const script = `return tools.assets.render({ format: 'png' });`;
    const first = await normalizeExecutionTrace({
      script,
      tools: TOOLS,
      backend: 'server',
      callRecords: [record('papercusp://results/one', 'a'.repeat(64), 'settled')],
    });
    const second = await normalizeExecutionTrace({
      script,
      tools: TOOLS,
      backend: 'client-compat',
      callRecords: [record('papercusp://results/two', 'b'.repeat(64), 'uncertain')],
    });

    expect(first.toolGraph.runtimeCalls[0]?.outputReferences).toEqual([
      {
        uri: 'papercusp://results/one',
        byteCount: 42,
        sha256: 'a'.repeat(64),
        audience: 'workspace',
      },
    ]);
    expect(first.requirements).toEqual({
      tools: ['assets:render'],
      capabilities: ['assets:read'],
      premises: ['host:same'],
    });
    expect(first.structuralFingerprint).toBe(second.structuralFingerprint);
    expect(second.portability.replayability).toBe('client-bound');
  });
});
