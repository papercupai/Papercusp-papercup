import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recordActivity } from '@papercusp/activity-bridge';
import { createPgTelemetryStore } from '../activity-pg-store';
import { sqlMiningFixture } from '../../test/_sql-mining-fixture';
import { canonicalNativeRuntimeSources, indexNativeCaptureCandidates } from './native-capture';
import { productionOpportunityReaders } from './source-readers';
import type { NativeProvider } from './native-operation';
import { runMonitoredCensus } from './census';

// Technical candidate-index regressions only. Positive index results below
// establish filesystem/PG pairing and cache behavior, NEVER production scope
// authority. D030 production boundaries are checked separately in this suite
// and native-capture-authority.integration.test.ts.

// Delay the real filesystem boundary, never supply a synthetic manifest. Only
// the final pass is delayed after the fixture has completed its source scans.
const metadataIO = vi.hoisted(() => ({ delayMs: 0, fastRoot: '', active: 0, peak: 0,
  barrier: null as (() => Promise<void>) | null, roots: [] as string[] }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, realpath: async (...args: Parameters<typeof actual.realpath>) => {
    if (!metadataIO.delayMs) return actual.realpath(...args);
    const path = String(args[0]);
    metadataIO.roots.push(path); metadataIO.active++;
    metadataIO.peak = Math.max(metadataIO.peak, metadataIO.active);
    try {
      await metadataIO.barrier?.();
      await new Promise(resolve => setTimeout(resolve, path === metadataIO.fastRoot ? 5 : metadataIO.delayMs));
      return await actual.realpath(...args);
    } finally { metadataIO.active--; }
  } };
});
afterEach(() => {
  metadataIO.barrier = null;
  expect(metadataIO.active).toBe(0);
  Object.assign(metadataIO, { delayMs: 0, fastRoot: '', peak: 0, roots: [] });
});

let f: Awaited<ReturnType<typeof sqlMiningFixture>>, root: string;
const envKeys = ['PAPERCUSP_SU_CODEX_HOMES_DIR', 'PAPERCUSP_SESSION_CLAUDE_DIR', 'PAPERCUSP_SU_OMP_HOMES_DIR'] as const;
let previous: (string | undefined)[];
const workspaceId = 'sql-mining-test', harnessSlug = 'mining-test', sourceBoundary = 'tool-ledger';
const options = () => ({ workspaceId, harnessSlug, sourceBoundary, client: f.db.adminSql,
  since: new Date(f.now - 1000).toISOString(), until: new Date(f.now).toISOString(), authorize: async () => true });
