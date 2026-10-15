/**
 * ws-guard.ts's corrected claim about same-listener WebSockets must stay true of
 * the tree (EI-21855861879191381). Sibling of `gate-candidate-ref.test.ts` /
 * `retired-surfaces.test.ts`, same family and same discipline.
 *
 * THE FIXTURE CONTROLS ARE THE LOAD-BEARING PART, for the reason those siblings
 * state: the moment the live assertion goes green it stops being evidence that the
 * detector works at all. Each fixture reproduces a shape that MUST be caught — or,
 * in two cases, one that must NOT be, because a false positive here would train
 * the next reader to silence the guard.
 *
 * The most important control is the last one. This test's whole subject is a
 * comment that made a false claim, and the corrected comment now QUOTES the very
 * construct being detected. A comment-blind scanner would flag the paragraph
 * documenting the problem as an instance of the problem — so "comments are not
 * code" is pinned here rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyWsBinding,
  findWsSites,
  judgeWsSites,
  sharesListener,
  type AllowedWsSite,
} from './same-listener-websocket-sites';

// lib/doc-claims → lib → operator-core → packages → <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WS_GUARD = join(ROOT, 'libs/generic/desktop-ipc/src/ws-guard.ts');

/**
 * THE DECLARED SET. Every WebSocket server in the tree that shares an HTTP
 * listener rather than owning a port. Adding an entry is meant to be a deliberate,
 * reviewable act — that is the whole mechanism, exactly as
 * `transport-coverage.test.ts` requires a `reason` for every uncovered surface.
 */
const SAME_LISTENER_WEBSOCKET_SITES: readonly AllowedWsSite[] = [
  {
    file: 'apps/operator/bin/hosted-handler.ts',
    binding: 'noServer',
    reason:
      'The hosted (app.papercusp.com) runtime serves /api/hosted/connectors/socket from an ' +
      'upgrade() hook on the same handler that mounts /api/* and the SPA. It is deliberate: the ' +
      'browser and the BYOC reverse connector must meet on ONE ticket-authenticated path, and a ' +
      'dedicated port would need its own TLS termination and firewall hole on every hosted ' +
      'deployment. It does NOT weaken ws-guard.ts, which protects the DESKTOP webview — a ' +
      'different runtime that talks to its own local host and cannot reach this socket. It DOES ' +
      'mean the browser portal has a same-origin WebSocket with no polyfill and no guard, which ' +
      'is the portal transport inventory\'s problem to classify (P-016, unified-web-portal).',
  },
];

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  '.git',
  'coverage',
  '_retired',
  'e2e',
]);

function collectTsFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) collectTsFiles(full, out);
    else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('.test.ts') &&
      !entry.endsWith('.spec.ts') &&
      !entry.endsWith('.d.ts')
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('same-listener WebSocket sites (EI-21855861879191381)', () => {
  describe('fixture controls — the detector must be able to FAIL', () => {
    it('catches { noServer: true } — the shape that refuted the original claim', () => {
      const sites = findWsSites(
        'fixture.ts',
        `const websocketServer = new WebSocketServer({ noServer: true });`,
      );
      expect(sites).toHaveLength(1);
      expect(sites[0]!.binding).toBe('noServer');
      expect(sharesListener(sites[0]!)).toBe(true);
    });

    it('retains a real constructor after a route wildcard string', () => {
      const source = [
        'app.all("/api/*", handler);',
        'const websocketServer = new WebSocketServer({ noServer: true });',
        '/* a later real comment */',
      ].join('\n');
      expect(findWsSites('fixture.ts', source)).toEqual([
        { file: 'fixture.ts', line: 2, binding: 'noServer' },
      ]);
    });

    it('catches a direct { server } attachment, shorthand or not', () => {
      expect(classifyWsBinding('new WebSocketServer({ server })')).toBe('server-attach');
      expect(classifyWsBinding('new WebSocketServer({ server: httpServer })')).toBe(
        'server-attach',
      );
    });

    it('catches a Hono upgradeWebSocket route', () => {
      const sites = findWsSites('fixture.ts', `app.get('/ws', upgradeWebSocket((c) => ({})));`);
      expect(sites).toHaveLength(1);
      expect(sites[0]!.binding).toBe('upgrade-route');
      expect(sharesListener(sites[0]!)).toBe(true);
    });

    it('catches a binding it does not recognize — unknown is NOT treated as safe', () => {
      const sites = findWsSites('fixture.ts', `const wss = new WebSocketServer(someOpaqueConfig);`);
      expect(sites[0]!.binding).toBe('unclassified');
      expect(sharesListener(sites[0]!)).toBe(true);
    });

    it('survives a Prettier-split options object — the false-absence shape', () => {
      // Scanning only the opening line reports "no port here", which is exactly
      // how a real absence claim gets manufactured from correct code.
      const sites = findWsSites(
        'fixture.ts',
        [
          'const wss = new WebSocketServer({',
          "  host: '127.0.0.1',",
          '  port,',
          '  path: WS_PATH,',
          '});',
        ].join('\n'),
      );
      expect(sites).toHaveLength(1);
      expect(sites[0]!.binding).toBe('dedicated-port');
      expect(sharesListener(sites[0]!)).toBe(false);
    });

    it('does NOT flag a dedicated port — the compliant shape stays quiet', () => {
      const sites = findWsSites('fixture.ts', `new WebSocketServer({ port: 3076 })`);
      expect(sharesListener(sites[0]!)).toBe(false);
      expect(judgeWsSites(sites, []).ok).toBe(true);
    });

    it('does NOT read a construct quoted inside a COMMENT as a real site', () => {
      // The corrected ws-guard.ts header quotes `new WebSocketServer({ noServer: true })`
      // while explaining this very defect. A comment-blind scanner would report that
      // paragraph as a violation of itself — a false positive on the one file whose
      // accuracy this test exists to protect.
      const sites = findWsSites(
        'fixture.ts',
        [
          '/**',
          ' * hosted-handler.ts builds `new WebSocketServer({ noServer: true })` and',
          ' * serves /api/hosted/connectors/socket from an upgradeWebSocket() hook.',
          ' */',
          "export const unrelated = 'code';",
          '// new WebSocketServer({ server })',
        ].join('\n'),
      );
      expect(sites).toEqual([]);
    });

    it('reports an UNCOVERED sharing site as a violation', () => {
      const sites = findWsSites('rogue.ts', `new WebSocketServer({ noServer: true })`);
      const verdict = judgeWsSites(sites, SAME_LISTENER_WEBSOCKET_SITES);
      expect(verdict.ok).toBe(false);
      expect(verdict.unexpected).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/SHARES an HTTP listener/);
    });

    it('reports a STALE allowlist entry — drift in the other direction', () => {
      const verdict = judgeWsSites([], SAME_LISTENER_WEBSOCKET_SITES);
      expect(verdict.ok).toBe(false);
      expect(verdict.missing).toHaveLength(1);
      expect(verdict.violations.join('\n')).toMatch(/stale allowlist hides the next real one/);
    });
  });

  describe('the live tree', () => {
    it('has no same-listener WebSocket beyond the declared set', () => {
      const roots = ['apps/operator', 'packages', 'libs'].map((r) => join(ROOT, r));
      const sites = roots
        .flatMap((r) => collectTsFiles(r))
        .flatMap((file) =>
          findWsSites(relative(ROOT, file), readFileSync(file, 'utf8')),
        );

      // A detector that silently scanned nothing would pass this test vacuously —
      // the exact false-absence shape the whole file is about.
      expect(sites.length, 'scanned the tree and found no WebSocketServer at all').toBeGreaterThan(
        0,
      );

      const verdict = judgeWsSites(sites, SAME_LISTENER_WEBSOCKET_SITES);
      expect(verdict.violations.join('\n')).toBe('');
      expect(verdict.ok).toBe(true);
    });
  });

  describe("ws-guard.ts's header", () => {
    const source = readFileSync(WS_GUARD, 'utf8');

    it('no longer makes the refuted repo-wide absence claim', () => {
      // The original: "There is no `noServer:true` and no `{ server }` attachment
      // anywhere, so no socket shares the operator's HTTP listener."
      expect(source).not.toMatch(/no\s+`?\{?\s*server\s*\}?`?\s+attachment\s+anywhere/i);
      expect(source).not.toMatch(/operator serves ZERO WebSocket endpoints/i);
    });

    it('scopes the surviving claim to the LOCAL operator and names the correction', () => {
      expect(source).toMatch(/LOCAL operator's HTTP listener/);
      expect(source).toMatch(/EI-21855861879191381/);
      expect(source).toMatch(/hosted-handler\.ts/);
    });
  });
});
