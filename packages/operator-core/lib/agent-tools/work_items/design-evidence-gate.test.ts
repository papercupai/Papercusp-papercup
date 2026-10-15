/**
 * P-007 — the design-evidence gate as the completion path consumes it.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24.
 *
 * The behaviour under test is mostly POLICY: when does the obligation apply,
 * when does it refuse rather than report (D-006), and what happens when it
 * cannot be established. The deciding logic has its own suites in
 * design-compare/{gate,feature-gate}.test.ts and is not re-tested here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const acceptanceRead = vi.hoisted(() => vi.fn());
// The reference binding/terminal-write suite controls the artifact reader's
// outcome. acceptance.test.ts separately drives that reader with real canary
// images and filesystem mutations through the same feature/completion adapter.
vi.mock('../../design-compare/acceptance', async (original) => ({
  ...(await original<typeof import('../../design-compare/acceptance')>()),
  designAcceptanceRoot: async () => '/isolated-acceptance-fixture',
  readDesignAcceptance: acceptanceRead,
}));

// ─── R1: the mocks that let this file drive the REAL work_items:complete ─────
// Mirrors complete.test.ts's wholesale engine mock. The point of the block at
// the bottom of this file is to traverse the completion path for real, so the
// ONLY things replaced here are the durable substrate (Postgres) and the
// unrelated sibling gates — never the design-evidence gate itself.
const getWorkItem = vi.fn();
const setWorkItemStateWithAliasInfo = vi.fn();
const setWorkItemClaimHold = vi.fn();
const mergeWorkItemOutputPayload = vi.fn();
const resolveWorkItemRef = vi.fn();
const linkWorkItem = vi.fn();
const subscribeWorkItem = vi.fn();
const attachCompletionEvidenceToSettledItem = vi.fn();
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  getWorkItem: (...a: unknown[]) => getWorkItem(...a),
  setWorkItemStateWithAliasInfo: (...a: unknown[]) => setWorkItemStateWithAliasInfo(...a),
  attachCompletionEvidenceToSettledItem: (...a: unknown[]) => attachCompletionEvidenceToSettledItem(...a),
  setWorkItemClaimHold: (...a: unknown[]) => setWorkItemClaimHold(...a),
  workItemObjectRef: (x: { id: string }) => `wi:${x.id}`,
  mergeWorkItemOutputPayload: (...a: unknown[]) => mergeWorkItemOutputPayload(...a),
  resolveWorkItemRef: (...a: unknown[]) => resolveWorkItemRef(...a),
  linkWorkItem: (...a: unknown[]) => linkWorkItem(...a),
  subscribeWorkItem: (...a: unknown[]) => subscribeWorkItem(...a),
  // D-035 agent-work door gate: the real lookup opens PG, which a unit test may not. null =
  // the row IS agent work, so every case reaches the design-evidence gate it is testing.
  readNonAgentWorkCategory: async () => null,
  SETTLED_WORK_ITEM_STATES: ['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped'],
}));

const setWorkItemCheckpoint = vi.fn();
vi.mock('../../work-item-checkpoint', () => ({
  setWorkItemCheckpoint: (...a: unknown[]) => setWorkItemCheckpoint(...a),
}));
const fireReactionInProcess = vi.fn();
vi.mock('../../events', () => ({
  fireReactionInProcess: (...a: unknown[]) => fireReactionInProcess(...a),
}));
const getFlag = vi.fn();
// `onFlagChange` is required even though nothing here exercises it: a module in
// this import graph calls it at MODULE SCOPE, and a mock omitting it fails the
// whole file at COLLECTION (0 tests run) rather than in a test.
vi.mock('@papercusp/flags/server', () => ({
  getFlag: (...a: unknown[]) => getFlag(...a),
  onFlagChange: () => {},
}));
const specTestAdequacyCompletionGate = vi.fn();
vi.mock('./spec-test-adequacy-gate', () => ({
  specTestAdequacyCompletionGate: (...a: unknown[]) => specTestAdequacyCompletionGate(...a),
}));

// The ONE design-side substitution: the production dependency bundle is
// Postgres + lost-pixel, so it is replaced with the in-memory store. Everything
// that DECIDES — designEvidenceCompletionGate and evaluateFeatureDesignGate —
// is left real, because that consultation is precisely what R1 binds.
const designCompareDepsFor = vi.fn();
vi.mock('../../design-compare/host-install', () => ({
  designCompareDepsFor: (...a: unknown[]) => designCompareDepsFor(...a),
  filesystemReferenceMaterializer: async () => ({ path: '/tmp/reference.png' }),
}));

import {
  DesignGateUnavailableError,
  type FeatureDesignGateResult,
  type FeatureGateReference,
} from '../../design-compare/feature-gate';
import {
  designEvidenceCompletionGate,
  designFeatureCandidates,
  renderDesignEvidenceRefusal,
} from './design-evidence-gate';

import { FLAGS } from '@papercusp/flags';
import type { CaptureEnvironment, ThresholdPolicy } from '../../design-compare/contract';
import { createInMemoryReferenceStore } from '../../design-compare/reference-store';
import { type VerbCaller, type VerbDeps, compareRenderVerb, ratifyReferenceVerb } from '../../design-compare/verbs';
import { calibrationRenderHost } from '../../design-compare/enforceability';
import complete from './complete';

/**
 * P-011/D-023: a reference whose ratification host matches the calibration
 * host, so its verdict is allowed to refuse rather than only report.
 */
