import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as recorder from '../degradation/fallback-observations';

beforeEach(() => { vi.spyOn(recorder, 'observeFallback').mockReturnValue(true); });
afterEach(() => { vi.restoreAllMocks(); });
import { execFileSync } from 'node:child_process';
import {
  evaluatePrimaryCount,
  countBackgroundPrimaries,
  assertPgReadAllStatsCapabilityAtBoot,
  PG_READ_ALL_STATS_CAPABILITY_SUBJECT,
  lastRoutineFireAgeSec,
  routinesDemonstrablyFiring,
  d026QuiescenceIsActive,
  readD026QuiescenceEvidence,
  readD026QuiescenceEvidenceAsync,
  defaultIsCutQuiescing,
  defaultIsCutQuiescingAsync,
  readBackgroundPrimaryLoadState,
  readBackgroundPrimaryLoadStateAsync,
  D026_RESTORE_UNIT,
  runSinglePrimaryCheck,
  openSinglePrimaryConditions,
  _resetSinglePrimaryDebounce,
} from './single-primary-check';
import { readCutStatus, readCutStatusAsync } from '../release-cut-launch';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';

// EI-20517156511202200 fixture: `systemctl --user is-active` for the CUT unit. Node's
// execFileSync throws on a non-zero exit but still captures stdout on the thrown error —
// exactly what happens for a real `deactivating` unit (systemctl exits non-zero but prints
// the state). Modeled here instead of hitting a real systemd user session in CI.
//
// Spread the REAL module (`...actual`) rather than replacing it wholesale — a bare
// `vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))` nukes every other
// export (spawn/execFile/fork/...) for the whole file's transitive import graph, which can
// crash an unrelated module at import time (see check-no-eager-execfile-promisify.mjs).
const childProcessMocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: childProcessMocks.execFileSync };
});
const sidecarMocks = vi.hoisted(() => ({ execFileViaSidecar: vi.fn() }));
vi.mock('../fleet/git-via-sidecar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../fleet/git-via-sidecar')>();
  return { ...actual, execFileViaSidecar: sidecarMocks.execFileViaSidecar };
});

/** Answer `systemctl --user is-active <unit>` per unit, the way real systemctl does. */
function mockAsyncIsActive(stateFor: (unit: string) => string): void {
  sidecarMocks.execFileViaSidecar.mockImplementation(async (_cmd: string, args: string[]) => {
    const unit = args[2] ?? '';
    const state = stateFor(unit);
    if (state !== 'active') throw Object.assign(new Error('Command failed'), { stdout: `${state}\n` });
    return { stdout: `${state}\n`, stderr: '', code: 0 };
  });
}

function mockIsActiveOutput(state: 'active' | 'activating' | 'deactivating' | 'inactive' | 'failed'): void {
  childProcessMocks.execFileSync.mockImplementation(() => {
    if (state === 'active' || state === 'activating') return `${state}\n`;
    // real systemctl: non-zero exit, but stdout still carries the printed state.
    const err = new Error(`Command failed`) as Error & { stdout?: string };
    err.stdout = `${state}\n`;
    throw err;
  });
}

describe('evaluatePrimaryCount (pure)', () => {
  it('exactly one → healthy', () => {
    expect(evaluatePrimaryCount(1)).toMatchObject({ ok: true, key: null });
  });
  // WI-7317: still a BLOCKER (an unobservable database must never silence a real outage) but
  // no longer the `no-primary` death verdict — with no evidence argument nothing was observed.
  it('zero with no evidence at all → blocker, but the UNVERIFIED key', () => {
    expect(evaluatePrimaryCount(0)).toMatchObject({
      ok: false,
      severity: 'blocker',
      key: 'no-primary-unverified',
    });
  });
  it('two → blocker (split-brain catastrophe)', () => {
    const v = evaluatePrimaryCount(2);
    expect(v).toMatchObject({ ok: false, severity: 'blocker', key: 'split-brain-primary' });
    expect(v.summary).toContain('split-brain');
  });
  it('three → still split-brain', () => {
    expect(evaluatePrimaryCount(3).key).toBe('split-brain-primary');
  });
});

// EI-19388269294151851 — the guard broadcast "routines, git-sync and the Mug wake-loop are
// all down" for ~3.6h while git-sync committed 66 times. The count was right; the
// consequence it hardcoded was not. These pin that a count-0 with LIVE routine activity
// can never again render that text or reach the owner as a blocker.
describe('evaluatePrimaryCount — count 0 checks its consequence against live evidence', () => {
  const FIRING = { lastRoutineFireAgeSec: 42 };
  const STALE = { lastRoutineFireAgeSec: 3600 };

  it('zero WITH routines still firing → advisory, NOT a blocker', () => {
    const v = evaluatePrimaryCount(0, FIRING);
    expect(v).toMatchObject({ ok: false, severity: 'advisory', key: 'no-dedicated-primary' });
  });

  it('zero WITH routines still firing NEVER claims background work has stopped', () => {
    const s = evaluatePrimaryCount(0, FIRING).summary;
    expect(s).not.toContain('all down');
    expect(s).toContain('NOT stopped');
    // Must EXPLICITLY disclaim the death class, not merely omit it — the blocker text is
    // what agents pattern-match on. (Asserting `not.toContain('routine-engine-death')`
    // would be wrong here: it appears inside that very negation.)
    expect(s).toContain('NOT the routine-engine-death class');
    expect(s).toContain('42s ago'); // the evidence travels with the claim
  });

  it('zero with STALE routines → the real blocker, text unchanged', () => {
    const v = evaluatePrimaryCount(0, STALE);
    expect(v).toMatchObject({ ok: false, severity: 'blocker', key: 'no-primary' });
    expect(v.summary).toContain('all down');
  });

  it('a masked bg-host keeps the outage diagnosis but never recommends starting it', () => {
    const v = evaluatePrimaryCount(0, STALE, undefined, undefined, 'masked');
    expect(v).toMatchObject({ severity: 'blocker', key: 'no-primary' });
    expect(v.summary).toContain('LoadState=masked');
    expect(v.summary).toContain('Do NOT start, restart, or unmask bg-host automatically');
    expect(v.summary).not.toContain('Start the bg-host');
  });

  it('a masked bg-host with active routines remains advisory without a restore instruction', () => {
    const v = evaluatePrimaryCount(0, FIRING, undefined, undefined, 'masked');
    expect(v).toMatchObject({ severity: 'advisory', key: 'no-dedicated-primary' });
    expect(v.summary).toContain('Do NOT start, restart, or unmask bg-host automatically');
    expect(v.summary).not.toContain('Restore the bg-host');
  });

  it('an unreadable or non-loaded bg-host state requires verification before recommending a start', () => {
    const unreadable = evaluatePrimaryCount(0, STALE, undefined, undefined, null);
    const notFound = evaluatePrimaryCount(0, STALE, undefined, undefined, 'not-found');
    expect(unreadable.summary).toContain('could not verify the bg-host LoadState');
    expect(notFound.summary).toContain('LoadState=not-found');
    expect(unreadable.summary).not.toContain('Start the bg-host');
    expect(notFound.summary).not.toContain('Start the bg-host');
  });

  it('a confirmed loaded bg-host keeps the existing restore recommendation', () => {
    expect(evaluatePrimaryCount(0, STALE, undefined, undefined, 'loaded').summary).toContain('Start the bg-host');
  });

  it('zero with UNKNOWN evidence never invents a healthier read — it still pages', () => {
    // Severity is the conservative axis and does NOT move: unknown still reaches the owner.
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: null }).severity).toBe('blocker');
    expect(evaluatePrimaryCount(0).severity).toBe('blocker');
  });

  it('split-brain is unaffected by activity evidence (>1 is always a blocker)', () => {
    expect(evaluatePrimaryCount(2, FIRING)).toMatchObject({ severity: 'blocker', key: 'split-brain-primary' });
  });

  it('routinesDemonstrablyFiring: only a fresh, finite, non-negative age counts', () => {
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: 0 })).toBe(true);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: 600 })).toBe(true);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: 601 })).toBe(false);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: null })).toBe(false);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: -5 })).toBe(false);
    expect(routinesDemonstrablyFiring({ lastRoutineFireAgeSec: NaN })).toBe(false);
    expect(routinesDemonstrablyFiring(undefined)).toBe(false);
  });
});

