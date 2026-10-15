"use client";

import { useEffect, useState } from 'react';
import { parseAsString, useQueryState } from 'nuqs';
import { toast } from 'sonner';
import type { PlanAuditRun, PlanAuditScope } from '@papercusp/operator-core/lib/plan-audit-runs';

export const PLAN_AUDIT_PARAM = 'paudit';
const API = '/api/admin/plan-audit';
interface AuditResponse { run?: PlanAuditRun; runs?: PlanAuditRun[]; error?: string; }
async function request(url: string, init?: RequestInit): Promise<AuditResponse> {
  const response = await fetch(url, init);
  const data = await response.json() as AuditResponse;
  if (!response.ok) throw new Error(data.error ?? 'Audit request failed');
  return data;
}
function useStartAudit() {
  const [, setAudit] = useQueryState(PLAN_AUDIT_PARAM, parseAsString);
  const [pending, setPending] = useState(false);
  const start = async (scope: PlanAuditScope, planSlugs?: string[]) => {
    if (pending) return;
    setPending(true);
    try {
      const data = await request(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope, ...(planSlugs ? { planSlugs } : {}) }) });
      if (!data.run?.id) throw new Error('Audit did not return a durable run id');
      await setAudit(data.run.id);
    } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };
  return { start, pending };
}

export function PlanAuditActions({ planSlugs }: { planSlugs: string[] }) {
  const { start, pending } = useStartAudit();
  const [, setAudit] = useQueryState(PLAN_AUDIT_PARAM, parseAsString);
  return <div className="plans-pane__controls" aria-label="Plan audit actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
    <button type="button" disabled={pending || !planSlugs.length} onClick={() => void start('visible', planSlugs)}>{pending ? 'Starting audit…' : 'Audit visible plans'}</button>
    <button type="button" disabled={pending} onClick={() => void start('workspace')}>Audit workspace</button>
    <button type="button" onClick={() => void setAudit('history')}>Audit history</button>
  </div>;
}
export function PlanAuditButton({ planSlug }: { planSlug: string }) {
  const { start, pending } = useStartAudit();
  return <button type="button" className="plan-dash__btn plan-dash__btn--ghost" aria-label={'Audit plan ' + planSlug} disabled={pending} onClick={event => { event.stopPropagation();void start('single', [planSlug]); }}>{pending ? 'Auditing…' : 'Audit'}</button>;
}

/** URL-owned app-pane takeover, like PlanDashboardHost; routed page stays mounted. */
export default function PlanAuditPane() {
  const [id, setId] = useQueryState(PLAN_AUDIT_PARAM, parseAsString);
  const [loadedRun, setRun] = useState<PlanAuditRun | null>(null);
  const [history, setHistory] = useState<PlanAuditRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { start, pending } = useStartAudit();
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();let timer: ReturnType<typeof setTimeout> | undefined;
    setRun(null);setError(null);setHistory([]);
    const load = async () => {
      try {
        const data = await request(id === 'history' ? API : API + '?runId=' + encodeURIComponent(id), { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (id === 'history') setHistory(data.runs ?? []);
        else { setRun(data.run ?? null);if (data.run?.status === 'running') timer = setTimeout(() => void load(), 2000); }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)); }
    };
    void load();
    return () => { controller.abort();if (timer) clearTimeout(timer); };
  }, [id]);
  const run = loadedRun?.id === id ? loadedRun : null;
  if (!id) return null;
  return <section data-testid="plan-audit-pane" aria-label="Plan audit workspace" style={{ position: 'absolute', inset: 0, zIndex: 40, display: 'flex', flexDirection: 'column', background: 'var(--bg)', color: 'var(--fg)' }}>
    <header style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, padding: 16, borderBottom: '1px solid var(--border)' }}>
      <button type="button" onClick={() => void setId(null)}>← Back to plans</button><strong>{id === 'history' ? 'Audit history' : 'Plan audit'}</strong>
      <button type="button" onClick={() => void setId('history')}>Saved audits</button>
      {run?.status === 'complete' ? <a href={API + '?runId=' + encodeURIComponent(id) + '&format=json'} download="plan-audit.json">Download full JSON</a> : null}
    </header>
    {error ? <p role="alert" style={{ padding: 24 }}>{error}</p> : null}
    {id === 'history' ? <div style={{ padding: 24, overflow: 'auto' }}><p>Immutable point-in-time snapshots. Auditing does not change plan statuses.</p>{history.length ? history.map(item => <button key={item.id} type="button" style={{ display: 'block', width: '100%', textAlign: 'left', padding: 14, marginBottom: 8 }} onClick={() => void setId(item.id)}>{item.scope} audit · {new Date(item.startedAt).toLocaleString()} · {item.status}{item.rowCount !== undefined ? ' · ' + item.rowCount + ' plans' : ''}</button>) : <p>No saved audits yet.</p>}</div> : null}
    {id !== 'history' && !run && !error ? <p role="status" style={{ padding: 24 }}>Loading audit…</p> : null}
    {run?.status === 'running' ? <div style={{ padding: 24 }} role="status"><h2>Auditing plans…</h2><p>Reading ledger, ownership and saved evidence. No plan state is being changed.</p><p>You can leave this page and reopen the run from Audit history.</p></div> : null}
    {run?.status === 'failed' ? <div style={{ padding: 24 }}><h2>Audit could not complete</h2><p role="alert">{run.error}</p><button type="button" disabled={pending} onClick={() => void start(run.scope, run.planSlugs)}>Retry as a new snapshot</button></div> : null}
    {run?.status === 'complete' ? <iframe title="Plan audit report" sandbox="allow-scripts allow-downloads" src={API + '?runId=' + encodeURIComponent(id) + '&format=html'} style={{ flex: 1, minHeight: 0, width: '100%', border: 0 }} /> : null}
  </section>;
}