const ENFORCEABLE = { enforceable: true, renderHost: 'chromium/141;probe@72px[…]' } as const;

/** The same verdict on a reference the shipped threshold was never measured for. */
const NOT_ENFORCEABLE = {
  enforceable: false,
  reason: 'reference-host-unknown',
  detail: 'no rendering host recorded',
} as const;

const NOT_APPLICABLE: FeatureDesignGateResult = { applicable: false, references: [] };

const SATISFIED: FeatureDesignGateResult = {
  applicable: true,
  satisfied: true,
  references: [
    {
      referenceId: 'ref-a',
      verdict: {
        applicable: true,
        satisfied: true,
        referenceId: 'ref-a',
        activeRevision: 1,
        cases: [],
        doesNotEstablish: ['accessibility'],
      },
      enforceability: ENFORCEABLE,
    },
  ],
  blocking: [],
  enforceableBlocking: [],
  doesNotEstablish: ['accessibility'],
};

/**
 * One failing reference, built once.
 *
 * It was previously spelled out twice — identically — under `references` and
 * `blocking`. Two copies of the fixture that decides whether this gate refuses
 * is exactly the shape that drifts, and a divergence between them would look
 * like a behaviour change rather than a typo.
 */
function failingReference(enforceability: FeatureGateReference['enforceability']) {
  return {
    referenceId: 'ref-a',
    verdict: {
      applicable: true,
      satisfied: false,
      referenceId: 'ref-a',
      activeRevision: 2,
      failures: [
        {
          caseId: 'desktop',
          kind: 'missing',
          reason: 'no-evidence',
          environment: {
            viewport: { width: 1280, height: 800 },
            deviceScaleFactor: 2,
            browser: 'chromium',
            theme: 'dark',
            fontSet: 'x',
          },
          rationale: 'primary',
          remedy: 'run design-phase.compare_render',
        },
      ],
      satisfiedCases: [],
      doesNotEstablish: ['accessibility'],
    },
    enforceability,
  } satisfies FeatureGateReference;
}

const UNSATISFIED: FeatureDesignGateResult = {
  applicable: true,
  satisfied: false,
  references: [failingReference(ENFORCEABLE)],
  blocking: [failingReference(ENFORCEABLE)],
  enforceableBlocking: [failingReference(ENFORCEABLE)],
  doesNotEstablish: ['accessibility'],
};

/**
 * The same failure on a reference the shipped threshold was never measured for
 * (P-011/D-023). `blocking` is non-empty and `enforceableBlocking` is not, which
 * is the whole distinction: the work genuinely owes evidence, and refusing on a
 * tolerance of ~34 pixels that was never measured against this machine's fonts
 * would fail correct work — the harm D-021 recorded.
 */
const UNSATISFIED_UNENFORCEABLE: FeatureDesignGateResult = {
  applicable: true,
  satisfied: false,
  references: [failingReference(NOT_ENFORCEABLE)],
  blocking: [failingReference(NOT_ENFORCEABLE)],
  enforceableBlocking: [],
  doesNotEstablish: ['accessibility'],
};

const on = async () => true;
const off = async () => false;

describe('designFeatureCandidates', () => {
  /**
   * The design-artifact rows in this workspace key `feature_id` by PLAN SLUG,
   * not by work-item id. Resolving only the id would find nothing and report
   * every item unratified — a gate that never fires, which is indistinguishable
   * from a gate that always passes.
   */
  it('checks the plan slug as well as the work-item id', () => {
    expect(designFeatureCandidates({ id: 'WI-1', sourcePlanSlug: 'my-plan' })).toEqual(['my-plan', 'WI-1']);
  });

  it('de-duplicates and tolerates a missing plan slug', () => {
    expect(designFeatureCandidates({ id: 'WI-1', sourcePlanSlug: null })).toEqual(['WI-1']);
    expect(designFeatureCandidates({ id: 'x', sourcePlanSlug: 'x' })).toEqual(['x']);
  });
});

