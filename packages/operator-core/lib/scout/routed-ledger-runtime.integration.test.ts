import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const sourcePaths = [
  'packages/operator-core/lib/scout/routed-ledger.ts',
  'packages/operator-core/lib/scout/tick-ledger.ts',
  'packages/operator-core/lib/scout/cycle-deps.ts',
];

describe('Scout lens rotation in the isolated background runtime', () => {
  it('advances a capped roster from real zero-route tick writes and removes private state afterward (EI-24926443593885283)', () => {
    // The child uses production imports and the real getOrgPg resolver. No
    // Vitest mocks or provider calls cross this runtime boundary.
    const probe = `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFileSync } from 'node:fs';
      import { getOrgPg } from '@papercusp/db-org';
      import { readLensRecency } from './packages/operator-core/lib/scout/routed-ledger.ts';
      import { recordScoutTick } from './packages/operator-core/lib/scout/tick-ledger.ts';
      import { rosterForBudget } from './packages/operator-core/lib/scout/cycle-deps.ts';

      const e = process.env;
      const ws = e.PAPERCUSP_WORKSPACE_ID;
      assert.ok(ws && ws.startsWith('test-runtime-'));
      assert.equal(e.PAPERCUSP_WORKSPACE, ws);
      assert.notEqual(e.HOME, e.TEST_LIVE_HOME);
      assert.equal(e.PAPERCUSP_BACKGROUND_WORKERS, '1');
      assert.equal(e.PAPERCUSP_DBOS_ROUTINES, '0');
      assert.equal(e.PAPERCUSP_DBOS_TIMERS, '0');
      for (const key of ['VITEST', 'VITEST_WORKER_ID', 'PAPERCUSP_SID',
        'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'PAPERCUSP_SUBSTRATE_IPC_SOCKET']) {
        assert.equal(e[key], undefined, key);
      }
      const registry = JSON.parse(readFileSync(e.PAPERCUSP_WORKSPACES_ROOT + '/registry.json', 'utf8'));
      assert.equal(registry.current, ws);
      const sourcePaths = [
        'packages/operator-core/lib/scout/routed-ledger.ts',
        'packages/operator-core/lib/scout/tick-ledger.ts',
        'packages/operator-core/lib/scout/cycle-deps.ts',
      ];
      const sources = Object.fromEntries(sourcePaths.map(path => [path,
        createHash('sha256').update(readFileSync(path)).digest('hex')]));
      const visited = [];
      const { sql } = getOrgPg();
      for (let cycle = 0; cycle < 4; cycle++) {
        const recency = await readLensRecency();
        const lens = rosterForBudget(1, undefined, recency).lenses[0];
        visited.push(lens);
        await recordScoutTick({
          workspaceId: ws, installSlug: '@singleton', potSlug: 'runtime-test-pot',
          status: 'ran', ideasGenerated: 0, ideasRouted: 0, budgetUsedUsd: 0,
          detail: { cycleId: 'runtime-zero-route-' + cycle, ideators: [{ lens, ok: true, raw: 0, produced: 0 }] },
        });
        assert.ok((await readLensRecency())[lens] > 0);
      }
      assert.deepEqual(visited, ['analogical', 'first-principles', 'reframing', 'constraint-removal']);
      const ticks = await sql.unsafe('SELECT count(*)::int AS n FROM harness_shared.scout_ticks WHERE workspace_id = $1', [ws]);
      const routes = await sql.unsafe('SELECT count(*)::int AS n FROM harness_shared.scout_routed_ideas WHERE workspace_id = $1', [ws]);
      assert.equal(ticks[0].n, 4);
      assert.equal(routes[0].n, 0);
      await sql.end({ timeout: 5 });
      const receipt = { home: e.HOME, workspacesRoot: e.PAPERCUSP_WORKSPACES_ROOT,
        workspace: ws, dbPort: new URL(e.HARNESS_ADMIN_DATABASE_URL).port,
        sources, visited, ticks: ticks[0].n, routes: routes[0].n };
      await new Promise(resolve => process.stdout.write('SCOUT_RUNTIME_PROBE ' + JSON.stringify(receipt) + '\\n', resolve));
      process.exit(0);
    `;
    const result = spawnSync(process.execPath, [
      resolve(root, 'scripts/with-test-pg.mjs'), '--isolated-runtime', '--',
      process.execPath, '--import', 'tsx', '--input-type=module', '-e', probe,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, TEST_LIVE_HOME: process.env.HOME ?? '' },
    });
    expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
    const payload = result.stdout.match(/^SCOUT_RUNTIME_PROBE (.+)$/m)?.[1];
    expect(payload).toBeTruthy();
    const receipt = JSON.parse(payload!);
    expect(receipt.sources).toEqual(Object.fromEntries(sourcePaths.map(path => [path,
      createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')])));
    expect(receipt.visited).toEqual(['analogical', 'first-principles', 'reframing', 'constraint-removal']);
    expect(receipt.ticks).toBe(4);
    expect(receipt.routes).toBe(0);
    expect(receipt.dbPort).not.toBe('5432');
    expect(existsSync(receipt.home)).toBe(false);
    expect(existsSync(receipt.workspacesRoot)).toBe(false);
    const dataDir = result.stdout.match(/datadir ([^)]+)\)/)?.[1];
    expect(dataDir).toBeTruthy();
    expect(existsSync(dataDir!)).toBe(false);
  }, 125_000);
});
