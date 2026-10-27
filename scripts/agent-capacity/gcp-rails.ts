/**
 * Safety rails for the agent-capacity GCP test runs.
 *
 * Plan agent-capacity-and-cost-gcp-2026-09-30, P-001 (WI-10004370). D-082 (2026-10-21)
 * removes D-002's historical $200 programme ceiling. Finite per-run reservations,
 * concurrent worst-case admission, actual-cost accounting and verified cleanup remain.
 * The product's strict under-$20/month acceptance requirement is a separate outcome.
 *
 * The rails, in the order they fire:
 *
 * 1. PROJECT — every VM lives in the dedicated test project `pc-agent-capacity-0930`, whose
 *    historical $200 budget alert (`agent-capacity-gcp-test-cap-200`) is scoped to that project only
 *    and is informational under D-082, not the programme's current spending authority.
 *    The default gcloud project is shared with unrelated long-lived VMs, so a budget or a
 *    sweep there would count or touch someone else's machines. A create against any other
 *    project is refused.
 * 2. LABELS — every VM carries the plan, run and worst-case-cost labels, so the sweep finds
 *    it and the live census can sum what is still committed.
 * 3. SELF-DELETE — every VM is created with a GCP-enforced `--max-run-duration` and
 *    `--instance-termination-action=DELETE`. A VM this machine forgets (crash, lost session,
 *    compaction) still deletes itself; nothing here has to stay alive for that to happen.
 * 4. WORST-CASE ADMISSION — a create is refused when its worst-case cost (list price x max
 *    run hours, disk included) plus the worst case already committed by live VMs would exceed
 *    the concurrent ceiling. Budget alerts only email; this is the rail that actually refuses.
 * 5. VERIFIED TEARDOWN — teardown deletes instances by run label and re-reads all supported
 *    billable resource kinds. A run verifies only with no run-labelled residue and no orphaned
 *    disk. Shared plan resources are reported separately; this is not programme settlement.
 *
 * Prices come from the Cloud Billing Catalog API (service 6F81-5844-456A, us-central1,
 * OnDemand, read 2026-09-30). They are list prices, not a quote; the budget alert is the
 * backstop for anything this estimate misses.
 */
import { execFile } from 'node:child_process';

export const TEST_PROJECT = 'pc-agent-capacity-0930';
export const PLAN_SLUG = 'agent-capacity-and-cost-gcp-2026-09-30';
export const DEFAULT_ZONE = 'us-central1-a';
export const DEFAULT_IMAGE_FAMILY = 'ubuntu-2404-lts-amd64';
export const DEFAULT_IMAGE_PROJECT = 'ubuntu-os-cloud';
export const DEFAULT_DISK_GB = 50;
/** Longest single VM lifetime any run may request. */
export const MAX_RUN_HOURS_CEILING = 12;
/** Ceiling on worst-case dollars committed by all live test VMs at once. */
export const MAX_CONCURRENT_WORST_CASE_USD = 50;

export const LABEL_PLAN = 'papercusp-plan';
export const LABEL_EPHEMERAL = 'papercusp-ephemeral';
export const LABEL_RUN = 'papercusp-run';
export const LABEL_MAXCOST = 'papercusp-maxcost-cents';
export const LABEL_PROVISIONING = 'papercusp-provisioning';
/** 'delete' (the default rail) or 'stop' (P-007 reclaim drills): what GCP does at reclaim and at the max-run deadline. */
export const LABEL_ON_RECLAIM = 'papercusp-on-reclaim';

/** USD, us-central1 on-demand, Cloud Billing Catalog API read 2026-09-30. */
export const PRICES_2026_09_30 = {
  e2: { vcpuHour: 0.02181159, gbRamHour: 0.00292353 },
  n2: { vcpuHour: 0.031611, gbRamHour: 0.004237 },
  n2d: { vcpuHour: 0.027502, gbRamHour: 0.003686 },
  // T2D read 2026-10-01 23:40Z (P-008): SKUs "T2D AMD Instance Core/Ram running in Americas".
  // One T2D vCPU is a whole core (no SMT), unlike an e2 vCPU (one hyperthread).
  t2d: { vcpuHour: 0.027502, gbRamHour: 0.003686 },
  // C4A (Arm, Axion) read 2026-10-01 23:40Z (P-008): "C4A Arm Instance Core/Ram running in Americas".
  c4a: { vcpuHour: 0.03086, gbRamHour: 0.00351 },
  // Z3 Titanium SSD follow-up, Cloud Billing Catalog us-central1 read 2026-10-14.
  z3: { vcpuHour: 0.0496531, gbRamHour: 0.0066553 },
  // N4 x86 Hyperdisk trial, Cloud Billing Catalog us-central1 read 2026-10-15.
  n4: { vcpuHour: 0.03119, gbRamHour: 0.00354 },
  c4: { vcpuHour: 0.03465, gbRamHour: 0.003938 },
  balancedDiskGbMonth: 0.1,
} as const;

