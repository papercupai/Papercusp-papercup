'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  parseStructuredResults, resultActionIntent, type ChatResultBlock, type ResultActionIntent,
  type StructuredResultOutcome,
} from '@papercusp/chat-protocol';
import { MarkdownView } from '@papercusp/ui-primitives/markdown';

export interface StructuredResultRequest {
  result: ChatResultBlock;
  /** Host-owned caller/scope/revocation epoch; never read from model content. */
  authorizationKey: string;
  signal: AbortSignal;
}
export interface StructuredResultHost {
  /** Recheck current resource access on the existing host backend. */
  resolve(request: StructuredResultRequest): Promise<StructuredResultOutcome<ChatResultBlock>>;
  /** Recheck authorization AND perform the action in one host operation. */
  activate?(intent: ResultActionIntent, request: StructuredResultRequest): Promise<StructuredResultOutcome<void>>;
  /** Selected application presentation, after resolution. Business types stay in hosts. */
  renderers?: Partial<Record<ChatResultBlock['kind'], (result: ChatResultBlock) => ReactNode>>;
  renderMarkdown?: (source: string) => ReactNode;
}
export interface StructuredResultsProps {
  blocks: unknown;
  authorizationKey: string;
  host: StructuredResultHost;
}

function sameReference(requested: ChatResultBlock, resolved: ChatResultBlock): boolean {
  return requested.id === resolved.id && requested.kind === resolved.kind
    && JSON.stringify(requested.sources) === JSON.stringify(resolved.sources)
    && (resolved.actions ?? []).every(action => requested.actions?.some(offered =>
      offered.id === action.id && offered.kind === action.kind && offered.ref === action.ref));
}

const failureText = {
  invalid: 'Invalid result.', unsupported: 'This result is not supported in this view.',
  unavailable: 'This result is unavailable.', unauthorized: 'This result is not available to this caller.',
  stale: 'This result is no longer current.',
} as const;

function StructuredResult({ result, authorizationKey, host }: {
  result: ChatResultBlock; authorizationKey: string; host: StructuredResultHost;
}): ReactNode {
  // A changed scope/reference hides the old content during render, before effects run.
  const key = JSON.stringify([authorizationKey, result]);
  const [state, setState] = useState<{
    key: string; resolver: StructuredResultHost['resolve']; outcome: StructuredResultOutcome<ChatResultBlock>;
  }>();
  const [busy, setBusy] = useState(false);
  const active = useRef<{ key: string; controller: AbortController; busy: boolean } | null>(null);
  const current = useRef({ key, resolve: host.resolve, activate: host.activate });
  current.current = { key, resolve: host.resolve, activate: host.activate };

  useEffect(() => {
    const token = { key, controller: new AbortController(), busy: false };
    active.current = token;
    setBusy(false);
    void (async () => {
      let outcome: StructuredResultOutcome<ChatResultBlock>;
      try {
        // Pass a copy: a host adapter cannot mutate the original reference fence.
        const resolved = await host.resolve({ result: structuredClone(result), authorizationKey, signal: token.controller.signal });
        if (!resolved.ok) outcome = { ok: false, code: Object.hasOwn(failureText, resolved.code) ? resolved.code : 'unavailable' };
        else {
          const parsed = parseStructuredResults([resolved.value]);
          outcome = parsed.ok && sameReference(result, parsed.value[0])
            ? { ok: true, value: parsed.value[0] } : { ok: false, code: 'invalid' };
        }
      } catch { outcome = { ok: false, code: 'unavailable' }; }
      if (!token.controller.signal.aborted && active.current === token)
        setState({ key, resolver: host.resolve, outcome });
    })();
    return () => { token.controller.abort(); if (active.current === token) active.current = null; };
    // The canonical scalar key includes the complete parsed request and scope epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, host.resolve]);

  const outcome = state?.key === key && state.resolver === host.resolve ? state.outcome : undefined;
  if (!outcome) return <p role="status" data-result-id={result.id}>Loading result…</p>;
  if (!outcome.ok) return <p role="status" data-result-id={result.id}>{failureText[outcome.code]}</p>;
  const value = outcome.value;
  const renderer = host.renderers?.[value.kind];
  if (host.renderers && !renderer) return <p role="status" data-result-id={result.id}>{failureText.unsupported}</p>;

  const activate = async (actionId: string): Promise<void> => {
    const token = active.current;
    const callback = host.activate;
    if (!token || token.key !== key || token.busy || !callback || token.controller.signal.aborted
      || current.current.key !== key || current.current.resolve !== host.resolve || current.current.activate !== callback) return;
    const intent = resultActionIntent(value, actionId);
    if (!intent.ok) return;
    // Fulfilled and rejected promises belong to the same captured host operation.
    const isCurrent = (): boolean => active.current === token && current.current.key === key
      && current.current.activate === callback && current.current.resolve === host.resolve
      && !token.controller.signal.aborted;
    token.busy = true;
    setBusy(true);
    try {
      const response = await callback(intent.value, {
        result: structuredClone(value), authorizationKey, signal: token.controller.signal,
      });
      if (!isCurrent()) return;
      if (!response.ok) setState({ key, resolver: host.resolve,
        outcome: { ok: false, code: Object.hasOwn(failureText, response.code) ? response.code : 'unavailable' } });
    } catch {
      if (isCurrent())
        setState({ key, resolver: host.resolve, outcome: { ok: false, code: 'unavailable' } });
    } finally {
      token.busy = false;
      if (active.current === token) setBusy(false);
    }
  };

  return <article className="structured-result" data-result-id={value.id} data-result-kind={value.kind}>
    {renderer ? renderer(value) : <>
      <h3>{value.title}</h3>
      {value.text ? host.renderMarkdown?.(value.text) ?? <MarkdownView source={value.text} linkPolicy="external" /> : null}
    </>}
    <ul aria-label="Sources">{value.sources.map((source, index) =>
      <li key={`${source.ref}:${index}`} data-source-ref={source.ref}>{source.label ?? source.ref}</li>)}</ul>
    {value.actions?.length ? <div aria-label="Suggested actions">{value.actions.map(action =>
      <button key={action.id} type="button" disabled={busy || !host.activate}
        data-action-id={action.id} onClick={() => { void activate(action.id); }}>{action.label}</button>)}</div> : null}
  </article>;
}

/** Rendering/replaying never dispatches. Resolve and activate remain host authority boundaries. */
export function StructuredResults({ blocks, authorizationKey, host }: StructuredResultsProps): ReactNode {
  const parsed = parseStructuredResults(blocks);
  if (!parsed.ok || !authorizationKey.trim()) return <p role="status">{failureText.invalid}</p>;
  return <div className="structured-results">{parsed.value.map(result =>
    <StructuredResult key={result.id} result={result} authorizationKey={authorizationKey} host={host} />)}</div>;
}
