// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { NuqsTestingAdapter } from 'nuqs/adapters/testing';
import { configureOperatorUi } from '@papercusp/operator-ui/seam';
import { ADV_TAB_SURFACE_KINDS } from '@papercusp/operator-ui/adv-navigation';
import type { ReactNode } from 'react';
import type { AutomationCatalog, AutomationRoutine } from '@papercusp/operator-core/lib/automation/catalog';
import type { ExternalTriggerAdminSnapshot } from '@papercusp/operator-core/lib/external-triggers/admin';

const H = vi.hoisted(() => ({
  runTool: vi.fn<
    (name: string, args: Record<string, unknown>) => Promise<{
      ok: boolean;
      message?: string;
      data?: Record<string, unknown>;
    }>
  >(
    async () => ({ ok: true }),
  ),
  invalidates: [] as string[],
  queries: [] as Array<{ queryName: string; args: unknown }>,
  emptyData: false,
  /** Reproduces the real workspace's scale, which is where the strip and the DOM blew up. */
  manyPlans: false,
  /** A triggered plan whose run history has no rollup — the "No verified run cost" path. */
  noRollup: false,
  /** Core inventory queries are unresolved — absence must render as loading, never zero. */
  loadingData: false,
  occurrenceError: null as Error | null,
  emptyOccurrences: false,
  /** Swap the connected-source fixture to Gmail for direct Email-target coverage. */
  gmailSource: false,
  /** The catalog carries the `external-trigger-dispatch` routine, inactive (WI-10004922). */
  dispatcherPaused: false,
  /** Every external binding in the admin snapshot is disarmed. */
  externalDisarmed: false,
  /** The external bindings belong to an unreviewed trigger pack (P-013): arming answers 409. */
  packOwned: false,
  enterpriseOperations: false,
  externalUnavailable: false,
}));

const PACK_INSTALLATION_ID = '33333333-3333-4333-8333-333333333333';
const PACK_FINGERPRINT = 'f'.repeat(64);

/** 230 triggered plans, 12 of them urgent — the shape measured in the desktop shell. */
const BULK_PLANS = Array.from({ length: 230 }, (_, i) => ({
  slug: `bulk-${i}`,
  title: `Bulk workflow ${i}`,
  harness: 'papercusp',
  status: 'ready',
  nextAction: 'Does a bulk thing',
  triggered: true,
  triggerSources: ['schedule'],
  scheduled: true,
  scheduleActive: true,
  ...(i < 12 ? { maxImportance: 'urgent' } : {}),
}));

function routine(): AutomationRoutine {
  return {
    name: 'git-sync', installSlug: 'papercusp', group: 'git-sync', category: 'infra',
    cron: '0 */2 * * * *', cadence: 'every 2m', active: true, spend: 'none',
    spendWhy: 'Runs inline', spawnsAgent: false, kind: 'scheduled', family: 'git-release',
    liveness: 'running', armedState: 'armed', control: 'routine', controlWhy: 'Pause from routines:set',
    flagKey: null, needsAttention: false, installs: ['papercusp'], ownerId: null,
    ownerLastActiveAt: null, triggerLabel: null, lastFiredAt: '2026-08-22T19:58:00.000Z',
    nextFireAt: '2026-08-22T20:02:00.000Z', source: 'routines', controllable: true,
  };
}

const catalog: AutomationCatalog = {
  routines: [routine()],
  categories: [],
  spend7d: [{ role: 'doc-steward', modelClass: 'claude', turns: 4, outputTokens: 1200, cacheReadTokens: 800, costUsd: 2.4, lastSeenAt: '2026-08-22T19:00:00.000Z' }],
  spend7dTotalUsd: 2.4,
  // potScope null = the scope read did not happen for this fixture. NOT an empty
  // scope, which would assert "every pot is learning" (learning-pot-scope-gate).
  arming: { gymPots: [], lanes: [], scoutCeiling: null, potScope: null },
  generatedAt: '2026-08-22T20:00:00.000Z',
};

