'use client';

/**
 * Settings → Integrations: connect a ticket tracker, choose what it syncs, and say which of its
 * tickets become work items (linear-asana-task-sync-2026-10-05 P-007, plan decision D-014).
 *
 * The page names no provider. Every card comes from the live provider registry through the
 * overview (packages/operator-core/lib/integrations/ticket-integrations.ts): which providers
 * connect over OAuth and sync tickets, what config each source still needs, whether a provider
 * can list its teams/projects, and whether its columns are user-mapped (sections) or decided by
 * the provider's own workflow states.
 *
 * Data: useTicketIntegrations (ticket-integrations-client.ts) reads the overview once and then
 * live; every write route fires notifySyncInvalidate, so the page never polls. The open source and
 * its open panel are URL state (nuqs); form drafts are local.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { toast } from 'sonner';
import type {
  TicketContainer,
  TicketContainerKind,
  TicketContainerList,
  TicketProviderSummary,
  TicketSourceConfigKey,
  TicketSourceSummary,
} from '@papercusp/operator-core/lib/integrations/ticket-integrations';
import {
  formatTime,
  IntegrationRequestError,
  integrationRequest as request,
  joinWords,
  missingLabels,
  useTicketIntegrations,
} from './ticket-integrations-client';
import type { SetAdmissionRuleResult, TicketRulePreset } from '@papercusp/operator-core/lib/work-admission/admission-rules';
import type { AdmittedKind } from '@papercusp/operator-core/lib/work-admission/admit';
import type { TicketStatusCategory } from '@papercusp/operator-core/lib/data-sources/ticket-vocabulary';
import { Button } from '../../harness/Button';
import { Checkbox } from '../../harness/Checkbox';
import { Select, type SelectOption } from '../../harness/Select';
import { isExternalWebUrl, openExternalWebUrl } from '../../_components/ExternalLinkProvider';
import { isDesktop } from '@/lib/ipc-status-tauri';
import { ProviderAppRegistration } from './ProviderAppRegistration';
import { ProviderCredentialsForm } from './ProviderCredentialsForm';
import { ProviderSourceSettingsForm } from './ProviderSourceSettingsForm';
import { ProviderSourceConfigForm } from './ProviderSourceConfigForm';
import { ProviderOAuthClientForm } from './ProviderOAuthClientForm';
import { TriggerPackSection, TriggerPackSetup } from './TriggerPackSection';

export const PANELS = ['scope', 'mapping', 'rules'] as const;
type Panel = (typeof PANELS)[number];

/** Which source config key each container kind fills (D-014.3), and whether it holds one id or many. */
const CONTAINER_KEYS: Record<TicketContainerKind, { key: TicketSourceConfigKey; many: boolean; label: string }> = {
  workspace: { key: 'workspaceGid', many: false, label: 'Workspace' },
  team: { key: 'teamIds', many: true, label: 'Teams' },
  project: { key: 'projectGids', many: true, label: 'Projects' },
};
const KIND_ORDER: TicketContainerKind[] = ['workspace', 'team', 'project'];

/**
 * Every rule preset the server accepts (TICKET_RULE_PRESETS, D-012). A Record keyed by the server's
 * own union, so a preset added or removed there fails this file's typecheck instead of drifting.
 * `suggest` names the container kind whose names fill the value's suggestion list.
 */
const PRESETS: Record<
  TicketRulePreset,
  { label: string; value?: { label: string; placeholder: string; suggest?: TicketContainerKind } }
> = {
  'delegated-to-papercusp': { label: 'Delegated to Papercusp' },
  'assigned-to-papercusp': { label: 'Assigned to Papercusp' },
  label: { label: 'Has a label', value: { label: 'Label', placeholder: 'needs-agent' } },
  team: { label: 'In a team', value: { label: 'Team', placeholder: 'ENG', suggest: 'team' } },
  project: { label: 'In a project', value: { label: 'Project', placeholder: 'Website', suggest: 'project' } },
};

/** The work kinds a rule may admit as (ADMITTED_KINDS); keyed by the server's union for the same reason. */
const WORK_KINDS: Record<AdmittedKind, string> = { change: 'Change', bug: 'Bug', task: 'Task' };

/** The canonical columns (TICKET_STATUS_CATEGORIES) an Asana-style section can map to (D-011). */
const CATEGORIES: Record<TicketStatusCategory, string> = {
  triage: 'Triage',
  backlog: 'Backlog',
  todo: 'To do',
  'in-progress': 'In progress',
  'in-review': 'In review',
  done: 'Done',
  canceled: 'Canceled',
};
/** Radix Select refuses an empty item value, so "no mapping" is this sentinel, never ''. */
const UNMAPPED = 'default';