describe('D-026 Corestore quiescence evidence', () => {
  it('reads the authoritative cut status and the registered restore unit', () => {
    const calls: string[] = [];
    const evidence = readD026QuiescenceEvidence({
      isUnitActive: (unit) => {
        calls.push(unit);
        return unit === 'papercup-release-cut' || unit === D026_RESTORE_UNIT;
      },
      // Hermetic: the real readCutStatus reads this host's cut-started marker, and a marker
      // carrying a taskId re-targets the probe to a per-task unit. So after any real cut on
      // the box, this case read cutActive:false. Pin "no marker on disk" so the probe
      // targets the default unit this case asserts.
      readCutStatus: (d) => readCutStatus({ ...d, existsSync: () => false }),
    });

    expect(evidence).toEqual({ cutActive: true, restoreActive: true });
    expect(calls).toEqual(['papercup-release-cut', D026_RESTORE_UNIT]);
  });

  it('requires both active signals before treating quiescence as protected', () => {
    expect(d026QuiescenceIsActive({ cutActive: true, restoreActive: true })).toBe(true);
    expect(d026QuiescenceIsActive({ cutActive: true, restoreActive: false })).toBe(false);
    expect(d026QuiescenceIsActive({ cutActive: false, restoreActive: true })).toBe(false);
  });

  it('reframes a stale zero-primary reading while the D-026 cut owns the Corestore lock', () => {
    const v = evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 3600 }, { cutActive: true, restoreActive: true });
    expect(v).toMatchObject({ ok: false, severity: 'advisory', key: 'no-primary-quiesced' });
    expect(v.summary).toContain('Do NOT start or restart bg-host');
    expect(v.summary).toContain('Corestore lock');
  });

  it('keeps ordinary stale zero-primary readings as blockers when either signal is absent', () => {
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 3600 }, { cutActive: true, restoreActive: false }).key).toBe('no-primary');
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 3600 }, { cutActive: false, restoreActive: true }).key).toBe('no-primary');
  });

  // EI-20517156511202200: the reported incident — the cut's main script has exited and
  // systemd is running the stop sequence (ActiveState=deactivating) while an orphaned
  // process in its cgroup still holds the Corestore lock, and the restore leg is genuinely
  // active. The old cut probe (strict active/activating) read this as "not running" and the
  // guard alarmed straight through an authorized, actively-progressing restore.
  describe('defaultIsCutQuiescing — the deactivating-but-still-holding-the-lock window', () => {
    beforeEach(() => {
      vi.mocked(execFileSync).mockReset();
    });

    it('active and activating both quiesce (unchanged behavior)', () => {
      mockIsActiveOutput('active');
      expect(defaultIsCutQuiescing('papercup-release-cut')).toBe(true);
      mockIsActiveOutput('activating');
      expect(defaultIsCutQuiescing('papercup-release-cut')).toBe(true);
    });

    it('deactivating (the reported incident) ALSO quiesces — this is the fix', () => {
      mockIsActiveOutput('deactivating');
      expect(defaultIsCutQuiescing('papercup-release-cut')).toBe(true);
    });

    it('a genuinely gone cut (inactive/failed) does NOT quiesce', () => {
      mockIsActiveOutput('inactive');
      expect(defaultIsCutQuiescing('papercup-release-cut')).toBe(false);
      mockIsActiveOutput('failed');
      expect(defaultIsCutQuiescing('papercup-release-cut')).toBe(false);
    });

    it('reproduces the reported incident end-to-end via readD026QuiescenceEvidence defaults', () => {
      // First call (cut, via readCutStatus) reads deactivating; second call (restore unit)
      // reads active — exactly what was observed at 2026-08-15T11:09Z.
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        const err = new Error('Command failed') as Error & { stdout?: string };
        err.stdout = 'deactivating\n';
        throw err;
      });
      vi.mocked(execFileSync).mockImplementationOnce(() => 'active\n');

      const evidence = readD026QuiescenceEvidence();
      expect(evidence).toEqual({ cutActive: true, restoreActive: true });
      expect(d026QuiescenceIsActive(evidence)).toBe(true);
    });
  });
});

describe('readBackgroundPrimaryLoadState', () => {
  beforeEach(() => vi.mocked(execFileSync).mockReset());

  it('reads the configured user unit LoadState', () => {
    vi.mocked(execFileSync).mockReturnValue('masked\n');
    expect(readBackgroundPrimaryLoadState('papercusp-bg-host.service')).toBe('masked');
    expect(execFileSync).toHaveBeenCalledWith(
      'systemctl',
      ['--user', 'show', 'papercusp-bg-host.service', '-p', 'LoadState', '--value'],
      { encoding: 'utf8' },
    );
  });

  it('returns unknown when the unit state is empty', () => {
    vi.mocked(execFileSync).mockReturnValue('');
    expect(readBackgroundPrimaryLoadState('papercusp-bg-host.service')).toBeNull();
  });
});

