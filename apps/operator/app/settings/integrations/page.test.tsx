// @vitest-environment jsdom
/**
 * Settings → Integrations (linear-asana-task-sync-2026-10-05 P-007, D-014): renders from the
 * overview, subscribes the live query as the user the routes resolve, and sends every write to its
 * route with the body the route expects. The source's harness and a rule's target harness are
 * deliberately different values: the page lets a user pick them independently.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { providerAppRegistrationView, type ProviderDescriptor } from '@papercusp/plugin-sdk/provider';

const H = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  sync: new Map<string, unknown[]>(),
  queryArgs: new Map<string, unknown>(),
  queryEnabled: new Map<string, boolean | undefined>(),
  desktop: false,
  openExternal: vi.fn(async (_href: string) => {}),
  routes: [] as Array<{ method: string; path: string | RegExp; status: number; body: unknown }>,
  calls: [] as Array<{ method: string; url: string; body: unknown }>,
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args, enabled }: { queryName: string; args: unknown; enabled?: boolean }) => {
    H.queryArgs.set(queryName, args);
    H.queryEnabled.set(queryName, enabled);
    return { data: enabled === false ? undefined : H.sync.get(queryName), loading: false, error: null };
  },
}));

vi.mock('sonner', () => ({ toast: H.toast }));

vi.mock('nuqs', () => ({
  parseAsString: { withDefault: (defaultValue: string) => ({ defaultValue }) },
  parseAsStringEnum: () => ({ withDefault: (defaultValue: string) => ({ defaultValue }) }),
  useQueryState: (_key: string, parser?: { defaultValue?: string }) => useState<string | null>(parser?.defaultValue ?? ''),
}));

vi.mock('../../harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: unknown }>;
    ariaLabel?: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled>
        —
      </option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {String(option.label)}
        </option>
      ))}
    </select>
  ),
}));

vi.mock('../../_components/ExternalLinkProvider', () => ({
  isExternalWebUrl: (href: string, current: string) => new URL(href).origin !== new URL(current).origin,
  openExternalWebUrl: H.openExternal,
}));

vi.mock('@/lib/ipc-status-tauri', () => ({ isDesktop: () => H.desktop }));

import Page from './page';

const API = '/api/user/integrations/tickets';

/** A registered OAuth app (P-009): status only, never a secret. */
function oauthClient(ref: string, configured = true) {
  return {
    ref,
    configured,
    clientId: configured ? `${ref}-client` : null,
    hasClientSecret: configured,
    redirectUri: 'http://127.0.0.1/api/oauth/callback',
    savedAt: null,
    secretRequired: true,
  };
}

const LINEAR = {
  id: 'linear',
  displayName: 'Linear',
  capabilities: ['ticket.sync', 'ticket.containers'],
  datatypes: ['ticket'],
  tracksTickets: true,
  canListContainers: true,
  statusMapping: 'provider-defined',
  requiredConfig: ['teamIds'],
  connectHref: '/api/oauth/start?provider=linear&return=%2Fsettings%2Fintegrations',
  credentials: [],
  sourceSettings: { organization: false, liveSearch: false },
  appRegistration: null,
  oauthClient: oauthClient('linear'),
};
const ASANA = {
  id: 'asana',
  displayName: 'Asana',
  capabilities: ['ticket.sync', 'ticket.containers'],
  datatypes: ['ticket'],
  tracksTickets: true,
  canListContainers: true,
  statusMapping: 'sections',
  requiredConfig: ['projectGids'],
  connectHref: '/api/oauth/start?provider=asana&return=%2Fsettings%2Fintegrations',
  credentials: [],
  sourceSettings: { organization: false, liveSearch: false },
  appRegistration: null,
  oauthClient: oauthClient('asana'),
};

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: 'src-1',
    provider: 'linear',
    providerAccountId: 'org-1',
    accountLabel: 'Acme',
    status: 'connected',
    lastError: null,
    lastSyncAt: null,
    nextAttemptAt: null,
    failureCount: 0,
    scope: 'personal',
    liveSearch: false,
    config: { accountLabel: 'Acme' },
    missingConfig: ['teamIds', 'harnessSlug'],
    mirrored: 0,
    admitted: 0,
    rules: [],
    ...overrides,
  };
}

