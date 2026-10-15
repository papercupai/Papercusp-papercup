#!/usr/bin/env node
/**
 * Stable :3081 front door for the Cloud Portal backend on :3801.
 *
 * A portal handoff deliberately stops one :3801 generation before starting the
 * next. Safe read requests are held through that bounded gap so browser SSE and
 * page hydration do not surface a burst of 502s. Requests that may mutate state
 * are never replayed.
 */
import http from 'node:http';
import net from 'node:net';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// deploy-cloud-portal.sh installs this file as a STANDALONE program in ~/.local/bin, outside
// every node_modules tree, so it may import only `node:` builtins. A workspace import here
// (it once used @papercusp/operator-core's isCliEntry) resolves in the repo and in tests but
// dies with ERR_MODULE_NOT_FOUND at the installed path — which stayed latent until a reboot
// first started the installed copy and :3081 crash-looped (WI-10003268). Realpath both sides:
// argv[1] keeps a symlinked invocation path while import.meta.url is already resolved.
function isDirectEntry(importMetaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function optionsFromEnv(overrides = {}) {
  return {
    targetHost: overrides.targetHost ?? process.env.PAPERCUSP_CLOUD_PORTAL_PROXY_TARGET_HOST ?? '127.0.0.1',
    targetPort: positiveNumber(
      overrides.targetPort ?? process.env.PAPERCUSP_CLOUD_PORTAL_PROXY_TARGET_PORT,
      3801,
    ),
    listenHost: overrides.listenHost ?? process.env.PAPERCUSP_CLOUD_PORTAL_PROXY_LISTEN_HOST ?? '127.0.0.1',
    listenPort: positiveNumber(
      overrides.listenPort ?? process.env.PAPERCUSP_CLOUD_PORTAL_PROXY_LISTEN_PORT,
      3081,
    ),
    retryWindowMs: positiveNumber(
      overrides.retryWindowMs ?? process.env.PAPERCUSP_CLOUD_PORTAL_PROXY_RETRY_MS,
      15_000,
    ),
    retryDelayMs: positiveNumber(
      overrides.retryDelayMs ?? process.env.PAPERCUSP_CLOUD_PORTAL_PROXY_RETRY_DELAY_MS,
      100,
    ),
  };
}

export function isRetryablePortalRequest(method) {
  const normalized = String(method || 'GET').toUpperCase();
  return normalized === 'GET' || normalized === 'HEAD';
}

function upstreamHeaders(headers, options) {
  return {
    ...headers,
    host: `${options.targetHost}:${options.targetPort}`,
    'x-forwarded-host': headers.host || `${options.listenHost}:${options.listenPort}`,
    'x-forwarded-proto': 'http',
  };
}

function forwardHttpRequest(req, res, options) {
  const startedAt = Date.now();
  const retryable = isRetryablePortalRequest(req.method);
  let attempts = 0;
  let settled = false;
  let retryTimer = null;

  const clearRetry = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
  };

  res.once('close', () => {
    if (!res.writableEnded) {
      settled = true;
      clearRetry();
    }
  });

  const fail = (error) => {
    if (settled || res.destroyed) return;
    settled = true;
    clearRetry();
    if (!res.headersSent) {
      res.writeHead(502, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      });
    }
    res.end('Papercusp Portal upstream unavailable\n');
    // Transport messages and arbitrary error fields can carry request credentials.
    const errorCode = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN']
      .includes(error?.code) ? error.code : 'upstream_error';
    console.error(
      `portal proxy request failed after ${attempts} attempt(s) / ${Date.now() - startedAt}ms:`,
      errorCode,
    );
  };

  const attempt = () => {
    if (settled || res.destroyed) return;
    attempts += 1;
    const proxy = http.request(
      {
        hostname: options.targetHost,
        port: options.targetPort,
        path: req.url,
        method: req.method,
        headers: upstreamHeaders(req.headers, options),
      },
      (upstream) => {
        if (settled || res.destroyed) {
          upstream.destroy();
          return;
        }
        settled = true;
        clearRetry();
        const headers = { ...upstream.headers };
        if (typeof headers.location === 'string') {
          headers.location = headers.location
            .replace(`${options.targetHost}:${options.targetPort}`, `${options.listenHost}:${options.listenPort}`)
            .replace(`localhost:${options.targetPort}`, `${options.listenHost}:${options.listenPort}`);
        }
        res.writeHead(upstream.statusCode || 502, headers);
        upstream.pipe(res);
      },
    );

    proxy.once('error', (error) => {
      const remainingMs = options.retryWindowMs - (Date.now() - startedAt);
      if (retryable && !res.headersSent && remainingMs > 0 && !res.destroyed) {
        retryTimer = setTimeout(attempt, Math.min(options.retryDelayMs, remainingMs));
        return;
      }
      fail(error);
    });

    if (retryable) proxy.end();
    else req.pipe(proxy);
  };

  req.once('aborted', () => {
    settled = true;
    clearRetry();
  });
  attempt();
}

export function createPortalProxy(overrides = {}) {
  const options = optionsFromEnv(overrides);
  const server = http.createServer((req, res) => forwardHttpRequest(req, res, options));

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(options.targetPort, options.targetHost, () => {
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (const [name, value] of Object.entries(upstreamHeaders(req.headers, options))) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) raw += `${name}: ${item}\r\n`;
        } else {
          raw += `${name}: ${value}\r\n`;
        }
      }
      upstream.write(`${raw}\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return server;
}

export function startPortalProxy(overrides = {}) {
  const options = optionsFromEnv(overrides);
  const server = createPortalProxy(options);
  server.listen(options.listenPort, options.listenHost, () => {
    console.log(
      `Papercusp Cloud Portal front door listening on http://${options.listenHost}:${options.listenPort}/ -> http://${options.targetHost}:${options.targetPort}/`,
    );
  });
  return server;
}

if (isDirectEntry(import.meta.url)) startPortalProxy();
