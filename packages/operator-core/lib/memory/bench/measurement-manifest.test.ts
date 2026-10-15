import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertNativeProfilerQualification, bindNativeProfilerKernelRequests, bindNativeLoaderMappedObjects, bindNativeLoaderClosure, inspectNativeLoaderActivity, loadIndependentMeasurementInputs, loadRetainedRelevanceVectors, alignRetainedRelevanceDocuments, embedIncrementalRelevanceQueries, embedIncrementalRelevanceDocuments, hashJson, validateIndependentCohort, writeMeasurementCell, failMeasurementCell, type PreparedMeasurement, type NativeLoaderCaptureReceipt } from './measurement-manifest';
import type { WorkerNativeInferenceTrace } from '../../../../../libs/generic/memory/src/local-embedder-worker';
import { independentCohortFixture, measurementManifestFixture } from './fixtures/measurement-manifest';

const roots: string[] = [];
describe('native loader population evidence', () => {
  const window = { runTag: 'pc-embed:123:1:0:1:1', processId: 123, nativeThreadId: 456,
    startMonotonicNs: '100', endMonotonicNs: '200' };
  const marker = (phase: string, overrides = {}) => 'PC_NATIVE_RUN\t'+JSON.stringify({ runTag: window.runTag,
    processId: 123, nativeThreadId: 456, phase, monotonicNs: phase === 'start' ? '100' : '200', ...overrides });
  const startup = ['123: file=libc.so.6 [0];  generating link map',
    '123: calling init: /lib/libc.so.6', '123: transferring control: /runtime/node'];
  const log = (...middle: string[]) => [...startup, marker('start'), ...middle, marker('end')].join('\n');
  it('binds complete markers and keeps no-activity distinct from complete DLL closure', () => {
    expect(inspectNativeLoaderActivity(log('999: file=child.so [0];  generating link map'), [window]))
      .toMatchObject({ noLoaderActivityDuringPopulation: true, completeBeforeInferenceClosureVerified: false });
  });
  it('detects a transient load/unload even when the snapshot population would be unchanged', () => {
    const result = inspectNativeLoaderActivity(log('123: file=/runtime/transient.so [2];  generating link map',
      '123: calling init: /runtime/transient.so', '123: calling fini: /runtime/transient.so [2]',
      '123: file=/runtime/transient.so [2];  destroying link map'), [window]);
    expect(result.noLoaderActivityDuringPopulation).toBe(false);
    expect(result.activity.map(x=>x.operation)).toEqual(['generating-map','init','fini','destroying-map']);
    expect(result.activity[0].namespace).toBe('2');
  });
  it('rejects invalid and overlapping native request populations before inspecting logs', () => {
    expect(()=>inspectNativeLoaderActivity(log(),[])).toThrow('population');
    expect(()=>inspectNativeLoaderActivity(log(),[window,window])).toThrow('population');
    expect(()=>inspectNativeLoaderActivity(log(),[{...window,startMonotonicNs:100 as any}])).toThrow('population');
    expect(()=>inspectNativeLoaderActivity(log(),[window,{...window,runTag:'second',startMonotonicNs:'150',endMonotonicNs:'250'}]))
      .toThrow('overlapping');
  });
  it.each(['missing-start','missing-end','duplicate','tag','thread','clock','process','malformed','startup','format'])
    ('rejects %s evidence', failure => {
      let text = log();
      if (failure === 'missing-start') text = [...startup, marker('end')].join('\n');
      if (failure === 'missing-end') text = [...startup, marker('start')].join('\n');
      if (failure === 'duplicate') text = log(marker('start'));
      if (['tag','thread','clock','process'].includes(failure)) text = [...startup,
        marker('start', failure === 'tag' ? {runTag:'another'} : failure === 'thread' ? {nativeThreadId:1}
          : failure === 'clock' ? {monotonicNs:'99'} : {processId:999}), marker('end')].join('\n');
      if (failure === 'malformed') text = log('PC_NATIVE_RUN\t{');
      if (failure === 'startup') text = [marker('start'),marker('end')].join('\n');
      if (failure === 'format') text = log('123: file=broken; generating link map');
      expect(()=>inspectNativeLoaderActivity(text,[window])).toThrow('native loader');
    });
  it.runIf(process.platform === 'linux')('observes real glibc load/unload of a model-free shared object', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(),'native-loader-fixture-')); roots.push(root);
    const library = path.join(root,'transient.so');
    const compiler = spawnSync('/usr/bin/cc',['-x','c','-shared','-fPIC','-nostdlib','-o',library,'-'],
      { input:'int pc_loader_fixture(void) { return 7; }',encoding:'utf8',timeout:10000 });
    expect(compiler.status,compiler.stderr).toBe(0);
    const program = `import ctypes,_ctypes,json,os,time
def marker(phase):
 n=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC)); row=dict(runTag='fixture',processId=os.getpid(),nativeThreadId=os.getpid(),phase=phase,monotonicNs=n)
 os.write(2,('PC_NATIVE_RUN\\t'+json.dumps(row)+'\\n').encode()); return n
start=marker('start')
library=ctypes.CDLL(${JSON.stringify(library)})
assert library.pc_loader_fixture()==7
_ctypes.dlclose(library._handle)
end=marker('end')
print(json.dumps(dict(runTag='fixture',processId=os.getpid(),nativeThreadId=os.getpid(),startMonotonicNs=start,endMonotonicNs=end)))`;
    const env: NodeJS.ProcessEnv={...process.env,LD_DEBUG:'files'}; delete env.LD_DEBUG_OUTPUT;
    const child=spawnSync('/usr/bin/python3',['-I','-S','-c',program],{env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
    expect(child.status,child.stderr).toBe(0);
    const result=inspectNativeLoaderActivity(child.stderr,[JSON.parse(child.stdout)]);
    expect(result.noLoaderActivityDuringPopulation).toBe(false);
    expect(result.activity).toEqual(expect.arrayContaining([
      expect.objectContaining({operation:'generating-map',object:library}),
      expect.objectContaining({operation:'destroying-map',object:library}),
    ]));
  });
});
describe('generated loader object to retained file joins', () => {
  const window = { runTag: 'first', processId: 123, nativeThreadId: 456, startMonotonicNs: '100', endMonotonicNs: '200' };
  const marker = (phase: 'start'|'end') => 'PC_NATIVE_RUN\t'+JSON.stringify({ runTag: window.runTag,
    processId: 123, nativeThreadId: 456, phase, monotonicNs: phase === 'start' ? '100' : '200' });
  const object = (name='libsame.so', namespace='0', dynamic='0x1800', phdr='0x1040', bias='0x1000') =>
    [`123: file=${name} [${namespace}];  generating link map`,
      `123: dynamic: ${dynamic}  base: ${bias}  size: 0x1000`, `123: entry: 0x1000  phdr: ${phdr}  phnum: 9`];
  const log = (...rows: string[]) => [...rows,'123: calling init: /alias/libsame.so',
    '123: transferring control: /runtime/node',marker('start'),marker('end')].join('\n');
  const sample = (): WorkerNativeInferenceTrace => ({ model:'/fixture', device:'cpu', observedAt:'2026-10-02T00:00:00.000Z',
    requestId:1,attempt:1,workerThreadId:1,processId:123,nativeThreadId:456,runTag:'first',runIndex:1,
    phase:'start',clock:'node-hrtime',monotonicNs:'100',runtime:{platform:'linux',clock:'node-hrtime',beforeNs:'80',afterNs:'90',
      gpuMemory:{status:'not-applicable'},libraries:[{path:'/resolved/libsame.so.1',bytes:8192,sha256:'a'.repeat(64),
        mappedDevice:'08:01',mappedInode:'123',mappedRanges:[{startAddress:'1000',endAddress:'2000',fileOffset:'0',permissions:'r--p'}]}]}});
  it('joins actual addresses to resolved fingerprints, preserving load bias zero and scope', () => {
    const result=bindNativeLoaderMappedObjects(log(...object(undefined,undefined,undefined,undefined,'0x0')),[window],sample());
    expect(result.objectMapJoins).toHaveLength(1);
    expect(result.objectMapJoins[0]).toMatchObject({object:'libsame.so',namespace:'0',loadBias:'0x0',
      file:{path:'/resolved/libsame.so.1',mappedInode:'123',sha256:'a'.repeat(64)}});
    expect(result.completeBeforeInferenceClosureVerified).toBe(false);
  });
  it('distinguishes identical basenames and namespaces by addresses, not names', () => {
    const event=sample(), other=structuredClone(event.runtime!.libraries[0]);
    other.path='/other/libsame.so.1';other.mappedInode='456';other.sha256='b'.repeat(64);
    other.mappedRanges=[{startAddress:'3000',endAddress:'4000',fileOffset:'0',permissions:'r--p'}];
    event.runtime!.libraries.push(other);
    const result=bindNativeLoaderMappedObjects(log(...object(),...object('libsame.so','2','0x3800','0x3040','0x3000')),[window],event);
    expect(result.objectMapJoins.map(join=>[join.namespace,join.file.path])).toEqual([
      ['0','/resolved/libsame.so.1'],['2','/other/libsame.so.1']]);
  });
  it('reports retired objects and unjoined executable/interpreter mappings explicitly', () => {
    const event=sample(), other=structuredClone(event.runtime!.libraries[0]);
    other.path='/runtime/node';other.mappedRanges=[{startAddress:'5000',endAddress:'6000',fileOffset:'0',permissions:'r-xp'}];
    event.runtime!.libraries.push(other);
    const result=bindNativeLoaderMappedObjects(log(...object(),...object('transient.so','1','0x3800','0x3040'),
      '123: file=transient.so [1];  destroying link map'),[window],event);
    expect(result.retiredBeforeFirstRun.map(x=>x.object)).toEqual(['transient.so']);
    expect(result.unjoinedMappedFiles.map(x=>x.path)).toEqual(['/runtime/node']);
  });
  it.each(['node_register_module_v141','napi_register_module_v1','node_api_module_get_api_version_v1'])
    ('records the exact startup Node addon %s lookup without suppressing general failures',symbol=>{
      const event=sample();event.runtime!.libraries[0].path='/resolved/addon.node';
      event.runtime!.loaderProcess={nodeModuleVersion:'141'} as any;
      const rows=[...object('/resolved/addon.node'),`123: /resolved/addon.node: error: symbol lookup error: undefined symbol: ${symbol} (fatal)`];
      const result=bindNativeLoaderMappedObjects(log(...rows),[window],event);
      expect(result.registrationProbeLookups).toEqual([{line:4,object:'/resolved/addon.node',symbol}]);
      for(const unsupported of ['other_required_symbol','node_register_module_v140']) {
        expect(()=>bindNativeLoaderMappedObjects(log(...rows.slice(0,-1),
          `123: /resolved/addon.node: error: symbol lookup error: undefined symbol: ${unsupported} (fatal)`),[window],event)).toThrow('native loader');
      }
      expect(()=>bindNativeLoaderMappedObjects(log(...rows.slice(0,-1),
        `123: /different/addon.node: error: symbol lookup error: undefined symbol: ${symbol} (fatal)`),[window],event)).toThrow('native loader');
    });
  it.each(['missing-ranges','bad-range','overlap','dynamic','header','split-file','missing-detail','namespace',
    'repeated-object','unbound-destroy','wrong-sample','late-sample','bad-fingerprint','foreign-detail'])('refuses %s evidence', failure => {
    const event=sample(); let rows=object();
    if(failure==='missing-ranges') delete event.runtime!.libraries[0].mappedRanges;
    if(failure==='bad-range') event.runtime!.libraries[0].mappedRanges![0].endAddress='1000';
    if(failure==='overlap'||failure==='split-file') {
      const other=structuredClone(event.runtime!.libraries[0]); other.path='/different.so';
      if(failure==='split-file') {
        event.runtime!.libraries[0].mappedRanges![0].endAddress='1800';
        other.mappedRanges![0].startAddress='1800';
      }
      event.runtime!.libraries.push(other);
    }
    if(failure==='dynamic') rows=object(undefined,undefined,'0x2800');
    if(failure==='header') rows=object(undefined,undefined,undefined,'0x2040');
    if(failure==='missing-detail') rows.splice(1,1);
    if(failure==='namespace') rows.push(...object('second.so','2'));
    if(failure==='repeated-object') rows.push(...object());
    if(failure==='unbound-destroy') rows.push('123: file=other.so [0];  destroying link map');
    if(failure==='wrong-sample') event.nativeThreadId=999;
    if(failure==='late-sample') event.runtime!.afterNs='101';
    if(failure==='bad-fingerprint') event.runtime!.libraries[0].sha256='bad';
    if(failure==='foreign-detail') rows[1]=rows[1].replace('123:','999:');
    expect(()=>bindNativeLoaderMappedObjects(log(...rows),[window],event)).toThrow('native loader');
  });
  // WI-6554700010008342 — TIMING BUDGET, do not re-tighten. These timeouts only guard against
  // a hung child; they assert nothing about speed. The python child hashes every mapped
  // library with LD_DEBUG=files on, and in green-checkpoint run 3ff293fb (2026-10-11) the old
  // 10s cap killed it under gate load (status null, the stderr dump was the message), while
  // the file passed alone at the same sha.
  const NATIVE_CHILD_HANG_GUARD_MS = 120_000;
  it.runIf(process.platform === 'linux')('joins real glibc object addresses to hashed pre-Run file maps', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-loader-namespace-'));roots.push(root);
    const library=path.join(root,'same-object.so');
    const compiled=spawnSync('/usr/bin/cc',['-x','c','-shared','-fPIC','-nostdlib','-o',library,'-'],
      {input:'int pc_loader_fixture(void) { return 7; }',encoding:'utf8',timeout:NATIVE_CHILD_HANG_GUARD_MS});
    expect(compiled.status,compiled.stderr).toBe(0);
    const program = `import os,json,time,hashlib,ctypes,struct
libc=ctypes.CDLL('libc.so.6')
libc.dlmopen.argtypes=[ctypes.c_long,ctypes.c_char_p,ctypes.c_int]; libc.dlmopen.restype=ctypes.c_void_p
handles=[libc.dlmopen(-1,${JSON.stringify(library)}.encode(),2) for _ in range(2)]
assert all(handles) and handles[0]!=handles[1]
rows={}
before=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC))
for line in open('/proc/self/maps'):
 fields=line.split(None,5)
 if len(fields)<6 or not fields[5].startswith('/'): continue
 address,permissions,offset,device,inode,file=fields; file=file.strip()
 row=rows.setdefault(file,dict(path=file,mappedDevice=device,mappedInode=inode,mappedRanges=[],eligible=False))
 row['eligible'] |= 'x' in permissions or '.so' in file
 start,end=address.split('-'); row['mappedRanges'].append(dict(startAddress=start,endAddress=end,fileOffset=offset,permissions=permissions))
libraries=[]
for file,row in rows.items():
 if not row.pop('eligible'): continue
 stat=os.stat(file)
 assert str(stat.st_ino)==row['mappedInode']
 assert (os.major(stat.st_dev),os.minor(stat.st_dev))==tuple(int(x,16) for x in row['mappedDevice'].split(':'))
 row.update(bytes=stat.st_size,sha256=hashlib.file_digest(open(file,'rb'),'sha256').hexdigest()); libraries.append(row)
auxv={}
raw=open('/proc/self/auxv','rb').read()
for offset in range(0,len(raw),16):
 key,value=struct.unpack_from('<QQ',raw,offset)
 if key==0: break
 auxv[key]=value
executable=os.path.realpath('/proc/self/exe')
image=open(executable,'rb').read()
assert image[:6]==bytes([127,69,76,70,2,1])
phoff=struct.unpack_from('<Q',image,32)[0]; phent,phnum=struct.unpack_from('<HH',image,54)
assert (phent,phnum)==(auxv[4],auxv[5])
interpreter=None
for index in range(phnum):
 offset=phoff+index*phent
 if struct.unpack_from('<I',image,offset)[0]!=3: continue
 nameOffset=struct.unpack_from('<Q',image,offset+8)[0]; nameBytes=struct.unpack_from('<Q',image,offset+32)[0]
 interpreter=os.path.realpath(image[nameOffset:nameOffset+nameBytes-1].decode())
vdsoLine=next(line for line in open('/proc/self/maps') if line.rstrip().endswith('[vdso]'))
vdsoAddress,vdsoPermissions,vdsoOffset=vdsoLine.split()[:3]; vdsoStart,vdsoEnd=vdsoAddress.split('-')
assert int(vdsoStart,16)==auxv[33]
memory=os.open('/proc/self/mem',os.O_RDONLY)
try: vdsoBytes=os.pread(memory,int(vdsoEnd,16)-int(vdsoStart,16),auxv[33])
finally: os.close(memory)
loaderProcess=dict(executablePath=executable,interpreterPath=interpreter,programHeaderAddress=hex(auxv[3])[2:],
 programHeaderEntryBytes=phent,programHeaderCount=phnum,entryAddress=hex(auxv[9])[2:],interpreterBaseAddress=hex(auxv[7])[2:],
 vdso=dict(startAddress=vdsoStart,endAddress=vdsoEnd,fileOffset=vdsoOffset,permissions=vdsoPermissions,
 bytes=len(vdsoBytes),sha256=hashlib.sha256(vdsoBytes).hexdigest(),origin='kernel-auxv-AT_SYSINFO_EHDR'))
after=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC))
def marker(phase):
 n=str(time.clock_gettime_ns(time.CLOCK_MONOTONIC)); os.write(2,('PC_NATIVE_RUN\\t'+json.dumps(dict(runTag='real',processId=os.getpid(),nativeThreadId=os.getpid(),phase=phase,monotonicNs=n))+'\\n').encode()); return n
start=marker('start'); end=marker('end')
print(json.dumps(dict(window=dict(runTag='real',processId=os.getpid(),nativeThreadId=os.getpid(),startMonotonicNs=start,endMonotonicNs=end),runtime=dict(platform='linux',clock='node-hrtime',beforeNs=before,afterNs=after,libraries=libraries,gpuMemory=dict(status='not-applicable'),loaderProcess=loaderProcess))))`;
    const env: NodeJS.ProcessEnv={...process.env,LD_DEBUG:'files'};delete env.LD_DEBUG_OUTPUT;
    const child=spawnSync('/usr/bin/python3',['-I','-S','-c',program],{env,encoding:'utf8',timeout:NATIVE_CHILD_HANG_GUARD_MS,maxBuffer:2*1024*1024});
    expect(child.status,child.stderr).toBe(0);
    const observed=JSON.parse(child.stdout), event={...sample(),...observed.window,runTag:'real',
      monotonicNs:observed.window.startMonotonicNs,runtime:observed.runtime};
    const result=bindNativeLoaderMappedObjects(child.stderr,[observed.window],event);
    expect(result.objectMapJoins.length).toBeGreaterThan(3);
    expect(result.objectMapJoins.some(join=>join.object==='libc.so.6')).toBe(true);
    const namespaceJoins=result.objectMapJoins.filter(join=>join.file.path===library);
    expect(namespaceJoins).toHaveLength(2);
    expect(new Set(namespaceJoins.map(join=>join.namespace)).size).toBe(2);
    expect(namespaceJoins.every(join=>join.namespace!=='0')).toBe(true);
    expect(result.noLoaderActivityDuringPopulation).toBe(true);
    expect(result.unjoinedMappedFiles.some(file=>file.path.includes('python3'))).toBe(true);
    expect(result.completeBeforeInferenceClosureVerified).toBe(false);
    const stderr=Buffer.from(child.stderr);
    const closure=bindNativeLoaderClosure(stderr,[observed.window],event,{source:'spawn-pipe',captureStartedBeforeExec:true,
      eof:true,processId:observed.window.processId,exitCode:child.status!,signal:child.signal,bytes:stderr.length,
      sha256:crypto.createHash('sha256').update(stderr).digest('hex')});
    expect(closure.completeBeforeInferenceClosureVerified).toBe(true);
    expect(closure.unjoinedMappedFiles).toEqual([]);
    expect(closure.executable.path).toBe(fs.realpathSync('/usr/bin/python3'));
    expect(closure.interpreter.path).toContain('ld-linux');
    expect(closure.initializationJoins.some(join=>join.file===closure.interpreter)).toBe(true);
    expect(closure.vdso.origin).toBe('kernel-auxv-AT_SYSINFO_EHDR');
  }, 2 * NATIVE_CHILD_HANG_GUARD_MS + 30_000);
});
describe('complete native loader capture qualification', () => {
  const window={runTag:'closure',processId:123,nativeThreadId:456,startMonotonicNs:'100',endMonotonicNs:'200'};
  const marker=(phase:'start'|'end')=>'PC_NATIVE_RUN\t'+JSON.stringify({runTag:'closure',processId:123,nativeThreadId:456,
    phase,monotonicNs:phase==='start'?'100':'200'});
  const log=()=>Buffer.from(['123: file=/lib/library.so [0];  generating link map',
    '123: dynamic: 0x1800 base: 0x1000 size: 0x1000','123: entry: 0x1000 phdr: 0x1040 phnum: 9',
    '123: calling init: /lib/library.so','123: calling init: /lib/interpreter.so','123: transferring control: /runtime/node',
    marker('start'),marker('end'),'123: calling fini: /lib/library.so [0]',''].join('\n'));
  const receipt=(bytes:Buffer):NativeLoaderCaptureReceipt=>({source:'spawn-pipe',captureStartedBeforeExec:true,eof:true,
    processId:123,exitCode:0,signal:null,bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});
  const sample=():WorkerNativeInferenceTrace=>({model:'/fixture',device:'cpu',observedAt:'2026-10-02T00:00:00Z',requestId:1,
    attempt:1,workerThreadId:1,processId:123,nativeThreadId:456,runTag:'closure',runIndex:1,phase:'start',clock:'node-hrtime',
    monotonicNs:'100',runtime:{platform:'linux',clock:'node-hrtime',beforeNs:'80',afterNs:'90',gpuMemory:{status:'not-applicable'},
      libraries:[['/lib/library.so','1000','2000'],['/runtime/node','3000','4000'],['/lib/interpreter.so','5000','6000']]
        .map(([path,startAddress,endAddress])=>({path,bytes:4096,sha256:'a'.repeat(64),mappedInode:'123',mappedDevice:'08:01',
          mappedRanges:[{startAddress,endAddress,fileOffset:'0',permissions:'r-xp'}]})),
      loaderProcess:{executablePath:'/runtime/node',interpreterPath:'/lib/interpreter.so',programHeaderAddress:'3040',
        programHeaderEntryBytes:56,programHeaderCount:9,entryAddress:'3100',interpreterBaseAddress:'5000',
        vdso:{startAddress:'7000',endAddress:'8000',fileOffset:'0',permissions:'r-xp',bytes:4096,
          sha256:'b'.repeat(64),origin:'kernel-auxv-AT_SYSINFO_EHDR'}}}});
  it('qualifies the exec image, init-only interpreter and kernel vDSO with no mapped-file residue',()=>{
    const bytes=log(),result=bindNativeLoaderClosure(bytes,[window],sample(),receipt(bytes));
    expect(result).toMatchObject({completeBeforeInferenceClosureVerified:true,unjoinedMappedFiles:[],
      executable:{path:'/runtime/node'},interpreter:{path:'/lib/interpreter.so'},vdso:{sha256:'b'.repeat(64)}});
    expect(result.initializationJoins.map(join=>[join.file.path,join.namespaces])).toEqual([
      ['/lib/library.so',['0']],['/lib/interpreter.so',[]]]);
  });
  it.each(['source','late-start','missing-eof','exit','signal','pid','bytes','hash','encoding'])('refuses %s stderr receipts',failure=>{
    let bytes=log(); const observed=receipt(bytes);
    if(failure==='source') (observed as any).source='log-tail';
    if(failure==='late-start') (observed as any).captureStartedBeforeExec=false;
    if(failure==='missing-eof') (observed as any).eof=false;
    if(failure==='exit') observed.exitCode=1;
    if(failure==='signal') observed.signal='SIGTERM';
    if(failure==='pid') observed.processId=999;
    if(failure==='bytes') observed.bytes++;
    if(failure==='hash') observed.sha256='0'.repeat(64);
    if(failure==='encoding') {bytes=Buffer.concat([bytes,Buffer.from([255])]);Object.assign(observed,receipt(bytes));}
    expect(()=>bindNativeLoaderClosure(bytes,[window],sample(),observed)).toThrow('native loader');
  });
  it.each(['missing-process','entry','headers','count','interpreter','base','vdso-hash','vdso-size','vdso-overlap',
    'residue','init-path','init-only','malformed-init','transfer','double-transfer','late-error','transient','preinit'])('refuses %s closure evidence',failure=>{
    const event=sample(),process=event.runtime!.loaderProcess!;let text=log().toString();
    if(failure==='missing-process') delete event.runtime!.loaderProcess;
    if(failure==='entry') process.entryAddress='1800';
    if(failure==='headers') process.programHeaderAddress='3f80';
    if(failure==='count') process.programHeaderCount=0;
    if(failure==='interpreter') process.interpreterPath='/lib/library.so';
    if(failure==='base') process.interpreterBaseAddress='5001';
    if(failure==='vdso-hash') process.vdso.sha256='bad';
    if(failure==='vdso-size') process.vdso.bytes++;
    if(failure==='vdso-overlap') {process.vdso.startAddress='3000';process.vdso.endAddress='4000';}
    if(failure==='residue'||failure==='init-only') event.runtime!.libraries.push({...structuredClone(event.runtime!.libraries[0]),
      path:'/lib/unjoined.so',mappedRanges:[{startAddress:'9000',endAddress:'a000',fileOffset:'0',permissions:'r-xp'}]});
    if(failure==='init-path') text=text.replace('calling init: /lib/library.so','calling init: unresolved.so');
    if(failure==='init-only') text=text.replace('calling init: /lib/library.so','calling init: /lib/unjoined.so');
    if(failure==='malformed-init') text=text.replace('calling init: /lib/library.so','calling init:');
    if(failure==='transfer') text=text.replace('transferring control: /runtime/node','transferring control: /lib/library.so');
    if(failure==='double-transfer') text=text.replace(marker('start'),'123: transferring control: /runtime/node\n'+marker('start'));
    if(failure==='late-error') text+='123: fatal: lost loader evidence\n';
    if(failure==='transient') text=text.replace(marker('end'),'123: file=transient.so [0];  generating link map\n'+marker('end'));
    if(failure==='preinit') text=text.replace(marker('end'),'123: calling preinit: /runtime/node\n'+marker('end'));
    const bytes=Buffer.from(text);
    expect(()=>bindNativeLoaderClosure(bytes,[window],event,receipt(bytes))).toThrow('native loader');
  });
  it('binds symlink aliases by inode/device/hash and refuses replaced alias bytes',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-loader-alias-'));roots.push(root);
    const file=path.join(root,'library.so'),alias=path.join(root,'alias.so');fs.writeFileSync(file,'pinned loader bytes');fs.symlinkSync(file,alias);
    const event=sample(),stat=fs.statSync(file,{bigint:true}),library=event.runtime!.libraries[0];
    library.path=file;library.bytes=Number(stat.size);library.sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    library.mappedInode=stat.ino.toString();
    const major=((stat.dev>>8n)&0xfffn)|((stat.dev>>32n)&0xfffff000n),minor=(stat.dev&0xffn)|((stat.dev>>12n)&0xffffff00n);
    library.mappedDevice=major.toString(16)+':'+minor.toString(16);
    const bytes=Buffer.from(log().toString().replace('calling init: /lib/library.so','calling init: '+alias));
    const result=bindNativeLoaderClosure(bytes,[window],event,receipt(bytes));
    expect(result.initializationJoins[0]).toMatchObject({object:alias,file:{path:file,sha256:library.sha256}});
    fs.writeFileSync(file,'changed same length');
    expect(()=>bindNativeLoaderClosure(bytes,[window],event,receipt(bytes))).toThrow('alias does not bind');
  });
});
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function prepared(): PreparedMeasurement {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-eval-test-')); roots.push(dir);
  const manifest = measurementManifestFixture(dir), { entries, queries, proof } = independentCohortFixture();
  const write = (name: string, value: unknown) => {
    const file = path.join(dir, `${name}.json`), bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes);
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  manifest.inputs.snapshot = write('snapshot', { suites: { memory: { entries } } });
  manifest.inputs.labels = write('labels', { memory: queries });
  manifest.inputs.judgments = write('judgments', { memory: { ...proof,
    snapshotSha256: manifest.inputs.snapshot.sha256, labelsSha256: manifest.inputs.labels.sha256 } });
  const cell = manifest.cells.find((c) => c.bar === 'relevance')!;
  return { manifest, cell, arm: manifest.arms[0], manifestSha256: 'a'.repeat(64), rawOutput: path.join(dir, 'out.json'), claimPath: path.join(dir, 'out.running') };
}
describe('immutable measurement receipt publication', () => {
  const attempt = () => {
    const p = prepared();
    fs.writeFileSync(p.claimPath, JSON.stringify({ ownerId: p.manifest.ownerId, pid: process.pid,
      manifestSha256: p.manifestSha256, cellId: p.cell.id }));
    return p;
  };
  for (const kind of ['success', 'failure'] as const) {
    const destination = (p: PreparedMeasurement) => kind === 'success' ? p.rawOutput : `${p.rawOutput}.failure.json`;
    const publish = (p: PreparedMeasurement) => kind === 'success' ? writeMeasurementCell(p, { result: 'complete' })
      : failMeasurementCell(p, new Error('measured failure', { cause: new Error('retained cause') }));
    it.each(['write', 'flush'])(`keeps interrupted ${kind} %s out of the final namespace and retains its claim`, phase => {
      const p = attempt(), file = destination(p), claim = fs.readFileSync(p.claimPath), originalWrite = fs.writeFileSync;
      const interrupted = new Error('interrupted receipt publication');
      const fault = phase === 'write' ? vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options) => {
        if (typeof target === 'number') {
          originalWrite(target, '{');
          expect(fs.existsSync(file)).toBe(false);
          throw interrupted;
        }
        return originalWrite(target, data, options);
      }) : vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {
        expect(fs.existsSync(file)).toBe(false); throw interrupted;
      });
      try {
        expect(() => publish(p)).toThrow(interrupted);
        expect(fs.existsSync(file)).toBe(false);
        expect(fs.readFileSync(p.claimPath)).toEqual(claim);
        expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.pending'))).toEqual([]);
        fault.mockRestore();
        publish(p);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ cellId: p.cell.id, manifestSha256: p.manifestSha256 });
        expect(fs.existsSync(p.claimPath)).toBe(false);
      } finally { fault.mockRestore(); }
    });
    it(`preserves a competing complete ${kind} receipt and retains its claim`, () => {
      const p = attempt(), file = destination(p), claim = fs.readFileSync(p.claimPath), originalLink = fs.linkSync;
      const winner = JSON.stringify({ owner: 'other', result: 'winner' });
      const fault = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
        fs.writeFileSync(file, winner, { flag: 'wx' });
        return originalLink(from, to);
      });
      try {
        expect(() => publish(p)).toThrow(/EEXIST/);
        expect(fs.readFileSync(file, 'utf8')).toBe(winner);
        expect(fs.readFileSync(p.claimPath)).toEqual(claim);
        expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.pending'))).toEqual([]);
      } finally { fault.mockRestore(); }
    });
    it(`publishes a complete ${kind} envelope before releasing its claim`, () => {
      const p = attempt(), file = destination(p), originalUnlink = fs.unlinkSync;
      const release = vi.spyOn(fs, 'unlinkSync').mockImplementation(target => {
        if (target === p.claimPath) expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({
          ownerId: p.manifest.ownerId, cellId: p.cell.id, manifestSha256: p.manifestSha256 });
        return originalUnlink(target);
      });
      try {
        const outcome = publish(p), bytes = fs.readFileSync(file), receipt = JSON.parse(bytes.toString());
        if (kind === 'success') {
          expect(receipt).toMatchObject({ armId: p.arm.id, report: { result: 'complete' } });
          expect(outcome).toMatchObject({ status: 'measured', artifacts: [{ path: file, bytes: bytes.length,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex') }] });
        } else expect(receipt.error).toMatchObject({ message: 'measured failure', cause: { message: 'retained cause' } });
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.existsSync(p.claimPath)).toBe(false);
        expect(fs.readdirSync(path.dirname(file)).filter(name => name.endsWith('.pending'))).toEqual([]);
      } finally { release.mockRestore(); }
    });
  }
});
describe('independent relevance evaluator inputs', () => {
  it('retains abstention diagnostics only for ambiguous excluded queries', () => {
    const { entries, queries, proof } = independentCohortFixture();
    const diagnostic = { queryId: 'excluded-query', pass: 1, documentIndices: [184] };
    const receipt = { ...proof, ambiguous: ['excluded-query'], excluded: ['excluded-query'], formatAbstentions: [diagnostic] };
    const validate = (value: unknown) => validateIndependentCohort(entries, queries, value,
      proof.snapshotSha256, proof.labelsSha256, proof.frozenAt);
    expect(() => validate(receipt)).not.toThrow();
    expect(() => validate({ ...receipt, excluded: [] })).toThrow('must be excluded');
    expect(() => validate({ ...receipt, formatAbstentions: [{ ...diagnostic, queryId: queries[0].id }] }))
      .toThrow('must be excluded');
  });
  it('loads actual corpus and blind labels, retaining partition metadata and hash-bound versions', () => {
    const p = prepared(), actual = loadIndependentMeasurementInputs(p, 'memory');
    expect(actual.entries.map((e) => e.text)).toEqual(['original source A', 'original source B']);
    expect(actual.queries.filter((q) => q.partition === 'test')).toHaveLength(4);
    expect(actual.queries.filter((q) => q.partition === 'calibration')).toHaveLength(4);
    expect(actual.corpusVersion).toContain(p.manifest.inputs.snapshot.sha256);
    expect(actual.goldVersion).toContain(p.manifest.inputs.labels.sha256);
  });
  it('rejects substituted inputs between preparation and scoring', () => {
    const p = prepared(); fs.appendFileSync(p.manifest.inputs.labels.path, ' ');
    expect(() => loadIndependentMeasurementInputs(p, 'memory')).toThrow('changed after preparation');
  });
  it('rejects a different corpus/cell and altered order instead of falling back to legacy fixtures', () => {
    const p = prepared();
    expect(() => loadIndependentMeasurementInputs(p, 'prose')).toThrow('corpus/cell');
    p.manifest.datasets[0].queryIds.reverse();
    expect(() => loadIndependentMeasurementInputs(p, 'memory')).toThrow('order');
  });
});

