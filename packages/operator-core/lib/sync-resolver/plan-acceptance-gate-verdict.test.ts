import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * P-011, the plan acceptance-gate read surface — the D-019 half of the plan panel.
 *
 * This query and `plans.specCoverage` look redundant (the gate verdict can itself carry a
 * `specCoverage` field), and the obvious simplification is to delete the census query and
 * render coverage from this verdict. D-019 forbids it, and the reason is mechanical:
 * `evaluatePlanAcceptanceGate` SHORT-CIRCUITS on its first refusal, so `specCoverage` is
 * absent on every refusal that PRECEDES the census — the item/audit family, the flag being
 * off, an exempt plan. A panel deriving coverage from this verdict would show a plan with a
 * real coverage problem as having none, because an earlier check refused first.
 *
 * The permanent negative control at the bottom reproduces that derivation and shows it
 * going blind, so the ruling is pinned by a failing alternative rather than by prose.
 *
 * The honesty rule here runs the OPPOSITE way from the census. The census's findings are
 * advisory (D-018) and it fails OPEN; these codes are REAL refusals and this resolver fails
 * CLOSED. That asymmetry is deliberate — "harmonizing" the two would either manufacture
 * refusals out of read errors, or render an unverified plan green — so both polarities are
 * asserted below.
 *
 * Three states must never be flattened into a green, and each is asserted against real
 * output rather than trusted to the module comment:
 *
 *   · `skipped`           — the gate did not APPLY. Nothing was checked.
 *   · `forcedPast`        — a human waived the code-truth family, with a reason.
 *   · `vettedUnderWaiver` — vetting attested over a consult nobody critiqued.
 */

const gateSpy = vi.fn();
const snapshotSpy = vi.fn();
vi.mock('../plan-acceptance-gate', () => ({
  evaluatePlanAcceptanceGate: (...a: unknown[]) => gateSpy(...a),
}));
vi.mock('../acceptance-bar-contract-snapshot', () => ({
  readAcceptanceBarContractSnapshot: (...a: unknown[]) => snapshotSpy(...a),
}));

import { resolvePlanAcceptanceGateVerdict } from './plan-acceptance-gate-verdict';
import { getBuildInfo } from '../build-info';

const ARGS = { workspaceId: 'default', planSlug: 'p-1' };

type Row = {
  planSlug: string;
  buildProvenance: { sha: string | null; version: string };
  satisfied: boolean;
  skipped: string | null;
  code: string | null;
  message: string | null;
  rubricId: string | null;
  gradedBy: string | null;
  unknownRatedCriteria: string[];
  forcedPast: { reason: string; checks: string[] } | null;
  vettedUnderWaiver: { consultId: string; reason: string | null } | null;
  unavailableReason: string | null;
  acceptanceBarContractSnapshot: Record<string, unknown> | null;
  acceptanceBarContractSnapshotUnavailableReason: string | null;
};

const run = async (
  args: Parameters<typeof resolvePlanAcceptanceGateVerdict>[0] = ARGS,
): Promise<Row> => (await resolvePlanAcceptanceGateVerdict(args))[0] as Row;

beforeEach(() => {
  gateSpy.mockReset();
  snapshotSpy.mockReset();
  snapshotSpy.mockResolvedValue({
    schemaVersion: 1,
    contentHash: 'snapshot-hash',
    planSlug: 'p-1',
    bars: [],
  });
});

