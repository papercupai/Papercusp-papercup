import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerInvocationLane, type OrchestratorPg } from '../../../../libs/papercusp/packages/orchestrator/src/invoke';
import { harnessSlug } from '../../../../libs/papercusp/packages/orchestrator/src/state';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

let db: FreshPgDb;
const projectDir = '/tmp/orchestrator-child-lane-fixture';
const phase = 'staging';
const role = 'worker';
const workspaceId = 'fixture-workspace';
const laneSlug = () => harnessSlug(projectDir);
const context = (pg: OrchestratorPg = db.sql as unknown as OrchestratorPg) => ({
  projectDir, phase, workspaceId, pg, log: () => {},
});

beforeAll(async () => {
  db = await createFreshPgDb('child_lane_generation');
  await db.sql.unsafe(`CREATE TABLE harness_shared.harness_lanes (
    workspace_id text NOT NULL, harness_slug text NOT NULL, phase text NOT NULL,
    role text NOT NULL, feature_id text, pid integer, started_at bigint NOT NULL,
    PRIMARY KEY (harness_slug, phase, role)
  )`);
}, 90_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => { await db.sql`TRUNCATE harness_shared.harness_lanes`; });

async function rows() {
  return db.sql`SELECT workspace_id, pid, started_at FROM harness_shared.harness_lanes`;
}

describe('spawned child lane cleanup', () => {
  it.each(['pid', 'started_at', 'workspace_id'] as const)(
    'preserves a replacement differing only in %s while the insert reply is pending', async field => {
      let inserted!: () => void;
      let release!: () => void;
      const insertion = new Promise<void>(resolve => { inserted = resolve; });
      const reply = new Promise<void>(resolve => { release = resolve; });
      const pg = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const result = await (db.sql as unknown as OrchestratorPg)(strings, ...values);
        if (strings.join('').includes('INSERT INTO harness_shared.harness_lanes')) {
          inserted();
          await reply;
        }
        return result;
      }) as OrchestratorPg;
      const clear = registerInvocationLane(context(pg), role, 'F-old', 1234);
      let clearing: Promise<void> | undefined;
      let replacement: unknown;
      try {
        await insertion;
        if (field === 'pid') await db.sql`UPDATE harness_shared.harness_lanes SET pid=5678`;
        if (field === 'started_at') await db.sql`UPDATE harness_shared.harness_lanes SET started_at=started_at+1`;
        if (field === 'workspace_id') await db.sql`UPDATE harness_shared.harness_lanes SET workspace_id='replacement-workspace'`;
        replacement = await rows();
        clearing = clear();
      } finally { release(); }
      await clearing;
      expect(await rows()).toEqual(replacement);
    },
  );

  it('waits for its pending insert and removes its own unchanged lane', async () => {
    const clear = registerInvocationLane(context(), role, 'F-own', 1234);
    await clear();
    expect(await rows()).toEqual([]);
  });

  it('does not remove another lane when no child pid was assigned', async () => {
    await db.sql`INSERT INTO harness_shared.harness_lanes
      VALUES (${workspaceId}, ${laneSlug()}, ${phase}, ${role}, 'F-peer', 5678, 100)`;
    const before = await rows();
    await registerInvocationLane(context(), role, 'F-failed-spawn', undefined)();
    expect(await rows()).toEqual(before);
  });

  it('does not remove an existing lane after its registration failed', async () => {
    await db.sql`INSERT INTO harness_shared.harness_lanes
      VALUES (${workspaceId}, ${laneSlug()}, ${phase}, ${role}, 'F-peer', 5678, 100)`;
    const before = await rows();
    const pg = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('INSERT INTO harness_shared.harness_lanes')) throw new Error('fixture insert refused');
      return (db.sql as unknown as OrchestratorPg)(strings, ...values);
    }) as OrchestratorPg;
    await registerInvocationLane(context(pg), role, 'F-failed-insert', 1234)();
    expect(await rows()).toEqual(before);
  });
});