beforeAll(async () => {
  f = await sqlMiningFixture(); root = await mkdtemp(join(tmpdir(), 'native-capture-'));
  previous = envKeys.map(k => process.env[k]);
  envKeys.forEach((k, i) => { process.env[k] = join(root, String(i)); });
  const migration = new URL('../../../../libs/papercusp/libs/db/sql/1585-native-capture-reconciliation-receipt.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(migration) ? migration : new URL(migration.href + '.DRAFT'), 'utf8'));
  const runs = new URL('../../../../libs/papercusp/libs/db/sql/1583-sql-intent-monitored-family-runs.sql', import.meta.url);
  await f.db.adminSql.unsafe(readFileSync(existsSync(runs) ? runs : new URL(runs.href + '.DRAFT'), 'utf8'));
}, 120_000);
afterAll(async () => {
  envKeys.forEach((k, i) => { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; });
  await f?.cleanup(); if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await f.clear();
  await f.db.adminSql`DELETE FROM harness_shared.adv_sessions`;
  await f.db.adminSql`DELETE FROM harness_shared.agent_activity`;
  await f.db.adminSql`DELETE FROM harness_shared.session_briefs WHERE workspace_id=${workspaceId}`;
  for (const k of envKeys) await rm(process.env[k]!, { recursive: true, force: true });
});
/** Test-only historical install state; production has no floor override. */
async function installed() {
  // A candidate-enrollment turn may use its IO budget before saving a baseline.
  // Keep the same finite turn bound as candidate source scanning below.
  expect(await finishRuntimeBatches()).toBe('gap');
  await f.db.adminSql`UPDATE harness_shared.sql_intent_progress SET native_capture_from=${options().since}::timestamptz
    WHERE workspace_id=${workspaceId} AND scope_id LIKE 'native:%'`;
}
async function finishRuntimeBatches(opts = options()) {
  let status: 'complete' | 'gap' | 'unknown' = 'unknown';
  for (let attempt = 0; attempt < 40 && status === 'unknown'; attempt++) status = await indexNativeCaptureCandidates(opts);
  return status;
}
async function seed(provider: NativeProvider = 'codex', includeBrowser = false) {
  const owner = `su-${randomUUID()}`, current = randomUUID(), predecessor = randomUUID();
  const [adv] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id,first_seen_at)
    VALUES (${workspaceId},'console',${owner},${provider},${current},${new Date(f.now - 2000).toISOString()}::timestamptz) RETURNING id::text`;
  await f.db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id,workspace_id,harness_slug)
    VALUES (${owner},${workspaceId},${harnessSlug})`;
  const dir = provider === 'codex' ? join(process.env.PAPERCUSP_SU_CODEX_HOMES_DIR!, `session-${adv!.id}`, 'sessions', '2026', '10', '25')
    : provider === 'claude' ? join(process.env.PAPERCUSP_SESSION_CLAUDE_DIR!, owner, 'projects', 'repo')
      : join(process.env.PAPERCUSP_SU_OMP_HOMES_DIR!, `session-${adv!.id}`, 'agent', 'sessions', 'repo');
  await mkdir(dir, { recursive: true });
  const paths: string[] = [];
  for (const session of [predecessor, current]) {
    const timestamp = new Date(f.now - 100).toISOString();
    const header = provider === 'codex' ? { type: 'session_meta', payload: { id: session } }
      : provider === 'omp' ? { type: 'session', id: session } : { type: 'system', sessionId: session };
    const call = provider === 'codex' ? { type: 'response_item', timestamp,
      payload: { type: 'function_call', name: 'exec_command', call_id: `call-${session}`, arguments: '{"cmd":"rg private-source src"}' } }
      : provider === 'claude' ? { type: 'assistant', timestamp, sessionId: session,
        message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', id: `call-${session}`, input: { command: 'rg private-source src' } }] } }
        : { type: 'message', timestamp, message: { role: 'assistant', content: [
          { type: 'toolCall', name: 'bash', id: `call-${session}`, arguments: { command: 'rg private-source src' } }] } };
    const result = provider === 'codex' ? { type: 'response_item', timestamp,
      payload: { type: 'function_call_output', call_id: `call-${session}`, output: '{"exit_code":0}' } }
      : provider === 'claude' ? { type: 'user', timestamp, sessionId: session,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `call-${session}`, content: '{"exit_code":0}' }] } }
        : { type: 'message', timestamp, message: { role: 'toolResult', toolCallId: `call-${session}`,
          content: [{ type: 'text', text: '{"exit_code":0}' }] } };
    const path = join(dir, provider === 'codex' ? `rollout-time-${session}.jsonl` : provider === 'omp' ? `time_${session}.jsonl` : `${session}.jsonl`);
    const records: unknown[] = [header, call, result];
    if (includeBrowser) {
      const callId = `browser-${session}`, args = { action: 'click', selector: '#save' }, body = { ok: true };
      if (provider === 'codex') records.push(
        { type: 'response_item', timestamp, payload: { type: 'function_call', name: 'browser', call_id: callId, arguments: JSON.stringify(args) } },
        { type: 'response_item', timestamp, payload: { type: 'function_call_output', call_id: callId, output: JSON.stringify(body) } });
      else if (provider === 'claude') records.push(
        { type: 'assistant', timestamp, sessionId: session, message: { role: 'assistant', content: [{ type: 'tool_use', name: 'browser', id: callId, input: args }] } },
        { type: 'user', timestamp, sessionId: session, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: JSON.stringify(body) }] } });
      else records.push(
        { type: 'message', timestamp, message: { role: 'assistant', content: [{ type: 'toolCall', name: 'browser', id: callId, arguments: args }] } },
        { type: 'message', timestamp, message: { role: 'toolResult', toolCallId: callId, content: [{ type: 'text', text: JSON.stringify(body) }] } });
    }
    await writeFile(path, records.map(r => JSON.stringify(r)).join('\n') + '\n'); paths.push(path);
  }
  return { owner, current, predecessor, paths, advId: adv!.id, provider };
}

it('R13-NATIVE prospective production reader never backdates a new installation or accepts a future window', async () => {
  await seed();
  const reader = productionOpportunityReaders({ ...options(), authorize: async () => true });
  expect(await reader.readContinuity({ family: 'native-operation', since: options().since, until: options().until })).toBe('unknown');
  const [untouched] = await f.db.adminSql`SELECT count(*)::int AS count FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(untouched!.count).toBe(0);
  expect(await finishRuntimeBatches()).toBe('gap');
  expect(await indexNativeCaptureCandidates({ ...options(), until: new Date(Date.now() + 86400_000).toISOString() })).toBe('unknown');
  const [row] = await f.db.adminSql`SELECT native_capture_receipt, native_capture_from > ${options().until}::timestamptz AS prospective
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(row).toMatchObject({ native_capture_receipt: { baseline: true }, prospective: true });
});

