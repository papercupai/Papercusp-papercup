/**
 * Settings → Integrations lists every installed provider that can be set up, not only ticket
 * trackers (plan cupboard-distributable-integrations-2026-10-10 P-005, SPEC-R-2-P-005).
 *
 * A provider earns a card when it declares an `oauth` block OR paste-a-secret `setup.credentials`
 * (P-001). Only ticket providers get source rows; only OAuth providers get a connect link.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderDescriptor } from '@papercusp/plugin-sdk';
import type { ProviderRegistry, RegisteredProvider } from './provider-registry';
import { integrationProviders, summarizeIntegrationProvider, ticketProviders } from './ticket-integrations';

function entry(descriptor: Record<string, unknown>): RegisteredProvider {
  return {
    descriptor: { capabilities: [], datatypes: [], ...descriptor } as unknown as ProviderDescriptor,
    adapter: {} as RegisteredProvider['adapter'],
    pluginName: `${String(descriptor.id)}-plugin`,
    runtime: 'in-process' as RegisteredProvider['runtime'],
    registeredAt: 0,
  };
}

const ticketOAuth = entry({
  id: 'tracker',
  displayName: 'Tracker',
  datatypes: ['ticket'],
  capabilities: ['ticket.containers'],
  oauth: { authorizeUrl: 'https://tracker.example/oauth', tokenUrl: 'https://tracker.example/token', scopes: [] },
});
const chatCredentials = entry({
  id: 'chatter',
  displayName: 'Chatter',
  datatypes: ['chat.message'],
  capabilities: ['chat.channels'],
  setup: { credentials: [{ key: 'botToken', label: 'Bot token' }] },
});
const bare = entry({ id: 'bare', displayName: 'Bare', datatypes: ['ticket'] });

const registry = { list: () => [ticketOAuth, chatCredentials, bare] } as unknown as ProviderRegistry;

describe('integrationProviders', () => {
  it('lists providers with OAuth or declared credentials, sorted by name, and skips ones with neither', () => {
    expect(integrationProviders(registry).map((e) => e.descriptor.id)).toEqual(['chatter', 'tracker']);
  });

  it('leaves the ticket-provider list (sources, containers, rules) unchanged', () => {
    expect(ticketProviders(registry).map((e) => e.descriptor.id)).toEqual(['tracker']);
  });
});

describe('summarizeIntegrationProvider', () => {
  it('gives a credentials-only provider no connect link and no ticket sources', () => {
    const summary = summarizeIntegrationProvider(chatCredentials, [{ key: 'botToken', label: 'Bot token', configured: true }] as never);
    expect(summary).toMatchObject({
      id: 'chatter',
      displayName: 'Chatter',
      datatypes: ['chat.message'],
      tracksTickets: false,
      connectHref: null,
    });
  });

  it('gives an OAuth ticket provider its connect link back to this page', () => {
    const summary = summarizeIntegrationProvider(ticketOAuth, []);
    expect(summary.tracksTickets).toBe(true);
    expect(summary.connectHref).toMatch(/^\/api\/oauth\/start\?/);
    expect(summary.connectHref).toContain(encodeURIComponent('/settings/integrations'));
  });
});
