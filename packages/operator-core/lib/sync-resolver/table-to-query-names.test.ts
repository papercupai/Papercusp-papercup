import { describe, expect, it } from 'vitest';
import {
  TABLE_TO_QUERY_NAMES,
  queryNamesForTriggerEvent,
  allBridgedQueryNames,
  resolveBridgeTarget,
  type QueryNameTarget,
  type ScopeKeyBuilder,
} from './table-to-query-names';
import { knownQueryNamesV2 } from './index';

describe('queryNamesForTriggerEvent', () => {
  it('refreshes the PR viewer when report, checks or exact merge-test metadata changes', () => {
    for (const table of ['pr_review_reports', 'pr_check_status_cache', 'harness_feature_prs', 'routines']) {
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toContain('harnessPrs.byHarness');
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toContain('harnessPrs.detail');
    }
  });
  it('strips the .changed suffix and looks up the table', () => {
    expect(queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed')).toEqual([
      'harnessTextArtifact.byHarness',
    ]);
  });

  it('returns multiple names when a single table backs multiple queries', () => {
    const names = queryNamesForTriggerEvent('harness_shared.harness_chunk_plans.changed');
    expect(names).toEqual(expect.arrayContaining(['chunkPlans.byHarness', 'chunkPlans.byFeature']));
    expect(names).toHaveLength(2);
  });

  it('refreshes pinned report reads when report-library metadata changes', () => {
    expect(queryNamesForTriggerEvent('harness_shared.report_library.changed', {
      workspace_id: 'ws1',
    })).toEqual(['reports.list', 'reports.library', 'reports.lineage', 'reports.get']);
  });

  it('returns empty array for unknown tables', () => {
    expect(queryNamesForTriggerEvent('harness_shared.totally_unknown.changed')).toEqual([]);
  });

  it('returns empty array for malformed event names (no .changed suffix)', () => {
    expect(queryNamesForTriggerEvent('plans.list')).toEqual([]);
    expect(queryNamesForTriggerEvent('harness_shared.harness_text_artifacts')).toEqual([]);
    expect(queryNamesForTriggerEvent('')).toEqual([]);
  });

  // WI-6796 — "the accounts tab stopped updating". The Accounts tab (and the /adv
  // Overview Spend tile) subscribe to `accounts.pool`, which resolves off
  // operator_account_pool. The table's dominant writer is the inference GATEWAY, a
  // SEPARATE process, so the operator's in-process notify can never be the only
  // route — the mig-715 row trigger plus this bridge entry is what carries a
  // gateway-side usage write through to an open tab. Its sibling
  // operator_account_override was mapped from the start; the pool was not, so
  // continuous usage updates were invisible to a tab left open.
  it('maps operator_account_pool → accounts.pool (WI-6796: the tab live-updates on a gateway usage write)', () => {
    expect(queryNamesForTriggerEvent('harness_shared.operator_account_pool.changed')).toEqual(['accounts.pool']);
  });

  it('maps operator_account_override → accounts.pool too — the sibling override table (both feed the same tab)', () => {
    expect(queryNamesForTriggerEvent('harness_shared.operator_account_override.changed')).toEqual([
      'accounts.sessionOverride',
      'accounts.pool',
    ]);
  });

  it('maps workspace-host control tables while leaving append-heavy logs producer-pushed', () => {
    for (const table of [
      'workspace_host_connections',
      'workspace_hosts',
      'workspace_host_operations',
      'workspace_host_resources',
      'workspace_host_events',
    ]) {
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toEqual(['workspaceHosts.control']);
    }
    expect(TABLE_TO_QUERY_NAMES['harness_shared.workspace_host_logs']).toBeUndefined();
  });

  it('maps foreign-workspace lifecycle writes to the public host registry query', () => {
    expect(queryNamesForTriggerEvent('harness_shared.p2p_foreign_workspaces.changed')).toEqual([
      'p2p.foreignWorkspaces',
    ]);
  });

  it('handles userActions which contributes three names from one table', () => {
    expect(queryNamesForTriggerEvent('harness_shared.user_actions.changed')).toEqual(
      expect.arrayContaining(['userActions.byHarness', 'userActions.byKind', 'userActions.recent']),
    );
  });

  it('maps pot_settings → hive.steering (the federated steering-write refresh, queen-steering-panel C-1)', () => {
    // A steering write lands in pot_settings (owner-steering:* keys; renamed from
    // hive_settings by WI-3953 cup-lexicon rename, migration 557); the capture
    // trigger fires this event so a FEDERATED write from a peer Swarm refreshes the
    // 👑 Queen tab's hive.steering query — the half pot:set-steering's explicit
    // notifySyncInvalidate does NOT cover (a remote write never runs that handler).
    expect(queryNamesForTriggerEvent('harness_shared.pot_settings.changed')).toEqual([
      'network.hiveDirectory',
      'hive.steering',
      'learning.dream',
      'hive.beaconConsent',
      // pot-review-integration-mode P-017 (EI-25188362216785598): the integration-mode settings
      // section reads pot_settings; it full-busts because its args are the harness slug.
      'potIntegration.settings',
    ]);
    expect(
      queryNamesForTriggerEvent('harness_shared.pot_settings.changed', {
        workspace_id: 'w1',
        harness_slug: 'acme-hive',
      }),
    ).toEqual([
      'network.hiveDirectory',
      'hive.steering',
      'learning.dream',
      { name: 'hive.beaconConsent', args: { potId: 'acme-hive' } },
      'potIntegration.settings',
    ]);
  });
  it('refreshes DAO identity, membership, governance and policy readers through the existing directory subscription', () => {
    for (const table of ['harness_registry', 'pot_members', 'pot_policy', 'pot_settings'])
      expect(queryNamesForTriggerEvent('harness_shared.' + table + '.changed')).toContain('network.hiveDirectory');
  });

  it('maps harness_plans → the schedule queries (data-sync-push-completion P-002)', () => {
    // The schedule lives in COLUMNS on harness_plans (mig 299), so set-schedule /
    // arm / disarm writes — and the routine engine's schedule_active flips — must
    // push the Calendar (plans.scheduledOccurrences) + Routines (plans.schedule) panes.
    const names = queryNamesForTriggerEvent('harness_shared.harness_plans.changed');
    expect(names).toEqual(expect.arrayContaining(['plans.schedule', 'plans.scheduledOccurrences']));
    expect(names).toEqual(expect.arrayContaining(['advSessions.list', 'advSessions.summary']));
    // and it still busts the directory + per-plan reads it always did
    expect(names).toEqual(expect.arrayContaining(['plans.list', 'plans.get']));
  });

  it('invalidates Sessions rows and the exact companion together on a ledger write', () => {
    expect(queryNamesForTriggerEvent('harness_shared.adv_sessions.changed')).toEqual(
      expect.arrayContaining(['advSessions.list', 'advSessions.summary']),
    );
  });

  it('invalidates the shared conversation projection from its low-churn foreign context tables', () => {
    for (const table of ['adv_sessions', 'agent_modes', 'work_items', 'coord_presence']) {
      expect(queryNamesForTriggerEvent(`harness_shared.${table}.changed`)).toContain(
        'conversations.contextProjection',
      );
    }
    // The append/lease ledgers are deliberately coverage-exempt rather than
    // gaining coarse high-volume triggers; see resolver-backing-table-coverage.
    expect(TABLE_TO_QUERY_NAMES['harness_shared.session_turns']).toBeUndefined();
    expect(TABLE_TO_QUERY_NAMES['harness_shared.tool_invocations']).toBeUndefined();
    expect(TABLE_TO_QUERY_NAMES['harness_shared.plan_item_claims']).toBeUndefined();
  });

  it('maps the design-write tables (data-sync-push-completion P-003)', () => {
    // Sketch saves land on harness_design_artifacts (trigger attached mig 380) → push
    // the sketch pane. Feature design-state flips land on work_items → push the dashboard.
    expect(queryNamesForTriggerEvent('harness_shared.harness_design_artifacts.changed')).toEqual([
      'designSketches.byFeature',
    ]);
    expect(queryNamesForTriggerEvent('harness_shared.work_items.changed')).toEqual(
      expect.arrayContaining(['designFeatures.byHarness', 'designFeatures.summary']),
    );
    expect(queryNamesForTriggerEvent('harness_shared.harness_features_consolidated.changed')).toEqual(
      expect.arrayContaining(['designFeatures.byHarness', 'designFeatures.summary']),
    );
  });

  it('maps both admission ledger and work-item rollup writes to the P-005 run surface', () => {
    expect(queryNamesForTriggerEvent('harness_shared.admission_runs.changed')).toEqual(['workItemAdmission.runs']);
    expect(queryNamesForTriggerEvent('harness_shared.work_items.changed')).toEqual(
      expect.arrayContaining(['workItemAdmission.runs']),
    );
  });

  it('handles *Consolidated tables', () => {
    expect(queryNamesForTriggerEvent('harness_shared.harness_features_consolidated.changed')).toEqual(
      // P-007: the on-demand single-feature detail read must be busted alongside
      // bySlug so an open Detail pane live-refreshes its Description.
      expect.arrayContaining([
        'featuresConsolidated.bySlug',
        'featuresConsolidated.detail',
        'featuresConsolidated.byPlanSlug',
      ]),
    );
    expect(queryNamesForTriggerEvent('harness_shared.agent_runs_consolidated.changed')).toEqual(
      expect.arrayContaining([
        'agentRunsConsolidated.bySlug',
        'agentRunsConsolidated.summary',
        'agentRunsConsolidated.recent',
      ]),
    );
  });
});

