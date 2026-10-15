import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../test/_pg-helpers';
import {
  acknowledgeControlTransition,
  applyRelaunchedActivation,
  convergeActivationToLaunchRecord,
  failControlTransitionActivation,
  markControlTransitionPrepared,
} from './agent-tools/coordination/control-anchor';
import { recordCurrentSessionIdentityActivation, recordSessionIdentityReanchor } from './session-identity-attribution';

const here = dirname(fileURLToPath(import.meta.url));
const migration = resolve(here, '../../../libs/papercusp/libs/db/sql/1149-session-identity-activation-spans.sql');
const carryMigration = resolve(here, '../../../libs/papercusp/libs/db/sql/1177-identity-usage-carry-correlation.sql');
// WI-10004451: the same attribution rule, evaluated without a per-row window recompute.
const indexedSpansMigration = resolve(here, '../../../libs/papercusp/libs/db/sql/1275-identity-attribution-indexed-spans.sql');
// The activation transaction fences the wearer's applied package installations
// (control-anchor -> applySessionPackageResources), so it reads this table even
// when the compiled artifact journals no package.
const packageInstallationsMigration = resolve(here, '../../../libs/papercusp/libs/db/sql/1232-blueprint-package-installations.sql');
// WI-10004494 gap 3: the recorder stamps the slotted layer set of the applied revision.
const layerRefsMigration = resolve(here, '../../../libs/papercusp/libs/db/sql/1295-activation-event-specification-layer-refs.sql');
const WS = 'identity-activation-test';
const OWNER = 'su-identity-test';
const SPEC_A = 'a'.repeat(64);
const SPEC_B = 'b'.repeat(64);

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('session-identity-attribution');
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
    -- The real table's column prefix, in order: 1177 selected u.* and 1275
    -- names these columns explicitly, so the two agree only on this shape.
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
    CREATE TABLE harness_shared.session_archives (
      adv_session_id bigint, session_id text NOT NULL
    );
    -- The key paths of 1275 look sessions up by session_id. Production indexes that on
    -- adv_sessions (adv_sessions_session_id_idx) and reaches it on session_archives through
    -- its (workspace_id, source_kind, session_id) primary key, which this two-column
    -- fixture stands in for. Without them the WI-10004477 cost guard measures a join
    -- order production never runs.
    CREATE INDEX adv_sessions_session_id_idx ON harness_shared.adv_sessions (session_id);
    CREATE INDEX session_archives_session_idx ON harness_shared.session_archives (session_id);
    CREATE TABLE harness_shared.session_turns (
      workspace_id text NOT NULL, source_kind text NOT NULL,
      session_id text NOT NULL, owner text
    );
    -- The activation transaction also replaces the wearer's async-rule
    -- subscriptions (applySessionPackageResources -> replaceIdentityRuleSubscriptions,
    -- P-018). Faithful to 123 + WI-4119's derived_from pair + 1257's 'muted' mode.
    CREATE TABLE harness_shared.coord_entity_subscriptions (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id text NOT NULL DEFAULT 'default' CHECK (workspace_id <> ''),
      subscriber_id text NOT NULL,
      target_kind text NOT NULL CHECK (target_kind IN ('topic','object','fleet','event')),
      target_ref text NOT NULL CHECK (target_ref <> ''),
      delivery_mode text NOT NULL DEFAULT 'full' CHECK (delivery_mode IN ('full','digest','mention','muted')),
      expires_ts timestamptz, created_at timestamptz NOT NULL DEFAULT now(), cancelled_at timestamptz,
      follow_blockers boolean NOT NULL DEFAULT false, derived_from_kind text, derived_from_ref text
    );
    CREATE UNIQUE INDEX coord_entity_subscriptions_active_uq ON harness_shared.coord_entity_subscriptions
      (workspace_id, subscriber_id, target_kind, target_ref) WHERE cancelled_at IS NULL;
  `);
  await applyMigrationForTest(db.sql, migration);
  await applyMigrationForTest(db.sql, carryMigration);
  await applyMigrationForTest(db.sql, indexedSpansMigration);
  await applyMigrationForTest(db.sql, layerRefsMigration);
  await db.sql.unsafe(`
    DO $r$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
    DO $r$ BEGIN CREATE ROLE harness_zero; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
  `).simple();
  await applyMigrationForTest(db.sql, packageInstallationsMigration);
}, 90_000);

afterAll(async () => db?.cleanup());

const ms = (iso: string) => new Date(iso).getTime();

/** A launch record carrying a real compiled specification, as the kernel resolver requires. */
function compiledLaunch(seed: string, stateRevision = `state-${seed}`) {
  const artifact = compileAgentSpecification({
    source: { id: `attribution-${seed}`, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
    prompt: { role: 'worker', text: `attribution fixture ${seed}` },
    inputClosure: [],
  });
  const revision = { specificationRevision: artifact.specificationRevision, stateRevision };
  return { revision, launchSpec: { ...revision, specificationArtifact: artifact } };
}

async function event(input: {
  id: number; phase: string; at: string; spec: string; state: string;
  stack: string[]; transition: string; source?: string; failure?: string | null;
}) {
  await db.sql`
    INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,
       stack_refs,failure,recorded_at)
    VALUES (${WS},${OWNER},'actor-stable','principal-stable','session-stable',1,'native-a',
      ${input.transition},${input.id},${input.phase},${input.source ?? 'control'},${input.spec},
      ${input.state},${JSON.stringify(input.stack)}::text::jsonb,${input.failure ?? null},${input.at}::timestamptz)`;
}

describe('P-009 activation span views', () => {
  it('keeps failed/pending switches on the prior applied span and joins switch, revocation, and restart', async () => {
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (1,${WS},${OWNER},'native-a','2026-09-09T00:00:00Z',NULL)`;
    await db.sql`INSERT INTO harness_shared.session_archives VALUES (1,'native-old')`;

    await event({ id: 1, phase: 'applied', at: '2026-09-09T00:01:00Z', spec: SPEC_A,
      state: 'state-a', stack: ['domain:researcher','autonomy:su.mode-auto'], transition: 'a' });
    await event({ id: 2, phase: 'desired', at: '2026-09-09T00:02:00Z', spec: SPEC_B,
      state: 'state-b', stack: ['domain:writer'], transition: 'b' });
    await event({ id: 2, phase: 'failed', at: '2026-09-09T00:03:00Z', spec: SPEC_B,
      state: 'state-b', stack: ['domain:writer'], transition: 'b', failure: 'render failed' });
    await event({ id: 3, phase: 'applied', at: '2026-09-09T00:04:00Z', spec: SPEC_B,
      state: 'state-b', stack: ['domain:writer'], transition: 'b-retry' });
    await event({ id: 4, phase: 'applied', at: '2026-09-09T00:05:00Z', spec: SPEC_B,
      state: 'revoked', stack: [], transition: 'revoke' });
    await event({ id: 5, phase: 'applied', at: '2026-09-09T00:06:00Z', spec: SPEC_B,
      state: 'revoked', stack: [], transition: 'restart', source: 'restart' });

    await db.sql`INSERT INTO harness_shared.tool_invocations VALUES
      (11,${WS},${OWNER},'2026-09-09T00:03:30Z'),
      (12,${WS},${OWNER},'2026-09-09T00:04:30Z'),
      (13,${WS},${OWNER},'2026-09-09T00:05:30Z')`;
    await db.sql`INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts) VALUES
      (21,${WS},'native-old',${ms('2026-09-09T00:03:30Z')}),
      (22,${WS},'native-a',${ms('2026-09-09T00:06:30Z')}),
      (23,${WS},'native-carry-successor',${ms('2026-09-09T00:03:45Z')})`;
    // A carry respawn rewrites adv_sessions.session_id in place. The existing
    // session_turns index retains the successor native id and its owner, which
    // is the only safe bridge for this intermediate sample.
    await db.sql`INSERT INTO harness_shared.session_turns VALUES
      (${WS},'codex','native-carry-successor',${OWNER})`;

    const tools = await db.sql<Array<{ id: string; identity_state_revision: string; identity_stack_refs: string[] }>>`
      SELECT id::text, identity_state_revision, identity_stack_refs
        FROM harness_shared.tool_invocations_identity_attribution ORDER BY id`;
    expect(tools).toEqual([
      { id: '11', identity_state_revision: 'state-a', identity_stack_refs: ['domain:researcher','autonomy:su.mode-auto'] },
      { id: '12', identity_state_revision: 'state-b', identity_stack_refs: ['domain:writer'] },
      { id: '13', identity_state_revision: 'revoked', identity_stack_refs: [] },
    ]);

    const usage = await db.sql<Array<{ id: string; identity_transition_id: string }>>`
      SELECT id::text, identity_transition_id
        FROM harness_shared.agent_usage_samples_identity_attribution ORDER BY id`;
    expect(usage).toEqual([
      { id: '21', identity_transition_id: 'a' },
      { id: '22', identity_transition_id: 'restart' },
      { id: '23', identity_transition_id: 'a' },
    ]);

    const layers = await db.sql<Array<{ layer_ref: string; active_until: Date }>>`
      SELECT layer_ref, active_until FROM harness_shared.session_identity_layer_spans
       WHERE transition_id='a' ORDER BY layer_ref`;
    expect(layers.map((row) => row.layer_ref)).toEqual(['autonomy:su.mode-auto','domain:researcher']);
    expect(new Date(layers[0]!.active_until).toISOString()).toBe('2026-09-09T00:04:00.000Z');
  });

  it('records the exact current generation idempotently through the store', async () => {
    const revision = { specificationRevision: SPEC_A, stateRevision: 'store-state' };
    const activation = {
      schemaVersion: 1, attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: revision, prepared: revision, applied: null, status: 'prepared',
    };
    await db.sql`INSERT INTO harness_shared.session_briefs
      (owner_id,workspace_id,native_session_id,control_generation,control_state)
      VALUES (${OWNER},${WS},'native-a',99,${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;
    const input = { workspaceId: WS, ownerId: OWNER, generation: 99, phase: 'prepared' as const,
      source: 'control' as const, revision, sql: db.sql };
    await expect(recordCurrentSessionIdentityActivation(input)).resolves.toBe('inserted');
    await expect(recordCurrentSessionIdentityActivation(input)).resolves.toBe('replayed');
  });

  // WI-10004917: applied events were written only on control transitions, so a CLI
  // relaunch that changed no control state left the new native id with no span, and
  // the owner-by-native-session oracle (the goal-brief R-3 probe's exact query) read
  // that incarnation's turns as foreign.
  it('opens a span for each re-anchored native incarnation, idempotently (WI-10004917)', async () => {
    const owner = 'su-reanchor-span';
    const revision = { specificationRevision: SPEC_B, stateRevision: 'reanchor-state' };
    const activation = {
      schemaVersion: 1, attribution: { actorId: owner, principalId: owner, sessionId: owner },
      desired: revision, prepared: revision, applied: revision, status: 'applied',
    };
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (95,${WS},${owner},'reanchor-old','2026-09-12T00:00:00Z',NULL)`;
    await db.sql`INSERT INTO harness_shared.session_briefs
      (owner_id,workspace_id,native_session_id,control_generation,control_state)
      VALUES (${owner},${WS},NULL,40,${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;
    await expect(recordCurrentSessionIdentityActivation({
      workspaceId: WS, ownerId: owner, generation: 40, phase: 'applied', source: 'control',
      revision, recordedAt: '2026-09-12T00:01:00Z', sql: db.sql,
    })).resolves.toBe('inserted');
    const ownersOf = (native: string) => db.sql`
      SELECT DISTINCT owner_id, workspace_id FROM harness_shared.session_identity_activation_spans
       WHERE native_session_id = ${native}`;
    const reanchor = (native: string) => recordSessionIdentityReanchor({
      workspaceId: WS, ownerId: owner, nativeSessionId: native, sql: db.sql });

    // Positive control: the oracle cannot resolve the relaunched incarnation yet.
    expect(await ownersOf('reanchor-new')).toEqual([]);
    expect(await ownersOf('reanchor-old')).toEqual([{ owner_id: owner, workspace_id: WS }]);

    await db.sql`UPDATE harness_shared.adv_sessions SET session_id='reanchor-new' WHERE id=95`;
    await expect(reanchor('reanchor-new')).resolves.toBe('inserted');
    // A retried or duplicated report converges on the one span.
    await expect(reanchor('reanchor-new')).resolves.toBe('replayed');
    expect(await ownersOf('reanchor-new')).toEqual([{ owner_id: owner, workspace_id: WS }]);

    const spans = () => db.sql<Array<{ native_session_id: string; source: string; open: boolean; stack_refs: string[] }>>`
      SELECT native_session_id, source, active_until IS NULL AS open, stack_refs
        FROM harness_shared.session_identity_activation_spans
       WHERE owner_id = ${owner} ORDER BY active_from, activation_event_id`;
    // The predecessor's span closes at the re-anchor; the new one carries the same stack.
    expect(await spans()).toEqual([
      { native_session_id: 'reanchor-old', source: 'control', open: false, stack_refs: ['domain:researcher'] },
      { native_session_id: 'reanchor-new', source: 'reanchor', open: true, stack_refs: ['domain:researcher'] },
    ]);

    // A later return to an earlier id (a --resume rung) opens a fresh span, not a replay.
    await expect(reanchor('reanchor-old')).resolves.toBe('inserted');
    expect((await spans()).map((row) => [row.native_session_id, row.open])).toEqual([
      ['reanchor-old', false], ['reanchor-new', false], ['reanchor-old', true],
    ]);
  });

  it('records nothing for a re-anchor while no revision is applied (WI-10004917)', async () => {
    const owner = 'su-reanchor-unapplied';
    const revision = { specificationRevision: SPEC_B, stateRevision: 'unapplied-state' };
    const activation = {
      schemaVersion: 1, attribution: { actorId: owner, principalId: owner, sessionId: owner },
      desired: revision, prepared: null, applied: null, status: 'desired',
    };
    await db.sql`INSERT INTO harness_shared.session_briefs
      (owner_id,workspace_id,native_session_id,control_generation,control_state)
      VALUES (${owner},${WS},NULL,3,${JSON.stringify({ activation })}::text::jsonb)`;
    await expect(recordSessionIdentityReanchor({
      workspaceId: WS, ownerId: owner, nativeSessionId: 'unapplied-native', sql: db.sql,
    })).resolves.toBe('missing');
    await expect(recordSessionIdentityReanchor({
      workspaceId: WS, ownerId: 'su-no-brief', nativeSessionId: 'unapplied-native', sql: db.sql,
    })).resolves.toBe('missing');
    const [{ n }] = await db.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM harness_shared.session_identity_activation_events
       WHERE owner_id IN (${owner}, 'su-no-brief')`;
    expect(n).toBe(0);
  });

  // WI-10004494 gap 3 (migration 1295). Metering used to re-resolve a span's layers from the launch
  // record, which churns its revision per relaunch and evicts identityHistory past 12, so most
  // spans lost them. The recorder now stamps them while the artifact is reachable.
  it('stamps the slotted layer set of the recorded revision and keeps it after the launch record moves on', async () => {
    const owner = 'su-layer-stamp';
    const specHist = '1'.repeat(64);
    const specCurrent = '2'.repeat(64);
    const specUnknown = '3'.repeat(64);
    const layerInput = (ref: string, slots?: string[]) => ({
      kind: 'blueprint-layer', ref,
      document: { id: ref, ...(slots ? { slots: slots.map((slot) => ({ slot })) } : {}) },
    });
    const artifact = (specificationRevision: string, inputs: unknown[]) => ({ specificationRevision, inputs });
    const setRecord = (launchSpec: unknown) => db.sql`
      UPDATE harness_shared.adv_sessions SET launch_spec = ${JSON.stringify(launchSpec)}::text::jsonb WHERE id = 9501`;
    const record = async (specificationRevision: string, generation: number) => {
      const revision = { specificationRevision, stateRevision: `stamp-state-${generation}` };
      const activation = {
        schemaVersion: 1, attribution: { actorId: owner, principalId: 'principal-stamp', sessionId: 'session-stamp' },
        desired: revision, prepared: revision, applied: revision, status: 'applied',
      };
      await db.sql`INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_state)
        VALUES (${owner},${WS},'native-stamp',${generation},${JSON.stringify({ activation, stack: [] })}::text::jsonb)
        ON CONFLICT (owner_id) DO UPDATE
          SET control_generation = EXCLUDED.control_generation, control_state = EXCLUDED.control_state`;
      await expect(recordCurrentSessionIdentityActivation({
        workspaceId: WS, ownerId: owner, generation, phase: 'applied', source: 'control', revision, sql: db.sql,
      })).resolves.toBe('inserted');
    };
    const stampOf = async (generation: number) => {
      const rows = await db.sql<Array<{ refs: unknown }>>`
        SELECT specification_layer_refs AS refs FROM harness_shared.session_identity_activation_events
         WHERE workspace_id = ${WS} AND owner_id = ${owner} AND control_generation = ${generation}`;
      expect(rows).toHaveLength(1);
      return rows[0]!.refs;
    };
    const histLayers = ['collaboration-stance:su-collaborator', 'domain:papercusp-engineer'];

    await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (9501,${WS},${owner},'native-stamp','2026-10-01T00:00:00Z','{}'::jsonb)`;
    try {
      await setRecord({
        specificationRevision: specCurrent,
        specificationArtifact: artifact(specCurrent, [layerInput('base')]),
        identityHistory: [
          // Same container revision, but the artifact hashes to another revision: never read.
          { specificationRevision: specHist, specificationArtifact: artifact('4'.repeat(64), [layerInput('decoy', ['domain'])]) },
          { specificationRevision: specHist, specificationArtifact: artifact(specHist, [
            layerInput('base'),
            layerInput('papercusp-engineer', ['domain']),
            layerInput('su-collaborator', ['collaboration-stance']),
          ]) },
        ],
      });
      await record(specHist, 1);    // from identityHistory, slot-qualified and sorted
      await record(specCurrent, 2); // the current artifact: known, nothing slotted
      await record(specUnknown, 3); // no artifact hashes to it anywhere
      expect(await stampOf(1)).toEqual(histLayers);
      expect(await stampOf(2)).toEqual([]);
      // NULL (unknown) must stay distinct from [] (known, none slotted): only NULL is a gap.
      expect(await stampOf(3)).toBeNull();

      // The record relaunches and evicts the entry. A later activation of the same revision still
      // gets its layers, from the stamp already taken rather than the now-lossy record.
      await setRecord({ specificationRevision: specCurrent, specificationArtifact: artifact(specCurrent, []), identityHistory: [] });
      await record(specHist, 4);
      expect(await stampOf(4)).toEqual(histLayers);

      // The migration's backfill fills only what is NULL and reachable now, never rewriting a stamp.
      await setRecord({
        specificationRevision: specUnknown,
        specificationArtifact: artifact(specUnknown, [layerInput('researcher', ['domain'])]),
        identityHistory: [{ specificationRevision: specHist, specificationArtifact: artifact(specHist, []) }],
      });
      await applyMigrationForTest(db.sql, layerRefsMigration);
      expect(await stampOf(3)).toEqual(['domain:researcher']);
      expect(await stampOf(1)).toEqual(histLayers);
      expect(await stampOf(4)).toEqual(histLayers);
    } finally {
      await db.sql`DELETE FROM harness_shared.session_identity_activation_events WHERE owner_id = ${owner}`;
      await db.sql`DELETE FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
      await db.sql`DELETE FROM harness_shared.adv_sessions WHERE id = 9501`;
    }
  });

  it('preserves intermediate carry usage after reanchor without widening owner, workspace or applied-time attribution', async () => {
    const owner = 'su-carry-attribution';
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (90,${WS},${owner},'carry-middle','2026-09-10T00:00:00Z',NULL)`;
    // As in a real carry, host acceptance predates native registration: the
    // receipt still names the preceding native id, on the same stable adv row.
    await db.sql`INSERT INTO harness_shared.session_identity_activation_events
      (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
       transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
      VALUES
      (${WS},${owner},${owner},'principal-carry','logical-carry',90,'carry-before',
       'carry-applied',90,'applied','control',${SPEC_A},'carry-state','["domain:researcher"]','2026-09-10T00:01:00Z'),
      (${WS},${owner},${owner},'principal-carry','logical-carry',90,'carry-before',
       'carry-pending',91,'desired','control',${SPEC_B},'pending-state','["domain:writer"]','2026-09-10T00:02:00Z'),
      (${WS},${owner},${owner},'principal-carry','logical-carry',90,'carry-middle',
       'carry-revoked',92,'applied','control',${SPEC_B},'revoked-state','[]','2026-09-10T00:04:00Z')`;
    await db.sql`INSERT INTO harness_shared.session_turns VALUES
      ('default','codex','carry-middle',${owner}),
      ('default','codex','carry-middle',NULL),
      ('foreign-workspace','codex','carry-foreign',${owner}),
      ('default','agent_chat','carry-chat',${owner}),
      ('default','codex','carry-ambiguous',${owner}),
      ('default','codex','carry-ambiguous','another-owner')`;
    await db.sql`INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts) VALUES
      (901,${WS},'carry-middle',${ms('2026-09-10T00:03:00Z')}),
      (902,${WS},'carry-middle',${ms('2026-09-10T00:00:30Z')}),
      (903,${WS},'carry-middle',${ms('2026-09-10T00:04:00Z')}),
      (904,${WS},'carry-foreign',${ms('2026-09-10T00:03:00Z')}),
      (905,${WS},'carry-chat',${ms('2026-09-10T00:03:00Z')}),
      (906,${WS},'carry-ambiguous',${ms('2026-09-10T00:03:00Z')}),
      (907,'foreign-workspace','carry-middle',${ms('2026-09-10T00:03:00Z')}),
      (908,${WS},'carry-before',${ms('2026-09-10T00:03:00Z')})`;
    const read = () => db.sql`
      SELECT id::text, identity_transition_id, identity_owner_id
        FROM harness_shared.agent_usage_samples_identity_attribution WHERE id >= 901 ORDER BY id`;
    const expected = [
      { id: '901', identity_transition_id: 'carry-applied', identity_owner_id: owner },
      { id: '902', identity_transition_id: null, identity_owner_id: null },
      { id: '903', identity_transition_id: 'carry-revoked', identity_owner_id: owner },
      ...['904', '905', '906', '907'].map((id) => ({ id, identity_transition_id: null, identity_owner_id: null })),
      { id: '908', identity_transition_id: 'carry-applied', identity_owner_id: owner },
    ];
    expect(await read()).toEqual(expected);
    await db.sql`UPDATE harness_shared.adv_sessions SET session_id='carry-after' WHERE id=90`;
    expect(await read()).toEqual(expected);

    // Calibrate the regression against the actual predecessor view, not a
    // hand-written approximation: after reanchor it loses the middle native id
    // even though the applied event and transcript-owner mapping still exist.
    // Only this disposable database is changed; never downgrade the live view.
    await applyMigrationForTest(db.sql, migration);
    try {
      const [withoutBridge] = await db.sql`
        SELECT identity_transition_id, identity_owner_id
          FROM harness_shared.agent_usage_samples_identity_attribution WHERE id=901`;
      expect(withoutBridge).toEqual({
        identity_transition_id: null,
        identity_owner_id: null,
      });
      const [positiveControl] = await db.sql`
        SELECT identity_transition_id
          FROM harness_shared.agent_usage_samples_identity_attribution WHERE id=908`;
      expect(positiveControl).toEqual({ identity_transition_id: 'carry-applied' });
    } finally {
      await applyMigrationForTest(db.sql, carryMigration);
      await applyMigrationForTest(db.sql, indexedSpansMigration);
    }
    // The repaired view restores the historical sample without weakening the
    // pending/revocation, workspace, source-kind, or ambiguous-owner exclusions.
    expect(await read()).toEqual(expected);
  });

  // WI-10004451: 1177 re-derived the windowed spans view once per sample row, so one
  // hour of production samples exceeded 30s. 1275 evaluates the same rule as two
  // indexed candidate sets. This pins it to the rule it replaced: the rows are read
  // under 1275, then under the real 1149+1177 definitions, and must match on the
  // shapes the carry fixture lacks (two span partitions for one owner, an
  // equal-timestamp tie, a span cut by its session's end, keyless samples, and a
  // session key reached while a different single owner holds the transcript).
  it('evaluates the 1177 attribution rule without a per-row window (WI-10004451)', async () => {
    const owner = 'su-indexed-spans';
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (70,${WS},${owner},'idx-native-1','2026-09-11T00:00:00Z','2026-09-11T00:30:00Z'),
      (71,${WS},${owner},'idx-native-2','2026-09-11T00:10:00Z',NULL)`;
    const applied = (row: { gen: number; session: string; adv: number; native: string; transition: string; at: string }) => db.sql`
      INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
         transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
      VALUES (${WS},${owner},${owner},'principal-idx',${row.session},${row.adv},${row.native},
        ${row.transition},${row.gen},'applied','control',${SPEC_A},${`state-${row.transition}`},'[]',${row.at}::timestamptz)`;
    await applied({ gen: 1, session: 'idx-p1', adv: 70, native: 'idx-native-1', transition: 'idx-1', at: '2026-09-11T00:01:00Z' });
    await applied({ gen: 2, session: 'idx-p2', adv: 71, native: 'idx-native-2', transition: 'idx-2', at: '2026-09-11T00:10:00Z' });
    await applied({ gen: 3, session: 'idx-p2', adv: 71, native: 'idx-native-2', transition: 'idx-3', at: '2026-09-11T00:20:00Z' });
    await applied({ gen: 4, session: 'idx-p2', adv: 71, native: 'idx-native-2', transition: 'idx-4', at: '2026-09-11T00:20:00Z' });
    await applied({ gen: 5, session: 'idx-p1', adv: 70, native: 'idx-native-1', transition: 'idx-5', at: '2026-09-11T00:40:00Z' });
    // idx-native-1 has one transcript owner (the owner path); idx-native-2 has none
    // (keys only); idx-two-owners has two owners and no keys. idx-archived-cross is
    // archived under adv 71 while ANOTHER single owner holds its transcript: the owner
    // veto guards only the owner path, so 1177 still attributes it through the key.
    await db.sql`INSERT INTO harness_shared.session_turns VALUES
      ('default','claude','idx-native-1',${owner}),
      ('default','claude','idx-two-owners',${owner}),
      ('default','claude','idx-two-owners','another-owner'),
      ('default','claude','idx-archived-cross','another-owner')`;
    await db.sql`INSERT INTO harness_shared.session_archives VALUES (71,'idx-archived-cross')`;
    let id = 800;
    const samples: Array<[number, string | null, number]> = [];
    for (const session of ['idx-native-1', 'idx-native-2', 'idx-two-owners', null, 'idx-archived-cross']) {
      for (const at of ['00:00:30', '00:05:00', '00:15:00', '00:20:00', '00:25:00', '00:35:00', '00:45:00']) {
        samples.push([id++, session, ms(`2026-09-11T${at}Z`)]);
      }
    }
    for (const [sampleId, session, ts] of samples) {
      await db.sql`INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts)
        VALUES (${sampleId},${WS},${session},${ts})`;
    }
    const read = () => db.sql<Array<Record<string, unknown>>>`
      SELECT id::text, identity_activation_event_id::text, identity_owner_id, identity_session_id,
             identity_transition_id, identity_state_revision, identity_stack_refs
        FROM harness_shared.agent_usage_samples_identity_attribution
       WHERE id BETWEEN 800 AND ${id - 1} ORDER BY id`;
    const planOf = async () => JSON.stringify(await db.sql.unsafe(
      'EXPLAIN (FORMAT JSON) SELECT * FROM harness_shared.agent_usage_samples_identity_attribution WHERE id = 815'));

    const indexed = await read();
    expect(await planOf()).not.toContain('WindowAgg');
    // Non-vacuous: owner path, key path, the tie's later event, both partitions,
    // and the cross-owner key the owner veto must not block.
    const transitionAt = (sampleId: number) => indexed.find((row) => row.id === String(sampleId))?.identity_transition_id;
    expect(transitionAt(802)).toBe('idx-2');   // idx-native-1 00:15: latest-started X span
    expect(transitionAt(803)).toBe('idx-4');   // tie at 00:20: the later id wins
    expect(transitionAt(805)).toBe('idx-4');   // 00:35: p1 ended with adv 70, p2 still open
    expect(transitionAt(806)).toBe('idx-4');   // 00:45: idx-5 opened after its session ended
    expect(transitionAt(809)).toBe('idx-2');   // idx-native-2 (keys only) 00:15
    expect(transitionAt(801)).toBe('idx-1');   // idx-native-1 00:05: owner path reaches p1
    expect(transitionAt(808)).toBeNull();      // idx-native-2 00:05: its keys reach only p2
    expect(indexed.filter((row) => Number(row.id) >= 814 && Number(row.id) <= 827)
      .every((row) => row.identity_transition_id === null)).toBe(true);
    expect(transitionAt(828)).toBeNull();      // idx-archived-cross 00:00:30: before p2
    expect(transitionAt(830)).toBe('idx-2');   // 00:15: archive key, despite another owner
    expect(transitionAt(831)).toBe('idx-4');   // 00:20

    await applyMigrationForTest(db.sql, migration);
    await applyMigrationForTest(db.sql, carryMigration);
    try {
      // Positive control for the plan assertion: the predecessor does window per row.
      expect(await planOf()).toContain('WindowAgg');
      expect(await read()).toEqual(indexed);
    } finally {
      await applyMigrationForTest(db.sql, indexedSpansMigration);
    }
  });

  // WI-10004477, the recurrence guard for WI-10004451. The case above pins the plan of a
  // one-row read and the window construct 1177 used. This pins the COST CLASS, for the
  // shape the shadow-metering reader actually runs (a workspace time range, grouped by
  // span): attributing a sample must not read activation events of OTHER owners. 1177 did,
  // once per sample, which is why one production hour (7,689 samples) passed 30s; 1275
  // reads it in ~1.7s. Measured as rows the plan touches on the events table, so it holds
  // whatever SQL construct a regression uses and does not depend on wall-clock speed.
  // The fixture is sized so production's plan is also the cheapest one here: at ~100 events
  // the planner rightly hash-joins whole tables (measured 2026-10-01: every event read per
  // sample under 1275, though production's 11,727 events cost 57.5 rows per sample).
  it('reads no other owner\'s activation events to attribute a sample (WI-10004477)', async () => {
    const ws = 'identity-attribution-scale';
    const owner = 'su-scale-target';
    const otherOwners = 300;
    const eventsPerOwner = 10;
    const sampleCount = 40;
    const base = ms('2026-09-12T00:00:00Z');
    await db.sql`
      INSERT INTO harness_shared.session_identity_activation_events
        (workspace_id,owner_id,actor_id,principal_id,session_id,native_session_id,
         transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
      SELECT ${ws}, 'su-scale-other-' || o, 'su-scale-other-' || o, 'principal-scale', 'scale-other-' || o,
             'scale-other-native-' || o, 'scale-other-' || o || '-' || e, e + 1, 'applied', 'control', ${SPEC_A},
             'state-scale-other-' || o || '-' || e, '[]',
             to_timestamp((${base}::bigint + e * 600000)::double precision / 1000.0)
        FROM generate_series(0, ${otherOwners - 1}) o CROSS JOIN generate_series(0, ${eventsPerOwner - 1}) e`;
    for (let e = 0; e < 4; e++) {
      await db.sql`
        INSERT INTO harness_shared.session_identity_activation_events
          (workspace_id,owner_id,actor_id,principal_id,session_id,native_session_id,
           transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
        VALUES (${ws},${owner},${owner},'principal-scale','scale-target','scale-target-native',
          ${`scale-target-${e}`},${e + 1},'applied','control',${SPEC_A},${`state-scale-target-${e}`},'[]',
          to_timestamp(${base + e * 600_000}::double precision / 1000.0))`;
    }
    await db.sql`INSERT INTO harness_shared.session_turns VALUES (${ws},'claude','scale-target-native',${owner})`;
    for (let i = 0; i < sampleCount; i++) {
      await db.sql`INSERT INTO harness_shared.agent_usage_samples (id, workspace_id, session_id, ts, cost_source, cost_usd)
        VALUES (${9000 + i},${ws},'scale-target-native',${base + 30_000 + i * 60_000},'reported',0.01)`;
    }
    // Production statistics come from autovacuum; a fresh fixture has none, and the planner
    // then guesses join orders production never runs.
    await db.sql`ANALYZE harness_shared.session_identity_activation_events, harness_shared.agent_usage_samples,
      harness_shared.adv_sessions, harness_shared.session_archives, harness_shared.session_turns`;
    const otherEvents = otherOwners * eventsPerOwner;
    const examined = async () => db.sql.begin(async (tx) => {
      const [row] = await tx.unsafe(`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT identity_activation_event_id, identity_specification_revision, identity_stack_refs,
               cost_source, sum(cost_usd), count(*)
          FROM harness_shared.agent_usage_samples_identity_attribution
         WHERE workspace_id = '${ws}' AND ts >= ${base} AND ts < ${base + 3_600_000}
         GROUP BY 1, 2, 3, 4`);
      // Rows touched per node = (emitted + filtered out) per loop, times loops. The node
      // list rides in the assertion message so a regression names the scan that grew.
      const nodes: Array<{ node: string; index: unknown; loops: number; rows: number }> = [];
      const walk = (node: Record<string, unknown>) => {
        if (node['Relation Name'] === 'session_identity_activation_events') {
          const perLoop = Number(node['Actual Rows'] ?? 0) + Number(node['Rows Removed by Filter'] ?? 0)
            + Number(node['Rows Removed by Index Recheck'] ?? 0);
          const loops = Number(node['Actual Loops'] ?? 0);
          nodes.push({ node: String(node['Node Type']), index: node['Index Name'] ?? null, loops, rows: perLoop * loops });
        }
        for (const child of (node.Plans as Array<Record<string, unknown>> | undefined) ?? []) walk(child);
      };
      walk((row as unknown as { 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> })['QUERY PLAN'][0]!.Plan);
      return { rows: nodes.reduce((sum, n) => sum + n.rows, 0), nodes: JSON.stringify(nodes) };
    });
    // Non-vacuous: every sample is attributed through the owner path to a target span.
    const attributed = await db.sql<Array<{ owner: string | null; n: number }>>`
      SELECT identity_owner_id AS owner, count(*)::int AS n
        FROM harness_shared.agent_usage_samples_identity_attribution
       WHERE workspace_id = ${ws} GROUP BY 1`;
    expect(attributed).toEqual([{ owner, n: sampleCount }]);

    // Budget: half of what reading every other owner's events once per sample costs.
    const budget = (sampleCount * otherEvents) / 2;
    const indexed = await examined();
    expect(indexed.rows, indexed.nodes).toBeGreaterThan(0);
    expect(indexed.rows, indexed.nodes).toBeLessThan(budget);

    await applyMigrationForTest(db.sql, migration);
    await applyMigrationForTest(db.sql, carryMigration);
    try {
      // Positive control: the predecessor rule reads other owners' events per sample.
      const predecessor = await examined();
      expect(predecessor.rows, predecessor.nodes).toBeGreaterThanOrEqual(budget);
    } finally {
      await applyMigrationForTest(db.sql, indexedSpansMigration);
    }
  });

  // EI-23703586803892464, the measured shape: a sibling launch record minted
  // `desired`, but the kernel selects a DIFFERENT, still-open row. Acknowledging
  // would have written an `applied` that row cannot resolve — a total tool wedge.
  it('refuses to acknowledge a revision the gate-selected launch record does not run', async () => {
    const owner = `${OWNER}-sibling`;
    const running = compiledLaunch('running');
    const sibling = compiledLaunch('sibling');
    await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (9101,${WS},${owner},'native-sibling','2026-09-22T21:43:05Z',${JSON.stringify(sibling.launchSpec)}::text::jsonb),
             (9102,${WS},${owner},'native-running','2026-09-22T21:43:36Z',${JSON.stringify(running.launchSpec)}::text::jsonb)`;
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: sibling.revision,
      prepared: sibling.revision,
      applied: running.revision,
      status: 'prepared',
    };
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-running',50,49,${JSON.stringify({ activation })}::text::jsonb)`;

    await expect(acknowledgeControlTransition(owner, WS, 50, db.sql, sibling.revision)).resolves.toBe(false);

    const [row] = await db.sql<Array<{ delivered: string; applied: unknown; status: string }>>`
      SELECT control_delivered_generation::text AS delivered,
             control_state->'activation'->'applied' AS applied,
             control_state #>> '{activation,status}' AS status
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(row).toEqual({ delivered: '49', applied: running.revision, status: 'prepared' });
  });

  // EI-23886889674609842 defect #1 on real PG: relaunched on `desired`, render failed.
  it('converges applied to the relaunched desired but leaves the delivery watermark pending', async () => {
    const owner = `${OWNER}-converge`;
    const relaunched = compiledLaunch('relaunched');
    const previous = compiledLaunch('previous').revision;
    await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (9201,${WS},${owner},'native-converge','2026-09-22T22:00:00Z',${JSON.stringify(relaunched.launchSpec)}::text::jsonb)`;
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: relaunched.revision, prepared: null, applied: previous, status: 'failed',
    };
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-converge',60,59,${JSON.stringify({ activation })}::text::jsonb)`;

    await expect(convergeActivationToLaunchRecord(owner, WS, 60, relaunched.revision, db.sql)).resolves.toBe(true);
    // Idempotent: once applied resolves, a retry on the next failed render is a no-op.
    await expect(convergeActivationToLaunchRecord(owner, WS, 60, relaunched.revision, db.sql)).resolves.toBe(false);

    const [row] = await db.sql<Array<{ delivered: string; applied: unknown; status: string }>>`
      SELECT control_delivered_generation::text AS delivered,
             control_state->'activation'->'applied' AS applied,
             control_state #>> '{activation,status}' AS status
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(row).toEqual({ delivered: '59', applied: relaunched.revision, status: 'applied' });
  });

  // WI-10003459 (residual) on real PG: a carry-respawn's launch artifact IS the
  // consumption, so `applied` must follow it on the relaunch's FIRST turn — while an
  // in-place flip (control-sourced desired) keeps waiting for delivery proof.
  describe('applies a restart onto the launched revision at the relaunch (WI-10003459)', () => {
    const seed = async (owner: string, advId: number, launch: ReturnType<typeof compiledLaunch>,
      desired: { specificationRevision: string; stateRevision: string },
      applied: { specificationRevision: string; stateRevision: string }, source: string) => {
      await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
        VALUES (${advId},${WS},${owner},'native-successor','2026-09-27T14:19:37Z',${JSON.stringify(launch.launchSpec)}::text::jsonb)`;
      const activation = {
        schemaVersion: 1,
        attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
        desired, prepared: null, applied, status: 'desired',
      };
      await db.sql`
        INSERT INTO harness_shared.session_briefs
          (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
        VALUES (${owner},${WS},'native-successor',69,67,${JSON.stringify({ activation })}::text::jsonb)`;
      await db.sql`
        INSERT INTO harness_shared.session_identity_activation_events
          (workspace_id,owner_id,actor_id,principal_id,session_id,adv_session_id,native_session_id,
           transition_id,control_generation,phase,source,specification_revision,state_revision,stack_refs,recorded_at)
        VALUES (${WS},${owner},'actor-stable','principal-stable','session-stable',${advId},'native-previous',
          ${`t-${owner}`},69,'desired',${source},${desired.specificationRevision},${desired.stateRevision},
          '[]'::jsonb,'2026-09-27T14:19:37Z')`;
    };
    const state = async (owner: string) => {
      const [row] = await db.sql<Array<{ delivered: string; applied: unknown; status: string; receipts: string }>>`
        SELECT b.control_delivered_generation::text AS delivered,
               b.control_state->'activation'->'applied' AS applied,
               b.control_state #>> '{activation,status}' AS status,
               (SELECT count(*)::text FROM harness_shared.session_identity_activation_events e
                 WHERE e.owner_id = b.owner_id AND e.phase = 'applied') AS receipts
          FROM harness_shared.session_briefs b WHERE b.owner_id = ${owner}`;
      return row;
    };

    it('restart + launch record carrying desired: applied at the first turn, watermark untouched, ack replays idempotently', async () => {
      const owner = `${OWNER}-relaunch`;
      const next = compiledLaunch('relaunch-next');
      const previous = compiledLaunch('relaunch-prev').revision;
      await seed(owner, 9401, next, next.revision, previous, 'restart');

      await expect(applyRelaunchedActivation(owner, WS, 69, next.revision, db.sql)).resolves.toBe(true);
      expect(await state(owner)).toEqual({ delivered: '67', applied: next.revision, status: 'applied', receipts: '1' });
      // A retry (e.g. a non-identity bump before the ack) appends no second receipt.
      await expect(applyRelaunchedActivation(owner, WS, 69, next.revision, db.sql)).resolves.toBe(false);
      // Prepare leaves an already-applied revision alone; the later delivery proof
      // advances the watermark and replays the SAME transition id, not a new span.
      await expect(markControlTransitionPrepared(owner, WS, 69, next.revision, db.sql)).resolves.toBe(true);
      await expect(acknowledgeControlTransition(owner, WS, 69, db.sql, next.revision)).resolves.toBe(true);
      expect(await state(owner)).toEqual({ delivered: '69', applied: next.revision, status: 'applied', receipts: '1' });
    });

    it('an in-place (control-sourced) flip back to the launched revision still waits for delivery proof', async () => {
      const owner = `${OWNER}-inplace`;
      const launched = compiledLaunch('inplace-launched');
      const flipped = compiledLaunch('inplace-flipped').revision;
      await seed(owner, 9402, launched, launched.revision, flipped, 'control');

      await expect(applyRelaunchedActivation(owner, WS, 69, launched.revision, db.sql)).resolves.toBe(false);
      expect(await state(owner)).toEqual({ delivered: '67', applied: flipped, status: 'desired', receipts: '0' });
    });

    // WI-10004663: a single-turn session (headless one-shot, consult answer) never
    // produces the next-turn delivery proof, so before this it stayed `prepared` for
    // life with no span and all its usage unattributed. Its launch artifact IS the
    // consumption, exactly like a restart.
    it('a fresh launch onto the launch record\'s revision is applied at the first turn (WI-10004663)', async () => {
      const owner = `${OWNER}-fresh-launch`;
      const launched = compiledLaunch('fresh-launch');
      const none = compiledLaunch('fresh-launch-prior').revision;
      await seed(owner, 9404, launched, launched.revision, none, 'launch');

      await expect(applyRelaunchedActivation(owner, WS, 69, launched.revision, db.sql)).resolves.toBe(true);
      expect(await state(owner)).toEqual({ delivered: '67', applied: launched.revision, status: 'applied', receipts: '1' });
      // The span opens on that receipt — usage from the first turn on is attributed.
      const [span] = await db.sql<Array<{ spec: string }>>`
        SELECT specification_revision AS spec FROM harness_shared.session_identity_activation_spans
         WHERE owner_id = ${owner}`;
      expect(span?.spec).toBe(launched.revision.specificationRevision);
    });

    it('a fresh launch whose launch record carries a different revision is refused (WI-10004663)', async () => {
      const owner = `${OWNER}-fresh-mismatch`;
      const recorded = compiledLaunch('fresh-mismatch-recorded');
      const wanted = compiledLaunch('fresh-mismatch-wanted').revision;
      await seed(owner, 9405, recorded, wanted, recorded.revision, 'launch');

      await expect(applyRelaunchedActivation(owner, WS, 69, wanted, db.sql)).resolves.toBe(false);
      expect(await state(owner)).toEqual({ delivered: '67', applied: recorded.revision, status: 'desired', receipts: '0' });
    });

    it('a restart whose relaunch never landed (launch record still the predecessor) is refused', async () => {
      const owner = `${OWNER}-unlanded`;
      const predecessor = compiledLaunch('unlanded-prev');
      const wanted = compiledLaunch('unlanded-next').revision;
      await seed(owner, 9403, predecessor, wanted, predecessor.revision, 'restart');

      await expect(applyRelaunchedActivation(owner, WS, 69, wanted, db.sql)).resolves.toBe(false);
      expect(await state(owner)).toEqual({ delivered: '67', applied: predecessor.revision, status: 'desired', receipts: '0' });
    });
  });

  // P-008 (identity-native-applied-revision-proof) failed-injection negative control
  // on REAL Postgres. The launch record runs `desired` in every case, so the ONLY
  // thing separating Applied from refused is whether the host actually prepared
  // (injected) that revision. The unit tests mock this SQL and can only string-match
  // the `prepared = revision` guard; here Postgres evaluates it.
  describe('reports Applied only after the host injected the selected revision', () => {
    async function seedInjection(suffix: string, id: number, generation: number, injection: {
      prepared: 'revision' | null; status: 'desired' | 'prepared' | 'failed'; failure?: string;
    }) {
      const owner = `${OWNER}-inject-${suffix}`;
      const selected = compiledLaunch(`inject-${suffix}`);
      const previous = compiledLaunch(`inject-${suffix}-previous`).revision;
      await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
        VALUES (${id},${WS},${owner},${`native-inject-${suffix}`},'2026-09-26T00:00:00Z',${JSON.stringify(selected.launchSpec)}::text::jsonb)`;
      const activation = {
        schemaVersion: 1,
        attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
        desired: selected.revision,
        prepared: injection.prepared === 'revision' ? selected.revision : null,
        applied: previous,
        status: injection.status,
        ...(injection.failure ? { failure: injection.failure } : {}),
      };
      await db.sql`
        INSERT INTO harness_shared.session_briefs
          (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
        VALUES (${owner},${WS},${`native-inject-${suffix}`},${generation},${generation - 1},
          ${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;
      return { owner, revision: selected.revision, previous };
    }

    async function readBack(owner: string) {
      const [brief] = await db.sql<Array<{ delivered: string; applied: unknown; status: string }>>`
        SELECT control_delivered_generation::text AS delivered,
               control_state->'activation'->'applied' AS applied,
               control_state #>> '{activation,status}' AS status
          FROM harness_shared.session_briefs
         WHERE owner_id = ${owner}`;
      const events = await db.sql<Array<{ phase: string; specification_revision: string }>>`
        SELECT phase, specification_revision
          FROM harness_shared.session_identity_activation_events
         WHERE owner_id = ${owner} AND phase = 'applied'`;
      return { brief, events };
    }

    it.each([
      ['staged (desired, never prepared)', 'staged', 9301, 81, { prepared: null, status: 'desired' }],
      ['failed (render failed, prepare skipped)', 'failed', 9302, 82, { prepared: null, status: 'failed', failure: 'render failed' }],
    ] as const)('refuses a %s injection: applied, watermark and receipts stay unchanged', async (_label, suffix, id, generation, injection) => {
      const seeded = await seedInjection(suffix, id, generation, injection);

      await expect(acknowledgeControlTransition(seeded.owner, WS, generation, db.sql, seeded.revision)).resolves.toBe(false);

      const { brief, events } = await readBack(seeded.owner);
      expect(brief).toEqual({ delivered: String(generation - 1), applied: seeded.previous, status: injection.status });
      expect(events).toEqual([]);
    });

    it('positive control: the same launch record with a prepared injection IS acknowledged and receipted', async () => {
      const seeded = await seedInjection('prepared', 9303, 83, { prepared: 'revision', status: 'prepared' });

      await expect(acknowledgeControlTransition(seeded.owner, WS, 83, db.sql, seeded.revision)).resolves.toBe(true);

      const { brief, events } = await readBack(seeded.owner);
      expect(brief).toEqual({ delivered: '83', applied: seeded.revision, status: 'applied' });
      expect(events).toEqual([{ phase: 'applied', specification_revision: seeded.revision.specificationRevision }]);
    });

    // WI-10003459: measured on a live Claude su session — every carry-respawn
    // prepared generation N, then a non-identity control write (orient, loop,
    // scope) bumped the brief to N+1 with the SAME activation. The ack's UPDATE
    // accepts control_generation >= N, but the applied receipt demanded exact
    // equality, returned 'missing', threw, and rolled the whole ack back — so
    // `applied` never landed and the retry failed identically every turn.
    it('acknowledges a prepared generation after an unrelated control bump, but never a future one', async () => {
      const seeded = await seedInjection('bumped', 9304, 84, { prepared: 'revision', status: 'prepared' });
      await db.sql`UPDATE harness_shared.session_briefs SET control_generation = 85 WHERE owner_id = ${seeded.owner}`;

      // Negative control: the receipt still refuses a generation the brief has not reached.
      await expect(recordCurrentSessionIdentityActivation({
        ownerId: seeded.owner, workspaceId: WS, generation: 86, phase: 'prepared', source: 'control',
        revision: seeded.revision, sql: db.sql,
      })).resolves.toBe('missing');

      await expect(acknowledgeControlTransition(seeded.owner, WS, 84, db.sql, seeded.revision)).resolves.toBe(true);

      const { brief, events } = await readBack(seeded.owner);
      expect(brief).toEqual({ delivered: '84', applied: seeded.revision, status: 'applied' });
      expect(events).toEqual([{ phase: 'applied', specification_revision: seeded.revision.specificationRevision }]);
      const [receipt] = await db.sql<Array<{ control_generation: string }>>`
        SELECT control_generation::text FROM harness_shared.session_identity_activation_events
         WHERE owner_id = ${seeded.owner} AND phase = 'applied'`;
      expect(receipt).toEqual({ control_generation: '84' });
    });

    // WI-10003464: measured on a live Claude su (2026-09-27) — every applied
    // generation was followed ~250 ms later by a 'prepared' receipt for the NEXT
    // generation at the SAME revision, so between turns status read 'prepared'
    // with desired == prepared == applied.
    async function markApplied(owner: string, revision: unknown, status: 'applied' | 'desired') {
      await db.sql`UPDATE harness_shared.session_briefs
         SET control_state = jsonb_set(
               jsonb_set(control_state, '{activation,applied}', ${JSON.stringify(revision)}::text::jsonb, true),
               '{activation,status}', ${JSON.stringify(status)}::text::jsonb, true)
       WHERE owner_id = ${owner}`;
    }
    async function activationOf(owner: string) {
      const [row] = await db.sql<Array<{ status: string; prepared: unknown }>>`
        SELECT control_state #>> '{activation,status}' AS status, control_state->'activation'->'prepared' AS prepared
          FROM harness_shared.session_briefs WHERE owner_id = ${owner}`;
      const prepared = await db.sql`SELECT 1 FROM harness_shared.session_identity_activation_events
        WHERE owner_id = ${owner} AND phase = 'prepared'`;
      return { ...row, preparedReceipts: prepared.length };
    }

    it('does not re-mark an already-applied revision prepared on a non-identity bump, and still advances the watermark', async () => {
      const seeded = await seedInjection('reapplied', 9305, 88, { prepared: null, status: 'desired' });
      await markApplied(seeded.owner, seeded.revision, 'applied');

      await expect(markControlTransitionPrepared(seeded.owner, WS, 88, seeded.revision, db.sql)).resolves.toBe(true);
      expect(await activationOf(seeded.owner)).toEqual({ status: 'applied', prepared: null, preparedReceipts: 0 });

      await expect(acknowledgeControlTransition(seeded.owner, WS, 88, db.sql, seeded.revision)).resolves.toBe(true);
      const { brief } = await readBack(seeded.owner);
      expect(brief).toEqual({ delivered: '88', applied: seeded.revision, status: 'applied' });
    });

    it('positive control: a same-revision restart (status desired) still prepares and receipts', async () => {
      const seeded = await seedInjection('restart', 9306, 89, { prepared: null, status: 'desired' });
      await markApplied(seeded.owner, seeded.revision, 'desired');

      await expect(markControlTransitionPrepared(seeded.owner, WS, 89, seeded.revision, db.sql)).resolves.toBe(true);
      expect(await activationOf(seeded.owner)).toEqual({
        status: 'prepared', prepared: seeded.revision, preparedReceipts: 1,
      });
    });
  });

  it('rolls back applied state and watermark when the event insert fails', async () => {
    const owner = `${OWNER}-atomic`;
    const previous = { specificationRevision: SPEC_A, stateRevision: 'previous' };
    // The ack guard admits only a revision the selected launch record resolves,
    // so this record must carry a REAL compiled specification — which also makes
    // reaching the forced event failure below the real-PG proof that it admits.
    const { revision, launchSpec } = compiledLaunch('atomic', 'next');
    await db.sql`INSERT INTO harness_shared.adv_sessions (id,workspace_id,coord_owner_id,session_id,started_at,launch_spec)
      VALUES (9001,${WS},${owner},'native-atomic','2026-09-22T00:00:00Z',${JSON.stringify(launchSpec)}::text::jsonb)`;
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: revision,
      prepared: revision,
      applied: previous,
      status: 'prepared',
    };
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-atomic',123,122,
        ${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.fail_atomic_activation_event()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.owner_id = '${owner}' THEN
          RAISE EXCEPTION 'forced activation event failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_atomic_activation_event
      BEFORE INSERT ON harness_shared.session_identity_activation_events
      FOR EACH ROW EXECUTE FUNCTION harness_shared.fail_atomic_activation_event();
    `);

    await expect(
      acknowledgeControlTransition(owner, WS, 123, db.sql, revision),
    ).rejects.toThrow('forced activation event failure');

    const [row] = await db.sql<Array<{
      delivered: string;
      applied: unknown;
      status: string;
    }>>`
      SELECT control_delivered_generation::text AS delivered,
             control_state->'activation'->'applied' AS applied,
             control_state #>> '{activation,status}' AS status
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(row).toEqual({ delivered: '122', applied: previous, status: 'prepared' });
  });

  it('retains the applied revision and records a failed phase when activation fails', async () => {
    const owner = `${OWNER}-failclosed`;
    const previous = { specificationRevision: SPEC_A, stateRevision: 'applied-previous' };
    const revision = { specificationRevision: SPEC_B, stateRevision: 'desired-next' };
    const activation = {
      schemaVersion: 1,
      attribution: { actorId: 'actor-stable', principalId: 'principal-stable', sessionId: 'session-stable' },
      desired: revision,
      prepared: revision,
      applied: previous,
      status: 'prepared',
    };
    await db.sql`INSERT INTO harness_shared.adv_sessions VALUES
      (7,${WS},${owner},'native-failclosed','2026-09-17T00:00:00Z',NULL)`;
    await db.sql`
      INSERT INTO harness_shared.session_briefs
        (owner_id,workspace_id,native_session_id,control_generation,control_delivered_generation,control_state)
      VALUES (${owner},${WS},'native-failclosed',77,76,
        ${JSON.stringify({ activation, stack: ['domain:researcher'] })}::text::jsonb)`;

    await expect(
      failControlTransitionActivation(owner, WS, 77, revision, 'render failed', db.sql),
    ).resolves.toBe(true);

    // The authority reduction must fail CLOSED: the session keeps the revision it had
    // already applied rather than dropping to the one that failed to render. Retention
    // is by omission from the jsonb_set chain, so only reading `applied` back can catch
    // a regression that starts clearing it.
    const [brief] = await db.sql<Array<{
      applied: unknown; prepared: unknown; status: string; failure: string;
    }>>`
      SELECT control_state->'activation'->'applied' AS applied,
             control_state->'activation'->'prepared' AS prepared,
             control_state #>> '{activation,status}' AS status,
             control_state #>> '{activation,failure}' AS failure
        FROM harness_shared.session_briefs
       WHERE owner_id = ${owner}`;
    expect(brief).toEqual({ applied: previous, prepared: null, status: 'failed', failure: 'render failed' });

    const events = await db.sql<Array<{ phase: string; failure: string; specification_revision: string }>>`
      SELECT phase, failure, specification_revision
        FROM harness_shared.session_identity_activation_events
       WHERE owner_id = ${owner}`;
    expect(events).toEqual([{ phase: 'failed', failure: 'render failed', specification_revision: SPEC_B }]);
  });
});
