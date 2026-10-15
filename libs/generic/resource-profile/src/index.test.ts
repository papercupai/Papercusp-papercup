import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedOrgPoolMax,
  configureResourceProfile,
  databaseTuningToSettings,
  deriveDatabaseTuning,
  deriveResourceProfile,
  diffPgSettings,
  findShadowingPgAssignments,
  getResourceProfile,
  parsePgSizeToBytes,
  parsePgDurationToMs,
  pgSettingRequiresRestart,
  PG_RESTART_ONLY_SETTINGS,
  requiredPgHugePagesForTarget,
  resetResourceProfile,
  type PgLiveSetting,
  type ResourceSignals,
} from './index';

const GIB = 1024 * 1024 * 1024;

function signals(overrides: Partial<ResourceSignals>): ResourceSignals {
  return {
    cores: 8,
    totalMemBytes: 16 * GIB,
    freeMemBytes: 16 * GIB,
    embeddedPg: false,
    hostRole: 'full',
    ...overrides,
  };
}

afterEach(() => resetResourceProfile());

describe('deriveResourceProfile — laptop (small, embedded PG)', () => {
  // 4 cores sharing the box with an embedded Postgres, plenty of RAM so RAM isn't
  // the binding constraint — caps should sit near their FLOORS.
  const p = deriveResourceProfile(signals({ cores: 4, embeddedPg: true, totalMemBytes: 8 * GIB, freeMemBytes: 8 * GIB }));

  it('classes as laptop', () => {
    expect(p.hostClass).toBe('laptop');
  });

  it('runs only a couple agents (round(4 * 0.25) = 1)', () => {
    expect(p.maxSimultaneousAgents).toBe(1);
    expect(p.maxSimultaneousAgents).toBeGreaterThanOrEqual(1); // floor honored
  });

  it('keeps the DBOS queue small but never below the floor of 1', () => {
    // round(4 * 0.5) = 2
    expect(p.dbosQueueConcurrency).toBe(2);
    expect(p.dbosQueueConcurrency).toBeGreaterThanOrEqual(1);
  });

  it('barely earns serialization workers at 4 cores (clamp(4 - 2, 0, 8) = 2)', () => {
    expect(p.serializationWorkers).toBe(2);
  });

  it('keeps the smallest embed batch', () => {
    expect(p.embedBatchSize).toBe(32);
  });

  it('pins httpWorkers / processCount to 1', () => {
    expect(p.httpWorkers).toBe(1);
    expect(p.processCount).toBe(1);
  });

  it('keeps background work in-process on the desktop', () => {
    expect(p.backgroundInProcess).toBe(true);
  });
});

describe('deriveResourceProfile — true 2-core minimum hits every floor', () => {
  const p = deriveResourceProfile(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB, freeMemBytes: 4 * GIB }));

  it('floors agents at 1', () => {
    // round(2 * 0.25) = 1 (round half up: 0.5 -> 1)
    expect(p.maxSimultaneousAgents).toBe(1);
  });

  it('floors the queue at 1', () => {
    // round(2 * 0.5) = 1
    expect(p.dbosQueueConcurrency).toBe(1);
  });

  it('floors serialization workers at 0 (inline)', () => {
    expect(p.serializationWorkers).toBe(0); // clamp(2 - 2, 0, 8)
  });

  it('pgPoolMax respects its floor (>= 4)', () => {
    expect(p.pgPoolMax).toBeGreaterThanOrEqual(4);
  });
});

describe('deriveResourceProfile — server (128 cores, native PG)', () => {
  const p = deriveResourceProfile(
    signals({ cores: 128, embeddedPg: false, totalMemBytes: 512 * GIB, freeMemBytes: 512 * GIB }),
  );

  it('classes as server', () => {
    expect(p.hostClass).toBe('server');
  });

  it('agents hit the ceiling of 16 (round(128 * 0.5) = 64, clamped)', () => {
    expect(p.maxSimultaneousAgents).toBe(16);
  });

  it('DBOS queue hits the ceiling of 32 (round(128 * 1) = 128, clamped)', () => {
    expect(p.dbosQueueConcurrency).toBe(32);
  });

  it('pgPoolMax hits the ceiling of 64 (16 + 32 + 4 = 52 -> still under, but big hosts cap at 64)', () => {
    // 16 + 32 + 4 = 52, under the ceiling; assert it scaled up and stays <= 64.
    expect(p.pgPoolMax).toBe(52);
    expect(p.pgPoolMax).toBeLessThanOrEqual(64);
  });

  it('serialization workers hit the ceiling of 8', () => {
    expect(p.serializationWorkers).toBe(8); // clamp(128 - 2, 0, 8)
  });

  it('embed batch hits the server tier (128)', () => {
    expect(p.embedBatchSize).toBe(128);
  });

  it('recommends clustering but BOUNDS httpWorkers by the PG connection budget (P3-2)', () => {
    // Clustering is recommended on a server, but NOT the raw cores-1 (=127, cap 32):
    // the connection budget caps it lower so the clustered per-process pools stay
    // healthy and can't over-subscribe max_connections (the 2026-06-17 exhaustion).
    expect(p.httpWorkers).toBeGreaterThan(1); // clustering on
    expect(p.httpWorkers).toBeLessThan(32); // conn-budget bound it below the core cap
    expect(p.processCount).toBe(p.httpWorkers + 1); // workers + background primary
    // The invariant that makes enabling the cluster safe: each of processCount
    // processes keeps a HEALTHY pool (>= 8) under the host's max_connections.
    const perPool = boundedOrgPoolMax({
      desired: p.pgPoolMax,
      maxConnections: p.database.maxConnections,
      superuserReserved: p.database.superuserReservedConnections,
      expectedProcesses: p.processCount,
    });
    expect(perPool).toBeGreaterThanOrEqual(8);
  });

  it('recommends splitting background work to its own process', () => {
    expect(p.backgroundInProcess).toBe(false);
  });
});

