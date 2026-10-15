'use client';

import { useId, useState } from 'react';
import { Button } from '@/app/harness/Button';
import { readHostedBrowserApiMarker } from '@/lib/hosted-browser-api';

export function CustomerDataControls() {
  const headingId = useId();
  const [busy, setBusy] = useState<'user' | 'organization' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [deleteScope, setDeleteScope] = useState<'user' | 'organization' | null>(null);
  const [confirmation, setConfirmation] = useState('');
  if (!readHostedBrowserApiMarker()) return null;

  const download = async (scope: 'user' | 'organization') => {
    setBusy(scope);
    setMessage(null);
    setFailed(false);
    let url: string | undefined;
    try {
      const response = await fetch(`/api/hosted/browser/data/${scope}/export`, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: '{}',
      });
      if (!response.ok) {
        throw new Error(response.status === 403
          ? 'You need organization administrator access to download these records.'
          : response.status === 401 ? 'Sign in again to download your data.'
            : 'Your download is unavailable. Please try again.');
      }
      url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `papercusp-${scope}-data.json`;
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
      setMessage(scope === 'user' ? 'Your account data download is ready.' : 'Your organization data download is ready.');
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : 'Your download is unavailable. Please try again.');
    } finally {
      if (url) URL.revokeObjectURL(url);
      setBusy(null);
    }
  };

  const requestDeletion = async () => {
    if (!deleteScope) return;
    setBusy(deleteScope); setFailed(false); setMessage(null);
    try {
      const response = await fetch(`/api/hosted/browser/data/${deleteScope}/delete`, {
        method: 'POST', credentials: 'include', cache: 'no-store',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmation }),
      });
      const result = await response.json().catch(() => ({})) as { operationId?: string; error?: string };
      if (response.status !== 202 || !result.operationId) {
        const code = result.error;
        throw new Error(code === 'retention_policy_pending' ? 'Deletion is awaiting the data retention policy. Contact support for help.'
          : code === 'transfer_organization_ownership_required' ? 'Transfer organization ownership before deleting your account.'
            : response.status === 403 ? 'Organization deletion requires owner access.'
              : response.status === 401 ? 'Sign in again before requesting deletion.'
                : 'Your deletion request could not be accepted. Please contact support.');
      }
      setMessage(`Deletion request accepted. Reference: ${result.operationId}. Deletion continues in the background; this message does not confirm completion.`);
      setDeleteScope(null); setConfirmation('');
    } catch (error) {
      setFailed(true); setMessage(error instanceof Error ? error.message : 'Your deletion request could not be accepted.');
    } finally { setBusy(null); }
  };

  return <section className="pc-settings-section" aria-labelledby={headingId}>
    <h2 id={headingId}>Your data</h2>
    <p>Download your account records for this organization. Organization owners and administrators can also download the organization’s records.</p>
    <Button variant="neutral" disabled={busy !== null} onClick={() => void download('user')}>
      {busy === 'user' ? 'Preparing download…' : 'Download my data'}
    </Button>
    <Button variant="neutral" disabled={busy !== null} onClick={() => void download('organization')}>
      {busy === 'organization' ? 'Preparing download…' : 'Download organization data'}
    </Button>
    <p>Deleting your account removes your identity across organizations. Deleting an organization also tears down its workspace. Shared members keep their other organizations. Download your records first.</p>
    <Button variant="neutral" disabled={busy !== null} onClick={() => { setDeleteScope('user'); setConfirmation(''); }}>Delete my account</Button>
    <Button variant="neutral" disabled={busy !== null} onClick={() => { setDeleteScope('organization'); setConfirmation(''); }}>Delete organization</Button>
    {deleteScope && <div>
      <label htmlFor={`${headingId}-confirmation`}>Type {deleteScope === 'user' ? 'DELETE MY ACCOUNT' : 'DELETE ORGANIZATION'} to confirm</label>
      <input id={`${headingId}-confirmation`} value={confirmation} disabled={busy !== null}
        onChange={event => setConfirmation(event.target.value)} autoComplete="off" />
      <Button variant="neutral" disabled={busy !== null || confirmation !== (deleteScope === 'user' ? 'DELETE MY ACCOUNT' : 'DELETE ORGANIZATION')}
        onClick={() => void requestDeletion()}>Request deletion</Button>
      <Button variant="neutral" disabled={busy !== null} onClick={() => { setDeleteScope(null); setConfirmation(''); }}>Cancel</Button>
    </div>}
    {message && <p role={failed ? 'alert' : 'status'}>{message}</p>}
  </section>;
}