/**
 * Hyperdisk Balanced, the only boot disk C4A accepts. us-central1, Cloud Billing Catalog read
 * 2026-10-01 23:50Z: capacity 0.08 USD/GiB-month; each disk includes 3000 IOPS and 140 MiB/s;
 * provisioned IOPS above that cost 0.005 USD/IOPS-month and throughput 0.04 USD/MiBps-month.
 */
export const HYPERDISK_BALANCED_2026_10_01 = {
  gbMonth: 0.08,
  includedIops: 3000,
  includedMiBps: 140,
  iopsMonth: 0.005,
  mibpsMonth: 0.04,
} as const;

/** The newer priced families use Hyperdisk boot disks; older families use pd-balanced. */
export function bootDiskType(family: Family): 'pd-balanced' | 'hyperdisk-balanced' {
  return family === 'c4a' || family === 'z3' || family === 'n4' || family === 'c4' ? 'hyperdisk-balanced' : 'pd-balanced';
}

/**
 * Hyperdisk performance provisioned to equal a pd-balanced disk of the same size (3000 + 6 IOPS
 * and 140 + 0.28 MiB/s per GB), so a C4A ramp is not starved or favoured on disk I/O relative to
 * the e2 ramps it is compared with (P-008).
 */
export function hyperdiskMatchingPdBalanced(diskGb: number): { iops: number; mibps: number } {
  return { iops: 3000 + 6 * diskGb, mibps: Math.round(140 + 0.28 * diskGb) };
}

function diskHourUsd(family: Family, diskGb: number): number {
  if (bootDiskType(family) === 'pd-balanced') return (diskGb * PRICES_2026_09_30.balancedDiskGbMonth) / HOURS_PER_MONTH;
  const h = HYPERDISK_BALANCED_2026_10_01;
  const { iops, mibps } = hyperdiskMatchingPdBalanced(diskGb);
  const month =
    diskGb * h.gbMonth +
    Math.max(0, iops - h.includedIops) * h.iopsMonth +
    Math.max(0, mibps - h.includedMiBps) * h.mibpsMonth;
  return month / HOURS_PER_MONTH;
}

/**
 * USD, us-central1 SPOT, Cloud Billing Catalog API read 2026-10-01 09:15Z (plan D-015): about 40%
 * below on-demand. Only families whose spot SKU was actually read are listed; a spot VM in any
 * other family is refused rather than priced by guess (WI-10004749).
 */
export const SPOT_PRICES_2026_10_01: Partial<Record<Family, { vcpuHour: number; gbRamHour: number }>> = {
  e2: { vcpuHour: 0.01309, gbRamHour: 0.001754 },
  // Read 2026-10-01 23:40Z (P-008): "Spot Preemptible T2D AMD Instance Core/Ram running in Americas".
  t2d: { vcpuHour: 0.0165, gbRamHour: 0.002212 },
  // Read 2026-10-01 23:40Z (P-008): "Spot Preemptible C4A Arm Instance Core/Ram running in Americas".
  c4a: { vcpuHour: 0.01387, gbRamHour: 0.001578 },
};
const HOURS_PER_MONTH = 730;

export type Family = 'e2' | 'n2' | 'n2d' | 't2d' | 'c4a' | 'z3' | 'n4' | 'c4';
/** C4A is Arm: it boots the arm64 build of the same Ubuntu LTS. */
export const DEFAULT_ARM_IMAGE_FAMILY = 'ubuntu-2404-lts-arm64';
export interface MachineShape {
  family: Family;
  vcpus: number;
  ramGb: number;
}

const GB_PER_VCPU: Record<string, number> = { standard: 4, highmem: 8, highcpu: 1 };

/**
 * Parse a machine type into vCPUs and RAM. Supports the predefined standard/highmem/highcpu
 * shapes and custom shapes (`e2-custom-4-32768`, RAM in MB), which is how the RAM-heavy
 * shapes in P-016 are expressed. Anything else is refused rather than priced by guess.
 */
