import { describe, it, expect } from 'vitest';
import {
  parseFactRef,
  parsePlanDecisionRef,
  parsePlanItemRef,
  parseWorkItemRef,
  resolvePremiseStamps,
  failingPremises,
  type PremiseProbes,
} from './premise-resolve';

describe('parseFactRef — the three live forms', () => {
  it('parses the documented owner form with a version pin', () => {
    expect(parseFactRef('fact:owner:su-123:my-key@v7')).toEqual({
      scope: 'owner',
      scopeRef: 'su-123',
      key: 'my-key',
      version: 7,
    });
  });

  it('parses the scoped form that actually dominates the corpus', () => {
    expect(parseFactRef('fact:harness:papercusp:pot-git-rule0-confirmed-sound')).toEqual({
      scope: 'harness',
      scopeRef: 'papercusp',
      key: 'pot-git-rule0-confirmed-sound',
      version: undefined,
    });
  });

  it('parses a workspace-scoped ref without a scopeRef segment', () => {
    expect(parseFactRef('fact:workspace:gate-integration-root-is-explicit-env')).toEqual({
      scope: 'workspace',
      key: 'gate-integration-root-is-explicit-env',
      version: undefined,
    });
  });

  it('parses the bare form', () => {
    expect(parseFactRef('fact:desktop-ipc-rollback-lever-is-dead-in-webview')).toEqual({
      key: 'desktop-ipc-rollback-lever-is-dead-in-webview',
      version: undefined,
    });
  });

  // REGRESSION: a hand-rolled parse that strips only `owner:` — or that takes
  // split(':')[2] as the key — reads this real fact as dangling. Keys carry
  // their own colons (`dead-end:`, `wall:`, `guard-rail:` prefixes), so the key is everything
  // after the scope PAIR. This exact false negative was produced live while
  // measuring adoption, and reported 4 of 5 real facts as missing.
  it('keeps a colon-bearing key intact', () => {
    expect(
      parseFactRef('fact:harness:papercusp:dead-end:wi6502-mapper-is-not-the-bottleneck'),
    ).toEqual({
      scope: 'harness',
      scopeRef: 'papercusp',
      key: 'dead-end:wi6502-mapper-is-not-the-bottleneck',
      version: undefined,
    });
  });

  it('does not mistake a non-scope first segment for a scope', () => {
    // `desktop` is not a FACT_SCOPE, so this is a bare key, not scope+ref.
    expect(parseFactRef('fact:desktop:ipc:lever')).toEqual({
      key: 'desktop:ipc:lever',
      version: undefined,
    });
  });

  it('returns null for a non-fact ref', () => {
    expect(parseFactRef('msg:abc')).toBeNull();
  });
});

describe('parsePlanDecisionRef / parseWorkItemRef', () => {
  it('splits a plan decision on the LAST hash, since slugs carry dates', () => {
    expect(parsePlanDecisionRef('hud-tab-public-release-2026-07-28#D-004')).toEqual({
      slug: 'hud-tab-public-release-2026-07-28',
      decisionId: 'D-004',
    });
  });

  it('rejects a non-decision anchor', () => {
    expect(parsePlanDecisionRef('some-plan#Now')).toBeNull();
  });

  it('splits a work-item ref into id and anchor', () => {
    expect(parseWorkItemRef('WI-6502#completion')).toEqual({ id: 'WI-6502', anchor: 'completion' });
    expect(parseWorkItemRef('WI-6502#checkpoint')).toEqual({ id: 'WI-6502', anchor: 'checkpoint' });
  });

  // REGRESSION: the anchor used to be REQUIRED (`if (idx <= 0) return null`),
  // so a bare id was unparseable. Widening the classifier without this would
  // have routed every bare id straight to `unknown` — a change that looks like
  // a fix and resolves nothing.
  it('parses a bare id, with no anchor and no wi: prefix', () => {
    expect(parseWorkItemRef('WI-6560')).toEqual({ id: 'WI-6560' });
    expect(parseWorkItemRef('wi:EI-18834967602055309')).toEqual({ id: 'EI-18834967602055309' });
  });

  it('refuses a ref that merely contains a hash', () => {
    // Sound standalone: the id shape is validated here, not assumed from the
    // caller's classification arm.
    expect(parseWorkItemRef('some-plan#Now')).toBeNull();
    expect(parseWorkItemRef('no-http-anywhere-2026-07-28#P-020')).toBeNull();
  });

  it('splits a plan ITEM on the LAST hash, and rejects a decision anchor', () => {
    expect(parsePlanItemRef('no-http-anywhere-2026-07-28#P-020')).toEqual({
      slug: 'no-http-anywhere-2026-07-28',
      itemId: 'P-020',
    });
    expect(parsePlanItemRef('some-plan#D-004')).toBeNull();
  });
});

