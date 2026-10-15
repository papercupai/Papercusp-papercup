import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
vi.mock('../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true),
  broadcastSevereEventResolved: vi.fn(async () => true) }));
vi.mock('../agent-tools/coordination/tools/conditions', () => ({ readConditionEnvelopes: async () => [],
  computeConditionStates: () => [], readLatestConditionEnvelope: vi.fn(async () => null) }));
vi.mock('../attention-notify', () => ({ notifyAttention: vi.fn(async () => {}), notifyAttentionOnce: vi.fn(async () => {}) }));
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AttentionNotifyInput } from '../attention-notify';
import { readLatestConditionEnvelope } from '../agent-tools/coordination/tools/conditions';
import { RETENTION_POLICY, type RetentionClass } from './retention-policy';
import { listDiskRootChildrenAsync } from './disk';
vi.mock('./disk', async (importOriginal) => ({
  ...await importOriginal<typeof import('./disk')>(),
  listDiskRootChildrenAsync: vi.fn(async () => ({ entries: [], truncated: false })),
}));
import {
  detectLowSpace,
  detectCriticalWriteHeadroom,
  criticalWriteHeadroomBytes,
  describeWriteHeadroomBreach,
  describeWriteHeadroomBreaches,
  diskEscalationTier,
  formatDiskEscalation,
  formatDiskAlarmToast,
  runDiskSpaceAlarmOnce as runDiskSpaceAlarmWithDefaults,
  diskPolicyFromEnv,
  watchedPaths,
  alarmWatchedPaths,
  mountPointOf,
  sampleDiskSnapshots,
  DEFAULT_DISK_POLICY,
  DISK_SPACE_ALARM_CONDITION_KEY,
  type DiskSnapshot,
  type DiskAlarmPolicy,
  type DiskAlarmContext,
} from './disk-space-alarm';

const GIB = 1024 ** 3;

// Unit fixtures never touch the live census/cooldown database.
function runDiskSpaceAlarmOnce(deps: Parameters<typeof runDiskSpaceAlarmWithDefaults>[0] = {}, policy?: DiskAlarmPolicy) {
  return runDiskSpaceAlarmWithDefaults({ readContext: async () => ({ devices: [], receipt: null }), recentlyEscalated: async () => false, ...deps }, policy);
}

function snap(p: Partial<DiskSnapshot> = {}): DiskSnapshot {
  // A healthy default: 500 GB total, 250 GB free (50%), inodes 50% free.
  const totalBytes = 500 * GIB;
  const freeBytes = 250 * GIB;
  const totalInodes = 1_000_000;
  const freeInodes = 500_000;
  return {
    path: '/ws',
    totalBytes,
    freeBytes,
    freePct: freeBytes / totalBytes,
    totalInodes,
    freeInodes,
    freeInodesPct: freeInodes / totalInodes,
    ...p,
  };
}

describe('detectLowSpace', () => {
  it('returns nothing when every filesystem is healthy', () => {
    expect(detectLowSpace([snap(), snap({ path: '/tmp' })])).toEqual([]);
  });

  it('flags low-bytes when below the absolute byte floor (even at a fine percentage)', () => {
    // Huge disk: 4 GB free of 10 TB = 0.04% — below the 5 GB floor though %-ish ok-looking only at the floor.
    const b = detectLowSpace([snap({ totalBytes: 10000 * GIB, freeBytes: 4 * GIB, freePct: 4 / 10000 })]);
    expect(b).toHaveLength(1);
    expect(b[0].kinds).toContain('low-bytes');
  });

  it('flags low-bytes when below the % floor', () => {
    const b = detectLowSpace([snap({ totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 })]); // 8% < 10%
    expect(b[0].kinds).toEqual(['low-bytes']);
  });

  it('flags low-inodes when inode headroom is below the floor', () => {
    const b = detectLowSpace([snap({ totalInodes: 1_000_000, freeInodes: 30_000, freeInodesPct: 0.03 })]); // 3% < 5%
    expect(b).toHaveLength(1);
    expect(b[0].kinds).toEqual(['low-inodes']);
  });

  it('reports BOTH kinds when bytes and inodes are both low', () => {
    const b = detectLowSpace([
      snap({ freeBytes: 1 * GIB, freePct: 1 / 500, freeInodes: 10_000, freeInodesPct: 0.01 }),
    ]);
    expect(b[0].kinds.sort()).toEqual(['low-bytes', 'low-inodes']);
  });

  it('skips the inode check on filesystems that do not report inodes (totalInodes === 0)', () => {
    // btrfs-style: no inode accounting. A 0% inode figure must NOT alarm.
    expect(detectLowSpace([snap({ totalInodes: 0, freeInodes: 0, freeInodesPct: 0 })])).toEqual([]);
  });

  it('honors a custom policy', () => {
    const strict: DiskAlarmPolicy = {
      freePctMin: 0.6,
      freeBytesMin: 0,
      freeInodesPctMin: 0,
      criticalFreePctMin: 0,
      criticalFreeBytesMin: 0,
      // Not under test here: this case isolates freePctMin. Inherit the default cap
      // rather than restating 64 GiB — and never omit it, since an absent cap falls
      // back to POSITIVE_INFINITY, i.e. the unbounded proportional reserve this
      // field exists to bound.
      criticalFreeBytesCap: DEFAULT_DISK_POLICY.criticalFreeBytesCap,
    };
    expect(detectLowSpace([snap()], strict)[0].kinds).toEqual(['low-bytes']); // 50% < 60%
  });
});

