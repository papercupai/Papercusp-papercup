/**
 * Unit tests for the inert-spec advisory (set_claim_spec.ts).
 *
 * su-loop-capability-parity-2026-07-03 P-003(b): the advisory used to warn 'INERT spec'
 * for ANY spawned role that wasn't in {bee, queen} — a FALSE-POSITIVE on every SU fleet
 * member (which, post-P-001, self-pulls via scheduler:get_next). The fix inverts the check
 * to an allowlist of the coding-FACTORY push-pipeline roles, so ONLY a genuine factory
 * push-role trips it. These assertions pin that role-awareness.
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import setClaimSpecTool, {
  claimSpecInertWarning,
  claimSpecWakeabilityWarning,
  previewClaimSpecAdmission,
  resolveClaimSpecPotSlug,
  wakeClaimableAwaitersAfterSpecChange,
} from './set_claim_spec';
import { DEFAULT_CLAIM_SPEC, type ClaimSpec } from '../../scheduler/claim-spec';
import type { ClaimFloorAttribution } from '../../work-items';

const wakeClaimableAwaitersForSubscribers = vi.hoisted(() => vi.fn());
const listFleetMembers = vi.hoisted(() => vi.fn());
const getClaimSpecRecord = vi.hoisted(() => vi.fn());
const setClaimSpec = vi.hoisted(() => vi.fn());
const previewSpecPoolEffect = vi.hoisted(() => vi.fn());
const getFleet = vi.hoisted(() => vi.fn());
const listFleetControlMembers = vi.hoisted(() => vi.fn());
const getWorkItem = vi.hoisted(() => vi.fn());
const explainIssueClaimFloors = vi.hoisted(() => vi.fn());
const getOrgPg = vi.hoisted(() => vi.fn());
const fetchWakeability = vi.hoisted(() => vi.fn());

// The helper is dynamically imported by the tool so its wake-plane dependency can
// fail soft after the durable spec write. Keep this test focused on the target
// resolution and forwarding contract without opening a real await/event store.
vi.mock('../../events/await/engine', () => ({
  wakeClaimableAwaitersForSubscribers: (...args: unknown[]) => wakeClaimableAwaitersForSubscribers(...args),
}));
vi.mock('../coordination/audience-host', () => ({
  listFleetControlMembers: (...args: unknown[]) => listFleetControlMembers(...args),
  hostAudienceResolvers: {
    listFleetMembers: (...args: unknown[]) => listFleetMembers(...args),
  },
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: (...args: unknown[]) => getOrgPg(...args),
}));
vi.mock('../coordination/presence-wakeability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/presence-wakeability')>()),
  fetchWakeability: (...args: unknown[]) => fetchWakeability(...args),
}));
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItem: (...args: unknown[]) => getWorkItem(...args),
  explainIssueClaimFloors: (...args: unknown[]) => explainIssueClaimFloors(...args),
}));
vi.mock('../../scheduler/claim-spec-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/claim-spec-store')>()),
  getClaimSpecRecord: (...args: unknown[]) => getClaimSpecRecord(...args),
  setClaimSpec: (...args: unknown[]) => setClaimSpec(...args),
}));
// WI-38283 rig: stub ONLY the two DB-backed seams the write path needs (the pool COUNT and
// the fleet-existence read). evaluateCollapseGuard / evaluateWideningDisclosure stay REAL, so
// these tests exercise the actual disclosure logic and its threading onto the tool result —
// not a re-assertion of a mock.
vi.mock('../../scheduler/spec-pool-preview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../scheduler/spec-pool-preview')>()),
  previewSpecPoolEffect: (...args: unknown[]) => previewSpecPoolEffect(...args),
}));
vi.mock('../../agent-fleets-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-fleets-store')>()),
  getFleet: (...args: unknown[]) => getFleet(...args),
}));

describe('wakeClaimableAwaitersAfterSpecChange — EI-20079462322478221', () => {
  it('forwards a direct member target and spec revision to the event engine', async () => {
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(1);

    await expect(
      wakeClaimableAwaitersAfterSpecChange({ cupId: 'su-target', specId: 'bugs-lane', revision: 7 }),
    ).resolves.toEqual({ woken: 1 });
    expect(wakeClaimableAwaitersForSubscribers).toHaveBeenCalledWith({
      subscriberIds: ['su-target'],
      specId: 'bugs-lane',
      revision: 7,
    });
  });

  it('turns an event-plane failure into an actionable warning without throwing', async () => {
    wakeClaimableAwaitersForSubscribers.mockRejectedValueOnce(new Error('await store unavailable'));

    await expect(
      wakeClaimableAwaitersAfterSpecChange({ cupId: 'su-target', specId: 'bugs-lane', revision: 8 }),
    ).resolves.toEqual({
      woken: 0,
      warning: 'claim-spec revision stored, but parked claimable awaiters could not be woken: await store unavailable',
    });
  });

  it('resolves a fleet target to its current live members before waking', async () => {
    listFleetMembers.mockResolvedValueOnce(['su-member-a', 'su-member-b']);
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(2);

    await expect(
      wakeClaimableAwaitersAfterSpecChange({
        cupId: 'fleet:nonp2p-bug-drain',
        fleet: 'nonp2p-bug-drain',
        specId: 'bugs-lane',
        revision: 9,
      }),
    ).resolves.toEqual({ woken: 2 });
    expect(listFleetMembers).toHaveBeenCalledWith('nonp2p-bug-drain');
    expect(wakeClaimableAwaitersForSubscribers).toHaveBeenCalledWith({
      subscriberIds: ['su-member-a', 'su-member-b'],
      specId: 'bugs-lane',
      revision: 9,
    });
  });
});

describe('replacement write wakes — EI-25930135591137865', () => {
  it.each([false, true])('wakes members only when the store commits: ok=%s', async (ok) => {
    getFleet.mockReset().mockResolvedValue({ slug: 'compatible-fleet' });
    getClaimSpecRecord.mockReset().mockResolvedValue(null);
    previewSpecPoolEffect.mockReset().mockResolvedValue({ matched: 20, pool: 20, states: ['open'] });
    setClaimSpec.mockReset().mockResolvedValue(ok
      ? { ok: true, errors: [], revision: 15 }
      : { ok: false, errors: ['release-operator has not attested support'] });
    listFleetMembers.mockReset().mockResolvedValue(['su-member-a', 'su-member-b']);
    wakeClaimableAwaitersForSubscribers.mockReset().mockResolvedValue(2);

    const result = await (setClaimSpecTool as any).handler({
      fleet: 'compatible-fleet', harness: 'papercusp',
      spec: { ...DEFAULT_CLAIM_SPEC, specId: 'adoption-lane', revisionAdoption: 'first' },
    }, { isSuperuser: true, uiClientId: 'su-leader', workspaceId: 'ws-test' });

    expect(setClaimSpec).toHaveBeenCalledOnce();
    expect(result.data.ok).toBe(ok);
    expect(result.data.claimableAwaitersWoken).toBe(ok ? 2 : 0);
    if (ok) {
      expect(wakeClaimableAwaitersForSubscribers).toHaveBeenCalledWith({
        subscriberIds: ['su-member-a', 'su-member-b'], specId: 'adoption-lane', revision: 15,
      });
    } else {
      expect(result.data.errors).toEqual(['release-operator has not attested support']);
      expect(listFleetMembers).not.toHaveBeenCalled();
      expect(wakeClaimableAwaitersForSubscribers).not.toHaveBeenCalled();
    }
  });
});

describe('published claim-spec guidance — WI-37997 severity ordering', () => {
  it('advertises the safe ordinal severity_rank term and a critical-first issue example', () => {
    const json = z.toJSONSchema(setClaimSpecTool.args as never) as {
      properties?: Record<string, { description?: string }>;
    };
    const description = json.properties?.spec?.description ?? '';
    expect(description).toContain('severity_rank');
    expect(description).toContain('dependency_unlock_score');
    expect(description).toContain('dependencyUnlockScore');
    expect(description).toContain('cluster_priority');
    expect(description).toContain('payload.clusterPriority');
    expect(description).toContain('never computes clustering at assignment time');
    expect(description).toContain('critical-first');
    expect(description).toContain('{ expr:"severity_rank", dir:"desc" }');
    expect(description).not.toContain('Filter on them instead');
  });
});

describe('published claim-spec args — EI-21170624598321316', () => {
  const baseSpec = {
    specVersion: '1.0',
    specId: 'schema-test',
    view: { filter: { field: 'kind', op: '=', value: 'bug' } },
    rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  };

  it('advertises revision as required instead of deferring the failure to the handler', () => {
    const missingRevision = setClaimSpecTool.args.safeParse({
      fleet: 'fleet-a',
      spec: baseSpec,
    });
    expect(missingRevision.success).toBe(false);
    if (!missingRevision.success) {
      expect(missingRevision.error.issues.some((issue) => issue.path.join('.') === 'spec.revision')).toBe(true);
    }

    const complete = setClaimSpecTool.args.safeParse({
      fleet: 'fleet-a',
      spec: { ...baseSpec, revision: 1 },
    });
    expect(complete.success).toBe(true);
  });
});

describe('scheduler:set_claim_spec appendIds', () => {
  afterEach(() => vi.clearAllMocks());

  it('accepts fleet plus appendIds without requiring claim-spec JSON', () => {
    expect(setClaimSpecTool.args.safeParse({ fleet: 'append-fleet', harness: 'papercusp', appendIds: ['WI-new'] }).success).toBe(true);
    for (const invalid of [
      { cupId: 'su-member', appendIds: ['WI-new'] },
      { fleet: 'append-fleet', appendIds: [] },
      { fleet: 'append-fleet', appendIds: [' '] },
      { fleet: 'append-fleet', appendIds: ['WI-new'], spec: DEFAULT_CLAIM_SPEC },
      { fleet: 'append-fleet', appendIds: ['WI-new'], clear: true },
    ]) expect(setClaimSpecTool.args.safeParse(invalid).success).toBe(false);
  });

  it('applies the existing admission preview to the union and wakes only after a successful append', async () => {
    vi.clearAllMocks();
    getFleet.mockResolvedValueOnce({ slug: 'append-fleet' });
    const candidate: ClaimSpec = { ...DEFAULT_CLAIM_SPEC, specId: 'append-fleet:cohort', revision: 9,
      view: { filter: { field: 'id', op: 'in', value: ['F-old', 'F-new'] } },
    };
    setClaimSpec.mockImplementationOnce(async (args) => {
      expect(args).toMatchObject({ cupId: 'fleet:append-fleet', workspaceId: 'ws-test', appendIds: ['F-new'], potSlug: 'papercusp' });
      expect(args.spec).toBeUndefined();
      const admission = await args.validateAppend(candidate, 'papercusp');
      expect(admission.errors).toEqual([]);
      return { ok: true, errors: [], revision: 9, spec: candidate };
    });
    listFleetMembers.mockResolvedValueOnce(['su-member']);
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(1);
    const result = await (setClaimSpecTool as any).handler(
      { fleet: 'append-fleet', appendIds: ['F-new'], harness: 'papercusp' },
      { isSuperuser: true, uiClientId: 'su-append', workspaceId: 'ws-test' },
    );
    expect(result.data).toMatchObject({ ok: true, revision: 9, spec: candidate, claimableAwaitersWoken: 1,
      admissibilityPreview: { mode: 'fixed-cohort', cohortIds: ['F-old', 'F-new'] },
    });
    expect(wakeClaimableAwaitersForSubscribers).toHaveBeenCalledWith({ subscriberIds: ['su-member'], specId: candidate.specId, revision: 9 });
    expect(getClaimSpecRecord).not.toHaveBeenCalled();
  });

  it('does not wake members when the append is refused', async () => {
    vi.clearAllMocks();
    getFleet.mockResolvedValueOnce({ slug: 'append-fleet' });
    setClaimSpec.mockResolvedValueOnce({ ok: false, errors: ['claim-floor refusal'] });
    const result = await (setClaimSpecTool as any).handler(
      { fleet: 'append-fleet', appendIds: ['WI-refused'], harness: 'papercusp' },
      { isSuperuser: true, uiClientId: 'su-append', workspaceId: 'ws-test' },
    );
    expect(result.data).toMatchObject({ ok: false, claimableAwaitersWoken: 0 });
    expect(wakeClaimableAwaitersForSubscribers).not.toHaveBeenCalled();
  });
});

describe('scheduler:set_claim_spec handler — EI-22389918023611568', () => {
  const incumbent = {
    source: 'cup' as const,
    spec: {
      specVersion: '1.0',
      specId: 'goal-lane',
      revision: 2,
      view: {
        filter: {
          all: [
            { field: 'goal', op: '=', value: 'goal-813959' },
            { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] },
          ],
        },
      },
      rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
    },
    revision: 2,
    updatedBy: 'su-leader',
    updatedAt: '2026-09-05T00:00:00.000Z',
    harnessSlug: 'papercusp',
  };

  it('refuses a kind-only replacement before persistence when the incumbent is goal-scoped', async () => {
    getClaimSpecRecord.mockResolvedValueOnce(incumbent);

    const result = await (setClaimSpecTool as any).handler(
      {
        cupId: 'su-target',
        spec: {
          specVersion: '1.0',
          specId: 'broad-lane',
          revision: 3,
          view: { filter: { field: 'kind', op: 'in', value: ['bug', 'change', 'task'] } },
          rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
        },
      },
      { isSuperuser: true, uiClientId: 'su-handler-test', workspaceId: 'ws-test', harnessSlug: 'papercusp' },
    );

    expect(result.data.ok).toBe(false);
    expect(result.data.errors[0]).toContain('DROPS the incumbent positive goal fence');
    expect(result.data.errors[0]).toContain('confirmGoalFenceDrop:true');
    expect(setClaimSpec).not.toHaveBeenCalled();
  });
});

describe('set_claim_spec — WI-38283 destructive-widening disclosure reaches the RESULT', () => {
  const p2pFence = { not: { field: 'title', op: 'word', value: 'p2p' } };
  const fencedIncumbent = {
    source: 'fleet' as const,
    spec: {
      specVersion: '1.0',
      specId: 'nonp2p-kinds',
      revision: 15,
      view: { filter: { all: [{ field: 'kind', op: 'in', value: ['bug', 'change'] }, p2pFence] } },
      rank: { mode: 'lexicographic' as const, terms: [{ expr: 'age', dir: 'asc' as const }] },
    },
    revision: 15,
    updatedBy: 'su-leader',
    updatedAt: '2026-09-05T00:00:00.000Z',
    harnessSlug: 'papercusp',
  };
  const ctx = { isSuperuser: true, uiClientId: 'su-widen-test', workspaceId: 'ws-test', harnessSlug: 'papercusp' };

  /** Drive one fleet-lane write; `candidate` replaces the fenced incumbent. */
  async function write(candidateFilter: unknown, counts: { candidate: number; incumbent: number }) {
    getClaimSpecRecord.mockResolvedValueOnce(fencedIncumbent);
    getFleet.mockResolvedValueOnce({ slug: 'nonp2p-drain' });
    previewSpecPoolEffect
      .mockResolvedValueOnce({ matched: counts.candidate, pool: 2060, states: ['open'], harness: 'papercusp' })
      .mockResolvedValueOnce({ matched: counts.incumbent, pool: 2060, states: ['open'], harness: 'papercusp' });
    setClaimSpec.mockResolvedValueOnce({ ok: true, revision: 16 });
    listFleetMembers.mockResolvedValueOnce([]);
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(0);

    return (await (setClaimSpecTool as any).handler(
      {
        fleet: 'nonp2p-drain',
        spec: {
          specVersion: '1.0',
          specId: 'nonp2p-kinds',
          revision: 16,
          view: { filter: candidateFilter },
          rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
        },
      },
      ctx,
    )) as { data: Record<string, any> };
  }

  it('REPRO 2026-07-26: a 31 → 1185 widening that deletes the fence STORES, and says so', async () => {
    const result = await write({ field: 'kind', op: 'in', value: ['bug', 'change'] }, { candidate: 1185, incumbent: 31 });

    // Deliberately NOT a refusal — the write lands (EI-18655873409999215: another confirm
    // flag would have been passed anyway; the recovery pointer is what actually helps).
    expect(setClaimSpec).toHaveBeenCalled();
    expect(result.data.warning).toContain('DROPS 1 exclusion predicate');
    expect(result.data.warning).toContain('title');
    expect(result.data.warning).toContain('scheduler:get_claim_spec');
    expect(result.data.warning).toContain('fleet: "nonp2p-drain"');
    // Machine-readable half, so a caller can branch instead of regex-ing prose.
    expect(result.data.admissibilityPreview.poolEffect.droppedExclusions).toHaveLength(1);
    expect(result.data.admissibilityPreview.poolEffect.widened).toBe(true);
  });

  it('a widening that KEEPS the fence stores silently (no cry-wolf on the result)', async () => {
    const result = await write(
      { all: [{ field: 'kind', op: 'in', value: ['bug', 'change', 'task'] }, p2pFence] },
      { candidate: 900, incumbent: 31 },
    );

    expect(setClaimSpec).toHaveBeenCalled();
    expect(result.data.admissibilityPreview.poolEffect.droppedExclusions).toEqual([]);
    expect(String(result.data.warning ?? '')).not.toContain('DROPS');
  });
});

