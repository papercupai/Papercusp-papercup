import { describe, expect, it, vi } from 'vitest';
import {
  addGovernancePolicyException,
  applyGovernancePolicyChange,
  chainRevision,
  decideGovernancePolicyChange,
  explainFromLoad,
  getGovernancePolicyState,
  GOVERNANCE_POLICY_CHANGE_ACTION,
  GOVERNANCE_POLICY_SYNC_QUERY,
  MAX_LAYERS_WITH_HISTORY,
  parseGovernedRequest,
  prepareGovernancePolicyChange,
  setGovernancePolicyLayer,
  simulateGovernancePolicy,
  type GovernancePolicyControlDeps,
} from './control';
import { SensitiveActionError } from './sensitive-action';
import { GovernanceAuthorityError } from './authority';
import { enforceInheritedPolicy, governedRequestOf } from './enforce';
import { simulateInheritedPolicy, type GovernedRequest, type PolicyLayer } from './inherited-policy';
import { GovernancePolicyWriteError, type ChainLoad, type StoredPolicyLayer, type UpsertLayerInput } from './store';

const NOW = new Date('2026-10-14T00:00:00Z');
const FUTURE = '2026-10-20T00:00:00Z';
const PAST = '2026-10-01T00:00:00Z';

function layer(
  layerId: string,
  level: StoredPolicyLayer['level'],
  parentLayerId: string | null,
  rules: StoredPolicyLayer['rules'],
  extra: Partial<StoredPolicyLayer> = {},
): StoredPolicyLayer {
  return {
    layerId,
    level,
    version: 1,
    rules,
    exceptions: [],
    scopeRef: level === 'workspace' ? 'ws-a' : 'acme',
    parentLayerId,
    contentHash: 'h',
    updatedBy: 'test',
    updatedAt: '2026-10-13T00:00:00Z',
    ...extra,
  };
}

const ORG = layer('org', 'organization', null, { tools: { deny: ['capability:bash'] }, models: { allow: ['claude-*'] } });
const DEPT = layer('dept-eng', 'department', 'org', {});
const WS = layer('ws-a', 'workspace', 'dept-eng', { tools: { allow: ['capability:bash', 'work_items:*'] } });
const OK: ChainLoad = { status: 'ok', chain: [ORG, DEPT, WS] };

function fakeDeps(over: Partial<GovernancePolicyControlDeps> = {}): GovernancePolicyControlDeps & {
  upserts: UpsertLayerInput[];
} {
  const upserts: UpsertLayerInput[] = [];
  const byId = new Map([ORG, DEPT, WS].map((l) => [l.layerId, l]));
  return {
    upserts,
    loadChain: async () => OK,
    listLayers: async () => [...byId.values()],
    listVersions: async () => [],
    loadLayer: async (id) => byId.get(id) ?? null,
    upsertLayer: async (input) => {
      upserts.push(input);
      const prev = byId.get(input.layerId);
      return { ...(prev ?? WS), ...input, exceptions: input.exceptions ?? [], version: (prev?.version ?? 0) + 1 } as StoredPolicyLayer;
    },
    invalidateCache: vi.fn(),
    notify: vi.fn(async () => undefined),
    now: () => NOW,
    // P-006: authority and the sensitive-action store. The default actor is authorized; tests that
    // exercise the gate override `authorize`. The action store is unused unless a test fakes it.
    authorize: vi.fn(async () => true),
    createOrganization: async (input) => {
      upserts.push(input);
      return layer(input.layerId, input.level, input.parentLayerId, input.rules, {
        exceptions: input.exceptions ?? [],
        updatedBy: input.actor,
      });
    },
    prepareAction: vi.fn(async () => {
      throw new Error('prepareAction not faked');
    }),
    decideAction: vi.fn(async () => {
      throw new Error('decideAction not faked');
    }),
    executeAction: vi.fn(async () => {
      throw new Error('executeAction not faked');
    }),
    ...over,
  };
}

