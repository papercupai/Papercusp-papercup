---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold24-native-assessment-batch3-424d5.json"
updated_at: 1791893560259
_body: "content"
---

{
  "schemaVersion": "cold24-indexed-native-shell-assessment-v1",
  "observedAt": "2026-10-13T12:12:38Z",
  "cohortHash": "24ff6981fd54f120f96381dd93732ec9c1bfb2101d7eec063119bf85caeb163a",
  "sourceRefs": [
    "audits/parked-agent-resumption-2026-10-09/r13-cold24-remaining69-indexed-source-batch3-424d5.json",
    "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json"
  ],
  "parser": "import ts from \"typescript\";\nimport {decode} from \"./libs/generic/result-encoding/src/encode.ts\";\nimport {parseJsonWithTrailer} from \"./libs/generic/tooldef/src/code-orchestration/json-prefix.ts\";\nconst input=await Bun.stdin.json();\nfunction receipt(text){\n const oi=text.indexOf(\"Output:\\n\"), b=oi>=0?text.slice(oi+8).trim():text.trim();\n const matches=[],errors=[];\n const decodeBody=(str,meta={})=>{\n  let body,fmt=\"json\";\n  try{const m=/^format: (\\S+)\\n/.exec(str);fmt=m?.[1]||\"json\";body=m?decode(str.slice(m[0].length),m[1]):JSON.parse(str);}\n  catch(e){errors.push({error:\"decode\",detail:String(e)});return;}\n  if(body&&typeof body===\"object\"&&typeof body.requested===\"boolean\"&&(\"respawn\" in body||\"error\" in body)){\n   matches.push({body,format:fmt,...meta});\n  }\n };\n const walk=(x,path=\"$\")=>{\n  if(typeof x===\"string\"){if(/^format: \\S+\\n/.test(x)||/^[\\[{\"]/.test(x.trim()))decodeBody(x,{path,textBlocks:null});return;} if(!x||typeof x!==\"object\")return; if(x.type===\"text\"&&typeof x.text===\"string\"){decodeBody(x.text,{path,textBlocks:null});return;}\n  if(typeof x.requested===\"boolean\"&&(\"respawn\" in x||\"error\" in x)){matches.push({body:x,format:\"json\",path,textBlocks:null});return;} if(Array.isArray(x)){x.forEach((v,i)=>walk(v,path+\"[\"+i+\"]\"));return;}\n  if(Array.isArray(x.content)){\n   const blocks=x.content.map(v=>typeof v===\"string\"?v:v?.type===\"text\"?v.text:null).filter(v=>typeof v===\"string\");\n   if(x.structuredContent&&typeof x.structuredContent.requested===\"boolean\"){\n    matches.push({body:x.structuredContent,format:\"structuredContent\",isError:x.isError===true,textBlocks:blocks.length,path});\n   }else for(let i=0;i<blocks.length;i++)decodeBody(blocks[i],{isError:x.isError===true,textBlocks:blocks.length,path:path+\".text[\"+i+\"]\",contentShape:x.content.every(v=>typeof v===\"string\")?\"text-strings\":\"MCP-blocks\"});\n   return;\n  }\n  for(const [key,value] of Object.entries(x))walk(value,path+\".\"+key);\n };\n if(/^format: \\S+\\n/.test(b))decodeBody(b,{textBlocks:null,path:\"$direct-format\"});\n else{\n  let v;try{v=JSON.parse(b);}catch{const pp=parseJsonWithTrailer(b);if(pp)v=pp.value;}\n  if(v===undefined){\n   const lines=b.split(\"\\n\").filter(x=>x.trim());\n   try{const stream=lines.map(x=>JSON.parse(x));if(stream.length<2)throw Error(\"not-stream\");stream.forEach((x,i)=>walk(x,\"$stream[\"+i+\"]\"));}\n   catch{return {error:\"no-leading-json-format-or-complete-json-stream\"};}\n  }else walk(v);\n }\n return matches.length===1?matches[0]:{error:matches.length>1?\"multiple-compaction-bodies\":\"no-compaction-body\",matches:matches.length,errors};\n}\n\nconst stable=v=>v===null||typeof v!==\"object\"?JSON.stringify(v):Array.isArray(v)?\"[\"+v.map(stable).join(\",\")+\"]\":\"{\"+Object.keys(v).sort().map(k=>JSON.stringify(k)+\":\"+stable(v[k])).join(\",\")+\"}\";\nconst clipped=s=>/…\\s*\\[truncated|\\[truncated \\d+ chars\\]/i.test(s);\nfunction exactCalls(text){\n const sf=ts.createSourceFile(\"source.ts\",text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),bindings=new Map(),out=[];\n for(const s of sf.statements)if(ts.isVariableStatement(s)&&(s.declarationList.flags&ts.NodeFlags.Const))for(const d of s.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer)bindings.set(d.name.text,d.initializer);\n const changed=new Set();\n const mutations=n=>{if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){let x=n.left;while(ts.isPropertyAccessExpression(x)||ts.isElementAccessExpression(x))x=x.expression;if(ts.isIdentifier(x))changed.add(x.text);}ts.forEachChild(n,mutations);};mutations(sf);\n const evaluating=new Set();\n function literal(n){\n  if(ts.isParenthesizedExpression(n)||ts.isAsExpression(n))return literal(n.expression);\n  if(ts.isIdentifier(n)){if(changed.has(n.text)||!bindings.has(n.text)||evaluating.has(n.text))throw Error(\"unsafe binding \"+n.text);evaluating.add(n.text);try{return literal(bindings.get(n.text));}finally{evaluating.delete(n.text);}}\n  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;\n  if(ts.isNumericLiteral(n))return Number(n.text);\n  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;\n  if(ts.isObjectLiteralExpression(n)){const r={};for(const p of n.properties){if(ts.isShorthandPropertyAssignment(p))r[p.name.text]=literal(p.name);else if(ts.isPropertyAssignment(p)&&p.name.text!==undefined)r[p.name.text]=literal(p.initializer);else throw Error(\"nonliteral property\");}return r;}\n  if(ts.isArrayLiteralExpression(n))return n.elements.map(literal);\n  throw Error(\"nonliteral \"+ts.SyntaxKind[n.kind]);\n }\n const path=n=>{const p=[];for(let x=n;x.parent;x=x.parent)if(ts.isIfStatement(x.parent))p.push({ifPos:x.parent.pos,branch:x===x.parent.thenStatement?\"then\":x===x.parent.elseStatement?\"else\":\"condition\"});return p;};\n const walk=n=>{if(ts.isCallExpression(n)){const name=n.expression.getText(sf);try{\n  let args,mechanism;\n  if(/session_request_compaction$|session\\.request_compaction$/.test(name)){args=literal(n.arguments[0]);mechanism=\"native-wrapper\";}\n  else if(/tools[_\\.]invoke$|\\.invoke$/.test(name)){const a=literal(n.arguments[0]);if(a.name===\"session:request-compaction\"){args=a.args;mechanism=\"invoke\";}}\n  else if(/exec_command$/.test(name)){const a=literal(n.arguments[0]);if(typeof a.cmd===\"string\"&&/^ptool session:request-compaction(?:\\s|$)/.test(a.cmd)){const m=/<<'JSON'\\n([\\s\\S]*?)\\nJSON(?:\\n|$)/.exec(a.cmd);if(!m)throw Error(\"no exact quoted JSON heredoc\");args=JSON.parse(m[1]);mechanism=\"ptool-quoted-json\";}}\n  if(args)out.push({args,mechanism,path:path(n)});\n }catch(e){out.push({error:String(e)});}}ts.forEachChild(n,walk);};walk(sf);\n return {parseErrors:sf.parseDiagnostics.length,calls:out};\n}\nfunction onePath(calls){\n if(calls.length===1)return true;if(calls.length!==2)return false;\n return calls[0].path.some(a=>a.branch!==\"condition\"&&calls[1].path.some(b=>a.ifPos===b.ifPos&&b.branch!==\"condition\"&&a.branch!==b.branch));\n}\nfunction assess(t){\n const ledger=t.ledger,src=t.source,parts=t.lineage||[],found=[];\n for(const c of src.source_candidates){\n  let call=c,result=c.following_parts.find(x=>x.part_kind===\"tool_result\"&&x.part_idx===c.part_idx+1),chain=null;\n  if(c.tool_name===\"wait\"){\n   let w;try{w=JSON.parse(c.text);}catch{continue;}\n   const y=parts.filter(x=>x.part_idx<c.part_idx&&x.part_kind===\"tool_result\"&&new RegExp(\"^Script running with cell ID \"+w.cell_id+\"(?:\\\\n|$)\").test(x.text)).at(-1);\n   if(!y)continue;call=parts.find(x=>x.part_idx===y.part_idx-1&&x.part_kind===\"tool_use\");if(!call)continue;\n   const intervening=parts.filter(x=>x.part_idx>y.part_idx&&x.part_idx<=c.part_idx&&x.part_kind===\"tool_use\");\n   if(!intervening.every(x=>x.tool_name===\"wait\"&&JSON.parse(x.text).cell_id===w.cell_id))continue;\n   chain={cellId:w.cell_id,yieldPart:y.part_idx,waitPart:c.part_idx,originalCallPart:call.part_idx};call={...call,session_id:c.session_id};\n  }\n  if(!result)continue;\n  const parsed=exactCalls(call.text),matches=parsed.calls.filter(x=>x.args&&stable(x.args)===stable(ledger.args_json));\n  const decoded=receipt(result.text.replace(\"compaction_request=format: \",\"format: \")),body=decoded.body;\n  const state=body?.requested===true&&body.respawn===\"queued\"?\"queued\":body?.requested===false&&body.error===\"flush-required\"?\"flush-refused\":body?.ok===false&&body.requested===false&&body.error===\"no_live_pty_host\"?\"no-host-refused\":\"unclassified\";\n  const statusAgrees=state===\"queued\"?ledger.status===\"ok\":state.endsWith(\"refused\")?ledger.status===\"refused\":false;\n  const ownerEqual=src.owner===ledger.coord_owner_id&&(call.owner===undefined||call.owner===src.owner);\n  const bounds=Date.parse(call.ts)<=Date.parse(ledger.invoked_at)-Number(ledger.duration_ms)+1000&&Date.parse(result.ts)>=Date.parse(ledger.invoked_at)-1000&&Date.parse(result.ts)>=Date.parse(call.ts);\n  const sourceComplete=!clipped(call.text)&&!clipped(result.text);\n  const complete=parsed.parseErrors===0&&matches.length>0&&onePath(matches)&&body&&statusAgrees&&ownerEqual&&bounds&&sourceComplete;\n  found.push({nativeSession:call.session_id,callPart:call.part_idx,resultPart:result.part_idx,callTimestamp:call.ts,responseTimestamp:result.ts,mechanisms:matches.map(x=>x.mechanism),conditionalAlternatives:matches.length===2,chain,literalArgsEqual:matches.length>0,ownerEqual,bounds,sourceComplete,parseErrors:parsed.parseErrors,receiptState:state,statusAgrees,format:decoded.format,requested:body?.requested,respawn:body?.respawn,error:body?.error,completeOriginalPair:!!complete});\n }\n const unique=found.filter(x=>x.completeOriginalPair);return {request_id:String(ledger.id),owner:src.owner,completeOriginalPair:unique.length===1,pairs:found,receiptState:unique.length===1?unique[0].receiptState:\"unresolved\",outcomeJoined:false};\n}\nconst output=input.targets.map(assess);console.log(JSON.stringify({rows:output}));",
  "method": "Unchanged Cold23 processor; each candidate and lineage are isolated to its exact native session; original row is then deduplicated by native call/result pair. Python sends JSON via subprocess stdin, outside shell argv.",
  "rows": [
    {
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "request_id": "35044097",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
          "callPart": 151,
          "resultPart": 152,
          "callTimestamp": "2026-10-10T01:14:16.889+00:00",
          "responseTimestamp": "2026-10-10T01:14:21.533+00:00",
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
          "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
          "callPart": 153,
          "resultPart": 154,
          "callTimestamp": "2026-10-10T01:14:31.403+00:00",
          "responseTimestamp": "2026-10-10T01:14:37.246+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "request_id": "35045161",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "request_id": "35045222",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
          "callPart": 65,
          "resultPart": 66,
          "callTimestamp": "2026-10-10T01:17:53.241+00:00",
          "responseTimestamp": "2026-10-10T01:17:56.361+00:00",
          "mechanisms": [
            "invoke"
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
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "request_id": "35046578",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
          "callPart": 121,
          "resultPart": 122,
          "callTimestamp": "2026-10-10T01:20:31.694+00:00",
          "responseTimestamp": "2026-10-10T01:20:48.884+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
        },
        {
          "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
          "callPart": 123,
          "resultPart": 124,
          "callTimestamp": "2026-10-10T01:21:28.146+00:00",
          "responseTimestamp": "2026-10-10T01:21:41.741+00:00",
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
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35047650",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
          "callPart": 167,
          "resultPart": 168,
          "callTimestamp": "2026-10-10T01:22:36.494+00:00",
          "responseTimestamp": "2026-10-10T01:22:55.034+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "request_id": "35058458",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12366-709f-7563-883f-29a8b509fa28",
          "callPart": 92,
          "resultPart": 93,
          "callTimestamp": "2026-10-10T01:42:38.818+00:00",
          "responseTimestamp": "2026-10-10T01:42:47.694+00:00",
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
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35063976",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 158,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:54:47.058+00:00",
          "mechanisms": [
            "native-wrapper"
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
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 160,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:55:23.789+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "yieldPart": 158,
            "waitPart": 159,
            "originalCallPart": 157
          },
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
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 159,
          "resultPart": 163,
          "callTimestamp": "2026-10-10T01:54:52.783+00:00",
          "responseTimestamp": "2026-10-10T01:55:59.527+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "yieldPart": 160,
            "waitPart": 162,
            "originalCallPart": 159
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 162,
          "resultPart": 165,
          "callTimestamp": "2026-10-10T01:55:28.513+00:00",
          "responseTimestamp": "2026-10-10T01:56:04.149+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "yieldPart": 163,
            "waitPart": 164,
            "originalCallPart": 162
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
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
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35064368",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 127,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:55:38.766+00:00",
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
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 129,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:56:15.438+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "yieldPart": 127,
            "waitPart": 128,
            "originalCallPart": 126
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
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 128,
          "resultPart": 131,
          "callTimestamp": "2026-10-10T01:55:44.43+00:00",
          "responseTimestamp": "2026-10-10T01:56:51.596+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "yieldPart": 129,
            "waitPart": 130,
            "originalCallPart": 128
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 130,
          "resultPart": 133,
          "callTimestamp": "2026-10-10T01:56:20.585+00:00",
          "responseTimestamp": "2026-10-10T01:56:58.885+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "yieldPart": 131,
            "waitPart": 132,
            "originalCallPart": 130
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
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
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "request_id": "35099533",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
          "callPart": 102,
          "resultPart": 103,
          "callTimestamp": "2026-10-10T03:11:19.842+00:00",
          "responseTimestamp": "2026-10-10T03:11:30.513+00:00",
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
          "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
          "callPart": 106,
          "resultPart": 107,
          "callTimestamp": "2026-10-10T03:12:08.306+00:00",
          "responseTimestamp": "2026-10-10T03:12:37.937+00:00",
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
        },
        {
          "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
          "callPart": 108,
          "resultPart": 109,
          "callTimestamp": "2026-10-10T03:13:22.329+00:00",
          "responseTimestamp": "2026-10-10T03:13:31.891+00:00",
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
    },
    {
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35108257",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a123d2-ee6c-7bc1-9a95-34572719bfe8",
          "callPart": 72,
          "resultPart": 73,
          "callTimestamp": "2026-10-10T03:32:20.565+00:00",
          "responseTimestamp": "2026-10-10T03:32:44.738+00:00",
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
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35109461",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
          "callPart": 177,
          "resultPart": 178,
          "callTimestamp": "2026-10-10T03:34:44.285+00:00",
          "responseTimestamp": "2026-10-10T03:34:44.474+00:00",
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
          "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
          "callPart": 181,
          "resultPart": 182,
          "callTimestamp": "2026-10-10T03:35:07.629+00:00",
          "responseTimestamp": "2026-10-10T03:35:17.09+00:00",
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
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35119644",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
          "callPart": 116,
          "resultPart": 117,
          "callTimestamp": "2026-10-10T03:55:12.063+00:00",
          "responseTimestamp": "2026-10-10T03:55:30.782+00:00",
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
          "nativeSession": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
          "callPart": 118,
          "resultPart": 119,
          "callTimestamp": "2026-10-10T03:56:01.867+00:00",
          "responseTimestamp": "2026-10-10T03:56:30.316+00:00",
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
      "request_id": "35120408",
      "acceptedUnique": true,
      "completeOriginalPair": true,
      "receiptState": "queued",
      "pairs": [
        {
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 150,
          "resultPart": 151,
          "callTimestamp": "2026-10-10T03:57:01.877+00:00",
          "responseTimestamp": "2026-10-10T03:57:15.263+00:00",
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
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 154,
          "resultPart": 155,
          "callTimestamp": "2026-10-10T03:57:34.569+00:00",
          "responseTimestamp": "2026-10-10T03:57:34.961+00:00",
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
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 156,
          "resultPart": 157,
          "callTimestamp": "2026-10-10T03:57:42.109+00:00",
          "responseTimestamp": "2026-10-10T03:58:04.747+00:00",
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
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35121480",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
          "callPart": 139,
          "resultPart": 140,
          "callTimestamp": "2026-10-10T03:59:38.018+00:00",
          "responseTimestamp": "2026-10-10T04:00:09.081+00:00",
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
          "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
          "callPart": 139,
          "resultPart": 143,
          "callTimestamp": "2026-10-10T03:59:38.018+00:00",
          "responseTimestamp": "2026-10-10T04:00:26.923+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "65",
            "yieldPart": 140,
            "waitPart": 142,
            "originalCallPart": 139
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
          "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
          "callPart": 142,
          "resultPart": 145,
          "callTimestamp": "2026-10-10T04:00:15.911+00:00",
          "responseTimestamp": "2026-10-10T04:00:31.129+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "65",
            "yieldPart": 143,
            "waitPart": 144,
            "originalCallPart": 142
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
      "owner": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "request_id": "35133707",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a123fe-6eda-7640-9dc5-7f91366ee84e",
          "callPart": 157,
          "resultPart": 158,
          "callTimestamp": "2026-10-10T04:28:03.242+00:00",
          "responseTimestamp": "2026-10-10T04:28:04.775+00:00",
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
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "request_id": "35145396",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
          "callPart": 101,
          "resultPart": 102,
          "callTimestamp": "2026-10-10T04:52:09.122+00:00",
          "responseTimestamp": "2026-10-10T04:52:23.484+00:00",
          "mechanisms": [
            "invoke"
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
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "request_id": "35232736",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
          "callPart": 197,
          "resultPart": 198,
          "callTimestamp": "2026-10-10T08:14:04.231+00:00",
          "responseTimestamp": "2026-10-10T08:14:35.255+00:00",
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
          "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
          "callPart": 197,
          "resultPart": 200,
          "callTimestamp": "2026-10-10T08:14:04.231+00:00",
          "responseTimestamp": "2026-10-10T08:14:47.334+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "90",
            "yieldPart": 198,
            "waitPart": 199,
            "originalCallPart": 197
          },
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
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "request_id": "35239534",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
          "callPart": 95,
          "resultPart": 96,
          "callTimestamp": "2026-10-10T08:27:58.704+00:00",
          "responseTimestamp": "2026-10-10T08:28:03.203+00:00",
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
          "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
          "callPart": 99,
          "resultPart": 100,
          "callTimestamp": "2026-10-10T08:28:41.984+00:00",
          "responseTimestamp": "2026-10-10T08:28:45.806+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "request_id": "35268060",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12513-3862-7261-ae4a-79265df0b73a",
          "callPart": 135,
          "resultPart": 136,
          "callTimestamp": "2026-10-10T09:34:49.928+00:00",
          "responseTimestamp": "2026-10-10T09:35:13.452+00:00",
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
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "request_id": "35277559",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "request_id": "35286001",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
          "callPart": 146,
          "resultPart": 147,
          "callTimestamp": "2026-10-10T10:15:55.774+00:00",
          "responseTimestamp": "2026-10-10T10:16:00.424+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 5,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "acceptedPairCount": 0,
      "outcomeJoined": false
    },
    {
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "request_id": "35289337",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a12531-ca04-75f2-a94c-e14631082377",
          "callPart": 166,
          "resultPart": 167,
          "callTimestamp": "2026-10-10T10:23:12.583+00:00",
          "responseTimestamp": "2026-10-10T10:23:43.677+00:00",
          "mechanisms": [
            "native-wrapper"
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
          "nativeSession": "01a12531-ca04-75f2-a94c-e14631082377",
          "callPart": 166,
          "resultPart": 169,
          "callTimestamp": "2026-10-10T10:23:12.583+00:00",
          "responseTimestamp": "2026-10-10T10:23:57.489+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "65",
            "yieldPart": 167,
            "waitPart": 168,
            "originalCallPart": 166
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
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "request_id": "35305755",
      "acceptedUnique": false,
      "completeOriginalPair": false,
      "receiptState": "unresolved",
      "pairs": [
        {
          "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
          "callPart": 266,
          "resultPart": 267,
          "callTimestamp": "2026-10-10T11:04:11.563+00:00",
          "responseTimestamp": "2026-10-10T11:04:15.94+00:00",
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
          "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
          "callPart": 270,
          "resultPart": 271,
          "callTimestamp": "2026-10-10T11:04:47.029+00:00",
          "responseTimestamp": "2026-10-10T11:05:05.947+00:00",
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
    }
  ],
  "sessionAssessments": [
    {
      "request_id": "35044097",
      "owner": "su-ab8cc07f-e903-4467-ac45-a32149258170",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
          "callPart": 151,
          "resultPart": 152,
          "callTimestamp": "2026-10-10T01:14:16.889+00:00",
          "responseTimestamp": "2026-10-10T01:14:21.533+00:00",
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
          "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
          "callPart": 153,
          "resultPart": 154,
          "callTimestamp": "2026-10-10T01:14:31.403+00:00",
          "responseTimestamp": "2026-10-10T01:14:37.246+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
      "request_id": "35045222",
      "owner": "su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
          "callPart": 65,
          "resultPart": 66,
          "callTimestamp": "2026-10-10T01:17:53.241+00:00",
          "responseTimestamp": "2026-10-10T01:17:56.361+00:00",
          "mechanisms": [
            "invoke"
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
      "request_id": "35046578",
      "owner": "su-3067d842-6f5a-41ad-bada-9a47df0ea9a6",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
          "callPart": 121,
          "resultPart": 122,
          "callTimestamp": "2026-10-10T01:20:31.694+00:00",
          "responseTimestamp": "2026-10-10T01:20:48.884+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
        },
        {
          "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
          "callPart": 123,
          "resultPart": 124,
          "callTimestamp": "2026-10-10T01:21:28.146+00:00",
          "responseTimestamp": "2026-10-10T01:21:41.741+00:00",
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
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35047650",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
          "callPart": 167,
          "resultPart": 168,
          "callTimestamp": "2026-10-10T01:22:36.494+00:00",
          "responseTimestamp": "2026-10-10T01:22:55.034+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
      "request_id": "35058458",
      "owner": "su-b7ae044b-c702-4275-8857-d8c0943bc6f6",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12366-709f-7563-883f-29a8b509fa28",
          "callPart": 92,
          "resultPart": 93,
          "callTimestamp": "2026-10-10T01:42:38.818+00:00",
          "responseTimestamp": "2026-10-10T01:42:47.694+00:00",
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
      "request_id": "35063976",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 158,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:54:47.058+00:00",
          "mechanisms": [
            "native-wrapper"
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
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 157,
          "resultPart": 160,
          "callTimestamp": "2026-10-10T01:54:16.017+00:00",
          "responseTimestamp": "2026-10-10T01:55:23.789+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "yieldPart": 158,
            "waitPart": 159,
            "originalCallPart": 157
          },
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
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 159,
          "resultPart": 163,
          "callTimestamp": "2026-10-10T01:54:52.783+00:00",
          "responseTimestamp": "2026-10-10T01:55:59.527+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "yieldPart": 160,
            "waitPart": 162,
            "originalCallPart": 159
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
          "callPart": 162,
          "resultPart": 165,
          "callTimestamp": "2026-10-10T01:55:28.513+00:00",
          "responseTimestamp": "2026-10-10T01:56:04.149+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "71",
            "yieldPart": 163,
            "waitPart": 164,
            "originalCallPart": 162
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
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
      "request_id": "35064368",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 127,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:55:38.766+00:00",
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
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 126,
          "resultPart": 129,
          "callTimestamp": "2026-10-10T01:55:07.723+00:00",
          "responseTimestamp": "2026-10-10T01:56:15.438+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "yieldPart": 127,
            "waitPart": 128,
            "originalCallPart": 126
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
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 128,
          "resultPart": 131,
          "callTimestamp": "2026-10-10T01:55:44.43+00:00",
          "responseTimestamp": "2026-10-10T01:56:51.596+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "yieldPart": 129,
            "waitPart": 130,
            "originalCallPart": 128
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        },
        {
          "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
          "callPart": 130,
          "resultPart": 133,
          "callTimestamp": "2026-10-10T01:56:20.585+00:00",
          "responseTimestamp": "2026-10-10T01:56:58.885+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "56",
            "yieldPart": 131,
            "waitPart": 132,
            "originalCallPart": 130
          },
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": false,
          "sourceComplete": true,
          "parseErrors": 3,
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
      "request_id": "35099533",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
          "callPart": 102,
          "resultPart": 103,
          "callTimestamp": "2026-10-10T03:11:19.842+00:00",
          "responseTimestamp": "2026-10-10T03:11:30.513+00:00",
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
          "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
          "callPart": 106,
          "resultPart": 107,
          "callTimestamp": "2026-10-10T03:12:08.306+00:00",
          "responseTimestamp": "2026-10-10T03:12:37.937+00:00",
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
        },
        {
          "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
          "callPart": 108,
          "resultPart": 109,
          "callTimestamp": "2026-10-10T03:13:22.329+00:00",
          "responseTimestamp": "2026-10-10T03:13:31.891+00:00",
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
    },
    {
      "request_id": "35108257",
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a123d2-ee6c-7bc1-9a95-34572719bfe8",
          "callPart": 72,
          "resultPart": 73,
          "callTimestamp": "2026-10-10T03:32:20.565+00:00",
          "responseTimestamp": "2026-10-10T03:32:44.738+00:00",
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
      "request_id": "35109461",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
          "callPart": 177,
          "resultPart": 178,
          "callTimestamp": "2026-10-10T03:34:44.285+00:00",
          "responseTimestamp": "2026-10-10T03:34:44.474+00:00",
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
          "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
          "callPart": 181,
          "resultPart": 182,
          "callTimestamp": "2026-10-10T03:35:07.629+00:00",
          "responseTimestamp": "2026-10-10T03:35:17.09+00:00",
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
      "request_id": "35119644",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
          "callPart": 116,
          "resultPart": 117,
          "callTimestamp": "2026-10-10T03:55:12.063+00:00",
          "responseTimestamp": "2026-10-10T03:55:30.782+00:00",
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
          "nativeSession": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
          "callPart": 118,
          "resultPart": 119,
          "callTimestamp": "2026-10-10T03:56:01.867+00:00",
          "responseTimestamp": "2026-10-10T03:56:30.316+00:00",
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
      "request_id": "35120408",
      "owner": "su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5",
      "completeOriginalPair": true,
      "pairs": [
        {
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 150,
          "resultPart": 151,
          "callTimestamp": "2026-10-10T03:57:01.877+00:00",
          "responseTimestamp": "2026-10-10T03:57:15.263+00:00",
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
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 154,
          "resultPart": 155,
          "callTimestamp": "2026-10-10T03:57:34.569+00:00",
          "responseTimestamp": "2026-10-10T03:57:34.961+00:00",
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
          "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
          "callPart": 156,
          "resultPart": 157,
          "callTimestamp": "2026-10-10T03:57:42.109+00:00",
          "responseTimestamp": "2026-10-10T03:58:04.747+00:00",
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
      "request_id": "35121480",
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
          "callPart": 139,
          "resultPart": 140,
          "callTimestamp": "2026-10-10T03:59:38.018+00:00",
          "responseTimestamp": "2026-10-10T04:00:09.081+00:00",
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
          "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
          "callPart": 139,
          "resultPart": 143,
          "callTimestamp": "2026-10-10T03:59:38.018+00:00",
          "responseTimestamp": "2026-10-10T04:00:26.923+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "65",
            "yieldPart": 140,
            "waitPart": 142,
            "originalCallPart": 139
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
          "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
          "callPart": 142,
          "resultPart": 145,
          "callTimestamp": "2026-10-10T04:00:15.911+00:00",
          "responseTimestamp": "2026-10-10T04:00:31.129+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "65",
            "yieldPart": 143,
            "waitPart": 144,
            "originalCallPart": 142
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
      "request_id": "35133707",
      "owner": "su-8d2cb6cc-8f27-4a25-8541-b00927471b94",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a123fe-6eda-7640-9dc5-7f91366ee84e",
          "callPart": 157,
          "resultPart": 158,
          "callTimestamp": "2026-10-10T04:28:03.242+00:00",
          "responseTimestamp": "2026-10-10T04:28:04.775+00:00",
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
      "request_id": "35145396",
      "owner": "su-faf26552-0633-4081-a250-172c02f07c19",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
          "callPart": 101,
          "resultPart": 102,
          "callTimestamp": "2026-10-10T04:52:09.122+00:00",
          "responseTimestamp": "2026-10-10T04:52:23.484+00:00",
          "mechanisms": [
            "invoke"
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
      "request_id": "35232736",
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
          "callPart": 197,
          "resultPart": 198,
          "callTimestamp": "2026-10-10T08:14:04.231+00:00",
          "responseTimestamp": "2026-10-10T08:14:35.255+00:00",
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
          "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
          "callPart": 197,
          "resultPart": 200,
          "callTimestamp": "2026-10-10T08:14:04.231+00:00",
          "responseTimestamp": "2026-10-10T08:14:47.334+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "90",
            "yieldPart": 198,
            "waitPart": 199,
            "originalCallPart": 197
          },
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
      "request_id": "35239534",
      "owner": "su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
          "callPart": 95,
          "resultPart": 96,
          "callTimestamp": "2026-10-10T08:27:58.704+00:00",
          "responseTimestamp": "2026-10-10T08:28:03.203+00:00",
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
          "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
          "callPart": 99,
          "resultPart": 100,
          "callTimestamp": "2026-10-10T08:28:41.984+00:00",
          "responseTimestamp": "2026-10-10T08:28:45.806+00:00",
          "mechanisms": [
            "ptool-quoted-json"
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
      "request_id": "35268060",
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12513-3862-7261-ae4a-79265df0b73a",
          "callPart": 135,
          "resultPart": 136,
          "callTimestamp": "2026-10-10T09:34:49.928+00:00",
          "responseTimestamp": "2026-10-10T09:35:13.452+00:00",
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
      "request_id": "35286001",
      "owner": "su-4adf5ebc-6443-4c3c-b704-162275765ff1",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
          "callPart": 146,
          "resultPart": 147,
          "callTimestamp": "2026-10-10T10:15:55.774+00:00",
          "responseTimestamp": "2026-10-10T10:16:00.424+00:00",
          "mechanisms": [],
          "conditionalAlternatives": false,
          "chain": null,
          "literalArgsEqual": false,
          "ownerEqual": true,
          "bounds": true,
          "sourceComplete": false,
          "parseErrors": 5,
          "receiptState": "unclassified",
          "statusAgrees": false,
          "completeOriginalPair": false
        }
      ],
      "receiptState": "unresolved",
      "outcomeJoined": false
    },
    {
      "request_id": "35289337",
      "owner": "su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a12531-ca04-75f2-a94c-e14631082377",
          "callPart": 166,
          "resultPart": 167,
          "callTimestamp": "2026-10-10T10:23:12.583+00:00",
          "responseTimestamp": "2026-10-10T10:23:43.677+00:00",
          "mechanisms": [
            "native-wrapper"
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
          "nativeSession": "01a12531-ca04-75f2-a94c-e14631082377",
          "callPart": 166,
          "resultPart": 169,
          "callTimestamp": "2026-10-10T10:23:12.583+00:00",
          "responseTimestamp": "2026-10-10T10:23:57.489+00:00",
          "mechanisms": [
            "native-wrapper"
          ],
          "conditionalAlternatives": false,
          "chain": {
            "cellId": "65",
            "yieldPart": 167,
            "waitPart": 168,
            "originalCallPart": 166
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
      "request_id": "35305755",
      "owner": "su-1415d088-0af5-4299-a5df-8dbfc634335b",
      "completeOriginalPair": false,
      "pairs": [
        {
          "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
          "callPart": 266,
          "resultPart": 267,
          "callTimestamp": "2026-10-10T11:04:11.563+00:00",
          "responseTimestamp": "2026-10-10T11:04:15.94+00:00",
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
          "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
          "callPart": 270,
          "resultPart": 271,
          "callTimestamp": "2026-10-10T11:04:47.029+00:00",
          "responseTimestamp": "2026-10-10T11:05:05.947+00:00",
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
    }
  ],
  "executions": [
    {
      "request_id": "35044097",
      "nativeSession": "01a1234a-0d22-76c3-9b5c-17845a8123b4",
      "exitCode": 0,
      "seconds": 0.32620841905009,
      "inputBytes": 39116,
      "stdout": "{\"rows\":[{\"request_id\":\"35044097\",\"owner\":\"su-ab8cc07f-e903-4467-ac45-a32149258170\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1234a-0d22-76c3-9b5c-17845a8123b4\",\"callPart\":151,\"resultPart\":152,\"callTimestamp\":\"2026-10-10T01:14:16.889+00:00\",\"responseTimestamp\":\"2026-10-10T01:14:21.533+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1234a-0d22-76c3-9b5c-17845a8123b4\",\"callPart\":153,\"resultPart\":154,\"callTimestamp\":\"2026-10-10T01:14:31.403+00:00\",\"responseTimestamp\":\"2026-10-10T01:14:37.246+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35045222",
      "nativeSession": "01a12354-76df-7230-8a3e-7b5bc95a62ef",
      "exitCode": 0,
      "seconds": 0.2890129539882764,
      "inputBytes": 20461,
      "stdout": "{\"rows\":[{\"request_id\":\"35045222\",\"owner\":\"su-960a52e7-9b11-42ac-8fe9-7e5e7e0da441\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12354-76df-7230-8a3e-7b5bc95a62ef\",\"callPart\":65,\"resultPart\":66,\"callTimestamp\":\"2026-10-10T01:17:53.241+00:00\",\"responseTimestamp\":\"2026-10-10T01:17:56.361+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35046578",
      "nativeSession": "01a12353-79f3-73f3-aa5d-89fd463e5c5b",
      "exitCode": 0,
      "seconds": 0.277770233922638,
      "inputBytes": 35252,
      "stdout": "{\"rows\":[{\"request_id\":\"35046578\",\"owner\":\"su-3067d842-6f5a-41ad-bada-9a47df0ea9a6\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12353-79f3-73f3-aa5d-89fd463e5c5b\",\"callPart\":121,\"resultPart\":122,\"callTimestamp\":\"2026-10-10T01:20:31.694+00:00\",\"responseTimestamp\":\"2026-10-10T01:20:48.884+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12353-79f3-73f3-aa5d-89fd463e5c5b\",\"callPart\":123,\"resultPart\":124,\"callTimestamp\":\"2026-10-10T01:21:28.146+00:00\",\"responseTimestamp\":\"2026-10-10T01:21:41.741+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35047650",
      "nativeSession": "01a1234b-2ad5-7db0-86b8-4dcb0f9aa366",
      "exitCode": 0,
      "seconds": 0.3127917379606515,
      "inputBytes": 34138,
      "stdout": "{\"rows\":[{\"request_id\":\"35047650\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1234b-2ad5-7db0-86b8-4dcb0f9aa366\",\"callPart\":167,\"resultPart\":168,\"callTimestamp\":\"2026-10-10T01:22:36.494+00:00\",\"responseTimestamp\":\"2026-10-10T01:22:55.034+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35058458",
      "nativeSession": "01a12366-709f-7563-883f-29a8b509fa28",
      "exitCode": 0,
      "seconds": 0.33055917208548635,
      "inputBytes": 18852,
      "stdout": "{\"rows\":[{\"request_id\":\"35058458\",\"owner\":\"su-b7ae044b-c702-4275-8857-d8c0943bc6f6\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12366-709f-7563-883f-29a8b509fa28\",\"callPart\":92,\"resultPart\":93,\"callTimestamp\":\"2026-10-10T01:42:38.818+00:00\",\"responseTimestamp\":\"2026-10-10T01:42:47.694+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35063976",
      "nativeSession": "01a12367-db6e-7d32-b369-cb7e792a16e4",
      "exitCode": 0,
      "seconds": 0.30735662404913455,
      "inputBytes": 21646,
      "stdout": "{\"rows\":[{\"request_id\":\"35063976\",\"owner\":\"su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12367-db6e-7d32-b369-cb7e792a16e4\",\"callPart\":157,\"resultPart\":158,\"callTimestamp\":\"2026-10-10T01:54:16.017+00:00\",\"responseTimestamp\":\"2026-10-10T01:54:47.058+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12367-db6e-7d32-b369-cb7e792a16e4\",\"callPart\":157,\"resultPart\":160,\"callTimestamp\":\"2026-10-10T01:54:16.017+00:00\",\"responseTimestamp\":\"2026-10-10T01:55:23.789+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"71\",\"yieldPart\":158,\"waitPart\":159,\"originalCallPart\":157},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12367-db6e-7d32-b369-cb7e792a16e4\",\"callPart\":159,\"resultPart\":163,\"callTimestamp\":\"2026-10-10T01:54:52.783+00:00\",\"responseTimestamp\":\"2026-10-10T01:55:59.527+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"71\",\"yieldPart\":160,\"waitPart\":162,\"originalCallPart\":159},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12367-db6e-7d32-b369-cb7e792a16e4\",\"callPart\":162,\"resultPart\":165,\"callTimestamp\":\"2026-10-10T01:55:28.513+00:00\",\"responseTimestamp\":\"2026-10-10T01:56:04.149+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"71\",\"yieldPart\":163,\"waitPart\":164,\"originalCallPart\":162},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":3,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35064368",
      "nativeSession": "01a12368-3a80-78b2-b196-a4b27f28a933",
      "exitCode": 0,
      "seconds": 0.31506334396544844,
      "inputBytes": 22397,
      "stdout": "{\"rows\":[{\"request_id\":\"35064368\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12368-3a80-78b2-b196-a4b27f28a933\",\"callPart\":126,\"resultPart\":127,\"callTimestamp\":\"2026-10-10T01:55:07.723+00:00\",\"responseTimestamp\":\"2026-10-10T01:55:38.766+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12368-3a80-78b2-b196-a4b27f28a933\",\"callPart\":126,\"resultPart\":129,\"callTimestamp\":\"2026-10-10T01:55:07.723+00:00\",\"responseTimestamp\":\"2026-10-10T01:56:15.438+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"56\",\"yieldPart\":127,\"waitPart\":128,\"originalCallPart\":126},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12368-3a80-78b2-b196-a4b27f28a933\",\"callPart\":128,\"resultPart\":131,\"callTimestamp\":\"2026-10-10T01:55:44.43+00:00\",\"responseTimestamp\":\"2026-10-10T01:56:51.596+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"56\",\"yieldPart\":129,\"waitPart\":130,\"originalCallPart\":128},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12368-3a80-78b2-b196-a4b27f28a933\",\"callPart\":130,\"resultPart\":133,\"callTimestamp\":\"2026-10-10T01:56:20.585+00:00\",\"responseTimestamp\":\"2026-10-10T01:56:58.885+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"56\",\"yieldPart\":131,\"waitPart\":132,\"originalCallPart\":130},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":3,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"json\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35099533",
      "nativeSession": "01a123b4-6f42-7472-a975-3a2ba6200ff0",
      "exitCode": 0,
      "seconds": 0.28758226498030126,
      "inputBytes": 42913,
      "stdout": "{\"rows\":[{\"request_id\":\"35099533\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a123b4-6f42-7472-a975-3a2ba6200ff0\",\"callPart\":102,\"resultPart\":103,\"callTimestamp\":\"2026-10-10T03:11:19.842+00:00\",\"responseTimestamp\":\"2026-10-10T03:11:30.513+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123b4-6f42-7472-a975-3a2ba6200ff0\",\"callPart\":106,\"resultPart\":107,\"callTimestamp\":\"2026-10-10T03:12:08.306+00:00\",\"responseTimestamp\":\"2026-10-10T03:12:37.937+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123b4-6f42-7472-a975-3a2ba6200ff0\",\"callPart\":108,\"resultPart\":109,\"callTimestamp\":\"2026-10-10T03:13:22.329+00:00\",\"responseTimestamp\":\"2026-10-10T03:13:31.891+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35108257",
      "nativeSession": "01a123d2-ee6c-7bc1-9a95-34572719bfe8",
      "exitCode": 0,
      "seconds": 0.34626714105252177,
      "inputBytes": 15799,
      "stdout": "{\"rows\":[{\"request_id\":\"35108257\",\"owner\":\"su-faf26552-0633-4081-a250-172c02f07c19\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a123d2-ee6c-7bc1-9a95-34572719bfe8\",\"callPart\":72,\"resultPart\":73,\"callTimestamp\":\"2026-10-10T03:32:20.565+00:00\",\"responseTimestamp\":\"2026-10-10T03:32:44.738+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35109461",
      "nativeSession": "01a123bb-3402-7a32-ac21-9d650b1634a4",
      "exitCode": 0,
      "seconds": 0.39153705700300634,
      "inputBytes": 27886,
      "stdout": "{\"rows\":[{\"request_id\":\"35109461\",\"owner\":\"su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a123bb-3402-7a32-ac21-9d650b1634a4\",\"callPart\":177,\"resultPart\":178,\"callTimestamp\":\"2026-10-10T03:34:44.285+00:00\",\"responseTimestamp\":\"2026-10-10T03:34:44.474+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123bb-3402-7a32-ac21-9d650b1634a4\",\"callPart\":181,\"resultPart\":182,\"callTimestamp\":\"2026-10-10T03:35:07.629+00:00\",\"responseTimestamp\":\"2026-10-10T03:35:17.09+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35119644",
      "nativeSession": "01a123e1-9727-72a2-b3d3-c4f01fe4b1ed",
      "exitCode": 0,
      "seconds": 0.40885833592619747,
      "inputBytes": 28614,
      "stdout": "{\"rows\":[{\"request_id\":\"35119644\",\"owner\":\"su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a123e1-9727-72a2-b3d3-c4f01fe4b1ed\",\"callPart\":116,\"resultPart\":117,\"callTimestamp\":\"2026-10-10T03:55:12.063+00:00\",\"responseTimestamp\":\"2026-10-10T03:55:30.782+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123e1-9727-72a2-b3d3-c4f01fe4b1ed\",\"callPart\":118,\"resultPart\":119,\"callTimestamp\":\"2026-10-10T03:56:01.867+00:00\",\"responseTimestamp\":\"2026-10-10T03:56:30.316+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35120408",
      "nativeSession": "01a123e1-8631-7722-98ac-33f2b3786d4f",
      "exitCode": 0,
      "seconds": 0.3866415920201689,
      "inputBytes": 35276,
      "stdout": "{\"rows\":[{\"request_id\":\"35120408\",\"owner\":\"su-0a26cdb5-a119-46b6-8484-4aca92cfc4c5\",\"completeOriginalPair\":true,\"pairs\":[{\"nativeSession\":\"01a123e1-8631-7722-98ac-33f2b3786d4f\",\"callPart\":150,\"resultPart\":151,\"callTimestamp\":\"2026-10-10T03:57:01.877+00:00\",\"responseTimestamp\":\"2026-10-10T03:57:15.263+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123e1-8631-7722-98ac-33f2b3786d4f\",\"callPart\":154,\"resultPart\":155,\"callTimestamp\":\"2026-10-10T03:57:34.569+00:00\",\"responseTimestamp\":\"2026-10-10T03:57:34.961+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123e1-8631-7722-98ac-33f2b3786d4f\",\"callPart\":156,\"resultPart\":157,\"callTimestamp\":\"2026-10-10T03:57:42.109+00:00\",\"responseTimestamp\":\"2026-10-10T03:58:04.747+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"queued\",\"statusAgrees\":true,\"format\":\"toon\",\"requested\":true,\"respawn\":\"queued\",\"completeOriginalPair\":true}],\"receiptState\":\"queued\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35121480",
      "nativeSession": "01a123df-0540-7073-ab0f-160863c68c25",
      "exitCode": 0,
      "seconds": 0.3364067339571193,
      "inputBytes": 22802,
      "stdout": "{\"rows\":[{\"request_id\":\"35121480\",\"owner\":\"su-faf26552-0633-4081-a250-172c02f07c19\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a123df-0540-7073-ab0f-160863c68c25\",\"callPart\":139,\"resultPart\":140,\"callTimestamp\":\"2026-10-10T03:59:38.018+00:00\",\"responseTimestamp\":\"2026-10-10T04:00:09.081+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123df-0540-7073-ab0f-160863c68c25\",\"callPart\":139,\"resultPart\":143,\"callTimestamp\":\"2026-10-10T03:59:38.018+00:00\",\"responseTimestamp\":\"2026-10-10T04:00:26.923+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"65\",\"yieldPart\":140,\"waitPart\":142,\"originalCallPart\":139},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a123df-0540-7073-ab0f-160863c68c25\",\"callPart\":142,\"resultPart\":145,\"callTimestamp\":\"2026-10-10T04:00:15.911+00:00\",\"responseTimestamp\":\"2026-10-10T04:00:31.129+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"65\",\"yieldPart\":143,\"waitPart\":144,\"originalCallPart\":142},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":3,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35133707",
      "nativeSession": "01a123fe-6eda-7640-9dc5-7f91366ee84e",
      "exitCode": 0,
      "seconds": 0.3245879290625453,
      "inputBytes": 27840,
      "stdout": "{\"rows\":[{\"request_id\":\"35133707\",\"owner\":\"su-8d2cb6cc-8f27-4a25-8541-b00927471b94\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a123fe-6eda-7640-9dc5-7f91366ee84e\",\"callPart\":157,\"resultPart\":158,\"callTimestamp\":\"2026-10-10T04:28:03.242+00:00\",\"responseTimestamp\":\"2026-10-10T04:28:04.775+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35145396",
      "nativeSession": "01a12411-e413-7d30-ae42-79e0a4cd8440",
      "exitCode": 0,
      "seconds": 0.3497390099801123,
      "inputBytes": 28932,
      "stdout": "{\"rows\":[{\"request_id\":\"35145396\",\"owner\":\"su-faf26552-0633-4081-a250-172c02f07c19\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12411-e413-7d30-ae42-79e0a4cd8440\",\"callPart\":101,\"resultPart\":102,\"callTimestamp\":\"2026-10-10T04:52:09.122+00:00\",\"responseTimestamp\":\"2026-10-10T04:52:23.484+00:00\",\"mechanisms\":[\"invoke\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35232736",
      "nativeSession": "01a124bf-7bab-7351-93bf-9daa6283b81e",
      "exitCode": 0,
      "seconds": 0.3106690120184794,
      "inputBytes": 28629,
      "stdout": "{\"rows\":[{\"request_id\":\"35232736\",\"owner\":\"su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a124bf-7bab-7351-93bf-9daa6283b81e\",\"callPart\":197,\"resultPart\":198,\"callTimestamp\":\"2026-10-10T08:14:04.231+00:00\",\"responseTimestamp\":\"2026-10-10T08:14:35.255+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a124bf-7bab-7351-93bf-9daa6283b81e\",\"callPart\":197,\"resultPart\":200,\"callTimestamp\":\"2026-10-10T08:14:04.231+00:00\",\"responseTimestamp\":\"2026-10-10T08:14:47.334+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"90\",\"yieldPart\":198,\"waitPart\":199,\"originalCallPart\":197},\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35239534",
      "nativeSession": "01a124df-4dc0-7741-97a6-73362938b29d",
      "exitCode": 0,
      "seconds": 0.3013009940041229,
      "inputBytes": 29701,
      "stdout": "{\"rows\":[{\"request_id\":\"35239534\",\"owner\":\"su-312c90f2-a3bd-4c92-ac4e-4eae40ae2647\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a124df-4dc0-7741-97a6-73362938b29d\",\"callPart\":95,\"resultPart\":96,\"callTimestamp\":\"2026-10-10T08:27:58.704+00:00\",\"responseTimestamp\":\"2026-10-10T08:28:03.203+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a124df-4dc0-7741-97a6-73362938b29d\",\"callPart\":99,\"resultPart\":100,\"callTimestamp\":\"2026-10-10T08:28:41.984+00:00\",\"responseTimestamp\":\"2026-10-10T08:28:45.806+00:00\",\"mechanisms\":[\"ptool-quoted-json\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35268060",
      "nativeSession": "01a12513-3862-7261-ae4a-79265df0b73a",
      "exitCode": 0,
      "seconds": 0.34217636089306325,
      "inputBytes": 15546,
      "stdout": "{\"rows\":[{\"request_id\":\"35268060\",\"owner\":\"su-1415d088-0af5-4299-a5df-8dbfc634335b\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12513-3862-7261-ae4a-79265df0b73a\",\"callPart\":135,\"resultPart\":136,\"callTimestamp\":\"2026-10-10T09:34:49.928+00:00\",\"responseTimestamp\":\"2026-10-10T09:35:13.452+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":1,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35286001",
      "nativeSession": "01a1253f-e361-75a0-a286-aeb68a8fb97d",
      "exitCode": 0,
      "seconds": 0.29812311194837093,
      "inputBytes": 22292,
      "stdout": "{\"rows\":[{\"request_id\":\"35286001\",\"owner\":\"su-4adf5ebc-6443-4c3c-b704-162275765ff1\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1253f-e361-75a0-a286-aeb68a8fb97d\",\"callPart\":146,\"resultPart\":147,\"callTimestamp\":\"2026-10-10T10:15:55.774+00:00\",\"responseTimestamp\":\"2026-10-10T10:16:00.424+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":5,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35289337",
      "nativeSession": "01a12531-ca04-75f2-a94c-e14631082377",
      "exitCode": 0,
      "seconds": 0.31000330997630954,
      "inputBytes": 32097,
      "stdout": "{\"rows\":[{\"request_id\":\"35289337\",\"owner\":\"su-d88420f0-c0b4-4dc7-92c7-f60ab3ddab44\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a12531-ca04-75f2-a94c-e14631082377\",\"callPart\":166,\"resultPart\":167,\"callTimestamp\":\"2026-10-10T10:23:12.583+00:00\",\"responseTimestamp\":\"2026-10-10T10:23:43.677+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a12531-ca04-75f2-a94c-e14631082377\",\"callPart\":166,\"resultPart\":169,\"callTimestamp\":\"2026-10-10T10:23:12.583+00:00\",\"responseTimestamp\":\"2026-10-10T10:23:57.489+00:00\",\"mechanisms\":[\"native-wrapper\"],\"conditionalAlternatives\":false,\"chain\":{\"cellId\":\"65\",\"yieldPart\":167,\"waitPart\":168,\"originalCallPart\":166},\"literalArgsEqual\":true,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":true,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    },
    {
      "request_id": "35305755",
      "nativeSession": "01a1254c-cc9a-75c0-9c26-f5e67d2b79a3",
      "exitCode": 0,
      "seconds": 0.31498371402267367,
      "inputBytes": 35947,
      "stdout": "{\"rows\":[{\"request_id\":\"35305755\",\"owner\":\"su-1415d088-0af5-4299-a5df-8dbfc634335b\",\"completeOriginalPair\":false,\"pairs\":[{\"nativeSession\":\"01a1254c-cc9a-75c0-9c26-f5e67d2b79a3\",\"callPart\":266,\"resultPart\":267,\"callTimestamp\":\"2026-10-10T11:04:11.563+00:00\",\"responseTimestamp\":\"2026-10-10T11:04:15.94+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":false,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false},{\"nativeSession\":\"01a1254c-cc9a-75c0-9c26-f5e67d2b79a3\",\"callPart\":270,\"resultPart\":271,\"callTimestamp\":\"2026-10-10T11:04:47.029+00:00\",\"responseTimestamp\":\"2026-10-10T11:05:05.947+00:00\",\"mechanisms\":[],\"conditionalAlternatives\":false,\"chain\":null,\"literalArgsEqual\":false,\"ownerEqual\":true,\"bounds\":true,\"sourceComplete\":false,\"parseErrors\":0,\"receiptState\":\"unclassified\",\"statusAgrees\":false,\"completeOriginalPair\":false}],\"receiptState\":\"unresolved\",\"outcomeJoined\":false}]}\n",
      "stderr": ""
    }
  ],
  "limits": [
    "Outcomes joined0; whole116 continuity/eligibility unaccepted.",
    "Original truncated source remains incomplete."
  ]
}