function retainedPreparedFixture() {
  const p = prepared(), root = p.manifest.privateRoot;
  const pin = (name: string, value: unknown) => {
    const file = path.join(root, `${name}.json`), bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(file, bytes);
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  };
  const { entries, queries, proof } = independentCohortFixture();
  entries.push({ key: 'c', text: 'second B source passage', kind: 'fact', metadata: { cluster: 'source-b' } });
  p.arm.execution.transport = 'worker';
  p.manifest.inputs.snapshot = pin('snapshot', { suites: { memory: { entries } } });
  p.manifest.inputs.labels = pin('labels', { memory: queries });
  p.manifest.inputs.census = pin('census', {});
  p.manifest.inputs.judgments = pin('judgments', { memory: { ...proof,
    snapshotSha256: p.manifest.inputs.snapshot.sha256, labelsSha256: p.manifest.inputs.labels.sha256 } });
  p.manifest.datasets[0].keys = entries.map((e) => e.key);
  const donor = structuredClone(p.manifest), donorCell = donor.cells.find((c) => c.bar === 'relevance')!;
  const manifestRef = pin('donor-manifest', donor);
  const oldInput = loadIndependentMeasurementInputs(p, 'memory');
  const raw = { formatVersion: 1, manifestSha256: manifestRef.sha256, ownerId: donor.ownerId,
    cellId: donorCell.id, armId: p.arm.id, measuredAt: '2026-01-03T00:00:00.000Z',
    report: { corpus: 'memory', corpusVersion: oldInput.corpusVersion, goldSetVersion: oldInput.goldVersion,
      labelAuthority: 'independent-blind-before-inference', scoringPartition: 'test', calibrationReportedSeparately: true,
      results: { mdenseon: { dims: p.arm.profile.nativeDims } } } };
  const unit = (index: number): number[] => Array.from({ length: p.arm.profile.nativeDims }, (_, i) => i === index ? 1 : 0);
  const vectors = { corpus: 'memory', corpusVersion: oldInput.corpusVersion, keys: entries.map((e) => e.key),
    queryIds: queries.map((q) => q.id),
    vectors: { mdenseon: { docVectors: entries.map((_, i) => unit(i)), queryVectors: queries.map((_, i) => unit(i)) } } };
  const rawRef = pin('donor-raw', raw), vectorsRef = pin('donor-vectors', vectors);
  const completion = { formatVersion: 1, status: 'completed', ownerId: donor.ownerId, manifestSha256: manifestRef.sha256,
    completedAt: '2026-01-03T00:00:00.000Z',
    completed: [{ cellId: donorCell.id, raw: rawRef, vectors: vectorsRef }] };
  p.manifest.inputs.reuseManifest = manifestRef;
  p.manifest.inputs.reuseCompletion = pin('donor-completion', completion);
  p.manifest.inputs.reuseVectors = vectorsRef;
  p.cell.inputIds.push('reuseManifest', 'reuseCompletion', 'reuseVectors');
  p.cell.parameters.reuseCellId = donorCell.id;
  p.manifest.frozenAt = '2026-01-04T00:00:00.000Z';
  const added = queries.slice(0, 4).map((q) => ({ ...q, id: `new-${q.id}`, query: `new question ${q.query}` }));
  const currentQueries = [...queries.slice(4).map((q) => ({ ...q,
    expected: q.expected.length ? ['c'] : [] })), ...added, ...queries.slice(0, 4)];
  const setCurrentQueries = (value = currentQueries) => {
    p.manifest.inputs.labels = pin('new-labels', { memory: value });
    p.manifest.datasets[0].queryIds = value.map((q) => q.id);
    p.manifest.inputs.judgments = pin('new-judgments', { memory: { ...proof, queryIds: value.map((q) => q.id),
      snapshotSha256: p.manifest.inputs.snapshot.sha256, labelsSha256: p.manifest.inputs.labels.sha256 } });
  };
  setCurrentQueries();
  return { p, pin, donor, raw, vectors, completion, currentQueries, setCurrentQueries, unit };
}

