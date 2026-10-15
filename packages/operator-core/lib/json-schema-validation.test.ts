/**
 * json-schema-validation.test — the shared ajv seam (plan-structured-inputs P-002).
 *
 * The load-bearing case is FAIL-CLOSED: unlike the datatype wrapper, this seam reports
 * a non-compilable schema as `bad_schema` rather than waving the value through, because
 * the plan start gate must never render "could not check" as "nothing was required".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import {
  checkAgainstJsonSchema,
  isCompilableSchema,
  jsonSchemaRequiredKeys,
  missingRequiredJsonSchemaKeys,
} from './json-schema-validation';

// A representative plan-input schema: two required fields, two optional.
const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    harness: { type: 'string', minLength: 1, description: 'harness slug to audit' },
    paths: { type: 'array', items: { type: 'string' }, minItems: 1 },
    severityFloor: { type: 'string', enum: ['nit', 'minor', 'major', 'critical'] },
    dryRun: { type: 'boolean' },
  },
  required: ['harness', 'paths'],
  additionalProperties: false,
} as Record<string, unknown>;

describe('checkAgainstJsonSchema', () => {
  it('validates through strict native ESM without bundled dependency resolution', () => {
    // Vitest and the host bundler resolve extensionless package subpaths that
    // Node ESM rejects. Strip TypeScript only, retaining the real imports.
    const source = readFileSync(new URL('./json-schema-validation.ts', import.meta.url), 'utf8');
    const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'node22' });
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      input: `${code}\nconst schema = { type: 'string', minLength: 2 };\n` +
        `process.stdout.write(JSON.stringify([checkAgainstJsonSchema(schema, 'ok'), checkAgainstJsonSchema(schema, 7)]));`,
      encoding: 'utf8', timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { ok: true },
      { ok: false, code: 'invalid_data', errors: ['/ must be string'] },
    ]);
  });

  it('accepts a value satisfying the schema', () => {
    expect(checkAgainstJsonSchema(AUDIT_SCHEMA, { harness: 'papercusp', paths: ['a'] })).toEqual({
      ok: true,
    });
  });

  it.each([
    ['uuid', '6a263926-e2ee-4267-a1aa-89d1c9ce32ec', 'not-a-uuid'],
    ['email', 'employee@example.com', 'not-an-email'],
    ['uri', 'https://example.com/case/1', 'relative path'],
    ['date-time', '2026-10-15T07:00:00Z', 'yesterday'],
  ])('enforces declared %s formats', (format, valid, invalid) => {
    const schema = { type: 'string', format };
    expect(checkAgainstJsonSchema(schema, valid)).toEqual({ ok: true });
    expect(checkAgainstJsonSchema(schema, invalid)).toMatchObject({
      ok: false, code: 'invalid_data', errors: [expect.stringContaining(format)],
    });
  });

  it('reports a missing required field as invalid_data', () => {
    const r = checkAgainstJsonSchema(AUDIT_SCHEMA, { paths: ['a'] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('invalid_data');
    expect(r.errors.join(' ')).toMatch(/harness/);
  });

  it('reports an unknown key as invalid_data (additionalProperties:false catches an arg typo)', () => {
    const r = checkAgainstJsonSchema(AUDIT_SCHEMA, { harnes: 'papercusp', paths: ['a'] });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('invalid_data');
  });

  it('no schema ⇒ ok (nothing was declared)', () => {
    expect(checkAgainstJsonSchema(null, { anything: 1 })).toEqual({ ok: true });
    expect(checkAgainstJsonSchema({}, { anything: 1 })).toEqual({ ok: true });
  });

  it('FAIL-CLOSED: a non-compilable schema is bad_schema, never a silent pass', () => {
    const r = checkAgainstJsonSchema({ type: 'banana' } as Record<string, unknown>, { x: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.code).toBe('bad_schema');
  });
});

describe('isCompilableSchema', () => {
  it('separates compilable from malformed', () => {
    expect(isCompilableSchema(AUDIT_SCHEMA)).toBe(true);
    expect(isCompilableSchema({ type: 'banana' } as Record<string, unknown>)).toBe(false);
  });
});

describe('jsonSchemaRequiredKeys', () => {
  it('returns the top-level required names in declaration order', () => {
    expect(jsonSchemaRequiredKeys(AUDIT_SCHEMA)).toEqual(['harness', 'paths']);
  });

  it('returns [] for absent / non-array required', () => {
    expect(jsonSchemaRequiredKeys(null)).toEqual([]);
    expect(jsonSchemaRequiredKeys({ type: 'object' })).toEqual([]);
    expect(jsonSchemaRequiredKeys({ required: 'nope' } as Record<string, unknown>)).toEqual([]);
  });
});

describe('missingRequiredJsonSchemaKeys', () => {
  it('lists only the absent required keys', () => {
    expect(missingRequiredJsonSchemaKeys(AUDIT_SCHEMA, { paths: ['a'] })).toEqual(['harness']);
    expect(missingRequiredJsonSchemaKeys(AUDIT_SCHEMA, {})).toEqual(['harness', 'paths']);
    expect(
      missingRequiredJsonSchemaKeys(AUDIT_SCHEMA, { harness: 'p', paths: ['a'] }),
    ).toEqual([]);
  });

  it('treats a non-object value as supplying nothing', () => {
    expect(missingRequiredJsonSchemaKeys(AUDIT_SCHEMA, null)).toEqual(['harness', 'paths']);
    expect(missingRequiredJsonSchemaKeys(AUDIT_SCHEMA, ['not', 'an', 'object'])).toEqual([
      'harness',
      'paths',
    ]);
  });

  it('an explicit null COUNTS as supplied — only undefined is absent', () => {
    // Supplying null is supplying a value; whether null is acceptable is the schema's
    // call (`type: ['string','null']`). Conflating the two would make a deliberate null
    // impossible to pass for a required nullable field.
    expect(missingRequiredJsonSchemaKeys(AUDIT_SCHEMA, { harness: null, paths: ['a'] })).toEqual([]);
    expect(
      missingRequiredJsonSchemaKeys(AUDIT_SCHEMA, { harness: undefined, paths: ['a'] }),
    ).toEqual(['harness']);
  });
});
