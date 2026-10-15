/** Explicit owner actions inside the existing inspector. Refresh is a user action;
 * no polling, principal aliases, public publishing or manufactured cost evidence. */
import { useRef, useState } from 'react';
import { parseAsBoolean, useQueryState } from 'nuqs';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import { workflowAdministrationHostFromInvoker, type BlueprintOperationHandle,
  type WorkflowAdministration as Administration, type WorkflowAdministrationAction } from '@papercusp/pot-app-seam';
import { runScheduleTool } from './ScheduleEditor';

const administrationHost = workflowAdministrationHostFromInvoker(async (name, args) => {
  const result = await runScheduleTool(name, args);
  if (!result.ok || !result.data) throw new Error(result.message ?? 'Workflow administration is unavailable');
  return result.data;
});
const usd = (value: number | null) => value == null ? 'Unknown' : `$${(value / 1_000_000).toFixed(6)}`;
const measurement = (value: { value: number } | { unknownReason: string }) =>
  'value' in value ? usd(value.value) : `Unknown (${value.unknownReason})`;

export default function WorkflowAdministration({ harnessSlug, operationId, handle, host = administrationHost }: {
  harnessSlug: string; operationId: string; handle?: BlueprintOperationHandle | null;
  host?: typeof administrationHost;
}) {
  return <AdministrationPanel key={`${harnessSlug}:${operationId}`} harnessSlug={harnessSlug}
    operationId={operationId} handle={handle} host={host} />;
}

function AdministrationPanel({ harnessSlug, operationId, handle, host }: {
  harnessSlug: string; operationId: string; handle?: BlueprintOperationHandle | null; host: typeof administrationHost;
}) {
  const [open, setOpen] = useQueryState('wfAdmin', parseAsBoolean.withDefault(false));
  const [value, setValue] = useState<Administration | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selection = { harness: harnessSlug, operationId };
  async function refresh() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setValue(null);
    try { setValue(await host.read(selection)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Administration unavailable'); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function act(action: WorkflowAdministrationAction['action']) {
    if (!value || inFlight.current || !reason.trim()) return;
    const snapshot = value;
    const receiptAction = action === 'stop' || action === 'revoke';
    const payload: WorkflowAdministrationAction = { action, reason: reason.trim(),
      expectedSpecificationRevision: snapshot.approvedRevision,
      ...(receiptAction ? { handle: handle ?? undefined } : { targetRevision: target }) };
    inFlight.current = true; setBusy(true); setError(null); setNotice(null);
    try {
      // Deterministic across reloads/uncertain responses. A changed payload gets
      // a new identity; the service refuses conflicting replays atomically.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ selection, payload,
        // A later rollback permits a fresh promotion of the same revision.
        // Retries from the same displayed snapshot retain their request key.
        afterEventId: snapshot.history[0]?.eventId ?? null })));
      const requestKey = 'workflow-admin:' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
      const receipt = await host.act(selection, payload, requestKey);
      setNotice(`${action} request saved · Evidence ${receipt.eventId}${action === 'stop' ? '. Cancellation settlement is still pending.' : ''}`);
      setValue(await host.read(selection));
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Administration failed'); setValue(null); }
    finally { inFlight.current = false; setBusy(false); }
  }
  const validHandle = handle?.harnessSlug === harnessSlug && handle.operationId === operationId;
  return <section className="pc-wf__insp-sec" aria-label="Workflow administration" aria-busy={busy}>
    <label><Checkbox checked={open} disabled={busy} ariaLabel="Show workflow administration"
      onChange={checked => { setValue(null); setError(null); setNotice(null); void setOpen(checked); }} /> Workflow administration</label>
    {open && <>
      <p>The authenticated accountable owner manages local revisions and access. Business acceptance requires a distinct reviewer.</p>
      <button type="button" className="pc-wf__btn" disabled={busy} onClick={() => void refresh()}>Refresh administration</button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {value && <>
        <h3 className="pc-wf__insp-h">Approved version {value.version}</h3>
        <p>Approved revision <code>{value.approvedRevision}</code></p>
        <p>Accountable owner: {value.accountableOwner}</p>
        <p>Distinct reviewers: {value.reviewerPrincipals.join(', ')}</p>
        <h4>Model funding and cost</h4>
        {value.funding ? <>
          <p>Allocation {value.funding.allocationId} · {value.funding.month}</p>
          <p>Finite allocation: {usd(value.funding.capMicros)} · Available: {usd(value.funding.availableMicros)}
            {' '}· Committed: {usd(value.funding.committedMicros)} · Maximum per run: {usd(value.funding.maximumCostMicros)}</p>
          {value.funding.unknownReason && <p>Unknown: {value.funding.unknownReason}</p>}
          {value.funding.costs.length === 0 && <p>Actual model cost: Unknown (no recorded reservation evidence).</p>}
          <ul>{value.funding.costs.map(cost => <li key={cost.reservationId}>Evidence <code>{cost.reservationId}</code>
            {' '}· Observed: {measurement(cost.observedCostMicros)} · Provider final: {measurement(cost.providerFinalCostMicros)}</li>)}</ul>
        </> : <p>Funding: Unknown (no bound allocation).</p>}
        <label>Retained local revision
          <Select value={target} onChange={setTarget} disabled={busy} ariaLabel="Retained local revision"
            options={value.retainedRevisions.map(r => ({ value: r.revision, label: `Version ${r.version} · ${r.revision}` }))} />
        </label>
        <label>Administrative reason<textarea value={reason} maxLength={2000} disabled={busy}
          onChange={event => setReason(event.target.value)} /></label>
        <div className="pc-wf__insp-actions">
          {(['promote', 'rollback'] as const).map(action => <button key={action} type="button" className="pc-wf__btn"
            disabled={busy || !reason.trim() || !target || target === value.approvedRevision}
            onClick={() => void act(action)}>{action === 'promote' ? 'Promote revision' : 'Roll back revision'}</button>)}
          <button type="button" className="pc-wf__btn pc-wf__btn--warn" disabled={busy || !reason.trim() || !validHandle}
            onClick={() => void act('stop')}>Stop selected run</button>
          <button type="button" className="pc-wf__btn pc-wf__btn--warn" disabled={busy || !reason.trim() || !validHandle}
            onClick={() => void act('revoke')}>Revoke employee source access</button>
        </div>
        {handle && <p>Selected receipt {handle.receiptId} keeps revision <code>{handle.specificationRevision}</code>.</p>}
        <p>Revocation removes the selected employee’s organization source grant for this worker role. It also affects other runs using that grant.</p>
        <h4>Recent administrative history (up to 20)</h4>
        <ul>{value.history.map(event => <li key={event.eventId}>{String(event.body.action)} by {String(event.body.principalId)}
          {' '}· {String(event.body.reason)} · Evidence <code>{event.eventId}</code></li>)}</ul>
        <h4>Recent distinct business decisions (up to 20)</h4>
        <ul>{value.businessReviews.map(event => <li key={event.eventId}>{String(event.body.decision)} by {String(event.body.reviewerPrincipal)}
          {' '}· {String(event.body.reason)} · Receipt {String(event.body.receiptId)} · Evidence <code>{event.eventId}</code></li>)}</ul>
      </>}
    </>}
  </section>;
}