const external: ExternalTriggerAdminSnapshot = {
  enabled: true,
  counts: { sources: 1, bindings: 1, armed: 1, recentFailures: 0 },
  sources: [
    {
      id: "source-slack",
      kind: "slack",
      status: "connected",
      scope: "pot",
      scopeRef: "papercusp",
      permissionMode: "source-acl",
      backfillStatus: "not-requested",
      lastSyncAt: null,
      nextAttemptAt: null,
      failureCount: 0,
      config: {},
      credentialRef: null,
      cursor: {},
      lastConnectedAt: "2026-08-22T19:00:00.000Z",
      lastError: null,
      bindingCount: 1,
      armedBindingCount: 1,
      failedDeliveries24h: 0,
      social: null,
    },
  ],
  bindings: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      sourceId: "source-slack",
      sourceKind: "slack",
      sourceStatus: "connected",
      planHarnessSlug: "papercusp",
      planSlug: "customer-digest",
      goalId: null,
      workItemHarnessSlug: null,
      workItemKind: null,
      eventPattern: "ext:slack:message",
      eventFilter: {},
      action: {},
      armed: true,
      stormPolicy: {},
      createdBy: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      lastRun: {
        id: "run-1",
        status: "done",
        triggeredAt: "2026-08-22T19:00:00.000Z",
        completedAt: "2026-08-22T19:01:00.000Z",
        error: null,
      },
    },
  ],
  recentRuns: [
    {
      id: "run-1",
      bindingId: "11111111-1111-4111-8111-111111111111",
      sourceKind: "slack",
      eventPattern: "ext:slack:message",
      planHarnessSlug: "papercusp",
      planSlug: "customer-digest",
      workItemHarnessSlug: null,
      workItemKind: null,
      status: "done",
      attempts: 1,
      dedupeKey: "slack:run-1",
      triggeredAt: "2026-08-22T19:00:00.000Z",
      startedAt: "2026-08-22T19:00:00.000Z",
      completedAt: "2026-08-22T19:01:00.000Z",
      planRunRef: "run:1",
      error: null,
      causeSummary: "Slack message matched",
      policyDisposition: "ran",
      policyDetail: "ran",
      eventFilter: {},
      stormPolicy: {},
      redactedPayload: {},
      outcomeLinks: [],
      timeline: [],
      planRun: null,
    },
  ],
};

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: ({ queryName, args, enabled }: { queryName: string; args: unknown; enabled?: boolean }) => {
    H.queries.push({ queryName, args });
    const invalidate = vi.fn(() => H.invalidates.push(queryName));
    // The real useSyncQuery does not run a disabled query. Honouring that here matters:
    // without it the mock hands run history to a routine that has no plan, and the
    // inspector's "no verified run cost" path can never be exercised.
    if (enabled === false) return { data: [], loading: false, invalidate };
    if (H.loadingData) return { data: [], loading: true, invalidate };
    if (H.emptyData) return { data: [], loading: false, invalidate };
    if (queryName === 'automation.catalog' && H.dispatcherPaused) {
      const dispatcher = { ...routine(), name: 'external-trigger-dispatch', group: 'external-triggers', active: false };
      return { data: [{ ...catalog, routines: [...catalog.routines, dispatcher] }], loading: false, invalidate };
    }
    if (queryName === 'automation.catalog' && (args as { supportWorkflow?: unknown })?.supportWorkflow) return {
      data: [{ supportWorkflow: { harnessSlug: 'papercusp', operationId: 'support-handoff', approvedRevision: 'a'.repeat(64),
        accountableOwner: 'support-owner', reviewerPrincipals: ['reviewer'], allowedSources: ['slack'],
        allowedActions: ['prepare-handoff'], maximumCostMicros: 100_000 } }], loading: false, invalidate,
    };
    if (queryName === 'automation.catalog') return { data: [catalog], loading: false, invalidate };
    if (queryName === 'harnessProjects.lite') return { data: [{ slug: 'papercusp' }], loading: false, invalidate };
    if (queryName === 'plans.list' && H.manyPlans) return { data: BULK_PLANS, loading: false, invalidate };
    if (queryName === 'plans.list') return { data: [
      { slug: 'customer-digest', title: 'Customer feedback digest', harness: 'papercusp', status: 'ready', nextAction: 'Turns feedback into a prioritized brief', triggered: true, triggerSources: ['schedule', 'external', 'manual'], scheduled: true, scheduleActive: true },
      { slug: 'rubric-ratification', title: 'Rubric ratification', harness: 'papercusp', status: 'ready', nextAction: 'Wait for independent review', triggered: true, triggerSources: ['manual'], scheduled: false, scheduleActive: false },
    ], loading: false, invalidate };
    if (queryName === 'plans.schedule') return { data: [{ templateSlug: 'customer-digest', title: 'Customer feedback digest', harnessSlug: 'papercusp', schedule: { rrule: 'RRULE:FREQ=DAILY;BYHOUR=9', tzid: 'America/New_York' }, scheduledAt: null, expiresAt: null, tzid: 'America/New_York', scheduleActive: true }], loading: false, invalidate };
    if (queryName === 'plans.scheduledOccurrences') return { data: H.emptyOccurrences ? [] : [{ templateSlug: 'customer-digest', title: 'Customer feedback digest', harnessSlug: 'papercusp', occurrenceMs: Date.now() + 18 * 60_000, kind: 'recurring', scheduleActive: true, lastOutcome: 'success' }], error: H.occurrenceError, loading: false, invalidate };
    if (queryName === 'plans.runHistory' && H.noRollup) return { data: [{ runs: [], rollup: null }], loading: false, invalidate };
    if (queryName === 'plans.runHistory') return { data: [{ runs: [{ id: 1, status: 'done', trigger: 'manual', outcome: 'success', launchedAt: Date.now() - 60_000, durationMs: 45_000, costUsd: 0.62 }], rollup: { total: 1, successRate: 1, totalCostUsd: 0.62, medianDurationMs: 45_000, running: 0, failed: 0 } }], loading: false, invalidate };
    return { data: [], loading: false, invalidate };
  },
}));