export function parseMachineType(machineType: string): MachineShape {
  // Price only the exact shape verified through machine-types describe. Its
  // 3,000 GiB Titanium SSD is built into the shape and billed separately.
  if (machineType === 'z3-highmem-8-highlssd') return { family: 'z3', vcpus: 8, ramGb: 64 };
  // Only this N4 shape has been verified with machine-types describe for P-533.
  if (machineType === 'n4-highmem-8') return { family: 'n4', vcpus: 8, ramGb: 64 };
  // Same-region x86 fallback after N4 stockouts; machine-types describe read 2026-10-15.
  if (machineType === 'c4-standard-8') return { family: 'c4', vcpus: 8, ramGb: 30 };
  const predefined = /^(e2|n2|n2d)-(standard|highmem|highcpu)-(\d+)$/.exec(machineType);
  if (predefined) {
    const vcpus = Number(predefined[3]);
    return { family: predefined[1] as Family, vcpus, ramGb: vcpus * GB_PER_VCPU[predefined[2]] };
  }
  // T2D has only the standard shape (4 GB per vCPU) and no custom shapes.
  const t2d = /^t2d-standard-(\d+)$/.exec(machineType);
  if (t2d) {
    const vcpus = Number(t2d[1]);
    return { family: 't2d', vcpus, ramGb: vcpus * GB_PER_VCPU.standard };
  }
  // C4A's highcpu shape has 2 GB per vCPU (e2/n2 highcpu have 1); no custom shapes.
  const c4a = /^c4a-(standard|highmem|highcpu)-(\d+)$/.exec(machineType);
  if (c4a) {
    const vcpus = Number(c4a[2]);
    const perVcpu = c4a[1] === 'highcpu' ? 2 : GB_PER_VCPU[c4a[1]];
    return { family: 'c4a', vcpus, ramGb: vcpus * perVcpu };
  }
  const custom = /^(e2|n2|n2d)-custom-(\d+)-(\d+)$/.exec(machineType);
  if (custom) {
    return { family: custom[1] as Family, vcpus: Number(custom[2]), ramGb: Number(custom[3]) / 1024 };
  }
  throw new Error(`unpriced machine type '${machineType}': add its shape before starting it`);
}

/** Spot list price for a family, or a refusal: a spot VM is never priced at a guessed discount. */
function spotRates(family: Family): { vcpuHour: number; gbRamHour: number } {
  const p = SPOT_PRICES_2026_10_01[family];
  if (!p) throw new Error(`no measured spot price for family '${family}': read its spot SKU before starting a spot VM`);
  return p;
}

/**
 * Disks a run attaches at create besides the boot disk (WI-10005475, the swap-tier test): data disks
 * of a priced Persistent Disk type, and NVMe Local SSDs. us-central1 on-demand, Cloud Billing Catalog
 * API read 2026-10-14 07:40Z: "Balanced PD Capacity" 0.10, "SSD backed PD Capacity" 0.17 and
 * "SSD backed Local Storage" 0.08 USD/GiB-month. A Local SSD is a fixed 375 GiB device that can only
 * be added at create.
 */
export const EXTRA_DISK_GB_MONTH_2026_10_14 = { 'pd-balanced': 0.1, 'pd-ssd': 0.17, 'hyperdisk-balanced': 0.08 } as const;
export const HYPERDISK_BALANCED_IOPS_MONTH_2026_10_15 = 0.005;
export const HYPERDISK_BALANCED_THROUGHPUT_MONTH_2026_10_15 = 0.04;
export type ExtraDiskType = keyof typeof EXTRA_DISK_GB_MONTH_2026_10_14;
export const LOCAL_SSD_GB_MONTH_2026_10_14 = 0.08;
export const LOCAL_SSD_GB = 375;
/** Families here that take an attached NVMe Local SSD. E2 takes none; C4A only as fixed `-lssd` shapes. */
export const LOCAL_SSD_FAMILIES: readonly Family[] = ['n2', 'n2d'];
const MAX_LOCAL_SSDS = 8;

export interface ExtraDisk {
  type: ExtraDiskType;
  gb: number;
  /** Becomes /dev/disk/by-id/google-<deviceName> on the VM. */
  deviceName: string;
  provisionedIops?: number;
  provisionedThroughputMibps?: number;
}

export interface AttachedDisks {
  extraDisks?: ExtraDisk[];
  localSsds?: number;
}

/** Hyperdisk adds explicit `:<iops>:<mibps>` to the existing type:size:device CLI format. */
export function parseExtraDisk(raw: string): ExtraDisk {
  const [type, gb, deviceName, ...performance] = raw.split(':');
  if (!deviceName) throw new Error(`--extra-disk expects <type>:<gb>:<device-name>[:<iops>:<mibps>], got '${raw}'`);
  if (!Object.hasOwn(EXTRA_DISK_GB_MONTH_2026_10_14, type)) {
    throw new Error(`unpriced extra disk type '${type}': one of ${Object.keys(EXTRA_DISK_GB_MONTH_2026_10_14).join(', ')}`);
  }
  if (type === 'hyperdisk-balanced') {
    if (performance.length !== 2 || performance.some((v) => !v.trim() || !Number.isFinite(Number(v)))) {
      throw new Error('Hyperdisk Balanced --extra-disk requires :<iops>:<mibps>');
    }
    return { type, gb: Number(gb), deviceName, provisionedIops: Number(performance[0]), provisionedThroughputMibps: Number(performance[1]) };
  }
  if (performance.length) throw new Error('provisioned performance is only valid for Hyperdisk Balanced');
  return { type: type as ExtraDiskType, gb: Number(gb), deviceName };
}

