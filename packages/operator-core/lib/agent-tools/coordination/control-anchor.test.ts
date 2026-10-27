import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { compileAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { deriveClaimScope, rearmControlWitnessForContextWipe } from './control-anchor';
import {
  ACTIVATION_CONSUMER_READ_PATH,
  CONTROL_ANCHOR_MAX_TOKENS,
  CONTROL_TRANSITION_MAX_TOKENS,
  CONTROL_TRANSITION_SCHEMA,
  acknowledgeControlTransition,
  controlStateHash,
  convergeActivationToLaunchRecord,
  failControlTransitionActivation,
  markControlTransitionPrepared,
  decideControlTransitionDelivery,
  estimateControlAnchorTokens,
  normalizeControlAnchorState,
  preparePendingControlTransition,
  projectGoalHolderAuthority,
  persistControlAnchor,
  renderControlAnchor,
  type ControlAnchorState,
} from './control-anchor';

function state(overrides: Partial<ControlAnchorState> = {}): ControlAnchorState {
  return {
    modes: ['ideate', 'auto', 'auto'],
    loop: { active: true, intervalSec: 60 },
    carry: 'warm',
    route: { kind: 'self' },
    scope: {
      workspace: 'papercusp-workspace',
      harness: 'papercusp',
      plan: 'agent-operability-improvements-implementation-2026-07-13',
      items: ['P-014', 'P-013', 'P-013'],
    },
    ...overrides,
  };
}

function inMemoryPersistSql() {
  let generation = 0;
  let current: ControlAnchorState | null = null;
  let updatedAt = '2026-07-13T18:00:00.000Z';
  let tick = 0;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const fragment = narrowingFragment(strings, values);
    if (fragment) return fragment;
    const next = JSON.parse(String(values[2])) as ControlAnchorState;
    if (current == null || JSON.stringify(current) !== JSON.stringify(next)) {
      generation += 1;
      current = next;
      updatedAt = `2026-07-13T18:00:0${tick++}.000Z`;
    }
    return Promise.resolve([{
      control_generation: generation,
      control_state: current,
      control_updated_at: updatedAt,
      control_transition: null,
    }]);
  }) as unknown as Sql;
  return sql;
}

/**
 * The gate read's narrowing is a postgres.js FRAGMENT (narrowedLaunchSpecSql,
 * identity-receipt-narrowing.ts, WI-10004801): built with `sql`…`` and never
 * awaited, then interpolated into the read as its first value. It is not a
 * query, so the fakes below answer it synchronously with a marker carrying the
 * `want` parameter (null = the record is read whole), record no call and
 * consume no scripted result.
 */
function narrowingFragment(strings: readonly string[], values: unknown[]) {
  const text = strings.join(' ').trim();
  if (text.startsWith('((EXCLUDED.control_state')) return { lifecycleFragment: true };
  if (text === 'n.launch_spec') return { narrowedLaunchSpecFragment: true, want: null };
  return text.startsWith('CASE') && text.includes('identityHistory')
    ? { narrowedLaunchSpecFragment: true, want: values[0] }
    : null;
}

function sqlReturning<T>(rows: T[]) {
  const calls: Array<{ statement: string; values: unknown[] }> = [];
  const query = async (strings: TemplateStringsArray, values: unknown[]) => {
    calls.push({ statement: strings.join(' '), values });
    return rows;
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    narrowingFragment(strings, values) ?? query(strings, values)) as unknown as Sql;
  Object.assign(sql as object, {
    begin: async (callback: (tx: Sql) => Promise<unknown>) => callback(sql),
  });
  return { sql, calls };
}

/**
 * A launch record carrying a REAL compiled specification, so the ack guard is
 * exercised through the kernel's own resolver rather than a stub. `seed` varies
 * the prompt, and therefore the specificationRevision.
 */
function launched(seed: string) {
  const artifact = compileAgentSpecification({
    source: { id: `ack-${seed}`, workItem: { kind: 'feature' }, spine: { edges: { DONE: { to: 'done' } } } },
    prompt: { role: 'worker', text: `ack fixture ${seed}` },
    inputClosure: [],
  });
  const revision = { specificationRevision: artifact.specificationRevision, stateRevision: `state-${seed}` };
  return { artifact, revision, launchSpec: { ...revision, specificationArtifact: artifact } };
}

function transactionalSqlSequence(results: unknown[][]) {
  const calls: Array<{ statement: string; values: unknown[] }> = [];
  let committed = false;
  let rolledBack = false;
  const query = async (strings: TemplateStringsArray, values: unknown[]) => {
    calls.push({ statement: strings.join(' '), values });
    return results.shift() ?? [];
  };
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    narrowingFragment(strings, values) ?? query(strings, values)) as unknown as Sql;
  const sql = tx;
  Object.assign(sql as object, {
    begin: async (callback: (transaction: Sql) => Promise<unknown>) => {
      try {
        const value = await callback(tx);
        committed = true;
        return value;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    },
  });
  return { sql, calls, committed: () => committed, rolledBack: () => rolledBack };
}

