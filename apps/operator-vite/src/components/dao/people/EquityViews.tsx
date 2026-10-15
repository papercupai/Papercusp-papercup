import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { DaoCapTable, DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';

type Position = DaoCapTable['positions'][number];
const amount = (key: keyof Position, header: string): ColumnDef<Position> => ({ key, header, width: 1,
  toCopyText: row => String(row[key]), render: ({ row }) => String(row[key]) });
const columns: ColumnDef<Position>[] = [
  amount('displayName', 'Holder'), amount('wallet', 'Wallet'), amount('shares', 'Shares owned'),
  amount('committed', 'Grants committed'), amount('earned', 'Grants earned'), amount('claimed', 'Grants claimed'),
  amount('unvested', 'Grants unvested'), amount('returnEntitlements', 'Return entitlements'), amount('unclaimedReturns', 'Returns unclaimed'),
  { ...amount('ownershipPercent', '% owned'), render: ({ row }) => row.ownershipPercent + '%' },
  { ...amount('fullyDilutedPercent', '% fully diluted'), render: ({ row }) => row.fullyDilutedPercent + '%' },
];
export default function EquityViews({ view, mine, onRefresh }: { view: DaoWorkspaceView; mine: boolean; onRefresh?: () => void }) {
  const table = view.capTable;
  const title = mine ? 'My equity' : 'Cap table';
  if (table?.status !== 'ready') return <section aria-label={title}><h3>{title}</h3>
    <p role="status">{table?.message ?? 'Equity records are unavailable.'} <button type="button" onClick={onRefresh}>Refresh equity</button></p></section>;
  const snapshot = table.value;
  const rows = mine ? snapshot.positions.filter(row => row.isSelf) : snapshot.positions;
  return <section aria-label={title}><h3>{title}</h3>
    {snapshot.nonBinding ? <p role="note">test chain - non-binding</p> : <p>On-chain register · verify against issuer documents.</p>}
    <p>Chain {snapshot.chainId} · block {snapshot.blockNumber} · issued {snapshot.issuedShares} · reserved {snapshot.reservedShares} · fully diluted {snapshot.fullyDilutedShares}</p>
    {rows.length ? <div role="table" aria-label={title + ' positions'}><RichGrid rows={rows} columns={columns} getRowId={row => row.holderId} /></div> :
      <p>{mine ? 'No equity position is linked to your verified member wallet.' : 'No equity holders recorded.'}</p>}
    <p>Returns are additional equity. Unvested totals exclude forfeited shares from stopped grants.</p>
  </section>;
}
