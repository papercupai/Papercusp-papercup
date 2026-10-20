/** Acceptance for the three first-party manifest-only starter trigger packs (P-021). */
import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPluginFromDir } from './index';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * `oauth` is the in-app OAuth connection a pack binds through a config field. A pack without it
 * binds the source a provider package creates (cupboard-distributable-integrations-2026-10-10
 * P-008: the Slack pack moved onto the `slack` package's source), so it declares no credential.
 */
const PACKS = [
  {
    slug: 'email-draft-responder',
    targetId: 'draft-reply',
    sourceKind: 'gmail',
    eventPattern: 'ext:gmail:message.received',
    datatype: 'email-message',
    oauth: {
      field: 'googleWorkspace',
      provider: 'google',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.compose',
      ],
    },
  },
  {
    slug: 'slack-thread-responder',
    targetId: 'thread-reply',
    sourceKind: 'slack',
    eventPattern: 'ext:slack:mention',
    datatype: 'chat-message',
    oauth: null,
  },
  {
    // provider-adapters-to-packages P-025: binds the `discord` package's source the same way.
    slug: 'discord-community-responder',
    targetId: 'member-reply',
    sourceKind: 'discord',
    eventPattern: 'ext:discord:mention',
    datatype: 'chat-message',
    oauth: null,
  },
  {
    slug: 'meeting-prep-brief',
    targetId: 'prepare-brief',
    sourceKind: 'gcal',
    eventPattern: 'ext:gcal:event-upcoming',
    datatype: 'calendar-event',
    oauth: {
      field: 'googleWorkspace',
      provider: 'google',
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/contacts.readonly',
      ],
    },
  },
] as const;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

describe.each(PACKS)('$slug shipped trigger pack', (pack) => {
  it('loads as manifest-only, declares a canonical plan input, and stays disarmed', async () => {
    const dir = resolve(REPO_ROOT, 'libs/papercusp/plugins', pack.slug);
    const result = await loadPluginFromDir(dir, 'global');
    expect('error' in result ? result.error : null).toBeNull();
    expect('skipped' in result ? result.skipped : null).toBeNull();
    if (!('plugin' in result)) return;

    expect((result.plugin as unknown as { __runtime?: string }).__runtime).toBe('manifest-only');
    expect(result.triggerPack).toMatchObject({
      targets: [{ id: pack.targetId, kind: 'plan', path: 'plan.md' }],
      bindings: [{
        source: {
          kind: 'external',
          sourceKind: pack.sourceKind,
          ...(pack.oauth ? { oauthField: pack.oauth.field } : {}),
        },
        target: pack.targetId,
        eventPattern: pack.eventPattern,
        mapping: { mode: 'payload-context' },
      }],
      edges: [],
    });
    expect(result.triggerPack?.bindings.every((binding) => !('armed' in binding))).toBe(true);
    expect(Number(result.triggerPack?.defaultStormPolicy?.maxRuns)).toBeGreaterThan(0);
    expect(Number(result.triggerPack?.defaultStormPolicy?.windowSeconds)).toBeGreaterThan(0);

    const inputs = object(result.triggerPack?.inputs);
    expect(Object.keys(object(inputs.properties)).length).toBeGreaterThan(0);
    const target = result.triggerPack?.targets[0];
    expect(target?.kind).toBe('plan');
    if (target?.kind === 'plan') {
      const targetProperties = object(target.inputSchema.properties);
      const triggerProperties = object(object(targetProperties.trigger).properties);
      expect(object(triggerProperties.payload).datatype).toBe(pack.datatype);
    }

    const configProperties = object(object(result.plugin.configSchema).properties);
    if (!pack.oauth) {
      // A package-bound pack carries no credential field and no in-app OAuth requirement.
      expect(result.triggerPack?.bindings.every((binding) => !('oauthField' in binding.source))).toBe(true);
      expect(result.plugin.oauth ?? []).toEqual([]);
      expect(Object.values(configProperties).some((field) => object(field).secret === true)).toBe(false);
      return;
    }
    expect(configProperties[pack.oauth.field]).toMatchObject({
      secret: true,
      shareable: false,
      snapshotPolicy: 'strip',
      oauth: { provider: pack.oauth.provider, scopes: [...pack.oauth.scopes] },
    });
    expect(result.plugin.oauth?.[0]).toMatchObject({
      provider: pack.oauth.provider,
      fieldName: pack.oauth.field,
      scopes: [...pack.oauth.scopes],
    });
  });
});
