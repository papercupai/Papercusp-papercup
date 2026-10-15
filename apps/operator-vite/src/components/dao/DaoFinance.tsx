import { useEffect, useState } from 'react';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import { Select } from '@/app/harness/Select';
import type { DaoSection } from './dao-navigation';
import DaoPolicyEditor from './DaoPolicyEditor';
type RecordRead = { status: string; value?: Record<string, unknown>; message?: string };
interface Finance {
  policyVersion: number; bindings: { funding?: { agreementRef: string }; commerce?: { buyerOrgId: string } };
  wallet: { ok: boolean; value?: { binding?: { walletAddress: string; chainId: number } }; error?: string; detail?: string };
  treasury: RecordRead; equity: RecordRead; commerce: RecordRead;
  actions: Array<{ contract: string; name: string; inputs: Array<{ name: string; type: string }> }>;
}
export default function DaoFinance({ view, section, onChanged }: { view: DaoWorkspaceView; section: DaoSection; onChanged?: () => void }) {
  const [data, setData] = useState<Finance | null>(null);
  const [error, setError] = useState(''); const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0); const [wallet, setWallet] = useState(''); const [chain, setChain] = useState('1');
  const [challenge, setChallenge] = useState<{ challengeId: string; message: string } | null>(null); const [signature, setSignature] = useState('');
  const [selected, setSelected] = useState(''); const [args, setArgs] = useState('[]'); const [transaction, setTransaction] = useState<unknown>(null);
  const path = '/api/pot/' + encodeURIComponent(view.localHomeSlug!) + '/finance';
  async function request(action: object, signal?: AbortSignal) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action), signal });
    const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.detail || result.error || 'Account request failed.'); return result;
  }
  useEffect(() => {
    const controller = new AbortController(); setData(null); setError(''); setTransaction(null); setChallenge(null);
    void request({ op: 'inspect' }, controller.signal).then(result => { if (!controller.signal.aborted) setData(result); }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Account records unavailable.'); });
    return () => controller.abort();
  }, [path, reload]);
  async function act(action: object, receive: (result: any) => void) {
    if (pending) return; setPending(true); setError(''); setTransaction(null);
    try { receive(await request(action)); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action refused.'); } finally { setPending(false); }
  }
  const ownership = section === 'ownership' || section === 'returns';
  const record = data && (ownership ? data.equity : section === 'billing' ? data.commerce : data.treasury);
  const action = data?.actions.find(value => value.contract + '/' + value.name === selected);
  const binding = data?.wallet.ok ? data.wallet.value?.binding : undefined;
  const equity = data?.equity.value;
  const canPrepare = !!binding && equity?.governanceBound === true && equity?.supplyInvariant === true && data?.equity.status === 'ready';
  return <div className="dao-overview-grid"><section className="dao-card">
    <h2>{ownership ? 'Equity deployment & holder records' : section === 'billing' ? 'Commerce account' : section === 'funding' ? 'Funding agreement & accounts' : 'Treasury account'}</h2>
    <button className="dao-action" type="button" disabled={pending} onClick={() => setReload(value => value + 1)}>Refresh accounts</button>
    {error ? <p role="alert">{error}</p> : null}{!data && !error ? <p role="status">Reading bound accounts…</p> : null}
    {data ? <>
      <p>Owner policy version {data.policyVersion}</p>
      {section === 'funding' ? <p>Contribution agreement: {data.bindings.funding?.agreementRef ?? 'No owner-signed agreement reference recorded.'}</p> : null}
      {record?.status === 'not-bound' ? <p>No owner-signed account binding is recorded for this area. Configure it in the owner policy.</p> : record?.status === 'error' ? <p role="alert">{record.message}</p> : record?.status === 'ready' ? <>
        {ownership ? <dl><div><dt>Issued shares</dt><dd>{String(equity?.issuedShares)}</dd></div><div><dt>Reserved shares</dt><dd>{String(equity?.reservedShares)}</dd></div><div><dt>Observed block</dt><dd>{String(equity?.blockNumber)}</dd></div><div><dt>Governance binding</dt><dd>{equity?.governanceBound === true ? 'Verified contract relationships' : 'Integrity check failed'}</dd></div></dl> : null}
        <details><summary>Review account evidence</summary><pre>{JSON.stringify(record.value, null, 2)}</pre></details>
      </> : null}
      {ownership ? <>
        <p>Returns are additional equity. Chain records do not verify issuer documents or establish legal effectiveness.</p>
        <p>Your verified wallet: {binding ? binding.walletAddress + ' · chain ' + binding.chainId : data.wallet.detail || 'No verified wallet bound.'}</p>
        <form className="dao-proposal-form" onSubmit={event => { event.preventDefault(); void act({ op: 'wallet-challenge', walletAddress: wallet, chainId: Number(chain) }, result => setChallenge(result.value)); }}>
          <label>Wallet address<input value={wallet} onChange={event => { setWallet(event.target.value); setChallenge(null); }} required /></label><label>Wallet chain ID<input type="number" min="1" value={chain} onChange={event => { setChain(event.target.value); setChallenge(null); }} required /></label>
          <button className="dao-action" disabled={pending}>Request wallet signing challenge</button>
        </form>
        {challenge ? <section><h3>Sign this exact message in your wallet</h3><pre>{challenge.message}</pre><label>Wallet signature<input value={signature} onChange={event => setSignature(event.target.value)} /></label><button type="button" className="dao-action" disabled={pending || !signature} onClick={() => { void act({ op: 'wallet-verify', challengeId: challenge.challengeId, signature }, () => { setSignature(''); setReload(value => value + 1); }); }}>Verify wallet signature</button></section> : null}
        <form className="dao-proposal-form" onSubmit={event => { event.preventDefault(); if (!action || !canPrepare) return; let parsed: unknown; try { parsed = JSON.parse(args); } catch { setError('Action arguments must be a JSON array.'); return; } void act({ op: 'prepare-equity', expectedPolicyVersion: data.policyVersion, contract: action.contract, functionName: action.name, args: parsed }, result => setTransaction(result.unsignedTransaction)); }}>
          <label>Equity action<Select ariaLabel="Equity action" value={selected} onChange={value => { setSelected(value); setTransaction(null); }}
            disabled={!canPrepare || pending} placeholder="Choose an action" triggerClassName="h-select-trigger dao-select"
            options={data.actions.map(value => ({ value: value.contract + '/' + value.name, label: value.contract + ' · ' + value.name }))} /></label>
          {action ? <p>Arguments in order: {action.inputs.map(value => value.name + ' (' + value.type + ')').join(', ') || 'none'}</p> : null}
          <label>Action arguments (JSON array)<textarea value={args} onChange={event => { setArgs(event.target.value); setTransaction(null); }} disabled={!canPrepare || pending} /></label>
          <button className="dao-action" disabled={!canPrepare || !action || pending}>Prepare unsigned wallet transaction</button>
        </form>
        {transaction ? <section><h3>Review unsigned transaction</h3><p>Your wallet must authorize and sign this transaction. No transaction has been submitted.</p><pre>{JSON.stringify(transaction, null, 2)}</pre><a className="dao-action" download="dao-equity-unsigned.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(transaction, null, 2))}>Download unsigned transaction</a></section> : null}
      </> : null}
    </> : null}
  </section><DaoPolicyEditor view={view} onChanged={() => { onChanged?.(); setReload(value => value + 1); }} /></div>;
}
