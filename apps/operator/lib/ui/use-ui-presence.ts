'use client';

/**
 * Mirror the current tab's URL into harness_shared.ui_clients so
 * agents can ask "what is the user looking at right now?" without
 * per-feature wiring.
 *
 * Posts on:
 *   - mount (and a one-shot retry after 1s for slow first-paint)
 *   - every URL change (via the popstate event, which nuqs + our
 *     built-in `set_url` intent both fire)
 *   - every 15 seconds as a heartbeat for last_seen_at
 */

import { useEffect, useRef } from 'react';
import { getOrCreateClientId } from '@papercusp/operator-core/lib/ui/client-id';
import { callRoute } from '@papercusp/operator-core/lib/call-tool';
import { backgroundRequest } from '@papercusp/operator-core/lib/transport-adapters/origin-scheduler-fetch';

const HEARTBEAT_MS = 15_000;
const REQUEST_DEADLINE_MS = 5_000;

async function postPresence(clientId: string, signal: AbortSignal): Promise<void> {
  try {
    await callRoute('/api/ui/presence', backgroundRequest({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        url: window.location.href,
        title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight },
      }),
      keepalive: true,
      signal,
    }));
  } catch {
    // Presence is best-effort. Don't make the UI care if it fails.
  }
}

export function useUiPresence(): void {
  const lastUrlRef = useRef<string>('');
  useEffect(() => {
    const clientId = getOrCreateClientId();
    if (!clientId) return;

    // Presence is disposable telemetry, not an interactive write. A missing
    // IPC advertisement can otherwise make its pre-dispatch retries hold the
    // entire finite-fetch queue forever. One pending background request plus
    // caller cancellation protects visible reads without changing the safety
    // policy for real user writes or replaying an ambiguously dispatched write.
    let pending: AbortController | null = null;
    const post = () => {
      if (pending) return;
      const controller = new AbortController();
      pending = controller;
      const deadline = window.setTimeout(() => controller.abort(), REQUEST_DEADLINE_MS);
      void postPresence(clientId, controller.signal).finally(() => {
        window.clearTimeout(deadline);
        if (pending === controller) pending = null;
      });
    };

    const flush = () => {
      const url = window.location.href;
      if (url === lastUrlRef.current) return;
      lastUrlRef.current = url;
      post();
    };

    // Initial post + a one-shot retry (covers cases where the first
    // request fires before the operator's middleware is warm).
    lastUrlRef.current = window.location.href;
    post();
    const initialRetry = window.setTimeout(post, 1_000);

    const onPop = () => flush();
    window.addEventListener('popstate', onPop);

    // nuqs + Next.js trigger a popstate on shallow navigations, but
    // not every router.push goes through history.pushState in dev.
    // Poll the URL every 500ms as a safety net; the diff check keeps
    // POST volume low.
    // perf:allow A7 — diff-guarded URL-change safety poll; flush only POSTs on an
    // actual URL change, so the steady-state cost is a 500ms string compare.
    const poll = window.setInterval(flush, 500);
    const heartbeat = window.setInterval(post, HEARTBEAT_MS);

    return () => {
      pending?.abort();
      window.clearTimeout(initialRetry);
      window.clearInterval(poll);
      window.clearInterval(heartbeat);
      window.removeEventListener('popstate', onPop);
    };
  }, []);
}
