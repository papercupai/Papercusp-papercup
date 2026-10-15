'use client';

/** Workspace bulk cleanup controls backed by the standing Inbox/Plans policy. */
import { useEffect, useState } from 'react';
import { Select } from '@/app/harness/Select';
import { Button } from '@/app/harness/Button';
import { BULK_AUTOMATION_RISKS, bulkRiskAutonomy, type BulkRiskAutonomy,
  type BulkConfidence, type StandingBulkAutomationPolicy } from '@papercusp/operator-core/lib/attention/bulk-dispositions';

const RISK_COPY = {
  low: ['Low risk', 'Acknowledgements, recovery notices and delegated cleanup.'],
  medium: ['Medium risk', 'Owner decisions, plan dispositions and work-item owner gates.'],
  high: ['High risk', 'Protected decisions, blocked work and standing approvals.'],
} as const;

async function policyRequest(body: Record<string, unknown>) {
  const response = await fetch('/api/admin/inbox/automation-policy', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || result.error || result.ok === false) throw new Error(
    typeof result.error === 'string' ? result.error : result.error?.message ?? 'Could not save autonomy settings',
  );
  return result;
}

export default function AutonomySettingsPage() {
  const [policy, setPolicy] = useState<StandingBulkAutomationPolicy | null>(null);
  const [risks, setRisks] = useState<BulkRiskAutonomy | null>(null);
  const [confidence, setConfidence] = useState<BulkConfidence>('high');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    policyRequest({ op: 'get' }).then(({ policy: loaded }) => {
      if (!cancelled) { setPolicy(loaded); setRisks(bulkRiskAutonomy(loaded)); setConfidence(loaded.minConfidence); }
    }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, []);

  const save = async (nextRisks: BulkRiskAutonomy) => {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await policyRequest({ op: 'set', riskLevels: nextRisks,
        ...(confidence !== policy?.minConfidence ? { minConfidence: confidence } : {}) });
      if (!result.applied || result.verify?.ok !== true) throw new Error('Autonomy settings were not applied');
      const saved = await policyRequest({ op: 'get' });
      setPolicy(saved.policy); setRisks(bulkRiskAutonomy(saved.policy)); setConfidence(saved.policy.minConfidence);
      setMessage('Saved. Eligible recommendations will apply automatically during queue cleanup.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1>Autonomy</h1>
      <p className="pc-settings-intro">Choose which Inbox and Plans cleanup recommendations can be applied automatically in this workspace.</p>
      {error && <p role="alert">{error}</p>}
      {!risks && !error && <p role="status">Loading autonomy settings…</p>}
      {risks && <section aria-label="Queue cleanup autonomy">
        {BULK_AUTOMATION_RISKS.map((risk) => <div className="pc-settings-section" key={risk}>
          <h2>{RISK_COPY[risk][0]}</h2><p>{RISK_COPY[risk][1]}</p>
          <Select ariaLabel={`${RISK_COPY[risk][0]} autonomy`} value={risks[risk]} disabled={busy}
            options={[{ value: 'review', label: 'Ask me to review' }, { value: 'automatic', label: 'Apply automatically' }]}
            onChange={(value) => setRisks({ ...risks, [risk]: value as 'review' | 'automatic' })} />
        </div>)}
        <div className="pc-settings-section"><h2>Evidence confidence</h2>
          <p>Risk and evidence are separate. Choose the minimum confidence for an automatic recommendation.</p>
          <Select ariaLabel="Minimum confidence" value={confidence} disabled={busy}
            options={[{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium or high' }, { value: 'low', label: 'Low or higher' }]}
            onChange={(value) => setConfidence(value as BulkConfidence)} />
        </div>
        <p>Recommendations still need a current executable action. Changing these settings also makes eligible saved recommendations available for the next cleanup pass.</p>
        <div className="pc-settings-row">
          <Button disabled={busy} onClick={() => void save(risks)}>Save settings</Button>
          <Button disabled={busy} onClick={() => void save({ low: 'automatic', medium: 'automatic', high: 'automatic' })}>Full autonomy for all risk levels</Button>
        </div>
      </section>}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
