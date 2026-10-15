import { describe, expect, it } from 'vitest';
import {
  CODEX_GREETING_EXPECTATION,
  codexHomeControlSocketPath,
  codexHomeFitsControlSocket,
  codexStartupAction,
  codexTaskCompleted,
  isCodexPromptReady,
  RESUME_RECALL_EXPECTATION,
  taskAnsweredAfterPrompt,
  p005PuiLaunchArgs,
  preflightStockCliArgs,
  reviewBlockingReason,
  TEST_RUN_EXPECTATION,
} from './p005-codex-readiness.js';

describe('P-005 review preflight', () => {
  it('checks the installed parser with the exact launch arguments and refuses rejected policies', () => {
    const calls: string[][] = [];
    const check = (cli: string, args: string[]) => {
      calls.push([cli, ...args]);
      if (args.includes('untrusted')) throw { stderr: "invalid value 'untrusted'; possible values: on-request, never" };
    };
    expect(() => preflightStockCliArgs('codex', ['-a', 'untrusted'], check)).toThrow(/before startup.*on-request, never/);
    expect(calls).toEqual([['codex', '-a', 'untrusted', '--help']]);
    expect(() => preflightStockCliArgs('codex', ['-a', 'on-request'], check)).not.toThrow();
    expect(() => preflightStockCliArgs('claude', ['--permission-mode', 'default'], check)).not.toThrow();
  });

  it('applies explicit model and account choices to both launch and resume without inventing defaults', () => {
    expect(p005PuiLaunchArgs({})).toEqual(['--solo']);
    expect(p005PuiLaunchArgs({ model: 'sonnet', account: 'auto' }))
      .toEqual(['--solo', '--model', 'sonnet', '--account', 'auto']);
    expect(p005PuiLaunchArgs({ account: 'default' })).toEqual(['--solo', '--account', 'default']);
  });

  it('stops on provider and connection walls rather than treating the idle composer as task completion', () => {
    expect(reviewBlockingReason("❯ hi\nYou've hit your weekly limit · resets Oct 13\n❯"))
      .toBe('provider usage limit');
    expect(reviewBlockingReason('API Error 429: rate_limit_error')).toBe('provider authentication or request refusal');
    expect(reviewBlockingReason('Connection: Unavailable')).toBe('connection or model unavailable');
    expect(reviewBlockingReason('❯ hi\n● Hi! What can I help you with?\n❯')).toBeNull();
  });

  it('recognizes actual stock test-result wording only after the run-tests prompt', () => {
    const prompt = 'Run the tests with npm test and tell me whether they pass.';
    for (const reply of ['All tests pass. npm test ran 2 tests, with 2 passing and 0 failing.',
      'npm test passed: 1 test passed, 0 failed.', '# pass 2\n# fail 0',
      'The tests pass. npm test runs node --test, which ran 2 tests (add and mul). Both passed, with 0 failures.',
      'Both tests passed, with 0 failures.']) {
      expect(taskAnsweredAfterPrompt(`❯ ${prompt}\n● ${reply}`, prompt, TEST_RUN_EXPECTATION)).toBe(true);
      expect(taskAnsweredAfterPrompt(`● ${reply}\n❯ ${prompt}\n✶ Thinking…`, prompt, TEST_RUN_EXPECTATION)).toBe(false);
    }
    expect(taskAnsweredAfterPrompt(`❯ ${prompt}\n● Tests failed: 0 passing.`, prompt, TEST_RUN_EXPECTATION)).toBe(false);
  });

  it('recognizes a stock greeting after the prompt while rejecting an echo or an earlier reply', () => {
    for (const reply of ['Hi! What are you working on? Tell me what you would like to do in this project.',
      'Hello! How can I help?', 'Hey, what would you like to work on?']) {
      expect(taskAnsweredAfterPrompt(`❯ hi\n● ${reply}\n❯`, 'hi', CODEX_GREETING_EXPECTATION)).toBe(true);
      expect(taskAnsweredAfterPrompt(`● ${reply}\n❯ hi\n✶ Thinking…`, 'hi', CODEX_GREETING_EXPECTATION)).toBe(false);
    }
    expect(taskAnsweredAfterPrompt('❯ hi\n❯', 'hi', CODEX_GREETING_EXPECTATION)).toBe(false);
    expect(taskAnsweredAfterPrompt('❯ hi\n✶ Thinking…', 'hi', CODEX_GREETING_EXPECTATION)).toBe(false);
  });
});

