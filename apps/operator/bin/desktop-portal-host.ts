import type { Http2Bindings, HttpBindings } from '@hono/node-server';
import { isLoopbackRequest } from '@papercusp/operator-core/lib/superuser-token';
import { isLoopbackAddress } from '@papercusp/operator-core/lib/auth/loopback-peer-trust';
import type { OperatorTransportInit } from '@papercusp/operator-core/lib/workspace-host/operator-relay-client';
import { HOSTED_PRINCIPAL_USER_HEADER } from '@papercusp/operator-core/lib/workspace-host/hosted-operator-http';
import { allowedLocalApiOrigin } from './host-cors';

type Bindings = HttpBindings | Http2Bindings;
type OperatorTransport = (path: string, init: OperatorTransportInit) => Promise<Response>;
type FetchApplication = { fetch(request: Request): Response | Promise<Response> };

/** The maintained portal's request scope, not a second transport implementation. */
export type PortalOperatorScope = <T>(transport: OperatorTransport, run: () => Promise<T>) => Promise<T>;

const CONTEXT_HEADERS = [
  'host', 'origin', 'referer', 'cookie', 'authorization',
  'x-papercusp-workspace', 'x-papercusp-machine',
] as const;

function localPortalRequest(request: Request, bindings?: Bindings): boolean {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (!headers.has('host')) headers.set('host', url.host);
  if (headers.has(HOSTED_PRINCIPAL_USER_HEADER) || !isLoopbackRequest(headers)
    || !isLoopbackRequest(new Headers({ host: url.host }))) return false;
  const socket = bindings?.incoming?.socket;
  if (socket && !isLoopbackAddress(socket.remoteAddress)) return false;
  const origin = headers.get('origin');
  return !origin || origin === url.origin || allowedLocalApiOrigin(origin) !== null;
}

function operatorPath(path: string, origin: string): URL {
  // Operator callers supply origin-relative paths. Reject an absolute URL or
  // authority override before constructing a Request carrying local credentials.
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new Error('desktop_portal_invalid_operator_path');
  }
  const url = new URL(path, origin);
  if (url.origin !== origin || url.hash || ![
    '/api/', '/vditor/', '/monaco/', '/internal/docs/',
  ].some(prefix => url.pathname.startsWith(prefix))) {
    throw new Error('desktop_portal_invalid_operator_path');
  }
  return url;
}

/**
 * Compose an explicitly selected LOCAL portal with the existing desktop API.
 * The caller supplies createPortalApi's local profile and its maintained
 * withOperatorTransport scope. No process environment, listener, signal handler,
 * external speech provider or public-build selection is changed here.
 *
 * Operator calls terminate in the supplied inner app, never this composition
 * or an HTTP fetch back into its listener. Bindings and trust/context headers
 * survive that hop; a portal request never creates a new local identity tier.
 */
export function createDesktopPortalHost(options: {
  portal: FetchApplication;
  withOperatorTransport: PortalOperatorScope;
  operator(request: Request, bindings?: Bindings): Response | Promise<Response>;
}) {
  return {
    async fetch(request: Request, bindings?: Bindings): Promise<Response> {
      const url = new URL(request.url);
      // Sidecar health and non-API assets keep their original handlers. This
      // adapter is mounted inside the host's existing CORS/rebinding guards.
      if (!url.pathname.startsWith('/api/') || url.pathname === '/api/health') {
        return options.operator(request, bindings);
      }
      // createLocalPortalAuthenticator is intentionally unconditional. Its
      // identity may only be reached AFTER this real local-request boundary.
      if (!localPortalRequest(request, bindings)) {
        return Response.json({ ok: false, error: 'desktop_portal_requires_local_owner' }, { status: 403 });
      }
      const transport: OperatorTransport = async (path, init) => {
        const target = operatorPath(path, url.origin);
        const headers = new Headers(init.headers);
        // The portal strips these across its hosted proxy boundary. This is
        // an in-process desktop hop: retain the original request's authority
        // and workspace so the inner operator runs its usual guards/routing.
        for (const name of CONTEXT_HEADERS) {
          const value = request.headers.get(name);
          if (value === null) headers.delete(name);
          else headers.set(name, value);
        }
        if (!headers.has('host')) headers.set('host', url.host);
        headers.delete('content-length');
        const upstream = new Request(target, {
          method: init.method,
          headers,
          ...(init.body === undefined ? {} : { body: init.body }),
          signal: init.signal ? AbortSignal.any([request.signal, init.signal]) : request.signal,
          redirect: 'manual',
        });
        return options.operator(upstream, bindings);
      };
      return options.withOperatorTransport(transport, async () => options.portal.fetch(request));
    },
  };
}
