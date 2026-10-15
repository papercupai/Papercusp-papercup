'use client';

/**
 * /admin/admission "Ticket sources": whether each connected ticket tracker syncs, what it has
 * mirrored, and how much of it became work (linear-asana-task-sync P-007, D-014.7). It renders the
 * same overview Settings → Integrations does, from the same read, and links each row there to fix it.
 */

import type { CSSProperties } from 'react';
import type { TicketSourceSummary } from '@papercusp/operator-core/lib/integrations/ticket-integrations';
import RouteLink from '@/app/_components/RouteLink';
import { Table, type TableColumn } from '@/app/harness/Table';
import {
  formatTime,
  INTEGRATIONS_SETTINGS_HREF,
  joinWords,
  missingLabels,
  useTicketIntegrations,
} from '@/app/settings/integrations/ticket-integrations-client';

interface Row {
  source: TicketSourceSummary;
  providerName: string;
}

/** What, if anything, keeps this source from syncing, in the order a user should fix it. */
function attention(source: TicketSourceSummary): string {
  if (source.missingConfig.length > 0) return `Needs ${joinWords(missingLabels(source.missingConfig))}`;
  if (source.lastError) return source.lastError;
  return '';
}

const COLUMNS: TableColumn<Row>[] = [
  { key: 'provider', header: 'Provider', render: (row) => row.providerName },
  {
    key: 'account',
    header: 'Account',
    render: (row) => row.source.accountLabel ?? row.source.providerAccountId ?? '—',
  },
  {
    key: 'status',
    header: 'Status',
    render: (row) => (
      <span
        data-status={row.source.status}
        style={{ color: row.source.status === 'connected' ? 'var(--good)' : row.source.status === 'disabled' ? 'var(--fg-mute)' : 'var(--bad)' }}
      >
        {row.source.status}
      </span>
    ),
  },
  {
    key: 'lastSync',
    header: 'Last sync',
    render: (row) => (row.source.lastSyncAt ? formatTime(row.source.lastSyncAt) : 'never'),
  },
  {
    key: 'nextAttempt',
    header: 'Next attempt',
    render: (row) => (row.source.nextAttemptAt ? formatTime(row.source.nextAttemptAt) : '—'),
  },
  { key: 'failures', header: 'Failures', render: (row) => row.source.failureCount, cellStyle: { fontVariantNumeric: 'tabular-nums' } },
  { key: 'mirrored', header: 'Mirrored', render: (row) => row.source.mirrored, cellStyle: { fontVariantNumeric: 'tabular-nums' } },
  { key: 'admitted', header: 'Admitted', render: (row) => row.source.admitted, cellStyle: { fontVariantNumeric: 'tabular-nums' } },
  {
    key: 'rules',
    header: 'Rules',
    render: (row) => `${row.source.rules.filter((rule) => rule.enabled).length} of ${row.source.rules.length}`,
  },
  {
    key: 'attention',
    header: 'Attention',
    render: (row) => {
      const text = attention(row.source);
      return text ? <span style={{ color: 'var(--bad)', overflowWrap: 'anywhere' }}>{text}</span> : '—';
    },
  },
  {
    key: 'configure',
    header: '',
    render: (row) => (
      <RouteLink href={`${INTEGRATIONS_SETTINGS_HREF}?source=${encodeURIComponent(row.source.id)}&panel=scope`}>Configure</RouteLink>
    ),
  },
];

export default function TicketSourcesHealth() {
  const { overview, loadError } = useTicketIntegrations();
  const names = new Map((overview?.providers ?? []).map((provider) => [provider.id, provider.displayName]));
  const rows: Row[] = (overview?.sources ?? []).map((source) => ({
    source,
    providerName: names.get(source.provider) ?? source.provider,
  }));

  return (
    <section aria-label="Ticket sources" style={SECTION_STYLE}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>Ticket sources</h2>
        <p style={MUTED_STYLE}>
          Connected ticket trackers: whether each syncs, what it mirrored, and how much became work. Fix one in{' '}
          <RouteLink href={INTEGRATIONS_SETTINGS_HREF}>Settings → Integrations</RouteLink>.
        </p>
      </div>
      {loadError && !overview ? (
        <p role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
          Couldn’t load ticket sources: {loadError}
        </p>
      ) : !overview ? (
        <p role="status" style={MUTED_STYLE}>
          Loading ticket sources…
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Table
            caption={`${rows.length} ticket source${rows.length === 1 ? '' : 's'}`}
            columns={COLUMNS}
            rows={rows}
            getRowKey={(row) => row.source.id}
            emptyLabel="No ticket tracker is connected."
          />
        </div>
      )}
    </section>
  );
}

const SECTION_STYLE: CSSProperties = { display: 'grid', gap: 12, marginTop: 24 };
const MUTED_STYLE: CSSProperties = { color: 'var(--fg-mute)', fontSize: 12, margin: '5px 0 0' };
