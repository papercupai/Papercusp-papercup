---
rel_path: "audits/parked-agent-resumption-2026-10-17-637d7/current-build-paging-driver-v3.mjs"
updated_at: 1792314341055
_body: "content"
---

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const client='su-637d70bf-567e-4ee9-ab87-88d69ca99dc9';
const common=['--port','3170','--client',client,'--workspace','papercusp-workspace','--harness','*','--json','-'];
function call(tool,args){
  const extra=tool==='code:run'?['--raw']:[];
  const r=spawnSync('node',['scripts/mcp-call.mjs',tool,...common,...extra],{input:JSON.stringify(args),encoding:'utf8',maxBuffer:50*1024*1024});
  let j=null;
  try {
   const raw=r.stdout||'';
   const candidate=tool==='code:run' ? raw.split(/\n/).filter(x=>x.startsWith('data: ')).at(-1)?.slice(6) : raw;
   if(tool==='code:run'&&!candidate) throw new Error('missing SSE result');
   j=JSON.parse(candidate||'{}');
   if(tool==='code:run' && j.result?.content){
    const jsonBlock=j.result.content.find(c=>c.type==='text'&&c.text?.trim().startsWith('{'));
    if(!jsonBlock) throw new Error('no JSON content');
    j=JSON.parse(jsonBlock.text);
   }
  } catch(e){throw new Error('non-json '+tool+' status '+r.status+' detail '+e.message+' stdout '+(r.stdout||'').slice(0,1800)+' stderr '+(r.stderr||'').slice(-500));}
  if(tool==='code:run' && j.schemaVersion==='papercusp.output-envelope/v1') {
   const uri=j.content?.[0]?.uri;
   if(!uri) throw new Error('missing envelope uri');
   const recovered=call('capability:read',{uri,content_indexes:[1]});
   if(recovered.status!==0) throw new Error('envelope recovery refused '+JSON.stringify(recovered.json));
   const block=recovered.json.content?.find(c=>c.type==='text'&&c.text?.trim().startsWith('{'));
   if(!block) throw new Error('no recovered JSON');
   j=JSON.parse(block.text);
  }
  return {status:r.status,json:j,stderr:r.stderr||''};
}
const artPath='audits/parked-agent-resumption-2026-10-17-637d7/current-build-paging-runner-v2.json';
const ar=call('artifacts:load',{slug:'papercusp',rel_path:artPath});
if(ar.status!==0||!ar.json.results?.[0]?.found) throw new Error('runner load failed '+JSON.stringify(ar.json));
const runner=JSON.parse(ar.json.results[0].content);
const readScript=runner.readScript.replaceAll('pageSize:1','pageSize:10').replace('d.pages<6','d.pages<20').replace('Date.now()-start<12000','Date.now()-start<20000');
const persistScript=runner.persistScript;
function current(){
 const x=call('code:run',{script:"const a=await tools.artifacts.load({slug:'papercusp',rel_path:'audits/parked-agent-resumption-2026-10-17-637d7/current-build-paging-45250822.json'});const s=JSON.parse(a.results[0].content);return {recordsRead:s.recordsRead,pages:s.pages,owners:s.owners.length,complete:s.complete,coverage:s.coverage};",timeoutSec:45,projection:{pick:['ok','summary','partial','childFailures']}});
 if(x.status!==0||!x.json.ok) throw new Error('state load failed '+JSON.stringify(x.json));
 return x.json.summary;
}
function exactSummary(j){
 if(!j.summaryNotice?.truncated) return j.summary;
 const c=j.summaryNotice.rawSummaryCursor;
 if(!c?.args) throw new Error('summary clipped without raw cursor '+JSON.stringify(j));
 let args={...c.args,byte_limit:2048}, chunks=[];
 for(let n=0;n<100;n++){
  let r;
  for (let attempt=0; attempt<4; attempt++) {
   r=call('capability:read',args);
   if (r.status===0 && r.json && r.json.ok!==false) break;
   if (attempt===3) throw new Error('cursor read failed status='+r.status+' stderr='+r.stderr.slice(-800)+' json='+JSON.stringify(r.json));
  }
  const b=Buffer.from(r.json.data,'base64');
  if(b.length!==r.json.byte_length || b.toString('base64')!==r.json.data) throw new Error('noncanonical byte page');
  chunks.push(b);
  if(r.json.eof===true&&r.json.next_cursor===null){
   const bytes=Buffer.concat(chunks);
   if(bytes.length!==c.byteCount||createHash('sha256').update(bytes).digest('hex')!==c.sha256) throw new Error('raw summary digest mismatch');
   return JSON.parse(bytes.toString('utf8'));
  }
  if(!r.json.next_cursor?.args) throw new Error('cursor did not advance');
  args={...r.json.next_cursor.args,byte_limit:2048};
 }
 throw new Error('raw summary cursor budget exceeded');
}
let start=current(); console.log(JSON.stringify({start}));
for(let i=0;i<Number(process.env.MAX_BATCH||1250) && !start.complete;i++){
 const rr=call('code:run',{script:readScript,timeoutSec:45,projection:{pick:['ok','summary','summaryNotice','error','partial','childFailures']}});
 if((rr.status!==0 && rr.status!==6) || rr.json.ok===false) throw new Error('read batch '+(i+1)+' failed status='+rr.status+' stderr='+rr.stderr.slice(-1000)+' json='+JSON.stringify(rr.json));
 const d=exactSummary(rr.json);
 if(!d || typeof d.recordsRead!=='number') throw new Error('read batch missing delta '+JSON.stringify(rr.json));
 const payload={script:'const d='+JSON.stringify(d)+';'+persistScript,timeoutSec:45,projection:{pick:['ok','summary','error','partial','childFailures']}};
 const pr=call('code:run',payload);
 let after=current();
 if(pr.status!==0 || pr.json.ok===false){
   console.log(JSON.stringify({batch:i+1,read:{base:d.baseRecordsRead,records:d.recordsRead,pages:d.pages,ids:d.ids.length},persistStatus:pr.status,persist:pr.json,after}));
   if(after.recordsRead < d.recordsRead) throw new Error('persistence did not land; stopped before retry');
 } else {
   console.log(JSON.stringify({batch:i+1,read:{base:d.baseRecordsRead,records:d.recordsRead,pages:d.pages,ids:d.ids.length},after}));
 }
 start=after;
}
console.log(JSON.stringify({final:start}));