describe('CTRL anchor wakeSource (WI-7302 part 2)', () => {
  it('OMITS wakeSource entirely when the leg did not resolve — absent is UNKNOWN', () => {
    // Never normalize an unresolved leg into 'none': that is a positive,
    // escalation-worthy claim ("nothing will ever wake this session") and a
    // degraded query must not be able to manufacture it.
    const out = normalizeControlAnchorState(state());
    expect('wakeSource' in out).toBe(false);
  });

  it('carries a resolved wakeSource through normalization', () => {
    expect(normalizeControlAnchorState({ ...state(), wakeSource: 'none' })).toMatchObject({
      wakeSource: 'none',
    });
    expect(normalizeControlAnchorState({ ...state(), wakeSource: 'event' })).toMatchObject({
      wakeSource: 'event',
    });
  });

  it('preserves the durable released lifecycle marker in the compact anchor', () => {
    expect(
      normalizeControlAnchorState({
        ...state(),
        lifecycle: { released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' } },
      }),
    ).toMatchObject({
      lifecycle: { released: { fleet: 'backend', at: '2026-08-20T10:00:00Z', by: 'su-leader' } },
    });
  });

  it('stays inside the anchor token budget with wakeSource present', () => {
    // The anchor is re-delivered on every post-compaction orient, which is why
    // the prose warning lives on the recovery block and only a short enum
    // lives here.
    const withField = estimateControlAnchorTokens(
      normalizeControlAnchorState({ ...state(), wakeSource: 'none' }),
    );
    expect(withField).toBeLessThan(CONTROL_ANCHOR_MAX_TOKENS);
  });
});

describe('compact durable CTRL anchor', () => {
  it('projects a truthful desired activation envelope without inventing applied state', () => {
    const activation = {
      schemaVersion: 1 as const,
      attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
      desired: { specificationRevision: 'a'.repeat(64), stateRevision: '1' },
      prepared: null,
      applied: null,
      status: 'desired' as const,
    };
    const normalized = normalizeControlAnchorState(state({ activation }));
    expect(normalized.activation).toMatchObject({ desired: activation.desired, prepared: null, applied: null, status: 'desired' });
  });

  it('carries a deterministic superseded stand-down and omits ordinary authority', () => {
    const superseded = projectGoalHolderAuthority({
      status: 'superseded',
      goalId: 'goal-42',
      electedOwnerId: 'holder-new',
      electedEpoch: 7,
      handoffExpiresAt: '2026-08-30T10:00:00.000Z',
    });
    expect(normalizeControlAnchorState(state({ goalAuthority: superseded }))).toMatchObject({
      goalAuthority: {
        status: 'superseded',
        goalId: 'goal-42',
        electedOwnerId: 'holder-new',
        electedEpoch: 7,
        standDown: true,
      },
    });
    expect(projectGoalHolderAuthority({
      status: 'elected',
      goalId: 'goal-42',
      electedOwnerId: 'holder-new',
      electedEpoch: 7,
      handoffExpiresAt: null,
    })).toBeUndefined();
  });

  it('canonicalizes duplicated modes/items so equivalent reads are byte-stable', () => {
    expect(normalizeControlAnchorState(state())).toMatchObject({
      modes: ['auto', 'ideate'],
      scope: { items: ['P-013', 'P-014'] },
    });
  });

  it('fingerprints normalized state rather than delivery generation', () => {
    const base = state({ modes: ['auto'], scope: { ...state().scope, items: ['P-014', 'P-013'] } });
    const reordered = state({ modes: ['auto'], scope: { ...state().scope, items: ['P-013', 'P-014'] } });
    expect(controlStateHash(base)).toBe(controlStateHash(reordered));
    expect(controlStateHash(base)).not.toBe(controlStateHash({ ...base, carry: 'cold' }));
  });

  it('holds generation on an unchanged reconciliation and increments on semantic change', async () => {
    const sql = inMemoryPersistSql();
    const a = await persistControlAnchor(
      { ownerId: 'su-x', workspaceId: 'papercusp-workspace', state: state() },
      sql,
    );
    const b = await persistControlAnchor(
      { ownerId: 'su-x', workspaceId: 'papercusp-workspace', state: state() },
      sql,
    );
    const c = await persistControlAnchor(
      {
        ownerId: 'su-x',
        workspaceId: 'papercusp-workspace',
        state: state({ carry: 'cold' }),
      },
      sql,
    );
    expect([a.generation, b.generation, c.generation]).toEqual([1, 1, 2]);
    expect(b.updatedAt).toBe(a.updatedAt);
    expect(c.updatedAt).not.toBe(b.updatedAt);
  });

  describe('consumer-attested write (EI-23770243810745552)', () => {
    const activation = (stateRevision: string) => ({
      schemaVersion: 1 as const,
      attribution: { actorId: 'actor', principalId: 'principal', sessionId: 'session' },
      desired: { specificationRevision: 'a'.repeat(64), stateRevision },
      prepared: null,
      applied: null,
      status: 'desired' as const,
    });

    it('an agreeing write attests no divergence and renders NO consumerView key', async () => {
      const persisted = await persistControlAnchor(
        { ownerId: 'su-x', workspaceId: 'papercusp-workspace', state: state({ activation: activation('1') }) },
        inMemoryPersistSql(),
      );
      expect(persisted.consumerView.divergedFromWrite).toBe(false);
      expect(persisted.consumerView.readPath).toBe(ACTIVATION_CONSUMER_READ_PATH);
      const anchor = renderControlAnchor({ ownerId: 'su-x', ...persisted });
      expect('consumerView' in anchor).toBe(false);
    });

    it('a write whose consumer read returns a DIFFERENT activation is reported, not ok-by-silence', async () => {
      // The WI-10002021 decoy: the row the enforcement port reads holds an older activation
      // than the one this write intended. Same fake, but RETURNING serves the stale read path.
      const honest = inMemoryPersistSql();
      const decoy = ((strings: TemplateStringsArray, ...values: unknown[]) => {
        const fragment = narrowingFragment(strings, values);
        if (fragment) return fragment;
        return (async () => {
          const [row] = await (honest as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<Array<Record<string, unknown>>>)(strings, ...values);
          return [{ ...row, control_state: { ...(row?.control_state as object), activation: activation('STALE') } }];
        })();
      }) as unknown as Sql;
      const persisted = await persistControlAnchor(
        { ownerId: 'su-x', workspaceId: 'papercusp-workspace', state: state({ activation: activation('2') }) },
        decoy,
      );
      expect(persisted.consumerView.divergedFromWrite).toBe(true);
      expect(persisted.consumerView.value?.desired.stateRevision).toBe('STALE');
      const anchor = renderControlAnchor({ ownerId: 'su-x', ...persisted });
      expect(anchor.consumerView).toEqual(persisted.consumerView);
      // Behavior-neutral: the anchor's authoritative state/hash are unchanged by the attestation.
      expect(anchor.stateHash).toBe(controlStateHash(persisted.state));
    });

    it('a state with no activation attests agreement (null == null), not divergence', async () => {
      const persisted = await persistControlAnchor(
        { ownerId: 'su-x', workspaceId: 'papercusp-workspace', state: state() },
        inMemoryPersistSql(),
      );
      expect(persisted.consumerView).toEqual({
        readPath: ACTIVATION_CONSUMER_READ_PATH,
        value: null,
        divergedFromWrite: false,
      });
    });
  });

  it('carries provenance, a full-resync rule, and an enforced serialized token budget', () => {
    const anchor = renderControlAnchor({
      ownerId: 'su-x',
      generation: 9,
      state: state({
        scope: {
          ...state().scope,
          items: Array.from({ length: 40 }, (_, i) => `P-${String(i).padStart(3, '0')}`),
        },
      }),
      updatedAt: '2026-07-13T18:00:00.000Z',
    });
    expect(anchor.state.scope.items).toHaveLength(12);
    expect(anchor.state.scope.itemsMore).toBe(28);
    expect(anchor.resync).toEqual({
      on: ['missing-base', 'schema-mismatch', 'generation-mismatch'],
      verb: 'coord:orient',
      args: { afterCompaction: true },
      rule: 'replace-full-never-merge-behind',
    });
    expect(anchor.provenance.source).toBe('harness_shared.session_briefs.control_state');
    expect(anchor.stateHash).toBe(controlStateHash(anchor.state));
    expect(anchor.budget.estimatedTokens).toBe(estimateControlAnchorTokens(anchor));
    expect(anchor.budget.estimatedTokens).toBeLessThanOrEqual(CONTROL_ANCHOR_MAX_TOKENS);
  });

  it('delivers only an exact next-generation transition and preserves mutation provenance', () => {
    const transition = {
      schemaVersion: CONTROL_TRANSITION_SCHEMA,
      targetOwnerId: 'su-x',
      previousGeneration: 4,
      generation: 5,
      state: state({ carry: 'cold' }),
      provenance: {
        origin: 'owner' as const,
        actorId: 'su-x',
        source: 'mode:set' as const,
        ownerDirected: true,
        recordedAt: '2026-07-13T18:01:00.000Z',
      },
      resync: {
        verb: 'coord:orient' as const,
        args: { afterCompaction: true as const },
        rule: 'replace-full-never-merge-behind' as const,
      },
    };
    const delivery = decideControlTransitionDelivery({
      ownerId: 'su-x',
      deliveredGeneration: 4,
      generation: 5,
      state: transition.state,
      transition,
      updatedAt: transition.provenance.recordedAt,
    });
    expect(delivery).toMatchObject({
      kind: 'transition',
      reason: 'next-generation',
      previousGeneration: 4,
      generation: 5,
      provenance: { origin: 'owner', actorId: 'su-x', ownerDirected: true },
    });
    expect(delivery.budget.estimatedTokens).toBeLessThanOrEqual(CONTROL_TRANSITION_MAX_TOKENS);
    expect(delivery.stateHash).toBe(controlStateHash(delivery.state));
  });

  // WI-10002005 recurrence guard. The budget assertion in the test above runs on
  // the DEFAULT fixture, which is comfortably small — it passes whether or not a
  // realistic control state fits, so it cannot catch the anchor outgrowing its
  // budget. THIS one renders a MAXIMAL state, and it is the assertion that
  // actually fails when the anchor grows.
  //
  // Why it is load-bearing: renderControlTransitionDelivery THROWS the moment the
  // estimate crosses CONTROL_TRANSITION_MAX_TOKENS, and turn-start's catch
  // swallows that throw so the prompt is never blocked. The failure is therefore
  // SILENT — the whole ⟦CTRL⟧ block simply disappears, taking with it the
  // generation-mismatch signal that is the carry marker's only escape hatch
  // (WI-10002017). Nothing errors, so only a test can catch this regression.
  //
  // Measured 2026-09-20 on a live session: ONE mode, TWO stack layers, a 60-char
  // fleet slug and both revision pairs already rendered at 351 of 384 tokens —
  // 33 tokens of headroom. Adding modes or layers is what crosses it.
  it('keeps a MAXIMAL control state inside the transition token budget', () => {
    const fleet = 'goal-drain-work-on-everything-fresh-grading-and-impro-60d3a8';
    // Pin the slug width: the budget is sensitive to it, and a shortened fixture
    // would silently weaken this guard.
    expect(fleet).toHaveLength(60);
    const revision = (seed: string) => ({
      specificationRevision: seed.repeat(64).slice(0, 64),
      stateRevision: seed.repeat(24).slice(0, 24),
    });
    const maximal = state({
      modes: ['auto', 'ideate', 'drain', 'audit'],
      stack: [
        'autonomy:su.mode-auto',
        'ideation:su.mode-ideate',
        'objective:su.mode-drain',
        'fleet-posture:su.fleet-member',
      ],
      wakeSource: 'loop',
      carry: 'cold',
      route: { kind: 'fleet', fleet, role: 'member' },
      activation: {
        schemaVersion: 1,
        attribution: {
          actorId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
          principalId: 'system:superuser',
          sessionId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
        },
        desired: revision('a'),
        prepared: null,
        applied: revision('b'),
        status: 'desired',
      },
    } as Partial<ControlAnchorState>);
    const transition = {
      schemaVersion: CONTROL_TRANSITION_SCHEMA,
      targetOwnerId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
      previousGeneration: 14,
      generation: 17,
      state: maximal,
      provenance: {
        origin: 'system' as const,
        actorId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
        source: 'session:activation' as const,
        ownerDirected: false,
        recordedAt: '2026-09-20T04:25:43.092Z',
      },
      resync: {
        verb: 'coord:orient' as const,
        args: { afterCompaction: true as const },
        rule: 'replace-full-never-merge-behind' as const,
      },
    };
    // WI-10002024 FIXED — this is the `toBeLessThanOrEqual` form the pin above
    // instructed its fixer to restore. The ceiling is now enforced HERE, at build
    // time, rather than by a render-time throw that the caller swallows.
    const delivered = decideControlTransitionDelivery({
      ownerId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
      deliveredGeneration: 14,
      generation: 17,
      state: maximal,
      transition,
      updatedAt: transition.provenance.recordedAt,
    });
    expect(delivered).not.toBeNull();
    expect(delivered?.budget.estimatedTokens).toBeLessThanOrEqual(CONTROL_TRANSITION_MAX_TOKENS);
    expect(delivered?.budget.overBudget).toBeUndefined();
    // Calibration: the fixture must stay genuinely LARGE, so a future refactor
    // that quietly shrinks it cannot turn this guard into a vacuous one.
    expect(estimateControlAnchorTokens(maximal)).toBeGreaterThan(200);
    // Anti-vacuity: this fixture must still be the one that BROKE the old 384
    // ceiling. If a later change shrinks the render below 384 this assertion goes
    // red, so the guard can never quietly stop exercising the overflow it exists
    // for — the 512 ceiling would then be untested headroom rather than a bound.
    expect(delivered?.budget.estimatedTokens).toBeGreaterThan(384);
  });

  // WI-10002024: the CLASS guard. The test above enforces the CEILING; this one
  // pins the FAILURE MODE, which is what actually bricked a session.
  //
  // A budget guard must never be able to cost more than the thing it rations.
  // turn-start-memory's controlPromise SWALLOWS a throw from the renderer, so
  // throwing does not report an overflow to anybody — it silently deletes the
  // ⟦CTRL⟧ block carrying the session's authority state and its only recovery
  // signal (WI-10002005 / WI-10002017). Overflow must therefore DEGRADE: mark
  // it, and deliver it anyway. This test goes red if the throw is ever restored.
  it('DELIVERS and MARKS an over-budget control state instead of throwing it away', () => {
    // Built from the NORMALIZER'S OWN MAXIMA, so this overflow is reachable in
    // production rather than synthetic: MAX_SCOPE_ITEMS=12 entries of
    // MAX_ID_CHARS=120 is the largest scope a normalized state can carry.
    const fat = state({
      modes: ['auto', 'ideate', 'drain', 'audit'],
      stack: [
        'autonomy:su.mode-auto',
        'ideation:su.mode-ideate',
        'objective:su.mode-drain',
        'fleet-posture:su.fleet-member',
      ],
      wakeSource: 'loop',
      carry: 'cold',
      route: {
        kind: 'fleet',
        fleet: 'goal-drain-work-on-everything-fresh-grading-and-impro-60d3a8',
        role: 'member',
      },
      activation: {
        schemaVersion: 1,
        attribution: {
          actorId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
          principalId: 'system:superuser',
          sessionId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
        },
        desired: { specificationRevision: 'a'.repeat(64), stateRevision: 'a'.repeat(24) },
        prepared: null,
        applied: { specificationRevision: 'b'.repeat(64), stateRevision: 'b'.repeat(24) },
        status: 'desired',
      },
      scope: {
        workspace: 'papercusp-workspace',
        harness: 'papercusp',
        plan: 'a-deliberately-long-plan-slug-for-the-budget-overflow-guard',
        items: Array.from({ length: 12 }, (_, i) => `P-${String(i + 1).padStart(3, '0')}-${'x'.repeat(114)}`),
      },
    } as Partial<ControlAnchorState>);

    const input = {
      ownerId: 'su-56d0a9bd-9c98-4c87-8e0d-ab9ddf15ba8f',
      generation: 17,
      state: fat,
      updatedAt: '2026-09-20T04:25:43.092Z',
    };

    expect(() => renderControlAnchor(input)).not.toThrow();
    const anchor = renderControlAnchor(input);

    // The overflow is real, and it is REPORTED rather than hidden...
    expect(anchor.budget.estimatedTokens).toBeGreaterThan(CONTROL_ANCHOR_MAX_TOKENS);
    expect(anchor.budget.overBudget).toBe(true);
    // ...and the payload SURVIVED it, which is the entire point of the change.
    expect(anchor.state.scope.items).toHaveLength(12);
    expect(anchor.state.modes).toContain('auto');
    expect(anchor.stateHash).toBeTruthy();
  });

  it('separates prepare from acknowledgement so a render failure leaves the generation pending', async () => {
    const transition = {
      schemaVersion: CONTROL_TRANSITION_SCHEMA,
      targetOwnerId: 'su-x',
      previousGeneration: 4,
      generation: 5,
      state: state({ carry: 'cold' }),
      provenance: {
        origin: 'owner' as const,
        actorId: 'su-x',
        source: 'mode:set' as const,
        ownerDirected: true,
        recordedAt: '2026-07-13T18:01:00.000Z',
      },
      resync: {
        verb: 'coord:orient' as const,
        args: { afterCompaction: true as const },
        rule: 'replace-full-never-merge-behind' as const,
      },
    };
    const read = sqlReturning([{
      owner_id: 'su-x',
      control_generation: 5,
      control_state: transition.state,
      control_updated_at: transition.provenance.recordedAt,
      control_transition: transition,
      delivered_generation: 4,
    }]);

    const prepared = await preparePendingControlTransition('su-x', 'ws-test', read.sql);
    expect(prepared).toMatchObject({ generation: 5, previousGeneration: 4, kind: 'transition' });
    expect(read.calls).toHaveLength(1);
    expect(read.calls[0]!.statement).toMatch(/SELECT/);
    expect(read.calls[0]!.statement).not.toMatch(/^\s*UPDATE/);

    const ack = sqlReturning([{ control_delivered_generation: 5 }]);
    await expect(acknowledgeControlTransition('su-x', 'ws-test', 5, ack.sql)).resolves.toBe(true);
    expect(ack.calls[0]!.statement).toMatch(/UPDATE/);
    expect(ack.calls[0]!.values).toContain(5);
  });

  it('marks activation prepared/failing through conditional revision guards', async () => {
    const preparedSql = sqlReturning([{ control_generation: 5 }]);
    const revision = { specificationRevision: 'a'.repeat(64), stateRevision: '1' };
    await expect(markControlTransitionPrepared('su-x', 'ws-test', 5, revision, preparedSql.sql)).resolves.toBe(true);
    expect(preparedSql.calls[0]!.statement).toMatch(/activation/);
    expect(preparedSql.calls[0]!.values).toContain(JSON.stringify(revision));

    const failedSql = sqlReturning([{ control_generation: 5 }]);
    await expect(failControlTransitionActivation('su-x', 'ws-test', 5, revision, 'render failed', failedSql.sql)).resolves.toBe(true);
    expect(failedSql.calls[0]!.statement).toMatch(/failed/);
  });

  it('acknowledges a revision only when its prepared JSON matches (and keeps legacy SQL shape otherwise)', async () => {
    const { revision, launchSpec } = launched('b');
    const activationAck = transactionalSqlSequence([
      [{ launch_spec: launchSpec }],
      [{ control_delivered_generation: 6 }],
      [{ id: 1 }],
    ]);
    await expect(acknowledgeControlTransition('su-x', 'ws-test', 6, activationAck.sql, revision)).resolves.toBe(true);
    expect(activationAck.calls[0]!.statement).toMatch(/adv_sessions/);
    expect(activationAck.calls[1]!.statement).toMatch(/activation/);
    const legacyAck = sqlReturning([{ control_delivered_generation: 6 }]);
    await expect(acknowledgeControlTransition('su-x', 'ws-test', 6, legacyAck.sql)).resolves.toBe(true);
    // WI-10002717: the revision-less path never WRITES activation state; it only
    // refuses while an activation is pending (desired != applied). The behaviour is
    // proven against real Postgres in control-anchor-ack.integration.test.ts.
    expect(legacyAck.calls[0]!.statement).not.toMatch(/jsonb_set/);
    expect(legacyAck.calls[0]!.statement).toMatch(/'activation'->'desired' = control_state->'activation'->'applied'/);
    expect(legacyAck.calls.some((call) => /adv_sessions/.test(call.statement))).toBe(false);
  });

  it('rolls back the applied watermark when the append-only activation event cannot be recorded', async () => {
    const { revision, launchSpec } = launched('c');
    const db = transactionalSqlSequence([
      [{ launch_spec: launchSpec }],
      [{ control_delivered_generation: 7 }],
      [],
      [],
    ]);
    await expect(
      acknowledgeControlTransition('su-x', 'ws-test', 7, db.sql, revision),
    ).rejects.toThrow('session_identity_activation_applied_not_recorded');
    expect(db.rolledBack()).toBe(true);
    expect(db.committed()).toBe(false);
    expect(db.calls).toHaveLength(4);
  });

  // EI-23703586803892464: a sibling launch record minted `desired`, the gate
  // selected a different live row, and acknowledging `desired` wedged every tool.
  it.each([
    ['the selected record runs a different specification', () => [{ launch_spec: launched('e').launchSpec }]],
    ['the owner has no launch record', () => []],
    ['the selected record has no launch_spec', () => [{ launch_spec: null }]],
  ])('refuses to write applied when %s, leaving the generation pending', async (_case, selected) => {
    const { revision } = launched('f');
    const db = transactionalSqlSequence([selected(), [{ control_delivered_generation: 9 }], [{ id: 1 }]]);
    await expect(acknowledgeControlTransition('su-x', 'ws-test', 9, db.sql, revision)).resolves.toBe(false);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.statement).toMatch(/ORDER BY/);
    // WI-10004801: the gate read is narrowed to the receipt for the revision
    // being acknowledged — the only one launchRecordAdmitsApplied consults.
    expect(db.calls[0]!.values).toEqual([
      { narrowedLaunchSpecFragment: true, want: JSON.stringify([revision]) }, 'su-x', 'ws-test',
    ]);
  });

  it('still acknowledges a control-only activation (same specification, new state revision)', async () => {
    const { artifact, launchSpec } = launched('g');
    const revision = { specificationRevision: artifact.specificationRevision, stateRevision: 'state-next' };
    const db = transactionalSqlSequence([
      [{ launch_spec: launchSpec }],
      [{ control_delivered_generation: 10 }],
      [{ id: 1 }],
    ]);
    await expect(acknowledgeControlTransition('su-x', 'ws-test', 10, db.sql, revision)).resolves.toBe(true);
    expect(db.committed()).toBe(true);
  });

  // EI-23886889674609842 defect #1: a failed render after a relaunch on `desired`.
  it('converges applied to a relaunched desired on render failure WITHOUT touching the delivery watermark', async () => {
    const running = launched('h');
    const previous = launched('i').revision;
    const db = transactionalSqlSequence([
      [{ launch_spec: running.launchSpec }],
      [{ applied: previous }],
      [{ control_generation: 11 }],
      [{ id: 1 }],
    ]);
    await expect(convergeActivationToLaunchRecord('su-x', 'ws-test', 11, running.revision, db.sql)).resolves.toBe(true);
    expect(db.calls[2]!.statement).toMatch(/activation,applied/);
    expect(db.calls[2]!.statement).not.toMatch(/control_delivered_generation/);
    expect(db.committed()).toBe(true);
  });

  it('restores a failed already-applied launch revision without acknowledging undelivered stack text', async () => {
    const running = launched('render-retry');
    const db = transactionalSqlSequence([
      [{ launch_spec: running.launchSpec }],
      [{ applied: running.revision, activation_status: 'failed' }],
      [{ control_generation: 12 }],
      [{ id: 1 }],
    ]);
    await expect(convergeActivationToLaunchRecord('su-x', 'ws-test', 12, running.revision, db.sql)).resolves.toBe(true);
    expect(db.calls[2]!.statement).toMatch(/activation,status/);
    expect(db.calls[2]!.statement).not.toMatch(/control_delivered_generation/);
    expect(db.calls[3]!.statement).toMatch(/session_identity_activation_events/);
    expect(db.committed()).toBe(true);
  });

  it.each([
    ['the selected record does not run desired', () => [[{ launch_spec: launched('j').launchSpec }]], 1],
    ['the current applied still resolves (not wedged)', () => {
      const running = launched('k');
      return [[{ launch_spec: running.launchSpec }], [{ applied: { ...running.revision, stateRevision: 'older' } }]];
    }, 2],
    ['a failed render has not applied the desired state revision', () => {
      const running = launched('k');
      return [[{ launch_spec: running.launchSpec }], [{ applied: { ...running.revision, stateRevision: 'older' }, activation_status: 'failed' }]];
    }, 2],
    ['the identical revision is already healthy', () => {
      const running = launched('k');
      return [[{ launch_spec: running.launchSpec }], [{ applied: running.revision, activation_status: 'applied' }]];
    }, 2],
    ['there is no applied receipt to strand', () => [[{ launch_spec: launched('k').launchSpec }], [{ applied: null }]], 2],
  ])('does not converge when %s', async (_case, results, expectedCalls) => {
    const db = transactionalSqlSequence(results());
    await expect(convergeActivationToLaunchRecord('su-x', 'ws-test', 12, launched('k').revision, db.sql)).resolves.toBe(false);
    expect(db.calls).toHaveLength(expectedCalls);
  });

  it.each([
    ['prepared', (db: ReturnType<typeof transactionalSqlSequence>, revision: { specificationRevision: string; stateRevision: string }) =>
      markControlTransitionPrepared('su-x', 'ws-test', 8, revision, db.sql)],
    ['failed', (db: ReturnType<typeof transactionalSqlSequence>, revision: { specificationRevision: string; stateRevision: string }) =>
      failControlTransitionActivation('su-x', 'ws-test', 8, revision, 'render failed', db.sql)],
  ])('rolls back %s state when its append-only event cannot be recorded', async (phase, run) => {
    const revision = { specificationRevision: 'd'.repeat(64), stateRevision: '4' };
    const db = transactionalSqlSequence([[{ control_generation: 8 }], [], []]);
    await expect(run(db, revision)).rejects.toThrow(`session_identity_activation_${phase}_not_recorded`);
    expect(db.rolledBack()).toBe(true);
    expect(db.committed()).toBe(false);
  });

  it('rejects generation-behind payloads and full-resyncs from current anchor state', () => {
    const current = state({ carry: 'cold', modes: ['auto'] });
    const stale = {
      schemaVersion: CONTROL_TRANSITION_SCHEMA,
      targetOwnerId: 'su-x',
      previousGeneration: 2,
      generation: 3,
      state: state({ carry: 'warm', modes: ['ideate'] }),
      provenance: {
        origin: 'agent' as const,
        actorId: 'su-old',
        source: 'loop:arm' as const,
        ownerDirected: false,
        recordedAt: '2026-07-13T18:00:00.000Z',
      },
      resync: {
        verb: 'coord:orient' as const,
        args: { afterCompaction: true as const },
        rule: 'replace-full-never-merge-behind' as const,
      },
    };
    const delivery = decideControlTransitionDelivery({
      ownerId: 'su-x',
      deliveredGeneration: 2,
      generation: 5,
      state: current,
      transition: stale,
      updatedAt: '2026-07-13T18:02:00.000Z',
    });
    expect(delivery).toMatchObject({
      kind: 'full-resync',
      reason: 'generation-mismatch',
      previousGeneration: 2,
      generation: 5,
      state: { carry: 'cold', modes: ['auto'] },
      provenance: { origin: 'system', source: 'control-anchor:reconcile' },
    });
    expect(delivery.state).not.toEqual(stale.state);
  });

  it('rejects a transition addressed to another owner even when its generation is exact', () => {
    const current = state({ carry: 'cold', modes: ['auto'] });
    const foreign = {
      schemaVersion: CONTROL_TRANSITION_SCHEMA,
      targetOwnerId: 'su-ended-prior-owner',
      previousGeneration: 4,
      generation: 5,
      state: state({ carry: 'warm', modes: [] }),
      provenance: {
        origin: 'agent' as const,
        actorId: 'su-ended-prior-owner',
        source: 'fleet:membership' as const,
        ownerDirected: false,
        recordedAt: '2026-07-13T18:03:00.000Z',
      },
      resync: {
        verb: 'coord:orient' as const,
        args: { afterCompaction: true as const },
        rule: 'replace-full-never-merge-behind' as const,
      },
    };
    const delivery = decideControlTransitionDelivery({
      ownerId: 'su-current-owner',
      deliveredGeneration: 4,
      generation: 5,
      state: current,
      transition: foreign,
      updatedAt: '2026-07-13T18:04:00.000Z',
    });

    expect(delivery).toMatchObject({
      kind: 'full-resync',
      reason: 'owner-mismatch',
      targetOwnerId: 'su-current-owner',
      state: normalizeControlAnchorState(current),
      provenance: { origin: 'system', source: 'control-anchor:reconcile', actorId: 'su-current-owner' },
    });
    expect(delivery.state).not.toEqual(foreign.state);
  });
});