describe('incremental relevance vector reuse', () => {
  function expandSnapshot(f: ReturnType<typeof retainedPreparedFixture>) {
    const original = JSON.parse(fs.readFileSync(f.donor.inputs.snapshot.path, 'utf8'));
    // Population splitting and randomized measurement ordering use DIFFERENT
    // seeds in the real frozen cohort. Never mirror them in this fixture.
    const identity = { formatVersion: 1, seed: 'source-population-seed', snapshotAt: '2026-01-01T00:00:00.000Z' };
    // Fixture donor snapshot must carry an actual frozen population identity.
    const prior = { ...original, ...identity };
    f.donor.inputs.snapshot = f.pin('identified-donor-snapshot', prior);
    const proof = JSON.parse(fs.readFileSync(f.donor.inputs.judgments.path, 'utf8'));
    proof.memory.snapshotSha256 = f.donor.inputs.snapshot.sha256;
    f.donor.inputs.judgments = f.pin('identified-donor-judgments', proof);
    f.p.manifest.inputs.reuseManifest = f.pin('identified-donor-manifest', f.donor);
    const oldInputs = loadIndependentMeasurementInputs({ ...f.p, manifest: f.donor }, 'memory');
    f.raw.manifestSha256 = f.p.manifest.inputs.reuseManifest.sha256;
    f.raw.report.corpusVersion = oldInputs.corpusVersion;
    f.vectors.corpusVersion = oldInputs.corpusVersion;
    const vectorRef = f.pin('identified-donor-vectors', f.vectors);
    f.p.manifest.inputs.reuseVectors = vectorRef;
    f.completion.completed[0].vectors = vectorRef;
    f.completion.completed[0].raw = f.pin('identified-donor-raw', f.raw);
    f.completion.manifestSha256 = f.p.manifest.inputs.reuseManifest.sha256;
    f.p.manifest.inputs.reuseCompletion = f.pin('identified-donor-completion', f.completion);
    const expanded = structuredClone(prior);
    expanded.suites.memory.entries.splice(1, 0, { key: 'added', text: 'new document text', kind: 'fact',
      metadata: { cluster: 'source-a' } });
    const setSnapshot = () => {
      f.p.manifest.inputs.snapshot = f.pin('expanded-snapshot', expanded);
      f.p.manifest.datasets[0].keys = expanded.suites.memory.entries.map((e: { key: string }) => e.key);
      f.setCurrentQueries();
    };
    setSnapshot();
    f.p.cell.parameters.reuseSnapshotExpansion = true;
    return { expanded, setSnapshot };
  }
  it('maps exact old documents around additive snapshot entries while retaining query identity', async () => {
    const f = retainedPreparedFixture(); expandSnapshot(f);
    const retained = (await loadRetainedRelevanceVectors(f.p, 'memory'))!;
    expect(retained.missingDocumentIndexes).toEqual([1]);
    expect(retained.documentVectors).toEqual([f.unit(0), undefined, f.unit(1), f.unit(2)]);
    expect(retained.docVectors).toEqual(f.vectors.vectors.mdenseon.docVectors);
    expect(retained.missingIndexes).toEqual([4, 5, 6, 7]);
    expect(retained.evidence).toMatchObject({ documentsReused: 3, newDocumentKeys: ['added'],
      snapshotExpansion: true, timingComparableToFullInference: false });
  });
  it('embeds only missing documents through the existing merge validation and preserves donor arrays', async () => {
    const f = retainedPreparedFixture(); expandSnapshot(f);
    f.setCurrentQueries(independentCohortFixture().queries);
    const retained = (await loadRetainedRelevanceVectors(f.p, 'memory'))!;
    const before = structuredClone(retained.docVectors), embed = vi.fn(async () => [f.unit(16)]);
    const documents = await embedIncrementalRelevanceDocuments(retained, retained.documentTexts, embed);
    expect(embed).toHaveBeenCalledOnce(); expect(embed).toHaveBeenCalledWith(['new document text']);
    expect(documents).toEqual([f.unit(0), f.unit(16), f.unit(1), f.unit(2)]);
    expect(retained.docVectors).toEqual(before); expect(retained.documentVectors[1]).toBeUndefined();
    const queryEmbed = vi.fn(async () => []);
    expect(await embedIncrementalRelevanceQueries(retained, retained.queryTexts, queryEmbed))
      .toEqual(f.vectors.vectors.mdenseon.queryVectors);
    expect(queryEmbed).not.toHaveBeenCalled();
    for (const bad of [[1], [2, ...f.unit(0).slice(1)], [NaN, ...f.unit(0).slice(1)]]) {
      await expect(embedIncrementalRelevanceDocuments(retained, retained.documentTexts, async () => [bad]))
        .rejects.toThrow('dimensions/normalization');
    }
    await expect(embedIncrementalRelevanceDocuments(retained, retained.documentTexts, async () => []))
      .rejects.toThrow('new vector population');
    const wrongTexts = [...retained.documentTexts]; wrongTexts[1] += ' changed';
    const noCalls = vi.fn(async () => []);
    await expect(embedIncrementalRelevanceDocuments(retained, wrongTexts, noCalls)).rejects.toThrow('text identity');
    await expect(embedIncrementalRelevanceDocuments(retained, ['wrong'], noCalls)).rejects.toThrow('document population');
    const wrongQueries = [...retained.queryTexts]; wrongQueries[0] += ' changed';
    await expect(embedIncrementalRelevanceQueries(retained, wrongQueries, noCalls)).rejects.toThrow('text identity');
    expect(noCalls).not.toHaveBeenCalled();
  });
  it('does not call the document embedder for an unchanged corpus', async () => {
    const f = retainedPreparedFixture(), retained = (await loadRetainedRelevanceVectors(f.p, 'memory'))!;
    const embed = vi.fn(async () => []);
    expect(await embedIncrementalRelevanceDocuments(retained, retained.documentTexts, embed))
      .toEqual(f.vectors.vectors.mdenseon.docVectors);
    expect(embed).not.toHaveBeenCalled();
  });
  it('qualifies only document alignment before labels, never accepting reordered, altered or duplicate source rows', () => {
    const f = retainedPreparedFixture(), { expanded } = expandSnapshot(f);
    const previous = JSON.parse(fs.readFileSync(f.donor.inputs.snapshot.path, 'utf8')).suites.memory.entries;
    const result = alignRetainedRelevanceDocuments(previous, expanded.suites.memory.entries, f.vectors.vectors.mdenseon.docVectors);
    expect(result.missingDocumentIndexes).toEqual([1]);
    for (const failure of ['order', 'text', 'metadata', 'duplicate', 'removed', 'vector-count']) {
      const rows = structuredClone(expanded.suites.memory.entries), vectors = structuredClone(f.vectors.vectors.mdenseon.docVectors);
      if (failure === 'order') rows.reverse();
      if (failure === 'text') rows[0].text += ' altered';
      if (failure === 'metadata') rows[0].metadata.extra = 'altered';
      if (failure === 'duplicate') rows.push(rows[0]);
      if (failure === 'removed') rows.pop();
      if (failure === 'vector-count') vectors.pop();
      expect(() => alignRetainedRelevanceDocuments(previous, rows, vectors)).toThrow('document population');
    }
  });
  it('refuses altered missing-index maps before calling either embedder', async () => {
    const f = retainedPreparedFixture(); expandSnapshot(f);
    const retained = (await loadRetainedRelevanceVectors(f.p, 'memory'))!;
    retained.missingDocumentIndexes.push(0);
    const noCalls = vi.fn(async () => []);
    await expect(embedIncrementalRelevanceDocuments(retained, retained.documentTexts, noCalls)).rejects.toThrow('missing-index identity');
    retained.missingIndexes.reverse();
    await expect(embedIncrementalRelevanceQueries(retained, retained.queryTexts, noCalls)).rejects.toThrow('missing-index identity');
    expect(noCalls).not.toHaveBeenCalled();
  });
  it.each(['opt-in', 'text', 'metadata', 'removed', 'order', 'seed', 'measurement-seed', 'date', 'format', 'invalid-option'])
    ('refuses expanded snapshot %s before vector embedding', async (failure) => {
      const f = retainedPreparedFixture(), { expanded, setSnapshot } = expandSnapshot(f);
      if (failure === 'opt-in') delete f.p.cell.parameters.reuseSnapshotExpansion;
      if (failure === 'invalid-option') f.p.cell.parameters.reuseSnapshotExpansion = 'true';
      if (failure === 'text') expanded.suites.memory.entries[0].text += ' changed';
      if (failure === 'metadata') expanded.suites.memory.entries[0].metadata.extra = 'changed';
      if (failure === 'removed') expanded.suites.memory.entries.pop();
      if (failure === 'order') expanded.suites.memory.entries.reverse();
      if (failure === 'seed') expanded.seed += ' changed';
      if (failure === 'measurement-seed') f.p.manifest.seed += ' changed';
      if (failure === 'date') expanded.snapshotAt = '2026-01-02T00:00:00.000Z';
      if (failure === 'format') expanded.formatVersion = 2;
      setSnapshot();
      await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow(/snapshot|expansion/);
    });
  it('binds distinct declared vector inputs for two cells of one shared manifest', async () => {
    const f = retainedPreparedFixture(), firstDonor = f.donor.cells.find((c) => c.bar === 'relevance')!;
    const secondDonor = { ...structuredClone(firstDonor), id: 'relevance-second', output: 'relevance-second' };
    f.donor.cells.push(secondDonor);
    const sharedManifest = f.pin('shared-donor-manifest', f.donor);
    f.raw.manifestSha256 = sharedManifest.sha256;
    f.completion.manifestSha256 = sharedManifest.sha256;
    f.completion.completed[0].raw = f.pin('shared-first-raw', f.raw);
    const secondVectors = structuredClone(f.vectors);
    secondVectors.vectors.mdenseon.docVectors = secondVectors.keys.map((_, i) => f.unit(i + 16));
    secondVectors.vectors.mdenseon.queryVectors = secondVectors.queryIds.map((_, i) => f.unit(i + 32));
    const secondVectorRef = f.pin('shared-second-vectors', secondVectors);
    f.completion.completed.push({ cellId: secondDonor.id,
      raw: f.pin('shared-second-raw', { ...f.raw, cellId: secondDonor.id }), vectors: secondVectorRef });
    f.p.manifest.inputs.reuseManifest = sharedManifest;
    f.p.manifest.inputs.reuseCompletion = f.pin('shared-completion', f.completion);
    f.p.manifest.inputs.reuseVectorsFirst = f.p.manifest.inputs.reuseVectors;
    f.p.manifest.inputs.reuseVectorsSecond = secondVectorRef;
    f.p.cell.inputIds.push('reuseVectorsFirst');
    f.p.cell.parameters.reuseVectorsInput = 'reuseVectorsFirst';
    const secondCell = structuredClone(f.p.cell);
    secondCell.id = secondDonor.id; secondCell.output = secondDonor.output;
    secondCell.parameters.reuseCellId = secondDonor.id;
    secondCell.parameters.reuseVectorsInput = 'reuseVectorsSecond';
    secondCell.inputIds = secondCell.inputIds.filter((id) => id !== 'reuseVectorsFirst');
    secondCell.inputIds.push('reuseVectorsSecond');
    f.p.manifest.cells.push(secondCell);
    const first = (await loadRetainedRelevanceVectors(f.p, 'memory'))!;
    const second = (await loadRetainedRelevanceVectors({ ...f.p, cell: secondCell }, 'memory'))!;
    expect(first.docVectors).toEqual(f.vectors.vectors.mdenseon.docVectors);
    expect(second.docVectors).toEqual(secondVectors.vectors.mdenseon.docVectors);
    expect(first.evidence.vectors).toEqual(f.p.manifest.inputs.reuseVectorsFirst);
    expect(second.evidence.vectors).toEqual(secondVectorRef);
    expect(first.queryVectors[0]).toEqual(f.unit(4));
    expect(second.queryVectors[0]).toEqual(f.unit(36));
    // A declared input is not permission to use another cell's completed vectors.
    secondCell.inputIds.push('reuseVectorsFirst');
    secondCell.parameters.reuseVectorsInput = 'reuseVectorsFirst';
    await expect(loadRetainedRelevanceVectors({ ...f.p, cell: secondCell }, 'memory'))
      .rejects.toThrow('completed receipt mismatch');
  });
  it.each([null, 0, false, {}, [], ''])('refuses invalid shared manifest vector selector %j', async (selector) => {
    const f = retainedPreparedFixture();
    // Adversarial decoded inputs deliberately exceed the well-typed parameter union.
    (f.p.cell.parameters as Record<string, unknown>).reuseVectorsInput = selector;
    await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow('invalid retained relevance vector input');
  });
  it.each(['undeclared', 'missing'])('refuses a shared manifest %s selected vector input', async (failure) => {
    const f = retainedPreparedFixture(); f.p.cell.parameters.reuseVectorsInput = 'cellVectors';
    if (failure === 'undeclared') f.p.manifest.inputs.cellVectors = f.p.manifest.inputs.reuseVectors;
    else f.p.cell.inputIds.push('cellVectors');
    await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow('inputs must be declared on the cell');
  });
  it('reuses exact completed document and query embeddings despite new labels/order, embedding only new queries', async () => {
    const f = retainedPreparedFixture(), retained = (await loadRetainedRelevanceVectors(f.p, 'memory'))!;
    expect(retained.docVectors).toEqual(f.vectors.vectors.mdenseon.docVectors);
    expect(retained.missingIndexes).toEqual([4, 5, 6, 7]);
    expect(retained.queryVectors[0]).toEqual(f.unit(4));
    expect(retained.queryVectors[8]).toEqual(f.unit(0));
    expect(retained.evidence).toMatchObject({ documentsReused: 3, timingComparableToFullInference: false });
    const embed = vi.fn(async () => [f.unit(12), f.unit(13), f.unit(14), f.unit(15)]);
    const complete = await embedIncrementalRelevanceQueries(retained, f.currentQueries.map((q) => q.query), embed);
    expect(embed).toHaveBeenCalledOnce();
    expect(embed).toHaveBeenCalledWith(f.currentQueries.slice(4, 8).map((q) => q.query));
    expect(complete).toHaveLength(12);
    expect(complete[0]).toEqual(f.unit(4));
    expect(complete[4]).toEqual(f.unit(12));
    expect(complete[11]).toEqual(f.unit(3));
    expect(retained.queryVectors[4]).toBeUndefined();
    await expect(embedIncrementalRelevanceQueries(retained, ['wrong'], embed)).rejects.toThrow('query population');
    await expect(embedIncrementalRelevanceQueries(retained, f.currentQueries.map((q) => q.query),
      async () => [f.unit(12)])).rejects.toThrow('new vector population');
    for (const bad of [[1], [Infinity, ...f.unit(0).slice(1)], [2, ...f.unit(0).slice(1)]]) {
      await expect(embedIncrementalRelevanceQueries(retained, f.currentQueries.map((q) => q.query),
        async () => [bad, f.unit(13), f.unit(14), f.unit(15)])).rejects.toThrow('dimensions/normalization');
    }
  });
  it('requires an explicit frozen reuse opt-in and each of the three declared inputs', async () => {
    const f = retainedPreparedFixture(); delete f.p.cell.parameters.reuseCellId;
    expect(await loadRetainedRelevanceVectors(f.p, 'memory')).toBeUndefined();
    f.p.cell.parameters.reuseCellId = 'relevance';
    f.p.cell.inputIds = f.p.cell.inputIds.filter((id) => id !== 'reuseVectors');
    await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow('declared on the cell');
  });
  it.each(['failed', 'duplicate', 'manifest', 'owner', 'vectors', 'time'])('refuses %s completion linkage', async (failure) => {
    const f = retainedPreparedFixture(), c: any = f.completion;
    if (failure === 'failed') c.status = 'failed';
    if (failure === 'duplicate') c.completed.push(c.completed[0]);
    if (failure === 'manifest') c.manifestSha256 = 'b'.repeat(64);
    if (failure === 'owner') c.ownerId = 'other-owner';
    if (failure === 'time') c.completedAt = '2026-01-05T00:00:00.000Z';
    if (failure === 'vectors') c.completed[0].vectors = { ...c.completed[0].vectors, sha256: 'b'.repeat(64) };
    f.p.manifest.inputs.reuseCompletion = f.pin('donor-completion', c);
    await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow('completed receipt');
  });
  it.each(['prompt', 'tokenizer', 'runtime', 'artifact', 'threads', 'dtype', 'corpus'])
    ('refuses %s arm identity substitution', async (failure) => {
      const f = retainedPreparedFixture();
      if (failure === 'prompt') f.p.arm.prompts.query += 'changed';
      if (failure === 'tokenizer') f.p.arm.tokenizer.version += 'changed';
      if (failure === 'runtime') f.p.arm.runtime.source.sha256 = 'b'.repeat(64);
      if (failure === 'artifact') f.p.arm.artifacts.graph.sha256 = 'b'.repeat(64);
      if (failure === 'threads') f.p.arm.execution.intraOpThreads++;
      if (failure === 'dtype') (f.p.arm.execution as any).dtype = 'fp16';
      await expect(loadRetainedRelevanceVectors(f.p, failure === 'corpus' ? 'prose' : 'memory'))
        .rejects.toThrow(/retained relevance.*(cell|mismatch)/);
    });
  it.each(['raw', 'vectors', 'donor-input'])('refuses unrepinned %s bytes', async (failure) => {
    const f = retainedPreparedFixture();
    const file = failure === 'raw' ? f.completion.completed[0].raw.path : failure === 'vectors'
      ? f.p.manifest.inputs.reuseVectors.path : f.donor.inputs.labels.path;
    fs.appendFileSync(file, ' ');
    await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow(/fingerprint mismatch|donor input changed/);
  });
  it.each(['width', 'count', 'order', 'nonfinite', 'norm', 'second-arm'])
    ('refuses repinned vector %s mismatch', async (failure) => {
      const f = retainedPreparedFixture(), v = f.vectors.vectors.mdenseon;
      if (failure === 'width') v.docVectors[0].pop();
      if (failure === 'count') v.queryVectors.pop();
      if (failure === 'order') f.vectors.queryIds.reverse();
      if (failure === 'nonfinite') v.docVectors[0][0] = Infinity;
      if (failure === 'norm') v.queryVectors[0][0] = 2;
      if (failure === 'second-arm') (f.vectors.vectors as any).gemma = v;
      const ref = f.pin('donor-vectors', f.vectors);
      f.p.manifest.inputs.reuseVectors = ref; f.completion.completed[0].vectors = ref;
      f.p.manifest.inputs.reuseCompletion = f.pin('donor-completion', f.completion);
      await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow('vector population/order/normalization');
    });
  it.each(['text', 'source', 'partition', 'class'])('refuses reused query %s changes before embedding', async (failure) => {
    const f = retainedPreparedFixture();
    if (failure === 'text') f.currentQueries[0].query += 'changed';
    if (failure === 'source') f.currentQueries[0].group = 'foreign-source';
    if (failure === 'partition') {
      for (const q of f.currentQueries.slice(0, 4)) q.partition = 'calibration' as const;
      // Keep two complete, non-leaking populations so the identity guard, not
      // the independent-cohort guard, is the refusal being tested.
      for (const q of f.currentQueries.slice(4)) q.partition = 'test' as const;
    }
    if (failure === 'class') [f.currentQueries[0].class, f.currentQueries[1].class] =
      [f.currentQueries[1].class, f.currentQueries[0].class];
    f.setCurrentQueries();
    await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow('query identity changed');
  });
  it('rejects changed snapshot bytes and raw model/version/time identities', async () => {
    const f = retainedPreparedFixture();
    f.p.manifest.inputs.snapshot = f.pin('changed-snapshot', { changed: true });
    await expect(loadRetainedRelevanceVectors(f.p, 'memory')).rejects.toThrow('snapshot changed');
    for (const change of [{ armId: 'gemma' }, { measuredAt: '2026-01-01T00:00:00.000Z' },
      { measuredAt: '2026-01-05T00:00:00.000Z' }, { report: { ...f.raw.report, goldSetVersion: 'changed' } }]) {
      const g = retainedPreparedFixture();
      g.completion.completed[0].raw = g.pin('donor-raw', { ...g.raw, ...change });
      g.p.manifest.inputs.reuseCompletion = g.pin('donor-completion', g.completion);
      await expect(loadRetainedRelevanceVectors(g.p, 'memory')).rejects.toThrow('raw identity');
    }
  });
  it('does not call the embedder when exact query reuse is complete', async () => {
    const f = retainedPreparedFixture(); f.setCurrentQueries(independentCohortFixture().queries);
    const retained = (await loadRetainedRelevanceVectors(f.p, 'memory'))!, embed = vi.fn(async () => []);
    const result = await embedIncrementalRelevanceQueries(retained, independentCohortFixture().queries.map((q) => q.query), embed);
    expect(result).toEqual(f.vectors.vectors.mdenseon.queryVectors);
    expect(embed).not.toHaveBeenCalled();
    expect(hashJson(retained.evidence.vectors)).toBe(hashJson(f.p.manifest.inputs.reuseVectors));
  });
});

