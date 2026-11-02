import { execFileSync } from "node:child_process";
import { readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scriptPath = fileURLToPath(new URL("./capture-signals.py", import.meta.url));

describe("capture-signals.py CLI", () => {
  it.each(["0", "61", "nan"])("refuses invalid memory budget %s before writing a capture", (budget) => {
    const outputDir = mkdtempSync(join(tmpdir(), "capture-signals-invalid-"));
    try {
      expect(() => execFileSync("python3", [scriptPath, "--memory-budget-sec", budget, "--out", outputDir],
        { stdio: "pipe" })).toThrow();
      expect(readdirSync(outputDir)).toEqual([]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("prints help without creating a capture artifact", () => {
    const outputDir = mkdtempSync(join(tmpdir(), "capture-signals-help-"));

    try {
      const help = execFileSync(
        "python3",
        [scriptPath, "--help", "--out", outputDir],
        { encoding: "utf8" },
      );

      expect(help).toContain("usage:");
      expect(help).toContain("--label");
      expect(help).toContain("--out");
      expect(readdirSync(outputDir)).toEqual([]);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});

/** Load capture-signals.py as a module (its filename has a hyphen) and run `body`
 *  with `cs` bound and `root` = a fresh temp dir; `body` prints one JSON line. */
function runPy(body: string): unknown {
  const root = mkdtempSync(join(tmpdir(), "capture-signals-io-"));
  try {
    const code = [
      "import importlib.util, json, os, sys",
      `spec = importlib.util.spec_from_file_location("cs", ${JSON.stringify(scriptPath)})`,
      "cs = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(cs)",
      "root = sys.argv[1]",
      "def put(rel, name, text):",
      "    d = os.path.join(root, rel)",
      "    os.makedirs(d, exist_ok=True)",
      "    open(os.path.join(d, name), 'w').write(text)",
      body,
    ].join("\n");
    return JSON.parse(execFileSync("python3", ["-c", code, root], { encoding: "utf8" }).trim().split("\n").pop()!);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("host memory right-sizing accounting", () => {
  const fixture = [
    "def proc(pid, start=99, huge=0):",
    "    put(f'proc/{pid}', 'stat', f'{pid} (name with (parens)) S ' + '0 ' * 18 + str(start) + '\\n')",
    "    put(f'proc/{pid}', 'smaps_rollup', f'Rss: 100 kB\\nPss: 60 kB\\nPrivate_Clean: 10 kB\\nPrivate_Dirty: 20 kB\\nSwapPss: 5 kB\\nShared_Hugetlb: {huge} kB\\nPrivate_Hugetlb: 0 kB\\nAnonHugePages: 40 kB\\n')",
    "def mapping(address, offset=0, inode=7, resident=2048, flags='ht sh'): ",
    "    return f'{address:x}-{address+2097152:x} rw-s {offset:08x} 00:01 {inode} /same-name\\nSize: 2048 kB\\nShared_Hugetlb: {resident} kB\\nPrivate_Hugetlb: 0 kB\\nVmFlags: {flags}\\n'",
  ].join("\n");

  it("partitions host physical memory without adding reservations, THP or overlapping cache views", () => {
    const out = runPy([
      "put('proc', 'meminfo', 'MemTotal: 16384 kB\\nMemFree: 4096 kB\\nHugetlb: 4096 kB\\nHugepagesize: 2048 kB\\nHugePages_Total: 2\\nHugePages_Free: 1\\nHugePages_Rsvd: 1\\nHugePages_Surp: 1\\nCached: 3000 kB\\nShmem: 1000 kB\\nSlab: 500 kB\\nAnonHugePages: 2048 kB\\n')",
      "print(json.dumps(cs.host_memory(os.path.join(root, 'proc'))))",
    ].join("\n")) as any;
    expect(out.partition).toEqual({ memTotalBytes: 16384 * 1024, memFreeBytes: 4096 * 1024,
      hugeTlbPoolBytes: 4096 * 1024, ordinaryNonFreeBytes: 8192 * 1024 });
    expect(out.hugeTlb).toEqual({ freeBytes: 2048 * 1024, usedBytes: 2048 * 1024,
      reservedSubsetOfFreeBytes: 2048 * 1024 });
    expect(out.overlappingViews.AnonHugePages).toBe(2048 * 1024);
    expect(out.partitionComplete).toBe(true);
  });

  it("keeps a non-default huge-page pool partition and malformed host fields unknown", () => {
    const out = runPy([
      "put('proc', 'meminfo', 'MemTotal: bad kB\\nMemFree: 1 kB\\nHugetlb: 8192 kB\\nHugepagesize: 2048 kB\\nHugePages_Total: 2\\nHugePages_Free: 1\\nHugePages_Rsvd: 1\\n')",
      "print(json.dumps(cs.host_memory(os.path.join(root, 'proc'))))",
    ].join("\n")) as any;
    expect(out.partition.memTotalBytes).toBeNull();
    expect(out.partition.ordinaryNonFreeBytes).toBeNull();
    expect(out.partitionComplete).toBe(false);
    expect(out.hugeTlb).toEqual({ freeBytes: null, usedBytes: null, reservedSubsetOfFreeBytes: null });
  });

  it("unions proven shared backing offsets across virtual aliases and different processes", () => {
    const out = runPy([fixture,
      "proc(10, huge=4096)", "proc(20, huge=4096)",
      "put('proc/10', 'smaps', mapping(0x1000000) + mapping(0x2000000, offset=2097152))",
      "put('proc/20', 'smaps', mapping(0x3000000) + mapping(0x4000000, offset=4194304))",
      "print(json.dumps(cs.process_memory(os.path.join(root, 'proc'))))",
    ].join("\n")) as any;
    // Four mappings, three physical backing ranges; the first page is shared.
    expect(out.explicitHugeTlbBytesAttributed).toBe(3 * 2097152);
    expect(out.hugeTlbAttributionComplete).toBe(true);
    expect(out.ordinaryPssBytesAttributed).toBe(120 * 1024);
    expect(out.ordinaryPrivateBytes).toBe(60 * 1024);
    expect(out.swapPssBytes).toBe(10 * 1024);
    expect(out.uniquePhysicalBytes).toBeNull();
  });

  it("does not merge same-name different backings, partial residency or private COW mappings", () => {
    const out = runPy([fixture,
      "proc(10, huge=2048)", "proc(20, huge=2048)",
      "proc(30, huge=1024)", "proc(40, huge=2048)",
      "put('proc/10', 'smaps', mapping(0x1000000, inode=7))",
      "put('proc/20', 'smaps', mapping(0x1000000, inode=8))",
      "put('proc/30', 'smaps', mapping(0x1000000, resident=1024))",
      "put('proc/40', 'smaps', mapping(0x1000000, flags='ht'))",
      "print(json.dumps(cs.process_memory(os.path.join(root, 'proc'))))",
    ].join("\n")) as any;
    expect(out.explicitHugeTlbBytesAttributed).toBe(2 * 2097152);
    expect(out.hugeTlbBytesInUnresolvedMappings).toBe(3072 * 1024);
    expect(out.hugeTlbAttributionComplete).toBe(false);
  });

  it("reports vanished, malformed and capped populations without measured-zero savings", () => {
    const out = runPy([fixture,
      "proc(10)", "os.makedirs(os.path.join(root, 'proc/20'))", "proc(30)",
      "put('proc/30', 'smaps_rollup', 'Pss: invalid kB\\n')", "proc(40)",
      "print(json.dumps(cs.process_memory(os.path.join(root, 'proc'), max_scanned=3)))",
    ].join("\n")) as any;
    expect(out).toMatchObject({ partial: true, populationCount: 4, scannedProcesses: 3,
      measuredProcesses: 1, unmeasuredProcesses: 2, notScannedProcesses: 1,
      ordinaryPssBytesAttributed: 60 * 1024, uniquePhysicalBytes: null });
    expect(out.unmeasured).toEqual([{ pid: 20, reason: "vanished" }, { pid: 30, reason: "incomplete smaps_rollup" }]);
    expect(out.populationFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("deduplicates partial residency only at proven resident backing offsets", () => {
    const out = runPy([fixture,
      "text = mapping(0x1000000, resident=1024).replace('Size: 2048 kB', 'Size: 2048 kB\\nKernelPageSize: 512 kB')",
      // Present-bit alone identifies a shared file offset; PFNs may be redacted.
      "present = 1 << 63",
      "read = lambda address: present if address in (0x1000000, 0x1100000) else 0",
      "ranges, unknown, observed = cs._hugetlb_backing_ranges(text, read)",
      "bad = cs._hugetlb_backing_ranges(text, lambda _: present)",
      "print(json.dumps({'ranges': ranges, 'unknown': unknown, 'observed': observed, 'changed': bad}))",
    ].join("\n")) as any;
    expect(out.ranges).toEqual([["00:01", 7, 0, 524288], ["00:01", 7, 1048576, 1572864]]);
    expect(out.unknown).toBe(0);
    expect(out.observed).toBe(1024 * 1024);
    // Changed presence no longer agrees with the kernel's resident byte count.
    expect(out.changed).toEqual([[], 1024 * 1024, 1024 * 1024]);
  });

  it("keeps private/anonymous huge pages unknown even with PFNs, avoiding mixed-identity double counts", () => {
    const out = runPy([fixture,
      "text = mapping(0x1000000, inode=0, flags='ht').replace('Size: 2048 kB', 'Size: 2048 kB\\nKernelPageSize: 2048 kB')",
      "known = cs._hugetlb_backing_ranges(text, lambda _: (1 << 63) | 1024)",
      "redacted = cs._hugetlb_backing_ranges(text, lambda _: 1 << 63)",
      "print(json.dumps({'known': known, 'redacted': redacted}))",
    ].join("\n")) as any;
    expect(out.known).toEqual([[], 2097152, 2097152]);
    expect(out.redacted).toEqual([[], 2097152, 2097152]);
  });

  it("captures partially resident shared aliases through actual sparse pagemap fixtures", () => {
    const out = runPy([fixture,
      "for pid, address in [(10, 0x1000000), (20, 0x2000000)]:",
      "    proc(pid, huge=1024)",
      "    text = mapping(address, resident=1024).replace('Size: 2048 kB', 'Size: 2048 kB\\nKernelPageSize: 512 kB')",
      "    put(f'proc/{pid}', 'smaps', text)",
      "    with open(os.path.join(root, f'proc/{pid}/pagemap'), 'wb') as f:",
      "        for delta in [0, 524288, 1048576, 1572864]:",
      "            f.seek((address + delta) // os.sysconf('SC_PAGE_SIZE') * 8)",
      "            f.write(((1 << 63) if delta in [0, 1048576] else 0).to_bytes(8, sys.byteorder))",
      "print(json.dumps(cs.process_memory(os.path.join(root, 'proc'))))",
    ].join("\n")) as any;
    expect(out.explicitHugeTlbBytesAttributed).toBe(1024 * 1024);
    expect(out.hugeTlbBytesInUnresolvedMappings).toBe(0);
    expect(out.hugeTlbAttributionComplete).toBe(true);
  });

  it("discards a PID reused during capture and leaves an entirely unreadable census unknown", () => {
    const out = runPy([fixture, "proc(10)",
      "starts = iter([99, 100])",
      "cs._memory_process_identity = lambda *_: next(starts)",
      "print(json.dumps(cs.process_memory(os.path.join(root, 'proc'))))",
    ].join("\n")) as any;
    expect(out.ordinaryPssBytesAttributed).toBeNull();
    expect(out.swapPssBytes).toBeNull();
    expect(out.unmeasured).toEqual([{ pid: 10, reason: "process-identity-changed" }]);
    expect(out.hugeTlbAttributionComplete).toBe(false);
  });

  it("makes permission and elapsed-budget gaps explicit", () => {
    const out = runPy([fixture, "proc(10)", "proc(20)",
      "cs._process_memory = lambda *_: (_ for _ in ()).throw(PermissionError())",
      "clock = iter([0, 0, 6, 6])",
      "print(json.dumps(cs.process_memory(os.path.join(root, 'proc'), monotonic_fn=lambda: next(clock))))",
    ].join("\n")) as any;
    expect(out).toMatchObject({ partial: true, measuredProcesses: 0, unmeasuredProcesses: 1,
      notScannedProcesses: 1, ordinaryPssBytesAttributed: null });
    expect(out.unmeasured).toEqual([{ pid: 10, reason: "permission-denied" }]);
    expect(out.unmeasuredReasons).toEqual({ "permission-denied": 1 });
  });

  it("distinguishes a stable kernel thread with no userspace mm from an unreadable user process", () => {
    const out = runPy([fixture, "proc(10)", "proc(20)",
      "fields = ['S'] + ['0'] * 18 + ['99']",
      "fields[6] = str(0x00200000)",
      "put('proc/10', 'stat', '10 (kernel thread) ' + ' '.join(fields))",
      "os.remove(os.path.join(root, 'proc/10/smaps_rollup'))",
      "os.remove(os.path.join(root, 'proc/20/smaps_rollup'))",
      "print(json.dumps(cs.process_memory(os.path.join(root, 'proc'))))",
    ].join("\n")) as any;
    expect(out).toMatchObject({ populationCount: 2, scannedProcesses: 2,
      kernelThreadsInHostView: 1, measuredProcesses: 0, unmeasuredProcesses: 1,
      ordinaryPssBytesAttributed: null, partial: true });
    expect(out.unmeasured).toEqual([{ pid: 20, reason: "vanished" }]);
  });
});

// EI-24438849822675827: the 2026-09-27 IO saturation could not be attributed because
// the capture recorded host PSI but neither per-cgroup IO nor the D-state task set.
describe("capture-signals.py IO-stall attribution", () => {
  it("cgroup_io ranks cgroups by bytes moved over the sample and carries their io.pressure", () => {
    const out = runPy([
      "zero = '259:1 rbytes=0 wbytes=0 rios=0 wios=0\\n'",
      "put('cg/a.slice', 'io.stat', zero)",
      // A device absent from the baseline is a new baseline, never a zero-to-counter
      // delta (WI-10003444), so b's baseline names both devices it writes to.
      "put('cg/b.slice', 'io.stat', zero + '259:2 rbytes=0 wbytes=0 rios=0 wios=0\\n')",
      "put('cg/b.slice', 'io.pressure', 'some avg10=50.00 avg60=1.00 avg300=1.00 total=1\\nfull avg10=42.00 avg60=1.00 avg300=1.00 total=1\\n')",
      "put('cg/c.slice', 'io.stat', '259:1 rbytes=0 wbytes=9000000 rios=0 wios=9\\n')",
      "put('cg/idle.slice', 'io.stat', zero)",
      "clock = [0.0]",
      "def sleep(_s):",
      "    clock[0] += 2.0",
      "    put('cg/a.slice', 'io.stat', '259:1 rbytes=0 wbytes=2000000 rios=0 wios=10\\n')",
      "    put('cg/b.slice', 'io.stat', '259:1 rbytes=4000000 wbytes=20000000 rios=8 wios=400\\n259:2 rbytes=0 wbytes=2000000 rios=0 wios=0\\n')",
      "    put('cg/c.slice', 'io.stat', '259:1 rbytes=0 wbytes=1 rios=0 wios=1\\n')",
      "r = cs.cgroup_io(root=os.path.join(root, 'cg'), monotonic_fn=lambda: clock[0], sleep_fn=sleep)",
      "print(json.dumps(r))",
    ].join("\n")) as { top: Array<Record<string, unknown>>; sampleSec: number; partial: boolean };

    expect(out.sampleSec).toBe(2);
    expect(out.partial).toBe(false);
    // b: 22 MB written + 4 MB read over 2 s across two devices; a: 2 MB written.
    // c's counter went BACKWARDS (cgroup recreated) and idle moved nothing: both dropped.
    expect(out.top.map((row) => row.path)).toEqual(["/b.slice", "/a.slice"]);
    expect(out.top[0]).toMatchObject({ writeMBps: 11, readMBps: 2, writeIops: 200, readIops: 4 });
    expect(out.top[0].ioPressure).toMatchObject({ full: { avg10: 42 } });
    expect(out.top[1]).toMatchObject({ writeMBps: 1, ioPressure: null });
  });

  it("cgroup_io preserves per-device deltas and reports new or missing baselines", () => {
    const out = runPy([
      "put('cg/common', 'io.stat', '259:3 rbytes=100 wbytes=200 rios=1 wios=2\\n259:1 rbytes=1000 wbytes=2000 rios=10 wios=20\\n259:9 rbytes=50 wbytes=60 rios=5 wios=6\\n')",
      // grown-cgroup exists at both samples and gains 259:5; new-cgroup exists only at the
      // second. Neither 259:5 nor any new-cgroup device may be counted as a delta.
      "put('cg/grown-cgroup', 'io.stat', '259:8 rbytes=10 wbytes=20 rios=1 wios=2\\n')",
      "put('cg/gone-cgroup', 'io.stat', '259:7 rbytes=10 wbytes=20 rios=1 wios=2\\n')",
      "clock = [0.0]",
      "def sleep(_s):",
      "    clock[0] += 2.0",
      "    put('cg/common', 'io.stat', '259:3 rbytes=150 wbytes=600 rios=2 wios=6\\n259:1 rbytes=3000 wbytes=5000 rios=13 wios=25\\n259:4 rbytes=9000 wbytes=9000 rios=9 wios=9\\n')",
      "    put('cg/grown-cgroup', 'io.stat', '259:8 rbytes=100 wbytes=200 rios=3 wios=4\\n259:5 rbytes=9000 wbytes=9000 rios=9 wios=9\\n')",
      "    put('cg/new-cgroup', 'io.stat', '259:8 rbytes=10 wbytes=20 rios=1 wios=2\\n259:5 rbytes=9000 wbytes=9000 rios=9 wios=9\\n')",
      "    os.remove(os.path.join(root, 'cg/gone-cgroup', 'io.stat'))",
      "r = cs.cgroup_io(root=os.path.join(root, 'cg'), monotonic_fn=lambda: clock[0], sleep_fn=sleep)",
      "print(json.dumps(r))",
    ].join("\n")) as {
      top: Array<Record<string, any>>;
      deviceSummary: Array<Record<string, unknown>>;
      newCgroupBaselines: Array<Record<string, unknown>>;
      newCgroupCount: number;
      missingCgroupBaselines: Array<Record<string, unknown>>;
      missingCgroupCount: number;
    };

    const common = out.top.find((row) => row.path === "/common");
    expect(common?.devices).toEqual([
      {
        devno: "259:1", readBytesDelta: 2000, writeBytesDelta: 3000,
        readIosDelta: 3, writeIosDelta: 5, readMBps: 0, writeMBps: 0,
        readIops: 1.5, writeIops: 2.5,
      },
      {
        devno: "259:3", readBytesDelta: 50, writeBytesDelta: 400,
        readIosDelta: 1, writeIosDelta: 4, readMBps: 0, writeMBps: 0,
        readIops: 0.5, writeIops: 2,
      },
    ]);
    expect(common).toMatchObject({
      newDeviceBaselines: ["259:4"],
      missingDeviceBaselines: ["259:9"],
      counterResetDevices: [],
    });
    expect(out.top.find((row) => row.path === "/grown-cgroup")).toMatchObject({
      newDeviceBaselines: ["259:5"],
      missingDeviceBaselines: [],
    });
    expect(out.newCgroupCount).toBe(1);
    expect(out.newCgroupBaselines).toEqual([{ path: "new-cgroup", devices: ["259:5", "259:8"] }]);
    expect(out.missingCgroupCount).toBe(1);
    expect(out.missingCgroupBaselines).toEqual([{ path: "gone-cgroup", devices: ["259:7"] }]);
    expect(out.deviceSummary).toEqual(expect.arrayContaining([
      expect.objectContaining({ devno: "259:1", changedCgroups: 1, writeBytesDeltaInclusive: 3000 }),
      expect.objectContaining({ devno: "259:3", changedCgroups: 1, writeBytesDeltaInclusive: 400 }),
      expect.objectContaining({ devno: "259:4", newBaselines: 1, writeBytesDeltaInclusive: 0 }),
      expect.objectContaining({ devno: "259:5", newBaselines: 2, writeBytesDeltaInclusive: 0 }),
      expect.objectContaining({ devno: "259:7", missingBaselines: 1 }),
      // 259:8 moved 180 bytes in grown-cgroup; new-cgroup's counters are a baseline only.
      expect.objectContaining({ devno: "259:8", changedCgroups: 1, newBaselines: 1, writeBytesDeltaInclusive: 180 }),
      expect.objectContaining({ devno: "259:9", missingBaselines: 1 }),
    ]));
  });

  it("dstate_tasks counts D-state threads by command, wait channel and cgroup", () => {
    const out = runPy([
      "def task(pid, tid, comm, state, wchan, cg):",
      "    put(f'proc/{pid}/task/{tid}', 'stat', f'{tid} ({comm}) {state} 1 2 3\\n')",
      "    put(f'proc/{pid}/task/{tid}', 'wchan', wchan)",
      "    put(f'proc/{pid}', 'cgroup', f'0::{cg}\\n')",
      "task(100, 100, 'kworker/u256:3+flush-259:1', 'D', 'rq_qos_wait', '/')",
      "task(101, 101, 'kworker/u256:7+flush-259:1', 'D', 'rq_qos_wait', '/')",
      "task(200, 200, 'pg (odd) name', 'D', 'jbd2_log_wait_commit', '/system.slice/pg.service')",
      "task(300, 300, 'bash', 'S', 'do_wait', '/user.slice')",
      "task(300, 301, 'node', 'D', 'folio_wait_bit', '/user.slice')",
      "put('proc', 'self-not-a-pid', '')",
      "r = cs.dstate_tasks(proc_root=os.path.join(root, 'proc'))",
      "print(json.dumps(r))",
    ].join("\n")) as Record<string, unknown>;

    expect(out).toMatchObject({ available: true, dStateTasks: 4, scannedTasks: 5, partial: false });
    expect(out.topComms).toEqual([
      { comm: "kworker/*+flush-259:1", count: 2 },
      { comm: "node", count: 1 },
      { comm: "pg (odd) name", count: 1 },
    ]);
    expect(out.topWchans).toContainEqual({ wchan: "rq_qos_wait", count: 2 });
    expect(out.topCgroups).toEqual([
      { cgroup: "/", count: 2 },
      { cgroup: "/system.slice/pg.service", count: 1 },
      { cgroup: "/user.slice", count: 1 },
    ]);
  });

  // WI-10005308: cgroupIo sums across devices, so an incident could not name the stalled disk.
  it("disk_stats reports per-disk rates, waits, queue depth and mounts for whole disks only", () => {
    const out = runPy([
      "put('sys/block/nvme0n1', 'size', '1')",
      "put('sys/block/nvme1n1/nvme1n1p2', 'partition', '2')",
      "put('sys/block/sdb', 'size', '1')",
      "put('sys/block/loop0', 'size', '1')",
      "put('sys/block/nbd0', 'size', '1')",
      "put('proc', 'mounts', '/dev/nvme1n1p2 / ext4 rw 0 0\\n/dev/nvme0n1 /tmp xfs rw 0 0\\n/dev/nvme0n1 /mnt/data xfs rw 0 0\\ntmpfs /run tmpfs rw 0 0\\n')",
      "put('proc', 'diskstats', ''.join([",
      "  ' 259 0 nvme0n1 100 0 1000 50 200 0 4000 400 0 100 0 0 0 0 0 0 0\\n',",
      "  ' 259 1 nvme1n1 100 0 1000 50 200 0 4000 400 0 100 0 0 0 0 0 0 0\\n',",
      "  ' 259 3 nvme1n1p2 100 0 1000 50 200 0 4000 400 0 100 0 0 0 0 0 0 0\\n',",
      "  '   8 16 sdb 500 0 5000 0 500 0 5000 0 0 0 0\\n',",
      "  '   7 0 loop0 1 0 1 0 0 0 0 0 0 0 0\\n',",
      "  '  43 0 nbd0 0 0 0 0 0 0 0 0 0 0 0\\n']))",
      "clock = [0.0]",
      "def sleep(_s):",
      "    clock[0] += 2.0",
      "    put('proc', 'diskstats', ''.join([",
      "      ' 259 0 nvme0n1 100 0 1000 50 210 0 4020 410 0 120 0 0 0 0 0 0 0\\n',",
      "      ' 259 1 nvme1n1 300 0 401000 2050 600 0 204000 200400 329 2100 0 0 0 0 0 0 0\\n',",
      "      ' 259 3 nvme1n1p2 300 0 401000 2050 600 0 204000 200400 329 2100 0 0 0 0 0 0 0\\n',",
      "      '   8 16 sdb 10 0 100 0 500 0 5000 0 0 0 0\\n',",
      "      '   7 0 loop0 9 0 9 0 0 0 0 0 0 0 0\\n',",
      "      '  43 0 nbd0 0 0 0 0 0 0 0 0 0 0 0\\n']))",
      "r = cs.disk_stats(proc_root=os.path.join(root, 'proc'), sys_block_root=os.path.join(root, 'sys/block'), monotonic_fn=lambda: clock[0], sleep_fn=sleep)",
      "print(json.dumps(r))",
    ].join("\n")) as { available: boolean; sampleSec: number; devices: Array<Record<string, unknown>> };

    expect(out).toMatchObject({ available: true, sampleSec: 2, wholeDisksKnown: true });
    // nvme1n1p2 is a partition (not in sys/block), loop0 is skipped by prefix, sdb's
    // read counter went BACKWARDS (reset) and nbd0 is idle + unmounted: none may appear.
    expect(out.devices.map((row) => row.device)).toEqual(["nvme1n1", "nvme0n1"]);
    expect(out.devices[0]).toEqual({
      device: "nvme1n1", devno: "259:1", mounts: ["/"],
      readMBps: 102.4, writeMBps: 51.2, readIops: 100, writeIops: 200,
      readAwaitMs: 10, writeAwaitMs: 500, inFlight: 329, utilPct: 100,
    });
    expect(out.devices[1]).toEqual({
      device: "nvme0n1", devno: "259:0", mounts: ["/mnt/data", "/tmp"],
      readMBps: 0, writeMBps: 0.01, readIops: 0, writeIops: 5,
      readAwaitMs: null, writeAwaitMs: 1, inFlight: 0, utilPct: 1,
    });
  });

  it("disk_stats reports an unreadable /proc/diskstats as unavailable, never as idle disks", () => {
    const out = runPy("print(json.dumps(cs.disk_stats(proc_root=os.path.join(root, 'missing'))))");
    expect(out).toEqual({ available: false, devices: null });
  });

  it("dstate_tasks reports an unreadable /proc as unavailable, never as zero D-state tasks", () => {
    const out = runPy("print(json.dumps(cs.dstate_tasks(proc_root=os.path.join(root, 'missing'))))");
    expect(out).toEqual({ available: false, dStateTasks: null, partial: true });
  });

  it("keeps an io-pressure incident copy at full avg10 >= 20, at most once per gap", () => {
    const out = runPy([
      "src = os.path.join(root, '2026-10-02T020000Z-cron.json')",
      "open(src, 'w').write('{}')",
      "hot = {'io': {'full': {'avg10': 31.5}}}",
      "first = cs.maybe_preserve_io_incident(hot, root, src)",
      "again = cs.maybe_preserve_io_incident(hot, root, src)",
      "calm = cs.maybe_preserve_io_incident({'io': {'full': {'avg10': 5.0}}}, root, src, min_gap_sec=0)",
      "missing = cs.maybe_preserve_io_incident({'io': None}, root, src, min_gap_sec=0)",
      "print(json.dumps({'first': os.path.basename(first or ''), 'again': again, 'calm': calm, 'missing': missing, 'files': sorted(os.listdir(root))}))",
    ].join("\n"));
    expect(out).toEqual({
      first: "2026-10-02T020000Z-cron-incident-io-pressure.json",
      again: null,
      calm: null,
      missing: null,
      files: ["2026-10-02T020000Z-cron-incident-io-pressure.json", "2026-10-02T020000Z-cron.json"],
    });
  });

  it("prunes its own io-pressure incident copies past retention (no crit edge ever prunes them)", () => {
    const out = runPy([
      "old = os.path.join(root, '2026-09-01T000000Z-scheduled-incident-io-pressure.json')",
      "open(old, 'w').write('{}')",
      "os.utime(old, (1, 1))",
      "src = os.path.join(root, '2026-10-02T020000Z-scheduled.json')",
      "open(src, 'w').write('{}')",
      "made = cs.maybe_preserve_io_incident({'io': {'full': {'avg10': 25.0}}}, root, src)",
      "print(json.dumps({'made': os.path.basename(made or ''), 'files': sorted(os.listdir(root))}))",
    ].join("\n"));
    expect(out).toEqual({
      made: "2026-10-02T020000Z-scheduled-incident-io-pressure.json",
      files: ["2026-10-02T020000Z-scheduled-incident-io-pressure.json", "2026-10-02T020000Z-scheduled.json"],
    });
  });
});
