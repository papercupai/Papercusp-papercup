import { useEffect, useState } from 'react';
import type { DaoWorkspaceView } from '@papercusp/operator-core/lib/dao-workspace-types';
import { Select } from '@/app/harness/Select';

export default function DaoPolicyEditor({ view, onChanged }: { view: DaoWorkspaceView; onChanged?: () => void }) {
  const [text, setText] = useState('');
  const [version, setVersion] = useState<number | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const path = '/api/pot/' + encodeURIComponent(view.localHomeSlug!) + '/policy';
  useEffect(() => {
    const controller = new AbortController();
    setVersion(null); setCanEdit(false); setError(''); setMessage('');
    void (async () => {
      try {
        const response = await fetch(path + '?editor=true', { signal: controller.signal });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'Policy could not be read.');
        if (!controller.signal.aborted) {
          setText(JSON.stringify(result.policy?.policy ?? {}, null, 2)); setVersion(result.policy?.policyVersion ?? 0);
          setCanEdit(result.canEdit === true); setMessage(result.refusal ?? '');
        }
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Policy could not be read.'); }
    })();
    return () => controller.abort();
  }, [path, reload]);
  let document: Record<string, unknown> | null = null;
  try { const parsed = JSON.parse(text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) document = parsed; } catch { /* Keep the draft; never substitute an empty policy. */ }
  function field(key: string, value: unknown) { if (document) setText(JSON.stringify({ ...document, [key]: value }, null, 2)); }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!canEdit || !document || version === null || pending) return;
    setPending(true); setError(''); setMessage('');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ policy: document, expectedPolicyVersion: version }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.detail || result.error || 'Policy save was refused.');
      setVersion(result.policy.policyVersion); setText(JSON.stringify(result.policy.policy, null, 2));
      setMessage('Owner-signed policy saved. Version ' + result.policy.policyVersion + '.'); onChanged?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Policy save was refused.'); }
    finally { setPending(false); }
  }
  return <section className="dao-card"><h2>Owner policy & account bindings</h2>
    <p>Membership, admission, voter keys, delegations and account references use the organization’s signed policy. Account references grant no spending authority.</p>
    {error ? <p role="alert">{error}</p> : null}{message ? <p role="status">{message}</p> : null}
    <button type="button" className="dao-action" disabled={pending} onClick={() => setReload(value => value + 1)}>Reload policy</button>
    {version !== null ? <form onSubmit={event => { void save(event); }} className="dao-proposal-form">
      <p>Reviewed policy version {version}</p>
      <label>Membership admission<Select ariaLabel="Membership admission" value={String(document?.membership ?? 'open')}
        disabled={!canEdit || !document || pending} onChange={value => field('membership', value)}
        triggerClassName="h-select-trigger dao-select" options={[
          { value: 'open', label: 'Open' }, { value: 'approval', label: 'Approval required' }, { value: 'allowlist', label: 'Allowlist' },
        ]} /></label>
      <label>Allowed GitHub identities<input value={Array.isArray(document?.allowlist) ? document.allowlist.join(', ') : ''} disabled={!canEdit || !document || pending} onChange={event => field('allowlist', event.target.value.split(',').map(v => v.trim()).filter(Boolean))} /></label>
      <label>Policy document<textarea aria-label="Policy document" rows={18} value={text} disabled={!canEdit || pending} onChange={event => setText(event.target.value)} /></label>
      {!document ? <p role="alert">Enter a valid policy object before saving. Your draft is retained.</p> : null}
      <details><summary>Account reference format</summary><pre>{JSON.stringify({ finance: { commerce: { buyerOrgId: 'your verified commerce organization' }, treasury: { chainId: 1, address: 'your treasury address' }, equity: { chainId: 1, equity: 'equity contract', governor: 'governor contract', timelock: 'timelock contract' }, funding: { agreementRef: 'your contribution agreement reference' } } }, null, 2)}</pre></details>
      <p>Delegation rules live in governance.signingAuthority.delegations and retain member key epochs and expiry. Plan admission thresholds live in governance.planAdmission.</p>
      <button type="submit" className="dao-action" disabled={!canEdit || !document || pending}>{pending ? 'Signing policy…' : 'Sign and save policy'}</button>
    </form> : !error ? <p role="status">Reading signed policy…</p> : null}
  </section>;
}