describe('explainFromLoad — the pane explains exactly what the kernel enforces (P-005)', () => {
  const loads: Array<[string, ChainLoad]> = [
    ['none', { status: 'none' }],
    ['ok', OK],
    ['malformed', { status: 'malformed', reason: 'chain is not organization-rooted', chain: [WS] }],
    [
      'expired exception',
      {
        status: 'ok',
        chain: [{ ...ORG, exceptions: [{ category: 'tools', pattern: 'capability:bash', reason: 'pilot', expiresAt: PAST }] }, DEPT, WS],
      },
    ],
    [
      'active exception',
      {
        status: 'ok',
        chain: [{ ...ORG, exceptions: [{ category: 'tools', pattern: 'capability:bash', reason: 'pilot', expiresAt: FUTURE }] }, DEPT, WS],
      },
    ],
  ];
  const tools = ['capability:bash', 'work_items:list', 'plans:get'];

  for (const [label, load] of loads) {
    for (const toolName of tools) {
      it(`parity with enforceInheritedPolicy: ${label} / ${toolName}`, async () => {
        const kreq = { toolName, capabilities: [], args: {}, boundary: 'dispatch', ctx: { workspaceId: 'ws-a' } };
        const enforced = await enforceInheritedPolicy(kreq as never, { loadChain: async () => load, now: () => NOW });
        const explained = explainFromLoad('ws-a', load, governedRequestOf(kreq as never), NOW);
        expect(explained.verdict.allow).toBe(enforced === null);
        if (!explained.verdict.allow) expect(JSON.stringify(enforced)).toContain(explained.verdict.code.replace('org_policy:', ''));
      });
    }
  }

  it('names the deciding layer: a workspace allow cannot widen the org deny', () => {
    const out = explainFromLoad('ws-a', OK, { tools: ['capability:bash'] }, NOW);
    expect(out.verdict.allow).toBe(false);
    if (out.verdict.allow) return;
    expect(out.verdict.decidedBy?.layerId).toBe('org');
    expect(out.explanation).toContain('organization policy org v1 denies tools');
    expect(out.revision).toBe('org@v1>dept-eng@v1>ws-a@v1');
  });

  it('an unlisted workspace is ungoverned, not refused', () => {
    const out = explainFromLoad('ws-z', { status: 'none' }, { tools: ['capability:bash'] }, NOW);
    expect(out).toMatchObject({ governed: false, verdict: { allow: true }, revision: null });
  });
});

describe('parseGovernedRequest', () => {
  it('keeps governed categories, trims, and drops empty values', () => {
    expect(parseGovernedRequest({ tools: [' capability:bash ', ''], models: [] })).toEqual({
      ok: true,
      request: { tools: ['capability:bash'] },
    });
  });
  it('refuses an unknown category, a non-array and an empty request', () => {
    expect(parseGovernedRequest({ shells: ['bash'] })).toMatchObject({ ok: false });
    expect(parseGovernedRequest({ tools: 'capability:bash' })).toMatchObject({ ok: false });
    expect(parseGovernedRequest({ tools: ['  '] })).toMatchObject({ ok: false });
    expect(parseGovernedRequest(null)).toMatchObject({ ok: false });
  });
});