describe('P-005 Codex TUI readiness', () => {
  it('keeps the isolated CODEX_HOME control socket below the Unix path limit', () => {
    const shortHome = '/tmp/p5c-a1b2c3';
    expect(codexHomeFitsControlSocket(shortHome)).toBe(true);
    expect(codexHomeControlSocketPath(shortHome)).toBe('/tmp/p5c-a1b2c3/app-server-control/app-server-control.sock');
    expect(codexHomeFitsControlSocket(`/tmp/${'long-path-segment-'.repeat(8)}`)).toBe(false);
  });

  it('does not mistake daemon installation or the empty command center for a ready prompt', () => {
    expect(isCodexPromptReady('Installing daemon from CLI version 0.157.1...')).toBe(false);
    expect(isCodexPromptReady('model: loading\ndirectory: loading\n› Ask Codex to do anything')).toBe(false);
    const commandCenter = 'Agent command center  Group: Project\nNo tasks yet\n? help  esc back  n new';
    expect(isCodexPromptReady(commandCenter)).toBe(false);
    expect(codexStartupAction(commandCenter, true)).toEqual({ kind: 'create-first-task', keys: 'n' });
    expect(codexStartupAction(commandCenter, false)).toBeNull();
  });

  it('answers the first-run trust prompt and skips only the update dialog', () => {
    expect(codexStartupAction('Trust this folder?\n1. Trust and continue', true))
      .toEqual({ kind: 'trust-folder', keys: '\r' });
    expect(codexStartupAction('Update available\nSkip', true))
      .toEqual({ kind: 'skip-update', keys: '\x1b[B\r' });
    expect(codexStartupAction('Update available! 0.157.1 -> 0.159.3', true)).toBeNull();
    expect(isCodexPromptReady('model: GPT-6-Astra\ndirectory: /tmp/p005\n› Ask Codex to do anything')).toBe(true);
  });

  it('counts a task only when its prompt, expected answer, and idle composer are visible', () => {
    const completed = 'The prompt is yours.\n› hi\n• Hi! What can I help you with?\n› Ask Codex to do anything';
    const alternateGreeting = '› hi\n• Hi! What would you like to work on?\n› Ask Codex to do anything';
    expect(codexTaskCompleted(completed, 'hi', CODEX_GREETING_EXPECTATION)).toBe(true);
    expect(codexTaskCompleted(alternateGreeting, 'hi', CODEX_GREETING_EXPECTATION)).toBe(true);
    expect(codexTaskCompleted('› Ask Codex to do anything', 'hi', CODEX_GREETING_EXPECTATION)).toBe(false);
    expect(codexTaskCompleted('Agent command center\nNo tasks yet\nn new', 'hi', /what can I help you with/i)).toBe(false);
  });

  it('matches the expected answer only after the echoed prompt, never in earlier transcript text', () => {
    const recall = 'What change did we make to calc.js earlier in this conversation? One sentence.';
    const expected = RESUME_RECALL_EXPECTATION;
    const earlier = '❯ Edit calc.js so that add() accepts an optional third number and adds it too.\n● Done.\n';
    // The P-022 false pass: the words sit in an EARLIER prompt and nothing answered the recall.
    expect(taskAnsweredAfterPrompt(`${earlier}┌ Conversation ┐\n│ Loading earlier conversations… │\n> Message Claude`, recall, expected)).toBe(false);
    expect(taskAnsweredAfterPrompt(`${earlier}❯ ${recall}\n✶ Thinking…`, recall, expected)).toBe(false);
    expect(taskAnsweredAfterPrompt(`${earlier}❯ ${recall}\n● We changed add to add(a, b, c = 0).`, recall, expected)).toBe(true);
    // P-032 false negative: stock Claude Code 2.1.289 answered correctly in this wording.
    expect(taskAnsweredAfterPrompt(
      `${earlier}❯ ${recall}\n● We changed add to accept an optional third argument c (default 0), so it now returns a + b + c.`,
      recall,
      expected,
    )).toBe(true);
    expect(taskAnsweredAfterPrompt(`${earlier}❯ ${recall}\n● It now takes a third parameter.`, recall, expected)).toBe(true);
    // P-032: stock Codex 0.160.1 dropped the "?" from its prompt echo and answered correctly.
    const codexRecallScreen = [
      '› Edit calc.js so that add() accepts an optional third number and adds it too.',
      '• Updated calc.js:1: add(a, b, c = 0) now adds all three numbers.',
      '› What change did we make to calc.js earlier in this conversation One sentence.',
      '• We changed add() to accept an optional third argument, defaulting to zero, and add it to the first two numbers.',
      '  Worked for 23s • 8:02 AM',
      '› Ask Codex to do anything',
      '  GPT-6.1-Sol default · /tmp/proj · Respond to greeting',
      '  ← for agents · ? for shortcuts',
    ].join('\n');
    expect(taskAnsweredAfterPrompt(codexRecallScreen, recall, expected)).toBe(true);
    // Only the dropped punctuation is forgiven: the earlier edit text still cannot answer it.
    expect(taskAnsweredAfterPrompt(codexRecallScreen.split('\n').slice(0, 3).join('\n'), recall, expected)).toBe(false);
    // A wrong recall must still fail.
    expect(taskAnsweredAfterPrompt(`${earlier}❯ ${recall}\n● We renamed mul to multiply.`, recall, expected)).toBe(false);
    // A short prompt is anchored on its input echo, so "Hi!" in the reply is not mistaken for it.
    expect(taskAnsweredAfterPrompt('❯ hi\n● Hi! What would you like to work on?', 'hi', CODEX_GREETING_EXPECTATION)).toBe(true);
    const codexEarlier = `› Edit calc.js so add takes an optional third number\n• Updated.\n› ${recall}\n› Ask Codex to do anything`;
    expect(codexTaskCompleted(codexEarlier, recall, expected)).toBe(false);
  });
});
