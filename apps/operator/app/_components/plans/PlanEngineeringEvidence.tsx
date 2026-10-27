'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/app/harness/Button';
import { Tooltip } from '@/app/harness/Tooltip';
import { Checkbox } from '@/app/harness/Checkbox';
import { TextInput } from '@/app/harness/TextInput';
import type { EngineeringEvidence, EngineeringNode, EngineeringRef } from '@papercusp/operator-core/lib/code-intelligence/engineering-evidence';

type Invoke = (ref: EngineeringRef, harness: string, signal?: AbortSignal, confirmed?: boolean) => Promise<unknown>;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Use the existing authenticated, scoped, audited tool route for readers and explicit repairs. */
// Opening the Evidence panel or an exact reference is the owner's explicit read action.
export const invokeEngineeringReference: Invoke = async (ref, harness, signal, confirmed = true) => {
  const response = await fetch('/api/agent-mcp/run-tool', { method: 'POST', signal,
    // This caller parses canonical records; an agent-context preview can omit
    // their exact selectors or execution receipt without an HTTP error.
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ref.tool,
      args: { ...ref.args, payloadTier: 'full' }, harness, confirmed }) });
  const envelope = record(await response.json());
  if (!response.ok || envelope.ok === false) throw new Error(String(envelope.message ?? envelope.error ?? 'Evidence read failed.'));
  let value = envelope.result;
  const mcp = record(value);
  if (mcp.isError) throw new Error('The referenced record could not be read.');
  if (mcp.structuredContent) value = mcp.structuredContent;
  else if (Array.isArray(mcp.content)) {
    const text = mcp.content.find(block => record(block).type === 'text');
    if (text) { try { value = JSON.parse(String(record(text).text)); } catch { value = record(text).text; } }
  }
  if (record(value).ok === false) throw new Error(String(record(value).error ?? 'The referenced record is unavailable.'));
  return record(value).data ?? value;
};

const titleOf = (node: EngineeringNode) => {
  const data = node.data;
  if (node.kind === 'spec') return `${data.id} · revision ${data.revision}`;
  if (node.kind === 'decision') return `${data.decision} · ${data.title}`;
  if (node.kind === 'test-case') return `${data.key} · occurrence ${data.occurrence}`;
  if (node.kind === 'symbol') return `${data.path} · ${data.name}`;
  return `${node.kind} ${data.id ?? data.item ?? data.boundary ?? ''}`.trim();
};

function relationship(graph: EngineeringEvidence, node: EngineeringNode): string {
  const edges = graph.edges.filter(edge => edge.from === node.id || edge.to === node.id);
  if (node.kind === 'decision') return edges.some(edge => edge.basis === 'decision-item-ref') ? 'Direct rationale'
    : edges.some(edge => edge.basis === 'plan-affects') ? 'Broader plan context' : 'Unscoped context';
  if (node.kind === 'execution') return 'Observed instrumented boundary';
  if (node.kind === 'test-run' || node.kind === 'test-case') return 'Recorded test result';
  if (node.kind === 'symbol' || node.kind === 'item') return 'Declared · static';
  return 'Explicit record link';
}