// ── requests ──────────────────────────────────────────────────────────────────────────────────

const sourcePath = (sourceId: string, rest: string) => `/sources/${encodeURIComponent(sourceId)}${rest}`;

/**
 * Start a provider's OAuth flow. A browser follows the redirect. The desktop webview cannot host a
 * provider's sign-in, so there the page asks for the authorization URL and opens it in the system
 * browser, the same handoff Personal Vault uses for Google. Resolves true when it opened a browser.
 */
async function startConnect(href: string): Promise<boolean> {
  if (!isDesktop()) {
    window.location.assign(href);
    return false;
  }
  const url = new URL(href, window.location.href);
  url.searchParams.set('response', 'json');
  const res = await fetch(url.pathname + url.search, { cache: 'no-store' });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; authorizationUrl?: unknown; error?: unknown } | null;
  if (!res.ok || !json?.ok || typeof json.authorizationUrl !== 'string') {
    throw new Error(typeof json?.error === 'string' ? json.error : `HTTP ${res.status}`);
  }
  const authorizationUrl = new URL(json.authorizationUrl);
  if (authorizationUrl.protocol !== 'https:' || !isExternalWebUrl(authorizationUrl.toString(), window.location.href)) {
    throw new Error('the OAuth server returned an unsafe authorization URL');
  }
  await openExternalWebUrl(authorizationUrl.toString());
  return true;
}

