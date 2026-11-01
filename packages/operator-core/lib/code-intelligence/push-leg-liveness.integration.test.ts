import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { LIVENESS_OPS, pgLivenessReaders } from './push-leg-liveness';
import { captureInterfaceEligibility } from './interface-eligibility';

const WS = `liveness-op-eligibility-${process.pid}`;
const START = Date.parse('2026-10-01T00:00:00Z');
const END = START + 86_400_000;
let db: OrgTestDb | undefined;

beforeAll(async () => {
  db = await createOrgTestDb();
  const sql = db.adminSql;
  for (const tool of LIVENESS_OPS) {
    const row = (status: string, owner = 'peer', result?: string, workspace = WS, at = START + 1000) => ({
      workspace_id: workspace, harness_slug: 'papercusp', plugin_name: 'papercusp',
      tool_name: tool, role: 'operator', spawn_id: 'liveness-fixture', window_key: 'fixture',
      status, coord_owner_id: owner, invoked_at: new Date(at),
      metadata_json: sql.json(result ? { codeIntelResult: { status: result } } : {}),
    });
    await sql`INSERT INTO harness_shared.tool_invocations ${sql([
      row('ok', 'peer', 'measured'), row('ok', 'implementer', 'measured'),
      row('ok', 'peer', 'unknown'), row('timeout'), row('error'), row('cancelled'),
      row('role-not-allowed'), row('role-not-allowed'), row('invalid-input'), row('invalid-input'),
      row('ok', 'system:code-intel-canary', 'measured'),
      row('ok', 'peer', 'measured', `${WS}-other`),
      row('ok', 'peer', 'measured', WS, START - 1), row('ok', 'peer', 'measured', WS, END),
      row('role-not-allowed', 'peer', undefined, `${WS}-denied-only`),
      row('invalid-input', 'peer', undefined, `${WS}-denied-only`),
    ])}`;
  }
  const observation = (beforeText: string | null, afterText: string) => captureInterfaceEligibility({
    file: 'target.ts', beforeText, afterText, capturedAt: new Date(START + 1000).toISOString(),
    peerEvidence: { status: 'unknown', peers: [] },
  });
  const row = (workspace: string, file: string, signal: unknown, at = START + 1000) => ({
    workspace_id: workspace, repo_root: '/clone-fixture', file, agent_id: 'peer',
    ts: new Date(at), signal_eligibility: sql.json({ interface: signal } as Parameters<typeof sql.json>[0]),
  });
  const added = observation('', 'export function added() {}\nexport const arrow = () => 1;');
  const unchanged = observation('export function old() {}', 'export function old(x = 1) {}');
  await sql`INSERT INTO harness_shared.edit_attribution_ledger ${sql([
    row(`${WS}-clone`, 'added.ts', added), row(`${WS}-clone`, 'old.ts', unchanged),
    row(`${WS}-clone`, 'README.md', {}),
    row(`${WS}-clone`, 'before.ts', added, START - 1), row(`${WS}-clone`, 'end.ts', added, END),
    row(`${WS}-clone-other`, 'other.ts', added),
    row(`${WS}-clone-partial`, 'known.ts', added), row(`${WS}-clone-partial`, 'legacy.ts', {}),
    row(`${WS}-clone-unknown`, 'unknown.ts', observation(null, 'export function added() {}')),
  ])}`;
}, 120_000);

afterAll(async () => { await db?.cleanup(); }, 30_000);

describe('op liveness eligibility (WI-6554700010030319, real invocation ledger)', () => {
  it.each(LIVENESS_OPS)('%s counts attempted failures but excludes pre-handler refusals', async op => {
    const readers = pgLivenessReaders(db!.adminSql as unknown as Parameters<typeof pgLivenessReaders>[0], ['implementer']);
    expect(await readers.measureOp(op, { workspaceId: WS, start: START, end: END })).toEqual({
      eligible: 6, outputs: 2, outsideLineageOutputs: 1,
    });
  });

  it('does not report eligible demand when every call was refused before the handler', async () => {
    const readers = pgLivenessReaders(db!.adminSql as unknown as Parameters<typeof pgLivenessReaders>[0], []);
    expect(await readers.measureOp('lsp:query', { workspaceId: `${WS}-denied-only`, start: START, end: END }))
      .toEqual({ eligible: 0, outputs: 0, outsideLineageOutputs: 0 });
  });
});

describe('clone liveness eligibility (independent edit journal, no push outputs)', () => {
  const measure = (suffix: string) => pgLivenessReaders(db!.adminSql as unknown as Parameters<typeof pgLivenessReaders>[0], [])
    .measureLeg('clone', { workspaceId: `${WS}-${suffix}`, start: START, end: END });

  it('counts edits adding exported functions once, independently of output or peer availability', async () => {
    expect(await measure('clone')).toMatchObject({ eligible: 1, outputs: 0, outsideLineageOutputs: 0 });
  });

  it.each(['clone-partial', 'clone-unknown'])('keeps %s eligibility unmeasured instead of treating missing observations as zero', async suffix => {
    expect(await measure(suffix)).toMatchObject({ eligible: null, outputs: 0 });
  });
});