function attachedDisksHourUsd(d: AttachedDisks): number {
  const pd = (d.extraDisks ?? []).reduce((sum, x) => {
    const capacity = x.gb * EXTRA_DISK_GB_MONTH_2026_10_14[x.type];
    if (x.type !== 'hyperdisk-balanced') return sum + capacity;
    const iops = Math.max(0, (x.provisionedIops ?? 3000) - 3000) * HYPERDISK_BALANCED_IOPS_MONTH_2026_10_15;
    const throughput = Math.max(0, (x.provisionedThroughputMibps ?? 140) - 140) * HYPERDISK_BALANCED_THROUGHPUT_MONTH_2026_10_15;
    return sum + capacity + iops + throughput;
  }, 0);
  const lssd = (d.localSsds ?? 0) * LOCAL_SSD_GB * LOCAL_SSD_GB_MONTH_2026_10_14;
  return (pd + lssd) / HOURS_PER_MONTH;
}

/** Refuse attached disks the machine cannot take or that are malformed, before anything is priced or created. */
function assertAttachedDisks(family: Family, d: AttachedDisks): void {
  const extra = d.extraDisks ?? [];
  if (extra.length && family === 'z3') throw new Error('Z3 test shape uses its built-in Titanium SSD; extra data disks are not priced here');
  const names = new Set<string>();
  for (const x of extra) {
    if (!Object.hasOwn(EXTRA_DISK_GB_MONTH_2026_10_14, x.type)) throw new Error(`unpriced extra disk type '${x.type}'`);
    const minGb = x.type === 'hyperdisk-balanced' ? 4 : 10;
    if (!Number.isInteger(x.gb) || x.gb < minGb || x.gb > 2048) throw new Error(`extra disk ${x.deviceName}: size ${x.gb} GB must be an integer ${minGb}-2048`);
    if (!/^[a-z][a-z0-9-]{0,61}$/.test(x.deviceName)) throw new Error(`extra disk device name '${x.deviceName}' must be [a-z][a-z0-9-]`);
    if (names.has(x.deviceName)) throw new Error(`duplicate extra disk device name '${x.deviceName}'`);
    names.add(x.deviceName);
    if (x.type === 'hyperdisk-balanced') {
      // Official limits read 2026-10-15: 4/5 GiB fix IOPS at 2000/2500;
      // throughput must also fit MAX(140, IOPS/256)..MIN(2400, IOPS/4).
      // https://cloud.google.com/compute/docs/disks/hd-types/hyperdisk-balanced
      const iops = x.provisionedIops;
      const minIops = x.gb < 6 ? x.gb * 500 : 3000;
      const maxIops = Math.min(160000, x.gb * 500);
      if (iops === undefined || !Number.isInteger(iops) || iops < minIops || iops > maxIops) {
        throw new Error(`Hyperdisk Balanced ${x.deviceName}: provisionedIops must be ${minIops}-${maxIops}`);
      }
      const throughput = x.provisionedThroughputMibps;
      const minThroughput = Math.ceil(Math.max(140, iops / 256));
      const maxThroughput = Math.floor(Math.min(2400, iops / 4));
      if (throughput === undefined || !Number.isInteger(throughput) || throughput < minThroughput || throughput > maxThroughput) {
        throw new Error(`Hyperdisk Balanced ${x.deviceName}: provisionedThroughputMibps must be ${minThroughput}-${maxThroughput}`);
      }
      // Older families need account-team enablement; this benchmark never assumes it.
      if (family !== 'n4' && family !== 'c4a' && family !== 'c4') throw new Error(`Hyperdisk Balanced is not enabled for family '${family}' in these rails`);
    } else if (x.provisionedIops !== undefined || x.provisionedThroughputMibps !== undefined) {
      throw new Error(`provisioned performance is only valid for Hyperdisk Balanced: ${x.deviceName}`);
    } else if (family === 'c4a' || family === 'n4' || family === 'c4') {
      throw new Error(`${family} takes only Hyperdisk: no Persistent Disk data disks`);
    }
  }
  const n = d.localSsds ?? 0;
  if (!Number.isInteger(n) || n < 0 || n > MAX_LOCAL_SSDS) throw new Error(`localSsds ${n} must be an integer 0-${MAX_LOCAL_SSDS}`);
  if (n > 0 && !LOCAL_SSD_FAMILIES.includes(family)) {
    throw new Error(`family '${family}' takes no attached Local SSD here (only ${LOCAL_SSD_FAMILIES.join(', ')})`);
  }
}

