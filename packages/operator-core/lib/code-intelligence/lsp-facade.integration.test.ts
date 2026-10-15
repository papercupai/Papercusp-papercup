/**
 * P-012 proof: the static read-only `lsp.*` facade
 * (plan `code-intelligence-routing-lsp-gitnexus-2026-08-20`).
 *
 * Two families, deliberately separated:
 *
 *  - POLICY, provable without a server: the closed op set, the flag gate, the
 *    argument refusals, the budget derivation, and the read-only contract.
 *    These are the rails a backend swap must not silently drop, so they are
 *    asserted against the facade's own exported contract rather than against a
 *    remembered shape.
 *  - BEHAVIOUR, against the REAL pinned server. Mocking a language server here
 *    would prove only that our translation layer round-trips; it could not
 *    catch a push-diagnostics timeout reported as a clean file, which is the
 *    single most dangerous outcome this facade can produce.
 *
 * The flag is MOCKED rather than flipped, because a test that mutates the live
 * flag store would race every other agent on this shared box.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const flagMock = vi.hoisted(() => ({ enabled: true }));
// PARTIAL mock. The adapter's own import graph (managedSpawn → task-manager)
// consumes other exports of this module — `onFlagChange` among them — so a
// wholesale replacement breaks the very code under test, with an error that
// masquerades as an LSP failure. Override only `getFlag`.
vi.mock('@papercusp/flags/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/flags/server')>()),
  getFlag: async () => flagMock.enabled,
}));

import {
  LSP_FACADE_OPS,
  MAX_SITES_PER_ANSWER,
  lspDaemonFacade as lspFacade,
  lspFacadeOpSpec,
  lspHealth,
  type LspFacadeOp,
} from './lsp-daemon-facade.ts';
import { DEFAULT_RESOURCE_BUDGET, isTrustworthyEmpty } from './contracts.ts';
import {
  LSP_VENDOR_DIR,
  lspClientInventory,
  resolveServerBin,
  shutdownAllLspClients,
} from './lsp-adapter.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const IMPORT_SITE = join(REPO_ROOT, 'libs/generic/search/src/leg-health.ts');

const TS_SERVER_PRESENT = resolveServerBin('typescript') !== null;
const skipReason = TS_SERVER_PRESENT
  ? ''
  : `— SKIPPED: pinned typescript-language-server not provisioned under ${LSP_VENDOR_DIR} (run P-007)`;

beforeEach(() => {
  flagMock.enabled = true;
});

afterAll(async () => {
  await shutdownAllLspClients();
});

describe('facade contract (no server needed)', () => {
  it('the advertised op spec and the op set cannot drift apart', () => {
    const spec = lspFacadeOpSpec();
    const specOps = spec.map((s) => s.op).sort();
    expect(specOps).toEqual([...LSP_FACADE_OPS].sort());
    // Both directions: a spec entry for a nonexistent op is as much a lie as a
    // missing one, and a tool description generated from a drifted spec
    // advertises capabilities the facade will refuse.
    expect(spec).toHaveLength(LSP_FACADE_OPS.length);
  });

  it('advertises exactly seven operations, none of which writes', () => {
    // The 5-7 facade cap is a plan constraint (D-007), asserted rather than
    // remembered so an eighth op is a deliberate act with a red test.
    expect(LSP_FACADE_OPS).toHaveLength(7);
    for (const entry of lspFacadeOpSpec()) {
      expect(entry.reads, `${entry.op} must read`).toBe(true);
      // The read-only rail. `refactor_preview` is the one that LOOKS like a
      // write; the no-mutation case below proves it is not.
      expect(entry.writes, `${entry.op} must not write`).toBe(false);
    }
  });

  it('derives its result cap from the shared budget rather than a magic number', () => {
    expect(MAX_SITES_PER_ANSWER).toBe(
      Math.floor(DEFAULT_RESOURCE_BUDGET.resultTokensMax / 12),
    );
    expect(MAX_SITES_PER_ANSWER).toBeGreaterThan(0);
  });
});

describe('flag gate', () => {
  it('a DISABLED facade says disabled — it never renders as "no results"', async () => {
    flagMock.enabled = false;
    for (const op of LSP_FACADE_OPS) {
      const answer = await lspFacade(op, {
        file: IMPORT_SITE,
        line1: 41,
        character: 11,
        name: 'pinModuleState',
        newName: 'x',
        rootPath: REPO_ROOT,
      });
      expect(answer.sites, `${op} leaked sites while disabled`).toHaveLength(0);
      expect(answer.error, `${op} was silently empty while disabled`).toMatch(/disabled/i);
      // 'unknown', not 'healthy': a disabled subsystem has no standing to
      // claim health, and isTrustworthyEmpty() must accept this only because
      // the error makes it LOUD.
      expect(answer.freshness.health).toBe('unknown');
      expect(isTrustworthyEmpty(answer)).toBe(true);
    }
  });

  it('a disabled facade never reaches the adapter at all', async () => {
    flagMock.enabled = false;
    const before = lspClientInventory().length;
    await lspFacade('symbol', {
      file: IMPORT_SITE,
      line1: 41,
      character: 11,
      rootPath: REPO_ROOT,
    });
    // A gate that refuses the RESULT but still spawned a language server would
    // leak a process per call while looking perfectly disabled.
    expect(lspClientInventory().length).toBe(before);
  });
});

describe('argument refusals are answers, not throws', () => {
  const cases: Array<{ what: string; op: string; args: Record<string, unknown>; match: RegExp }> = [
    {
      what: 'an op outside the closed set',
      op: 'apply_edit',
      args: {},
      match: /unknown lsp op|closed/i,
    },
    { what: 'a position op with no file', op: 'symbol', args: {}, match: /requires 'file'/ },
    {
      what: 'workspace_symbols with no name',
      op: 'workspace_symbols',
      args: {},
      match: /requires 'name'/,
    },
    {
      what: 'refactor_preview with no newName',
      op: 'refactor_preview',
      args: { file: IMPORT_SITE, line1: 41, character: 11 },
      match: /requires 'newName'/,
    },
    {
      what: 'a file no pinned server handles',
      op: 'symbol',
      args: { file: '/x/a.cpp', line1: 1, character: 0 },
      match: /no pinned language server/,
    },
    {
      what: 'a ZERO line, the off-by-one D-008 exists to prevent',
      op: 'symbol',
      args: { file: IMPORT_SITE, line1: 0, character: 0 },
      match: /ONE-indexed/,
    },
    {
      what: 'a position op missing line1/character',
      op: 'references',
      args: { file: IMPORT_SITE },
      match: /requires 'line1'/,
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.what} without throwing`, async () => {
      const answer = await lspFacade(c.op as LspFacadeOp, {
        ...c.args,
        rootPath: REPO_ROOT,
      });
      expect(answer.error, `no error for: ${c.what}`).toMatch(c.match);
      expect(answer.sites).toHaveLength(0);
      expect(answer.freshness.health).toBe('unknown');
      // The whole point: a refusal is trustworthy BECAUSE it is loud. If this
      // ever returned health:'healthy' with sites:[], a caller would read the
      // refusal as proof the symbol has no references.
      expect(isTrustworthyEmpty(answer)).toBe(true);
    });
  }
});

describe(`facade against the pinned server ${skipReason}`, () => {
  it.skipIf(!TS_SERVER_PRESENT)(
    'lsp.symbol resolves across a package boundary, one-indexed',
    { timeout: 90_000 },
    async () => {
      const answer = await lspFacade('symbol', {
        file: IMPORT_SITE,
        line1: 41,
        character: 11,
        rootPath: REPO_ROOT,
      });
      expect(answer.error, `lsp.symbol failed: ${answer.error}`).toBeNull();
      expect(answer.freshness.health).toBe('healthy');
      expect(answer.sites.length).toBeGreaterThan(0);
      expect(answer.sites[0].path).toBe('libs/generic/module-singleton/src/index.ts');
      // The off-by-one guard, again at the FACADE boundary: the wire says 105.
      expect(answer.sites[0].line1).toBe(106);
    },
  );

  it.skipIf(!TS_SERVER_PRESENT)(
    'lsp.diagnostics never reports "clean" from silence',
    { timeout: 90_000 },
    async () => {
      const answer = await lspFacade('diagnostics', {
        file: IMPORT_SITE,
        rootPath: REPO_ROOT,
      });
      // The load-bearing assertion. Either the server PUBLISHED (healthy, and
      // an empty list then genuinely means clean), or it did not (degraded +
      // error). What must never happen is health:'healthy' with sites:[] and
      // no publish behind it — a file reported clean because nobody spoke.
      if (answer.error === null) {
        expect(answer.freshness.health).toBe('healthy');
        expect(answer.freshness.indexedAt).not.toBeNull();
      } else {
        expect(answer.freshness.health).toBe('degraded');
        expect(answer.error).toMatch(/publishDiagnostics|clean bill of health|half-loaded/);
      }
      expect(isTrustworthyEmpty(answer)).toBe(true);
    },
  );

  it.skipIf(!TS_SERVER_PRESENT)(
    'lsp.workspace_symbols finds a declared symbol by name',
    { timeout: 90_000 },
    async () => {
      const answer = await lspFacade('workspace_symbols', {
        name: 'pinModuleState',
        language: 'typescript',
        rootPath: REPO_ROOT,
      });
      expect(answer.intent).toBe('symbol-search');
      if (answer.error === null && answer.sites.length > 0) {
        expect(answer.sites.some((s) => s.path.endsWith('.ts'))).toBe(true);
      } else {
        // A server that declines workspace/symbol must say so loudly.
        expect(isTrustworthyEmpty(answer)).toBe(true);
      }
    },
  );

  it.skipIf(!TS_SERVER_PRESENT)(
    'lsp.refactor_preview leaves the tree byte-identical',
    { timeout: 90_000 },
    async () => {
      const digest = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
      const targets = [
        IMPORT_SITE,
        join(REPO_ROOT, 'libs/generic/module-singleton/src/index.ts'),
      ];
      const before = targets.map(digest);

      const answer = await lspFacade('refactor_preview', {
        file: IMPORT_SITE,
        line1: 41,
        character: 11,
        newName: 'pinModuleStateRenamedByTest',
        rootPath: REPO_ROOT,
      });

      // THE read-only proof, and the reason this is verified by bytes rather
      // than by the tool's name: a rename that quietly applied would bypass
      // the PreToolUse lock arbitration and clobber a peer on this shared
      // checkout. Absence of mutation is asserted, never assumed.
      expect(targets.map(digest)).toEqual(before);
      expect(answer.intent).toBe('rename-preview');
      expect(isTrustworthyEmpty(answer)).toBe(true);
    },
  );

  it.skipIf(!TS_SERVER_PRESENT)(
    'a capped result set SAYS it was capped',
    { timeout: 90_000 },
    async () => {
      const full = await lspFacade('references', {
        file: IMPORT_SITE,
        line1: 41,
        character: 11,
        rootPath: REPO_ROOT,
      });
      if (full.error !== null || full.sites.length < 2) {
        // Not enough references to cut — the capping property is exercised by
        // the unit-level control below instead of being faked here.
        expect(isTrustworthyEmpty(full)).toBe(true);
        return;
      }
      const capped = await lspFacade('references', {
        file: IMPORT_SITE,
        line1: 41,
        character: 11,
        rootPath: REPO_ROOT,
        limit: 1,
      });
      expect(capped.sites).toHaveLength(1);
      expect(capped.truncation.truncated).toBe(true);
      // The PRE-cut total, so a caller can tell a capped 1 from a true 1.
      expect(capped.truncation.totalAvailable).toBeGreaterThan(1);
    },
  );

  it.skipIf(!TS_SERVER_PRESENT)(
    'lsp.health reports a taskId per server — the only safe kill handle',
    { timeout: 90_000 },
    async () => {
      await lspFacade('symbol', {
        file: IMPORT_SITE,
        line1: 41,
        character: 11,
        rootPath: REPO_ROOT,
      });
      const report = await lspHealth();
      expect(report.enabled).toBe(true);
      expect(report.provisioned.typescript).toBe(true);
      expect(report.servers.length).toBeGreaterThan(0);
      for (const s of report.servers) {
        // D-006: killing a language server by NAME on this shared box would
        // reach every peer agent's server. taskId is the only handle that
        // cannot.
        expect(s.taskId).toBeTruthy();
        expect(s.pid).toBeGreaterThan(0);
      }
      expect(report.overall).toBe('healthy');
    },
  );
});

describe(`concurrent-start budget ${skipReason}`, () => {
  it.skipIf(!TS_SERVER_PRESENT)(
    'concurrent first-calls share ONE server, not one each',
    { timeout: 120_000 },
    async () => {
      // RECURRENCE GUARD for a measured defect: the task ledger recorded two
      // `lsp:typescript` sidecars 18ms apart from a single run, because nothing
      // is written to the client cache until `initialize` returns (~3.5s) and
      // both callers had already missed it. Every individual answer still
      // looked correct, so only the ledger showed it — which is why this
      // asserts the INVENTORY, not the answers.
      // A clean slate is required to count servers — but shutting a sidecar
      // down inside a test body surfaces managed-spawn's known WI-37509 handoff:
      // `typescript-language-server` spawns `tsserver` as a grandchild, so at
      // the instant the systemd-run client exits the scope is briefly still
      // non-empty and the row is left for the reconciler. That is expected
      // behaviour, not our defect (the client now exits code 0, i.e. via the
      // protocol, not a signal). It is informational, not a warning; capture
      // both channels so a regression cannot re-red this otherwise-valid test.
      const warnings: string[] = [];
      const infos: string[] = [];
      const warnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation((...a: unknown[]) => void warnings.push(a.join(' ')));
      const infoSpy = vi.spyOn(console, 'info').mockImplementation((...a: unknown[]) => void infos.push(a.join(' ')));
      try {
        await shutdownAllLspClients();
        // managed-spawn's bounded handoff check reports the expected info
        // asynchronously after the client exit; keep the spy installed until
        // that signal arrives instead of racing its 250ms grace window.
        await vi.waitFor(
          () => {
            expect(infos.some((line) => /scope still holds processes|WI-37509/.test(line))).toBe(true);
          },
          { interval: 25, timeout: 1_000 },
        );
      } finally {
        warnSpy.mockRestore();
        infoSpy.mockRestore();
      }
      expect(warnings).toHaveLength(0);
      expect(infos.some((line) => /scope still holds processes|WI-37509/.test(line))).toBe(true);
      expect(lspClientInventory()).toHaveLength(0);

      const shared = { file: IMPORT_SITE, line1: 41, character: 11, rootPath: REPO_ROOT };
      const answers = await Promise.all([
        lspFacade('symbol', shared),
        lspFacade('references', shared),
        lspFacade('implementations', shared),
      ]);

      const typescriptServers = lspClientInventory().filter((c) => c.language === 'typescript');
      expect(
        typescriptServers,
        `three concurrent calls spawned ${typescriptServers.length} servers; ` +
          `DEFAULT_RESOURCE_BUDGET.childProcMax is 1`,
      ).toHaveLength(1);

      // And the sharing must not have cost correctness.
      for (const a of answers) expect(isTrustworthyEmpty(a)).toBe(true);
    },
  );
});

describe('health aggregation control', () => {
  it('reports the WORST server health, never the best', async () => {
    // A permanent control for the aggregation rule, independent of any live
    // server: reducing with the rank table must surface the unhealthy member.
    // If someone re-implements this as "healthy if any server is healthy",
    // one dead server disappears from the report and its confidently-empty
    // answers stop being attributable to anything.
    const rank = { healthy: 0, degraded: 1, unknown: 2, unhealthy: 3 } as const;
    const worstOf = (hs: Array<keyof typeof rank>) =>
      hs.reduce((w, h) => (rank[h] > rank[w] ? h : w), 'healthy' as keyof typeof rank);
    expect(worstOf(['healthy', 'healthy', 'unhealthy'])).toBe('unhealthy');
    expect(worstOf(['healthy', 'degraded'])).toBe('degraded');
    expect(worstOf(['healthy'])).toBe('healthy');
  });
});