describe('clusterable — EI-3377: a server clusters regardless of the embeddedPg signal', () => {
  // The papercusp detectEmbeddedPg() misfires to true on any host with an explicit
  // DATABASE_URL (EI-2403), so a native-PG SERVER read embeddedPg=true and collapsed
  // httpWorkers to 1. clusterable now gates on hostClass alone, so the cluster
  // recommendation is identical whether embeddedPg is true or false at the same host
  // size — the connection ceiling (maxClusterWorkersForConnBudget) is what bounds it.
  const native = deriveResourceProfile(
    signals({ cores: 128, embeddedPg: false, totalMemBytes: 512 * GIB, freeMemBytes: 512 * GIB }),
  );
  const misfired = deriveResourceProfile(
    signals({ cores: 128, embeddedPg: true, totalMemBytes: 512 * GIB, freeMemBytes: 512 * GIB }),
  );

  it('still recommends clustering when embeddedPg=true (was wrongly 1 pre-fix)', () => {
    expect(misfired.httpWorkers).toBeGreaterThan(1);
    expect(misfired.processCount).toBe(misfired.httpWorkers + 1);
  });

  it('recommends the SAME worker count regardless of embeddedPg', () => {
    expect(misfired.httpWorkers).toBe(native.httpWorkers);
  });

  it('a desktop (laptop/workstation) still never clusters, embeddedPg or not', () => {
    expect(deriveResourceProfile(signals({ cores: 4, embeddedPg: true })).httpWorkers).toBe(1);
    expect(deriveResourceProfile(signals({ cores: 16, embeddedPg: true })).httpWorkers).toBe(1);
  });
});

describe('backgroundInProcess — split only on a server with dedicated PG', () => {
  it('keeps background in-process on a laptop (native or embedded PG)', () => {
    expect(deriveResourceProfile(signals({ cores: 4, embeddedPg: false })).backgroundInProcess).toBe(true);
    expect(deriveResourceProfile(signals({ cores: 4, embeddedPg: true })).backgroundInProcess).toBe(true);
  });

  it('keeps background in-process on a workstation', () => {
    expect(deriveResourceProfile(signals({ cores: 16, embeddedPg: false })).backgroundInProcess).toBe(true);
  });

  it('splits background out ONLY on a server-class host with a dedicated (native) PG', () => {
    expect(deriveResourceProfile(signals({ cores: 128, embeddedPg: false })).backgroundInProcess).toBe(false);
  });

  it('keeps background in-process on a big box whose PG is embedded on the same machine', () => {
    // server-class cores but an embedded PG sharing the box → no split (the DB is
    // already competing for the same resources; a second process worsens that).
    expect(deriveResourceProfile(signals({ cores: 128, embeddedPg: true })).backgroundInProcess).toBe(true);
  });
});

// WI-41206 / remove-memory-derived-work-refusals-2026-08-24: this block asserted the OPPOSITE
// until now — that free RAM capped the agent budget. The clamp is gone on two grounds: running
// the box into paging is the operator's call, and `os.freemem()` was the wrong measurement
// anyway (it excludes reclaimable page cache; measured here at ~33 GiB free vs ~70 GiB truly
// available). These cases are kept, inverted, as the regression guard.
describe('free RAM no longer caps the agent budget (WI-41206)', () => {
  it('does NOT cap agents by free RAM when cores are plentiful', () => {
    // Previously: 2 GiB free -> floor(2 / 0.5) = 4 agents. Now purely core-derived:
    // 128 cores * 0.5 = 64, clamped to the ceiling of 16.
    const p = deriveResourceProfile(
      signals({ cores: 128, embeddedPg: false, totalMemBytes: 512 * GIB, freeMemBytes: 2 * GIB }),
    );
    expect(p.maxSimultaneousAgents).toBe(16);
  });

  it('keeps the full core-derived budget even with almost no free RAM', () => {
    // Previously clamped to the floor of 1. A host under memory pressure should get SLOWER,
    // not be told it may run only one agent.
    const p = deriveResourceProfile(
      signals({ cores: 64, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 0.1 * GIB }),
    );
    expect(p.maxSimultaneousAgents).toBe(16);
  });

  it('returns the SAME budget regardless of free RAM, all else equal', () => {
    // The sharpest statement of the property: free RAM is not an input to this number.
    const at = (freeMemBytes: number) =>
      deriveResourceProfile(
        signals({ cores: 16, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes }),
      ).maxSimultaneousAgents;
    expect(at(0.1 * GIB)).toBe(at(200 * GIB));
  });
});

describe('maxSwarmPeers — P-004 shared-hive peer budget', () => {
  it('floors at 256 on a tiny host so one shared hive can still reach 256 peers', () => {
    // 2 cores / 4 GiB: byCore = 64, byRam = 256 → min 64 → floored to 256.
    const tiny = deriveResourceProfile(
      signals({ cores: 2, totalMemBytes: 4 * GIB, freeMemBytes: 4 * GIB }),
    );
    expect(tiny.maxSwarmPeers).toBe(256);
    // 4 cores / 8 GiB (the laptop fixture) also sits on the floor.
    const laptop = deriveResourceProfile(
      signals({ cores: 4, totalMemBytes: 8 * GIB, freeMemBytes: 8 * GIB }),
    );
    expect(laptop.maxSwarmPeers).toBe(256);
  });

  it('scales above the floor on a mid-size box (cores * 32)', () => {
    // 32 cores / 128 GiB: byCore = 1024, byRam = 8192 → min 1024.
    const mid = deriveResourceProfile(
      signals({ cores: 32, totalMemBytes: 128 * GIB, freeMemBytes: 128 * GIB }),
    );
    expect(mid.maxSwarmPeers).toBe(1024);
    expect(mid.maxSwarmPeers).toBeGreaterThan(256); // genuine headroom for OTHER topics
  });

  it('ceilings at 2048 on a huge box so a connection-flood cannot exhaust fds/RAM', () => {
    // 128 cores / 512 GiB: byCore = 4096, byRam = 32768 → min 4096 → clamped to 2048.
    const server = deriveResourceProfile(
      signals({ cores: 128, totalMemBytes: 512 * GIB, freeMemBytes: 512 * GIB }),
    );
    expect(server.maxSwarmPeers).toBe(2048);
  });

  it('lets TOTAL RAM bind below the core-derived budget on a core-rich / RAM-poor host', () => {
    // 64 cores but only 8 GiB: byCore = 2048, byRam = 512 → min 512 (RAM bound it,
    // so the host never advertises peer slots it cannot hold).
    const ramPoor = deriveResourceProfile(
      signals({ cores: 64, totalMemBytes: 8 * GIB, freeMemBytes: 8 * GIB }),
    );
    expect(ramPoor.maxSwarmPeers).toBe(512);
  });

  it('falls back to the 256 floor on a non-finite signal (never poisons the cap)', () => {
    expect(deriveResourceProfile(signals({ cores: NaN })).maxSwarmPeers).toBe(256);
    expect(
      deriveResourceProfile(signals({ cores: 64, totalMemBytes: Number.POSITIVE_INFINITY }))
        .maxSwarmPeers,
    ).toBe(256);
  });
});

