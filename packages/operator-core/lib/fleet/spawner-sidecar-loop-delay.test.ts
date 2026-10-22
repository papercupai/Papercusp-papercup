import { describe, expect, it } from 'vitest';
import { createSpawnerSidecarLoopDelay } from './spawner-sidecar-loop-delay';

describe('spawner sidecar loop delay health', () => {
  it('reports a loop stall and resets the measurement window', async () => {
    const health = createSpawnerSidecarLoopDelay(1);
    try {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const end = performance.now() + 80;
      while (performance.now() < end) { /* deliberate synchronous loop stall */ }
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(health.readP99Ms()).toBeGreaterThan(40);

      await new Promise((resolve) => setTimeout(resolve, 15));
      expect(health.readP99Ms()).toBeLessThan(40);
    } finally {
      health.close();
    }
  });
});