describe('claimSpecInertWarning — inert-spec advisory role-awareness', () => {
  it('WARNS for coding-FACTORY push-pipeline roles (spec is genuinely inert)', () => {
    for (const role of [
      'scoper',
      'architect',
      'worker',
      'validator',
      'reviewer',
      'debugger',
      'documenter',
      'curator',
      'director',
    ]) {
      const w = claimSpecInertWarning('bee-x', role);
      expect(w, `expected a warning for factory role "${role}"`).toBeTruthy();
      expect(w).toContain(role);
      expect(w).toContain('INERT');
    }
  });

  it('does NOT warn for self-pulling hive roles (bee / queen)', () => {
    expect(claimSpecInertWarning('bee-1', 'cup')).toBeNull();
    expect(claimSpecInertWarning('queen-1', 'mug')).toBeNull();
  });

  it('does NOT warn for an su fleet member — the P-003 false-positive class', () => {
    // A fleet member launched via launch-on-plan runs as a bare su collaborator; the
    // nursery records no distinctive self-pulling role (often null or a bare role string),
    // yet post-P-001 it self-pulls via get_next. None of these may trip the advisory.
    expect(claimSpecInertWarning('su-member', null)).toBeNull();
    expect(claimSpecInertWarning('su-member', '(missing)')).toBeNull();
    expect(claimSpecInertWarning('su-member', 'su')).toBeNull();
    expect(claimSpecInertWarning('su-member', 'operator')).toBeNull();
  });

  it('does NOT warn when the spawned role is unknown/null (best-effort, never cries wolf)', () => {
    expect(claimSpecInertWarning('x', null)).toBeNull();
    expect(claimSpecInertWarning('x', '')).toBeNull();
    expect(claimSpecInertWarning('x', 'some-future-role')).toBeNull();
  });

  it('names the cupId in the warning so the operator can act on it', () => {
    const w = claimSpecInertWarning('bee-abc123', 'scoper');
    expect(w).toContain('bee-abc123');
  });
});

