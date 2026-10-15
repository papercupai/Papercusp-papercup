---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-cold25-native-analysis-instrument-424d5.json"
updated_at: 1791895087179
_body: "content"
---

{
  "schemaVersion": "cold25-native-analysis-instrument-v1",
  "observedAt": "2026-10-13T12:38:05.084Z",
  "sourceRef": "audits/parked-agent-resumption-2026-10-09/r13-cold23-remaining-direct-originals-424d5.json",
  "parser": "import ts from \"typescript\";\nimport {decode} from \"./libs/generic/result-encoding/src/encode.ts\";\nimport {parseJsonWithTrailer} from \"./libs/generic/tooldef/src/code-orchestration/json-prefix.ts\";\nconst input=await Bun.stdin.json();\nfunction receipt(text){\n const oi=text.indexOf(\"Output:\\n\"), b=oi>=0?text.slice(oi+8).trim():text.trim();\n const matches=[],errors=[];\n const decodeBody=(str,meta={})=>{\n  let body,fmt=\"json\";\n  try{const m=/^format: (\\S+)\\n/.exec(str);fmt=m?.[1]||\"json\";\n   if(m){const trailer=str.indexOf(\"\\nSee also:\");if(trailer>=0){if(!str.slice(trailer+1).split(\"\\n\").every(x=>x.startsWith(\"See also:\")))throw Error(\"non-reference format trailer\");str=str.slice(0,trailer);}body=decode(str.slice(m[0].length),m[1]);}\n   else{const pp=parseJsonWithTrailer(str);body=pp?pp.value:JSON.parse(str);}\n  }catch(e){errors.push({error:\"decode\",detail:String(e)});return;}\n  if(body&&typeof body===\"object\"&&typeof body.requested===\"boolean\"&&(\"respawn\" in body||\"error\" in body))matches.push({body,format:fmt,...meta});\n };\n const walk=(x,path=\"$\")=>{\n  if(typeof x===\"string\"){if(/^format: \\S+\\n/.test(x)||/^[\\[{\\\"]/.test(x.trim()))decodeBody(x,{path,textBlocks:null});return;}\n  if(!x||typeof x!==\"object\")return;\n  if(x.type===\"text\"&&typeof x.text===\"string\"){decodeBody(x.text,{path,textBlocks:null});return;}\n  if(typeof x.requested===\"boolean\"&&(\"respawn\" in x||\"error\" in x)){matches.push({body:x,format:\"json\",path,textBlocks:null});return;}\n  if(Array.isArray(x)){x.forEach((v,i)=>walk(v,path+\"[\"+i+\"]\"));return;}\n  if(Array.isArray(x.content)){\n   const blocks=x.content.map(v=>typeof v===\"string\"?v:v?.type===\"text\"?v.text:null).filter(v=>typeof v===\"string\");\n   if(x.structuredContent&&typeof x.structuredContent.requested===\"boolean\")matches.push({body:x.structuredContent,format:\"structuredContent\",isError:x.isError===true,textBlocks:blocks.length,path});\n   else for(let i=0;i<blocks.length;i++)decodeBody(blocks[i],{isError:x.isError===true,textBlocks:blocks.length,path:path+\".text[\"+i+\"]\",contentShape:x.content.every(v=>typeof v===\"string\")?\"text-strings\":\"MCP-blocks\"});\n   return;\n  }\n  for(const [key,value] of Object.entries(x))walk(value,path+\".\"+key);\n };\n const labelled=/^(?:COMPACTION |compaction: |compaction_request=)(format: \\S+\\n[\\s\\S]*)$/.exec(b);\n if(labelled)decodeBody(labelled[1],{textBlocks:null,path:\"$labelled-format\"});\n else if(/^format: \\S+\\n/.test(b))decodeBody(b,{textBlocks:null,path:\"$direct-format\"});\n else{\n  let v;try{v=JSON.parse(b);}catch{const pp=parseJsonWithTrailer(b);if(pp)v=pp.value;}\n  if(v===undefined){\n   const lines=b.split(\"\\n\").filter(x=>x.trim());\n   try{const stream=lines.map(x=>JSON.parse(x.replace(/^(?:release|compaction): /,\"\")));if(stream.length<1)throw Error(\"not-stream\");stream.forEach((x,i)=>walk(x,\"$stream[\"+i+\"]\"));}\n   catch{return {error:\"no-leading-json-format-or-complete-json-stream\"};}\n  }else walk(v);\n }\n return matches.length===1?matches[0]:{error:matches.length>1?\"multiple-compaction-bodies\":\"no-compaction-body\",matches:matches.length,errors};\n}\nconst stable=v=>v===null||typeof v!==\"object\"?JSON.stringify(v):Array.isArray(v)?\"[\"+v.map(stable).join(\",\")+\"]\":\"{\"+Object.keys(v).sort().map(k=>JSON.stringify(k)+\":\"+stable(v[k])).join(\",\")+\"}\";\nconst clipped=s=>/…\\s*\\[truncated|\\[truncated \\d+ chars\\]/i.test(s);\nfunction exactCalls(text){\n const sf=ts.createSourceFile(\"source.ts\",text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS),bindings=new Map(),out=[],changed=new Set();\n for(const s of sf.statements)if(ts.isVariableStatement(s)&&(s.declarationList.flags&ts.NodeFlags.Const))for(const d of s.declarationList.declarations)if(ts.isIdentifier(d.name)&&d.initializer){if(bindings.has(d.name.text))changed.add(d.name.text);bindings.set(d.name.text,d.initializer);}\n const root=n=>{while(ts.isPropertyAccessExpression(n)||ts.isElementAccessExpression(n))n=n.expression;return ts.isIdentifier(n)?n.text:null;};\n const mutations=n=>{if(ts.isBinaryExpression(n)&&n.operatorToken.kind>=ts.SyntaxKind.FirstAssignment&&n.operatorToken.kind<=ts.SyntaxKind.LastAssignment){const r=root(n.left);if(r)changed.add(r);}\n if((ts.isPrefixUnaryExpression(n)||ts.isPostfixUnaryExpression(n))&&[ts.SyntaxKind.PlusPlusToken,ts.SyntaxKind.MinusMinusToken].includes(n.operator)){const r=root(n.operand);if(r)changed.add(r);}\n if(ts.isDeleteExpression(n)){const r=root(n.expression);if(r)changed.add(r);}\n if(ts.isCallExpression(n)&&ts.isPropertyAccessExpression(n.expression)&&[\"push\",\"pop\",\"shift\",\"unshift\",\"splice\",\"sort\",\"reverse\",\"fill\",\"copyWithin\",\"set\",\"delete\",\"clear\"].includes(n.expression.name.text)){const r=root(n.expression.expression);if(r)changed.add(r);}\n ts.forEachChild(n,mutations);};mutations(sf);\n const evaluating=new Set();\n function literal(n){\n  if(!n)throw Error(\"missing literal\");\n  if(ts.isParenthesizedExpression(n)||ts.isAsExpression(n))return literal(n.expression);\n  if(ts.isIdentifier(n)){if(changed.has(n.text)||!bindings.has(n.text)||evaluating.has(n.text))throw Error(\"unsafe binding \"+n.text);evaluating.add(n.text);try{return literal(bindings.get(n.text));}finally{evaluating.delete(n.text);}}\n  if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n))return n.text;\n  if(ts.isNumericLiteral(n))return Number(n.text);\n  if(n.kind===ts.SyntaxKind.TrueKeyword)return true;if(n.kind===ts.SyntaxKind.FalseKeyword)return false;if(n.kind===ts.SyntaxKind.NullKeyword)return null;\n  if(ts.isObjectLiteralExpression(n)){const r={};for(const p of n.properties){if(ts.isShorthandPropertyAssignment(p))r[p.name.text]=literal(p.name);else if(ts.isPropertyAssignment(p)&&p.name.text!==undefined){if(Object.hasOwn(r,p.name.text))throw Error(\"duplicate property\");r[p.name.text]=literal(p.initializer);}else throw Error(\"nonliteral property\");}return r;}\n  if(ts.isArrayLiteralExpression(n))return n.elements.map(literal);\n  if(ts.isBinaryExpression(n)&&n.operatorToken.kind===ts.SyntaxKind.PlusToken){const a=literal(n.left),b=literal(n.right);if(typeof a===\"string\"&&typeof b===\"string\")return a+b;throw Error(\"non-string concat\");}\n  if(ts.isCallExpression(n)&&n.expression.getText(sf)===\"JSON.stringify\"&&n.arguments.length===1&&!bindings.has(\"JSON\")&&!changed.has(\"JSON\"))return JSON.stringify(literal(n.arguments[0]));\n  throw Error(\"nonliteral \"+ts.SyntaxKind[n.kind]);\n }\n function callee(n,seen=new Set()){\n  if(ts.isParenthesizedExpression(n))return callee(n.expression,seen);\n  if(ts.isIdentifier(n)&&bindings.has(n.text)){if(changed.has(n.text)||seen.has(n.text))throw Error(\"unsafe callee alias\");seen.add(n.text);return callee(bindings.get(n.text),seen);}\n  if(ts.isElementAccessExpression(n)&&ts.isIdentifier(n.expression)&&n.expression.text===\"tools\"&&!bindings.has(\"tools\")&&!changed.has(\"tools\")){const key=literal(n.argumentExpression);if(typeof key!==\"string\")throw Error(\"non-string tool\");return \"tools.\"+key;}\n  return n.getText(sf);\n }\n const path=n=>{const p=[];for(let x=n;x.parent;x=x.parent){const a=x.parent;if(ts.isIfStatement(a))p.push({ifPos:a.pos,branch:x===a.thenStatement?\"then\":x===a.elseStatement?\"else\":\"condition\"});if(ts.isConditionalExpression(a))p.push({ifPos:a.pos,branch:x===a.whenTrue?\"then\":x===a.whenFalse?\"else\":\"condition\"});}return p;};\n const walk=n=>{if(ts.isCallExpression(n)){try{\n  for(let a=n.parent;a;a=a.parent)if(ts.isFunctionLike(a))throw Error('deferred function body');\n  const name=callee(n.expression);if(!/^tools\\.(?:mcp__papercusp_su__session_request_compaction|mcp__papercusp_su__tools_invoke|exec_command|session\\.request_compaction)$/.test(name))return;let args,mechanism;\n  if(/session_request_compaction$|session\\.request_compaction$/.test(name)){args=literal(n.arguments[0]);mechanism=\"native-wrapper\";}\n  else if(/tools[_\\.]invoke$|\\.invoke$/.test(name)){const a=literal(n.arguments[0]);if(a.name===\"session:request-compaction\"){args=a.args;mechanism=\"invoke\";}}\n  else if(/exec_command$/.test(name)){const a=literal(n.arguments[0]);if(typeof a.cmd===\"string\"&&/^ptool (?:session:request-compaction|tools:invoke)(?:\\s|$)/.test(a.cmd)){const m=/<<'JSON'\\n([\\s\\S]*?)\\nJSON(?:\\n|$)/.exec(a.cmd);if(!m)throw Error(\"no exact quoted JSON heredoc\");const v=JSON.parse(m[1]);if(/^ptool session:request-compaction(?:\\s|$)/.test(a.cmd)){args=v;mechanism=\"ptool-quoted-json\";}else if(v.name===\"session:request-compaction\"){args=v.args;mechanism=\"ptool-invoke-quoted-json\";}}}\n  if(args)out.push({args,mechanism,path:path(n)});\n }catch(e){out.push({error:String(e)});}}ts.forEachChild(n,walk);};walk(sf);\n return {parseErrors:sf.parseDiagnostics.length,calls:out};\n}\nfunction onePath(calls){\n if(calls.length===1)return true;if(calls.length!==2)return false;\n return calls[0].path.some(a=>a.branch!==\"condition\"&&calls[1].path.some(b=>a.ifPos===b.ifPos&&b.branch!==\"condition\"&&a.branch!==b.branch));\n}\nfunction assess(t){\n const ledger=t.ledger,src=t.source,parts=t.lineage||[],found=[];\n for(const c of src.source_candidates){\n  let call=c,result=c.following_parts.find(x=>x.part_kind===\"tool_result\"&&x.part_idx===c.part_idx+1),chain=null;\n  if(c.tool_name===\"wait\"){\n   let w;try{w=JSON.parse(c.text);}catch{continue;}\n   const y=parts.filter(x=>x.part_idx<c.part_idx&&x.part_kind===\"tool_result\"&&new RegExp(\"^Script running with cell ID \"+w.cell_id+\"(?:\\\\n|$)\").test(x.text)).at(-1);\n   if(!y)continue;call=parts.find(x=>x.part_idx===y.part_idx-1&&x.part_kind===\"tool_use\");if(!call)continue;\n   const intervening=parts.filter(x=>x.part_idx>y.part_idx&&x.part_idx<=c.part_idx&&x.part_kind===\"tool_use\");\n   if(!intervening.every(x=>x.tool_name===\"wait\"&&JSON.parse(x.text).cell_id===w.cell_id))continue;\n   chain={cellId:w.cell_id,yieldPart:y.part_idx,waitPart:c.part_idx,originalCallPart:call.part_idx};call={...call,session_id:c.session_id};\n  }\n  if(!result)continue;\n  const parsed=exactCalls(call.text),matches=parsed.calls.filter(x=>x.args&&stable(x.args)===stable(ledger.args_json));\n  const decoded=receipt(result.text.replace(\"compaction_request=format: \",\"format: \")),body=decoded.body;\n  const state=body?.requested===true&&body.respawn===\"queued\"?\"queued\":body?.requested===false&&body.error===\"flush-required\"?\"flush-refused\":body?.ok===false&&body.requested===false&&body.error===\"no_live_pty_host\"?\"no-host-refused\":\"unclassified\";\n  const statusAgrees=state===\"queued\"?ledger.status===\"ok\":state.endsWith(\"refused\")?ledger.status===\"refused\":false;\n  const ownerEqual=src.owner===ledger.coord_owner_id&&(call.owner===undefined||call.owner===src.owner);\n  const bounds=Date.parse(call.ts)<=Date.parse(ledger.invoked_at)-Number(ledger.duration_ms)+1000&&Date.parse(result.ts)>=Date.parse(ledger.invoked_at)-1000&&Date.parse(result.ts)>=Date.parse(call.ts);\n  const sourceComplete=!clipped(call.text)&&!clipped(result.text);\n  const complete=parsed.parseErrors===0&&matches.length>0&&onePath(matches)&&body&&statusAgrees&&ownerEqual&&bounds&&sourceComplete;\n  found.push({nativeSession:call.session_id,callPart:call.part_idx,resultPart:result.part_idx,callTimestamp:call.ts,responseTimestamp:result.ts,mechanisms:matches.map(x=>x.mechanism),conditionalAlternatives:matches.length===2,chain,literalArgsEqual:matches.length>0,ownerEqual,bounds,sourceComplete,parseErrors:parsed.parseErrors,receiptState:state,statusAgrees,format:decoded.format,requested:body?.requested,respawn:body?.respawn,error:body?.error,completeOriginalPair:!!complete});\n }\n const unique=found.filter(x=>x.completeOriginalPair);return {request_id:String(ledger.id),owner:src.owner,completeOriginalPair:unique.length===1,pairs:found,receiptState:unique.length===1?unique[0].receiptState:\"unresolved\",outcomeJoined:false};\n}\nconst output=input.targets.map(assess);console.log(JSON.stringify({rows:output}));",
  "validationProgram": "\nconst tests=[];\nfunction check(name,condition){tests.push({name,passed:!!condition});if(!condition)throw Error(\"control failed: \"+name);}\nconst a={focus:\"original\",autoContinue:true},direct=\"await tools.mcp__papercusp_su__session_request_compaction(\"+JSON.stringify(a)+\");\";\nconst match=s=>exactCalls(s).parseErrors===0&&exactCalls(s).calls.filter(x=>x.args&&stable(x.args)===stable(a));\ncheck(\"direct literal\",match(direct).length===1);\ncheck(\"constant tools index\",match('const n=\"mcp__papercusp_su__session_request_compaction\"; await tools[n]('+JSON.stringify(a)+');').length===1);\ncheck(\"constant function alias\",match('const fn=tools.mcp__papercusp_su__session_request_compaction; await fn('+JSON.stringify(a)+');').length===1);\nconst alt=match('const args='+JSON.stringify(a)+';const r=typeof tools.mcp__papercusp_su__session_request_compaction===\"function\"?await tools.mcp__papercusp_su__session_request_compaction(args):await tools.mcp__papercusp_su__tools_invoke({name:\"session:request-compaction\",args});');\ncheck(\"conditional alternatives exactly one executable path\",alt.length===2&&onePath(alt));\ncheck(\"two sequential calls rejected\",!onePath(match(direct+direct)));\ncheck(\"wrong literal focus rejected\",match(direct.replace(\"original\",\"other\")).length===0);\ncheck(\"dynamic index rejected\",match('const n=getName(); await tools[n]('+JSON.stringify(a)+');').length===0);\ncheck(\"reassigned key rejected\",match('const n=\"mcp__papercusp_su__session_request_compaction\";n=\"fake\";await tools[n]('+JSON.stringify(a)+');').length===0);\ncheck(\"mutated args rejected\",match('const args='+JSON.stringify(a)+';args.focus=\"changed\";'+direct.replace(JSON.stringify(a),\"args\")).length===0);\ncheck(\"mutated fn rejected\",match('const fn=tools.mcp__papercusp_su__session_request_compaction;fn=fake;await fn('+JSON.stringify(a)+');').length===0);\ncheck(\"uninvoked function body rejected\",match('function unused(){'+direct+'}').length===0);\ncheck(\"shadowed tools index rejected\",match('const tools=fake;const n=\"mcp__papercusp_su__session_request_compaction\";await tools[n]('+JSON.stringify(a)+');').length===0);\ncheck(\"malformed AST rejected\",exactCalls(direct.slice(0,-2)).parseErrors>0);\nconst body={ok:true,requested:true,respawn:\"queued\"},json=JSON.stringify(body),toon=\"format: toon\\nok: true\\nrequested: true\\nrespawn: queued\";\ncheck(\"direct JSON body\",receipt(json).body?.respawn===\"queued\");\ncheck(\"direct TOON body\",receipt(toon).body?.respawn===\"queued\");\ncheck(\"COMPACTION TOON label\",receipt(\"COMPACTION \"+toon).body?.respawn===\"queued\");\ncheck(\"TOON See also trailer\",receipt(toon+\"\\nSee also: config:set-compaction-limit\").body?.respawn===\"queued\");\ncheck(\"labelled full JSON line stream\",receipt('release: {\"released\":true}\\ncompaction: '+JSON.stringify({content:[{type:\"text\",text:toon}]})).body?.respawn===\"queued\");\ncheck(\"nested full text blocks\",receipt(JSON.stringify({content:[{type:\"text\",text:toon},{type:\"text\",text:\"See also: config:set-compaction-limit\"}]})).body?.respawn===\"queued\");\ncheck(\"duplicate JSON stream bodies rejected\",receipt(json+\"\\n\"+json).error===\"multiple-compaction-bodies\");\ncheck(\"duplicate labelled bodies rejected\",receipt(\"compaction: \"+json+\"\\ncompaction: \"+json).error===\"multiple-compaction-bodies\");\ncheck(\"non-reference TOON trailer rejected\",!receipt(toon+\"\\nSee also: config\\nunexpected line\").body);\ncheck(\"partial JSON rejected\",!receipt(json.slice(0,-1)).body);\nconst t={ledger:{id:\"control\",args_json:a,coord_owner_id:\"owner\",invoked_at:\"2026-10-09T20:00:01.000Z\",duration_ms:500,status:\"ok\"},source:{owner:\"owner\",source_candidates:[{session_id:\"native\",part_idx:1,tool_name:\"exec\",text:direct,ts:\"2026-10-09T20:00:00.000Z\",following_parts:[{part_idx:2,part_kind:\"tool_result\",text:json,ts:\"2026-10-09T20:00:02.000Z\"}]}]},lineage:[]};\ncheck(\"complete integrated native pair\",assess(t).completeOriginalPair);\nconst clone=()=>JSON.parse(JSON.stringify(t));\nlet neg=clone();neg.source.owner=\"foreign\";check(\"foreign owner rejected\",!assess(neg).completeOriginalPair);\nneg=clone();neg.source.source_candidates[0].text+=\"\\n// … [truncated 20 chars]\";check(\"clipped original call rejected\",!assess(neg).completeOriginalPair);\nneg=clone();neg.source.source_candidates[0].following_parts[0].text+=\"\\n… [truncated 20 chars]\";check(\"clipped response rejected\",!assess(neg).completeOriginalPair);\nneg=clone();neg.source.source_candidates[0].ts=\"2026-10-09T20:00:05.000Z\";check(\"outside dispatch timestamp rejected\",!assess(neg).completeOriginalPair);\nneg=clone();neg.ledger.status=\"refused\";check(\"ledger status disagreement rejected\",!assess(neg).completeOriginalPair);\nneg=clone();neg.source.source_candidates.push(JSON.parse(JSON.stringify(neg.source.source_candidates[0])));check(\"two native pairs ambiguous\",!assess(neg).completeOriginalPair);\nconsole.log(JSON.stringify({tests,passed:tests.filter(x=>x.passed).length,failed:tests.filter(x=>!x.passed).length}));\n",
  "validation": {
    "tests": [
      {
        "name": "direct literal",
        "passed": true
      },
      {
        "name": "constant tools index",
        "passed": true
      },
      {
        "name": "constant function alias",
        "passed": true
      },
      {
        "name": "conditional alternatives exactly one executable path",
        "passed": true
      },
      {
        "name": "two sequential calls rejected",
        "passed": true
      },
      {
        "name": "wrong literal focus rejected",
        "passed": true
      },
      {
        "name": "dynamic index rejected",
        "passed": true
      },
      {
        "name": "reassigned key rejected",
        "passed": true
      },
      {
        "name": "mutated args rejected",
        "passed": true
      },
      {
        "name": "mutated fn rejected",
        "passed": true
      },
      {
        "name": "uninvoked function body rejected",
        "passed": true
      },
      {
        "name": "shadowed tools index rejected",
        "passed": true
      },
      {
        "name": "malformed AST rejected",
        "passed": true
      },
      {
        "name": "direct JSON body",
        "passed": true
      },
      {
        "name": "direct TOON body",
        "passed": true
      },
      {
        "name": "COMPACTION TOON label",
        "passed": true
      },
      {
        "name": "TOON See also trailer",
        "passed": true
      },
      {
        "name": "labelled full JSON line stream",
        "passed": true
      },
      {
        "name": "nested full text blocks",
        "passed": true
      },
      {
        "name": "duplicate JSON stream bodies rejected",
        "passed": true
      },
      {
        "name": "duplicate labelled bodies rejected",
        "passed": true
      },
      {
        "name": "non-reference TOON trailer rejected",
        "passed": true
      },
      {
        "name": "partial JSON rejected",
        "passed": true
      },
      {
        "name": "complete integrated native pair",
        "passed": true
      },
      {
        "name": "foreign owner rejected",
        "passed": true
      },
      {
        "name": "clipped original call rejected",
        "passed": true
      },
      {
        "name": "clipped response rejected",
        "passed": true
      },
      {
        "name": "outside dispatch timestamp rejected",
        "passed": true
      },
      {
        "name": "ledger status disagreement rejected",
        "passed": true
      },
      {
        "name": "two native pairs ambiguous",
        "passed": true
      }
    ],
    "passed": 30,
    "failed": 0
  },
  "execution": {
    "exitCode": 0,
    "stdout": "{\"tests\":[{\"name\":\"direct literal\",\"passed\":true},{\"name\":\"constant tools index\",\"passed\":true},{\"name\":\"constant function alias\",\"passed\":true},{\"name\":\"conditional alternatives exactly one executable path\",\"passed\":true},{\"name\":\"two sequential calls rejected\",\"passed\":true},{\"name\":\"wrong literal focus rejected\",\"passed\":true},{\"name\":\"dynamic index rejected\",\"passed\":true},{\"name\":\"reassigned key rejected\",\"passed\":true},{\"name\":\"mutated args rejected\",\"passed\":true},{\"name\":\"mutated fn rejected\",\"passed\":true},{\"name\":\"uninvoked function body rejected\",\"passed\":true},{\"name\":\"shadowed tools index rejected\",\"passed\":true},{\"name\":\"malformed AST rejected\",\"passed\":true},{\"name\":\"direct JSON body\",\"passed\":true},{\"name\":\"direct TOON body\",\"passed\":true},{\"name\":\"COMPACTION TOON label\",\"passed\":true},{\"name\":\"TOON See also trailer\",\"passed\":true},{\"name\":\"labelled full JSON line stream\",\"passed\":true},{\"name\":\"nested full text blocks\",\"passed\":true},{\"name\":\"duplicate JSON stream bodies rejected\",\"passed\":true},{\"name\":\"duplicate labelled bodies rejected\",\"passed\":true},{\"name\":\"non-reference TOON trailer rejected\",\"passed\":true},{\"name\":\"partial JSON rejected\",\"passed\":true},{\"name\":\"complete integrated native pair\",\"passed\":true},{\"name\":\"foreign owner rejected\",\"passed\":true},{\"name\":\"clipped original call rejected\",\"passed\":true},{\"name\":\"clipped response rejected\",\"passed\":true},{\"name\":\"outside dispatch timestamp rejected\",\"passed\":true},{\"name\":\"ledger status disagreement rejected\",\"passed\":true},{\"name\":\"two native pairs ambiguous\",\"passed\":true}],\"passed\":30,\"failed\":0}\n",
    "stderr": ""
  },
  "limits": [
    "Only remaining59 source recovery; prior78 immutable.",
    "Exact original source/owner/args/session/timestamps/status remain required.",
    "No product-test reruns/outcome joins/continuity or eligibility acceptance."
  ]
}