describe('simulateGovernancePolicy — preview before apply', () => {
  const bash: GovernedRequest = { tools: ['capability:bash'] };
  const list: GovernedRequest = { tools: ['work_items:list'] };

  it('a workspace layer that tries to allow an org-denied tool changes nothing and is flagged decidedByAncestor', async () => {
    const sim = await simulateGovernancePolicy(
      'ws-a',
      { layerId: 'ws-a', level: 'workspace', scopeRef: 'ws-a', parentLayerId: 'dept-eng', rules: { tools: { allow: ['*'] } } },
      [bash, list],
      fakeDeps(),
    );
    expect(sim.validation).toBeNull();
    expect(sim.affectsWorkspace).toBe(true);
    expect(sim.proposedVersion).toBe(2);
    expect(sim.cases[0]).toMatchObject({ changed: false, decidedByAncestor: true, after: { allow: false } });
    expect(sim.cases[1]).toMatchObject({ changed: false, decidedByAncestor: false, after: { allow: true } });
  });

  it('substituting a chain layer matches simulateInheritedPolicy exactly', async () => {
    const proposed = { layerId: 'org', level: 'organization' as const, scopeRef: 'acme', parentLayerId: null, rules: {} };
    const sim = await simulateGovernancePolicy('ws-a', proposed, [bash, list], fakeDeps());
    const ref = simulateInheritedPolicy(OK.status === 'ok' ? OK.chain : [], { ...proposed, version: 2, exceptions: [] } as PolicyLayer, [bash, list], NOW);
    expect(sim.cases.map((c) => [c.before.allow, c.after.allow, c.changed])).toEqual(
      ref.cases.map((c) => [c.before.allow, c.after.allow, c.changed]),
    );
    expect(sim.changedCount).toBe(1);
  });

  it("a first workspace layer for an ungoverned workspace is judged under its parent's ancestry", async () => {
    const sim = await simulateGovernancePolicy(
      'ws-new',
      { layerId: 'ws-new', level: 'workspace', scopeRef: 'ws-new', parentLayerId: 'dept-eng', rules: {} },
      [bash, list],
      fakeDeps({ loadChain: async () => ({ status: 'none' }) }),
    );
    expect(sim.affectsWorkspace).toBe(true);
    expect(sim.proposedRevision).toBe('org@v1>dept-eng@v1>ws-new@v1');
    expect(sim.cases[0]).toMatchObject({ before: { allow: true }, after: { allow: false }, changed: true, decidedByAncestor: true });
  });

  it('a layer outside the chain is reported as not affecting this workspace', async () => {
    const sim = await simulateGovernancePolicy(
      'ws-a',
      { layerId: 'dept-sales', level: 'department', scopeRef: 'acme', parentLayerId: 'org', rules: { tools: { deny: ['*'] } } },
      [list],
      fakeDeps(),
    );
    expect(sim.affectsWorkspace).toBe(false);
    expect(sim.note).toContain('not in workspace ws-a');
    expect(sim.changedCount).toBe(0);
  });

  it('reports the validation error set would refuse (an exception without expiry)', async () => {
    const sim = await simulateGovernancePolicy(
      'ws-a',
      {
        layerId: 'ws-a',
        level: 'workspace',
        scopeRef: 'ws-a',
        parentLayerId: 'dept-eng',
        rules: {},
        exceptions: [{ category: 'tools', pattern: 'x', reason: 'r' }],
      },
      [list],
      fakeDeps(),
    );
    expect(sim.validation).toMatch(/expiresAt/);
  });
});

describe('setGovernancePolicyLayer — apply with reason, versioned', () => {
  const req = {
    layerId: 'ws-a',
    level: 'workspace' as const,
    scopeRef: 'ws-a',
    parentLayerId: 'dept-eng',
    rules: { tools: { deny: ['plans:*'] } },
    reason: 'lock plans for the pilot',
    expectedVersion: 1,
  };

  it('writes actor + reason + expectedVersion, invalidates every cached chain, notifies the pane', async () => {
    const deps = fakeDeps();
    const out = await setGovernancePolicyLayer(req, 'admin:avi', deps);
    expect(out).toMatchObject({ ok: true, revision: 'ws-a@v2' });
    expect(deps.upserts[0]).toMatchObject({ actor: 'admin:avi', reason: 'lock plans for the pilot', expectedVersion: 1 });
    expect(deps.invalidateCache).toHaveBeenCalledWith();
    expect(deps.notify).toHaveBeenCalledWith(GOVERNANCE_POLICY_SYNC_QUERY);
  });

  it('refuses a blank reason before touching the store', async () => {
    const deps = fakeDeps();
    const out = await setGovernancePolicyLayer({ ...req, reason: '  ' }, 'admin:avi', deps);
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(deps.upserts).toHaveLength(0);
    expect(deps.notify).not.toHaveBeenCalled();
  });

  it('maps a store conflict to code conflict and does not invalidate', async () => {
    const deps = fakeDeps({
      upsertLayer: async () => {
        throw new GovernancePolicyWriteError('conflict', 'layer ws-a is at v3');
      },
    });
    const out = await setGovernancePolicyLayer(req, 'admin:avi', deps);
    expect(out).toEqual({ ok: false, code: 'conflict', error: 'layer ws-a is at v3' });
    expect(deps.invalidateCache).not.toHaveBeenCalled();
  });

  it('a failed notify does not fail a committed write', async () => {
    const deps = fakeDeps({ notify: async () => Promise.reject(new Error('pg down')) });
    await expect(setGovernancePolicyLayer(req, 'admin:avi', deps)).resolves.toMatchObject({ ok: true });
  });
});

