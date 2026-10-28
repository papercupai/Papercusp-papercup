// Source-tree entry for tsx and Vitest runtimes. Bundled hosts fork the sibling
// warm-cochange-index.worker.mjs emitted by the host worker bundlers.
import { tsImport } from 'tsx/esm/api';

await tsImport('./warm-cochange-index.worker.ts', import.meta.url);
