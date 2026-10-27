import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withFsMutex } from '../../../../scripts/lib/fs-mutex.mjs';
import { type HarnessContract, HarnessContractError, validateContract } from './contract.js';
import { assertEvidenceRootPlacement, formatRunRetentionLine, formatSummaryLine, loadRunResult, parseSummaryLine, pruneEvidenceRoot, pruneRuns, pruneRunsWithReport, runHarness, writeRunResult } from './runner.js';
import { symlinkSync } from 'node:fs';
import { planCommand, retainRunsCommand } from './cli.js';
import { parseSelectionArgs, planSelection } from './select.js';

const contract: HarnessContract = {
  name: 'drill',
  phases: [
    { id: 'setup', reusable: true },
    { id: 'leg-a', dependsOn: ['setup'] },
    { id: 'leg-b', dependsOn: ['setup'] },
    { id: 'leg-c', dependsOn: ['leg-a'] },
  ],
};

const tmp = () => mkdtempSync(path.join(tmpdir(), 'vh-'));

let privateRetention: string;
beforeEach(() => {
  privateRetention = tmp();
  vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', path.join(privateRetention, 'mutex'));
  vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', path.join(privateRetention, 'pins'));
  vi.stubEnv('PAPERCUSP_DISABLE_FS_MUTEX', '0');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(privateRetention, { recursive: true, force: true });
});

describe('evidence placement guard', () => {
  it('rejects an implicit legacy home-state root when offload storage is available', () => {
    const home = tmp();
    const legacy = path.join(home, '.local/state/verification-harness/legacy');
    expect(() => assertEvidenceRootPlacement('legacy', legacy, { HOME: home })).toThrow('root filesystem');
    expect(() => assertEvidenceRootPlacement('legacy', path.join('/tmp', 'vh-data', 'legacy'), { HOME: home })).not.toThrow();
    rmSync(home, { recursive: true, force: true });
  });
});

