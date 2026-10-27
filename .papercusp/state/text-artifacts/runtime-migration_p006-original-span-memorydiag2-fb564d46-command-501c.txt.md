---
rel_path: "runtime-migration/p006-original-span-memorydiag2-fb564d46-command-501c.txt"
updated_at: 1792858513047
_body: "content"
---

set -euo pipefail
umask 077
cd /mnt/data/tmp/bun-p006-seed-fb564d46-a1203980-501c
export NODE_OPTIONS='' NODE_PATH='' BUN_OPTIONS=''
export PAPERCUSP_DEPENDENCY_GENERATION_ROOT=/mnt/data/papercusp-dependency-generations
export PAPERCUSP_WORKSPACE_ROOT=/mnt/data/tmp/bun-p006-seed-fb564d46-a1203980-501c
node --expose-gc --import ./packages/operator-core/lib/sync/hyperbee/seed-module-census.mjs --import tsx --input-type=module <<'JS'
import {register} from 'node:module';
const resolver=`export async function resolve(specifier, context, nextResolve) {
 const resolved = await nextResolve(specifier, context);
 if (resolved.url.startsWith('file:') && /\\.tsx?$/.test(new URL(resolved.url).pathname) && !resolved.url.includes('/node_modules/')) return {...resolved,format:'module-typescript'};
 return resolved;
}`;
register('data:text/javascript,'+encodeURIComponent(resolver),import.meta.url);
import * as fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const root=process.cwd(), commit='fb564d469b6f6a54ce2ab546befd8176adf4fa55';
const outputDir='/mnt/data/tmp/bun-p006-original-span-fb564d46-a1203980-esm1-501c';
const storeDir='/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/papercusp/hyperbee';
const epochKeysPath='/home/marsh-office/papercupai-workspace/papercusp/papercusp-desktop/src-tauri/seed/epoch-keys.json';
const epochKeysSha256='640fcaa2e99d37c7166c0fe7fc8800967c3b2f3de5b138fa7552052675751678';
const hash=b=>createHash('sha256').update(b).digest('hex');
const assert=(v,m)=>{if(!v)throw Error(m)};
let stage='preflight',created=false;
try {
 assert(await fs.realpath(root)===root,'frozen root alias');
 assert(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()===commit,'frozen commit drift');
 assert(!execFileSync('git',['status','--porcelain','--untracked-files=all','--ignore-submodules=none'],{encoding:'utf8'}).trim(),'frozen source dirty');
 const rawRefs=[['/tmp/bun-p006-seed-fb564d46-a1203980-source-501c.json','9fed91b8e248a92ce6a06e72e342c51751c40ae1d4e49785bbf71fd818353856'],['/tmp/bun-p006-seed-fb564d46-a1203980-source-501c.json.dependencies.json','19982f8ae59486e7ab64a5d43ef9463dd6e86a829c0dd0db7cdb304549fed556'],['/tmp/bun-p006-seed-fb564d46-a1203980-execution-501c.json','0f347cf0c1022d9f92a6a7a2659873261681af9a82df64823712d1602ed2ade0']];
 for(const [path,digest] of rawRefs)assert(hash(await fs.readFile(path))===digest,'prerequisite receipt drift');
 const baseline=JSON.parse(await fs.readFile(rawRefs[2][0],'utf8'));
 assert(baseline.sourceCommit===commit && baseline.gitDirty===false,'baseline commit invalid');
 for(const file of baseline.directBlobs)assert(hash(await fs.readFile(join(root,file.path)))===file.sha256,'frozen execution blob drift');
 assert((await fs.lstat(storeDir)).isDirectory() && await fs.realpath(storeDir)===storeDir,'source directory alias');

 const receiptPath='/tmp/bun-p006-original-span-memorydiag2-fb564d46-501c.json';
 const receiptFile=await fs.open(receiptPath,'wx',0o600);
 const {default:Corestore}=await import('corestore');
 const {enumerateOwnStoreCoreKeys}=await import('./packages/operator-core/lib/sync/hyperbee/seed-cutter.ts');
 const {signedSeedSource,SEED_EXCLUDED_TABLES,seedSnapshotValueTransform}=await import('./packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts');
 const {foldFilteredSnapshotRows}=await import('./packages/operator-core/lib/sync/hyperbee/log-snapshot.ts');
 const {releaseSeedRedactionValues}=await import('./apps/operator/lib/release/seed-identity-guard.ts');
 const samples=[], started=Date.now();
 let reads=0,totalBytes=0,maxBlockBytes=0,maxHeap=0,stopped=false,reason=null,store;
 const sample=(event,extra={})=>{
   global.gc?.();
   const m=process.memoryUsage(); maxHeap=Math.max(maxHeap,m.heapUsed);
   const s={event,stage,reads,totalBytes,maxBlockBytes,heapUsed:m.heapUsed,rss:m.rss,external:m.external,elapsedMs:Date.now()-started,...extra};
   samples.push(s); console.log('P006_MEMORY_DIAG '+JSON.stringify(s));
   if(m.heapUsed>1800*1024*1024||reads>2000000||Date.now()-started>8*60*1000){stopped=true;reason='bounded-diagnostic-stop';}
   return s;
 };
 const guard=()=>{if(stopped)throw Error('bounded-diagnostic-stop');};
 try{
   stage='store-open';sample('begin');
   store=new Corestore(storeDir,{readOnly:true,wait:false});await store.ready();
   const keys=await enumerateOwnStoreCoreKeys(store);assert(keys.length===1,'source selection incomplete');
   const core=store.get({key:Buffer.from(keys[0],'hex'),valueEncoding:'json'});await core.ready();
   assert(Number.isSafeInteger(core.length)&&core.length>0,'source head missing');
   const length=core.length;
   const nativeProof=core.proof.bind(core);
   core.proof=async options=>{
     guard(); const proof=await nativeProof(options);reads++;
     const n=proof.block?.value?.byteLength??0;totalBytes+=n;maxBlockBytes=Math.max(maxBlockBytes,n);
     if(reads%1024===0||n>16*1024*1024)sample('proof-read');
     guard();return proof;
   };
   stage='signed-snapshot-discovery';sample('phase-begin',{sourceLength:length});
   const source=await signedSeedSource(core,keys[0],length);
   sample('phase-end',{hint:source.hint});guard();
   const options={now:Date.now(),excludeTables:SEED_EXCLUDED_TABLES,priorSnapshotHint:source.hint,requireComplete:true,
     onSourceBlock:()=>{guard();},
     onProgress:p=>{sample('fold-progress',{processed:p.processed,total:p.total,keyCount:p.keyCount});guard();}};
   stage='original-fold';sample('phase-begin');
   const original=await foldFilteredSnapshotRows(source.log,options);
   sample('phase-end',{rowCount:original.rows.length,seedIndex:original.seedIndex,chunkCount:original.chunkCount});guard();
   stage='projected-fold';sample('phase-begin');
   const projected=await foldFilteredSnapshotRows(source.log,{...options,transformValue:seedSnapshotValueTransform(releaseSeedRedactionValues(root)).transform});
   sample('phase-end',{rowCount:projected.rows.length,originalRows:original.rows.length});guard();
   source.assertHead();
   stage='complete';sample('complete');
 }catch(e){reason=stopped?'bounded-diagnostic-stop':'diagnostic-error';sample('stopped',{errorSha256:hash(Buffer.from(String(e?.message??e)))});}
 finally{
   if(store)await store.close();
   const receipt={schema:'papercusp-p006-original-span-memory-diagnostic-v1',commit,sourceMutated:false,custodyAccepted:false,stopped,reason,samples,maxHeap};
   await receiptFile.writeFile(JSON.stringify(receipt));await receiptFile.close();
   console.log('P006_MEMORY_DIAG_RECEIPT '+JSON.stringify({path:receiptPath,sha256:hash(await fs.readFile(receiptPath)),stopped,reason,samples:samples.length,maxHeap}));
 }
}catch(e){console.log('P006_MEMORY_DIAG_PREFLIGHT_FAILURE '+JSON.stringify({errorSha256:hash(Buffer.from(String(e?.message??e)))}));process.exitCode=1;}
JS