it('R13-NATIVE reconciles real canonical carry sources for all providers without a hook or injected completeness callback', async () => {
  const seeds = [];
  for (const provider of ['codex', 'claude', 'omp'] as const) seeds.push(await seed(provider));
  await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  const rows = await f.db.adminSql`SELECT id::text,agent,owner_id,session_id,tool_use_id,summary,detail FROM harness_shared.agent_activity ORDER BY id`;
  expect(rows).toHaveLength(6);
  expect(rows.every(r => r.summary === 'Canonical native operation' && JSON.stringify(r.detail) === '{}')).toBe(true);
  const [receipt] = await f.db.adminSql`SELECT native_capture_receipt FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(receipt!.native_capture_receipt).toMatchObject({ version: 1, sources: 6, runtimes: 3, calls: 6 });
  expect(JSON.stringify(receipt)).not.toMatch(/private-source|session-|su-|jsonl/);
  const reader = productionOpportunityReaders({ ...options(), authorize: async () => true });
  for (const s of seeds) {
    const row = rows.find(r => r.session_id === s.predecessor)!;
    const hydrated = await reader.readTranscriptCandidate({ id: row.id, actor: s.owner, provider: s.provider,
      sessionId: s.predecessor, callId: row.tool_use_id });
    expect(hydrated?.sources[0]?.result?.body).toEqual({ exit_code: 0 });
  }
});

it.each(['codex', 'claude', 'omp'] as const)('R13-NATIVE accepts delayed original hook receipts for %s while preserving canonical event time', async provider => {
  const s = await seed(provider);
  const toolName = provider === 'codex' ? 'exec_command' : provider === 'claude' ? 'Bash' : 'bash';
  const store = createPgTelemetryStore(f.db.adminSql);
  const hook = await recordActivity(store, { workspaceId, scope: harnessSlug, owner: s.owner,
    agent: provider, sessionId: s.predecessor, toolName, phase: 'pre',
    toolUseId: `call-${s.predecessor}`, toolInput: { command: 'rg private-source src' } });
  const [before] = await f.db.adminSql`SELECT created_at FROM harness_shared.agent_activity WHERE id=${hook.id}`;
  expect(before!.created_at.getTime()).toBeGreaterThan(f.now);
  await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  const rows = await f.db.adminSql`SELECT id::text,created_at,summary FROM harness_shared.agent_activity
    WHERE owner_id=${s.owner} AND session_id=${s.predecessor} ORDER BY created_at`;
  // Receipt rows keep their ingestion timestamp; the canonical index must still
  // expose the event in its original window without re-dating the hook receipt.
  expect(rows.find(row => row.id === hook.id)?.created_at).toEqual(before!.created_at);
  expect(rows.filter(row => row.summary === 'Canonical native operation')).toHaveLength(1);
  expect(rows[0]!.created_at.getTime()).toBe(f.now - 100);
  const reader = productionOpportunityReaders({ ...options(), authorize: async () => true });
  const hydrated = await reader.readTranscriptCandidate({ id: rows[0]!.id, actor: s.owner, provider,
    sessionId: s.predecessor, callId: `call-${s.predecessor}` });
  expect(hydrated?.sources[0]?.result?.body).toEqual({ exit_code: 0 });
});

it('R13-NATIVE candidate index cannot make any native cell review-eligible without independent per-call authority', async () => {
  const seeds = [];
  for (const provider of ['codex', 'claude', 'omp'] as const) seeds.push(await seed(provider, true));
  await installed();
  expect(await finishRuntimeBatches()).toBe('complete');
  // Fixture-only older installation: the production census still uses its fixed
  // seven-day window, and no caller can pass a historical native receipt.
  await f.db.adminSql`UPDATE harness_shared.sql_intent_progress
    SET native_capture_from=${new Date(f.now - 7 * 86400_000).toISOString()}::timestamptz
    WHERE workspace_id=${workspaceId} AND scope_id LIKE 'native:%'`;
  const opts = f.opts({ rowBudget: 2, timeBudgetMs: 30_000 });
  const run = () => runMonitoredCensus(opts, async () => ({ status: 'UNKNOWN', stage: 'source', rows: 0 }));
  const measured = await run(), native = measured.families.find(row => row.family === 'native-operation')!;
  expect(native).toMatchObject({ coverage: 'UNKNOWN', diagnostics: {
    continuity: { before: 'unknown', after: 'unknown' }, reviewEligible: false } });
  const candidates = native.diagnostics.candidates as { id: string; reviewEligible: boolean }[];
  expect(candidates.every(candidate => !candidate.reviewEligible)).toBe(true);
  const [stored] = await f.db.adminSql`SELECT coverage,diagnostics FROM harness_shared.sql_intent_family_runs
    WHERE workspace_id=${workspaceId} AND run_id=${measured.runId}::uuid AND family='native-operation'`;
  expect(stored).toMatchObject({ coverage: 'UNKNOWN', diagnostics: { reviewEligible: false } });
  await rm(seeds[2]!.paths[0]!);
  expect((await run()).families.find(row => row.family === 'native-operation')).toMatchObject({
    coverage: 'UNKNOWN', diagnostics: { reviewEligible: false } });
});

it.each(['DELETE FROM harness_shared.agent_activity',
  "UPDATE harness_shared.agent_activity SET tool_name='rewritten'", 'TRUNCATE harness_shared.agent_activity'])(
  'R13-NATIVE invalidates the source receipt under replication-role loss: %s', async statement => {
  await seed(); await installed(); expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  await f.db.adminSql`SET session_replication_role=replica`;
  try { await f.db.adminSql.unsafe(statement); }
  finally { await f.db.adminSql`SET session_replication_role=origin`; }
  const [row] = await f.db.adminSql`SELECT native_capture_revision,native_capture_receipt FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(Number(row!.native_capture_revision)).toBeGreaterThan(0); expect(row!.native_capture_receipt).toBeNull();
  expect(await indexNativeCaptureCandidates(options())).not.toBe('complete');
});

