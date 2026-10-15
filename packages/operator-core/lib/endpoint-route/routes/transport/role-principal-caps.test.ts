/**
 * loadRoleCapabilities — the spawned-role → capability synthesis. Pins the
 * program-blueprint role grant (coordination-ops-as-blueprint-primitives): a
 * spawned voter/advocate has no system_principals row but must still get
 * coord:write (so coord:thread-post passes the capability gate), while ordinary
 * pipeline roles keep their empty least-privilege set.
 */
import { describe, test, expect } from 'vitest';
import type { Sql } from 'postgres';
import {
  CAPABILITY_REPLACEMENT_PRINCIPAL_CAPS,
  CAPABILITY_REPLACEMENT_PRINCIPAL_ROLES,
  effectiveDispatchWorkspace,
  loadRoleCapabilities,
  synthesizeDispatchPrincipal,
  synthesizeResourcePrincipal,
  synthesizeTransportPrincipal,
} from './role-principal-caps.js';
import { FLEET_CAPABILITY_ROLES } from '@papercusp/orchestrator';

/** A fake `tx` tagged-template that returns a fixed row set regardless of query. */
function fakeTx(rows: Array<{ capabilities: unknown }>): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql;
}

describe('loadRoleCapabilities', () => {
  test('judge can reproduce autoloop status only through its read capability', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'judge');
    const { default: status } = await import('../../../agent-tools/autoloop/status.js');

    expect(status.agentRoles).toContain('judge');
    expect(status.capability).toBe('autoloop:read');
    expect(caps.has('autoloop:read')).toBe(true);
    expect(caps.has('autoloop:write')).toBe(false);
  });

  test.each(['papercup', 'papercup-deep'])('%s can read the public manual without receiving a docs write grant', async (role) => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', role);
    expect(caps.has('docs:read')).toBe(true);
    expect(caps.has('docs:write')).toBe(false);
  });
  test('transcript readers get sessions:read without granting generic search to judge', async () => {
    const reader = await loadRoleCapabilities(fakeTx([{ capabilities: ['search:read'] }]), 'ws', 'transcript-reader');
    expect(reader.has('search:read')).toBe(true);
    expect(reader.has('sessions:read')).toBe(true);

    const judge = await loadRoleCapabilities(fakeTx([{ capabilities: ['search:read'] }]), 'ws', 'judge');
    expect(judge.has('search:read')).toBe(false);
    expect(judge.has('sessions:read')).toBe(true);
  });

  test('memory:read preserves search access through a narrow derived capability', async () => {
    const reader = await loadRoleCapabilities(fakeTx([{ capabilities: ['memory:read'] }]), 'ws', 'memory-reader');
    expect(reader.has('memory:read')).toBe(true);
    expect(reader.has('memory:search:read')).toBe(true);

    const judge = await loadRoleCapabilities(fakeTx([{ capabilities: ['memory:read'] }]), 'ws', 'judge');
    expect(judge.has('memory:search:read')).toBe(true);
    expect(judge.has('memory:read')).toBe(false);
  });

  describe('native-tool cutover replacement grants', () => {
    test('principal grant roles stay in lockstep with orchestrator FLEET_CAPABILITY_ROLES', () => {
      expect(new Set(CAPABILITY_REPLACEMENT_PRINCIPAL_ROLES)).toEqual(new Set(FLEET_CAPABILITY_ROLES));
    });

    test.each([...FLEET_CAPABILITY_ROLES])('%s gets every capability:* replacement grant', async (role) => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', role);
      for (const capability of CAPABILITY_REPLACEMENT_PRINCIPAL_CAPS) {
        expect(caps.has(capability), `${role} missing ${capability}`).toBe(true);
      }
    });

    test('non-cutover evidence-only roles do not inherit the replacement grant set', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'judge');
      expect(caps.has('capability:git')).toBe(false);
      expect(caps.has('capability:bash')).toBe(false);
      expect(caps.has('capability:fs-write')).toBe(false);
    });
  });

  test('voter (no system_principals row) gets the program-blueprint baseline incl. coord:write', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'papercusp-workspace', 'voter');
    expect(caps.has('coord:write')).toBe(true);
    expect(caps.has('coord:read')).toBe(true);
    expect(caps.has('docs:read')).toBe(true);
    expect(caps.has('search:read')).toBe(true);
  });

  test('advocate gets coord:write too', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'advocate');
    expect(caps.has('coord:write')).toBe(true);
  });

  test(
    "scanner's OUTPUT CONTRACT is reachable: caps grant coord:write AND improvements:capture allowlists the role (P-009 smoke regression)",
    // This is deliberately an execution check of the real tool descriptor. Its
    // dynamic import pulls the full capture/dispatch graph and measured 8s of
    // cold transform time in isolation, so the default 5s budget is invalid.
    { timeout: 60_000 },
    async () => {
      // The capability half: the scan launch blueprint's scanner gets coord:write
      // (improvements:capture's declared capability) from BLUEPRINT_ROLE_CAPS.
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'scanner');
      expect(caps.has('coord:write')).toBe(true);
      expect(caps.has('harness:read')).toBe(true);
      // The ALLOWLIST half — the one the live smoke caught missing: capability
      // alone is not enough; the tool's per-role allowlist must include scanner
      // or the tool never appears in its projected surface and findings can't
      // land as work_items (the D-005 output contract).
      const { default: capture } = await import('../../../agent-tools/improvements/capture.js');
      expect(capture.agentRoles).toContain('scanner');
    },
  );

  test('scanner (launch-blueprint role) gets coord:write + the read caps it scans with', async () => {
    // unify-agent-launches-as-blueprints D-005: the scan blueprint's scanner reads
    // harness/plans/search state and captures findings via improvements:capture
    // (coord:write) into the self-improvement backlog.
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'scanner');
    expect(caps.has('coord:write')).toBe(true); // improvements:capture
    expect(caps.has('harness:read')).toBe(true);
    expect(caps.has('plans:read')).toBe(true);
    expect(caps.has('search:read')).toBe(true);
  });

  test(
    'release-fixer can use every direct platform seam its runbook requires',
    { timeout: 60_000 },
    async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'release-fixer');
      for (const capability of [
        'coord:read',
        'coord:write',
        'docs:read',
        'work_items:read',
        'work_items:write',
        'harness:read',
        'locks:read',
        'locks:write',
        'intel:read',
        'operator:write',
        'testing:run',
      ]) {
        expect(caps.has(capability), `release-fixer missing ${capability}`).toBe(true);
      }

      const [
        { COORD_ROLES },
        { default: stateRead },
        { default: acquireLock },
        { default: checkpointRun },
        { default: releaseTrace },
        { default: docsOutline },
        { default: docsGet },
        { default: harnessEscalation },
        { default: repairQueue },
        { default: processesList },
      ] = await Promise.all([
        import('../../../agent-tools/coordination/roles.js'),
        import('../../../agent-tools/state/read.js'),
        import('../../../agent-tools/locks/acquire.js'),
        import('../../../agent-tools/release/checkpoint-run.js'),
        import('../../../agent-tools/release/trace.js'),
        import('../../../agent-tools/docs/outline.js'),
        import('../../../agent-tools/docs/get.js'),
        import('../../../agent-tools/harness/escalation.js'),
        import('../../../agent-tools/release/repair-queue.js'),
        import('../../../agent-tools/processes/list.js'),
      ]);
      expect(COORD_ROLES).toContain('release-fixer');
      for (const tool of [
        stateRead,
        acquireLock,
        checkpointRun,
        releaseTrace,
        docsOutline,
        docsGet,
        harnessEscalation,
        repairQueue,
        processesList,
      ]) {
        expect(tool.agentRoles).toContain('release-fixer');
      }
    },
  );

  test(
    'content-fixer can use its narrow coordination/work-item workflow (both dispatch gates)',
    { timeout: 60_000 },
    async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'content-fixer');
      for (const capability of ['coord:read', 'coord:write', 'work_items:read', 'work_items:write']) {
        expect(caps.has(capability), `content-fixer missing ${capability}`).toBe(true);
      }
      for (const capability of [
        'docs:read',
        'harness:read',
        'locks:read',
        'locks:write',
        'plans:read',
        'plans:write',
        'operator:write',
        'testing:run',
        'capability:fs-write',
        'capability:bash',
      ]) {
        expect(caps.has(capability), `content-fixer must not receive ${capability}`).toBe(false);
      }

      const [
        { COORD_ROLES },
        { default: orient },
        { default: createWorkItem },
        { default: checkpoint },
        { default: complete },
        { default: escalate },
      ] = await Promise.all([
        import('../../../agent-tools/coordination/roles.js'),
        import('../../../agent-tools/coordination/tools/orient.js'),
        import('../../../agent-tools/work_items/create.js'),
        import('../../../agent-tools/work_items/checkpoint.js'),
        import('../../../agent-tools/work_items/complete.js'),
        import('../../../agent-tools/coordination/tools/escalate.js'),
      ]);
      expect(COORD_ROLES).toContain('content-fixer');
      for (const [name, tool] of [
        ['coord:orient', orient],
        ['work_items:create', createWorkItem],
        ['work_items:checkpoint', checkpoint],
        ['work_items:complete', complete],
        ['coord:escalate', escalate],
      ] as const) {
        expect(tool.agentRoles, `${name} must admit content-fixer`).toContain('content-fixer');
      }
    },
  );

  test(
    'merge-resolver can use its documented native conflict tools and report findings (both dispatch gates)',
    { timeout: 60_000 },
    async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'merge-resolver');
      for (const capability of [
        'coord:read',
        'coord:write',
        'work_items:read',
        'work_items:write',
        'features:read',
        'locks:read',
        'locks:write',
      ]) {
        expect(caps.has(capability), `merge-resolver missing ${capability}`).toBe(true);
      }
      for (const capability of [
        'features:write',
        'plans:write',
        'operator:write',
        'testing:run',
        'capability:fs-write',
        'capability:bash',
      ]) {
        expect(caps.has(capability), `merge-resolver must not receive ${capability}`).toBe(false);
      }

      const [
        { COORD_ROLES },
        { default: acquireResource },
        { default: releaseResource },
        { default: locksList },
        { default: workItemGet },
        { default: workItemCreate },
        { default: capture },
        { default: featureGet },
        { default: presence },
        { default: ask },
        { default: send },
        { default: awaitInbox },
        { default: escalate },
      ] = await Promise.all([
        import('../../../agent-tools/coordination/roles.js'),
        import('../../../agent-tools/locks/acquire_resource.js'),
        import('../../../agent-tools/locks/release_resource.js'),
        import('../../../agent-tools/locks/list.js'),
        import('../../../agent-tools/work_items/get.js'),
        import('../../../agent-tools/work_items/create.js'),
        import('../../../agent-tools/improvements/capture.js'),
        import('../../../../../agent-mcp/src/tools/features/get.js'),
        import('../../../agent-tools/coordination/tools/presence.js'),
        import('../../../agent-tools/coordination/tools/ask.js'),
        import('../../../agent-tools/coordination/tools/send.js'),
        import('../../../agent-tools/coordination/tools/await-inbox.js'),
        import('../../../agent-tools/coordination/tools/escalate.js'),
      ]);
      expect(COORD_ROLES).toContain('merge-resolver');
      for (const [name, tool] of [
        ['locks:acquire_resource', acquireResource],
        ['locks:release_resource', releaseResource],
        ['locks:list', locksList],
        ['work_items:get', workItemGet],
        ['work_items:create', workItemCreate],
        ['improvements:capture', capture],
        ['coord:presence', presence],
        ['coord:send', send],
        ['coord:await-inbox', awaitInbox],
        ['coord:escalate', escalate],
      ] as const) {
        expect(tool.agentRoles, `${name} must admit merge-resolver`).toContain('merge-resolver');
      }
      // coord:ask is deliberately owner-UI-only; agents use coord:send instead.
      expect(ask.agentRoles).toEqual([]);
      // features:get is a package-side tool with no per-role agentRoles field;
      // its declared capability is the dispatch gate for this role.
      expect(featureGet.capability).toBe('features:read');
      expect(caps.has(featureGet.capability)).toBe(true);
    },
  );

  test(
    'judge can read rubric docs and use read-only SQL/LSP evidence fallbacks without write access',
    { timeout: 60_000 },
    async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'judge');
      const [
        { default: docsGet },
        { default: getTemplateData },
        { default: reportsGet },
        { default: pgQuery },
        { default: pgMutate },
        { default: lspQuery },
        { default: lspApply },
      ] = await Promise.all([
        import('../../../agent-tools/docs/get'),
        import('../../../agent-tools/plans/get-template-data'),
        import('../../../agent-tools/reports/get'),
        import('../../../agent-tools/dev/pg_query'),
        import('../../../agent-tools/dev/pg_mutate'),
        import('../../../agent-tools/lsp/query'),
        import('../../../agent-tools/lsp/apply'),
      ]);
      // Gate 1: the tool's role allowlist. Gate 2: the principal capability it requires.
      expect(docsGet.agentRoles).toContain('judge');
      expect(docsGet.capability).toBe('docs:read');
      expect(caps.has(docsGet.capability as string)).toBe(true);
      expect(getTemplateData.agentRoles).toContain('judge');
      expect(getTemplateData.capability).toBe('plans:read');
      expect(caps.has(getTemplateData.capability as string)).toBe(true);
      expect(reportsGet.agentRoles).toContain('judge');
      expect(reportsGet.capability).toBe('reports:read');
      expect(caps.has('reports:read')).toBe(true);
      expect(caps.has('reports:write')).toBe(false);
      // Public evidence reads can be independently reproduced through the
      // read-only SQL/compiler surfaces when their projections omit fields.
      expect(pgQuery.agentRoles).toContain('judge');
      expect(pgQuery.capability).toBe('intel:read');
      expect(lspQuery.agentRoles).toContain('judge');
      expect(lspQuery.capability).toBe('intel:read');
      expect(caps.has('intel:read')).toBe(true);

      // The evidence fallback remains read-only: the SQL and LSP writers need
      // intel:write, which the judge principal does not receive.
      expect(pgMutate.capability).toBe('intel:write');
      expect(lspApply.capability).toBe('intel:write');
      expect(caps.has('intel:write')).toBe(false);
      expect(caps.has('docs:write')).toBe(false);
    },
  );

  test(
    'judge can emit, verify, persist lifecycle evidence, and capture defects without gaining implementation powers',
    { timeout: 60_000 },
    async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'judge');
      expect(caps.has('coord:read')).toBe(true);
      expect(caps.has('coord:write')).toBe(true);
      expect(caps.has('work_items:read')).toBe(true);
      expect(caps.has('operator:read')).toBe(true);
      expect(caps.has('plans:read')).toBe(true);
      expect(caps.has('testing:run')).toBe(true);
      expect(caps.has('operator:write')).toBe(false);
      expect(caps.has('work_items:write')).toBe(true);
      expect(caps.has('capability:fs-read')).toBe(true);
      expect(caps.has('capability:git-evidence:read')).toBe(true);
      expect(caps.has('capability:git')).toBe(false);
      expect(caps.has('memory:search:read')).toBe(true);
      expect(caps.has('memory:read')).toBe(false);
      expect(caps.has('sessions:read')).toBe(true);
      expect(caps.has('search:read')).toBe(false);
      expect(caps.has('capability:fs-write')).toBe(false);
      expect(caps.has('capability:bash')).toBe(false);

      const [
        { COORD_REPLY_ROLES, COORD_ROLES, WORK_ITEM_LIFECYCLE_ROLES },
        { default: send },
        { default: ack },
        { default: emit },
        { default: run },
        { default: read },
        { default: capture },
        { default: getRubric },
        { default: listScorecards },
        { default: listTestRuns },
        { default: getPlan },
        { default: evaluateSpecTestAdequacy },
        { default: getWorkItems },
        { default: listWorkItems },
        { default: comment },
        { default: checkpoint },
        { default: complete },
        { default: release },
        { default: createWorkItem },
        { default: setState },
      ] = await Promise.all([
        import('../../../agent-tools/coordination/roles.js'),
        import('../../../agent-tools/coordination/tools/send.js'),
        import('../../../agent-tools/coordination/tools/ack.js'),
        import('../../../agent-tools/scorecards/emit.js'),
        import('../../../agent-tools/testing/run.js'),
        import('../../../agent-tools/capability/read.js'),
        import('../../../agent-tools/improvements/capture.js'),
        import('../../../agent-tools/rubrics/get.js'),
        import('../../../agent-tools/scorecards/list.js'),
        import('../../../agent-tools/testing/runs.js'),
        import('../../../agent-tools/plans/get.js'),
        import('../../../agent-tools/plans/evaluate-spec-test-adequacy.js'),
        import('../../../agent-tools/work_items/get.js'),
        import('../../../agent-tools/work_items/list.js'),
        import('../../../agent-tools/work_items/comment.js'),
        import('../../../agent-tools/work_items/checkpoint.js'),
        import('../../../agent-tools/work_items/complete.js'),
        import('../../../agent-tools/work_items/release.js'),
        import('../../../agent-tools/work_items/create.js'),
        import('../../../agent-tools/work_items/set_state.js'),
      ]);
      for (const tool of [
        emit,
        run,
        read,
        capture,
        getRubric,
        listScorecards,
        listTestRuns,
        getPlan,
        evaluateSpecTestAdequacy,
        getWorkItems,
        listWorkItems,
        comment,
        checkpoint,
        complete,
        release,
      ]) {
        expect(tool.agentRoles).toContain('judge');
      }
      expect(send.agentRoles).toContain('judge');
      expect(ack.agentRoles).toContain('judge');
      for (const [name, tool] of [
        ['work_items:create', createWorkItem],
        ['work_items:set_state', setState],
      ] as const) {
        expect(tool.agentRoles, `${name} must stay outside judge's lifecycle lane`).not.toContain('judge');
      }
      expect(WORK_ITEM_LIFECYCLE_ROLES).toContain('judge');
      expect(COORD_REPLY_ROLES).toContain('judge');
      expect(COORD_ROLES).not.toContain('judge');
    },
  );

  // ── bee — the generic fleet IMPLEMENTER (OWNER-PRIORITY fs-write/bash fix, 2026-06-15) ──
  describe('bee — the IMPLEMENTER surface (can write code + run bash)', () => {
    test('bee gets capability:fs-write + capability:bash so it can LAND a fix, not just diagnose', async () => {
      // The EI-524 read-only confinement was lifted at the ENVELOPE layer; this pins
      // the matching capability GRANT (the two-gate fix) so a future re-confinement is
      // a DELIBERATE test change, never a silent regression that re-strands the fleet.
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'cup');
      expect(caps.has('capability:fs-write')).toBe(true); // capability:write + capability:edit
      expect(caps.has('capability:bash')).toBe(true); // capability:bash + :bash_output + :bash_kill
      // ...alongside the engineering surface it already had (parity with psu).
      expect(caps.has('work_items:write')).toBe(true);
      expect(caps.has('plans:write')).toBe(true);
      expect(caps.has('harness:write')).toBe(true);
    });
  });

  // ── sentinel — the fleet watcher (unify-launch-mechanics-2026-06-09 D-004) ──
  describe('sentinel — the read-mostly fleet watcher surface', () => {
    test("sentinel's WATCH+ALARM contract is reachable: read caps + coord:write, AND fleet:assignments allowlists it", async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'papercup');
      // Reads it sweeps with.
      expect(caps.has('coord:read')).toBe(true);
      expect(caps.has('harness:read')).toBe(true);
      expect(caps.has('work_items:read')).toBe(true);
      expect(caps.has('activity:read')).toBe(true);
      expect(caps.has('search:read')).toBe(true);
      // The alarm channel: coord:write (coord:escalate/send).
      expect(caps.has('coord:write')).toBe(true);
      // The two-gate other half — the watcher tools must allowlist sentinel, else
      // the read caps are INERT (the bee/scanner lesson).
      const { default: assignments } = await import('../../../agent-tools/fleet/assignments.js');
      expect(assignments.agentRoles).toContain('papercup');
      const { default: health } = await import('../../../agent-tools/harness/health.js');
      expect(health.agentRoles).toContain('papercup');
    });

    // ── Sentinel-as-Herald: the watcher is re-homed onto the always-on, voice-first
    // Herald. It gains a USER-FACING surface (converse + voice + file-a-work_item +
    // nudge), but the hard boundary holds: it suggests + files + hands off; the
    // QUEEN places/executes. ──
    test("Herald CONVERSE contract is reachable: operator:converse cap AND the converse tool allowlists sentinel", async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'papercup');
      // The brain runs with role='papercup' (the operator-converse route resolves
      // `${role}:converse`); the cap + the allowlist are the two gates.
      expect(caps.has('operator:converse')).toBe(true);
      const { default: converse } = await import('../../../agent-tools/operator/converse.js');
      expect(converse.agentRoles).toContain('papercup');
      expect(converse.agentRoles).toContain('operator'); // unchanged for the operator
    });

    test('Herald VOICE contract is reachable: operator:read/write caps AND the voice:* tools allowlist sentinel', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'papercup');
      expect(caps.has('operator:read')).toBe(true); // voice:status / voice:transcript
      expect(caps.has('operator:write')).toBe(true); // voice:join / leave / channels / agent
      const { default: join } = await import('../../../agent-tools/voice/join.js');
      expect(join.agentRoles).toContain('papercup');
      const { default: status } = await import('../../../agent-tools/voice/status.js');
      expect(status.agentRoles).toContain('papercup');
    });

    test('Herald can FILE the user’s ask: work_items:write cap AND work_items:create/set_priority admit sentinel (via COORD_ROLES)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'papercup');
      expect(caps.has('work_items:write')).toBe(true);
      const { default: create } = await import('../../../agent-tools/work_items/create.js');
      expect(create.agentRoles).toContain('papercup');
      const { default: setPriority } = await import('../../../agent-tools/work_items/set_priority.js');
      expect(setPriority.agentRoles).toContain('papercup');
    });

    test('Herald can NUDGE the Queen: coord:write cap AND coord:send/escalate admit sentinel (via COORD_ROLES)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'papercup');
      expect(caps.has('coord:write')).toBe(true);
      const { default: send } = await import('../../../agent-tools/coordination/tools/send.js');
      expect(send.agentRoles).toContain('papercup');
      const { default: escalate } = await import('../../../agent-tools/coordination/tools/escalate.js');
      expect(escalate.agentRoles).toContain('papercup');
    });

    test('Herald reads the live blackboard it narrates: curation:read + plans:read caps (+ plans:attention allowlists it)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'papercup');
      expect(caps.has('curation:read')).toBe(true); // curation:feed / state-of-pot / change-feed (capability-only, no allowlist)
      expect(caps.has('plans:read')).toBe(true);
      const { default: attention } = await import('../../../agent-tools/plans/attention.js');
      expect(attention.agentRoles).toContain('papercup');
    });

    test('sentinel still NEVER places/executes: no set_state / harness / plan / routine WRITE caps (suggest + hand off, do not act)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'papercup');
      // It CAN file work_items (work_items:write → create/set_priority) but the
      // PLACEMENT verbs stay the Queen's: it gets no harness/plan/routine write.
      expect(caps.has('harness:write')).toBe(false);
      expect(caps.has('plans:write')).toBe(false);
      expect(caps.has('routines:write')).toBe(false);
    });

    test('sentinel CANNOT execute: DENIED fs-write/bash at the envelope', async () => {
      // (This test also asserted the sentinel was carved OUT of `cup:spawn`'s
      // agentRoles until P-059 retired that verb. Narrowed, not deleted — the
      // envelope belt below is the half that survives the tool. The carve-out
      // it pinned is now structural: there is no cup:* verb to be carved out of.)
      // The envelope belt: even a tool asking for fs-write/bash is refused.
      const { evaluateCapabilityEnvelope } = await import('../../../capability-envelope/policy.js');
      const prev = process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
      process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = 'off';
      try {
        expect(
          evaluateCapabilityEnvelope({
            toolName: 'capability:write',
            capabilities: ['capability:fs-write'],
            ctx: { role: 'papercup' },
          }).withinEnvelope,
        ).toBe(false);
        expect(
          evaluateCapabilityEnvelope({
            toolName: 'capability:bash',
            capabilities: ['capability:bash'],
            ctx: { role: 'papercup' },
          }).withinEnvelope,
        ).toBe(false);
      } finally {
        if (prev === undefined) delete process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES;
        else process.env.PAPERCUSP_TESTING_FULL_ACCESS_ROLES = prev;
      }
    });
  });

  // ── overwatch — the autonomous system-health supervisor (overwatch-role-2026-06-15 C-2 / B-01) ──
  describe('overwatch — the read-everything + nudge/observe/escalate surface', () => {
    test("overwatch's WATCH+NUDGE contract is reachable: broad read caps + coord:write, AND the watcher tools allowlist it", async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'kettle');
      // The broad read surface it senses the whole system with.
      for (const c of [
        'coord:read',
        'harness:read',
        'work_items:read',
        'intel:read',
        'plans:read',
        'notifications:read',
        'activity:read',
        'search:read',
      ]) {
        expect(caps.has(c), `overwatch missing read cap ${c}`).toBe(true);
      }
      // The nudge/observe/escalate channel + the directed-message channel.
      expect(caps.has('coord:write')).toBe(true); // coord:send / coord:escalate / improvements:capture
      expect(caps.has('messages:write')).toBe(true); // messages:send
      // The two-gate other half — the read+nudge tools must allowlist overwatch, else the
      // caps are INERT (the bee/scanner/sentinel lesson). One representative per gate kind:
      const { default: potStatus } = await import('../../../agent-tools/pot/status.js');
      expect(potStatus.agentRoles).toContain('kettle'); // via COORD_ROLES
      const { default: governor } = await import('../../../agent-tools/dev/rate_governor_status.js');
      expect(governor.agentRoles).toContain('kettle'); // explicit allowlist
      const { default: notifications } = await import('../../../agent-tools/operator/notifications_recent.js');
      expect(notifications.agentRoles).toContain('kettle'); // [...SU_ROLES, 'kettle']
      const { default: capture } = await import('../../../agent-tools/improvements/capture.js');
      expect(capture.agentRoles).toContain('kettle'); // via COORD_ROLES — observations land
    });

    test('overwatch is READ + NUDGE only: no work/harness/plan/routine WRITE caps (nudge the Queen, never re-place — D-001)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'kettle');
      expect(caps.has('work_items:write')).toBe(false);
      expect(caps.has('harness:write')).toBe(false);
      expect(caps.has('plans:write')).toBe(false);
      expect(caps.has('routines:write')).toBe(false);
    });

    test('overwatch is carved OUT of optimization (gym:judge — D-002)', async () => {
      // (The placement half — `cup:spawn`.agentRoles excludes 'kettle' — retired
      // with the verb in P-059. Narrowed, not deleted: gym:judge exercises the
      // same carve-out property on a live tool.)
      const { default: judge } = await import('../../../agent-tools/gym/judge.js');
      expect(judge.agentRoles).not.toContain('kettle'); // not a gym evaluator (gates on harness:read it holds)
    });
  });

  test('a cutover pipeline role gets discovery + only the capability replacements beyond its provisioned row', async () => {
    // Pre-change this was the empty set. `agent_tools:list` is declared
    // ALL_ROLES + requirePrincipal:false and every pipeline-role persona instructs
    // calling `agent_tools:list { asRole }` as its runtime fallback playbook — so
    // every role-scoped caller gets the read-only `agent_tools:read` introspection
    // cap. B-18 additionally strips native tools from worker and substitutes
    // five capability:* tools, so its signed principal gets exactly those five
    // grants. The least-privilege intent is preserved for everything else: a
    // bare pipeline role still gets NO workflow caps (no coord/work_items/harness/…).
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'worker');
    expect(caps.has('agent_tools:read')).toBe(true);
    expect(caps.has('coord:write')).toBe(false);
    expect(caps.has('work_items:write')).toBe(false);
    expect(caps.has('harness:write')).toBe(false);
    expect(caps).toEqual(new Set(['agent_tools:read', ...CAPABILITY_REPLACEMENT_PRINCIPAL_CAPS]));
  });

  test('reviewer can run grading-integrity audits and claim adequacy-gate work without gaining plan writes', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'reviewer');
    for (const capability of ['coord:read', 'coord:write', 'work_items:read', 'work_items:write', 'plans:read']) {
      expect(caps.has(capability), `reviewer missing ${capability}`).toBe(true);
    }
    expect(caps.has('plans:write')).toBe(false);
    expect(caps.has('harness:write')).toBe(false);
    expect(caps.has('agent_tools:read')).toBe(true);
    for (const capability of CAPABILITY_REPLACEMENT_PRINCIPAL_CAPS) {
      expect(caps.has(capability), `reviewer missing ${capability}`).toBe(true);
    }

    const [coordinationRoles, scorecardGet, rubricGet, factsList, declareIntent, capture] = await Promise.all([
      import('../../../agent-tools/coordination/roles.js'),
      import('../../../agent-tools/scorecards/get.js'),
      import('../../../agent-tools/rubrics/get.js'),
      import('../../../agent-tools/facts/list.js'),
      import('../../../agent-tools/coordination/tools/declare-intent.js'),
      import('../../../agent-tools/improvements/capture.js'),
    ]);
    expect(coordinationRoles.COORD_ROLES).toContain('reviewer');
    expect(scorecardGet.default.agentRoles, scorecardGet.default.name).toContain('reviewer');
    expect(rubricGet.default.agentRoles, rubricGet.default.name).toContain('reviewer');
    expect(factsList.default.agentRoles, factsList.default.name).toContain('reviewer');
    expect(declareIntent.default.agentRoles, declareIntent.default.name).toContain('reviewer');
    expect(capture.default.agentRoles, capture.default.name).toContain('reviewer');
  });

  test('operator: a provisioned row is unioned with the hive-decider baseline', async () => {
    // autoloop-pot-operator-rebuild-2026-06-05 P-004: operator became a
    // blueprint-declared role (the pot's decider), so a STALE provisioned row
    // (pre-P-004 caps) still gets the superpower/survey baseline unioned in.
    const caps = await loadRoleCapabilities(
      fakeTx([{ capabilities: ['messages:write', 'chat:write'] }]),
      'ws',
      'operator',
    );
    expect(caps.has('messages:write')).toBe(true); // from the row
    expect(caps.has('chat:write')).toBe(true); // from the row
    expect(caps.has('harness:write')).toBe(true); // baseline — harness:create / blueprint:extend
    expect(caps.has('coord:write')).toBe(true); // baseline — survey/coord surface
  });

  test('operator with NO row gets the full hive-decider baseline (fresh workspace, pre-provision)', async () => {
    const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'operator');
    for (const c of [
      'harness:read', // blueprint:catalog / blueprint:validate / harness:status
      'harness:write', // blueprint:extend / harness:create
      'work_items:read',
      'work_items:write',
      'curation:read',
      'activity:read',
      'coord:read',
      'coord:write',
      'plans:read',
      'routines:write', // pot:declare-wake
    ]) {
      expect(caps.has(c), `missing ${c}`).toBe(true);
    }
  });

  test('a blueprint role WITH a row gets the union of both', async () => {
    const caps = await loadRoleCapabilities(
      fakeTx([{ capabilities: ['something:read'] }]),
      'ws',
      'voter',
    );
    expect(caps.has('something:read')).toBe(true); // from the row
    expect(caps.has('coord:write')).toBe(true); // from the baseline
  });

  // bee-capability-expansion-2026-06-08 (P-002 / D-001 / D-005): the generic Hive
  // worker `cup` carries the worker ENGINEERING surface. This is the CAPABILITY half
  // of the boundary (necessary, not sufficient — the agentRoles allowlist is the
  // independent co-gate, asserted empirically in the dispatch-stack boundary test).
  describe("bee — the worker engineering cap set", () => {
    test('grants the engineering caps added by the expansion (incl. plans:write, D-005)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'cup');
      for (const c of [
        // pre-existing worker surface
        'harness:read',
        'harness:write',
        'work_items:read',
        'work_items:write',
        'coord:read',
        'coord:write',
        'plans:read',
        'docs:read',
        'search:read',
        'memory:read',
        'memory:write',
        'tasks:read',
        'tasks:write',
        // added by bee-capability-expansion
        'intel:read',
        'locks:read',
        'locks:write',
        'docs:write',
        'issues:read',
        'plans:write',
      ]) {
        expect(caps.has(c), `bee missing ${c}`).toBe(true);
      }
    });

    test('does NOT grant the Queen-only capabilities (D-002)', async () => {
      const caps = await loadRoleCapabilities(fakeTx([]), 'ws', 'cup');
      // Placement / steering / admin / judgment surfaces stay with the Queen
      // (a kind:'hive' bee). These are withheld at the CAPABILITY layer — the
      // bee never holds the cap, so the capability-check gate denies regardless
      // of any allowlist.
      for (const c of [
        'operator:converse',
        'autoloop:write',
        'routines:write',
        'curation:read',
        'processes:kill',
        'activity:report',
        'secrets:read',
        'backup:write',
        'plugins:write',
        'discovery:write',
      ]) {
        expect(caps.has(c), `bee should NOT have ${c}`).toBe(false);
      }
    });
  });
});