export default function PlanEngineeringEvidence({ plan, item, harness, onClose, onEditItem,
  invoke = invokeEngineeringReference }: { plan: string; item: string; harness: string; onClose: () => void;
    onEditItem?: () => void; invoke?: Invoke }) {
  const [graph, setGraph] = useState<EngineeringEvidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [includeContext, setIncludeContext] = useState(false);
  const [edition, setEdition] = useState(0);
  const [detail, setDetail] = useState<{ title: string; value: unknown } | null>(null);
  const [repair, setRepair] = useState<{ id: string; revision: number } | null>(null);
  const [workItem, setWorkItem] = useState('');
  const [testRun, setTestRun] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setGraph(null); setDetail(null); setRepair(null); setLoading(true); setError(null);
    void invoke({ tool: 'graph:query', args: { op: 'evidence', plan, item, harnesses: [harness], include_context: includeContext } },
      harness, controller.signal).then(value => {
      const result = record(value), evidence = record(result.evidence);
      if (result.status !== 'measured' || !Array.isArray(evidence.nodes) || !Array.isArray(evidence.edges) || !Array.isArray(evidence.gaps))
        throw new Error(String(result.error ?? 'Evidence is unavailable. Retry this scoped query.'));
      const scope = record(evidence.scope);
      if (scope.harness !== harness) throw new Error('Evidence belongs to another repository.');
      if (!controller.signal.aborted) setGraph(evidence as unknown as EngineeringEvidence);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason instanceof Error ? reason.message : reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [plan, item, harness, includeContext, edition, invoke]);

  async function open(ref: EngineeringRef, title: string) {
    setBusy(true); setError(null);
    try { setDetail({ title, value: await invoke(ref, harness) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Reference unavailable.'); }
    finally { setBusy(false); }
  }
  async function bind() {
    if (!repair || !/^WI-[A-Za-z0-9-]+$/.test(workItem) || !Number.isSafeInteger(Number(testRun)) || Number(testRun) <= 0) return;
    setBusy(true); setError(null);
    try {
      await invoke({ tool: 'plans:bind-spec-evidence', args: { slug: plan, harness,
        binding: { workItemId: workItem, specId: repair.id, specRevision: repair.revision, fromTestRun: Number(testRun) } } }, harness, undefined, true);
      setRepair(null); setEdition(value => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Evidence binding failed.'); }
    finally { setBusy(false); }
  }
  return <section className="plan-dash__card" aria-label={`Engineering evidence for ${item}`} data-testid="plan-engineering-evidence">
    <h3>Engineering evidence · {item}</h3>
    <Button onClick={onClose}>Close evidence</Button>
    <label><Checkbox checked={includeContext} onChange={setIncludeContext} ariaLabel="Include unscoped decision context" /> Include unscoped decision context</label>
    <p>Declared/static links · Inferred relationships are not measured here · Observed execution names only instrumented boundaries.</p>
    {loading ? <p role="status">Loading evidence…</p> : null}
    {error ? <div role="alert">{error} <Button onClick={() => setEdition(value => value + 1)}>Retry evidence</Button></div> : null}
    {graph ? <>
      {graph.truncated ? <p role="status">Additional evidence was omitted. Open the exact references to continue.</p> : null}
      {!graph.nodes.length ? <p>No linked evidence is recorded for this item.</p> : null}
      <ul>{graph.nodes.filter(node => node && node.ref && node.data).map(node => <li key={node.id}>
        <Tooltip label="Read the exact canonical record"><Button disabled={busy} onClick={() => void open(node.ref, titleOf(node))}>{titleOf(node)}</Button></Tooltip>
        <span> · {node.state} · {relationship(graph, node)}</span>
      </li>)}</ul>
      {graph.execution?.status !== 'observed' ? <p>Execution unknown: {graph.execution?.reason ?? 'No validated instrumented execution is recorded.'}</p> : null}
      <h4>Missing links</h4>
      <ul>{graph.gaps.map((gap, index) => {
        const specId = Array.isArray(gap.at?.args.specIds) ? gap.at.args.specIds[0] : undefined;
        const revision = gap.at?.args.revision;
        return <li key={`${gap.code}:${index}`}>
          {gap.code.replaceAll('-', ' ')}{' '}
          <Button disabled={busy} onClick={() => void open(gap.at, 'Missing-link record')}>Inspect missing link</Button>
          {(gap.code === 'no-visible-proof' || gap.code.startsWith('proof-')) && typeof specId === 'string' && typeof revision === 'number'
            ? <Button onClick={() => setRepair({ id: specId, revision })}>Bind test evidence for {specId}</Button> : null}
          {onEditItem && ['no-visible-spec', 'no-visible-item-anchor', 'anchor-not-current'].includes(gap.code)
            ? <Button onClick={onEditItem}>Edit item and source links</Button> : null}
        </li>;
      })}</ul>
    </> : null}
    {repair ? <form onSubmit={event => { event.preventDefault(); void bind(); }}>
      <h4>Bind recorded test evidence · {repair.id} · revision {repair.revision}</h4>
      <label>Owning work item<TextInput value={workItem} onChange={event => setWorkItem(event.target.value)} required pattern={'WI-[A-Za-z0-9\\-]+'} /></label>
      <label>Recorded test run<TextInput type="number" min="1" step="1" value={testRun} onChange={event => setTestRun(event.target.value)} required /></label>
      <Button type="submit" disabled={busy}>Bind evidence</Button>
      <Button onClick={() => setRepair(null)}>Cancel repair</Button>
    </form> : null}
    {detail ? <div role="region" aria-label="Exact evidence record"><h4>{detail.title}</h4>
      <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(detail.value, null, 2)}</pre>
    </div> : null}
  </section>;
}
