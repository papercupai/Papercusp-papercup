'use client';

import { useQueryState, parseAsString } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { IdentityUsageStatementLine } from '@papercusp/operator-core/lib/cupboard/commerce-dashboards';
import type { MeteredDoorFailure, PrincipalUsagePage } from '@papercusp/operator-core/lib/cupboard/metered-invocation-door-io';
import { Button } from '../harness/Button';

/** Exact USD decimal display; never round a micros string through Number. */
export function formatUsageMicros(value: string): string {
  const micros = BigInt(value);
  return `$${micros / 1_000_000n}.${(micros % 1_000_000n).toString().padStart(6, '0')}`;
}

const moneyColumn = (key: string, header: string, value: (line: IdentityUsageStatementLine) => string): ColumnDef<IdentityUsageStatementLine> => ({
  key, header, width: '170px', align: 'right', toCopyText: line => formatUsageMicros(value(line)),
  render: ({ row }) => formatUsageMicros(value(row)),
});

const columns: ColumnDef<IdentityUsageStatementLine>[] = [
  { key: 'identity', header: 'Identity / receipt', width: 'minmax(300px, 2fr)',
    toCopyText: row => `${row.releaseRef} · ${row.channelId}/${row.usageNonce}`,
    render: ({ row }) => <div><div>{row.releaseRef}</div><small>{row.channelId} / {row.usageNonce}</small>
      <div><small>Buyer {row.payer} · Seller {row.seller}</small></div></div> },
  moneyColumn('inference', 'Inference (your provider)', row => row.billedInferenceMicros),
  moneyColumn('markup', 'Identity markup', row => row.markupMicros),
  moneyColumn('creator', 'Creator quote', row => row.allocationQuote.creatorMicros),
  moneyColumn('dao', 'DAO quote', row => row.allocationQuote.daoMicros),
  { key: 'components', header: 'Component quote', width: 'minmax(210px, 1fr)',
    toCopyText: row => formatUsageMicros(row.allocationQuote.componentMicros),
    render: ({ row }) => <div>{formatUsageMicros(row.allocationQuote.componentMicros)}
      {row.allocationQuote.componentAuthorsMicros === null ? <div><small>Author allocation unavailable</small></div> :
        Object.entries(row.allocationQuote.componentAuthorsMicros).map(([author, micros]) =>
          <div key={author}><small>{author}: {formatUsageMicros(micros)}</small></div>)}
    </div> },
];

type UsageRead = { readonly ok: true; readonly page: PrincipalUsagePage } | MeteredDoorFailure;

export default function IdentityStatements() {
  const [cursor, setCursor] = useQueryState('usageCursor', parseAsString);
  const query = useSyncQuery<UsageRead>({ queryName: 'cupboard.identityUsage',
    args: { limit: 100, ...(cursor === null ? {} : { cursor }) }, staleTime: 0 });
  const read = query.data?.[0];
  const busy = query.loading || query.fetching;
  const page = !busy && !query.error && read?.ok ? read.page : null;
  const error = query.error ? String(query.error) : read?.ok === false ? read.detail : null;
  return (
    <section aria-label="Identity usage statement" style={{ padding: 24 }}>
      <h2>Identity usage</h2>
      <p>This page shows your purchases and sales. Inference is paid through your provider; markup is charged separately.</p>
      <p>Split amounts are quotes, not payouts. Inference costs can repeat across stacked identities and are not added together here.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <Button onClick={() => query.invalidate()} disabled={busy}>Refresh</Button>
        <Button onClick={() => void setCursor(null)} disabled={busy || cursor === null}>First page</Button>
        <Button onClick={() => { if (page?.nextCursor) void setCursor(page.nextCursor); }}
          disabled={busy || !page?.nextCursor}>Next page</Button>
      </div>
      {busy ? <p role="status" aria-live="polite">Loading identity usage…</p> : error ?
        <div role="alert"><p>Identity usage is unavailable. No totals were measured.</p><p>{error}</p>
          <Button onClick={() => query.invalidate()}>Retry</Button></div> : page ? <>
          <p>Markup on this page: <strong>{formatUsageMicros(page.identityStatement.markupMicros)}</strong></p>
          <p>{page.identityStatement.reservedReceipts} identity receipt(s) awaiting settlement.</p>
          <p>{page.coverage.hasMore ? 'More receipt pages are available.' : 'End of the current receipt pages.'} Refresh to check for changes.</p>
          {!page.identityStatement.complete && <div role="alert">Some receipts could not be included:
            <ul>{page.identityStatement.issues.map(issue => <li key={JSON.stringify([issue.channelId, issue.usageNonce, issue.reason])}>
              {issue.channelId} / {issue.usageNonce}: {issue.reason}</li>)}</ul></div>}
          {page.identityStatement.lines.length === 0 ? <p>No settled identity usage on this page.</p> :
            <div style={{ overflowX: 'auto' }}><RichGrid columns={columns} rows={[...page.identityStatement.lines]}
              getRowId={row => JSON.stringify([row.channelId, row.usageNonce])} /></div>}
        </> : <p role="status">Identity usage has not been measured.</p>}
      <p>Cost per accepted outcome: unavailable — verified outcome evidence is not linked.</p>
    </section>
  );
}
