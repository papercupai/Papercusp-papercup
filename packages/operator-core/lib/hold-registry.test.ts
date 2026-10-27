/**
 * The hold registry's guards (plan unified-bug-pipeline-and-honest-queue-2026-10-05 P-001 / D-026).
 *
 * The registry restates several code vocabularies, so every domain is PINNED here against the
 * vocabulary it covers. A new claim floor, blocker capability, review status or readiness writer
 * fails this file until someone decides who clears the new hold and how often to look again.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { NON_FLOOR_LABELS, STRUCTURAL_CLAIM_FLOORS, TRANSIENT_CLAIM_FLOORS } from './claim-floor-classification';
import { EXTERNAL_BLOCKER_CAPABILITIES, externalBlockerCapabilityPolicy } from './external-blockers';
import { AGENT_REVIEW_STATUSES, createImplementationReadiness } from './harness/improvements/agent-review-policy';
import { STRANDED_REVIEW_REASONS } from './harness/improvements/capture-core';
import {
  HOLD_PAYLOAD_KEYS,
  HOLD_REGISTRY,
  LEGACY_ACCEPTANCE_ADOPTION_REASON_PREFIX,
  OWNER_CAPABILITIES,
  RetiredHoldError,
  UnmappedHoldError,
  assertHoldRegistered,
  claimFloorLabels,
  classifyHolds,
  hasActiveStrictHumanAsk,
  holdDomainKeys,
  resolveHold,
  type HoldDomain,
} from './hold-registry';
import { ISSUE_FLOOR_EXPLANATIONS } from './work-items';

const LIB = path.dirname(fileURLToPath(import.meta.url));
const sorted = (xs: Iterable<string>) => [...xs].sort();

describe('hold registry: each domain is total over the code vocabulary it covers', () => {
  it('claim-floor: every oracle label (minus not-found) is registered, and nothing else is', () => {
    const oracle = Object.keys(ISSUE_FLOOR_EXPLANATIONS).filter((k) => !NON_FLOOR_LABELS.has(k));
    const floors = HOLD_REGISTRY.filter((e) => e.domain === 'claim-floor' && !e.claimantSpecific).map((e) => e.key);
    expect(sorted(floors)).toEqual(sorted(oracle));
  });

  it('claim-floor: a claimant-specific hold is the claim door refusal code, never an oracle label', () => {
    const specific = HOLD_REGISTRY.filter((e) => e.domain === 'claim-floor' && e.claimantSpecific);
    expect(specific.map((e) => e.key)).toEqual(['verification_conflict']);
    for (const e of specific) expect(Object.keys(ISSUE_FLOOR_EXPLANATIONS)).not.toContain(e.key);
    const claimDoor = readFileSync(path.join(LIB, 'agent-tools/work_items/claim.ts'), 'utf8');
    expect(claimDoor).toContain("error: 'verification_conflict'");
  });

  it('claim-floor: the derived STRUCTURAL/TRANSIENT sets reproduce the previous hand-written classification exactly', () => {
    // The literals claim-floor-classification.ts carried before D-026. A class change is a
    // deliberate decision: make it in hold-registry.ts and update this pin in the same change.
    expect(sorted(STRUCTURAL_CLAIM_FLOORS)).toEqual(
      sorted([
        'not-claimable-status', 'observation-lane', 'needs-owner-action', 'external-blocker', 'claim-hold',
        'plan-lane-reserved', 'federation-detector', 'loop-noise', 'live-gate-ops', 'already-completed',
        'cross-machine-rig', 'origin',
      ]),
    );
    expect(sorted(TRANSIENT_CLAIM_FLOORS)).toEqual(
      // EI-26988974367709614 added 'admission-hold' (TRANSIENT: the admission promoter clears it on
      // its next tick, exactly like 'admission-pending'). WI-6554700010029716 added
      // 'admission-recovery' (TRANSIENT: the promoter delivers the recovery to its target).
      sorted([
        'already-taken', 'admission-pending', 'admission-hold', 'admission-recovery', 'agent-review',
        'watchdog-recovery-window', 'blocked-dep', 'cooldown', 'stop-line',
      ]),
    );
    expect(sorted(claimFloorLabels('transient'))).not.toContain('verification_conflict');
  });

  it('blocker: every capability is registered; the clearer is the policy resolutionOwner; owner-cleared iff the policy requires the owner', () => {
    expect(sorted(holdDomainKeys('blocker'))).toEqual(sorted(EXTERNAL_BLOCKER_CAPABILITIES));
    for (const capability of EXTERNAL_BLOCKER_CAPABILITIES) {
      const policy = externalBlockerCapabilityPolicy(capability);
      const e = resolveHold('blocker', capability);
      expect(e?.clearer.ref, capability).toBe(policy.resolutionOwner);
      expect(e?.clearer.kind === 'owner', capability).toBe(policy.requiresOwnerCapability);
      expect(e?.class === 'structural', capability).toBe(policy.requiresOwnerCapability);
    }
    expect(sorted(OWNER_CAPABILITIES)).toEqual(
      sorted(EXTERNAL_BLOCKER_CAPABILITIES.filter((c) => externalBlockerCapabilityPolicy(c).requiresOwnerCapability)),
    );
  });

  it('review: every non-approved agentReview status is registered', () => {
    expect(sorted(holdDomainKeys('review'))).toEqual(sorted(AGENT_REVIEW_STATUSES.filter((s) => s !== 'approved')));
  });

  it('ANTI-VACUITY: every domain is populated and every entry names a clearer and a positive re-check time', () => {
    const domains: HoldDomain[] = ['claim-floor', 'readiness', 'blocker', 'review', 'park', 'needs-human'];
    for (const d of domains) expect(holdDomainKeys(d).length, d).toBeGreaterThan(0);
    for (const e of HOLD_REGISTRY) {
      expect(e.clearer.ref.trim().length, `${e.domain}:${e.key}`).toBeGreaterThan(0);
      expect(e.recheckSec, `${e.domain}:${e.key}`).toBeGreaterThan(0);
    }
  });
});

describe('hold registry: unregistered holds are refused at the write', () => {
  it('assertHoldRegistered throws UnmappedHoldError for an unknown key and returns the entry otherwise', () => {
    expect(() => assertHoldRegistered('readiness', 'made-up-reason')).toThrow(UnmappedHoldError);
    try {
      assertHoldRegistered('blocker', 'telepathy');
    } catch (err) {
      expect((err as UnmappedHoldError).code).toBe('unmapped_hold');
      expect((err as Error).message).toContain('hold-registry.ts');
    }
    expect(assertHoldRegistered('readiness', 'awaiting-agent-review').clearer.kind).toBe('lane');
  });

  it('createImplementationReadiness refuses a non-ready verdict with an unregistered reason', () => {
    for (const status of ['unknown', 'not-ready'] as const) {
      expect(() => createImplementationReadiness({ status, source: 'agent-review', reason: 'awaiting-review' })).toThrow(
        UnmappedHoldError,
      );
    }
  });

  it('createImplementationReadiness accepts a registered non-ready reason, and any reason on a ready verdict', () => {
    expect(
      createImplementationReadiness({ status: 'unknown', source: 'creation-enrollment', reason: 'no-acceptance-evidence-at-creation' }).reason,
    ).toBe('no-acceptance-evidence-at-creation');
    expect(createImplementationReadiness({ status: 'ready', source: 'capture-policy', reason: 'immediate capture' }).status).toBe('ready');
  });

  // P-008 / D-038: a retired reason is refused at the write but still RESOLVES. A deployed build
  // that predates the retirement keeps stamping it until it ships, and a row already carrying it
  // must keep naming a clearer — deleting the entry would make the census report it as a hold
  // nobody ends (AUTO-BAR-R-4's falsifier) while the sweep is in fact clearing it.
  it('a retired reason still resolves to its clearer but is refused at the write', () => {
    const retired = HOLD_REGISTRY.filter((e) => e.retired);
    expect(retired.map((e) => e.key)).toEqual(
      expect.arrayContaining(['corroborated-tool-failure-awaiting-review', 'deployment-freshness-unknown']),
    );
    for (const e of retired) {
      expect(resolveHold(e.domain, e.key)?.clearer.kind, e.key).toBe(e.clearer.kind);
      expect(() => assertHoldRegistered(e.domain, e.key), e.key).toThrow(RetiredHoldError);
      try {
        assertHoldRegistered(e.domain, e.key);
      } catch (err) {
        expect((err as RetiredHoldError).code).toBe('retired_hold');
        expect((err as RetiredHoldError).retiredBy).toBe(e.retired?.by);
      }
      if (e.domain === 'readiness') {
        expect(() => createImplementationReadiness({ status: 'unknown', source: 'capture-policy', reason: e.key }), e.key).toThrow(
          RetiredHoldError,
        );
      }
    }
  });

  it('every retired readiness reason the stranded sweep clears is one the sweep actually selects', () => {
    const sweptRetired = HOLD_REGISTRY.filter(
      (e) => e.retired && e.domain === 'readiness' && e.clearer.ref.startsWith('stranded-tool-failure-sweep'),
    );
    expect(sweptRetired.length).toBeGreaterThan(0);
    for (const e of sweptRetired) expect(STRANDED_REVIEW_REASONS, e.key).toContain(e.key);
  });

  it('a prefix entry matches only its stem followed by a space', () => {
    const p = LEGACY_ACCEPTANCE_ADOPTION_REASON_PREFIX;
    expect(resolveHold('readiness', p)?.match).toBe('prefix');
    expect(resolveHold('readiness', `${p} cohort k1 run r1`)?.key).toBe(p);
    expect(resolveHold('readiness', `${p}-impostor`)).toBeNull();
    expect(resolveHold('readiness', '')).toBeNull();
    expect(resolveHold('readiness', null)).toBeNull();
  });
});

/** Production files that construct a readiness verdict (the declaration itself excluded). */
function readinessWriterFiles(root: string, read: (rel: string) => string, files: string[]): string[] {
  const call = /\bcreateImplementationReadiness\(/;
  return files
    .filter((rel) => /\.tsx?$/.test(rel) && !/\.(test|testing)\.tsx?$/.test(rel) && !rel.endsWith('.d.ts'))
    .filter((rel) =>
      read(path.join(root, rel))
        .split('\n')
        .some((line) => {
          const t = line.trim();
          return call.test(t) && !t.startsWith('*') && !t.startsWith('//') && !/function createImplementationReadiness\(/.test(t);
        }),
    )
    .sort();
}

describe('hold registry: every readiness writer is enumerated', () => {
  it('CALIBRATION: the scan finds a call, and ignores the declaration, comments and test files', () => {
    const texts: Record<string, string> = {
      'a.ts': 'const r = createImplementationReadiness({ status });',
      'b.ts': 'export function createImplementationReadiness(input) {}',
      'c.ts': ' * see createImplementationReadiness( for details',
      'd.test.ts': 'createImplementationReadiness({})',
    };
    expect(readinessWriterFiles('/x', (p) => texts[path.basename(p)] ?? '', Object.keys(texts))).toEqual(['a.ts']);
  });

  it('the production writers are exactly the reviewed set (a new writer must use a registered reason)', () => {
    const files = (readdirSync(LIB, { recursive: true }) as string[]).filter((rel) => !rel.includes('node_modules'));
    const writers = readinessWriterFiles(LIB, (p) => readFileSync(p, 'utf8'), files);
    expect(writers).toEqual(
      sorted([
        'attention/intake-compensation.ts',
        'attention/intake-promotion.ts',
        'harness/improvements/agent-review.ts',
        'harness/improvements/capture-core.ts',
        // P-007 Phase C (D-028): writes status 'ready', which is not a hold.
        'harness/improvements/completion-verification.ts',
        'harness/improvements/legacy-acceptance-adoption.ts',
        'harness/improvements/stranded-tool-failure-sweep.ts',
        'harness/improvements/triage-core.ts',
        'issues-engineer.ts',
      ]),
    );
  });
});

describe('classifyHolds', () => {
  const ask = {
    status: 'active',
    kind: 'human',
    capability: 'product-decision',
    summary: 'Ship the epoch policy?',
    createdBy: 'su-asker',
    createdAt: '2026-10-06T00:00:00.000Z',
    nextVerb: 'Answer the ask, then clear the blocker.',
    defaultIfUnanswered: 'ship it',
  };

  it('resolves each hold on a stored row against the registry', () => {
    const holds = classifyHolds({
      status: 'open',
      payload: {
        implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' },
        agentReview: { status: 'pending' },
        externalBlockers: [{ status: 'active', capability: 'credential' }, { status: 'resolved', capability: 'live-dependency' }],
        _claimHold: true,
        held_open_by: 'su-1',
      },
    });
    expect(holds.map((h) => `${h.domain}:${h.key}:${h.entry ? 'mapped' : 'UNMAPPED'}`)).toEqual([
      'readiness:awaiting-agent-review:mapped',
      'review:pending:mapped',
      'blocker:credential:mapped',
      'park:lease:mapped',
    ]);
  });

  it('a needs-human row is mapped only when it carries an active strict owner ask', () => {
    expect(hasActiveStrictHumanAsk({ externalBlockers: [ask] })).toBe(true);
    expect(hasActiveStrictHumanAsk({ externalBlockers: [{ ...ask, defaultIfUnanswered: '' }] })).toBe(false);
    expect(hasActiveStrictHumanAsk({ externalBlockers: [{ ...ask, capability: 'live-dependency' }] })).toBe(false);
    // D-029: it is ALSO the structured owner ask the canonical needs-human writer requires; each
    // missing field fails it on its own, and the fields must sit on ONE blocker.
    for (const field of ['summary', 'createdBy', 'nextVerb', 'createdAt'] as const) {
      expect(hasActiveStrictHumanAsk({ externalBlockers: [{ ...ask, [field]: '' }] }), field).toBe(false);
    }
    expect(hasActiveStrictHumanAsk({ externalBlockers: [{ ...ask, createdAt: 'not-a-date' }] })).toBe(false);
    expect(
      hasActiveStrictHumanAsk({
        externalBlockers: [
          { ...ask, defaultIfUnanswered: '' },
          { ...ask, ref: 'other', nextVerb: '' },
        ],
      }),
    ).toBe(false);
    expect(classifyHolds({ status: 'needs-human', payload: { externalBlockers: [ask] } }).find((h) => h.domain === 'needs-human')?.entry).not.toBeNull();
    const bare = classifyHolds({ status: 'needs-human', payload: {} });
    expect(bare).toEqual([{ domain: 'needs-human', key: 'needs-human-without-answerable-ask', entry: null }]);
  });

  it('terminal rows, observations and ready rows carry no hold', () => {
    expect(classifyHolds({ status: 'done', payload: { implementationReadiness: { status: 'unknown', reason: 'x' } } })).toEqual([]);
    expect(classifyHolds({ status: 'open', lane: 'observation', payload: { implementationReadiness: { status: 'unknown', reason: 'x' } } })).toEqual([]);
    expect(classifyHolds({ status: 'open', payload: { implementationReadiness: { status: 'ready', reason: 'anything' } } })).toEqual([]);
  });

  it('an unregistered stored reason is reported as UNMAPPED, not dropped', () => {
    const [h] = classifyHolds({ status: 'open', payload: { implementationReadiness: { status: 'unknown', reason: 'legacy-free-text' } } });
    expect(h).toEqual({ domain: 'readiness', key: 'legacy-free-text', entry: null });
  });
});

describe('HOLD_PAYLOAD_KEYS: the census projection classifies exactly like the whole payload', () => {
  const ask = {
    status: 'active',
    kind: 'human',
    capability: 'product-decision',
    summary: 'Ship the epoch policy?',
    createdBy: 'su-asker',
    createdAt: '2026-10-06T00:00:00.000Z',
    nextVerb: 'Answer the ask, then clear the blocker.',
    defaultIfUnanswered: 'ship it',
  };
  const noise = { title: 'x', toolFailureProbation: { class: 'caller' }, lane: 'bugs', summary: 'y' };
  const fixtures = [
    {
      status: 'open',
      payload: {
        ...noise,
        implementationReadiness: { status: 'unknown', reason: 'awaiting-agent-review' },
        agentReview: { status: 'revision-requested' },
        externalBlockers: [{ status: 'active', capability: 'credential' }],
        _claimHold: true,
        held_open_by: 'su-1',
      },
    },
    { status: 'needs-human', payload: { ...noise, externalBlockers: [ask] } },
    { status: 'blocked', payload: { ...noise, implementationReadiness: { status: 'not-ready', reason: 'legacy-free-text' } } },
    { status: 'wip', payload: { ...noise, _claimHold: true } },
  ];
  const project = (payload: Record<string, unknown>, keys: readonly string[]) =>
    Object.fromEntries(Object.entries(payload).filter(([key]) => keys.includes(key)));
  const classify = (keys: readonly string[]) =>
    fixtures.map((row) => classifyHolds({ status: row.status, payload: project(row.payload, keys) }));

  it('projected and whole payloads give identical holds', () => {
    const whole = fixtures.map((row) => classifyHolds(row));
    expect(whole.flat().length).toBeGreaterThanOrEqual(7);
    expect(classify(HOLD_PAYLOAD_KEYS)).toEqual(whole);
  });

  it('CALIBRATION: dropping any listed key changes some classification, so a missing key cannot pass unseen', () => {
    const whole = classify(HOLD_PAYLOAD_KEYS);
    for (const key of HOLD_PAYLOAD_KEYS) {
      expect(classify(HOLD_PAYLOAD_KEYS.filter((k) => k !== key)), key).not.toEqual(whole);
    }
  });
});