describe('native CUDA profiler qualification', () => {
  const decodedCuda = { databaseIntegrity: 'ok', cudaApiRecords: 12, cudaKernelRecords: 36 };

  it('accepts a clean importer and decoded CUDA activity without treating API names as errors', () => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output: '0 errors; cudaGetLastError\nSaved report file' }, decodedCuda))
      .not.toThrow();
  });

  it('rejects a saved report from the observed failing CUDA event importer', () => {
    const output = 'Error {\n Type: RuntimeError\n Type: ProcessEventsError\n'
      + 'Unknown driver API function index: 752\nCannot find string for an exterior index\nSaved report file';
    expect(() => assertNativeProfilerQualification({ exitCode: 3, output }, decodedCuda)).toThrow('profiler import failed');
  });

  it.each([
    'Error {\n Type: RuntimeError',
    'Type: ProcessEventsError',
    'Unknown driver API function index: 752',
    'Cannot find string for an exterior index',
    '**** Errors occurred while processing the raw events. ****',
    'Import Failed: Qdstrm file does not have valid time conversion factors.',
    'Fatal error: invalid_command_line_syntax',
  ])('rejects partial decoding even when the importer exit code is zero: %s', (output) => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output }, decodedCuda)).toThrow('profiler import failed');
  });

  it('rejects the previous no-CUDA preflight despite SQLite integrity passing', () => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output: 'Saved report file' },
      { databaseIntegrity: 'ok', cudaApiRecords: 0, cudaKernelRecords: 0 })).toThrow('decoded CUDA activity');
  });

  it('rejects a damaged exported database', () => {
    expect(() => assertNativeProfilerQualification({ exitCode: 0, output: '' },
      { ...decodedCuda, databaseIntegrity: 'malformed database' })).toThrow('decoded CUDA activity');
  });

  it.each([0, -1, 0.5, NaN, Infinity])('requires measured positive integer API and kernel counts: %s', (count) => {
    for (const field of ['cudaApiRecords', 'cudaKernelRecords'] as const) {
      expect(() => assertNativeProfilerQualification({ exitCode: 0, output: '' },
        { ...decodedCuda, [field]: count })).toThrow('decoded CUDA activity');
    }
  });
});

