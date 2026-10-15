/**
 * Faithful-parts ingest conformance (session-turn-storage-2026-07-28 P-001,
 * P-004). Pure line→parts tests — no PG, no FS.
 *
 * Three contracts are pinned here, each of which has a concrete way to break:
 *   1. FIDELITY — every renderable block of a line becomes a part, in content
 *      order. The thing this plan exists to fix is that `parseClaudeLine`
 *      reduces a whole assistant line to its joined text or to nothing at all.
 *   2. SEPARATION — parts must never leak into the recall corpus. Enforced
 *      structurally (a separate table, D-001), so what is pinned here is that
 *      the TURN parser's behavior is unchanged by the parts work.
 *   3. REDACTION (P-004) — tool inputs and results carry file contents and
 *      credentials, and the shapes that matter there are key-directed
 *      (`API_KEY=…`), which no token-shape regex can see. This is a security
 *      gate on P-001, so it is tested as one.
 *
 * NOTE: credential-shaped fixtures below are assembled from fragments rather
 * than written as literals. The repo's secrets-guard PreToolUse hook refuses
 * to write a PEM banner into a git-sync tree file, and it is right to — a
 * redaction test is not a reason to put a real-looking key in history.
 */

import { describe, it, expect } from 'vitest';
import {
  FILE_ADAPTERS,
  parseClaudeParts,
  parseClaudeLine,
  parseCodexParts,
  cleanPartText,
  redactPartSecrets,
  partRowsFrom,
  canonicalSessionPartToolName,
  PART_TEXT_CAP_PROSE,
  PART_TEXT_CAP_TOOL,
  type ParsedPart,
} from './session-ingest';
import {
  PAPERCUSP_MCP_SERVER,
  PAPERCUSP_MCP_SERVER_NAMES,
  PSU_MCP_SERVER,
} from '../papercusp-mcp-servers';

const assistantLine = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-07-28T05:00:00.000Z',
    sessionId: 'sess-1',
    message: { role: 'assistant', content },
    ...extra,
  });

const userLine = (content: unknown) =>
  JSON.stringify({
    type: 'user',
    timestamp: '2026-07-28T05:00:01.000Z',
    sessionId: 'sess-1',
    message: { role: 'user', content },
  });

describe('parseClaudeParts — fidelity', () => {
  it('emits every renderable block of one line, in content order', () => {
    const parts = parseClaudeParts(assistantLine([
      { type: 'thinking', thinking: 'weighing options' },
      { type: 'text', text: 'Let me check two things.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/etc/hosts' } },
    ]));
    expect(parts.map((p) => p.partKind)).toEqual(['thinking', 'text', 'tool_use', 'tool_use']);
    expect(parts.map((p) => p.toolName)).toEqual([null, null, 'Bash', 'Read']);
    expect(parts[2].text).toContain('ls -la');
    expect(parts.every((p) => p.speaker === 'assistant')).toBe(true);
    expect(parts.every((p) => p.sessionId === 'sess-1')).toBe(true);
  });

  it('captures exactly what the TURN parser throws away', () => {
    // The motivating case: an assistant line that is nothing but tool calls.
    // parseClaudeLine returns null (no text ⇒ no row at all); a pane rendering
    // from session_turns alone shows a hole where the work happened.
    const line = assistantLine([{ type: 'tool_use', name: 'Grep', input: { pattern: 'x' } }]);
    expect(parseClaudeLine(line)).toBeNull();
    expect(parseClaudeParts(line)).toHaveLength(1);
  });

  it('stores a tool_use on its NAME alone when the input is empty', () => {
    // An argument-less call is still a real transcript event; dropping it would
    // silently change the pane's view of what the agent did.
    const parts = parseClaudeParts(assistantLine([{ type: 'tool_use', name: 'TaskList', input: {} }]));
    expect(parts).toHaveLength(1);
    expect(parts[0].toolName).toBe('TaskList');
  });

  it('reads a tool_result carried on a synthetic user line', () => {
    const parts = parseClaudeParts(userLine([
      { type: 'tool_result', content: [{ type: 'text', text: 'total 4\ndrwx' }] },
    ]));
    expect(parts).toHaveLength(1);
    expect(parts[0].partKind).toBe('tool_result');
    expect(parts[0].text).toContain('total 4');
    // ...and that same line remains a NON-turn for recall (separation).
    expect(parseClaudeLine(userLine([
      { type: 'tool_result', content: [{ type: 'text', text: 'total 4' }] },
    ]))).toBeNull();
  });

  it('keeps boilerplate the recall parser deliberately drops', () => {
    // <system-reminder> is noise for RECALL and real content for RENDERING —
    // the pane showed it before this change and must keep showing it.
    const line = userLine([{ type: 'text', text: '<system-reminder>be brief</system-reminder>' }]);
    expect(parseClaudeLine(line)).toBeNull();
    expect(parseClaudeParts(line)[0].text).toContain('system-reminder');
  });

  it('ignores non-transcript and malformed lines without throwing', () => {
    expect(parseClaudeParts('not json')).toEqual([]);
    expect(parseClaudeParts(JSON.stringify({ type: 'summary' }))).toEqual([]);
    expect(parseClaudeParts(JSON.stringify({ type: 'assistant' }))).toEqual([]);
    expect(parseClaudeParts(assistantLine('a plain string body'))[0].partKind).toBe('text');
  });
});

