import { afterEach, describe, expect, it, vi } from 'vitest';

const emitSystemEvent = vi.fn();
vi.mock('./engine', () => ({ emitSystemEvent: (...a: unknown[]) => emitSystemEvent(...a) }));

const fanout = await import('./plugin-event-fanout');
const { emitPluginEvent, publishPluginEvent, subscribePluginEvents, pluginEventSubscriberCount, pluginEventPayload } = fanout;

const unsubs: Array<() => void> = [];
function sub(name: string, installSlug: string) {
  const seen: Array<Record<string, unknown>> = [];
  unsubs.push(subscribePluginEvents({ name, installSlug }, (p) => { seen.push(p); }));
  return seen;
}

afterEach(() => {
  while (unsubs.length) unsubs.pop()!();
  emitSystemEvent.mockClear();
});

describe('plugin event fan-out (WI-39801)', () => {
  it('delivers an event to subscribers of its name in its install, and to no one else', () => {
    const match = sub('acme.ping', 'pot-a');
    const otherInstall = sub('acme.ping', 'pot-b');
    const otherName = sub('acme.pong', 'pot-a');
    publishPluginEvent({ name: 'acme.ping', installSlug: 'pot-a', payload: { n: 1 } });
    expect(match).toEqual([{ n: 1 }]);
    expect(otherInstall).toEqual([]);
    expect(otherName).toEqual([]);
  });

  it('delivers an event with no install scope to every install subscribed to the name', () => {
    const a = sub('acme.ping', 'pot-a');
    const b = sub('acme.ping', 'pot-b');
    publishPluginEvent({ name: 'acme.ping', installSlug: null, payload: { n: 2 } });
    expect(a).toEqual([{ n: 2 }]);
    expect(b).toEqual([{ n: 2 }]);
  });

  it('stops delivering after unsubscribe and releases the listener', () => {
    const before = pluginEventSubscriberCount();
    const seen: unknown[] = [];
    const off = subscribePluginEvents({ name: 'acme.ping', installSlug: 'pot-a' }, (p) => { seen.push(p); });
    expect(pluginEventSubscriberCount()).toBe(before + 1);
    off();
    expect(pluginEventSubscriberCount()).toBe(before);
    publishPluginEvent({ name: 'acme.ping', installSlug: 'pot-a', payload: {} });
    expect(seen).toEqual([]);
  });

  it('isolates a throwing subscriber from the emitter and from other subscribers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    unsubs.push(subscribePluginEvents({ name: 'acme.ping', installSlug: 'pot-a' }, () => { throw new Error('boom'); }));
    const healthy = sub('acme.ping', 'pot-a');
    expect(() => publishPluginEvent({ name: 'acme.ping', installSlug: 'pot-a', payload: { n: 3 } })).not.toThrow();
    expect(healthy).toEqual([{ n: 3 }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
    warn.mockRestore();
  });

  it('emitPluginEvent feeds the reaction matcher and the fan-out with the same normalized payload', () => {
    const seen = sub('acme.ping', 'pot-a');
    emitPluginEvent({ name: 'acme.ping', payload: 'hello', installSlug: 'pot-a' });
    expect(emitSystemEvent).toHaveBeenCalledWith({ tool: 'acme.ping', args: { value: 'hello' }, harnessSlug: 'pot-a' });
    expect(seen).toEqual([{ value: 'hello' }]);
  });

  it('emitPluginEvent without an install leaves the reaction scope at its default', () => {
    emitPluginEvent({ name: 'acme.ping' });
    expect(emitSystemEvent).toHaveBeenCalledWith({ tool: 'acme.ping', args: {} });
  });

  it('normalizes payloads to the object shape reaction rules match on', () => {
    expect(pluginEventPayload({ a: 1 })).toEqual({ a: 1 });
    expect(pluginEventPayload(undefined)).toEqual({});
    expect(pluginEventPayload(null)).toEqual({ value: null });
    expect(pluginEventPayload(7)).toEqual({ value: 7 });
    expect(pluginEventPayload([1, 2])).toEqual({ value: [1, 2] });
  });
});