describe('addGovernancePolicyException — expiring exceptions', () => {
  const exception = { category: 'tools' as const, pattern: 'capability:bash', reason: 'incident 42', expiresAt: FUTURE };

  it('appends to the stored layer as a new version, pinned to the version it read', async () => {
    const deps = fakeDeps();
    const out = await addGovernancePolicyException({ layerId: 'ws-a', exception, reason: 'incident 42' }, 'admin:avi', deps);
    expect(out).toMatchObject({ ok: true, revision: 'ws-a@v2' });
    expect(deps.upserts[0]).toMatchObject({ layerId: 'ws-a', expectedVersion: 1, exceptions: [exception], rules: WS.rules });
  });

  it('an exception on an organization layer is a sensitive change: approval-required, nothing written (P-006)', async () => {
    const deps = fakeDeps();
    const out = await addGovernancePolicyException({ layerId: 'org', exception, reason: 'incident 42' }, 'admin:avi', deps);
    expect(out).toMatchObject({ ok: false, code: 'approval-required' });
    expect(deps.upserts).toHaveLength(0);
  });

  it('refuses a stale expectedVersion and an unknown layer', async () => {
    const deps = fakeDeps();
    await expect(
      addGovernancePolicyException({ layerId: 'org', exception, reason: 'r', expectedVersion: 7 }, 'admin:avi', deps),
    ).resolves.toMatchObject({ ok: false, code: 'conflict' });
    await expect(
      addGovernancePolicyException({ layerId: 'nope', exception, reason: 'r' }, 'admin:avi', deps),
    ).resolves.toMatchObject({ ok: false, code: 'invalid' });
    expect(deps.upserts).toHaveLength(0);
  });

  it('refuses an exception without a valid absolute expiry (exceptions always expire)', async () => {
    const deps = fakeDeps();
    const out = await addGovernancePolicyException(
      { layerId: 'org', exception: { ...exception, expiresAt: 'next week' }, reason: 'r' },
      'admin:avi',
      deps,
    );
    expect(out).toMatchObject({ ok: false, code: 'invalid' });
    expect(deps.upserts).toHaveLength(0);
  });
});

describe('getGovernancePolicyState', () => {
  it('returns the chain root-first with its revision, and history chain layers first', async () => {
    const listVersions = vi.fn(async () => []);
    const extra = Array.from({ length: MAX_LAYERS_WITH_HISTORY + 2 }, (_, i) => layer(`d${i}`, 'department', 'org', {}));
    const state = await getGovernancePolicyState(
      'ws-a',
      {},
      fakeDeps({ listVersions, listLayers: async () => [...extra, WS, ORG, DEPT] }),
    );
    expect(state.load).toBe('ok');
    expect(state.chain.map((l) => l.layerId)).toEqual(['org', 'dept-eng', 'ws-a']);
    expect(state.revision).toBe('org@v1>dept-eng@v1>ws-a@v1');
    expect(listVersions).toHaveBeenCalledTimes(MAX_LAYERS_WITH_HISTORY);
    expect(Object.keys(state.versions).slice(0, 3)).toEqual(['org', 'dept-eng', 'ws-a']);
    expect(state.historyTruncated).toBe(true);
  });

  it('reports an ungoverned workspace as load none with an empty chain', async () => {
    const state = await getGovernancePolicyState('ws-z', {}, fakeDeps({ loadChain: async () => ({ status: 'none' }) }));
    expect(state).toMatchObject({ load: 'none', chain: [], revision: null, reason: null });
  });
});

