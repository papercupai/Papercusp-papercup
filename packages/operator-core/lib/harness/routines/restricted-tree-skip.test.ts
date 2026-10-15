/**
 * WI-10005745 — routines that execute integration-tree code are skipped while a restricted
 * session's writes are held in that tree (D-012). Units for the skip verdict, the registry flag,
 * the dispatcher wiring, and a SOURCE-DERIVED classification guard: every system-action module
 * that reaches the integration root must either declare `executesIntegrationTreeCode: true` or
 * carry a written justification here, so a new tree-executing routine cannot slip in unfenced.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RestrictedEditHolding } from '../../personal-vault/git-sync-hold';
import { integrationTreeRoots, restrictedTreeSkipReason } from './restricted-tree-skip';
import { getSystemActionEntry, registerSystemAction } from './system-actions';

const LIB = resolve(fileURLToPath(new URL('../..', import.meta.url)));

let root: string;
beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'restricted-tree-skip-')));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'held.mjs'), 'export {};\n');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const hold = (...paths: string[]) =>
  vi.fn(async (): Promise<RestrictedEditHolding[]> =>
    paths.map((path) => ({ path, owner: 'su-restricted', intent: 'restricted-disclosure hold (D-006/P-014): fixture', coordinationDomain: root })),
  );

describe('restrictedTreeSkipReason', () => {
  it('never consults the census for an action that does not execute tree code', async () => {
    const holdings = hold('scripts/held.mjs');
    expect(await restrictedTreeSkipReason('reader', { executesIntegrationTreeCode: false }, { roots: [root], holdings })).toBeNull();
    expect(await restrictedTreeSkipReason('unknown', undefined, { roots: [root], holdings })).toBeNull();
    expect(holdings).not.toHaveBeenCalled();
  });

  it('runs a declared action when nothing is held (calibration)', async () => {
    expect(await restrictedTreeSkipReason('cargo-test', { executesIntegrationTreeCode: true }, { roots: [root], holdings: hold() })).toBeNull();
  });

  it('skips a declared action while any restricted write is held in the tree, naming the file', async () => {
    const reason = await restrictedTreeSkipReason('cargo-test', { executesIntegrationTreeCode: true }, { roots: [root], holdings: hold('scripts/held.mjs') });
    expect(reason).toMatch(/^system:cargo-test skipped — restricted_write_held: 1 held restricted write\(s\)/);
    expect(reason).toContain('scripts/held.mjs');
  });

  it('ignores holds in a different checkout', async () => {
    const elsewhere = vi.fn(async (): Promise<RestrictedEditHolding[]> => [
      { path: 'scripts/held.mjs', owner: 'su-restricted', intent: 'fixture', coordinationDomain: '/some/other/repo' },
    ]);
    expect(await restrictedTreeSkipReason('cargo-test', { executesIntegrationTreeCode: true }, { roots: [root], holdings: elsewhere })).toBeNull();
  });

  it('fails closed: an unreadable census skips the fire', async () => {
    const broken = vi.fn(async (): Promise<RestrictedEditHolding[]> => {
      throw new Error('census offline');
    });
    const reason = await restrictedTreeSkipReason('cargo-test', { executesIntegrationTreeCode: true }, { roots: [root], holdings: broken });
    expect(reason).toContain('restricted_hold_state_unknown');
    expect(reason).toContain('census offline');
  });

  it('checks the integration root and this module\u2019s repo root, once each', () => {
    const roots = integrationTreeRoots({ PAPERCUSP_INTEGRATION_ROOT: root }, '/nowhere/apps/operator');
    expect(roots[0]).toBe(root);
    // The module's own enclosing checkout is the second candidate (this test runs inside one).
    expect(roots.length).toBe(2);
    expect(LIB.startsWith(roots[1])).toBe(true);
    expect(new Set(roots).size).toBe(roots.length);
    expect(integrationTreeRoots({}, '/x/apps/operator')[0]).toBe('/x');
  });
});

describe('registerSystemAction executesIntegrationTreeCode', () => {
  it('records the declaration and defaults to false', () => {
    registerSystemAction('wi5745-test-exec', async () => {}, { executesIntegrationTreeCode: true });
    registerSystemAction('wi5745-test-plain', async () => {});
    expect(getSystemActionEntry('wi5745-test-exec')?.executesIntegrationTreeCode).toBe(true);
    expect(getSystemActionEntry('wi5745-test-plain')?.executesIntegrationTreeCode).toBe(false);
  });
});

/** Actions that reach the integration root but never EXECUTE tree code. A reason is mandatory. */
const JUSTIFIED: Record<string, string> = {
  'harness/git-sync/git-sync-action.ts': 'git plumbing only; D-011 holds restricted writes out of its commits',
  'harness/routines/completion-claim-recheck-action.ts': 'reads tree files (repoSourceReader); executes nothing',
  'harness/routines/dead-citation-sweep-action.ts': 'git ls-files plus file reads; executes nothing',
  'harness/routines/gitnexus-reindex-action.ts': 'tree-sitter parses tree files; never executes them',
  'harness/routines/frozen-candidate-drift-sweep-action.ts': 'git log / rev-parse only',
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.ts$/.test(entry.name) && !/\.(test|spec)\.ts$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

describe('classification guard (derived from source)', () => {
  const REGISTERS = /^\s*registerSystemAction\(/m;
  const REACHES_TREE = /integrationRoot\(|moduleRepoRoot\(|PAPERCUSP_INTEGRATION_ROOT|tsxBin\(/;
  const candidates = sourceFiles(LIB)
    .filter((file) => {
      const text = readFileSync(file, 'utf8');
      return REGISTERS.test(text) && REACHES_TREE.test(text);
    })
    .map((file) => relative(LIB, file).split('\\').join('/'))
    .sort();

  it('finds the known population (the scan itself works)', () => {
    expect(candidates).toContain('harness/routines/cargo-test-action.ts');
    expect(candidates).toContain('harness/git-sync/git-sync-action.ts');
  });

  it('every action module that reaches the integration root is declared or justified', () => {
    const unclassified = candidates.filter(
      (rel) => !JUSTIFIED[rel] && !readFileSync(join(LIB, rel), 'utf8').includes('executesIntegrationTreeCode: true'),
    );
    expect(unclassified, 'declare executesIntegrationTreeCode: true, or justify it in JUSTIFIED with a reason').toEqual([]);
  });

  it('a justification cannot outlive its subject or contradict a declaration', () => {
    for (const rel of Object.keys(JUSTIFIED)) {
      expect(candidates, `${rel} is no longer a candidate; drop its JUSTIFIED row`).toContain(rel);
      expect(readFileSync(join(LIB, rel), 'utf8')).not.toContain('executesIntegrationTreeCode: true');
    }
  });

  it('keeps the tree-executing actions declared', () => {
    const declared = [
      'harness/routines/cargo-test-action.ts',
      'harness/routines/autoloop-release-readiness-action.ts',
      'gates/gate-canary-sweep-action.ts',
      'harness/routines/supervision-reconcile-action.ts',
      'harness/routines/project-history-refresh-action.ts',
      'harness/routines/p2p-perf-actions.ts',
      'harness/routines/sync-batch-delta-check-action.ts',
      'harness/routines/sync-batch-lint-guards-action.ts',
      'harness/routines/gate-fire-drill-action.ts',
      'harness/routines/release-actions.ts',
      // Runs release-local.sh and setup-release-checkout.sh from the LIVE tree before it moves
      // into the pinned release checkout; a committed source sha does not cover those scripts.
      'harness/routines/nightly-release-cut-action.ts',
      // Runs the live tree's scripts/run-operator-e2e-isolated.sh, the verify-tauri-headless rig
      // and the Playwright specs (WI-10006805).
      'harness/routines/operator-e2e-isolated-action.ts',
    ];
    for (const rel of declared) expect(readFileSync(join(LIB, rel), 'utf8'), rel).toContain('executesIntegrationTreeCode: true');
  });
});

describe('dispatcher wiring', () => {
  it('the durable routine workflow asks before it runs a system action', () => {
    const src = readFileSync(join(LIB, 'dbos/routines-workflow.ts'), 'utf8');
    const ask = src.indexOf('restrictedTreeSkipReason(action, entry)');
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(src.indexOf('if (entry?.ownSteps)'));
    expect(src).toContain("'last_skip_reason'");
  });

  it('the ephemeral executor asks before it runs a system action', () => {
    const src = readFileSync(join(LIB, 'dbos/ephemeral-executor.ts'), 'utf8');
    const ask = src.indexOf('restrictedTreeSkipReason(name, getSystemActionEntry(name))');
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(src.indexOf('action({', ask));
  });
});
