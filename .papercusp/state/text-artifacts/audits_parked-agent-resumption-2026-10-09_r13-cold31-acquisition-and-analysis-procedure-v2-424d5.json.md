---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold31-acquisition-and-analysis-procedure-v2-424d5.json"
updated_at: 1791907169847
_body: "content"
---

{
  "schemaVersion": "cold31-acquisition-and-analysis-procedure-v2",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "route": "approved SELF/AUTO/P-013",
  "priorProcedure": "audits/parked-agent-resumption-2026-10-09/r13-cold30-acquisition-and-analysis-procedure-424d5.json",
  "summary": {
    "population": 137,
    "custodyComplete": 113,
    "queued": 111,
    "flushRefused": 1,
    "noHostRefused": 1,
    "unresolved": 24,
    "newCompleteInCold31": 19,
    "original94PreservedExactly": true,
    "prior111PreservedExactly": true,
    "continuityAccepted": 0,
    "eligibilityAccepted": 0,
    "outcomesJoined": 0
  },
  "programs": {
    "acquisitionTemplate": "import json,hashlib,os,subprocess,concurrent.futures,datetime\nstart=BATCH_START\nbase='/tmp/parked-cold31-'\ncustody=json.loads(json.load(open('/tmp/parked-cold30-backup-object-save-424d5.json'))['content'])\nscope=json.load(open('/tmp/parked-cold30-native-scope-full-424d5.json'))\ndedup={}\nfor r in custody['new30HomeIndex']['rows']:\n for x in r['exactNativeObjects']:\n  z=dedup.setdefault(x['objectId'],dict(x,occurrences=[]))\n  z['occurrences'].append({'home':r['home'],'homeObject':r['objectId'],'snapshotIds':r['sourceSnapshots'],'directoryEvidenceSha256':r['sha256']})\ntargets=list(dedup.values())[start:start+6]\nassert len(dedup)==36 and len({x['nativeSessionId'] for x in dedup.values()})==35\ndef run(t):\n obj=t['objectId'];sid=t['nativeSessionId'];source=base+'native-object-'+obj+'-424d5.jsonl';record=base+'native-object-'+obj+'-custody-424d5.json'\n assert not os.path.exists(source) and not os.path.exists(source+'.pending') and not os.path.exists(record),'Acquisition already exists; read its record, do not rerun.'\n n=next(n for n in scope['native'] if n['sid']==sid);indexed=max(int(x['byte_offset']) for x in n['tracked'])\n a=dict(t,schemaVersion='cold31-exact-native-backup-source-v1',observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),operation='read-only kopia show exact immutable transcript object',sourcePath=source,indexedSources=n['tracked'],indexedBytes=indexed)\n with open(source+'.pending','wb') as f:\n  try:\n   p=subprocess.run(['/usr/bin/sudo','-n','--','/usr/bin/env','KOPIA_LOG_DIR=/mnt/backup/kopia-cli-logs','/usr/bin/kopia','show',obj],stdout=f,stderr=subprocess.PIPE,timeout=18)\n   a.update(exitCode=p.returncode,timeout=False,stderr=p.stderr.decode())\n  except subprocess.TimeoutExpired as ex:a.update(exitCode=None,timeout=True,stderr=(ex.stderr or b'').decode())\n raw=open(source+'.pending','rb').read();metas=[];errors=[];stamps=[]\n for i,line in enumerate(raw.splitlines(),1):\n  try:r=json.loads(line)\n  except Exception as ex:errors.append({'line':i,'message':str(ex),'bytes':len(line),'sha256':hashlib.sha256(line).hexdigest()});continue\n  if r.get('type')=='session_meta':metas.append(r['payload']['id'])\n  if isinstance(r.get('timestamp'),str):stamps.append(r['timestamp'])\n a.update(bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),lines=len(raw.splitlines()),sessionMetaIds=metas,parseErrors=errors,exactSessionIdentity=metas==[sid],atLeastIndexedBytes=len(raw)>=indexed,firstTimestamp=min(stamps) if stamps else None,lastTimestamp=max(stamps) if stamps else None)\n a['sourceCustodyAccepted']=a['exitCode']==0 and not a['timeout'] and a['exactSessionIdentity'] and a['atLeastIndexedBytes'] and not errors\n if a['exitCode']==0:os.replace(source+'.pending',source)\n text=json.dumps(a,ensure_ascii=False,indent=2);open(record+'.pending','w').write(text);os.replace(record+'.pending',record)\n return a\nwith concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:rows=list(pool.map(run,targets))\nout={'schemaVersion':'cold31-native-object-acquisition-batch-v1','batchStart':start,'rows':rows,'summary':{'objects':len(rows),'exitZero':sum(r['exitCode']==0 for r in rows),'sourceCustodyAccepted':sum(r['sourceCustodyAccepted'] for r in rows),'timeouts':sum(r['timeout'] for r in rows),'parseErrors':sum(len(r['parseErrors']) for r in rows),'shorterThanIndexed':sum(not r['atLeastIndexedBytes'] for r in rows)},'limits':['Exact frozen Cold30 locators only. Source custody is separate from receipt acceptance, continuity, eligibility and outcome. No restore. No directory acquisition rerun.']}\npath=base+'native-object-batch'+str(start)+'-424d5.json';assert not os.path.exists(path);text=json.dumps(out,ensure_ascii=False,indent=2);open(path+'.pending','w').write(text);os.replace(path+'.pending',path)\nprint(json.dumps({'path':path,'sha256':hashlib.sha256(text.encode()).hexdigest(),'summary':out['summary'],'exceptions':[{'sid':r['nativeSessionId'],'objectId':r['objectId'],'bytes':r['bytes'],'indexedBytes':r['indexedBytes'],'errors':r['parseErrors']} for r in rows if not r['sourceCustodyAccepted']]}))\n",
    "batchStarts": [
      0,
      6,
      12,
      18,
      24,
      30
    ],
    "initialAnalysis": "import {readFileSync,writeFileSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nimport {parseCodexParts,partRowsFrom} from './packages/operator-core/lib/search/session-ingest.ts';\nimport {blockPayloadText,codexToolCallArgsRaw} from './packages/operator-core/lib/transcript-wire.ts';\nconst sha=x=>createHash('sha256').update(x).digest('hex'),base='audits/parked-agent-resumption-2026-10-09/',accepted=x=>x.acceptedUnique||x.completeOriginalPair;\nconst oldEnvelope=JSON.parse(readFileSync('/tmp/parked-cold30-combined-v2-save-424d5.json','utf8')),priorText=oldEnvelope.content,prior=JSON.parse(priorText),instrumentText=readFileSync('/tmp/parked-cold30-r13-cold26-native-analysis-instrument-424d5.json','utf8'),instrument=JSON.parse(instrumentText);\nif(sha(priorText)!=='1e24e6308fa619a7c20c460e0620cd30f27d915ebfe4d153be4d53fb7964bef4'||sha(instrumentText)!=='db2ecf60955aa3d2524f9d480a8c3d4bcb09c6a72200273bf3a193e4874164f0')throw Error('Frozen prior/parser drift');\nconst custody=Array.from({length:6},(_,i)=>JSON.parse(readFileSync('/tmp/parked-cold31-native-object-batch'+i*6+'-424d5.json','utf8'))),bySid=new Map(),sourceRows=[];\nfor(const batch of custody)for(const c of batch.rows){\n sourceRows.push(c);if(!c.sourceCustodyAccepted)continue;\n if(bySid.has(c.nativeSessionId)&&bySid.get(c.nativeSessionId).bytes>=c.bytes)continue;bySid.set(c.nativeSessionId,c);\n}\nconst sources=[],ownerOf=sid=>{const rows=prior.rows.filter(x=>!accepted(x)&&x.cold27Assessment.sourceLocationAssessment.nativeSessions.includes(sid));const owners=[...new Set(rows.map(x=>x.owner))];if(owners.length!==1)throw Error('Native owner mapping ambiguous '+sid);return owners[0];};\nfor(const [sid,c] of bySid){\n const raw=readFileSync(c.sourcePath);if(raw.length!==c.bytes||sha(raw)!==c.sha256||raw.length<c.indexedBytes)throw Error('Acquired source changed');\n const lines=raw.toString('utf8').split('\\n').filter(Boolean),parts=[],nativeToolMapping=[],metas=[],owner=ownerOf(sid);\n for(let i=0;i<lines.length;i++){\n  const rec=JSON.parse(lines[i]);if(rec.type==='session_meta')metas.push(rec.payload.id);\n  const rows=partRowsFrom(parseCodexParts(lines[i]),{sourceKind:'codex',sessionId:sid,owner,partCount:parts.length},[]);\n  for(const p of rows){\n   if(p.part_kind==='tool_use')p.text=blockPayloadText(codexToolCallArgsRaw(rec.payload));\n   else if(p.part_kind==='tool_result')p.text=blockPayloadText(rec.payload.output);\n   parts.push(p);\n   if(p.part_kind==='tool_use'||p.part_kind==='tool_result')nativeToolMapping.push({nativeLine:i+1,part_idx:p.part_idx,ts:p.ts,part_kind:p.part_kind,tool_name:p.tool_name,call_id:rec.payload.call_id,textChars:p.text.length,textSha256:sha(p.text)});\n  }\n }\n if(JSON.stringify(metas)!==JSON.stringify([sid]))throw Error('Native identity drift');\n sources.push({nativeSessionId:sid,owner,custody:c,sourceRef:base+'r13-cold31-backup-native-'+sid+'-'+c.objectId+'-424d5.jsonl',parts,nativeToolMapping});\n}\nconst input={targets:prior.rows.filter(x=>!accepted(x)).map(x=>{\n const loc=x.cold27Assessment.sourceLocationAssessment;const available=sources.filter(s=>loc.nativeSessions.includes(s.nativeSessionId));\n const parts=available.flatMap(s=>s.parts),selected=parts.filter(p=>p.part_kind==='tool_use').map(p=>({...p,following_parts:parts.filter(q=>q.session_id===p.session_id&&q.part_idx===p.part_idx+1)}));\n return {ledger:loc.ledger,source:{owner:x.owner,source_candidates:selected},lineage:parts};\n})};\nconst child=Bun.spawn(['bun','-e',instrument.parser],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'});\nconst [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(exitCode!==0)throw Error('Original parser failed '+stderr);\nconst result=JSON.parse(stdout.trim());if(result.rows.length!==43)throw Error('Request population mismatch');\nconst checks=[];\nfor(const r of result.rows)for(const pair of r.pairs.filter(x=>x.completeOriginalPair)){\n const s=sources.find(x=>x.nativeSessionId===pair.nativeSession),m=s.nativeToolMapping,original=m.find(x=>x.part_idx===pair.callPart&&x.part_kind==='tool_use'),response=m.find(x=>x.part_idx===pair.resultPart&&x.part_kind==='tool_result'),responseUse=m.find(x=>x.part_idx===pair.resultPart-1&&x.part_kind==='tool_use');\n const exactNativeCallId=!!original&&!!response&&!!responseUse&&responseUse.call_id===response.call_id;\n if(!exactNativeCallId)throw Error('Native call_id mismatch '+r.request_id);\n const links=pair.chain?.links||[],chainCallIds=links.every(x=>{const a=m.find(y=>y.part_idx===x.precedingCallPart),b=m.find(y=>y.part_idx===x.yieldPart);return a?.part_kind==='tool_use'&&b?.part_kind==='tool_result'&&a.call_id===b.call_id;});\n if(!chainCallIds)throw Error('Native yielded-chain call_id mismatch '+r.request_id);\n checks.push({request_id:r.request_id,nativeSession:pair.nativeSession,originalCallId:original.call_id,responseCallId:response.call_id,responseCallPart:responseUse.part_idx,exactNativeCallId,chainCallIds,sourceIdentityFullIndexedBytes:true});\n}\nconst writer={path:'packages/operator-core/lib/search/session-ingest.ts',sha256:sha(readFileSync('packages/operator-core/lib/search/session-ingest.ts')),wirePath:'packages/operator-core/lib/transcript-wire.ts',wireSha256:sha(readFileSync('packages/operator-core/lib/transcript-wire.ts')),function:'parseCodexParts + partRowsFrom with exact native tool text before recall capping'};\nconst assessment={schemaVersion:'cold31-original-native-multi-source-receipt-assessment-v1',observedAt:new Date().toISOString(),priorRef:oldEnvelope.rel_path,priorSha256:sha(priorText),parserRef:base+'r13-cold26-native-analysis-instrument-424d5.json',instrumentSha256:sha(instrumentText),parserSha256:sha(instrument.parser),writer,acquisition:custody,sources:sources.map(({parts,...rest})=>rest),sourceInput:input,parserExecution:{stdout,stderr,exitCode},rows:result.rows,nativeCallIdVerification:checks,summary:{originalRequestsAssessed:43,acquisitionObjects:36,fullSources:sources.length,newUniqueComplete:result.rows.filter(accepted).length,completePairCount:checks.length,continuityAccepted:0,eligibilityAccepted:0,outcomesJoined:0},limits:instrument.limits};\nconst assessmentRef=base+'r13-cold31-recovered-native-original43-assessment-424d5.json',assessmentText=JSON.stringify(assessment,null,2);\nwriteFileSync('/tmp/parked-cold31-assessment-save-424d5.json',JSON.stringify({slug:'papercusp',rel_path:assessmentRef,content:assessmentText}));\nconst newIds=[],rows=prior.rows.map(p=>{\n if(accepted(p))return p;const r=result.rows.find(x=>x.request_id===String(p.request_id));if(!r)throw Error('Missing original request');\n if(!accepted(r))return {...p,cold31Assessment:{...r,assessmentRef,sourceCustody:'only full-indexed-byte exact sources offered'}};\n newIds.push(String(p.request_id));return {...p,...r,acceptedUnique:true,cold31Assessment:{...r,assessmentRef}};\n});\nif(rows.length!==137||new Set(rows.map(x=>x.request_id)).size!==137)throw Error('Fixed cohort denominator drift');\nfor(const p of prior.rows.filter(accepted))if(JSON.stringify(rows.find(x=>x.request_id===p.request_id))!==JSON.stringify(p))throw Error('Original94 mutation');\nconst identities=[],collisions=[];\nfor(const r of rows.filter(accepted))for(const p of r.pairs.filter(x=>x.completeOriginalPair)){const k=p.nativeSession+':'+p.callPart+':'+p.resultPart;if(identities.includes(k))collisions.push(k);identities.push(k);}\nif(collisions.length)throw Error('Native pair reuse '+JSON.stringify(collisions));\nconst complete=rows.filter(accepted),summary={population:137,prior94PreservedExactly:true,newComplete:newIds.length,custodyComplete:complete.length,queued:complete.filter(x=>x.receiptState==='queued').length,flushRefused:complete.filter(x=>x.receiptState==='flush-refused').length,noHostRefused:complete.filter(x=>x.receiptState==='no-host-refused').length,unresolved:137-complete.length,nativePairCollisions:collisions.length,continuityAccepted:0,eligibilityAccepted:0,outcomesJoined:0};\nconst combined={...prior,schemaVersion:'cold31-original137-custody-assessment-v1',observedAt:new Date().toISOString(),sourceRefs:[...prior.sourceRefs,assessmentRef],priorRef:oldEnvelope.rel_path,priorSha256:sha(priorText),prior94PreservedExactly:true,newIds,rows,summary};\nconst combinedText=JSON.stringify(combined,null,2),combinedRef=base+'r13-cold31-original137-custody-assessment-424d5.json';\nwriteFileSync('/tmp/parked-cold31-combined-save-424d5.json',JSON.stringify({slug:'papercusp',rel_path:combinedRef,content:combinedText}));\nfor(let start=0;start<sources.length;start+=6)writeFileSync('/tmp/parked-cold31-source-batch'+start+'-save-424d5.json',JSON.stringify({items:sources.slice(start,start+6).map(s=>({slug:'papercusp',rel_path:s.sourceRef,content:readFileSync(s.custody.sourcePath,'utf8')}))}));\nconsole.log(JSON.stringify({summary,assessment:{ref:assessmentRef,chars:assessmentText.length,sha256:sha(assessmentText)},combined:{ref:combinedRef,chars:combinedText.length,sha256:sha(combinedText)},acceptedRequestIds:newIds,sourceArtifactBatches:Math.ceil(sources.length/6),nativeCallIdChecks:checks.length,ambiguousRequests:result.rows.filter(x=>!accepted(x)&&x.pairs.some(p=>p.completeOriginalPair)).map(x=>x.request_id)}));\n",
    "delayedSourceFinalization": "import json,hashlib,os,time,datetime\nbase='/tmp/parked-cold31-';original=json.load(open(base+'native-object-batch0-424d5.json'));d=json.load(open(base+'timeout-distilled-424d5.json'));ev=json.loads(d['summary']['output'])['evidence'];assert len(ev)==3 and all(x['storageClosed'] for x in ev)\nrows=[]\nfor c in original['rows']:\n if not c['timeout']:continue\n p=c['sourcePath']+'.pending';raw=open(p,'rb').read();s=os.stat(p);time.sleep(0.15);s2=os.stat(p);assert s.st_size==s2.st_size and s.st_mtime_ns==s2.st_mtime_ns\n errors=[];meta=[];stamps=[]\n for n,line in enumerate(raw.splitlines(),1):\n  try:r=json.loads(line)\n  except Exception as e:errors.append({'line':n,'message':str(e)});continue\n  if r.get('type')=='session_meta':meta.append(r['payload']['id'])\n  if isinstance(r.get('timestamp'),str):stamps.append(r['timestamp'])\n assert not errors and meta==[c['nativeSessionId']] and len(raw)==c['indexedBytes']\n a=dict(c,finalizedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),completionKind='exact pending source finalized after wrapper timeout; acquisition not rerun',originalAttemptRef=base+'native-object-batch0-424d5.json',originalAttemptBytes=c['bytes'],originalTimeoutPreserved=True,writerStorageCloseEvidence=ev,bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest(),lines=len(raw.splitlines()),sessionMetaIds=meta,parseErrors=errors,exactSessionIdentity=True,atLeastIndexedBytes=True,stableClosedFile=True,firstTimestamp=min(stamps),lastTimestamp=max(stamps),sourceCustodyAccepted=True)\n assert not os.path.exists(c['sourcePath']);os.replace(p,c['sourcePath']);rows.append(a)\nout={'schemaVersion':'cold31-delayed-completed-source-finalization-v1','rows':rows,'summary':{'finalizedOriginalCopies':len(rows),'repeatAcquisitions':0,'fullExactIndexedBytes':len(rows)},'guard':['Never publish custody until writer completion, stable final bytes and full exact identity/parse verification. Parent wrapper timeout alone does not establish descendant completion or source absence. Original timeout records stay immutable.']}\np=base+'delayed-source-finalization-424d5.json';assert not os.path.exists(p);t=json.dumps(out,ensure_ascii=False,indent=2);open(p,'w').write(t);print(json.dumps({'path':p,'sha256':hashlib.sha256(t.encode()).hexdigest(),'summary':out['summary']}))",
    "delayedAnalysis": "import {readFileSync,writeFileSync} from 'node:fs';\nimport {createHash} from 'node:crypto';\nimport {parseCodexParts,partRowsFrom} from './packages/operator-core/lib/search/session-ingest.ts';\nimport {blockPayloadText,codexToolCallArgsRaw} from './packages/operator-core/lib/transcript-wire.ts';\nconst sha=x=>createHash('sha256').update(x).digest('hex'),base='audits/parked-agent-resumption-2026-10-09/',accepted=x=>x.acceptedUnique||x.completeOriginalPair;\nconst oldEnvelope=JSON.parse(readFileSync('/tmp/parked-cold31-combined-save-424d5.json','utf8')),priorText=oldEnvelope.content,prior=JSON.parse(priorText),instrumentText=readFileSync('/tmp/parked-cold30-r13-cold26-native-analysis-instrument-424d5.json','utf8'),instrument=JSON.parse(instrumentText);\nif(sha(priorText)!=='b9f98fe7c491cf992f40a970bf46e86c25146d5d4ff529f17b6be893366c75ba'||sha(instrumentText)!=='db2ecf60955aa3d2524f9d480a8c3d4bcb09c6a72200273bf3a193e4874164f0')throw Error('Frozen prior/parser drift');\nconst custody=[JSON.parse(readFileSync('/tmp/parked-cold31-delayed-source-finalization-424d5.json','utf8'))],bySid=new Map(),sourceRows=[];\nfor(const batch of custody)for(const c of batch.rows){\n sourceRows.push(c);if(!c.sourceCustodyAccepted)continue;\n if(bySid.has(c.nativeSessionId)&&bySid.get(c.nativeSessionId).bytes>=c.bytes)continue;bySid.set(c.nativeSessionId,c);\n}\nconst sources=[],ownerOf=sid=>{const rows=prior.rows.filter(x=>!accepted(x)&&x.cold27Assessment.sourceLocationAssessment.nativeSessions.includes(sid));const owners=[...new Set(rows.map(x=>x.owner))];if(owners.length!==1)throw Error('Native owner mapping ambiguous '+sid);return owners[0];};\nfor(const [sid,c] of bySid){\n const raw=readFileSync(c.sourcePath);if(raw.length!==c.bytes||sha(raw)!==c.sha256||raw.length<c.indexedBytes)throw Error('Acquired source changed');\n const lines=raw.toString('utf8').split('\\n').filter(Boolean),parts=[],nativeToolMapping=[],metas=[],owner=ownerOf(sid);\n for(let i=0;i<lines.length;i++){\n  const rec=JSON.parse(lines[i]);if(rec.type==='session_meta')metas.push(rec.payload.id);\n  const rows=partRowsFrom(parseCodexParts(lines[i]),{sourceKind:'codex',sessionId:sid,owner,partCount:parts.length},[]);\n  for(const p of rows){\n   if(p.part_kind==='tool_use')p.text=blockPayloadText(codexToolCallArgsRaw(rec.payload));\n   else if(p.part_kind==='tool_result')p.text=blockPayloadText(rec.payload.output);\n   parts.push(p);\n   if(p.part_kind==='tool_use'||p.part_kind==='tool_result')nativeToolMapping.push({nativeLine:i+1,part_idx:p.part_idx,ts:p.ts,part_kind:p.part_kind,tool_name:p.tool_name,call_id:rec.payload.call_id,textChars:p.text.length,textSha256:sha(p.text)});\n  }\n }\n if(JSON.stringify(metas)!==JSON.stringify([sid]))throw Error('Native identity drift');\n sources.push({nativeSessionId:sid,owner,custody:c,sourceRef:base+'r13-cold31-backup-native-'+sid+'-'+c.objectId+'-424d5.jsonl',parts,nativeToolMapping});\n}\nconst input={targets:prior.rows.filter(x=>!accepted(x)&&x.cold27Assessment.sourceLocationAssessment.nativeSessions.some(sid=>bySid.has(sid))).map(x=>{\n const loc=x.cold27Assessment.sourceLocationAssessment;const available=sources.filter(s=>loc.nativeSessions.includes(s.nativeSessionId));\n const parts=available.flatMap(s=>s.parts),selected=parts.filter(p=>p.part_kind==='tool_use').map(p=>({...p,following_parts:parts.filter(q=>q.session_id===p.session_id&&q.part_idx===p.part_idx+1)}));\n return {ledger:loc.ledger,source:{owner:x.owner,source_candidates:selected},lineage:parts};\n})};\nconst child=Bun.spawn(['bun','-e',instrument.parser],{stdin:new Blob([JSON.stringify(input)]),stdout:'pipe',stderr:'pipe'});\nconst [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);if(exitCode!==0)throw Error('Original parser failed '+stderr);\nconst result=JSON.parse(stdout.trim());if(result.rows.length!==3)throw Error('Request population mismatch');\nconst checks=[];\nfor(const r of result.rows)for(const pair of r.pairs.filter(x=>x.completeOriginalPair)){\n const s=sources.find(x=>x.nativeSessionId===pair.nativeSession),m=s.nativeToolMapping,original=m.find(x=>x.part_idx===pair.callPart&&x.part_kind==='tool_use'),response=m.find(x=>x.part_idx===pair.resultPart&&x.part_kind==='tool_result'),responseUse=m.find(x=>x.part_idx===pair.resultPart-1&&x.part_kind==='tool_use');\n const exactNativeCallId=!!original&&!!response&&!!responseUse&&responseUse.call_id===response.call_id;\n if(!exactNativeCallId)throw Error('Native call_id mismatch '+r.request_id);\n const links=pair.chain?.links||[],chainCallIds=links.every(x=>{const a=m.find(y=>y.part_idx===x.precedingCallPart),b=m.find(y=>y.part_idx===x.yieldPart);return a?.part_kind==='tool_use'&&b?.part_kind==='tool_result'&&a.call_id===b.call_id;});\n if(!chainCallIds)throw Error('Native yielded-chain call_id mismatch '+r.request_id);\n checks.push({request_id:r.request_id,nativeSession:pair.nativeSession,originalCallId:original.call_id,responseCallId:response.call_id,responseCallPart:responseUse.part_idx,exactNativeCallId,chainCallIds,sourceIdentityFullIndexedBytes:true});\n}\nconst writer={path:'packages/operator-core/lib/search/session-ingest.ts',sha256:sha(readFileSync('packages/operator-core/lib/search/session-ingest.ts')),wirePath:'packages/operator-core/lib/transcript-wire.ts',wireSha256:sha(readFileSync('packages/operator-core/lib/transcript-wire.ts')),function:'parseCodexParts + partRowsFrom with exact native tool text before recall capping'};\nconst assessment={schemaVersion:'cold31-original-native-multi-source-receipt-assessment-v1',observedAt:new Date().toISOString(),priorRef:oldEnvelope.rel_path,priorSha256:sha(priorText),parserRef:base+'r13-cold26-native-analysis-instrument-424d5.json',instrumentSha256:sha(instrumentText),parserSha256:sha(instrument.parser),writer,acquisition:custody,sources:sources.map(({parts,...rest})=>rest),sourceInput:input,parserExecution:{stdout,stderr,exitCode},rows:result.rows,nativeCallIdVerification:checks,summary:{originalRequestsAssessed:3,acquisitionObjects:3,fullSources:sources.length,newUniqueComplete:result.rows.filter(accepted).length,completePairCount:checks.length,continuityAccepted:0,eligibilityAccepted:0,outcomesJoined:0},limits:instrument.limits};\nconst assessmentRef=base+'r13-cold31-delayed-native-original3-assessment-424d5.json',assessmentText=JSON.stringify(assessment,null,2);\nwriteFileSync('/tmp/parked-cold31-delayed-assessment-save-424d5.json',JSON.stringify({slug:'papercusp',rel_path:assessmentRef,content:assessmentText}));\nconst newIds=[],rows=prior.rows.map(p=>{\n if(accepted(p))return p;const r=result.rows.find(x=>x.request_id===String(p.request_id));if(!r)return p;\n if(!accepted(r))return {...p,cold31Assessment:{...r,assessmentRef,sourceCustody:'only full-indexed-byte exact sources offered'}};\n newIds.push(String(p.request_id));return {...p,...r,acceptedUnique:true,cold31Assessment:{...r,assessmentRef}};\n});\nif(rows.length!==137||new Set(rows.map(x=>x.request_id)).size!==137)throw Error('Fixed cohort denominator drift');\nfor(const p of prior.rows.filter(accepted))if(JSON.stringify(rows.find(x=>x.request_id===p.request_id))!==JSON.stringify(p))throw Error('Original111 mutation');\nconst identities=[],collisions=[];\nfor(const r of rows.filter(accepted))for(const p of r.pairs.filter(x=>x.completeOriginalPair)){const k=p.nativeSession+':'+p.callPart+':'+p.resultPart;if(identities.includes(k))collisions.push(k);identities.push(k);}\nif(collisions.length)throw Error('Native pair reuse '+JSON.stringify(collisions));\nconst complete=rows.filter(accepted),summary={population:137,prior111PreservedExactly:true,newComplete:newIds.length,custodyComplete:complete.length,queued:complete.filter(x=>x.receiptState==='queued').length,flushRefused:complete.filter(x=>x.receiptState==='flush-refused').length,noHostRefused:complete.filter(x=>x.receiptState==='no-host-refused').length,unresolved:137-complete.length,nativePairCollisions:collisions.length,continuityAccepted:0,eligibilityAccepted:0,outcomesJoined:0};\nconst combined={...prior,schemaVersion:'cold31-original137-custody-assessment-v2',observedAt:new Date().toISOString(),sourceRefs:[...prior.sourceRefs,assessmentRef],priorRef:oldEnvelope.rel_path,priorSha256:sha(priorText),prior111PreservedExactly:true,newIds,rows,summary};\nconst combinedText=JSON.stringify(combined,null,2),combinedRef=base+'r13-cold31-original137-custody-assessment-v2-424d5.json';\nwriteFileSync('/tmp/parked-cold31-combined-v2-save-424d5.json',JSON.stringify({slug:'papercusp',rel_path:combinedRef,content:combinedText}));\nfor(let start=0;start<sources.length;start+=6)writeFileSync('/tmp/parked-cold31-delayed-source-batch'+start+'-save-424d5.json',JSON.stringify({items:sources.slice(start,start+6).map(s=>({slug:'papercusp',rel_path:s.sourceRef,content:readFileSync(s.custody.sourcePath,'utf8')}))}));\nconsole.log(JSON.stringify({summary,assessment:{ref:assessmentRef,chars:assessmentText.length,sha256:sha(assessmentText)},combined:{ref:combinedRef,chars:combinedText.length,sha256:sha(combinedText)},acceptedRequestIds:newIds,sourceArtifactBatches:Math.ceil(sources.length/6),nativeCallIdChecks:checks.length,ambiguousRequests:result.rows.filter(x=>!accepted(x)&&x.pairs.some(p=>p.completeOriginalPair)).map(x=>x.request_id)}));\n",
    "fullCanonicalReadback": "import {getOrgPg} from '@papercusp/db-org';import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';const {sql}=getOrgPg(),sha=x=>createHash('sha256').update(x).digest('hex');\nconst files=['assessment','combined','delayed-assessment','combined-v2','all36-custody','short-source'].map(k=>'/tmp/parked-cold31-'+k+'-save-424d5.json');\nfor(let i=0;i<31;i+=6)files.push('/tmp/parked-cold31-source-batch'+i+'-save-424d5.json');files.push('/tmp/parked-cold31-delayed-source-batch0-save-424d5.json');\nconst result=[];let totalChars=0;\nfor(const file of files){const p=JSON.parse(readFileSync(file,'utf8'));for(const s of p.items||[p]){\n const rows=await sql`SELECT content FROM harness_shared.harness_text_artifacts WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND rel_path=${s.rel_path}`;\n if(rows.length!==1||rows[0].content!==s.content)throw Error('Full canonical readback mismatch '+s.rel_path);\n totalChars+=s.content.length;result.push({ref:s.rel_path,chars:s.content.length,sha256:sha(s.content),fullExactReadback:true});\n}}\nconst manifest={schemaVersion:'cold31-all-artifact-full-canonical-readback-v1',observedAt:new Date().toISOString(),rows:result,summary:{artifacts:result.length,exact:result.length,totalChars},combinedSummary:JSON.parse(JSON.parse(readFileSync('/tmp/parked-cold31-combined-v2-save-424d5.json','utf8')).content).summary};\nconst t=JSON.stringify(manifest,null,2);writeFileSync('/tmp/parked-cold31-readback-manifest-save-424d5.json',JSON.stringify({slug:'papercusp',rel_path:'audits/parked-agent-resumption-2026-10-09/r13-cold31-full-canonical-readback-manifest-424d5.json',content:t}));\nconsole.log(JSON.stringify({summary:manifest.summary,combinedSummary:manifest.combinedSummary,manifest:{chars:t.length,sha256:sha(t)}}));await sql.end();",
    "partitionProgram": "python3 - <<'PY'\nimport json,hashlib,datetime\nbase='/tmp/parked-cold31-';prior=json.loads(json.load(open(base+'combined-v2-save-424d5.json'))['content']);a=json.loads(json.load(open(base+'assessment-save-424d5.json'))['content']);d=json.loads(json.load(open(base+'delayed-assessment-save-424d5.json'))['content']);custody=json.loads(json.load(open(base+'all36-custody-save-424d5.json'))['content']);full={r['nativeSessionId'] for r in custody['effectiveRows'] if r['sourceCustodyAccepted']};allids={r['nativeSessionId'] for r in custody['effectiveRows']};rows=[]\nfor p in prior['rows']:\n if p.get('acceptedUnique') or p.get('completeOriginalPair'):continue\n loc=p['cold27Assessment']['sourceLocationAssessment'];assessments=[(name,x,next((r for r in x['rows'] if r['request_id']==p['request_id']),None)) for name,x in [('original43',a),('delayed3',d)]];sources=[]\n for name,x,r in assessments:\n  if r:\n   t=next(t for t in x['sourceInput']['targets'] if str(t['ledger']['id'])==p['request_id']);bounded=[q for q in r['pairs'] if q['literalArgsEqual'] and q['bounds']];sources.append({'assessment':name,'nativeIds':sorted({t['session_id'] for t in t['lineage']}),'pairCount':len(r['pairs']),'literalArgsMatched':sum(q['literalArgsEqual'] for q in r['pairs']),'boundedLiteralPairs':bounded})\n rows.append({'request_id':p['request_id'],'owner':p['owner'],'ledger':loc['ledger'],'nativeSessionIds':loc['nativeSessions'],'fullCold31NativeIds':[s for s in loc['nativeSessions'] if s in full],'shortSnapshotOnlyNativeIds':[s for s in loc['nativeSessions'] if s in allids and s not in full],'noCold31LocatedObjectNativeIds':[s for s in loc['nativeSessions'] if s not in allids],'classification':'full-native-source-unaccepted-original-receipt' if any(s in full for s in loc['nativeSessions']) else 'no-full-native-source-in-completed-Cold31-acquisition','assessmentEvidence':sources,'receiptAccepted':False,'continuityAccepted':False,'eligibilityAccepted':False,'outcomeJoined':False})\nsummary={'unresolved':len(rows),'fullSourceUnaccepted':sum(x['classification']=='full-native-source-unaccepted-original-receipt' for x in rows),'noFullSource':sum(x['classification']=='no-full-native-source-in-completed-Cold31-acquisition' for x in rows),'fixedOriginalCohort':137,'custodyAccepted':113,'outcomesJoined':0};assert summary['unresolved']==24 and summary['fullSourceUnaccepted']==9 and summary['noFullSource']==15\nout={'schemaVersion':'cold31-original24-unresolved-source-partition-v1','observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'combinedRef':'audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json','combinedSha256':hashlib.sha256(json.load(open(base+'combined-v2-save-424d5.json'))['content'].encode()).hexdigest(),'rows':rows,'summary':summary,'limits':['No parser modification. Full-source unaccepted does not mean a successful receipt exists. No located object is scoped to completed frozen Cold31 acquisition, not global absence. Original113 records are immutable.']}\nt=json.dumps(out,ensure_ascii=False,indent=2);ref='audits/parked-agent-resumption-2026-10-09/r13-cold31-original24-unresolved-source-partition-424d5.json';json.dump({'slug':'papercusp','rel_path':ref,'content':t},open(base+'unresolved24-partition-save-424d5.json','w'),ensure_ascii=False);print(json.dumps({'summary':summary,'ref':ref,'chars':len(t),'sha256':hashlib.sha256(t.encode()).hexdigest()}))\nPY"
  },
  "reportArgs": {
    "request_key": "parked-r13-cold31-native113-424d5-v1",
    "title": "R13 native custody: 113 receipts verified, 24 unresolved",
    "summary": "19 additional original receipts; 36 frozen objects acquired; prior records unchanged; whole-cohort continuity and eligibility remain open.",
    "body_md": "The original 137-request cohort now has 113 complete receipts: 111 queued, one flush refusal, and one no-host refusal. This continuation recovered 19 additional receipts and preserved every previously accepted record exactly. Twenty-four requests remain unresolved. Receipt custody does not establish continuity, eligibility, delivery, or recovery.\n\nAll 36 frozen immutable transcript objects were acquired without repeating a completed acquisition. They cover 35 native sessions: 34 objects meet the full indexed-byte, exact identity and JSON checks; two snapshot versions are shorter than their indexed versions and remain excluded from parser input. The unchanged Cold26 instrument accepted 17 receipts from the initial full sources and two from three subsequently finalized copies. All 19 new accepted pairs passed native call-ID and yielded-chain checks; no pair was reused.\n\nThree initial reads hit the acquisition wrapper’s 18-second deadline during Kopia’s cache initialization. Kopia continued and finished the pending copies after its sudo wrapper was terminated. The retained logs, final stable byte counts, full parse and identity checks established those copies without new reads. Original timeout records remain immutable. The acquisition lifecycle defect is filed and assigned as EI-25879329310017617; source finalization guards now require writer completion and final byte verification.\n\nThe source texts, assessments and combined cohort were saved canonically. Full exact readback verified 41 artifacts containing 149,816,346 characters. Unresolved envelope variants are recorded for review while the frozen parser remains unchanged. Whole-116 continuity and eligibility remain unfrozen, and outcomes remain unjoined. R5, orphan-lock root cause, R12 refresh, malformed native input, source-loss remediation, the final runtime anchor, and the actual 24-hour R14 census remain open. No product tests, terminal relaunches, restores, execution-route changes or live release-gate operations were performed.",
    "kind": "status-digest",
    "subject": {
      "kind": "plan",
      "ref": "parked-agent-census-resumption-and-root-cause-2026-10-09",
      "label": "Parked-agent recovery acceptance"
    },
    "visibility": "owner",
    "supersedes": "rpt_ccf19a18-d8bf-4dfa-8609-e48b4d7cec0b",
    "tags": [
      "r13",
      "native-source",
      "receipt-custody"
    ]
  },
  "canonicalRefs": {
    "combined": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json",
    "assessment": "audits/parked-agent-resumption-2026-10-09/r13-cold31-recovered-native-original43-assessment-424d5.json",
    "delayedAssessment": "audits/parked-agent-resumption-2026-10-09/r13-cold31-delayed-native-original3-assessment-424d5.json",
    "all36Custody": "audits/parked-agent-resumption-2026-10-09/r13-cold31-all36-native-acquisition-custody-424d5.json",
    "fullReadbackManifest": "audits/parked-agent-resumption-2026-10-09/r13-cold31-full-canonical-readback-manifest-424d5.json"
  },
  "ownedFindings": [
    "EI-25879329310017617",
    "EI-25879870290163805"
  ],
  "transportProbation": "EI-25878442219099079",
  "remaining": "Original24 receipts unresolved. Whole116 continuity/eligibility/outcomes remain0. R5/root961/R12/malformed-native/source-loss/finalALLfixruntime/actual>=24hR14 open. No final acceptance or terminal item close.",
  "next": "Verify coord:whoami. Read full Cold31 v2 procedure and current combined-v2 plus source partition. All36 source reads and all assessments/partition are completed; DO NOT rerun any of them. Preserve113 original complete receipts and unchanged Cold26 instrument. For15 no-full-source rows follow exact original native IDs and Cold27 tracked home paths against already saved frozen custody inventory; successful/failed path listings are scoped, not global absence. For9 full-source-unaccepted rows preserve exact native frame evidence; EI-25879870290163805 owns coverage gap, no parser mutation under owner constraint. Recover any missing original source from existing custody/artifacts before any unperformed acquisition; do not replace original-request proof with new requests. Whole116 continuity+eligibility must freeze before outcomes. R5/root961/R12/malformed/source-loss/finalallfixruntime/actual>=24hR14 still open. Root961 original31892 checkpoint archive mandatory before root edits. Same SELF/AUTO/P013/account/cold route; no tests/terminalredo/restore/routechange/LIVE_GATE_OPS. Context actually advanced93315 to186331 this fresh turn; only investigate writer if unchanged value repeats across fresh continuations.",
  "frictions": [
    {
      "kind": "outer-js-syntax",
      "effect": "none; no nested tools dispatched",
      "cause": "Unescaped SQL template backtick inside String.raw program prevented functions.exec compilation",
      "correction": "Ordinary JavaScript string keeps embedded Bun SQL tagged template literal intact."
    }
  ],
  "report": {
    "report_id": "rpt_29979488-10ad-4df1-81f2-5b603009142d",
    "path": "/reports?sel=rpt_29979488-10ad-4df1-81f2-5b603009142d",
    "visibility": "owner",
    "body_sha256": "df470110aec3d4b54c1d492d85fa454cc10004a72566d663be9d0e3abdbf4b8b",
    "fullExactReadback": true
  },
  "readbackManifest": {
    "schemaVersion": "cold31-all-artifact-full-canonical-readback-v1",
    "observedAt": "2026-10-13T15:46:05.997Z",
    "rows": [
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-recovered-native-original43-assessment-424d5.json",
        "chars": 37491173,
        "sha256": "a14f014d66ae8b8ca4d2762838dd591f27822eafded5f64d3e85179bf5631f81",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-424d5.json",
        "chars": 3026440,
        "sha256": "b9f98fe7c491cf992f40a970bf46e86c25146d5d4ff529f17b6be893366c75ba",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-delayed-native-original3-assessment-424d5.json",
        "chars": 3840974,
        "sha256": "b0bc7026408f351588d466b6e873b3f476b2924cee74ea509e6295879077b2d1",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original137-custody-assessment-v2-424d5.json",
        "chars": 3191124,
        "sha256": "2f0817467ff18f74a91fffda4d983ab1a5d0c2e669a0569809761c28a638c18c",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-all36-native-acquisition-custody-424d5.json",
        "chars": 177782,
        "sha256": "878c398968270f5176e3f2c76d4ecbf14c1d2c9613bdd018017bb2bbf184388b",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-shorter-indexed-backup-native-01a12360-da31-7753-8b52-6276d176e0d8-b9d5a14467c653de714613b7c012a64f-424d5.jsonl",
        "chars": 1995533,
        "sha256": "c5c3098abf6bbbf1383d1c2bfcf8a32ccc2d333767a0951aed4e3644166dc706",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-shorter-indexed-backup-native-01a123df-0540-7073-ab0f-160863c68c25-d879f8c570f9963265f0be78a15c96e6-424d5.jsonl",
        "chars": 2912296,
        "sha256": "3f4669b096587b81a1d30808a5eb2bb62d58c69291941018a1476a26d59f7af9",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12332-bcc7-7303-ae0d-4c748ccc0059-21d650235c4b736048acfbbe64db5dde-424d5.jsonl",
        "chars": 2538377,
        "sha256": "c542bf419990a08d8ff493216d5a038c76c738fd19124dad607a03af2f2de77a",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a122ec-4cda-7080-9411-78e5617480bc-Ixecb05869bb736fa8a244b90eb75922ec-424d5.jsonl",
        "chars": 2721094,
        "sha256": "6d74581bded4f48dce9d790a8440cdab3d7b607dcdd013835ac094f0f2813a3d",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a1231e-b6d5-7ee0-8ce8-73fb43067a42-5ffbe27192449a91075ce9220679ac6c-424d5.jsonl",
        "chars": 3161213,
        "sha256": "4e90cd550fb0502ea59016c11a8922b01950c08757f73547757dcebefddf7953",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a1234a-0d22-76c3-9b5c-17845a8123b4-Ix0d2044872da09b8ce38747bea6cce05f-424d5.jsonl",
        "chars": 3309599,
        "sha256": "11265e978198a1b737b728c7bba25828ac6059a01961dd4494a5cb942d606a62",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12354-76df-7230-8a3e-7b5bc95a62ef-c2e79552875452289d5d4c49a53b83bc-424d5.jsonl",
        "chars": 2586195,
        "sha256": "926c36cdf49b805f499333fd882b9c9c985d6af03a3f2f97b7f6c5d80cd7174e",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12315-a40e-7280-a1e8-9f2ac48b1d4e-2002175567b99d2b5185ee5e4a9315cf-424d5.jsonl",
        "chars": 3321510,
        "sha256": "8843b877454127d2eb3503f9b35bb51b2dc1c51415e01f7bf3862c56d894f0f2",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a1232c-37f8-7e61-a664-1dbf34681ab9-35c2ed7f9dae8f758832e400f6a0156c-424d5.jsonl",
        "chars": 2794584,
        "sha256": "d10078a108871afe194450b9f17852045456d026087af16b022e336ee505b050",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12348-953f-7483-9589-e1a23948d6f5-Ix7cb2cddd3c3d82777eca862f375b6c10-424d5.jsonl",
        "chars": 2951053,
        "sha256": "f7fdd8c09d423bbc8fb1b6f4dd85ae1a1022576f392744bf4f4fb0e2dabe0f81",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12358-40b3-7071-afa8-73e105e0851b-575a1dbc45d1ee75573259e5593d0af1-424d5.jsonl",
        "chars": 1245513,
        "sha256": "a9ddcf5d658b76c9484ae8d955c85936c25397f8ca1c90a9b51b8d0068cd3fc5",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a1234b-2ad5-7db0-86b8-4dcb0f9aa366-ed5a07539c79bea441a152cf2d2a785c-424d5.jsonl",
        "chars": 3440889,
        "sha256": "5397a3275c61755c40cb105d2be5c1b62c8b23f764e7b1a496a084d9123df22f",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12368-3a80-78b2-b196-a4b27f28a933-fe456aca9edb7453278827be18b58d76-424d5.jsonl",
        "chars": 3341661,
        "sha256": "a2f7629ac5673d2934cac492a657f0f8724a6fa9a3a18580746aff81a472e3d3",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a123b4-6f42-7472-a975-3a2ba6200ff0-eaaeb2357586de6cc1fed1ad1ffae69d-424d5.jsonl",
        "chars": 2760848,
        "sha256": "1f48eea56a85a224d69b9f39cd25a1e20a06cf071868d16f0c4ded682e9fd1c3",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12337-f502-7103-9a8a-d2d14c76be56-Ix34374fcdea5f3615ee1ee2f656fcec77-424d5.jsonl",
        "chars": 2819771,
        "sha256": "df3358aaa80c2ccd041ad84d25b5b8bd007238975062fafdc29f489bde0943f3",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12349-7117-7211-955a-cc49fb6d9292-Ixa540423d273e36841bb9dda2d62c5c00-424d5.jsonl",
        "chars": 2982268,
        "sha256": "1471e26742216ac56305447ec6f4d593a64f0a81c2e219527ddda97b15da8306",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a122d9-d539-7ed1-918a-41bcc5b9f9c4-Ix308f945d62547c43a6cd5744a14c9c51-424d5.jsonl",
        "chars": 2866345,
        "sha256": "d1015e6a3868c9ccb945d47da4ed3b3b85010f90e28b25727dedf6b63d0ece05",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a122ee-ee80-77b3-9aed-03658f2afb68-60f445394ec65fd955256f41439374a2-424d5.jsonl",
        "chars": 2966823,
        "sha256": "c18fea52b467fd0f60985fe01823cd488840dd4e3f5d96eb89b30b0f9bab19e4",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12302-9220-7a31-94cd-e744f4253db3-319dbaf0259e5b373ef6f24dfccab481-424d5.jsonl",
        "chars": 1303755,
        "sha256": "e87ac7325db099a6deb53a00fe02c884906787f8f15e7f1b66a2c7f587521590",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12308-185e-7f41-bfec-9b7409dd18d3-c897dc29cca172d4174fe4de044c52ae-424d5.jsonl",
        "chars": 3350627,
        "sha256": "313ada59ddb8c8db4f90228a17a00a85c6b3bcf25f5e48a7c9609933bb93b304",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a1232c-bbfd-7201-ae9d-dabbbdc1be14-5095d8530748ff6adae773ddd3169a2e-424d5.jsonl",
        "chars": 2750069,
        "sha256": "a109c8f4abdc179e7c644f5a31f2f08d9acd81aaa2e50bc48d1bb723dda53bbd",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a1231e-4587-78c2-aa03-27c4229be312-Ixe881e73bcff3af373f4a206248a687e9-424d5.jsonl",
        "chars": 2467473,
        "sha256": "8d3816806fb1808546ce767f232645c73717c7bfb4e21836e528002af8c7f81c",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12315-8b95-7243-8949-1b20acf248cd-4d30241d8a32c3e25a7ee639eda6d786-424d5.jsonl",
        "chars": 3158266,
        "sha256": "a22f4e80dba5ba7a14821c8fe669fdeb7ee43025f132e3215e615cce4de93679",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12329-777a-7b80-8fc3-ab01535f10ae-cad44eb4918b4b779d1a7591e7f7afb6-424d5.jsonl",
        "chars": 2684946,
        "sha256": "32c84627d2d7390fc0f162fee983b4a57b90e1d511c1ece5b2a47143277aaa60",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a1233a-d987-7c81-ab19-ebb8b26a4768-Ix9f5e2f8bd45f7a4c75affe638701df2b-424d5.jsonl",
        "chars": 2991162,
        "sha256": "b865ba88b15e013007d20d98030f7cbc34d29d15159ea7ebd1c4d88b401a948b",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12301-650c-73c2-af6d-661ef6de7e01-ec12da214fe4ecbe63c332a9e22f9a88-424d5.jsonl",
        "chars": 2923961,
        "sha256": "c63ef22a9807a98faf4b92e90687fa40d53ba83297d437438c26a576ba8d4cd4",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12357-33fa-76b1-9add-840d4be15ec1-Ixc9a0179af7ed58d50ebf825a2e8b5bc3-424d5.jsonl",
        "chars": 2700059,
        "sha256": "db7ce17ddec77234d3e7b994db97425ea3e29c60406f4fdedbbe545b148501b1",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12353-79f3-73f3-aa5d-89fd463e5c5b-e1e1eb87c5216154f761998a344012b2-424d5.jsonl",
        "chars": 2893795,
        "sha256": "b47f484e60bae793f66e2e6aae188d7594e9c9bd85d422690e6f9d8ce5f5c628",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a122c4-ab61-7441-ae2f-4df2cabf0193-8d2c76729e5f039b1d02a84e217d29da-424d5.jsonl",
        "chars": 3118495,
        "sha256": "851e00fed3dd8a9f415a862907bae4e76b9cd6705abb110c2e30457d87b8fec5",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12308-16d4-7b32-8c56-c080e0f308f7-aa82e385df1e40b75987037b24a88dda-424d5.jsonl",
        "chars": 3411220,
        "sha256": "ca86085563aa674057502a1bc2d67a1abdd637392696203633fb14571ebdeedb",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a122ef-e794-7141-ab72-5d02dedba04e-424aec60722035c1882506f49090c1ef-424d5.jsonl",
        "chars": 3240274,
        "sha256": "8bb1122edbb82e06420c67c6f83ecb67d7bce30fb5bdf07818f1bcaa333e8d21",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a123df-0540-7073-ab0f-160863c68c25-10f49c8e9ff2e50f2b49efbbeb0d0264-424d5.jsonl",
        "chars": 3110459,
        "sha256": "7c70e4b11e7940af9cfcaf104d34a8c99952a66152b9303ae0a92df720834732",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a12411-e413-7d30-ae42-79e0a4cd8440-af7441ef055e2cfaa426e4b0dfba3e5b-424d5.jsonl",
        "chars": 2853952,
        "sha256": "296ab90ca6a88f32f5b1e9469556e5937a2ad7f2d2f162c8a673b6c63f482b76",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a123bb-3402-7a32-ac21-9d650b1634a4-2d0e023df755c109f7a414d5faeebcbd-424d5.jsonl",
        "chars": 3608074,
        "sha256": "9782824617b0c818a516081030dc8c05a4e16487d69ed228823e2123232e5533",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a122c4-d22d-72b3-8c37-5ef6c96c94bb-97208da1c5637be63ed4db874e6db157-424d5.jsonl",
        "chars": 2136377,
        "sha256": "f37570b71fc404bdb874ddd6e3b0eb6d3dbbc251c6f10744a25528001392a213",
        "fullExactReadback": true
      },
      {
        "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-backup-native-01a122d6-ff62-75c3-a4ee-384dd3040a57-810a23d4027584d61f93db20218afb9e-424d5.jsonl",
        "chars": 2670317,
        "sha256": "cf45fe86180a31cf234bb053420ce991f0a1cbbd8b91ec0290d3cf698077315d",
        "fullExactReadback": true
      }
    ],
    "summary": {
      "artifacts": 41,
      "exact": 41,
      "totalChars": 149816346
    },
    "combinedSummary": {
      "population": 137,
      "prior111PreservedExactly": true,
      "newComplete": 2,
      "custodyComplete": 113,
      "queued": 111,
      "flushRefused": 1,
      "noHostRefused": 1,
      "unresolved": 24,
      "nativePairCollisions": 0,
      "continuityAccepted": 0,
      "eligibilityAccepted": 0,
      "outcomesJoined": 0
    }
  },
  "observedAt": "2026-10-13T15:59:23.869940+00:00",
  "sourceReportPath": "audits/parked-agent-resumption-2026-10-09/r13-cold31-owner-report-424d5.md",
  "supersedesProcedureRef": "audits/parked-agent-resumption-2026-10-09/r13-cold31-acquisition-and-analysis-procedure-424d5.json",
  "supersedesProcedureSha256": "e44b779ebc5a8367fd4afb79a5d4803d02d27f09cef9b99a945a41fd79f2417a",
  "unresolved24Partition": {
    "ref": "audits/parked-agent-resumption-2026-10-09/r13-cold31-original24-unresolved-source-partition-424d5.json",
    "sha256": "5718082aac94a41076e7dc6bfe4ae41525e3474110578e18372d3cde891cadd5",
    "chars": 51035,
    "fullExactReadback": true,
    "summary": {
      "unresolved": 24,
      "fullSourceUnaccepted": 9,
      "noFullSource": 15,
      "fixedOriginalCohort": 137,
      "custodyAccepted": 113,
      "outcomesJoined": 0
    }
  }
}
