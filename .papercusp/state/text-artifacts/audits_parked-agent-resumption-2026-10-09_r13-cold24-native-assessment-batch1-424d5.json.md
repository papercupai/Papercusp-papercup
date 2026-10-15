---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch1-424d5.json"
updated_at: 1791893529992
_body: "content"
---

{
  "schemaVersion": "cold24-indexed-native-shell-assessment-v1",
  "observedAt": "2026-10-13T12:12:08Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch1-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json"
  ],
  "parser": "import ts from \"typescript\";\nimport {decode} from \"./libs/generic/result-encoding/src/encode.ts\";\nimport {parseJsonWithTrailer} from \"./libs/generic/tooldef/src/code-orchestration/json-prefix.ts\";\nconst input=await Bun.stdin.json();\nfunction receipt(text){\n const oi=text.indexOf(\"Output:\\n\"), b=oi>=0?text.slice(oi+8).trim():text.trim();\n const matches=[],errors=[];\n const decodeBody=(str,meta={})=>{\n  let body,fmt=\"json\";\n  try{const m=/^format: (\\S+)\\n/.exec(str);fmt=m?.[1]||\"json\";body=m?decode(str.slice(m[0].length),m[1]):JSON.parse(str);}\n  catch(e){errors.push({error:\"decode\",detail:String(e)});return;}\n  if(body&&typeof body===\"object\"&&typeof body.requested===\"boolean\"&&(\"respawn\" in body||\"error\" in body)){\n   matches.push({body,format:fmt,...meta});\n  }\n };\n const walk=(x,path=\"$\")=>{\n  if(typeof x===\"string\"){if(/^format: \\S+\\n/.test(x)||/^[\\[{\"]/.test(x.trim()))decodeBody(x,{path,textBlocks:null});return;} if(!x||typeof x!==\"object\")return; if(x.type===\"text\"&&typeof x.text===\"string\"){decodeBody(x.text,{path,textBlocks:null});return;}\n  if(typeof x.requested===\"boolean\"&&(\"respawn\" in x||\"error\" in x)){matches.push({body:x,format:\"json\",path,textBlocks:null});return;} if(Array.isArray(x)){x.forEach((v,i)=>walk(v,path+\"[\"+i+\"]\"));return;}\n  if(Array.isArray(x.content)){\n   const blocks=x.content.map(v=>typeof v===\"string\"?v:v?.type===\"text\"?v.text:null).filter(v=>typeof v===\"string\");\n   if(x.structuredContent&&typeof x.structuredContent.requested===\"boolean\"){\n    matches.push({body:x.structuredContent,format:\"structuredContent\",isError:x.isError===true,textBlocks:blocks.length,path});\n   }else for(let i=0;i<blocks.length;i++)decodeBody(blocks[i],{isError:x.isError===true,textBlocks:blocks.length,path:path+\".text[\"+i+\"]\",contentShape:x.content.every(v=>typeof v===\"string\")?\"text-strings\":\"MCP-blocks\"});\n   return;\n  }\n  for(const [key,value] of Object.entries(x))walk(value,path+\".\"+key);\n };\n if(/^format: \\S+\\n/.test(b))decodeBody(b,{textBlocks:null,path:\"$direct-format\"});\n else{\n  let v;try{v=JSON.parse(b);}catch{const pp=parseJsonWithTrailer(b);if(pp)v=pp.value;}\n  if(v===undefined){\n   const lines=b.split(\"\\n\").filter(x=>x.trim());\n   try{const stream=lines.map(x=>JSON.parse(x));if(stream.length<2)throw Error(\"not-stream\");stream.forEach((x,i)=>walk(x,\"$stream[\"+i+\"]\"));}\n   catch{return {error:\"no-leading-json-format-or-complete-json-stream\"};}\n  }else walk(v);\n }\n return matches.length===1?matches[0]:{error:matches.length>1?\"multiple-compaction-bodies\":\"no-compaction-body\",matches:matches.length,errors};\n}\n\nconst stable=v=>v===null||typeof v!==\"object\"?JSON.stringify(v):Array.isArray(v)?\"[\"+v.map(stable).join(\",\")+\"]\":\"{\"+Object.keys(v).sort().map(k=>JSON.stringify(k)+\":\"+stable(v[k])).join(\",\")+\"}\";\nconst clipped=s=>/…\\s*\\[truncated|\\[truncated \\d+ chars\\]/i.test(s);\nfunction exactCalls(text){\n const sf=ts.createSourceFile(\"source.ts\",text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),bindings=new Map(),out=[];\n for(const s of sf.statements)if(ts.isVariableStatement(s)&&(s.declarationList.flags&ts.NodeFlags.Const))for(const d of s.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer)bindings.set(d.name.text,d.initializer);\n const changed=new Set();\n const mutations=n=>{if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){let x=n.left;while(ts.isPropertyAccessExpression(x)||ts.isElementAccessExpression(x))x=x.expression;if(ts.isIdentifier(x))changed.add(x.text);}ts.forEachChild(n,mutations);};mutations(sf);\n const evaluating=new Set();\n function literal(n){\n  if(ts.isParenthesizedExpression(n)||ts.isAsExpression(n))return literal(n.expression);\n  if(ts.isIdentifier(n)){if(changed.has(n.text)||!bindings.has(n.text)||evaluating.has(n.text))throw Error(\"unsafe binding \"+n.text);evaluating.add(n.text);try{return literal(bindings.get(n.text));}finally{evaluating.delete(n.text);}}\n  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;\n  if(ts.isNumericLiteral(n))return Number(n.text);\n  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;\n  if(ts.isObjectLiteralExpression(n)){const r={};for(const p of n.properties){if(ts.isShorthandPropertyAssignment(p))r[p.name.text]=literal(p.name);else if(ts.isPropertyAssignment(p)&&p.name.text!==undefined)r[p.name.text]=literal(p.initializer);else throw Error(\"nonliteral property\");}return r;}\n  if(ts.isArrayLiteralExpression(n))return n.elements.map(literal);\n  throw Error(\"nonliteral \"+ts.SyntaxKind[n.kind]);\n }\n const path=n=>{const p=[];for(let x=n;x.parent;x=x.parent)if(ts.isIfStatement(x.parent))p.push({ifPos:x.parent.pos,branch:x===x.parent.thenStatement?\"then\":x===x.parent.elseStatement?\"else\":\"condition\"});return p;};\n const walk=n=>{if(ts.isCallExpression(n)){const name=n.expression.getText(sf);try{\n  let args,mechanism;\n  if(/session_request_compaction$|session\\.request_compaction$/.test(name)){args=literal(n.arguments[0]);mechanism=\"native-wrapper\";}\n  else if(/tools[_\\.]invoke$|\\.invoke$/.test(name)){const a=literal(n.arguments[0]);if(a.name===\"session:request-compaction\"){args=a.args;mechanism=\"invoke\";}}\n  else if(/exec_command$/.test(name)){const a=literal(n.arguments[0]);if(typeof a.cmd===\"string\"&&/^ptool session:request-compaction(?:\\s|$)/.test(a.cmd)){const m=/<<'JSON'\\n([\\s\\S]*?)\\nJSON(?:\\n|$)/.exec(a.cmd);if(!m)throw Error(\"no exact quoted JSON heredoc\");args=JSON.parse(m[1]);mechanism=\"ptool-quoted-json\";}}\n  if(args)out.push({args,mechanism,path:path(n)});\n }catch(e){out.push({error:String(e)});}}ts.forEachChild(n,walk);};walk(sf);\n return {parseErrors:sf.parseDiagnostics.length,calls:out};\n}\nfunction onePath(calls){\n if(calls.length===1)return true;if(calls.length!==2)return false;\n return calls[0].path.some(a=>a.branch!==\"condition\"&&calls[1].path.some(b=>a.ifPos===b.ifPos&&b.branch!==\"condition\"&&a.branch!==b.branch));\n}\nfunction assess(t){\n const ledger=t.ledger,src=t.source,parts=t.lineage||[],found=[];\n for(const c of src.source_candidates){\n  let call=c,result=c.following_parts.find(x=>x.part_kind===\"tool_result\"&&x.part_idx===c.part_idx+1),chain=null;\n  if(c.tool_name===\"wait\"){\n   let w;try{w=JSON.parse(c.text);}catch{continue;}\n   const y=parts.filter(x=>x.part_idx<c.part_idx&&x.part_kind===\"tool_result\"&&new RegExp(\"^Script running with cell ID \"+w.cell_id+\"(?:\\\\n|$)\").test(x.text)).at(-1);\n   if(!y)continue;call=parts.find(x=>x.part_idx===y.part_idx-1&&x.part_kind===\"tool_use\");if(!call)continue;\n   const intervening=parts.filter(x=>x.part_idx>y.part_idx&&x.part_idx<=c.part_idx&&x.part_kind===\"tool_use\");\n   if(!intervening.every(x=>x.tool_name===\"wait\"&&JSON.parse(x.text).cell_id===w.cell_id))continue;\n   chain={cellId:w.cell_id,yieldPart:y.part_idx,waitPart:c.part_idx,originalCallPart:call.part_idx};call={...call,session_id:c.session_id};\n  }\n  if(!result)continue;\n  const parsed=exactCalls(call.text),matches=parsed.calls.filter(x=>x.args&&stable(x.args)===stable(ledger.args_json));\n  const decoded=receipt(result.text.replace(\"compaction_request=format: \",\"format: \")),body=decoded.body;\n  const state=body?.requested===true&&body.respawn===\"queued\"?\"queued\":body?.requested===false&&body.error===\"flush-required\"?\"flush-refused\":body?.ok===false&&body.requested===false&&body.error===\"no_live_pty_host\"?\"no-host-refused\":\"unclassified\";\n  const statusAgrees=state===\"queued\"?ledger.status===\"ok\":state.endsWith(\"refused\")?ledger.status===\"refused\":false;\n  const ownerEqual=src.owner===ledger.coord_owner_id&&(call.owner===undefined||call.owner===src.owner);\n  const bounds=Date.parse(call.ts)<=Date.parse(ledger.invoked_at)-Number(ledger.duration_ms)+1000&&Date.parse(result.ts)>=Date.parse(ledger.invoked_at)-1000&&Date.parse(result.ts)>=Date.parse(call.ts);\n  const sourceComplete=!clipped(call.text)&&!clipped(result.text);\n  const complete=parsed.parseErrors===0&&matches.length>0&&onePath(matches)&&body&&statusAgrees&&ownerEqual&&bounds&&sourceComplete;\n  found.push({nativeSession:call.session_id,callPart:call.part_idx,resultPart:result.part_idx,callTimestamp:call.ts,responseTimestamp:result.ts,mechanisms:matches.map(x=>x.mechanism),conditionalAlternatives:matches.length===2,chain,literalArgsEqual:matches.length>0,ownerEqual,bounds,sourceComplete,parseErrors:parsed.parseErrors,receiptState:state,statusAgrees,format:decoded.format,requested:body?.requested,respawn:body?.respawn,error:body?.error,completeOriginalPair:!!complete});\n }\n const unique=found.filter(x=>x.completeOriginalPair);return {request_id:String(ledger.id),owner:src.owner,completeOriginalPair:unique.length===1,pairs:found,receiptState:unique.length===1?unique[0].receiptState:\"unresolved\",outcomeJoined:false};\n}\nconst output=input.targets.map(assess);console.log(JSON.stringify({rows:output}));",
  "method": "Unchanged Cold23 processor; each candidate and lineage are isolated to its exact native session; original row is then deduplicated by native call/result pair. Python sends JSON via subprocess stdin, outside shell argv.",
  "rows": [
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32216380",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 107,
          "resultPart": 108,
          "callTimestamp": "2026-10-06T12:43:18.775+00:00",
          "responseTimestamp": "2026-10-06T12:43:26.168+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-06T12:43:34.417+00:00",
          "responseTimestamp": "2026-10-06T12:44:04.626+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32231391",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 70,
          "resultPart": 74,
          "callTimestamp": "2026-10-06T13:11:35.718+00:00",
          "responseTimestamp": "2026-10-06T13:12:35.635+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "30",
            "yieldPart": 71,
            "waitPart": 73,
            "originalCallPart": 70
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32243511",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a11158-b6c7-7c23-8712-bc632b5004fa",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-06T13:34:56.224+00:00",
          "responseTimestamp": "2026-10-06T13:34:59.831+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "32259530",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1116d-047a-71f2-a719-b43eb100ae49",
          "callPart": 86,
          "resultPart": 87,
          "callTimestamp": "2026-10-06T14:02:33.078+00:00",
          "responseTimestamp": "2026-10-06T14:02:42.046+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1116d-047a-71f2-a719-b43eb100ae49",
          "callPart": 88,
          "resultPart": 89,
          "callTimestamp": "2026-10-06T14:02:59.857+00:00",
          "responseTimestamp": "2026-10-06T14:03:30.244+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34800973",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a121a0-ce00-7b80-878e-b7de5741bed6",
          "callPart": 177,
          "resultPart": 178,
          "callTimestamp": "2026-10-09T17:34:48.362+00:00",
          "responseTimestamp": "2026-10-09T17:35:09.495+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34805876",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a121ba-c573-7653-bef3-77028f51c4b1",
          "callPart": 76,
          "resultPart": 77,
          "callTimestamp": "2026-10-09T17:46:12.885+00:00",
          "responseTimestamp": "2026-10-09T17:46:15.91+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a121ba-c573-7653-bef3-77028f51c4b1",
          "callPart": 79,
          "resultPart": 80,
          "callTimestamp": "2026-10-09T17:46:26.055+00:00",
          "responseTimestamp": "2026-10-09T17:46:48.095+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34831365",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34840615",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T18:51:17.671+00:00",
          "responseTimestamp": "2026-10-09T18:51:17.735+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 122,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T18:51:34.793+00:00",
          "responseTimestamp": "2026-10-09T18:51:39.693+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 4,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34863926",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
          "callPart": 121,
          "resultPart": 122,
          "callTimestamp": "2026-10-09T19:33:42.959+00:00",
          "responseTimestamp": "2026-10-09T19:33:44.975+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34866872",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
          "callPart": 129,
          "resultPart": 132,
          "callTimestamp": "2026-10-09T19:38:29.111+00:00",
          "responseTimestamp": "2026-10-09T19:39:03.545+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "58",
            "yieldPart": 130,
            "waitPart": 131,
            "originalCallPart": 129
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34882439",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
          "callPart": 148,
          "resultPart": 149,
          "callTimestamp": "2026-10-09T20:10:47.778+00:00",
          "responseTimestamp": "2026-10-09T20:10:47.825+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
          "callPart": 150,
          "resultPart": 151,
          "callTimestamp": "2026-10-09T20:10:57.792+00:00",
          "responseTimestamp": "2026-10-09T20:11:13.627+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "34886663",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 165,
          "resultPart": 166,
          "callTimestamp": "2026-10-09T20:17:24.991+00:00",
          "responseTimestamp": "2026-10-09T20:17:52.084+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 168,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:40.031+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 170,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:43.48+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "62",
            "yieldPart": 168,
            "waitPart": 169,
            "originalCallPart": 167
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34887447",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
          "callPart": 125,
          "resultPart": 126,
          "callTimestamp": "2026-10-09T20:19:55.221+00:00",
          "responseTimestamp": "2026-10-09T20:19:57.857+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34888135",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34897845",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 137,
          "resultPart": 138,
          "callTimestamp": "2026-10-09T20:33:51.409+00:00",
          "responseTimestamp": "2026-10-09T20:34:20.249+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 140,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:34:58.203+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 142,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:35:19.153+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "63",
            "yieldPart": 140,
            "waitPart": 141,
            "originalCallPart": 139
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "34911877",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 83,
          "resultPart": 86,
          "callTimestamp": "2026-10-09T21:00:27.287+00:00",
          "responseTimestamp": "2026-10-09T21:01:03.633+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "32",
            "yieldPart": 84,
            "waitPart": 85,
            "originalCallPart": 83
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 87,
          "resultPart": 88,
          "callTimestamp": "2026-10-09T21:01:10.291+00:00",
          "responseTimestamp": "2026-10-09T21:01:29.144+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34912704",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 134,
          "resultPart": 135,
          "callTimestamp": "2026-10-09T21:01:38.777+00:00",
          "responseTimestamp": "2026-10-09T21:01:38.839+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:39.911+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 141,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:53.226+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 139,
            "waitPart": 140,
            "originalCallPart": 138
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 140,
          "resultPart": 143,
          "callTimestamp": "2026-10-09T21:02:42.218+00:00",
          "responseTimestamp": "2026-10-09T21:02:56.38+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 141,
            "waitPart": 142,
            "originalCallPart": 140
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34924375",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a12278-2e15-7521-82f2-816b032ce988",
          "callPart": 114,
          "resultPart": 115,
          "callTimestamp": "2026-10-09T21:22:43.468+00:00",
          "responseTimestamp": "2026-10-09T21:23:01.019+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34925297",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "callPart": 112,
          "resultPart": 113,
          "callTimestamp": "2026-10-09T21:24:24.14+00:00",
          "responseTimestamp": "2026-10-09T21:24:24.182+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "callPart": 114,
          "resultPart": 115,
          "callTimestamp": "2026-10-09T21:24:29.343+00:00",
          "responseTimestamp": "2026-10-09T21:24:46.238+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "34937571",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 89,
          "resultPart": 90,
          "callTimestamp": "2026-10-09T21:45:05.932+00:00",
          "responseTimestamp": "2026-10-09T21:45:12.504+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 92,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:48.475+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 94,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:51.529+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": {
            "cellId": "39",
            "yieldPart": 92,
            "waitPart": 93,
            "originalCallPart": 91
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34938104",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:45.459+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:50.775+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "51",
            "yieldPart": 121,
            "waitPart": 122,
            "originalCallPart": 120
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "34952665",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-09T22:12:40.227+00:00",
          "responseTimestamp": "2026-10-09T22:12:41.672+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "34967591",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
          "callPart": 80,
          "resultPart": 81,
          "callTimestamp": "2026-10-09T22:44:14.079+00:00",
          "responseTimestamp": "2026-10-09T22:44:17.1+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    }
  ],
  "sessionAssessments": [
    {
      "request_id": "32216380",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 107,
          "resultPart": 108,
          "callTimestamp": "2026-10-06T12:43:18.775+00:00",
          "responseTimestamp": "2026-10-06T12:43:26.168+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-06T12:43:34.417+00:00",
          "responseTimestamp": "2026-10-06T12:44:04.626+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "32231391",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
          "callPart": 70,
          "resultPart": 74,
          "callTimestamp": "2026-10-06T13:11:35.718+00:00",
          "responseTimestamp": "2026-10-06T13:12:35.635+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "30",
            "yieldPart": 71,
            "waitPart": 73,
            "originalCallPart": 70
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "32243511",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a11158-b6c7-7c23-8712-bc632b5004fa",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-06T13:34:56.224+00:00",
          "responseTimestamp": "2026-10-06T13:34:59.831+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "32259530",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1116d-047a-71f2-a719-b43eb100ae49",
          "callPart": 86,
          "resultPart": 87,
          "callTimestamp": "2026-10-06T14:02:33.078+00:00",
          "responseTimestamp": "2026-10-06T14:02:42.046+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1116d-047a-71f2-a719-b43eb100ae49",
          "callPart": 88,
          "resultPart": 89,
          "callTimestamp": "2026-10-06T14:02:59.857+00:00",
          "responseTimestamp": "2026-10-06T14:03:30.244+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "34800973",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a121a0-ce00-7b80-878e-b7de5741bed6",
          "callPart": 177,
          "resultPart": 178,
          "callTimestamp": "2026-10-09T17:34:48.362+00:00",
          "responseTimestamp": "2026-10-09T17:35:09.495+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "34805876",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a121ba-c573-7653-bef3-77028f51c4b1",
          "callPart": 76,
          "resultPart": 77,
          "callTimestamp": "2026-10-09T17:46:12.885+00:00",
          "responseTimestamp": "2026-10-09T17:46:15.91+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a121ba-c573-7653-bef3-77028f51c4b1",
          "callPart": 79,
          "resultPart": 80,
          "callTimestamp": "2026-10-09T17:46:26.055+00:00",
          "responseTimestamp": "2026-10-09T17:46:48.095+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "34840615",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T18:51:17.671+00:00",
          "responseTimestamp": "2026-10-09T18:51:17.735+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
          "callPart": 122,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T18:51:34.793+00:00",
          "responseTimestamp": "2026-10-09T18:51:39.693+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 4,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34863926",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
          "callPart": 121,
          "resultPart": 122,
          "callTimestamp": "2026-10-09T19:33:42.959+00:00",
          "responseTimestamp": "2026-10-09T19:33:44.975+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34866872",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
          "callPart": 129,
          "resultPart": 132,
          "callTimestamp": "2026-10-09T19:38:29.111+00:00",
          "responseTimestamp": "2026-10-09T19:39:03.545+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "58",
            "yieldPart": 130,
            "waitPart": 131,
            "originalCallPart": 129
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34882439",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
          "callPart": 148,
          "resultPart": 149,
          "callTimestamp": "2026-10-09T20:10:47.778+00:00",
          "responseTimestamp": "2026-10-09T20:10:47.825+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
          "callPart": 150,
          "resultPart": 151,
          "callTimestamp": "2026-10-09T20:10:57.792+00:00",
          "responseTimestamp": "2026-10-09T20:11:13.627+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "34886663",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 165,
          "resultPart": 166,
          "callTimestamp": "2026-10-09T20:17:24.991+00:00",
          "responseTimestamp": "2026-10-09T20:17:52.084+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 168,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:40.031+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
          "callPart": 167,
          "resultPart": 170,
          "callTimestamp": "2026-10-09T20:18:08.976+00:00",
          "responseTimestamp": "2026-10-09T20:18:43.48+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "62",
            "yieldPart": 168,
            "waitPart": 169,
            "originalCallPart": 167
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34887447",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
          "callPart": 125,
          "resultPart": 126,
          "callTimestamp": "2026-10-09T20:19:55.221+00:00",
          "responseTimestamp": "2026-10-09T20:19:57.857+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34897845",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 137,
          "resultPart": 138,
          "callTimestamp": "2026-10-09T20:33:51.409+00:00",
          "responseTimestamp": "2026-10-09T20:34:20.249+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 140,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:34:58.203+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
          "callPart": 139,
          "resultPart": 142,
          "callTimestamp": "2026-10-09T20:34:27.166+00:00",
          "responseTimestamp": "2026-10-09T20:35:19.153+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "63",
            "yieldPart": 140,
            "waitPart": 141,
            "originalCallPart": 139
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34911877",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 83,
          "resultPart": 86,
          "callTimestamp": "2026-10-09T21:00:27.287+00:00",
          "responseTimestamp": "2026-10-09T21:01:03.633+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "32",
            "yieldPart": 84,
            "waitPart": 85,
            "originalCallPart": 83
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
          "callPart": 87,
          "resultPart": 88,
          "callTimestamp": "2026-10-09T21:01:10.291+00:00",
          "responseTimestamp": "2026-10-09T21:01:29.144+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34912704",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 134,
          "resultPart": 135,
          "callTimestamp": "2026-10-09T21:01:38.777+00:00",
          "responseTimestamp": "2026-10-09T21:01:38.839+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:39.911+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 138,
          "resultPart": 141,
          "callTimestamp": "2026-10-09T21:02:07.475+00:00",
          "responseTimestamp": "2026-10-09T21:02:53.226+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 139,
            "waitPart": 140,
            "originalCallPart": 138
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
          "callPart": 140,
          "resultPart": 143,
          "callTimestamp": "2026-10-09T21:02:42.218+00:00",
          "responseTimestamp": "2026-10-09T21:02:56.38+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "55",
            "yieldPart": 141,
            "waitPart": 142,
            "originalCallPart": 140
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34924375",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a12278-2e15-7521-82f2-816b032ce988",
          "callPart": 114,
          "resultPart": 115,
          "callTimestamp": "2026-10-09T21:22:43.468+00:00",
          "responseTimestamp": "2026-10-09T21:23:01.019+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "34925297",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "callPart": 112,
          "resultPart": 113,
          "callTimestamp": "2026-10-09T21:24:24.14+00:00",
          "responseTimestamp": "2026-10-09T21:24:24.182+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
          "callPart": 114,
          "resultPart": 115,
          "callTimestamp": "2026-10-09T21:24:29.343+00:00",
          "responseTimestamp": "2026-10-09T21:24:46.238+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "34937571",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 89,
          "resultPart": 90,
          "callTimestamp": "2026-10-09T21:45:05.932+00:00",
          "responseTimestamp": "2026-10-09T21:45:12.504+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 92,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:48.475+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
          "callPart": 91,
          "resultPart": 94,
          "callTimestamp": "2026-10-09T21:45:17.434+00:00",
          "responseTimestamp": "2026-10-09T21:45:51.529+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
          "chain": {
            "cellId": "39",
            "yieldPart": 92,
            "waitPart": 93,
            "originalCallPart": 91
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34938104",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 121,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:45.459+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
          "callPart": 120,
          "resultPart": 123,
          "callTimestamp": "2026-10-09T21:46:14.411+00:00",
          "responseTimestamp": "2026-10-09T21:46:50.775+00:00",
          "mechanisms": [
            "ptool-quoted-json"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "51",
            "yieldPart": 121,
            "waitPart": 122,
            "originalCallPart": 120
          },
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34952665",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
          "callPart": 109,
          "resultPart": 110,
          "callTimestamp": "2026-10-09T22:12:40.227+00:00",
          "responseTimestamp": "2026-10-09T22:12:41.672+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "toon",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34967591",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
          "callPart": 80,
          "resultPart": 81,
          "callTimestamp": "2026-10-09T22:44:14.079+00:00",
          "responseTimestamp": "2026-10-09T22:44:17.1+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    }
  ],
  "executions": [
    {
      "request_id": "32216380",
      "nativeSession": "01a1112b-5115-7990-a36b-c354420236b0",
      "exitCode": 0,
      "seconds": 0.33419053396210074,
      "inputBytes": 35247,
      "stdout": "{\"rows\":[{\"request_id\":\"32216380\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1112b-5115-7990-a36b-c354420236b0\",\"callPart\":107,\"resultPart\":108,\"callTimestamp\":\"2026-10-06T12:43:18.775+00:00\",\"responseTimestamp\":\"2026-10-06T12:43:26.168+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1112b-5115-7990-a36b-c354420236b0\",\"callPart\":109,\"resultPart\":110,\"callTimestamp\":\"2026-10-06T12:43:34.417+00:00\",\"responseTimestamp\":\"2026-10-06T12:44:04.626+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "32231391",
      "nativeSession": "01a1113e-65dd-7822-9033-cde625ea52e3",
      "exitCode": 0,
      "seconds": 0.331609882065095,
      "inputBytes": 16018,
      "stdout": "{\"rows\":[{\"request_id\":\"32231391\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1113e-65dd-7822-9033-cde625ea52e3\",\"callPart\":70,\"resultPart\":74,\"callTimestamp\":\"2026-10-06T13:11:35.718+00:00\",\"responseTimestamp\":\"2026-10-06T13:12:35.635+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"30\",\"yieldPart\":71,\"waitPart\":73,\"originalCallPart\":70},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "32243511",
      "nativeSession": "01a11158-b6c7-7c23-8712-bc632b5004fa",
      "exitCode": 0,
      "seconds": 0.29424263595137745,
      "inputBytes": 13224,
      "stdout": "{\"rows\":[{\"request_id\":\"32243511\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a11158-b6c7-7c23-8712-bc632b5004fa\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-06T13:34:56.224+00:00\",\"responseTimestamp\":\"2026-10-06T13:34:59.831+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "32259530",
      "nativeSession": "01a1116d-047a-71f2-a719-b43eb100ae49",
      "exitCode": 0,
      "seconds": 0.30766341101843864,
      "inputBytes": 25472,
      "stdout": "{\"rows\":[{\"request_id\":\"32259530\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1116d-047a-71f2-a719-b43eb100ae49\",\"callPart\":86,\"resultPart\":87,\"callTimestamp\":\"2026-10-06T14:02:33.078+00:00\",\"responseTimestamp\":\"2026-10-06T14:02:42.046+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1116d-047a-71f2-a719-b43eb100ae49\",\"callPart\":88,\"resultPart\":89,\"callTimestamp\":\"2026-10-06T14:02:59.857+00:00\",\"responseTimestamp\":\"2026-10-06T14:03:30.244+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34800973",
      "nativeSession": "01a121a0-ce00-7b80-878e-b7de5741bed6",
      "exitCode": 0,
      "seconds": 0.29992093797773123,
      "inputBytes": 9459,
      "stdout": "{\"rows\":[{\"request_id\":\"34800973\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a121a0-ce00-7b80-878e-b7de5741bed6\",\"callPart\":177,\"resultPart\":178,\"callTimestamp\":\"2026-10-09T17:34:48.362+00:00\",\"responseTimestamp\":\"2026-10-09T17:35:09.495+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34805876",
      "nativeSession": "01a121ba-c573-7653-bef3-77028f51c4b1",
      "exitCode": 0,
      "seconds": 0.3156756979878992,
      "inputBytes": 27553,
      "stdout": "{\"rows\":[{\"request_id\":\"34805876\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a121ba-c573-7653-bef3-77028f51c4b1\",\"callPart\":76,\"resultPart\":77,\"callTimestamp\":\"2026-10-09T17:46:12.885+00:00\",\"responseTimestamp\":\"2026-10-09T17:46:15.91+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a121ba-c573-7653-bef3-77028f51c4b1\",\"callPart\":79,\"resultPart\":80,\"callTimestamp\":\"2026-10-09T17:46:26.055+00:00\",\"responseTimestamp\":\"2026-10-09T17:46:48.095+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34840615",
      "nativeSession": "01a121f3-2211-7912-b4f6-78fd26b41ca4",
      "exitCode": 0,
      "seconds": 0.3139884400879964,
      "inputBytes": 42178,
      "stdout": "{\"rows\":[{\"request_id\":\"34840615\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a121f3-2211-7912-b4f6-78fd26b41ca4\",\"callPart\":120,\"resultPart\":121,\"callTimestamp\":\"2026-10-09T18:51:17.671+00:00\",\"responseTimestamp\":\"2026-10-09T18:51:17.735+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a121f3-2211-7912-b4f6-78fd26b41ca4\",\"callPart\":122,\"resultPart\":123,\"callTimestamp\":\"2026-10-09T18:51:34.793+00:00\",\"responseTimestamp\":\"2026-10-09T18:51:39.693+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":4,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34863926",
      "nativeSession": "01a12212-c9fe-7921-bc00-6644cf505bab",
      "exitCode": 0,
      "seconds": 0.33110835892148316,
      "inputBytes": 33543,
      "stdout": "{\"rows\":[{\"request_id\":\"34863926\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12212-c9fe-7921-bc00-6644cf505bab\",\"callPart\":121,\"resultPart\":122,\"callTimestamp\":\"2026-10-09T19:33:42.959+00:00\",\"responseTimestamp\":\"2026-10-09T19:33:44.975+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34866872",
      "nativeSession": "01a12215-f913-74d0-8930-463399a84938",
      "exitCode": 0,
      "seconds": 0.38729325204622,
      "inputBytes": 19660,
      "stdout": "{\"rows\":[{\"request_id\":\"34866872\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12215-f913-74d0-8930-463399a84938\",\"callPart\":129,\"resultPart\":132,\"callTimestamp\":\"2026-10-09T19:38:29.111+00:00\",\"responseTimestamp\":\"2026-10-09T19:39:03.545+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"58\",\"yieldPart\":130,\"waitPart\":131,\"originalCallPart\":129},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34882439",
      "nativeSession": "01a1222c-d097-7e31-abe1-3d9adafedc1d",
      "exitCode": 0,
      "seconds": 0.3545466420473531,
      "inputBytes": 17529,
      "stdout": "{\"rows\":[{\"request_id\":\"34882439\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1222c-d097-7e31-abe1-3d9adafedc1d\",\"callPart\":148,\"resultPart\":149,\"callTimestamp\":\"2026-10-09T20:10:47.778+00:00\",\"responseTimestamp\":\"2026-10-09T20:10:47.825+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1222c-d097-7e31-abe1-3d9adafedc1d\",\"callPart\":150,\"resultPart\":151,\"callTimestamp\":\"2026-10-09T20:10:57.792+00:00\",\"responseTimestamp\":\"2026-10-09T20:11:13.627+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34886663",
      "nativeSession": "01a1222f-4f0d-71b2-b283-fb4c74b79830",
      "exitCode": 0,
      "seconds": 0.42406728805508465,
      "inputBytes": 25598,
      "stdout": "{\"rows\":[{\"request_id\":\"34886663\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1222f-4f0d-71b2-b283-fb4c74b79830\",\"callPart\":165,\"resultPart\":166,\"callTimestamp\":\"2026-10-09T20:17:24.991+00:00\",\"responseTimestamp\":\"2026-10-09T20:17:52.084+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1222f-4f0d-71b2-b283-fb4c74b79830\",\"callPart\":167,\"resultPart\":168,\"callTimestamp\":\"2026-10-09T20:18:08.976+00:00\",\"responseTimestamp\":\"2026-10-09T20:18:40.031+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1222f-4f0d-71b2-b283-fb4c74b79830\",\"callPart\":167,\"resultPart\":170,\"callTimestamp\":\"2026-10-09T20:18:08.976+00:00\",\"responseTimestamp\":\"2026-10-09T20:18:43.48+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"62\",\"yieldPart\":168,\"waitPart\":169,\"originalCallPart\":167},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34887447",
      "nativeSession": "01a1223d-8d3b-73d2-ba27-19a009e9bfc7",
      "exitCode": 0,
      "seconds": 0.3717874090652913,
      "inputBytes": 28087,
      "stdout": "{\"rows\":[{\"request_id\":\"34887447\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1223d-8d3b-73d2-ba27-19a009e9bfc7\",\"callPart\":125,\"resultPart\":126,\"callTimestamp\":\"2026-10-09T20:19:55.221+00:00\",\"responseTimestamp\":\"2026-10-09T20:19:57.857+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34897845",
      "nativeSession": "01a1224b-a4da-7813-8679-5959b1e641f6",
      "exitCode": 0,
      "seconds": 0.39141023193951696,
      "inputBytes": 27890,
      "stdout": "{\"rows\":[{\"request_id\":\"34897845\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1224b-a4da-7813-8679-5959b1e641f6\",\"callPart\":137,\"resultPart\":138,\"callTimestamp\":\"2026-10-09T20:33:51.409+00:00\",\"responseTimestamp\":\"2026-10-09T20:34:20.249+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1224b-a4da-7813-8679-5959b1e641f6\",\"callPart\":139,\"resultPart\":140,\"callTimestamp\":\"2026-10-09T20:34:27.166+00:00\",\"responseTimestamp\":\"2026-10-09T20:34:58.203+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1224b-a4da-7813-8679-5959b1e641f6\",\"callPart\":139,\"resultPart\":142,\"callTimestamp\":\"2026-10-09T20:34:27.166+00:00\",\"responseTimestamp\":\"2026-10-09T20:35:19.153+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"63\",\"yieldPart\":140,\"waitPart\":141,\"originalCallPart\":139},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34911877",
      "nativeSession": "01a12263-9cc1-78b0-bc03-6f19c79a2fb0",
      "exitCode": 0,
      "seconds": 0.4525566640077159,
      "inputBytes": 14842,
      "stdout": "{\"rows\":[{\"request_id\":\"34911877\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12263-9cc1-78b0-bc03-6f19c79a2fb0\",\"callPart\":83,\"resultPart\":86,\"callTimestamp\":\"2026-10-09T21:00:27.287+00:00\",\"responseTimestamp\":\"2026-10-09T21:01:03.633+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"32\",\"yieldPart\":84,\"waitPart\":85,\"originalCallPart\":83},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12263-9cc1-78b0-bc03-6f19c79a2fb0\",\"callPart\":87,\"resultPart\":88,\"callTimestamp\":\"2026-10-09T21:01:10.291+00:00\",\"responseTimestamp\":\"2026-10-09T21:01:29.144+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34912704",
      "nativeSession": "01a12266-3e63-7283-821f-8cbcd5c543fa",
      "exitCode": 0,
      "seconds": 0.3985753540182486,
      "inputBytes": 30719,
      "stdout": "{\"rows\":[{\"request_id\":\"34912704\",\"owner\":\"su-ba80f2f7-46f6-4aec-b99a-21e02460933f\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":134,\"resultPart\":135,\"callTimestamp\":\"2026-10-09T21:01:38.777+00:00\",\"responseTimestamp\":\"2026-10-09T21:01:38.839+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":138,\"resultPart\":139,\"callTimestamp\":\"2026-10-09T21:02:07.475+00:00\",\"responseTimestamp\":\"2026-10-09T21:02:39.911+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":138,\"resultPart\":141,\"callTimestamp\":\"2026-10-09T21:02:07.475+00:00\",\"responseTimestamp\":\"2026-10-09T21:02:53.226+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"55\",\"yieldPart\":139,\"waitPart\":140,\"originalCallPart\":138},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12266-3e63-7283-821f-8cbcd5c543fa\",\"callPart\":140,\"resultPart\":143,\"callTimestamp\":\"2026-10-09T21:02:42.218+00:00\",\"responseTimestamp\":\"2026-10-09T21:02:56.38+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"55\",\"yieldPart\":141,\"waitPart\":142,\"originalCallPart\":140},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34924375",
      "nativeSession": "01a12278-2e15-7521-82f2-816b032ce988",
      "exitCode": 0,
      "seconds": 0.34867062408011407,
      "inputBytes": 21941,
      "stdout": "{\"rows\":[{\"request_id\":\"34924375\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a12278-2e15-7521-82f2-816b032ce988\",\"callPart\":114,\"resultPart\":115,\"callTimestamp\":\"2026-10-09T21:22:43.468+00:00\",\"responseTimestamp\":\"2026-10-09T21:23:01.019+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34925297",
      "nativeSession": "01a1227a-27b3-79c3-990b-b101d7ea9a6c",
      "exitCode": 0,
      "seconds": 0.40337541699409485,
      "inputBytes": 40399,
      "stdout": "{\"rows\":[{\"request_id\":\"34925297\",\"owner\":\"su-ba80f2f7-46f6-4aec-b99a-21e02460933f\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a1227a-27b3-79c3-990b-b101d7ea9a6c\",\"callPart\":112,\"resultPart\":113,\"callTimestamp\":\"2026-10-09T21:24:24.14+00:00\",\"responseTimestamp\":\"2026-10-09T21:24:24.182+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1227a-27b3-79c3-990b-b101d7ea9a6c\",\"callPart\":114,\"resultPart\":115,\"callTimestamp\":\"2026-10-09T21:24:29.343+00:00\",\"responseTimestamp\":\"2026-10-09T21:24:46.238+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34937571",
      "nativeSession": "01a1228f-1738-79e1-8225-adb923521fa8",
      "exitCode": 0,
      "seconds": 0.4812114289961755,
      "inputBytes": 27080,
      "stdout": "{\"rows\":[{\"request_id\":\"34937571\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1228f-1738-79e1-8225-adb923521fa8\",\"callPart\":89,\"resultPart\":90,\"callTimestamp\":\"2026-10-09T21:45:05.932+00:00\",\"responseTimestamp\":\"2026-10-09T21:45:12.504+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1228f-1738-79e1-8225-adb923521fa8\",\"callPart\":91,\"resultPart\":92,\"callTimestamp\":\"2026-10-09T21:45:17.434+00:00\",\"responseTimestamp\":\"2026-10-09T21:45:48.475+00:00\",\"mechanisms\":[\"native-wrapper\",\"invoke\"],\"conditionalAlternatives\":true,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1228f-1738-79e1-8225-adb923521fa8\",\"callPart\":91,\"resultPart\":94,\"callTimestamp\":\"2026-10-09T21:45:17.434+00:00\",\"responseTimestamp\":\"2026-10-09T21:45:51.529+00:00\",\"mechanisms\":[\"native-wrapper\",\"invoke\"],\"conditionalAlternatives\":true,\"chain\":{\"cellId\":\"39\",\"yieldPart\":92,\"waitPart\":93,\"originalCallPart\":91},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34938104",
      "nativeSession": "01a1228c-7bc5-76c2-ac09-038120bb49b5",
      "exitCode": 0,
      "seconds": 0.48851129109971225,
      "inputBytes": 36529,
      "stdout": "{\"rows\":[{\"request_id\":\"34938104\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1228c-7bc5-76c2-ac09-038120bb49b5\",\"callPart\":120,\"resultPart\":121,\"callTimestamp\":\"2026-10-09T21:46:14.411+00:00\",\"responseTimestamp\":\"2026-10-09T21:46:45.459+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1228c-7bc5-76c2-ac09-038120bb49b5\",\"callPart\":120,\"resultPart\":123,\"callTimestamp\":\"2026-10-09T21:46:14.411+00:00\",\"responseTimestamp\":\"2026-10-09T21:46:50.775+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"51\",\"yieldPart\":121,\"waitPart\":122,\"originalCallPart\":120},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34952665",
      "nativeSession": "01a122a7-e41a-7f92-9cfc-a825eca90ad8",
      "exitCode": 0,
      "seconds": 0.45489848498255014,
      "inputBytes": 14216,
      "stdout": "{\"rows\":[{\"request_id\":\"34952665\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122a7-e41a-7f92-9cfc-a825eca90ad8\",\"callPart\":109,\"resultPart\":110,\"callTimestamp\":\"2026-10-09T22:12:40.227+00:00\",\"responseTimestamp\":\"2026-10-09T22:12:41.672+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34967591",
      "nativeSession": "01a122c4-d22d-72b3-8c37-5ef6c96c94bb",
      "exitCode": 0,
      "seconds": 0.39497297699563205,
      "inputBytes": 29836,
      "stdout": "{\"rows\":[{\"request_id\":\"34967591\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122c4-d22d-72b3-8c37-5ef6c96c94bb\",\"callPart\":80,\"resultPart\":81,\"callTimestamp\":\"2026-10-09T22:44:14.079+00:00\",\"responseTimestamp\":\"2026-10-09T22:44:17.1+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    }
  ],
  "limits": [
    "Outcomes joined0; whole116 continuity/eligibility unaccepted.",
    "Original truncated source remains incomplete."
  ]
}
