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

describe('operator readiness across cold lifecycle', () => {
  function healthScenario(valid: boolean) {
    const code = [
      'import importlib.util,json,socketserver,threading,subprocess,sys',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
      'class Handler(socketserver.BaseRequestHandler):',
      ' def handle(self):',
      '  self.request.recv(4096)',
      '  self.request.sendall(self.server.payload)',
      'servers=[]',
      'def serve(payload):',
      ' server=socketserver.TCPServer(("127.0.0.1",0),Handler);server.payload=payload;servers.append(server)',
      ' threading.Thread(target=server.serve_forever,daemon=True).start();return server.server_address[1]',
      'def http(body):return b"HTTP/1.0 200 OK\\r\\nContent-Length: "+str(len(body)).encode()+b"\\r\\n\\r\\n"+body',
      'ports=[serve(b"SSH-2.0-OpenSSH_9.6\\r\\n"),serve(http(b"<html>SPA</html>")),serve(http(b"[]")),serve(http(b\'{"ok":1,"service":"papercusp-operator","sha":"candidate"}\')),serve(http(b\'{"ok":true,"service":"other","sha":"candidate"}\')),serve(http(b\'{"ok":true,"service":"papercusp-operator","sha":"wrong"}\'))]',
      ...(valid ? ['ports.append(serve(http(b\'{"ok":true,"service":"papercusp-operator","sha":"candidate"}\')))'] : []),
      'out=m.wait_for_operator_health(ports,timeout=.15,interval=.01,expected_sha="candidate")',
      `r=subprocess.run([sys.executable,${JSON.stringify(DRIVER)},"wait-health",*sum((["--port",str(p)] for p in ports),[]),"--timeout",".15","--expected-sha","candidate"],capture_output=True,text=True)`,
      'print(json.dumps({"result":out,"cli":json.loads(r.stdout),"exitCode":r.returncode,"expectedPort":ports[-1]}))',
      'for server in servers:server.server_close()',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 5000 });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  it('passes a valid candidate API after SSH, HTML, wrong schema and wrong candidate sockets', () => {
    const out = healthScenario(true);
    expect(out.result).toMatchObject({ ready: true, port: out.expectedPort, attempts: 7 });
    expect(out.cli).toMatchObject({ ready: true, port: out.expectedPort });
    expect(out.exitCode).toBe(0);
  });

  it('times out without accepting HTTP availability or another artifact', () => {
    const out = healthScenario(false);
    expect(out.result.ready).toBe(false);
    expect(out.cli.ready).toBe(false);
    expect(out.exitCode).toBe(1);
  });
});

describe('retained file and SQL durability witness', () => {
  function witnessScenario(change: string, expectedFailure = false, cli = false) {
    const fakePsql = String.raw`#!/usr/bin/env python3
import os,sys,json,pathlib,re
sql=sys.argv[-1]; db=pathlib.Path(os.environ['WITNESS_DB']); log=pathlib.Path(os.environ['WITNESS_LOG'])
with log.open('a') as f:
 f.write(json.dumps({'sql':sql,'options':os.environ['PGOPTIONS'],'passwordCorrect':os.environ['PGPASSWORD']=='p@ssword','argsContainSecret':'p@ssword' in str(sys.argv)})+'\n')
if os.environ.get('WITNESS_SQL_FAILURE'):
 print('error includes p@ssword',file=sys.stderr); sys.exit(17)
if sql.startswith('BEGIN;'):
 if db.exists(): sys.exit(1)
 db.write_text(re.findall(r'[a-f0-9]{64}',sql)[0])
elif sql.startswith('SELECT current_setting'):
 if db.exists(): print(('off' if os.environ.get('WITNESS_WRITABLE') else 'on')+'\t'+db.read_text())
else: sys.exit(9)
`;
    const code = [
      'import importlib.util,json,pathlib,tempfile,os,sys,shutil,subprocess',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'root=pathlib.Path(tempfile.mkdtemp()); data=root/"retained.bin"; data.write_bytes(b"retained-data")',
      'config=root/"embedded-pg.json"; config.write_text(json.dumps({"url":"postgresql://user:p%40ssword@127.0.0.1:5432/test"}))',
      'db=root/"db"; log=root/"sql.log"; psql=root/"psql"',
      `psql.write_text(${JSON.stringify(fakePsql)}); psql.chmod(0o755)`,
      'os.environ.update(WITNESS_DB=str(db),WITNESS_LOG=str(log))',
      'manifest=root/"manifest.json"',
      'receipt=m.create_durability_witness(str(manifest),[str(data)],str(config),str(psql),"p544-test")',
      'before=manifest.read_bytes(); error=None; verified=None',
      change,
      'try: verified=m.verify_durability_witness(str(manifest),receipt["manifestSha256"],str(config),str(psql))',
      'except (RuntimeError,ValueError,OSError) as e: error=str(e)',
      'cli=None',
      ...(cli ? [
        `result=subprocess.run([sys.executable,${JSON.stringify(DRIVER)},"witness-verify","--manifest",str(manifest),"--manifest-sha256",receipt["manifestSha256"],"--pg-config",str(config),"--psql",str(psql)],capture_output=True,text=True)`,
        'assert result.returncode==0,result.stderr; cli=json.loads(result.stdout)',
      ] : []),
      'rows=[json.loads(line) for line in log.read_text().splitlines()]',
      'print(json.dumps({"receipt":receipt,"verified":verified,"error":error,"cli":cli,"sql":rows,"manifestUnchanged":before==manifest.read_bytes(),"dbExists":db.exists()}))',
      'shutil.rmtree(root)',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out.error !== null).toBe(expectedFailure);
    expect(out.sql.filter((row: any) => row.sql.startsWith('BEGIN;'))).toHaveLength(1);
    for (const row of out.sql.slice(1)) {
      expect(row.sql).toMatch(/^SELECT current_setting\('transaction_read_only'\), value FROM/);
      expect(row.sql).not.toMatch(/CREATE|INSERT|UPDATE|DELETE|CONFLICT/i);
      expect(row.options).toContain('default_transaction_read_only=on');
      expect(row.passwordCorrect).toBe(true);
      expect(row.argsContainSecret).toBe(false);
    }
    return out;
  }

  it('compares the pre-event manifest and forces read-only SQL verification', () => {
    const out = witnessScenario('pass', false, true);
    expect(out.verified).toMatchObject({ verified: true, files: 1, sqlReadOnly: true });
    expect(out.cli).toEqual(out.verified);
    expect(out.manifestUnchanged).toBe(true);
    expect(out.sql).toHaveLength(3);
  });

  it.each([
    ['db.unlink()', 'missing, changed or not read-only'],
    ['db.write_text("changed")', 'missing, changed or not read-only'],
    ['os.environ["WITNESS_WRITABLE"]="1"', 'missing, changed or not read-only'],
    ['os.environ["WITNESS_SQL_FAILURE"]="1"', 'SQL failed'],
    ['data.write_bytes(b"lost-and-recreated")', 'file changed'],
    ['data.unlink()', 'retained.bin'],
    ['manifest.write_bytes(before+b" ")', 'manifest hash mismatch'],
  ])('fails without repairing evidence after %s', (change, message) => {
    const out = witnessScenario(change, true);
    expect(out.error).toContain(message);
    if (change === 'db.unlink()') expect(out.dbExists).toBe(false);
  });

  it('refuses initialization over the same manifest before another SQL write', () => {
    const out = witnessScenario([
      'try: m.create_durability_witness(str(manifest),[str(data)],str(config),str(psql),"p544-test")',
      'except ValueError as e: assert "already exists" in str(e)',
      'else: raise AssertionError("reinitialized existing witness")',
    ].join('\n'));
    expect(out.verified.verified).toBe(true);
    expect(out.manifestUnchanged).toBe(true);
  });
});

