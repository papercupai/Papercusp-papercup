/**
 * WI-10006543: graph:query routes `callers` to the first-party backend (the
 * vendored TypeScript, D-026), not to the GitNexus facade. The answer's backend
 * says which one ran, whether or not the vendored TypeScript is installed on the
 * machine running this test, so the routing is checked either way.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import graphQuery from './query';

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'graph-query-callers-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.ts'), 'export function target(): number {\n  return 1;\n}\nexport const v = target();\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const run = async (args: Record<string, unknown>) => {
  const parsed = graphQuery.args.parse(args);
  const out = (await graphQuery.handler(parsed, { projectDir: root } as never)) as {
    data: { backend: string; error: string | null; coverage: { limitations: string[] } };
  };
  return out.data;
};

describe('graph:query callers', () => {
  it('is answered by the first-party TypeScript backend, never the GitNexus facade', async () => {
    const a = await run({ op: 'callers', name: 'target' });
    expect(a.backend).toBe('typescript-service');
  }, 60_000);

  it('says which GitNexus selectors it ignored', async () => {
    const a = await run({ op: 'callers', name: 'target', uid: 'Function:x', kind: 'Function' });
    expect(a.backend).toBe('typescript-service');
    expect(a.coverage.limitations.join('\n')).toMatch(/callers ignores kind, uid/);
  }, 60_000);

  // native-code-intelligence-ecosystem-and-dream-2026-10-09#P-008 moved impact
  // to the first-party backend (query.ts native op list). This used to assert
  // the opposite, from WI-10006543, when only callers was native.
  it('answers impact with the first-party TypeScript backend', async () => {
    const a = await run({ op: 'impact', name: 'target' });
    expect(a.backend).toBe('typescript-service');
  }, 60_000);

  it('leaves the non-native health op on the GitNexus facade', async () => {
    // No dispatcher in this ctx: the facade refuses with a wiring fault, which proves the route.
    const a = await run({ op: 'health' });
    expect(a.backend).not.toBe('typescript-service');
    expect(a.error).toBeTruthy();
  });
});
