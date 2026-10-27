import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateRuntimeSourceCapture } from './runtime-source-capture.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const preload = fileURLToPath(new URL('./runtime-source-capture.mjs', import.meta.url));
function run(program: string, extraArgs: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-source-capture-')); roots.push(root);
  const output = path.join(root, 'sources.jsonl');
  const fixture = path.join(root, 'actual-input.cjs');
  const source = 'module.exports = "runtime-input-identity";\n';
  fs.writeFileSync(fixture, source);
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_RUNTIME_SOURCE_CAPTURE: output };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, ['--import', preload, ...extraArgs, '-e', program.replaceAll('FIXTURE', JSON.stringify(fixture))],
    { env, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
  expect(result.error, result.stderr).toBeUndefined();
  const rows = fs.readFileSync(output, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { result, rows, fixture, source, output };
}
describe('actual runtime parsed-source capture', () => {
  it('binds source bytes in main and a real worker that clears inherited flags', () => {
    const { result, rows, fixture, source, output } = run(`
      require(FIXTURE);
      const {Worker} = require('node:worker_threads');
      const worker = new Worker('require(' + JSON.stringify(FIXTURE) + ')', {eval:true,execArgv:[]});
      worker.on('error', error => { throw error; });
    `);
    expect(result.status, result.stderr).toBe(0);
    const receipt = validateRuntimeSourceCapture(rows);
    expect(receipt.workerIds).toHaveLength(1);
    expect(receipt.completeRuntimeClosureVerified).toBe(false);
    const expectedHash = crypto.createHash('sha256').update(source).digest('hex');
    const loaded = rows.filter(row => row.kind === 'source' && row.url.endsWith(fixture));
    expect(loaded.map(row => row.target).sort()).toEqual(['main', receipt.workerIds[0]].sort());
    expect(loaded.every(row => row.sha256 === expectedHash && row.bytes === Buffer.byteLength(source))).toBe(true);
    expect(fs.statSync(output).mode & 0o777).toBe(0o600);
    expect(() => validateRuntimeSourceCapture(rows, ['unobserved-worker'])).toThrow('expected worker');
    expect(() => validateRuntimeSourceCapture(rows.slice(0, -1))).toThrow('terminal');
    const omitted = rows.filter(row => row !== loaded[0]);
    expect(() => validateRuntimeSourceCapture(omitted)).toThrow('census');
  });

  it('retains forced exit as incomplete evidence when a worker has not terminated', () => {
    const { result, rows } = run(`
      const {Worker} = require('node:worker_threads');
      const worker = new Worker('require("node:worker_threads").parentPort.postMessage("ready");setInterval(()=>{},1000)',
        {eval:true,execArgv:[]});
      worker.on('message', () => process.exit(0));
    `);
    expect(result.status, result.stderr).toBe(0);
    expect(rows.at(-1).liveWorkers).toBeGreaterThan(0);
    expect(() => validateRuntimeSourceCapture(rows)).toThrow('worker census');
    expect(() => validateRuntimeSourceCapture(rows, [], {processId:rows[0].processId,exitCode:0,signal:null,eof:true})).toThrow('worker census');
  });

  it('closes the real Node ESM loader only with independent successful process termination', () => {
    const {result,rows} = run('require(FIXTURE)', ['--import','tsx']);
    expect(result.status,result.stderr).toBe(0);
    expect(rows.some(row=>row.kind==='worker-attached' && row.url==='node:internal/modules/esm/worker')).toBe(true);
    expect(() => validateRuntimeSourceCapture(rows)).toThrow('worker census');
    const proof={processId:rows[0].processId,exitCode:result.status!,signal:result.signal,eof:true as const};
    expect(validateRuntimeSourceCapture(rows,[],proof).workersClosedByProcessExit).toHaveLength(1);
    for (const bad of [{...proof,eof:false},{...proof,exitCode:1},{...proof,processId:1},{...proof,signal:'SIGTERM'}])
      expect(()=>validateRuntimeSourceCapture(rows,[],bad)).toThrow('worker census');
  });

  it('preserves target failures and refuses an existing receipt destination', () => {
    const { result, rows, output } = run('require(FIXTURE);throw new Error("retained target failure")');
    expect(result.status).not.toBe(0);
    expect(() => validateRuntimeSourceCapture(rows)).toThrow('failed');
    const before = fs.readFileSync(output);
    const env: NodeJS.ProcessEnv = { ...process.env, PAPERCUSP_RUNTIME_SOURCE_CAPTURE: output }; delete env.NODE_OPTIONS;
    const replay = spawnSync(process.execPath, ['--import', preload, '-e', ''], {env, encoding:'utf8', timeout:5000});
    expect(replay.status).not.toBe(0);
    expect(replay.stderr).toContain('EEXIST');
    expect(fs.readFileSync(output)).toEqual(before);
  });
});
