import { describe, expect, it } from 'vitest';
import {
  admitCreate,
  buildCreateArgs,
  committedWorstCaseCents,
  hourlyPriceUsd,
  LABEL_MAXCOST,
  LABEL_ON_RECLAIM,
  LABEL_PROVISIONING,
  LABEL_RUN,
  MAX_CONCURRENT_WORST_CASE_USD,
  parseExtraDisk,
  parseMachineType,
  PLAN_SLUG,
  readCensus,
  SPOT_PRICES_2026_10_01,
  teardownRun,
  TEST_PROJECT,
  worstCaseCents,
  type Census,
  type Exec,
} from './gcp-rails';

const spec = { runId: 'cal-1', name: 'cap-cal-1', machineType: 'e2-standard-4', maxHours: 4 };

function flagValue(args: string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

describe('buildCreateArgs', () => {
  it('applies every rail: test project, self-delete timer, labels', () => {
    const args = buildCreateArgs(spec);
    expect(flagValue(args, 'project')).toBe(TEST_PROJECT);
    expect(flagValue(args, 'max-run-duration')).toBe('240m');
    expect(flagValue(args, 'instance-termination-action')).toBe('DELETE');
    expect(args).toContain('--boot-disk-auto-delete');
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels).toMatchObject({
      'papercusp-plan': PLAN_SLUG,
      'papercusp-ephemeral': 'true',
      [LABEL_RUN]: 'cal-1',
      [LABEL_MAXCOST]: String(worstCaseCents('e2-standard-4', 4)),
    });
  });

  it('refuses a VM without a self-delete timer or with one past the ceiling', () => {
    expect(() => buildCreateArgs({ ...spec, maxHours: 0 })).toThrow(/self-delete/);
    expect(() => buildCreateArgs({ ...spec, maxHours: Number.NaN })).toThrow(/self-delete/);
    expect(() => buildCreateArgs({ ...spec, maxHours: 13 })).toThrow(/ceiling/);
  });

  it('refuses any project but the dedicated test project', () => {
    expect(() => buildCreateArgs({ ...spec, project: 'active-alcove-504205-q3' })).toThrow(/only in pc-agent-capacity-0930/);
  });

  it('refuses a run id that is not a valid label value, so the sweep can always find it', () => {
    expect(() => buildCreateArgs({ ...spec, runId: 'Cal 1' })).toThrow(/label papercusp-run/);
  });

  it('lets caller labels through but never lets them override a rail label', () => {
    const args = buildCreateArgs({ ...spec, extraLabels: { 'papercusp-run': 'evil', scenario: 's7' } });
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels[LABEL_RUN]).toBe('cal-1');
    expect(labels.scenario).toBe('s7');
  });

  it('starts a spot VM with the SPOT model, the same DELETE rail, and a spot-priced worst-case label', () => {
    const args = buildCreateArgs({ ...spec, spot: true });
    expect(args).toContain('--provisioning-model=SPOT');
    expect(flagValue(args, 'instance-termination-action')).toBe('DELETE');
    expect(flagValue(args, 'max-run-duration')).toBe('240m');
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels[LABEL_PROVISIONING]).toBe('spot');
    expect(labels[LABEL_MAXCOST]).toBe(String(worstCaseCents('e2-standard-4', 4, undefined, { spot: true })));
    expect(Number(labels[LABEL_MAXCOST])).toBeLessThan(worstCaseCents('e2-standard-4', 4));
  });

  it('starts a P-007 drill VM that GCP stops (not deletes) at reclaim, and labels it so the census can tell', () => {
    const args = buildCreateArgs({ ...spec, spot: true, onReclaim: 'stop' });
    expect(args).toContain('--provisioning-model=SPOT');
    expect(flagValue(args, 'instance-termination-action')).toBe('STOP');
    expect(flagValue(args, 'max-run-duration')).toBe('240m');
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels[LABEL_ON_RECLAIM]).toBe('stop');
    expect(labels[LABEL_RUN]).toBe('cal-1');
    // Every other VM keeps the self-delete rail, and says so on its label.
    const plain = buildCreateArgs({ ...spec, spot: true });
    expect(flagValue(plain, 'instance-termination-action')).toBe('DELETE');
    expect(Object.fromEntries(flagValue(plain, 'labels')!.split(',').map((kv) => kv.split('=')))[LABEL_ON_RECLAIM]).toBe('delete');
  });

  it('refuses stop-on-reclaim for an on-demand VM, where it would only remove the self-delete rail', () => {
    expect(() => buildCreateArgs({ ...spec, onReclaim: 'stop' })).toThrow(/needs a spot VM/);
  });

  it('starts an on-demand VM without the SPOT model', () => {
    const args = buildCreateArgs(spec);
    expect(args.some((a) => a.startsWith('--provisioning-model'))).toBe(false);
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels[LABEL_PROVISIONING]).toBe('standard');
  });

  it('refuses a spot VM in a family whose spot price was never read', () => {
    expect(() => buildCreateArgs({ ...spec, machineType: 'n2d-standard-4', spot: true })).toThrow(/no measured spot price/);
  });
});