describe('applicability', () => {
  it('is inert when the gate flag is off', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => {
        throw new Error('the gate was consulted while disabled');
      },
      isEnabled: off,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('not-applicable');
  });

  it('reports not-applicable when no candidate feature has a ratified reference', async () => {
    const outcome = await designEvidenceCompletionGate(['plan', 'WI-1'], {
      evaluate: async () => NOT_APPLICABLE,
      isEnabled: on,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('not-applicable');
  });

  /**
   * The candidate loop must not stop at the first feature that has nothing.
   * A work-item whose plan slug carries no references would otherwise exempt
   * itself from an obligation genuinely recorded under its own id.
   */
  it('keeps looking when the first candidate has no references', async () => {
    const seen: string[] = [];
    const outcome = await designEvidenceCompletionGate(['plan', 'WI-1'], {
      evaluate: async (featureId) => {
        seen.push(featureId);
        return featureId === 'WI-1' ? UNSATISFIED : NOT_APPLICABLE;
      },
      isEnabled: on,
      isEnforcing: off,
    });
    expect(seen).toEqual(['plan', 'WI-1']);
    expect(outcome.status).toBe('unsatisfied');
  });

  it('does not let a passing plan reference hide a failing item reference', async () => {
    const evaluate = vi.fn(async (id: string) => (id === 'plan' ? SATISFIED : UNSATISFIED));
    const outcome = await designEvidenceCompletionGate(['plan', 'WI-1'], { evaluate, isEnabled: on, isEnforcing: on });
    expect(evaluate.mock.calls.map(([id]) => id)).toEqual(['plan', 'WI-1']);
    expect(outcome).toMatchObject({ status: 'unsatisfied', enforced: true, featureId: 'WI-1' });
    expect('report' in outcome && outcome.report).toContain("design 'WI-1'");
  });

  it('does not let an advisory plan failure hide an enforceable item failure', async () => {
    const outcome = await designEvidenceCompletionGate(['plan', 'WI-1'], {
      evaluate: async (id) => (id === 'plan' ? UNSATISFIED_UNENFORCEABLE : UNSATISFIED),
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome).toMatchObject({ status: 'unsatisfied', enforced: true });
    expect('report' in outcome && outcome.report).toContain("design 'plan'");
    expect('report' in outcome && outcome.report).toContain("design 'WI-1'");
  });

  it('checks a declared approved reference even outside the item and plan candidates', async () => {
    const evaluate = vi.fn(async () => NOT_APPLICABLE);
    const outcome = await designEvidenceCompletionGate(['WI-1'], {
      evaluate,
      isEnabled: on,
      isEnforcing: on,
      requiredReferences: [{ featureId: 'original-design', referenceId: 'option-b' }],
    });
    expect(evaluate.mock.calls).toHaveLength(2);
    expect(outcome).toMatchObject({ status: 'unsatisfied', enforced: true, blockingReferenceIds: ['option-b'] });
    expect('report' in outcome && outcome.report).toContain('not actively ratified');
  });

  it('does not satisfy an explicit reference with a different passing reference', async () => {
    const outcome = await designEvidenceCompletionGate(['plan'], {
      evaluate: async () => SATISFIED,
      isEnabled: on,
      isEnforcing: on,
      requiredReferences: [{ featureId: 'plan', referenceId: 'option-b' }],
    });
    expect(outcome).toMatchObject({ status: 'unsatisfied', enforced: true, blockingReferenceIds: ['option-b'] });
  });

  it('accepts a declared reference only when that exact active reference passes', async () => {
    const outcome = await designEvidenceCompletionGate(['plan'], {
      evaluate: async () => SATISFIED,
      isEnabled: on,
      isEnforcing: on,
      requiredReferences: [{ featureId: 'plan', referenceId: 'ref-a' }],
    });
    expect(outcome.status).toBe('satisfied');
  });

  it('refuses malformed design obligations instead of dropping them', async () => {
    const outcome = await designEvidenceCompletionGate(['plan'], {
      evaluate: async () => NOT_APPLICABLE,
      isEnabled: on,
      isEnforcing: on,
      requiredReferences: [{ featureId: 'plan' }],
    });
    expect(outcome).toMatchObject({ status: 'unavailable', enforced: true });
  });

  it('does not let a passing reference hide an unavailable later obligation', async () => {
    const outcome = await designEvidenceCompletionGate(['plan', 'WI-1'], {
      evaluate: async (id) => {
        if (id === 'plan') return SATISFIED;
        throw new Error('store offline');
      },
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome).toMatchObject({ status: 'unavailable', enforced: true });
  });
});

describe('report-only rollout (D-006)', () => {
  it('does NOT enforce by default, and says so in the outcome', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('unsatisfied');
    if (outcome.status !== 'unsatisfied') return;
    expect(outcome.enforced).toBe(false);
    expect(outcome.blockingReferenceIds).toEqual(['ref-a']);
  });

  /**
   * CALIBRATION for the case above. Without it, a gate hardwired to
   * `enforced: false` would satisfy every assertion in this file about
   * report-only behaviour while being incapable of ever enforcing.
   */
  /**
   * P-011/D-023. The flag says enforcement is ON; it does not say the threshold
   * was measured for the machine involved. Both must hold, and the calibration
   * immediately below proves this suite can still observe a real enforcement —
   * without it, a gate hardwired to `enforced: false` would satisfy this test.
   */
  it('does NOT enforce a failing reference the threshold was never measured for', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED_UNENFORCEABLE,
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome.status).toBe('unsatisfied');
    if (outcome.status !== 'unsatisfied') return;
    expect(outcome.enforced).toBe(false);
    // Still REPORTED as blocking: the work owes evidence either way, and
    // dropping it from the report would turn "we could not enforce" into
    // "there was nothing wrong".
    expect(outcome.blockingReferenceIds).toEqual(['ref-a']);
  });

  it('DOES enforce once the enforcement flag is on', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome.status === 'unsatisfied' && outcome.enforced).toBe(true);
  });

  it('a satisfied obligation reports rather than staying silent', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => SATISFIED,
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome.status).toBe('satisfied');
    if (outcome.status !== 'satisfied') return;
    expect(outcome.report).toContain('does NOT establish');
  });
});