/** Hourly list price, disk included (the disk is never spot-discounted). */
export function hourlyPriceUsd(machineType: string, diskGb = DEFAULT_DISK_GB, opts: { spot?: boolean } & AttachedDisks = {}): number {
  const shape = parseMachineType(machineType);
  assertAttachedDisks(shape.family, opts);
  const p = opts.spot ? spotRates(shape.family) : PRICES_2026_09_30[shape.family];
  const includedLocalSsd = shape.family === 'z3' ? (3000 * LOCAL_SSD_GB_MONTH_2026_10_14) / HOURS_PER_MONTH : 0;
  return shape.vcpus * p.vcpuHour + shape.ramGb * p.gbRamHour + diskHourUsd(shape.family, diskGb) + attachedDisksHourUsd(opts) + includedLocalSsd;
}

export function worstCaseCents(machineType: string, maxHours: number, diskGb = DEFAULT_DISK_GB, opts: { spot?: boolean } & AttachedDisks = {}): number {
  return Math.ceil(hourlyPriceUsd(machineType, diskGb, opts) * maxHours * 100);
}

export interface CreateSpec {
  project?: string;
  runId: string;
  name: string;
  machineType: string;
  maxHours: number;
  zone?: string;
  diskGb?: number;
  imageFamily?: string;
  imageProject?: string;
  /** Extra `--metadata-from-file` entries, e.g. `startup-script=/path/to/boot.sh`. */
  metadataFromFile?: string[];
  extraLabels?: Record<string, string>;
  /**
   * Start a SPOT VM (P-007): GCP may reclaim it at any time. The termination action stays DELETE,
   * so a reclaim and the max-run-duration timer both delete it; it is priced at the measured spot rate.
   */
  spot?: boolean;
  /**
   * 'stop' (spot only, P-007 reclaim drills): GCP STOPS the VM at reclaim instead of deleting it, so its
   * disk and saved agent state survive and the drill can measure the restart. GCP has one termination
   * action for both reclaim and the max-run deadline, so the deadline then stops the VM too: it no longer
   * self-deletes, its boot disk keeps costing (~0.10 USD per GB-month), and it stays in the census (status
   * TERMINATED) until `teardown --run` deletes it. Default 'delete'.
   */
  onReclaim?: 'delete' | 'stop';
  /** Persistent Disk data disks, created with the VM and auto-deleted with it (priced into the worst case). */
  extraDisks?: ExtraDisk[];
  /** Attached NVMe Local SSDs, 375 GiB each (n2/n2d only; priced into the worst case). */
  localSsds?: number;
}

const LABEL_VALUE = /^[a-z0-9_-]{1,63}$/;

function assertLabelValue(key: string, value: string): void {
  if (!LABEL_VALUE.test(value)) {
    throw new Error(`label ${key}='${value}' is not a valid GCP label value ([a-z0-9_-], 1-63 chars)`);
  }
}

