/** Pure disk policy shared by the alarm, writer admission and standalone health recorder. */
const GIB = 1024 ** 3;

function envNum(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

// ── Policy ─────────────────────────────────────────────────────────────────────

export interface DiskAlarmPolicy {
  /** Flag when free space drops below this fraction of total (0–1). */
  freePctMin: number;
  /** …or below this absolute byte floor (catches a huge disk that is %-fine but
   *  nearly out in absolute terms). */
  freeBytesMin: number;
  /** Flag when free inodes drop below this fraction of total (0–1). Skipped on
   *  filesystems that do not report inodes (totalInodes === 0, e.g. btrfs). */
  freeInodesPctMin: number;
  /** CRITICAL tier (EI-20090527288494606): below this fraction, a breach stops
   *  being "getting full" and becomes "writes are about to fail" — it escalates
   *  to a human instead of only toasting. Must be TIGHTER than freePctMin. */
  criticalFreePctMin: number;
  /** …or below this absolute byte floor. Must be TIGHTER than freeBytesMin. */
  criticalFreeBytesMin: number;
  /**
   * Ceiling on the PERCENTAGE-derived write-headroom reserve (EI-23337577023503501).
   *
   * Only {@link detectCriticalWriteHeadroom} / {@link criticalWriteHeadroomBytes}
   * honour this — the alarm tiers deliberately do not (see below). A percentage
   * floor is a proxy for "this filesystem is nearly full", which is the right
   * question for a HUMAN CLEANUP NUDGE and the wrong one for a WRITER: a writer's
   * transient demand is ABSOLUTE and does not scale with volume size, so the same
   * 2% that means 400 MiB on a 20 GiB disk means 149 GiB on a 7.45 TiB archive
   * volume — a reserve no run has ever needed, which froze this repo's green
   * checkpoint for 32 consecutive reds while 47.9 GiB sat free (24x the absolute
   * floor). Measured over 826 paired checkpoint runs, a run's net consumption was
   * p50 0.1 GiB, p90 3.6 GiB, p99 34 GiB, max 57.7 GiB — and the same series has a
   * MINIMUM of -74.5 GiB (peers freeing space mid-run), so that upper tail is
   * shared-box noise in both directions rather than gate demand. 64 GiB therefore
   * covers the largest delta ever observed, with margin, and still refuses a
   * genuinely doomed write.
   */
  criticalFreeBytesCap: number;
}

export const DEFAULT_DISK_POLICY: DiskAlarmPolicy = {
  freePctMin: 0.1, // 10%
  freeBytesMin: 100 * GIB,
  freeInodesPctMin: 0.05, // 5%
  criticalFreePctMin: 0.02, // 2%
  criticalFreeBytesMin: 2 * GIB,
  criticalFreeBytesCap: 64 * GIB,
};

export function diskPolicyFromEnv(): DiskAlarmPolicy {
  return {
    freePctMin: envNum('PAPERCUSP_DISK_ALARM_FREE_PCT', DEFAULT_DISK_POLICY.freePctMin * 100) / 100,
    freeBytesMin: Math.max(DEFAULT_DISK_POLICY.freeBytesMin, envNum('PAPERCUSP_DISK_ALARM_FREE_GB', DEFAULT_DISK_POLICY.freeBytesMin / GIB) * GIB),
    freeInodesPctMin: envNum('PAPERCUSP_DISK_ALARM_FREE_INODES_PCT', DEFAULT_DISK_POLICY.freeInodesPctMin * 100) / 100,
    criticalFreePctMin:
      envNum('PAPERCUSP_DISK_ALARM_CRITICAL_PCT', DEFAULT_DISK_POLICY.criticalFreePctMin * 100) / 100,
    criticalFreeBytesMin:
      envNum('PAPERCUSP_DISK_ALARM_CRITICAL_GB', DEFAULT_DISK_POLICY.criticalFreeBytesMin / GIB) * GIB,
    criticalFreeBytesCap:
      envNum('PAPERCUSP_DISK_ALARM_CRITICAL_CAP_GB', DEFAULT_DISK_POLICY.criticalFreeBytesCap / GIB) * GIB,
  };
}

/**
 * Minimum writer reserve, without loading the alarm runtime. The absolute floor
 * and capped percentage reserve are unchanged (EI-23337577023503501): demand
 * does not scale with volume size. Invalid totals retain the absolute floor;
 * a cap can never lower it. Alarm tiers themselves continue using their policy.
 */
export function criticalWriteHeadroomBytes(
  totalBytes: number,
  policy: DiskAlarmPolicy = DEFAULT_DISK_POLICY,
): number {
  const absolute =
    Number.isFinite(policy.criticalFreeBytesMin) && policy.criticalFreeBytesMin > 0
      ? policy.criticalFreeBytesMin
      : 0;
  const proportional =
    Number.isFinite(totalBytes) &&
    totalBytes > 0 &&
    Number.isFinite(policy.criticalFreePctMin) &&
    policy.criticalFreePctMin > 0
      ? totalBytes * policy.criticalFreePctMin
      : 0;
  const cap =
    Number.isFinite(policy.criticalFreeBytesCap) && policy.criticalFreeBytesCap > 0
      ? policy.criticalFreeBytesCap
      : Number.POSITIVE_INFINITY;
  // The cap bounds the proportional term; the absolute floor stays a hard minimum.
  return Math.max(absolute, Math.min(proportional, cap));
}

