/**
 * host-dump-coverage.test.ts — the decision that lets the per-workspace
 * pre-snapshot hook stand down when the host backup already dumped the database.
 *
 * The whole point of this module is that it is FAIL-SAFE: it may only return
 * `covered: true` on positive proof, because a false positive silently disables
 * a workspace's only database dump. So the bulk of these cases assert the
 * NEGATIVE branches — each one is a way the evidence can be missing, stale,
 * malformed, or about a different server, and each must fall through to dumping.
 *
 * The single positive case is deliberately outnumbered; that ratio is the
 * safety property, not test padding.
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_HOST_PG_DUMP_DIR,
  HOST_DUMP_IN_PROGRESS_MAX_AGE_SEC,
  HOST_PG_DUMP_IN_PROGRESS_PREFIX,
  HOST_PG_DUMP_IN_PROGRESS_SUFFIX,
  KOPIA_BACKUP_LOCK_PATH_ENV,
  HOST_DUMP_MAX_AGE_SEC,
  HOST_PG_DUMP_DIR_ENV,
  evaluateHostDumpCoverage,
  hostDumpGuardInProgressPath,
  hostDumpInProgressPath,
  hostDumpStatusPath,
  readHostDumpInProgress,
} from './host-dump-coverage';

const NOW = 1_788_100_000;
const SYSID = '7635091775813704249';

/** A receipt that DOES prove coverage; each test perturbs exactly one field. */
const goodStatus = () => ({
  ok: true,
  lastSuccessEpoch: NOW - 600,
  dumped: ['postgres', 'papercusp', 'restart'],
  systemIdentifier: SYSID,
});

const evaluate = (over: Partial<Parameters<typeof evaluateHostDumpCoverage>[0]> = {}) =>
  evaluateHostDumpCoverage({
    database: 'papercusp',
    targetSystemIdentifier: SYSID,
    status: goodStatus(),
    nowEpoch: NOW,
    ...over,
  });

async function writeFakeProcess(
  procRoot: string,
  pid: number,
  startTicks: string,
  state = 'S',
  commandLine?: string,
): Promise<void> {
  const processDir = join(procRoot, String(pid));
  await mkdir(processDir, { recursive: true });
  const fields = [state, ...Array(18).fill('0'), startTicks, '0', '0'];
  await writeFile(join(processDir, 'stat'), `${pid} (fake process name) ${fields.join(' ')}\n`);
  if (commandLine !== undefined) await writeFile(join(processDir, 'cmdline'), commandLine);
}