describe('hostRole shrinks the queue on non-draining hosts', () => {
  it('request-only halves the DBOS queue', () => {
    const full = deriveResourceProfile(signals({ cores: 16, hostRole: 'full' }));
    const reqOnly = deriveResourceProfile(signals({ cores: 16, hostRole: 'request-only' }));
    expect(reqOnly.dbosQueueConcurrency).toBeLessThan(full.dbosQueueConcurrency);
    // round(16 * 1) = 16 (full) ; round(16 * 0.5) = 8 (request-only)
    expect(full.dbosQueueConcurrency).toBe(16);
    expect(reqOnly.dbosQueueConcurrency).toBe(8);
  });
});

describe('non-finite cores never poison the profile (RP1 — was a real defect)', () => {
  // Before the fix: Math.floor(NaN)=NaN flowed straight through Math.max and the
  // un-guarded clamp(), so every cap came back NaN; NaN<=4 and NaN<=16 are both
  // false so the host misclassed as 'server' — and the WHOLE bogus profile got
  // memoized for the process lifetime. A NaN profile is never intended. Reverting
  // either guard (the cores fallback or the clamp Number.isFinite check) makes NaN
  // reappear and these assertions fail.
  it('cores:NaN falls back to a single-core laptop with finite caps', () => {
    const p = deriveResourceProfile(signals({ cores: NaN }));
    // host class is sane, not the bogus 'server' the NaN comparisons produced.
    expect(p.hostClass).toBe('laptop');
    // every cap is a finite number (the defect made all of these NaN).
    for (const cap of [
      p.maxSimultaneousAgents,
      p.dbosQueueConcurrency,
      p.pgPoolMax,
      p.serializationWorkers,
      p.embedBatchSize,
    ]) {
      expect(Number.isFinite(cap)).toBe(true);
    }
    // and each lands on its small-host floor / value.
    expect(p.maxSimultaneousAgents).toBe(1);
    expect(p.dbosQueueConcurrency).toBe(1);
    expect(p.pgPoolMax).toBe(6); // 1 + 1 + 4
    expect(p.serializationWorkers).toBe(0);
    expect(p.embedBatchSize).toBe(32);
    // the persisted signal is a finite core count, not NaN.
    expect(Number.isFinite(p.signals.cores)).toBe(true);
    expect(p.signals.cores).toBe(1);
  });

  it('cores:Infinity also falls back to a single-core laptop (not an oversized server)', () => {
    const p = deriveResourceProfile(signals({ cores: Infinity }));
    expect(p.hostClass).toBe('laptop');
    expect(Number.isFinite(p.signals.cores)).toBe(true);
    expect(p.signals.cores).toBe(1);
    expect(p.maxSimultaneousAgents).toBe(1);
    expect(p.dbosQueueConcurrency).toBe(1);
    for (const cap of [p.pgPoolMax, p.serializationWorkers, p.embedBatchSize]) {
      expect(Number.isFinite(cap)).toBe(true);
    }
  });

  it('a non-finite freeMemBytes is absorbed by the clamp guard, not the cap', () => {
    // WI-41206: freeMemBytes is no longer an input to the agent budget, so a NaN reading can
    // no longer poison it by ANY path — previously NaN flowed through floor(NaN/0.5) into
    // Math.min and was only rescued by clamp()'s isFinite guard, pinning the cap to 1. The
    // NaN-safety property is still worth asserting; it is now satisfied structurally rather
    // than by a rescue, and a healthy 16-core host keeps its real budget (16 * 0.5 = 8).
    const p = deriveResourceProfile(
      signals({ cores: 16, freeMemBytes: NaN }),
    );
    expect(Number.isFinite(p.maxSimultaneousAgents)).toBe(true);
    expect(p.maxSimultaneousAgents).toBe(8);
  });
});

describe('cores + freeMem normalization (RP2)', () => {
  it('floors fractional cores down and lifts non-positive cores to 1', () => {
    // Math.max(1, Math.floor(cores))
    expect(deriveResourceProfile(signals({ cores: 0 })).signals.cores).toBe(1);
    expect(deriveResourceProfile(signals({ cores: -5 })).signals.cores).toBe(1);
    expect(deriveResourceProfile(signals({ cores: 2.7 })).signals.cores).toBe(2);
  });

  it('overwrites the frozen signals.cores with the normalized value, not the raw input', () => {
    // signals: Object.freeze({ ...signals, cores }) — the derived (floored) value wins.
    const p = deriveResourceProfile(signals({ cores: 2.7 }));
    expect(p.signals.cores).toBe(2);
    // and the frozen object can't be mutated back.
    expect(() => {
      (p.signals as { cores: number }).cores = 99;
    }).toThrow();
  });

  it('a negative freeMemBytes cannot affect the agent budget at all (WI-41206)', () => {
    // Previously: Math.max(0, freeMemBytes) -> 0 free GiB -> 0 agents-by-ram -> floor of 1.
    // Now free RAM is not an input, so a nonsense reading is simply inert and the budget stays
    // core-derived (128 * 0.5 = 64, clamped to the ceiling of 16).
    const p = deriveResourceProfile(
      signals({ cores: 128, embeddedPg: false, totalMemBytes: 512 * GIB, freeMemBytes: -1 * GIB }),
    );
    expect(p.maxSimultaneousAgents).toBe(16);
  });
});

describe('utility hostRole halves the DBOS queue like request-only (RP3)', () => {
  it('a 16-core utility host gets half the full-host queue depth', () => {
    // queueRoleFactor = hostRole === 'full' ? 1 : 0.5 — 'utility' is in the else.
    // round(16 * 1) = 16 base; * 0.5 = 8.
    const p = deriveResourceProfile(signals({ cores: 16, hostRole: 'utility' }));
    expect(p.dbosQueueConcurrency).toBe(8);
    const full = deriveResourceProfile(signals({ cores: 16, hostRole: 'full' }));
    expect(p.dbosQueueConcurrency).toBeLessThan(full.dbosQueueConcurrency);
  });
});

