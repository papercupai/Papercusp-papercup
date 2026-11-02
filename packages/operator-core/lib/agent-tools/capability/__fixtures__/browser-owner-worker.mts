/** DB-free process fixture: production sessions/relay, deterministic browser adapter. */
import { startWorkerOwnerRpc } from '../../../cluster-owner-rpc.ts';
import { runManagedBrowserSession } from '../browser-owner.ts';
import type { BrowserDeps } from '../browser-session.ts';
import type { UnifiedToolContext } from '@papercusp/agent-mcp';
import { fetchWithCapabilityPolicy } from '../fetch-policy.ts';

const markStartup = (type: string) => process.send?.({ type, pid: process.pid, startupAtNs: process.hrtime.bigint().toString() });
markStartup('fixture:imports-loaded');
startWorkerOwnerRpc();
markStartup('fixture:rpc-started');
const controllers = new Map<number, AbortController>();
process.on('message', async (message: any) => {
  if (message?.type !== 'fixture:call') return;
  const { seq } = message;
  try {
    if (message.op === 'cancel') {
      controllers.get(message.runSeq)?.abort();
      process.send!({ type: 'fixture:result', seq, result: { cancelled: true } }); return;
    }
    const controller = new AbortController(); controllers.set(seq, controller);
    const principal = () => process.pid;
    const ctx = { workspaceId: message.workspace ?? 'browser-workspace', uiClientId: message.owner ?? 'browser-owner',
      harnessSlug: message.harness ?? 'papercusp', role: 'operator', isSuperuser: true, authenticatedPrincipal: principal,
      signal: controller.signal, log: () => {} } as unknown as UnifiedToolContext;
    if (message.enrolled) {
      const { setAutoPumpEnabledForTests } = await import('../../../events/await/engine.ts');
      setAutoPumpEnabledForTests(false);
      const result = await runManagedBrowserSession(message.args, message.url, ctx,
        { timeoutMs: 20_000, maxText: 500 });
      controllers.delete(seq); process.send!({ type: 'fixture:result', seq, result }); return;
    }
    const profile = message.confined ? { kind: 'confined', reason: 'autonomous-caller' } as const : { kind: 'trusted', reason: 'superuser' } as const;
    const deps: BrowserDeps = {
      profile: async (actual) => {
        if (actual !== ctx || (actual as any).authenticatedPrincipal !== principal) throw new Error('caller_context_left_worker');
        return profile;
      },
      fetch: async (input) => {
        const { signal } = input;
        process.send!({ type: 'fixture:fetch', seq, pid: process.pid, principalStayedLocal: (ctx as any).authenticatedPrincipal === principal });
        if (message.denyFetch) throw new Error('current_caller_denied');
        if (message.real) return fetchWithCapabilityPolicy(input);
        if (message.hangFetch) await new Promise<void>((_resolve, reject) => {
          const stop = () => reject(new Error('fixture_fetch_aborted'));
          if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
        });
        return { response: new Response(new Uint8Array([0, 127, 255])), finalUrl: 'https://example.com', finalMethod: 'GET',
          redirectCount: 0, resolvedAddress: { address: '93.184.216.34', family: 4 },
          release: async () => { process.send!({ type: 'fixture:release', seq, pid: process.pid }); } };
      },
      launch: async () => {
        if (message.real) {
          // Real Chromium + production relay/fetch policy. This adapter deliberately
          // does not claim actual ledger enrollment or execution confinement.
          const { chromium } = await import('playwright-core');
          const server = await chromium.launchServer({ headless: true, host: '127.0.0.1', timeout: 10_000 });
          const browser = await chromium.connect(server.wsEndpoint());
          process.send!({ type: 'fixture:launch', seq, pid: process.pid, browserPid: server.process().pid });
          return { server, browser, profile, taskId: 'fixture-browser-task', sandbox: { mode: 'fixture', sandboxed: false } };
        }
        let route!: (r: any) => Promise<void>; let text = 'opened'; let navigations = 0;
        let stop: (() => void) | undefined; const handlers: Array<() => void> = [];
        const server = { on: (_name: string, handler: () => void) => handlers.push(handler),
          close: async () => { stop?.(); for (const handler of handlers) handler(); },
          kill: async () => { stop?.(); for (const handler of handlers) handler(); } };
        const page = {
          goto: async (url: string) => {
            let refused = false;
            const request = { url: () => url, method: () => 'GET', headers: () => ({}), redirectedFrom: () => null };
            const pending = route({ request: () => request, abort: async () => { refused = true; },
              fulfill: async ({ body }: { body: Buffer }) => { text = JSON.stringify([...body]); } });
            await Promise.race([pending, new Promise<never>((_resolve, reject) => { stop = () => reject(new Error('fixture_page_closed')); })]);
            if (refused) throw new Error('fixture_request_refused'); navigations++;
          },
          evaluate: async () => ({ url: 'https://example.com/', title: String(process.pid), text, navigations, links: [], truncated: false }),
          locator: () => ({ waitFor: async () => {} }), screenshot: async () => Buffer.from([0, 127, 255]),
        };
        const context = { newPage: async () => page, route: async (_pattern: string, handler: typeof route) => { route = handler; },
          routeWebSocket: async () => {}, on: () => {} };
        process.send!({ type: 'fixture:launch', seq, pid: process.pid });
        return { server, browser: { newContext: async () => context }, profile,
          taskId: 'fixture-browser-task', sandbox: { mode: 'fixture', sandboxed: false } } as any;
      },
    };
    const result = await runManagedBrowserSession(message.args, message.url, ctx,
      { timeoutMs: message.timeoutMs ?? 3000, maxText: 500 }, deps);
    controllers.delete(seq); process.send!({ type: 'fixture:result', seq, result });
  } catch (error) { controllers.delete(seq); process.send!({ type: 'fixture:result', seq, error: String(error) }); }
});
process.on('disconnect', () => process.exit(0));
markStartup('fixture:ready');
