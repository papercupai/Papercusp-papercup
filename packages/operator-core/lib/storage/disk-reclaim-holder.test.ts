import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const worker = fileURLToPath(new URL('./disk-reclaim-holder-worker.py', import.meta.url));

describe.skipIf(process.platform !== 'linux')('kernel holder evidence admission', () => {
  it('requires both complete iterator footers, every read, and the positive original caller', () => {
    const output = execFileSync('python3', ['-c', `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('holder',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
good=dict(files=5,tasks=3,failures=0,fd_end=1,cwd_end=1,caller_seen=1)
cases=[good]+[{**good,key:value} for key,value in [('files',0),('tasks',0),('failures',1),('fd_end',0),('fd_end',2),('cwd_end',0),('cwd_end',2),('caller_seen',0)]]
print(json.dumps([module.complete_stats(module.Stats(**case)) for case in cases]))
`, worker], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual([true, false, false, false, false, false, false, false, false]);
  });

  it('refuses malformed requests before allocating kernel resources', () => {
    const requests = [null, {}, { path: '/tmp/a', caller: 0, control: '/' },
      { path: '/tmp/../a', caller: 1, control: '/' }, { path: '/tmp/a', caller: true, control: '/' },
      { path: '/tmp/a', caller: 1, control: '/', cached: true }];
    const output = execFileSync('python3', [worker], {
      input: requests.map(x => JSON.stringify(x)).join('\n') + '\n', encoding: 'utf8',
    });
    const results = output.trim().split('\n').map(line => JSON.parse(line));
    expect(results).toHaveLength(requests.length);
    expect(results.every(result => result.complete === false && result.byPath.length === 0)).toBe(true);
    expect(results.every(result => result.diagnostics.reason)).toBe(true);
  });

  it('rejects nested mount coverage, including escaped mount paths and malformed evidence', () => {
    const output = execFileSync('python3', ['-c', `
import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('holder',sys.argv[1])
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
def admitted(path,info):
 try: module.reject_nested_mounts(path,info);return True
 except ValueError: return False
print(json.dumps([admitted('/tmp/root',info) for info in [
 '1 0 8:1 / /tmp/root rw - ext4 /dev/a rw',
 '1 0 8:1 / /tmp/root-other/nested rw - ext4 /dev/a rw',
 '1 0 8:1 / /tmp/root/nested rw - ext4 /dev/a rw',
 r'1 0 8:1 / /tmp/root/a\\040b rw - ext4 /dev/a rw',
 'invalid']]))
`, worker], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual([true, true, false, false, false]);
  });
});