// ── small helpers ─────────────────────────────────────────────────────────────────────────────

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function strings(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const splitIds = (text: string): string[] => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

const count = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? '' : 's'}`;

function harnessOptions(harnesses: string[], current: string): SelectOption[] {
  const all = current && !harnesses.includes(current) ? [current, ...harnesses] : harnesses;
  return all.map((slug) => ({ value: slug, label: slug }));
}

// ── page ──────────────────────────────────────────────────────────────────────────────────────

export default function IntegrationsSettingsPage() {
  const { overview, loadError, refresh } = useTicketIntegrations();

  const harnessQuery = useSyncQuery<{ slug?: string }>({ queryName: 'harnessProjects.lite', args: {}, staleTime: 60_000 });
  const harnesses = useMemo(
    () => [...new Set((harnessQuery.data ?? []).map((h) => str(h.slug)).filter(Boolean))].sort(),
    [harnessQuery.data],
  );

  const [openSource, setOpenSource] = useQueryState('source', parseAsString.withDefault(''));
  const [panel, setPanel] = useQueryState('panel', parseAsStringEnum<Panel>([...PANELS]).withDefault('scope'));
  const openPanel = useCallback(
    (sourceId: string, next: Panel) => {
      void setOpenSource(sourceId);
      void setPanel(next);
    },
    [setOpenSource, setPanel],
  );
  const closePanel = useCallback(() => {
    void setOpenSource(null);
    void setPanel(null);
  }, [setOpenSource, setPanel]);

  return (
    <div>
      <h1>Integrations</h1>
      <p className="pc-settings-intro">
        Every integration installed from the Cupboard appears here. Connect each one, choose what it syncs, then set up and
        arm the workflows that act on what arrives.
      </p>

      {loadError && !overview && (
        <p role="alert" style={alertText}>
          Couldn’t load integrations: {loadError}
        </p>
      )}
      {!overview && !loadError && (
        <p role="status" style={muteText}>
          Loading integrations…
        </p>
      )}
      {overview && overview.providers.length === 0 && (
        <p style={muteText}>No integrations are installed. Install one from the Cupboard and it adds itself here.</p>
      )}
      {overview?.providers.map((provider) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          sources={overview.sources.filter((source) => source.provider === provider.id)}
          harnesses={harnesses}
          openSource={openSource}
          panel={panel}
          onOpen={openPanel}
          onClose={closePanel}
          onSaved={refresh}
        />
      ))}
      {overview && overview.triggerPacks.length + (overview.availableTriggerPacks?.length ?? 0) > 0 && (
        <>
          <h2 style={groupTitle}>Workflows</h2>
          {overview.triggerPacks.map((pack) => (
            <TriggerPackSection key={pack.installationId} pack={pack} onChanged={refresh} />
          ))}
          {(overview.availableTriggerPacks ?? []).map((pack) => (
            <TriggerPackSetup key={`setup:${pack.pluginName}`} pack={pack} harnesses={harnesses} onChanged={refresh} />
          ))}
        </>
      )}
    </div>
  );
}

// ── provider card ─────────────────────────────────────────────────────────────────────────────

/** A credentials-only provider's status, from its declared fields (never a stored value). */
function credentialStatus(provider: TicketProviderSummary): string {
  // A per-person field is each reader's own and never part of connecting the provider (D-026).
  const fields = provider.credentials.filter((field) => !field.perPrincipal);
  const missing = fields.filter((field) => !field.configured).length;
  if (fields.length === 0) return 'Nothing to set up';
  return missing === 0 ? 'Connected' : `Needs ${missing} of ${fields.length} credential${fields.length === 1 ? '' : 's'}`;
}

function ProviderCard({
  provider,
  sources,
  harnesses,
  openSource,
  panel,
  onOpen,
  onClose,
  onSaved,
}: {
  provider: TicketProviderSummary;
  sources: TicketSourceSummary[];
  harnesses: string[];
  openSource: string;
  panel: Panel;
  onOpen: (sourceId: string, panel: Panel) => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const connect = useCallback(async () => {
    if (!provider.connectHref) return;
    setConnecting(true);
    try {
      if (await startConnect(provider.connectHref)) {
        toast.success(`${provider.displayName} sign-in opened in your browser. Finish there; this page updates by itself.`);
      }
    } catch (err) {
      toast.error(`Couldn’t start ${provider.displayName} sign-in: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setConnecting(false);
    }
  }, [provider]);

  return (
    <section className="pc-settings-section" aria-label={provider.displayName} data-provider={provider.id} style={cardStyle}>
      <div style={cardHead}>
        <div style={{ minWidth: 0 }}>
          <h2 style={cardTitle}>{provider.displayName}</h2>
          <div style={chipRow} aria-label={`${provider.displayName} capabilities`}>
            {provider.capabilities.map((capability) => (
              <code key={capability} style={chipStyle}>
                {capability}
              </code>
            ))}
          </div>
        </div>
        {provider.connectHref ? (
          <Button
            variant={sources.length > 0 ? 'neutral' : 'primary'}
            onClick={() => void connect()}
            // Sign-in cannot start until the owner's OAuth app is registered (P-009).
            disabled={connecting || provider.oauthClient?.configured === false}
            title={provider.oauthClient?.configured === false ? `Register your ${provider.displayName} OAuth app first` : undefined}
          >
            {sources.length > 0 ? 'Connect another account' : `Connect ${provider.displayName}`}
          </Button>
        ) : (
          <span role="status" style={metaText}>
            {credentialStatus(provider)}
          </span>
        )}
      </div>
      {!provider.oauthClient?.instanceRequired ? <ProviderAppRegistration providerId={provider.id} displayName={provider.displayName} registration={provider.appRegistration} /> : null}
      <ProviderOAuthClientForm providerId={provider.id} displayName={provider.displayName} client={provider.oauthClient ?? null} appRegistration={provider.appRegistration} />
      <ProviderCredentialsForm providerId={provider.id} displayName={provider.displayName} credentials={provider.credentials} />
      <ProviderSourceSettingsForm
        providerId={provider.id}
        displayName={provider.displayName}
        offer={provider.sourceSettings}
        sources={sources}
      />
      {sources.length === 0 ? (
        <p style={muteText}>No {provider.displayName} account connected.</p>
      ) : (
        sources.map((source) => (
          <SourceRow
            key={source.id}
            source={source}
            provider={provider}
            harnesses={harnesses}
            panel={openSource === source.id ? panel : null}
            onOpen={(next) => onOpen(source.id, next)}
            onClose={onClose}
            onReconnect={() => void connect()}
            reconnecting={connecting}
            onSaved={onSaved}
          />
        ))
      )}
    </section>
  );
}

// ── one connected account ─────────────────────────────────────────────────────────────────────

const PANEL_TITLES: Record<Panel, string> = { scope: 'What syncs', mapping: 'Status mapping', rules: 'Rules' };

