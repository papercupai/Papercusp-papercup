import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
// The project mutation runner supplies a copy-out subject. Reading it explicitly
// keeps the tracked checkout clean and makes the same fixtures judge the mutant
// rather than a sibling import resolving back to the original implementation.
const SCRIPT = process.env.PROBE_SCRIPT
  ? resolve(process.env.PROBE_SCRIPT)
  : join(dirname(fileURLToPath(import.meta.url)), 'measure-tool-output.mjs');
// A runtime-path import is untyped (`any`); the swapped probe script must honour the same surface as
// the canonical module, so type it as that module rather than losing every downstream type.
type MeasureToolOutputModule = typeof import('./measure-tool-output.mjs');
const { capFor, contentBytes, measure, compareMeasurementWindows, renderMeasurementComparison, verifyMeasurementReportReadback } =
  await import(pathToFileURL(SCRIPT).href) as MeasureToolOutputModule;
const NOW = Date.parse('2026-10-15T09:00:00Z');
const START = NOW - 24 * 3600_000;
const base = NOW - 600_000;
const time = (seconds = 0) => new Date(base + seconds * 1000).toISOString();
const byte = (s: string) => Buffer.byteLength(s);
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture(claude: unknown[] = [], codex: unknown[] = []) {
  const home = mkdtempSync(join(tmpdir(), 'tool-output-measure-'));
  homes.push(home);
  for (const client of ['claude', 'codex']) mkdirSync(join(home, client));
  const roots = [{ client: 'claude', path: join(home, 'claude') }, { client: 'codex', path: join(home, 'codex') }];
  const claudeFile = join(roots[0].path, 'session.jsonl');
  const codexFile = join(roots[1].path, 'rollout-fixture.jsonl');
  const save = (file: string, rows: unknown[]) => writeFileSync(file, rows.map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  save(claudeFile, claude); save(codexFile, codex);
  return { home, roots, claudeFile, codexFile };
}
const assistant = (id: string, seconds: number, blocks: unknown[] = []) => ({ timestamp: time(seconds), type: 'assistant', message: { id, content: blocks } });
const use = (id: string, name = 'Bash', input: Record<string, unknown> = { command: 'cat file' }) => ({ type: 'tool_use', id, name, input });
const result = (id: string, content: unknown, seconds: number) => ({
  timestamp: time(seconds), type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const call = (id: string, name: string, input: unknown, seconds: number) => ({
  timestamp: time(seconds), type: 'response_item', payload: { type: name === 'exec' ? 'custom_tool_call' : 'function_call', call_id: id, name,
    ...(name === 'exec' ? { input } : { arguments: JSON.stringify(input) }) },
});
const output = (id: string, body: unknown, seconds: number, custom = false) => ({
  timestamp: time(seconds), type: 'response_item', payload: { type: custom ? 'custom_tool_call_output' : 'function_call_output', call_id: id, output: body },
});
const usage = (n: number, seconds: number) => ({
  timestamp: time(seconds), type: 'event_msg', payload: { type: 'token_count',
    info: { last_token_usage: { input_tokens: 100, output_tokens: 10 }, total_token_usage: { input_tokens: n * 100, output_tokens: n * 10 } } },
});
const run = (f: ReturnType<typeof fixture>, extra = {}) => measure(f.roots, 24, { now: NOW, ...extra });

describe('measurement acceptance comparison (R5/R7)', () => {
  const refs = { beforeRef: 'raw-before.json', afterRef: 'raw-after.json',
    patternFixes: [{ workItem: 'WI-123', regressionReceipt: 'test_runs:456', status: 'verified' }] };
  async function pairedWindows() {
    const raw = (calls: number) => [
      { timestamp: time(0), type: 'session_meta', payload: { id: 'matched-native' } },
      { timestamp: time(0), type: 'response_item', payload: { type: 'message', role: 'user',
        content: [{ type: 'input_text', text: '⟦turn-origin:loop-fire nonce:abcdef12⟧ matched wake' }] } },
      call('read', 'exec_command', { cmd: 'cat one' }, 0), output('read', 'é🙂', 1),
      ...Array.from({ length: calls }, (_, i) => usage(i + 1, i + 2)),
    ];
    const previous = fixture([], raw(3));
    const following = fixture([], raw(2).map((row) => ({ ...row, timestamp: new Date(Date.parse(row.timestamp) + 86400_000).toISOString() })));
    const sessionMetadata = [{ nativeSessionId: 'matched-native', role: 'su', ownerId: 'owner', source: 'fixture-ledger' }];
    return { before: await run(previous, { sessionMetadata }),
      after: await run(following, { now: NOW + 86400_000, sessionMetadata }), home: following.home };
  }

  it('accepts measured per-session reduction from two real raw-parser windows and named regression receipts', async () => {
    const { before, after } = await pairedWindows();
    const compared = compareMeasurementWindows(before, after, refs);
    expect(compared.errors).toEqual([]);
    expect(compared.mismatches).toEqual([]);
    expect(compared.reductionSatisfied).toBe(true);
    expect(compared.clients.find((row: { client: string }) => row.client === 'codex')).toMatchObject({
      before: { bytes: 6, modelCalls: 3, sessions: 1, callsPerSession: 3 },
      after: { bytes: 6, modelCalls: 2, sessions: 1, callsPerSession: 2 },
    });
    const noDecrease = structuredClone(after);
    noDecrease.clients.codex.modelCalls = 3;
    noDecrease.drivers.sessions[0].modelCalls = 3;
    expect(compareMeasurementWindows(before, noDecrease, refs).reductionSatisfied).toBe(false);
    expect(compareMeasurementWindows(before, after, { ...refs, patternFixes: [] }).reductionSatisfied).toBe(false);
    expect(compareMeasurementWindows(before, after, { ...refs, patternFixes: [{ ...refs.patternFixes[0], status: 'planned' }] }).reductionSatisfied).toBe(false);
  });

  it.each(['role', 'wakeSource', 'waitCalls', 'durationBand'])('rejects missing %s attribution instead of inferring a reduction', async (field) => {
    const { before, after } = await pairedWindows();
    delete after.drivers.sessions[0][field];
    const compared = compareMeasurementWindows(before, after, refs);
    expect(compared.errors).toContain('after: role/wake/polling/duration attribution missing');
    expect(compared.reductionSatisfied).toBe(false);
  });

  it('rejects mismatched methods, windows, denominators and missing raw evidence', async () => {
    const { before, after } = await pairedWindows();
    for (const change of [
      (r: typeof after) => { r.window.start = new Date(Date.parse(r.window.start) + 1000).toISOString(); },
      (r: typeof after) => { r.drivers.sessions[0].role = 'worker'; },
      (r: typeof after) => { r.method.requests = 'changed request definition'; },
      (r: typeof after) => { r.clients.codex.modelCalls += 1; },
      (r: typeof after) => { delete (r as { sourceCoverage?: unknown }).sourceCoverage; },
    ]) {
      const altered = structuredClone(after);
      change(altered);
      expect(compareMeasurementWindows(before, altered, refs).reductionSatisfied).toBe(false);
    }
    expect(compareMeasurementWindows(before, after, { ...refs, beforeRef: '' }).reportReady).toBe(false);
  });

  it('requires every requested measure and actual owner-visible reports:get content before R7 is satisfied', async () => {
    const { before, after } = await pairedWindows();
    const compared = compareMeasurementWindows(before, after, refs);
    const body_md = renderMeasurementComparison(compared);
    const readback = { results: [{ id: 'report-1', ok: true, report: { visibility: 'owner', body_md } }] };
    expect(verifyMeasurementReportReadback(compared, readback, 'report-1')).toBe(true);
    for (const metric of ['bytes', 'rereadBytes', 'modelCalls']) {
      const altered = structuredClone(after);
      delete (altered.clients.codex as Record<string, unknown>)[metric];
      const missing = compareMeasurementWindows(before, altered, refs);
      expect(missing.reportReady).toBe(false);
      expect(() => renderMeasurementComparison(missing)).toThrow('Incomplete');
    }
    expect(verifyMeasurementReportReadback(compared, { report_id: 'report-1' }, 'report-1')).toBe(false);
    expect(verifyMeasurementReportReadback(compared, readback, 'another-report')).toBe(false);
    for (const report of [{ visibility: 'owner', body_md: body_md.replace('Re-read bytes', 'Omitted') },
      { visibility: 'pot', body_md }, { visibility: 'owner', body_md: body_md.slice(0, -1) }]) {
      expect(verifyMeasurementReportReadback(compared, { results: [{ id: 'report-1', ok: true, report }] }, 'report-1')).toBe(false);
    }
  });

  it('allows disclosed noncomparability in a report but never in a reduction claim', async () => {
    const { before, after } = await pairedWindows();
    after.drivers.sessions[0].role = 'worker';
    expect(compareMeasurementWindows(before, after, refs).reportReady).toBe(false);
    const disclosed = compareMeasurementWindows(before, after, { ...refs, disclosure: 'Roles differ; no causal reduction claim.' });
    expect(disclosed.reportReady).toBe(true);
    expect(disclosed.reductionSatisfied).toBe(false);
    expect(renderMeasurementComparison(disclosed)).toContain('Roles differ; no causal reduction claim.');
  });

  it('rejects unmarked wake attribution and retains both methods and every client in a readable disclosed report', async () => {
    const { before, after } = await pairedWindows();
    const unmarked = structuredClone(after);
    unmarked.drivers.sessions[0].wakeSource = 'unmarked';
    expect(compareMeasurementWindows(before, unmarked, refs).reductionSatisfied).toBe(false);
    const mixed = structuredClone(after);
    mixed.drivers.sessions[0].wakeSource = 'mixed';
    mixed.drivers.sessions[0].callsByOrigin.unmarked = 1;
    expect(compareMeasurementWindows(before, mixed, refs).reductionSatisfied).toBe(false);

    // A new client is a disclosed population change, never zero measured traffic.
    delete before.clients.claude;
    after.method.requests = 'A different request definition';
    const compared = compareMeasurementWindows(before, after, { ...refs, disclosure: 'Client population and definitions differ.' });
    expect(compared.reportReady).toBe(true);
    expect(compared.reductionSatisfied).toBe(false);
    const markdown = renderMeasurementComparison(compared);
    expect(markdown).toContain('A different request definition');
    expect(markdown).toContain(before.method.requests);
    expect(markdown).toMatch(/\| --- \| --- \| --- \| --- \| --- \| --- \|\n\| claude \| null → 0/);
    expect(markdown).toMatch(/\| claude [^\n]+\n\| codex /);
  });

  it('runs comparison through the maintained CLI and refuses R7 before verified readback', async () => {
    const { before, after, home } = await pairedWindows();
    const beforeRef = join(home, 'before.json'), afterRef = join(home, 'after.json'), manifest = join(home, 'comparison.json');
    writeFileSync(beforeRef, JSON.stringify(before)); writeFileSync(afterRef, JSON.stringify(after));
    const options = { ...refs, beforeRef, afterRef, acceptance: 'r-5' };
    writeFileSync(manifest, JSON.stringify(options));
    const result = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--comparison', manifest], { encoding: 'utf8' }));
    expect(result.reductionSatisfied).toBe(true);
    expect(result.reportReadbackSatisfied).toBe(false);
    writeFileSync(manifest, JSON.stringify({ ...options, acceptance: 'r-7' }));
    expect(() => execFileSync(process.execPath, [SCRIPT, '--comparison', manifest], { stdio: 'pipe' })).toThrow();
    const readbackRef = join(home, 'readback.json');
    writeFileSync(readbackRef, JSON.stringify({ results: [{ id: 'report-1', ok: true, report: { visibility: 'owner', body_md: result.body_md } }] }));
    writeFileSync(manifest, JSON.stringify({ ...options, acceptance: 'r-7', readbackRef, reportId: 'report-1' }));
    expect(JSON.parse(execFileSync(process.execPath, [SCRIPT, '--comparison', manifest], { encoding: 'utf8' })).reportReadbackSatisfied).toBe(true);
  });

  it('discloses parser and identity gaps while refusing to infer savings from incomplete counts', async () => {
    const { before, after } = await pairedWindows();
    for (const key of ['parseErrors', 'requestsWithoutTimestamp', 'requestsWithoutIdentity', 'resultsWithoutTimestamp', 'unmatchedResults']) {
      const altered = structuredClone(after);
      (altered.sourceCoverage as Record<string, unknown>)[key] = 1;
      const compared = compareMeasurementWindows(before, altered, { ...refs, disclosure: 'Source coverage is incomplete.' });
      expect(compared.reductionSatisfied).toBe(false);
      expect(compared.reportReady).toBe(true);
      expect(renderMeasurementComparison(compared)).toContain(`"${key}":1`);
      delete (altered.sourceCoverage as Record<string, unknown>)[key];
      expect(compareMeasurementWindows(before, altered, refs).reportReady).toBe(false);
    }
  });
});

describe('measure-tool-output raw transcript instrument', () => {
  it('TE-MEASURE-COUNTS / BYTES: exact UTF-8 result counts and byte percentiles per client and tool', async () => {
    const texts = ['a', 'é', '漢', '🙂'];
    const f = fixture([
      assistant('m1', 0, texts.map((_, i) => use('c' + i, i === 3 ? 'Read' : 'Bash'))),
      ...texts.map((s, i) => result('c' + i, [{ type: 'text', text: s }], 1)),
    ], [
      call('x1', 'exec_command', { cmd: 'cat one' }, 0), output('x1', 'é🙂', 1),
      call('x2', 'exec', 'text(1)', 2), output('x2', [{ type: 'text', text: 'xy' }], 3, true),
    ]);
    const r = await run(f);
    expect(r.clients.claude.results).toBe(4);
    expect(r.clients.claude.bytes).toBe(10);
    expect(r.clients.claude.size).toEqual({ count: 4, p50: 3, p90: 4, p95: 4, p99: 4, max: 4 });
    expect(r.clients.claude.tools.find((x) => x.tool === 'Bash')).toMatchObject({
      results: 3, bytes: 6, size: { p50: 2, p95: 3 },
    });
    expect(r.clients.claude.tools.find((x) => x.tool === 'Read')).toMatchObject({ results: 1, bytes: 4 });
    expect(r.clients.codex.results).toBe(2);
    expect(r.clients.codex.bytes).toBe(8);
    expect(r.clients.codex.tools.map((x) => x.tool)).toEqual(['code-mode-exec', 'exec_command']);
    expect(r.results).toBe(6);
    expect(r.bytes).toBe(18);
    expect(contentBytes([{ type: 'text', text: 'é' }, { type: 'image', source: { data: 'x' } }]))
      .toBe(2 + byte(JSON.stringify({ type: 'image', source: { data: 'x' } })));
  });

  it('TE-MEASURE-REREAD: later model responses, not tool count, determine replay bytes', async () => {
    const f = fixture([
      assistant('m1', 0, [use('a'), use('b', 'Read')]),
      assistant('m1', .1, [{ type: 'thinking', thinking: 'streamed block' }]),
      result('a', 'é', 1), result('b', 'abc', 1),
      assistant('m2', 2), assistant('m3', 3),
      { timestamp: time(4), type: 'system', subtype: 'compact_boundary' },
      assistant('m4', 5),
    ], [
      usage(1, 0), call('c1', 'exec_command', { cmd: 'cat' }, 1), output('c1', '1234', 2),
      usage(2, 3), usage(2, 3.1), // repeated usage notification
      { timestamp: time(3.2), type: 'event_msg', payload: { type: 'token_count', info: null } },
      usage(3, 4), { timestamp: time(5), type: 'compacted' }, usage(1, 6),
    ]);
    const r = await run(f);
    expect(r.clients.claude.rereadBytes).toBe((2 + 3) * 2);
    expect(r.clients.claude.modelCalls).toBe(4);
    expect(r.clients.codex.rereadBytes).toBe(4 * 2);
    expect(r.clients.codex.modelCalls).toBe(4);
    expect(r.rereadBytes).toBe(18);
    // Spread in from scan()'s coverage counters, which the inferred declaration cannot see.
    expect((r.sourceCoverage as Record<string, unknown>).duplicateRequests).toBe(2);
    expect((r.sourceCoverage as Record<string, unknown>).nativeCompactions).toBe(2);
  });

  it('TE-MEASURE-CAPS: distinguishes outer exec, nested shell, and door, including overlapping caps', async () => {
    const nested = JSON.stringify({ chunk_id: 'x', original_token_count: 5000, output: 'Warning: truncated output (original token count: 5000)\nabc' });
    const outer = 'Script completed\nWall time 1.0 seconds\nOutput:\nWarning: truncated output (original token count: 8000)\n' + nested;
    const door = JSON.stringify({ answer: 'kept', _projection: { kind: 'bounded-payload', truncated: true } });
    expect(capFor('codex', 'code-mode-exec', outer)).toEqual(['codex-outer-exec', 'nested-shell']);
    expect(capFor('codex', 'code-mode-exec', 'Script completed\nWall time 1.0 seconds\nOutput:\n' + nested)).toEqual(['nested-shell']);
    expect(capFor('claude', 'mcp__x', door)).toEqual(['papercusp-door']);
    expect(capFor('codex', 'code-mode-exec', [{ type: 'text', text: door }])).toEqual(['papercusp-door']);
    expect(capFor('claude', 'mcp__x', '[projection: pick results[].id → 75% saved]')).toEqual([]);
    expect(capFor('codex', 'code-mode-exec', 'The code checks for tokens truncated.')).toEqual([]);
    const f = fixture([assistant('m1', 0, [use('a', 'mcp__x')]), result('a', door, 1)], [
      call('c1', 'exec', 'text(await tools.exec_command({cmd:"cat"}))', 0), output('c1', outer, 1, true),
    ]);
    const r = await run(f);
    expect(r.truncation.results).toBe(2);
    expect(r.truncation.byCap['codex-outer-exec'].results).toBe(1);
    expect(r.truncation.byCap['nested-shell'].results).toBe(1);
    expect(r.truncation.byCap['papercusp-door'].results).toBe(1);
    expect(r.clients.codex.tools[0].truncation.byCap['nested-shell'].shareOfResults).toBe(1);
  });

  it('TE-MEASURE-RERUN: only the same invocation inside the declared short window, with actual repeat bytes', async () => {
    const cut = 'kept\n[result-door: spilled]';
    const f = fixture([
      assistant('m1', 0, [use('a')]), result('a', cut, 1),
      assistant('m2', 2, [use('unrelated', 'Bash', { command: 'cat other-file' })]),
      result('unrelated', 'other', 3),
      assistant('m3', 121, [use('retry')]), result('retry', 'new output!', 122), // exactly 120s
      assistant('m4', 130, [use('b', 'Read')]), result('b', cut, 131),
      assistant('m5', 252, [use('too-late', 'Read')]), result('too-late', 'late', 253),
    ], [
      call('c1', 'exec_command', { cmd: 'cat', max_output_tokens: 10 }, 0),
      output('c1', 'Warning: truncated output (original token count: 100)', 1),
      call('c2', 'exec_command', { cmd: 'cat', max_output_tokens: 100 }, 2), output('c2', '🙂', 3),
    ]);
    const r = await run(f);
    expect(r.rerunWindowSeconds).toBe(120);
    expect(r.clients.claude.reruns).toEqual({ callsAfterTruncation: 1, bytesAfterTruncation: 11 });
    expect(r.clients.codex.reruns).toEqual({ callsAfterTruncation: 1, bytesAfterTruncation: 4 });
    expect(r.clients.claude.tools.find((x) => x.tool === 'Read')!.reruns.callsAfterTruncation).toBe(0);
    expect(r.truncation.byCap['papercusp-door'].reruns).toBe(1);
  });

  it('TE-MEASURE-BASELINE: bounds results by record time, resolves old calls, excludes unknown/future times and dedupes raw paths/results', async () => {
    const oldCall = assistant('old', 0, [use('a')]);
    oldCall.timestamp = new Date(START - 1000).toISOString();
    const boundary = result('a', 'in', 0); boundary.timestamp = new Date(START).toISOString();
    const old = result('b', 'old', 0); old.timestamp = new Date(START - 1).toISOString();
    const future = result('c', 'future', 0); future.timestamp = new Date(NOW + 1).toISOString();
    const { timestamp: _withoutTimestamp, ...unknown } = result('d', 'unknown', 0);
    const f = fixture([oldCall, boundary, boundary, old, future, unknown, '{bad json']);
    const r = await measure([...f.roots, f.roots[0]], 24, { now: NOW });
    expect(r.measuredAt).toBe(new Date(NOW).toISOString());
    expect(r.window).toEqual({ start: new Date(START).toISOString(), end: new Date(NOW).toISOString() });
    expect(r.clients.claude.tools[0]).toMatchObject({ tool: 'Bash', results: 1, bytes: 2 });
    expect(r.sourceCoverage).toMatchObject({ parseErrors: 1, duplicateResults: 1, resultsWithoutTimestamp: 1, futureResults: 1 });
    expect(r.sourceCoverage.diagnostics.duplicatePaths).toBe(1);
  });

  it('reports unavailable roots, stale-file discovery omissions and empty populations explicitly', async () => {
    const f = fixture();
    utimesSync(f.claudeFile, new Date(START - 1000), new Date(START - 1000));
    const r = await measure([...f.roots, { client: 'claude', path: join(f.home, 'missing') }], 24, { now: NOW });
    expect(r.sourceCoverage.roots.find((x) => x.path.endsWith('/missing'))).toMatchObject({ status: 'unavailable', errors: 1 });
    expect(r.sourceCoverage.roots[0].skippedBeforeWindow).toBe(1);
    expect(r.clients.claude.size).toEqual({ count: 0, p50: 0, p90: 0, p95: 0, p99: 0, max: 0 });
    expect(r.rereadBytes).toBe(0);
  });

  it('TE-DIAGNOSE-COHORTS: reconciles roles, stamped wakes, polling and observed durations to native sessions', async () => {
    const prompt = (text: string, seconds: number) => ({ timestamp: time(seconds), type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    const f = fixture([
      { timestamp: time(0), type: 'user', sessionId: 'claude-native', message: { content: 'quoted ⟦turn-origin:loop-fire nonce:fake⟧' } },
      assistant('m1', 1, [use('read1', 'Read', { file_path: '/one' })]),
      result('read1', 'one', 2),
      assistant('m2', 3, [use('read2', 'Read', { file_path: '/one' })]),
      result('read2', 'one', 4),
    ], [
      { timestamp: time(0), type: 'session_meta', payload: { id: 'codex-native' } },
      prompt('<pasted_content id="a1">\n⟦turn-origin:loop-fire nonce:abcdef12⟧ wake\n</pasted_content id="a1">', 0),
      { timestamp: time(0), type: 'event_msg', payload: { type: 'user_message', message: 'duplicate prompt' } },
      usage(1, 1), usage(1, 1.1), call('w1', 'wait', { cell_id: 'x' }, 2), output('w1', 'still running', 3),
      usage(2, 4), call('w2', 'write_stdin', { session_id: 1, yield_time_ms: 1000 }, 5), output('w2', 'done', 6),
      prompt('owner text', 7), usage(3, 8), call('x', 'exec', 'await tools.read_file({path:"one"})', 9),
      output('x', 'opaque', 10, true),
    ]);
    const r = await run(f, { sessionMetadata: [
      { nativeSessionId: 'claude-native', role: 'su', ownerId: 'c', source: 'adv_sessions' },
      { nativeSessionId: 'codex-native', role: 'worker', ownerId: 'x', source: 'identity-ledger' },
      // Several historical phases corroborate one identity; they are not sessions.
      { nativeSessionId: 'codex-native', role: 'worker', ownerId: 'x', source: 'identity-ledger' },
    ] });
    expect(r.drivers.coverage).toMatchObject({ activeFiles: 2, includedSessions: 2, unknownIdentitySessions: 0 });
    expect(r.drivers.byRole.map((c) => [c.client, c.cohort, c.sessions, c.modelCalls])).toEqual([
      ['claude', 'su', 1, 2], ['codex', 'worker', 1, 3],
    ]);
    const codex = r.drivers.sessions.find((s) => s.client === 'codex');
    expect(codex).toMatchObject({ role: 'worker', observedSeconds: 10, durationBand: '<5m', wakeSource: 'mixed',
      callsByOrigin: { 'loop-fire': 2, unmarked: 1 }, turnsByOrigin: { 'loop-fire': 1, unmarked: 1 },
      toolCalls: 3, waitCalls: 2, shortWaitCalls: 1, waitYieldMilliseconds: { unspecified: 1, '<=1000': 1 }, readCalls: 0, opaqueExecCalls: 1 });
    expect(r.drivers.sessions.find((s) => s.client === 'claude')).toMatchObject({
      role: 'su', wakeSource: 'unmarked', readCalls: 2, repeatedReadCalls: 1, turnsByOrigin: { unmarked: 1 },
    });
    expect(r.drivers.byOwner).toEqual([
      { client: 'claude', ownerId: 'c', nativeSessions: 1, modelCalls: 2 },
      { client: 'codex', ownerId: 'x', nativeSessions: 1, modelCalls: 3 },
    ]);
    expect(r.drivers.byRoleWakeDuration.reduce((n, c) => n + c.modelCalls, 0)).toBe(5);
    for (const cohort of [r.drivers.byRole, r.drivers.byWakeSource, r.drivers.byDuration]) {
      expect(cohort.reduce((n, c) => n + c.modelCalls, 0)).toBe(5);
      expect(cohort.reduce((n, c) => n + c.sessions, 0)).toBe(2);
    }
  });

  it('TE-DIAGNOSE-COHORTS: preserves unknown/conflicting roles and excludes duplicate native files', async () => {
    const f = fixture([assistant('m1', 0)], [
      { timestamp: time(0), type: 'session_meta', payload: { id: 'native' } }, usage(1, 1),
    ]);
    const metadata = [
      { nativeSessionId: 'native', role: 'su', ownerId: 'a' },
      { nativeSessionId: 'native', role: 'worker', ownerId: 'b' },
    ];
    const r = await run(f, { sessionMetadata: metadata });
    expect(r.drivers.coverage).toMatchObject({ unknownIdentitySessions: 1, ambiguousIdentitySessions: 1 });
    expect(r.drivers.sessions.find((s) => s.client === 'codex').role).toBe('ambiguous');
    writeFileSync(join(f.roots[1].path, 'rollout-copy.jsonl'), readFileSync(f.codexFile));
    const copies = await run(f, { sessionMetadata: metadata });
    expect(copies.clients.codex.modelCalls).toBe(2); // file observations retained
    expect(copies.drivers.coverage).toMatchObject({ activeFiles: 3, includedSessions: 1,
      duplicateNativeFiles: [{ nativeSessionId: 'native', excludedModelCalls: 2 }] });
    expect(copies.drivers.sessions).toHaveLength(1);
  });

  it('TE-DIAGNOSE-PATTERN: repeated reads reset at compaction and do not count unseen exec bodies or out-of-window calls', async () => {
    const f = fixture([
      assistant('m1', 0, [use('r1', 'Read', { file_path: '/one' })]),
      assistant('m2', 1, [use('r2', 'Read', { file_path: '/two' })]),
      assistant('m3', 2, [use('r3', 'Read', { file_path: '/one' })]),
      { timestamp: time(3), type: 'system', subtype: 'compact_boundary' },
      assistant('m4', 4, [use('r4', 'Read', { file_path: '/one' })]),
      { ...assistant('future', 5, [use('r5', 'Read', { file_path: '/one' })]), timestamp: new Date(NOW + 1).toISOString() },
    ]);
    const r = await run(f);
    expect(r.drivers.sessions[0]).toMatchObject({ toolCalls: 4, readCalls: 4, repeatedReadCalls: 1, observedSeconds: 4 });
  });

  it('TE-DIAGNOSE-PATTERN: distinguishes repeated no-change waits from progressing output and resets at compaction', async () => {
    const f = fixture([], [usage(1, 0),
      call('w1', 'wait', { cell_id: 'x', yield_time_ms: 1000 }, 1), output('w1', 'running', 2),
      call('w2', 'wait', { cell_id: 'x', yield_time_ms: 500 }, 3), output('w2', 'running', 4),
      call('w3', 'wait', { cell_id: 'x', yield_time_ms: 30000 }, 5), output('w3', 'more output', 6),
      { timestamp: time(7), type: 'compacted' },
      call('w4', 'wait', { cell_id: 'x', yield_time_ms: 30000 }, 8), output('w4', 'more output', 9),
    ]);
    const r = await run(f);
    expect(r.drivers.sessions[0]).toMatchObject({ waitCalls: 4, shortWaitCalls: 2, repeatedWaitCalls: 2,
      unchangedWaitResults: 1, waitYieldMilliseconds: { '<=1000': 2, '>10000': 2 } });
  });

  it('TE-DIAGNOSE-COHORTS: replays frozen file sizes/window and exposes missing or shortened source coverage', async () => {
    const f = fixture([assistant('m1', 0)], [usage(1, 0)]);
    const baseline = await run(f);
    writeFileSync(f.codexFile, readFileSync(f.codexFile, 'utf8') + JSON.stringify(usage(2, 1)) + '\n');
    const frozen = await measure([], 1, { now: NOW + 3600_000, snapshot: baseline });
    expect(frozen.window).toEqual(baseline.window);
    expect(frozen.clients.codex.modelCalls).toBe(1);
    expect((await run(f)).clients.codex.modelCalls).toBe(2);
    expect(frozen.sourceCoverage.files.find((s) => s.client === 'codex')!.snapshotBytes)
      .toBe(baseline.sourceCoverage.files.find((s) => s.client === 'codex')!.snapshotBytes);
    writeFileSync(f.codexFile, '');
    rmSync(f.claudeFile);
    const missing = await measure([], 24, { snapshot: baseline });
    expect(missing.drivers.coverage.includedSessions).toBe(0);
    expect(missing.sourceCoverage.diagnostics).toMatchObject({ unreadablePaths: 2, shortenedSnapshots: 1 });
    expect(missing.sourceCoverage.unavailableFiles).toHaveLength(2);
  });

  it('CLI persists the dated 24h baseline with a named source window and validates options', async () => {
    const f = fixture(), out = join(f.home, 'baseline.json');
    const stdout = execFileSync(process.execPath, [SCRIPT, '--since', '24h', '--claude-root', f.roots[0].path, '--codex-root', f.roots[1].path, '--out', out], { encoding: 'utf8' });
    const persisted = JSON.parse(readFileSync(out, 'utf8'));
    expect(persisted).toEqual(JSON.parse(stdout));
    expect(persisted.windowHours).toBe(24);
    expect(Date.parse(persisted.window.end) - Date.parse(persisted.window.start)).toBe(24 * 3600_000);
    expect(persisted.sourceCoverage.roots).toHaveLength(2);
    expect(persisted.method.bytes).toContain('No tokenizer ran');
    const snapshot = join(f.home, 'frozen.json'), metadata = join(f.home, 'roles.json');
    writeFileSync(snapshot, JSON.stringify(persisted));
    writeFileSync(metadata, JSON.stringify({ capturedAt: time(), source: 'fixture', sessions: [] }));
    const replay = JSON.parse(execFileSync(process.execPath, [SCRIPT, '--snapshot', snapshot, '--metadata', metadata], { encoding: 'utf8' }));
    expect(replay.window).toEqual(persisted.window);
    expect(replay.metadataCoverage).toEqual({ capturedAt: time(), source: 'fixture', rows: 0 });
    // Deliberately invalid input: exercises the runtime array guard, so the type is bypassed.
    await expect(measure(f.roots, 24, { sessionMetadata: {} as unknown as unknown[] })).rejects.toThrow('sessionMetadata must be an array');
    expect(() => execFileSync(process.execPath, [SCRIPT, '--out'], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync(process.execPath, [SCRIPT, '--hours', '-1'], { stdio: 'pipe' })).toThrow();
  });
});