describe('pricing', () => {
  it('prices the verified Z3 shape including its fixed 3000 GiB Titanium SSD', () => {
    expect(parseMachineType('z3-highmem-8-highlssd')).toEqual({ family: 'z3', vcpus: 8, ramGb: 64 });
    const bootMonth = 50 * 0.08 + 300 * 0.005 + 14 * 0.04;
    const expected = 8 * 0.0496531 + 64 * 0.0066553 + (3000 * 0.08 + bootMonth) / 730;
    expect(hourlyPriceUsd('z3-highmem-8-highlssd')).toBeCloseTo(expected, 8);
    const args = buildCreateArgs({ runId: 'titanium-50', name: 'cap-titanium-50', machineType: 'z3-highmem-8-highlssd', maxHours: 6 });
    expect(flagValue(args, 'boot-disk-type')).toBe('hyperdisk-balanced');
    expect(flagValue(args, 'maintenance-policy')).toBe('MIGRATE');
    expect(flagValue(args, 'max-run-duration')).toBe('360m');
    expect(args.some(arg => arg.startsWith('--local-ssd'))).toBe(false);
    expect(() => hourlyPriceUsd('z3-highmem-8-highlssd', 50, { spot: true })).toThrow(/no measured spot price/);
    expect(() => parseMachineType('z3-highmem-16-highlssd')).toThrow(/unpriced/);
    expect(() => buildCreateArgs({ runId: 'titanium-50', name: 'cap-titanium-50', machineType: 'z3-highmem-8-highlssd', maxHours: 6, extraDisks: [{ type: 'pd-ssd', gb: 64, deviceName: 'swap' }] })).toThrow(/not priced/);
  });

  it('derives shapes for predefined and custom machine types', () => {
    expect(parseMachineType('e2-standard-4')).toEqual({ family: 'e2', vcpus: 4, ramGb: 16 });
    expect(parseMachineType('e2-highmem-8')).toEqual({ family: 'e2', vcpus: 8, ramGb: 64 });
    expect(parseMachineType('e2-custom-4-32768')).toEqual({ family: 'e2', vcpus: 4, ramGb: 32 });
    expect(() => parseMachineType('a3-megagpu-8g')).toThrow(/unpriced/);
  });

  it('prices e2-standard-4 at the catalog rate (4 x core + 16 GB x ram + disk)', () => {
    const expected = 4 * 0.02181159 + 16 * 0.00292353 + (50 * 0.1) / 730;
    expect(hourlyPriceUsd('e2-standard-4')).toBeCloseTo(expected, 8);
    expect(worstCaseCents('e2-standard-4', 4)).toBe(Math.ceil(expected * 4 * 100));
  });

  it('prices a spot e2 VM at the measured spot rate, with the disk at its normal price', () => {
    const expected = 16 * SPOT_PRICES_2026_10_01.e2!.vcpuHour + 16 * SPOT_PRICES_2026_10_01.e2!.gbRamHour + (120 * 0.1) / 730;
    expect(hourlyPriceUsd('e2-highcpu-16', 120, { spot: true })).toBeCloseTo(expected, 8);
    expect(hourlyPriceUsd('e2-highcpu-16', 120, { spot: true })).toBeLessThan(hourlyPriceUsd('e2-highcpu-16', 120));
  });

  it('prices T2D (P-008) from its own read SKUs, standard shape only', () => {
    expect(parseMachineType('t2d-standard-16')).toEqual({ family: 't2d', vcpus: 16, ramGb: 64 });
    expect(() => parseMachineType('t2d-highmem-16')).toThrow(/unpriced/);
    expect(() => parseMachineType('t2d-custom-16-65536')).toThrow(/unpriced/);
    const spot = 16 * 0.0165 + 64 * 0.002212 + (120 * 0.1) / 730;
    expect(hourlyPriceUsd('t2d-standard-16', 120, { spot: true })).toBeCloseTo(spot, 8);
    const onDemand = 16 * 0.027502 + 64 * 0.003686 + (120 * 0.1) / 730;
    expect(hourlyPriceUsd('t2d-standard-16', 120)).toBeCloseTo(onDemand, 8);
    // A T2D vCPU is a whole core, so it costs more per vCPU than e2 at the same shape.
    expect(hourlyPriceUsd('t2d-standard-16', 120, { spot: true })).toBeGreaterThan(
      hourlyPriceUsd('e2-standard-16', 120, { spot: true }),
    );
  });

  it('prices C4A (Arm, P-008) with a Hyperdisk boot disk provisioned to match pd-balanced', () => {
    expect(parseMachineType('c4a-standard-16')).toEqual({ family: 'c4a', vcpus: 16, ramGb: 64 });
    expect(parseMachineType('c4a-highcpu-16')).toEqual({ family: 'c4a', vcpus: 16, ramGb: 32 });
    expect(parseMachineType('c4a-highmem-8')).toEqual({ family: 'c4a', vcpus: 8, ramGb: 64 });
    // 120 GB pd-balanced performs at 3000 + 6x120 = 3720 IOPS and 140 + 0.28x120 = 174 MiB/s.
    const diskMonth = 120 * 0.08 + (3720 - 3000) * 0.005 + (174 - 140) * 0.04;
    const spot = 16 * 0.01387 + 64 * 0.001578 + diskMonth / 730;
    expect(hourlyPriceUsd('c4a-standard-16', 120, { spot: true })).toBeCloseTo(spot, 8);
  });

  it('creates C4A on the arm64 image with a provisioned Hyperdisk boot disk; e2 keeps pd-balanced', () => {
    const c4a = buildCreateArgs({ ...spec, machineType: 'c4a-standard-16', diskGb: 120, spot: true });
    expect(flagValue(c4a, 'boot-disk-type')).toBe('hyperdisk-balanced');
    expect(flagValue(c4a, 'boot-disk-provisioned-iops')).toBe('3720');
    expect(flagValue(c4a, 'boot-disk-provisioned-throughput')).toBe('174');
    expect(flagValue(c4a, 'image-family')).toBe('ubuntu-2404-lts-arm64');
    const e2 = buildCreateArgs({ ...spec, machineType: 'e2-standard-16', diskGb: 120 });
    expect(flagValue(e2, 'boot-disk-type')).toBe('pd-balanced');
    expect(flagValue(e2, 'boot-disk-provisioned-iops')).toBeUndefined();
    expect(flagValue(e2, 'image-family')).toBe('ubuntu-2404-lts-amd64');
  });
});

