'use client';
import type { ReactNode } from 'react';
import { HarnessSyncProvider } from '../../providers/HarnessSyncProvider';
import {
  installDesktopIpcPolyfills,
  setConsentedTelemetryOrigin,
} from '@papercusp/operator-core/lib/transport-adapters/desktop-bootstrap';
import { configureOperatorUi } from '@papercusp/operator-ui/seam';
import { installWorkspaceHeaderFetch } from '@papercusp/operator-core/lib/transport-adapters/workspace-header-fetch';
import { installWorkspaceParamEventSource } from '@papercusp/operator-core/lib/transport-adapters/workspace-eventsource';
import { installOriginSchedulerFetch } from '@papercusp/operator-core/lib/transport-adapters/origin-scheduler-fetch';
import { installCallToolResolver } from '@papercusp/operator-core/lib/call-tool-resolver';
import { installIpcInspector } from '@papercusp/operator-core/lib/dev/ipc-inspector-client';
import HostedWorkspaceSelectionGate from './HostedWorkspaceSelectionGate';
import UpdateMismatchNotifier from './UpdateMismatchNotifier';
import { VoicePrefsSyncBridge } from './voice/VoicePrefsSyncBridge';

/**
 * Root sync provider. Wraps the app in `HarnessSyncProvider` and, on
 * Tauri, installs the desktop IPC polyfills so same-origin /api/*
 * `fetch` and every `EventSource` ride the IPC bridge instead of the
 * webview's HTTP connection pool.
 *
 * The install fires at *module-evaluation time*, not in `useEffect`:
 * React effects run in child-first commit order, so a `useEffect` here
 * would land *after* child components' effects had already opened their
 * SSE streams against the native `EventSource`. Module-eval runs once
 * per bundle load, well before any component's runtime
 * `new EventSource(...)` call. See
 * `lib/transport-adapters/desktop-bootstrap.ts` for the install rules.
 *
 * `installOriginSchedulerFetch` wraps the installed fetch, followed by
 * `installWorkspaceHeaderFetch`. Workspace and machine headers must be stamped
 * before a request enters the queue or its single-flight key is computed:
 * a later machine selection must not retarget a queued write or share reads
 * across machines. `installWorkspaceParamEventSource` wraps the installed
 * `window.EventSource` — `IpcEventSource` on desktop, native in the browser. The
 * fetch wrapper stamps `x-papercusp-workspace`; the EventSource wrapper appends
 * `?ws=` (streams can't set headers). Both make the backend resolve per-window
 * rather than against the global `reg.current`
 * (per-window-workspace-context-2026-05-31, P-013/P-015). They must install
 * after the IPC polyfills (to wrap the IPC transports) but before any component
 * opens a stream — module-eval ordering guarantees that.
 */
if (typeof window !== 'undefined') {
  configureOperatorUi({ setConsentedTelemetryOrigin });
  // Dev-only IPC-traffic recorder. Installs FIRST so it captures every dispatch
  // from the very first one; no-op in production. Exposes window.__ipcInspector
  // (.churn()/.summary()/.events()) — Plan: calltool-endpoint-seam (Phase C).
  installIpcInspector();
  installDesktopIpcPolyfills();
  // P-019: route every finite operator API fetch through the one process-pinned
  // per-origin scheduler. The workspace layer wraps it next, pinning request
  // identity before queueing; IPC remains the innermost transport. Sync-owned
  // rest-query and long-lived streams are explicitly skipped.
  installOriginSchedulerFetch();
  installWorkspaceHeaderFetch();
  installWorkspaceParamEventSource();
  // Register the callTool seam's transport resolver (tool name → canonical route
  // + Phase-E eligibility). No runtime change yet — nothing calls callTool until
  // the Phase B migration. Plan: calltool-endpoint-seam-2026-06-01.
  installCallToolResolver();
  // HarnessSyncProvider owns persistence after resolving the selected machine
  // and workspace. Restoring the unscoped singleton here would paint another
  // instance's retained rows before that boundary exists.
}

export function RootSyncProvider({ children }: { children: ReactNode }) {
  return (
    <HostedWorkspaceSelectionGate>
      <HarnessSyncProvider>
        {/* P-013: surface a post-update stale-operator mismatch (EI-9002) to the user. */}
        <UpdateMismatchNotifier />
        <VoicePrefsSyncBridge />
        {children}
      </HarnessSyncProvider>
    </HostedWorkspaceSelectionGate>
  );
}
