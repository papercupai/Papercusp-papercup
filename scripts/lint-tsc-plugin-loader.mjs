#!/usr/bin/env node
/**
 * typecheck (plugin-loader) — the per-file baseline gate for packages/plugin-loader (WI-10006237).
 *
 * Before this, plugin-loader had no tsconfig and no `typecheck` script, so no lint:tsc leg ever
 * compiled it: the TYPE half of its guards (e.g. manifest-validate.test.ts's Required<ProviderDescriptor>
 * fixture, which must change when a descriptor field is added) never fired. Vitest is type-blind.
 *
 * The package imports @papercusp/agent-mcp, whose source graph reaches most of operator-core, so a
 * raw `tsc` result carries operator-core's and agent-mcp's standing diagnostics. Exactly as
 * scripts/lint-tsc-agent-mcp.mjs does, files under those prefixes are judged against THEIR OWN
 * committed baselines (no second hand-kept copy of their debt), and plugin-loader's own files are
 * held to packages/plugin-loader/.tsc-baseline.json, which starts at zero. Any new diagnostic in the
 * graph fails. Discovery by lint:tsc:workspaces is automatic: it gates every package that declares a
 * `typecheck` script.
 *
 * Usage: npm --workspace @papercusp/plugin-loader run typecheck [-- --files=<paths>] [-- --update]
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTscBaselineGate, TOOLCHAIN_FAILURE_EXIT_CODE } from './lib/tsc-baseline-gate.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A fresh compiler run: a warm tsbuildinfo can under-report errors and ratchet a baseline down (EI-487).
const TSC_COMMAND = 'npx tsc -p packages/plugin-loader/tsconfig.json --noEmit --incremental false';

const FOREIGN_BASELINES = [
  {
    prefix: 'packages/operator-core/',
    baselineFile: resolve(ROOT, 'packages/operator-core/.tsc-baseline.json'),
    label: 'operator-core',
  },
  {
    prefix: 'packages/agent-mcp/',
    baselineFile: resolve(ROOT, 'packages/agent-mcp/.tsc-baseline.json'),
    label: 'agent-mcp',
  },
];

runTscBaselineGate({
  root: ROOT,
  tscCommand: TSC_COMMAND,
  baselineFile: resolve(ROOT, 'packages/plugin-loader/.tsc-baseline.json'),
  label: 'plugin-loader',
  argv: process.argv.slice(2),
  foreignBaselines: FOREIGN_BASELINES,
}).catch((err) => {
  // A failed or interrupted measurement is never a typecheck pass — and never a regression
  // either: exit 1 prints status=regressed, so a crash exits EX_SOFTWARE (EI-25816656568127078).
  console.error(err);
  process.exit(TOOLCHAIN_FAILURE_EXIT_CODE);
});