describe('resolvePremiseStamps', () => {
  it('flags a completion premise on an OPEN item as broken, not stale', async () => {
    // The WI-6502 case, observed live: a message declared it rested on a
    // completion that had never happened. The sender was wrong AT SEND TIME,
    // which is `broken` — the ground was never there, it did not move.
    const probes: PremiseProbes = {
      workItem: async (id) =>
        id === 'WI-6502' ? { exists: true, state: 'open', terminal: false } : null,
    };
    const [stamp] = await resolvePremiseStamps(['WI-6502#completion'], probes);
    expect(stamp!.status).toBe('broken');
    expect(stamp!.note).toContain('open');
    // The ref travels verbatim — verification decorates, never rewrites.
    expect(stamp!.ref).toBe('WI-6502#completion');
  });

  it('holds a completion premise on a terminal item', async () => {
    const probes: PremiseProbes = {
      workItem: async () => ({ exists: true, state: 'done', terminal: true }),
    };
    const [stamp] = await resolvePremiseStamps(['WI-6412#completion'], probes);
    expect(stamp!.status).toBe('holds');
  });

  it('reports a dangling work-item citation as unresolvable', async () => {
    const probes: PremiseProbes = { workItem: async () => ({ exists: false }) };
    const [stamp] = await resolvePremiseStamps(['WI-9999#completion'], probes);
    expect(stamp!.status).toBe('unresolvable');
  });

  it('resolves a workspace-scoped fact citation whose scopeRef is null', async () => {
    const probes: PremiseProbes = {
      fact: async (parsed) => {
        expect(parsed).toEqual({
          scope: 'workspace',
          key: 'gate-integration-root-is-explicit-env',
          version: undefined,
        });
        return { exists: true, supersededAt: null };
      },
    };
    const [stamp] = await resolvePremiseStamps(
      ['fact:workspace:gate-integration-root-is-explicit-env'],
      probes,
    );
    expect(stamp!.status).toBe('holds');
  });

  // THE GUARANTEE D-026 correction 2 actually asks for, pinned executably.
  // Widening classification is only safe while this holds: a container citation
  // must never acquire the completion assertion its sender did not make.
  it('NEVER reports a bare work-item citation as broken, however open the item', async () => {
    const probes: PremiseProbes = {
      workItem: async () => ({ exists: true, state: 'open', terminal: false }),
    };
    const stamps = await resolvePremiseStamps(
      ['WI-6560', 'wi:EI-18834967602055309', 'WI-6502#checkpoint'],
      probes,
    );
    // The SAME item, same open state, that is `broken` when cited as
    // `#completion` — the anchor is the whole difference.
    expect(stamps.map((s) => s.status)).toEqual(['holds', 'holds', 'holds']);
    expect(failingPremises(stamps)).toHaveLength(0);

    const [asCompletion] = await resolvePremiseStamps(['WI-6560#completion'], probes);
    expect(asCompletion!.status).toBe('broken');
  });

  it('catches a MISTYPED bare id — the whole yield of classifying it', async () => {
    const probes: PremiseProbes = { workItem: async (id) => ({ exists: id === 'WI-6560' }) };
    const [real, typo] = await resolvePremiseStamps(['WI-6560', 'WI-6650'], probes);
    expect(real!.status).toBe('holds');
    expect(typo!.status).toBe('unresolvable');
    expect(typo!.note).toContain('WI-6650');
    // Verification decorates, never rewrites (the inherited P-006 contract).
    expect(typo!.ref).toBe('WI-6650');
  });

  it('resolves a plan ITEM, distinguishing a missing plan from a missing item', async () => {
    const probes: PremiseProbes = {
      planItem: async (slug, id) => ({
        planExists: slug === 'no-http-anywhere-2026-07-28',
        itemExists: slug === 'no-http-anywhere-2026-07-28' && id === 'P-020',
      }),
    };
    const [ok, prefixedOk, noItem, noPlan] = await resolvePremiseStamps(
      [
        'no-http-anywhere-2026-07-28#P-020',
        'plan:no-http-anywhere-2026-07-28#P-020',
        'no-http-anywhere-2026-07-28#P-999',
        'ghost-plan#P-001',
      ],
      probes,
    );
    expect(ok!.status).toBe('holds');
    expect(prefixedOk!.status).toBe('holds');
    expect(noItem!.status).toBe('unresolvable');
    expect(noItem!.note).toContain('P-999');
    expect(noPlan!.status).toBe('unresolvable');
    expect(noPlan!.note).toContain('ghost-plan');
  });

  it('resolves a plan decision, and distinguishes a missing plan from a missing decision', async () => {
    const probes: PremiseProbes = {
      planDecision: async (slug, id) => ({
        planExists: slug === 'real-plan',
        decisionExists: slug === 'real-plan' && id === 'D-004',
      }),
    };
    const [ok, prefixedOk, noDecision, noPlan] = await resolvePremiseStamps(
      ['real-plan#D-004', 'plan:real-plan#D-004', 'real-plan#D-999', 'ghost-plan#D-001'],
      probes,
    );
    expect(ok!.status).toBe('holds');
    expect(prefixedOk!.status).toBe('holds');
    expect(noDecision!.status).toBe('unresolvable');
    expect(noDecision!.note).toContain('D-999');
    expect(noPlan!.status).toBe('unresolvable');
    expect(noPlan!.note).toContain('ghost-plan');
  });

  // This pair is the measured defect, pinned as behaviour: the version pin is
  // the ONLY thing that can make a fact premise go stale. 0 of 57 refs in the
  // corpus carried one, which is precisely why nothing has ever gone stale.
  it('marks a PINNED premise stale once its version is superseded', async () => {
    const probes: PremiseProbes = {
      fact: async () => ({ exists: true, supersededAt: '2026-07-30T00:00:00Z' }),
    };
    const [stamp] = await resolvePremiseStamps(['fact:harness:papercusp:some-key@v3'], probes);
    expect(stamp!.status).toBe('stale');
    expect(stamp!.note).toContain('superseded');
  });

  it('cannot detect staleness on an UNPINNED premise, even when superseded', async () => {
    const probes: PremiseProbes = {
      fact: async () => ({ exists: true, supersededAt: '2026-07-30T00:00:00Z' }),
    };
    const [stamp] = await resolvePremiseStamps(['fact:harness:papercusp:some-key'], probes);
    expect(stamp!.status).toBe('holds');
  });

  it('treats docs and unrecognised refs as not-checkable, never as failures', async () => {
    const [doc, opaque] = await resolvePremiseStamps([
      '/internal/docs/agent-insights/judging-claimable-work-not-status-open',
      'dev:pg_query GROUP BY kind over harness_shared.engineer_issues',
    ]);
    expect(doc!.status).toBe('not-checkable');
    expect(opaque!.status).toBe('not-checkable');
    expect(failingPremises([doc!, opaque!])).toHaveLength(0);
  });

  it('fail-softs a throwing probe to unknown rather than blocking the send', async () => {
    const probes: PremiseProbes = {
      workItem: async () => {
        throw new Error('store down');
      },
    };
    const [stamp] = await resolvePremiseStamps(['WI-1#completion'], probes);
    expect(stamp!.status).toBe('unknown');
  });

  it('yields unknown — not unresolvable — when no probe is supplied', async () => {
    // Absence of a probe must never read as a false accusation of dangling.
    const [stamp] = await resolvePremiseStamps(['WI-1#completion'], {});
    expect(stamp!.status).toBe('unknown');
  });

  it('de-dupes and caps, preserving first-appearance order', async () => {
    const probes: PremiseProbes = { workItem: async () => ({ exists: true, terminal: true }) };
    const stamps = await resolvePremiseStamps(
      ['WI-2#completion', 'WI-1#completion', 'WI-2#completion'],
      probes,
    );
    expect(stamps.map((s) => s.ref)).toEqual(['WI-2#completion', 'WI-1#completion']);
  });

  it('surfaces only genuine failures through failingPremises', async () => {
    const probes: PremiseProbes = {
      workItem: async (id) =>
        id === 'WI-6502'
          ? { exists: true, state: 'open', terminal: false }
          : { exists: true, terminal: true },
    };
    const stamps = await resolvePremiseStamps(
      ['WI-6502#completion', 'WI-6412#completion', '/internal/docs/x'],
      probes,
    );
    expect(failingPremises(stamps).map((s) => s.ref)).toEqual(['WI-6502#completion']);
  });
});
