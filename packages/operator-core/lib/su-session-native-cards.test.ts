import { afterEach, describe, expect, it } from 'vitest';
import { _resetCardCorrelatorForTests, resolveCardResponse } from '@papercusp/agent-mcp';
import { REJECTED_TOOL_MESSAGE, SKIPPED_QUESTION_MESSAGE, SuNativeCards, type SuNativeCardsOptions } from './su-session-native-cards';
import type { SuSessionEventInput } from './su-session-host';
import type { RpcFrame } from './su-session-stdio-peer';

afterEach(_resetCardCorrelatorForTests);
function fixture(options: SuNativeCardsOptions = {}) {
  const events: SuSessionEventInput[] = [];
  const replies: RpcFrame[] = [];
  const cards = new SuNativeCards('workspace', 'native-card-test', (event) => events.push(event), options);
  const opened = () => {
    const event = [...events].reverse().find((event) => event.type === 'card' && event.phase === 'opened');
    if (!event || event.type !== 'card' || event.phase !== 'opened') throw new Error('No pending card');
    return event;
  };
  const answer = (payload: unknown, workspaceId = 'workspace') =>
    resolveCardResponse({ correlationId: opened().card.correlationId, action: 'submit', payload, expectedWorkspaceId: workspaceId });
  /** Esc on the card: the PUI's decline. */
  const escape = () => resolveCardResponse({ correlationId: opened().card.correlationId, action: 'decline', expectedWorkspaceId: 'workspace' });
  return { cards, events, replies, answer, escape, opened, reply: (frame: RpcFrame) => replies.push(frame) };
}
/** Lets every pending reply settle: a macrotask, so the test never depends on
 * how many awaits sit between a card's answer and the native reply. */
const flush = () => new Promise<void>((resolve) => { setImmediate(resolve); });
/** Labels of the most recently opened choice card. */
function openedChoiceLabels(events: SuSessionEventInput[]): string[] {
  const card = events.at(-1);
  const presentation = card?.type === 'card' && card.phase === 'opened' ? card.card.presentation : undefined;
  if (presentation?.kind !== 'radio' || !presentation.options) throw new Error('No permission card');
  return presentation.options.map((option) => option.label);
}