describe('deriveDatabaseTuning — server (128 cores, 256 GiB, native PG)', () => {
  const t = deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 256 * GIB }));

  it('scales max_connections far past the stock 100 (128 * 4 = 512)', () => {
    expect(t.maxConnections).toBe(512);
    expect(t.maxConnections).toBeGreaterThan(100); // the stock default it replaces
  });

  it('keeps superuser slots reserved so an exhausted pool never locks operators out', () => {
    expect(t.superuserReservedConnections).toBe(10); // round(512 * 0.02)
  });

  it('caps shared_buffers at 32 GiB even when the host-scaled fraction is 64 GiB', () => {
    expect(t.sharedBuffersMb).toBe(32768);
  });

  it('sets effective_cache_size to ~75% RAM (planner hint)', () => {
    expect(t.effectiveCacheSizeMb).toBe(196608); // 256 * 0.75 * 1024
  });

  it('caps maintenance_work_mem at 2 GiB and work_mem at 64 MiB', () => {
    expect(t.maintenanceWorkMemMb).toBe(2048);
    expect(t.workMemMb).toBe(64);
  });

  it('prices the supported SSD/NVMe storage class instead of rotational media', () => {
    expect(t.randomPageCost).toBe(1.1);
    expect(t.effectiveIoConcurrency).toBe(200);
  });

  it('scales the parallel-worker pool to the cores', () => {
    expect(t.maxWorkerProcesses).toBe(128);
    expect(t.maxParallelWorkers).toBe(128);
    expect(t.maxParallelWorkersPerGather).toBe(8); // clamp(round(128/2), 1, 8)
    expect(t.maxParallelMaintenanceWorkers).toBe(8);
  });

  it('never lets the parallel cap exceed the worker-process pool (PG invariant)', () => {
    expect(t.maxParallelWorkers).toBeLessThanOrEqual(t.maxWorkerProcesses);
    expect(t.maxParallelWorkersPerGather).toBeLessThanOrEqual(t.maxParallelWorkers);
  });
});

describe('deriveDatabaseTuning — laptop with embedded PG sits on the floors', () => {
  const t = deriveDatabaseTuning(signals({ cores: 4, embeddedPg: true, totalMemBytes: 8 * GIB, freeMemBytes: 8 * GIB }));

  it('floors max_connections at 100 (a small box never goes below the stock ceiling)', () => {
    expect(t.maxConnections).toBe(100); // clamp(4 * 4, 100, 1000)
    expect(t.superuserReservedConnections).toBe(3); // floor
  });

  it('takes only a gentle slice of a shared box (15% RAM, not 25%)', () => {
    expect(t.sharedBuffersMb).toBe(Math.round(8 * 1024 * 0.15)); // 1229
  });

  it('floors the worker pool at 8 (== the PG default, no regression on tiny hosts)', () => {
    expect(t.maxWorkerProcesses).toBe(8);
    expect(t.maxParallelWorkers).toBe(8);
    expect(t.maxParallelWorkersPerGather).toBe(2); // round(4 / 2)
  });
});

describe('deriveDatabaseTuning — embedded takes a gentler RAM slice than dedicated', () => {
  it('shared_buffers + effective_cache_size shrink when the DB shares the box', () => {
    const dedicated = deriveDatabaseTuning(signals({ cores: 16, embeddedPg: false, totalMemBytes: 64 * GIB }));
    const embedded = deriveDatabaseTuning(signals({ cores: 16, embeddedPg: true, totalMemBytes: 64 * GIB }));
    expect(embedded.sharedBuffersMb).toBeLessThan(dedicated.sharedBuffersMb);
    expect(embedded.effectiveCacheSizeMb).toBeLessThan(dedicated.effectiveCacheSizeMb);
    expect(dedicated.sharedBuffersMb).toBe(16384); // 64 * 0.25 * 1024
    expect(embedded.sharedBuffersMb).toBe(9830); // round(64 * 0.15 * 1024)
  });
});

describe('deriveDatabaseTuning — non-finite signals never poison the knobs', () => {
  it('NaN cores → finite knobs on the floor', () => {
    const t = deriveDatabaseTuning(signals({ cores: NaN, totalMemBytes: NaN }));
    for (const v of Object.values(t)) expect(Number.isFinite(v)).toBe(true);
    expect(t.maxConnections).toBe(100); // 1 core * 4 -> floored to 100
    expect(t.sharedBuffersMb).toBeGreaterThanOrEqual(128); // RAM floored to 0.5 GiB -> floor
  });
});

describe('deriveDatabaseTuning — physicalCores overrides cgroup-quota-scoped cores (WI-5456)', () => {
  it('uses physicalCores for maxConnections when supplied, ignoring the quota-scoped cores', () => {
    // The exact bg-host shape: a systemd unit with CPUQuota=1600% (~16-core quota)
    // on the real 128-core box. `cores` (availableParallelism, quota-aware) sees 16;
    // `physicalCores` (os.cpus().length) sees the real 128.
    const t = deriveDatabaseTuning(
      signals({ cores: 16, physicalCores: 128, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 256 * GIB }),
    );
    expect(t.maxConnections).toBe(512); // 128 * 4, NOT clamp(16*4, 100, 1000)=100
  });

  it('falls back to cores when physicalCores is not supplied (no behavior change for existing callers)', () => {
    const withoutPhysical = deriveDatabaseTuning(
      signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 256 * GIB }),
    );
    const withPhysicalEqual = deriveDatabaseTuning(
      signals({ cores: 128, physicalCores: 128, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 256 * GIB }),
    );
    expect(withoutPhysical.maxConnections).toBe(512);
    expect(withoutPhysical).toEqual(withPhysicalEqual);
  });

  it('reproduces the WI-5456 pool-collapse math end to end: quota-scoped cores starve boundedOrgPoolMax to 1, physicalCores fixes it', () => {
    // bg-host's real config: PAPERCUSP_DB_POOL_MAX=24, PAPERCUSP_EXPECTED_OPERATOR_PROCS=6,
    // CPUQuota=1600% (cores=16) on a 128-core / 512-max_connections box.
    const quotaScoped = deriveDatabaseTuning(signals({ cores: 16, embeddedPg: false, totalMemBytes: 256 * GIB }));
    expect(quotaScoped.maxConnections).toBe(100); // the bug: floor-clamped estimate, not the live 512

    const brokenPoolMax = boundedOrgPoolMax({
      desired: 24,
      maxConnections: quotaScoped.maxConnections,
      superuserReserved: quotaScoped.superuserReservedConnections,
      expectedProcesses: 6,
    });
    expect(brokenPoolMax).toBe(1); // reproduces the observed live `poolMax 1`

    const fixed = deriveDatabaseTuning(
      signals({ cores: 16, physicalCores: 128, embeddedPg: false, totalMemBytes: 256 * GIB }),
    );
    expect(fixed.maxConnections).toBe(512);

    const fixedPoolMax = boundedOrgPoolMax({
      desired: 24,
      maxConnections: fixed.maxConnections,
      superuserReserved: fixed.superuserReservedConnections,
      expectedProcesses: 6,
    });
    expect(fixedPoolMax).toBe(24); // the intended desired size is honored once maxConnections is real
  });
});

