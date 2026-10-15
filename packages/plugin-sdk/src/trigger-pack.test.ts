import { describe, expect, it } from 'vitest';
import { validateTriggerPackDeclaration, type PluginTriggerPack } from './index';

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
];

function validManifest(): {
  kind: 'plugin';
  triggerPack: PluginTriggerPack;
  configSchema: Record<string, unknown>;
  oauth: Array<{ provider: string; scopes: string[]; fieldName: string }>;
} {
  return {
    kind: 'plugin',
    triggerPack: {
      inputs: { type: 'object', properties: {} },
      defaultStormPolicy: { maxRuns: 5, windowSeconds: 60 },
      targets: [{
        id: 'draft-reply',
        kind: 'plan',
        path: 'plan.md',
        inputSchema: { type: 'object', properties: { trigger: { type: 'object' } } },
      }],
      bindings: [{
        id: 'gmail-to-draft',
        source: { kind: 'external', sourceKind: 'gmail', oauthField: 'googleWorkspace' },
        target: 'draft-reply',
        eventPattern: 'ext:gmail:message.received',
        filter: { direction: 'inbound' },
        mapping: { mode: 'payload-context' },
      }],
      edges: [],
    },
    configSchema: {
      type: 'object',
      properties: {
        googleWorkspace: {
          type: 'string',
          secret: true,
          shareable: false,
          snapshotPolicy: 'strip',
          oauth: { provider: 'google', scopes: SCOPES },
        },
      },
    },
    oauth: [{ provider: 'google', scopes: SCOPES, fieldName: 'googleWorkspace' }],
  };
}

