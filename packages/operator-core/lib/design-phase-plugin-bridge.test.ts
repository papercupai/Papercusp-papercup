/**
 * P-006 — the design-phase plugin's bridge to the comparison engine.
 *
 * Plan: ratified-mockup-implementation-validation-2026-08-24 (D-017).
 *
 * ─── WHAT THIS FILE IS FOR ───────────────────────────────────────────────────
 *
 * `verbs.test.ts` proves the verb bodies behave. It does not prove the plugin
 * can REACH them, and that rendezvous is the part with a real failure mode:
 * the writer is an ESM module in this package, the reader is a CommonJS module
 * in the `libs/papercusp` submodule, and nothing about the two is checked by a
 * compiler. If the key strings drift apart, or the pin does not actually cross
 * the loader boundary, every verb silently answers `engine-unavailable` — which
 * is a legitimate answer in another context, so nothing looks broken.
 *
 * So this test loads the REAL plugin file through `createRequire` — the same
 * way the plugin loader does — installs REAL verb implementations into the
 * REAL pinned slot, and calls the plugin's own handlers. There is no fake
 * bridge: the path under test is the production path.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptureEnvironment, ThresholdPolicy } from './design-compare/contract';
import {
  DESIGN_COMPARE_HOST_SLOT,
  installDesignCompareVerbs,
  resetDesignCompareHostForTest,
} from './design-compare/host-registry';
import { createInMemoryReferenceStore } from './design-compare/reference-store';
import type { ComparisonProvider } from './design-compare/provider';
import { createDesignCompareVerbs } from './design-compare/verbs';
import { lintIr } from './design-ir/lint';
import type { UiIr } from './design-ir/schema';

const require_ = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PLUGIN_PATH = resolve(REPO_ROOT, 'libs/papercusp/plugins/design-phase/index.cjs');

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}
type Handler = (input: unknown, ctx: unknown) => Promise<ToolResult>;

const plugin = require_(PLUGIN_PATH) as {
  capabilities: string[];
  tools: Record<string, Handler>;
  _internal: {
    DESIGN_COMPARE_HOST_SLOT: string;
    readDesignCompareVerbs: (harnessSlug: string) => unknown;
  };
};

const manifest = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'libs/papercusp/plugins/design-phase/papercusp.json'), 'utf8'),
) as {
  capabilities: string[];
  tools: Array<{ name: string; roles?: string[]; capabilities?: string[]; inputSchema?: unknown }>;
};

const HARNESS = 'bridge-test-harness';
const FEATURE = 'F-bridge';
const REFERENCE = 'ref-bridge';

const ENV: CaptureEnvironment = {
  viewport: { width: 800, height: 600 },
  deviceScaleFactor: 1,
  browser: 'chromium',
  theme: 'light',
  fontSet: 'default',
};

const POLICY: ThresholdPolicy = {
  policyVersion: 'p-1',
  referenceClass: 'artifact-capture',
  eligibility: 'gateable',
  maxDiffRatio: 0.01,
  derivedFrom: 'bridge-test',
};

const ctx = { harnessSlug: HARNESS, workspaceId: 'ws', spawnId: 'spawn-bridge', role: 'reviewer' };

describe('design-phase plugin state component references (EI-25261432783270107)', () => {
  it('keeps the real tutorial state controls in the plugin lint coverage', async () => {
    const ir = JSON.parse(readFileSync(resolve(REPO_ROOT,
      'apps/operator/lib/onboarding/cloud-tutorial.ui.json'), 'utf8')) as UiIr;
    const result = JSON.parse((await plugin.tools.lint_spec({ ir }, ctx)).content[0].text);
    expect(result.issues.filter((issue: { ruleId: string }) => issue.ruleId === 'orphan-component-binding'))
      .toEqual([]);
    expect(result.errorCount).toBe(0);
    expect(result.issues.map((issue: { ruleId: string }) => issue.ruleId)).toEqual([
      'raw-escape-hatch', 'raw-escape-hatch',
    ]);
    expect(lintIr(ir).filter(issue => issue.ruleId === 'orphan-component-binding')).toEqual([]);
  });

  it('checks bindings under state children, slots, item and emptyState', async () => {
    const ir = {
      layout: { kind: 'stack' },
      components: ['resume', 'replay', 'restart', 'locate'].map(id => ({ id, registry: 'action.secondary' })),
      states: {
        paused: { kind: 'stack', children: [{ kind: 'component', ref: 'resume' }] },
        complete: { kind: 'stack', slots: { action: { kind: 'component', ref: 'replay' } } },
        skipped: { kind: 'stack', item: { kind: 'component', ref: 'restart' } },
        missing: { kind: 'stack', emptyState: { kind: 'component', ref: 'locate' } },
      },
    };
    const lint = async (value: unknown) => {
      const result = JSON.parse((await plugin.tools.lint_spec({ ir: value }, ctx)).content[0].text);
      return result.issues.filter((issue: { ruleId: string }) => issue.ruleId === 'orphan-component-binding');
    };
    expect(await lint(ir)).toEqual([]);
    expect(await lint({ ...ir, states: { ...ir.states,
      unknown: { kind: 'stack', slots: { action: { kind: 'component', ref: 'missing-binding' } } },
    } })).toEqual([expect.objectContaining({ severity: 'error',
      message: expect.stringContaining('missing-binding') })]);
    expect(await lint({ ...ir, states: {} })).toHaveLength(4);
  });
});

function fakeProvider(pixelDifference: number): ComparisonProvider {
  return {
    engine: { engine: 'fake/pixelmatch', engineVersion: '1.0.0' },
    async compare() {
      return { pixelDifference, diffArtifactWritten: true };
    },
  };
}

function installRealVerbs(): void {
  installDesignCompareVerbs(
    HARNESS,
    createDesignCompareVerbs({
      harnessSlug: HARNESS,
      store: createInMemoryReferenceStore(),
      now: () => 1_000,
      clock: () => '2026-08-25T00:00:00.000Z',
      materializeReferenceImage: async () => ({ path: '/tmp/ref.png' }),
      comparison: {
        provider: fakeProvider(0),
        probe: () => ({ exists: true, dimensions: { width: 800, height: 600 } }),
      },
    }),
  );
}

function body(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

const RATIFY_INPUT = {
  featureId: FEATURE,
  referenceId: REFERENCE,
  revision: 1,
  referenceClass: 'artifact-capture',
  contentSha256: 'f'.repeat(64),
  image: {
    mediaType: 'image/png',
    locator: '/refs/bridge.png',
    byteLength: 1024,
    width: 800,
    height: 600,
  },
  referenceEnvironment: ENV,
  requiredCases: [
    {
      caseId: 'default',
      environment: ENV,
      // Agrees with COMPARE_INPUT.target: coverage matches surface as well as
      // environment, so a mismatch here would leave the case uncovered.
      target: { targetId: 'story--default', targetKind: 'storybook-story' },
      rationale: 'primary',
    },
  ],
  provenance: { source: 'artifact-capture', sourceRef: 'artifact://bridge' },
};

const COMPARE_INPUT = {
  featureId: FEATURE,
  referenceId: REFERENCE,
  target: { targetId: 'story--default', targetKind: 'storybook-story', implementationRevision: 'impl-1' },
  environment: ENV,
  policy: POLICY,
  actualImagePath: '/tmp/actual.png',
  diffImagePath: '/tmp/diff.png',
};

afterEach(() => {
  resetDesignCompareHostForTest();
});

describe('the pinned slot key', () => {
  it('is the same literal on both sides of the loader boundary', () => {
    // The two sides cannot import each other — that is the entire design — so
    // the key is written down twice. This is the check that keeps the copies
    // from drifting into a silent no-rendezvous.
    expect(plugin._internal.DESIGN_COMPARE_HOST_SLOT).toBe(DESIGN_COMPARE_HOST_SLOT);
  });

  it('carries state written by the ESM host across to the CommonJS plugin', () => {
    // The pin has to survive the fact that the plugin loaded `@papercusp/module-singleton`
    // through a native CommonJS `require` while this file reached it through an
    // ESM import — two module records, one `globalThis` slot.
    expect(plugin._internal.readDesignCompareVerbs(HARNESS)).toBeNull();
    installRealVerbs();
    expect(plugin._internal.readDesignCompareVerbs(HARNESS)).not.toBeNull();
  });

  it('keeps harnesses separate', () => {
    installRealVerbs();
    expect(plugin._internal.readDesignCompareVerbs('some-other-harness')).toBeNull();
  });
});

describe('with no engine installed', () => {
  it('refuses every verb loudly, and never reports a verdict', async () => {
    for (const verb of ['ratify_reference', 'compare_render', 'get_design_evidence'] as const) {
      const result = await plugin.tools[verb]!(
        { featureId: FEATURE, referenceId: REFERENCE, contentSha256: 'x', actualImagePath: '/a', diffImagePath: '/d' },
        ctx,
      );
      expect(result.isError, verb).toBe(true);
      const payload = body(result);
      expect(payload.code, verb).toBe('engine-unavailable');
      // The refusal must not be mistakable for a measurement. An absent engine
      // is a host misconfiguration; describing it with a verdict would put it
      // into the evidence record wearing evidence's clothes.
      expect(payload, verb).not.toHaveProperty('verdict');
      expect(payload, verb).not.toHaveProperty('result');
    }
  });
});

describe('with the engine installed', () => {
  it('round-trips ratify → compare → read through the plugin handlers', async () => {
    installRealVerbs();

    const ratified = await plugin.tools.ratify_reference!(RATIFY_INPUT, ctx);
    expect(ratified.isError).toBeUndefined();
    expect(body(ratified)).toMatchObject({ ok: true, revision: 1, ratifiedBy: 'reviewer:spawn-bridge' });

    const compared = await plugin.tools.compare_render!(COMPARE_INPUT, ctx);
    expect(compared.isError).toBeUndefined();
    const comparedBody = body(compared) as { ok: boolean; result: { verdict: string } };
    expect(comparedBody.ok).toBe(true);
    expect(comparedBody.result.verdict).toBe('pass');

    const read = await plugin.tools.get_design_evidence!(
      { featureId: FEATURE, referenceId: REFERENCE },
      ctx,
    );
    expect(read.isError).toBeUndefined();
    const readBody = body(read) as {
      evidence: Array<{ current: boolean; advisory: { notes: string | null } }>;
      coverage: Array<{ verdict: string | null }>;
    };
    expect(readBody.evidence).toHaveLength(1);
    expect(readBody.evidence[0]!.current).toBe(true);
    expect(readBody.coverage[0]!.verdict).toBe('pass');
  });

  it('takes the ratifying principal from ctx, not from input', async () => {
    installRealVerbs();
    const ratified = await plugin.tools.ratify_reference!(RATIFY_INPUT, {
      ...ctx,
      role: 'architect',
      spawnId: 'spawn-zzz',
    });
    expect(body(ratified).ratifiedBy).toBe('architect:spawn-zzz');
  });

  it('flags a verb refusal as a tool error, but not a legitimate invalid verdict', async () => {
    installRealVerbs();
    // Nothing ratified yet ⇒ a refusal ⇒ isError.
    const refused = await plugin.tools.compare_render!(COMPARE_INPUT, ctx);
    expect(refused.isError).toBe(true);
    expect(body(refused).code).toBe('not-ratified');

    // Ratified, but compared at a different theme ⇒ a real `invalid` result.
    // That IS evidence, so it must NOT be dressed up as a failed tool call.
    await plugin.tools.ratify_reference!(RATIFY_INPUT, ctx);
    const invalid = await plugin.tools.compare_render!(
      { ...COMPARE_INPUT, environment: { ...ENV, theme: 'dark' } },
      ctx,
    );
    expect(invalid.isError).toBeUndefined();
    const payload = body(invalid) as { result: { verdict: string; invalidReason: string } };
    expect(payload.result.verdict).toBe('invalid');
    expect(payload.result.invalidReason).toBe('environment-mismatch');
  });

  it('reports missing required input without reaching the engine', async () => {
    installRealVerbs();
    const result = await plugin.tools.compare_render!({ featureId: FEATURE }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('referenceId');
  });
});

describe('manifest and handler surface agree', () => {
  it('declares a handler for every manifest tool, which is the loader invariant', () => {
    // `registerPluginTools` reports "manifest declares tool X but plugin export
    // has no matching handler" as a load error the fleet only sees in a log.
    for (const tool of manifest.tools) {
      expect(typeof plugin.tools[tool.name], tool.name).toBe('function');
    }
  });

  it('declares the three P-006 verbs in the manifest and both capability lists', () => {
    const names = manifest.tools.map((t) => t.name);
    for (const verb of ['ratify_reference', 'compare_render', 'get_design_evidence']) {
      expect(names).toContain(verb);
      expect(manifest.capabilities).toContain(`tools:design:${verb}`);
      expect(plugin.capabilities).toContain(`tools:design:${verb}`);
    }
  });

  it('does not offer ratification to the designer role', () => {
    // D-001 draws the line between unconstrained exploration and an explicit
    // ratification transition. A designer that could ratify its own mockup
    // would erase that line, and the role list is where it is enforced.
    const ratify = manifest.tools.find((t) => t.name === 'ratify_reference')!;
    expect(ratify.roles).not.toContain('designer');
    expect(ratify.roles).toEqual(expect.arrayContaining(['reviewer', 'operator']));

    // Control: the comparison verbs ARE open to a designer, so the assertion
    // above is about ratification specifically and not about the whole plugin
    // being closed to designers.
    const compare = manifest.tools.find((t) => t.name === 'compare_render')!;
    expect(compare.roles).toContain('designer');
  });

  it('requires a difference-image path on compare_render', () => {
    // The pixelmatch comparator returns isWithinThreshold:true unconditionally
    // when invoked without one, so an optional field here would be a route to a
    // vacuous pass that never reaches the adapter's own guard.
    const compare = manifest.tools.find((t) => t.name === 'compare_render')!;
    const schema = compare.inputSchema as { required: string[] };
    expect(schema.required).toContain('diffImagePath');
  });
});
