import { fetchBrowserSyncQuery as fetchSyncQuery } from '../../../lib/hosted-browser-api';
import { parseStructuredResults, resultActionIntent, type ChatResultBlock } from '@papercusp/chat-protocol';
import type { StructuredResultHost, StructuredResultRequest } from '@papercusp/chat-cards';

/** Owner UI adapter: existing sync resolvers retain resource and workspace authority.
 * Public hosts supply their own adapter and never use these owner-only queries. */
export function createOperatorResultHost(options: {
  workspaceId: string;
  harnessSlug?: string | null;
  authorizationKey: string;
  openReport(id: string): void;
  openWorkItem(id: string): void;
}): StructuredResultHost {
  const current = (request: StructuredResultRequest) => !request.signal.aborted
    && request.authorizationKey === options.authorizationKey;
  const resolve: StructuredResultHost['resolve'] = async request => {
    if (!current(request)) return { ok: false, code: 'unauthorized' };
    const parsed = parseStructuredResults([request.result]);
    if (!parsed.ok) return parsed;
    const block = parsed.value[0];
    if (block.sources.length !== 1) return { ok: false, code: 'unsupported' };
    const ref = block.sources[0].ref;
    let value: ChatResultBlock;
    if (block.kind === 'report' && ref.startsWith('report:') && ref.length > 7) {
      const id = ref.slice(7);
      const rows = await fetchSyncQuery<{ report_id: string; workspace_id: string; title: string; body_md: string }>({
        queryName: 'reports.get', args: { reportId: id }, staleTime: 0,
      });
      if (!current(request)) return { ok: false, code: 'unauthorized' };
      const row = rows.find(item => item.report_id === id && item.workspace_id === options.workspaceId);
      if (!row || typeof row.title !== 'string' || typeof row.body_md !== 'string') return { ok: false, code: 'unavailable' };
      value = { ...block, title: row.title, text: row.body_md };
    } else if (block.kind === 'task' && /^wi:(?:WI|EI|F)-[A-Za-z0-9-]+$/.test(ref) && options.harnessSlug) {
      const id = ref.slice(3);
      const rows = await fetchSyncQuery<{ id: string; title: string; summary?: string | null }>({
        queryName: 'workItems.detail', args: { harnessSlug: options.harnessSlug, id }, staleTime: 0,
      });
      if (!current(request)) return { ok: false, code: 'unauthorized' };
      const row = rows.find(item => item.id === id);
      if (!row || typeof row.title !== 'string') return { ok: false, code: 'unavailable' };
      value = { ...block, title: row.title, text: typeof row.summary === 'string' ? row.summary : '' };
    } else return { ok: false, code: 'unsupported' };
    // Opening an existing resource is the only supported action in this host.
    return { ok: true, value: { ...value, actions: value.actions?.filter(action => action.kind === 'open' && action.ref === ref) } };
  };
  return {
    resolve,
    async activate(intent, request) {
      const selected = resultActionIntent(request.result, intent.actionId);
      if (!selected.ok || selected.value.resultId !== intent.resultId || selected.value.ref !== intent.ref
        || selected.value.kind !== intent.kind || intent.kind !== 'open') return { ok: false, code: 'invalid' };
      const resolved = await resolve(request);
      if (!resolved.ok) return resolved;
      if (!current(request)) return { ok: false, code: 'unauthorized' };
      if (!resolved.value.actions?.some(action => action.id === intent.actionId && action.ref === intent.ref))
        return { ok: false, code: 'unsupported' };
      if (resolved.value.kind === 'report') options.openReport(intent.ref.slice(7));
      else options.openWorkItem(intent.ref.slice(3));
      return { ok: true, value: undefined };
    },
  };
}