describe('unavailability', () => {
  it('reports unavailable rather than passing when the obligation cannot be established', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => {
        throw new DesignGateUnavailableError('connection reset');
      },
      isEnabled: on,
      isEnforcing: off,
    });
    expect(outcome.status).toBe('unavailable');
    if (outcome.status !== 'unavailable') return;
    expect(outcome.report).toContain('connection reset');
  });

  it('reports an unexpected error without refusing during report-only rollout', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => {
        throw new TypeError('programming error');
      },
      isEnabled: on,
      isEnforcing: off,
    });
    expect(outcome).toMatchObject({
      status: 'unavailable',
      enforced: false,
    });
    if (outcome.status !== 'unavailable') return;
    expect(outcome.report).toContain("failed unexpectedly for 'f': programming error");
  });

  it('preserves enforcement for an unexpected error instead of silently passing', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => {
        throw new TypeError('programming error');
      },
      isEnabled: on,
      isEnforcing: on,
    });
    expect(outcome).toMatchObject({
      status: 'unavailable',
      enforced: true,
    });
    if (outcome.status !== 'unavailable') return;
    expect(outcome.report).toContain("failed unexpectedly for 'f': programming error");
  });

  /**
   * A flag read that throws must not become an enforcement mandate: blocking
   * completions because the flag service blipped is a worse failure than
   * missing one report.
   */
  it('treats an unreadable enforcement flag as not-enforcing', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: async () => {
        throw new Error('flag service down');
      },
    });
    expect(outcome.status === 'unsatisfied' && outcome.enforced).toBe(false);
  });
});

describe('refusal rendering', () => {
  it('states that nothing was written, so a retry cannot make it worse', async () => {
    const outcome = await designEvidenceCompletionGate(['f'], {
      evaluate: async () => UNSATISFIED,
      isEnabled: on,
      isEnforcing: on,
    });
    if (outcome.status !== 'unsatisfied') throw new Error('expected unsatisfied');
    const text = renderDesignEvidenceRefusal('WI-9', outcome);
    expect(text).toContain('WI-9');
    expect(text).toContain('No completion record or state transition was written');
    expect(text).toContain('compare_render');
  });
});

/**
 * R1 — a completion that ACTUALLY TRAVERSES the gate.
 *
 * ─── WHY EVERYTHING ABOVE THIS LINE IS NOT ENOUGH ────────────────────────────
 *
 * Every case above calls `designEvidenceCompletionGate` directly and hands it a
 * hand-built `FeatureDesignGateResult`. That proves the POLICY — when the gate
 * refuses rather than reports, what the refusal says. It cannot prove that
 * anything CONSULTS it, because the caller in those tests is the test.
 *
 * This criterion's stated BINDING drift is exactly that: the bound files
 * "partitioning into 'gate logic' and 'completion wiring' with nothing
 * exercising a completion that actually traverses the gate". Before this block,
 * the consultation at complete.ts:1891 and the refusal at :1922 were verified by
 * CODE-READ ONLY — a suite-wide grep found no test driving them. Delete both
 * lines and every design-compare suite stays green while ratified work closes
 * with no evidence at all.
 *
 * So these cases drive the REAL `work_items:complete` handler. The engine is
 * mocked (as it is in complete.test.ts) and the design dependency bundle is the
 * in-memory store instead of Postgres — but `designEvidenceCompletionGate` and
 * `evaluateFeatureDesignGate` are the real ones, and the gate is reached the way
 * production reaches it rather than by being called directly.
 *
 * BOTH halves of the claim are asserted, because the first without the second is
 * the dangerous shape: an error string is easy to return from a path that has
 * ALREADY written the terminal state, leaving an item closed AND reported
 * refused. `setWorkItemStateWithAliasInfo` is the real writer, so
 * `not.toHaveBeenCalled()` is what "no terminal state was written" means here.
 */