describe('direct-write gate — sensitive levels and delegated scope (P-006, D-015)', () => {
  const ws = { layerId: 'ws-a', level: 'workspace' as const, scopeRef: 'ws-a', parentLayerId: 'dept-eng', rules: {}, reason: 'r' };

  it('an organization or department change returns approval-required and writes nothing', async () => {
    for (const req of [
      { layerId: 'org', level: 'organization' as const, scopeRef: 'acme', parentLayerId: null, rules: {}, reason: 'r' },
      { layerId: 'dept-eng', level: 'department' as const, scopeRef: 'eng', parentLayerId: 'org', rules: {}, reason: 'r' },
      { layerId: 'dept-new', level: 'department' as const, scopeRef: 'new', parentLayerId: 'org', rules: {}, reason: 'r' },
    ]) {
      const deps = fakeDeps();
      expect(await setGovernancePolicyLayer(req, 'admin:avi', deps)).toMatchObject({ ok: false, code: 'approval-required' });
      expect(deps.upserts).toHaveLength(0);
    }
  });

  it('a workspace write needs prepare authority over the layer and any new parent', async () => {
    const authorize = vi.fn(async (_p: string, layerId: string) => layerId === 'ws-a');
    const deps = fakeDeps({ authorize });
    expect(await setGovernancePolicyLayer(ws, 'admin:dept-a', deps)).toMatchObject({ ok: true });
    const moved = await setGovernancePolicyLayer({ ...ws, parentLayerId: 'dept-sales' }, 'admin:dept-a', fakeDeps({ authorize }));
    expect(moved).toMatchObject({
      ok: false,
      code: 'forbidden',
      refusal: {
        observed: { capability: 'prepare', scope: 'dept-sales', authority: 'not-granted' },
        liftsWhen: expect.stringContaining('required governance capability'),
        whoCanMakeItTrue: ['owner', 'host'],
      },
    });
    const denied = fakeDeps({ authorize: async () => false });
    expect(await setGovernancePolicyLayer(ws, 'admin:other', denied)).toMatchObject({
      ok: false,
      code: 'forbidden',
      refusal: { observed: { capability: 'prepare', scope: 'ws-a', authority: 'not-granted' } },
    });
    expect(denied.upserts).toHaveLength(0);
  });

  it('a brand-new organization is bootstrapped only by a human principal', async () => {
    const org = { layerId: 'org-new', level: 'organization' as const, scopeRef: 'new', parentLayerId: null, rules: {}, reason: 'r' };
    const human = fakeDeps();
    expect(await setGovernancePolicyLayer(org, 'admin:founder', human)).toMatchObject({ ok: true, revision: 'org-new@v1' });
    expect(human.upserts[0]).toMatchObject({ layerId: 'org-new', actor: 'admin:founder' });
    const agent = fakeDeps();
    expect(await setGovernancePolicyLayer(org, 'su-agent-1', agent)).toMatchObject({
      ok: false,
      code: 'forbidden',
      refusal: {
        observed: { actorKind: 'service', operation: 'organization-bootstrap' },
        liftsWhen: expect.stringContaining('required governance capability'),
        whoCanMakeItTrue: ['owner', 'host'],
      },
    });
    expect(agent.upserts).toHaveLength(0);
  });

  it('adds a lift contract when a typed authority exception maps dynamically to forbidden', async () => {
    const denied = new GovernanceAuthorityError('forbidden', 'admin:avi holds no prepare authority over ws-a');
    const deps = fakeDeps({ upsertLayer: async () => { throw denied; } });
    const out = await setGovernancePolicyLayer(ws, 'admin:avi', deps);
    expect(out).toMatchObject({
      ok: false,
      code: 'forbidden',
      refusal: {
        observed: { authorityFailure: denied.message },
        liftsWhen: expect.stringContaining('target layer'),
        whoCanMakeItTrue: ['owner', 'host'],
      },
    });
    expect(deps.upserts).toHaveLength(0);
  });
});

