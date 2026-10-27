/** Fresh, local-only Gemma runtime qualification. Instrumentation pauses scripts
 * and samples native libraries, so its timings cannot discharge latency budgets.
 * Usage: node --import tsx runtime-qualification-cli.ts --output NEW_PREFIX
 *   --assets PRESERVED_ASSET_RECEIPT --configuration PRESERVED_MODEL_RECEIPT
 * Add --benchmark -- --out NEW_BENCHMARK_JSON --inputs-from FROZEN_INPUTS ...
 * to exercise the real benchmark instead of the one-request SDK probe.
 * Run under the governed task/pc-heavy route; outputs are private/write-once.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRuntimeSourceCapture } from './runtime-source-capture.mjs';
import { bindRuntimeModelOpens, runtimeFileTraceArguments } from './runtime-file-opens.mjs';
import { bindNativeLoaderClosure, fingerprintFile, type NativeProfilerRequestWindow } from './measurement-manifest';
import { embedViaWorker, shutdownLocalEmbedder, getWorkerState, validNativeRuntimeSample, observeWorkerNativeInference,
  type WorkerNativeInferenceTrace } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { GEMMA_MODEL, gemmaPrompt, mrlTruncate } from '../../../../../libs/generic/memory/src/gemma-embedder';
import { benchmarkRuntimeArguments, readBenchmarkRuntimeEvidence } from './runtime-benchmark-evidence';

const digest = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
const benchmarkArgs = args.includes('--benchmark') ? benchmarkRuntimeArguments(args) : undefined;
function argument(name: string) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('missing ' + name);
  return path.resolve(args[index + 1]);
}
function write(file: string, value: unknown) {
  const bytes = JSON.stringify(value, null, 2) + '\n', fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (digest(fs.readFileSync(file)) !== digest(bytes)) throw new Error('runtime receipt readback differs');
}
async function child(output: string) {
  if (process.env.PAPERCUSP_EMBED_DEVICE !== 'cpu' || process.env.PAPERCUSP_TRANSFORMERS_LOCAL_ONLY !== '1')
    throw new Error('runtime qualification requires explicit CPU/local-only policy');
  const native: WorkerNativeInferenceTrace[] = [];
  const stopObserving = observeWorkerNativeInference(event => native.push(event));
  let vector: number[] = [], failure: string | undefined;
  let benchmark: ReturnType<typeof readBenchmarkRuntimeEvidence> | undefined;
  try {
    if (benchmarkArgs) {
      // Keep argv[1] on this driver: importing the benchmark must not trigger its
      // process.exit entrypoint before cleanup and terminal evidence are saved.
      const priorArgv = process.argv;
      try {
        process.argv = [...priorArgv.slice(0, 2), ...benchmarkArgs];
        const { runBm25HybridRecall } = await import('../../search/bench/bm25-hybrid-recall-cli');
        const exitCode = await runBm25HybridRecall();
        benchmark = readBenchmarkRuntimeEvidence(benchmarkArgs, exitCode);
      } finally { process.argv = priorArgv; }
    } else {
      vector = mrlTruncate(await embedViaWorker(gemmaPrompt('query', 'Verify a preserved local search embedding configuration.'),
        { model: GEMMA_MODEL, pooling:'mean', normalize:false }));
      if (vector.length !== 768 || vector.some(value => !Number.isFinite(value))
        || Math.abs(Math.hypot(...vector) - 1) > 1e-6) throw new Error('runtime vector invariant failed');
    }
    if (!native.length || native.some(event => !validNativeRuntimeSample(event))) throw new Error('native runtime samples invalid');
  } catch (error) { failure = String(error); process.exitCode = 1; }
  finally {
    stopObserving();
    await shutdownLocalEmbedder();
    const worker = getWorkerState();
    if (worker.alive || worker.pendingCount) { failure = 'worker cleanup incomplete'; process.exitCode = 1; }
    if (benchmarkArgs) {
      try {
        const { getOrgPg } = await import('@papercusp/db-org');
        await getOrgPg().sql.end({timeout:5});
      } catch (error) { failure = 'benchmark database cleanup: '+String(error); process.exitCode = 1; }
    }
    write(output, { processId: process.pid, native,
      ...(benchmark ? {benchmark} : {vector: {dimensions:vector.length,sha256:digest(JSON.stringify(vector))}}), worker, failure });
  }
}
async function parent() {
  process.umask(0o077);
  const prefix = argument('--output'), assetsPath = argument('--assets'), configPath = argument('--configuration');
  const outputs = Object.fromEntries(['report.json','sources.jsonl','native.json','file-opens.log','stderr.log','stdout.log']
    .map(suffix => [suffix, prefix + '.' + suffix]));
  for (const file of Object.values(outputs)) if (fs.existsSync(file)) throw new Error('runtime output already exists: ' + file);
  const configBytes = fs.readFileSync(configPath), config = JSON.parse(configBytes.toString());
  const assetsBytes = fs.readFileSync(assetsPath), assets = JSON.parse(assetsBytes.toString()).assets;
  if (config.configuration.profile.model !== GEMMA_MODEL || config.configuration.profile.targetDims !== 768
    || !Array.isArray(assets) || !assets.length) throw new Error('preserved Gemma identity invalid');
  const stamps = new Map<string,string>();
  const stamp = (file: string) => { const s=fs.statSync(file,{bigint:true}); return [s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join(':'); };
  for (const asset of assets) {
    const before = stamp(asset.path), actual = await fingerprintFile(asset.path);
    if (before !== stamp(asset.path) || actual.sha256 !== asset.sha256 || actual.bytes !== asset.bytes) throw new Error('preserved model asset moved: ' + asset.path);
    stamps.set(asset.path,before);
  }
  const outFd = fs.openSync(outputs['stdout.log'],'wx',0o600), errFd=fs.openSync(outputs['stderr.log'],'wx',0o600);
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_EMBED_DEVICE:'cpu', PAPERCUSP_TRANSFORMERS_LOCAL_ONLY:'1',
    PAPERCUSP_MEMORY_EMBEDDER:'gemma', PAPERCUSP_RUNTIME_SOURCE_CAPTURE:outputs['sources.jsonl'], LD_DEBUG:'files' };
  delete env.LD_DEBUG_OUTPUT;
  const stderr: Buffer[] = [];
  let eof = false;
  const result = await new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject) => {
    const processChild = spawn('/usr/bin/strace',runtimeFileTraceArguments(outputs['file-opens.log'],[
      process.execPath,'--import',fileURLToPath(new URL('./runtime-source-capture.mjs',import.meta.url)),
      '--import','tsx',fileURLToPath(import.meta.url),'--child',outputs['native.json'],
      ...(benchmarkArgs ? ['--benchmark','--',...benchmarkArgs] : [])]),{env,stdio:['ignore','pipe','pipe']});
    processChild.stdout.on('data',bytes => fs.writeSync(outFd,bytes));
    processChild.stderr.on('data',bytes => {stderr.push(bytes); fs.writeSync(errFd,bytes);});
    processChild.stderr.on('end',()=>{eof=true;});
    processChild.on('error',()=>resolve({code:null,signal:null}));
    processChild.on('close',(code,signal)=>resolve({code,signal}));
  }).finally(()=>{fs.fsyncSync(outFd);fs.fsyncSync(errFd);fs.closeSync(outFd);fs.closeSync(errFd);});
  const report: Record<string,unknown> = { schemaVersion:1,
    kind:benchmarkArgs ? 'shared-search-benchmark-runtime-qualification' : 'shared-search-runtime-only-qualification',
    workItemId:process.env.PAPERCUSP_WORK_ITEM_ID ?? 'WI-6554700010022135',
    configuration:{path:configPath,sha256:digest(configBytes)},assets:{path:assetsPath,sha256:digest(assetsBytes)},
    outputs,result,baselineRun:false,searchAdapterExercised:false,completeRuntimeClosureVerified:false,
    latencyAcceptance:false, instrumentation:'V8 debugger, strace file opens, native loader and worker diagnostics',
    excluded:['other processes not captured by the inspector','JIT machine-code bytes','untaken runtime paths','retrieval population and budgets'] };
  const check = (key: string, action: () => unknown) => {try {report[key]=action();}catch(error){report[key]={error:String(error)};process.exitCode=1;}};
  let runtime: {processId:number;native:WorkerNativeInferenceTrace[];failure?:string;
    benchmark?:ReturnType<typeof readBenchmarkRuntimeEvidence>} = {processId:0,native:[]};
  check('childReceipt',()=>{
    runtime=JSON.parse(fs.readFileSync(outputs['native.json'],'utf8'));
    if (!Number.isSafeInteger(runtime.processId) || runtime.processId<=0 || !Array.isArray(runtime.native) || runtime.failure)
      throw new Error(runtime.failure ?? 'invalid native child receipt');
    return {processId:runtime.processId};
  });
  if (benchmarkArgs) check('benchmark',()=>{
    if (!runtime.benchmark) throw new Error('actual benchmark evidence missing');
    const actual = readBenchmarkRuntimeEvidence(benchmarkArgs,runtime.benchmark.exitCode);
    if (JSON.stringify(actual)!==JSON.stringify(runtime.benchmark)) throw new Error('benchmark artifacts moved after child readback');
    report.searchAdapterExercised = true;
    return actual;
  });
  const starts: WorkerNativeInferenceTrace[] = runtime.native.filter((event:WorkerNativeInferenceTrace)=>event.phase==='start');
  check('sourceCapture',()=>validateRuntimeSourceCapture(fs.readFileSync(outputs['sources.jsonl'],'utf8').trim().split('\n').map(line=>JSON.parse(line)),
    [...new Set(starts.map(start=>String(start.workerThreadId)))],
    {processId:runtime.processId,exitCode:result.code!,signal:result.signal,eof}));
  let windows: NativeProfilerRequestWindow[] = [];
  check('nativeWindows',()=>{
    if(!starts.length) throw new Error('native run population missing');
    windows=starts.map(start=>{
      const ends=runtime.native.filter((end:WorkerNativeInferenceTrace)=>end.phase==='end' && end.runTag===start.runTag && end.outcome==='success');
      if (ends.length!==1 || !start.nativeThreadId) throw new Error('native run population incomplete');
      return {runTag:start.runTag,processId:start.processId,nativeThreadId:start.nativeThreadId,startMonotonicNs:start.monotonicNs,endMonotonicNs:ends[0].monotonicNs};
    });
    return windows;
  });
  const errBytes=Buffer.concat(stderr);
  check('nativeLoader',()=>bindNativeLoaderClosure(errBytes,windows,starts[0],{source:'spawn-pipe',captureStartedBeforeExec:true,
    eof:eof as true,processId:runtime.processId,exitCode:result.code!,signal:result.signal,bytes:errBytes.length,sha256:digest(errBytes)}));
  check('modelOpens',()=>bindRuntimeModelOpens(fs.readFileSync(outputs['file-opens.log'],'utf8'),
    {processId:runtime.processId,assets,beforeEpochMs:Date.parse(starts[0].observedAt)}));
  check('modelStamps',()=>{for(const asset of assets) if(stamp(asset.path)!==stamps.get(asset.path)) throw new Error('model asset moved during runtime: '+asset.path);return {stable:true,scope:'pre-run sha256 plus unchanged device/inode/size/mtime/ctime through terminal capture'};});
  if (result.code!==0 || result.signal!==null || runtime.failure) process.exitCode=1;
  report.qualifiedComponentsOnly = process.exitCode !== 1;
  write(outputs['report.json'],report);
  console.log(JSON.stringify({output:outputs['report.json'],sha256:digest(fs.readFileSync(outputs['report.json'])),qualifiedComponentsOnly:report.qualifiedComponentsOnly,
    completeRuntimeClosureVerified:false}));
}
if (args.includes('--child')) await child(argument('--child')); else await parent();
