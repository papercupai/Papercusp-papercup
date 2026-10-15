import { beforeEach, describe, expect, it, vi } from 'vitest';

// jev-memory-timeouts-to-zero-2026-10-01: the completion-settlement reconciler
// forked git from bg-host's ~4 GB main process ~8 times a second (~54 ms of
// frozen event loop each). Bounded reads now opt into the spawner sidecar.
// These tests pin the routing contract of `streamGitFields({ preferSidecar })`.
const sidecar = vi.hoisted(() => ({
  enabled: true,
  run: vi.fn(),
  fallbacks: [] as string[],
}));

vi.mock('../../fleet/git-via-sidecar', () => ({
  gitSidecarEnabled: () => sidecar.enabled,
  runGitViaSpawnerSidecar: sidecar.run,
  noteSidecarFallback: (subsystem: string) => {
    sidecar.fallbacks.push(subsystem);
  },
  isSidecarInfrastructureFault: (res: { code: number; stderr: string }) =>
    res.code === -1 && res.stderr.startsWith('spawner sidecar '),
}));

const { streamGitFields } = await import('./untouched-paths');

function collect(args: string[], opts: Parameters<typeof streamGitFields>[2]) {
  const fields: string[] = [];
  return streamGitFields(args, (f) => {
    fields.push(f);
  }, opts).then((outcome) => ({ outcome, fields }));
}

beforeEach(() => {
  sidecar.enabled = true;
  sidecar.run.mockReset();
  sidecar.fallbacks.length = 0;
});

describe('streamGitFields — preferSidecar routing', () => {
  it('runs a preferSidecar read in the sidecar and replays its NUL fields in order', async () => {
    sidecar.run.mockResolvedValue({ code: 0, stdout: 'a\0b\0tail', stderr: '' });
    const r = await collect(['-C', '/repo', 'ls-tree', '-z', 'HEAD'], { preferSidecar: true });
    expect(r).toEqual({ outcome: 'complete', fields: ['a', 'b', 'tail'] });
    expect(sidecar.run).toHaveBeenCalledOnce();
    expect(sidecar.run.mock.calls[0]![0]).toEqual(['-C', '/repo', 'ls-tree', '-z', 'HEAD']);
  });

  it('honours an early stop from onField', async () => {
    sidecar.run.mockResolvedValue({ code: 0, stdout: 'first\0second\0', stderr: '' });
    const seen: string[] = [];
    const outcome = await streamGitFields(['log'], (f) => {
      seen.push(f);
      return true;
    }, { preferSidecar: true });
    expect(outcome).toBe('complete');
    expect(seen).toEqual(['first']);
  });

  it("reports a non-zero exit as 'failed', not as an empty success", async () => {
    sidecar.run.mockResolvedValue({ code: 128, stdout: '', stderr: 'fatal: bad object' });
    expect((await collect(['ls-tree', 'nope'], { preferSidecar: true })).outcome).toBe('failed');
  });

  it('falls back to a local git spawn, counted, when the sidecar is unreachable', async () => {
    sidecar.run.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await collect(['--version'], { preferSidecar: true });
    expect(r.outcome).toBe('complete');
    expect(r.fields.join('')).toMatch(/^git version /);
    expect(sidecar.fallbacks).toEqual(['completion-freshness']);
  });

  it("falls back on the sidecar's own infrastructure fault rather than reporting it as git's answer", async () => {
    sidecar.run.mockResolvedValue({ code: -1, stdout: '', stderr: 'spawner sidecar admission refused' });
    const r = await collect(['--version'], { preferSidecar: true });
    expect(r.fields.join('')).toMatch(/^git version /);
    expect(sidecar.fallbacks).toEqual(['completion-freshness']);
  });

  it('never routes a read that did not opt in, or a host without a sidecar', async () => {
    expect((await collect(['--version'], {})).fields.join('')).toMatch(/^git version /);
    sidecar.enabled = false;
    expect((await collect(['--version'], { preferSidecar: true })).fields.join('')).toMatch(/^git version /);
    expect(sidecar.run).not.toHaveBeenCalled();
  });
});

// WI-10005340: completionHeadBlobMap is the settlement reconciler's MAIN per-row
// lookup. The two sibling reads above were routed on 2026-10-01 but this one was
// not, and it stayed the largest source of bg-host main-thread forks (178 of ~236
// in a 300 s trace). Pin it behaviourally: every ls-tree it issues reaches the
// sidecar, and none falls through to a local fork.
describe('completionHeadBlobMap — reconciler lookup runs in the sidecar', () => {
  const SHA = 'a'.repeat(40);
  const BLOB = 'b'.repeat(40);

  it('resolves a committed path through ONE sidecar ls-tree, never a local fork', async () => {
    const { completionHeadBlobMap } = await import('./completion-freshness');
    sidecar.run.mockResolvedValue({ code: 0, stdout: `100644 blob ${BLOB}\tapps/x.ts\0`, stderr: '' });

    const map = await completionHeadBlobMap('/repo', SHA, ['apps/x.ts']);

    expect(map?.get('apps/x.ts')).toEqual({ status: 'resolved', sha: BLOB });
    expect(sidecar.run).toHaveBeenCalledOnce();
    expect(sidecar.run.mock.calls[0]![0]).toEqual(['-C', '/repo', 'ls-tree', '-r', '-z', SHA, '--', 'apps/x.ts']);
    expect(sidecar.fallbacks).toEqual([]);
  });

  it('routes the gitlink-prefix read for a MISSING path to the sidecar too', async () => {
    const { completionHeadBlobMap } = await import('./completion-freshness');
    sidecar.run.mockResolvedValue({ code: 0, stdout: '', stderr: '' });

    const map = await completionHeadBlobMap('/repo', SHA, ['apps/gone.ts']);

    expect(map?.get('apps/gone.ts')).toEqual({ status: 'absent' });
    expect(sidecar.run.mock.calls.map((c) => c[0])).toEqual([
      ['-C', '/repo', 'ls-tree', '-r', '-z', SHA, '--', 'apps/gone.ts'],
      ['-C', '/repo', 'ls-tree', '-z', SHA, '--', 'apps'],
    ]);
    expect(sidecar.fallbacks).toEqual([]);
  });
});
