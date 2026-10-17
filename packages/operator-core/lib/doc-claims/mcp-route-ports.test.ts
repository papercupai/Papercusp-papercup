import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROXY_ENTRYPOINT,
  PROXY_UNIT,
  judgeMcpRoutePorts,
  stripComments,
} from './mcp-route-ports';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const LIVE_PROXY = readFileSync(join(REPO_ROOT, PROXY_ENTRYPOINT), 'utf8');
const LIVE_UNIT = readFileSync(join(REPO_ROOT, PROXY_UNIT), 'utf8');
const LIVE_DOC = readFileSync(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');

/** The shape of the real assignments, minimal enough to mutate in a control. */
const proxyFixture = (listen: number, target: number) =>
  [
    '/**',
    ` *   PAPERCUSP_MCP_PROXY_PORT  listen port (default ${listen})`,
    ` *   PAPERCUSP_MCP_PROXY_TARGET_PORT  upstream port (default ${target})`,
    ' */',
    `const targetPort = Number(process.env.PAPERCUSP_MCP_PROXY_TARGET_PORT ?? process.env.PAPERCUSP_HONO_PORT ?? ${target});`,
    'startProxy({',
    `  listenPort: Number(process.env.PAPERCUSP_MCP_PROXY_PORT ?? ${listen}),`,
    '});',
  ].join('\n');

const unitFixture = (listen: number) =>
  ['[Service]', `Environment=PAPERCUSP_MCP_PROXY_PORT=${listen}`].join('\n');

const docFixture = (...ports: number[]) =>
  `Your MCP calls go ${ports.map((p) => `:${p}`).join(' -> ')}.`;

describe('mcp-route-ports doc claim', () => {
  describe('fixture controls (the detector must be able to FAIL)', () => {
    it('reads a declared default actually passed through a shorthand proxy option', () => {
      for (const port of [9071, 9099]) {
        const source = proxyFixture(port, 3070).replace(
          /startProxy\(\{[\s\S]*?\}\);/,
          `const listenPort = Number(process.env.PAPERCUSP_MCP_PROXY_PORT ?? ${port});\nstartMcpProxy({ listenPort, retryWindowMs: 100 });`,
        );
        const verdict = judgeMcpRoutePorts({ proxySource: source, unitSource: unitFixture(port), docSource: docFixture(port, 3070) });
        expect(verdict.ok).toBe(true);
        expect(verdict.listenPort).toBe(port);
        expect(judgeMcpRoutePorts({ proxySource: source, unitSource: unitFixture(port), docSource: docFixture(9000, 3070) }).ok).toBe(false);
      }
    });

    it('does not credit an unused constant or a commented shorthand connection', () => {
      for (const connection of ['startMcpProxy({ targetPort: 3070 });', '// startMcpProxy({ listenPort });']) {
        const source = `const listenPort = Number(process.env.PAPERCUSP_MCP_PROXY_PORT ?? 9071);\nconst targetPort = Number(process.env.UPSTREAM ?? 3070);\n${connection}`;
        expect(judgeMcpRoutePorts({ proxySource: source, unitSource: unitFixture(9071), docSource: docFixture(9071, 3070) }).listenPort).toBeNull();
      }
    });

    it('accepts a tree where code, unit and doc all agree', () => {
      const v = judgeMcpRoutePorts({
        proxySource: proxyFixture(9071, 3070),
        unitSource: unitFixture(9071),
        docSource: docFixture(9071, 3070),
      });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      expect(v).toMatchObject({ listenPort: 9071, targetPort: 3070, unitListenPort: 9071 });
    });

    it('FAILS when the listen port moves and the doc is left behind', () => {
      // This is the whole reason the claim is pinned rather than hand-maintained: the
      // doc keeps confidently naming :9071 while every agent now routes through :9099.
      const v = judgeMcpRoutePorts({
        proxySource: proxyFixture(9099, 3070),
        unitSource: unitFixture(9099),
        docSource: docFixture(9071, 3070),
      });
      expect(v.ok).toBe(false);
      expect(v.listenPort).toBe(9099);
      expect(v.problems.join(' ')).toContain(':9099');
    });

    it('FAILS when the upstream execution port moves off the one the doc names', () => {
      const v = judgeMcpRoutePorts({
        proxySource: proxyFixture(9071, 3080),
        unitSource: unitFixture(9071),
        docSource: docFixture(9071, 3070),
      });
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain(':3080');
    });

    it('FAILS when the shipped unit and the entrypoint default disagree', () => {
      // A split like this is worse than either port being wrong: the doc would be
      // accurate for whichever one the reader did not have.
      const v = judgeMcpRoutePorts({
        proxySource: proxyFixture(9071, 3070),
        unitSource: unitFixture(9099),
        docSource: docFixture(9071, 3070),
      });
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toContain('cannot describe both');
    });

    it('does NOT accept a comment-only mention as a live wiring', () => {
      // The entrypoint's real header spells out both ports in prose, so a scan that did
      // not strip comments would keep passing after the assignments themselves were gone.
      const commentedOnly = [
        '/**',
        ' *   PAPERCUSP_MCP_PROXY_PORT  listen port (default 9071)',
        ' *   upstream port (default 3070)',
        ' */',
        'startProxy({});',
      ].join('\n');
      const v = judgeMcpRoutePorts({
        proxySource: commentedOnly,
        unitSource: unitFixture(9071),
        docSource: docFixture(9071, 3070),
      });
      expect(v.ok).toBe(false);
      expect(v.listenPort).toBeNull();
      expect(v.targetPort).toBeNull();
    });

    it('does NOT accept a unit line that is commented out', () => {
      const v = judgeMcpRoutePorts({
        proxySource: proxyFixture(9071, 3070),
        unitSource: '[Service]\n# Environment=PAPERCUSP_MCP_PROXY_PORT=9071',
        docSource: docFixture(9071, 3070),
      });
      expect(v.ok).toBe(false);
      expect(v.unitListenPort).toBeNull();
    });
  });

  describe('stripComments', () => {
    it('drops block and line comments but keeps the code', () => {
      expect(stripComments('/* x */ const a = 1; // y')).toContain('const a = 1;');
      expect(stripComments('/* 9071 */ const a = 1;')).not.toContain('9071');
    });
  });

  describe('the live tree', () => {
    it('keeps CLAUDE.md naming the proxy default ports', () => {
      const v = judgeMcpRoutePorts({
        proxySource: LIVE_PROXY,
        unitSource: LIVE_UNIT,
        docSource: LIVE_DOC,
      });
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
      // Positive control on the INSTRUMENT, not the subject: an unreadable or renamed
      // entrypoint would also yield "no problems" from a judge that parsed nothing, so
      // assert it genuinely resolved both ports from real assignments.
      expect(v.listenPort).toBeGreaterThan(0);
      expect(v.targetPort).toBeGreaterThan(0);
      expect(v.unitListenPort).toBe(v.listenPort);
    });

    it('requires per-invocation serving-host evidence before attributing a build', () => {
      // The proxy's default does not identify the host that served every call. Keep the
      // loaded-host/build ledger fields in the guidance and reject the old universal claim.
      expect(LIVE_DOC).toContain('MCP client URL does not prove which build served a call');
      expect(LIVE_DOC).toContain('harness_shared.tool_invocations');
      expect(LIVE_DOC).toContain('serving_host');
      expect(LIVE_DOC).toContain('serving_build_sha');
      expect(LIVE_DOC).not.toContain('Your own MCP tool calls execute `:3070`');
    });
  });
});
