/**
 * EI-2826 regression: the doc-freshness sweep used to broadcast ONE coord message per
 * drifted doc to `*` — a single substantive commit could fire 50+ in seconds, burying
 * directed peer messages in every agent's inbox. The fix coalesces a sweep into ONE
 * digest line. These tests pin the pure digest builder (the sweep orchestration around it
 * is best-effort PG/git glue; the COALESCING — N drifted docs → exactly one message — is
 * the behavior that matters and is fully captured here).
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';
const syncPolicy = vi.hoisted(() => ({ allowed: vi.fn(), workspace: vi.fn(), observed: vi.fn(async (_scope, invoke) => invoke()) }));
vi.mock('../../device-operator-actions', async original => ({
  ...(await original<object>()), workspaceBackgroundActivityAllowed: syncPolicy.allowed,
}));
vi.mock('../../startup-activity', async original => ({
  ...(await original<object>()), runObservedBackgroundActivity: syncPolicy.observed,
}));
vi.mock('../workspace-for-harness', async original => ({
  ...(await original<object>()), resolveWorkspaceForHarness: syncPolicy.workspace,
}));
import { drainDetached } from '../../detached-imports';
import {
  buildDocDriftDigest,
  DOC_DRIFT_DIGEST_MAX_NAMED,
  enqueueDocFreshnessSweepAfterSync,
  runDocFreshnessSweepAfterSync,
  type SweepAfterSyncInput,
} from './sweep-after-sync';
import type { DriftedDoc } from './doc-steward-dispatch';
import { startupActivityFeatureId } from '../../schedule-inventory';

describe('post-sync execution admission', () => {
  beforeEach(() => {
    syncPolicy.allowed.mockReset().mockResolvedValue(true);
    syncPolicy.workspace.mockReset().mockResolvedValue('resolved-workspace');
    syncPolicy.observed.mockClear();
  });

  it('uses the resolved workspace and observes only the admitted sync callback', async () => {
    await expect(runDocFreshnessSweepAfterSync({ harnessSlug: 'h', workspaceId: 'requested', repoRoot: null })).resolves.toBeNull();
    const featureId = startupActivityFeatureId({ source: 'in-process', installSlug: null,
      name: 'doc-freshness-sweep', detail: {} }, { workspaceId: 'resolved-workspace' });
    expect(syncPolicy.allowed).toHaveBeenCalledWith('resolved-workspace', featureId);
    expect(syncPolicy.observed).toHaveBeenCalledWith({ workspaceId: 'resolved-workspace', featureId,
      source: 'sync', trigger: 'sync' }, expect.any(Function));
  });

  it('withholds paused queued work after async workspace resolution', async () => {
    syncPolicy.workspace.mockImplementationOnce(async () => {
      syncPolicy.allowed.mockResolvedValue(false);
      return 'resolved-workspace';
    });
    await expect(runDocFreshnessSweepAfterSync({ harnessSlug: 'h', workspaceId: 'requested', repoRoot: null })).resolves.toBeNull();
    expect(syncPolicy.allowed).toHaveBeenCalledOnce();
    expect(syncPolicy.observed).not.toHaveBeenCalled();
  });

  it('never executes or records an unresolved workspace', async () => {
    syncPolicy.workspace.mockRejectedValueOnce(new Error('workspace unavailable'));
    await expect(runDocFreshnessSweepAfterSync({ harnessSlug: 'h', workspaceId: 'requested', repoRoot: null })).rejects.toThrow('workspace unavailable');
    expect(syncPolicy.allowed).not.toHaveBeenCalled();
    expect(syncPolicy.observed).not.toHaveBeenCalled();
  });
});

const doc = (docId: string, source: string): DriftedDoc => ({
  docId,
  anchorPaths: [],
  reason: 'subject code changed',
  source,
});

describe('buildDocDriftDigest (EI-2826 — coalesce the per-doc doc-drift flood)', () => {
  it('returns null when nothing drifted (→ send no message at all)', () => {
    expect(buildDocDriftDigest('papercusp', [])).toBeNull();
  });

  it('a single manual doc → one digest that names it as RE-VERIFY, no "+more"', () => {
    const d = buildDocDriftDigest('papercusp', [doc('agent-insights/foo.mdx', 'manual')]);
    expect(d).not.toBeNull();
    expect(d).toContain('papercusp');
    expect(d).toContain('1 doc(s) drifted');
    expect(d).toContain('1 manual need RE-VERIFY');
    expect(d).toContain('agent-insights/foo.mdx');
    expect(d).not.toContain('more)');
    expect(d).not.toContain('regen'); // no generated docs in this batch
  });

  it('splits manual (re-verify) vs generated/augmented (regen) in ONE message', () => {
    const d = buildDocDriftDigest('papercusp', [
      doc('a.mdx', 'manual'),
      doc('b.mdx', 'manual'),
      doc('c.mdx', 'generated'),
      doc('d.mdx', 'augmented'), // augmented routes to regen (status 'stale'), not re-verify
    ]);
    expect(d).toContain('4 doc(s) drifted');
    expect(d).toContain('2 manual need RE-VERIFY');
    expect(d).toContain('2 generated STALE → regen enqueued');
  });

  it('caps the inline names at DOC_DRIFT_DIGEST_MAX_NAMED and folds the rest into "+N more"', () => {
    const n = DOC_DRIFT_DIGEST_MAX_NAMED + 5;
    const docs = Array.from({ length: n }, (_, i) => doc(`d${i}.mdx`, 'manual'));
    const d = buildDocDriftDigest('papercusp', docs)!;
    expect(d).toContain(`${n} doc(s) drifted`);
    expect(d).toContain('d0.mdx');
    expect(d).toContain(`d${DOC_DRIFT_DIGEST_MAX_NAMED - 1}.mdx`); // last named
    expect(d).not.toContain(`d${DOC_DRIFT_DIGEST_MAX_NAMED}.mdx`); // first folded
    expect(d).toContain(`(+5 more)`);
  });

  it('a batch of any size collapses to exactly ONE string — the whole point (no per-doc flood)', () => {
    const docs = Array.from({ length: 50 }, (_, i) => doc(`doc${i}.mdx`, i % 2 ? 'manual' : 'generated'));
    const d = buildDocDriftDigest('papercusp', docs);
    expect(typeof d).toBe('string');
    expect(d).toContain('50 doc(s) drifted');
  });
});

describe('enqueueDocFreshnessSweepAfterSync (EI-21343916898736862)', () => {
  it('returns without awaiting a slow corpus sweep and runs only one copy at a time', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: SweepAfterSyncInput[] = [];
    const run = vi.fn(async (input: SweepAfterSyncInput) => {
      seen.push(input);
      if (seen.length === 1) await firstBlocked;
      return null;
    });
    const base = {
      harnessSlug: 'queue-does-not-gate-git-sync',
      workspaceId: 'ws-test',
      repoRoot: '/repo',
    };

    expect(enqueueDocFreshnessSweepAfterSync({ ...base, prevSha: 'a', headSha: 'b' }, { run })).toBeUndefined();
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    enqueueDocFreshnessSweepAfterSync({ ...base, prevSha: 'b', headSha: 'c' }, { run });
    enqueueDocFreshnessSweepAfterSync({ ...base, prevSha: 'c', headSha: 'd' }, { run });
    expect(run).toHaveBeenCalledTimes(1);

    releaseFirst();
    await drainDetached();
    expect(run).toHaveBeenCalledTimes(2);
    expect(seen[1]).toMatchObject({ prevSha: 'b', headSha: 'd' });
  });

  it('falls back to a full recompute when queued ranges are discontinuous', async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const seen: SweepAfterSyncInput[] = [];
    const run = vi.fn(async (input: SweepAfterSyncInput) => {
      seen.push(input);
      if (seen.length === 1) await firstBlocked;
      return null;
    });
    const base = {
      harnessSlug: 'queue-discontinuous-range',
      workspaceId: 'ws-test',
      repoRoot: '/repo',
    };

    enqueueDocFreshnessSweepAfterSync({ ...base, prevSha: 'a', headSha: 'b' }, { run });
    await Promise.resolve();
    enqueueDocFreshnessSweepAfterSync({ ...base, prevSha: 'x', headSha: 'y' }, { run });
    enqueueDocFreshnessSweepAfterSync({ ...base, prevSha: 'y', headSha: 'z' }, { run });
    releaseFirst();
    await drainDetached();

    expect(run).toHaveBeenCalledTimes(2);
    expect(seen[1]).toMatchObject({ headSha: 'z' });
    expect(seen[1]?.prevSha).toBeUndefined();
  });
});
