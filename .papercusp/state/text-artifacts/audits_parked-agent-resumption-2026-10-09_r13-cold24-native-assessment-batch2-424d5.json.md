---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch2-424d5.json"
updated_at: 1791893558849
_body: "content"
---

{
  "schemaVersion": "cold24-indexed-native-shell-assessment-v1",
  "observedAt": "2026-10-13T12:12:37Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch2-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json"
  ],
  "parser": "import ts from \"typescript\";\nimport {decode} from \"./libs/generic/result-encoding/src/encode.ts\";\nimport {parseJsonWithTrailer} from \"./libs/generic/tooldef/src/code-orchestration/json-prefix.ts\";\nconst input=await Bun.stdin.json();\nfunction receipt(text){\n const oi=text.indexOf(\"Output:\\n\"), b=oi>=0?text.slice(oi+8).trim():text.trim();\n const matches=[],errors=[];\n const decodeBody=(str,meta={})=>{\n  let body,fmt=\"json\";\n  try{const m=/^format: (\\S+)\\n/.exec(str);fmt=m?.[1]||\"json\";body=m?decode(str.slice(m[0].length),m[1]):JSON.parse(str);}\n  catch(e){errors.push({error:\"decode\",detail:String(e)});return;}\n  if(body&&typeof body===\"object\"&&typeof body.requested===\"boolean\"&&(\"respawn\" in body||\"error\" in body)){\n   matches.push({body,format:fmt,...meta});\n  }\n };\n const walk=(x,path=\"$\")=>{\n  if(typeof x===\"string\"){if(/^format: \\S+\\n/.test(x)||/^[\\[{\"]/.test(x.trim()))decodeBody(x,{path,textBlocks:null});return;} if(!x||typeof x!==\"object\")return; if(x.type===\"text\"&&typeof x.text===\"string\"){decodeBody(x.text,{path,textBlocks:null});return;}\n  if(typeof x.requested===\"boolean\"&&(\"respawn\" in x||\"error\" in x)){matches.push({body:x,format:\"json\",path,textBlocks:null});return;} if(Array.isArray(x)){x.forEach((v,i)=>walk(v,path+\"[\"+i+\"]\"));return;}\n  if(Array.isArray(x.content)){\n   const blocks=x.content.map(v=>typeof v===\"string\"?v:v?.type===\"text\"?v.text:null).filter(v=>typeof v===\"string\");\n   if(x.structuredContent&&typeof x.structuredContent.requested===\"boolean\"){\n    matches.push({body:x.structuredContent,format:\"structuredContent\",isError:x.isError===true,textBlocks:blocks.length,path});\n   }else for(let i=0;i<blocks.length;i++)decodeBody(blocks[i],{isError:x.isError===true,textBlocks:blocks.length,path:path+\".text[\"+i+\"]\",contentShape:x.content.every(v=>typeof v===\"string\")?\"text-strings\":\"MCP-blocks\"});\n   return;\n  }\n  for(const [key,value] of Object.entries(x))walk(value,path+\".\"+key);\n };\n if(/^format: \\S+\\n/.test(b))decodeBody(b,{textBlocks:null,path:\"$direct-format\"});\n else{\n  let v;try{v=JSON.parse(b);}catch{const pp=parseJsonWithTrailer(b);if(pp)v=pp.value;}\n  if(v===undefined){\n   const lines=b.split(\"\\n\").filter(x=>x.trim());\n   try{const stream=lines.map(x=>JSON.parse(x));if(stream.length<2)throw Error(\"not-stream\");stream.forEach((x,i)=>walk(x,\"$stream[\"+i+\"]\"));}\n   catch{return {error:\"no-leading-json-format-or-complete-json-stream\"};}\n  }else walk(v);\n }\n return matches.length===1?matches[0]:{error:matches.length>1?\"multiple-compaction-bodies\":\"no-compaction-body\",matches:matches.length,errors};\n}\n\nconst stable=v=>v===null||typeof v!==\"object\"?JSON.stringify(v):Array.isArray(v)?\"[\"+v.map(stable).join(\",\")+\"]\":\"{\"+Object.keys(v).sort().map(k=>JSON.stringify(k)+\":\"+stable(v[k])).join(\",\")+\"}\";\nconst clipped=s=>/…\\s*\\[truncated|\\[truncated \\d+ chars\\]/i.test(s);\nfunction exactCalls(text){\n const sf=ts.createSourceFile(\"source.ts\",text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),bindings=new Map(),out=[];\n for(const s of sf.statements)if(ts.isVariableStatement(s)&&(s.declarationList.flags&ts.NodeFlags.Const))for(const d of s.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer)bindings.set(d.name.text,d.initializer);\n const changed=new Set();\n const mutations=n=>{if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){let x=n.left;while(ts.isPropertyAccessExpression(x)||ts.isElementAccessExpression(x))x=x.expression;if(ts.isIdentifier(x))changed.add(x.text);}ts.forEachChild(n,mutations);};mutations(sf);\n const evaluating=new Set();\n function literal(n){\n  if(ts.isParenthesizedExpression(n)||ts.isAsExpression(n))return literal(n.expression);\n  if(ts.isIdentifier(n)){if(changed.has(n.text)||!bindings.has(n.text)||evaluating.has(n.text))throw Error(\"unsafe binding \"+n.text);evaluating.add(n.text);try{return literal(bindings.get(n.text));}finally{evaluating.delete(n.text);}}\n  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;\n  if(ts.isNumericLiteral(n))return Number(n.text);\n  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;\n  if(ts.isObjectLiteralExpression(n)){const r={};for(const p of n.properties){if(ts.isShorthandPropertyAssignment(p))r[p.name.text]=literal(p.name);else if(ts.isPropertyAssignment(p)&&p.name.text!==undefined)r[p.name.text]=literal(p.initializer);else throw Error(\"nonliteral property\");}return r;}\n  if(ts.isArrayLiteralExpression(n))return n.elements.map(literal);\n  throw Error(\"nonliteral \"+ts.SyntaxKind[n.kind]);\n }\n const path=n=>{const p=[];for(let x=n;x.parent;x=x.parent)if(ts.isIfStatement(x.parent))p.push({ifPos:x.parent.pos,branch:x===x.parent.thenStatement?\"then\":x===x.parent.elseStatement?\"else\":\"condition\"});return p;};\n const walk=n=>{if(ts.isCallExpression(n)){const name=n.expression.getText(sf);try{\n  let args,mechanism;\n  if(/session_request_compaction$|session\\.request_compaction$/.test(name)){args=literal(n.arguments[0]);mechanism=\"native-wrapper\";}\n  else if(/tools[_\\.]invoke$|\\.invoke$/.test(name)){const a=literal(n.arguments[0]);if(a.name===\"session:request-compaction\"){args=a.args;mechanism=\"invoke\";}}\n  else if(/exec_command$/.test(name)){const a=literal(n.arguments[0]);if(typeof a.cmd===\"string\"&&/^ptool session:request-compaction(?:\\s|$)/.test(a.cmd)){const m=/<<'JSON'\\n([\\s\\S]*?)\\nJSON(?:\\n|$)/.exec(a.cmd);if(!m)throw Error(\"no exact quoted JSON heredoc\");args=JSON.parse(m[1]);mechanism=\"ptool-quoted-json\";}}\n  if(args)out.push({args,mechanism,path:path(n)});\n }catch(e){out.push({error:String(e)});}}ts.forEachChild(n,walk);};walk(sf);\n return {parseErrors:sf.parseDiagnostics.length,calls:out};\n}\nfunction onePath(calls){\n if(calls.length===1)return true;if(calls.length!==2)return false;\n return calls[0].path.some(a=>a.branch!==\"condition\"&&calls[1].path.some(b=>a.ifPos===b.ifPos&&b.branch!==\"condition\"&&a.branch!==b.branch));\n}\nfunction assess(t){\n const ledger=t.ledger,src=t.source,parts=t.lineage||[],found=[];\n for(const c of src.source_candidates){\n  let call=c,result=c.following_parts.find(x=>x.part_kind===\"tool_result\"&&x.part_idx===c.part_idx+1),chain=null;\n  if(c.tool_name===\"wait\"){\n   let w;try{w=JSON.parse(c.text);}catch{continue;}\n   const y=parts.filter(x=>x.part_idx<c.part_idx&&x.part_kind===\"tool_result\"&&new RegExp(\"^Script running with cell ID \"+w.cell_id+\"(?:\\\\n|$)\").test(x.text)).at(-1);\n   if(!y)continue;call=parts.find(x=>x.part_idx===y.part_idx-1&&x.part_kind===\"tool_use\");if(!call)continue;\n   const intervening=parts.filter(x=>x.part_idx>y.part_idx&&x.part_idx<=c.part_idx&&x.part_kind===\"tool_use\");\n   if(!intervening.every(x=>x.tool_name===\"wait\"&&JSON.parse(x.text).cell_id===w.cell_id))continue;\n   chain={cellId:w.cell_id,yieldPart:y.part_idx,waitPart:c.part_idx,originalCallPart:call.part_idx};call={...call,session_id:c.session_id};\n  }\n  if(!result)continue;\n  const parsed=exactCalls(call.text),matches=parsed.calls.filter(x=>x.args&&stable(x.args)===stable(ledger.args_json));\n  const decoded=receipt(result.text.replace(\"compaction_request=format: \",\"format: \")),body=decoded.body;\n  const state=body?.requested===true&&body.respawn===\"queued\"?\"queued\":body?.requested===false&&body.error===\"flush-required\"?\"flush-refused\":body?.ok===false&&body.requested===false&&body.error===\"no_live_pty_host\"?\"no-host-refused\":\"unclassified\";\n  const statusAgrees=state===\"queued\"?ledger.status===\"ok\":state.endsWith(\"refused\")?ledger.status===\"refused\":false;\n  const ownerEqual=src.owner===ledger.coord_owner_id&&(call.owner===undefined||call.owner===src.owner);\n  const bounds=Date.parse(call.ts)<=Date.parse(ledger.invoked_at)-Number(ledger.duration_ms)+1000&&Date.parse(result.ts)>=Date.parse(ledger.invoked_at)-1000&&Date.parse(result.ts)>=Date.parse(call.ts);\n  const sourceComplete=!clipped(call.text)&&!clipped(result.text);\n  const complete=parsed.parseErrors===0&&matches.length>0&&onePath(matches)&&body&&statusAgrees&&ownerEqual&&bounds&&sourceComplete;\n  found.push({nativeSession:call.session_id,callPart:call.part_idx,resultPart:result.part_idx,callTimestamp:call.ts,responseTimestamp:result.ts,mechanisms:matches.map(x=>x.mechanism),conditionalAlternatives:matches.length===2,chain,literalArgsEqual:matches.length>0,ownerEqual,bounds,sourceComplete,parseErrors:parsed.parseErrors,receiptState:state,statusAgrees,format:decoded.format,requested:body?.requested,respawn:body?.respawn,error:body?.error,completeOriginalPair:!!complete});\n }\n const unique=found.filter(x=>x.completeOriginalPair);return {request_id:String(ledger.id),owner:src.owner,completeOriginalPair:unique.length===1,pairs:found,receiptState:unique.length===1?unique[0].receiptState:\"unresolved\",outcomeJoined:false};\n}\nconst output=input.targets.map(assess);console.log(JSON.stringify({rows:output}));",
  "method": "Unchanged Cold23 processor; each candidate and lineage are isolated to its exact native session; original row is then deduplicated by native call/result pair. Python sends JSON via subprocess stdin, outside shell argv.",
  "rows": [
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "34967597",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "34979247",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122d6-ff62-75c3-a4ee-384dd3040a57",
          "callPart": 132,
          "resultPart": 133,
          "callTimestamp": "2026-10-09T23:07:09.785+00:00",
          "responseTimestamp": "2026-10-09T23:07:34.243+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34980575",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 111,
          "resultPart": 112,
          "callTimestamp": "2026-10-09T23:08:53.404+00:00",
          "responseTimestamp": "2026-10-09T23:08:55.701+00:00",
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
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 113,
          "resultPart": 114,
          "callTimestamp": "2026-10-09T23:09:35.497+00:00",
          "responseTimestamp": "2026-10-09T23:09:37.298+00:00",
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
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "34983377",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 97,
          "resultPart": 98,
          "callTimestamp": "2026-10-09T23:13:41.025+00:00",
          "responseTimestamp": "2026-10-09T23:13:51.31+00:00",
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
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 99,
          "resultPart": 100,
          "callTimestamp": "2026-10-09T23:14:01.203+00:00",
          "responseTimestamp": "2026-10-09T23:14:32.445+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 99,
          "resultPart": 102,
          "callTimestamp": "2026-10-09T23:14:01.203+00:00",
          "responseTimestamp": "2026-10-09T23:14:41.628+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "41",
            "yieldPart": 100,
            "waitPart": 101,
            "originalCallPart": 99
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
          "completeOriginalPair": true
        }
      ],
      "acceptedPairCount": 1,
      "outcomeJoined": false
    },
    {
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "request_id": "34993138",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122ee-ee80-77b3-9aed-03658f2afb68",
          "callPart": 101,
          "resultPart": 102,
          "callTimestamp": "2026-10-09T23:32:00.831+00:00",
          "responseTimestamp": "2026-10-09T23:32:04.319+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-ddb4cbf4-2581-4f7c-8d6a-efbb712bd295",
      "request_id": "34995559",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "request_id": "34996602",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a122fc-9a60-7772-8189-7fdc8cf876bb",
          "callPart": 92,
          "resultPart": 93,
          "callTimestamp": "2026-10-09T23:39:38.752+00:00",
          "responseTimestamp": "2026-10-09T23:39:40.048+00:00",
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
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35002236",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "request_id": "35007728",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35012964",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
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
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35013188",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
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
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35013284",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
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
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "request_id": "35014709",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
          "callPart": 170,
          "resultPart": 171,
          "callTimestamp": "2026-10-10T00:17:28.795+00:00",
          "responseTimestamp": "2026-10-10T00:17:32.072+00:00",
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
      "request_id": "35015047",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
          "callPart": 94,
          "resultPart": 95,
          "callTimestamp": "2026-10-10T00:18:03.917+00:00",
          "responseTimestamp": "2026-10-10T00:18:06.073+00:00",
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
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "request_id": "35018210",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
          "callPart": 140,
          "resultPart": 141,
          "callTimestamp": "2026-10-10T00:24:39.497+00:00",
          "responseTimestamp": "2026-10-10T00:24:41.567+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "request_id": "35020841",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
          "callPart": 133,
          "resultPart": 134,
          "callTimestamp": "2026-10-10T00:30:07.402+00:00",
          "responseTimestamp": "2026-10-10T00:30:10.049+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
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
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35022684",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
          "callPart": 104,
          "resultPart": 105,
          "callTimestamp": "2026-10-10T00:33:31+00:00",
          "responseTimestamp": "2026-10-10T00:33:33.014+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
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
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "request_id": "35023582",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
          "callPart": 108,
          "resultPart": 109,
          "callTimestamp": "2026-10-10T00:35:01.359+00:00",
          "responseTimestamp": "2026-10-10T00:35:12.91+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
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
      "request_id": "35030923",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35031846",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 65,
          "resultPart": 66,
          "callTimestamp": "2026-10-10T00:50:16.169+00:00",
          "responseTimestamp": "2026-10-10T00:50:29.501+00:00",
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
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 68,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:04.55+00:00",
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
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 70,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:10.514+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "27",
            "yieldPart": 68,
            "waitPart": 69,
            "originalCallPart": 67
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "json",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "request_id": "35038763",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "request_id": "35039357",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-10T01:05:26.418+00:00",
          "responseTimestamp": "2026-10-10T01:05:29.307+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "request_id": "35042969",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
          "callPart": 47,
          "resultPart": 48,
          "callTimestamp": "2026-10-10T01:11:02.234+00:00",
          "responseTimestamp": "2026-10-10T01:11:04.06+00:00",
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
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    }
  ],
  "sessionAssessments": [
    {
      "request_id": "34979247",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122d6-ff62-75c3-a4ee-384dd3040a57",
          "callPart": 132,
          "resultPart": 133,
          "callTimestamp": "2026-10-09T23:07:09.785+00:00",
          "responseTimestamp": "2026-10-09T23:07:34.243+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34980575",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 111,
          "resultPart": 112,
          "callTimestamp": "2026-10-09T23:08:53.404+00:00",
          "responseTimestamp": "2026-10-09T23:08:55.701+00:00",
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
          "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
          "callPart": 113,
          "resultPart": 114,
          "callTimestamp": "2026-10-09T23:09:35.497+00:00",
          "responseTimestamp": "2026-10-09T23:09:37.298+00:00",
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
      "request_id": "34983377",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 97,
          "resultPart": 98,
          "callTimestamp": "2026-10-09T23:13:41.025+00:00",
          "responseTimestamp": "2026-10-09T23:13:51.31+00:00",
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
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 99,
          "resultPart": 100,
          "callTimestamp": "2026-10-09T23:14:01.203+00:00",
          "responseTimestamp": "2026-10-09T23:14:32.445+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
          "callPart": 99,
          "resultPart": 102,
          "callTimestamp": "2026-10-09T23:14:01.203+00:00",
          "responseTimestamp": "2026-10-09T23:14:41.628+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "41",
            "yieldPart": 100,
            "waitPart": 101,
            "originalCallPart": 99
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
          "completeOriginalPair": true
        }
      ],
      "receiptState": "queued",
      "outcomeJoined": false
    },
    {
      "request_id": "34993138",
      "owner": "su-ba80f2f7-46f6-4aec-b99a-21e02460933f",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122ee-ee80-77b3-9aed-03658f2afb68",
          "callPart": 101,
          "resultPart": 102,
          "callTimestamp": "2026-10-09T23:32:00.831+00:00",
          "responseTimestamp": "2026-10-09T23:32:04.319+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "34996602",
      "owner": "su-77348e3d-80ac-42d8-b4e7-bdce9684a72a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a122fc-9a60-7772-8189-7fdc8cf876bb",
          "callPart": 92,
          "resultPart": 93,
          "callTimestamp": "2026-10-09T23:39:38.752+00:00",
          "responseTimestamp": "2026-10-09T23:39:40.048+00:00",
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
      "request_id": "35012964",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
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
      "request_id": "35013188",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": false,
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
      "request_id": "35013284",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
          "callPart": 115,
          "resultPart": 116,
          "callTimestamp": "2026-10-10T00:14:24.785+00:00",
          "responseTimestamp": "2026-10-10T00:14:26.232+00:00",
          "mechanisms": [
            "invoke"
          ],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": true,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
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
      "request_id": "35014709",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
          "callPart": 170,
          "resultPart": 171,
          "callTimestamp": "2026-10-10T00:17:28.795+00:00",
          "responseTimestamp": "2026-10-10T00:17:32.072+00:00",
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
      "request_id": "35015047",
      "owner": "su-f0e98560-52c5-4afe-8709-46fef49a576e",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
          "callPart": 94,
          "resultPart": 95,
          "callTimestamp": "2026-10-10T00:18:03.917+00:00",
          "responseTimestamp": "2026-10-10T00:18:06.073+00:00",
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
      "request_id": "35018210",
      "owner": "su-82c46308-5eb9-4237-9d2d-950d322576c4",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
          "callPart": 140,
          "resultPart": 141,
          "callTimestamp": "2026-10-10T00:24:39.497+00:00",
          "responseTimestamp": "2026-10-10T00:24:41.567+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35020841",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
          "callPart": 133,
          "resultPart": 134,
          "callTimestamp": "2026-10-10T00:30:07.402+00:00",
          "responseTimestamp": "2026-10-10T00:30:10.049+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
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
      "request_id": "35022684",
      "owner": "su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
          "callPart": 104,
          "resultPart": 105,
          "callTimestamp": "2026-10-10T00:33:31+00:00",
          "responseTimestamp": "2026-10-10T00:33:33.014+00:00",
          "mechanisms": [
            "native-wrapper",
            "invoke"
          ],
          "conditionalAlternatives": true,
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
      "request_id": "35023582",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
          "callPart": 108,
          "resultPart": 109,
          "callTimestamp": "2026-10-10T00:35:01.359+00:00",
          "responseTimestamp": "2026-10-10T00:35:12.91+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35031846",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 65,
          "resultPart": 66,
          "callTimestamp": "2026-10-10T00:50:16.169+00:00",
          "responseTimestamp": "2026-10-10T00:50:29.501+00:00",
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
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 68,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:04.55+00:00",
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
          "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
          "callPart": 67,
          "resultPart": 70,
          "callTimestamp": "2026-10-10T00:50:33.52+00:00",
          "responseTimestamp": "2026-10-10T00:51:10.514+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "27",
            "yieldPart": 68,
            "waitPart": 69,
            "originalCallPart": 67
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": true,
          "parseErrors": 0,
          "receiptState": "queued",
          "statusAgrees": true,
          "format": "json",
          "requested": true,
          "respawn": "queued",
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35039357",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
          "callPart": 138,
          "resultPart": 139,
          "callTimestamp": "2026-10-10T01:05:26.418+00:00",
          "responseTimestamp": "2026-10-10T01:05:29.307+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 1,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35042969",
      "owner": "su-449b83a8-a709-43af-9681-768dc6ac744a",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
          "callPart": 47,
          "resultPart": 48,
          "callTimestamp": "2026-10-10T01:11:02.234+00:00",
          "responseTimestamp": "2026-10-10T01:11:04.06+00:00",
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
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    }
  ],
  "executions": [
    {
      "request_id": "34979247",
      "nativeSession": "01a122d6-ff62-75c3-a4ee-384dd3040a57",
      "exitCode": 0,
      "seconds": 0.3301963150734082,
      "inputBytes": 16503,
      "stdout": "{\"rows\":[{\"request_id\":\"34979247\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122d6-ff62-75c3-a4ee-384dd3040a57\",\"callPart\":132,\"resultPart\":133,\"callTimestamp\":\"2026-10-09T23:07:09.785+00:00\",\"responseTimestamp\":\"2026-10-09T23:07:34.243+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34980575",
      "nativeSession": "01a122d9-d539-7ed1-918a-41bcc5b9f9c4",
      "exitCode": 0,
      "seconds": 0.30109484505373985,
      "inputBytes": 38602,
      "stdout": "{\"rows\":[{\"request_id\":\"34980575\",\"owner\":\"su-ba80f2f7-46f6-4aec-b99a-21e02460933f\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122d9-d539-7ed1-918a-41bcc5b9f9c4\",\"callPart\":111,\"resultPart\":112,\"callTimestamp\":\"2026-10-09T23:08:53.404+00:00\",\"responseTimestamp\":\"2026-10-09T23:08:55.701+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a122d9-d539-7ed1-918a-41bcc5b9f9c4\",\"callPart\":113,\"resultPart\":114,\"callTimestamp\":\"2026-10-09T23:09:35.497+00:00\",\"responseTimestamp\":\"2026-10-09T23:09:37.298+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34983377",
      "nativeSession": "01a122e2-3803-77b0-9417-4b18e4d73bf4",
      "exitCode": 0,
      "seconds": 0.2957935140002519,
      "inputBytes": 24162,
      "stdout": "{\"rows\":[{\"request_id\":\"34983377\",\"owner\":\"su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a122e2-3803-77b0-9417-4b18e4d73bf4\",\"callPart\":97,\"resultPart\":98,\"callTimestamp\":\"2026-10-09T23:13:41.025+00:00\",\"responseTimestamp\":\"2026-10-09T23:13:51.31+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a122e2-3803-77b0-9417-4b18e4d73bf4\",\"callPart\":99,\"resultPart\":100,\"callTimestamp\":\"2026-10-09T23:14:01.203+00:00\",\"responseTimestamp\":\"2026-10-09T23:14:32.445+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a122e2-3803-77b0-9417-4b18e4d73bf4\",\"callPart\":99,\"resultPart\":102,\"callTimestamp\":\"2026-10-09T23:14:01.203+00:00\",\"responseTimestamp\":\"2026-10-09T23:14:41.628+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"41\",\"yieldPart\":100,\"waitPart\":101,\"originalCallPart\":99},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34993138",
      "nativeSession": "01a122ee-ee80-77b3-9aed-03658f2afb68",
      "exitCode": 0,
      "seconds": 0.3354699370684102,
      "inputBytes": 21314,
      "stdout": "{\"rows\":[{\"request_id\":\"34993138\",\"owner\":\"su-ba80f2f7-46f6-4aec-b99a-21e02460933f\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122ee-ee80-77b3-9aed-03658f2afb68\",\"callPart\":101,\"resultPart\":102,\"callTimestamp\":\"2026-10-09T23:32:00.831+00:00\",\"responseTimestamp\":\"2026-10-09T23:32:04.319+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "34996602",
      "nativeSession": "01a122fc-9a60-7772-8189-7fdc8cf876bb",
      "exitCode": 0,
      "seconds": 0.31921273097395897,
      "inputBytes": 20825,
      "stdout": "{\"rows\":[{\"request_id\":\"34996602\",\"owner\":\"su-77348e3d-80ac-42d8-b4e7-bdce9684a72a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a122fc-9a60-7772-8189-7fdc8cf876bb\",\"callPart\":92,\"resultPart\":93,\"callTimestamp\":\"2026-10-09T23:39:38.752+00:00\",\"responseTimestamp\":\"2026-10-09T23:39:40.048+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35012964",
      "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
      "exitCode": 0,
      "seconds": 0.2973754269769415,
      "inputBytes": 31497,
      "stdout": "{\"rows\":[{\"request_id\":\"35012964\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-8b95-7243-8949-1b20acf248cd\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-10T00:14:24.785+00:00\",\"responseTimestamp\":\"2026-10-10T00:14:26.232+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35013188",
      "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
      "exitCode": 0,
      "seconds": 0.33460702397860587,
      "inputBytes": 31417,
      "stdout": "{\"rows\":[{\"request_id\":\"35013188\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-8b95-7243-8949-1b20acf248cd\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-10T00:14:24.785+00:00\",\"responseTimestamp\":\"2026-10-10T00:14:26.232+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35013284",
      "nativeSession": "01a12315-8b95-7243-8949-1b20acf248cd",
      "exitCode": 0,
      "seconds": 0.32997241895645857,
      "inputBytes": 31269,
      "stdout": "{\"rows\":[{\"request_id\":\"35013284\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-8b95-7243-8949-1b20acf248cd\",\"callPart\":115,\"resultPart\":116,\"callTimestamp\":\"2026-10-10T00:14:24.785+00:00\",\"responseTimestamp\":\"2026-10-10T00:14:26.232+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35014709",
      "nativeSession": "01a12315-a40e-7280-a1e8-9f2ac48b1d4e",
      "exitCode": 0,
      "seconds": 0.36200195795390755,
      "inputBytes": 26924,
      "stdout": "{\"rows\":[{\"request_id\":\"35014709\",\"owner\":\"su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12315-a40e-7280-a1e8-9f2ac48b1d4e\",\"callPart\":170,\"resultPart\":171,\"callTimestamp\":\"2026-10-10T00:17:28.795+00:00\",\"responseTimestamp\":\"2026-10-10T00:17:32.072+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35015047",
      "nativeSession": "01a1231e-4587-78c2-aa03-27c4229be312",
      "exitCode": 0,
      "seconds": 0.3257433179533109,
      "inputBytes": 21818,
      "stdout": "{\"rows\":[{\"request_id\":\"35015047\",\"owner\":\"su-f0e98560-52c5-4afe-8709-46fef49a576e\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1231e-4587-78c2-aa03-27c4229be312\",\"callPart\":94,\"resultPart\":95,\"callTimestamp\":\"2026-10-10T00:18:03.917+00:00\",\"responseTimestamp\":\"2026-10-10T00:18:06.073+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35018210",
      "nativeSession": "01a1231e-b6d5-7ee0-8ce8-73fb43067a42",
      "exitCode": 0,
      "seconds": 0.3680876089492813,
      "inputBytes": 22190,
      "stdout": "{\"rows\":[{\"request_id\":\"35018210\",\"owner\":\"su-82c46308-5eb9-4237-9d2d-950d322576c4\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1231e-b6d5-7ee0-8ce8-73fb43067a42\",\"callPart\":140,\"resultPart\":141,\"callTimestamp\":\"2026-10-10T00:24:39.497+00:00\",\"responseTimestamp\":\"2026-10-10T00:24:41.567+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35020841",
      "nativeSession": "01a12329-3110-7ed1-b8cd-0af91f5a7d90",
      "exitCode": 0,
      "seconds": 0.3596077759284526,
      "inputBytes": 48228,
      "stdout": "{\"rows\":[{\"request_id\":\"35020841\",\"owner\":\"su-449b83a8-a709-43af-9681-768dc6ac744a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12329-3110-7ed1-b8cd-0af91f5a7d90\",\"callPart\":133,\"resultPart\":134,\"callTimestamp\":\"2026-10-10T00:30:07.402+00:00\",\"responseTimestamp\":\"2026-10-10T00:30:10.049+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35022684",
      "nativeSession": "01a12329-777a-7b80-8fc3-ab01535f10ae",
      "exitCode": 0,
      "seconds": 0.43217793002258986,
      "inputBytes": 19769,
      "stdout": "{\"rows\":[{\"request_id\":\"35022684\",\"owner\":\"su-acd7d9d0-01c4-47ad-a2b4-3e8a24110100\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12329-777a-7b80-8fc3-ab01535f10ae\",\"callPart\":104,\"resultPart\":105,\"callTimestamp\":\"2026-10-10T00:33:31+00:00\",\"responseTimestamp\":\"2026-10-10T00:33:33.014+00:00\",\"mechanisms\":[\"native-wrapper\",\"invoke\"],\"conditionalAlternatives\":true,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35023582",
      "nativeSession": "01a1232c-37f8-7e61-a664-1dbf34681ab9",
      "exitCode": 0,
      "seconds": 0.3422612289432436,
      "inputBytes": 31017,
      "stdout": "{\"rows\":[{\"request_id\":\"35023582\",\"owner\":\"su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1232c-37f8-7e61-a664-1dbf34681ab9\",\"callPart\":108,\"resultPart\":109,\"callTimestamp\":\"2026-10-10T00:35:01.359+00:00\",\"responseTimestamp\":\"2026-10-10T00:35:12.91+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35031846",
      "nativeSession": "01a1233d-49f6-7fb3-b489-37d80ae709a0",
      "exitCode": 0,
      "seconds": 0.3201057619880885,
      "inputBytes": 28475,
      "stdout": "{\"rows\":[{\"request_id\":\"35031846\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1233d-49f6-7fb3-b489-37d80ae709a0\",\"callPart\":65,\"resultPart\":66,\"callTimestamp\":\"2026-10-10T00:50:16.169+00:00\",\"responseTimestamp\":\"2026-10-10T00:50:29.501+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1233d-49f6-7fb3-b489-37d80ae709a0\",\"callPart\":67,\"resultPart\":68,\"callTimestamp\":\"2026-10-10T00:50:33.52+00:00\",\"responseTimestamp\":\"2026-10-10T00:51:04.55+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1233d-49f6-7fb3-b489-37d80ae709a0\",\"callPart\":67,\"resultPart\":70,\"callTimestamp\":\"2026-10-10T00:50:33.52+00:00\",\"responseTimestamp\":\"2026-10-10T00:51:10.514+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"27\",\"yieldPart\":68,\"waitPart\":69,\"originalCallPart\":67},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35039357",
      "nativeSession": "01a12348-953f-7483-9589-e1a23948d6f5",
      "exitCode": 0,
      "seconds": 0.2926238359650597,
      "inputBytes": 28135,
      "stdout": "{\"rows\":[{\"request_id\":\"35039357\",\"owner\":\"su-449b83a8-a709-43af-9681-768dc6ac744a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12348-953f-7483-9589-e1a23948d6f5\",\"callPart\":138,\"resultPart\":139,\"callTimestamp\":\"2026-10-10T01:05:26.418+00:00\",\"responseTimestamp\":\"2026-10-10T01:05:29.307+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35042969",
      "nativeSession": "01a12358-40b3-7071-afa8-73e105e0851b",
      "exitCode": 0,
      "seconds": 0.2981913620606065,
      "inputBytes": 27912,
      "stdout": "{\"rows\":[{\"request_id\":\"35042969\",\"owner\":\"su-449b83a8-a709-43af-9681-768dc6ac744a\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12358-40b3-7071-afa8-73e105e0851b\",\"callPart\":47,\"resultPart\":48,\"callTimestamp\":\"2026-10-10T01:11:02.234+00:00\",\"responseTimestamp\":\"2026-10-10T01:11:04.06+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    }
  ],
  "limits": [
    "Outcomes joined0; whole116 continuity/eligibility unaccepted.",
    "Original truncated source remains incomplete."
  ]
}