describe('synthesizeDispatchPrincipal — telemetry provenance', () => {
  test('verified spawn URLs produce a trusted harness principal', async () => {
    const principal = await synthesizeDispatchPrincipal(fakeTx([]), {
      workspaceId: 'ws',
      role: 'worker',
      sigVerifiedSpawn: true,
    });
    expect(principal).toMatchObject({
      kind: 'harness',
      slug: 'system:worker',
      workspaceId: 'ws',
      authMethod: 'spawn-url',
      trust: 'trusted',
    });
    expect(principal.capabilities.has('agent_tools:read')).toBe(true);
    expect(principal.capabilities.has('capability:git')).toBe(true);
  });

  test('accepted unsigned legacy spawn URLs stay explicitly unverified loopback', async () => {
    const principal = await synthesizeDispatchPrincipal(fakeTx([]), {
      workspaceId: 'ws',
      role: 'worker',
      sigVerifiedSpawn: false,
    });
    expect(principal).toMatchObject({
      kind: 'loopback',
      authMethod: 'host-loopback',
      trust: 'unverified-loopback',
    });
  });

  test('superuser and power-user dispatches produce a trusted system principal', async () => {
    const principal = await synthesizeDispatchPrincipal(fakeTx([]), {
      workspaceId: 'ws',
      role: 'operator',
      isSuperuser: true,
      sigVerifiedSpawn: false,
    });
    expect(principal).toMatchObject({
      kind: 'system',
      slug: 'system:operator',
      authMethod: 'bearer-token',
      trust: 'trusted',
    });
  });

  test('verified PI principals pass through without role-derived capability inflation', async () => {
    const authenticatedPrincipal = {
      kind: 'pi' as const,
      slug: 'pi:public-chat',
      workspaceId: 'ws',
      authMethod: 'bearer-token' as const,
      trust: 'trusted' as const,
      capabilities: new Set(['chat:write']),
    };
    const principal = await synthesizeDispatchPrincipal(fakeTx([]), {
      workspaceId: 'ws',
      role: 'papercup',
      authenticatedPrincipal,
    });
    expect(principal).toBe(authenticatedPrincipal);
    expect(principal.capabilities).toEqual(new Set(['chat:write']));
  });
});

