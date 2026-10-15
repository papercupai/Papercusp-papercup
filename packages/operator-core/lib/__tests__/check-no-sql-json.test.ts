/**
 * Positive controls for the compatibility-named `lint:no-sql-json` gate.
 *
 * The gate used to ban valid `sql.json(value)` calls after the canonical
 * db-org client acquired a sticky hybrid JSON/JSONB serializer. It now guards
 * that serializer contract itself. These synthetic cases prove the detector
 * can fail for each root-cause regression; the live-tree case proves current
 * production + test wiring satisfy the same contract.
 */
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-ignore — pure .mjs guard module; detector tests intentionally import its source of truth.
import * as guardModule from '../../../../scripts/check-no-sql-json.mjs';

const { checkJsonbSerializerContract, inspectJsonbSerializerContract } = guardModule as {
  checkJsonbSerializerContract: (root?: string) => string[];
  inspectJsonbSerializerContract: (sources: {
    connection: string;
    serializer: string;
    orgTestFixture: string;
    planToolFixture: string;
  }) => string[];
};

const ROOT = resolve(__dirname, '../../../..');

const VALID = {
  connection: [
    'function buildClient() {',
    '  const client = postgres(url);',
    '  restoreRawJsonbSerializer(client);',
    '  return client;',
    '}',
  ].join('\n'),
  serializer: [
    "const DRIZZLE_MUTATED_JSON_OIDS = ['114', '3802'] as const;",
    'export function restoreRawJsonbSerializer(client: Sql): void {',
    '  const serializers = client.options.serializers;',
    "  const hybrid = (x: any) => typeof x === 'string' ? x : JSON.stringify(x);",
    '  for (const oid of DRIZZLE_MUTATED_JSON_OIDS) {',
    '    Object.defineProperty(serializers, oid, {',
    '      get: () => hybrid,',
    '      set: () => {},',
    '    });',
    '  }',
    '}',
  ].join('\n'),
  orgTestFixture: [
    'function applyRawSerializerFixes(client: Sql): Sql {',
    '  restoreRawJsonbSerializer(client);',
    '  return client;',
    '}',
  ].join('\n'),
  planToolFixture: [
    'const admin = postgres(url, { max: 2 });',
    'restoreRawJsonbSerializer(admin);',
  ].join('\n'),
};

const inspect = (overrides: Partial<typeof VALID> = {}) => inspectJsonbSerializerContract({ ...VALID, ...overrides });

describe('check-no-sql-json compatibility gate — hybrid serializer contract', () => {
  it('accepts the complete contract', () => {
    expect(inspect()).toEqual([]);
  });

  it('fails if production buildClient stops installing the serializer', () => {
    const problems = inspect({ connection: 'function buildClient() { return postgres(url); }' });
    expect(problems).toEqual([expect.stringContaining('buildClient must call restoreRawJsonbSerializer(client)')]);
  });

  it('fails if the serializer stops passing strings through', () => {
    const problems = inspect({
      serializer: VALID.serializer.replace("typeof x === 'string' ? x : JSON.stringify(x)", 'JSON.stringify(x)'),
    });
    expect(problems).toContainEqual(expect.stringContaining('pass strings through'));
  });

  it('fails if a later drizzle() wrap can overwrite the serializer', () => {
    const problems = inspect({
      serializer: VALID.serializer.replace(/Object\.defineProperty\([\s\S]*?\n\s*}\);/, 'serializers[oid] = hybrid;'),
    });
    expect(problems).toContainEqual(expect.stringContaining('sticky get/set accessors'));
  });

  it('fails if either JSON OID loses coverage', () => {
    const problems = inspect({ serializer: VALID.serializer.replace("'114', ", '') });
    expect(problems).toContainEqual(expect.stringContaining('JSON OID 114 and JSONB OID 3802'));
  });

  it('fails if the production-shaped org fixture diverges from production', () => {
    const problems = inspect({
      orgTestFixture: 'function applyRawSerializerFixes(client: Sql) { return client; }',
    });
    expect(problems).toEqual([
      expect.stringContaining('applyRawSerializerFixes must call restoreRawJsonbSerializer(client)'),
    ]);
  });

  it('fails if the plan-tool fixture builds its admin client without the serializer', () => {
    const problems = inspect({ planToolFixture: 'const admin = postgres(url, { max: 2 });' });
    expect(problems).toEqual([
      expect.stringContaining('must call restoreRawJsonbSerializer(admin)'),
    ]);
  });

  it('the live tree satisfies the contract', () => {
    expect(checkJsonbSerializerContract(ROOT)).toEqual([]);
  });
});