function SourceRow({
  source,
  provider,
  harnesses,
  panel,
  onOpen,
  onClose,
  onReconnect,
  reconnecting,
  onSaved,
}: {
  source: TicketSourceSummary;
  provider: TicketProviderSummary;
  harnesses: string[];
  panel: Panel | null;
  onOpen: (panel: Panel) => void;
  onClose: () => void;
  onReconnect: () => void;
  reconnecting: boolean;
  onSaved: () => void;
}) {
  const label = sourceLabel(source);
  const needs = missingLabels(source.missingConfig);
  const enabledRules = source.rules.filter((rule) => rule.enabled).length;
  const panelId = `integration-panel-${source.id}`;

  return (
    <div style={rowStyle} data-source={source.id}>
      <div style={rowHead}>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: 'var(--fg)' }}>{label}</span>
          <StatusBadge status={source.status} />
          {provider.tracksTickets && (
            <div style={metaText}>
              {source.lastSyncAt ? `Last synced ${formatTime(source.lastSyncAt)}` : 'Not synced yet'}
              {' · '}
              {count(source.mirrored, 'ticket')} mirrored{' · '}
              {source.admitted} admitted as work
            </div>
          )}
          {needs.length > 0 && (
            <p role="status" style={warnText}>
              Needs {joinWords(needs)} before it can sync.
            </p>
          )}
          {source.lastError && (
            <p style={errorText}>
              Last error: {source.lastError}
              {source.failureCount > 1 ? ` (${source.failureCount} failures in a row)` : ''}
            </p>
          )}
        </div>
        <div style={actionRow}>
          {(provider.tracksTickets ? PANELS : []).map((p) => (
            <Button
              key={p}
              size="sm"
              variant={panel === p ? 'accent' : 'ghost'}
              aria-expanded={panel === p}
              aria-controls={panelId}
              onClick={() => (panel === p ? onClose() : onOpen(p))}
            >
              {p === 'rules' ? `Rules (${enabledRules})` : PANEL_TITLES[p]}
            </Button>
          ))}
          {provider.connectHref && (
            <Button size="sm" variant="ghost" onClick={onReconnect} disabled={reconnecting}>
              Reconnect
            </Button>
          )}
        </div>
      </div>
      {panel && provider.tracksTickets && <SourceDetail id={panelId} source={source} provider={provider} harnesses={harnesses} panel={panel} />}
      {!provider.tracksTickets && provider.sourceConfigSchema && (
        <ProviderSourceConfigForm key={JSON.stringify(source.config)} source={source} displayName={provider.displayName} schema={provider.sourceConfigSchema} onSaved={onSaved} />
      )}
    </div>
  );
}

/**
 * The account name a source row shows. A source created from pasted credentials (D-006) is keyed
 * `provider-setup:<providerId>`, a credential-store reference rather than an account, so it reads
 * as "Saved credentials" until the provider reports an identity (accountLabel).
 */
function sourceLabel(source: Pick<TicketSourceSummary, 'accountLabel' | 'providerAccountId'>): string {
  if (source.accountLabel) return source.accountLabel;
  if (source.providerAccountId?.startsWith('provider-setup:')) return 'Saved credentials';
  return source.providerAccountId ?? 'Unnamed account';
}

function StatusBadge({ status }: { status: string }) {
  const color = status === 'connected' ? 'var(--good)' : status === 'disabled' ? 'var(--fg-mute)' : 'var(--bad)';
  return (
    <span style={{ marginLeft: 8, fontSize: 12, color }} data-status={status}>
      ● {status}
    </span>
  );
}

// ── the provider's own container list (teams, workspaces, projects) ───────────────────────────

type ContainersResult =
  | { state: 'loading' }
  | { state: 'ready'; list: TicketContainerList }
  | { state: 'unsupported' }
  | { state: 'failed'; message: string };

interface SourceContainers {
  result: ContainersResult;
  retry: () => void;
}