describe('P-011 acceptance-gate read — never flatten a non-check into a pass', () => {
  it('threads the exact subject harness to both canonical readers', async () => {
    gateSpy.mockResolvedValue({ satisfied: false, code: 'acceptance_bar_contract_not_ready' });
    await run({ ...ARGS, harnessSlug: 'other-home' });
    expect(gateSpy).toHaveBeenCalledWith('p-1', expect.objectContaining({
      harnessSlug: 'other-home',
      acceptanceBarContractSnapshot: expect.any(Promise),
    }));
    expect(snapshotSpy).toHaveBeenCalledWith('p-1', {}, { harnessSlug: 'other-home' });
  });

  it('preserves the same observation repair context even when the later snapshot is unavailable', async () => {
    const repairAction = {
      kind: 'author-verdict', nextVerb: { name: 'scorecards:get', args: { issueId: 'EI-grade' } },
    };
    const acceptanceBarLifecycle = { phase: 'ship', codes: ['bar_snapshot_author_verdict_missing'] };
    gateSpy.mockResolvedValue({
      satisfied: false, code: 'acceptance_not_recorded', gradingRef: 'EI-grade',
      repairAction, acceptanceBarLifecycle,
    });
    snapshotSpy.mockRejectedValue(new Error('later snapshot unavailable'));
    expect(await run()).toMatchObject({
      code: 'acceptance_not_recorded', gradingRef: 'EI-grade', repairAction, acceptanceBarLifecycle,
      acceptanceBarContractSnapshotUnavailableReason: 'later snapshot unavailable',
    });
  });

  it('asks the gate about the plan it was given', async () => {
    gateSpy.mockResolvedValue({ satisfied: true });
    await run();
    expect(gateSpy).toHaveBeenCalledWith('p-1', expect.objectContaining({
      acceptanceBarContractSnapshot: expect.any(Promise),
    }));
    expect(snapshotSpy).toHaveBeenCalledWith('p-1');
  });

  it('threads one current proof cohort to both the verdict and explainability snapshot', async () => {
    const current = [
      {
        evidenceKind: 'test' as const,
        evidenceRef: 'testing-run:current#R-1',
        sourceFingerprint: 'source-current',
        testFingerprint: 'test-current',
      },
    ];
    gateSpy.mockResolvedValue({ satisfied: true });

    await run({ ...ARGS, current });

    expect(gateSpy).toHaveBeenCalledWith('p-1', expect.objectContaining({
      current,
      acceptanceBarContractSnapshot: expect.any(Promise),
    }));
    expect(snapshotSpy).toHaveBeenCalledWith('p-1', {}, { current });
  });

  it('shares one in-flight BAR snapshot with the gate instead of rereading it', async () => {
    const snapshot = {
      schemaVersion: 1,
      contentHash: 'shared-snapshot',
      planSlug: 'p-1',
      bars: [],
    };
    snapshotSpy.mockResolvedValue(snapshot);
    gateSpy.mockImplementation(async (_planSlug: string, opts: {
      acceptanceBarContractSnapshot?: Promise<unknown>;
    }) => {
      expect(opts.acceptanceBarContractSnapshot).toBeInstanceOf(Promise);
      expect(await opts.acceptanceBarContractSnapshot).toBe(snapshot);
      return { satisfied: false, code: 'plan_items_unfinished' };
    });

    const row = await run();

    expect(snapshotSpy).toHaveBeenCalledTimes(1);
    expect(row.acceptanceBarContractSnapshot).toBe(snapshot);
  });

  it('carries the shared BAR snapshot without re-deriving or summarizing it', async () => {
    gateSpy.mockResolvedValue({ satisfied: false, code: 'plan_items_unfinished' });
    const snapshot = {
      schemaVersion: 1,
      contentHash: 'snapshot-hash',
      planSlug: 'p-1',
      bars: [{ barKey: 'R-1', readiness: { state: 'blocked', codes: ['bar_snapshot_method_missing'] } }],
    };
    snapshotSpy.mockResolvedValue(snapshot);

    const row = await run();

    expect(row.acceptanceBarContractSnapshot).toBe(snapshot);
    expect(row.acceptanceBarContractSnapshotUnavailableReason).toBeNull();
    expect(row.code).toBe('plan_items_unfinished');
  });

  it('carries the gate build provenance into the read row', async () => {
    const buildProvenance = { sha: 'gate-sha', version: '1.2.3' };
    gateSpy.mockResolvedValue({ satisfied: false, code: 'plan_items_unfinished', buildProvenance });

    expect((await run()).buildProvenance).toEqual(buildProvenance);
  });

  it('keeps the real gate verdict when only snapshot explainability is unavailable', async () => {
    gateSpy.mockResolvedValue({ satisfied: false, code: 'acceptance_ungraded' });
    snapshotSpy.mockRejectedValue(new Error('snapshot read down'));

    const row = await run();

    expect(row.code).toBe('acceptance_ungraded');
    expect(row.unavailableReason).toBeNull();
    expect(row.acceptanceBarContractSnapshot).toBeNull();
    expect(row.acceptanceBarContractSnapshotUnavailableReason).toBe('snapshot read down');
  });

  it('carries `skipped` through even though the gate reports satisfied', async () => {
    // The dangerous shape: satisfied:true, but nothing was actually checked.
    gateSpy.mockResolvedValue({ satisfied: true, skipped: 'flag-off' });

    const row = await run();

    expect(row.satisfied).toBe(true);
    expect(row.skipped).toBe('flag-off');
  });

  it.each(['flag-off', 'rubric-template-plan', 'template-instance'] as const)(
    'preserves skip reason %s rather than collapsing it to a boolean',
    async (reason) => {
      gateSpy.mockResolvedValue({ satisfied: true, skipped: reason });
      expect((await run()).skipped).toBe(reason);
    },
  );

  it('surfaces a forcedPast waiver AND its reason on an otherwise-green verdict', async () => {
    gateSpy.mockResolvedValue({
      satisfied: true,
      forcedPast: { reason: 'release window', checks: ['code-truth', 'spec-coverage'] },
    });

    const row = await run();

    expect(row.satisfied).toBe(true);
    expect(row.forcedPast).toEqual({
      reason: 'release window',
      checks: ['code-truth', 'spec-coverage'],
    });
  });

  it('copies forcedPast.checks instead of aliasing the gate’s array', async () => {
    const checks = ['code-truth'];
    gateSpy.mockResolvedValue({ satisfied: true, forcedPast: { reason: 'r', checks } });

    const row = await run();
    checks.push('mutated-after-the-fact');

    expect(row.forcedPast?.checks).toEqual(['code-truth']);
  });

  it('surfaces vettedUnderWaiver, including a null reason, on a green verdict', async () => {
    gateSpy.mockResolvedValue({
      satisfied: true,
      vettedUnderWaiver: { consultId: 'c-9', reason: null },
    });

    const row = await run();

    expect(row.satisfied).toBe(true);
    expect(row.vettedUnderWaiver).toEqual({ consultId: 'c-9', reason: null });
  });

  it('renders the refusal message verbatim, not summarized', async () => {
    const message = 'Plan p-1 is not graded by an INDEPENDENT reviewer; author grades do not count.';
    gateSpy.mockResolvedValue({ satisfied: false, code: 'rubric-not-graded', message, rubricId: 'RB-1' });

    const row = await run();

    expect(row.message).toBe(message);
    expect(row.code).toBe('rubric-not-graded');
    expect(row.rubricId).toBe('RB-1');
  });

  it('reports the rubric ROLE and the independent grader when the gate is satisfied', async () => {
    gateSpy.mockResolvedValue({ satisfied: true, rubricId: 'RB-1', gradedBy: 'su-peer' });

    const row = await run();

    expect(row.rubricId).toBe('RB-1');
    expect(row.gradedBy).toBe('su-peer');
  });

  it('carries authoritative UNKNOWN criterion keys and copies the array', async () => {
    const unknownRatedCriteria = ['central-outcome'];
    gateSpy.mockResolvedValue({ satisfied: true, unknownRatedCriteria });

    const row = await run();
    unknownRatedCriteria.push('mutated-after-the-fact');

    expect(row.unknownRatedCriteria).toEqual(['central-outcome']);
  });
});