describe('evaluateHostDumpCoverage', () => {
  it('covers a fresh successful host dump of the same database on the same cluster', () => {
    const r = evaluate();
    expect(r.covered).toBe(true);
    expect(r.reason).toContain('covered by db-backup.sh');
    expect(r.reason).toContain(SYSID);
  });

  it('covers the authoritative state tier when the host producer uses tiered dumps', () => {
    const r = evaluate({
      status: {
        ok: true,
        lastSuccessEpoch: NOW - 600,
        dumped: ['papercusp-state', 'papercusp-transcript', 'restart'],
        tiersEnabled: true,
        systemIdentifier: SYSID,
      },
    });
    expect(r.covered).toBe(true);
    expect(r.reason).toContain('artifact papercusp-state');
  });

  it('does not treat a tier name as coverage unless tier mode is advertised', () => {
    const r = evaluate({
      status: {
        ok: true,
        lastSuccessEpoch: NOW - 600,
        dumped: ['papercusp-state', 'papercusp-transcript', 'restart'],
        systemIdentifier: SYSID,
      },
    });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('not in host-dump receipt');
  });

  it('does not cover when there is no receipt at all (the desktop ship target)', () => {
    expect(evaluate({ status: null })).toMatchObject({ covered: false });
  });

  it('does not cover when the host run reported failure and carries no run timing', () => {
    const r = evaluate({ status: { ...goodStatus(), ok: false } });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('run timing');
  });

  describe('a partially failed host run (EI-24018312041976584)', () => {
    // The tower's real receipt from 2026-09-22 21:19 EDT, verbatim in every field
    // this decision reads. The state tier dumped, but the transcript tier was
    // skipped for disk space, so the run wrote ok:false. The old rule rejected
    // it outright. That made four workspace hooks each dump this cluster every
    // hour, and nine of their ten dumps in three hours timed out or failed.
    const towerReceipt = {
      ok: false,
      lastRunEpoch: 1_790_126_347,
      lastSuccessEpoch: 1_790_088_192,
      elapsedSec: 1087,
      dumped: ['postgres', 'phone_app_test2', 'email_app', 'calendar_app', 'restart', 'papercusp_su', 'papercusp-state'],
      failed: ['papercusp-transcript'],
      systemIdentifier: SYSID,
      tiersEnabled: true,
      tierDumped: ['papercusp-state'],
      tierFailed: ['papercusp-transcript'],
    };
    const HOOK_FIRED_AT = 1_790_131_691; // 2026-09-23T02:48:11Z, when that hour's workspace dump started

    it('covers the state tier the failed run DID dump', () => {
      const r = evaluate({ status: towerReceipt, nowEpoch: HOOK_FIRED_AT });
      expect(r.covered).toBe(true);
      expect(r.reason).toContain('artifact papercusp-state');
      expect(r.reason).toContain('partially failed run');
    });

    it('dates the artifact from the run START, so the age is measured conservatively', () => {
      const start = towerReceipt.lastRunEpoch - towerReceipt.elapsedSec;
      const r = evaluate({ status: towerReceipt, nowEpoch: HOOK_FIRED_AT });
      expect(r.reason).toContain(`${HOOK_FIRED_AT - start}s ago`);
      // Just past the bound when measured from the start, while measuring from
      // the run's END would still read as fresh: the start must win.
      const justStale = start + HOST_DUMP_MAX_AGE_SEC + 1;
      expect(justStale - towerReceipt.lastRunEpoch).toBeLessThan(HOST_DUMP_MAX_AGE_SEC);
      const stale = evaluate({ status: towerReceipt, nowEpoch: justStale });
      expect(stale.covered).toBe(false);
      expect(stale.reason).toContain('stale');
    });

    it('does not cover when the artifact that failed IS the one the hook needs', () => {
      const r = evaluate({
        status: { ...towerReceipt, dumped: ['postgres', 'restart'] },
        nowEpoch: HOOK_FIRED_AT,
      });
      expect(r.covered).toBe(false);
      expect(r.reason).toContain('did not dump papercusp');
    });

    it.each([
      ['missing lastRunEpoch', { lastRunEpoch: undefined }],
      ['missing elapsedSec', { elapsedSec: undefined }],
      ['negative elapsedSec', { elapsedSec: -5 }],
      ['non-numeric lastRunEpoch', { lastRunEpoch: '1790126347' }],
    ])('does not cover when the receipt has %s', (_label, perturbation) => {
      const r = evaluate({ status: { ...towerReceipt, ...perturbation }, nowEpoch: HOOK_FIRED_AT });
      expect(r.covered).toBe(false);
      expect(r.reason).toContain('run timing');
    });

    it('still demands the same cluster identity', () => {
      const r = evaluate({ status: towerReceipt, nowEpoch: HOOK_FIRED_AT, targetSystemIdentifier: '1111111111111111111' });
      expect(r.covered).toBe(false);
      expect(r.reason).toContain('different cluster');
    });
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['non-string', 12345],
  ])('does not cover when the receipt cluster identity is %s', (_label, systemIdentifier) => {
    const r = evaluate({ status: { ...goodStatus(), systemIdentifier } });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('cluster identity');
  });

  it('does not cover when the target cluster identity could not be probed', () => {
    // psql missing, auth failure, or timeout — an unproven target never skips.
    const r = evaluate({ targetSystemIdentifier: null });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('probe');
  });

  it('does NOT cover a same-named database on a DIFFERENT cluster', () => {
    // The load-bearing case: a workspace's embedded Postgres routinely holds a
    // database named `papercusp`. A name-only comparison would suppress its
    // only dump. Identity must differ ⇒ dump.
    const r = evaluate({ targetSystemIdentifier: '1111111111111111111' });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('different cluster');
  });

  it('does not cover a database absent from the receipt (e.g. excluded by EXCLUDE_RE)', () => {
    const r = evaluate({ database: 'papercusp_scratch' });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('not in host-dump receipt');
  });

  it('does not cover when `dumped` is malformed rather than a string array', () => {
    expect(evaluate({ status: { ...goodStatus(), dumped: 'papercusp' } })).toMatchObject({
      covered: false,
    });
  });

  it('does not cover a stale receipt, so a wedged host job cannot suppress dumps forever', () => {
    const r = evaluate({ status: { ...goodStatus(), lastSuccessEpoch: NOW - HOST_DUMP_MAX_AGE_SEC - 1 } });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('stale');
  });

  it('still covers a receipt exactly at the freshness boundary', () => {
    expect(
      evaluate({ status: { ...goodStatus(), lastSuccessEpoch: NOW - HOST_DUMP_MAX_AGE_SEC } }),
    ).toMatchObject({ covered: true });
  });

  it.each([
    ['zero', 0],
    ['missing', undefined],
    ['non-numeric', 'yesterday'],
  ])('does not cover when lastSuccessEpoch is %s', (_label, lastSuccessEpoch) => {
    expect(evaluate({ status: { ...goodStatus(), lastSuccessEpoch } })).toMatchObject({
      covered: false,
    });
  });

  it('treats a future-dated receipt as a clock fault, not as coverage', () => {
    const r = evaluate({ status: { ...goodStatus(), lastSuccessEpoch: NOW + 3600 } });
    expect(r.covered).toBe(false);
    expect(r.reason).toContain('future');
  });

  it('always returns a non-empty reason, on every branch', () => {
    // The reason is written verbatim into the workspace hook.log; a blank one
    // would make an operator unable to tell WHY a dump did or did not happen.
    for (const r of [
      evaluate(),
      evaluate({ status: null }),
      evaluate({ targetSystemIdentifier: null }),
      evaluate({ database: 'absent' }),
    ]) {
      expect(r.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('hostDumpStatusPath', () => {
  it('defaults to the shared host dump directory', () => {
    expect(hostDumpStatusPath({})).toBe(`${DEFAULT_HOST_PG_DUMP_DIR}/STATUS.json`);
  });

  it('honors the shared env override', () => {
    expect(hostDumpStatusPath({ [HOST_PG_DUMP_DIR_ENV]: '/srv/dumps' })).toBe(
      '/srv/dumps/STATUS.json',
    );
  });

  it('ignores a blank override rather than resolving to a bare /STATUS.json', () => {
    expect(hostDumpStatusPath({ [HOST_PG_DUMP_DIR_ENV]: '   ' })).toBe(
      `${DEFAULT_HOST_PG_DUMP_DIR}/STATUS.json`,
    );
  });
});

describe('readHostDumpInProgress', () => {
  it('recognizes a fresh host-writer marker only for the current live PID generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-dump-progress-'));
    const dumpDir = join(root, 'dump');
    const procRoot = join(root, 'proc');
    const pid = 4242;
    const startTicks = '987654321';
    const env = {
      [HOST_PG_DUMP_DIR_ENV]: dumpDir,
      [KOPIA_BACKUP_LOCK_PATH_ENV]: join(root, 'kopia-global.lock'),
    };
    try {
      await mkdir(dumpDir, { recursive: true });
      await writeFakeProcess(procRoot, pid, startTicks);
      await writeFile(hostDumpInProgressPath(pid, env), JSON.stringify({
        pid,
        processStartTicks: startTicks,
        startedAtEpoch: NOW - 10,
        phase: 'host-backup',
      }));

      const active = await readHostDumpInProgress({ env, nowEpoch: NOW, procRoot });
      expect(active).toMatchObject({ pid, processStartTicks: startTicks, phase: 'host-backup', source: 'host-backup' });
      expect(evaluate({ inProgress: active })).toMatchObject({
        covered: false,
        inProgress: true,
        reason: expect.stringContaining('host backup is in progress'),
      });
      expect(evaluate({
        status: { ...goodStatus(), lastSuccessEpoch: NOW - HOST_DUMP_MAX_AGE_SEC - 1 },
        inProgress: active,
      })).toMatchObject({
        covered: false,
        inProgress: true,
        reason: expect.stringContaining('host backup is in progress'),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recognizes the guard run marker and a live legacy .wait marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-dump-guard-progress-'));
    const procRoot = join(root, 'proc');
    const pid = 4343;
    const startTicks = '987654322';
    const lockPath = join(root, 'kopia-global.lock');
    const env = {
      [HOST_PG_DUMP_DIR_ENV]: join(root, 'dump'),
      [KOPIA_BACKUP_LOCK_PATH_ENV]: lockPath,
    };
    try {
      await mkdir(env[HOST_PG_DUMP_DIR_ENV], { recursive: true });
      await writeFakeProcess(procRoot, pid, startTicks);
      const runPath = hostDumpGuardInProgressPath(pid, env);
      expect(runPath).toBe(`${lockPath}.db-dump.${pid}.run`);
      await writeFile(runPath, JSON.stringify({
        pid,
        processStartTicks: startTicks,
        startedAtEpoch: NOW - 10,
        phase: 'guard-queued',
      }));
      await expect(readHostDumpInProgress({ env, nowEpoch: NOW, procRoot })).resolves.toMatchObject({
        pid,
        source: 'guard',
        phase: 'guard-queued',
      });

      await rm(runPath);
      const waitPath = `${lockPath}.db-dump.${pid}.wait`;
      const commandLine = ['/bin/bash', '/opt/kopia-backup-guard.sh', '--mode', 'scheduled', '--label', 'db-dump'].join('\0') + '\0';
      await writeFakeProcess(procRoot, pid, startTicks, 'S', commandLine);
      await writeFile(waitPath, `${pid}\n`);
      const oldEnoughForTest = new Date((NOW - 10) * 1000);
      await utimes(waitPath, oldEnoughForTest, oldEnoughForTest);
      await expect(readHostDumpInProgress({ env, nowEpoch: NOW, procRoot })).resolves.toMatchObject({
        pid,
        source: 'guard-wait',
        phase: 'guard-queued',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale, future-dated, reused-PID, and zombie markers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-dump-invalid-progress-'));
    const dumpDir = join(root, 'dump');
    const procRoot = join(root, 'proc');
    const pid = 4444;
    const env = {
      [HOST_PG_DUMP_DIR_ENV]: dumpDir,
      [KOPIA_BACKUP_LOCK_PATH_ENV]: join(root, 'kopia-global.lock'),
    };
    const markerPath = hostDumpInProgressPath(pid, env);
    const row = (patch: Record<string, unknown> = {}) => ({
      pid,
      processStartTicks: '123456',
      startedAtEpoch: NOW - 10,
      phase: 'host-backup',
      ...patch,
    });
    try {
      await mkdir(dumpDir, { recursive: true });
      await writeFakeProcess(procRoot, pid, '123456');

      for (const invalid of [
        row({ startedAtEpoch: NOW - HOST_DUMP_IN_PROGRESS_MAX_AGE_SEC - 1 }),
        row({ startedAtEpoch: NOW + 1 }),
        row({ processStartTicks: '654321' }),
      ]) {
        await writeFile(markerPath, JSON.stringify(invalid));
        await expect(readHostDumpInProgress({ env, nowEpoch: NOW, procRoot })).resolves.toBeNull();
      }

      await writeFakeProcess(procRoot, pid, '123456', 'Z');
      await writeFile(markerPath, JSON.stringify(row()));
      await expect(readHostDumpInProgress({ env, nowEpoch: NOW, procRoot })).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the host marker filename contract explicit', () => {
    expect(HOST_PG_DUMP_IN_PROGRESS_PREFIX).toBe('IN_PROGRESS.');
    expect(HOST_PG_DUMP_IN_PROGRESS_SUFFIX).toBe('.json');
    expect(hostDumpInProgressPath(45, { [HOST_PG_DUMP_DIR_ENV]: '/srv/dumps' })).toBe('/srv/dumps/IN_PROGRESS.45.json');
  });
});