it('R13-NATIVE detects absent detectors and a deleted or rebound runtime population', async () => {
  const s = await seed(); await installed(); expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  await f.db.adminSql`ALTER TABLE harness_shared.agent_activity DISABLE TRIGGER native_capture_index_delete`;
  try { expect(await indexNativeCaptureCandidates(options())).toBe('unknown'); }
  finally { await f.db.adminSql`ALTER TABLE harness_shared.agent_activity ENABLE ALWAYS TRIGGER native_capture_index_delete`; }
  await f.db.adminSql`UPDATE harness_shared.adv_sessions SET coord_owner_id='su-rebound' WHERE id=${s.advId}::bigint`;
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const [row] = await f.db.adminSql`SELECT native_capture_receipt FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(row!.native_capture_receipt).toBeNull();
});

it('R13-NATIVE refuses missing, truncated, malformed, symlinked and mismatched canonical sources', async () => {
  const s = await seed(); await installed();
  const path = s.paths[0]!, original = await readFile(path);
  for (const bytes of [original.subarray(0, original.length - 1), Buffer.from('not-json\n'),
    Buffer.from(original.toString().replace(s.predecessor, randomUUID()))]) {
    await writeFile(path, bytes); expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  }
  await rm(path); expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const outside = join(root, 'outside'); await writeFile(outside, original); await symlink(outside, path);
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
});

it('R13-NATIVE refuses ambiguous attribution, wrong same-ID index copies and revoked authorization', async () => {
  const s = await seed(); await installed();
  await f.db.adminSql`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,tool_use_id)
    VALUES (${workspaceId},${harnessSlug},${s.owner},'codex',${s.predecessor},'tool','wrong-tool',${`call-${s.predecessor}`})`;
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  expect(await indexNativeCaptureCandidates({ ...options(), authorize: async () => false })).toBe('unknown');
  await f.db.adminSql`DELETE FROM harness_shared.session_briefs WHERE owner_id=${s.owner}`;
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
});

it('R13-NATIVE refuses a conflicting hook tool even beside a matching canonical event row', async () => {
  const s = await seed(); await installed();
  await f.db.adminSql`INSERT INTO harness_shared.agent_activity
    (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,tool_use_id,created_at)
    VALUES (${workspaceId},${harnessSlug},${s.owner},'codex',${s.predecessor},'tool','exec_command',
      ${`call-${s.predecessor}`},${new Date(f.now - 100).toISOString()}::timestamptz)`;
  await recordActivity(createPgTelemetryStore(f.db.adminSql), { workspaceId, scope: harnessSlug,
    owner: s.owner, agent: 'codex', sessionId: s.predecessor,
    toolName: 'wrong-tool', phase: 'post', toolUseId: `call-${s.predecessor}` });
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const [receipt] = await f.db.adminSql`SELECT native_capture_receipt
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(receipt!.native_capture_receipt).toMatchObject({ baseline: true });
});

it('R13-NATIVE invalidates cached scans after a conflicting hook append without resetting the prospective floor', async () => {
  const s = await seed(); await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  const [before] = await f.db.adminSql`SELECT native_capture_from FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  await recordActivity(createPgTelemetryStore(f.db.adminSql), { workspaceId, scope: harnessSlug,
    owner: s.owner, agent: 'codex', sessionId: s.predecessor,
    toolName: 'wrong-tool', phase: 'post', toolUseId: `call-${s.predecessor}` });
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const [after] = await f.db.adminSql`SELECT native_capture_from,native_capture_receipt
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(after!.native_capture_from).toEqual(before!.native_capture_from);
  expect(after!.native_capture_receipt).toMatchObject({ reconciling: true });
});