/** Ask the provider for the source's teams/projects once per open source (D-014.3). */
function useSourceContainers(source: TicketSourceSummary, provider: TicketProviderSummary): SourceContainers {
  const [result, setResult] = useState<ContainersResult>(
    provider.canListContainers ? { state: 'loading' } : { state: 'unsupported' },
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!provider.canListContainers) return;
    let cancelled = false;
    setResult({ state: 'loading' });
    request<TicketContainerList>(sourcePath(source.id, '/containers'), 'POST', { args: {} })
      .then(({ containers, truncated }) => {
        if (!cancelled) setResult({ state: 'ready', list: { containers, truncated } });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof IntegrationRequestError && err.code === 'provider_capability_unsupported') {
          setResult({ state: 'unsupported' });
        } else {
          setResult({ state: 'failed', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [provider.canListContainers, source.id, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { result, retry };
}

function ContainersNotice({ containers, provider }: { containers: SourceContainers; provider: TicketProviderSummary }) {
  const { result } = containers;
  if (result.state === 'loading') {
    return (
      <p role="status" style={muteText}>
        Asking {provider.displayName} for this account’s teams and projects…
      </p>
    );
  }
  if (result.state === 'failed') {
    return (
      <p role="alert" style={errorText}>
        Couldn’t list this account’s teams and projects: {result.message}.{' '}
        <Button size="mini" variant="ghost" onClick={containers.retry}>
          Try again
        </Button>{' '}
        You can still enter ids below.
      </p>
    );
  }
  if (result.state === 'unsupported') {
    return <p style={muteText}>{provider.displayName} can’t list its teams or projects here, so enter their ids.</p>;
  }
  return result.list.truncated ? (
    <p style={warnText}>{provider.displayName} stopped before listing everything, so some may be missing.</p>
  ) : null;
}

function SourceDetail({
  id,
  source,
  provider,
  harnesses,
  panel,
}: {
  id: string;
  source: TicketSourceSummary;
  provider: TicketProviderSummary;
  harnesses: string[];
  panel: Panel;
}) {
  const containers = useSourceContainers(source, provider);
  // A saved config re-seeds the forms from the server, so a draft never outlives the save it made.
  const configKey = JSON.stringify(source.config);
  return (
    <div id={id} role="region" aria-label={PANEL_TITLES[panel]} style={detailStyle}>
      {panel === 'scope' && (
        <ScopePanel key={configKey} source={source} provider={provider} harnesses={harnesses} containers={containers} />
      )}
      {panel === 'mapping' && <MappingPanel key={configKey} source={source} provider={provider} containers={containers} />}
      {panel === 'rules' && <RulesPanel source={source} harnesses={harnesses} containers={containers} />}
    </div>
  );
}

// ── what syncs ────────────────────────────────────────────────────────────────────────────────

function ScopePanel({
  source,
  provider,
  harnesses,
  containers,
}: {
  source: TicketSourceSummary;
  provider: TicketProviderSummary;
  harnesses: string[];
  containers: SourceContainers;
}) {
  const listed = containers.result.state === 'ready' ? containers.result.list.containers : null;
  const pickerKinds = listed ? KIND_ORDER.filter((kind) => listed.some((c) => c.kind === kind)) : [];
  // Without a list, offer an id field for each container key the provider requires or already has.
  const manualKinds =
    listed || containers.result.state === 'loading'
      ? []
      : KIND_ORDER.filter((kind) => {
          const { key } = CONTAINER_KEYS[kind];
          return provider.requiredConfig.includes(key) || source.config[key] !== undefined;
        });

  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(KIND_ORDER.map((kind) => [CONTAINER_KEYS[kind].key, strings(source.config[CONTAINER_KEYS[kind].key])])),
  );
  const [manual, setManual] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      KIND_ORDER.map((kind) => [CONTAINER_KEYS[kind].key, strings(source.config[CONTAINER_KEYS[kind].key]).join(', ')]),
    ),
  );
  const [harness, setHarness] = useState(str(source.config.harnessSlug));
  const [saving, setSaving] = useState(false);

  const workspaceKey = CONTAINER_KEYS.workspace.key;
  const projectKey = CONTAINER_KEYS.project.key;
  const workspaceId = selected[workspaceKey]?.[0] ?? '';

  const toggle = (kind: TicketContainerKind, id: string, checked?: boolean) => {
    const { key, many } = CONTAINER_KEYS[kind];
    setSelected((prev) => {
      const current = prev[key] ?? [];
      const selected = current.includes(id);
      const include = checked ?? !selected;
      const next = {
        ...prev,
        [key]: many
          ? include
            ? (selected ? current : [...current, id])
            : current.filter((x) => x !== id)
          : [id],
      };
      if (kind === 'workspace' && listed) {
        // A project belongs to one workspace, so changing workspace drops projects outside it.
        const inWorkspace = new Set(listed.filter((c) => c.kind === 'project' && c.parentId === id).map((c) => c.id));
        next[projectKey] = (prev[projectKey] ?? []).filter((p) => inWorkspace.has(p));
      }
      return next;
    });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const patch: Record<string, unknown> = { harnessSlug: harness || null };
    for (const kind of listed ? pickerKinds : manualKinds) {
      const { key, many } = CONTAINER_KEYS[kind];
      const ids = listed ? selected[key] ?? [] : splitIds(manual[key] ?? '');
      patch[key] = ids.length === 0 ? null : many ? ids : ids[0];
    }
    setSaving(true);
    try {
      const result = await request<{ missingConfig: string[] }>(sourcePath(source.id, '/config'), 'PATCH', { patch });
      toast.success(
        result.missingConfig.length === 0
          ? `Saved. ${provider.displayName} syncs this account shortly.`
          : `Saved. It still needs ${joinWords(missingLabels(result.missingConfig))}.`,
      );
    } catch (err) {
      toast.error(`Couldn’t save: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} aria-label="What syncs" style={formStyle}>
      <ContainersNotice containers={containers} provider={provider} />

      {listed &&
        pickerKinds.map((kind) => {
          const { key, many, label } = CONTAINER_KEYS[kind];
          const chosen = selected[key] ?? [];
          let items = listed.filter((c) => c.kind === kind);
          if (kind === 'project' && pickerKinds.includes('workspace')) {
            if (!workspaceId) {
              return (
                <p key={kind} style={muteText}>
                  Choose a workspace to see its projects.
                </p>
              );
            }
            items = items.filter((c) => !c.parentId || c.parentId === workspaceId);
          }
          if (!many) {
            return (
              <label key={kind} style={fieldLabel}>
                {label}
                <Select
                  value={chosen[0] ?? ''}
                  onChange={(id) => toggle(kind, id)}
                  options={items.map((c) => ({ value: c.id, label: c.name }))}
                  placeholder={`Choose a ${label.toLowerCase()}`}
                  ariaLabel={label}
                />
              </label>
            );
          }
          // A configured id the provider no longer lists stays visible, so saving never drops it silently.
          const orphans: TicketContainer[] = chosen
            .filter((id) => !items.some((c) => c.id === id))
            .map((id) => ({ id, name: `${id} (not listed)`, kind }));
          return (
            <fieldset key={kind} style={fieldsetStyle}>
              <legend style={legendStyle}>{label}</legend>
              {items.length + orphans.length === 0 ? (
                <p style={muteText}>None listed.</p>
              ) : (
                [...items, ...orphans].map((c) => (
                  <label key={c.id} style={checkLabel}>
                    <Checkbox ariaLabel={c.name} checked={chosen.includes(c.id)} onChange={(checked) => toggle(kind, c.id, checked)} />
                    <span>{c.name}</span>
                    {c.key ? <code style={chipStyle}>{c.key}</code> : null}
                  </label>
                ))
              )}
            </fieldset>
          );
        })}

      {manualKinds.map((kind) => {
        const { key, many, label } = CONTAINER_KEYS[kind];
        return (
          <label key={kind} style={fieldLabel}>
            {many ? `${label} (ids, comma-separated)` : `${label} (id)`}
            <input
              value={manual[key] ?? ''}
              onChange={(event) => setManual((prev) => ({ ...prev, [key]: event.target.value }))}
              aria-label={label}
              style={inputStyle}
            />
          </label>
        );
      })}

      <label style={fieldLabel}>
        Store tickets in
        <Select
          value={harness}
          onChange={setHarness}
          options={harnessOptions(harnesses, harness)}
          placeholder="Choose a harness"
          ariaLabel="Harness to store tickets in"
        />
        <span style={hintText}>Mirrored tickets live in this harness. A rule can still admit them as work into any harness.</span>
      </label>

      <div>
        <Button type="submit" variant="primary" disabled={saving || containers.result.state === 'loading'}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

// ── status mapping ────────────────────────────────────────────────────────────────────────────

function MappingPanel({
  source,
  provider,
  containers,
}: {
  source: TicketSourceSummary;
  provider: TicketProviderSummary;
  containers: SourceContainers;
}) {
  if (provider.statusMapping === 'provider-defined') {
    return (
      <p style={bodyText}>
        {provider.displayName} decides each ticket’s column from its own workflow-state types: a started state is In
        progress, a completed one is Done. There is nothing to map here.
      </p>
    );
  }
  return <SectionMapping source={source} provider={provider} containers={containers} />;
}

const CATEGORY_OPTIONS: SelectOption[] = [
  { value: UNMAPPED, label: 'Default (To do)' },
  ...Object.entries(CATEGORIES).map(([value, label]) => ({ value, label })),
];

function SectionMapping({
  source,
  provider,
  containers,
}: {
  source: TicketSourceSummary;
  provider: TicketProviderSummary;
  containers: SourceContainers;
}) {
  const saved = isRecord(source.config.sectionCategories) ? source.config.sectionCategories : {};
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  );
  const [saving, setSaving] = useState(false);
  const configured = strings(source.config[CONTAINER_KEYS.project.key]);

  if (configured.length === 0) {
    return <p style={muteText}>Choose projects under What syncs first; their sections appear here.</p>;
  }
  if (containers.result.state !== 'ready') {
    return <ContainersNotice containers={containers} provider={provider} />;
  }
  const projects = containers.result.list.containers.filter(
    (c) => c.kind === 'project' && configured.includes(c.id) && (c.sections?.length ?? 0) > 0,
  );

  // The provider matches a mapping by section id or lower-cased name (D-011), so read both.
  const valueFor = (section: { id: string; name: string }) => draft[section.id] ?? draft[section.name.toLowerCase()] ?? UNMAPPED;
  const setValue = (section: { id: string; name: string }, value: string) =>
    setDraft((prev) => {
      const next = { ...prev };
      delete next[section.name.toLowerCase()];
      if (value === UNMAPPED) delete next[section.id];
      else next[section.id] = value;
      return next;
    });

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await request(sourcePath(source.id, '/config'), 'PATCH', {
        patch: { sectionCategories: Object.keys(draft).length > 0 ? draft : null },
      });
      toast.success('Status mapping saved. Tickets move to their new columns on the next sync.');
    } catch (err) {
      toast.error(`Couldn’t save the mapping: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void save(event)} aria-label="Status mapping" style={formStyle}>
      <p style={hintText}>Completed tasks are always Done. Map each section to the column its open tasks belong in.</p>
      {projects.length === 0 && <p style={muteText}>The chosen projects have no sections listed.</p>}
      {projects.map((project) => (
        <fieldset key={project.id} style={fieldsetStyle}>
          <legend style={legendStyle}>{project.name}</legend>
          {(project.sections ?? []).map((section) => (
            <div key={section.id} style={mapRow}>
              <span style={{ flex: '1 1 auto', color: 'var(--fg)' }}>{section.name}</span>
              <Select
                value={valueFor(section)}
                onChange={(value) => setValue(section, value)}
                options={CATEGORY_OPTIONS}
                ariaLabel={`Column for ${section.name}`}
              />
            </div>
          ))}
        </fieldset>
      ))}
      <div>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save mapping'}
        </Button>
      </div>
    </form>
  );
}

// ── admission rules ───────────────────────────────────────────────────────────────────────────

const PRESET_OPTIONS: SelectOption[] = Object.entries(PRESETS).map(([value, spec]) => ({ value, label: spec.label }));
const KIND_OPTIONS: SelectOption[] = Object.entries(WORK_KINDS).map(([value, label]) => ({ value, label }));

function RulesPanel({
  source,
  harnesses,
  containers,
}: {
  source: TicketSourceSummary;
  harnesses: string[];
  containers: SourceContainers;
}) {
  const [preset, setPreset] = useState<TicketRulePreset>('delegated-to-papercusp');
  const [value, setValue] = useState('');
  const [harness, setHarness] = useState(str(source.config.harnessSlug));
  const [workKind, setWorkKind] = useState<AdmittedKind>('change');
  const [busy, setBusy] = useState<string | null>(null);
  const spec = PRESETS[preset];
  const suggestKind = spec.value?.suggest;
  const suggestions = useMemo(() => {
    if (!suggestKind || containers.result.state !== 'ready') return [];
    const names = containers.result.list.containers.filter((c) => c.kind === suggestKind).map((c) => c.key ?? c.name);
    return [...new Set(names)];
  }, [suggestKind, containers.result]);
  const listId = `integration-rule-values-${source.id}`;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    if (spec.value && !value.trim()) {
      toast.error(`Enter a ${spec.value.label.toLowerCase()} for this rule.`);
      return;
    }
    if (!harness) {
      toast.error('Choose the harness the work goes to.');
      return;
    }
    setBusy('add');
    try {
      const result = await request<SetAdmissionRuleResult>(sourcePath(source.id, '/rules'), 'POST', {
        preset,
        ...(spec.value ? { value: value.trim() } : {}),
        harness,
        workKind,
      });
      const admitted = result.backfill?.admitted ?? 0;
      // A bug the intake recognised as already filed is admitted onto that bug, not as a new one.
      const folded = result.backfill?.folded ?? 0;
      toast.success(
        admitted + folded === 0
          ? 'Rule added. No synced ticket matches it yet.'
          : `Rule added. ${count(admitted + folded, 'synced ticket')} admitted as work` +
              (folded > 0 ? ` (${folded} attached to a bug that was already filed).` : '.'),
      );
      setValue('');
    } catch (err) {
      toast.error(`Couldn’t add the rule: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const disable = async (ruleId: string) => {
    setBusy(ruleId);
    try {
      await request(sourcePath(source.id, `/rules/${encodeURIComponent(ruleId)}`), 'DELETE');
      toast.success('Rule disabled. Work it already admitted stays.');
    } catch (err) {
      toast.error(`Couldn’t disable the rule: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={formStyle}>
      {source.rules.length === 0 ? (
        <p style={muteText}>No rules yet. Tickets mirror into Papercusp, but none becomes work until a rule matches it.</p>
      ) : (
        <ul style={ruleList} aria-label="Admission rules">
          {source.rules.map((rule) => (
            <li key={rule.id} style={ruleRow} data-rule={rule.id}>
              <div style={{ minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: 'var(--fg)', opacity: rule.enabled ? 1 : 0.6 }}>{rule.title}</span>
                <div style={metaText}>
                  {WORK_KINDS[rule.workKind] ?? rule.workKind} in {rule.harness}
                  {rule.enabled ? '' : ' · disabled'}
                </div>
              </div>
              {rule.enabled && (
                <Button size="sm" variant="ghost" onClick={() => void disable(rule.id)} disabled={busy === rule.id}>
                  Disable
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void add(event)} aria-label="Add a rule" style={addRuleForm}>
        <label style={fieldLabel}>
          Admit tickets that are
          <Select
            value={preset}
            onChange={(next) => setPreset(next as TicketRulePreset)}
            options={PRESET_OPTIONS}
            ariaLabel="Rule"
          />
        </label>
        {spec.value && (
          <label style={fieldLabel}>
            {spec.value.label}
            <input
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={spec.value.placeholder}
              aria-label={spec.value.label}
              list={suggestions.length > 0 ? listId : undefined}
              style={inputStyle}
            />
            {suggestions.length > 0 && (
              <datalist id={listId}>
                {suggestions.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            )}
          </label>
        )}
        <label style={fieldLabel}>
          as a
          <Select value={workKind} onChange={(next) => setWorkKind(next as AdmittedKind)} options={KIND_OPTIONS} ariaLabel="Work kind" />
        </label>
        <label style={fieldLabel}>
          in
          <Select
            value={harness}
            onChange={setHarness}
            options={harnessOptions(harnesses, harness)}
            placeholder="Choose a harness"
            ariaLabel="Target harness"
          />
        </label>
        <Button type="submit" variant="primary" disabled={busy === 'add'}>
          {busy === 'add' ? 'Adding…' : 'Add rule'}
        </Button>
      </form>
      <p style={hintText}>A ticket labelled bug is admitted as a bug, whatever kind the rule names.</p>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────────────────────

const muteText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 13, margin: '6px 0' };
const bodyText: CSSProperties = { color: 'var(--fg)', fontSize: 13, margin: '6px 0' };
const hintText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12 };
const alertText: CSSProperties = { color: 'var(--bad)', fontSize: 13, marginBottom: 16 };
const warnText: CSSProperties = { color: 'var(--warn, #d29922)', fontSize: 12, margin: '4px 0 0' };
const errorText: CSSProperties = { color: 'var(--bad)', fontSize: 12, margin: '4px 0 0', overflowWrap: 'anywhere' };
const metaText: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, marginTop: 2 };
const cardStyle: CSSProperties = { marginBottom: 20 };
const cardHead: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 };
const cardTitle: CSSProperties = { fontSize: 16, margin: 0 };
const groupTitle: CSSProperties = { fontSize: 18, margin: '28px 0 12px' };
const chipRow: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 };
const chipStyle: CSSProperties = {
  fontSize: 11,
  padding: '1px 6px',
  borderRadius: 4,
  background: 'var(--bg-2)',
  color: 'var(--fg-mute)',
  marginLeft: 4,
};
const rowStyle: CSSProperties = { borderTop: '1px solid var(--border, rgba(127,127,127,0.25))', padding: '10px 0' };
const rowHead: CSSProperties = { display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' };
const actionRow: CSSProperties = { display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' };
const detailStyle: CSSProperties = {
  marginTop: 10,
  padding: 12,
  borderRadius: 6,
  background: 'var(--bg-2)',
};
const formStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 };
const fieldLabel: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--fg-mute)' };
const fieldsetStyle: CSSProperties = {
  border: '1px solid var(--border, rgba(127,127,127,0.25))',
  borderRadius: 6,
  padding: '8px 10px',
  margin: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};
const legendStyle: CSSProperties = { fontSize: 12, color: 'var(--fg-mute)', padding: '0 4px' };
const checkLabel: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--fg)' };
const inputStyle: CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border, rgba(127,127,127,0.35))',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 13,
};
const mapRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 };
const ruleList: CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 };
const ruleRow: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 };
const addRuleForm: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'flex-end' };
