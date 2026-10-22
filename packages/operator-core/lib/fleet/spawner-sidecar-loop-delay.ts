import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Reports the sidecar's loop delay since the previous health read. */
export function createSpawnerSidecarLoopDelay(resolution = 10) {
  const histogram = monitorEventLoopDelay({ resolution });
  histogram.enable();

  return {
    readP99Ms(): number {
      const p99Ms = histogram.count > 0 ? histogram.percentile(99) / 1e6 : 0;
      histogram.reset();
      return p99Ms;
    },
    close(): void {
      histogram.disable();
    },
  };
}
