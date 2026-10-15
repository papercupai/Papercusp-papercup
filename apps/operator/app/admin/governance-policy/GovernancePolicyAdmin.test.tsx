// @vitest-environment jsdom
/**
 * GovernancePolicyAdmin.test.tsx — render-tier coverage for the /admin/governance-policy pane
 * (plan papercusp-enterprise-readiness-roadmap-2026-10-09 P-005, WI-6554700010011434).
 * Covers: the effective chain; explaining a denial (decidedBy + trace); preview-before-apply
 * (Apply stays disabled until the CURRENT draft is previewed, and needs a reason); the
 * "a lower layer cannot widen an ancestor's refusal" preview note; a refused save surfacing as
 * an error; expiring exceptions (active vs expired, and the add-exception post); version history.
 * `@papercusp/sync` is mocked to feed one state payload; `Select` is a native select.
 */
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { GovernancePolicyState } from '@papercusp/operator-core/lib/governance-policy/control';
import type { StoredPolicyLayer } from '@papercusp/operator-core/lib/governance-policy/store';

const { sync, toast } = vi.hoisted(() => ({
  sync: { payload: null as GovernancePolicyState | null, loading: false, error: null as unknown },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({ data: sync.payload ? [sync.payload] : [], loading: sync.loading, error: sync.error }),
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
  }: {
    value: string;
    onChange: (v: string) => void;
    options: { value: string; label: string }[];
    ariaLabel?: string;
  }) => (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));

import GovernancePolicyAdmin, {
  isExceptionActive,
  parseRequestLines,
  rulesFromDraft,
  simulationNote,
} from './GovernancePolicyAdmin';

const CATEGORIES = ['models', 'tools', 'plugins', 'egress', 'dataUse', 'actions'] as const;
const FUTURE = new Date(Date.now() + 7 * 86_400_000).toISOString();
const PAST = new Date(Date.now() - 7 * 86_400_000).toISOString();

function layer(over: Partial<StoredPolicyLayer>): StoredPolicyLayer {
  return {
    layerId: 'org',
    level: 'organization',
    version: 1,
    rules: {},
    exceptions: [],
    scopeRef: 'acme',
    parentLayerId: null,
    contentHash: 'abcdef0123456789',
    updatedBy: 'admin:avi',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  };
}

const ORG = layer({
  rules: { tools: { deny: ['capability:bash'] } },
  exceptions: [
    { category: 'tools', pattern: 'plans:*', reason: 'pilot', expiresAt: FUTURE },
    { category: 'tools', pattern: 'git:*', reason: 'old', expiresAt: PAST },
  ],
});
const WS = layer({
  layerId: 'ws-a',
  level: 'workspace',
  scopeRef: 'ws-a',
  parentLayerId: 'org',
  rules: { tools: { allow: ['capability:bash', 'work_items:*'] } },
});

function state(over: Partial<GovernancePolicyState> = {}): GovernancePolicyState {
  return {
    workspaceId: 'ws-a',
    load: 'ok',
    reason: null,
    chain: [ORG, WS],
    revision: 'org@v1>ws-a@v1',
    layers: [ORG, WS],
    versions: {
      'ws-a': [
        {
          layerId: 'ws-a',
          version: 1,
          level: 'workspace',
          scopeRef: 'ws-a',
          parentLayerId: 'org',
          rules: WS.rules,
          exceptions: [],
          contentHash: 'deadbeefcafe00',
          actor: 'admin:avi',
          reason: 'initial pilot policy',
          recordedAt: '2026-10-13T00:00:00.123Z',
        },
      ],
    },
    historyTruncated: false,
    categories: CATEGORIES,
    levels: ['organization', 'department', 'workspace'],
    dataClasses: [{ label: 'class:pii', class: 'pii', description: 'Personal data about a person.' }],
    generatedAt: '2026-10-14T00:00:00Z',
    ...over,
  };
}

const fetchMock = vi.fn();
function reply(body: Record<string, unknown>, status = 200) {
  fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });
}
function bodyOf(call: number): Record<string, unknown> {
  return JSON.parse(String((fetchMock.mock.calls[call]?.[1] as RequestInit).body)) as Record<string, unknown>;
}
function renderAt(search: string): ReturnType<typeof render> {
  const ui: ReactElement = (
    <NuqsTestingAdapter searchParams={search}>
      <GovernancePolicyAdmin />
    </NuqsTestingAdapter>
  );
  return render(ui);
}

const DENY_VERDICT = {
  allow: false,
  code: 'org_policy:denied',
  reason: 'organization policy org v1 denies tools',
  decidedBy: { layerId: 'org', level: 'organization', version: 1, category: 'tools', value: 'capability:bash', outcome: 'deny-rule', pattern: 'capability:bash' },
  trace: [{ layerId: 'org', level: 'organization', version: 1, category: 'tools', value: 'capability:bash', outcome: 'deny-rule', pattern: 'capability:bash' }],
};

