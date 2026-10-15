/**
 * affected-tests-integration-only.test.ts — EI-24955492938994792 regression guard.
 *
 * Schema/migration edits must run every workspace's integration suite. The only door used to be
 * `npm run test:all:integration` (`--all --integration`), which ALSO queued every unit lane
 * (~118 tasks), so it competed for gate-sized admission and was projected to starve.
 * `--integration-only` queues exactly the `test:integration` tasks.
 *
 * Asserts BEHAVIOR via the real CLI's `--print-affected` probe (exits before running a suite).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import {
  EXECUTED_MAP_WORKSPACE_ENV,
  EXECUTED_MAP_RESULT_ENV,
  EXECUTED_MAP_OUT_ENV,
  EXECUTED_MAP_NO_PERSIST_ENV,
  executedMapRecordingEnabled,
  executedMapResultPath,
} from '../../../../scripts/lib/executed-source-map.mjs';
import { LANE_SCRIPTS } from '../../../../scripts/lib/targeted-task-reuse.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');

// Execute the production child-environment statements. No suites, admission or DB writes
// are needed to exercise the boundary that decides whether the real reporter is armed.
function captureEnvironment({
  workspace = '@probe/core', script = 'test:integration', env = {}, extraArgs = [],
  scriptOverride = null, journalLabel = 'initial', runToken = 'run-a',
}: {
  workspace?: string; script?: string; env?: NodeJS.ProcessEnv; extraArgs?: string[];
  scriptOverride?: string | null; journalLabel?: string; runToken?: string;
} = {}): NodeJS.ProcessEnv {
  const source = readFileSync(AFFECTED_TESTS, 'utf8');
  const ast = ts.createSourceFile('affected-tests.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const runner = ast.statements.find((n): n is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(n) && n.name?.text === 'runCapturedTask');
  expect(runner?.body).toBeDefined();
  const statements = runner!.body!.statements;
  const names = (n: ts.Statement): string[] => ts.isVariableStatement(n)
    ? n.declarationList.declarations.map(d => d.name.getText(ast)) : [];
  const start = statements.findIndex(n => names(n).includes('recordsExecutedMap'));
  const end = statements.findIndex(n => names(n).includes('childEnv'));
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const task = { ws: { name: workspace }, script };
  return { ...runInNewContext(
    `${source.slice(statements[start].getStart(ast), statements[end].end)}\nchildEnv;`,
    {
      process: { env }, spawnTask: { ...task, script: scriptOverride ?? script },
      context: { t: task }, allocation: { workers: 1 }, specEnv: {},
      relatedFilterList: null, reuseSkipList: null, extraArgs, scriptOverride, journalLabel,
      RUN_LOG_ROOT: '/tmp/capture', RUN_TOKEN: runToken, LANE_SCRIPTS,
      executedMapRecordingEnabled: () => executedMapRecordingEnabled(env), executedMapResultPath,
      EXECUTED_MAP_WORKSPACE_ENV, EXECUTED_MAP_RESULT_ENV, EXECUTED_MAP_OUT_ENV,
      EXECUTED_MAP_NO_PERSIST_ENV, TEST_REUSE_SKIP_LIST_ENV: 'PC_TEST_REUSE_SKIP_LIST',
      createHash, taskKey: (t: typeof task) => `${t.ws.name}::${t.script}`,
    },
  ) };
}

describe('integration executed-source capture (EI-25197689746466505)', () => {
  it('arms an integration task with its own source diagnostics and no-persist reporter', () => {
    const env = captureEnvironment();
    expect(env[EXECUTED_MAP_WORKSPACE_ENV]).toBe('@probe/core');
    expect(env[EXECUTED_MAP_RESULT_ENV]).toContain('/tmp/capture/executed-map-result-run-a-');
    expect(env[EXECUTED_MAP_OUT_ENV]).toMatch(/^\/tmp\/capture\/.*\.sources\.json$/);
    expect(env[EXECUTED_MAP_OUT_ENV]).not.toBe(env[EXECUTED_MAP_RESULT_ENV]);
    expect(env[EXECUTED_MAP_NO_PERSIST_ENV]).toBe('1');
  });

  it('keeps diagnostics distinct across workspaces, runs and retry file sets', () => {
    const scenarios = [
      {}, { workspace: '@probe/other' }, { runToken: 'run-b' },
      { extraArgs: ['a.integration.test.ts'], journalLabel: 'retry' },
      { extraArgs: ['b.integration.test.ts'], journalLabel: 'retry' },
    ];
    const outputs = scenarios.map(s => captureEnvironment(s)[EXECUTED_MAP_OUT_ENV]);
    expect(outputs.every(Boolean)).toBe(true);
    expect(new Set(outputs).size).toBe(scenarios.length);
    expect(captureEnvironment(scenarios[3])[EXECUTED_MAP_RESULT_ENV]).toBeUndefined();
  });

  it('replaces inherited integration output/workspace/result channels and forces no-persist', () => {
    const env = captureEnvironment({ env: {
      [EXECUTED_MAP_WORKSPACE_ENV]: '@outer/wrong', [EXECUTED_MAP_RESULT_ENV]: '/outer/result',
      [EXECUTED_MAP_OUT_ENV]: '/outer/shared.json', [EXECUTED_MAP_NO_PERSIST_ENV]: '0',
    } });
    expect(env[EXECUTED_MAP_WORKSPACE_ENV]).toBe('@probe/core');
    expect(env[EXECUTED_MAP_RESULT_ENV]).not.toBe('/outer/result');
    expect(env[EXECUTED_MAP_OUT_ENV]).not.toBe('/outer/shared.json');
    expect(env[EXECUTED_MAP_NO_PERSIST_ENV]).toBe('1');
  });

  it('retains integration diagnostics and no-persist when a fresh-file retry uses the unit script', () => {
    const retry = {
      scriptOverride: 'test', extraArgs: ['a.integration.test.ts'], journalLabel: 'retry',
      env: { [EXECUTED_MAP_OUT_ENV]: '/outer/shared.json', [EXECUTED_MAP_NO_PERSIST_ENV]: '0' },
    };
    const env = captureEnvironment(retry);
    expect(env[EXECUTED_MAP_WORKSPACE_ENV]).toBe('@probe/core');
    expect(env[EXECUTED_MAP_OUT_ENV]).toMatch(/^\/tmp\/capture\/.*\.sources\.json$/);
    expect(env[EXECUTED_MAP_OUT_ENV]).not.toBe('/outer/shared.json');
    expect(env[EXECUTED_MAP_NO_PERSIST_ENV]).toBe('1');
    expect(env[EXECUTED_MAP_RESULT_ENV]).toBeUndefined();
    expect(captureEnvironment({ ...retry, script: 'test' })[EXECUTED_MAP_OUT_ENV]).toBe('/outer/shared.json');
  });

  it('respects the recording opt-out even when capture channels were inherited', () => {
    const env = captureEnvironment({ env: {
      AFFECTED_RECORD_EXECUTED_SOURCES: '0',
      [EXECUTED_MAP_WORKSPACE_ENV]: '@outer/wrong', [EXECUTED_MAP_OUT_ENV]: '/outer/shared.json',
      [EXECUTED_MAP_RESULT_ENV]: '/outer/result',
    } });
    for (const key of [EXECUTED_MAP_WORKSPACE_ENV, EXECUTED_MAP_OUT_ENV, EXECUTED_MAP_RESULT_ENV]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it.each(['test', ...LANE_SCRIPTS])('preserves unit recorder and caller diagnostics for %s', script => {
    const env = captureEnvironment({ script, env: { [EXECUTED_MAP_OUT_ENV]: '/caller/unit.json' } });
    expect(env[EXECUTED_MAP_WORKSPACE_ENV]).toBe('@probe/core');
    expect(env[EXECUTED_MAP_RESULT_ENV]).toBeDefined();
    expect(env[EXECUTED_MAP_OUT_ENV]).toBe('/caller/unit.json');
    expect(env[EXECUTED_MAP_NO_PERSIST_ENV]).toBeUndefined();
  });

  it('does not arm a non-recording task through inherited channels', () => {
    const env = captureEnvironment({ script: 'lint:el-tools', env: {
      [EXECUTED_MAP_WORKSPACE_ENV]: '@outer/wrong', [EXECUTED_MAP_OUT_ENV]: '/outer/shared.json',
      [EXECUTED_MAP_RESULT_ENV]: '/outer/result',
    } });
    for (const key of [EXECUTED_MAP_WORKSPACE_ENV, EXECUTED_MAP_OUT_ENV, EXECUTED_MAP_RESULT_ENV]) {
      expect(env[key]).toBeUndefined();
    }
  });
});

function selectedCommands(args: string[]): string[] {
  const r = spawnSync('node', [AFFECTED_TESTS, ...args, '--print-affected'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  expect(r.status, `affected-tests ${args.join(' ')} --print-affected failed:\n${r.stderr}`).toBe(0);
  return (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('AFFECTED_WS_CMD\t'))
    .map((l) => l.slice('AFFECTED_WS_CMD\t'.length).trim());
}

describe('affected-tests --integration-only (EI-24955492938994792)', () => {
  it('queues exactly the test:integration tasks of the full --all --integration sweep, and nothing else', () => {
    const full = selectedCommands(['--all', '--integration']);
    const only = selectedCommands(['--all', '--integration-only']);

    const fullIntegration = full.filter((c) => /\btest:integration$/.test(c));
    // Positive control: the full sweep really contains unit tasks AND integration tasks, so
    // the narrowing below is measured against a population that could fail it.
    expect(fullIntegration.length).toBeGreaterThan(0);
    expect(full.length).toBeGreaterThan(fullIntegration.length);

    // No unit lane, no lint:el-tools: every selected command is an integration task.
    expect(only.filter((c) => !/\btest:integration$/.test(c))).toEqual([]);
    // And no integration task is dropped by the narrowing.
    expect([...only].sort()).toEqual([...fullIntegration].sort());
  });

  it('includes the db workspace, whose migrations motivate the schema verification door', () => {
    const only = selectedCommands(['--all', '--integration-only']);
    expect(only.some((c) => c.includes('libs/papercusp/libs/db') && c.endsWith('test:integration'))).toBe(true);
  });

  it('is wired as the root test:integration-only script', () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts?.['test:integration-only']).toMatch(/scripts\/affected-tests\.mjs --all --integration-only$/);
  });
});