describe('native profiler monotonic-clock launch attribution', () => {
  const origin = '9007199254740993000';
  const window = (runTag: string, start: bigint, end: bigint, nativeThreadId = 8) => ({
    runTag, processId: 7, nativeThreadId, startMonotonicNs: (BigInt(origin)+start).toString(), endMonotonicNs: (BigInt(origin)+end).toString() });
  const windows = [window('request-zero', 10n, 20n), window('request-one', 30n, 40n)];
  const launches = [{ processId: 7, nativeThreadId: 8, correlationId: 1, startNs: '11', endNs: '19' },
    { processId: 7, nativeThreadId: 8, correlationId: 2, startNs: '31', endNs: '39' }];
  const kernels = [{ kernelId: 'kernel-one', processId: 7, correlationId: 1 },
    { kernelId: 'kernel-two', processId: 7, correlationId: 2 }];
  it('joins launch APIs exactly above Number precision, independently of kernel completion order', () => {
    expect(bindNativeProfilerKernelRequests(origin, windows, launches, [...kernels].reverse())).toEqual([
      { kernelId: 'kernel-two', runTag: 'request-one' }, { kernelId: 'kernel-one', runTag: 'request-zero' }]);
  });
  it('allows several kernels per API and simultaneous requests on distinct OS threads', () => {
    const parallel = [windows[0], { ...windows[0], runTag: 'other-thread', nativeThreadId: 9 }];
    expect(bindNativeProfilerKernelRequests(origin, parallel, [launches[0], { ...launches[0], nativeThreadId: 9, correlationId: 3 }],
      [kernels[0], { ...kernels[0], kernelId: 'another-kernel' }, { ...kernels[0], kernelId: 'parallel-kernel', correlationId: 3 }])).toHaveLength(3);
  });
  it('rejects a wrong clock origin, API straddling a boundary and a different launching thread', () => {
    expect(() => bindNativeProfilerKernelRequests((BigInt(origin)+100n).toString(), windows, launches, kernels)).toThrow('unique monotonic');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], endNs: '21' }, launches[1]], kernels)).toThrow('unique monotonic');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches.map(x => ({ ...x, nativeThreadId: 9 })), kernels)).toThrow('unique monotonic');
  });
  it('rejects substituting the observed independent RAW clock for the profiler monotonic origin', () => {
    const rawClockOffset = 13559209703n;
    const rawWindows = windows.map(w => ({ ...w, startMonotonicNs: (BigInt(w.startMonotonicNs)-rawClockOffset).toString(),
      endMonotonicNs: (BigInt(w.endMonotonicNs)-rawClockOffset).toString() }));
    expect(() => bindNativeProfilerKernelRequests(origin, rawWindows, launches, kernels)).toThrow('unique monotonic');
  });
  it('rejects overlapping request windows and duplicate tags', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, [windows[0], window('overlap', 15n, 30n)], launches, kernels)).toThrow('overlapping');
    expect(() => bindNativeProfilerKernelRequests(origin, [windows[0], windows[0]], launches, kernels)).toThrow('request window');
  });
  it('rejects cross-process, missing and duplicate API correlations', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, [{ ...kernels[0], processId: 9 }])).toThrow('lacks launch');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches.slice(1), kernels)).toThrow('lacks launch');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [...launches, launches[0]], kernels)).toThrow('ambiguous');
  });
  it('rejects empty populations, unobserved request windows and duplicate kernel rows', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, [])).toThrow('population');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, kernels.slice(0,1))).toThrow('lacks compute');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, launches, [...kernels, kernels[0]])).toThrow('kernel identity');
  });
  it.each(['1.2', '-1', ' 1', '01', 'Infinity', ''])('rejects noncanonical nanoseconds: %s', (value) => {
    expect(() => bindNativeProfilerKernelRequests(value, windows, launches, kernels)).toThrow('nanoseconds');
    expect(() => bindNativeProfilerKernelRequests(origin, [{ ...windows[0], startMonotonicNs: value }], launches, kernels)).toThrow('nanoseconds');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], startNs: value }], kernels)).toThrow('nanoseconds');
  });
  it('rejects invalid process/correlation IDs and reversed intervals', () => {
    expect(() => bindNativeProfilerKernelRequests(origin, [{ ...windows[0], processId: 0 }], launches, kernels)).toThrow('request window');
    expect(() => bindNativeProfilerKernelRequests(origin, [window('reverse',20n,10n)], launches, kernels)).toThrow('request window');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], correlationId: 0 }], kernels)).toThrow('API correlation');
    expect(() => bindNativeProfilerKernelRequests(origin, windows, [{ ...launches[0], endNs: '10' }], kernels)).toThrow('API correlation');
  });
});
