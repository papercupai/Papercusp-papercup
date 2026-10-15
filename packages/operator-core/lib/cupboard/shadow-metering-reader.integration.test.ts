/**
 * agent-economy-flywheel P-003 (E1, WI-10004287): the shadow statement reader against the real
 * attribution views (1149 + 1177 + 1275) on a fresh Postgres.
 *
 * Pins the parts the pure pricing tests cannot see: which month a sample falls in, how the
 * launch record's layers become slot-qualified refs, that layers are withheld when the launch
 * record no longer carries the revision the span applied, and that tool calls are counted.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve, join } from 'node:path';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { PRICE_TABLE_VERSION } from '@papercusp/model-pricing';
import { readIdentityOutcomeCost, readIdentityTurnBilledCost, readShadowCostBasis, readShadowStatement, readShadowUsageAggregates, shadowMonthBounds, type OutcomeWorkItem } from './shadow-metering-reader';
import { FundedIdentityTurnStore, type FundedIdentityTurnBinding } from './funded-turn-store';
import { identityPerUseOfferTerms, quoteIdentityInferenceTurn } from './identity-per-use-offer';
import { readClosedCodexTurnBilledCost } from '../session-transcript-resolvers';
import { closedCodexTurnPopulation } from '../interactive-usage/ingest-adapters';

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = resolve(here, '../../../../libs/papercusp/libs/db/sql');
const MIGRATIONS = [
  '1149-session-identity-activation-spans.sql',
  '1177-identity-usage-carry-correlation.sql',
  '1275-identity-attribution-indexed-spans.sql',
  // WI-10004494 gap 3: the activation event's own layer stamp, preferred by the reader.
  '1295-activation-event-specification-layer-refs.sql',
  '1423-cupboard-funded-turn-ledger.sql',
  '1424-funded-turn-native-binding.sql',
];
const WS = 'shadow-reader-ws';
const OTHER_WS = 'shadow-reader-other';
const OWNER = 'su-shadow-reader';
const SPEC_A = 'a'.repeat(64);
const SPEC_B = 'b'.repeat(64);
const SPEC_NEWER = 'c'.repeat(64);
const MONTH = '2026-08';

let db: FreshPgDb;

const ms = (iso: string) => new Date(iso).getTime();

/** A specification input as the compiler records it; `slots` marks an identity layer. */
function layer(ref: string, slots?: string[]) {
  return {
    kind: 'blueprint-layer',
    ref,
    sourceKind: slots ? 'identity' : 'blueprint',
    document: { id: ref, ...(slots ? { slots: slots.map((slot) => ({ slot })) } : {}) },
  };
}

function launchSpec(revision: string, agent: string, inputs: unknown[]) {
  return { agent, profile: 'engineer', specificationRevision: revision, stateRevision: 'state-1', specificationArtifact: { inputs } };
}