describe('native requests through the shared PUI card correlator', () => {
  it('requires the matching workspace and an explicit approval before answering Codex', async () => {
    const f = fixture();
    expect(f.cards.handle('codex', { id: 10, method: 'item/commandExecution/requestApproval', params: { command: 'touch approved.txt' } }, 'turn', f.reply)).toBe(true);
    expect(f.replies).toEqual([]);
    expect(f.answer({ picks: ['yes'] }, 'wrong-workspace').ok).toBe(false);
    expect(f.answer({ picks: ['invalid'] }).ok).toBe(false);
    expect(f.replies).toEqual([]);
    expect(f.answer({ picks: ['yes'] }).ok).toBe(true);
    await flush();
    expect(f.replies).toEqual([{ id: 10, result: { decision: 'accept' } }]);
    expect(f.answer({ picks: ['yes'] }).ok).toBe(false);
  });

  // D-028: one approval prompt for every engine, in Claude Code's words.
  it('asks a Codex command approval as Yes / Yes, don\'t ask again / No, with the command shown once', () => {
    const f = fixture({ cwd: '/tmp/proj' });
    f.cards.handle('codex', { id: 14, method: 'item/commandExecution/requestApproval',
      params: { command: 'npm test', cwd: '/tmp/proj/web' } }, 'turn', f.reply);
    expect(openedChoiceLabels(f.events)).toEqual(['Yes',
      "Yes, and don't ask again for this command this session", 'No, and tell Codex what to do instead']);
    expect(f.opened().card.approval).toEqual({ title: 'Bash(npm test)', question: 'Do you want to run this command?',
      body: ['$ npm test', 'Directory: web'] });
  });

  it('maps the Codex answers to accept, acceptForSession and cancel (No and Esc both stop the turn)', async () => {
    for (const [answer, decision] of [['always', 'acceptForSession'], ['no', 'cancel'], ['esc', 'cancel']] as const) {
      const f = fixture();
      f.cards.handle('codex', { id: 11, method: 'item/fileChange/requestApproval', params: { reason: 'Write proposed file?' } }, 'turn', f.reply);
      expect(f.opened().card.approval).toMatchObject({ title: 'Edit files', question: 'Do you want to make these edits?' });
      expect((answer === 'esc' ? f.escape() : f.answer({ picks: [answer] })).ok).toBe(true);
      await flush();
      expect(f.replies).toEqual([{ id: 11, result: { decision } }]);
      _resetCardCorrelatorForTests();
    }
  });

  it('maps a Codex question back to its native question id', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 12, method: 'item/tool/requestUserInput', params: {
      questions: [{ id: 'destination', question: 'Where should it go?', options: [{ label: 'Here' }, { label: 'There' }] }],
    } }, 'turn', f.reply);
    f.answer({ picks: ['1'] }); await flush();
    expect(f.replies).toEqual([{ id: 12, result: { answers: { destination: { answers: ['There'] } } } }]);
  });

  it('returns OMP text input and confirmation through native RPC', async () => {
    const f = fixture();
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'input', method: 'input', title: 'File name?' }, 'turn', f.reply);
    f.answer({ value: 'notes.txt' }); await flush();
    expect(f.replies).toEqual([{ type: 'extension_ui_response', id: 'input', value: 'notes.txt' }]);
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'confirm', method: 'confirm', title: 'Proceed?' }, 'turn', f.reply);
    f.answer({ picks: ['0'] }); await flush();
    expect(f.replies[1]).toEqual({ type: 'extension_ui_response', id: 'confirm', confirmed: true });
  });

  it('preserves an explicitly empty OMP editor value', async () => {
    const f = fixture();
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'editor', method: 'editor', title: 'Edit text' }, 'turn', f.reply);
    expect(f.answer({ value: '' }).ok).toBe(true);
    await flush();
    expect(f.replies).toEqual([{ type: 'extension_ui_response', id: 'editor', value: '' }]);
  });

  it('cancels a pending approval on interrupt without opening later questions', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 13, method: 'item/commandExecution/requestApproval', params: {} }, 'turn', f.reply);
    f.cards.cancel(); await flush();
    expect(f.replies).toEqual([{ id: 13, result: { decision: 'cancel' } }]);
    expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'closed', resolution: 'cancelled' });
  });

  it('accepts Claude multiple selections and custom text through validated cards', async () => {
    const f = fixture();
    const pending = f.cards.handleClaude('AskUserQuestion', { questions: [{ question: 'Which features?', multiSelect: true,
      options: [{ label: 'Search' }, { label: 'Export' }] }] }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'question', requestId: 'request',
    });
    expect(f.answer({ picks: ['0', '0'] }).ok).toBe(false);
    expect(f.answer({ picks: ['0', '2'] }).ok).toBe(true);
    await flush();
    expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'opened', card: { presentation: { kind: 'text' } } });
    expect(f.answer({ value: 'Offline' }).ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Which features?': 'Search, Offline' } } });
  });

  it('answers a wrapped Claude native question as a choice card instead of a generic MCP permission', async () => {
    const f = fixture();
    const pending = f.cards.handleClaude('mcp__papercusp-su__tools_invoke', {
      name: 'AskUserQuestion', args: { questions: [{ question: 'Keep or change?', multiSelect: false,
        options: [{ label: 'Keep' }, { label: 'Change' }] }] },
    }, 'turn', { signal: new AbortController().signal, toolUseID: 'wrapped-question', requestId: 'wrapped-request' });
    expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'opened',
      card: { prompt: 'Keep or change?', presentation: { kind: 'radio' } } });
    expect(openedChoiceLabels(f.events)).toEqual(['Keep', 'Change', 'Type a different answer']);
    expect(f.answer({ picks: ['1'] }).ok).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny',
      message: expect.stringContaining('"Keep or change?":"Change"') });
    expect(f.events.filter((event) => event.type === 'card' && event.phase === 'opened')).toHaveLength(1);
  });

  // P-014: Esc on a question card is a skip. The model must be told so in
  // words that are neither an error nor an invitation to ask again.
  it('tells Claude a skipped question is a skip, not a failure (native and wrapped)', async () => {
    for (const [toolName, input] of [
      ['AskUserQuestion', { questions: [{ question: 'What next?', options: [{ label: 'Tests' }] }] }],
      ['mcp__papercusp-su__tools_invoke', { name: 'AskUserQuestion',
        args: { questions: [{ question: 'What next?', options: [{ label: 'Tests' }] }] } }],
    ] as const) {
      const f = fixture();
      const pending = f.cards.handleClaude(toolName, input, 'turn', {
        signal: new AbortController().signal, toolUseID: `skip-${toolName}`, requestId: 'skip-request' });
      const opened = f.events.at(-1);
      if (opened?.type !== 'card' || opened.phase !== 'opened') throw new Error('No question card');
      expect(resolveCardResponse({ correlationId: opened.card.correlationId, action: 'decline',
        expectedWorkspaceId: 'workspace' }).ok).toBe(true);
      const result = await pending;
      expect(result).toEqual({ behavior: 'deny', message: SKIPPED_QUESTION_MESSAGE });
      expect(f.events.at(-1)).toMatchObject({ type: 'card', phase: 'closed', resolution: 'declined' });
      _resetCardCorrelatorForTests();
    }
    // It may say what a skip is NOT ("not an error"); it must not carry the
    // failure wording P-005 showed the owner.
    expect(SKIPPED_QUESTION_MESSAGE).not.toMatch(/fail|declined or cancelled/i);
    expect(SKIPPED_QUESTION_MESSAGE).toMatch(/not an error/);
  });

  it('keeps the interrupt denial distinct from a skip', async () => {
    const f = fixture(); const aborted = new AbortController();
    const pending = f.cards.handleClaude('AskUserQuestion', { questions: [{ question: 'Still there?',
      options: [{ label: 'Yes' }] }] }, 'turn', { signal: aborted.signal, toolUseID: 'interrupted', requestId: 'r' });
    aborted.abort();
    const result = await pending;
    expect(result).toMatchObject({ behavior: 'deny' });
    expect(result).not.toMatchObject({ message: SKIPPED_QUESTION_MESSAGE });
  });

  it('cancels only the aborted Claude request and leaves a concurrent permission answerable', async () => {
    const f = fixture(); const aborted = new AbortController();
    const first = f.cards.handleClaude('Bash', { command: 'first' }, 'turn', {
      signal: aborted.signal, toolUseID: 'first', requestId: 'first-request',
    });
    const second = f.cards.handleClaude('Bash', { command: 'second' }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'second', requestId: 'second-request',
    });
    const secondCard = f.events.at(-1);
    if (secondCard?.type !== 'card' || secondCard.phase !== 'opened') throw new Error('No second permission card');
    aborted.abort();
    await expect(first).resolves.toMatchObject({ behavior: 'deny' });
    expect(resolveCardResponse({ correlationId: secondCard.card.correlationId, action: 'submit', payload: { picks: ['yes'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(true);
    await expect(second).resolves.toMatchObject({ behavior: 'allow', updatedInput: { command: 'second' } });
  });

  it('offers Claude\'s remembered permission as a labelled session-only choice', async () => {
    const f = fixture();
    const toolName = 'mcp__papercusp-su__orders_disposition';
    const pending = f.cards.handleClaude(toolName, { id: 282 }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'remember', requestId: 'remember-request',
      suggestions: [
        { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'localSettings' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    });
    // P-008: the remembered choice names the tool the way the card does, never the raw MCP id.
    expect(openedChoiceLabels(f.events)).toEqual(['Yes',
      "Yes, and don't ask again for papercusp-su · orders disposition (MCP) this session",
      'No, and tell Claude what to do instead']);
    expect(f.answer({ picks: ['always'] }).ok).toBe(true);
    // Never a settings-file write, and never a mode change the card did not name.
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { id: 282 },
      updatedPermissions: [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }] });
  });

  it('keeps the plain Yes / No card when Claude offers nothing to remember', async () => {
    const f = fixture();
    const pending = f.cards.handleClaude('Bash', { command: 'ls' }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'plain', requestId: 'plain-request',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' }],
    });
    expect(openedChoiceLabels(f.events)).toEqual(['Yes', 'No, and tell Claude what to do instead']);
    expect(f.answer({ picks: ['yes'] }).ok).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('stops Claude\'s turn on No and on Esc, saying nothing was run', async () => {
    for (const how of ['no', 'esc'] as const) {
      const f = fixture();
      const pending = f.cards.handleClaude('Bash', { command: 'rm -rf build' }, 'turn', {
        signal: new AbortController().signal, toolUseID: `deny-${how}`, requestId: 'deny-request' });
      expect((how === 'esc' ? f.escape() : f.answer({ picks: ['no'] })).ok).toBe(true);
      await expect(pending).resolves.toEqual({ behavior: 'deny', message: REJECTED_TOOL_MESSAGE, interrupt: true });
      _resetCardCorrelatorForTests();
    }
  });

  it('draws an edit as Claude Code does: title row, the diff once, then the question', () => {
    const f = fixture({ cwd: '/tmp/proj' });
    void f.cards.handleClaude('Edit', { file_path: '/tmp/proj/calc.js', old_string: 'a - b', new_string: 'a + b' }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'edit', requestId: 'edit-request',
      // Claude's description of an edit is often only the path: never a stray line under the diff.
      description: '/tmp/proj/calc.js' });
    const approval = f.opened().card.approval;
    expect(approval).toMatchObject({ title: 'Update(calc.js)', question: 'Do you want to make this edit to calc.js?' });
    expect(approval?.body.join('\n')).toContain('a + b');
    expect(approval?.body.filter((line) => /calc\.js/.test(line))).toEqual([]);
  });

  it('offers "allow all edits this session" for an edit and reports the auto-edit switch', async () => {
    const switched: string[] = [];
    const f = fixture({ approvalsChanged: (mode) => switched.push(mode) });
    const pending = f.cards.handleClaude('Edit', { file_path: 'calc.js', old_string: 'a', new_string: 'b' }, 'turn', {
      signal: new AbortController().signal, toolUseID: 'accept-edits', requestId: 'accept-edits-request',
      suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    expect(openedChoiceLabels(f.events)).toEqual(['Yes', 'Yes, and allow all edits this session',
      'No, and tell Claude what to do instead']);
    expect(f.answer({ picks: ['always'] }).ok).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { file_path: 'calc.js', old_string: 'a', new_string: 'b' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] });
    expect(switched).toEqual(['auto-edit']);
  });

  it('asks an OMP tool approval with the same three answers and remembers option 2 for this runtime', async () => {
    const stops: number[] = [];
    const f = fixture({ stopTurn: () => stops.push(1) });
    const request = (id: string, title = 'Allow tool: edit\nFile: calc.js') =>
      f.cards.handle('omp', { type: 'extension_ui_request', id, method: 'select', title, options: ['Approve', 'Deny'] }, 'turn', f.reply);
    expect(request('first')).toBe(true);
    expect(openedChoiceLabels(f.events)).toEqual(['Yes', "Yes, and don't ask again for Update this session",
      'No, and tell OMP what to do instead']);
    expect(f.opened().card.approval).toMatchObject({ title: 'Update(calc.js)', question: 'Do you want to make this edit to calc.js?' });
    f.answer({ picks: ['always'] }); await flush();
    expect(f.replies).toEqual([{ type: 'extension_ui_response', id: 'first', value: 'Approve' }]);
    // Remembered: the next edit is approved without a card.
    const cardsBefore = f.events.length;
    expect(request('second', 'Allow tool: edit\nFile: other.js')).toBe(true);
    expect(f.events.length).toBe(cardsBefore);
    expect(f.replies.at(-1)).toEqual({ type: 'extension_ui_response', id: 'second', value: 'Approve' });
    expect(stops).toEqual([]);
    // A command is remembered only for the exact same request, and No stops the turn.
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'cmd', method: 'select',
      title: 'Allow tool: bash\nCommand: rm -rf build', options: ['Approve', 'Deny'] }, 'turn', f.reply);
    expect(f.opened().card.approval).toEqual({ title: 'Bash(rm -rf build)', question: 'Do you want to run this command?',
      body: ['Command: rm -rf build'] });
    f.answer({ picks: ['no'] }); await flush();
    expect(f.replies.at(-1)).toEqual({ type: 'extension_ui_response', id: 'cmd', value: 'Deny' });
    expect(stops).toEqual([1]);
  });

  it('leaves an OMP select that is not a tool approval as an ordinary choice', async () => {
    const f = fixture();
    f.cards.handle('omp', { type: 'extension_ui_request', id: 'pick', method: 'select', title: 'Pick a branch',
      options: ['main', 'dev'] }, 'turn', f.reply);
    expect(openedChoiceLabels(f.events)).toEqual(['main', 'dev']);
    expect(f.opened().card.approval).toBeUndefined();
    f.answer({ picks: ['1'] }); await flush();
    expect(f.replies).toEqual([{ type: 'extension_ui_response', id: 'pick', value: 'dev' }]);
  });
});