beforeEach(() => {
  sync.payload = state();
  sync.loading = false;
  sync.error = null;
  fetchMock.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GovernancePolicyAdmin — inherited policy admin pane (P-005)', () => {
  it('shows loading and error states', () => {
    sync.payload = null;
    sync.loading = true;
    renderAt('');
    expect(screen.getByText(/Loading governance policy/)).toBeTruthy();
    cleanup();
    sync.loading = false;
    sync.error = new Error('boom');
    renderAt('');
    expect(screen.getByText(/Failed to load the governance policy/)).toBeTruthy();
  });

  it('renders the effective chain root first with rules and exception status', () => {
    renderAt('');
    expect(screen.getByTestId('gp-load-status').getAttribute('data-load')).toBe('ok');
    expect(screen.getByText('Chain: org@v1>ws-a@v1')).toBeTruthy();
    expect(screen.getByTestId('gp-chain-layer-org').textContent).toContain('tools: no allow list · deny capability:bash');
    expect(screen.getByTestId('gp-chain-layer-org').textContent).toContain('Exceptions: 1 active, 1 expired');
    expect(screen.getByTestId('gp-chain-layer-ws-a').textContent).toContain('allow only capability:bash, work_items:*');
  });

  it('explains a denial: the deciding layer and the trace come from the server', async () => {
    reply({ ok: true, workspaceId: 'ws-a', governed: true, verdict: DENY_VERDICT, explanation: 'Refused: organization policy org v1 denies tools.', revision: 'org@v1>ws-a@v1' });
    renderAt('?tab=explain');
    fireEvent.change(screen.getByTestId('gp-explain-values'), { target: { value: 'capability:bash' } });
    fireEvent.click(screen.getByTestId('gp-explain-submit'));
    await waitFor(() => expect(screen.getByTestId('gp-explain-result')).toBeTruthy());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/governance-policy/explain');
    expect(bodyOf(0)).toEqual({ workspaceId: 'ws-a', request: { tools: ['capability:bash'] } });
    expect(screen.getByTestId('gp-explain-result').getAttribute('data-allow')).toBe('false');
    expect(screen.getByText(/Decided by organization org v1: deny-rule \(capability:bash\)/)).toBeTruthy();
  });

  it('requires a preview of the CURRENT draft and a reason before Apply; records reason + expectedVersion', async () => {
    renderAt('?tab=edit&layer=ws-a');
    const apply = screen.getByTestId('gp-apply') as HTMLButtonElement;
    fireEvent.change(screen.getByTestId('gp-reason'), { target: { value: 'tighten for pilot' } });
    expect(apply.disabled).toBe(true);

    reply({
      ok: true,
      workspaceId: 'ws-a',
      validation: null,
      affectsWorkspace: true,
      note: null,
      proposedVersion: 2,
      proposedRevision: 'org@v1>ws-a@v2',
      changedCount: 0,
      cases: [{ request: { tools: ['capability:bash'] }, before: DENY_VERDICT, after: DENY_VERDICT, changed: false, decidedByAncestor: true }],
    });
    fireEvent.click(screen.getByTestId('gp-simulate'));
    await waitFor(() => expect(screen.getByTestId('gp-sim-result')).toBeTruthy());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/governance-policy/simulate');
    expect(bodyOf(0)).toMatchObject({
      workspaceId: 'ws-a',
      proposed: { layerId: 'ws-a', level: 'workspace', parentLayerId: 'org', rules: { tools: { allow: ['capability:bash', 'work_items:*'] } } },
      requests: [{ tools: ['capability:bash'] }],
    });
    expect(screen.getByText('Still refused by organization org: a lower layer cannot widen it')).toBeTruthy();
    expect(apply.disabled).toBe(false);

    // Editing the draft after the preview invalidates it.
    fireEvent.change(screen.getByLabelText('tools deny'), { target: { value: 'plans:*' } });
    expect(apply.disabled).toBe(true);
    reply({ ok: true, workspaceId: 'ws-a', validation: null, affectsWorkspace: true, note: null, proposedVersion: 2, proposedRevision: 'org@v1>ws-a@v2', changedCount: 0, cases: [] });
    fireEvent.click(screen.getByTestId('gp-simulate'));
    await waitFor(() => expect(apply.disabled).toBe(false));

    reply({ ok: true, op: 'set', revision: 'ws-a@v2' });
    fireEvent.click(apply);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/governance-policy/set');
    expect(bodyOf(2)).toMatchObject({
      layerId: 'ws-a',
      reason: 'tighten for pilot',
      expectedVersion: 1,
      rules: { tools: { allow: ['capability:bash', 'work_items:*'], deny: ['plans:*'] } },
    });
  });

  it('surfaces a refused save (stale version) as an error, never a success', async () => {
    renderAt('?tab=edit&layer=ws-a');
    reply({ ok: true, workspaceId: 'ws-a', validation: null, affectsWorkspace: true, note: null, proposedVersion: 2, proposedRevision: null, changedCount: 0, cases: [] });
    fireEvent.click(screen.getByTestId('gp-simulate'));
    await waitFor(() => expect(screen.getByTestId('gp-sim-result')).toBeTruthy());
    fireEvent.change(screen.getByTestId('gp-reason'), { target: { value: 'tighten' } });
    reply({ ok: false, op: 'set', code: 'conflict', error: 'layer ws-a is at v3' }, 409);
    fireEvent.click(screen.getByTestId('gp-apply'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('blocks Apply when the server says the proposal is invalid', async () => {
    renderAt('?tab=edit&layer=ws-a');
    reply({ ok: true, workspaceId: 'ws-a', validation: 'exceptions[0].expiresAt must be an absolute ISO-8601 time', affectsWorkspace: true, note: null, proposedVersion: 2, proposedRevision: null, changedCount: 0, cases: [] });
    fireEvent.click(screen.getByTestId('gp-simulate'));
    await waitFor(() => expect(screen.getByTestId('gp-sim-invalid')).toBeTruthy());
    fireEvent.change(screen.getByTestId('gp-reason'), { target: { value: 'tighten' } });
    expect((screen.getByTestId('gp-apply') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lists exceptions as active or expired and posts a new one with an absolute expiry', async () => {
    renderAt('?tab=exceptions&layer=org');
    const rows = screen.getAllByTestId('gp-exception-row');
    expect(rows.map((r) => r.getAttribute('data-active'))).toEqual(['true', 'false']);
    expect(rows[1]?.textContent).toContain('expired, grants nothing');

    reply({ ok: true, op: 'add-exception', revision: 'org@v2' });
    fireEvent.change(screen.getByTestId('gp-exception-pattern'), { target: { value: 'capability:bash' } });
    fireEvent.change(screen.getByTestId('gp-exception-reason'), { target: { value: 'incident 42' } });
    fireEvent.change(screen.getByTestId('gp-exception-expires'), { target: { value: '2030-01-01T09:30' } });
    fireEvent.click(screen.getByTestId('gp-exception-add'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const body = bodyOf(0);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/governance-policy/add-exception');
    expect(body).toMatchObject({ layerId: 'org', expectedVersion: 1, exception: { category: 'tools', pattern: 'capability:bash', reason: 'incident 42' } });
    expect(String((body.exception as { expiresAt: string }).expiresAt)).toMatch(/^2030-01-01T\d\d:30:00\.000Z$/);
  });

  it('shows the version history with actor and reason', () => {
    renderAt('?tab=history&layer=ws-a');
    expect(screen.getByText('initial pilot policy')).toBeTruthy();
    expect(screen.getByText('2026-10-13 00:00:00Z')).toBeTruthy();
  });
});

describe('GovernancePolicyAdmin helpers', () => {
  it('parseRequestLines builds one request per line and names a bad line', () => {
    expect(parseRequestLines('tools: capability:bash, plans:get\n\nmodels: gpt-x', CATEGORIES)).toEqual({
      ok: true,
      requests: [{ tools: ['capability:bash', 'plans:get'] }, { models: ['gpt-x'] }],
    });
    expect(parseRequestLines('shells: bash', CATEGORIES)).toMatchObject({ ok: false, error: expect.stringContaining('line 1') });
    expect(parseRequestLines('tools:', CATEGORIES)).toMatchObject({ ok: false });
    expect(parseRequestLines('  ', CATEGORIES)).toMatchObject({ ok: false });
  });

  it('rulesFromDraft treats a blank allow field as no allow list, not allow-nothing', () => {
    expect(rulesFromDraft(CATEGORIES, { tools: { allow: '', deny: 'a, b, a' }, models: { allow: '', deny: '' } })).toEqual({
      tools: { deny: ['a', 'b'] },
    });
  });

  it('isExceptionActive needs a valid future expiry', () => {
    const now = Date.parse('2026-10-14T00:00:00Z');
    expect(isExceptionActive({ category: 'tools', pattern: 'x', reason: 'r', expiresAt: '2026-10-15T00:00:00Z' }, now)).toBe(true);
    expect(isExceptionActive({ category: 'tools', pattern: 'x', reason: 'r', expiresAt: '2026-10-13T00:00:00Z' }, now)).toBe(false);
    expect(isExceptionActive({ category: 'tools', pattern: 'x', reason: 'r' }, now)).toBe(false);
    expect(isExceptionActive({ category: 'tools', pattern: 'x', reason: 'r', expiresAt: 'soon' }, now)).toBe(false);
  });

  it('simulationNote distinguishes ancestor refusal, change and no change', () => {
    const allow = { allow: true as const, trace: [] };
    expect(simulationNote({ request: {}, before: allow, after: allow, changed: false, decidedByAncestor: false })).toBe('No change');
    expect(simulationNote({ request: {}, before: allow, after: DENY_VERDICT as never, changed: true, decidedByAncestor: false })).toBe('Would become refused');
  });
});
