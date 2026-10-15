/**
 * codex-overlay-launch-context.test.ts — proves the CANONICAL Codex overlay edit
 * actually reaches a live launch context (P-010,
 * fleet-friction-remediation-2026-08-21).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM su-render-baseline.test.ts: that suite is
 * deliberately pinned to FROZEN FIXTURES under `__fixtures__/su-render-baseline/`
 * and renders only the `claude` overlay — by design, so its byte/hash table stays
 * comparable across persona edits. The consequence is that it cannot notice a
 * change to the LIVE `apps/operator/prompts/papercusp-su.codex.md`, and nothing
 * else did either. The su persona runbook's central warning is that the prompt is
 * LAYERED AND PROJECTED, so an edit can land on a real file and still never reach
 * a launched session — the "I changed the prompt and nothing happened" trap. This
 * renders the REAL prompt tree and asserts the guidance is in the shipped text.
 *
 * THE CLAUDE CONTROL IS THE LOAD-BEARING HALF. Asserting only that the rendered
 * codex text contains the guidance would also pass if the string had been written
 * into the shared BASE playbook (which every client receives) rather than the
 * codex overlay — i.e. it would pass while the delivery mechanism under test was
 * broken. Rendering `claude` from the same live tree and asserting the guidance is
 * ABSENT pins it to the overlay specifically.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderSuPlaybook } from './papercusp-files';

// __dirname = <repo>/packages/operator-core/lib/desktop-install — four levels down.
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const OPERATOR_APP_ROOT = join(REPO_ROOT, 'apps', 'operator');
// SU_BLUEPRINT_PERSONA's live interactive path resolves this blueprint base
// and then splices the client overlay from the operator prompts directory.
// renderSuPlaybook's default base is the legacy engineer playbook, so pin the
// production source explicitly to keep this from becoming a false-positive.
const LIVE_BASE_SOURCE = join(
  REPO_ROOT,
  'libs',
  'papercusp',
  'packages',
  'harness',
  'blueprints',
  'base',
  'prompts',
  'su.md',
);
const LIVE_OVERLAY_DIR = join(OPERATOR_APP_ROOT, 'prompts');

const render = (agent: string) =>
  renderSuPlaybook({
    agent,
    operatorAppRoot: OPERATOR_APP_ROOT,
    baseSource: LIVE_BASE_SOURCE,
    overlayDir: LIVE_OVERLAY_DIR,
  });

/** Load-bearing phrases from the two P-010 sections of the codex overlay. Each is a
 *  claim an agent acts on, not decoration — so each is asserted individually and a
 *  failure names exactly which guarantee stopped shipping. */
const CODEX_GUIDANCE = [
  // apply_patch atomic-update constraint
  'at most one operation per target path',
  'multiple operations target',
  'one block per FILE, one `@@` hunk per REGION',
  // shell/heredoc quoting
  "quote the opening delimiter",
  'closing delimiter must be at column 0',
  // nested exec session-handle preservation
  'preserve the **whole returned envelope**',
  'every returned `session_id`',
  'Never map a nested response to `output` alone',
  // MCP server verbs have qualified method names inside functions.exec.
  'tools.mcp__papercusp_su__tools_find({ query:',
  'exact method is callable, for example',
  'A missing normalized method is a client exposure',
  'use the CLI fallback below.',
  'ptool tools:find --json -',
  '`tools.find` and',
  // WI-10005083: seeded tools are called directly, never re-found per restart
  // (a Codex drain fleet re-ran tools:find ~12x per restart for seeded tools).
  'Your seeded tools are already callable. Do not re-find them after a restart.',
  'Check `ALL_TOOLS` first, then call the method',
  'tools.mcp__papercusp_su__work_items_get({ id, harness })',
  'Use `tools:find` only for a capability that is\nnot in `ALL_TOOLS`',
  'on the `ptool` path it cannot',
  // EI-25176447697693688: stale direct wrappers require a current tools/list baseline.
  '`stale_tool_contract`',
  '`tools/list` baseline for the current serving generation.',
  'each named `ptool` invocation opens its own MCP\nconnection and lists the current catalog',
  'The CLI uses its\nown connection, so it does not repair the old direct-wrapper session.',
  'that client reconnects and refreshes its list.',
  // Native-owner authority refusal: use the authenticated ptool route without weakening the boundary.
  '`native_tool_owner_unsupported_capability`',
  'host-local `authenticatedPrincipal`',
  'Do NOT retry the same direct wrapper',
  'Switch this and the remaining Papercusp\ncalls in the session to the installed',
  'A successful ptool call verifies the CLI route only',
  'not a reason to loosen\n`authenticatedPrincipal` forwarding.',
] as const;

describe('codex overlay reaches live launch context (P-010)', () => {
  it('resolves the REAL codex overlay file, not a fixture', async () => {
    const rendered = await render('codex');
    // If this is '', readAgentOverlay silently found no file and every content
    // assertion below would be vacuous.
    expect(rendered.baseSource).toBe(LIVE_BASE_SOURCE);
    expect(rendered.overlaySource).not.toBe('');
    expect(rendered.overlaySource).toBe(join(LIVE_OVERLAY_DIR, 'papercusp-su.codex.md'));
    expect(rendered.text.length).toBeGreaterThan(0);
  });

  it('renders the coord:send summary contract in the live Codex launch context', async () => {
    const { text, baseSource, overlaySource } = await render('codex');
    expect(baseSource).toBe(LIVE_BASE_SOURCE);
    expect(overlaySource).toBe(join(LIVE_OVERLAY_DIR, 'papercusp-su.codex.md'));
    expect(text).toContain('`summary` is REQUIRED at the top level for every single-message send.');
    expect(text).toContain('It is the one-line inbox headline the recipient sees, even when `body` carries the full message.');
  });

  it.each(CODEX_GUIDANCE)('a launched Codex session receives: %s', async (phrase) => {
    const { text } = await render('codex');
    expect(text).toContain(phrase);
  });

  it('drains a nested exec session through every yielded poll', async () => {
    const { text } = await render('codex');
    expect(text).toContain('while ("session_id" in result && !("exit_code" in result))');
    expect(text).toContain('result = await tools.write_stdin');
    expect(text).toContain('continue until an');
    expect(text).toContain('`exit_code` is present');
  });

  it('CONTROL: the same phrases are absent from the claude render (overlay-scoped, not base)', async () => {
    const { text, overlaySource } = await render('claude');
    // A `not.toContain` sweep passes trivially against an empty or failed render,
    // which would make this control inert exactly when it matters. Prove the claude
    // render is real and substantial FIRST, so the absence below is a finding.
    expect(overlaySource).toContain('papercusp-su.claude.md');
    expect(text.length).toBeGreaterThan(10_000);
    for (const phrase of CODEX_GUIDANCE) {
      expect(text).not.toContain(phrase);
    }
  });

  it('keeps the pre-existing functions.exec JavaScript-boundary guidance', async () => {
    // P-010 extends the codex overlay; it must not displace what was already
    // delivered there (the trap family this overlay originally existed for).
    const { text } = await render('codex');
    expect(text).toContain('the outer\nprogram is JavaScript');
    expect(text).toContain('yield_time_ms');
  });
});
