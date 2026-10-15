import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '../../../..');
const managedPath = resolve(import.meta.dirname, 'admission-fix-precheck-managed.ts');
const managedSource = readFileSync(managedPath, 'utf8');
const payload = 'x'.repeat(256 * 1024);

function parse(path: string) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function entrySource(entry: 'bin' | 'hono' | 'serve'): string {
  if (entry === 'bin') return readFileSync(resolve(import.meta.dirname, 'admission-fix-precheck-worker-bin.ts'), 'utf8');
  const path = resolve(root, `apps/operator/bin/${entry === 'hono' ? 'hono-host' : 'serve'}.ts`);
  const source = parse(path);
  let branch: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && (entry === 'hono'
      ? node.expression.getText(source) === "sidecarMode === 'repair-precheck'"
      : node.expression.getText(source) === 'process.env.PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE === "1"')) branch = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!branch) throw new Error(`missing ${entry} finite-worker branch`);
  if (entry === 'serve') return `async function main() { ${branch.getText(source)} } void main();`;
  const workerImport = source.statements.find((node) => ts.isImportDeclaration(node)
    && node.moduleSpecifier.getText(source).includes('/release/admission-fix-precheck-managed'));
  if (!workerImport) throw new Error('missing Hono worker import');
  return `${workerImport.getText(source)}\nconst sidecarMode = 'repair-precheck';\n${branch.getText(source)}`;
}

function compile(source: string): string {
  return ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
  } }).outputText;
}

function childProgram(entry: 'bin' | 'hono' | 'serve', outcome: string): string {
  const source = ts.createSourceFile(managedPath, managedSource, ts.ScriptTarget.Latest, true);
  // Keep the actual entry branch and finite-worker functions. Replace only the task/queue
  // boundary: importing the whole host would start shared services from a unit fixture.
  const functions = source.statements.filter((node) => ts.isFunctionDeclaration(node)
    && ['runAdmissionPrecheckWorkerFromEnvironment', 'runAdmissionPrecheckWorkerMain'].includes(node.name?.text ?? ''));
  const dependencies = `
    const ADMISSION_PRECHECK_WORKER_INPUT_ENV = 'PAPERCUSP_REPAIR_PRECHECK_WORKER_INPUT';
    function parseAdmissionPrecheckWorkerInput() {
      if (${JSON.stringify(outcome)} === 'startup-error') throw new Error('startup marker');
      return ${JSON.stringify(outcome)} === 'invalid' ? null : { operationId: 'fixture' };
    }
    async function runAdmissionPrecheckWorker() {
      process.send({ kind: 'ready' });
      await new Promise(resolve => process.once('message', resolve));
      process.stdout.write('x'.repeat(256 * 1024));
      process.stderr.write('x'.repeat(256 * 1024));
      process.send({ kind: 'work-done' });
      if (${JSON.stringify(outcome)} === 'worker-error') throw new Error('worker marker');
      return { status: 'ignored', reason: 'fixture completed' };
    }
  `;
  return `
    // An unrelated referenced handle distinguishes explicit finite exit from exitCode-only.
    setInterval(() => {}, 1000);
    process.env.PAPERCUSP_REPAIR_PRECHECK_WORKER_MODE = '1';
    process.send({ kind: 'loaded' });
    const workerModule = {};
    (function(exports) { ${compile(dependencies + functions.map((node) => node.getText(source)).join('\n'))} })(workerModule);
    (function(require, exports) { ${compile(entrySource(entry))} })(() => workerModule, {});
  `;
}

async function runChild(entry: 'bin' | 'hono' | 'serve', outcome: string) {
  const child = spawn(process.execPath, ['-e', childProgram(entry, outcome)], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], detached: process.platform !== 'win32',
  });
  let stdout = '', stderr = '', awaitedWork = false;
  child.stdout!.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  let deadline: ReturnType<typeof setTimeout>;
  try {
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolveResult, reject) => {
      deadline = setTimeout(() => reject(new Error(`${entry}/${outcome} did not exit after completion`)), 10_000);
      child.on('error', reject);
      child.on('message', (message: { kind?: string }) => {
        if (message.kind === 'ready') {
          if (child.exitCode !== null || child.signalCode !== null) return reject(new Error('exited before awaited work'));
          child.send({ finish: true });
        }
        if (message.kind === 'work-done') {
          awaitedWork = true;
          clearTimeout(deadline);
          deadline = setTimeout(() => reject(new Error(`${entry}/${outcome} did not exit after completion`)), 2000);
        }
      });
      child.on('close', (code, signal) => resolveResult({ code, signal }));
    });
    return { ...result, stdout, stderr, awaitedWork };
  } finally {
    clearTimeout(deadline!);
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
      if (process.platform === 'win32') child.kill('SIGKILL');
      else process.kill(-child.pid!, 'SIGKILL');
      await closed;
    }
  }
}

describe.each(['bin', 'hono', 'serve'] as const)('%s finite admission worker entry', (entry) => {
  it.each(['success', 'worker-error'])('awaits %s and drains both pipes despite a live handle', async (outcome) => {
    const result = await runChild(entry, outcome);
    expect(result).toMatchObject({ code: outcome === 'success' ? 0 : 1, signal: null, awaitedWork: true });
    expect(result.stdout).toBe(payload);
    expect(result.stderr).toContain(payload);
    expect(result.stderr).toContain(outcome === 'success' ? 'fixture completed' : 'worker marker');
  });
  it.each(['invalid', 'startup-error'])('exits with the diagnostic for %s', async (outcome) => {
    const result = await runChild(entry, outcome);
    expect(result).toMatchObject({ code: outcome === 'invalid' ? 2 : 1, signal: null, awaitedWork: false });
    expect(result.stderr).toContain(outcome === 'invalid' ? 'worker input is missing or invalid' : 'startup marker');
  });
});
