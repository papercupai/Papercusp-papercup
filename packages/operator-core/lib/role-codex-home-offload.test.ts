import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  BoundedCodexHomeWorkerQueue,
  CodexHomeWorkerQueueFullError,
  type CodexHomeMaterializerJob,
  type CodexHomeWorkerLike,
} from './role-codex-home-offload';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const JOB: CodexHomeMaterializerJob = { operation: 'role-write', options: { sessionKey: 'fixture' } };

class FakeWorker extends EventEmitter implements CodexHomeWorkerLike {}

describe('bounded Codex-home worker queue', () => {
  it('caps active workers and queued requests, then continues after a completed job', async () => {
    const workers: FakeWorker[] = [];
    const queue = new BoundedCodexHomeWorkerQueue(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    }, 1, 1);

    const first = queue.enqueue<string>(JOB);
    const second = queue.enqueue<string>(JOB);
    await expect(queue.enqueue(JOB)).rejects.toBeInstanceOf(CodexHomeWorkerQueueFullError);
    expect(queue.activeCount).toBe(1);
    expect(queue.queuedCount).toBe(1);
    expect(workers).toHaveLength(1);

    workers[0]!.emit('message', { ok: true, value: 'first' });
    workers[0]!.emit('exit', 0);
    await expect(first).resolves.toBe('first');
    expect(workers).toHaveLength(2);

    workers[1]!.emit('message', { ok: false, error: { name: 'Error', message: 'worker failure' } });
    workers[1]!.emit('exit', 0);
    await expect(second).rejects.toThrow('worker failure');
    expect(queue.activeCount).toBe(0);
    expect(queue.queuedCount).toBe(0);
  });
});

describe('Codex-home worker materialization', () => {
  it('writes a role home through the worker entry and confines files to the configured roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-home-worker-'));
    const previousHome = process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
    const previousSqlite = process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR;
    process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = join(root, 'homes');
    process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR = join(root, 'sqlite');
    try {
      const { writeRoleCodexHomeAsync } = await import('./role-codex-home');
      const result = await writeRoleCodexHomeAsync({
        sessionKey: 'offload-fixture',
        mcpUrl: 'http://localhost:3170/api/mcp?role=worker&sig=fixture',
        promptText: 'Codex worker fixture',
        model: 'gpt-6.1-sol:xhigh',
      });
      expect(result.codexHome).toBe(join(root, 'homes', 'session-offload-fixture'));
      expect(existsSync(result.agentsPath)).toBe(true);
      expect(readFileSync(result.agentsPath, 'utf8')).toContain('Codex worker fixture');
      expect(result.configPath.startsWith(root)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.PAPERCUSP_SU_CODEX_HOMES_DIR;
      else process.env.PAPERCUSP_SU_CODEX_HOMES_DIR = previousHome;
      if (previousSqlite === undefined) delete process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR;
      else process.env.PAPERCUSP_CODEX_SQLITE_HOMES_DIR = previousSqlite;
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps both production role-home callers on the async worker API', () => {
    const bootstrapRole = readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/endpoint-route/routes/agent-mcp/bootstrap-role.ts'), 'utf8');
    const advSessions = readFileSync(join(REPO_ROOT, 'packages/operator-core/lib/endpoint-route/routes/adv/sessions.ts'), 'utf8');
    // A caller may await the worker API directly or through a timing wrapper
    // (`await measure('<span>', () => writeRoleCodexHomeAsync(...))`, added to
    // adv/sessions.ts by fdcd798b9c). Either way the awaited value is the async call.
    const awaitedAsyncWrite = /await\s+(?:measure\(\s*(['"`])[^'"`]+\1\s*,\s*\(\)\s*=>\s*)?writeRoleCodexHomeAsync\s*\(/;
    expect(bootstrapRole).toMatch(awaitedAsyncWrite);
    expect(advSessions).toMatch(awaitedAsyncWrite);
    expect(bootstrapRole).not.toMatch(/\bwriteRoleCodexHome\s*\(/);
    expect(advSessions).not.toMatch(/\bwriteRoleCodexHome\s*\(/);
  });

  it('keeps every async materializer on bounded worker dispatch', () => {
    const path = join(REPO_ROOT, 'packages/operator-core/lib/role-codex-home.ts');
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const wrappers = [
      { name: 'writeRoleCodexHomeAsync', syncImplementation: 'writeRoleCodexHome' },
      { name: 'writeSuCodexHomeAsync', syncImplementation: 'writeSuCodexHomeImpl' },
      { name: 'ensureSuCodexHomeConfigAsync', syncImplementation: 'ensureSuCodexHomeConfigImpl' },
    ];

    for (const { name, syncImplementation } of wrappers) {
      const declaration = source.statements.find((statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      expect(declaration, `${name} declaration`).toBeDefined();
      const calls: string[] = [];
      if (declaration?.body) {
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.push(node.expression.text);
          ts.forEachChild(node, visit);
        };
        visit(declaration.body);
      }
      expect(calls, `${name} worker dispatch`).toContain('runCodexHomeMaterializerJob');
      expect(calls, `${name} must not call its synchronous materializer on the host`).not.toContain(syncImplementation);
    }
  });
});
