import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { resolveForceGc } from './memory-watchdog';

vi.mock('node:v8', () => ({ getHeapStatistics: vi.fn(), setFlagsFromString: vi.fn() }));
vi.mock('node:vm', () => ({ runInNewContext: vi.fn() }));

const originalBun = Object.getOwnPropertyDescriptor(process.versions, 'bun');
const originalGc = Reflect.get(globalThis, 'gc');
function runtime(name: 'node' | 'bun') {
  if (name === 'bun') Object.defineProperty(process.versions, 'bun', { value: '1.3.14', configurable: true });
  else delete process.versions.bun;
}

beforeEach(() => {
  vi.clearAllMocks();
  // --expose-gc installs a nonconfigurable, writable property: replace its value.
  expect(Reflect.set(globalThis, 'gc', undefined)).toBe(true);
  vi.stubGlobal('Bun', undefined);
  runtime('node');
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.set(globalThis, 'gc', originalGc);
  if (originalBun) Object.defineProperty(process.versions, 'bun', originalBun);
  else delete process.versions.bun;
});

describe('watchdog runtime GC selection', () => {
  it('uses the Bun API with a full collection and preserves its receiver', () => {
    runtime('bun');
    const gc = vi.fn();
    const bun = { gc };
    vi.stubGlobal('Bun', bun);
    const force = resolveForceGc();
    expect(force).toBeTypeOf('function');
    force!();
    expect(gc).toHaveBeenCalledWith(true);
    expect(gc.mock.contexts[0]).toBe(bun);
    expect(setFlagsFromString).not.toHaveBeenCalled();
    expect(runInNewContext).not.toHaveBeenCalled();
  });

  it('does not attempt V8 APIs when a Bun runtime has no usable GC method', () => {
    runtime('bun');
    vi.stubGlobal('Bun', { gc: 'unavailable' });
    expect(resolveForceGc()).toBeNull();
    expect(setFlagsFromString).not.toHaveBeenCalled();
  });

  it('retains the already-exposed GC method without runtime-specific activation', () => {
    const gc = vi.fn();
    Reflect.set(globalThis, 'gc', gc);
    expect(resolveForceGc()).toBe(gc);
    expect(setFlagsFromString).not.toHaveBeenCalled();
  });

  it('retains Node V8 activation and ignores an unrelated Bun-shaped global', () => {
    const nodeGc = vi.fn();
    const unrelatedGc = vi.fn();
    vi.stubGlobal('Bun', { gc: unrelatedGc });
    vi.mocked(runInNewContext).mockReturnValueOnce(nodeGc);
    expect(resolveForceGc()).toBe(nodeGc);
    expect(setFlagsFromString).toHaveBeenCalledWith('--expose-gc');
    expect(runInNewContext).toHaveBeenCalledWith('gc');
    expect(unrelatedGc).not.toHaveBeenCalled();
  });
});
