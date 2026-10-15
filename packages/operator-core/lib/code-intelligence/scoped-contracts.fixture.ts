import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import graphQuery from '../agent-tools/gitnexus/query';
import * as registry from '../harness-registry';
import type { ScopedContractReport } from './scoped-contracts';

const roots: string[] = [];
export function cleanupContractFixtures() { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); }
export function contractFixture(port = 8123) {
  const root = mkdtempSync(join(tmpdir(), 'native-p019-contracts-')); roots.push(root);
  const service = join(root, 'service'), client = join(root, 'client'), secret = join(root, 'secret');
  for (const dir of [service, client, secret]) {
    mkdirSync(dir); writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {
      target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, allowImportingTsExtensions: true } }));
  }
  writeFileSync(join(service, 'api.ts'), 'export interface Response { value: string; }\nexport function readApi(): Response { return { value: "ok" }; }\n');
  writeFileSync(join(service, 'routes.ts'), 'import { defineTool } from "@papercusp/agent-mcp";\nimport { readApi } from "./api";\nexport const route = defineTool({ method: "GET", path: "/read", handler: readApi, input: {}, description: "read response" });\nexport const rpc = defineTool({ name: "service:read", handler: readApi, result: {} });\ndeclare const bus: { emit(name: string): void }; bus.emit("read:ready");\n');
  writeFileSync(join(client, 'client.ts'), `import type { Response } from "../service/api.ts";\nexport async function client() { const response: Response = await (await fetch("http://127.0.0.1:${port}/read")).json(); return response.value.length; }\ndeclare const ctx: { dispatchTool(name: string): void }; ctx.dispatchTool("service:read");\ndeclare const bus: { on(name: string, callback: () => void): void }; bus.on("read:ready", () => {});\n`);
  writeFileSync(join(secret, 'secret.ts'), 'export const PRIVATE_CONTRACT_MARKER = "private";\n');
  const projects = [
    { slug: 'service', path: service, localEndpoint: { host: '127.0.0.1', port, advertisedAt: '2026-10-12T00:00:00Z' } },
    { slug: 'client', path: client }, { slug: 'secret', path: secret },
  ];
  const registrySpy = vi.spyOn(registry, 'loadHarnessRegistry').mockResolvedValue({ projects });
  const ctx = { workspaceId: 'workspace-a', harnessSlug: '*', role: 'operator',
    principal: { slug: 'fixture:reader', workspaceId: 'workspace-a', capabilities: new Set(['intel:read']) } };
  const query = async () => ((await graphQuery.handler(graphQuery.args.parse({ op: 'contracts',
    harnesses: ['service', 'client'], limit: 100 }), ctx as never)) as { data: ScopedContractReport }).data;
  return { root, service, client, secret, projects, registrySpy, ctx, query };
}