describe('detectResourceSignals — auto-fills physicalCores from os.cpus().length', () => {
  it('returns a physicalCores signal alongside cores', async () => {
    const { detectResourceSignals } = await import('./index');
    const s = detectResourceSignals();
    expect(typeof s.physicalCores).toBe('number');
    expect(s.physicalCores).toBeGreaterThan(0);
  });

  it('an explicit override still wins (existing override semantics preserved)', async () => {
    const { detectResourceSignals } = await import('./index');
    const s = detectResourceSignals({ physicalCores: 999 });
    expect(s.physicalCores).toBe(999);
  });

  it('loads Node built-ins through the Node 22 ESM-safe loader', async () => {
    const getBuiltinModule = vi.spyOn(process, 'getBuiltinModule');
    try {
      const { detectResourceSignals } = await import('./index');
      expect(detectResourceSignals().cores).toBeGreaterThan(0);
      expect(getBuiltinModule).toHaveBeenCalledWith('node:os');
    } finally {
      getBuiltinModule.mockRestore();
    }
  });
});

describe('databaseTuningToSettings — renders GUC strings with units', () => {
  it('counts are plain, sizes carry MB', () => {
    const t = deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB }));
    const s = databaseTuningToSettings(t);
    expect(s.max_connections).toBe('512');
    expect(s.shared_buffers).toBe('32768MB');
    expect(s.effective_cache_size).toBe('196608MB');
    expect(s.work_mem).toBe('64MB');
    expect(s.random_page_cost).toBe('1.1');
    expect(s.effective_io_concurrency).toBe('200');
    expect(s.max_parallel_workers_per_gather).toBe('8');
    // WI-347 — the WAL-disk-fill-SPOF defense bound ships in the GUC map (so it
    // reaches BOTH the native conf.d drop-in and the embedded-pg -c flags). A
    // fixed safety ceiling: complements storage/replication-slot-alarm.ts, which
    // only WARNS when a stuck slot pins WAL under the PG default of -1 (unbounded).
    expect(s.max_slot_wal_keep_size).toBe('32GB');
  });

  it('keeps the planner I/O profile fixed across supported host sizes', () => {
    const big = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
    );
    const small = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB })),
    );
    expect(big.random_page_cost).toBe('1.1');
    expect(small.random_page_cost).toBe(big.random_page_cost);
    expect(big.effective_io_concurrency).toBe('200');
    expect(small.effective_io_concurrency).toBe(big.effective_io_concurrency);
  });

  it('the WAL-keep cap is a fixed safety ceiling regardless of host size', () => {
    // Defense-in-depth, not host-tuned: a tiny embedded host and a big server box
    // both get the same bound (it only ever caps a pathological stuck slot).
    const big = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
    );
    const small = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB })),
    );
    expect(big.max_slot_wal_keep_size).toBe('32GB');
    expect(small.max_slot_wal_keep_size).toBe('32GB');
  });

  it('bounds logged bind parameters on every host so slow-query logging cannot fill the disk (WI-10002867)', () => {
    // PG's default -1 wrote multi-MB bound payloads for every slow statement:
    // 13.4 GB of one day's server log was `DETAIL: Parameters:` lines. The cap
    // must be present and finite for native AND embedded hosts alike.
    for (const s of [
      databaseTuningToSettings(
        deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
      ),
      databaseTuningToSettings(
        deriveDatabaseTuning(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB })),
      ),
    ]) {
      for (const k of ['log_parameter_max_length', 'log_parameter_max_length_on_error'] as const) {
        const v = Number(s[k]);
        expect(Number.isInteger(v) && v > 0 && v <= 4096).toBe(true);
      }
    }
  });

  it('scales max_wal_size with the pre-cap host fraction so big hosts retain 8 GiB WAL capacity', () => {
    // 2026-09-23 dev host (128 cores / 252 GiB): at PG's 1 GB default, 2,217 of
    // 5,338 checkpoints were WAL-volume FORCED, and every forced checkpoint
    // re-arms full-page images for every hot page. A big dedicated host must
    // leave that default; a small/embedded host must not grow its WAL footprint.
    const big = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
    );
    const mid = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 16, embeddedPg: false, totalMemBytes: 64 * GIB })),
    );
    const small = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB })),
    );
    expect(big.shared_buffers).toBe('32768MB');
    expect(big.max_wal_size).toBe('8192MB');
    expect(mid.max_wal_size).toBe('2048MB');
    expect(small.max_wal_size).toBe('1024MB');
  });

  it('checkpoint_timeout is a fixed 15min workload-shape setting and reloads without a restart', () => {
    const big = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
    );
    const small = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB })),
    );
    expect(big.checkpoint_timeout).toBe('15min');
    expect(small.checkpoint_timeout).toBe('15min');
    // Applying either must not cost the fleet a PG restart (pg-autotune --apply reloads).
    expect(pgSettingRequiresRestart('max_wal_size')).toBe(false);
    expect(pgSettingRequiresRestart('checkpoint_timeout')).toBe(false);
  });

  it('wal_compression is pglz on every host, the one method embedded builds accept, and reloads', () => {
    for (const embeddedPg of [false, true]) {
      const s = databaseTuningToSettings(
        deriveDatabaseTuning(signals({ cores: 128, embeddedPg, totalMemBytes: 256 * GIB })),
      );
      expect(s.wal_compression).toBe('pglz');
    }
    expect(pgSettingRequiresRestart('wal_compression')).toBe(false);
  });

  // WI-6859 — the JIT-compilation defense. PG gates its LLVM passes on the
  // PLANNER'S COST ESTIMATE, which this workload's jsonb/LATERAL shapes cannot
  // produce reliably: measured 2,101,755 estimated for a plan touching 97
  // buffers, which cleared both 500k thresholds and bought 839 ms of compilation
  // for a query doing 1.3 ms of work. Live delta: 13.68% of ALL database
  // execution time was JIT compilation.
  it('the expensive JIT passes are disabled in the GUC map', () => {
    const s = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
    );
    expect(s.jit_inline_above_cost).toBe('-1');
    expect(s.jit_optimize_above_cost).toBe('-1');
  });

  it('leaves jit itself ON — the cheap passes still earn their keep', () => {
    // Deliberately NOT `jit = off`. Statements doing 38,554 / 8,673 / 5,257 ms of
    // real work per call pay only 37-70 ms of JIT, because their estimates sit
    // BELOW these thresholds — they were only ever buying generation + emission.
    // Raising the two expensive knobs removes the waste without stripping JIT
    // from the queries it exists for.
    const s = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
    );
    expect(s.jit).toBeUndefined();
    expect(s.jit_above_cost).toBeUndefined();
  });

  it('the JIT knobs are a fixed workload shape, not host-scaled', () => {
    // A laptop-class embedded host runs the SAME short-OLTP statements as the
    // 128-core box, so it inherits the same defense.
    const big = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
    );
    const small = databaseTuningToSettings(
      deriveDatabaseTuning(signals({ cores: 2, embeddedPg: true, totalMemBytes: 4 * GIB })),
    );
    expect(small.jit_inline_above_cost).toBe(big.jit_inline_above_cost);
    expect(small.jit_optimize_above_cost).toBe(big.jit_optimize_above_cost);
  });
});