// jev-memory-timeouts-to-zero-2026-10-01: the sync readers above wait on systemctl
// with execFileSync, freezing the caller's event loop 107-237 ms per read. The
// liveness alarm and the single-primary timer now use these async twins.
describe('D-026 evidence without blocking the event loop', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset();
    sidecarMocks.execFileViaSidecar.mockReset().mockRejectedValue(new Error('Unexpected systemctl probe'));
  });
  afterEach(() => sidecarMocks.execFileViaSidecar.mockReset());

  it('probes the cut unit and the restore unit, same as the sync reader', async () => {
    const calls: string[] = [];
    const evidence = await readD026QuiescenceEvidenceAsync({
      isUnitActiveAsync: async (unit) => {
        calls.push(unit);
        return unit === D026_RESTORE_UNIT;
      },
      isCutActiveAsync: async (unit) => {
        calls.push(unit);
        return unit === 'papercup-release-cut';
      },
      // Hermetic, as in the sync case: no cut-started marker on disk.
      readCutStatusAsync: (d) => readCutStatusAsync({ ...d, existsSync: () => false }),
    });
    expect(evidence).toEqual({ cutActive: true, restoreActive: true });
    expect(calls).toEqual(['papercup-release-cut', D026_RESTORE_UNIT]);
  });

  it('keeps the deactivating rule: a stopping cut still quiesces, a stopping restore does not', async () => {
    mockAsyncIsActive((unit) => (unit === D026_RESTORE_UNIT ? 'active' : 'deactivating'));
    expect(await defaultIsCutQuiescingAsync('papercup-release-cut')).toBe(true);
    const evidence = await readD026QuiescenceEvidenceAsync({
      readCutStatusAsync: (d) => readCutStatusAsync({ ...d, existsSync: () => false }),
    });
    expect(evidence).toEqual({ cutActive: true, restoreActive: true });

    mockAsyncIsActive((unit) => (unit === D026_RESTORE_UNIT ? 'deactivating' : 'inactive'));
    expect(await defaultIsCutQuiescingAsync('papercup-release-cut')).toBe(false);
    expect(
      await readD026QuiescenceEvidenceAsync({
        readCutStatusAsync: (d) => readCutStatusAsync({ ...d, existsSync: () => false }),
      }),
    ).toEqual({ cutActive: false, restoreActive: false });
  });

  it('lets the event loop run while systemctl has not answered', async () => {
    const pending: Array<(value: { stdout: string; stderr: string; code: number }) => void> = [];
    sidecarMocks.execFileViaSidecar.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const read = readD026QuiescenceEvidenceAsync({
      readCutStatusAsync: (d) => readCutStatusAsync({ ...d, existsSync: () => false }),
    });
    let ticked = false;
    await new Promise<void>((resolve) => setTimeout(() => { ticked = true; resolve(); }, 0));
    expect(ticked).toBe(true);
    expect(pending).toHaveLength(2);
    for (const resolve of pending) resolve({ stdout: 'active\n', stderr: '', code: 0 });
    expect(await read).toEqual({ cutActive: true, restoreActive: true });
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reads the background unit LoadState, and null when systemctl fails', async () => {
    sidecarMocks.execFileViaSidecar.mockImplementationOnce(async (_cmd: string, args: string[]) => {
      expect(args).toEqual(['--user', 'show', 'papercusp-bg-host.service', '-p', 'LoadState', '--value']);
      return { stdout: 'masked\n', stderr: '', code: 0 };
    });
    expect(await readBackgroundPrimaryLoadStateAsync('papercusp-bg-host.service')).toBe('masked');
    sidecarMocks.execFileViaSidecar.mockRejectedValueOnce(new Error('no bus'));
    expect(await readBackgroundPrimaryLoadStateAsync('papercusp-bg-host.service')).toBeNull();
  });
});

// WI-7317 — absence of evidence is not evidence of death. The count-0 split originally routed
// a NULL age (i.e. "I could not observe liveness") into the `no-primary` death verdict. That is
// the input a MISRESOLVED DB handle produces, because `count` and the liveness age are read
// through the SAME handle — so the single most assertive alarm in the system fired on exactly
// the reading that proves the reader is broken. Measured live 2026-08-03: 108 active routines
// in papercusp-workspace, most recent fire 0.7s earlier, 1 live primary, while this guard
// broadcast "routines, git-sync and the Mug wake-loop are all down" on a streak of 175.
describe('evaluatePrimaryCount — an UNOBSERVED count-0 never claims the engine is dead', () => {
  const UNAVAILABLE = { lastRoutineFireAgeSec: null, status: 'unavailable' as const };
  const ABSENT = { lastRoutineFireAgeSec: null, status: 'absent' as const };

  it('a FAILED liveness read is its own condition, not the death verdict', () => {
    expect(evaluatePrimaryCount(0, UNAVAILABLE)).toMatchObject({
      severity: 'blocker',
      key: 'no-primary-unverified',
    });
  });

  it('an EMPTY liveness read is likewise unverified — a live workspace always has fire times', () => {
    expect(evaluatePrimaryCount(0, ABSENT).key).toBe('no-primary-unverified');
  });

  it.each([
    ['unavailable', UNAVAILABLE],
    ['absent', ABSENT],
    ['not gathered', undefined],
  ])('never renders the routine-engine-death text (%s)', (_label, ev) => {
    const s = evaluatePrimaryCount(0, ev).summary;
    expect(s).not.toContain('all down');
    expect(s).not.toContain('routine-engine-death');
    expect(s).toContain('UNVERIFIED');
  });

  it('warns that the COUNT is equally unverified — they share one DB handle', () => {
    // The trap that cost hours: reading count-0 as an independent corroborating observation.
    expect(evaluatePrimaryCount(0, UNAVAILABLE).summary).toContain('SAME database handle');
  });

  it('prescribes VERIFY, never "restart the bg-host" — the remediation is the real harm', () => {
    // Acting on a false no-primary blocker kills in-flight routine work and reaps headless
    // children in that cgroup (EI-9748 class), so the text must not send anyone to a restart.
    const s = evaluatePrimaryCount(0, UNAVAILABLE).summary;
    expect(s).toContain('VERIFY BEFORE ACTING');
    expect(s).not.toContain('Start the bg-host');
  });

  it('distinguishes the two unobserved causes — a wrong workspace id is diagnosable', () => {
    expect(evaluatePrimaryCount(0, UNAVAILABLE).summary).toContain('FAILED');
    expect(evaluatePrimaryCount(0, ABSENT).summary).toContain('MISRESOLVED workspace id');
  });

  it('a NEGATIVE age is clock skew, not staleness — also unverified', () => {
    // routinesDemonstrablyFiring already rejects it; it must not fall through to "stale".
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: -5 }).key).toBe('no-primary-unverified');
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: NaN }).key).toBe('no-primary-unverified');
  });

  it('a genuinely OBSERVED stale age keeps the death verdict untouched', () => {
    // The one reading that earns it: we looked, and background work really has stopped.
    const v = evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 3600, status: 'observed' });
    expect(v).toMatchObject({ severity: 'blocker', key: 'no-primary' });
    expect(v.summary).toContain('all down');
  });

  it('every non-healthy verdict carries its evidence, so the claim is auditable later', () => {
    // Nothing recorded whether liveness was ever read, which is why the 2026-08-03 diagnosis
    // needed hours of archaeology instead of one look at the escalation body.
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 42 }).evidenceNote).toContain('fired 42s ago');
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 3600 }).evidenceNote).toContain('3600s');
    expect(evaluatePrimaryCount(0, UNAVAILABLE).evidenceNote).toContain('NOT observed');
    expect(evaluatePrimaryCount(2, UNAVAILABLE).evidenceNote).toContain('NOT observed');
    expect(evaluatePrimaryCount(1).evidenceNote).toBeUndefined();
  });

  it('split-brain is still decided on the count alone', () => {
    expect(evaluatePrimaryCount(2, UNAVAILABLE).key).toBe('split-brain-primary');
    expect(evaluatePrimaryCount(2, ABSENT).key).toBe('split-brain-primary');
  });
});

