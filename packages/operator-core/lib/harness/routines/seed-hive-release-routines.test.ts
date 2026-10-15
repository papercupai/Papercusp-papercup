/**
 * seed-hive-release-routines — per-hive green-gate seeding (per-hive-git-and-release-gate P-009).
 * Flag + resolver + sql are mocked; asserts the gating + the upsert/undo shape. No PG.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let flagOn: boolean;
let envResult: {
  enabled: boolean;
  reason?: string;
  env: Record<string, string>;
  hasDeploy: boolean;
  isOperatorHome: boolean;
};
let sqlCalls: Array<{ kind: 'insert' | 'delete' | 'other'; values: unknown[]; query: string }>;
let sqlResultRows: Array<{ name: string }>;

function classify(text: string): 'insert' | 'delete' | 'other' {
  if (/INSERT INTO/i.test(text)) return 'insert';
  if (/DELETE FROM/i.test(text)) return 'delete';
  return 'other';
}

// A fake tagged-template sql that records each call.
function fakeSql(): import('postgres').Sql {
  const fn = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join(' ? ');
    sqlCalls.push({ kind: classify(query), values, query });
    return Promise.resolve(sqlResultRows);
  }) as unknown as import('postgres').Sql;
  return fn;
}

beforeEach(() => {
  vi.resetModules();
  flagOn = true;
  envResult = { enabled: true, env: {}, hasDeploy: false, isOperatorHome: false };
  sqlCalls = [];
  sqlResultRows = [];
  vi.doMock('@papercusp/flags/server', () => ({ getFlag: async () => flagOn }));
  vi.doMock('@papercusp/flags', () => ({ FLAGS: { PER_POT_RELEASE_GATE: 'papercusp-per-hive-release-gate' } }));
  vi.doMock('./hive-release-env', () => ({ resolveHiveReleaseEnv: async () => envResult }));
});
afterEach(() => {
  vi.doUnmock('@papercusp/flags/server');
  vi.doUnmock('@papercusp/flags');
  vi.doUnmock('./hive-release-env');
});

async function seed(extra: { active?: boolean } = {}) {
  const { seedHiveReleaseRoutines } = await import('./seed-hive-release-routines');
  return seedHiveReleaseRoutines({ sql: fakeSql(), workspaceId: 'default', potSlug: 'oddsmith-hive', ...extra });
}

describe('seedHiveReleaseRoutines', () => {
  it('flag OFF → no-op (no sql), reason flag_off', async () => {
    flagOn = false;
    const res = await seed();
    expect(res.seeded).toBe(false);
    expect(res.reason).toBe('flag_off');
    expect(sqlCalls).toHaveLength(0);
  });

  it('operator-home → skipped (never double-seeds the live papercusp pipeline)', async () => {
    envResult = { enabled: true, env: {}, hasDeploy: false, isOperatorHome: true };
    const res = await seed();
    expect(res.seeded).toBe(false);
    expect(res.reason).toBe('operator_home');
    expect(sqlCalls).toHaveLength(0);
  });

  it('gate disabled / no repo → skipped with the resolver reason', async () => {
    envResult = { enabled: false, reason: 'no_repo', env: {}, hasDeploy: false, isOperatorHome: false };
    const res = await seed();
    expect(res.seeded).toBe(false);
    expect(res.reason).toBe('no_repo');
    expect(sqlCalls).toHaveLength(0);
  });

  it('coding hive, no deploy → seeds green-checkpoint only (active)', async () => {
    const res = await seed();
    expect(res.seeded).toBe(true);
    expect(res.routines).toEqual(['green-checkpoint']);
    const inserts = sqlCalls.filter((c) => c.kind === 'insert');
    expect(inserts).toHaveLength(1);
    // values: [id, potSlug, ws, name, cronJson, target, active]
    expect(inserts[0].values).toContain('oddsmith-hive');
    expect(inserts[0].values).toContain('green-checkpoint');
    expect(inserts[0].values).toContain('system:green-checkpoint');
    expect(inserts[0].values).toContain(true); // active
  });

  it('coding hive WITH deploy → seeds green-checkpoint + release-trigger', async () => {
    envResult = { enabled: true, env: {}, hasDeploy: true, isOperatorHome: false };
    const res = await seed();
    expect(res.routines).toEqual(['green-checkpoint', 'release-trigger']);
    expect(sqlCalls.filter((c) => c.kind === 'insert')).toHaveLength(2);
  });

  it('active:false lays the rows down inert', async () => {
    const res = await seed({ active: false });
    expect(res.seeded).toBe(true);
    const inserts = sqlCalls.filter((c) => c.kind === 'insert');
    expect(inserts[0].values).toContain(false); // active=false
  });

  it('undo deletes exactly the rows it seeded', async () => {
    const res = await seed();
    sqlCalls = []; // reset to observe only the undo
    await res.undo();
    const deletes = sqlCalls.filter((c) => c.kind === 'delete');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].values).toContain('oddsmith-hive');
  });

  it('teardown deletes only this workspace and pot release routines', async () => {
    sqlResultRows = [{ name: 'green-checkpoint' }, { name: 'release-trigger' }];
    const { teardownHiveReleaseRoutines } = await import('./seed-hive-release-routines');

    const result = await teardownHiveReleaseRoutines({
      sql: fakeSql(),
      workspaceId: 'workspace-a',
      potSlug: 'oddsmith-hive',
    });

    expect(result.deleted).toEqual(['green-checkpoint', 'release-trigger']);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].kind).toBe('delete');
    expect(sqlCalls[0].values).toEqual(['workspace-a', 'oddsmith-hive']);
    expect(sqlCalls[0].query).toMatch(
      /WHERE workspace_id =\s*\?\s+AND install_slug =\s*\?\s+AND name IN \('green-checkpoint', 'release-trigger'\)/i,
    );
  });
});
