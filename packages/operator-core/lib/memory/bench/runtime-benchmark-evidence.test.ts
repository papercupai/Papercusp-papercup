import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { declareBm25Attempts, reconcileBm25Attempts, type Bm25AttemptReceipt, type PairResult } from '../../search/bench/bm25-hybrid-recall';
import { benchmarkRuntimeArguments, readBenchmarkRuntimeEvidence } from './runtime-benchmark-evidence';

describe('real benchmark runtime evidence boundary',()=>{
  it('passes ordinary benchmark options through and refuses preparation/replay/missing output',()=>{
    expect(benchmarkRuntimeArguments(['--benchmark','--','--out','new.json','--inputs-from','frozen.json']))
      .toEqual(['--out','new.json','--inputs-from','frozen.json']);
    for(const tail of [[],['--prepare-only'],['--replay-from','old.json'],['--out','duplicate.json']])
      expect(()=>benchmarkRuntimeArguments(['--benchmark',...(tail.length?['--','--out','new.json',...tail]:[])] )).toThrow();
  });
  it.each(['valid','interleaved','missing','unknown','duplicate','moved-ledger','wrong-profile','invalid','failed-budget',
    'unstarted','duplicate-start','duplicate-settlement','undeclared-start','unknown-event','unsettled','bad-time','eventless'])(
    'keeps adapter execution distinct from acceptance: %s',variant=>{
      const root=fs.mkdtempSync(path.join(os.tmpdir(),'benchmark-runtime-'));
      try {
        const output=path.join(root,'new.json');
        const pair=(id:string):PairResult=>({source:'work_item',targetId:id,style:'fragment',query:'query '+id,arms:{}});
        const declaration=declareBm25Attempts({declaredAt:new Date().toISOString(),sources:['work_item'],pairsPerSource:1,
          paired:[pair('p')],warmup:[pair('w')],steady:[pair('s')],pins:{source:'s',corpus:null,queries:'q',configuration:'c'}});
        const receipts:Bm25AttemptReceipt[]=declaration.attempts.map(a=>({id:a.id,outcome:'success',executed:true,
          latencyMs:1,costUsd:null,observation:{hits:1,rank:1,latencyMs:1,engine:a.arm}}));
        const ledger=reconcileBm25Attempts(declaration,receipts);
        const artifact={kind:'bm25-hybrid-recall',verdict:variant==='invalid'?'invalid':variant==='failed-budget'?'fail':'pass',
          latencyVerdict:'pass',queryEmbeddingProfile:{mode:variant==='wrong-profile'?'local':'gemma',profileId:'gemma-embeddinggemma-300m-768@v1'},
          population:{declaration,ledger}};
        fs.writeFileSync(output,JSON.stringify(artifact));
        fs.writeFileSync(output+'.declaration.json',JSON.stringify(declaration));
        if(variant==='missing') receipts.pop();
        if(variant==='unknown') receipts[0].outcome='unknown';
        if(variant==='duplicate') receipts.push(receipts[0]);
        // trackedMeasure writes both lifecycle events; only settlements are receipts.
        const journal: Array<Record<string, unknown>> = receipts.flatMap(receipt => [
          {id:receipt.id,event:'started',at:'2026-10-25T00:00:00.000Z'},
          {...receipt,event:'settled',at:'2026-10-25T00:00:00.001Z'},
        ]);
        if(variant==='interleaved') journal.sort((a,b)=>Number(a.event==='settled')-Number(b.event==='settled'));
        if(variant==='unstarted') journal.shift();
        if(variant==='duplicate-start') journal.splice(1,0,journal[0]);
        if(variant==='duplicate-settlement') journal.push(journal[1]);
        if(variant==='undeclared-start') journal.push({id:'undeclared',event:'started',at:'2026-10-25T00:00:00.000Z'});
        if(variant==='unknown-event') journal[0].event='unknown';
        if(variant==='unsettled') journal.pop();
        if(variant==='bad-time') journal[0].at='invalid';
        if(variant==='eventless') delete journal[1].event;
        fs.writeFileSync(output+'.attempts.jsonl',journal.map(row=>JSON.stringify(row)).join('\n'));
        fs.writeFileSync(output+'.ledger.json',JSON.stringify(variant==='moved-ledger'?{}:ledger));
        const read=()=>readBenchmarkRuntimeEvidence(['--out',output],variant==='failed-budget'?1:0);
        if(['valid','interleaved','failed-budget'].includes(variant)) expect(read()).toMatchObject({searchAdapterExercised:true,
          baselineAccepted:false,latencyAcceptance:false,executed:6});
        else expect(read).toThrow();
      } finally { fs.rmSync(root,{recursive:true,force:true}); }
    });
});
