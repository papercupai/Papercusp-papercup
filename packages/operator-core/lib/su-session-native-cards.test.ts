import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetCardCorrelatorForTests, readPrivateCardLink, resolveCardResponse } from '@papercusp/agent-mcp';
import { REJECTED_TOOL_MESSAGE, SKIPPED_QUESTION_MESSAGE, SuNativeCards, type SuNativeCardsOptions } from './su-session-native-cards';
import type { SuSessionEventInput } from './su-session-host';
import type { RpcFrame } from './su-session-stdio-peer';
import { nativeFormFields } from './su-session-native-form';

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
  it('never replays a settled private Claude answer after turn cancellation', async () => {
    const f = fixture(), request = { serverName: 'example', mode: 'form' as const, message: '', requestedSchema: {
      type: 'object' as const, properties: { apiKey: { type: 'string' as const } }, required: ['apiKey'] } };
    const options = { requestId: 'secret-repeat', signal: new AbortController().signal };
    const pending = f.cards.handleClaudeElicitation(request as never, 'turn', options);
    f.answer({ value: 'private-no-replay' });
    expect(await pending).toMatchObject({ action: 'accept', content: { apiKey: 'private-no-replay' } });
    f.cards.cancel();
    expect(await f.cards.handleClaudeElicitation(request as never, 'turn', options)).toEqual({ action: 'cancel' });
    expect(f.events.filter(event => event.type === 'card' && event.phase === 'opened')).toHaveLength(1);
  });

  it.each(['claude', 'codex'] as const)('preserves valid empty %s form values and explicit optional omission', async provider => {
    const f = fixture(), request = { mode: 'form' as const, serverName: 'example', message: '', requestedSchema: {
      type: 'object' as const, properties: { text: { type: 'string' }, roles: { type: 'array', items: { enum: ['read'] }, maxItems: 0 },
        omitted: { type: 'string' } }, required: ['text', 'roles'],
    } };
    const pending = provider === 'claude' ? f.cards.handleClaudeElicitation(request as never, 'turn', {
      signal: new AbortController().signal, requestId: 'empty',
    }) : (f.cards.handle('codex', { id: 'empty', method: 'mcpServer/elicitation/request', params: request }, 'turn', f.reply), undefined);
    expect(f.opened().card.presentation).toMatchObject({ kind: 'text', allowEmpty: true });
    expect(f.answer({ value: '' }).ok).toBe(true); await flush();
    expect(f.opened().card.presentation).toMatchObject({ kind: 'checkbox', allowEmpty: true });
    expect(f.answer({ picks: ['0'] }).ok).toBe(false);
    expect(f.answer({ picks: [] }).ok).toBe(true); await flush();
    expect(f.answer({ picks: ['no'] }).ok).toBe(true); await flush();
    const expected = { action: 'accept', content: { text: '', roles: [] } };
    if (pending) expect(await pending).toEqual(expected);
    else expect(f.replies).toEqual([{ id: 'empty', result: { ...expected, _meta: null } }]);
  });

  it.each([
    { type: 'number', enum: ['one'] }, { type: 'boolean', minLength: 2 },
    { type: 'string', minimum: 3 }, { type: 'array', items: { enum: ['one'] }, minItems: 2, maxItems: 1 },
    { type: 'string', enum: ['one'], oneOf: [{ const: 'two' }] }, { type: 'string', enumNames: ['One'] },
  ])('refuses unsupported or contradictory form constraints before asking (%j)', field => {
    expect(() => nativeFormFields({ type: 'object', properties: { answer: field } })).toThrow();
  });

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

  it.each(['execCommandApproval', 'applyPatchApproval'])('preserves legacy %s scope without persistent-policy choices', async method => {
    const f = fixture();
    f.cards.handle('codex', { id: method, method, params: { command: ['printf', 'hello'],
      fileChanges: { '/project/file': { type: 'add', content: 'new content' } }, grantRoot: '/project',
    } }, 'turn', f.reply);
    expect(openedChoiceLabels(f.events)).toEqual(['Yes', 'No, and tell Codex what to do instead']);
    expect(f.answer({ picks: ['always'] }).ok).toBe(false);
    f.answer({ picks: ['yes'] }); await flush();
    expect(f.replies).toEqual([{ id: method, result: { decision: 'approved' } }]);
  });

  it('offers only native-approved command decisions and displays added permission scope', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 'restricted', method: 'item/commandExecution/requestApproval', params: {
      command: 'fetch', availableDecisions: ['accept', 'decline'],
      networkApprovalContext: { host: 'example.org', protocol: 'https' },
      additionalPermissions: { fileSystem: { read: ['/project/docs'] } },
    } }, 'turn', f.reply);
    expect(openedChoiceLabels(f.events)).toHaveLength(2);
    expect(f.opened().card.prompt).toContain('example.org');
    expect(f.opened().card.prompt).toContain('/project/docs');
    expect(f.answer({ picks: ['always'] }).ok).toBe(false);
    f.escape(); await flush();
    expect(f.replies).toEqual([{ id: 'restricted', result: { decision: 'decline' } }]);
  });

  it.each(['yes', 'always', 'no', 'esc'] as const)('grants only the requested scoped permissions on %s', async answer => {
    const f = fixture(), permissions = { network: { enabled: true }, fileSystem: { read: ['/project/docs'], write: null,
      entries: [{ path: { type: 'path', path: '/project/output' }, access: 'write' }] } };
    f.cards.handle('codex', { id: 30, method: 'item/permissions/requestApproval', params: { permissions, reason: 'Fetch docs' } }, 'turn', f.reply);
    expect(f.opened().card.prompt).toContain('/project/output');
    expect((answer === 'esc' ? f.escape() : f.answer({ picks: [answer] })).ok).toBe(true);
    await flush();
    expect(f.replies).toEqual([{ id: 30, result: { permissions: answer === 'yes' || answer === 'always' ? permissions : {},
      scope: answer === 'always' ? 'session' : 'turn' } }]);
  });

  it('keeps native question descriptions, multiple choices and a custom answer', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 31, method: 'item/tool/requestUserInput', params: { questions: [
      { id: 'features', question: 'Which features?', isOther: true, multiSelect: true,
        options: [{ label: 'Search', description: 'Search saved documents' }, { label: 'Export' }] },
    ] } }, 'turn', f.reply);
    expect(f.opened().card.presentation).toMatchObject({ kind: 'checkbox', options: [{ hint: 'Search saved documents' }, {}, {}] });
    f.answer({ picks: ['0', '2'] }); await flush();
    f.answer({ value: 'Print' }); await flush();
    expect(f.replies).toEqual([{ id: 31, result: { answers: { features: { answers: ['Search', 'Print'] } } } }]);
  });

  it.each([undefined, [], [{ id: 'same', question: 'One?' }, { id: 'same', question: 'Two?' }],
    [{ id: 'valid', question: 'One?' }, { id: 'bad', question: '' }]])('refuses invalid question sets before any card opens: %j', async questions => {
    const f = fixture();
    f.cards.handle('codex', { id: 32, method: 'item/tool/requestUserInput', params: { questions } }, 'turn', f.reply);
    await flush();
    expect(f.events.some(event => event.type === 'card')).toBe(false);
    expect(f.replies).toEqual([{ id: 32, error: { code: -32602, message: expect.any(String) } }]);
  });

  it('opens a native request once and refuses identity reuse with different content', async () => {
    const f = fixture(), request = { id: 33, method: 'item/commandExecution/requestApproval', params: { command: 'pwd' } };
    f.cards.handle('codex', request, 'turn', f.reply);
    f.cards.handle('codex', request, 'turn', f.reply);
    expect(f.events.filter(event => event.type === 'card' && event.phase === 'opened')).toHaveLength(1);
    f.cards.handle('codex', { ...request, params: { command: 'other-command' } }, 'turn', f.reply);
    expect(f.replies[0]).toMatchObject({ id: 33, error: { code: -32602 } });
    f.answer({ picks: ['yes'] }); await flush();
    expect(f.replies).toHaveLength(1);
    f.cards.handle('codex', request, 'turn', f.reply);
    expect(f.replies).toHaveLength(1);
  });

  it('returns a secret answer only through the native response, never ordinary card events', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 'private', method: 'item/tool/requestUserInput', params: {
      questions: [{ id: 'credential', question: 'Enter credential', isSecret: true }],
    } }, 'turn', f.reply);
    expect(f.opened().card.presentation).toMatchObject({ kind: 'text', sensitive: true });
    f.answer({ value: 'private-value-for-native-only' }); await flush();
    expect(f.replies).toEqual([{ id: 'private', result: { answers: { credential: { answers: ['private-value-for-native-only'] } } } }]);
    expect(JSON.stringify(f.events)).not.toContain('private-value-for-native-only');
  });

  it.each(['claude', 'codex'] as const)('validates an entire %s form, preserving typed and private answers', async provider => {
    const f = fixture(), request = { mode: 'form' as const, serverName: 'example', message: 'Details', requestedSchema: {
      type: 'object', properties: { count: { type: 'integer', minimum: 2, maximum: 4 },
        roles: { type: 'array', items: { anyOf: [{ const: 'read', title: 'Reader' }, { const: 'write', title: 'Writer' }] }, minItems: 1 },
        apiKey: { type: 'string', writeOnly: true, minLength: 8, default: 'never-display-default' } }, required: ['count', 'roles', 'apiKey'],
    } };
    const pending = provider === 'claude' ? f.cards.handleClaudeElicitation(request, 'turn', {
      signal: new AbortController().signal, requestId: 'form',
    }) : (f.cards.handle('codex', { id: 'form', method: 'mcpServer/elicitation/request', params: request }, 'turn', f.reply), undefined);
    expect(f.answer({ value: '1' }).ok).toBe(false);
    expect(f.answer({ value: '2.5' }).ok).toBe(false);
    expect(f.answer({ value: '3' }, 'foreign').ok).toBe(false);
    f.answer({ value: '3' }); await flush();
    expect(f.opened().card.presentation).toMatchObject({ kind: 'checkbox' });
    f.answer({ picks: ['0', '1'] }); await flush();
    expect(f.opened().card.presentation).toMatchObject({ kind: 'text', sensitive: true });
    expect(f.answer({ value: 'short' }).ok).toBe(false);
    f.answer({ value: 'private-form-value' }); await flush();
    const result = { action: 'accept', content: { count: 3, roles: ['read', 'write'], apiKey: 'private-form-value' } };
    if (pending) await expect(pending).resolves.toEqual(result);
    else expect(f.replies).toEqual([{ id: 'form', result: { ...result, _meta: null } }]);
    expect(JSON.stringify(f.events)).not.toMatch(/private-form-value|never-display-default/);
  });

  it.each(['decline', 'cancel'] as const)('preserves %s without partial form content', async action => {
    const f = fixture(), abort = new AbortController();
    const pending = f.cards.handleClaudeElicitation({ mode: 'form', serverName: 'example', message: '', requestedSchema: {
      type: 'object', properties: { first: { type: 'string' }, second: { type: 'boolean' } }, required: ['first', 'second'],
    } }, 'turn', { signal: abort.signal, requestId: action });
    f.answer({ value: 'partial' }); await flush();
    if (action === 'decline') f.escape(); else abort.abort();
    await expect(pending).resolves.toEqual({ action });
    expect(f.answer({ picks: ['0'] }).ok).toBe(false);
  });

  it('refuses an unsupported later form schema before publishing any field', async () => {
    const f = fixture();
    await expect(f.cards.handleClaudeElicitation({ serverName: 'example', message: '', requestedSchema: {
      type: 'object', properties: { first: { type: 'string' }, unsupported: { type: 'object', secret: 'DO_NOT_LOG' } },
    } }, 'turn', { signal: new AbortController().signal, requestId: 'unsupported' })).resolves.toEqual({ action: 'cancel' });
    expect(f.events.some(event => event.type === 'card')).toBe(false);
    expect(JSON.stringify(f.events)).not.toContain('DO_NOT_LOG');
  });

  it.each(['claude', 'codex'] as const)('keeps %s authentication URLs private and revokes the link on settlement', async provider => {
    const f = fixture(), url = 'https://auth.example/path/PRIVATE-PATH?code=PRIVATE-CODE#PRIVATE-FRAGMENT';
    const request = { serverName: 'example', mode: 'url' as const, url, elicitationId: 'auth-native', message: `Visit ${url}` };
    const pending = provider === 'claude' ? f.cards.handleClaudeElicitation(request, 'turn', {
      signal: new AbortController().signal, requestId: 'auth',
    }) : (f.cards.handle('codex', { id: 'auth', method: 'mcpServer/elicitation/request', params: request }, 'turn', f.reply), undefined);
    const card = f.opened().card;
    expect(card.presentation?.link).toBe(`/api/ui/cards/${card.correlationId}/link`);
    expect(readPrivateCardLink(card.correlationId, 'foreign')).toBeNull();
    expect(readPrivateCardLink(card.correlationId, 'workspace')).toBe(url);
    expect(JSON.stringify(f.events)).not.toMatch(/PRIVATE-PATH|PRIVATE-CODE|PRIVATE-FRAGMENT/);
    f.answer({ picks: ['continue'] }); await flush();
    if (pending) await expect(pending).resolves.toEqual({ action: 'accept' });
    else expect(f.replies).toEqual([{ id: 'auth', result: { action: 'accept', content: null, _meta: null } }]);
    expect(readPrivateCardLink(card.correlationId, 'workspace')).toBeNull();
  });

  it('cancels old-generation forms and authentication links before a replacement runtime asks', async () => {
    const old = fixture();
    const pending = old.cards.handleClaudeElicitation({ serverName: 'server', mode: 'url',
      url: 'https://auth.example/?token=PRIVATE', elicitationId: 'url-id', message: '' }, 'turn', {
      signal: new AbortController().signal, requestId: 'request-id',
    });
    const oldId = old.opened().card.correlationId;
    old.cards.cancel(); await expect(pending).resolves.toEqual({ action: 'cancel' });
    const replacement = fixture();
    replacement.cards.handle('codex', { id: 'request-id', method: 'item/permissions/requestApproval', params: {
      permissions: { network: { enabled: true } },
    } }, 'new-turn', replacement.reply);
    expect(resolveCardResponse({ correlationId: oldId, action: 'submit', payload: { picks: ['continue'] }, expectedWorkspaceId: 'workspace' }).ok).toBe(false);
    expect(readPrivateCardLink(oldId, 'workspace')).toBeNull();
    expect(replacement.replies).toEqual([]);
    replacement.answer({ picks: ['no'] }); await flush();
    expect(replacement.replies[0]).toMatchObject({ result: { permissions: {}, scope: 'turn' } });
  });

  it('coalesces matching Claude request IDs and cancels conflicting replacements', async () => {
    const f = fixture(), options = { signal: new AbortController().signal, toolUseID: 'tool-id', requestId: 'same-id' };
    const first = f.cards.handleClaude('Bash', { command: 'pwd' }, 'turn', options);
    const duplicate = f.cards.handleClaude('Bash', { command: 'pwd' }, 'turn', options);
    expect(duplicate).toBe(first);
    expect(f.events.filter(event => event.type === 'card' && event.phase === 'opened')).toHaveLength(1);
    const conflicting = f.cards.handleClaude('Bash', { command: 'rm' }, 'turn', options);
    await expect(conflicting).resolves.toMatchObject({ behavior: 'deny' });
    await expect(first).resolves.toMatchObject({ behavior: 'deny' });
    expect(f.answer({ picks: ['yes'] }).ok).toBe(false);
  });

  it('expires a private URL flow and removes its redirect capability', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ requestTimeoutMs: 10 });
      const pending = f.cards.handleClaudeElicitation({ serverName: 'example', mode: 'url',
        url: 'https://auth.example/?code=PRIVATE', elicitationId: 'auth', message: '' }, 'turn', {
        signal: new AbortController().signal, requestId: 'expiring-url',
      });
      const id = f.opened().card.correlationId;
      await vi.advanceTimersByTimeAsync(11);
      await expect(pending).resolves.toEqual({ action: 'cancel' });
      expect(readPrivateCardLink(id, 'workspace')).toBeNull();
      expect(f.answer({ picks: ['continue'] }).ok).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('does not return partial answers when a later question is cancelled', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 34, method: 'item/tool/requestUserInput', params: { questions: [
      { id: 'first', question: 'First?' }, { id: 'second', question: 'Second?' },
    ] } }, 'turn', f.reply);
    f.answer({ value: 'first answer' }); await flush();
    f.escape(); await flush();
    expect(f.replies).toEqual([{ id: 34, result: { answers: {} } }]);
  });

  it('expires unanswered permissions and refuses a late answer', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ requestTimeoutMs: 10 });
      f.cards.handle('codex', { id: 35, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } }, 'turn', f.reply);
      await vi.advanceTimersByTimeAsync(11);
      expect(f.replies).toEqual([{ id: 35, result: { permissions: {}, scope: 'turn' } }]);
      expect(f.answer({ picks: ['yes'] }).ok).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('cancels an already submitted permission before its continuation grants it', async () => {
    const f = fixture();
    f.cards.handle('codex', { id: 36, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } }, 'turn', f.reply);
    f.answer({ picks: ['yes'] }); f.cards.cancel(); await flush();
    expect(f.replies).toEqual([{ id: 36, result: { permissions: {}, scope: 'turn' } }]);
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
    await expect(pending).resolves.toMatchObject({ message: expect.stringContaining('source is not established') });
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