/** Build the `gcloud` argv for one test VM with every rail applied. Refuses unsafe specs. */
export function buildCreateArgs(spec: CreateSpec): string[] {
  const project = spec.project ?? TEST_PROJECT;
  if (project !== TEST_PROJECT) {
    throw new Error(`refusing to create in project '${project}': capacity tests run only in ${TEST_PROJECT}`);
  }
  if (!Number.isFinite(spec.maxHours) || spec.maxHours <= 0) {
    throw new Error('maxHours is required: every test VM must self-delete');
  }
  if (spec.maxHours > MAX_RUN_HOURS_CEILING) {
    throw new Error(`maxHours ${spec.maxHours} exceeds the ${MAX_RUN_HOURS_CEILING}h ceiling`);
  }
  const onReclaim = spec.onReclaim ?? 'delete';
  if (onReclaim === 'stop' && !spec.spot) {
    throw new Error("onReclaim 'stop' needs a spot VM: an on-demand VM is never reclaimed, and 'stop' only removes its self-delete");
  }
  const diskGb = spec.diskGb ?? DEFAULT_DISK_GB;
  assertAttachedDisks(parseMachineType(spec.machineType).family, spec);
  const labels: Record<string, string> = {
    ...(spec.extraLabels ?? {}),
    [LABEL_PLAN]: PLAN_SLUG,
    [LABEL_EPHEMERAL]: 'true',
    [LABEL_RUN]: spec.runId,
    [LABEL_MAXCOST]: String(worstCaseCents(spec.machineType, spec.maxHours, diskGb, { spot: spec.spot, extraDisks: spec.extraDisks, localSsds: spec.localSsds })),
    [LABEL_PROVISIONING]: spec.spot ? 'spot' : 'standard',
    [LABEL_ON_RECLAIM]: onReclaim,
  };
  for (const [k, v] of Object.entries(labels)) assertLabelValue(k, v);
  const minutes = Math.round(spec.maxHours * 60);
  const family = parseMachineType(spec.machineType).family;
  const diskType = bootDiskType(family);
  const hyperdisk = diskType === 'hyperdisk-balanced' ? hyperdiskMatchingPdBalanced(diskGb) : null;
  const args = [
    'compute', 'instances', 'create', spec.name,
    `--project=${project}`,
    `--zone=${spec.zone ?? DEFAULT_ZONE}`,
    `--machine-type=${spec.machineType}`,
    ...(family === 'z3' ? ['--maintenance-policy=MIGRATE'] : []),
    `--image-family=${spec.imageFamily ?? (family === 'c4a' ? DEFAULT_ARM_IMAGE_FAMILY : DEFAULT_IMAGE_FAMILY)}`,
    `--image-project=${spec.imageProject ?? DEFAULT_IMAGE_PROJECT}`,
    `--boot-disk-size=${diskGb}GB`,
    `--boot-disk-type=${diskType}`,
    ...(hyperdisk
      ? [`--boot-disk-provisioned-iops=${hyperdisk.iops}`, `--boot-disk-provisioned-throughput=${hyperdisk.mibps}`]
      : []),
    '--boot-disk-auto-delete',
    `--max-run-duration=${minutes}m`,
    `--instance-termination-action=${onReclaim === 'stop' ? 'STOP' : 'DELETE'}`,
    `--labels=${Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(',')}`,
    '--format=json',
  ];
  if (spec.metadataFromFile?.length) args.push(`--metadata-from-file=${spec.metadataFromFile.join(',')}`);
  if (spec.spot) args.push('--provisioning-model=SPOT');
  // auto-delete=yes: the VM's own self-delete takes its data disks too, so no run leaves an orphan.
  for (const d of spec.extraDisks ?? []) {
    args.push(`--create-disk=auto-delete=yes,device-name=${d.deviceName},size=${d.gb}GB,type=${d.type}` +
      (d.type === 'hyperdisk-balanced'
        ? `,provisioned-iops=${d.provisionedIops},provisioned-throughput=${d.provisionedThroughputMibps}`
        : ''));
  }
  for (let i = 0; i < (spec.localSsds ?? 0); i++) args.push('--local-ssd=interface=NVME');
  return args;
}

