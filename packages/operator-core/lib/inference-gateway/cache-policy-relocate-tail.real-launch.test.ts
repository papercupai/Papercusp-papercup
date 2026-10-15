/**
 * token-efficiency-prompts-cache-and-behavior-2026-10-11 P-015 — the gateway's relocation of the
 * per-session system tail, run over a REAL su launch request. Clauses: SPEC-P-015-ON,
 * SPEC-P-015-OFF, SPEC-P-015-WRAPPED, AUTO-BAR-R-3-P-015 and AUTO-BAR-R-4-P-015.
 *
 * NO FIXTURE DATA. Every piece of prompt content the relocation reads is produced by production
 * code or is a real file from this checkout:
 *   - the system prompt is the production su playbook (`renderSuPlaybook`, the renderer
 *     `buildLaunchSpec({ kind: 'su' })` uses) passed through `applySuPromptOverlays`, which inserts
 *     the P-006 boundary and appends the real per-session tail: provenance, mode section
 *     (`composeModePromptSection`) and instruction precedence (`buildSuInstructionRuntime`);
 *   - messages[0] block 0 is this repository's CLAUDE.md, the always-loaded guide Claude Code
 *     delivers in that block;
 *   - the flag default is `FLAG_DEFAULTS` from @papercusp/flags, the registry the gateway reads.
 * The Claude Code request envelope (billing and identity system blocks, a two-tool list, the first
 * prompt) is shaped here. The relocation reads none of its content; it only needs the envelope's
 * structure, which matches what Claude Code sends. Owner and launcher ids are parameters.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FLAG_DEFAULTS, FLAGS } from '@papercusp/flags';
import { describe, expect, it } from 'vitest';
import { renderSuPlaybook } from '../desktop-install/papercusp-files';
import { composeModePromptSection } from '../endpoint-route/routes/agent-mcp/bootstrap-su-shared';
import { applySuPromptOverlays, buildSuInstructionRuntime } from '../su-persona-render';
import {
  PSU_CACHE_BOUNDARY,
  RELOCATED_TAIL_CLOSE,
  RELOCATED_TAIL_OPEN,
  resolveRelocateSystemTail,
  rewriteAnthropicCacheBody,
} from './cache-policy';

type Body = Record<string, any>;

const CLAUDE_MD_PATH = fileURLToPath(new URL('../../../../CLAUDE.md', import.meta.url));
const claudeMd = readFileSync(CLAUDE_MD_PATH, 'utf8');
const playbook = renderSuPlaybook({ agent: 'claude', profile: 'engineer', tier: 'full' }).then((r) => r.text);

const PER_SESSION_HEADINGS = [
  '## Provenance — who launched this session',
  '## Effective instruction precedence',
] as const;

type Mode = 'auto' | 'drain';
const runtimes = new Map<string, ReturnType<typeof buildSuInstructionRuntime>>();
const runtimeFor = (ownerId: string, mode: Mode) => {
  const key = `${ownerId}:${mode}`;
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = buildSuInstructionRuntime({
      ownerId,
      autoMode: true,
      drainMode: mode === 'drain',
      fleet: null,
      workspaceId: 'papercusp-workspace',
      harnessSlug: 'papercusp',
      planSlug: 'token-efficiency-prompts-cache-and-behavior-2026-10-11',
    });
    runtimes.set(key, runtime);
  }
  return runtime;
};

/** The real su system prompt for one owner: production playbook + boundary + per-session tail. */
async function suSystemPrompt(ownerId: string, mode: Mode, launchedBy: string | null) {
  const modeSection = composeModePromptSection({ autoMode: true, drainMode: mode === 'drain', loopArmed: false });
  const { promptText } = await applySuPromptOverlays({
    basePromptText: await playbook,
    agent: 'claude',
    launchedBy,
    modeSection,
    instructionRuntime: runtimeFor(ownerId, mode),
  });
  return { promptText, modeSection };
}

/** messages[0] block 0 as Claude Code ships it: the project guide inside a system reminder. */
const claudeMdBlock = () =>
  `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# claudeMd\n` +
  `Contents of ${CLAUDE_MD_PATH} (project instructions, checked into the codebase):\n\n${claudeMd}\n</system-reminder>\n`;