// EI-20090527288494606: the warning tier is a UI toast nobody consumes. Severity is
// what decides whether a human is actually reached, so it needs its own guards.
describe('detectLowSpace severity tiering', () => {
  it('marks a merely-low filesystem as warning, NOT critical', () => {
    // 8% free of 500 GB = 40 GB — under the 10% warn floor, well over both critical floors.
    const b = detectLowSpace([snap({ totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 })]);
    expect(b[0].severity).toBe('warning');
  });

  it('marks a filesystem under the critical % floor as critical', () => {
    // The condition measured on this box: 17.6 GB free of 1875.7 GB = 0.9% — a huge
    // disk that is nowhere near the absolute byte floor but is proportionally doomed.
    const b = detectLowSpace([snap({ totalBytes: 1875.7 * GIB, freeBytes: 17.6 * GIB, freePct: 0.0094 })]);
    expect(b[0].severity).toBe('critical');
  });

  it('marks a filesystem under the critical BYTE floor as critical even at a healthy percentage', () => {
    // Small disk: 1 GB free of 20 GB = 5%. Over the 2% floor, under the 2 GB floor.
    const b = detectLowSpace([snap({ totalBytes: 20 * GIB, freeBytes: 1 * GIB, freePct: 0.05 })]);
    expect(b[0].severity).toBe('critical');
  });

  it('does NOT escalate on an inode-only breach (bytes are what kill a write mid-copy)', () => {
    const b = detectLowSpace([snap({ totalInodes: 1_000_000, freeInodes: 30_000, freeInodesPct: 0.03 })]);
    expect(b[0].kinds).toEqual(['low-inodes']);
    expect(b[0].severity).toBe('warning');
  });
});

describe('detectCriticalWriteHeadroom', () => {
  it('allows the warning band but refuses the critical byte band', () => {
    // 8% free is intentionally an alarm warning, not a reason to burn no verdict.
    expect(
      detectCriticalWriteHeadroom([
        snap({ totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 }),
      ]),
    ).toEqual([]);

    const critical = detectCriticalWriteHeadroom([
      snap({ totalBytes: 500 * GIB, freeBytes: 4 * GIB, freePct: 0.008 }),
    ]);
    expect(critical).toHaveLength(1);
    expect(critical[0].kinds).toContain('low-bytes');
  });

  it('still refuses low inode headroom because inode exhaustion is ENOSPC too', () => {
    const breaches = detectCriticalWriteHeadroom([
      snap({ totalInodes: 1_000_000, freeInodes: 30_000, freeInodesPct: 0.03 }),
    ]);
    expect(breaches[0].kinds).toEqual(['low-inodes']);
  });
});

describe('criticalWriteHeadroomBytes', () => {
  it('projects the same larger-of-absolute-or-percent reserve writers must preserve', () => {
    expect(criticalWriteHeadroomBytes(20 * GIB)).toBe(2 * GIB);
    expect(criticalWriteHeadroomBytes(500 * GIB)).toBe(10 * GIB);
    expect(criticalWriteHeadroomBytes(1875.7 * GIB)).toBeCloseTo(37.514 * GIB, -3);
  });

  it('falls back to the absolute reserve when total bytes are not measurable', () => {
    expect(criticalWriteHeadroomBytes(Number.NaN)).toBe(DEFAULT_DISK_POLICY.criticalFreeBytesMin);
    expect(criticalWriteHeadroomBytes(0)).toBe(DEFAULT_DISK_POLICY.criticalFreeBytesMin);
  });
});