describe('synthesizeTransportPrincipal — no-tx telemetry provenance', () => {
  test('concrete superuser transport gets a trusted system principal', () => {
    expect(
      synthesizeTransportPrincipal({ workspaceId: 'ws', role: 'operator', isSuperuser: true }),
    ).toMatchObject({
      kind: 'system',
      slug: 'system:operator',
      authMethod: 'bearer-token',
      trust: 'trusted',
    });
  });

  test('verified role transport gets a trusted harness principal', () => {
    expect(
      synthesizeTransportPrincipal({ workspaceId: 'ws', role: 'worker', sigVerifiedSpawn: true }),
    ).toMatchObject({
      kind: 'harness',
      slug: 'system:worker',
      authMethod: 'spawn-url',
      trust: 'trusted',
    });
  });

  test('unsigned legacy role transport remains explicitly unverified loopback', () => {
    expect(
      synthesizeTransportPrincipal({ workspaceId: 'ws', role: 'worker', sigVerifiedSpawn: false }),
    ).toMatchObject({
      kind: 'loopback',
      authMethod: 'host-loopback',
      trust: 'unverified-loopback',
    });
  });

  test('unscoped transport has no principal', () => {
    expect(synthesizeTransportPrincipal({ workspaceId: '*', role: 'operator', isSuperuser: true })).toBeNull();
  });

  test('verified PI transport keeps the bearer-derived principal', () => {
    const authenticatedPrincipal = {
      kind: 'pi' as const,
      slug: 'pi:public-chat',
      workspaceId: 'ws',
      authMethod: 'bearer-token' as const,
      trust: 'trusted' as const,
      capabilities: new Set(['chat:write']),
    };
    expect(synthesizeTransportPrincipal({
      workspaceId: 'ws',
      role: 'papercup',
      authenticatedPrincipal,
    })).toBe(authenticatedPrincipal);
  });
});

