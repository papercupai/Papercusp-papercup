/** Selected support-case input in the existing Workflows inspector. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { parseAsJson, useQueryState } from 'nuqs';
import { useSyncQuery } from '@papercusp/sync';
import type { BlueprintOperationHandle, PotAppSeam } from '@papercusp/pot-app-seam';
import { assertSupportCaseInput, type ApprovedSupportWorkflow } from
  '@papercusp/operator-core/lib/blueprint/support-workflow-contract';
import { Checkbox } from '@/app/harness/Checkbox';
import { Select } from '@/app/harness/Select';
import WorkflowOperationResult, { workflowOperationSeam } from './WorkflowOperationResult';
import { runScheduleTool } from './ScheduleEditor';
import WorkflowAdministration from './WorkflowAdministration';

type CaseDocument = { id: string; source: string; externalId: string | null; title: string; snippet: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const message = (error: unknown) => error instanceof Error ? error.message : 'Support request failed';

// This is URL restoration, never receipt authority: the result service validates
// the complete handle and authenticated caller again on every read and write.
function receiptFromUrl(value: unknown): BlueprintOperationHandle {
  const h = value as BlueprintOperationHandle | null;
  if (!h || typeof h.workspaceId !== 'string' || typeof h.harnessSlug !== 'string' ||
      typeof h.operationId !== 'string' || !Number.isSafeInteger(h.receiptId) || h.receiptId <= 0 ||
      typeof h.specificationRevision !== 'string' || !/^[0-9a-f]{64}$/.test(h.specificationRevision) ||
      !h.target || (h.target.kind === 'work-item' ? typeof h.target.id !== 'string' :
        h.target.kind !== 'plan' || !Number.isSafeInteger(h.target.runId) || typeof h.target.instanceSlug !== 'string')) {
    throw new Error('Invalid operation receipt');
  }
  return h;
}

async function searchCase(query: string, sources: readonly string[]): Promise<CaseDocument[]> {
  // Explicit search is a user action. It uses the existing tool's grant, source
  // ACL and disclosure path; no source content is copied into the submit input.
  const result = await runScheduleTool('documents:search', { query, sources: [...sources], legs: ['organization'], limit: 50 });
  if (!result.ok || !result.data) throw new Error(result.message ?? 'Case search failed');
  const data = result.data.data as { legs?: { organization?: { allowed?: boolean } }; results?: unknown[]; error?: string } | undefined;
  if (!data || data.error || data.legs?.organization?.allowed !== true || !Array.isArray(data.results)) {
    throw new Error('Support sources are unavailable or access was refused');
  }
  return data.results.map((value) => {
    const d = value as CaseDocument & { scope?: string };
    if (d.scope !== 'organization' || typeof d.id !== 'string' || !uuid.test(d.id) ||
        !sources.includes(d.source) || typeof d.title !== 'string' || typeof d.snippet !== 'string' ||
        (d.externalId !== null && typeof d.externalId !== 'string')) throw new Error('Invalid case search result');
    return { id: d.id, source: d.source, externalId: d.externalId, title: d.title, snippet: d.snippet };
  });
}

export default function WorkflowSupportForm({ harnessSlug, operationId, previousHandle, enterprise = false, seam = workflowOperationSeam,
  search = searchCase }: {
  harnessSlug: string; operationId: string; previousHandle?: BlueprintOperationHandle | null;
  enterprise?: boolean;
  seam?: Pick<PotAppSeam, 'submitOperations'>; search?: typeof searchCase;
}) {
  const [receipt, setReceipt] = useQueryState('wfRun', parseAsJson(receiptFromUrl));
  const handle = receipt?.harnessSlug === harnessSlug && receipt.operationId === operationId ? receipt : previousHandle;
  const declaration = useSyncQuery<{ supportWorkflow: ApprovedSupportWorkflow | null }>({
    queryName: 'automation.catalog', args: { supportWorkflow: { harnessSlug, operationId } },
  });
  const workflow = declaration.data?.[0]?.supportWorkflow;
  return <>
    {declaration.error ? <p role="alert">Unable to load the current support workflow.</p> :
      workflow ? <SupportSelection key={JSON.stringify(workflow)} workflow={workflow}
        onAccepted={async accepted => { await setReceipt(accepted); }} seam={seam} search={search} /> :
        workflow === undefined ? <p role="status">Loading workflow declaration…</p> :
          <p role="status">Employee action unavailable: no approved support workflow declaration is installed for this operation.</p>}
    {enterprise && !handle && <section className="pc-wf__insp-sec" aria-label="Operation result">
      <h3 className="pc-wf__insp-h">Reviewer decision</h3>
      <p role="status">Business outcome pending. Prepare a case first; a distinct authorized reviewer then decides on its result.</p>
    </section>}
    {handle && <WorkflowOperationResult handle={handle} />}
    <WorkflowAdministration harnessSlug={harnessSlug} operationId={operationId} handle={handle} defaultExpanded={enterprise} />
  </>;
}

function SupportSelection({ workflow, onAccepted, seam, search }: {
  workflow: ApprovedSupportWorkflow; onAccepted: (handle: BlueprintOperationHandle) => Promise<void>;
  seam: Pick<PotAppSeam, 'submitOperations'>; search: typeof searchCase;
}) {
  const [caseId, setCaseId] = useState('');
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [documents, setDocuments] = useState<CaseDocument[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState(workflow.allowedActions[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  async function find(event: FormEvent) {
    event.preventDefault();
    if (inFlight.current || !query.trim()) return;
    inFlight.current = true; setBusy(true); setError(null); setDocuments([]); setSelected([]); setSearchedQuery('');
    try {
      const results = await search(query.trim(), workflow.allowedSources);
      if (active.current) { setDocuments(results); setSearchedQuery(query.trim()); }
    } catch (cause) { if (active.current) setError(message(cause)); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }

  async function submit() {
    if (inFlight.current) return;
    setError(null); setNotice(null);
    try {
      if (query.trim() !== searchedQuery || selected.some(id => !documents.some(d => d.id === id))) {
        throw new Error('Search the current case and select its source evidence first');
      }
      const input = assertSupportCaseInput(workflow, { supportCaseId: caseId.trim(), query: searchedQuery,
        approvedRevision: workflow.approvedRevision, documentIds: [...selected].sort(), requestedAction: action });
      inFlight.current = true; setBusy(true);
      // A reload after an uncertain network response must replay the same
      // caller-bound receipt for the same selection and approved revision.
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({
        harnessSlug: workflow.harnessSlug, operationId: workflow.operationId, input,
      })));
      const requestKey = 'support:' + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      const [accepted] = await seam.submitOperations([{ harnessSlug: workflow.harnessSlug, operationId: workflow.operationId,
        expectedSpecificationRevision: workflow.approvedRevision, requestKey,
        input: { ...input, documentIds: [...input.documentIds] } }]);
      if (!accepted || accepted.harnessSlug !== workflow.harnessSlug || accepted.operationId !== workflow.operationId ||
          accepted.specificationRevision !== workflow.approvedRevision) throw new Error('Operation returned an unexpected receipt');
      if (active.current) {
        await onAccepted(accepted);
        setNotice('Preparation accepted. A distinct reviewer must decide the business outcome.');
      }
    } catch (cause) { if (active.current) setError(message(cause)); }
    finally { inFlight.current = false; if (active.current) setBusy(false); }
  }

  return <>
    <section className="pc-wf__insp-sec" aria-label="Prepare support handoff" aria-busy={busy}>
      <h3 className="pc-wf__insp-h">Prepare support handoff</h3>
      <p>Internal simulation · Assumed support workflow</p>
      <p>Accountable owner: {workflow.accountableOwner}</p>
      <p>Allowed sources: {workflow.allowedSources.join(', ')}</p>
      <p>Maximum per run: ${(workflow.maximumCostMicros / 1_000_000).toFixed(2)}. Availability is checked when starting.</p>
      <p>Approved revision <code>{workflow.approvedRevision}</code></p>
      <label>Support case reference
        <input value={caseId} maxLength={200} disabled={busy} onChange={e => setCaseId(e.target.value)} />
      </label>
      <form onSubmit={event => void find(event)}>
        <label>Find case evidence
          <input value={query} maxLength={500} disabled={busy} onChange={e => {
            setQuery(e.target.value); setDocuments([]); setSelected([]); setSearchedQuery('');
          }} />
        </label>
        <button className="pc-wf__btn" type="submit" disabled={busy || !query.trim()}>Search allowed sources</button>
      </form>
      {searchedQuery && documents.length === 0 && <p role="status">No accessible case evidence found.</p>}
      {documents.map(document => <label key={document.id}>
        <Checkbox checked={selected.includes(document.id)} disabled={busy} ariaLabel={`Include ${document.title || document.externalId || document.source}`}
          onChange={checked => setSelected(ids => checked ? [...ids, document.id] : ids.filter(id => id !== document.id))} />
        {document.title || document.externalId || document.source} · {document.source}
        <span>{document.snippet}</span>
      </label>)}
      <label>Requested action
        <Select value={action} disabled={busy} onChange={setAction} ariaLabel="Requested action"
          options={workflow.allowedActions.map(value => ({ value, label: value }))} />
      </label>
      <button type="button" className="pc-wf__btn" disabled={busy || !caseId.trim() || !selected.length}
        onClick={() => void submit()}>Prepare handoff</button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  </>;
}