// ---------------------------------------------------------------------------
// Applying the settings to a live server, and detecting drift.
//
// The bug these guard against was silent for weeks: the managed conf.d drop-in
// was hand-appended to (because the only applier path RESTARTS PG, which nobody
// dares do on a shared box), so the live cluster forked from this source of
// truth and BOTH `max_slot_wal_keep_size` and `shared_preload_libraries` were
// dropped without an error anywhere. Reload-vs-restart makes hand-editing
// unnecessary; the diff makes a fork detectable.
// ---------------------------------------------------------------------------

function liveRow(over: Partial<PgLiveSetting> & { name: string }): PgLiveSetting {
  return { setting: '0', unit: null, context: 'sighup', ...over };
}

describe('pgSettingRequiresRestart — the live context wins over the static set', () => {
  it('trusts the server-reported context when given one', () => {
    expect(pgSettingRequiresRestart('max_slot_wal_keep_size', 'sighup')).toBe(false);
    expect(pgSettingRequiresRestart('shared_buffers', 'postmaster')).toBe(true);
  });

  it('a GUC our static set calls restart-only is still reloadable if PG says so', () => {
    // The whole point of preferring the live context: a PostgreSQL version that
    // reclassifies a GUC must not leave us restarting the cluster for nothing.
    expect(PG_RESTART_ONLY_SETTINGS.has('max_connections')).toBe(true);
    expect(pgSettingRequiresRestart('max_connections', 'sighup')).toBe(false);
  });

  it('falls back to the static set when no context is available (offline/--print)', () => {
    expect(pgSettingRequiresRestart('shared_buffers')).toBe(true);
    expect(pgSettingRequiresRestart('max_slot_wal_keep_size')).toBe(false);
    expect(pgSettingRequiresRestart('shared_preload_libraries')).toBe(true);
  });

  it('every GUC in the static set is one we actually emit', () => {
    // A stale name in the set would silently mean "restart for a knob we never
    // set" — cheap to assert, and it keeps the set honest as the map changes.
    const emitted = new Set(
      Object.keys(
        databaseTuningToSettings(
          deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB })),
        ),
      ),
    );
    emitted.add('shared_preload_libraries'); // added by the applier, not the map
    for (const name of PG_RESTART_ONLY_SETTINGS) expect(emitted.has(name)).toBe(true);
  });
});

describe('requiredPgHugePagesForTarget', () => {
  it('permits a 32 GiB target to use an 18,000-page pool after a 64 GiB cluster', () => {
    // The 32,983-page server estimate describes the OLD 64 GiB allocation.
    expect(requiredPgHugePagesForTarget(32768, '64392MB', 32983)).toBe(17408);
    expect(requiredPgHugePagesForTarget(32768, '64392MB', 32983)).toBeLessThan(18000);
  });

  it('retains measured non-buffer shared-memory overhead when it exceeds the margin', () => {
    expect(requiredPgHugePagesForTarget(32768, '64392MB', 34000)).toBe(18188);
  });

  it('uses the conservative target floor when the live server is unreadable', () => {
    expect(requiredPgHugePagesForTarget(32768, null, null)).toBe(17408);
    expect(requiredPgHugePagesForTarget(32768, 'unreadable', 32983)).toBe(17408);
  });
});

describe('parsePgSizeToBytes', () => {
  it('parses config-file size forms', () => {
    expect(parsePgSizeToBytes('32GB')).toBe(32 * 1024 ** 3);
    expect(parsePgSizeToBytes('64392MB')).toBe(64392 * 1024 ** 2);
    expect(parsePgSizeToBytes('1kB')).toBe(1024);
  });

  it('interprets a bare number in the supplied default unit (the 8kB block form)', () => {
    expect(parsePgSizeToBytes('8', 8 * 1024)).toBe(65536);
  });

  it('keeps -1 and 0 as sentinels rather than quantities', () => {
    // `-1` is "unlimited", not "minus one byte" — it must compare UNEQUAL to any
    // real bound, which is exactly the max_slot_wal_keep_size case.
    expect(parsePgSizeToBytes('-1')).toBe(-1);
    expect(parsePgSizeToBytes('0')).toBe(0);
    expect(parsePgSizeToBytes('-1', 1024)).toBe(-1024);
  });

  it('returns null for non-sizes', () => {
    expect(parsePgSizeToBytes('pg_stat_statements')).toBeNull();
    expect(parsePgSizeToBytes('')).toBeNull();
  });
});