describe('parseCodexParts — fidelity', () => {
  const responseItem = (payload: Record<string, unknown>, timestamp = '2026-08-20T19:44:10.656Z') =>
    JSON.stringify({ type: 'response_item', timestamp, payload });

  it('stores the exact native-only assistant marker that drives P-011 freshness', () => {
    const parts = parseCodexParts(responseItem({
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'NATIVE_ONLY_P011_READY_3' }],
    }));

    expect(parts).toEqual([{
      ts: new Date('2026-08-20T19:44:10.656Z'),
      speaker: 'assistant',
      partKind: 'text',
      toolName: null,
      text: 'NATIVE_ONLY_P011_READY_3',
    }]);
  });

  it('maps tool calls, results, and readable reasoning summaries without losing speaker provenance', () => {
    const parts = [
      ...parseCodexParts(responseItem({
        type: 'function_call', namespace: 'mcp__papercusp_su', name: 'coord_presence',
        arguments: '{"owner":"su-1"}',
      })),
      ...parseCodexParts(responseItem({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch' })),
      ...parseCodexParts(responseItem({ type: 'function_call_output', output: 'done' })),
      ...parseCodexParts(responseItem({ type: 'reasoning', summary: [{ text: 'weigh the evidence' }] })),
    ];

    expect(parts.map((part) => part.partKind)).toEqual([
      'tool_use', 'tool_use', 'tool_result', 'thinking',
    ]);
    expect(parts.map((part) => part.speaker)).toEqual([
      'assistant', 'assistant', 'user', 'assistant',
    ]);
    expect(parts[0]).toMatchObject({ toolName: 'mcp__papercusp_su.coord_presence' });
    expect(parts[1]).toMatchObject({ toolName: 'apply_patch', text: '*** Begin Patch' });
    expect(parts[2].text).toBe('done');
    expect(parts[3].text).toBe('weigh the evidence');
  });

  it('skips malformed, meta, and duplicate event_msg records', () => {
    expect(parseCodexParts('not json')).toEqual([]);
    expect(parseCodexParts(JSON.stringify({ type: 'session_meta', payload: {} }))).toEqual([]);
    expect(parseCodexParts(JSON.stringify({
      type: 'event_msg', payload: { type: 'agent_message', message: 'duplicate' },
    }))).toEqual([]);
  });

  it('is wired into the Codex ingest adapter so the cursor cannot advance without parts', () => {
    const codex = FILE_ADAPTERS.find((adapter) => adapter.sourceKind === 'codex');
    expect(codex?.parseParts).toBe(parseCodexParts);
  });
});

describe('cleanPartText — cap', () => {
  it('marks truncation rather than silently cutting', () => {
    const out = cleanPartText('x'.repeat(PART_TEXT_CAP_TOOL + 500), 'tool_result');
    expect(out.length).toBeLessThan(PART_TEXT_CAP_TOOL + 200);
    expect(out).toContain('[truncated 500 chars]');
  });

  it('leaves in-cap text untouched', () => {
    expect(cleanPartText('  hello  ')).toBe('  hello  ');
  });

  it('redacts a prefixed opaque value across the cap before storing a Codex tool result', () => {
    const prefix = 'x'.repeat(PART_TEXT_CAP_TOOL - 40);
    const secret = 'opaque-fixture-value-that-crosses-the-cap';
    const suffix = ' trailing diagnostic context'.repeat(2);
    const raw = prefix + ' AWS_SECRET_ACCESS_KEY=' + secret + suffix;
    const expected = cleanPartText(prefix + ' AWS_SECRET_ACCESS_KEY=[redacted]' + suffix, 'tool_result');
    const parts = parseCodexParts(JSON.stringify({
      type: 'response_item', timestamp: '2026-10-01T00:00:00Z',
      payload: { type: 'function_call_output', output: raw },
    }));
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toBe(expected);
    expect(parts[0].text).toContain('[redacted]');
    expect(parts[0].text).not.toContain('opaque-fixture');
    expect(parts[0].text).toContain('[truncated ');
  });

  it('caps PROSE at the render budget, not the tool cap (EI-20637908167729753)', () => {
    // The regression: prose used to share the tool cap, so an agent's own
    // report was cut to 2,000 chars even though the pane could render 8,000.
    const body = 'x'.repeat(PART_TEXT_CAP_TOOL + 500);
    expect(cleanPartText(body, 'text')).toBe(body);
    expect(cleanPartText(body, 'thinking')).toBe(body);
    expect(PART_TEXT_CAP_PROSE).toBeGreaterThan(PART_TEXT_CAP_TOOL);
  });
});

describe('redactPartSecrets — P-004 security gate', () => {
  it('redacts key-directed secrets a token-shape regex cannot see', () => {
    // The whole point: these values are opaque random strings. Only the KEY
    // next to them identifies them as credentials.
    const cases: Array<[string, RegExp]> = [
      ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLE', /wJalrXUt/],
      ['api_key: "a8f3c0d1e2b7449aa1f0"', /a8f3c0d1/],
      ["password='hunter2hunter2'", /hunter2/],
      ['Authorization: Bearer abcdef0123456789abcdef', /abcdef0123/],
      ['{"client_secret": "s3cr3t-value-here-0000"}', /s3cr3t-value/],
    ];
    for (const [input, leak] of cases) {
      const out = redactPartSecrets(input);
      expect(out, input).toContain('[redacted]');
      expect(out, input).not.toMatch(leak);
    }
  });

  it('preserves the KEY so a reader still knows what was elided', () => {
    expect(redactPartSecrets('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPx'))
      .toContain('AWS_SECRET_ACCESS_KEY=');
  });

  it('elides a private-key body but keeps the banner', () => {
    // Assembled, never a literal — see the file header.
    const dashes = '-'.repeat(5);
    const banner = `${dashes}BEGIN RSA PRIVATE KEY${dashes}`;
    const end = `${dashes}END RSA PRIVATE KEY${dashes}`;
    const out = redactPartSecrets(`${banner}\nMIIEowIBAAKCAQEAsecretbytes\n${end}`);
    expect(out).toContain(banner);
    expect(out).not.toContain('secretbytes');
  });

  it('does not redact ordinary prose that merely mentions a credential word', () => {
    // The false-positive guard: this pass is applied to PARTS only, but even
    // there it must not eat a sentence.
    const prose = 'The password reset flow is broken and the token expiry is wrong.';
    expect(redactPartSecrets(prose)).toBe(prose);
  });

  it('is applied by cleanPartText, so every stored part is scrubbed', () => {
    const out = cleanPartText('running with API_KEY=0123456789abcdef0123 set');
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('0123456789abcdef');
  });

  it('scrubs a secret that appears inside a real tool_use input', () => {
    const parts = parseClaudeParts(assistantLine([
      { type: 'tool_use', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer tok_abcdef012345"' } },
    ]));
    expect(parts[0].text).toContain('[redacted]');
    expect(parts[0].text).not.toContain('tok_abcdef012345');
  });
});

describe('partRowsFrom — numbering', () => {
  const part = (over: Partial<ParsedPart> = {}): ParsedPart => ({
    ts: new Date('2026-07-28T05:00:00.000Z'),
    speaker: 'assistant',
    partKind: 'text',
    text: 'x',
    ...over,
  });

  it('numbers parts from the persisted cursor, continuing across ticks', () => {
    const rows = partRowsFrom([part(), part(), part()], {
      sourceKind: 'claude', sessionId: 'sess-1', owner: 'su-1', partCount: 17,
    });
    expect(rows.map((r) => r.part_idx)).toEqual([17, 18, 19]);
    expect(rows.every((r) => r.session_id === 'sess-1' && r.owner === 'su-1')).toBe(true);
  });

  it('prefers a part-carried sessionId over the file-derived one', () => {
    // A resumed transcript can carry a different sessionId than its path
    // implies; the row must follow the line, exactly as turns do.
    const rows = partRowsFrom([part({ sessionId: 'sess-resumed' })], {
      sourceKind: 'claude', sessionId: 'sess-from-path', owner: null, partCount: 0,
    });
    expect(rows[0].session_id).toBe('sess-resumed');
  });

  it('nulls tool_name for non-tool parts', () => {
    const rows = partRowsFrom([part(), part({ partKind: 'tool_use', toolName: 'Bash' })], {
      sourceKind: 'claude', sessionId: 's', owner: null, partCount: 0,
    });
    expect(rows.map((r) => r.tool_name)).toEqual([null, 'Bash']);
  });
});

describe('session tool-name canonicalization — live catalog aliases', () => {
  const catalog = (...names: string[]) =>
    names.map((name) => ({ expose: { mcp: { name } } }));

  it('maps the Claude and Codex Papercusp wrapper spellings to group:verb', () => {
    const names = catalog('coord:presence', 'blender:ideation-feedback');

    expect(canonicalSessionPartToolName('mcp__papercusp-su__coord_presence', names))
      .toBe('coord:presence');
    expect(canonicalSessionPartToolName('mcp__papercusp_su.coord_presence', names))
      .toBe('coord:presence');
    expect(canonicalSessionPartToolName('mcp__papercusp-su__blender_ideation-feedback', names))
      .toBe('blender:ideation-feedback');
    expect(canonicalSessionPartToolName('mcp__papercusp_su.blender_ideation_feedback', names))
      .toBe('blender:ideation-feedback');
  });

  // WI-6554700010008643: spawned agents register the catalog under the
  // `papercusp` server, not `papercusp-su`; ~13k rows/day stayed mangled.
  it('maps the spawned-agent `papercusp` server spellings too (Claude and Codex)', () => {
    const names = catalog('tools:invoke', 'code:run', 'blender:ideation-feedback');

    expect(canonicalSessionPartToolName('mcp__papercusp__tools_invoke', names)).toBe('tools:invoke');
    expect(canonicalSessionPartToolName('mcp__papercusp__code_run', names)).toBe('code:run');
    expect(canonicalSessionPartToolName('mcp__papercusp.code_run', names)).toBe('code:run');
    expect(canonicalSessionPartToolName('mcp__papercusp__blender_ideation-feedback', names))
      .toBe('blender:ideation-feedback');
    expect(canonicalSessionPartToolName('mcp__papercusp.blender_ideation_feedback', names))
      .toBe('blender:ideation-feedback');
    // Unknown verb under the same server stays byte-for-byte.
    expect(canonicalSessionPartToolName('mcp__papercusp__not_in_catalog', names))
      .toBe('mcp__papercusp__not_in_catalog');
  });

  it('derives its prefixes from every registered server name, so a new one needs no second edit', () => {
    const names = catalog('coord:presence');
    for (const server of PAPERCUSP_MCP_SERVER_NAMES) {
      expect(canonicalSessionPartToolName(`mcp__${server}__coord_presence`, names)).toBe('coord:presence');
      expect(canonicalSessionPartToolName(`mcp__${server.replace(/-/g, '_')}.coord_presence`, names))
        .toBe('coord:presence');
    }
    // Both servers the launch writers use are covered.
    expect([...PAPERCUSP_MCP_SERVER_NAMES].sort()).toEqual(
      [PAPERCUSP_MCP_SERVER, PSU_MCP_SERVER].sort(),
    );
  });

  it('canonicalizes at the persisted row seam while preserving native and unknown names', () => {
    const rows = partRowsFrom([
      {
        ts: null,
        speaker: 'assistant',
        partKind: 'tool_use',
        toolName: 'mcp__papercusp_su.coord_presence',
        text: '{}',
      },
      {
        ts: null,
        speaker: 'assistant',
        partKind: 'tool_use',
        toolName: 'Read',
        text: '{}',
      },
      {
        ts: null,
        speaker: 'assistant',
        partKind: 'tool_use',
        toolName: 'mcp__papercusp_su.not_in_catalog',
        text: '{}',
      },
    ], {
      sourceKind: 'codex',
      sessionId: 's',
      owner: null,
      partCount: 0,
    }, catalog('coord:presence'));

    expect(rows.map((row) => row.tool_name)).toEqual([
      'coord:presence',
      'Read',
      'mcp__papercusp_su.not_in_catalog',
    ]);
  });

  it('leaves a separator-collision untouched instead of guessing', () => {
    const ambiguous = catalog('foo:bar_baz', 'foo_bar:baz');
    const alias = 'mcp__papercusp_su.foo_bar_baz';

    expect(canonicalSessionPartToolName(alias, ambiguous)).toBe(alias);
    expect(canonicalSessionPartToolName(alias, catalog('foo:bar_baz')))
      .toBe('foo:bar_baz');
  });
});
