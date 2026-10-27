import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatResultBlock, ResultActionIntent, StructuredResultOutcome } from '@papercusp/chat-protocol';
import { MarkdownView } from '@papercusp/ui-primitives/markdown';
import { CardRenderer, ReportBlockCard, StructuredResults, type StructuredResultHost } from './index';

afterEach(cleanup);
const kinds = ['entity', 'document', 'report', 'task', 'suggestion'] as const;
function block(kind: ChatResultBlock['kind'] = 'document'): ChatResultBlock {
  return { id: `result-${kind}`, kind, title: `Authorized ${kind}`, text: `**${kind}** details`,
    sources: [{ ref: `${kind}:original`, label: `Original ${kind}` }],
    actions: [{ id: 'open', kind: 'open', ref: `${kind}:original`, label: `Open ${kind}` }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('structured result host composition (tree only)', () => {
  it('selected application renderer preserves authorized result references and provenance', async () => {
    const blocks = kinds.map(block);
    const effects: ResultActionIntent[] = [];
    const selected = vi.fn((value: ChatResultBlock) => <h3>{value.title}</h3>);
    const host: StructuredResultHost = {
      resolve: vi.fn<StructuredResultHost['resolve']>(async request => request.authorizationKey === 'caller:allowed:1'
        ? { ok: true, value: request.result } : { ok: false, code: 'unauthorized' }),
      renderers: Object.fromEntries(kinds.map(kind => [kind, selected])),
      activate: vi.fn<NonNullable<StructuredResultHost['activate']>>(async (intent, request) => {
        if (request.authorizationKey !== 'caller:allowed:1'
          || !request.result.sources.some(source => source.ref === intent.ref)) return { ok: false, code: 'unauthorized' };
        effects.push(intent);
        return { ok: true, value: undefined };
      }),
    };
    const view = render(<StructuredResults blocks={blocks} authorizationKey="caller:allowed:1" host={host} />);
    for (const original of blocks) {
      await screen.findByRole('heading', { name: original.title });
      const article = view.container.querySelector(`[data-result-id="${original.id}"]`)!;
      expect(article.getAttribute('data-result-kind')).toBe(original.kind);
      expect(article.querySelector('[data-source-ref]')?.getAttribute('data-source-ref')).toBe(original.sources[0].ref);
      expect(article.textContent).toContain(original.sources[0].label);
      expect(selected).toHaveBeenCalledWith(original);
    }
    expect(host.activate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
    await waitFor(() => expect(effects).toEqual([{ resultId: 'result-document', actionId: 'open', kind: 'open', ref: 'document:original' }]));
    expect(host.activate).toHaveBeenCalledTimes(1);
    view.rerender(<StructuredResults blocks={structuredClone(blocks)} authorizationKey="caller:allowed:1" host={host} />);
    expect(effects).toHaveLength(1);
  });

  it('host adapters reuse product broaden report and work-reference presentation', async () => {
    // These deterministic host callbacks prove composition, not installed Scout/Papercup adoption.
    const product = { id: 'product:42', name: 'Refurbished laptop' };
    const legacyProducts = { type: 'products', products: [product] };
    const legacyBroaden = { type: 'broaden', correlationId: 'broaden:1', ref: 'search:original' };
    const renderProducts = vi.fn((products: typeof legacyProducts.products) => products.map(value => <p key={value.id}>{value.name}</p>));
    const onBroaden = vi.fn();
    const onWorkRef = vi.fn();
    const report = { title: 'Existing report', plans: [{ title: 'Existing plan', items: [{ id: 'WI-42', text: 'Existing work', ref: 'WI-42' }] }] };
    const blocks: ChatResultBlock[] = [
      { ...block('entity'), id: product.id, sources: [{ ref: product.id }], actions: [] },
      { ...block('suggestion'), id: legacyBroaden.correlationId, sources: [{ ref: legacyBroaden.ref }], actions: [] },
      { ...block('report'), id: 'report:42', sources: [{ ref: 'report:42' }], actions: [] },
      { ...block('task'), id: 'WI-42', sources: [{ ref: 'WI-42' }], actions: [] },
    ];
    const host: StructuredResultHost = {
      resolve: async request => ({ ok: true, value: request.result }),
      renderers: {
        entity: value => renderProducts(legacyProducts.products.filter(candidate => candidate.id === value.sources[0].ref)),
        suggestion: value => <CardRenderer card={{ correlationId: value.id, createdAt: 1,
          prompt: 'Broaden the search', presentation: { kind: 'radio', options: [{ id: 'broaden', label: 'Broaden' }] } }} onResponse={onBroaden} />,
        report: () => <ReportBlockCard report={report} />,
        task: value => <ReportBlockCard report={{ title: 'Work reference', plans: report.plans }}
          canDrillIn={ref => value.sources.some(source => source.ref === ref)} onDrillIn={onWorkRef} />,
      },
    };
    const view = render(<StructuredResults blocks={blocks} authorizationKey="host:1" host={host} />);
    await screen.findByText(product.name);
    expect(renderProducts).toHaveBeenCalledWith(legacyProducts.products);
    expect(await screen.findByRole('group', { name: 'Existing report' })).toBeTruthy();
    expect(await screen.findByRole('group', { name: 'Work reference' })).toBeTruthy();
    expect(onBroaden).not.toHaveBeenCalled();
    expect(onWorkRef).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Broaden' }));
    expect(onBroaden).toHaveBeenCalledWith({ action: 'submit', correlationId: 'broaden:1', value: { picks: ['broaden'] } });
    fireEvent.click(screen.getByRole('button', { name: 'Open WI-42' }));
    expect(onWorkRef).toHaveBeenCalledWith('WI-42');
    expect([...view.container.querySelectorAll('[data-source-ref]')].map(node => node.getAttribute('data-source-ref')))
      .toEqual(blocks.map(value => value.sources[0].ref));
    // Host Markdown can reuse the same safe primitive without domain imports in the package.
    const markdown = vi.fn((source: string) => <MarkdownView source={source} linkPolicy="external" />);
    view.rerender(<StructuredResults blocks={[block()]} authorizationKey="host:1" host={{ ...host, renderers: undefined, renderMarkdown: markdown }} />);
    await screen.findByText('document', { selector: 'strong' });
    expect(markdown).toHaveBeenCalledWith('**document** details');
  });

  it('hostile result content cannot create executable markup or unsafe links', async () => {
    const hostile = { ...block(), title: '<img src=x onerror=alert(1)>',
      text: '**ordinary Markdown** [safe](https://example.com/source)\n\n'
        + '<script>alert(1)</script><iframe src="https://evil.example"></iframe>\n\n'
        + '[js](javascript:alert%281%29) [data](data:text/html,evil) [relative](/admin) '
        + '[encoded](jav&#x61;script:alert%281%29) ![tracking](https://evil.example/pixel)',
      sources: [{ ref: 'javascript:alert(1)', label: '<svg onload=alert(1)>' }], actions: [],
      renderMarkdown: '<script>not a callback</script>',
    };
    const host: StructuredResultHost = { resolve: async request => ({ ok: true, value: request.result }) };
    const view = render(<StructuredResults blocks={[hostile]} authorizationKey="safe:1" host={host} />);
    await screen.findByText('ordinary Markdown', { selector: 'strong' });
    const safe = screen.getByRole('link', { name: 'safe' });
    expect(safe.getAttribute('href')).toBe('https://example.com/source');
    expect(safe.getAttribute('target')).toBe('_blank');
    expect(safe.getAttribute('rel')?.split(' ').sort()).toEqual(['noopener', 'noreferrer']);
    expect(view.container.querySelectorAll('a')).toHaveLength(1);
    expect(view.container.querySelector('script, iframe, img, svg, [onclick], [onerror], [onload]')).toBeNull();
    expect(view.container.textContent).toContain(hostile.title);
    expect(view.container.querySelector('[data-source-ref]')?.getAttribute('data-source-ref')).toBe('javascript:alert(1)');
  });

  it('foreign revoked and stale references cannot reveal protected content or dispatch actions', async () => {
    const original = block();
    const resolve = vi.fn<StructuredResultHost['resolve']>(async () => ({ ok: false, code: 'unauthorized' }));
    const activate = vi.fn<NonNullable<StructuredResultHost['activate']>>(async () => ({ ok: true, value: undefined }));
    let view = render(<StructuredResults blocks={[original]} authorizationKey="foreign:1" host={{ resolve, activate }} />);
    await screen.findByText('This result is not available to this caller.');
    expect(view.container.querySelector(`[data-result-id="${original.id}"]`)?.textContent)
      .toBe('This result is not available to this caller.');
    expect(view.container.querySelector('[data-source-ref]')).toBeNull();
    expect(screen.queryByText(original.title)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(activate).not.toHaveBeenCalled();
    view.unmount();

    // A successful host response cannot substitute a reference or an unoffered action.
    for (const value of [{ ...original, id: 'unrelated' },
      { ...original, sources: [{ ref: 'foreign:secret' }] },
      { ...original, actions: [{ id: 'delete', label: 'Delete', kind: 'delete', ref: original.sources[0].ref }] }]) {
      view = render(<StructuredResults blocks={[original]} authorizationKey="allowed:1"
        host={{ resolve: async () => ({ ok: true, value }), activate }} />);
      await screen.findByText('Invalid result.');
      expect(screen.queryByText(original.title)).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      view.unmount();
    }
    for (const code of ['unsupported', 'unavailable', 'stale'] as const) {
      view = render(<StructuredResults blocks={[original]} authorizationKey="allowed:1"
        host={{ resolve: async () => ({ ok: false, code }), activate }} />);
      await waitFor(() => expect(screen.queryByText('Loading result…')).toBeNull());
      expect(screen.queryByText(original.title)).toBeNull();
      expect(screen.queryByRole('button')).toBeNull();
      view.unmount();
    }
    for (const input of [[original, original], [{ ...original, sources: [] }], [{ ...original, kind: 'executable' }]]) {
      resolve.mockClear();
      view = render(<StructuredResults blocks={input} authorizationKey="allowed:1" host={{ resolve, activate }} />);
      expect(screen.getByText('Invalid result.')).toBeTruthy();
      expect(resolve).not.toHaveBeenCalled();
      view.unmount();
    }
    view = render(<StructuredResults blocks={[original]} authorizationKey="allowed:1"
      host={{ resolve: async request => ({ ok: true, value: request.result }), renderers: {} }} />);
    await screen.findByText('This result is not supported in this view.');
    expect(screen.queryByRole('button')).toBeNull();
    view.unmount();

    // Revocation between display and click is checked by the same backend action operation.
    let allowed = true;
    const effects: ResultActionIntent[] = [];
    const host: StructuredResultHost = {
      resolve: async request => allowed ? { ok: true, value: request.result } : { ok: false, code: 'unauthorized' },
      activate: async intent => {
        if (!allowed) return { ok: false, code: 'unauthorized' };
        effects.push(intent); return { ok: true, value: undefined };
      },
    };
    view = render(<StructuredResults blocks={[original]} authorizationKey="allowed:1" host={host} />);
    await screen.findByText(original.title);
    allowed = false;
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
    await screen.findByText('This result is not available to this caller.');
    expect(view.container.querySelector(`[data-result-id="${original.id}"]`)?.textContent)
      .toBe('This result is not available to this caller.');
    expect(screen.queryByText(original.title)).toBeNull();
    expect(effects).toEqual([]);
    view.unmount();

    // The old resolver deliberately ignores AbortSignal; the renderer still fences it out.
    const old = deferred<StructuredResultOutcome<ChatResultBlock>>();
    const fresh = deferred<StructuredResultOutcome<ChatResultBlock>>();
    const requests: AbortSignal[] = [];
    const delayed: StructuredResultHost = { resolve: request => {
      requests.push(request.signal);
      return request.authorizationKey === 'old:1' ? old.promise : fresh.promise;
    }, activate };
    view = render(<StructuredResults blocks={[original]} authorizationKey="old:1" host={delayed} />);
    const current = { ...original, title: 'Current authorized document', sources: [{ ref: 'document:current' }], actions: [] };
    view.rerender(<StructuredResults blocks={[current]} authorizationKey="current:2" host={delayed} />);
    expect(requests[0].aborted).toBe(true);
    await act(async () => old.resolve({ ok: true, value: original }));
    expect(screen.queryByText(original.title)).toBeNull();
    await act(async () => fresh.resolve({ ok: true, value: current }));
    expect(await screen.findByText(current.title)).toBeTruthy();
    expect(screen.queryByText('Original document')).toBeNull();
    expect(activate).not.toHaveBeenCalled();
    view.unmount();

    // An old action acknowledgement must not clear/restore a newly authorized scope.
    const lateAction = deferred<StructuredResultOutcome<void>>();
    const action = vi.fn(() => lateAction.promise);
    const actionHost: StructuredResultHost = { resolve: async request => ({ ok: true, value: request.result }), activate: action };
    view = render(<StructuredResults blocks={[original]} authorizationKey="old:1" host={actionHost} />);
    await screen.findByText(original.title);
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
    expect(action).toHaveBeenCalledTimes(1);
    view.rerender(<StructuredResults blocks={[current]} authorizationKey="current:2" host={actionHost} />);
    expect(screen.queryByText(original.title)).toBeNull();
    await screen.findByText(current.title);
    await act(async () => lateAction.resolve({ ok: false, code: 'unauthorized' }));
    expect(screen.getByText(current.title)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    view.unmount();

    // Replacing only the host callback leaves scope/reference/resolver unchanged.
    // An obsolete callback's thrown failure must obey the same fence as its return.
    const obsolete = deferred<StructuredResultOutcome<void>>();
    const obsoleteAction = vi.fn(() => obsolete.promise);
    const replacement = vi.fn<NonNullable<StructuredResultHost['activate']>>(async () => ({ ok: true, value: undefined }));
    const stableResolve: StructuredResultHost['resolve'] = async request => ({ ok: true, value: request.result });
    view = render(<StructuredResults blocks={[original]} authorizationKey="unchanged:1"
      host={{ resolve: stableResolve, activate: obsoleteAction }} />);
    await screen.findByText(original.title);
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
    expect(obsoleteAction).toHaveBeenCalledTimes(1);
    view.rerender(<StructuredResults blocks={[original]} authorizationKey="unchanged:1"
      host={{ resolve: stableResolve, activate: replacement }} />);
    await act(async () => obsolete.reject(new Error('old transport failed')));
    expect(screen.getByText(original.title)).toBeTruthy();
    expect(replacement).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
    await waitFor(() => expect(replacement).toHaveBeenCalledTimes(1));
    expect(screen.getByText(original.title)).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open document' }) as HTMLButtonElement).disabled).toBe(false));
    const currentFailure: StructuredResultHost['activate'] = async () => { throw new Error('current transport failed'); };
    view.rerender(<StructuredResults blocks={[original]} authorizationKey="unchanged:1"
      host={{ resolve: stableResolve, activate: currentFailure }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open document' }));
    await screen.findByText('This result is unavailable.');
    expect(screen.queryByText(original.title)).toBeNull();
  });
});
