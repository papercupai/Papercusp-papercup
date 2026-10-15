/**
 * P-033 / R-30 + R-31 integration layer (native-code-intelligence-ecosystem-and-dream-2026-10-09).
 *
 * Drives the REAL reader (`readNativeAdoptionWindow`, the two-step tool_invocations read plus
 * the agent_activity shell/follow-through reads) against the fully migrated schema, then the
 * REAL scorecards resolver seam that turns the measurement into platform-computed instrument
 * snapshots for the R-30 (measured) and R-31 (good use) criteria.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import {
  NATIVE_ADOPTION_INSTRUMENT_KEYS,
  measureNativeAdoptionWindow,
  rateNativeAdoption,
  readNativeAdoptionWindow,
} from './native-adoption';
import { resolveScorecardInstrumentSnapshots } from '../scorecards';
import type { Rubric } from '../rubrics';

const WS = `test-native-adoption-${process.pid}`;
const OTHER_WS = `${WS}-other`;
const START = '2026-10-01T00:00:00.000Z';
const END = '2026-10-04T00:00:00.000Z';
const t = (iso: string) => new Date(iso);

let db: OrgTestDb | undefined;

async function seed(sql: OrgTestDb['adminSql']): Promise<void> {
  const invocation = (over: {
    workspace?: string; tool: string; owner: string; at: string; status?: string; errorCode?: string | null;
    role?: string; durationMs?: number | null;
  }) => ({
    workspace_id: over.workspace ?? WS, harness_slug: 'papercusp', plugin_name: 'papercusp',
    tool_name: over.tool, role: over.role ?? 'operator', spawn_id: `spawn-${over.owner}`, window_key: 'w',
    status: over.status ?? 'ok', error_code: over.errorCode ?? null, duration_ms: over.durationMs ?? null,
    invoked_at: t(over.at), coord_owner_id: over.owner,
  });
  const rows = [
    invocation({ tool: 'graph:query', owner: 'A', at: '2026-10-02T10:00:00.000Z', durationMs: 120 }),
    invocation({ tool: 'lsp:query', owner: 'A', at: '2026-10-02T11:00:00.000Z', durationMs: 80 }),
    invocation({ tool: 'lsp:query', owner: 'B', at: '2026-10-02T12:00:00.000Z', role: 'judge',
      status: 'role-not-allowed', errorCode: 'missing_capability' }),
    invocation({ tool: 'code:pack', owner: 'C', at: '2026-10-02T13:00:00.000Z', durationMs: 900 }),
    invocation({ tool: 'gitnexus.context', owner: 'D', at: '2026-10-02T14:00:00.000Z' }),
    invocation({ tool: 'coord:send', owner: 'A', at: '2026-10-02T15:00:00.000Z' }),
    // outside the window, and another workspace: both must be excluded.
    invocation({ tool: 'graph:query', owner: 'A', at: '2026-10-05T00:00:00.000Z' }),
    invocation({ workspace: OTHER_WS, tool: 'graph:query', owner: 'X', at: '2026-10-02T10:00:00.000Z' }),
  ];
  await sql`INSERT INTO harness_shared.tool_invocations ${sql(rows)}`;

  const activity = (over: { owner: string; tool: string; at: string; detail: Record<string, unknown>; workspace?: string }) => ({
    workspace_id: over.workspace ?? WS, owner_id: over.owner, kind: 'tool', tool_name: over.tool, phase: 'post',
    detail: sql.json(over.detail as never), created_at: t(over.at),
  });
  const acts = [
    // follow-through: A edits a file 5 min after graph:query; nothing after A's lsp:query; C reads after 30 min (too late).
    activity({ owner: 'A', tool: 'Edit', at: '2026-10-02T10:05:00.000Z', detail: { file: '/repo/a.ts' } }),
    activity({ owner: 'C', tool: 'Read', at: '2026-10-02T13:30:00.000Z', detail: { file: '/repo/c.ts' } }),
    // raw-text lookups
    activity({ owner: 'E', tool: 'Bash', at: '2026-10-02T09:00:00.000Z',
      detail: { command: 'grep -rn "export function rateNativeAdoption" packages/operator-core/lib' } }),
    activity({ owner: 'E', tool: 'mcp__papercusp-su__capability_bash', at: '2026-10-02T09:10:00.000Z',
      detail: { cmd: 'cd /repo || exit 1; rg -n "rateNativeAdoption(" packages' } }),
    activity({ owner: 'F', tool: 'Bash', at: '2026-10-02T09:20:00.000Z', detail: { command: 'grep -n ERROR /var/log/syslog' } }),
    activity({ owner: 'B', tool: 'Bash', at: '2026-10-02T09:30:00.000Z',
      detail: { command: "rg -n 'interface RubricCriterion' packages" } }),
    // pre-phase rows and other workspaces never count
    { ...activity({ owner: 'G', tool: 'Bash', at: '2026-10-02T09:40:00.000Z',
      detail: { command: 'grep -rn "class Foo" src' } }), phase: 'pre' },
    activity({ workspace: OTHER_WS, owner: 'H', tool: 'Bash', at: '2026-10-02T09:50:00.000Z',
      detail: { command: 'grep -rn "class Foo" src' } }),
  ];
  await sql`INSERT INTO harness_shared.agent_activity ${sql(acts)}`;
}

beforeAll(async () => {
  db = await createOrgTestDb();
  await seed(db.adminSql);
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
}, 30_000);

describe('readNativeAdoptionWindow (real ledgers)', () => {
  it('reads only in-window, in-workspace code-intelligence invocations, with the follow-through proxy', async () => {
    const read = await readNativeAdoptionWindow({ workspaceId: WS, windowStart: START, windowEnd: END }, db!.adminSql);
    const byTool = read.invocations.map((row) => `${row.toolName}:${row.ownerId}:${String(row.followedThrough)}`).sort();
    expect(byTool).toEqual([
      'code:pack:C:false',
      'gitnexus.context:D:null',
      'graph:query:A:true',
      'lsp:query:A:false',
      'lsp:query:B:null',
    ]);
  });

  it('returns post-phase, in-workspace shell commands for classification', async () => {
    const read = await readNativeAdoptionWindow({ workspaceId: WS, windowStart: START, windowEnd: END }, db!.adminSql);
    expect(read.shellCommands.map((row) => row.ownerId).sort()).toEqual(['B', 'E', 'E']);
  });

  it('refuses an invalid window instead of reading an unbounded range', async () => {
    await expect(readNativeAdoptionWindow({ workspaceId: WS, windowStart: END, windowEnd: START }, db!.adminSql))
      .rejects.toThrow(/valid/);
  });
});

describe('measureNativeAdoptionWindow → ratings (R-30 / R-31)', () => {
  it('summarizes adoption from the real ledgers', async () => {
    const metrics = await measureNativeAdoptionWindow({ workspaceId: WS, windowStart: START, windowEnd: END }, db!.adminSql);
    expect(metrics.native).toMatchObject({ calls: 4, ok: 3, refused: 1, refusalsByRole: { judge: 1 } });
    expect(metrics.native.followThrough).toEqual({ measuredCalls: 3, followed: 1, rate: 1 / 3 });
    expect(metrics.substitutes.gitnexusDirect.calls).toBe(1);
    expect(metrics.substitutes.rawTextLookups).toMatchObject({ definition: 2, callSite: 1, total: 3, distinctAgents: 2 });
    // lookup agents A,B,C,D,E; native OK agents A,C.
    expect(metrics.adoption).toMatchObject({ lookupAgents: 5, nativeAgents: 2, agentAdoptionRate: 0.4, lookups: 8 });
    expect(metrics.adoption.nativeCallShare).toBeCloseTo(3 / 7, 10);

    const target = {
      decisionRef: 'test#D-001', frozenAt: START, baselineWindow: { windowStart: START, windowEnd: END },
      baseline: { agentAdoptionRate: 0.1, nativeCallShare: 0.1, refusalRate: 0.5, lookups: 100 },
      minLookups: 5, minAgentAdoptionRate: 0.3, minNativeCallShare: 0.4, maxRefusalRate: 0.3,
    };
    expect(rateNativeAdoption(metrics, target).goodUse.verdict).toBe('pass');
    expect(rateNativeAdoption(metrics, { ...target, minAgentAdoptionRate: 0.6 }).goodUse.verdict).toBe('fail');
  });

  it('reports observability limits on every real-ledger measurement, including an empty window', async () => {
    for (const window of [
      { workspaceId: WS, windowStart: START, windowEnd: END },
      { workspaceId: `${WS}-no-activity`, windowStart: START, windowEnd: END },
    ]) {
      const metrics = await measureNativeAdoptionWindow(window, db!.adminSql);
      expect(metrics.cannotObserve.length).toBeGreaterThan(0);
      expect(metrics.cannotObserve).toEqual(expect.arrayContaining([
        expect.stringContaining('agent_activity'),
        expect.stringContaining('Follow-through'),
      ]));
    }
  });

  it('resolves platform-computed scorecard snapshots for both criteria through the real seam', async () => {
    const rubric = {
      ref: 'acceptance-native-adoption-test',
      workspaceId: WS,
      criteria: [
        { key: 'r-30', check: { kind: 'instrument', instrumentKey: NATIVE_ADOPTION_INSTRUMENT_KEYS.measured } },
        { key: 'r-31', check: { kind: 'instrument', instrumentKey: NATIVE_ADOPTION_INSTRUMENT_KEYS.goodUse } },
      ],
    } as unknown as Rubric;
    let reads = 0;
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject: { kind: 'plan', ref: 'native-plan', windowStart: START, windowEnd: END } as never },
      {
        now: () => Date.parse('2026-10-10T00:00:00.000Z'),
        nativeAdoption: async (window) => {
          reads += 1;
          return measureNativeAdoptionWindow(window, db!.adminSql);
        },
      },
    );
    expect(reads).toBe(1);
    const measured = snapshots?.[NATIVE_ADOPTION_INSTRUMENT_KEYS.measured];
    expect(measured).toMatchObject({ verdict: 'pass', provenance: 'platform-computed' });
    expect((measured?.value as { adoption: { lookups: number } }).adoption.lookups).toBe(8);
    // Rated against the frozen D-011 target: 8 lookups is below its sample floor → inconclusive, never pass.
    const goodUse = snapshots?.[NATIVE_ADOPTION_INSTRUMENT_KEYS.goodUse];
    expect(goodUse).toMatchObject({ verdict: 'unknown', provenance: 'platform-computed' });
    expect((goodUse?.value as { unknownReason?: string }).unknownReason).toBe('insufficient-sample');
  });

  it('rates unknown (not pass) when the subject window is still open', async () => {
    const rubric = {
      ref: 'acceptance-native-adoption-test', workspaceId: WS,
      criteria: [{ key: 'r-30', check: { kind: 'instrument', instrumentKey: NATIVE_ADOPTION_INSTRUMENT_KEYS.measured } }],
    } as unknown as Rubric;
    const snapshots = await resolveScorecardInstrumentSnapshots(
      { rubric, subject: { kind: 'plan', ref: 'native-plan', windowStart: START, windowEnd: END } as never },
      { now: () => Date.parse('2026-10-02T00:00:00.000Z'), nativeAdoption: async () => { throw new Error('must not read'); } },
    );
    expect(snapshots?.[NATIVE_ADOPTION_INSTRUMENT_KEYS.measured]?.verdict).toBe('unknown');
  });
});
