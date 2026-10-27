import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('retained search baseline edition custody',()=>{
  it('requires every pin, safe table counts, fresh output and immutable execution source',()=>{
    const driver=fileURLToPath(new URL('../../../../../scripts/backup/search-bench/run-retained-baseline.py',import.meta.url));
    const result=execFileSync('python3',['-B','-c',[
      'import importlib.util,json,tempfile,pathlib,hashlib,sys',
      'spec=importlib.util.spec_from_file_location("baseline",sys.argv[1]); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
      'with tempfile.TemporaryDirectory() as root:',
      ' p=pathlib.Path(root); f=p/"input.json";f.write_text("{}")',
      ' pin={"path":str(f),"sha256":hashlib.sha256(f.read_bytes()).hexdigest()}',
      ' fixture={"exitCode":1,"executed":3,**{k:{"path":str(f)+suffix,"sha256":pin["sha256"]} for k,suffix in {"artifact":"","declaration":".declaration.json","attempts":".attempts.jsonl","ledger":".ledger.json"}.items()}}',
      ' plan={"schemaVersion":2,"workItemId":"WI-fixture","expectedCounts":{"session_turns":0},"outputDirectory":str(p/"new"),"protocolFixture":fixture,**{k:pin for k in ["consumption","schema","queries","configuration"]}}',
      ' m.validate_plan(plan);assert m.pinned(pin)=={}',
      ' rejected=[]',
      ' for key in ["consumption","schema","queries","configuration"]:',
      '  altered={**plan};del altered[key]',
      '  try:m.validate_plan(altered)',
      '  except ValueError:rejected.append(key)',
      ' for label,changes in [("existing",{"outputDirectory":root}),("relative",{"outputDirectory":"relative"}),("negative",{"expectedCounts":{"t":-1}}),("unsafe",{"expectedCounts":{"t;drop":0}})]:',
      '  try:m.validate_plan({**plan,**changes})',
      '  except ValueError:rejected.append(label)',
      ' for key in ["artifact","declaration","attempts","ledger","exitCode","executed"]:',
      '  altered={**plan,"protocolFixture":{k:v for k,v in fixture.items() if k!=key}}',
      '  try:m.validate_plan(altered)',
      '  except ValueError:rejected.append(key)',
      ' for label,changes in [("old-edition",{"schemaVersion":1}),("wrong-journal-path",{"protocolFixture":{**fixture,"attempts":pin}}),("empty-journal",{"protocolFixture":{**fixture,"executed":0}})]:',
      '  try:m.validate_plan({**plan,**changes})',
      '  except ValueError:rejected.append(label)',
      ' f.write_text("[]")',
      ' try:m.pinned(pin)',
      ' except ValueError:rejected.append("pin-drift")',
      ' print(json.dumps(rejected))',
    ].join('\n'),driver],{encoding:'utf8'});
    expect(JSON.parse(result)).toEqual(['consumption','schema','queries','configuration','existing','relative','negative','unsafe',
      'artifact','declaration','attempts','ledger','exitCode','executed','old-edition','wrong-journal-path','empty-journal','pin-drift']);
  });

  it('requires pinned journal reconciliation and ordinary runtime qualification before restoration',()=>{
    const driver=fileURLToPath(new URL('../../../../../scripts/backup/search-bench/run-retained-baseline.py',import.meta.url));
    const result=execFileSync('python3',['-B','-c',[
      'import importlib.util,json,tempfile,pathlib,hashlib,sys',
      'spec=importlib.util.spec_from_file_location("baseline",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
      'with tempfile.TemporaryDirectory() as root:',
      ' p=pathlib.Path(root);artifact=p/"benchmark.json";fixture={"exitCode":1,"executed":3}',
      ' for key,suffix in {"artifact":"","declaration":".declaration.json","attempts":".attempts.jsonl","ledger":".ledger.json"}.items():',
      '  f=pathlib.Path(str(artifact)+suffix);f.write_text("{}\\n");fixture[key]=m.fingerprint(f)',
      ' plan={"protocolFixture":fixture,"configuration":{"path":str(p/"configuration.json")}}',
      ' cases=[]',
      ' for mode in ["pass","ordinary-failed","wrong-runtime-kind","journal-population","fixture-drift"]:',
      '  destination=p/mode;destination.mkdir();calls=[]',
      '  def command(label,args,env):',
      '   calls.append(label)',
      '   if label=="protocol-preflight":',
      '    assert args[:7]==["node","--import","tsx","--input-type=module","-e",args[5],str(artifact)]',
      '    value={"executed":2 if mode=="journal-population" else 3,"exitCode":1,"searchAdapterExercised":True,"baselineAccepted":False,"latencyAcceptance":False}',
      '    pathlib.Path(args[-1]).write_text(json.dumps(value))',
      '   else:',
      '    assert "--benchmark" not in args and args[args.index("--assets")+1]==str(p/"assets.json")',
      '    value={"kind":"wrong" if mode=="wrong-runtime-kind" else "shared-search-runtime-only-qualification","qualifiedComponentsOnly":mode!="ordinary-failed","result":{"code":0,"signal":None},"searchAdapterExercised":False,"latencyAcceptance":False}',
      '    pathlib.Path(args[args.index("--output")+1]+".report.json").write_text(json.dumps(value))',
      '  if mode=="fixture-drift":artifact.write_text("changed")',
      '  try:',
      '   receipt=m.runtime_preflight(plan,destination,p/"assets.json",command,{})',
      '   assert len(receipt["journalInputs"])==4;cases.append([mode,"pass",calls])',
      '  except ValueError:cases.append([mode,"rejected",calls])',
      ' print(json.dumps(cases))',
    ].join('\n'),driver],{encoding:'utf8'});
    expect(JSON.parse(result)).toEqual([
      ['pass','pass',['protocol-preflight','ordinary-runtime']],
      ['ordinary-failed','rejected',['protocol-preflight','ordinary-runtime']],
      ['wrong-runtime-kind','rejected',['protocol-preflight','ordinary-runtime']],
      ['journal-population','rejected',['protocol-preflight']],
      ['fixture-drift','rejected',[]],
    ]);
  });

  it('pins completed artifact bytes including the terminal phase journal record',()=>{
    const driver=fileURLToPath(new URL('../../../../../scripts/backup/search-bench/run-retained-baseline.py',import.meta.url));
    const result=execFileSync('python3',['-B','-c',[
      'import importlib.util,json,tempfile,pathlib,sys,os,contextlib,io,types',
      'spec=importlib.util.spec_from_file_location("baseline",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
      'with tempfile.TemporaryDirectory() as root:',
      ' p=pathlib.Path(root);os.chdir(p);(p/".verifier-source.json").write_text("{}")',
      ' (p/"node_modules/@huggingface/transformers").mkdir(parents=True)',
      ' def pin(name,value):',
      '  f=p/name;f.write_text(json.dumps(value));return m.fingerprint(f)',
      ' destination=p/"output"',
      ' queries={"configuration":{"queryEmbeddingProfile":{"mode":"gemma","profileId":"gemma-embeddinggemma-300m-768@v1"}},"workspaceId":"fixture","pairsPerSource":1,"sources":["session_turn"],"seed":"fixture"}',
      ' schema={"schema":"harness_shared","archives":[{"tables":["session_turns"],"path":"fixture.dump"}],"indexes":[]}',
      ' plan={"schemaVersion":2,"workItemId":"WI-fixture","outputDirectory":str(destination),"expectedCounts":{"session_turns":0},"configuration":pin("config.json",{}),"consumption":pin("consumption.json",{"files":[]}),"schema":pin("schema.json",schema),"queries":pin("queries.json",queries)}',
      ' f=pin("benchmark.json",{});plan["protocolFixture"]={"exitCode":1,"executed":3,**{k:{"path":f["path"]+suffix,"sha256":f["sha256"]} for k,suffix in {"artifact":"","declaration":".declaration.json","attempts":".attempts.jsonl","ledger":".ledger.json"}.items()}}',
      ' file=p/"plan.json";file.write_text(json.dumps(plan))',
      ' os.environ.update(m.RUNTIME_POLICY);os.environ["PAPERCUSP_TEST_PG_ADMIN_URL"]="postgres://localhost:23456/postgres"',
      ' m.runtime_preflight=lambda *args:{"verified":True}',
      ' def external(args,**kwargs):',
      '  if args[0]=="psql":',
      '   statement=kwargs["input"]',
      '   value=str(p/"papercusp-test-pg-fixture") if "data_directory" in statement else "[]" if "json_agg" in statement else "0"',
      '   return types.SimpleNamespace(returncode=0,stdout=value,stderr="")',
      '  if "--output" in args:',
      '   pathlib.Path(args[args.index("--output")+1]+".report.json").write_text(json.dumps({"qualifiedComponentsOnly":True,"searchAdapterExercised":True}))',
      '  elif "--out" in args:',
      '   pathlib.Path(args[args.index("--out")+1]).write_text(json.dumps({"sourceQualification":{"verdict":"pass"},"verdict":"pass","latencyVerdict":"pass"}))',
      '  return types.SimpleNamespace(returncode=0)',
      ' m.subprocess.run=external',
      ' with contextlib.redirect_stdout(io.StringIO()):code=m.run(str(file))',
      ' receipt=json.loads((destination/"receipt.json").read_text())',
      ' assert code==0 and "failure" not in receipt',
      ' assert receipt["phases"][-1]["phase"]=="measured-contributing-baseline"',
      ' pins=receipt["artifacts"];assert any(pathlib.Path(x["path"]).name=="phases.jsonl" for x in pins)',
      ' for recorded in pins:',
      '  assert m.fingerprint(recorded["path"])==recorded, "completed artifact pin differs: "+recorded["path"]',
      ' print(json.dumps({"exitCode":code,"terminalPhase":receipt["phases"][-1]["phase"],"everyArtifactMatches":True}))',
    ].join('\n'),driver],{encoding:'utf8'});
    expect(JSON.parse(result)).toEqual({exitCode:0,terminalPhase:'measured-contributing-baseline',everyArtifactMatches:true});
  });

  it('applies explicit policies after isolation and saves prerequisite verdicts without accessing PostgreSQL',()=>{
    const driver=fileURLToPath(new URL('../../../../../scripts/backup/search-bench/run-retained-baseline.py',import.meta.url));
    const result=execFileSync('python3',['-B','-c',[
      'import importlib.util,json,tempfile,pathlib,hashlib,sys,os,contextlib,io',
      'spec=importlib.util.spec_from_file_location("baseline",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)',
      'with tempfile.TemporaryDirectory() as root:',
      ' p=pathlib.Path(root);os.chdir(p);(p/".verifier-source.json").write_text("{}")',
      ' (p/"node_modules/@huggingface/transformers").mkdir(parents=True)',
      ' def pin(name,value):',
      '  f=p/name;f.write_text(json.dumps(value));return m.fingerprint(f)',
      ' plan={"schemaVersion":2,"workItemId":"WI-fixture","expectedCounts":{"session_turns":0},"configuration":pin("config.json",{}),"consumption":pin("consumption.json",{"files":[]}),"schema":pin("schema.json",{"archives":[{"tables":["session_turns"]}]}),"queries":pin("queries.json",{"configuration":{"queryEmbeddingProfile":{"mode":"gemma","profileId":"gemma-embeddinggemma-300m-768@v1"}}})}',
      ' f=pin("benchmark.json",{});plan["protocolFixture"]={"exitCode":1,"executed":3,**{k:{"path":f["path"]+suffix,"sha256":f["sha256"]} for k,suffix in {"artifact":"","declaration":".declaration.json","attempts":".attempts.jsonl","ledger":".ledger.json"}.items()}}',
      ' os.environ.update(PAPERCUSP_TEST_PG_ADMIN_URL="postgres://localhost:23456/postgres",PAPERCUSP_MEMORY_EMBEDDER="ambient-must-be-scrubbed")',
      ' def forbidden(*args,**kwargs):raise AssertionError("PostgreSQL or restore accessed")',
      ' m.subprocess.run=forbidden',
      ' def isolated(command):',
      '  boundary=command.index("--");assert command[:boundary]==["node","scripts/with-test-pg.mjs","--isolated-runtime"]',
      '  assert command[boundary+1]=="env" and not any("PAPERCUSP_" in value for value in command[:boundary])',
      '  assignments=dict(value.split("=",1) for value in command[boundary+2:boundary+2+len(m.RUNTIME_POLICY)])',
      '  assert assignments=={"PAPERCUSP_MEMORY_EMBEDDER":"gemma","PAPERCUSP_EMBED_DEVICE":"cpu","PAPERCUSP_TRANSFORMERS_LOCAL_ONLY":"1","PAPERCUSP_SKIP_PG_DISCOVERY":"1"}',
      '  assert command[-1]=="--preflight-only" and "--with-test-pg" not in command',
      '  for key in m.RUNTIME_POLICY:os.environ.pop(key,None)',
      '  os.environ.update(assignments)',
      '  return m.run(command[command.index("--plan")+1],preflight_only=True)',
      ' m.subprocess.call=isolated',
      ' cases=[]',
      ' for failed in [False,True]:',
      '  destination=p/("failed" if failed else "success");plan["outputDirectory"]=str(destination);file=p/"plan.json";file.write_text(json.dumps(plan))',
      '  def preflight(*args):',
      '   if failed:raise ValueError("ordinary runtime rejected")',
      '   return {"verified":True}',
      '  m.runtime_preflight=preflight',
      '  with contextlib.redirect_stdout(io.StringIO()):code=m.run_in_test_pg(str(file),preflight_only=True)',
      '  receipt=json.loads((destination/"receipt.json").read_text());cases.append([code,receipt["kind"],"failure" in receipt,receipt["baselineAccepted"]])',
      ' print(json.dumps(cases))',
    ].join('\n'),driver],{encoding:'utf8'});
    expect(JSON.parse(result)).toEqual([
      [0,'retained-search-runtime-prerequisites',false,false],
      [1,'retained-search-runtime-prerequisites',true,false],
    ]);
  });
});
