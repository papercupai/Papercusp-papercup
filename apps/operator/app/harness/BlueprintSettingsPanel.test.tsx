// @vitest-environment jsdom
/**
 * BlueprintSettingsPanel.test.tsx — render-tier coverage for the schema-driven
 * per-harness settings panel (whole-app-test-coverage-breadth). The blueprint
 * params module is mocked so the test controls the exact ParamViews
 * (resolveParamViews) and the save validation result (validateParamPatch /
 * applyParamPatch). useSyncQuery (config.json mirror) and sonner are mocked;
 * the two heavy children (SavedPromptsSection, HarnessPluginsSection) are
 * stubbed. fetch is stubbed for the blueprint-params load + the /spec PUT.
 *
 * Covered branches: loading (params not yet loaded), the no-params empty state
 * (with/without a blueprintId), grouped param rendering + control-by-type,
 * editing a text param → dirty save bar → successful save (toast.success), and
 * a validation failure → toast.error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import type { ReactElement } from 'react';

/* ── Mocks ─────────────────────────────────────────────────────────── */
let syncResult: { data: unknown[] | undefined; loading?: boolean; error?: Error | null };
const invalidateConfig = vi.fn();
vi.mock('@papercusp/sync', () => ({
  onSyncBusEvent: () => () => {},
  useSyncQuery: () => ({ loading: false, error: null, ...syncResult, fetching: false, invalidate: invalidateConfig }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/use-workspace-id', () => ({ useWorkspaceId: () => 'ws-test' }));
// Heavy children — out of scope for this panel's own logic.
vi.mock('./SavedPromptsSection', () => ({ default: () => <div data-testid="saved-prompts" /> }));
vi.mock('./HarnessPluginsSection', () => ({ default: () => <div data-testid="plugins-section" /> }));
vi.mock('./IntegrationModeSection', () => ({
  default: ({ slug }: { slug: string }) => <div data-testid="integration-mode-section-mount">{slug}</div>,
}));

// The blueprint-params engine — fully mocked so we drive views + validation.
let mockViews: Array<{ key: string; spec: Record<string, unknown>; value: unknown; overridden: boolean }>;
let mockValidate: { ok: boolean; errors: { key: string; error: string }[]; unknownKeys: string[]; patch: Record<string, unknown> };
vi.mock('@papercusp/orchestrator/blueprint/params', () => ({
  resolveParamViews: () => mockViews,
  validateParamPatch: () => mockValidate,
  applyParamPatch: (cfg: Record<string, unknown>, _params: unknown, patch: Record<string, unknown>) => ({ ...cfg, ...patch }),
}));

import { toast } from 'sonner';
import BlueprintSettingsPanel from './BlueprintSettingsPanel';

/* ── Helpers ───────────────────────────────────────────────────────── */
function renderPanel(ui: ReactElement, searchParams = '') {
  return render(<NuqsTestingAdapter searchParams={searchParams}>{ui}</NuqsTestingAdapter>);
}

/** Drive the on-mount /blueprint-params fetch result. */
function stubBlueprintParamsFetch(body: { blueprintId?: string | null; params?: Record<string, unknown> }) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/blueprint-params')) {
      return new Response(JSON.stringify(body), { status: 200 });
    }
    // /spec PUT and anything else → ok.
    return new Response('{"ok":true}', { status: 200 });
  }));
}