describe('per-row scoped invalidation (caching-layer-tag-eca P-006)', () => {
  // The PG trigger (emit_change_notify, mig 368) emits args { workspace_id,
  // op, id } where `id` is the changed row's PK (absent for id-less tables).
  // A query mapped as { name, scope } uses that id to invalidate JUST the
  // row's key; bare-string queries (every live entry today) full-bust.

  // A representative per-row query keyed solely by the row id. The scope
  // builder returns the COMPLETE consumer-key args object the client
  // subscribes with — TanStack hashes the whole key structurally, so a
  // partial object would match nothing.
  const byIdScope: ScopeKeyBuilder = (rowId) => ({ id: rowId });
  const widgetById: QueryNameTarget = { name: 'widget.byId', scope: byIdScope };

  it('a { name, scope } target with an id present → SCOPED { name, args:{id} }', () => {
    expect(resolveBridgeTarget(widgetById, 'widget-42', 'w1')).toEqual({
      name: 'widget.byId',
      args: { id: 'widget-42' },
    });
  });

  it('a bare-string target ALWAYS full-busts, even when an id is present', () => {
    // The existing byHarness/bySlug queries are keyed by harness/workspace,
    // not the changed row's PK — scoping by id can't narrow a list, so they
    // stay bare strings (full-bust). Mirrors the live registry.
    expect(resolveBridgeTarget('list.byHarness', 'row-7', 'w1')).toBe('list.byHarness');
  });

  it('a { name, scope } target with NO id (id-less table) falls back to full-bust', () => {
    // Most harness_shared.* tables key on a natural composite, so
    // to_jsonb(row)->'id' is JSON null → rowId undefined → bare name.
    expect(resolveBridgeTarget(widgetById, undefined, 'w1')).toBe('widget.byId');
  });

  it('a scope that opts out (returns null) falls back to full-bust', () => {
    const optsOut: QueryNameTarget = { name: 'q.byId', scope: () => null };
    expect(resolveBridgeTarget(optsOut, 'id-1', 'w1')).toBe('q.byId');
  });

  it('queryNamesForTriggerEvent normalizes a JSON-number id and forwards workspace', () => {
    const seen: Array<[string, string | undefined]> = [];
    const recordingScope: ScopeKeyBuilder = (rowId, ws) => {
      seen.push([rowId, ws]);
      return { id: rowId };
    };
    // Drive resolveBridgeTarget the way queryNamesForTriggerEvent does, but
    // assert the id-coercion + workspace pass-through it performs. (We can't
    // mutate the frozen live map, so exercise the coercion via the function's
    // public contract on a numeric id.)
    expect(resolveBridgeTarget({ name: 'q.byId', scope: recordingScope }, '99', 'wsX')).toEqual({
      name: 'q.byId',
      args: { id: '99' },
    });
    expect(seen).toEqual([['99', 'wsX']]);
  });

  it('LIVE registry: every entry full-busts today (no per-id opt-in yet) — id is ignored', () => {
    // Backward-compat guarantee: passing an id-bearing args payload through
    // the real bridge yields the SAME bare-string targets as before, because
    // no bridged table has an `id` column / per-row consumer (see P-006 note).
    const withId = queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed', {
      workspace_id: 'w1',
      op: 'UPDATE',
      id: 'should-be-ignored',
    });
    expect(withId).toEqual(['harnessTextArtifact.byHarness']);

    const noArgs = queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed');
    expect(noArgs).toEqual(withId);
  });

  it('the live map is bare-string (full-bust) EXCEPT the EI-7433 scoped entries', () => {
    // plans.get was flipped to { name, scope } (harness_plans natural-key
    // scoping, mig 507) — the first live per-row-scoped entry. Every other
    // mapped query name today is still a bare string (full-bust); name each
    // scoped exception explicitly so a future accidental object-ification
    // elsewhere in the map still fails loud here.
    const KNOWN_SCOPED = new Set([
      'plans.get',
      'conversations.questionDetail',
      'conversations.agentChatDetail',
      'agentChats.detail',
      'hive.beaconConsent',
    ]);
    for (const [table, targets] of Object.entries(TABLE_TO_QUERY_NAMES)) {
      for (const t of targets) {
        if (typeof t === 'string') continue;
        expect(KNOWN_SCOPED.has(t.name), `unexpected scoped target ${t.name} for ${table}`).toBe(true);
      }
    }
  });
});