describe('lastRoutineFireAgeSec', () => {
  it('returns the age reported by the injected sql', async () => {
    const sql = (async () => [{ age_sec: 12.5 }]) as never;
    expect(await lastRoutineFireAgeSec(sql)).toBe(12.5);
  });
  it('null when nothing has ever fired (fresh install) — reads as unknown', async () => {
    expect(await lastRoutineFireAgeSec((async () => [{ age_sec: null }]) as never)).toBeNull();
    expect(await lastRoutineFireAgeSec((async () => []) as never)).toBeNull();
  });

  // routines is multi-tenant: an unscoped read lets ANOTHER workspace's healthy routines
  // mask this one's dead ones, downgrading a real blocker to an advisory.
  it('binds the workspace as a parameter when one is given', async () => {
    const seen: unknown[][] = [];
    const sql = (async (_s: TemplateStringsArray, ...vals: unknown[]) => {
      seen.push(vals);
      return [{ age_sec: 1 }];
    }) as never;
    await lastRoutineFireAgeSec(sql, 'papercusp-workspace');
    expect(seen[0]).toEqual(['papercusp-workspace']);
  });

  it('omits the predicate (no stray bindings) when no workspace is given', async () => {
    const seen: unknown[][] = [];
    const sql = (async (_s: TemplateStringsArray, ...vals: unknown[]) => {
      seen.push(vals);
      return [{ age_sec: 1 }];
    }) as never;
    await lastRoutineFireAgeSec(sql);
    expect(seen[0]).toEqual([]);
  });

  // EI-27251243767353998: ephemeral-tier routines keep firing on the per-host executor
  // while DBOS is dead, so counting them false-greens a real zero-primary outage
  // (2026-10-28 18:31-19:13Z, WI-6554700010042546). Both branches must read the durable tier only.
  it.each([
    ['scoped to a workspace', 'papercusp-workspace'],
    ['unscoped', undefined],
  ])('reads ONLY durable-tier fires (%s)', async (_label, workspaceId) => {
    const texts: string[] = [];
    const sql = (async (s: TemplateStringsArray) => {
      texts.push(s.join('?'));
      return [{ age_sec: 1 }];
    }) as never;
    await lastRoutineFireAgeSec(sql, workspaceId);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/\btier\s*=\s*'durable'/);
  });
});

describe('openSinglePrimaryConditions (WI-7291 durable condition read)', () => {
  const fakeSql = (rows: unknown[], capture?: { sql?: string; vals?: unknown[] }) =>
    (async (s: TemplateStringsArray, ...vals: unknown[]) => {
      if (capture) {
        capture.sql = s.join('?');
        capture.vals = vals;
      }
      return rows;
    }) as never;

  it('returns the open condition keys the fold reports', async () => {
    const keys = await openSinglePrimaryConditions(
      fakeSql([{ key: 'single-primary:no-primary' }, { key: 'single-primary:split-brain-primary' }]),
      'ws',
    );
    expect(keys).toEqual(['single-primary:no-primary', 'single-primary:split-brain-primary']);
  });

  it('binds the workspace FIRST — the store is multi-tenant', async () => {
    // An unscoped read would all-clear another tenant's alarm off this tenant's recovery.
    const cap: { sql?: string; vals?: unknown[] } = {};
    await openSinglePrimaryConditions(fakeSql([], cap), 'papercusp-workspace');
    expect(cap.vals?.[0]).toBe('papercusp-workspace');
  });

  it('scopes to the single-primary namespace and bounds by retention', async () => {
    const cap: { sql?: string; vals?: unknown[] } = {};
    await openSinglePrimaryConditions(fakeSql([], cap), 'ws');
    // Both LIKE bindings are the guard's own namespace — it must never clear a condition
    // some other subsystem owns.
    expect(cap.vals?.filter((v) => v === 'single-primary:%').length).toBe(2);
    // A ts lower bound keeps this off the unbounded-scan path (EI-9447 furnace class).
    expect(cap.sql).toContain('ts >=');
  });

  it('matches the conditions partial index predicate so the read seeks it', async () => {
    const cap: { sql?: string; vals?: unknown[] } = {};
    await openSinglePrimaryConditions(fakeSql([], cap), 'ws');
    expect(cap.sql).toContain("surface = 'messages'");
    expect(cap.sql).toContain("body ? 'condition_key'");
  });

  it('drops null/empty keys rather than emitting a malformed all-clear', async () => {
    const keys = await openSinglePrimaryConditions(
      fakeSql([{ key: null }, { key: '' }, { key: 'single-primary:no-primary' }]),
      'ws',
    );
    expect(keys).toEqual(['single-primary:no-primary']);
  });
});