describe('P-011 acceptance-gate read — fails CLOSED (opposite polarity to the census)', () => {
  it('reports NOT satisfied when the gate module cannot be run', async () => {
    gateSpy.mockRejectedValue(new Error('module gone'));

    const row = await run();

    // The gate never throws by contract, so reaching here is "could not verify" — which
    // must never render as the green that a failing-open resolver would produce.
    expect(row.satisfied).toBe(false);
    expect(row.unavailableReason).toBe('resolver-unavailable');
    expect(row.buildProvenance).toEqual(getBuildInfo());
    expect(row.message).toContain('could not be evaluated');
    expect(row.acceptanceBarContractSnapshot).toBeNull();
  });

  it('does not invent a refusal CODE out of a read failure', async () => {
    gateSpy.mockRejectedValue(new Error('module gone'));
    const row = await run();

    // Unsatisfied, but with no code: "could not verify" is not the same as "check X failed",
    // and a renderer must not be handed a blocker name that no check produced.
    expect(row.code).toBeNull();
    expect(row.skipped).toBeNull();
  });

  it('marks a real verdict with unavailableReason null, so the two are distinguishable', async () => {
    gateSpy.mockResolvedValue({ satisfied: false, code: 'items-incomplete' });
    expect((await run()).unavailableReason).toBeNull();
  });
});

describe('D-019 permanent negative control — coverage cannot be derived from this verdict', () => {
  /**
   * The forbidden "simplification": drop `plans.specCoverage` and read coverage off the
   * acceptance-gate verdict. Below is a gate verdict that refused in the ITEM family, i.e.
   * BEFORE the census ever ran — the single most common real refusal.
   */
  const shortCircuitedVerdict = {
    satisfied: false,
    code: 'items-incomplete',
    message: '2 plan items are not complete.',
    // NOTE: no `specCoverage` key at all — the gate returned before computing it.
  } as { satisfied: boolean; code: string; specCoverage?: { unproven: number } };

  it('a panel deriving coverage from the gate verdict goes BLIND on a short-circuited refusal', () => {
    const derived = shortCircuitedVerdict.specCoverage;

    // Not "zero unproven clauses" — no census happened at all. A renderer that treated
    // this as the coverage picture would show a clean coverage panel for a plan whose
    // clauses were never examined.
    expect(derived).toBeUndefined();
    expect(derived?.unproven).toBeUndefined();
  });

  it('the resolver therefore exposes NO coverage field of its own', async () => {
    gateSpy.mockResolvedValue(shortCircuitedVerdict);
    const row = (await run()) as Row & Record<string, unknown>;

    // Coverage is the census query's job (D-019). If this row ever grows a coverage field,
    // the two surfaces have been merged and the short-circuit blindness above is live.
    expect(row).not.toHaveProperty('specCoverage');
    expect(row).not.toHaveProperty('coverage');
    expect(row).not.toHaveProperty('clauses');
    // ...while the blocker it DOES own is reported exactly.
    expect(row.code).toBe('items-incomplete');
  });
});
