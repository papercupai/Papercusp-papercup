// Source-tree entry for tsx and Vitest runtimes. Packaged builds use the
// sibling role-codex-home.worker.mjs emitted by the host worker bundlers.
import { tsImport } from 'tsx/esm/api';

await tsImport('./role-codex-home.worker.ts', import.meta.url);