describe('diffPgSettings — the drift detector', () => {
  it('reports nothing when live already matches, across units', () => {
    // shared_buffers comes back from pg_settings in 8kB BLOCKS; the target is
    // written in MB. A naive string compare would call this permanent drift.
    const d = diffPgSettings(
      { shared_buffers: '64392MB', work_mem: '64MB', max_parallel_workers: '128' },
      [
        liveRow({ name: 'shared_buffers', setting: String((64392 * 1024 ** 2) / (8 * 1024)), unit: '8kB', context: 'postmaster' }),
        liveRow({ name: 'work_mem', setting: '65536', unit: 'kB', context: 'user' }),
        liveRow({ name: 'max_parallel_workers', setting: '128' }),
      ],
    );
    expect(d.inSync).toBe(true);
    expect(d.diverged).toEqual([]);
    expect(d.reloadSuffices).toBe(false); // no drift ⇒ nothing to reload FOR
  });

  // 2026-09-23: `pg-autotune --apply` set checkpoint_timeout to 15min, the server
  // reported its canonical 900 + unit `s`, and the verify compared the strings and
  // reported a correctly applied setting as "did NOT take effect". Durations must
  // compare by value exactly like sizes do.
  it('compares time-valued GUCs by duration, not by spelling', () => {
    const d = diffPgSettings({ checkpoint_timeout: '15min' }, [
      { name: 'checkpoint_timeout', setting: '900', unit: 's', context: 'sighup' },
    ]);
    expect(d.inSync).toBe(true);
    expect(d.diverged).toEqual([]);
  });

  it('still reports a genuinely different duration as drift', () => {
    const d = diffPgSettings({ checkpoint_timeout: '15min' }, [
      { name: 'checkpoint_timeout', setting: '300', unit: 's', context: 'sighup' },
    ]);
    expect(d.inSync).toBe(false);
    expect(d.diverged.map((x) => x.name)).toEqual(['checkpoint_timeout']);
    expect(d.reloadSuffices).toBe(true);
  });

  it('parsePgDurationToMs reads config-file duration spellings', () => {
    expect(parsePgDurationToMs('15min')).toBe(900_000);
    expect(parsePgDurationToMs('900s')).toBe(900_000);
    expect(parsePgDurationToMs('300', 1000)).toBe(300_000);
    expect(parsePgDurationToMs('250ms')).toBe(250);
    expect(parsePgDurationToMs('1h')).toBe(3_600_000);
    expect(parsePgDurationToMs('-1', 1000)).toBe(-1000);
    expect(parsePgDurationToMs('64MB')).toBeNull();
  });

  it('catches the real regression: max_slot_wal_keep_size unapplied at PG default -1', () => {
    const d = diffPgSettings({ max_slot_wal_keep_size: '32GB' }, [
      liveRow({ name: 'max_slot_wal_keep_size', setting: '-1', unit: 'MB', context: 'sighup' }),
    ]);
    expect(d.inSync).toBe(false);
    expect(d.diverged).toEqual([
      { name: 'max_slot_wal_keep_size', live: '-1MB', target: '32GB', restartOnly: false },
    ]);
    expect(d.reloadSuffices).toBe(true);
    expect(d.restartRequired).toEqual([]);
  });

  it('a postmaster-context divergence forces a restart, and says which one', () => {
    const d = diffPgSettings({ shared_buffers: '64392MB', work_mem: '64MB' }, [
      liveRow({ name: 'shared_buffers', setting: '1024', unit: '8kB', context: 'postmaster' }),
      liveRow({ name: 'work_mem', setting: '4096', unit: 'kB', context: 'user' }),
    ]);
    expect(d.reloadSuffices).toBe(false);
    expect(d.restartRequired).toEqual(['shared_buffers']);
    expect(d.diverged.map((x) => x.name).sort()).toEqual(['shared_buffers', 'work_mem']);
  });

  it('compares list GUCs as a set, so order and quoting are not drift', () => {
    const d = diffPgSettings({ shared_preload_libraries: "'pg_stat_statements,auto_explain'" }, [
      liveRow({ name: 'shared_preload_libraries', setting: 'auto_explain, pg_stat_statements', context: 'postmaster' }),
    ]);
    expect(d.inSync).toBe(true);
  });

  it('a list GUC that genuinely lost a library IS drift', () => {
    const d = diffPgSettings({ shared_preload_libraries: "'pg_stat_statements'" }, [
      liveRow({ name: 'shared_preload_libraries', setting: '', context: 'postmaster' }),
    ]);
    expect(d.restartRequired).toEqual(['shared_preload_libraries']);
  });

  it('separates "unknown to this server" from "diverged" instead of reporting a false diff', () => {
    const d = diffPgSettings({ work_mem: '64MB', not_a_guc: '1' }, [
      liveRow({ name: 'work_mem', setting: '65536', unit: 'kB', context: 'user' }),
    ]);
    expect(d.unknown).toEqual(['not_a_guc']);
    expect(d.diverged).toEqual([]);
    expect(d.inSync).toBe(true); // unknown ≠ drift; it's a different report
  });
});

describe('resource profile exposes the database tuning', () => {
  it('the memoized profile carries the derived DB knobs', () => {
    const p = deriveResourceProfile(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB, freeMemBytes: 256 * GIB }));
    expect(p.database.maxConnections).toBe(512);
    expect(p.database.sharedBuffersMb).toBe(32768);
  });
});

describe('boundedOrgPoolMax — keep org pools under the DB ceiling (C1-1)', () => {
  it('does not reduce when the budget is ample (this box: 52 vs 512)', () => {
    expect(
      boundedOrgPoolMax({ desired: 52, maxConnections: 512, superuserReserved: 10, expectedProcesses: 2 }),
    ).toBe(52);
  });

  it('caps when desired × 2 pools × procs would blow the ceiling (the regression case)', () => {
    // The pre-fix scenario: desired 52, but a 100-slot DB. 2 pools × 2 procs × 52
    // = 208 >> 100. Must come down hard.
    const bounded = boundedOrgPoolMax({
      desired: 52,
      maxConnections: 100,
      superuserReserved: 3,
      expectedProcesses: 2,
    });
    expect(bounded).toBeLessThan(52);
    // invariant holds: 2 pools × 2 procs × bounded + overhead ≤ 100
    expect(bounded * 2 * 2 + 13 * 2 + 32 + 3).toBeLessThanOrEqual(100);
  });

  it('behind a pooler, returns the full desired size (app pool ≠ PG backends)', () => {
    expect(
      boundedOrgPoolMax({
        desired: 52,
        maxConnections: 100,
        superuserReserved: 3,
        expectedProcesses: 2,
        behindPooler: true,
      }),
    ).toBe(52);
  });

  it('never returns below 1', () => {
    expect(
      boundedOrgPoolMax({ desired: 1, maxConnections: 10, superuserReserved: 3, expectedProcesses: 8 }),
    ).toBeGreaterThanOrEqual(1);
  });
});