describe('deriveClaimScope — an agent must not lose its own lane to a lapsed lease', () => {
  const claim = (item: string, lease_valid: boolean) => ({
    harness_slug: 'papercusp',
    plan_slug: 'retire-mug-kettle-su-only-2026-08-09',
    item_id: item,
    lease_valid,
  });

  it('REGRESSION (2026-08-10): a lapsed-but-unreleased claim still yields plan AND items', () => {
    // The exact production failure. A session driving this plan respawned and
    // reported `scope: { plan: null, items: [] }` while its P-034 claim row was
    // still present and unreleased — the 1200s lease had lapsed 13h earlier.
    // Filtering self-scope by expires_ts emptied `items`, and `plan` then fell
    // through to null. The agent lost its mission and had to ask the owner.
    const scope = deriveClaimScope([claim('P-034', false)], null, null);

    expect(scope.plan).toBe('retire-mug-kettle-su-only-2026-08-09');
    expect(scope.items).toEqual(['P-034']);
    expect(scope.harness).toBe('papercusp');
    // Still ours, but the lease is cold — surfaced so a caller re-claims
    // before editing rather than assuming peers are locked out.
    expect(scope.lapsed).toEqual(['P-034']);
  });

  it('a live lease is not reported as lapsed', () => {
    const scope = deriveClaimScope([claim('P-034', true)], null, null);
    expect(scope.items).toEqual(['P-034']);
    expect(scope.lapsed).toEqual([]);
  });

  it('the session brief wins for the plan when it has one', () => {
    const scope = deriveClaimScope(
      [claim('P-034', false), { ...claim('P-999', true), plan_slug: 'other-plan' }],
      'retire-mug-kettle-su-only-2026-08-09',
      'papercusp',
    );
    // Only the briefed plan's items form the lane — a stray claim on another
    // plan must not leak in.
    expect(scope.plan).toBe('retire-mug-kettle-su-only-2026-08-09');
    expect(scope.items).toEqual(['P-034']);
  });

  it('falls back to the held claim lane when a stale brief plan has no matching claim', () => {
    const scope = deriveClaimScope(
      [{ ...claim('P-005', true), plan_slug: 'rem-dream-recombination-2026-08-17' }],
      'dream-cycle-operator-control',
      'papercusp',
    );

    expect(scope).toEqual({
      harness: 'papercusp',
      plan: 'rem-dream-recombination-2026-08-17',
      items: ['P-005'],
      lapsed: [],
    });
  });

  it('with no brief, the lane is a SINGLE plan — claims across plans do not merge', () => {
    // Before the fix the no-brief branch passed every row through, so an agent
    // holding items on two plans got a lane whose items did not all belong to
    // the plan reported beside them.
    const scope = deriveClaimScope(
      [claim('P-034', false), { ...claim('P-999', true), plan_slug: 'other-plan' }],
      null,
      null,
    );
    expect(scope.plan).toBe('retire-mug-kettle-su-only-2026-08-09');
    expect(scope.items).toEqual(['P-034']);
  });

  it('no claims and no brief is an empty lane, not a crash', () => {
    expect(deriveClaimScope([], null, null)).toEqual({
      harness: null,
      plan: null,
      items: [],
      lapsed: [],
    });
  });
});