// EI-23337577023503501 — the percentage-floor mis-specification that froze this
// repo's green checkpoint at 32 consecutive reds.
//
// /tmp here is 7.45 TiB (an archive volume the checkpoint merely writes scratch
// to). The uncapped rule was `freeBytes < 2 GiB || freePct < 2%`, so the
// percentage leg demanded 149 GiB of a filesystem where 47.9 GiB sat free — 24x
// the absolute floor, and far past any measured demand (826 paired runs: p50
// 0.1 GiB, p90 3.6 GiB, max 57.7 GiB, against a -74.5 GiB minimum proving that
// tail is shared-box noise). "Free /tmp" cannot fix a floor that scales with the
// volume, so the floor is what had to change.
const TIB = 1024 ** 4;
const BIG_VOLUME = 7.45 * TIB;

describe('write-headroom reserve is bounded on a large volume (EI-23337577023503501)', () => {
  it('caps the percentage-derived reserve instead of scaling it with the volume', () => {
    // Uncapped this would be 2% of 7.45 TiB ≈ 152.6 GiB.
    expect(criticalWriteHeadroomBytes(BIG_VOLUME)).toBe(DEFAULT_DISK_POLICY.criticalFreeBytesCap);
    expect(BIG_VOLUME * DEFAULT_DISK_POLICY.criticalFreePctMin).toBeGreaterThan(
      DEFAULT_DISK_POLICY.criticalFreeBytesCap,
    );
  });

  it('admits a large volume holding far more than any run has ever written', () => {
    // 100 GiB free of 7.45 TiB is 1.3% — under the 2% floor, so the OLD rule
    // refused it. It is ~28x the p90 run consumption.
    expect(
      detectCriticalWriteHeadroom([
        snap({ totalBytes: BIG_VOLUME, freeBytes: 100 * GIB, freePct: (100 * GIB) / BIG_VOLUME }),
      ]),
    ).toEqual([]);
  });

  it('STILL refuses a large volume below the bounded reserve — the guard is capped, not removed', () => {
    const breaches = detectCriticalWriteHeadroom([
      snap({ totalBytes: BIG_VOLUME, freeBytes: 8 * GIB, freePct: (8 * GIB) / BIG_VOLUME }),
    ]);
    expect(breaches).toHaveLength(1);
    expect(breaches[0].kinds).toContain('low-bytes');
    expect(breaches[0].severity).toBe('critical');
  });

  it('leaves the ALARM tiers proportional — a nearly-full archive volume still nudges a human', () => {
    // The alarm asks "is this filesystem nearly full?" (yes: 1.3%), which is the
    // right question for a cleanup nudge and the wrong one for a writer. Only the
    // write-headroom projection is bounded.
    const b = detectLowSpace([
      snap({ totalBytes: BIG_VOLUME, freeBytes: 100 * GIB, freePct: (100 * GIB) / BIG_VOLUME }),
    ]);
    expect(b).toHaveLength(1);
    expect(b[0].kinds).toContain('low-bytes');
  });
});

describe('formatDiskAlarmToast', () => {
  it('names the path with free GiB + %, and mentions inodes only when low-inodes', () => {
    const t = formatDiskAlarmToast([
      {
        path: '/ws',
        kinds: ['low-bytes', 'low-inodes'],
        severity: 'critical', // 0.4% free — critical under the default policy
        freeBytes: 2 * GIB,
        totalBytes: 500 * GIB,
        freePct: 0.004,
        freeInodes: 10_000,
        totalInodes: 1_000_000,
        freeInodesPct: 0.01,
      },
    ]);
    expect(t.level).toBe('warning');
    expect(t.message).toContain('1 filesystem');
    expect(t.description).toContain('/ws');
    expect(t.description).toContain('2.0 GiB free');
    expect(t.description).toContain('inodes free');
    expect(t.description).toContain('PAPERCUSP_DISK_SPACE_ALARM=0');
  });

  it('omits the inode clause for a bytes-only breach', () => {
    const t = formatDiskAlarmToast([
      {
        path: '/ws',
        kinds: ['low-bytes'],
        severity: 'critical', // 0.4% free — critical under the default policy
        freeBytes: 2 * GIB,
        totalBytes: 500 * GIB,
        freePct: 0.004,
        freeInodes: 900_000,
        totalInodes: 1_000_000,
        freeInodesPct: 0.9,
      },
    ]);
    expect(t.description).not.toContain('inodes free');
  });
});

