// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useVisibleRefresh } from "./use-visible-refresh";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useVisibleRefresh (agent-multi-desktops-grid P-005/P-006)", () => {
  it("refreshes at once and then every interval while visible", () => {
    const refresh = vi.fn();
    renderHook(() => useVisibleRefresh(refresh, 5_000, true));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(10_000));
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("never refreshes when disabled", () => {
    const refresh = vi.fn();
    renderHook(() => useVisibleRefresh(refresh, 5_000, false));
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops while hidden and refreshes immediately on becoming visible", () => {
    const refresh = vi.fn();
    renderHook(() => useVisibleRefresh(refresh, 5_000, true));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => setVisibility("hidden"));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => setVisibility("visible"));
    expect(refresh).toHaveBeenCalledTimes(2);
    act(() => vi.advanceTimersByTime(5_000));
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("starts nothing when mounted hidden", () => {
    visibility = "hidden";
    const refresh = vi.fn();
    renderHook(() => useVisibleRefresh(refresh, 5_000, true));
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("clears its timer on unmount", () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useVisibleRefresh(refresh, 5_000, true));
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(60_000));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("always calls the latest callback without restarting the timer", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(({ fn }) => useVisibleRefresh(fn, 5_000, true), {
      initialProps: { fn: first },
    });
    rerender({ fn: second });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(5_000));
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
