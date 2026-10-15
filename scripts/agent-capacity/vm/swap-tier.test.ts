import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// swap-tier.py drives the WI-10005475 swap-tier test on a VM; swap-tier-stub-api.py answers the
// agents' model requests. These tests import both modules' pure parts through python3 (the files
// are hyphenated, so by path) and check the reply plan and the report reduction.
const HERE = dirname(fileURLToPath(import.meta.url));
const DRIVER = process.env.SWAP_TIER_PATH ?? join(HERE, 'swap-tier.py');
const STUB = process.env.SWAP_TIER_STUB_PATH ?? join(HERE, 'swap-tier-stub-api.py');

function py(module: string, expr: string, input: unknown): any {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("m", ${JSON.stringify(module)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'inp = json.loads(sys.stdin.read())',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  const r = spawnSync('python3', ['-c', code], { input: JSON.stringify(input), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

const plan = (messages: unknown[]) => py(STUB, 'list(m.plan_reply({"messages": inp}, ["/f0.py", "/f1.py"]))', messages);

describe('real Luna load and swap tuning', () => {
  it.each([[200, true], [429, true], [503, false]])('checks HTTP %s with catalog=%s', (status, catalog) => {
    const code = [
      'import importlib.util, json, threading, types',
      'from http.server import BaseHTTPRequestHandler, HTTPServer',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'headers={}; rows=[]; error=None',
      'class Handler(BaseHTTPRequestHandler):',
      ' def log_message(self, *args): pass',
      ' def do_GET(self):',
      '  headers.update({k.lower():v for k,v in self.headers.items()}); headers["path"]=self.path',
      `  self.send_response(${status}); self.end_headers(); self.wfile.write(b"{}")`,
      'server=HTTPServer(("127.0.0.1",0),Handler)',
      'thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()',
      `try: m.gateway_preflight(f"http://127.0.0.1:{server.server_port}/v1","benchmark-owner",types.SimpleNamespace(rec=lambda kind, **kw: rows.append({"kind":kind, **kw})),catalog=${catalog ? 'True' : 'False'})`,
      'except RuntimeError as e: error=str(e)',
      'finally: server.shutdown(); server.server_close(); thread.join()',
      'print(json.dumps({"headers":headers,"rows":rows,"error":error}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.headers).toMatchObject({
      path: catalog ? '/v1/models' : '/healthz', originator: 'codex_cli_rs',
      'x-papercusp-owner': 'benchmark-owner', authorization: 'Bearer papercusp-gateway',
    });
    const success = !catalog || status === 200;
    expect(receipt.rows).toEqual([expect.objectContaining({ kind: 'gateway-preflight', status, success })]);
    expect(receipt.error === null).toBe(success);
  });

  it('refuses another prompt batch after a previously healthy tunnel disappears', () => {
    const code = [
      'import importlib.util, json, socket, types',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'server=socket.socket(); server.bind(("127.0.0.1",0)); port=server.getsockname()[1]; server.close()',
      'rows=[]; typed=[]',
      'm.GATEWAY_CHECK=lambda: m.gateway_preflight(f"http://127.0.0.1:{port}/v1","benchmark-owner",types.SimpleNamespace(rec=lambda kind, **kw: rows.append({"kind":kind, **kw})))',
      'm.type_text=lambda *args: typed.append(args)',
      'try: m.prompt_all(["a1"],lambda n:"MARKER",lambda n:"dummy",1)',
      'except RuntimeError as e: print(json.dumps({"error":str(e),"rows":rows,"typed":typed}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.error).toContain('refusing a batch');
    expect(receipt.typed).toEqual([]);
    expect(receipt.rows).toEqual([{ kind: 'gateway-preflight', success: false, status: null, error: 'URLError', catalog: true }]);
  });

  it('keeps each native runtime in its measured scope without requiring a daemon socket', () => {
    const code = [
      'import importlib.util, types, json, io, builtins',
      `s = importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'commands=[]',
      'm.os.makedirs=lambda *a, **kw: None',
      'm.open=lambda p, mode="r", **kw: io.BytesIO(b"fixture") if "b" in mode else io.StringIO()',
      'm.time.sleep=lambda *a: None',
      'def shell(args, **kw):',
      ' commands.append(args)',
      ' if "new-session" in args and "--no-daemon" not in args[args.index("-c")+2]:',
      '  raise RuntimeError("app-server-control.sock did not become ready")',
      ' return types.SimpleNamespace(returncode=0, stdout="0", stderr="")',
      'm.sh=shell',
      'm.pane=lambda n: "ready"',
      'm.codex_ready=lambda *a: True',
      'm.start_codex_agents(2,"agent",types.SimpleNamespace(rec=lambda *a, **kw: None),"gpt-6-luna","low","http://127.0.0.1:18788/v1","test-owner")',
      'print(json.dumps([a[a.index("-c")+2] for a in commands if "new-session" in a]))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const commands = JSON.parse(result.stdout) as string[];
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command).toContain('--slice=swaptier');
      expect(command).toContain('--no-daemon');
    }
  });

  it('lets submitted native tasks settle without an interrupting health request', () => {
    const code = [
      'import importlib.util, json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'checks=[]; clock=[0]',
      'def check():',
      ' checks.append(1)',
      ' if len(checks)>1: raise RuntimeError("health endpoint timed out while native task was completing")',
      'def tick(*a): clock[0]+=20',
      'm.GATEWAY_CHECK=check; m.time.time=lambda:clock[0]; m.time.monotonic=lambda:clock[0]; m.time.sleep=tick',
      'm.type_text=lambda *a:None; m.press_enter=lambda *a:None; m.pane=lambda *a:"MARKER DONE-MARKER"',
      'state=m.prompt_all(["a1"],lambda n:"MARKER",lambda n:"dummy",100)',
      'print(json.dumps({"checks":len(checks),"state":state}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.checks).toBe(1);
    expect(receipt.state.a1).toMatchObject({ tDone: 20, error: null });
  });

  it('requires native hash-verified history before resuming a saved session', () => {
    const code = [
      'import importlib.util, json, tempfile, pathlib',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'with tempfile.TemporaryDirectory() as d:',
      ' p=pathlib.Path(d)/"sessions"; p.mkdir(); f=p/"native.jsonl"',
      ' rows=[{"type":"session_meta","payload":{"id":"12345678-1234-1234-1234-123456789abc"}},{"type":"event_msg","payload":{"type":"task_started"}},{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"WARM-a1-0"}]}},{"type":"response_item","payload":{"type":"function_call_output","output":"Process exited with code 0\\nOutput:\\nabc123  dummy-data.txt\\n"}},{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"DONE-WARM-a1-0"}]}},{"type":"event_msg","payload":{"type":"task_complete"}}]',
      ' f.write_text("\\n".join(json.dumps(r) for r in rows)+"\\n")',
      ' rows[-2]["payload"]["phase"]="final_answer"',
      ' f.write_text("".join(json.dumps(r)+chr(10) for r in rows))',
      ' good=m.saved_codex_session(d,"abc123")',
      ' try: m.saved_codex_session(d,"wrong")',
      ' except ValueError as e: error=str(e)',
      ' print(json.dumps({"good":good,"error":error}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.good).toMatchObject({ id: '12345678-1234-1234-1234-123456789abc', verifiedWarmMarkers: ['WARM-a1-0'] });
    expect(receipt.error).toContain('no verified warm history');
  });

  it('bounds the native launch throttle and rejects unsafe values', () => {
    expect(py(DRIVER, 'm.launch_delay_seconds({"SWAPTIER_LAUNCH_DELAY_SEC":"1.25"})', null)).toBe(1.25);
    expect(py(DRIVER, 'm.launch_delay_seconds({"SWAPTIER_LAUNCH_DELAY_SEC":"0"})', null)).toBe(0);
    for (const value of ['-1', '31', 'not-a-number']) {
      const code = `import importlib.util; s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)}); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); m.launch_delay_seconds({"SWAPTIER_LAUNCH_DELAY_SEC":${JSON.stringify(value)}})`;
      const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('SWAPTIER_LAUNCH_DELAY_SEC');
    }
  });

  it('records a dead terminal exit status and output before failing startup', () => {
    const code = [
      'import importlib.util, types, json',
      `s = importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'rows=[]',
      'm.sh=lambda *a, **kw: types.SimpleNamespace(returncode=0, stdout="1 101", stderr="")',
      'm.pane=lambda n: "native runtime failed to create a worker"',
      'try: m.check_codex_terminal("a4", types.SimpleNamespace(rec=lambda kind, **kw: rows.append({"kind":kind, **kw})))',
      'except RuntimeError as e: print(json.dumps({"error":str(e),"rows":rows}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.rows).toEqual([{ kind: 'startup-failed', agent: 'a4', state: '1 101', stderr: '', pane: 'native runtime failed to create a worker' }]);
    expect(receipt.error).toContain('exited before readiness');
  });

  const nativeOutcome = (rows: unknown[]) => py(DRIVER,
    '(lambda s: ([m.codex_record(s, r) for r in inp], s)[1])({"expected_sha256": "abc123"})', rows.flatMap((row: any) =>
      row.payload?.phase === 'final_answer' ? [row, { type: 'event_msg', payload: { type: 'task_complete' } }] : [row]));
  const turn = (marker: string) => ({ type: 'response_item', payload: { role: 'user', content: [{ type: 'input_text', text: `Dummy task ${marker}` }] } });
  const final = (text: string) => ({ type: 'response_item', payload: { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text }] } });

  it('settles a terminal provider error without waiting for an absent final answer', () => {
    const error = { message: 'Selected model is at capacity.', codex_error_info: 'server_overloaded' };
    const rows = [turn('WARM-a2-2'), { type: 'event_msg', payload: { type: 'task_complete', error, last_agent_message: null } }];
    expect(nativeOutcome(rows).outcomes['WARM-a2-2']).toContain('server_overloaded');
    expect(nativeOutcome([turn('WARM-a2-2'), { type: 'event_msg', payload: { type: 'task_complete' } }]).outcomes['WARM-a2-2'])
      .toContain('without an assistant final answer');
  });

  it('holds a final answer until native task settlement before admitting the next prompt', () => {
    const rows = [turn('WAKE-none1a1'), final('DONE-WAKE-none1a1')];
    const expr = '(lambda s: ([m.codex_record(s, r) for r in inp], s)[1])({})';
    const pending = py(DRIVER, expr, rows);
    expect(pending.outcomes).toBeUndefined();
    expect(pending.pending_outcome).toEqual({ marker: 'WAKE-none1a1', error: null });
    const settled = py(DRIVER, expr, [...rows, { type: 'event_msg', payload: { type: 'task_complete' } }]);
    expect(settled.outcomes).toEqual({ 'WAKE-none1a1': null });
    expect(settled.pending_outcome).toBeUndefined();
  });

  it('rejects the observed DONE after bwrap failure and a final refusal without waiting five minutes', () => {
    const rows = [turn('WARM-a1-0'), { type: 'response_item', payload: { type: 'custom_tool_call_output', output: [{ type: 'input_text', text: 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted' }] } }];
    expect(nativeOutcome([...rows, final('DONE-WARM-a1-0')]).outcomes['WARM-a1-0']).toContain('no successful native file-hash');
    expect(nativeOutcome([...rows, final('Unable to read the file')]).outcomes['WARM-a1-0']).toContain('omitted DONE');
  });

  it('accepts actual hash output in both native tool formats, without carrying success into another warm turn', () => {
    for (const type of ['function_call_output', 'custom_tool_call_output']) {
      const output = type === 'function_call_output' ? 'abc123  dummy-data.txt' : [{ type: 'input_text', text: 'abc123  dummy-data.txt' }];
      const rows = [turn('WARM-a1-0'), { type: 'response_item', payload: { type, output } }, final('DONE-WARM-a1-0')];
      expect(nativeOutcome(rows).outcomes['WARM-a1-0']).toBeNull();
      expect(nativeOutcome([...rows, turn('WARM-a1-1'), final('DONE-WARM-a1-1')]).outcomes['WARM-a1-1']).toContain('no successful native file-hash');
      expect(nativeOutcome([...rows, turn('WAKE-none1a1'), final('DONE-WAKE-none1a1')]).outcomes['WAKE-none1a1']).toBeNull();
    }
  });

  it('accepts the exact hash of piped input, which sha256sum labels with a dash', () => {
    const toolResult = { type: 'response_item', payload: { type: 'function_call_output', output: 'Process exited with code 0\nOutput:\nabc123  -\n' } };
    const rows = [turn('WARM-a8-0'), toolResult, final('DONE-WARM-a8-0')];
    expect(nativeOutcome(rows).outcomes['WARM-a8-0']).toBeNull();
    toolResult.payload.output = 'wrong abc1230  -';
    expect(nativeOutcome(rows).outcomes['WARM-a8-0']).toContain('no successful native file-hash');
  });

  it('corrects only failed dummy tasks with a bounded retry budget and records the evidence', () => {
    const code = [
      'import importlib.util, types, json',
      `s = importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'calls=[]; records=[]; markers=[]',
      'def prompt(names, marker, *args, **kw):',
      ' calls.append(list(names))',
      ' markers.append([marker(n) for n in names])',
      ' return {n: {"tDone": None if len(calls)==1 and n=="a2" else 1, "error": "hash mismatch"} for n in names}',
      'm.prompt_all=prompt',
      'm.warm(["a1","a2"],1,types.SimpleNamespace(rec=lambda kind, **kw: records.append({"kind":kind, **kw})))',
      'print(json.dumps({"calls":calls,"records":records,"markers":markers}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.calls).toEqual([['a1', 'a2'], ['a2']]);
    expect(parsed.markers).toEqual([['WARM-a1-0', 'WARM-a2-0'], ['WARM-a2r1-0']]);
    expect(parsed.records[0]).toMatchObject({ kind: 'warm-retry', agents: ['a2'] });
    expect(parsed.records[1]).toMatchObject({ kind: 'warm-round', agents: 2 });
    const exhausted = spawnSync('python3', ['-c', code.replace('len(calls)==1 and n=="a2"', 'True')], { encoding: 'utf8' });
    expect(exhausted.status).not.toBe(0);
    expect(exhausted.stderr).toContain('warm round 0 never finished');
  });

  it('bounds warm-up concurrency while verifying every session in each round', () => {
    const code = [
      'import importlib.util, types, json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'calls=[]; records=[]',
      'def prompt(names, marker, *args, **kw):',
      ' calls.append(list(names)); return {n:{"tDone":1} for n in names}',
      'm.prompt_all=prompt; m.agent_stats=lambda n: {}',
      'm.warm(["a1","a2","a3","a4","a5"],2,types.SimpleNamespace(rec=lambda kind, **kw:records.append({"kind":kind, **kw})),2)',
      'print(json.dumps({"calls":calls,"rounds":[r["agents"] for r in records if r["kind"]=="warm-round"]}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.calls).toEqual([['a1', 'a2'], ['a3', 'a4'], ['a5'], ['a1', 'a2'], ['a3', 'a4'], ['a5']]);
    expect(receipt.rounds).toEqual([5, 5]);
  });

  it('provisions the documented distro sandbox without disabling global user-namespace restrictions', () => {
    const bootstrap = readFileSync(join(HERE, 'swap-tier-bootstrap.sh'), 'utf8');
    expect(bootstrap).toContain('bubblewrap apparmor-profiles apparmor-utils');
    expect(bootstrap).toContain('apparmor_parser -r "$profile"');
    expect(bootstrap).not.toContain('apparmor_restrict_unprivileged_userns=0');
  });

  it('fails the native sandbox preflight on the observed namespace error before spending model calls', () => {
    const code = [
      'import importlib.util, types',
      `s = importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'm.subprocess.run = lambda *a, **kw: types.SimpleNamespace(returncode=1, stdout="", stderr="bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted")',
      'm.codex_sandbox_preflight("agent", types.SimpleNamespace(rec=lambda *a, **kw: None))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('native read-only sandbox preflight failed: bwrap: loopback');
  });

  it('counts an actual assistant final answer instead of an echoed prompt or tool invocation', () => {
    const row = { type: 'response_item', payload: { role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'DONE-WARM-a1-0' }] } };
    expect(py(DRIVER, 'm.final_reply_text(inp)', row)).toBe('DONE-WARM-a1-0');
    expect(py(DRIVER, 'm.final_reply_text(inp)', { ...row, payload: { ...row.payload, role: 'user' } })).toBe('');
    expect(py(DRIVER, 'm.final_reply_text(inp)', { ...row, payload: { ...row.payload, phase: 'commentary' } })).toBe('');
    expect(py(DRIVER, 'm.final_reply_text(inp)', { type: 'response_item', payload: { type: 'function_call', arguments: 'echo DONE-WARM-a1-0' } })).toBe('');
  });

  it('refuses another load attempt when an interrupted run leaves the owned slice active', () => {
    const code = [
      'import importlib.util, types',
      `s = importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm = importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'm.sh = lambda argv, check=True: types.SimpleNamespace(stdout="active\\n" if "is-active" in argv else "", returncode=0)',
      'm.stop_agents()',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refusing a duplicate launch');
  });

  it('recognizes the observed native input frame even when context-left is absent', () => {
    const screen = '>_ OpenAI Codex (v0.162.1)\n› Ask Codex to do anything\ngpt-6-luna low · ~/work/a1 · ← for agents';
    expect(py(DRIVER, 'm.codex_ready(inp, "gpt-6-luna")', screen)).toBe(true);
    expect(py(DRIVER, 'm.codex_ready(inp, "gpt-6-luna")', screen.replace('gpt-6-luna', 'GPT-6-Luna'))).toBe(true);
    expect(py(DRIVER, 'm.codex_ready(inp, "gpt-6-luna")', 'Sign in to ChatGPT · gpt-6-luna')).toBe(false);
    expect(py(DRIVER, 'm.codex_ready(inp, "gpt-6-luna")', screen.replace('gpt-6-luna', 'gpt-6-sol'))).toBe(false);
  });

  it('pins model and low effort without copying cloud credentials or using stub responses', () => {
    const config = py(DRIVER, 'm.codex_config(*inp)', ['gpt-6-luna', 'low', 'http://127.0.0.1:18788/v1', 'benchmark-owner', '/home/agent/work/a1']);
    expect(config).toContain('model = "gpt-6-luna"');
    expect(config).toContain('model_reasoning_effort = "low"');
    expect(config).toContain('wire_api = "responses"');
    expect(config).toContain('requires_openai_auth = false');
    expect(() => py(DRIVER, 'm.codex_config(*inp)', ['gpt-6-luna', 'low', 'https://example.com/v1', 'benchmark-owner', '/work'])).toThrow(/loopback SSH/);
  });

  it('keeps independently measured compressor, readahead and batched disk arms distinguishable', () => {
    expect(py(DRIVER, '[m.parse_arm(x) for x in inp]', ['zram:lz4', 'titanium@pc0=/dev/nvme0n1', 'titanium-batch5=/dev/nvme0n1'])).toEqual([
      { name: 'zram-lz4', kind: 'zram', algorithm: 'lz4' },
      { name: 'titanium-pc0', kind: 'device', device: '/dev/nvme0n1', pageCluster: 0 },
      { name: 'titanium-batch5', kind: 'device', device: '/dev/nvme0n1', batch: 5 },
    ]);
    expect(() => py(DRIVER, 'm.parse_arm(inp)', 'titanium@pc9=/dev/nvme0n1')).toThrow(/page-cluster/);
  });
});
const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] });
const toolResult = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file body' }] };
const toolUse = { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] };

describe('stub reply plan', () => {
  it('answers a WARM prompt with a Read of warm file k, then a DONE text once the tool ran', () => {
    expect(plan([user('Please do step WARM-a3-1 now')])).toEqual(['warm-tool', 'WARM-a3-1', ['tool', '/f1.py']]);
    const done = plan([user('Please do step WARM-a3-1 now'), toolUse, toolResult]);
    expect(done[0]).toBe('warm-done');
    expect(done[2][1]).toMatch(/DONE-WARM-a3-1$/);
  });

  it('still sees the tool result when the CLI appends a reminder-only user message after it', () => {
    // The first prototype looped 2,500 Reads: it only looked for the tool result in the LAST message.
    const reminder = user('<system-reminder>todo list is empty</system-reminder>');
    expect(plan([user('step WARM-a1-0'), toolUse, toolResult, reminder])[0]).toBe('warm-done');
  });

  it('answers a WAKE prompt with DONE-WAKE-<nonce>, and a markerless side request with a short text', () => {
    expect(plan([user('Wake up WAKE-zram123a4 please')])).toEqual(['wake', 'WAKE-zram123a4', ['text', 'Back. DONE-WAKE-zram123a4']]);
    expect(plan([user('generate a title for this conversation')])).toEqual(['side', null, ['text', 'ok']]);
  });

  it('follows the newest marker, not an older WARM one still in the history', () => {
    const msgs = [user('step WARM-a1-0'), toolUse, toolResult, { role: 'assistant', content: [{ type: 'text', text: 'DONE' }] }, user('WAKE-x1a1')];
    expect(plan(msgs)[0]).toBe('wake');
  });
});

const MiB = 2 ** 20;
// anon defaults to current: in these fixtures all of an agent's resident memory is anonymous.
const st = (current: number, swap: number, majflt = 0, anon = current) => ({
  current: current * MiB,
  swap: swap * MiB,
  anon: anon * MiB,
  file: 0,
  majflt,
});

describe('report reduction', () => {
  const rows = [
    { t: 100, kind: 'arm-start', arm: 'zram', device: '/dev/zram0' },
    { t: 101, kind: 'reclaimed', arm: 'zram', agent: 'a1', seconds: 1.0, before: st(300, 0), after: st(20, 250) },
    { t: 102, kind: 'reclaimed', arm: 'zram', agent: 'a2', seconds: 1.0, before: st(300, 0), after: st(30, 230) },
    { t: 103, kind: 'phase', arm: 'zram', phase: 'reclaim', edge: 'end', host: { zram: { orig: 480 * MiB, compr: 100 * MiB, used: 120 * MiB } } },
    { t: 164, kind: 'idle', arm: 'zram', before: { a1: st(20, 250), a2: st(30, 230) }, after: { a1: st(25, 245), a2: st(30, 230) } },
    { t: 170, kind: 'phase', arm: 'zram', phase: 'single', edge: 'start' },
    { t: 172, kind: 'phase', arm: 'zram', phase: 'single', edge: 'end' },
    { t: 173, kind: 'wake', arm: 'zram', phase: 'single', agent: 'a1', t0: 170, tEcho: 170.5, tEnter: 170.5, tDone: 171.5, pre: st(25, 245, 10), post: st(200, 70, 4010) },
    { t: 180, kind: 'phase', arm: 'zram', phase: 'storm', edge: 'start' },
    { t: 190, kind: 'phase', arm: 'zram', phase: 'storm', edge: 'end' },
    { t: 191, kind: 'wake', arm: 'zram', phase: 'storm', agent: 'a2', t0: 180, tEcho: 182, tEnter: 182, tDone: 186, pre: st(30, 230), post: st(210, 50) },
    { t: 211, kind: 'arm-end', arm: 'zram', host: {}, agents: { a1: st(200, 60), a2: st(210, 40) } },
  ];
  const probe = [
    [171, 2, 0],
    [171.1, 40, 3],
    [185, 900, 50],
    [300, 1, 0],
  ];
  const [arm] = py(DRIVER, 'm.summarize(inp["rows"], [tuple(p) for p in inp["probe"]])', { rows, probe });

  it('reports how much each parked agent moved to swap, what stayed resident, and the zram ratio', () => {
    expect(arm.reclaim).toMatchObject({ agents: 2, beforeMiBPerAgent: 300, swappedMiBPerAgent: 240, residentAfterMiBPerAgent: 25, seconds: 2 });
    expect(arm.reclaim.swapOutMiBps).toBe(240);
    expect(arm.zram).toMatchObject({ origMiB: 480, usedMiB: 120, ratio: 4 });
    expect(arm.idleRegainedMiB).toBe(5);
  });

  it('times single and storm wakes from the typed prompt, with paged-back memory and the probe inside each window', () => {
    expect(arm.single.totalSec.p50).toBe(1.5);
    expect(arm.single.echoSec.p50).toBe(0.5);
    expect(arm.single.regainedMiBPerAgent).toBe(175);
    expect(arm.single.majfltPerAgent).toBe(4000);
    expect(arm.single.probeExecMs).toMatchObject({ samples: 2, max: 40 });
    expect(arm.storm.allDoneSec).toBe(6);
    expect(arm.storm.probeExecMs).toMatchObject({ samples: 1, max: 900 });
    expect(arm.swapAfterStormMiB).toBe(100);
    expect(arm.residentAfterStormMiB).toBe(410);
  });

  // Measured 14 Oct 2026 (WI-10005475): on a disk swap device the kernel keeps each swap slot
  // after reading the page back (swap cache), so swap-used stays flat while the agent pages
  // itself back in. The first summary used the swap-used drop and reported ~0 MiB regained on
  // every disk tier while resident memory had grown by ~1.1 GiB.
  it('measures memory regained from resident growth, not swap-used, so disk swap cache cannot hide it', () => {
    const disk = [
      { t: 100, kind: 'arm-start', arm: 'pd-ssd', device: '/dev/sdc' },
      { t: 101, kind: 'reclaimed', arm: 'pd-ssd', agent: 'a1', seconds: 0.5, before: st(152, 0), after: st(3, 150, 0, 1) },
      { t: 164, kind: 'idle', arm: 'pd-ssd', before: { a1: st(3, 150, 0, 1) }, after: { a1: st(60, 150, 0, 58) } },
      { t: 170, kind: 'phase', arm: 'pd-ssd', phase: 'single', edge: 'start' },
      { t: 172, kind: 'phase', arm: 'pd-ssd', phase: 'single', edge: 'end' },
      { t: 173, kind: 'wake', arm: 'pd-ssd', phase: 'single', agent: 'a1', t0: 170, tEcho: 170.5, tEnter: 170.5, tDone: 171.5, pre: st(60, 150, 0, 58), post: st(130, 149, 900, 128) },
      { t: 200, kind: 'arm-end', arm: 'pd-ssd', host: {}, agents: { a1: st(130, 149, 900, 128) } },
    ];
    const [d] = py(DRIVER, 'm.summarize(inp, [])', disk);
    expect(d.idleRegainedMiB).toBe(57);
    expect(d.single.regainedMiBPerAgent).toBe(70);
    expect(d.swapAfterStormMiB).toBe(149);
    expect(d.residentAfterStormMiB).toBe(128);
  });

  it('counts a wake that never rendered as failed instead of dropping it', () => {
    const lost = rows.map((r) => (r.kind === 'wake' && r.phase === 'storm' ? { ...r, tDone: null } : r));
    const [a] = py(DRIVER, 'm.summarize(inp, [])', lost);
    expect(a.storm.failed).toBe(1);
    expect(a.storm.allDoneSec).toBeNull();
  });
});

describe('arm specs', () => {
  it('accepts none, zram and <label>=<device>, and refuses anything else', () => {
    expect(py(DRIVER, '[m.parse_arm(s) for s in inp]', ['none', 'zram', 'pd-ssd=/dev/disk/by-id/google-swapssd'])).toEqual([
      { name: 'none', kind: 'none' },
      { name: 'zram', kind: 'zram' },
      { name: 'pd-ssd', kind: 'device', device: '/dev/disk/by-id/google-swapssd' },
    ]);
    expect(() => py(DRIVER, 'm.parse_arm(inp)', 'pd-ssd')).toThrow(/expects none, zram/);
  });
});
