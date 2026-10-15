/**
 * P-061 regression guard (per-window-workspace-context-2026-05-31).
 *
 * Request-path code must resolve the active workspace through
 * `activeWorkspaceId()` (which prefers the request-scoped ALS), NOT by reading
 * `readRegistry().current` / `reg.current` directly — a direct read bypasses the
 * per-window context and re-introduces the process-global flapping this plan
 * fixes. Same spirit as `no-server-imports-in-client`.
 *
 * Only `activeWorkspaceId()` itself and the workspace-MANAGEMENT routes (which
 * legitimately read/SET `reg.current`) are allowed.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const LIB_ROOT = join(__dirname); // apps/operator/lib

// Files allowed to touch `reg.current` directly (repo-relative-from-lib suffix).
const ALLOW = new Set([
  'workspace-registry.ts', // activeWorkspaceId() — the canonical reader
  'harness/papercusp-workspace.ts', // bootstrap default when unset
  'endpoint-route/routes/workspaces/switch.ts', // the switch handler SETS it
  'endpoint-route/routes/workspaces/index.ts', // bootstrap default on create
  'endpoint-route/routes/workspaces/by-id.ts', // workspace management
  // First-boot dogfood-hive bootstrap (owner decision 2026-06-23): deliberately
  // SETS registry.current to the home workspace so the freshly-created `papercusp`
  // hive is visible — the documented counterpart to ensurePapercuspWorkspace's
  // "never hijack current" rule, a workspace-management writer like switch.ts.
  'harness/bootstrap-papercusp-hive.ts',
  // resolveActiveWorkspaceId() — the BROWSER-side active-workspace resolver
  // (P-030), the client analogue of activeWorkspaceId(). It reads reg.current
  // only as the new-window-default fallback on a *fetched* registry object
  // (a param), never the server process-global readRegistry().
  'browser-workspace.ts',
  // Test-only hosted fixture validates registry.current inside its disposable,
  // private runtime; it does not resolve production request workspaces.
  'llm-testing/public-manual-hosted-fixture.ts',
  // Native acceptance fixture verifies/switches an isolated test registry; it
  // is a CLI/test helper, not a production request handler.
  'native-device-fixture.ts',
  // First-boot canonical-hive join bootstrap: deliberately makes the joined
  // Papercusp workspace visible as home after a successful join, matching the
  // workspace-management bootstrap writers above.
  'harness/papercusp-hive-join.ts',
]);

// Match the conventional ways code reads the active workspace off the registry.
const OFFENSE = [/\breg\.current\b/, /\bregistry\.current\b/, /readRegistry\(\)[^;\n]*\.current\b/];

/**
 * Broader catch: any file that reads the registry FILE directly AND accesses
 * `.current` is resolving the active workspace by hand under a non-conventional
 * var name (e.g. `JSON.parse(readFileSync('registry.json')).current`). Inside a
 * file that touches registry.json, `.current` is the active workspace, not a ref.
 */
function readsRegistryCurrentByHand(code: string): boolean {
  const readsRegistryFile = /registry\.json/.test(code) && /readFileSync|existsSync|statSync/.test(code);
  return readsRegistryFile && /\.current\b/.test(code);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
}

/** Strip line + block comments so a doc-comment mentioning `reg.current` doesn't trip the guard. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, '')) // line comments
    .join('\n');
}

describe('P-061: no direct reg.current reads in request-path code', () => {
  it('every reg.current access lives in activeWorkspaceId() or a workspace-management route', () => {
    const files: string[] = [];
    walk(LIB_ROOT, files);
    const offenders: string[] = [];
    for (const file of files) {
      const suffix = relative(LIB_ROOT, file);
      if (ALLOW.has(suffix)) continue;
      const code = stripComments(readFileSync(file, 'utf8'));
      if (OFFENSE.some((re) => re.test(code)) || readsRegistryCurrentByHand(code)) {
        offenders.push(suffix);
      }
    }
    expect(
      offenders,
      `These request-path files read reg.current directly — use activeWorkspaceId() instead, ` +
        `or add the file to ALLOW only when its direct read has a documented non-request-path role:\n` +
        offenders.map((f) => `  - ${f}`).join('\n'),
    ).toEqual([]);
  });

  it('the detector catches the offense pattern and ignores React refs / comments', () => {
    const hits = (src: string) => OFFENSE.some((re) => re.test(stripComments(src)));
    // Offenses:
    expect(hits('const ws = reg.current;')).toBe(true);
    expect(hits('return registry.current ?? "default";')).toBe(true);
    expect(hits('const ws = readRegistry().current;')).toBe(true);
    // Not offenses:
    expect(hits('inputRef.current?.focus();')).toBe(false);
    expect(hits('// resolve against reg.current historically')).toBe(false);
    expect(hits('const reg = readRegistry(); return reg.workspaces;')).toBe(false);
  });

  it('the broader detector catches a by-hand registry.json current read (e.g. parsed.current)', () => {
    const byHand =
      `const parsed = JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'));\n` +
      `if (parsed.current) return parsed.current;`;
    expect(readsRegistryCurrentByHand(byHand)).toBe(true);
    // A registry read for enumeration (.workspaces) is fine:
    expect(
      readsRegistryCurrentByHand(`const r = JSON.parse(readFileSync('registry.json')); return r.workspaces;`),
    ).toBe(false);
    // A plain ref read with no registry file is fine:
    expect(readsRegistryCurrentByHand(`scrollRef.current.scrollTop = 0;`)).toBe(false);
  });
});
