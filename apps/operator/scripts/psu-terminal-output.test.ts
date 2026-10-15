// @vitest-environment node
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalOutput } from './psu-terminal-output.mjs';

function sink() {
  const stream = new EventEmitter() as EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
  stream.write = vi.fn(() => true);
  stream.end = vi.fn((done: () => void) => done());
  return stream;
}

describe('managed terminal output', () => {
  it('borrows POSIX TTY stdout instead of calling its synchronous write', async () => {
    const stdout = { isTTY: true, fd: 1, write: vi.fn(() => { throw new Error('synchronous TTY write'); }) };
    const stream = sink();
    const makeStream = vi.fn(() => stream);
    const output = createTerminalOutput({ stdout, makeStream, platform: 'linux' });
    output.write('first');
    output.write('second');
    expect(makeStream).toHaveBeenCalledWith(1);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stream.write.mock.calls.map(([data]) => data)).toEqual(['first', 'second']);
    expect(await output.finish()).toBe(true);
  });

  it('pauses output on congestion, leaves the event loop free, and resumes only on drain', async () => {
    const stream = sink();
    stream.write.mockReturnValue(false);
    const pause = vi.fn();
    const resume = vi.fn();
    const output = createTerminalOutput({ stdout: stream, pause, resume });
    output.write('screen');
    output.write('handoff');
    expect(output.blocked).toBe(true);
    expect(pause).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(resume).not.toHaveBeenCalled();
    stream.emit('drain');
    expect(output.blocked).toBe(false);
    expect(resume).toHaveBeenCalledTimes(1);
    stream.emit('drain');
    expect(resume).toHaveBeenCalledTimes(1);
    expect(await output.finish()).toBe(true);
  });

  it('does not end or close an injected/Windows output stream', async () => {
    const stream = Object.assign(sink(), { isTTY: true, fd: 1 });
    const makeStream = vi.fn();
    const output = createTerminalOutput({ stdout: stream, platform: 'win32', makeStream });
    output.write('text');
    expect(await output.finish()).toBe(true);
    expect(makeStream).not.toHaveBeenCalled();
    expect(stream.end).not.toHaveBeenCalled();
  });

  it('reports a failed descriptor once and never resumes a failed producer', async () => {
    const stream = sink();
    stream.write.mockReturnValue(false);
    const onError = vi.fn();
    const resume = vi.fn();
    const output = createTerminalOutput({ stdout: stream, onError, resume });
    output.write('pending');
    stream.emit('error', new Error('EIO'));
    stream.emit('drain');
    stream.emit('error', new Error('EIO again'));
    expect(onError).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
    expect(await output.finish()).toBe(false);
  });

  it('bounds shutdown when the terminal never drains', async () => {
    const stream = sink();
    stream.write.mockReturnValue(false);
    const output = createTerminalOutput({ stdout: stream });
    output.write('pending');
    expect(await output.finish(10)).toBe(false);
    expect(stream.listenerCount('error')).toBe(0);
    expect(stream.listenerCount('drain')).toBe(0);
  });
});
