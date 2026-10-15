/** P014: literal source/diagnostic oracles through the existing compiler and report. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { firstPartyCallers } from './first-party-callers';
import { nativeChangeReport } from './packer-facade';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'native-interface-')); roots.push(root);
  writeFileSync(join(root, 'target.ts'), 'export interface Response { value: string; }\nexport function readApi(): Response { return { value: "ok" }; }\n');
  writeFileSync(join(root, 'client.ts'), 'import { readApi } from "./target";\nexport function client() { return readApi().value.length; }\n');
  writeFileSync(join(root, 'tool.ts'), 'import { readApi } from "./target";\nfunction defineTool<T>(value: T) { return value; }\nconst request = {}; const response = {};\nexport const tool = defineTool({ name: "read-api", args: request, result: response, handler: readApi, description: "contract docs" });\n');
  return root;
}
const query = (root: string, limit = 20) => firstPartyCallers({ ts, root, name: 'readApi', filePath: 'target.ts',
  paths: ['.'], op: 'impact', direction: 'downstream', includeInterfaces: true, limit });
describe('native P014 compiler interface change evidence', () => {
  it('links a renamed response field to its incompatible known client and static validator/implementation references', async () => {
    const root = fixture();
    const before = query(root);
    expect(before.error).toBeNull(); expect(before.interfaces?.diagnostics).toEqual([]);
    expect(before.interfaces?.registrations).toEqual([expect.objectContaining({ name: 'read-api', kind: 'tool', factoryAuthority: 'unverified', runtimeRegistered: 'unmeasured',
      implementation: expect.objectContaining({ path: 'target.ts', line1: 2 }),
      requestValidator: expect.objectContaining({ path: 'tool.ts' }), responseValidator: expect.objectContaining({ path: 'tool.ts' }),
      documentation: expect.objectContaining({ path: 'tool.ts' }) })]);
    writeFileSync(join(root, 'target.ts'), 'export interface Response { label: string; }\nexport function readApi(): Response { return { label: "ok" }; }\n');
    const after = query(root);
    expect(after.error).toBeNull();
    expect(after.interfaces?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 2339,
      site: expect.objectContaining({ path: 'client.ts', line1: 2 }), message: expect.stringContaining("'value'") })]));
    for (const source of after.interfaces!.sources) expect(source.contentHash).toBe(createHash('sha256')
      .update(readFileSync(join(root, source.path))).digest('hex'));
    const report = await nativeChangeReport({ rootPath: root, include: ['*.ts'] }, { symbol: 'readApi', file: 'target.ts', paths: ['.'] },
      { graph: async () => after, exec: async () => ({ stdout: '', stderr: '' }) });
    expect(report.report.interfaces.status).toBe('measured');
    expect(report.report.interfaces.mismatchedConsumers).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'client.ts' })]));
    expect(report.report.interfaces.limitations.join(' ')).toContain('not executed');
  });
  it('keeps dynamic registration names unknown and bounds diagnostic rows', () => {
    const root = fixture();
    writeFileSync(join(root, 'tool.ts'), 'import { readApi } from "./target";\nfunction defineTool<T>(value: T) { return value; }\nconst dynamicName = "read-api";\nexport const tool = defineTool({ name: dynamicName, handler: readApi });\n');
    writeFileSync(join(root, 'client.ts'), 'import { readApi } from "./target";\nreadApi().missing; readApi().alsoMissing;\n');
    const answer = query(root, 1);
    expect(answer.interfaces?.registrations[0]?.name).toBeNull();
    expect(answer.interfaces?.diagnostics).toHaveLength(1); expect(answer.interfaces?.truncated).toBe(true);
  });
  it('does not label diagnostic evidence current after a cited registration changes during analysis', async () => {
    const root = fixture(), answer = query(root);
    writeFileSync(join(root, 'tool.ts'), 'export const changed = true;\n');
    const result = await nativeChangeReport({ rootPath: root, include: ['*.ts'] }, { symbol: 'readApi', file: 'target.ts' },
      { graph: async () => answer, exec: async () => ({ stdout: '', stderr: '' }) });
    expect(result.report.freshness).toBe('unmeasured');
    expect(result.report.interfaces).toMatchObject({ status: 'unknown', diagnostics: [], registrations: [] });
  });
  it('links unified route input and handler sources through an aliased maintained import, preserving runtime uncertainty', () => {
    const root = fixture();
    writeFileSync(join(root, 'tool.ts'), 'import { defineTool as endpoint } from "@papercusp/agent-mcp";\nimport { readApi } from "./target";\nconst request = {};\nexport const route = endpoint({ method: "GET", path: "/read-api", input: request, handler: readApi });\n');
    const registration = query(root).interfaces?.registrations[0];
    expect(registration).toMatchObject({ name: null, kind: 'route', method: 'GET', path: '/read-api',
      factoryAuthority: 'maintained-import', factory: { path: 'tool.ts', line1: 1 },
      requestValidator: { path: 'tool.ts', line1: 3 }, implementation: { path: 'target.ts', line1: 2 },
      responseValidator: null, runtimeRegistered: 'unmeasured' });
  });
  it('resolves namespace imports and inline handlers but does not confuse prose returns with an output validator', () => {
    const root = fixture();
    writeFileSync(join(root, 'tool.ts'), 'import * as platform from "@papercusp/tooldef";\nimport { readApi } from "./target";\nconst output = {};\nexport const tool = platform.defineTool({ name: "read-api", output, returns: "prose only", handler() { return readApi(); } });\n');
    expect(query(root).interfaces?.registrations[0]).toMatchObject({ factoryAuthority: 'maintained-import',
      implementation: { path: 'tool.ts', line1: 4 }, responseValidator: { path: 'tool.ts', line1: 3 } });
    writeFileSync(join(root, 'tool.ts'), 'import { readApi } from "./target";\nfunction defineTool<T>(value: T) { return value; }\nexport const tool = defineTool({ name: "read-api", returns: "prose only", handler: readApi });\n');
    expect(query(root).interfaces?.registrations[0]).toMatchObject({ factoryAuthority: 'unverified', responseValidator: null });
  });
  it('keeps spread overrides unknown instead of attributing a replaced literal implementation', () => {
    const root = fixture();
    writeFileSync(join(root, 'tool.ts'), 'import { defineTool } from "@papercusp/agent-mcp";\nimport { readApi } from "./target";\nconst override = { name: "other", handler: () => 0 };\nexport const tool = defineTool({ name: "read-api", handler: readApi, ...override });\n');
    expect(query(root).interfaces?.registrations[0]).toMatchObject({ name: null, kind: 'unknown',
      implementation: null, requestValidator: null, responseValidator: null, runtimeRegistered: 'unmeasured' });
  });
});