it('R13-NATIVE refreshes valid hook appends and reuses its own canonical index without moving the floor', async () => {
  const s = await seed(); await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  const receipt = async () => (await f.db.adminSql`SELECT native_capture_from,native_capture_receipt
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!;
  const before = await receipt();
  await recordActivity(createPgTelemetryStore(f.db.adminSql), { workspaceId, scope: harnessSlug,
    owner: s.owner, agent: 'codex', sessionId: s.predecessor,
    toolName: 'exec_command', phase: 'post', toolUseId: `call-${s.predecessor}` });
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  const refreshed = await receipt();
  expect(refreshed.native_capture_from).toEqual(before.native_capture_from);
  expect(refreshed.native_capture_receipt.scans).not.toEqual(before.native_capture_receipt.scans);
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  expect(await receipt()).toEqual(refreshed);
  const [index] = await f.db.adminSql`SELECT count(*)::int AS count FROM harness_shared.agent_activity`;
  expect(index!.count).toBe(3); // Two event copies plus the original hook, no cache churn.
});

it('R13-NATIVE detects a late committed index row below the cached maximum ID', async () => {
  const s = await seed(); await installed();
  const held = await f.db.adminSql.reserve();
  try {
    await held`BEGIN`;
    const [hidden] = await held`INSERT INTO harness_shared.agent_activity
      (workspace_id,harness_slug,owner_id,agent,session_id,kind,tool_name,tool_use_id)
      VALUES (${workspaceId},${harnessSlug},${s.owner},'codex',${s.predecessor},'tool','wrong-tool',
        ${`call-${s.predecessor}`}) RETURNING id::text`;
    expect(await indexNativeCaptureCandidates(options())).toBe('complete');
    const [before] = await f.db.adminSql`SELECT count(*)::text AS count,max(id)::text AS maximum
      FROM harness_shared.agent_activity WHERE workspace_id=${workspaceId}`;
    expect(BigInt(hidden!.id)).toBeLessThan(BigInt(before!.maximum));
    await held`COMMIT`;
    const [after] = await f.db.adminSql`SELECT count(*)::text AS count,max(id)::text AS maximum
      FROM harness_shared.agent_activity WHERE workspace_id=${workspaceId}`;
    expect(after!.maximum).toBe(before!.maximum);
    expect(Number(after!.count)).toBe(Number(before!.count) + 1);
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  } finally {
    await held`ROLLBACK`;
    held.release();
  }
});

it('R13-NATIVE rechecks the cached index after final metadata validation', async () => {
  const s = await seed(); await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  metadataIO.delayMs = 1;
  metadataIO.barrier = () => barrier;
  const running = indexNativeCaptureCandidates(options());
  try {
    await vi.waitFor(() => expect(metadataIO.active).toBeGreaterThan(0));
    await recordActivity(createPgTelemetryStore(f.db.adminSql), { workspaceId, scope: harnessSlug,
      owner: s.owner, agent: 'codex', sessionId: s.predecessor,
      toolName: 'wrong-tool', phase: 'post', toolUseId: `call-${s.predecessor}` });
    metadataIO.barrier = null;
    release();
    expect(await running).toBe('unknown');
  } finally {
    metadataIO.barrier = null;
    release();
    await running;
  }
});

it('R13-NATIVE pages a roster above 500 and resumes prospective enrollment without certifying partial coverage', async () => {
  const seeds = [];
  for (let i = 0; i < 33; i++) seeds.push(await seed());
  // Other harnesses contribute to the authoritative roster, not this manifest.
  await f.db.adminSql`INSERT INTO harness_shared.session_briefs (owner_id,workspace_id,harness_slug)
    VALUES ('su-other-harness',${workspaceId},'another-harness')`;
  await f.db.adminSql`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id,first_seen_at)
    SELECT ${workspaceId},'console','su-other-harness','codex','other-' || n,
      ${new Date(f.now - 2000).toISOString()}::timestamptz FROM generate_series(1,501) n`;
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const read = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt,native_capture_from AS started
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!;
  const partial = await read();
  expect(partial.receipt).toMatchObject({ enrolling: true, cursor: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(Object.keys(partial.receipt.manifest)).toHaveLength(32);
  expect(await indexNativeCaptureCandidates({ ...options(), authorize: async () => false })).toBe('unknown');
  expect((await read()).receipt).toEqual(partial.receipt);
  // Ordinary new launches must not restart already completed batches.
  seeds.push(await seed());
  // A completed root may disappear while later batches enroll. Its identity
  // must survive in the baseline so the next reconciliation detects the loss.
  await rm(seeds[0]!.paths[0]!);
  expect(await indexNativeCaptureCandidates(options())).toBe('gap');
  const completed = await read();
  expect(completed.receipt).toMatchObject({ baseline: true, sources: 68 });
  expect(Object.keys(completed.receipt.manifest)).toHaveLength(34);
  expect(completed.started.getTime()).toBeGreaterThanOrEqual(partial.started.getTime());
  expect(JSON.stringify(completed.receipt)).not.toMatch(/private-source|session-|su-|jsonl/);
  await f.db.adminSql`UPDATE harness_shared.sql_intent_progress SET native_capture_from=${options().since}::timestamptz
    WHERE workspace_id=${workspaceId} AND scope_id LIKE 'native:%'`;
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
}, 120_000);

it('R13-NATIVE resumes bounded postbaseline scans across all providers and keeps partial coverage unknown', async () => {
  for (let i = 0; i < 33; i++) await seed((['codex', 'claude', 'omp'] as const)[i % 3]!, true);
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  await installed();
  const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!.receipt;
  // A bounded turn may exhaust its budget before earning a source scan. Wait
  // for durable progress, keeping the same finite bound as finishRuntimeBatches;
  // every pre-progress turn must still refuse complete coverage.
  let partial = await receipt();
  for (let attempt = 0; attempt < 40 && !Object.keys(partial.scans ?? {}).length; attempt++) {
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
    partial = await receipt();
  }
  expect(partial).toMatchObject({ reconciling: true });
  expect(Object.keys(partial.scans).length).toBeGreaterThan(0);
  expect(Object.keys(partial.scans).length).toBeLessThanOrEqual(32);
  expect(JSON.stringify(partial)).not.toMatch(/private-source|session-|su-|jsonl|exec_command|#save/);
  expect(await indexNativeCaptureCandidates({ ...options(), authorize: async () => false })).toBe('unknown');
  expect(await receipt()).toEqual(partial);
  expect(await finishRuntimeBatches()).toBe('complete');
  expect(await receipt()).toMatchObject({ runtimes: 33, sources: 66, calls: 132 });
  const rows = await f.db.adminSql`SELECT agent,count(*)::int AS calls FROM harness_shared.agent_activity GROUP BY agent`;
  expect(rows).toHaveLength(3);
  expect(rows.every(row => row.calls === 44)).toBe(true);
}, 120_000);

it('R13-NATIVE revalidates every cached root in bounded concurrent metadata waves under real filesystem delay', async () => {
  for (let i = 0; i < 40; i++) await seed((['codex', 'claude', 'omp'] as const)[i % 3]!);
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  await installed();
  expect(await finishRuntimeBatches()).toBe('complete');
  metadataIO.delayMs = 35; // Serial IO alone would exceed the unchanged 1s deadline.
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  expect(new Set(metadataIO.roots).size).toBe(40);
  expect(metadataIO.peak).toBe(32);
  const [row] = await f.db.adminSql`SELECT native_capture_receipt AS receipt
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(row!.receipt).toMatchObject({ runtimes: 40, sources: 80, calls: 80 });
}, 120_000);

