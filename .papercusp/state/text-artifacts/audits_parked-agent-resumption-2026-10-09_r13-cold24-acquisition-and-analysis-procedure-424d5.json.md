---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold24-acquisition-and-analysis-procedure-424d5.json"
updated_at: 1791894223464
_body: "content"
---

{
  "schemaVersion": "cold24-source-acquisition-and-native-analysis-procedure-v1",
  "observedAt": "2026-10-13T12:23:00Z",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-original137-custody-assessment-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch3-424d5.json"
  ],
  "nativeDbExportProgram": "import {getOrgPg} from '@papercusp/db-org';const {sql}=getOrgPg();const rows=await sql`SELECT harness_slug AS slug,rel_path,content FROM harness_shared.harness_text_artifacts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND rel_path IN ('audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json','audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json')`;console.log(JSON.stringify({results:rows.map(x=>({...x,found:true}))}));await sql.end();",
  "nativePythonProcessor": "import json,sys,subprocess,time,hashlib\nlines=sys.stdin.read().splitlines()\nraw=json.loads(next(x for x in lines if x.startswith('{\"results\":')))\nif len(raw['results'])!=2: raise RuntimeError('exact PG source not found')\nif 'results' not in raw: raise RuntimeError('missing raw artifact results')\nres={x['rel_path']:json.loads(x['content']) for x in raw['results'] if x.get('found')}\nbase='audits/parked-agent-resumption-2026-10-09/'\nd=res[base+'r13-cold24-remaining69-indexed-source-batch1-424d5.json']\np=res[base+'r13-cold23-remaining-direct-originals-424d5.json']\nparser=p['parser']\nrows=[]; executions=[]; session_rows=[]\nfor t in d['targets']:\n cs=[c for c in t['source']['source_candidates'] if 'compaction' in c['text'] or c.get('tool_name')=='wait']\n sessions=sorted(set(c['session_id'] for c in cs))\n found=[]\n for sid in sessions:\n  iso=dict(t);iso['source']=dict(t['source']);iso['source']['source_candidates']=[c for c in cs if c['session_id']==sid];iso['lineage']=[x for x in t['lineage'] if x['session_id']==sid]\n  src=json.dumps({'targets':[iso]},separators=(',',':'),ensure_ascii=False)\n  start=time.monotonic()\n  try:\n   r=subprocess.run(['bun','-e',parser],input=src,text=True,capture_output=True,timeout=10,cwd='/home/marsh-office/papercupai-workspace/papercusp')\n   ex={'request_id':t['ledger']['id'],'nativeSession':sid,'exitCode':r.returncode,'seconds':time.monotonic()-start,'inputBytes':len(src.encode()),'stdout':r.stdout,'stderr':r.stderr}\n   if r.returncode==0:\n    lines=r.stdout.splitlines();rr=json.loads(next(x for x in lines if x.startswith('{\"rows\":')))['rows'][0];found.extend(rr['pairs']);session_rows.append(rr)\n  except subprocess.TimeoutExpired as e:\n   ex={'request_id':t['ledger']['id'],'nativeSession':sid,'exitCode':None,'timeout':True,'seconds':time.monotonic()-start,'inputBytes':len(src.encode()),'stdout':str(e.stdout),'stderr':str(e.stderr)}\n  executions.append(ex)\n accepted={str(x['nativeSession'])+':'+str(x['callPart'])+':'+str(x['resultPart']):x for x in found if x.get('completeOriginalPair')}\n ap=list(accepted.values())\n rows.append({'owner':t['source']['owner'],'request_id':str(t['ledger']['id']),'acceptedUnique':len(ap)==1,'completeOriginalPair':len(ap)==1,'receiptState':ap[0]['receiptState'] if len(ap)==1 else 'unresolved','pairs':found,'acceptedPairCount':len(ap),'outcomeJoined':False})\nart={'schemaVersion':'cold24-indexed-native-shell-assessment-v1','observedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'cohortHash':d['cohortHash'],'sourceRefs':[base+'r13-cold24-remaining69-indexed-source-batch1-424d5.json',base+'r13-cold23-remaining-direct-originals-424d5.json'],'parser':parser,'method':'Unchanged Cold23 processor; each candidate and lineage are isolated to its exact native session; original row is then deduplicated by native call/result pair. Python sends JSON via subprocess stdin, outside shell argv.','rows':rows,'sessionAssessments':session_rows,'executions':executions,'limits':['Outcomes joined0; whole116 continuity/eligibility unaccepted.','Original truncated source remains incomplete.']}\nprint(json.dumps({'slug':'papercusp','rel_path':base+'r13-cold24-native-assessment-batch1-424d5.json','content':json.dumps(art,indent=2,ensure_ascii=False)}))\nprint(json.dumps({'contentSha256':hashlib.sha256(json.dumps(art,indent=2,ensure_ascii=False).encode()).hexdigest(),'contentBytes':len(json.dumps(art,indent=2,ensure_ascii=False).encode()),'targets':len(rows),'accepted':sum(r['acceptedUnique'] for r in rows),'executions':len(executions),'timeouts':sum(e.get('timeout',False) for e in executions)}),file=sys.stderr)\n",
  "nativeCommandMethod": "set -o pipefail; bun --env-file apps/operator/.env -e <properly shell quoted export program> | python3 -c <properly shell quoted processor> | ptool artifacts:save --json -. Substitute source-batch1/native-assessment-batch1 only for other numbered batches. No source files were created. Exact PG export uses operator-env-file localhost5432, positive exact source artifacts required, stdout prefix-aware JSON parse. Each native parser input is passed on stdin to subprocess, not shell argv.",
  "readback": {
    "batch1": "721b9b5a153c8783e2d663aefb73db31ed62dc788aed614f8c2a956ec1a9d0d2",
    "batch2": "c38d4070de69350ec2bd930140b9fb0aaf1204d142ea53b93eeefa19757e24ff",
    "batch3": "19b2b03d55c15c0bb2109f0bbf38597e9b1f332f625198c0b1f0e5862a15379d",
    "procedure": "Independent native getOrgPg exact key source read; SHA256 of complete UTF8 content must match original native save-stream hash. Canonical combined304642char assessment additionally read back full content equality in code:run."
  },
  "retainedFailures": [
    {
      "tool": "code:run",
      "error": "state_limit_exceeded",
      "cause": "Attempted183163char replay-state copy exceeds65536 limit; use local-only read distillation."
    },
    {
      "tool": "dev:pg_query",
      "error": "57014",
      "cause": "Broad IN tool_use/tool_result lateral source scan timed out30000ms. Cause unconfirmed; indexed tool_use+PK-following bounded23rows was measured31/53/84ms."
    },
    {
      "tool": "capability:bash",
      "bashId": "b846d077-c10",
      "taskId": "0mv6mvs4r1klorbmk4t",
      "terminal": "timed_out exit143; job_process_gone confirmed by durable ledger and log",
      "logPath": ".papercusp/scratch/bash-b846d077-c10.log",
      "cause": "Unconfirmed, no parser output. No assessment saved from this run. Do not call or relaunch its old handle."
    },
    {
      "tool": "artifacts:load/tools:invoke CLI",
      "error": "nested artifact content upstream trimmed despite enclosing JSON",
      "cause": "Code:run in-process load886073char complete; CLI content incomplete. Both failed CLI parsing attempts preserved, no parser started or save succeeded."
    },
    {
      "tool": "native getOrgPg export",
      "error": "stdout_prefix",
      "cause": "Diagnostic db line precedes JSON. Exact result-line parser corrected it before any native assessment."
    },
    {
      "tool": "code:run",
      "error": "crypto is not defined",
      "cause": "crypto is not ambient; native node:crypto SHA read verified instead."
    },
    {
      "tool": "code:run",
      "error": "undefined.lineage",
      "cause": "Candidate34937571 was looked up only in batch2. Batch position is not a stable identifier; use original IDs across all3 exact refs."
    }
  ],
  "next": "Recover only59 unresolved original receipts from current combined Cold24 partition. Broad source preserves all69 exact ledger rows and281native tool-use candidates. Literal AST older parser misses tools[n] and aliased fn wrappers; data contains exact constant declarations. Specific labeled complete responses32216380 compaction: JSON-lines,34886663 directTOON plus See also trailer,35289337 COMPACTION format prefix. Candidate34937571 literal conditional alternatives and complete queued response require exact source branch validation. Never relax source completeness or argument/owner/native-session/dispatch-settle custody to accept them. Extend and validate analysis instrument only after reading these actual full source bodies, preserve prior78 as immutable. Whole116 cutoff model/account/carry continuity and eligibility remain unaccepted and outcomesJoined0.",
  "limits": [
    "No product source edits or repeats of successful59/98 product tests.",
    "No terminal work-item reruns, route change or LIVE_GATE_OPS.",
    "Flush-refused/no-live-host refusal retained as failures, never success."
  ]
}