describe('plan_slug natural-key scoping (mig 507, EI-7433)', () => {
  // harness_plans has NO `id` column, so args.id is always JSON null for it —
  // mig 507 additively emits args.plan_slug instead, and
  // queryNamesForTriggerEvent falls back to it when args.id is absent.

  it('a harness_plans event WITH plan_slug scopes plans.get to { slug }, leaves siblings full-bust', () => {
    const names = queryNamesForTriggerEvent('harness_shared.harness_plans.changed', {
      workspace_id: 'w1',
      op: 'UPDATE',
      id: null,
      plan_slug: 'my-plan',
    });
    expect(names).toContainEqual({ name: 'plans.get', args: { slug: 'my-plan' } });
    // Cross-plan queries are correctly NOT scopeable by a single row's slug —
    // they stay bare (full-bust), unaffected by the natural-key fallback.
    expect(names).toContain('plans.list');
    expect(names).toContain('plans.items');
    expect(names).toContain('plans.byHive');
  });

  it('a harness_plans event with NO plan_slug (and no id) falls back to full-bust', () => {
    const names = queryNamesForTriggerEvent('harness_shared.harness_plans.changed', {
      workspace_id: 'w1',
      op: 'DELETE',
      id: null,
      plan_slug: null,
    });
    expect(names).toContain('plans.get');
    expect(names).not.toContainEqual(expect.objectContaining({ name: 'plans.get', args: expect.anything() }));
  });

  it('args.id (a real PK) is preferred over plan_slug when somehow both are present', () => {
    // Not a real shape any live table produces today (harness_plans has no id;
    // an id-bearing table wouldn't carry plan_slug) — pins the documented
    // precedence so a future table combining both doesn't silently flip it.
    const names = queryNamesForTriggerEvent('harness_shared.harness_plans.changed', {
      workspace_id: 'w1',
      op: 'UPDATE',
      id: 'some-pk',
      plan_slug: 'my-plan',
    });
    // plans.get's own scope (planSlugScope) just echoes whatever key it's
    // handed as `slug` — with `id` preferred, that key is 'some-pk', not the
    // plan_slug, proving the precedence (rowIdOf ?? planSlugOf).
    expect(names).toContainEqual({ name: 'plans.get', args: { slug: 'some-pk' } });
  });

  it('plan_slug has zero effect on other id-less tables (natural key is table-specific, not global)', () => {
    // known_schema_versions / trusted_authors etc. have neither id nor
    // plan_slug — nothing in their mapped targets is scoped, so a stray
    // plan_slug in triggerArgs (which would never really co-occur) still
    // wouldn't matter, but this pins that the fallback doesn't leak into
    // unrelated tables' full-bust entries.
    const names = queryNamesForTriggerEvent('harness_shared.harness_text_artifacts.changed', {
      workspace_id: 'w1',
      op: 'UPDATE',
      id: null,
      plan_slug: 'unrelated-plan',
    });
    expect(names).toEqual(['harnessTextArtifact.byHarness']);
  });
});

