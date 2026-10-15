import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  analyzeClaudeResumeTranscript,
  analyzeClaudeResumeTranscriptFile,
  appendClaudeToolReferencesToSeed,
  CLAUDE_TOOL_REFERENCE_POISON_TURNS,
  CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS,
  neutralizeClaudeToolReferences,
  neutralizeForkSeedToolReferences,
  neutralizeResumeNativeToolReferences,
  neutralizeResumeNativeToolReferencesInFile,
  __resetClaudeResumeTranscriptCacheForTests,
} from './claude-resume-tool-references.mjs';

const missing = (tool: string, colon = true) =>
  `API Error${colon ? ':' : ''} 400 Tool reference '${tool}' not found in available tools`;
const assistant = (text: string) => JSON.stringify({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
/** The real record shape of a provider rejection (WI-10003466): synthetic, not model prose. */
const apiError = (text: string, status = 400) => JSON.stringify({
  type: 'assistant',
  error: 'unknown',
  isApiErrorMessage: true,
  apiErrorStatus: status,
  message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] },
});

afterEach(() => {
  __resetClaudeResumeTranscriptCacheForTests();
});

describe('Claude resume tool-reference recovery', () => {
  it.each(['Credit balance is too low', '402 Insufficient credits. This account never purchased credits.'])
    ('detects a synthetic billing rejection after the current kickoff: %s', (text) => {
      expect(analyzeClaudeResumeTranscript(apiError(text))).toMatchObject({
        trailingAccountWallTurns: 1, lastAccountWallEvidence: text,
        assistantTurnsSinceLastPrompt: 1,
      });
    });

  it('detects the provider 429 account-rate rejection used by reviewer dispatch', () => {
    const text = "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
    expect(analyzeClaudeResumeTranscript(apiError(text, 429))).toMatchObject({
      trailingAccountWallTurns: 1,
      lastAccountWallEvidence: text,
      assistantTurnsSinceLastPrompt: 1,
    });
  });

  it('does not treat ordinary discussion of a 429 account-rate error as a provider rejection', () => {
    const text = "The reviewer transcript said API Error: Request rejected (429) · This request would exceed your account's rate limit.";
    expect(analyzeClaudeResumeTranscript(assistant(text))).toMatchObject({
      trailingAccountWallTurns: 0,
      lastAccountWallEvidence: null,
      assistantTurnsSinceLastPrompt: 1,
    });
  });

  it('detects a structured rate-limit rejection without depending on provider wording', () => {
    const text = 'API Error: Request rejected (429) · inference-gateway: all accounts throttled; retry after 60s';
    const rejected = JSON.stringify({ ...JSON.parse(apiError(text, 429)), error: 'rate_limit' });
    expect(analyzeClaudeResumeTranscript(rejected)).toMatchObject({
      trailingAccountWallTurns: 1,
      lastAccountWallEvidence: text,
      assistantTurnsSinceLastPrompt: 1,
    });
  });

  it('does not treat ordinary structured rate-limit discussion as a provider rejection', () => {
    const discussed = JSON.stringify({ ...JSON.parse(assistant('The gateway returned rate_limit; I am reviewing.')), error: 'rate_limit' });
    expect(analyzeClaudeResumeTranscript(discussed)).toMatchObject({
      trailingAccountWallTurns: 0,
      lastAccountWallEvidence: null,
    });
  });

  it('a new kickoff clears a structured rate-limit rejection', () => {
    const rejected = JSON.stringify({ ...JSON.parse(apiError('Gateway temporarily throttled', 429)), error: 'rate_limit' });
    const kickoff = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Retry the same review.' } });
    expect(analyzeClaudeResumeTranscript([rejected, kickoff].join('\n'))).toMatchObject({
      trailingAccountWallTurns: 0,
      lastAccountWallEvidence: null,
      assistantTurnsSinceLastPrompt: 0,
    });
  });

  it('keeps copied billing errors and ordinary model discussion out of current account-wall evidence', () => {
    const kickoff = JSON.stringify({ type: 'user', message: { role: 'user', content: 'Answer the current consult.' } });
    for (const recovery of [kickoff, assistant('Credit balance is too low')]) {
      expect(analyzeClaudeResumeTranscript([apiError('Credit balance is too low'), recovery].join('\n')))
        .toMatchObject({ trailingAccountWallTurns: 0, lastAccountWallEvidence: null });
    }
  });

  it('detects the persisted provider context wall across a new fork kickoff', () => {
    const transcript = [
      assistant('Working.'),
      apiError('Prompt is too long'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Answer the exact current consult.' } }),
    ].join('\n');
    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingContextLimitTurns: 1,
      lastContextLimitEvidence: 'Prompt is too long',
      trailingMissingToolReferenceTurns: 0,
    });
  });

  it.each([
    assistant('The source reported Prompt is too long; investigate it.'),
    assistant('Prompt is too long'),
    JSON.stringify({ type: 'system', subtype: 'compact_boundary' }),
  ])('CONTROL: model output or a native compaction clears a prior context wall', (recovery) => {
    expect(analyzeClaudeResumeTranscript([apiError('Prompt is too long'), recovery].join('\n')))
      .toMatchObject({ trailingContextLimitTurns: 0, lastContextLimitEvidence: null });
  });

  it('tool results do not clear a synthetic context rejection', () => {
    const result = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', content: 'done' }] },
    });
    expect(analyzeClaudeResumeTranscript([apiError('Prompt is too long'), result].join('\n')))
      .toMatchObject({ trailingContextLimitTurns: 1 });
  });

  it('restores recent Papercusp tool references and excludes other MCP servers', () => {
    const transcript = [
      JSON.stringify({
        type: 'user',
        message: { content: [
          { type: 'tool_reference', tool_name: 'mcp__papercusp-su__plans_audit' },
          { type: 'tool_reference', tool_name: 'mcp__filesystem__read_file' },
        ] },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_reference', tool_name: 'mcp__papercusp_su__docs_get' }] },
      }),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript).toolReferences).toEqual([
      'mcp__papercusp_su__docs_get',
      'mcp__papercusp-su__plans_audit',
    ]);
  });

  it('bounds the restored set to the most recently referenced tools', () => {
    const transcript = Array.from({ length: 4 }, (_, i) => JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_reference', tool_name: `mcp__papercusp-su__tool_${i}` }] },
    })).join('\n');

    expect(analyzeClaudeResumeTranscript(transcript, { maxReferences: 2 }).toolReferences).toEqual([
      'mcp__papercusp-su__tool_3',
      'mcp__papercusp-su__tool_2',
    ]);
  });

  it('counts only a trailing streak of exact missing-tool-reference assistant turns', () => {
    const ref = 'mcp__papercusp-su__plans_audit';
    const transcript = [
      assistant('Previous valid turn.'),
      apiError(missing(ref)),
      apiError(missing(ref, false)),
      apiError(missing(ref)),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: CLAUDE_TOOL_REFERENCE_POISON_TURNS,
      lastMissingToolReferenceName: ref,
      needsFreshContext: true,
      poisoned: true,
    });
  });

  it('flags a live session for fresh-context recovery at two consecutive rejections, before the quarantine threshold', () => {
    const ref = 'mcp__papercusp-su__capability_bash';
    const transcript = [assistant('Working.'), apiError(missing(ref)), apiError(missing(ref))].join('\n');

    expect(CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS).toBeLessThan(CLAUDE_TOOL_REFERENCE_POISON_TURNS);
    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: CLAUDE_TOOL_REFERENCE_RECOVERY_TURNS,
      needsFreshContext: true,
      poisoned: false,
    });
    expect(analyzeClaudeResumeTranscript([assistant('Working.'), apiError(missing(ref))].join('\n')))
      .toMatchObject({ trailingMissingToolReferenceTurns: 1, needsFreshContext: false });
  });

  it('never counts assistant PROSE that quotes the rejection (WI-10003466 false-death guard)', () => {
    // An agent diagnosing this very failure writes the error text into its own
    // reply. That is model output, not the provider's synthetic rejection record,
    // so it must reset the streak instead of quarantining/respawning a healthy session.
    const ref = 'mcp__papercusp-su__capability_bash';
    const quoted = `Root cause:\n${missing(ref)}\n— the MCP transport dropped.`;
    const transcript = [apiError(missing(ref)), assistant(quoted), assistant(missing(ref)), assistant(quoted)].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: 0,
      lastMissingToolReferenceName: null,
      needsFreshContext: false,
      poisoned: false,
    });
  });

  it('resets the poison streak on a normal assistant turn and ignores malformed JSONL', () => {
    const ref = 'mcp__papercusp-su__plans_audit';
    const transcript = [
      apiError(missing(ref)),
      '{partial JSON',
      apiError(missing(ref)),
      assistant('I can continue normally.'),
    ].join('\n');

    expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
      trailingMissingToolReferenceTurns: 0,
      poisoned: false,
    });
  });

  // WI-10004645: a fork's file starts with the source's copied history, so the
  // consult dispatcher needs to know whether the fork's OWN first reply exists.
  describe('assistantTurnsSinceLastPrompt', () => {
    const prompt = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
    const toolResult = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
    });
    const meta = JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'caveat' } });
    // The non-message rows a real fork transcript carries between its kickoff and its reply.
    const attachment = JSON.stringify({ type: 'attachment', attachment: { type: 'hook_additional_context' } });
    const system = JSON.stringify({ type: 'system', subtype: 'turn_duration', durationMs: 900 });

    it('is 0 for a fork whose kickoff is written but whose reply is not, despite copied assistant history', () => {
      const transcript = [
        prompt('source work'),
        assistant('source reply'),
        prompt('the consult kickoff'),
        attachment,
        meta,
      ].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
        assistantTurnsSinceLastPrompt: 0,
        trailingMissingToolReferenceTurns: 0,
      });
    });

    it('counts the fork’s first reply once it lands, including the provider’s synthetic rejection', () => {
      const transcript = [
        prompt('source work'),
        assistant('source reply'),
        prompt('the consult kickoff'),
        attachment,
        apiError(missing('EndConversation')),
        system,
      ].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
        assistantTurnsSinceLastPrompt: 1,
        trailingMissingToolReferenceTurns: 1,
        lastMissingToolReferenceName: 'EndConversation',
      });
    });

    it('a tool result or meta row continues the turn — it does not reset the count', () => {
      const transcript = [
        prompt('the consult kickoff'),
        assistant('calling a tool'),
        toolResult,
        meta,
        assistant('answered'),
      ].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript).assistantTurnsSinceLastPrompt).toBe(2);
    });

    it('a copied rejection in the source history is not counted for the fork before it replies', () => {
      // The streak still reports the history's tail, which is why the
      // dispatcher must also require a reply after the prompt before judging.
      const transcript = [prompt('wake'), apiError(missing('WaitForMcpServers')), prompt('the consult kickoff')].join('\n');
      expect(analyzeClaudeResumeTranscript(transcript)).toMatchObject({
        assistantTurnsSinceLastPrompt: 0,
        trailingMissingToolReferenceTurns: 1,
      });
    });
  });

  it('appends Papercusp references without changing or duplicating the current seed', () => {
    expect(appendClaudeToolReferencesToSeed(
      'tools:find,coord:orient,mcp__papercusp-su__plans_audit',
      ['mcp__papercusp-su__plans_audit', 'mcp__papercusp_su__docs_get', 'mcp__filesystem__read_file'],
    )).toBe('tools:find,coord:orient,mcp__papercusp-su__plans_audit,mcp__papercusp_su__docs_get');
  });

  it('reuses diagnostics for an unchanged transcript and refreshes them after append', () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-tool-reference-'));
    try {
      const file = join(root, 'session.jsonl');
      writeFileSync(file, assistant('Normal turn.'));
      expect(analyzeClaudeResumeTranscriptFile(file)?.trailingMissingToolReferenceTurns).toBe(0);
      writeFileSync(file, `${assistant('Normal turn.')}\n${apiError(missing('mcp__papercusp-su__plans_audit'))}`);
      expect(analyzeClaudeResumeTranscriptFile(file)?.trailingMissingToolReferenceTurns).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/**
 * WI-10005612: the exact record shape that made every acceptance-grading fork
 * die on its first request (conv-murg7tb6, 2026-10-02): a server tool-search
 * result in an ASSISTANT message whose `tool_references` named the native
 * `EndConversation`, which the headless fork does not advertise.
 */
const serverToolSearch = (...names: string[]) => JSON.stringify({
  type: 'assistant',
  uuid: 'u-1',
  message: {
    role: 'assistant',
    content: [{
      type: 'tool_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: {
        type: 'tool_search_tool_search_result',
        tool_references: names.map((tool_name) => ({ type: 'tool_reference', tool_name })),
      },
    }],
  },
});
/** A client ToolSearch result: references inside a tool_result content array. */
const clientToolSearch = (...names: string[]) => JSON.stringify({
  type: 'user',
  message: {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: names.map((tool_name) => ({ type: 'tool_reference', tool_name })),
    }],
  },
});

