/** P-004: real maintained servers + isolated capability PG, with homonyms in two projects. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const db = vi.hoisted(() => ({ sql: undefined as postgres.Sql | undefined, tasks: [] as string[] }));
vi.mock('@papercusp/db-org', async original => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => {
    if (!db.sql) throw new Error('isolated multilingual capability database is not initialized');
    return { sql: db.sql };
  },
}));
vi.mock('@papercusp/flags/server', async original => ({
  ...await original<typeof import('@papercusp/flags/server')>(), getFlag: async () => true,
}));
vi.mock('../task-manager/managed-spawn', async original => {
  const actual = await original<typeof import('../task-manager/managed-spawn')>();
  return { ...actual, managedSpawn: async (...args: Parameters<typeof actual.managedSpawn>) => {
    const result = await actual.managedSpawn(args[0], args[1], args[2], { ...args[3], workspaceId });
    // Own the handle BEFORE checking any postcondition: a failed assertion must
    // still leave afterAll able to reap the exact child and join its ledger write.
    db.tasks.push(result.taskId);
    const [row] = await db.sql!`SELECT workspace_id FROM harness_shared.task_ledger WHERE task_id = ${result.taskId}`;
    expect(row).toMatchObject({ workspace_id: workspaceId });
    return result;
  } };
});
import { LSP_LANGUAGES, resolveServerBin, shutdownAllLspClients, type LspLanguage } from './lsp-adapter';
import { lspDaemonFacade } from './lsp-daemon-facade';
import { killScopeUnit, killTask } from '../task-manager/control';
import { closeTask } from '../task-manager/store';
import { taskTerminalEventKey } from '../task-manager/task-terminal-events';

const eventEngine = await import('../events/await/engine');
const workspaceId = `test-lsp-multilingual-${process.pid}`;

let root: string;
let orgDb: OrgTestDb | undefined;
let previousAutoPump = true;
const layouts: Record<LspLanguage, { marker: string; config: string; declaration: string; source: string; consumer: string; use: string }> = {
  typescript: { marker: 'tsconfig.json', config: '{"compilerOptions":{"module":"commonjs"},"include":["*.ts"]}',
    declaration: 'target.ts', source: 'export function target() { return 1; }\n',
    consumer: 'consumer.ts', use: 'import { target } from "./target";\nexport function consume() { return target(); }\n// no symbol here\n' },
  rust: { marker: 'Cargo.toml', config: '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n[lib]\npath = "lib.rs"\n',
    declaration: 'lib.rs', source: 'pub fn target() -> i32 { 1 }\nmod consumer;\n',
    consumer: 'consumer.rs', use: 'use crate::target;\npub fn consume() -> i32 { target() }\n// no symbol here\n' },
  python: { marker: 'pyrightconfig.json', config: '{"include":["."]}',
    declaration: 'target.py', source: 'def target():\n    return 1\n',
    consumer: 'consumer.py', use: 'from target import target\ndef consume():\n    return target()\n# no symbol here\n' },
  go: { marker: 'go.mod', config: 'module example.com/fixture\n\ngo 1.26\n',
    declaration: 'target.go', source: 'package fixture\nfunc target() int { return 1 }\n',
    consumer: 'consumer.go', use: 'package fixture\nfunc consume() int { return target() }\n// no symbol here\n' },
};

beforeAll(async () => {
  for (const language of LSP_LANGUAGES)
    expect(resolveServerBin(language), `${language} pin must be provisioned; no acceptance skips`).not.toBeNull();
  root = mkdtempSync(join(tmpdir(), 'lsp-multilingual-pinned-'));
  orgDb = await createOrgTestDb();
  db.sql = orgDb.adminSql;
  previousAutoPump = eventEngine.setAutoPumpEnabledForTests(false);
  for (const language of LSP_LANGUAGES) for (const project of ['a', 'b']) {
    const layout = layouts[language]; const dir = join(root, language, project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, layout.marker), layout.config);
    writeFileSync(join(dir, layout.declaration), layout.source);
    writeFileSync(join(dir, layout.consumer), layout.use);
  }
}, 120_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try { await shutdownAllLspClients(); } catch (error) { errors.push(error); }
  for (const taskId of db.tasks) {
    try {
    const outcome = await killTask(taskId, { includeSubtree: true, reapTerminalResidue: true, escalateAfterMs: 500 });
    if (!outcome.ok && outcome.error === 'not_live') {
      // not_live also covers unsafe/unconfined residue. Independently verify
      // this exact owned scope instead of treating the error itself as success.
      const [row] = await db.sql!`SELECT workspace_id, scope_unit FROM harness_shared.task_ledger WHERE task_id = ${taskId}`;
      expect(row?.workspace_id).toBe(workspaceId);
      if (!row?.scope_unit) throw new Error('multilingual fixture cannot verify an unconfined terminal task');
      const scope = await killScopeUnit(row.scope_unit, { escalateAfterMs: 500 });
      if (!scope.ok && scope.error !== 'already_gone') throw new Error(`multilingual fixture scope cleanup refused: ${scope.error}`);
    } else if (!outcome.ok && outcome.error !== 'already_gone') {
      throw new Error(`multilingual fixture cleanup refused: ${outcome.error}`);
    } else if (!outcome.ok) {
      await closeTask(taskId, { state: 'stranded', exitReason: 'fixture verified process gone at teardown' });
    }
    // expect.poll requires an active test; vi.waitFor is valid in suite hooks.
    await vi.waitFor(async () => {
      const [row] = await db.sql!`
        SELECT task.workspace_id, task.ended_at IS NOT NULL AS ended,
               fire.last_payload->>'taskId' AS emitted_task,
               fire.last_payload->>'state' = task.state AS matching_state
          FROM harness_shared.task_ledger task
          LEFT JOIN harness_shared.event_key_fires fire ON fire.event_key = ${taskTerminalEventKey(taskId)}
         WHERE task.task_id = ${taskId}`;
      expect(row).toMatchObject({ workspace_id: workspaceId, ended: true, emitted_task: taskId, matching_state: true });
    }, { timeout: 5_000, interval: 20 });
    } catch (error) { errors.push(error); }
  }
  eventEngine.setAutoPumpEnabledForTests(previousAutoPump);
  await orgDb?.cleanup();
  db.sql = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, 'multilingual fixture task cleanup failed');
}, 30_000);

describe('P-004 configured native compiler adapters', () => {
  it.each(LSP_LANGUAGES)('%s resolves to its own declaration, despite a homonym in another project', async language => {
    const layout = layouts[language];
    const lines = layout.use.trimEnd().split('\n');
    const line1 = lines.findIndex(line => line.includes('target()')) + 1;
    const character = lines[line1 - 1]!.indexOf('target()');
    for (const project of ['a', 'b']) {
      const file = join(root, language, project, layout.consumer);
      const answer = await lspDaemonFacade('symbol', { file, rootPath: root, line1, character });
      expect(answer.error, `${language}/${project}: ${answer.error}`).toBeNull();
      expect(answer.sites.map(site => site.path)).toContain(`${language}/${project}/${layout.declaration}`);
      expect(answer.sites.some(site => site.path.startsWith(`${language}/${project === 'a' ? 'b' : 'a'}/`))).toBe(false);
      expect(answer.evidence?.languageCapabilities).toContainEqual({ language, intent: 'definition', status: 'compiler-backed' });
      expect(answer.evidence?.graphScope.sourceCompleteness).toBe('unverified');
    }
  }, 90_000);

  it.each(['python', 'go'] as const)('%s refuses an uncertified empty after a successful definition', async language => {
    const layout = layouts[language]; const file = join(root, language, 'a', layout.consumer);
    const lines = layout.use.trimEnd().split('\n');
    const useLine = lines.findIndex(line => line.includes('target()')) + 1;
    const warm = await lspDaemonFacade('symbol', { file, rootPath: root, line1: useLine, character: lines[useLine - 1]!.indexOf('target()') });
    expect(warm.error).toBeNull();
    expect(warm.sites.map(site => site.path)).toContain(`${language}/a/${layout.declaration}`);
    const line1 = layout.use.trimEnd().split('\n').length;
    const answer = await lspDaemonFacade('symbol', { file, rootPath: root, line1, character: 0 });
    expect(answer.sites).toEqual([]);
    expect(answer.freshness.health).not.toBe('healthy');
    expect(answer.error).toMatch(/readiness is not certified/);
  }, 30_000);
});