describe('claimSpecWakeabilityWarning — EI-6079 warm-inject-miss advisory', () => {
  it('WARNS when the bee is NOT wakeable (no live coord:inbox-wake await)', () => {
    const w = claimSpecWakeabilityWarning('bee-x', false);
    expect(w).toBeTruthy();
    expect(w).toContain('bee-x');
    expect(w).toContain('woken:0');
  });

  it('does NOT warn when the bee IS wakeable (the common/healthy case)', () => {
    expect(claimSpecWakeabilityWarning('bee-x', true)).toBeNull();
  });

  it('does NOT warn on an unknown result (a lookup failure) — never cry wolf', () => {
    expect(claimSpecWakeabilityWarning('bee-x', null)).toBeNull();
  });

  it('names the cupId so the operator can act on it', () => {
    const w = claimSpecWakeabilityWarning('bee-abc123', false);
    expect(w).toContain('bee-abc123');
  });
});

describe('resolveClaimSpecPotSlug — EI-20240600109414261 direct/tools:invoke parity', () => {
  it('uses an explicit harness for both direct and tools:invoke-style unscoped calls', () => {
    const direct = resolveClaimSpecPotSlug('papercusp', 'papercusp');
    const viaInvoke = resolveClaimSpecPotSlug('papercusp', '*');

    expect(direct).toBe('papercusp');
    expect(viaInvoke).toBe(direct);
  });

  it('falls back to a concrete ambient harness when no explicit override is supplied', () => {
    expect(resolveClaimSpecPotSlug(undefined, 'papercusp')).toBe('papercusp');
    expect(resolveClaimSpecPotSlug(undefined, '*')).toBeUndefined();
  });

  it('does not treat the wildcard sentinel as a hive scope', () => {
    expect(resolveClaimSpecPotSlug('*', 'papercusp')).toBe('papercusp');
  });
});

