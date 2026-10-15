/**
 * EI-6479 regression guard — the `npm run typecheck --if-present` idiom must
 * NOT silently no-op.
 *
 * The fleet-brief verification idiom is `npm run typecheck --if-present`.
 * npm's `--if-present` exits 0 WITHOUT running anything when no `typecheck`
 * script exists — so an agent honestly-but-wrongly reports "tsc clean" while
 * nothing ran. The durable fix aliases `typecheck` onto the EXISTING
 * baseline-aware gate (`scripts/lint-tsc.mjs`, a.k.a. `lint:tsc`), which
 * reports the operator-core error count vs its committed baseline and fails
 * only on NEW errors (ratchet-only-down). This test fails if the alias is
 * removed — i.e. if the repo regresses back to the silent-no-op state.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');

function scripts(pkgRelPath: string): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, pkgRelPath), 'utf-8'));
  return pkg.scripts ?? {};
}

describe('EI-6479 — typecheck script exists and runs the real baseline gate', () => {
  it('root package.json defines a non-empty `typecheck` script (so --if-present never no-ops)', () => {
    const s = scripts('package.json');
    expect(s.typecheck, 'root package.json must define a `typecheck` script').toBeTruthy();
    // Must invoke the shared baseline gate, not a placeholder that no-ops.
    expect(s.typecheck).toMatch(/lint-tsc\.mjs|lint:tsc/);
  });

  it('operator-core package.json defines a `typecheck` script wired to the baseline gate', () => {
    const s = scripts('packages/operator-core/package.json');
    expect(
      s.typecheck,
      'operator-core package.json must define a `typecheck` script',
    ).toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc\.mjs/);
  });

  it('operator-core exposes the same baseline gate as a package-local `lint:tsc` script', () => {
    const s = scripts('packages/operator-core/package.json');
    expect(
      s['lint:tsc'],
      'direct npm --prefix packages/operator-core lint:tsc callers must not hit a missing script',
    ).toBe('node ../../scripts/lint-tsc.mjs');
  });

  it('root exposes the canonical npm workspace name for focused operator-core typechecks', () => {
    const root = scripts('package.json');
    expect(root['typecheck:operator-core']).toBe(
      'npm --workspace @papercusp/operator-core run typecheck --',
    );
    const operatorCore = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/operator-core/package.json'), 'utf-8'),
    ) as { name?: string };
    expect(operatorCore.name).toBe('@papercusp/operator-core');
  });

  it('root exposes the canonical npm workspace name for focused operator typechecks', () => {
    const root = scripts('package.json');
    expect(root['typecheck:operator']).toBe('npm --workspace @papercusp/web run typecheck --');
    const operator = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'apps/operator/package.json'), 'utf-8'),
    ) as { name?: string };
    expect(operator.name).toBe('@papercusp/web');
  });

  // EI-847: operator-vite's `typecheck` used to be a raw `tsc --noEmit`, which floods with
  // hundreds of pre-existing errors (native-module ambient-type gaps transitively reachable
  // through operator-core) and gives an agent editing one component no clean per-file signal.
  // It must stay aliased onto the same per-file baseline gate as operator-core (via
  // scripts/lint-tsc-operator-vite.mjs, built on the shared scripts/lib/tsc-baseline-gate.mjs
  // policy) — this test fails if it regresses back to a bare `tsc --noEmit`.
  it('operator-vite package.json defines a `typecheck` script wired to the baseline gate, not a raw tsc flood', () => {
    const s = scripts('apps/operator-vite/package.json');
    expect(
      s.typecheck,
      'apps/operator-vite/package.json must define a `typecheck` script',
    ).toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc-operator-vite\.mjs/);
    expect(s.typecheck).not.toMatch(/^tsc\b/);
  });

  it('apps/operator package.json exposes its baseline-aware gate as `typecheck`', () => {
    const s = scripts('apps/operator/package.json');
    // Match the WIRING, not the exact command string. This assertion used to pin
    // the whole line including a `bash ../../scripts/pc-heavy.sh` prefix; when
    // EI-21311288080670514 correctly moved slot admission inside the runner, that
    // over-specification turned a deliberate fix into a red gate. Where admission
    // happens is owned by heavy-typecheck-scripts-throttled.test.ts; this test
    // (EI-6479) only cares that `typecheck` EXISTS and reaches the baseline gate,
    // so `npm run typecheck --if-present` cannot silently no-op.
    expect(
      s.typecheck,
      'apps/operator must not remain invisible to workspace typecheck discovery',
    ).toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc-operator\.mjs/);
    expect(s.typecheck).not.toMatch(/^tsc\b/);
  });

  it('apps/operator baseline exists and carries per-file diagnostic ceilings', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'apps/operator/.tsc-baseline.json'), 'utf-8'),
    );
    expect(baseline.files, 'apps/operator baseline must have a files map').toBeTypeOf('object');
    expect(Object.keys(baseline.files).length).toBeGreaterThan(0);
  });

  it('apps/operator-vite/.tsc-baseline.json exists with a per-file `files` map', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'apps/operator-vite/.tsc-baseline.json'), 'utf-8'),
    );
    expect(baseline.files, 'baseline must have a files map').toBeTypeOf('object');
    expect(Object.keys(baseline.files).length).toBeGreaterThan(0);
  });

  it('agent-mcp package declares the baseline-gated typecheck used by workspace promotion', () => {
    const s = scripts('packages/agent-mcp/package.json');
    expect(s.typecheck, 'packages/agent-mcp must expose a real typecheck script').toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc-agent-mcp\.mjs/);
    expect(s.typecheck).not.toMatch(/^tsc\b/);
  });

  it('agent-mcp baseline exists and is ready for per-file diagnostics', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/agent-mcp/.tsc-baseline.json'), 'utf-8'),
    );
    expect(baseline.files, 'agent-mcp baseline must have a files map').toBeTypeOf('object');
  });

  // WI-10006237: plugin-loader had no tsconfig and no typecheck script, so no leg compiled it and the
  // type half of its guards (manifest-validate.test.ts's Required<ProviderDescriptor> fixture) never fired.
  it('plugin-loader declares the baseline-gated typecheck that lint:tsc:workspaces discovers', () => {
    const s = scripts('packages/plugin-loader/package.json');
    expect(s.typecheck, 'packages/plugin-loader must expose a real typecheck script').toBeTruthy();
    expect(s.typecheck).toMatch(/lint-tsc-plugin-loader\.mjs/);
    expect(existsSync(resolve(REPO_ROOT, 'packages/plugin-loader/tsconfig.json'))).toBe(true);
  });

  it('plugin-loader baseline exists and starts with no own-file diagnostics', () => {
    const baseline = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/plugin-loader/.tsc-baseline.json'), 'utf-8'),
    );
    expect(baseline.files, 'plugin-loader baseline must have a files map').toBeTypeOf('object');
    const own = Object.keys(baseline.files).filter((f) => f.startsWith('packages/plugin-loader/'));
    expect(own, 'plugin-loader files must not be baselined: fix the error instead').toEqual([]);
  });
});