describe('pot_settings harness_slug natural-key scoping (WI-4137)', () => {
  it('scopes beacon consent to the changed Pot home', () => {
    expect(
      queryNamesForTriggerEvent('harness_shared.pot_settings.changed', {
        workspace_id: 'w1',
        op: 'UPDATE',
        id: null,
        harness_slug: 'acme-hive',
      }),
    ).toContainEqual({ name: 'hive.beaconConsent', args: { potId: 'acme-hive' } });
  });

  it('falls back to a full invalidation when harness_slug is absent', () => {
    expect(
      queryNamesForTriggerEvent('harness_shared.pot_settings.changed', {
        workspace_id: 'w1',
        op: 'DELETE',
        id: null,
        harness_slug: null,
      }),
    ).toContain('hive.beaconConsent');
    expect(
      queryNamesForTriggerEvent('harness_shared.pot_settings.changed', {
        workspace_id: 'w1',
        op: 'DELETE',
        id: null,
        harness_slug: null,
      }),
    ).not.toContainEqual(expect.objectContaining({ name: 'hive.beaconConsent', args: expect.anything() }));
  });
});

describe('saved_prompts bridge (quick-panel-saved-prompts-2026-07-13 P-003)', () => {
  it('full-busts savedPrompts.byScope on a saved_prompts change', () => {
    expect(
      queryNamesForTriggerEvent('harness_shared.saved_prompts.changed', {
        workspace_id: 'w1',
        op: 'UPDATE',
        id: 'row-1',
        harness_slug: null,
      }),
    ).toContain('savedPrompts.byScope');
  });
});

