---
rel_path: "runtime-migration/p006-original-span-04d16736-20261025-command-501c.txt"
updated_at: 1792966828668
_body: "content"
---

set -euo pipefail
umask 077
cd /mnt/data/tmp/bun-p006-seed-04d16736-20261025-501c
export NODE_OPTIONS='' NODE_PATH='' BUN_OPTIONS=''
export PAPERCUSP_DEPENDENCY_GENERATION_ROOT=/mnt/data/papercusp-dependency-generations
export PAPERCUSP_WORKSPACE_ROOT=/mnt/data/tmp/bun-p006-seed-04d16736-20261025-501c
PC_HEAVY_TIMEOUT_SEC=2400 bash /home/marsh-office/papercupai-workspace/papercusp/scripts/pc-heavy.sh node --import ./packages/operator-core/lib/sync/hyperbee/seed-module-census.mjs --import tsx --input-type=module <<'JS'
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
const root=process.cwd(), commit='04d1673643f0b05554e6cf63cb8b4b75bf3efbd5';
const outputDir='/mnt/data/tmp/bun-p006-original-span-04d16736-20261025-501c';
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
 const rawRefs=[['/tmp/bun-p006-seed-04d16736-20261025-source-501c.json','e8338ec08732f01648fbb71124f91f6f3d4474a804559a8f6065977cf91b9f50'],['/tmp/bun-p006-seed-04d16736-20261025-source-501c.json.dependencies.json','9a2b45b67f636aa3eceb0ce388b747417fb3304da43a01e4638395e91b792183'],['/tmp/bun-p006-seed-04d16736-20261025-execution-501c.json','6313fac9126da3ceeb3d5831a3ccb2fd3377fae4222daadac3357de34b687c51']];
 for(const [path,digest] of rawRefs)assert(hash(await fs.readFile(path))===digest,'prerequisite receipt drift');
 const baseline=JSON.parse(await fs.readFile(rawRefs[2][0],'utf8'));
 assert(baseline.sourceCommit===commit && baseline.gitDirty===false,'baseline commit invalid');
 for(const file of baseline.directBlobs)assert(hash(await fs.readFile(join(root,file.path)))===file.sha256,'frozen execution blob drift');
 assert((await fs.lstat(storeDir)).isDirectory() && await fs.realpath(storeDir)===storeDir,'source directory alias');
 const keysStat=await fs.lstat(epochKeysPath);assert(keysStat.isFile() && !keysStat.isSymbolicLink(),'key file alias');
 const keyBytes=await fs.readFile(epochKeysPath);assert(hash(keyBytes)===epochKeysSha256,'key custody drift');
 let keyShape;try{keyShape=JSON.parse(keyBytes.toString('utf8'));}catch{throw Error('key file invalid JSON')}
 assert(keyShape && typeof keyShape==='object' && !Array.isArray(keyShape),'key file shape invalid');
 await fs.mkdir(outputDir,{mode:0o700});created=true;
 assert(await fs.realpath(outputDir)===resolve(outputDir),'output alias');
 const {exportSeedUuidIdempotencyCensus}=await import('./apps/operator/lib/release/cut-seed-cli.ts');
 const {releaseSeedRedactionValues}=await import('./apps/operator/lib/release/seed-identity-guard.ts');
 const redactValues=releaseSeedRedactionValues(root);
 console.log('P006_ORIGINAL_SIGNED_SPAN_BEGIN');stage='maintained-original-span-export';
 const configPath=await exportSeedUuidIdempotencyCensus({storeDir,potId:'papercusp',epochKeysPath,epochKeysSha256,outputDir,redactValues,captureOriginalSpan:true});
 stage='verify-export-receipts';
 const configBytes=await fs.readFile(configPath), config=JSON.parse(configBytes.toString('utf8'));
 assert(config.originalSpanReplicaDir===join(outputDir,'original-signed-span'),'replica path missing');
 assert(config.epochKeysPath===epochKeysPath && config.epochKeysSha256===epochKeysSha256 && config.potId==='papercusp','key/pot config drift');
 assert(config.sources.length===1,'source population invalid');
 const manifestBytes=await fs.readFile(config.sourceManifestPath),manifest=JSON.parse(manifestBytes.toString('utf8'));
 assert(hash(manifestBytes)===config.sourceManifestSha256 && manifest.schema==='papercusp-original-signed-source-span-v1' && manifest.sourceSelection==='enumerateOwnStoreCoreKeys','manifest binding invalid');
 const source=config.sources[0], binding=source.sourceInput.executionBinding;
 for(const name of ['sourceCommit','gitDirty','nodeVersion','dependencyInputSha256','installedPackagesSha256','dependencyGeneration','dependencyGenerationSnapshotSha256','materializedTreesSha256','directBlobs','securityPackages','excludedEntries','excludedEntryCount'])assert(JSON.stringify(binding[name])===JSON.stringify(baseline[name]),'baseline identity mismatch:'+name);
 assert(source.sourceBlocksRead===source.sourceLength-source.sourceInput.seedIndex && source.sourceInput.proofInventorySha256,'source span incomplete');
 const meta=manifest.stores[0].meta;
 assert(meta.coreKeys.length===1 && meta.coreKeys[0]===source.sourceKeyHex && meta.coreLengths[source.sourceKeyHex]===source.sourceLength && JSON.stringify(meta.sourceHeads[source.sourceKeyHex])===JSON.stringify(source.sourceInput.sourceHead),'manifest head/span mismatch');
 const rowBytes=await fs.readFile(source.rowsPath);assert(hash(rowBytes)===source.rowsSha256,'row export drift');
 assert((await fs.stat(outputDir)).mode%512===448 && ((await fs.stat(configPath)).mode&0o777)===0o600 && ((await fs.stat(config.sourceManifestPath)).mode&0o777)===0o600,'private mode invalid');
 assert(hash(await fs.readFile(epochKeysPath))===epochKeysSha256,'key changed during capture');
 const receipt={schema:'p006-original-signed-span-custody-v1',sourceCommit:commit,root,outputDir,sourceStoreDir:storeDir,configPath,configSha256:hash(configBytes),manifestPath:config.sourceManifestPath,manifestSha256:hash(manifestBytes),rowsPath:source.rowsPath,rowsSha256:source.rowsSha256,rowCount:source.rowCount,sourceLength:source.sourceLength,sourceInput:source.sourceInput,privacyProjectionContext:source.privacyProjectionContext,epochKeysPath,epochKeysSha256,replicaDir:config.originalSpanReplicaDir,prerequisiteReceipts:rawRefs,limits:['independent original-envelope authentication pending','current source epoch-key coverage pending','final candidate and platform acceptance pending']};
 const receiptPath=join(outputDir,'p006-custody.private.json');await fs.writeFile(receiptPath,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
 console.log('P006_ORIGINAL_SIGNED_SPAN_CUSTODY_PASS '+JSON.stringify({receiptPath,sourceLength:source.sourceLength,sourceBlocksRead:source.sourceBlocksRead,rowCount:source.rowCount,coverage:source.sourceInput.coverage}));
} catch(error) {
 if(created)await fs.writeFile(join(outputDir,'failure.private.json'),JSON.stringify({stage,name:error?.name,message:error?.message,stack:error?.stack})+'\n',{flag:'wx',mode:0o600});
 console.error('P006_ORIGINAL_SIGNED_SPAN_FAILED '+JSON.stringify({stage,errorName:error?.name,privateFailure:created?join(outputDir,'failure.private.json'):null}));
 process.exitCode=1;
}
JS
