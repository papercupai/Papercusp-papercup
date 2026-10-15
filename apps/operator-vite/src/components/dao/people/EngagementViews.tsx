import { useCallback, useEffect, useRef, useState } from 'react';
import type { readEngagement } from '@papercusp/operator-core/lib/dao-hr/engagement-changes';
import type { UnsignedEquityTransaction } from '@papercusp/operator-core/lib/equity/runtime';

type View = Awaited<ReturnType<typeof readEngagement>>;
type EndAction = 'complete-fire' | 'complete-resignation' | 'complete-amendment';
type WalletProvider = {request(input:{method:string;params?:unknown[]}):Promise<unknown>};
export default function EngagementViews({daoSlug,offerId,onChanged}:{daoSlug:string;offerId:string;onChanged?:()=>void}) {
  const [data,setData]=useState<View|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [transaction,setTransaction]=useState<UnsignedEquityTransaction|null>(null),[hash,setHash]=useState('');
  const [completion,setCompletion]=useState<EndAction|null>(null),[payOnly,setPayOnly]=useState(false);
  const generation=useRef(0),url='/api/pot/'+encodeURIComponent(daoSlug)+'/contracts/'+encodeURIComponent(offerId)+'/engagement';
  const load=useCallback(async()=>{
    const current=++generation.current;setLoading(true);setError('');
    try {
      const response=await fetch(url),value=await response.json();
      if(!response.ok||!value.ok||typeof value.engagement?.isCandidate!=='boolean')throw new Error(value.message||'Engagement could not be read.');
      if(current===generation.current)setData(value.engagement);
    }catch(cause){if(current===generation.current){setData(null);setError(cause instanceof Error?cause.message:'Engagement could not be read.');}}
    finally{if(current===generation.current)setLoading(false);}
  },[url]);
  useEffect(()=>{setData(null);setTransaction(null);setCompletion(null);setHash('');setPayOnly(false);setBusy(false);void load();return()=>{generation.current++;};},[load]);
  async function action(name:string,end?:EndAction){
    const current=generation.current;setBusy(true);setError('');
    try{
      const payload=name.startsWith('complete-')?{action:name,transactionHash:payOnly?null:hash}:{action:name};
      const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)}),value=await response.json();
      if(!response.ok||!value.ok)throw new Error(value.message||'The engagement action was refused.');
      if(current!==generation.current)return;
      if(end){setCompletion(end);setHash('');setPayOnly(name==='prepare-amendment'&&value.result.unsignedTransaction===null);
        setTransaction(name==='prepare-resignation'?value.result:value.result.unsignedTransaction);}
      else{setCompletion(null);setTransaction(null);setHash('');}
      setBusy(false);
      await load();onChanged?.();
    }catch(cause){if(current===generation.current)setError(cause instanceof Error?cause.message:'The engagement action was refused.');}
    finally{if(current===generation.current)setBusy(false);}
  }
  async function sign(){
    if(!transaction)return;
    const current=generation.current;setBusy(true);setError('');
    try{
      const provider=(window as Window&{ethereum?:WalletProvider}).ethereum;
      if(!provider)throw new Error('Open this page with your wallet extension, or download the transaction for your wallet.');
      const accounts=await provider.request({method:'eth_requestAccounts'}) as string[];
      if(!accounts.some(account=>account.toLowerCase()===transaction.from.toLowerCase()))throw new Error('Select the verified wallet shown in this transaction.');
      const chainId='0x'+transaction.chainId.toString(16);
      if(String(await provider.request({method:'eth_chainId'})).toLowerCase()!==chainId)await provider.request({method:'wallet_switchEthereumChain',params:[{chainId}]});
      const result=await provider.request({method:'eth_sendTransaction',params:[{from:transaction.from,to:transaction.to,data:transaction.data,value:'0x0',chainId}]});
      if(typeof result!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(result))throw new Error('The wallet did not return a transaction hash.');
      if(current===generation.current)setHash(result);
    }catch(cause){if(current===generation.current)setError(cause instanceof Error?cause.message:'The wallet refused this transaction.');}
    finally{if(current===generation.current)setBusy(false);}
  }
  if(!data)return <section aria-label="Engagement"><h3>Engagement</h3>{loading?<p role="status" aria-live="polite">Reading engagement…</p>:<div role="alert">{error}<button type="button" onClick={()=>void load()}>Retry engagement</button></div>}</section>;
  const disabled=busy||loading;
  return <section aria-label="Engagement"><h3>Engagement</h3>
    {!data.bindingEligible?<p role="status">Non-binding sample. Counsel-approved templates and a formed issuing entity are required.</p>:null}
    {error?<p role="alert">{error}</p>:null}{loading?<p role="status" aria-live="polite">Refreshing engagement…</p>:null}
    <button type="button" disabled={disabled} onClick={()=>void load()}>Refresh engagement</button>
    {data.offboarding?<><p role="status">Engagement ended: {data.offboarding.kind}. DAO access is revoked; records and earned equity are retained.</p>
      <p>Retained earned shares: {data.offboarding.retainedEarned}</p></>:data.amendment?<p role="status">Signed amendment executed.</p>:<>
      {data.amendsOfferId?<><p>Amends offer <code>{data.amendsOfferId}</code>. Both parties must sign the new amendment before it can execute.</p>
        {data.isAdmin?<button type="button" disabled={disabled||!data.signed} onClick={()=>void action('prepare-amendment','complete-amendment')}>Prepare signed amendment</button>:null}</>:
        data.admitted?<><p>Firing needs an executed member vote. You can resign using your own wallet. Earned equity remains yours.</p>
          {data.isAdmin?<button type="button" disabled={disabled} onClick={()=>void action('prepare-fire','complete-fire')}>Prepare fire vote</button>:null}
          {data.isCandidate?<button type="button" disabled={disabled} onClick={()=>void action('prepare-resignation','complete-resignation')}>Prepare my resignation</button>:null}
          {data.fireProposalId?<p>Fire proposal: <code>{data.fireProposalId}</code>. Members vote, queue and execute this exact proposal in DAO governance.</p>:null}
        </>:<p>Complete onboarding before managing this engagement.</p>}
      {transaction?<section aria-label="Review engagement transaction"><h4>Review wallet transaction</h4>
        <dl><dt>From</dt><dd>{transaction.from}</dd><dt>Contract</dt><dd>{transaction.to}</dd><dt>Chain</dt><dd>{transaction.chainId}</dd></dl>
        <button type="button" disabled={disabled} onClick={()=>void sign()}>Review and sign in my wallet</button>
        <a download="dao-engagement-transaction.json" href={'data:application/json;charset=utf-8,'+encodeURIComponent(JSON.stringify(transaction))}>Download wallet transaction</a>
      </section>:null}
      {completion?<div className="dao-form">{payOnly?<p>This pay amendment requires no equity transaction or vote.</p>:<>
        <label>Transaction hash<input value={hash} onChange={event=>setHash(event.target.value)} /></label>
        <p>{completion==='complete-fire'?'Use the executed fire proposal transaction, after the member vote and timelock.':'Use your submitted transaction.'} Wait for two confirmations.</p></>}
        <button type="button" disabled={disabled||(!payOnly&&!/^0x[0-9a-fA-F]{64}$/.test(hash))} onClick={()=>void action(completion)}>{payOnly?'Execute signed pay amendment':'Verify confirmed transaction'}</button>
      </div>:null}
    </>}
  </section>;
}