describe('harness retention admission', () => {
  it('shell retention preflight defers a busy mutex without waiting for the lock holder', async () => {
    const root = tmp();
    try {
      await withFsMutex('papercusp-disk-retention', async () => {
        const child = spawnSync('bash', ['-c',
          'source "$1"; vh_phase proof ""; vh_init shell-busy "$2"; test "$VH_DISABLED" = 0 && test -f "$VH_RUN_DIR/plan.json"',
          'vh-preflight', new URL('../bin/vh.sh', import.meta.url).pathname, root],
        { encoding: 'utf8', env: process.env, timeout: 8000 });
        expect(child.error, child.stderr + child.stdout).toBeUndefined();
        expect(child.status).toBe(0);
        expect(child.stderr).toContain('VH_RETENTION_DEFERRED stage=before reason=retention-mutex-busy');
        expect(child.stdout).toContain('VH_RUN harness=shell-busy');
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it.each([true, false])('shell finalization defers busy GC and retains the original %s verdict and declared receipt', async passes => {
    const root = tmp();
    const old = '20200101T000000Z-1', runId = '20260101T000000Z-1';
    const runDir = path.join(root, runId);
    vi.stubEnv('VH_KEEP_RUNS', '1');
    mkdirSync(path.join(root, old));
    writeFileSync(path.join(root, old, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: old,
      endedAt: '2020-01-01T00:00:00.000Z', verdict: 'pass' }));
    mkdirSync(runDir);
    writeFileSync(path.join(runDir, 'contract.json'), JSON.stringify({ name: 'shell-busy', phases: [{ id: 'proof' }] }));
    await planCommand(['--run-dir', runDir]);
    writeFileSync(path.join(runDir, 'phases.jsonl'), JSON.stringify({ phase: 'proof',
      status: passes ? 'passed' : 'failed', reasonCode: passes ? null : 'original-failure' }) + '\n');
    writeFileSync(path.join(runDir, 'original.json'), '{"original":"phase receipt"}\n');
    try {
      await withFsMutex('papercusp-disk-retention', async () => {
        // Exercise the real shell CLI entry point under an independently held mutex.
        // Bound the child so a regression cannot consume the production 180s lock wait.
        const child = spawnSync(process.execPath, ['--import', 'tsx', new URL('./cli.ts', import.meta.url).pathname,
          'finalize', '--run-dir', runDir, '--evidence-root', root, '--retain-artifact', 'original.json'],
        { encoding: 'utf8', env: process.env, timeout: 8000 });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(passes ? 0 : 1);
        expect(child.stdout).toContain(`HARNESS_RESULT harness=shell-busy`);
        expect(child.stderr).toContain('VH_RETENTION_DEFERRED stage=after reason=retention-mutex-busy');
        const result = await loadRunResult(runDir);
        expect(result.verdict).toBe(passes ? 'pass' : 'fail');
        expect(result.firstFailure?.reasonCode ?? null).toBe(passes ? null : 'original-failure');
        expect(readlinkSync(path.join(root, 'latest'))).toBe(runId);
        expect(readFileSync(path.join(root, 'retained', runId, 'result.json'), 'utf8'))
          .toBe(readFileSync(path.join(runDir, 'result.json'), 'utf8'));
        expect(readFileSync(path.join(root, 'retained', runId, 'original.json'), 'utf8'))
          .toBe(readFileSync(path.join(runDir, 'original.json'), 'utf8'));
        expect(existsSync(path.join(root, old))).toBe(true);
        expect(readdirSync(path.join(privateRetention, 'mutex', 'papercusp-disk-retention.queue'))).toHaveLength(0);
      });
      expect((await pruneEvidenceRoot(root)).runs).toEqual([old]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);

  it.each([true, false])('defers busy GC before and after phases while preserving the original %s verdict', async passes => {
    const root = tmp(), mutexRoot = tmp(), pins = tmp();
    vi.stubEnv('PAPERCUSP_FS_MUTEX_LOCK_DIR', mutexRoot);
    vi.stubEnv('PAPERCUSP_DISABLE_FS_MUTEX', '0');
    vi.stubEnv('PAPERCUSP_RELEASE_RETENTION_ROOT', pins);
    vi.stubEnv('VH_KEEP_RUNS', '1');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const old = '20200101T000000Z-1';
    mkdirSync(path.join(root, old));
    writeFileSync(path.join(root, old, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: old,
      endedAt: '2020-01-01T00:00:00.000Z', verdict: 'pass' }));
    try {
      await withFsMutex('papercusp-disk-retention', async () => {
        const result = await runHarness({
          contract: { name: 'busy-retention', phases: [{ id: 'proof' }] }, evidenceRoot: root,
          runPhase: async () => passes ? { ok: true } : { ok: false, reasonCode: 'original-failure' },
        });
        expect(result.verdict).toBe(passes ? 'pass' : 'fail');
        expect(await loadRunResult(result.evidenceDir)).toEqual(result);
        expect(readlinkSync(path.join(root, 'latest'))).toBe(result.runId);
        expect(existsSync(path.join(root, old))).toBe(true);
        const output = stderr.mock.calls.map(([text]) => String(text)).join('');
        for (const stage of ['before', 'after'])
          expect(output).toContain(`VH_RETENTION_DEFERRED stage=${stage} reason=retention-mutex-busy`);
        // Cancelled admissions leave neither FIFO tickets nor reader entries.
        expect(readdirSync(path.join(mutexRoot, 'papercusp-disk-retention.queue'))).toHaveLength(0);
      });
      expect((await pruneEvidenceRoot(root)).runs).toEqual([old]);
    } finally {
      stderr.mockRestore(); vi.unstubAllEnvs();
      for (const dir of [root, mutexRoot, pins]) rmSync(dir, { recursive: true, force: true });
    }
  }, 5000);
});

describe('read-only retention preview', () => {
  const now = Date.now();
  const names = ['20200101T000000Z-1', '20200102T000000Z-1', '20200103T000000Z-1'];
  const fixture = () => {
    const root = tmp();
    for (const name of names) {
      mkdirSync(path.join(root, name));
      writeFileSync(path.join(root, name, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: name, endedAt: new Date(now).toISOString(), verdict: 'pass' }));
    }
    return root;
  };
  it('shares count eligibility with mutation but leaves all evidence intact', async () => {
    const root = fixture();
    const before = names.map(n => readFileSync(path.join(root, n, 'result.json'), 'utf8'));
    const external = tmp();
    writeFileSync(path.join(external, 'proof'), 'external');
    symlinkSync(external, path.join(root, names[0], 'external'));
    const options = { measureDisk: async () => ({ totalBytes: 1000, availableBytes: 900 }), reserveBytes: () => 100 };
    const plan = await pruneRunsWithReport(root, 1, now, { ...options, dryRun: true });
    expect(plan.removed).toEqual([]);
    expect(plan.preview?.candidates.map(c => path.basename(c.path))).toEqual(names.slice(0, 2));
    expect(plan.preview?.candidates.every(c => c.allocatedBytes !== null)).toBe(true);
    expect(names.map(n => readFileSync(path.join(root, n, 'result.json'), 'utf8'))).toEqual(before);
    expect(readlinkSync(path.join(root, names[0], 'external'))).toBe(external);
    expect((await pruneRunsWithReport(root, 1, now, options)).removed).toEqual(names.slice(0, 2));
    expect(readFileSync(path.join(external, 'proof'), 'utf8')).toBe('external');
  });
  it('reports a pressure upper bound without simulated recovery and preserves protected/foreign entries', async () => {
    const root = fixture();
    symlinkSync(names[2], path.join(root, 'latest'));
    writeFileSync(path.join(root, names[1], '.vh-keep'), 'pin');
    mkdirSync(path.join(root, 'retained'));
    writeFileSync(path.join(root, 'foreign'), 'proof');
    const plan = await pruneRunsWithReport(root, 30, now, { dryRun: true, measureDisk: async () => ({ totalBytes: 1000, availableBytes: 0 }), reserveBytes: () => 100 });
    expect(plan.preview?.candidates.map(c => [path.basename(c.path), c.reason])).toEqual([[names[0], 'pressure']]);
    expect(plan.preview?.kept.map(c => c.reason)).toEqual(['.vh-keep', 'latest']);
    expect(plan.disk.status).toBe('unresolved');
    expect(plan.disk.availableAfterBytes).toBeNull();
    expect(readlinkSync(path.join(root, 'latest'))).toBe(names[2]);
    expect(readFileSync(path.join(root, names[1], '.vh-keep'), 'utf8')).toBe('pin');
    expect(readFileSync(path.join(root, 'foreign'), 'utf8')).toBe('proof');
    expect(readdirSync(root).sort()).toEqual([...names, 'latest', 'retained', 'foreign'].sort());
  });
  it('keeps fresh partial runs and exposes unknown disk/root state', async () => {
    const root = fixture();
    rmSync(path.join(root, names[0], 'result.json'));
    const plan = await pruneRunsWithReport(root, 1, now, { dryRun: true, measureDisk: async () => null });
    expect(plan.preview?.kept).toContainEqual({ path: path.join(root, names[0]), reason: 'incomplete-grace' });
    expect(plan.disk.status).toBe('unmeasured');
    expect((await pruneRunsWithReport(path.join(root, 'absent'), 1, now, { dryRun: true })).preview?.rootStatus).toBe('unreadable');
  });
  it('exposes zero-effect preview through the existing retain CLI', async () => {
    const root = fixture();
    const report = await retainRunsCommand(['--evidence-root', root, '--dry-run']);
    expect(report.preview?.advisory).toBe(true);
    expect(report.removed).toEqual([]);
    expect(readdirSync(root).sort()).toEqual(names);
  });
});

describe('evidence root byte ceiling', () => {
  it('evicts oldest writes until under cap even when count and disk reserve are healthy', async () => {
    const root = tmp();
    const names = ['20200101T000000Z-1', '20200102T000000Z-1', '20200103T000000Z-1'];
    try {
      for (const [i, name] of names.entries()) {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: name, endedAt: new Date().toISOString(), verdict: 'pass' }));
        writeFileSync(path.join(root, name, 'bulk'), Buffer.alloc(64 * 1024, 1));
        // Reverse name order: the actual newest write decides cap eviction.
        const time = new Date(Date.now() - (i + 1) * 3600e3);
        for (const file of [path.join(root, name), path.join(root, name, 'bulk'), path.join(root, name, 'result.json')]) utimesSync(file, time, time);
      }
      const options = { maxBytes: 100 * 1024, measureDisk: async () => ({ totalBytes: 1000, availableBytes: 900 }), reserveBytes: () => 100 };
      const preview = await pruneRunsWithReport(root, 30, Date.now(), { ...options, dryRun: true });
      expect(preview.preview?.candidates.map(c => c.reason)).toEqual(['size-cap', 'size-cap', 'size-cap']);
      expect(names.every(name => existsSync(path.join(root, name)))).toBe(true);
      const report = await pruneRunsWithReport(root, 30, Date.now(), options);
      expect(report.removed).toEqual([names[2], names[1]]);
      expect(report.cap?.afterBytes).toBeLessThanOrEqual(options.maxBytes);
      expect(existsSync(path.join(root, names[0]))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps latest and reports the remaining overage while continuing past protected older runs', async () => {
    const root = tmp();
    const names = ['20200101T000000Z-1', '20200102T000000Z-1'];
    try {
      for (const name of names) {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: name, endedAt: new Date().toISOString(), verdict: 'pass' }));
        writeFileSync(path.join(root, name, 'bulk'), Buffer.alloc(64 * 1024, 1));
      }
      symlinkSync(names[0], path.join(root, 'latest'));
      const report = await pruneRunsWithReport(root, 30, Date.now(), { maxBytes: 1, measureDisk: async () => null });
      expect(report.removed).toEqual([names[1]]);
      expect(report.cap?.overByBytes).toBeGreaterThan(0);
      expect(existsSync(path.join(root, names[0]))).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('counts and reports finite descendant pins above cap; expiry restores eviction', async () => {
    const root = tmp();
    const leases = tmp();
    const names = ['20200101T000000Z-1', '20200102T000000Z-1'];
    const now = Date.now();
    try {
      for (const name of names) {
        mkdirSync(path.join(root, name));
        writeFileSync(path.join(root, name, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: name, endedAt: new Date(now).toISOString(), verdict: 'pass' }));
        writeFileSync(path.join(root, name, 'bulk'), Buffer.alloc(64 * 1024, 1));
      }
      const id = randomUUID();
      const tag = 'agent-pin-' + Buffer.from(JSON.stringify({ version: 1, id, owner: 'test', reason: 'cap-test', createdAt: new Date(now).toISOString() })).toString('base64url');
      writeFileSync(path.join(leases, `lease-agent-pin-${id}.tsv`), `schema=papercusp-release-retention/v1\ntag=${tag}\nexpires_ns=${BigInt(now + 3600e3) * 1000000n}\npath=${path.join(root, names[0], 'bulk')}\n`);
      const options = { env: { ...process.env, PAPERCUSP_RELEASE_RETENTION_ROOT: leases }, maxBytes: 1, measureDisk: async () => null };
      const report = await pruneRunsWithReport(root, 30, now, options);
      expect(report.removed).toEqual([names[1]]);
      expect(report.cap?.pinnedPaths).toEqual([path.join(root, names[0])]);
      expect(report.cap?.pinnedBytes).toBeGreaterThanOrEqual(64 * 1024);
      expect(report.cap?.pinnedOverageBytes).toBeGreaterThan(0);
      const expired = await pruneRunsWithReport(root, 30, now + 2 * 3600e3, options);
      expect(expired.removed).toEqual([names[0]]);
      expect(expired.cap?.pinnedBytes).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(leases, { recursive: true, force: true }); }
  });
});

describe('exact VH pin allocation and cap verdict', () => {
  const runId = '20200101T000000Z-1';
  const healthy = { measureDisk: async () => ({ totalBytes: 1000, availableBytes: 900 }), reserveBytes: () => 100 };
  const pin = (scope: string, now: number) => {
    const leases = path.join(privateRetention, 'pins');
    mkdirSync(leases, { recursive: true });
    const id = randomUUID();
    const tag = 'agent-pin-' + Buffer.from(JSON.stringify({ version: 1, id, owner: 'test', reason: 'exact-vh-cap', createdAt: new Date(now).toISOString() })).toString('base64url');
    writeFileSync(path.join(leases, `lease-agent-pin-${id}.tsv`), `schema=papercusp-release-retention/v1\ntag=${tag}\nexpires_ns=${BigInt(now + 3600e3) * 1000000n}\npath=${scope}\n`);
  };
  const terminal = (root: string, name = runId) => {
    mkdirSync(path.join(root, name));
    writeFileSync(path.join(root, name, 'result.json'), JSON.stringify({ schemaVersion: 1, runId: name, endedAt: new Date().toISOString(), verdict: 'pass' }));
  };

  it.each([false, true])('charges only the pinned child union while retaining its atomic run (alias=%s)', async alias => {
    const root = tmp(), now = Date.now();
    try {
      terminal(root);
      const run = path.join(root, runId), child = path.join(run, 'z-proof');
      mkdirSync(child);
      writeFileSync(path.join(run, 'bulk'), Buffer.alloc(256 * 1024, 1));
      writeFileSync(path.join(run, 'a-shared'), Buffer.alloc(4096, 1));
      linkSync(path.join(run, 'a-shared'), path.join(child, 'receipt'));
      linkSync(path.join(child, 'receipt'), path.join(child, 'duplicate'));
      const aliasPath = path.join(privateRetention, 'alias');
      if (alias) symlinkSync(root, aliasPath);
      pin(path.join(alias ? aliasPath : root, runId, 'z-proof'), now);
      const report = await pruneRunsWithReport(root, 30, now, { ...healthy, maxBytes: 64 * 1024 });
      expect(report.removed).toEqual([]);
      expect(existsSync(run)).toBe(true);
      expect(report.cap?.pinnedBytes).toBe((lstatSync(child).blocks + lstatSync(path.join(child, 'receipt')).blocks) * 512);
      expect(report.cap?.pinnedOverageBytes).toBe(0);
      expect(report.cap?.overByBytes).toBeGreaterThan(0);
      expect(report.cap?.error).toContain('size cap remains exceeded');
      expect(formatRunRetentionLine(report)).toContain('cap=exceeded');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('charges a root pin for unknown entries without following their symlink targets', async () => {
    const root = tmp(), external = tmp(), now = Date.now();
    try {
      terminal(root);
      writeFileSync(path.join(root, 'foreign'), Buffer.alloc(4096, 1));
      writeFileSync(path.join(external, 'outside'), Buffer.alloc(256 * 1024, 1));
      symlinkSync(external, path.join(root, 'external'));
      pin(root, now);
      const report = await pruneRunsWithReport(root, 30, now, { ...healthy, maxBytes: 1 });
      expect(report.cap?.pinnedBytes).toBe(report.cap?.beforeBytes);
      expect(report.cap?.beforeBytes).toBeLessThan(256 * 1024);
      expect(report.cap?.overByBytes).toBe(report.cap?.pinnedOverageBytes);
      expect(report.cap?.error).toBeUndefined();
      expect(formatRunRetentionLine(report)).toContain('cap=pinned-overage');
      expect(readFileSync(path.join(external, 'outside'))).toHaveLength(256 * 1024);
    } finally { for (const dir of [root, external]) rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['latest', 'keep', 'non-terminal', 'grace', 'foreign'])('reports healthy-disk non-pin excess retained by %s', async protection => {
    const root = tmp(), now = Date.now();
    try {
      if (protection === 'foreign') writeFileSync(path.join(root, 'foreign'), Buffer.alloc(64 * 1024, 1));
      else {
        terminal(root);
        writeFileSync(path.join(root, runId, 'bulk'), Buffer.alloc(64 * 1024, 1));
        if (protection === 'latest') symlinkSync(runId, path.join(root, 'latest'));
        if (protection === 'keep') writeFileSync(path.join(root, runId, '.vh-keep'), 'keep');
        if (protection === 'non-terminal' || protection === 'grace') {
          rmSync(path.join(root, runId, 'result.json'));
          const age = new Date(now - (protection === 'grace' ? 1000 : 48 * 3600e3));
          utimesSync(path.join(root, runId), age, age);
        }
      }
      const report = await pruneRunsWithReport(root, 30, now, { ...healthy, maxBytes: 1 });
      expect(report.removed).toEqual([]);
      expect(report.disk.status).toBe('healthy');
      expect(report.cap?.pinnedBytes).toBe(0);
      expect(report.cap?.error).toContain('size cap remains exceeded');
      expect(formatRunRetentionLine(report)).toContain('cap=exceeded');
      expect(readdirSync(root).length).toBeGreaterThan(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports actual root allocation after pressure eviction', async () => {
    const root = tmp();
    try {
      terminal(root);
      writeFileSync(path.join(root, runId, 'bulk'), Buffer.alloc(64 * 1024, 1));
      const report = await pruneRunsWithReport(root, 30, Date.now(), { maxBytes: 1024 * 1024,
        measureDisk: async () => ({ totalBytes: 1000, availableBytes: existsSync(path.join(root, runId)) ? 0 : 900 }), reserveBytes: () => 100 });
      expect(report.removed).toEqual([runId]);
      expect(report.disk.status).toBe('recovered');
      expect(report.cap?.afterBytes).toBe(lstatSync(root).blocks * 512);
      expect(report.cap?.afterBytes).toBeLessThan(report.cap!.beforeBytes!);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('declared completion receipt retention', () => {
  it.each(['count', 'bytes', 'symlink', 'ancestor-symlink'])(
    'refuses unsafe browser artifact %s before publishing a retained completion', async mode => {
      const root = tmp(), outside = tmp(), runId = '20261022T000001Z-1';
      try {
        await expect(runHarness({
          contract: { name: 'bounded-browser-proof', phases: [{ id: 'assert' }] },
          evidenceRoot: root, runId,
          retainedArtifacts: ['phases/assert/playwright/screens/**/*.png'],
          runPhase: async ({ evidenceDir }) => {
            const output = path.join(evidenceDir, 'playwright/screens');
            if (mode === 'ancestor-symlink') {
              mkdirSync(path.join(outside, 'screens'));
              writeFileSync(path.join(outside, 'screens/private.png'), 'outside');
              symlinkSync(outside, path.join(evidenceDir, 'playwright'));
            } else {
              mkdirSync(output, { recursive: true });
              if (mode === 'symlink') {
                writeFileSync(path.join(outside, 'private.png'), 'outside');
                symlinkSync(path.join(outside, 'private.png'), path.join(output, 'linked.png'));
              } else {
                for (let i = 0; i < (mode === 'count' ? 129 : 5); i++) {
                  const file = path.join(output, `${i}.png`);
                  writeFileSync(file, 'x');
                  if (mode === 'bytes') truncateSync(file, 16 * 1024 * 1024);
                }
              }
            }
            return { ok: true };
          },
        })).rejects.toThrow(mode === 'count' ? 'file limit exceeded'
          : mode === 'bytes' ? 'byte limit exceeded'
            : mode === 'symlink' ? 'artifact symlink' : 'directory outside run');
        expect(existsSync(path.join(root, 'retained', runId, 'result.json'))).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
    });

  it('allows a non-browser assertion with no PNG directory and keeps its custody manifest immutable', async () => {
    const root = tmp();
    try {
      const result = await runHarness({
        contract: { name: 'non-browser-proof', phases: [{ id: 'assert' }] },
        evidenceRoot: root, retainedArtifacts: ['phases/assert/playwright/**/*.png'],
        runPhase: async () => ({ ok: true }),
      });
      expect(result.verdict).toBe('pass');
      const manifest = path.join(root, 'retained', result.runId, 'retained-artifacts.json');
      const original = readFileSync(manifest);
      expect(JSON.parse(original.toString()).artifacts.map((entry: { path: string }) => entry.path)).toEqual(['result.json']);
      const output = path.join(result.evidenceDir, 'phases/assert/playwright');
      mkdirSync(output, { recursive: true });
      writeFileSync(path.join(output, 'late.png'), 'late evidence');
      await expect(writeRunResult(result, ['phases/assert/playwright/**/*.png']))
        .rejects.toThrow('retained harness artifact changed');
      expect(readFileSync(manifest)).toEqual(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  const receipts = ['phases/prepare/source.json', 'phases/execute/lifecycle.json'];
  const source = Buffer.from('{"source":"original bytes", "sequence":1}\n');
  const lifecycle = Buffer.from('{"worker":23,"ended":true}\n');
  const complete = (root: string, runId: string) => runHarness({
    contract: { name: 'receipt-proof', phases: [{ id: 'prepare' }, { id: 'execute' }] },
    evidenceRoot: root, runId, retainedArtifacts: receipts,
    runPhase: async ({ phase, evidenceDir }) => {
      writeFileSync(path.join(evidenceDir, phase === 'prepare' ? 'source.json' : 'lifecycle.json'),
        phase === 'prepare' ? source : lifecycle);
      return { ok: true };
    },
  });

  it('preserves exact source and lifecycle bytes for late binding after count pruning', async () => {
    const root = tmp(), first = '20261010T000001Z-1', second = '20261010T000002Z-2';
    try {
      const original = await complete(root, first);
      await complete(root, second);
      await pruneRuns(root, 1);
      expect(existsSync(original.evidenceDir)).toBe(false);
      expect(readFileSync(path.join(root, 'retained', first, receipts[0]))).toEqual(source);
      expect(readFileSync(path.join(root, 'retained', first, receipts[1]))).toEqual(lifecycle);
      expect(readFileSync(path.join(root, 'retained', first, 'result.json')))
        .toEqual(Buffer.from(JSON.stringify(original, null, 2) + '\n'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains a terminal failure without declared artifacts after its run directory is pruned', async () => {
    const root = tmp(), runId = '20261010T000001Z-1';
    try {
      const original = await runHarness({
        contract: { name: 'failure-proof', phases: [{ id: 'boot' }] },
        evidenceRoot: root, runId,
        runPhase: async () => ({ ok: false, step: 'load-config', reasonCode: 'invalid-config' }),
      });
      expect(original.verdict).toBe('fail');
      await complete(root, '20261010T000002Z-2');
      expect(await pruneRuns(root, 1)).toContain(runId);
      expect(existsSync(original.evidenceDir)).toBe(false);
      expect(readFileSync(path.join(root, 'retained', runId, 'result.json')))
        .toEqual(Buffer.from(JSON.stringify(original, null, 2) + '\n'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses missing declared phase receipts before publishing retained completion', async () => {
    const root = tmp(), runId = '20261010T000003Z-3';
    try {
      await expect(runHarness({
        contract: { name: 'receipt-proof', phases: [{ id: 'prepare' }] },
        evidenceRoot: root, runId, retainedArtifacts: receipts,
        runPhase: async () => ({ ok: true }),
      })).rejects.toThrow();
      expect(existsSync(path.join(root, 'retained', runId, 'result.json'))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['prepare', 'execute'])('preserves original failed %s receipts and verdict after count pruning', async failurePhase => {
    const root = tmp(), runId = '20261012T000001Z-1';
    try {
      const original = await runHarness({
        contract: { name: 'failed-receipt-proof', phases: [{ id: 'prepare' }, { id: 'execute', dependsOn: ['prepare'] }] },
        evidenceRoot: root, runId, retainedArtifacts: receipts,
        runPhase: async ({ phase, evidenceDir }) => {
          writeFileSync(path.join(evidenceDir, phase === 'prepare' ? 'source.json' : 'lifecycle.json'),
            phase === 'prepare' ? source : lifecycle);
          return phase === failurePhase ? { ok: false, reasonCode: 'original-rejection', detail: 'original failure' } : { ok: true };
        },
      });
      expect(original.verdict).toBe('fail');
      expect(original.phases.find(phase => phase.phase === failurePhase)).toMatchObject({
        reasonCode: 'original-rejection', detail: 'original failure',
      });
      await complete(root, '20261012T000002Z-2');
      expect(await pruneRuns(root, 1)).toContain(runId);
      expect(existsSync(original.evidenceDir)).toBe(false);
      expect(readFileSync(path.join(root, 'retained', runId, receipts[0]))).toEqual(source);
      if (failurePhase === 'execute') expect(readFileSync(path.join(root, 'retained', runId, receipts[1]))).toEqual(lifecycle);
      else expect(existsSync(path.join(root, 'retained', runId, receipts[1]))).toBe(false);
      expect(JSON.parse(readFileSync(path.join(root, 'retained', runId, 'result.json'), 'utf8'))).toEqual(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('refuses changed retained source bytes without replacing the original', async () => {
    const root = tmp(), runId = '20261010T000004Z-4';
    try {
      const result = await complete(root, runId);
      writeFileSync(path.join(result.evidenceDir, receipts[0]), '{}');
      await expect(writeRunResult(result, receipts)).rejects.toThrow('retained harness artifact changed');
      expect(readFileSync(path.join(root, 'retained', runId, receipts[0]))).toEqual(source);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['../outside.json', '/absolute.json', 'phases/../source.json', 'phases\\source.json'])
    ('refuses an unsafe declared receipt path %s before phase execution', async receipt => {
      const root = tmp(); let ran = false;
      try {
        await expect(runHarness({
          contract: { name: 'receipt-proof', phases: [{ id: 'prepare' }] },
          evidenceRoot: root, retainedArtifacts: [receipt],
          runPhase: async () => { ran = true; return { ok: true }; },
        })).rejects.toThrow('invalid retained harness artifact path');
        expect(ran).toBe(false);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
});

describe('validateContract', () => {
  it('rejects a forward dependency, an unknown one and a duplicate id', () => {
    expect(() => validateContract({ name: 'x', phases: [{ id: 'a', dependsOn: ['b'] }, { id: 'b' }] })).toThrow(/declared later/);
    expect(() => validateContract({ name: 'x', phases: [{ id: 'a', dependsOn: ['z'] }] })).toThrow(/unknown phase z/);
    expect(() => validateContract({ name: 'x', phases: [{ id: 'a' }, { id: 'a' }] })).toThrow(HarnessContractError);
  });
});

describe('runHarness', () => {
  it('never aborts: a failed phase blocks only its dependents, and the first failure is named', async () => {
    const root = tmp();
    const ran: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: root,
      runId: 'r1',
      runPhase: async ({ phase, markStep }) => {
        ran.push(phase);
        if (phase === 'leg-a') {
          markStep('clone');
          return { ok: false, reasonCode: 'clone-timeout', detail: 'no refs after 60s' };
        }
        return { ok: true };
      },
    });
    expect(ran).toEqual(['setup', 'leg-a', 'leg-b']);
    expect(result.phases.map((p) => [p.phase, p.status, p.reasonCode])).toEqual([
      ['setup', 'passed', null],
      ['leg-a', 'failed', 'clone-timeout'],
      ['leg-b', 'passed', null],
      ['leg-c', 'blocked', 'dependency:leg-a:failed'],
    ]);
    expect(result.verdict).toBe('fail');
    expect(result.firstFailure).toEqual({ phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' });
    expect(formatSummaryLine(result)).toContain('first_failure=leg-a/clone/clone-timeout passed=2 failed=1 blocked=1');
    // The line has one owner: what formatSummaryLine writes, parseSummaryLine reads back.
    expect(parseSummaryLine(formatSummaryLine(result))).toEqual({
      harness: 'drill',
      verdict: 'fail',
      runId: 'r1',
      firstFailure: { phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' },
    });
    expect((await loadRunResult(path.join(root, 'r1'))).verdict).toBe('fail');
    expect(readlinkSync(path.join(root, 'latest'))).toBe('r1');
  });

  it('records a throwing phase as failed with its last marked step', async () => {
    const result = await runHarness({
      contract: { name: 't', phases: [{ id: 'only' }] },
      evidenceRoot: tmp(),
      runPhase: async ({ markStep }) => {
        markStep('boot');
        throw new Error('ECONNREFUSED');
      },
    });
    expect(result.phases[0]).toMatchObject({ status: 'failed', step: 'boot', reasonCode: 'threw', detail: 'ECONNREFUSED' });
  });

  it('a failed preflight blocks every phase and runs none', async () => {
    const ran: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: tmp(),
      preflight: async () => ({ ok: false, reasonCode: 'rig-daemon-loaded' }),
      runPhase: async ({ phase }) => { ran.push(phase); return { ok: true }; },
    });
    expect(ran).toEqual([]);
    expect(result.verdict).toBe('preflight-failed');
    expect(result.phases.every((p) => p.status === 'blocked' && p.reasonCode === 'preflight-failed')).toBe(true);
  });

  it('R-5: every run keeps its own evidence dir; a same-second run never overwrites an earlier one', async () => {
    const root = tmp();
    const clock = () => new Date('2026-09-30T00:00:00.000Z');
    const run = (verdict: boolean) =>
      runHarness({
        contract: { name: 'r5', phases: [{ id: 'only' }] },
        evidenceRoot: root,
        now: clock,
        runPhase: async ({ evidenceDir }) => {
          writeFileSync(path.join(evidenceDir, 'mark.txt'), String(verdict));
          return verdict ? { ok: true } : { ok: false, reasonCode: 'boom' };
        },
      });
    const first = await run(false);
    const second = await run(true);
    // Same clock second, same pid: the ids must still differ, and so must the dirs.
    expect(second.runId).not.toBe(first.runId);
    expect(second.evidenceDir).not.toBe(first.evidenceDir);
    // The first run's evidence is intact: its own result and its own phase output.
    expect((await loadRunResult(first.evidenceDir)).verdict).toBe('fail');
    expect(readFileSync(path.join(first.evidenceDir, 'phases', 'only', 'mark.txt'), 'utf8')).toBe('false');
    expect((await loadRunResult(second.evidenceDir)).verdict).toBe('pass');
    // An explicit run id that already exists is refused rather than reused.
    await expect(
      runHarness({ contract: { name: 'r5', phases: [{ id: 'only' }] }, evidenceRoot: root, runId: first.runId, runPhase: async () => ({ ok: true }) }),
    ).rejects.toThrow(/already exists/);
    expect((await loadRunResult(first.evidenceDir)).verdict).toBe('fail');
  });

  it('--only re-runs one phase and reuses passed setup from the prior run', async () => {
    const root = tmp();
    await runHarness({ contract, evidenceRoot: root, runId: 'first', runPhase: async () => ({ ok: true }) });
    const ran: string[] = [];
    const result = await runHarness({
      contract,
      evidenceRoot: root,
      runId: 'second',
      selection: { only: ['leg-c'], from: null },
      reuseFrom: path.join(root, 'first'),
      runPhase: async ({ phase }) => { ran.push(phase); return { ok: true }; },
    });
    // setup is reusable → reused; leg-a is not reusable → it must run again for leg-c.
    expect(ran).toEqual(['leg-a', 'leg-c']);
    expect(result.phases.map((p) => [p.phase, p.status])).toEqual([
      ['setup', 'reused'],
      ['leg-a', 'passed'],
      ['leg-b', 'skipped'],
      ['leg-c', 'passed'],
    ]);
    expect(result.phases[0]!.reusedFromRunId).toBe('first');
    expect(result.verdict).toBe('pass');
  });
});

describe('parseSummaryLine', () => {
  const line = (first: string) =>
    `  HARNESS_RESULT harness=h verdict=fail run=20260930T000000Z-42 first_failure=${first} passed=0 failed=1 evidence=/x`;

  it('reads no failure, placeholder steps, a step containing "/" and a guard-rail reason', () => {
    expect(parseSummaryLine(line('none'))?.firstFailure).toBeNull();
    expect(parseSummaryLine(line('build/-/exit-1'))?.firstFailure).toEqual({ phase: 'build', step: null, reasonCode: 'exit-1' });
    expect(parseSummaryLine(line('leg/a/b/timeout'))?.firstFailure).toEqual({ phase: 'leg', step: 'a/b', reasonCode: 'timeout' });
    expect(parseSummaryLine(line('preflight/guard-rails/guard-rail:daemon-up'))?.firstFailure).toEqual({
      phase: 'preflight',
      step: 'guard-rails',
      reasonCode: 'guard-rail:daemon-up',
    });
    expect(parseSummaryLine(line('x'))?.firstFailure).toBeNull();
  });

  it('returns null for any other line', () => {
    expect(parseSummaryLine('VH_RUN harness=h run=r evidence=/x')).toBeNull();
    expect(parseSummaryLine('')).toBeNull();
  });
});

describe('planSelection', () => {
  it('--from runs that phase and everything after it, running setup when there is nothing to reuse', () => {
    const plan = planSelection(contract, { only: null, from: 'leg-b' }, null);
    expect(plan.map((p) => [p.phase, p.action])).toEqual([
      ['setup', 'run'],
      ['leg-a', 'run'],
      ['leg-b', 'run'],
      ['leg-c', 'run'],
    ]);
  });

  it('does not reuse a setup the prior run failed', () => {
    const prior = { runId: 'p', phases: [{ phase: 'setup', status: 'failed' }] } as never;
    expect(planSelection(contract, { only: ['leg-b'], from: null }, prior)[0]).toMatchObject({ phase: 'setup', action: 'run' });
  });

  it('rejects an unknown phase and --only together with --from', () => {
    expect(() => planSelection(contract, { only: ['nope'], from: null }, null)).toThrow(/unknown phase nope/);
    expect(() => planSelection(contract, { only: ['leg-a'], from: 'leg-b' }, null)).toThrow(/mutually exclusive/);
  });

  it('parses the shared flags and leaves the rest alone', () => {
    expect(parseSelectionArgs(['x.deb', '--only-phase', 'leg-a,leg-b', '--reuse=/r/1'])).toEqual({
      only: ['leg-a', 'leg-b'],
      from: null,
      reuse: '/r/1',
      rest: ['x.deb'],
    });
  });
});

describe('bin/vh.sh (shell harness)', () => {
  const vh = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../bin/vh.sh');
  const script = (root: string) => `
set -u
source ${JSON.stringify(vh)}
vh_phase setup "" 1
vh_phase leg-a setup
vh_phase leg-b setup
vh_phase leg-c leg-a
phase_setup() { vh_step seed; echo seeded > "$VH_PHASE_DIR/out.txt"; }
phase_leg_a() { vh_step clone; vh_fail clone-timeout "no refs"; return 1; }
phase_leg_b() { false; }
phase_leg_c() { :; }
vh_init shell-drill ${JSON.stringify(root)} "$@" || exit 2
vh_run setup phase_setup
vh_run leg-a phase_leg_a
vh_run leg-b phase_leg_b
vh_run leg-c phase_leg_c
vh_finish
`;

  it('records the same result schema as the TS runner, continuing past failures', () => {
    const root = tmp();
    const file = path.join(root, 'h.sh');
    writeFileSync(file, script(root));
    let out = '';
    let code = 0;
    try {
      out = execFileSync('bash', [file], { encoding: 'utf8' });
    } catch (err) {
      const e = err as { status: number; stdout: string };
      code = e.status;
      out = e.stdout;
    }
    expect(code).toBe(1);
    expect(out).toMatch(/HARNESS_RESULT harness=shell-drill verdict=fail .*first_failure=leg-a\/clone\/clone-timeout passed=1 failed=2 blocked=1/);
    // The shell half prints the same line the parser reads (the attempt ledger's fingerprint input).
    const summary = out.split('\n').find((l) => l.includes('HARNESS_RESULT')) ?? '';
    expect(parseSummaryLine(summary)?.firstFailure).toEqual({ phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' });
    const result = JSON.parse(readFileSync(path.join(root, 'latest', 'result.json'), 'utf8'));
    expect(result.phases.map((p: { phase: string; status: string; reasonCode: string | null }) => [p.phase, p.status, p.reasonCode])).toEqual([
      ['setup', 'passed', null],
      ['leg-a', 'failed', 'clone-timeout'],
      ['leg-b', 'failed', 'exit-1'],
      ['leg-c', 'blocked', 'dependency:leg-a:failed'],
    ]);
    expect(readFileSync(path.join(root, 'latest', 'phases', 'setup', 'out.txt'), 'utf8')).toBe('seeded\n');
  });

  it('keeps a failed bracketed command step, stdout, stderr, and result in phase evidence', () => {
    const root = tmp();
    const file = path.join(root, 'capture.sh');
    writeFileSync(file, `
set -u
source ${JSON.stringify(vh)}
vh_phase prepare ""
vh_init shell-capture ${JSON.stringify(root)} || exit 2
vh_begin prepare
trap 'rc=$?; vh_capture_phase_stop; vh_exit "$rc"' EXIT
vh_capture_phase_start
rc=0
vh_run_step source-snapshot bash -c 'printf "stdout evidence\\n"; printf "stderr evidence\\n" >&2; exit 7' || rc=$?
exit "$rc"
`);

    let stdout = '';
    let stderr = '';
    let code = 0;
    try {
      stdout = execFileSync('bash', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { status: number; stdout: string; stderr: string };
      code = e.status;
      stdout = e.stdout;
      stderr = e.stderr;
    }

    expect(code).toBe(7);
    expect(stdout).toContain('stdout evidence');
    expect(stdout + stderr).toContain('stderr evidence');
    const commandDir = path.join(root, 'latest', 'phases', 'prepare', 'commands');
    expect(readFileSync(path.join(commandDir, 'source-snapshot.stdout.log'), 'utf8')).toBe('stdout evidence\n');
    expect(readFileSync(path.join(commandDir, 'source-snapshot.stderr.log'), 'utf8')).toBe('stderr evidence\n');
    expect(JSON.parse(readFileSync(path.join(commandDir, 'source-snapshot.result.json'), 'utf8'))).toEqual({
      step: 'source-snapshot',
      exitCode: 7,
    });
    const result = JSON.parse(readFileSync(path.join(root, 'latest', 'result.json'), 'utf8'));
    expect(result.phases).toContainEqual(expect.objectContaining({
      phase: 'prepare',
      status: 'failed',
      step: 'source-snapshot',
      reasonCode: 'exit-7',
    }));
    expect(readFileSync(path.join(root, 'latest', 'phases', 'prepare', 'command-output.log'), 'utf8')).toContain(
      'VH_COMMAND_RESULT phase=prepare step=source-snapshot exit=7',
    );
  });

  // WI-6554700010011505: a detached descendant (e.g. a daemon left behind by a
  // killed prepare step) inherits the capture pipe, so tee never sees EOF. An
  // unbounded wait in vh_capture_phase_stop then pinned the verifier, and the
  // Cargo slot lock it held, for 15h after result.json was written.
  it('stops waiting for the capture tee when a detached descendant still holds its pipe', () => {
    const root = tmp();
    const file = path.join(root, 'hold.sh');
    const holderPidFile = path.join(root, 'holder.pid');
    writeFileSync(file, `
set -u
source ${JSON.stringify(vh)}
vh_phase prepare ""
vh_init shell-capture-hold ${JSON.stringify(root)} || exit 2
vh_begin prepare
trap 'rc=$?; vh_capture_phase_stop; vh_exit "$rc"' EXIT
vh_capture_phase_start
echo "before holder"
sleep 60 &
echo "$!" > ${JSON.stringify(holderPidFile)}
exit 0
`);

    // Streams go to FILES, not pipes: the holder inherits the harness's saved
    // stdout/stderr descriptors too, so a pipe would make Node wait on the holder
    // instead of measuring when the verifier shell itself exits.
    const outFile = path.join(root, 'stdout.log');
    const errFile = path.join(root, 'stderr.log');
    const outFd = openSync(outFile, 'w');
    const errFd = openSync(errFile, 'w');
    const started = Date.now();
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync('bash', [file], {
        stdio: ['ignore', outFd, errFd],
        timeout: 20_000,
        env: { ...process.env, VH_CAPTURE_TEE_GRACE_SEC: '1' },
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
      if (existsSync(holderPidFile)) {
        try { process.kill(Number(readFileSync(holderPidFile, 'utf8').trim())); } catch { /* already gone */ }
      }
    }
    const elapsedMs = Date.now() - started;
    const streams = readFileSync(outFile, 'utf8') + readFileSync(errFile, 'utf8');

    expect(result.signal, streams).toBeNull();
    expect(result.status, streams).toBe(0);
    expect(elapsedMs).toBeLessThan(15_000);
    expect(streams).toContain('VH_CAPTURE_TEE_FORCED phase=prepare grace_sec=1');
    expect(readFileSync(path.join(root, 'latest', 'phases', 'prepare', 'command-output.log'), 'utf8')).toContain('before holder');
    expect(existsSync(path.join(root, 'latest', 'result.json'))).toBe(true);
  }, 30_000);

  it('does not wait out the tee grace when nothing else holds the capture pipe', () => {
    const root = tmp();
    const file = path.join(root, 'clean.sh');
    writeFileSync(file, `
set -u
source ${JSON.stringify(vh)}
vh_phase prepare ""
vh_init shell-capture-clean ${JSON.stringify(root)} || exit 2
vh_begin prepare
trap 'rc=$?; vh_capture_phase_stop; vh_exit "$rc"' EXIT
vh_capture_phase_start
echo "clean capture"
exit 0
`);
    const started = Date.now();
    const stdout = execFileSync('bash', [file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20_000,
      env: { ...process.env, VH_CAPTURE_TEE_GRACE_SEC: '10' },
    });
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(stdout).not.toContain('VH_CAPTURE_TEE_FORCED');
    expect(readFileSync(path.join(root, 'latest', 'phases', 'prepare', 'command-output.log'), 'utf8')).toContain('clean capture');
  }, 30_000);

  it('--only with --reuse latest reuses setup and skips unselected phases', () => {
    const root = tmp();
    const file = path.join(root, 'h.sh');
    writeFileSync(file, script(root));
    try { execFileSync('bash', [file], { encoding: 'utf8' }); } catch { /* first run fails by design */ }
    let out = '';
    try {
      out = execFileSync('bash', [file, '--only', 'leg-b', '--reuse', 'latest'], { encoding: 'utf8' });
    } catch (err) {
      out = (err as { stdout: string }).stdout;
    }
    expect(out).toMatch(/plan=setup:reuse,leg-a:skip,leg-b:run,leg-c:skip/);
    expect(out).toMatch(/VH_PHASE phase=setup status=reused/);
    expect(out).toMatch(/passed=0 failed=1 blocked=0 skipped=2 reused=1/);
  });

  it('R-5: a same-second second run in the same process claims its own dir and leaves the first intact', () => {
    const root = tmp();
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    // Pin ONLY the run-id timestamp format to one second; every other date call passes through.
    const realDate = execFileSync('bash', ['-c', 'command -v date'], { encoding: 'utf8' }).trim();
    writeFileSync(
      path.join(bin, 'date'),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in +%Y%m%dT%H%M%SZ) echo 20260930T000000Z; exit 0;; esac; done\nexec ${realDate} "$@"\n`,
      { mode: 0o755 },
    );
    const ev = path.join(root, 'ev');
    const file = path.join(root, 'h.sh');
    writeFileSync(
      file,
      `source ${JSON.stringify(vh)}\nvh_phase only\n` +
        `vh_init twice ${JSON.stringify(ev)} || exit 2\nvh_run only true\nvh_finish\n` +
        `vh_init twice ${JSON.stringify(ev)} || exit 3\necho "SECOND=$VH_RUN_DIR"\nvh_run only false\n`,
    );
    const out = execFileSync('bash', [file], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const runs = readdirSync(ev, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}Z-\d+(\.\d+)?$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    expect(runs).toHaveLength(2);
    expect(runs[1]).toBe(`${runs[0]}.1`);
    expect(out).toContain(`SECOND=${path.join(ev, runs[1]!)}`);
    const first = JSON.parse(readFileSync(path.join(ev, runs[0]!, 'result.json'), 'utf8'));
    expect(first.verdict).toBe('pass');
    expect(first.runId).toBe(runs[0]);
  });

  it('a planned phase the harness never reported is a failure, not a pass', () => {
    const root = tmp();
    const file = path.join(root, 'h.sh');
    writeFileSync(
      file,
      `source ${JSON.stringify(vh)}\nvh_phase a\nvh_phase b\nvh_init early ${JSON.stringify(root)} || exit 2\nvh_run a true\nvh_finish\n`,
    );
    let out = '';
    try { out = execFileSync('bash', [file], { encoding: 'utf8' }); } catch (err) { out = (err as { stdout: string }).stdout; }
    expect(out).toMatch(/verdict=fail .*first_failure=b\/-\/not-reported/);
  });
});

describe('verify-tauri-headless prepare diagnostics', () => {
  it('captures the prepare phase and names its major fallible stages before boot', () => {
    const verifier = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../scripts/verify-tauri-headless.sh');
    const source = readFileSync(verifier, 'utf8');
    const prepareStart = source.indexOf('verifier_begin_phase prepare');
    const bootStart = source.indexOf('verifier_begin_phase boot', prepareStart);
    expect(prepareStart).toBeGreaterThanOrEqual(0);
    expect(bootStart).toBeGreaterThan(prepareStart);
    const prepare = source.slice(prepareStart, bootStart);
    expect(prepare).toContain('vh_capture_phase_start');
    expect(prepare).toContain('vh_capture_phase_stop');
    for (const step of [
      'shared-schema-readiness',
      'verifier-snapshot-root',
      'operator-source-snapshot',
      'verifier-host-bundle',
      'verifier-host-import-smoke',
      'assertion-input-manifest',
      'assertion-script-snapshot',
      'freshness-check-script',
    ]) {
      expect(prepare).toContain(`verifier_run_step ${step}`);
    }
    // WI-6554700010017687: the --boot-only env file's ownership check runs in
    // the CALLER's shell, where no vh_* helper exists, so it is not a verifier
    // step. A vh_run_step wrapper there exits 127 and the file never loads.
    expect(prepare).not.toContain('vh_run_step verifier-bridge-ownership');
    expect(prepare).toContain('vh_step isolated-database-prepare');
  });
});
