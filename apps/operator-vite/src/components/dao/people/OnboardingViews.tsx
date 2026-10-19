import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { RichGrid, type ColumnDef } from '@papercusp/grid-core';
import type { readOnboarding } from '@papercusp/operator-core/lib/dao-hr/onboarding';
import type { UnsignedEquityTransaction } from '@papercusp/operator-core/lib/equity/runtime';

type View = Awaited<ReturnType<typeof readOnboarding>>;
type Step = View['checklist'][number];
type WalletProvider = { request(input: { method: string; params?: unknown[] }): Promise<unknown> };
export default function OnboardingViews({ daoSlug, offerId, onChanged }: { daoSlug: string; offerId: string; onChanged?: () => void }) {
  const [data, setData] = useState<View | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [transaction, setTransaction] = useState<UnsignedEquityTransaction | null>(null), [hash, setHash] = useState('');
  const [challenge, setChallenge] = useState<{ challengeId: string; message: string } | null>(null);
  const generation = useRef(0), url = '/api/pot/' + encodeURIComponent(daoSlug) + '/contracts/' + encodeURIComponent(offerId) + '/onboarding';
  const load = useCallback(async () => {
    const request = ++generation.current; setLoading(true); setError('');
    try {
      const response = await fetch(url), value = await response.json();
      if (!response.ok || !value.ok || !Array.isArray(value.onboarding?.checklist)) throw new Error(value.message || 'Onboarding could not be read.');
      if (request === generation.current) setData(value.onboarding);
    } catch (cause) { if (request === generation.current) { setData(null); setError(cause instanceof Error ? cause.message : 'Onboarding could not be read.'); } }
    finally { if (request === generation.current) setLoading(false); }
  }, [url]);
  useEffect(() => { setData(null); setTransaction(null); setHash(''); setChallenge(null); void load(); return () => { generation.current++; }; }, [load]);
  async function action(payload: unknown, receive?: (value: any) => void, notifyParent = true) {
    const request = generation.current; setBusy(true); setError('');
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.message || value.detail || 'The onboarding step was refused.');
      if (request !== generation.current) return;
      receive?.(value.result); await load(); if (notifyParent) onChanged?.();
    } catch (cause) { if (request === generation.current) setError(cause instanceof Error ? cause.message : 'The onboarding step was refused.'); }
    finally { setBusy(false); }
  }
  async function signTransaction() {
    if (!transaction) return;
    setBusy(true); setError('');
    try {
      const provider = (window as Window & { ethereum?: WalletProvider }).ethereum;
      if (!provider) throw new Error('Open this page with your wallet extension, or download the transaction for your wallet.');
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[];
      if (!accounts.some(account => account.toLowerCase() === transaction.from.toLowerCase())) throw new Error('Select the verified wallet shown in this transaction.');
      const chainId = '0x' + transaction.chainId.toString(16);
      if (String(await provider.request({ method: 'eth_chainId' })).toLowerCase() !== chainId)
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
      const submitted = await provider.request({ method: 'eth_sendTransaction', params: [{ from: transaction.from, to: transaction.to, data: transaction.data, value: '0x0', chainId }] });
      if (typeof submitted !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(submitted)) throw new Error('The wallet did not return a transaction hash.');
      setHash(submitted);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The wallet transaction was refused.'); }
    finally { setBusy(false); }
  }
  if (!data) return <section aria-label="Onboarding"><h3>Onboarding</h3>{loading ? <p role="status" aria-live="polite">Reading onboarding…</p> :
    <p role="alert">{error}<button type="button" onClick={() => void load()}>Retry onboarding</button></p>}</section>;
  const complete = (key: string) => data.checklist.find(step => step.key === key)?.complete === true;
  const columns: ColumnDef<Step>[] = [
    { key: 'step', header: 'Onboarding step', width: 2, toCopyText: step => step.label, render: ({ row }) => row.label },
    { key: 'status', header: 'Status', width: 1, toCopyText: step => step.complete ? 'Complete' : 'Not complete', render: ({ row }) => row.complete ? 'Complete' : 'Not complete' },
  ];
  function requestChallenge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget); setChallenge(null);
    void action({ action: 'wallet-challenge', walletAddress: fields.get('wallet'), chainId: Number(fields.get('chain')) }, setChallenge, false);
  }
  function verifyWallet(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const fields = new FormData(event.currentTarget);
    void action({ action: 'wallet-verify', challengeId: challenge!.challengeId, signature: fields.get('signature') }, () => setChallenge(null));
  }
  const inactive = data.state === 'lapsed', disabled = busy || loading;
  return <section aria-label="Onboarding"><h3>Onboarding</h3>
    {!data.bindingEligible ? <p role="status">Non-binding sample. Counsel-approved templates and a formed issuing entity are required.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {data.chainError ? <p role="alert">{data.chainError} <button type="button" onClick={() => void load()}>Retry chain verification</button></p> : null}
    {loading ? <p role="status" aria-live="polite">Refreshing onboarding…</p> : null}
    <RichGrid rows={data.checklist} columns={columns} getRowId={step => step.key} />
    <button type="button" disabled={disabled} onClick={() => void load()}>Refresh onboarding</button>
    {inactive ? <p role="status">The hire vote failed or expired. This conditional offer has lapsed.</p> : <>
      {data.isCandidate && !complete('membership') ? <>
        <p>Sign in with the GitHub account whose verified email signed this offer. Bind your wallet by signing its challenge.</p>
        <form className="dao-form" aria-label="Bind onboarding wallet" onSubmit={requestChallenge}>
          <label>Wallet address<input name="wallet" required pattern="0x[0-9a-fA-F]{40}" /></label>
          <label>Wallet chain ID<input name="chain" type="number" min="1" defaultValue={data.plan?.chainId ?? 1} required /></label>
          <button type="submit" disabled={disabled}>Request wallet challenge</button>
        </form>
        {challenge ? <form className="dao-form" aria-label="Verify onboarding wallet signature" onSubmit={verifyWallet}>
          <p>Sign this exact message in your wallet:</p><pre>{challenge.message}</pre>
          <label>Wallet signature<input name="signature" required pattern="0x[0-9a-fA-F]{130}" /></label>
          <button type="submit" disabled={disabled}>Verify wallet signature</button>
        </form> : null}
        <button type="button" disabled={disabled || !complete('contract')} onClick={() => void action({ action: 'verify-identity' })}>Verify my identity and bound wallet</button>
      </> : null}
      {data.isAdmin && !complete('proposal') ? <>
        <button type="button" disabled={disabled || !complete('identity') || !complete('wallet')} onClick={() => void action({ action: 'prepare-hire' }, value => setTransaction(value.unsignedTransaction))}>Prepare hire vote</button>
        {data.proposalId ? <><p>Hire proposal: <code>{data.proposalId}</code>. Members vote, queue and execute this proposal through DAO governance.</p>
          <button type="button" disabled={disabled} onClick={() => void action({ action: 'reconcile-failed-hire' })}>Check for failed or expired hire vote</button></> : null}
      </> : null}
      {data.isCandidate && complete('proposal') && !complete('acceptance') ? <button type="button" disabled={disabled} onClick={() => void action({ action: 'prepare-acceptance' }, setTransaction)}>Prepare my terms acceptance</button> : null}
      {data.plan ? <p>Verified hire: {data.plan.shares} shares · wallet <code>{data.plan.wallet}</code> · chain {data.plan.chainId}</p> : null}
      {transaction ? <section aria-label="Review wallet transaction"><h4>Review wallet transaction</h4>
        <p>Review and authorize this transaction in your wallet. A successful signature alone does not complete onboarding.</p>
        <dl><dt>From</dt><dd>{transaction.from}</dd><dt>Contract</dt><dd>{transaction.to}</dd><dt>Chain</dt><dd>{transaction.chainId}</dd></dl>
        <button type="button" disabled={disabled} onClick={() => void signTransaction()}>Review and sign in my wallet</button>
        <a download="dao-hire-transaction.json" href={'data:application/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(transaction))}>Download wallet transaction</a>
      </section> : null}
      {data.plan && !complete('membership') ? <div className="dao-form">
        <label>Transaction hash<input value={hash} onChange={event => setHash(event.target.value)} /></label>
        <p>After two confirmations, verify the submitted transaction. The app reads its receipt directly from the chain.</p>
        {data.isAdmin && !data.proposalId ? <button type="button" disabled={disabled || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => void action({ action: 'record-proposal', transactionHash: hash })}>Verify hire proposal transaction</button> : null}
        {data.proposalId && !complete('proposal') ? <button type="button" disabled={disabled || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => void action({ action: 'record-execution', transactionHash: hash })}>Verify hire execution transaction</button> : null}
        {data.isCandidate && complete('proposal') ? <button type="button" disabled={disabled || !/^0x[0-9a-fA-F]{64}$/.test(hash)} onClick={() => void action({ action: 'admit', transactionHash: hash })}>Verify acceptance and admit me</button> : null}
      </div> : null}
    </>}
  </section>;
}