export interface CensusInstance {
  name: string;
  zone: string;
  status: string;
  runId: string | null;
  maxCostCents: number;
  planSlug?: string | null;
}
const RESOURCE_KINDS = ['disks', 'snapshots', 'addresses', 'buckets'] as const;
export interface CensusResource {
  kind: typeof RESOURCE_KINDS[number];
  name: string;
  runId: string | null;
  planSlug: string | null;
}
export interface Census {
  instances: CensusInstance[];
  /** Disks attached to no instance: nothing deletes these automatically. */
  orphanDisks: { name: string; zone: string }[];
  staticAddresses: string[];
  /**
   * Storage buckets (e.g. the artifact bucket the Server .deb is staged in). Shared across
   * runs. Only buckets labelled for this run block its teardown. Shared plan buckets are
   * reported separately; their objects/lifecycle and costs still need programme settlement.
   */
  buckets: string[];
  /** Preserve ownership for run-scoped verification, including attached disks. */
  resources: CensusResource[];
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type Exec = (argv: readonly string[]) => Promise<ExecResult>;

export const gcloudExec: Exec = (argv) =>
  new Promise((resolveExec) => {
    execFile('gcloud', [...argv], { maxBuffer: 16 * 1024 * 1024, timeout: 300_000 }, (err, stdout, stderr) => {
      // execFile reports a non-zero exit as a numeric `code`, a spawn failure as a string one.
      const raw = err ? (err as { code?: unknown }).code : 0;
      const code = typeof raw === 'number' ? raw : err ? 1 : 0;
      resolveExec({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const basename = (url: string | undefined): string => (url ?? '').split('/').pop() ?? '';

async function listJson(exec: Exec, argv: string[]): Promise<Array<Record<string, unknown>>> {
  const r = await exec([...argv, `--project=${TEST_PROJECT}`, '--format=json']);
  if (r.code !== 0) throw new Error(`gcloud ${argv.join(' ')} failed (${r.code}): ${r.stderr.trim()}`);
  const parsed: unknown = JSON.parse(r.stdout);
  if (!Array.isArray(parsed)) throw new Error(`gcloud ${argv.join(' ')} returned non-array JSON`);
  if (parsed.some(row => row === null || typeof row !== 'object'
    || typeof row.name !== 'string' || !row.name.trim())) {
    throw new Error(`gcloud ${argv.join(' ')} returned an invalid resource record`);
  }
  return parsed as Array<Record<string, unknown>>;
}

/** Read everything billable in the test project. Throws if any read fails: no silent empty. */
export async function readCensus(exec: Exec = gcloudExec): Promise<Census> {
  // These SDK processes share config/credential SQLite stores. Do not make one census
  // contend with itself; each command must finish before the next starts.
  const instances = await listJson(exec, ['compute', 'instances', 'list']);
  const disks = await listJson(exec, ['compute', 'disks', 'list']);
  const snapshots = await listJson(exec, ['compute', 'snapshots', 'list']);
  const addresses = await listJson(exec, ['compute', 'addresses', 'list']);
  const buckets = await listJson(exec, ['storage', 'buckets', 'list']);
  const inventories = { disks, snapshots, addresses, buckets };
  return {
    instances: instances.map((i) => {
      const labels = (i.labels ?? {}) as Record<string, string>;
      return {
        name: String(i.name),
        zone: basename(i.zone as string),
        status: String(i.status),
        runId: labels[LABEL_RUN] ?? null,
        maxCostCents: Number(labels[LABEL_MAXCOST] ?? 0),
        planSlug: labels[LABEL_PLAN] ?? null,
      };
    }),
    orphanDisks: disks
      .filter((d) => !Array.isArray(d.users) || (d.users as unknown[]).length === 0)
      .map((d) => ({ name: String(d.name), zone: basename(d.zone as string) })),
    staticAddresses: addresses.map((a) => String(a.name)),
    buckets: buckets.map((b) => String(b.name)),
    resources: RESOURCE_KINDS.flatMap(kind => inventories[kind].map(resource => {
      const labels = (resource.labels ?? {}) as Record<string, string>;
      return { kind, name: String(resource.name), runId: labels[LABEL_RUN] ?? null,
        planSlug: labels[LABEL_PLAN] ?? null };
    })),
  };
}

/** Worst-case cents still committed by VMs that can run (TERMINATED VMs bill only disk). */
export function committedWorstCaseCents(census: Census): number {
  return census.instances
    .filter((i) => i.status !== 'TERMINATED')
    .reduce((sum, i) => sum + i.maxCostCents, 0);
}

export interface AdmissionVerdict {
  admitted: boolean;
  newCents: number;
  committedCents: number;
  ceilingCents: number;
  reason: string;
}

export function admitCreate(spec: CreateSpec, census: Census): AdmissionVerdict {
  const newCents = worstCaseCents(spec.machineType, spec.maxHours, spec.diskGb ?? DEFAULT_DISK_GB, {
    spot: spec.spot,
    extraDisks: spec.extraDisks,
    localSsds: spec.localSsds,
  });
  const committedCents = committedWorstCaseCents(census);
  const ceilingCents = MAX_CONCURRENT_WORST_CASE_USD * 100;
  const admitted = committedCents + newCents <= ceilingCents;
  return {
    admitted,
    newCents,
    committedCents,
    ceilingCents,
    reason: admitted
      ? 'within the concurrent worst-case ceiling'
      : `worst case ${newCents}c + committed ${committedCents}c exceeds the ${ceilingCents}c ceiling`,
  };
}

/** Admission-checked create. Returns the verdict; creates only when admitted. */
export async function createInstance(spec: CreateSpec, exec: Exec = gcloudExec): Promise<AdmissionVerdict & { created: boolean }> {
  const args = buildCreateArgs(spec);
  const verdict = admitCreate(spec, await readCensus(exec));
  if (!verdict.admitted) return { ...verdict, created: false };
  const r = await exec(args);
  if (r.code !== 0) throw new Error(`create ${spec.name} failed (${r.code}): ${r.stderr.trim()}`);
  return { ...verdict, created: true };
}

export interface TeardownResult {
  runId: string;
  deleted: string[];
  remainingInstances: string[];
  orphanDisks: string[];
  remainingResources: CensusResource[];
  sharedResources: CensusResource[];
  checkedResourceKinds: readonly string[];
  verificationScope: 'run-labelled-resources-and-project-orphan-disks';
  verified: boolean;
}

export interface ConvergeOptions {
  /** How long to keep re-reading before declaring the teardown unverified. */
  deadlineMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Delete every instance of a run, then re-read the project until it converges. `verified` is
 * true only when a complete census shows no instance or supported billable resource of that
 * run and no orphaned disk anywhere in the test project. Other resource kinds are reported,
 * never automatically deleted. Shared resources are not proof of programme settlement.
 * The re-read repeats because GCP lists a deleted VM as STOPPING for a while
 * after its delete operation reports DONE (measured 2026-09-30 on cap-rails-smoke-1): one read
 * straight after the delete would report a false leak.
 */
export async function teardownRun(runId: string, exec: Exec = gcloudExec, converge: ConvergeOptions = {}): Promise<TeardownResult> {
  assertLabelValue(LABEL_RUN, runId);
  const before = await readCensus(exec);
  const belongsToRun = (i: CensusInstance) => i.runId === runId
    && (i.planSlug == null || i.planSlug === PLAN_SLUG);
  const targets = before.instances.filter(belongsToRun);
  const byZone = new Map<string, string[]>();
  for (const t of targets) byZone.set(t.zone, [...(byZone.get(t.zone) ?? []), t.name]);
  for (const [zone, names] of byZone) {
    const r = await exec(['compute', 'instances', 'delete', ...names, `--project=${TEST_PROJECT}`, `--zone=${zone}`, '--quiet']);
    if (r.code !== 0) throw new Error(`delete in ${zone} failed (${r.code}): ${r.stderr.trim()}`);
  }
  const deadlineMs = converge.deadlineMs ?? 300_000;
  const intervalMs = converge.intervalMs ?? 10_000;
  const sleep = converge.sleep ?? realSleep;
  let waitedMs = 0;
  let remainingInstances: string[];
  let orphanDisks: string[];
  let remainingResources: CensusResource[];
  let sharedResources: CensusResource[];
  for (;;) {
    const after = await readCensus(exec);
    remainingInstances = after.instances.filter(belongsToRun).map((i) => i.name);
    orphanDisks = after.orphanDisks.map((d) => d.name);
    remainingResources = after.resources.filter(resource => resource.runId === runId
      && (resource.planSlug === PLAN_SLUG || resource.planSlug === null));
    sharedResources = after.resources.filter(resource => resource.runId === null
      && resource.planSlug === PLAN_SLUG);
    if ((remainingInstances.length === 0 && orphanDisks.length === 0 && remainingResources.length === 0)
      || waitedMs >= deadlineMs) break;
    await sleep(intervalMs);
    waitedMs += intervalMs;
  }
  return {
    runId,
    deleted: targets.map((t) => t.name),
    remainingInstances,
    orphanDisks,
    remainingResources,
    sharedResources,
    checkedResourceKinds: ['instances', ...RESOURCE_KINDS],
    verificationScope: 'run-labelled-resources-and-project-orphan-disks',
    verified: remainingInstances.length === 0 && orphanDisks.length === 0 && remainingResources.length === 0,
  };
}

function flag(argv: string[], name: string): string | undefined {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function main(argv: string[]): Promise<number> {
  const [cmd] = argv;
  if (cmd === 'census') {
    const census = await readCensus();
    console.log(JSON.stringify({ ...census, committedWorstCaseCents: committedWorstCaseCents(census) }, null, 2));
    return 0;
  }
  if (cmd === 'create') {
    const reclaimFlag = flag(argv, 'on-reclaim');
    if (reclaimFlag !== undefined && reclaimFlag !== 'stop' && reclaimFlag !== 'delete') {
      console.error(`--on-reclaim must be 'stop' or 'delete', got '${reclaimFlag}'`);
      return 2;
    }
    const spec: CreateSpec = {
      runId: flag(argv, 'run') ?? '',
      name: flag(argv, 'name') ?? '',
      machineType: flag(argv, 'machine-type') ?? '',
      maxHours: Number(flag(argv, 'max-hours')),
      zone: flag(argv, 'zone'),
      diskGb: flag(argv, 'disk-gb') ? Number(flag(argv, 'disk-gb')) : undefined,
      metadataFromFile: flag(argv, 'metadata-from-file')?.split(','),
      imageFamily: flag(argv, 'image-family'),
      imageProject: flag(argv, 'image-project'),
      spot: argv.includes('--spot'),
      onReclaim: reclaimFlag as CreateSpec['onReclaim'],
      // Repeatable: Hyperdisk adds :<iops>:<mibps> after type:size:device.
      extraDisks: argv.filter((a) => a.startsWith('--extra-disk=')).map((a) => parseExtraDisk(a.slice('--extra-disk='.length))),
      localSsds: flag(argv, 'local-ssds') ? Number(flag(argv, 'local-ssds')) : undefined,
    };
    const result = await createInstance(spec);
    console.log(JSON.stringify(result, null, 2));
    return result.created ? 0 : 3;
  }
  if (cmd === 'teardown') {
    const result = await teardownRun(flag(argv, 'run') ?? '');
    console.log(JSON.stringify(result, null, 2));
    return result.verified ? 0 : 4;
  }
  console.error('usage: gcp-rails.ts census | create --run= --name= --machine-type= --max-hours= [--zone= --disk-gb= --metadata-from-file= --image-family= --image-project= --spot [--on-reclaim=stop] --extra-disk=<pd-balanced|pd-ssd>:<gb>:<device-name> | --extra-disk=hyperdisk-balanced:<gb>:<device-name>:<iops>:<mibps> (repeatable) --local-ssds=<n>] | teardown --run=');
  return 2;
}

if (process.argv[1] && /gcp-rails\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