beforeEach(() => {
  syncResult = { data: [] };
  mockViews = [];
  mockValidate = { ok: true, errors: [], unknownKeys: [], patch: {} };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('BlueprintSettingsPanel (schema-driven per-harness settings)', () => {
  it('shows the loading state until the blueprint params resolve', () => {
    // fetch never resolves → paramsLoaded stays false.
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    renderPanel(<BlueprintSettingsPanel slug="my-harness" phase="production" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });

  it('renders the no-params empty state with the blueprint name once loaded', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: {} });
    renderPanel(<BlueprintSettingsPanel slug="my-harness" phase="production" />);
    await waitFor(() => expect(screen.getByText(/declares no tunable settings/i)).toBeTruthy());
    // Header references the blueprint id.
    expect(screen.getByText('coding')).toBeTruthy();
    // No-params → no save bar.
    expect(screen.queryByRole('button', { name: /^Save$/ })).toBeNull();
  });

  it('notes the missing blueprint.yaml when there is no blueprintId', async () => {
    stubBlueprintParamsFetch({ blueprintId: null, params: {} });
    renderPanel(<BlueprintSettingsPanel slug="bare" phase="staging" />);
    await waitFor(() => expect(screen.getByText(/no blueprint\.yaml found/i)).toBeTruthy());
  });

  it('renders grouped params with the right control per type', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { a: {}, b: {}, c: {} } });
    mockViews = [
      { key: 'worker.count', spec: { type: 'number', label: 'Worker count', group: 'Workers' }, value: 3, overridden: false },
      { key: 'worker.flag', spec: { type: 'boolean', label: 'Enable flag', group: 'Workers' }, value: true, overridden: true },
      { key: 'model.name', spec: { type: 'string', label: 'Model', group: 'Model' }, value: 'opus', overridden: false },
    ];
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText('Worker count')).toBeTruthy());
    // Two groups render as <h2> section headings.
    expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Model' })).toBeTruthy();
    // boolean → a checkbox with the spec label as aria-label.
    expect(screen.getByRole('checkbox', { name: 'Enable flag' })).toBeTruthy();
    // string → a textbox seeded with the value.
    const text = screen.getByDisplayValue('opus');
    expect(text).toBeTruthy();
  });

  it('renders a secret param as a credential-store note (no input)', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { tok: {} } });
    mockViews = [
      { key: 'api.token', spec: { type: 'string', label: 'API token', secret: true, group: 'Secrets' }, value: undefined, overridden: false },
    ];
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText(/set via the credential store/i)).toBeTruthy());
  });

  it('editing a param arms the save bar and a successful save toasts success', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { m: {} } });
    mockViews = [
      { key: 'model.name', spec: { type: 'string', label: 'Model', group: 'Model' }, value: 'opus', overridden: false },
    ];
    mockValidate = { ok: true, errors: [], unknownKeys: [], patch: { 'model.name': 'sonnet' } };
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByDisplayValue('opus')).toBeTruthy());

    // No edits yet → Save disabled.
    const saveBtn = () => screen.getByRole('button', { name: /^Save$|^Saving…$/ }) as HTMLButtonElement;
    expect(saveBtn().disabled).toBe(true);

    fireEvent.change(screen.getByDisplayValue('opus'), { target: { value: 'sonnet' } });
    // Dirty → the unsaved-change pill + enabled Save.
    expect(screen.getByText(/unsaved change/i)).toBeTruthy();
    expect(saveBtn().disabled).toBe(false);

    fireEvent.click(saveBtn());
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved'));
  });

  it('a validation failure on save toasts an error and does not clear edits', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { m: {} } });
    mockViews = [
      { key: 'worker.count', spec: { type: 'number', label: 'Worker count', group: 'Workers' }, value: 1, overridden: false },
    ];
    mockValidate = { ok: false, errors: [{ key: 'worker.count', error: 'out of range' }], unknownKeys: [], patch: {} };
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByText('Worker count')).toBeTruthy());

    // Edit the number control to dirty the form.
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Some settings are invalid'));
    // The per-field error is rendered.
    expect(screen.getByText(/out of range/)).toBeTruthy();
  });

  it('always mounts the saved-prompts and plugins sections', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: {} });
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByTestId('saved-prompts')).toBeTruthy());
    expect(screen.getByTestId('plugins-section')).toBeTruthy();
  });

  it('withholds denied blueprint settings and retries the schema read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"forbidden","params":{"m":{}}}', { status: 403 }))
      .mockResolvedValueOnce(new Response('{"blueprintId":"research","params":{}}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    mockViews = [{ key: 'm', spec: { type: 'string', label: 'Model' }, value: 'denied-model', overridden: false }];
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('HTTP 403'));
    expect(screen.queryByDisplayValue('denied-model')).toBeNull();
    expect(screen.queryByText(/declares no tunable settings/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry settings' }));
    await waitFor(() => expect(screen.getByText('research')).toBeTruthy());
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      '/api/harness/h/blueprint-params?phase=production', '/api/harness/h/blueprint-params?phase=production',
    ]);
  });

  it('waits for the saved config before editing and preserves unrelated fields on save', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { m: {} } });
    mockViews = [{ key: 'm', spec: { type: 'string', label: 'Model' }, value: 'initial', overridden: false }];
    mockValidate = { ok: true, errors: [], unknownKeys: [], patch: { m: 'edited' } };
    syncResult = { data: undefined, loading: true };
    const panel = renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(screen.queryByDisplayValue('initial')).toBeNull();
    expect(screen.getByText('Loading…')).toBeTruthy();
    syncResult = { data: [{ config: '{"unrelated":{"keep":true},"m":"initial"}' }], loading: false };
    panel.rerender(<NuqsTestingAdapter><BlueprintSettingsPanel slug="h" phase="production" /></NuqsTestingAdapter>);
    await waitFor(() => expect(screen.getByDisplayValue('initial')).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('initial'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved'));
    const put = vi.mocked(fetch).mock.calls.find(c => c[1]?.method === 'PUT')!;
    expect(JSON.parse(JSON.parse(String(put[1]!.body)).config)).toEqual({ unrelated: { keep: true }, m: 'edited' });
  });

  it('clears previous saved config when the authoritative mirror becomes empty', async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: { m: {} } });
    mockViews = [{ key: 'm', spec: { type: 'string', label: 'Model' }, value: 'initial', overridden: false }];
    mockValidate = { ok: true, errors: [], unknownKeys: [], patch: { m: 'edited' } };
    syncResult = { data: [{ config: '{"staleOnly":"must-not-return"}' }] };
    const panel = renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByDisplayValue('initial')).toBeTruthy());
    syncResult = { data: [] };
    panel.rerender(<NuqsTestingAdapter><BlueprintSettingsPanel slug="h" phase="production" /></NuqsTestingAdapter>);
    fireEvent.change(screen.getByDisplayValue('initial'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const put = vi.mocked(fetch).mock.calls.find(c => c[1]?.method === 'PUT')!;
    expect(JSON.parse(JSON.parse(String(put[1]!.body)).config)).toEqual({ m: 'edited' });
  });

  it('discards prior edits and schema while a different harness is loading', async () => {
    let resolveNext!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/next/')
      ? new Promise<Response>(resolve => { resolveNext = resolve; })
      : Promise.resolve(new Response('{"blueprintId":"old-blueprint","params":{"m":{}}}'))));
    mockViews = [{ key: 'm', spec: { type: 'string', label: 'Model' }, value: 'initial', overridden: false }];
    const panel = renderPanel(<BlueprintSettingsPanel slug="old" phase="production" />);
    await waitFor(() => expect(screen.getByDisplayValue('initial')).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('initial'), { target: { value: 'old-edit' } });
    panel.rerender(<NuqsTestingAdapter><BlueprintSettingsPanel slug="next" phase="production" /></NuqsTestingAdapter>);
    expect(screen.queryByDisplayValue('old-edit')).toBeNull();
    expect(screen.queryByText('old-blueprint')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    resolveNext(new Response('{"blueprintId":"new-blueprint","params":{"m":{}}}'));
    await waitFor(() => expect(screen.getByText('new-blueprint')).toBeTruthy());
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  it('retains edits after a denied save and retries the exact selected harness', async () => {
    let deny = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (!init?.method) return new Response('{"blueprintId":"coding","params":{"m":{}}}');
      return new Response(deny ? '{"error":"forbidden"}' : '{"ok":true}', { status: deny ? 403 : 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    mockViews = [{ key: 'm', spec: { type: 'string', label: 'Model' }, value: 'initial', overridden: false }];
    mockValidate = { ok: true, errors: [], unknownKeys: [], patch: { m: 'edited' } };
    renderPanel(<BlueprintSettingsPanel slug="chosen" phase="production" />);
    await waitFor(() => expect(screen.getByDisplayValue('initial')).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('initial'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Save failed', { description: 'HTTP 403' }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue('edited')).toBeTruthy();
    deny = false;
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Settings saved'));
    expect(fetchMock.mock.calls.filter(c => c[1]?.method === 'PUT').map(c => c[0]))
      .toEqual(['/api/harness/chosen/spec?phase=production', '/api/harness/chosen/spec?phase=production']);
  });

  it('shows blueprint resolution errors even when the API returns HTTP 200', async () => {
    stubBlueprintParamsFetch({ params: {}, error: 'Invalid blueprint schema' } as never);
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Invalid blueprint schema'));
    expect(screen.queryByText(/declares no tunable settings/)).toBeNull();
  });

  it('withholds config read errors and retries the existing named query', async () => {
    stubBlueprintParamsFetch({ params: { m: {} } });
    syncResult = { data: [], error: new Error('Config denied') };
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Config denied'));
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry settings' }));
    expect(invalidateConfig).toHaveBeenCalledOnce();
  });

  it.each(['{"unterminated":', '[]', 'null'])('does not overwrite malformed saved config %s', async config => {
    stubBlueprintParamsFetch({ params: { m: {} } });
    syncResult = { data: [{ config }] };
    renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(c => c[1]?.method === 'PUT')).toBe(false);
  });

  it('resets edits when the same harness switches spec phase', async () => {
    stubBlueprintParamsFetch({ params: { m: {} } });
    mockViews = [{ key: 'm', spec: { type: 'string', label: 'Model' }, value: 'initial', overridden: false }];
    const panel = renderPanel(<BlueprintSettingsPanel slug="h" phase="production" />);
    await waitFor(() => expect(screen.getByDisplayValue('initial')).toBeTruthy());
    fireEvent.change(screen.getByDisplayValue('initial'), { target: { value: 'old-phase-edit' } });
    panel.rerender(<NuqsTestingAdapter><BlueprintSettingsPanel slug="h" phase="staging" /></NuqsTestingAdapter>);
    await waitFor(() => expect(screen.getByDisplayValue('initial')).toBeTruthy());
    expect(screen.queryByDisplayValue('old-phase-edit')).toBeNull();
    expect(screen.queryByText(/unsaved change/)).toBeNull();
  });

  // WI-10006501: this is the panel the Settings tab mounts by default
  // (BLUEPRINT_AWARE_SETTINGS on), so the pot's working-copy switch (P-016) must be
  // here too, keyed to the selected pot. Before the fix it existed only in the
  // legacy HarnessSettingsPanel, so with defaults no user could reach it.
  it("mounts the pot's working-copy switch for the selected pot, including while params load", async () => {
    stubBlueprintParamsFetch({ blueprintId: 'coding', params: {} });
    renderPanel(<BlueprintSettingsPanel slug="pot-review-pilot" phase="production" />);
    await waitFor(() => expect(screen.getByTestId('integration-mode-section-mount')).toBeTruthy());
    expect(screen.getByTestId('integration-mode-section-mount').textContent).toBe('pot-review-pilot');
  });
});