describe('runDiskSpaceAlarmOnce', () => {
  it('delivers the warning-floor alarm with both persisted device consumers and an exact receipt link', async () => {
    const context: DiskAlarmContext = {
      devices: [
        { device: '/', complete: true, sampledAt: '2026-10-13T12:00:00Z', consumers: [{ consumer: '/home/builduser', kind: 'dir', depth: 2, bytes: 120 * GIB, baselineBytes: null, growth24hBytes: null }] },
        { device: '/mnt/data', complete: true, sampledAt: '2026-10-13T12:00:00Z', consumers: [{ consumer: '/mnt/data/offload', kind: 'dir', depth: 3, bytes: 300 * GIB, baselineBytes: null, growth24hBytes: null }] },
      ],
      receipt: { schemaVersion: 1, id: 'receipt-123', startedAt: '', finishedAt: '2026-10-13T13:00:00Z', dryRun: false, complete: false, policyExhausted: null, devices: [], entries: [], delegates: [], errors: ['protected artifacts remain'] },
    };
    const escalate = vi.fn(async (_t: AttentionNotifyInput) => {});
    const emitToast = vi.fn(async (_t: { description: string }) => {});
    const readContext = vi.fn(async () => context);
    const deps = { emitToast, escalate, readContext, recentlyEscalated: async () => false, attributeUsage: async () => ({ entries: [], truncated: false }) };
    const result = await runDiskSpaceAlarmOnce({ ...deps, sample: async () => [snap({ path: '/', freeBytes: 99 * GIB, freePct: 0.198 }), snap({ path: '/mnt/data' })] });
    expect(result.escalated).toBe(true);
    expect(escalate.mock.calls[0]![0].importance).toBe('urgent');
    expect(escalate.mock.calls[0]![0].data).toEqual({
      conditionKey: DISK_SPACE_ALARM_CONDITION_KEY, host: expect.any(String),
      consumers: { '/': ['/home/builduser'], '/mnt/data': ['/mnt/data/offload'] }, reclaimReceiptId: 'receipt-123',
    });
    for (const text of ['/home/builduser', '/mnt/data/offload', '/settings/storage?reclaim=receipt-123', 'partial']) {
      expect(escalate.mock.calls[0]![0].body).toContain(text);
      expect(emitToast.mock.calls[0]![0].description).toContain(text);
    }
    escalate.mockClear(); readContext.mockClear();
    await runDiskSpaceAlarmOnce({ ...deps, sample: async () => [snap({ path: '/', freeBytes: 100 * GIB, freePct: 0.2 })] });
    expect(escalate).not.toHaveBeenCalled(); expect(readContext).not.toHaveBeenCalled();
  });
  it('inspects breached temporary and extra paths before known roots and reports their consumers', async () => {
    const retained = join(tmpdir(), 'retained-source-evidence');
    const scan = vi.mocked(listDiskRootChildrenAsync);
    scan.mockClear();
    scan.mockImplementationOnce(async (options) => ({
      entries: options?.roots?.[0] === tmpdir()
        ? [{ path: retained, mtimeMs: 0, sizeBytes: 3 * GIB }]
        : [],
      truncated: true,
    }));
    const emitToast = vi.fn(async (_t: { description: string }) => {});
    const escalate = vi.fn(async (_t: { body: string }) => {});
    await runDiskSpaceAlarmOnce({
      sample: async () => [
        // The sampler deduplicates the /tmp bind mount against /mnt/data.
        // Attribution must still reach that narrower alias before a broad scan.
        snap({ path: '/mnt/data', aliases: [tmpdir()], freeBytes: 0, freePct: 0 }),
        snap({ path: '/extra-volume', freeBytes: 0, freePct: 0 }),
        snap(),
      ],
      emitToast, escalate, recentlyEscalated: async () => false,
    });
    expect(scan).toHaveBeenCalledOnce();
    expect(scan.mock.calls[0]?.[0]?.roots?.slice(0, 3)).toEqual([tmpdir(), '/mnt/data', '/extra-volume']);
    expect(scan.mock.calls[0]?.[0]?.followSymlinks).toBe(false);
    expect(emitToast.mock.calls[0]?.[0].description).toContain(retained);
    expect(emitToast.mock.calls[0]?.[0].description).toContain('partial scan');
    expect(escalate.mock.calls[0]?.[0].body).toContain(retained);
  });

  it('does not scan a healthy disk; labels partial and unavailable attribution', async () => {
    const attributeUsage = vi.fn(async () => ({ entries: [{ path: '/large-store', mtimeMs: 0, sizeBytes: GIB }], truncated: true }));
    const emitToast = vi.fn(async (_t: { description: string }) => {});
    await runDiskSpaceAlarmOnce({ sample: async () => [snap()], emitToast, attributeUsage });
    expect(attributeUsage).not.toHaveBeenCalled();
    await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ freeBytes: 6 * GIB, freePct: 0.03 })], emitToast, attributeUsage,
    });
    expect(emitToast.mock.calls[0]?.[0].description).toContain('partial scan');
    await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ freeBytes: 6 * GIB, freePct: 0.03 })], emitToast,
      attributeUsage: async () => { throw new Error('unreadable'); },
    });
    expect(emitToast.mock.calls[1]?.[0].description).toContain('attribution unavailable');
  });

  it('WI-10005720: names a large sibling that fleet-logs retention cannot see', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-alarm-attribution-'));
    try {
      mkdirSync(join(root, 'fleet-logs'));
      const large = join(root, 'pot-git');
      mkdirSync(large);
      writeFileSync(join(large, 'payload'), Buffer.alloc(4096));
      const emitToast = vi.fn(async (_t: { description: string }) => {});
      const escalate = vi.fn(async (_t: { body: string }) => {});
      const disk = await vi.importActual<typeof import('./disk')>('./disk');
      await runDiskSpaceAlarmOnce({
        sample: async () => [snap({ freeBytes: 0, freePct: 0 })],
        emitToast, escalate, recentlyEscalated: async () => false,
        attributeUsage: () => disk.listDiskRootChildrenAsync({ roots: [root], followSymlinks: false }),
      });
      expect(emitToast.mock.calls[0]?.[0].description).toContain(large);
      expect(escalate.mock.calls[0]?.[0].body).toContain(large);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Every case below injects BOTH escalation deps. A critical-tier breach otherwise
  // falls through to the real notifyAttention (defaultRecentlyEscalated fails OPEN on
  // a missing DB, by design) — i.e. a unit test firing a live push.
  const noEscalate = {
    escalate: async (_t: { title: string; body: string }) => {},
    recentlyEscalated: async () => false,
  };

  it('emits exactly one toast when a filesystem breaches, and returns the breaches', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', freeBytes: 1 * GIB, freePct: 1 / 500 }), snap({ path: '/tmp' })],
      emitToast,
      ...noEscalate,
    });
    expect(res.checked).toBe(2);
    expect(res.breaches.map((b) => b.path)).toEqual(['/ws']);
    expect(emitToast).toHaveBeenCalledTimes(1);
    expect(emitToast.mock.calls[0][0].level).toBe('warning');
  });

  it('escalates a CRITICAL breach to a human, once', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 1875 * GIB, freeBytes: 17 * GIB, freePct: 0.009 })],
      emitToast: async () => {},
      escalate,
      recentlyEscalated: async () => false,
    });
    expect(res.escalated).toBe(true);
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][0].body).toContain('/ws');
  });

  it('delivers a warning-tier breach through the existing human attention rail', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 500 * GIB, freeBytes: 40 * GIB, freePct: 0.08 })],
      emitToast,
      escalate,
      recentlyEscalated: async () => false,
    });
    expect(emitToast).toHaveBeenCalledTimes(1); // still toasts
    expect(escalate).toHaveBeenCalledOnce();
    expect(escalate.mock.calls[0][0].title).toBe('Disk below headroom target');
    expect(res.escalated).toBe(true);
  });

  it('suppresses a repeat escalation inside the cooldown window', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 1875 * GIB, freeBytes: 17 * GIB, freePct: 0.009 })],
      emitToast: async () => {},
      escalate,
      recentlyEscalated: async () => true, // already pinged within the window
    });
    expect(escalate).not.toHaveBeenCalled();
    expect(res.escalated).toBe(false);
    expect(res.breaches).toHaveLength(1); // still detected + toasted, just not re-pinged
  });

  it('hands the escalation rail the ladder-rung title, so a deeper rung is a new cooldown identity', async () => {
    const escalate = vi.fn(async (_t: { title: string; body: string }) => {});
    await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/', totalBytes: 1875 * GIB, freeBytes: 2.9 * GIB, freePct: 2.9 / 1875 })],
      emitToast: async () => {},
      escalate,
      recentlyEscalated: async () => false,
    });
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0][0].title).toMatch(/worsening \(tier 3:/);
  });
});

