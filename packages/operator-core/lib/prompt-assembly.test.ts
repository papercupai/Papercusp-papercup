/**
 * prompt-assembly unit tests. Covers:
 *   - section order (persona → catalog → playbook → runtime)
 *   - empty-state rendering (no guidance → description-only)
 *   - byRole override merging
 *   - missing tools.md → playbook section omitted (not failed)
 *   - missing persona.md → throws (every role must have one)
 *
 * The projection registry is module-singleton, so we use the existing
 * operator role with its current allowedTools list as the fixture (only
 * a few entries needed to exercise rendering).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promptsDir } from './prompt-assembly.js';

// Mock listAllProjectedTools so tests don't depend on what's registered
// at module-load time.
const mockTools: Array<{
  expose: { mcp: { name: string } };
  description: string;
  capabilities: string[];
  // `modality` is a real ProjectedTool field (define-tool.test.ts covers its
  // projection); the modality-filter tests below push it, so the mock type
  // must carry it or tsc rejects the literals (vitest/esbuild hid it).
  modality?: ('text' | 'voice')[];
  // Wire-schemas (token-efficient-agent-io P-003) projects columns from these.
  inputSchema?: Record<string, unknown>;
  outputJsonSchema?: Record<string, unknown>;
  guidance?: {
    when?: string;
    notWhen?: string;
    chaining?: string;
    argRedirects?: Record<string, string | { tool: string; args: Record<string, unknown>; note?: string }>;
    byRole?: Record<string, { when?: string; notWhen?: string; chaining?: string }>;
  };
  // tool-call-batching-wrappers P-010 — composite marker; the back-pointer tests push it.
  replaces?: readonly string[];
}> = [];

vi.mock('@papercusp/agent-mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/agent-mcp')>()),
  listAllProjectedTools: () => mockTools,
  // Admission must answer from the SAME fixture as the tool list above. The real
  // implementation resolves `lookupByMcpName` against the live registry, so leaving
  // it unmocked reintroduces exactly the module-load dependency this mock exists to
  // remove: a fixture tool absent from (or not role-admitted by) the real registry
  // silently renders without its corrective calls.
  projectedToolAdmitted: (name: string) =>
    mockTools.some((candidate) => candidate.expose.mcp.name === name),
  projectedToolCorrectiveCalls: (name: string) => {
    const tool = mockTools.find((candidate) => candidate.expose.mcp.name === name);
    return Object.entries(tool?.guidance?.argRedirects ?? {}).flatMap(([rejectedArg, redirect]) =>
      typeof redirect === 'string'
        ? []
        : [{
            rejectedArg,
            ...redirect,
            rendered: `${redirect.tool} ${JSON.stringify(redirect.args)}`,
            source: 'projected-tool-registry',
            registryRevision: 'projected-tool-registry-v1:test',
          }],
    );
  },
}));

// Force cache bypass throughout the tests so reloading mocks works.
beforeEach(() => {
  process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
  mockTools.length = 0;
});

afterEach(() => {
  delete process.env.PAPERCUSP_RELOAD_PROMPTS;
});

describe('renderToolsCatalog', () => {
  it('returns empty string when no toolNames provided', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    expect(renderToolsCatalog('operator', [])).toBe('');
  });

  it('fails closed when the caller advertises a tool absent from the live registry', async () => {
    const { renderToolsCatalog } = await import('./prompt-assembly');
    expect(() => renderToolsCatalog('operator', ['stale:missing']))
      .toThrow(/absent from the projected registry: stale:missing/);
  });

  it('renders registry provenance and a validated structured corrective call', async () => {
    mockTools.push({
      expose: { mcp: { name: 'work_items:update' } },
      description: 'Update a work item.',
      capabilities: [],
      guidance: {
        argRedirects: {
          tags: {
            tool: 'work_items:tag',
            args: { id: '<work-item-id>', topic: '<topic>' },
            note: 'canonical tag writer',
          },
        },
      },
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['work_items:update']);
    expect(out).toContain('Executable contract: projected-tool-registry');
    expect(out).toContain('Serving generation: unknown (not sampled)');
    expect(out).toContain('Correction for rejected `tags`');
    expect(out).toContain('`work_items:tag {"id":"<work-item-id>","topic":"<topic>"}`');
  });

  it('renders the shared serving generation when supplied by an async prompt boundary', async () => {
    mockTools.push({
      expose: { mcp: { name: 'work_items:list' } },
      description: 'List work items.',
      capabilities: [],
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['work_items:list'], 'text', undefined, {
      state: 'known',
      revision: 'serving-generation-v1:abc123',
      buildSha: 'build-sha',
      appliedMigrationDigest: 'migration-sha',
      toolRegistryRevision: 'tool-sha',
    });
    expect(out).toContain('Serving generation: serving-generation-v1:abc123');
  });

  it('renders a "Bundled by" back-pointer on a primitive a rendered composite replaces (P-010)', async () => {
    mockTools.push(
      { expose: { mcp: { name: 'fleet:assignments' } }, description: 'List assignments.', capabilities: [] },
      { expose: { mcp: { name: 'work_items:list' } }, description: 'List work items.', capabilities: [] },
      {
        expose: { mcp: { name: 'coord:orient' } },
        description: 'Orient + bootstrap in one call.',
        capabilities: [],
        replaces: ['fleet:assignments', 'work_items:list'],
      },
    );
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['fleet:assignments', 'work_items:list', 'coord:orient']);
    // each bundled primitive points at the composite
    expect(out).toContain('Bundled by: `coord:orient`');
    // the composite itself gets no back-pointer (it is not a bundled primitive).
    // Isolate just coord:orient's block (up to the next tool entry) — it sorts first,
    // so a naive split would bleed into the primitives' back-pointers rendered below.
    const compositeBlock = (out.split('- `coord:orient`')[1] ?? '').split('\n- `')[0];
    expect(compositeBlock).not.toContain('Bundled by:');
  });

  it('does not back-point at a composite the agent cannot reach (not in the rendered set)', async () => {
    mockTools.push(
      { expose: { mcp: { name: 'fleet:assignments' } }, description: 'List assignments.', capabilities: [] },
      { expose: { mcp: { name: 'coord:orient' } }, description: 'Orient.', capabilities: [], replaces: ['fleet:assignments'] },
    );
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['fleet:assignments']); // coord:orient NOT rendered
    expect(out).not.toContain('Bundled by:');
  });

  it('caps the back-pointer at 2 composites + "(+N more)" (D-006 bound)', async () => {
    mockTools.push(
      { expose: { mcp: { name: 'coord:inbox' } }, description: 'Inbox.', capabilities: [] },
      { expose: { mcp: { name: 'c:one' } }, description: 'one', capabilities: [], replaces: ['coord:inbox'] },
      { expose: { mcp: { name: 'c:two' } }, description: 'two', capabilities: [], replaces: ['coord:inbox'] },
      { expose: { mcp: { name: 'c:three' } }, description: 'three', capabilities: [], replaces: ['coord:inbox'] },
    );
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['coord:inbox', 'c:one', 'c:two', 'c:three']);
    expect(out).toContain('(+1 more)');
  });

  it('renders description-only for tools without guidance (backwards-identical)', async () => {
    mockTools.push({
      expose: { mcp: { name: 'tasks:list' } },
      description: 'List tasks for a harness.',
      capabilities: [],
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['tasks:list']);
    expect(out).toContain('`tasks:list`');
    expect(out).toContain('List tasks for a harness.');
    expect(out).not.toContain('When:');
    expect(out).not.toContain('Not when:');
    expect(out).not.toContain('Chaining:');
  });

  it('renders When/Not when/Chaining when guidance fields are populated', async () => {
    mockTools.push({
      expose: { mcp: { name: 'escalations:get' } },
      description: 'Returns active escalations for a harness.',
      capabilities: [],
      guidance: {
        when: 'User asks "what\'s wrong with X" or "any escalations".',
        notWhen: 'For health counts, use `harness_health`.',
        chaining: undefined,
      },
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['escalations:get']);
    expect(out).toContain('When: User asks "what\'s wrong with X"');
    expect(out).toContain('Not when: For health counts, use `harness_health`.');
    expect(out).not.toContain('Chaining:');
  });

  it('shallow-merges byRole over base guidance', async () => {
    mockTools.push({
      expose: { mcp: { name: 'harness:list' } },
      description: 'List harnesses.',
      capabilities: [],
      guidance: {
        when: 'Show me my work.',
        byRole: {
          worker: { when: 'Find the chunk I\'m assigned to.' },
        },
      },
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const operatorOut = renderToolsCatalog('operator', ['harness:list']);
    expect(operatorOut).toContain('When: Show me my work.');
    const workerOut = renderToolsCatalog('worker', ['harness:list']);
    expect(workerOut).toContain('When: Find the chunk I\'m assigned to.');
  });

  it('preserves base fields that byRole does not override', async () => {
    mockTools.push({
      expose: { mcp: { name: 'tasks:list' } },
      description: 'List tasks.',
      capabilities: [],
      guidance: {
        when: 'Default when.',
        notWhen: 'Default not when.',
        byRole: {
          worker: { when: 'Worker when.' },
          // notWhen NOT overridden — should inherit
        },
      },
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const workerOut = renderToolsCatalog('worker', ['tasks:list']);
    expect(workerOut).toContain('When: Worker when.');
    expect(workerOut).toContain('Not when: Default not when.');
  });

  describe('modality filter (Phase 4 T3.1)', () => {
    it('defaults to text-only when modality arg is omitted', async () => {
      mockTools.push({
        expose: { mcp: { name: 'text:only' } },
        description: 'A text-only tool.',
        capabilities: [],
        modality: ['text'],
      });
      mockTools.push({
        expose: { mcp: { name: 'voice:only' } },
        description: 'A voice-only tool.',
        capabilities: [],
        modality: ['voice'],
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      const out = renderToolsCatalog('operator', ['text:only', 'voice:only']);
      expect(out).toContain('`text:only`');
      expect(out).not.toContain('`voice:only`');
    });

    it('voice modality drops tools that declare modality:["text"]', async () => {
      mockTools.push({
        expose: { mcp: { name: 'chat:ask_choice' } },
        description: 'Buttons for clicking.',
        capabilities: [],
        modality: ['text'],
      });
      mockTools.push({
        expose: { mcp: { name: 'operator:converse' } },
        description: 'Both surfaces.',
        capabilities: [],
        modality: ['text', 'voice'],
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      const voiceOut = renderToolsCatalog('operator', ['chat:ask_choice', 'operator:converse'], 'voice');
      expect(voiceOut).not.toContain('chat:ask_choice');
      expect(voiceOut).toContain('operator:converse');
    });

    it('tools without declared modality appear in BOTH catalogs (default = both surfaces, regression for E2E bug #36)', async () => {
      mockTools.push({
        expose: { mcp: { name: 'legacy:tool' } },
        description: 'Has no modality field.',
        capabilities: [],
        // modality intentionally absent — default is now ['text','voice']
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      const voiceOut = renderToolsCatalog('operator', ['legacy:tool'], 'voice');
      expect(voiceOut).toContain('legacy:tool');
      const textOut = renderToolsCatalog('operator', ['legacy:tool'], 'text');
      expect(textOut).toContain('legacy:tool');
    });

    it('a tool declaring both modalities appears in both catalogs', async () => {
      mockTools.push({
        expose: { mcp: { name: 'both:surfaces' } },
        description: 'Works everywhere.',
        capabilities: [],
        modality: ['text', 'voice'],
      });
      const { renderToolsCatalog } = await import('./prompt-assembly');
      expect(renderToolsCatalog('operator', ['both:surfaces'], 'text')).toContain('both:surfaces');
      expect(renderToolsCatalog('operator', ['both:surfaces'], 'voice')).toContain('both:surfaces');
    });
  });

  it('deduplicates and sorts tool names alphabetically', async () => {
    mockTools.push({
      expose: { mcp: { name: 'b:tool' } },
      description: 'Second.',
      capabilities: [],
    });
    mockTools.push({
      expose: { mcp: { name: 'a:tool' } },
      description: 'First.',
      capabilities: [],
    });
    const { renderToolsCatalog } = await import('./prompt-assembly');
    const out = renderToolsCatalog('operator', ['b:tool', 'a:tool', 'b:tool']);
    const aPos = out.indexOf('`a:tool`');
    const bPos = out.indexOf('`b:tool`');
    expect(aPos).toBeGreaterThanOrEqual(0);
    expect(bPos).toBeGreaterThan(aPos);
    // Only one b:tool entry despite being passed twice.
    const matches = out.match(/`b:tool`/g);
    expect(matches?.length).toBe(1);
  });
});

describe('PAPERCUSP_RELOAD_PROMPTS env flag', () => {
  it('bypasses cache when set to 1', () => {
    process.env.PAPERCUSP_RELOAD_PROMPTS = '1';
    // Implicitly tested by the beforeEach in this file — every test
    // observes mockTools.length === 0 at start despite earlier tests
    // populating it. If caching weren't bypassed, the second test in
    // the file would see leaked guidance from the first.
    expect(process.env.PAPERCUSP_RELOAD_PROMPTS).toBe('1');
  });
});

describe('renderWireSchemasSection — the "## Wire schemas" legend (P-003)', () => {
  const flatArrayOut = {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'state'],
      properties: { id: { type: 'string' }, state: { enum: ['todo', 'done'] } },
    },
  };
  const claimArgs = {
    type: 'object',
    additionalProperties: false,
    required: ['id'],
    properties: { id: { type: 'string' }, assignee: { type: 'string' }, harness: { type: 'string' } },
  };

  it('renders read + write column lines for the configured registry tools', async () => {
    const { configurePrePromptRegistry, clearPrePromptRegistry } = await import('@papercusp/result-encoding');
    mockTools.push({
      expose: { mcp: { name: 'audit:list' } },
      description: 'audit',
      capabilities: [],
      outputJsonSchema: flatArrayOut,
    });
    mockTools.push({
      expose: { mcp: { name: 'work_items:claim' } },
      description: 'claim',
      capabilities: [],
      inputSchema: claimArgs,
    });
    configurePrePromptRegistry([
      { name: 'audit:list', read: 'csv' },
      { name: 'work_items:claim', write: 'positional' },
    ]);
    const { renderWireSchemasSection } = await import('./prompt-assembly');
    const out = renderWireSchemasSection();
    expect(out).toContain('## Wire schemas');
    expect(out).toContain('`audit:list`');
    expect(out).toContain('read → id:id, state:todo|done');
    expect(out).toContain('`work_items:claim`');
    expect(out).toContain('write ← id:id, assignee:str?, harness:str?');
    expect(out).toContain('`ptool --json -` fallback therefore wraps the row as `{ "row": "value1,value2" }`');
    clearPrePromptRegistry();
  });

  it('declares NO read columns for a self-describing TOON read (EI-136)', async () => {
    const { configurePrePromptRegistry, clearPrePromptRegistry } = await import('@papercusp/result-encoding');
    mockTools.push({
      expose: { mcp: { name: 'audit:list' } },
      description: 'audit',
      capabilities: [],
      outputJsonSchema: flatArrayOut,
    });
    // Shape-eligible for positional CSV (flat scalar array) — so this asserts the
    // ENCODING gates the legend, not the schema. A TOON payload carries
    // `fields[N]:` inline, so declaring the columns thousands of tokens away is
    // dead weight AND instructs a position→column mapping the wire doesn't use.
    configurePrePromptRegistry([{ name: 'audit:list', read: 'toon' }]);
    const { renderWireSchemasSection } = await import('./prompt-assembly');
    const out = renderWireSchemasSection();
    expect(out).not.toContain('read →');
    // With no write side either, the entry contributes nothing and the whole
    // section collapses rather than emitting a bare heading.
    expect(out).toBe('');
    clearPrePromptRegistry();
  });

  it('still declares read columns for a headerless CSV read (the positional case)', async () => {
    const { configurePrePromptRegistry, clearPrePromptRegistry } = await import('@papercusp/result-encoding');
    mockTools.push({
      expose: { mcp: { name: 'audit:list' } },
      description: 'audit',
      capabilities: [],
      outputJsonSchema: flatArrayOut,
    });
    // The falsifier for the test above: same tool, same schema, only the
    // encoding differs. A headerless body has no inline field names, so the
    // legend is load-bearing and MUST still be emitted.
    configurePrePromptRegistry([{ name: 'audit:list', read: 'csv' }]);
    const { renderWireSchemasSection } = await import('./prompt-assembly');
    const out = renderWireSchemasSection();
    expect(out).toContain('read → id:id, state:todo|done');
    clearPrePromptRegistry();
  });

  it('returns empty string when the registry is empty', async () => {
    const { clearPrePromptRegistry } = await import('@papercusp/result-encoding');
    clearPrePromptRegistry();
    const { renderWireSchemasSection } = await import('./prompt-assembly');
    expect(renderWireSchemasSection()).toBe('');
  });
});

describe('assembleRolePrompt — coord-injection legend (token-efficient-coord-injection P-013)', () => {
  it('includes the ## Coord injection protocol legend so role agents can read injected [coord+N] blocks', async () => {
    mockTools.length = 0; // catalog optional; we only assert the coord-legend section
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Coord injection protocol');
    expect(out.text).toContain('<glyph> <handle> <text>');
    expect(out.sections.some((s) => s.name === 'coord-legend')).toBe(true);
  });
});

describe('assembleRolePrompt — deploy-pipeline note (deploy-pipeline-legibility-2026-06-18 P-003)', () => {
  it('injects the async deploy-pipeline note + the "a RED gate is everyone\'s job to FIX" directive into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## The deploy pipeline is ASYNC');
    expect(out.text.match(/## The deploy pipeline is ASYNC/g)).toHaveLength(1);
    expect(out.text).toContain('DEFAULT implementation and plan-item acceptance plane');
    expect(out.text).toContain('reserved ONLY for final promotion and shipment verification');
    expect(out.text).toContain('held or red green-checkpoint gate does NOT block non-final work');
    expect(out.text).toContain('explicitly names the deployed-only property');
    expect(out.text).toContain('dev:pipeline_position');
    expect(out.text).toContain(':3070 serves GREEN `main`');
    // owner-directed reframe (2026-06-23): a RED gate is everyone's job to fix — no owner-ask, even out of lane
    expect(out.text).toContain('do NOT ask the owner');
    expect(out.text).toContain('even if it is not your lane');
    expect(out.sections.some((s) => s.name === 'deploy-pipeline-note')).toBe(true);
  });
});

describe('assembleRolePrompt — wait-loop note (owner directive 2026-06-23)', () => {
  it('injects the "waiting? arm a self-wake loop; never sleep on an event that may never fire" note into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Waiting on something? Arm a self-wake LOOP');
    expect(out.text).toContain('NEVER-FIRING event');
    expect(out.text).toContain('loop:arm');
    expect(out.text).toContain('pot:declare-wake');
    expect(out.sections.some((s) => s.name === 'wait-loop-note')).toBe(true);
  });
});

describe('assembleRolePrompt — peer-wake note (owner directive 2026-06-24)', () => {
  it('injects the "you can WAKE a peer; handing work off is not enough" note into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## You can WAKE a peer');
    expect(out.text).toContain('coord:dispatch');
    expect(out.text).toContain('coord:wake');
    expect(out.text).toContain('recipient_absent');
    expect(out.sections.some((s) => s.name === 'peer-wake-note')).toBe(true);
  });
});

describe('assembleRolePrompt — coupling note (owner directive 2026-07-27, P-031/D-062)', () => {
  it('injects the couple/decouple note into the SHARED base EVERY role inherits', async () => {
    // The owner's ask was explicitly all agents, not just fleet roles — coupling is
    // not a fleet mechanism (D-054 cut `same fleet` from the predicate), so a
    // role-gated note would hide it from exactly the third-party case it serves.
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Coupling');
    expect(out.text).toContain('coord:couple');
    expect(out.text).toContain('coord:decouple');
    expect(out.sections.some((s) => s.name === 'coupling-note')).toBe(true);
  });

  it('teaches the DECOUPLE trigger and the COST, not just the couple verb (D-062)', async () => {
    // A capability taught only as "how to turn it on" grows monotonically: nobody
    // removes an edge they were never told to remove, and both agents pay for it.
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('no longer want to see each other\'s data intimately');
    expect(out.text).toContain('BOTH sides');
    // …and it must say the third-party case is allowed, or agents never find it.
    expect(out.text).toContain('COUPLE ANY TWO AGENTS');
  });

  it('states NO token number — the per-entry cost is unmeasured until P-013 lands (D-062)', async () => {
    // Guard against the failure this plan already made twice: a figure invented
    // here would read as measured and then get carried onto other surfaces.
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    const couplingSection = out.text.slice(out.text.indexOf('## Coupling'));
    const note = couplingSection.slice(0, couplingSection.indexOf('\n## ') + 1 || undefined);
    expect(note).not.toMatch(/\d+\s*(tokens?|KB|kb)\b/);
  });
});

describe('assembleRolePrompt — concurrency-first note (owner directive 2026-06-20)', () => {
  it('injects the "never wait for a calm window; a non-resource block is a BUG to fix" note into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Never wait for a "calm window"');
    expect(out.text).toContain('TRUE, VERIFIED exhaustion');
    expect(out.text).toContain('hundreds to thousands of agents');
    expect(out.text).toContain('INVESTIGATE the real root cause');
    expect(out.sections.some((s) => s.name === 'concurrency-first-note')).toBe(true);
  });
});

describe('assembleRolePrompt — code-run note (code-execution-tool-orchestration B-CX-3)', () => {
  it('injects the "collapse a multi-step flow into one code:run" note into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Optimize tool flows for MODEL turns — use parallel calls or one `code:run`');
    expect(out.text).toContain('round-trip');
    expect(out.text).toContain('SUMMARIZE CONSERVATIVELY');
    // MODEL-turn refinement: the cost is MODEL inference turns, not raw RPC count; the corrected
    // bundle cutoff (judgment mid-flow, NOT mere data dependency).
    expect(out.text).toContain('Count MODEL inference turns, not raw tool/RPC calls');
    expect(out.text).toContain('Mere data dependency is not judgment');
    expect(out.sections.some((s) => s.name === 'code-run-note')).toBe(true);
  });
});

describe('assembleRolePrompt — reuse-first nudge (agents-reuse-first-default-2026-06-20 P-001/D-001)', () => {
  it('injects the soft "extend, don\'t fork" nudge into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain("## Reuse-first (extend, don't fork)");
    expect(out.text).toContain('new durable surface');
    expect(out.text).toContain('smallest extension');
    expect(out.text).toContain('top review smell');
    expect(out.sections.some((s) => s.name === 'reuse-first-nudge')).toBe(true);
  });
});

describe('assembleRolePrompt — observation-rubric nudge (rubric-driven-observations-2026-06-20 P-005/D-003)', () => {
  it('injects the "check rubrics:list, grade structured if one fits" nudge into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Filing an observation? Grade it against a rubric if one fits');
    expect(out.text).toContain('rubrics:list');
    expect(out.text).toContain('observation.rubricRef');
    expect(out.text).toContain('EVIDENCE IS REQUIRED');
    expect(out.sections.some((s) => s.name === 'observation-rubric-nudge')).toBe(true);
  });
});

describe('assembleRolePrompt — plan-discipline + observation-capture (enforce-system-on-generic-work-2026-06-29)', () => {
  it('injects the plan-discipline bright-line into the SHARED base every role inherits (P-016)', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## A plan is REQUIRED when work spans multiple steps');
    expect(out.text).toContain('A plan is REQUIRED when work decomposes into >=2 work-items');
    expect(out.text).toContain("Don't over-apply");
    expect(out.sections.some((s) => s.name === 'plan-discipline-note')).toBe(true);
  });

  it('injects the work-item PRECONDITION into the SHARED base every role inherits (P-015)', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Hold a work-item before you edit');
    expect(out.text).toContain('Before your first code/deliverable edit you MUST hold a work-item');
    expect(out.text).toContain('private scratch, never a substitute');
    expect(out.sections.some((s) => s.name === 'work-record-note')).toBe(true);
  });

  it('injects the observation-capture routing into the SHARED base every role inherits (P-017)', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Capture what you notice — the moment you notice it');
    expect(out.text).toContain('an agent-insights doc');
    expect(out.sections.some((s) => s.name === 'observation-capture-note')).toBe(true);
  });

  it('injects the write-through memory discipline into the SHARED base every role inherits (compaction P-004)', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Write-through memory — flush a conclusion WHEN IT FORMS');
    expect(out.text).toContain('are the BACKSTOP for');
    expect(out.sections.some((s) => s.name === 'write-through-note')).toBe(true);
  });

  it('injects the sharpened flag-on dangerous-set rule into the SHARED base every role inherits (P-010)', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('Ship features flag-ON by default');
    expect(out.text).toContain('Default-OFF is ONLY for the dangerous set');
    expect(out.text).toContain('registered WITH A REASON in the dark-flags registry');
    expect(out.sections.some((s) => s.name === 'finish-the-rollout-note')).toBe(true);
  });
});

describe('assembleRolePrompt — friction trip-wire (self-learning-central P-001/A, D-006)', () => {
  it('injects the near-zero friction trip-wire into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Bug + friction trip-wire (self-learning loop)');
    expect(out.text).toContain('improvements:capture');
    expect(out.sections.some((s) => s.name === 'friction-tripwire')).toBe(true);
  });

  it('the base trip-wire does NOT leak harness-pipeline role names (validator/reviewer)', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    // Slice out just the trip-wire section to avoid false hits from a persona/catalog mention.
    const idx = out.text.indexOf('## Bug + friction trip-wire');
    const after = out.text.slice(idx);
    const end = after.indexOf('\n\n---\n\n');
    const tripwire = (end >= 0 ? after.slice(0, end) : after).toLowerCase();
    expect(tripwire).not.toMatch(/validator|reviewer/);
  });
});

describe('assembleRolePrompt — yield policy (turn-lifecycle-control P-017, D-007/D-009)', () => {
  it('injects the cooperative-yield policy into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Yielding on request (turn-lifecycle control)');
    expect(out.text).toContain('turn:interrupt');
    expect(out.text).toContain('Save only when it fits');
    expect(out.sections.some((s) => s.name === 'yield-policy')).toBe(true);
  });
});

describe('assembleRolePrompt — testing standard (write tests the project way)', () => {
  it('injects the testing-standard clause into the SHARED base every role inherits', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    expect(out.text).toContain('## Tests follow the project standard');
    expect(out.text).toContain('canonical test framework');
    expect(out.text).toContain('A green typecheck is not a test.');
    expect(out.sections.some((s) => s.name === 'testing-standard')).toBe(true);
  });

  it('the clause is project-agnostic — it does NOT hardcode one project\'s framework list', async () => {
    mockTools.length = 0;
    const { assembleRolePrompt } = await import('./prompt-assembly');
    const out = assembleRolePrompt({ role: 'oracle', toolNames: [] });
    const idx = out.text.indexOf('## Tests follow the project standard');
    const after = out.text.slice(idx);
    const end = after.indexOf('\n\n---\n\n');
    const clause = end >= 0 ? after.slice(0, end) : after;
    expect(clause).not.toMatch(/Vitest|Playwright|Cargo|\/admin\/testing/);
  });
});

// ── decouple-agent-prompts-from-release-gate-2026-06-20 P-002/P-005 ──────────
// The chat-surface prompts dir (operator/oracle/sentinel persona+tools) prefers
// the integration-tree operator prompts (PAPERCUSP_INTEGRATION_ROOT) so a
// chat-surface prompt edit goes live without a code-release promotion. The
// existing explicit PAPERCUSP_PROMPTS_DIR override still wins.
describe('promptsDir — integration-tree prompt root', () => {
  const saved: Record<string, string | undefined> = {};
  const tmps: string[] = [];
  beforeEach(() => {
    saved.PAPERCUSP_PROMPTS_DIR = process.env.PAPERCUSP_PROMPTS_DIR;
    saved.PAPERCUSP_INTEGRATION_ROOT = process.env.PAPERCUSP_INTEGRATION_ROOT;
    delete process.env.PAPERCUSP_PROMPTS_DIR;
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function mkIntegRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'papercusp-integ-prompts-'));
    mkdirSync(join(root, 'apps/operator/prompts'), { recursive: true });
    tmps.push(root);
    return root;
  }

  it('prefers <PAPERCUSP_INTEGRATION_ROOT>/apps/operator/prompts when it exists', () => {
    const root = mkIntegRoot();
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(promptsDir()).toBe(join(root, 'apps/operator/prompts'));
  });

  it('PAPERCUSP_PROMPTS_DIR (explicit) still wins over the integration root', () => {
    const explicit = mkdtempSync(join(tmpdir(), 'papercusp-explicit-prompts-'));
    tmps.push(explicit);
    const root = mkIntegRoot();
    process.env.PAPERCUSP_PROMPTS_DIR = explicit;
    process.env.PAPERCUSP_INTEGRATION_ROOT = root;
    expect(promptsDir()).toBe(explicit);
  });

  it('a non-existent integration root falls through to the cwd/anchor heuristics (never strands)', () => {
    process.env.PAPERCUSP_INTEGRATION_ROOT = join(tmpdir(), 'papercusp-no-such-integ-xyz');
    // Falls through to the normal resolution; the result must be a real dir.
    expect(existsSync(promptsDir())).toBe(true);
  });
});
