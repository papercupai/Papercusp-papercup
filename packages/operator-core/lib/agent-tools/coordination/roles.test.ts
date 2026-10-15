/**
 * COORD_ROLES membership — pins the coord-role set and, in particular, that the
 * generic Hive worker `cup` is a member (bee-capability-expansion-2026-06-08 P-001).
 *
 * Why this matters: a tool gated `agentRoles: [...COORD_ROLES]` is callable by a
 * role-scoped (signed) caller ONLY if that caller's role is in this list. The bee
 * coordinates (coord:declare-intent/send/await-inbox), maintains its work-list
 * (work_items:*), and — the P-001 contract — creates + reads ideas and issues
 * (improvements:capture, work_items:create/list/get) which all gate on COORD_ROLES.
 * If `cup` silently dropped out of this constant, every one of those would start
 * failing `role_not_allowed` for a bee-role-scoped URL with no other signal. Pin it.
 */
import { describe, test, expect } from 'vitest';
import {
  COORD_REPLY_ROLES,
  COORD_READ_ROLES,
  COORD_ROLES,
  DESKTOP_AGENT_ROLES,
  QUEEN_PLACEMENT_ROLES,
  WORK_ITEM_LIFECYCLE_ROLES,
} from './roles';

describe('COORD_ROLES', () => {
  test('researcher reaches every morning AI operation dependency without broad coordination or placement', { timeout: 60_000 }, async () => {
    // EI-25392637620560983: requiredTools passed the identity/listing gates,
    // but the independent dispatch role gate rejected get, claim and send.
    const required = [
      '../capability/fetch.js', '../capability/read.js',
      '../work_items/get.js', '../work_items/claim.js', '../work_items/complete.js',
      '../plans/get.js', '../reports/publish.js', '../reports/get.js',
      '../reports/list.js', './tools/send.js',
    ];
    const tools = await Promise.all(required.map(async (path) => (await import(path)).default));
    expect(tools.filter((tool) => !tool.agentRoles?.includes('researcher')).map((tool) => tool.name))
      .toEqual([]);
    // Keep the extension on the concrete tools; joining any of these sets
    // would also open unrelated writers, readers, or placement surfaces.
    for (const roles of [COORD_ROLES, COORD_READ_ROLES, COORD_REPLY_ROLES,
      WORK_ITEM_LIFECYCLE_ROLES, QUEEN_PLACEMENT_ROLES, DESKTOP_AGENT_ROLES]) {
      expect(roles).not.toContain('researcher');
    }
    for (const path of ['../work_items/create.js', '../work_items/set_state.js',
      './tools/escalate.js', '../gym/judge.js']) {
      const { default: tool } = await import(path);
      expect(tool.agentRoles, `${tool.name}: researcher must not gain this surface`).not.toContain('researcher');
    }
  });

  test('acceptance judge can read and settle its own owner directives without general coordination writes', async () => {
    const [get, list, summarize, disposition, record] = await Promise.all([
      import('../orders/get.js'),
      import('../orders/list.js'),
      import('../orders/summarize.js'),
      import('../orders/disposition.js'),
      import('../orders/record.js'),
    ]);
    for (const [name, tool] of [
      ['orders:get', get.default],
      ['orders:list', list.default],
      ['orders:summarize', summarize.default],
      ['orders:disposition', disposition.default],
    ] as const) {
      expect(tool.agentRoles, `${name} must admit judge`).toContain('judge');
    }
    expect(record.default.agentRoles).not.toContain('judge');
    expect(COORD_ROLES).not.toContain('judge');
  });

  test('acceptance judge can consume coordination reads without becoming a general coordinator', async () => {
    const [
      { default: inbox },
      { default: read },
      { default: orient },
      { default: whoami },
      { default: cupMail },
      { default: assignments },
    ] = await Promise.all([
      import('./tools/inbox.js'),
      import('./tools/read.js'),
      import('./tools/orient.js'),
      import('./tools/whoami.js'),
      import('../fleet/cup_mail.js'),
      import('../fleet/assignments.js'),
    ]);

    for (const [name, tool] of [
      ['coord:inbox', inbox],
      ['coord:read', read],
      ['coord:orient', orient],
      ['coord:whoami', whoami],
      ['fleet:cup_mail', cupMail],
      ['fleet:assignments', assignments],
    ] as const) {
      expect(tool.agentRoles, `${name} must admit judge`).toContain('judge');
    }
    expect(COORD_READ_ROLES).toContain('judge');
    expect(COORD_ROLES).not.toContain('judge');
  });

  test('acceptance judge can read and advance routed consults without becoming a general coordinator', async () => {
    const [
      { default: conversationsGet },
      { default: consultReply },
      { default: consultDecline },
      { default: consultClose },
    ] = await Promise.all([
      import('./tools/conversations-get.js'),
      import('../consult/reply.js'),
      import('../consult/decline.js'),
      import('../consult/close.js'),
    ]);

    for (const [name, tool] of [
      ['conversations:get', conversationsGet],
      ['consult:reply', consultReply],
      ['consult:decline', consultDecline],
      ['consult:close', consultClose],
    ] as const) {
      expect(tool.agentRoles, `${name} must admit judge`).toContain('judge');
    }
    expect(COORD_ROLES).not.toContain('judge');
  });

  test('bee is a coord role (P-001 — improvements:capture + work_items:* resolve for a bee URL)', () => {
    expect(COORD_ROLES).toContain('cup');
  });

  test('sentinel is a coord role (unify-launch-mechanics D-004 — fleet:assignments/tree + coord:* resolve for a sentinel URL)', () => {
    expect(COORD_ROLES).toContain('papercup');
  });

  test('overwatch is a coord role (overwatch-role-2026-06-15 B-01 — coord:send/escalate + improvements:capture + topics:feed resolve for an overwatch URL)', () => {
    expect(COORD_ROLES).toContain('kettle');
  });

  test('the pipeline + chat coord roles are all present (catches an accidental removal)', () => {
    for (const role of [
      'scoper',
      'architect',
      'worker',
      'validator',
      'reviewer',
      'debugger',
      'operator',
      'documenter',
      'curator',
      'cup',
    ]) {
      expect(COORD_ROLES, `missing ${role}`).toContain(role);
    }
  });

  test('the pot-rename dual-accept twins are coord roles (cup/mug/papercup/kettle accepted alongside the old ids)', () => {
    for (const role of ['cup', 'mug', 'papercup', 'kettle']) {
      expect(COORD_ROLES, `missing twin ${role}`).toContain(role);
    }
    // scout was never a coord role, so its twin `blender` is intentionally absent.
    expect(COORD_ROLES).not.toContain('blender');
  });

  test('content-fixer is a coord role (launch-fixer workflow requires orient and work-item coordination)', () => {
    expect(COORD_ROLES).toContain('content-fixer');
  });

  test('AUTH INVARIANT (pot-rename P2): COORD_ROLES + the read-mostly exclusion admit mug but exclude cup/papercup/kettle', () => {
    // Every Queen-only write tool (fleet/place_batch, gym/*, experiment/*,
    // computer/*-desktop) imports QUEEN_PLACEMENT_ROLES (EI-145 part 2 —
    // `cup/spawn` was in this list until P-059 retired it —
    // previously each re-derived the identical inline filter; now ONE shared array,
    // so this single test holding is enough for every site to hold in lockstep —
    // no more "the tool files carry the literal verbatim; grep keeps them in sync").
    for (const excluded of ['cup', 'papercup', 'papercup-deep', 'kettle']) {
      expect(QUEEN_PLACEMENT_ROLES, `${excluded} must be excluded from Queen-only tools`).not.toContain(
        excluded,
      );
    }
    // placement/judgement is the Queen's — she keeps access.
    expect(QUEEN_PLACEMENT_ROLES).toContain('mug');
  });

  test('AUTH INVARIANT (agent-multi-desktops D-013): the worker cup may own desktops; read-mostly roles may not', () => {
    for (const excluded of ['papercup', 'papercup-deep', 'kettle']) {
      expect(DESKTOP_AGENT_ROLES, `${excluded} must never own a desktop`).not.toContain(excluded);
    }
    expect(DESKTOP_AGENT_ROLES).toContain('cup');
    // Every placement role keeps desktop access — the set only ever GROWS by cup.
    for (const role of QUEEN_PLACEMENT_ROLES) expect(DESKTOP_AGENT_ROLES).toContain(role);
    expect(DESKTOP_AGENT_ROLES.length).toBe(QUEEN_PLACEMENT_ROLES.length + 1);
  });

  test(
    'the COORD_ROLES-gated idea/work-item tools actually admit bee (the consumer half)',
    // The dynamic imports below pull the tool modules' FULL transitive graph
    // (dispatch stack, drizzle schema, …) through vitest's on-demand transform
    // — measured ~5.6s cold on the dev box (2026-07-12), which outgrew the 5s
    // default and made this timeout-flake. Import weight, not test logic. Under
    // the fully-parallel green-checkpoint gate (candidate 0fe0b5aa, 2026-07-17)
    // even 30s was exceeded (timed out at 36s) when the whole workspace was
    // re-running under contention — bumped to 60s so peak gate load can't re-red
    // an import-weight-bound assertion. Runs in ~6s in isolation.
    { timeout: 60_000 },
    async () => {
      // Capability alone is not enough; the tool's agentRoles allowlist must include
      // the caller's role (mirrors the scanner output-contract test in
      // role-principal-caps.test.ts). These three are the P-001 "bees can already
      // create + read ideas/work-items" contract — verify, don't assume.
      const { default: capture } = await import('../improvements/capture.js');
      const { default: createWorkItem } = await import('../work_items/create.js');
      const { default: listWorkItems } = await import('../work_items/list.js');
      expect(capture.agentRoles).toContain('cup');
      expect(createWorkItem.agentRoles).toContain('cup');
      expect(listWorkItems.agentRoles).toContain('cup');
    },
  );

  test(
    'the dedicated acceptance judge stays outside general coordination while gaining its narrow lifecycle lane',
    { timeout: 60_000 },
    async () => {
      // The judge role is intentionally NOT a general coordination role. Its
      // acceptance-rubric method needs these explicit evidence surfaces plus
      // the narrow work-item lifecycle writer lane; adding it to COORD_ROLES
      // would also expose unrelated coordination tools.
      const { default: workItemsGet } = await import('../work_items/get.js');
      const { default: searchFulltext } = await import('../search/fulltext.js');
      const { default: rubricSearch } = await import('../rubrics/search.js');
      const { default: planRevisions } = await import('../plans/revisions-list.js');
      const { default: scorecardsEvaluate } = await import('../scorecards/evaluate.js');
      const { default: pgQuery } = await import('../dev/pg_query.js');
      const { default: degenerateCheck } = await import('../gates/degenerate-check.js');

      for (const [name, tool] of [
        ['work_items:get', workItemsGet],
        ['search:fulltext', searchFulltext],
        ['rubrics:search', rubricSearch],
        ['plans:revisions', planRevisions],
        ['scorecards:evaluate', scorecardsEvaluate],
        ['dev:pg_query', pgQuery],
        ['gates:degenerate-check', degenerateCheck],
      ] as const) {
        expect(tool.agentRoles, `${name} must admit judge`).toContain('judge');
      }
      expect(WORK_ITEM_LIFECYCLE_ROLES).toContain('judge');
      expect(COORD_REPLY_ROLES).toContain('judge');
      expect(COORD_ROLES).not.toContain('judge');
    },
  );

  test(
    'the fast↔deep delegation channel admits both papercup and papercup-deep (voice-release P-006)',
    // Same import-weight caveat as the test above: these pull the coord tool
    // modules' full transitive graph through vitest's transform. Same 60s
    // gate-load headroom (see the note on the test above).
    { timeout: 60_000 },
    async () => {
      // voice-public-release-readiness-2026-07-12 P-006 / D-003: the fast
      // front-end (papercup) delegates questions to the hidden deep brain
      // (papercup-deep) over the modern coord/wake channel — a directed
      // coord:send { wake:'required' } each way, discovered via coord:presence,
      // with coord:wake-mode { auto } at boot so wakes actually deliver.
      // If either role silently dropped off any of these tools' allowlists,
      // delegation would fail role_not_allowed with no other signal. Pin it.
      const { default: send } = await import('./tools/send.js');
      const { default: ack } = await import('./tools/ack.js');
      const { default: presence } = await import('./tools/presence.js');
      const { default: wakeMode } = await import('./tools/wake-mode.js');
      const { default: orient } = await import('./tools/orient.js');
      for (const role of ['papercup', 'papercup-deep']) {
        expect(send.agentRoles, `coord:send must admit ${role}`).toContain(role);
        expect(presence.agentRoles, `coord:presence must admit ${role}`).toContain(role);
        expect(wakeMode.agentRoles, `coord:wake-mode must admit ${role}`).toContain(role);
        expect(orient.agentRoles, `coord:orient must admit ${role}`).toContain(role);
      }
      expect(send.agentRoles, 'coord:send must admit judge for replies').toContain('judge');
      expect(ack.agentRoles, 'coord:ack must admit judge for acknowledgements').toContain('judge');
      expect(send.agentRoles, 'coord:send must not widen the shared role set').not.toEqual(COORD_ROLES);
    },
  );
});
