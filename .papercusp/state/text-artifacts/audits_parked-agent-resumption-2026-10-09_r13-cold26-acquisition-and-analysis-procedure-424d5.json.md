---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold26-acquisition-and-analysis-procedure-424d5.json"
updated_at: 1791897118469
_body: "content"
---

{
  "schemaVersion": "cold26-source-recovery-procedure-v1",
  "observedAt": "2026-10-13T13:11:26.622Z",
  "sourceProcedure": "audits/parked-agent-resumption-2026-10-09/r13-cold25-acquisition-and-analysis-procedure-424d5.json",
  "authoritativeAssessment": "audits/parked-agent-resumption-2026-10-09/r13-cold26-original137-custody-assessment-424d5.json",
  "custody": {
    "population": 137,
    "prior88Immutable": 88,
    "newComplete": 4,
    "custodyComplete": 92,
    "queued": 90,
    "flushRefused": 1,
    "noHostRefused": 1,
    "unresolved": 45,
    "nativePairCollisions": 0,
    "nativeExecutions": 39,
    "timeouts": 0,
    "failedExecutions": 0,
    "outcomesJoined": 0,
    "cutoffContinuityAccepted": 0,
    "eligibilityAccepted": 0
  },
  "readback": [
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-analysis-instrument-424d5.json",
      "chars": 35277,
      "bytes": 35291,
      "sha256": "db2ecf60955aa3d2524f9d480a8c3d4bcb09c6a72200273bf3a193e4874164f0",
      "exactFullReadback": true
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold26-native-assessment-original49-424d5.json",
      "chars": 170569,
      "bytes": 170569,
      "sha256": "f2dfe0c848461dd14a55a1db301ec68173fb4b74a8cf50e8cdacd27a8510cab5",
      "exactFullReadback": true
    },
    {
      "path": "audits/parked-agent-resumption-2026-10-09/r13-cold26-original137-custody-assessment-424d5.json",
      "chars": 422785,
      "bytes": 423259,
      "sha256": "39a54e94c0c5ab27bb6af4a216e581d40517cdb38a8c27404d12576d230472e2",
      "exactFullReadback": true
    }
  ],
  "nativeProgram": "import {readFileSync,writeFileSync} from \"node:fs\";\nimport {createHash} from \"node:crypto\";\nconst root=\"/tmp/parked-cold26-\",base=\"audits/parked-agent-resumption-2026-10-09/\";\nconst priorPath=root+\"r13-cold25-original137-custody-assessment-424d5.json\";\nconst priorText=readFileSync(priorPath,\"utf8\"),prior=JSON.parse(priorText);\nconst sha=s=>createHash(\"sha256\").update(s).digest(\"hex\");\nif(sha(priorText)!==\"0fbc6a2fa8422a71d17b1ae970565d7e17677115636e0bf3dabe7247add8d411\")throw Error(\"prior custody drift\");\nconst accepted=x=>x.acceptedUnique||x.completeOriginalPair,remaining=new Set(prior.rows.filter(x=>!accepted(x)).map(x=>String(x.request_id)));\nif(prior.rows.length!==137||remaining.size!==49)throw Error(\"prior population\");\nconst parserBase=readFileSync(\"/tmp/parked-cold26-analysis-424d5.mjs\",\"utf8\");\nconst parser=parserBase+'\\nconst input=await Bun.stdin.json();console.log(JSON.stringify({rows:input.targets.map(assess)}));\\n';\nconst validationSource=readFileSync(\"/tmp/parked-cold26-validation-424d5.mjs\",\"utf8\");\nconst controlLog=readFileSync(\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-22ce6c3d-131.log\",\"utf8\");\nconst controlStdout=controlLog.split(\"\\n\")[0]+\"\\n\",controls=JSON.parse(controlStdout);if(controls.passed!==50||controls.failed!==0||!controlLog.includes(\"JOB END: status=completed exit=0\"))throw Error(\"control proof\");\nconst instrument={schemaVersion:\"cold26-native-analysis-instrument-v1\",observedAt:new Date().toISOString(),sourceRef:base+\"r13-cold25-native-analysis-instrument-424d5.json\",parser,validationProgram:validationSource.slice(parserBase.length),validation:controls,execution:{exitCode:0,stdout:controlStdout,nativeLog:controlLog},guardDiscoveries:[{failureLog:\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-4be5dbdf-34f.log\",cause:\"TOON decoder treats appended JSON as additional mapping; proof reader now rejects root JSON frames and duplicate requested fields.\"},{failureLog:\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-344af74a-e9d.log\",cause:\"Filtering yields by desired cell can skip a foreign-cell result; proof reader now requires nearest preceding result to identify the exact cell.\"},{failureLog:\"/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/bash-81631725-a2f.log\",cause:\"Native log contains job custody trailer after complete JSON stdout line; driver now parses that exact line and checks JOB END while retaining full log.\"}],limits:[\"Original137 denominator and prior88 JSON records unchanged.\",\"Completeness,owner,args,native-session,status and original timestamp bounds remain required.\",\"Receipt custody is not process delivery,continuity,eligibility or recovery; refusals remain failures.\"]};\nconst instrumentText=JSON.stringify(instrument,null,2),instrumentRef=base+\"r13-cold26-native-analysis-instrument-424d5.json\";\nwriteFileSync(\"/tmp/parked-cold26-instrument-save.json\",JSON.stringify({slug:\"papercusp\",rel_path:instrumentRef,content:instrumentText}));\nconst expected=[\"879153aae85ab8d198eca9312e72a6533d7b6a1dbff62d1957fd99978488e203\",\"1ea3787fb6589c0d9db506bef177b350e3a1f737b8eda5fbbbff7fa95fde27f5\",\"7868fe86367540dbd68da010ccc7d8b87fda0ba9f36803f511a63d738b4b4323\"];\nconst rows=[],executions=[],sessionAssessments=[],sourceReads=[],seen=new Set();\nfor(let batch=1;batch<=3;batch++){\n const name=\"r13-cold24-remaining69-indexed-source-batch\"+batch+\"-424d5.json\",text=readFileSync(root+name,\"utf8\");\n if(sha(text)!==expected[batch-1])throw Error(\"original source drift\");\n const d=JSON.parse(text);sourceReads.push({ref:base+name,sha256:sha(text),bytes:Buffer.byteLength(text),exactFullReadback:true});\n for(const t of d.targets.filter(t=>remaining.has(String(t.ledger.id)))){\n  const id=String(t.ledger.id);if(seen.has(id))throw Error(\"duplicate original target\");seen.add(id);\n  const cs=t.source.source_candidates.filter(c=>c.text.includes(\"compaction\")||c.tool_name===\"wait\"),sessions=[...new Set(cs.map(c=>c.session_id))].sort(),pairs=[];\n  for(const sid of sessions){\n   const isolated={...t,source:{...t.source,source_candidates:cs.filter(c=>c.session_id===sid)},lineage:t.lineage.filter(c=>c.session_id===sid)};\n   const input=JSON.stringify({targets:[isolated]}),started=Date.now(),child=Bun.spawn([\"bun\",\"-e\",parser],{stdin:new Blob([input]),stdout:\"pipe\",stderr:\"pipe\"});\n   let timeout=false;const timer=setTimeout(()=>{timeout=true;child.kill(\"SIGTERM\");},10000);\n   const [stdout,stderr,exitCode]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);\n   executions.push({request_id:id,nativeSession:sid,sourceRef:base+name,inputBytes:Buffer.byteLength(input),inputSha256:sha(input),stdout,stderr,exitCode,timeout,elapsedMs:Date.now()-started});\n   if(exitCode===0&&!timeout){const parsed=JSON.parse(stdout.trim());if(parsed.rows.length!==1||parsed.rows[0].request_id!==id)throw Error(\"native row mismatch\");sessionAssessments.push(parsed.rows[0]);pairs.push(...parsed.rows[0].pairs);}\n  }\n  const unique=new Map(pairs.filter(p=>p.completeOriginalPair).map(p=>[p.nativeSession+\":\"+p.callPart+\":\"+p.resultPart,p])),complete=[...unique.values()];\n  rows.push({request_id:id,owner:t.source.owner,acceptedUnique:complete.length===1,completeOriginalPair:complete.length===1,receiptState:complete.length===1?complete[0].receiptState:\"unresolved\",pairs,acceptedPairCount:complete.length,sourceRef:base+name,outcomeJoined:false});\n }\n}\nif(seen.size!==49||[...remaining].some(id=>!seen.has(id)))throw Error(\"remaining49 coverage\");\nconst assessmentRef=base+\"r13-cold26-native-assessment-original49-424d5.json\";\nconst assessment={schemaVersion:\"cold26-native-source-assessment-v1\",observedAt:new Date().toISOString(),cohortHash:prior.cohortHash,instrumentRef,instrumentSha256:sha(instrumentText),sourceReads,rows,sessionAssessments,executions,summary:{targets:rows.length,newComplete:rows.filter(accepted).length,unresolved:rows.filter(x=>!accepted(x)).length,nativeExecutions:executions.length,nativeExitZero:executions.filter(x=>x.exitCode===0).length,timeouts:executions.filter(x=>x.timeout).length,failedExecutions:executions.filter(x=>x.exitCode!==0).length,outcomesJoined:0}};\nconst assessmentText=JSON.stringify(assessment,null,2);\nwriteFileSync(\"/tmp/parked-cold26-assessment-save.json\",JSON.stringify({slug:\"papercusp\",rel_path:assessmentRef,content:assessmentText}));\nconst map=new Map(rows.map(x=>[x.request_id,x])),newIds=[];\nconst combinedRows=prior.rows.map(x=>{if(accepted(x))return x;const n=map.get(String(x.request_id));if(!n)throw Error(\"missing target\");if(accepted(n)){newIds.push(n.request_id);return {...n,assessmentRef,instrumentRef};}return {...x,cold26Assessment:n};});\nconst preserved=prior.rows.filter(accepted).every(x=>JSON.stringify(x)===JSON.stringify(combinedRows.find(y=>y.request_id===x.request_id)));if(!preserved)throw Error(\"prior88 altered\");\nconst complete=combinedRows.filter(accepted),pairKeys=complete.flatMap(x=>x.pairs.filter(p=>p.completeOriginalPair||p.accepted).map(p=>({request_id:x.request_id,key:p.nativeSession+\":\"+p.callPart+\":\"+p.resultPart})));\nconst collisions=pairKeys.filter((p,i)=>pairKeys.findIndex(q=>q.key===p.key)!==i);if(collisions.length)throw Error(\"native pair collision\");\nconst residue=combinedRows.filter(x=>!accepted(x)).map(x=>({id:x.request_id,owner:x.owner,pairs:x.cold26Assessment.pairs.length,parseErrors:x.cold26Assessment.pairs.some(p=>p.parseErrors!==0),literalArgsMatch:x.cold26Assessment.pairs.some(p=>p.literalArgsEqual),completeSource:x.cold26Assessment.pairs.some(p=>p.sourceComplete),knownReceipt:x.cold26Assessment.pairs.some(p=>p.receiptState!==\"unclassified\"),goodOwnerBounds:x.cold26Assessment.pairs.some(p=>p.ownerEqual&&p.bounds)}));\nconst summary={population:137,prior88Immutable:88,newComplete:newIds.length,custodyComplete:complete.length,queued:complete.filter(x=>x.receiptState===\"queued\").length,flushRefused:complete.filter(x=>x.receiptState===\"flush-refused\").length,noHostRefused:complete.filter(x=>x.receiptState===\"no-host-refused\").length,unresolved:residue.length,nativePairCollisions:collisions.length,nativeExecutions:executions.length,timeouts:assessment.summary.timeouts,failedExecutions:assessment.summary.failedExecutions,outcomesJoined:0,cutoffContinuityAccepted:0,eligibilityAccepted:0};\nconst combined={schemaVersion:\"cold26-original137-combined-custody-v1\",observedAt:new Date().toISOString(),cutoff:prior.cutoff,cohortHash:prior.cohortHash,sourceRefs:[base+\"r13-cold25-original137-custody-assessment-424d5.json\",assessmentRef,instrumentRef],readback:[{path:base+\"r13-cold25-original137-custody-assessment-424d5.json\",sha256:sha(priorText),exactFullReadback:true}],summary,newIds,rows:combinedRows,unresolvedSourceClassification:residue,prior88PreservedExactly:preserved,limits:instrument.limits};\nconst combinedText=JSON.stringify(combined,null,2);writeFileSync(\"/tmp/parked-cold26-combined-save.json\",JSON.stringify({slug:\"papercusp\",rel_path:base+\"r13-cold26-original137-custody-assessment-424d5.json\",content:combinedText}));\nconsole.log(JSON.stringify({summary,newIds,controls:{passed:controls.passed,failed:controls.failed},artifacts:[{kind:\"instrument\",chars:instrumentText.length,sha256:sha(instrumentText)},{kind:\"assessment\",chars:assessmentText.length,sha256:sha(assessmentText)},{kind:\"combined\",chars:combinedText.length,sha256:sha(combinedText)}]}));\n\n",
  "controls": {
    "passed": 50,
    "failed": 0,
    "sourcePrefixExact": true
  },
  "newIds": [
    "35020841",
    "35063976",
    "35064368",
    "35133707"
  ],
  "analysisFixes": [
    "Continue AST traversal through unrecognized outer calls; deferred bodies still rejected.",
    "Recursively require each nearest preceding same-session yield/wait to carry exact same cell and original call timestamp.",
    "Decode only exact two capability-probe preludes from fully retained receipts.",
    "Reject ambiguous TOON root frames and duplicates; failed controls preserved in instrument."
  ],
  "remainingSourceFindings": [
    "45 original requests remain unresolved; preserve all92 complete original custody records byte-for-byte.",
    "34938104 original literal ptool call120 matches but response121 is yield. Original same-cell wait122/result123 exists in lineage; actual result123 is clipped2023chars with955 omitted. Do not accept or infer its queued result.",
    "35232736 nested tools[n] call197 now matches literal args, but actual wait199/result200 is clipped2024chars with1059 omitted. Do not accept its prefix.",
    "Seven unresolved rows have some full pair, but most are unrelated calls or intermediate yields. All flags must belong to one complete original pair.",
    "11 unresolved rows have no assessed pair; source_candidates excludes some waits that do exist in original lineage. Before expanding candidates, read exact call/result fullsource and validate same-session,adjacency,cell and no-clipping controls; no source-completeness relaxation."
  ],
  "next": "Recover only45 remaining original receipt sources (including exact original native/archive custody) under EI-25855583682954393 and WI-6554700010008887. If source-loss is established, attribute durably without converting unknown to eligible or excluding failure. Then whole116 model/account/carry continuity and eligibility before any outcome join.",
  "limits": [
    "Same approved SELF/AUTO/P-013 only; no route change or LIVE_GATE_OPS.",
    "No successful product-test rerun or terminal-item redo.",
    "R5/root961/R12/malformed-native/source-loss attribution/finalALLfix runtime anchor and actual>=24hR14 remain open. All6 held items remain open.",
    "Native processes completed and no process handle or file lock is carried."
  ]
}
