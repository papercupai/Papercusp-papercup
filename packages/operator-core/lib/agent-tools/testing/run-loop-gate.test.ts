import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// WI-10004175 / expensive-verification-loops P-002: testing:run launches detached runs that
// the attempt ledger counts per work-item, but it never consulted the loop gate, so a grinding
// item could keep launching slow test runs that capability:bash and release:cut would refuse.
const phases = vi.hoisted(() => ({
  gate: vi.fn(),
  fence: vi.fn(),
  prepare: vi.fn(),
  finish: vi.fn(),
  retract: vi.fn(),
  provenance: vi.fn(),
  detach: vi.fn(),
}));
vi.mock('../../testing-run-store', async (original) => ({
  ...(await original<typeof import('../../testing-run-store')>()), startRunDurable: phases.detach,
}));
vi.mock('../../verification-attempts/loop-gate', () => ({ loopLaunchRefusal: phases.gate }));
vi.mock('./mutation-probe-fence', () => ({ mutationProbeRefusal: phases.fence }));
// The restricted-write fence (WI-10005634) reads the fence module's closure exports, which the
// factory above omits; it has its own suite (restricted-hold-fence.test.ts).
vi.mock('./restricted-hold-fence', () => ({ restrictedHoldRefusal: vi.fn(async () => null) }));
vi.mock('../capability/bash-task-provenance', () => ({
  BashProvenanceRefusal: class extends Error {
    constructor(public code: string, message: string) { super(message); }
  },
  resolveBashTaskProvenance: phases.provenance,
}));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  prepareTestEvidence: phases.prepare,
  finishTestEvidence: phases.finish,
  retractRefusedTestEvidence: phases.retract,
}));

import { BashProvenanceRefusal } from '../capability/bash-task-provenance';
import runTool, { testingRunAbortCompletionReceipt } from './run';

const roots: string[] = [];
afterEach(async () => {
  const directories = phases.detach.mock.calls.flatMap(([request]) =>
    (request.detachedReportArtifacts ?? []).map((artifact: { reportPath: string }) => join(artifact.reportPath, '..')));
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })));
  Object.values(phases).forEach((mock) => mock.mockReset());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function invoke(extra: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'testing-run-loop-gate-'));
  roots.push(root);
  await mkdir(join(root, '.git'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, workspaces: [] }));
  await writeFile(join(root, 'vitest.config.ts'), 'export default {};\n');
  await writeFile(join(root, 'feature.test.ts'), "import { it } from 'vitest';\nit('noop', () => {});\n");
  const evidence = { workItemId: 'WI-grinding', planSlug: 'gate-plan', bindings: [{
    specId: 'SPEC-001', specRevision: 1, testPath: 'feature.test.ts', sourcePaths: ['feature.ts'], testLayer: 'unit' as const,
  }] };
  const ctx = { projectDir: root, workspaceId: 'gate-workspace', uiClientId: 'su-gate-test', isSuperuser: true } as const;
  const args = runTool.args.parse({ files: ['feature.test.ts'], harness: 'gate-harness', evidence, ...extra });
  const result = (await runTool.handler(args, ctx as never)) as { data: Record<string, unknown> };
  return { root, result: result.data };
}

const refusal = {
  ok: false as const,
  reason: 'loop_audit_required' as const,
  work_item_id: 'WI-grinding',
  triggers: ['distinct-failures'],
  fingerprints: ['exit:aaa', 'log:bbb'],
  message: 'loop_audit_required — WI-grinding is grinding',
};

it('starts one caller-bound background core, retaining pending evidence and the full budget', async () => {
  phases.gate.mockResolvedValue(null);
  phases.fence.mockResolvedValue(null);
  phases.prepare.mockResolvedValue([{}]);
  phases.detach.mockResolvedValue({ snapshot: { runId: 'direct-background', taskId: 'task-direct' }, durable: true });
  const before = Date.now();
  const { root, result } = await invoke({ background: true, timeoutMs: 120_000,
    privatePg: false, maxFailures: 7, reporterStageTrace: true, testNamePattern: 'focused case' });
  expect(phases.gate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ background: true, timeoutMs: 120_000 }));
  expect(phases.detach).toHaveBeenCalledTimes(1);
  const request = phases.detach.mock.calls[0]![0];
  expect(request).toMatchObject({ command: process.execPath, cwd: root, originRunId: result.runId,
    env: { PAPERCUSP_TEST_RUN_HARNESS: 'gate-harness', PAPERCUSP_WORKSPACE_ID: 'gate-workspace' } });
  const script = request.args.at(-1) as string;
  expect(script).toContain('runTestFilesCore');
  expect(script).toContain('"allowDetachedRecovery":false');
  expect(script).toContain('"privatePg":false');
  expect(script).toContain('"maxFailures":7');
  expect(script).toContain('"testNamePattern":"focused case"');
  expect(result).toMatchObject({ ok: true, mode: 'background', status: 'pending',
    detachedRunId: 'direct-background', detachedDurable: true, taskId: 'task-direct',
    evidenceBundle: { status: 'incomplete', verificationFingerprint: null, rows: [{ phase: 'pending', outcome: 'unknown' }],
      recovery: { args: { recoverEvidence: { originRunId: result.runId, runId: 'direct-background' } } } } });
  expect((result.deadline as { taskDeadlineAtMs: number }).taskDeadlineAtMs).toBeGreaterThanOrEqual(before + 120_000);
  expect(phases.prepare).toHaveBeenCalledOnce();
  expect(phases.finish).not.toHaveBeenCalled();
  expect(result).not.toHaveProperty('passed');
  expect(testingRunAbortCompletionReceipt({}, { data: result } as never, {} as never)).toMatchObject({
    status: 'recorded', diagnostics: { outcome: 'pending' },
  });
  expect(testingRunAbortCompletionReceipt({}, { data: { ...result, detachedDurable: false } } as never, {} as never))
    .toMatchObject({ status: 'recovery-incomplete' });
});