function route(method: string, path: string | RegExp, body: unknown, status = 200) {
  H.routes.push({ method, path, status, body });
}

function serve(overview: { providers: unknown[]; sources: unknown[]; triggerPacks?: unknown[] }) {
  route('GET', API, { ok: true, userId: 'user-1', triggerPacks: [], ...overview });
}

function packageDescriptor(directory: string): ProviderDescriptor {
  return JSON.parse(readFileSync(resolve(process.cwd(), '../../libs/papercusp/plugins', directory, 'papercusp.json'), 'utf8')).provider;
}

/** A provider that signs in with a pasted credential only and syncs no tickets (P-001/P-005). */
const CHAT = {
  id: 'chatter',
  displayName: 'Chatter',
  capabilities: ['chat.channels'],
  datatypes: ['chat.message'],
  tracksTickets: false,
  canListContainers: false,
  statusMapping: 'provider-defined',
  requiredConfig: [],
  connectHref: null,
  credentials: [
    { key: 'botToken', label: 'Bot token', help: null, helpUrl: null, placeholder: null, pattern: null, hosts: ['chat.example'], perPrincipal: false, configured: false, savedAt: null },
  ],
  sourceSettings: { organization: false, liveSearch: false },
  appRegistration: null,
  oauthClient: null,
};

const PACK_REVIEW = {
  pluginName: 'intake-pack',
  pluginVersion: '1.0.0',
  harnessSlug: 'papercusp',
  status: 'configured',
  capabilities: [],
  oauth: [],
  bindings: [
    {
      packBindingId: 'intake',
      triggerBindingId: 'b1',
      kind: 'external',
      source: { id: 's1', kind: 'chatter' },
      eventPattern: 'message.posted',
      datatype: null,
      filter: {},
      target: { harnessSlug: 'papercusp', planSlug: 'triage' },
      planInput: {},
      stormPolicy: {},
    },
  ],
  entryPoints: [],
  plans: [],
  recipients: [],
  unmet: [] as unknown[],
};

function pack(overrides: { installationId?: string; pluginName?: string; unmet?: unknown[] } = {}) {
  const installationId = overrides.installationId ?? 'pack-1';
  const pluginName = overrides.pluginName ?? 'intake-pack';
  return {
    installationId,
    harnessSlug: 'papercusp',
    pluginName,
    pluginVersion: '1.0.0',
    status: 'configured',
    inputsSchema: {
      type: 'object',
      required: ['project'],
      properties: {
        project: { type: 'string', title: 'Project' },
        notify: { type: 'boolean', title: 'Notify' },
        priority: { type: 'string', title: 'Priority', enum: ['normal', 'urgent'] },
      },
    },
    inputs: { project: 'P1', priority: 'normal' },
    state: {
      installationId,
      fingerprint: `fp-${installationId}`,
      reviewedFingerprint: null,
      reviewedBy: null,
      reviewedAt: null,
      current: false,
      bindingCount: 1,
      armedBindingCount: 0,
      review: { ...PACK_REVIEW, pluginName, unmet: overrides.unmet ?? [] },
    },
  };
}

async function packSection(pluginName: string) {
  const element = await waitFor(() => {
    const found = document.querySelector(`[data-trigger-pack="${pluginName}"]`);
    if (!found) throw new Error(`trigger pack ${pluginName} is not rendered`);
    return found as HTMLElement;
  });
  return within(element);
}

/** The rendered row for one source, once the overview has loaded it. */
async function row(sourceId: string) {
  const element = await waitFor(() => {
    const found = document.querySelector(`[data-source="${sourceId}"]`);
    if (!found) throw new Error(`source row ${sourceId} is not rendered`);
    return found as HTMLElement;
  });
  return within(element);
}
const call = (method: string, url: string) => H.calls.find((c) => c.method === method && c.url === url);

