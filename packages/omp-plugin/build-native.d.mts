import type { BuildOptions } from 'esbuild';

/** Shared production recipes; callers choose a private output directory. */
export function nativeBuilds(root: string, outDir?: string): BuildOptions[];