describe('prepareGovernancePolicyChange — simulate-before-apply is recorded (P-006)', () => {
  const change = {
    layerId: 'dept-eng',
    level: 'department' as const,
    scopeRef: 'eng',
    parentLayerId: 'org',
    rules: { tools: { deny: ['processes:kill'] } },
    workspaceId: 'ws-a',
    reason: 'lock process control',
  };

  it('records the simulated chain revision, the base version and the authority layer', async () => {
    const prepareAction = vi.fn(async (input: Parameters<GovernancePolicyControlDeps['prepareAction']>[0]) => ({ requestId: 'r1', ...input }) as never);
    const out = await prepareGovernancePolicyChange(change, 'su-agent-1', fakeDeps({ prepareAction }));
    expect(out).toMatchObject({ ok: true });
    expect(prepareAction).toHaveBeenCalledTimes(1);
    const input = prepareAction.mock.calls[0]![0];
    expect(input).toMatchObject({
      actionKind: GOVERNANCE_POLICY_CHANGE_ACTION,
      targetLayerId: 'dept-eng',
      authorityLayerId: 'dept-eng',
      baseVersion: 1,
      chainRevision: chainRevision([ORG, DEPT, WS]),
      preparedBy: 'su-agent-1',
    });
    expect(input.simulation).toMatchObject({ affectsWorkspace: true });
  });

  it('adds a lift contract to dynamically mapped governance authority failures', async () => {
    const denied = new GovernanceAuthorityError('forbidden', 'admin:avi holds no delegate authority over dept-eng');
    const out = await prepareGovernancePolicyChange(change, 'admin:avi', fakeDeps({
      prepareAction: async () => { throw denied; },
    }));
    expect(out).toMatchObject({
      ok: false,
      code: 'forbidden',
      refusal: {
        observed: { authorityFailure: denied.message },
        liftsWhen: expect.stringContaining('target layer'),
        whoCanMakeItTrue: ['owner', 'host'],
      },
    });
  });

  it('refuses a stale edit, a new organization, re-parenting and an unrelated workspace before preparing', async () => {
    const prepareAction = vi.fn();
    const deps = () => fakeDeps({ prepareAction });
    expect(await prepareGovernancePolicyChange({ ...change, expectedVersion: 4 }, 'su-agent-1', deps())).toMatchObject({ code: 'conflict' });
    expect(
      await prepareGovernancePolicyChange({ ...change, layerId: 'org-x', level: 'organization', parentLayerId: null }, 'admin:a', deps()),
    ).toMatchObject({ code: 'invalid' });
    expect(await prepareGovernancePolicyChange({ ...change, parentLayerId: 'dept-other' }, 'su-agent-1', deps())).toMatchObject({
      code: 'invalid',
    });
    const unrelated = fakeDeps({ prepareAction, loadChain: async () => ({ status: 'none' }) });
    expect(await prepareGovernancePolicyChange(change, 'su-agent-1', unrelated)).toMatchObject({ code: 'invalid' });
    expect(prepareAction).not.toHaveBeenCalled();
  });

  it('maps sensitive-action refusals to their codes on decide and apply', async () => {
    const decideAction = vi.fn(async () => {
      throw new SensitiveActionError('self-approval', 'admin:a prepared request r1');
    });
    expect(await decideGovernancePolicyChange({ requestId: 'r1', decision: 'approve', reason: 'ok' }, 'admin:a', fakeDeps({ decideAction }))).toEqual({
      ok: false,
      code: 'self-approval',
      error: 'admin:a prepared request r1',
    });
    const executeAction = vi.fn(async () => {
      throw new SensitiveActionError('replayed', 'request r1 was already executed');
    }) as unknown as GovernancePolicyControlDeps['executeAction'];
    const deps = fakeDeps({ executeAction });
    expect(await applyGovernancePolicyChange({ requestId: 'r1' }, 'su-agent-1', deps)).toMatchObject({ ok: false, code: 'replayed' });
    expect(deps.invalidateCache).not.toHaveBeenCalled();
  });
});