describe('escalation ladder — a worsening critical disk re-escalates inside the cooldown (WI-10002867)', () => {
  // The measured incident: 1.875 TB root, default policy ⇒ critical reserve =
  // min(2% of total, 64 GiB cap) = 37.5 GiB.
  const total = 1875 * GIB;
  const breach = (freeGib: number) =>
    detectLowSpace([snap({ path: '/', totalBytes: total, freeBytes: freeGib * GIB, freePct: (freeGib * GIB) / total })])[0];

  it('counts halvings below the critical reserve', () => {
    expect(criticalWriteHeadroomBytes(total) / GIB).toBeCloseTo(37.5, 6);
    expect(diskEscalationTier(breach(30))).toBe(0);
    expect(diskEscalationTier(breach(17))).toBe(1);
    expect(diskEscalationTier(breach(2.9))).toBe(3);
    expect(diskEscalationTier({ totalBytes: total, freeBytes: 0 })).toBe(6);
  });

  it('keeps ONE cooldown identity while the disk merely stays on the same rung (no spam)', () => {
    const escalation = formatDiskEscalation([breach(17)]);
    expect(escalation.title).toBe(formatDiskEscalation([breach(15)]).title);
    expect(escalation.title).toContain('18.8 GiB');
    expect(escalation.body).toContain('17.0 GiB free');
    expect(escalation.body).toContain('1875.0 GiB');
    expect(formatDiskEscalation([breach(30)]).title).toBe('Disk critically low');
  });

  it('replays 2026-09-23: 1.4% → 1.5% → 0.1% → 0.3% free now re-pings when it gets worse', () => {
    // Title-keyed cooldown, exactly as alarm-attention's defaultRecentlyEscalated applies it.
    const pinged = new Set<string>();
    const pings: number[] = [];
    for (const freeGib of [26, 28, 1.9, 5.6]) {
      const { title } = formatDiskEscalation([breach(freeGib)]);
      if (!pinged.has(title)) {
        pinged.add(title);
        pings.push(freeGib);
      }
    }
    // Before the ladder a single fixed title ⇒ only the 26 GiB tick pinged.
    expect(pings).toContain(26);
    expect(pings).toContain(1.9);
    expect(pings).not.toContain(28);
  });

  it('never throws when the escalation rail itself fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => [snap({ path: '/ws', totalBytes: 1875 * GIB, freeBytes: 17 * GIB, freePct: 0.009 })],
      emitToast: async () => {},
      escalate: async () => {
        throw new Error('push rail down');
      },
      recentlyEscalated: async () => false,
    });
    expect(res.escalated).toBe(false);
    expect(res.breaches).toHaveLength(1); // detection survives a dead delivery rail
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('emits NO toast when every filesystem is healthy', async () => {
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    vi.mocked(readLatestConditionEnvelope).mockClear();
    const res = await runDiskSpaceAlarmOnce({ sample: async () => [snap(), snap({ path: '/tmp' })], emitToast });
    expect(res.breaches).toEqual([]);
    expect(emitToast).not.toHaveBeenCalled();
    expect(readLatestConditionEnvelope).toHaveBeenCalledOnce();
    expect(readLatestConditionEnvelope).toHaveBeenCalledWith(DISK_SPACE_ALARM_CONDITION_KEY);
  });

  it('never throws when sampling fails — returns an empty result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const emitToast = vi.fn(async (_t: { level: string; message: string; description: string }) => {});
    const res = await runDiskSpaceAlarmOnce({
      sample: async () => {
        throw new Error('boom statfs');
      },
      emitToast,
    });
    expect(res).toEqual({ checked: 0, breaches: [], escalated: false });
    expect(emitToast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('diskPolicyFromEnv', () => {
  const policyEnvKeys = [
    'PAPERCUSP_DISK_ALARM_FREE_PCT',
    'PAPERCUSP_DISK_ALARM_FREE_GB',
    'PAPERCUSP_DISK_ALARM_FREE_INODES_PCT',
    'PAPERCUSP_DISK_ALARM_CRITICAL_PCT',
    'PAPERCUSP_DISK_ALARM_CRITICAL_GB',
    'PAPERCUSP_DISK_ALARM_CRITICAL_CAP_GB',
  ];

  beforeEach(() => {
    for (const key of policyEnvKeys) vi.stubEnv(key, undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('falls back to defaults when env is unset', () => {
    expect(diskPolicyFromEnv()).toEqual(DEFAULT_DISK_POLICY);
  });
  it('keeps the approved 100 GiB alarm floor when a legacy environment sets a lower value', () => {
    vi.stubEnv('PAPERCUSP_DISK_ALARM_FREE_GB', '5');
    expect(diskPolicyFromEnv().freeBytesMin).toBe(100 * GIB);
    vi.stubEnv('PAPERCUSP_DISK_ALARM_FREE_GB', '150');
    expect(diskPolicyFromEnv().freeBytesMin).toBe(150 * GIB);
  });
});

describe('watchedPaths', () => {
  it('prefers /mnt/data to the process temp path and deduplicates identical extras', () => {
    const previous = process.env.PAPERCUSP_DISK_ALARM_PATHS;
    process.env.PAPERCUSP_DISK_ALARM_PATHS = `${tmpdir()},${tmpdir()}`;
    try {
      const paths = watchedPaths();
      expect(paths).toContain(tmpdir());
      expect(paths.indexOf('/mnt/data')).toBeLessThan(paths.indexOf(tmpdir()));
      expect(paths.filter((path) => path === tmpdir())).toHaveLength(1);
    } finally {
      if (previous == null) delete process.env.PAPERCUSP_DISK_ALARM_PATHS;
      else process.env.PAPERCUSP_DISK_ALARM_PATHS = previous;
    }
  });

  it('samples only one path for filesystem aliases with the same stat.dev', async () => {
    const root = mkdtempSync(join(tmpdir(), 'disk-alarm-device-alias-'));
    const nested = join(root, 'nested');
    mkdirSync(nested);
    try {
      const snapshots = await sampleDiskSnapshots([root, nested]);
      expect(snapshots.map((snapshot) => snapshot.path)).toEqual([root]);
      expect(snapshots[0]?.aliases).toEqual([nested]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('alarmWatchedPaths — every retention volume is watched (WI-6554700010011387)', () => {
  // A fake host: /mnt/backup and /mnt/data are their own devices; everything else is '/'.
  const fakeStat = (p: string) => {
    if (p === '/mnt/missing' || p.startsWith('/mnt/missing/')) throw new Error('ENOENT');
    if (p === '/mnt/backup' || p.startsWith('/mnt/backup/')) return { dev: 2 };
    if (p === '/mnt/data' || p.startsWith('/mnt/data/')) return { dev: 3 };
    return { dev: 1 };
  };
  const cls = (id: string, roots: string[]): RetentionClass => ({
    id, title: id, origin: 'system', roots, keep: { kind: 'keep', reason: 'fixture' }, enforcers: [{ kind: 'none' }],
  });

  it('mountPointOf walks up to the device boundary and is null for a missing path', () => {
    expect(mountPointOf('/mnt/backup/offload/macos-vm/OSX-KVM', fakeStat)).toBe('/mnt/backup');
    expect(mountPointOf('/usr/lib', fakeStat)).toBe('/');
    expect(mountPointOf('/mnt/missing/x', fakeStat)).toBeNull();
  });

  it('adds the mount of every absolute class root, including glob roots, and skips ~ roots', () => {
    const paths = alarmWatchedPaths([
      cls('vm', ['/mnt/backup/offload/macos-vm']),
      cls('trees', ['/mnt/backup/cloud-e2e-*']),
      cls('home', ['~/.cache']),
      cls('gone', ['/mnt/missing/x']),
    ], fakeStat);
    expect(paths).toContain('/mnt/backup');
    expect(paths.filter((p) => p === '/mnt/backup')).toHaveLength(1);
    expect(paths).not.toContain('/mnt/missing');
    for (const p of watchedPaths()) expect(paths).toContain(p);
  });

  it('the shipped policy puts /mnt/backup in the ALARM set but not the gate write-admission set', () => {
    // The gate reuses watchedPaths() for write admission (green-checkpoint sampleCheckpointDisk);
    // a volume the suite never writes to must not hold it.
    expect(alarmWatchedPaths(RETENTION_POLICY, fakeStat)).toContain('/mnt/backup');
    expect(watchedPaths()).not.toContain('/mnt/backup');
  });
});

describe('describeWriteHeadroomBreach (EI-23424266636870803)', () => {
  // The measured wedge, reproduced exactly: /tmp on a 7.45 TiB device with 40.2 GiB
  // free. Reserve = max(2 GiB, min(7451 GiB * 2% = 149.0 GiB, 64 GiB cap)) = 64 GiB,
  // so the true deficit is 23.8 GiB.
  // NOTE `snap` spreads overrides over PRE-COMPUTED percentages, so a caller that sets
  // bytes/inodes must set the matching pct too or the snapshot is internally incoherent.
  const REAL_BOX = snap({
    path: '/tmp',
    totalBytes: 7451 * GIB,
    freeBytes: 40.2 * GIB,
    freePct: 40.2 / 7451,
  });

  function onlyBreach(s: DiskSnapshot, policy?: DiskAlarmPolicy) {
    const breaches = detectCriticalWriteHeadroom([s], policy ?? DEFAULT_DISK_POLICY);
    expect(breaches).toHaveLength(1);
    return breaches[0]!;
  }

  it('reports the reserve that was APPLIED, not the raw policy scalars', () => {
    // THE BUG. The old message quoted policy.criticalFreeBytesMin (2.0 GiB) and
    // criticalFreePctMin (2.00%) as "the floor", while the breach test used the capped
    // per-filesystem reserve. Printed beside "40.2 GiB free" that reads as a verdict
    // contradicting its own evidence — so a responder concludes the gate is buggy or
    // the reading is stale, and the wedge outlives the message meant to explain it.
    const msg = describeWriteHeadroomBreach(onlyBreach(REAL_BOX));
    expect(msg).toContain('64.0 GiB write-headroom reserve');
    expect(msg).not.toMatch(/floor is 2\.0 GiB/);
    expect(msg).not.toContain('2.00%');
  });

  it('sizes the cleanup by the ABSOLUTE deficit, never a percentage of the volume', () => {
    // 64.0 - 40.2. Taking the retired percentage leg instead would size this at ~109 GiB
    // — a 4.6x overstatement of how much a human has to delete, on a 100%-full shared
    // device where the difference is "prune a cache" vs "delete a backup".
    const msg = describeWriteHeadroomBreach(onlyBreach(REAL_BOX));
    expect(msg).toContain('23.8 GiB');
    expect(msg).not.toContain('109');
  });

  it('the named reserve always EQUALS criticalWriteHeadroomBytes for that filesystem', () => {
    // The drift guard, and the reason this formatter lives beside the policy: parse the
    // reserve back out of the prose and compare it with the function the detector used.
    // Any future divergence between what is applied and what is reported fails here
    // rather than in a wedged gate nobody can interpret.
    for (const totalGib of [20, 500, 1875.7, 7451]) {
      // 1 byte under the reserve: guaranteed to breach at every volume size.
      const freeBytes = criticalWriteHeadroomBytes(totalGib * GIB) - 1;
      const s = snap({
        path: '/fs',
        totalBytes: totalGib * GIB,
        freeBytes,
        freePct: freeBytes / (totalGib * GIB),
      });
      const msg = describeWriteHeadroomBreach(onlyBreach(s));
      const named = msg.match(/([\d.]+) GiB write-headroom reserve/)?.[1];
      expect(named, `no reserve named for a ${totalGib} GiB filesystem`).toBeDefined();
      expect(Number(named)).toBeCloseTo(criticalWriteHeadroomBytes(totalGib * GIB) / GIB, 1);
    }
  });

  it('attributes free space to the FILESYSTEM, not to the directory that named it', () => {
    // The destructive misreading. /tmp, /mnt/data and /var/lib/systemd/coredump are one
    // device here and /tmp holds ~104 GiB of 7.3 TiB, so "/tmp lacked headroom" sends a
    // responder to empty /tmp — destroying peers' preserved artifacts to reach a target
    // that ~24 GiB reclaimed anywhere on the device already satisfies.
    const msg = describeWriteHeadroomBreaches([onlyBreach(REAL_BOX)]);
    expect(msg).toContain('/tmp');
    expect(msg).toMatch(/filesystem backing it/i);
    expect(msg).toMatch(/anywhere on that filesystem/i);
    expect(msg).toMatch(/other\s+mount points may share the same device/i);
  });

  it('an inode breach reports the inode floor, not a byte deficit', () => {
    const s = snap({
      path: '/fs',
      totalInodes: 1_000_000,
      freeInodes: 10_000,
      freeInodesPct: 0.01,
    });
    const breach = onlyBreach(s);
    expect(breach.kinds).toContain('low-inodes');
    const msg = describeWriteHeadroomBreach(breach);
    expect(msg).toContain('1.00% inodes free');
    expect(msg).toContain('5.00% floor');
    expect(msg).not.toContain('write-headroom reserve');
  });

  it('no breaches renders nothing — an empty string, never a headline with no content', () => {
    expect(describeWriteHeadroomBreaches([])).toBe('');
  });

  it('CONTROL: the drift guard REJECTS the pre-fix wording', () => {
    // A guard that has never failed is a guard you have not tested, and this one reads a
    // number back out of prose — the kind that passes by accident. So run the assertion
    // above against a deliberately-wrong formatter kept here permanently: the shipped
    // pre-fix string, which quoted policy.criticalFreeBytesMin as "the floor". If the
    // property below ever stops failing for it, the guard has gone vacuous.
    const preFix = (breach: typeof brokenBreach) =>
      `${breach.path} ${breach.kinds.join('+')} breaches the standing critical write ` +
      `headroom floor; floor is ${(DEFAULT_DISK_POLICY.criticalFreeBytesMin / GIB).toFixed(1)} GiB`;
    const brokenBreach = onlyBreach(REAL_BOX);

    // The pre-fix string names 2.0 GiB where the applied reserve was 64.0 GiB.
    const named = preFix(brokenBreach).match(/([\d.]+) GiB/)?.[1];
    expect(Number(named)).toBe(2);
    expect(Number(named)).not.toBeCloseTo(
      criticalWriteHeadroomBytes(REAL_BOX.totalBytes) / GIB,
      1,
    );

    // CALIBRATION: the same parse against the REAL subject must agree, or the control
    // above is passing because the regex is broken rather than because the wording was.
    const real = describeWriteHeadroomBreach(brokenBreach).match(
      /([\d.]+) GiB write-headroom reserve/,
    )?.[1];
    expect(Number(real)).toBeCloseTo(criticalWriteHeadroomBytes(REAL_BOX.totalBytes) / GIB, 1);
  });
});