const fixedSpec = (ids: string[], states?: string[]): ClaimSpec => ({
  specVersion: '1.0',
  specId: 'fixed-live-wave',
  revision: 1,
  view: {
    filter: {
      all: [{ field: 'id', op: 'in', value: ids }, { not: { field: 'title', op: 'glob', value: '*p2p*' } }],
    },
  },
  rank: { mode: 'lexicographic', terms: [{ expr: 'age', dir: 'asc' }] },
  ...(states ? { states } : {}),
});

describe('previewClaimSpecAdmission — WI-4429 write-time dead-cohort prevention', () => {
  it('rejects a 0-admissible issue cohort and threads spec-carried states into the shared evaluator', async () => {
    const explain = async (_harness: string, ids: readonly string[], opts?: { states?: readonly string[] }) =>
      ids.map((id) => ({
        id,
        admissible: false,
        refusedBy: 'not-claimable-status',
        detail: `states=${opts?.states?.join(',')}`,
      }));
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-1', 'EI-2'], ['open']),
      harness: 'papercusp',
      assignee: 'su-leader',
      explain,
      resolveFamily: async () => 'issue',
    });
    expect(result.errors[0]).toContain('0 are claim-path admissible');
    expect(result.preview).toMatchObject({
      checked: true,
      cohortIds: ['WI-1', 'EI-2'],
      effectiveStates: ['open'],
      admissibleIds: [],
    });
    expect(result.preview.floored).toHaveLength(2);
  });

  it('accepts a partially-admissible cohort but returns every floored id as a warning', async () => {
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-good', 'WI-held'], ['open']),
      harness: 'papercusp',
      assignee: 'su-leader',
      explain: async () => [
        { id: 'WI-good', admissible: true, refusedBy: null, detail: null },
        { id: 'WI-held', admissible: false, refusedBy: 'claim-hold', detail: 'held' },
      ],
      resolveFamily: async () => 'issue',
    });
    expect(result.errors).toEqual([]);
    expect(result.warning).toContain('1/2');
    expect(result.warning).toContain('WI-held:claim-hold');
    expect(result.preview.admissibleIds).toEqual(['WI-good']);
  });

  it('does not misclassify a WI-prefixed feature as an issue-family not-found and false-reject it', async () => {
    const explained: string[][] = [];
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-feature', 'WI-issue'], ['open']),
      harness: 'papercusp',
      assignee: 'su-leader',
      resolveFamily: async (id) => (id === 'WI-feature' ? 'feature' : 'issue'),
      explain: async (_harness, ids) => {
        explained.push([...ids]);
        return [{ id: 'WI-issue', admissible: false, refusedBy: 'claim-hold', detail: 'held' }];
      },
    });
    expect(explained).toEqual([['WI-issue']]);
    expect(result.errors).toEqual([]);
    expect(result.preview).toMatchObject({
      checked: false,
      checkedIssueIds: ['WI-issue'],
      uncheckedFeatureIds: ['WI-feature'],
      unknownIds: [],
    });
    expect(result.warning).toContain('WI-feature');
    expect(result.warning).toContain('pull time');
  });

  it('refuses to skip a named issue preview when no harness can be resolved', async () => {
    const result = await previewClaimSpecAdmission({
      spec: fixedSpec(['WI-1']),
      assignee: 'su-leader',
      explain: async () => [],
    });
    expect(result.errors[0]).toMatch(/harness is required/);
    expect(result.preview).toMatchObject({ checked: false, mode: 'fixed-cohort' });
  });

  it('leaves dynamic/property specs to live pull-time evaluation without a false reject', async () => {
    const spec: ClaimSpec = {
      ...fixedSpec([]),
      view: { filter: { field: 'kind', op: 'in', value: ['bug'] } },
    };
    const result = await previewClaimSpecAdmission({ spec, assignee: 'su-leader' });
    expect(result.errors).toEqual([]);
    expect(result.preview).toMatchObject({ mode: 'dynamic', checked: false });
  });
});

