/**
 * Tests for unknown-tool-referral (EI-9011, generalized — plan
 * fleet-retro-hardening-2026-07-10 P-002) + the dangling-tool-ref integrity scan.
 *
 * The scan is the durable half: any `ns:verb` token that agent-facing referral text
 * (hook refusals, the capability map, the unknown_tool error itself) tells an agent to
 * call must resolve against the LIVE projected registry — a rename that strands a
 * printed tool name reds HERE instead of stranding blocked agents at runtime.
 * Matching is separator-normalized (`:`/`_`/`-`/`.`) because MCP clients rewrite `:`
 * to `_` when advertising, and the referral machinery recovers those variants.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Full-catalog side-effect registration (same pattern as tool-harness-scope.test.ts).
import '../index';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { capabilityMapText } from './capability-map';
import {
  isPluginNamespacedToolName,
  normalizeToolName,
  suggestClosestToolNames,
  unknownToolReferral,
} from './unknown-tool-referral';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../..');

describe('normalizeToolName', () => {
  it('strips the client mcp__<server>__ wrapper and unifies separators', () => {
    expect(normalizeToolName('mcp__papercusp-su__locks_acquire')).toBe('locks:acquire');
    expect(normalizeToolName('locks_acquire')).toBe('locks:acquire');
    expect(normalizeToolName('locks:acquire')).toBe('locks:acquire');
    expect(normalizeToolName('fleet:launch_on_plan')).toBe(normalizeToolName('fleet:launch-on-plan'));
  });
});

describe('suggestClosestToolNames', () => {
  it('recovers a client-format variant to the exact registered name', () => {
    expect(suggestClosestToolNames('locks_acquire')[0]).toBe('locks:acquire');
    expect(suggestClosestToolNames('mcp__papercusp-su__locks_acquire')[0]).toBe('locks:acquire');
  });

  it('suggests the family for a typo\'d verb', () => {
    const hits = suggestClosestToolNames('locks:aquire');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((n) => n.startsWith('locks:'))).toBe(true);
  });

  it('fabricates nothing for an unrelated string', () => {
    expect(suggestClosestToolNames('qqqxyzzz')).toEqual([]);
  });
});

describe('unknownToolReferral', () => {
  it('keeps the unknown_tool error-code prefix and carries the routing referral', () => {
    const text = unknownToolReferral('locks_acquire');
    expect(text).toMatch(/^unknown_tool: no tool named "locks_acquire"/);
    expect(text).toContain('locks:acquire'); // closest-match recovery
    expect(text).toContain('tools:invoke');
    expect(text).toContain('tools:find');
  });

  it('omits the matches clause when nothing is close', () => {
    const text = unknownToolReferral('qqqxyzzz');
    expect(text).not.toContain('Closest catalog matches');
    expect(text).toContain('tools:invoke');
  });

  // EI-18752546668875973: a doc-cited name can miss for a third reason besides "typo" and
  // "the doc is wrong" — it exists in source but hasn't reached THIS operator's deployed
  // code yet. Name that possibility + the diagnostic step at the moment of failure, instead
  // of leaving the agent to conclude the doc/registry itself is wrong.
  it('names "not yet deployed" as a possibility and points at dev:pipeline_position', () => {
    const text = unknownToolReferral('testing:run');
    expect(text).toContain('not be deployed to THIS operator yet');
    expect(text).toContain('dev:pipeline_position');
  });

  // staging-build-tool-routing-2026-10-21 R-3: on the main build, the not-deployed case has a
  // route that does not wait for the deploy — the per-call staging selector.
  it('names build:"staging" on tools:invoke as the route when this operator serves main', () => {
    const text = unknownToolReferral('testing:run', 'main');
    expect(text).toContain("tools:invoke { name, args, build: 'staging' }");
    expect(text).toContain("tools:find { query, build: 'staging' }");
    expect(text).toContain(':3170');
  });

  // Falsifiability control: on the staging operator the same sentence would point at itself.
  it('omits the staging route when this operator already serves staging', () => {
    const text = unknownToolReferral('testing:run', 'staging');
    expect(text).not.toContain("build: 'staging'");
    expect(text).toMatch(/^unknown_tool: no tool named "testing:run"/);
  });

  // EI-22365453839629245: the plugin-sweep window. Plugin verbs register INCREMENTALLY after
  // an operator restart, so one verb can miss while a sibling dispatches — a transient miss
  // that both other reasons ("typo", "not deployed") would have the agent read as permanent.
  it('names the transient plugin-sweep window for a plugin-shaped name', () => {
    const text = unknownToolReferral('design-phase.validate_spec');
    expect(text).toContain('PLUGIN-shaped');
    expect(text).toContain('TRANSIENT');
    expect(text).toContain('plugins:runtime_status');
    // The sibling-verb asymmetry is the load-bearing detail: it is what made the real report
    // look like a real defect (search_registry worked; validate_spec/lint_spec did not).
    expect(text).toContain('SIBLING verb');
  });

  it('recognises a plugin-shaped name through the client mcp__<server>__ wrapper', () => {
    const text = unknownToolReferral('mcp__papercusp-su__gitnexus.context');
    expect(text).toContain('PLUGIN-shaped');
  });

  // Falsifiability control: without this, the three assertions above would still pass if the
  // hint were appended UNCONDITIONALLY, which would tell every typo'd core-tool caller to go
  // read plugin status. A core `ns:verb` name must NOT get the plugin branch.
  it('does NOT add the plugin hint for a core colon-form or client-underscore name', () => {
    for (const name of ['locks_acquire', 'testing:run', 'qqqxyzzz', 'mcp__papercusp-su__locks_acquire']) {
      const text = unknownToolReferral(name);
      expect(text).not.toContain('PLUGIN-shaped');
      expect(text).not.toContain('plugins:runtime_status');
    }
  });
});

describe('isPluginNamespacedToolName', () => {
  it('is true only for the dot-separated <plugin>.<verb> family', () => {
    expect(isPluginNamespacedToolName('design-phase.lint_spec')).toBe(true);
    expect(isPluginNamespacedToolName('repomix.pack')).toBe(true);
    expect(isPluginNamespacedToolName('mcp__papercusp-su__design-phase.lint_spec')).toBe(true);
    expect(isPluginNamespacedToolName('work_items:claim')).toBe(false);
    expect(isPluginNamespacedToolName('work_items_claim')).toBe(false);
    expect(isPluginNamespacedToolName('mcp__papercusp-su__work_items_claim')).toBe(false);
  });

  // Guards the documented reason this cannot be built on normalizeToolName: that normalizer
  // folds '.' and ':' onto ONE separator, so reusing it would classify every core tool as a
  // plugin tool. If someone "simplifies" the helper onto it, this reds.
  it('stays distinct from the separator-folding normalizer', () => {
    expect(normalizeToolName('design-phase.lint_spec')).toBe(normalizeToolName('design-phase:lint_spec'));
    expect(isPluginNamespacedToolName('design-phase.lint_spec')).toBe(true);
    expect(isPluginNamespacedToolName('design-phase:lint_spec')).toBe(false);
  });
});

describe('dangling tool-ref integrity (EI-9011 leg c)', () => {
  /** Agent-facing texts that NAME tools an agent is told to call. */
  const SCANNED_FILES = [
    'apps/operator/scripts/hooks/cc/pretooluse-locks-acquire.sh',
    'apps/operator/scripts/hooks/omp/coord-hook.ts',
  ];

  /** ns:verb-shaped tokens inside a real tool namespace that are deliberately NOT tool
   *  names. Keep SHORT — every entry weakens the guard. */
  const ALLOW = new Set<string>([
    'group:verb', // generic placeholder in guidance prose
  ]);

  const TOKEN_RE = /\b([a-z][a-z0-9_]{2,}):([a-z][a-z0-9_-]{2,})\b/g;

  it('every ns:verb a referral text names resolves against the live registry', () => {
    const registered = new Set<string>();
    const namespaces = new Set<string>();
    for (const t of listAllProjectedTools()) {
      const name = t.expose?.mcp?.name;
      if (!name) continue;
      registered.add(normalizeToolName(name));
      namespaces.add(name.split(':')[0]!);
    }
    expect(registered.size).toBeGreaterThan(100); // the full catalog actually loaded

    const sources: Array<{ label: string; text: string }> = [
      ...SCANNED_FILES.map((f) => ({ label: f, text: readFileSync(resolve(REPO_ROOT, f), 'utf8') })),
      { label: 'capability-map', text: capabilityMapText() },
      { label: 'unknown-tool-referral', text: unknownToolReferral('qqqxyzzz') },
    ];

    const dangling: string[] = [];
    for (const { label, text } of sources) {
      for (const m of text.matchAll(TOKEN_RE)) {
        const token = m[0];
        if (ALLOW.has(token)) continue;
        if (!namespaces.has(m[1]!)) continue; // not a tool namespace (URL scheme, arg:value, …)
        if (!registered.has(normalizeToolName(token))) dangling.push(`${label}: ${token}`);
      }
    }
    expect(dangling, `tool names printed to agents that no longer resolve:\n${dangling.join('\n')}`).toEqual([]);
  });
});