beforeAll(async () => {
  db = await createFreshPgDb('shadow-metering-reader');
  await db.sql.unsafe(`
    CREATE TABLE harness_shared.adv_sessions (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, coord_owner_id text,
      session_id text, started_at timestamptz NOT NULL, ended_at timestamptz,
      ended_by text, launch_spec jsonb
    );
    CREATE TABLE harness_shared.session_briefs (
      owner_id text PRIMARY KEY, workspace_id text NOT NULL,
      native_session_id text, control_generation bigint NOT NULL,
      control_delivered_generation bigint NOT NULL DEFAULT 0,
      control_state jsonb
    );
    CREATE TABLE harness_shared.tool_invocations (
      id bigint PRIMARY KEY, workspace_id text NOT NULL,
      coord_owner_id text, invoked_at timestamptz NOT NULL
    );
    -- The real table's column prefix, in order (1275 names these columns explicitly).
    CREATE TABLE harness_shared.agent_usage_samples (
      id bigint PRIMARY KEY, workspace_id text NOT NULL, ts bigint NOT NULL,
      bucket_key text, provider text, model_class text, source text,
      input_tokens bigint, output_tokens bigint, cache_read_tokens bigint,
      cost_usd double precision, rl_requests_limit bigint, rl_requests_remaining bigint,
      rl_tokens_limit bigint, rl_tokens_remaining bigint, rl_reset_at bigint,
      model text, cost_source text, harness_slug text, run_id text, role text,
      cache_creation_tokens bigint, turn_count integer, session_id text,
      tool_name text, turn_trigger text, account_id text, goal_id text
    );
    CREATE TABLE harness_shared.session_archives (adv_session_id bigint, session_id text NOT NULL);
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL, source_kind text NOT NULL, session_id text NOT NULL, owner text
    );
    CREATE TABLE harness_shared.interactive_usage_files (
      workspace_id text NOT NULL, file_path text NOT NULL, byte_offset bigint NOT NULL, parser_state jsonb,
      PRIMARY KEY (workspace_id, file_path)
    );
  `);
  for (const file of MIGRATIONS) await applyMigrationForTest(db.sql, resolve(sqlDir, file));
  // Read by readShadowCostBasis (D-018 point 4). Added AFTER the migrations: an earlier one builds
  // the view from u.*, and 1275 replaces it with an explicit list, which cannot drop view columns.
  await db.sql`ALTER TABLE harness_shared.agent_usage_samples ADD COLUMN usage_provenance jsonb, ADD COLUMN price_table_version text,
    ADD COLUMN usage_event_key text`;

  const specA = launchSpec(SPEC_A, 'codex', [
    layer('base'),
    layer('papercusp-engineer', ['domain']),
    layer('papercusp'),
    // A slot-bearing input that is not a blueprint layer carries no identity.
    { kind: 'package', ref: 'pkg-with-slot', document: { slots: [{ slot: 'domain' }] } },
    { kind: 'setting', ref: 'model' },
  ]);
  const specNewer = launchSpec(SPEC_NEWER, 'claude', [layer('papercusp-engineer', ['domain'])]);
  await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
    (1,${WS},${OWNER},'adv-key-1','2026-08-01T00:00:00Z',NULL,NULL,${JSON.stringify(specA)}::text::jsonb),
    (2,${WS},${OWNER},'adv-key-2','2026-08-01T00:00:00Z',NULL,NULL,${JSON.stringify(specNewer)}::text::jsonb)`;
  const applied = (row: { gen: number; session: string; adv: number; native: string; spec: string; stack: string[] }) => db.sql`
    INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
    VALUES (${WS},${OWNER},${OWNER},'principal-shadow',${row.session},${row.adv},${row.native},
      ${`t${row.gen}`},${row.gen},'applied','control',${row.spec},'state-1',
      ${JSON.stringify(row.stack)}::text::jsonb,'2026-08-01T00:01:00Z'::timestamptz)`;
  await applied({ gen: 1, session: 'shadow-p1', adv: 1, native: 'native-shadow-1', spec: SPEC_A, stack: ['autonomy:su.mode-auto'] });
  // The span applied SPEC_B; the launch record has since moved on to SPEC_NEWER.
  await applied({ gen: 2, session: 'shadow-p2', adv: 2, native: 'native-shadow-2', spec: SPEC_B, stack: [] });

  const sample = (id: number, ws: string, session: string | null, at: string, cost: number | null, source: string | null) => db.sql`
    INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts, cost_usd, cost_source)
    VALUES (${id},${ws},${session},${ms(at)},${cost},${source})`;
  await sample(101, WS, 'native-shadow-1', '2026-08-15T00:00:00Z', 1.0, 'provider');
  await sample(102, WS, 'native-shadow-1', '2026-08-15T01:00:00Z', 0.5, 'estimated');
  await sample(103, WS, 'native-shadow-2', '2026-08-16T00:00:00Z', 2.0, 'estimated');
  await sample(104, WS, 'unknown-session', '2026-08-17T00:00:00Z', 0.25, 'estimated');
  await sample(105, WS, 'native-shadow-1', '2026-09-01T00:00:00Z', 7.0, 'provider');       // next month (end exclusive)
  await sample(106, WS, 'native-shadow-1', '2026-07-31T23:59:59.999Z', 11.0, 'provider');  // previous month
  await sample(107, OTHER_WS, 'native-shadow-1', '2026-08-15T00:00:00Z', 3.0, 'provider'); // other workspace
  await sample(108, WS, null, '2026-08-18T00:00:00Z', null, null);                        // keyless, costless
  await sample(109, WS, 'native-shadow-1', '2026-08-01T00:00:00Z', 0.125, 'estimated');  // month start, before the span

  await db.sql`INSERT INTO harness_shared.tool_invocations VALUES
    (201,${WS},${OWNER},'2026-08-15T00:00:00Z'),
    (202,${WS},'someone-else','2026-08-15T00:00:00Z'),
    (203,${WS},${OWNER},'2026-09-01T00:00:00Z'),
    (204,${OTHER_WS},${OWNER},'2026-08-15T00:00:00Z')`;
}, 90_000);

afterAll(async () => db?.cleanup());

describe('P-018 production funded outcome cost against migrated PostgreSQL', () => {
  it('reads the exact persisted population and provider costs, includes failed spend and fails closed when evidence changes', async () => {
    const workspaceId = 'p018-outcome-reader';
    const offered = identityPerUseOfferTerms({ identity: { id: 'outcome-reviewer', version: '1.0.0' }, markupBps: 2500 });
    if (!offered.ok) throw new Error(offered.detail);
    const offer = offered.terms;
    const store = new FundedIdentityTurnStore(db.sql);
    const outcomes = new Map<string, OutcomeWorkItem>();
    let firstBinding: FundedIdentityTurnBinding | undefined;
    for (const n of [1, 2, 3]) {
      const id = 400 + n, owner = `su-p018-outcome-${n}`, native = `p018-outcome-native-${n}`;
      const workItem = { id: `WI-outcome-${n}`, harness: 'papercusp' };
      const binding: FundedIdentityTurnBinding = { workspaceId, ownerId: owner, principalId: 'principal-outcome',
        nativeSessionId: native, nativeTurnId: `native-turn-${n}`, specificationRevision: SPEC_A, stateRevision: 'state-1',
        workItem, payer: 'gh:1', seller: 'gh:2', offerId: `offer-${n}`, channelId: `channel-${n}`, offer,
        inferenceCeilingMicros: 1n, expiresAtMs: ms('2026-08-21T00:00:00Z') };
      firstBinding ??= binding;
      await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
        (${id},${workspaceId},${owner},${native},'2026-08-01T00:00:00Z',NULL,NULL,NULL)`;
      await db.sql`INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
         transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
        VALUES (${workspaceId},${owner},${owner},'principal-outcome',${native},${id},${native},
          ${`outcome-${n}`},1,'applied','control',${SPEC_A},'state-1','[]'::jsonb,'2026-08-01T00:01:00Z')`;
      const usageEventKey = String(n).padStart(64, '0');
      await db.sql`INSERT INTO harness_shared.agent_usage_samples
        (id,workspace_id,session_id,ts,cost_usd,cost_source,usage_provenance,usage_event_key)
        VALUES (${id},${workspaceId},${native},${ms('2026-08-20T00:00:00Z')},0.000001,'provider',
          ${JSON.stringify({ turnId: binding.nativeTurnId, costBound: null })}::text::jsonb,${usageEventKey})`;
      const prepared = await store.prepare(binding);
      if (!prepared.ok) throw new Error(prepared.detail);
      const quote = quoteIdentityInferenceTurn({ offer, billedInferenceMicros: 1n, inferenceCeilingMicros: 1n });
      if (!quote.ok) throw new Error(quote.detail);
      // Seed a persisted settled receipt, independently of the reader under test.
      const receipt = { channelId: binding.channelId, usageNonce: prepared.turn.turnId, voucherDigest: `digest-${n}`,
        meterQuantity: String(quote.reservationQuantity), amountMicros: '0', occurredAtMs: 3, signature: 'seller-signature' };
      const funding = { ...receipt, payer: binding.payer, seller: binding.seller, releaseRef: offer.skuRef,
        priceVersion: offer.priceVersion, splitManifestHash: offer.splitManifestHash };
      const outbox = { billedInferenceMicros: '1', priorRemainderNumerator: '0', remainderNumerator: '2500', receipt,
        samples: [{ usageEventKey, sampleId: String(id), activationEventId: 'seeded-settlement-evidence' }] };
      await db.sql`UPDATE harness_shared.cupboard_funded_turns SET state = 'settled',
        funding_receipt = ${db.sql.json(funding)}, usage_event_keys = ${db.sql.json([usageEventKey])},
        closed_at_ms = 3, settlement_outbox = ${db.sql.json(outbox)}
        WHERE workspace_id = ${workspaceId} AND turn_id = ${prepared.turn.turnId}`;
      outcomes.set(workItem.id, { ...workItem, kind: 'feature', payload: {}, state: n === 3 ? 'dropped' : 'done',
        terminalOwner: owner, terminalCompletionRef: `completion-${n}`, completionAuthority: 'committed',
        terminalCompletionEvidence: { verifiedHow: 'integration', testsRun: 'vitest', testResult: 'passed' } });
    }
    // Poison rows must be excluded by the real workspace/release population query.
    const foreign = await store.prepare({ ...firstBinding!, workspaceId: workspaceId + '-foreign' });
    const otherOffer = identityPerUseOfferTerms({ identity: { id: 'another-reviewer', version: '1.0.0' }, markupBps: 2500 });
    if (!otherOffer.ok) throw new Error(otherOffer.detail);
    const otherRelease = await store.prepare({ ...firstBinding!, offerId: 'foreign-release', offer: otherOffer.terms });
    expect(foreign.ok && otherRelease.ok).toBe(true);
    const scope = { workspaceId, releaseRef: offer.skuRef };
    const deps = { readWorkItem: async (ref: { id: string }) => outcomes.get(ref.id) ?? null,
      grade: async () => ({ ok: true as const, applicable: true as const, checked: ['outcome-accepted@1'] }) };
    const read = () => readIdentityOutcomeCost(db.sql, scope, deps);
    // Independent integer oracle: three one-microUSD bills, two successes, zero settled markup.
    const result = await read();
    expect(result).toMatchObject({ status: 'verified', totalCostMicros: '3', costPerAcceptedOutcomeMicros: '2',
      acceptedOutcomes: 2, totalOutcomes: 3, turns: 3 });
    if (result.status !== 'verified') throw new Error(result.reason);
    expect(result.evidenceRefs).toEqual(expect.arrayContaining(['agent-usage-sample:401', 'agent-usage-sample:402',
      'agent-usage-sample:403', 'graded-clause:outcome-accepted@1']));
    await db.sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimated' WHERE id = 401`;
    expect(await read()).toMatchObject({ status: 'unavailable', costPerAcceptedOutcomeMicros: null,
      reason: 'identity-usage-not-bill-grade' });
    await db.sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'provider' WHERE id = 401`;
    await db.sql`UPDATE harness_shared.agent_usage_samples SET usage_event_key = NULL WHERE id = 401`;
    expect(await read()).toMatchObject({ reason: 'identity-usage-incomplete' });
    await db.sql`UPDATE harness_shared.agent_usage_samples SET usage_event_key = ${'1'.padStart(64, '0')} WHERE id = 401`;
    const item = outcomes.get('WI-outcome-1')!;
    outcomes.set(item.id, { ...item, completionAuthority: 'proposed' });
    expect(await read()).toMatchObject({ reason: 'completion-unverified' });
    outcomes.set(item.id, item);
    expect(await readIdentityOutcomeCost(db.sql, scope, { ...deps,
      grade: async () => ({ ok: true, applicable: true, checked: [] }) })).toMatchObject({ reason: 'grading-unverified' });
    const pending = await store.prepare({ ...firstBinding!, offerId: 'pending-extra-turn', nativeTurnId: 'pending-native' });
    expect(pending.ok).toBe(true);
    expect(await read()).toMatchObject({ reason: 'unsettled-turn' });
  });
});

describe('shadowMonthBounds', () => {
  it('returns UTC month bounds, end exclusive, across a year boundary', () => {
    expect(shadowMonthBounds('2026-12')).toEqual({ startMs: ms('2026-12-01T00:00:00Z'), endMs: ms('2027-01-01T00:00:00Z') });
    expect(() => shadowMonthBounds('2026-13')).toThrow(/YYYY-MM/);
    expect(() => shadowMonthBounds('2026-8')).toThrow(/YYYY-MM/);
  });
});

describe('readShadowStatement (P-003)', () => {
  it('prices one workspace-month from the attribution views', async () => {
    const st = await readShadowStatement(db.sql, { workspaceId: WS, month: MONTH });
    // In month and workspace: 101, 102, 103, 104, 108, 109.
    expect(st.inference).toEqual({ costMicros: 3_875_000, billGradeMicros: 1_000_000, samples: 6 });
    expect(st.lines).toEqual([
      { identityClass: 'domain:papercusp-engineer', basis: 'specification-layer', markupBps: 2000,
        baseMicros: 1_500_000, markupMicros: 300_000, daoMicros: 30_000, sellerMicros: 270_000, samples: 2 },
      { identityClass: 'papercusp-engineer', basis: 'inferred-profile', markupBps: 2000,
        baseMicros: 2_000_000, markupMicros: 400_000, daoMicros: 40_000, sellerMicros: 360_000, samples: 1 },
    ]);
    expect(st.totals).toEqual({ markupMicros: 700_000, daoMicros: 70_000, sellerMicros: 630_000, wouldHaveChargedMicros: 700_000 });
    expect(st.zeroPriced).toEqual({
      axisLayers: [{ layerRef: 'autonomy:su.mode-auto', baseMicros: 1_500_000 }],
      toolCalls: { attributed: 1, unattributed: 1 },
    });
    // D-018 point 4: 102/103/104/109 (estimated) and 108 (no cost) carry no price stamp; 108 is unpriced.
    expect(st.costBasis).toEqual({ priceTableVersion: PRICE_TABLE_VERSION, samples: 6, staleSamples: 5, unpricedSamples: 1, lowerBoundSamples: 0 });
    expect(st.cleanliness).toEqual({
      verdict: 'not-bill-grade',
      reasons: ['unattributed-cost', 'estimated-cost', 'inferred-base-identity', 'stale-price-table', 'unpriced-usage'],
      attributedShareBps: 9032,
      billGradeCostShareBps: 2580,
      inferredShareBps: 5714,
      unattributedMicros: 375_000,
      unclassifiedMicros: 0,
    });
  });

  it('reads slot-qualified layers only while the launch record carries the applied revision', async () => {
    const layersFor = async () => {
      const rows = await readShadowUsageAggregates(db.sql, { workspaceId: WS, month: MONTH });
      return rows.filter((r) => r.attributed)
        .map((r) => ({ agent: r.agent, profile: r.profile, layers: r.specificationLayerRefs }))
        .sort((a, b) => String(a.agent).localeCompare(String(b.agent)));
    };
    expect(await layersFor()).toEqual([
      { agent: 'claude', profile: 'engineer', layers: [] },
      { agent: 'codex', profile: 'engineer', layers: ['domain:papercusp-engineer'] },
      { agent: 'codex', profile: 'engineer', layers: ['domain:papercusp-engineer'] },
    ]);
    // Positive control for the revision gate: once the record carries SPEC_B, its layer is read.
    await db.sql`UPDATE harness_shared.adv_sessions
      SET launch_spec = jsonb_set(launch_spec, '{specificationRevision}', to_jsonb(${SPEC_B}::text)) WHERE id = 2`;
    try {
      expect((await layersFor())[0]).toEqual({ agent: 'claude', profile: 'engineer', layers: ['domain:papercusp-engineer'] });
    } finally {
      await db.sql`UPDATE harness_shared.adv_sessions
        SET launch_spec = jsonb_set(launch_spec, '{specificationRevision}', to_jsonb(${SPEC_NEWER}::text)) WHERE id = 2`;
    }
  });

  it('reads layers from identityHistory for exactly the applied revision once the record moved on (WI-10004494)', async () => {
    // Own owner: a further applied event under OWNER would close the spans the other cases price.
    const owner = 'su-shadow-reader-history';
    const specHist = 'f'.repeat(64);
    const specDecoy = 'e'.repeat(64);
    const record = {
      ...launchSpec('d'.repeat(64), 'claude', [layer('papercusp-engineer-current', ['domain'])]),
      identityHistory: [
        // A neighbouring revision: never read for a span that applied specHist.
        { specificationRevision: specDecoy, stateRevision: 'state-1',
          specificationArtifact: { inputs: [layer('decoy-engineer', ['domain'])] } },
        { specificationRevision: specHist, stateRevision: 'state-1',
          specificationArtifact: { inputs: [layer('base'), layer('papercusp-engineer', ['domain'])] } },
        // Not an artifact object: skipped rather than read.
        { specificationRevision: specHist, stateRevision: 'state-2', specificationArtifact: 'not-an-artifact' },
      ],
    };
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (3,${WS},${owner},'adv-key-3','2026-08-01T00:00:00Z',NULL,NULL,${JSON.stringify(record)}::text::jsonb)`;
    await db.sql`
      INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
         transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
      VALUES (${WS},${owner},${owner},'principal-shadow','shadow-p3',3,'native-shadow-3',
        't-hist',1,'applied','launch',${specHist},'state-1','[]'::jsonb,'2026-08-01T00:01:00Z'::timestamptz)`;
    await db.sql`INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts, cost_usd, cost_source)
      VALUES (110,${WS},'native-shadow-3',${ms('2026-08-20T00:00:00Z')},4.0,'estimated')`;
    try {
      const rows = await readShadowUsageAggregates(db.sql, { workspaceId: WS, month: MONTH });
      const hist = rows.filter((r) => r.attributed && r.costMicros === 4_000_000);
      expect(hist).toEqual([expect.objectContaining({
        agent: 'claude', profile: 'engineer', specificationLayerRefs: ['domain:papercusp-engineer'], samples: 1,
      })]);
      // The span of adv 2 applied SPEC_B, which neither its record nor any history carries: still no layers.
      expect(rows.find((r) => r.attributed && r.costMicros === 2_000_000)?.specificationLayerRefs).toEqual([]);
    } finally {
      await db.sql`DELETE FROM harness_shared.agent_usage_samples WHERE id = 110`;
      await db.sql`DELETE FROM harness_shared.session_identity_activation_events WHERE owner_id = ${owner}`;
      await db.sql`DELETE FROM harness_shared.adv_sessions WHERE id = 3`;
    }
  });

  it('prefers the activation event\'s own layer stamp over the launch record (WI-10004494 gap 3)', async () => {
    const owner = 'su-shadow-reader-stamp';
    const specStamped = '7'.repeat(64);
    // The record still carries the revision, with a DIFFERENT layer set, so the assertion can tell
    // which source answered. Preferring the stamp is what lets a span keep its layers after the
    // record has churned its revision or evicted it from identityHistory.
    const record = launchSpec(specStamped, 'claude', [layer('record-engineer', ['domain'])]);
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (4,${WS},${owner},'adv-key-4','2026-08-01T00:00:00Z',NULL,NULL,${JSON.stringify(record)}::text::jsonb)`;
    await db.sql`
      INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
         transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at,
         specification_layer_refs)
      VALUES (${WS},${owner},${owner},'principal-shadow','shadow-p4',4,'native-shadow-4',
        't-stamp',1,'applied','launch',${specStamped},'state-1','[]'::jsonb,'2026-08-01T00:01:00Z'::timestamptz,
        '["domain:stamped-engineer"]'::jsonb)`;
    await db.sql`INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts, cost_usd, cost_source)
      VALUES (111,${WS},'native-shadow-4',${ms('2026-08-20T00:00:00Z')},5.0,'estimated')`;
    const layersOfStampedRow = async () => {
      const rows = await readShadowUsageAggregates(db.sql, { workspaceId: WS, month: MONTH });
      const stamped = rows.filter((r) => r.attributed && r.costMicros === 5_000_000);
      expect(stamped).toEqual([expect.objectContaining({ agent: 'claude', samples: 1 })]);
      return stamped[0]!.specificationLayerRefs;
    };
    try {
      expect(await layersOfStampedRow()).toEqual(['domain:stamped-engineer']);
      // Positive control: unstamped, the same span falls back to the launch record's artifact.
      await db.sql`UPDATE harness_shared.session_identity_activation_events
                      SET specification_layer_refs = NULL WHERE owner_id = ${owner}`;
      expect(await layersOfStampedRow()).toEqual(['domain:record-engineer']);
    } finally {
      await db.sql`DELETE FROM harness_shared.agent_usage_samples WHERE id = 111`;
      await db.sql`DELETE FROM harness_shared.session_identity_activation_events WHERE owner_id = ${owner}`;
      await db.sql`DELETE FROM harness_shared.adv_sessions WHERE id = 4`;
    }
  });

  it('counts the cost basis against the price table it is given (D-018 point 4)', async () => {
    await db.sql`UPDATE harness_shared.agent_usage_samples
      SET price_table_version = 'v-it', usage_provenance = '{"costBound":"lower"}'::jsonb WHERE id IN (102, 103)`;
    try {
      // Stale = non-provider rows on another stamp: 104, 108, 109. Provider row 101 never counts.
      expect(await readShadowCostBasis(db.sql, { workspaceId: WS, month: MONTH, priceTableVersion: 'v-it' })).toEqual({
        workspaceId: WS, month: MONTH, priceTableVersion: 'v-it', samples: 6, staleSamples: 3, unpricedSamples: 1, lowerBoundSamples: 2,
      });
    } finally {
      await db.sql`UPDATE harness_shared.agent_usage_samples SET price_table_version = NULL, usage_provenance = NULL WHERE id IN (102, 103)`;
    }
  });

  it('returns an itemized no-usage statement for a month with no activity', async () => {
    const st = await readShadowStatement(db.sql, { workspaceId: WS, month: '2026-06' });
    expect(st).toMatchObject({ workspaceId: WS, month: '2026-06', lines: [], totals: { wouldHaveChargedMicros: 0 } });
    expect(st.zeroPriced.toolCalls).toEqual({ attributed: 0, unattributed: 0 });
    expect(st.cleanliness).toMatchObject({ verdict: 'not-bill-grade', reasons: ['no-usage'] });
  });

  it('requires full native closure and an atomic frontier before pricing the exact complete request set', async () => {
    const codexHome = await fs.mkdtemp(join(tmpdir(), 'p017-native-proof-'));
    const nativeSessionId = '1a111111-1111-4111-8111-111111111111';
    const ownerId = 'su-p017-full-source';
    const b = { workspaceId: WS, ownerId, principalId: 'principal-shadow', nativeSessionId,
      nativeTurnId: 'full-source-turn', specificationRevision: SPEC_A, stateRevision: 'state-1', codexHome };
    const dir = join(codexHome, 'sessions', '2026', '08', '20');
    await fs.mkdir(dir, { recursive: true });
    const file = join(dir, 'rollout-2026-08-20T00-00-00-' + nativeSessionId + '.jsonl');
    const line = (record: unknown) => JSON.stringify(record) + '\n';
    const usage = (n: number) => line({ type: 'event_msg', payload: { type: 'token_count', info: {
      total_token_usage: { input_tokens: n, output_tokens: 10 },
      last_token_usage: { input_tokens: 100, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 10 },
    } } });
    const transcript = line({ type: 'session_meta', payload: { id: nativeSessionId } }) +
      line({ type: 'turn_context', payload: { turn_id: b.nativeTurnId, model: 'gpt-6' } }) + usage(100) + usage(200) +
      line({ type: 'event_msg', payload: { type: 'task_complete', turn_id: b.nativeTurnId } });
    await fs.writeFile(file, transcript);
    const population = closedCodexTurnPopulation({ transcript, file, fileGeneration: 0, nativeSessionId, nativeTurnId: b.nativeTurnId });
    if (!population.ok) throw new Error(population.detail);
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (202,${WS},${ownerId},'full-source-parent','2026-08-01T00:00:00Z',NULL,NULL,NULL)`;
    await db.sql`INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
      VALUES (${WS},${ownerId},${ownerId},'principal-shadow','full-source-logical',202,'full-source-parent',
        'full-source-initial',1,'applied','control',${SPEC_A},'state-1','[]'::jsonb,'2026-08-01T00:01:00Z')`;
    await db.sql`INSERT INTO harness_shared.session_turns VALUES (${WS},'codex',${nativeSessionId},${ownerId})`;
    await db.sql`INSERT INTO harness_shared.interactive_usage_files VALUES
      (${WS},${file},0,'{"initialized":true,"fileGeneration":0}'::jsonb)`;
    const sample = (id: number, key: string) => db.sql`INSERT INTO harness_shared.agent_usage_samples
      (id,workspace_id,session_id,ts,cost_usd,cost_source,usage_provenance,usage_event_key)
      VALUES (${id},${WS},${nativeSessionId},${ms('2026-08-20T00:00:00Z')},0.000999,'provider',
        ${JSON.stringify({ turnId: b.nativeTurnId, costBound: null })}::text::jsonb,${key})`;
    try {
      await sample(202, population.usageEventKeys[0]!);
      expect(await readClosedCodexTurnBilledCost(db.sql, b)).toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
      await db.sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = ${population.closedByteOffset - 1}
        WHERE file_path = ${file}`;
      expect(await readClosedCodexTurnBilledCost(db.sql, b)).toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
      await db.sql`UPDATE harness_shared.interactive_usage_files SET byte_offset = ${population.closedByteOffset}
        WHERE file_path = ${file}`;
      // One bill-grade row is still an incomplete native population.
      expect(await readClosedCodexTurnBilledCost(db.sql, b)).toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
      await sample(203, population.usageEventKeys[1]!);
      expect(await readClosedCodexTurnBilledCost(db.sql, b)).toMatchObject({ ok: true,
        billedInferenceMicros: 1998n, usageEventKeys: population.usageEventKeys });
      expect(await readClosedCodexTurnBilledCost(db.sql, { ...b, principalId: 'different' }))
        .toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
      await db.sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimated' WHERE id = 203`;
      expect(await readClosedCodexTurnBilledCost(db.sql, b)).toMatchObject({ ok: false, code: 'identity-usage-not-bill-grade' });
      await fs.writeFile(file, transcript.trimEnd());
      expect(await readClosedCodexTurnBilledCost(db.sql, b)).toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
    } finally {
      await fs.rm(codexHome, { recursive: true, force: true });
      await db.sql`DELETE FROM harness_shared.agent_usage_samples WHERE id IN (202,203)`;
      await db.sql`DELETE FROM harness_shared.interactive_usage_files WHERE file_path = ${file}`;
      await db.sql`DELETE FROM harness_shared.session_turns WHERE session_id = ${nativeSessionId}`;
      await db.sql`DELETE FROM harness_shared.session_identity_activation_events WHERE owner_id = ${ownerId}`;
      await db.sql`DELETE FROM harness_shared.adv_sessions WHERE id = 202`;
    }
  });

  it('binds exact provider cost through carry correlation and refuses partial, switched or estimated evidence', async () => {
    const usageEventKey = 'c'.repeat(64);
    const ownerId = 'su-p017-reader-carry';
    const binding = { workspaceId: WS, ownerId, principalId: 'principal-shadow',
      nativeSessionId: 'p017-carry-native', nativeTurnId: 'p017-native-turn', specificationRevision: SPEC_A,
      stateRevision: 'state-1', usageEventKeys: [usageEventKey] };
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (201,${WS},${ownerId},'p017-parent-native','2026-08-01T00:00:00Z',NULL,NULL,NULL)`;
    await db.sql`INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
      VALUES (${WS},${ownerId},${ownerId},'principal-shadow','p017-logical-session',201,'p017-parent-native',
        'p017-initial',1,'applied','control',${SPEC_A},'state-1','[]'::jsonb,'2026-08-01T00:01:00Z')`;
    await db.sql`INSERT INTO harness_shared.session_turns VALUES (${WS},'codex',${binding.nativeSessionId},${ownerId})`;
    await db.sql`INSERT INTO harness_shared.agent_usage_samples
      (id,workspace_id,session_id,ts,cost_usd,cost_source,usage_provenance,usage_event_key)
      VALUES (201,${WS},${binding.nativeSessionId},${ms('2026-08-20T00:00:00Z')},0.000999,'provider',
        ${JSON.stringify({ turnId: binding.nativeTurnId, costBound: null })}::text::jsonb,${usageEventKey})`;
    try {
      const initial = await readIdentityTurnBilledCost(db.sql, binding);
      expect(initial.ok, initial.ok ? 'verified' : `${initial.code}: ${initial.detail}`).toBe(true);
      expect(initial).toMatchObject({ ok: true, billedInferenceMicros: 999n,
        samples: [{ usageEventKey, sampleId: '201', activationEventId: expect.any(String), billedInferenceMicros: '999' }] });
      expect(await readIdentityTurnBilledCost(db.sql, { ...binding, principalId: 'other' }))
        .toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
      expect(await readIdentityTurnBilledCost(db.sql, { ...binding, specificationRevision: SPEC_NEWER }))
        .toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
      expect(await readIdentityTurnBilledCost(db.sql, { ...binding, nativeTurnId: 'later-turn' }))
        .toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
      expect(await readIdentityTurnBilledCost(db.sql, { ...binding, usageEventKeys: [usageEventKey, 'd'.repeat(64)] }))
        .toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
      expect(await readIdentityTurnBilledCost(db.sql, { ...binding, workspaceId: OTHER_WS }))
        .toMatchObject({ ok: false, code: 'identity-usage-incomplete' });
      await db.sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'estimated' WHERE id = 201`;
      expect(await readIdentityTurnBilledCost(db.sql, binding)).toMatchObject({ ok: false, code: 'identity-usage-not-bill-grade' });
      await db.sql`UPDATE harness_shared.agent_usage_samples SET cost_source = 'provider',cost_usd = 0.0000001 WHERE id = 201`;
      expect(await readIdentityTurnBilledCost(db.sql, binding)).toMatchObject({ ok: false, code: 'identity-usage-not-bill-grade' });
      await db.sql`UPDATE harness_shared.agent_usage_samples SET cost_usd = 0.000999 WHERE id = 201`;
      await db.sql`INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
         transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
        VALUES (${WS},${ownerId},${ownerId},'principal-shadow','p017-logical-session',201,${binding.nativeSessionId},
          'p017-switch',2,'applied','control',${SPEC_NEWER},'state-2','[]'::jsonb,'2026-08-19T00:00:00Z')`;
      expect(await readIdentityTurnBilledCost(db.sql, binding)).toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
      expect(await readIdentityTurnBilledCost(db.sql, { ...binding, specificationRevision: SPEC_NEWER, stateRevision: 'state-2' }))
        .toMatchObject({ ok: true, billedInferenceMicros: 999n });
      // Return to owner-only carry correlation; a conflicting native owner vetoes it.
      await db.sql`DELETE FROM harness_shared.session_identity_activation_events WHERE owner_id = ${ownerId} AND transition_id = 'p017-switch'`;
      await db.sql`INSERT INTO harness_shared.session_turns VALUES (${WS},'codex',${binding.nativeSessionId},'different-owner')`;
      expect(await readIdentityTurnBilledCost(db.sql, binding)).toMatchObject({ ok: false, code: 'identity-usage-binding-mismatch' });
    } finally {
      await db.sql`DELETE FROM harness_shared.agent_usage_samples WHERE id = 201`;
      await db.sql`DELETE FROM harness_shared.session_turns WHERE session_id = ${binding.nativeSessionId}`;
      await db.sql`DELETE FROM harness_shared.session_identity_activation_events WHERE owner_id = ${ownerId}`;
      await db.sql`DELETE FROM harness_shared.adv_sessions WHERE id = 201`;
    }
  });
});