it.each(['missing-root', 'deadline'] as const)(
  'R13-NATIVE drains final metadata waves and refuses cached completeness after %s', async failure => {
    const first = await seed();
    for (let i = 1; i < 40; i++) await seed();
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
    await installed();
    expect(await finishRuntimeBatches()).toBe('complete');
    const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt
      FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!.receipt;
    const before = await receipt();
    // The first root rejects before its siblings finish; every started read
    // must settle before returning, and no second wave may start after failure.
    metadataIO.delayMs = failure === 'deadline' ? 1100 : 50;
    if (failure === 'missing-root') {
      metadataIO.fastRoot = dirname(dirname(dirname(dirname(first.paths[0]!))));
      await rm(metadataIO.fastRoot, { recursive: true });
    }
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
    expect(metadataIO.active).toBe(0);
    expect(metadataIO.peak).toBe(32);
    expect(metadataIO.roots).toHaveLength(32);
    const after = await receipt();
    if (failure === 'deadline') expect(after).toEqual(before);
    else expect(after).toMatchObject({ reconciling: true });
  }, 120_000);

it.each(['rewrite', 'predecessor-loss'] as const)(
  'R13-NATIVE revalidates earlier runtime batches after %s', async change => {
    const first = await seed();
    for (let i = 1; i < 33; i++) await seed();
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
    await installed();
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
    const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt
      FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!.receipt;
    expect(Object.keys((await receipt()).scans).length).toBeGreaterThan(0);
    expect(Object.keys((await receipt()).scans).length).toBeLessThanOrEqual(32);
    if (change === 'predecessor-loss') await rm(first.paths[0]!);
    if (change === 'rewrite') await writeFile(first.paths[0]!,
      (await readFile(first.paths[0]!, 'utf8')).replace('private-source', 'changed-source'));
    const opts = options();
    expect(await indexNativeCaptureCandidates(opts)).toBe('unknown');
    expect(await receipt()).toMatchObject({ reconciling: true });
    if (change === 'predecessor-loss') {
      expect(await indexNativeCaptureCandidates(opts)).toBe('unknown');
    } else {
      expect(await finishRuntimeBatches(opts)).toBe('complete');
      expect(await receipt()).toMatchObject({ runtimes: 33, sources: 66, calls: 66 });
    }
  }, 120_000);

it('R13-NATIVE reuses source scans across advancing windows and new runtimes without retaining transcript content', async () => {
  const first = await seed();
  for (let i = 1; i < 33; i++) await seed();
  // This call is outside the first census window but must become eligible when
  // until advances, without reparsing an already completed source batch.
  const later = new Date(f.now + 50).toISOString();
  await writeFile(first.paths[0]!, (await readFile(first.paths[0]!, 'utf8')) + JSON.stringify({
    type: 'response_item', timestamp: later, payload: { type: 'function_call', name: 'exec_command',
      call_id: 'later-window-call', arguments: '{"cmd":"rg private-future src"}' },
  }) + '\n');
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!.receipt;
  const partial = await receipt();
  expect(Object.keys(partial.scans).length).toBeGreaterThan(0);
  expect(Object.keys(partial.scans).length).toBeLessThanOrEqual(32);
  await seed();
  const rolling = { ...options(), since: new Date(f.now - 50).toISOString(), until: new Date(f.now + 100).toISOString() };
  // A reset would need to parse 34 runtimes and could not complete in one batch.
  expect(await indexNativeCaptureCandidates(rolling)).toBe('complete');
  expect(await receipt()).toMatchObject({ runtimes: 34, sources: 68, calls: 1 });
  for (const [key, scan] of Object.entries(partial.scans)) expect((await receipt()).scans[key]).toEqual(scan);
  // A completed receipt retains the same evidence for both wider and narrower
  // windows. Index rows outside the original window were validated at parse time.
  expect(await indexNativeCaptureCandidates({ ...rolling, since: options().since })).toBe('complete');
  expect(await receipt()).toMatchObject({ calls: 69 });
  expect(await indexNativeCaptureCandidates({ ...rolling, since: new Date(f.now + 75).toISOString() })).toBe('complete');
  expect(await receipt()).toMatchObject({ calls: 0 });
  expect(JSON.stringify(await receipt())).not.toMatch(/private-source|private-future|session-|su-|jsonl|exec_command/);
  expect(await indexNativeCaptureCandidates({ ...rolling, authorize: async () => false })).toBe('unknown');
}, 120_000);