describe('synthesizeResourcePrincipal — transport-authenticated resources', () => {
  test('superuser keeps the result-door owner id and gets wildcard resource access', () => {
    const principal = synthesizeResourcePrincipal({
      workspaceId: 'ws',
      isSuperuser: true,
      uiClientId: 'su-session-42',
    });
    expect(principal).toMatchObject({
      kind: 'system',
      slug: 'su-session-42',
      workspaceId: 'ws',
      authMethod: 'bearer-token',
      trust: 'trusted',
    });
    expect(principal?.capabilities).toEqual(new Set(['*']));
  });

  test('client-less superuser uses the same stable fallback as coordination identity', () => {
    expect(
      synthesizeResourcePrincipal({ workspaceId: '*', isSuperuser: true }),
    ).toMatchObject({
      slug: 'su-loopback',
      workspaceId: '*',
    });
  });

  test('verified authenticated principals pass through without capability inflation', () => {
    const authenticatedPrincipal = {
      kind: 'pi' as const,
      slug: 'pi:public-chat',
      workspaceId: 'ws',
      authMethod: 'bearer-token' as const,
      trust: 'trusted' as const,
      capabilities: new Set(['chat:write']),
    };
    expect(
      synthesizeResourcePrincipal({
        workspaceId: 'ws',
        authenticatedPrincipal,
      }),
    ).toBe(authenticatedPrincipal);
  });

  test('unsigned non-superuser transport has no resource principal', () => {
    expect(synthesizeResourcePrincipal({ workspaceId: 'ws' })).toBeNull();
  });
});

