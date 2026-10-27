/** Inspect retained strace -f -ttt -yy output. Successful opens are evidence of
 * access, not proof of which bytes were read. Join with stable pre/post hashes.
 * Fail closed on unfinished or unsupported open records, never infer from a
 * filename appearing in an argv, a failed open, or another process's output. */
export function runtimeFileTraceArguments(output, command) {
  // -q suppresses attach chatter. -qq also suppresses the terminal records
  // that bindRuntimeModelOpens requires and therefore cannot qualify a run.
  return ['-f', '-q', '-ttt', '-yy', '-s', '4096', '-e',
    'trace=openat,openat2,mmap,execve,execveat,clone,clone3', '-o', output, ...command];
}

export function bindRuntimeModelOpens(text, { processId, assets, beforeEpochMs }) {
  if (!Number.isSafeInteger(processId) || processId <= 0 || !assets.length
    || !Number.isFinite(beforeEpochMs)) throw new Error('model-open population missing');
  const pending = new Map(), lines = [], edges = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const match = /^(\d+)\s+(\d+\.\d+)\s+(.*)$/.exec(line);
    if (!match) throw new Error('unsupported strace record');
    const tid = Number(match[1]), atMs = Number(match[2]) * 1000;
    let call = match[3];
    if (call.endsWith('<unfinished ...>')) {
      if (pending.has(tid)) throw new Error('duplicate unfinished strace record');
      pending.set(tid, { call: call.slice(0, -16), atMs }); continue;
    }
    if (call.startsWith('<... ')) {
      const resumed = /^<\.\.\. (\w+) resumed>(.*)$/.exec(call), start = pending.get(tid);
      if (!resumed || !start || !start.call.startsWith(resumed[1] + '('))
        throw new Error('unmatched resumed strace record');
      pending.delete(tid); call = start.call + resumed[2];
    }
    const clone = /^(?:clone|clone3)\(.*\)\s+=\s+(\d+)\b/.exec(call);
    if (clone) edges.push([tid, Number(clone[1])]);
    lines.push({ tid, atMs, call });
  }
  if (pending.size) throw new Error('incomplete strace capture');
  const descendants = new Set([processId]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [parent, child] of edges) if (descendants.has(parent) && !descendants.has(child)) {
      descendants.add(child); changed = true;
    }
  }
  const rootExec = lines.some(row => row.tid === processId && /^execve\(/.test(row.call) && /\)\s+=\s+0$/.test(row.call));
  const terminal = lines.some(row => row.tid === processId && row.call === '+++ exited with 0 +++');
  if (!rootExec || !terminal) throw new Error('model-open capture lacks target exec-to-exit evidence');
  const observed = [];
  for (const row of lines) {
    if (!descendants.has(row.tid) || row.atMs >= beforeEpochMs || !/^openat2?\(/.test(row.call)) continue;
    const result = /\)\s+=\s+(\d+)<([^<>]+)>$/.exec(row.call);
    if (!result) {
      if (/\)\s+=\s+-1\b/.test(row.call)) continue;
      // strace -yy annotates devices with nested brackets, e.g.
      // /dev/null<char 1:3>. They are outside this declared model population.
      if (assets.some(asset => row.call.includes(JSON.stringify(asset.path))))
        throw new Error('successful model-open record lacks resolved descriptor path');
      continue;
    }
    if (assets.some(asset => asset.path === result[2])) observed.push({ taskId: row.tid, atMs: row.atMs, path: result[2], fd: Number(result[1]) });
  }
  const missing = assets.filter(asset => !observed.some(row => row.path === asset.path));
  if (missing.length) throw new Error('model files lack successful opens before native inference: ' + missing.map(asset => asset.path).join(', '));
  return { processId, tasks: [...descendants], opens: observed,
    modelFilesOpenedBeforeInference: true, modelBytesReadVerified: false,
    scope: 'successful resolved descriptor opens of the declared model assets before first selected native Run' };
}