it.each(['changedPaths', 'recoverEvidence', 'remeasureEvidence', 'nativeConsult', 'securityQualification'])(
  'refuses background mixed with %s before any preparation or launch', async selector => {
    const { data: result } = await runTool.handler({ background: true, [selector]: {} } as never, {} as never) as
      { data: Record<string, unknown> };
    expect(result).toMatchObject({ ok: false, error: 'mutually_exclusive_selectors' });
    expect(phases.prepare).not.toHaveBeenCalled();
    expect(phases.detach).not.toHaveBeenCalled();
  });

it('refuses a grinding item before any evidence is registered or any test process starts', async () => {
  phases.gate.mockResolvedValue(refusal);

  const { root, result } = await invoke();

  expect(result).toMatchObject({ ok: false, reason: 'loop_audit_required', work_item_id: 'WI-grinding', root });
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.fence).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('asks the gate about the named work item with the REQUESTED budget, not the foreground clamp', async () => {
  // Default budget: the detached run may outlive the clamp, so it is a slow attempt.
  phases.gate.mockResolvedValue(refusal);
  await invoke();
  expect(phases.gate).toHaveBeenCalledExactlyOnceWith({
    workspaceId: 'gate-workspace',
    workItemId: 'WI-grinding',
    background: false,
    timeoutMs: 300_000,
  });

  // An explicit short budget is passed through, so the gate can let an audit's quick check run.
  phases.gate.mockReset();
  phases.gate.mockResolvedValue(refusal);
  await invoke({ timeoutMs: 60_000 });
  expect(phases.gate).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
});

it('attributes the slow-run gate to the explicitly named item instead of a stale WI goal stamp', async () => {
  phases.provenance.mockImplementation(async (_ctx, _harness, _deps, options) => ({
    launchedBy: 'su-gate-test',
    sessionId: 'su-gate-test',
    harnessSlug: 'gate-harness',
    workItemId: options?.explicitWorkItemId ?? 'WI-10004353',
    planSlug: null,
    goalRef: 'WI-10004353',
  }));
  const namedRefusal = {
    ...refusal,
    work_item_id: 'WI-10004437',
    message: 'loop_audit_required — WI-10004437 is grinding',
  };
  phases.gate.mockResolvedValue(namedRefusal);

  const { result } = await invoke({ evidence: undefined, work_item_id: 'WI-10004437' });

  expect(result).toMatchObject({ ok: false, reason: 'loop_audit_required', work_item_id: 'WI-10004437' });
  expect(phases.provenance).toHaveBeenCalledWith(
    expect.objectContaining({ uiClientId: 'su-gate-test' }),
    'gate-harness',
    undefined,
    { explicitWorkItemId: 'WI-10004437' },
  );
  expect(phases.gate).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'WI-10004437' }));
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});

it('returns a held-claim refusal before the loop gate when the named item is not held', async () => {
  phases.provenance.mockRejectedValue(
    new BashProvenanceRefusal('work_item_not_held', "work_item_id 'WI-not-held' is not one of your held work-items."),
  );

  const { result } = await invoke({ evidence: undefined, work_item_id: 'WI-not-held' });

  expect(result).toMatchObject({ ok: false, error: 'work_item_not_held' });
  expect(phases.gate).not.toHaveBeenCalled();
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.fence).not.toHaveBeenCalled();
});

it('rejects an explicit work item that conflicts with the evidence attribution', async () => {
  const { result } = await invoke({ work_item_id: 'WI-explicit' });

  expect(result).toMatchObject({ ok: false, error: 'work_item_id_conflicts_with_evidence' });
  expect(phases.provenance).not.toHaveBeenCalled();
  expect(phases.gate).not.toHaveBeenCalled();
  expect(phases.prepare).not.toHaveBeenCalled();
  expect(phases.finish).not.toHaveBeenCalled();
});