describe('effectiveDispatchWorkspace — EI-30 superuser per-call workspace', () => {
  test('unscoped superuser + concrete workspace arg → dispatches under the arg workspace', () => {
    expect(
      effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, { workspace: 'papercusp-workspace' }),
    ).toBe('papercusp-workspace');
  });

  test('unscoped superuser without a workspace arg → stays "*" (built-ins still fail with the scoped error)', () => {
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, {})).toBe('*');
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, undefined)).toBe('*');
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, { workspace: '' })).toBe('*');
    expect(effectiveDispatchWorkspace({ workspaceId: '*', isSuperuser: true }, { workspace: 42 })).toBe('*');
  });

  test('session-scoped superuser keeps the SESSION workspace — the arg never overrides a concrete scope', () => {
    expect(
      effectiveDispatchWorkspace({ workspaceId: 'default', isSuperuser: true }, { workspace: 'other-ws' }),
    ).toBe('default');
  });

  test('non-superuser callers are never re-scoped by the arg', () => {
    expect(effectiveDispatchWorkspace({ workspaceId: '*' }, { workspace: 'sneaky' })).toBe('*');
    expect(
      effectiveDispatchWorkspace({ workspaceId: 'ws-1', isSuperuser: false }, { workspace: 'sneaky' }),
    ).toBe('ws-1');
  });
});