describe('countBackgroundPrimaries', () => {
  it('reads the DISTINCT dbos-executor count from the injected sql', async () => {
    const sql = (async () => [{ n: 2, can_read_all_stats: true }]) as never;
    expect(await countBackgroundPrimaries(sql)).toBe(2);
  });
  // WI-7291: this previously asserted `.toBe(0)` under the name "defaults to 0 when the
  // query returns nothing" — the defect written down as intended behaviour. A count()
  // aggregate always returns exactly one row, so an empty result means the read did not
  // happen; reporting it as 0 made "I could not look" indistinguishable from "everything
  // is dead", and paged the fleet with the routine-engine-death text on an unread count.
  it('returns null (NOT 0) when the query returns no usable row — an unread count is not a zero count', async () => {
    const sql = (async () => []) as never;
    expect(await countBackgroundPrimaries(sql)).toBeNull();
  });
  it('preserves a GENUINE zero as 0, not null — the real outage must still be reportable', async () => {
    const sql = (async () => [{ n: 0, can_read_all_stats: true }]) as never;
    expect(await countBackgroundPrimaries(sql)).toBe(0);
  });

  // EI-19442084790376701: the SECOND form of "I could not look". pg_stat_activity is
  // role-filtered — a reader that is neither superuser nor a member of pg_read_all_stats sees
  // other roles' backends with application_name NULLED, so the LIKE matches nothing and
  // count() returns a flawless 0. Measured 2026-08-03: the live DBOS backends are owned by
  // harness_admin (which HAS the privilege and reads 1); harness_app holds neither and would
  // read 0. Unlike the empty-row case above, the read SUCCEEDS and the row is well-formed, so
  // no shape check can catch it — only asking the capability question directly.
  //
  // This is the recurrence guard for the ~10h false page: one worker reporting 0 while peers
  // concurrently read 1, monotonic because the guard never reads healthy to reset its streak.
  it('returns null (NOT 0) when the reader lacks pg_read_all_stats — a zero it was not permitted to see is not an observation', async () => {
    const sql = (async () => [{ n: 0, can_read_all_stats: false }]) as never;
    expect(await countBackgroundPrimaries(sql)).toBeNull();
  });

  it('suppresses even a NON-zero count from a blind reader — an unprivileged read undercounts, it does not merely zero out', async () => {
    const sql = (async () => [{ n: 1, can_read_all_stats: false }]) as never;
    expect(await countBackgroundPrimaries(sql)).toBeNull();
  });

  // Fail-OPEN on an absent flag, deliberately: treating "missing column" as blind would make
  // the probe return null forever and silently stop reporting real outages. Only an
  // affirmative false suppresses. This also pins the back-compat the two tests above rely on.
  it('treats an ABSENT can_read_all_stats as permitted, so a driver quirk cannot silently disable the guard', async () => {
    _resetSinglePrimaryDebounce(); // clear the once-per-process announce latch
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sql = (async () => [{ n: 2 }]) as never;
      expect(await countBackgroundPrimaries(sql)).toBe(2);

      // FAIL OPEN *AND ANNOUNCE* (su-4ca244e4). Fail-open alone would silently revert to the
      // pre-fix behaviour — a restricted reader reporting a confident 0 — with nothing
      // recording that the protection had evaporated, which is this same defect class one
      // level up. The warning is what makes "running unprotected" observable rather than
      // inferred, so it is asserted, not merely tolerated.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain('capability probe UNAVAILABLE');

      // …and it LATCHES: once per process, not once per 3-minute tick.
      await countBackgroundPrimaries(sql);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('evaluatePrimaryCount — unread count (WI-7291)', () => {
  it('never emits the routine-engine-death text when the count was not read', () => {
    const verdict = evaluatePrimaryCount(null);
    expect(verdict.key).toBe('no-primary-unverified');
    expect(verdict.countObserved).toBe(false);
    expect(verdict.summary).not.toContain('are all down');
    expect(verdict.summary).not.toContain('NO background primary running');
  });

  it('still pages — an unreadable database must not SILENCE a real outage', () => {
    const verdict = evaluatePrimaryCount(null);
    expect(verdict.ok).toBe(false);
    expect(verdict.severity).toBe('blocker');
  });

  // The regression that motivated checking count===null FIRST: a liveness read that
  // succeeds and reports a stale age would otherwise fall through to the `no-primary`
  // death verdict on a count nobody ever obtained.
  it('an unread count outranks a successful stale-liveness read', () => {
    const verdict = evaluatePrimaryCount(null, {
      lastRoutineFireAgeSec: 9999,
      status: 'observed',
    });
    expect(verdict.key).toBe('no-primary-unverified');
    expect(verdict.summary).not.toContain('NO background primary running');
  });

  it('a genuine zero still earns the death verdict when liveness confirms it', () => {
    const verdict = evaluatePrimaryCount(0, {
      lastRoutineFireAgeSec: 9999,
      status: 'observed',
    });
    expect(verdict.key).toBe('no-primary');
    expect(verdict.countObserved).not.toBe(false);
  });
});

describe('assertPgReadAllStatsCapabilityAtBoot (EI-19447868110362941)', () => {
  it('opens one actionable blocker when the host role lacks stats visibility', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray) => [
      { role_name: 'harness_admin', can_read_all_stats: false },
    ]);
    const openEscalation = vi.fn(async (_input: unknown) => ({ msg_id: 'stats-missing', repeatCount: 1 }));
    const notifyAttention = vi.fn(async (_input: unknown) => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        assertPgReadAllStatsCapabilityAtBoot({
          sql: sql as never,
          openEscalation: openEscalation as never,
          notifyAttention: notifyAttention as never,
        }),
      ).resolves.toBe('missing');

      expect(sql).toHaveBeenCalledTimes(1);
      const query = sql.mock.calls[0]?.[0].join(' ') ?? '';
      expect(query).toContain("pg_has_role(current_user, 'pg_read_all_stats', 'member')");
      expect(query).toContain('pg_roles');
      expect(openEscalation).toHaveBeenCalledTimes(1);
      expect(openEscalation.mock.calls[0]?.[0]).toMatchObject({
        severity: 'blocker',
        meta: { subjectSignature: PG_READ_ALL_STATS_CAPABILITY_SUBJECT },
      });
      expect(notifyAttention).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it('does not send another urgent page while the same blocker is already open', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray) => [
      { role_name: 'harness_admin', can_read_all_stats: false },
    ]);
    const openEscalation = vi.fn(async (_input: unknown) => ({ msg_id: 'stats-missing', repeatCount: 2 }));
    const notifyAttention = vi.fn(async (_input: unknown) => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        assertPgReadAllStatsCapabilityAtBoot({
          sql: sql as never,
          openEscalation: openEscalation as never,
          notifyAttention: notifyAttention as never,
        }),
      ).resolves.toBe('missing');

      expect(openEscalation).toHaveBeenCalledTimes(1);
      expect(notifyAttention).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('resolves the prior blocker once a later boot confirms the role capability', async () => {
    const sql = vi.fn(async (_query: TemplateStringsArray) => [
      { role_name: 'harness_admin', can_read_all_stats: true },
    ]);
    const listOpenEscalations = vi.fn(async (_subject: string) => [{
      ts: '2026-10-10T10:00:00.000Z',
      msg_id: 'stats-missing',
      from: 'system-health',
      to: ['human'],
      kind: 'escalation',
      severity: 'blocker',
      summary: 'stats visibility missing',
      resolved: null,
    } satisfies EscalationRecord]);
    const resolveEscalation = vi.fn(async (_msgId: string, _note: string) => ({ kind: 'resolved' }));

    await expect(
      assertPgReadAllStatsCapabilityAtBoot({
        sql: sql as never,
        listOpenEscalations,
        resolveEscalation,
      }),
    ).resolves.toBe('available');

    expect(sql).toHaveBeenCalledTimes(1);
    expect(listOpenEscalations).toHaveBeenCalledWith(PG_READ_ALL_STATS_CAPABILITY_SUBJECT);
    expect(resolveEscalation).toHaveBeenCalledWith(
      'stats-missing',
      'Boot assertion confirms current_user can read pg_stat_activity across roles.',
    );
  });
});

describe('runSinglePrimaryCheck (hysteresis + debounce + self-clear)', () => {
  beforeEach(() => _resetSinglePrimaryDebounce());

  it('escalates only after a SUSTAINED 0 (hysteresis), then debounces within the window', async () => {
    const calls: Array<{ severity: string; summary: string }> = [];
    const escalate = async (input: { severity: string; summary: string }) => { calls.push(input); return { msg_id: 'esc-1' }; };
    let now = 100 * 60_000;
    // routineFireAgeSec null = unknown ⇒ the count-only blocker path these assertions target.
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => null,
      escalate,
      now: () => now,
      debounceMs: 30 * 60_000,
    };

    // 1st tick: streak 1 < 2 → no fire (a single transient blip is suppressed).
    const a = await runSinglePrimaryCheck('ws', deps);
    expect(a.fired).toBe(false);
    expect(calls.length).toBe(0);

    // 2nd consecutive tick: streak 2 → fire.
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);
    expect(b.fired).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].summary).toContain('[single-primary]');

    // within the debounce window → no re-fire.
    now += 5 * 60_000;
    const c = await runSinglePrimaryCheck('ws', deps);
    expect(c.fired).toBe(false);
    expect(calls.length).toBe(1);

    // after the debounce window → fire again.
    now += 30 * 60_000;
    const d = await runSinglePrimaryCheck('ws', deps);
    expect(d.fired).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('a single transient 0 then recovery NEVER reaches the owner (the false-positive class)', async () => {
    const calls: unknown[] = [];
    const escalate = async (i: unknown) => { calls.push(i); return { msg_id: 'x' }; };
    // one 0 sample (a bg-host reconnect/restart blip)…
    const a = await runSinglePrimaryCheck('ws', {
      count: async () => 0,
      routineFireAgeSec: async () => null,
      escalate,
      now: () => 1,
    });
    expect(a.fired).toBe(false);
    // …then the next check is healthy again.
    const b = await runSinglePrimaryCheck('ws', { count: async () => 1, escalate, now: () => 2 });
    expect(b.fired).toBe(false);
    expect(calls.length).toBe(0); // the blip was absorbed by hysteresis
  });

  it('does NOT escalate when exactly one primary is live', async () => {
    const calls: unknown[] = [];
    const r = await runSinglePrimaryCheck('ws', { count: async () => 1, escalate: async (i) => { calls.push(i); }, now: () => 1 });
    expect(r.fired).toBe(false);
    expect(r.verdict.ok).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('withholds start advice when the systemd LoadState probe fails', async () => {
    const calls: Array<{ summary: string }> = [];
    const result = await runSinglePrimaryCheck('ws', {
      count: async () => 0,
      routineFireAgeSec: async () => 3600,
      backgroundUnitLoadState: async () => { throw new Error('systemctl unavailable'); },
      escalate: async (input) => { calls.push(input); return { msg_id: 'masked-probe-1' }; },
      now: () => 100 * 60_000,
      sustainTicks: 1,
    });
    expect(result.verdict.summary).toContain('systemd could not verify the bg-host LoadState');
    expect(result.verdict.summary).not.toContain('Start the bg-host');
    expect(calls[0]?.summary).toContain(result.verdict.summary);
  });

  it('escalates on a SUSTAINED split-brain (>1)', async () => {
    const calls: Array<{ summary: string }> = [];
    const escalate = async (i: { summary: string }) => { calls.push(i); return { msg_id: 'sb-1' }; };
    let now = 0;
    const deps = { count: async () => 2, routineFireAgeSec: async () => null, escalate, now: () => now };
    expect((await runSinglePrimaryCheck('ws', deps)).fired).toBe(false); // streak 1
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);
    expect(b.fired).toBe(true);
    expect(calls[0].summary).toContain('split-brain');
  });

  it('EI-19400981259017885: a SECOND process observing the SAME already-open condition does NOT re-page (only escalate() dedups did before this fix)', async () => {
    // Simulates the real multi-process shape: `startSinglePrimaryGuard()` runs on every
    // hono-host worker, each with its OWN in-process consecutiveNon1/lastAlertedAt state
    // (reset here via _resetSinglePrimaryDebounce between "processes"), but all sharing
    // ONE durable escalation store — modeled here as `openState`, which is exactly what
    // openEscalation's cross-process dedup-by-subject-signature gives in production: a
    // second escalate() call for the same still-open condition returns the SAME record
    // with `repeatCount` bumped, rather than creating a fresh row.
    let openState: { msgId: string; repeatCount: number } | null = null;
    const escalate = async () => {
      if (openState) {
        openState = { ...openState, repeatCount: openState.repeatCount + 1 };
        return { msg_id: openState.msgId, repeatCount: openState.repeatCount };
      }
      openState = { msgId: 'shared-esc-1', repeatCount: 1 };
      return { msg_id: openState.msgId, repeatCount: openState.repeatCount };
    };
    const paged: unknown[] = [];
    const page = async (v: unknown) => { paged.push(v); };

    // Process A: sustains 2 ticks, fires — this is the FIRST opener, so it pages.
    let now = 0;
    const depsA = { count: async () => 0, routineFireAgeSec: async () => null, escalate, page, now: () => now };
    expect((await runSinglePrimaryCheck('ws', depsA)).fired).toBe(false); // streak 1
    now += 3 * 60_000;
    const a = await runSinglePrimaryCheck('ws', depsA);
    expect(a.fired).toBe(true);
    expect(paged.length).toBe(1); // A is the first opener — pages once.

    // Process B: independent in-memory state (its own consecutiveNon1/lastAlertedAt —
    // simulated by resetting the module Maps), but reaches its OWN sustained streak
    // moments later against the SAME durable condition A already opened.
    _resetSinglePrimaryDebounce();
    let nowB = 0;
    const depsB = { count: async () => 0, routineFireAgeSec: async () => null, escalate, page, now: () => nowB };
    expect((await runSinglePrimaryCheck('ws', depsB)).fired).toBe(false); // streak 1
    nowB += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', depsB);
    expect(b.fired).toBe(true); // B still records/escalates (audit trail intact)…
    expect(paged.length).toBe(1); // …but does NOT re-page: openState.repeatCount was 2.
  });

  // EI-19442084790376701 — THE PAGE-LOOP. `alreadyPagedByPeer` only suppresses while the
  // escalation is still OPEN. WI-7291 has a peer that reads a healthy count all-clear it,
  // which RESOLVES the row — so the next escalate() gets a FRESH record with repeatCount 1
  // and the pager re-arms. One stuck reader then pages the fleet every debounce window
  // forever (measured 2026-08-03: every 30min for ~10h, streak past 266, each alarm followed
  // ~2min later by a peer's all-clear). Modeled here by clearing `openState` between cycles,
  // which is exactly what a peer's resolve does to the durable store.
  const mkSharedEscalate = (openState: { v: { msgId: string; repeatCount: number } | null }) => async () => {
    openState.v = openState.v
      ? { ...openState.v, repeatCount: openState.v.repeatCount + 1 }
      : { msgId: 'esc-1', repeatCount: 1 };
    return { msg_id: openState.v.msgId, repeatCount: openState.v.repeatCount };
  };

  it('does NOT re-page after a peer observed a healthy count and all-cleared our previous page', async () => {
    const openState = { v: null as { msgId: string; repeatCount: number } | null };
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => null,
      escalate: mkSharedEscalate(openState),
      page: async (v: unknown) => { paged.push(v); },
      // The peer already all-cleared: this condition is NOT durably open.
      openConditions: async () => [] as string[],
      now: () => now,
    };

    expect((await runSinglePrimaryCheck('ws', deps)).fired).toBe(false); // streak 1
    now += 3 * 60_000;
    expect((await runSinglePrimaryCheck('ws', deps)).fired).toBe(true);
    // The FIRST page is never suppressed — "not currently open" is also true of a real
    // outage nobody has reported yet, so it can never be the suppression signal on its own.
    expect(paged.length).toBe(1);

    // A peer reads healthy and all-clears: the durable escalation row is RESOLVED, which is
    // what re-armed the pager before this fix.
    openState.v = null;
    now += 31 * 60_000; // past debounceMs

    const again = await runSinglePrimaryCheck('ws', deps);
    expect(again.fired).toBe(true);  // still ESCALATED — the disagreement stays durable/visible…
    expect(paged.length).toBe(1);    // …but the urgent page is SUPPRESSED. Pre-fix this was 2.
  });

  it('fails OPEN — a failed openConditions read must never suppress a page', async () => {
    const openState = { v: null as { msgId: string; repeatCount: number } | null };
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => null,
      escalate: mkSharedEscalate(openState),
      page: async (v: unknown) => { paged.push(v); },
      openConditions: async () => { throw new Error('durable read failed'); },
      now: () => now,
    };

    expect((await runSinglePrimaryCheck('ws', deps)).fired).toBe(false);
    now += 3 * 60_000;
    await runSinglePrimaryCheck('ws', deps);
    expect(paged.length).toBe(1);

    openState.v = null;
    now += 31 * 60_000;
    await runSinglePrimaryCheck('ws', deps);
    // Suppression requires POSITIVE evidence a peer falsified us — never the absence of a
    // successful read, which would let a flaky query silence a real outage.
    expect(paged.length).toBe(2);
  });

  it('SELF-CLEARS its own escalation when the count returns to 1', async () => {
    const escalations: unknown[] = [];
    const resolves: Array<{ msg_id: string; choice: string }> = [];
    let now = 0;
    const base = {
      escalate: async (i: unknown) => { escalations.push(i); return { msg_id: 'esc-99' }; },
      resolve: async (i: { msg_id: string; choice: string }) => { resolves.push(i); },
      now: () => now,
      sustainTicks: 1, // fire immediately for the self-clear assertion
    };

    // fire on 0…
    const a = await runSinglePrimaryCheck('ws', {
      ...base,
      count: async () => 0,
      routineFireAgeSec: async () => null,
    });
    expect(a.fired).toBe(true);
    expect(escalations.length).toBe(1);
    expect(resolves.length).toBe(0);

    // …recover to 1 → the open escalation auto-resolves.
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', { ...base, count: async () => 1 });
    expect(b.fired).toBe(false);
    expect(b.selfCleared).toBe(true);
    expect(resolves.length).toBe(1);
    expect(resolves[0].msg_id).toBe('esc-99');
    expect(resolves[0].choice).toBe('auto-resolved-recovered');

    // a second healthy tick does NOT re-resolve (the alarm is already cleared).
    const c = await runSinglePrimaryCheck('ws', { ...base, count: async () => 1 });
    expect(c.selfCleared).toBe(false);
    expect(resolves.length).toBe(1);
  });

  // ── WI-7291: the all-clear must be driven by DURABLE state, not per-process memory ──
  //
  // THE REGRESSION THIS PINS: the guard runs on every request worker, and the fleet
  // all-clear used to be keyed off an in-process map — so it fired only when the SAME
  // process both alarmed and later saw the recovery. Measured live on
  // `single-primary:no-primary`: 122 alarms since 2026-07-11, 60 resolutions, ALL of them
  // on or before 2026-07-21; the 40+ alarms since produced none, leaving the condition
  // continuously open and re-escalating via condition-staleness-alarm every ~30 min
  // (59 in one 12h window). If these fail, that flood is back.
  it('all-clears a condition THIS process never alarmed (the cross-process case)', async () => {
    const paged: string[][] = [];
    // A pristine process: it has no in-memory record of any alarm — exactly the state of a
    // worker that just booted, or that simply was not the one that alarmed.
    const r = await runSinglePrimaryCheck('ws', {
      count: async () => 1,
      openConditions: async () => ['single-primary:no-primary'],
      pageResolved: async (keys) => { paged.push(keys); },
    });

    expect(r.fired).toBe(false);
    expect(r.selfCleared).toBe(true);
    // Bare key: defaultPageResolved re-applies the `single-primary:` namespace itself, so
    // passing the qualified key through would double-prefix and supersede nothing.
    expect(paged).toEqual([['no-primary']]);
  });

  it('emits NOTHING when durable state shows no open condition (no all-clear spam)', async () => {
    const paged: string[][] = [];
    const r = await runSinglePrimaryCheck('ws', {
      count: async () => 1,
      openConditions: async () => [],
      pageResolved: async (keys) => { paged.push(keys); },
    });

    expect(r.selfCleared).toBe(false);
    expect(paged).toEqual([]);
  });

  it('a FAILING durable read degrades to silence, never to a false all-clear', async () => {
    // The only direction that could hide a real outage: an unreadable condition store must
    // never be reported as "recovered".
    const paged: string[][] = [];
    const r = await runSinglePrimaryCheck('ws', {
      count: async () => 1,
      openConditions: async () => { throw new Error('pg down'); },
      pageResolved: async (keys) => { paged.push(keys); },
    });

    expect(r.selfCleared).toBe(false);
    expect(paged).toEqual([]);
  });

  it('all-clears EVERY open key at once, including one no live verdict can produce', async () => {
    // A recovery must drain the whole namespace, not just the key this tick happens to
    // know about — `split-brain-primary` can be left open by a process that has since
    // died, and no live verdict will ever name it again.
    const paged: string[][] = [];
    await runSinglePrimaryCheck('ws', {
      count: async () => 1,
      openConditions: async () => [
        'single-primary:no-primary',
        'single-primary:split-brain-primary',
      ],
      pageResolved: async (keys) => { paged.push(keys); },
    });

    expect(paged).toEqual([['no-primary', 'split-brain-primary']]);
  });

  it('is EDGE-triggered: a resolved condition drops out and stops re-clearing', async () => {
    // The durable fold reports a key only while its latest alarm is newer than its latest
    // resolution, so one recovery emits exactly one all-clear.
    const paged: string[][] = [];
    let open = ['single-primary:no-primary'];
    const deps = {
      count: async () => 1,
      openConditions: async () => open,
      pageResolved: async (keys: string[]) => { paged.push(keys); open = []; },
    };

    await runSinglePrimaryCheck('ws', deps);
    await runSinglePrimaryCheck('ws', deps);
    await runSinglePrimaryCheck('ws', deps);

    expect(paged).toEqual([['no-primary']]);
  });

  // EI-19388269294151851: the 2026-08-03 incident, end to end. A sustained count of 0
  // while routines keep firing must be RECORDED but must never urgent-page the owner or
  // fire the "everything is down" fleet broadcast.
  it('sustained 0 WITH routines firing: records an advisory and NEVER pages', async () => {
    const escalated: Array<{ severity: string; summary: string }> = [];
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => 42, // git-sync et al demonstrably alive
      escalate: async (i: { severity: string; summary: string }) => { escalated.push(i); return { msg_id: 'adv-1' }; },
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };

    expect((await runSinglePrimaryCheck('ws', deps)).fired).toBe(false); // streak 1, hysteresis
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);

    expect(b.fired).toBe(true);
    expect(b.verdict.key).toBe('no-dedicated-primary');
    expect(escalated).toHaveLength(1);
    expect(escalated[0].severity).toBe('advisory');
    expect(escalated[0].summary).not.toContain('all down');
    expect(paged).toHaveLength(0); // the owner is NOT urgent-paged
  });

  it('sustained 0 with routines STALE still pages — the real outage is untouched', async () => {
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => 4000, // nothing has fired in over an hour
      escalate: async () => ({ msg_id: 'blk-1' }),
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };
    await runSinglePrimaryCheck('ws', deps);
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);

    expect(b.verdict.key).toBe('no-primary');
    expect(b.verdict.severity).toBe('blocker');
    expect(paged).toHaveLength(1);
  });

  it('a failing evidence query degrades to the blocker, never to silence', async () => {
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => { throw new Error('pg down'); },
      escalate: async () => ({ msg_id: 'blk-2' }),
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };
    await runSinglePrimaryCheck('ws', deps);
    now += 3 * 60_000;
    const b = await runSinglePrimaryCheck('ws', deps);
    // WI-7317: the SEVERITY is unchanged — it still pages — but the read failed, so the
    // verdict says so instead of asserting the engine is dead.
    expect(b.verdict.key).toBe('no-primary-unverified');
    expect(b.verdict.severity).toBe('blocker');
    expect(paged).toHaveLength(1);
  });

  // WI-7317: the caller is what knows WHY the age is null — the tick distinguishes a read that
  // threw from one that returned nothing, and evaluatePrimaryCount cannot recover that after
  // the fact. These pin the wiring, not just the pure function.
  it('classifies a THROWN liveness read as unavailable and an EMPTY one as absent', async () => {
    const run = (routineFireAgeSec: () => Promise<number | null>) =>
      runSinglePrimaryCheck('ws', {
        count: async () => 0,
        routineFireAgeSec,
        escalate: async () => ({ msg_id: 'e' }),
        page: async () => {},
        sustainTicks: 1,
        now: () => 0,
      });

    _resetSinglePrimaryDebounce();
    const threw = await run(async () => { throw new Error('pg down'); });
    expect(threw.verdict.evidenceNote).toContain('unavailable');
    expect(threw.verdict.summary).toContain('FAILED');

    _resetSinglePrimaryDebounce();
    const empty = await run(async () => null);
    expect(empty.verdict.evidenceNote).toContain('absent');
    expect(empty.verdict.summary).toContain('MISRESOLVED workspace id');
  });

  it('records the observed evidence in the durable escalation body', async () => {
    // The 2026-08-03 alarm recorded its conclusion and none of its evidence, so nobody could
    // tell from the record whether liveness had ever been read.
    const bodies: string[] = [];
    const r = await runSinglePrimaryCheck('ws', {
      count: async () => 0,
      routineFireAgeSec: async () => 42,
      escalate: async (i: { body?: string }) => { bodies.push(i.body ?? ''); return { msg_id: 'e' }; },
      page: async () => {},
      sustainTicks: 1,
      now: () => 0,
    });
    expect(r.verdict.key).toBe('no-dedicated-primary');
    expect(bodies[0]).toContain('Routine-liveness evidence');
    expect(bodies[0]).toContain('fired 42s ago');
  });

  it('sustained stale zero-primary during D-026 quiescence records advisory context and never pages', async () => {
    const paged: unknown[] = [];
    const escalated: Array<{ severity: string; summary: string }> = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => 4000,
      d026Quiescence: async () => ({ cutActive: true, restoreActive: true }),
      escalate: async (i: { severity: string; summary: string }) => { escalated.push(i); return { msg_id: 'd026-1' }; },
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };

    await runSinglePrimaryCheck('ws', deps);
    now += 3 * 60_000;
    const result = await runSinglePrimaryCheck('ws', deps);

    expect(result.verdict.key).toBe('no-primary-quiesced');
    expect(result.verdict.severity).toBe('advisory');
    expect(escalated).toHaveLength(1);
    expect(escalated[0].summary).toContain('Do NOT start or restart bg-host');
    expect(paged).toHaveLength(0);
  });
});

