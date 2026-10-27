import { describe, expect, it } from 'vitest';
import { EMBEDDER_DIM_SPECS } from '@papercusp/memory';
import {
  blueprintOperationProviderPackage,
  CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE,
  capabilityClassVectorStorageAcceptsProfile,
  capabilityClassRef,
  normalizeCapabilityClassId,
  parseCapabilityClassRef,
  validateOperationProviderInterface,
  validateProviderInterface,
  type CapabilityClassRow,
  type ProviderOperationContract,
  type ProviderToolContract,
} from './capability-class-registry-store';

const capabilityClass = (overrides: Partial<CapabilityClassRow> = {}): CapabilityClassRow => ({
  id: 'crm.email',
  version: '1.0.0',
  ref: 'crm.email@1.0.0',
  workspaceId: 'ws-a',
  title: 'CRM email',
  description: 'Send a templated email through a customer record provider.',
  interfaceVerbs: {
    send: {
      inputSchema: {
        type: 'object',
        properties: { body: { type: 'string' }, contactId: { type: 'string' } },
        required: ['contactId', 'body'],
      },
      outputSchema: {
        type: 'object',
        properties: { messageId: { type: 'string' } },
        required: ['messageId'],
      },
    },
  },
  behavioralSuiteRef: null,
  status: 'active',
  published: false,
  reviewStatus: 'none',
  tags: ['crm', 'email'],
  hasEmbedding: false,
  embeddingProfile: null,
  createdBy: 'operator',
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
  ...overrides,
});

const providerTool = (overrides: Partial<ProviderToolContract> = {}): ProviderToolContract => ({
  name: 'acme:send-email',
  pluginName: 'acme-crm',
  providerVersion: '2.0.0',
  // Deliberately reverse property insertion order. Structural comparison is
  // canonical, never JSON.stringify insertion-order theatre.
  inputSchema: {
    required: ['contactId', 'body'],
    properties: { contactId: { type: 'string' }, body: { type: 'string' } },
    type: 'object',
  },
  outputSchema: {
    required: ['messageId'],
    properties: { messageId: { type: 'string' } },
    type: 'object',
  },
  ...overrides,
});

describe('capability class identity', () => {
  it('normalizes namespace/job spelling and round-trips an exact versioned ref', () => {
    expect(normalizeCapabilityClassId(' CRM / Email ')).toBe('crm-email');
    expect(normalizeCapabilityClassId('CRM.Email')).toBe('crm.email');
    expect(capabilityClassRef('CRM.Email', '1.2.3')).toBe('crm.email@1.2.3');
    expect(parseCapabilityClassRef('crm.email@1.2.3')).toEqual({ id: 'crm.email', version: '1.2.3' });
    expect(parseCapabilityClassRef('crm.email')).toBeNull();
  });
});

describe('capability class vector storage identity', () => {
  it('accepts only independently declared exact profiles, never width alone', () => {
    expect(capabilityClassVectorStorageAcceptsProfile(EMBEDDER_DIM_SPECS.gemma)).toBe(true);
    expect(capabilityClassVectorStorageAcceptsProfile(EMBEDDER_DIM_SPECS.openai)).toBe(true);
    expect(capabilityClassVectorStorageAcceptsProfile({
      ...EMBEDDER_DIM_SPECS.gemma,
      profileId: 'same-width-foreign-space@v1',
    })).toBe(false);
  });

  it('keeps the index metric coupled to the closed metric mapping', () => {
    expect(CAPABILITY_CLASS_VECTOR_STORAGE_PROFILE).toMatchObject({
      dimensions: 768,
      distanceMetric: 'cosine',
      indexOperatorClass: 'vector_cosine_ops',
    });
  });
});

