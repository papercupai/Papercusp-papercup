/**
 * R-8 BAR file (plan bug-inflow-one-problem-one-row-2026-10-18, P-009, D-008):
 * one regression test per top structural tool-error class by 7-day volume,
 * each failing on the pre-fix code.
 *
 * CENSUS PIN (D-023, which supersedes D-013's rank 2): window 2026-10-13T06:00Z ..
 * 2026-10-20T06:00Z, workspace papercusp-workspace, status <> 'ok', the production
 * tool-error classifier, tools:invoke unwrapped to the inner tool it dispatched;
 * output sha256 fcc7d2b5818beb9914bcec4d60621ed53f6f4e7a372c966a271f64f559defb29.
 * Rank → class → describe block below:
 *   1 session:request-compaction no_live_pty_host 1931
 *   2 capability:read read_failed 448
 *   3 capability:bash_output job_process_gone 344
 *   4 capability:read evidence_not_selectable 288
 *   5 capability:launch-agent handler_refusal 145 (5a and 5b)
 *
 * Class map (census 2026-10-20, WI-6554700010017610 checkpoint):
 *   - capability:read read_failed ENOENT on a result-door spill: the caller
 *     retyped the cursor by hand (run-id character, workspace segment, or the
 *     retired ~/.papercup root) while the real spill was on disk. Fix:
 *     scratch-path-recovery.ts + read-handler returns scratch_path_mistyped with
 *     the exact did_you_mean cursor, classified caller.
 *   - capability:read evidence_not_selectable / content_not_selectable
 *     "scratch reference payload is not JSON": the result-door writes a
 *     Markdown prefix followed by the JSON body (bodyOffsetInPayload); the
 *     pre-fix reader parsed the whole payload as JSON. Fix (staging since
 *     577d230455): select from the declared body offset.
 *   - capability:bash_output job_process_gone: the job's in-memory handle was
 *     lost, the task ledger recorded `exited` with a real exit code, and the
 *     pre-fix branch reported every non-zero exit as a tool error (~200 of ~240
 *     in 7 days were exit 1/2 test and typecheck runs). Fix: bash_output.ts
 *     ledgerRecordedCommandExit — a recorded exit reads like the live path
 *     (status + exit_code), with the live path's dead-typecheck verdict.
 *   - session:request-compaction no_live_pty_host (1,934/7d, 93% from 3 owners
 *     retired by fleet:kill:pc-admin-coord-ui on 2026-10-15): the deployed
 *     build predated the retirement fence, so each work-item:claimable wake
 *     resume-headless'd a killed owner whose over-limit transcript then asked
 *     to self-compact with no host. The refusal itself is correct. Fix (staging
 *     since 32ed5dd2b9, WI-6554700010010429): executeWake drops a wake for a
 *     retired owner before any resume channel claims or spawns.
 *   - capability:launch-agent handler_refusal (D-008 tie at #5; 90 of 104
 *     watchdog rows were "source session is still LIVE"): the compaction
 *     watchdog dispatched an identity-preserving successor for a live source
 *     and launch-agent correctly refused it. Fix: compaction-force-successor.ts
 *     reconcileHostlessSource refuses a live source before the launch-agent
 *     dispatch, so no refusal row is minted.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskRow } from '../../task-manager/types';
import { executeWake, type ExecuteWakeDeps } from '../../events/await/wake-executor';
import { MultiSessionTestbed, advSessionHandle, makeDelivery } from '../../../test/_multi-session-testbed';

// Class-5a seam: hand compaction-force-successor a stand-in launch-agent tool and
// count projected dispatches. Both wrappers pass through to the real exports
// unless a test opts in, so a mock reset in another suite cannot break them.
const forceSuccessorSeam = vi.hoisted(() => ({ tool: null as unknown, dispatched: 0 }));
vi.mock('@papercusp/agent-mcp', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/agent-mcp')>();
  const lookupByMcpName = ((...args: Parameters<typeof real.lookupByMcpName>) =>
    forceSuccessorSeam.tool && args[0] === 'capability:launch-agent'
      ? forceSuccessorSeam.tool
      : real.lookupByMcpName(...args)) as typeof real.lookupByMcpName;
  return { ...real, lookupByMcpName };
});
vi.mock('@papercusp/tooldef-mcp', async (importOriginal) => {
  const real = await importOriginal<typeof import('@papercusp/tooldef-mcp')>();
  const dispatchProjectedToolToMcp = ((...args: Parameters<typeof real.dispatchProjectedToolToMcp>) => {
    forceSuccessorSeam.dispatched++;
    return real.dispatchProjectedToolToMcp(...args);
  }) as typeof real.dispatchProjectedToolToMcp;
  return { ...real, dispatchProjectedToolToMcp };
});

const ledger = vi.hoisted(() => ({ getTask: vi.fn(), getTaskByBashJobId: vi.fn() }));
const registry = vi.hoisted(() => ({ getJob: vi.fn(), startBackground: vi.fn() }));
// Only the two lookups the recovery path consults are replaced; every other export stays real.
vi.mock('../../task-manager/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../task-manager/store')>()),
  getTask: ledger.getTask,
  getTaskByBashJobId: ledger.getTaskByBashJobId,
}));
vi.mock('../../agent-tools/capability/bash-jobs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent-tools/capability/bash-jobs')>()),
  getJob: registry.getJob,
  startBackground: registry.startBackground,
}));

import bashOutputTool from '../../agent-tools/capability/bash_output';
import readTool from '../../agent-tools/capability/read';
import { mkNonRepoTmpDir } from '../../agent-tools/locks/non-repo-tmpdir';
import { writeScratchReference } from '../../scratch-reference';
import { findMistypedScratchSpill, parseScratchSpillAddress } from '../../scratch-path-recovery';
import { classifyToolError } from './tool-error-classifier';

const ROOT = mkNonRepoTmpDir('top-tool-error-fixes-');
const SCRATCH = join(ROOT, 'scratch');
const WS = 'ws-r8';
const TOOL = 'work_items:get';
const RUN = 'c3986847-b504-46c0-be5d-a3d6367ad1ed';
const BASENAME = 'result-door-1792444057973.md';
const SPILL = join(SCRATCH, WS, TOOL, RUN, BASENAME);
const PREFIX = '# result-door spill — the text as it reached this door\n\n';
const BODY = JSON.stringify({ ok: true, results: [{ id: 'EI-1', workItem: { id: 'EI-1', state: 'open' } }] });

const ctx = {
  projectDir: ROOT,
  stateDir: ROOT,
  workspaceId: WS,
  signal: new AbortController().signal,
  emit: () => {},
  progress: () => {},
  log: () => {},
} as never;

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };
const parse = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;
const read = async (args: Record<string, unknown>) => (await readTool.handler!(args as never, ctx)) as ToolResult;

let previousScratchRoot: string | undefined;
beforeAll(() => {
  previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
  process.env.PAPERCUSP_SCRATCH_ROOT = SCRATCH;
  mkdirSync(join(SCRATCH, WS, TOOL, RUN), { recursive: true });
  // The real result-door shape: text/plain, a Markdown prefix, then the JSON
  // body at bodyOffsetInPayload, with work-item evidence pointers into it.
  writeScratchReference({
    filePath: SPILL,
    payload: `${PREFIX}${BODY}`,
    workspaceId: WS,
    mediaType: 'text/plain',
    content: [{ index: 0, type: 'text', byteCount: Buffer.byteLength(BODY) }],
    evidence: [{ evidenceClass: 'work-item', contentIndex: 0, jsonPointers: ['/results/0/workItem'] }],
    bodyOffsetInPayload: Buffer.byteLength(PREFIX),
  });
});
afterAll(() => {
  if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
  else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
  rmSync(ROOT, { recursive: true, force: true });
});

describe('D-023 rank 2 (capability:read read_failed, 448): ENOENT on a hand-retyped result-door cursor', () => {
  it('a changed run-id character returns scratch_path_mistyped with the exact cursor, and the cursor reads', async () => {
    const typo = join(SCRATCH, WS, TOOL, 'c3986847-b504-46ca-9db5-a3d6367ad1ed', BASENAME);
    const refused = await read({ file_path: typo, byte_offset: 0, byte_limit: 64 });
    expect(refused.isError).toBe(true);
    const body = parse(refused);
    expect(body).toMatchObject({
      ok: false,
      reason: 'scratch_path_mistyped',
      did_you_mean: { tool: 'capability:read', args: { file_path: SPILL, byte_offset: 0, byte_limit: 64 } },
    });
    const retried = await read((body.did_you_mean as { args: Record<string, unknown> }).args);
    expect(retried.isError).not.toBe(true);
  });

  it('a wrong workspace segment in a scratch URI is recovered under the caller’s uri key', async () => {
    const uri = `papercusp://scratch/papercupai-workspace/${TOOL}/${RUN}/${BASENAME}`;
    const body = parse(await read({ uri, evidence_class: 'work-item' }));
    expect(body).toMatchObject({
      reason: 'scratch_path_mistyped',
      did_you_mean: { args: { uri: `papercusp://scratch/${WS}/${TOOL}/${RUN}/${BASENAME}`, evidence_class: 'work-item' } },
    });
  });

  it('the retired ~/.papercup root resolves to the spill under the current scratch root', async () => {
    const recovered = await findMistypedScratchSpill(join(ROOT, '.papercup', 'scratch', WS, TOOL, RUN, BASENAME));
    expect(recovered?.path).toBe(SPILL);
  });

  it('never guesses between two candidates, and a genuinely missing spill stays read_failed', async () => {
    const twinRun = 'c3986847-b504-46c0-be5d-a3d6367ad1ee';
    const twinBase = 'result-door-1792444099999.md';
    for (const run of [RUN, twinRun]) {
      mkdirSync(join(SCRATCH, WS, TOOL, run), { recursive: true });
      writeScratchReference({ filePath: join(SCRATCH, WS, TOOL, run, twinBase), payload: 'x', workspaceId: WS, mediaType: 'text/plain' });
    }
    const ambiguous = parse(await read({ file_path: join(SCRATCH, WS, TOOL, 'c3986847-b504-46c0-be5d-000000000000', twinBase) }));
    expect(ambiguous.reason).toBe('read_failed');
    const missing = parse(await read({ file_path: join(SCRATCH, WS, TOOL, RUN, 'result-door-1000000000000.md') }));
    expect(missing.reason).toBe('read_failed');
  });

  it('only result-door spill addresses inside a scratch root are recovered', () => {
    expect(parseScratchSpillAddress(`${SCRATCH}/${WS}/${TOOL}/${RUN}/notes.md`)).toBeNull();
    expect(parseScratchSpillAddress(`${SCRATCH}/${WS}/${TOOL}/../${BASENAME}`)).toBeNull();
    expect(parseScratchSpillAddress(`/etc/${WS}/${TOOL}/${RUN}/${BASENAME}`)).toBeNull();
  });

  it('the recovery refusal is counted as a caller error, not a structural defect', () => {
    expect(classifyToolError('scratch_path_mistyped', 'refused', 'does not exist, but a saved result with the same name exists')).toBe('caller');
  });
});

describe('D-023 rank 4 (capability:read evidence_not_selectable, 288): evidence selection on a Markdown-prefixed JSON spill', () => {
  it('evidence_class reads the declared JSON body instead of refusing "payload is not JSON"', async () => {
    const selected = await read({ file_path: SPILL, evidence_class: 'work-item' });
    expect(selected.isError).not.toBe(true);
    expect(parse(selected)).toMatchObject({
      ok: true,
      evidence: [{ contentIndex: 0, jsonPointer: '/results/0/workItem', value: { id: 'EI-1', state: 'open' } }],
    });
  });
});

describe('D-023 rank 3 (capability:bash_output job_process_gone, 344): a ledger-recorded exit', () => {
  type ToolResultish = { content: Array<{ text: string }>; isError?: boolean };
  const bashOutput = bashOutputTool as unknown as {
    handler: (args: unknown, ctx: unknown) => Promise<ToolResultish>;
  };
  const JOBS = join(ROOT, 'jobs');

  beforeAll(() => mkdirSync(JOBS, { recursive: true }));
  beforeEach(() => {
    vi.clearAllMocks();
    // The worker lost its in-memory handle — the only state the shape depends on.
    registry.getJob.mockReturnValue(null);
  });

  function endedTask(name: string, command: string, log: string, overrides: Partial<TaskRow> = {}): TaskRow {
    const logPath = join(JOBS, `${name}.log`);
    writeFileSync(logPath, log);
    return {
      taskId: `task-${name}`,
      workspaceId: WS,
      rootTaskId: `task-${name}`,
      class: 'bash-job',
      title: name,
      argv: ['bash', '-o', 'pipefail', '-c', command],
      confined: true,
      scopeUnit: `pc-task-${name}.scope`,
      cgroupPath: `/papercusp.slice/pc-task-${name}.scope`,
      state: 'exited',
      exitCode: 1,
      startedAt: new Date(0).toISOString(),
      lastSeenAt: new Date(0).toISOString(),
      launchedBy: 'su-r8',
      logPath,
      detail: { bashJobId: `bash-${name}` },
      pid: null,
      processIdentity: null,
      ...overrides,
    };
  }

  async function readEnded(row: TaskRow) {
    ledger.getTask.mockResolvedValue(row);
    const result = await bashOutput.handler(
      { task_id: row.taskId },
      { workspaceId: WS, stateDir: JOBS, signal: new AbortController().signal, emit: () => {}, role: 'cup' },
    );
    return { result, payload: JSON.parse(result.content[0]!.text) as Record<string, unknown> };
  }

  it('a red test run (exited/1) reads as status failed + exit_code 1, not a job_process_gone tool error', async () => {
    const { result, payload } = await readEnded(
      endedTask('red-vitest', 'npx vitest run a.test.ts', 'FAIL a.test.ts > adds\nTests  1 failed (1)\n'),
    );
    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({ ok: true, status: 'failed', exit_code: 1, running: false, recovered_from_ledger: true });
    expect(payload).not.toHaveProperty('reason');
    expect(String(payload.output)).toContain('Tests  1 failed');
    expect(registry.startBackground).not.toHaveBeenCalled();
  });

  it('tsc exiting 2 WITH diagnostics is a real typecheck result, not a dead run', async () => {
    const { result, payload } = await readEnded(
      endedTask(
        'tsc-errors',
        'npx tsc --noEmit -p packages/x',
        "packages/x/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
        { exitCode: 2 },
      ),
    );
    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({ ok: true, status: 'failed', exit_code: 2 });
    expect(payload).not.toHaveProperty('typecheck_verdict');
    expect(payload).not.toHaveProperty('reason');
  });

  it('tsc dying out of heap with no diagnostics still reads as an error — the live path’s verdict, applied on recovery', async () => {
    const { result, payload } = await readEnded(
      endedTask(
        'tsc-oom',
        'npx tsc --noEmit -p packages/x',
        'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory\n',
        { exitCode: 134 },
      ),
    );
    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ status: 'failed', exit_code: 134, typecheck_verdict: 'typecheck_died_out_of_memory' });
    expect(payload).not.toHaveProperty('reason', 'job_process_gone');
  });

  it('a process that vanished with no recorded exit stays job_process_gone', async () => {
    const { result, payload } = await readEnded(
      endedTask('vanished', 'npx vitest run a.test.ts', 'RUN a.test.ts\n', { state: 'stranded', exitCode: null }),
    );
    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({ ok: false, reason: 'job_process_gone' });
  });

  it('the handle-less ledger recovery path (no bashJobId) applies the same rule', async () => {
    const { result, payload } = await readEnded(
      endedTask('no-handle', 'npx vitest run a.test.ts', 'Tests  2 failed (5)\n', { detail: {} }),
    );
    expect(result.isError).toBeUndefined();
    expect(payload).toMatchObject({ ok: true, status: 'failed', exit_code: 1, recovered_from_ledger: true });
  });
});

describe('D-023 rank 1 (session:request-compaction no_live_pty_host, 1931): retired owners', () => {
  let tb: MultiSessionTestbed;
  let provDir: string;
  let prevProvDir: string | undefined;
  beforeEach(() => {
    prevProvDir = process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
    provDir = mkdtempSync(join(tmpdir(), 'top-err-prov-'));
    process.env.PAPERCUSP_TURN_PROVENANCE_DIR = provDir;
    tb = MultiSessionTestbed.create();
  });
  afterEach(async () => {
    if (prevProvDir === undefined) delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
    else process.env.PAPERCUSP_TURN_PROVENANCE_DIR = prevProvDir;
    rmSync(provDir, { recursive: true, force: true });
    await tb.destroy();
  });

  it('a claimable-event wake for a fleet-killed codex owner is dropped before any resume claim or spawn', async () => {
    const s = tb.session('retired-codex');
    let spawned = 0;
    let claimed = 0;
    const raw: ExecuteWakeDeps = {
      findPsuHost: tb.findPsuHostDep(),
      getSession: async () => ({
        pid: null, endedAt: null, retiredAt: '2026-10-15T20:01:25.851Z', retiredBy: 'fleet:kill:pc-admin-coord-ui',
        agent: 'codex', sessionId: 'native-retired-codex', coordOwnerId: s.ownerId, cwd: s.cwd,
      }) as never,
      findPty: () => null,
      write: () => true,
      presence: async () => null,
      alive: () => false,
      spawnDetached: () => { spawned++; return 4242; },
      sendCoordMessage: async () => ({}) as never,
      claimResume: async () => { claimed++; return true; },
      accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
    };
    const d = makeDelivery({
      subscriberId: s.ownerId,
      wakeHandle: advSessionHandle(s, { agent: 'codex', sessionId: 'native-retired-codex', pid: null }),
    });

    const out = await executeWake(d, { ...raw, ...tb.ownerElectionDeps(raw) });

    expect(out).toMatchObject({ kind: 'drop', reason: expect.stringContaining('retired by deliberate kill') });
    expect(claimed).toBe(0);
    expect(spawned).toBe(0);
  });
});

describe('D-023 rank 5 (capability:launch-agent handler_refusal, 145), 5a: a live compaction source', () => {
  afterEach(() => {
    forceSuccessorSeam.tool = null;
    forceSuccessorSeam.dispatched = 0;
  });

  it('the watchdog force-successor refuses a live source locally and never dispatches launch-agent', async () => {
    forceSuccessorSeam.tool = { name: 'capability:launch-agent' };
    const { dispatchCompactionForceSuccessor } = await import('../../system-health/compaction-force-successor');

    const res = await dispatchCompactionForceSuccessor({
      brief: 'over-limit recovery',
      target: {
        ownerId: 'su-live-source', workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp',
        advSessionId: 33944, live: true, endedAt: null, endedBy: null, display: 'console', headless: true,
        pid: 4242, binding: { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp' },
      } as never,
    });

    expect(res).toMatchObject({ verified: false, detail: expect.stringContaining('still live') });
    expect(forceSuccessorSeam.dispatched).toBe(0);
  });
});
