/** Real-PG regression for successor-author acceptance continuity. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';
import {
  acceptanceLineageAncestors,
  acceptanceLineageClosure,
  areAcceptanceLineageRelated,
  isAcceptanceAuthorIdentity,
  lineagePartyKeys,
  resolvePlanImplementerIdentities,
} from './acceptance-author-identity';

const { createOrgTestDb } = await import('../test/_org-test-db');

describe('bounded acceptance lineage on converging graphs', () => {
  let db: OrgTestDb;
  const workspaceId = 'acceptance-converging-lineage';
  const root = 'diamond-root';
  const layers = 22;
  const layer = (n: number) => [`diamond-${n}-a`, `diamond-${n}-b`];

  beforeAll(async () => {
    db = await createOrgTestDb();
    const edges: Array<[string, string]> = [];
    for (let n = 1; n <= layers; n++) {
      for (const from of n === 1 ? [root] : layer(n - 1)) {
        for (const to of layer(n)) edges.push([from, to]);
      }
    }
    for (let n = 1; n <= 66; n++) edges.push([`chain-${n - 1}`, `chain-${n}`]);
    edges.push(['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a']);
    await db.adminSql`INSERT INTO harness_shared.tool_invocations ${db.adminSql(edges.map(([from, to], n) => ({
      workspace_id: workspaceId,
      harness_slug: 'lineage-diamond',
      plugin_name: 'agentmcp',
      tool_name: 'coord:rebind-identity',
      role: 'su',
      spawn_id: `lineage-edge-${n}`,
      window_key: `lineage-edge-${n}`,
      status: 'ok',
      args_json: { from, to },
      coord_owner_id: to,
    })))}`;
  });

  afterAll(async () => { await db?.cleanup(); });

  it('reads each reachable identity despite millions of converging paths', async () => {
    // A statement deadline makes the pre-fix path explosion fail promptly; it
    // never leaves a runaway fixture query after Vitest times the assertion out.
    const sql = await db.adminSql.reserve();
    try {
      await sql`SET statement_timeout = '1500ms'`;
      const opts = { sql, workspaceId };
      const nodes = [root, ...Array.from({ length: layers }, (_, n) => layer(n + 1)).flat()];
      expect(await acceptanceLineageClosure(root, opts)).toEqual(new Set(nodes));
      expect(await acceptanceLineageAncestors(layer(layers)[0], opts)).toEqual(
        new Set([root, ...nodes.slice(1, -2), layer(layers)[0]]),
      );
      expect(await areAcceptanceLineageRelated(root, 'unrelated', opts)).toBe(false);
      expect(await lineagePartyKeys([root, layer(layers)[0], 'unrelated'], opts)).toEqual(
        new Map([[root, root], [layer(layers)[0], root], ['unrelated', 'unrelated']]),
      );
      expect(await isAcceptanceAuthorIdentity(root, 'unrelated', opts)).toBe(false);
      expect(await isAcceptanceAuthorIdentity(root, layer(layers)[0], opts)).toBe(true);
    } finally {
      await sql`RESET statement_timeout`;
      sql.release();
    }
  });

  it('preserves the exact hop limits and terminates cyclic lineage', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    expect(await areAcceptanceLineageRelated('chain-0', 'chain-64', opts)).toBe(true);
    expect(await areAcceptanceLineageRelated('chain-0', 'chain-65', opts)).toBe(false);
    const closure = await acceptanceLineageClosure('chain-0', opts);
    expect(closure.has('chain-64')).toBe(true);
    expect(closure.has('chain-65')).toBe(false);
    const ancestors = await acceptanceLineageAncestors('chain-65', opts);
    expect(ancestors.has('chain-1')).toBe(true);
    expect(ancestors.has('chain-0')).toBe(false);
    expect(await isAcceptanceAuthorIdentity('chain-0', 'chain-32', opts)).toBe(true);
    expect(await isAcceptanceAuthorIdentity('chain-0', 'chain-33', opts)).toBe(false);
    expect(await acceptanceLineageClosure('cycle-a', opts)).toEqual(new Set(['cycle-a', 'cycle-b']));
    expect(await acceptanceLineageAncestors('cycle-a', opts)).toEqual(new Set(['cycle-a', 'cycle-b']));
  });
});

describe('isAcceptanceAuthorIdentity (audited coord rebind lineage)', () => {
  let db: OrgTestDb;
  const workspaceId = 'acceptance-author-lineage-ws';

  beforeAll(async () => {
    db = await createOrgTestDb();
    const rows = [
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-1',
        window_key: 'w-1',
        status: 'ok',
        args_json: { from: 'su-author', to: 'su-successor-1' },
        coord_owner_id: 'su-successor-1',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-b',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-2',
        window_key: 'w-2',
        status: 'ok',
        // Production permits omitting `to`; the successful caller is the target.
        args_json: { from: 'su-successor-1' },
        coord_owner_id: 'su-successor-2',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-refused',
        window_key: 'w-refused',
        status: 'error',
        args_json: { from: 'su-author', to: 'su-refused' },
        coord_owner_id: 'su-refused',
      },
      {
        workspace_id: 'different-workspace',
        harness_slug: 'h-a',
        plugin_name: 'agentmcp',
        tool_name: 'coord:rebind-identity',
        role: 'su',
        spawn_id: 'spawn-cross-tenant',
        window_key: 'w-cross-tenant',
        status: 'ok',
        args_json: { from: 'su-author', to: 'su-cross-tenant' },
        coord_owner_id: 'su-cross-tenant',
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.tool_invocations ${db.adminSql(rows)}`;
    const spawns = [
      {
        spawn_id: 'spawn-author',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: null,
        parent_role: 'su',
        child_role: 'su',
        run_id: 'run-author',
        status: 'finished',
        session_owner: 'su-author',
      },
      {
        spawn_id: 'spawn-child-1',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'spawn-author',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-child-1',
        status: 'finished',
        session_owner: 'su-child-1',
      },
      {
        spawn_id: 'spawn-grandchild',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'su-child-1',
        parent_role: 'judge',
        child_role: 'judge',
        run_id: 'run-grandchild',
        status: 'finished',
        session_owner: 'su-grandchild',
      },
      {
        spawn_id: 'spawn-sibling-a',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'su-common-parent',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-sibling-a',
        status: 'finished',
        session_owner: 'su-sibling-a',
      },
      {
        spawn_id: 'spawn-sibling-b',
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        parent_spawn_id: 'su-common-parent',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-sibling-b',
        status: 'finished',
        session_owner: 'su-sibling-b',
      },
      {
        spawn_id: 'spawn-cross-tenant-child',
        workspace_id: 'different-workspace',
        harness_slug: 'h-a',
        parent_spawn_id: 'su-author',
        parent_role: 'su',
        child_role: 'judge',
        run_id: 'run-cross-tenant-child',
        status: 'finished',
        session_owner: 'su-cross-tenant-child',
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.spawned_agents ${db.adminSql(spawns)}`;
    const sessions = [
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-child',
        launch_spec: { launchedBy: 'su-author' },
      },
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-grandchild',
        launch_spec: { launchedBy: 'su-psu-child' },
      },
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-sibling-a',
        launch_spec: { launchedBy: 'su-psu-common-parent' },
      },
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-psu-sibling-b',
        launch_spec: { launchedBy: 'su-psu-common-parent' },
      },
      {
        workspace_id: 'different-workspace',
        mode: 'console',
        coord_owner_id: 'su-cross-tenant-psu-child',
        launch_spec: { launchedBy: 'su-author' },
      },
      // P-005 (review-routing-through-relevance-router-2026-09-26): an implementer
      // REQUESTS a routed review, so the consult dispatcher records the implementer
      // as the launcher of the answering fork (get-feedback-prod passes the
      // requester as launchedBy). Only the fork's SOURCE decides its lineage.
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-amend-review-fork',
        launch_spec: { launchedBy: 'su-amend-implementer' },
      },
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-amend-inlineage-fork',
        launch_spec: { launchedBy: 'su-amend-implementer' },
      },
      // An ORDINARY launch by the implementer — not a routed answer — is lineage.
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-amend-implementer-child',
        launch_spec: { launchedBy: 'su-amend-implementer' },
      },
      // The consult selection stamp is best-effort: the durable task-ledger
      // consultAnswer row is the fallback source for this routed fork's lineage.
      {
        workspace_id: workspaceId,
        mode: 'console',
        coord_owner_id: 'su-amend-review-ledger-fork',
        launch_spec: { launchedBy: 'su-amend-implementer' },
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.adv_sessions ${db.adminSql(sessions)}`;
    // P-004 consult-dispatch edges. `su-consult-fork` is launched by the SYSTEM
    // sweep actor, exactly as a dispatched grader is — so the launch edge above
    // says nothing about its source, and only this edge can relate it to the
    // transcript it answers from.
    const consults = [
      {
        workspace_id: workspaceId,
        conversation_id: 'conv-lineage-1',
        requester_id: 'su-consult-requester',
        responder_id: 'su-consult-source',
        state: 'awaiting_responder',
        question: 'q',
        latency_contract: 'proceed',
        routing: {
          selection: {
            selected: [
              { ownerId: 'su-consult-source', via: 'floor', answeringOwnerId: 'su-consult-fork' },
              // A CONVERSION keeps the source identity; the edge must not
              // manufacture a self-loop out of it.
              { ownerId: 'su-consult-converted', via: 'floor', answeringOwnerId: 'su-consult-converted' },
              // Not yet dispatched — no answering identity, no edge.
              { ownerId: 'su-consult-untried', via: 'floor' },
            ],
          },
        },
      },
      {
        workspace_id: 'different-workspace',
        conversation_id: 'conv-lineage-cross',
        requester_id: 'su-consult-requester',
        responder_id: 'su-author',
        state: 'awaiting_responder',
        question: 'q',
        latency_contract: 'proceed',
        routing: {
          selection: { selected: [{ ownerId: 'su-author', answeringOwnerId: 'su-cross-tenant-consult-fork' }] },
        },
      },
      {
        workspace_id: workspaceId,
        conversation_id: 'conv-amend-review',
        requester_id: 'su-amend-implementer',
        responder_id: 'su-amend-expert',
        state: 'awaiting_responder',
        question: 'q',
        latency_contract: 'hard-blocked',
        routing: {
          policy: 'acceptance-bar-amendment-review',
          selection: {
            selected: [
              { ownerId: 'su-amend-expert', via: 'floor', answeringOwnerId: 'su-amend-review-fork' },
              // A fork of the implementer's OWN child: related through its source.
              { ownerId: 'su-amend-implementer-child', via: 'floor', answeringOwnerId: 'su-amend-inlineage-fork' },
            ],
          },
        },
      },
      {
        workspace_id: workspaceId,
        conversation_id: 'conv-amend-review-ledger',
        requester_id: 'su-amend-implementer',
        responder_id: 'su-amend-expert',
        state: 'awaiting_responder',
        question: 'q',
        latency_contract: 'hard-blocked',
        routing: {
          policy: 'acceptance-bar-amendment-review',
          selection: { selected: [{ ownerId: 'su-amend-expert', via: 'floor' }] },
        },
      },
    ].map((row) => ({ ...row, routing: db.adminSql.json(row.routing as never) }));
    await db.adminSql`INSERT INTO harness_shared.consult_state ${db.adminSql(consults)}`;
    await db.adminSql`INSERT INTO harness_shared.task_ledger ${db.adminSql([
      {
        task_id: 'consult-answer-ledger-fork',
        workspace_id: workspaceId,
        root_task_id: 'consult-answer-ledger-fork',
        class: 'agent-session',
        title: 'consult answer fork without selection stamp',
        launched_by: 'su-amend-implementer',
        detail: db.adminSql.json({
          consultAnswer: {
            conversationId: 'conv-amend-review-ledger',
            operation: 'fork',
            sourceOwnerId: 'su-amend-expert',
            answeringOwnerId: 'su-amend-review-ledger-fork',
          },
        }),
      },
      {
        task_id: 'consult-answer-cross-tenant-fork',
        workspace_id: 'different-workspace',
        root_task_id: 'consult-answer-cross-tenant-fork',
        class: 'agent-session',
        title: 'cross-tenant consult answer must not leak lineage',
        launched_by: 'su-other-tenant',
        detail: db.adminSql.json({
          consultAnswer: {
            conversationId: 'conv-cross-tenant-ledger',
            operation: 'fork',
            sourceOwnerId: 'su-author',
            answeringOwnerId: 'su-cross-tenant-ledger-fork',
          },
        }),
      },
    ])}`;
    const planWorkItems = [
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-split-terminal',
        item_kind: 'bug',
        status: 'done',
        source_plan_slug: 'split-role-plan',
        terminal_owner: 'su-plan-terminal-owner',
        taken_by: 'su-plan-current-owner',
        last_released_by: 'su-plan-released-owner',
        worked_by_history: [
          { owner: 'su-plan-prior-owner', at: '2026-09-04T10:00:00.000Z' },
          'su-plan-string-history-owner',
        ],
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-split-current',
        item_kind: 'change',
        status: 'open',
        source_plan_slug: 'split-role-plan',
        terminal_owner: null,
        taken_by: 'su-plan-current-owner-2',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-split-blank',
        item_kind: 'task',
        status: 'open',
        source_plan_slug: 'split-role-plan',
        terminal_owner: ' ',
        taken_by: ' ',
      },
      {
        workspace_id: workspaceId,
        harness_slug: 'h-a',
        feature_id: 'WI-other-plan',
        item_kind: 'bug',
        status: 'done',
        source_plan_slug: 'other-plan',
        terminal_owner: 'su-other-plan-owner',
        taken_by: null,
      },
      {
        workspace_id: 'different-workspace',
        harness_slug: 'h-a',
        feature_id: 'WI-cross-tenant-plan',
        item_kind: 'bug',
        status: 'done',
        source_plan_slug: 'split-role-plan',
        terminal_owner: 'su-cross-tenant-owner',
        taken_by: null,
      },
    ];
    await db.adminSql`INSERT INTO harness_shared.work_items ${db.adminSql(
      planWorkItems.map((row) => ({ last_released_by: null, worked_by_history: [], ...row })),
    )}`;
    await db.adminSql`
      INSERT INTO harness_shared.plan_audits
        (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
         activation, audited_plan_revision_id, audited_plan_revision_seq,
         audited_plan_content_hash)
      VALUES
        (${workspaceId}, 'h-a', 'split-role-plan', 1, 'su-plan-activation-auditor',
         'activation', '{}'::jsonb, 1, 1, ${'a'.repeat(64)}),
        (${workspaceId}, 'h-a', 'split-role-plan', 2, 'su-plan-completion-auditor',
         'completion', NULL, NULL, NULL, NULL),
        ('different-workspace', 'h-a', 'split-role-plan', 1, 'su-cross-tenant-auditor',
         'completion', NULL, NULL, NULL, NULL)
    `;
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('accepts exact, direct, and multi-hop successors but rejects failed, unrelated, and cross-workspace edges', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-author', opts)).resolves.toBe(true);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-successor-1', opts)).resolves.toBe(true);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-successor-2', opts)).resolves.toBe(true);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-refused', opts)).resolves.toBe(false);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-unrelated', opts)).resolves.toBe(false);
    await expect(isAcceptanceAuthorIdentity('su-author', 'su-cross-tenant', opts)).resolves.toBe(false);
  });

  it('resolves current, historical, released, terminal, and audit owners, workspace-scoped', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await expect(resolvePlanImplementerIdentities('split-role-plan', opts)).resolves.toEqual([
      'su-plan-activation-auditor',
      'su-plan-completion-auditor',
      'su-plan-current-owner',
      'su-plan-current-owner-2',
      'su-plan-prior-owner',
      'su-plan-released-owner',
      'su-plan-string-history-owner',
      'su-plan-terminal-owner',
    ]);
    await expect(resolvePlanImplementerIdentities('other-plan', opts)).resolves.toEqual(['su-other-plan-owner']);
    await expect(resolvePlanImplementerIdentities('missing-plan', opts)).resolves.toEqual([]);
    await expect(resolvePlanImplementerIdentities(' ', opts)).resolves.toEqual([]);
  });

  it('fails closed when append-only worker history has an unreadable shape', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await db.adminSql`
      UPDATE harness_shared.work_items
         SET worked_by_history = '{}'::jsonb
       WHERE workspace_id = ${workspaceId}
         AND feature_id = 'WI-split-current'
    `;
    try {
      await expect(resolvePlanImplementerIdentities('split-role-plan', opts)).rejects.toThrow(
        /acceptance_lineage_unreadable/,
      );
    } finally {
      await db.adminSql`
        UPDATE harness_shared.work_items
           SET worked_by_history = '[]'::jsonb
         WHERE workspace_id = ${workspaceId}
           AND feature_id = 'WI-split-current'
      `;
    }
  });

  it('treats descendants, ancestors, and rebind successors as related but keeps siblings and tenants separate', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await expect(areAcceptanceLineageRelated('su-author', 'su-child-1', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-author', 'su-grandchild', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-grandchild', 'su-author', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-author', 'su-successor-2', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-author', 'su-psu-grandchild', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-psu-grandchild', 'su-author', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-sibling-a', 'su-sibling-b', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-psu-sibling-a', 'su-psu-sibling-b', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-author', 'su-unrelated', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-author', 'su-cross-tenant-child', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-author', 'su-cross-tenant-psu-child', opts)).resolves.toBe(false);
  });

  it('P-004: a consult FORK is lineage-related to the transcript it answers from, in BOTH directions', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    // The whole point: exclusion follows the KNOWLEDGE. Without this edge the
    // fork's only ancestor is whoever launched it — for a dispatched grader the
    // system sweep actor — so an excluded expert's own transcript could grade
    // the plan they implemented and read as an independent judge.
    await expect(areAcceptanceLineageRelated('su-consult-source', 'su-consult-fork', opts)).resolves.toBe(true);
    await expect(areAcceptanceLineageRelated('su-consult-fork', 'su-consult-source', opts)).resolves.toBe(true);
    // A selectee with no answering identity yet has no edge — an untried rank
    // must not pre-emptively relate anyone.
    await expect(areAcceptanceLineageRelated('su-consult-untried', 'su-consult-fork', opts)).resolves.toBe(false);
    // Two forks of DIFFERENT sources are siblings, not relatives.
    await expect(areAcceptanceLineageRelated('su-consult-fork', 'su-consult-converted', opts)).resolves.toBe(false);
    // Still workspace-scoped.
    await expect(
      areAcceptanceLineageRelated('su-author', 'su-cross-tenant-consult-fork', opts),
    ).resolves.toBe(false);
  });

  it('P-005: a routed fork is judged by its SOURCE lineage, not by the requester recorded as its launcher', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    // The acceptance-BAR amendment apply guard refuses an approval whose author is
    // related to any implementer. The implementer requested the review, so it is
    // the fork's recorded launcher; if that launch edge counted, every routed
    // reviewer would be refused as the implementer's own descendant.
    await expect(areAcceptanceLineageRelated('su-amend-review-fork', 'su-amend-implementer', opts)).resolves.toBe(false);
    await expect(areAcceptanceLineageRelated('su-amend-implementer', 'su-amend-review-fork', opts)).resolves.toBe(false);
    // Exclusion still follows the knowledge: the fork is its source expert.
    await expect(areAcceptanceLineageRelated('su-amend-review-fork', 'su-amend-expert', opts)).resolves.toBe(true);
    // Not a blanket exemption: an ordinary launch by the implementer stays lineage,
    await expect(areAcceptanceLineageRelated('su-amend-implementer-child', 'su-amend-implementer', opts)).resolves.toBe(
      true,
    );
    // and a routed fork of an implementer-lineage source is still related, via that source.
    await expect(areAcceptanceLineageRelated('su-amend-inlineage-fork', 'su-amend-implementer', opts)).resolves.toBe(
      true,
    );
    const keys = await lineagePartyKeys(['su-amend-implementer', 'su-amend-review-fork', 'su-amend-expert'], opts);
    expect(keys.get('su-amend-review-fork')).toBe(keys.get('su-amend-expert'));
    expect(keys.get('su-amend-review-fork')).not.toBe(keys.get('su-amend-implementer'));
  });

  it('P-005: consultAnswer ledger lineage covers a routed fork whose selection has no answeringOwnerId', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    await expect(
      areAcceptanceLineageRelated('su-amend-review-ledger-fork', 'su-amend-expert', opts),
    ).resolves.toBe(true);
    await expect(
      areAcceptanceLineageRelated('su-amend-review-ledger-fork', 'su-amend-implementer', opts),
    ).resolves.toBe(false);
    await expect(
      areAcceptanceLineageRelated('su-author', 'su-cross-tenant-ledger-fork', opts),
    ).resolves.toBe(false);
    const keys = await lineagePartyKeys(
      ['su-amend-expert', 'su-amend-review-ledger-fork', 'su-amend-implementer'],
      opts,
    );
    expect(keys.get('su-amend-review-ledger-fork')).toBe(keys.get('su-amend-expert'));
    expect(keys.get('su-amend-review-ledger-fork')).not.toBe(keys.get('su-amend-implementer'));
  });

  it('P-005: acceptanceLineageClosure(id).has(x) equals areAcceptanceLineageRelated(x, id) for every fixture pair', async () => {
    const opts = { sql: db.adminSql, workspaceId };
    // The amendment-review screen answers per candidate from this closure, while
    // the apply guard asks pairwise. They must be the same relation.
    const ids = [
      'su-author', 'su-child-1', 'su-grandchild', 'su-successor-2', 'su-psu-grandchild',
      'su-sibling-a', 'su-sibling-b', 'su-psu-sibling-a', 'su-consult-source', 'su-consult-fork',
      'su-consult-converted', 'su-amend-implementer', 'su-amend-review-fork', 'su-amend-expert',
      'su-amend-implementer-child', 'su-amend-inlineage-fork', 'su-unrelated',
    ];
    let relatedPairs = 0;
    for (const target of ids) {
      const closure = await acceptanceLineageClosure(target, opts);
      for (const candidate of ids) {
        const pairwise = await areAcceptanceLineageRelated(candidate, target, opts);
        expect({ candidate, target, related: closure.has(candidate) }).toEqual({ candidate, target, related: pairwise });
        if (pairwise) relatedPairs += 1;
      }
    }
    // Positive control: related pairs beyond the diagonal exist, so parity is not vacuous.
    expect(relatedPairs).toBeGreaterThan(ids.length);
    await expect(acceptanceLineageClosure('  ', opts)).resolves.toEqual(new Set());
  });

  /**
   * D-008 / P-005. These MUST be real-PG: `lineagePartyKeys` fails toward "no
   * pairs found", which a stubbed test reads as a clean "no duplicate parties"
   * while the guard is silently inert — the same class of invisible-malformed-
   * query D-007 hit. Only executing the recursive CTE proves it composes.
   */
  describe('lineagePartyKeys', () => {
    const opts = () => ({ sql: db.adminSql, workspaceId });

    it('P-004: a consult fork and its source collapse to ONE party, so a menu cannot seat both', async () => {
      // The set-based reader must learn the edge at the same moment the pairwise
      // one does — that is why identityEdges is defined once. A grading menu
      // that seated an expert AND a fork of that expert would look like two
      // independent judges while being one transcript twice.
      const keys = await lineagePartyKeys(['su-consult-source', 'su-consult-fork', 'su-unrelated'], opts());
      expect(keys.get('su-consult-fork')).toBe(keys.get('su-consult-source'));
      expect(keys.get('su-unrelated')).toBe('su-unrelated');
    });

    it('groups a spawn chain and a launch chain into one party each, keyed by CALLER order', async () => {
      const keys = await lineagePartyKeys(['su-author', 'su-child-1', 'su-grandchild', 'su-unrelated'], opts());
      expect(keys.get('su-author')).toBe('su-author');
      expect(keys.get('su-child-1')).toBe('su-author');
      expect(keys.get('su-grandchild')).toBe('su-author');
      // An id with no edge into the set is its own party, never merged by default.
      expect(keys.get('su-unrelated')).toBe('su-unrelated');

      const launched = await lineagePartyKeys(['su-author', 'su-psu-grandchild'], opts());
      expect(launched.get('su-psu-grandchild')).toBe('su-author');
    });

    it('the key is the EARLIEST caller-order member, so a ranked pool keeps its best-ranked face', async () => {
      // Reversing the input must reverse the representative — that is what makes
      // "collapse a ranked pool" keep the top-ranked candidate rather than an
      // arbitrary one. A key derived from the ledger instead of caller order
      // would return 'su-author' both times and pass the test above regardless.
      const forward = await lineagePartyKeys(['su-author', 'su-child-1'], opts());
      const reversed = await lineagePartyKeys(['su-child-1', 'su-author'], opts());
      expect(forward.get('su-child-1')).toBe('su-author');
      expect(reversed.get('su-author')).toBe('su-child-1');
    });

    it('keeps SIBLINGS apart when their shared parent is not in the set (not connected components)', async () => {
      // The calibration for the over-merge below: sharing a parent is not lineage,
      // so an undirected-reachability implementation would wrongly merge these and
      // this is the only assertion that would catch it.
      const spawned = await lineagePartyKeys(['su-sibling-a', 'su-sibling-b'], opts());
      expect(spawned.get('su-sibling-a')).toBe('su-sibling-a');
      expect(spawned.get('su-sibling-b')).toBe('su-sibling-b');

      const launchedSiblings = await lineagePartyKeys(['su-psu-sibling-a', 'su-psu-sibling-b'], opts());
      expect(launchedSiblings.get('su-psu-sibling-a')).toBe('su-psu-sibling-a');
      expect(launchedSiblings.get('su-psu-sibling-b')).toBe('su-psu-sibling-b');
    });

    it('DISCLOSED (D-008): siblings DO merge once their shared parent is also a candidate', async () => {
      // Union-find over in-set pairs, so the parent bridges its children. Asserted
      // deliberately: this over-EXCLUDES, the safe direction for an independence
      // guard, and recording it stops a later reader "fixing" it into an
      // under-exclusion that would re-open the n=2 self-review path.
      const keys = await lineagePartyKeys(
        ['su-psu-common-parent', 'su-psu-sibling-a', 'su-psu-sibling-b'],
        opts(),
      );
      expect(keys.get('su-psu-sibling-a')).toBe('su-psu-common-parent');
      expect(keys.get('su-psu-sibling-b')).toBe('su-psu-common-parent');
    });

    it('never merges across workspaces, and short-circuits below two ids', async () => {
      const crossTenant = await lineagePartyKeys(
        ['su-author', 'su-cross-tenant-child', 'su-cross-tenant-psu-child'],
        opts(),
      );
      expect(crossTenant.get('su-cross-tenant-child')).toBe('su-cross-tenant-child');
      expect(crossTenant.get('su-cross-tenant-psu-child')).toBe('su-cross-tenant-psu-child');

      await expect(lineagePartyKeys([], opts())).resolves.toEqual(new Map());
      await expect(lineagePartyKeys(['su-author'], opts())).resolves.toEqual(new Map([['su-author', 'su-author']]));
      // Blank/duplicate ids are dropped rather than becoming their own parties.
      await expect(lineagePartyKeys(['su-author', ' ', null, 'su-author'], opts())).resolves.toEqual(
        new Map([['su-author', 'su-author']]),
      );
    });
  });
});