it('R13-NATIVE prepares known roots without treating unattributed runtimes as outside the harness', async () => {
  await seed();
  const [runtime] = await f.db.adminSql<{ id: string }[]>`INSERT INTO harness_shared.adv_sessions
    (workspace_id,mode,coord_owner_id,agent,session_id,first_seen_at)
    VALUES (${workspaceId},'console',${`su-${randomUUID()}`},'codex',${randomUUID()},
      ${new Date(f.now - 2000).toISOString()}::timestamptz) RETURNING id::text`;
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const read = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt FROM harness_shared.sql_intent_progress
    WHERE scope_id LIKE 'native:%'`)[0]!.receipt;
  const partial = await read();
  expect(partial).toMatchObject({ enrolling: true }); expect(Object.keys(partial.manifest)).toHaveLength(1);
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown'); expect(await read()).toEqual(partial);
  // Population loss invalidates the partial receipt just like a final one.
  await f.db.adminSql`DELETE FROM harness_shared.adv_sessions WHERE id=${runtime!.id}::bigint`;
  expect(await read()).toBeNull();
  expect(await indexNativeCaptureCandidates(options())).toBe('gap');
});

it.each(['codex', 'claude', 'omp'] as const)(
  'R13-NATIVE streams %s records across buffers while preserving distant result pairing and source line identities', async provider => {
    const s = await seed(provider);
    const path = s.paths[0]!, records = (await readFile(path, 'utf8')).trimEnd().split('\n');
    const padding = JSON.stringify({ type: 'metadata', note: 'multibyte-✓-🦉'.repeat(50) });
    await writeFile(path, [records[0], records[1], ...Array<string>(4500).fill(padding), records[2]].join('\n') + '\n');
    await installed();
    expect(await finishRuntimeBatches()).toBe('complete');
    const rows = await f.db.adminSql`SELECT id::text,session_id,tool_use_id FROM harness_shared.agent_activity`;
    expect(rows).toHaveLength(2);
    const row = rows.find(r => r.session_id === s.predecessor)!;
    const reader = productionOpportunityReaders({ ...options(), authorize: async () => true });
    const hydrated = await reader.readTranscriptCandidate({ id: row.id, actor: s.owner, provider,
      sessionId: s.predecessor, callId: row.tool_use_id });
    expect(hydrated?.sources).toHaveLength(1);
    expect(hydrated!.sources[0]).toMatchObject({ copyRef: `transcript:${provider}:${s.predecessor}:1`,
      result: { body: { exit_code: 0 }, complete: true } });
    // A trailing partial record remains unavailable after a successful stream.
    await writeFile(path, (await readFile(path)).subarray(0, (await readFile(path)).length - 1));
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  });

it.each(['codex', 'claude', 'omp'] as const)(
  'R13-NATIVE resumes %s source chunks across rolling windows using only opaque checkpoints', async provider => {
    const s = await seed(provider, true);
    const records = (await readFile(s.paths[0]!, 'utf8')).trimEnd().split('\n');
    const padding = JSON.stringify({ type: 'metadata', note: 'private-metadata-✓-🦉'.repeat(1800) });
    await writeFile(s.paths[0]!, [records[0], records[1], ...Array<string>(300).fill(padding), ...records.slice(2)].join('\n') + '\n');
    await installed();
    const receipt = async () => (await f.db.adminSql`SELECT native_capture_receipt AS receipt
      FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`)[0]!.receipt;
    expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
    const partial = await receipt();
    const offset = (r: typeof partial): number => Math.max(...Object.values(r.pendingSources as Record<string,
      { continuation: { files: Record<string, { offset: number }> } }>).flatMap(s => Object.values(s.continuation.files).map(f => f.offset)));
    const firstOffset = offset(partial);
    expect(firstOffset).toBeGreaterThan(0);
    expect(firstOffset).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(JSON.stringify(partial)).not.toMatch(/private-source|private-metadata|session-|su-|jsonl|exec_command|#save/);
    expect(await indexNativeCaptureCandidates({ ...options(), authorize: async () => false })).toBe('unknown');
    expect(await receipt()).toEqual(partial);
    const rolling = { ...options(), until: new Date(f.now + 100).toISOString() };
    expect(await indexNativeCaptureCandidates(rolling)).toBe('unknown');
    expect(offset(await receipt())).toBeGreaterThan(firstOffset);
    // Rewriting the same source invalidates offsets and already parsed call
    // digests, even if only metadata changes and the census window advances.
    await writeFile(s.paths[0]!, (await readFile(s.paths[0]!, 'utf8')).replace('private-metadata', 'changed-metadata'));
    expect(await indexNativeCaptureCandidates(rolling)).toBe('unknown');
    expect(offset(await receipt())).toBeLessThanOrEqual(firstOffset);
    expect(await finishRuntimeBatches(rolling)).toBe('complete');
    expect(await receipt()).toMatchObject({ sources: 2, runtimes: 1, calls: 4 });
    const rows = await f.db.adminSql`SELECT tool_use_id FROM harness_shared.agent_activity WHERE workspace_id=${workspaceId}`;
    expect(rows).toHaveLength(4);
    expect(JSON.stringify(await receipt())).not.toMatch(/private-source|private-metadata|changed-metadata|session-|su-|jsonl|exec_command|#save/);
  }, 120_000);

it('R13-NATIVE refuses a conflicting call split across durable source chunks', async () => {
  const s = await seed();
  const records = (await readFile(s.paths[0]!, 'utf8')).trimEnd().split('\n');
  const conflicting = JSON.parse(records[1]!);
  conflicting.payload.arguments = '{"cmd":"rg changed-copy src"}';
  const padding = JSON.stringify({ type: 'metadata', note: 'a'.repeat(32 * 1024) });
  await writeFile(s.paths[0]!, [records[0], records[1], ...Array<string>(200).fill(padding),
    JSON.stringify(conflicting), records[2]].join('\n') + '\n');
  await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  for (let attempt = 0; attempt < 3; attempt++) expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
  const [row] = await f.db.adminSql`SELECT native_capture_receipt AS receipt
    FROM harness_shared.sql_intent_progress WHERE scope_id LIKE 'native:%'`;
  expect(row!.receipt).toMatchObject({ reconciling: true });
  expect(row!.receipt.until).toBeUndefined();
}, 120_000);

it('R13-NATIVE enrolls large source identities prospectively and streams metadata without a whole-file allocation', async () => {
  const s = await seed();
  const records = (await readFile(s.paths[0]!, 'utf8')).trimEnd().split('\n');
  const padding = JSON.stringify({ type: 'metadata', note: 'a'.repeat(32 * 1024) });
  const large = [records[0], records[1], ...Array<string>(1025).fill(padding), records[2]].join('\n') + '\n';
  expect(Buffer.byteLength(large)).toBeGreaterThan(32 * 1024 * 1024);
  await writeFile(s.paths[0]!, large);
  // Baseline enrollment attests no content or historical interval.
  expect(await indexNativeCaptureCandidates(options())).toBe('gap');
  const [row] = await f.db.adminSql`SELECT native_capture_receipt AS receipt FROM harness_shared.sql_intent_progress
    WHERE workspace_id=${workspaceId} AND scope_id LIKE 'native:%'`;
  expect(row!.receipt).toMatchObject({ baseline: true, sources: 2 });
  expect(JSON.stringify(row)).not.toMatch(/private-source|session-|su-|jsonl/);
  // A direct source-read verifies the streaming mechanism independently of the
  // production one-second deadline, which is deliberately unchanged.
  const read = await canonicalNativeRuntimeSources({ id: s.advId, owner: s.owner, provider: s.provider, harness: harnessSlug },
    options(), Date.now() + 30_000);
  expect(read.sources).toHaveLength(2);
  expect(read.sources.every(source => source.result?.complete)).toBe(true);
  await expect(canonicalNativeRuntimeSources({ id: s.advId, owner: s.owner, provider: s.provider, harness: harnessSlug },
    options(), Date.now() - 1)).rejects.toThrow('native_capture_bound');
  // Malformed unrelated content cannot satisfy continuity, but does not force a
  // single-source hydration read to parse every historical transcript again.
  await writeFile(s.paths[1]!, 'not-json\n');
  const target = await canonicalNativeRuntimeSources({ id: s.advId, owner: s.owner, provider: s.provider, harness: harnessSlug },
    options(), Date.now() + 30_000, s.predecessor);
  expect(target.sources).toHaveLength(1);
  expect(await indexNativeCaptureCandidates(options())).toBe('unknown');
}, 120_000);

it('R13-NATIVE counts Codex discovery calls recognized by the maintained provider parser', async () => {
  const s = await seed(), timestamp = new Date(f.now - 100).toISOString();
  const records = (await readFile(s.paths[0]!, 'utf8')).trimEnd().split('\n');
  records.push(JSON.stringify({ type: 'response_item', timestamp,
    payload: { type: 'tool_search_call', call_id: 'discovery-call', query: 'find tool' } }),
  JSON.stringify({ type: 'response_item', timestamp,
    payload: { type: 'tool_search_output', call_id: 'discovery-call', tools: [{ name: 'exec_command' }] } }));
  await writeFile(s.paths[0]!, records.join('\n') + '\n');
  await installed();
  expect(await indexNativeCaptureCandidates(options())).toBe('complete');
  const rows = await f.db.adminSql`SELECT tool_use_id,tool_name FROM harness_shared.agent_activity
    WHERE workspace_id=${workspaceId} AND harness_slug=${harnessSlug}`;
  expect(rows).toHaveLength(3);
  expect(rows).toContainEqual({ tool_use_id: 'discovery-call', tool_name: 'tool_search_call' });
});