/** A Claude Code startup request carrying the real su system prompt and the real CLAUDE.md block. */
function launchRequest(systemPrompt: string, firstPrompt: string): Body {
  return {
    model: 'claude-opus-5-5',
    tools: [
      { name: 'Edit', input_schema: { type: 'object' } },
      { name: 'Write', input_schema: { type: 'object' } },
    ],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cc_entrypoint=cli' },
      { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: 'ephemeral' } },
      { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: claudeMdBlock() },
          { type: 'text', text: firstPrompt, cache_control: { type: 'ephemeral' } },
        ],
      },
    ],
  };
}

const rewrite = (body: Body, relocateSystemTail?: boolean) => {
  const r = rewriteAnthropicCacheBody(Buffer.from(JSON.stringify(body)), {
    splitBoundary: true,
    ...(relocateSystemTail === undefined ? {} : { relocateSystemTail }),
  });
  return { raw: r.body, out: JSON.parse(r.body.toString('utf8')) as Body, stats: r.stats };
};

/** What the gateway does for one request: resolve the flag (env override first), then rewrite. */
async function gatewayRewrite(body: Body, env: NodeJS.ProcessEnv) {
  const relocate = await resolveRelocateSystemTail(
    async () => FLAG_DEFAULTS[FLAGS.GATEWAY_RELOCATE_SYSTEM_TAIL],
    env,
  );
  return rewrite(body, relocate);
}

const systemText = (b: Body) => (b.system as Body[]).map((s) => s.text as string).join('');
/** Content of everything up to and including messages[0] block 0; cache_control is not content. */
const prefixThroughBlock0 = (b: Body) =>
  JSON.stringify({ tools: b.tools, system: b.system, m0b0: b.messages[0].content[0] }, (k, v) =>
    k === 'cache_control' ? undefined : v,
  );
const unwrap = (text: string) => text.slice(RELOCATED_TAIL_OPEN.length, text.length - RELOCATED_TAIL_CLOSE.length);

describe('real su launch request — calibration', () => {
  it('the inputs are the real ones: a large production prompt with one boundary and a real per-session tail, and the real CLAUDE.md', async () => {
    const { promptText, modeSection } = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    expect(Buffer.byteLength(promptText, 'utf8')).toBeGreaterThan(100_000);
    expect(promptText.split(PSU_CACHE_BOUNDARY)).toHaveLength(2);
    const tail = promptText.slice(promptText.indexOf(PSU_CACHE_BOUNDARY));
    for (const heading of PER_SESSION_HEADINGS) expect(tail, heading).toContain(heading);
    expect(tail).toContain(modeSection.replace(/\n+$/, ''));
    expect(Buffer.byteLength(claudeMd, 'utf8')).toBeGreaterThan(30_000);
    expect(claudeMd).toContain('# Papercup — agent guide');
  });
});

