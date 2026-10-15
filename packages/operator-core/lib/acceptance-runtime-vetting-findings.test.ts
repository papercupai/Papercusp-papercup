/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-004 (R-6) — rubric vetting flags live or
 * deployed acceptance criteria that declare no evidenceRuntime, at the pure function AND at
 * the rubrics:propose / rubrics:amend tool doors.
 *
 * Split out of acceptance-runtime-citation.test.ts (which now covers only R-5, the
 * scorecards:emit citation refusal) so the two acceptance BARs can fail independently:
 * deleting the vetting finding reds THIS file and leaves the citation file green, and vice
 * versa (rubric vetting finding 2, conv-mudgleel-0000-af1706371867402784aa32370e52411d).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runtimeVettingFindings } from './acceptance-runtime-citation';

const mocks = vi.hoisted(() => ({
  proposeRubric: vi.fn(),
  amendRubric: vi.fn(),
  previewAcceptanceBarAmendment: vi.fn(),
  rubricCompleteness: vi.fn(),
}));

vi.mock('./agent-tools/coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'vetting-test' }) }));
vi.mock('./rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rubrics')>();
  return {
    ...actual,
    proposeRubric: mocks.proposeRubric,
    // P-005: rubrics:propose/amend read the stored revision for instrument grandfathering.
    getRubric: async () => null,
    amendRubric: mocks.amendRubric,
    previewAcceptanceBarAmendment: mocks.previewAcceptanceBarAmendment,
    rubricCompleteness: mocks.rubricCompleteness,
  };
});
vi.mock('./rubrics-replication-sql', () => ({
  validateRubricReplicationSql: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('./detached-imports', () => ({
  trackDetached: () => Promise.resolve({ notifySyncInvalidate: vi.fn() }),
}));
// rubrics:amend reserves a shared Postgres receipt (RSR-P-008-C) before it runs; that
// store has its own integration test (amend-receipts.integration.test.ts). Here it is a
// pass-through so the unit test measures the vetting finding, not the receipt table.
vi.mock('./agent-tools/rubrics/amend-receipts', () => ({
  trackAmendRun: (_key: string, _ref: string, run: () => Promise<Record<string, unknown>>) => run(),
}));

import proposeTool from './agent-tools/rubrics/propose';
import amendTool from './agent-tools/rubrics/amend';

const BG_PATH = 'packages/operator-core/lib/harness/routines/psu-pty-host-events-ingest.ts';

type ToolOutput = { content: Array<{ text: string }> };
// rubrics:amend answers with a structured `{ data }` root (receipt-bearing, since a5462cbbf9);
// rubrics:propose still answers with the MCP `content[]` envelope. Read either, as amend.test.ts does.
const parse = (result: unknown) => {
  if (result && typeof result === 'object' && 'data' in result) return (result as { data: Record<string, any> }).data;
  return JSON.parse((result as ToolOutput).content[0]!.text);
};

/** A complete acceptance BAR on the live plane, optionally carrying a declared runtime. */
const liveCriterion = (evidenceRuntime?: 'staging-operator') => ({
  key: 'r-1',
  title: 'The ingest routine reads correctly on its runtime',
  model: 'The ingest routine reports a measured build identity.',
  bar: 'The ingest routine reports a measured build identity.',
  method: `Call dev:pipeline_position for ${BG_PATH} on the runtime and record servingRuntimes.`,
  driftMarkers: 'The runtime entry is missing or its containment is unknown.',
  barKey: 'R-1',
  role: 'outcome' as const,
  mandatory: true,
  requiredScope: ['live'],
  evidencePlane: 'live' as const,
  passRatings: ['healthy'],
  check: { kind: 'instrument' as const, instrumentKey: 'none' },
  ...(evidenceRuntime ? { evidenceRuntime } : {}),
});

const storedRubric = (criteria: unknown[]) => ({
  rubricId: 'acceptance-example',
  kind: 'acceptance',
  subjectPlan: 'example-plan',
  characteristic: 'example',
  title: 'Example acceptance',
  criteria,
  description: '',
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: null,
  status: 'active',
  createdBy: null,
  proposedBy: 'vetting-test',
  ratifiedBy: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rubricCompleteness.mockReturnValue({ complete: true });
});

describe('runtimeVettingFindings — the finding itself', () => {
  it('flags every live/deployed criterion without evidenceRuntime, and nothing else', () => {
    const findings = runtimeVettingFindings([
      { key: 'r-1', barKey: 'R-1', evidencePlane: 'live', method: `census from ${BG_PATH}` },
      { key: 'r-2', barKey: 'R-2', evidencePlane: 'deployed', method: 'eyeball the dashboard' },
      { key: 'r-3', barKey: 'R-3', evidencePlane: 'live', evidenceRuntime: 'staging-operator' },
      { key: 'r-4', barKey: 'R-4', evidencePlane: 'tree' },
    ]);
    expect(findings.map((f) => f.barKey)).toEqual(['R-1', 'R-2']);
    expect(findings[0]!.finding).toMatch(/inferred bg-host/);
    expect(findings[1]!.finding).toMatch(/default to :3070 and wait on main/);
    expect(findings[1]!.resolution.runtime).toBeNull();
  });
});

describe('rubrics:propose returns the runtime vetting finding', () => {
  it('a live acceptance BAR with no evidenceRuntime comes back with runtimeFindings naming it', async () => {
    const criterion = liveCriterion();
    mocks.proposeRubric.mockResolvedValue(storedRubric([criterion]));

    const parsed = parse(
      await proposeTool.handler(
        {
          rubricRef: 'acceptance-example',
          kind: 'acceptance',
          subjectPlan: 'example-plan',
          characteristic: 'example',
          title: 'Example acceptance',
          criteria: [criterion],
        } as never,
        {} as never,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.runtimeFindings?.map((f: { barKey: string }) => f.barKey)).toEqual(['R-1']);
  });

  it('the same BAR with a declared evidenceRuntime carries no runtimeFindings', async () => {
    const criterion = liveCriterion('staging-operator');
    mocks.proposeRubric.mockResolvedValue(storedRubric([criterion]));

    const parsed = parse(
      await proposeTool.handler(
        {
          rubricRef: 'acceptance-example',
          kind: 'acceptance',
          subjectPlan: 'example-plan',
          characteristic: 'example',
          title: 'Example acceptance',
          criteria: [criterion],
        } as never,
        {} as never,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.runtimeFindings).toBeUndefined();
  });
});

describe('rubrics:amend returns the runtime vetting finding', () => {
  it('an amendment leaving a live BAR without evidenceRuntime comes back with runtimeFindings naming it', async () => {
    const criterion = liveCriterion();
    mocks.amendRubric.mockResolvedValue(storedRubric([criterion]));

    const parsed = parse(
      await amendTool.handler(
        { rubricRef: 'acceptance-example', criteria: [criterion], reason: 'Refresh the live procedure.' } as never,
        {} as never,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.runtimeFindings?.map((f: { barKey: string }) => f.barKey)).toEqual(['R-1']);
  });

  it('an amendment that declares evidenceRuntime clears the finding', async () => {
    const criterion = liveCriterion('staging-operator');
    mocks.amendRubric.mockResolvedValue(storedRubric([criterion]));

    const parsed = parse(
      await amendTool.handler(
        { rubricRef: 'acceptance-example', criteria: [criterion], reason: 'Declare the evidence runtime.' } as never,
        {} as never,
      ),
    );

    expect(parsed.ok).toBe(true);
    expect(parsed.runtimeFindings).toBeUndefined();
  });
});