describe('control-witness re-arm across a context wipe (WI-10002058)', () => {
  it('rolls the delivery watermark down to the stamp the outgoing document carries', async () => {
    const { sql, calls } = sqlReturning([{ control_delivered_generation: 67 }]);

    const result = await rearmControlWitnessForContextWipe('su-1', 'ws-1', 67, sql);

    expect(result).toEqual({ rearmed: true, deliveredGeneration: 67 });
    const [call] = calls;
    // Bound to THIS owner/workspace and THIS document's stamp, in statement order:
    // the SET target first, then owner, workspace, and the threshold the WHERE
    // compares against. A re-arm bound to anything else re-arms for a document
    // nobody is about to read. The SET value and the threshold must be the SAME
    // stamp — a mismatch would lower the watermark past the document it describes.
    expect(call.values).toEqual([67, 'su-1', 'ws-1', 67]);
    // Lower-only. GREATEST here would silently make the whole fix a no-op while
    // still passing any test that merely asserts "a statement was emitted".
    expect(call.statement).toContain('LEAST(control_delivered_generation');
    expect(call.statement).not.toContain('GREATEST');
  });

  it('reports not-rearmed when the watermark was already at or below the stamp', async () => {
    const { sql } = sqlReturning<{ control_delivered_generation: number }>([]);

    // The WHERE clause filters it out server-side; zero rows is the healthy
    // steady state (nothing was delivered past this stamp), not a failure.
    expect(await rearmControlWitnessForContextWipe('su-1', 'ws-1', 67, sql)).toEqual({
      rearmed: false,
      deliveredGeneration: null,
    });
  });

  it('refuses a non-integer or negative stamp without touching the row', async () => {
    const { sql, calls } = sqlReturning([{ control_delivered_generation: 0 }]);

    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(await rearmControlWitnessForContextWipe('su-1', 'ws-1', bad, sql)).toEqual({
        rearmed: false,
        deliveredGeneration: null,
      });
    }
    // A garbage stamp must never reach the UPDATE: LEAST(watermark, NaN) would be
    // an unbounded rollback, re-delivering the anchor on every turn forever.
    expect(calls).toEqual([]);
  });

  it('arms the escape hatch: a watermark behind the live generation yields a full-resync', () => {
    // The point of the rollback. Once the watermark sits at the document's stamp,
    // a control state that has since moved forces the ⟦CTRL:…⟧ block that
    // contradicts the stale marker — the correction that silence used to suppress.
    const delivery = decideControlTransitionDelivery({
      ownerId: 'su-1',
      deliveredGeneration: 67,
      generation: 69,
      state: state(),
      transition: null,
      updatedAt: new Date(0).toISOString(),
    });

    expect(delivery.kind).toBe('full-resync');
    expect(delivery.generation).toBe(69);
    expect(delivery.previousGeneration).toBe(67);
  });

  it('stays quiet when the stamp is still current — the re-arm must not re-deliver forever', () => {
    // Calibration for the assertion above: if EVERY watermark produced a resync,
    // the test before this one would pass no matter how the rollback behaved.
    const decision = decideControlTransitionDelivery({
      ownerId: 'su-1',
      deliveredGeneration: 69,
      generation: 69,
      state: state(),
      transition: null,
      updatedAt: new Date(0).toISOString(),
    });

    expect(decision.previousGeneration).toBe(69);
    expect(decision.generation).toBe(69);
  });
});