describe('gateway relocation over a real su launch request (P-015)', () => {
  it('AUTO-BAR-R-3-P-015: the registered flag defaults ON, and with no override the gateway relocates the tail after messages[0] block 0', async () => {
    expect(FLAG_DEFAULTS[FLAGS.GATEWAY_RELOCATE_SYSTEM_TAIL]).toBe(true);
    const { promptText } = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    const original = launchRequest(promptText, 'first prompt');
    const { out, stats } = await gatewayRewrite(original, {});
    expect(stats?.tailRelocated).toBe(true);
    expect(out.messages[0].content).toHaveLength(3);
    expect(out.messages[0].content[0].text).toBe(original.messages[0].content[0].text);
    expect(out.messages[0].content[1].text.startsWith(RELOCATED_TAIL_OPEN)).toBe(true);
    expect(out.messages[0].content[2].text).toBe('first prompt');
  });

  it('SPEC-P-015-ON: with the flag on, no per-session section stays in the system prompt; the system prompt ends at the stable playbook', async () => {
    const { promptText } = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    const { out } = rewrite(launchRequest(promptText, 'first prompt'), true);
    const sys = systemText(out);
    for (const heading of PER_SESSION_HEADINGS) expect(sys, heading).not.toContain(heading);
    expect(sys).not.toContain('You were launched by **su-launcher-a**');
    expect(sys).not.toContain(PSU_CACHE_BOUNDARY);
    expect(out.system.at(-1).text).toBe(promptText.slice(0, promptText.indexOf(PSU_CACHE_BOUNDARY)));
  });

  it('AUTO-BAR-R-3-P-015: the environment override wins over the flag in both directions', async () => {
    const { promptText } = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    const original = launchRequest(promptText, 'first prompt');
    const forcedOff = await gatewayRewrite(original, { PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL: '0' });
    expect(forcedOff.stats?.tailRelocated).toBeUndefined();
    expect(forcedOff.out.messages[0].content).toHaveLength(2);
    const forcedOn = await resolveRelocateSystemTail(async () => false, { PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL: '1' });
    expect(forcedOn).toBe(true);
    expect((await gatewayRewrite(original, { PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL: '1' })).raw.equals(rewrite(original, true).raw)).toBe(true);
  });

  it('SPEC-P-015-OFF / AUTO-BAR-R-3-P-015: with relocation off, the tail stays in the system block and the body is byte-identical to the previous (split-only) layout', async () => {
    const { promptText } = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    const original = launchRequest(promptText, 'first prompt');
    const prevEnv = process.env.PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL;
    delete process.env.PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL;
    try {
      const previousLayout = rewrite(original); // the pre-P-015 call: no relocation option at all
      const off = rewrite(original, false);
      expect(off.raw.equals(previousLayout.raw)).toBe(true);
      const tailBlock = off.out.system.at(-1).text as string;
      for (const heading of PER_SESSION_HEADINGS) expect(tailBlock, heading).toContain(heading);
      expect(tailBlock).toContain('You were launched by **su-launcher-a**');
      // The cache policy may still upgrade marker ttls (cache_control); no block of content moves.
      expect(off.out.messages[0].content.map((b: Body) => b.text)).toEqual(
        original.messages[0].content.map((b: Body) => b.text),
      );
      expect(systemText(off.out)).toBe(systemText(original).replace(PSU_CACHE_BOUNDARY, ''));
    } finally {
      if (prevEnv !== undefined) process.env.PAPERCUSP_GATEWAY_RELOCATE_SYSTEM_TAIL = prevEnv;
    }
  });

  it('SPEC-P-015-WRAPPED / AUTO-BAR-R-4-P-015: the relocated tail arrives wrapped as a system-authority reminder', async () => {
    const { promptText } = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    const { out } = rewrite(launchRequest(promptText, 'first prompt'), true);
    const relocated = out.messages[0].content[1].text as string;
    expect(relocated.startsWith('<system-reminder>\n')).toBe(true);
    expect(relocated.endsWith('\n</system-reminder>')).toBe(true);
    expect(relocated).toContain('It carries the SAME authority as the system prompt.');
    expect(relocated.startsWith(RELOCATED_TAIL_OPEN)).toBe(true);
    expect(relocated.endsWith(RELOCATED_TAIL_CLOSE)).toBe(true);
  });

  it('AUTO-BAR-R-4-P-015: every per-session section is present byte-for-byte; stable half + boundary + relocated tail rebuild the original prompt', async () => {
    const { promptText, modeSection } = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    const { out } = rewrite(launchRequest(promptText, 'first prompt'), true);
    const inner = unwrap(out.messages[0].content[1].text as string);
    expect(inner).toBe(promptText.slice(promptText.indexOf(PSU_CACHE_BOUNDARY) + PSU_CACHE_BOUNDARY.length));
    expect(out.system.at(-1).text + PSU_CACHE_BOUNDARY + inner).toBe(promptText);
    for (const heading of PER_SESSION_HEADINGS) expect(inner, heading).toContain(heading);
    expect(inner).toContain(modeSection.replace(/\n+$/, ''));
    expect(inner).toContain('You were launched by **su-launcher-a**');
  });

  it('AUTO-BAR-R-3-P-015: two owners in different modes share every byte through the CLAUDE.md block only when relocated', async () => {
    const a = await suSystemPrompt('su-owner-a', 'auto', 'su-launcher-a');
    const b = await suSystemPrompt('su-owner-b', 'drain', null);
    expect(a.promptText).not.toBe(b.promptText);
    const reqA = launchRequest(a.promptText, 'first prompt for a');
    const reqB = launchRequest(b.promptText, 'first prompt for b');
    expect(prefixThroughBlock0(rewrite(reqA, false).out)).not.toBe(prefixThroughBlock0(rewrite(reqB, false).out));
    const relA = rewrite(reqA, true).out;
    const relB = rewrite(reqB, true).out;
    expect(prefixThroughBlock0(relA)).toBe(prefixThroughBlock0(relB));
    expect(relA.messages[0].content[1].text).toContain('## AUTO mode');
    expect(relB.messages[0].content[1].text).toContain('## DRAIN mode');
  });
});
