import { describe, expect, it } from 'vitest';
import { extractIdopP001NativeFragments, nativeFragmentHash, type NativeFragmentSource } from './idop-p001-native-fragments';

const nativeSessionId = 'fixture-native-session';
const ownerId = 'su-fixture-source';
const catalog = () => ({ callerRole: 'operator', isSuperuser: true, count: 500, _partial: true,
  tools: [{ name: 'fixture:read', capability: 'fixture:read', allowed: false, description: 'retained text…' }],
  _projection: { truncated: true, arrayTruncations: [{ path: '$.tools', shownCount: 1, renderedCount: 151, omittedCount: 150 }] } });
function fixture() {
  const command = "ptool agent_tools:list --json - <<'JSON'\n{\"limit\":500}\nJSON";
  const input = `const r = await tools.exec_command({ cmd: ${JSON.stringify(command)}, workdir: "/fixture", yield_time_ms: 30000, max_output_tokens: 10000 });\ntext(JSON.stringify(r));\n`;
  const output = `ptool: connection trace ${JSON.stringify({ clientId: ownerId, toolName: 'agent_tools:list' })}\n${JSON.stringify(catalog())}\n`;
  return [
    { type: 'session_meta', payload: { id: nativeSessionId, session_id: nativeSessionId } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call-fixture', input } },
    { type: 'response_item', timestamp: '2026-10-22T16:12:00.039Z', payload: { type: 'custom_tool_call_output', call_id: 'call-fixture',
      output: [{ type: 'input_text', text: JSON.stringify({ exit_code: 0, output }) }] } },
  ];
}
type Fixture = ReturnType<typeof fixture>;
const bytesFor = (rows: Fixture) => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
function inspect(rows = fixture(), override: Partial<NativeFragmentSource> = {}) {
  const bytes = bytesFor(rows);
  return extractIdopP001NativeFragments(bytes, { nativeSessionId, ownerId, nativeSha256: nativeFragmentHash(bytes), ...override });
}
function mutateEnvelope(rows: Fixture, change: (envelope: { exit_code: number; output: string; session_id?: number }) => void) {
  const blocks = rows[2].payload.output!;
  const envelope = JSON.parse(blocks[0].text);
  change(envelope);
  blocks[0].text = JSON.stringify(envelope);
}
function mutateCatalog(rows: Fixture, change: (value: ReturnType<typeof catalog>) => void) {
  mutateEnvelope(rows, envelope => {
    const value = catalog(); change(value);
    envelope.output = envelope.output.split('\n').slice(0, 1).join('\n') + '\n' + JSON.stringify(value) + '\n';
  });
}

describe('P001 authenticated retained native catalog fragments', () => {
  it('retains exact annotations, caller fields and partial counts without granting full coverage', () => {
    const result = inspect();
    expect(result.rejected).toEqual([]);
    expect(result.fragments).toHaveLength(1);
    expect(result.fragments[0]).toMatchObject({ sourceNative: nativeSessionId, sourceOwner: ownerId, line: 3,
      declaredCount: 500, partial: true, projectionTruncated: true, projectionRenderedCount: 151,
      callerRole: 'operator', isSuperuser: true, tools: [{ allowed: false, retainedDescriptionSha256: nativeFragmentHash('retained text…') }] });
    expect(result.fullCatalogsAccepted).toBe(0);
    expect(result.effectiveArgumentScopesAccepted).toBe(0);
    expect(result.fragments[0].recordSha256).toBe(nativeFragmentHash(bytesFor(fixture()).toString().split('\n')[2] + '\n'));
    expect(result.fragments[0].priorCallLine).toBe(2);
    expect(result.fragments[0].priorCallHashIncludesLineTerminator).toBe(true);
    expect(result.fragments[0].priorCallRecordSha256).toBe(nativeFragmentHash(bytesFor(fixture()).toString().split('\n')[1] + '\n'));
  });
  it('rejects different native bytes before parsing', () => expect(() => inspect(fixture(), { nativeSha256: '0'.repeat(64) })).toThrow('digest mismatch'));
  it('accepts the compact whitespace variant of the recorded wrapper', () => {
    const rows = fixture();
    rows[1].payload.input = rows[1].payload.input!.replaceAll(': ', ':');
    expect(inspect(rows).fragments).toHaveLength(1);
  });
  it('rejects a substituted native session even with a recalculated digest', () => expect(() => inspect(fixture(), { nativeSessionId: 'other' })).toThrow('session mismatch'));
  it('rejects a substituted owner even with intact catalog JSON', () => expect(inspect(fixture(), { ownerId: 'su-other' }).rejected[0].reason).toContain('attribution mismatch'));
  it.each([
    ['duplicate input', (rows: Fixture) => rows.splice(2, 0, rows[1]), 'call pair'],
    ['duplicate output', (rows: Fixture) => rows.push(rows[2]), 'duplicate call output'],
    ['out-of-order input', (rows: Fixture) => rows.reverse(), 'call pair'],
    ['mismatched output', (rows: Fixture) => { rows[2].payload.call_id = 'different'; }, null],
    ['unevaluated command mention', (rows: Fixture) => { rows[1].payload.input = `if (false) { ${rows[1].payload.input} }`; }, 'unsupported catalog invocation'],
    ['different shell tool', (rows: Fixture) => { rows[1].payload.input = rows[1].payload.input!.replace('ptool agent_tools:list', 'echo agent_tools:list'); }, null],
    ['failed shell', (rows: Fixture) => mutateEnvelope(rows, e => { e.exit_code = 1; }), 'finish successfully'],
    ['yielded shell', (rows: Fixture) => mutateEnvelope(rows, e => { e.session_id = 12; }), 'finish successfully'],
    ['incomplete JSON', (rows: Fixture) => mutateEnvelope(rows, e => { e.output = e.output.trimEnd().slice(0, -1); }), 'JSON'],
    ['duplicate JSON line', (rows: Fixture) => mutateEnvelope(rows, e => { e.output += JSON.stringify(catalog()); }), 'ambiguous catalog'],
    ['missing projection', (rows: Fixture) => mutateCatalog(rows, c => { c._projection.truncated = false; }), 'explicit partial'],
    ['inflated retained count', (rows: Fixture) => mutateCatalog(rows, c => { c._projection.arrayTruncations[0].shownCount = 500; }), 'projection counts'],
    ['inconsistent omitted count', (rows: Fixture) => mutateCatalog(rows, c => { c._projection.arrayTruncations[0].omittedCount = 0; }), 'projection counts'],
    ['different requested count', (rows: Fixture) => mutateCatalog(rows, c => { c.count = 501; }), 'catalog header'],
    ['duplicate annotation', (rows: Fixture) => mutateCatalog(rows, c => { c.tools.push(c.tools[0]); c._projection.arrayTruncations[0].shownCount = 2; c._projection.arrayTruncations[0].omittedCount = 149; }), 'annotation row'],
    ['invalid permission', (rows: Fixture) => mutateCatalog(rows, c => { Object.assign(c.tools[0], { allowed: 'true' }); }), 'annotation row'],
  ] as const)('refuses %s', (_name, change, reason) => {
    const rows = fixture(); change(rows);
    const result = inspect(rows);
    expect(result.fragments).toEqual([]);
    if (reason) expect(result.rejected.some(row => row.reason.includes(reason))).toBe(true);
  });
  it('ignores unrelated output rather than manufacturing a catalog', () => {
    const rows = fixture(); rows[1].payload.input = 'text("unrelated")';
    expect(inspect(rows)).toMatchObject({ fragments: [], rejected: [] });
  });
});
