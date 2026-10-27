import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import { bindRuntimeModelOpens, runtimeFileTraceArguments } from './runtime-file-opens.mjs';

const options = { processId: 10, assets: [{path:'/model/config.json'}, {path:'/model/model.onnx'}], beforeEpochMs: 2000 };
const lines = [
  '10 1.000000 execve("/usr/bin/node", ["node"], 0x1 /* 1 var */) = 0',
  '10 1.100000 clone(child_stack=NULL, flags=CLONE_VM|CLONE_THREAD) = 11',
  '11 1.200000 openat(AT_FDCWD, "/model/config.json", O_RDONLY|O_CLOEXEC) = 4</model/config.json>',
  '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY|O_CLOEXEC) = 5</model/model.onnx>',
  '11 2.200000 +++ exited with 0 +++', '10 2.300000 +++ exited with 0 +++',
];
describe('model opens from the actual traced runtime', () => {
  it.runIf(process.platform==='linux')('retains real exec, successful opens and terminal records with the launcher arguments', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'runtime-model-open-'));
    try {
      const file=path.join(root,'model-fixture.json'), trace=path.join(root,'trace.log');
      fs.writeFileSync(file,'{}');
      const env={...process.env}; delete env.NODE_OPTIONS;
      const child=spawnSync('/usr/bin/strace',runtimeFileTraceArguments(trace,[process.execPath,'-e',
        'require("node:fs").readFileSync('+JSON.stringify(file)+');process.stdout.write(String(process.pid));']),
        {env,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
      expect(child.status,child.stderr).toBe(0);
      expect(bindRuntimeModelOpens(fs.readFileSync(trace,'utf8'),
        {processId:Number(child.stdout),assets:[{path:file}],beforeEpochMs:Date.now()+1}).modelFilesOpenedBeforeInference).toBe(true);
    } finally {fs.rmSync(root,{recursive:true,force:true});}
  });

  it('joins the target task lineage and resolved successful opens before inference', () => {
    expect(bindRuntimeModelOpens(lines.join('\n'), options)).toMatchObject({
      tasks:[10,11], modelFilesOpenedBeforeInference:true, modelBytesReadVerified:false,
      opens:[{path:'/model/config.json',taskId:11},{path:'/model/model.onnx',taskId:11}],
    });
  });
  it('keeps annotated character-device descriptors outside the declared model population', () => {
    const captured=[...lines];
    captured.splice(3,0,'11 1.250000 openat(AT_FDCWD, "/dev/null", O_RDONLY|O_CLOEXEC) = 6</dev/null<char 1:3>>');
    expect(bindRuntimeModelOpens(captured.join('\n'),options).opens).toHaveLength(2);
  });
  it('reassembles interleaved unfinished/resumed syscalls', () => {
    const split = [...lines]; split.splice(3, 1,
      '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY|O_CLOEXEC <unfinished ...>',
      '10 1.350000 openat(AT_FDCWD, "/other", O_RDONLY) = -1 ENOENT (No such file or directory)',
      '11 1.400000 <... openat resumed>) = 5</model/model.onnx>');
    expect(bindRuntimeModelOpens(split.join('\n'), options).opens).toHaveLength(2);
  });
  it.each(['missing','failed','foreign','late','unresolved','truncated','no-exec','no-exit'])('refuses %s evidence', variant => {
    const altered = [...lines];
    if (variant === 'missing') altered.splice(3,1);
    if (variant === 'failed') altered[3] = '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY) = -1 ENOENT (No such file or directory)';
    if (variant === 'foreign') altered[3] = altered[3].replace(/^11/, '99');
    if (variant === 'late') altered[3] = altered[3].replace('1.300000', '2.100000');
    if (variant === 'unresolved') altered[3] = altered[3].replace('5</model/model.onnx>', '5');
    if (variant === 'truncated') altered[3] = '11 1.300000 openat(AT_FDCWD, "/model/model.onnx", O_RDONLY <unfinished ...>';
    if (variant === 'no-exec') altered.shift();
    if (variant === 'no-exit') altered.pop();
    expect(() => bindRuntimeModelOpens(altered.join('\n'), options)).toThrow();
  });
});