describe('CI guard (C5-2) — derived pool sizing never exceeds the host-tuned ceiling', () => {
  // The 2026-06-17 outage was pool sizing that ignored the DB ceiling. This is the
  // permanent tripwire: for every host shape, the bounded org pools + per-process
  // fixed overhead + other-DB pools + reserved must fit under max_connections.
  const FIXED_PER_PROC = 13; // admin-cache(8) + 5 LISTEN buses
  const OTHER_DBS = 32; // su-lock in papercusp_su
  const PROCS = 2; // dev box runs :3070 + :3170
  for (const cores of [2, 4, 8, 16, 24, 32, 64, 128, 256]) {
    for (const ramGib of [2, 4, 8, 16, 64, 256, 512]) {
      for (const embeddedPg of [false, true]) {
        it(`fits: ${cores} cores / ${ramGib} GiB / embedded=${embeddedPg}`, () => {
          const p = deriveResourceProfile(
            signals({ cores, embeddedPg, totalMemBytes: ramGib * GIB, freeMemBytes: ramGib * GIB }),
          );
          const db = p.database;
          const bounded = boundedOrgPoolMax({
            desired: p.pgPoolMax,
            maxConnections: db.maxConnections,
            superuserReserved: db.superuserReservedConnections,
            expectedProcesses: PROCS,
          });
          const total =
            bounded * 2 * PROCS + FIXED_PER_PROC * PROCS + OTHER_DBS + db.superuserReservedConnections;
          expect(total).toBeLessThanOrEqual(db.maxConnections);
        });
      }
    }
  }
});

describe('configure + memoized singleton', () => {
  it('injects signals and memoizes the derived profile', () => {
    configureResourceProfile({ cores: 4, embeddedPg: true, freeMemBytes: 8 * GIB });
    const a = getResourceProfile();
    const b = getResourceProfile();
    expect(a).toBe(b); // same frozen object — detection ran once
    expect(a.signals.cores).toBe(4);
    expect(a.signals.embeddedPg).toBe(true);
    expect(a.maxSimultaneousAgents).toBe(1);
  });

  it('throws if configured after the profile is already realized', () => {
    getResourceProfile();
    expect(() => configureResourceProfile({ cores: 99 })).toThrow(/already detected/);
  });

  it('auto-detects with no config (cores >= 1)', () => {
    const p = getResourceProfile();
    expect(p.signals.cores).toBeGreaterThanOrEqual(1);
    expect(p.maxSimultaneousAgents).toBeGreaterThanOrEqual(1);
    expect(p.hostClass).toMatch(/laptop|workstation|server/);
  });
});

describe('diffPgSettings renders a block-unit live value scaled, not glued', () => {
  it('shows 24725888 x 8kB as 197807104kB', () => {
    const drift = diffPgSettings(
      { effective_cache_size: '193172MB' },
      [{ name: 'effective_cache_size', setting: '24725888', unit: '8kB', context: 'user' } as PgLiveSetting],
    );
    expect(drift.diverged).toHaveLength(1);
    expect(drift.diverged[0]?.live).toBe('197807104kB');
  });
});

describe('pg_textsearch memtable budget (BM25 plan P-004)', () => {
  it('keeps the upstream 2 GB on a big host and scales down with shared_buffers', () => {
    const big = deriveDatabaseTuning(signals({ cores: 128, embeddedPg: false, totalMemBytes: 256 * GIB }));
    expect(big.bm25MemtableMemoryLimitMb).toBe(2048);
    expect(databaseTuningToSettings(big)['pg_textsearch.memory_limit']).toBe('2048MB');

    const laptop = deriveDatabaseTuning(signals({ cores: 4, embeddedPg: true, totalMemBytes: 8 * GIB }));
    expect(laptop.bm25MemtableMemoryLimitMb).toBe(Math.max(64, Math.round(laptop.sharedBuffersMb / 8)));
    expect(laptop.bm25MemtableMemoryLimitMb).toBeLessThan(big.bm25MemtableMemoryLimitMb);
  });

  it('never drops below 64 MB', () => {
    const tiny = deriveDatabaseTuning(signals({ cores: 1, embeddedPg: true, totalMemBytes: 1 * GIB }));
    expect(tiny.bm25MemtableMemoryLimitMb).toBe(64);
  });
});

describe('findShadowingPgAssignments — later conf.d files override the managed drop-in', () => {
  const own = '10-papercusp-autotune.conf';
  const keys = ['shared_preload_libraries', 'work_mem'];

  it('reports the dev-box shape: a later file pins shared_preload_libraries', () => {
    expect(findShadowingPgAssignments([
      { name: own, text: "shared_preload_libraries = 'pg_stat_statements,pg_textsearch'\n" },
      { name: '20-pg-stat-statements.conf', text: "# keep stats\nshared_preload_libraries = 'pg_stat_statements'\n" },
    ], own, keys)).toEqual([{ file: '20-pg-stat-statements.conf', key: 'shared_preload_libraries', line: 2 }]);
  });

  it('ignores earlier files, non-.conf files, comments and unmanaged keys', () => {
    expect(findShadowingPgAssignments([
      { name: '05-early.conf', text: 'work_mem = 4MB\n' },
      { name: '20-pg-stat-statements.conf.bak-2026-10-01', text: "shared_preload_libraries = 'x'\n" },
      { name: '30-notes.conf', text: "# work_mem = 1MB\nlog_min_duration_statement = 250\n" },
    ], own, keys)).toEqual([]);
  });

  it('matches every assignment form, case-insensitively, in name order', () => {
    expect(findShadowingPgAssignments([
      { name: '90-b.conf', text: 'WORK_MEM 8MB\n' },
      { name: '50-a.conf', text: "work_mem='16MB'  # tuned\n" },
    ], own, keys)).toEqual([
      { file: '50-a.conf', key: 'work_mem', line: 1 },
      { file: '90-b.conf', key: 'WORK_MEM', line: 1 },
    ]);
  });

  it('does not read a bare prefix of a longer name as the key', () => {
    expect(findShadowingPgAssignments([{ name: '20-x.conf', text: 'work_mem_extra = 1\nwork_me\n' }], own, keys))
      .toEqual([]);
  });
});