describe('native evidence survives guest teardown', () => {
  function archiveScenario(change: string, afterArchive = 'pass') {
    const code = [
      'import importlib.util,json,pathlib,tempfile,tarfile,io,subprocess,sys,hashlib,shutil',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'root=pathlib.Path(tempfile.mkdtemp()); out=root/"run"; out.mkdir()',
      'start=1792190000; stamp="2026-10-16T22:33:25Z"',
      'rows=[{"kind":"run-start","t":start,"cli":"codex","agents":2,"warm":1}]',
      'sessions={}',
      'def record(payload, type="response_item"): return {"timestamp":stamp,"type":type,"payload":payload}',
      'for name in ["a1","a2"]:',
      ' data=root/(name+".txt"); data.write_bytes((name+" dummy").encode()); digest=hashlib.sha256(data.read_bytes()).hexdigest()',
      ' history=[]',
      ' for marker in ["WARM-"+name+"-0", "WAKE-test"+name]:',
      '  history.extend([record({"role":"user","content":[{"text":marker}]}),record({"type":"function_call_output","output":digest}),record({"role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"DONE-"+marker}]}),record({"type":"task_complete"},"event_msg")])',
      ' path=root/(name+".jsonl"); path.write_text("".join(json.dumps(r)+"\\n" for r in history))',
      ' sessions[name]={"file":str(path),"data":str(data)}',
      ' rows.append({"kind":"wake","t":start+10,"agent":name,"tDone":start+9,"error":None,"nativeToolVerified":False})',
      'rows.append({"kind":"run-end","t":start+20})',
      change,
      '(out/"results.jsonl").write_text("".join(json.dumps(r)+"\\n" for r in rows))',
      'error=None; receipt=None; cli=None',
      'try: receipt=m.archive_native_evidence(str(out),sessions)',
      'except (RuntimeError,ValueError) as e: error=str(e)',
      'archive=out/"native-evidence.tar.gz"',
      afterArchive,
      'if archive.exists():',
      ' copied=root/"local-copy.tar.gz"; shutil.copyfile(archive,copied)',
      ' for entry in sessions.values():',
      '  for key in ["file","data"]:',
      '   p=pathlib.Path(entry[key]); p.unlink(missing_ok=True)',
      ` r=subprocess.run([sys.executable,${JSON.stringify(DRIVER)},"verify-archive","--archive",str(copied),"--results",str(out/"results.jsonl")],capture_output=True,text=True)`,
      ' cli={"exit":r.returncode,"stdout":r.stdout,"stderr":r.stderr}',
      ' with tarfile.open(copied) as t: manifest=json.load(t.extractfile("native-manifest.json"))',
      'else: manifest=None',
      'print(json.dumps({"receipt":receipt,"error":error,"cli":cli,"manifest":manifest}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  }

  it('verifies a locally copied complete population after original histories are deleted', () => {
    const result = archiveScenario('pass');
    expect(result.error).toBeNull();
    expect(result.receipt).toMatchObject({ verified: true, assignedAgents: 2 });
    expect(result.receipt.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.cli.exit).toBe(0);
    expect(JSON.parse(result.cli.stdout)).toEqual(result.receipt);
    expect(result.manifest.agents.map((a: any) => a.agent)).toEqual(['a1', 'a2']);
    expect(result.manifest.problems).toEqual([]);
  });

  it.each([
    ['sessions.pop("a2")', 'population mismatch'],
    ['pathlib.Path(sessions["a2"]["file"]).unlink()', 'population mismatch'],
    ['rows.pop()', 'run did not complete'],
    ['rows[1]["error"]="task failed"', 'task coverage incomplete'],
    ['pathlib.Path(sessions["a2"]["file"]).write_text(pathlib.Path(sessions["a2"]["file"]).read_text().replace("2026-10-16T22:33:25Z","2026-10-16T22:00:00Z"))', 'task coverage incomplete'],
    ['pathlib.Path(sessions["a2"]["file"]).write_text(pathlib.Path(sessions["a2"]["file"]).read_text().replace("2026-10-16T22:33:25Z","2026-10-16T23:00:00Z"))', 'task coverage incomplete'],
    ['p=pathlib.Path(sessions["a2"]["file"]); p.write_text("".join(line+"\\n" for line in p.read_text().splitlines() if json.loads(line).get("type")!="event_msg"))', 'task coverage incomplete'],
    ['pathlib.Path(sessions["a2"]["data"]).write_text("changed task data")', 'task coverage incomplete'],
  ])('preserves a rejected partial archive for %s', (change, message) => {
    const result = archiveScenario(change);
    expect(result.receipt).toBeNull();
    expect(result.error).toContain(message);
    expect(result.manifest.problems.join(';')).toContain(message);
    expect(result.cli.exit).not.toBe(0);
  });

  it('rejects the original results-only archive shape and changed raw bytes', () => {
    const code = [
      'import importlib.util,tempfile,pathlib,tarfile,io,json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'path=pathlib.Path(tempfile.mkdtemp())/"results-only.tgz"',
      'with tarfile.open(path,"w:gz") as t:',
      ' member=tarfile.TarInfo("results.jsonl"); member.size=3; t.addfile(member,io.BytesIO(b"{}\\n"))',
      'error=None',
      'try: m.verify_native_archive(str(path),str(path.parent/"results.jsonl"))',
      'except RuntimeError as e:error=str(e)',
      'print(json.dumps({"error":error,"changed":m.native_archive_problems({"schemaVersion":"swap-tier-native-archive-v1","resultsSha256":"wrong"},{"results.jsonl":b"changed"})}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ error: 'native archive missing required population manifest', changed: ['results hash mismatch'] });
  });

  it('rejects an older complete archive when the caller supplies newer run results', () => {
    const result = archiveScenario('pass', '(out/"results.jsonl").write_text((out/"results.jsonl").read_text()+"{}\\n")');
    expect(result.receipt.verified).toBe(true);
    expect(result.cli.exit).not.toBe(0);
    expect(result.cli.stderr).toContain('belongs to different run results');
  });

  it.each(['session.jsonl', 'dummy-data.txt'])('rejects changed archived %s bytes', (suffix) => {
    const result = archiveScenario('pass', [
      'with tarfile.open(archive) as t: files={m.name:t.extractfile(m).read() for m in t.getmembers()}',
      `files["native/a1/${suffix}"]+=b"changed"`,
      'with tarfile.open(archive,"w:gz") as t:',
      ' for name,content in files.items():',
      '  member=tarfile.TarInfo(name); member.size=len(content); t.addfile(member,io.BytesIO(content))',
    ].join('\n'));
    expect(result.cli.exit).not.toBe(0);
    expect(result.cli.stderr).toContain('missing or changed');
  });
});

describe('capacity Server population preflight', () => {
  it('requests a bounded full-file digest with enough native output for any poll', () => {
    const prompt = py(DRIVER, 'm.native_hash_prompt(inp)', 'WARM-a17-3');
    expect(prompt).toContain('`sha256sum dummy-data.txt`');
    expect(prompt).toContain('max_output_tokens=512 for execution and any polling');
    expect(prompt).not.toContain('cat dummy-data.txt');
    expect(prompt).toContain('DONE-WARM-a17-3');
  });

  function population(users: number[], expected = 1003, nested = false) {
    const code = [
      'import importlib.util,json,pathlib,tempfile,types',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'root=pathlib.Path(tempfile.mkdtemp())',
      'def service(uid): return root / f"user.slice/user-{uid}.slice/user@{uid}.service/app.slice/papercusp-server.service"',
      `for uid in ${JSON.stringify(users)}:`,
      ` p=service(uid)${nested ? ' / "child"' : ''}; p.mkdir(parents=True); (p/"cgroup.procs").write_text("123\\n")`,
      'result=None; error=None',
      `try: result=m.server_population(str(service(${expected})), str(root))`,
      'except RuntimeError as e: error=str(e)',
      'print(json.dumps({"result":result,"error":error}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  }

  it('accepts exactly the intended live service, including a child-only process', () => {
    for (const nested of [false, true]) {
      expect(population([1003], 1003, nested)).toMatchObject({ result: { count: 1 }, error: null });
    }
  });

  it.each([{ users: [] }, { users: [1001] }, { users: [1001, 1003] }])('rejects missing, wrong or extra services: %j', ({ users }) => {
    const result = population(users);
    expect(result.result).toBeNull();
    expect(result.error).toContain('server population mismatch');
  });

  it('runs the population check before creating probes or launching native agents', () => {
    const code = [
      'import importlib.util,json,tempfile,types',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'calls=[]',
      'm.Recorder=lambda *args: calls.append("recorder")',
      'm.subprocess.Popen=lambda *args, **kw: calls.append("probe")',
      'm.stop_agents=lambda: calls.append("stop")',
      'error=None',
      'try: m.run(types.SimpleNamespace(server_cgroup="/missing"))',
      'except RuntimeError as e: error=str(e)',
      'print(json.dumps({"calls":calls,"error":error}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ calls: [], error: expect.stringContaining('server population mismatch') });
  });
});

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

  it('records a native route failure without substituting a monitoring request', () => {
    const code = [
      'import importlib.util, json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'clock=[0]; typed=[]; m.REAL_MODEL=True; m.CODEX_SESSIONS={"a1":{}}',
      'm.time.time=lambda:clock[0]; m.time.sleep=lambda *a:clock.__setitem__(0,clock[0]+1)',
      'm.type_text=lambda *args: typed.append(args); m.press_enter=lambda *a:None; m.pane=lambda *a:"MARKER"',
      'def failed(*a): raise m.NativeTaskError("native model route disconnected")',
      'm.codex_completed=failed',
      'state=m.prompt_all(["a1"],lambda n:"MARKER",lambda n:"dummy",10)',
      'print(json.dumps({"state":state,"typed":typed}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.state.a1.error).toBe('native model route disconnected');
    expect(receipt.state.a1.tDone).toBeNull();
    expect(receipt.typed).toEqual([['a1', 'dummy']]);
  });

  it.each(['native-complete', 'native-error', 'stub'])('avoids unused terminal captures after submission: %s', (mode) => {
    const code = [
      'import importlib.util, json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      `mode=${JSON.stringify(mode)}`,
      'clock=[0]; submitted=set(); captures=[]; polls=[]; typed=[]',
      'm.REAL_MODEL=mode!="stub"; m.CODEX_SESSIONS={"a1":{}}',
      'm.time.time=lambda:clock[0]; m.time.sleep=lambda *a:clock.__setitem__(0,clock[0]+1)',
      'm.type_text=lambda *a:typed.append(a); m.press_enter=lambda n:submitted.add(n)',
      'def pane(n):',
      ' captures.append({"agent":n,"submitted":n in submitted})',
      ' return "MARKER DONE-MARKER"',
      'def completed(n, marker):',
      ' polls.append([n,marker])',
      ' if mode=="native-error": raise m.NativeTaskError("native failure")',
      ' return len(polls)>=2',
      'm.pane=pane; m.codex_completed=completed',
      'state=m.prompt_all(["a1"],lambda n:"MARKER",lambda n:"dummy",10)',
      'print(json.dumps({"state":state,"captures":captures,"polls":polls,"typed":typed}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.typed).toEqual([['a1', 'dummy']]);
    expect(receipt.captures).toEqual(mode === 'stub'
      ? [{ agent: 'a1', submitted: false }, { agent: 'a1', submitted: true }]
      : [{ agent: 'a1', submitted: false }]);
    if (mode === 'native-error') {
      expect(receipt.state.a1).toMatchObject({ tDone: null, error: 'native failure' });
      expect(receipt.polls).toHaveLength(1);
    } else {
      expect(receipt.state.a1).toMatchObject({ tDone: mode === 'stub' ? 1 : 2, error: null });
      expect(receipt.polls).toHaveLength(mode === 'stub' ? 0 : 2);
    }
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

  it('lets a native batch complete when an auxiliary health request would time out', () => {
    const code = [
      'import importlib.util, json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'checks=[]; clock=[0]',
      'def check():',
      ' checks.append(1)',
      ' raise RuntimeError("health endpoint timed out while native task was completing")',
      'def tick(*a): clock[0]+=20',
      'm.GATEWAY_CHECK=check; m.time.time=lambda:clock[0]; m.time.monotonic=lambda:clock[0]; m.time.sleep=tick',
      'm.type_text=lambda *a:None; m.press_enter=lambda *a:None; m.pane=lambda *a:"MARKER DONE-MARKER"',
      'state=m.prompt_all(["a1"],lambda n:"MARKER",lambda n:"dummy",100)',
      'print(json.dumps({"checks":len(checks),"state":state}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.checks).toBe(0);
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
      'evidence=m.check_codex_terminal("a4", types.SimpleNamespace(rec=lambda kind, **kw: rows.append({"kind":kind, **kw})))',
      'print(json.dumps({"evidence":evidence,"rows":rows}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.rows).toEqual([{ kind: 'startup-failed', agent: 'a4', state: '1 101', stderr: '', pane: 'native runtime failed to create a worker', dead: true, inspectionFailed: false }]);
    expect(receipt.evidence).toMatchObject({ agent: 'a4', dead: true, inspectionFailed: false, state: '1 101', pane: 'native runtime failed to create a worker' });
  });

  it('captures every failed pane plus remaining cohort evidence before aborting startup', () => {
    const code = [
      'import importlib.util, types, json, io',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'clock=[100.0]; rows=[]',
      'm.os.makedirs=lambda *a, **kw: None',
      'm.open=lambda p, mode="r", **kw: io.BytesIO(b"fixture") if "b" in mode else io.StringIO()',
      'm.sh=lambda argv, **kw: (types.SimpleNamespace(returncode=0, stdout="1 101", stderr="") if "display-message" in argv and argv[argv.index("-t")+1] in ("a1","a2") else types.SimpleNamespace(returncode=0, stdout="0 0", stderr=""))',
      'm.time.sleep=lambda seconds: clock.__setitem__(0, clock[0]+seconds)',
      'm.time.time=lambda: clock[0]',
      'm.LAUNCH_DELAY_SEC=0',
      'm.pane=lambda name: "native worker creation failed" if name in ("a1","a2") else ("still booting" if name=="a3" else "READY")',
      'm.codex_ready=lambda text, model: text=="READY"',
      'm.sh=lambda argv, **kw: (commands.append(argv) or (types.SimpleNamespace(returncode=0, stdout="1 101", stderr="") if "display-message" in argv and argv[argv.index("-t")+1] in ("a1","a2") else types.SimpleNamespace(returncode=0, stdout="0 0", stderr="")))',
      'commands=[]',
      'try: m.start_codex_agents(4,"agent",types.SimpleNamespace(rec=lambda kind, **kw: rows.append({"kind":kind, **kw})),"gpt-6-luna","low","http://127.0.0.1:18788/v1","test-owner")',
      'except RuntimeError as e: print(json.dumps({"error":str(e),"rows":rows,"clock":clock[0]}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.error).toContain('2 terminal(s) exited');
    expect(receipt.error).toContain('Per-terminal status and pane evidence recorded');
    expect(receipt.clock).toBeLessThan(110);
    expect(receipt.rows.filter((row: any) => row.kind === 'startup-failed')).toEqual([
      expect.objectContaining({ agent: 'a1', state: '1 101', pane: 'native worker creation failed', dead: true }),
      expect.objectContaining({ agent: 'a2', state: '1 101', pane: 'native worker creation failed', dead: true }),
    ]);
    expect(receipt.rows).toContainEqual(expect.objectContaining({
      kind: 'startup-aborted', agent: 'a3', state: '0 0', pane: 'still booting',
      reason: 'sibling-terminal-failed-before-cohort-readiness',
    }));
    expect(receipt.rows.some((row: any) => row.kind === 'agents-started')).toBe(false);
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

describe('minimum-resource active cohorts', () => {
  it('runs bounded native tool cohorts while retaining fifty assigned agents and a separate fifty-agent burst', () => {
    const code = [
      'import importlib.util, types, json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'calls=[]; rows=[]; m.REAL_MODEL=True',
      'm.host_stats=lambda: {}; m.agent_stats=lambda n: {}',
      'm.time.sleep=lambda *a: None; m.reclaim=lambda n: 0; m.write=lambda *a: None',
      'def forbidden(*a): raise RuntimeError("swap must stay enabled around a live low-RAM cohort")',
      'm.swap_off=forbidden; m.swap_on=forbidden',
      'def prompt(names, marker, task, *a, **kw):',
      ' calls.append({"names":list(names),"markers":[marker(n) for n in names],"tasks":[task(n) for n in names]})',
      ' return {n:{"t0":1,"tEcho":2,"tEnter":2,"tDone":3,"error":None} for n in names}',
      'm.prompt_all=prompt; m.stub_request_times=lambda *a: None',
      'm.run_arm({"name":"zram","kind":"zram"},[f"a{i}" for i in range(50)],0,4,types.SimpleNamespace(rec=lambda k,**kw:rows.append({"kind":k,**kw})),"absent",active=[1,5,10],active_rounds=2,swap_ready=True,keep_swap=True)',
      'print(json.dumps({"calls":calls,"phases":[r["phase"] for r in rows if r["kind"]=="phase" and r["edge"]=="start"]}))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const receipt = JSON.parse(result.stdout);
    expect(receipt.calls.map((c: any) => c.names.length)).toEqual([1, 1, 5, 5, 10, 10, 50]);
    expect(receipt.calls.at(-1).names).toHaveLength(50);
    const activeCalls = receipt.calls.slice(0, -1);
    const markers = activeCalls.flatMap((c: any) => c.markers);
    expect(new Set(markers).size).toBe(markers.length);
    for (const call of activeCalls) {
      expect(call.markers.every((m: string) => m.startsWith('WARM-'))).toBe(true);
      expect(call.tasks.every((t: string) => t.includes('sha256sum dummy-data.txt'))).toBe(true);
    }
    expect(receipt.calls.at(-1).tasks.every((t: string) => t.includes('sha256sum dummy-data.txt'))).toBe(true);
    expect(receipt.phases).toEqual(['reclaim', 'idle', 'active-1', 'active-1', 'active-5', 'active-5', 'active-10', 'active-10', 'storm']);
  });

  it.each([
    ['--active', '0'], ['--active', '51'], ['--active', '1', '--active-rounds', '0'],
    ['--active', '1', '--arm', 'none'], ['--active', '1', '--single', '1'],
    ['--active', '1', '--cli', 'claude'], ['--active', '1', '--warm', '0'],
    ['--active', '1', '--active', '1'],
    ['--active', '1', '--arm', 'pd-balanced-batch5=/dev/test'],
  ])('refuses invalid active-cohort options before launching: %j', (...extra) => {
    const code = [
      'import importlib.util',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'm.run=lambda a: (_ for _ in ()).throw(RuntimeError("UNSAFE_LAUNCH"))',
      `m.main(${JSON.stringify(['run', '--out', '/unused', '--agents', '50', '--single', '0', '--cli', 'codex', '--arm', 'zram', ...extra])})`,
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('active cohort');
    expect(result.stderr).not.toContain('UNSAFE_LAUNCH');
  });

  it.each([false, true])('preserves provisioned swap on active startup and cleanup, including failure=%s', (fail) => {
    const code = [
      'import importlib.util, types, json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'events=[]; m.Recorder=lambda *a: types.SimpleNamespace(rec=lambda *a, **kw: None)',
      'm.subprocess.Popen=lambda *a, **kw: types.SimpleNamespace(terminate=lambda:None)',
      'm.time.sleep=lambda *a:None; m.host_stats=lambda:{}; m.report=lambda *a:None',
      'm.stop_agents=lambda:events.append("stop"); m.swap_off=lambda:events.append("swapoff")',
      'm.archive_native_evidence=lambda *a: events.append("archive") or {"verified":True}',
      'm.swap_on=lambda *a:events.append("swapon")',
      'm.active_swap=lambda *a:events.append("validate-swap") or {"device":"/dev/zram0","devices":[]}',
      'm.gateway_preflight=lambda *a, **kw:None; m.codex_sandbox_preflight=lambda *a:None',
      'm.start_agents=lambda *a:events.append("start") or ["a1"]',
      fail ? 'm.warm=lambda *a: (_ for _ in ()).throw(RuntimeError("warm failed"))' : 'm.warm=lambda *a:events.append("warm")',
      'm.run_arm=lambda *a, **kw:events.append({"arm":kw})',
      'try: m.main(["run","--out","/unused","--agents","50","--single","0","--arm","zram","--cli","codex","--active","1"])',
      'except RuntimeError: pass',
      'print("EVENTS="+json.dumps(events))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const events = JSON.parse(result.stdout.split('EVENTS=')[1]);
    expect(events).toEqual(fail ? ['validate-swap', 'stop', 'start', 'stop', 'validate-swap', 'archive'] : ['validate-swap', 'stop', 'start', 'warm', {
      arm: { active: [1], active_rounds: 3, swap_ready: true, keep_swap: true },
    }, 'stop', 'validate-swap', 'archive']);
  });

  it.each([
    { devices: [], arm: 'zram:lz4', algorithm: '[lz4] zstd', ok: false },
    { devices: [{ name: '/dev/zram0', size: 4 * 2 ** 30 - 4096 }], arm: 'zram:lz4', algorithm: '[lz4] zstd', ok: true },
    { devices: [{ name: '/dev/zram0', size: 2 * 2 ** 30 }], arm: 'zram:lz4', algorithm: '[lz4] zstd', ok: false },
    { devices: [{ name: '/dev/zram0', size: 4 * 2 ** 30 }], arm: 'zram:lz4', algorithm: 'lz4 [zstd]', ok: false },
    { devices: [{ name: '/dev/zram0', size: 4 * 2 ** 30 }, { name: '/swapfile', size: 8 * 2 ** 30 }], arm: 'zram:lz4', algorithm: '[lz4] zstd', ok: true },
    { devices: [{ name: '/swapfile', size: 8 * 2 ** 30 }], arm: 'none', algorithm: '', ok: false },
    { devices: [], arm: 'none', algorithm: '', ok: true },
    { devices: [{ name: '/swapfile', size: 8 * 2 ** 30 }], arm: 'overflow=/swapfile', algorithm: '', ok: true },
    { devices: [{ name: '/swapfile', size: 8 * 2 ** 30 }], arm: 'overflow=/other', algorithm: '', ok: false },
  ])('validates provisioned active swap without mutation: $arm $ok $devices', ({ devices, arm, algorithm, ok }) => {
    const code = [
      'import importlib.util,types,json,io',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      `devices=json.loads(${JSON.stringify(JSON.stringify(devices))})`,
      'm.configured_swap_devices=lambda:devices',
      'm.sh=lambda *a: (_ for _ in ()).throw(AssertionError("unexpected swap command"))',
      `m.open=lambda *a:io.StringIO(${JSON.stringify(algorithm)})`,
      `try: result=m.active_swap(m.parse_arm(${JSON.stringify(arm)}),4); print(json.dumps({"ok":True,"result":result}))`,
      'except RuntimeError as e: print(json.dumps({"ok":False,"error":str(e)}))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(ok);
  });

  it('refuses absent configured swap before opening output, probes, or touching agents', () => {
    const code = [
      'import importlib.util,types',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      'def forbidden(*a, **kw): raise AssertionError("unexpected mutation")',
      'm.Recorder=forbidden; m.stop_agents=forbidden; m.subprocess.Popen=forbidden',
      'm.configured_swap_devices=lambda:[]',
      'try: m.main(["run","--out","/unused","--agents","50","--single","0","--arm","zram","--cli","codex","--active","1"])',
      'except RuntimeError as e: print(str(e))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('must be configured before');
  });

  it('reads kernel swap sizes in bytes and escaped paths without a swapon subprocess', () => {
    const fixture = 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition 4194300 0 100\n/swap\\040file file 8388608 12 -2\n';
    const code = [
      'import importlib.util,io,json',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      `m.open=lambda path:io.StringIO(${JSON.stringify(fixture)})`,
      'm.sh=lambda *a: (_ for _ in ()).throw(AssertionError("swapon JSON unsupported"))',
      'print(json.dumps(m.configured_swap_devices()))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { name: '/dev/zram0', size: 4 * 2 ** 30 - 4096, prio: 100 },
      { name: '/swap file', size: 8 * 2 ** 30, prio: -2 },
    ]);
  });

  it.each(['', 'Filename Type Size Used Priority\ninvalid\n'])('fails closed on an unreadable kernel swap inventory: %j', (fixture) => {
    const code = [
      'import importlib.util,io',
      `s=importlib.util.spec_from_file_location("m", ${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s); s.loader.exec_module(m)',
      `m.open=lambda path:io.StringIO(${JSON.stringify(fixture)})`,
      'm.configured_swap_devices()',
    ].join('\n');
    const r = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('invalid kernel swap inventory');
  });
});

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

  it('reduces repeated active windows together without counting repeated tasks as distinct agents', () => {
    const active = [
      { t: 1, kind: 'arm-start', arm: 'zram' },
      { t: 10, kind: 'phase', arm: 'zram', phase: 'active-1', edge: 'start' },
      { t: 12, kind: 'phase', arm: 'zram', phase: 'active-1', edge: 'end' },
      { t: 13, kind: 'wake', arm: 'zram', phase: 'active-1', agent: 'a1', t0: 10, tEcho: 10.5, tEnter: 10.5, tDone: 11, pre: st(0, 0), post: st(0, 0) },
      { t: 20, kind: 'phase', arm: 'zram', phase: 'active-1', edge: 'start' },
      { t: 22, kind: 'phase', arm: 'zram', phase: 'active-1', edge: 'end' },
      { t: 23, kind: 'wake', arm: 'zram', phase: 'active-1', agent: 'a1', t0: 20, tEcho: 21, tEnter: 21, tDone: null, pre: st(0, 0), post: st(0, 0) },
    ];
    const [summary] = py(DRIVER, 'm.summarize(inp["rows"], inp["probe"])', { rows: active, probe: [[11, 100, 0], [15, 999, 0], [21, 2, 0]] });
    expect(summary['active-1']).toMatchObject({ agents: 1, tasks: 2, failed: 1,
      totalSec: { p95: 1 }, echoSec: { p95: 1 }, probeExecMs: { samples: 2, max: 100 } });
  });
});

describe('frozen D075 native workload detector', () => {
  function fixture() {
    const names = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const host = { oom_kill: 0, pgmajfault: 10, pswpin: 20, pswpout: 30 };
    const agents = Object.fromEntries(names.map(n => [n, {}]));
    const rows: any[] = [
      { t: 1, kind: 'run-start', agents: 50, cli: 'codex', inference: 'real', model: 'gpt-6-luna', effort: 'low', single: 0, active: [1, 5, 10], activeRounds: 3, arms: [{ name: 'zram' }], host },
      { t: 2, kind: 'arm-start', arm: 'zram', assignedAgents: 50, agents },
    ];
    const probe: number[][] = [];
    let time = 10;
    for (const [phase, width, rounds] of [['active-1', 1, 3], ['active-5', 5, 3], ['active-10', 10, 3], ['storm', 50, 1]] as const) {
      for (let round = 0; round < rounds; round++) {
        rows.push({ t: time, kind: 'phase', arm: 'zram', phase, edge: 'start' });
        probe.push([time + 2, 100, 0]);
        rows.push(...names.slice(0, width).map(agent => ({ t: time + 31, kind: 'wake', arm: 'zram', phase,
          agent, assignedAgents: 50, concurrentAgents: width, nativeToolVerified: true,
          t0: time, tEcho: time + 1, tEnter: time + 1, tDone: time + 30 })));
        rows.push({ t: time + 30, kind: 'phase', arm: 'zram', phase, edge: 'end' });
        time += 40;
      }
    }
    rows.push({ t: time, kind: 'arm-end', arm: 'zram', agents, host: { ...host } }, { t: time + 1, kind: 'run-end' });
    return { rows, probe };
  }
  const detect = (input: ReturnType<typeof fixture>) => py(DRIVER, 'm.evaluate_native_workload(inp["rows"], inp["probe"])', input);

  it('accepts exact populations and boundary thresholds without qualifying a VM', () => {
    expect(detect(fixture())).toMatchObject({ status: 'pass', scope: 'D075-native-workload-only', qualification: 'not-evaluated', gaps: [], failures: [] });
  });
  it.each([
    ['rounded echo', (x: any) => { for (const r of x.rows.filter((r: any) => r.kind === 'wake' && r.phase === 'active-1')) { r.tEcho = r.t0 + 1.0004; r.tEnter = r.tEcho; } }, 'fail'],
    ['shell time substituted', (x: any) => { for (const r of x.rows.filter((r: any) => r.kind === 'wake' && r.phase === 'active-1')) r.tDone = r.t0 + 31; }, 'fail'],
    ['native task failure', (x: any) => { x.rows.find((r: any) => r.kind === 'wake').nativeToolVerified = false; }, 'fail'],
    ['slow host exec', (x: any) => { x.probe[0][1] = 100.0001; }, 'fail'],
    ['slow burst echo', (x: any) => { x.rows.filter((r: any) => r.kind === 'wake' && r.phase === 'storm').forEach((r: any) => { r.tEcho = r.t0 + 3.0001; r.tEnter = r.tEcho; }); }, 'fail'],
    ['burst settling deadline', (x: any) => { x.rows.filter((r: any) => r.kind === 'wake' && r.phase === 'storm').forEach((r: any) => { r.tDone = r.t0 + 120.0001; }); }, 'fail'],
    ['OOM', (x: any) => { x.rows.find((r: any) => r.kind === 'arm-end').host.oom_kill = 1; }, 'fail'],
    ['unknown OOM counter', (x: any) => { delete x.rows.find((r: any) => r.kind === 'arm-end').host.oom_kill; }, 'unknown'],
    ['batched burst', (x: any) => { x.rows.filter((r: any) => r.phase === 'storm' && r.kind === 'wake').forEach((r: any) => r.concurrentAgents = 10); }, 'unknown'],
    ['padded repeated agent', (x: any) => { x.rows.filter((r: any) => r.phase === 'active-5' && r.kind === 'wake')[1].agent = 'a0'; }, 'unknown'],
    ['missing round probe', (x: any) => { x.probe.shift(); }, 'unknown'],
    ['sparse task population', (x: any) => { x.rows.splice(x.rows.findIndex((r: any) => r.kind === 'wake'), 1); }, 'unknown'],
    ['counter reset', (x: any) => { x.rows.find((r: any) => r.kind === 'arm-end').host.pswpin = 0; }, 'unknown'],
    ['missing arm config', (x: any) => { x.rows[0].arms = []; }, 'fail'],
    ['unrelated extra phase', (x: any) => { x.rows.push({ ...x.rows.find((r: any) => r.kind === 'wake'), phase: 'single' }); }, 'unknown'],
  ])('rejects %s', (_name, mutate, status) => {
    const input = fixture(); mutate(input);
    expect(detect(input).status).toBe(status);
  });
  it('CLI refuses absent and truncated raw evidence without a passing receipt', () => {
    const code = [
      'import tempfile,pathlib,subprocess,sys,json',
      'with tempfile.TemporaryDirectory() as root:',
      ` first=subprocess.run([sys.executable,${JSON.stringify(DRIVER)},"evaluate-workload","--out",root],capture_output=True,text=True)`,
      ' pathlib.Path(root,"results.jsonl").write_text("{truncated")',
      ` second=subprocess.run([sys.executable,${JSON.stringify(DRIVER)},"evaluate-workload","--out",root],capture_output=True,text=True)`,
      ' print(json.dumps([{"exit":r.returncode,"receipt":json.loads(r.stdout)} for r in [first,second]]))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    for (const row of JSON.parse(result.stdout)) expect(row).toMatchObject({ exit: 2, receipt: { status: 'unknown', qualification: 'not-evaluated' } });
  });

  function qualificationFixture() {
    const input = fixture();
    const identity = { runId: 'trial-1', provider: 'gcp', projectOrAccount: 'test-project', zone: 'us-central1-a',
      instanceId: 'vm-1', profile: '2cpu8g', customerWorkspaceId: 'customer-1', candidateSha: 'a'.repeat(40), artifactSha256: 'b'.repeat(64), model: 'gpt-6-luna', effort: 'low' };
    input.rows[0].identity = identity;
    input.rows.unshift({ t: 0.1, kind: 'server-population-preflight', count: 1, expected: '/server', active: ['/server'] },
      { t: 0.2, kind: 'active-swap-preflight', device: '/dev/zram0', devices: [{ name: '/dev/zram0' }] });
    input.rows.push({ t: input.rows.at(-1).t + 1, kind: 'active-swap-postflight', device: '/dev/zram0', devices: [{ name: '/dev/zram0' }] });
    const operations = ['cold-wake', 'grow', 'resize', 'reconnect'];
    const evidence: any = { schemaVersion: 'swap-tier-qualification-v1', identity,
      sources: Object.fromEntries(['provider-inventory', 'footprint', ...operations, 'teardown'].map(k => [k, { path: `${k}.json`, sha256: 'c'.repeat(64) }])),
      providerInventory: { identity, market: 'on-demand', customerWorkspaces: ['customer-1'] },
      footprint: { identity, serverProcesses: 1, measuredAt: 0, dbBytes: 100, repositoryBytes: 200, activeHours: 1, freshInstall: true },
      lifecycle: operations.map(kind => ({ kind, identity, requestedAt: 1000, readyAt: 1120,
        health: { ok: true, service: 'papercusp-operator', sha: identity.candidateSha },
        witnessBefore: { created: true, manifestSha256: 'd'.repeat(64), files: 2 },
        witnessAfter: { verified: true, sqlReadOnly: true, manifestSha256: 'd'.repeat(64), files: 2 } })),
      teardown: { identity, runId: identity.runId, deleted: ['vm-1'], remainingInstances: [], orphanDisks: [], verified: true } };
    return { ...input, evidence, expectedSha: identity.candidateSha, expectedArtifact: identity.artifactSha256 };
  }
  const qualify = (input: ReturnType<typeof qualificationFixture>) => py(DRIVER,
    'm.evaluate_native_qualification(inp["rows"], inp["probe"], inp["evidence"], inp["expectedSha"], inp["expectedArtifact"])', input);

  it('composes complete observations while retaining independent review authority', () => {
    expect(qualify(qualificationFixture())).toMatchObject({ status: 'pass', qualification: 'independent-review-required', gaps: [], failures: [] });
  });
  it.each([
    ['foreign candidate', (x: any) => { x.expectedSha = 'e'.repeat(40); }],
    ['foreign artifact', (x: any) => { x.expectedArtifact = 'e'.repeat(64); }],
    ['foreign run', (x: any) => { x.rows.find((r: any) => r.kind === 'run-start').identity = { ...x.evidence.identity, runId: 'other' }; }],
    ['changed frozen model', (x: any) => { x.rows.find((r: any) => r.kind === 'run-start').model = 'other'; }],
    ['changed frozen effort', (x: any) => { x.rows.find((r: any) => r.kind === 'run-start').effort = 'high'; }],
    ['missing source category', (x: any) => { delete x.evidence.sources.grow; }],
    ['unhashed source', (x: any) => { x.evidence.sources.grow.sha256 = null; }],
    ['spot substituted', (x: any) => { x.evidence.providerInventory.market = 'spot'; }],
    ['foreign tenant', (x: any) => { x.evidence.providerInventory.customerWorkspaces.push('other'); }],
    ['unmeasured footprint', (x: any) => { delete x.evidence.footprint.dbBytes; }],
    ['foreign footprint identity', (x: any) => { x.evidence.footprint.identity = { ...x.evidence.identity, instanceId: 'other' }; }],
    ['boolean process count', (x: any) => { x.evidence.footprint.serverProcesses = true; }],
    ['missing active hours', (x: any) => { x.evidence.footprint.activeHours = 0; }],
    ['active hours shorter than measured run', (x: any) => { x.evidence.footprint.activeHours = 0.001; }],
    ['footprint from after launch', (x: any) => { x.evidence.footprint.measuredAt = 2; }],
    ['wrong native population', (x: any) => { x.rows.find((r: any) => r.kind === 'server-population-preflight').active.push('/other'); }],
    ['swap absent at shutdown', (x: any) => { x.rows.pop(); }],
    ['swap changed at shutdown', (x: any) => { x.rows.at(-1).device = '/other'; }],
    ['swap checked before shutdown', (x: any) => { x.rows.at(-1).t = 2; }],
    ['missing lifecycle operation', (x: any) => { x.evidence.lifecycle.pop(); }],
    ['duplicate lifecycle operation', (x: any) => { x.evidence.lifecycle[1] = x.evidence.lifecycle[0]; }],
    ['readiness from another candidate', (x: any) => { x.evidence.lifecycle[0].health.sha = 'e'.repeat(40); }],
    ['HTML availability', (x: any) => { x.evidence.lifecycle[0].health = '<html>SPA</html>'; }],
    ['reversed clock', (x: any) => { x.evidence.lifecycle[0].readyAt = 999; }],
    ['changed acknowledged data', (x: any) => { x.evidence.lifecycle[0].witnessAfter.manifestSha256 = 'e'.repeat(64); }],
    ['writable SQL probe', (x: any) => { x.evidence.lifecycle[0].witnessAfter.sqlReadOnly = false; }],
    ['missing file witness', (x: any) => { x.evidence.lifecycle[0].witnessBefore.files = 0; }],
    ['boolean retained file count', (x: any) => { x.evidence.lifecycle[0].witnessBefore.files = 1; x.evidence.lifecycle[0].witnessAfter.files = true; }],
    ['foreign teardown', (x: any) => { x.evidence.teardown.runId = 'other'; }],
    ['unbound teardown identity', (x: any) => { delete x.evidence.teardown.identity; }],
    ['same-named VM deleted in another project', (x: any) => { x.evidence.teardown.identity = { ...x.evidence.identity, projectOrAccount: 'other-project' }; }],
    ['undeleted instance', (x: any) => { x.evidence.teardown.remainingInstances.push('vm-1'); }],
    ['orphan disk', (x: any) => { x.evidence.teardown.orphanDisks.push('disk-1'); }],
  ])('keeps %s unknown', (_name, mutate) => {
    const input = qualificationFixture(); mutate(input);
    expect(qualify(input).status).toBe('unknown');
  });
  it('enforces the raw cold-ready boundary and retains workload failures', () => {
    const input = qualificationFixture(); input.evidence.lifecycle[0].readyAt += 0.0001;
    expect(qualify(input)).toMatchObject({ status: 'fail', failures: ['cold-wake:application-ready'] });
    input.evidence.lifecycle[0].readyAt = 1120;
    input.rows.find((r: any) => r.kind === 'arm-end').host.oom_kill = 1;
    expect(qualify(input)).toMatchObject({ status: 'fail', failures: ['oom'] });
  });
  it('never treats an inline passing dossier as retained archive/source proof', () => {
    const input = qualificationFixture();
    const code = [
      'import importlib.util,json,tempfile,pathlib,sys',
      `s=importlib.util.spec_from_file_location("m",${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);x=json.load(sys.stdin)',
      'with tempfile.TemporaryDirectory() as d:',
      ' p=pathlib.Path(d);(p/"dossier.json").write_text(json.dumps(x["evidence"]))',
      ' (p/"results.jsonl").write_text("\\n".join(json.dumps(r) for r in x["rows"]))',
      ' (p/"probe.csv").write_text("\\n".join(",".join(str(v) for v in r) for r in x["probe"]))',
      ' out=m.read_native_qualification(d,str(p/"dossier.json"),x["expectedSha"],x["expectedArtifact"])',
      ' print(json.dumps(out))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { input: JSON.stringify(input), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'unknown', qualification: 'independent-review-required' });
  });
  it('rechecks an actual 50-history archive and every hashed source through the CLI', () => {
    const input = qualificationFixture();
    const code = [
      'import importlib.util,json,tempfile,pathlib,sys,hashlib,subprocess',
      `s=importlib.util.spec_from_file_location("m",${JSON.stringify(DRIVER)})`,
      'm=importlib.util.module_from_spec(s);s.loader.exec_module(m);x=json.load(sys.stdin)',
      'def digest(p):return hashlib.sha256(p.read_bytes()).hexdigest()',
      'with tempfile.TemporaryDirectory() as d:',
      ' p=pathlib.Path(d);e=x["evidence"];rows=x["rows"];sessions={}',
      ' for row in rows:',
      '  if isinstance(row.get("agents"),dict):row["agents"]={"a"+str(int(k[1:])+1):v for k,v in row["agents"].items()}',
      '  if "agent" in row:row["agent"]="a"+str(int(row["agent"][1:])+1)',
      ' next(r for r in rows if r["kind"]=="run-start")["warm"]=1',
      ' for i in range(1,51):',
      '  name="a"+str(i);data=p/(name+".txt");data.write_text(name);sha=digest(data);history=[]',
      '  count=1+sum(r.get("kind")=="wake" and r.get("agent")==name for r in rows)',
      '  for n in range(count):',
      '   marker="WARM-"+name+"-"+str(n)',
      '   payloads=[{"role":"user","content":[{"text":marker}]},{"type":"function_call_output","output":sha},{"role":"assistant","phase":"final_answer","content":[{"type":"output_text","text":"DONE-"+marker}]},{"type":"task_complete"}]',
      '   history.extend({"timestamp":"1970-01-01T00:00:02Z","type":"event_msg" if z==3 else "response_item","payload":v} for z,v in enumerate(payloads))',
      '  path=p/(name+".jsonl");path.write_text("\\n".join(json.dumps(r) for r in history));sessions[name]={"file":str(path),"data":str(data)}',
      ' (p/"results.jsonl").write_text("\\n".join(json.dumps(r) for r in rows))',
      ' (p/"probe.csv").write_text("\\n".join(",".join(str(v) for v in r) for r in x["probe"]))',
      ' e["resultsSha256"]=digest(p/"results.jsonl");e["probeSha256"]=digest(p/"probe.csv")',
      ' e["archiveSha256"]=m.archive_native_evidence(d,sessions)["archiveSha256"]',
      ' for kind,ref in e["sources"].items():',
      '  value=e["providerInventory"] if kind=="provider-inventory" else e["footprint"] if kind=="footprint" else e["teardown"] if kind=="teardown" else next(o for o in e["lifecycle"] if o["kind"]==kind)',
      '  path=p/ref["path"];path.write_text(json.dumps(value));ref["sha256"]=digest(path)',
      ' dossier=p/"dossier.json";dossier.write_text(json.dumps(e));out=[]',
      ' def check(label):',
      `  r=subprocess.run([sys.executable,${JSON.stringify(DRIVER)},"evaluate-workload","--out",d,"--qualification",str(dossier),"--expected-sha",x["expectedSha"],"--expected-artifact-sha256",x["expectedArtifact"]],capture_output=True,text=True)`,
      '  out.append({"label":label,"exit":r.returncode,"result":json.loads(r.stdout)})',
      ' check("complete")',
      ' source=p/e["sources"]["footprint"]["path"];raw=source.read_bytes();source.write_bytes(raw+b" ");check("changed-source");source.write_bytes(raw)',
      ' e["footprint"]["repositoryBytes"]+=1;dossier.write_text(json.dumps(e));check("inline-mismatch");e["footprint"]["repositoryBytes"]-=1;dossier.write_text(json.dumps(e))',
      ' source.unlink();check("missing-source");source.write_bytes(raw)',
      ' raw=(p/"probe.csv").read_bytes();(p/"probe.csv").write_bytes(raw+b"\\nmalformed");check("malformed-probe");(p/"probe.csv").write_bytes(raw)',
      ' raw=(p/"native-evidence.tar.gz").read_bytes();(p/"native-evidence.tar.gz").write_bytes(b"broken");check("broken-archive");(p/"native-evidence.tar.gz").write_bytes(raw)',
      ' raw=(p/"results.jsonl").read_bytes();(p/"results.jsonl").write_bytes(raw+b"\\n{}");check("foreign-results");(p/"results.jsonl").write_bytes(raw)',
      ' dossier.write_text("{truncated");check("truncated-dossier")',
      ' print(json.dumps(out))',
    ].join('\n');
    const result = spawnSync('python3', ['-c', code], { input: JSON.stringify(input), encoding: 'utf8', timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    const [passing, ...refused] = JSON.parse(result.stdout);
    expect(passing).toMatchObject({ label: 'complete', exit: 0, result: { status: 'pass', qualification: 'independent-review-required' } });
    expect(refused.map((row: any) => row.label)).toEqual(['changed-source', 'inline-mismatch', 'missing-source', 'malformed-probe', 'broken-archive', 'foreign-results', 'truncated-dossier']);
    for (const row of refused) expect(row, row.label).toMatchObject({ exit: 2, result: { status: 'unknown' } });
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
