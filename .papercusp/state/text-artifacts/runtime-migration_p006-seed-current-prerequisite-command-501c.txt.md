---
rel_path: "runtime-migration/p006-seed-current-prerequisite-command-501c.txt"
updated_at: 1792824259113
_body: "content"
---

set -euo pipefail
PC_HEAVY_TIMEOUT_SEC=1800 bash scripts/pc-heavy.sh node --import tsx --input-type=module <<'JS'
import { prepareVerifierSource, prepareVerifierDependencies } from './scripts/source-preview.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
const repo=process.cwd();
const ref='92746d8842fef1f4210f197da7ae8ac0c3a90cba';
const dest='/mnt/data/tmp/bun-p006-seed-92746d88-501c';
const receiptPath='/tmp/bun-p006-seed-92746d88-source-501c.json';
const proofPath='/tmp/bun-p006-seed-92746d88-execution-501c.json';
const inputs=['packages/operator-core/lib/sync/hyperbee/read-merge.ts','packages/operator-core/lib/sync/hyperbee/log-snapshot.ts','packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts','apps/operator/lib/release/cut-seed-cli.ts','packages/operator-core/lib/sync/hyperbee/seed-frozen-execution.ts','packages/operator-core/lib/dependency-generation-proof.ts','packages/operator-core/lib/sync/hyperbee/hive-epoch-aead.ts','apps/operator/bin/release/dependency-generation.sh','scripts/check-lockfile-census.mjs','packages/operator-core/lib/sync/hyperbee/seed-module-census.mjs'];
const phase=async(name,fn)=>{console.log('P006_SEED_PHASE_BEGIN '+name);const r=await fn();console.log('P006_SEED_PHASE_PASS '+name);return r;};
const receipt=await phase('source.freeze',()=>prepareVerifierSource({repo,ref,dest,inputs,gitCheckout:true}));
await fs.writeFile(receiptPath,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
const dependencies=await prepareVerifierDependencies({donor:repo,dest,receipt,runPhase:phase});
await fs.writeFile(receiptPath+'.dependencies.json',JSON.stringify(dependencies)+'\n',{flag:'wx',mode:0o600});
const generationRoot=execFileSync('bash',['-euo','pipefail','-c','source "$1"; dependency_generation_resolve_root "$2" "" 1','seed-root',join(repo,'apps/operator/bin/release/dependency-generation.sh'),repo],{encoding:'utf8',env:{...process.env,NODE_OPTIONS:'',NODE_PATH:''}}).trim();
console.log('P006_SEED_PHASE_BEGIN frozen.execution');
const code="const {readSeedFrozenExecution}=await import('./packages/operator-core/lib/sync/hyperbee/seed-provider-corestore.ts');const {writeFile}=await import('node:fs/promises');const p=await readSeedFrozenExecution();await writeFile(process.env.P006_SEED_EXECUTION_PROOF,JSON.stringify(p)+'\\n',{flag:'wx',mode:0o600});console.log('P006_SEED_FROZEN_EXECUTION_PASS '+JSON.stringify({sourceCommit:p.sourceCommit,gitDirty:p.gitDirty,nodeVersion:p.nodeVersion,dependencyGeneration:p.dependencyGeneration,securityPackages:p.securityPackages.map(x=>x.name),proof:process.env.P006_SEED_EXECUTION_PROOF}));";
const child=spawnSync(process.execPath,['--import','./packages/operator-core/lib/sync/hyperbee/seed-module-census.mjs','--import','tsx','--input-type=module','-e',code],{cwd:dest,env:{...process.env,NODE_OPTIONS:'',NODE_PATH:'',PAPERCUSP_DEPENDENCY_GENERATION_ROOT:generationRoot,P006_SEED_EXECUTION_PROOF:proofPath},stdio:'inherit'});
if(child.error)throw child.error;if(child.status!==0)process.exit(child.status??1);
console.log('P006_SEED_CURRENT_PREREQUISITE_PASS');
JS