describe('attached disks (WI-10005475 swap-tier test)', () => {
  const swapDisks = [
    { type: 'pd-balanced' as const, gb: 64, deviceName: 'swapbal' },
    { type: 'pd-ssd' as const, gb: 64, deviceName: 'swapssd' },
  ];
  const hyperDisks = [
    { type: 'hyperdisk-balanced' as const, gb: 256, deviceName: 'swap', provisionedIops: 16000, provisionedThroughputMibps: 400 },
    { type: 'hyperdisk-balanced' as const, gb: 256, deviceName: 'db', provisionedIops: 16000, provisionedThroughputMibps: 400 },
  ];

  it('creates the fresh trial with 256 GiB each for swap and DB on the verified x86 shape', () => {
    const args = buildCreateArgs({ ...spec, machineType: 'n4-highmem-8', diskGb: 32, extraDisks: hyperDisks });
    expect(args.filter((a) => a.startsWith('--create-disk='))).toEqual([
      '--create-disk=auto-delete=yes,device-name=swap,size=256GB,type=hyperdisk-balanced,provisioned-iops=16000,provisioned-throughput=400',
      '--create-disk=auto-delete=yes,device-name=db,size=256GB,type=hyperdisk-balanced,provisioned-iops=16000,provisioned-throughput=400',
    ]);
    expect(flagValue(args, 'image-family')).toBe('ubuntu-2404-lts-amd64');
    expect(flagValue(args, 'boot-disk-type')).toBe('hyperdisk-balanced');
    const bootMonth = 32 * 0.08 + 192 * 0.005 + 9 * 0.04;
    const compute = 8 * 0.03119 + 64 * 0.00354;
    expect(hourlyPriceUsd('n4-highmem-8', 32)).toBeCloseTo(compute + bootMonth / 730, 8);
    const expectedExtra = (512 * 0.08 + 2 * ((16000 - 3000) * 0.005 + (400 - 140) * 0.04)) / 730;
    expect(hourlyPriceUsd('n4-highmem-8', 32, { extraDisks: hyperDisks }) - hourlyPriceUsd('n4-highmem-8', 32)).toBeCloseTo(expectedExtra, 8);
    expect(() => parseMachineType('n4-highmem-16')).toThrow(/unpriced/);
  });

  it.each([[4, 2000], [5, 2500], [6, 3000]])('accepts the minimum %i GiB volume at %i IOPS', (gb, iops) => {
    const disk = { ...hyperDisks[0], gb, provisionedIops: iops, provisionedThroughputMibps: 140 };
    expect(buildCreateArgs({ ...spec, machineType: 'n4-highmem-8', extraDisks: [disk] })).toContain(
      `--create-disk=auto-delete=yes,device-name=swap,size=${gb}GB,type=hyperdisk-balanced,provisioned-iops=${iops},provisioned-throughput=140`,
    );
    expect(() => buildCreateArgs({ ...spec, machineType: 'n4-highmem-8', extraDisks: [{ ...disk, provisionedIops: iops - 1 }] })).toThrow(/provisionedIops/);
  });

  it('admits the verified C4 fallback with its own shape, disk type and cost', () => {
    expect(parseMachineType('c4-standard-8')).toEqual({ family: 'c4', vcpus: 8, ramGb: 30 });
    const args = buildCreateArgs({ ...spec, machineType: 'c4-standard-8', extraDisks: hyperDisks, maxHours: 1 });
    expect(flagValue(args, 'boot-disk-type')).toBe('hyperdisk-balanced');
    expect(flagValue(args, 'image-family')).toBe('ubuntu-2404-lts-amd64');
    expect(flagValue(args, 'max-run-duration')).toBe('60m');
    expect(hourlyPriceUsd('c4-standard-8', 32)).toBeCloseTo(8 * 0.03465 + 30 * 0.003938 + (32 * 0.08 + 192 * 0.005 + 9 * 0.04) / 730, 8);
    expect(() => parseMachineType('c4-standard-16')).toThrow(/unpriced/);
  });

  it('rejects invalid IOPS/throughput ratios and missing performance before pricing or creating', () => {
    const create = (disk: typeof hyperDisks[number]) => buildCreateArgs({ ...spec, machineType: 'n4-highmem-8', extraDisks: [disk] });
    expect(() => create({ ...hyperDisks[0], gb: 4, provisionedIops: 3000 })).toThrow(/2000-2000/);
    expect(() => create({ ...hyperDisks[0], provisionedIops: 3000, provisionedThroughputMibps: 751 })).toThrow(/140-750/);
    expect(() => create({ ...hyperDisks[0], gb: 320, provisionedIops: 160000, provisionedThroughputMibps: 624 })).toThrow(/625-2400/);
    expect(() => create({ ...hyperDisks[0], gb: 256, provisionedIops: 128001 })).toThrow(/provisionedIops/);
    expect(() => hourlyPriceUsd('n4-highmem-8', 32, { extraDisks: [{ type: 'hyperdisk-balanced', gb: 256, deviceName: 'swap' }] })).toThrow(/provisionedIops/);
  });

  it.each(['e2-standard-4', 'n2-standard-4', 'n2d-standard-4', 't2d-standard-4'])('does not assume Hyperdisk enablement on %s', (machineType) => {
    expect(() => buildCreateArgs({ ...spec, machineType, extraDisks: hyperDisks })).toThrow(/not enabled/);
    expect(() => hourlyPriceUsd(machineType, 32, { extraDisks: hyperDisks })).toThrow(/not enabled/);
  });

  it('parses explicit Hyperdisk performance without accepting it on Persistent Disk', () => {
    expect(parseExtraDisk('hyperdisk-balanced:256:swap:16000:400')).toEqual(hyperDisks[0]);
    for (const raw of ['hyperdisk-balanced:256:swap', 'hyperdisk-balanced:256:swap:16000', 'hyperdisk-balanced:256:swap:16000:NaN', 'hyperdisk-balanced:256:swap::400']) {
      expect(() => parseExtraDisk(raw)).toThrow(/requires/);
    }
    expect(() => parseExtraDisk('pd-ssd:256:swap:16000:400')).toThrow(/only valid for Hyperdisk/);
    expect(() => parseExtraDisk('toString:256:swap')).toThrow(/unpriced/);
  });

  it('creates each data disk with the VM and auto-deletes it with the VM', () => {
    const args = buildCreateArgs({ ...spec, extraDisks: swapDisks });
    expect(args.filter((a) => a.startsWith('--create-disk='))).toEqual([
      '--create-disk=auto-delete=yes,device-name=swapbal,size=64GB,type=pd-balanced',
      '--create-disk=auto-delete=yes,device-name=swapssd,size=64GB,type=pd-ssd',
    ]);
    expect(args.some((a) => a.startsWith('--local-ssd'))).toBe(false);
  });

  it('prices data disks and Local SSDs into the worst-case label and the admission', () => {
    const plain = hourlyPriceUsd('n2-standard-4');
    const withDisks = hourlyPriceUsd('n2-standard-4', 50, { extraDisks: swapDisks, localSsds: 1 });
    expect(withDisks - plain).toBeCloseTo((64 * 0.1 + 64 * 0.17 + 375 * 0.08) / 730, 8);
    const args = buildCreateArgs({ ...spec, machineType: 'n2-standard-4', extraDisks: swapDisks, localSsds: 1 });
    const labels = Object.fromEntries(flagValue(args, 'labels')!.split(',').map((kv) => kv.split('=')));
    expect(labels[LABEL_MAXCOST]).toBe(String(worstCaseCents('n2-standard-4', 4, 50, { extraDisks: swapDisks, localSsds: 1 })));
    const verdict = admitCreate({ ...spec, machineType: 'n2-standard-4', extraDisks: swapDisks, localSsds: 1 }, census([]));
    expect(verdict.newCents).toBeGreaterThan(admitCreate({ ...spec, machineType: 'n2-standard-4' }, census([])).newCents);
  });

  it('adds one NVMe Local SSD per count on n2, and refuses it on e2, which takes none', () => {
    const args = buildCreateArgs({ ...spec, machineType: 'n2-standard-4', localSsds: 2 });
    expect(args.filter((a) => a === '--local-ssd=interface=NVME')).toHaveLength(2);
    expect(() => buildCreateArgs({ ...spec, localSsds: 1 })).toThrow(/takes no attached Local SSD/);
  });

  it('refuses malformed, duplicate, unpriced or C4A data disks', () => {
    expect(() => buildCreateArgs({ ...spec, extraDisks: [{ type: 'pd-ssd', gb: 5, deviceName: 'x' }] })).toThrow(/10-2048/);
    expect(() => buildCreateArgs({ ...spec, extraDisks: [{ type: 'pd-ssd', gb: 20, deviceName: 'Bad_Name' }] })).toThrow(/device name/);
    expect(() => buildCreateArgs({ ...spec, extraDisks: [swapDisks[0], swapDisks[0]] })).toThrow(/duplicate/);
    expect(() => buildCreateArgs({ ...spec, machineType: 'c4a-standard-4', extraDisks: [swapDisks[0]] })).toThrow(/only Hyperdisk/);
    expect(() => parseExtraDisk('pd-extreme:64:fast')).toThrow(/unpriced extra disk type/);
    expect(() => parseExtraDisk('pd-ssd:64')).toThrow(/<type>:<gb>:<device-name>/);
    expect(parseExtraDisk('pd-ssd:64:swapssd')).toEqual({ type: 'pd-ssd', gb: 64, deviceName: 'swapssd' });
    expect(() => buildCreateArgs({ ...spec, extraDisks: [{ ...hyperDisks[0], provisionedIops: 2000 }] })).toThrow(/provisionedIops/);
  });
});

