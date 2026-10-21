/**
 * The delivery-time cell fold (state-plane-interest-and-hardening-2026-08-21 P-022 / D-007).
 *
 * Two contracts are worth a test here, and they pull against each other:
 *
 *   1. FRESHNESS — the reading must be taken at DELIVERY, not at fire time. That is the
 *      entire point of D-007: `payload.observed` is a fire-time snapshot, and the agent
 *      is woken because of it at exactly the moment it is most likely to be stale.
 *   2. NEVER DELAY THE WAKE — a wake is an interrupt. The resolvers involved were
 *      measured at p50 324ms / p95 2037ms / max 45511ms (the P-004 census), so a budget
 *      breach is the ORDINARY case, not the edge case.
 *
 * (2) is why most of this file is about degrades. Each one must still produce a block
 * that TELLS the agent the value was not re-read — never silence, because a wake with no
 * fold reads as "nothing to say about the value", and an agent reading absence as
 * reassurance is the false-all-clear this subsystem exists to refuse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getPredicateWatchMock = vi.fn();
const deriveCellRereadMock = vi.fn();
const readCellMock = vi.fn();

vi.mock('./predicate-watch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./predicate-watch')>();
  return {
    ...actual,
    getPredicateWatch: (...a: unknown[]) => getPredicateWatchMock(...a),
    deriveCellReread: (...a: unknown[]) => deriveCellRereadMock(...a),
  };
});

vi.mock('../../cell-read', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cell-read')>();
  return { ...actual, readCell: (...a: unknown[]) => readCellMock(...a) };
});

const { prepareCellWakeFold, CELL_WAKE_FOLD_BUDGET_MS } = await import('./cell-wake-fold');

const ROW = {
  id: 'w1',
  ownerId: 'su-me',
  role: 'su',
  harnessSlug: 'papercusp',
  tool: 'dev:pipeline_position',
  path: 'positions.deployed',
  args: {},
};
const HANDLE = { tool: 'state:read' as const, args: { cell: 'gate.greenCheckpoint.verdict' } };
const INPUT = { eventKey: 'predicate:w1', workspaceId: 'papercusp-workspace' };

const valueRead = (over: Record<string, unknown> = {}) => ({
  status: 'value' as const,
  cell: 'gate.greenCheckpoint.verdict',
  value: 0,
  headline: 'gate.consecutiveReds',
  resolver: 'gitPipelinePosition',
  // P-005 / D-014 — the fold renders the declared ASSESSMENT.
  assessment: {
    status: 'resolved' as const,
    path: 'assessments.gateVerdict',
    code: 'green',
    meaning: 'the last checkpoint passed and main is fast-forwarding',
    safeAction: 'Proceed; no gate repair is needed.',
    evidence: [{ path: 'verdictProvenance.mainBehindStaging', value: false }],
  },
  ...over,
});

beforeEach(() => {
  getPredicateWatchMock.mockReset().mockResolvedValue(ROW);
  deriveCellRereadMock.mockReset().mockReturnValue(HANDLE);
  readCellMock.mockReset().mockResolvedValue(valueRead());
});

describe('the healthy fold', () => {
  it('renders the delivery-time headline, a dated stamp, and the re-read handle', async () => {
    const block = await prepareCellWakeFold(INPUT);

    // Keep the declared path and measured value distinct. The old fixture set both to
    // "green", masking a renderer that printed the path while dropping `read.value`.
    expect(block).toContain('[cell] gate.greenCheckpoint.verdict');
    expect(block).toContain('measurement · gate.consecutiveReds = 0');
    expect(block).toContain('re-read at delivery');
    // The handle rides along even on the healthy path: this reading is itself a
    // snapshot, just a dated one, and the agent may act minutes from now.
    expect(block).toContain("state:read { cell: 'gate.greenCheckpoint.verdict' }");
  });

  it('carries the SUBJECT into the handle for a caller-relative cell', async () => {
    deriveCellRereadMock.mockReturnValue({
      tool: 'state:read',
      args: { cell: 'git.pipelinePosition', as: 'apps/operator/x.ts' },
    });
    readCellMock.mockResolvedValue(valueRead({ cell: 'git.pipelinePosition' }));

    const block = await prepareCellWakeFold(INPUT);

    // A handle without the subject re-answers a DIFFERENT question.
    expect(block).toContain("state:read { cell: 'git.pipelinePosition', as: 'apps/operator/x.ts' }");
  });

  it("reads with the WATCH ROW's identity — the delivery carries no role or harness", async () => {
    await prepareCellWakeFold(INPUT);

    const [, reader, env] = readCellMock.mock.calls[0];
    expect(reader).toEqual({ ownerId: 'su-me', roles: ['su'], harnessSlug: 'papercusp' });
    expect(env).toEqual({ workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', role: 'su' });
  });

  // WI-6554700010018677: a real delivery carries the coordination namespace ('default'), not
  // the reader's tenant. The watch row is stamped with the tenant at registration.
  it("reads under the WATCH ROW's tenant, not the delivery's coordination namespace", async () => {
    getPredicateWatchMock.mockResolvedValue({ ...ROW, workspaceId: 'tenant-ws' });

    await prepareCellWakeFold({ eventKey: 'predicate:w1', workspaceId: 'default' });

    const [, , env] = readCellMock.mock.calls[0];
    expect(env).toEqual({ workspaceId: 'tenant-ws', harnessSlug: 'papercusp', role: 'su' });
  });

  it('re-derives the cell from the REGISTRY at delivery time, not from the fire payload', async () => {
    await prepareCellWakeFold(INPUT);

    // Trusting a stored cell id cannot notice a rename, a re-scope, or the reader
    // leaving the audience between fire and delivery. Re-deriving can.
    expect(deriveCellRereadMock).toHaveBeenCalledWith(ROW);
  });

  it('surfaces the MATERIAL path when the cell declares one (P-021)', async () => {
    readCellMock.mockResolvedValue(valueRead({ material: { path: 'gate.red', value: 3 } }));

    const block = await prepareCellWakeFold(INPUT);

    expect(block).toContain('material · gate.red = 3');
  });

  it('renders the ASSESSMENT before the raw measurement, with its meaning and safe action', async () => {
    const block = await prepareCellWakeFold(INPUT);

    expect(block).toContain('assessment · green — the last checkpoint passed and main is fast-forwarding');
    expect(block).toContain('safe action · Proceed; no gate repair is needed.');
    expect(block).toContain('evidence · verdictProvenance.mainBehindStaging = false');

    // P-005's ORDERING claim, asserted as an ordering rather than as two memberships.
    // A wake is an interrupt: the agent acts on the first thing it reads, so the
    // meaning has to precede the number rather than merely accompany it.
    expect(block!.indexOf('assessment · green')).toBeLessThan(block!.indexOf('measurement · gate.consecutiveReds'));
  });

  it('reports DRIFTED evidence as missing, never as measured null agreement', async () => {
    readCellMock.mockResolvedValue(
      valueRead({
        assessment: {
          status: 'resolved' as const,
          path: 'assessments.gateVerdict',
          code: 'green',
          meaning: 'the last checkpoint passed',
          safeAction: 'Proceed.',
          evidence: [{ path: 'verdictProvenance.mainBehindStaging', value: null, drifted: true }],
        },
      }),
    );

    const block = await prepareCellWakeFold(INPUT);

    expect(block).toContain('registration drift');
    expect(block).toContain('ABSENT from the resolver result');
    // MISSING is not a measured null — collapsing the two is the defect this plan exists
    // to close, and rendering `= null` here would do exactly that.
    expect(block).not.toContain('mainBehindStaging = null');
  });

  it('reports DOOR-TRUNCATED evidence as unattributable, distinct from drift', async () => {
    readCellMock.mockResolvedValue(
      valueRead({
        assessment: {
          status: 'resolved' as const,
          path: 'assessments.gateVerdict',
          code: 'green',
          meaning: 'the last checkpoint passed',
          safeAction: 'Proceed.',
          evidence: [{ path: 'serving.startedSinceCodeChange', value: null, truncatedByDoor: true }],
        },
      }),
    );

    const block = await prepareCellWakeFold(INPUT);

    expect(block).toContain('TRUNCATED IN TRANSIT');
    expect(block).toContain('unattributable');
    // Truncation and drift demand OPPOSITE responses — re-read vs fix the registration —
    // so the renderer must never report one as the other.
    expect(block).not.toContain('registration drift');
  });

  it('renders an UNAVAILABLE assessment loudly and preserves the door full-read lever', async () => {
    readCellMock.mockResolvedValue(
      valueRead({
        assessment: {
          status: 'unavailable' as const,
          path: 'assessments.gateVerdict',
          code: null,
          meaning: null,
          safeAction: 'Do not treat the value below as a verdict.',
          evidence: [],
          unknown: { code: 'not-measured' as const },
          truncatedByDoor: true,
          fullRead: { tool: 'dev:pipeline_position', args: { path: 'x.ts' } },
        },
      }),
    );

    const block = await prepareCellWakeFold(INPUT);

    expect(block).toContain('UNINTERPRETED');
    expect(block).toContain('unattributable');
    expect(block).toContain('Do not treat the value below as a verdict.');
    // The door's escape hatch remains: when the payload
    // truncated ITSELF, the untruncated re-read is the one useful next move.
    expect(block).toContain('full read · {"tool":"dev:pipeline_position"');
  });

  it('hoists a NON-AUTHORITATIVE reading where it cannot be skipped', async () => {
    readCellMock.mockResolvedValue(
      valueRead({ source: { value: 'run-probe', authoritative: false, why: 'inferred from the checkout HEAD' } }),
    );

    const block = await prepareCellWakeFold(INPUT);

    expect(block).toContain('INFERRED, not observed');
    expect(block).toContain('inferred from the checkout HEAD');
  });

  it('reports UNKNOWN by its branchable code rather than omitting the block', async () => {
    readCellMock.mockResolvedValue({
      status: 'unknown',
      cell: 'gate.greenCheckpoint.verdict',
      unknown: { code: 'resolver-failed', detail: 'git rev-parse died' },
    });

    const block = await prepareCellWakeFold(INPUT);

    // The code is what the agent branches on: retry vs pointless vs supply-more-input.
    expect(block).toContain('UNKNOWN');
    expect(block).toContain('resolver-failed');
    expect(block).toContain('git rev-parse died');
  });
});

describe('degrades — the wake is never delayed and never silently unqualified', () => {
  it('BUDGET BREACH: returns promptly and says the value was NOT re-read', async () => {
    // The measured common case. Resolver never settles.
    readCellMock.mockReturnValue(new Promise(() => {}));

    const started = Date.now();
    const block = await prepareCellWakeFold({ ...INPUT, budgetMs: 40 });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(1000);
    expect(block).toContain('NOT re-read at delivery');
    expect(block).toContain('did not resolve within 40ms');
    // It must still hand over the handle — the agent's recourse.
    expect(block).toContain("state:read { cell: 'gate.greenCheckpoint.verdict' }");
    // And it must warn that what was quoted above is stale.
    expect(block).toContain('may be stale');
  });

  it('RESOLVER THROWS: same qualified block, not a crash and not silence', async () => {
    readCellMock.mockRejectedValue(new Error('boom'));

    const block = await prepareCellWakeFold(INPUT);

    expect(block).toContain('NOT re-read at delivery');
    expect(block).toContain('could not be resolved');
    expect(block).toContain("state:read { cell: 'gate.greenCheckpoint.verdict' }");
  });

  it('the two degrade reasons are DISTINGUISHABLE in the transcript', async () => {
    readCellMock.mockReturnValue(new Promise(() => {}));
    const slow = await prepareCellWakeFold({ ...INPUT, budgetMs: 20 });
    readCellMock.mockRejectedValue(new Error('boom'));
    const broken = await prepareCellWakeFold(INPUT);

    // A chronically slow resolver and a broken one need different fixes.
    expect(slow).not.toBe(broken);
    expect(slow).toContain('did not resolve within');
    expect(broken).toContain('could not be resolved');
  });
});

describe('no fold at all — the cases with genuinely nothing to say', () => {
  it('a NON-predicate wake (inbox, loop, plain await) is untouched', async () => {
    expect(await prepareCellWakeFold({ ...INPUT, eventKey: 'coord:inbox-wake:su-me' })).toBeNull();
    expect(await prepareCellWakeFold({ ...INPUT, eventKey: 'fleet:drained:x' })).toBeNull();
    // ...and it does not even look the row up.
    expect(getPredicateWatchMock).not.toHaveBeenCalled();
  });

  it("a GC'd or reaped watch row", async () => {
    getPredicateWatchMock.mockResolvedValue(null);
    expect(await prepareCellWakeFold(INPUT)).toBeNull();
  });

  it('a watch that maps to no registered cell, or a reader outside its audience', async () => {
    // deriveCellReread returns undefined for BOTH, deliberately — a hand-rolled
    // watch:create on the same (tool, path) must not learn the cell exists.
    deriveCellRereadMock.mockReturnValue(undefined);
    expect(await prepareCellWakeFold(INPUT)).toBeNull();
    expect(readCellMock).not.toHaveBeenCalled();
  });

  it('an ABSENT read stays deliberately uninformative', async () => {
    readCellMock.mockResolvedValue({ status: 'absent', cell: 'x' });
    // Never distinguish "unregistered" from "not yours", even here (P-019).
    expect(await prepareCellWakeFold(INPUT)).toBeNull();
  });

  it('a malformed predicate key', async () => {
    expect(await prepareCellWakeFold({ ...INPUT, eventKey: 'predicate:' })).toBeNull();
  });

  it('TOTAL — a throwing lookup still yields null rather than breaking the wake', async () => {
    getPredicateWatchMock.mockRejectedValue(new Error('db down'));
    await expect(prepareCellWakeFold(INPUT)).resolves.toBeNull();
  });
});

describe('the budget itself', () => {
  it("defaults well below readCell's own ~10s hung-resolver ceiling", async () => {
    // Those are different jobs: that ceiling stops a hung resolver wedging a caller;
    // this one stops a merely SLOW resolver delaying an interrupt.
    expect(CELL_WAKE_FOLD_BUDGET_MS).toBeLessThanOrEqual(2000);
    expect(CELL_WAKE_FOLD_BUDGET_MS).toBeGreaterThan(0);
  });

  it('CONTROL — a resolver inside the budget is NOT degraded', async () => {
    // Calibration: without this, every degrade assertion above would pass just as
    // happily against an implementation that degrades unconditionally.
    readCellMock.mockImplementation(() => new Promise((r) => setTimeout(() => r(valueRead()), 5)));

    const block = await prepareCellWakeFold({ ...INPUT, budgetMs: 500 });

    expect(block).not.toContain('NOT re-read at delivery');
    expect(block).toContain('measurement · gate.consecutiveReds = 0');
  });
});