describe('R1: work_items:complete actually consults the design-evidence gate', () => {
  const HARNESS = 'papercup';
  const PLAN_SLUG = 'ratified-surface-plan';
  const REF = 'ref-checkout-desktop';
  const ITEM = 'WI-design-1';

  const ENV: CaptureEnvironment = {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    browser: 'chromium',
    theme: 'dark',
    fontSet: 'papercusp-default',
  };

  const POLICY: ThresholdPolicy = {
    policyVersion: 'p-2026-08-25',
    referenceClass: 'artifact-capture',
    eligibility: 'gateable',
    maxDiffRatio: 0.001,
    derivedFrom: 'calibration-run-1',
  };

  const CALLER: VerbCaller = { actorId: 'su-ratifier', role: 'reviewer' };

  // DESKTOP 1280x800 = 1_024_000 px; at maxDiffRatio 0.001 the failing threshold
  // is >1024 changed pixels, so this is comfortably over.
  const FAILING_PIXELS = 50_000;

  function deps(pixelDifference: number): VerbDeps & { store: ReturnType<typeof createInMemoryReferenceStore> } {
    const store = createInMemoryReferenceStore();
    let tick = 0;
    return {
      harnessSlug: HARNESS,
      store,
      now: () => 1_000,
      clock: () => `2026-08-25T00:00:${String(tick++).padStart(2, '0')}.000Z`,
      materializeReferenceImage: async () => ({ path: '/tmp/reference.png' }),
      comparison: {
        provider: {
          engine: { engine: 'fake/pixelmatch', engineVersion: '9.9.9' },
          async compare() {
            return { pixelDifference, diffArtifactWritten: true };
          },
        },
        probe: () => ({ exists: true, dimensions: { ...ENV.viewport } }),
      },
    };
  }

  /**
   * Ratify under the PLAN SLUG, on the calibration host.
   *
   * Both details are load-bearing. The feature id is the plan slug because that
   * is the convention `designFeatureCandidates` resolves against, and the render
   * host must match `calibrationRenderHost()` or the failure is reportable but
   * NOT enforceable (D-023) — in which case the completion succeeds and this
   * test would be asserting the wrong thing for the wrong reason.
   */
  async function ratifyOnCalibrationHost(d: VerbDeps): Promise<void> {
    await ratifyReferenceVerb(
      {
        featureId: PLAN_SLUG,
        referenceId: REF,
        revision: 1,
        referenceClass: 'artifact-capture',
        contentSha256: 'a'.repeat(64),
        image: {
          mediaType: 'image/png',
          locator: `/refs/${REF}.png`,
          byteLength: 4096,
          width: ENV.viewport.width,
          height: ENV.viewport.height,
        },
        referenceEnvironment: ENV,
        requiredCases: [
          {
            caseId: `${REF}-case`,
            environment: ENV,
            target: { targetId: `components-checkout--${REF}`, targetKind: 'storybook-story' },
            rationale: 'primary breakpoint',
          },
        ],
        provenance: {
          source: 'artifact-capture',
          sourceRef: 'artifact://abc',
          capturedOnRenderHost: calibrationRenderHost() ?? undefined,
        },
      },
      CALLER,
      d,
    );
  }

  /**
   * Record a comparison ON THE CALIBRATION HOST.
   *
   * `renderHost` is not optional dressing here. D-023 judges a case INVALID when
   * the evidence was captured on a host the reference was not ratified on —
   * "the stored evidence passed, but it was produced on a capture that reported
   * no rendering host". Omitting it makes every case fail for a cross-host
   * reason, which would let the over-threshold cases below pass while proving
   * nothing about the threshold. (This is not hypothetical: the passing CONTROL
   * is what caught it.)
   */
  async function compareAgainst(d: VerbDeps): Promise<void> {
    await compareRenderVerb(
      {
        featureId: PLAN_SLUG,
        referenceId: REF,
        target: {
          targetId: `components-checkout--${REF}`,
          targetKind: 'storybook-story',
          implementationRevision: 'impl-1',
        },
        environment: ENV,
        policy: POLICY,
        actualImagePath: '/tmp/actual.png',
        diffImagePath: '/tmp/diff.png',
        renderHost: calibrationRenderHost() ?? undefined,
      },
      CALLER,
      d,
    );
  }

  /** Drive the REAL tool handler for a terminal close. */
  async function closeItem() {
    const args = (complete.args as { parse: (x: unknown) => unknown }).parse({
      id: ITEM,
      state: 'resolved',
      assumptions: 'none',
      completion: { summary: 'implemented the ratified surface', tests: '5 green' },
    });
    const res = (await complete.handler(
      args as never,
      {
        uiClientId: 'su-tester',
        isSuperuser: true,
        workspaceId: 'default',
      } as never,
    )) as { data: { results: { ok: boolean; id: string; error?: string }[] } };
    return res.data.results[0]!;
  }

  beforeEach(() => {
    acceptanceRead.mockReset();
    acceptanceRead.mockResolvedValue({ satisfied: true, failures: [] });
    getWorkItem.mockReset();
    getWorkItem.mockResolvedValue({
      id: ITEM,
      kind: 'change',
      family: 'issue',
      state: 'in_progress',
      harness: HARNESS,
      sourcePlanSlug: PLAN_SLUG,
    });
    setWorkItemStateWithAliasInfo.mockReset();
    setWorkItemStateWithAliasInfo.mockImplementation(async () => ({
      workItem: { id: ITEM, state: 'resolved', harness: HARNESS },
      aliased: false,
      requestedState: 'resolved',
      appliedState: 'resolved',
    }));
    setWorkItemClaimHold.mockReset();
    setWorkItemClaimHold.mockResolvedValue({ id: ITEM, harness: HARNESS, hold: true, applicable: true });
    mergeWorkItemOutputPayload.mockReset();
    resolveWorkItemRef.mockReset();
    linkWorkItem.mockReset();
    linkWorkItem.mockResolvedValue({ ok: true });
    subscribeWorkItem.mockReset();
    subscribeWorkItem.mockResolvedValue({ ok: true });
    setWorkItemCheckpoint.mockReset();
    setWorkItemCheckpoint.mockResolvedValue(null);
    fireReactionInProcess.mockReset();
    fireReactionInProcess.mockResolvedValue({ ok: true });
    attachCompletionEvidenceToSettledItem.mockReset();
    attachCompletionEvidenceToSettledItem.mockResolvedValue({ outcome: 'recorded', workItem: null });
    specTestAdequacyCompletionGate.mockReset();
    specTestAdequacyCompletionGate.mockResolvedValue({ ok: true, applicable: false, checked: [] });

    // Only the two design-evidence flags are on. Every OTHER flag stays off, so
    // an unrelated gate cannot be the thing refusing and be mistaken for this one.
    getFlag.mockReset();
    getFlag.mockImplementation(
      async (flag: string) => flag === FLAGS.DESIGN_EVIDENCE_GATE || flag === FLAGS.DESIGN_EVIDENCE_GATE_ENFORCING,
    );
    designCompareDepsFor.mockReset();
  });

  it('REFUSES the close when a ratified reference has no evidence, and writes NO terminal state', async () => {
    const d = deps(0); // ratified, never compared
    await ratifyOnCalibrationHost(d);
    designCompareDepsFor.mockResolvedValue(d);

    const result = await closeItem();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing terminal completion for 'WI-design-1'/);
    expect(result.error).toContain(REF);
    // The reason is ABSENCE of evidence — distinct from the failing-evidence
    // case below, whose remedy is the opposite instruction.
    expect(result.error).toMatch(/design-phase\.compare_render/);
    expect(result.error).not.toMatch(/fix the implementation for case/);
    // The half that matters most: the refusal is not a message attached to a
    // close that already happened.
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('REFUSES when the evidence exists but FAILS, and still writes no terminal state', async () => {
    // Distinct from the case above: here the implementer did run the comparison.
    // "Evidence was produced" must not be mistakable for "evidence passed".
    const d = deps(FAILING_PIXELS);
    await ratifyOnCalibrationHost(d);
    await compareAgainst(d);
    designCompareDepsFor.mockResolvedValue(d);

    const result = await closeItem();

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/refusing terminal completion/);
    // Pin the REASON, not just the refusal. This case and the one above must
    // refuse for genuinely different causes — an over-threshold diff here, an
    // absence there — or a single catch-all failure would satisfy both while
    // proving the gate distinguishes nothing.
    expect(result.error).toMatch(/fix the implementation for case/);
    // And specifically NOT the cross-host reason: if `renderHost` ever stops
    // being recorded, this case would still "refuse" while silently no longer
    // testing the threshold at all.
    expect(result.error).not.toMatch(/no rendering host|different machine/);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('CONTROL: the same close SUCCEEDS once the evidence passes', async () => {
    // Without this control, both refusals above are equally consistent with a
    // completion path that refuses everything — which is the failure mode that
    // would make the whole gate look shipped while blocking all work.
    const d = deps(0);
    await ratifyOnCalibrationHost(d);
    await compareAgainst(d);
    designCompareDepsFor.mockResolvedValue(d);

    const result = await closeItem();

    // The error rides the assertion message: a control that fails for an
    // UNRELATED reason would otherwise read as "the gate refused", which is the
    // one conclusion this case exists to rule out.
    expect(result.ok, result.error).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
  });

  it('CONTROL: an UNRATIFIED surface imposes nothing, so exploration still closes', async () => {
    // The other side of the window (D-001). A gate that refused here would make
    // ratifying strictly worse than never ratifying at all.
    const d = deps(0); // nothing ratified
    designCompareDepsFor.mockResolvedValue(d);

    const result = await closeItem();

    expect(result.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
  });

  it('REFUSES a declared approved design with no ratification through the real completion handler', async () => {
    getWorkItem.mockResolvedValue({
      id: ITEM, kind: 'change', family: 'issue', state: 'in_progress',
      harness: HARNESS, sourcePlanSlug: PLAN_SLUG,
      payload: { designReferences: [{ featureId: PLAN_SLUG, referenceId: REF }] },
    });
    designCompareDepsFor.mockResolvedValue(deps(0));
    const result = await closeItem();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('not actively ratified');
    expect(result.error).toContain(REF);
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('CONTROL: a declared design closes through the real handler once its exact reference passes', async () => {
    getWorkItem.mockResolvedValue({
      id: ITEM, kind: 'change', family: 'issue', state: 'in_progress',
      harness: HARNESS, sourcePlanSlug: PLAN_SLUG,
      payload: { designReferences: [{ featureId: PLAN_SLUG, referenceId: REF }] },
    });
    const d = deps(0);
    await ratifyOnCalibrationHost(d);
    await compareAgainst(d);
    designCompareDepsFor.mockResolvedValue(d);
    const result = await closeItem();
    expect(result.ok, result.error).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
  });

  it('REFUSES an unexpected gate fault while enforcing, and writes no terminal state', async () => {
    designCompareDepsFor.mockRejectedValue(new TypeError('programming error'));

    const result = await closeItem();

    expect(result.ok).toBe(false);
    expect(result.error).toContain("design-evidence gate failed unexpectedly for 'ratified-surface-plan'");
    expect(result.error).toContain('programming error');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  // The desktop canary's approval contract, with controlled comparison evidence.
  // This proves binding through the real completion path; live portal rendering
  // remains a separate browser obligation under the prevention plan's P-002/3.
  const DESKTOP_ROUTE = '/?app=desktops';
  const APPROVAL = {
    schemaVersion: 1,
    approvalRef: 'unified-web-portal-2026-08-29#D-062',
    planSlug: PLAN_SLUG,
    planItemIds: ['P-001'],
    targetRoute: DESKTOP_ROUTE,
    acceptance: { schemaVersion: 1, contractPath: 'contract.json', contractSha256: 'a'.repeat(64), evidencePath: 'evidence.json' },
  } as const;

  function desktopApprovalInput(revision = 1) {
    const environment = { ...ENV, state: 'disconnected' };
    return {
      featureId: PLAN_SLUG, referenceId: REF, revision,
      referenceClass: 'artifact-capture' as const,
      contentSha256: (revision === 1 ? 'a' : 'b').repeat(64),
      image: {
        mediaType: 'image/png' as const, locator: `/refs/desktop-option-b-${revision}.png`,
        byteLength: 4096, width: ENV.viewport.width, height: ENV.viewport.height,
      },
      referenceEnvironment: environment,
      requiredCases: [{
        caseId: 'desktop.option-b.disconnected', environment,
        target: { targetKind: 'page-route' as const, targetId: DESKTOP_ROUTE },
        rationale: 'Option B viewer, roster and activity with truthful disconnected data',
      }],
      provenance: {
        source: 'artifact-capture', sourceRef: 'scratchpad/visual-desktop-mockups-2026-09-07/b-workspace.png',
        capturedOnRenderHost: calibrationRenderHost() ?? undefined,
      },
      approval: revision === 1 ? APPROVAL : { ...APPROVAL, approvalRef: 'reviewed-desktop-replacement#D-001' },
    };
  }

  async function prepareApprovedDesktop(d: VerbDeps, revision = 1) {
    const input = desktopApprovalInput(revision);
    Object.assign(d, {
      // This synthetic reference exercises the binding/completion obligations
      // after rollout admission. The real policy reader and its refusal controls
      // are exercised separately in design-compare/rollout.test.ts.
      rolloutAdmission: async () => ({ satisfied: true, reason: 'reviewed-fixture-cohort' }),
      materializeReferenceImage: async (image: { locator: string }) => ({
        path: '/tmp/reference.png', contentSha256: (image.locator.endsWith('-1.png') ? 'a' : 'b').repeat(64),
      }),
    });
    const ratified = await ratifyReferenceVerb(input, CALLER, d);
    expect(ratified.ok, JSON.stringify(ratified)).toBe(true);
    const compared = await compareRenderVerb({
      featureId: PLAN_SLUG, referenceId: REF,
      target: { targetId: DESKTOP_ROUTE, targetKind: 'page-route', implementationRevision: 'repaired-portal' },
      environment: input.referenceEnvironment, policy: POLICY,
      actualImagePath: '/tmp/actual.png', diffImagePath: '/tmp/diff.png',
      renderHost: calibrationRenderHost() ?? undefined,
    }, CALLER, d);
    expect(compared.ok, JSON.stringify(compared)).toBe(true);
    designCompareDepsFor.mockResolvedValue(d);
    return ratified;
  }

  function approvedDesktopItem(binding: unknown) {
    getWorkItem.mockResolvedValue({
      id: ITEM, kind: 'change', family: 'issue', state: 'in_progress',
      harness: HARNESS, sourcePlanSlug: PLAN_SLUG, sourcePlanItemIds: ['P-001'],
      payload: binding === undefined ? {} : { designReferences: binding },
    });
  }

  const DESKTOP_BINDING = {
    schemaVersion: 1, featureId: PLAN_SLUG, referenceId: REF,
    revision: 1, contentSha256: 'a'.repeat(64),
  };

  it('desktop.binding.missing: original unbound approval cannot close even with passing pixels', async () => {
    await prepareApprovedDesktop(deps(0));
    approvedDesktopItem(undefined);
    const result = await closeItem();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('approval-binding-missing');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('desktop.binding.malformed: an invalid revision cannot discharge approval', async () => {
    await prepareApprovedDesktop(deps(0));
    approvedDesktopItem([{ ...DESKTOP_BINDING, revision: 'latest' }]);
    const result = await closeItem();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('approval-binding-malformed');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('desktop.binding.replaced: fresh passing pixels cannot silently replace the approved reference', async () => {
    const d = deps(0);
    await prepareApprovedDesktop(d);
    await prepareApprovedDesktop(d, 2);
    approvedDesktopItem([DESKTOP_BINDING]);
    const result = await closeItem();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('approval-reference-replaced');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('desktop.binding.repaired: exact approved binding and current evidence allow the same close', async () => {
    const ratified = await prepareApprovedDesktop(deps(0));
    expect(ratified).toMatchObject({ binding: DESKTOP_BINDING });
    approvedDesktopItem([DESKTOP_BINDING]);
    const result = await closeItem();
    expect(result.ok, result.error).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
  });

  it.each(['missing-acceptance-registration', 'missing-proof', 'wrong-target', 'stale-source', 'stale-build', 'invalid-capture', 'journey-failed'])(
    'desktop.gate.%s: the real completion handler writes no terminal state', async (reason) => {
      await prepareApprovedDesktop(deps(0));
      approvedDesktopItem([DESKTOP_BINDING]);
      acceptanceRead.mockResolvedValue({ satisfied: false, failures: [{ caseId: 'desktop', reason }] });
      const result = await closeItem();
      expect(result.ok).toBe(false);
      expect(result.error).toContain(reason);
      expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
    },
  );

  it('desktop.binding.scope: a different implementing item cannot borrow the approved binding', async () => {
    await prepareApprovedDesktop(deps(0));
    approvedDesktopItem([DESKTOP_BINDING]);
    getWorkItem.mockResolvedValue({
      ...(await getWorkItem()), sourcePlanItemIds: ['P-002'],
    });
    const result = await closeItem();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('approval-scope-mismatch');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it.each(['approvalRef', 'targetRoute', 'planItemIds', 'state'] as const)(
    'desktop.binding.invalid-scope: refuses malformed %s before ratification', async (field) => {
      const input = desktopApprovalInput();
      const malformed = field === 'state'
        ? { ...input, requiredCases: input.requiredCases.map(c => ({ ...c, environment: { ...c.environment, state: '' } })) }
        : { ...input, approval: { ...APPROVAL, [field]: field === 'planItemIds' ? [] : '' } };
      const d = deps(0);
      const result = await ratifyReferenceVerb(malformed, CALLER, d);
      expect(result).toMatchObject({ ok: false, code: 'validation-failed' });
      expect(await d.store.listFeatureReferenceIds({ harnessSlug: HARNESS, featureId: PLAN_SLUG })).toEqual([]);
    },
  );

  it('desktop.binding.downgrade: revising the image cannot remove the adopted approval contract', async () => {
    const d = deps(0);
    await prepareApprovedDesktop(d);
    const { approval: _approval, ...replacement } = desktopApprovalInput(2);
    const result = await ratifyReferenceVerb(replacement, CALLER, d);
    expect(result).toMatchObject({ ok: false, code: 'validation-failed' });
    expect(JSON.stringify(result)).toContain('approval');
  });

  it('desktop.binding.reapproval: replacement bytes cannot reuse the original approval source', async () => {
    const d = deps(0);
    await prepareApprovedDesktop(d);
    const result = await ratifyReferenceVerb({ ...desktopApprovalInput(2), approval: APPROVAL }, CALLER, d);
    expect(result).toMatchObject({ ok: false, code: 'validation-failed' });
    expect(JSON.stringify(result)).toContain('new approvalRef');
  });

  it('desktop.binding.bytes: changing image bytes behind the same locator invalidates prior passing proof', async () => {
    const d = deps(0);
    await prepareApprovedDesktop(d);
    Object.assign(d, { materializeReferenceImage: async () => ({ path: '/tmp/reference.png', contentSha256: 'c'.repeat(64) }) });
    approvedDesktopItem([DESKTOP_BINDING]);
    const result = await closeItem();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('approved-reference-bytes-mismatch');
    expect(setWorkItemStateWithAliasInfo).not.toHaveBeenCalled();
  });

  it('reports but does NOT refuse while enforcement is off (D-006 report-only rollout)', async () => {
    // The gate ships report-only until P-011 flips it. This pins that the
    // ENFORCING flag is what separates a refusal from a notice — so flipping it
    // is a real change and not a no-op over an already-refusing path.
    getFlag.mockImplementation(async (flag: string) => flag === FLAGS.DESIGN_EVIDENCE_GATE);
    const d = deps(FAILING_PIXELS);
    await ratifyOnCalibrationHost(d);
    await compareAgainst(d);
    designCompareDepsFor.mockResolvedValue(d);

    const result = await closeItem();

    expect(result.ok).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
  });

  it('CONTROL: an unexpected gate fault still reports without refusing while enforcement is off', async () => {
    getFlag.mockImplementation(async (flag: string) => flag === FLAGS.DESIGN_EVIDENCE_GATE);
    designCompareDepsFor.mockRejectedValue(new TypeError('programming error'));

    const result = await closeItem();

    expect(result.ok, result.error).toBe(true);
    expect(setWorkItemStateWithAliasInfo).toHaveBeenCalled();
  });

  it('FALSIFIABILITY CONTROL: a completion path that never consulted the gate would pass every negative test', async () => {
    // The deliberately-wrong implementation, kept permanently in the file
    // (CLAUDE.md's prescribed tier for an imported module — no tree mutation, no
    // sweep race, and it re-proves itself on every CI run).
    //
    // `neverConsults` is the drift this criterion is written against: a
    // completion path with the gate call deleted. Note what it does to the suite
    // — it agrees with the real path on BOTH controls above (it closes), and
    // differs only on the two refusals. That is the whole reason the refusals
    // have to exist as distinct cases: a suite of controls alone cannot tell a
    // shipped gate from a deleted one.
    const neverConsults = async () => ({ ok: true, id: ITEM });

    const d = deps(0);
    await ratifyOnCalibrationHost(d);
    designCompareDepsFor.mockResolvedValue(d);

    const real = await closeItem();
    const stubbed = await neverConsults();

    expect(stubbed.ok).toBe(true);
    expect(real.ok).toBe(false);
    expect(real.ok).not.toBe(stubbed.ok);
  });
});