function census(instances: Census['instances'], orphanDisks: Census['orphanDisks'] = []): Census {
  return { instances, orphanDisks, staticAddresses: [], buckets: [] };
}

describe('admission', () => {
  it('admits a create inside the concurrent worst-case ceiling', () => {
    const verdict = admitCreate(spec, census([]));
    expect(verdict.admitted).toBe(true);
  });

  it('refuses a create whose worst case would exceed the ceiling with live VMs counted', () => {
    const ceiling = MAX_CONCURRENT_WORST_CASE_USD * 100;
    const live = census([{ name: 'a', zone: 'us-central1-a', status: 'RUNNING', runId: 'x', maxCostCents: ceiling - 10 }]);
    const verdict = admitCreate(spec, live);
    expect(verdict.admitted).toBe(false);
    expect(verdict.reason).toMatch(/exceeds/);
  });

  it('does not count stopped (TERMINATED) VMs as committed compute', () => {
    const c = census([
      { name: 'a', zone: 'z', status: 'TERMINATED', runId: 'x', maxCostCents: 9999 },
      { name: 'b', zone: 'z', status: 'RUNNING', runId: 'x', maxCostCents: 100 },
    ]);
    expect(committedWorstCaseCents(c)).toBe(100);
  });
});

/**
 * A fake gcloud holding a mutable project inventory, recording every call. `lingerReads` keeps a
 * deleted VM listed (as STOPPING) for that many instance-list reads, the way GCP does.
 */