describe('validateTriggerPackDeclaration', () => {
  it('accepts a manifest-only trigger pack with explicit secret/share/OAuth semantics', () => {
    expect(validateTriggerPackDeclaration(validManifest())).toEqual([]);
  });

  it('rejects the unsupported schedule source with the supported cadence route', () => {
    const manifest = validManifest();
    manifest.triggerPack.bindings[0] = {
      ...manifest.triggerPack.bindings[0],
      // Keep the legacy shape in the test so the semantic guard remains a
      // useful error for callers that bypass or precede schema validation.
      source: { kind: 'schedule', scheduleRef: 'crosspost-cadence' } as never,
    };

    expect(validateTriggerPackDeclaration(manifest)).toContain(
      'triggerPack binding "gmail-to-draft" declares source kind "schedule", which has no runtime consumer — arm the cadence on the instantiated plan with plans:set-schedule + plans:arm-schedule',
    );
  });

  it('accepts x-options on a string or string-array input (P-004)', () => {
    const manifest = validManifest();
    manifest.triggerPack.inputs = {
      type: 'object',
      properties: {
        channels: { type: 'array', items: { type: 'string' }, 'x-options': { capability: 'chat.channels' } },
        project: { type: 'string', 'x-options': { capability: 'ticket.containers', args: { kind: 'project' } } },
        note: { type: 'string' },
      },
    };
    expect(validateTriggerPackDeclaration(manifest)).toEqual([]);
  });

  it('rejects a malformed x-options source or an input that cannot hold a choice (P-004)', () => {
    const manifest = validManifest();
    manifest.triggerPack.inputs = {
      type: 'object',
      properties: {
        threeSegments: { type: 'string', 'x-options': { capability: 'chat.channels.list' } },
        unknownKey: { type: 'string', 'x-options': { capability: 'chat.channels', provider: 'slack' } },
        badArgs: { type: 'string', 'x-options': { capability: 'chat.channels', args: ['general'] } },
        notAnObject: { type: 'string', 'x-options': 'chat.channels' },
        numeric: { type: 'number', 'x-options': { capability: 'ticket.containers' } },
        numericItems: { type: 'array', items: { type: 'number' }, 'x-options': { capability: 'ticket.containers' } },
      },
    };
    const issues = validateTriggerPackDeclaration(manifest);
    const at = (name: string) => `triggerPack.inputs.properties.${name}.x-options`;
    expect(issues).toEqual(expect.arrayContaining([
      `${at('threeSegments')}.capability must be <domain>.<verb>`,
      `${at('unknownKey')}.provider is not a known option-source key`,
      `${at('badArgs')}.args must be an object`,
      `${at('notAnObject')} must be an object`,
      `${at('numeric')} needs the input to be type "string" or an array of strings`,
      `${at('numericItems')} needs the input to be type "string" or an array of strings`,
    ]));
    expect(issues).toHaveLength(6);
  });

  it('rejects code-tool kind:pack and a source/event family mismatch', () => {
    const manifest = validManifest();
    expect(validateTriggerPackDeclaration({
      ...manifest,
      kind: 'pack',
      triggerPack: {
        ...manifest.triggerPack,
        bindings: manifest.triggerPack.bindings.map((binding) => ({
          ...binding,
          eventPattern: 'ext:slack:mention',
        })),
      },
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('kind "plugin"'),
      expect.stringContaining('ext:gmail:'),
    ]));
  });

  it('rejects a credential field that could leak or asks for mismatched OAuth scopes', () => {
    const manifest = validManifest();
    const properties = (manifest.configSchema.properties as Record<string, Record<string, unknown>>);
    properties.googleWorkspace = {
      ...properties.googleWorkspace,
      secret: false,
      shareable: true,
      snapshotPolicy: 'include',
      oauth: { provider: 'google', scopes: [SCOPES[0]] },
    };
    expect(validateTriggerPackDeclaration(manifest)).toEqual(expect.arrayContaining([
      expect.stringContaining('.secret must be true'),
      expect.stringContaining('.snapshotPolicy must be "strip"'),
      expect.stringContaining('.shareable must be false'),
      expect.stringContaining('.oauth.scopes must match'),
    ]));
  });

  it('rejects absolute, traversing, and non-markdown plan paths', () => {
    for (const path of ['/plan.md', '../plan.md', 'plans/../plan.md', 'plan.json', 'plans\\plan.md']) {
      const manifest = validManifest();
      const target = manifest.triggerPack.targets[0];
      if (target.kind !== 'plan') throw new Error('fixture target must be a plan');
      target.path = path;
      expect(validateTriggerPackDeclaration(manifest)).toContain(
        'triggerPack target "draft-reply" path must be a safe relative .md path',
      );
    }
  });

  it('validates a multi-target event-stitched graph and complete deterministic mapping', () => {
    const manifest = validManifest();
    manifest.triggerPack.targets.push({
      id: 'record-draft',
      kind: 'recipe',
      ref: 'recipes:record-draft',
      revision: 3,
      argsSchema: {
        type: 'object',
        required: ['messageId', 'draftId'],
        properties: {
          messageId: { type: 'string' },
          draftId: { type: 'string' },
        },
      },
    });
    manifest.triggerPack.bindings.push({
      id: 'draft-to-record',
      source: { kind: 'internal', event: 'plan-completed' },
      target: 'record-draft',
      mapping: {
        mode: 'fields',
        fields: {
          messageId: 'trigger.payload.messageId',
          draftId: 'plan.output.draftId',
        },
      },
      retry: { maxAttempts: 3, backoffSeconds: 10, onExhausted: 'dead-letter' },
    });
    manifest.triggerPack.edges.push({
      from: 'gmail-to-draft',
      to: 'draft-to-record',
      event: 'plan-completed',
      correlation: 'inherit',
    });

    expect(validateTriggerPackDeclaration(manifest)).toEqual([]);

    const recipeBinding = manifest.triggerPack.bindings[1];
    if (recipeBinding.mapping?.mode !== 'fields') throw new Error('fixture mapping must use fields');
    delete recipeBinding.mapping.fields?.draftId;
    expect(validateTriggerPackDeclaration(manifest)).toContain(
      'triggerPack recipe binding "draft-to-record" fields mapping is missing required args: draftId',
    );
  });

  it('rejects nondeterministic recipe policy, plan retry policy, and cyclic edges', () => {
    const manifest = validManifest();
    manifest.triggerPack.targets.push({
      id: 'record-draft',
      kind: 'recipe',
      ref: 'recipes:record-draft',
      argsSchema: { type: 'object', properties: {} },
    });
    manifest.triggerPack.bindings[0].retry = {
      maxAttempts: 2,
      onExhausted: 'dead-letter',
    };
    manifest.triggerPack.bindings.push({
      id: 'draft-to-record',
      source: { kind: 'internal', event: 'binding-run-completed' },
      target: 'record-draft',
      mapping: { mode: 'payload-context' },
    });
    manifest.triggerPack.edges.push(
      {
        from: 'gmail-to-draft',
        to: 'draft-to-record',
        event: 'binding-run-completed',
        correlation: 'inherit',
      },
      {
        from: 'draft-to-record',
        to: 'gmail-to-draft',
        event: 'binding-run-completed',
        correlation: 'inherit',
      },
    );

    expect(validateTriggerPackDeclaration(manifest)).toEqual(expect.arrayContaining([
      expect.stringContaining('plan binding "gmail-to-draft" must not declare retry policy'),
      expect.stringContaining('recipe binding "draft-to-record" requires deterministic'),
      expect.stringContaining('recipe binding "draft-to-record" requires an explicit dead-letter retry policy'),
      expect.stringContaining('edge destination "gmail-to-draft" must declare source.kind "internal"'),
      expect.stringContaining('acyclic event-stitched graph'),
    ]));
  });
});