// EI-22040647386284200: a SECOND, broader quiesce signal — a self-reported, bounded-duration
// announcement (announced-quiesce.ts) for an ad-hoc quiesce (manual kill + shell EXIT trap)
// that leaves no D-026 systemd trace at all. Weaker evidence than D-026, so checked second;
// still authorized to replace "Start the bg-host" with the announcer's own window.
describe('announced-quiesce evidence (EI-22040647386284200)', () => {
  it('evaluatePrimaryCount: an active announced quiesce reframes a stale zero-primary reading', () => {
    const v = evaluatePrimaryCount(
      0,
      { lastRoutineFireAgeSec: 3600 },
      undefined,
      { active: true, subject: 'bg-host', reason: 'P-101 seed re-cut', by: 'su-0300e', until: '2026-09-01T22:40:00.000Z' },
    );
    expect(v).toMatchObject({ ok: false, severity: 'advisory', key: 'no-primary-announced-quiesce' });
    expect(v.summary).toContain('Do NOT start or restart bg-host');
    expect(v.summary).toContain('P-101 seed re-cut');
    expect(v.summary).toContain('su-0300e');
  });

  it('evaluatePrimaryCount: an inactive/absent announced quiesce falls through to the ordinary blocker', () => {
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 3600 }, undefined, { active: false }).key).toBe('no-primary');
    expect(evaluatePrimaryCount(0, { lastRoutineFireAgeSec: 3600 }, undefined, undefined).key).toBe('no-primary');
  });

  it('evaluatePrimaryCount: D-026 is checked FIRST — a systemd-verified quiescence wins even when an announced-quiesce arg is also present', () => {
    const v = evaluatePrimaryCount(
      0,
      { lastRoutineFireAgeSec: 3600 },
      { cutActive: true, restoreActive: true },
      { active: true, subject: 'bg-host', reason: 'unrelated announcement', by: 'someone-else' },
    );
    expect(v.key).toBe('no-primary-quiesced');
  });

  it('runSinglePrimaryCheck: a sustained stale zero-primary during an active announced quiesce records advisory context and never pages', async () => {
    const paged: unknown[] = [];
    const escalated: Array<{ severity: string; summary: string }> = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => 4000,
      announcedQuiescence: async () => ({
        active: true,
        subject: 'bg-host',
        reason: 'P-101 seed re-cut',
        by: 'su-0300e',
        until: '2026-09-01T22:40:00.000Z',
      }),
      escalate: async (i: { severity: string; summary: string }) => { escalated.push(i); return { msg_id: 'aq-1' }; },
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };

    await runSinglePrimaryCheck('ws', deps);
    now += 3 * 60_000;
    const result = await runSinglePrimaryCheck('ws', deps);

    expect(result.verdict.key).toBe('no-primary-announced-quiesce');
    expect(result.verdict.severity).toBe('advisory');
    expect(escalated).toHaveLength(1);
    expect(escalated[0].summary).toContain('Do NOT start or restart bg-host');
    expect(paged).toHaveLength(0);
  });

  it('runSinglePrimaryCheck: a THROWING announcedQuiescence dep fails closed — never suppresses a real page (fail-closed, same rule as D-026)', async () => {
    const paged: unknown[] = [];
    let now = 0;
    const deps = {
      count: async () => 0,
      routineFireAgeSec: async () => null,
      announcedQuiescence: async () => { throw new Error('pg unreachable'); },
      escalate: async () => ({ msg_id: 'e' }),
      page: async (v: unknown) => { paged.push(v); },
      now: () => now,
    };

    await runSinglePrimaryCheck('ws', deps);
    now += 3 * 60_000;
    const result = await runSinglePrimaryCheck('ws', deps);

    expect(result.verdict.key).not.toBe('no-primary-announced-quiesce');
  });
});
