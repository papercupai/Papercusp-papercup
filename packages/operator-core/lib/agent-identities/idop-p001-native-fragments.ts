import { createHash } from 'node:crypto';

export const nativeFragmentHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export type NativeFragmentSource = { nativeSessionId: string; ownerId: string; nativeSha256: string };
type RecordValue = Record<string, unknown>;
const object = (value: unknown): value is RecordValue => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`P001 native fragment: ${message}`);
}

/** Recognize the exact recorded wrapper without evaluating JavaScript or shell text. */
function catalogRequest(payload: RecordValue): number | null {
  if (payload.type !== 'custom_tool_call' || payload.name !== 'exec' || typeof payload.input !== 'string') return null;
  const literal = '"(?:[^"\\\\]|\\\\.)*"';
  const wrapper = new RegExp('^\\s*const r = await tools\\.exec_command\\(\\{\\s*cmd:\\s*(' + literal +
    '),\\s*workdir:\\s*' + literal + ',\\s*yield_time_ms:\\s*\\d+,\\s*max_output_tokens:\\s*\\d+\\s*\\}\\);\\s*text\\(JSON\\.stringify\\(r\\)\\);\\s*$');
  const match = wrapper.exec(payload.input);
  if (!match) return null;
  const command: string = JSON.parse(match[1]);
  const shell = /^ptool agent_tools:list --json - <<'JSON'\n([^\n]+)\nJSON$/.exec(command);
  if (!shell) return null;
  const args: unknown = JSON.parse(shell[1]);
  if (!object(args) || Object.keys(args).join() !== 'limit' || !Number.isSafeInteger(args.limit) || Number(args.limit) < 1) return null;
  return Number(args.limit);
}