describe('neutralizeClaudeToolReferences (fork seed)', () => {
  it('empties a server tool-search result instead of leaving an unresolvable reference', () => {
    const out = neutralizeClaudeToolReferences(serverToolSearch('Bash', 'EndConversation'));
    expect(out.rewritten).toBe(2);
    expect(out.toolNames).toEqual(['Bash', 'EndConversation']);
    const record = JSON.parse(out.text);
    expect(record.uuid).toBe('u-1');
    expect(record.message.content[0].type).toBe('tool_search_tool_result');
    // An empty match list is a valid search result; a text block in this array is not.
    expect(record.message.content[0].content.tool_references).toEqual([]);
    expect(out.text).not.toContain('tool_reference"');
  });

  it('turns a reference inside tool_result content into a text marker', () => {
    const out = neutralizeClaudeToolReferences(clientToolSearch('mcp__papercusp-su__plans_audit'));
    expect(out.rewritten).toBe(1);
    const block = JSON.parse(out.text).message.content[0];
    expect(block.type).toBe('tool_result');
    expect(block.content).toEqual([
      { type: 'text', text: '[tool reference mcp__papercusp-su__plans_audit was loaded here before this session was forked]' },
    ]);
  });

  it('leaves lines without references, and unparseable lines, byte-identical', () => {
    const plain = assistant('No references here.');
    const broken = '{"type":"assistant","message":{"content":[{"type":"tool_reference"';
    const jsonl = [plain, broken, serverToolSearch('EndConversation'), ''].join('\n');
    const out = neutralizeClaudeToolReferences(jsonl);
    const lines = out.text.split('\n');
    expect(lines[0]).toBe(plain);
    expect(lines[1]).toBe(broken);
    expect(lines[3]).toBe('');
    expect(out.rewritten).toBe(1);
  });
});

