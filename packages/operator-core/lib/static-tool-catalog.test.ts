import { describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import './agent-tools/index';
import {
  PRODUCTION_TOOL_REGISTRY_ENTRYPOINT,
  buildBuiltinToolCatalog,
  buildProductionToolSourceFiles,
} from './static-tool-catalog';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function liveMcpNames(): Set<string> {
  return new Set(
    listAllProjectedTools()
      .map((tool) => tool.expose.mcp?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0),
  );
}

describe('static tool catalog derivation', () => {
  it('resolves extensionless dotted module names and still refuses a missing dotted module', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-dotted-module-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: [] }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT, "import type { Job } from './callers.worker';\nimport './callers.worker';\nimport './runtime.generated';");
      write('packages/operator-core/lib/agent-tools/callers.worker.ts', 'export interface Job { name: string }');
      write('packages/operator-core/lib/agent-tools/runtime.generated.mts', 'export const ready = true;');
      expect(buildProductionToolSourceFiles(root)).toEqual(expect.arrayContaining([
        resolve(root, 'packages/operator-core/lib/agent-tools/callers.worker.ts'),
        resolve(root, 'packages/operator-core/lib/agent-tools/runtime.generated.mts'),
      ]));

      const missing = resolve(root, 'missing');
      write('missing/package.json', JSON.stringify({ workspaces: [] }));
      write(`missing/${PRODUCTION_TOOL_REGISTRY_ENTRYPOINT}`, "import './absent.worker';");
      expect(() => buildProductionToolSourceFiles(missing)).toThrow('could not resolve ./absent.worker');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([false, true])('resolves the specific .mjs workspace export with reversed ordering=%s', (reversed) => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-exports-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
      const entries = [['./lib/*', './lib/*.ts'], ['./lib/*.mjs', './lib/*.mjs']];
      write('packages/fixture/package.json', JSON.stringify({
        name: '@test/fixture', exports: Object.fromEntries(reversed ? entries.reverse() : entries),
      }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT, "import '@test/fixture/lib/probe.mjs';");
      write('packages/fixture/lib/probe.mjs', 'export const probe = true;');
      expect(buildProductionToolSourceFiles(root)).toContain(resolve(root, 'packages/fixture/lib/probe.mjs'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('prefers the longer export base and does not fall through a blocked specific export', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'static-export-base-'));
    const write = (path: string, text: string) => {
      const fullPath = resolve(root, path);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, text);
    };
    try {
      write('package.json', JSON.stringify({ workspaces: ['packages/*'] }));
      write('packages/fixture/package.json', JSON.stringify({
        name: '@test/fixture', exports: { './lib/*': './generic/*.ts', './lib/specific/*': './specific/*.mjs' },
      }));
      write(PRODUCTION_TOOL_REGISTRY_ENTRYPOINT, "import '@test/fixture/lib/specific/probe';");
      write('packages/fixture/specific/probe.mjs', 'export const probe = true;');
      expect(buildProductionToolSourceFiles(root)).toContain(resolve(root, 'packages/fixture/specific/probe.mjs'));
      // A new root avoids the scanner's immutable-snapshot cache for the second graph.
      const blocked = resolve(root, 'blocked');
      write('blocked/package.json', JSON.stringify({ workspaces: ['packages/*'] }));
      write('blocked/packages/fixture/package.json', JSON.stringify({
        name: '@test/fixture', exports: { './lib/*': './generic/*.ts', './lib/*.mjs': null },
      }));
      write(`blocked/${PRODUCTION_TOOL_REGISTRY_ENTRYPOINT}`, "import '@test/fixture/lib/probe.mjs';");
      write('blocked/packages/fixture/generic/probe.mjs.ts', 'export const probe = true;');
      expect(() => buildProductionToolSourceFiles(blocked)).toThrow('could not resolve workspace import');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('matches every projected MCP identity in the production registry exactly', () => {
    const derived = buildBuiltinToolCatalog(REPO_ROOT);
    const live = liveMcpNames();
    const missing = [...live].filter((name) => !derived.has(name)).sort();
    const extra = [...derived].filter((name) => !live.has(name)).sort();

    expect(buildProductionToolSourceFiles(REPO_ROOT)).toContain(
      resolve(REPO_ROOT, PRODUCTION_TOOL_REGISTRY_ENTRYPOINT),
    );
    expect(derived.size, 'graph/AST catalog floor — a collapsed scan must fail loudly').toBeGreaterThan(800);
    expect({ missing, extra }, 'derived catalog must have no missing or invented MCP names').toEqual({
      missing: [],
      extra: [],
    });
    expect(derived.size).toBe(live.size);
  });
});