function fakeGcloud(
  initial: { instances: Array<Record<string, unknown>>; disks: Array<Record<string, unknown>> },
  opts: { deleteSticks?: boolean; lingerReads?: number } = {},
) {
  const state = { instances: [...initial.instances], disks: [...initial.disks] };
  const calls: string[][] = [];
  let pendingGone: string[] = [];
  let lingerLeft = 0;
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const [, kind, verb] = argv;
    if (verb === 'list') {
      if (kind === 'instances' && pendingGone.length) {
        if (lingerLeft > 0) {
          lingerLeft -= 1;
          state.instances = state.instances.map((i) => (pendingGone.includes(String(i.name)) ? { ...i, status: 'STOPPING' } : i));
        } else {
          state.instances = state.instances.filter((i) => !pendingGone.includes(String(i.name)));
          state.disks = state.disks.filter((d) => !pendingGone.includes(String(d.name)));
          pendingGone = [];
        }
      }
      const rows = kind === 'instances' ? state.instances : kind === 'disks' ? state.disks : [];
      return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
    }
    if (kind === 'instances' && verb === 'delete') {
      const names = argv.slice(3).filter((a) => !a.startsWith('--'));
      if (!opts.deleteSticks) {
        pendingGone = [...pendingGone, ...names];
        lingerLeft = opts.lingerReads ?? 0;
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected ${argv.join(' ')}` };
  };
  return { exec, calls, state };
}

const zoneUrl = (z: string) => `https://www.googleapis.com/compute/v1/projects/${TEST_PROJECT}/zones/${z}`;
const vm = (name: string, run: string, zone = 'us-central1-a') => ({
  name,
  zone: zoneUrl(zone),
  status: 'RUNNING',
  labels: { [LABEL_RUN]: run, [LABEL_MAXCOST]: '60' },
});
const bootDisk = (name: string, zone = 'us-central1-a') => ({ name, zone: zoneUrl(zone), users: [`.../instances/${name}`] });

describe('readCensus', () => {
  it('keeps only one SDK command active while collecting every resource kind', async () => {
    const inventory: Record<string, Array<Record<string, unknown>>> = {
      instances: [vm('r1-a', 'r1')],
      disks: [bootDisk('r1-a'), { name: 'orphan', zone: zoneUrl('us-central1-b'), users: [] }],
      addresses: [{ name: 'reserved-ip' }],
      buckets: [{ name: 'artifacts' }],
    };
    const calls: string[][] = [];
    let active = 0;
    let peakActive = 0;
    const exec: Exec = async (argv) => {
      calls.push([...argv]);
      active += 1;
      peakActive = Math.max(peakActive, active);
      try {
        // Keep the command pending for one microtask, without wall-clock timing assumptions.
        await Promise.resolve();
        return { code: 0, stdout: JSON.stringify(inventory[argv[1]]), stderr: '' };
      } finally {
        active -= 1;
      }
    };

    const census = await readCensus(exec);
    expect(peakActive).toBe(1);
    expect(active).toBe(0);
    expect(census).toEqual({
      instances: [{ name: 'r1-a', zone: 'us-central1-a', status: 'RUNNING', runId: 'r1', maxCostCents: 60 }],
      orphanDisks: [{ name: 'orphan', zone: 'us-central1-b' }],
      staticAddresses: ['reserved-ip'],
      buckets: ['artifacts'],
    });
    expect(calls).toEqual(['instances', 'disks', 'addresses', 'buckets'].map((kind) => [
      kind === 'buckets' ? 'storage' : 'compute', kind, 'list', `--project=${TEST_PROJECT}`, '--format=json',
    ]));
  });
});

describe('teardownRun', () => {
  it('deletes only the run, per zone, and verifies with a fresh census', async () => {
    const g = fakeGcloud({
      instances: [vm('r1-a', 'r1'), vm('r1-b', 'r1', 'us-central1-b'), vm('other', 'r2')],
      disks: [bootDisk('r1-a'), bootDisk('r1-b', 'us-central1-b'), bootDisk('other')],
    });
    const result = await teardownRun('r1', g.exec);
    expect(result.verified).toBe(true);
    expect(result.deleted.sort()).toEqual(['r1-a', 'r1-b']);
    const deletes = g.calls.filter((c) => c[2] === 'delete');
    expect(deletes).toHaveLength(2);
    expect(deletes.every((c) => c.includes(`--project=${TEST_PROJECT}`))).toBe(true);
    expect(g.state.instances.map((i) => i.name)).toEqual(['other']);
  });

  const fastConverge = () => {
    const sleeps: number[] = [];
    return { sleeps, opts: { deadlineMs: 50, intervalMs: 10, sleep: async (ms: number) => void sleeps.push(ms) } };
  };

  it('waits out a VM that GCP still lists as STOPPING after the delete, then verifies', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a')] }, { lingerReads: 2 });
    const c = fastConverge();
    const result = await teardownRun('r1', g.exec, c.opts);
    expect(result.verified).toBe(true);
    expect(c.sleeps).toHaveLength(2);
  });

  it('is NOT verified when the instance is still listed at the deadline', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a')] }, { deleteSticks: true });
    const c = fastConverge();
    const result = await teardownRun('r1', g.exec, c.opts);
    expect(result.verified).toBe(false);
    expect(result.remainingInstances).toEqual(['r1-a']);
    expect(c.sleeps.reduce((a, b) => a + b, 0)).toBe(50);
  });

  it('is NOT verified while an orphaned disk remains anywhere in the project', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a'), { name: 'leaked', zone: zoneUrl('us-central1-a'), users: [] }] });
    const result = await teardownRun('r1', g.exec, fastConverge().opts);
    expect(result.verified).toBe(false);
    expect(result.orphanDisks).toEqual(['leaked']);
  });

  it('lists the project storage buckets in the census, without letting them block a run teardown', async () => {
    const g = fakeGcloud({ instances: [vm('r1-a', 'r1')], disks: [bootDisk('r1-a')] });
    const exec: Exec = async (argv) =>
      argv[0] === 'storage'
        ? { code: 0, stdout: JSON.stringify([{ name: 'pc-agent-capacity-0930-artifacts', labels: {} }]), stderr: '' }
        : g.exec(argv);
    expect((await readCensus(exec)).buckets).toEqual(['pc-agent-capacity-0930-artifacts']);
    const result = await teardownRun('r1', exec, fastConverge().opts);
    expect(result.verified).toBe(true);
    expect(result.deleted).toEqual(['r1-a']);
  });

  it.each(['instances', 'disks', 'addresses', 'buckets'])('throws instead of reporting a partial census when %s listing fails', async (failedKind) => {
    const exec: Exec = async (argv) => argv[1] === failedKind
      ? { code: 1, stdout: '', stderr: `permission denied: ${failedKind}` }
      : { code: 0, stdout: '[]', stderr: '' };
    await expect(readCensus(exec)).rejects.toThrow(`permission denied: ${failedKind}`);
  });
});