describe('fixed-cohort scope authoring — EI-25159722494650027', () => {
  const held: ClaimFloorAttribution = {
    id: 'EI-member-held',
    admissible: false,
    refusedBy: 'already-taken',
    detail: 'already claimed by another agent',
    heldBy: 'su-member',
  };
  const eligible: ClaimFloorAttribution = {
    id: held.id,
    admissible: true,
    refusedBy: null,
    detail: null,
  };
  const args = {
    spec: fixedSpec([held.id]),
    harness: 'papercusp',
    assignee: 'su-leader',
    fleet: 'repair-fleet',
    resolveFamily: async () => 'issue' as const,
  };

  it('accepts the sole admissible same-fleet held item without calling it newly claimable', async () => {
    const resolveFleetMembers = vi.fn(async () => ['su-member']);
    const explain = vi.fn(
      async (_harness: string, _ids: readonly string[], opts?: { scopeHeldBy?: readonly string[] }) =>
        opts?.scopeHeldBy?.includes(held.heldBy!) ? [eligible] : [held],
    );
    const result = await previewClaimSpecAdmission({ ...args, resolveFleetMembers, explain });

    expect(result.errors).toEqual([]);
    expect(result.preview).toMatchObject({
      admissibleIds: [],
      scopeAdmissibleIds: [held.id],
      alreadyHeldIds: [held.id],
      floored: [],
    });
    expect(result.warning).toContain('already held');
    expect(resolveFleetMembers).toHaveBeenCalledWith('repair-fleet');
    expect(explain).toHaveBeenLastCalledWith('papercusp', [held.id], {
      assignee: 'su-member',
      states: ['open'],
      scopeHeldBy: ['su-member'],
      claimantFleetSlug: 'repair-fleet',
      claimSpecReferencesFleet: false,
      claimSpecReferencesGoal: false,
    });
  });

  it('accepts the caller-held cohort for a self-targeted cup without making it claimable', async () => {
    const selfHeld = { ...held, heldBy: 'su-self' };
    const selfEligible = { ...eligible };
    const explain = vi.fn(
      async (_harness: string, _ids: readonly string[], opts?: { scopeHeldBy?: readonly string[] }) =>
        opts?.scopeHeldBy?.includes('su-self') ? [selfEligible] : [selfHeld],
    );
    const result = await previewClaimSpecAdmission({
      ...args,
      fleet: undefined,
      cupId: 'su-self',
      assignee: 'su-self',
      explain,
    });

    expect(result.errors).toEqual([]);
    expect(result.preview).toMatchObject({
      admissibleIds: [],
      scopeAdmissibleIds: [held.id],
      alreadyHeldIds: [held.id],
      floored: [],
    });
    expect(result.warning).toContain('target cup "su-self"');
    expect(explain).toHaveBeenLastCalledWith('papercusp', [held.id], {
      assignee: 'su-self',
      states: ['open'],
      scopeHeldBy: ['su-self'],
    });
  });

  it('still refuses a self-held row when a later claim floor remains', async () => {
    const selfHeld = { ...held, heldBy: 'su-self' };
    const blocked = { ...eligible, admissible: false, refusedBy: 'claim-hold', detail: 'claim-hold' };
    const explain = vi.fn(
      async (_harness: string, _ids: readonly string[], opts?: { scopeHeldBy?: readonly string[] }) =>
        opts?.scopeHeldBy?.includes('su-self') ? [blocked] : [selfHeld],
    );
    const result = await previewClaimSpecAdmission({
      ...args,
      fleet: undefined,
      cupId: 'su-self',
      assignee: 'su-self',
      explain,
    });

    expect(result.errors[0]).toContain('claim-hold');
    expect(result.preview).toMatchObject({
      admissibleIds: [],
      scopeAdmissibleIds: [],
      alreadyHeldIds: [],
      floored: [blocked],
    });
  });

  it('does not scope another cup holder’s work to the caller', async () => {
    const explain = vi.fn(async () => [held]);
    const result = await previewClaimSpecAdmission({
      ...args,
      fleet: undefined,
      cupId: 'su-member',
      assignee: 'su-leader',
      explain,
    });

    expect(result.errors[0]).toContain('already-taken');
    expect(result.preview.scopeAdmissibleIds).toEqual([]);
    expect(result.preview.alreadyHeldIds).toEqual([]);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('does not waive a foreign-held item or infer membership from the writer', async () => {
    const explain = vi.fn(async () => [held]);
    const result = await previewClaimSpecAdmission({
      ...args,
      assignee: 'su-member',
      resolveFleetMembers: async () => ['su-other-member'],
      explain,
    });
    expect(result.errors[0]).toContain('already-taken');
    expect(result.preview.scopeAdmissibleIds).toEqual([]);
    expect(result.preview.alreadyHeldIds).toEqual([]);
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it.each(['claim-hold', 'observation-lane', 'blocked-dep', 'admission-pending'])(
    'still refuses a same-fleet held item whose next floor is %s',
    async (refusedBy) => {
      const blocked = { ...eligible, admissible: false, refusedBy, detail: refusedBy };
      const explain = vi.fn(
        async (_harness: string, _ids: readonly string[], opts?: { scopeHeldBy?: readonly string[] }) =>
          opts?.scopeHeldBy ? [blocked] : [held],
      );
      const result = await previewClaimSpecAdmission({
        ...args,
        resolveFleetMembers: async () => ['su-member'],
        explain,
      });
      expect(result.errors[0]).toContain(refusedBy);
      expect(result.preview).toMatchObject({
        admissibleIds: [],
        scopeAdmissibleIds: [],
        alreadyHeldIds: [],
        floored: [blocked],
      });
    },
  );

  it('keeps ordinary non-fleet previews on acquisition floors', async () => {
    const explain = vi.fn(async () => [held]);
    const resolveFleetMembers = vi.fn(async () => ['su-member']);
    const result = await previewClaimSpecAdmission({
      ...args,
      fleet: undefined,
      resolveFleetMembers,
      explain,
    });
    expect(result.errors[0]).toContain('already-taken');
    expect(resolveFleetMembers).not.toHaveBeenCalled();
    expect(explain).toHaveBeenCalledTimes(1);
  });

  it('reports unknown membership without authorizing the held cohort', async () => {
    const result = await previewClaimSpecAdmission({
      ...args,
      explain: async () => [held],
      resolveFleetMembers: async () => { throw new Error('roster unavailable'); },
    });
    expect(result.errors.join('\n')).toContain('roster unavailable');
    expect(result.preview).toMatchObject({
      scopeAdmissibleIds: [],
      alreadyHeldIds: [],
      floored: [held],
      previewError: expect.stringContaining('could not verify'),
    });
  });

  it('retains floored and unknown cohort controls alongside admissible member-held work', async () => {
    const unknownId = 'EI-not-found';
    const foreign = { ...held, id: 'EI-foreign', heldBy: 'su-foreign' };
    const result = await previewClaimSpecAdmission({
      ...args,
      spec: fixedSpec([held.id, foreign.id, unknownId]),
      resolveFamily: async (id) => id === unknownId ? null : 'issue',
      resolveFleetMembers: async () => ['su-member'],
      explain: async (_harness, _ids, opts) => opts?.scopeHeldBy ? [eligible] : [held, foreign],
    });
    expect(result.errors).toEqual([]);
    expect(result.preview).toMatchObject({
      admissibleIds: [],
      scopeAdmissibleIds: [held.id],
      alreadyHeldIds: [held.id],
      floored: [foreign, expect.objectContaining({ id: unknownId, refusedBy: 'not-found' })],
    });
    expect(result.warning).toContain('2/3');
    expect(result.warning).toContain('EI-foreign:already-taken');
    expect(result.warning).toContain('EI-not-found:not-found');
  });

  it('threads the validated fleet target through the handler and the control roster, not delivery preferences', async () => {
    getFleet.mockResolvedValueOnce({ slug: 'repair-fleet' });
    getClaimSpecRecord.mockResolvedValueOnce(null);
    getWorkItem.mockResolvedValueOnce({ family: 'issue' });
    listFleetControlMembers.mockResolvedValueOnce(['su-member']);
    explainIssueClaimFloors.mockResolvedValueOnce([held]).mockResolvedValueOnce([eligible]);
    setClaimSpec.mockClear();
    setClaimSpec.mockResolvedValueOnce({ ok: true, revision: 2 });
    listFleetMembers.mockResolvedValueOnce([]);
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(0);

    const result = await (setClaimSpecTool as any).handler(
      { fleet: 'repair-fleet', harness: 'papercusp', spec: args.spec },
      { isSuperuser: true, uiClientId: 'su-leader', workspaceId: 'ws-test' },
    );
    expect(result.data.ok).toBe(true);
    expect(result.data.admissibilityPreview).toMatchObject({
      admissibleIds: [],
      scopeAdmissibleIds: [held.id],
      alreadyHeldIds: [held.id],
    });
    expect(listFleetControlMembers).toHaveBeenCalledWith('repair-fleet');
    expect(setClaimSpec).toHaveBeenCalledWith(expect.objectContaining({ cupId: 'fleet:repair-fleet' }));
  });

  it('threads a self cup target through admission for the caller-held cohort', async () => {
    const selfHeld = { ...held, heldBy: 'su-leader' };
    const selfEligible = { ...eligible };
    const sql = vi.fn().mockResolvedValue([]);
    getOrgPg.mockReturnValue({ sql });
    fetchWakeability.mockResolvedValueOnce(new Map([['su-leader', { wakeable: true }]]));
    getClaimSpecRecord.mockResolvedValueOnce(null);
    getWorkItem.mockResolvedValueOnce({ family: 'issue' });
    explainIssueClaimFloors.mockResolvedValueOnce([selfHeld]).mockResolvedValueOnce([selfEligible]);
    setClaimSpec.mockClear();
    setClaimSpec.mockResolvedValueOnce({ ok: true, revision: 2 });
    listFleetMembers.mockResolvedValueOnce([]);
    wakeClaimableAwaitersForSubscribers.mockResolvedValueOnce(0);

    const result = await (setClaimSpecTool as any).handler(
      { cupId: 'su-leader', harness: 'papercusp', spec: fixedSpec([held.id]) },
      { isSuperuser: true, uiClientId: 'su-leader', workspaceId: 'ws-test' },
    );

    expect(result.data.ok).toBe(true);
    expect(result.data.admissibilityPreview).toMatchObject({
      admissibleIds: [],
      scopeAdmissibleIds: [held.id],
      alreadyHeldIds: [held.id],
    });
    expect(result.data.warning).toContain('target cup "su-leader"');
    expect(explainIssueClaimFloors).toHaveBeenLastCalledWith('papercusp', [held.id], {
      assignee: 'su-leader',
      states: ['open'],
      scopeHeldBy: ['su-leader'],
    });
    expect(setClaimSpec).toHaveBeenCalledWith(expect.objectContaining({ cupId: 'su-leader' }));
  });

  it('validates fleet existence before any held-cohort membership read or persistence', async () => {
    getFleet.mockResolvedValueOnce(null);
    listFleetControlMembers.mockClear();
    setClaimSpec.mockClear();
    const result = await (setClaimSpecTool as any).handler(
      { fleet: 'typo-fleet', harness: 'papercusp', spec: args.spec },
      { isSuperuser: true, uiClientId: 'su-leader', workspaceId: 'ws-test' },
    );
    expect(result.data.errors[0]).toContain('does not exist');
    expect(listFleetControlMembers).not.toHaveBeenCalled();
    expect(setClaimSpec).not.toHaveBeenCalled();
  });
});