describe('neutralizeForkSeedToolReferences', () => {
  it("rewrites only the source session's seeded transcripts, in every encoded-cwd dir, idempotently", () => {
    const projects = mkdtempSync(join(tmpdir(), 'fork-seed-'));
    try {
      const a = join(projects, '-home-a');
      const b = join(projects, '-home-b');
      mkdirSync(a);
      mkdirSync(b);
      const source = `${assistant('hello')}\n${serverToolSearch('EndConversation', 'WaitForMcpServers')}\n`;
      writeFileSync(join(a, 'orig.jsonl'), source);
      writeFileSync(join(b, 'orig.jsonl'), clientToolSearch('Monitor'));
      writeFileSync(join(a, 'other.jsonl'), source);

      const first = neutralizeForkSeedToolReferences(projects, 'orig');
      expect(first).toMatchObject({ files: 2, rewritten: 3 });
      expect(first.toolNames.sort()).toEqual(['EndConversation', 'Monitor', 'WaitForMcpServers']);
      expect(readFileSync(join(a, 'orig.jsonl'), 'utf8')).not.toContain('"tool_reference"');
      expect(readFileSync(join(b, 'orig.jsonl'), 'utf8')).not.toContain('"tool_reference"');
      // Another session's transcript in the same dir is not the fork's source.
      expect(readFileSync(join(a, 'other.jsonl'), 'utf8')).toBe(source);

      expect(neutralizeForkSeedToolReferences(projects, 'orig')).toMatchObject({ files: 0, rewritten: 0 });
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('is a no-op for a missing dir or id', () => {
    expect(neutralizeForkSeedToolReferences(join(tmpdir(), 'no-such-fork-seed-dir'), 'x')).toEqual({ files: 0, rewritten: 0, toolNames: [] });
    expect(neutralizeForkSeedToolReferences(null, 'x')).toEqual({ files: 0, rewritten: 0, toolNames: [] });
  });
});

/**
 * EI-24890753013901545: a same-session RESUME (not a fork) hit the provider's
 * "Tool reference 'ExitPlanMode' not found in available tools" 400 because the
 * resumed process lacks a NATIVE deferred tool the earlier process loaded, and
 * the resume seed can only restore Papercusp MCP names. Native references are
 * dropped from the resumed session's own transcript; Papercusp ones stay.
 */
describe('native-only neutralization for a same-session resume (EI-24890753013901545)', () => {
  const PAPERCUSP = 'mcp__papercusp-su__plans_audit';

  it('drops native references and keeps Papercusp MCP references in a server search result', () => {
    const out = neutralizeClaudeToolReferences(
      serverToolSearch('ExitPlanMode', PAPERCUSP, 'WaitForMcpServers'),
      { nativeOnly: true },
    );
    expect(out.rewritten).toBe(2);
    expect(out.toolNames).toEqual(['ExitPlanMode', 'WaitForMcpServers']);
    expect(JSON.parse(out.text).message.content[0].content.tool_references).toEqual([
      { type: 'tool_reference', tool_name: PAPERCUSP },
    ]);
  });

  it('rewrites a native reference inside tool_result content and leaves a Papercusp one byte-identical', () => {
    const native = neutralizeClaudeToolReferences(clientToolSearch('ExitPlanMode'), { nativeOnly: true });
    expect(native.rewritten).toBe(1);
    // The marker must describe a RESUME, not a fork (the agent reads this text).
    expect(JSON.parse(native.text).message.content[0].content).toEqual([
      { type: 'text', text: '[tool reference ExitPlanMode was loaded here before this session was resumed]' },
    ]);
    expect(native.text).not.toContain('"tool_reference"');

    const mcpOnly = clientToolSearch(PAPERCUSP);
    const kept = neutralizeClaudeToolReferences(mcpOnly, { nativeOnly: true });
    expect(kept).toMatchObject({ rewritten: 0, toolNames: [] });
    expect(kept.text).toBe(mcpOnly);
  });

  it('keeps the FORK default unchanged: without nativeOnly every reference is neutralized', () => {
    const out = neutralizeClaudeToolReferences(serverToolSearch('ExitPlanMode', PAPERCUSP));
    expect(out.rewritten).toBe(2);
    expect(out.text).not.toContain('"tool_reference"');
  });

  it("rewrites only the resumed session's own transcript, atomically, idempotently, leaving no temp file", () => {
    const projects = mkdtempSync(join(tmpdir(), 'resume-native-'));
    try {
      const dir = join(projects, '-home-a');
      mkdirSync(dir);
      const source = `${assistant('hello')}\n${serverToolSearch('ExitPlanMode', PAPERCUSP)}\n`;
      writeFileSync(join(dir, 'sess.jsonl'), source);
      writeFileSync(join(dir, 'other.jsonl'), source);

      const first = neutralizeResumeNativeToolReferences(projects, 'sess');
      expect(first).toMatchObject({ files: 1, rewritten: 1, toolNames: ['ExitPlanMode'] });
      const after = readFileSync(join(dir, 'sess.jsonl'), 'utf8');
      expect(after).not.toContain('ExitPlanMode');
      // The seed restores Papercusp references, so the analysis must still see it.
      expect(analyzeClaudeResumeTranscriptFile(join(dir, 'sess.jsonl'))?.toolReferences).toEqual([PAPERCUSP]);
      // A different session in the same dir is not the resumed one.
      expect(readFileSync(join(dir, 'other.jsonl'), 'utf8')).toBe(source);
      // temp + rename must not strand a partial file next to the transcript.
      expect(readdirSync(dir).sort()).toEqual(['other.jsonl', 'sess.jsonl']);

      expect(neutralizeResumeNativeToolReferences(projects, 'sess')).toMatchObject({ files: 0, rewritten: 0 });
      expect(readFileSync(join(dir, 'sess.jsonl'), 'utf8')).toBe(after);
    } finally {
      rmSync(projects, { recursive: true, force: true });
    }
  });

  it('file form: rewrites native references, and is a no-op for a missing or empty path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resume-native-file-'));
    try {
      const file = join(dir, 'sess.jsonl');
      writeFileSync(file, serverToolSearch('WaitForMcpServers'));
      expect(neutralizeResumeNativeToolReferencesInFile(file)).toMatchObject({ rewritten: 1, toolNames: ['WaitForMcpServers'] });
      expect(readFileSync(file, 'utf8')).not.toContain('WaitForMcpServers');
      expect(neutralizeResumeNativeToolReferencesInFile(join(dir, 'missing.jsonl'))).toEqual({ rewritten: 0, toolNames: [] });
      expect(neutralizeResumeNativeToolReferencesInFile(null)).toEqual({ rewritten: 0, toolNames: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