describe('TABLE_TO_QUERY_NAMES vs v2 registry consistency', () => {
  /**
   * Forward-defined names — mapped in the bridge BEFORE the
   * corresponding v2 registry entry exists. Trigger events for these
   * tables fire (as expected) but currently invalidate nothing; the
   * matching consumer + v2 entry will land later. Listed here so
   * the consistency assertion stays sharp while permitting deliberate
   * advance-mapping.
   *
   * REMOVE an entry from this set as soon as its v2 registry entry
   * lands — otherwise drift between intent ("this should land soon")
   * and reality ("it never did") stops being visible.
   */
  const FORWARD_DEFINED = new Set<string>([
    // v5 addendum 3 §9.0 Insights tab — P-073+ work.
    'contributorUsageEvents.byHarness',
    'insightsFirstVisit.byHarness',
  ]);

  it('every bridged query name is either in v2 registry OR explicitly forward-defined', () => {
    const v2 = new Set(knownQueryNamesV2());
    const bridged = allBridgedQueryNames();
    const unaccountedFor = bridged.filter((n) => !v2.has(n) && !FORWARD_DEFINED.has(n));
    expect(unaccountedFor).toEqual([]);
  });

  it('forward-defined names are NOT in v2 registry (sanity)', () => {
    const v2 = new Set(knownQueryNamesV2());
    const stillForward = Array.from(FORWARD_DEFINED).filter((n) => !v2.has(n));
    // If this assertion fails, a forward-defined name has been
    // implemented and its entry in FORWARD_DEFINED should be removed.
    expect(stillForward.sort()).toEqual(Array.from(FORWARD_DEFINED).sort());
  });

  it('exposes a distinct, non-trivially-populated set of camelCase names through the bridge', () => {
    // Was a brittle exact count (56) that flapped red as query families landed
    // (issues/conversations/coord added 2026-06-04 → 63; delegates.byWorkspace
    // removed by collapse-delegate-into-workitems-2026-06-04 → 62; harnessHealth.byHarness
    // removed by spec-md-ui-deprecation-cleanup P-007 → 61; operatorScans + operatorLastScan
    // removed by archive-legacy-orchestrator-deadcode P-009 (their tables were dropped by
    // migration 167) → 59; further Zero-retirement removals → 52 by 2026-06-09). The
    // forward-defined + v2-consistency assertions above carry the real signal; this is only a
    // non-triviality floor — set WELL BELOW the current count with headroom for the ongoing
    // shrink, so a routine add/remove doesn't flap it red (the exact-set assertions catch real
    // drift). The 55 floor flapped red @52 + blocked main fleet-wide; lowered to 45.
    const names = allBridgedQueryNames();
    expect(names.length).toBeGreaterThanOrEqual(45);
    expect(new Set(names).size, 'bridged query names are distinct').toBe(names.length);
  });

  it('refreshes every Conversations source list/detail from its backing tables', () => {
    expect(TABLE_TO_QUERY_NAMES['harness_shared.coord_conversations']).toEqual(
      expect.arrayContaining([
        'conversations.questionsList',
        expect.objectContaining({ name: 'conversations.questionDetail' }),
      ]),
    );
    for (const table of ['harness_shared.coord_threads', 'harness_shared.coord_thread_posts']) {
      expect(TABLE_TO_QUERY_NAMES[table]).toEqual(
        expect.arrayContaining([
          'conversations.deliberationList',
          'conversations.deliberationDetail',
          'conversations.questionDetail',
        ]),
      );
    }
    expect(TABLE_TO_QUERY_NAMES['harness_shared.agent_chats_consolidated']).toEqual(
      expect.arrayContaining([
        'conversations.agentChatList',
        expect.objectContaining({ name: 'conversations.agentChatDetail' }),
      ]),
    );
    // harness_shared.messages_consolidated entry retired with the work-item
    // mail read queries — see retire-work-item-mail-surface-2026-07-26 P-004.
    expect(TABLE_TO_QUERY_NAMES['harness_shared.messages_consolidated']).toBeUndefined();
    expect(TABLE_TO_QUERY_NAMES['harness_shared.coord_links']).toEqual(
      expect.arrayContaining(['conversations.questionsList', 'conversations.questionDetail']),
    );
    expect(TABLE_TO_QUERY_NAMES['harness_shared.coord_entity_subscriptions']).toContain('conversations.questionDetail');
  });

  it('refreshes the merged operator-turn query that serves both live tail and hydration', () => {
    expect(TABLE_TO_QUERY_NAMES['harness_shared.operator_turns']).toEqual(
      expect.arrayContaining(['operatorTurns.page']),
    );
  });

  it('invalidates the observation page and summary when occurrence watermarks change', () => {
    expect(TABLE_TO_QUERY_NAMES['harness_shared.work_item_occurrences']).toEqual(
      ['learning.observations', 'learning.observations.summary'],
    );
  });

  it('refreshes both global and focused work-item conversation identities', () => {
    expect(TABLE_TO_QUERY_NAMES['harness_shared.operator_conversations']).toEqual(
      expect.arrayContaining([
        'operatorConversations.current',
        'operatorConversations.byWorkItem',
      ]),
    );
  });

  // P-025 / no-http-anywhere-2026-07-28 D-016 + D-018: the chat pane used to run a
  // second query, `operatorTurns.byConversation`, over the same listTurnsRecent()
  // rows — ~200 turns fetched twice per mount. It was merged into
  // `operatorTurns.page`, and no client subscribes to the old name any more.
  //
  // The invariant is COUPLED TO THE REGISTRY rather than an absolute "never appears",
  // deliberately. Mapping a name that no resolver serves is dead wiring: every
  // invalidation fired at it is a no-op against a name nothing reads, which is the
  // false-liveness shape (accounts.pool / WI-6796) — it looks wired while pushing
  // nothing.
  //
  // WHY THIS IS A TOTAL ASSERTION AND NOT A GATED ONE (EI-19372846096817075).
  //
  // It was written to tolerate an interim in which WI-6964 deliberately kept the
  // resolver entry alive (declared AND wired) so the shrink-only ratchet stayed
  // green while the deletion waited, as `if (!stillRegistered) { expect(mapped)
  // .toBe(false); }`. That made the gate depend on the very entry the guard exists
  // to catch: while the entry survived, the test executed ZERO assertions and
  // reported a green tick indistinguishable from a real pass. The interim then ran
  // ~12h longer than anyone tracked — D-018 recorded the deletion as DONE on
  // 2026-08-02 while all three sites survived — and two agents read "guard green +
  // decision says removed" and concluded it had landed. It had not.
  //
  // The fix is NOT to pin `stillRegistered` absolutely: that would red the fleet's
  // gate for any legitimate future interim, which is how this interim arose in the
  // first place. It is to state the invariant the guard actually holds, which is an
  // IMPLICATION and is therefore assertable on every input:
  //
  //     mapped  =>  some resolver serves the name
  //
  // Both-present (a tolerated interim) passes; mapped-with-no-resolver fails as
  // dead wiring. No input makes it assert nothing, so it cannot go vacuous again —
  // the dormant state that needed reporting no longer exists to report.
  //
  // EI-19372323793235963 has since removed the entry, the mapping and the audit
  // fixture, so today both sides are absent and the implication holds trivially —
  // but it is now holding *because it was checked*, which is the whole difference.
  //
  // Where an invariant genuinely CANNOT be made total — a guard landed ahead of the
  // cleanup it enforces — use `expectArmed` from lib/testing-armed-guard.ts rather
  // than a bare `if`, so a dormant run reports as a SKIP with its arming condition
  // and starts failing once its `armBy` date passes.
  it('never maps operatorTurns.byConversation unless a resolver actually serves it', () => {
    const stillRegistered = knownQueryNamesV2().includes('operatorTurns.byConversation');
    for (const [table, names] of Object.entries(TABLE_TO_QUERY_NAMES)) {
      const mapped = names.some((n) => (typeof n === 'string' ? n : n.name) === 'operatorTurns.byConversation');
      expect(
        !mapped || stillRegistered,
        `${table} maps 'operatorTurns.byConversation', but no resolver serves that name — ` +
          `dead wiring: every invalidation fired at it is a no-op against a name nothing reads.`,
      ).toBe(true);
    }
  });
});

