/**
 * WI-4332: gym-cycle ephemeral PG testcontainers have no crash-safe cleanup — a
 * self-heal sweep at the start of each gym-cycle entry point reclaims containers
 * a crashed prior run left behind before Ryuk could reap them (Ryuk itself can be
 * restarted, losing memory of anything it was tracking before).
 *
 * These tests mock `node:child_process.execFile` (the sweep's only IO) so they run
 * with zero Docker dependency, asserting the three safety properties that matter:
 *   1. the shared `.withReuse()` container (carries `org.testcontainers.container-hash`)
 *      is NEVER touched, regardless of age;
 *   2. a container younger than `maxAgeMs` (could be a live in-flight run) is left alone;
 *   3. only a container that is BOTH un-hashed AND old enough gets force-removed.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const execFileMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFileMock as any)(...args),
}));

// Imported AFTER the mock so the module under test picks up the mocked execFile.
const { sweepOrphanedGymPgContainers } = await import('./gym-pg-orphan-sweep');

const IMAGE = 'pgvector/pgvector:pg18';

/** Wires execFileMock's `docker ps` / `docker inspect` / `docker rm` calls in order. */
function wireDocker(opts: {
  psIds: string[];
  inspectEntries?: Array<{ Id: string; Created: string; Labels?: Record<string, string> }>;
  rmShouldFail?: (id: string) => boolean;
}) {
  execFileMock.mockImplementation((cmd: string, args: string[], cb: (err: unknown, res: { stdout: string; stderr: string }) => void) => {
    if (cmd !== 'docker') throw new Error(`unexpected cmd: ${cmd}`);
    if (args[0] === 'ps') {
      cb(null, { stdout: opts.psIds.join('\n') + (opts.psIds.length ? '\n' : ''), stderr: '' });
      return;
    }
    if (args[0] === 'inspect') {
      const ids = args.slice(1);
      const entries = (opts.inspectEntries ?? []).filter((e) => ids.includes(e.Id)).map((e) => ({
        Id: e.Id,
        Created: e.Created,
        Config: { Labels: e.Labels ?? {} },
      }));
      cb(null, { stdout: JSON.stringify(entries), stderr: '' });
      return;
    }
    if (args[0] === 'rm') {
      const id = args[args.length - 1];
      if (opts.rmShouldFail?.(id)) {
        cb(new Error(`rm failed for ${id}`), { stdout: '', stderr: '' });
        return;
      }
      cb(null, { stdout: id, stderr: '' });
      return;
    }
    throw new Error(`unexpected docker subcommand: ${args[0]}`);
  });
}

beforeEach(() => {
  execFileMock.mockReset();
});

describe('sweepOrphanedGymPgContainers', () => {
  it('never touches the shared .withReuse() container (container-hash label present), regardless of age', async () => {
    const OLD = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(); // 5h old
    wireDocker({
      psIds: ['reused123'],
      inspectEntries: [
        { Id: 'reused123', Created: OLD, Labels: { 'org.testcontainers': 'true', 'org.testcontainers.container-hash': 'abc123' } },
      ],
    });
    const result = await sweepOrphanedGymPgContainers({ image: IMAGE });
    expect(result.swept).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('leaves a young un-hashed container alone (could be a live in-flight gym run)', async () => {
    const YOUNG = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5min old
    wireDocker({
      psIds: ['young123'],
      inspectEntries: [
        { Id: 'young123', Created: YOUNG, Labels: { 'org.testcontainers': 'true' } },
      ],
    });
    const result = await sweepOrphanedGymPgContainers({ image: IMAGE, maxAgeMs: 2 * 60 * 60 * 1000 });
    expect(result.swept).toEqual([]);
  });

  it('force-removes an un-hashed container older than maxAgeMs (the orphan case)', async () => {
    const OLD = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString(); // 20h old
    wireDocker({
      psIds: ['orphan123'],
      inspectEntries: [
        { Id: 'orphan123', Created: OLD, Labels: { 'org.testcontainers': 'true' } },
      ],
    });
    const result = await sweepOrphanedGymPgContainers({ image: IMAGE, maxAgeMs: 2 * 60 * 60 * 1000 });
    expect(result.swept).toEqual(['orphan123']);
    expect(result.errors).toEqual([]);
    // docker rm -f -v was actually invoked with the container id. `-v` is load-bearing:
    // without it the container's anonymous PG data volume is left dangling on the root
    // disk (WI-6554700010008551 — ~41 GB of leaked volumes starved the release gate).
    const rmCall = execFileMock.mock.calls.find((c) => c[1]?.[0] === 'rm');
    expect(rmCall?.[1]).toEqual(['rm', '-f', '-v', 'orphan123']);
  });

  it('mixed set: sweeps only the old un-hashed one, skips the young one and the reused one', async () => {
    const OLD = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const YOUNG = new Date(Date.now() - 60 * 1000).toISOString();
    wireDocker({
      psIds: ['orphan-old', 'orphan-young', 'reused'],
      inspectEntries: [
        { Id: 'orphan-old', Created: OLD, Labels: { 'org.testcontainers': 'true' } },
        { Id: 'orphan-young', Created: YOUNG, Labels: { 'org.testcontainers': 'true' } },
        { Id: 'reused', Created: OLD, Labels: { 'org.testcontainers': 'true', 'org.testcontainers.container-hash': 'xyz' } },
      ],
    });
    const result = await sweepOrphanedGymPgContainers({ image: IMAGE, maxAgeMs: 2 * 60 * 60 * 1000 });
    expect(result.swept).toEqual(['orphan-old']);
  });

  it('is best-effort: a docker ps failure never throws, just reports an error', async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], cb: (err: unknown, res: unknown) => void) => {
      cb(new Error('docker daemon unreachable'), { stdout: '', stderr: '' });
    });
    const result = await expect(sweepOrphanedGymPgContainers({ image: IMAGE })).resolves.toBeDefined();
    const res = await sweepOrphanedGymPgContainers({ image: IMAGE });
    expect(res.swept).toEqual([]);
    expect(res.errors.length).toBeGreaterThan(0);
  });

  it('is best-effort: a single failed rm is reported but does not throw or block others', async () => {
    const OLD = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    wireDocker({
      psIds: ['bad-orphan', 'good-orphan'],
      inspectEntries: [
        { Id: 'bad-orphan', Created: OLD, Labels: { 'org.testcontainers': 'true' } },
        { Id: 'good-orphan', Created: OLD, Labels: { 'org.testcontainers': 'true' } },
      ],
      rmShouldFail: (id) => id === 'bad-orphan',
    });
    const result = await sweepOrphanedGymPgContainers({ image: IMAGE, maxAgeMs: 2 * 60 * 60 * 1000 });
    expect(result.swept).toEqual(['good-orphan']);
    expect(result.errors).toEqual([{ id: 'bad-orphan', error: expect.stringContaining('rm failed for bad-orphan') }]);
  });

  it('no candidates at all → no-op, no docker inspect/rm calls', async () => {
    wireDocker({ psIds: [] });
    const result = await sweepOrphanedGymPgContainers({ image: IMAGE });
    expect(result).toEqual({ swept: [], errors: [] });
    expect(execFileMock.mock.calls.some((c) => c[1]?.[0] === 'inspect')).toBe(false);
  });
});
