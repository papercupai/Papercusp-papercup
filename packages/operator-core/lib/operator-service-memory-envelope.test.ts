/**
 * EI-20340243384897336 — the clustered :3070 operator needs a service-wide
 * cgroup envelope in addition to each process's recycle watchdog.
 *
 * This reads the versioned systemd source rather than the mutable live symlink,
 * so CI catches a lost policy before a fresh machine installs it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND,
  MEMORY_WATCHDOG_LIMIT_MB_REQUEST,
} from './memory-watchdog';
import { resolveClusterWorkers } from './cluster-fork';

const dropInPath = fileURLToPath(
  new URL('../../../apps/operator/scripts/systemd/papercup-dev-api.service.d/55-memory-envelope.conf', import.meta.url),
);

function directive(text: string, name: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

function environmentValue(text: string, name: string): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('Environment='))
    .map((line) => line.slice('Environment='.length))
    .find((assignment) => assignment.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

describe('papercup-dev-api service memory envelope (EI-20340243384897336)', () => {
  const dropIn = readFileSync(dropInPath, 'utf8');

  it('removes the stale process-wide watchdog override', () => {
    expect(directive(dropIn, 'UnsetEnvironment')).toBe('PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB');
    expect(dropIn).not.toMatch(/^Environment=PAPERCUSP_MEMORY_WATCHDOG_LIMIT_MB=/m);
  });

  it('keeps a reclaim-first aggregate envelope with ordered limits', () => {
    const highGiB = Number.parseInt(directive(dropIn, 'MemoryHigh') ?? '', 10);
    const maxGiB = Number.parseInt(directive(dropIn, 'MemoryMax') ?? '', 10);
    const swapMaxGiB = Number.parseInt(directive(dropIn, 'MemorySwapMax') ?? '', 10);

    expect(directive(dropIn, 'MemoryAccounting')).toBe('yes');
    expect(highGiB).toBe(48);
    expect(maxGiB).toBe(64);
    expect(swapMaxGiB).toBe(0);
    expect(highGiB).toBeLessThan(maxGiB);
  });

  it('caps the cluster so every process at its recycle ceiling stays below MemoryHigh', () => {
    const highMiB = Number.parseInt(directive(dropIn, 'MemoryHigh') ?? '', 10) * 1024;
    const workers = Number(environmentValue(dropIn, 'PAPERCUSP_CLUSTER_WORKERS'));
    const expectedProcesses = Number(environmentValue(dropIn, 'PAPERCUSP_EXPECTED_OPERATOR_PROCS'));
    const aggregateRecycleCeilingMiB =
      MEMORY_WATCHDOG_LIMIT_MB_BACKGROUND + workers * MEMORY_WATCHDOG_LIMIT_MB_REQUEST;

    // WI-6554700010029423: request tier raised 6 -> 9 (see the drop-in's own
    // comment); the headroom assertion below is what keeps that change safe.
    expect(workers).toBe(9);
    expect(expectedProcesses).toBe(workers + 1);
    expect(
      resolveClusterWorkers(
        { PAPERCUSP_CLUSTER: '16', PAPERCUSP_CLUSTER_WORKERS: String(workers) },
        32,
      ),
    ).toBe(workers);
    expect(highMiB - aggregateRecycleCeilingMiB).toBeGreaterThanOrEqual(4 * 1024);
  });
});

/**
 * WI-10003355 — interactive request services must keep their heap in RAM.
 * Under host-wide pressure a non-zero swap allowance let 225-407 MB of each
 * :3070 worker's heap reach swap; GC over swapped pages then stalled the event
 * loop for seconds, and the slowest probes coincided with 600+ major faults/s.
 * Each drop-in below is the versioned source a fresh machine installs.
 */
describe('interactive operator services never swap (WI-10003355)', () => {
  const systemdDir = new URL('../../../apps/operator/scripts/systemd/', import.meta.url);
  const noSwapDropIns = [
    'papercup-dev-api.service.d/55-memory-envelope.conf',
    'papercup-staging-api.service.d/55-no-swap.conf',
    'papercup-mcp-proxy.service.d/55-no-swap.conf',
  ];

  it.each(noSwapDropIns)('%s sets MemorySwapMax=0 under [Service]', (relativePath) => {
    const text = readFileSync(fileURLToPath(new URL(relativePath, systemdDir)), 'utf8');
    const lines = text.split('\n').map((line) => line.trim());
    const serviceIndex = lines.indexOf('[Service]');
    const swapIndex = lines.findIndex((line) => line.startsWith('MemorySwapMax='));

    expect(serviceIndex).toBeGreaterThanOrEqual(0);
    expect(swapIndex).toBeGreaterThan(serviceIndex);
    expect(directive(text, 'MemorySwapMax')).toBe('0');
    expect(lines.filter((line) => line.startsWith('MemorySwapMax='))).toHaveLength(1);
  });
});
