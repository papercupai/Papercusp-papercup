---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold30-acquisition-and-analysis-procedure-424d5.json"
updated_at: 1791904252918
_body: "content"
---

{
  "schemaVersion": "cold30-acquisition-and-analysis-procedure-v1",
  "observedAt": "2026-10-13T15:10:49.631200+00:00",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "route": "approved SELF/AUTO/P-013",
  "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
  "authoritativeAssessment": "audits/parked-agent-resumption-2026-10-09/r13-cold30-original137-custody-assessment-v2-424d5.json",
  "summary": {
    "population": 137,
    "prior92Immutable": 92,
    "prior93PreservedExactly": true,
    "newCompleteInCold30": 2,
    "custodyComplete": 94,
    "queued": 92,
    "flushRefused": 1,
    "noHostRefused": 1,
    "unresolved": 43,
    "nativePairCollisions": 0,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0
  },
  "readback": [
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold30-recovered-native01a1113e-original32231391-assessment-424d5.json",
      "sha256": "09753c8214cde1b6b7834df7caa13369a619d2c54bab67dde2c027e29f60f50f",
      "chars": 909040,
      "bytes": 910786,
      "fullExactReadback": true,
      "summary": {
        "priorComplete": 92,
        "newComplete": 1,
        "outcomesJoined": 0,
        "continuityAccepted": 0,
        "eligibilityAccepted": 0
      }
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold30-original137-custody-assessment-424d5.json",
      "sha256": "8decdd75d1a50303d12f7e785c65cdad3457d8e2fb09b4d1f5acae8b5678b7c4",
      "chars": 649303,
      "bytes": 649779,
      "fullExactReadback": true,
      "summary": {
        "population": 137,
        "prior92Immutable": 92,
        "newComplete": 1,
        "custodyComplete": 93,
        "queued": 91,
        "flushRefused": 1,
        "noHostRefused": 1,
        "unresolved": 44,
        "nativePairCollisions": 0,
        "continuityAccepted": 0,
        "eligibilityAccepted": 0,
        "outcomesJoined": 0
      }
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold30-recovered-native01a11158-original32243511-assessment-424d5.json",
      "sha256": "3e07126080769df3654383df4dfa68a99d26f62e2eb3ae59db2ec7c504414197",
      "chars": 1010980,
      "bytes": 1013818,
      "fullExactReadback": true,
      "summary": {
        "priorComplete": 93,
        "newComplete": 1,
        "outcomesJoined": 0,
        "continuityAccepted": 0,
        "eligibilityAccepted": 0
      }
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold30-original137-custody-assessment-v2-424d5.json",
      "sha256": "1e24e6308fa619a7c20c460e0620cd30f27d915ebfe4d153be4d53fb7964bef4",
      "chars": 677079,
      "bytes": 677555,
      "fullExactReadback": true,
      "summary": {
        "population": 137,
        "prior92Immutable": 92,
        "prior93PreservedExactly": true,
        "newCompleteInCold30": 2,
        "custodyComplete": 94,
        "queued": 92,
        "flushRefused": 1,
        "noHostRefused": 1,
        "unresolved": 43,
        "nativePairCollisions": 0,
        "continuityAccepted": 0,
        "eligibilityAccepted": 0,
        "outcomesJoined": 0
      }
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold30-frozen-backup-object-custody-424d5.json",
      "sha256": "8e9ca81038570dab722e5748e71dc052a8016f6c9837a4da082fd485f30184d8",
      "chars": 4290894,
      "bytes": 4290894,
      "fullExactReadback": true,
      "summary": {
        "fiveInitialObjectsExitZero": 5,
        "remainingRoots": {
          "targets": 31,
          "exitZero": 18,
          "timeouts": 0,
          "matchingHomeEntries": 44
        },
        "newHomes": {
          "uniqueObjects": 30,
          "exitZero": 30,
          "timeouts": 0,
          "exactNativeMatches": 39
        },
        "exactNativeMatches": 39,
        "uniqueNativeSessionIds": 35,
        "uniqueNativeObjectIds": 36
      }
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold30-backup-original-native-01a11158-b6c7-7c23-8712-bc632b5004fa-424d5.jsonl",
      "sha256": "92b1669364ebc47b65d9c338cdc0ec912f54a2891b3358489cdf17f3da2716fc",
      "chars": 2648917,
      "bytes": 2656781,
      "fullExactReadback": true,
      "summary": {
        "fullNativeSource": true
      }
    }
  ],
  "programs": {
    "originalNativeAssessment": "\nimport {readFileSync,writeFileSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nimport {parseCodexParts,partRowsFrom} from './packages/operator-core/lib/search/session-ingest.ts';\nimport {blockPayloadText,codexToolCallArgsRaw} from './packages/operator-core/lib/transcript-wire.ts';\nconst sha=x=>createHash('sha256').update(x).digest('hex'),base='audits/parked-agent-resumption-2026-10-09/';\nconst priorText=readFileSync('/tmp/parked-cold30-r13-cold27-original137-custody-assessment-424d5.json','utf8'),prior=JSON.parse(priorText);\nconst instrumentText=readFileSync('/tmp/parked-cold30-r13-cold26-native-analysis-instrument-424d5.json','utf8'),instrument=JSON.parse(instrumentText);\nif(sha(priorText)!=='b0c218f70d54bde66da822d0a14fec696115357e346400294b585239d7935c51'||sha(instrumentText)!=='db2ecf60955aa3d2524f9d480a8c3d4bcb09c6a72200273bf3a193e4874164f0')throw Error('prior/instrument drift');\nconst sid='01a1113e-65dd-7822-9033-cde625ea52e3',sourcePath='/tmp/parked-cold28-original-native-'+sid+'-424d5.jsonl',raw=readFileSync(sourcePath),lines=raw.toString('utf8').split('\\n').filter(Boolean),metadata=JSON.parse(readFileSync('/tmp/parked-cold28-native-source-custody-424d5.json','utf8'));\nif(raw.length!==2536442||sha(raw)!==metadata.sha256||metadata.sha256!=='3bfaaf16eeda428205069f642a3e9a105cfefc7ed82b072debab1344200b0c5e')throw Error('native bytes drift');\nconst target=prior.rows.find(x=>String(x.request_id)==='32231391'),ledger=target.cold27Assessment.sourceLocationAssessment.ledger;\nconst parts=[],nativeToolMapping=[],metas=[];\nfor(let i=0;i<lines.length;i++){\n const rec=JSON.parse(lines[i]);if(rec.type==='session_meta')metas.push(rec.payload.id);\n const emitted=parseCodexParts(lines[i]),rows=partRowsFrom(emitted,{sourceKind:'codex',sessionId:sid,owner:ledger.coord_owner_id,partCount:parts.length},[]);\n for(let k=0;k<rows.length;k++){\n  const p=rows[k],payload=rec.payload;\n  if(p.part_kind==='tool_use')p.text=blockPayloadText(codexToolCallArgsRaw(payload));\n  else if(p.part_kind==='tool_result')p.text=blockPayloadText(payload.output);\n  parts.push(p);\n  if(p.part_kind==='tool_use'||p.part_kind==='tool_result')nativeToolMapping.push({nativeLine:i+1,part_idx:p.part_idx,ts:p.ts,part_kind:p.part_kind,tool_name:p.tool_name,call_id:payload.call_id,textChars:p.text.length,textSha256:sha(p.text)});\n }\n}\nif(JSON.stringify(metas)!==JSON.stringify([sid]))throw Error('native identity');\nconst selected=parts.filter(p=>p.part_kind==='tool_use').map(p=>({...p,following_parts:parts.filter(q=>q.part_idx===p.part_idx+1)}));\nconst input={targets:[{ledger,source:{owner:ledger.coord_owner_id,source_candidates:selected},lineage:parts}]};\nconst child=Bun.spawn(['bun','-e',instrument.parser],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'});\nconst [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);\nif(exitCode!==0)throw Error('parser failed '+stderr);\nconst result=JSON.parse(stdout.trim());if(result.rows.length!==1||result.rows[0].request_id!=='32231391')throw Error('identity');\nconst accepted=x=>x.acceptedUnique||x.completeOriginalPair,assessment={schemaVersion:'cold30-original-native-backup-receipt-assessment-v1',observedAt:new Date().toISOString(),originalRequest:'32231391',priorAssessmentRef:base+'r13-cold27-original137-custody-assessment-424d5.json',priorAssessmentSha256:sha(priorText),prior92Immutable:true,sourceRef:base+'r13-cold28-backup-original-native-'+sid+'-424d5.jsonl',sourceCustody:metadata,instrumentRef:base+'r13-cold26-native-analysis-instrument-424d5.json',instrumentSha256:sha(instrumentText),parserSha256:sha(instrument.parser),writer:{path:'packages/operator-core/lib/search/session-ingest.ts',sha256:sha(readFileSync('packages/operator-core/lib/search/session-ingest.ts')),function:'parseCodexParts + partRowsFrom with exact raw tool text before recall capping',wirePath:'packages/operator-core/lib/transcript-wire.ts',wireSha256:sha(readFileSync('packages/operator-core/lib/transcript-wire.ts')),partCount:parts.length,originalLedger:ledger},nativeToolMapping,sourceInput:input,parserExecution:{exitCode,stdout,stderr},rows:result.rows,summary:{priorComplete:92,newComplete:result.rows.filter(accepted).length,outcomesJoined:0,continuityAccepted:0,eligibilityAccepted:0},limits:instrument.limits};\nconst text=JSON.stringify(assessment,null,2),ref=base+'r13-cold30-recovered-native01a1113e-original32231391-assessment-424d5.json';\nwriteFileSync('/tmp/parked-cold30-native-assessment-save-424d5.json',JSON.stringify({slug:'papercusp',rel_path:ref,content:text}));\nconsole.log(JSON.stringify({summary:assessment.summary,rows:result.rows,artifact:{ref,chars:text.length,sha256:sha(text)},nativeMapping:nativeToolMapping.filter(p=>p.part_idx>=70)}));\n",
    "secondNativeAssessment": "\nimport {readFileSync,writeFileSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nimport {parseCodexParts,partRowsFrom} from './packages/operator-core/lib/search/session-ingest.ts';\nimport {blockPayloadText,codexToolCallArgsRaw} from './packages/operator-core/lib/transcript-wire.ts';\nconst sha=x=>createHash('sha256').update(x).digest('hex'),base='audits/parked-agent-resumption-2026-10-09/';\nconst priorText=JSON.parse(readFileSync('/tmp/parked-cold30-combined-save-424d5.json','utf8')).content,prior=JSON.parse(priorText);\nconst instrumentText=readFileSync('/tmp/parked-cold30-r13-cold26-native-analysis-instrument-424d5.json','utf8'),instrument=JSON.parse(instrumentText);\nif(sha(priorText)!=='8decdd75d1a50303d12f7e785c65cdad3457d8e2fb09b4d1f5acae8b5678b7c4'||sha(instrumentText)!=='db2ecf60955aa3d2524f9d480a8c3d4bcb09c6a72200273bf3a193e4874164f0')throw Error('prior/instrument drift');\nconst sid='01a11158-b6c7-7c23-8712-bc632b5004fa',sourcePath='/tmp/parked-cold30-original-native-'+sid+'-424d5.jsonl',raw=readFileSync(sourcePath),lines=raw.toString('utf8').split('\\n').filter(Boolean),metadata=JSON.parse(readFileSync('/tmp/parked-cold30-native01a11158-source-custody-424d5.json','utf8'));\nif(raw.length!==2656781||sha(raw)!==metadata.sha256||metadata.sha256!=='92b1669364ebc47b65d9c338cdc0ec912f54a2891b3358489cdf17f3da2716fc')throw Error('native bytes drift');\nconst target=prior.rows.find(x=>String(x.request_id)==='32243511'),ledger=target.cold27Assessment.sourceLocationAssessment.ledger;\nconst parts=[],nativeToolMapping=[],metas=[];\nfor(let i=0;i<lines.length;i++){\n const rec=JSON.parse(lines[i]);if(rec.type==='session_meta')metas.push(rec.payload.id);\n const emitted=parseCodexParts(lines[i]),rows=partRowsFrom(emitted,{sourceKind:'codex',sessionId:sid,owner:ledger.coord_owner_id,partCount:parts.length},[]);\n for(let k=0;k<rows.length;k++){\n  const p=rows[k],payload=rec.payload;\n  if(p.part_kind==='tool_use')p.text=blockPayloadText(codexToolCallArgsRaw(payload));\n  else if(p.part_kind==='tool_result')p.text=blockPayloadText(payload.output);\n  parts.push(p);\n  if(p.part_kind==='tool_use'||p.part_kind==='tool_result')nativeToolMapping.push({nativeLine:i+1,part_idx:p.part_idx,ts:p.ts,part_kind:p.part_kind,tool_name:p.tool_name,call_id:payload.call_id,textChars:p.text.length,textSha256:sha(p.text)});\n }\n}\nif(JSON.stringify(metas)!==JSON.stringify([sid]))throw Error('native identity');\nconst selected=parts.filter(p=>p.part_kind==='tool_use').map(p=>({...p,following_parts:parts.filter(q=>q.part_idx===p.part_idx+1)}));\nconst input={targets:[{ledger,source:{owner:ledger.coord_owner_id,source_candidates:selected},lineage:parts}]};\nconst child=Bun.spawn(['bun','-e',instrument.parser],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'});\nconst [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);\nif(exitCode!==0)throw Error('parser failed '+stderr);\nconst result=JSON.parse(stdout.trim());if(result.rows.length!==1||result.rows[0].request_id!=='32243511')throw Error('identity');\nconst accepted=x=>x.acceptedUnique||x.completeOriginalPair,assessment={schemaVersion:'cold30-original-native-backup-receipt-assessment-v1',observedAt:new Date().toISOString(),originalRequest:'32243511',priorAssessmentRef:base+'r13-cold30-original137-custody-assessment-424d5.json',priorAssessmentSha256:sha(priorText),prior92Immutable:true,sourceRef:base+'r13-cold30-backup-original-native-'+sid+'-424d5.jsonl',sourceCustody:metadata,instrumentRef:base+'r13-cold26-native-analysis-instrument-424d5.json',instrumentSha256:sha(instrumentText),parserSha256:sha(instrument.parser),writer:{path:'packages/operator-core/lib/search/session-ingest.ts',sha256:sha(readFileSync('packages/operator-core/lib/search/session-ingest.ts')),function:'parseCodexParts + partRowsFrom with exact raw tool text before recall capping',wirePath:'packages/operator-core/lib/transcript-wire.ts',wireSha256:sha(readFileSync('packages/operator-core/lib/transcript-wire.ts')),partCount:parts.length,originalLedger:ledger},nativeToolMapping,sourceInput:input,parserExecution:{exitCode,stdout,stderr},rows:result.rows,summary:{priorComplete:93,newComplete:result.rows.filter(accepted).length,outcomesJoined:0,continuityAccepted:0,eligibilityAccepted:0},limits:instrument.limits};\nconst text=JSON.stringify(assessment,null,2),ref=base+'r13-cold30-recovered-native01a11158-original32243511-assessment-424d5.json';\nwriteFileSync('/tmp/parked-cold30-second-native-assessment-save-424d5.json',JSON.stringify({slug:'papercusp',rel_path:ref,content:text}));\nconsole.log(JSON.stringify({summary:assessment.summary,acceptedPairs:result.rows.flatMap(r=>r.pairs.filter(p=>p.completeOriginalPair)),artifact:{ref,chars:text.length,sha256:sha(text)}}));\n",
    "canonicalV1Verify": "\nimport {getOrgPg} from '@papercusp/db-org';\nimport {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';\nconst {sql}=getOrgPg(),sha=x=>createHash('sha256').update(x).digest('hex'),files=['/tmp/parked-cold30-native-assessment-save-424d5.json','/tmp/parked-cold30-combined-save-424d5.json'];\nconst out=[];\nfor(const file of files){const s=JSON.parse(readFileSync(file,'utf8')),rs=await sql`SELECT content FROM harness_shared.harness_text_artifacts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND rel_path=${s.rel_path}`;if(rs.length!==1||rs[0].content!==s.content)throw Error('full readback mismatch '+s.rel_path);const d=JSON.parse(rs[0].content);out.push({path:s.rel_path,sha256:sha(rs[0].content),chars:rs[0].content.length,bytes:Buffer.byteLength(rs[0].content),fullExactReadback:true,summary:d.summary});}\nconsole.log(JSON.stringify({verified:out}));await sql.end();\n",
    "canonicalV2Verify": "\nimport {getOrgPg} from '@papercusp/db-org';\nimport {readFileSync} from 'node:fs';import {createHash} from 'node:crypto';\nconst {sql}=getOrgPg(),sha=x=>createHash('sha256').update(x).digest('hex'),files=['/tmp/parked-cold30-second-native-assessment-save-424d5.json','/tmp/parked-cold30-combined-v2-save-424d5.json','/tmp/parked-cold30-backup-object-save-424d5.json','/tmp/parked-cold30-native01a11158-source-save-424d5.json'];\nconst out=[];\nfor(const file of files){const s=JSON.parse(readFileSync(file,'utf8')),rs=await sql`SELECT content FROM harness_shared.harness_text_artifacts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND rel_path=${s.rel_path}`;if(rs.length!==1||rs[0].content!==s.content)throw Error('full readback mismatch '+s.rel_path);const d=s.rel_path.endsWith('.jsonl')?{summary:{fullNativeSource:true}}:JSON.parse(rs[0].content);out.push({path:s.rel_path,sha256:sha(rs[0].content),chars:rs[0].content.length,bytes:Buffer.byteLength(rs[0].content),fullExactReadback:true,summary:d.summary});}\nconsole.log(JSON.stringify({verified:out}));await sql.end();\n",
    "fiveHomeTraversal": "import json,subprocess,hashlib,datetime,os,concurrent.futures\nbase='/tmp/parked-cold30-'\ne=json.load(open(base+'r13-cold28-publication-and-backup-source-custody-424d5.json'))\nscope=json.load(open(base+'native-scope-full-424d5.json'))\ntargets=[{'snapshotId':r['snapshotId'],'home':h,'objectId':o} for r in e['directoryProbe']['rows'] for h,o in r.get('matchingHomes',{}).items() if h!='session-35023']\nassert len(targets)==5\nids={n['sid'] for n in scope['native']}\ndef run(t):\n path=base+'backup-home-'+t['snapshotId'][:6]+'-'+t['home']+'-424d5.json'\n assert not os.path.exists(path),'evidence already exists; do not re-run'\n a={**t,'schemaVersion':'cold30-exact-home-object-traversal-v1','operation':'read-only kopia ls -r -o exact immutable home object','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}\n try:\n  p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','ls','-r','-o',t['objectId']],capture_output=True,timeout=40)\n  a.update(exitCode=p.returncode,stdout=p.stdout.decode(),stderr=p.stderr.decode(),timeout=False)\n except subprocess.TimeoutExpired as ex:a.update(exitCode=None,stdout=(ex.stdout or b'').decode(),stderr=(ex.stderr or b'').decode(),timeout=True)\n a['exactNativeObjects']=[{'nativeSessionId':sid,'objectId':line.split(None,1)[0],'entryPath':line.split(None,1)[1]} for line in a['stdout'].splitlines() if len(line.split(None,1))==2 for sid in ids if sid in line and line.endswith('.jsonl')]\n text=json.dumps(a,ensure_ascii=False,indent=2);open(path+'.pending','w').write(text);os.replace(path+'.pending',path)\n return {'evidencePath':path,'metadataSha256':hashlib.sha256(text.encode()).hexdigest(),**{k:a[k] for k in ['snapshotId','home','exitCode','timeout','exactNativeObjects']}}\nwith concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,targets))\nout={'schemaVersion':'cold30-five-home-object-traversal-v1','rows':results,'limits':['Five exact previously untraversed immutable home objects. Directory presence is not receipt custody. Failed reads prove no absence. No restore.']}\npath=base+'backup-home-traversal-index-424d5.json';text=json.dumps(out,ensure_ascii=False,indent=2);open(path,'w').write(text);print(json.dumps(out))\n",
    "remaining31RootTraversal": "import json,subprocess,hashlib,datetime,os,concurrent.futures,re\nbase='/tmp/parked-cold30-'\ne=json.load(open(base+'r13-cold28-publication-and-backup-source-custody-424d5.json'))\nscope=json.load(open(base+'native-scope-full-424d5.json'))\ncombined=json.loads(json.load(open(base+'combined-save-424d5.json'))['content'])\naccept=lambda x:x.get('acceptedUnique') or x.get('completeOriginalPair')\nremaining={str(x['request_id']) for x in combined['rows'] if not accept(x)}\nassert len(remaining)==44\nids={sid for r in scope['rows'] if str(r['request_id']) in remaining for sid in r['nativeSessions']}\nhomes={re.search(r'/su-codex-homes/([^/]+)/',t['file_path']).group(1) for n in scope['native'] if n['sid'] in ids for t in n['tracked']}\ndone={r['snapshotId'] for r in e['directoryProbe']['rows']}\ntargets=[s for s in e['retainedRelevantSnapshotMetadata'] if s['id'] not in done]\nassert len(targets)==31\ndef run(t):\n path=base+'backup-root-'+t['id']+'-424d5.json'\n assert not os.path.exists(path),'prior acquisition exists; do not repeat'\n rel='su-codex-homes' if t['source']['path'].endswith('/.papercusp') else '.papercusp/su-codex-homes'\n key=t['id']+'/'+rel\n a={'schemaVersion':'cold30-remaining-host-snapshot-directory-v1','snapshotId':t['id'],'sourcePath':t['source']['path'],'snapshotIncomplete':t.get('incomplete'),'rootObjectId':t['rootEntry']['obj'],'operation':'read-only kopia ls -o exact snapshot subtree','path':key,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}\n try:\n  p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','ls','-o',key],capture_output=True,timeout=25)\n  a.update(exitCode=p.returncode,stdout=p.stdout.decode(),stderr=p.stderr.decode(),timeout=False)\n except subprocess.TimeoutExpired as ex:a.update(exitCode=None,stdout=(ex.stdout or b'').decode(),stderr=(ex.stderr or b'').decode(),timeout=True)\n parsed=[line.split(None,1) for line in a['stdout'].splitlines() if len(line.split(None,1))==2]\n a['matchingHomes']={entry.rsplit('/',1)[-1].rstrip('/'):obj for obj,entry in parsed if entry.rsplit('/',1)[-1].rstrip('/') in homes}\n a['directoryEntryCount']=len(parsed)\n text=json.dumps(a,ensure_ascii=False,indent=2);open(path+'.pending','w').write(text);os.replace(path+'.pending',path)\n return {'evidencePath':path,'sha256':hashlib.sha256(text.encode()).hexdigest(),**{k:a[k] for k in ['snapshotId','sourcePath','snapshotIncomplete','exitCode','timeout','matchingHomes','directoryEntryCount']}}\nwith concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:rows=list(pool.map(run,targets))\nout={'schemaVersion':'cold30-remaining31-snapshot-directory-index-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'unresolvedRequestCount':44,'nativeSessionIds':sorted(ids),'homePopulation':sorted(homes),'rows':rows,'summary':{'targets':len(rows),'exitZero':sum(x['exitCode']==0 for x in rows),'timeouts':sum(x['timeout'] for x in rows),'matchingHomeEntries':sum(len(x['matchingHomes']) for x in rows)},'limits':['Frozen Cold28 host inventory only. Successful exact subtree listing is scoped evidence. Incomplete snapshots and failed reads do not prove original-source absence. No restore.']}\npath=base+'backup-remaining31-root-index-424d5.json';text=json.dumps(out,ensure_ascii=False,indent=2);open(path+'.pending','w').write(text);os.replace(path+'.pending',path)\nprint(json.dumps({'evidencePath':path,'sha256':hashlib.sha256(text.encode()).hexdigest(),'summary':out['summary'],'matches':[{'snapshotId':x['snapshotId'],'homes':x['matchingHomes']} for x in rows if x['matchingHomes']]}))\n",
    "new30HomeTraversal": "import json,subprocess,hashlib,datetime,os,concurrent.futures\nbase='/tmp/parked-cold30-';e=json.load(open(base+'r13-cold28-publication-and-backup-source-custody-424d5.json'));idx=json.load(open(base+'backup-remaining31-root-index-424d5.json'));scope=json.load(open(base+'native-scope-full-424d5.json'))\nold={json.load(open(r['evidencePath']))['objectId'] for r in json.load(open(base+'backup-home-traversal-index-424d5.json'))['rows']};old.add(e['sourceObjectRead']['objectId'])\ntargets={}\nfor r in idx['rows']:\n if r['exitCode']==0:\n  for h,o in r['matchingHomes'].items():\n   if o not in old:targets.setdefault(o,{'objectId':o,'home':h,'sourceSnapshots':[]})['sourceSnapshots'].append(r['snapshotId'])\nassert len(targets)==30\nids={sid for r in scope['rows'] for sid in r['nativeSessions']}\ndef run(t):\n path=base+'backup-home-object-'+t['objectId']+'-424d5.json';assert not os.path.exists(path),'completed or partial record exists; no repeat'\n a={**t,'schemaVersion':'cold30-additional-exact-home-object-traversal-v1','operation':'read-only kopia ls -r -o exact immutable home object','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}\n try:\n  p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','ls','-r','-o',t['objectId']],capture_output=True,timeout=25);a.update(exitCode=p.returncode,stdout=p.stdout.decode(),stderr=p.stderr.decode(),timeout=False)\n except subprocess.TimeoutExpired as ex:a.update(exitCode=None,stdout=(ex.stdout or b'').decode(),stderr=(ex.stderr or b'').decode(),timeout=True)\n a['exactNativeObjects']=[{'nativeSessionId':sid,'objectId':line.split(None,1)[0],'entryPath':line.split(None,1)[1]} for line in a['stdout'].splitlines() if len(line.split(None,1))==2 for sid in ids if sid in line and line.endswith('.jsonl')]\n text=json.dumps(a,ensure_ascii=False,indent=2);open(path+'.pending','w').write(text);os.replace(path+'.pending',path)\n return {'evidencePath':path,'sha256':hashlib.sha256(text.encode()).hexdigest(),**{k:a[k] for k in ['objectId','home','sourceSnapshots','exitCode','timeout','exactNativeObjects']}}\nwith concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:rows=list(pool.map(run,targets.values()))\nout={'schemaVersion':'cold30-new30-home-object-index-v1','rows':rows,'summary':{'uniqueObjects':30,'exitZero':sum(r['exitCode']==0 for r in rows),'timeouts':sum(r['timeout'] for r in rows),'exactNativeMatches':sum(len(r['exactNativeObjects']) for r in rows)},'limits':['Thirty exact new immutable objects, deduplicated across snapshot occurrences. Receipt acceptance is separate. No restore.']}\npath=base+'backup-new30-home-object-index-424d5.json';text=json.dumps(out,ensure_ascii=False,indent=2);open(path+'.pending','w').write(text);os.replace(path+'.pending',path);print(json.dumps({'evidencePath':path,'sha256':hashlib.sha256(text.encode()).hexdigest(),'summary':out['summary'],'matches':[r for r in rows if r['exactNativeObjects']]}))\n",
    "secondOriginalSourceAcquisition": "import json,subprocess,hashlib,datetime,os\nbase='/tmp/parked-cold30-';e=json.load(open(base+'r13-cold28-publication-and-backup-source-custody-424d5.json'));sid='01a11158-b6c7-7c23-8712-bc632b5004fa'\nhits=[l.split(None,1) for l in e['sourceSessionsObjectRead']['stdout'].splitlines() if sid in l]\nassert len(hits)==1;obj=hits[0][0];source=base+'original-native-'+sid+'-424d5.jsonl';out=base+'native01a11158-source-custody-424d5.json';assert not os.path.exists(source)\na={'schemaVersion':'cold30-original-native-backup-source-v1','nativeSessionId':sid,'snapshotId':e['sourceSessionsObjectRead']['snapshotId'],'parentObjectId':e['sourceSessionsObjectRead']['objectId'],'objectId':obj,'operation':'read-only kopia show immutable original transcript object','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'recoveredCopyPath':source}\nwith open(source+'.pending','wb') as f:\n try:\n  p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','show',obj],stdout=f,stderr=subprocess.PIPE,timeout=35);a.update(exitCode=p.returncode,stderr=p.stderr.decode(),timeout=False)\n except subprocess.TimeoutExpired as ex:a.update(exitCode=None,timeout=True,stderr=(ex.stderr or b'').decode())\nif a['exitCode']==0 and not a['timeout']:\n os.replace(source+'.pending',source);raw=open(source,'rb').read();lines=raw.splitlines();errors=[];meta=[];stamps=[]\n for n,line in enumerate(lines,1):\n  try:r=json.loads(line)\n  except Exception as ex:errors.append({'line':n,'message':str(ex)});continue\n  if r.get('type')=='session_meta':meta.append(r['payload']['id'])\n  if isinstance(r.get('timestamp'),str):stamps.append(r['timestamp'])\n a.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),lines=len(lines),parseErrors=errors,sessionMetaIds=meta,exactSessionIdentity=meta==[sid],ingestedByteOffset=2656781,atLeastIndexedBytes=len(raw)>=2656781,firstTimestamp=min(stamps),lastTimestamp=max(stamps))\n if not errors and a['exactSessionIdentity'] and a['atLeastIndexedBytes']:json.dump({'slug':'papercusp','rel_path':'audits/parked-agent-resumption-2026-10-09/r13-cold30-backup-original-native-'+sid+'-424d5.jsonl','content':raw.decode()},open(base+'native01a11158-source-save-424d5.json','w'),ensure_ascii=False)\ntext=json.dumps(a,ensure_ascii=False,indent=2);open(out+'.pending','w').write(text);os.replace(out+'.pending',out);print(json.dumps(a))\n"
  },
  "report": {
    "report_id": "rpt_ccf19a18-d8bf-4dfa-8609-e48b4d7cec0b",
    "path": "/reports?sel=rpt_ccf19a18-d8bf-4dfa-8609-e48b4d7cec0b",
    "visibility": "owner",
    "body_sha256": "7b194d86d266a9d44460cea5bbe7e9c7e57d023d5270b768a9052cea998e28d1",
    "fullExactReadback": true,
    "body_md": "The original 137-request cohort now has 94 complete receipts: 92 queued, one flush refusal, and one no-host refusal. All 92 previously accepted records are preserved exactly; 43 requests remain unresolved. Receipt custody does not establish delivery, continuity, or recovery.\n\nTwo original native transcripts were recovered from immutable host-backup objects. Their exact identities, ingestion byte counts, and SHA-256 hashes were verified. The unchanged receipt parser accepted requests 32231391 and 32243511 after matching the original arguments, owner, timestamps, native call IDs, and the yielded-cell chain where present. The combined cohort has no reused native pair.\n\nThe backup search traversed five initial home objects, the 31 remaining snapshot subtrees in the frozen inventory, and 30 additional home objects after deduplicating shared content. It found 36 exact transcript objects covering 35 session IDs. These objects still require source recovery and receipt assessment. Eighteen remaining snapshot-subtree listings succeeded; thirteen incomplete home snapshots returned entry-not-found. Those failed path reads do not establish global source absence.\n\nThe assessments, source text, combined cohort, and complete acquisition evidence were saved canonically and verified by full exact readback. Whole-cohort continuity and eligibility remain unfrozen, and outcomes remain unjoined. R5, orphan-lock root cause, R12 refresh, malformed native input, source-loss remediation, the final runtime anchor, and the actual 24-hour R14 census remain open. No product tests, terminal relaunches, execution-route changes, restores, or live release-gate operations were performed."
  },
  "backupObjectCustodyRef": "audits/parked-agent-resumption-2026-10-09/r13-cold30-frozen-backup-object-custody-424d5.json",
  "backupSummary": {
    "fiveInitialObjectsExitZero": 5,
    "remainingRoots": {
      "targets": 31,
      "exitZero": 18,
      "timeouts": 0,
      "matchingHomeEntries": 44
    },
    "newHomes": {
      "uniqueObjects": 30,
      "exitZero": 30,
      "timeouts": 0,
      "exactNativeMatches": 39
    },
    "exactNativeMatches": 39,
    "uniqueNativeSessionIds": 35,
    "uniqueNativeObjectIds": 36
  },
  "frictionEvidence": [
    "/tmp/parked-cold30-loader-friction-424d5.json",
    "/tmp/parked-cold30-report-schema-friction-424d5.json"
  ],
  "openItems": [
    "WI-6554700010008887",
    "WI-10008164",
    "WI-10008017",
    "EI-25855583682954393",
    "EI-25841670252693578",
    "EI-25796141267112530"
  ],
  "remaining": "R5/root961/R12/malformed-native/source-loss/final-all-fix-runtime/actual>=24hR14 remain open; whole116 continuity0/eligibility0/outcomes0. No product tests/terminal redo/routechange/restore/LIVE_GATE_OPS.",
  "next": "Read this full procedure and exact combined677079-character v2 and backup4290894-character evidence. Recover36 immutable objects for35 exact session IDs from new30HomeIndex rows, deduplicate object IDs and choose exact ledger-related original native sources. Original scope/ledger mapping comes from Cold27 nativeCustodyRef; sourceLocationAssessment lives on unresolved rows. Require identity, full indexed bytes, literal args, matching native call IDs/status/timestamps and unchanged original parser before augmenting94. No completed directory acquisition reruns. Preserve original92 and both new94 records; no outcome join until whole116 continuity/eligibility. Orphan-lock full31892 checkpoint archive remains mandatory before root edits. No automatic respawn on unchanged telemetry; this turn telemetry advanced78366 to195285 with substantive progress."
}
