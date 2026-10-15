import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CAPACITY, capacity, dedicatedHosts, evaluate, hostMonthUsd, pooledComputeUsd, SCENARIOS } from './cost-model';
import {
  cheapestOwnVm,
  HOSTED_DEFAULTS_PATH,
  ownVmAgents,
  PICK_AGENT_COUNTS,
  readHostedDefault,
  renderSizeGuide,
  serverRows,
  SIZE_GUIDE_PATH,
  sizeRows,
} from './size-guide';
import {
  HOSTED_GCP_MAX_EXPECTED_AGENTS,
  HOSTED_GCP_OWN_VM_SIZES,
  hostedGcpSizeForAgents,
} from '../../packages/operator-core/lib/auth/hosted/hosted-vm-size';

const scenario = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`no scenario ${id}`);
  return s;
};

describe('size guide derives from the cost model', () => {
  it('own-VM agent count is the exact inverse of dedicatedHosts for every measured row', () => {
    for (const cap of CAPACITY) {
      const n = ownVmAgents(cap);
      expect(n, cap.id).toBeGreaterThan(0);
      expect(dedicatedHosts(n, cap), cap.id).toBe(1);
      expect(dedicatedHosts(n + 1, cap), cap.id).toBe(2);
    }
  });

  it('pooled cost per agent equals cost-model pooled compute for one agent', () => {
    for (const r of sizeRows()) {
      expect(r.pooledPerAgentSpotUsd).toBeCloseTo(pooledComputeUsd(1, capacity(r.id), true), 9);
    }
  });

  it('keeps the measured anchors: e2-standard-4 holds 15 mixed agents on its own VM, e2-standard-8 holds 67', () => {
    const rows = new Map(sizeRows().map((r) => [r.id, r]));
    expect(rows.get('mixed-e2s4')?.ownVmAgents).toBe(15);
    expect(rows.get('mixed-e2s8')?.ownVmAgents).toBe(67);
  });

  it('the cheapest own VM for 50 mixed agents is the D-046 M1 row', () => {
    const pick = cheapestOwnVm(50, 'mixed');
    const m1 = evaluate(scenario('M1'), 50, null);
    expect(pick.machineType).toBe(m1.machineType);
    expect(pick.hosts).toBe(m1.hosts);
    expect(pick.spotUsd).toBeCloseTo(m1.computeUsd, 6);
  });

  it('own-VM picks never cost less as the workspace grows', () => {
    const costs = PICK_AGENT_COUNTS.map((n) => cheapestOwnVm(n, 'mixed').spotUsd);
    for (let i = 1; i < costs.length; i += 1) expect(costs[i]).toBeGreaterThanOrEqual(costs[i - 1] ?? 0);
  });

  // WI-10006498: the product sizes a hosted GCP workspace from HOSTED_GCP_OWN_VM_SIZES. That table
  // is a copy, so it is pinned here. Only x86 shapes count: the hosted image is amd64.
  const x86Mixed = () => sizeRows().filter((r) => r.workload === 'mixed' && r.machineType.startsWith('e2-'));

  it('each hosted VM size row is a measured x86 shape at its derived own-VM limit', () => {
    const rows = new Map(x86Mixed().map((r) => [r.machineType, r]));
    for (const row of HOSTED_GCP_OWN_VM_SIZES) {
      expect(rows.get(row.size)?.ownVmAgents, row.size).toBe(row.maxAgents);
    }
  });

  it('every hosted VM size pick is the cheapest single x86 VM for that agent count', () => {
    for (let n = 1; n <= HOSTED_GCP_MAX_EXPECTED_AGENTS; n += 1) {
      const pick = cheapestOwnVm(n, 'mixed', x86Mixed());
      expect(pick.hosts, `n=${n}`).toBe(1);
      expect(hostedGcpSizeForAgents(n), `n=${n}`).toBe(pick.machineType);
    }
    // Past the largest row no single measured x86 VM holds the workspace, so the product refuses it.
    expect(cheapestOwnVm(HOSTED_GCP_MAX_EXPECTED_AGENTS + 1, 'mixed', x86Mixed()).hosts).toBeGreaterThan(1);
    expect(hostedGcpSizeForAgents(HOSTED_GCP_MAX_EXPECTED_AGENTS + 1)).toBeNull();
  });

  it('the P-532 Server costs less than the in-process one', () => {
    const [inProcess, sidecar] = serverRows();
    expect(sidecar?.ramGiB).toBeLessThan(inProcess?.ramGiB ?? 0);
    expect(sidecar?.packedUsd).toBeLessThan(inProcess?.packedUsd ?? 0);
  });
});

describe('hosted default', () => {
  it('reads the shape and provisioning model from the provisioning code', () => {
    const hd = readHostedDefault();
    expect(hd.machineType).toMatch(/^[a-z0-9]+-[a-z0-9-]+$/);
    expect(hd.provisioningModel).toBe('spot');
  });

  it('is a MEASURED mixed shape, so the guide can say how many agents it holds', () => {
    const hd = readHostedDefault();
    const measured = CAPACITY.filter((c) => c.workload === 'mixed').map((c) => c.machineType);
    expect(measured, `hosted default ${hd.machineType} has no capacity run; measure it before making it the default`).toContain(
      hd.machineType,
    );
    expect(hostMonthUsd(hd.machineType, true)).toBeGreaterThan(0);
  });

  it('refuses source text that no longer has the defaults block (control)', () => {
    const real = readFileSync(HOSTED_DEFAULTS_PATH, 'utf8');
    // replaceAll, not replace: the name also appears in comments above the declaration (WI-10006498),
    // and renaming only the FIRST mention left the block intact, so the control passed vacuously.
    const renamed = real.replaceAll('GCP_FIRST_WORKSPACE_DEFAULTS', 'RENAMED_DEFAULTS');
    expect(renamed).not.toContain('export const GCP_FIRST_WORKSPACE_DEFAULTS');
    expect(() => readHostedDefault(renamed)).toThrow(/could not read the hosted default/);
  });

  it('renders "Not measured" for an unmeasured default instead of an agent count (control)', () => {
    const md = renderSizeGuide({ machineType: 'n4-standard-2', provisioningModel: 'spot', source: 'test' });
    expect(md).toContain('**Not measured.**');
  });
});

describe('SIZE-GUIDE.md', () => {
  it('is the current output of size-guide.ts (regenerate: npx tsx scripts/agent-capacity/size-guide.ts --write)', () => {
    expect(readFileSync(SIZE_GUIDE_PATH, 'utf8')).toBe(renderSizeGuide());
  });
});
