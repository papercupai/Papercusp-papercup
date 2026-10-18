/**
 * Interactive-usage ingestion writes session_id — the loop cost-cap attribution fix
 * (loop-wake-rate-limit-robustness-2026-06-23 P3), proven against a REAL migrated Postgres.
 *
 * THE BUG: the interactive ingestion wrote the native session UUID (the transcript filename)
 * into `agent_usage_samples.run_id` and left `session_id` NULL. But `loop-cost-cap.ts`
 * `readLoopSpendCents` attributes a warm-session loop's spend via
 *   owner → adv_sessions.session_id → agent_usage_samples.session_id → SUM(cost_usd)
 * so it always found 0 and the cost-cap never bound an interactive loop. The native UUID IS
 * the session id (it equals adv_sessions.session_id), so populating `session_id` makes the
 * existing join work — no schema change. This test pins that session_id is now written.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *        lib/interactive-usage/ingest-claude-transcripts.session-attribution.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Sql } from 'postgres';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { parseCodexChunk } from './ingest-adapters';

const WS = 'ws-interactive-ingest-p3';

// getOrgPg() → the testcontainer sql; activeWorkspaceId() → our fixed workspace.
const h = vi.hoisted(() => ({ sql: undefined as unknown }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../workspace-registry')>('../workspace-registry');
  return { ...actual, activeWorkspaceId: () => WS };
});

const { ingestInteractiveUsage, parseTranscriptChunk, reconcileTranscriptAccounts } = await import('./ingest-claude-transcripts');

let org: OrgTestDb;
let sql: Sql;
const tmpDirs: string[] = [];

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  h.sql = sql;
  await sql.unsafe(await fs.readFile(new URL('../../../../libs/papercusp/libs/db/sql/1533-gateway-response-usage-attribution.sql', import.meta.url), 'utf8'));
});
afterAll(async () => {
  await org?.cleanup();
  for (const d of tmpDirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
});
beforeEach(async () => {
  await sql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.interactive_usage_files WHERE workspace_id = ${WS}`;
  await sql`DELETE FROM harness_shared.gateway_request_outcomes WHERE workspace_id = ${WS}`;
});

describe('ingestInteractiveUsage — session_id attribution (P3)', () => {
  it('attributes late exact gateway evidence while preserving ambiguous and mismatched accounts as unknown', async () => {
    const session = '44444444-aaaa-4444-8444-444444444444';
    for (const response of ['resp-a', 'resp-b', 'resp-ambiguous', 'resp-wrong-owner', 'resp-wrong-turn', 'resp-cancelled']) {
      await sql`INSERT INTO harness_shared.agent_usage_samples
        (workspace_id, ts, bucket_key, provider, model_class, source, session_id, cost_usd, usage_provenance, usage_event_key)
        VALUES (${WS}, 1, 'openai:gpt', 'openai', 'gpt', 'interactive', ${session}, 1,
          ${JSON.stringify({ providerResponseId: response, sessionOwnerId: 'exact-owner', turnId: 'exact-turn',
            accountSource: 'unavailable' })}::jsonb, ${response})`;
    }
    const before = await sql<Array<{ count: number }>>`SELECT count(*)::int AS count FROM harness_shared.agent_usage_samples
      WHERE workspace_id = ${WS} AND account_id IS NOT NULL`;
    expect(before[0].count).toBe(0);
    for (const [index, response] of ['resp-a', 'resp-b', 'resp-ambiguous', 'resp-ambiguous', 'resp-wrong-owner', 'resp-wrong-turn', 'resp-cancelled'].entries()) {
      await sql`INSERT INTO harness_shared.gateway_request_outcomes
        (request_id, workspace_id, gateway_process_instance_id, request_ordinal, owner_id, provider, protocol,
         transport, selected_account_id, outcome_class, final_status, request_timestamp_ms, finalized_at_ms,
         attempts, failovers, native_session_id, native_thread_id, native_turn_id, recorded_at_ms,
         retention_expires_at_ms, provider_response_id)
        VALUES (${`request-${index}`}, ${WS}, '00000000-0000-4000-8000-000000000001', ${index + 1},
          ${response === 'resp-wrong-owner' ? 'another-owner' : 'exact-owner'}, 'codex', 'openai-responses', 'oauth-http',
          ${index === 1 ? 'account-b' : 'account-a'}, ${response === 'resp-cancelled' ? 'cancelled' : 'ok'}, 200,
          1, 2, 1, 0, ${session}, ${session}, ${response === 'resp-wrong-turn' ? 'another-turn' : 'exact-turn'},
          2, 3, ${response})`;
    }
    // More than a page of newer unknowns must not hide older exact matches.
    await sql`INSERT INTO harness_shared.agent_usage_samples
      (workspace_id, ts, bucket_key, provider, model_class, source, usage_provenance)
      SELECT ${WS}, 1, 'openai:gpt', 'openai', 'gpt', 'interactive',
        jsonb_build_object('providerResponseId', 'unmatched-' || n) FROM generate_series(1,501) n`;
    const result = await ingestInteractiveUsage({ adapters: [] });
    expect(result.errors).toEqual([]);
    expect(result.attributedAccounts).toBe(2);
    expect(await reconcileTranscriptAccounts(sql, WS)).toBe(0);
    const rows = await sql<Array<{ usage_event_key: string; account_id: string | null; usage_provenance: Record<string, unknown> }>>`
      SELECT usage_event_key, account_id, usage_provenance FROM harness_shared.agent_usage_samples
      WHERE workspace_id = ${WS} AND usage_event_key LIKE 'resp-%' ORDER BY usage_event_key`;
    expect(rows).toHaveLength(6);
    expect(rows.map(row => [row.usage_event_key, row.account_id])).toEqual([
      ['resp-a', 'account-a'], ['resp-ambiguous', null], ['resp-b', 'account-b'], ['resp-cancelled', null],
      ['resp-wrong-owner', null], ['resp-wrong-turn', null],
    ]);
    expect(rows[0].usage_provenance).toMatchObject({ accountSource: 'exact-gateway-provider-response', gatewayRequestId: 'request-0' });
    const [coverage] = await sql<Array<{ samples: number; total: number; attributed: number }>>`
      SELECT count(*)::int AS samples, sum(cost_usd)::float8 AS total,
        sum(cost_usd) FILTER (WHERE account_id IS NOT NULL)::float8 AS attributed
      FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS} AND usage_event_key LIKE 'resp-%'`;
    expect(coverage).toEqual({ samples: 6, total: 6, attributed: 2 });
  });

  it('persists exact native response provenance once and keeps account and trigger unknown', async () => {
    const uuid = '22222222-aaaa-4222-8222-222222222222';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wi-native-response-'));
    tmpDirs.push(dir);
    const file = path.join(dir, `${uuid}.jsonl`);
    const usage = { input_tokens: 100, cached_input_tokens: 20, cache_write_input_tokens: 0, output_tokens: 10 };
    const cumulative = { ...usage, total_tokens: 110 };
    const line = (value: unknown) => JSON.stringify(value) + '\n';
    await fs.writeFile(file,
      line({ type: 'session_meta', payload: { id: uuid } }) +
      line({ type: 'turn_context', payload: { turn_id: 'native-turn', model: 'gpt-6' } }) +
      line({ type: 'token_usage_record', payload: { session_id: uuid, thread_id: uuid, turn_id: 'native-turn',
        response_id: 'resp-persisted', usage, thread_token_usage: cumulative } }));
    const adapters = [{ name: 'codex', root: dir, parse: parseCodexChunk, replayStateFromPrefix: true }];
    await ingestInteractiveUsage({ adapters });
    // Simulate a deployed, already initialized watermark from the old parser.
    await sql`UPDATE harness_shared.interactive_usage_files SET parser_state =
      ${JSON.stringify({ initialized: true, model: 'gpt-6', turnId: 'native-turn' })}::jsonb
      WHERE workspace_id = ${WS} AND file_path = ${file}`;
    await fs.appendFile(file, line({ type: 'event_msg', timestamp: '2026-10-18T00:00:00Z', payload: {
      type: 'token_count', info: { total_token_usage: cumulative, last_token_usage: usage },
    } }));
    await ingestInteractiveUsage({ adapters });
    await ingestInteractiveUsage({ adapters });
    const rows = await sql<Array<{ turn_count: number; account_id: string | null; turn_trigger: string | null;
      usage_provenance: Record<string, unknown> }>>`
      SELECT turn_count, account_id, turn_trigger, usage_provenance FROM harness_shared.agent_usage_samples
      WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn_count: 1, account_id: null, turn_trigger: null,
      usage_provenance: { providerResponseId: 'resp-persisted', providerResponseIdSource: 'native-token-usage-record',
        turnId: 'native-turn', accountSource: 'unavailable', triggerSource: 'unavailable' } });
  });

  it('persists an explicit trigger and session context without claiming causal work-item attribution', async () => {
    const uuid = '33333333-aaaa-4333-8333-333333333333';
    const [session] = await sql<Array<{ id: number | string }>>`
      INSERT INTO harness_shared.adv_sessions (workspace_id, mode, coord_owner_id, session_id, role, plan_slug)
      VALUES (${WS}, 'console', 'exact-session-owner', ${uuid}, 'su', 'launch-plan') RETURNING id`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wi-native-trigger-'));
    tmpDirs.push(dir);
    const line = (value: unknown) => JSON.stringify(value) + '\n';
    await fs.writeFile(path.join(dir, `${uuid}.jsonl`),
      line({ type: 'session_meta', payload: { id: uuid } }) +
      line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '⟦turn-origin:self-compaction nonce:1234567890abcdef⟧\ncarry' },
      ] } }) +
      line({ type: 'turn_context', payload: { turn_id: 'native-turn', model: 'gpt-6' } }) +
      line({ type: 'event_msg', payload: { type: 'token_count', info: {
        total_token_usage: { input_tokens: 100 }, last_token_usage: { input_tokens: 100, output_tokens: 10 },
      } } }));
    await ingestInteractiveUsage({ adapters: [{ name: 'codex', root: dir, parse: parseCodexChunk,
      advSessionId: Number(session.id) }] });
    const rows = await sql<Array<{ turn_trigger: string | null; account_id: string | null; usage_provenance: Record<string, unknown> }>>`
      SELECT turn_trigger, account_id, usage_provenance FROM harness_shared.agent_usage_samples
      WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ turn_trigger: 'self-compaction', account_id: null, usage_provenance: {
      triggerSource: 'native-turn-envelope', sessionOwnerId: 'exact-session-owner', sessionPlanSlug: 'launch-plan',
      sessionContextSource: 'ingest-time-adv-session', workItemSource: 'unavailable',
    } });
  });

  it('writes the transcript native UUID into agent_usage_samples.session_id (was NULL before the fix)', async () => {
    const uuid = 'aaaa1111-bbbb-2222-cccc-333344445555';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-ingest-'));
    tmpDirs.push(dir);
    const turn = (model: string, usage: Record<string, number>) =>
      JSON.stringify({ type: 'assistant', message: { model, usage } });
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      turn('claude-opus-4-8', { input_tokens: 100, output_tokens: 200 }) + '\n',
    );

    // A claude-only adapter pointed at our temp dir — no codex/omp roots, no pollution.
    const res = await ingestInteractiveUsage({
      adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }],
    });
    expect(res.samples).toBeGreaterThan(0);

    const rows = await sql<Array<{ session_id: string | null; run_id: string | null; source: string; cost_usd: number | null; role: string }>>`
      SELECT session_id, run_id, source, cost_usd, role FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
    expect(rows.length).toBeGreaterThan(0);
    // THE FIX: session_id now carries the native UUID = adv_sessions.session_id (the join key).
    expect(rows[0].session_id).toBe(uuid);
    expect(rows[0].run_id).toBe(uuid); // run_id still carries it too (back-compat preserved)
    expect(rows[0].source).toBe('interactive');
    expect(rows[0].role).toBe('interactive');
  });

  it('prefers adv_sessions.id over an exact session_id match when stamping role', async () => {
    const uuid = '11111111-aaaa-4111-8111-111111111111';
    const [advSession] = await sql<Array<{ id: string | number }>>`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, coord_owner_id, session_id, role)
      VALUES (${WS}, 'console', 'role-by-adv-id', 'different-session-id', 'judge')
      RETURNING id
    `;
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, coord_owner_id, session_id, role)
      VALUES (${WS}, 'console', 'role-by-session-id', ${uuid}, 'planner')
    `;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wi-role-adv-id-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 25, cache_creation_input_tokens: 0 } },
      }) + String.fromCharCode(10),
    );

    await ingestInteractiveUsage({
      adapters: [{
        name: 'claude',
        root: dir,
        parse: parseTranscriptChunk,
        advSessionId: Number(advSession.id),
      }],
    });
    const rows = await sql<Array<{ role: string }>>`
      SELECT role FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('judge');
  });

  it('uses an exact adv_sessions.session_id match when no adv session id is available', async () => {
    const uuid = '22222222-bbbb-4222-8222-222222222222';
    await sql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, mode, coord_owner_id, session_id, role)
      VALUES (${WS}, 'console', 'role-by-exact-session-id', ${uuid}, 'worker')
    `;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wi-role-session-id-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      JSON.stringify({
        type: 'assistant',
        message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 25, cache_creation_input_tokens: 0 } },
      }) + String.fromCharCode(10),
    );

    await ingestInteractiveUsage({
      adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }],
    });
    const rows = await sql<Array<{ role: string }>>`
      SELECT role FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].role).toBe('worker');
  });

  it('stamps goal_id from the session GOAL-mode subject at write time', async () => {
    const uuid = 'eeee5555-ffff-6666-aaaa-777788889999';
    await sql`INSERT INTO harness_shared.adv_sessions
      (workspace_id, mode, coord_owner_id, session_id)
      VALUES (${WS}, 'console', 'goal-owner', ${uuid})`;
    await sql`INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, subject, set_by)
      VALUES (${WS}, 'goal-owner', 'overlay:goal', 'goal', 'goal-write-time', 'test')`;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-goal-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 100, output_tokens: 200 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }] });
    const rows = await sql<Array<{ goal_id: string | null }>>`
      SELECT goal_id FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].goal_id).toBe('goal-write-time');
  });

  it('the exact readLoopSpendCents attribution query now sums interactive spend by session_id', async () => {
    // Mirror what readLoopSpendCents runs (owner→session_id resolved upstream): SUM(cost_usd)
    // WHERE session_id = <native uuid>. With the fix, interactive samples are now summed.
    const uuid = 'bbbb2222-cccc-3333-dddd-444455556666';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-spend-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      // The spend assertion needs fully reported input usage, including measured zero writes.
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1000, output_tokens: 2000, cache_creation_input_tokens: 0 } } }) + '\n',
    );
    await ingestInteractiveUsage({ adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }] });

    const rows = await sql<Array<{ usd: number }>>`
      SELECT COALESCE(SUM(cost_usd), 0)::float8 AS usd
        FROM harness_shared.agent_usage_samples
       WHERE session_id = ${uuid}`;
    // Priced opus spend attributed by session_id — a positive cents figure (was 0 before the fix).
    expect(Math.round((rows[0]?.usd ?? 0) * 100)).toBeGreaterThan(0);
  });
});

describe('ingestInteractiveUsage — per-owner isolation root sweep (EI-19964643447670242)', () => {
  it('ingests a transcript under <isolationBase>/<owner>/projects/, not just the global root', async () => {
    // Mirrors the REAL on-disk shape every psu-launched agent (su/queen/overwatch/bee)
    // writes to: ~/.papercusp/session-claude/<ownerId>/projects/<munged-cwd>/<uuid>.jsonl —
    // a root the ingester never swept before this fix, so this whole population's
    // interactive usage was structurally invisible to agent_usage_samples.
    const uuid = 'cccc3333-dddd-4444-eeee-555566667777';
    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-isobase-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, 'su-fake-owner-id', 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 500, output_tokens: 700, cache_creation_input_tokens: 0 } } }) + '\n',
    );

    // Empty explicit `adapters` (no global-root pollution) + includeIsolationRoots:true
    // (test seam override) + isolationBase pointed at our temp fixture — never touches
    // the real $HOME tree.
    const res = await ingestInteractiveUsage({
      adapters: [],
      includeIsolationRoots: true,
      isolationBase,
    });
    expect(res.samples).toBeGreaterThan(0);

    const rows = await sql<Array<{ session_id: string | null; source: string; cost_usd: number | null }>>`
      SELECT session_id, source, cost_usd FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('interactive');
    expect(rows[0].cost_usd).toBeGreaterThan(0);
  });

  it('ingests a codex rollout under <codexIsolationBase>/session-N/sessions/ keyed by the rollout uuid (WI-2140701 (a))', async () => {
    // Mirrors the REAL on-disk shape every psu-launched codex agent writes to:
    // ~/.papercusp/su-codex-homes/session-<advId>/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.
    // Before this fix the codex adapter swept only the global ~/.codex/sessions AND
    // keyed samples by the whole basename ("rollout-…"), so the codex everything-goal
    // holder had zero attributable usage samples (WI-2140701 card-4 finding).
    const uuid = '01a06086-e882-7e10-9079-aa29e6a00097';
    const claudeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-claude-empty-'));
    const codexBase = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-codex-homes-'));
    tmpDirs.push(claudeBase, codexBase);
    const day = path.join(codexBase, 'session-21396', 'sessions', '2026', '09', '02');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(
      path.join(day, `rollout-2026-09-02T01-10-49-${uuid}.jsonl`),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
        '\n' +
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 17396, cached_input_tokens: 16000, cache_write_input_tokens: 0, output_tokens: 55 } },
          },
        }) +
        '\n',
    );

    const res = await ingestInteractiveUsage({
      adapters: [],
      includeIsolationRoots: true,
      isolationBase: claudeBase, // empty — keeps the claude sweep off the real $HOME
      codexIsolationBase: codexBase,
    });
    expect(res.samples).toBe(1);

    const rows = await sql<Array<{ session_id: string | null; source: string; model: string | null; cache_read_tokens: string | null }>>`
      SELECT session_id, source, model, cache_read_tokens FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND provider = 'openai'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe(uuid); // the bare uuid — NOT "rollout-2026-…-<uuid>"
    expect(rows[0].source).toBe('interactive');
    expect(rows[0].model).toBe('gpt-5.6-sol');
    expect(Number(rows[0].cache_read_tokens)).toBe(16000);
  });

  it('a caller-supplied `adapters` array WITHOUT includeIsolationRoots opts out — no real-$HOME sweep', async () => {
    // Recurrence guard for the test-pollution risk: every pre-existing test in this
    // file relies on exactly this default (adapters given, includeIsolationRoots
    // unset) to stay hermetic. Pin it explicitly so a future change to the default
    // can't silently start sweeping the real machine's isolation tree in every test.
    const uuid = 'dddd4444-eeee-5555-ffff-666677778888';
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'p3-noiso-'));
    tmpDirs.push(dir);
    await fs.writeFile(
      path.join(dir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 10 } } }) + '\n',
    );
    const res = await ingestInteractiveUsage({
      adapters: [{ name: 'claude', root: dir, parse: parseTranscriptChunk }],
    });
    // Only the one file under `dir` — no other adapter (isolation or otherwise) ran.
    expect(res.root).toBe(dir);
  });
});

describe('ingestInteractiveUsage — harness_slug stamped at INSERT (WI-2144763)', () => {
  // THE GAP THIS GUARDS. Before WI-2144763 the interactive writer omitted harness_slug
  // from its INSERT column list entirely: measured 2026-09-05, all 51,784 interactive
  // rows carried harness_slug IS NULL (0.0%) and rendered as '(unattributed)', against
  // a jsonl writer at 100% on the same column — a WRITER gap, not a schema gap.
  //
  // The fix resolves the value IN SQL via
  // harness_shared.harness_slug_for_usage_attribution(workspace, ownerId, sessionId)
  // (migration 1119), taking the coord owner id straight off the isolation ROOT path.
  // That owner-first route is the whole point: session_briefs covers 83.4% of owners,
  // where the adv_sessions session route the sample already carries covers only 7.8%,
  // so resolving through the session would have capped interactive coverage at ~7.8%
  // while looking like a fix. These tests pin the owner route specifically.
  it('stamps harness_slug from the isolation-root owner (the session_briefs owner route)', async () => {
    const owner = 'su-wi2144763-stamp-owner';
    const uuid = 'aaaa1111-bbbb-2222-cccc-333344445555';
    await sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, harness_slug)
           VALUES (${owner}, ${WS}, ${'harness-under-test'})
      ON CONFLICT (owner_id)
        DO UPDATE SET harness_slug = EXCLUDED.harness_slug, workspace_id = EXCLUDED.workspace_id`;

    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2144763-iso-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, owner, 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 400, output_tokens: 600 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [], includeIsolationRoots: true, isolationBase });

    const rows = await sql<Array<{ harness_slug: string | null }>>`
      SELECT harness_slug FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('harness-under-test');
  });

  it('leaves harness_slug NULL when the owner resolves to nothing — an honest gap, never a fabricated slug', async () => {
    // The companion half of the guard. A stamp that always produced SOME value would
    // pass the test above while silently inventing attribution, which is worse than the
    // NULL it replaced: '(unattributed)' is at least readable as unknown. The function
    // has exactly two resolution branches (owner → session_briefs, then adv_sessions →
    // coord_owner_id → session_briefs) and returns NULL when neither resolves; this
    // owner has no brief and this uuid no adv_sessions row, so both must miss.
    const owner = 'su-wi2144763-unknown-owner';
    const uuid = 'bbbb2222-cccc-3333-dddd-444455556666';
    await sql`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;

    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2144763-iso-null-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, owner, 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 120, output_tokens: 130 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [], includeIsolationRoots: true, isolationBase });

    const rows = await sql<Array<{ harness_slug: string | null }>>`
      SELECT harness_slug FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBeNull();
  });

  it('CONTROL: the stamp is resolved per-owner, not a constant — a second owner gets its own slug', async () => {
    // Calibration for the two pins above. If the writer stamped one hardcoded value (or
    // the fixture leaked between cases), the positive test would still pass. Ingesting a
    // DIFFERENT owner in the same run must yield that owner's own slug, which is what
    // makes 'harness-under-test' above evidence of resolution rather than a constant.
    const owner = 'su-wi2144763-second-owner';
    const uuid = 'cccc3333-dddd-4444-eeee-666677778888';
    await sql`
      INSERT INTO harness_shared.session_briefs (owner_id, workspace_id, harness_slug)
           VALUES (${owner}, ${WS}, ${'a-different-harness'})
      ON CONFLICT (owner_id)
        DO UPDATE SET harness_slug = EXCLUDED.harness_slug, workspace_id = EXCLUDED.workspace_id`;

    const isolationBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2144763-iso-2nd-'));
    tmpDirs.push(isolationBase);
    const ownerProjectsDir = path.join(isolationBase, owner, 'projects', 'munged-cwd');
    await fs.mkdir(ownerProjectsDir, { recursive: true });
    await fs.writeFile(
      path.join(ownerProjectsDir, `${uuid}.jsonl`),
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 200, output_tokens: 300 } } }) + '\n',
    );

    await ingestInteractiveUsage({ adapters: [], includeIsolationRoots: true, isolationBase });

    const rows = await sql<Array<{ harness_slug: string | null }>>`
      SELECT harness_slug FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('a-different-harness');
  });
});

describe('ingestInteractiveUsage — goal_id stamped via the adv_sessions PK (WI-2145149)', () => {
  // THE DEFECT. Both routes of the 2-arg `goal_id_for_usage_session` join
  // adv_sessions on `a.session_id = p_session_id`. A psu-launched codex session's
  // sample carries the ROLLOUT UUID in session_id, while the key it is actually
  // indexed by is `adv_sessions.id` — the bigint PK carried by its per-session
  // CODEX_HOME dir `<base>/session-<advId>/`. So both routes returned NULL for
  // every codex row: measured 0 of 134 resolving in production. Migration 1121
  // adds a 3-arg overload that tries the adv-id key first, in each semantic tier.
  //
  // HONEST CEILING, so nobody reads these tests as closing the goal gap: the fix
  // moves codex goal attribution 0 -> 3 of 134 — which IS 100% of the achievable
  // set (feeding the OLD function a key it can match yields the same 3). The other
  // 131 owners have no goal on any brief or mode row; workspace-wide only 344 of
  // 22,229 adv_sessions (1.55%) resolve a goal by ANY route. A NULL goal_id is
  // overwhelmingly ABSENT GOAL DATA, not a resolver failure (EI-22391659152296045).
  //
  // Fixtures use an EXPLICIT adv_sessions.id (a plain bigint with a sequence
  // default, not an identity column) so the CODEX_HOME dir name and the PK agree.

  it('resolves the goal through the CODEX_HOME adv id when the session route provably cannot', async () => {
    const advId = 987654321;
    const uuid = '01a0aaaa-1111-7e10-9079-bb0000000001';
    // session_id is DELIBERATELY not the rollout uuid — this is what every real psu
    // codex row looks like, and it is what makes the session route unable to match.
    await sql`INSERT INTO harness_shared.adv_sessions
      (id, workspace_id, mode, coord_owner_id, session_id)
      VALUES (${advId}, ${WS}, 'console', 'codex-goal-owner', ${'some-other-native-session-id'})`;
    await sql`INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, subject, set_by)
      VALUES (${WS}, 'codex-goal-owner', 'overlay:goal', 'goal', 'goal-via-adv-id', 'test')`;

    // CONTROL, asserted BEFORE the ingest: the pre-fix 2-arg form — still live, still
    // called by the deployed release checkout and the desktop sidecar — cannot resolve
    // this session. Without this line a passing test below would be equally consistent
    // with a fixture that the OLD function could already have resolved, so this is what
    // makes the stamp evidence of the new argument rather than of the fixture.
    const [preFix] = await sql<Array<{ goal_id: string | null }>>`
      SELECT harness_shared.goal_id_for_usage_session(${WS}, ${uuid}) AS goal_id`;
    expect(preFix.goal_id).toBeNull();

    const claudeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2145149-claude-empty-'));
    const codexBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2145149-codex-homes-'));
    tmpDirs.push(claudeBase, codexBase);
    const day = path.join(codexBase, `session-${advId}`, 'sessions', '2026', '09', '05');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(
      path.join(day, `rollout-2026-09-05T03-40-00-${uuid}.jsonl`),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
        '\n' +
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 40 } },
          },
        }) +
        '\n',
    );

    await ingestInteractiveUsage({
      adapters: [],
      includeIsolationRoots: true,
      isolationBase: claudeBase, // empty — keeps the claude sweep off the real $HOME
      codexIsolationBase: codexBase,
    });

    const rows = await sql<Array<{ goal_id: string | null; session_id: string | null }>>`
      SELECT goal_id, session_id FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    // The sample still carries the rollout uuid — 1121 resolves the goal WITHOUT
    // re-signing session_id, which the P3 path above pins as load-bearing.
    expect(rows[0].session_id).toBe(uuid);
    expect(rows[0].goal_id).toBe('goal-via-adv-id');
  });

  it('leaves goal_id NULL when the adv session carries no goal — the 131-of-134 case, never a fabricated goal', async () => {
    // The dominant real-world shape: a genuine adv_sessions row and a real coord
    // owner whose agent_modes/session_briefs simply record no goal. The resolver must
    // return NULL rather than inventing one or falling back to another session's goal
    // — the latter is exactly what a naive "nearest row" fix would do.
    const advId = 987654322;
    const uuid = '01a0aaaa-1111-7e10-9079-bb0000000002';
    await sql`INSERT INTO harness_shared.adv_sessions
      (id, workspace_id, mode, coord_owner_id, session_id)
      VALUES (${advId}, ${WS}, 'console', 'codex-goalless-owner', ${'another-native-session-id'})`;

    const claudeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2145149-claude-empty-2-'));
    const codexBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2145149-codex-homes-2-'));
    tmpDirs.push(claudeBase, codexBase);
    const day = path.join(codexBase, `session-${advId}`, 'sessions', '2026', '09', '05');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(
      path.join(day, `rollout-2026-09-05T03-41-00-${uuid}.jsonl`),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
        '\n' +
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 20 } },
          },
        }) +
        '\n',
    );

    await ingestInteractiveUsage({
      adapters: [],
      includeIsolationRoots: true,
      isolationBase: claudeBase,
      codexIsolationBase: codexBase,
    });

    const rows = await sql<Array<{ goal_id: string | null }>>`
      SELECT goal_id FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].goal_id).toBeNull();
  });

  it('CONTROL: the goal is resolved per-session, not a constant — a second CODEX_HOME gets its own goal', async () => {
    // Calibration for the positive pin above. If the writer stamped one hardcoded
    // value, or the fixture leaked between cases, that test would still pass.
    // Ingesting a DIFFERENT adv id in the same file must yield ITS goal.
    const advId = 987654323;
    const uuid = '01a0aaaa-1111-7e10-9079-bb0000000003';
    await sql`INSERT INTO harness_shared.adv_sessions
      (id, workspace_id, mode, coord_owner_id, session_id)
      VALUES (${advId}, ${WS}, 'console', 'codex-second-goal-owner', ${'third-native-session-id'})`;
    await sql`INSERT INTO harness_shared.agent_modes
      (workspace_id, owner_id, axis_key, mode, subject, set_by)
      VALUES (${WS}, 'codex-second-goal-owner', 'overlay:goal', 'goal', 'a-different-goal', 'test')`;

    const claudeBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2145149-claude-empty-3-'));
    const codexBase = await fs.mkdtemp(path.join(os.tmpdir(), 'wi2145149-codex-homes-3-'));
    tmpDirs.push(claudeBase, codexBase);
    const day = path.join(codexBase, `session-${advId}`, 'sessions', '2026', '09', '05');
    await fs.mkdir(day, { recursive: true });
    await fs.writeFile(
      path.join(day, `rollout-2026-09-05T03-42-00-${uuid}.jsonl`),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }) +
        '\n' +
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 200, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 } },
          },
        }) +
        '\n',
    );

    await ingestInteractiveUsage({
      adapters: [],
      includeIsolationRoots: true,
      isolationBase: claudeBase,
      codexIsolationBase: codexBase,
    });

    const rows = await sql<Array<{ goal_id: string | null }>>`
      SELECT goal_id FROM harness_shared.agent_usage_samples
       WHERE workspace_id = ${WS} AND session_id = ${uuid}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].goal_id).toBe('a-different-goal');
  });
});
