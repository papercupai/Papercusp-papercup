/**
 * Regression guard for the per-turn VERIFY-not-CREATE work-item BACKSTOP hook
 * (enforce-system-on-generic-work-2026-06-29, P-019). Covers the
 * OPERATOR-INDEPENDENT paths (no live operator needed): the psu gate, the
 * PostToolUse edit-marker (workspace scoping + tool filtering), and the
 * Stop/SessionEnd nudge decision (objective present vs empty, per-session
 * de-dupe, the flag kill-switch, and the fail-open-to-ON contract).
 *
 * The nudge branch's objective read + flag read are driven by FIXTURE env vars
 * (PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE / _FLAG_FIXTURE) so the whole suite
 * runs offline; the coord-note POST is skipped under a glance fixture. The hook
 * is bash+python, so we spawn it as a subprocess with crafted stdin + run it
 * SYNC (PAPERCUSP_WORKITEM_NUDGE_SYNC=1).
 *
 * Cardinal contract (a backstop must NEVER block/break a session): every path
 * exits 0 with EMPTY stdout, and the hook NEVER creates a work-item.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

const HOOK = join(__dirname, '..', 'workitem-verify-nudge.sh');
const SID = 'su-test1';
let home: string, cache: string, ws: string, repo: string, logPath: string;
let glanceEmpty: string, glanceHasObj: string;
const editedMarker = () => join(cache, `wi-nudge-${SID}.edited`);
const doneMarker = () => join(cache, `wi-nudge-${SID}.done`);

beforeAll(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'winudge-home-'));
  fs.mkdirSync(join(home, '.papercusp'), { recursive: true });
  // Install marker — the hook bails (exit 0) without the su-token.
  fs.writeFileSync(join(home, '.papercusp', 'superuser-token'), 'test-token\n');
  cache = fs.mkdtempSync(join(os.tmpdir(), 'winudge-cache-'));
  ws = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'winudge-ws-')));
  repo = join(ws, 'papercup-test');
  fs.mkdirSync(join(repo, 'sub'), { recursive: true });
  logPath = join(cache, 'nudge.log');
  glanceEmpty = join(cache, 'glance-empty.json');
  glanceHasObj = join(cache, 'glance-obj.json');
  fs.writeFileSync(glanceEmpty, JSON.stringify({ self: { objective: null } }));
  fs.writeFileSync(glanceHasObj, JSON.stringify({ self: { objective: 'WI-9 do a thing' } }));
});
afterAll(() => {
  for (const d of [home, cache, ws]) fs.rmSync(d, { recursive: true, force: true });
});
beforeEach(() => {
  // Isolate each case: clear this session's markers + the log.
  for (const f of [editedMarker(), doneMarker(), logPath]) fs.rmSync(f, { force: true });
});

function run(input: string, extra: Record<string, string> = {}, withSid = true) {
  // Start from a CLEAN env (the test itself runs inside a psu session, so we must
  // strip any inherited PAPERCUSP_* that would leak into the child).
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('PAPERCUSP_')) env[k] = v;
  }
  Object.assign(env, {
    HOME: home,
    PAPERCUSP_LOCKS_CACHE_DIR: cache,
    PAPERCUSP_WORKSPACE_ROOT: ws,
    PAPERCUSP_WORKITEM_NUDGE_SYNC: '1',
    PAPERCUSP_WORKITEM_NUDGE_LOG: logPath,
    // Unreachable operator: any accidental network call fails fast (and fail-open).
    PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:1',
  });
  if (withSid) env.PAPERCUSP_SID = SID;
  Object.assign(env, extra);
  const r = spawnSync('bash', [HOOK], { input, encoding: 'utf8', env });
  return { status: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}
const payload = (o: object) => JSON.stringify(o);
const logLines = () =>
  fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];

async function startMcpStub() {
  const requestsPath = join(cache, 'mcp-requests.jsonl');
  fs.rmSync(requestsPath, { force: true });
  const serverProgram = `
import http.server, json, sys

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        tool = request.get('params', {}).get('name')
        with open(sys.argv[1], 'a', encoding='utf-8') as log:
            log.write(json.dumps({'name': tool, 'url': self.path}) + '\\n')
        if tool == 'flags:get':
            payload = {'results': [{'ok': True, 'enabled': True}]}
        elif tool == 'coord:glance':
            payload = {'self': {'objective': None}}
        else:
            payload = {'ok': True}
        result = {'content': [{'type': 'text', 'text': json.dumps(payload)}]}
        response = json.dumps({'jsonrpc': '2.0', 'id': request.get('id'), 'result': result}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, *_args):
        pass

server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
print('READY:' + str(server.server_address[1]), flush=True)
server.serve_forever()
`;
  const server = spawn('python3', ['-u', '-c', serverProgram, requestsPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  server.stdout.setEncoding('utf8');
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.kill('SIGTERM');
      reject(new Error(`MCP stub did not start: ${stderr}`));
    }, 5000);
    server.stdout.on('data', (chunk) => {
      stdout += chunk;
      const ready = /READY:([0-9]+)/.exec(stdout);
      if (ready) {
        clearTimeout(timeout);
        resolve(`http://127.0.0.1:${ready[1]}`);
      }
    });
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`MCP stub exited before ready (code=${code}, signal=${signal}): ${stderr}`));
    });
  });
  return {
    url,
    requestsPath,
    stop: async () => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => server.once('exit', () => resolve()));
      server.kill('SIGTERM');
      await exited;
    },
  };
}

describe('cc work-item verify-nudge hook — operator-independent paths', () => {
  it('no PAPERCUSP_SID (plain session) → exit 0, no marker, no nudge', () => {
    const r = run(
      payload({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'a.ts') }, cwd: repo }),
      {},
      false,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(editedMarker())).toBe(false);
  });

  it('malformed JSON → fail-open exit 0, empty stdout', () => {
    const r = run('not json {');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });

  // ── PostToolUse marker branch ────────────────────────────────────────────────
  it('PostToolUse Edit IN workspace → writes the .edited marker', () => {
    const r = run(payload({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: join(repo, 'sub', 'f.ts') }, cwd: repo }));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(editedMarker())).toBe(true);
  });

  it('PostToolUse Edit OUTSIDE workspace → no marker', () => {
    const r = run(payload({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: '/tmp/elsewhere/x.ts' }, cwd: '/tmp/elsewhere' }));
    expect(r.status).toBe(0);
    expect(fs.existsSync(editedMarker())).toBe(false);
  });

  it('PostToolUse non-edit tool (Read) → no marker', () => {
    const r = run(payload({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: join(repo, 'a.ts') }, cwd: repo }));
    expect(r.status).toBe(0);
    expect(fs.existsSync(editedMarker())).toBe(false);
  });

  // ── Stop / SessionEnd nudge branch ───────────────────────────────────────────
  it('Stop with NO prior edit → no nudge (no log, no .done)', () => {
    const r = run(payload({ hook_event_name: 'Stop' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceEmpty, PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE: 'on' });
    expect(r.status).toBe(0);
    expect(logLines()).toEqual([]);
    expect(fs.existsSync(doneMarker())).toBe(false);
  });

  it('Stop with edit + objective PRESENT → no nudge', () => {
    fs.writeFileSync(editedMarker(), '{}');
    const r = run(payload({ hook_event_name: 'Stop' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceHasObj, PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE: 'on' });
    expect(r.status).toBe(0);
    expect(logLines()).toEqual([]);
    expect(fs.existsSync(doneMarker())).toBe(false);
  });

  it('Stop with edit + objective EMPTY + flag ON → emits ONE nudge (log + stderr + .done), empty stdout, no work-item created', () => {
    fs.writeFileSync(editedMarker(), '{}');
    const r = run(payload({ hook_event_name: 'Stop' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceEmpty, PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE: 'on' });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(''); // never alters the turn output
    expect(logLines().length).toBe(1);
    expect(logLines()[0]).toContain('open one');
    expect(r.stderr).toContain('work-item');
    expect(fs.existsSync(doneMarker())).toBe(true);
  });

  it('second Stop after .done → suppressed (still exactly one log line)', () => {
    fs.writeFileSync(editedMarker(), '{}');
    run(payload({ hook_event_name: 'Stop' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceEmpty, PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE: 'on' });
    const r2 = run(payload({ hook_event_name: 'Stop' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceEmpty, PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE: 'on' });
    expect(r2.status).toBe(0);
    expect(logLines().length).toBe(1);
  });

  it('flag OFF → no nudge even with edit + empty objective (owner kill-switch)', () => {
    fs.writeFileSync(editedMarker(), '{}');
    const r = run(payload({ hook_event_name: 'Stop' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceEmpty, PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE: 'off' });
    expect(r.status).toBe(0);
    expect(logLines()).toEqual([]);
    expect(fs.existsSync(doneMarker())).toBe(false);
  });

  it('flag UNRESOLVABLE (operator down) → fail-open to ON → still nudges', () => {
    fs.writeFileSync(editedMarker(), '{}');
    // No flag fixture: the hook calls flags:get against the unreachable operator,
    // the call throws, and the backstop defaults ON.
    const r = run(payload({ hook_event_name: 'Stop' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceEmpty });
    expect(r.status).toBe(0);
    expect(logLines().length).toBe(1);
    expect(fs.existsSync(doneMarker())).toBe(true);
  });

  it('binds flags:get and coord:glance MCP requests to the native session from the hook event', async () => {
    fs.writeFileSync(editedMarker(), '{}');
    const stub = await startMcpStub();
    try {
      const r = run(payload({ hook_event_name: 'Stop', session_id: 'native-session-from-event' }), {
        PAPERCUSP_OPERATOR_URL: stub.url,
        PAPERCUSP_NATIVE_SESSION_ID: 'native-session-from-environment',
      });
      expect(r.status).toBe(0);
      expect(logLines().length).toBe(1);

      const requests = fs.readFileSync(stub.requestsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const tool of ['flags:get', 'coord:glance']) {
        const request = requests.find((entry) => entry.name === tool);
        expect(request, `${tool} request was sent`).toBeDefined();
        expect(new URL(request.url, stub.url).searchParams.get('native_session')).toBe('native-session-from-event');
      }
    } finally {
      await stub.stop();
    }
  });

  it('uses PAPERCUSP_NATIVE_SESSION_ID when the hook event has no native session ID', async () => {
    fs.writeFileSync(editedMarker(), '{}');
    const stub = await startMcpStub();
    try {
      const r = run(payload({ hook_event_name: 'Stop' }), {
        PAPERCUSP_OPERATOR_URL: stub.url,
        PAPERCUSP_NATIVE_SESSION_ID: 'native-session-from-environment',
      });
      expect(r.status).toBe(0);
      const requests = fs.readFileSync(stub.requestsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      for (const tool of ['flags:get', 'coord:glance']) {
        const request = requests.find((entry) => entry.name === tool);
        expect(request, `${tool} request was sent`).toBeDefined();
        expect(new URL(request.url, stub.url).searchParams.get('native_session')).toBe('native-session-from-environment');
      }
    } finally {
      await stub.stop();
    }
  });

  it('SessionEnd behaves like Stop (also nudges)', () => {
    fs.writeFileSync(editedMarker(), '{}');
    const r = run(payload({ hook_event_name: 'SessionEnd' }), { PAPERCUSP_WORKITEM_NUDGE_GLANCE_FIXTURE: glanceEmpty, PAPERCUSP_WORKITEM_NUDGE_FLAG_FIXTURE: 'on' });
    expect(r.status).toBe(0);
    expect(logLines().length).toBe(1);
    expect(fs.existsSync(doneMarker())).toBe(true);
  });
});