describe('every control_delivered_generation writer is classified (WI-10002058)', () => {
  /** Classify one `SET control_delivered_generation = …` expression by the only
   *  property that matters: which DIRECTION it can move the watermark. */
  function classifyWatermarkWrites(source: string): Array<{
    kind: 'advance' | 'rollback' | 'unclassified';
    enclosing: string;
    expression: string;
  }> {
    const out: Array<{
      kind: 'advance' | 'rollback' | 'unclassified';
      enclosing: string;
      expression: string;
    }> = [];
    const write = /SET\s+control_delivered_generation\s*=\s*([^\n]*)/g;
    for (let m = write.exec(source); m; m = write.exec(source)) {
      const expression = m[1].trim();
      const kind = /^GREATEST\s*\(/.test(expression)
        ? 'advance'
        : /^LEAST\s*\(/.test(expression)
          ? 'rollback'
          : 'unclassified';
      // Backwards walk to the enclosing declaration, so a new writer is attributed
      // to the function that actually performs it rather than hand-listed here.
      const preceding = source.slice(0, m.index);
      const decls = [...preceding.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)];
      out.push({ kind, enclosing: decls.at(-1)?.[1] ?? '<module>', expression });
    }
    return out;
  }

  it('detects direction and enclosing function, and can actually fail', () => {
    // The control. Without it a rename of the column makes every assertion below
    // range over an empty set and pass while asserting nothing at all.
    const fixture = [
      'export async function advances() {',
      '  SET control_delivered_generation = GREATEST(control_delivered_generation, 5)',
      '}',
      'export async function rollsBack() {',
      '  SET control_delivered_generation = LEAST(control_delivered_generation, 5)',
      '}',
      'export async function smuggled() {',
      '  SET control_delivered_generation = 5',
      '}',
    ].join('\n');

    expect(classifyWatermarkWrites(fixture)).toEqual([
      {
        kind: 'advance',
        enclosing: 'advances',
        expression: 'GREATEST(control_delivered_generation, 5)',
      },
      {
        kind: 'rollback',
        enclosing: 'rollsBack',
        expression: 'LEAST(control_delivered_generation, 5)',
      },
      { kind: 'unclassified', enclosing: 'smuggled', expression: '5' },
    ]);
  });

  it('has exactly one rollback, and it is the designated context-wipe re-arm', () => {
    const source = readFileSync(new URL('./control-anchor.ts', import.meta.url), 'utf8');
    const writes = classifyWatermarkWrites(source);

    // Calibration: the advance path must still be found. Zero writes would make
    // the two assertions below vacuously true.
    expect(writes.filter((w) => w.kind === 'advance').length).toBeGreaterThan(0);

    // A new writer must declare its direction. An unclassified one can move the
    // watermark either way, which is exactly the ambiguity that disarmed the
    // escape hatch in the first place.
    expect(writes.filter((w) => w.kind === 'unclassified')).toEqual([]);

    // Exactly one place may lower the watermark. A second rollback site elsewhere
    // would re-deliver the anchor on paths that never wiped a context.
    expect(writes.filter((w) => w.kind === 'rollback').map((w) => w.enclosing)).toEqual([
      'rearmControlWitnessForContextWipe',
    ]);
  });
});
