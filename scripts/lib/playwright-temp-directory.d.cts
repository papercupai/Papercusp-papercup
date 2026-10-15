import type { accessSync, mkdirSync, statfsSync } from 'node:fs';
export const PLAYWRIGHT_TEMP_MIN_BYTES: number;
export const PLAYWRIGHT_TEMP_MIN_INODES: number;
export function preparePlaywrightTempDirectory(options?: {
  env?: NodeJS.ProcessEnv;
  statfs?: typeof statfsSync;
  mkdir?: typeof mkdirSync;
  access?: typeof accessSync;
  minBytes?: number;
  minInodes?: number;
}): { path: string; availableBytes: number; freeInodes: number; usedFallback: boolean };