vi.mock('@/app/admin/plans/plans-api', () => ({
  fetchPlanInputs: vi.fn(async () => ({ ok: true, slug: 'customer-digest', source: 'input-schema', inputSchema: {}, template: null, required: ['topic', 'urgency'], missing: [], values: { topic: 'feedback', urgency: 'high' }, ready: true })),
}));
vi.mock('@/app/adv/create/use-create-data', () => ({ useResolvedHarnessSlug: () => 'papercusp' }));
vi.mock('@/app/harness/Modal', () => ({
  Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) => (
    open ? <div role="dialog" aria-label={title}>{children}</div> : null
  ),
}));
vi.mock('@/app/harness/Select', () => ({
  Select: ({
    value,
    onChange,
    options,
    ariaLabel,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    options: Array<{ value: string; label: ReactNode }>;
    ariaLabel?: string;
    disabled?: boolean;
  }) => (
    <select aria-label={ariaLabel} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  ),
}));
vi.mock('@/app/harness/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: vi.fn(async () => true), element: null }) }));
vi.mock('@/app/harness/ChatPanel', () => ({
  default: ({ initialMessage, context }: { initialMessage?: string; context?: string }) => (
    <div data-testid="workflow-composer-chat" data-context={context ?? ''}>{initialMessage ?? 'Empty composer chat'}</div>
  ),
}));
vi.mock('./ScheduleEditor', () => ({ runScheduleTool: H.runTool }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AdvWorkflowsTab from './AdvWorkflowsTab';

const DIGEST = 'plan:papercusp:customer-digest';

function renderTab(searchParams?: Record<string, string>, enterprise = false) {
  return render(
    <NuqsTestingAdapter searchParams={searchParams}>
      <AdvWorkflowsTab enterprise={enterprise} />
    </NuqsTestingAdapter>,
  );
}

/**
 * Selection is seeded through the URL rather than clicked, for the same reason the previous
 * suite did it: nuqs batches its URL writes, so a click-then-assert races the flush.
 */
function renderTabOnDigest() {
  return renderTab({ wfSelId: DIGEST });
}

async function openAdvancedWorkflowSetup() {
  fireEvent.click(await screen.findByRole('button', { name: 'New workflow' }));
  const composer = await screen.findByRole('dialog', { name: 'Compose a workflow with the agent' });
  fireEvent.click(within(composer).getByRole('button', { name: 'Advanced manual setup' }));
  return screen.getByRole('dialog', { name: 'Create a workflow' });
}

beforeEach(() => {
  H.runTool.mockReset();
  H.runTool.mockResolvedValue({ ok: true });
  H.invalidates.length = 0;
  H.queries.length = 0;
  H.emptyData = false;
  H.manyPlans = false;
  H.noRollup = false;
  H.loadingData = false;
  H.occurrenceError = null;
  H.emptyOccurrences = false;
  H.gmailSource = false;
  H.dispatcherPaused = false;
  H.externalDisarmed = false;
  H.packOwned = false;
  H.enterpriseOperations = false;
  H.externalUnavailable = false;
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (H.externalUnavailable && String(_input).includes('/api/admin/triggers')) throw new Error('Inventory read refused');
    if (init?.method === 'POST' && String(_input).includes('/agent-chats')) {
      return new Response(JSON.stringify({ id: 'workflow-composer-chat-1' }), { status: 200 });
    }
    if (init?.method === 'PATCH') {
      const request = JSON.parse(String(init.body ?? '{}')) as { op?: string; id?: string; armed?: boolean };
      if (H.packOwned && request.op === 'set-armed' && request.armed === true) {
        return new Response(JSON.stringify({
          ok: false,
          error: 'trigger_pack_review_required',
          detail: 'binding belongs to an unreviewed trigger pack',
          pack: { installationId: PACK_INSTALLATION_ID, pluginName: 'gmail-triage' },
        }), { status: 409 });
      }
      if (request.op === 'pack-review') {
        return new Response(JSON.stringify({
          ok: true,
          review: {
            installationId: PACK_INSTALLATION_ID,
            fingerprint: PACK_FINGERPRINT,
            reviewedFingerprint: null,
            reviewedBy: null,
            reviewedAt: null,
            current: false,
            bindingCount: 2,
            review: {
              pluginName: 'gmail-triage', pluginVersion: '1.2.0', harnessSlug: 'papercusp', status: 'configured',
              capabilities: ['mail.draft'], oauth: [{ provider: 'google', scopes: ['gmail.readonly'] }],
              bindings: [], entryPoints: [], plans: [], recipients: [], unmet: [],
            },
          },
        }), { status: 200 });
      }
      if (request.op === 'pack-arm') {
        return new Response(JSON.stringify({
          ok: true, installationId: PACK_INSTALLATION_ID, fingerprint: PACK_FINGERPRINT, armedBindingIds: ['a', 'b'],
        }), { status: 200 });
      }
      if (request.op === 'attach-external') {
        return new Response(JSON.stringify({ ok: true, binding: { id: '22222222-2222-4222-8222-222222222222' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true, binding: { id: request.id } }), { status: 200 });
    }
    if (H.enterpriseOperations) return Response.json({ ...external, bindings: [...external.bindings, {
      ...external.bindings[0], id: '22222222-2222-4222-8222-222222222222', planSlug: null,
      action: { type: 'blueprint-operation', operationHarnessSlug: 'papercusp', operationId: 'support-handoff' },
    }] });
    if (H.emptyData) {
      return new Response(JSON.stringify({ enabled: true, counts: { sources: 0, bindings: 0, armed: 0, recentFailures: 0 }, sources: [], bindings: [], recentRuns: [] }), { status: 200 });
    }
    if (H.gmailSource) {
      const gmail = {
        ...external,
        counts: { sources: 1, bindings: 0, armed: 0, recentFailures: 0 },
        sources: [{
          id: 'source-gmail', kind: 'gmail', status: 'connected', config: {}, credentialRef: null,
          cursor: {}, lastConnectedAt: '2026-08-22T19:00:00.000Z', lastError: null,
          bindingCount: 0, armedBindingCount: 0, failedDeliveries24h: 0, social: null,
        }],
        bindings: [],
        recentRuns: [],
      };
      return new Response(JSON.stringify(gmail), { status: 200 });
    }
    if (H.manyPlans) {
      // 230 recent runs, so the Activity feed is over the render cap the ledger already has.
      const recentRuns = Array.from({ length: 230 }, (_, i) => ({
        ...external.recentRuns[0],
        id: `run-bulk-${i}`,
        planSlug: `bulk-${i}`,
        triggeredAt: new Date(Date.parse('2026-08-22T19:00:00.000Z') - i * 60_000).toISOString(),
      }));
      return new Response(JSON.stringify({ ...external, recentRuns }), { status: 200 });
    }
    if (H.externalDisarmed) {
      const bindings = external.bindings.map((binding) => ({ ...binding, armed: false }));
      return new Response(JSON.stringify({ ...external, bindings }), { status: 200 });
    }
    return new Response(JSON.stringify(external), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); configureOperatorUi({ advNavigation: undefined }); });

describe('Enterprise workspace — D-050', () => {
  it.each([['Plans', 'create'], ['Calendar', 'scheduled'], ['Evaluations', 'evals'], ['Live work', 'hud'], ['Health', 'health'], ['Learning', 'learning']])(
    'opens %s through the portal host navigation while retaining the selected workflow and workspace', async (label, destination) => {
      configureOperatorUi({ advNavigation: { param: 'app', targets: ADV_TAB_SURFACE_KINDS } });
      H.enterpriseOperations = true;
      const onUrlUpdate = vi.fn();
      render(<NuqsTestingAdapter hasMemory searchParams="?app=enterprise&ws=private-workspace&wfSelId=operation:papercusp:support-handoff"
        onUrlUpdate={onUrlUpdate}><AdvWorkflowsTab enterprise /></NuqsTestingAdapter>);
      await screen.findByRole('heading', { name: 'Prepare support handoff' });
      fireEvent.click(within(screen.getByRole('navigation', { name: 'Supporting workspace evidence' })).getByRole('button', { name: label }));
      await waitFor(() => expect(onUrlUpdate).toHaveBeenCalled());
      const params = onUrlUpdate.mock.lastCall![0].searchParams as URLSearchParams;
      expect(params.get('app')).toBe(destination);
      expect(params.get('tab')).toBeNull();
      expect(params.get('ws')).toBe('private-workspace');
      expect(params.get('wfSelId')).toBe('operation:papercusp:support-handoff');
    },
  );

  it('keeps the employee, pending reviewer, and admin evidence together for departmental operations', async () => {
    H.enterpriseOperations = true;
    renderTab({ wfMode: 'activity', wfState: 'paused', wfKind: 'system', wfQ: 'unrelated', wfId: DIGEST }, true);
    expect(await screen.findByRole('heading', { name: 'Prepare support handoff' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Enterprise workspace' })).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Departmental workflow' }) as HTMLSelectElement;
    expect(Array.from(picker.options).map(option => option.text)).toEqual(['support-handoff · papercusp']);
    expect(screen.queryByRole('button', { name: 'Run manually' })).toBeNull();
    expect(screen.queryByLabelText('Workflow controls')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Reviewer decision' })).toBeTruthy();
    expect(screen.getByText(/Business outcome pending/)).toBeTruthy();
    expect(screen.getByText(/funding\/cost evidence, promotion, rollback, and history have not been read/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh administration' })).toBeTruthy();
    expect(screen.getByText('a'.repeat(64))).toBeTruthy();
    expect(H.runTool).not.toHaveBeenCalled();
    expect(within(screen.getByRole('navigation', { name: 'Supporting workspace evidence' })).getAllByRole('button')).toHaveLength(6);
  });

  it('distinguishes an unavailable inventory from an installed-workflow count of zero', async () => {
    H.externalUnavailable = true;
    renderTab({}, true);
    expect(await screen.findByText(/Departmental workflow inventory is unavailable: Inventory read refused/)).toBeTruthy();
    expect(screen.getByText('Inventory unavailable')).toBeTruthy();
    expect(screen.queryByText('No departmental workflow installed')).toBeNull();
  });

  it('explains how to start when no departmental operation is installed', async () => {
    renderTab({}, true);
    expect(await screen.findByText('No departmental workflow installed')).toBeTruthy();
    expect(screen.getByText(/Install an approved departmental operation/)).toBeTruthy();
    expect((screen.getByRole('combobox', { name: 'Departmental workflow' }) as HTMLSelectElement).disabled).toBe(true);
  });
});

describe('<AdvWorkflowsTab> — one frame (D-001)', () => {
  it('renders a single frame: one masthead, the ledger and the inspector together', async () => {
    renderTab();
    // ONE heading. The retired landing painted a second "Workflows" under this one.
    expect(await screen.findByRole('heading', { name: 'Workflows', level: 1 })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: 'Workflows' })).toHaveLength(1);

    expect(screen.getByRole('region', { name: 'Describe a workflow' })).toBeTruthy();
    expect(screen.getByLabelText('Workflow inspector')).toBeTruthy();
    // Both populations are in ONE ledger — routines are no longer exiled to a Catalog view.
    expect(screen.getByTestId(`wf-row:${DIGEST}`)).toBeTruthy();
    expect(screen.getByTestId('wf-row:routine:git-sync:papercusp')).toBeTruthy();

    // The five sub-views are gone.
    for (const gone of ['Overview', 'Flows', 'Catalog', 'Sources']) {
      expect(screen.queryByRole('tab', { name: gone })).toBeNull();
    }
    expect(screen.queryByLabelText('Search trigger flows')).toBeNull();
  });

  it('summarises the population and surfaces source health as a filter (D-003)', async () => {
    renderTab();
    expect(await screen.findByText('1 triggered · 1 system task')).toBeTruthy();

    const sources = screen.getByRole('group', { name: 'Source health' });
    const slack = within(sources).getByRole('button', { name: /^Slack: connected/ });
    expect(within(sources).getByRole('button', { name: /^Schedule:/ })).toBeTruthy();

    fireEvent.click(slack);
    await waitFor(() => expect(slack.getAttribute('aria-pressed')).toBe('true'));
    // Filtering to Slack keeps the slack-triggered plan and drops the internal routine.
    expect(screen.getByTestId(`wf-row:${DIGEST}`)).toBeTruthy();
    expect(screen.queryByTestId('wf-row:routine:git-sync:papercusp')).toBeNull();
  });

  it('renders structured loading states without asserting a false zero population', async () => {
    H.loadingData = true;
    renderTab();

    expect(await screen.findByText('Loading workflow inventory…')).toBeTruthy();
    expect(screen.queryByText(/0 triggered/)).toBeNull();
    expect(screen.getByRole('status', { name: 'Loading workflows' })).toBeTruthy();
    expect(screen.getByRole('status', { name: 'Loading workflow details' })).toBeTruthy();
    expect(screen.queryByText('Select a workflow to inspect it.')).toBeNull();
  });

  it('renders NOTHING for the needs-you strip when nothing needs the operator (D-018/D-004)', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    // The rule this preserves: no "all clear" card, no empty frame — absence IS the state.
    expect(screen.queryByTestId('workflows-needs-you')).toBeNull();
  });

  it('reports an occurrence read failure while retaining the workflow and routine inventory', async () => {
    H.occurrenceError = new Error('occurrence read denied');
    renderTab();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('occurrence read denied');
    expect(within(alert).getByRole('button', { name: 'Retry schedule read' })).toBeTruthy();
    expect(screen.getByTestId(`wf-row:${DIGEST}`)).toBeTruthy();
    expect(screen.getByTestId('wf-row:routine:git-sync:papercusp')).toBeTruthy();
  });

  it('does not show stale next-run values after an occurrence read fails', async () => {
    H.occurrenceError = new Error('occurrence read denied');
    renderTabOnDigest();
    const row = await screen.findByTestId(`wf-row:${DIGEST}`);
    expect(row.textContent).not.toContain('18m');
    expect(row.textContent).toContain('Schedule unavailable');
    expect(screen.getByLabelText('Workflow inspector').textContent).not.toContain('18m');
  });

  it('retries the occurrence read and restores verified next-run values on recovery', async () => {
    H.occurrenceError = new Error('occurrence read denied');
    const view = renderTab();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry schedule read' }));
    expect(H.invalidates).toEqual(['plans.scheduledOccurrences']);
    expect(H.runTool).not.toHaveBeenCalled();
    H.occurrenceError = null;
    view.rerender(<NuqsTestingAdapter><AdvWorkflowsTab /></NuqsTestingAdapter>);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByTestId(`wf-row:${DIGEST}`).textContent).toContain('18m');
  });

  it('keeps a genuinely empty successful occurrence read distinct from failure', async () => {
    H.emptyOccurrences = true;
    renderTab();
    await screen.findByTestId(`wf-row:${DIGEST}`);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry schedule read' })).toBeNull();
    expect(screen.getByTestId(`wf-row:${DIGEST}`).textContent).not.toContain('Schedule unavailable');
  });

  it('shows verified next-run values for a successful occurrence read', async () => {
    renderTabOnDigest();
    expect((await screen.findByTestId(`wf-row:${DIGEST}`)).textContent).toContain('18m');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  /**
   * WI-10004922: the trigger dispatcher was paused for two weeks while an armed workflow
   * looked ready. The catalog's routine row is the only input that can say so.
   */
  it('leads the needs-you strip when the trigger dispatcher is paused under an armed event workflow', async () => {
    H.dispatcherPaused = true;
    renderTab();
    const strip = await screen.findByTestId('workflows-needs-you');
    expect(
      await within(strip).findByText(/Event triggers are paused: 1 armed workflow is queuing runs/),
    ).toBeTruthy();
  });

  it('raises no dispatcher alarm when only schedules are armed, because schedules keep firing', async () => {
    // customer-digest keeps an ARMED schedule; only its event binding is disarmed. Counting
    // every un-paused triggered row (the first cut) raised the alarm here falsely.
    H.dispatcherPaused = true;
    H.externalDisarmed = true;
    renderTab();
    // Not vacuous: the armed-schedule workflow has rendered, and the snapshot has been read.
    expect((await screen.findAllByText('Customer feedback digest')).length).toBeGreaterThan(0);
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(screen.queryByText(/Event triggers are paused/)).toBeNull();
  });

  /**
   * The scale regression the desktop shell exposed and the fixtures could not: on the real
   * workspace this surface raised 55 needs-you items and put 4,441 rows / 99,597 nodes in
   * the DOM. Both are now bounded, and both disclose what they hold back.
   */
  it('keeps the needs-you strip an interrupt, not a wall, at real scale', async () => {
    H.manyPlans = true;
    renderTab();
    const strip = await screen.findByTestId('workflows-needs-you');
    const rows = within(strip).getAllByRole('listitem');
    expect(rows.length).toBeLessThanOrEqual(4);
    // 12 urgent plans collapse into one counted row rather than twelve stacked lines.
    expect(within(strip).getByText('12 workflows need attention')).toBeTruthy();
  });

  it('bounds the rendered ledger and says how many it is holding back', async () => {
    H.manyPlans = true;
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    const rendered = screen.getAllByTestId(/^wf-row:/);
    expect(rendered).toHaveLength(200);
    // 230 plans + 1 routine = 231 matching rows, so 31 are held back — and said so.
    expect(screen.getByTestId('wf-ledger-more').textContent).toContain('31 more match these filters');
  });

  it('bounds the Activity feed by the same cap — it is the same frame, not a second surface', async () => {
    // Found live: the ledger was capped but Activity was not, and rendered 4,238 rows.
    H.manyPlans = true;
    renderTab({ wfMode: 'activity' });
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    expect(screen.getAllByTestId(/^wf-activity:/).length).toBeLessThanOrEqual(200);
    expect(screen.getByTestId('wf-activity-more').textContent).toMatch(/not shown/);
  });

  it('filters by state and kind facets over one ledger instead of switching views', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });

    fireEvent.click(screen.getByRole('button', { name: /^Running/ }));
    await waitFor(() => expect(screen.queryByTestId(`wf-row:${DIGEST}`)).toBeNull());
    expect(screen.getByTestId('wf-row:routine:git-sync:papercusp')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^All/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Triggered/ }));
    await waitFor(() => expect(screen.queryByTestId('wf-row:routine:git-sync:papercusp')).toBeNull());
    expect(screen.getByTestId(`wf-row:${DIGEST}`)).toBeTruthy();
  });

  it('wires the compact kind selector to the same URL-backed facet', async () => {
    renderTab();
    const compactKind = await screen.findByLabelText('Filter workflows by kind');

    // This fixture is an infra/system task despite its `routine:*` row id.
    fireEvent.change(compactKind, { target: { value: 'system' } });
    await waitFor(() => {
      expect(screen.queryByTestId(`wf-row:${DIGEST}`)).toBeNull();
      expect(screen.getByTestId('wf-row:routine:git-sync:papercusp')).toBeTruthy();
    });
  });

  it('says which kind of empty it is', async () => {
    renderTab({ wfQ: 'nothing-matches-this' });
    expect(await screen.findByText('No workflows match these filters.')).toBeTruthy();

    cleanup();
    H.emptyData = true;
    renderTab();
    expect(await screen.findByText(/No workflows are installed yet/)).toBeTruthy();
    expect(screen.getByText('Your workflow control center starts here')).toBeTruthy();
    // With no population there is nothing for a persistent inspector to inspect; a second
    // empty panel would repeat the state and consume half the working width.
    expect(screen.queryByLabelText('Workflow inspector')).toBeNull();
  });

  it('renders the ledger truthfully: a spend classification, never invented dollars (D-005)', async () => {
    renderTab();
    const row = await screen.findByTestId(`wf-row:${DIGEST}`);
    // The verified dollars live in the inspector; the row carries the classification.
    expect(within(row).getByText('per run')).toBeTruthy();
    expect(within(row).queryByText(/^\$/)).toBeNull();
    expect(within(screen.getByTestId('wf-row:routine:git-sync:papercusp')).getByText('$0')).toBeTruthy();
  });
});

describe('<AdvWorkflowsTab> — the inspector is the detail surface (D-002)', () => {
  it('inspects the selected workflow, with its triggers and verified run cost', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    expect(within(inspector).getByRole('heading', { name: 'Customer feedback digest' })).toBeTruthy();
    expect(within(inspector).getByText('Turns feedback into a prioritized brief')).toBeTruthy();
    // Both installed triggers, each with its own arm control.
    expect(within(inspector).getByText('FREQ=DAILY · BYHOUR=9')).toBeTruthy();
    expect(within(inspector).getByText('ext:slack:message')).toBeTruthy();
    // Measured here, so a dollar figure is honest here.
    await waitFor(() => expect(within(inspector).getByText('$0.62 · 1 run')).toBeTruthy());
  });

  it('reports the routine classification rather than formatting an absent number as $0.00', async () => {
    renderTab({ wfSelId: 'routine:git-sync:papercusp' });
    const inspector = await screen.findByLabelText('Workflow inspector');
    expect(within(inspector).getByText('$0 model spend')).toBeTruthy();
    expect(within(inspector).queryByText('$0.00')).toBeNull();
  });

  it('says "No verified run cost" for a TRIGGERED PLAN whose run history has no rollup', async () => {
    // The branch a routine never reaches: rewriting it to render $0.00 must fail a test,
    // since "$0.00 where no rollup exists" is this criterion's own drift marker.
    H.noRollup = true;
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    await waitFor(() => expect(within(inspector).getByText('No verified run cost')).toBeTruthy());
    expect(within(inspector).queryByText(/^\$/)).toBeNull();
  });

  it('offers only the agent-mediated controls — no structural edit affordance (D-016)', async () => {
    // The negative half of D-016. Without it, adding a Delete control to the inspector
    // would leave every other test green.
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    for (const forbidden of [/delete/i, /remove/i, /connect/i, /rename/i, /drag/i]) {
      expect(within(inspector).queryByRole('button', { name: forbidden })).toBeNull();
    }
    // ...and the ones that must be there, so this cannot pass by rendering nothing at all.
    expect(within(inspector).getByRole('button', { name: 'Run manually' })).toBeTruthy();
    expect(within(inspector).getByRole('button', { name: /^Expand/ })).toBeTruthy();
    expect(within(inspector).getByRole('button', { name: 'Disarm ext:slack:message' })).toBeTruthy();
  });

  it('fires Run manually through plans:run-now', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Run manually' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('plans:run-now', { slug: 'customer-digest', harness: 'papercusp' }));
  });

  it('toggles one external binding through the audited trigger admin route', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Disarm ext:slack:message' }));
    await waitFor(() => {
      const fetchMock = vi.mocked(fetch);
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH'
        && String(init.body).includes('11111111-1111-4111-8111-111111111111')
        && String(init.body).includes('"armed":false'))).toBe(true);
    });
  });

  it('arms a pack-owned binding only through the pack review, against the reviewed fingerprint (P-013)', async () => {
    H.externalDisarmed = true;
    H.packOwned = true;
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: 'Arm ext:slack:message' }));
    await waitFor(() => {
      const bodies = vi.mocked(fetch).mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
      expect(bodies.map((body) => body.op)).toEqual(['set-armed', 'pack-review', 'pack-arm']);
      expect(bodies[2]).toEqual({
        op: 'pack-arm', installationId: PACK_INSTALLATION_ID, fingerprint: PACK_FINGERPRINT, confirm: true,
      });
    });
  });

  it('expands into the topology + agent destination rather than opening a second detail view', async () => {
    renderTabOnDigest();
    const inspector = await screen.findByLabelText('Workflow inspector');
    fireEvent.click(within(inspector).getByRole('button', { name: /^Expand Customer feedback digest/ }));
    // The expansion replaces the frame — one destination, reached from the inspector.
    expect(await screen.findByLabelText('Workflow detail')).toBeTruthy();
    expect(screen.queryByLabelText('Workflow inspector')).toBeNull();
  });

  it('confirms and queues a distinct last-event run from the expanded view', async () => {
    const runId = '33333333-3333-4333-8333-333333333333';
    H.runTool.mockResolvedValueOnce({ ok: true, data: { ok: true, run: { id: runId } } });
    renderTab({ wfId: DIGEST });
    fireEvent.click(await screen.findByRole('button', { name: 'Test with last event' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('triggers:run-with-last-event', {
      bindingId: '11111111-1111-4111-8111-111111111111',
      confirm: true,
    }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'Test run 33333333 queued from the last provider event',
    );
  });
});

describe('<AdvWorkflowsTab> — ledger controls and activity', () => {
  it('pauses every automatic trigger from the row control when the workflow is armed', async () => {
    renderTab();
    const row = await screen.findByTestId(`wf-row:${DIGEST}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Disarm Customer feedback digest' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('plans:disarm-schedule', { slug: 'customer-digest', harness: 'papercusp' }));
    await waitFor(() => {
      expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'PATCH' && String(init.body).includes('"armed":false'))).toBe(true);
    });
  });

  it('pauses a controllable routine through routines:set', async () => {
    renderTab();
    const row = await screen.findByTestId('wf-row:routine:git-sync:papercusp');
    fireEvent.click(within(row).getByRole('button', { name: 'Disarm git-sync' }));
    await waitFor(() => expect(H.runTool).toHaveBeenCalledWith('routines:set', expect.objectContaining({
      name: 'git-sync',
      installSlug: 'papercusp',
      active: false,
    })));
  });

  it('shows Activity as a mode of the same frame, keeping the inspector', async () => {
    renderTab({ wfMode: 'activity' });
    expect(await screen.findByTestId('wf-activity:external-run:run-1')).toBeTruthy();
    // Same frame: the inspector does not disappear when the mode changes.
    expect(screen.getByLabelText('Workflow inspector')).toBeTruthy();
    expect(screen.queryByTestId(`wf-row:${DIGEST}`)).toBeNull();
  });

  it('switches into Activity from the mode control', async () => {
    renderTab();
    // Radix activates a tab on mousedown, not on a bare click event.
    fireEvent.mouseDown(await screen.findByRole('tab', { name: 'Activity' }));
    await waitFor(() => expect(screen.queryByTestId(`wf-row:${DIGEST}`)).toBeNull());
    expect(screen.getByTestId('wf-activity:external-run:run-1')).toBeTruthy();
  });

  it('reads plans workspace-wide without fanning out the project registry', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    expect(H.queries.some(({ queryName, args }) => queryName === 'plans.list' && JSON.stringify(args) === '{}')).toBe(true);
    expect(H.queries.some(({ queryName }) => queryName === 'harnessProjects.lite')).toBe(false);
  });

  /**
   * The URL-state contract the agent control surface (ui:get_state / ui:dispatch) drives this
   * tab through. Clicking a facet would still pass if it had been moved to useState, so each
   * param is asserted by SEEDING it — that is the assertion a useState regression fails.
   */
  it.each([
    ['wfState', { wfState: 'running' }, 'routine:git-sync:papercusp', DIGEST],
    ['wfKind', { wfKind: 'triggered' }, DIGEST, 'routine:git-sync:papercusp'],
    ['wfSource', { wfSource: 'slack' }, DIGEST, 'routine:git-sync:papercusp'],
  ])('drives %s from the URL, not from component state', async (_param, params, kept, dropped) => {
    renderTab(params as Record<string, string>);
    expect(await screen.findByTestId(`wf-row:${kept}`)).toBeTruthy();
    expect(screen.queryByTestId(`wf-row:${dropped}`)).toBeNull();
  });

  it('drives wfSort from the URL, not from component state', async () => {
    // `name` is the one sort whose order is independent of the fixtures' timing fields.
    renderTab({ wfSort: 'name' });
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    const names = screen.getAllByTestId(/^wf-row:/).map((row) => row.getAttribute('data-testid'));
    expect(names).toEqual([`wf-row:${DIGEST}`, 'wf-row:routine:git-sync:papercusp']);
    expect((screen.getByLabelText('Sort workflows') as HTMLSelectElement).value).toBe('name');
  });

  it('excludes a plan with no automatic trigger — manual launch is not a trigger', async () => {
    renderTab();
    await screen.findByRole('heading', { name: 'Workflows', level: 1 });
    expect(screen.queryByText('Rubric ratification')).toBeNull();
  });
});

describe('<AdvWorkflowsTab> — composing and creating', () => {
  it('opens the canonical workflow-agent composer with intent and source context, never the manual form by default', async () => {
    renderTab();
    const input = await screen.findByLabelText(/What should happen automatically/);
    fireEvent.change(input, { target: { value: 'When a client email arrives, draft a concise reply' } });
    fireEvent.click(screen.getByRole('button', { name: 'Wire it' }));

    const dialog = await screen.findByRole('dialog', { name: 'Compose a workflow with the agent' });
    expect(within(dialog).queryByLabelText('Event pattern')).toBeNull();
    expect(within(dialog).queryByText('Automatic trigger')).toBeNull();
    const chat = await within(dialog).findByTestId('workflow-composer-chat');
    expect(chat.textContent).toContain('When a client email arrives, draft a concise reply');
    const context = JSON.parse(chat.getAttribute('data-context') ?? '{}') as {
      harness?: string;
      sources?: Array<{ id: string; kind: string; status: string }>;
      contract?: { autoArm?: boolean; operatorReviewsAndArmsDirectly?: boolean };
    };
    expect(context).toMatchObject({
      harness: 'papercusp',
      sources: [{ id: 'source-slack', kind: 'slack', status: 'connected' }],
      contract: { autoArm: false, operatorReviewsAndArmsDirectly: true },
    });
    expect(H.runTool).not.toHaveBeenCalled();
  });

  it('suggests only what a connected source could actually wire', async () => {
    renderTab();
    const chips = await screen.findByTestId('workflows-chips');
    expect(within(chips).getByText('When someone mentions me in Slack…')).toBeTruthy();
  });

  it('creates and arms a schedule in place instead of redirecting to Plans', async () => {
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    expect(within(dialog).getByRole('button', { name: /Schedule/ }).getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog).getByRole('button', { name: 'Use an existing plan' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));
    await waitFor(() => {
      expect(H.runTool).toHaveBeenCalledWith('plans:set-schedule', expect.objectContaining({
        slug: 'customer-digest',
        harness: 'papercusp',
        schedule: expect.objectContaining({ kind: 'cron', cron: '*/15 * * * *' }),
      }));
      expect(H.runTool).toHaveBeenCalledWith('plans:arm-schedule', { slug: 'customer-digest', harness: 'papercusp' });
    });
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
    expect(within(dialog).getByText('Armed')).toBeTruthy();
  });

  it('searches existing plans by title, slug, and harness, with keyboard selection', async () => {
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    const picker = within(dialog).getByRole('combobox', { name: 'Plan to run' });

    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'rubric-ratification' } });
    expect(within(dialog).getByRole('option', { name: /Rubric ratification/ })).toBeTruthy();
    expect(within(dialog).queryByRole('option', { name: /Customer feedback digest/ })).toBeNull();

    fireEvent.keyDown(picker, { key: 'Enter' });
    expect(within(dialog).getByRole('status').textContent).toContain('Rubric ratification');

    fireEvent.change(picker, { target: { value: 'no-plan-here' } });
    expect(within(dialog).getByText('No plans match “no-plan-here”.')).toBeTruthy();
  });

  it('exposes the supported action boundary and sends a goal target without plan columns', async () => {
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    expect(within(dialog).getByText(/Arbitrary tool-name dispatch is not available/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: /External event/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: /Activate a goal/ }));
    fireEvent.change(within(dialog).getByLabelText('Goal ID'), { target: { value: 'goal-support-triage' } });
    fireEvent.change(within(dialog).getByLabelText('Event pattern'), { target: { value: 'ext:slack:mention' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));

    await waitFor(() => {
      const attach = vi.mocked(fetch).mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
        .find((body) => body.op === 'attach-external');
      expect(attach).toMatchObject({
        op: 'attach-external',
        goalId: 'goal-support-triage',
        eventPattern: 'ext:slack:mention',
      });
      expect(attach).not.toHaveProperty('planSlug');
      expect(attach).not.toHaveProperty('planHarnessSlug');
    });
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
  });

  it('sends the Gmail direct Email work-item target and keeps it unavailable for other sources', async () => {
    renderTab();
    const slackDialog = await openAdvancedWorkflowSetup();
    expect((within(slackDialog).getByRole('button', { name: /Create an Email work item/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(slackDialog).getByRole('button', { name: 'Cancel' }));

    cleanup();
    H.gmailSource = true;
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    fireEvent.click(within(dialog).getByRole('button', { name: /External event/ }));
    const emailTarget = within(dialog).getByRole('button', { name: /Create an Email work item/ });
    expect((emailTarget as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(emailTarget);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));

    await waitFor(() => {
      const attach = vi.mocked(fetch).mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
        .find((body) => body.op === 'attach-external');
      expect(attach).toMatchObject({
        op: 'attach-external',
        workItemHarnessSlug: 'email',
        workItemKind: 'email-draft-proposal',
        eventPattern: 'ext:gmail:',
      });
      expect(attach).not.toHaveProperty('planSlug');
      expect(attach).not.toHaveProperty('goalId');
    });
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
  });

  it('creates a plan inline, attaches an external binding, and explicitly arms it', async () => {
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    fireEvent.click(within(dialog).getByRole('button', { name: /External event/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create the plan here' }));
    fireEvent.change(within(dialog).getByLabelText('Workflow name'), { target: { value: 'Summarize support escalations' } });
    fireEvent.change(within(dialog).getByLabelText('What should the plan produce?'), { target: { value: 'Publish a prioritized escalation brief' } });
    fireEvent.change(within(dialog).getByLabelText('Event pattern'), { target: { value: 'ext:slack:mention' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));

    await waitFor(() => {
      expect(H.runTool).toHaveBeenCalledWith('plans:new', expect.objectContaining({
        harness: 'papercusp',
        title: 'Summarize support escalations',
        status: 'ready',
        content: expect.stringContaining('- **P-001** `todo` Publish a prioritized escalation brief importance: normal'),
      }));
      const patchBodies = vi.mocked(fetch).mock.calls
        .filter(([, init]) => init?.method === 'PATCH')
        .map(([, init]) => JSON.parse(String(init?.body)) as { op: string; eventPattern?: string; armed?: boolean });
      expect(patchBodies).toEqual(expect.arrayContaining([
        expect.objectContaining({ op: 'attach-external', eventPattern: 'ext:slack:mention' }),
        expect.objectContaining({ op: 'set-armed', armed: true }),
      ]));
    });
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
  });

  it('reports a saved-but-unarmed schedule and retries only the arm step', async () => {
    H.runTool
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, message: 'Set required plan inputs first' })
      .mockResolvedValueOnce({ ok: true });
    renderTab();
    const dialog = await openAdvancedWorkflowSetup();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create & arm workflow' }));

    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent).toContain('Schedule saved for Customer feedback digest, but it is not armed.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry arming' }));
    expect(await within(dialog).findByText('Workflow armed')).toBeTruthy();
    expect(H.runTool.mock.calls.map(([name]) => name)).toEqual([
      'plans:set-schedule',
      'plans:arm-schedule',
      'plans:arm-schedule',
    ]);
  });
});
