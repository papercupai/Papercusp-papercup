/**
 * bash-desktop-env.test.ts — computer-tool-plan Gap C: capability:bash binds DISPLAY to
 * the calling hive's leased sandbox desktop, so a bee can LAUNCH GUI apps (`firefox &`)
 * on the desktop it then drives via capability:computer. Resolution is per-caller from
 * ctx.harnessSlug (the handler runs in the operator process, not the bee). Runs the real
 * shell (no mocks) through the injectable provisioner seam (no live Xvfb).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const provenanceFixture = vi.hoisted(() => ({
  readHeldWorkItems: vi.fn(async () => []),
}));
// Authenticated callers still use the real provenance policy. This fixture has
// no live work-item claims, so its reader must not consult production Postgres.
vi.mock('../../carry-brief', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../carry-brief')>()),
  readHeldWorkItems: provenanceFixture.readHeldWorkItems,
}));
// This suite exercises DISPLAY leasing, NOT the exec-sandbox. capability:bash resolves
// the papercusp-capability-exec-sandbox flag at spawn (bash.ts → capabilityExecSandboxEnabled),
// and when the flag reads ON but the host has no sandbox binary (bubblewrap absent — e.g. a
// headless VM / CI runner / packaged install), bash-jobs.ts console.warns "running unsandboxed",
// which vitest-fail-on-console turns into a failure. Whether the flag reads on/off is ambient
// (flag-store state), so leaving it unpinned made this suite pass or fail by host. Pin it OFF —
// the no-sandbox path is exactly what these DISPLAY tests intend — so the suite is hermetic
// regardless of flag state or sandbox availability.
vi.mock('./exec-sandbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec-sandbox')>()),
  capabilityExecSandboxEnabled: vi.fn(async () => false),
}));

import bashTool from './bash';
import { resolveBashTaskProvenance } from './bash-task-provenance';
import { __resetBashJobs } from './bash-jobs';
import {
  ensureHiveDesktop,
  releaseAllHiveDesktops,
  __setProvisionerForTests,
  __resetProvisioner,
} from '../computer/desktop-lease';
import { NO_GL_STRATEGY } from '../../desktop/gl-strategy';

type Tool = { handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
const bash = bashTool as unknown as Tool;
const STATE = mkdtempSync(join(tmpdir(), 'cap-bash-disp-'));

let savedDisplay: string | undefined;
let savedPapercuspSid: string | undefined;

function makeCtx(harnessSlug?: string, over: Record<string, unknown> = {}) {
  return {
    projectDir: STATE,
    stateDir: STATE,
    harnessSlug,
    signal: new AbortController().signal,
    emit: () => {},
    role: 'cup',
    ...over,
  } as never;
}

function fakeLease(display: string) {
  __setProvisionerForTests(async () => ({
    display,
    number: Number(display.slice(1)),
    width: 1024,
    height: 768,
    // No live X server here, so no GL was measured — the honest zero value.
    gl: NO_GL_STRATEGY,
    // WI-1223202: nothing was probed at all here, so it was certainly not probed inside a
    // sandbox. `false` is the honest value, not a placeholder.
    glProbeSandboxed: false,
    xServer: 'xvfb',
    // P-005: a fixture enrols nothing in the task ledger — the honest
    // "unenrolled" value.
    taskId: null,
    // WI-1105361: no apps are launched here, so the honest diagnostic set is
    // empty. Added to the fixture rather than made optional on SandboxDesktop —
    // the field is required so a desktop cannot silently under-report a failed
    // app launch.
    appDiagnostics: () => [],
    release: async () => {},
  }));
}

describe('capability:bash — DISPLAY from the hive desktop lease (Gap C)', () => {
  beforeEach(() => {
    provenanceFixture.readHeldWorkItems.mockClear();
    savedDisplay = process.env.DISPLAY;
    savedPapercuspSid = process.env.PAPERCUSP_SID;
    process.env.DISPLAY = ':5'; // a sentinel host-seat value: proves the lease overrides it, and that it is otherwise stripped
    process.env.PAPERCUSP_SID = 'operator-process-sid';
  });
  afterEach(async () => {
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
    if (savedPapercuspSid === undefined) delete process.env.PAPERCUSP_SID;
    else process.env.PAPERCUSP_SID = savedPapercuspSid;
    await releaseAllHiveDesktops();
    __resetProvisioner();
    __resetBashJobs();
  });

  it('binds DISPLAY to the caller hive lease (overriding the inherited value)', async () => {
    fakeLease(':222');
    await ensureHiveDesktop('demo-hive');
    const r = await bash.handler({ command: 'echo "D=[$DISPLAY]"' }, makeCtx('demo-hive'));
    expect(r.content[0].text).toContain('D=[:222]'); // the leased sandbox display, not :5
  });

  it('strips the inherited host display when the caller hive has no desktop (no seat leak)', async () => {
    const r = await bash.handler({ command: 'echo "D=[$DISPLAY]"' }, makeCtx('no-desktop-hive'));
    // 2026-06-19 keystroke-leak fix: bash-jobs' stripHostX removes the inherited host
    // DISPLAY (:5 here standing in for the host seat :0), so with no lease there is NO
    // DISPLAY — the bee shell can never inherit the operator's X session.
    expect(r.content[0].text).toContain('D=[]');
  });

  it('strips the inherited host display when there is no harnessSlug on the ctx', async () => {
    fakeLease(':223');
    await ensureHiveDesktop('some-hive'); // a lease exists, but this caller is not in that hive
    const r = await bash.handler({ command: 'echo "D=[$DISPLAY]"' }, makeCtx(undefined));
    // No ctx.harnessSlug → no lease lookup → no DISPLAY bound; the inherited host seat
    // (:5) is stripped, never passed through.
    expect(r.content[0].text).toContain('D=[]');
  });

  it("binds the resolved caller's PAPERCUSP_SID instead of the operator process identity", async () => {
    const callerSid = 'su-caller-session';
    const r = await bash.handler(
      { command: 'printf "SID=[%s]" "$PAPERCUSP_SID"' },
      makeCtx(undefined, { isSuperuser: true, uiClientId: callerSid }),
    );

    expect(r.content[0].text).toContain(`SID=[${callerSid}]`);
    expect(r.content[0].text).not.toContain('operator-process-sid');
    expect(provenanceFixture.readHeldWorkItems).toHaveBeenCalledWith(
      callerSid, '', { limit: 2 },
    );
  });
});

describe('capability:bash — durable task provenance', () => {
  it('stamps the stable caller and its live work-item goal', async () => {
    const resolveGoal = vi.fn();
    const result = await resolveBashTaskProvenance({ uiClientId: 'su-owner', isSuperuser: true }, 'papercusp', {
      resolveIdentity: (() => ({ ownerId: 'su-owner' })) as never,
      readStamp: (() => ({ intentEventId: 1, assumptionSetId: null, goalRef: 'EI-21192501620501693' })) as never,
      resolveGoal,
      // A declared goal is only a CANDIDATE: the resolver links it after the live
      // held-claim read confirms the caller still holds it (bash-task-provenance.ts).
      readHeldWorkItems: (async () => [{ id: 'EI-21192501620501693' }]) as never,
    });

    expect(result).toEqual({
      launchedBy: 'su-owner',
      sessionId: 'su-owner',
      harnessSlug: 'papercusp',
      workItemId: 'EI-21192501620501693',
      planSlug: null,
      goalRef: 'EI-21192501620501693',
    });
    expect(resolveGoal).not.toHaveBeenCalled();
  });

  it('falls back to the durable goal resolver and preserves a plan-item provenance ref', async () => {
    const result = await resolveBashTaskProvenance({ uiClientId: 'su-owner', isSuperuser: true }, 'papercusp', {
      resolveIdentity: (() => ({ ownerId: 'su-owner' })) as never,
      readStamp: (() => ({ intentEventId: null, assumptionSetId: null, goalRef: null })) as never,
      resolveGoal: (async () => ({ ref: 'plan:host-pressure-hardening#P-014' })) as never,
      readHeldWorkItems: (async () => []) as never,
    });

    expect(result).toMatchObject({
      launchedBy: 'su-owner',
      sessionId: 'su-owner',
      workItemId: null,
      planSlug: 'host-pressure-hardening',
      goalRef: 'plan:host-pressure-hardening#P-014',
    });
  });

  it('fails open without fabricating an item when caller identity is unavailable', async () => {
    const result = await resolveBashTaskProvenance(
      { principal: { kind: 'system', slug: 'system:operator', workspaceId: 'papercusp-workspace' } },
      null,
      {
        resolveIdentity: (() => {
          throw new Error('missing session identity');
        }) as never,
        readStamp: vi.fn() as never,
        resolveGoal: vi.fn() as never,
        readHeldWorkItems: (async () => []) as never,
      },
    );

    expect(result).toEqual({
      launchedBy: 'system:operator',
      sessionId: null,
      harnessSlug: null,
      workItemId: null,
      planSlug: null,
      goalRef: null,
    });
  });
});
