/**
 * Registry unit tests — covers the contracts that PR 1 ships and that
 * later PRs will rely on.
 *
 * Specifically:
 *   - Unknown command id → ok:false code:'unknown', not throw
 *   - Wrong agent       → ok:false code:'denied'
 *   - Bad args          → ok:false code:'invalid-args'
 *   - browser:'required' from non-browser ctx → 'no-active-session'
 *   - Handler throw → wrapped as code:'internal' (or CommandError payload)
 *   - Concurrent 'queue' serializes
 *   - Concurrent 'deny' rejects second caller with code:'conflict'
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  __resetRegistryForTests,
  register,
  runCommand,
  runQuery,
} from './registry';
import { CommandError, type CommandContext } from './types';

const ctx = (overrides: Partial<CommandContext> = {}): CommandContext => ({
  agent: 'operator',
  workspace: 'default',
  requestId: 'r1',
  ...overrides,
});

beforeEach(() => __resetRegistryForTests());
afterEach(() => vi.unstubAllGlobals());

describe('runCommand basics', () => {
  it('returns unknown for an unregistered id', async () => {
    const r = await runCommand('does.not.exist', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown');
  });

  it('returns denied for an agent not in the def', async () => {
    register({
      id: 'test.cmd',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'none',
      tier: 'reflexive',
      handler: () => ({ ok: 1 }),
    });
    const r = await runCommand('test.cmd', {}, ctx({ agent: 'pi' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('denied');
  });

  it('returns invalid-args on schema failure', async () => {
    register({
      id: 'test.cmd',
      kind: 'command',
      description: 'x',
      schema: z.object({ x: z.number() }),
      agents: ['operator'],
      browser: 'none',
      tier: 'reflexive',
      handler: () => ({}),
    });
    const r = await runCommand('test.cmd', { x: 'nope' }, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-args');
  });

  it('wraps thrown Error as code:internal', async () => {
    register({
      id: 'test.cmd',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'none',
      tier: 'reflexive',
      handler: () => { throw new Error('kaboom'); },
    });
    const r = await runCommand('test.cmd', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('internal');
  });

  it('passes CommandError payload through', async () => {
    register({
      id: 'test.cmd',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'none',
      tier: 'reflexive',
      handler: () => {
        throw new CommandError({
          code: 'special',
          message: 'specific failure',
          retryable: true,
        });
      },
    });
    const r = await runCommand('test.cmd', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('special');
      expect(r.error.retryable).toBe(true);
    }
  });

  it("returns ok:true on a clean handler", async () => {
    register({
      id: 'test.cmd',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'none',
      tier: 'reflexive',
      handler: () => ({ x: 1 }),
    });
    const r = await runCommand<{ x: number }>('test.cmd', {}, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.x).toBe(1);
  });
});

describe('browser-requirement gate', () => {
  it.each(['palette', 'shortcut'] as const)(
    'allows a local %s command before voice assigns a session ID',
    async (agent) => {
      vi.stubGlobal('window', { sessionStorage: { getItem: () => null } });
      const handler = vi.fn(() => ({ path: '/settings/shortcuts' }));
      register({
        id: 'nav.settings-shortcuts',
        kind: 'command',
        description: 'Open keyboard shortcuts',
        schema: z.object({}),
        agents: ['palette', 'shortcut'],
        browser: 'required',
        tier: 'reflexive',
        handler,
      });

      const result = await runCommand('nav.settings-shortcuts', {}, ctx({ agent }));
      expect(result).toEqual({ ok: true, value: { path: '/settings/shortcuts' } });
      expect(handler).toHaveBeenCalledOnce();
    },
  );

  it("rejects browser:'required' commands when ctx has no sessionId", async () => {
    register({
      id: 'panel.toggle',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'required',
      tier: 'reflexive',
      handler: () => ({ panel: 'operator', open: true }),
    });
    const r = await runCommand('panel.toggle', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('no-active-session');
      expect(r.error.retryable).toBe(true);
    }
  });

  it("allows browser:'required' when sessionId is set", async () => {
    register({
      id: 'panel.toggle',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'required',
      tier: 'reflexive',
      handler: () => ({ panel: 'operator', open: true }),
    });
    const r = await runCommand('panel.toggle', {}, ctx({ sessionId: 's1' }));
    expect(r.ok).toBe(true);
  });
});

describe("concurrency 'deny'", () => {
  it('rejects a second concurrent caller with code:conflict', async () => {
    let release!: () => void;
    register({
      id: 'slow.cmd',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'none',
      concurrent: 'deny',
      tier: 'reflexive',
      handler: () => new Promise((resolve) => { release = () => resolve({ done: true }); }),
    });

    const first = runCommand('slow.cmd', {}, ctx());
    // Yield so the first call lands in inflight before the second.
    await Promise.resolve();
    const second = await runCommand('slow.cmd', {}, ctx());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe('conflict');

    release();
    await first;
  });
});

describe("concurrency 'queue'", () => {
  it('serializes; second caller waits for the first', async () => {
    let counter = 0;
    register({
      id: 'queued.cmd',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'none',
      concurrent: 'queue',
      tier: 'reflexive',
      handler: async () => {
        const start = ++counter;
        await new Promise((r) => setTimeout(r, 10));
        return { start, end: counter };
      },
    });

    const [a, b] = await Promise.all([
      runCommand<{ start: number; end: number }>('queued.cmd', {}, ctx()),
      runCommand<{ start: number; end: number }>('queued.cmd', {}, ctx()),
    ]);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // serialization: a.start === a.end === 1, b.start === b.end === 2
      expect(a.value.start).toBe(1);
      expect(a.value.end).toBe(1);
      expect(b.value.start).toBe(2);
      expect(b.value.end).toBe(2);
    }
  });
});

describe('runQuery basics', () => {
  it("returns ok on a registered query", async () => {
    register({
      id: 'test.q',
      kind: 'query',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      audit: 'none',
      tier: 'fast-query',
      handler: () => ({ x: 'hello' }),
    });
    const r = await runQuery<{ x: string }>('test.q', {}, ctx());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.x).toBe('hello');
  });

  it("returns unknown for the wrong kind", async () => {
    register({
      id: 'cmd.disguise',
      kind: 'command',
      description: 'x',
      schema: z.object({}),
      agents: ['operator'],
      browser: 'none',
      tier: 'reflexive',
      handler: () => ({}),
    });
    const r = await runQuery('cmd.disguise', {}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('unknown');
  });
});