beforeEach(() => {
  H.routes = [];
  H.calls = [];
  H.sync.clear();
  H.queryArgs.clear();
  H.queryEnabled.clear();
  H.desktop = false;
  H.sync.set('harnessProjects.lite', [{ slug: 'papercusp' }, { slug: 'website' }]);
  // The page also mounts the Slack setup card; give it a "nothing connected yet" answer so
  // every test here sees a settled Slack card rather than its own read-failure alert.
  route('GET', '/api/admin/triggers', { sources: [] });
  route('GET', '/api/admin/triggers/slack/manifest', { ok: true, manifest: { display_information: { name: 'Papercusp' } } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? 'GET';
      const url = String(input);
      H.calls.push({ method, url, body: init?.body ? JSON.parse(init.body) : undefined });
      const match = H.routes.find((r) => r.method === method && (typeof r.path === 'string' ? r.path === url : r.path.test(url)));
      const status = match?.status ?? 404;
      const body = match ? match.body : { ok: false, error: 'no_route', detail: `${method} ${url}` };
      return { ok: status < 400, status, json: async () => body };
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Settings → Integrations', () => {
  it.each(['facebook-pages', 'instagram', 'x', 'threads', 'tiktok', 'linkedin', 'linkedin-company', 'youtube', 'reddit'])('renders actual %s package setup in the generic provider card', async (id) => {
    const d = packageDescriptor(id);
    // The backend's real installer/registry integration tests the overview projection;
    // this browser test uses the package's actual descriptor and SDK setup view.
    serve({ providers: [{
      ...CHAT, id: d.id, displayName: d.displayName, capabilities: d.capabilities, datatypes: d.datatypes,
      requiredConfig: d.configSchema?.required ?? [],
      connectHref: `/api/oauth/start?plugin=${d.id}`,
      credentials: [], appRegistration: providerAppRegistrationView(d),
      oauthClient: { ...oauthClient(d.oauth!.clientRegistrationRef!, false), secretRequired: !d.oauth!.pkce,
        userAgentRequired: d.oauth!.userAgentRequired },
    }], sources: [] });
    render(<Page />);
    const card = within(await screen.findByRole('region', { name: d.displayName }));
    expect(card.getByRole('link', { name: `Create ${d.displayName} app` }).getAttribute('href')).toBe(d.setup!.appRegistration!.createUrl);
    expect((card.getByRole('button', { name: `Connect ${d.displayName}` }) as HTMLButtonElement).disabled).toBe(true);
    for (const capability of d.capabilities) expect(card.getByText(capability)).toBeTruthy();
    expect(card.getByLabelText('Client ID')).toBeTruthy();
    expect(card.getByLabelText('Client secret')).toBeTruthy();
    if (d.oauth!.userAgentRequired) expect((card.getByLabelText('User-Agent') as HTMLInputElement).value).toBe('');
    else expect(card.queryByLabelText('User-Agent')).toBeNull();
    expect(card.queryByRole('button', { name: 'What syncs' })).toBeNull();
  });

  it('binds actual Mastodon app setup to the selected instance before saving its registration', async () => {
    const d = packageDescriptor('mastodon');
    serve({ providers: [{
      ...CHAT, id: d.id, displayName: d.displayName, capabilities: d.capabilities, datatypes: d.datatypes,
      connectHref: `/api/oauth/start?plugin=${d.id}`, credentials: [], appRegistration: providerAppRegistrationView(d),
      oauthClient: { ...oauthClient(d.oauth!.clientRegistrationRef!, false), instanceRequired: d.oauth!.instance },
    }], sources: [] });
    const path = `/api/user/integrations/providers/${d.id}/oauth-client`;
    route('PUT', path, { ok: true });
    render(<Page />);
    const card = within(await screen.findByRole('region', { name: d.displayName }));
    expect(card.queryByRole('link', { name: 'Create Mastodon app' })).toBeNull();
    expect((card.getByRole('button', { name: 'Connect Mastodon' }) as HTMLButtonElement).disabled).toBe(true);
    for (const origin of ['https://mastodon.social', 'https://hachyderm.io']) {
      fireEvent.change(card.getByLabelText('Instance origin'), { target: { value: origin } });
      expect(card.getByRole('link', { name: 'Create Mastodon app' }).getAttribute('href')).toBe(`${origin}${d.setup!.appRegistration!.createUrl}`);
    }
    fireEvent.change(card.getByLabelText('Client ID'), { target: { value: 'instance-client' } });
    fireEvent.change(card.getByLabelText('Client secret'), { target: { value: 'instance-secret' } });
    fireEvent.click(card.getByRole('button', { name: 'Save OAuth app' }));
    await waitFor(() => expect(call('PUT', path)?.body).toEqual({
      origin: 'https://hachyderm.io', clientId: 'instance-client', clientSecret: 'instance-secret',
    }));
    expect((card.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
    expect(H.openExternal).not.toHaveBeenCalled();
  });

  it('saves the actual Bluesky app-password fields through the credential route without offering OAuth', async () => {
    const d = packageDescriptor('bluesky');
    const credentials = d.setup!.credentials!.map((field) => ({ ...field, configured: false, savedAt: null }));
    serve({ providers: [{
      ...CHAT, id: d.id, displayName: d.displayName, capabilities: d.capabilities, datatypes: d.datatypes,
      connectHref: null, credentials, appRegistration: providerAppRegistrationView(d), oauthClient: null,
    }], sources: [] });
    const path = `/api/user/integrations/providers/${d.id}/credentials`;
    route('PUT', path, { ok: true });
    render(<Page />);
    const card = within(await screen.findByRole('region', { name: d.displayName }));
    expect(card.getByRole('status').textContent).toBe('Needs 2 of 2 credentials');
    expect(card.queryByRole('button', { name: /^Connect/ })).toBeNull();
    expect(card.queryByLabelText('Client ID')).toBeNull();
    expect(card.queryByLabelText('Client secret')).toBeNull();
    const values = { identifier: 'fixture.bsky.social', app_password: 'fixture-app-password' };
    for (const field of credentials) {
      const input = card.getByLabelText(field.label) as HTMLInputElement;
      expect(input.type).toBe('password');
      expect(input.value).toBe('');
      fireEvent.change(input, { target: { value: values[field.key as keyof typeof values] } });
    }
    expect(card.getByRole('link', { name: 'Where to find it' }).getAttribute('href')).toBe('https://bsky.app/settings/app-passwords');
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(call('PUT', path)?.body).toEqual({ values }));
    await waitFor(() => {
      for (const field of credentials) expect((card.getByLabelText(field.label) as HTMLInputElement).value).toBe('');
    });
    expect(H.calls.filter((entry) => /oauth|createSession|refreshSession/.test(entry.url))).toEqual([]);
    expect(H.openExternal).not.toHaveBeenCalled();
  });

  it.each(['devto', 'hashnode', 'discord'])('saves the actual %s package credential through the generic card without OAuth', async (id) => {
    const d = packageDescriptor(id);
    const credentials = d.setup!.credentials!.map((field) => ({ ...field, configured: false, savedAt: null }));
    serve({ providers: [{
      ...CHAT, id: d.id, displayName: d.displayName, capabilities: d.capabilities, datatypes: d.datatypes,
      requiredConfig: d.configSchema?.required ?? [],
      connectHref: null, credentials, appRegistration: providerAppRegistrationView(d), oauthClient: null,
    }], sources: [] });
    const path = `/api/user/integrations/providers/${d.id}/credentials`;
    route('PUT', path, { ok: true });
    render(<Page />);
    const card = within(await screen.findByRole('region', { name: d.displayName }));
    expect(card.getByRole('status').textContent).toBe('Needs 1 of 1 credential');
    for (const capability of d.capabilities) expect(card.getByText(capability)).toBeTruthy();
    expect(card.queryByRole('button', { name: /^Connect/ })).toBeNull();
    expect(card.queryByLabelText('Client ID')).toBeNull();
    expect(card.queryByLabelText('Client secret')).toBeNull();
    expect(card.getByRole('link', { name: 'Where to find it' }).getAttribute('href')).toBe(credentials[0].helpUrl);
    const input = card.getByLabelText(credentials[0].label) as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(input.value).toBe('');
    fireEvent.change(input, { target: { value: 'fixture-provider-credential' } });
    fireEvent.click(card.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(call('PUT', path)?.body).toEqual({ values: { [credentials[0].key]: 'fixture-provider-credential' } }));
    await waitFor(() => expect(input.value).toBe(''));
    expect(H.calls.filter((entry) => /oauth|gql\.hashnode|dev\.to\/api|discord\.com/.test(entry.url))).toEqual([]);
    expect(H.openExternal).not.toHaveBeenCalled();
  });

  it('renders each provider from the overview and subscribes the live query as the resolved user', async () => {
    serve({ providers: [LINEAR, ASANA], sources: [source({ mirrored: 1, admitted: 0 })] });
    render(<Page />);

    await screen.findByText('Acme');
    expect(H.queryArgs.get('integrations.tickets')).toEqual({ userId: 'user-1' });
    expect(H.queryEnabled.get('integrations.tickets')).toBe(true);

    const linear = within(screen.getByRole('region', { name: 'Linear' }));
    expect(linear.getByRole('button', { name: 'Connect another account' })).toBeTruthy();
    expect(linear.getByText('Needs teams and a harness to store tickets in before it can sync.')).toBeTruthy();
    expect(linear.getByText(/1 ticket mirrored/)).toBeTruthy();

    const asana = within(screen.getByRole('region', { name: 'Asana' }));
    expect(asana.getByRole('button', { name: 'Connect Asana' })).toBeTruthy();
    expect(asana.getByText('No Asana account connected.')).toBeTruthy();
  });

  it('renders the live query over the first read once it answers', async () => {
    serve({ providers: [LINEAR], sources: [source()] });
    H.sync.set('integrations.tickets', [{ providers: [LINEAR], sources: [source({ accountLabel: 'Acme (live)' })], triggerPacks: [] }]);
    render(<Page />);

    expect(await screen.findByText('Acme (live)')).toBeTruthy();
    expect(screen.queryByText('Acme')).toBeNull();
  });

  it('shows the read failure when the overview cannot load', async () => {
    route('GET', API, { ok: false, error: 'ticket_integrations_failed', detail: 'database unavailable' }, 500);
    render(<Page />);
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn’t load integrations: database unavailable');
  });

  it('saves the chosen teams and harness through the config route', async () => {
    serve({ providers: [LINEAR], sources: [source()] });
    route('POST', `${API}/sources/src-1/containers`, {
      ok: true,
      truncated: false,
      containers: [
        { id: 'team-a', name: 'Engineering', kind: 'team', key: 'ENG' },
        { id: 'team-b', name: 'Design', kind: 'team', key: 'DES' },
      ],
    });
    route('PATCH', `${API}/sources/src-1/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'What syncs' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Engineering/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Design/ }));
    fireEvent.change(screen.getByLabelText('Harness to store tickets in'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(call('PATCH', `${API}/sources/src-1/config`)).toBeTruthy());
    expect(call('POST', `${API}/sources/src-1/containers`)?.body).toEqual({ args: {} });
    expect(call('PATCH', `${API}/sources/src-1/config`)?.body).toEqual({ patch: { harnessSlug: 'website', teamIds: ['team-a', 'team-b'] } });
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Saved. Linear syncs this account shortly.'));
  });

  it('falls back to id fields when the provider cannot list its containers', async () => {
    serve({ providers: [LINEAR], sources: [source()] });
    route(
      'POST',
      `${API}/sources/src-1/containers`,
      { ok: false, error: 'provider_capability_unsupported', detail: 'no ticket.containers' },
      409,
    );
    route('PATCH', `${API}/sources/src-1/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'What syncs' }));
    await screen.findByText('Linear can’t list its teams or projects here, so enter their ids.');
    fireEvent.change(screen.getByLabelText('Teams'), { target: { value: 'team-a, team-b' } });
    fireEvent.change(screen.getByLabelText('Harness to store tickets in'), { target: { value: 'website' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(call('PATCH', `${API}/sources/src-1/config`)?.body).toEqual({
        patch: { harnessSlug: 'website', teamIds: ['team-a', 'team-b'] },
      }),
    );
  });

  it('keeps only the chosen workspace’s projects', async () => {
    const asana = source({
      id: 'src-2',
      provider: 'asana',
      accountLabel: 'Acme Asana',
      config: { workspaceGid: 'ws-1', projectGids: ['p-1'], harnessSlug: 'website' },
      missingConfig: [],
    });
    serve({ providers: [ASANA], sources: [asana] });
    route('POST', `${API}/sources/src-2/containers`, {
      ok: true,
      truncated: false,
      containers: [
        { id: 'ws-1', name: 'Acme', kind: 'workspace' },
        { id: 'ws-2', name: 'Side project', kind: 'workspace' },
        { id: 'p-1', name: 'Website', kind: 'project', parentId: 'ws-1' },
        { id: 'p-2', name: 'Mobile', kind: 'project', parentId: 'ws-2' },
      ],
    });
    route('PATCH', `${API}/sources/src-2/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-2')).getByRole('button', { name: 'What syncs' }));
    expect((await screen.findByRole('checkbox', { name: /Website/ })).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('checkbox', { name: /Mobile/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'ws-2' } });
    expect(screen.queryByRole('checkbox', { name: /Website/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: /Mobile/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(call('PATCH', `${API}/sources/src-2/config`)?.body).toEqual({
        patch: { harnessSlug: 'website', workspaceGid: 'ws-2', projectGids: ['p-2'] },
      }),
    );
  });

  it('maps sections onto canonical columns where the provider has sections, and says why there is nothing to map otherwise', async () => {
    const asana = source({
      id: 'src-2',
      provider: 'asana',
      accountLabel: 'Acme Asana',
      config: { workspaceGid: 'ws-1', projectGids: ['p-1'], harnessSlug: 'website', sectionCategories: { 'sec-todo': 'todo' } },
      missingConfig: [],
    });
    serve({ providers: [LINEAR, ASANA], sources: [source(), asana] });
    route('POST', /\/sources\/src-[12]\/containers$/, {
      ok: true,
      truncated: false,
      containers: [
        { id: 'ws-1', name: 'Acme', kind: 'workspace' },
        {
          id: 'p-1',
          name: 'Website',
          kind: 'project',
          parentId: 'ws-1',
          sections: [
            { id: 'sec-todo', name: 'To do' },
            { id: 'sec-doing', name: 'Doing' },
          ],
        },
      ],
    });
    route('PATCH', `${API}/sources/src-2/config`, { ok: true, config: {}, missingConfig: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Status mapping' }));
    expect(await screen.findByText(/Linear decides each ticket’s column from its own workflow-state types/)).toBeTruthy();

    fireEvent.click((await row('src-2')).getByRole('button', { name: 'Status mapping' }));
    const doing = (await screen.findByLabelText('Column for Doing')) as HTMLSelectElement;
    expect(doing.value).toBe('default');
    expect((screen.getByLabelText('Column for To do') as HTMLSelectElement).value).toBe('todo');
    fireEvent.change(doing, { target: { value: 'in-progress' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save mapping' }));

    await waitFor(() =>
      expect(call('PATCH', `${API}/sources/src-2/config`)?.body).toEqual({
        patch: { sectionCategories: { 'sec-todo': 'todo', 'sec-doing': 'in-progress' } },
      }),
    );
  });

  it('adds a preset rule into a harness other than the source’s, and disables a rule', async () => {
    const rule = {
      id: 'rule-1',
      title: 'Delegated to Papercusp',
      harness: 'papercusp',
      workKind: 'change',
      enabled: true,
    };
    serve({
      providers: [LINEAR],
      sources: [source({ config: { accountLabel: 'Acme', teamIds: ['team-a'], harnessSlug: 'website' }, missingConfig: [], rules: [rule] })],
    });
    route('POST', `${API}/sources/src-1/containers`, { ok: true, truncated: false, containers: [] });
    route('POST', `${API}/sources/src-1/rules`, {
      ok: true,
      rule: { ...rule, id: 'rule-2' },
      backfill: { scanned: 3, admitted: 2, existing: 0, refused: [], truncated: false },
    });
    route('DELETE', `${API}/sources/src-1/rules/rule-1`, { ok: true, rule: { ...rule, enabled: false } });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Rules (1)' }));
    const rules = within(await screen.findByRole('list', { name: 'Admission rules' }));
    expect(rules.getByText('Delegated to Papercusp')).toBeTruthy();
    expect(rules.getByText('Change in papercusp')).toBeTruthy();
    expect((screen.getByLabelText('Target harness') as HTMLSelectElement).value).toBe('website');

    fireEvent.change(screen.getByLabelText('Rule'), { target: { value: 'label' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'needs-agent' } });
    fireEvent.change(screen.getByLabelText('Work kind'), { target: { value: 'task' } });
    fireEvent.change(screen.getByLabelText('Target harness'), { target: { value: 'papercusp' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() =>
      expect(call('POST', `${API}/sources/src-1/rules`)?.body).toEqual({
        preset: 'label',
        value: 'needs-agent',
        harness: 'papercusp',
        workKind: 'task',
      }),
    );
    await waitFor(() => expect(H.toast.success).toHaveBeenCalledWith('Rule added. 2 synced tickets admitted as work.'));

    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(call('DELETE', `${API}/sources/src-1/rules/rule-1`)).toBeTruthy());
  });

  it('counts a backfilled ticket the intake attached to an already-filed bug as admitted', async () => {
    serve({ providers: [LINEAR], sources: [source({ config: { harnessSlug: 'website' }, missingConfig: [] })] });
    route('POST', `${API}/sources/src-1/containers`, { ok: true, truncated: false, containers: [] });
    route('POST', `${API}/sources/src-1/rules`, {
      ok: true,
      rule: { id: 'rule-3', title: 'Label needs-agent', harness: 'website', workKind: 'bug', enabled: true },
      backfill: { scanned: 3, admitted: 1, folded: 1, existing: 1, refused: [], truncated: false },
    });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Rules (0)' }));
    fireEvent.change(await screen.findByLabelText('Rule'), { target: { value: 'label' } });
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'needs-agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() =>
      expect(H.toast.success).toHaveBeenCalledWith(
        'Rule added. 2 synced tickets admitted as work (1 attached to a bug that was already filed).',
      ),
    );
  });

  it('refuses a value-taking preset with no value without calling the route', async () => {
    serve({ providers: [LINEAR], sources: [source({ config: { harnessSlug: 'website' }, missingConfig: ['teamIds'] })] });
    route('POST', `${API}/sources/src-1/containers`, { ok: true, truncated: false, containers: [] });
    render(<Page />);

    fireEvent.click((await row('src-1')).getByRole('button', { name: 'Rules (0)' }));
    fireEvent.change(await screen.findByLabelText('Rule'), { target: { value: 'project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));

    await waitFor(() => expect(H.toast.error).toHaveBeenCalledWith('Enter a project for this rule.'));
    expect(call('POST', `${API}/sources/src-1/rules`)).toBeUndefined();
  });

  it('opens a provider’s sign-in in the system browser on desktop', async () => {
    H.desktop = true;
    serve({ providers: [LINEAR], sources: [] });
    route('GET', /^\/api\/oauth\/start\?/, { ok: true, authorizationUrl: 'https://linear.app/oauth/authorize?state=s' });
    render(<Page />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

    await waitFor(() => expect(H.openExternal).toHaveBeenCalledWith('https://linear.app/oauth/authorize?state=s'));
    const start = new URL(H.calls.find((c) => c.url.startsWith('/api/oauth/start'))!.url, 'http://localhost');
    expect(Object.fromEntries(start.searchParams)).toEqual({ provider: 'linear', return: '/settings/integrations', response: 'json' });
    expect(H.toast.success).toHaveBeenCalledWith(expect.stringContaining('Linear sign-in opened in your browser'));
  });

  it('refuses to open a non-https authorization URL', async () => {
    H.desktop = true;
    serve({ providers: [LINEAR], sources: [] });
    route('GET', /^\/api\/oauth\/start\?/, { ok: true, authorizationUrl: 'http://linear.example/oauth/authorize' });
    render(<Page />);

    fireEvent.click(await screen.findByRole('button', { name: 'Connect Linear' }));

    await waitFor(() =>
      expect(H.toast.error).toHaveBeenCalledWith(
        'Couldn’t start Linear sign-in: the OAuth server returned an unsafe authorization URL',
      ),
    );
    expect(H.openExternal).not.toHaveBeenCalled();
  });
});

describe('every installed integration and workflow (P-005)', () => {
  it('gives a credentials-only provider a card with its status, and no sign-in button or ticket sources', async () => {
    serve({ providers: [CHAT], sources: [] });
    render(<Page />);

    const card = await waitFor(() => {
      const found = document.querySelector('[data-provider="chatter"]');
      if (!found) throw new Error('chatter card is not rendered');
      return within(found as HTMLElement);
    });
    expect(card.getByRole('heading', { name: 'Chatter' })).toBeTruthy();
    expect(card.getByText('Needs 1 of 1 credential')).toBeTruthy();
    expect(card.queryByRole('button', { name: /^Connect/ })).toBeNull();
    expect(card.getByText('No Chatter account connected.')).toBeTruthy();
  });

  it('lists the source saved credentials created (D-006) with its status, and none of the ticket controls', async () => {
    serve({
      providers: [CHAT],
      sources: [source({ id: 'src-chat', provider: 'chatter', providerAccountId: 'provider-setup:chatter', accountLabel: null, config: {}, missingConfig: [] })],
    });
    render(<Page />);

    const row = await waitFor(() => {
      const found = document.querySelector('[data-provider="chatter"] [data-source="src-chat"]');
      if (!found) throw new Error('chatter source row is not rendered');
      return within(found as HTMLElement);
    });
    expect(row.getByText('Saved credentials')).toBeTruthy();
    expect(row.getByText(/connected/)).toBeTruthy();
    // Ticket-only metrics and panels, and an OAuth reconnect, have no meaning for this provider.
    expect(row.queryByText(/mirrored/)).toBeNull();
    expect(row.queryByRole('button', { name: 'What syncs' })).toBeNull();
    expect(row.queryByRole('button', { name: /^Rules/ })).toBeNull();
    expect(row.queryByRole('button', { name: 'Reconnect' })).toBeNull();
  });

  it('saves a workflow’s settings through the inputs route, and blocks arming until they are saved', async () => {
    serve({ providers: [], sources: [], triggerPacks: [pack()] });
    route('PUT', '/api/user/integrations/trigger-packs/pack-1/inputs', { ok: true, installationId: 'pack-1', status: 'configured', unmet: [], armed: false });
    render(<Page />);

    const section = await packSection('intake-pack');
    expect(section.getByText('message.posted')).toBeTruthy();
    expect(section.getByText('triage')).toBeTruthy();
    const arm = section.getByRole('button', { name: 'Arm intake-pack' }) as HTMLButtonElement;
    expect(arm.disabled).toBe(false);

    fireEvent.change(section.getByLabelText('Project (required)'), { target: { value: 'P2' } });
    fireEvent.click(section.getByLabelText('Notify'));
    fireEvent.change(section.getByLabelText('Priority'), { target: { value: 'urgent' } });
    expect(arm.disabled).toBe(true);
    fireEvent.click(section.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(call('PUT', '/api/user/integrations/trigger-packs/pack-1/inputs')?.body).toEqual({ inputs: { project: 'P2', notify: true, priority: 'urgent' } }),
    );
    expect(H.toast.success).toHaveBeenCalledWith(expect.stringContaining('intake-pack settings saved'));
  });

  it('arms a workflow against the review fingerprint on screen, and will not arm one that still needs setup', async () => {
    const needsSetup = pack({
      installationId: 'pack-2',
      pluginName: 'other-pack',
      unmet: [{ bindingId: 'inputs', reason: 'inputs-invalid', requirement: { kind: 'inputs', errors: ['project is required'] }, candidates: [] }],
    });
    serve({ providers: [], sources: [], triggerPacks: [pack(), needsSetup] });
    route('POST', '/api/user/integrations/trigger-packs/pack-1/arm', { ok: true, installationId: 'pack-1', fingerprint: 'fp-pack-1', armedBindingIds: ['b1'] });
    render(<Page />);

    const blocked = await packSection('other-pack');
    expect(blocked.getByText('Settings: project is required')).toBeTruthy();
    expect((blocked.getByRole('button', { name: 'Arm other-pack' }) as HTMLButtonElement).disabled).toBe(true);

    const ready = await packSection('intake-pack');
    fireEvent.click(ready.getByRole('button', { name: 'Arm intake-pack' }));
    await waitFor(() => expect(call('POST', '/api/user/integrations/trigger-packs/pack-1/arm')?.body).toEqual({ fingerprint: 'fp-pack-1' }));
    expect(H.toast.success).toHaveBeenCalledWith('intake-pack armed: 1 trigger on.');
    expect(H.calls.some((c) => c.url.includes('pack-2/arm'))).toBe(false);
  });
});
