import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function measureRoutineCost(routine: string) {
  // Refuse mismatched child/parent bytes before paying for a private database boot.
  for (const path of [
    'packages/operator-core/test/_rules-events-reuse-cost-child.ts',
    'packages/operator-core/test/_rules-events-reuse-cost.ts',
    'packages/operator-core/lib/harness/routines/rules-events-reuse-baseline.integration.test.ts',
  ]) {
    const committed = execFileSync('git', ['show', `HEAD:${path}`], { cwd: root });
    assert.ok(committed.equals(readFileSync(resolve(root, path))), `${path} must match its committed blob before measurement`);
  }
  const result = await new Promise<{ code: number | null; output: string }>((finish, reject) => {
    const child = spawn(process.execPath, ['scripts/with-test-pg.mjs', '--isolated-runtime', '--',
      process.execPath, '--import', 'tsx', 'packages/operator-core/test/_rules-events-reuse-cost-child.ts', routine],
    { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => { output += chunk; });
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), 300_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); finish({ code, output }); });
  });
  if (result.code !== 0 && process.env.RULES_EVENTS_BASELINE_OUTPUT_DIR) {
    const dir = resolve(process.env.RULES_EVENTS_BASELINE_OUTPUT_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${routine}-failure.log`), result.output);
  }
  assert.equal(result.code, 0, result.output.slice(-16_000));
  const line = result.output.split('\n').find(value => value.startsWith('RULES_EVENTS_COST_PROOF='));
  assert.ok(line, result.output.slice(-16_000));
  const proof = JSON.parse(line.slice('RULES_EVENTS_COST_PROOF='.length));
  assert.equal(existsSync(proof.runtimeRoot), false, 'the private runtime must be removed');
  const dataDir = /\(datadir ([^)]+)\)/.exec(result.output)?.[1];
  assert.ok(dataDir, 'the owned database directory must be identified');
  assert.equal(existsSync(dataDir), false, 'the private database must be removed');
  await new Promise<void>((finish, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: proof.pgPort });
    socket.once('connect', () => { socket.destroy(); reject(new Error('measurement PG still accepts connections')); });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') finish(); else reject(error);
    });
    socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error('PG teardown unverified')); });
  });
  proof.cleanup = { runtimeRemoved: true, databaseRemoved: true, postgresConnectionRefused: true };
  if (process.env.RULES_EVENTS_BASELINE_OUTPUT_DIR) {
    const dir = resolve(process.env.RULES_EVENTS_BASELINE_OUTPUT_DIR);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${routine}.json`), JSON.stringify(proof, null, 2) + '\n');
  }
  return proof;
}