describe('validateProviderInterface', () => {
  it.each([null, '1.9.0', '2.0.1'])('refuses an unmeasured or mismatched loaded provider version %s', (loadedVersion) => {
    const report = validateProviderInterface({
      capabilityClass: capabilityClass(),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'acme:send-email' },
      lookup: () => ({ ...providerTool(), providerVersion: loadedVersion }),
    });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.problems).toContain(loadedVersion === null
      ? 'loaded provider version is unavailable'
      : `loaded provider version ${loadedVersion} differs from requested 2.0.0`);
  });

  it('passes only from the real provider-owned tool contract and ignores JSON object key order', () => {
    const report = validateProviderInterface({
      capabilityClass: capabilityClass(),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'acme:send-email' },
      lookup: (name) => name === 'acme:send-email' ? providerTool() : null,
    });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual([
      { verb: 'send', tool: 'acme:send-email', ok: true, problems: [] },
    ]);
    expect(report.behavioral).toEqual({ status: 'not-required', suiteRef: null });
  });

  it('refuses absent tools, wrong package ownership, schema drift and undeclared extra verbs', () => {
    const wrongOwner = validateProviderInterface({
      capabilityClass: capabilityClass(),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'other:send', extra: 'acme:extra' },
      lookup: (name) => name === 'other:send'
        ? providerTool({ name, pluginName: 'other-vendor', inputSchema: { type: 'null' } })
        : name === 'acme:extra'
          ? providerTool({ name })
          : null,
    });
    expect(wrongOwner.ok).toBe(false);
    expect(wrongOwner.checks.find((check) => check.verb === 'send')?.problems).toEqual(
      expect.arrayContaining([
        'tool is owned by other-vendor, not provider package acme-crm',
        'input schema differs from the class contract',
      ]),
    );
    expect(wrongOwner.checks.find((check) => check.verb === 'extra')?.problems).toEqual([
      'binding names a verb the class does not declare',
    ]);

    const absent = validateProviderInterface({
      capabilityClass: capabilityClass(),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'missing:tool' },
      lookup: () => null,
    });
    expect(absent.ok).toBe(false);
    expect(absent.checks[0]?.problems).toContain('tool is not present in the live projected-tool registry');
  });

  it('reports a behavioral suite as not-run instead of laundering structural success into behavior proof', () => {
    const report = validateProviderInterface({
      capabilityClass: capabilityClass({ behavioralSuiteRef: 'suite:crm-email-v1' }),
      providerPackage: 'acme-crm',
      providerVersion: '2.0.0',
      registryRevision: 'registry-r1',
      verbBindings: { send: 'acme:send-email' },
      lookup: () => providerTool(),
    });
    expect(report.ok).toBe(true);
    expect(report.behavioral).toEqual({ status: 'not-run', suiteRef: 'suite:crm-email-v1' });
  });
});

describe('validateOperationProviderInterface (portable-identity-packages D-030)', () => {
  const SPEC = 'f'.repeat(64);
  const operation = (overrides: Partial<ProviderOperationContract> = {}): ProviderOperationContract => ({
    // Reversed insertion order again: the comparison is canonical.
    inputSchema: providerTool().inputSchema,
    resultSchema: providerTool().outputSchema!,
    ...overrides,
  });
  const validate = (over: Partial<Parameters<typeof validateOperationProviderInterface>[0]> = {}) =>
    validateOperationProviderInterface({
      capabilityClass: capabilityClass(),
      harnessSlug: 'crm-ops',
      providerVersion: '1.0.0',
      specificationRevision: SPEC,
      verbBindings: { send: 'send-email' },
      lookup: (id) => (id === 'send-email' ? operation() : null),
      ...over,
    });

  it('binds each verb to a declared operation with the verb input and output contracts', () => {
    const report = validate();
    expect(report).toMatchObject({
      schemaVersion: 'capability-class-operation-v1', ok: true, classRef: 'crm.email@1.0.0',
      providerPackage: blueprintOperationProviderPackage('crm-ops'), providerVersion: '1.0.0',
      registryRevision: SPEC, harnessSlug: 'crm-ops',
    });
    expect(report.checks).toEqual([{ verb: 'send', tool: 'send-email', ok: true, problems: [] }]);
  });

  it('refuses an operation the compiled specification does not declare', () => {
    const report = validate({ lookup: () => null });
    expect(report.ok).toBe(false);
    expect(report.checks[0]?.problems).toEqual(['operation is not declared by the compiled blueprint specification']);
  });

  it('refuses an operation whose input or result schema differs from the class contract', () => {
    const input = validate({ lookup: () => operation({ inputSchema: { type: 'object' } }) });
    expect(input.checks[0]?.problems).toEqual(['input schema differs from the class contract']);
    const result = validate({ lookup: () => operation({ resultSchema: { type: 'string' } }) });
    expect(result.checks[0]?.problems).toEqual(['result schema differs from the class output contract']);
  });

  it('refuses a missing binding and a verb the class does not declare', () => {
    const report = validate({ verbBindings: { archive: 'archive-email' } });
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual([
      { verb: 'send', tool: null, ok: false, problems: ['missing provider operation binding'] },
      { verb: 'archive', tool: 'archive-email', ok: false, problems: ['binding names a verb the class does not declare'] },
    ]);
  });
});