describe('TABLE_TO_QUERY_NAMES shape', () => {
  it('all keys start with harness_shared.', () => {
    for (const k of Object.keys(TABLE_TO_QUERY_NAMES)) {
      expect(k).toMatch(/^harness_shared\./);
    }
  });

  it('all values are non-empty arrays of well-formed query-name entries (bare string OR { name, scope })', () => {
    for (const [k, vs] of Object.entries(TABLE_TO_QUERY_NAMES)) {
      expect(Array.isArray(vs), `value for ${k}`).toBe(true);
      expect(vs.length, `value for ${k}`).toBeGreaterThan(0);
      for (const v of vs) {
        const name = typeof v === 'string' ? v : v.name;
        // Query families may own nested lenses (for example
        // learning.observations.summary); require 2+ identifier segments.
        expect(name, `entry in ${k}`).toMatch(/^\w+(?:\.\w+)+$/);
        if (typeof v !== 'string') {
          expect(typeof v.scope, `scope fn for ${name} in ${k}`).toBe('function');
        }
      }
    }
  });
});

/**
 * A duplicate key in TABLE_TO_QUERY_NAMES is INVISIBLE at runtime — an object
 * literal keeps the LAST one and silently discards every earlier declaration — so
 * no assertion against the built object can find it. This guard reads the source.
 *
 * It exists because it actually happened (2026-07-27): a change added a second
 * 'harness_shared.coord_event_log' key while one already existed further down. The
 * later literal won, so the newly-added conversation queries were never invalidated
 * by any coord write — a brand-new feature that simply never refreshed, with nothing
 * anywhere reporting a problem. It also emitted TS1117, which hard-fails the
 * typecheck gate REGARDLESS of the per-file error baseline, blocking the whole
 * fleet's green checkpoint until someone chased it down.
 *
 * This registry is exactly the kind of long, append-friendly map where two
 * contributors adding the same table months apart is a matter of time.
 */
describe('TABLE_TO_QUERY_NAMES source hygiene', () => {
  it('declares every table key exactly once (a duplicate silently overrides, it does not merge)', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('./table-to-query-names.ts', import.meta.url), 'utf8');

    // Top-level entries of the map are indented exactly two spaces; query names
    // nested inside an array value are indented four, so they cannot match here.
    const keys = [...src.matchAll(/^ {2}'([\w.]+)':/gm)].map((m) => m[1]);
    // Non-vacuity: prove the regex actually found the map before trusting a pass.
    expect(keys.length).toBeGreaterThan(50);

    const seen = new Set<string>();
    const duplicated = keys.filter((k) => (seen.has(k) ? true : (seen.add(k), false)));
    expect(duplicated, `duplicate table key(s): ${duplicated.join(', ')}`).toEqual([]);
  });
});