/** Digest pins come from the independently retained source-recovery record, not this parser. */
export function extractIdopP001NativeFragments(bytes: Buffer, source: NativeFragmentSource) {
  requireProof(/^[a-f0-9]{64}$/.test(source.nativeSha256) && nativeFragmentHash(bytes) === source.nativeSha256,
    'native source digest mismatch');
  requireProof(source.ownerId.startsWith('su-') && source.ownerId.length > 3, 'source owner missing');
  const lines = bytes.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const records = lines.map((line, index) => {
    const value: unknown = JSON.parse(line);
    requireProof(object(value) && object(value.payload), `invalid native record at line ${index + 1}`);
    return { value, payload: value.payload, line, number: index + 1 };
  });
  const metadata = records.filter(row => row.value.type === 'session_meta');
  requireProof(metadata.length === 1 && metadata[0].payload.id === source.nativeSessionId &&
    metadata[0].payload.session_id === source.nativeSessionId, 'native session mismatch');
  const calls = records.filter(row => row.value.type === 'response_item' && row.payload.type === 'custom_tool_call');
  const outputs = records.filter(row => row.value.type === 'response_item' && row.payload.type === 'custom_tool_call_output');
  const fragments = [];
  const rejected: Array<{ line: number; callId: unknown; reason: string }> = [];
  for (const record of outputs) {
    const call = calls.filter(row => row.payload.call_id === record.payload.call_id);
    // Unrelated outputs are outside this instrument's population.
    if (!call.some(row => typeof row.payload.input === 'string' && row.payload.input.includes('ptool agent_tools:list'))) continue;
    try {
      requireProof(typeof record.payload.call_id === 'string' && call.length === 1 && call[0].number < record.number,
        'missing, duplicate, or out-of-order call pair');
      requireProof(outputs.filter(row => row.payload.call_id === record.payload.call_id).length === 1, 'duplicate call output');
      const limit = catalogRequest(call[0].payload);
      requireProof(limit !== null, 'unsupported catalog invocation wrapper');
      requireProof(Array.isArray(record.payload.output), 'missing native output blocks');
      const envelopes = record.payload.output.flatMap((block: unknown) => {
        if (!object(block) || block.type !== 'input_text' || typeof block.text !== 'string') return [];
        try {
          const value: unknown = JSON.parse(block.text);
          return object(value) && 'exit_code' in value ? [value] : [];
        } catch { return []; }
      });
      requireProof(envelopes.length === 1, 'missing or ambiguous shell envelope');
      const envelope = envelopes[0];
      requireProof(envelope.exit_code === 0 && typeof envelope.output === 'string' && !('session_id' in envelope),
        'shell did not finish successfully');
      const outputLines = envelope.output.split('\n');
      const traces = outputLines.filter(line => line.startsWith('ptool: connection trace ')).map(line =>
        JSON.parse(line.slice('ptool: connection trace '.length)) as RecordValue);
      requireProof(traces.length > 0 && traces.every(trace => trace.clientId === source.ownerId &&
        trace.toolName === 'agent_tools:list'), 'recorded caller attribution mismatch');
      const catalogs = outputLines.filter(line => /^\s*\{"callerRole"\s*:/.test(line));
      requireProof(catalogs.length === 1, 'missing or ambiguous catalog JSON line');
      let catalog: unknown;
      try { catalog = JSON.parse(catalogs[0]); }
      catch { throw new Error('P001 native fragment: catalog JSON is incomplete or invalid'); }
      requireProof(object(catalog) && typeof catalog.callerRole === 'string' && typeof catalog.isSuperuser === 'boolean' &&
        Number.isSafeInteger(catalog.count) && catalog.count === limit && typeof catalog._partial === 'boolean' &&
        Array.isArray(catalog.tools), 'invalid retained catalog header');
      const projection = catalog._projection;
      requireProof(object(projection) && projection.truncated === true && Array.isArray(projection.arrayTruncations),
        'missing explicit partial projection');
      const truncations = projection.arrayTruncations.filter((row: unknown) => object(row) && row.path === '$.tools');
      requireProof(truncations.length === 1 && object(truncations[0]), 'missing or ambiguous tool truncation');
      const truncation = truncations[0];
      requireProof(truncation.shownCount === catalog.tools.length && Number.isSafeInteger(truncation.renderedCount) &&
        Number(truncation.renderedCount) >= catalog.tools.length && Number(truncation.renderedCount) <= limit &&
        truncation.omittedCount === Number(truncation.renderedCount) - catalog.tools.length, 'inconsistent projection counts');
      const names = new Set<string>();
      const tools = catalog.tools.map((row: unknown) => {
        requireProof(object(row) && typeof row.name === 'string' && row.name.length > 0 && !names.has(row.name) &&
          typeof row.capability === 'string' && typeof row.allowed === 'boolean' && typeof row.description === 'string',
        'invalid or duplicate annotation row');
        names.add(row.name);
        return { name: row.name, capability: row.capability, allowed: row.allowed,
          retainedDescriptionSha256: nativeFragmentHash(row.description) };
      });
      requireProof(typeof record.value.timestamp === 'string' && Number.isFinite(Date.parse(record.value.timestamp)),
        'missing output timestamp');
      fragments.push({ sourceNative: source.nativeSessionId, sourceOwner: source.ownerId, nativeSha256: source.nativeSha256,
        line: record.number, recordSha256: nativeFragmentHash(record.line), recordHashIncludesLineTerminator: record.line.endsWith('\n'),
        timestamp: record.value.timestamp, callId: record.payload.call_id, priorCallLine: call[0].number,
        priorCallRecordSha256: nativeFragmentHash(call[0].line), priorCallHashIncludesLineTerminator: call[0].line.endsWith('\n'),
        nativeExitCode: 0, retainedCatalogLineSha256: nativeFragmentHash(catalogs[0]), callerRole: catalog.callerRole,
        isSuperuser: catalog.isSuperuser, declaredCount: catalog.count, partial: catalog._partial,
        projectionTruncated: true, projectionRenderedCount: Number(truncation.renderedCount), tools });
    } catch (error) {
      rejected.push({ line: record.number, callId: record.payload.call_id,
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { fragments, rejected, fullCatalogsAccepted: 0 as const, effectiveArgumentScopesAccepted: 0 as const };
}
