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
}));
vi.mock('../../verification-attempts/loop-gate', () => ({ loopLaunchRefusal: phases.gate }));
vi.mock('./mutation-probe-fence', () => ({ mutationProbeRefusal: phases.fence }));
// The restricted-write fence (WI-10005634) reads the fence module's closure exports, which the
// factory above omits; it has its own suite (restricted-hold-fence.test.ts).
vi.mock('./restricted-hold-fence', () => ({ restrictedHoldRefusal: vi.fn(async () => null) }));
vi.mock('../capability/bash-task-provenance', async (original) => ({
  ...(await original<typeof import('../capability/bash-task-provenance')>()),
  resolveBashTaskProvenance: phases.provenance,
}));
vi.mock('./evidence', async (original) => ({
  ...(await original<typeof import('./evidence')>()),
  prepareTestEvidence: phases.prepare,
  finishTestEvidence: phases.finish,
  retractRefusedTestEvidence: phases.retract,
}));

import { BashProvenanceRefusal } from '../capability/bash-task-provenance';
import runTool from './run';

const roots: string[] = [];
afterEach(async () => {
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
